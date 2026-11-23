import { useEffect, useState, type ReactNode } from 'react'
import './auth.css'

type AuthState = { enabled: boolean; authenticated: boolean }

/**
 * 应用登录门（样式参考拓竹耗材管家）：未登录时整屏独立卡片，与应用完全分离。
 * 未配置 APP_PASSWORD 时 enabled=false，直接放行，本地开发无感。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/auth/state')
      .then((r) => r.json())
      .then((s: AuthState) => setState(s))
      .catch(() => setState({ enabled: false, authenticated: true })) // 后端未启用鉴权时放行
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password) { setError('请输入密码'); return }
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, remember }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.message || '登录失败')
        return
      }
      setState({ enabled: true, authenticated: true })
      setPassword('')
    } catch {
      setError('网络错误，请重试')
    } finally {
      setBusy(false)
    }
  }

  // 加载中 / 无需登录 / 已登录
  if (state === null) return null
  if (!state.enabled || state.authenticated) return <>{children}</>

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-head">
          <span className="auth-logo">✨</span>
          <div>
            <div className="auth-name">AI 角色合成台</div>
            <div className="auth-tag">POSE &amp; CHARACTER Atlas</div>
          </div>
        </div>

        <h1>登录</h1>
        <p className="auth-sub">请输入访问密码</p>

        <form onSubmit={submit} autoComplete="on">
          <label className="auth-field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <label className="auth-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>保持登录状态（30 天）</span>
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="auth-foot">数据保存在你自己的服务器上</p>
      </div>
    </div>
  )
}
