/**
 * 疏音 · 共享核心模型
 * 本文件不依赖任何平台 API；平台能力通过 LocalMusicProvider / SettingsStore 接口注入。
 */

/** 音频容器格式（本阶段支持的本地格式） */
export type AudioFormat =
  | 'mp3' | 'aac' | 'm4a' | 'flac' | 'wav' | 'ogg' | 'opus'

/** 本地音轨（扫描归一化后的模型，两端共享） */
export interface LocalTrack {
  /** 稳定主键：优先使用文件路径的哈希，避免数据库自增 id 与增量刷新错位 */
  id: string
  /** 绝对路径（桌面 file:// 或移动 content:// / file://） */
  path: string
  title: string
  artist: string
  album: string
  /** 秒 */
  duration: number
  /** 音频格式标签 */
  format: AudioFormat
  /** kbps；探测不到为 null */
  bitrate: number | null
  /** 采样率 Hz；探测不到为 null */
  sampleRate: number | null
  /** 封面：桌面为封面缓存文件的绝对路径，移动端为媒体库 URI；无封面为 null */
  cover: string | null
  /** 文件修改时间（毫秒），增量扫描据此跳过未变更文件 */
  mtime: number
  /** 文件大小（字节） */
  size: number
  /** 发行年份（标签可得） */
  year?: number | null
  /** 专辑内音轨号 */
  trackNo?: number | null
  /** 流派 */
  genre?: string | null
}

/* ------------------------------------------------------------------ */
/* 歌词                                                                */
/* ------------------------------------------------------------------ */

export type LyricSource = 'lrc' | 'embedded' | 'online' | 'none'

export interface LyricLine {
  /** 起始秒 */
  time: number
  text: string
}

export interface LyricsDoc {
  source: LyricSource
  lines: LyricLine[]
  /** 原始文本（纯文本歌词时 lines 可能为空） */
  plain: string
}

/** 解析 LRC：支持一行多时间标签 [mm:ss.xx][mm:ss.xx] 与 [mm:ss:xx] 变体 */
export function parseLrc(text: string): LyricLine[] {
  if (!text) return []
  const out: LyricLine[] = []
  const tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    tagRe.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    let lastEnd = 0
    while ((m = tagRe.exec(line)) !== null) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const fracRaw = m[3] ?? '0'
      const frac = Number(fracRaw.length === 3 ? fracRaw : fracRaw.padEnd(2, '0')) / (fracRaw.length === 3 ? 1000 : 100)
      stamps.push(min * 60 + sec + frac)
      lastEnd = tagRe.lastIndex
    }
    if (!stamps.length) continue
    const content = line.slice(lastEnd).trim()
    if (!content) continue
    for (const t of stamps) out.push({ time: t, text: content })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** 二分查找当前时间对应的歌词行下标（无匹配返回 -1） */
export function activeLyricIndex(lines: LyricLine[], t: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= t + 0.05) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 纯文本歌词（无时间轴）按行拆分 */
export function plainLyricLines(text: string): LyricLine[] {
  return text
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map((text, i) => ({ time: -1 - i * 0.001, text }))
}

export const SUPPORTED_EXTENSIONS = [
  'mp3', 'aac', 'm4a', 'flac', 'wav', 'ogg', 'opus'
] as const

export function formatFromPath(path: string): AudioFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  if (!m) return null
  const ext = m[1].toLowerCase() as AudioFormat
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext) ? ext : null
}

export interface ScanProgress {
  /** 已发现（遍历中）的文件数 */
  found: number
  /** 已完成元数据解析的歌曲数 */
  parsed: number
  /** 当前正在扫描的目录（用于 UI 展示） */
  currentDir?: string
}

export interface ScanResult {
  /** 本次（全量或增量）扫描入库的歌曲总数 */
  total: number
  /** 新增数 */
  added: number
  /** 更新数（标签或 mtime 变化） */
  updated: number
  /** 移除数（上次存在、本次缺失） */
  removed: number
  /** 扫描耗时（毫秒） */
  durationMs: number
  /** 增量扫描时为 true */
  incremental: boolean
  /** 本次扫描覆盖的根目录（快速 / 全盘 / 指定目录） */
  roots?: string[]
  /** 被判为无效而跳过的文件数（非音频 / 过短 / 录音） */
  skipped?: number
  /** 是否因保护上限提前结束（此时不做缺失清理） */
  truncated?: boolean
}

/** 平台注入的本地音乐能力（桌面 = Tauri Rust 命令；移动 = 原生模块桥接） */
export interface LocalMusicProvider {
  requestPermission(): Promise<boolean>
  scan(options?: { directories?: string[]; incremental?: boolean }): Promise<ScanResult>
  /** 进度事件（可选）：平台可经事件总线推流，前端订阅 */
  onScanProgress?(cb: (p: ScanProgress) => void): () => void
}

/** 平台注入的键值存储 */
export interface SettingsStore {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
}

/* ------------------------------------------------------------------ */
/* 播放队列状态机                                                       */
/* ------------------------------------------------------------------ */

export type RepeatMode = 'sequence' | 'one' | 'shuffle'

export type PlayerEvent =
  | { type: 'started'; queue: LocalTrack[]; index: number }
  | { type: 'track-changed'; queue: LocalTrack[]; index: number }
  | { type: 'play-state'; playing: boolean }
  | { type: 'queue-changed'; queue: LocalTrack[]; index: number }
  | { type: 'shuffle-on' | 'shuffle-off'; queue: LocalTrack[]; index: number }

/**
 * PlaybackQueue —— 播放队列纯函数状态机。
 * 「顺序即真相」：队列数组 + 当前指针，所有变换返回新状态，不原地修改。
 * 播放器引擎只消费 index 与当前曲目，UI 只订阅事件。
 */
export interface QueueState {
  queue: LocalTrack[]
  index: number
  repeat: RepeatMode
  /** shuffle 开启时维护的播放顺序（存 id，跨重排稳定） */
  order: string[]
}

export const initialQueueState: QueueState = {
  queue: [],
  index: -1,
  repeat: 'sequence',
  order: [],
}

export function currentTrack(s: QueueState): LocalTrack | null {
  return s.queue[s.index] ?? null
}

/** 生成随机播放顺序（Fisher-Yates，当前曲保持在首位） */
export function shuffleOrder(queue: LocalTrack[], currentId: string | null): string[] {
  const ids = queue.map(t => t.id)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  if (currentId) {
    const k = ids.indexOf(currentId)
    if (k > 0) {
      ids.splice(k, 1)
      ids.unshift(currentId)
    }
  }
  return ids
}

/** playTracks：从某曲开始播放一个列表（点击列表行为） */
export function playTracks(
  s: QueueState,
  tracks: LocalTrack[],
  startIndex: number
): QueueState & { event: PlayerEvent } {
  const queue = tracks.slice()
  const order = s.repeat === 'shuffle'
    ? shuffleOrder(queue, queue[startIndex]?.id ?? null)
    : queue.map(t => t.id)
  return {
    queue, index: startIndex, repeat: s.repeat, order,
    event: { type: 'started', queue, index: startIndex },
  }
}

/** next/previous：根据循环模式推进指针；返回 null 表示队列播完（停止） */
export function nextIndex(s: QueueState, auto: boolean): number | null {
  const n = s.queue.length
  if (n === 0) return null
  if (s.repeat === 'shuffle') {
    if (n === 1) return auto ? 0 : 0
    const cur = s.queue[s.index]?.id ?? null
    const pos = cur ? s.order.indexOf(cur) : -1
    if (pos === -1) return null
    if (pos === n - 1) return auto ? indexOfId(s, s.order[0]) : null
    return indexOfId(s, s.order[pos + 1])
  }
  if (s.index >= n - 1) {
    if (s.repeat === 'sequence' && auto) return null // 顺序播完 → 停
    return 0 // 列表循环 / 手动下一首回到开头
  }
  return s.index + 1
}

export function prevIndex(s: QueueState): number | null {
  const n = s.queue.length
  if (n === 0) return null
  if (s.repeat === 'shuffle') {
    const cur = s.queue[s.index]?.id ?? null
    const pos = cur ? s.order.indexOf(cur) : -1
    if (pos <= 0) return indexOfId(s, s.order[n - 1])
    return indexOfId(s, s.order[pos - 1])
  }
  if (s.index <= 0) return n - 1
  return s.index - 1
}

function indexOfId(s: QueueState, id: string): number {
  return s.queue.findIndex(t => t.id === id)
}

/** 用户手动切歌（下一首按钮）：即使顺序模式到尾也回绕 */
export function skipNext(s: QueueState): QueueState & { event: PlayerEvent } | null {
  const i = nextIndex(s, false)
  if (i == null || i < 0) return null
  return { ...s, index: i, event: { type: 'track-changed', queue: s.queue, index: i } }
}

export function skipPrev(s: QueueState): QueueState & { event: PlayerEvent } | null {
  const i = prevIndex(s)
  if (i == null || i < 0) return null
  return { ...s, index: i, event: { type: 'track-changed', queue: s.queue, index: i } }
}

/** 自动推进（曲终）：单曲循环由播放器层处理，这里只处理跨曲 */
export function advance(s: QueueState): QueueState & { event: PlayerEvent } | null {
  const i = nextIndex(s, true)
  if (i == null) return null
  return { ...s, index: i, event: { type: 'track-changed', queue: s.queue, index: i } }
}

/** 切换循环模式；进入 shuffle 时重建随机顺序 */
export function cycleRepeat(s: QueueState): QueueState & { event: PlayerEvent } {
  const next: RepeatMode =
    s.repeat === 'sequence' ? 'one' : s.repeat === 'one' ? 'shuffle' : 'sequence'
  if (next === 'shuffle') {
    const order = shuffleOrder(s.queue, currentTrack(s)?.id ?? null)
    return { ...s, repeat: next, order, event: { type: 'shuffle-on', queue: s.queue, index: s.index } }
  }
  return {
    ...s, repeat: next,
    event: s.repeat === 'shuffle'
      ? { type: 'shuffle-off', queue: s.queue, index: s.index }
      : { type: 'queue-changed', queue: s.queue, index: s.index },
  }
}

/** 就地重排（拖拽排序 / Alt+↑↓）：返回新数组，不依赖下标持久化 */
export function reorderQueue(s: QueueState, from: number, to: number): QueueState {
  if (from === to || from < 0 || to < 0 || from >= s.queue.length || to >= s.queue.length) return s
  const next = s.queue.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  const cur = currentTrack(s)
  // 队列重排后随机顺序同步按 id 重映射（顺序即真相，不依赖下标）
  const order = s.order.length
    ? next.map(t => t.id).sort((a, b) => {
        const oa = s.order.indexOf(a); const ob = s.order.indexOf(b)
        return (oa === -1 ? Infinity : oa) - (ob === -1 ? Infinity : ob)
      })
    : []
  return {
    ...s,
    queue: next,
    index: cur ? next.findIndex(t => t.id === cur.id) : s.index,
    order,
  }
}

/** 移除队列中的一首；若移除的是当前曲，指针后移（不中断已播放音频，由平台层决定） */
export function removeFromQueue(s: QueueState, trackId: string): QueueState {
  const idx = s.queue.findIndex(t => t.id === trackId)
  if (idx === -1) return s
  const next = s.queue.filter(t => t.id !== trackId)
  let index = s.index
  if (idx < s.index) index--
  else if (idx === s.index) index = Math.min(idx, next.length - 1)
  return {
    queue: next,
    index,
    repeat: s.repeat,
    order: s.order.filter(id => id !== trackId),
  }
}

export function clearQueue(s: QueueState): QueueState {
  return { ...initialQueueState, repeat: s.repeat }
}

/** 曲目加入队列尾部/下一首播放 */
export function enqueue(s: QueueState, track: LocalTrack, position: 'end' | 'next'): QueueState {
  const exists = s.queue.some(t => t.id === track.id)
  const queue = exists ? s.queue : (
    position === 'end'
      ? [...s.queue, track]
      : [...s.queue.slice(0, s.index + 1), track, ...s.queue.slice(s.index + 1)]
  )
  const order = exists || s.repeat !== 'shuffle' ? queue.map(t => t.id) : [...s.order, track.id]
  return { ...s, queue, order: order.length === queue.length ? order : queue.map(t => t.id) }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m + ':' + (s < 10 ? '0' : '') + s
}

/** 用文件路径生成稳定 id（djb2 变体，跨平台一致，无需 crypto） */
export function trackIdFromPath(path: string): string {
  let h = 5381
  for (let i = 0; i < path.length; i++) {
    h = ((h << 5) + h + path.charCodeAt(i)) | 0
  }
  return 't' + (h >>> 0).toString(36) + '_' + path.length
}
