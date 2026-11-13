/**
 * 长按手势（触摸屏专用）。
 *
 * 安卓上没有右键，也没有 Ctrl 多选。酷狗 / QQ 音乐那一套是：
 * **长按一行 → 进入多选**，之后再点就是勾选 / 取消。这里把这件事抽成一个
 * 可以展开到任意行上的属性包，省得每个列表各写一遍定时器。
 *
 * 三个细节，少一个手感就崩：
 *   · **只认 touch**：鼠标按住 460ms 不该触发多选（桌面有右键和 Ctrl）；
 *   · **一滚动 / 一挪动就取消**：手指推着列表滚的时候，手指相对视口几乎没动，
 *     光看坐标位移判不出来，必须同时听 `scroll`（见 onPointerDown 里的说明）；
 *   · **长按后的 click 要吞掉**：手指抬起浏览器还会补一个 click，
 *     不吞的话「长按进入多选」会紧接着把这首播了。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

/** 触发时长。480ms 是移动端菜单的常用值：比系统长按（500ms）略早，手指感觉刚好 */
const HOLD_MS = 480

/**
 * 手指抖动的容忍半径（px）。
 *
 * 以前 `pointermove` 一律取消长按。手指按在玻璃上不可能一动不动——华为 / 荣耀那批
 * 机器每帧都会吐几个 1~3px 的 move，定时器还没到就被清掉了，用户看到的就是
 * **「长按毫无反应」**（同一份代码在小米上能弹，因为那边抖动少）。现在超过 12px
 * 才算「在滑列表」，以下都当作还按着。
 */
const SLOP = 12

let timer = 0
let firedAt = 0
/** 当前这次按压挂着的「别长了」监听；抬手/触发时要解掉，否则会一直累积 */
let detach: (() => void) | null = null

/** 长按落点。菜单要贴着手指弹，不能弹到屏幕另一头去 */
export type HoldPoint = { x: number; y: number }

export function longPressProps(fire: (at: HoldPoint) => void) {
  const stop = () => {
    window.clearTimeout(timer)
    if (detach) { detach(); detach = null }
  }
  let at: HoldPoint = { x: 0, y: 0 }
  let start: HoldPoint = { x: 0, y: 0 }
  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      /*
       * 只认手指。`pointerType` 在个别 WebView（华为上的老 Chromium）里是空串，
       * 一律当触摸处理——真正的鼠标在这里恒为 'mouse'，不会被误伤。
       */
      if (e.pointerType === 'mouse') return
      firedAt = 0
      stop()
      at = { x: e.clientX, y: e.clientY }
      start = at
      /*
       * 一滚动就作废。
       *
       * 这是「**只是滑了一下，怎么就进多选了**」的根因：手指按住列表往上推，
       * 浏览器接管触摸去滚容器，此时**手指相对视口几乎没动**——真正在动的是
       * 列表里的行。于是上面那条「挪超过 12px 才算滑动」的判据完全失效，
       * 480ms 一到照常触发长按，用户看到的就是「我明明没长按」。
       *
       * `scroll` 不冒泡，但在**捕获阶段**能从 window 一路传到目标，
       * 所以在 window 上挂一个捕获监听就能覆盖所有滚动容器（列表、弹层、页面）。
       * 真滚动必发 scroll，系统长按弹层不会——比去猜 `pointercancel` 稳得多，
       * 华为那批机器会在系统长按时误发 pointercancel，所以那个信号不能用来判。
       */
      const onScroll = () => stop()
      window.addEventListener('scroll', onScroll, { capture: true, passive: true })
      detach = () => window.removeEventListener('scroll', onScroll, true)
      timer = window.setTimeout(() => {
        stop()
        firedAt = Date.now()
        fire(at)
      }, HOLD_MS)
    },
    onPointerUp() {
      stop()
      /*
       * 抬手时把时间戳刷成「现在」。
       *
       * 浏览器补的那个 click 是在抬手之后才发的，而 `consumeLongPress` 只认
       * 触发后 1.2 秒内的点击。按住三秒再松手，时间戳早就过期了——这一下会
       * 被当成普通点击，长按进多选的同时把这首也播了。刷新之后，不管按多久，
       * 紧跟抬手的这一次 click 一定被吞掉；没产生 click 的话 1.2 秒后自然失效。
       */
      if (firedAt) firedAt = Date.now()
    },
    /*
     * 只有「明显挪动」才取消。
     *
     * `pointercancel` / `pointerleave` **不取消**：安卓 WebView 在长按判成
     * 「系统长按」时会发一个 pointercancel（华为、荣耀尤其积极），
     * 早先的写法一收到就清定时器，于是菜单永远不会出现。滚动这件事交给上面的
     * `scroll` 监听——它只在真滚动时发，不会误伤。
     */
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (dx * dx + dy * dy > SLOP * SLOP) stop()
    },
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

/**
 * 这一发 `contextmenu` 是「长按的副产物」吗？
 *
 * 安卓 WebView 在手指按住约 500ms 时会自己发一个 `contextmenu`（系统长按菜单的钩子）。
 * 我们自己的长按是 480ms 触发，于是顺序变成：480ms 先 `enterEdit()` 把整理态打开，
 * 500ms 系统那一发进来时 `tidy` 已经是 true，被当成「整理态里的右键」，
 * **又多弹一个菜单**——现象是长按一下同时出现小叉和浮层。
 *
 * 鼠标右键不会走到这里：`longPressProps` 开头就把 `pointerType === 'mouse'` 挡掉了，
 * `firedAt` 一直是 0。
 */
export function isHoldContextMenu(): boolean {
  return firedAt > 0 && Date.now() - firedAt < 900
}
