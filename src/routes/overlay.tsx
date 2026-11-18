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

  // 把选中的图片设为工作流的人像参考槽位。当前 Z-Image 单图稳定工作流只认这一个槽位，
  // 所以无论素材内容是人像/服装/姿势，都从这里作为「参考图 + 文字」的输入。
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
      toast.success('参考图已就位，写一句描述即可生成')
    } catch {
      toast.error('图片加载失败，请换一张')
    } finally {
      setPicking(false)
    }
  }

  const pickMine = (item: MineItem) => {
    if (!item.url) return
    void useAsReference(item.label || item.name, item.url)
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
    if (!selected) {
      toast.info('先选一张参考图')
      return
    }
    if (!description.trim()) {
      toast.info('写一句你想要的画面描述')
      return
    }
    // startGeneration 的 overridePrompt 优先于配方拼接提示词，直接用用户写的描述。
    await startGeneration(description.trim())
  }

  const mineImages = mineItems.filter((item) => item.kind !== 'text' && item.url)

  return (
    <>
      <PageHeader
        title="素材生图"
        description="选一张素材图作为参考，写下你想要的画面，交给 B 房 ComfyUI 生成新图。生成只走本机显卡。"
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

      <div className="mt-4 grid gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <ImagePlusIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">1. 选一张参考图</span>
            </div>

            {selected ? (
              <div className="flex items-center gap-3 rounded-xl border bg-background p-2">
                <img src={selected.url} alt="参考图" className="size-16 shrink-0 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{selected.name}</div>
                  <div className="flex items-center gap-1 text-xs text-emerald-600">
                    <CheckIcon className="size-3.5" /> 已设为参考图
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-2"
                  onClick={() => { setSelected(null); setPortrait(null) }}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
                从下面「我的素材」选一张，或上传本地图片。这张图会作为生成的参考（人像 / 服装 / 姿势图都可以）。
              </div>
            )}

            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onFileChange(e)} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => fileRef.current?.click()} disabled={picking}>
                <UploadIcon className="size-3.5" /> 上传本地图片
              </Button>
              <Button size="sm" variant="outline" onClick={useRecent} disabled={picking || !history.length}>
                <WandSparklesIcon className="size-3.5" /> 用上一张生成图
              </Button>
            </div>

            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <FolderOpenIcon className="size-3.5" />
                我的素材（点击选用）
                <button type="button" className="ml-auto underline" onClick={() => void loadMine()} disabled={loadingMine}>
                  {loadingMine ? '刷新中' : '刷新'}
                </button>
              </div>
              <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
                {mineImages.length ? (
                  mineImages.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs hover:bg-accent ${selected?.url === item.url ? 'border-primary' : ''}`}
                      onClick={() => pickMine(item)}
                      disabled={picking}
                    >
                      <img src={item.url!} alt="" className="size-8 shrink-0 rounded object-cover" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{item.label || item.name}</span>
                        {item.caption && <span className="block truncate text-muted-foreground">{item.caption}</span>}
                      </span>
                      <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  ))
                ) : (
                  <div className="text-xs text-muted-foreground">还没有图片素材，可先到「我的素材」上传，或点上方「上传本地图片」。</div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <WandSparklesIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">2. 描述你想要的画面</span>
            </div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder="例：把这张图里的人换成白色连衣裙，站在樱花树下，阳光柔和，写实摄影风格，半身构图"
              className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground">
              写得越具体越好：主体、衣着/动作、场景、光线、风格、构图。参考图提供画面依据，文字决定改造成什么样。
            </p>
            <Button className="w-full" size="lg" onClick={() => void generate()} disabled={!isComfy || !selected || !description.trim() || isGenerating}>
              {isGenerating ? <LoaderCircleIcon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}
              {isGenerating ? '生成中…' : '生成新图'}
            </Button>
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
                <div>选一张参考图、写下描述，点「生成新图」</div>
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
