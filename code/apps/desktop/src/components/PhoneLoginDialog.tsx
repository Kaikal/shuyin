/**
 * 平台「手机验证码」登录弹窗（QQ 音乐 / 酷狗）。
 *
 * 三步：输手机号 → 收短信 → 输码登录。只有 QQ 音乐撞上风控时才多一步：
 * 去验证页过滑块，回来点「我已验证，重新发送」。
 *
 * 为什么不做成官方网页登录窗：那条路在手机上是死结——用户切去 QQ 的那一刻
 * 页面就被系统挂起，回来时二维码已经换了（实测 123 秒寿命、离开 2 秒就换）。
 * 短信这条路不依赖任何「另一台设备」，也不用离开 App。
 *
 * 酷狗也走这里还有一个额外理由：它的网页登录窗签的 cookie 读不了云歌单
 * （`20017`），而 `/v7/login_by_verifycode` 签的是 App 级 token。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PlatformSource } from '@shuyin/lx-provider'
import { loginKgWithSms, sendKgSms, type KgAccount } from '../lib/kgLogin'
import { clearDailyCache } from '../lib/online'
import { finishQrLogin } from '../lib/platformAccount'
import { toast } from '../lib/toast'
import { loginWithSms, openCaptcha, sendLoginSms } from '../lib/txLogin'
import { Modal } from './Modal'

interface Props {
  open: boolean
  /** 哪家平台：`tx` = QQ 音乐（带人机验证），`kg` = 酷狗 */
  source: PlatformSource
  onClose(): void
  /** 登录成功（凭证已落盘） */
  onLogged(): void
}

/** 中国大陆手机号：1 开头、第二位 3-9、共 11 位 */
const PHONE_RE = /^1[3-9]\d{9}$/

/** 重发间隔（秒）。平台侧有频率限制，60 秒是常见口径 */
const RESEND_SEC = 60

export function PhoneLoginDialog({ open, source, onClose, onLogged }: Props) {
  const kg = source === 'kg'
  const label = kg ? '酷狗音乐' : 'QQ音乐'
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  /** 验证码输入框是否已展开（短信发出成功后才展开） */
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /** 人机验证链接：非空时界面多一块「去验证」 */
  const [captcha, setCaptcha] = useState('')
  /** 重发倒计时（秒），0 = 可以发 */
  const [left, setLeft] = useState(0)
  /**
   * 酷狗：这个号码下绑了多个账号，等用户选一个。
   *
   * 不是错误态——34175 那一步验证码已经校验通过了，只是要指定用哪个账号。
   * 选定后拿**同一个验证码**再提一次（平台不会在选账号那步消费掉它）。
   */
  const [choices, setChoices] = useState<KgAccount[] | null>(null)

  /** 回调每次渲染都是新引用，进 effect 会把倒计时反复重启 → 走 ref */
  const cb = useRef({ onClose, onLogged })
  cb.current = { onClose, onLogged }

  /* 关掉就清空：下次打开必须是干净的表单，别把上一个号的验证码带进来 */
  useEffect(() => {
    if (open) return
    setPhone('')
    setCode('')
    setSent(false)
    setErr('')
    setCaptcha('')
    setLeft(0)
    setChoices(null)
  }, [open])

  useEffect(() => {
    if (left <= 0) return
    const t = window.setTimeout(() => setLeft(n => Math.max(0, n - 1)), 1000)
    return () => window.clearTimeout(t)
  }, [left])

  /** 发短信。`retry` = 用户刚做完人机验证，回来重发一次 */
  async function send(retry = false) {
    if (busy) return
    if (!PHONE_RE.test(phone)) {
      setErr('手机号看起来不对，检查一下')
      return
    }
    setBusy(true)
    setErr('')
    if (!retry) setCaptcha('')
    try {
      const r = kg ? await sendKgSms(phone) : await sendLoginSms(phone)
      if ('captcha' in r) {
        // 风控：短信还没发出去，必须先过滑块。别把「去验证」和「重发」的按钮藏起来
        setCaptcha(r.captcha)
        return
      }
      setCaptcha('')
      setSent(true)
      setLeft(RESEND_SEC)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function goCaptcha() {
    try {
      await openCaptcha(captcha)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '打不开验证页')
    }
  }

  /** `pickUserid` 只由「选账号」那个列表传进来 */
  async function submit(pickUserid?: string) {
    if (busy) return
    if (code.trim().length < 4) {
      setErr('验证码还没输完')
      return
    }
    // 手动点「登录」= 重新走一遍，把上一次残留的账号列表收掉
    if (!pickUserid) setChoices(null)
    setBusy(true)
    setErr('')
    try {
      const r = kg ? await loginKgWithSms(phone, code.trim(), pickUserid) : await loginWithSms(phone, code.trim())
      if ('captcha' in r) {
        setCaptcha(r.captcha)
        return
      }
      /*
       * 酷狗：验证码已经通过了，只是这个号绑了多个账号。
       * 不当失败处理——把账号列出来让用户点，点完拿同一个验证码再提一次。
       */
      if ('needChoose' in r) {
        setChoices(r.accounts)
        /*
         * 把键盘收掉。验证码已经输完了，接下来只是点一下账号；
         * 而手机上键盘会把列表压掉一半（安卓 WebView 的 dvh 不跟着键盘缩），
         * 用户只能看见第一个号，第二个藏在键盘底下。
         */
        ;(document.activeElement as HTMLElement | null)?.blur()
        return
      }
      /*
       * 凭证到手后不再自己拼账号：统一走 `finishQrLogin` ——
       * 它会落盘、再问一次平台「这凭证认不认」，认不出来就算失败。
       * 判定标准和扫码 / 网页登录完全一致，不会出现「显示已登录但推荐还是公共的」。
       */
      const res = await finishQrLogin(source, r.cookie)
      if (!res.ok) {
        setErr(res.error || '登录没生效，再试一次')
        return
      }
      clearDailyCache()
      toast(`已登录${label}`, { ok: true })
      cb.current.onLogged()
      cb.current.onClose()
    } catch (e) {
      // 登录没成（多半是验证码过期）：把账号列表收掉，让用户重新收一条短信。
      // 否则列表还挂在那儿，点哪个号都是同一个错，看着像「选了没反应」。
      setChoices(null)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const phoneOk = PHONE_RE.test(phone)

  return (
    <Modal
      open={open}
      title={`登录${label}`}
      hint={kg ? '收一条短信就能登，登录后可读云歌单' : '收一条短信就能登，不用扫码'}
      onClose={onClose}
      width={360}
      footer={
        <>
          <span className="modal-sp" />
          <button className="ghost-btn" onClick={onClose}>关闭</button>
        </>
      }
    >
      <div className="form-col">
        <label className="form-label" htmlFor="ph-phone">手机号</label>
        <div className="phone-row">
          <span className="phone-cc">+86</span>
          <input
            id="ph-phone"
            className="text-input"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={11}
            placeholder="11 位手机号"
            value={phone}
            onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
            onKeyDown={e => { if (e.key === 'Enter' && left === 0) void send() }}
          />
          <button
            className="ghost-btn phone-send"
            disabled={!phoneOk || busy || left > 0}
            onClick={() => void send()}
          >
            {left > 0 ? `${left} 秒后重发` : '获取验证码'}
          </button>
        </div>

        {sent && (
          <>
            <label className="form-label" htmlFor="ph-code">验证码</label>
            <input
              id="ph-code"
              className="text-input"
              type="tel"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="短信里的 6 位数字"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => { if (e.key === 'Enter') void submit() }}
            />
            <button className="primary-btn phone-go" disabled={busy || code.length < 4} onClick={() => void submit()}>
              {busy ? '登录中…' : '登录'}
            </button>
          </>
        )}

        {/*
         * 多账号：验证码已经过了，只差「用哪个号」。
         * 点一行就拿同一个验证码再提一次，不用重新收短信。
         */}
        {choices && (
          <div className="kg-pick">
            <p className="kg-pick-t">这个手机号下有多个账号，选一个继续</p>
            {choices.map(a => (
              <button
                key={a.userid}
                type="button"
                className="kg-acct"
                disabled={busy}
                onClick={() => void submit(a.userid)}
              >
                {a.avatar
                  ? <img className="kg-acct-av" src={a.avatar} alt="" />
                  : <span className="kg-acct-av kg-acct-ph" aria-hidden="true" />}
                <span className="kg-acct-main">
                  <span className="kg-acct-nm">{a.nickname || `账号 ${a.userid.slice(-4)}`}</span>
                  <span className="kg-acct-id">uid {a.userid}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {err && <p className="phone-err">{err}</p>}
        <p className="phone-note">
          {kg
            ? '登录用 App 级凭证，只读你账号下的歌单与每日推荐，不会动账号里的任何东西。'
            : '登录只用于读取你账号下的歌单与推荐，不会动账号里的任何东西。'}
        </p>
      </div>

      {/*
       * 人机验证铺满一屏，不塞进弹窗里。
       *
       * 验证页（y.qq.com/m/client/safety_captcha）是按整屏设计的：拼图卡片 + 上下留白
       * 加起来比弹窗的正文区高得多，硬塞进去只能看到上半截，滑块拖到底就点不到了。
       * 这个页面既没有 X-Frame-Options 也没有 frame-ancestors，可以直接 iframe，
       * 所以也不必跳浏览器——验证做完人还在 App 里。
       *
       * 挂到 body 上：留在 `.modal-card` 里的话，那一层有自己的层叠上下文
       * （动画 + 阴影），底部按钮会被播放条和导航栏盖掉。
       */}
      {!kg && captcha && createPortal(
        <div className="cap-sheet" role="dialog" aria-label="安全验证">
          <div className="cap-bar">
            <span className="cap-title">安全验证</span>
            <button className="cap-x" onClick={() => setCaptcha('')}>关闭</button>
          </div>
          <iframe className="cap-frame" src={captcha} title="安全验证" />
          <div className="cap-foot">
            {err && <p className="cap-err">{err}</p>}
            <div className="cap-acts">
              <button className="primary-btn cap-done" disabled={busy} onClick={() => void send(true)}>
                {busy ? '发送中…' : '验证完成，重新发送'}
              </button>
              <button className="qr-alt" onClick={() => void goCaptcha()}>滑块动不了？换个浏览器</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </Modal>
  )
}
