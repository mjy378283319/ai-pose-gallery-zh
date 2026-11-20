import { createFileRoute } from '@tanstack/react-router'
import { CheckIcon, CopyIcon, FileTextIcon, FolderOpenIcon, ImagePlusIcon, PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, SparklesIcon, Trash2Icon, UploadIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/notifications'
import { useStudio } from '@/store/studioStore'

export const Route = createFileRoute('/mine')({
  staticData: { title: '我的素材' },
  component: MinePage,
})

interface MineItem {
  kind?: 'image' | 'text'
  name: string
  label?: string
  url: string | null
  imageName?: string | null
  caption: string
  size: number
  mtime: string
}

function formatSize(bytes: number) {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

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

// 生成记录的 imageUrl 是 data:image/... (base64)，转成 File 以便复用现有上传链路。
async function dataUrlToFile(dataUrl: string, nameHint: string): Promise<File> {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const ext = (blob.type.split('/')[1] || 'png').split(';')[0].replace('jpeg', 'jpg')
  return new File([blob], `${nameHint}.${ext}`, { type: blob.type || 'image/png' })
}

// 编辑弹窗状态：item=正在编辑的素材；imageFile=新选的图片（换图/加图）
interface EditState {
  item: MineItem
  title: string
  text: string
  imageFile: File | null
}

function MinePage() {
  const { addExtraImage, setCustomPrompt, history, extractKeywords } = useStudio()
  const [autoKeywords, setAutoKeywords] = useState(true)
  const [items, setItems] = useState<MineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [files, setFiles] = useState<File[]>([])
  const [uploadCaption, setUploadCaption] = useState('')
  const [uploading, setUploading] = useState(false)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [textTitle, setTextTitle] = useState('')
  const [textBody, setTextBody] = useState('')
  const [textImage, setTextImage] = useState<File | null>(null)
  const [savingText, setSavingText] = useState(false)
  // 从生成记录选配图：'edit'=编辑弹窗，'text'=直接添加文字
  const [pickerFor, setPickerFor] = useState<'edit' | 'text' | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const editImageRef = useRef<HTMLInputElement>(null)
  const textImageRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/userdata/list', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { ok?: boolean; items?: MineItem[]; error?: string }
      if (!data.ok && data.error) throw new Error(data.error)
      setItems(data.items || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => `${i.name} ${i.label || ''} ${i.caption}`.toLowerCase().includes(q))
  }, [items, query])

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

        // 自动识图打关键词：无手动说明时，用本地 ComfyUI 识别图片并写入 caption
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
          } catch {
            // 识图失败不影响上传本身，仅跳过关键词
          }
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : '上传失败'
      }
    }
    setUploading(false)
    if (okCount) {
      toast.success(`已上传 ${okCount} 张${autoKeywords ? '（已自动识别关键词）' : ''}${files.length > 1 ? '，多张可逐张编辑' : ''}`)
      setFiles([])
      setUploadCaption('')
      if (fileRef.current) fileRef.current.value = ''
      void load()
    }
    if (lastErr) toast.error(lastErr)
  }

  // 统一的素材编辑：标题 + 文字 + 可选换图/加图
  const openEdit = (item: MineItem) => {
    setEdit({ item, title: item.label || item.name.replace(/\.[^.]+$/, ''), text: item.caption, imageFile: null })
  }

  const saveEdit = async () => {
    if (!edit) return
    if (!edit.text && !edit.imageFile && !edit.item.url) return toast.info('内容为空')
    setSavingEdit(true)
    try {
      const isText = edit.item.kind === 'text'
      const oldName = edit.item.name
      const newTitle = edit.title.trim()
      let finalName = oldName
      let finalUrl = edit.item.url

      // 1) 标题变了 -> 重命名（图片项 / 文字项）
      const oldTitle = isText ? (edit.item.label || oldName.replace(/\.txt$/i, '')) : oldName.replace(/\.[^.]+$/, '')
      if (newTitle && newTitle !== oldTitle) {
        const r = await fetch('/userdata/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: isText ? 'text' : 'image', from: oldName, to: newTitle }),
        })
        const o = (await r.json()) as { ok?: boolean; name?: string; url?: string | null; error?: { message?: string } }
        if (!r.ok || !o.ok) throw new Error(o.error?.message || '重命名失败')
        finalName = o.name || finalName
        finalUrl = o.url ?? finalUrl
      }

      // 2) 换图 / 加图：用最终标题作为图片文件名上传（同名覆盖）
      if (edit.imageFile) {
        // 图片项保持原扩展名；文字项用标题+原扩展名（让 list 的同名匹配生效）
        const ext = edit.imageFile.name.replace(/^.*\./, '').toLowerCase() || 'png'
        const imgFileName = isText ? `${newTitle || oldTitle}.${ext}` : finalName
        const data = await toBase64(edit.imageFile)
        const r = await fetch('/userdata/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: imgFileName, data, caption: '' }),
        })
        const o = (await r.json()) as { ok?: boolean; name?: string; error?: { message?: string } }
        if (!r.ok || !o.ok) throw new Error(o.error?.message || '图片保存失败')
        if (isText) finalUrl = `/userdata/img/${encodeURIComponent(o.name || imgFileName)}`
      }

      // 3) 保存文字：图片项走 caption，文字项走 text（用最终 name）
      const textVal = edit.text.trim()
      if (isText) {
        const r = await fetch('/userdata/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: finalName.replace(/\.txt$/i, ''), text: textVal }),
        })
        const o = (await r.json()) as { ok?: boolean; error?: { message?: string } }
        if (!r.ok || !o.ok) throw new Error(o.error?.message || '文字保存失败')
      } else {
        const r = await fetch('/userdata/caption', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: finalName, caption: textVal }),
        })
        const o = (await r.json()) as { ok?: boolean; error?: { message?: string } }
        if (!r.ok || !o.ok) throw new Error(o.error?.message || '说明保存失败')
      }

      toast.success('已保存')
      setEdit(null)
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSavingEdit(false)
    }
  }

  // 直接添加文字（可同时附图）
  const saveText = async () => {
    if (!textBody.trim() && !textImage) return toast.info('写点文字或选一张图片')
    setSavingText(true)
    try {
      const title = textTitle.trim() || `文字 ${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}`
      const res = await fetch('/userdata/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title, text: textBody }),
      })
      const out = (await res.json()) as { ok?: boolean; name?: string; error?: { message?: string } }
      if (!res.ok || !out.ok) throw new Error(out.error?.message || '保存失败')
      if (textImage) {
        const ext = textImage.name.replace(/^.*\./, '').toLowerCase() || 'png'
        const data = await toBase64(textImage)
        const ir = await fetch('/userdata/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `${title}.${ext}`, data, caption: '' }),
        })
        const io = (await ir.json()) as { ok?: boolean; error?: { message?: string } }
        if (!ir.ok || !io.ok) throw new Error(io.error?.message || '配图保存失败')
      }
      toast.success('已保存到 NAS')
      setTextTitle(''); setTextBody(''); setTextImage(null)
      if (textImageRef.current) textImageRef.current.value = ''
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSavingText(false)
    }
  }

  // 从生成记录选一张图作为配图：转成 File 后填入对应入口，复用现有保存链路。
  const pickGenerated = async (url: string) => {
    if (!pickerFor) return
    try {
      const file = await dataUrlToFile(url, `生成图_${Date.now()}`)
      if (pickerFor === 'edit') setEdit((prev) => prev ? { ...prev, imageFile: file } : prev)
      else setTextImage(file)
      setPickerFor(null)
      toast.success('已选为配图，保存后生效')
    } catch {
      toast.error('读取生成图失败')
    }
  }

  const deleteTextItem = async (item: MineItem) => {
    const res = await fetch(`/userdata/text?name=${encodeURIComponent(item.name)}`, { method: 'DELETE' })
    const out = (await res.json()) as { ok?: boolean; error?: { message?: string } }
    if (!res.ok || !out.ok) return toast.error(out.error?.message || '删除失败')
    toast.success('已删除')
    void load()
  }

  const add = (item: MineItem) => {
    if (!item.url) return toast.info('这条素材没有图片，请点「提示词」')
    addExtraImage({ name: item.caption || item.label || item.name, url: item.url })
    setAdded((prev) => new Set(prev).add(item.name))
    toast.success(`已加入配方：${item.caption || item.label || item.name}`)
  }

  const useText = (item: MineItem) => {
    if (!item.caption) return toast.info('这条素材没有文字')
    setCustomPrompt(item.caption)
    toast.success('文字已填入合成台提示词')
  }

  const copyText = async (item: MineItem) => {
    if (!item.caption) return toast.info('这条素材没有文字')
    await navigator.clipboard.writeText(item.caption)
    toast.success('文字已复制')
  }

  return (
    <>
      <PageHeader
        title="我的素材"
        description="图片与文字都存 NAS 挂载目录，更新镜像不丢失。点卡片上的铅笔可改标题、说明并更换图片。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCwIcon className="size-3.5" />
            刷新
          </Button>
        }
      />

      {/* 上传区（放大） */}
      <section className="mt-4 space-y-3 rounded-2xl border bg-card p-5">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><UploadIcon className="size-4" /></span>
          <div>
            <div className="text-sm font-semibold">上传图片与文字</div>
            <div className="text-xs text-muted-foreground">可多选图片；单张 ≤ 20 MB，支持 jpg / png / webp / gif</div>
          </div>
        </div>
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/20 px-4 py-8 text-center transition-colors hover:border-primary/50 hover:bg-primary/5">
          <ImagePlusIcon className="size-9 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{files.length ? `已选择 ${files.length} 张图片` : '点击选择图片，或多选'}</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
            className="hidden"
          />
        </label>
        <Input
          value={uploadCaption}
          onChange={(e) => setUploadCaption(e.target.value)}
          placeholder="文字说明（只在单张上传时自动保存；多张可上传后逐张点铅笔编辑）"
          className="h-11"
        />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoKeywords}
            onChange={(e) => setAutoKeywords(e.target.checked)}
            className="size-3.5 accent-primary"
          />
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

      {/* 纯文字区（放大） */}
      <section className="mt-3 space-y-3 rounded-2xl border bg-card p-5">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><PencilIcon className="size-4" /></span>
          <div>
            <div className="text-sm font-semibold">直接添加文字</div>
            <div className="text-xs text-muted-foreground">不传图片也可以；可选配一张图片变成图文素材</div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className="space-y-3">
            <Input
              value={textTitle}
              onChange={(e) => setTextTitle(e.target.value)}
              placeholder="标题（留空自动用时间）"
              className="h-11"
            />
            <textarea
              value={textBody}
              onChange={(e) => setTextBody(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-lg border bg-background p-3 text-sm leading-relaxed"
              placeholder="粘贴提示词或任意文字，保存后可一键填入合成台"
            />
          </div>
          <div className="flex flex-col gap-2">
            <input
              ref={textImageRef}
              type="file"
              accept="image/*"
              onChange={(e) => setTextImage(e.target.files?.[0] || null)}
              className="block w-full text-xs text-muted-foreground file:mr-2 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-xs"
            />
            <Button type="button" size="sm" variant="outline" onClick={() => setPickerFor('text')}>
              <SparklesIcon className="size-3.5" />
              从生成记录选图
            </Button>
            {textImage && (
              <div className="relative overflow-hidden rounded-lg border">
                <img src={URL.createObjectURL(textImage)} alt="配图预览" className="h-32 w-full object-cover" />
                <button type="button" onClick={() => { setTextImage(null); if (textImageRef.current) textImageRef.current.value = '' }} className="absolute top-1 right-1 rounded bg-black/60 p-1 text-white"><XIcon className="size-3.5" /></button>
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="lg" onClick={() => void saveText()} disabled={savingText || (!textBody.trim() && !textImage)}>
            <PlusIcon className="size-4" />
            {savingText ? '保存中…' : '保存文字'}
          </Button>
        </div>
      </section>

      <div className="mt-5 flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件名或文字" className="h-11 pl-9" />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{filtered.length} / {items.length} 项</span>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          读取失败：{error}
          <div className="mt-1 text-xs text-muted-foreground">确认容器挂载了可写的 /app/userdata 目录。</div>
        </div>
      )}

      {!error && !loading && items.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed p-10 text-center">
          <FolderOpenIcon className="mx-auto size-10 text-muted-foreground" />
          <div className="mt-3 font-medium">还没有自己的素材</div>
          <div className="mt-1 text-xs text-muted-foreground">在上方上传图片或添加文字；也可把文件放到 NAS 的 userdata 目录。</div>
        </div>
      )}

      {loading && <div className="mt-6 text-sm text-muted-foreground">读取中…</div>}

      {filtered.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((item) => {
            const isText = item.kind === 'text'
            const hasImg = Boolean(item.url)
            return (
              <div key={item.name} className="overflow-hidden rounded-xl border bg-card">
                {hasImg ? (
                  <div className="relative aspect-square bg-muted">
                    <img src={item.url || undefined} alt={item.caption || item.label || item.name} loading="lazy" className="size-full object-cover" />
                    {isText && <span className="absolute top-1 left-1 rounded bg-primary/80 px-1.5 py-0.5 text-[10px] text-primary-foreground">图文</span>}
                    {!isText && <div className="absolute right-1 bottom-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{formatSize(item.size)}</div>}
                  </div>
                ) : (
                  <div className="flex min-h-28 items-start gap-2 bg-muted/40 p-2.5">
                    <FileTextIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{item.label || item.name}</div>
                      <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-[11px] text-muted-foreground">{item.caption || '（空）'}</div>
                    </div>
                  </div>
                )}
                <div className="space-y-2 p-2.5">
                  {!isText && <div className="line-clamp-2 min-h-8 text-xs" title={item.caption || item.name}>{item.caption || <span className="text-muted-foreground">{item.name}</span>}</div>}
                  {isText && hasImg && <div className="truncate text-xs font-medium">{item.label || item.name}</div>}
                  <div className="flex flex-wrap gap-1">
                    {(hasImg || isText) && (
                      <Button size="sm" className="flex-1 px-2" onClick={() => isText ? useText(item) : add(item)}>
                        {isText ? <><FileTextIcon className="size-3.5" />提示词</> : added.has(item.name) ? <><CheckIcon className="size-3.5" />已加</> : <><PlusIcon className="size-3.5" />加入配方</>}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="px-2" title="编辑标题/文字/图片" onClick={() => openEdit(item)}>
                      <PencilIcon className="size-3.5" />
                    </Button>
                    {item.caption && !isText && (
                      <Button size="sm" variant="outline" className="px-2" title="文字填入提示词" onClick={() => useText(item)}>提示词</Button>
                    )}
                    {item.caption && (
                      <Button size="sm" variant="ghost" className="px-2" title="复制文字" onClick={() => void copyText(item)}>
                        <CopyIcon className="size-3.5" />
                      </Button>
                    )}
                    {isText && (
                      <Button size="sm" variant="ghost" className="px-2 text-destructive" title="删除" onClick={() => void deleteTextItem(item)}>
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 统一编辑弹窗 */}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setEdit(null)}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">编辑素材</h2>
              <button type="button" onClick={() => setEdit(null)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"><XIcon className="size-5" /></button>
            </div>
            <div className="mt-5 space-y-5">
              {/* 标题 */}
              <div>
                <label className="mb-1.5 block text-sm font-medium">标题</label>
                <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} className="h-11" placeholder="给这条素材起个名字" />
                <p className="mt-1 text-xs text-muted-foreground">图片项改名会同时改文件名；文字项改名会同时改配图名。</p>
              </div>

              {/* 图片 + 换图 */}
              <div>
                <label className="mb-1.5 block text-sm font-medium">{edit.item.kind === 'text' ? '配图（可选）' : '图片'}</label>
                <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
                  <div className="flex min-h-36 items-center justify-center overflow-hidden rounded-xl border bg-muted/30">
                    {edit.imageFile ? (
                      <img src={URL.createObjectURL(edit.imageFile)} alt="新图预览" className="h-40 w-full object-cover" />
                    ) : edit.item.url ? (
                      <img src={edit.item.url} alt="当前图片" className="h-40 w-full object-cover" />
                    ) : (
                      <span className="text-xs text-muted-foreground">暂无图片</span>
                    )}
                  </div>
                  <div className="flex flex-col justify-center gap-2">
                    <input
                      ref={editImageRef}
                      type="file"
                      accept="image/*"
                      onChange={(e) => setEdit({ ...edit, imageFile: e.target.files?.[0] || null })}
                      className="block w-full text-xs text-muted-foreground file:mr-2 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-xs"
                    />
                    <Button type="button" size="sm" variant="outline" onClick={() => setPickerFor('edit')}>
                      <SparklesIcon className="size-3.5" />
                      从生成记录选图
                    </Button>
                    <p className="text-xs text-muted-foreground">{edit.item.kind === 'text' ? '可上传本地图片，或从生成记录里选一张作为配图。' : '可上传本地图片，或从生成记录里选一张替换当前图片（保存后生效）。'}</p>
                    {edit.imageFile && <Button size="sm" variant="ghost" className="w-fit" onClick={() => { setEdit({ ...edit, imageFile: null }); if (editImageRef.current) editImageRef.current.value = '' }}>清除选择</Button>}
                  </div>
                </div>
              </div>

              {/* 文字 / 说明 */}
              <div>
                <label className="mb-1.5 block text-sm font-medium">{edit.item.kind === 'text' ? '文字内容' : '图片说明'}</label>
                <textarea
                  value={edit.text}
                  onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                  rows={8}
                  className="w-full resize-y rounded-lg border bg-background p-3 text-sm leading-relaxed"
                  placeholder={edit.item.kind === 'text' ? '输入或粘贴文字' : '输入这张图片的文字说明'}
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t pt-4">
              <Button variant="outline" size="lg" onClick={() => setEdit(null)}>取消</Button>
              <Button size="lg" onClick={() => void saveEdit()} disabled={savingEdit}>
                {savingEdit ? '保存中…' : '保存修改'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 从生成记录选配图 */}
      {pickerFor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setPickerFor(null)}>
          <div className="max-h-[86vh] w-full max-w-3xl overflow-y-auto rounded-2xl border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">从生成记录选配图</h2>
                <p className="mt-1 text-xs text-muted-foreground">点一张即可选为配图（最多显示 30 条生成记录）</p>
              </div>
              <button type="button" onClick={() => setPickerFor(null)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"><XIcon className="size-5" /></button>
            </div>
            {history.length === 0 ? (
              <div className="mt-8 flex flex-col items-center gap-2 py-10 text-muted-foreground">
                <SparklesIcon className="size-8" />
                <p className="text-sm">还没有生成记录。先在「AI 角色合成台」生成图片后再来选。</p>
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {history.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => void pickGenerated(h.imageUrl)}
                    className="group overflow-hidden rounded-xl border text-left transition hover:ring-2 hover:ring-primary"
                    title={h.prompt}
                  >
                    <img src={h.imageUrl} alt="生成记录" className="h-32 w-full object-cover" />
                    <div className="p-1.5 text-[10px] text-muted-foreground">
                      {new Date(h.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
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
