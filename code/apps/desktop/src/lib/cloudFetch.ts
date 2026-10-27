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

interface RawNetResponse {
  status: number
  headers: Record<string, string>
  body: string
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
    let body: string | undefined
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

    if (init?.body != null) {
      body = typeof init.body === 'string' ? init.body : await new Response(init.body).text()
    } else if (raw) {
      body = await raw.clone().text()
    }
    if (body === '') body = undefined
    if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD') body = undefined

    let res: RawNetResponse
    try {
      res = await invoke<RawNetResponse>('net_request', {
        req: { url, method: method.toUpperCase(), headers, body, timeout: 20_000 },
      })
    } catch (e) {
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
    return new Response(noBody ? null : res.body ?? '', {
      status: res.status,
      headers: out,
    })
  }
}

/** 诊断用：这次有没有走原生代理（设置页「复制诊断信息」里带上） */
export function cloudFetchActive(): boolean {
  return installed
}
