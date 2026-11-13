/**
 * 沉浸式播放页：整屏覆盖，背景取自当前封面（模糊 + 压暗 + 强调色光斑）。
 * 交互对齐主流播放器：点播放条封面进入，Esc / 收起按钮退出，歌词可点行跳转。
 *
 * 两种排布：
 *   默认   —— 左封面 + 右歌词（一眼看清「在放什么」）
 *   沉浸式歌词 —— 只留歌词，居中、逐字上色、上下淡出（参考 Folia）
 * 后者可用右上角按钮或 L 键随时切换，状态会被记住。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fmtTime, type LocalTrack } from '@shuyin/core'
import { bridge } from '../lib/bridge'
import { isAndroid, onNative } from '../lib/native/android'
import { useShell } from '../lib/shellMode'
import { coverUrlOf } from '../lib/coverUrl'
import { useCoverBrightness } from '../lib/coverTone'
import { usePlayer } from '../lib/PlayerProvider'
import { useTheme } from '../lib/ThemeProvider'
import { Cover } from './Cover'
import { DiscSpectrum } from './DiscSpectrum'
import { LyricsView } from './LyricsView'
import { FoliaLyrics } from './FoliaLyrics'
import { CoverRing } from './SpectrumLayer'
import { ProgressControl } from './Shell'
import { ActionSheet } from './ActionSheet'
import { AddToPlaylistDialog } from './AddToPlaylistDialog'
import { useFavs, favRecOf } from '../lib/favTracks'
import { cachedAudio } from '../lib/audioCache'
import { toast } from '../lib/toast'
import { ChipMenu } from './ChipMenu'
import { Comments } from './Comments'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { SPECTRUM_STYLES, spectrumStyleName, useSpectrumStyle } from '../lib/spectrumStyle'
import { SPECTRUM_POSITIONS, spectrumPosName, useSpectrumPos, useMobileSpecPos } from '../lib/spectrumPos'
import { Spectrum } from './Spectrum'
import { SpectrumSheet } from './SpectrumSheet'
import { LYRICS_LOOKS, lyricsLookName, useLyricsLook } from '../lib/lyricsLook'
import { FX_PRESETS, fxSummary, setFxPreset, useAudioFx } from '../lib/audioFx'
import { coverInfo, effectiveSong, qualityChoicesFor, qualityLabel } from '../lib/online'
import { dlLabel, toLrcText, useDownloads } from '../lib/DownloadsProvider'
import { useFoliaFx, useLyricsSolo, useSpectrumOn, useSwipeHint, useVinylView } from '../lib/uiPrefs'
import { toggleFullscreen, useFullscreen } from '../lib/fullscreen'
import {
  IconAlignCenter, IconAlignLeft, IconAlignRight,
  IconCheck, IconChevronDown, IconComment, IconDesktopLyric, IconDisc, IconDownload, IconFolder, IconFrame, IconFullscreen,
  IconFullscreenExit, IconHeart, IconHeartFilled, IconInfo, IconLyric, IconMonitor, IconMore, IconNext, IconPause, IconPlay,
  IconPrev, IconQueue, IconQueueLines, IconRefresh, IconRepeat, IconRepeatAll, IconShare, IconShuffle, IconSliders, IconSparkle,
  IconMusicNote, IconSpeaker, IconVolume, IconVolumeMute, IconWave,
} from './icons'
import { LYRIC_ALIGN_LIST, useLyricAlign } from '../lib/lyricAlign'

interface Props {
  open: boolean
  onClose(): void
  onOpenDetail(): void
  onOpenQueue(): void
  onToggleLyrics(): void
  /** 关掉播放页并跳到下载页（下载弹层里的「打开下载页面」） */
  onOpenDownloads(): void
  lyricsOn: boolean
  /** 音乐桌面（铺满屏幕的壁纸式音乐屏）：开着时按钮高亮，再点收起 */
  onToggleDesk(): void
  deskOn: boolean
}

export function ImmersivePlayer({ open, onClose, onOpenDetail, onOpenQueue, onToggleLyrics, onOpenDownloads, lyricsOn, onToggleDesk, deskOn }: Props) {
  const p = usePlayer()
  const { tokens } = useTheme()
  const t = p.current
  const repeat = p.queueState.repeat
  const RepeatIcon = repeat === 'one' ? IconRepeat : repeat === 'shuffle' ? IconShuffle : IconRepeatAll
  const [specStyle, setSpecStyle] = useSpectrumStyle()
  const [specPos, setSpecPos] = useSpectrumPos()
  /* 手机：频谱摆在播放页的哪儿（封面外圈 / 页面底部 / 页面顶部） */
  const [mSpecPos, setMSpecPos] = useMobileSpecPos()
  const [specSheet, setSpecSheet] = useState(false)
  const [soloOn, setSolo] = useLyricsSolo()
  const [foliaFx, setFoliaFx] = useFoliaFx()
  const [specOn, setSpecOn] = useSpectrumOn()
  const [vinyl, setVinyl] = useVinylView()
  const [look, setLook] = useLyricsLook()
  const fx = useAudioFx()
  const rootRef = useRef<HTMLDivElement>(null)
  /**
   * 音量控件容器：鼠标停在这上面滚轮直接调音量。
   *
   * 播放页原来只有一条 72px 的细滑杆，要拖准很难；dock 上那颗早就支持滚轮了，
   * 这里却得先悬停展开、再瞄准拖动（用户：「播放页的按钮不支持鼠标滚轮修改音量」）。
   */
  const volRef = useRef<HTMLSpanElement>(null)
  /** 系统级全屏（F11 / 右上角按钮），跟「全屏歌词」是两件事 */
  const full = useFullscreen()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const toggleFull = toggleFullscreen

  /* ---------------- 下载 ----------------
   * 状态已经搬到 `DownloadsProvider`：任务跟着**曲目**走，不再是一个全局 busy 标志。
   * 以前切歌之后那颗图标照旧转圈（它根本不知道自己在下哪首），看着就像「没切成功」。
   * 现在只有「当前这首歌正在下」才转，其余情况该是正常的下载图标。
   */
  const dl = useDownloads()
  /** 当前曲目的音频任务（歌词任务单独一条，不参与这颗按钮的转圈）。
   *  同一首歌可以下多个音质，各是一条任务、各是一个文件 */
  const myDl = t ? dl.taskOf(t.id) : undefined
  const dlTasks = useMemo(
    () => (t ? dl.tasks.filter(x => x.trackId === t.id && x.kind === 'audio') : []),
    [dl.tasks, t],
  )
  const dlBusy = dlTasks.some(x => x.status === 'queued' || x.status === 'resolving' || x.status === 'downloading')
  /** 已经下完 / 正在下的音质：弹层里按档位打勾、挡住重复点击，别的档位照样能下 */
  const dlDoneQs = useMemo(
    () => new Set(dlTasks.filter(x => x.status === 'done').map(x => x.quality).filter(Boolean) as string[]),
    [dlTasks],
  )
  const dlBusyQs = useMemo(
    () => new Set(dlTasks.filter(x => x.status !== 'done' && x.status !== 'error').map(x => x.quality).filter(Boolean) as string[]),
    [dlTasks],
  )
  /** 档位列表：可用音质 + 已经下过/在下的（音源降档时，实际档位可能不在可用列表里） */
  const dlQualities = useMemo(() => {
    const base = qualityChoicesFor(p.onlineQualities)
    const extra = [...dlDoneQs, ...dlBusyQs].filter(q => !base.includes(q))
    return extra.length ? [...base, ...extra] : base
  }, [p.onlineQualities, dlDoneQs, dlBusyQs])
  /**
   * 完全没有歌词（本地大多是录音片段：没有 .lrc、也没有内嵌标签）。
   *
   * 只用来藏「歌词对齐」按钮组——没歌词可对齐。**布局不再随它变**：
   * 有没有歌词都是同一套两列，免得画面晃来晃去还误点（用户明确要求）。
   */
  const noLyric = !p.lyricsLoading && !p.lyrics?.lines.length
  /** 下载用的音质档位（独立于播放档位：想存无损但听流畅是常见诉求） */
  const [dlQuality, setDlQuality] = useState<string | null>(null)
  /** 右栏显示什么：歌词 / 评论。切歌回歌词——评论是「给这首歌看的」，不能留到下一首 */
  const [panel, setPanel] = useState<'lyric' | 'comments'>('lyric')
  useEffect(() => { setPanel('lyric') }, [t?.id])
  /** 歌词对齐（居左 / 居中 / 居右）：右栏是一整块很宽的区域，让用户自己决定贴哪边 */
  const [lyrAlign, setLyrAlign] = useLyricAlign()
  const [dlOpen, setDlOpen] = useState(false)
  const dlRoot = useRef<HTMLDivElement>(null)

  /* ---------------- 触屏形态（安卓手机 / 平板 / 车机） ----------------
   * 设计稿把播放页重排成了「封面 + 歌名 + 一排操作 + 三行歌词 + 进度 + 控制」，
   * 桌面那套左右两列（含黑胶视图、音效/频谱芯片）不适用于手指。
   *
   * **必须是 isAndroid，不能是 isNative**（这里踩过坑）：Tauri 桌面也是 native，
   * 用 isNative 会让 Windows 渲染出一整套触屏节点，而那些样式只写在
   * `html[data-shell='phone'|'tablet'|'car']` 下——桌面上一个都不命中，
   * 于是操作行变成 UA 默认的白底方块、标题多出来一份。见 HomePage 里同一条教训。
   *
   * **平板要排除在外**（0.6.79）：手机上那套竖排 `.imm-mpager` 的样式全部写在
   * `html[data-shell='phone']` 下，平板（短边 ≥ 560）命中的是 `tablet` 那一段，
   * 于是「手机 DOM + 桌面基础样式」硬拼——标题/进度/控制按文档流一路往下堆，
   * 一首歌的字就能顶出屏幕。平板本来屏幕就够，直接用桌面那套两列
   * （左：封面+信息+控制 / 右：歌词），也就是用户说的「参考 windows 端」。 */
  /* 形态要在上面先算出来：playbar / 系统栏 / 排版分支都看它 */
  const shellKind = useShell()
  const mobile = isAndroid && shellKind !== 'tablet'
  /*
   * 「两栏」形态：**横屏时封面页与歌词页是并排的**（见 handoff.css 里
   * landscape 那两段——手机 520 高以内一套、平板 data-wide 一套）。
   *
   * 这不只是视觉差异，面板切换的语义要跟着变：
   *   · 一栏：点「评论」必须整页滑过去，左半屏（封面页）当然跟着走；
   *   · 两栏：右栏自己换内容，左栏一分都不能动。
   *
   * 用户报的「点歌词和评论左边也跟着动」有两层原因：一是这条判断缺了，
   * 二是操作行挂在 `panel !== 'comments'` 上——切评论时那 56 高的一排消失，
   * 轨道长高 28，左栏居中排的封面/歌名跟着往下跳。两处一起改。
   */
  const [twoCol, setTwoCol] = useState(() => false)
  useEffect(() => {
    if (!isAndroid) return
    const calc = () => {
      const wide = document.documentElement.dataset.wide === '1'
      const land = window.matchMedia('(orientation: landscape)').matches
      setTwoCol(land && (wide || window.innerHeight <= 520))
    }
    calc()
    window.addEventListener('resize', calc)
    window.addEventListener('orientationchange', calc)
    return () => {
      window.removeEventListener('resize', calc)
      window.removeEventListener('orientationchange', calc)
    }
  }, [])
  /*
   * 「只留歌词」(solo) 是**桌面专属**视图：手机本来就有封面页 / 歌词页两页，
   * 再叠一层 solo 等于把封面页整个抽走——只剩一屏歌词，且没有任何入口回去。
   *
   * 它是从「⋯ → Folia 歌词动效」漏进来的（打开动效顺手 setSolo(true)），
   * 而且会持久化，下次进播放页还是那个状态：用户看到的就是
   * 「切换不回来到唱片页了」。这里直接让 solo 在手机上恒为 false，
   * 并把存档里的 true 清掉（见下面的 effect），免得一直带着这个包袱。
   */
  const solo = soloOn && !mobile
  /*
   * 封面 / 唱片两态，手机也跟着设置走（用户：「没有唱片模式」——以前这里硬写成
   * `mobile ? false : vinyl`，手机上那颗「视图」芯片又被藏了，等于没有唱片）。
   * 手机上另给一颗封面右下角的切换钮，见 `.imm-mp-vswitch`。
   *
   * 安卓开「频谱可视化」时**强制唱片视图**：频谱画的就是黑胶外那一圈，
   * 方形封面模式里没有这圈可画（用户：「如果开启频谱，就切换到唱片模式，
   * 唱片外面的那个黑圈就不要了，用来展示频谱，关闭的时候又要展示黑圈」）。
   */
  const specRing = mobile && specOn && mSpecPos === 'art'
  /*
   * 手机选了「页面底部 / 顶部」时不再画唱片外圈，改用一条横向频谱。
   * 这条用的是桌面那套 `Spectrum`，所以六种样式在这里是真的能看出区别
   * （唱片外圈那圈走的是 DiscSpectrum，也认样式，但圆环上辨识度天然弱一些）。
   */
  const specBar = mobile && specOn && mSpecPos !== 'art'
  const vinylView = specRing ? true : vinyl
  const favs = useFavs()
  const [moreOpen, setMoreOpen] = useState(false)
  /*
   * 手机上的音质弹层。
   *
   * 桌面右上角本来就有「音质」芯片，手机那一排芯片整个藏起来了（触屏点不准），
   * 结果手机上根本改不了音质——底部那颗「高品质」胶囊只是个 `<span>`，点不动。
   * 现在胶囊本身就是入口：点开列出这首歌真有的档位，选一个当场换。
   */
  const [qualSheet, setQualSheet] = useState(false)
  /* 安卓桌面歌词（悬浮窗）的开关态。真值在原生侧，这里只是界面上那几处开关的显示 */
  const [floatOn, setFloatOn] = useState(false)
  /*
   * 浮窗自己带「×」之后，原生侧会单方面把窗关掉，本地这份 state 就过期了。
   *
   * **`open` 而不是 `moreOpen`**：这颗开关现在不止「更多」面板里有——播放页
   * 底部那排芯片（动效 / 全屏歌词 / 桌面歌词 / 列表）也挂同一个状态。
   * 只在打开面板时问一次，芯片上那颗就会一直显示成「关」（用户说的
   * 「桌面歌词的开关显示不准确」有一半是这里）。
   */
  useEffect(() => {
    if (!open || !isAndroid) return
    void bridge.invoke<{ on: boolean }>('float_lyric_state')
      .then(r => setFloatOn(!!r?.on))
      .catch(() => { /* 命令不存在就保持原样 */ })
  }, [open])
  /*
   * 浮窗自己那颗 ×、以及窗口被系统回收，原生都会推一条 `float://state`。
   * 以前只靠「每次打开面板时问一次」，面板开着的时候窗被关掉，开关还亮着——
   * 用户看到的就是「开关显示不准」。这里跟着原生真值走。
   */
  useEffect(() => {
    if (!isAndroid) return
    return onNative('float://state', payload => {
      const on = !!(payload as { on?: boolean } | null)?.on
      setFloatOn(on)
    })
  }, [])
  /*
   * 从后台回来时**补问一次真值**。
   *
   * 原生侧有好几处会在「前端不在前台」的时候把浮窗收掉：通知栏那颗「词」、
   * 浮窗自己的 ×、锁屏页让位时先 hide 再 show。这些都会推 `float://state`，
   * 但页面在后台时那条推送根本到不了（`evaluateJavascript` 打在被冻结的
   * WebView 上就丢了）。于是用户切回来看，面板/芯片上那颗开关还是离开前的
   * 样子——这就是「桌面歌词的开关显示不准确」剩下的那一半。
   *
   * `app://resume` 由 MainActivity.onResume 发；`visibilitychange` 兜一层
   * （个别 ROM 上 onResume 早于页面可见）。
   */
  useEffect(() => {
    if (!isAndroid) return
    const sync = () => {
      if (document.visibilityState === 'hidden') return
      void bridge.invoke<{ on: boolean }>('float_lyric_state')
        .then(r => setFloatOn(!!r?.on))
        .catch(() => { /* 命令不存在就保持原样 */ })
    }
    const off = onNative('app://resume', sync)
    document.addEventListener('visibilitychange', sync)
    return () => { off(); document.removeEventListener('visibilitychange', sync) }
  }, [])
  /**
   * 安卓「桌面歌词」开关的唯一入口。
   *
   * 以前芯片走的是 `onToggleLyrics`（桌面端那条「开一个独立的歌词窗口」的路），
   * 在安卓上它只是把 `lyricsOn` 这个本地 state 翻成 true——窗压根没开，
   * 芯片亮着，而「更多」面板里的开关还是暗的：同一件事两个状态，必然对不上。
   * 现在两边都走这里，状态只认原生返回的那份。
   */
  const toggleFloat = () => {
    void bridge.invoke<{ on: boolean; needPermission?: boolean }>('float_lyric_toggle').then(r => {
      setFloatOn(!!r?.on)
      if (r?.needPermission) toast('请先允许「显示在其他应用上层」，再打开桌面歌词')
      else if (r?.on) toast('桌面歌词已开启，可以切到别的应用看词')
    }).catch(() => {
      /*
       * 命令没回来（超时 / 原生抛异常）时不要直接说「没有权限」——那是在猜。
       * 先问一次真值：窗其实开出来了，就把开关拨到对的位置，什么都不用说。
       */
      void bridge.invoke<{ on: boolean }>('float_lyric_state').then(r => {
        const on = !!r?.on
        setFloatOn(on)
        if (!on) toast('桌面歌词没能打开，请检查「显示在其他应用上层」权限')
      }).catch(() => toast('桌面歌词没能打开，请检查「显示在其他应用上层」权限'))
    })
  }
  const [addTo, setAddTo] = useState<string[] | null>(null)
  /** 在线曲目是否已经缓存在本地（底部「已缓存」胶囊；本地曲目另有文案） */
  const [cached, setCached] = useState(false)
  /*
   * 手机播放页分两页：`art`（封面 + 歌名 + 操作）和 `lyric`（整屏歌词）。
   *
   * 以前一屏塞九块（页头 / 标签行 / 封面 / 曲目 / 五颗操作 / 三行歌词 / 进度 /
   * 控制 / 音质胶囊），360dp 的机器上封面只能压到 156，其余全挤成薄片——
   * 用户的评价就是「按钮好大、好丑」。分页之后封面能放大，歌词也能真的上下滑。
   *
   * 只对手机生效（`mobile` 为真时才有手势）；桌面 / 平板是两列，本来就有地方。
   */
  const [pager, setPager] = useState<'art' | 'lyric'>('art')
  const pagerTouch = useRef<{ x: number; y: number } | null>(null)
  /*
   * 打开播放页时「第一帧先别烤模糊」。
   *
   * 背景是一张全屏封面 + `filter: blur(...)`。WebView / WebView2 里这层是
   * 软件合成：打开的那一帧要一次性把整屏烤一遍，再叠上页面里几十处
   * `backdrop-filter`，于是「点 mini 播放栏」会有半秒的明显卡顿。
   * 现在先按原图（只压暗）推进来，等推进动画走完再补模糊——用户看不到切换过程，
   * 但首帧的重活没了。
   *
   * 用 `dataset` 直接写、**不用 state**：这是纯样式标记，走 state 会让整页
   * （两千行 JSX + 整份歌词）在动画刚结束的 420ms 处再整棵重渲染一遍，
   * 相当于开页时又卡一下，正好抵消掉这里省下来的。
   *
   * 时序（手机，见 immersive.css 里同名的注释）：
   *   0    ~280ms  背景层推进来，页内容 `opacity: 0` 不参与绘制；
   *   300ms        动画窗口结束 → 内容 140ms 淡入；
   *   520ms        内容画完再补背景模糊，别让这两件重活撞在同一帧。
   */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    if (!open) {
      el.dataset.settled = 'false'
      /* 退场也算动画窗口（关页时整页在往下滑，同样别让毛玻璃抢帧） */
      el.dataset.anim = 'out'
      const id = window.setTimeout(() => { el.dataset.anim = 'false' }, mobile ? 340 : 300)
      return () => window.clearTimeout(id)
    }
    el.dataset.anim = 'in'
    const clearAnim = window.setTimeout(() => { el.dataset.anim = 'false' }, mobile ? 300 : 380)
    if (!mobile) {
      el.dataset.settled = 'true'
      return () => window.clearTimeout(clearAnim)
    }
    const settle = window.setTimeout(() => { el.dataset.settled = 'true' }, 520)
    return () => { window.clearTimeout(clearAnim); window.clearTimeout(settle) }
  }, [open, mobile])

  /*
   * 顺手把存档里的 solo=true 清掉：手机上它没有意义，
   * 留着只会让「桌面开着全屏歌词」这个状态跟着账号/存档跑到手指上。
   */
  useEffect(() => {
    if (mobile && soloOn) setSolo(false)
  }, [mobile, soloOn, setSolo])

  /** 切歌回封面页：停在上一首的歌词上会让人以为「没切成功」 */
  useEffect(() => { setPager('art') }, [t?.id])

  /*
   * 频谱不再需要权限了。
   *
   * 以前这里会「第一次进播放页要一次录音权限」，因为安卓的频谱只能靠
   * Visualizer 采集输出音频。现在原生侧改成从 ExoPlayer 的音频处理链上
   * 旁路 PCM（TapAudioProcessor），一个权限都不用要，这段请求逻辑一起删掉。
   */

  /*
   * 播放页**不再全屏**（用户：「播放页不用全屏，就和我的页面那种高度和宽度一样」）。
   *
   * 以前进页会用 `sysbars hide` 把状态栏/导航栏收掉，页头直接顶到屏幕最上沿——
   * 尺寸跟别的页面对不上。现在反过来：显式把系统栏放回来，播放页就和「我的」页
   * 同一套坐标系（顶部让状态栏、底部让安全区）。
   *
   * 时机从「进页」挪到「退场之后」：
   * 这个调用会让原生重新量一遍安全区并写 `--sy-safe-*`，而**在 `<html>` 上写自定义
   * 属性会让整棵文档重算样式**（真机 1217 个元素 / 35ms）。落在进场动画里就是一次
   * 明显的掉帧，实测开页最坏帧 189ms 里有 64ms 是这一下。关页后 420ms 再调，
   * 那时页面已经滑下去了，重算谁也看不见。
   */
  useEffect(() => {
    if (!isAndroid || shellKind !== 'phone' || open) return
    const id = window.setTimeout(() => {
      void bridge.invoke('sysbars', { hide: false }).catch(() => {})
    }, 420)
    return () => window.clearTimeout(id)
  }, [isAndroid, shellKind, open])

  /*
   * 切歌方向动画（用户：「专辑切换下一曲时加个动画，不然好僵硬」）：
   * 队列下标变小时是上一首（从上方/左侧滑入），变大是下一首（从下方/右侧滑入）。
   * 只标记 400ms，CSS 拿 `data-slide` 播一次 transform/opacity 动画——
   * 不动布局，封面/曲目信息/黑胶一起平移，播放按钮原地不动。
   */
  const lastIdx = useRef(p.queueState.index)
  const [slide, setSlide] = useState<'next' | 'prev' | null>(null)
  /*
   * 「这一下想往哪边切」。
   *
   * 光看下标差在**队列绕回**时是错的：在最后一首上滑（= 下一首）会跳到第 0 首，
   * 下标变小，算出来是 prev，动画就从上面落下来——手指往上、画面从上来，方向反了。
   * 所以手势和按钮在调 next/prev 之前先声明方向，下标的差只当兜底
   * （比如自动接下一首、队列被外部换掉）。
   */
  const wantSlide = useRef<'next' | 'prev' | null>(null)
  const slideTimer = useRef(0)
  const markSlide = (dir: 'next' | 'prev') => {
    wantSlide.current = dir
    setSlide(dir)
    window.clearTimeout(slideTimer.current)
    slideTimer.current = window.setTimeout(() => setSlide(null), 400)
  }
  useEffect(() => {
    const idx = p.queueState.index
    if (idx === lastIdx.current) return
    const dir = wantSlide.current ?? (idx > lastIdx.current ? 'next' : 'prev')
    wantSlide.current = null
    lastIdx.current = idx
    setSlide(dir)
    window.clearTimeout(slideTimer.current)
    slideTimer.current = window.setTimeout(() => setSlide(null), 400)
  }, [p.queueState.index])

  /* 按钮切歌：先声明方向再切，理由同上（绕回时不能按指针差猜） */
  const goPrev = () => { markSlide('prev'); p.prev() }
  const goNext = () => { markSlide('next'); p.next() }

  /*
   * 封面页的歌词带（用户：「展示专辑或唱片时显示歌词，像桌面歌词一样」，
   * 后来又补了一句「歌词显示在专辑下面」）：
   * 三行——上一句（暗）/ 当前句（亮、大）/ 下一句（暗），取设计稿 02 那一块。
   *
   * 为什么要三行而不是两行：设计稿就是三行；而且两行的时候这一带只有 44 高，
   * 下面到进度条之间会空出一大块（用户：「中间空着好多」）。三行既对齐设计稿，
   * 也把那块空白吃掉一部分。
   *
   * **没有歌词也要占位**：整块收起来的话，下面的内容会整体往下跳一截，
   * 切歌（有词↔无词）时画面会抖——所以空态也渲染，写一行「暂无歌词」。
   */
  const lyricLines = p.lyrics?.lines ?? []
  /** 有词但还没唱到第一句（前奏 / 首句时间戳不在 0）、或某句文本为空：
      封面页那块不该整块塌成「暂无歌词」——用户看到的就是「歌词消失了一下」。
      歌词页用的是同一套兜底（`active >= 0 ? active : 0`），两边必须一致。 */
  const firstLyric = lyricLines.findIndex(l => !!l.text.trim())
  const lyricIdx = (() => {
    const pos = p.snapshot.position
    let idx = -1
    for (let i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i].time <= pos + 0.05) idx = i
      else break
    }
    if (idx < 0) return firstLyric
    /* 落在空行上（解析器一般会丢掉，但不保证所有来源都干净）：
       往前找最近一句有字的，找不到就用第一句 */
    if (!lyricLines[idx].text.trim()) {
      for (let i = idx - 1; i >= 0; i--) if (lyricLines[i].text.trim()) return i
      return firstLyric
    }
    return idx
  })()
  const miniPrev = lyricIdx > 0 ? lyricLines[lyricIdx - 1]?.text ?? null : null
  const miniCur = lyricIdx >= 0 ? lyricLines[lyricIdx]?.text ?? null : null
  const miniNext = lyricIdx >= 0 && lyricIdx + 1 < lyricLines.length ? lyricLines[lyricIdx + 1].text : null

  /*
   * 「接下来播放」：封面页底部那块空地的填充。
   *
   * 用户对这一屏的原话是「中间空着好多 / 空的地方你看看再加点什么」。
   * 空出来的高度又不是常量（封面按屏高 clamp、有没有歌词也不一样），
   * 与其硬塞一根分隔线，不如放一块**真有用**的信息：下一首是谁。
   * 点它打开播放队列——用户想看的完整列表就在那儿。
   *
   * 随机播放时队列顺序是算出来的，写「下一首」会撒谎，这时候只报数量。
   */
  const nextTrack = (() => {
    const q = p.queueState.queue
    if (!q.length) return null
    if (p.queueState.repeat === 'shuffle') return null
    if (p.queueState.repeat === 'one') return q[p.queueState.index] ?? null
    return q[p.queueState.index + 1] ?? null
  })()

  /*
   * 「怎么用这一页」的第一次提示。
   *
   * 分页之后有个新问题：封面页上看不出右边还有一页——用户不知道能滑，
   * 也不会去试。所以第一次进播放页浮一句提示，滑过一次就存起来，以后不再出现
   * （每首都飘一句就是噪音）。页头那两个小圆点是常驻的，忘了也能点回去。
   *
   * 文案跟着手势一起改了：现在是「左右翻页、上下换歌」，
   * 再写「在封面左右滑动切歌」会把人教错（那是上一版的手势）。
   */
  const [hintSeen, markHintSeen] = useSwipeHint()
  useEffect(() => {
    if (!mobile || !open || hintSeen) return
    const id = window.setTimeout(() => {
      toast('点左右翻页 · 上下滑动切歌')
      markHintSeen(true)
    }, 700)
    return () => window.clearTimeout(id)
  }, [mobile, open, hintSeen])

  /**
   * 播放页手势（用户：「左右滑动切换歌词和专辑，上下滑动切换上一首下一首」）。
   *
   *   横向 → 翻页（左滑进歌词、右滑回封面）
   *   纵向 → 换歌（上滑下一首、下滑上一首）
   *
   * 三条约束，缺一条就会变成「拖进度条把页面翻走了」：
   *   1. 起点落在按钮 / 进度条 / 操作行 / 歌词带 / 接下来播放上，直接不接；
   *   2. 横向 52dp、纵向 56dp 起步，且主轴要明显压过副轴（×1.3~1.4）——
   *      斜着划一下不该同时翻页又换歌；
   *   3. **封面不再单独吃掉横向手势**：以前封面横滑是换歌，和「左右翻页」直接打架，
   *      用户按新方案统一之后，封面上的横滑也归这里。
   */
  const pageGesture = mobile
    ? {
        onTouchStart: (e: React.TouchEvent) => {
          const el = e.target as HTMLElement
          if (el.closest('button, input, .imm-progress, .imm-ctl, .imm-acts, .imm-pills, .imm-tabrow-solo, .imm-upnext, .imm-mini-lyrics')) {
            pagerTouch.current = null
            return
          }
          const tp = e.touches[0]
          pagerTouch.current = { x: tp.clientX, y: tp.clientY }
        },
        onTouchEnd: (e: React.TouchEvent) => {
          const s = pagerTouch.current
          pagerTouch.current = null
          if (!s) return
          const tp = e.changedTouches[0]
          const dx = tp.clientX - s.x
          const dy = tp.clientY - s.y
          /* 纵向：换歌。上滑=下一首（内容往上走，像翻到下面那张），下滑=上一首 */
          if (Math.abs(dy) > 56 && Math.abs(dy) > Math.abs(dx) * 1.3) {
            markHintSeen(true)
            /* 立闸：滑动结束后浏览器可能补一个 click，会被封面当成「点我看歌词」 */
            tapGuard.current = Date.now() + 400
            if (dy < 0) p.next()
            else p.prev()
            return
          }
          if (Math.abs(dx) < 52 || Math.abs(dx) < Math.abs(dy) * 1.4) return
          /* 用户已经自己滑过了 → 「点左右翻页」这句提示以后不用再出现 */
          markHintSeen(true)
          setPager(dx < 0 ? 'lyric' : 'art')
        },
      }
    : {}

  /* ---------------- 手机播放页手势 ----------------
   *
   * 一页 = 封面 + 歌名 + 两行歌词，**整页一起横滑**。上一版只滑文字带，
   * 唱片模式下看着像「只翻了半个屏」，用户直接说不协调；这一版整页走，
   * 底部进度 / 控制 / 胶囊仍然固定（「不需要滑动整个控制条」说的就是它们）。
   *
   * 竖滑只认封面那一块，而且只有封面跟手指（不是整页上下挪）。
   *
   * 位移直接写 `style.transform`，**不走 React state**：一次 touchmove 一帧，
   * 走 state 会整块重渲染，手指一快就掉帧（这正是「生硬」的来源之一）。
   */
  const mpTrack = useRef<HTMLDivElement>(null)
  const mpStage = useRef<HTMLDivElement>(null)
  /** 竖向翻页轨道：上一首 / 当前 / 下一首三张封面都在里面 */
  const mpReel = useRef<HTMLDivElement>(null)
  const mpDrag = useRef<{ x: number; y: number; axis: '' | 'x' | 'y'; at: number; zone: 'stage' | 'page'; inScroll: boolean } | null>(null)
  const tapGuard = useRef(0)

  /** 一页的宽度 = 轨道的一半。
      **不能用 window.innerWidth**：`.imm-shell` 左右各有 20dp 内边距，
      用 innerWidth 会多推 40px，翻到歌词页时整页往左偏出去一截。 */
  const mpW = () => {
    const tr = mpTrack.current
    const w = tr ? tr.clientWidth / 2 : 0
    return w > 0 ? w : window.innerWidth
  }

  const mpPlace = (x: number, ms = 0) => {
    const tr = mpTrack.current
    if (!tr) return
    tr.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.22, 0.61, 0.36, 1)` : 'none'
    tr.style.transform = `translate3d(${x}px, 0, 0)`
    /*
     * 封面 / 唱片**跟着一起走**（用户：「左滑的时候封面不跟手」）。
     *
     * 上一版这里给 stage 反向补了同样的距离，把封面钉在屏幕原位不动：
     * 手指拖出去半个屏，唱片纹丝不动、只有歌名和歌词在跑，像贴了张贴纸。
     * 现在撤掉补偿，同一条轨道、同一条曲线，封面和文字一起跟手。
     * `--page-x` 一并删掉（styles/handoff.css 里那条 transform 已移除）。
     */
  }

  /**
   * 封面的竖向位移（上下滑切歌）。
   *
   * 位移写在**整条竖向轨道 `.imm-mp-reel`** 上，而不是封面本体：
   * 轨道里装着「上一首 / 当前 / 下一首」三张封面，一起走才有「翻过去」的样子。
   * 以前只推当前那张，滑出去就是一块空底——用户原话「上下滑动下一首歌曲的封面
   * 没有跟随进来」。
   *
   * 唱臂不在这条轨道里（挂在 stage 上），所以切歌时只有唱片走、唱臂留在原地，
   * 正是真唱机的样子。
   */
  /**
   * 邻居（上一首 / 下一首的封面）的显隐。
   *
   * 它们平时 `opacity: 0` 待在 clip 上下那 26px 里——静止时露出一点点边，
   * 正是用户不要的。真的竖着拖起来（data-slide）才显形，那时轨道已经在走，
   * 看到的是「下一张从下面进来」，不是「一条边摆在那儿」。
   */
  const mpSlide = (on: boolean) => {
    const st = mpStage.current
    if (!st) return
    if (on) { if (st.dataset.slide !== '1') st.dataset.slide = '1' }
    else if (st.dataset.slide) delete st.dataset.slide
  }

  const mpLift = (y: number, ms = 0) => {
    const reel = mpReel.current
    if (!reel) return
    reel.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.22, 0.61, 0.36, 1)` : 'none'
    reel.style.transform = `translate3d(0, ${y}px, 0)`
    /* 归零那一刻把邻居重新藏起来（静止态不该看到上下两条边） */
    if (y === 0) {
      if (ms > 0) window.setTimeout(() => mpSlide(false), ms + 24)
      else mpSlide(false)
    }
  }

  /** 当前那张（轨道中间，不是邻居）的高度：切歌阈值按它算 */
  const mpCurH = () => {
    const cur = mpReel.current?.querySelector<HTMLElement>(':scope > .imm-mp-cover, :scope > .imm-mp-disc')
    return cur?.offsetHeight || 320
  }

  /** 翻一步 = 封面高 + 邻居之间的空隙（轨道是 flex column，直接量第一张到第二张） */
  const mpStep = () => {
    const kids = mpReel.current ? (Array.from(mpReel.current.children) as HTMLElement[]) : []
    if (kids.length >= 2) {
      const d = kids[1].offsetTop - kids[0].offsetTop
      if (d > 0) return d
    }
    return mpCurH()
  }

  /**
   * 换曲完成、DOM 已经换成新封面、**还没画**的那一刻把轨道归零。
   *
   * 直接在 `p.next()` 后面归零会闪一帧：那一帧里 React 还没提交新曲目，
   * 归零等于把**旧封面**搬回屏幕中间。用 layout effect 卡在提交之后、绘制之前。
   */
  const liftPending = useRef(0)
  useLayoutEffect(() => {
    if (!liftPending.current) return
    liftPending.current = 0
    mpLift(0, 0)
  }, [t?.id])

  /*
   * 竖向轨道里的左右邻居：队列中当前这首的前一首 / 后一首。
   * 队列只有一首时不给——往哪边滑都是空的，看着像卡住。
   */
  const queueQ = p.queueState.queue
  const queueI = p.queueState.index
  const nbNext = queueQ.length > 1 && queueI >= 0 ? queueQ[(queueI + 1) % queueQ.length] : null
  const nbPrev = queueQ.length > 1 && queueI >= 0 ? queueQ[(queueI - 1 + queueQ.length) % queueQ.length] : null

  /** 轨道里的「邻居」封面：不转、不带频谱、不接点击，只是等着被翻上来 */
  const mpFace = (track: LocalTrack) =>
    vinylView ? (
      <div className="imm-mp-disc" data-playing="false">
        <div className="imm-disc-spin">
          <div className="imm-disc-grooves" aria-hidden="true" />
          <div className="imm-disc-label">
            <Cover track={track} size={220} radius={999} fill />
          </div>
        </div>
        <span className="imm-disc-hole" aria-hidden="true" />
        <span className="imm-disc-gloss" aria-hidden="true" />
      </div>
    ) : (
      <div className="imm-mp-cover" data-playing="false">
        <Cover track={track} size={300} radius={20} fill />
      </div>
    )

  /* 翻页入口不止手势（页头圆点、点封面、点歌词带、点「评论」）——外部改了 pager
     也要走同一段动画，否则那几条路径仍是「瞬间跳过去」 */
  useEffect(() => {
    if (!mobile || twoCol) return
    mpPlace(pager === 'lyric' ? -mpW() : 0, 320)
  }, [pager, mobile, twoCol, t?.id, open])

  /*
   * 回到封面页时把右栏切回「歌词」。
   *
   * 「评论」面板是从歌词页那一排操作进来的（点评论 = panel 切评论 + 翻到歌词页），
   * 而操作行那一排（收藏 / 下载 / 评论 / 分享 / 更多）挂在 `panel !== 'comments'` 上。
   * 以前右滑回封面只改了 pager、没改 panel，于是回到封面页时操作行整排消失；
   * 再左滑回去还会直接落在评论页——用户两条都是这个根因。
   *
   * **必须只在手机上做**：桌面是两列布局，`pager` 恒为 'art'，
   * 不判 mobile 的话桌面点「评论」会被这条立刻改回歌词，评论根本打不开。
   *
   * 两栏（横屏）同理：封面页一直摆在左边，`pager` 在不在 'art' 已经不影响
   * 右栏显示什么了。不排除的话，横屏点右栏顶部那个「评论」tab 会被这条
   * 当场改回去——实测点了两次都没反应，用户只会以为按钮坏了。
   */
  useEffect(() => {
    if (!mobile || twoCol) return
    if (pager === 'art' && panel === 'comments') setPanel('lyric')
  }, [pager, panel, mobile, twoCol])

  /* 手势被系统打断（来电、切后台、通知栏下拉）时不会收到 touchend，
     轨道会僵在拖到一半的位置。回到前台先对齐一次，代价接近零。

     横竖屏切换也必须重算：`mpW()` 取的是轨道宽度的一半，转屏后轨道从
     1024 变成 640，旧位移还停在 -492 上，歌词页右侧会被裁掉 88px
     （华为平板上「Swimming」正好缺一半）。转屏既不发 visibilitychange
     也不发 focus，得自己听 resize / orientationchange。

     但 resize 在手机上很吵（软键盘、地址栏收缩），每次都写 transform 会
     把正在跑的翻页动画打断，所以只在「一页宽真的变了」时才对齐。 */
  useEffect(() => {
    if (!mobile || !open) return
    let lastW = mpW()
    const sync = () => {
      const w = mpW()
      if (Math.abs(w - lastW) < 1) return
      lastW = w
      mpPlace(pager === 'lyric' ? -w : 0, 0)
    }
    /* 转屏时 orientationchange 早于布局完成，读到的还是旧宽度；等一帧再量 */
    const onShift = () => requestAnimationFrame(sync)
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    window.addEventListener('resize', onShift)
    window.addEventListener('orientationchange', onShift)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
      window.removeEventListener('resize', onShift)
      window.removeEventListener('orientationchange', onShift)
    }
  }, [mobile, open, pager])

  /** 点封面 / 唱片：手机进歌词页，桌面切「纯歌词」 */
  const onArtTap = () => {
    if (Date.now() < tapGuard.current) return
    if (mobile) {
      markHintSeen(true)
      setPager('lyric')
      return
    }
    setSolo(true)
  }

  const mpGesture = mobile
    ? {
        onTouchStart: (e: React.TouchEvent) => {
          const el = e.target as HTMLElement
          /* 评论列表与歌词区都算「内容区」：竖着滑它们是在看内容/滚歌词，
             手一歪不该被判成横滑翻页（翻过去就看不见歌词了，用户报的
             「歌词滑不动、滑两下就没了」有这个成分）。这里给横向手势
             更高的门槛（见 touchmove 里的 ratio）。 */
          const inScroll = !!el.closest('.imm-mp-lyricbody')
          /* 按钮 / 输入框不接手势：点它们就是点它们 */
          if (!inScroll && el.closest('button, input, .imm-mp-acts, .imm-mp-foot')) {
            mpDrag.current = null
            return
          }
          const tp = e.touches[0]
          mpDrag.current = {
            x: tp.clientX,
            y: tp.clientY,
            axis: '',
            at: Date.now(),
            zone: el.closest('.imm-mp-stage') ? 'stage' : 'page',
            /* 评论列表自己能滚（用户：「评论不能滑动」）。落在它里面时
               纵向位移优先，只接「明显横着划」的翻页手势 */
            inScroll,
          }
        },
        onTouchMove: (e: React.TouchEvent) => {
          const d = mpDrag.current
          if (!d) return
          const tp = e.touches[0]
          const dx = tp.clientX - d.x
          const dy = tp.clientY - d.y
          if (!d.axis) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
            const ratio = d.inScroll ? 2.4 : 1.12
            d.axis = Math.abs(dx) > Math.abs(dy) * ratio ? 'x' : 'y'
          }
          if (d.axis === 'x') {
            const w = mpW()
            if (pager === 'lyric') {
              /* 歌词页是最右一页：往右 1:1 跟手回封面，往左给 0.3 阻尼
                 （再往左没有内容可露，硬拖只会露出白边） */
              const x = dx > 0 ? Math.min(0, -w + dx) : -w + dx * 0.3
              mpPlace(x)
              return
            }
            let x = dx
            if (x > 0) {
              /* 往右没有上一页——那是「退出播放页」的方向（用户：
                 「左滑也加上，可以退出播放页」）。给 0.85 的轻阻尼，
                 拖得动、拖不满，松手过阈值才收。 */
              x = Math.min(x * 0.85, w * 0.46)
            } else if (x < -w) x = -w + (x + w) * 0.3
            mpPlace(x)
            return
          }
          /* 竖滑：只有封面接（用户：「上下滑动只需要滑动专辑封面或者唱片」）。
             位移 1:1 跟手（原来固定 ×0.45 又死夹 96px，跟一段就顶住，
             正是「不如切歌词页丝滑」的原因）；越过半个 stage 才加阻尼。 */
          if (d.zone !== 'stage') return
          /* 真的竖着拖起来了：这时候才让上下邻居显形（静止态藏起来，
             见 styles/handoff.css 的 .imm-mp-neigh） */
          mpSlide(true)
          const h = mpCurH() || 320
          let y = dy
          const lim = h * 0.46
          if (Math.abs(y) > lim) y = (y < 0 ? -1 : 1) * (lim + (Math.abs(y) - lim) * 0.38)
          mpLift(y)
        },
        onTouchEnd: (e: React.TouchEvent) => {
          const d = mpDrag.current
          mpDrag.current = null
          if (!d) return
          const tp = e.changedTouches[0]
          const dx = tp.clientX - d.x
          const dy = tp.clientY - d.y
          if (d.axis === 'x') {
            const w = mpW()
            const fast = Date.now() - d.at < 300 && Math.abs(dx) > 40
            if (pager === 'lyric') {
              /* 歌词页是最后一页：往右是自然方向；往左也让它回——
                 用户原话「歌词页左滑不能返回专辑页」，愣在那儿比多做一种手势更糟 */
              if (dx > 34 || (fast && dx > 0)) {
                mpPlace(0, 320)
                setPager('art')
              } else {
                mpPlace(-w, 260)
              }
            } else {
              /* 往右：退出播放页。阈值给得比翻页（22%）高一点，
                 避免想点封面时手一抖就退出去了 */
              if (dx > w * 0.3 || (fast && dx > 90)) {
                mpPlace(w, 240)
                tapGuard.current = Date.now() + 600
                setTimeout(() => {
                  mpPlace(0, 0)
                  onClose()
                }, 190)
                return
              }
              const turn = dx < -w * 0.22 || (fast && dx < 0)
              mpPlace(turn ? -w : 0, 320)
              if (turn) {
                markHintSeen(true)
                setPager('lyric')
              }
            }
            tapGuard.current = Date.now() + 320
            return
          }
          if (d.axis === 'y') {
            if (d.zone !== 'stage') return
            const h = mpCurH()
            /* 1:1 跟手之后，切歌阈值按封面高度算（约 1/4），手感与翻页一致；
               快速一甩仍然算 */
            const fast = Date.now() - d.at < 320 && Math.abs(dy) > 56
            if (Math.abs(dy) < h * 0.24 && !fast) {
              mpLift(0, 300)
              return
            }
            /* 队列里只有这一首：往哪边翻都是它自己，别推 */
            const down = dy < 0
            if (!(down ? nbNext : nbPrev)) {
              mpLift(0, 300)
              return
            }
            markHintSeen(true)
            tapGuard.current = Date.now() + 440
            /* 方向按**手指**定，不按切完之后的下标差（最后一首上滑会绕回第 0 首） */
            markSlide(down ? 'next' : 'prev')
            /*
             * 把轨道**顺势推一步**（而不是先弹回原位再换歌）：
             * 推出去 → 换曲 → 在新封面到位的那一帧无动画归零（见 liftPending）。
             * 用户看到的是「上一张翻走了、下一张翻进来」，中间不会弹一下。
             */
            liftPending.current = 1
            mpLift(down ? -mpStep() : mpStep(), 240)
            window.setTimeout(() => {
              if (down) p.next()
              else p.prev()
            }, 210)
            return
          }
          /* 没划动就是「点了一下」：封面看歌词。划过的不算点击，
             浏览器补发的 click 由 tapGuard 兜住 */
          if (d.zone !== 'stage') return
          if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return
          if (Date.now() - d.at > 700) return
          onArtTap()
          tapGuard.current = Date.now() + 400
        },
      }
    : {}

  /* 桌面那套 grid 还挂着 `{...artGesture}`：手机上已由 mpGesture 接管，
     这里留个空对象，桌面本来就不需要（点封面走 onClick）。 */
  const artGesture = {}



  useEffect(() => {
    setCached(false)
    if (!t || !p.online) return
    let alive = true
    void cachedAudio(t.id, t.duration || 0, effectiveSong(t.id)?.name || t.title || '')
      .then(v => { if (alive) setCached(!!v) })
      .catch(() => { /* 查缓存失败就当没缓存，不影响播放 */ })
    return () => { alive = false }
  }, [t?.id, p.online, t?.duration])

  /**
   * 分享。
   *
   * 安卓走**系统分享面板**（`Intent.ACTION_SEND`）：微信、QQ、短信、便签都在里面，
   * 这是「原平台的分享」。以前这里试的是 `navigator.share` —— WebView 里没有这个
   * 对象（它是 Chrome 浏览器的 API），于是每次都静默掉到「复制文本」，
   * 用户点了分享界面毫无反应，原话就是「分享按钮点不了」。
   *
   * 桌面没有系统分享面板，退回复制文本（有 toast，点了看得见结果）。
   */
  const doShare = async () => {
    if (!t) return
    const text = [
      [t.title, t.artist].filter(Boolean).join(' - '),
      t.album ? `专辑：${t.album}` : '',
      '—— 分享自「疏音」',
    ].filter(Boolean).join('\n')
    try {
      if (await bridge.shareText({ text, title: t.title, chooser: '分享歌曲' })) return
    } catch (e) {
      /* 面板起不来（ROM 上一个能接收文本的应用都没有）：继续走复制，别让点击落空 */
      toast(e instanceof Error ? e.message : '打不开分享面板', { bad: true })
    }
    try {
      await navigator.clipboard.writeText(text)
      toast('已复制歌曲信息', { ok: true })
    } catch {
      toast('复制失败', { bad: true })
    }
  }

  useEffect(() => {
    if (!dlOpen) return
    const onDown = (e: PointerEvent) => {
      /* 桌面的下载弹层挂在控制行、手机上的挂在操作行——两处共用 dlOpen，
         所以按 class 判归属，别只认那个 ref（另一个入口点开就立刻被关掉） */
      if (!(e.target as Element)?.closest?.('.imm-dl-wrap')) setDlOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [dlOpen])

  const doDownload = (q?: string) => {
    if (!t || !p.online) return
    if (q) setDlQuality(q)
    dl.download(t, q ?? dlQuality ?? p.onlineQuality ?? undefined)
    /* 弹层**不要**关：点了音质就该马上开始下，用户得看得见进度条和最后的「已下载」。
       关掉的话只剩一颗图标在转，得再点一次才知道下完没有。 */
  }

  const doDownloadLyrics = () => {
    if (!t || !p.lyrics?.lines.length) return
    dl.downloadLyric(t, toLrcText(p.lyrics.lines))
  }

  /** 音效芯片上显示的名字：自定义就用用户起的名字 */
  const fxName = fx.preset === 'custom'
    ? fx.customName
    : (FX_PRESETS.find(x => x.id === fx.preset)?.name ?? '原声')

  /* 音效列表：预设 + 用户自己调的那套（有的话） */
  const fxOptions = [
    ...FX_PRESETS.map(f => ({ id: f.id, name: f.name, desc: f.desc })),
    ...(fx.preset === 'custom'
      ? [{ id: 'custom', name: fx.customName, desc: fxSummary(fx.values) }]
      : []),
  ]

  // 打开时把焦点收进页面，便于键盘操作；关闭后还回去
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => prev?.focus?.()
  }, [open])

  /* L 键切换「只留歌词」，鼠标党用右上角的按钮；F 键切 Folia 动效 */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        setSolo(!solo)
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        const next = !foliaFx
        setFoliaFx(next)
        if (next) setSolo(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, solo, setSolo, foliaFx, setFoliaFx])

  /** 开 Folia 动效。
   *  桌面：顺手进全屏歌词——那个效果在右侧窄栏里看不出味道。
   *  手机：**不**跳全屏歌词（`.imm-solo` 是桌面两列布局的变体，进去以后底部
   *  控制条、频谱、封面全没了，用户看到的是「点了动效，播放页坏了」），
   *  只翻到歌词页——歌词页本身现在也走 Folia。 */
  const toggleFolia = () => {
    const next = !foliaFx
    setFoliaFx(next)
    if (!next) return
    if (mobile) setPager('lyric')
    else setSolo(true)
  }

  /**
   * 点歌词 = 「从这里开始听」。
   * 暂停时只 seek 不播会让人以为点击没反应（声音没变），所以跳转后顺手续播。
   * 进度条拖拽不走这里——那里的语义是「看/定位」，保持原有暂停态。
   */
  const seekToLine = (sec: number) => {
    p.seek(sec)
    if (!p.snapshot.playing) p.togglePlay()
  }

  const bgUrl = coverUrlOf(t?.cover)
  const bgBright = useCoverBrightness(bgUrl)
  const vol = p.snapshot.volume
  /*
   * 滚轮调音量（桌面）：挂在音量控件上，规则和 dock 那颗一致。
   * React 的 onWheel 是 passive 的，`preventDefault` 拦不住页面滚动，所以用原生监听。
   * `p` 每次渲染都是新对象，effect 只在挂载时跑一次、回调里走 ref 取最新值。
   */
  const volPRef = useRef(p)
  volPRef.current = p
  useEffect(() => {
    const el = volRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      volPRef.current.nudgeVolume(e.deltaY < 0 ? 0.05 : -0.05)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const bitrate = t?.bitrate ? `${t.bitrate} kbps` : null

  /*
   * 「这一秒在响的，到底是谁的歌」。
   *
   * 两处不诚实要在这里解决：
   *   1. 跨平台兜底后，真正在放的可能**不是**原曲目的歌手（B 平台只有翻唱）。
   *      继续显示原歌手，就成了「歌手和实际播放的音频不是同一个人」。
   *      → 歌手字段一律显示 `onlineActual.singer`（真正在唱的人）。
   *   2. 平台自己的标题常常写「晴天 (原唱 周杰伦)」而歌手是别人——名字读起来像
   *      原唱那一版，其实放的是翻唱。标题改不了，但可以标一个「翻唱」。
   *      → `coverInfo` 判断「标题点了原唱、歌手却不是他」。
   */
  const actual = p.online ? p.onlineActual : null
  const shownArtist = actual?.singer || t?.artist || ''
  const shownTitle = actual?.name || t?.title || ''
  const cov = t && p.online ? coverInfo(t.title, shownArtist) : null
  /** 歌名下面那一行的后半段：专辑 / 格式 / 码率（没有就整段不渲染，别留个孤零零的「·」） */
  /* 码率低于 32k 的一定是解析出来的垃圾值（WAV/AIFF 的头里没有码率字段，
     有些文件会回一个 1000，显示成「1k」比不显示更让人困惑），索性不写。 */
  const rest = [t?.album, t?.format?.toUpperCase(), t?.bitrate && t.bitrate >= 32000 ? `${Math.round(t.bitrate / 1000)}k` : null]
    .filter(Boolean) as string[]

  /**
   * 播放页的按钮分两层（用户明确反馈过「别全挤在播放按钮周围」）：
   *
   *   menus —— 需要二次选择的下拉芯片（音质 / 音效 / 频谱 / 位置 / 歌词观感），
   *            放回**顶部右上角**：它们是「设置」，不是「控制」，靠上看合理；
   *   quick —— 点一下就生效的开关（Folia / 全屏歌词 / 桌面歌词 / 播放列表），
   *            留在**播放按钮下方**：手就停在控制区，切换不用满屏找。
   */
  const menus = (
    <>
      {p.online && (
        <ChipMenu
          label="音质"
          value={p.onlineQuality ? qualityLabel(p.onlineQuality) : (p.onlineBusy ? '取链中' : '—')}
          activeId={p.onlineQuality ?? undefined}
          disabled={p.onlineBusy}
          title="音质：只列这首歌真实有的档位。某一档取不到时会自动降到下一档，不用你再点一次"
          /* 只列这首歌真有的档位：平台没有的真无损，列出来也是点不动的摆设。
             正在播的那一档如果不在列表里（自动降档 / 换了平台），补一条进去——
             否则下拉里没有任何一项带勾，看着像「音质未知」。 */
          options={[
            ...(p.onlineQuality && !p.onlineQualities.includes(p.onlineQuality)
              ? [{ id: p.onlineQuality, name: qualityLabel(p.onlineQuality), note: p.onlineQuality }]
              : []),
            ...qualityChoicesFor(p.onlineQualities).map(q => ({
              id: q,
              name: qualityLabel(q),
              note: q,
            })),
          ]}
          onPick={q => p.changeQuality(q)}        />
      )}
      <ChipMenu
        icon={<IconSliders width={13} height={13} />}
        label="音效"
        value={fxName}
        activeId={fx.preset}
        title="音效：三段均衡 + 前置增益，改完立刻生效"
        options={fxOptions}
        onPick={id => { if (id !== 'custom') setFxPreset(id) }}
        width={230}      />
      <ChipMenu
        icon={<IconWave width={13} height={13} />}
        label="频谱"
        value={spectrumStyleName(specStyle)}
        activeId={specStyle}
        options={SPECTRUM_STYLES.map(s => ({ id: s.id, name: s.name, desc: s.desc }))}
        onPick={setSpecStyle}
        width={230}      />
      <ChipMenu
        icon={<IconFrame width={13} height={13} />}
        label="位置"
        value={spectrumPosName(specPos)}
        activeId={specPos}
        title="频谱摆在哪儿"
        options={SPECTRUM_POSITIONS.map(x => ({ id: x.id, name: x.name, desc: x.desc }))}
        onPick={setSpecPos}
        width={256}      />
      {foliaFx && (
        <ChipMenu
          icon={<IconLyric width={13} height={13} />}
          label="歌词"
          value={lyricsLookName(look)}
          activeId={look}
          options={LYRICS_LOOKS.map(l => ({ id: l.id, name: l.name, desc: l.desc }))}
          onPick={setLook}
          width={230}        />
      )}
      <ChipMenu
        label="视图"
        value={vinyl ? '唱片' : '封面'}
        activeId={vinyl ? 'vinyl' : 'cover'}
        title="播放页封面样式"
        options={[
          { id: 'vinyl', name: '黑胶唱片', desc: '圆盘 + 唱臂，播放时转动' },
          { id: 'cover', name: '方形封面', desc: '更紧凑' },
        ]}
        onPick={id => setVinyl(id === 'vinyl')}
        width={214}
      />
    </>
  )

  /* 下载：一颗图标，放在播放控制那一行（循环 / 上一首 / 播放 / 下一首 / 下载 / 音量）。
     ·
     · 为什么不用胶囊 `.imm-tool`：那一排已经有 4 个（Folia / 全屏歌词 / 桌面歌词 / 列表），
     · 封面列的宽度只有 320，加第 5 个必然换行——实测它会单独占一整行、还撑满列宽，
     · 观感像是「多出来一块」。播放控制这一行的按钮本来就是纯图标，没有底板没有圆圈，
     · 正好符合「和其他按钮保持样式统一」。
     ·
     · 本地曲目直接 disabled：它已经在磁盘上，亮着只会骗用户点一次。
     */
  /* 下载弹层内容：桌面挂在控制行、手机挂在操作行，共用同一份 */
  const dlPop = (
      <div className="chip-pop dl-pop" role="menu" aria-label="下载" style={{ minWidth: 240 }}>
        {/* 标题下面不再写「选一个音质，立即开始」——点一下就下了，这句话纯属噪音 */}
        <div className="dl-pop-title">下载歌曲</div>
        {dlQualities.map(q => {
          const rowDone = dlDoneQs.has(q)
          const rowBusy = dlBusyQs.has(q)
          return (
            <button
              key={q}
              className={'chip-opt' + (rowDone ? ' on done' : rowBusy ? ' on' : '')}
              disabled={rowDone || rowBusy}
              title={rowDone ? `已下载 ${qualityLabel(q)}` : rowBusy ? '这一档正在下载' : `下载 ${qualityLabel(q)}`}
              onClick={() => doDownload(q)}
            >
              <span className="co-main"><span className="co-name">{qualityLabel(q)}</span></span>
              {/* 只有**真正下过的那一档**才标「已下载」：下 320k 不该把无损也打上勾，
                  否则用户想再下一个音质时，所有档位都灰着，路被堵死 */}
              <span className={'co-note' + (rowDone ? ' done' : '')}>
                {rowDone ? '已下载' : q}
              </span>
              {rowDone && <IconCheck width={12} height={12} />}
            </button>
          )
        })}
        <div className="ctx-divider" />
        <button
          className="chip-opt"
          disabled={!p.lyrics?.lines.length}
          title={p.lyrics?.lines.length ? '保存为 .lrc（与音频同目录）' : '当前没有可用歌词'}
          onClick={doDownloadLyrics}
        >
          <span className="co-main"><span className="co-name">歌词 .lrc</span></span>
        </button>
        {myDl && (
          <div className={'dl-status' + (myDl.error ? ' bad' : '')}>
            {myDl.error ? (
              <>
                <span className="dl-status-text">{myDl.error}</span>
                <button className="link-btn" onClick={() => dl.retry(myDl.id)}>重试</button>
              </>
            ) : (
              <>
                <span className="dl-status-text">{dlLabel(myDl)}</span>
                {myDl.status === 'downloading' && myDl.total > 0 && (
                  <span className="side-dl-bar">
                    <i style={{ width: `${Math.min(100, (myDl.done / myDl.total) * 100)}%` }} />
                  </span>
                )}
                {myDl.status === 'done' && myDl.path && (
                  <button className="link-btn" onClick={() => void bridge.revealInFolder(myDl.path)}>
                    {bridge.isAndroid ? '复制路径' : '在文件夹中显示'}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <div className="dl-pop-foot">
          <button className="link-btn" onClick={() => { setDlOpen(false); onOpenDownloads() }}>打开下载页面</button>
        </div>
      </div>
  )

  const dlMenu = (
    <span className="imm-dl-wrap chip-menu up" ref={dlRoot}>
      <button
        className={'icon-btn imm-dl' + (dlBusy ? ' busy' : '')}
        aria-label={p.online ? (dlDoneQs.size ? '已下载' : '下载') : '本地歌曲，不需要下载'}
        aria-haspopup="menu"
        aria-expanded={dlOpen}
        disabled={!p.online}
        title={
          !p.online
            ? '本地歌曲已经在磁盘上，不需要下载'
            : dlDoneQs.size
              ? `已下载 ${dlDoneQs.size} 个音质 · 点开可以再下一个或看进度`
              : '下载歌曲（可选音质）'
        }
        onClick={() => setDlOpen(o => !o)}
      >
        {dlBusy ? <span className="spin-ring sm" aria-hidden="true" />
          : dlDoneQs.size ? (
            /* 已下载：**保留下载图标**，右下角叠一个小勾。
               只画一个勾的话，这一排图标里它就变成了「另一个功能」——
               用户找不到「下载」在哪了（他反馈过这一点）。 */
            <span className="imm-dl-done" aria-hidden="true">
              <IconDownload width={17} height={17} />
              <IconCheck className="imm-dl-tick" width={9} height={9} />
            </span>
          )
          : <IconDownload width={17} height={17} />}
      </button>
      {dlOpen && dlPop}
    </span>
  )

  /** 播放按钮下面那一排：点一下即生效的开关（Folia / 全屏歌词 / 桌面歌词 / 列表）。
   *  文字包在 `.it-lbl` 里：窄窗（列宽只有 264）时 CSS 会把它藏起来只留图标，
   *  否则 4 颗芯片必然换行，第二行孤零零一颗特别难看。 */
  const quick = (
    <div className="imm-tools" role="toolbar" aria-label="播放控制">
      <button className="imm-tool" onClick={toggleFolia} aria-pressed={foliaFx}
        title={foliaFx ? '歌词动效：开（F 切换）' : '歌词动效：关（F 切换）'}>
        <IconSparkle width={13} height={13} /> <span className="it-lbl">动效</span>
      </button>
      {/* 手机上这颗是「翻到歌词页 / 翻回封面页」（solo 排版只给桌面，见渲染处的注释）；
          桌面上仍然是「只留歌词」那档布局 */}
      <button className="imm-tool"
        onClick={() => (mobile ? setPager(pager === 'lyric' ? 'art' : 'lyric') : setSolo(!solo))}
        aria-pressed={mobile ? pager === 'lyric' : solo}
        title={mobile
          ? (pager === 'lyric' ? '回到封面' : '翻到歌词页')
          : (solo ? '回到播放页 (L)' : '只留歌词，全屏显示 (L)')}>
        <IconLyric width={13} height={13} />
        <span className="it-lbl">{mobile ? (pager === 'lyric' ? '封面' : '歌词页') : (solo ? '播放页' : '全屏歌词')}</span>
      </button>
      {/* 桌面端 = 独立歌词窗口；安卓 = 系统悬浮窗（走原生，状态见 toggleFloat） */}
      <button className="imm-tool" onClick={isAndroid ? toggleFloat : onToggleLyrics}
        aria-pressed={isAndroid ? floatOn : lyricsOn} title="桌面歌词">
        <IconDesktopLyric width={13} height={13} /> <span className="it-lbl">桌面歌词</span>
      </button>
      <button className="imm-tool" data-panel-toggle onClick={onOpenQueue} title="播放列表 (Q)">
        <IconQueue width={13} height={13} /> <span className="it-lbl">列表</span>
      </button>
    </div>
  )

  /**
   * 播放页右键菜单。
   * 以前这里什么都不弹：主窗口全局把系统菜单（刷新/另存为）关掉了，
   * 而播放页自己没有兜一个自定义菜单，右键就等于没反应。
   */
  const immMenu: MenuItem[] = t ? [
    { id: 'detail', label: '歌曲详情', icon: <IconInfo width={13} height={13} />, onSelect: onOpenDetail },
    { id: 'queue', label: '播放列表', icon: <IconQueue width={13} height={13} />, onSelect: onOpenQueue },
    {
      id: 'lyrics',
      label: (isAndroid ? floatOn : lyricsOn) ? '关闭桌面歌词' : '打开桌面歌词',
      icon: <IconDesktopLyric width={13} height={13} />,
      onSelect: isAndroid ? toggleFloat : onToggleLyrics,
    },
    {
      id: 'full', label: full ? '退出全屏' : '全屏',
      icon: <IconFullscreen width={13} height={13} />, onSelect: () => void toggleFull(),
    },
    ...(p.online ? [
      {
        id: 'dl',
        label: `下载歌曲${p.onlineQuality ? `（${qualityLabel(p.onlineQuality)}）` : ''}`,
        icon: <IconDownload width={13} height={13} />,
        onSelect: () => void doDownload(p.onlineQuality ?? undefined),
      },
      {
        id: 'lrc', label: '下载歌词 .lrc',
        icon: <IconLyric width={13} height={13} />,
        disabled: !p.lyrics?.lines.length,
        onSelect: () => void doDownloadLyrics(),
      },
    ] : [
      {
        id: 'reveal', label: bridge.isAndroid ? '复制路径' : '在文件夹中显示',
        icon: <IconFolder width={13} height={13} />,
        onSelect: () => void bridge.revealInFolder(t.path),
      },
    ]),
  ] : []

  /*
   * 播放页是盖在全站之上的抽屉，但**多选工具条是 position:fixed + z-index 125**，
   * 抽屉关不住它——播放页打开时它会浮在封面正中间（实测）。这里在根节点上挂一个标记，
   * 由 CSS 把这类全局浮层收掉，比在 .imm 上加更低的 z-index 稳（不影响真实层级关系）。
   */
  useEffect(() => {
    const root = document.documentElement
    const want = open ? '1' : ''
    /*
     * 判一下再写，而且**不做 cleanup 删除**。
     *
     * `<html>` 上的属性变化会让整棵文档样式失效（实测扫 1217 个元素 / 26~34ms）。
     * 以前这里是「依赖变化 → 先 delete 再 set」，`open` 从 false 变 true 时等于
     * 白写两次；而 App.flashPlayer 在点击事件里已经把 `data-imm` 置成 '1' 了，
     * 走到这里本来就该什么都不做。
     */
    if (want) {
      if (root.dataset.imm !== '1') root.dataset.imm = '1'
    } else if (root.dataset.imm) {
      delete root.dataset.imm
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className="imm themed"
      data-open={open}
      data-settled="false"
      data-anim="false"
      data-solo={solo}
      data-cover={bgUrl ? 'true' : 'false'}
      aria-hidden={!open}
      role="dialog"
      aria-modal={open}
      aria-label="正在播放"
      tabIndex={-1}
      onContextMenu={e => {
        if (!t) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div
        className="imm-bg"
        style={bgUrl
          ? { backgroundImage: `url("${bgUrl}")`, ['--imm-bright' as never]: bgBright }
          : undefined}
        data-glass-degraded={tokens.glassBlur === 0}
      />
      <div className="imm-scrim" />
      <div className="imm-beam" aria-hidden="true" />
      <div className="imm-flare" />
      {/* 有封面时再垫一层「专辑色」的柔光，让模糊底不像一块灰板 */}
      {bgUrl && <div className="imm-tint" aria-hidden="true" />}

      <div className="imm-shell" data-solo={solo} data-mobile={mobile ? '1' : '0'} data-tauri-drag-region>
        {/* 手机 / 车机页头（设计稿 02）：收起在左、居中「正在播放 · 本地」、更多在右。
            桌面那一条（品牌 + 芯片 + 全屏 + 收起）在触屏上没意义，CSS 里整条隐掉。 */}
        {mobile && (
          <header className="imm-top-m">
            <button className="icon-btn imm-m-back" aria-label="收起播放页" onClick={onClose}>
              <IconChevronDown width={26} height={26} />
            </button>
            <span className="imm-m-kicker">
              <span className="k">
                {pager === 'lyric' ? (panel === 'comments' ? '评论' : '歌词') : '正在播放'}
                <span className="dim"> · {p.online ? '在线' : '本地'}</span>
              </span>
              {/* 两页的常驻指示：既告诉用户「左边还有一页」，也给不知道能滑的人
                  一个能点的入口（点圆点直接翻页）。 */}
              <span className="imm-pagedots" role="tablist" aria-label="播放页分页">
                <button
                  className={'imm-pagedot' + (pager === 'art' ? ' on' : '')}
                  role="tab" aria-selected={pager === 'art'} aria-label="封面页"
                  onClick={() => setPager('art')}
                />
                <button
                  className={'imm-pagedot' + (pager === 'lyric' ? ' on' : '')}
                  role="tab" aria-selected={pager === 'lyric'} aria-label="歌词页"
                  onClick={() => setPager('lyric')}
                />
              </span>
            </span>
            <span className="imm-m-topacts">
              {/* 频谱设置：手机上样式/位置以前只能看默认值（设置页那段只对桌面渲染）。
                  放在页头是因为它属于「这台播放器长什么样」，不是每首歌的操作；
                  操作行那五颗已经是收藏/下载/评论/分享/更多，再塞一颗会挤。 */}
              <button className="icon-btn imm-m-spec" aria-label="频谱设置" onClick={() => setSpecSheet(true)}>
                <IconWave width={22} height={22} />
              </button>
              <button className="icon-btn imm-m-more" aria-label="更多" onClick={() => setMoreOpen(true)}>
                <IconMore width={26} height={26} />
              </button>
            </span>
          </header>
        )}
        {/* data-tauri-drag-region：播放页整屏盖住了标题栏，用户没法拖窗口换位置。
            顶部这一条和四周留白都标成拖动区——点在按钮上不生效（按钮是更深的 target），
            空白处按住就能拖，双击空白处会走系统的最小化/最大化行为。 */}
        <header className="imm-top" data-tauri-drag-region>
          <div className="imm-top-l" data-tauri-drag-region>
            <span className="imm-mark">疏音</span>
            <span className="imm-sep" aria-hidden="true" />
            <span className="imm-kicker">{solo ? '歌词' : '正在播放'}</span>
            {p.queueState.queue.length > 0 && (
              <span className="imm-pos num">
                {p.queueState.index + 1} / {p.queueState.queue.length}
              </span>
            )}
            {/* 桌面视图切换（用户：「像手机一样加个切换状态的按钮」）：
                点封面进纯歌词后，回口原来只有底部工具带里那颗小按钮，根本找不到——
                「点击专辑切换后切换不回来了」说的就是它。这里在页头放一个常驻分段开关，
                播放页 / 歌词 两态一目了然，随时点回去。 */}
            {!mobile && t && (
              <span className="imm-viewtoggle" role="tablist" aria-label="播放页视图">
                <button
                  className={!solo ? 'on' : ''}
                  role="tab" aria-selected={!solo}
                  onClick={() => setSolo(false)}
                >播放页</button>
                <button
                  className={solo ? 'on' : ''}
                  role="tab" aria-selected={solo}
                  onClick={() => setSolo(true)}
                >歌词</button>
              </span>
            )}
          </div>
          <div className="imm-top-r">
            {/* 下拉设置芯片：音质 / 音效 / 频谱 / 位置（+Folia 的歌词观感）。
                点一下就生效的开关在下面的播放按钮旁，别把两类混在一起。 */}
            <div className="imm-top-menus">{menus}</div>
            {/* 音乐桌面 / 全屏：两个都是桌面窗口层面的事。
                安卓上 musicDesk 是空实现、全屏按钮只是把系统栏再藏一次（=没有全屏），
                留着就是「点了没反应」——直接不渲染。 */}
            {bridge.isTauri && (
              <>
                {/* 音乐桌面：铺满屏幕的壁纸式音乐屏。放在全屏按钮左边——
                    两者都是「换一种看法」，但一个是把应用放大，一个是把它退到桌面背景。 */}
                <button
                  className="icon-btn imm-icobtn"
                  aria-label={deskOn ? '收起音乐桌面' : '打开音乐桌面'}
                  aria-pressed={deskOn}
                  title={deskOn ? '收起音乐桌面' : '音乐桌面（铺满屏幕，可置底当壁纸）'}
                  onClick={onToggleDesk}
                >
                  <IconMonitor width={15} height={15} />
                </button>
                <button
                  className="icon-btn imm-icobtn"
                  aria-label={full ? '退出全屏' : '全屏'}
                  aria-pressed={full}
                  title={full ? '退出全屏 (F11)' : '全屏 (F11)'}
                  onClick={() => void toggleFull()}
                >
                  {full
                    ? <IconFullscreenExit width={15} height={15} />
                    : <IconFullscreen width={15} height={15} />}
                </button>
              </>
            )}
            <button className="icon-btn imm-close" aria-label="收起播放页" title="收起 (Esc)" onClick={onClose}>
              <IconChevronDown width={18} height={18} />
            </button>
          </div>
        </header>

        {!t && (
          <div className="empty-state" style={{ height: '100%' }}>
            <div className="title">还没有正在播放的歌曲</div>
            <div className="sub">从本地音乐里选一首开始</div>
          </div>
        )}

        {/* 全屏歌词（`.imm-solo`）是**桌面**排版：一条歌词 + 底部控制，没有封面页、
            没有频谱、没有手机上那套翻页手势。手机上开着 `solo` 会把整页换掉，
            用户看到的就是「打开歌词动效，播放页坏了」——所以手机上永远走 pager。 */}
        {t && solo && !mobile && (
          <div className="imm-solo" data-tauri-drag-region>
            <div className="imm-solo-lyrics">
              {/* Folia 动效开启时是「逐字弹出」的文字 PV；关闭时退回可滚动的普通歌词 */}
              {foliaFx ? (
                <FoliaLyrics
                  doc={p.lyrics}
                  loading={p.lyricsLoading}
                  currentTime={p.snapshot.position}
                  progress={p.snapshot.duration > 0 ? p.snapshot.position / p.snapshot.duration : 0}
                  onSeek={seekToLine}
                  onSearchOnline={q => p.reloadLyrics(true, q)}
                  trackTitle={t.title || ''}
                  trackArtist={t.artist || ''}
                  live={open}
                />
              ) : (
                <LyricsView
                  doc={p.lyrics}
                  loading={p.lyricsLoading}
                  currentTime={p.snapshot.position}
                  onSeek={seekToLine}
                  onSearchOnline={q => p.reloadLyrics(true, q)}
                  trackTitle={t.title || ''}
                  trackArtist={t.artist || ''}
                  immersive
                  /* 全屏歌词也要跑马灯：以前这里靠缩字号硬塞，缩到下限（0.5 倍）
                     还是超宽就被省略号吃掉半句——用户在全屏看歌词，恰恰是最需要
                     「整句读完」的地方。现在和右栏、手机歌词页同一套：字号不动，
                     唱到哪个字就横向推到哪个字。 */
                  scrollOverflow
                  live={open && solo}
                />
              )}
            </div>

            <div className="imm-solo-foot">
              <div className="imm-solo-meta">
                <span className="n">{t.title}</span>
                <span className="dot" aria-hidden="true">·</span>
                <span className="a">{t.artist || '未知歌手'}</span>
              </div>
              <ProgressControl />
              <div className="imm-solo-ctl">
                <button className="icon-btn" aria-label="上一首" onClick={goPrev}>
                  <IconPrev width={20} height={20} />
                </button>
                <button className="play-primary imm-play" aria-label={p.loading ? '正在加载' : p.snapshot.playing ? '暂停' : '播放'}
                  aria-busy={p.loading} onClick={p.togglePlay}>
                  {p.loading
                    ? <span className="spin-ring" aria-hidden="true" />
                    : p.snapshot.playing ? <IconPause width={22} height={22} /> : <IconPlay width={22} height={22} />}
                </button>
                <button className="icon-btn" aria-label="下一首" onClick={goNext}>
                  <IconNext width={20} height={20} />
                </button>
              </div>
              {quick}
            </div>
          </div>
        )}

        {/* 手机：整页横滑（封面 + 歌名 + 歌词 ⇄ 歌词页），底部控制固定。
            桌面仍是下面那套两列 grid——两边的排版需求差太远，硬套一套会互相拖累。 */}
        {t && mobile && (
          <div
            className="imm-mpager"
            data-page={pager}
            data-slide={slide ?? undefined}
            {...mpGesture}
          >
            {/* 频谱横条·顶部：占在封面页上方，翻页时不动 */}
            {specBar && mSpecPos === 'top' && (
              <div className="imm-mp-specbar" data-pos="top" aria-hidden="true">
                <Spectrum
                  playing={p.snapshot.playing && open}
                  active={open}
                  variant={specStyle}
                  height={34}
                  barWidth={4}
                  gap={3}
                  maxBars={80}
                  flip
                />
              </div>
            )}

            <div className="imm-mp-track" ref={mpTrack}>
              {/* ---- 封面页：封面 + 歌名 + 两行歌词，一整页一起滑 ---- */}
              <section className="imm-mp" data-p="art">
                {/* 封面 / 唱片：只有这一块接竖滑，拖动时也只有它跟着走 */}
                <div
                  className="imm-mp-stage"
                  ref={mpStage}
                  data-vinyl={vinylView ? 'true' : 'false'}
                >
                  {/*
                   * 竖向轨道：上一首 / 当前 / 下一首三张封面叠在一条竖线上。
                   * 上下滑时整条轨道跟手走，所以滑出去的那半屏正好是邻居的封面，
                   * 不会露出空底（用户：「上下滑动下一首歌曲的封面没有跟随进来」）。
                   * 外面那层 `.imm-mp-clip` 只负责裁掉轨道滑出去的部分，
                   * 唱臂留在 stage 上不参与翻页。
                   */}
                  <div className="imm-mp-clip">
                    <div className="imm-mp-reel" ref={mpReel}>
                  {nbPrev && (
                    <div className="imm-mp-neigh" data-k="prev" aria-hidden="true">{mpFace(nbPrev)}</div>
                  )}
                  {vinylView ? (
                    <>
                    <div
                      className="imm-mp-disc"
                      data-playing={p.snapshot.playing && open ? 'true' : 'false'}
                      data-spec={specRing ? 'true' : 'false'}
                      title="点击看歌词 · 上下滑动切歌"
                    >
                      <div className="imm-disc-spin">
                        <div className="imm-disc-grooves" aria-hidden="true" />
                        <div className="imm-disc-label">
                          <Cover track={t} size={220} radius={999} fill />
                        </div>
                      </div>
                      {/*
                        开频谱时：黑胶纹路让位给一圈真·FFT 频谱（数据来自原生 Visualizer）。

                        `active` 必须带上 `open`：播放页是**常驻挂载**的（靠 opacity
                        藏起来），只写 `pager === 'art'` 等于退出播放页之后这圈
                        88 根柱子仍在后台 35fps 重绘——用户翻曲库、滚歌单时主线程
                        一直被占着，任何动画都跟着掉帧。关页即停。
                      */}
                      {specRing && (
                        <DiscSpectrum
                          playing={p.snapshot.playing && open}
                          active={open && pager === 'art'}
                          variant={specStyle}
                        />
                      )}
                      <span className="imm-disc-hole" aria-hidden="true" />
                      <span className="imm-disc-gloss" aria-hidden="true" />
                    </div>
                    </>
                  ) : (
                    <div
                      className="imm-mp-cover"
                      data-playing={p.snapshot.playing}
                      title="点击看歌词 · 上下滑动切歌"
                    >
                      <Cover track={t} size={300} radius={20} fill />
                      {specPos === 'cover' && <CoverRing playing={p.snapshot.playing && open} pad={100} variant={specStyle} />}
                    </div>
                  )}
                    {nbNext && (
                      <div className="imm-mp-neigh" data-k="next" aria-hidden="true">{mpFace(nbNext)}</div>
                    )}
                    </div>
                  </div>

                  {/* 唱臂挂在 stage 上（不是 disc 里、也不在翻页轨道里）：切歌 / 拖动时
                      disc 自己走，唱臂只负责抬臂旋转。以前靠反向平移补偿，位移一过页顶
                      就被 overflow 裁掉 —— 用户看到的「唱臂滑着滑着就不见了」。 */}
                  {vinylView && (
                    <span
                      className="imm-disc-arm-wrap"
                      data-playing={p.snapshot.playing && open ? 'true' : 'false'}
                    >
                        {/* 唱臂：坐标系 = 唱片外接方框，(50,50) 是盘心、半径 50。
                            转轴放在盘沿外上方 (66,-4)，臂长 32 —— 绕转轴转 -26° 时
                            唱头从「黑圈 0.75 半径」抬到「盘外 1.04 半径」，正好是
                            用户要的：播放指黑圈、暂停指盘外。唱头不再落在封面图上。

                            标签放大到 68% 之后黑圈变窄，唱头原来的落点（0.82R）虽然
                            还在环里，但它的外端正好骑在盘沿上；整只唱头往盘心收 2.5
                            单位，落点变成 0.79R、外端 0.93R，全程压在黑圈/频谱里。 */}
                        <span className="imm-disc-arm" aria-hidden="true">
                          <svg viewBox="0 0 100 100" fill="none">
                            <path
                              d="M66 -4C67.6 6 70.8 15 75.1 23"
                              stroke="currentColor"
                              strokeWidth="2.9"
                              strokeLinecap="round"
                            />
                            <rect x="73.75" y="22.63" width="12.5" height="6.2" rx="3.1"
                              fill="currentColor" transform="rotate(40 80 25.73)" />
                            <circle cx="66" cy="-4" r="5.4" fill="currentColor" />
                            <circle cx="66" cy="-4" r="2.4" fill="#0c0d11" />
                          </svg>
                        </span>
                    </span>
                  )}
                </div>

                {/* 歌名 / 歌手 · 专辑：紧贴封面下沿，不留一块空档。
                    封面 / 唱片切换钮也摆在这一行的右端（用户：「按钮可以移动到
                    歌曲名称那一行上去」）——以前贴在封面右下角，压画面又不好点。 */}
                <div className="imm-mp-meta">
                  <div className="imm-mp-metatxt">
                    <h1 className="imm-mp-title">
                      <span>{t.title}</span>
                      {cov && <i className="imm-badge cov imm-cov" title={`这是翻唱版 · 原唱：${cov.original}`}>翻唱</i>}
                    </h1>
                    <p className="imm-mp-sub">
                      <span className="a">{shownArtist || '未知歌手'}</span>
                      {t.album && <span className="sep" aria-hidden="true">·</span>}
                      {t.album && <span className="b">{t.album}</span>}
                    </p>
                  </div>
                  {/* 环形频谱只能长在唱片上（它绕盘沿画一圈），开到这个位置时页面
                      被强制成唱片模式，切换钮以前干脆不渲染——用户找不到按钮，
                      以为「是不是被隐藏了」。现在按钮常驻：点它就把频谱从「封面
                      外圈」挪到「页面底部」，再回方形封面。 */}
                  <button
                    className="imm-mp-vswitch"
                    aria-label={vinylView ? '切换为方形封面' : '切换为唱片模式'}
                    title={vinylView ? '方形封面' : '唱片模式'}
                    onClick={() => {
                      if (specRing) {
                        setMSpecPos('bottom')
                        setVinyl(false)
                        return
                      }
                      setVinyl(!vinylView)
                    }}
                  >
                    {vinylView ? <IconFrame width={17} height={17} /> : <IconDisc width={17} height={17} />}
                  </button>
                </div>

                {/* 两条歌词：当前句 + 下一句（对齐用户给的 QQ 音乐那屏）。
                    点一下进歌词页。没有歌词也占位，否则整页会上下跳。 */}
                <div
                  className="imm-mp-lyr"
                  data-empty={miniCur ? 'false' : 'true'}
                  onClick={() => setPager('lyric')}
                >
                  {miniCur ? (
                    <>
                      <div className="imp-l cur">{miniCur}</div>
                      <div className="imp-l next">{miniNext || '\u00a0'}</div>
                    </>
                  ) : (
                    <div className="imp-empty">
                      <span className="t">{p.lyricsLoading ? '歌词加载中…' : '暂无歌词'}</span>
                      {!p.lyricsLoading && <span className="s">点这里看歌词页</span>}
                    </div>
                  )}
                </div>
              </section>

              {/* ---- 歌词页 ---- */}
              <section className="imm-mp" data-p="lyric">
                <div className="imm-mp-tabs">
                  <button
                    className={'imm-mp-tab' + (panel === 'lyric' ? ' on' : '')}
                    onClick={() => setPanel('lyric')}
                  >歌词</button>
                  <button
                    className={'imm-mp-tab' + (panel === 'comments' ? ' on' : '')}
                    onClick={() => setPanel('comments')}
                  >评论</button>
                  {/* 歌词对齐（用户：「歌词页不能调整对齐方式，默认居中」）：
                      手机上一直没这个入口，还硬写成左对齐。三颗小图标放在
                      tab 行右端，选中的那档记在 ui.lyricAlign 里，与桌面共用。
                      Folia 动效是「一句一行居中排」的版式，对齐对它不起作用，
                      开着动效就把这三颗收起来（留着一个点了没反应的开关更糟）。 */}
                  {panel === 'lyric' && !foliaFx && (
                    <div className="imm-mp-align" role="group" aria-label="歌词对齐">
                      {LYRIC_ALIGN_LIST.map(a => (
                        <button
                          key={a.id}
                          type="button"
                          className={'imm-mp-align-btn' + (lyrAlign === a.id ? ' on' : '')}
                          aria-pressed={lyrAlign === a.id}
                          aria-label={a.name + '对齐'}
                          onClick={() => setLyrAlign(a.id)}
                        >
                          {a.id === 'left' ? <IconAlignLeft width={15} height={15} />
                            : a.id === 'right' ? <IconAlignRight width={15} height={15} />
                            : <IconAlignCenter width={15} height={15} />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="imm-mp-lyricbody" data-panel={panel}>
                  {panel === 'comments' ? (
                    <Comments track={t} />
                  ) : foliaFx ? (
                    /*
                     * 手机也要 Folia。
                     *
                     * 之前这里写死成 `LyricsView`（注释还留着「手机上不用 Folia」），
                     * 于是「歌词动效」这个开关在手机上等于是死的：点了只会被踢到
                     * 桌面那套 `.imm-solo` 排版里，歌词页本身一点变化都没有。
                     *
                     * `flat` 是手机的形态：只保留「逐字弹出 + 唱到发光」，
                     * 前后句同一字号、不缩放、不倾斜、不虚化——Folia 原版那套按距离
                     * 缩放放到 360dp 上就是「一行大一行小」，正是用户吐槽过的。
                     */
                    <FoliaLyrics
                      doc={p.lyrics}
                      loading={p.lyricsLoading}
                      currentTime={p.snapshot.position}
                      progress={p.snapshot.duration > 0 ? p.snapshot.position / p.snapshot.duration : 0}
                      onSeek={seekToLine}
                      onSearchOnline={q => p.reloadLyrics(true, q)}
                      trackTitle={t.title || ''}
                      trackArtist={t.artist || ''}
                      live={open && pager === 'lyric'}
                      flat
                    />
                  ) : (
                    /* 关掉动效：标准歌词视图 + `scrollOverflow`，字号统一、长句不缩，
                       唱到哪个字就横向推到哪个字。对齐默认居中，可切。 */
                    <LyricsView
                      doc={p.lyrics}
                      loading={p.lyricsLoading}
                      currentTime={p.snapshot.position}
                      onSeek={seekToLine}
                      onSearchOnline={q => p.reloadLyrics(true, q)}
                      trackTitle={t.title || ''}
                      trackArtist={t.artist || ''}
                      align={lyrAlign}
                      immersive
                      rowH={56}
                      scrollOverflow
                      live={open && pager === 'lyric'}
                    />
                  )}
                </div>
              </section>
            </div>

            {/* 频谱横条·底部：夹在两页内容与操作行之间，不压按钮 */}
            {specBar && mSpecPos === 'bottom' && (
              <div className="imm-mp-specbar" data-pos="bottom" aria-hidden="true">
                <Spectrum
                  playing={p.snapshot.playing && open}
                  active={open}
                  variant={specStyle}
                  height={34}
                  barWidth={4}
                  gap={3}
                  maxBars={80}
                />
              </div>
            )}

            {/* 操作行 + 底部控制：两页共用，翻页时不动。
                评论面板例外——那一排（收藏/下载/评论/分享/更多）在评论区里
                没有任何用处，还占掉 54px 高度，把「加载更多」挤到屏幕外
                （用户：「评论页不需要展示播放按钮上面那一排按钮」）。
                **两栏（横屏）例外中的例外**：这时歌词页在右边、封面页在左边，
                这一排消失会让轨道长高 28，左栏居中的封面和歌名跟着往下跳
                （用户：「点评论左半屏也会跟着动」）。空间够，就让它常驻。 */}
            {(panel !== 'comments' || twoCol) && (
            <div className="imm-mp-acts" role="toolbar" aria-label="歌曲操作">
              <button
                className={'imm-mact' + (favs.has(t.id) ? ' on' : '')}
                aria-pressed={favs.has(t.id)}
                onClick={async () => {
                  const on = await favs.toggle(favRecOf(t))
                  toast(on ? '已收藏' : '已取消收藏', { ok: on })
                }}
              >
                {favs.has(t.id) ? <IconHeartFilled width={19} height={19} /> : <IconHeart width={19} height={19} />}
                <span>{favs.has(t.id) ? '已收藏' : '收藏'}</span>
              </button>
              <span className={'imm-mact imm-mact-dl imm-dl-wrap chip-menu up' + (p.online ? '' : ' off')}>
                <button
                  className="imm-mact-btn"
                  aria-label="下载"
                  aria-haspopup="menu"
                  aria-expanded={dlOpen}
                  disabled={!p.online}
                  onClick={() => setDlOpen(o => !o)}
                >
                  {dlBusy ? <span className="spin-ring sm" aria-hidden="true" />
                    : <IconDownload width={19} height={19} />}
                </button>
                <span>{dlDoneQs.size ? '已下载' : '下载'}</span>
                {dlOpen && dlPop}
              </span>
              <button className="imm-mact" onClick={() => { setPanel('comments'); setPager('lyric') }}>
                <IconComment width={19} height={19} />
                <span>评论</span>
              </button>
              <button className="imm-mact" onClick={() => void doShare()}>
                <IconShare width={19} height={19} />
                <span>分享</span>
              </button>
              <button className="imm-mact" onClick={() => setMoreOpen(true)}>
                <IconMore width={19} height={19} />
                <span>更多</span>
              </button>
            </div>
            )}

            {/* 底部固定区：进度 + 控制 + 音质胶囊。两页共用，不跟着翻页动——
                QQ 音乐那一屏也是这样，翻页时手指只掀上面的内容。 */}
            <div className="imm-mp-foot">
              <div className="imm-progress">
                <ProgressControl tall />
              </div>
              <div className="imm-mf-ctl">
                <div className="imm-mf-l">
                  <button className="icon-btn" aria-label="循环模式" onClick={p.cycleMode}
                    title={repeat === 'sequence' ? '顺序播放' : repeat === 'one' ? '单曲循环' : '随机播放'}>
                    <RepeatIcon width={18} height={18}
                      style={{ color: repeat !== 'sequence' ? 'var(--sy-accent-soft)' : undefined }} />
                  </button>
                  <button className="icon-btn imm-step" aria-label="上一首" onClick={goPrev}>
                    <IconPrev width={22} height={22} />
                  </button>
                </div>
                <button className="play-primary imm-play" aria-label={p.loading ? '正在加载' : p.snapshot.playing ? '暂停' : '播放'}
                  aria-busy={p.loading} onClick={p.togglePlay}>
                  {p.loading
                    ? <span className="spin-ring" aria-hidden="true" />
                    : p.snapshot.playing ? <IconPause width={22} height={22} /> : <IconPlay width={22} height={22} />}
                </button>
                <div className="imm-mf-r">
                  <button className="icon-btn imm-step" aria-label="下一首" onClick={goNext}>
                    <IconNext width={22} height={22} />
                  </button>
                  <button className="icon-btn imm-queue-btn" aria-label="播放队列" onClick={onOpenQueue}>
                    <IconQueueLines width={24} height={24} />
                  </button>
                </div>
              </div>
              <div className="imm-mf-pills">
                {/* 在线曲：这颗胶囊是**可点的**，点开挑音质（本地文件没有档位可换，保持只读） */}
                {p.online ? (
                  <button
                    className="imm-pill imm-pill-btn"
                    aria-haspopup="dialog"
                    aria-label={`音质：${p.onlineQuality ? qualityLabel(p.onlineQuality) : '在线'}，点按切换`}
                    title="切换音质"
                    onClick={() => setQualSheet(true)}
                  >
                    <IconSpeaker width={12} height={12} />
                    {p.onlineQuality ? qualityLabel(p.onlineQuality) : (p.onlineBusy ? '取链中' : '在线')}
                    <IconChevronDown width={10} height={10} />
                  </button>
                ) : (
                  <span className="imm-pill">
                    <IconSpeaker width={12} height={12} />
                    {[t.format?.toUpperCase(), t.bitrate && t.bitrate >= 32000 ? `${Math.round(t.bitrate / 1000)}k` : null].filter(Boolean).join(' · ') || '本地'}
                  </span>
                )}
                <span className="imm-pill muted">
                  {p.online
                    ? (cached ? '已缓存' : '流式播放')
                    : `本地 · ${t.size ? (t.size > 1024 * 1024 ? `${(t.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(t.size / 1024))} KB`) : '文件'}`}
                </span>
              </div>
            </div>
          </div>
        )}

        {t && !solo && !mobile && (
          <div
            className="imm-grid"
            data-view={vinylView ? 'vinyl' : 'cover'}
            /* 手机：art = 封面页，lyric = 整屏歌词页（左右滑动切换，见 pageGesture） */
            data-pager={pager}
            /* 切歌方向：CSS 据此给封面/曲目信息播一次左右滑入（见上方 slide） */
            data-slide={slide ?? undefined}
            {...pageGesture}
            /* 永远是两列：有没有歌词、在看哪一页，布局都不动——
               曾经没歌词会并成单列居中，用户反馈「晃来晃去的容易误点」 */
            data-tauri-drag-region
          >
            <section
              className="imm-art"
              data-tauri-drag-region
              /*
               * 点/滑封面这块**不能挂在 section 上**：section 里还有进度条、控制行、
               * 操作行，挂在这儿等于「点播放键也顺手切了页」（以前手机就是这样，
               * 点一下暂停顺便翻到歌词页）。所以手势只落在封面/唱片本体上。
               */
            >
              {vinylView ? (
                /* 黑胶：整块圆盘 + 唱臂。转动的是内层 `.imm-disc-spin`（含纹路与标签），
                   暂停时 animation-play-state: paused——不停在别的角度，看着才像「唱片停住了」 */
                <div
                  className="imm-disc"
                  data-playing={p.snapshot.playing && open ? 'true' : 'false'}
                  {...artGesture}
                  onClick={onArtTap}
                  role={!mobile ? 'button' : undefined}
                  tabIndex={!mobile ? 0 : undefined}
                  aria-label={!mobile ? '只看歌词' : undefined}
                  title={!mobile ? '点击只看歌词（再点右上角的「全屏歌词」回来）' : '点击看歌词 · 上下滑动切歌'}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onArtTap() } }}
                >
                  <div className="imm-disc-spin">
                    <div className="imm-disc-grooves" aria-hidden="true" />
                    <div className="imm-disc-label">
                      <Cover track={t} size={220} radius={999} fill />
                    </div>
                  </div>
                  <span className="imm-disc-hole" aria-hidden="true" />
                  <span className="imm-disc-gloss" aria-hidden="true" />
                  {/* 唱臂：暂停时抬到唱片外面（唱臂架），播放时压到外圈纹路上 */}
                  <svg className="imm-arm" viewBox="0 0 160 132" fill="none" aria-hidden="true">
                    <circle cx="30" cy="24" r="13" fill="#d7dae3" />
                    <circle cx="30" cy="24" r="5" fill="#8f95a5" />
                    <path d="M36 32 L104 100" stroke="#e6e8ef" strokeWidth="4" strokeLinecap="round" />
                    <path d="M98 94 L118 112" stroke="#cfd3dd" strokeWidth="9" strokeLinecap="round" />
                    <path d="M118 112 L124 118" stroke="#9aa1b1" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                </div>
              ) : (
                <div
                  className="imm-cover"
                  data-playing={p.snapshot.playing}
                  data-ring={specPos === 'cover' ? 'true' : 'false'}
                  {...artGesture}
                  onClick={onArtTap}
                  role={!mobile ? 'button' : undefined}
                  tabIndex={!mobile ? 0 : undefined}
                  aria-label={!mobile ? '只看歌词' : undefined}
                  title={!mobile ? '点击只看歌词（再点右上角的「全屏歌词」回来）' : '点击看歌词 · 上下滑动切歌'}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onArtTap() } }}
                >
                  <Cover track={t} size={300} radius={18} />
                  {/* pad 必须和 styles/immersive.css 里 .cover-ring 的 --ring-pad 一致，
                      否则柱子按更长的尺寸算，超出画布被裁成平头 */}
                  {specPos === 'cover' && <CoverRing playing={p.snapshot.playing && open} pad={100} variant={specStyle} />}
                </div>
              )}

              {/* 唱片模式把标题/专辑搬到右栏顶部（像一张唱片摆在那儿，右边是它的信息）；
                  封面模式没有右栏头部，标题才留在左列 */}
              {!vinylView && (
                <>
                  <h1 className="imm-title" title={t.title}>{t.title}</h1>
                  <p className="imm-artist">
                    {shownArtist || '未知歌手'}
                    {cov && <i className="imm-badge cov imm-cov" title={`这是翻唱版 · 原唱：${cov.original}`}>翻唱</i>}
                  </p>
                  <p className="imm-album">
                    {[t.album, t.year ? String(t.year) : null, t.format?.toUpperCase(), bitrate].filter(Boolean).join(' · ')}
                  </p>
                </>
              )}

              {/* 触屏：歌名 24/600 + 「歌手 · 专辑 · 格式 码率」（设计稿 02）。
                  拆成三个 span 是为了车机：设计稿 10 里歌手是 22 的一行，
                  专辑·格式是 15 的另一行；手机上它们只是同一行的三段，
                  中间的「 · 」由 .imm-m-sep 提供，车机上隐藏掉。 */}
              {mobile && (
                <div className="imm-meta-block">
                  <h1 className="imm-m-title">
                    <span>{t.title}</span>
                    {cov && <i className="imm-badge cov imm-cov" title={`这是翻唱版 · 原唱：${cov.original}`}>翻唱</i>}
                  </h1>
                  <p className="imm-m-sub">
                    <span className="imm-m-artist">{shownArtist || '未知歌手'}</span>
                    {rest.length > 0 && (
                      <>
                        <span className="imm-m-sep" aria-hidden="true"> · </span>
                        <span className="imm-m-rest">{rest.join(' · ')}</span>
                      </>
                    )}
                  </p>
                </div>
              )}

              {/* 手机 / 车机：5 颗 42 圆钮 + 10 号标签（设计稿 02 功能行）。
                  桌面那一排是音质/音效/频谱/视图芯片，触屏上既点不准也没必要暴露。 */}
              {mobile && (
                <div className="imm-acts" role="toolbar" aria-label="歌曲操作">
                  <button
                    className={'imm-act' + (favs.has(t.id) ? ' on' : '')}
                    aria-pressed={favs.has(t.id)}
                    onClick={async () => {
                      const on = await favs.toggle(favRecOf(t))
                      toast(on ? '已收藏' : '已取消收藏', { ok: on })
                    }}
                  >
                    {favs.has(t.id) ? <IconHeartFilled width={20} height={20} /> : <IconHeart width={20} height={20} />}
                    <span>{favs.has(t.id) ? '已收藏' : '收藏'}</span>
                  </button>
                  <span className={'imm-act imm-act-dl imm-dl-wrap chip-menu up' + (p.online ? '' : ' off')}>
                    <button
                      className="imm-act-btn"
                      aria-label="下载"
                      aria-haspopup="menu"
                      aria-expanded={dlOpen}
                      disabled={!p.online}
                      onClick={() => setDlOpen(o => !o)}
                    >
                      {dlBusy ? <span className="spin-ring sm" aria-hidden="true" />
                        : <IconDownload width={20} height={20} />}
                    </button>
                    <span>{dlDoneQs.size ? '已下载' : '下载'}</span>
                    {dlOpen && dlPop}
                  </span>
                  <button className="imm-act" onClick={() => { setPanel('comments'); if (mobile) setPager('lyric') }}>
                    <IconComment width={20} height={20} />
                    <span>评论</span>
                  </button>
                  <button className="imm-act" onClick={() => void doShare()}>
                    <IconShare width={20} height={20} />
                    <span>分享</span>
                  </button>
                  <button className="imm-act" onClick={() => setMoreOpen(true)}>
                    <IconMore width={20} height={20} />
                    <span>更多</span>
                  </button>
                </div>
              )}

              {/* 封面页的歌词带（设计稿 02 那三行）：上一句暗、当前句亮、下一句暗。
                  点击进整屏歌词页。没有歌词也占位——收起来的话下面会整体往下跳。 */}
              {mobile && pager === 'art' && (
                <div
                  className="imm-mini-lyrics"
                  data-empty={miniCur ? 'false' : 'true'}
                  role="button"
                  tabIndex={0}
                  aria-label="查看整屏歌词"
                  onClick={() => setPager('lyric')}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPager('lyric') } }}
                >
                  {miniCur ? (
                    <>
                      <div className="iml-prev">{miniPrev || '\u00a0'}</div>
                      <div className="iml-cur">{miniCur}</div>
                      <div className="iml-next">{miniNext || '\u00a0'}</div>
                    </>
                  ) : (
                    <div className="iml-empty">
                      <span className="iml-empty-t">{p.lyricsLoading ? '歌词加载中…' : '暂无歌词'}</span>
                      {!p.lyricsLoading && <span className="iml-empty-s">点这里去搜歌词</span>}
                    </div>
                  )}
                </div>
              )}

              {/* 接下来播放（用户：「空的地方你看看再加点什么」）。
                  放进「下一首是谁」这件事本身，比一根分隔线有用；点开就是完整队列。
                  两行：上行「接下来播放 · 歌手」，下行歌名——52 高正好，不挤。 */}
              {mobile && pager === 'art' && (
                <button className="imm-upnext" onClick={onOpenQueue} aria-label="打开播放队列">
                  {nextTrack && (
                    <span className="un-cover">
                      <Cover track={nextTrack} size={34} radius={9} />
                    </span>
                  )}
                  <span className="un-meta">
                    <span className="un-lbl">
                      {nextTrack
                        ? `接下来播放${nextTrack.artist ? ` · ${nextTrack.artist}` : ''}`
                        : p.queueState.repeat === 'shuffle'
                          ? '随机播放'
                          : '已是最后一首'}
                    </span>
                    <span className="un-name">
                      {nextTrack
                        ? nextTrack.title
                        : `队列 ${p.queueState.queue.length} 首`}
                    </span>
                  </span>
                  <IconQueueLines width={18} height={18} />
                </button>
              )}

              <div className="imm-progress">
                <ProgressControl tall />
              </div>

              {/*
                * 三格网格：左（循环+上一首）/ 中间（播放键）/ 右（下一首+下载+音量）。
                * 以前是一排 flex，左边两颗、右边四颗，播放键实际偏左 60 多 px，
                * 跟上面的封面中线对不上，整排看着是歪的。1fr auto 1fr 把播放键
                * 钉死在列中线上，两侧各自靠向自己那一侧。
                */}
              <div className="imm-ctl">
                <div className="imm-ctl-l">
                  <button className="icon-btn" aria-label="循环模式" onClick={p.cycleMode}
                    title={repeat === 'sequence' ? '顺序播放' : repeat === 'one' ? '单曲循环' : '随机播放'}>
                    <RepeatIcon width={18} height={18}
                      style={{ color: repeat !== 'sequence' ? 'var(--sy-accent-soft)' : undefined }} />
                  </button>
                  <button className="icon-btn imm-step" aria-label="上一首" onClick={goPrev}>
                    <IconPrev width={22} height={22} />
                  </button>
                </div>
                <button className="play-primary imm-play" aria-label={p.loading ? '正在加载' : p.snapshot.playing ? '暂停' : '播放'}
                  aria-busy={p.loading} onClick={p.togglePlay}>
                  {p.loading
                    ? <span className="spin-ring" aria-hidden="true" />
                    : p.snapshot.playing ? <IconPause width={22} height={22} /> : <IconPlay width={22} height={22} />}
                </button>
                <div className="imm-ctl-r">
                  <button className="icon-btn imm-step" aria-label="下一首" onClick={goNext}>
                    <IconNext width={22} height={22} />
                  </button>
                  {/* 设计稿控制行右侧是「队列」（桌面版的队列在工具带里，手机没有那一条） */}
                  {mobile && (
                    <button className="icon-btn imm-queue-btn" aria-label="播放队列" onClick={onOpenQueue}>
                      <IconQueueLines width={24} height={24} />
                    </button>
                  )}
                  {/* 手机上下载入口在操作行，这里不再挂第二个（同一份状态会弹两层） */}
                  {!mobile && dlMenu}
                  <span className="imm-vol" ref={volRef}>
                    <button
                      className="icon-btn"
                      aria-label={p.muted ? '取消静音' : '静音'}
                      aria-pressed={p.muted}
                      onClick={p.toggleMute}
                    >
                      {vol === 0 ? <IconVolumeMute width={17} height={17} /> : <IconVolume width={17} height={17} />}
                    </button>
                    <input
                      className="slider" type="range" min={0} max={1} step={0.01} value={vol}
                      aria-label="音量"
                      onChange={e => p.setVolume(Number(e.target.value))}
                    />
                  </span>
                </div>
              </div>

              {quick}

              {/* 底部两枚胶囊（设计稿 02）：左边音质、右边缓存状态。
                  本地曲目本来就在磁盘上，「已缓存」对它是句废话——改写文件大小。 */}
              {mobile && (
                <div className="imm-pills">
                  <span className="imm-pill">
                    <IconSpeaker width={12} height={12} />
                    {p.online
                      ? (p.onlineQuality ? qualityLabel(p.onlineQuality) : (p.onlineBusy ? '取链中' : '在线'))
                      : [t.format?.toUpperCase(), t.bitrate && t.bitrate >= 32000 ? `${Math.round(t.bitrate / 1000)}k` : null].filter(Boolean).join(' · ') || '本地'}
                  </span>
                  <span className="imm-pill muted">
                    {p.online
                      ? (cached ? '已缓存' : '流式播放')
                      : `本地 · ${t.size ? (t.size > 1024 * 1024 ? `${(t.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(t.size / 1024))} KB`) : '文件'}`}
                  </span>
                </div>
              )}

              <div className="imm-meta-line">
                <button className="link-btn" data-panel-toggle onClick={onOpenDetail}>
                  <IconInfo width={13} height={13} /> 歌曲详情
                </button>
                <span className="imm-dur num">{fmtTime(p.snapshot.position)} / {fmtTime(p.snapshot.duration || t.duration)}</span>
              </div>
            </section>

            {/* 右栏永远在场：歌词 / 评论 / 「暂无歌词」占的都是同一块地方，
                布局不随有没有歌词变化（用户：不要晃来晃去、容易误点）。
                「暂无歌词 + 在线搜索歌词」由 LyricsView / FoliaLyrics 的空态渲染，
                位置和看歌词时完全一致。 */}
            <section className="imm-lyric" data-tauri-drag-region>
                {/* 唱片模式的右栏顶部：标题 + 专辑/歌手/来源 + 标签行。
                    照「一张唱片 + 它的说明」排，歌词从下面接着往下走。 */}
                {vinylView && (
                  <header className="imm-head">
                    <h1 className="imm-head-title" title={t.title}>
                      <span className="imm-head-name">{t.title}</span>
                      <span className="imm-badges">
                        {cov && <i className="imm-badge cov" title={`这是翻唱版 · 原唱：${cov.original}`}>翻唱</i>}
                        {p.online && (
                          <i className="imm-badge">{p.onlineQuality ? qualityLabel(p.onlineQuality) : '在线'}</i>
                        )}
                        {bitrate && <i className="imm-badge">{bitrate.replace(/\s*kbps/i, '')}</i>}
                        {!p.online && t.format && <i className="imm-badge">{t.format.toUpperCase()}</i>}
                      </span>
                    </h1>
                    <p className="imm-head-meta">
                      <span>专辑：{t.album || '—'}</span>
                      <span title={actual ? `原曲目歌手：${t.artist || '未知'}（这一条来自兜底平台）` : undefined}>
                        歌手：{shownArtist || '未知歌手'}
                      </span>
                      {/* 兜底到的版本连歌名都不一样时也要说清楚，不然「名字」这一栏还是假的 */}
                      {actual && shownTitle && shownTitle !== t.title && (
                        <span>实际曲目：{shownTitle}</span>
                      )}
                      <span>
                        来源：
                        {p.online
                          ? [p.onlineVia, p.onlineSource].filter(Boolean).join(' · ') || '在线'
                          : '本地'}
                      </span>
                    </p>
                    <div className="imm-tagrow">
                      <button className={'imm-tag' + (panel === 'lyric' ? ' on' : '')}
                        onClick={() => setPanel('lyric')}>歌词</button>
                      <button className={'imm-tag' + (panel === 'comments' ? ' on' : '')}
                        onClick={() => setPanel('comments')}>评论</button>
                      <button className="imm-tag" onClick={onOpenDetail}>歌曲详情</button>
                      <button className="imm-tag" onClick={onOpenQueue}>播放列表</button>
                    </div>
                  </header>
                )}
                {/* 标签行原本只挂在唱片模式的头部里。关掉唱片视图后右栏就没有
                    「歌词 / 评论」的入口了，评论功能等于消失——非唱片模式补一行。
                    手机上这行还是**翻页入口**：点「歌词 / 评论」都翻到整屏那一页
                    （封面页只看封面，歌词页才看内容），和左滑是同一个动作。 */}
                {!vinylView && (
                  <div className="imm-tagrow imm-tabrow-solo">
                    <button className={'imm-tag' + (panel === 'lyric' ? ' on' : '')}
                      onClick={() => { setPanel('lyric'); if (mobile) setPager('lyric') }}>歌词</button>
                    <button className={'imm-tag' + (panel === 'comments' ? ' on' : '')}
                      onClick={() => { setPanel('comments'); if (mobile) setPager('lyric') }}>评论</button>
                  </div>
                )}
                {/* Folia 是「歌词渲染方式」，不是「沉浸式专属」：只要开了动效，
                    右侧这栏也要用它，否则会出现「Folia 开着却完全没效果」的错觉 */}
                <div className="imm-lyric-body">
                  {panel === 'comments' ? (
                    <Comments track={t} />
                  ) : foliaFx ? (
                    <FoliaLyrics
                      doc={p.lyrics}
                      loading={p.lyricsLoading}
                      currentTime={p.snapshot.position}
                      progress={p.snapshot.duration > 0 ? p.snapshot.position / p.snapshot.duration : 0}
                      onSeek={seekToLine}
                      onSearchOnline={q => p.reloadLyrics(true, q)}
                      trackTitle={t.title || ''}
                      trackArtist={t.artist || ''}
                      /* 桌面是两列布局，`pager` 只在手机上有意义——这里别跟着它判 */
                      live={open && (!mobile || pager === 'lyric')}
                    />
                  ) : (
                    <LyricsView
                      doc={p.lyrics}
                      loading={p.lyricsLoading}
                      currentTime={p.snapshot.position}
                      onSeek={seekToLine}
                      onSearchOnline={q => p.reloadLyrics(true, q)}
                      trackTitle={t.title || ''}
                      trackArtist={t.artist || ''}
                      /* 右栏这块很宽：按用户选的对齐方式贴边，
                         长句不缩字号、唱到那句时横向滚动 */
                      align={lyrAlign}
                      scrollOverflow
                      live={open && (!mobile || pager === 'lyric')}
                    />
                  )}
                </div>
                {/* 歌词对齐：三个图标（居左 / 居中 / 居右），摆在歌词区右下角 */}
                {panel === 'lyric' && !noLyric && !foliaFx && (
                  <div className="imm-lyrbar">
                    <div className="imm-align" role="group" aria-label="歌词对齐">
                      {LYRIC_ALIGN_LIST.map(a => (
                        <button
                          key={a.id}
                          type="button"
                          className={'imm-align-btn' + (lyrAlign === a.id ? ' on' : '')}
                          aria-pressed={lyrAlign === a.id}
                          aria-label={a.name + '对齐'}
                          title={'歌词' + a.name}
                          onClick={() => setLyrAlign(a.id)}
                        >
                          {a.id === 'left' ? <IconAlignLeft width={15} height={15} />
                            : a.id === 'center' ? <IconAlignCenter width={15} height={15} />
                              : <IconAlignRight width={15} height={15} />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>

          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={immMenu} onClose={() => setMenu(null)} />}

      {/* 手机 / 车机「更多」：设计稿 06 的底部面板。
          动作是「对**这一首**做的事」——收藏 / 添加到歌单 / 下载 / 分享。
          ·
          · 这里原本第一颗是「下一首播放」，是个 bug：面板永远只描述**正在播的那首**，
          · 对正在播的歌说「下一首播放」讲不通（用户原话：「明明已经在播了」）。
          · 想「下一首播放」是列表里的行才有的语义，那里长按/右键本来就有。
          ·
          · 下半部分除了队列入口，新加两个**开关**：频谱可视化 / Folia 歌词动效。
          · 桌面上这两项是页头右上角的下拉芯片，手机上那排芯片整个藏起来了，
          · 于是「手机没有开频谱 / 开 Folia 的地方」——只能从设置页翻。 */}
      <ActionSheet
        open={moreOpen && !!t}
        title={t?.title ?? ''}
        sub={t ? [shownArtist || '未知歌手', t.album].filter(Boolean).join(' · ') : ''}
        cover={t ? <Cover track={t} size={44} radius={10} /> : undefined}
        actions={t ? [
          {
            id: 'fav', label: '收藏',
            icon: t && favs.has(t.id) ? <IconHeartFilled width={20} height={20} /> : <IconHeart width={20} height={20} />,
            on: favs.has(t.id),
            onClick: async () => {
              const on = await favs.toggle(favRecOf(t))
              toast(on ? '已收藏' : '已取消收藏', { ok: on })
            },
          },
          { id: 'addpl', label: '添加到歌单', icon: <IconMusicNote width={20} height={20} />, onClick: () => setAddTo([t.id]) },
          {
            id: 'dl', label: '下载', icon: <IconDownload width={20} height={20} />,
            disabled: !p.online,
            onClick: () => void doDownload(p.onlineQuality ?? undefined),
          },
          { id: 'share', label: '分享', icon: <IconShare width={20} height={20} />, onClick: () => void doShare() },
        ] : []}
        rows={t ? [
          /* 音质：以前手机上完全没有入口（桌面那颗芯片在触屏上藏起来了）。
             现在「更多」和底部胶囊都能点到这里。 */
          {
            id: 'qual',
            label: `音质 · ${p.online ? (p.onlineQuality ? qualityLabel(p.onlineQuality) : '取链中') : '本地'}`,
            chevron: true,
            disabled: !p.online,
            onClick: () => setQualSheet(true),
          },
          {
            id: 'spec', label: '频谱可视化', sw: true, on: specOn, keepOpen: true,
            onClick: () => {
              const next = !specOn
              setSpecOn(next)
              toast(next ? '频谱已开启' : '频谱已关闭')
            },
          },
          {
            /*
             * 频谱的样式与位置：手机以前只能看默认那一圈（设置页那段还只对桌面渲染）。
             * 这一行点开是独立弹层，样式六种 + 位置三种，改完立刻能看到。
             */
            id: 'specset',
            label: `频谱样式 · ${spectrumStyleName(specStyle)}`,
            chevron: true,
            onClick: () => setSpecSheet(true),
          },
          {
            id: 'folia', label: '歌词动效', sw: true, on: foliaFx, keepOpen: true,
            onClick: () => {
              const next = !foliaFx
              setFoliaFx(next)
              if (!next) return
              /* 打开就跳去看得到效果的那一页：桌面 → 全屏歌词，手机 → 歌词页。
                 手机上绝不能进 `.imm-solo`（那是桌面排版，进去等于「页面坏了」）。 */
              if (mobile) setPager('lyric')
              else setSolo(true)
            },
          },
          /* 安卓专属：真正的悬浮窗歌词（其他应用上层），开关在原生侧持久。
             名字说的是它实际的样子——浮在桌面/别的应用上，就是「桌面歌词」 */
          ...(isAndroid ? [{
            id: 'float', label: '桌面歌词', sw: true, on: floatOn, keepOpen: true,
            onClick: toggleFloat,
          }] : []),
          /* 锁屏播放页搬去设置页了：它是「系统层面的一个开关」，
             和收藏/下载这些「对这首歌做什么」的动作不是一类，
             而且以前打开它还会立刻把锁屏页弹出来（用户明确不要这个预览）。 */
          { id: 'queue', label: '播放队列', chevron: true, onClick: onOpenQueue },
          { id: 'detail', label: '歌曲详情', chevron: true, onClick: onOpenDetail },
          { id: 'rm', label: '从队列移除', danger: true, onClick: () => p.remove(t.id) },
        ] : []}
        onClose={() => setMoreOpen(false)}
      />

      {/* 音质选择（手机：点底部那颗「高品质」胶囊；更多面板里也有一行入口）。
          只列这首歌**真实有**的档位：平台没给的档位列出来也是点不动。
          正在播的那档如果不在列表里（自动降档 / 换过平台），补一条进去，
          否则面板里一个勾都没有，看着像「音质未知」。 */}
      <ActionSheet
        open={qualSheet && !!t}
        title="音质"
        sub={t ? [t.title, shownArtist || '未知歌手'].filter(Boolean).join(' · ') : ''}
        cover={t ? <Cover track={t} size={44} radius={10} /> : undefined}
        rows={!t ? [] : !p.online ? [
          { id: 'local', label: '本地文件，没有可选档位', disabled: true },
        ] : [
          ...(p.onlineQuality && !p.onlineQualities.includes(p.onlineQuality)
            ? [{ id: p.onlineQuality, label: qualityLabel(p.onlineQuality), checked: true }]
            : []),
          ...qualityChoicesFor(p.onlineQualities).map(q => ({
            id: q,
            label: qualityLabel(q),
            checked: q === p.onlineQuality,
            onClick: q === p.onlineQuality ? undefined : () => p.changeQuality(q),
          })),
          ...(p.onlineQualities.length === 0
            ? [{ id: 'pending', label: p.onlineBusy ? '正在取播放地址…' : '这首歌的档位还没拿到', disabled: true }]
            : []),
        ]}
        onClose={() => setQualSheet(false)}
      />

      {/* 频谱设置（样式 + 位置）：从「更多」面板里点开。
          z-index 比 ActionSheet 高一点，两个弹层交接时不会互相压住 */}
      <SpectrumSheet open={specSheet} onClose={() => setSpecSheet(false)} />

      <AddToPlaylistDialog
        open={!!addTo}
        trackIds={addTo ?? []}
        onClose={() => setAddTo(null)}
        onDone={msg => toast(msg, { ok: true })}
      />
    </div>
  )
}
