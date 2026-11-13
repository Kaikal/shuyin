/**
 * 歌词视图：跟随播放滚动，当前行居中高亮；点击行跳转播放位置。
 * 无歌词时显示占位 + 「在线搜索歌词」入口。
 *
 * 滚动方式：用 transform 平移整条歌词轨（不用原生滚动条，避免与居中定位打架）。
 * 用户可滚轮 / 按住拖动临时改变位置，松手 2.4 秒后自动缓动回「跟随当前行」。
 *
 * 两个横向相关的开关（播放页右栏用）：
 *   · `align`：整行按居左 / 居中 / 居右贴边——右栏是一整块很宽的区域，
 *     只靠左会让短句缩在左边一小条里。
 *   · `scrollOverflow`：长句**不再缩字号**硬塞，超出就裁掉，等唱到这一句时
 *     随进度横向平移（`--wrap-x`），整句都能看到。没唱到的行仍然用省略号收尾，
 *     否则满屏都在飘。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fmtTime, type LyricsDoc } from '@shuyin/core'
import { IconRefresh } from './icons'
import { LyricSearchForm } from './LyricSearchForm'
import { indexAt, lineSpan, useSmoothTime } from '../lib/smoothClock'
import { visualWidth } from '../lib/textFit'
import type { LyricAlign } from '../lib/lyricAlign'

interface Props {
  doc: LyricsDoc | null
  loading: boolean
  currentTime: number
  onSeek?(t: number): void
  /** 在线搜索歌词；带上用户填的歌名 / 歌手（搜索表单里改过的） */
  onSearchOnline?(q: { title: string; artist: string }): void
  /** 当前曲目信息：只用于给搜索表单预填 */
  trackTitle?: string
  trackArtist?: string
  /** 紧凑模式：详情面板用 */
  compact?: boolean
  /** 沉浸式（全屏歌词）：行更大、居中、当前句 KTV 染色、上下渐隐更深 */
  immersive?: boolean
  /** 对齐方式：不传就按原来的靠左（详情面板 / 全屏歌词各有自己的排版） */
  align?: LyricAlign
  /** 长句溢出时横向滚动（替代缩字号）。播放页右栏 / 手机歌词页打开 */
  scrollOverflow?: boolean
  /** 行高覆盖（默认沉浸 76 / 普通 42）：手机播放页的歌词窗口矮，用 62 塞下更多句 */
  rowH?: number
  /**
   * 这块歌词现在看不看得见（默认 true）。
   *
   * 播放页是常驻挂载的：页关着的时候它照样每个位置快照都跟着重渲染，
   * 而「平滑时钟」还额外开着 30Hz 定时器往上推——不可见的时候纯属白烧，
   * 主线程被占着，别处动画就跟着掉帧。
   *
   * 名字不叫 active：这个组件里 `active` 是「当前句下标」，已经用掉了。
   */
  live?: boolean
}

const ROW_H = 42
/** 沉浸式：行距要撑开，不然整屏只有小小几行字，压不住场 */
const ROW_H_IMM = 76
/** 用户操作后，多久恢复自动跟随 */
/**
 * 手动滑完多久回到当前句。
 * 原来 2400ms：滑一下刚看清两句就被抢回去，用户感受就是「滑不动」。
 * 现在给到 6 秒，够把整段歌词看完；点某一句跳转后同样按这个时长兜底。
 */
const HOLD_MS = 6000
/**
 * 量「这一行真正能用多宽」。
 *
 * 以前是从容器宽度减去写死的 `ROW_PAD`（10px）：这个数只在播放页右栏恰好成立，
 * 全屏歌词那套行的内边距是 28px、手机歌词页是 6px——同一个常数在三处各错一截，
 * 溢出量跟着多算或少算，跑马灯就会「滚过头露白边」或者「最后几个字永远滚不出来」。
 * 行元素本身的内边距是现成的，直接读它，三处都不用再对数字。
 */
function availOf(row: HTMLElement): number {
  const cs = getComputedStyle(row)
  const padL = parseFloat(cs.paddingLeft) || 0
  const padR = parseFloat(cs.paddingRight) || 0
  return Math.max(80, row.clientWidth - padL - padR)
}
/**
 * 染色的「时间提前量」（秒）。
 *
 * `.lyric-text.kara` 上有 40ms 的 `--kara` 线性过渡，它的稳态滞后正好是一个过渡时长，
 * 于是眼睛看到的颜色总比声音晚 40ms。把算进度用的时间往前送 40ms，刚好抵消。
 * 改 CSS 里的过渡时长时，这个数要跟着改。
 */
const KARA_LAG = 0.04

/**
 * 一行歌词。
 * memo 是必需的：染色每秒要更新 30 次，如果每次都把整首歌词（可能上百行）重建一遍，
 * 长歌词会明显掉帧。现在每帧只有「当前这一行」需要重渲染。
 */
const LyricRow = memo(function LyricRow({
  text, time, height, active, shown, kara, timed, fit, isRef, onSeek, movedRef, tapGuard,
}: {
  text: string
  time: number
  height: number
  active: boolean
  shown: boolean
  kara: boolean
  timed: boolean
  /** 字号缩放（1 = 原尺寸）：长句按可用宽度收，避免顶出屏幕或被省略号吃掉 */
  fit: number
  /** 手动滑动期间，停在参考线上的那一行 */
  isRef: boolean
  onSeek?(t: number): void
  movedRef: React.MutableRefObject<boolean>
  tapGuard: React.MutableRefObject<number>
}) {
  return (
    <div
      className={'lyric-line' + (shown ? ' active' : '') + (isRef ? ' ref' : '')}
      style={{ height, ['--lf' as never]: fit }}
      role={timed ? 'button' : undefined}
      tabIndex={timed ? 0 : undefined}
      onClick={() => {
        // 刚拖动过就不算点击，避免松手瞬间跳播放位置
        if (movedRef.current) { movedRef.current = false; return }
        if (Date.now() < tapGuard.current) return
        if (timed && time >= 0) onSeek?.(time)
      }}
      onKeyDown={e => { if (e.key === 'Enter' && timed && time >= 0) onSeek?.(time) }}
    >
      <span className={'lyric-text' + (kara ? ' kara' : '')}>{text}</span>
      {timed && time >= 0 && <span className="lyric-time num">{fmtTime(time)}</span>}
    </div>
  )
})

export function LyricsView({
  doc, loading, currentTime, onSeek, onSearchOnline, trackTitle, trackArtist, compact, immersive, align, scrollOverflow,
  rowH: rowHProp, live = true,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxH, setBoxH] = useState(360)
  const [boxW, setBoxW] = useState(640)
  /** 空态里「在线搜索歌词」点开后的搜索表单（歌名 / 歌手可改）；不常显 */
  const [searching, setSearching] = useState(false)
  const rowH = rowHProp ?? (immersive ? ROW_H_IMM : ROW_H)

  /**
   * 位置快照 250ms 一跳，直接拿它上色会「一顿一顿」并且看起来慢半拍。
   * 这里插值成 ~30Hz 的连续时间，染色才跟得上耳朵。
   * （原来 15Hz：33ms 一格配 40ms 过渡才看不出台阶；15Hz 会露馅。）
   */
  const smooth = useSmoothTime(currentTime, 30, live)

  /** 用户额外位移（正值 = 内容下移，即往回看）。**只存 ref、不存 state**：
      每帧 setState 会重渲染整份歌词（上百行），真机上就是「滑动卡卡的」。 */
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(0)
  const trackRef = useRef<HTMLDivElement>(null)
  /** 手动滑动时停在参考线上的行号（-1 = 没有）。只在**跨行**时更新一次 state */
  const [refRow, setRefRow] = useState(-1)
  const refRowRef = useRef(-1)
  /**
   * 拖动开始那一刻的 follow。
   *
   * 播放一直在推进，`follow` 每换一句就跳一段——如果偏移量始终相对「实时 follow」，
   * 用户滑到后面停住不动，整块歌词也会跟着一句一句往上漂（停留 6 秒能漂出好几屏，
   * 手感就是「怎么滑都定不住」）。动手时把基准冻住，回弹归零时才解冻。
   */
  const frozenFollow = useRef<number | null>(null)
  const holdTimer = useRef(0)
  const snapRaf = useRef(0)
  const flingRaf = useRef(0)
  /**
   * 甩动采样：最近若干个 pointermove 的 (y, 时间)。
   * 松手瞬间的速度只取**最近 110ms**——按整段拖动的平均速度算，慢慢挪一大段
   * 也会被当成猛甩，松手后自己滑出两屏，比不滑还难用。
   */
  const ptsRef = useRef<{ y: number; t: number }[]>([])
  const startRef = useRef<{ y: number; base: number } | null>(null)
  const movedRef = useRef(false)
  /** 拖动结束后的短暂静默期：这段时间内补发的 click 一律不算「点某行跳转」 */
  const tapGuard = useRef(0)
  /** 点击跳转后暂存的目标行：等播放位置真的落到这一行再把位移归零（见 seekTo） */
  const pinRef = useRef(-1)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setBoxH(el.clientHeight)
      setBoxW(el.clientWidth)
    })
    ro.observe(el)
    setBoxH(el.clientHeight)
    setBoxW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const active = useMemo(() => {
    if (!doc || !doc.lines.length) return -1
    return indexAt(doc.lines, smooth)
  }, [doc, smooth])

  /** 前奏里还没有「当前句」时，先把第一句点亮，比整块灰着更像在等歌词 */
  const shown = active >= 0 ? active : (doc && doc.lines.length ? 0 : -1)

  const follow = shown >= 0 ? boxH / 2 - (shown * rowH + rowH / 2) : 0
  const timed = doc?.lines.some(l => l.time >= 0) ?? false

  /**
   * 当前句横向溢出多少（px）。
   *
   * 为什么不按字数估：`visualWidth` 只是近似值（中文 1 字宽、拉丁 0.55），
   * 估小了最后几个字就永远滚不出来，等于白滚。这里直接量高亮那一行的文字块——
   * 它在 CSS 里是 `max-width: none` 的自然宽度，减掉可用宽度就是真正要滚的距离。
   *
   * 激活行的字号有 200ms 过渡，立刻量到的是「放大前」的宽度，会偏小；
   * 过渡结束后补量一次，前后两次都只是覆盖同一个 state，不会闪。
   */
  const [ov, setOv] = useState(0)
  useLayoutEffect(() => {
    if (!scrollOverflow) { setOv(0); return }
    const box = boxRef.current
    const row = box?.querySelector<HTMLElement>('.lyric-line.active')
    const text = row?.querySelector<HTMLElement>('.lyric-text')
    if (!box || !row || !text) { setOv(0); return }
    const avail = availOf(row)
    const read = () => {
      /* 用 offsetWidth 而不是 getBoundingClientRect：这一行现在可能正被 --wrap-x 平移，
         外接矩形是平移后的，宽度倒不受影响——但 offsetWidth 更便宜，也不会被 transform 影响 */
      setOv(Math.max(0, Math.round(text.offsetWidth - avail)))
    }
    read()
    const t = window.setTimeout(read, 260)
    return () => window.clearTimeout(t)
  }, [scrollOverflow, shown, boxW, doc])

  /** 长句：随这一句的进度从左往右推，唱完正好露到最后一个字 */
  let wrapX = 0
  const curLine = doc && active >= 0 ? doc.lines[active] : null
  if (scrollOverflow && ov > 0 && curLine && curLine.time >= 0) {
    const chars = Array.from(curLine.text).length
    const nx = doc!.lines[active + 1]
    const span = lineSpan(chars, curLine.time, nx ? nx.time : 0, 0)
    const p = Math.min(1, Math.max(0, (smooth - curLine.time) / span))
    wrapX = -ov * p
  }

  /*
   * 可翻范围：从「第一行居中」到「最后一行居中」，两端各留 20% 盒高的过滚动。
   *
   * 以前按 (总高-盒高)/2 + 盒高*0.3 估算，歌一长就只够翻中间一小段——
   * 实测 50 句的歌，滚轮滑到底也看不到最后十几句（用户反馈「滚动不到最后一句」）。
   * 现在按「把某一端拉到中线」算：两头都到底，中间任意位置都能停。
   */
  const clampOffset = useCallback((off: number) => {
    const n = doc?.lines.length ?? 0
    if (!n) return 0
    const first = boxH / 2 - rowH / 2                      // 第一行居中时的位移
    const last = boxH / 2 - ((n - 1) * rowH + rowH / 2)    // 最后一行居中时的位移
    const pad = boxH * 0.2                                 // 两端过滚动，别硬顶
    return Math.max(Math.min(first, last) - pad, Math.min(Math.max(first, last) + pad, off))
  }, [doc, boxH, rowH])

  /*
   * follow / active 每次换句都变，但 apply、seekTo 的依赖不能跟着变——
   * 否则 rows 的 memo 每换一句就重建整份歌词（可能上百行），长歌明显掉帧。
   * 事件处理器里统一从 ref 取最新值。
   */
  const followRef = useRef(0)
  followRef.current = follow
  const activeRef = useRef(-1)
  activeRef.current = active

  /**
   * 把位移直接画到 DOM 上。
   *
   * 以前这里是 `setDrag(c)`：手指每动一帧就一次 React 更新，整份歌词
   * （上百行 element）跟着 reconciliation —— 真机上就是用户说的「有点卡卡」。
   * 现在 transform 直接写 style，套 React 的只有参考线那一行的行号（跨行才变）。
   */
  const paint = (off: number) => {
    const el = trackRef.current
    if (el) el.style.transform = `translateY(${off}px)`
  }

  const apply = useCallback((v: number) => {
    const f = frozenFollow.current ?? followRef.current
    const c = clampOffset(f + v) - f
    dragRef.current = c
    const off = f + c
    paint(off)
    if (compact) return
    /* 参考线只在真的拖开时出现；贴着 0 的浮点残值不算 */
    let want = -1
    if (Math.abs(c) > 1) {
      const i = Math.floor((boxH / 2 - off) / rowH)
      if (i >= 0 && i < (doc?.lines.length ?? 0)) want = i
    }
    if (want !== refRowRef.current) { refRowRef.current = want; setRefRow(want) }
  }, [clampOffset, boxH, rowH, doc, compact])

  /** 缓动归零：回到自动跟随当前行 */
  const snapBack = useCallback(() => {
    cancelAnimationFrame(snapRaf.current)
    cancelAnimationFrame(flingRaf.current)   // 回弹与惯性不许同时跑
    const step = () => {
      const cur = dragRef.current
      if (Math.abs(cur) < 0.6) {
        frozenFollow.current = null
        apply(0)
        if (trackRef.current) trackRef.current.style.transition = ''
        if (refRowRef.current !== -1) { refRowRef.current = -1; setRefRow(-1) }
        return
      }
      apply(cur * 0.82)
      snapRaf.current = requestAnimationFrame(step)
    }
    snapRaf.current = requestAnimationFrame(step)
  }, [apply])

  const hold = useCallback(() => {
    window.clearTimeout(holdTimer.current)
    cancelAnimationFrame(snapRaf.current)
    holdTimer.current = window.setTimeout(snapBack, HOLD_MS)
  }, [snapBack])

  /**
   * 松手后的惯性：手指已经离开，歌词按松手那一刻的速度继续滑，慢慢停下。
   *
   * 摩擦取每 16.7ms 保留 94.5%：1px/ms 的一甩能多走 ~300px（三四句），
   * 约 1.1 秒停稳——短了像被按住，长了会一路甩到歌尾。
   * 撞到两端就立刻停，不空转。
   */
  const startFling = useCallback((v0: number) => {
    cancelAnimationFrame(flingRaf.current)
    cancelAnimationFrame(snapRaf.current)
    /* 惯性期间每帧都在改 transform，过渡必须还关着，否则文字追着惯性走、越甩越滞 */
    if (trackRef.current) trackRef.current.style.transition = 'none'
    let v = v0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(50, Math.max(0, now - last))
      last = now
      const before = dragRef.current
      apply(before + v * dt)
      const moved = dragRef.current - before
      /* 钳制之后没走满 = 顶到两端了，就地停住 */
      if (Math.abs(moved) < Math.abs(v * dt) - 0.5) { hold(); return }
      v *= Math.pow(0.945, dt / 16.667)
      if (Math.abs(v) < 0.015) { hold(); return }
      flingRaf.current = requestAnimationFrame(step)
    }
    flingRaf.current = requestAnimationFrame(step)
  }, [apply, hold])

  /** 松手速度（px/ms，正 = 往下翻）。抬手前手指已经停住的不算甩 */
  const flingSpeed = () => {
    const a = ptsRef.current
    const last = a[a.length - 1]
    if (!last) return 0
    if (performance.now() - last.t > 80) return 0
    let i = a.length - 1
    while (i > 0 && last.t - a[i - 1].t < 110) i--
    const first = a[i]
    const dt = last.t - first.t
    if (dt < 8) return 0
    return (last.y - first.y) / dt
  }

  useEffect(() => () => {
    window.clearTimeout(holdTimer.current)
    cancelAnimationFrame(snapRaf.current)
    cancelAnimationFrame(flingRaf.current)
  }, [])

  /** 点击跳转后：播放位置真的落到那一行，就把位移归零（见 seekTo） */
  useLayoutEffect(() => {
    if (pinRef.current >= 0 && active === pinRef.current) {
      pinRef.current = -1
      dragRef.current = 0
      paint(clampOffset(followRef.current))
    }
  }, [active, clampOffset])

  /*
   * follow 变（换句）或尺寸变时，把 DOM 上的位移对齐一次。
   * 拖动中 dragRef 是最新的，所以这里不会把手指的位置改掉。
   */
  useLayoutEffect(() => {
    paint(clampOffset((frozenFollow.current ?? follow) + dragRef.current))
  }, [follow, boxH, rowH, doc, clampOffset])

  const onWheel = (e: React.WheelEvent) => {
    // 紧凑模式（详情面板）里歌词跟着面板滚，不抢滚轮
    if (compact || !doc?.lines.length) return
    // 沉浸式页本身 overflow:hidden，滚轮不会传导，直接接管
    cancelAnimationFrame(flingRaf.current)   // 惯性还没停，滚轮一滚就接管
    pinRef.current = -1   // 用户又动手了，点击的锚点作废
    if (frozenFollow.current === null) frozenFollow.current = followRef.current
    apply(dragRef.current - e.deltaY * 1.15)
    hold()
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (compact || e.button !== 0 || !doc?.lines.length) return
    /*
     * 触摸抬手后，浏览器会补发一整套鼠标事件（pointerType === 'mouse'）。
     * 这一套如果不拦：补发的 pointerdown 第一步就把 `movedRef` 重置成 false，
     * 紧接着的 click 就被当成「点了某一行」→ 跳播放位置。
     * 真机表现：滑一次歌词跳一次，滑几下就蹿到歌尾换下一首，下一首没歌词
     * 于是显示「暂无歌词」（用户原话：歌词滑不动，多滑几下就变成暂无歌词）。
     */
    if (e.pointerType === 'mouse' && Date.now() < tapGuard.current) return
    /* 惯性滑到一半又按住了：先刹住，从它当前的位置接着拖，不然手指一动位置就跳 */
    cancelAnimationFrame(flingRaf.current)
    pinRef.current = -1
    frozenFollow.current = followRef.current
    startRef.current = { y: e.clientY, base: dragRef.current }
    movedRef.current = false
    ptsRef.current = [{ y: e.clientY, t: performance.now() }]
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const s = startRef.current
    if (!s) return
    /* 速度采样：只留最近 20 个点（约 200~300ms），够算松手速度也够省 */
    const now = performance.now()
    const pts = ptsRef.current
    pts.push({ y: e.clientY, t: now })
    if (pts.length > 20) pts.shift()
    const dy = e.clientY - s.y
    if (!movedRef.current) {
      /*
       * 阈值给到 8：4px 太敏感，真机上手指刚放上去的那点抖动就把 movedRef
       * 立起来，紧接着的 click 会被当成「刚拖动过」吞掉——用户想点某一句
       * 跳转时反而没反应。
       */
      if (Math.abs(dy) < 8) return
      movedRef.current = true
      setDragging(true)
      cancelAnimationFrame(snapRaf.current)
      /* 跟手期间不能有过渡，否则文字追着手指跑、越滑越滞 */
      if (trackRef.current) trackRef.current.style.transition = 'none'
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
    }
    apply(s.base + dy)
  }

  const onPointerUp = (e?: React.PointerEvent) => {
    const wasDragging = movedRef.current
    startRef.current = null
    if (wasDragging) {
      setDragging(false)
      /* 拖动结束后浏览器还会补一个 click（落在松手时的那一行上）→ 直接跳到
         那行播放。用户滑动几下 = 连着跳几次 = 直接蹿到歌尾切下一首，
         下一首没歌词就变成「暂无歌词」。用时间戳再兜一层。 */
      tapGuard.current = Date.now() + 420
      /* 猛一甩：松手后按惯性继续滑（用户要的「手离开屏幕它还在滑」）。
         只给触摸：桌面鼠标拖拽松手就该停在原地，甩出去反而像失控。 */
      const v = e?.pointerType === 'touch' ? flingSpeed() : 0
      if (Math.abs(v) > 0.2) startFling(v)
      else hold()
      return
    }
    /*
     * 只是点了一下（没到 8px 阈值）：`onPointerDown` 已经把跟随基准冻住了，
     * 这里必须解冻，否则这一下之后歌词就再也不跟着播放换句了。
     */
    frozenFollow.current = null
    paint(clampOffset(followRef.current + dragRef.current))
  }

  /*
   * 点某一行跳转。
   *
   * 手动位移还在的时候直接 seek，视图会蹿到用户没点过的区域：follow 换成新当前句，
   * 位移却停在旧值上，整块歌词平移的量正好是「两句之差」——用户原话：「歌能正常
   * 跳转播放，但是歌词会跳转到其他歌词上」。所以先把位移改成「这一行居中」，
   * 等播放位置真的落到这一行（active 对上）再归零，全程视图最多滑过半屏。
   */
  const seekTo = useCallback((t: number) => {
    window.clearTimeout(holdTimer.current)
    cancelAnimationFrame(snapRaf.current)
    cancelAnimationFrame(flingRaf.current)   // 惯性滑行中点某一句：先刹住，再整段移过去
    /* 点行跳转是「对准某一行」的整段移动，该有过渡（拖动时被设成 none 了） */
    if (trackRef.current) trackRef.current.style.transition = ''
    frozenFollow.current = null
    const i = t >= 0 && doc ? indexAt(doc.lines, t) : -1
    if (i >= 0 && (dragRef.current !== 0 || i !== activeRef.current)) {
      pinRef.current = i
      apply(boxH / 2 - (i * rowH + rowH / 2) - followRef.current)
    } else {
      pinRef.current = -1
      apply(0)
    }
    onSeek?.(t)
    // seek 万一没生效（极少见），也要能自己回到当前句
    hold()
  }, [apply, doc, boxH, rowH, onSeek, hold])

  /*
   * KTV 染色（当前句）：整行从左往右被主题色"唱"过去，边界是软的。
   * 不用逐字换色——逐字换色在 250ms 快照下会一顿一顿，而且边界是硬的；
   * 连续渐变只改一个自定义属性，浏览器用 @property 过渡，观感是平滑的扫过。
   *
   * 注意：这段必须在上面两个条件 return 之前算完（hook 顺序不能变），
   * 否则「歌词加载完」那一刻 hook 数量变化，React 直接抛 #310。
   */
  const cur = doc && active >= 0 ? doc.lines[active] : null
  let kara = 0
  if (doc && cur && cur.time >= 0) {
    const chars = Array.from(cur.text).length
    const nx = doc.lines[active + 1]
    const span = lineSpan(chars, cur.time, nx ? nx.time : 0, 0)
    kara = Math.min(1, Math.max(0, (smooth + KARA_LAG - cur.time) / span))
  }
  /** 只有「当前句 + 有时间轴」才染色；无时间轴的歌词整行就是正文色 */
  const karaOn = active >= 0 && !!cur && cur.time >= 0

  /*
   * 染色进度直接写到 DOM。
   *
   * 为什么不用 React 传值：这个数每 33ms 变一次，一旦出现在 `rows` 的依赖里，
   * 整份歌词（可能上百行）就得跟着重建，长歌直接掉帧——这也是当初把 `--kara`
   * 挂在根节点、靠继承让所有行共享的原因。
   *
   * 但挂在根节点有个副作用（用户反馈的「换行时先染几个字又退回来」）：
   * 上一句唱到 1.0，换行那一刻新句继承到的还是 1.0，40ms 过渡把它拉回 0 的过程中
   * 新句就「亮一下再退掉」。所以现在只写在**当前那一行自己的** `.lyric-text` 上——
   * 新行没有继承值，天然从 0 起，不会再闪。
   */
  useEffect(() => {
    const el = boxRef.current?.querySelector<HTMLElement>('.lyric-text.kara')
    if (el) el.style.setProperty('--kara', kara.toFixed(4))
  }, [kara, active])

  /*
   * 长句不再靠省略号：按可用宽度把字号收下来。
   * 以前是 nowrap + text-overflow: ellipsis——一句 30 字会直接被吃掉半句，
   * 收字号虽然小一点，但整句读得全。参考字号取各场景里最大的那一档，
   * 算出来的缩放会偏保守（宁可小一点，也不要顶出去）。
   *
   * 播放页右栏例外（scrollOverflow）：那里要的是「字号稳定 + 唱到就滚」，
   * 一句 40 字要是缩到 0.5 倍，整块歌词的字号就会一行一个样，比滚动更难读。
   */
  const availW = Math.max(140, boxW * 0.94 - (immersive ? 56 : 34))
  const fitFor = (text: string, ref: number) => {
    if (scrollOverflow) return 1
    const w = visualWidth(text)
    if (w <= 0) return 1
    return Math.round(Math.max(0.5, Math.min(1, availW / (w * ref))) * 1000) / 1000
  }
  const refActive = immersive ? 34 : 20
  const refNormal = immersive ? 21 : 17

  /*
   * 手动滑动期间：标出「停在中间的这一行」——一条虚线 + 它的播放时间。
   * 主流播放器都这么做：滑动时用户是在看「后面会唱什么」，
   * 光看文字不知道那句是第几秒；而且滑走之后原「当前句」已经不在视线中心，
   * 得有个东西说明「现在对的准的是这一行」。
   *
   * 位移本身不参与渲染（apply 直接写 DOM），行号由 apply 在跨行时写进
   * `refRow`——所以这里不再算 offset / rawIdx。
   */
  const scrolling = !compact && !!doc && (dragging || refRow >= 0)
  const refLine = refRow >= 0 && doc ? doc.lines[refRow] : null

  /* 行列表本身不随播放进度变化：memo 住，染色靠直接改当前行上的 --kara */
  const rows = useMemo(() => (doc ? doc.lines.map((l, i) => (
    <LyricRow
      key={i}
      text={l.text}
      time={l.time}
      height={rowH}
      shown={i === shown}
      active={i === active}
      kara={karaOn && i === active}
      timed={timed}
      fit={fitFor(l.text, i === active ? refActive : refNormal)}
      isRef={i === refRow}
      onSeek={seekTo}
      movedRef={movedRef}
      tapGuard={tapGuard}
    />
  )) : null), [doc, shown, active, karaOn, rowH, timed, seekTo, availW, refActive, refNormal, refRow, scrollOverflow])

  if (loading) {
    return <div className={'lyrics ' + (compact ? 'compact ' : '') + (immersive ? 'immersive' : '')} ref={boxRef}>
      <div className="lyrics-empty">正在读取歌词…</div>
    </div>
  }

  if (!doc || !doc.lines.length) {
    return (
      <div className={'lyrics ' + (compact ? 'compact ' : '') + (immersive ? 'immersive' : '')} ref={boxRef}>
        <div className="lyrics-empty" data-searching={searching ? 'true' : undefined}>
          <div className="t">暂无歌词</div>
          <div className="s">已检查同名 .lrc 文件与内嵌歌词标签</div>
          {onSearchOnline && (searching ? (
            /* 点了「在线搜索歌词」才展开：歌名 / 歌手都能改，预填当前曲目 */
            <LyricSearchForm
              title={trackTitle ?? ''}
              artist={trackArtist ?? ''}
              onSubmit={q => { setSearching(false); onSearchOnline(q) }}
              onCancel={() => setSearching(false)}
            />
          ) : (
            <button className="ghost-btn" onClick={() => setSearching(true)}>
              <IconRefresh width={13} height={13} /> 在线搜索歌词
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className={'lyrics ' + (compact ? 'compact ' : '') + (immersive ? 'immersive ' : '') + (scrollOverflow ? 'wrap' : '')}
      ref={boxRef}
      data-dragging={dragging}
      /* 对齐 / 溢出滚动都交给 CSS：`data-align` 决定整行贴哪边，`data-wrap`
         打开「行内裁切 + 当前句横向平移」（位移量是下面的 --wrap-x） */
      data-align={align}
      data-wrap={scrollOverflow ? 'true' : undefined}
      /* 当前句确实溢出时，整行改成靠左起排：居中会让这句左右都被裁掉，
         开唱时连头一个字都看不见。靠左起排之后 0 → -溢出量 才是「从头看到尾」 */
      data-ov={scrollOverflow ? (ov > 0 ? 'true' : 'false') : undefined}
      data-scrolling={scrolling ? 'true' : 'false'}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      /* 长句横移放根节点（行是 memo 的，只有继承下来的变量在变）。
         染色进度**不能**放这里：它会被下一行继承走，换行时新句先亮一下再退掉，
         改成由上面的 effect 直接写在当前那一行上。 */
      style={{
        ['--wrap-x' as never]: `${wrapX.toFixed(1)}px`,
        /*
         * 纵向手势归 JS 自己算位移，别交给浏览器当滚动——
         * 一旦被判成滚动就会发 pointercancel，拖动直接断在第一步，
         * 随后补发的 click 又落到松手那一行上 → 跳播（真机上「歌词滑不动、
         * 多滑几下变成暂无歌词」就是这么来的：连着跳几次直接跳到歌尾换下一首）。
         */
        touchAction: 'pan-x',
      }}
      title="滚轮或按住拖动可翻歌词，松手后自动回到当前句"
    >
      <div
        className="lyrics-track"
        ref={trackRef}
        /* transform 由 apply / paint 直接写 DOM（见上面的注释）：
           这里一旦交回 React，每帧一次 render 就又回来了。 */
      >
        {rows}
      </div>
      {refLine && (
        <div className="lyric-ref" aria-hidden="true">
          <span className="lyric-ref-time num">{refLine.time >= 0 ? fmtTime(refLine.time) : '—'}</span>
          <i className="lyric-ref-rule" />
        </div>
      )}
      <div className="lyrics-source">
        {doc.source === 'lrc' ? '本地 .lrc' : doc.source === 'embedded' ? '内嵌歌词' : doc.source === 'online' ? '在线歌词 · lrclib' : ''}
        {!timed && ' · 无时间轴'}
      </div>
    </div>
  )
}
