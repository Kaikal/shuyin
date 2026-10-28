/**
 * 形态检测：桌面 / 平板 / 手机 / 车机。
 *
 * 为什么不只用 CSS 媒体查询：车机是「1280×720 横屏大屏」，宽度和笔记本一样，
 * 但它的触摸目标、字号、可点区域完全是另一套要求；而手机横过来是 780×360，
 * 宽度又落进了「平板」区间。只看宽度必然判错，所以这里按**短边**判手机，
 * 车机则来自原生打包标识（BuildConfig.CAR → appInfo().car）。
 *
 * 结果写到 <html data-shell="…">，所有布局差异都在 mobile.css 里按它分流，
 * 组件本身不需要到处写 if。
 */
import { useEffect, useState } from 'react'
import { androidAppInfo, isAndroid } from './native/android'

export type ShellMode = 'desk' | 'tablet' | 'phone' | 'car'

/** 预览用：`?shell=phone` 可以在浏览器里按手机布局看效果（不影响真实判定） */
function override(): ShellMode | null {
  try {
    const v = new URLSearchParams(window.location.search).get('shell')
    if (v === 'phone' || v === 'tablet' || v === 'car' || v === 'desk') return v
  } catch { /* ignore */ }
  return null
}

export function detectShell(): ShellMode {
  const forced = override()
  if (forced) return forced

  if (isAndroid && androidAppInfo().car) return 'car'

  const w = window.innerWidth
  const h = window.innerHeight
  const short = Math.min(w, h)

  if (isAndroid) {
    // 安卓上不存在「桌面形态」：再宽的平板也走平板布局（没有窗口标题栏可点）
    return short < 560 ? 'phone' : 'tablet'
  }
  // 桌面端只做「窄窗」降级，不切到手机布局
  return w < 900 ? 'tablet' : 'desk'
}

function apply(mode: ShellMode): void {
  const el = document.documentElement
  if (el.dataset.shell !== mode) el.dataset.shell = mode
  // 车机单独打标：有些样式（大字号、去 hover 动效）只对车机生效
  el.dataset.car = mode === 'car' ? '1' : '0'
}

/** 当前形态（随窗口变化重算） */
export function useShell(): ShellMode {
  const [mode, setMode] = useState<ShellMode>(() => {
    const m = detectShell()
    apply(m)
    return m
  })

  useEffect(() => {
    const update = () => {
      const m = detectShell()
      apply(m)
      setMode(m)
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  return mode
}

/** 触摸设备（安卓 / 触屏），用来关掉「悬停才出现」这类交互 */
export const isTouch = isAndroid || (typeof window !== 'undefined' && 'ontouchstart' in window)

/**
 * 主输入设备是手指吗？
 *
 * 比 `isTouch` 更准：触屏笔记本外接了鼠标时 `(pointer: coarse)` 是 false，
 * 而 `ontouchstart` 依然在 window 上——那种机器上双击、右键都该保留。
 * 安卓壳里恒为 true。用它决定「双击进详情」这类桌面习惯要不要绑。
 */
export const isCoarsePointer = isAndroid || (
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(pointer: coarse)').matches
)
