/**
 * 扫码登录协议（应用内画二维码，不弹官方网页）。
 *
 * 为什么不用「开官方登录页」那条路：用户的原话是「突然弹出来一个网易云页面，
 * 看着不好看」。二维码是登录这件事**唯一必要**的界面元素，其余都属于平台的网页。
 *
 * 网易云自己网页登录用的就是这套接口，不需要签名：
 *   POST /api/login/qrcode/unikey?type=1         → { code:200, unikey }
 *   GET  /api/login/qrcode/client/login?key=…&type=1
 *        → 800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 成功（带 cookie）
 * 二维码内容固定是 `https://music.163.com/login?codekey=<unikey>`，
 * 用网易云 App 扫一扫就能认。
 *
 * 请求走独立的 HttpClient（**不带账号 cookie**）：这一整段是「还没有登录」时跑的，
 * 带上旧 cookie 只会让平台按上一个账号处理。
 */
import qrcode from 'qrcode-generator'
import type { PlatformSource } from '@shuyin/lx-provider'
import { invoke } from './bridge'
import { createTauriHttpClient } from './tauriNet'

const http = createTauriHttpClient()

/** 未登录也要带的「客户端身份」：缺了 appver/os，接口直接 4xx */
const BASE_COOKIE = 'appver=8.9.70; os=pc;'
const BASE_HEADERS: Record<string, string> = {
  Referer: 'https://music.163.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

/**
 * 扫码这一个会话自己的 cookie 罐（**不跨会话复用**）。
 *
 * 只装平台在 Set-Cookie 里回给我们的东西（网易云是 NMTID）：它是「同一台机器」
 * 的凭据，二维码 key 跟它绑在一起。每次请求都换一个新 NMTID 的话，
 * 803 有可能只回一句「授权成功」而不给凭证。
 */
const jar = new Map<string, string>()

/** 一次扫码结束（成功 / 换码 / 关闭）就把它清掉，别把上一张码的身份带进下一张 */
export function resetQrSession() {
  jar.clear()
}

function signHeaders(): Record<string, string> {
  const extra = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  return { ...BASE_HEADERS, Cookie: extra ? `${BASE_COOKIE} ${extra}` : BASE_COOKIE }
}

/** 把响应头里的 Set-Cookie 收进罐子里。多值用 \n 或 ", " 拼过，两种都要拆 */
function absorbCookies(raw: string | undefined) {
  if (!raw) return
  for (const piece of raw.split(/\n|,(?=\s*[A-Za-z0-9_.\-]+=)/)) {
    const first = piece.split(';')[0]?.trim()
    if (!first) continue
    const i = first.indexOf('=')
    if (i <= 0) continue
    const k = first.slice(0, i).trim()
    const v = first.slice(i + 1).trim()
    // Max-Age / Expires 这些属性没有值，别当 cookie 存
    if (!k || !v || /^(max-?age|expires|path|domain|secure|httponly|samesite)$/i.test(k)) continue
    /*
     * **已经有的不覆盖**。网易云每回一次响应就发一个新的 NMTID，
     * 跟着它换，等于「申请二维码的会话」和「后来轮询的会话」不是同一个 ——
     * 803 时服务端只回一句「授权成功」而不下凭证，正是这个症状。
     * 扫码这一个会话从头到尾用同一个身份，才对得上。
     */
    if (!jar.has(k)) jar.set(k, v)
  }
}

/** cookie 串里有没有真正的登录凭证（不是「有个 cookie」就算） */
function hasAuth(cookie: string, keys: string[]): boolean {
  return keys.some(k => new RegExp(`(^|;\\s*)${k}=`).test(cookie))
}

/** 二维码的四种状态。`ok` 之后同一个 key 就失效了，不能再轮询 */
export type QrState = 'waiting' | 'scanned' | 'expired' | 'ok'

export interface QrSession {
  source: PlatformSource
  /** 平台给的会话 key（网易云叫 unikey） */
  key: string
  /** 要编进二维码的内容 */
  content: string
  /** 生成时间：用来在本地兜底判过期（平台偶尔不报 800） */
  at: number
}

export interface QrPoll {
  state: QrState
  /** `state === 'ok'` 时可直接塞进请求头的整串 cookie */
  cookie?: string
  /** 比「过期」更准确的原因（例如 803 却没解析出凭证），有就优先显示 */
  error?: string
  /**
   * 扫码这条路走不通了，应该改走**官方登录窗**。
   *
   * 只在「手机上说登录成功、服务端却不给凭证」时置位（网易云对新设备登录
   * 有时要做二次验证）。让上层自动换一条路，别把用户困在「换一张再扫」的循环里。
   */
  fallback?: boolean
}

/** 只有实现了扫码协议的平台才有这一项 */
export const QR_PLATFORMS: PlatformSource[] = ['wy']

export const supportsQr = (s: PlatformSource) => QR_PLATFORMS.includes(s)

/**
 * 一次请求 = 解析后的 JSON + 响应头。
 *
 * 为什么要带头：网易云 803（授权成功）在某些出口上**只在 `Set-Cookie` 里给
 * MUSIC_U**，body 里的 `cookie` 字段是空串。只读 body 就会得到
 * 「登录成功了但没拿到凭证」——用户看到的就是这句话，而他其实已经登上了。
 */
interface QrResponse {
  json: any
  headers: Record<string, string>
  /** 原始响应体：803 却没解析出凭证时，靠它在日志里留证据 */
  text: string
}

async function call(method: 'GET' | 'POST', url: string, body?: string): Promise<QrResponse> {
  const headers = signHeaders()
  /*
   * POST 必须把参数放进**表单 body**（官方网页就是这么发的），
   * 只挂在 query 上、body 留空会被服务端当成「空请求」：
   * 查状态那几步照样回 801/802，但 803 要签发凭证时它认不出是哪个 key，
   * 于是只回一句「授权成功」，body 里没有 `cookie` —— 用户看到的就是
   * 「登录成功了但没拿到凭证」。
   */
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    // 浏览器发同源 POST 会带 Origin，少了它请求看起来就不像网页发的
    headers.Origin = 'https://music.163.com'
  }
  const res = await http.request({
    url,
    method,
    headers,
    body,
    responseType: 'json',
    timeout: 10_000,
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`扫码接口返回 ${res.status}`)
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
  /* 顺手把 Set-Cookie 收进会话：网易云把「这台机器」的身份记在 NMTID 里，
     二维码会话跟它对不上时，803 可能不给凭证。下一轮带着它再问就好。 */
  absorbCookies(res.headers?.['set-cookie'])
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch { /* 预热首页回的是 HTML，没有 JSON */ }
  return { json, headers: res.headers ?? {}, text }
}

/** 诊断日志（写进 app.log）。失败一律忽略：日志不能影响登录 */
function diag(event: string, detail: string) {
  try {
    void invoke('diag_log', { event, detail }).catch(() => { /* 安卓 / 浏览器预览没有这个命令 */ })
  } catch { /* 同上 */ }
}

async function postJson(url: string, body?: string): Promise<any> {
  return (await call('POST', url, body)).json
}

/**
 * 先落一次首页，把「这台机器」的身份（NMTID / _ntes_nuid / __csrf）收进会话罐。
 *
 * 真实浏览器就是这么走的：先打开 music.163.com，再在那个会话里申请二维码。
 * 裸着申请 unikey 也能拿到 key，但 803（授权成功）时服务端可能不认这个
 * **没有来历**的会话 —— 于是只回一句「授权成功」，body 里 `cookie` 是空串，
 * 用户看到的就是「登录成功了但没拿到凭证」。
 */
async function warmUp() {
  try {
    await call('GET', 'https://music.163.com/')
  } catch { /* 首页拿不到就裸着走，别把扫码整个挡住 */ }
}

/**
 * 换一张二维码。
 *
 * 有效期由平台控制（约 5 分钟），本地记 `at` 是给「用户放着不管」兜底：
 * 到点还没扫就把状态改成已过期，省得他对着一个早就失效的码一直等。
 */
export async function startQrLogin(source: PlatformSource): Promise<QrSession> {
  if (!supportsQr(source)) throw new Error('该平台暂不支持扫码登录')
  resetQrSession()
  if (source === 'wy') {
    await warmUp()
    // 参数同时放 query 和表单 body：官方就是这么发的，两条都认得
    const j = await postJson('https://music.163.com/api/login/qrcode/unikey?type=1', 'type=1')
    if (Number(j?.code) !== 200 || !j?.unikey) throw new Error('没拿到二维码，稍后再试')
    const key = String(j.unikey)
    diag('qr.wy.new', `cookies=${[...jar.keys()].join(',')}`)
    return { source, key, content: `https://music.163.com/login?codekey=${key}`, at: Date.now() }
  }
  throw new Error('该平台暂不支持扫码登录')
}

/** 二维码本地有效期（毫秒）。平台约 5 分钟，这里取 4 分半先判过期，留一点余量 */
const QR_TTL = 270_000

/**
 * 查一次扫码状态。
 *
 * `scanned` = 用户已经扫过了。**这时本地计时必须作废**：
 * 扫完码还要在手机上点「确认登录」，人可能正在切 App、回消息，磨蹭两分钟很正常；
 * 本地 TTL 抢先判死的话，界面会在「已扫码，在手机上确认一下」之后突然跳成
 * 「二维码已过期」——而平台那边这张码其实还好好的。过期只由平台（800）说了算。
 */
export async function pollQrLogin(session: QrSession, opts: { scanned?: boolean } = {}): Promise<QrPoll> {
  if (!opts.scanned && Date.now() - session.at > QR_TTL) return { state: 'expired' }
  if (session.source === 'wy') {
    /*
     * 动词用 POST：官方网页自己就是用 POST 查这张码的。
     * GET 也能拿到 801/802，但 803 那一轮服务端可能只认 POST 分支才下发凭证
     * （「登录成功却没凭证」的样子，正好像查状态和真登录走了两条路）。
     * 出口个别会拦 POST，所以抛错就退回 GET —— 至少别把轮询打断。
     */
    const pollOnce = async (): Promise<QrResponse> => {
      const q = `key=${encodeURIComponent(session.key)}&type=1&t=${Date.now()}`
      const url = `https://music.163.com/api/login/qrcode/client/login?${q}`
      try {
        return await call('POST', url, `key=${encodeURIComponent(session.key)}&type=1`)
      } catch {
        return call('GET', url)
      }
    }
    let r = await pollOnce()
    let code = Number(r.json?.code)
    if (code === 803) {
      /*
       * 803 = 授权成功。凭证可能在 body 的 `cookie` 里，也可能**只**在 Set-Cookie 里，
       * 字段名还可能不是 cookie（见过包在 data / cookies 里的）。
       * 三处都找一遍；还拿不到就最多再问两次（平台那边落库有延迟），别第一下就判死。
       */
      for (let attempt = 0; attempt < 3; attempt++) {
        const cookie = authCookieOf(r)
        if (cookie) {
          diag('qr.wy.ok', `attempt=${attempt} len=${cookie.length}`)
          return { state: 'ok', cookie }
        }
        if (attempt === 2) break
        await new Promise(r2 => setTimeout(r2, 700))
        r = await pollOnce()
        code = Number(r.json?.code)
        if (code !== 803) break
      }
      /*
       * 803 却始终没有凭证：这个账号在扫码这条路上被卡住了（网易云对新设备登录
       * 要做验证时，就是「手机上说成功了、服务端不给票」）。
       * 把原始响应记下来，同时让上层**直接改走官方登录窗**——那里读的是
       * WebView2 自己的 cookie，一定能拿到 MUSIC_U，不会把用户困在换码死循环里。
       */
      diag('qr.wy.nocookie', `${r.text.slice(0, 300)} | hdr=${Object.keys(r.headers ?? {}).join(',')}`)
      return {
        state: 'expired',
        error: '网易云没把登录凭证给扫码这条路，已改用网页登录',
        fallback: true,
      }
    }
    if (code === 802) return { state: 'scanned' }
    if (code === 800) return { state: 'expired' }
    return { state: 'waiting' }
  }
  return { state: 'waiting' }
}

/**
 * 从一次 803 响应里把凭证挖出来。
 *
 * 顺序按「可信度」排，最后一层是**不管字段名直接按名字捞**：
 * 网易云改过几次返回形状（`cookie` → `data.cookie` → 只有响应头），
 * 每改一次就「登录成功但没凭证」，盯着字段名写死迟早再来一次。
 */
function authCookieOf(r: QrResponse): string {
  // ① body 的 cookie / cookies 字段（一直以来的主形状）
  const fromBody = cookieHeader(r.json?.cookie ?? r.json?.cookies)
  if (hasAuth(fromBody, ['MUSIC_U'])) return fromBody

  // ② Set-Cookie 响应头（httpOnly 凭证走这里）
  const fromHeader = cookieHeader(r.headers?.['set-cookie'])
  if (hasAuth(fromHeader, ['MUSIC_U'])) return fromHeader

  // ③ 兜底：整段响应里按 cookie 名捞值，捞到再配上响应头里的其它 cookie（__csrf 等）
  const bare = findMusicU(`${r.text}\n${Object.values(r.headers ?? {}).join('\n')}`)
  if (!bare) return ''
  return fromHeader ? `MUSIC_U=${bare}; ${fromHeader}` : `MUSIC_U=${bare}`
}

/** 在任意文本里找 `MUSIC_U=…` 的值（值里可能有 %xx，先解码一次再匹配） */
function findMusicU(text: string): string {
  let src = text
  if (/%[0-9A-Fa-f]{2}/.test(src)) {
    try { src = decodeURIComponent(src) } catch { /* 解不开就按原串找 */ }
  }
  const m = /MUSIC_U=([^;,"'\s\\]+)/.exec(src)
  return m ? m[1] : ''
}

/**
 * 把平台回的那串 `k=v; Max-Age=…; Expires=…; Path=/; HTTPOnly` 收拾成请求头。
 *
 * 平台返回的是**Set-Cookie 语法**，不是请求头语法：直接塞进 `Cookie` 头，
 * `Max-Age=2147483647` 会被服务端当成一个叫 Max-Age 的 cookie，
 * 真正的凭证反而可能因为整串太长被截断。所以只留 `k=v`，属性一律丢掉。
 *
 * 三种坑都要吃下去（都是线上真实见过的形状）：
 *   1. **整串被 URL 编码**（`MUSIC_U%3Dxxx%3B%20Max-Age%3D…`）——不解码就切不开，
 *      整串没有一个 `=`，全部被丢掉 → 空凭证 → 界面报「二维码已过期」。
 *   2. **是个数组**（新版接口按 Set-Cookie 逐条返回）。
 *   3. **是个对象**（`{ MUSIC_U: '…' }`）。
 */
export function cookieHeader(raw: unknown): string {
  const ATTRS = /^(max-?age|expires|path|domain|secure|httponly|samesite|version|comment|priority)$/i

  const pieces: string[] = []
  if (Array.isArray(raw)) pieces.push(...raw.map(x => String(x)))
  else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v != null && v !== '') pieces.push(`${k}=${String(v)}`)
    }
  } else if (raw != null) pieces.push(String(raw))

  const out: string[] = []
  const seen = new Set<string>()
  for (const piece of pieces) {
    let src = piece
    if (/%[0-9A-Fa-f]{2}/.test(src)) {
      try { src = decodeURIComponent(src) } catch { /* 解不开就按原串处理 */ }
    }
    for (const seg of src.split(';')) {
      const s = seg.trim()
      const i = s.indexOf('=')
      if (i <= 0) continue
      const k = s.slice(0, i).trim()
      const v = s.slice(i + 1).trim()
      if (!k || !v || ATTRS.test(k) || seen.has(k)) continue
      seen.add(k)
      out.push(`${k}=${v}`)
    }
  }
  return out.join('; ')
}

/* ------------------------------------------------------------------ */
/* 二维码 → SVG 路径                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把内容编成二维码的**单条 path**。
 *
 * 为什么不用 `<canvas>`：二维码要能跟着窗口缩放、也要能跟着主题重画，
 * 矢量图省事。为什么不用一堆 `<rect>`：33×33 就是一千多个节点，
 * 每次刷新都重建一遍不值当——按行把连续的黑块并成一段 `h n` 即可。
 */
export function qrPath(content: string): { modules: number; path: string } {
  const qr = qrcode(0, 'M')
  qr.addData(content)
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++) {
    let c = 0
    while (c < n) {
      if (!qr.isDark(r, c)) { c++; continue }
      let len = 1
      while (c + len < n && qr.isDark(r, c + len)) len++
      d += `M${c} ${r}h${len}v1h-${len}z`
      c += len
    }
  }
  return { modules: n, path: d }
}
