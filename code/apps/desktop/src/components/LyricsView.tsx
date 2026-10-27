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
  /** 长句溢出时横向滚动（替代缩字号）。播放页右栏打开 */
  scrollOverflow?: boolean
}

const ROW_H = 42
/** 沉浸式：行距要撑开，不然整屏只有小小几行字，压不住场 */
const ROW_H_IMM = 76
/** 用户操作后，多久恢复自动跟随 */
const HOLD_MS = 2400
/** 与 `.imm-lyric .lyric-line { padding: 0 10px }` 对齐：算可用宽度要扣掉两侧 */
const ROW_PAD = 10
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
  text, time, height, active, shown, kara, timed, fit, isRef, onSeek, movedRef,
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
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxH, setBoxH] = useState(360)
  const [boxW, setBoxW] = useState(640)
  /** 空态里「在线搜索歌词」点开后的搜索表单（歌名 / 歌手可改）；不常显 */
  const [searching, setSearching] = useState(false)
  const rowH = immersive ? ROW_H_IMM : ROW_H

  /**
   * 位置快照 250ms 一跳，直接拿它上色会「一顿一顿」并且看起来慢半拍。
   * 这里插值成 ~30Hz 的连续时间，染色才跟得上耳朵。
   * （原来 15Hz：33ms 一格配 40ms 过渡才看不出台阶；15Hz 会露馅。）
   */
  const smooth = useSmoothTime(currentTime, 30)

  /** 用户额外位移（正值 = 内容下移，即往回看） */
  const [drag, setDrag] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(0)
  const holdTimer = useRef(0)
  const snapRaf = useRef(0)
  const startRef = useRef<{ y: number; base: number } | null>(null)
  const movedRef = useRef(false)
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
    const avail = box.clientWidth - ROW_PAD * 2
    const read = () => setOv(Math.max(0, Math.round(text.getBoundingClientRect().width - avail)))
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

  const apply = useCallback((v: number) => {
    const f = followRef.current
    const c = clampOffset(f + v) - f
    dragRef.current = c
    setDrag(c)
  }, [clampOffset])

  /** 缓动归零：回到自动跟随当前行 */
  const snapBack = useCallback(() => {
    cancelAnimationFrame(snapRaf.current)
    const step = () => {
      const cur = dragRef.current
      if (Math.abs(cur) < 0.6) { apply(0); return }
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

  useEffect(() => () => {
    window.clearTimeout(holdTimer.current)
    cancelAnimationFrame(snapRaf.current)
  }, [])

  /** 点击跳转后：播放位置真的落到那一行，就把位移归零（见 seekTo） */
  useLayoutEffect(() => {
    if (pinRef.current >= 0 && active === pinRef.current) {
      pinRef.current = -1
      dragRef.current = 0
      setDrag(0)
    }
  }, [active])

  const onWheel = (e: React.WheelEvent) => {
    // 紧凑模式（详情面板）里歌词跟着面板滚，不抢滚轮
    if (compact || !doc?.lines.length) return
    // 沉浸式页本身 overflow:hidden，滚轮不会传导，直接接管
    pinRef.current = -1   // 用户又动手了，点击的锚点作废
    apply(dragRef.current - e.deltaY * 1.15)
    hold()
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (compact || e.button !== 0 || !doc?.lines.length) return
    pinRef.current = -1
    startRef.current = { y: e.clientY, base: dragRef.current }
    movedRef.current = false
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const s = startRef.current
    if (!s) return
    const dy = e.clientY - s.y
    if (!movedRef.current) {
      if (Math.abs(dy) < 4) return
      movedRef.current = true
      setDragging(true)
      cancelAnimationFrame(snapRaf.current)
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
    }
    apply(s.base + dy)
  }

  const onPointerUp = () => {
    const wasDragging = movedRef.current
    startRef.current = null
    if (wasDragging) {
      setDragging(false)
      hold()
    }
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
   * 这里再钳一次：拖动/滚轮只在「动手那一刻」钳过，而 follow 随播放一直变，
   * 用户停在后半段时不钳，视图会跟着漂进末尾的空白里。
   */
  const offset = clampOffset(follow + drag)
  /*
   * 参考线只在「确实有一行落在中线上」时出现。
   * 滑到最前/最后时，中线会落到空白处——这时硬标一个行号（还带着时间）
   * 反而误导人：屏幕中间明明什么都没有。
   */
  const rawIdx = Math.floor((boxH / 2 - offset) / rowH)
  const scrolling = drag !== 0 && !compact && !!doc
  const refIdx = scrolling && doc && rawIdx >= 0 && rawIdx < doc.lines.length ? rawIdx : -1
  const refLine = refIdx >= 0 && doc ? doc.lines[refIdx] : null

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
      isRef={i === refIdx}
      onSeek={seekTo}
      movedRef={movedRef}
    />
  )) : null), [doc, shown, active, karaOn, rowH, timed, seekTo, availW, refActive, refNormal, refIdx, scrollOverflow])

  if (loading) {
    return <div className={'lyrics ' + (compact ? 'compact ' : '') + (immersive ? 'immersive' : '')} ref={boxRef}>
      <div className="lyrics-empty">正在读取歌词…</div>
    </div>
  }

  if (!doc || !doc.lines.length) {
    return (
      <div className={'lyrics ' + (compact ? 'compact ' : '') + (immersive ? 'immersive' : '')} ref={boxRef}>
        <div className="lyrics-empty">
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
      style={{ ['--wrap-x' as never]: `${wrapX.toFixed(1)}px` }}
      title="滚轮或按住拖动可翻歌词，松手后自动回到当前句"
    >
      <div
        className="lyrics-track"
        style={{
          transform: `translateY(${offset}px)`,
          // 拖拽时必须关掉过渡，否则手指和文字不同步
          transition: dragging ? 'none' : 'transform 320ms var(--sy-ease-panel)',
        }}
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
