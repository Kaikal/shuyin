/**
 * 自绘窗口标题栏。
 *
 * 主窗口是「无系统边框」的：Windows 原生的最小化/最大化/关闭是系统画的一小块灰，
 * 跟应用内的圆角按钮完全两个世界。这里自己画一栏，配色跟着主题 token 走。
 *
 * 四件事都在前端做（Tauri 的 window API）：
 *   · 拖动      —— pointerdown 记起点，位移超 4px 才交给 startDragging，
 *                 所以「点一下标题栏」不会误触拖动
 *   · 双击      —— 两次 pointerup 间隔 < 320ms 且没拖动过 → 切换最大化。
 *                 不能靠 dblclick：startDragging 会进系统拖动循环，dblclick 不一定派得回来
 *   · 最大化    —— 走系统 zoom。无边框窗口的 zoom 尺寸由 Rust 侧的 WM_GETMINMAXINFO
 *                 子类化修正到显示器工作区（install_max_fix），所以不会盖任务栏，
 *                 双击标题栏 / Win+↑ / Aero Snap 也能全部沿用系统行为。
 *   · 边缘缩放  —— 无边框窗口默认拖不了边，四周铺 5~12px 的透明热区，
 *                 按下即 startResizeDragging；最大化时自动隐藏
 *
 * 窗口**可以**自由改大小，但有下限：1120×680（CSS px）。比这更小，
 * 播放页的两列（封面 + 歌词）和播放条就会被挤乱。下限由 Rust 侧
 * `apply_min_size` 按 devicePixelRatio 设成物理像素（Tauri 的 min_inner_size
 * 吃的是系统逻辑缩放，跟 webview 的 dpr 不是一回事，直接用逻辑值算出来的偏小）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge } from '../lib/bridge'

async function win() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/** JS 侧 currentMonitor 是独立函数，不是 Window 的方法 */
async function currentMonitor() {
  const { currentMonitor } = await import('@tauri-apps/api/window')
  return currentMonitor()
}

/** setSize / setPosition 要的是 DPI 类实例（传 {width,height} 会被当成物理像素） */
async function dpiClasses() {
  return import('@tauri-apps/api/dpi')
}

/** Tauri 的 ResizeDirection（动态 import 拿不到类型，本地抄一份字面量联合） */
type ResizeDir = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest'

/** 页面名 → 标题栏左侧文案 */
const PAGE_LABEL: Record<string, string> = {
  home: '我的',
  search: '在线搜索',
  playlist: '歌单广场',
  downloads: '下载',
  settings: '设置',
}

/**
 * 「现在是不是最大化态」。
 * isMaximized 覆盖按钮和 Win+↑；尺寸判断兜住 Aero Snap（贴到半屏时 zoom 标记为 false，
 * 但窗口已铺满，此时不该再显示「最大化」图标）。
 */
function useWindowMax() {
  const [max, setMax] = useState(false)

  const read = useCallback(async () => {
    if (!bridge.isTauri) return false
    try {
      const w = await win()
      if (await w.isMaximized()) return true
      // innerSize 与 workArea 都是物理像素，直接比
      const [size, mon] = await Promise.all([w.innerSize(), currentMonitor()])
      const wa = mon?.workArea
      if (!wa) return false
      return Math.abs(size.width - wa.size.width) < 3 && Math.abs(size.height - wa.size.height) < 3
    } catch {
      return false
    }
  }, [])

  const sync = useCallback(() => { void read().then(setMax) }, [read])

  useEffect(() => {
    if (!bridge.isTauri) return
    let alive = true
    let off: (() => void) | null = null
    void read().then(v => { if (alive) setMax(v) })
    void import('@tauri-apps/api/event').then(({ listen }) => {
      // resize 覆盖 最大化/还原/snap/多显示器拖动 四种来源
      listen('tauri://resize', () => { if (alive) sync() }).then(u => { if (alive) off = u; else u() })
    })
    return () => { alive = false; off?.() }
  }, [read, sync])

  return [max, setMax, read] as const
}

/**
 * 还原时回到这个尺寸（和 Rust 侧建窗口的 `inner_size` 一致）。
 *
 * 为什么不能只 `unmaximize()`：系统的「还原」是回到**最大化之前那一帧**的尺寸。
 * 于是「先把窗口拉得跟屏幕差不多大，再点最大化、再点还原」会得到「还原了但还是满屏」，
 * 用户看到的就是「点了没反应」——他被还原到了自己刚拉大的尺寸，这是系统行为，不是 bug。
 * 所以还原这一步统一落回预设尺寸：尺寸可预期，重复点也不会漂。
 */
const RESTORE_W = 1180
const RESTORE_H = 760

export function TitleBar({ page }: { page: string }) {
  const [max] = useWindowMax()
  const label = PAGE_LABEL[page] ?? ''

  /**
   * 最大化 / 还原。
   *
   * 判断只认 `isMaximized()`（不能用图标那套「尺寸接近工作区就算最大化」的兜底，
   * 那个兜底是为了 Aero Snap 的图标显示，拿来做动作判断会导致「判断说已最大化、
   * 实际是普通态」→ unmaximize 空操作）。
   *
   * 还原时**主动设回预设尺寸**：系统还原只会回到最大化之前的尺寸，
   * 而用户往往就是「先拉到快满屏、再点最大化」，于是还原后还是满屏。
   *
   * 两个必须等的地方（实测踩过）：
   *   · `unmaximize()` 只把 SC_RESTORE 投进消息队列就返回，zoom 标记还没落下来。
   *     这时立刻 setSize，尺寸会被随后的 un-zoom 覆盖掉 → 表现为「点还原没反应」。
   *     所以先等 `isMaximized()` 真的变 false 再改尺寸。
   *   · 尺寸换算用 `window.scaleFactor()`（本机 1.5），不是 `devicePixelRatio`（1.71）。
   *     两个数不是一回事，混用会让「工作区 - 24」算错。
   */
  const toggleMax = useCallback(async () => {
    if (!bridge.isTauri) return
    try {
      const w = await win()
      if (await w.isMaximized()) {
        await w.unmaximize()
        // 等系统把 zoom 状态收回去（最多 400ms），否则这次 setSize 会被 zoom 覆盖
        for (let i = 0; i < 20; i++) {
          if (!(await w.isMaximized())) break
          await new Promise(r => window.setTimeout(r, 20))
        }
        const [mon, scale] = await Promise.all([currentMonitor(), w.scaleFactor()])
        const { LogicalSize, PhysicalPosition } = await dpiClasses()
        // 预设尺寸不能大过工作区（小屏幕上 1180×760 会顶出屏幕）
        const wa = mon?.workArea
        const maxW = wa ? wa.size.width / scale - 24 : RESTORE_W
        const maxH = wa ? wa.size.height / scale - 24 : RESTORE_H
        const width = Math.round(Math.min(RESTORE_W, maxW))
        const height = Math.round(Math.min(RESTORE_H, maxH))
        await w.setSize(new LogicalSize(width, height))
        /* 居中自己算，不调 center()：那条命令在 ACL 里是单独一项，
           漏了就整条链断在最后一步（前面尺寸已经改好了，看起来像「居中失效」）。
           setSize 是异步落地的，读 outerSize 前给一帧时间。 */
        if (wa) {
          await new Promise(r => window.setTimeout(r, 60))
          const out = await w.outerSize()
          const x = Math.round(wa.position.x + (wa.size.width - out.width) / 2)
          const y = Math.round(wa.position.y + (wa.size.height - out.height) / 2)
          await w.setPosition(new PhysicalPosition(x, y))
        }
      } else {
        await w.maximize()
      }
    } catch { /* 忽略：预览环境 / 窗口已销毁 */ }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    // 按钮/输入不进入拖动判定，否则点窗口按钮会顺带拖动窗口
    if (el.closest('button, input, a, select, textarea, [role="button"]')) return
    const x0 = e.clientX
    const y0 = e.clientY
    let dragged = false
    let lastUp = 0

    const move = (ev: PointerEvent) => {
      if (dragged) return
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) <= 4) return
      dragged = true
      if (bridge.isTauri) void win().then(w => w.startDragging().catch(() => {}))
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', finish)
    }
    const up = () => {
      if (dragged) { finish(); return }
      const now = performance.now()
      if (lastUp && now - lastUp < 320) { lastUp = 0; void toggleMax() }
      else lastUp = now
      finish()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', finish)
  }, [toggleMax])

  const minimize = useCallback(() => {
    if (!bridge.isTauri) return
    void win().then(w => w.minimize().catch(() => {}))
  }, [])

  const close = useCallback(() => {
    if (!bridge.isTauri) return
    void win().then(w => w.close().catch(() => {}))
  }, [])

  return (
    <>
      <header className="titlebar" onPointerDown={onPointerDown}>
        <div className="tb-drag">
          <span className="tb-app">疏音</span>
          {label && (
            <>
              <span className="tb-sep" aria-hidden="true">·</span>
              <span className="tb-page">{label}</span>
            </>
          )}
        </div>
        <div className="tb-win">
          <button className="tb-btn" aria-label="最小化" title="最小化" onClick={minimize}>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1.5 6.5h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
            </svg>
          </button>
          <button
            className="tb-btn"
            aria-label={max ? '还原' : '最大化'}
            title={max ? '还原' : '最大化'}
            onClick={toggleMax}
          >
            {max ? (
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.6" y="3.4" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
                <path d="M4.2 3.4V2.2h6.2v6.2H9.2" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.8" y="1.8" width="8.4" height="8.4" rx="1.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </svg>
            )}
          </button>
          <button className="tb-btn tb-close" aria-label="关闭" title="关闭（收进托盘，音乐继续播放）" onClick={close}>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.2 2.2l7.6 7.6M9.8 2.2l-7.6 7.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        </div>
      </header>
      <ResizeZones max={max} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 边缘缩放热区                                                         */
/* ------------------------------------------------------------------ */

const ZONES: Array<{ dir: string; cls: string }> = [
  { dir: 'North', cls: 'rz rz-n' },
  { dir: 'South', cls: 'rz rz-s' },
  { dir: 'West', cls: 'rz rz-w' },
  { dir: 'East', cls: 'rz rz-e' },
  { dir: 'NorthWest', cls: 'rz rz-nw' },
  { dir: 'NorthEast', cls: 'rz rz-ne' },
  { dir: 'SouthWest', cls: 'rz rz-sw' },
  { dir: 'SouthEast', cls: 'rz rz-se' },
]

function ResizeZones({ max }: { max: boolean }) {
  const onDown = useCallback((dir: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !bridge.isTauri) return
    void win().then(w => w.startResizeDragging(dir as ResizeDir).catch(() => {}))
  }, [])

  return (
    <div className="rz-host" data-hidden={max ? 'true' : 'false'} aria-hidden="true">
      {ZONES.map(z => (
        <div
          key={z.dir}
          className={z.cls}
          onPointerDown={onDown(z.dir)}
        />
      ))}
    </div>
  )
}
