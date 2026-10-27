/**
 * 平台 API 层的 `HttpClient` 实现（桌面 Tauri / 安卓壳共用）。
 *
 * 为什么不能在渲染进程里直接用 fetch：
 * 音乐平台接口一律不回 `Access-Control-Allow-Origin`，`no-cors` 只能拿到 opaque
 * 响应（拿不到 body），所以只能走原生的 `net_request` 代理
 * （桌面是 Rust，安卓是 Kotlin，命令名与返回形状完全一致）。
 *
 * 返回的 `body` **一律是原始字符串**：解析在下游 `http.ts` 里做，
 * 这样宿主换成任何实现（RN fetch / 测试桩）行为都一致。
 */
import type { HttpClient, HttpRequestOptions, HttpResponse } from '@shuyin/lx-provider'
import { invoke, isNative } from './bridge'

interface RawNetResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export function createTauriHttpClient(): HttpClient {
  return {
    async request(opts: HttpRequestOptions): Promise<HttpResponse> {
      if (!isNative) {
        // 浏览器预览：没有原生代理，大多数平台会被 CORS 挡。留着是为了 dev 时不至于白屏崩
        const res = await fetch(opts.url, {
          method: opts.method ?? 'GET',
          headers: opts.headers,
          body: opts.body,
        })
        return { status: res.status, headers: {}, body: await res.text() }
      }
      const res = await invoke<RawNetResponse>('net_request', {
        req: {
          url: opts.url,
          method: opts.method ?? 'GET',
          headers: opts.headers ?? {},
          body: opts.body,
          timeout: opts.timeout ?? 10_000,
        },
      })
      return { status: res.status, headers: res.headers ?? {}, body: res.body }
    },
  }
}
