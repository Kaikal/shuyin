/**
 * 安卓原生适配层。
 *
 * 桌面端所有能力都收在 `bridge.invoke(cmd, args)` 这一个口子上，
 * 安卓这边只要提供同名命令、同形状返回，上层（曲库、取链、下载、歌词……）
 * 就完全不需要知道自己跑在哪个平台上。
 *
 * 原生侧实现见 `apps/android/.../Bridge.kt`，命令清单与 `src-tauri/src/lib.rs` 对齐。
 */

interface NativeHost {
  call(id: string, cmd: string, args: string): void
  appInfo(): string
}

const nativeHost: NativeHost | undefined = typeof window !== 'undefined'
  ? (window as unknown as { ShuyinNative?: NativeHost }).ShuyinNative
  : undefined

export const isAndroid = !!nativeHost

export interface AndroidAppInfo {
  platform: string
  /** 车机版打包（applicationId 不同，界面按横屏大屏排） */
  car: boolean
  sdk: number
  device: string
  downloads: string
}

let infoCache: AndroidAppInfo | null = null
export function androidAppInfo(): AndroidAppInfo {
  if (!infoCache) {
    try {
      infoCache = JSON.parse(nativeHost?.appInfo() ?? '{}') as AndroidAppInfo
    } catch {
      infoCache = { platform: 'android', car: false, sdk: 0, device: '', downloads: '' }
    }
  }
  return infoCache
}

/* ------------------------------------------------------------------ */
/* 事件总线                                                            */
/* ------------------------------------------------------------------ */

const subs = new Map<string, Set<(payload: unknown) => void>>()

/** 订阅原生事件，返回取消函数 */
export function onNative(name: string, cb: (payload: unknown) => void): () => void {
  let set = subs.get(name)
  if (!set) { set = new Set(); subs.set(name, set) }
  set.add(cb)
  return () => { set!.delete(cb) }
}

/** 最近一帧播放状态：界面首帧就能拿到真实状态，不用等第一次推送 */
let lastPlayerState: unknown = null
export function lastKnownPlayerState(): unknown { return lastPlayerState }

let backHandler: (() => boolean) | null = null
/** 注册安卓返回键处理（返回 true 表示「这一下我吃掉了」） */
export function setBackHandler(fn: (() => boolean) | null): void { backHandler = fn }

/* ------------------------------------------------------------------ */
/* 原生 → JS 的入口（由原生 evaluateJavascript 调用）                    */
/* ------------------------------------------------------------------ */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
const pending = new Map<string, Pending>()
let seq = 0

function decodePayload(b64: string): unknown {
  if (!b64) return null
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const text = new TextDecoder('utf-8').decode(bytes)
    return text === 'null' ? null : JSON.parse(text)
  } catch {
    return null
  }
}

if (isAndroid) {
  const w = window as unknown as Record<string, unknown>

  // 命令结果
  w.__syNative = (id: string, ok: boolean, b64: string) => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (ok) p.resolve(decodePayload(b64))
    else p.reject(new Error(String(decodePayload(b64) ?? '原生调用失败')))
  }

  // 主动事件：播放状态 / 媒体键
  w.__syNativeEvent = (name: string, b64: string) => {
    const payload = decodePayload(b64)
    for (const cb of subs.get(name) ?? []) {
      try { cb(payload) } catch (e) { console.warn('[疏音] 事件处理异常', name, e) }
    }
    if (name === 'player://state') lastPlayerState = payload
    if (name === 'hotkey://action') {
      // 转成 DOM 事件：hotkeys.ts 里那条 switch 桌面/安卓共用，不必再写一份
      window.dispatchEvent(new CustomEvent('sy:hotkey', { detail: payload }))
    }
  }

  // 安卓返回键：前端先决定这一下该关哪一层
  w.__syBack = () => (backHandler ? backHandler() : false)
  // 转屏 / 权限变化
  w.__syOnResize = () => window.dispatchEvent(new Event('resize'))
  w.__syOnPermission = () => window.dispatchEvent(new CustomEvent('sy:permission'))
}

/* ------------------------------------------------------------------ */
/* 调用通道                                                            */
/* ------------------------------------------------------------------ */

/**
 * 发一条命令。
 *
 * 超时兜底 120s：原生侧若因权限/文件锁卡住没回调，这里不能永远挂着——
 * 挂住就是「点了没反应」且无从恢复（桌面上 pending 死锁那个坑的翻版）。
 */
export function androidInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!nativeHost) return Promise.reject(new Error('不在安卓环境'))
  const id = String(++seq)
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (!pending.delete(id)) return
      reject(new Error(`原生调用超时：${cmd}`))
    }, 120_000)
    pending.set(id, {
      resolve: (v: unknown) => { window.clearTimeout(timer); resolve(v as T) },
      reject: (e: Error) => { window.clearTimeout(timer); reject(e) },
    })
    try {
      nativeHost.call(id, cmd, JSON.stringify(args ?? {}))
    } catch (e) {
      pending.delete(id)
      window.clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}
