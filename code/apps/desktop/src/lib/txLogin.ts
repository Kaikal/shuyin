/**
 * QQ 音乐「手机验证码」登录（应用内完成，不弹官方网页）。
 *
 * 为什么单独开一条路：手机上扫码登录的前提是「手边还有第二台设备」——
 * 安卓这台本身就是手机，让用户扫自己屏幕上的码走不通（实测过，二维码会在
 * 离开 App 的瞬间被页面换掉）。密码登录也被风控挡住。改成「收短信」之后，
 * 整条链路都在 App 内：输手机号 → 收码 → 输码 → 拿凭证。
 *
 * 协议（实测确认，非臆测）：
 *   POST musicu.fcg  music.login.LoginServer / SendPhoneAuthCode
 *                    → req_0.code 0 = 已发出；20276 = 先过安全验证（data.securityURL）
 *   POST musicu.fcg  music.login.LoginServer / Login（phoneNo + code + loginMode:1）
 *                    → req_0.data 即凭证（musickey / musicid / refresh_key …）
 *
 * 两个必须踩准的点：
 *   1. **身份要用 Android 客户端那套**（`ct: 11` / `cv: 20090008` / `chid: 10003505`），
 *      发码和换票据都用它。用网页版身份（`platform: "yqq.json"`）能把短信验过去、
 *      能把账号认出来，但服务端**不签 `musickey`**——实测回 20351，`data` 里
 *      `musicid` / `openid` / `access_token` 都给全了，唯独 `musickey` 是空串。
 *      手机号验证码登录是客户端才有的能力，网页版身份拿不到票据。
 *   2. 判断成功与否看 `req_0.code`，**不能看 `data.code`**——风控那条 20276
 *      的 `data` 里根本没有 code 字段，照 data.code 判会把「短信已发出」误报成失败。
 *
 * 请求走原生 `net_request`（桌面 Rust / 安卓 Kotlin 同一命令）：
 * `u.y.qq.com` 不回 CORS 头，渲染进程里 fetch 拿不到 body。
 */
import { invoke } from './bridge'
import { createTauriHttpClient } from './tauriNet'

const FCG = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

/** 网页版 UA */
const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 客户端 UA：换票据那一步身份必须跟着 comm 一起换成「Android 客户端」 */
const ANDROID_CV = 20_090_008

const http = createTauriHttpClient()

/** 从 WebView 的 UA 里抠机型和系统版本，让 comm 里的 `os_ver` / `phonetype` 是真值 */
function deviceFacts(): { osVer: string; model: string } {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const osVer = /Android\s+([\d.]+)/i.exec(ua)?.[1] ?? '12'
  const raw = /Android\s+[\d.]+;\s*([^;)]+)/i.exec(ua)?.[1] ?? 'Android'
  return { osVer, model: raw.replace(/Build\/.*/i, '').trim() || 'Android' }
}

/*
 * 设备标识。
 *
 * 服务端把 `OpenUDID` / `udid` 当成「这台客户端」的记忆用：每次请求换一个，
 * 等于每次都换台新手机来登录——换票据那一步最忌讳这个。所以只生成一次，
 * 落 localStorage，之后一直复用。
 */
function persistentId(key: string, bytes = 8): string {
  try {
    const hit = localStorage.getItem(key)
    if (hit) return hit
  } catch {
    /* 隐私模式读不到就当没有 */
  }
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  const v = [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  try { localStorage.setItem(key, v) } catch { /* 存不下也只是这次会话内有效 */ }
  return v
}

/** WEB 平台公共参数（未登录态）。`tmeLoginMethod: 3` = 手机验证码 */
const COMM = {
  ct: 24,
  cv: 4747474,
  platform: 'yqq.json',
  chid: '0',
  tmeLoginMethod: 3,
  format: 'json',
  inCharset: 'utf-8',
  outCharset: 'utf-8',
  notice: 0,
  need_new_code: 1,
}

/**
 * Android 客户端那套公共参数。
 *
 * **必须用这一套换票据**：网页版身份能把短信验过去、也能把账号认出来，但服务端
 * 不会给网页版签 `musickey`——实测回 `20351`，`data` 里 `musicid` / `openid` /
 * `access_token` 全都给全了，唯独 `musickey` 是空串。手机号验证码登录是客户端才有的能力。
 *
 * 字段对的是 TME 客户端的公参（`ct: 11` / `cv: 20090008` / `chid: 10003505`）。
 * `QIMEI36` 我们没有采集（那是 TME 的设备指纹 SDK），留空即可——登录这条链不校验它。
 */
function androidComm(extra?: Record<string, unknown>): Record<string, unknown> {
  const { osVer, model } = deviceFacts()
  const guid = persistentId('sy.tx.guid')
  return {
    ct: 11,
    cv: ANDROID_CV,
    v: ANDROID_CV,
    chid: '10003505',
    tmeAppID: 'qqmusic',
    tmeLoginMethod: 3,
    tmeLoginType: 0,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: 0,
    need_new_code: 1,
    // traceid 里的时间戳是「这一次请求」的，不能缓存
    traceid: `10002_${guid}_${Math.floor(Date.now() / 1000)}`,
    QIMEI36: '',
    OpenUDID: guid,
    udid: guid,
    OpenUDID2: persistentId('sy.tx.guid2'),
    aid: persistentId('sy.tx.aid'),
    os_ver: osVer,
    phonetype: model,
    ...extra,
  }
}

/** `req_0.code` 的两种「非 0 但不该当失败」的值 */
const CODE_NEED_CAPTCHA = 20276
const CODE_OK = 0

/**
 * 业务码 → 人话。
 *
 * 平台自己几乎不回 `errMsg`（实测 20271 / 20351 的 `data.errMsg` 都是空串），
 * 所以只靠它只能给用户看一段 JSON——这里把常见码翻掉，剩下的原文兜底。
 */
const CODE_TEXT: Record<number, string> = {
  20261: '登录参数不对，多半是接口改了',
  20271: '验证码不对或已经过期，重新发一条再试',
  20272: '这个手机号的账号绑定异常，先去 QQ 音乐里处理一下',
  20274: '这个手机号还没绑定 QQ 音乐账号',
  20277: '账号被限制了，暂时登不上',
  20278: '账号被限制了，暂时登不上',
  20279: '登录过的设备太多了，去 QQ 音乐客户端里删掉几台再试',
  20450: '账号被封禁了',
  20351: '短信验过了，但这次的请求没拿到音乐票据（账号绑的是 QQ 号）。改用 QQ 账号授权登录',
  104604: '操作太频繁，等一会儿再试',
}

interface FcgResult {
  /** `req_0.code`：业务码，判成败只认它 */
  code: number
  /** `req_0.data`：业务体（凭证 / errMsg / securityURL） */
  data: any
  /** 原始响应：抛错时给用户看原文，别把真实原因吞掉 */
  raw: string
}

/**
 * 极简 cookie 罐。
 *
 * 原生 `net_request` 是无状态的——同一个会话里的两次请求不会自动共用 cookie。
 * 而「发短信」和「用验证码登录」在服务端是一对：码绑在发码那一方的会话上。
 * 所以这里自己存一层，把 `set-cookie` 收下来、下次带回去，装成同一个人。
 * 只服务 `u.y.qq.com` 这一条链路，不需要按域分桶。
 */
const jar = new Map<string, string>()

function harvest(headers: Record<string, string> | undefined): void {
  const raw = headers?.['set-cookie']
  if (!raw) return
  // 原生两侧（Rust / Kotlin）都按换行拼多值，因为 Set-Cookie 的值里自带逗号
  for (const line of raw.split('\n')) {
    const pair = line.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const k = pair.slice(0, eq).trim()
    const v = pair.slice(eq + 1).trim()
    if (!k) continue
    if (v) jar.set(k, v)
    else jar.delete(k)
  }
}

function jarHeader(): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 用哪套身份说话：`android` 才能拿到 `musickey`，`web` 只用于发码兜底 */
export type TxPlatform = 'web' | 'android'

async function callFcg(
  req: { module: string; method: string; param: object },
  opts: { platform?: TxPlatform; comm?: Record<string, unknown> } = {},
): Promise<FcgResult> {
  const platform = opts.platform ?? 'android'
  const cookie = jarHeader()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (platform === 'android') {
    headers['User-Agent'] = `QQMusic ${ANDROID_CV}(android ${deviceFacts().osVer})`
  } else {
    headers['User-Agent'] = UA_WEB
    headers.Referer = 'https://y.qq.com/'
    headers.Origin = 'https://y.qq.com'
  }
  if (cookie) headers.Cookie = cookie
  const comm = platform === 'android' ? androidComm(opts.comm) : { ...COMM, ...opts.comm }
  const res = await http.request({
    url: FCG,
    method: 'POST',
    headers,
    body: JSON.stringify({ comm, req_0: req }),
    timeout: 12_000,
  })
  harvest(res.headers)
  const raw = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
  if (res.status < 200 || res.status >= 300) throw new Error(`QQ 音乐接口返回 ${res.status}`)
  let j: any
  try {
    j = JSON.parse(raw)
  } catch {
    throw new Error('QQ 音乐返回了无法解析的内容')
  }
  /*
   * 留一份原文在内存里：出错时界面只能显示一小段（弹窗装不下整包 JSON），
   * 但排查时经常需要看 `openid` / `prompt2bind` 这些排在后面的字段。
   * 真机连上调试器读 `window.__syTxLog` 就能拿到完整几包。
   */
  const w = globalThis as unknown as { __syTxLog?: string[] }
  w.__syTxLog = [...(w.__syTxLog ?? []).slice(-9), raw]
  // 顶层 code 是网关码（一般 0），业务码在 req_0.code
  const node = j?.req_0 ?? {}
  const code = Number(node.code ?? NaN)
  if (Number.isNaN(code)) throw new Error(errText(node, j, raw, NaN))
  return { code, data: node.data ?? {}, raw }
}

/** 失败时优先用平台自己的话（`errMsg` / `errTip`），拿不到再按码翻译，最后才甩原文 */
function errText(node: any, top: any, raw: string, code: number): string {
  const m =
    node?.data?.errMsg ?? node?.errMsg ?? node?.data?.errtip ?? top?.errMsg ?? top?.error?.message
  if (m) return String(m)
  const known = CODE_TEXT[code]
  if (known) return known
  return `登录失败（${Number.isNaN(code) ? '无业务码' : code}）：${raw.slice(0, 600)}`
}

/** 一次「发短信」的结果：要么已发出，要么先过人机验证 */
export type SmsSent = { sent: true } | { captcha: string }

/**
 * 发短信验证码。
 *
 * 首次基本都会撞上风控（`20276 robot defense`），并在 `data.securityURL` 给一个
 * 滑块页。用户在验证页做完之后**原样重试本函数**即可——服务端认的是那个
 * URL 里的 token，跟我们这边带没带 cookie 无关。
 *
 * 身份用 Android 客户端那套（跟换票据保持一致）。万一客户端身份被拒
 * （签名/指纹这类我们给不出的东西），退回网页版再发一次——发码这条网页版是能用的。
 */
export async function sendLoginSms(phone: string): Promise<SmsSent> {
  const req = {
    module: 'music.login.LoginServer',
    method: 'SendPhoneAuthCode',
    param: { tmeAppid: 'qqmusic', areaCode: '86', phoneNo: phone },
  }
  const pick = (r: FcgResult): SmsSent => {
    const url = r.data?.securityURL
    if (url) return { captcha: String(url) }
    if (r.code === CODE_OK) return { sent: true }
    throw new Error(errText({ data: r.data }, null, r.raw, r.code))
  }

  const a = await callFcg(req, { platform: 'android' })
  if (a.code === CODE_OK || a.code === CODE_NEED_CAPTCHA || a.data?.securityURL || a.code === 104604) {
    return pick(a)
  }
  return pick(await callFcg(req, { platform: 'web' }))
}

/** 一次「验证码换凭证」的结果 */
export type SmsLogin = { ok: true; cookie: string } | { captcha: string }

/**
 * 验证码换登录凭证，并拼成平台层认的 cookie 串。
 *
 * 平台层（`lx-provider/platforms/tx.ts`）只从 cookie 里取两样东西：
 * `uin`（账号）和 `qm_keyst`（音乐票据），其余字段它不看。
 * 所以这里把凭证整理成一行 cookie 就够了，不必另建一套存储。
 */
export async function loginWithSms(phone: string, code: string): Promise<SmsLogin> {
  const r = await callFcg({
    module: 'music.login.LoginServer',
    method: 'Login',
    param: { phoneNo: phone, code, loginMode: 1 },
  })
  if (r.code !== CODE_OK) {
    const url = r.data?.securityURL
    if (r.code === CODE_NEED_CAPTCHA || url) {
      if (url) return { captcha: String(url) }
    }
    throw new Error(errText({ data: r.data }, null, r.raw, r.code))
  }
  const cookie = cookieOf(r.data)
  if (!cookie) throw new Error('QQ 音乐没有返回登录凭证')
  return { ok: true, cookie }
}

/**
 * 把凭证 dict 拼成 cookie。
 *
 * 字段名做过兼容：官方现在叫 `musickey` / `musicid`，但历史上换过几次名字，
 * 拼错一个字段的结果就是「登录成功但界面还是未登录」——比直接报错更难查。
 */
function cookieOf(d: any): string {
  const key = String(d?.musickey ?? d?.musicKey ?? d?.strMusicKey ?? '')
  const uin = String(d?.musicid ?? d?.strMusicid ?? '').replace(/\D/g, '')
  if (!key || !uin) return ''
  return `uin=${uin}; qqmusic_uin=${uin}; qm_keyst=${key}; qqmusic_key=${key}`
}

/** 在系统浏览器里打开人机验证页（App 内的 WebView 打不开这个域名） */
export async function openCaptcha(url: string): Promise<void> {
  await invoke('open_url', { url })
}
