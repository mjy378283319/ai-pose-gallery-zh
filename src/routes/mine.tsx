import { createFileRoute } from '@tanstack/react-router'
import { CheckIcon, CopyIcon, FileTextIcon, FolderOpenIcon, PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, Trash2Icon, UploadIcon } from 'lucide-react'
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

function MinePage() {
  const { addExtraImage, setCustomPrompt } = useStudio()
  const [items, setItems] = useState<MineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [files, setFiles] = useState<File[]>([])
  const [uploadCaption, setUploadCaption] = useState('')
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [textTitle, setTextTitle] = useState('')
  const [textBody, setTextBody] = useState('')
  const [savingText, setSavingText] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

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
    return items.filter((i) => `${i.name} ${i.caption}`.toLowerCase().includes(q))
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
      } catch (e) {
        lastErr = e instanceof Error ? e.message : '上传失败'
      }
    }
    setUploading(false)
    if (okCount) {
      toast.success(`已上传 ${okCount} 张${files.length > 1 ? '（多张图片的文字请单独编辑）' : ''}`)
      setFiles([])
      setUploadCaption('')
      if (fileRef.current) fileRef.current.value = ''
      void load()
    }
    if (lastErr) toast.error(lastErr)
  }

  const saveCaption = async (item: MineItem) => {
    const res = await fetch('/userdata/caption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: item.name, caption: editText }),
    })
    const out = (await res.json()) as { ok?: boolean; error?: { message?: string } }
    if (!res.ok || !out.ok) return toast.error(out.error?.message || '保存失败')
    toast.success('文字已保存')
    setEditing(null)
    void load()
  }

  const saveText = async () => {
    if (!textBody.trim()) return toast.info('先写点文字')
    setSavingText(true)
    try {
      const res = await fetch('/userdata/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: textTitle.trim() || `文字 ${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}`,
          text: textBody,
        }),
      })
      const out = (await res.json()) as { ok?: boolean; error?: { message?: string } }
      if (!res.ok || !out.ok) throw new Error(out.error?.message || '保存失败')
      toast.success('文字已保存到 NAS')
      setTextTitle(''); setTextBody('')
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSavingText(false)
    }
  }

  const saveTextItem = async (item: MineItem) => {
    const res = await fetch('/userdata/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: item.label || item.name.replace(/\.txt$/i, ''), text: editText }),
    })
    const out = (await res.json()) as { ok?: boolean; error?: { message?: string } }
    if (!res.ok || !out.ok) return toast.error(out.error?.message || '保存失败')
    toast.success('文字已保存')
    setEditing(null)
    void load()
  }

  const deleteTextItem = async (item: MineItem) => {
    const res = await fetch(`/userdata/text?name=${encodeURIComponent(item.name)}`, { method: 'DELETE' })
    const out = (await res.json()) as { ok?: boolean; error?: { message?: string } }
    if (!res.ok || !out.ok) return toast.error(out.error?.message || '删除失败')
    toast.success('已删除')
    void load()
  }

  const add = (item: MineItem) => {
    if (!item.url) return toast.info('纯文字不能加入图片配方，请点「提示词」')
    addExtraImage({ name: item.caption || item.name, url: item.url })
    setAdded((prev) => new Set(prev).add(item.name))
    toast.success(`已加入配方：${item.caption || item.name}`)
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
        description="直接在这里上传图片与文字。文件存 NAS 挂载目录，更新镜像不丢失。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCwIcon className="size-3.5" />
            刷新
          </Button>
        }
      />

      {/* 上传区 */}
      <div className="mt-4 space-y-3 rounded-2xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <UploadIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">上传图片与文字</span>
          <span className="text-xs text-muted-foreground">（单张 ≤ 20 MB）</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
            className="block w-full max-w-xs text-xs text-muted-foreground file:mr-2 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-xs file:font-medium file:text-primary-foreground"
          />
          <Input
            value={uploadCaption}
            onChange={(e) => setUploadCaption(e.target.value)}
            placeholder="文字说明（单张时自动保存；多张请上传后逐张编辑）"
            className="min-w-[220px] flex-1"
          />
          <Button onClick={() => void upload()} disabled={uploading || !files.length}>
            <UploadIcon className="size-3.5" />
            {uploading ? '上传中…' : `上传${files.length ? ` ${files.length} 张` : ''}`}
          </Button>
        </div>
      </div>

      {/* 纯文字区 */}
      <div className="mt-3 space-y-2 rounded-2xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <PencilIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">直接添加文字</span>
          <span className="text-xs text-muted-foreground">（不传图片，存为独立文字素材）</span>
        </div>
        <Input
          value={textTitle}
          onChange={(e) => setTextTitle(e.target.value)}
          placeholder="标题（留空自动用时间）"
        />
        <textarea
          value={textBody}
          onChange={(e) => setTextBody(e.target.value)}
          rows={3}
          className="w-full rounded-lg border bg-background p-2.5 text-sm"
          placeholder="粘贴提示词或任意文字，保存后可一键填入合成台"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void saveText()} disabled={savingText || !textBody.trim()}>
            <PlusIcon className="size-3.5" />
            {savingText ? '保存中…' : '保存文字'}
          </Button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件名或文字" className="pl-9" />
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
            const editSave = isText ? saveTextItem : saveCaption
            return (
              <div key={item.name} className="overflow-hidden rounded-xl border bg-card">
                {isText ? (
                  <div className="flex min-h-24 items-start gap-2 bg-muted/40 p-2.5">
                    <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{item.label || item.name}</div>
                      <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-[11px] text-muted-foreground">{item.caption || '（空）'}</div>
                    </div>
                  </div>
                ) : (
                  <div className="relative aspect-square bg-muted">
                    <img src={item.url || undefined} alt={item.caption || item.name} loading="lazy" className="size-full object-cover" />
                    <div className="absolute right-1 bottom-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{formatSize(item.size)}</div>
                  </div>
                )}
                <div className="space-y-2 p-2.5">
                  {editing === item.name ? (
                    <div className="space-y-1">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={3}
                        className="w-full rounded-lg border bg-background p-2 text-xs"
                        placeholder={isText ? '输入文字' : '输入图片说明'}
                      />
                      <div className="flex gap-1">
                        <Button size="sm" className="flex-1 px-2" onClick={() => void editSave(item)}>保存</Button>
                        <Button size="sm" variant="ghost" className="px-2" onClick={() => setEditing(null)}>取消</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {!isText && <div className="line-clamp-2 min-h-8 text-xs" title={item.caption || item.name}>{item.caption || <span className="text-muted-foreground">{item.name}</span>}</div>}
                      <div className="flex flex-wrap gap-1">
                        {isText ? (
                          <Button size="sm" className="flex-1 px-2" onClick={() => useText(item)}>
                            填入提示词
                          </Button>
                        ) : (
                          <Button size="sm" className="flex-1 px-2" onClick={() => add(item)}>
                            {added.has(item.name) ? <CheckIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
                            加入配方
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="px-2" title="编辑" onClick={() => { setEditing(item.name); setEditText(item.caption) }}>
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
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
