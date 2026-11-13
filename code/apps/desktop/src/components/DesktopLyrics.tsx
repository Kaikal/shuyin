/**
 * 桌面歌词窗口（独立 WebView，挂在透明置顶窗口里）。
 *
 * 数据来源有两条，互为补位：
 *   1. 主窗口推来的文本（歌名/歌词行）——受主窗口节流影响，最小化时会变慢
 *   2. Rust 侧的 player://state 广播（250ms）——播放状态与进度永远准
 * 所以进度条和播放/暂停按钮用 2，歌词文本用 1，主窗口收进托盘也不会卡住。
 *
 * 逐字高亮：LRC 只给整行时间，字之间按字数均分（主窗口算好 lineStart / lineEnd 推过来）。
 * 300ms 一次的位置广播太粗，这里本地按时间插值，60ms 一格，字跟着唱。
 *
 * 交互：
 *   - 按住歌词拖动位置（超过 4px 才算拖，单击不会误触发）
 *   - 按住右边缘拖动改「宽窄」（窗口高度跟着字号走，不单独放开）
 *   - 滚轮调字号，悬停条上 A− / A+ 也能调
 *   - 悬停出控制条；锁定后鼠标穿透，解锁入口在托盘菜单的「锁定桌面歌词」
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { desktopLyrics, type LyricDocData, type LyricWindowData } from '../lib/desktopLyrics'
import { LYRIC_COLORS, lyricColorName, type LyricsColorId } from '../lib/lyricsColor'
import {
  LYRIC_FONT_MAX, LYRIC_GROW, clampFont, clampWidth, lyricWindowHeight, setLyricsLayout, useLyricsLayout,
} from '../lib/lyricsLayout'
import { indexAt, lineSpan } from '../lib/smoothClock'
import { bridge } from '../lib/bridge'
import { fillToWidth, trackToFill } from '../lib/textFit'
import { installGlobalDiagnostics } from '../lib/diag'
import { IconCheck, IconClose, IconLock, IconNext, IconPause, IconPlay, IconPrev, IconUnlock } from './icons'

/**
 * 字号不再固定：短句放大到铺满窗宽，长句缩到刚好放得下（酷狗桌面歌词就是这个手感）。
 * 只按字数缩、不折行——折行会破坏「上下一排」的结构。
 */
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * 染色的「时间提前量」（秒）。等于 `.dl-line` 上 `--q` 过渡的时长。
 *
 * CSS 过渡的稳态滞后量就是过渡时长本身，不抵消的话颜色永远比声音晚一截
 * （用户反馈的「染色有延迟」）。改 CSS 里的过渡时长要同步改这里。
 */
const Q_LAG = 0.045

/** 卡片内左右可用宽度：窗口 7px 透明边 ×2 + 左右各留 21px 呼吸位 */
const AVAIL_INSET = 56

/** 右边缘的拖拽热区宽度（px）。太窄的话鼠标一抖就滑出去了， resize 直接断手 */
const EDGE = 22

export function DesktopLyricsWindow() {
  const [data, setData] = useState<LyricWindowData | null>(null)
  /** 整份歌词：换句由本窗口自己按插值位置算，不跟着主窗口的 400ms 推送走 */
  const [doc, setDoc] = useState<LyricDocData | null>(null)
  const [locked, setLocked] = useState(false)
  const [hover, setHover] = useState(false)
  const [hint, setHint] = useState(false)
  /** 色板抽屉：直接点选一套配色，而不是「点一下切下一套」 */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [layout, setLayout] = useLyricsLayout()
  const [resizing, setResizing] = useState(false)
  const [live, setLive] = useState<{ playing: boolean; position: number; duration: number } | null>(null)
  /**
   * 点过播放键之后的「意图锁」。
   *
   * 只在真值跟意图**对上**时才撤。Rust 的 250ms 广播很可能先把命令落地之前
   * 那一帧旧状态送过来——一收到就撤锁的话，图标会被打回原样，
   * 用户看到的就是「点了暂停，声音停了但图标不切换」。
   * 反过来，命令真没生效（正在取链、播放器被回收）时 1.2 秒后自己松开，
   * 不会长期停在一个假的态上。
   */
  const [playWant, setPlayWant] = useState<{ v: boolean; until: number } | null>(null)
  /** 本地换色后的即时颜色（主窗口 400ms 后会用存档值对齐） */
  const [hlLocal, setHlLocal] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef(0)
  const showTimer = useRef(0)
  /** 展开延时是否已排上（pointermove 会一直触发，不能每次都重排） */
  const showPending = useRef(false)
  /** 指针是否在窗口里。`:hover` 在 WebView2 上会残留也会丢，只能当辅证 */
  const inside = useRef(false)
  /** 按下位置：超过阈值才算拖动，避免「点一下窗口就跟着鼠标跑」 */
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  /** 右边缘改宽的起点（起始指针 + 起始宽度 + 上一次落定的宽度） */
  const edgeDrag = useRef<{ x: number; w: number; last: number } | null>(null)
  const lastResize = useRef(0)
  /** 位置插值基准：最后一次广播的进度 + 到达时刻 */
  const clock = useRef({ pos: 0, at: 0, playing: false })
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useEffect(() => {
    installGlobalDiagnostics()
    const offData = desktopLyrics.onData(d => {
      setData(d)
      if (d.hl) setHlLocal(d.hl)
    })
    const offState = desktopLyrics.onPlayerState(s => {
      setLive(s)
      /* 真值跟意图一致 → 撤锁；相反就先留着（命令可能还在路上，见 playWant 注释） */
      setPlayWant(w => (w && s.playing === w.v ? null : w))
      clock.current = { pos: s.position, at: performance.now(), playing: s.playing }
    })
    const offLock = desktopLyrics.onLock(l => { setLocked(l); if (l) flashHint() })
    // 整份歌词：换歌 / 歌词加载完时推一次
    const offDoc = desktopLyrics.onDoc(d => setDoc(d))
    // 设置页拉动滑块时会推过来，跟着变（存档已由主窗口写好）
    const offLayout = desktopLyrics.onLayout(l => setLyricsLayout(l, false))

    // 恢复：上次是否锁定；字号与宽度由 useLyricsLayout 自己从存档读
    void desktopLyrics.isLocked().then(setLocked)

    // 主动要一次，避免歌词窗口后开时空白
    void desktopLyrics.sendAction('sync')
    return () => { offData(); offState(); offLock(); offDoc(); offLayout() }
  }, [])

  /* 宽高套到真实窗口上：字号变了高度跟着变，宽度变了不再单独调 */
  useEffect(() => {
    if (resizing) return
    void desktopLyrics.applyWindowSize(layout.width, lyricWindowHeight(layout.fontSize))
  }, [layout.width, layout.fontSize, resizing])

  /* 播放中才需要刷新逐字高亮：33ms 一格（≈30Hz），比 45ms 的过渡还密，看不出台阶 */
  const playing = playWant?.v ?? live?.playing ?? data?.playing ?? false
  /* 意图锁兜底：命令没生效时别让图标一直停在假的态上 */
  useEffect(() => {
    if (!playWant) return
    const id = window.setTimeout(
      () => setPlayWant(null),
      Math.max(0, playWant.until - performance.now()),
    )
    return () => window.clearTimeout(id)
  }, [playWant])
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => setTick(t => (t + 1) % 100000), 33)
    return () => window.clearInterval(id)
  }, [playing])

  /*
   * 浏览器预览用：桌面歌词窗口在 vite dev 里没有 Rust 事件通道，本来是整块空白，
   * 调样式时看不见任何字。这里塞一份假歌词 + 假时钟（只在 dev 构建里存在，
   * 打包时整段会被摇掉）。真机上永远走上面的 Tauri 事件。
   */
  useEffect(() => {
    if (bridge.isTauri || !import.meta.env.DEV) return
    const lines = [
      { time: 0, text: '我们把灯火留在身后' },
      { time: 5, text: '夜航向西 云层很薄' },
      { time: 10.2, text: '你数着座椅上的编号' },
      { time: 16.4, text: '说这是最后一次远行' },
      { time: 22.6, text: '风从舷窗的缝隙里穿过去' },
    ]
    setDoc({ key: 'dev', lines })
    setData({
      title: '夜航西飞', artist: '岛屿与海', playing: true,
      line: '', next: '', lineStart: 0, lineEnd: 0, progress: 0.3,
      hasLyrics: true, hl: LYRIC_COLORS[0].color, accent: '#7BA6FF', text: '#fff',
    })
    const start = performance.now()
    /** 起始时间可调（?t=19.3），方便把染色定格在句中看效果 */
    const from = Number(new URLSearchParams(location.search).get('t') || 10.4) || 10.4
    let last = -1
    const id = window.setInterval(() => {
      const p = from + (performance.now() - start) / 1000
      const sec = Math.floor(p)
      if (sec === last) return
      last = sec
      clock.current = { pos: p, at: performance.now(), playing: true }
      setLive({ playing: true, position: p, duration: 240 })
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  const flashHint = () => {
    setHint(true)
    window.setTimeout(() => setHint(false), 2800)
  }

  /* ---------- 悬停：按「最近一次交互」算显隐 ---------- */
  /*
   * 以前只有 mouseenter / mouseleave 一对事件 + 900ms 定时器，两个毛病：
   *   · 控制条出现、改字号、窗口被系统挪一下，WebView2 都会补一个 mouseleave，
   *     鼠标明明还压在字上，不到一秒背板就整块收掉——用户：「点了它还是隔几秒
   *     消失，不等我停手」；
   *   · 鼠标只是路过（桌面歌词常驻，拖别的窗口经常扫过）也整块亮一下，很吵。
   * 现在：进来先等 HOVER_INTENT，真的停住才展开（路过不闪）；任何按下 / 移动 /
   * 点击 / 滚轮都刷新时间戳，操作期间绝不收；到点前再看一眼指针还在不在
   * （leave 事件漏了也能兜一次）。
   */
  const HOVER_INTENT = 110
  const HIDE_AFTER = 2000

  const scheduleHide = (retry = 0) => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      /* 指针确实还在窗口里（多半马上要动手）：再给一轮，最多一轮。
         桌面歌词是常驻窗，背板永远挂着会挡住底下的东西 */
      if (retry < 1 && inside.current) { scheduleHide(retry + 1); return }
      setHover(false)
      setPaletteOpen(false)
    }, HIDE_AFTER)
  }

  /** 指针进来了（或窗口刚展开）：停住 HOVER_INTENT 才浮出背板 */
  const armShow = () => {
    /* 重复调用不重排：鼠标在窗口里慢慢挪的时候会一直触发 pointermove，
       每次都重排的话永远等不到那 110ms，背板就再也出不来了 */
    if (showPending.current) return
    showPending.current = true
    showTimer.current = window.setTimeout(() => {
      showPending.current = false
      if (inside.current) setHover(true)
    }, HOVER_INTENT)
  }
  const cancelShow = () => {
    showPending.current = false
    window.clearTimeout(showTimer.current)
  }

  const enterBar = () => {
    inside.current = true
    if (!hover) armShow()
    scheduleHide()
  }

  const leaveBar = () => {
    inside.current = false
    cancelShow()
    /* 拉边缘改宽时鼠标经常暂时滑出窗口——这时绝不能收背板，一收就看不见在拉什么 */
    if (edgeDrag.current) return
    scheduleHide()
  }

  /**
   * 任何一次交互都调一下：刷新「最后一次动手」的时间。
   * 点按往往先于 enter 到达（窗口小、鼠标一抖就出去了），所以这里也负责补展开。
   */
  const bump = () => {
    if (!hover) armShow()
    scheduleHide()
  }

  /* 卸载时别把定时器留在外面跑 */
  useEffect(() => () => {
    window.clearTimeout(hideTimer.current)
    window.clearTimeout(showTimer.current)
  }, [])

  /** 背板 / 控制条 / 进度条的显示条件：悬停、改宽中、色板开着，任一就算「在场」 */
  const present = hover || resizing || paletteOpen

  const toggleLock = async () => {
    const next = !locked
    setLocked(next)
    await desktopLyrics.setLocked(next)
    if (next) flashHint()
  }

  /** 改字号：窗口高度会跟着变（见上面的 effect），并同步给设置页 */
  const bumpFont = (d: number) => {
    const cur = layoutRef.current
    const next = clampFont(cur.fontSize + d)
    if (next === cur.fontSize) return
    setLayout({ fontSize: next })
    void desktopLyrics.pushLayout({ width: cur.width, fontSize: next, bg: cur.bg })
  }

  /** 改宽度（设置页滑块之外的两个入口：滚轮 Shift、控制条） */
  const bumpWidth = (d: number) => {
    const cur = layoutRef.current
    const next = clampWidth(cur.width + d)
    if (next === cur.width) return
    setLayout({ width: next })
    void desktopLyrics.pushLayout({ width: next, fontSize: cur.fontSize, bg: cur.bg })
  }

  /* 滚轮调字号；Shift + 滚轮调宽窄 */
  const onWheel = (e: React.WheelEvent) => {
    bump()
    if (locked) return
    const step = e.deltaY < 0 ? 2 : -2
    if (e.shiftKey) bumpWidth(e.deltaY < 0 ? 40 : -40)
    else bumpFont(step)
  }

  /* ---------- 右边缘改宽 ---------- */
  const onPointerDown = (e: React.PointerEvent) => {
    bump()
    if (locked || e.button !== 0) return
    const el = e.target as HTMLElement
    // 按钮/控制条自己处理，不要拖窗口
    if (el.closest('button, a, input, .dl-bar, .dl-swatches, .dl-x')) return
    if (window.innerWidth - e.clientX <= EDGE) {
      edgeDrag.current = { x: e.clientX, w: layoutRef.current.width, last: layoutRef.current.width }
      setResizing(true)
      /* 拉边全程保持背板在场：鼠标暂时滑出窗口也不会「背景消失、改不了宽」 */
      inside.current = true
      cancelShow()
      setHover(true)
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
      return
    }
    press.current = { x: e.clientX, y: e.clientY, dragging: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    bump()
    const rz = edgeDrag.current
    if (rz) {
      const w = clampWidth(rz.w + (e.clientX - rz.x))
      if (w === rz.last) return
      rz.last = w
      // 拖动过程中每帧都改：窗口尺寸和字重排一起走，才是「拉橡皮筋」的手感
      setLyricsLayout({ width: w }, false)
      // 尺寸 IPC 40ms 一次就够跟手了，太密会和系统窗口管理打架
      const t = performance.now()
      if (t - lastResize.current < 40) return
      lastResize.current = t
      void desktopLyrics.applyWindowSize(w, lyricWindowHeight(layoutRef.current.fontSize), false)
      return
    }
    const pr = press.current
    if (!pr || pr.dragging || locked) return
    if (Math.abs(e.clientX - pr.x) < 4 && Math.abs(e.clientY - pr.y) < 4) return
    pr.dragging = true
    void desktopLyrics.startDrag()
  }

  const endPress = () => {
    press.current = null
    const rz = edgeDrag.current
    if (rz) {
      edgeDrag.current = null
      setResizing(false)
      // 松手才落盘：拖动过程中每秒几十次写入会把存档写花
      setLayout({ width: rz.last })
      void desktopLyrics.pushLayout({ width: rz.last, fontSize: layoutRef.current.fontSize, bg: layoutRef.current.bg })
    }
    /* 拉宽的整个过程都强制「在场」，松手后按正常节拍收（指针要是还在窗口里，
       scheduleHide 会自己再等一轮） */
    scheduleHide()
  }

  /* ---------- 歌词行 + KTV 染色 ---------- */
  /*
   * 位置：Rust 每 250ms 广播一次，这里用「最后一次广播 + 流逝时间」自己往前走，
   * 60ms 刷新一格。不能直接按广播推进——250ms 一台阶，字会一顿一顿地亮。
   */
  const now = performance.now()
  const clk = clock.current
  const pos = clk.playing && playing ? clk.pos + (now - clk.at) / 1000 : clk.pos

  /*
   * 行由本窗口自己查（主窗口只在换歌时推一次整份歌词）：
   * 主窗口 400ms 推一次「当前是什么行」会让换句晚半拍，染色起点也跟着晚。
   */
  const local = (() => {
    const lines = doc?.lines
    if (!lines || !lines.length) return null
    const i = indexAt(lines, pos)
    if (i < 0) return null
    const cur = lines[i]
    const nx = lines[i + 1]
    return { i, cur, nx, span: lineSpan(Array.from(cur.text).length, cur.time, nx ? nx.time : 0, 0) }
  })()

  /* ---------- KTV 双行轮换 + 开唱倒计时 ---------- */
  /*
   * 经典 KTV 桌面歌词是上下两行轮着走：这一句唱上排、下一句唱下排，唱完换位。
   * 这里用「行序号奇偶」决定当前句落在上排还是下排——纯派生值，不需要额外状态。
   */
  const flip = !!local && local.i % 2 === 1

  /*
   * 开唱倒数。
   *
   * 用户的反馈是「不是每一句都要倒数」——之前只要下一句在 3 秒以外就倒数，
   * 而正常唱歌句间几乎都在 3 秒以上，于是每一句都在数，像在催。
   * 现在只在两种时候数：
   *   · 整首还没开口（前奏）
   *   · 这一句到下一句隔了 10 秒以上（间奏），且已经进入最后 8 秒
   * 而且**只在最后 8 秒内**出现，不是整段前奏从头数到尾。
   */
  const countdown = (() => {
    const lines = doc?.lines
    if (!lines || !lines.length) return null
    const i = indexAt(lines, pos)
    const nextT = i < 0 ? lines[0]?.time : lines[i + 1]?.time
    if (nextT == null) return null
    const d = nextT - pos
    if (d <= 0.2 || d > 8) return null
    if (i < 0) return d
    // 长间奏才数；正常换句那 3~5 秒直接显示下一句歌词
    return nextT - lines[i].time >= 10 ? d : null
  })()

  /*
   * 倒数用「点」而不是「♪ 3s」：这是用户在参考图里明确要的样子——
   * 一排圆点，每过一秒熄一颗，全部熄灭时正好开唱。
   * 最多 4 颗，所以「还有 8 秒」和「还有 5 秒」看着一样，够用且不吵。
   */
  const dotCount = countdown == null ? 0 : Math.min(4, Math.max(1, Math.ceil(countdown)))

  const line = local?.cur.text || data?.line || (data?.hasLyrics ? '♪' : (data?.title || '疏音'))
  // 次行：倒数点优先，其次「下一句」，没有下一句才退回歌手名——绝不塞假文案
  const sub = (local ? local.nx?.text : data?.next) || data?.artist || ''
  const progress = live && live.duration > 0
    ? Math.min(1, Math.max(0, live.position / live.duration))
    : (data?.progress ?? 0)

  const hl = hlLocal || data?.hl || LYRIC_COLORS[0].color
  const hlId: LyricsColorId =
    (LYRIC_COLORS.find(c => c.color.toLowerCase() === hl.toLowerCase()) ?? LYRIC_COLORS[0]).id

  const hasLyrics = !!local || !!data?.hasLyrics
  const lineStart = local ? local.cur.time : (data?.lineStart ?? 0)
  const span = Math.max(0.6, local ? local.span : (data?.lineEnd ?? 0) - (data?.lineStart ?? 0))
  /**
   * 0~1：这一行唱到哪儿了。KTV 染色就是靠它把整行从左往右「推」过去。
   *
   * 加上 Q_LAG 是为了抵消 CSS 的过渡滞后：`.dl-line` 上有 45ms 的 `--q` 线性过渡，
   * 它的稳态滞后正好是一个过渡时长，于是颜色总比声音晚 45ms（用户反馈「染色有延迟」）。
   * 把算进度用的位置往前送同样的时间，眼睛看到的就和耳朵对上了。改 CSS 要同步改这里。
   */
  const ratio = hasLyrics ? clamp01((pos + Q_LAG - lineStart) / span) : 0

  /*
   * 字号按「可用宽度 ÷ 视觉字宽」算：短句会放大（最多 LYRIC_GROW 倍基准），
   * 长句缩到刚好放得下。字号被上限卡住时，剩下的宽度摊到字缝里（trackToFill），
   * 这样窗口拉宽以后句子是真的铺开了——而不是一大块底板中间一小撮字。
   */
  const avail = Math.max(160, layout.width - AVAIL_INSET)
  const mainSize = fillToWidth(line, layout.fontSize, avail, { maxGrow: LYRIC_GROW, maxFont: LYRIC_FONT_MAX, minRatio: 0.6 })
  const tracking = trackToFill(line, mainSize, avail, 0.32)
  /*
   * 次行（还没唱的那句）的字号。
   *
   * 基准**必须挂在主行上**，不能挂在 `layout.fontSize` 上：主行会被 `fillToWidth`
   * 放大到铺满宽度（短句常常涨到 1.5 倍），而 `layout.fontSize` 只是用户设的那档，
   * 于是「基准乘 0.52」实际出来只有 11px，跟 34px 的主行差了三倍——
   * 用户反馈「大小差太多，轮换着太抢眼，影响工作」。
   * 现在按主行的 0.68 起算、上限 0.78，长句仍然缩到放得下，但两排始终差不到三成。
   */
  const subSize = Math.min(mainSize * 0.78, fillToWidth(sub, mainSize * 0.68, avail, { maxGrow: 1.15, minRatio: 0.32 }))
  const subTracking = trackToFill(sub, subSize, avail, 0.34)

  /*
   * 长句跑马灯（当前句）。
   *
   * 以前这里的策略是「缩字号硬塞」：`fillToWidth` 的 minRatio 是 0.6，缩到底还有
   * 一句 30 多字放不下，就被 `.dl-line` 的 `overflow: hidden` 直接裁掉——用户原话
   * 「超出去的歌词就看不见了」。桌面歌词是常驻看的，裁掉半句等于漏词。
   *
   * 现在和播放页同一套：字号不动，**唱到哪个字就横向推到哪个字**（位移量 `--dl-x`，
   * 0 → -溢出量）。歌词窗口窄（默认 620），主行字号 32，一句 20 字就是 640px——
   * 这属于常见情况，不是极端长句。
   *
   * 溢出量实测 DOM（`.dl-line` 在这套样式里是 `width: max-content`，量到的是自然宽度），
   * 不按字数估：`visualWidth` 对拉丁字母偏小，估少了最后几个字永远滚不出来。
   * 换句时字号有 180ms 的 `dl-grow` 动画（起点是本位的九成），立刻量会偏小，240ms 后补量一次。
   */
  const lineRef = useRef<HTMLDivElement>(null)
  const [ov, setOv] = useState(0)
  /**
   * 量「这一句超出了多少」。
   *
   * 基准取**裁切层的宽度**，不是 `layout.width - AVAIL_INSET`：
   * 后者只是按窗口尺寸估的，一旦窗口被系统缩放 / body 内边距变了，
   * 估出来的可用宽度和真实排版对不上，溢出的判定就整个偏掉。
   */
  const measure = useCallback(() => {
    const el = lineRef.current
    const clip = el?.parentElement
    if (!el || !clip) { setOv(0); return }
    setOv(Math.max(0, Math.round(el.offsetWidth - clip.clientWidth)))
  }, [])
  useLayoutEffect(() => {
    const el = lineRef.current
    const clip = el?.parentElement
    if (!el || !clip) { setOv(0); return }
    measure()
    /*
     * 窗口宽度变化不会经过 React（Rust 侧直接 resize），只靠 `avail` 这个依赖
     * 是接不住的——那头一改，这里量到的还是旧宽度，长句就永远不滚。
     * 盯住裁切层自己的尺寸，谁改的都能收到。
     */
    const ro = new ResizeObserver(measure)
    ro.observe(clip)
    ro.observe(el)
    /* 换句时字号有 180ms 的 grow 动画（起点是本位的九成），立刻量到的宽度偏小 */
    const t = window.setTimeout(measure, 240)
    return () => { ro.disconnect(); window.clearTimeout(t) }
  }, [line, mainSize, tracking, measure])
  /** 横移量：唱到 100% 时末尾刚好露出来 */
  const wrapX = ov > 0 ? -ov * ratio : 0
  /*
   * 换句动画的起点字号。
   *
   * 换句不再让大字淡入（那会让整个窗口先空一下），而是让字号从略小涨到本位，
   * 视觉上是「这一句升上来」而不是「换了一行」。
   * 起点只取本位的 **0.9**：次行现在本来就有主行的七成多，再从它的真实尺寸起步
   * 会变成一次明显的缩放，桌面歌词是常驻置顶窗口，每句都缩放会一直打断视线。
   */
  const growFrom = Math.min(mainSize, Math.max(subSize, mainSize * 0.9))

  return (
    <div
      ref={rootRef}
      className="dl"
      data-locked={locked}
      data-resizing={resizing}
      data-hover={present}
      data-present={present}
      style={{ ['--dl-bg' as never]: layout.bg }}
      onPointerEnter={enterBar}
      onPointerLeave={leaveBar}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onDoubleClick={e => {
        /*
         * 双击回主窗口，但**必须排除控制条 / 色板**：
         * 连点两次换色按钮（或换色 + 锁定）会被浏览器识别成 dblclick，
         * 结果歌词没换色，主窗口反倒被弹到前面来了。
         */
        const t = e.target as HTMLElement
        if (t.closest('.dl-bar, .dl-swatches, .dl-x, button')) return
        void desktopLyrics.showMain()
      }}
    >
      <div
        className="dl-body"
        title={locked
          ? '已锁定（托盘菜单可解锁）'
          : '拖动移动 · 右边缘拖动改宽 · 滚轮调字号（Shift+滚轮改宽）· 双击回主窗口'}
      >
        {/* KTV 双行：当前句与下一句上下轮换（行序号奇偶决定谁在上），
            间奏时下排显示「开唱倒计时」。交错的对角排版保留。 */}
        <div className="dl-lines" data-flip={flip ? 'true' : 'false'}>
          {/* 裁切层：文字块量到的是自然宽度（`width: max-content`），超出窗口的部分
              由这一层裁掉，当前句再按演唱进度横移（`--dl-x`）。不包这层的话，
              `overflow: hidden` 只能挂在 `.dl-line` 自己身上，而它一旦被压到
              100% 宽就量不出「到底超了多少」。 */}
          <div className="dl-clip" data-ov={ov > 0 ? 'true' : 'false'}>
            <div
              className="dl-line"
              ref={lineRef}
              key={'a' + line + (flip ? 'f' : '')}
              style={{
                fontSize: mainSize,
                letterSpacing: tracking ? tracking + 'px' : undefined,
                marginRight: tracking ? -tracking : undefined,
                /* 唱到哪儿：0~1，CSS 用它切渐变（@property 注册过，可以平滑过渡） */
                ['--q' as never]: Math.round(ratio * 1000) / 1000,
                ['--dl-hl' as never]: hl,
                /* 换句动画的起点：本位的九成（幅度小才不抢眼，见 growFrom 注释） */
                ['--dl-from' as never]: growFrom.toFixed(1) + 'px',
                /* 长句横移：唱完这一句正好把最后一个字推到窗口右边缘 */
                ['--dl-x' as never]: wrapX.toFixed(1) + 'px',
              }}
            >
              {line}
            </div>
          </div>
          <div className="dl-clip">
            <div
              className={'dl-sub' + (countdown != null ? ' counting' : '')}
              key={'b' + (countdown != null ? `d${dotCount}` : sub)}
              style={{
                fontSize: subSize,
                letterSpacing: subTracking ? subTracking + 'px' : undefined,
                marginRight: subTracking ? -subTracking : undefined,
              }}
            >
              {countdown != null
                ? (
                  /* 倒数点：不占文字位置，用固定尺寸的点排，避免跟着字号缩放变得巨大 */
                  <span className="dl-dots" role="timer" aria-label={`还有 ${Math.ceil(countdown)} 秒开唱`}>
                    {Array.from({ length: dotCount }, (_, i) => <i key={i} />)}
                  </span>
                )
                : (sub || '\u00a0')}
            </div>
          </div>
        </div>
      </div>

      <div className="dl-progress" aria-hidden="true">
        <i style={{ width: progress * 100 + '%' }} />
      </div>

      {/* 右边缘：按住就能拉宽（窗口无边框，这是唯一的「拖边」入口） */}
      {!locked && <div className="dl-grip" aria-hidden="true" title="拖动调整宽度" />}

      {/* 关闭放右上角独立一格：和播放控制混在一排里，想关的时候总点错。
          常驻渲染 + data-show 过渡，而不是 `hover && …` 硬切——原来鼠标一进来
          这颗钮「啪」地出现，是「很生硬」的主要来源之一 */}
      {!locked && (
        <button
          className="dl-x"
          data-show={present}
          aria-label="关闭桌面歌词"
          title="关闭桌面歌词"
          aria-hidden={!present}
          tabIndex={present ? 0 : -1}
          onClick={() => void desktopLyrics.sendAction('close')}
        >
          <IconClose width={12} height={12} />
        </button>
      )}

      {/* 色板：悬在歌词上方，六套配色一眼看全，点哪个是哪个 */}
      {!locked && paletteOpen && (
        <div className="dl-swatches" role="listbox" aria-label="歌词配色">
          {LYRIC_COLORS.map(c => {
            const on = c.id === hlId
            return (
              <button
                key={c.id}
                role="option"
                aria-selected={on}
                className={'dl-sw' + (on ? ' on' : '')}
                title={c.name}
                onClick={() => {
                  setHlLocal(c.color)
                  void desktopLyrics.sendAction('color', { id: c.id })
                  setPaletteOpen(false)
                }}
              >
                <i style={{ background: c.color }} />
                {on && <IconCheck width={10} height={10} />}
              </button>
            )
          })}
        </div>
      )}

      {!locked && (
        <div className="dl-bar" data-show={present}>
          <button className="dl-btn" aria-label="上一首" onClick={() => void desktopLyrics.sendAction('prev')}>
            <IconPrev width={16} height={16} />
          </button>
          <button className="dl-btn dl-play" aria-label={playing ? '暂停' : '播放'}
            onClick={() => {
              /*
               * 先就地翻面（意图锁），再发命令。
               *
               * 图标原来只认 Rust 推来的 250ms 快照。暂停后位置不动、歌词也不变，
               * 加上命令往返的几十毫秒里有整整一帧还是旧值，按下去声音停了、
               * 键还停在 ⏸（用户：「点击暂停，确实会暂停，但是图标不会切换」）。
               * 这里先翻，真值跟上才撤锁，所以命令失败也只是 1.2 秒后自己弹回去。
               */
              setPlayWant({ v: !playing, until: performance.now() + 1200 })
              void desktopLyrics.sendAction('playpause')
            }}>
            {/* key 换一个 → 图标重新挂载，走一次 200ms 的淡入缩小，
                比原地硬换 SVG 柔和；两态之间不会闪空 */}
            <span className="dl-ico" key={playing ? 'p' : 's'}>
              {playing ? <IconPause width={18} height={18} /> : <IconPlay width={18} height={18} />}
            </span>
          </button>
          <button className="dl-btn" aria-label="下一首" onClick={() => void desktopLyrics.sendAction('next')}>
            <IconNext width={16} height={16} />
          </button>
          <span className="dl-vline" aria-hidden="true" />
          <button className="dl-btn dl-aa" aria-label="字号减小" title="字号减小"
            onClick={() => bumpFont(-2)}>
            <span style={{ fontSize: 11 }}>A−</span>
          </button>
          <button className="dl-btn dl-aa" aria-label="字号增大" title="字号增大"
            onClick={() => bumpFont(2)}>
            <span style={{ fontSize: 14 }}>A+</span>
          </button>
          <span className="dl-vline" aria-hidden="true" />
          <button
            className={'dl-btn dl-color' + (paletteOpen ? ' on' : '')}
            aria-label="选择歌词颜色"
            aria-expanded={paletteOpen}
            title={`歌词颜色：${lyricColorName(hlId)}（点开直接选）`}
            onClick={() => setPaletteOpen(o => !o)}
          >
            <i style={{ background: hl }} />
          </button>
          <button className="dl-btn" aria-label="锁定桌面歌词（鼠标穿透）" title="锁定后背景全透明、鼠标穿透"
            onClick={() => void toggleLock()}>
            <IconUnlock width={15} height={15} />
          </button>
        </div>
      )}

      {locked && hint && <div className="dl-hint">已锁定 · 托盘菜单可解锁</div>}

      {locked && !hint && (
        <button className="dl-lock-flag" aria-label="锁定中" title="桌面歌词已锁定（托盘菜单可解锁）">
          <IconLock width={12} height={12} />
        </button>
      )}
    </div>
  )
}
