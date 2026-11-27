import { createFileRoute } from '@tanstack/react-router'
import { HistoryIcon, ImagePlusIcon, PencilIcon, PlusIcon, UploadIcon, XIcon } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/notifications'
import { useStudio } from '@/store/studioStore'

export const Route = createFileRoute('/add')({
  staticData: { title: '添加素材' },
  component: AddPage,
})

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// 生成记录的 imageUrl 是 data:image/... (base64)，转成 File 复用上传链路
async function dataUrlToFile(dataUrl: string, nameHint: string): Promise<File> {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const ext = (blob.type.split('/')[1] || 'png').split(';')[0].replace('jpeg', 'jpg')
  return new File([blob], `${nameHint}.${ext}`, { type: blob.type || 'image/png' })
}

// 网页图片网址 → 服务端代理下载 → File（浏览器跨域取不到图片二进制）
async function urlToFile(url: string): Promise<File> {
  const res = await fetch('/userdata/fetch-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const out = (await res.json()) as { ok?: boolean; name?: string; data?: string; error?: { message?: string } }
  if (!res.ok || !out.ok || !out.data || !out.name) throw new Error(out.error?.message || '拉取图片失败')
  const ext = out.name.split('.').pop()?.toLowerCase() || 'png'
  const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`
  return dataUrlToFile(`data:${mime};base64,${out.data}`, out.name.replace(/\.[^.]+$/, ''))
}

// 从拖拽事件中提取网页图片 URL（dataTransfer 里通常是 uri-list 或含 img 的 html）
function droppedImageUrl(dt: DataTransfer): string {
  const uri = dt.getData('text/uri-list') || dt.getData('text/plain') || ''
  const first = uri.split('\n').map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s))
  if (first) return first
  const html = dt.getData('text/html') || ''
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html)
  if (m && /^https?:\/\//i.test(m[1])) return m[1]
  return ''
}

function AddPage() {
  const { history, extractKeywords } = useStudio()
  const [autoKeywords, setAutoKeywords] = useState(true)

  // 直接添加文字
  const [textTitle, setTextTitle] = useState('')
  const [textBody, setTextBody] = useState('')
  const [textImages, setTextImages] = useState<File[]>([])
  const [savingText, setSavingText] = useState(false)
  const textImageRef = useRef<HTMLInputElement>(null)

  // 上传图片与文字
  const [files, setFiles] = useState<File[]>([])
  const [uploadCaption, setUploadCaption] = useState('')
  const [uploading, setUploading] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 生成历史选图弹窗：'text'=文字配图，'upload'=上传队列
  const [pickerFor, setPickerFor] = useState<'text' | 'upload' | null>(null)

  const saveText = async () => {
    if (!textBody.trim() && !textImages.length) return toast.info('写点文字或选一张图片')
    setSavingText(true)
    try {
      const title = textTitle.trim() || `文字 ${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}`
      const res = await fetch('/userdata/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title, text: textBody }),
      })
      const out = (await res.json()) as { ok?: boolean; error?: { message?: string } }
      if (!res.ok || !out.ok) throw new Error(out.error?.message || '保存失败')
      // 多张配图：主图 <标题>.<ext>，附图 <标题>__2.<ext>...（服务端据此关联）
      for (let i = 0; i < textImages.length; i++) {
        const f = textImages[i]
        const ext = f.name.replace(/^.*\./, '').toLowerCase() || 'png'
        const name = `${title}${i === 0 ? '' : `__${i + 1}`}.${ext}`
        const data = await toBase64(f)
        const ir = await fetch('/userdata/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, data, caption: '' }),
        })
        const io = (await ir.json()) as { ok?: boolean; error?: { message?: string } }
        if (!ir.ok || !io.ok) throw new Error(io.error?.message || `第 ${i + 1} 张配图保存失败`)
      }
      toast.success(`已保存到 NAS（${textImages.length} 张配图），可在「我的素材」查看`)
      setTextTitle(''); setTextBody(''); setTextImages([])
      if (textImageRef.current) textImageRef.current.value = ''
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSavingText(false)
    }
  }

  const upload = async () => {
    if (!files.length) return toast.info('先选择图片')
    setUploading(true)
    let okCount = 0
    let lastErr = ''
    for (const file of files) {
      try {
        const data = await toBase64(file)
        const res = await fetch('/userdata/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, data, caption: files.length === 1 ? uploadCaption : '' }),
        })
        const out = (await res.json()) as { ok?: boolean; error?: { message?: string } }
        if (!res.ok || !out.ok) {
          lastErr = out.error?.message || `HTTP ${res.status}`
          continue
        }
        okCount++
        if (autoKeywords && !(files.length === 1 && uploadCaption.trim())) {
          try {
            const dataUrl = `data:${file.type || 'image/png'};base64,${data}`
            const tags = await extractKeywords(dataUrl)
            if (tags.length) {
              await fetch('/userdata/caption', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: file.name, caption: tags.join(', ') }),
              })
            }
          } catch { /* 识图失败不影响上传 */ }
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : '上传失败'
      }
    }
    setUploading(false)
    if (okCount) {
      toast.success(`已上传 ${okCount} 张${autoKeywords ? '（已自动识别关键词）' : ''}，可在「我的素材」查看`)
      setFiles([]); setUploadCaption('')
      if (fileRef.current) fileRef.current.value = ''
    }
    if (lastErr) toast.error(lastErr)
  }

  // 本地图片文件 → 入上传队列
  const addLocalFiles = (list: FileList | File[]) => {
    const imgs = Array.from(list).filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return toast.info('拖入的不是图片')
    setFiles((prev) => [...prev, ...imgs])
    toast.success(`已加入 ${imgs.length} 张图片`)
  }

  // 拖放到上传区：本地文件优先，否则取网页图片 URL
  const onUploadDrop = async (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) return addLocalFiles(e.dataTransfer.files)
    const url = droppedImageUrl(e.dataTransfer)
    if (!url) return toast.info('请拖入图片文件，或从网页拖入图片')
    try {
      const file = await urlToFile(url)
      setFiles((prev) => [...prev, file])
      toast.success(`已加入网页图片：${file.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '拉取失败')
    }
  }

  // 粘贴网址入上传队列
  const addFromUrl = async () => {
    const url = imageUrl.trim()
    if (!url) return toast.info('先粘贴图片网址')
    try {
      const file = await urlToFile(url)
      setFiles((prev) => [...prev, file])
      setImageUrl('')
      toast.success(`已加入网页图片：${file.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '拉取失败')
    }
  }

  // 文字配图区拖放
  const onTextImageDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) {
      const imgs = Array.from(e.dataTransfer.files).filter((x) => x.type.startsWith('image/'))
      if (imgs.length) { setTextImages((prev) => [...prev, ...imgs]); return toast.success(`已加入 ${imgs.length} 张配图`) }
      return toast.info('拖入的不是图片')
    }
    const url = droppedImageUrl(e.dataTransfer)
    if (!url) return toast.info('请拖入图片，或从网页拖入图片')
    try {
      const file = await urlToFile(url)
      setTextImages((prev) => [...prev, file])
      toast.success('已加入配图')
    } catch (err) { toast.error(err instanceof Error ? err.message : '拉取失败') }
  }

  const pickGenerated = async (url: string) => {
    if (!pickerFor) return
    try {
      const file = await dataUrlToFile(url, `生成图_${Date.now()}`)
      if (pickerFor === 'text') setTextImages((prev) => [...prev, file])
      else setFiles((prev) => [...prev, file])
      setPickerFor(null)
      toast.success(pickerFor === 'text' ? '已选为配图，保存后生效' : '已加入上传队列，点上传即存入素材')
    } catch {
      toast.error('读取生成图失败')
    }
  }

  return (
    <>
      <PageHeader
        title="添加素材"
        description="把图片或文字存入 NAS 挂载目录，更新镜像不丢失。生成历史里的图也能直接选进来。"
      />

      {/* 1. 直接添加文字 */}
      <section className="mt-4 space-y-3 rounded-2xl border bg-card p-5">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><PencilIcon className="size-4" /></span>
          <div>
            <div className="text-sm font-semibold">直接添加文字</div>
            <div className="text-xs text-muted-foreground">不传图片也可以；可选配一张图片变成图文素材</div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className="space-y-3">
            <Input value={textTitle} onChange={(e) => setTextTitle(e.target.value)} placeholder="标题（留空自动用时间）" className="h-11" />
            <textarea
              value={textBody}
              onChange={(e) => setTextBody(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-lg border bg-background p-3 text-sm leading-relaxed"
              placeholder="粘贴提示词或任意文字，保存后可一键填入合成台"
            />
          </div>
          <div className="flex flex-col gap-2">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => void onTextImageDrop(e)}
              className={`rounded-lg border-2 border-dashed p-2 transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/30'}`}
            >
              <input
                ref={textImageRef}
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => setTextImages((prev) => [...prev, ...Array.from(e.target.files || [])])}
                className="block w-full text-xs text-muted-foreground file:mr-2 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-xs"
              />
              <div className="mt-1 text-center text-[11px] text-muted-foreground">可多选；或把网页图片拖到这里（不限张数）</div>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setPickerFor('text')}>
              <HistoryIcon className="size-3.5" />
              从生成历史选图（可多次选）
            </Button>
            {textImages.length > 0 && (
              <>
                <div className="text-[11px] text-muted-foreground">已选 {textImages.length} 张配图（第 1 张为主图）</div>
                <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto">
                  {textImages.map((f, i) => (
                    <div key={i} className="relative overflow-hidden rounded-lg border">
                      <img src={URL.createObjectURL(f)} alt={`配图 ${i + 1}`} className="h-20 w-full object-contain" />
                      <span className="absolute top-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
                      <button type="button" onClick={() => setTextImages((prev) => prev.filter((_, j) => j !== i))} className="absolute top-1 right-1 rounded bg-black/60 p-0.5 text-white"><XIcon className="size-3" /></button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="lg" onClick={() => void saveText()} disabled={savingText || (!textBody.trim() && !textImages.length)}>
            <PlusIcon className="size-4" />
            {savingText ? '保存中…' : '保存文字'}
          </Button>
        </div>
      </section>

      {/* 2. 上传图片与文字 */}
      <section className="mt-4 space-y-3 rounded-2xl border bg-card p-5">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><UploadIcon className="size-4" /></span>
          <div>
            <div className="text-sm font-semibold">上传图片与文字</div>
            <div className="text-xs text-muted-foreground">可多选图片；单张 ≤ 20 MB，支持 jpg / png / webp / gif</div>
          </div>
        </div>
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => void onUploadDrop(e)}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${dragOver ? 'border-primary bg-primary/10' : 'border-muted-foreground/30 bg-muted/20 hover:border-primary/50 hover:bg-primary/5'}`}
        >
          <ImagePlusIcon className="size-9 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{files.length ? `已选择 ${files.length} 张图片` : '点击选择图片，或多选'}</span>
          <span className="text-xs text-primary">也可把网页图片直接拖到这里，或粘贴图片网址 ↓</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files || [])])}
            className="hidden"
          />
        </label>
        <div className="flex gap-2">
          <Input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addFromUrl() } }}
            placeholder="粘贴网页图片网址，回车加入队列（如 https://…/pic.jpg）"
            className="h-10"
          />
          <Button type="button" variant="outline" onClick={() => void addFromUrl()} disabled={!imageUrl.trim()}>加入</Button>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setPickerFor('upload')}>
          <HistoryIcon className="size-3.5" />
          从生成历史选图
        </Button>
        <Input
          value={uploadCaption}
          onChange={(e) => setUploadCaption(e.target.value)}
          placeholder="文字说明（只在单张上传时自动保存；多张可上传后逐张点编辑）"
          className="h-11"
        />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={autoKeywords} onChange={(e) => setAutoKeywords(e.target.checked)} className="size-3.5 accent-primary" />
          上传后自动识别图片关键词（走本机 ComfyUI，无手动说明时写入说明栏）
        </label>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span key={i} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{f.name}</span>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button size="lg" onClick={() => void upload()} disabled={uploading || !files.length}>
            <UploadIcon className="size-4" />
            {uploading ? '上传中…' : `上传${files.length ? ` ${files.length} 张` : ''}`}
          </Button>
        </div>
      </section>

      {/* 从生成记录选图 */}
      {pickerFor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setPickerFor(null)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-2xl bg-card p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">从生成历史选图</h2>
              <button type="button" onClick={() => setPickerFor(null)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"><XIcon className="size-5" /></button>
            </div>
            {history.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">还没有生成记录，先去生成一张吧</p>
            ) : (
              <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
                {history.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => void pickGenerated(h.imageUrl)}
                    title={h.recipeSummary || h.prompt}
                    className="group relative aspect-square overflow-hidden rounded-lg border transition hover:ring-2 hover:ring-primary"
                  >
                    <img src={h.imageUrl} alt={h.recipeSummary || '历史生成图'} className="size-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
