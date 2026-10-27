/**
 * 桌面歌词：独立透明窗口 + 跨窗口事件通道。
 *
 * 数据方向：
 *   主窗口（歌词/播放状态） --lyrics://data--> 歌词窗口
 *   歌词窗口（上一首/播放/下一首/关闭） --lyrics://action--> 主窗口
 *
 * 歌词窗口是独立 WebView，不共享 React 状态，所以整条链路都走事件。
 */
import { bridge } from './bridge'

export interface LyricWindowData {
  title: string
  artist: string
  playing: boolean
  /** 当前行 */
  line: string
  /** 下一行（作视觉对照） */
  next: string
  /** 当前行起始秒（逐字高亮按它算进度） */
  lineStart: number
  /** 当前行「应该唱完」的时刻：下一行起点或按字数估的时长 */
  lineEnd: number
  /** 0~1 播放进度，用于底部细线 */
  progress: number
  /** 是否真的取到了歌词（null 时显示歌名） */
  hasLyrics: boolean
  /** 已唱歌词的颜色（随设置变化） */
  hl: string
  accent: string
  text: string
}

export type LyricsWindowAction = 'playpause' | 'prev' | 'next' | 'close' | 'sync' | 'color' | 'layout'

/**
 * 整份歌词（只在换歌 / 歌词加载完时推一次）。
 *
 * 为什么要推整份而不是每 400ms 推「当前是哪一句」：
 * 400ms 一推意味着换句最多晚 0.4 秒，染色起点也跟着晚——
 * 用户感知就是「桌面歌词总比声音慢半拍」。
 * 歌词窗口自己按插值后的位置查行，换句是准点的。
 */
export interface LyricDocData {
  /** 曲目标识，换歌时用于丢弃旧歌词 */
  key: string
  lines: { time: number; text: string }[]
}

export const desktopLyrics = {
  async open(): Promise<void> {
    if (!bridge.isTauri) return
    await bridge.invoke('lyrics_open')
  },
  async hide(): Promise<void> {
    if (!bridge.isTauri) return
    await bridge.invoke('lyrics_hide')
  },
  async close(): Promise<void> {
    if (!bridge.isTauri) return
    await bridge.invoke('lyrics_close')
  },
  async isVisible(): Promise<boolean> {
    if (!bridge.isTauri) return false
    return bridge.invoke<boolean>('lyrics_visible')
  },
  /** 锁定后鼠标穿透，不挡桌面操作 */
  async setLocked(locked: boolean): Promise<void> {
    if (!bridge.isTauri) return
    await bridge.invoke('lyrics_set_locked', { locked })
  },
  /** 当前是否锁定（窗口重开时恢复按钮态用） */
  async isLocked(): Promise<boolean> {
    if (!bridge.isTauri) return false
    try {
      return await bridge.invoke<boolean>('lyrics_is_locked')
    } catch {
      return false
    }
  },
  async showMain(): Promise<void> {
    if (!bridge.isTauri) return
    await bridge.invoke('show_main')
  },

  /** 歌词窗口直接订阅 Rust 侧的播放快照（主窗口最小化时也不会断） */
  onPlayerState(cb: (s: { playing: boolean; position: number; duration: number }) => void): () => void {
    return subscribe('player://state', p => cb(p as { playing: boolean; position: number; duration: number }))
  },

  /** 托盘「锁定/解锁桌面歌词」 */
  onLock(cb: (locked: boolean) => void): () => void {
    return subscribe('lyrics://action', p => {
      const v = p as { action?: string; locked?: boolean }
      if (v.action === 'lock') cb(Boolean(v.locked))
    })
  },

  /** 主窗口 → 歌词窗口 */
  async push(data: LyricWindowData): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('lyrics', 'lyrics://data', data)
    } catch {
      /* 歌词窗口尚未就绪 */
    }
  },

  /** 主窗口 → 歌词窗口：整份歌词（换歌 / 歌词变化时才发） */
  async pushDoc(doc: LyricDocData): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('lyrics', 'lyrics://doc', doc)
    } catch {
      /* 歌词窗口尚未就绪 */
    }
  },

  onDoc(cb: (d: LyricDocData) => void): () => void {
    return subscribe('lyrics://doc', p => {
      const v = p as LyricDocData
      if (v && Array.isArray(v.lines)) cb(v)
    })
  },

  /** 拖动窗口：交给系统接管（比 data-tauri-drag-region 可靠，且能自己决定「点击 vs 拖动」） */
  async startDrag(): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().startDragging()
    } catch (e) {
      console.warn('[疏音] 拖动桌面歌词失败', e)
    }
  },

  /**
   * 套用「宽 × 高」。
   * 高度跟着字号变，所以底边保持不动、只往上长——桌面歌词常年蹲在屏幕下方，
   * 让左上角固定会让它在改字号时整块往上跳。
   * 右沿越界时整体左移回来，别把歌词挤到屏幕外。
   */
  async applyWindowSize(width: number, height: number, clampToScreen = true): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { getCurrentWindow, currentMonitor, PhysicalSize, PhysicalPosition } =
        await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      const mon = await currentMonitor()
      const before = await win.innerSize()
      /*
       * 必须按 devicePixelRatio 换物理像素，不能用 LogicalSize：
       * 这两台机器上 WebView2 的 dpr（1.71）和显示器 scaleFactor（1.5）不一致，
       * 走 LogicalSize 会让「900 宽的窗口」实际只有 790 CSS 像素，
       * 于是按宽度算出来的字数偏多，长句就被裁掉了。
       */
      const dpr = window.devicePixelRatio || 1
      const pxW = Math.round(width * dpr)
      const pxH = Math.round(height * dpr)
      await win.setSize(new PhysicalSize(pxW, pxH))
      if (!mon) return

      const pos = await win.outerPosition()
      let x = pos.x
      // 高度变了：把窗口往上顶回「底边不动」
      let y = pos.y + (before.height - pxH)
      if (clampToScreen) {
        const left = mon.position.x
        const top = mon.position.y
        x = Math.max(left, Math.min(x, left + mon.size.width - pxW))
        y = Math.max(top, Math.min(y, top + mon.size.height - pxH))
      }
      if (x !== pos.x || y !== pos.y) await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
    } catch (e) {
      console.warn('[疏音] 调整桌面歌词窗口尺寸失败', e)
    }
  },

  /** 歌词窗口改完布局 → 通知主窗口（设置页要跟着变） */
  async pushLayout(l: { width: number; fontSize: number; bg?: number }): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('main', 'lyrics://action', { action: 'layout', ...l })
    } catch {
      /* 主窗口已关闭 */
    }
  },

  /** 设置页改布局 → 推给歌词窗口 */
  async applyLayoutToWindow(l: { width: number; fontSize: number; bg?: number }): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('lyrics', 'lyrics://action', { action: 'layout', ...l })
    } catch {
      /* 歌词窗口没开 */
    }
  },

  /** 主窗口推来的布局（设置页滑块） */
  onLayout(cb: (l: { width: number; fontSize: number; bg?: number }) => void): () => void {
    return subscribe('lyrics://action', p => {
      const v = p as { action?: string; width?: number; fontSize?: number; bg?: number }
      if (v.action === 'layout' && typeof v.width === 'number' && typeof v.fontSize === 'number') {
        cb({ width: v.width, fontSize: v.fontSize, bg: typeof v.bg === 'number' ? v.bg : undefined })
      }
    })
  },

  /** 歌词窗口 → 主窗口 */
  async sendAction(action: LyricsWindowAction, extra?: Record<string, unknown>): Promise<void> {
    if (!bridge.isTauri) return
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('main', 'lyrics://action', { ...extra, action })
    } catch {
      /* 主窗口已关闭 */
    }
  },

  onData(cb: (d: LyricWindowData) => void): () => void {
    return subscribe('lyrics://data', p => cb(p as LyricWindowData))
  },

  onAction(cb: (a: LyricsWindowAction, payload: { action?: string; [k: string]: unknown }) => void): () => void {
    return subscribe('lyrics://action', p => {
      const v = p as { action?: string; [k: string]: unknown }
      cb(v.action as LyricsWindowAction, v)
    })
  },

  /** 托盘菜单动作 */
  onTrayAction(cb: (a: string) => void): () => void {
    return subscribe('tray://action', p => cb((p as { action: string }).action))
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
