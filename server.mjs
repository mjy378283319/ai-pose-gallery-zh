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

    const items = []
    for (const f of files) {
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

    // 独立文字：texts/*.txt（与图片字幕彻底分离）
    const textEntries = await readDirSafe(TEXT_DIR())
    const textFiles = textEntries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    for (const e of textFiles) {
      const full = path.join(TEXT_DIR(), e.name)
      const label = e.name.replace(/\.txt$/i, '')
      let text = '', st = null
      try { text = (await fs.promises.readFile(full, 'utf8')).trim() } catch {}
      try { st = await fs.promises.stat(full) } catch {}
      // 文字项可附加一张同名配图（images/<label>.<ext>），前端据此显示缩略图并支持编辑
      // 文件名经 safeUserName 清洗（空格->下划线），label 也做同样规范化后再比对
      const normLabel = (s) => s.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5.\-]/g, '_')
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
  if (p === '/api/proxy') return void handleApiProxy(req, res)
  if (p === '/comfy' || p.startsWith('/comfy/')) {
    const rest = p.replace(/^\/comfy/, '') || '/'
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
  const rest = p.replace(/^\/comfy/, '') || '/'
  handleComfyUpgrade(req, clientSocket, head, `${rest}${url.search}`)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pose-atlas] listening on :${PORT}`)
  console.log(`[pose-atlas] ComfyUI upstream = ${upstreamOrigin}`)
  console.log(`[pose-atlas] browser ComfyUI base = ${COMFY_BASE_URL}`)
  console.log(`[pose-atlas] userdata dir = ${USERDATA_DIR}`)
})
