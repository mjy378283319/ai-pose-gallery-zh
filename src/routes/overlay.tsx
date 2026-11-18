import { createFileRoute, Link } from '@tanstack/react-router'
import {
  DownloadIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  TypeIcon,
  UploadIcon,
} from 'lucide-react'
import { type ChangeEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/notifications'
import { useStudio } from '@/store/studioStore'

export const Route = createFileRoute('/overlay')({
  staticData: { title: '图片加字' },
  component: OverlayPage,
})

type Align = 'left' | 'center' | 'right'

interface OverlayStyle {
  fontSize: number
  fontFamily: string
  bold: boolean
  color: string
  strokeColor: string
  strokeWidth: number
  background: boolean
  backgroundOpacity: number
  align: Align
}

interface Position {
  x: number
  y: number
}

interface Source {
  name: string
  url: string
}

interface MineItem {
  kind?: 'image' | 'text'
  name: string
  label?: string
  url: string | null
  caption: string
  size: number
  mtime: string
}

const DEFAULT_STYLE: OverlayStyle = {
  fontSize: 64,
  fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
  bold: true,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 3,
  background: true,
  backgroundOpacity: 0.45,
  align: 'center',
}

const DEFAULT_POSITION: Position = { x: 0.5, y: 0.9 }

const FONT_OPTIONS = [
  { label: '微软雅黑 / 苹方（推荐）', value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { label: '黑体', value: '"SimHei", "Heiti SC", sans-serif' },
  { label: '宋体', value: '"SimSun", "Songti SC", serif' },
  { label: '等线 / 系统默认', value: 'sans-serif' },
]

const POSITION_PRESETS: Array<{ label: string; x: number; y: number; align: Align }> = [
  { label: '顶部居中', x: 0.5, y: 0.08, align: 'center' },
  { label: '中部居中', x: 0.5, y: 0.5, align: 'center' },
  { label: '底部居中', x: 0.5, y: 0.9, align: 'center' },
  { label: '左上', x: 0.05, y: 0.08, align: 'left' },
  { label: '右上', x: 0.95, y: 0.08, align: 'right' },
  { label: '左下', x: 0.05, y: 0.9, align: 'left' },
  { label: '右下', x: 0.95, y: 0.9, align: 'right' },
]

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

function wrapLines(ctx: CanvasRenderingContext2D, lines: string[], maxWidth: number): string[] {
  const result: string[] = []
  for (const line of lines) {
    if (!line) {
      result.push('')
      continue
    }
    let current = ''
    for (const char of Array.from(line)) {
      const candidate = current + char
      if (current && ctx.measureText(candidate).width > maxWidth) {
        result.push(current)
        current = char
      } else {
        current = candidate
      }
    }
    if (current) result.push(current)
  }
  return result.length ? result : ['']
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  text: string,
  style: OverlayStyle,
  position: Position,
) {
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)

  if (!text.trim()) return

  // 字号按 1000px 宽图片设计，导出时按原图宽度等比缩放，832/1024/1216 宽都一致。
  const scale = width / 1000
  const fontSize = Math.max(8, style.fontSize * scale)
  const lineHeight = fontSize * 1.28
  ctx.font = `${style.bold ? '700 ' : ''}${fontSize}px ${style.fontFamily}`
  ctx.textBaseline = 'top'
  ctx.textAlign = style.align

  const x = clamp(position.x, 0, 1) * width
  const margin = width * 0.04
  let maxWidth = width - margin * 2
  if (style.align === 'left') maxWidth = width - x - margin
  if (style.align === 'right') maxWidth = x - margin
  if (style.align === 'center') maxWidth = 2 * Math.min(x, width - x) - margin
  maxWidth = Math.max(fontSize * 2, maxWidth)

  const lines = wrapLines(ctx, text.replace(/\r/g, '').split('\n'), maxWidth)
  const blockHeight = lineHeight * lines.length
  let startY = clamp(position.y, 0, 1) * height - blockHeight / 2 + (lineHeight - fontSize) / 2
  startY = clamp(startY, 0, Math.max(0, height - fontSize))

  lines.forEach((line, index) => {
    const y = startY + index * lineHeight
    if (!line) return

    const textWidth = ctx.measureText(line).width
    let boxX = x
    if (style.align === 'center') boxX = x - textWidth / 2
    if (style.align === 'right') boxX = x - textWidth

    if (style.background) {
      const padX = fontSize * 0.36
      const padY = fontSize * 0.18
      ctx.globalAlpha = clamp(style.backgroundOpacity, 0, 1)
      ctx.fillStyle = style.strokeColor
      ctx.fillRect(boxX - padX, y - padY, textWidth + padX * 2, fontSize + padY * 2)
      ctx.globalAlpha = 1
    }

    if (style.strokeWidth > 0) {
      ctx.lineWidth = Math.max(1, style.strokeWidth * scale)
      ctx.strokeStyle = style.strokeColor
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      ctx.strokeText(line, x, y)
    }

    ctx.fillStyle = style.color
    ctx.fillText(line, x, y)
  })
}

function OverlayPage() {
  const { history } = useStudio()
  const recentImageUrl = history.find((item) => item.imageUrl)?.imageUrl

  const [source, setSource] = useState<Source | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [text, setText] = useState('在这里输入要写在图片上的文字')
  const [style, setStyle] = useState<OverlayStyle>(DEFAULT_STYLE)
  const [position, setPosition] = useState<Position>(DEFAULT_POSITION)
  const [mineItems, setMineItems] = useState<MineItem[]>([])
  const [loadingMine, setLoadingMine] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const objectUrlRef = useRef<string | null>(null)
  const draggingRef = useRef(false)

  function updateStyle<K extends keyof OverlayStyle>(key: K, value: OverlayStyle[K]) {
    setStyle((prev) => ({ ...prev, [key]: value }))
  }

  const useSource = (name: string, url: string) => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    setImage(null)
    setSource({ name, url })
  }

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
    if (!source) return
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (!cancelled) setImage(img)
    }
    img.onerror = () => {
      if (cancelled) return
      setImage(null)
      toast.error('图片加载失败，请换一张图片')
    }
    img.src = source.url
    return () => {
      cancelled = true
    }
  }, [source])

  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !image) return
    drawOverlay(canvas, image, text, style, position)
  }, [image, text, style, position])

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
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
    const url = URL.createObjectURL(file)
    objectUrlRef.current = url
    setImage(null)
    setSource({ name: file.name.replace(/\.[^.]+$/, ''), url })
    event.target.value = ''
  }

  const download = () => {
    if (!image) {
      toast.info('先选择一张图片')
      return
    }
    const canvas = document.createElement('canvas')
    drawOverlay(canvas, image, text, style, position)
    canvas.toBlob((blob) => {
      if (!blob) {
        toast.error('导出失败，请重试')
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const safeName = (source?.name || 'image').replace(/[\\/:*?"<>|]/g, '_')
      a.href = url
      a.download = `${safeName}_加字.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success('已导出 PNG（原图尺寸）')
    }, 'image/png')
  }

  const applyPreset = (preset: (typeof POSITION_PRESETS)[number]) => {
    setPosition({ x: preset.x, y: preset.y })
    updateStyle('align', preset.align)
  }

  const updatePositionFromPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    setPosition({
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    })
  }

  const mineImages = mineItems.filter((item) => item.kind !== 'text' && item.url)

  return (
    <>
      <PageHeader
        title="图片加字"
        description="给生成图或导入图片叠加文字，浏览器本地合成，原尺寸导出 PNG；不调用 ComfyUI，不改动显卡链路。"
        actions={
          <Button variant="outline" size="sm" onClick={() => { setText(''); setStyle(DEFAULT_STYLE); setPosition(DEFAULT_POSITION) }}>
            <RotateCcwIcon className="size-3.5" />
            重置文字样式
          </Button>
        }
      />

      <div className="mt-4 grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <ImagePlusIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">1. 选择图片</span>
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => fileRef.current?.click()}>
                <UploadIcon className="size-3.5" />
                上传本地图片
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link to="/studio">
                  <SparklesIcon className="size-3.5" />
                  去生成图片
                </Link>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!recentImageUrl}
                onClick={() => recentImageUrl && useSource('最近生成图', recentImageUrl)}
              >
                <SparklesIcon className="size-3.5" />
                用最近生成图
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
              <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                {mineImages.length ? (
                  mineImages.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs hover:bg-accent"
                      onClick={() => useSource(item.label || item.name, item.url!)}
                    >
                      <img src={item.url!} alt="" className="size-7 shrink-0 rounded object-cover" />
                      <span className="truncate">{item.label || item.name}</span>
                    </button>
                  ))
                ) : (
                  <div className="text-xs text-muted-foreground">没有图片素材，可先在「我的素材」上传。</div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <TypeIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">2. 输入文字</span>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="支持换行；中文建议每行不超过 12 个字"
              className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">字体</span>
                <select
                  value={style.fontFamily}
                  onChange={(e) => updateStyle('fontFamily', e.target.value)}
                  className="w-full rounded-lg border bg-background px-2 py-1.5 text-xs"
                >
                  {FONT_OPTIONS.map((font) => (
                    <option key={font.label} value={font.value}>{font.label}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">对齐</span>
                <div className="flex gap-1">
                  {(['left', 'center', 'right'] as Align[]).map((align) => (
                    <Button
                      key={align}
                      type="button"
                      size="sm"
                      variant={style.align === align ? 'default' : 'outline'}
                      className="flex-1 px-1"
                      onClick={() => updateStyle('align', align)}
                    >
                      {align === 'left' ? '左' : align === 'center' ? '中' : '右'}
                    </Button>
                  ))}
                </div>
              </label>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="flex justify-between text-muted-foreground">
                <span>字号（按 1000px 宽等比）</span><span>{style.fontSize}</span>
              </span>
              <input
                type="range"
                min={20}
                max={180}
                step={2}
                value={style.fontSize}
                onChange={(e) => updateStyle('fontSize', Number(e.target.value))}
                className="w-full"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 text-xs">
                <input type="color" value={style.color} onChange={(e) => updateStyle('color', e.target.value)} className="size-8 rounded border bg-background p-0.5" />
                文字颜色
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="color" value={style.strokeColor} onChange={(e) => updateStyle('strokeColor', e.target.value)} className="size-8 rounded border bg-background p-0.5" />
                描边/底框颜色
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1 text-xs">
                <span className="flex justify-between text-muted-foreground"><span>描边宽度</span><span>{style.strokeWidth}</span></span>
                <input type="range" min={0} max={12} step={1} value={style.strokeWidth} onChange={(e) => updateStyle('strokeWidth', Number(e.target.value))} className="w-full" />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="flex justify-between text-muted-foreground"><span>底框透明度</span><span>{Math.round(style.backgroundOpacity * 100)}%</span></span>
                <input type="range" min={0} max={0.9} step={0.05} value={style.backgroundOpacity} onChange={(e) => updateStyle('backgroundOpacity', Number(e.target.value))} className="w-full" />
              </label>
            </div>

            <div className="flex flex-wrap gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={style.bold} onChange={(e) => updateStyle('bold', e.target.checked)} />
                加粗
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={style.background} onChange={(e) => updateStyle('background', e.target.checked)} />
                文字底框（更清晰）
              </label>
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="text-sm font-medium">3. 放置位置</div>
            <div className="grid grid-cols-4 gap-1.5">
              {POSITION_PRESETS.map((preset) => (
                <Button key={preset.label} type="button" size="sm" variant="outline" className="h-7 px-1 text-[11px]" onClick={() => applyPreset(preset)}>
                  {preset.label}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1 text-xs">
                <span className="flex justify-between text-muted-foreground"><span>水平</span><span>{Math.round(position.x * 100)}%</span></span>
                <input type="range" min={0} max={1} step={0.01} value={position.x} onChange={(e) => setPosition((p) => ({ ...p, x: Number(e.target.value) }))} className="w-full" />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="flex justify-between text-muted-foreground"><span>垂直</span><span>{Math.round(position.y * 100)}%</span></span>
                <input type="range" min={0} max={1} step={0.01} value={position.y} onChange={(e) => setPosition((p) => ({ ...p, y: Number(e.target.value) }))} className="w-full" />
              </label>
            </div>
            <p className="text-[11px] text-muted-foreground">也可以直接拖动右侧预览中的文字位置。</p>
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">预览与导出</span>
            {source && <span className="truncate text-xs text-muted-foreground">{source.name}</span>}
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!source}
                onClick={() => {
                  if (objectUrlRef.current) {
                    URL.revokeObjectURL(objectUrlRef.current)
                    objectUrlRef.current = null
                  }
                  setImage(null)
                  setSource(null)
                }}
              >
                清除图片
              </Button>
              <Button size="sm" onClick={download} disabled={!image || !text.trim()}>
                <DownloadIcon className="size-3.5" />
                导出 PNG
              </Button>
            </div>
          </div>

          <div className="flex min-h-[420px] items-center justify-center overflow-hidden rounded-2xl bg-background p-4">
            {image ? (
              <canvas
                ref={previewRef}
                className="max-h-[70vh] w-auto max-w-full cursor-crosshair select-none touch-none rounded-lg shadow-lg"
                onPointerDown={(event) => {
                  draggingRef.current = true
                  event.currentTarget.setPointerCapture(event.pointerId)
                  updatePositionFromPointer(event)
                }}
                onPointerMove={(event) => {
                  if (draggingRef.current) updatePositionFromPointer(event)
                }}
                onPointerUp={() => { draggingRef.current = false }}
                onPointerCancel={() => { draggingRef.current = false }}
                onLostPointerCapture={() => { draggingRef.current = false }}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
                <ImagePlusIcon className="size-10" />
                <div>先上传图片，或用「最近生成图 / 我的素材」载入</div>
                <div className="text-xs">合成只在浏览器本地完成，导出为原图尺寸 PNG</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
