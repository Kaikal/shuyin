/**
 * 分组的上下排序：把「本地 / 网易云 / QQ / 酷狗 / 酷我」这些组整块挪位置。
 *
 * 为什么不是复用 `SortableGrid`：网格假设**格子一样大**，按 `cellW / cellH`
 * 算位移；分组的高度全不一样（一组 2 张卡、一组 12 张卡，还可能是列表模式），
 * 套进去每一格都错位。这里改成「逐组量一次 `offsetTop / offsetHeight`」，
 * 位移量用**组与组的差值**算，于是不等高也能让位。
 *
 * 为什么只从手柄起手（和卡片那套一致）：
 * 整组按住再滑，浏览器第一件事就是判成「滚页面」并发 `pointercancel`，
 * 拖动整段断掉。手柄上 `touch-action: none`，从它按下去浏览器就不接管，
 * 组外区域仍然可以正常滚列表。
 *
 * 拖动期间**数组不动**：被拖的组跟手走，其它组按「让位后的位置」写
 * `transform`，松手才把 from→to 交给父层重排一次。这样不会掉帧，
 * 也不会出现「拖动中原地被后面的组填上、整页跳一下」。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { grabGesture, releaseGesture } from '../lib/gestureLock'

/** 手柄按下后挪这么多才算真在拖（以下当误触） */
const LIFT_SLOP = 6

/** 拖动结束后这段时间内的 click 一律吞掉（浏览器补发的那一个） */
const CLICK_GUARD_MS = 350

interface Props {
  className?: string
  /** 松手时调用一次，索引是 `[data-gkey]` 的顺序 */
  onReorder(from: number, to: number): void
  children: ReactNode
}

interface DragState {
  el: HTMLElement
  sections: HTMLElement[]
  from: number
  over: number
  startY: number
  /** 每一组的内容坐标顶边 / 高度，拖动开始时量一次 */
  tops: number[]
  heights: number[]
  /** 被拖组挪一格需要带动邻居走的距离（自身高度 + 组间空隙） */
  step: number
  lifted: boolean
}

export function SortableSections({ className = 'home-groups', onReorder, children }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const cb = useRef(onReorder)
  cb.current = onReorder
  const lockId = useRef(`sect-${Math.random().toString(36).slice(2, 8)}`)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const lock = lockId.current

    const listNow = () =>
      Array.from(host.children).filter((n): n is HTMLElement =>
        n instanceof HTMLElement && !!n.dataset.gkey)

    const reset = (d: DragState) => {
      d.el.classList.remove('is-dragging', 'is-armed')
      d.el.style.transform = ''
      d.el.style.touchAction = ''
      for (const s of d.sections) {
        if (s === d.el) continue
        s.style.transform = ''
        s.style.transition = ''
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const target = e.target as HTMLElement
      const handle = target.closest<HTMLElement>('[data-section-handle]')
      if (!handle) return
      const el = handle.closest<HTMLElement>('[data-gkey]')
      if (!el) return
      const prev = dragRef.current
      if (prev) reset(prev)

      const sections = listNow()
      const from = sections.indexOf(el)
      if (from < 0) return

      /*
       * 全程用**内容坐标**（offsetTop 差值，只拿差量）。
       * 混进视口坐标（scrollTop / getBoundingClientRect）就会整体偏一截，
       * 表现为「拖一格结果挪了两格」——卡片那边踩过同一个坑。
       */
      const tops = sections.map(s => s.offsetTop)
      const heights = sections.map(s => s.offsetHeight)
      const gapAfter = from + 1 < sections.length
        ? Math.max(0, tops[from + 1] - (tops[from] + heights[from]))
        : from > 0
          ? Math.max(0, tops[from] - (tops[from - 1] + heights[from - 1]))
          : 0

      dragRef.current = {
        el, sections, from, over: from,
        startY: e.clientY,
        tops, heights,
        step: heights[from] + gapAfter,
        lifted: false,
      }

      /*
       * 手柄按下 = 用户已经说了「这一下是拖」，不用等长按。
       * 立刻给反馈（描边 + 抬起阴影），但**位移要过阈值**才发生，
       * 否则轻点一下手柄整组会抖一下。
       */
      el.classList.add('is-armed')
      el.style.touchAction = 'none'
      grabGesture(lock)
      try { navigator.vibrate?.(8) } catch { /* 设备不支持就算了 */ }
    }

    /** 其它组按「让位后的下标」平移 */
    const applyShift = (d: DragState) => {
      const { sections, from, over, step } = d
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i]
        if (s === d.el) continue
        let dy = 0
        if (from < over && i > from && i <= over) dy = -step
        else if (from > over && i >= over && i < from) dy = step
        s.style.transform = dy ? `translate3d(0, ${dy}px, 0)` : ''
      }
    }

    const update = (y: number) => {
      const d = dragRef.current
      if (!d) return
      const dy = y - d.startY

      if (!d.lifted) {
        if (Math.abs(dy) < LIFT_SLOP) return
        d.lifted = true
        d.el.classList.remove('is-armed')
        d.el.classList.add('is-dragging')
        for (const s of d.sections) {
          if (s !== d.el) s.style.transition = 'transform 170ms cubic-bezier(.2,.8,.2,1)'
        }
      }

      d.el.style.transform = `translate3d(0, ${dy}px, 0)`

      /*
       * 落点：被拖组的**中心**越过某组的中心线，就算换到那个位置。
       * 逐格推进（一次最多跨一格），所以拖得慢也不会「一跳三格」。
       */
      const center = d.tops[d.from] + d.heights[d.from] / 2 + dy
      let over = d.over
      if (dy < 0) {
        for (let i = d.from - 1; i >= 0; i--) {
          if (center < d.tops[i] + d.heights[i] / 2) over = i
          else break
        }
      } else if (dy > 0) {
        for (let i = d.from + 1; i < d.sections.length; i++) {
          if (center > d.tops[i] + d.heights[i] / 2) over = i
          else break
        }
      }
      if (over !== d.over) {
        d.over = over
        applyShift(d)
      }
    }

    const onPointerMove = (e: PointerEvent) => update(e.clientY)

    const onTouchMove = (e: TouchEvent) => {
      const d = dragRef.current
      if (!d) return
      const p = e.touches[0]
      if (!p) return
      if (d.lifted && e.cancelable) e.preventDefault()
      update(p.clientY)
    }

    const end = () => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      releaseGesture(lock)
      const { el, sections, from, over, lifted } = d

      /*
       * 先清位移再重排：顺序反了 React 已经换好位置、transform 还挂着旧值，
       * 松手会「从新位置滑回新位置」弹一下。同一帧清干净，浏览器看不到中间态。
       */
      for (const s of sections) {
        s.style.transition = 'none'
        s.style.transform = ''
      }
      el.classList.remove('is-dragging', 'is-armed')
      el.style.touchAction = ''
      requestAnimationFrame(() => {
        for (const s of sections) s.style.transition = ''
      })

      if (lifted && over !== from) {
        /*
         * 抬手这一下浏览器还会补一个 click。不吞的话，页面那层「点空白退出整理态」
         * 会立刻把整理态关掉——用户拖完一组，发现手柄全没了。
         */
        swallowUntil = Date.now() + CLICK_GUARD_MS
        cb.current(from, over)
      }
    }

    const onEnd = () => end()
    const onCancel = () => end()

    host.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onCancel)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      host.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
      window.removeEventListener('touchmove', onTouchMove)
      const d = dragRef.current
      dragRef.current = null
      releaseGesture(lock)
      if (d) reset(d)
    }
  }, [])

  return (
    <div
      ref={hostRef}
      className={className}
      /* 捕获阶段拦：拖动结束那一下必须在页面「点空白退出」之前被吃掉 */
      onClickCapture={e => {
        if (Date.now() < swallowUntil) { e.stopPropagation(); e.preventDefault() }
      }}
    >{children}</div>
  )
}

/**
 * 拖动结束后的 click 闸门。
 *
 * 模块级变量而不是 state：抬手补发的 click 和 `end()` 在同一个同步任务里，
 * state 更新是异步的，根本赶不上。
 */
let swallowUntil = 0
