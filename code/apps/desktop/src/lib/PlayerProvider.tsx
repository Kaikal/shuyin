/**
 * 播放器状态：Rust 侧是唯一真相源，前端只持有快照 + 队列 UI 状态。
 * 队列（曲目顺序）是 UI 概念，由前端 PlaybackQueue 状态机管理；
 * 播放（progress/volume/playing）经事件流从 Rust 同步。
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import {
  advance, clearQueue, currentTrack, cycleRepeat, enqueue, initialQueueState,
  playTracks, removeFromQueue, reorderQueue, skipNext, skipPrev,
  type LocalTrack, type LyricsDoc, type QueueState, type RepeatMode,
} from '@shuyin/core'
import { bridge, isAndroid, type ScanProgressPayload, type ScanScope } from './bridge'
import { lastKnownPlayerState } from './native/android'
import { forceOnlineLyrics, loadLyrics, lyricAt } from './lyrics'
import { KEYS, SCAN_VERSION, settings } from './settings'
import { NoPlayableSourceError, type PlatformSource } from '@shuyin/lx-provider'
import { favRecOf, useFavs } from './favTracks'
import { recordHistory } from './history'
import {
  coverForTrack, effectiveSong, ensureRegistry, forgetSubstitute, getPreferredQuality, isCacheCopyTrack, isOnlineTrack, onlineLyric, pinSongs,
  qualityDropMatters, resolvePlayUrl, setPreferredQuality, songOf, sourceManager, trackOfId,
  usableQualities,
} from './online'
import { cachedAudio, cachedAudioQuality, dropCachedAudio, hasCachedAudio, warmCache } from './audioCache'
import { cachedCoverPath, cachedLyric, rememberCover, rememberLyric, mediaCacheVersion } from './mediaCache'
import { isIOS } from './shellMode'
import { liveArtOf } from './liveArt'
import { installIdleTracking, userActive, waitIdle } from './idle'
import { diag } from './diag'
import { parseLrc, plainLyricLines } from '@shuyin/core'

export interface PlayerSnapshot {
  playing: boolean
  position: number
  duration: number
  volume: number
  /** 在线曲目已缓冲到的秒数（本地恒 0），进度条画淡色第二层用 */
  buffered: number
}

/**
 * 队列的「内容指纹」。
 *
 * **不能用 `q.queue !== other.queue` 判断「队列变了没有」**：`commitQueue` 每次都
 * 产出新对象，引用永远不相等。2026-11-17 真机日志里的后果是补表自激：
 *
 *   一轮取链还没结束 → 定时器递来同队列的 pending → 收尾时按引用判定「变了下标」
 *   → 立刻重算 → 新一轮 `++prefetchSeq` 把上一轮作废 → `pf abort 被新一轮顶掉`
 *   连着出现，**一张表都递不出去**，原生 `pf` 恒为 0（用户看到的「只循环两首」）。
 *
 * 用内容比：下标 / 循环模式 / 顺序 / 每首的 id。
 */
function queueFingerprint(q: QueueState): string {
  return `${q.index}|${q.repeat}|${q.order}|${q.queue.map(t => t.id).join(',')}`
}

/**
 * 定时关闭的状态（安卓原生是唯一真相，见 apps/android/.../SleepTimer.kt）。
 *
 * `remain` 是**剩余秒数**，不是时间戳：原生每秒对一次墙钟，前端拿到的就是
 * 「还剩多久」，不用自己算 `endAt - now`（那还要处理系统时间被改的情况）。
 */
export interface SleepState {
  on: boolean
  /** 等当前这首放完就停（没有时间点） */
  track: boolean
  remain: number
}

interface PlayerCtx {
  queueState: QueueState
  current: LocalTrack | null
  snapshot: PlayerSnapshot
  scanning: boolean
  scanProgress: ScanProgressPayload | null
  library: LocalTrack[]
  libraryVersion: number
  lastScanAt: number | null
  /** 最近一次扫描覆盖的根目录 */
  lastRoots: string[]
  /** 上次扫描跳过的无效文件数（非音频 / 过短 / 录音） */
  lastSkipped: number
  /** 上次扫描是否被保护上限截断 */
  lastTruncated: boolean
  scanScope: ScanScope
  playList(tracks: LocalTrack[], index: number): void
  /** 单曲播放：已在队列就跳过去，否则追加到末尾再播（不替换现有队列） */
  playOne(track: LocalTrack): void
  next(): void
  prev(): void
  togglePlay(): void
  seek(secs: number): void
  setVolume(v: number): void
  /**
   * 是否静音。
   *
   * 以前是各控件自己的一个 `useState`，只把**显示**的音量算成 0——图标变静音、
   * 滑杆归零，但播放器那边一点没动，声音照旧。用户点下去只会觉得按钮坏了。
   * 现在由这里统一：静音 = 真的把输出音量压到 0，取消时回到压之前的值。
   */
  muted: boolean
  /** 静音 / 取消静音（真正调音量，见上） */
  toggleMute(): void
  /**
   * 增量调音量（鼠标滚轮、多媒体键）。
   *
   * 和 `setVolume` 的区别只在静音态：直接拿 `snapshot.volume`（=0）做基准的话，
   * 静音时滚一下是从 0 爬到 0.05，几乎听不见；这里改用静音前的音量做基准。
   */
  nudgeVolume(delta: number): void
  cycleMode(): void
  setScrubbing(b: boolean): void
  addToQueue(track: LocalTrack, position: 'end' | 'next'): void
  /** 批量加入队列（本地音乐页多选） */
  addManyToQueue(tracks: LocalTrack[], position: 'end' | 'next'): void
  reorder(from: number, to: number): void
  remove(id: string): void
  /** 批量从曲库移除（不会删除磁盘文件） */
  removeTracks(ids: string[]): Promise<void>
  clear(): void
  refreshLibrary(): Promise<void>
  /** 扫描：fast（音乐文件夹）/ full（全盘）/ custom（指定目录） */
  scan(scope: ScanScope, dirs?: string[]): Promise<void>
  rescan(): Promise<void>
  removeTrack(id: string): Promise<void>
  /** 播放失败提示（一次性；UI 读走后自动清理） */
  lastError: string | null
  clearError(): void
  /**
   * **用户按「停止」**：把这一轮取链连同它派生出来的自动行为一起撤掉。
   *
   * 取链失败之后，前端会自己排两件事：6 秒后×2 的「网回来再试」，以及 3 秒后的
   * 「自动切下一首」。如果一首都播不了（iOS 没导音源、断网），这两件事会互相
   * 接着来，用户看到的是「一直在加载 / 自己一首首往下跳」，界面上却没有任何
   * 能把它停下来的按钮——`clearError` 只是把红条收掉，机器还在底下转。
   * 这个函数是那颗真正能停的按钮：清定时器、作废在途结果、禁掉后续自动动作、
   * 再让原生停掉。
   */
  stopPlayback(): void
  /** 当前曲目的歌词（本地 lrc/内嵌 → 在线兜底），全应用共用一份 */
  lyrics: LyricsDoc | null
  lyricsLoading: boolean
  /** 重新取歌词；force=true 时强制走在线搜索；`q` 是用户手动填的歌名 / 歌手 */
  reloadLyrics(force?: boolean, q?: { title?: string; artist?: string }): void
  /** 当前是否在线曲目 */
  online: boolean
  /**
   * 正在加载音频（起播前的解码 / 在线取链 + 首段拉流）。
   * 播放按钮据此显示转圈，否则用户看到「未播放」会一直点播放。
   */
  loading: boolean
  /** 在线取链中的状态（换源 / 音质切换时也会亮） */
  onlineBusy: boolean
  /** 实际生效的音源名与音质档位（音源可能静默降级，这里是真实档位；音质存原始 key，如 320k） */
  onlineSource: string | null
  onlineQuality: string | null
  /** 当前平台可选的音质档位（来自音源脚本声明；不在列表里的档位置灰） */
  onlineQualities: string[]
  /**
   * 实际出链的平台名。跨平台兜底成功时**不等于**用户搜索时那个平台，
   * 播放条 / 播放页据此显示「其实是从哪来的」。
   */
  onlineVia: string | null
  /**
   * 跨平台兜底时，**真正在放的那条音频**的歌名/歌手。
   *
   * 兜底到别的平台，找到的可能不是同一个人的版本（翻唱 / 重制）。这时界面上的
   * 歌手如果还写着原曲目的人，就成了「名不副实」——这个字段让播放页可以显示
   * 真正在唱的人。只有歌手确实不同时才有值，正常播放是 null。
   */
  onlineActual: { name: string; singer: string } | null
  /** 非阻断的「已自动处理」提示（降档 / 换平台），和红色错误条分开 */
  onlineNotice: string | null
  clearNotice(): void
  /** 换一个音源重试当前曲目 */
  switchSource(): void
  /** 原地重试当前曲目（网络刚恢复、取链超时用；不拉黑音源） */
  retryCurrent(): void
  /** 换音质并从当前进度继续 */
  changeQuality(q: string): void
  /**
   * 定时关闭（安卓）。
   *
   * 传分钟数、`'track'`（播完这首）或 `null`（取消）。**返回后不等结果**：
   * 原生会把新状态塞进接下来的 `player://state`，这里只负责发命令。
   */
  sleep: SleepState
  setSleep(min: number | 'track' | null): void
  /** 音量保护（起播淡入 / 暂停淡出 / 被压低后缓慢回升），安卓原生执行 */
  audioGuard: boolean
  setAudioGuard(on: boolean): void
}

/**
 * 「已加载曲目」的标识：本地用路径，在线用 id。
 * 在线曲目的 path 是空串，拿 path 比较会导致每帧都判定「需要重新加载」。
 */
const trackKey = (t: LocalTrack): string => (isOnlineTrack(t) ? t.id : t.path)

/**
 * 曲库里不该出现的条目：旧版误落盘的播放缓存副本（`online_<平台>_<id>.mp3`）。
 *
 * 壳那边已经不再收录（`Library.kt`），但**已经写进 `library.json` 的旧条目还在**，
 * 而 `Library.tracks()` 优先读那份缓存。所以前端在每次拿曲库时再筛一遍：
 * 用户不需要为此重扫一次全库，也不必等下次装包。
 */
const cleanLibrary = (list: LocalTrack[]): LocalTrack[] =>
  list.some(t => isCacheCopyTrack(t)) ? list.filter(t => !isCacheCopyTrack(t)) : list

const Ctx = createContext<PlayerCtx | null>(null)

export function usePlayer(): PlayerCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('usePlayer must be used within PlayerProvider')
  return c
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [queueState, setQueueState] = useState<QueueState>(initialQueueState)
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>({ playing: false, position: 0, duration: 0, volume: 0.8, buffered: 0 })
  /**
   * 定时关闭 / 音量保护（**安卓专属**，原生执行）。
   *
   * 状态由 `player://state` 每帧带回（原生是唯一真相）：这样连「设置完之后
   * WebView 被系统冻住」这种情况也是对的——定时器在原生那边照走，
   * 前端醒来读到的就是真实剩余时间。
   */
  const [sleep, setSleepState] = useState<SleepState>({ on: false, track: false, remain: 0 })
  const [audioGuard, setAudioGuardState] = useState(true)
  /** 静音开关（真值：`snapshot.volume` 此时就是 0） */
  const [muted, setMuted] = useState(false)
  /**
   * 静音前的音量。
   *
   * 用 ref 不用 state：它只在「取消静音」和「静音态下滚轮」两个瞬间被读，
   * 变化不需要重渲染；当 state 用反而会让 `value` 的 useMemo 多一条依赖。
   */
  const lastVolRef = useRef(0.8)
  /** `toggleMute` 里判当前状态用；`muted` 的闭包在 useCallback([]) 里永远是 false */
  const mutedRef = useRef(false)
  const [library, setLibrary] = useState<LocalTrack[]>([])
  const [libraryVersion, setLibraryVersion] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgressPayload | null>(null)
  const [lastScanAt, setLastScanAt] = useState<number | null>(null)
  const [lastRoots, setLastRoots] = useState<string[]>([])
  const [lastSkipped, setLastSkipped] = useState(0)
  const [lastTruncated, setLastTruncated] = useState(false)
  const [scanScope, setScanScope] = useState<ScanScope>('fast')
  const [lastError, setLastError] = useState<string | null>(null)
  const [lyrics, setLyrics] = useState<LyricsDoc | null>(null)
  const [lyricsLoading, setLyricsLoading] = useState(false)
  /**
   * 加载态：只在**用户能感知到等待**的时候亮（延迟 220ms 再显示，
   * 本地文件几十毫秒就出声，没必要闪一下转圈）。
   * 结束条件见 onPlayerEvent：出声 / 有时长 / 报错 / 超时兜底。
   */
  const [loading, setLoading] = useState(false)
  const loadingTimer = useRef(0)
  const loadingGuard = useRef(0)
  /** 正在进行一次加载（startLoad 起、出声/出错/超时止） */
  const loadingRef = useRef(false)
  /** 这次加载预期的时长：用来判断「Rust 报的时长已经是新曲目了」 */
  const loadExpect = useRef(0)
  const startLoading = useCallback((immediate = false) => {
    loadingRef.current = true
    window.clearTimeout(loadingTimer.current)
    /*
     * 本地文件几十毫秒就出声，220ms 后再亮转圈（闪一下反而像卡了）。
     * 在线曲目要先取链、再探活，一两秒才出声：点下去就得看见「在加载」。
     */
    if (immediate) setLoading(true)
    else loadingTimer.current = window.setTimeout(() => setLoading(true), 220)
    // 兜底：真卡死（网络挂住）也不能永远转圈
    window.clearTimeout(loadingGuard.current)
    loadingGuard.current = window.setTimeout(() => {
      /*
       * 15 秒没等到「出声 / 时长 / 报错」：**先跟原生对一次账**。
       *
       * 这一步是必须的：`player://state` 事件一旦断供（订阅没建起来、
       * WebView 被系统冻过一段），前端就再也不知道自己该不该结束加载，
       * 于是「取链中…」永远挂在播放条上，而 `loadingRef` 会让
       * 播放/暂停那颗键**一点反应都没有**（就是用户说的「点了都没反应」）。
       * 原生手里有真相：它说在放、或者已经有长度，就说明这次加载其实成了。
       */
      /*
       * **先无条件收掉转圈**，再去对账。
       *
       * 顺序不能反：兜底的全部意义是「无论如何让用户能继续操作」，
       * 一旦被 `await` 拖住（原生那边命令排队、`player_state` 迟迟不回），
       * 转圈就永远停在那里、`loadingRef` 永远为 true —— 按钮彻底变死。
       * 这一步以前是同步的两行赋值，改成异步之后必须保住这个性质。
       */
      loadingRef.current = false
      setLoading(false)
      void bridge.playerState().then(st => {
        /* 原生其实在放 / 已经有长度：说明这次加载是成的，只是事件没送到，别报错 */
        if (st.playing || st.duration > 0) return
        setLastError('「正在解析播放地址」卡住了：网络或音源没响应，再点一次播放试试')
      }).catch(() => {})
    }, 15000)
  }, [])
  const stopLoading = useCallback(() => {
    loadingRef.current = false
    window.clearTimeout(loadingTimer.current)
    window.clearTimeout(loadingGuard.current)
    setLoading(false)
  }, [])
  const [onlineBusy, setOnlineBusy] = useState(false)
  const [onlineSource, setOnlineSource] = useState<string | null>(null)
  const [onlineQuality, setOnlineQuality] = useState<string | null>(null)
  /** 同步给 changeQuality 判断「点的是不是正在播的档位」——ref 不触发重渲染 */
  const onlineQualityRef = useRef<string | null>(null)
  useEffect(() => { onlineQualityRef.current = onlineQuality }, [onlineQuality])
  const [onlineVia, setOnlineVia] = useState<string | null>(null)
  const [onlineActual, setOnlineActual] = useState<{ name: string; singer: string } | null>(null)
  const [onlineNotice, setOnlineNotice] = useState<string | null>(null)
  /** 当前曲目实际用的音源 id（换源时要排除它） */
  const lastSourceId = useRef<string | null>(null)
  /**
   * 当前在线曲目已失败的音源 id（换源时排除，避免反复试同一个死源）。
   * 带上曲目标识：换歌必须复位，否则会一直排除上一个曲目的失败源。
   */
  const excluded = useRef<{ key: string; ids: string[] }>({ key: '', ids: [] })
  /** 在线取链的串行锁：连点两首时后发的请求要能取消前一个对状态的写入 */
  const onlineSeq = useRef(0)
  const scrubRef = useRef(false)
  /** 当前曲目是否在线——失败处理要区分：在线取链失败不自动跳歌 */
  const curOnlineRef = useRef(false)
  const lastPlayedIndex = useRef(-1)
  /** 连续播放失败计数：>3 就停下，避免整队列坏文件时疯狂跳歌 */
  const failCount = useRef(0)
  /**
   * 在线曲目「所有音源 + 所有平台都试过仍取不到链」时的自杀倒计时（3 秒）。
   *
   * 为什么不在 `lastError` 那条 effect 里做：那里靠错误文案当触发键，
   * 两首同名歌失败会得到一模一样的字符串 → 第二次不重渲染 → 倒计时不启动。
   * 这里按「每次加载失败」直接排一个定时器，与文案无关。
   */
  const skipTimer = useRef(0)
  /** 队列长度镜像：定时器回来时要判「整队都试过了没」，闭包里读 state 是旧值 */
  const queueLenRef = useRef(0)
  /** `next` 的镜像：定时器在 startLoad 之后才定义，靠它拿最新的那个 */
  const skipToNext = useRef<(() => void) | null>(null)
  /** 当前正在加载的曲目 + 下标：试听重试要用它再走一遍 startLoad */
  const curLoad = useRef<{ track: LocalTrack; index: number } | null>(null)
  /**
   * 这次的链来自哪个平台。试听识别之后要靠它跳过这一家——
   * 同一家换个音源脚本，多半还是同一段 30 秒试听。
   */
  const lastPlatform = useRef<PlatformSource | null>(null)
  /** 因为「只有试听」而跳过的平台（按曲目记：换歌清零，见 startLoad） */
  const trialSkip = useRef<{ key: string; platform: PlatformSource | null }>({ key: '', platform: null })
  /** 试听重试次数（按曲目记）。跳两次还都是试听就停手，把话说清楚 */
  const trialRetry = useRef<{ key: string; n: number }>({ key: '', n: 0 })
  /** 本轮连续失败次数（成功出声/取链成功即清零）：跳满一整圈还不行就停，别无限跳 */
  const pullFail = useRef(0)
  /**
   * 「这一轮加载我不想让它出声」。
   *
   * 用户在**取链途中**点了暂停：那一刻原生手里还没有播放器（`mp == null`），暂停
   * 命令落到空处；等 2~8 秒后链取回来，`startLoad` 照样按 `autoplay: true` 下发 ——
   * 声音就这么在「我已经按过暂停」之后响起来（用户 2026-11-15 报的
   * 「暂停了还是会继续播放音乐」，在线慢歌最容易复现）。
   *
   * 置 true 之后这一轮下发 `autoplay: false`：链照样取、播放器照样建（进度条/时长
   * 都正常），只是不自动起播；用户再点播放走 resume，不用再等一次取链。
   * 每次 `startLoad` 开头清掉，只影响被暂停的那一轮。
   */
  const autoCancel = useRef(false)
  /**
   * 用户意图代号：每按一次（播放 / 暂停 / 换歌）就 +1。
   *
   * 为什么光有 `autoCancel` 还不够（2026-11-15 真机日志）：
   *   `13:55:56.617 src=frontend pause` → `after pause playing=false`
   *   `13:55:56.748 open autoplay=true index=22`   ← 130ms 之后，迟到的加载
   *
   * `autoCancel` 是**前端自己**在「算 autoplay 的那一刻」读的布尔值，它管不住
   * 「已经在路上」的命令：这一轮取链在暂停**之前**出发，回来时暂停已经落地，
   * 但原生那边 `open(autoplay=true)` 照样把 `wantPlay` 置回 true，prepare 一完成
   * 就出声。弱网时这条链路能拖几秒，用户听到的就是「我明明暂停了，过一会儿又响」。
   *
   * 代号交给原生做最终裁决（见 PlaybackService.intentEpoch）：比当前代号旧的
   * `play_file/play_url` **照样准备音源，但强制不出声**——进度条、时长、后续
   * 秒播都在，只是不背叛用户按下的那一下。
   *
   * 注意 `startLoad` 必须在**入口**取一次代号并一路带着，不能在下发时现读：
   * 现读会拿到暂停之后的新号，等于把「迟到」这个事实抹掉了。
   */
  const epochRef = useRef(1)
  /** 用户按了一下 → 代号 +1 */
  const bumpEpoch = useCallback(() => ++epochRef.current, [])
  /**
   * 用户的动作明确表达了「我要听」：解开暂停锁。
   *
   * 只有点歌 / 上一首 / 下一首 / 按播放这几个入口调它。`startLoad` 自己**不调**——
   * 加载可能是后台发起的（队列编辑、原生对齐、试听重试），不该替用户改主意。
   */
  const resumeIntent = useCallback(() => {
    autoCancel.current = false
    bumpEpoch()
  }, [bumpEpoch])
  /**
   * 刚下发的 seek 目标。
   *
   * Rust 的 `player://state` 是 250ms 一帧的「解码器当前位置」，但 `Cmd::Seek` 要在音频线程
   * 里排到队才有结果——这一次事件往往还带着**跳转前**的位置。直接回写，界面就会
   * 「先弹回原处、再跳到你点的地方」。所以下发 seek 后开一个短窗口，窗口内凡是
   * 与目标差得远的位置一律丢弃（等到位置已经追上、或者窗口超时）。
   */
  const seekGuard = useRef<{ target: number; until: number } | null>(null)
  /**
   * 「这一首取链失败了」的记录，专供**网络恢复后自动重来一次**。
   *
   * 断网 / 刚重连那几秒里，所有平台的搜索都会超时（真机日志：
   * `msgs=各平台都没有可用音源（酷狗搜索超时；酷我搜索超时）`），用户清完缓存后
   * 每首都得重新取链，于是「好多歌都播放不了」。网一旦回来，这一首其实立刻能成功，
   * 可前端只在失败当时弹了个提示就停在原地 —— 用户只能自己去再点一遍。
   * 这里记住失败的那首，等 `navigator.onLine` 恢复（或看门狗发现网络通了）再试，
   * 最多两次，避免把请求打成雪崩。
   */
  const failRetry = useRef<{ track: LocalTrack; index: number; at: number; n: number } | null>(null)
  /** 自动重试次数（按曲目记）：重试本身会再调 `startLoad`，会把 `failRetry` 清掉，次数得单独存 */
  const retryTries = useRef<{ key: string; n: number }>({ key: '', n: 0 })
  /** Rust 侧当前已加载的曲目路径（用于「恢复上次曲目后点播放」时判断是否需要先加载） */
  const loadedRef = useRef<string | null>(null)
  /** 恢复完成前不要回写队列：否则首帧的空队列会把上次的曲单覆盖掉 */
  const hydrated = useRef(false)
  /** 本次启动是否从存档里恢复了曲目/进度 */
  const restored = useRef(false)
  /**
   * 待应用的恢复进度：启动时只恢复界面，不预加载音频。
   * 这样既不用在开机时解码文件（坏文件会触发一串报错），点播放时再从这里续上。
   */
  const resumePos = useRef(0)
  /** 恢复了「时长未知 / 0 时长」的曲目：Rust 侧没加载，别用它的 0:00 覆盖界面 */
  const lazyRestored = useRef(false)
  /**
   * 最新快照的镜像：定时落盘 / 批量移除时要读"此刻"的值，
   * 不能依赖闭包里的旧 snapshot。
   */
  const snapRef = useRef<PlayerSnapshot>({ playing: false, position: 0, duration: 0, volume: 0.8, buffered: 0 })
  snapRef.current = snapshot
  /**
   * 「我刚刚点的那一下」——播放态的操作意图。
   *
   * 原生每 250ms 推一帧 state，而 pause / resume 走的是命令通道。点下去到命令真正
   * 生效之间，进来的那一帧很可能还是**发命令之前**采样的旧状态。以前事件流无条件
   * 覆盖 `playing`：点暂停 → 图标先变播放 → 被旧帧推回暂停 → 下一帧才再变播放。
   * 用户看到的就是「点暂停时图标快速闪三下」。
   *
   * 现在的规则：命令发出后的 `until` 之前，事件流里**与意图相反**的 `playing` 一律
   * 不采信（继续显示意图值）；原生一旦追平立刻解锁；超时也认命（那是真没生效，
   * 该回滚就回滚，不能永远卡在假状态上）。
   */
  const playWant = useRef<{ want: boolean; until: number } | null>(null)
  /**
   * 「刚才那一下 resume 到底响没响」的守护定时器。
   *
   * 用户报过的形状（2026-11-15）：「偶尔点击播放按钮但歌曲播不起来，这首歌是
   * 已缓存的歌曲，然后切换下一曲又切换上一曲又可以播放了」。
   *
   * 缓存歌不走取链，所以问题不在网络，在**原生那台播放器还起不起得来**：
   * 放完（ENDED）、被 `stop()` 过（IDLE）、或者解码器已经废了。这时 `resume()`
   * 是条静默命令——服务收到了、执行了、什么声音都没有，前端也没有任何回执可以
   * 分辨「已经响了」和「发出去没落地」。
   *
   * 所以按下去之后留一次回查：900ms 内原生还没报 `playing`，说明这台播放器救不回来，
   * 直接走一次完整加载（`startLoad`）——反正用户要的就是出声。切下一首再切回来
   * 能好，是因为那条路本来就走 `startLoad`；这里只是把它自动化。
   */
  const resumeGuard = useRef(0)

  /**
   * 进度快照的**合并提交**。
   *
   * 原生侧每 250ms 推一帧（暂停时也推）。以前每帧都 `setSnapshot`，等于整个 App
   * ——常驻挂载的播放页、曲库、歌单、歌词——每 250ms 整棵重渲染一遍。
   * 页面上任何动画都在跟这次重渲染抢主线程，用户看到的就是「哪哪都卡一下」；
   * 暂停后明明没有新信息，它也照样一秒四次地转。
   *
   * 现在只在真的变了的时候提交：播放态 / 时长 / 音量 / 缓冲，或位置跨过半秒。
   * 时间标签本来就是秒级显示，进度条 250ms 与 500ms 的步进肉眼分不出来。
   */
  /**
   * 事件流报上来的播放态要不要采信（见上方 `playWant` 的说明）。
   * 追平就解锁并返回原生值；没追平且还在宽限期内就保持意图值。
   */
  const settlePlaying = useCallback((remote: boolean): boolean => {
    const it = playWant.current
    if (!it) return remote
    if (remote === it.want) { playWant.current = null; return remote }
    if (performance.now() < it.until) return it.want
    playWant.current = null
    return remote
  }, [])

  const commitSnapshot = useCallback((next: PlayerSnapshot) => {
    const prev = snapRef.current
    const same =
      prev.playing === next.playing &&
      Math.abs(prev.duration - next.duration) < 0.01 &&
      Math.abs(prev.volume - next.volume) < 0.005 &&
      Math.abs((prev.buffered ?? 0) - (next.buffered ?? 0)) < 0.5 &&
      Math.round(prev.position * 2) === Math.round(next.position * 2)
    if (same) return
    snapRef.current = next
    setSnapshot(next)
  }, [])

  /**
   * 统一加载入口。本地曲目直接交给 Rust 读文件；在线曲目先取链再流式播放。
   * 「懒恢复」状态在真正加载后即结束，之后以 Rust 事件为准。
   */
  const startLoad = useCallback((
    track: LocalTrack, index: number,
    opts?: {
      startAt?: number | (() => number)
      autoplay?: boolean; restore?: boolean; keepPause?: boolean; why?: string
      bypassCache?: boolean; fallbackQuality?: string
      /**
       * **换音质专用**：取链期间不把正在响的上一版按住。
       *
       * 换歌必须静音（界面已经换、声音还是旧的会被当成「没点中」），
       * 但换音质是**同一首歌**——旧档位继续响、新档位好了无缝换过去，
       * 用户听到的是「音质变好了」而不是「断了 N 秒才有声」。
       * 取链失败还有 fallbackQuality 兜着，歌不会断。
       */
      keepSound?: boolean
    },
  ) => {
    lazyRestored.current = false
    loadExpect.current = track.duration || 0
    /*
     * **这里绝不主动清「暂停锁」。**
     *
     * 以前开头是 `if (!opts?.keepPause) autoCancel.current = false`，本意是
     * 「用户点了新歌，就该出声」。但 `startLoad` 不只被用户动作调用：
     * 队列编辑、原生对齐下标、试听重试、预告接下一首，都会进来。
     * 于是出现一个真机上抓到的形状（2026-11-15 日志）：
     *
     *   `src=frontend pause`  → 用户按了暂停
     *   `open[play_url] autoplay=true index=46`  ← 同一秒里，另一轮加载把它顶回来了
     *
     * 现在这条锁**只由用户的动作来解**（点歌 / 上一首 / 下一首 / 按播放，见
     * `resumeIntent()`）。谁发起的加载都不重要：用户最后一次是「暂停」，
     * 那这一轮就只准备音源、不出声。`keepPause` 参数因此失去了意义，保留只为
     * 兼容调用点。
    /*
     * 这一轮加载的代号：**入口取一次**，三条下发路径都带同一个值（见 epochRef）。
     * 取完就自增，等于「这一轮比之前所有操作都新」。
     */
    const ep = ++epochRef.current
    /*
     * 前端自己的这一笔也记进原生日志。
     *
     * 「歌自己停了」最难查的地方在于：原生的 `setPlaying want=false` 只说明**停了**，
     * 是换歌前的静音？某个 effect 又加载了一遍？还是用户真的按了？只有前端知道。
     * 现在每轮加载都留一行（`why` 说明来路），两端的日志能对上同一条时间轴。
     */
    const why = opts?.why ?? '?'
    void bridge.trace(
      `load ep=${ep} idx=${index} why=${why} online=${isOnlineTrack(track) ? 1 : 0}`
      + `${opts?.restore ? ' restore' : ''}${opts?.autoplay === false ? ' noAuto' : ''}`,
    )
    /* 手动换歌 / 上一首 / 下一首都从这里过：把上一次失败排的「3 秒后下一首」撤掉，
       否则用户刚点的新歌会被旧倒计时顶掉 */
    window.clearTimeout(skipTimer.current)
    /* 新的一轮开始：上一次失败留下的「网络回来再试」作废（用户已经自己换了一首） */
    failRetry.current = null
    /* 上一次「resume 没响」的回查也一并作废：它查的是上一首，不能拿它把新歌顶掉 */
    window.clearTimeout(resumeGuard.current)
    resumeGuard.current = 0
    const key = trackKey(track)
    const online = isOnlineTrack(track)
    /* 试听重试的记忆跟着曲目走：换一首就清零，别把上一首跳过的平台带过来 */
    if (trialSkip.current.key !== key) trialSkip.current = { key, platform: null }
    curLoad.current = { track, index }
    /*
     * 这一轮取链的序号：任何新的一轮都会 +1，旧一轮在下一个 await 边界自己退出
     * （见 online.ts 的 cancel）。**必须在所有定时器/副作用之前取**，
     * 否则 900ms 那个「按住上一首」的定时器分不清自己是不是已经被顶掉了。
     */
    const seq = ++onlineSeq.current
    startLoading(online)
    /*
     * **换歌立刻把进度条拉回起点。**
     *
     * 这一步只能在前后端这里做：`snapshot.position` 要等原生 `open` 成功、推回第一帧
     * 之后才会有新值，而在线曲目取链慢的时候要 3~13 秒（平台超时更久）。这段空窗里，
     * 封面 / 标题 / 歌词**已经**换成新歌了（它们来自 `queueState`，点下去就换），
     * 只有进度条还指着上一首的位置 —— 用户看到的就是
     * 「封面歌词都出来了，进度条还停留在原地」（2026-11-16 反馈）。
     * 取链失败时更糟：进度条永远停在那儿，看着像界面卡死。
     *
     * 两个例外：`restore`（恢复上次播放位置）和 `startAt`（换源 / 换音质保持进度），
     * 它们本来就要停在某个指定位置，清掉反而会跳回 0。
     */
    if (!opts?.restore && !opts?.startAt) {
      seekGuard.current = null
      commitSnapshot({ ...snapRef.current, position: 0, duration: track.duration || 0, buffered: 0 })
    }
    /*
     * `startAt` 支持函数形式：**在真正下发的那一刻**再取位置。
     *
     * 换音质那轮（keepSound）取链要 1~3 秒，期间旧档位一直在响、进度一直在走；
     * 位置若在点击那一下就定死，换过去会往回跳这几秒（把刚听过的再播一遍）。
     */
    const startAtNow = (): number =>
      typeof opts?.startAt === 'function' ? Math.max(0, opts.startAt()) : Math.max(0, opts?.startAt ?? 0)

    if (!online) {
      /* 本地曲目交给原生直接读文件，这一下就算「已加载」 */
      loadedRef.current = key
      void bridge.playFile(track.path, index, { ...opts, startAt: startAtNow(), autoplay: (opts?.autoplay ?? true) && !autoCancel.current, epoch: ep })
      return
    }

    /*
     * 在线曲目要先取链（1~3 秒）：**这一段等待里必须把上一首按住**。
     *
     * 不按的话声音还在唱上一首、界面又还没换，用户会以为「没点中」再点一次
     * （2026-11-01 反馈）。本地曲目不用管——`playFile` 是立刻换源，多一次暂停
     * 反而多一段静音。
     */
    /* 换歌要重新加载，播放态由加载流程接管：意图锁在这里必须松开，
       否则「刚点暂停又点歌」会让事件流被旧意图按住 */
    playWant.current = null
    /*
     * 恢复会话（`restore`）时**不要**掐播放。
     *
     * 这一步是给「点歌换歌」用的：取链要 1~3 秒，这期间得把上一首按住，
     * 否则声音还在唱、界面已经换了。冷启动恢复时原生那边本来就没有实例，
     * 这一下是空操作；但安卓「切后台再回来」时页面会重挂一遍，此时原生
     * 正在出声——真被这里 pause 掉，就正好是用户说的「一打开就停」。
     * 会话接管的判据在前面的恢复段（`liveReady`），这里再兜一层：
     * 拿不准的时候，宁可让旧声音多响一秒，也不要无端掐断。
     *
     * **别按得太早**（2026-11-15 用户报「打开新歌单连点两次下一首，歌曲就会暂停播放」）：
     * 以前是进入这个分支立刻 `pause()`，之后整段取链都是静音。取链快（缓存 / 秒回）
     * 时听不出来，可一旦某一轮慢个几秒、或者干脆失败，用户听到的就是**点了就停、
     * 而且再也不响**。现在给 900ms 缓冲：
     *   · 900ms 内链回来了 → 从头到尾没静音，换歌是无缝的；
     *   · 超过 900ms → 才按下去，避免「界面已经换歌、声音还是上一首」；
     *   · 这一轮失败 → 上一首还在响（比一停到底好得多），提示照常弹。
     * 定时器跟着 `onlineSeq` 走：被下一轮顶掉的那一轮，不许再动播放状态。
     */
    /*
     * `keepSound`（换音质）那一轮不按：同一首歌，旧档位继续响到新档位接上。
     */
    let pressTimer = 0
    const cancelPress = () => {
      if (pressTimer) {
        window.clearTimeout(pressTimer)
        pressTimer = 0
      }
    }
    if (!opts?.restore && !opts?.keepSound) {
      pressTimer = window.setTimeout(() => {
        pressTimer = 0
        if (seq !== onlineSeq.current) return
        setSnapshot(s => (s.playing ? { ...s, playing: false } : s))
        /* 带上代号：这一轮的暂停比之前所有操作都新，旧一轮还没落地的加载就此作废 */
        void bridge.pause(ep, `load:${why}`).catch(() => { /* 还没加载过 / 命令不存在：都无所谓 */ })
      }, 900)
    }

    if (excluded.current.key !== key) excluded.current = { key, ids: [] }

    setOnlineBusy(true)
    setOnlineSource(null)
    setOnlineQuality(null)
    setOnlineVia(null)
    setOnlineActual(null)
    setOnlineNotice(null)
    /*
     * 先看缓存。
     *
     * 听过的歌在本地有一份（见 lib/audioCache.ts），直接当本地文件播：
     * 点下去就出声，不用等「取链 → 探活」那两秒，也不再受直链过期影响。
     * 取链逻辑原封不动留在下面，缓存没命中就走它——两条路互不影响。
     *
     * 音质切换那一轮（`bypassCache`）必须**跳过缓存查询**：缓存里那份是旧档位
     * 出链落盘的，命中它等于把切换前的东西又播了一遍（2026-11-21 用户实测
     * 「切了音质没反应」）。直接走取链，成功后由 success 分支换掉缓存。
     */
    const cacheLookup: Promise<string | null> = opts?.bypassCache
      ? Promise.resolve(null)
      : cachedAudio(track.id, effectiveSong(track.id)?.interval || track.duration || 0, effectiveSong(track.id)?.name || track.title || '')
    void cacheLookup.then(hit => {
      if (seq !== onlineSeq.current) return
      if (hit) {
        /* 链已经在手上：不需要那 900ms 的「按住上一首」，直接换源 */
        cancelPress()
        setOnlineBusy(false)
        setOnlineSource('本地缓存')
        pullFail.current = 0
        retryTries.current = { key: '', n: 0 }
        setLastError(null)
        /*
         * 缓存命中也要把音质选中态补上：这条路不走 resolvePlayUrl，
         * `onlineQuality` 以前一直没人设置，音质下拉「没有对应选中」。
         * 档位以缓存索引里记的为准（没有就按用户当前偏好兜底）。
         */
        void cachedAudioQuality(track.id)
          .then(q => q ?? getPreferredQuality())
          .then(q => { if (seq === onlineSeq.current) setOnlineQuality(q) })
          .catch(() => {})
        loadedRef.current = trackKey(track)
        void bridge.playFile(hit, index, { ...opts, startAt: startAtNow(), autoplay: (opts?.autoplay ?? true) && !autoCancel.current, epoch: ep })
        return
      }
      resolvePlayUrl(track, {
        exclude: excluded.current.ids,
        skipPlatform: trialSkip.current.platform ?? undefined,
        /*
         * 已经被下一首顶掉了就别再往下取。
         *
         * 连点「下一首」时，每一轮取链都会「注册表重搜 → 本平台取链 → 跨平台搜索」，
         * 一路往原生 HTTP 线程池里塞请求。旧轮次不收手的话，最新那首的请求就排在队尾，
         * 超时被判成「没搜到」—— 用户看到的就是「快速切歌会播放失败」。
         * 这里让旧轮次在下一个 await 边界自己退出（见 online.ts 的 StaleResolve）。
         */
        cancel: () => seq !== onlineSeq.current,
      })
        .then(r => {
          if (seq !== onlineSeq.current) return
          cancelPress()
          setOnlineBusy(false)
          pullFail.current = 0
          retryTries.current = { key: '', n: 0 }
          /* 上一首的失败提示不能赖在新歌上：取链成功就撤掉 */
          setLastError(null)
          lastSourceId.current = r.sourceId
          lastPlatform.current = r.platform
          /* 未校验的地址要标出来：用户听出「有点不对劲」时，界面上得有据可查 */
          setOnlineSource(r.unverified ? `${r.sourceName} · 未校验` : r.sourceName)
          // 存原始 key（320k / flac …）：音质下拉的 option value 用它，存中文标签会对不上
          setOnlineQuality(r.quality)
          setOnlineVia(r.switched ? r.platformName : null)
          /*
           * 兜底到的音频，歌手可能不是原曲目的人（翻唱 / 重制）。
           * 只有**真的不一样**时才上报，界面据此把「歌手」换成真正在唱的那个——
           * 用户反馈过「歌手和名字和实际播放的音频不是同一个」，这是那一半的修法。
           */
          setOnlineActual(
            r.switched && r.matchedSinger && r.matchedSinger !== track.artist
              ? { name: r.matchedName || track.title, singer: r.matchedSinger }
              : null,
          )
          /*
           * 「已自动处理」的非阻断提示。
           *
           * 这一版的目标是**不让用户看到失败**，但也不能什么都不说——
           * 用户明明选了无损，界面显示高品质，不说一句就成了「偷偷降级」。
           * 但提示要克制：换平台只说**刚发生的那一次**（重播不再弹），降档只在
           * 「无损掉成有损 / 320k 掉成 128k」这种真听得出来的情况说一句，
           * 母带→Hi-Res 不打扰（不然每首歌都弹，提示就成了噪音）。
           */
          const bits: string[] = []
          if (r.switched && r.fresh) {
            bits.push(`当前平台暂无资源，已切换至${r.platformName}`)
          }
          if (qualityDropMatters(r.requestedQuality, r.quality)) {
            bits.push(`音质已降至${r.qualityLabel}`)
          }
          if (bits.length) setOnlineNotice(bits.join(' · '))
          loadedRef.current = trackKey(track)
          void bridge.playUrl(r.url, index, {
            // 换平台后时长可能和搜索结果的元数据不同，进度条要用真实那条的时长
            durationHint: r.duration || track.duration,
            /* keepSound 那轮在这里取「此刻」的位置：旧档位响到这一刻才换过去 */
            startAt: startAtNow(),
            /* 取链途中用户按过暂停：照样建播放器，但别出声（见 autoCancel） */
            autoplay: (opts?.autoplay ?? true) && !autoCancel.current,
            /* 这一轮出发时的代号：比它新的暂停/播放已经发生时，原生会强制静音 */
            epoch: ep,
          })
          /*
           * 出链成功就顺手在后台存一份，下次秒开。15 秒后才起手：前十几秒的带宽
           * 全留给「当前这首的缓冲」（用户听到的是「一卡一卡」）。
           *
           * 音质切换那一轮（`bypassCache`）要先把旧档位的缓存丢掉再存：
           * 同一首只按 id 存一份，不清的话 warmCache 看到已有条目直接跳过，
           * 缓存永远停在切换前的档位。**成功之后才丢**——离线时取不到链走不到这里，
           * 旧的缓存还是唯一的可播资源，不能先删。
           */
          if (opts?.bypassCache) {
            /* 先删后存：warmCache 的去重检查是同步的，得等索引里没有这条再调它 */
            void dropCachedAudio(track.id).then(() => warmCache(track.id, r.url, 15000, r.quality))
          } else {
            warmCache(track.id, r.url, 15000)
          }
        })
        .catch(e => {
          if (seq !== onlineSeq.current) return
          cancelPress()
          setOnlineBusy(false)
          stopLoading()
          /*
           * 音质切换取不到链：回退原音质继续播 + 一句浅提示，不算失败。
           *
           * 用户的拍板（2026-11-21）：「取不到链接应该切换为原音质播放，给个提示
           * 就行，就说找不到这个音质的音乐」。不弹错误条、不排自动下一首——
           * 歌还在，只是这个档位没有资源。
           *
           * 原音质的缓存**还在**：旧档位落盘的文件只有在新档位取链成功后才被
           * dropCachedAudio 换掉，失败走不到那一步。所以回退这一轮不 bypass，
           * 大概率直接命中缓存秒回。
           */
          if (opts?.fallbackQuality) {
            void bridge.trace(`quality-fallback ep=${ep} idx=${index} from=${opts.fallbackQuality} msg=${String(e instanceof Error ? e.message : e).slice(0, 60)}`)
            setOnlineNotice('找不到这个音质的音乐，已切回原音质')
            /* 偏好也要跟着回退：否则之后每首歌都先试这个拿不到的档位 */
            void setPreferredQuality(opts.fallbackQuality).then(() => {
              /* keepSound 一路带上：回退轮大概率直接命中缓存，歌不该再断一次 */
              startLoad(track, index, { startAt: opts?.startAt, autoplay: true, keepSound: opts?.keepSound, why: 'quality-fallback' })
            })
            return
          }
          // `NoPlayableSourceError` 自带一句人话（「暂时取不到播放地址…」），直接用它
          const detail = e instanceof Error ? e.message : String(e)
          const name = track.title.length > 18 ? track.title.slice(0, 18) + '…' : track.title
          /*
           * 音源 + 平台全试完还是没链 → 3 秒后自动切下一首（用户 2026-11-01 要求）。
           *
           * 两道上限，避免「整队列都没资源」时把歌单刷到底：
           *   · 队列只有一首 → 不跳（跳了还是它）；
           *   · 连挂 5 首 → 说明不是单曲的问题（断网 / 音源全挂 / 队列里全是过期记录），
           *     停下来留错误提示，比继续跳 500 首更好。
           * 失败计数的清零条件：取链成功 / 缓存命中 / 真的出声（见上面的 pullFail）。
           */
          pullFail.current += 1
          /*
           * **这一首没加载成功，把「已加载」的记录抹掉。**
           *
           * `togglePlay` 判「要不要重新加载」看的是
           * `loadedRef.current !== trackKey(t) || snapshot.duration <= 0`。
           * 取链失败时如果 `loadedRef` 还留着这一首（上一轮缓存命中设的、或者
           * 原生对齐时写的），上面两条都不成立 —— 用户点播放只会发一个 `resume`
           * 到**没有音源的播放器**上，什么都不发生，看起来就是「这首彻底废了，
           * 怎么点都不响」（2026-11-16「好多歌都播放不了」）。
           * 抹掉之后同一首再点会老老实实重新取链。
           */
          if (loadedRef.current === key) loadedRef.current = null
          /*
           * 冷启动的预加载不排「3 秒后自动切下一首」。
           *
           * 那一刻音源脚本可能刚热起来、网卡刚连上（见 SourceManager.waitLoaded），
           * 一次失败就把整条队列往下刷 5 首，用户看到的是「一打开就自己乱跳」。
           * 启动失败就静静停在当前这首，点播放会重来一遍，那次是真有准备的。
           */
          /*
           * 用户已经按过暂停 / 停止：**不许再自己往下跳**。
           *
           * 这一条是「停不下来」的另一半：失败分支排的 3 秒跳歌倒计时是独立定时器，
           * 用户在那 3 秒里按了暂停并不会把它收掉，于是歌自己换掉、下一首继续
           * 转圈失败、再排下一跳。`autoCancel` 就是「用户最后一下是停」，它既然
           * 立着，这里就不能排（真要让它在加载完之后播，用户再点一下就行）。
           */
          const canSkip = !opts?.restore && !autoCancel.current
            && queueLenRef.current > 1 && pullFail.current <= 5 && skipToNext.current != null
          /* 取链失败也要留痕：不然「点了下一首就没声音」只能靠猜是网络还是音源 */
          void bridge.trace(
            `loadfail ep=${ep} idx=${index} why=${why} pull=${pullFail.current} skip=${canSkip ? 1 : 0}`
            + ` msg=${detail.slice(0, 70)}`,
          )
          setLastError(canSkip ? `「${name}」${detail}　3 秒后自动切到下一首` : `「${name}」${detail}`)
          /*
           * 留一个「网回来就自己重来」的记号。
           *
           * 断网 / 刚重连那几秒所有平台都超时，这时候**不是歌的问题**：网一回来同一首
           * 立刻能取到。以前前端弹完提示就撒手，用户清完缓存后遇到的就是
           * 「好多歌都播放不了，得一首首自己重点」（2026-11-16）。
           */
          failRetry.current = { track, index, at: Date.now(), n: 0 }
          if (canSkip) {
            window.clearTimeout(skipTimer.current)
            skipTimer.current = window.setTimeout(() => {
              skipTimer.current = 0
              void bridge.trace(`skipfail ep=${ep} idx=${index} pull=${pullFail.current}`)
              skipToNext.current?.()
            }, 3000)
          }
        })
    })
  }, [startLoading, stopLoading, commitSnapshot])

  /* 启动：恢复音量/队列 + 拉取曲库 + 订阅事件 */
  useEffect(() => {
    let unsubs: Array<() => void> = []
    /* 「用户正在操作」的全局信号：后台预加载/落盘靠它让路（见 lib/idle.ts） */
    installIdleTracking()
    ;(async () => {
      const vol = await settings.get<number>(KEYS.volume)
      if (vol != null) {
        /*
         * 存档是 0 不能照搬。以前「点静音」走的是各自的本地 state，只有拖滑杆才会
         * 把 0 写进配置；谁拖到最左再退出，下次启动就静音启动、界面上又没有任何
         * 「你静音了」的提示。0 一律当没存过，回默认 0.8。
         */
        const v = vol > 0.001 ? vol : 0.8
        lastVolRef.current = v
        setSnapshot(s => ({ ...s, volume: v }))
        void bridge.setVolume(v)
      }
      const scope = await settings.get<ScanScope>(KEYS.scanScope)
      if (scope) setScanScope(scope)
      const roots = await settings.get<string[]>(KEYS.scanRoots)
      if (roots) setLastRoots(roots)

      /**
       * 在线音源：静默装载一次。
       * 不装的话「搜到了但播不了」，而用户根本没意识到要去设置页点一下加载。
       * 脚本是用户**导入**进来的，导入动作本身就已经是「我同意运行它」了，不必再点第二次。
       *
       * v0.4.5 起只认应用自己的数据目录（`sources.json` 清单，不扫文件夹）。
       * 旧版可能把音源目录指到别处（`sources.dir`）：那种自定义目录里的脚本
       * 先收进清单、再忘掉这个设置——从此音源只有一个家，且只能靠导入进清单。
       */
      let defDir: string | null = null
      try { defDir = await bridge.invoke<string>('sources_default_dir') } catch { defDir = null }
      const legacyDir = await settings.get<string>(KEYS.sourcesDir).catch(() => null)
      if (defDir && legacyDir && legacyDir !== defDir) {
        try {
          const legacy = await bridge.invoke<Array<{ path: string; name: string; code: string }>>(
            'list_source_scripts',
            { dir: legacyDir },
          )
          for (const sc of legacy) {
            if (!sc?.code?.trim()) continue
            await bridge.importSourceText(sc.name.replace(/\.js$/i, ''), sc.code)
          }
        } catch { /* 老目录读不出来就跳过：脚本还在老地方躺着，用户能自己再导一次 */ }
        void settings.set(KEYS.sourcesDir, '')
      }
      if (defDir) {
        const off = await settings.get<string[]>(KEYS.sourcesOff)
        if (off?.length) sourceManager.setDisabled(off)
        void sourceManager.loadAll([defDir]).catch(() => {})
      }

      // 增量刷新不阻塞 UI（有曲库时）
      const existing = cleanLibrary(await bridge.getTracks().catch(() => [] as LocalTrack[]))
      const savedVer = await settings.get<string>(KEYS.scanVersion)
      const needFullRescan = savedVer !== SCAN_VERSION
      if (existing.length) {
        setLibrary(existing)
        setLibraryVersion(v => v + 1)
        // 扫描规则升级过：跑一次全量，把旧规则收进来的录音/假音频清掉
        void bridge.scanMusic(scope ?? 'fast', [], !needFullRescan).then(async () => {
          const tracks = cleanLibrary(await bridge.getTracks())
          setLibrary(tracks)
          setLibraryVersion(v => v + 1)
          if (needFullRescan) void settings.set(KEYS.scanVersion, SCAN_VERSION)
        }).catch(() => {})
      }

      /*
       * 安卓：首次启动（或曲库还空着）自动扫一遍系统媒体库。
       *
       * 桌面端是「选文件夹再扫」，所以空曲库让你自己点一下是合理的；
       * 手机上没人会去「选目录」，装完打开就该看到歌——不扫等于一进来就是空的。
       * 放在非阻塞分支里，扫描期间界面照常可用。
       */
      if (isAndroid && !existing.length) {
        void bridge.scanMusic('fast', [], false).then(async () => {
          const tracks = cleanLibrary(await bridge.getTracks())
          setLibrary(tracks)
          setLibraryVersion(v => v + 1)
          setLastScanAt(Date.now())
          void settings.set(KEYS.scanVersion, SCAN_VERSION)
          void settings.set(KEYS.lastScanAt, Date.now())
        }).catch(() => { /* 没给权限就等用户自己授权后再扫 */ })
      }

      const last = await settings.get<number>(KEYS.lastScanAt)
      if (last) setLastScanAt(last)

      /*
       * 恢复队列（顺序即真相）+ 循环模式；同时恢复「上次在听哪首、播到哪」。
       *
       * 三条来源依次兜底，缺一不可：
       *   1. 曲库 map —— 本地文件，以库里的最新标签为准；
       *   2. 队列快照 —— 在线曲目（online:平台:id）根本不在本地曲库里，
       *      重启后只能靠这份完整数据还原；
       *   3. 在线注册表 —— 老版本只存了 id，从搜过的歌里重新捞回来。
       * 以前只有第 1 条：一整条在线队列会被 filter 成空数组，用户看到的就是
       * 「每次打开播放列表都是空的」。
       */
      const qids = await settings.get<string[]>(KEYS.queueIds)
      const qSnap = await settings.get<LocalTrack[]>(KEYS.queueTracks)
      const savedRepeat = await settings.get<RepeatMode>(KEYS.repeat)
      const ids = qids?.length ? qids : (qSnap ?? []).map(t => t.id)
      if (ids.length) {
        const all = existing.length ? existing : await bridge.getTracks()
        const map = new Map(all.map(t => [t.id, t]))
        const snap = new Map((qSnap ?? []).map(t => [t.id, t]))
        // 注册表是异步从存档读的：只要有一首还得靠它（或要拿它补封面），就先等它读完
        if (ids.some(id => {
          const t = map.get(id) ?? snap.get(id)
          if (!t) return true
          return !t.cover && id.startsWith('online:')
        })) {
          await ensureRegistry().catch(() => { /* 读不出来就当没有，别阻塞启动 */ })
        }
        const tracks = ids
          .map(id => map.get(id) ?? snap.get(id) ?? trackOfId(id))
          /* 旧版误落盘的缓存副本（`online_平台_id.mp3`）不是歌：留在队列里就永远存盘，
             播放条上一直挂着文件名当曲名（见 isCacheCopyTrack 的注释） */
          .filter((t): t is LocalTrack => (t ? !isCacheCopyTrack(t) : false))
          /*
           * 在线曲目的封面**不进队列快照**（快照存的是当时的 LocalTrack，cover 是 null），
           * 只存在在线注册表里。老版本没做这一步，于是每次重启后播出来的歌
           * 都是「黑胶标签一片渐变 + 一个音符图标」——用户说的「每次启动之后
           * 好像都没有专辑封面」就是这里。注册表里现成有 img，不用重新搜。
           */
          .map(t => {
            if (t.cover || !t.id.startsWith('online:')) return t
            const img = songOf(t.id)?.img
            return img ? { ...t, cover: img } : t
          })
        if (tracks.length) {
          /*
           * 过滤掉坏条目之后立刻回写存档。
           *
           * 不回写的话，那份含着 6 条 `online_xxx` 的旧快照会一直躺在存储里：
           * 每次启动都要再过滤一遍（无害，但白做），而且用户在「清缓存」之前
           * 永远看不到它消失。
           */
          if (tracks.length !== ids.length) {
            void settings.set(KEYS.queueIds, tracks.map(t => t.id))
            void settings.set(KEYS.queueTracks, tracks)
          }
          const lastId = await settings.get<string>(KEYS.lastTrackId)
          const idx = lastId ? tracks.findIndex(t => t.id === lastId) : -1
          if (idx >= 0) lastPlayedIndex.current = idx // 阻止 effect 自动开播
          const repeat: RepeatMode = savedRepeat === 'one' || savedRepeat === 'shuffle' ? savedRepeat : 'sequence'
          setQueueState(q => ({
            ...q,
            queue: tracks,
            index: idx >= 0 ? idx : -1,
            repeat,
            order: tracks.map(t => t.id),
          }))

          if (idx >= 0) {
            const t = tracks[idx]
            const dur = t.duration || 0
            /*
             * 先问原生：那边是不是还挂着一个活的音源？
             *
             * 安卓上「切后台听歌 → 过一阵再切回来」，系统回收的是**后台的
             * Activity**（前台服务不受影响，声音一直没断）。再进来时是全新的
             * WebView，前端从零挂载一遍。如果这里照冷启动的路走，`startLoad`
             * 第一件事就是 `pause()`（换歌前的静音），接着按
             * `autoplay = wasPlaying && autoResume` 决定播不播——而
             * 「启动时接着播放」（`player.autoResume`）默认是关的。于是
             * 用户看到的就是「打开前还在唱，一打开就停了」。
             *
             * 桌面端没有这个场景：关窗只是收进托盘，页面根本不重载。
             *
             * 判据只看原生：时长读出来过（> 0）或挂着一个源，就说明那边有
             * 个 prepared 的实例。哪怕此刻是暂停态也不该重新取链——用户离开
             * 时是什么样，回来就该是什么样。冷启动时 `player_state` 回的是
             * 空快照（0 / null / -1），这里自然落到下面的正常恢复。
             */
            const live = await bridge.playerState().catch(() => null)
            /*
             * 三条一起判：真原生宿主（浏览器预览的 mock 恒定报 246 秒，
             * 会把预览页判成「原生正在播」而什么都不加载）、原生手里有下标
             * （说明前端至少 load 过一次）、以及读到了时长或源。
             */
            const liveReady = bridge.isNative && !!live && live.index >= 0
              && (live.duration > 0 || !!live.trackPath)
            const liveIdx = live && live.index >= 0 && live.index < tracks.length ? live.index : idx
            if (liveReady) {
              /*
               * 留一行痕迹：安卓上没有它，「页面被系统回收后重挂」和「正常冷启动」
               * 从界面上根本分不出来，下次再有人报「打开就停」只能靠猜。
               * 桌面写进 app.log，安卓进 logcat（ShuyinJS）。
               */
              diag('player.resume.takeover', {
                index: liveIdx, playing: !!live.playing, position: live.position, duration: live.duration,
              })
              const lt = tracks[liveIdx] ?? t
              restored.current = true
              resumePos.current = 0
              loadedRef.current = trackKey(lt)
              loadExpect.current = lt.duration || live.duration || 0
              curLoad.current = { track: lt, index: liveIdx }
              lastPlayedIndex.current = liveIdx
              // 后台用通知切过歌：原生手里的下标已经变了，队列跟着对齐
              if (liveIdx !== idx) setQueueState(q => (q.index === liveIdx ? q : { ...q, index: liveIdx }))
              setSnapshot(s => ({
                ...s,
                playing: !!live.playing,
                position: live.position || 0,
                duration: live.duration || lt.duration || 0,
              }))
            } else {
              const saved = await settings.get<number>(KEYS.lastPosition)
              let pos = typeof saved === 'number' && Number.isFinite(saved) && saved > 0 ? saved : 0
              // 上次是听着看着就退出的：进度停在结尾附近没有意义，下次从头开始
              if (dur > 0 && pos > dur - 3) pos = 0
              diag('player.resume.restore', {
                index: idx, dur, hadNative: !!live && live.index >= 0,
                nativeDur: live?.duration ?? 0, nativePlaying: !!live?.playing,
              })
              const wasPlaying = !!(await settings.get<boolean>(KEYS.wasPlaying))
              const autoResume = !!(await settings.get<boolean>(KEYS.autoResume))
              const autoplay = wasPlaying && autoResume
              restored.current = true
              resumePos.current = pos
              /*
               * `playing` **不能**拿 `autoplay` 当代言。
               *
               * `autoplay` 只是「等会儿加载完就播」的意图，这一刻原生手上连播放器都
               * 还没有（`playerState().trackPath` 是空的）。把界面写成「正在播」，用户
               * 就会看到暂停图标、听到没有声音；他点一下想暂停，前端按「我这边在播」
               * 发一条 `pause` 给一个空服务 —— **点了完全没有反应**，再点还是一样。
               * 真实状态一律等 `player://state` 推上来（第一帧就会到）。
               */
              setSnapshot(s => ({ ...s, position: pos, duration: dur, playing: false }))
              // 只有时长可信（>5s）的曲目才在启动时预加载：
              // 0 时长多半是残缺/损坏文件，开机去解码会拉出一串报错。
              if (dur > 5) {
                /*
                 * 这里**不要**自己写 `loadedRef`：那个标记的含义是「原生侧确实拉着
                 * 这首歌的音源」，而此刻只是「发出了一次加载请求」——在线曲目还要
                 * 取链、探活，网络没就绪就会失败。抢先把标记写上，之后点播放只会走
                 * `resume()`，落到一个空的服务里什么都不发生（华为真机上就是这样
                 * 「点播放没反应」）。交给 `startLoad` 在真正成功那一刻去写。
                 */
                resumePos.current = 0
                startLoad(t, idx, { startAt: pos, autoplay, restore: true, why: 'restore' })
              } else {
                lazyRestored.current = true
              }
            }
          }
        }
      }

      const st = await bridge.playerState()
      /*
       * 服务被系统回收、进程被重建之后，原生那边**没有任何播放器**，
       * 但前端 `loadedRef` 记的是「我让它加载过」——两边不一致。
       *
       * 不一致的后果用户已经报过两次：「点了播放没反应」（命令落到空处），
       * 「点了暂停一会儿又自己播」（原生没有播放器时把命令退回前端 = 一记切换）。
       * `trackPath` 为空就是「原生手上没东西」的铁证，据此把 `loadedRef` 清掉，
       * 下一次点播放就会老老实实走 `startLoad` 重新加载。
       */
      if (!st.trackPath) loadedRef.current = ''
      // 已从存档恢复：Rust 那边的加载命令还在通道里排队，此刻读到的 0:00 不能回写 UI
      if (!restored.current) {
        setSnapshot(s => ({ ...s, playing: st.playing, position: st.position, duration: st.duration }))
      }
      hydrated.current = true

      unsubs.push(bridge.onPlayerEvent(({ payload }) => {
        const p = payload as PlayerSnapshot & {
          ended?: boolean; error?: string | null; seeking?: boolean
          sleep?: number; sleep_track?: boolean
          /** 原生手里「下一首预告表」还剩几首（见 PlaybackService.push） */
          pf?: number
        }
        /*
         * 定时关闭的剩余时间：只在**真的变了**的时候写 state。
         *
         * 每秒一帧，而 `snapshot` 那条路本来就每 250ms 变一次；但 `sleep` 变化会
         * 单独触发一次 context 更新，所以「没设定时器」（=0）时必须原样返回旧对象，
         * 否则整个应用每秒白白重渲染一次。
         */
        {
          const remain = typeof p.sleep === 'number' ? p.sleep : 0
          const track = !!p.sleep_track
          const on = remain > 0 || track
          setSleepState(prev => (
            prev.on === on && prev.track === track && prev.remain === remain
              ? prev
              : { on, track, remain }
          ))
        }
        /*
         * 加载结束判定：出声了 / 解码器报出了正确的时长（暂停态起播也算加载完了）/ 报错。
         * 不能只看 `duration > 0`：`Cmd::Play` 在换歌时并不清零时长，
         * 上一首的 3:12 会立刻把转圈关掉。
         */
        if (loadingRef.current) {
          const expect = loadExpect.current
          const durOk = p.duration > 0 && (expect <= 1 || Math.abs(p.duration - expect) < 2)
          if (p.playing || durOk || p.error) stopLoading()
        }
        /*
         * 「取链中」不能比声音活得久。
         *
         * 取链结果里那次 `setOnlineBusy(false)` 带 seq 校验：连点两首时，前一首的回调
         * 会被判定为过期而直接 return，它负责清的标记就没人清了。表现是
         * 「歌已经在放、进度条在走，播放条上却一直挂着『取链中…／正在解析播放地址…』」
         * （用户截图反馈，2026-10）。加载已经结束（`loadingRef` 为 false）而音频真的在响，
         * 就说明取链早已完成——这时候把标记收掉，用函数式更新读当前值，不引入新的依赖。
         */
        if (!loadingRef.current && p.playing) {
          setOnlineBusy(b => (b ? false : b))
        }
        /*
         * 「只有 30 秒」：平台对没版权 / VIP 的歌只回一段试听。
         *
         * 取链时那一道探活经常读不出时长（分块传输、没有 Content-Length，
         * 16KB 头里也没有 Xing/moov），所以拦不住；这一段只有等原生真正解码出来
         * 才知道——解码器报的长度就是这条音频的真身（安卓直接读 MediaPlayer.duration）。
         * 比平台标的短一大截，就当这一家不行：换平台重来，别让用户听完 30 秒
         * 被莫名其妙换歌（2026-11-01 反馈）。
         */
        /*
         * 原生自己接上了下一首。
         *
         * 息屏时 JS 会被系统摁住，`ended` 推过来也没人处理（用户听到的就是
         * 「切歌期间停掉、亮屏又接着播」）。现在原生手里有前端事先递过去的
         * 直链，放完自己接，并把「我现在是第几首」写进每一帧状态。
         *
         * 这里只**对齐下标**：再调一次 advance 就成跳一首了。
         * 播放相关的 refs 一起换掉，否则「试听识别」「已加载」还是上一首的。
         */
        const auto = (p as { auto?: unknown }).auto
        if (typeof auto === 'number' && auto >= 0) {
          const q = queueRef.current
          if (q.index !== auto) {
            const t = q.queue[auto]
            if (t) {
              playWant.current = null
              stopLoading()
              curLoad.current = { track: t, index: auto }
              loadedRef.current = trackKey(t)
              loadExpect.current = t.duration || 0
              curOnlineRef.current = isOnlineTrack(t)
              lastPlayedIndex.current = auto
              /*
               * **`queueRef` 必须在这里同步写掉。**
               *
               * `setQueueState` 只是排一次渲染，而 `queueRef` 是由 effect 跟着渲染同步的
               * （见下方 `useEffect(() => { queueRef.current = queueState })`）。
               * 也就是说：这一帧对齐完下标之后，**同一个回调里**读 `queueRef.current`
               * 拿到的还是上一首的下标。
               *
               * 下面那段「预告表空了就补」正好在同一个回调里、就在几行之后 —— 它拿
               * 旧下标重新算一遍预告表，算出来的还是刚放完的那两首。原生照着这份表
               * 接着放，于是同一对歌来回放：用户 2026-11-17 报的
               * 「过一段时间就只有 2 首循环」。先摊平这个时序，别指望 React 的批次。
               */
              queueRef.current = { ...q, index: auto }
              setQueueState(s => (s.index === auto ? s : { ...s, index: auto }))
              void bridge.trace(`auto 对齐 idx=${auto}`)
            }
          }
        }
        if (curOnlineRef.current && p.duration > 5) {
          const expect = loadExpect.current
          const here = curLoad.current
          const sameTrack = here && (p as { index?: number }).index === here.index
          /*
           * `p.playing` 这道闸是必须的：这一支会把同一首歌**从 0 重新加载**，
           * 而它挂在每 250ms 一帧的状态流上。用户按了暂停、播放器停在 20 秒，
           * 帧还在来 —— 于是「试听识别」替他又发起一轮加载，取链几秒后
           * `autoplay` 把声音放出来，用户听到的就是「暂停了，过几秒自己又响」。
           * 只有真的在出声时才值得判断「这是不是试听版」。
           */
          if (here && sameTrack && p.playing && expect >= 90 && p.duration < expect * 0.6 && expect - p.duration >= 40) {
            const k = trackKey(here.track)
            if (trialRetry.current.key !== k) trialRetry.current = { key: k, n: 0 }
            if (trialRetry.current.n < 2) {
              trialRetry.current.n += 1
              trialSkip.current = { key: k, platform: lastPlatform.current }
              startLoad(here.track, here.index, { startAt: 0, why: 'trial' })
            } else if (trialRetry.current.n === 2) {
              /* 只提示一次：这段 state 每 250ms 推一帧，不设闸会重复写同一个值 */
              trialRetry.current.n = 3
              setLastError(
                `「${here.track.title}」各平台都只提供 ${Math.round(p.duration)} 秒试听`
                + '，会员账号才能听完整版',
              )
            }
            return
          }
        }
        if (lazyRestored.current) {
          // Rust 侧还没加载音频（恢复出来的是时长未知的曲目）：
          // 只同步音量，别让空转的 0:00 / 0:00 覆盖掉恢复出来的进度
          setSnapshot(s => ({ ...s, volume: p.volume }))
          if (p.error) setLastError(p.error)
          return
        }
        if (!scrubRef.current) {
          /*
           * seek 之后的位置：三个信号一起判。
           *   · Rust 的 `seeking` —— 命令还在队列里 / 音频线程正在重开解码器，位置一定是旧值
           *   · 位置是否已经追上目标（±1.5s）
           *   · 兜底超时 —— 真的卡住了也不能让进度条永远停在你点的地方
           * 以前只有「超时 1.5s」这一条，在线曲目重开 Range 请求常常超过 1.5s，
           * 于是先弹回原处、再跳回来——就是用户说的「进度条跳回原本的位置」。
           */
          const guard = seekGuard.current
          let pos = p.position
          if (guard) {
            const near = Math.abs(p.position - guard.target) <= 1.5
            if (near) {
              seekGuard.current = null
            } else if (p.seeking || performance.now() < guard.until) {
              pos = guard.target
            } else {
              seekGuard.current = null
            }
          }
          /*
           * **手指还在屏幕上就别推位置了。**
           *
           * `snapshot` 是**整个应用**共用的上下文：位置一变，`Ctx.Provider` 的 value
           * 就是新对象，于是播放条、页头、搜索页、歌单详情里那几百行全都重渲染一遍。
           * 平时 250ms 一帧无所谓，可用户正在滑一个长歌单时，每 250ms 插一次全树
           * diff，渲染线程一排队，手指感受到的就是**一格一格地卡**（用户 2026-11-15：
           * 「歌单里面快速滑动感觉会一卡一卡的」）。
           *
           * 位置只喂进度条，而进度条这会儿不在视野里（在滑列表），跳过它完全看不出来；
           * 播放态 / 时长 / 缓冲这些「变了要马上反映」的字段照旧提交。
           */
          if (userActive(400)) {
            commitSnapshot({ ...snapRef.current, playing: settlePlaying(p.playing), duration: p.duration, volume: p.volume, buffered: p.buffered ?? 0 })
          } else {
            commitSnapshot({ ...snapRef.current, playing: settlePlaying(p.playing), position: pos, duration: p.duration, volume: p.volume, buffered: p.buffered ?? 0 })
          }
        } else {
          commitSnapshot({ ...snapRef.current, playing: settlePlaying(p.playing), duration: p.duration, volume: p.volume, buffered: p.buffered ?? 0 })
        }
        // 播放失败：提示 + 自动跳下一首（连续失败 3 次后停止，避免疯狂跳歌）
        if (p.error) setLastError(p.error)
        if (p.ended) {
          /*
           * 放完自动接下一首：**副作用放在 updater 外面**（同 commitQueue 的注释）。
           * `p.ended` 是原生每一帧都可能带着的标志，updater 一旦被 React 重放，
           * 就会多接一首、多一次「换歌前的静音」。
           */
          const n = advance(queueRef.current)
          if (!n) {
            void bridge.stop()
          } else {
            const { event: _e, ...rest } = n
            const t = rest.queue[rest.index]
            if (t) {
              lastPlayedIndex.current = rest.index
              loadedRef.current = trackKey(t)
              commitQueue(rest)
              startLoad(t, rest.index, { why: 'ended' })
            }
          }
        }
        /*
         * **凭空了就补预告表——用状态帧驱动，不用 setTimeout。**
         *
         * 这条链路存在的唯一理由是「熄屏后 WebView 的定时器会被节流到分钟级」：
         * `prefetchTimer` 那一版在后台几乎不跑，在线歌的预告表于是越来越短，
         * 原生放完手里那两首就停在曲末（用户看到的「在线歌单放一段时间就停」）。
         * 缓存歌不受影响——它们进表时不需要取链，一次 `setPrefetch` 就能撑到底。
         *
         * 每一帧状态都是原生 `evaluateJavascript` 推过来的，**不受定时器节流影响**，
         * 所以「表空了」这件事在任何时候都能被看见。12 秒防抖只是避免连续取链
         * 把平台打出限流（那反而会让失败率更高）。
         */
        if (p.playing && typeof p.pf === 'number' && p.pf <= 0 && !loadingRef.current && !pfBusy.current) {
          const now = Date.now()
          if (now - pfBeatAt.current > pfGap.current) {
            pfBeatAt.current = now
            const q = queueRef.current
            void bridge.trace(`pf beat 补表 pf=0 idx=${q.index} n=${q.queue.length}`)
            /* 表真空了：允许重取同一份计划（skip 只拦「例行重算」） */
            void buildPrefetchRef.current(q, { force: true })
          }
        }
      }))

      unsubs.push(bridge.onScanProgress(p => setScanProgress(p)))
    })()

    /*
     * 看门狗：每 2 秒跟原生对一次账。
     *
     * 为什么要它：这个界面所有「在放 / 没在放」都只靠 `player://state` 事件流喂。
     * 事件一旦断供（页面被系统冻过一段、WebView 重挂、订阅那段初始化里某个 await
     * 抛了错），前端就永远停在最后一帧：明明在出声，按钮却显示「播放」、
     * 或者转圈永远不停 —— 用户点它，发出去的是**相反**的那条命令，
     * 表现就是「点暂停它又接着播」「点了完全没反应」。
     * 这里用最笨也最可靠的办法兜住：原生手里有真相，隔两秒问一次，不一致就纠正。
     * 只在「确实不一样」时写 state，不会让界面抖。
     */
    /*
     * 网络真的回来了：把重试额度还回去，让看门狗立刻再试一次那一首。
     *
     * 为什么不能只靠看门狗自己轮询：`navigator.onLine` 在安卓 WebView 里经常
     * **一直返回 true**（它只看有没有网卡，不看到不到外网），所以「网断过又回来」
     * 这件事它看不见；而 `online` 事件在部分机型换 WiFi / 关飞行模式时也不发。
     * 两条路都挂上，谁先醒谁知道。
     */
    const netBack = () => {
      const f = failRetry.current
      if (!f || loadingRef.current) return
      retryTries.current = { key: '', n: 0 }
      failRetry.current = { ...f, at: 0 }
      void bridge.trace('netback 额度重置，准备重试 idx=' + f.index)
    }
    window.addEventListener('online', netBack)

    const dog = window.setInterval(() => {
      if (!hydrated.current) return
      /*
       * 断网期间取链失败的那一首：网回来了自己再试。
       *
       * 为什么要跟看门狗绑在一起、而不是只听 `window 'online'`：安卓 WebView 的
       * `online` 事件在「换了 WiFi / 热点恢复 / 飞行模式关掉」这几种情况下未必发，
       * 而 `navigator.onLine` 又常常一直是 true（它只看有没有网卡，不看到不到外网）。
       * 所以这里退一步：**间隔 6 秒、最多两次**的无脑重试。真没网时也就是两条
       * 注定超时的请求，比「用户以为 App 坏了」便宜得多。
       */
      const f = failRetry.current
      if (f && !loadingRef.current && !playWant.current && !autoCancel.current && Date.now() - f.at > 6000) {
        const k = trackKey(f.track)
        if (retryTries.current.key !== k) retryTries.current = { key: k, n: 0 }
        if (retryTries.current.n < 2) {
          retryTries.current.n += 1
          failRetry.current = null
          void bridge.trace(`retry ${retryTries.current.n}/2 idx=${f.index} why=net`)
          startLoad(f.track, f.index, { why: 'retry-net' })
          return
        }
        /*
         * 额度用完了**不要**把记录删掉。
         *
         * 真机上「断网几分钟再连回来」才是最常见的形状：两次轮询（十几秒）早就打空了，
         * 这时网才回来。删掉记录等于彻底放弃那一首，用户还是得自己再点一遍。
         * 留着它，等 `online` 事件 / `navigator.onLine` 翻转时把额度还回去再试。
         */
      }
      void bridge.playerState().then(st => {
        const cur = snapRef.current
        /* 转圈卡住：原生已经有播放器或已经在出声，说明加载其实成了 */
        if (loadingRef.current && (st.playing || st.duration > 0)) stopLoading()
        /* 用户刚点完、在等原生回声：别抢方向盘 */
        if (playWant.current) return
        /*
         * 位置也要对账，**不能只看播放态**。
         *
         * 事件流断掉的时候（WebView 重挂、订阅那段某个 await 抛错），界面会冻在
         * 最后一帧：歌在响、封面歌词都对，**只有进度条不动**。以前这条判断只比
         * `playing`，两边都是 true 就什么都不做——于是「在放但进度条停住」这个
         * 症状没有任何自愈路径（2026-11-16 用户报的那条）。
         * 3 秒是容差：正常一帧 250ms，差到 3 秒说明前端已经跟不上了。
         */
        const drift = Math.abs(st.position - cur.position)
        if (st.playing !== cur.playing || (st.playing && drift > 3)) {
          commitSnapshot({
            ...cur,
            playing: st.playing,
            position: st.position > 0 ? st.position : cur.position,
            duration: st.duration > 0 ? st.duration : cur.duration,
          })
        }
      }).catch(() => { /* 问不到就算了，下一次再试 */ })
    }, 2000)

    return () => {
      window.clearInterval(dog)
      window.removeEventListener('online', netBack)
      unsubs.forEach(u => u())
    }
  }, [])

  /* 队列变化 → 播放当前曲 */
  useEffect(() => {
    queueLenRef.current = queueState.queue.length
    const t = currentTrack(queueState)
    if (t && queueState.index !== lastPlayedIndex.current) {
      lastPlayedIndex.current = queueState.index
      /*
       * **原生手里正在响的已经是这首：什么都别做。**
       *
       * 这条 effect 只看「队列变了、下标变了」，可分不清「真的换了歌」和
       * 「别的 state 更新把队列对象换了个新的」。后者一旦走到 `startLoad`，
       * 第一件事就是「换歌前的静音」（`bridge.pause`）→ 取链 → 再出声，
       * 用户听到的就是**歌自己停了**（用户 2026-11-15 报的「连点两次下一首，
       * 歌曲就会暂停播放」）。原生那帧状态是同步可读的，先问一句最便宜。
       */
      const live = lastKnownPlayerState() as { index?: number; playing?: boolean } | null
      if (live && live.playing === true && live.index === queueState.index) return
      /*
       * 队列被编辑（删歌、拖排序）导致「当前曲」换了一首时，**别替用户按播放**。
       * 他要是正暂停着，就静默把这一首准备好；`autoCancel` 此刻正是「用户在暂停」
       * 的真值（按播放时会被清掉）。
       */
      startLoad(t, queueState.index, { keepPause: autoCancel.current, why: 'queue' })
    }
  }, [queueState])

  /**
   * 歌词统一入口。
   * 本地曲目：同名 .lrc / 内嵌 → lrclib 兜底；
   * 在线曲目：直接问平台（网易云/QQ/酷我/酷狗的歌词接口都通了），
   *           拿不到再退回 lrclib，避免「在线歌全部没歌词」。
   * `retry` 交给下面那次自动重试用：重试要真的重新打接口，不能命中空结果记录。
   */
  const lyricsFor = useCallback(async (t: LocalTrack, retry = false): Promise<LyricsDoc> => {
    if (!isOnlineTrack(t)) return loadLyrics(t, { retry })
    /*
     * 断网也要有词：先看上次在线拿到的那份有没有落盘（见 `mediaCache`）。
     * 在线曲目的音频已经能离线播（`audioCache`），歌词却每次都得重新联网，
     * 结果就是「没网时歌在响、词是空的」（用户 2026-11 反馈）。
     * 只有用户点「重新加载」（retry）时才无条件走网络并覆盖存量。
     */
    if (!retry) {
      const saved = await cachedLyric(t.id).catch(() => null)
      if (saved) {
        const lines = parseLrc(saved)
        if (lines.length) return { source: 'online', lines, plain: saved }
        if (saved.trim()) return { source: 'online', lines: plainLyricLines(saved), plain: saved }
      }
    }
    /*
     * 平台歌词（按歌曲 id 精确取）。**只有这一路拿到的词才落盘**：
     * 跨平台兜底 / lrclib 的结果是按歌名模糊匹配来的——歌名对得上、
     * 时间轴却可能是另一个版本（MV / 加长版 / DJ 版）的，高亮全错。
     * 缓存是**永久性**的（见 mediaCache），模糊结果一旦落盘就再也
     * 不会自愈（2026-11-21 平板「海屿你歌词对不上」就是这么来的：
     * 本平台偶尔失败一次，别家那份错时间轴的词存了一辈子）。
     * 模糊结果只在**本次会话**显示，下次播再重新问——本平台恢复后
     * 自然拿到对的那份。
     */
    const r = await onlineLyric(t)
    if (r.text.trim()) {
      const lines = parseLrc(r.text)
      if (r.exact) void rememberLyric(t.id, r.text, retry)
      return lines.length
        ? { source: 'online', lines, plain: r.text }
        : { source: 'online', lines: plainLyricLines(r.text), plain: r.text }
    }
    /* lrclib 兜底同样不落盘（按歌名模糊匹配，无法核对时间轴） */
    const fallback = await forceOnlineLyrics(t).catch(() => null)
    return fallback ?? { source: 'none', lines: [], plain: '' }
  }, [])

  /* 歌词：跟随当前曲目加载（本地优先，miss 后在线），全应用共享 */
  const currentId = currentTrack(queueState)?.id ?? null
  const curCover = currentTrack(queueState)?.cover ?? null
  curOnlineRef.current = isOnlineTrack(currentTrack(queueState))

  /*
   * 当前这首的封面**顺手存一份到本地**。
   *
   * 断网时在线曲目只有音频能播（缓存过的），封面是 CDN 直链、拿不到就只剩
   * 一块灰渐变。存一份之后 `coverUrlOf` 会优先用本地那张。
   * 只存「正在听的这一首」：列表里几十张全下会白烧流量（见 `rememberCover`）。
   */
  useEffect(() => {
    if (curCover) rememberCover(curCover)
  }, [curCover])

  /*
   * 同步给系统媒体会话（SMTC）。
   *
   * 这一步不是「顺手做的好看」：Windows 的耳机线控/蓝牙按键是**按会话**路由的，
   * 没有会话就没有按键，锁屏和音量浮层也不会显示歌名。状态只在换歌与播放/暂停时变，
   * 不跟着 progress 每 250ms 刷。
   *
   * cover / fav 是安卓通知用的（桌面端 Rust 只认四个参数，多传的字段会被忽略）：
   * MIUI 的媒体卡片没有封面大图就画成一片空白；收藏态变了也要重推一次，
   * 通知上的那颗心才能跟着亮/灭。
   */
  const favs = useFavs()
  const curFavOn = currentId ? favs.has(currentId) : false

  /* ---------------- 播放历史：真正出声了才记 ---------------- */
  /**
   * 只在「这首真正开始播」时记一条：`playing` 来自事件流（不能拿意图充数），
   * 同一首歌只记第一次（暂停再续不算新的一次）。换歌必换 `currentId`，
   * 所以 ref 一比对就知道该不该记。
   */
  const lastHist = useRef<string | null>(null)
  useEffect(() => {
    if (!snapshot.playing || !currentId || lastHist.current === currentId) return
    const t = currentTrack(queueState)
    if (!t) return
    lastHist.current = currentId
    void recordHistory(t)
  }, [snapshot.playing, currentId, queueState])

  /* ---------------- 下一首预告（安卓：息屏时自动接歌靠它） ---------------- */
  /**
   * 往前预告几首。
   *
   * 这个数就是「熄屏后还能自己播多久」：预告表是原生**唯一**的续播依据，
   * 用完就只剩 `ended` 一帧推给 JS（那时 WebView 往往已经被系统摁住，
   * 没人接就停在两首之间）。所以它不能是 0。
   *
   * **但也不能是 10。** 每一项都要走一遍 `resolvePlayUrl`：注册表重搜 +
   * 本平台各档取链（并行竞速）+ 700ms 后起跑的「其它平台搜索」，10 项叠起来
   * 是几十个请求同时打到同一批平台上。真机表现是：点开一首没听过的歌，
   * 出声之后网就开始被这些后台请求挤，缓冲走走停停，用户以为「加载一半坏了」。
   *
   * 用户 2026-11-15 的原话：「顶多预加载下一首我感觉就差不多了」。
   * 取 2：下一首 + 再下一首兜底（第一首取链失败时表里还有一条，不至于断）。
   */
  const PREFETCH_N = 2
  /**
   * 取链并发度。
   *
   * 4 路在真机上被量出来是会拖慢「点歌那一下」的（2026-11-15 A/B：同一批歌
   * 3.7s vs 2.1s）——每条 `resolvePlayUrl` 内部本来就有三条泳道在跑。
   * 现在整表只有 2 首，直接串行：**任何时刻都不和用户点的那首歌抢请求**。
   */
  const PREFETCH_CONC = 1
  /** 每次重算都换号：旧轮次在下一个 await 边界自己退出（同 resolvePlayUrl 的 cancel） */
  const prefetchSeq = useRef(0)
  const prefetchTimer = useRef(0)
  /**
   * 上一次「按状态帧补表」的时间。
   *
   * 补表原来只有 `prefetchTimer` 一条路（1200ms setTimeout），而熄屏后 WebView 会把
   * 定时器节流到分钟级，在线歌的预告表就补不上——原生放完手里那两首就停在曲末。
   * 现在多一条：原生每 250ms 推一帧（走 evaluateJavascript，不受定时器节流），
   * 帧里带 `pf`（表里还剩几首），这里看到 0 就补。这个 ref 只是防抖，别每帧都取链。
   */
  const pfBeatAt = useRef(0)
  /**
   * 有没有一次补表正在进行。
   *
   * 没有这个闸会出现**自我取消的死循环**（2026-11-17 真机日志确认）：
   *
   *   状态帧每 250ms 一帧，`pf=0` 一直成立 → 每 12 秒触发一次补表 →
   *   每次 `buildPrefetch` 开头都 `++prefetchSeq`，把**上一次还没跑完**的那次取消 →
   *   上一次在 `await resolvePlayUrl` 里返回，`seq !== prefetchSeq` 直接退出，
   *   一张表都没递出去 → `pf` 还是 0 → 12 秒后又来一遍。
   *
   * 日志里的形状是：`pf beat 补表 pf=0` 每 10~16 秒重复一次，而
   * `setPrefetch n=` 一行都没有 —— 也就是说原生手里那张表**一直是空的**，
   * 在线歌放到当前这首结束就没人接；能接着放全靠 `ended` 交给 JS 走完整加载
   * （而这条链在后台随时会被冻住）。这正是「放着放着就停/只在两首之间来回」。
   *
   * 所以：补表期间不许再起一次；真需要立刻重算（换歌、改队列）时，
   * 由调用方先 `prefetchSeq.current++` 把它作废，那个口子留给 `buildPrefetch` 的
   * 常规入口，不在这里堵。
   */
  const pfBusy = useRef(false)
  /** 正在跑的那一轮是「从哪首算起」：用来区分「纯重算」和「真换歌」 */
  const pfRunningIdx = useRef(-1)
  /** 跑的过程中来的重算请求（只留最新的一个） */
  const pfPending = useRef<QueueState | null>(null)
  /**
   * 两次补表之间至少隔多久。
   *
   * 正常情况下 12 秒（一次取链最多十来秒，别再往上叠）。但如果这次**一首都没取到**，
   * 说明平台这会儿正在限流 / 没网 —— 再按 12 秒硬刷，等于用更高的频率去撞同一堵墙，
   * 反而把限流拖得更久。空表之后退到 60 秒。
   */
  const pfGap = useRef(12_000)
  /**
   * 上一次**真的递交成功**的那张表长什么样（起点 + 循环模式 + 计划下标）。
   *
   * 为什么需要：定时器（队列一变就 1.2s 重排）和 `visibilitychange` 会在同一首
   * 歌上反复触发重算，每次都要走 2 条 `resolvePlayUrl`。真机日志里一首 4 分钟
   * 的歌能看到 5 次 `pf plan base=0/4 -> [1,2] send=2` —— 同样的两首歌被反复
   * 取链，白烧平台配额（限流会直接抬高失败率）。
   *
   * 同一份计划在 2 分钟内已经递交过就不再取链；`force` 的那条路（原生 pf=0，
   * 表真的空了）不受这个限制。
   */
  const pfSentSig = useRef('')
  const pfSentAt = useRef(0)
  const queueRef = useRef(queueState)
  /*
   * 镜像只在**状态真的变化之后**对齐，不在渲染期赋值。
   *
   * 渲染期赋值（`queueRef.current = queueState`）看起来更及时，但它会把
   * `commitQueue` 刚写进去的「乐观值」冲回上一版：`setQueueState` 提交之前，
   * 任何一次无关的重渲染（快照 250ms 一帧）都会先把旧队列写回镜像，
   * 「连点两下下一首」第二下就基于旧队列算回了同一首。
   */
  useEffect(() => { queueRef.current = queueState }, [queueState])
  /**
   * 用户动作改队列：**先写镜像，再交给 React**。
   *
   * 为什么不能只在 `setQueueState(updater)` 里做（以前的写法就是这样）：
   *
   *   · updater 必须是纯函数，React 有权**重放**它（并发渲染回滚、重新计算队列）。
   *     以前 `next()` / `playList()` 把 `startLoad()` 这种带副作用的调用塞在
   *     updater 里 —— 一旦被重放，就凭空多出一次「换歌前的静音 + 取链」，
   *     用户听到的就是**歌自己停了**，而且时序随机、极难复现。
   *   · 副作用里还要读「下一首是谁」，那必须读**算完之后**的状态；渲染还没发生，
   *     闭包里的 `queueState` 是旧的。
   *
   * 现在的分工：动作函数同步算出新队列 → 写镜像（连点两下也一步一算）→
   * `setQueueState` 只负责把这份新状态交给 React → 再在外面发起加载。
   */
  const commitQueue = useCallback((st: QueueState) => {
    queueRef.current = st
    setQueueState(st)
  }, [])
  /**
   * 最新一版 `buildPrefetch`。
   *
   * **不能把 `buildPrefetch` 直接放进 effect 的依赖里**：它 `useCallback` 的依赖
   * 是 `favs`，而 `useFavs()` 每次都返回一个新对象 —— 这个函数每帧都是新的，
   * effect 于是每帧「清定时器 → 重排定时器」，1200ms 的定时器在播放时
   * （位置 250ms 一帧）**永远等不到触发**。2026-11-15 实测：`[pf]` 一行日志都没有，
   * 原生 `setPrefetch` 也从没被调用过 —— 也就是说「预告表」这条链路当时压根没跑，
   * 息屏后能连着听几首全靠运气。
   */
  const buildPrefetchRef = useRef<(q: QueueState, opts?: { force?: boolean }) => Promise<void>>(async () => {})

  /**
   * 把「接下来会放的几首」的直链递给原生。
   *
   * 为什么要有：自动下一首整条链路（取直链 → play_url）都捏在前端，而息屏之后
   * WebView 的任务会被系统摁住——上一首自然放完时没人拉下一首，声音就停在
   * 两首之间，亮屏才接上（用户 2026-11-09 反馈）。原生手里有直链就能自己接。
   *
   * 顺序用 `advance` 模拟，所以随机播放 / 单曲循环跟真放时一致：
   *   · 单曲循环 → 同一首预告 N 份（原生放完重开这条链，不再等 JS）
   *   · 走到队列末尾 → `advance` 返回 null，表就短一截
   */
  const buildPrefetch = useCallback(async (base: QueueState, opts?: { force?: boolean }) => {
    if (!isAndroid) return
    /*
     * 同一个「起点」的重算没有任何意义 —— 挡在门外。
     *
     * 2026-11-17 真机日志里出现过 `pf abort 被新一轮顶掉` 连着来：状态帧那条路
     * 已经被 `pfBusy` 挡住了，但**定时器（队列一变就 1.2s）和 `visibilitychange`
     * 这两条路没挡**。它们在同一首歌上反复重算，每次都把上一轮还在 `await
     * resolvePlayUrl` 里的那次作废，结果又是「一轮都没递出去，pf 一直是 0」。
     *
     * 注意不能简单 return：换歌时必须让旧表作废（否则原生会拿上一首算出来的
     * 「下一首」去放别的歌）。判据就是起点下标：同一下标＝纯重算，记一笔排队；
     * 下标变了＝真的换歌，放行并打断旧的。
     */
    if (pfBusy.current) {
      if (base.index === pfRunningIdx.current) {
        pfPending.current = base
        return
      }
      void bridge.trace(`pf 换歌打断 base=${base.index} 旧=${pfRunningIdx.current}`)
    }
    const seq = ++prefetchSeq.current
    pfBusy.current = true
    pfRunningIdx.current = base.index
    try {
    const plan: { index: number; track: LocalTrack }[] = []
    let walk = base
    for (let k = 0; k < PREFETCH_N; k++) {
      const n = advance(walk)
      if (!n) break
      walk = n
      const t = walk.queue[walk.index]
      if (!t) break
      /* 单曲循环就是要同一首反复放；其他模式下撞到重复下标说明绕回环了 */
      if (walk.repeat !== 'one' && plan.some(x => x.index === walk.index)) break
      plan.push({ index: walk.index, track: t })
    }
    /*
     * **同一份计划刚递交过就别再取链。**
     *
     * 定时器（队列一变就 1.2s 重排）和 `visibilitychange` 会在同一首歌上反复
     * 触发重算，算出来的还是同样两首。2026-11-17 真机日志里，一首 4 分钟的歌
     * 出现 5 次 `pf plan base=0/4 -> [1,2] send=2` —— 也就是同两首歌被取链
     * 5 遍，白烧平台配额（限流本身就是失败率的一大来源）。
     *
     * `force` 那条路（原生状态帧里 pf=0，表真的空了）不受限制：宁可多取一次，
     * 也不能让播放器手里没货。
     */
    /* 计划里带 track id：队列被重排/换歌但下标恰好相同时，不能当成同一份计划 */
    const sig = `${base.index}|${base.repeat}|${base.order}|` +
      plan.map(x => `${x.index}:${x.track.id}`).join(',')
    if (!opts?.force && sig === pfSentSig.current && Date.now() - pfSentAt.current < 120_000) {
      void bridge.trace(`pf skip 同一计划 [${plan.map(x => x.index).join(',')}] base=${base.index}`)
      return
    }
    /*
     * 并发取链，不再一首一首 await。
     *
     * 串行的代价在「秒」这个量级上：每首 1~3 秒，10 首就是十几秒，而页面一进
     * 锁屏就被冻住——冻住那一刻拿到几首算几首。用户点开播放随手熄屏时，串行
     * 版往往一首都还没递出去，于是「只播一首就停」。
     */
    const slots: (Record<string, unknown> | null)[] = new Array(plan.length).fill(null)
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const i = cursor++
        if (i >= plan.length || seq !== prefetchSeq.current) return
        const t = plan[i].track
        const head = {
          index: plan[i].index,
          title: t.title,
          artist: t.artist,
          album: t.album,
          cover: t.cover ?? effectiveSong(t.id)?.img ?? '',
          fav: favs.has(t.id),
          duration: t.duration || 0,
        }
        if (!isOnlineTrack(t)) { slots[i] = { ...head, path: t.path }; continue }
        try {
          /*
           * **等用户的手停下来再取链。**
           *
           * 一条 `resolvePlayUrl` 里至少三条泳道（本平台竞速 + 兜底 + 700ms 后起跑的
           * 跨平台搜索），每条都要解析 JSON、走一遍桥；这在用户滑列表的时候插进去，
           * 就是一次几十毫秒的主线程卡顿。预告表本来就不着急（当前这首已经在放了），
           * 让它排在手指后面完全没损失。
           */
          await waitIdle(700)
          if (seq !== prefetchSeq.current) return
          const r = await resolvePlayUrl(t, { cancel: () => seq !== prefetchSeq.current })
          slots[i] = { ...head, url: r.url, duration: r.duration || head.duration }
        } catch (e) {
          /*
           * 单条取不到就少撑一首：不写进表，原生放到那儿会走老路（交还前端）。
           *
           * 但**必须留下原因**：`send=0` 这种「计划有两首、一首都没取到」是
           * 「后台只循环两首」的直接原因（表一直是空的），以前这里是静默 catch，
           * 真机上只能看到 `send=0` 却不知道是限流、断网还是没源。
           */
          void bridge.trace(`pf 取链失败 idx=${plan[i].index} "${t.title}" ${(e as Error)?.message ?? String(e)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PREFETCH_CONC, plan.length) }, worker))
    if (seq !== prefetchSeq.current) { void bridge.trace('pf abort 被新一轮顶掉'); return }
    /* 取链失败的项留空，压掉——原生按 FIFO 播，缺一首就是少撑一首 */
    const items = slots.filter(Boolean) as Record<string, unknown>[]
    /*
     * 一行日志要能回答三个问题：从哪首算起、算出来是哪几首、真递过去了几首。
     * 「只剩两首循环」这类症状，靠这一行就能看出是「计划本来就只有两首」还是
     * 「计划有 4 首但取链只成功 2 首」。
     */
    void bridge.trace(
      `pf plan base=${base.index}/${base.queue.length} -> [${plan.map(x => x.index).join(',')}] send=${items.length}`,
    )
    /* 一首都没取到 → 退到 60 秒再试（见 pfGap 的注释） */
    pfGap.current = items.length > 0 ? 12_000 : 60_000
    /* 记住这份表：同样的计划 2 分钟内不再重取（见上面 sig 的注释） */
    if (items.length > 0) {
      pfSentSig.current = sig
      pfSentAt.current = Date.now()
    }
    void bridge.invoke('next_prefetch', { items }).catch(() => { /* 桌面端没有这条命令 */ })
    } finally {
      pfBusy.current = false
      pfRunningIdx.current = -1
      /*
       * 跑的过程中有人要重算（队列/循环模式/喜欢状态变了）：等这一轮收工再算。
       * 现在就重算等于把刚取到的几首扔掉——真机上「只剩两首循环」那阵子，
       * 一半的时间花在重复取同一批歌上。
       */
      const pend = pfPending.current
      pfPending.current = null
      /*
       * 只有**内容真的变了**才重算。
       *
       * 之前写的是 `pend.queue !== base.queue`（引用比较）—— `commitQueue` 每次都
       * 造新对象，于是「同一队列的重算请求」也会被当成换队列，收尾时立刻再算一轮，
       * 新一轮又把下一轮顶掉…… 真机表现就是 `pf abort 被新一轮顶掉` 每几秒一次、
       * `send=` 一次都没有。比内容（`queueFingerprint`）才断得干净。
       */
      if (pend && queueFingerprint(pend) !== queueFingerprint(base)) {
        void buildPrefetchRef.current(pend)
      }
    }
  }, [favs])
  /* 每帧同步一次：定时器/可见性回调都从 ref 取，避免被「每帧都是新函数」拖着重排 */
  buildPrefetchRef.current = buildPrefetch

  /*
   * 队列一变就重算预告（当前曲 / 顺序 / 循环模式都会影响「下一首是谁」）。
   *
   * **必须等当前这首真的出声（`playing`）再排。**
   *
   * 2026-11-15 用户报「加载歌曲变慢了」：上一版为了抢在熄屏冻结之前，把延迟压到
   * 0.3s 并开 4 路并发取链——可这 0.3s 正好撞上「点歌那一下」自己还在取链。
   * 一条 `resolvePlayUrl` 内部就有本平台音源竞速 + 兜底平台 + 700ms 后起跑的
   * 「其它平台搜索」三条泳道，4 条预取叠上去就是十几个请求同时打同一批平台，
   * QQ/酷狗一限流，当前这首的链就排在后面 —— 用户等的那几秒全花在这儿。
   * 改成「当前这首出声了再排」：此刻它的链已经拿到，预取只和**下载**抢带宽，
   * 抢带宽有 `warmCache` 那套节流兜着，不会拖慢起播。
   *
   * 冻结风险仍然由下面那条 `visibilitychange` 兜：真·点开就锁屏的，那条会再递一次。
   */
  useEffect(() => {
    if (!isAndroid) return
    window.clearTimeout(prefetchTimer.current)
    if (!snapshot.playing) return
    prefetchTimer.current = window.setTimeout(() => { void buildPrefetchRef.current(queueRef.current) }, 1200)
    return () => window.clearTimeout(prefetchTimer.current)
  }, [queueState.index, queueState.queue, queueState.repeat, queueState.order, snapshot.playing])

  /*
   * 切后台 / 熄屏前最后一搏：`visibilitychange` 是页面彻底被冻住之前**还能跑完
   * 的最后一个同步钩子**。这里再递一次整表，把「刚点开就锁屏」这种最常见的情况
   * 兜住；取链是异步的，能不能跑完看运气，但试一次不亏。
   */
  useEffect(() => {
    if (!isAndroid || typeof document === 'undefined') return
    const onVis = () => {
      if (document.visibilityState === 'hidden') void buildPrefetchRef.current(queueRef.current)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  /* ---------------- 把手边这几首提前落盘（停着的时候最该干这事） ---------------- */
  const warmSeq = useRef(0)
  /**
   * 预缓存「接下来会放的几首」。
   *
   * 用户的原话：「歌曲暂停以后，好像后面的就不会加载了，按道理加载应该在他
   * 暂停的时候更应该抓紧时间加载」。他说的对：
   *
   *   · 正在放的时候，带宽要留给**当前这首**（`warmCache` 那 6 秒延迟就是这个
   *     道理）——再多开几条下载，用户听到的是「卡一下、声音断了」；
   *   · 暂停的时候声音停了、带宽全闲、网络刚热起来，这是唯一「多下几首也不会
   *     被骂」的窗口。等再点播放，下一首已经在本机了，切歌就是秒切。
   *
   * 所以两档：暂停 → 连下 3 首、1.2 秒后起手；播放中 → 只补 1 首、12 秒后起手。
   * 只做在线曲（本地文件不需要缓存），失败静默（真放的时候会重新取链）。
   */
  useEffect(() => {
    if (!bridge.isNative) return
    if (!currentTrack(queueState)) return
    const seq = ++warmSeq.current
    /*
     * **只补下一首，播放和暂停都一样。**
     *
     * 这里以前是「暂停时连下 8 首、播放中补 1 首」，理由是「暂停时带宽闲着，
     * 多下几首下次切歌就秒切」。真机上的代价是：8 首整曲串行下载要跑几十秒，
     * 用户随手按了播放，**正在下载的那一首不会让路**（`warmCache` 只是一次
     * 阻塞式 download，中途不可取消），于是正在听的这首开始卡、缓冲走走停停。
     * 用户 2026-11-15 的原话：「预加载太多了，导致卡顿，顶多预加载下一首」。
     *
     * 现在的分工：
     *   · 当前这首 —— 出链成功就顺手落盘（见 startLoad 里的 `warmCache`，延迟 6 秒）；
     *   · 下一首   —— 这里补，播放中 12 秒后起手、暂停时 1.2 秒后起手；
     *   · 再往后   —— 一朵都不碰，真放到它时再取一次链（现在有预告表 2 首兜底）。
     */
    const ahead = 1
    const delay = snapshot.playing ? 12000 : 1200
    const seen = new Set<string>()
    const timer = window.setTimeout(() => {
      void (async () => {
        let walk = queueState
        for (let k = 0; k < ahead; k++) {
          const n = advance(walk)
          if (!n) break
          walk = n
          if (seq !== warmSeq.current) return
          const nt = walk.queue[walk.index]
          /* 单曲循环会连着给同一首，去过重再说 */
          if (!nt || !isOnlineTrack(nt) || seen.has(nt.id)) continue
          seen.add(nt.id)
          try {
            /* 已经有缓存的别再去要一次直链：既慢又快被平台限流 */
            if (await hasCachedAudio(nt.id)) continue
            if (seq !== warmSeq.current) return
            /* 同预告表：用户还在滑/切歌时别插队（一次取链就是三条请求的连锁） */
            await waitIdle(700)
            if (seq !== warmSeq.current) return
            const r = await resolvePlayUrl(nt, { cancel: () => seq !== warmSeq.current })
            /* await：串行落盘，避免暂停期间开一堆下载（恢复播放时抢带宽） */
            await warmCache(nt.id, r.url, 0)
            if (seq !== warmSeq.current) return
          } catch { /* 取不到就算了，等真放到它的时候再取一次 */ }
        }
      })()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [queueState.index, queueState.queue, queueState.repeat, queueState.order, snapshot.playing])

  /* 元数据里这几个字段都要进依赖：冷启动时封面是**后来补**的（见下面的封面补全），
     只在 currentId/playing 变化时推的话，通知栏那张卡会一直停在「应用图标 + 疏音」。 */
  const metaTrack = currentTrack(queueState)
  /*
   * 封面落盘缓存的变化版本：离线时原生拿 CDN 直链只会失败（通知/锁屏黑封面），
   * 所以 meta 里的 cover 要优先换成本地路径；缓存是异步补的（boot 载索引、
   * rememberCover 1.5s 后落盘），落盘完成版本号 +1，靠它在依赖里触发重推。
   */
  const cacheVer = mediaCacheVersion()

  /*
   * 灵动岛（iOS Live Activity）：把「当前曲目 + 播放状态」推给原生。
   *
   * 只在状态**真的变了**的时候调（换歌 / 播放暂停 / 拖动进度 / 封面补全），
   * 绝不当心跳用：进度条由扩展里的 `Text(timerInterval:)` 自己走秒，
   * 每秒推一次只会烧掉 Live Activity 的更新预算（超了系统会限流，
   * 表现就是「灵动岛卡在某一秒不动」）。
   *
   * 封面必须先压成 base64：扩展和主 App 是两个沙箱，路径在那边读不到。
   */
  const liveSyncNow = useCallback(
    async (t: LocalTrack | undefined, playing: boolean, position: number, duration: number) => {
      if (!isIOS) return
      if (!t) {
        // 队列空了 / 播完了：把锁屏上那条收掉，别留一块过期的卡片
        void bridge.liveEnd().catch(() => { /* 没有活着的 activity 时是空操作 */ })
        return
      }
      const art = await liveArtOf(cachedCoverPath(t.cover) ?? null)
      void bridge.liveSync({
        title: t.title ?? '',
        artist: t.artist ?? '',
        album: t.album ?? '',
        art,
        playing,
        position: Math.max(0, position || 0),
        duration: Math.max(0, duration || 0),
        anchor: Date.now() / 1000,
      }).catch(() => { /* 灵动岛起不来不该影响播放 */ })
    },
    [],
  )

  useEffect(() => {
    if (!bridge.isTauri && !isAndroid) return
    const t = currentTrack(queueState)
    /*
     * 队列空了就**别再推空 meta**。
     *
     * 以前这里无条件推，title/artist 全是空串。原生照着它建通知：标题回落到
     * 「疏音」、封面大图没有、动作按钮照旧六个——MIUI 上就是一块白板
     * （用户：「播放列表为空时，小米的状态栏会显示白的一片」）。
     * 现在没有曲目就不推，让原生那边按「没东西可放」收摊。
     */
    if (!t) {
      /*
       * 桌面（Windows SMTC）：照旧推一次空值——Rust 那边收到空标题就把系统媒体浮层清掉。
       * 安卓：**一句都不推**。推空标题过去，原生会照着它建一张没有封面、没有文字、
       * 却带着六个按钮的通知，MIUI 渲染出来就是一块白板。
       */
      if (bridge.isTauri) {
        void bridge.invoke('smtc_update', { title: '', artist: '', album: '', playing: false, cover: '', fav: false }).catch(() => {})
      }
      void liveSyncNow(undefined, false, 0, 0)
      return
    }
    void bridge.invoke('smtc_update', {
      title: t.title ?? '',
      artist: t.artist ?? '',
      album: t.album ?? '',
      playing: snapshot.playing,
      cover: cachedCoverPath(t.cover) ?? t.cover ?? '',
      fav: curFavOn,
      /*
       * 锁屏「正在播放」卡片靠这两个画进度条。
       *
       * 只在切歌 / 暂停 / 恢复时推一次——系统拿「已播秒数 + 播放速率」自己走秒。
       * 每秒推一次不但没必要，还会让后台被节流的 App 把卡片卡在某一秒不动
       * （和灵动岛那边是同一个教训）。
       */
      position: snapshot.position,
      duration: snapshot.duration,
    }).catch(() => { /* 系统媒体会话不可用不影响播放 */ })
    /*
     * 留痕：通知栏「切了歌但信息不跟」时，最需要分清的是
     *   · 前端根本没推（这条不出现）→ 是 `currentId` 没变，队列下标没动；
     *   · 推了但原生没吃（原生侧有 `meta <-` 那条，成对看）。
     */
    void bridge.trace(`meta push "${t.title ?? ''}" idx=${queueState.index}`)
    /*
     * 顺手推一份给灵动岛。
     *
     * 这里用渲染时的 `snapshot.position` 而不是现查一次 `playerState()`：
     * 切歌的那一帧刚发完 play_file，原生状态还没回来，现查会拿到上一首的
     * 位置——反而更错。effect 的依赖里没有 position 是故意的：位置每秒都变，
     * 进了依赖就等于每秒推一次。
     */
    void liveSyncNow(t, snapshot.playing, snapshot.position, snapshot.duration)
  }, [currentId, snapshot.playing, curFavOn, cacheVer, liveSyncNow,
      metaTrack?.title, metaTrack?.artist, metaTrack?.album, metaTrack?.cover])

  /*
   * 悬浮歌词（安卓）：推「当前句 + 下一句 + 本句唱到哪儿」给原生，由服务的悬浮窗画。
   *
   * 2026-11-01 用户要求「像电脑端那样上下两行、唱到哪个字染哪个字」，所以推的形状
   * 从一句 text 变成四个字段：
   *   · cur / next —— 上下两排的字（next 为空时原生只画一行）；
   *   · prog      —— 本句进度 0~1，原生按字数逐字染色；
   *   · flip      —— 行序号奇偶，决定哪一排在上（KTV 那种斜对角轮换）。
   * 进度每 250ms 的心跳都会推一次（原生只在悬浮窗开着时才会重绘），
   * 但把 prog 量化到 1%，否则一首歌要发几万次无意义的重复包。
   */
  const lastFloat = useRef('')
  /**
   * 整首歌词的时间轴 → 原生（每首歌只推一次）。
   *
   * 锁屏播放页的歌词以前靠下面那条 250ms 的 `float_lyric` 推「当前句」，中间压着
   * React 的提交阈值（位置跨过半秒才提交一次）和浏览器对不可见页面的定时器节流——
   * 两段延迟叠起来，金线比歌声慢半句到一句（用户：「歌词跟不上歌曲的进度」）。
   * 现在把整张表交给原生，让它拿 `currentPosition` 自己算，误差只剩一拍（≤250ms）。
   * 一张表几十行、换歌才发一次，代价可以忽略。
   */
  const lastTimeline = useRef('')
  useEffect(() => {
    if (!isAndroid) return
    /* 切歌立刻清空：新歌开头几秒不该还唱着上一首的歌词 */
    lastTimeline.current = ''
    void bridge.invoke('lyric_timeline', { lines: [] }).catch(() => {})
  }, [currentId, isAndroid])
  useEffect(() => {
    if (!isAndroid) return
    const lines = lyrics?.lines ?? []
    if (!lines.length) return
    const head = lines[0]
    const tail = lines[lines.length - 1]
    const sig = `${lines.length}|${head?.time ?? ''}|${head?.text ?? ''}|${tail?.time ?? ''}`
    if (sig === lastTimeline.current) return
    lastTimeline.current = sig
    void bridge.invoke('lyric_timeline', {
      lines: lines.map(l => ({ t: l.time, x: l.text ?? '' })),
    }).catch(() => { /* 推不过去只是退回老路（前端推当前句），不影响播放 */ })
    /* 真机上没有 logcat 可看：留个记号，排查「锁屏歌词不动」时一眼就知道表有没有送到 */
    try { localStorage.setItem('__tl', `${lines.length}|${Date.now()}`) } catch { /* 隐私模式写不进去 */ }
  }, [lyrics, isAndroid])
  useEffect(() => {
    if (!isAndroid) return
    const lines = lyrics?.lines ?? []
    const at = lyricAt(lyrics, snapshot.position)
    const i = at ? lines.findIndex(l => l.time === at.time && l.text === at.text) : -1
    const nx = i >= 0 ? lines[i + 1] : undefined
    /* 句长：用下一句的时间当本句时长；最后一句没有下一句就按 4 秒算 */
    const span = at ? Math.max(0.4, (nx ? nx.time : at.time + 4) - at.time) : 0
    const prog = at ? Math.min(1, Math.max(0, (snapshot.position - at.time) / span)) : 0
    /*
     * 锁屏播放页铺多行要的是「当前句 ±3」的上下文（和 `NowPlaying.AROUND_*` 对齐）。
     * 只推 7 条短字符串、而且只有换句才变（下面按 payload 判重），代价可以忽略；
     * 全量歌词不推——一首歌几千行，250ms 一次会把桥打满。
     * 当前句还没到（前奏）时 i<0，全部填空串，锁屏上就显示歌名。
     */
    const AR = 3
    const around: string[] = []
    for (let k = -AR; k <= AR; k++) {
      const j = i + k
      around.push(i >= 0 && j >= 0 && j < lines.length ? (lines[j].text ?? '') : '')
    }
    const payload = {
      cur: at?.text ?? '',
      next: nx?.text ?? '',
      prog: Math.round(prog * 100) / 100,
      flip: i % 2 === 1,
      /* 暂停时浮窗上的播放键要换成 ▶，所以状态也得跟着推。
         **`snapshot.playing` 必须进依赖**：暂停之后位置不再变化、歌词也不变，
         这个 effect 不重跑就一次都推不出去——浮窗上那颗键一直停在 ⏸
         （用户：「点击暂停，确实会暂停，但是图标不会切换」）。
         原生侧现在也会自己按真实播放状态刷图标（见 FloatingLyrics.setPlaying），
         这条推送是第二道保险。 */
      playing: snapshot.playing,
      title: currentTrack(queueState)?.title ?? '',
      around,
    }
    const key = JSON.stringify(payload)
    if (key === lastFloat.current) return
    lastFloat.current = key
    void bridge.invoke('float_lyric', payload).catch(() => { /* 悬浮窗未授权时原生直接忽略 */ })
  }, [lyrics, snapshot.position, snapshot.playing, currentId])

  useEffect(() => {
    if (!currentId) { setLyrics(null); setLyricsLoading(false); return }
    let alive = true
    const t = currentTrack(queueState)
    if (!t) { setLyrics(null); setLyricsLoading(false); return }
    setLyricsLoading(true)
    // 在线歌词可能长时间不返回：兜一个上限，别让界面永远停在「正在读取歌词…」
    const guard = window.setTimeout(() => { if (alive) setLyricsLoading(false) }, 6000)
    /*
     * 拿不到歌词就**再要两次**，不要一次就判死。
     *
     * 平台歌词接口是第三方，偶发限流 / 长尾超时很常见；以前这里只在
     * `currentId` 变化时跑一次，那一次失败就等于这首歌永久「暂无歌词」——
     * 用户看到的就是「点歌单播放，有时候没有歌词」。现在空结果会隔一会儿
     * 重试一次（重试要绕过空结果记录，见 `loadLyrics` 的 `retry`）。
     *
     * 节奏：第 2 次 +1.2s（还留着 loading，别闪一下「暂无歌词」），
     * 第 3 次 +3.5s（这时先放掉 loading，让用户看到真实状态，
     * 万一这次拿到了再无缝换成歌词）。
     */
    const RETRY_AT = [1200, 3500]
    let tries = 0
    let timer = 0

    const run = (): void => {
      tries += 1
      const retry = tries > 1
      lyricsFor(t, retry)
        .then(d => {
          if (!alive) return
          if (d.lines.length || d.plain.trim()) {
            window.clearTimeout(guard)
            window.clearTimeout(timer)
            setLyrics(d)
            setLyricsLoading(false)
            return
          }
          if (tries <= RETRY_AT.length) {
            // 排下一次的时候已经是最后一轮了：先放掉 loading，让界面回到真实状态
            if (tries === RETRY_AT.length) setLyricsLoading(false)
            timer = window.setTimeout(run, RETRY_AT[tries - 1])
            return
          }
          window.clearTimeout(guard)
          setLyrics(d)
          setLyricsLoading(false)
        })
        .catch(() => {
          // 歌词读取失败也必须收尾，否则界面会一直卡在「正在读取歌词…」
          if (!alive) return
          if (tries <= RETRY_AT.length) {
            timer = window.setTimeout(run, RETRY_AT[tries - 1])
            return
          }
          window.clearTimeout(guard)
          setLyrics(null)
          setLyricsLoading(false)
        })
    }
    run()
    return () => { alive = false; window.clearTimeout(guard); window.clearTimeout(timer) }
  }, [currentId])

  /*
   * 封面预热：换歌就先把封面图**解码**掉。
   *
   * 播放页背景是「同一张封面铺满整屏 + 18px 模糊」，而它平时是 opacity:0
   * 藏着的——浏览器根本不解码。第一次点开播放页那一帧才现解一张 500×500 的
   * jpg（小程序里的缩略图只有 44px，另一份解码结果不能复用），于是「第一次打开
   * 特别卡、之后再开就好了」：卡的是解码，不是样式。这里在换歌时就 decode()，
   * 打开那一刻只剩合成。
   *
   * 顺带把队列里下一首也热一下，切歌时同理。`decode()` 在旧 WebView 上会 reject
   * （跨域/已缓存），忽略即可——最多退回原来的「打开时再解」。
   */
  useEffect(() => {
    if (!currentId) return
    const q = queueState.queue
    const i = q.findIndex(x => x.id === currentId)
    const urls = [q[i]?.cover, q[i + 1]?.cover].filter(Boolean) as string[]
    for (const url of urls) {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      void img.decode?.().catch(() => { /* 解不了就算了，别抛 */ })
    }
  }, [currentId, queueState.queue.length])

  /*
   * 封面补全：老队列快照里的在线曲目 `cover` 是 null（当年落盘没存这个字段，
   * 酷狗歌单详情那边也压根没解析出封面），播到它的时候顺手补一次，
   * 拿到就写回队列项——不补的话播放页/播放条永远是渐变占位 + 音符图标。
   */
  useEffect(() => {
    if (!currentId || !currentId.startsWith('online:')) return
    const t = currentTrack(queueState)
    if (!t || t.cover) return
    let alive = true
    void coverForTrack(t).then(url => {
      if (!alive || !url) return
      setQueueState(q => ({
        ...q,
        queue: q.queue.map(x => (x.id === t.id ? { ...x, cover: url } : x)),
      }))
    }).catch(() => { /* 补不到就保持渐变色，别抛到界面上 */ })
    return () => { alive = false }
  }, [currentId])

  /*
   * 整队补图：光补「当前这首」不够——播放列表里其余那些在线曲目照样是空封面，
   * 用户看到的就是「有的封面出来了、有的没有」。
   *
   * 根因在入库那一步：酷狗歌单详情（`special/song`）对 80/90 年代那批老歌
   * 压根不给 album_img / union_cover，`toLocalTrack` 只能写成 cover:null。
   * 搜索接口反而有图，所以这里用 `coverForTrack`（先查注册表，未命中才搜一次）
   * 按歌名+歌手补回来，拿到就写回队列项——队列快照会把 cover 一起存下来，
   * 下次启动不必再补。
   *
   * 限并发 3：一次二十几个请求打出去，平台会限速，反而更慢。
   */
  const coverKey = useMemo(
    () => queueState.queue.map(t => (t.cover ? '1' : '0')).join(''),
    [queueState.queue],
  )
  useEffect(() => {
    const missing = queueState.queue.filter(t => !t.cover && t.id.startsWith('online:'))
    if (!missing.length) return
    let alive = true
    let cursor = 0
    const worker = async () => {
      while (alive) {
        const i = cursor++
        if (i >= missing.length) return
        const t = missing[i]
        try {
          const url = await coverForTrack(t)
          if (!alive || !url) continue
          setQueueState(q => ({
            ...q,
            queue: q.queue.map(x => (x.id === t.id ? { ...x, cover: url } : x)),
          }))
        } catch { /* 补不到就保持渐变色，别抛到界面上 */ }
      }
    }
    for (let k = 0; k < 3; k++) void worker()
    return () => { alive = false }
    // coverKey 变化（补到一张 / 换队列）时重算；队列数组本身每次都变，不能当依赖
  }, [coverKey])

  const reloadLyrics = useCallback((force = false, q?: { title?: string; artist?: string }) => {
    const t = currentTrack(queueState)
    if (!t) return
    setLyricsLoading(true)
    /*
     * 用户手动指定了歌名 / 歌手（搜索表单里填的）：直接按这个名字去 lrclib 搜。
     * 平台的歌词接口是按歌曲 id 查的，用户改名字就是要绕开平台上那份错的数据。
     */
    const job = q
      ? forceOnlineLyrics(t, q)
      : isOnlineTrack(t)
        ? lyricsFor(t, true)
        : force ? forceOnlineLyrics(t) : loadLyrics(t, { retry: true })
    void job
      .then(d => { setLyrics(d); setLyricsLoading(false) })
      .catch(() => { setLyrics(null); setLyricsLoading(false) })
  }, [queueState])

  /**
   * 上一次落盘的队列签名（id 顺序）。
   * 切歌只改 index、不改队列——不做这个判断的话每切一首都要把整条队列
   * 序列化一遍写进存储，几百首的队列会明显卡一下。
   */
  const queueSig = useRef('')

  useEffect(() => {
    // 恢复完成前不回写：首帧的空队列会把上次的曲单冲掉
    if (!hydrated.current) return
    const sig = queueState.queue.map(t => t.id).join('\u0001')
    if (sig !== queueSig.current) {
      queueSig.current = sig
      /*
       * 队列里的歌钉在注册表里（`online.songs` 只保留最近 300 条）。
       * 不钉的话，隔几天再打开，这些歌的「搜索信息」早被新搜索挤出去了，
       * 恢复播放就会弹「这首歌的搜索信息已过期」——用户看到的是
       * 「每次打开都提示音源问题，但去歌单里点同一首又能播」。
       */
      pinSongs(queueState.queue.map(t => t.id))
      void settings.set(KEYS.queueIds, queueState.queue.map(t => t.id))
      /*
       * 同时存一份完整曲目快照。
       * 只存 id 的话，在线曲目（`online:平台:id`）重启后无处还原，
       * 会被曲库 map 过滤掉——播放列表就空了。本地曲目也一起存，
       * 曲库还没扫完 / 文件被移走时照样能显示歌名歌手。
       */
      void settings.set(KEYS.queueTracks, queueState.queue)
    }
    void settings.set(KEYS.repeat, queueState.repeat)
    const t = currentTrack(queueState)
    if (t) {
      void settings.set(KEYS.lastTrackId, t.id)
      void settings.set(KEYS.lastTrackLabel, `${t.title} · ${t.artist}`)
    }
  }, [queueState])

  /**
   * 播放进度 / 播放态定时落盘（2.5s 一次）。
   * 关窗口只是收进托盘，真正退出走托盘「退出」——那条路径没有 beforeunload，
   * 所以不能只在卸载时保存。
   */
  useEffect(() => {
    const flush = () => {
      const s = snapRef.current
      void settings.set(KEYS.lastPosition, Math.round(s.position))
      void settings.set(KEYS.wasPlaying, s.playing)
    }
    const id = window.setInterval(flush, 2500)
    const onHide = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [])

  /* 播放失败自动跳过 + 提示自动消失 */
  useEffect(() => {
    if (!lastError) return
    /**
     * 在线曲目的跳过**不在这条链上**：它由 startLoad 的 catch 排 3 秒倒计时
     * （见那里注释，用户 2026-11-01 要求「所有音源和平台都试了还是没有就自动下一首」）。
     * 这里只处理本地坏文件：700ms 一跳，连续 3 次停手，避免整队列坏文件疯狂跳歌。
     */
    const onlineNow = curOnlineRef.current
    const skip = onlineNow ? 0 : window.setTimeout(() => {
      if (failCount.current < 3) {
        failCount.current += 1
        const st = skipNext(queueRef.current)
        if (!st) return
        const { event: _e, ...rest } = st
        const t = rest.queue[rest.index]
        if (!t) return
        lastPlayedIndex.current = rest.index
        loadedRef.current = trackKey(t)
        resumePos.current = 0
        commitQueue(rest)
        startLoad(t, rest.index, { why: 'badfile' })
      } else {
        failCount.current = 0
        void bridge.stop()
      }
    }, 700)
    const hide = window.setTimeout(() => setLastError(null), onlineNow ? 12_000 : 5000)
    return () => { if (skip) clearTimeout(skip); clearTimeout(hide) }
  }, [lastError])

  /* 播成功后重置失败计数 */
  useEffect(() => {
    if (snapshot.playing) {
      failCount.current = 0
      pullFail.current = 0
    }
  }, [snapshot.playing])

  /* 卸载时把「3 秒后下一首」的倒计时收掉，别在组件没了之后调 setQueueState */
  useEffect(() => () => window.clearTimeout(skipTimer.current), [])

  /* 「已自动降档 / 已切平台」这种浅提示自己消失，不需要用户点关闭 */
  useEffect(() => {
    if (!onlineNotice) return
    const t = window.setTimeout(() => setOnlineNotice(null), 6_000)
    return () => window.clearTimeout(t)
  }, [onlineNotice])

  const clearError = useCallback(() => setLastError(null), [])

  /**
   * 用户按「停止」：真的把机器停下来。
   *
   * 为什么需要它（2026-11-22 iOS 实测反馈）：一首播不了的歌会让前端自己排两条
   * 自动动作——「6 秒后重试（共两次）」和「3 秒后自动切下一首」。两条都排在
   * `startLoad` 的失败分支里，跟界面上那条红提示**没有联动**：用户点「关闭」
   * 只是把文字收掉，几秒后它又自己开始加载、又失败、又跳下一首，一串歌排着队
   * 转圈，而他没有任何按钮能让它停。这里一次性把这几样都掐掉：
   *   · 定时器（自动跳歌 / 自动重试 / 转圈兜底）；
   *   · 在途的取链结果（`onlineSeq` 递增后，回来那一轮自己作废）；
   *   · 迟到的 `play_url`（`bumpEpoch` + `autoCancel`，原生也强制静音）；
   *   · 原生的播放器（`stop`）。
   * 之后要听歌就正常点一首，`resumeIntent()` 会把暂停锁解开。
   */
  const stopPlayback = useCallback(() => {
    autoCancel.current = true
    bumpEpoch()
    onlineSeq.current += 1
    window.clearTimeout(skipTimer.current)
    skipTimer.current = 0
    window.clearTimeout(resumeGuard.current)
    resumeGuard.current = 0
    failRetry.current = null
    retryTries.current = { key: '', n: 0 }
    playWant.current = null
    /*
     * 「已加载」这一笔要抹掉：原生那边刚被 stop 掉了，播放器已经不在。
     * 留着它，用户再点播放会走「原生手里就是这首 → 一个 resume 就够了」那条捷径，
     * 而 resume 落到一个没有音源的播放器上什么都不会发生 —— 又一次「点了没反应」。
     */
    loadedRef.current = null
    stopLoading()
    snapRef.current = { ...snapRef.current, playing: false }
    setSnapshot(s => (s.playing ? { ...s, playing: false } : s))
    setLastError(null)
    void bridge.trace('stop user')
    void bridge.stop()
  }, [bumpEpoch, stopLoading])

  /* ---------------- 动作 ---------------- */

  const playList = useCallback((tracks: LocalTrack[], index: number) => {
    /* 用户点了「播放全部 / 播这首」= 明确要听：解开暂停锁（见 resumeIntent） */
    resumeIntent()
    const st = playTracks(queueRef.current, tracks, index)
    const { event: _e, ...rest } = st
    const t = rest.queue[rest.index]
    if (!t) return
    lastPlayedIndex.current = rest.index
    loadedRef.current = trackKey(t)
    resumePos.current = 0
    commitQueue(rest)
    startLoad(t, rest.index, { why: 'list' })
  }, [])

  /**
   * 单曲播放：**插到当前播放的下一首**再播，不替换队列。
   *
   * 用户定的规则（2026-11）：
   *   · 歌单里点一首 → 整个歌单替换队列（走 `playList`，不是这里）；
   *   · 搜索里点单曲 → 只把这首歌塞进「正在播的下一首」，原来的队列继续留着；
   *   · 点「下一首」按钮 → 只换歌，队列一动不动。
   *
   * 以前是「不在队列就追加到末尾」：搜一首听一首，队列越拖越长，
   * 而且听完这首要等中间几十首放完才轮得到它后面那首。
   */
  const playOne = useCallback((track: LocalTrack) => {
    /* 用户点名要这首歌：解开暂停锁（见 resumeIntent） */
    resumeIntent()
    const q = queueRef.current
    const at = q.queue.findIndex(t => t.id === track.id)
    // 已经在队列里：跳过去就行，别插入重复的一条
    const nextState: QueueState = at >= 0
      ? { ...q, index: at }
      : (() => {
        const base = enqueue(q, track, 'next')
        return { ...base, index: base.queue.findIndex(t => t.id === track.id) }
      })()
    if (nextState.index < 0) return
    lastPlayedIndex.current = nextState.index
    loadedRef.current = trackKey(track)
    resumePos.current = 0
    commitQueue(nextState)
    startLoad(track, nextState.index, { why: 'one' })
  }, [])

  const next = useCallback(() => {
    /* 用户按了「下一首」= 想听：解开暂停锁 */
    resumeIntent()
    const st = skipNext(queueRef.current)
    if (!st) return
    const { event: _e, ...rest } = st
    const t = rest.queue[rest.index]
    if (!t) return
    lastPlayedIndex.current = rest.index
    loadedRef.current = trackKey(t)
    resumePos.current = 0
    commitQueue(rest)
    startLoad(t, rest.index, { why: 'next' })
  }, [])

  /* 取链失败倒计时要能调到「下一首」：`next` 定义在 startLoad 之后，用 ref 转一道 */
  skipToNext.current = next

  const prev = useCallback(() => {
    resumeIntent()
    const st = skipPrev(queueRef.current)
    if (!st) return
    const { event: _e, ...rest } = st
    const t = rest.queue[rest.index]
    if (!t) return
    lastPlayedIndex.current = rest.index
    loadedRef.current = trackKey(t)
    resumePos.current = 0
    commitQueue(rest)
    startLoad(t, rest.index, { why: 'prev' })
  }, [])

  /**
   * 「按了播放，原生到底响了没有」的回查（见 `resumeGuard` 的说明）。
   *
   * 只在**用户想要它响**的时候挂；900ms 是留给 `resume` 落地 + 一帧 state（250ms）
   * 再加一点余量的时长。到时原生还没报 `playing`，就说明这台播放器救不回来
   * （放完 / 被 stop 过 / 解码器废了），直接走完整加载把它重建一遍 —— 位置不丢。
   */
  const armResumeGuard = (track: LocalTrack, index: number) => {
    window.clearTimeout(resumeGuard.current)
    const at = snapRef.current.position
    let tries = 0
    const check = () => {
      resumeGuard.current = 0
      /* 用户在这段里又按了暂停：那就该停着，别替他放 */
      if (autoCancel.current) return
      const live = lastKnownPlayerState() as { playing?: boolean; want?: boolean; track_path?: string | null; track_url?: string | null } | null
      if (live && live.playing === true) return
      /*
       * 原生说「我要播，只是还没出声」（`want === true`）：那是在准备，
       * 不是死路。再给它一次机会——网络曲目 prepare + 首段缓冲偶尔真的超过 900ms，
       * 这时候推倒重来反而会让进度归零、白等一轮。最多再看两次。
       */
      if (live?.want === true && (live.track_path || live.track_url) && tries < 2) {
        tries += 1
        resumeGuard.current = window.setTimeout(check, 1200)
        return
      }
      void bridge.trace(`resumefail idx=${index} at=${at.toFixed(1)} live=${live ? 1 : 0} want=${live?.want === true ? 1 : 0}`)
      autoCancel.current = false
      lastPlayedIndex.current = index
      loadedRef.current = trackKey(track)
      setSnapshot(s => ({ ...s, playing: true }))
      startLoad(track, index, { startAt: at, autoplay: true, why: 'resume-dead' })
    }
    resumeGuard.current = window.setTimeout(check, 900)
  }

  const togglePlay = useCallback(() => {
    /*
     * 正在为下一首取链：这一刻点播放没有意义，而且会 `resume()` 把**上一首**放出声，
     * 看起来就像「切歌失败了，还是那首」。等加载结束再说。
     */
    /* 读 ref 而不是闭包里的 `snapshot`：同一个渲染帧里连点两下时，
       两次拿到的 `snapshot` 是同一份，第二下会被算成第一下的重复 */
    /*
     * 这一下是用户的动作：先领一个新代号。
     * 之后无论走「暂停」「续播」还是「重新加载」，原生都拿它当分界线——
     * 代号更旧的加载即使还在路上，也只能准备音源、不许出声（见 epochRef）。
     */
    const ep = bumpEpoch()
    const nowPlaying = snapRef.current.playing
    const t0 = currentTrack(queueState)
    const live = lastKnownPlayerState() as {
      index?: number
      track_path?: string | null
      track_url?: string | null
      want?: boolean
      playing?: boolean
    } | null
    const onNative = !!t0 && !!live && live.index === queueState.index
      && (!!live.track_path || !!live.track_url)

    /*
     * **①「还没有声音，但已经在往响的路上」——这一下是「停」。**
     *
     * 覆盖两个窗口，用户报的「点了暂停它反而响起来」正是这两处：
     *   · 正在取链（`loadingRef`，`play_url` 还没下发）；
     *   · `play_url` 已下发、prepare 还在跑——原生此刻 `want === true`，
     *     几秒后 `onPrepared` 就会 `start()`。界面上这会儿显示的是「播放」图标
     *     （因为确实还没出声），用户点它当然是想「别放了」。
     *
     * 以前这两个窗口的点击被当成「我要听」：`bridge.resume()` 把 `wantPlay`
     * 又写回 true，或者干脆继续往下取链（`autoplay: true`），于是几秒后自己响。
     * 现在统一翻成取消：`autoCancel` 让这一轮取链落地时不出声，`pause()` 把
     * 原生那边的待播意图撤掉。真想让它在加载完之后播，再点一下就行（走 ②）。
     */
    if (!nowPlaying && (loadingRef.current || (live?.want === true && live?.playing !== true))) {
      playWant.current = { want: false, until: performance.now() + 800 }
      autoCancel.current = true
      /* 这一下也是「停」：把失败分支排的自动跳歌 / 自动重试一并撤掉，
         否则转圈停了、3 秒后它又自己换一首继续转（见 startLoad 的 canSkip） */
      window.clearTimeout(skipTimer.current)
      skipTimer.current = 0
      failRetry.current = null
      snapRef.current = { ...snapRef.current, playing: false }
      setSnapshot(s => (s.playing ? { ...s, playing: false } : s))
      void bridge.pause(ep, 'toggle:cancel-loading')
      return
    }
    /*
     * **② 原生手上就是这首、而且已经停了 → 一个 resume 就够。**
     *
     * 这是「点了没反应」最要命的那个形状：前端记的 `loadedRef` 和原生实际状态
     * 一旦脱钩（会话恢复、服务被回收重建、上一轮加载走了缓存分支），
     * 点播放就会掉进 `startLoad` → 在线曲目要重新取链 → 网络一慢就十几秒没有声音，
     * 而界面上那个键看着完全正常。原生本来就有这首、位置也对，一个 resume 就够了。
     * `lastKnownPlayerState()` 是同步读最近一帧，不引入 await。
     */
    if (!nowPlaying && onNative) {
      playWant.current = { want: true, until: performance.now() + 800 }
      autoCancel.current = false
      snapRef.current = { ...snapRef.current, playing: true }
      setSnapshot(s => ({ ...s, playing: true }))
      loadedRef.current = trackKey(t0!)
      armResumeGuard(t0!, queueState.index)
      void bridge.resume(ep, 'toggle:resume-native')
      return
    }
    /*
     * 取链中的点击已经在 ① 里统一处理成「取消」了。
     *
     * 原来这里有一条「加载中点一下 = 我想听」的分支（`loadingThis`），本意是修
     * 「冷启动恢复会话的那几秒里点播放没反应」。代价是：用户点了一首没听过的歌，
     * 还在取链时改主意点一下，前端把这一下当成「我要听」，等链回来 `autoplay: true`
     * ——于是声音在用户已经按过暂停之后自己响起来。现在宁可让他多点一下。
     */
    if (!nowPlaying) {
      // 恢复上次曲目后 Rust 侧尚未加载任何音频：从上次进度接着播，否则是「点了没声」
      const t = currentTrack(queueState)
      /*
       * `duration <= 0` 也得重新加载，不能只信 `loadedRef`。
       *
       * `loadedRef` 是**前端自己**记的「我已经让原生加载过了」，但原生那边的播放器
       * 是可能没了的：服务被系统回收、被 `stopSelf` 收掉、或者上一次加载其实失败了
       * （在线歌取链超时）。那些情况下 `resume()` 落到一个没有 MediaPlayer 的服务里
       * 什么都不会发生，界面上就是「点播放没反应」——华为真机上重启应用后第一次
       * 播放必现（`loadedRef` 记着、`mp` 却是 null）。
       * 有源的时候暂停也会有时长，所以这条判断不会误伤正常暂停。
       */
      if (t && (loadedRef.current !== trackKey(t) || snapshot.duration <= 0)) {
        /*
         * 从哪儿接着放：`resumePos` 优先（冷启动恢复算好的），否则用**界面上
         * 正显示的那个位置**。
         *
         * 不能只认 `resumePos`：它会话恢复完就清零了，而 `snapshot.duration <= 0`
         * 这个分支恰恰是「原生那边的播放器没了」（服务被回收 / 上一轮加载失败）——
         * 此时用户界面上还停在 2:30，点播放却从 0 开始，听起来就是
         * 「这首歌停了，又从头放了一遍」。
         */
        const start = resumePos.current || (snapRef.current.position > 0 ? snapRef.current.position : 0)
        resumePos.current = 0
        /* 用户按了播放 = 要出声：解开暂停锁（按过「停止」之后锁是立着的，
           不解的话这一轮会老老实实取链、然后静音，又是「点了没反应」） */
        resumeIntent()
        loadedRef.current = trackKey(t)
        lastPlayedIndex.current = queueState.index
        setSnapshot(s => ({ ...s, playing: true, position: start || s.position }))
        startLoad(t, queueState.index, { startAt: start, autoplay: true, why: 'toggle:reload' })
        return
      }
    }
    /*
     * 乐观翻转 + 意图锁。
     *
     * 只乐观翻转不够：原生那一帧旧状态会把它顶回来（就是这次的闪烁）。锁 800ms
     * 是「等一帧 state 的余量」——tick 是 250ms，命令生效通常 <100ms；超过这个
     * 时间还没追平，说明 pause/resume 是真没生效，那正好该回滚成原生值。
     * `snapRef` 同步写一份：`commitSnapshot` 是拿它做去重比较的，
     * 不写的话下一帧会被判成「变了」，界面又被推回去一次。
     */
    const want = !nowPlaying
    playWant.current = { want, until: performance.now() + 800 }
    snapRef.current = { ...snapRef.current, playing: want }
    setSnapshot(s => ({ ...s, playing: want }))
    if (want) {
      autoCancel.current = false
      /* 同上：这条 resume 也可能是条静默命令，留一次回查 */
      if (t0) armResumeGuard(t0, queueState.index)
      void bridge.resume(ep, 'toggle:play')
    } else {
      /*
       * 暂停要能「拦住还没回来的那一轮取链」。
       *
       * 此刻原生手里可能根本没有播放器（在线歌还在取链），`pause()` 落到空处；
       * 几秒后链回来了，`startLoad` 如果照旧 `autoplay: true` 下发，声音就会在
       * 用户已经按过暂停之后响起来 —— 这就是「暂停了还是会继续播放音乐」。
       * 置上这个标记，那一轮只建播放器不出声（见 autoCancel）。
       */
      autoCancel.current = true
      /* 暂停 = 别再自动换歌：上一首失败排的 3 秒跳歌倒计时在这里撤掉 */
      window.clearTimeout(skipTimer.current)
      skipTimer.current = 0
      failRetry.current = null
      void bridge.pause(ep, 'toggle:pause')
    }
  }, [snapshot.duration, queueState, bumpEpoch, resumeIntent])

  const seek = useCallback((secs: number) => {
    setSnapshot(s => ({ ...s, position: secs, }))
    // 还没加载音频（刚启动恢复出来的状态）：把位置记下来，点播放时从这里开始
    const t = currentTrack(queueState)
    if (t && loadedRef.current !== trackKey(t)) resumePos.current = secs
    // 本地文件 seek 是内存级操作，1.5s 足够；在线要重开 Range 请求，给 4s
    seekGuard.current = { target: secs, until: performance.now() + (curOnlineRef.current ? 4000 : 1500) }
    void bridge.seek(secs)
    /*
     * 拖动进度也要推一次灵动岛：扩展是按「锚点 + 已流逝时间」自己走秒的，
     * 不推的话它会沿旧锚点继续往下跑，越走越偏，直到下次换歌才对上。
     */
    if (t) void liveSyncNow(t, snapRef.current.playing, secs, snapRef.current.duration)
  }, [queueState, liveSyncNow])

  /*
   * 锁屏 / 控制中心拖进度条 → 原生那边已经直接 seek 了播放器，这里把 UI 跟上。
   *
   * 为什么不等 2s 看门狗对账：从锁屏切回 App，看到进度条先弹回原处、两秒后才
   * 跳过去，观感就是「拖动没生效」。事件里带的是原生夹取过的最终位置。
   */
  useEffect(() => {
    if (!isIOS) return
    let un: (() => void) | undefined
    let live = true
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const off = await listen<{ position?: number }>('media://seek', e => {
          const p = e.payload?.position
          if (typeof p === 'number' && Number.isFinite(p) && p >= 0) seek(p)
        })
        if (live) un = off
        else off()
      } catch { /* 浏览器预览 */ }
    })()
    return () => { live = false; un?.() }
  }, [seek])

  const setVolume = useCallback((v: number) => {
    const vol = Math.min(1, Math.max(0, v))
    setSnapshot(s => ({ ...s, volume: vol }))
    void bridge.setVolume(vol)
    if (vol > 0) {
      /*
       * 只有「听得到的音量」才存档。
       * 静音时把 0 写进 KEYS.volume 的话，下次启动就是静音启动，
       * 用户完全无法把「没声音」和「上次点过静音」联系起来——那是 bug 的形状。
       */
      lastVolRef.current = vol
      mutedRef.current = false
      setMuted(false)
      void settings.set(KEYS.volume, vol)
    } else {
      /*
       * 拖到最左 = 静音，开关也要跟上。不然那颗按钮还以为自己在「有声音」档，
       * 点下去先执行一次「静音」（本来就是 0，等于没反应），得点第二次才恢复——
       * 用户看到的就是「点了没效果」。
       */
      mutedRef.current = true
      setMuted(true)
    }
  }, [])

  /* 真实静音：Rust / MediaPlayer 的音量真的变 0，不是只把图标换掉 */
  const toggleMute = useCallback(() => {
    /* 判「此刻有没有声音」而不是只看开关：滑杆拖到 0 时 muted 也是真 */
    const silent = mutedRef.current || snapRef.current.volume <= 0.001
    if (silent) {
      const back = lastVolRef.current > 0.001 ? lastVolRef.current : 0.6
      mutedRef.current = false
      setMuted(false)
      setSnapshot(s => ({ ...s, volume: back }))
      void bridge.setVolume(back)
      void settings.set(KEYS.volume, back)
    } else {
      const cur = snapRef.current.volume
      if (cur > 0.001) lastVolRef.current = cur
      mutedRef.current = true
      setMuted(true)
      setSnapshot(s => ({ ...s, volume: 0 }))
      void bridge.setVolume(0)
    }
  }, [])

  const nudgeVolume = useCallback((d: number) => {
    /* 静音态下以「静音前的音量」为基准，否则从 0 一格一格爬，听着像没反应 */
    const base = mutedRef.current ? lastVolRef.current : snapRef.current.volume
    setVolume(Math.min(1, Math.max(0, base + d)))
  }, [setVolume])

  const cycleMode = useCallback(() => {
    setQueueState(q => {
      const st = cycleRepeat(q)
      const { event: _e, ...rest } = st
      return rest
    })
  }, [])

  const addToQueue = useCallback((track: LocalTrack, position: 'end' | 'next') => {
    setQueueState(q => enqueue(q, track, position))
  }, [])

  const addManyToQueue = useCallback((tracks: LocalTrack[], position: 'end' | 'next') => {
    if (!tracks.length) return
    setQueueState(q => {
      // 「下一首播放」多选逐个插到当前曲后面会反序：倒着插才是列表顺序
      const list = position === 'next' ? [...tracks].reverse() : tracks
      return list.reduce((acc, t) => enqueue(acc, t, position), q)
    })
  }, [])

  const reorder = useCallback((from: number, to: number) => {
    setQueueState(q => reorderQueue(q, from, to))
  }, [])

  const remove = useCallback((id: string) => {
    setQueueState(q => {
      const next = removeFromQueue(q, id)
      /*
       * 队列被清空：无条件收摊。
       *
       * 以前这一步套在「删的正好是当前曲目」那个判断里，删最后几首时索引
       * 可能已经不是它了，于是 bridge.stop() 一次都没发出去——原生的服务、
       * 前台通知、媒体会话全留在那儿，MIUI 照样画那块空白的媒体卡。
       */
      if (next.queue.length === 0) {
        void bridge.stop()
        lastPlayedIndex.current = -1
        return next
      }
      if (q.index >= 0 && q.queue[q.index]?.id === id) {
        if (next.index !== q.index) {
          lastPlayedIndex.current = next.index
          startLoad(next.queue[next.index], next.index, { why: 'remove' })
        } else {
          lastPlayedIndex.current = -1
        }
      }
      return next
    })
  }, [])

  const removeTracks = useCallback(async (ids: string[]) => {
    if (!ids.length) return
    const set = new Set(ids)
    // 单首失败不影响其它：用户点的是"批量移除"，不该被一个坏记录卡住
    await Promise.all(ids.map(id => bridge.removeTrack(id).catch(() => {})))
    setLibrary(prev => prev.filter(t => !set.has(t.id)))
    setQueueState(q => {
      const beforeId = q.queue[q.index]?.id ?? null
      let next = q
      for (const id of set) next = removeFromQueue(next, id)

      if (!next.queue.length) {
        void bridge.stop()
        loadedRef.current = null
        lastPlayedIndex.current = -1
        return next
      }

      const afterId = next.queue[next.index]?.id ?? null
      if (afterId !== beforeId) {
        // 当前曲被删了（或被顺延到下一首）：让 index 与已播记录对齐，
        // 否则下面的 [queueState] effect 会把它当成"换歌"自动开播
        lastPlayedIndex.current = next.index
        if (beforeId && set.has(beforeId)) {
          const t = next.queue[next.index]
          loadedRef.current = null
          if (snapRef.current.playing) {
            loadedRef.current = trackKey(t)
            startLoad(t, next.index, { why: 'removeBatch' })
          } else {
            setSnapshot(s => ({ ...s, position: 0, duration: t.duration }))
          }
        }
      }
      return next
    })
  }, [])

  const clear = useCallback(() => {
    loadedRef.current = null
    resumePos.current = 0
    void bridge.stop()
    lastPlayedIndex.current = -1
    setQueueState(q => clearQueue(q))
    setSnapshot(s => ({ ...s, playing: false, position: 0, duration: 0 }))
  }, [])

  /** 重载当前在线曲目：keepProgress 时从当前位置续上（换音质用） */
  const reloadOnline = useCallback((keepProgress: boolean, opts?: { bypassCache?: boolean; fallbackQuality?: string; keepSound?: boolean }) => {
    const t = currentTrack(queueState)
    if (!t || !isOnlineTrack(t)) return
    /*
     * 续播位置给成**函数**：换音质那轮（keepSound）取链期间旧档位一直在响，
     * 位置要到下发那一刻才取（见 startLoad 的 startAtNow）——否则换过去
     * 会往回跳取链耗掉的那几秒。
     */
    startLoad(t, queueState.index, {
      startAt: keepProgress ? () => snapRef.current.position : 0,
      autoplay: true,
      ...opts,
    })
  }, [queueState, startLoad])

  /**
   * 换源：把当前音源拉黑后重取。
   * 这是常驻能力而不是异常分支——第三方音源随时会挂，用户需要一键绕过。
   */
  const switchSource = useCallback(() => {
    const t = currentTrack(queueState)
    if (!t || !isOnlineTrack(t)) return
    const now = lastSourceId.current
    if (now) {
      const key = trackKey(t)
      if (excluded.current.key !== key) excluded.current = { key, ids: [] }
      if (!excluded.current.ids.includes(now)) excluded.current.ids.push(now)
    }
    reloadOnline(false)
  }, [queueState, reloadOnline])

  /** 换音质：保持进度，不清空已排除的音源（那是另一个维度的问题） */
  /**
   * 原地重试当前曲目：**不**把上次的音源拉黑。
   *
   * 和 `switchSource` 的区别就是这一条：取链超时（尤其断网重连后的头几秒）不是
   * 音源的问题，把人家拉黑等于自己把可用音源一个个删掉。所以这条只重新取一次。
   */
  const retryCurrent = useCallback(() => {
    failRetry.current = null
    retryTries.current = { key: '', n: 0 }
    setLastError(null)
    reloadOnline(false)
  }, [reloadOnline])

  /**
   * 换音质：保持进度重取。
   *
   * **必须绕过本地缓存**（`bypassCache`）：缓存里的那份是旧档位出链落盘的，
   * 命中缓存的话这一轮直接把同一份文件又播了一遍——用户看到的就是
   * 「切了音质没反应，选中态也没变」（2026-11-20）。绕过缓存重新取链，
   * 成功后才把旧档位的缓存换成新的（见 success 分支）；离线取不到链时
   * 旧缓存还在，不影响播放。
   */
  const changeQuality = useCallback((q: string) => {
    const t = currentTrack(queueState)
    /* 点的就是正在播的这一档：什么都不做。三处入口（胶囊菜单 / 更多面板 / 设置页）
       都不过滤当前档，误点当前档以前会触发一整轮「暂停 → 重新取链 → 续播」——
       用户看到的就是「每点一下音乐断一下，好像不能正常播了」（2026-11-21）。
       真想强制重取有「换源 / 重试」入口，不走这里。 */
    if (!t || !isOnlineTrack(t) || onlineQualityRef.current === q) return
    const prev = onlineQualityRef.current
    /*
     * **反馈要立刻出现**：以前要等 setPreferredQuality 落盘 → reloadOnline →
     * startLoad 里才把 busy 点亮，手机上存储写入慢半拍，这几百毫秒里界面纹丝不动，
     * 用户不知道有没有点中（2026-11-21「没有立马出现加载动画」）。
     * 这里同步先把「取链中」点亮——startLoad 随后会原样再设一遍，失败路径也会收掉。
     */
    setOnlineBusy(true)
    setOnlineQuality(null)
    setOnlineNotice(null)
    /* 换音质是「对**这首歌**要一个档位」：先清掉跨平台兜底记录，回到最初找到
     * 它的音源去取。兜底平台往往只有标准档，不清的话高音质永远回不来——
     * 下一次取链还会从兜底平台出发（2026-11-21）。 */
    forgetSubstitute(t.id)
    /* 切音质 = 明确要听：解开暂停锁，取到链就从原位置接着放。
       用户暂停中切音质以前不会自动播（autoCancel 锁着），被当成「切换了不播放」（2026-11-21）。 */
    resumeIntent()
    /* 带上原档位：新档位取不到链时回退原音质继续播（见 startLoad 的失败分支）。
       keepSound：取链期间旧档位继续响，新档位好了无缝换——「切音质等好几秒
       没声音」的体感主要就来自那段静音（2026-11-21）。 */
    void setPreferredQuality(q).then(() => reloadOnline(true, { bypassCache: true, fallbackQuality: prev ?? undefined, keepSound: true }))
  }, [queueState, reloadOnline, resumeIntent])

  const refreshLibrary = useCallback(async () => {
    const tracks = cleanLibrary(await bridge.getTracks())
    setLibrary(tracks)
    setLibraryVersion(v => v + 1)
  }, [])

  const scan = useCallback(async (scope: ScanScope, dirs: string[] = []) => {
    setScanning(true)
    setScanProgress({ found: 0, parsed: 0 })
    try {
      const res = await bridge.scanMusic(scope, dirs, false)
      await refreshLibrary()
      const now = Date.now()
      setLastScanAt(now)
      setScanScope(scope)
      setLastRoots(res.roots ?? [])
      setLastSkipped(res.skipped ?? 0)
      setLastTruncated(Boolean(res.truncated))
      void settings.set(KEYS.lastScanAt, now)
      void settings.set(KEYS.scanScope, scope)
      void settings.set(KEYS.scanRoots, res.roots ?? [])
      void settings.set(KEYS.scanVersion, SCAN_VERSION)
      if (scope === 'custom' && dirs.length) {
        void settings.set(KEYS.scanDirs, dirs)
      }
    } catch (e) {
      console.error('扫描失败', e)
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }, [refreshLibrary])

  const rescan = useCallback(async () => {
    const scope = scanScope === 'custom' ? 'custom' : scanScope
    const dirs = scope === 'custom' ? (await settings.get<string[]>(KEYS.scanDirs)) ?? [] : []
    await scan(scope as ScanScope, dirs)
  }, [scan, scanScope])

  const removeTrack = useCallback(async (id: string) => {
    await bridge.removeTrack(id)
    setLibrary(prev => prev.filter(t => t.id !== id))
    setQueueState(q => removeFromQueue(q, id))
  }, [])

  /* ---------------- 定时关闭 / 音量保护（安卓原生执行，前端只发命令） ---------------- */

  const setSleep = useCallback((min: number | 'track' | null) => {
    if (!isAndroid) return
    /*
     * 乐观更新：先按用户选的值画上，等原生下一帧把真值带回来（`sleep` 字段）。
     * 不乐观的话，点了「30 分钟」面板要等 250ms 才变成「30 分钟」，
     * 用户会以为没点上、再点一次。
     */
    if (min === null) setSleepState({ on: false, track: false, remain: 0 })
    else if (min === 'track') setSleepState({ on: true, track: true, remain: 0 })
    else setSleepState({ on: true, track: false, remain: Math.max(0, Math.round(min * 60)) })
    void bridge.invoke('sleep_set', min === null ? { minutes: 0 } : min === 'track' ? { track: true } : { minutes: min })
      .catch(() => { /* 老版本没有这条命令：下一个 tick 会把状态改回去 */ })
  }, [])

  const setAudioGuard = useCallback((on: boolean) => {
    setAudioGuardState(on)
    void settings.set(KEYS.audioGuard, on)
    if (isAndroid) {
      void bridge.invoke<boolean>('audio_guard', { on }).catch(() => { /* 同上 */ })
    }
  }, [])

  /* 挂载时把音量保护的真值推给原生：原生自己也存了一份（见 Bridge.init），
     这里再推一次是为了「设置文件比 prefs 新」的所有情况（换机恢复、手改文件） */
  useEffect(() => {
    if (!isAndroid) return
    void settings.get<boolean>(KEYS.audioGuard).then(v => {
      if (v === null || v === undefined) return
      setAudioGuardState(!!v)
      void bridge.invoke('audio_guard', { on: !!v }).catch(() => {})
    })
  }, [])

  const value = useMemo<PlayerCtx>(() => ({
    queueState, current: currentTrack(queueState), snapshot, scanning, scanProgress,
    online: isOnlineTrack(currentTrack(queueState)),
    loading,
    onlineBusy,
    onlineSource,
    onlineQuality,
    /* 真实可选的档位：平台说「这首有」∩ 音源说「我能取」（见 usableQualities） */
    onlineQualities: usableQualities(currentTrack(queueState)),
    onlineVia, onlineActual, onlineNotice,
    clearNotice: () => setOnlineNotice(null),
    switchSource,
    retryCurrent,
    changeQuality,
    library, libraryVersion, lastScanAt, lastRoots, lastSkipped, lastTruncated, scanScope,
    playList, playOne, next, prev, togglePlay, seek, setVolume, cycleMode,
    muted, toggleMute, nudgeVolume,
    setScrubbing: (b: boolean) => { scrubRef.current = b },
    addToQueue, addManyToQueue, reorder, remove, removeTracks, clear, refreshLibrary, scan, rescan, removeTrack,
    lastError, clearError, stopPlayback, lyrics, lyricsLoading, reloadLyrics,
    sleep, setSleep, audioGuard, setAudioGuard,
  }), [queueState, snapshot, scanning, scanProgress, library, libraryVersion, lastScanAt, lastRoots,
    lastSkipped, lastTruncated, scanScope, loading,
    onlineBusy, onlineSource, onlineQuality, onlineVia, onlineActual, onlineNotice,
    switchSource, changeQuality, retryCurrent,
    playList, playOne, next, prev, togglePlay, seek, setVolume, cycleMode,
    muted, toggleMute, nudgeVolume,
    addToQueue, addManyToQueue, reorder, remove,
    removeTracks, clear,
    refreshLibrary, scan, rescan, removeTrack, lastError, clearError, stopPlayback, lyrics, lyricsLoading, reloadLyrics,
    sleep, setSleep, audioGuard, setAudioGuard])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
