/**
 * 长按手势（触摸屏专用）。
 *
 * 安卓上没有右键，也没有 Ctrl 多选。酷狗 / QQ 音乐那一套是：
 * **长按一行 → 进入多选**，之后再点就是勾选 / 取消。这里把这件事抽成一个
 * 可以展开到任意行上的属性包，省得每个列表各写一遍定时器。
 *
 * 三个细节，少一个手感就崩：
 *   · **只认 touch**：鼠标按住 460ms 不该触发多选（桌面有右键和 Ctrl）；
 *   · **pointermove 就取消**：手指一滑是在滚列表，不能把经过的那行选上；
 *   · **长按后的 click 要吞掉**：手指抬起浏览器还会补一个 click，
 *     不吞的话「长按进入多选」会紧接着把这首播了。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

/** 触发时长。480ms 是移动端菜单的常用值：比系统长按（500ms）略早，手指感觉刚好 */
const HOLD_MS = 480

let timer = 0
let firedAt = 0

/** 长按落点。菜单要贴着手指弹，不能弹到屏幕另一头去 */
export type HoldPoint = { x: number; y: number }

export function longPressProps(fire: (at: HoldPoint) => void) {
  const stop = () => window.clearTimeout(timer)
  let at: HoldPoint = { x: 0, y: 0 }
  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.pointerType !== 'touch') return
      firedAt = 0
      stop()
      at = { x: e.clientX, y: e.clientY }
      timer = window.setTimeout(() => {
        firedAt = Date.now()
        fire(at)
      }, HOLD_MS)
    },
    onPointerUp: stop,
    onPointerMove: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
  }
}

/**
 * 刚刚长按触发过吗？是的话这一次 click 要丢掉。
 * 1.2 秒后自动失效——手指长按完滑走（没产生 click）时不会把下一次点击也吞了。
 */
export function consumeLongPress(): boolean {
  if (!firedAt) return false
  const hit = Date.now() - firedAt < 1200
  firedAt = 0
  return hit
}
