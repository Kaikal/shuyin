/**
 * 应用根组件：启动页 → 主界面（侧栏 + 页面 + 播放条 + 队列抽屉 + 详情面板 + 沉浸式播放页）。
 * 启动页不阻塞初始化：主题/曲库加载在 Provider 内并行进行。
 *
 * 交互与主流播放器对齐：
 *   点播放条封面/标题 → 展开沉浸式播放页（不再单独做一个「正在播放」标签页）
 *   侧栏只有 本地音乐 / 导入歌单 / 设置
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { activeLyricIndex, type LocalTrack } from '@shuyin/core'
import { Splash } from './components/Splash'
import { TitleBar } from './components/TitleBar'
import { PlayBar, QueueDrawer, Sidebar, type Page } from './components/Shell'
import { TrackDetail } from './components/TrackDetail'
import { ImmersivePlayer } from './components/ImmersivePlayer'
import { SpectrumEdges } from './components/SpectrumLayer'
import { HomePage } from './pages/HomePage'
import { LibraryPage } from './pages/LibraryPage'
import { LocalPlaylistPage } from './pages/LocalPlaylistPage'
import { SearchPage } from './pages/SearchPage'
import { PlaylistSquarePage } from './pages/PlaylistSquarePage'
import { PlaylistDetailPage } from './pages/PlaylistDetailPage'
import type { PlatformSource } from '@shuyin/lx-provider'
import { PlaylistImportPage } from './pages/PlaylistImportPage'
import { SettingsPage } from './pages/SettingsPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { usePlayer } from './lib/PlayerProvider'
import { useSpectrumStyle } from './lib/spectrumStyle'
import { useSpectrumPos } from './lib/spectrumPos'
import { useTheme } from './lib/ThemeProvider'
import { bridge, isAndroid } from './lib/bridge'
import { useShell } from './lib/shellMode'
import { setBackHandler } from './lib/native/android'
import { desktopLyrics } from './lib/desktopLyrics'
import { musicDesk } from './lib/musicDesk'
import { coverUrlOf } from './lib/coverUrl'
import { syncFullscreen, toggleFullscreen } from './lib/fullscreen'
import { trayMenu } from './lib/trayMenu'
import { lyricColorValue, setLyricColor, useLyricColor, type LyricsColorId } from './lib/lyricsColor'
import { getLyricsLayout, setLyricsLayout } from './lib/lyricsLayout'
import { KEYS, settings } from './lib/settings'
import { toggleMainWindow, useGlobalHotkeys } from './lib/hotkeys'
import { ToastHost } from './components/ToastHost'
import { ConfirmHost } from './components/ConfirmHost'
import { UpdateDialog } from './components/UpdateDialog'
import { autoCheckUpdate, openDownload, skipVersion, type UpdateInfo } from './lib/update'

/**
 * 一个在线歌单的定位信息（平台 + id + 名字）。
 *
 * `id` 也可能是 `rank:xxx`（排行榜）——平台层用前缀分流，上层不用区分。
 * `cover` 只是兜底：有的平台详情接口不回封面（酷狗榜单），拿列表里那一份顶上。
 */
type PlRef = { source: PlatformSource; id: string; name: string; cover?: string }

export function App() {
  const th = useTheme()
  /** 形态：桌面 / 平板 / 手机 / 车机（见 lib/shellMode.ts） */
  const shell = useShell()
  const p = usePlayer()
  const [showSplash, setShowSplash] = useState(true)
  const [firstLaunch, setFirstLaunch] = useState<boolean | null>(null)
  const [page, setPage] = useState<Page>('home')
  /** 正在看的本地歌单（在「我的」之上打开） */
  const [localPl, setLocalPl] = useState<string | null>(null)
  /** 「我的」里点开本地音乐横条后，曲库作为子页打开 */
  const [homeLib, setHomeLib] = useState(false)
  /**
   * 在线歌单详情。`from` 记住「从哪儿点进来的」：
   * 搜索页点进来返回搜索页，；「我的 → 收藏的歌单」点进来返回「我的」——
   * 以前两种入口都走 nav('search')，用户点了自己收藏的歌单会被甩到在线搜索页。
   * v0.5.5 起又多了一个 `square`：歌单广场里点开的歌单，返回时回广场（不是搜索页）。
   */
  const [onlinePl, setOnlinePl] = useState<(PlRef & { from: 'home' | 'search' | 'square' }) | null>(null)
  const homeDetail = onlinePl?.from === 'home' ? onlinePl : null
  const searchDetail = onlinePl?.from === 'search' ? onlinePl : null
  const squareDetail = onlinePl?.from === 'square' ? onlinePl : null
  /** 歌单广场 → 「导入歌单」：导入页现在挂在广场下面，不再是侧栏独立入口 */
  const [plImport, setPlImport] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [detail, setDetail] = useState<LocalTrack | null>(null)
  const [nowOpen, setNowOpen] = useState(false)
  /** 有新版本时这里放更新信息，弹窗就靠它开 */
  const [upd, setUpd] = useState<UpdateInfo | null>(null)
  const [specStyle] = useSpectrumStyle()
  const [specPos] = useSpectrumPos()
  /* 顶部频谱是覆盖层，内容区得往下让一截，否则会压住页面大标题 */
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--sy-sedge-top',
      specPos === 'top' ? '28px' : '0px',
    )
  }, [specPos])
  const [lyricsOn, setLyricsOn] = useState(false)
  const [lyricColor] = useLyricColor()
  /** 上次停留的页面（启动后恢复） */
  const pageHydrated = useRef(false)
  const nav = useCallback((p: Page) => {
    pageHydrated.current = true
    // 换页时收起本地歌单详情：它挂在「我的」上面
    if (p !== 'home') {
      setLocalPl(null)
      setHomeLib(false)
    }
    // 挂在某个页面「上面」的在线歌单详情，离开那个页面就一并收起，
    // 回来还是干净的列表页（以前只处理了「我的」，广场的详情会残留）
    setOnlinePl(v => (v && (v.from === 'home' || v.from === 'square') ? null : v))
    // 点侧栏「歌单广场」永远回到广场首页，不要停在「导入歌单」子页
    setPlImport(false)
    setPage(p)
    void settings.set(KEYS.uiPage, p)
  }, [])
  /** 播放器上下文每次快照刷新都会变，事件监听里通过 ref 取最新值 */
  const pRef = useRef(p)
  pRef.current = p
  const toggleLyricsRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    // 关键：这里绝不能让异常冒出去——firstLaunch 卡在 null 会让整个界面渲染成空白页。
    let alive = true
    const watchdog = window.setTimeout(() => {
      // 兜底：存储层若卡住（插件未就绪 / 文件锁），1.2s 后按「非首次启动」继续
      if (alive) setFirstLaunch(v => v ?? false)
    }, 1200)
    ;(async () => {
      let launched = false
      try {
        launched = !!(await settings.get<boolean>(KEYS.launched))
      } catch (e) {
        console.warn('[疏音] 读取设置失败，按首次启动处理', e)
      }
      if (!alive) return
      window.clearTimeout(watchdog)
      setFirstLaunch(!launched)
      if (!launched) {
        settings.set(KEYS.launched, true).catch(() => { /* 写不进去也不该拦住启动 */ })
      }
    })()
    return () => { alive = false; window.clearTimeout(watchdog) }
  }, [])

  /* 上次停在哪个页面，这次继续停在那里 */
  useEffect(() => {
    void settings.get<string>(KEYS.uiPage).then(v => {
      // 在线歌单详情不参与恢复：它依赖一次网络请求，开局弹出来会很突兀
      // v0.5 起「本地音乐」并进「我的」：老存档里的 library 映射过去
      const next = v === 'library' ? 'home' : v
      if (!pageHydrated.current && (next === 'home' || next === 'search' || next === 'playlist' || next === 'downloads' || next === 'settings')) setPage(next)
      pageHydrated.current = true
    })
  }, [])

  /* 全屏状态启动时对齐一次（上次退出时若在全屏，进来按钮图标要一致） */
  useEffect(() => { void syncFullscreen() }, [])

  /* 窗口最小尺寸（1120×680，按 CSS px 算）。
     Tauri's min_inner_size 用的是系统逻辑缩放（这台机器 1.5），而 webview 的
     devicePixelRatio 是 1.71 —— 两者不等，直接用逻辑值算出来的下限比布局需要的小一截，
     窗口还是能拖到把两列挤扁。所以下限由前端上报 dpr，后端按物理像素设。 */
  useEffect(() => {
    const t = window.setTimeout(() => {
      void bridge.invoke('apply_min_size', { dpr: window.devicePixelRatio }).catch(() => { /* ignore */ })
    }, 600)
    return () => window.clearTimeout(t)
  }, [])

  /* ---------- 桌面歌词 ---------- */

  const openLyrics = useCallback(async () => {
    await desktopLyrics.open()
    setLyricsOn(true)
    void settings.set(KEYS.lyricsOn, true)
  }, [])

  const closeLyrics = useCallback(async () => {
    await desktopLyrics.hide()
    setLyricsOn(false)
    void settings.set(KEYS.lyricsOn, false)
  }, [])

  const toggleLyrics = useCallback(async () => {
    if (lyricsOn) await closeLyrics()
    else await openLyrics()
  }, [lyricsOn, openLyrics, closeLyrics])

  /* 上次开着桌面歌词，这次启动继续开着 */
  useEffect(() => {
    void settings.get<boolean>(KEYS.lyricsOn).then(v => { if (v) void openLyrics() })
  }, [openLyrics])

  /* 主窗口 → 歌词窗口：400ms 推一次，行切换与进度都能跟上 */
  const liveRef = useRef({ p, th, hl: lyricColor })
  liveRef.current = { p, th, hl: lyricColor }
  useEffect(() => {
    if (!lyricsOn) return
    const send = () => {
      const { p: pl, th: theme, hl } = liveRef.current
      const t = pl.current
      const lines = pl.lyrics?.lines ?? []
      const i = lines.length ? activeLyricIndex(lines, pl.snapshot.position) : -1
      const dur = pl.snapshot.duration || t?.duration || 0
      const cur = i >= 0 ? lines[i] : null
      const nx = i >= 0 ? lines[i + 1] : undefined
      /*
       * 逐字高亮的节奏：LRC 只有整行时间，字与字之间按字数均分。
       * 「正常一句唱多久」按字数估（0.34s/字，夹在 2~8 秒）；
       * 实际间隔夹在「估值 ~ 2.4 倍估值」之间取：下一句离得近就唱满整段，
       * 隔得太远（长间奏）也只慢到 2.4 倍，不会一路爬到天荒地老。
       */
      const chars = cur ? Array.from(cur.text).length : 0
      const est = Math.min(8, Math.max(2, chars * 0.34))
      const lineStart = cur?.time ?? 0
      const gap = cur ? (nx ? nx.time - lineStart : (dur > lineStart ? dur - lineStart : 0)) : 0
      const span = gap > 0 ? Math.min(Math.max(gap, est), est * 2.4) : est
      const lineEnd = cur ? lineStart + span : 0
      void desktopLyrics.push({
        title: t?.title ?? '',
        artist: t?.artist ?? '',
        playing: pl.snapshot.playing,
        line: cur?.text ?? '',
        next: nx?.text ?? '',
        lineStart,
        lineEnd,
        progress: dur > 0 ? Math.min(1, pl.snapshot.position / dur) : 0,
        hasLyrics: lines.length > 0,
        hl: lyricColorValue(hl),
        accent: theme.tokens.accent,
        text: theme.tokens.textPrimary,
      })
    }
    send()
    const id = window.setInterval(send, 400)
    return () => window.clearInterval(id)
  }, [lyricsOn])

  /*
   * 换歌 / 歌词变化 → 推一次整份歌词。
   * 桌面歌词窗口自己按「插值后的位置」查行，换句不再跟着这 400ms 的推送走，
   * 否则歌词窗口换句最多晚 0.4 秒，染色自然也就慢半拍。
   */
  const pushDoc = useCallback(() => {
    const pl = pRef.current
    const t = pl.current
    const lines = (pl.lyrics?.lines ?? []).map(l => ({ time: l.time, text: l.text }))
    void desktopLyrics.pushDoc({ key: t?.id ?? '', lines })
  }, [])
  useEffect(() => {
    if (!lyricsOn) return
    pushDoc()
  }, [lyricsOn, p.lyrics, p.current?.id, pushDoc])

  /* 歌词窗口 → 主窗口的控制 */
  useEffect(() => desktopLyrics.onAction((a, payload) => {
    const pl = pRef.current
    if (a === 'playpause') pl.togglePlay()
    else if (a === 'next') pl.next()
    else if (a === 'prev') pl.prev()
    else if (a === 'sync') pushDoc()
    else if (a === 'color' && typeof payload?.id === 'string') setLyricColor(payload.id as LyricsColorId)
    // 歌词窗口里拖边缘 / 点 A± 改了宽窄字号：主窗口跟着更新（存档已由歌词窗口写好）
    else if (a === 'layout' && typeof payload?.width === 'number' && typeof payload?.fontSize === 'number') {
      setLyricsLayout({
        width: payload.width,
        fontSize: payload.fontSize,
        bg: typeof payload?.bg === 'number' ? payload.bg : getLyricsLayout().bg,
      }, false)
    }
    else if (a === 'close') {
      void desktopLyrics.close()
      setLyricsOn(false)
      void settings.set(KEYS.lyricsOn, false)
    }
  }), [pushDoc])

  /* 右下角托盘 → 播放控制 / 桌面歌词 */
  useEffect(() => desktopLyrics.onTrayAction(a => {
    const pl = pRef.current
    if (a === 'playpause') pl.togglePlay()
    else if (a === 'next') pl.next()
    else if (a === 'prev') pl.prev()
    else if (a === 'settings') nav('settings')
    else if (a === 'lyrics') void toggleLyricsRef.current()
  }), [nav])

  /* 托盘菜单要显示「在放什么」：标题/歌手/封面只有前端知道，换歌时上报一次 */
  useEffect(() => {
    if (!bridge.isTauri) return
    void trayMenu.setMeta({
      title: p.current?.title ?? '',
      artist: p.current?.artist ?? '',
      cover: p.current?.cover ?? '',
      index: p.queueState.queue.length ? p.queueState.index + 1 : 0,
      total: p.queueState.queue.length,
    })
  }, [p.current?.id, p.current?.title, p.current?.artist, p.current?.cover, p.queueState.index, p.queueState.queue.length])

  toggleLyricsRef.current = toggleLyrics

  /* ---------- 音乐桌面（铺满主屏的壁纸式音乐屏） ---------- */

  const [deskOn, setDeskOn] = useState(false)
  const deskOnRef = useRef(false)
  deskOnRef.current = deskOn

  /** 「音乐锁屏」是否开着：开着时桌面窗是置顶全屏时钟，关掉恢复壁纸层 */
  const [lockOn, setLockOn] = useState(false)
  const lockRef = useRef(false)

  const openDesk = useCallback(async (reveal = true) => {
    // 只有 WorkerW 壁纸一种形态（嵌在桌面图标后面，图标保留、Win+D 收不走）
    await musicDesk.open('bottom')
    setDeskOn(true)
    void settings.set(KEYS.deskOn, true)
    /*
     * 用户主动打开时把主窗口让开。
     * 桌面屏默认置底，主窗口整块盖在它上面——不让开的话，点完按钮屏幕上
     * 什么变化都没有，看起来就是「点了没反应」。启动时恢复（reveal=false）不能让，
     * 否则每次开应用主窗口都自己消失，用户会以为崩了。
     */
    if (reveal) void bridge.invoke('hide_main')
  }, [])

  const closeDesk = useCallback(async () => {
    await musicDesk.close()
    setDeskOn(false)
    void settings.set(KEYS.deskOn, false)
  }, [])

  const toggleDesk = useCallback(() => {
    if (deskOnRef.current) void closeDesk()
    else void openDesk()
  }, [openDesk, closeDesk])

  /* 上次开着，这次继续开着：它是「挂着不动」的东西，不该每次重新点一遍。
     注意这里不能把主窗口让开（reveal=false）——否则每次启动主窗口都自己消失。 */
  useEffect(() => {
    void settings.get<boolean>(KEYS.deskOn).then(v => { if (v) void openDesk(false) })
  }, [openDesk])

  /**
   * 推给音乐桌面窗口的那一份。
   *
   * 只有「换歌 / 歌词变化 / 播放暂停」需要推，**进度不推**：
   * 窗口自己订阅 Rust 的 `player://state`（每 250ms 一次），
   * 主窗口最小化、JS 被节流时，桌面屏上的歌词仍然跟着声音走。
   */
  const pushDesk = useCallback((force = false) => {
    // force：音乐锁屏刚顶上来的那次，桌面窗可能原本没开着，不能被 deskOn 拦
    if (!force && !deskOnRef.current && !lockRef.current) return
    const pl = pRef.current
    const t = pl.current
    void musicDesk.push({
      key: t?.id ?? '',
      title: t?.title ?? '',
      artist: t?.artist ?? '',
      album: t?.album ?? '',
      // 本地封面是磁盘路径，必须过 coverUrlOf（asset 协议），否则 img 静默裂图
      cover: t ? (coverUrlOf(t.cover) || '') : '',
      duration: t?.duration ?? 0,
      playing: pl.snapshot.playing,
      lines: (pl.lyrics?.lines ?? []).map(l => ({ time: l.time, text: l.text })),
    })
  }, [])

  useEffect(() => {
    if (!deskOn && !lockOn) return
    pushDesk()
  }, [deskOn, lockOn, p.current?.id, p.lyrics, p.snapshot.playing, pushDesk])

  /* 音乐锁屏和音乐桌面是**两件独立的事**（两个不同的窗口）：
     进锁屏不会打开桌面，退锁屏也不会收起 / 重挂桌面。这里只负责在锁屏刚顶上来的
     那一刻补推一份数据——锁屏窗口平时藏着，可能从没收到过 `desk://data`。 */
  useEffect(() => musicDesk.onAutoLock(on => {
    lockRef.current = on
    setLockOn(on)
    if (on) pushDesk(true)
  }), [pushDesk])

  /* 音乐桌面窗口 → 主窗口 */
  useEffect(() => musicDesk.onAction((a, payload) => {
    const pl = pRef.current
    // 窗口刚加载完时主窗口可能已经推过了（那时 WebView 还没就绪），补推一次
    if (a === 'ready') { pushDesk(); return }
    if (a === 'playpause') pl.togglePlay()
    else if (a === 'next') pl.next()
    else if (a === 'prev') pl.prev()
    else if (a === 'seek') {
      const sec = Number(payload?.sec)
      if (Number.isFinite(sec)) pl.seek(Math.max(0, sec))
    } else if (a === 'close') {
      // 音乐锁屏里的 × / Esc：只退出锁屏（回到壁纸层），不收起窗口
      if (lockRef.current) { void musicDesk.exitLock(); return }
      // 从桌面屏上收起：把主窗口叫回来，否则用户会面对一块空桌面
      void closeDesk()
      void bridge.invoke('show_main')
    } else if (a === 'open-main') {
      void bridge.invoke('show_main')
    }
  }), [pushDesk, closeDesk])

  /* ---------- 检查更新 ----------
   * 启动 4 秒后再查：先把首屏和曲库扫描让出来，别跟它们抢带宽。
   * 12 小时内只查一次；点过「以后再说」的版本不再提（见 lib/update.ts）。 */
  useEffect(() => {
    if (!bridge.isNative) return
    const t = window.setTimeout(() => {
      void autoCheckUpdate().then(i => { if (i) setUpd(i) })
    }, 4000)
    return () => window.clearTimeout(t)
  }, [])

  /* ---------- 全局快捷键 / 耳机线控 ----------
   * 媒体键、组合键都由 Rust 侧注册（窗口在后台也响应），这里只负责把动作接到播放器上。
   * 用 pRef 取最新播放器上下文，避免快捷键跟着每次快照重建。
   */
  useGlobalHotkeys({
    playpause: () => pRef.current.togglePlay(),
    next: () => pRef.current.next(),
    prev: () => pRef.current.prev(),
    setVolume: v => pRef.current.setVolume(v),
    getVolume: () => pRef.current.snapshot.volume,
    seek: d => {
      const pl = pRef.current
      const dur = pl.snapshot.duration || pl.current?.duration || 0
      if (dur > 0) pl.seek(Math.min(dur, Math.max(0, pl.snapshot.position + d)))
    },
    seekable: () => {
      const pl = pRef.current
      return (pl.snapshot.duration || pl.current?.duration || 0) > 0
    },
    toggleLyrics: () => void toggleLyricsRef.current(),
    openSearch: () => {
      setNowOpen(false)
      setLocalPl(null)
      nav('search')
      void bridge.invoke('show_main').catch(() => { /* 浏览器预览 */ })
    },
    toggleWindow: () => void toggleMainWindow(),
    musicLock: () => {
      if (lockRef.current) void musicDesk.exitLock()
      else void musicDesk.enterLock()
    },
  })

  /* ---------- 快捷键 ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const inInput = tag === 'input' || tag === 'textarea'
      if (inInput) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur()
        return
      }
      const pl = pRef.current
      if (e.key === ' ') { e.preventDefault(); pl.togglePlay() }
      if (e.key === 'ArrowRight' && !e.altKey) pl.seek(Math.min(pl.snapshot.duration, pl.snapshot.position + 5))
      if (e.key === 'ArrowLeft' && !e.altKey) pl.seek(Math.max(0, pl.snapshot.position - 5))
      if (e.key === '/') {
        e.preventDefault()
        setNowOpen(false)
        setLocalPl(null)
        setOnlinePl(v => (v && v.from === 'home' ? null : v))
        nav('home')
        // 搜索框在曲库页里：先把曲库作为「我的」的子页打开，再聚焦
        setHomeLib(true)
        window.setTimeout(() => document.querySelector<HTMLInputElement>('.search-box input')?.focus(), 160)
      }
      if (e.key === 'q' || e.key === 'Q') setQueueOpen(o => !o)
      // F11 全屏：任何页面都能用（播放页右上角那颗按钮走同一个状态）
      if (e.key === 'F11') { e.preventDefault(); void toggleFullscreen() }
      if (e.key === 'Escape') {
        if (detail) { setDetail(null); return }
        if (queueOpen) { setQueueOpen(false); return }
        if (nowOpen) { setNowOpen(false); return }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, queueOpen, nowOpen])

  const openDetail = (t: LocalTrack | null) => {
    if (t) setQueueOpen(false) // 与队列抽屉互斥，避免双抽屉叠加
    setDetail(t)
  }

  /* ---------- 点击空白处收起右侧卡片 ----------
   * 播放列表、歌曲详情这类贴边弹出的卡片，点别处应该自动收回——
   * 总是要求用户先找到那颗小小的 ✕ 太费劲。开关按钮本身（data-panel-toggle）
   * 要排除，否则「点开关想关掉」会被 pointerdown 先收起、click 再打开，永远关不上。 */
  useEffect(() => {
    if (!queueOpen && !detail) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null
      if (!el) return
      if (el.closest('.queue-drawer, .detail-panel, [data-panel-toggle]')) return
      if (queueOpen) setQueueOpen(false)
      if (detail) setDetail(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [queueOpen, detail])

  /*
   * 安卓返回键：先关「最上面那一层」，都不在才允许系统把应用退到后台。
   * 顺序就是这个界面的层叠顺序——播放页 > 抽屉 > 详情 > 子页 > 回首页。
   * 桌面上没有返回键，这段只在安卓壳里注册。
   */
  const backRef = useRef<() => boolean>(() => false)
  backRef.current = () => {
    if (detail) { setDetail(null); return true }
    if (queueOpen) { setQueueOpen(false); return true }
    if (nowOpen) { setNowOpen(false); return true }
    if (plImport) { setPlImport(false); return true }
    if (onlinePl) { setOnlinePl(null); return true }
    if (localPl) { setLocalPl(null); return true }
    if (homeLib) { setHomeLib(false); return true }
    if (page !== 'home') { nav('home'); return true }
    return false
  }
  useEffect(() => {
    if (!isAndroid) return
    setBackHandler(() => backRef.current())
    return () => setBackHandler(null)
  }, [])

  // 设置还没读出来：先铺一张同色的静态底（绝不留白屏），最多 1.2s
  if (firstLaunch === null) {
    return (
      <div className="splash" aria-hidden="true">
        <div className="splash-inner" />
      </div>
    )
  }

  if (showSplash) {
    return <Splash firstLaunch={firstLaunch} reducedMotion={th.reducedMotion} onDone={() => setShowSplash(false)} />
  }

  return (
    <>
      {/* 手机 / 平板 / 车机没有窗口标题栏这回事（那是桌面端的自定义窗口边框） */}
      {shell === 'desk' && <TitleBar page={page} />}
      <Sidebar page={page} onNavigate={nav} trackCount={p.library.length} />
      <main className="page-host">
        {/*
         * 「我的」常驻挂载（和搜索页同一套思路）：从收藏的歌单点进在线歌单详情、
         * 再返回时，歌单网格的滚动位置和本地曲库的搜索词都还在。
         */}
        {page === 'home' && (
          <div className="page-keep" hidden={!!homeDetail || !!localPl || homeLib}>
            <HomePage
              onOpenDetail={openDetail}
              onOpenLocalPlaylist={id => setLocalPl(id)}
              onOpenOnlinePlaylist={r => { setLocalPl(null); setOnlinePl({ ...r, from: 'home' }) }}
              onOpenLibrary={() => { setLocalPl(null); setHomeLib(true) }}
            />
          </div>
        )}
        {page === 'home' && !homeDetail && localPl && (
          <div className="page-keep">
            <LocalPlaylistPage id={localPl} onBack={() => setLocalPl(null)} onOpenDetail={openDetail} />
          </div>
        )}
        {page === 'home' && !homeDetail && homeLib && (
          <div className="page-keep">
            <LibraryPage onOpenDetail={openDetail} onBack={() => setHomeLib(false)} />
          </div>
        )}
        {/*
         * 在线搜索**常驻挂载**，只在不可见时隐藏。
         *
         * 以前 `page === 'search' && <SearchPage/>`：切到下载页再切回来，组件被卸载，
         * 搜索结果、关键词、当前 Tab 全没了——用户搜到一半去看一眼下载进度，
         * 回来得重新搜一次。搜索是这一页最贵的操作（四个平台并发 + 风控），
         * 不该因为切个页面就白做。
         *
         * 歌单详情也是同一套：从详情返回搜索结果时，搜索页的 DOM 和状态都还在。
         */}
        <div className="page-keep" hidden={page !== 'search' || !!searchDetail}>
          <SearchPage onOpenPlaylist={r => setOnlinePl({ ...r, from: 'search' })} />
        </div>
        <div className="page-keep" hidden={page !== 'search' || !searchDetail}>
          {searchDetail && (
            <PlaylistDetailPage
              source={searchDetail.source}
              id={searchDetail.id}
              name={searchDetail.name}
              onBack={() => setOnlinePl(null)}
            />
          )}
        </div>
        {/*
         * 「我的」里点开的在线歌单：**不切页面**，压在「我的」上面，
         * 侧栏还停在「我的」，返回键写「返回我的」。
         */}
        {homeDetail && (
          <div className="page-keep">
            <PlaylistDetailPage
              source={homeDetail.source}
              id={homeDetail.id}
              name={homeDetail.name}
              backLabel="返回我的"
              onBack={() => setOnlinePl(null)}
            />
          </div>
        )}
        {page === 'downloads' && <DownloadsPage />}
        {/*
         * 歌单广场**常驻挂载**：切去下载页再回来，翻到第 5 页的列表和滚动位置还在，
         * 不会把人打回第一屏（和在线搜索同一个理由，那一页最贵的是「翻」）。
         * 「导入歌单」是它下面的子页，从广场的按钮进，返回也回广场。
         */}
        <div className="page-keep" hidden={page !== 'playlist' || plImport || !!squareDetail}>
          <PlaylistSquarePage
            onOpenPlaylist={r => setOnlinePl({ ...r, from: 'square' })}
            onImport={() => setPlImport(true)}
          />
        </div>
        {page === 'playlist' && plImport && (
          <div className="page-keep">
            <PlaylistImportPage onBack={() => setPlImport(false)} />
          </div>
        )}
        {page === 'playlist' && squareDetail && (
          <div className="page-keep">
            <PlaylistDetailPage
              source={squareDetail.source}
              id={squareDetail.id}
              name={squareDetail.name}
              fallbackCover={squareDetail.cover}
              backLabel="返回广场"
              onBack={() => setOnlinePl(null)}
            />
          </div>
        )}
        {page === 'settings' && <SettingsPage deskOn={deskOn} onToggleDesk={toggleDesk} />}
      </main>
      <SpectrumEdges playing={p.snapshot.playing} variant={specStyle} imm={nowOpen} />
      <PlayBar
        onOpenQueue={() => { openDetail(null); setQueueOpen(o => !o) }}
        queueOpen={queueOpen}
        onOpenNow={() => { openDetail(null); setQueueOpen(false); setNowOpen(true) }}
        onOpenDetail={() => { if (p.current) openDetail(p.current) }}
        onOpenLyrics={() => void toggleLyrics()}
        lyricsOn={lyricsOn}
      />
      {/* 播放列表是抽屉（z-index 70 > 播放页 60），直接压在播放页上就行。
          以前先 setNowOpen(false) 再开抽屉，等于「点播放列表 → 播放页被关掉 →
          露出底下的本地音乐页 → 抽屉才弹出来」，看着就像退回了曲库。 */}
      <ImmersivePlayer
        open={nowOpen}
        onClose={() => setNowOpen(false)}
        onOpenDetail={() => { if (p.current) openDetail(p.current) }}
        onOpenQueue={() => setQueueOpen(true)}
        onToggleLyrics={() => void toggleLyrics()}
        onOpenDownloads={() => { setNowOpen(false); nav('downloads') }}
        lyricsOn={lyricsOn}
        onToggleDesk={toggleDesk}
        deskOn={deskOn}
      />
      <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
      {/* 全局轻提示：登录报错、导入结果、加入歌单……都走这里，顶部居中不占布局 */}
      <ToastHost low={nowOpen} />
      {/* 全局确认框：替换掉系统原生 confirm（白底英文按钮，和应用风格完全不搭） */}
      <ConfirmHost />
      {/* 发现新版本：启动时查一次，弹应用内弹窗（不是系统白框） */}
      <UpdateDialog
        info={upd}
        onSkip={() => { if (upd) void skipVersion(upd.latest); setUpd(null) }}
        onGo={() => { if (upd) void openDownload(upd.url); setUpd(null) }}
      />
      <TrackDetail
        track={detail}
        onClose={() => setDetail(null)}
        onPlay={t => p.playList(p.library.length ? p.library : [t], Math.max(0, p.library.findIndex(x => x.id === t.id)))}
        onQueueNext={t => p.addToQueue(t, 'next')}
        currentTime={p.snapshot.position}
        onSeek={s => p.seek(s)}
      />
      {p.lastError && (
        <div className={'app-toast' + (nowOpen ? ' low' : '')} role="alert">
          <span className="app-toast-icon" aria-hidden="true">!</span>
          <span className="app-toast-text">{p.lastError}</span>
          {/* 在线曲目取链失败时，「换源」要随手可点——让用户再去播放条找按钮太绕 */}
          {p.online && (
            <button className="app-toast-act" onClick={() => { p.clearError(); p.switchSource() }}>换源</button>
          )}
          <button onClick={p.clearError} aria-label="关闭提示">关闭</button>
        </div>
      )}
      {/* 非阻断提示：自动降档 / 自动换平台。有错误条时让位，别两条叠一起 */}
      {!p.lastError && p.onlineNotice && (
        <div className={'app-toast soft' + (nowOpen ? ' low' : '')} role="status">
          <span className="app-toast-icon" aria-hidden="true">✓</span>
          <span className="app-toast-text">{p.onlineNotice}</span>
          <button onClick={p.clearNotice} aria-label="关闭提示">关闭</button>
        </div>
      )}
    </>
  )
}
