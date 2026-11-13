/**
 * 手机上「左右滑一下切页面」。
 *
 * 只给「单页 + 底部 dock」那套布局开：竖屏手机、以及平板（横竖屏都算，平板
 * 横屏没换布局，只是 `data-wide='1'`）。手机横屏不要——那一套是左 dock + 两栏，
 * 横向手势要留给内容本身（歌单详情、播放页的横滑翻页都在这条轴上）。
 *
 * ⚠️ 为什么用 touch 事件而不是 pointer 事件：
 * 实测（华为 AL6-AL00 / WebView 104）在页面上横向拖，浏览器第一次 move 之后就发
 * `pointercancel` —— 它把这次拖动当成「页面滚动」收走了，pointer 事件从此不再派发，
 * 抬手也没有 pointerup，手势永远走不完。touchmove 可以 `preventDefault()`，
 * 一 prevent 浏览器就不再抢，事件流是完整的。
 *
 * 三条硬约束，少一条就会和现有手势打架：
 *   1. **先判方向再判距离**。手指斜着划时纵向位移更大就是滚列表，
 *      必须在 6px 内认出来并彻底放弃（6 而不是 12：要在浏览器自己的滑动阈值之前锁定）；
 *   2. **起手在横向滚动容器里就不接管**。歌单卡横排、平台胶囊横排都是
 *      `overflow-x: auto`，在那儿横划是在翻卡，不是切页面；
 *   3. **播放页 / 弹层 / 输入框里一律不接管**。播放页有自己的横滑翻页，
 *      弹层和输入框的横划是选词/拖选。
 *   4. **别人拿走的那根手指不接管**（`lib/gestureLock`）。歌单网格长按到点之后
 *      这根手指就归排序了，页面不能再跟着横滑——那是「卡片在拖、整页在溜」的根因。
 *   5. **迷你播放条上不接管**：那里横划是切歌。整个条子写了 `data-no-swipe`，
 *      以前两边一起动，用户看到的是「只想切歌，上面的页面也滑走了」（2026-11-11）。
 *
 * 跟手（v0.6.x 重做，v0.6.9 改成两页同屏）：
 *   以前只在抬手那一刻算个方向，然后给新页面挂一段 220ms 的入场动画——
 *   手指划过去的时候**页面一动不动**，用户的原话是「不跟手，切换不丝滑」。
 *   后来改成拖动时把位移写在页面上（1:1），但屏幕里只有当前这一页，
 *   抬手之后还得「旧页滑走 → 换内容 → 新页从对面推进来」，两段接在一起
 *   就是「下一个进来的没跟上」（2026-11-09 反馈）。
 *   现在页面是一条横向长条（`.page-track`，每页一个 `.page-slot`），
 *   位移写在这条长条上——手指拖到哪，下一屏就跟着露出多少，抬手一次到位。
 */
import { useEffect, useRef } from 'react'
import { isGestureTaken } from './gestureLock'

/** 判定方向前允许的抖动 */
const SLOP = 6
/** 慢速划：走完这么多 px 才算切页 */
const MIN_DX = 56
/** 快速轻扫：180ms 内甩出这么多就认（手机上常用「甩」而不是「拖」） */
const FLICK_DX = 26
const FLICK_MS = 180
/** 按住超过这么久再抬手，是在长按 / 拖选，不是滑 */
const MAX_MS = 900
/** 拖过半屏的这么多比例就认「要切」 */
const COMMIT_RATIO = 0.26
/** 到头了（第一页往右 / 最后一页往左）的阻尼 */
const EDGE_DAMP = 0.3
/** 落位时间：一段就走完，不再分「滑出 / 滑入」两段 */
const SETTLE_MS = 260

const EASE_OUT = 'cubic-bezier(0.32, 0.72, 0.22, 1)'
const EASE_BACK = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** 这些容器里的横向手势归它们自己 */
const BLOCKED = [
  '.imm',            // 沉浸式播放页：自己就是横滑翻页
  '.ctx-menu',       // 长按菜单
  '.modal', '.modal-scrim', '.sheet', '.drawer', '.q-drawer',
  '.queue-drawer', '.q-scrim', // 播放队列 sheet（类名不是 .drawer，必须单列）
  '[role="dialog"]', '[role="slider"]',
  'input', 'textarea', 'select', '[contenteditable="true"]',
  '[data-no-swipe]',
].join(', ')

export function usePageSwipe(opts: {
  enabled: boolean
  /** 手势容器（`.page-host`）：只管 `data-swiping` 这个标记 */
  host?: React.RefObject<HTMLElement | null>
  /** 真正被位移的东西（`.page-track`，五页并排的那条长条） */
  track?: React.RefObject<HTMLElement | null>
  /** 当前页下标（settled）：落位时要用它算长条该停在哪 */
  index?: number
  /** 已经在第一页 / 最后一页：往那个方向拖只剩阻尼，抬手也不会切 */
  atStart?: boolean
  atEnd?: boolean
  /** dir = 1 下一页（手指往左滑），-1 上一页 */
  onStep: (dir: -1 | 1) => void
}) {
  const onStep = useRef(opts.onStep)
  onStep.current = opts.onStep
  const enabled = useRef(opts.enabled)
  enabled.current = opts.enabled
  const host = useRef(opts.host)
  host.current = opts.host
  const track = useRef(opts.track)
  track.current = opts.track
  const idx = useRef(opts.index ?? 0)
  idx.current = opts.index ?? 0
  const edge = useRef({ atStart: !!opts.atStart, atEnd: !!opts.atEnd })
  edge.current = { atStart: !!opts.atStart, atEnd: !!opts.atEnd }

  useEffect(() => {
    let x0 = 0
    let y0 = 0
    let t0 = 0
    /** 手势是否还被我们管着 */
    let armed = false
    /** 判定为纵向滚动（或撞了禁区）后彻底放弃本次手势 */
    let dead = false
    /** 已经确认是横向 */
    let horiz = false
    /** 当前跟手位移（px，已含阻尼） */
    let drag = 0
    /** 段落动画进行中：这段时间里的 touchstart 一律不理，免得叠着滑 */
    let settling = false

    const el = () => host.current?.current ?? null
    const tr = () => track.current?.current ?? null

    /**
     * 滑动期间给容器挂个标记：页面自己的进场动画（`page-enter`，8px 上移 + 淡入）
     * 会和横向位移叠在一起，看起来像「滑到一半闪一下」。整段手势结束才摘掉。
     */
    const setSwiping = (on: boolean) => {
      const node = el()
      if (!node) return
      if (on) node.setAttribute('data-swiping', 'true')
      else node.removeAttribute('data-swiping')
    }

    /** 直接把位移写到长条上（不走路 CSS 过渡：跟手就是每帧一个真实值） */
    const paint = (dx: number) => {
      const node = tr()
      if (!node) return
      node.style.transition = 'none'
      node.style.transform = dx === 0 ? '' : `translate3d(${dx}px, 0, 0)`
    }

    const reset = () => {
      setSwiping(false)
      const node = tr()
      if (!node) return
      node.style.transition = ''
      node.style.transform = ''
    }

    /** 没切：从当前位置弹回原位 */
    const snapBack = () => {
      const node = tr()
      settling = true
      if (!node) { settling = false; return }
      node.style.transition = `transform ${SETTLE_MS}ms ${EASE_BACK}`
      node.style.transform = 'translate3d(0px, 0, 0)'
      window.setTimeout(() => { settling = false; reset() }, SETTLE_MS + 20)
    }

    /**
     * 切页：长条从「手指松开处」直接滑到隔壁一屏。
     *
     * 到位那一拍做的事必须**在同一个任务里**：先把长条的偏移交给 margin
     * （换成一整屏的整数倍），再把 transform 清掉，最后才通知 React 换页。
     * 三步分开做（哪怕隔一帧）就会看见「先跳回去、再跳过来」。
     */
    const commit = (dir: -1 | 1) => {
      const node = tr()
      settling = true
      const W = window.innerWidth
      const next = idx.current + dir
      if (!node) { onStep.current(dir); settling = false; return }
      node.style.transition = `transform ${SETTLE_MS}ms ${EASE_OUT}`
      node.style.transform = `translate3d(${dir > 0 ? -W : W}px, 0, 0)`
      window.setTimeout(() => {
        const n = tr()
        if (n) {
          n.style.transition = 'none'
          /* 百分比是相对 page-host 的宽度算的，正好一屏 */
          n.style.marginLeft = `-${Math.max(0, next) * 100}%`
          n.style.transform = ''
        }
        onStep.current(dir)
        window.setTimeout(() => { settling = false; reset() }, SETTLE_MS + 20)
      }, SETTLE_MS)
    }

    /*
     * 划动成立后，浏览器照样会在抬手时补一个 `click`。
     *
     * 因为我们在 touchmove 里 `preventDefault()` 了，浏览器**没有滚页面**，
     * 于是它认为这是一次「点按」——click 落到手指抬起处的那个元素上。
     * 用户报的就是这件事：「滑动时《我好像在哪见过你》这首歌总弹出来」，
     * 划一下等于点了那一行，歌就开始播了。
     *
     * 拦法：横滑一旦锁定，挂一个**只吃一次**的捕获阶段 click 监听，
     * 把紧跟而来的那一下吞掉。350ms 后自动摘（个别设备根本不补 click，
     * 不摘的话会把用户接下来的一次正常点击也吞了）。
     */
    let sink: ((e: Event) => void) | null = null
    let sinkTimer = 0
    const dropSink = () => {
      window.clearTimeout(sinkTimer)
      if (!sink) return
      window.removeEventListener('click', sink, true)
      sink = null
    }
    const swallowClick = () => {
      if (sink) return
      sink = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); dropSink() }
      window.addEventListener('click', sink, { capture: true })
      sinkTimer = window.setTimeout(dropSink, 350)
    }

    const inHorizontalScroller = (node: Element | null) => {
      let p: Element | null = node
      while (p && p !== document.body && p !== document.documentElement) {
        const cs = getComputedStyle(p)
        if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 4) return true
        p = p.parentElement
      }
      return false
    }

    const start = (e: TouchEvent) => {
      armed = false
      dead = false
      horiz = false
      drag = 0
      if (settling) { dead = true; return }
      if (!enabled.current || e.touches.length !== 1) return
      /*
       * 横屏默认不接管：手机横屏那一套是左 dock + 两栏，横向手势要留给内容自己。
       *
       * **但平板（`data-wide='1'`）横屏仍是「单页 + 底部 dock」**，和竖屏是同一套
       * 布局，整页横滑就该切页。以前一刀切 `innerWidth > innerHeight` 把平板横屏
       * 也挡掉了，用户的原话是「平板端不能左右滑动切换页面」（2026-11-13）。
       */
      if (innerWidth > innerHeight && document.documentElement.dataset.wide !== '1') return
      // 这根手指已经被别的抓手拿走了（长按拖卡片），整段让开
      if (isGestureTaken()) return
      const t = e.target as Element | null
      if (t?.closest?.(BLOCKED)) return
      if (inHorizontalScroller(t)) return
      const p = e.touches[0]
      x0 = p.clientX
      y0 = p.clientY
      t0 = performance.now()
      armed = true
    }

    const move = (e: TouchEvent) => {
      if (!armed || dead) return
      /*
       * 手势中途被别人接手（长按到点开始拖卡片）：立刻把这边的位移交还回去。
       *
       * 判定必须**每一帧都做**，不能只在起手时看一次：长按是 340ms 之后才成立的，
       * 起手那一刻还没有锁。已经跟手挪出去的那点距离要原样收掉，否则页面会
       * 停在半路，看着像卡住了。
       */
      if (isGestureTaken()) {
        dead = true
        if (horiz) { horiz = false; drag = 0; reset() }
        // 顺手撤掉那次「吞点击」：这根手指的收尾归别人了，别把人家后续的点击也吞了
        dropSink()
        return
      }
      const p = e.touches[0]
      if (!p) return
      const raw = p.clientX - x0
      const dy = p.clientY - y0
      if (horiz) {
        // 已经锁定横向：一直 prevent，浏览器不会半路把手势抢去滚页面
        if (e.cancelable) e.preventDefault()
        /* 到头了只给一点阻尼，手感上「能拉动但拉不走」 */
        const blocked = (raw > 0 && edge.current.atStart) || (raw < 0 && edge.current.atEnd)
        drag = blocked ? raw * EDGE_DAMP : raw
        paint(drag)
        return
      }
      if (Math.abs(raw) < SLOP && Math.abs(dy) < SLOP) return
      if (Math.abs(dy) >= Math.abs(raw)) {
        dead = true
        return
      }
      horiz = true
      if (e.cancelable) e.preventDefault()
      setSwiping(true)
      // 抬手补的那一下 click 不能落到手指底下那一行上
      swallowClick()
      drag = raw
      paint(drag)
    }

    const end = (e: TouchEvent) => {
      if (!armed) return
      armed = false
      if (dead || !horiz) { reset(); return }
      const p = e.changedTouches[0]
      if (!p) { snapBack(); return }
      const raw = p.clientX - x0
      const ms = performance.now() - t0
      const dir: -1 | 1 = raw < 0 ? 1 : -1
      const blocked = (dir === -1 && edge.current.atStart) || (dir === 1 && edge.current.atEnd)
      const flick = ms < FLICK_MS && Math.abs(raw) >= FLICK_DX
      const far = Math.abs(raw) >= Math.max(MIN_DX, innerWidth * COMMIT_RATIO)
      if (ms <= MAX_MS && !blocked && (far || flick)) commit(dir)
      else snapBack()
    }

    const cancel = () => {
      armed = false
      if (horiz) snapBack()
      horiz = false
    }

    // touchmove 必须 passive:false，否则 preventDefault 无效、手势照样被抢
    window.addEventListener('touchstart', start, { capture: true, passive: true })
    window.addEventListener('touchmove', move, { capture: true, passive: false })
    window.addEventListener('touchend', end, { capture: true, passive: true })
    window.addEventListener('touchcancel', cancel, { capture: true, passive: true })
    return () => {
      dropSink()
      reset()
      window.removeEventListener('touchstart', start, true)
      window.removeEventListener('touchmove', move, true)
      window.removeEventListener('touchend', end, true)
      window.removeEventListener('touchcancel', cancel, true)
    }
  }, [])
}

/** dock 的页面顺序：左右滑就是按这条链前后走 */
export const PAGE_ORDER = ['home', 'search', 'playlist', 'downloads', 'settings'] as const
