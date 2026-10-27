/**
 * 音源脚本宿主（桌面端 = Web Worker）。
 *
 * 洛雪的音源脚本是「裸 JS」：解构 `globalThis.lx` 拿宿主 API，跑完调
 * `send(EVENT_NAMES.inited, ...)` 声明能力，之后靠 `on(EVENT_NAMES.request, ...)`
 * 接收取链请求、**以返回值/Promise 的形式**把 URL 交回去（不是 send 回去）。
 *
 * 用 Worker 而不是主线程 eval 的理由：
 *   1. 脚本里全是同步拼接 + 正则，放主线程会掉帧（尤其搜索列表滚动时）
 *   2. 单个脚本可能陷入死循环，Worker 可以直接 terminate
 *   3. CSP 是 null，Blob Worker 可用
 *
 * 脚本要出网时调 `lx.request` —— 那不是 fetch，是发消息回主线程、再由主线程
 * 走 Rust `net_request`。所以脚本拿到的永远是**原始字符串 body**。
 */
import type {
  HttpClient, LxHostAdapter, LxInitPayload, LxLoadedScript, PlatformSource,
} from '@shuyin/lx-provider'
import { invoke, isNative } from './bridge'
import { buildWorkerSource } from './lxWorkerBoot'

/* ------------------------------------------------------------------ */
/* 宿主实现                                                             */
/* ------------------------------------------------------------------ */

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Entry {
  worker: Worker
  blobUrl: string
  inited: LxInitPayload
  logs: string[]
  pending: Map<number, Pending>
  seq: number
  loaded: LxLoadedScript
}

export interface LxWorkerHostOptions {
  /** 平台 API 的 HttpClient，脚本外联也用它（都是走 Rust 代理） */
  client: HttpClient
  /** 最多保留多少条脚本日志 */
  maxLogs?: number
}

export function createLxWorkerHost(opts: LxWorkerHostOptions): LxHostAdapter {
  const entries = new Map<string, Entry>()
  const maxLogs = opts.maxLogs ?? 200

  async function runHttp(url: string, o: any) {
    const res = await opts.client.request({
      url,
      method: (o?.method ?? 'GET') as 'GET' | 'POST',
      headers: o?.headers ?? {},
      body: o?.body,
      timeout: o?.timeout ?? 12_000,
    })
    // 脚本要的是 body 字符串（长青直接 JSON.parse），别在这里解析
    return {
      statusCode: res.status,
      headers: res.headers ?? {},
      body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body),
    }
  }

  function spawn(id: string, code: string): Promise<Entry> {
    const blobUrl = URL.createObjectURL(new Blob([buildWorkerSource(code)], { type: 'text/javascript' }))
    const worker = new Worker(blobUrl)

    const entry: Entry = {
      worker,
      blobUrl,
      inited: { sources: {} },
      logs: [],
      pending: new Map(),
      seq: 0,
      loaded: undefined as unknown as LxLoadedScript,
    }

    const ready = new Promise<Entry>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('音源脚本 15s 内没有完成初始化'))
      }, 15_000)

      worker.onerror = (ev) => {
        clearTimeout(timer)
        reject(new Error(ev.message || '音源脚本执行出错'))
      }

      worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data || {}
        switch (m.type) {
          case 'inited': {
            clearTimeout(timer)
            entry.inited = (m.payload ?? { sources: {} }) as LxInitPayload
            resolve(entry)
            break
          }
          case 'error': {
            clearTimeout(timer)
            reject(new Error(String(m.message ?? '音源脚本执行出错').slice(0, 300)))
            break
          }
          case 'log': {
            const line = String(m.text ?? '')
            entry.logs.push(line)
            if (entry.logs.length > maxLogs) entry.logs.splice(0, entry.logs.length - maxLogs)
            break
          }
          case 'http': {
            runHttp(String(m.url), m.options)
              .then(response => worker.postMessage({ type: 'http-res', id: m.id, response }))
              .catch(e => worker.postMessage({
                type: 'http-res',
                id: m.id,
                error: e instanceof Error ? e.message : String(e),
              }))
            break
          }
          case 'call-res': {
            const p = entry.pending.get(m.id)
            if (!p) break
            entry.pending.delete(m.id)
            clearTimeout(p.timer)
            if (m.ok) p.resolve(String(m.value ?? ''))
            else p.reject(new Error(String(m.error ?? '音源取链失败')))
            break
          }
          default:
            break
        }
      }
    })

    entry.loaded = {
      get inited() {
        return entry.inited
      },
      logs: entry.logs,
      requestMusicUrl(
        source: PlatformSource,
        musicInfo: unknown,
        quality: string,
        timeoutMs = 8_000,
      ): Promise<string> {
        const id = ++entry.seq
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            entry.pending.delete(id)
            reject(new Error(`音源 ${Math.round(timeoutMs / 1000)}s 内没有返回播放地址`))
          }, timeoutMs)
          entry.pending.set(id, { resolve, reject, timer })
          try {
            worker.postMessage({
              type: 'call',
              id,
              payload: { source, action: 'musicUrl', info: { type: quality, musicInfo } },
            })
          } catch (e) {
            // musicInfo 里有不可克隆的东西（函数等）才会走到这里
            clearTimeout(timer)
            entry.pending.delete(id)
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      },
    }

    entries.set(id, entry)
    return ready
  }

  return {
    async listScripts(dir: string) {
      if (!isNative) return []
      const files = await invoke<Array<{ path: string; name: string; code: string }>>(
        'list_source_scripts',
        { dir },
      )
      return files
    },

    async load(script) {
      const existing = entries.get(script.id)
      // 幂等：SourceManager 每次取链都会 load 一次，重复 exec 脚本会重复注册处理器
      if (existing) return existing.loaded
      const entry = await spawn(script.id, script.code)
      return entry.loaded
    },

    async dispose(id: string) {
      const entry = entries.get(id)
      if (!entry) return
      entries.delete(id)
      for (const p of entry.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('音源已卸载'))
      }
      entry.pending.clear()
      entry.worker.terminate()
      URL.revokeObjectURL(entry.blobUrl)
    },
  }
}
