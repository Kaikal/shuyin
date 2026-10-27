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
import { forceOnlineLyrics, loadLyrics } from './lyrics'
import { KEYS, SCAN_VERSION, settings } from './settings'
import { NoPlayableSourceError } from '@shuyin/lx-provider'
import {
  effectiveSong, isOnlineTrack, onlineLyric, qualityDropMatters, resolvePlayUrl, setPreferredQuality, songOf,
  sourceManager, usableQualities,
} from './online'
import { cachedAudio, warmCache } from './audioCache'
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
  const startLoading = useCallback(() => {
    loadingRef.current = true
    window.clearTimeout(loadingTimer.current)
    // 慢 220ms 才亮：本地文件几十毫秒就出声，闪一下转圈反而像卡了
    loadingTimer.current = window.setTimeout(() => setLoading(true), 220)
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
   * 统一加载入口。本地曲目直接交给 Rust 读文件；在线曲目先取链再流式播放。
   * 「懒恢复」状态在真正加载后即结束，之后以 Rust 事件为准。
   */
  const startLoad = useCallback((
    track: LocalTrack, index: number, opts?: { startAt?: number; autoplay?: boolean },
  ) => {
    lazyRestored.current = false
    loadExpect.current = track.duration || 0
    startLoading()
    if (!isOnlineTrack(track)) {
      void bridge.playFile(track.path, index, opts)
      return
    }

    const key = trackKey(track)
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
    void cachedAudio(track.id, effectiveSong(track.id)?.interval || track.duration || 0).then(hit => {
      if (seq !== onlineSeq.current) return
      if (hit) {
        setOnlineBusy(false)
        setOnlineSource('本地缓存')
        loadedRef.current = trackKey(track)
        void bridge.playFile(hit, index, opts)
        return
      }
      resolvePlayUrl(track, { exclude: excluded.current.ids })
        .then(r => {
          if (seq !== onlineSeq.current) return
          setOnlineBusy(false)
          lastSourceId.current = r.sourceId
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
          setLastError(`「${name}」${detail}`)
        })
    })
  }, [startLoading, stopLoading])

  /* 启动：恢复音量/队列 + 拉取曲库 + 订阅事件 */
  useEffect(() => {
    let unsubs: Array<() => void> = []
    ;(async () => {
      const vol = await settings.get<number>(KEYS.volume)
      if (vol != null) {
        setSnapshot(s => ({ ...s, volume: vol }))
        void bridge.setVolume(vol)
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

      // 恢复队列（顺序即真相）+ 循环模式；同时恢复「上次在听哪首、播到哪」
      const qids = await settings.get<string[]>(KEYS.queueIds)
      const savedRepeat = await settings.get<RepeatMode>(KEYS.repeat)
      if (qids?.length) {
        const all = existing.length ? existing : await bridge.getTracks()
        const map = new Map(all.map(t => [t.id, t]))
        const tracks = qids.map(id => map.get(id)).filter((t): t is LocalTrack => !!t)
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
            const saved = await settings.get<number>(KEYS.lastPosition)
            let pos = typeof saved === 'number' && Number.isFinite(saved) && saved > 0 ? saved : 0
            // 上次是听着看着就退出的：进度停在结尾附近没有意义，下次从头开始
            if (dur > 0 && pos > dur - 3) pos = 0
            const wasPlaying = !!(await settings.get<boolean>(KEYS.wasPlaying))
            const autoResume = !!(await settings.get<boolean>(KEYS.autoResume))
            const autoplay = wasPlaying && autoResume
            restored.current = true
            resumePos.current = pos
            setSnapshot(s => ({ ...s, position: pos, duration: dur, playing: autoplay }))
            // 只有时长可信（>5s）的曲目才在启动时预加载：
            // 0 时长多半是残缺/损坏文件，开机去解码会拉出一串报错。
            if (dur > 5) {
              loadedRef.current = trackKey(t)
              resumePos.current = 0
              startLoad(t, idx, { startAt: pos, autoplay })
            } else {
              lazyRestored.current = true
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
          setSnapshot(s => ({ ...s, playing: p.playing, position: pos, duration: p.duration, volume: p.volume, buffered: p.buffered ?? 0 }))
        } else {
          setSnapshot(s => ({ ...s, playing: p.playing, duration: p.duration, volume: p.volume, buffered: p.buffered ?? 0 }))
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
   */
  const lyricsFor = useCallback(async (t: LocalTrack): Promise<LyricsDoc> => {
    if (!isOnlineTrack(t)) return loadLyrics(t)
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
   */
  useEffect(() => {
    if (!bridge.isTauri) return
    const t = currentTrack(queueState)
    void bridge.invoke('smtc_update', {
      title: t?.title ?? '',
      artist: t?.artist ?? '',
      album: t?.album ?? '',
      playing: snapshot.playing,
    }).catch(() => { /* 系统媒体会话不可用不影响播放 */ })
  }, [currentId, snapshot.playing])

  useEffect(() => {
    if (!currentId) { setLyrics(null); setLyricsLoading(false); return }
    let alive = true
    const t = currentTrack(queueState)
    if (!t) { setLyrics(null); setLyricsLoading(false); return }
    setLyricsLoading(true)
    // 在线歌词可能长时间不返回：兜一个上限，别让界面永远停在「正在读取歌词…」
    const guard = window.setTimeout(() => { if (alive) setLyricsLoading(false) }, 6000)
    lyricsFor(t)
      .then(d => {
        if (!alive) return
        window.clearTimeout(guard)
        setLyrics(d)
        setLyricsLoading(false)
      })
      .catch(() => {
        // 歌词读取失败也必须收尾，否则界面会一直卡在「正在读取歌词…」
        if (!alive) return
        window.clearTimeout(guard)
        setLyrics(null)
        setLyricsLoading(false)
      })
    return () => { alive = false; window.clearTimeout(guard) }
  }, [currentId])

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
        ? lyricsFor(t)
        : force ? forceOnlineLyrics(t) : loadLyrics(t)
    void job
      .then(d => { setLyrics(d); setLyricsLoading(false) })
      .catch(() => { setLyrics(null); setLyricsLoading(false) })
  }, [queueState])

  useEffect(() => {
    // 恢复完成前不回写：首帧的空队列会把上次的曲单冲掉
    if (!hydrated.current) return
    void settings.set(KEYS.queueIds, queueState.queue.map(t => t.id))
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
     * 在线曲目取不到链时**不要自动跳下一首**：
     * 第三方音源挂掉是常态，跳歌会让用户眼看着队列自己往下跑，还以为播放器坏了。
     * 正确做法是停在这首、把「换源」按钮摆出来。本地坏文件才继续自动跳。
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
    if (snapshot.playing) failCount.current = 0
  }, [snapshot.playing])

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
   * 单曲播放：**不替换队列**。
   * 在队列里就跳过去，不在就追加到末尾再播。用户在搜索结果里点一首歌，
   * 期望的是「放这首」，而不是「把现在的播放列表换成几十首搜索结果」。
   */
  const playOne = useCallback((track: LocalTrack) => {
    setQueueState(q => {
      const at = q.queue.findIndex(t => t.id === track.id)
      const base = at >= 0 ? q : enqueue(q, track, 'end')
      const index = at >= 0 ? at : base.queue.length - 1
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
    if (!snapshot.playing) {
      // 恢复上次曲目后 Rust 侧尚未加载任何音频：从上次进度接着播，否则是「点了没声」
      const t = currentTrack(queueState)
      if (t && loadedRef.current !== trackKey(t)) {
        const start = resumePos.current
        resumePos.current = 0
        loadedRef.current = trackKey(t)
        lastPlayedIndex.current = queueState.index
        setSnapshot(s => ({ ...s, playing: true, position: start || s.position }))
        startLoad(t, queueState.index, { startAt: start, autoplay: true })
        return
      }
    }
    setSnapshot(s => ({ ...s, playing: !s.playing }))
    if (snapshot.playing) void bridge.pause()
    else void bridge.resume()
  }, [snapshot.playing, queueState])

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
    setSnapshot(s => ({ ...s, volume: v }))
    void bridge.setVolume(v)
    void settings.set(KEYS.volume, v)
  }, [])

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
      if (q.index >= 0 && q.queue[q.index]?.id === id) {
        if (next.queue.length === 0) {
          void bridge.stop()
          lastPlayedIndex.current = -1
        } else if (next.index !== q.index) {
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
    setScrubbing: (b: boolean) => { scrubRef.current = b },
    addToQueue, addManyToQueue, reorder, remove, removeTracks, clear, refreshLibrary, scan, rescan, removeTrack,
    lastError, clearError, lyrics, lyricsLoading, reloadLyrics,
  }), [queueState, snapshot, scanning, scanProgress, library, libraryVersion, lastScanAt, lastRoots,
    lastSkipped, lastTruncated, scanScope, loading,
    onlineBusy, onlineSource, onlineQuality, onlineVia, onlineActual, onlineNotice,
    switchSource, changeQuality,
    playList, playOne, next, prev, togglePlay, seek, setVolume, cycleMode, addToQueue, addManyToQueue, reorder, remove,
    removeTracks, clear,
    refreshLibrary, scan, rescan, removeTrack, lastError, clearError, lyrics, lyricsLoading, reloadLyrics])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
