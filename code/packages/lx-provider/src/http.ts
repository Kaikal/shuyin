/**
 * HTTP 小工具：统一超时、重试、错误语义。
 *
 * 约定：**失败要抛，不要静默返回空数组**。上层（搜索页）需要区分
 * 「真的没结果」和「请求挂了」，否则用户会以为是歌名打错了。
 */
import { HttpError, type HttpClient, type HttpRequestOptions } from './types'

/** 桌面端默认 10s；平台接口偶尔慢，给一次重试 */
export const DEFAULT_TIMEOUT = 10_000
const RETRY_DELAY = 400

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface FetchOptions extends Omit<HttpRequestOptions, 'url'> {
  retry?: number
}

async function once(client: HttpClient, opts: HttpRequestOptions): Promise<any> {
  const res = await client.request(opts)
  if (res.status < 200 || res.status >= 300) {
    const detail = typeof res.body === 'string' ? res.body.slice(0, 160) : ''
    throw new HttpError(opts.url, res.status, detail)
  }
  return res.body
}

/**
 * 宿主（Rust `net_request` / RN fetch）一律把 `body` 当**字符串**回，
 * 只有在 `responseType: 'json'` 时才尝试解析。解析放在这里而不是各平台里：
 * 少写一次就少一个「静默空列表」的坑（平台接口被风控时回的就是 HTML）。
 */
function toJson(req: HttpRequestOptions, body: any): any {
  if (typeof body !== 'string') return body
  const t = body.trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    throw new HttpError(req.url, 200, `响应不是 JSON：${t.slice(0, 120)}`)
  }
}

/** 取 JSON。body 可能是字符串（宿主返回原文）或已经解析好的对象 */
export async function getJson(client: HttpClient, url: string, opts: FetchOptions = {}): Promise<any> {
  const { retry = 1, ...rest } = opts
  const req: HttpRequestOptions = { url, method: 'GET', responseType: 'json', timeout: DEFAULT_TIMEOUT, ...rest }
  return withRetry(async () => toJson(req, await once(client, req)), retry, req)
}

export async function postJson(client: HttpClient, url: string, body: unknown, opts: FetchOptions = {}): Promise<any> {
  // headers 必须**最后**合，别用 `...rest` 整体覆盖：
  // 调用方传 headers 时会把 Content-Type 一起顶掉，接口不报错、只回空结果。
  const { retry = 1, headers, ...rest } = opts
  const req: HttpRequestOptions = {
    url,
    ...rest,
    method: 'POST',
    responseType: 'json',
    timeout: rest.timeout ?? DEFAULT_TIMEOUT,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  }
  return withRetry(async () => toJson(req, await once(client, req)), retry, req)
}

/**
 * 表单 POST。**必须和 postJson 分开**：
 * 网易云的 cloudsearch / 多数老接口只吃 `application/x-www-form-urlencoded`，
 * 传 JSON 会直接被风控成空结果（不是报错，是静默空数组，很难查）。
 */
export async function postForm(client: HttpClient, url: string, form: Record<string, string | number>, opts: FetchOptions = {}): Promise<any> {
  const { retry = 1, headers, ...rest } = opts
  const body = Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  const req: HttpRequestOptions = {
    url,
    ...rest,
    method: 'POST',
    responseType: 'json',
    timeout: rest.timeout ?? DEFAULT_TIMEOUT,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(headers ?? {}) },
    body,
  }
  return withRetry(async () => toJson(req, await once(client, req)), retry, req)
}

export async function getText(client: HttpClient, url: string, opts: FetchOptions = {}): Promise<string> {
  const { retry = 1, ...rest } = opts
  const req: HttpRequestOptions = { url, method: 'GET', responseType: 'text', timeout: DEFAULT_TIMEOUT, ...rest }
  return withRetry(() => once(client, req), retry, req)
}

async function withRetry<T>(run: () => Promise<T>, retry: number, req: HttpRequestOptions): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= retry; i++) {
    try {
      const body = await run()
      // 有些平台用 HTTP 200 + 空 body 表示被风控，这里当成错误，交给上层重试
      if (body === '' || body == null) throw new HttpError(req.url, 204, '空响应')
      return body as T
    } catch (e) {
      lastErr = e
      // 4xx 重试没有意义（除了 429）
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) break
      if (i < retry) await sleep(RETRY_DELAY)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/* ------------------------------------------------------------------ */
/* 文本清洗                                                            */
/* ------------------------------------------------------------------ */

/** 各平台的老接口会把 `&nbsp;` / `\u0026` 原样塞进歌名歌手 */
export function clean(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 「酷我」的 r.s 接口返回的是 **JS 字面量**：单引号包裹、key 不加引号、
 * 部分字段（MINFO）里还夹着 `level:p,bitrate:192` 这种伪 key。
 *
 * 不能简单对整串做正则替换——那会把字符串**内部**的 `,bitrate:` 也加上引号，
 * 直接把值写坏（实测报 `Expected ',' or '}' after property value`）。
 * 所以这里按字符扫描，只在「期待 key 的位置」才给裸标识符补引号。
 */
export function lenientJson<T = any>(text: string): T {
  const src = String(text ?? '').trim()
  if (!src) return null as unknown as T
  try {
    return JSON.parse(src) as T
  } catch {
    return JSON.parse(quoteLooseKeys(src)) as T
  }
}

function quoteLooseKeys(s: string): string {
  const n = s.length
  let out = ''
  let i = 0
  let expectKey = false
  while (i < n) {
    const c = s[i]
    // 字符串：统一转成双引号，内部的双引号转义
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let buf = ''
      while (j < n && s[j] !== quote) {
        if (s[j] === '\\') { buf += s[j] + (s[j + 1] ?? ''); j += 2; continue }
        buf += s[j] === '"' ? '\\"' : s[j]
        j++
      }
      out += `"${buf}"`
      expectKey = false
      i = j + 1
      continue
    }
    if (c === '{' || c === ',') { out += c; expectKey = true; i++; continue }
    if (c === '[' || c === ']' || c === '}' || c === ':') { out += c; expectKey = false; i++; continue }
    if (expectKey) {
      const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, i + 64))
      if (m) { out += `"${m[0]}"`; i += m[0].length; expectKey = false; continue }
    }
    out += c
    i++
  }
  return out
}

/** 秒数格式化由 UI 决定，这里只做数值归一（部分平台给毫秒） */
export function toSeconds(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 10_000 ? Math.round(n / 1000) : Math.round(n)
}

/* ------------------------------------------------------------------ */
/* 评论                                                                */
/* ------------------------------------------------------------------ */

/**
 * 评论正文清洗。
 *
 * 和 `clean()` 的区别只有一个，但很关键：**保留换行**。
 *   · 评论区 `.cm-text` 是 `pre-wrap`，正文里的真换行要留住；
 *   · QQ / 酷狗偶尔把换行写成**两个字面字符** `\n`（反斜杠 + n），
 *     直接显示就是「这条评论里有 \n」。先把这种转义还原成真换行，
 *     再做实体还原，最后只压空格、不压换行。
 */
export function commentText(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * `2026-10-24 23:16:20` → 秒级时间戳。
 *
 * 酷狗 / 酷我给的评论时间都是**北京时间字符串**，不是时间戳。
 * 直接 `Date.parse` 会按本机时区解释，非 UTC+8 的机器上会差几个小时，
 * 所以显式补 `+08:00`。
 */
export function cnTimeToSec(s: unknown): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? '').trim())
  if (!m) return 0
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`)
  return Number.isFinite(ms) ? Math.round(ms / 1000) : 0
}

/**
 * 评论表情代码 → 真表情。
 *
 * 三个平台三种写法，都得在进 UI 之前处理掉，否则评论区满是方括号：
 *   · 酷狗 / 酷我 —— `[玫瑰]` `[微笑]` 这种中文代码，能映射就映射成 unicode；
 *   · QQ —— `[em]e400851[/em]` 是**数字编号**，没有公开对照表，只能去掉
 *     （留着比没有更难看）；
 *   · 认不出来的中文代码原样保留——总比吞掉用户写的内容安全。
 */
const COMMENT_EMOJI: Record<string, string> = {
  玫瑰: '🌹', 凋谢: '🥀', 流泪: '😭', 大哭: '😭', 泪奔: '😭', 色: '😍', 可怜: '🥺', 委屈: '🥺',
  得意: '😏', 微笑: '🙂', 大笑: '😄', 笑哭: '😂', 呲牙: '😁', 偷笑: '🤭', 憨笑: '😄', 亲亲: '😘',
  调皮: '😛', 鬼脸: '😜', 睡: '😴', 晕: '😵', 疑问: '❓', 惊讶: '😲', 白眼: '🙄', 酷: '😎',
  害羞: '😳', 发怒: '😡', 抓狂: '😫', 难过: '😔', 汗: '😅', 撇嘴: '😒', 嘘: '🤫', 思考: '🤔',
  鼓掌: '👏', 强: '👍', 赞: '👍', good: '👍', 弱: '👎', NO: '👎', 握手: '🤝', 抱拳: '🙏',
  胜利: '✌️', OK: '👌', 爱心: '❤️', 心: '❤️', 心碎: '💔', 比心: '🫰', 给力: '💪', 加油: '💪',
  啤酒: '🍺', 咖啡: '☕', 蛋糕: '🎂', 礼物: '🎁', 红包: '🧧', 月亮: '🌙', 太阳: '☀️',
  下雨: '🌧️', 雪花: '❄️', 星星: '⭐', 火: '🔥', 炸弹: '💣', 刀: '🔪', 骷髅: '💀',
  便便: '💩', 允悲: '😢', 太开心: '😆', 酸: '🍋', 打call: '🙌', 跪了: '🧎', 喵喵: '🐱', doge: '🐶',
}

/** 把评论正文里的表情代码换掉（已经清洗过的正文再走这一步） */
export function emojiCode(input: string): string {
  if (!input) return ''
  return input
    .replace(/\[em\]e?\d+\[\/em\]/gi, '')
    .replace(/\[([^\[\]\n]{1,8})\]/g, (m, k) => COMMENT_EMOJI[k] ?? m)
}

/** 看起来像图片的 URL（用来把「语音 / 音频」从图片列表里剔掉） */
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)(?:[?#]|$)/i

/**
 * 从任意结构里收集**图片**地址。
 *
 * 为什么不能见到 url 就收：网易云的评论附件 `contentResource` 里
 * 既有图片**也有语音**（`resourceType: 1014`），语音的 `url` 是
 * `commentaudio.music.126.net/xxx.mp3`。以前直接收下来当图片用，
 * `<img src="*.mp3">` 必然失败——界面上就是一块永远空着的灰格子。
 *
 * 规则：显式给了 `imageUrl` / `picUrl` 的直接收；只给 `url` 的必须
 * 后缀像图片。协议相对（`//host/a.jpg`）补 https，`http://` 一律升 https。
 */
export function imageUrlsOf(input: unknown, out: string[] = []): string[] {
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return
    let u = raw.trim().replace(/&amp;/g, '&')
    if (!u) return
    if (u.startsWith('//')) u = `https:${u}`
    if (!/^https?:\/\//.test(u)) return
    if (!IMG_EXT.test(u)) return
    u = u.replace(/^http:\/\//, 'https://')
    if (!out.includes(u)) out.push(u)
  }
  // 显式图片字段：哪怕后缀不规范也收（部分 CDN 走 `?imageView` 之类的参数）
  const pushNamed = (raw: unknown) => {
    if (typeof raw !== 'string') return
    let u = raw.trim().replace(/&amp;/g, '&')
    if (u.startsWith('//')) u = `https:${u}`
    if (!/^https?:\/\//.test(u)) return
    u = u.replace(/^http:\/\//, 'https://')
    if (!out.includes(u)) out.push(u)
  }

  if (Array.isArray(input)) {
    for (const it of input) imageUrlsOf(it, out)
    return out
  }
  if (typeof input === 'string') {
    // 正文里内嵌的 <img src="...">（QQ 评论就这么给图）
    const re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(input))) push(m[1])
    return out
  }
  if (!input || typeof input !== 'object') return out

  const o = input as Record<string, any>
  if (o.imageUrl) pushNamed(o.imageUrl)
  if (o.picUrl) pushNamed(o.picUrl)
  if (o.url) push(o.url)
  if (o.images) imageUrlsOf(o.images, out)
  if (o.contentResource) imageUrlsOf(o.contentResource, out)
  return out
}

/* ------------------------------------------------------------------ */
/* 歌词                                                                */
/* ------------------------------------------------------------------ */

/** 秒 → `[mm:ss.xx]`，歌词时间轴统一用两位小数 */
export function lrcTime(sec: number): string {
  const total = Math.max(0, sec)
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`
}

/**
 * base64 → UTF-8 字符串。
 * Worker / 浏览器里没有 Buffer，但 `atob` 只认 latin1，中文必须自己按字节还原；
 * Node 侧（验证脚本）没有 atob 时退回 Buffer。
 */
export function b64decodeUtf8(input: string): string {
  const s = String(input ?? '').replace(/\s+/g, '')
  if (!s) return ''
  const g = globalThis as any
  try {
    if (typeof g.atob === 'function') {
      const bin = g.atob(s)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder('utf-8').decode(bytes)
    }
    if (g.Buffer) return g.Buffer.from(s, 'base64').toString('utf8')
  } catch {
    return ''
  }
  return ''
}
