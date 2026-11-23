/**
 * iPhone 的「从左边缘往右滑 → 返回上一层」。
 *
 * 安卓不用这个：系统自己带边缘返回手势，按下去会直接发返回键 / 手势事件
 * （见 lib/native/android.ts 的 `__syBack`）。iOS 没有这回事——WKWebView
 * 的 `allowsBackForwardNavigationGestures` 只认 history，而我们是单页应用，
 * 从头到尾只有一个 history 条目，侧滑永远什么都不做。用户的原话：
 * 「我们的APP好像没有苹果的返回功能，一般应用在左侧边缘滑动可以返回，我们的就不行」。
 *
 * 所以自己实现一格：起点落在左边缘 22px 内、向右拖，松手过阈值就调 `onBack`。
 * `onBack` 由 App 提供，直接复用安卓返回键那一套层叠顺序
 * （播放页 > 抽屉 > 详情 > 子页 > 回首页），两条入口同一份真值。
 *
 * ⚠️ 三个必须：
 *   1. **touchmove 要 passive: false**。和 lib/pageSwipe 一样：真机上浏览器
 *      第一次 move 之后就把手势判成「页面滚动」并补 `pointercancel`，
 *      不拦就永远收不到 touchend（这也是播放页歌词页返回不了的同一条根因）。
 *   2. **左边缘那一小条要先从 pageSwipe 手里抢过来**。pageSwipe 是从任意位置
 *      起手切页面的，不排除边缘的话，同一次滑动会既切页又返回。
 *      对它那边的改动是「起点 x ≤ EDGE 就不接管」（见 pageSwipe 的 start）。
 *   3. **播放页 / 弹层里不接管**。播放页自己有横滑（右滑退出），弹层里的横划
 *      是选词拖选；在这些地方再叠一层返回手势，手指一斜就误退。
 */
import { useEffect, useRef } from 'react'

/** 起手允许的最右 x（CSS px）。比 iOS 系统那条约 16pt 的边稍宽一点，好按 */
const EDGE = 22
/** 判定方向前允许的抖动 */
const SLOP = 8
/** 拖过这么多就认（比系统那条松，手指不用划满整屏） */
const COMMIT = 72
/** 快速甩：时间短、距离短也算 */
const FLICK = 30
const FLICK_MS = 260
/** 回弹时间 */
const BACK_MS = 200

const EASE = 'cubic-bezier(0.32, 0.72, 0.22, 1)'

/** 这些容器里的横向手势归它们自己，边缘返回不接 */
const BLOCKED = [
  '.imm',              // 沉浸式播放页：自己就是横滑翻页 / 右滑退出
  '.ctx-menu',
  '.modal', '.modal-scrim', '.sheet', '.drawer', '.q-drawer',
  '.queue-drawer', '.q-scrim',
  '[role="dialog"]', '[role="slider"]',
  'input', 'textarea', 'select', '[contenteditable="true"]',
  '[data-no-swipe]',
].join(', ')

/**
 * 跟手的那一层。
 *
 * 优先二层页面（`.page-keep.push`：本地歌单、在线歌单、收藏、历史…），
 * 那是最常见的「返回」场景；没有二层页面时用整条页面长条
 * （`page !== home` 时它已经偏在 -100%，往右挪正好露出上一页）。
 */
function dragLayer(): HTMLElement | null {
  const pushes = document.querySelectorAll<HTMLElement>('.page-keep.push')
  for (let i = pushes.length - 1; i >= 0; i--) {
    const el = pushes[i]
    if (el.offsetParent !== null) return el
  }
  return document.querySelector<HTMLElement>('.page-track')
}

export function useEdgeBack(opts: {
  /** 只在 iOS 打开：安卓有系统手势，再叠一层会互相抢 */
  enabled: boolean
  /** 当前有没有上一层可回。没有的话连跟手都不做——首页边缘滑不该有反应 */
  canBack: () => boolean
  /** 返回上一层；返回 true 表示「这一下吃掉了」 */
  onBack: () => boolean
}): void {
  const onBack = useRef(opts.onBack)
  onBack.current = opts.onBack
  const enabled = useRef(opts.enabled)
  enabled.current = opts.enabled
  const canBack = useRef(opts.canBack)
  canBack.current = opts.canBack

  useEffect(() => {
    let x0 = 0
    let y0 = 0
    let t0 = 0
    /** 是否还归我们管 */
    let armed = false
    /** 判定为纵向 / 撞了禁区，整段放弃 */
    let dead = false
    /** 目标层（起手时定下来，中途不再换） */
    let node: HTMLElement | null = null
    let dx = 0

    const paint = (n: HTMLElement | null, v: number) => {
      if (!n) return
      n.style.transform = v === 0 ? '' : `translate3d(${v}px, 0, 0)`
    }

    const settle = (n: HTMLElement | null, to: number) => {
      if (!n) return
      n.style.transition = `transform ${BACK_MS}ms ${EASE}`
      paint(n, to)
      window.setTimeout(() => {
        n.style.transition = ''
        n.style.transform = ''
      }, BACK_MS)
    }

    const start = (e: TouchEvent) => {
      armed = false
      dead = false
      node = null
      dx = 0
      if (!enabled.current) return
      if (e.touches.length !== 1) return
      /* 没有可退的层就别接：首页边缘右滑不该有任何跟手 */
      if (!canBack.current()) return
      const t = e.touches[0]
      /* 只认左边缘起手：从屏幕中间横划是切页面，不是返回 */
      if (t.clientX > EDGE) return
      const el = e.target as Element | null
      if (!el || typeof el.closest !== 'function') return
      if (el.closest(BLOCKED)) return
      /*
       * 横向滚动容器里不接：歌单卡横排、平台胶囊横排在边缘起手时，
       * 那根手指是该翻卡的（和 pageSwipe 的判定一致）。
       */
      let p: Element | null = el
      while (p && p !== document.body && p !== document.documentElement) {
        const cs = getComputedStyle(p)
        if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 4) return
        p = p.parentElement
      }
      x0 = t.clientX
      y0 = t.clientY
      t0 = performance.now()
      armed = true
    }

    const move = (e: TouchEvent) => {
      if (!armed || dead) return
      const t = e.touches[0]
      if (!t) return
      const raw = t.clientX - x0
      const dy = t.clientY - y0
      if (!node && Math.abs(raw) < SLOP && Math.abs(dy) < SLOP) return
      if (raw <= 0) { dead = true; return }
      if (Math.abs(dy) >= Math.abs(raw)) { dead = true; return }
      if (e.cancelable) e.preventDefault()
      if (!node) {
        node = dragLayer()
        if (node) node.style.transition = 'none'
      }
      /* 越拖越沉：拖到 200px 之后每多拖一点只跟 0.4，手感上「到头了」 */
      dx = raw <= COMMIT ? raw : COMMIT + (raw - COMMIT) * 0.4
      paint(node, dx)
    }

    const end = () => {
      if (!armed) return
      armed = false
      const n = node
      node = null
      if (dead || !n) { settle(n, 0); return }
      const ms = performance.now() - t0
      const far = dx >= COMMIT || (ms < FLICK_MS && dx >= FLICK)
      if (!far) { settle(n, 0); return }
      /* 先滑出去，再换页：换完这一层就不在文档里了，看不到回弹 */
      n.style.transition = `transform ${BACK_MS}ms ${EASE}`
      paint(n, window.innerWidth)
      /* 首页 / 没有可退的层：滑出去也得滑回来，别把页面留在屏外 */
      if (!onBack.current()) settle(n, 0)
    }

    const cancel = () => {
      if (!armed) return
      armed = false
      const n = node
      node = null
      settle(n, 0)
    }

    window.addEventListener('touchstart', start, { capture: true, passive: true })
    window.addEventListener('touchmove', move, { capture: true, passive: false })
    window.addEventListener('touchend', end, { capture: true, passive: true })
    window.addEventListener('touchcancel', cancel, { capture: true, passive: true })
    return () => {
      window.removeEventListener('touchstart', start, true)
      window.removeEventListener('touchmove', move, true)
      window.removeEventListener('touchend', end, true)
      window.removeEventListener('touchcancel', cancel, true)
    }
  }, [])
}

/** pageSwipe 用它判断「起点落在左边缘，让给返回手势」 */
export const EDGE_BACK_ZONE = EDGE
