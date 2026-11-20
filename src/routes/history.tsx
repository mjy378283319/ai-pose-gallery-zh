import { createFileRoute } from '@tanstack/react-router'
import { DownloadIcon, SearchIcon, TagIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { ImageViewer } from '@/components/common/ImageViewer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/lib/notifications'
import { useStudio } from '@/store/studioStore'
import type { GenerationHistoryItem } from '@/types/gallery'

export const Route = createFileRoute('/history')({
  staticData: { title: '生成历史' },
  component: HistoryPage,
})

function HistoryPage() {
  const { history, removeHistoryItem, clearHistory, setCustomPrompt, updateHistoryTags } = useStudio()
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)
  const [tagEdit, setTagEdit] = useState<GenerationHistoryItem | null>(null)
  const [tagDraft, setTagDraft] = useState('')

  // 所有出现过的标签（去重）
  const allTags = useMemo(() => {
    const set = new Set<string>()
    history.forEach((h) => h.tags?.forEach((t) => set.add(t)))
    return Array.from(set).sort()
  }, [history])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return history.filter((h) => {
      if (activeTag && !h.tags?.includes(activeTag)) return false
      if (!q) return true
      return [h.recipeSummary, h.prompt, h.model, ...(h.tags || [])].some((s) => s?.toLowerCase().includes(q))
    })
  }, [history, query, activeTag])

  const openTagEdit = (item: GenerationHistoryItem) => {
    setTagEdit(item)
    setTagDraft((item.tags || []).join(', '))
  }
  const saveTags = () => {
    if (!tagEdit) return
    const tags = tagDraft.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    updateHistoryTags(tagEdit.id, Array.from(new Set(tags)))
    setTagEdit(null)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="生成历史"
        description={`全部生成记录已完整保存在本机浏览器（共 ${history.length} 条）。可打关键词标签、按标签筛选、复用提示词、下载或删除。`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索说明/提示词/模型/标签"
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

      {/* 标签筛选条 */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border bg-muted/30 px-3 py-2">
          <TagIcon className="size-3.5 text-muted-foreground" />
          <button
            type="button"
            onClick={() => setActiveTag(null)}
            className={`h-6 rounded-full border px-2 text-[11px] transition ${activeTag === null ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
          >
            全部
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              className={`h-6 rounded-full border px-2 text-[11px] transition ${activeTag === tag ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

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
                {/* 关键词标签 */}
                <div className="flex flex-wrap items-center gap-1">
                  {(h.tags || []).map((t) => (
                    <button key={t} type="button" onClick={() => setActiveTag(t)} className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary transition hover:bg-primary/20">{t}</button>
                  ))}
                  <button type="button" onClick={() => openTagEdit(h)} title="编辑关键词" className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-accent">
                    <TagIcon className="size-2.5" />
                    {h.tags?.length ? '编辑' : '加标签'}
                  </button>
                </div>
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

      {/* 关键词编辑弹窗 */}
      <Dialog open={tagEdit !== null} onOpenChange={(o) => !o && setTagEdit(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">编辑关键词标签</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">用逗号分隔多个关键词，例如：狐耳, 巫女, 红色, 坐姿。之后可按标签筛选好图。</p>
          <Input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveTags() }}
            placeholder="狐耳, 巫女, 红色, 坐姿"
            className="text-sm"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setTagEdit(null)}>取消</Button>
            <Button size="sm" onClick={saveTags}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
