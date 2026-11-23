import { createFileRoute } from '@tanstack/react-router'
import { ActivityIcon, LoaderCircleIcon, PlayIcon, RefreshCwIcon, SquareIcon, TriangleAlertIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/notifications'

export const Route = createFileRoute('/services')({
  staticData: { title: '服务控制台' },
  component: ServicesPage,
})

type SvcState = 'on' | 'off' | 'ext' | 'paused' | 'unknown'
interface SvcStatus {
  comfyui: { state: SvcState; port: boolean; detail: unknown }
  bridge: { state: SvcState; remote: boolean }
  frpc: { state: SvcState }
}
interface LogLine { t: string; lvl: string; msg: string }

async function command(action: string): Promise<any> {
  const res = await fetch('/api/bridge/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

function StateBadge({ state, extra }: { state: SvcState; extra?: string }) {
  const map: Record<SvcState, { label: string; cls: string }> = {
    on: { label: '运行中', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    ext: { label: '运行中(外部)', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    off: { label: '已停止', cls: 'bg-muted text-muted-foreground' },
    paused: { label: '已暂停', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    unknown: { label: '未知', cls: 'bg-muted text-muted-foreground' },
  }
  const m = map[state] || map.unknown
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}>{m.label}{extra ? ` · ${extra}` : ''}</span>
}

function ServiceRow({
  title, desc, state, extra, busy, onStart, onStop, onRestart,
}: {
  title: string; desc: string; state: SvcState; extra?: string; busy: boolean
  onStart?: () => void; onStop?: () => void; onRestart?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/20 p-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          <StateBadge state={state} extra={extra} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {onStart && <Button size="sm" disabled={busy} onClick={onStart}><PlayIcon className="size-3.5" />开启</Button>}
        {onRestart && <Button size="sm" variant="outline" disabled={busy} onClick={onRestart}><RefreshCwIcon className="size-3.5" />重启</Button>}
        {onStop && <Button size="sm" variant="destructive" disabled={busy} onClick={onStop}><SquareIcon className="size-3.5" />关闭</Button>}
      </div>
    </div>
  )
}

function ServicesPage() {
  const [status, setStatus] = useState<SvcStatus | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([command('status'), command('logs')])
      setStatus(s?.status || null)
      setLogs(Array.isArray(l?.logs) ? l.logs.slice(-80).reverse() : [])
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '状态获取失败')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [refresh])

  const run = async (action: string, label: string) => {
    setBusy(action)
    try {
      const r = await command(action)
      toast.success(r?.message || r?.result?.message || `${label} 完成`)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label} 失败`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="服务控制台"
        description="一处开关 B 房电脑的 ComfyUI / 桥接转发 / frpc 隧道。指令经安全通道下发到 4060 电脑，无需挨个找脚本。"
        actions={<Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCwIcon className="size-3.5" />刷新</Button>}
      />

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="size-4" />
          {error}（B 房服务管理器未启动或远程断开）
        </div>
      )}

      {!status && !error && (
        <div className="flex items-center justify-center gap-2 rounded-xl border py-12 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />正在读取服务状态…
        </div>
      )}

      {status && (
        <div className="space-y-2.5">
          <ServiceRow
            title="ComfyUI (4060)"
            desc="生图引擎，监听 127.0.0.1:8188。开启/重启/关闭由本机控制器执行。"
            state={status.comfyui?.state || 'unknown'}
            extra={status.comfyui?.port ? '端口可达' : undefined}
            busy={busy !== null}
            onStart={() => void run('comfy_start', '开启 ComfyUI')}
            onRestart={() => void run('comfy_restart', '重启 ComfyUI')}
            onStop={() => void run('comfy_stop', '关闭 ComfyUI')}
          />
          <ServiceRow
            title="Bridge 任务转发"
            desc="手机→4060 的生图通道。暂停后进程仍在，可随时远程恢复；暂停期间生图请求会快速失败。"
            state={status.bridge?.state || 'unknown'}
            extra={status.bridge?.remote ? '已连接远程' : '远程离线'}
            busy={busy !== null}
            onStart={() => void run('agent_resume', '恢复桥接')}
            onStop={() => void run('agent_pause', '暂停桥接')}
          />
          <ServiceRow
            title="frpc 隧道（备用）"
            desc="frp 备用通道，与桥接并存。日常用桥接即可，frpc 保持关闭更省事也更安全。"
            state={status.frpc?.state || 'unknown'}
            busy={busy !== null}
            onStart={() => void run('frpc_start', '开启 frpc')}
            onStop={() => void run('frpc_stop', '关闭 frpc')}
          />
        </div>
      )}

      <div className="rounded-xl border">
        <div className="flex items-center gap-2 border-b px-3.5 py-2.5 text-sm font-semibold">
          <ActivityIcon className="size-4" />实时日志
        </div>
        <div className="max-h-72 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <p className="text-muted-foreground">暂无日志</p>
          ) : logs.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground/60">{l.t}</span>
              <span className={l.lvl === 'err' ? 'text-red-500' : l.lvl === 'warn' ? 'text-amber-500' : ''}>{l.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
