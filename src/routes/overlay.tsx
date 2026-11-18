import { createFileRoute, Link } from '@tanstack/react-router'
import {
  CheckIcon,
  DownloadIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  LoaderCircleIcon,
  PlusIcon,
  SparklesIcon,
  UploadIcon,
  WandSparklesIcon,
  XIcon,
} from 'lucide-react'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/notifications'
import { uploadedReferences } from '@/lib/recipeImages'
import { fileToDataUrl } from '@/services/aiGenerator'
import { useStudio } from '@/store/studioStore'

export const Route = createFileRoute('/overlay')({
  staticData: { title: '素材生图' },
  component: OverlayPage,
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

interface SelectedImage {
  name: string
  url: string
}

function OverlayPage() {
  const {
    apiConfig,
    updateApiConfig,
    setPortrait,
    setCostume,
    setPose,
    startGeneration,
    isGenerating,
    generationProgress,
    generationError,
    previewUrl,
    history,
  } = useStudio()

  const [selected, setSelected] = useState<SelectedImage | null>(null)
  const [description, setDescription] = useState('')
  const [picked, setPicked] = useState<string[]>([]) // 已加入文字描述的素材名（有序）
  const [mineItems, setMineItems] = useState<MineItem[]>([])
  const [loadingMine, setLoadingMine] = useState(false)
  const [picking, setPicking] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const objectUrlRef = useRef<string | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const isComfy = apiConfig.activeProvider === 'comfyui'

  const loadMine = async () => {
    setLoadingMine(true)
    try {
      const res = await fetch('/userdata/list', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { ok?: boolean; items?: MineItem[]; error?: string }
      if (!data.ok && data.error) throw new Error(data.error)
      setMineItems(data.items || [])
    } catch (e) {
      toast.error(e instanceof Error ? `读取我的素材失败：${e.message}` : '读取我的素材失败')
    } finally {
      setLoadingMine(false)
    }
  }

  useEffect(() => {
    void loadMine()
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  useEffect(() => {
    if (generationProgress?.message && isGenerating) {
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [generationProgress?.message, isGenerating])

  // 把图设为唯一视觉参考（当前 Z-Image 单图工作流只认人像槽位）。
  const useAsReference = async (name: string, url: string) => {
    setPicking(true)
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = url
      await img.decode()
      const refs = uploadedReferences(name, url, img.naturalWidth || 1024, img.naturalHeight || 1024, 0)
      setPortrait(refs.portrait)
      setCostume(null)
      setPose(null)
      setSelected({ name, url })
      toast.success('已设为视觉参考图')
    } catch {
      toast.error('图片加载失败，请换一张')
    } finally {
      setPicking(false)
    }
  }

  // 方案 B 核心：把素材的文字描述累加/移除到提示词。多张图（人像/服装/姿势）的意图
  // 全部靠文字保留，只有一张图作为视觉参考——绕开 Z-Image 三图参考的已知问题。
  const toggleCaption = (item: MineItem) => {
    const caption = (item.caption || '').trim()
    if (!caption) {
      toast.info('这张素材没有文字描述，可到「我的素材」编辑后重试')
      return
    }
    if (picked.includes(item.name)) {
      setPicked((prev) => prev.filter((n) => n !== item.name))
      setDescription((prev) => prev.split('\n').filter((line) => line.trim() !== caption).join('\n'))
      toast.info('已移除这张的文字描述')
    } else {
      setPicked((prev) => [...prev, item.name])
      setDescription((prev) => {
        const lines = prev.split('\n').map((l) => l.trim()).filter(Boolean)
        if (lines.includes(caption)) return prev
        return [...lines, caption].join('\n')
      })
      toast.success(`已加入文字描述（共 ${picked.length + 1} 张）`)
    }
  }

  const setAsReference = (item: MineItem) => {
    if (!item.url) return
    void useAsReference(item.label || item.name, item.url)
  }

  const clearAll = () => {
    setDescription('')
    setPicked([])
    setSelected(null)
    setPortrait(null)
  }

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error('图片超过 20 MB，请先压缩')
      return
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const dataUrl = await fileToDataUrl(file)
    objectUrlRef.current = URL.createObjectURL(file)
    await useAsReference(file.name.replace(/\.[^.]+$/, ''), dataUrl)
    event.target.value = ''
  }

  const useRecent = () => {
    const recent = history.find((item) => item.imageUrl)
    if (!recent) return toast.info('还没有生成记录')
    void useAsReference('上一张生成图', recent.imageUrl)
  }

  const generate = async () => {
    if (!isComfy) {
      toast.error('请先把生成器切换为本地 ComfyUI（B 房）')
      return
    }
    if (!description.trim()) {
      toast.info('先从素材加入文字描述，或自己写一句画面描述')
      return
    }
    // 提示词 = 多张素材的文字汇总（+用户手动补充）；视觉参考只有一张。
    await startGeneration(description.trim())
  }

  const mineImages = mineItems.filter((item) => item.kind !== 'text' && item.url)

  return (
    <>
      <PageHeader
        title="素材生图"
        description="多张素材的文字描述拼成提示词，只选一张当视觉参考——三张图的意图靠文字保留，稳定出图。"
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/studio">
              <SparklesIcon className="size-3.5" />
              完整合成台
            </Link>
          </Button>
        }
      />

      {!isComfy && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <span className="text-amber-700 dark:text-amber-300">当前生成器不是本地 ComfyUI，无法调用 B 房显卡。</span>
          <Button size="sm" onClick={() => updateApiConfig({ activeProvider: 'comfyui' })}>
            切换为本地 ComfyUI
          </Button>
          <span className="text-xs text-muted-foreground">或到「API 接口配置」里选择 ComfyUI</span>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">怎么用：</span>
        ① 从「我的素材」点「+文字」把每张图的描述都加进来（人像、服装、姿势可以全加）→
        ② 点其中一张的缩略图「设为参考」（建议选人像图）→
        ③ 右侧检查拼好的描述、可补充修改 → 点「生成」。
        文字负责保留三张图的信息，参考图只给一张，避开三图参考的已知问题。
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <ImagePlusIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">1. 选参考图 + 加入文字</span>
            </div>

            {selected ? (
              <div className="flex items-center gap-3 rounded-xl border border-primary/60 bg-background p-2">
                <img src={selected.url} alt="参考图" className="size-14 shrink-0 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{selected.name}</div>
                  <div className="flex items-center gap-1 text-xs text-emerald-600">
                    <CheckIcon className="size-3.5" /> 视觉参考图
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="px-2" onClick={() => { setSelected(null); setPortrait(null) }}>
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-2.5 text-xs text-muted-foreground">
                还没设参考图——点下面素材的缩略图设为参考（也可以不选，纯文字生成）。
              </div>
            )}

            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onFileChange(e)} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => fileRef.current?.click()} disabled={picking}>
                <UploadIcon className="size-3.5" /> 上传本地
              </Button>
              <Button size="sm" variant="outline" onClick={useRecent} disabled={picking || !history.length}>
                <WandSparklesIcon className="size-3.5" /> 用上一张生成图
              </Button>
            </div>

            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <FolderOpenIcon className="size-3.5" />
                我的素材（点图设参考 · 点 +文字 加描述）
                <button type="button" className="ml-auto underline" onClick={() => void loadMine()} disabled={loadingMine}>
                  {loadingMine ? '刷新中' : '刷新'}
                </button>
              </div>
              <div className="max-h-[300px] space-y-1 overflow-y-auto pr-1">
                {mineImages.length ? (
                  mineImages.map((item) => {
                    const isRef = selected?.url === item.url
                    const isPicked = picked.includes(item.name)
                    return (
                      <div
                        key={item.name}
                        className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-1.5 ${isRef ? 'border-primary' : ''}`}
                      >
                        <button
                          type="button"
                          title="设为视觉参考图"
                          onClick={() => setAsReference(item)}
                          disabled={picking}
                          className={`relative size-9 shrink-0 overflow-hidden rounded ${isRef ? 'ring-2 ring-primary' : ''}`}
                        >
                          <img src={item.url!} alt="" className="size-full object-cover" />
                          {isRef && <span className="absolute bottom-0 right-0 bg-primary px-0.5 text-[9px] text-primary-foreground">参考</span>}
                        </button>
                        <button
                          type="button"
                          onClick={() => setAsReference(item)}
                          disabled={picking}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-xs">{item.label || item.name}</span>
                          {item.caption && <span className="block truncate text-[11px] text-muted-foreground">{item.caption}</span>}
                        </button>
                        {item.caption && (
                          <button
                            type="button"
                            onClick={() => toggleCaption(item)}
                            className={`shrink-0 rounded-md border px-1.5 py-1 text-[11px] ${isPicked ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
                          >
                            {isPicked ? <><CheckIcon className="mr-0.5 inline size-3" />已加</> : <><PlusIcon className="mr-0.5 inline size-3" />文字</>}
                          </button>
                        )}
                      </div>
                    )
                  })
                ) : (
                  <div className="text-xs text-muted-foreground">还没有图片素材，可先到「我的素材」上传，或点上方「上传本地」。</div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <WandSparklesIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">2. 提示词（已加入 {picked.length} 张的文字）</span>
              {(description || picked.length || selected) && (
                <button type="button" className="ml-auto text-xs text-muted-foreground underline" onClick={clearAll}>
                  全部清空
                </button>
              )}
            </div>
            <div className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              下面是已加入的素材文字，按顺序拼成。可自由增删调整——建议：人像特征 → 服装 → 姿势动作 → 场景光线风格。
            </div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={7}
              placeholder="点素材的「+文字」自动汇总到这里；也可以直接写描述，例：27岁女性，长卷发，穿白色连衣裙，侧身站立，树林场景，阳光柔和，写实摄影"
              className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring"
            />
            <Button className="w-full" size="lg" onClick={() => void generate()} disabled={!isComfy || !description.trim() || isGenerating}>
              {isGenerating ? <LoaderCircleIcon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}
              {isGenerating ? '生成中…' : selected ? '文字 + 参考图生成' : '纯文字生成'}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              三张图的意图用文字保留，视觉参考只用一张——当前显卡最稳的方式。
            </p>
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border bg-card p-4" ref={resultRef}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">生成结果</span>
            {generationProgress?.message && isGenerating && (
              <span className="text-xs text-muted-foreground">{generationProgress.message}</span>
            )}
            <div className="ml-auto flex gap-2">
              {previewUrl && !isGenerating && (
                <Button size="sm" variant="outline" asChild>
                  <a href={previewUrl} download="generated.png">
                    <DownloadIcon className="size-3.5" /> 下载
                  </a>
                </Button>
              )}
            </div>
          </div>

          <div className="flex min-h-[420px] items-center justify-center overflow-hidden rounded-2xl bg-background p-4">
            {isGenerating ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <LoaderCircleIcon className="size-10 animate-spin text-primary" />
                <div className="text-sm font-semibold">B 房 ComfyUI 正在生成…</div>
                {generationProgress?.percent !== undefined && (
                  <div className="h-1.5 w-48 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${generationProgress.percent}%` }} />
                  </div>
                )}
                <div className="max-w-sm text-xs text-muted-foreground">{generationProgress?.message || '正在排队'}</div>
                <p className="pt-1 text-xs text-muted-foreground">切换页面不会中断生成</p>
              </div>
            ) : generationError ? (
              <div className="flex max-w-md flex-col items-center gap-2 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-lg font-bold text-destructive">!</div>
                <div className="text-sm font-semibold text-destructive">生成失败</div>
                <p className="whitespace-pre-wrap break-all text-left text-xs leading-relaxed text-muted-foreground">{generationError}</p>
              </div>
            ) : previewUrl ? (
              <button type="button" onClick={() => window.open(previewUrl, '_blank')} className="cursor-zoom-in rounded-xl">
                <img src={previewUrl} alt="生成结果" className="max-h-[70vh] w-auto rounded-xl object-contain shadow-lg" />
              </button>
            ) : (
              <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
                <SparklesIcon className="size-10 opacity-35" />
                <div>点素材的「+文字」加描述，选一张参考图，点生成</div>
                <div className="text-xs">生成只走 B 房间本机显卡，单位网络看不到内容</div>
              </div>
            )}
          </div>

          {history.length > 0 && (
            <div className="border-t pt-3">
              <div className="mb-2 text-xs text-muted-foreground">最近生成（{history.length}）</div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {history.slice(0, 8).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title="点击放大"
                    onClick={() => window.open(item.imageUrl, '_blank')}
                    className="size-16 shrink-0 overflow-hidden rounded-lg border hover:border-primary"
                  >
                    <img src={item.imageUrl} alt="" className="size-full object-cover" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
