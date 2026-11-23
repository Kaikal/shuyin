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
import { EDGE_BACK_ZONE } from './edgeBack'

/** 判定方向前允许的抖动 */
const SLOP = 6
/** 慢速划：走完这么多 px 才算切页 */
const MIN_DX = 56
/** 快速轻扫：180ms 内甩出这么多就认（手机上常用「甩」而不是「拖」） */
const FLICK_DX = 26
const FLICK_MS = 180
/**
 * 拖过半屏的这么多比例就认「要切」。
 *
 * 0.26 太高了：这台机一屏 686 CSS px，要拖满 178px 松手才切。用户的原话是
 * 「滑不过去」——他拖了三分之一屏，看着下一屏都露出小半了，一松手却弹回去。
 * 0.18（约 123px）和「下一屏露出三分之一」的视觉预期对得上。
 */
const COMMIT_RATIO = 0.18
/** 到头了（第一页往右 / 最后一页往左）的阻尼 */
const EDGE_DAMP = 0.3
/** 落位时间：一段就走完，不再分「滑出 / 滑入」两段 */
const SETTLE_MS = 260

const EASE_OUT = 'cubic-bezier(0.32, 0.72, 0.22, 1)'
const EASE_BACK = 'cubic-bezier(0.22, 1, 0.36, 1)'

/**
 * 「瞬时写」必须用 inline `!important`。
 *
 * 设置里开了**减弱动效**时，全局规则（global.css）
 * `html[data-reduced-motion] * { transition-duration: 100ms !important }`
 * 会压过普通的 inline `transition: 'none'`（样式表 `!important` > inline 普通声明）。
 * 真机实锤（2026-11-15，用户录屏 + 逐帧探针）：
 *   1. 拖动时每帧写 transform 都在播 100ms 过渡 → 跟手变成橡皮筋；
 *   2. 落位收尾要把位移从 transform 交接给 margin，两条 100ms 过渡起始差十几毫秒，
 *      相加不再恒等 → 页面「跳过去 → 跳回来 → 又跳过去」，**每次落位都有**，
 *      偏差最大实测 150px。
 * inline `!important` 在同源（author）里优先级最高，稳赢样式表的 `!important`；
 * glide 动画不用锁——被压成 100ms 反而更干脆，正合减弱动效的本意。
 */
const lockTransition = (node: HTMLElement) => {
  node.style.setProperty('transition', 'none', 'important')
}
/** 解锁：glide / 弹回要挂自己的过渡，先把 important 锁摘掉（inline important 会赢过普通声明） */
const unlockTransition = (node: HTMLElement) => {
  node.style.setProperty('transition', '')
}

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
  /**
   * 手势容器（`.page-host`）。
   *
   * 以前用它挂 `data-swiping`，让 CSS 停掉页面进场动画。现在不用了：
   * 竖屏横滑时 `enabled` 已经把二层页面（`.page-keep.push`）全排除了，
   * 那条规则根本命中不了；而给 `.page-host` 写属性会让**五页所有内容**
   * 重算一次样式（真机 20~30ms），正好卡在跟手的第一帧上。
   */
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
  /**
   * effect 里的落位收尾，暴露给渲染期：横滑落位还在飞时页面被**别的路径**换掉
   * （滑动途中点了 dock / 弹层导航），立即按 React 的当前页收尾——否则遗留的
   * 定时器到点会把 margin 硬掰回滑动目标页、再补发一次 onStep，就是
   * 「跳过去、跳回来、又跳过去」三连跳（2026-11-15）。
   */
  const finishRef = useRef<(() => void) | null>(null)
  const enabled = useRef(opts.enabled)
  enabled.current = opts.enabled
  const track = useRef(opts.track)
  track.current = opts.track
  const idx = useRef(opts.index ?? 0)
  const prevIdx = useRef(opts.index ?? 0)
  /*
   * 必须先更新 idx.current、**再**检测变化并收尾：finishSettle 的 stale 判定
   * 读的是 idx.current——若先检测后赋值，收尾时看到的还是上一渲染的旧页号，
   * 「glide 中点 dock 到别的页」会被误判成没换过页，多补发一次 onStep。
   */
  idx.current = opts.index ?? 0
  if (idx.current !== prevIdx.current) {
    prevIdx.current = idx.current
    finishRef.current?.()
  }
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
    /**
     * 这次手势里**到过的最远位移**（带符号）。
     *
     * 松手判定不能只看最终位置：用户快速拖过头再「稳一下、蹭回去一点」才松手
     * 是极常见的手型（2026-11-15 录屏实锤：拖到 85px——远超 69.8px 的切页线，
     * 松手前回蹭到 60px，按最终位置判成弹回，用户原话「感觉好像就没改」）。
     * 到过切页线、松手时没拉回 26px 以内的，都算确认切页。
     */
    let peak = 0

    /**
     * 落位动画（弹回 / 切页）的状态机。
     *
     * 以前这里只有一个 `settling` 布尔量：动画期间来的 touchstart 直接 `dead`。
     * 但切页那条路要等 **两次** 超时（260ms 走完 + 280ms 收尾）才把 `settling`
     * 放掉，等于松手后 **540ms** 内的任何新滑动都不认。用户快速连滑两三下
     * （每下 150~200ms）时后两下全被吞掉，原话就是「滑得快就滑不过去」，
     * 而且因为页面一动不动，看着也「不跟手」。
     *
     * 现在改成「可中断」：新手指一落下就把上一次立刻收尾（长条直接落到目标页），
     * 这一下从新页继续跟手。视觉上只是一下到位，不会再整段无响应。
     */
    let settling = false
    /** 落位动画的目标页（`-1` = 不知道怎么落，弹回原地） */
    let settleIdx = -1
    /** 还没通知 React 的步进；0 = 已经通知过（弹回路径恒为 0） */
    let settleStep: -1 | 0 | 1 = 0
    let settleTimer = 0
    /**
     * touchcancel 之后 WebView 可能**把同一次手势重新投递**（新的 touchstart 接着
     * 原手指的位移继续来）。这段窗口内的 touchstart 必须整个吞掉：它不是新手势，
     * 若被接住，会从已经 commit 过的新页再拖再 commit 一次——一滑跳两页。
     */
    let phantomUntil = 0

    const tr = () => track.current?.current ?? null

    /**
     * 直接把位移写到长条上（不走路 CSS 过渡：跟手就是每帧一个真实值）。
     *
     * `transition` 只在锁定横向的那一帧写一次：以前每帧都写，等于每帧都让
     * 浏览器重算一次这个元素的样式，追手指的时候这笔开销白花。
     */
    const paint = (dx: number) => {
      const node = tr()
      if (!node) return
      node.style.transform = dx === 0 ? '' : `translate3d(${dx}px, 0, 0)`
    }

    const reset = () => {
      const node = tr()
      if (!node) return
      node.style.transition = ''
      node.style.transform = ''
    }

    /**
     * 把落位动画就地收尾：长条落到目标页、通知 React 换页（如果还没通知）、清掉过渡。
     *
     * 三种场景共用它：动画自己跑完、新手势插入、组件卸载。
     *
     * ⚠️ 「stale」判定（2026-11-15）：落位还在飞的时候，页面可能已经被**别的路径**
     * 换掉了（滑动途中点了 dock / 弹层把页面切走）。这时再照旧写 margin + 补发
     * onStep，用户看到的就是三连跳：跳到 dock 选的页 → 滑动定时器把它硬掰回
     * 滑动目标页 → onStep 再换一次页。所以收尾前先对账：React 的当前页必须是
     * 「这次手势的出发点」（target - step），对不上就**以 React 为准**，只把
     * 长条归位到 React 的页，不补发 onStep。
     */
    const finishSettle = () => {
      window.clearTimeout(settleTimer)
      settleTimer = 0
      const node = tr()
      const target = settleIdx
      const step = settleStep
      settleIdx = -1
      settleStep = 0
      settling = false
      if (node && target >= 0) {
        const stale = step !== 0 && idx.current !== target - step
        /* 锁过渡：margin↔transform 交接必须瞬时（见 lockTransition 注释） */
        lockTransition(node)
        node.style.marginLeft = `-${Math.max(0, stale ? idx.current : target) * 100}%`
        node.style.transform = ''
        if (step !== 0 && !stale) onStep.current(step)
      } else if (step !== 0) {
        onStep.current(step)
      }
      /*
       * ⚠️ 这里**不能**调 reset()（它会摘掉过渡锁）：浏览器的样式重算发生在
       * 本任务之后，锁若在这一帧里被摘掉，margin/transform 的交接照样按
       * 减弱动效的 100ms !important 播两条不同步的过渡——相加不再恒等，
       * 页面「跳过去→跳回来→又跳过去」。锁留在这元素上没有副作用：
       * 下一次 glide/弹回（commit/snapBack）开头会先摘，dock 换页的
       * React margin 写入本来就该瞬时。
       */
    }
    finishRef.current = finishSettle

    /** 没切：从当前位置弹回原位 */
    const snapBack = () => {
      /* 之前若有一段没跑完的落位，旧定时器必须撤掉——settleTimer 马上要被覆盖，
       * 丢掉句柄后旧定时器到点还会触发一次 finishSettle，把页面硬掰一回 */
      window.clearTimeout(settleTimer)
      const node = tr()
      settling = true
      settleIdx = idx.current
      settleStep = 0
      if (!node) { settling = false; settleIdx = -1; return }
      unlockTransition(node)
      node.style.transition = `transform ${SETTLE_MS}ms ${EASE_BACK}`
      node.style.transform = 'translate3d(0px, 0, 0)'
      settleTimer = window.setTimeout(finishSettle, SETTLE_MS + 10)
    }

    /**
     * 切页：长条从「手指松开处」直接滑到隔壁一屏。
     *
     * 到位那一拍做的事必须**在同一个任务里**：先把长条的偏移交给 margin
     * （换成一整屏的整数倍），再把 transform 清掉，最后才通知 React 换页。
     * 三步分开做（哪怕隔一帧）就会看见「先跳回去、再跳过来」。
     */
    const commit = (dir: -1 | 1) => {
      /* 同 snapBack：清掉可能残留的上一段落位定时器 */
      window.clearTimeout(settleTimer)
      const node = tr()
      settling = true
      settleIdx = idx.current + dir
      settleStep = dir
      const W = window.innerWidth
      if (!node) { finishSettle(); return }
      unlockTransition(node)
      node.style.transition = `transform ${SETTLE_MS}ms ${EASE_OUT}`
      node.style.transform = `translate3d(${dir > 0 ? -W : W}px, 0, 0)`
      settleTimer = window.setTimeout(finishSettle, SETTLE_MS)
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
      /* 系统取消后重投的同一次手势：吞掉，别从新页再拖再提交 */
      if (performance.now() < phantomUntil) return
      armed = false
      dead = false
      horiz = false
      drag = 0
      peak = 0
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
      /*
       * 上一次落位还没跑完：就地收尾，这一下从新页接着跟手。
       *
       * 位置必须压在**所有「不接管」的判定之后**——在播放页、弹层、横滑列表里
       * 按一下不该把上一次的换页动画掐断。
       */
      if (settling) finishSettle()
      const p = e.touches[0]
      /*
       * 左边缘那一小条让给「边缘右滑返回」（lib/edgeBack）。
       *
       * pageSwipe 是从**任意位置**起手切页的，边缘也算。不排除的话，同一次滑动
       * 会既切页面又触发返回，用户看到的是「划一下退两层」。
       * 22px 之内本来也几乎划不出一次切页（Safari / 系统返回手势都在这条带上）。
       */
      if (p.clientX <= EDGE_BACK_ZONE) return
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
        if (Math.abs(drag) > Math.abs(peak)) peak = drag
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
      /* 掐掉过渡只写这一次（见 paint 的注释），后面每帧只写 transform。
       * 必须是 important 锁：减弱动效的全局 !important 会把普通 inline 'none' 顶掉，
       * 每帧 transform 都在播过渡 → 拖动橡皮筋。 */
      const node = tr()
      if (node) lockTransition(node)
      // 抬手补的那一下 click 不能落到手指底下那一行上
      swallowClick()
      drag = raw
      if (Math.abs(drag) > Math.abs(peak)) peak = drag
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
      /*
       * 松手判定用「主导位移」：最终位置和到过的最远处，谁远听谁的。
       * 明显往回拉（松手处 < 26px）才当作用户主动取消。
       */
      const usePeak = Math.abs(peak) > Math.abs(raw)
      const dist = usePeak ? peak : raw
      const pulledBack = usePeak && Math.abs(raw) < FLICK_DX
      const dir: -1 | 1 = dist < 0 ? 1 : -1
      const blocked = (dir === -1 && edge.current.atStart) || (dir === 1 && edge.current.atEnd)
      const far = !pulledBack && Math.abs(dist) >= Math.max(MIN_DX, innerWidth * COMMIT_RATIO)
      /*
       * 甩一下（快而短）才看时间；**拖够距离的一律认**，不设时长上限。
       *
       * 以前是 `ms <= MAX_MS && (far || flick)`——慢慢拖过去（比如 1.2 秒拖了
       * 半屏）反而判失败，用户看到的是「明明拖过去了又弹回来」。
       * 长按那种情况根本拿不到 horiz（按住不动没有 MOVE），用不着时长兜。
       */
      const flick = ms < FLICK_MS && Math.abs(raw) >= FLICK_DX
      if (!blocked && (far || flick)) commit(dir)
      else snapBack()
      /*
       * 手势收尾必须复位：horiz/dead 残留的话，之后任何**迟到的** touchcancel
       * 都会进 cancel()、把一段已经提交的换页错当成「拖动被系统抢走」执行
       * snapBack——用户看到的就是「跳过去又弹回来」。
       */
      horiz = false
      dead = false
    }

    const cancel = () => {
      armed = false
      /*
       * 一段**已提交**的换页（settleStep ≠ 0）被 touchcancel 打中：照常完成它，
       * 绝不弹回——弹回等于把用户已经确认的换页撤销，页面「跳过去又跳回来」。
       */
      if (settling && settleStep !== 0) { finishSettle(); return }
      if (horiz) {
        /*
         * 拖到一半手指被系统抢走（真机录屏实锤，2026-11-15）：往回滑时 Android 的
         * 左缘返回手势会把整根手指收走，WebView 补 touchcancel。判定同样用主导
         * 位移（见 end 里的 peak 注释）：到过切页线的照常完成切页，没到才弹回。
         */
        const dist = Math.abs(peak) > Math.abs(drag) ? peak : drag
        const dir: -1 | 1 = dist < 0 ? 1 : -1
        const blocked = (dir === -1 && edge.current.atStart) || (dir === 1 && edge.current.atEnd)
        const far = Math.abs(dist) >= Math.max(MIN_DX, innerWidth * COMMIT_RATIO)
        const flick = performance.now() - t0 < FLICK_MS && Math.abs(dist) >= FLICK_DX
        if (!blocked && (far || flick)) commit(dir)
        else snapBack()
      }
      horiz = false
      /* 重投窗口：系统抢走手指后，紧接着可能重投同一次手势（见 phantomUntil 注释） */
      phantomUntil = performance.now() + 160
    }

    // touchmove 必须 passive:false，否则 preventDefault 无效、手势照样被抢
    window.addEventListener('touchstart', start, { capture: true, passive: true })
    window.addEventListener('touchmove', move, { capture: true, passive: false })
    window.addEventListener('touchend', end, { capture: true, passive: true })
    window.addEventListener('touchcancel', cancel, { capture: true, passive: true })
    return () => {
      finishRef.current = null
      dropSink()
      /* 落位计时器必须撤掉：它到点还会去调 onStep，组件已经卸载就是白发一次切页 */
      window.clearTimeout(settleTimer)
      settleTimer = 0
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
