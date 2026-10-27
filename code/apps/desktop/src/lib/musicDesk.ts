/**
 * 音乐桌面：「铺满屏幕的壁纸式音乐屏」。
 *
 * 它是一块**铺在主屏上的背景**（默认置底，压在所有窗口下面），不是第二个播放器：
 *   主窗口 --desk://data--> 音乐桌面窗口   曲目 / 封面 / 整份歌词 / 播放状态
 *   音乐桌面窗口 --desk://action--> 主窗口  上一首 / 播放暂停 / 下一首 / 关闭 / 回应用
 *
 * 和桌面歌词一样，它是独立 WebView，不共享 React 状态，所以整条链路都走事件。
 *
 * **播放进度不走这条通道**：窗口自己订阅 Rust 的 `player://state`（每 250ms 一次），
 * 主窗口最小化、JS 被节流时进度和歌词仍然是准的。这条设计是桌面歌词验证过的。
 */
import { bridge } from './bridge'

/** `bottom` = 当壁纸（WorkerW 嵌进桌面层，图标保留）/ `top` = 置顶（锁屏期由 Rust 用） */
export type DeskLayer = 'bottom' | 'top'

export interface DeskLine {
  /** 秒 */
  time: number
  text: string
}

export interface DeskData {
  /** 曲目标识，换歌时窗口用来丢弃上一首的歌词 */
  key: string
  title: string
  artist: string
  album: string
  /** 已经解析成能直接给 <img> 的 URL（本地封面必须过 coverUrlOf） */
  cover: string
  duration: number
  playing: boolean
  /** 整份歌词；空数组表示没有歌词，窗口退回显示歌名 */
  lines: DeskLine[]
}

export type DeskAction = 'ready' | 'playpause' | 'prev' | 'next' | 'seek' | 'close' | 'open-main'

/** 会订阅 `desk://data` 的两个窗口（彼此独立，只是共用同一份推送） */
const DESK_WINDOWS = ['musicdesk', 'musiclock'] as const

export const musicDesk = {
  async open(layer: DeskLayer = 'bottom'): Promise<void> {
    if (!bridge.isTauri) return
    await bridge.invoke('musicdesk_open', { layer })
  },
  async close(): Promise<void> {
    if (!bridge.isTauri) return
    await bridge.invoke('musicdesk_close')
  },
  async visible(): Promise<boolean> {
    if (!bridge.isTauri) return false
    try {
      return await bridge.invoke<boolean>('musicdesk_visible')
    } catch {
      return false
    }
  },
  async setLayer(layer: DeskLayer): Promise<void> {
    if (!bridge.isTauri) return
    await bridge.invoke('musicdesk_set_layer', { layer })
  },

  /**
   * 主窗口 → 音乐桌面窗口 / 音乐锁屏窗口。
   *
   * 两个是**独立窗口**（锁屏不该顺手开桌面），各自都订这条数据；哪个还没建，
   * 那一路 emitTo 会失败，单独吞掉即可，不能让它挡掉另一个。
   */
  async push(data: DeskData): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await Promise.all(DESK_WINDOWS.map(l =>
        emitTo(l, 'desk://data', data).catch(() => { /* 该窗口还没就绪 */ })))
    } catch {
      /* 事件模块不可用（浏览器预览） */
    }
  },

  onData(cb: (d: DeskData) => void): () => void {
    return subscribe('desk://data', p => {
      const v = p as DeskData
      if (v && typeof v.key === 'string') cb(v)
    })
  },

  /** 播放位置 / 是否在播（Rust 侧直接推，主窗口最小化也不断） */
  onState(cb: (s: { playing: boolean; position: number; duration: number }) => void): () => void {
    return subscribe('player://state', p =>
      cb(p as { playing: boolean; position: number; duration: number }))
  },

  /** 窗口里的按钮 → 主窗口执行 */
  async action(a: DeskAction, extra?: Record<string, unknown>): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('main', 'desk://action', { action: a, ...extra })
    } catch {
      /* 主窗口已关闭 */
    }
  },

  onAction(cb: (a: string, p: Record<string, unknown>) => void): () => void {
    return subscribe('desk://action', p => {
      const v = p as { action?: string } & Record<string, unknown>
      if (v?.action) cb(v.action, v)
    })
  },

  /**
   * 主窗口用：音乐锁屏开始/结束（Rust 的 `desk_lock_show/hide` 广播）。
   * 开始时要补推一次数据——锁屏窗口平时是藏着的，可能从没接过数据。
   */
  onAutoLock(cb: (on: boolean) => void): () => void {
    return subscribe('desk://autolock', p => cb(p === true))
  },

  /** 进入「音乐锁屏」：全屏置顶 + 时钟形态（用户主动，快捷键 / 设置页按钮） */
  async enterLock(): Promise<void> {
    if (!bridge.isTauri) return
    try { await bridge.invoke('desk_lock_enter') } catch { /* 忽略 */ }
  },

  /** 退出「音乐锁屏」：恢复壁纸层（或收起，按进来前是否开着） */
  async exitLock(): Promise<void> {
    if (!bridge.isTauri) return
    try { await bridge.invoke('desk_lock_exit') } catch { /* 忽略 */ }
  },
}

/** 订阅一个 Tauri 事件；浏览器预览下为空实现 */
function subscribe(name: string, cb: (payload: unknown) => void): () => void {
  if (!bridge.isTauri) return () => {}
  let unlisten: (() => void) | null = null
  let disposed = false
  import('@tauri-apps/api/event').then(({ listen }) => {
    if (disposed) return
    listen(name, e => cb(e.payload)).then(u => {
      if (disposed) u()
      else unlisten = u
    })
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}
