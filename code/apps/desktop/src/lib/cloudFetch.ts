/**
 * 把云开发 SDK 的请求挪出 WebView。
 *
 * 为什么要这样：WebView2 里发出的请求必然带 `Origin: http://tauri.localhost`，
 * 而云开发网关的安全来源白名单**免费套餐改不了**（点「添加域名」直接提示
 * 「当前套餐无法执行此操作」）。于是登录必然被 403 掉，前端只看到
 * `TypeError: Failed to fetch`，界面翻译成「连不上云开发」——用户无从下手。
 *
 * 实测（2026-10）同一个接口：
 *   · 不带 Origin  → 401 + JSON（正常业务响应，说明网关认这个来源之外的服务端调用）
 *   · 带 Origin    → 403，body 空（安全来源拦截）
 *
 * 所以这里把发往云开发的 `fetch` 接管，交给 Rust 的 `net_request` 发。
 * 从服务端看是「没有 Origin 的普通调用」，不触发白名单；从 SDK 看还是正常的
 * `Response`，登录、数据库、token 全流程代码一行都不用改。
 *
 * 只拦云开发的域名，别的请求（音源、图片）一律原样放行。
 */
import { invoke, isNative } from './bridge'

/** 云开发网关的几种域名形态（国内 / 国际 / 老版 tcb-api） */
const PROXY_HOSTS: RegExp[] = [
  /(^|\.)api\.tcloudbasegateway\.com$/i,
  /(^|\.)api\.intl\.tcloudbasegateway\.com$/i,
  /(^|\.)tcb-api\.tencentcloudapi\.com$/i,
  /(^|\.)service\.tcloudbase\.com$/i,
  /(^|\.)tcb-api\.tcloudbase\.com$/i,
  /(^|\.)tcloudbase\.com$/i,
]

function hostOf(url: string): string {
  try {
    return new URL(url, window.location.href).hostname
  } catch {
    return ''
  }
}

function shouldProxy(url: string): boolean {
  const h = hostOf(url)
  return !!h && PROXY_HOSTS.some(re => re.test(h))
}

/**
 * 请求头里这几项由浏览器/原生自己算，或者会暴露来源，转发时必须去掉：
 *   · origin / referer —— 就是被白名单拦的那两个，带了等于白改
 *   · cookie —— CloudBase 用 localStorage 存 token，不靠 cookie
 *   · accept-encoding / content-length / host —— 由 ureq 按实际传输决定
 */
const DROP_REQ = new Set([
  'origin', 'referer', 'cookie', 'host',
  'accept-encoding', 'content-length', 'connection',
])

/** 响应头里这几项描述的是「那一段传输」，body 到手上时已经对不上了 */
const DROP_RES = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'set-cookie',
])

function headersToObject(src: HeadersInit | undefined | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!src) return out
  if (typeof Headers !== 'undefined' && src instanceof Headers) {
    src.forEach((v, k) => {
      if (!DROP_REQ.has(k.toLowerCase())) out[k] = v
    })
    return out
  }
  if (Array.isArray(src)) {
    for (const [k, v] of src) {
      if (k && !DROP_REQ.has(String(k).toLowerCase())) out[String(k)] = String(v)
    }
    return out
  }
  for (const [k, v] of Object.entries(src as Record<string, string>)) {
    if (!DROP_REQ.has(k.toLowerCase())) out[k] = String(v)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 字节：base64 往返                                                     */
/* ------------------------------------------------------------------ */

function b64Of(u8: Uint8Array): string {
  let s = ''
  // 一次 32K：`String.fromCharCode(...arr)` 的参数个数有上限，整块传会炸栈
  const STEP = 0x8000
  for (let i = 0; i < u8.length; i += STEP) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + STEP)))
  }
  return btoa(s)
}

function bytesOfB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

/**
 * 请求体分两类，绝不能混为一谈。
 *
 * 文本（JSON / 表单字面量）直接交给 `net_request` 的 `body`。
 * 而 **FormData / Blob / ArrayBuffer 是字节**：以前统一走
 * `new Response(x).text()`，FormData 转出来就是字符串 `"[object FormData]"`
 * ——17 个字符、Content-Type 却声称是 multipart，服务端解析出来只能是空的或者
 * 一堆垃圾。用户看到的现象就是「上传说成功，恢复时 JSON 解析失败」。
 *
 * 现在字节走 base64（`bodyB64`），原生按原始字节写出。
 * 顺带解决另一件事：multipart 的 boundary 必须和实际字节一致，
 * 只有 `new Response(formData)` 自己生成的这一对才是对的，所以 content-type
 * 也从它身上取，覆盖 SDK 传下来的那份。
 */
interface EncodedBody {
  text?: string
  b64?: string
  /** 字节体自带的 Content-Type（multipart 的 boundary 在里面） */
  contentType?: string
}

async function encodeBody(body: BodyInit): Promise<EncodedBody> {
  if (typeof body === 'string') return { text: body }
  const r = new Response(body)
  const buf = await r.arrayBuffer()
  return {
    b64: b64Of(new Uint8Array(buf)),
    contentType: r.headers.get('content-type') ?? undefined,
  }
}

/* ------------------------------------------------------------------ */
/* 诊断                                                                */
/* ------------------------------------------------------------------ */

/**
 * 最近若干次云开发请求的流水。
 *
 * SDK 的错误对象极难读（`new StorageError` 把内部错误 `String()` 成了
 * `[object Object]`，message / code 全丢），出问题时前端只能看到一句
 * 「上传失败」。把 URL、状态码、响应头几个字符留下来，设置页「复制诊断信息」
 * 会带上——下次再出问题不用连电脑抓包。
 */
const LOG: Array<Record<string, unknown>> = []

function note(rec: Record<string, unknown>): void {
  try {
    LOG.push(rec)
    if (LOG.length > 24) LOG.shift()
    ;(window as unknown as { __cloudLog?: unknown }).__cloudLog = LOG
  } catch { /* 诊断失败不许影响主流程 */ }
}

/** 设置页诊断用：把最近的请求流水拼成几行纯文本 */
export function cloudLogLines(): string[] {
  return LOG.map(r => {
    const u = String(r.url ?? '')
    const short = u.length > 96 ? `${u.slice(0, 60)}…${u.slice(-30)}` : u
    const body = r.bodyKind ? ` body=${r.bodyKind}${r.bodyLen ? `(${r.bodyLen})` : ''}` : ''
    const st = r.status ?? r.error ?? '?'
    const head = r.head ? ` ← ${String(r.head).replace(/\s+/g, ' ').slice(0, 60)}` : ''
    return `${st} ${r.method} ${short}${body}${head}`
  })
}

interface RawNetResponse {
  status: number
  headers: Record<string, string>
  body: string
  /** 原始字节的 base64；新原生都会给，老版本没有就走 body 文本 */
  bodyB64?: string
}

let installed = false

/** 装上拦截（只装一次；浏览器预览里什么都不做） */
export function installCloudFetch(): void {
  if (installed || !isNative) return
  installed = true

  const orig = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url = ''
    let method = init?.method || 'GET'
    let headers: Record<string, string> = headersToObject(init?.headers)
    let raw: Request | null = null

    if (typeof input === 'string') url = input
    else if (input instanceof URL) url = input.href
    else if (input instanceof Request) {
      raw = input
      url = input.url
      if (!init?.method) method = input.method
      // Request 自带的头优先度低于 init.headers
      headers = { ...headersToObject(input.headers), ...headers }
    }

    if (!shouldProxy(url)) {
      return raw ? orig(raw, init) : orig(input as RequestInfo, init)
    }

    const verb = method.toUpperCase()
    const noBodyVerb = verb === 'GET' || verb === 'HEAD'

    let payload: EncodedBody | null = null
    if (!noBodyVerb) {
      try {
        if (init?.body != null) payload = await encodeBody(init.body)
        else if (raw) payload = await encodeBody(await raw.clone().arrayBuffer())
      } catch (e) {
        note({ url, method: verb, error: `body 编码失败：${String(e).slice(0, 60)}` })
        throw new TypeError('请求体编码失败')
      }
    }
    if (payload?.text === '') payload = null
    if (payload?.b64 && payload.contentType) {
      headers = { ...headers, 'content-type': payload.contentType }
    }

    const started = Date.now()
    let res: RawNetResponse
    try {
      res = await invoke<RawNetResponse>('net_request', {
        req: {
          url,
          method: verb,
          headers,
          body: payload?.text,
          bodyB64: payload?.b64,
          // 文件内容必须按字节拿：文本通道在二进制上是有损的（换行、替换符、GB18030 兜底）
          wantBytes: true,
          timeout: 20_000,
        },
      })
    } catch (e) {
      note({ url, method: verb, error: String((e as Error)?.message || e).slice(0, 80), ms: Date.now() - started })
      // 让上层看到真实原因（DNS / 超时 / 证书），别伪装成通用的 Failed to fetch
      throw new TypeError(typeof e === 'string' ? e : (e as Error)?.message || '云开发请求失败')
    }

    const out = new Headers()
    for (const [k, v] of Object.entries(res.headers || {})) {
      if (DROP_RES.has(k.toLowerCase())) continue
      try { out.set(k, v) } catch { /* 非法头名直接丢，不影响 body */ }
    }

    // 204/304 规定不能有 body
    const noBody = res.status === 204 || res.status === 304 || res.status === 101
    let bytes: Uint8Array | null = null
    if (!noBody) {
      if (typeof res.bodyB64 === 'string' && res.bodyB64) bytes = bytesOfB64(res.bodyB64)
      else bytes = new TextEncoder().encode(res.body ?? '')
    }

    note({
      url, method: verb, status: res.status, ms: Date.now() - started,
      bodyKind: payload?.b64 ? 'bytes' : payload?.text ? 'text' : undefined,
      bodyLen: payload?.b64 ? Math.round((payload.b64.length * 3) / 4) : payload?.text?.length,
      head: bytes ? new TextDecoder().decode(bytes.subarray(0, 80)) : undefined,
      ct: out.get('content-type') || undefined,
    })

    // 用 Blob 包一层：TS 的 BodyInit 不认 Uint8Array 的泛型形态，Blob 两边都合法
    const bodyInit: BodyInit | null = bytes ? new Blob([bytes as unknown as BlobPart]) : null
    return new Response(bodyInit, { status: res.status, headers: out })
  }
}

/** 诊断用：这次有没有走原生代理（设置页「复制诊断信息」里带上） */
export function cloudFetchActive(): boolean {
  return installed
}
