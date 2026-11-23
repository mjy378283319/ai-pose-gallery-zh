/**
 * NAS/Docker 运行时：静态站点 + 同源代理
 *
 *  - /                     静态前端（dist/）+ SPA fallback
 *  - /data /thumbs /img    图库静态资源（镜像内，或挂载卷）
 *  - /api/proxy            云端 AI 接口 CORS 转发（白名单）
 *  - /comfy/*              ComfyUI 反向代理（HTTP + WebSocket），去掉 Origin
 *                          让浏览器以为 ComfyUI 与本站同源，从而可以
 *                          跨房间 / 经公网控制 B 房 ComfyUI，无需 --enable-cors-header
 *  - /userdata/*           用户自有素材（挂卷，只读）：列表与图片
 *
 * 环境变量：
 *   PORT                    监听端口，默认 8080
 *   COMFYUI_URL             ComfyUI 上游，默认 http://127.0.0.1:8188
 *                          支持内嵌凭据 http://user:pass@host:port
 *   COMFY_BASE_URL          注入浏览器的 ComfyUI Base URL，默认 /comfy
 *   PROXY_ALLOWED_ORIGINS  /api/proxy 额外放行域名，逗号/分号/空白分隔
 *   USERDATA_DIR            用户素材挂载目录，默认 /app/userdata
 */
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8080)
const COMFY_BASE_URL = process.env.COMFY_BASE_URL || '/comfy'
const USERDATA_DIR = path.resolve(process.env.USERDATA_DIR || path.join(ROOT, 'userdata'))
const MAX_PROXY_BODY = 10 * 1024 * 1024
const USER_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

const upstream = new URL(process.env.COMFYUI_URL || 'http://127.0.0.1:8188')
const upstreamAuth = upstream.username
  ? 'Basic ' + Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64')
  : ''
const upstreamOrigin = upstream.origin
const upstreamHttp = upstream.protocol === 'https:' ? https : http

/* ── 应用登录（方案B）：APP_PASSWORD 为空则不启用，保持本地开发无感 ── */
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim()
const AUTH_ENABLED = APP_PASSWORD.length > 0
const AUTH_COOKIE = 'pose_auth'
// 用密码本身派生签名密钥（改密码后旧 cookie 自动失效）
const AUTH_SECRET = crypto.createHash('sha256').update('pose-auth:' + APP_PASSWORD).digest()
const AUTH_SIGN = (payload) => crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
const AUTH_TOKEN = (days) => {
  const exp = Date.now() + days * 86400 * 1000
  const payload = String(exp)
  return payload + '.' + AUTH_SIGN(payload)
}
const AUTH_VERIFY = (token) => {
  if (!token || typeof token !== 'string') return false
  const i = token.lastIndexOf('.')
  if (i < 1) return false
  const payload = token.slice(0, i), sig = token.slice(i + 1)
  const expect = AUTH_SIGN(payload)
  if (sig.length !== expect.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false
  return Number(payload) > Date.now()
}
function authCookie(req) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === AUTH_COOKIE) return v.join('=')
  }
  return ''
}
function isAuthed(req) { return !AUTH_ENABLED || AUTH_VERIFY(authCookie(req)) }
function sendUnauthorized(res) {
  const body = JSON.stringify({ error: 'unauthorized', message: '请先登录' })
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}
function handleAuthApi(req, res, p, url) {
  if (p === '/api/auth/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ enabled: AUTH_ENABLED, authenticated: isAuthed(req) }))
    return true
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy() })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      const ok = AUTH_ENABLED && typeof body.password === 'string' && body.password === APP_PASSWORD
      if (!ok) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'bad_password', message: '密码错误' }))
        return
      }
      const days = body.remember === false ? 1 : 30
      const maxAge = body.remember === false ? undefined : days * 86400
      const token = AUTH_TOKEN(days)
      const attrs = [`${AUTH_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
      if (maxAge) attrs.push(`Max-Age=${maxAge}`)
      // HTTPS 反代下加 Secure；本地 http 访问时不加，否则登录态丢失
      if ((req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') attrs.push('Secure')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': attrs.join('; ') })
      res.end(JSON.stringify({ ok: true }))
    })
    return true
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` })
    res.end(JSON.stringify({ ok: true }))
    return true
  }
  return false
}

/* ── HTTP 轮询桥接（方案：B 房 agent 主动出站拉取任务，无需 frp 隧道）──
 * 启用条件：BRIDGE_TOKEN 非空。agent 用它鉴权；前端 /comfy/* 请求被转成
 * 桥接任务，agent 轮询拿走→在本地调 127.0.0.1:8188→回传结果。
 * 任务只在内存，短时存在；agent 离线时请求会超时返回 503。
 */
const BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || '').trim()
const BRIDGE_ENABLED = BRIDGE_TOKEN.length > 0
const BRIDGE_TIMEOUT_MS = 110000
const bridgeTasks = new Map() // taskId → {method,path,headers,body,status,result,createdAt,done}
let bridgeSeq = 0

function bridgeTokenOk(req, url) {
  const h = req.headers['x-bridge-token']
  const q = url.searchParams.get('token')
  return BRIDGE_ENABLED && (h === BRIDGE_TOKEN || q === BRIDGE_TOKEN)
}
function bridgeGC() {
  const now = Date.now()
  for (const [id, t] of bridgeTasks) {
    if (now - t.createdAt > 5 * 60 * 1000) bridgeTasks.delete(id)
  }
}
setInterval(bridgeGC, 60 * 1000).unref?.()

/** agent 轮询：拿一个 pending 任务（长轮询最多 25s） */
function handleBridgePoll(req, res, url) {
  if (!BRIDGE_ENABLED) return sendJson(res, 503, { error: 'bridge disabled' })
  if (!bridgeTokenOk(req, url)) return sendJson(res, 401, { error: 'bad token' })
  const started = Date.now()
  const tryPick = () => {
    for (const [id, t] of bridgeTasks) {
      if (t.status === 'pending') {
        t.status = 'processing'
        if (t.kind === 'command') {
          return sendJson(res, 200, { id, kind: 'command', action: t.action, args: t.args })
        }
        return sendJson(res, 200, {
          id,
          kind: 'http',
          method: t.method,
          path: t.path,
          headers: t.headers,
          body: t.body ? t.body.toString('base64') : '', // base64 二进制安全
        })
      }
    }
    if (Date.now() - started > 25000) return sendJson(res, 200, { id: null })
    setTimeout(tryPick, 500)
  }
  tryPick()
}

/** agent 回传结果 */
async function handleBridgeResult(req, res, url) {
  if (!BRIDGE_ENABLED) return sendJson(res, 503, { error: 'bridge disabled' })
  if (!bridgeTokenOk(req, url)) return sendJson(res, 401, { error: 'bad token' })
  let raw
  try { raw = await readBody(req, 64 * 1024 * 1024) } catch { return json(res, 413, 'result too large') }
  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, 'invalid json') }
  const task = bridgeTasks.get(payload.id)
  if (!task) return sendJson(res, 404, { error: 'task not found' })
  task.result = {
    status: Number(payload.status) || 200,
    headers: payload.headers || {},
    body: payload.body ? Buffer.from(payload.body, 'base64') : Buffer.alloc(0),
  }
  task.status = 'done'
  sendJson(res, 200, { ok: true })
}

/** 服务控制指令：前端发 action → 作为 command 任务入队 → agent 执行 → 回传 */
async function handleBridgeCommand(req, res, url) {
  if (!BRIDGE_ENABLED) return sendJson(res, 503, { ok: false, error: 'bridge disabled' })
  if (!isAuthed(req)) return sendUnauthorized(res) // 控制指令要求应用登录态
  let raw
  try { raw = await readBody(req, 64 * 1024) } catch { return json(res, 413, 'body too large') }
  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, 'invalid json') }
  const action = String(payload.action || '')
  const allowed = new Set(['status', 'comfy_start', 'comfy_stop', 'comfy_restart', 'agent_pause', 'agent_resume', 'frpc_start', 'frpc_stop', 'logs'])
  if (!allowed.has(action)) return sendJson(res, 400, { ok: false, error: 'unknown action' })
  const id = `c${Date.now().toString(36)}${(bridgeSeq++).toString(36)}`
  bridgeTasks.set(id, {
    kind: 'command', action, args: payload.args || {},
    status: 'pending', result: null, createdAt: Date.now(),
  })
  const deadline = Date.now() + BRIDGE_TIMEOUT_MS
  const wait = () => {
    const t = bridgeTasks.get(id)
    if (t?.status === 'done' && t.result) {
      bridgeTasks.delete(id)
      const text = t.result.body.toString('utf8')
      try { sendJson(res, 200, JSON.parse(text)) }
      catch { sendJson(res, 200, { ok: true, raw: text }) }
      return
    }
    if (Date.now() > deadline) {
      bridgeTasks.delete(id)
      return sendJson(res, 503, { ok: false, error: 'agent 未响应' })
    }
    setTimeout(wait, 250)
  }
  wait()
}

/** 前端 /comfy 请求 → 提交桥接任务并等待结果 */
async function handleBridgeComfy(req, res, targetPath) {
  let body
  try { body = await readBody(req, 64 * 1024 * 1024) } catch { return json(res, 413, 'Request body too large') }
  const headers = { ...req.headers }
  delete headers.origin
  delete headers['x-forwarded-for']
  delete headers['x-bridge-token']
  const id = `b${Date.now().toString(36)}${(bridgeSeq++).toString(36)}`
  bridgeTasks.set(id, {
    method: req.method, path: targetPath, headers,
    body: body.length ? body : null, status: 'pending', result: null, createdAt: Date.now(),
  })
  const deadline = Date.now() + BRIDGE_TIMEOUT_MS
  const wait = () => {
    const t = bridgeTasks.get(id)
    if (t?.status === 'done' && t.result) {
      bridgeTasks.delete(id)
      const cleanHeaders = { ...t.result.headers }
      delete cleanHeaders['transfer-encoding']
      delete cleanHeaders['content-encoding'] // 回传已是解码后 body
      res.writeHead(t.result.status, cleanHeaders)
      res.end(t.result.body)
      return
    }
    if (Date.now() > deadline) {
      bridgeTasks.delete(id)
      return json(res, 503, 'Bridge agent 未响应（B 房 agent 未启动或 ComfyUI 未运行）')
    }
    setTimeout(wait, 300)
  }
  wait()
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const DEFAULT_ALLOWED_ORIGINS = [
  'https://dashscope.aliyuncs.com',
  'https://ark.cn-beijing.volces.com',
  'https://generativelanguage.googleapis.com',
  'https://api.openai.com',
]
const EXTRA_ALLOWED_ORIGINS = (process.env.PROXY_ALLOWED_ORIGINS || '').split(/[\s,;]+/).filter(Boolean)

function matchOriginRule(target, rawRule) {
  const rule = rawRule.trim()
  if (!rule) return false
  if (rule === '*') return true
  const wildcard = rule.match(/^(?:(https?):\/\/)?\*\.([a-z0-9.-]+)(?::(\d+))?(?:\/.*)?$/i)
  if (wildcard) {
    const [, proto, baseHost, port] = wildcard
    if (proto && `${proto.toLowerCase()}:` !== target.protocol) return false
    if ((port || '') !== target.port) return false
    const host = target.hostname.toLowerCase()
    const suffix = `.${baseHost.toLowerCase().replace(/^\.+|\.+$/g, '')}`
    return host.endsWith(suffix) && host.length > suffix.length
  }
  try {
    return new URL(rule.includes('://') ? rule : `https://${rule}`).origin === target.origin
  } catch {
    return false
  }
}

function originAllowed(target) {
  if (target.protocol !== 'https:') return false
  return [...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS].some((r) => matchOriginRule(target, r))
}

const json = (res, status, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: { message } }))
}

const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function readBody(req, limit = MAX_PROXY_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function handleApiProxy(req, res) {
  if (req.method !== 'POST') return json(res, 405, 'Method Not Allowed')
  const raw = req.headers['x-target-url']
  if (typeof raw !== 'string') return json(res, 400, 'Missing x-target-url header')
  let target
  try {
    target = new URL(raw)
  } catch {
    return json(res, 400, 'Invalid x-target-url header')
  }
  if (!originAllowed(target)) return json(res, 403, 'Target origin not allowed')

  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 413, `Request body exceeds ${MAX_PROXY_BODY} bytes`)
  }
  const headers = {}
  for (const key of ['content-type', 'authorization', 'x-goog-api-key', 'x-dashscope-async']) {
    if (req.headers[key]) headers[key] = req.headers[key]
  }
  try {
    const up = await fetch(target.toString(), { method: 'POST', headers, body: body.length ? body : undefined })
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json; charset=utf-8' })
    res.end(Buffer.from(await up.arrayBuffer()))
  } catch (err) {
    json(res, 502, err instanceof Error ? err.message : 'Upstream proxy error')
  }
}

/** /comfy HTTP 反向代理：保留原始 body（含 multipart /upload/image），去掉 Origin */
async function handleComfyHttp(req, res, targetPath) {
  let body
  try {
    body = await readBody(req, 64 * 1024 * 1024)
  } catch {
    return json(res, 413, 'Request body too large')
  }
  const headers = { ...req.headers }
  delete headers.origin
  delete headers['x-forwarded-for']
  headers.host = upstream.host
  if (upstreamAuth) headers.authorization = upstreamAuth
  // 浏览器可能用 chunked 上传参考图；重算长度，避免 transfer-encoding 与 content-length 冲突
  delete headers['transfer-encoding']
  if (body.length) headers['content-length'] = body.length
  else delete headers['content-length']

  const upReq = upstreamHttp.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: targetPath,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    },
  )
  upReq.setTimeout(120000, () => upReq.destroy(new Error('upstream timeout')))
  upReq.on('error', (err) => {
    if (!res.headersSent) json(res, 502, `ComfyUI unreachable: ${err.message}`)
    else res.destroy()
  })
  if (body.length) upReq.write(body)
  upReq.end()
}

/** /comfy WebSocket 反向代理：实时进度依赖它，断线时前端会自动退化为 HTTP 轮询 */
function handleComfyUpgrade(req, clientSocket, head, targetPath) {
  const headers = { ...req.headers }
  delete headers.origin
  headers.host = upstream.host
  if (upstreamAuth) headers.authorization = upstreamAuth
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'

  const upReq = upstreamHttp.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    method: 'GET',
    path: targetPath,
    headers,
  })
  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    let raw = `HTTP/1.1 101 ${upRes.statusMessage || 'Switching Protocols'}\r\n`
    for (const [key, value] of Object.entries(upRes.headers)) {
      if (Array.isArray(value)) for (const item of value) raw += `${key}: ${item}\r\n`
      else raw += `${key}: ${value}\r\n`
    }
    raw += '\r\n'
    clientSocket.write(raw)
    if (upHead?.length) clientSocket.write(upHead)
    if (head?.length) upSocket.write(head)
    upSocket.pipe(clientSocket)
    clientSocket.pipe(upSocket)
    upSocket.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upSocket.destroy())
    upSocket.on('close', () => clientSocket.destroy())
    clientSocket.on('close', () => upSocket.destroy())
  })
  upReq.on('error', () => clientSocket.destroy())
  upReq.on('response', (upRes) => {
    clientSocket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n\r\n`)
    clientSocket.destroy()
  })
  upReq.end()
}

function safePath(base, decoded) {
  const rel = decoded.replace(/^\/+/, '')
  const full = path.resolve(base, rel)
  return full.startsWith(path.resolve(base) + path.sep) || full === path.resolve(base) ? full : null
}

function serveFile(res, filePath, cache = 'public, max-age=3600') {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return serveIndex(res)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache,
    })
    fs.createReadStream(filePath).pipe(res)
  })
}

/**
 * 用户自有素材（只读，来自挂卷 USERDATA_DIR）：
 *  - /userdata/list               返回 {items:[{name,url,caption,size,mtime}]}
 *  - /userdata/img/<文件名>        返回图片本身
 *  - /userdata/caption/<文件名>.txt 返回同名 txt 文字（可选）
 *  - POST /userdata/upload         上传 {name, data(base64), caption}
 *  - POST /userdata/caption        更新 {name, caption} 到 captions.json
 * captions.json 可选：{ "IMG_001.jpg": "文字说明" }，不存在则用同名 .txt。
 */
function captionFor(name, captions, cb) {
  if (Object.hasOwn(captions, name)) return cb(String(captions[name] ?? ''))
  const txt = safePath(USERDATA_DIR, name.replace(/\.[^.]+$/, '') + '.txt')
  if (!txt) return cb('')
  fs.readFile(txt, 'utf8', (err, text) => cb(err ? '' : text.trim()))
}

const TEXT_DIR = () => path.join(USERDATA_DIR, 'texts')

async function handleUserdataList(res) {
  try {
    await fs.promises.mkdir(USERDATA_DIR, { recursive: true })
    let captions = {}
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(USERDATA_DIR, 'captions.json'), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) captions = parsed
    } catch {}

    const readDirSafe = async (dir) => {
      try { return await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return [] }
    }
    const collectImages = (list, base) => list
      .filter((e) => e.isFile() && USER_IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => ({ name: e.name, full: path.join(base, e.name) }))

    // 图片：根目录 + images/ 子目录，同名去重
    const rootEntries = await readDirSafe(USERDATA_DIR)
    const subEntries = await readDirSafe(path.join(USERDATA_DIR, 'images'))
    const seen = new Set()
    const files = []
    for (const f of [...collectImages(rootEntries, USERDATA_DIR), ...collectImages(subEntries, path.join(USERDATA_DIR, 'images'))]) {
      if (seen.has(f.name)) continue
      seen.add(f.name)
      files.push(f)
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

    // 独立文字：texts/*.txt（与图片字幕彻底分离）
    const textEntries = await readDirSafe(TEXT_DIR())
    const textFiles = textEntries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    // 文件名规范化：与下方 matchedImg 一致。同名配图只作为文字项的缩略图，
    // 不再单列为独立图片项，避免素材库出现"纯图 + 图文"两条重复记录。
    const normLabel = (s) => s.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5.\-]/g, '_')
    const textLabels = new Set(textFiles.map((e) => normLabel(e.name.replace(/\.txt$/i, ''))))

    const items = []
    for (const f of files) {
      if (textLabels.has(normLabel(f.name))) continue // 跳过文字项的配图
      const caption = await new Promise((resolve) => captionFor(f.name, captions, resolve))
      let st = null
      try { st = await fs.promises.stat(f.full) } catch {}
      items.push({
        kind: 'image',
        name: f.name,
        url: `/userdata/img/${encodeURIComponent(f.name)}`,
        caption,
        size: st?.size || 0,
        mtime: st ? st.mtime.toISOString() : '',
      })
    }

    for (const e of textFiles) {
      const full = path.join(TEXT_DIR(), e.name)
      const label = e.name.replace(/\.txt$/i, '')
      let text = '', st = null
      try { text = (await fs.promises.readFile(full, 'utf8')).trim() } catch {}
      try { st = await fs.promises.stat(full) } catch {}
      // 文字项可附加一张同名配图（images/<label>.<ext>），前端据此显示缩略图并支持编辑
      const matchedImg = files.find((f) => normLabel(f.name) === normLabel(label))
      items.push({
        kind: 'text',
        name: e.name,
        label,
        url: matchedImg ? `/userdata/img/${encodeURIComponent(matchedImg.name)}` : null,
        imageName: matchedImg?.name || null,
        caption: text,
        size: st?.size || 0,
        mtime: st ? st.mtime.toISOString() : '',
      })
    }

    sendJson(res, 200, { ok: true, items })
  } catch (err) {
    sendJson(res, 200, { ok: true, items: [], error: err instanceof Error ? err.message : '读取失败' })
  }
}

function safeUserName(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.trim().replace(/\\/g, '/').split('/').pop() || ''
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) return null
  if (!USER_IMAGE_EXT.has(path.extname(name).toLowerCase())) return null
  return name.replace(/[^\w\u4e00-\u9fa5.\-]/g, '_')
}

function updateCaptions(updates, cb) {
  const file = path.join(USERDATA_DIR, 'captions.json')
  fs.readFile(file, 'utf8', (err, raw) => {
    let cap = {}
    if (!err) {
      try {
        const p = JSON.parse(raw)
        if (p && typeof p === 'object' && !Array.isArray(p)) cap = p
      } catch {}
    }
    for (const [k, v] of Object.entries(updates)) cap[k] = v
    fs.writeFile(file, JSON.stringify(cap, null, 2) + '\n', 'utf8', (wErr) => cb(wErr))
  })
}

function safeTextName(raw) {
  if (typeof raw !== 'string') return null
  let name = raw.trim().replace(/\\/g, '/').split('/').pop() || ''
  name = name.replace(/\.txt$/i, '')
  // 允许中英文、数字、空格、下划线、连字符；其余替换为下划线
  name = name.replace(/[^\w\u4e00-\u9fa5 \-]/g, '_').trim()
  if (!name) return null
  if (name.length > 80) name = name.slice(0, 80)
  return name + '.txt'
}

async function handleUserdataTextSave(req, res) {
  let raw
  try { raw = await readBody(req, 2 * 1024 * 1024) } catch { return json(res, 413, '文字过长') }
  let body
  try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, '无效的 JSON') }
  const name = safeTextName(body.name)
  if (!name) return json(res, 400, '标题无效')
  const text = typeof body.text === 'string' ? body.text : ''
  if (text.length > 100000) return json(res, 413, '文字上限 10 万字')
  try {
    await fs.promises.mkdir(TEXT_DIR(), { recursive: true })
    await fs.promises.writeFile(path.join(TEXT_DIR(), name), text, 'utf8')
    sendJson(res, 200, { ok: true, name, text })
  } catch (err) {
    json(res, 500, `保存失败（挂载是否只读？）：${err instanceof Error ? err.message : err}`)
  }
}

async function handleUserdataTextDelete(req, res, url) {
  const name = safeTextName(url.searchParams.get('name') || '')
  if (!name) return json(res, 400, '标题无效')
  try {
    await fs.promises.unlink(path.join(TEXT_DIR(), name))
    sendJson(res, 200, { ok: true, name })
  } catch (err) {
    json(res, 500, `删除失败：${err instanceof Error ? err.message : err}`)
  }
}

/** 删除图片素材：删图片本体 + 同名 captions 条目（若有），不碰 texts/ 独立文字 */
async function handleUserdataImageDelete(req, res, url) {
  const raw = url.searchParams.get('name') || ''
  let name
  try { name = decodeURIComponent(raw) } catch { return json(res, 400, '文件名无效') }
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return json(res, 400, '文件名无效')
  // 与 handleUserdataFile 一致的候选路径：images/ 子目录优先，其次根目录
  const candidates = [safePath(USERDATA_DIR, path.join('images', name)), safePath(USERDATA_DIR, name)].filter(Boolean)
  const target = candidates.find((c) => fs.existsSync(c))
  if (!target) return json(res, 404, '图片不存在')
  try {
    await fs.promises.unlink(target)
    // 清理 captions.json 里同名条目（best-effort）
    const capFile = safePath(USERDATA_DIR, 'captions.json')
    if (capFile && fs.existsSync(capFile)) {
      try {
        const caps = JSON.parse(await fs.promises.readFile(capFile, 'utf8'))
        if (caps && Object.prototype.hasOwnProperty.call(caps, name)) {
          delete caps[name]
          await fs.promises.writeFile(capFile, JSON.stringify(caps, null, 2), 'utf8')
        }
      } catch {}
    }
    sendJson(res, 200, { ok: true, name })
  } catch (err) {
    json(res, 500, `删除失败：${err instanceof Error ? err.message : err}`)
  }
}

// 重命名素材：图片项改文件名 + captions key；文字项改 txt 名 + 同名配图名。
// 用于「我的素材」编辑弹窗里的标题修改。
async function handleUserdataRename(req, res) {
  let raw
  try { raw = await readBody(req, 2 * 1024 * 1024) } catch { return json(res, 413, '请求体过大') }
  let body
  try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, '无效的 JSON') }
  const kind = body.kind === 'text' ? 'text' : 'image'
  const from = String(body.from || '').trim()
  const to = String(body.to || '').trim()
  if (!from || !to) return json(res, 400, '缺少原名称或新名称')

  try {
    if (kind === 'image') {
      const fromName = safeUserName(from)
      const toName = safeUserName(to)
      if (!fromName || !toName) return json(res, 400, '图片名无效（需含 jpg/png/gif/webp 后缀）')
      if (fromName === toName) return sendJson(res, 200, { ok: true, kind, name: toName })
      // 源可能在 images/ 或根目录
      const src = [safePath(USERDATA_DIR, path.join('images', fromName)), safePath(USERDATA_DIR, fromName)].find((c) => c && fs.existsSync(c))
      if (!src) return json(res, 404, '原图片不存在')
      const dst = path.join(path.dirname(src), toName)
      if (fs.existsSync(dst)) return json(res, 409, '新文件名已存在')
      await fs.promises.rename(src, dst)
      // 迁移 caption key
      await new Promise((resolve) => updateCaptions({}, () => resolve()))
      let captions = {}
      try { captions = JSON.parse(await fs.promises.readFile(path.join(USERDATA_DIR, 'captions.json'), 'utf8')) || {} } catch {}
      if (Object.hasOwn(captions, fromName)) {
        captions[toName] = captions[fromName]
        delete captions[fromName]
        await fs.promises.writeFile(path.join(USERDATA_DIR, 'captions.json'), JSON.stringify(captions, null, 2) + '\n', 'utf8')
      }
      return sendJson(res, 200, { ok: true, kind, name: toName, url: `/userdata/img/${encodeURIComponent(toName)}` })
    }

    // 文字项：改 txt 文件名 + 关联配图（images/<label>.<ext>）
    const fromName = safeTextName(from)
    const toName = safeTextName(to)
    if (!fromName || !toName) return json(res, 400, '标题无效')
    if (fromName === toName) return sendJson(res, 200, { ok: true, kind, name: toName, label: toName.replace(/\.txt$/i, '') })
    const srcTxt = path.join(TEXT_DIR(), fromName)
    const dstTxt = path.join(TEXT_DIR(), toName)
    if (!fs.existsSync(srcTxt)) return json(res, 404, '原文字不存在')
    if (fs.existsSync(dstTxt)) return json(res, 409, '新标题已存在')
    await fs.promises.rename(srcTxt, dstTxt)
    // 关联配图一起改名
    const fromLabel = fromName.replace(/\.txt$/i, '')
    const toLabel = toName.replace(/\.txt$/i, '')
    const imgDir = path.join(USERDATA_DIR, 'images')
    let attached = null
    for (const f of await fs.promises.readdir(imgDir).catch(() => [])) {
      if (f.replace(/\.[^.]+$/, '') === fromLabel) {
        const newImg = toLabel + path.extname(f)
        await fs.promises.rename(path.join(imgDir, f), path.join(imgDir, newImg)).catch(() => {})
        attached = newImg
        break
      }
    }
    return sendJson(res, 200, {
      ok: true, kind, name: toName, label: toLabel,
      url: attached ? `/userdata/img/${encodeURIComponent(attached)}` : null,
    })
  } catch (err) {
    json(res, 500, `重命名失败（挂载是否只读？）：${err instanceof Error ? err.message : err}`)
  }
}

async function handleUserdataUpload(req, res) {
  let raw
  try {
    raw = await readBody(req, 30 * 1024 * 1024)
  } catch {
    return json(res, 413, '请求体过大')
  }
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return json(res, 400, '无效的 JSON')
  }
  const name = safeUserName(body.name)
  if (!name) return json(res, 400, '仅支持图片文件，且文件名不能含路径')
  if (typeof body.data !== 'string') return json(res, 400, '缺少 data')
  let buffer
  try {
    buffer = Buffer.from(body.data, 'base64')
  } catch {
    return json(res, 400, 'data 不是有效 base64')
  }
  if (!buffer.length) return json(res, 400, '文件为空')
  if (buffer.length > MAX_UPLOAD_BYTES) return json(res, 413, '单张图片上限 20 MB')
  // 图片魔数校验，防止把任意文件改成图片后缀
  const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isGif = buffer.subarray(0, 3).toString() === 'GIF'
  const isWebp = buffer.subarray(8, 12).toString() === 'WEBP'
  if (!(isJpg || isPng || isGif || isWebp)) return json(res, 400, '不是有效图片（jpg/png/gif/webp）')

  fs.mkdir(path.join(USERDATA_DIR, 'images'), { recursive: true }, (mkErr) => {
    if (mkErr) return json(res, 500, `无法创建目录（挂载是否只读？）：${mkErr.message}`)
    fs.writeFile(path.join(USERDATA_DIR, 'images', name), buffer, (wErr) => {
      if (wErr) return json(res, 500, `写入失败（挂载是否只读？）：${wErr.message}`)
      const caption = typeof body.caption === 'string' ? body.caption.trim() : ''
      if (!caption) return sendJson(res, 200, { ok: true, name, caption: '' })
      updateCaptions({ [name]: caption }, (cErr) => {
        if (cErr) return json(res, 500, `图片已上传，但文字保存失败：${cErr.message}`)
        sendJson(res, 200, { ok: true, name, caption })
      })
    })
  })
}

async function handleUserdataCaption(req, res) {
  let raw
  try {
    raw = await readBody(req, 1024 * 1024)
  } catch {
    return json(res, 413, '文字过长')
  }
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return json(res, 400, '无效的 JSON')
  }
  const name = safeUserName(body.name)
  if (!name) return json(res, 400, '文件名无效')
  if (typeof body.caption !== 'string') return json(res, 400, '缺少 caption')
  if (body.caption.length > 20000) return json(res, 413, '文字上限 20000 字')
  updateCaptions({ [name]: body.caption.trim() }, (err) => {
    if (err) return json(res, 500, `保存失败（挂载是否只读？）：${err.message}`)
    sendJson(res, 200, { ok: true, name, caption: body.caption.trim() })
  })
}

function handleUserdataFile(res, kind, encoded) {
  let name
  try {
    name = decodeURIComponent(encoded)
  } catch {
    return json(res, 400, 'Bad filename')
  }
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return json(res, 400, 'Bad filename')
  // 同时兼容扁平目录与 images/ 子目录，取第一个真实存在的候选
  const candidates = kind === 'caption'
    ? [safePath(USERDATA_DIR, name.replace(/\.[^.]+$/, '') + '.txt')]
    : [safePath(USERDATA_DIR, path.join('images', name)), safePath(USERDATA_DIR, name)]
  const target = candidates.find((c) => c && fs.existsSync(c)) || null
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, 'Not found')
    res.writeHead(200, {
      'Content-Type': kind === 'caption' ? 'text/plain; charset=utf-8' : (MIME[path.extname(target).toLowerCase()] || 'application/octet-stream'),
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    })
    fs.createReadStream(target).pipe(res)
  })
}

function serveIndex(res) {
  const indexFile = path.join(ROOT, 'dist', 'index.html')
  fs.readFile(indexFile, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('dist/index.html missing')
      return
    }
    const config = JSON.stringify({ comfyBaseUrl: COMFY_BASE_URL, version: process.env.APP_VERSION || 'dev' }).replace(/</g, '\\u003c')
    const injected = html.replace('</head>', `<script>window.__APP_CONFIG__=${config};</script></head>`)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(injected)
  })
}

function handleStatic(req, res, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return serveIndex(res)
  }
  const roots = [
    ['/data/', path.join(ROOT, 'data')],
    ['/thumbs/', path.join(ROOT, 'thumbs')],
    ['/img/', path.join(ROOT, 'img')],
  ]
  for (const [prefix, base] of roots) {
    if (decoded.startsWith(prefix)) {
      const file = safePath(base, decoded.slice(prefix.length))
      if (!file) return json(res, 403, 'Forbidden')
      return fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) return json(res, 404, 'Not found')
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=86400',
        })
        fs.createReadStream(file).pipe(res)
      })
    }
  }
  if (['/og-cover.jpg', '/robots.txt', '/sitemap.xml'].includes(decoded)) {
    return serveFile(res, path.join(ROOT, decoded.slice(1)))
  }
  if (decoded !== '/' && !decoded.includes('..')) {
    const file = safePath(path.join(ROOT, 'dist'), decoded)
    if (file) {
      return fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) return serveIndex(res)
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        })
        fs.createReadStream(file).pipe(res)
      })
    }
  }
  serveIndex(res)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const p = url.pathname
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, comfyui: upstreamOrigin, comfyBaseUrl: COMFY_BASE_URL, userdata: USERDATA_DIR, version: process.env.APP_VERSION || 'dev' }))
    return
  }
  // 登录接口本身必须匿名可达
  if (p.startsWith('/api/auth/')) {
    if (handleAuthApi(req, res, p, url)) return
  }
  // 桥接 agent 接口：用 BRIDGE_TOKEN 鉴权，不走 cookie（agent 在单位机，无登录态）
  if (p === '/api/bridge/poll' && req.method === 'GET') return void handleBridgePoll(req, res, url)
  if (p === '/api/bridge/result' && req.method === 'POST') return void handleBridgeResult(req, res, url)
  if (p === '/api/bridge/command' && req.method === 'POST') return void handleBridgeCommand(req, res, url)
  if (p === '/api/bridge/status' && req.method === 'GET') {
    if (!BRIDGE_ENABLED) return sendJson(res, 200, { enabled: false })
    if (!bridgeTokenOk(req, url)) return sendJson(res, 401, { error: 'bad token' })
    const pending = [...bridgeTasks.values()].filter((t) => t.status === 'pending').length
    return sendJson(res, 200, { enabled: true, pending, queued: bridgeTasks.size })
  }
  // 数据/代理接口需要登录；静态资源(index.html/assets/img 等)放行以便登录页渲染
  const isDataApi = p === '/api/proxy' || p.startsWith('/comfy') || p.startsWith('/userdata')
  if (isDataApi && !isAuthed(req)) return sendUnauthorized(res)
  if (p === '/api/proxy') return void handleApiProxy(req, res)
  if (p === '/comfy' || p.startsWith('/comfy/')) {
    const rest = p.replace(/^\/comfy/, '') || '/'
    // Bridge 优先：启用时走轮询队列（不依赖 frp 隧道）
    if (BRIDGE_ENABLED) return void handleBridgeComfy(req, res, `${rest}${url.search}`)
    return void handleComfyHttp(req, res, `${rest}${url.search}`)
  }
  if (p === '/userdata/list') {
    if (req.method !== 'GET') return json(res, 405, 'Method Not Allowed')
    return void handleUserdataList(res)
  }
  if (p === '/userdata/upload') {
    if (req.method !== 'POST') return json(res, 405, 'Method Not Allowed')
    return void handleUserdataUpload(req, res)
  }
  if (p === '/userdata/caption') {
    if (req.method !== 'POST') return json(res, 405, 'Method Not Allowed')
    return void handleUserdataCaption(req, res)
  }
  if (p === '/userdata/rename') {
    if (req.method !== 'POST') return json(res, 405, 'Method Not Allowed')
    return void handleUserdataRename(req, res)
  }
  if (p === '/userdata/text') {
    if (req.method === 'POST') return void handleUserdataTextSave(req, res)
    if (req.method === 'DELETE') return void handleUserdataTextDelete(req, res, url)
    return json(res, 405, 'Method Not Allowed')
  }
  if (p === '/userdata/image') {
    if (req.method === 'DELETE') return void handleUserdataImageDelete(req, res, url)
    return json(res, 405, 'Method Not Allowed')
  }
  if (p.startsWith('/userdata/img/') || p.startsWith('/userdata/caption/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, 'Method Not Allowed')
    const kind = p.startsWith('/userdata/caption/') ? 'caption' : 'img'
    return void handleUserdataFile(res, kind, p.slice(`/userdata/${kind}/`.length))
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, 'Method Not Allowed')
  handleStatic(req, res, p)
})

server.on('upgrade', (req, clientSocket, head) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const p = url.pathname
  if (p !== '/comfy' && !p.startsWith('/comfy/')) {
    clientSocket.destroy()
    return
  }
  if (!isAuthed(req)) { clientSocket.destroy(); return }
  const rest = p.replace(/^\/comfy/, '') || '/'
  handleComfyUpgrade(req, clientSocket, head, `${rest}${url.search}`)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pose-atlas] listening on :${PORT}`)
  console.log(`[pose-atlas] ComfyUI upstream = ${upstreamOrigin}`)
  console.log(`[pose-atlas] browser ComfyUI base = ${COMFY_BASE_URL}`)
  console.log(`[pose-atlas] userdata dir = ${USERDATA_DIR}`)
})
