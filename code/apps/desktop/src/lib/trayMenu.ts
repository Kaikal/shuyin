/**
 * 托盘菜单：跨窗口数据通道。
 *
 * 原生 Win32 弹出菜单是系统画的，配色/圆角/间距一样都改不了，
 * 和疏音的界面放一起就是两个时代的东西。所以托盘菜单改成自绘：
 * Rust 侧建一个透明置顶小窗，右击托盘在光标处弹出，前端按主题 token 渲染。
 */
import { bridge } from './bridge'

export interface TrayState {
  playing: boolean
  position: number
  duration: number
  title: string
  artist: string
  cover: string
  /** 队列里的第几首 / 共几首（0 / 0 = 没有队列） */
  index: number
  total: number
  /** 桌面歌词是否开着 */
  lyrics: boolean
  locked: boolean
}

export const trayMenu = {
  async state(): Promise<TrayState | null> {
    if (!bridge.isTauri) return null
    try {
      return await bridge.invoke<TrayState>('tray_state')
    } catch {
      return null
    }
  },

  async action(id: string): Promise<void> {
    if (!bridge.isTauri) return
    try {
      await bridge.invoke('tray_action', { id })
    } catch {
      /* 主窗口没准备好 / 已退出 */
    }
  },

  async hide(): Promise<void> {
    if (!bridge.isTauri) return
    try {
      await bridge.invoke('tray_hide')
    } catch { /* 窗口已销毁 */ }
  },

  /** 把「内容实际尺寸 + devicePixelRatio」报给 Rust：Windows 上逻辑尺寸和 DPR 不是一回事 */
  async fit(w: number, h: number, dpr: number): Promise<void> {
    if (!bridge.isTauri) return
    try {
      await bridge.invoke('tray_fit', { w, h, dpr })
    } catch { /* 忽略 */ }
  },

  /** 每换一首 / 队列变化时上报，托盘菜单不用再自己去前端抓数据 */
  async setMeta(m: { title: string; artist: string; cover: string; index: number; total: number }): Promise<void> {
    if (!bridge.isTauri) return
    try {
      await bridge.invoke('now_meta_set', m)
    } catch { /* 忽略 */ }
  },

  /** 每次弹出都会来一发，用来刷新内容 */
  onShow(cb: () => void): () => void {
    return subscribe('tray://show', () => cb())
  },

  onPlayerState(cb: (s: { playing: boolean; position: number; duration: number }) => void): () => void {
    return subscribe('player://state', p => cb(p as { playing: boolean; position: number; duration: number }))
  },
}

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
