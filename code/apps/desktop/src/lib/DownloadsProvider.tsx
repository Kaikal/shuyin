/**
 * 下载中心：队列 + 进度 + 目录，全应用共用一份。
 *
 * 为什么从播放页里搬出来：
 *   · 以前下载状态是 `ImmersivePlayer` 的**组件内 state**，一份全局唯一的 `dl.busy`。
 *     它不记得自己在给哪首歌下载——切歌之后那颗图标照旧转圈，看起来像「上一首的下载
 *     还在给这一首转」。状态必须挂在曲目上，而不是挂在按钮上。
 *   · 关掉播放页 = 组件卸载 = 进度彻底消失，用户只能守着那颗图标看。
 *     现在任务活在 Provider 里，退出播放页、切页面都不影响。
 *
 * 设计取舍：
 *   · **并发 2**：再多会和在线播放抢同一批连接，边听边下的时候反而两处都卡。
 *   · **进度靠轮询**：Rust 侧写一张 `dest → (done,total)` 的表，这里 600ms 扫一次。
 *     比事件简单，也不会因为前端某个组件没挂上而丢进度。
 *   · **只存已完成/失败的记录**：`downloading` 重启后没有任何意义（进程都换了），
 *     读回来时统一标成「已中断」，让用户可以点重试。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { LocalTrack } from '@shuyin/core'
import { bridge } from './bridge'
import { settings } from './settings'
import { resolvePlayUrl, forgetResolved } from './online'

export type DlStatus = 'queued' | 'resolving' | 'downloading' | 'done' | 'error'

export interface DownloadTask {
  /** `audio:<trackId>:<quality>` / `lyric:<trackId>`：同一首歌的每个音质各是一条独立任务 */
  id: string
  trackId: string
  kind: 'audio' | 'lyric'
  title: string
  artist: string
  album: string
  cover: string | null
  source: string
  quality?: string
  qualityLabel?: string
  /** 实际出链的平台名（跨平台兜底时可能和用户选的平台不同），下载列表里标出来 */
  via?: string
  status: DlStatus
  /** 已写字节 */
  done: number
  /** 总字节；未知为 0 */
  total: number
  /** 目标路径（进度轮询的 key） */
  path: string
  error?: string
  /** 入队时间戳，用于排序 */
  at: number
  /** 内存里的曲目引用：重试时直接复用，不落盘 */
  track?: LocalTrack
  /** 歌词任务要写的文本（也只在内存里） */
  lrc?: string
}

/** 存盘用的形状：把 `track` 和临时状态剔掉 */
type StoredTask = Omit<DownloadTask, 'track'>

const STORE_KEY = 'downloads.tasks'
const DIR_KEY = 'downloads.dir'
const MAX_CONCURRENT = 2
const KEEP = 200

/** 文件名里不能出现的字符，统一换成下划线（Windows 下写盘会直接失败） */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名'
}

/** 从直链猜扩展名：音源给的地址多数带后缀，猜不到就按 mp3 存 */
function extOf(url: string): string {
  const m = /\.(mp3|m4a|aac|flac|wav|ogg)(?:[?#]|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase()}` : '.mp3'
}

/** `LyricsDoc.lines` → LRC 文本 */
export function toLrcText(lines: Array<{ time: number; text: string }>): string {
  const stamp = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec - m * 60
    return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`
  }
  return lines.filter(l => l.time >= 0).map(l => `${stamp(l.time)}${l.text}`).join('\r\n')
}

export const fileNameOf = (t: { artist: string; title: string }) =>
  safeFileName(`${t.artist || '未知歌手'} - ${t.title}`)

/** 文件名里的音质后缀（` [320k]` / ` [无损]`）：多音质下载时靠它区分，空就不加 */
const qualityTag = (r: { quality?: string; qualityLabel?: string }) => {
  const q = r.qualityLabel || r.quality
  return q ? ` [${safeFileName(q)}]` : ''
}

const mb = (n: number) => (n / 1048576).toFixed(1)

/**
 * 失败原因 → 一句人话。
 *
 * 用户不需要知道「音源」「直链」「HTTP 403」是什么，他只需要知道
 * 「再点一次有没有用」「是不是我的问题」。所以这里只分几类可行动的结论，
 * 原始报错留在控制台（`console.warn`），排查时看那个。
 */
export function dlFailText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  if (import.meta.env.DEV) console.warn('[download]', raw)
  if (/会员|版权|VIP/i.test(raw)) return '这首歌要会员才能下'
  if (/下载目录|目录/.test(raw)) return '找不到下载目录，去设置里选一个'
  if (/空间|no space|磁盘已满/i.test(raw)) return '磁盘空间不够了，换个目录试试'
  if (/创建文件失败|写入失败|拒绝访问|permission/i.test(raw)) return '写不进这个文件夹，去设置换个下载目录'
  if (/中断|超时|timeout|timed out|不可达/i.test(raw)) return '网络断了，重试一次'
  if (/过期|重新搜/i.test(raw)) return '这首歌的信息过期了，重新搜一次'
  if (/播放地址|直链|地址不合法|取不到|失效/i.test(raw)) return '暂时取不到下载地址，稍后重试'
  return '下载失败，重试一次'
}

/** 任务状态 → 一句人话（播放页弹层、下载页共用） */
/**
 * 下载任务的一行说明。
 *
 * `compact` 给「下载页」用：那一行下面还会单独显示文件大小，说明里就不用再写一遍。
 * 不压缩的话（「已下载 10.3 MB · 高品质 · 酷狗」）在 1080 宽的窗口里放不下，
 * 只能折行或省略——折行会把「酷狗」拆成上下两个字，省略又会把平台裁掉。
 */
export function dlLabel(t: DownloadTask, compact = false): string {
  switch (t.status) {
    case 'queued':
      return '排队中…'
    case 'resolving':
      return t.kind === 'lyric' ? '正在写入歌词…' : '正在取下载地址…'
    case 'downloading':
      return t.total > 0 ? `下载中 ${mb(t.done)} / ${mb(t.total)} MB` : `下载中 ${mb(t.done)} MB`
    case 'done':
      return t.kind === 'lyric'
        ? '歌词已保存（.lrc）'
        : `已下载${compact ? '' : ` ${mb(t.done)} MB`}${t.qualityLabel ? ` · ${t.qualityLabel}` : ''}${t.via ? ` · ${t.via}` : ''}`
    case 'error':
      return t.error || '下载失败'
  }
}

interface Ctx {
  tasks: DownloadTask[]
  /** 当前实际生效的下载目录（空 = 还没取到） */
  dir: string
  /** 用户自选的目录（空 = 用默认的数据目录）——设置页据此显示「恢复默认」是否可用 */
  customDir: string
  /** 换目录；传空串恢复默认 */
  setDir(path: string): Promise<void>
  /** 下载一首在线曲目（已在队列/已完成就不会重复入队） */
  download(track: LocalTrack, quality?: string): void
  /** 导出当前曲目的 .lrc */
  downloadLyric(track: LocalTrack, lrcText: string): void
  retry(id: string): void
  remove(id: string): void
  clearFinished(): void
  /** 这首歌是否正在下载（按钮转圈用） */
  busyOf(trackId: string): boolean
  /** 这首歌的音频任务（有就返回，下载页/播放页展示用） */
  taskOf(trackId: string): DownloadTask | undefined
}

const DownloadsCtx = createContext<Ctx | null>(null)

export function useDownloads(): Ctx {
  const v = useContext(DownloadsCtx)
  if (!v) throw new Error('useDownloads 必须在 DownloadsProvider 内使用')
  return v
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [dir, setDirState] = useState('')
  const [customDir, setCustomDir] = useState('')

  /** 权威数据：state 只是它的渲染镜像（队列推进依赖同步读，不能等 setState） */
  const map = useRef<Map<string, DownloadTask>>(new Map())
  const running = useRef(0)
  const dirRef = useRef('')
  const hydrated = useRef(false)

  const sync = useCallback(() => {
    const list = [...map.current.values()].sort((a, b) => b.at - a.at)
    setTasks(list)
  }, [])

  const patch = useCallback((id: string, p: Partial<DownloadTask>) => {
    const cur = map.current.get(id)
    if (!cur) return
    map.current.set(id, { ...cur, ...p })
    sync()
  }, [sync])

  /* ---------------- 目录 ---------------- */

  const resolveDir = useCallback(async (): Promise<string> => {
    if (dirRef.current) return dirRef.current
    const d = await bridge.downloadsDir().catch(() => '')
    dirRef.current = d
    setDirState(d)
    return d
  }, [])

  const setDir = useCallback(async (path: string) => {
    const p = path.trim()
    if (!p) {
      dirRef.current = ''
      setCustomDir('')
      await settings.set(DIR_KEY, '')
      await resolveDir()
      return
    }
    // 传过去让 Rust 建目录：用户新选的空文件夹也能直接落盘
    const real = await bridge.downloadsDir(p).catch(() => p)
    dirRef.current = real
    setDirState(real)
    setCustomDir(p)
    await settings.set(DIR_KEY, p)
  }, [resolveDir])

  useEffect(() => {
    let alive = true
    void (async () => {
      const saved = await settings.get<string>(DIR_KEY).catch(() => null)
      if (saved && alive) {
        dirRef.current = saved
        setDirState(saved)
        setCustomDir(saved)
      }
      await resolveDir()
      // 读回历史任务：download 中的一律转成「已中断」，否则界面永远转圈
      const list = await settings.get<StoredTask[]>(STORE_KEY).catch(() => null)
      if (list && Array.isArray(list)) {
        for (const t of list) {
          if (!t?.id) continue
          const status: DlStatus = t.status === 'done' ? 'done' : t.status === 'error' ? 'error' : 'error'
          map.current.set(t.id, {
            ...t,
            status,
            error: status === 'error' && !t.error ? '下载被中断（应用已退出）' : t.error,
          })
        }
        sync()
      }
      hydrated.current = true
    })()
    return () => { alive = false }
  }, [resolveDir, sync])

  /* 落盘：只写非内存字段，且只留最近的 KEEP 条；未 hydrate 前不写（会把历史覆盖成空） */
  useEffect(() => {
    if (!hydrated.current) return
    const timer = setTimeout(() => {
      const list: StoredTask[] = tasks.slice(0, KEEP).map(({ track: _t, ...rest }) => rest)
      void settings.set(STORE_KEY, list).catch(() => {})
    }, 600)
    return () => clearTimeout(timer)
  }, [tasks])

  /* ---------------- 进度轮询 ---------------- */

  useEffect(() => {
    const live = tasks.filter(t => t.status === 'downloading' && t.path)
    if (!live.length) return
    const timer = setInterval(() => {
      for (const t of live) {
        void bridge.downloadProgress(t.path).then(pg => {
          // total 可能是 0（服务端不给长度）：这种也要更新已下载字节，
          // 否则界面一直停在「0.0 MB」，看着像没动
          if (!pg || pg[0] <= 0) return
          // 只在还是 downloading 时改：已经完成/失败的别被回写覆盖
          const cur = map.current.get(t.id)
          if (cur?.status === 'downloading') {
            patch(t.id, pg[1] > 0 ? { done: pg[0], total: pg[1] } : { done: pg[0] })
          }
        }).catch(() => {})
      }
    }, 600)
    return () => clearInterval(timer)
  }, [tasks, patch])

  /* ---------------- 队列 ---------------- */

  const exec = useCallback(async (id: string) => {
    const task = map.current.get(id)
    if (!task) return
    try {
      const dirNow = await resolveDir()
      if (!dirNow) throw new Error('拿不到下载目录，去「设置 → 下载」选一个')

      if (task.kind === 'lyric') {
        const dest = `${dirNow}\\${fileNameOf(task)}.lrc`
        await bridge.saveLyricsFile(dest, task.lrc ?? '')
        patch(id, { status: 'done', path: dest, done: 1, total: 1, qualityLabel: 'LRC 歌词' })
        return
      }

      if (!task.track) {
        /*
         * 重启后 `track` 不在内存里（只存了 id 和标题）。
         * 以前这里直接报「曲目信息已失效」，等于把队列里没下完的歌全废掉。
         * 曲目信息其实够用：在线曲目只需要 id（v0.3.5 起搜索信息也落盘了），
         * 其余字段只是给文件名和展示用。拼一个最小可用的 LocalTrack 让重试继续。
         */
        patch(id, { status: 'resolving', error: undefined })
      }
      const track: LocalTrack = task.track ?? {
        id: task.trackId,
        path: '',
        title: task.title,
        artist: task.artist,
        album: task.album,
        duration: 0,
        format: 'mp3',
        bitrate: null,
        sampleRate: null,
        cover: task.cover,
        mtime: 0,
        size: 0,
      }
      patch(id, { status: 'resolving', error: undefined, done: 0, total: 0 })
      const r = await resolvePlayUrl(track, { quality: task.quality })
      /* 文件名带上音质：同一首歌下多个音质时靠它区分，不会互相覆盖。
         用**实际取到的**档位（可能比用户点的低一档），跟下载页显示的一致。 */
      const dest = `${dirNow}\\${fileNameOf(task)}${qualityTag(r)}${extOf(r.url)}`
      patch(id, {
        status: 'downloading',
        path: dest,
        quality: r.quality,
        qualityLabel: r.qualityLabel,
        via: r.platformName,
        total: 0,
        done: 0,
      })
      const n = await bridge.downloadTrack(r.url, dest)
      // 完成时进度表可能已经被清掉，用返回值兜住总字节数
      patch(id, { status: 'done', path: dest, done: n, total: n })
    } catch (e) {
      patch(id, {
        status: 'error',
        error: dlFailText(e),
        // 保留已下的字节数，方便用户判断是「一点没下」还是「下到一半断了」
        done: map.current.get(id)?.done ?? 0,
      })
    }
  }, [patch, resolveDir])

  /** 从队列里挑一个排 next 的跑起来；跑完再挑。用 ref 递归，避免 useCallback 自引用 */
  const pumpRef = useRef<() => void>(() => {})
  pumpRef.current = () => {
    while (running.current < MAX_CONCURRENT) {
      const next = [...map.current.values()]
        .filter(t => t.status === 'queued')
        .sort((a, b) => a.at - b.at)[0]
      if (!next) break
      running.current++
      // 先置状态，避免同一帧被 pump 再挑一次
      map.current.set(next.id, { ...next, status: 'resolving' })
      sync()
      void exec(next.id).finally(() => {
        running.current--
        pumpRef.current()
      })
    }
  }

  const enqueue = useCallback((t: DownloadTask) => {
    map.current.set(t.id, t)
    sync()
    pumpRef.current()
  }, [sync])

  const download = useCallback((track: LocalTrack, quality?: string) => {
    /*
     * 同一首歌的**每一个音质**是一条独立任务。
     * 以前按曲目建 id（`audio:${track.id}`）：一个音质下完，别的档位就被
     * 「已下载」挡住下不了，用户想同时存 320k 和无损两个文件直接被堵死
     * （弹层里还会把所有档位都打上勾，看着像都下过）。
     */
    const id = `audio:${track.id}:${quality || 'auto'}`
    const cur = map.current.get(id)
    // 已完成 / 正在跑的不重复入队（重复点只会让用户以为「没反应」）
    if (cur && (cur.status === 'done' || cur.status === 'queued' || cur.status === 'resolving' || cur.status === 'downloading')) return
    // 兼容旧版任务 id（没有音质后缀）：同一首歌已经下过这个档位就不再下
    const legacy = map.current.get(`audio:${track.id}`)
    if (legacy && (legacy.status === 'done' || legacy.status === 'queued' || legacy.status === 'resolving' || legacy.status === 'downloading')) {
      if (!quality || legacy.quality === quality) return
    }
    enqueue({
      id,
      trackId: track.id,
      kind: 'audio',
      title: track.title,
      artist: track.artist,
      album: track.album,
      cover: track.cover,
      source: 'online',
      quality,
      status: 'queued',
      done: 0,
      total: 0,
      path: '',
      at: Date.now(),
      track,
    })
  }, [enqueue])

  const downloadLyric = useCallback((track: LocalTrack, lrcText: string) => {
    const id = `lyric:${track.id}`
    const cur = map.current.get(id)
    if (cur && (cur.status === 'done' || cur.status === 'downloading')) return
    enqueue({
      id,
      trackId: track.id,
      kind: 'lyric',
      title: track.title,
      artist: track.artist,
      album: track.album,
      cover: track.cover,
      source: 'lyric',
      status: 'queued',
      done: 0,
      total: 0,
      path: '',
      at: Date.now(),
      track,
      lrc: lrcText,
    })
  }, [enqueue])

  const retry = useCallback((id: string) => {
    const cur = map.current.get(id)
    if (!cur) return
    /*
     * 重试必须**先扔掉直链缓存**：失败的十有八九是那条地址过期 / 被拒了，
     * 不清掉的话重试会原样再拿回同一条死链，用户点三次还是同一个错。
     */
    forgetResolved(cur.trackId)
    map.current.set(id, { ...cur, status: 'queued', error: undefined, done: 0, total: 0, at: Date.now() })
    sync()
    pumpRef.current()
  }, [sync])

  const remove = useCallback((id: string) => {
    map.current.delete(id)
    sync()
  }, [sync])

  const clearFinished = useCallback(() => {
    for (const [k, v] of [...map.current.entries()]) {
      if (v.status === 'done' || v.status === 'error') map.current.delete(k)
    }
    sync()
  }, [sync])

  /** 这首歌是否正在下载（按钮转圈用）——同一首歌可能下了多个音质，任一条在跑就算 */
  const busyOf = useCallback((trackId: string) => {
    for (const t of map.current.values()) {
      if (t.trackId !== trackId || t.kind !== 'audio') continue
      if (t.status === 'queued' || t.status === 'resolving' || t.status === 'downloading') return true
    }
    return false
  }, [])

  /**
   * 这首歌的音频任务（下载页/播放页展示用）。
   * 同一首歌可以下多个音质（各是一个文件）：优先返回正在跑的那条，
   * 都没有就返回最近的一条——播放页弹层底部那行状态看的是它。
   */
  const taskOf = useCallback((trackId: string) => {
    const live = (x: DownloadTask) => x.status === 'queued' || x.status === 'resolving' || x.status === 'downloading'
    let best: DownloadTask | undefined
    for (const t of map.current.values()) {
      if (t.trackId !== trackId || t.kind !== 'audio') continue
      if (!best) { best = t; continue }
      if (live(t) !== live(best)) { if (live(t)) best = t; continue }
      if (t.at > best.at) best = t
    }
    return best
  }, [])

  /* busyOf/taskOf 读的是 ref，渲染不会因为 ref 变化而重跑；
     但每次 sync 都会产生新 tasks 数组，消费者重渲染时就能读到最新值。 */
  void tasks

  return (
    <DownloadsCtx.Provider
      value={{ tasks, dir, customDir, setDir, download, downloadLyric, retry, remove, clearFinished, busyOf, taskOf }}
    >
      {children}
    </DownloadsCtx.Provider>
  )
}
