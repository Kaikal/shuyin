/**
 * 账号与同步：登录卡片（邮箱验证码）+ 登录后的同步操作。
 *
 * 两个入口共用这一份实现：
 *   * 设置页 → 「账号与同步」（外层再包标题、快速备份、环境设置）；
 *   * 「我的」页 → 右上角「登录 / 同步」按钮弹出的小窗。
 * 同一个功能写两遍必然改两遍，所以这里只留一个实体，两处都用它。
 *
 * 只有邮箱验证码一条路：短信登录要上海地域 + 短信签名审核 + 按条计费，
 * 而云开发的邮箱验证码是内置邮件代发，零配置、不单独计费。
 * 微信登录在桌面 WebView（来源 tauri.localhost）里从根上走不通，也不放按钮了。
 */
import { useCallback, useEffect, useState } from 'react'
import { IconCheck, IconRefresh, IconUpload } from './icons'
import {
  getScopes, humanizeCloudError, loadProfile, pushToCloud, restoreSession,
  sendEmailCode, setScopes, signInWithEmail, signOut, syncDown,
  type CloudProfile, type SyncScopes, type Verification,
} from '../lib/cloud'
import { KEYS, settings } from '../lib/settings'
import { toast } from '../lib/toast'
import { confirm } from '../lib/confirm'

interface Props {
  /** 登录态变化时通知外层（「我的」页据此切换按钮文案） */
  onProfile?(p: CloudProfile | null): void
  /** 紧凑版：去掉同步范围，只留登录 / 同步两个按钮（给弹窗用） */
  compact?: boolean
}

export function AccountPanel({ onProfile, compact = false }: Props) {
  const [profile, setProfile] = useState<CloudProfile | null>(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [verification, setVerification] = useState<Verification | null>(null)
  const [wait, setWait] = useState(0)
  const [busy, setBusy] = useState('')
  const [scopes, setScopesState] = useState<SyncScopes>({ playlists: true, sources: true, settings: true, theme: true })
  const [lastSync, setLastSync] = useState(0)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void (async () => {
      setScopesState(await getScopes())
      setLastSync((await settings.get<number>(KEYS.cloudLastSync)) ?? 0)
      const saved = await loadProfile()
      // 先把「有登录态」这件事渲染出来，再去后台校验会话——否则每次打开都要空等一次网络
      setReady(true)
      if (saved) {
        setProfile(saved)
        // 顺便把邮箱回填进输入框：换设备登录时少打一次
        if (saved.email) setEmail(saved.email)
        onProfile?.(saved)
        const live = await restoreSession()
        if (live) { setProfile(live); onProfile?.(live) }
        // 会话失效时别装没事：restoreSession 已经把本地资料清了，这里同步 UI
        else { setProfile(null); onProfile?.(null) }
      }
    })()
    // onProfile 是个回调用，别让它进依赖，否则父组件每次渲染都会重跑一轮网络请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (wait <= 0) return
    const id = window.setInterval(() => setWait(w => Math.max(0, w - 1)), 1000)
    return () => window.clearInterval(id)
  }, [wait])

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  const doSend = async () => {
    if (busy) return
    if (!emailOk) { toast('请输入有效的邮箱地址', { bad: true }); return }
    setBusy('code')
    try {
      const v = await sendEmailCode(email)
      setVerification(v)
      setWait(60)
      toast('验证码已发送，请查收邮箱', { ok: true })
    } catch (e) {
      toast(humanizeCloudError(e), { bad: true })
    } finally {
      setBusy('')
    }
  }

  const doLogin = async () => {
    if (busy) return
    if (!verification) { toast('请先获取验证码', { bad: true }); return }
    if (!/^\d{4,8}$/.test(code.trim())) { toast('验证码为 4~8 位数字', { bad: true }); return }
    setBusy('login')
    try {
      const p = await signInWithEmail(email, code, verification)
      setProfile(p)
      setCode('')
      setVerification(null)
      onProfile?.(p)
      toast('登录成功', { ok: true })
    } catch (e) {
      toast(humanizeCloudError(e), { bad: true })
    } finally {
      setBusy('')
    }
  }

  const doLogout = async () => {
    const okQuit = await confirm({
      title: '退出登录',
      message: '本机数据会保留，只是不再与云端同步。',
      confirmText: '退出',
      danger: true,
    })
    if (!okQuit) return
    await signOut()
    setProfile(null)
    setLastSync(0)
    onProfile?.(null)
    toast('已退出登录，本机数据不受影响')
  }

  const doPush = useCallback(async () => {
    if (!profile || busy) return
    setBusy('push')
    try {
      const r = await pushToCloud(profile)
      setLastSync(Date.now())
      const kb = Math.max(1, Math.round(r.bytes / 1024))
      if (r.adopted > 0) {
        /* 云端有本机没有的歌单 → 已经合并进来了，重载一次让「我的」列出来 */
        toast(`已同步（${kb} KB），并从云端取回 ${r.adopted} 个歌单`, { ok: true })
        window.setTimeout(() => window.location.reload(), 900)
      } else {
        toast(`已同步到云端（${kb} KB）`, { ok: true })
      }
    } catch (e) {
      toast(humanizeCloudError(e, 'sync'), { bad: true })
    } finally {
      setBusy('')
    }
  }, [profile, busy])

  const doPull = async () => {
    if (!profile || busy) return
    const okPull = await confirm({
      title: '从云端恢复数据',
      message: '歌单会合并（不会丢本机独有的），设置项以云端为准。',
      confirmText: '恢复',
    })
    if (!okPull) return
    setBusy('pull')
    try {
      const r = await syncDown(profile)
      if (!r) toast('云端暂无备份，请先同步一次', { bad: true })
      else {
        setLastSync(Date.now())
        toast('已从云端恢复', { ok: true })
        window.setTimeout(() => window.location.reload(), 900)
      }
    } catch (e) {
      toast(humanizeCloudError(e, 'sync'), { bad: true })
    } finally {
      setBusy('')
    }
  }

  const toggleScope = (k: keyof SyncScopes) => {
    const next = { ...scopes, [k]: !scopes[k] }
    setScopesState(next)
    void setScopes(next)
  }

  if (!ready) return <div className="acct-loading" aria-hidden="true" />

  if (!profile) {
    return (
      <div className="login-card">
        <div className="login-row">
          <input
            className="text-input" type="email" inputMode="email" autoComplete="email"
            placeholder="邮箱地址" maxLength={80}
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && wait === 0) void doSend() }}
          />
          <button
            className="ghost-btn"
            disabled={!!busy || wait > 0 || !emailOk}
            onClick={() => void doSend()}
          >
            {wait > 0 ? `${wait}s 后重发` : busy === 'code' ? '发送中…' : '发送验证码'}
          </button>
        </div>
        <div className="login-row">
          <input
            className="text-input" inputMode="numeric" autoComplete="one-time-code" placeholder="验证码" maxLength={8}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={e => { if (e.key === 'Enter') void doLogin() }}
          />
          <button className="primary-btn" disabled={!!busy || !code} onClick={() => void doLogin()}>
            {busy === 'login' ? '登录中…' : '登录'}
          </button>
        </div>
      </div>
    )
  }

  const when = lastSync
    ? new Date(lastSync).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <div className="acct-body">
      <div className="acct-who">
        <span className="acct-mail" title={profile.email || profile.uid}>{profile.email || profile.uid}</span>
        <span className="acct-when">{when ? `上次同步 ${when}` : '还没同步过'}</span>
        <button className="link-btn" onClick={() => void doLogout()}>退出登录</button>
      </div>

      {!compact && (
        <div className="set-row">
          <span className="set-label">同步范围</span>
          <span className="set-ctl scope-ctl">
            {([
              ['playlists', '歌单'],
              ['sources', '音源'],
              ['settings', '设置'],
              ['theme', '主题'],
            ] as Array<[keyof SyncScopes, string]>).map(([k, label]) => (
              <button
                key={k}
                className={'chip' + (scopes[k] ? ' on' : '')}
                aria-pressed={scopes[k]}
                onClick={() => toggleScope(k)}
              >
                {scopes[k] && <IconCheck width={10} height={10} />} {label}
              </button>
            ))}
          </span>
        </div>
      )}

      <div className={'acct-sync' + (compact ? ' compact' : '')}>
        <button className="primary-btn" disabled={!!busy} onClick={() => void doPush()}>
          <IconUpload width={12} height={12} /> {busy === 'push' ? '上传中…' : '立即同步'}
        </button>
        <button className="ghost-btn" disabled={!!busy} onClick={() => void doPull()}>
          <IconRefresh width={12} height={12} /> {busy === 'pull' ? '恢复中…' : '从云端恢复'}
        </button>
      </div>
    </div>
  )
}
