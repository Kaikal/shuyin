/**
 * 歌单网格的手势层：长按拖起来换位 + 长按松手进「整理态」+ 整理态里按手柄直接拖。
 *
 * 触摸这条路（用户 2026-11-10 / 11-11 的口径）：
 *   · 按住约 0.34 秒，卡片「端起来」（`.is-armed`，微微放大 + 一圈描边）；
 *     之后手指一动就是排序，**松手只重排、绝不进整理态**；
 *     一直没动就松手 → 进整理态（右上角出现 ×，卡上出现手柄）。
 *   · **整理态里从手柄（`data-drag-handle`）按下去立刻可拖**，不用再等 0.34 秒。
 *     手柄上写了 `touch-action: none`，浏览器从这一下开始就不接管纵向手势，
 *     不会再出现「拖到一半被判成滚页面、pointercancel 把拖动打断」。
 *     整理态里非手柄区域仍留给滚动——歌单多了要靠它翻。
 *   · **鼠标** —— 右键进整理态（桌面习惯），整理态里整卡都能拖。
 *     鼠标按住不动不算长按，点一下还是「打开歌单」。
 *
 * ## 为什么拖动中不真的重排数组
 *
 * 最初的做法是「手指一过界就调 onReorder，让父层重排」。看起来能用，
 * 实际有两个毛病：
 *   1. 被拖的卡片必须 `position: fixed` 才能不被重排带走，可它一脱离文档流，
 *      原来的坑位立刻被后面的卡片填上——整排卡片会「哗」地跳一下，很难看；
 *   2. 拖动中途就有十几次 setState，每帧一次 DOM 重排，手机上直接掉帧。
 *
 * 现在改成经典做法：**拖动期间数组不动，只给邻居写位移**（`transform`），
 * 松手才把 from→to 交给父层。位移量按「让位后的下标」算，跨行也对：
 *
 *   pos(k) = ((k % 列) * (格宽+横缝), floor(k / 列) * (格高+纵缝))
 *   位移   = pos(让位后的下标) - pos(原下标)
 *
 * 这样卡片是「让人」而不是「换位」，有过渡也不打架；父层只在松手时重排一次。
 *
 * ## 为什么同时听 pointer 和 touch
 *
 * 指针事件是主通道（鼠标只有它），但触摸时浏览器随时可能因为「它觉得你在滚页面」
 * 而发 `pointercancel` 把整条 pointer 事件流收走——那一刻 `pointermove` 再也不来，
 * 卡片就僵在原地，抬手时 `lifted` 还是 false，于是被当成「长按没动」进了删除态。
 * 触摸的手势只有 `touchmove` + `preventDefault()` 能真正抢回来，
 * 所以触摸这条路由 touch 事件继续跟手，两条路写的是同一个 `update()`。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { grabGesture, releaseGesture } from '../lib/gestureLock'

/** 卡片「端起来」之后再挪这么多才算真在拖（以下当按住不动） */
const LIFT_SLOP = 5

/**
 * 长按到点**之前**允许的手指抖动（px）。
 *
 * 以前是 5。手指按在玻璃上每帧都会吐 1~3px 的 move，340ms 里累计起来很容易
 * 超过 5px，定时器还没到手势就被判死——用户的原话是「长按拖动不好触发」
 * （2026-11-11）。12 和 `lib/longPress` 里那个 SLOP 对齐：
 * 真要滚列表的话，12px 以内也滚不动，所以不会误伤滚动。
 */
const PRE_SLOP = 12

/**
 * 触摸按住多久算长按（进「可拖」的预置态）。
 *
 * 380 → 340：拿起得更快一点，和系统长按（500ms，会顺手弹 contextmenu）拉开距离。
 * 再短就会和「点一下打开歌单」打架。
 */
const HOLD_MS = 340

/** 拖动结束后这段时间内的 click 一律吞掉（浏览器补发的那个） */
const CLICK_GUARD_MS = 350

interface Props {
  /**
   * 删除态：× 已经露出来。
   *
   * 触摸在这个态下**不接拖动**（用户：「长按，就是可以删除歌单，这时候不能拖动」），
   * 鼠标照旧能拖（桌面没有「长按」这个动作，进删除态之后只能靠拖）。
   */
  deleting?: boolean
  /** 触摸长按松手（没移动）→ 父层进删除态 */
  onHold?(): void
  /**
   * 整理态里长按某张卡 → 弹这张卡的功能菜单（编辑 / 删除 / 置顶）。
   *
   * 以前这里靠系统补发的 `contextmenu`，但触摸屏上根本没保证：
   * 华为 / 荣耀那批 WebView 在 `user-select: none` 的元素上**不派发 contextmenu**，
   * 于是「整理态里长按 → 菜单」在真机上永远不出现（用户 2026-11-13 报了这条）。
   * 现在自己起一个 340ms 的定时器，跟拖动用的是同一套抖动阈值。
   */
  onMenu?(at: { x: number; y: number }): void
  /** 组内换位。松手时才调用一次，索引是 `[data-skey]` 的顺序 */
  onReorder(from: number, to: number): void
  /** 不许拖到的下标以下（比如第一格是固定的「我喜欢的音乐」） */
  minIndex?: number
  className?: string
  children: ReactNode
}

interface DragState {
  el: HTMLElement
  cards: HTMLElement[]
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  /** 拖起来那一刻的位置（视口坐标），用来算跟手位移 */
  originLeft: number
  originTop: number
  /** 容器内容区左上角（视口坐标） */
  hostLeft: number
  hostTop: number
  cellW: number
  cellH: number
  gapX: number
  gapY: number
  cols: number
  /** 起点下标 */
  from: number
  /** 落点下标（会随手指变） */
  over: number
  /** 长按已到点，进入「端起来」预置态（还没开始位移） */
  armed: boolean
  /** 真的动起来了 */
  lifted: boolean
  min: number
}

export function SortableGrid({
  deleting = false, onHold, onMenu, onReorder, minIndex = 0, className = 'home-grid', children,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const holdTimer = useRef(0)
  const cb = useRef(onReorder)
  cb.current = onReorder
  const holdCb = useRef(onHold)
  holdCb.current = onHold
  const menuCb = useRef(onMenu)
  menuCb.current = onMenu
  /** 这个实例的手势锁名（同一屏有本地 / 平台 / 收藏三个网格，不能共用一个名字） */
  const lockId = useRef(`sort-${Math.random().toString(36).slice(2, 8)}`)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const lock = lockId.current

    const cardsNow = () => Array.from(host.querySelectorAll<HTMLElement>('[data-skey]'))

    const clearHold = () => {
      if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = 0 }
    }

    /* ---- 整理态里「长按弹菜单」这一路（跟拖动完全独立，别混进 dragRef） ---- */
    let menuTimer = 0
    let menuFrom = { x: 0, y: 0 }
    let menuAt = { x: 0, y: 0 }
    const clearMenuHold = () => {
      if (menuTimer) { window.clearTimeout(menuTimer); menuTimer = 0 }
    }

    const reset = (d: DragState) => {
      d.el.classList.remove('is-dragging', 'is-armed')
      delete d.el.dataset.armed
      d.el.style.transform = ''
      d.el.style.touchAction = ''
      for (const c of d.cards) { c.style.transform = ''; c.style.transition = '' }
    }

    /** 放下这次手势（没排成、没进删除态），一切原位 */
    const abort = () => {
      const d = dragRef.current
      dragRef.current = null
      clearHold()
      releaseGesture(lock)
      if (d) reset(d)
    }

    /**
     * 把这张卡片置成「端起来了」。
     *
     * 做三件事，顺序都不能换：
     *   1. 加 `.is-armed` —— 这是**拿起来了的唯一反馈**。没有它用户根本不知道
     *      现在拖会不会有效果，手感就是「长按不好触发」；
     *   2. `touch-action: none` —— 手指还完全没动，此时改值 Chromium 会认，
     *      接下来那一下就不会被判成滚页面；
     *   3. 拿走手势锁 —— 页面横滑看到锁整段让开，卡片才不会被「整页在溜」带走。
     */
    const armNow = (d: DragState) => {
      if (d.armed) return
      d.armed = true
      d.el.classList.add('is-armed')
      /*
       * 同一个状态再写一份 data 属性。
       *
       * `.is-armed` 是**原生代码**加的类，而这张卡的 `className` 归 React 管——
       * 只要父层在这期间重渲染一次（队列/进度/收藏都会触发），React 写回
       * `className="home-card"`，类名就没了，用户看到的是「按住了但什么反应都没有」。
       * data 属性不在 React 的 props 里，它不会去碰，反馈才稳得住。
       */
      d.el.dataset.armed = '1'
      d.el.style.touchAction = 'none'
      grabGesture(lock)
      /* 轻轻一震：告诉指腹「拿起来了」。设备不支持 / 没权限时静默失败 */
      try { navigator.vibrate?.(8) } catch { /* 忽略 */ }
    }

    /** 长按定时器到点 */
    const arm = () => {
      holdTimer.current = 0
      const d = dragRef.current
      if (!d || d.lifted) return
      armNow(d)
    }

    const onPointerDown = (e: PointerEvent) => {
      // 鼠标只认左键：右键是「进删除态」，不是拖动
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const target = e.target as HTMLElement
      /*
       * 手柄起手 = 用户已经明确说了「这一下是拖」。
       *
       * 整理态里每张卡都会露出一枚手柄（`data-drag-handle`，CSS 上写了
       * `touch-action: none`），从它按下去**立刻**可拖，不用再等 340ms。
       * 这就是用户说的「拖不动」的解法：之前整理态里触摸完全不接拖动，
       * 而长按那条路又随时可能被浏览器判成滚页面（pointercancel），
       * 手指按住一滑、卡片先抖一下就回位了。
       */
      const byHandle = !!target.closest('[data-drag-handle]')
      /*
       * 整理态 + 手指 + 没按在手柄上 = 这一下要么是**滚列表**，要么是**要菜单**。
       *
       * 早先这里直接 `return`（整理态触摸不接拖动），结果连"长按弹菜单"也没了：
       * 菜单原来是等系统 `contextmenu`，而它在 WebView 里常常不派发。
       * 现在自己起一个定时器——按住 340ms 不动就弹菜单，动了就当滚动（阈值同 PRE_SLOP）。
       */
      if (deleting && e.pointerType !== 'mouse' && !byHandle) {
        if (target.closest('[data-nodrag]')) return
        const card = target.closest<HTMLElement>('[data-skey]')
        if (!card || card.dataset.fixed || !host.contains(card)) return
        menuFrom = { x: e.clientX, y: e.clientY }
        menuAt = { x: e.clientX, y: e.clientY }
        clearMenuHold()
        menuTimer = window.setTimeout(() => {
          menuTimer = 0
          /* 抬手这一下补发的 click 不能让卡片自己再跑一次 onClick */
          swallowUntil = Date.now() + CLICK_GUARD_MS
          menuCb.current?.(menuAt)
        }, HOLD_MS)
        return
      }
      // 小叉、播放键这类按钮不负责拖动
      if (target.closest('[data-nodrag]')) return
      const el = target.closest<HTMLElement>('[data-skey]')
      if (!el || !host.contains(el)) return
      // 「我喜欢的音乐」这种固定卡：参与几何计算（它占着一格），但不许被拖走
      if (el.dataset.fixed) return
      // 同一个手势重复进来（pointerdown 冒泡）时先收掉上一份
      const prev = dragRef.current
      if (prev) { clearHold(); reset(prev) }

      const list = cardsNow()
      const from = list.indexOf(el)
      const first = list[0]
      if (from < 0 || !first) return

      const fr = first.getBoundingClientRect()
      const cs = getComputedStyle(host)
      const gapX = parseFloat(cs.columnGap) || 0
      const gapY = parseFloat(cs.rowGap) || 0
      const hr = host.getBoundingClientRect()
      // 列数由「容器宽 + 一个缝」除「格宽 + 一个缝」反推，比 split gridTemplateColumns 稳
      const cols = Math.max(1, Math.round((hr.width + gapX) / (fr.width + gapX)))
      const rect = el.getBoundingClientRect()

      dragRef.current = {
        el, cards: list, pointerId: e.pointerId, pointerType: e.pointerType,
        startX: e.clientX, startY: e.clientY,
        originLeft: rect.left, originTop: rect.top,
        hostLeft: hr.left + host.clientLeft, hostTop: hr.top + host.clientTop,
        cellW: fr.width, cellH: fr.height, gapX, gapY, cols,
        from, over: from,
        /*
         * 鼠标按下即「可以拖」；触摸一律等 armNow（长按到点，或手柄按下）。
         * **手柄这里不能预置 true**：armNow 开头就有 `if (d.armed) return`，
         * 提前置真是把它整段短路掉——反馈、手势锁、震动全没了（2026-11-11 踩过）。
         */
        armed: e.pointerType === 'mouse',
        lifted: false,
        min: Math.max(0, Math.min(minIndex, list.length - 1)),
      }

      if (e.pointerType !== 'mouse') {
        clearHold()
        if (byHandle) armNow(dragRef.current)
        else holdTimer.current = window.setTimeout(arm, HOLD_MS)
      }
    }

    /** 让位：非拖动卡片按「自己在新顺序里的位置」平移过去 */
    const applyShift = (d: DragState) => {
      const { cards, from, over, cols, cellW, cellH, gapX, gapY } = d
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i]
        if (c === d.el) continue
        let j = i
        if (from < over) { if (i > from && i <= over) j = i - 1 }
        else if (from > over) { if (i >= over && i < from) j = i + 1 }
        const dx = ((j % cols) - (i % cols)) * (cellW + gapX)
        const dy = (Math.floor(j / cols) - Math.floor(i / cols)) * (cellH + gapY)
        c.style.transform = dx || dy ? `translate3d(${dx}px, ${dy}px, 0)` : ''
      }
    }

    /** 手指到 (x, y)：pointer / touch 两条路共用，重复调用结果一样 */
    const update = (x: number, y: number) => {
      const d = dragRef.current
      if (!d) return
      const dx = x - d.startX
      const dy = y - d.startY

      if (!d.armed) {
        /*
         * 还没到长按时间就动了：这是**滚页面 / 滑页面**，不是拖卡片。
         * 收掉这次手势，把后续交给浏览器——不这么做的话，
         * 手指一划就把卡片拖起来，列表再也滚不动。
         * 阈值是 PRE_SLOP（12）而不是 5：抖动不该被判成滑动。
         */
        if (Math.hypot(dx, dy) < PRE_SLOP) return
        abort()
        return
      }

      if (!d.lifted) {
        if (Math.hypot(dx, dy) < LIFT_SLOP) return
        d.lifted = true
        d.el.classList.remove('is-armed')
        delete d.el.dataset.armed
        d.el.classList.add('is-dragging')
        // 邻居加上过渡：让位是「挪过去」而不是「瞬移」
        for (const c of d.cards) {
          if (c !== d.el) c.style.transition = 'transform 160ms cubic-bezier(.2,.8,.2,1)'
        }
      }

      d.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.05)`

      /*
       * 落点：把「手指相对容器左上角的偏移」翻译成行列，再压回合法下标。
       * 用四舍五入（减半格）而不是向下取整，卡片才像被「吸」过去，
       * 不会出现「手指已经过了中线、卡片还赖在原来那格」。
       */
      const relX = x - d.hostLeft
      const relY = y - d.hostTop
      const col = Math.min(d.cols - 1, Math.max(0, Math.round(relX / (d.cellW + d.gapX) - 0.5)))
      const row = Math.max(0, Math.round(relY / (d.cellH + d.gapY) - 0.5))
      const next = Math.min(d.cards.length - 1, Math.max(d.min, row * d.cols + col))
      if (next !== d.over) {
        d.over = next
        applyShift(d)
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      /* 整理态里手指一挪就是滚列表，别把菜单按出来（阈值同拖动的 PRE_SLOP） */
      if (menuTimer && Math.hypot(e.clientX - menuFrom.x, e.clientY - menuFrom.y) > PRE_SLOP) {
        clearMenuHold()
      }
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      update(e.clientX, e.clientY)
    }

    /**
     * 触摸的第二条路。
     *
     * `pointercancel` 之后 pointer 流就断了，只有 touchmove 还能拿到坐标；
     * 而「拦住滚动」也只有非 passive 的 touchmove + preventDefault 做得到。
     * 未到长按时**不 prevent**：那时候是在滚列表 / 滑页面，一概别管。
     */
    const onTouchMove = (e: TouchEvent) => {
      const p0 = e.touches[0]
      if (menuTimer && p0 && Math.hypot(p0.clientX - menuFrom.x, p0.clientY - menuFrom.y) > PRE_SLOP) {
        clearMenuHold()
      }
      const d = dragRef.current
      if (!d) return
      const p = e.touches[0]
      if (!p) return
      if (d.armed && e.cancelable) e.preventDefault()
      update(p.clientX, p.clientY)
    }

    /**
     * 收尾。
     *
     * `cancelled` = 浏览器把手势抢走了（pointercancel）。这种状态下如果卡片还没
     * 被拿起来，就当没发生过——用户没打算长按，只是被系统打断，不能因此进删除态。
     * 已经拖起来的照常落位：手指确实拖了这么远，落点就该认。
     */
    const end = (cancelled: boolean) => {
      clearHold()
      clearMenuHold()
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      releaseGesture(lock)

      if (!d.lifted) {
        /*
         * 长按到了、但手指一直没动，现在松手 —— 进删除态。
         *
         * 只对触摸生效：鼠标点一下卡片必须还是「打开歌单」，
         * 不能因为按住超过 340ms 就莫名进了整理态。
         */
        const held = d.armed && d.pointerType !== 'mouse'
        reset(d)
        if (held && !cancelled) {
          /*
           * 抬手这一下浏览器还会补一个 click。不吞掉的话，
           * 「长按 → 进删除态」的同时顺手把歌单打开了——用户看到的是
           * 抖动的卡片后面已经跳进了详情页。
           */
          swallowUntil = Date.now() + CLICK_GUARD_MS
          holdCb.current?.()
        }
        return
      }

      /*
       * 拖动结束：**只重排，绝不进删除态**。
       * 用户的口径：「我长按了然后拖动，说明这次长按的目的是拖动」（2026-11-11）。
       */
      const { el, cards, from, over } = d
      el.classList.remove('is-dragging', 'is-armed')
      delete el.dataset.armed
      el.style.transform = ''
      el.style.touchAction = ''
      /*
       * 先把位移和过渡一起摘掉，再让父层重排。
       *
       * 顺序反了会「弹一下」：重排后卡片已经在新位置，此时的 transform 还是
       * 按旧位置算的，带着过渡清空就成了「从新位置滑回新位置」的怪动作。
       * 同一帧里清干净再重排，浏览器根本看不到中间态。
       */
      for (const c of cards) {
        c.style.transition = 'none'
        c.style.transform = ''
      }
      if (over !== from) {
        swallowUntil = Date.now() + CLICK_GUARD_MS
        cb.current(from, over)
      }
      requestAnimationFrame(() => {
        for (const c of cards) c.style.transition = ''
      })
    }

    /* touchend 里没有 pointerId，坐标也用不着：落点已经在拖动期间算好了 */
    const onEnd = () => end(false)
    const onCancel = () => end(true)

    host.addEventListener('pointerdown', onPointerDown)
    // move / up 挂 window：手指拖出网格（拖到标题上、拖到窗口外）也要继续跟手
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
      clearHold()
      clearMenuHold()
      // 删除态被外部关掉时（点空白 / 按 Esc / 返回键）可能还有残留位移，清掉
      abort()
    }
  }, [deleting, minIndex])

  /*
   * 捕获阶段拦 click：拖动结束那一下必须在业务 onClick 之前被吃掉。
   * 捕获在容器上就能拿到，冒泡阶段的处理函数根本收不到。
   */
  const onClickCapture = (e: React.MouseEvent) => {
    if (Date.now() < swallowUntil) {
      e.stopPropagation()
      e.preventDefault()
    }
  }

  return (
    <div
      ref={hostRef}
      className={className}
      data-edit={deleting ? 'true' : undefined}
      onClickCapture={onClickCapture}
    >
      {children}
    </div>
  )
}

/**
 * 拖动结束后的 click 闸门。
 *
 * 放在模块作用域而不是组件 state：重排会让父组件重渲染，但闸门要在
 * **同一个同步任务**里被读到，state 更新是异步的、赶不上抬手补发的那次点击。
 */
let swallowUntil = 0

/** 刚刚拖动过吗？（调用方在 onClick 里再兜一层，最保险） */
export function isJustDragged(): boolean {
  return Date.now() < swallowUntil
}
