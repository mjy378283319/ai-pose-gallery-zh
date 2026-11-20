import { createFileRoute } from '@tanstack/react-router'
import { DownloadIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { ImageViewer } from '@/components/common/ImageViewer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/notifications'
import { useStudio } from '@/store/studioStore'

export const Route = createFileRoute('/history')({
  staticData: { title: '生成历史' },
  component: HistoryPage,
})

function HistoryPage() {
  const { history, removeHistoryItem, clearHistory, setCustomPrompt } = useStudio()
  const [query, setQuery] = useState('')
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return history
    return history.filter((h) =>
      [h.recipeSummary, h.prompt, h.model].some((s) => s?.toLowerCase().includes(q))
    )
  }, [history, query])

  return (
    <div className="space-y-4">
      <PageHeader
        title="生成历史"
        description={`全部生成记录已完整保存在本机浏览器（共 ${history.length} 条）。可搜索、复用提示词、下载或删除。`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索说明/提示词/模型"
                className="h-9 w-56 pl-8 text-xs"
              />
            </div>
            {history.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearHistory}>
                <Trash2Icon className="size-3.5" />
                清空全部
              </Button>
            )}
          </div>
        }
      />

      {filtered.length === 0 ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed text-center text-muted-foreground">
          <span className="text-sm">{history.length === 0 ? '还没有生成记录' : '没有匹配的记录'}</span>
          <span className="text-xs">在「AI 角色合成台」生成图片后会自动保存在这里</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((h) => (
            <div key={h.id} className="group flex flex-col overflow-hidden rounded-2xl border bg-muted/20 p-2">
              <div className="relative aspect-3/4 overflow-hidden rounded-xl bg-muted">
                <button type="button" aria-label={`查看记录：${h.recipeSummary}`} onClick={() => setZoomUrl(h.imageUrl)} className="block h-full w-full cursor-zoom-in">
                  <img src={h.imageUrl} alt={h.recipeSummary} className="h-full w-full object-cover transition group-hover:scale-105" />
                  <span className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-12px)] truncate rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">{h.model}</span>
                </button>
                <button type="button" onClick={() => removeHistoryItem(h.id)} title="删除此记录" className="absolute top-1.5 right-1.5 rounded-full bg-black/65 p-1 text-white opacity-85 transition hover:bg-destructive hover:opacity-100">
                  <XIcon className="size-3" />
                </button>
              </div>
              <div className="mt-2 space-y-1 px-0.5">
                <div className="truncate text-xs font-medium" title={h.recipeSummary}>{h.recipeSummary}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{new Date(h.createdAt).toLocaleString('zh-CN')}</div>
                <div className="grid grid-cols-2 gap-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => { setCustomPrompt(h.prompt); window.location.href = '/studio'; toast.success('已恢复该图提示词') }}
                    className="flex h-7 items-center justify-center rounded-lg bg-muted text-[11px] font-medium whitespace-nowrap transition hover:bg-muted/70"
                  >
                    复用词
                  </button>
                  <a href={h.imageUrl} download={`character-${h.id}.png`} className="flex h-7 items-center justify-center rounded-lg bg-primary/10 text-[11px] font-medium whitespace-nowrap text-primary transition hover:bg-primary/20">
                    <DownloadIcon className="mr-1 size-3" />
                    下载
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ImageViewer imageUrl={zoomUrl || ''} open={Boolean(zoomUrl)} onOpenChange={(o) => !o && setZoomUrl(null)} />
    </div>
  )
}
