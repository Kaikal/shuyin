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
import { forceOnlineLyrics, loadLyrics, lyricAt } from './lyrics'
import { KEYS, SCAN_VERSION, settings } from './settings'
import { NoPlayableSourceError, type PlatformSource } from '@shuyin/lx-provider'
import { favRecOf, useFavs } from './favTracks'
import {
  coverForTrack, effectiveSong, ensureRegistry, isOnlineTrack, onlineLyric, pinSongs,
  qualityDropMatters, resolvePlayUrl, setPreferredQuality, songOf, sourceManager, trackOfId,
  usableQualities,
} from './online'
import { cachedAudio, hasCachedAudio, warmCache } from './audioCache'
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
  /** 换音质并从当前进度继续 */
  changeQuality(q: string): void
}

/**
 * 「已加载曲目」的标识：本地用路径，在线用 id。
 * 在线曲目的 path 是空串，拿 path 比较会导致每帧都判定「需要重新加载」。
 */
const trackKey = (t: LocalTrack): string => (isOnlineTrack(t) ? t.id : t.path)

const Ctx = createContext<PlayerCtx | null>(null)

export function usePlayer(): PlayerCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('usePlayer must be used within PlayerProvider')
  return c
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [queueState, setQueueState] = useState<QueueState>(initialQueueState)
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>({ playing: false, position: 0, duration: 0, volume: 0.8, buffered: 0 })
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
      loadingRef.current = false
      setLoading(false)
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
   * 刚下发的 seek 目标。
   *
   * Rust 的 `player://state` 是 250ms 一帧的「解码器当前位置」，但 `Cmd::Seek` 要在音频线程
   * 里排到队才有结果——这一次事件往往还带着**跳转前**的位置。直接回写，界面就会
   * 「先弹回原处、再跳到你点的地方」。所以下发 seek 后开一个短窗口，窗口内凡是
   * 与目标差得远的位置一律丢弃（等到位置已经追上、或者窗口超时）。
   */
  const seekGuard = useRef<{ target: number; until: number } | null>(null)
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
    opts?: { startAt?: number; autoplay?: boolean; restore?: boolean },
  ) => {
    lazyRestored.current = false
    loadExpect.current = track.duration || 0
    /* 手动换歌 / 上一首 / 下一首都从这里过：把上一次失败排的「3 秒后下一首」撤掉，
       否则用户刚点的新歌会被旧倒计时顶掉 */
    window.clearTimeout(skipTimer.current)
    const key = trackKey(track)
    const online = isOnlineTrack(track)
    /* 试听重试的记忆跟着曲目走：换一首就清零，别把上一首跳过的平台带过来 */
    if (trialSkip.current.key !== key) trialSkip.current = { key, platform: null }
    curLoad.current = { track, index }
    startLoading(online)
    if (!online) {
      /* 本地曲目交给原生直接读文件，这一下就算「已加载」 */
      loadedRef.current = key
      void bridge.playFile(track.path, index, opts)
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
     */
    if (!opts?.restore) {
      setSnapshot(s => (s.playing ? { ...s, playing: false } : s))
      void bridge.pause().catch(() => { /* 还没加载过 / 命令不存在：都无所谓 */ })
    }

    if (excluded.current.key !== key) excluded.current = { key, ids: [] }

    const seq = ++onlineSeq.current
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
     */
    void cachedAudio(track.id, effectiveSong(track.id)?.interval || track.duration || 0, effectiveSong(track.id)?.name || track.title || '').then(hit => {
      if (seq !== onlineSeq.current) return
      if (hit) {
        setOnlineBusy(false)
        setOnlineSource('本地缓存')
        pullFail.current = 0
        setLastError(null)
        loadedRef.current = trackKey(track)
        void bridge.playFile(hit, index, opts)
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
          setOnlineBusy(false)
          pullFail.current = 0
          /* 上一首的失败提示不能赖在新歌上：取链成功就撤掉 */
          setLastError(null)
          lastSourceId.current = r.sourceId
          lastPlatform.current = r.platform
          setOnlineSource(r.sourceName)
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
            bits.push(`该平台暂无可用资源，已自动切到${r.platformName}`)
          }
          if (qualityDropMatters(r.requestedQuality, r.quality)) {
            bits.push(`音质自动降到${r.qualityLabel}`)
          }
          if (bits.length) setOnlineNotice(bits.join(' · '))
          loadedRef.current = trackKey(track)
          void bridge.playUrl(r.url, index, {
            // 换平台后时长可能和搜索结果的元数据不同，进度条要用真实那条的时长
            durationHint: r.duration || track.duration,
            startAt: opts?.startAt ?? 0,
            autoplay: opts?.autoplay ?? true,
          })
          // 出链成功就顺手在后台存一份，下次秒开
          warmCache(track.id, r.url)
        })
        .catch(e => {
          if (seq !== onlineSeq.current) return
          setOnlineBusy(false)
          stopLoading()
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
           * 冷启动的预加载不排「3 秒后自动切下一首」。
           *
           * 那一刻音源脚本可能刚热起来、网卡刚连上（见 SourceManager.waitLoaded），
           * 一次失败就把整条队列往下刷 5 首，用户看到的是「一打开就自己乱跳」。
           * 启动失败就静静停在当前这首，点播放会重来一遍，那次是真有准备的。
           */
          const canSkip = !opts?.restore && queueLenRef.current > 1 && pullFail.current <= 5 && skipToNext.current != null
          setLastError(canSkip ? `「${name}」${detail}　3 秒后自动切到下一首` : `「${name}」${detail}`)
          if (canSkip) {
            window.clearTimeout(skipTimer.current)
            skipTimer.current = window.setTimeout(() => {
              skipTimer.current = 0
              skipToNext.current?.()
            }, 3000)
          }
        })
    })
  }, [startLoading, stopLoading])

  /* 启动：恢复音量/队列 + 拉取曲库 + 订阅事件 */
  useEffect(() => {
    let unsubs: Array<() => void> = []
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
      const existing = await bridge.getTracks().catch(() => [] as LocalTrack[])
      const savedVer = await settings.get<string>(KEYS.scanVersion)
      const needFullRescan = savedVer !== SCAN_VERSION
      if (existing.length) {
        setLibrary(existing)
        setLibraryVersion(v => v + 1)
        // 扫描规则升级过：跑一次全量，把旧规则收进来的录音/假音频清掉
        void bridge.scanMusic(scope ?? 'fast', [], !needFullRescan).then(async () => {
          const tracks = await bridge.getTracks()
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
          const tracks = await bridge.getTracks()
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
          .filter((t): t is LocalTrack => !!t)
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
              setSnapshot(s => ({ ...s, position: pos, duration: dur, playing: autoplay }))
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
                startLoad(t, idx, { startAt: pos, autoplay, restore: true })
              } else {
                lazyRestored.current = true
              }
            }
          }
        }
      }

      const st = await bridge.playerState()
      // 已从存档恢复：Rust 那边的加载命令还在通道里排队，此刻读到的 0:00 不能回写 UI
      if (!restored.current) {
        setSnapshot(s => ({ ...s, playing: st.playing, position: st.position, duration: st.duration }))
      }
      hydrated.current = true

      unsubs.push(bridge.onPlayerEvent(({ payload }) => {
        const p = payload as PlayerSnapshot & { ended?: boolean; error?: string | null; seeking?: boolean }
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
              setQueueState(s => (s.index === auto ? s : { ...s, index: auto }))
            }
          }
        }
        if (curOnlineRef.current && p.duration > 5) {
          const expect = loadExpect.current
          const here = curLoad.current
          const sameTrack = here && (p as { index?: number }).index === here.index
          if (here && sameTrack && expect >= 90 && p.duration < expect * 0.6 && expect - p.duration >= 40) {
            const k = trackKey(here.track)
            if (trialRetry.current.key !== k) trialRetry.current = { key: k, n: 0 }
            if (trialRetry.current.n < 2) {
              trialRetry.current.n += 1
              trialSkip.current = { key: k, platform: lastPlatform.current }
              startLoad(here.track, here.index, { startAt: 0 })
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
          commitSnapshot({ ...snapRef.current, playing: settlePlaying(p.playing), position: pos, duration: p.duration, volume: p.volume, buffered: p.buffered ?? 0 })
        } else {
          commitSnapshot({ ...snapRef.current, playing: settlePlaying(p.playing), duration: p.duration, volume: p.volume, buffered: p.buffered ?? 0 })
        }
        // 播放失败：提示 + 自动跳下一首（连续失败 3 次后停止，避免疯狂跳歌）
        if (p.error) setLastError(p.error)
        if (p.ended) {
          setQueueState(q => {
            const n = advance(q)
            if (!n) {
              void bridge.stop()
              return q
            }
            lastPlayedIndex.current = n.index
            loadedRef.current = trackKey(n.queue[n.index])
            startLoad(n.queue[n.index], n.index)
            const { event: _e, ...rest } = n
            return rest
          })
        }
      }))

      unsubs.push(bridge.onScanProgress(p => setScanProgress(p)))
    })()
    return () => unsubs.forEach(u => u())
  }, [])

  /* 队列变化 → 播放当前曲 */
  useEffect(() => {
    queueLenRef.current = queueState.queue.length
    const t = currentTrack(queueState)
    if (t && queueState.index !== lastPlayedIndex.current) {
      lastPlayedIndex.current = queueState.index
      startLoad(t, queueState.index)
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
    const text = await onlineLyric(t)
    const lines = parseLrc(text)
    if (lines.length) return { source: 'online', lines, plain: text }
    if (text.trim()) return { source: 'online', lines: plainLyricLines(text), plain: text }
    const fallback = await forceOnlineLyrics(t).catch(() => null)
    return fallback ?? { source: 'none', lines: [], plain: '' }
  }, [])

  /* 歌词：跟随当前曲目加载（本地优先，miss 后在线），全应用共享 */
  const currentId = currentTrack(queueState)?.id ?? null
  curOnlineRef.current = isOnlineTrack(currentTrack(queueState))

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

  /* ---------------- 下一首预告（安卓：息屏时自动接歌靠它） ---------------- */
  /** 往前预告几首：够撑过一段不碰手机的时间，又不至于把平台打到限流 */
  const PREFETCH_N = 3
  /** 每次重算都换号：旧轮次在下一个 await 边界自己退出（同 resolvePlayUrl 的 cancel） */
  const prefetchSeq = useRef(0)
  const prefetchTimer = useRef(0)
  const queueRef = useRef(queueState)
  queueRef.current = queueState

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
  const buildPrefetch = useCallback(async (base: QueueState) => {
    if (!isAndroid) return
    const seq = ++prefetchSeq.current
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
    const items: Record<string, unknown>[] = []
    for (const it of plan) {
      if (seq !== prefetchSeq.current) return
      const t = it.track
      const head = {
        index: it.index,
        title: t.title,
        artist: t.artist,
        album: t.album,
        cover: t.cover ?? effectiveSong(t.id)?.img ?? '',
        fav: favs.has(t.id),
        duration: t.duration || 0,
      }
      if (!isOnlineTrack(t)) { items.push({ ...head, path: t.path }); continue }
      try {
        const r = await resolvePlayUrl(t, { cancel: () => seq !== prefetchSeq.current })
        items.push({ ...head, url: r.url, duration: r.duration || head.duration })
      } catch {
        /* 单条取不到就少撑一首：不写进表，原生放到那儿会走老路（交还前端） */
      }
    }
    if (seq !== prefetchSeq.current) return
    void bridge.invoke('next_prefetch', { items }).catch(() => { /* 桌面端没有这条命令 */ })
  }, [favs])

  /*
   * 队列一变就重算预告（当前曲 / 顺序 / 循环模式都会影响「下一首是谁」）。
   * 延迟 1.5s：切歌那一下先把当前这首的链取好、出声，别和它抢平台请求。
   */
  useEffect(() => {
    if (!isAndroid) return
    window.clearTimeout(prefetchTimer.current)
    prefetchTimer.current = window.setTimeout(() => { void buildPrefetch(queueRef.current) }, 1500)
    return () => window.clearTimeout(prefetchTimer.current)
  }, [queueState.index, queueState.queue, queueState.repeat, queueState.order, buildPrefetch])

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
     * 暂停时一次补 8 首、播放中只补 1 首。
     *
     * 用户第二次提这件事：「暂停时还是会停止加载」。原来只补 3 首——那是按
     * 「暂停一下马上就走」估的，实际用户会停很久，听两首就发现又没了。
     * 8 首 ≈ 40MB ≈ 半小时，够撑过任何一次「放下手机」。
     * 下载是**串行 await** 的（warmCache 现在返回 Promise），恢复播放时
     * 不会有一堆下载跟当前这首抢带宽。
     */
    const ahead = snapshot.playing ? 1 : 8
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
      return
    }
    void bridge.invoke('smtc_update', {
      title: t.title ?? '',
      artist: t.artist ?? '',
      album: t.album ?? '',
      playing: snapshot.playing,
      cover: t.cover ?? '',
      fav: curFavOn,
    }).catch(() => { /* 系统媒体会话不可用不影响播放 */ })
  }, [currentId, snapshot.playing, curFavOn,
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
        setQueueState(q => {
          const st = skipNext(q)
          if (!st) return q
          lastPlayedIndex.current = st.index
          loadedRef.current = trackKey(st.queue[st.index])
          resumePos.current = 0
          startLoad(st.queue[st.index], st.index)
          const { event: _e, ...rest } = st
          return rest
        })
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

  /* ---------------- 动作 ---------------- */

  const playList = useCallback((tracks: LocalTrack[], index: number) => {
    setQueueState(q => {
      const st = playTracks(q, tracks, index)
      lastPlayedIndex.current = st.index
      loadedRef.current = trackKey(st.queue[st.index])
      resumePos.current = 0
      startLoad(st.queue[st.index], st.index)
      const { event: _e, ...rest } = st
      return rest
    })
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
    setQueueState(q => {
      const at = q.queue.findIndex(t => t.id === track.id)
      // 已经在队列里：跳过去就行，别插入重复的一条
      if (at >= 0) {
        lastPlayedIndex.current = at
        loadedRef.current = trackKey(track)
        resumePos.current = 0
        startLoad(track, at)
        return { ...q, index: at }
      }
      const base = enqueue(q, track, 'next')
      const index = base.queue.findIndex(t => t.id === track.id)
      lastPlayedIndex.current = index
      loadedRef.current = trackKey(track)
      resumePos.current = 0
      startLoad(track, index)
      return { ...base, index }
    })
  }, [])

  const next = useCallback(() => {
    setQueueState(q => {
      const st = skipNext(q)
      if (!st) return q
      lastPlayedIndex.current = st.index
      loadedRef.current = trackKey(st.queue[st.index])
      resumePos.current = 0
      startLoad(st.queue[st.index], st.index)
      const { event: _e, ...rest } = st
      return rest
    })
  }, [])

  /* 取链失败倒计时要能调到「下一首」：`next` 定义在 startLoad 之后，用 ref 转一道 */
  skipToNext.current = next

  const prev = useCallback(() => {
    setQueueState(q => {
      const st = skipPrev(q)
      if (!st) return q
      lastPlayedIndex.current = st.index
      loadedRef.current = trackKey(st.queue[st.index])
      resumePos.current = 0
      startLoad(st.queue[st.index], st.index)
      const { event: _e, ...rest } = st
      return rest
    })
  }, [])

  const togglePlay = useCallback(() => {
    /*
     * 正在为下一首取链：这一刻点播放没有意义，而且会 `resume()` 把**上一首**放出声，
     * 看起来就像「切歌失败了，还是那首」。等加载结束再说。
     */
    if (loadingRef.current) return
    /* 读 ref 而不是闭包里的 `snapshot`：同一个渲染帧里连点两下时，
       两次拿到的 `snapshot` 是同一份，第二下会被算成第一下的重复 */
    const nowPlaying = snapRef.current.playing
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
        const start = resumePos.current
        resumePos.current = 0
        loadedRef.current = trackKey(t)
        lastPlayedIndex.current = queueState.index
        setSnapshot(s => ({ ...s, playing: true, position: start || s.position }))
        startLoad(t, queueState.index, { startAt: start, autoplay: true })
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
    if (want) void bridge.resume()
    else void bridge.pause()
  }, [snapshot.duration, queueState])

  const seek = useCallback((secs: number) => {
    setSnapshot(s => ({ ...s, position: secs, }))
    // 还没加载音频（刚启动恢复出来的状态）：把位置记下来，点播放时从这里开始
    const t = currentTrack(queueState)
    if (t && loadedRef.current !== trackKey(t)) resumePos.current = secs
    // 本地文件 seek 是内存级操作，1.5s 足够；在线要重开 Range 请求，给 4s
    seekGuard.current = { target: secs, until: performance.now() + (curOnlineRef.current ? 4000 : 1500) }
    void bridge.seek(secs)
  }, [queueState])

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
          startLoad(next.queue[next.index], next.index)
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
            startLoad(t, next.index)
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
  const reloadOnline = useCallback((keepProgress: boolean) => {
    const t = currentTrack(queueState)
    if (!t || !isOnlineTrack(t)) return
    const at = keepProgress ? snapRef.current.position : 0
    startLoad(t, queueState.index, { startAt: at, autoplay: true })
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
  const changeQuality = useCallback((q: string) => {
    void setPreferredQuality(q).then(() => reloadOnline(true))
  }, [reloadOnline])

  const refreshLibrary = useCallback(async () => {
    const tracks = await bridge.getTracks()
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
    changeQuality,
    library, libraryVersion, lastScanAt, lastRoots, lastSkipped, lastTruncated, scanScope,
    playList, playOne, next, prev, togglePlay, seek, setVolume, cycleMode,
    muted, toggleMute, nudgeVolume,
    setScrubbing: (b: boolean) => { scrubRef.current = b },
    addToQueue, addManyToQueue, reorder, remove, removeTracks, clear, refreshLibrary, scan, rescan, removeTrack,
    lastError, clearError, lyrics, lyricsLoading, reloadLyrics,
  }), [queueState, snapshot, scanning, scanProgress, library, libraryVersion, lastScanAt, lastRoots,
    lastSkipped, lastTruncated, scanScope, loading,
    onlineBusy, onlineSource, onlineQuality, onlineVia, onlineActual, onlineNotice,
    switchSource, changeQuality,
    playList, playOne, next, prev, togglePlay, seek, setVolume, cycleMode,
    muted, toggleMute, nudgeVolume,
    addToQueue, addManyToQueue, reorder, remove,
    removeTracks, clear,
    refreshLibrary, scan, rescan, removeTrack, lastError, clearError, lyrics, lyricsLoading, reloadLyrics])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
