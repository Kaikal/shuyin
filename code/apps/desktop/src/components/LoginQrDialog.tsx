/**
 * 扫码登录弹窗：只画一张二维码，不弹官方网页。
 *
 * 三种状态的界面差别只有一行字和一张蒙层——扫码这件事用户只关心「扫上了没」，
 * 多一个按钮都是在添乱。所以除了「过期重刷」和底部的「用网页登录」兜底，
 * 这里没有别的东西可点。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformSource } from '@shuyin/lx-provider'
import { clearDailyCache, platformName } from '../lib/online'
import { finishQrLogin, loginPlatform } from '../lib/platformAccount'
import { pollQrLogin, qrPath, startQrLogin, type QrSession, type QrState } from '../lib/qrLogin'
import { toast } from '../lib/toast'
import { Modal } from './Modal'
import { IconRefresh } from './icons'

interface Props {
  open: boolean
  /** 要登录哪个平台（null = 没在登录） */
  source: PlatformSource | null
  onClose(): void
  /** 登录成功（cookie 已落盘） */
  onLogged(): void
}

type Phase = 'loading' | QrState | 'error'

/** 轮询间隔。1.5 秒：人扫码到看见「已扫码」的延迟感刚好，又不至于把接口打满 */
const POLL_MS = 1500

export function LoginQrDialog({ open, source, onClose, onLogged }: Props) {
  const [session, setSession] = useState<QrSession | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [qr, setQr] = useState<{ modules: number; path: string } | null>(null)
  const [err, setErr] = useState('')

  /** 回调每次渲染都是新引用，放进 effect 依赖会让轮询反复重启 → 走 ref */
  const cb = useRef({ onClose, onLogged })
  cb.current = { onClose, onLogged }

  const refresh = useCallback(async () => {
    if (!source) return
    setPhase('loading')
    setErr('')
    setQr(null)
    setSession(null)
    try {
      const s = await startQrLogin(source)
      setQr(qrPath(s.content))
      setSession(s)
      setPhase('waiting')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [source])

  /* 打开 / 换平台都重新要一张码 */
  useEffect(() => {
    if (!open || !source) return
    void refresh()
  }, [open, source, refresh])

  /* 关掉时清干净：下次打开必须是全新的码，不能拿着上一个人的会话接着轮询 */
  useEffect(() => {
    if (open) return
    setSession(null)
    setQr(null)
    setPhase('loading')
    setErr('')
  }, [open])

  /* 轮询状态。expired / error / ok 都终止——继续问只会得到同一个答案 */
  useEffect(() => {
    if (!open || !session) return
    let dead = false
    let timer = 0
    /* 扫过码之后本地 TTL 就不能再判过期：人正在手机上点确认，界面不能先投降 */
    let scanned = false
    const tick = async () => {
      if (dead) return
      try {
        const r = await pollQrLogin(session, { scanned })
        if (dead) return
        if (r.state === 'ok' && r.cookie) {
          setPhase('ok')
          const res = await finishQrLogin(session.source, r.cookie)
          if (dead) return
          if (res.ok) {
            clearDailyCache()
            toast(`已登录${platformName(session.source)}`, { ok: true })
            cb.current.onLogged()
            cb.current.onClose()
          } else {
            setErr(res.error || '登录没生效，再试一次')
            setPhase('error')
          }
          return
        }
        if (r.state === 'scanned') scanned = true
        if (r.error) setErr(r.error)
        setPhase(r.state)
        /*
         * 手机上说「登录成功」、网易云却不给凭证（新设备 / 异地登录要二次验证时就是这样）。
         * 这时候再换一张码也是同样的结果，别让用户一遍遍扫 ——
         * 直接改开官方登录窗：那里读的是 WebView2 自己的 cookie，凭证一定拿得到。
         */
        if (r.state === 'expired' && r.fallback) {
          window.setTimeout(() => {
            if (dead) return
            cb.current.onClose()
            void loginPlatform(session.source).then(res => {
              if (res.ok) {
                clearDailyCache()
                toast(`已登录${platformName(session.source)}`, { ok: true })
                cb.current.onLogged()
              } else if (!res.cancel) {
                toast(res.error || '登录失败', { bad: true })
              }
            })
          }, 1200)
          return
        }
        if (r.state === 'expired') return
      } catch {
        /*
         * 单次请求失败**不打断**轮询：扫码这几分钟里网络抖动很常见，
         * 断一次就让用户重新扫码是最糟的体验。连续失败由超时兜底。
         */
      }
      timer = window.setTimeout(tick, POLL_MS)
    }
    timer = window.setTimeout(tick, 900)
    return () => { dead = true; window.clearTimeout(timer) }
  }, [open, session])

  const name = source ? platformName(source) : ''
  const tip = phase === 'loading' ? '正在获取二维码…'
    : phase === 'waiting' ? '等待扫码'
      : phase === 'scanned' ? '已扫码，在手机上确认一下'
        : phase === 'ok' ? '登录成功'
          : phase === 'expired' ? (err || '二维码已过期')
            : err || '二维码没取到'

  return (
    <Modal
      open={open}
      title={`登录${name}`}
      onClose={onClose}
      width={330}
      footer={
        <>
          <button
            className="qr-alt"
            onClick={() => {
              // 扫码这条路走不通时的兜底：开平台的官方登录页（能输账号密码）
              if (!source) return
              onClose()
              void loginPlatform(source).then(r => {
                if (r.ok) {
                  clearDailyCache()
                  toast(`已登录${platformName(source)}`, { ok: true })
                  cb.current.onLogged()
                } else if (!r.cancel) {
                  toast(r.error || '登录失败', { bad: true })
                }
              })
            }}
          >
            用网页登录
          </button>
          <span className="modal-sp" />
          <button className="ghost-btn" onClick={onClose}>关闭</button>
        </>
      }
    >
      <div className="qr-wrap" data-phase={phase}>
        <div className="qr-card">
          {qr
            ? (
              <svg
                className="qr-svg"
                viewBox={`0 0 ${qr.modules} ${qr.modules}`}
                shapeRendering="crispEdges"
                role="img"
                aria-label={`${name}登录二维码`}
              >
                <rect width={qr.modules} height={qr.modules} fill="#fff" />
                <path d={qr.path} fill="#15171b" />
              </svg>
            )
            : <span className="qr-ph" aria-hidden="true" />}

          {(phase === 'expired' || phase === 'error') && (
            <button className="qr-mask" onClick={() => void refresh()}>
              <IconRefresh width={15} height={15} />
              <span>点这里换一张</span>
            </button>
          )}
          {phase === 'ok' && <span className="qr-mask ok">登录成功</span>}
        </div>

        <p className="qr-tip">
          <span className="qr-dot" aria-hidden="true" />
          {tip}
        </p>
        <p className="qr-sub">打开「{name}」App，用「扫一扫」</p>
      </div>
    </Modal>
  )
}
