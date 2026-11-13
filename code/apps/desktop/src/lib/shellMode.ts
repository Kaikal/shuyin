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
    /*
     * 安卓一律走手机那套。
     *
     * 原来按短边分：< 560 手机、其余平板——平板吃到的是「左侧 232 导航 + 右侧 340
     * 正在播放栏」的桌面结构，可那套交互是按鼠标写的（悬停才现的按钮、右键菜单、
     * 拖拽排序），手指在平板上根本用不了，等于把桌面功能原样搬过去却点不动。
     * 功能集要和手机一致，结构就不能分叉；大屏只做尺寸放大（见 mobile.css 里
     * `html[data-wide='1']` 那一段），不另起一套布局。
     */
    return 'phone'
  }
  // 桌面端只做「窄窗」降级，不切到手机布局
  return w < 900 ? 'tablet' : 'desk'
}

function apply(mode: ShellMode): void {
  const el = document.documentElement
  if (el.dataset.shell !== mode) el.dataset.shell = mode
  /*
   * 车机标记也要判一下再写。
   *
   * `<html>` 上任何属性/样式变化都会让**整棵文档**的样式失效——真机实测一次
   * recalc 扫 1217 个元素要 26~34ms。这里以前无条件赋值，`apply()` 又是
   * resize / 首次挂载都会走的，等于每次窗口变化都白送一次全文档重算。
   */
  const car = mode === 'car' ? '1' : '0'
  if (el.dataset.car !== car) el.dataset.car = car
  /*
   * 大屏手机形态（平板）：结构完全同手机，只把字号 / 间距 / 列数放大。
   * 用短边判，横竖屏都稳定——用宽度的话平板横过来会突然变成「超宽」。
   */
  const wide = Math.min(window.innerWidth, window.innerHeight) >= 560 ? '1' : '0'
  if (el.dataset.wide !== wide) el.dataset.wide = wide
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
