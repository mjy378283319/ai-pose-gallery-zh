import { createFileRoute } from '@tanstack/react-router'
import { CheckIcon, CopyIcon, FolderOpenIcon, PlusIcon, RefreshCwIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
  name: string
  url: string
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

function MinePage() {
  const { addExtraImage, setCustomPrompt } = useStudio()
  const [items, setItems] = useState<MineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [added, setAdded] = useState<Set<string>>(new Set())

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

  const add = (item: MineItem) => {
    addExtraImage({ name: item.caption || item.name, url: item.url })
    setAdded((prev) => new Set(prev).add(item.name))
    toast.success(`已加入配方：${item.caption || item.name}`)
  }

  const useText = (item: MineItem) => {
    if (!item.caption) return toast.info('这张图没有配文字')
    setCustomPrompt(item.caption)
    toast.success('文字已填入合成台提示词')
  }

  const copyText = async (item: MineItem) => {
    if (!item.caption) return toast.info('这张图没有配文字')
    await navigator.clipboard.writeText(item.caption)
    toast.success('文字已复制')
  }

  return (
    <>
      <PageHeader
        title="我的素材"
        description="NAS 上你自己的图片与文字。只读挂载，更新镜像不丢失。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCwIcon className="size-3.5" />
              刷新
            </Button>
          </>
        }
      />

      <div className="mt-4 flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件名或文字"
            className="pl-9"
          />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{filtered.length} / {items.length} 张</span>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          读取失败：{error}
          <div className="mt-1 text-xs text-muted-foreground">
            确认容器已挂卷 USERDATA_DIR，且目录里有图片。
          </div>
        </div>
      )}

      {!error && !loading && items.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed p-10 text-center">
          <FolderOpenIcon className="mx-auto size-10 text-muted-foreground" />
          <div className="mt-3 font-medium">还没有自己的素材</div>
          <div className="mt-1 text-xs text-muted-foreground">
            把图片放到 NAS 的 userdata 目录（或 images/ 子目录），可配同名 .txt 或 captions.json 写文字。
          </div>
        </div>
      )}

      {loading && <div className="mt-6 text-sm text-muted-foreground">读取中…</div>}

      {filtered.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((item) => (
            <div key={item.name} className="overflow-hidden rounded-xl border bg-card">
              <div className="relative aspect-square bg-muted">
                <img src={item.url} alt={item.caption || item.name} loading="lazy" className="size-full object-cover" />
                <div className="absolute right-1 bottom-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  {formatSize(item.size)}
                </div>
              </div>
              <div className="space-y-2 p-2.5">
                <div className="line-clamp-2 min-h-8 text-xs" title={item.caption || item.name}>
                  {item.caption || item.name}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" className="flex-1 px-2" onClick={() => add(item)}>
                    {added.has(item.name) ? <CheckIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
                    加入配方
                  </Button>
                  {item.caption && (
                    <>
                      <Button size="sm" variant="outline" className="px-2" title="文字填入提示词" onClick={() => useText(item)}>
                        提示词
                      </Button>
                      <Button size="sm" variant="ghost" className="px-2" title="复制文字" onClick={() => void copyText(item)}>
                        <CopyIcon className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
