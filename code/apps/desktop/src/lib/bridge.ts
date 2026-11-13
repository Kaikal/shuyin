/**
 * 平台桥接层：所有对原生能力的调用集中在此。
 *
 * 三个宿主，同一个命令表：
 *   桌面 Tauri → `invoke`（Rust 命令，见 src-tauri/src/lib.rs）
 *   安卓壳     → `androidInvoke`（Kotlin 命令，见 apps/android/.../Bridge.kt）
 *   浏览器预览 → mock（纯前端开发调试用）
 *
 * 上层只认 `invoke(cmd, args)` 与下面这些语义化的方法，
 * 因此「界面复用」在安卓上是真的复用，不是重写一套。
 */
import type { LocalTrack, ScanResult } from '@shuyin/core'
import { androidInvoke, isAndroid, lastKnownPlayerState, onNative } from './native/android'
import { toast } from './toast'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export { isAndroid }

/** 有原生能力（桌面或安卓），即「不是浏览器预览」 */
export const isNative = isTauri || isAndroid

export type ScanScope = 'fast' | 'full' | 'custom'

/** `probe_audio_url` 的返回：读到的字节 + 整首字节数 + Content-Type + 文件头里读出的时长 */
export interface ProbeAudioInfo {
  got: number
  /** 0 = 服务端没给长度（这时跳过「是不是这首歌」的校验） */
  total: number
  contentType: string
  status: number
  /** 秒；0 = 这个封装里读不出来（m4a 的 moov 在尾部、或者数据不够） */
  duration: number
  /** 音频文件自己写的标题；空串 = 这个封装里没有标签（跳过名字校验） */
  title: string
  /** 音频文件自己写的歌手；空串同上 */
  artist: string
}

/**
 * 「其他应用打开」送进来的文件（安卓 `intent://VIEW|SEND`）。
 * 原生已经把它拷进 `cache/inbox`，`path` 可以直接读。
 */
export interface IncomingFile {
  /** 原生生成的去重号：同一个文件可能既被「取」到又被「推」过来 */
  id: string
  path: string
  /** 原始文件名（带后缀），拿来当音源名 */
  name: string
  size: number
  /** 内容里能不能找到洛雪脚本的痕迹（`@name` / `module.exports` / `musicUrl`） */
  source: boolean
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args)
  }
  if (isAndroid) return androidInvoke<T>(cmd, args)
  return mockInvoke<T>(cmd, args)
}

/* ------------------------------------------------------------------ */
/* Mock（浏览器开发用）                                                 */
/* ------------------------------------------------------------------ */

const MOCK_TITLE_A = ['夜航西飞', '云层很薄', '城市光带', '引擎声', '座位上的编号', '最后一次远行', '灯火留在身后', '风从舷窗的缝隙里穿过', '而我一直没有回头', '沉默的跑道', '云上的日出', '潮汐表', '北纬五十度', '远洋信件']
const MOCK_ARTISTS = ['陈默', '岛屿与海', '白鲸乐队', '周屿', 'Seabird', 'Aria Tang']
const MOCK_ALBUMS = ['岛屿与海', '夜航西飞', '风与航线', 'Signals', '潮汐']

const MOCK_LYRICS = `[00:12.20]我们把灯火留在身后
[00:18.60]夜航向西 云层很薄
[00:25.10]你数着座椅上的编号
[00:31.80]说这是最后一次远行
[00:38.40]如果云会记得
[00:44.90]我们曾在这里停留过
[00:52.30]风从舷窗的缝隙里穿过去
[00:59.10]而我一直没有回头
[01:06.40]直到城市变成一条光带
[01:13.20]才明白那不是告别
[01:20.60]云上的日出很慢
[01:27.30]慢到可以说完一生`

function mockTracks(count: number, dir: string): LocalTrack[] {
  const list: LocalTrack[] = []
  for (let i = 0; i < count; i++) {
    const fmt = (['flac', 'mp3', 'flac', 'm4a', 'ogg', 'wav'] as const)[i % 6]
    list.push({
      id: 't' + i + '_' + dir.length,
      path: dir + '/track-' + String(i).padStart(3, '0') + '.' + fmt,
      title: MOCK_TITLE_A[i % MOCK_TITLE_A.length] + (i >= MOCK_TITLE_A.length ? ' (' + (Math.floor(i / MOCK_TITLE_A.length) + 1) + ')' : ''),
      artist: MOCK_ARTISTS[i % MOCK_ARTISTS.length],
      album: MOCK_ALBUMS[i % MOCK_ALBUMS.length],
      duration: 180 + ((i * 37) % 160),
      format: fmt,
      bitrate: fmt === 'flac' ? 1057 : 320,
      sampleRate: 44100,
      cover: null,
      mtime: Date.now() - i * 86400000,
      size: (fmt === 'flac' ? 40 : 8) * 1024 * 1024,
      year: 2020 + (i % 6),
      trackNo: (i % 12) + 1,
      genre: ['民谣', '电子', 'Ambient'][i % 3],
    })
  }
  return list
}

const MOCK_TRACKS = mockTracks(320, 'C:/Users/demo/Music')

let mockPlaying = false
let mockPos = 0
let mockVolume = 0.8

function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // 频谱要按帧轮询，不能走 120ms 的模拟延迟
  if (cmd === 'spectrum') {
    const t = Date.now() / 1000
    const bands = Array.from({ length: 40 }, (_, i) => {
      const shape = Math.exp(-Math.pow((i - 7) / 11, 2))
      const wobble = 0.45 + 0.55 * Math.abs(Math.sin(t * (1.1 + i * 0.11) + i * 0.55))
      const v = shape * wobble * (mockPlaying ? 1 : 0.05)
      return Math.max(0, Math.min(1, v))
    })
    return Promise.resolve(bands as T)
  }
  return new Promise(resolve => {
    setTimeout(() => {
      switch (cmd) {
        case 'scan_music': {
          const scope = (args?.scope as string) ?? 'fast'
          const dirs = (args?.directories as string[]) ?? []
          const res: ScanResult = {
            total: MOCK_TRACKS.length,
            added: MOCK_TRACKS.length,
            updated: 0,
            removed: 0,
            durationMs: scope === 'full' ? 5200 : 1400,
            incremental: Boolean(args?.incremental),
            roots: dirs.length ? dirs : scope === 'full' ? ['C:\\', 'D:\\', 'E:\\'] : ['C:\\Users\\demo\\Music', 'D:\\Music'],
            skipped: scope === 'full' ? 371 : 88,
            truncated: false,
          }
          resolve(res as T)
          break
        }
        case 'get_tracks':
          resolve(MOCK_TRACKS as T)
          break
        case 'get_track_count':
          resolve(MOCK_TRACKS.length as T)
          break
        case 'get_lyrics':
          resolve({ source: 'lrc', text: MOCK_LYRICS } as T)
          break
        case 'remove_track':
          resolve(undefined as T)
          break
        case 'player_state':
          resolve({
            playing: mockPlaying, position: mockPos, duration: 246, volume: mockVolume,
            trackPath: null, index: -1, ended: false,
          } as T)
          break
        case 'pick_music_folder':
          resolve('C:\\Users\\demo\\Music' as T)
          break
        default:
          if (cmd === 'play_file') { mockPlaying = true; mockPos = 0 }
          else if (cmd === 'pause') mockPlaying = false
          else if (cmd === 'resume') mockPlaying = true
          else if (cmd === 'set_volume') mockVolume = args?.volume as number
          else if (cmd === 'seek') mockPos = args?.positionSecs as number
          resolve(undefined as T)
      }
    }, 120)
  })
}

/* ------------------------------------------------------------------ */
/* 类型化 API                                                          */
/* ------------------------------------------------------------------ */

export interface PlayerStateSnapshot {
  playing: boolean
  position: number
  duration: number
  volume: number
  trackPath: string | null
  index: number
  ended?: boolean
  /** seek 进行中：此时 position 是旧值，前端不要拿它回写进度条 */
  seeking?: boolean
  /** 播放错误（一次性）：格式不支持 / 文件损坏 / 设备异常 */
  error?: string | null
  /** 在线曲目已缓冲到的秒数（本地恒 0），进度条画淡色第二层用 */
  buffered?: number
}

export interface ScanProgressPayload {
  found: number
  parsed: number
  currentDir?: string
}

export interface LyricsRawPayload {
  source: 'lrc' | 'embedded' | 'none'
  text: string
}

export const bridge = {
  invoke,
  isTauri,
  isAndroid,
  isNative,

  async scanMusic(scope: ScanScope, directories: string[], incremental: boolean): Promise<ScanResult> {
    return invoke<ScanResult>('scan_music', { scope, directories, incremental })
  },
  async getTracks(): Promise<LocalTrack[]> {
    return invoke<LocalTrack[]>('get_tracks')
  },
  async getTrackCount(): Promise<number> {
    return invoke<number>('get_track_count')
  },
  async getLyrics(trackId: string): Promise<LyricsRawPayload> {
    return invoke<LyricsRawPayload>('get_lyrics', { trackId })
  },
  async removeTrack(trackId: string): Promise<void> {
    return invoke('remove_track', { trackId })
  },
  async pickMusicFolder(): Promise<string | null> {
    return invoke<string | null>('pick_music_folder')
  },
  async playerState(): Promise<PlayerStateSnapshot> {
    /*
     * 字段名归一化。
     *
     * 桌面 Rust 回的是 camelCase（`trackPath`），安卓 `Bridge.kt` 直接把
     * `PlaybackService.snapshot` 那个 JSONObject 原样吐出来——里面是
     * `track_path` / `track_url`。以前没人读这个字段所以没露馅，但
     * 「原生是不是还挂着一个活的音源」正是靠它判断（见 PlayerProvider 的
     * 会话接管），不归一化就等于安卓上永远判「没有」。
     */
    const raw = await invoke<PlayerStateSnapshot & {
      track_path?: string | null
      track_url?: string | null
    }>('player_state')
    return {
      ...raw,
      trackPath: raw.trackPath ?? raw.track_path ?? raw.track_url ?? null,
    }
  },
  /**
   * 加载并播放某首。
   * opts.startAt：从第几秒开始（恢复上次进度）；
   * opts.autoplay=false：只加载并停在 startAt，等用户点播放。
   */
  async playFile(path: string, index: number, opts?: { startAt?: number; autoplay?: boolean }): Promise<void> {
    return invoke('play_file', {
      path,
      index,
      startAt: opts?.startAt ?? 0,
      autoplay: opts?.autoplay ?? true,
    })
  },
  /**
   * 在线曲目：直链流式播放（Rust 侧用 HTTP Range 边下边解，可拖进度）。
   * durationHint 来自平台搜索结果（秒），远端拿不到权威时长只能靠它。
   */
  async playUrl(
    url: string,
    index: number,
    opts?: { durationHint?: number; startAt?: number; autoplay?: boolean },
  ): Promise<void> {
    return invoke('play_url', {
      url,
      index,
      durationHint: opts?.durationHint ?? 0,
      startAt: opts?.startAt ?? 0,
      autoplay: opts?.autoplay ?? true,
    })
  },
  async pause(): Promise<void> { return invoke('pause') },  async resume(): Promise<void> { return invoke('resume') },
  async stop(): Promise<void> { return invoke('stop') },
  async seek(secs: number): Promise<void> { return invoke('seek', { positionSecs: secs }) },
  async setVolume(v: number): Promise<void> { return invoke('set_volume', { volume: v }) },

  /** 频谱快照：40 个频段，0..1（暂停/停止时全 0） */
  async spectrum(): Promise<number[]> {
    try {
      return await invoke<number[]>('spectrum')
    } catch {
      return []
    }
  },

  /**
   * 探测在线直链是否真的能播（Rust 侧发一个 Range 请求看有没有字节回来）。
   * 取链成功 ≠ 能播：平台经常回 403 / 空 body / HTML 错误页，必须落地验一次。
   *
   * 返回里带 `total`（整首字节数），用来反算平均码率、判断「这个文件是不是这首歌」。
   * 浏览器预览版没有网络代理，按「能播」返回、`total=0` 让上层跳过校验。
   */
  async probeAudioInfo(url: string): Promise<ProbeAudioInfo> {    if (!isNative) return { got: 1, total: 0, contentType: '', status: 200, duration: 0, title: '', artist: '' }
    return invoke<ProbeAudioInfo>('probe_audio_url', { url })
  },

  /** 本地音频文件的真实时长（秒）。缓存校验用，读不出来按 0 */
  async localAudioDuration(path: string): Promise<number> {
    if (!isNative) return 0
    return invoke<number>('local_audio_duration', { path }).catch(() => 0)
  },

  /**
   * 本地音频文件自己写的标题/歌手。安卓侧没有对应命令（要 MediaMetadataRetriever，
   * 而缓存校验在手机上不划算）——读不到就返回空，调用方跳过名字校验。
   */
  async localAudioTags(path: string): Promise<{ title: string; artist: string }> {
    if (!isTauri) return { title: '', artist: '' }
    try {
      const r = await invoke<[string, string]>('local_audio_tags', { path })
      return { title: r?.[0] || '', artist: r?.[1] || '' }
    } catch {
      return { title: '', artist: '' }
    }
  },

  /* ---- 音源脚本导入（只此一个入口：清单式存储，改文件夹不认） ---- */
  async sourcesDefaultDir(): Promise<string> {
    return invoke<string>('sources_default_dir')
  },
  /** 选本地 .js 文件导入，返回导入后的音源名（可多个） */
  async importSourceFiles(): Promise<string[]> {
    if (!isNative) return []
    return invoke<string[]>('import_source_files')
  },
  /** 粘贴脚本文本导入 */
  async importSourceText(name: string, code: string): Promise<string> {
    return invoke<string>('import_source_text', { name, code })
  },
  /** 用 URL 导入脚本 */
  async importSourceUrl(url: string, name?: string): Promise<string> {
    return invoke<string>('import_source_url', { url, name: name ?? null })
  },
  async deleteSourceScript(path: string): Promise<void> {
    return invoke('delete_source_script', { path })
  },
  /** 音源清单（名字 + 代码，供配置包备份） */
  async listSourceScripts(): Promise<Array<{ path: string; name: string; code: string }>> {
    if (!isNative) return []
    return invoke<Array<{ path: string; name: string; code: string }>>('list_source_scripts').catch(() => [])
  },

  /* ---- 下载 ---- */
  /**
   * 下载目录。不传 = **系统「下载」文件夹**；传了就用它（Rust 侧会建好）。
   * 用户在设置里选的自定义目录就走这个参数。
   */
  async downloadsDir(dir?: string): Promise<string> {
    if (!isNative) return ''
    return invoke<string>('downloads_dir', { dir: dir ?? null })
  },
  /**
   * 安卓：拉起系统文件夹选择器换下载目录（SAF 授权会持久化）。
   *
   * 桌面返回 null——那边走 Tauri 的目录对话框，不经过这里。
   * 返回值里 `cancel=true` 表示用户按了返回、没选。
   */
  async downloadsPickDir(): Promise<{ dir: string; custom: boolean; cancel: boolean } | null> {
    if (!isAndroid) return null
    return invoke<{ dir: string; custom: boolean; cancel: boolean }>('download_pick_dir')
  },
  /** 安卓：清掉自选目录，回到公共「音乐/疏音」。桌面返回 null（前端自己处理默认） */
  async downloadsResetDir(): Promise<string | null> {
    if (!isAndroid) return null
    return invoke<string>('downloads_reset_dir')
  },
  /** 安卓：当前目录 + 是不是自选的。启动时以原生为准，避免 localStorage 里的旧路径带偏 */
  async downloadsState(): Promise<{ dir: string; custom: boolean } | null> {
    if (!isAndroid) return null
    return invoke<{ dir: string; custom: boolean }>('downloads_state')
  },
  /** 下载在线曲目到 dest（分段并发）。返回写入字节数 */
  async downloadTrack(url: string, dest: string): Promise<number> {
    if (!isNative) throw new Error('网页预览版不能下载，请用桌面端')
    return invoke<number>('download_track', { url, dest })
  },
  /** 查下载进度：[已写, 总量]；没有任务返回 null */
  async downloadProgress(dest: string): Promise<[number, number] | null> {
    if (!isNative) return null
    return invoke<[number, number] | null>('download_progress', { dest })
  },

  /* ---- 播放缓存（听过的歌留一份在本地） ---- */
  /** 命中缓存返回文件路径，否则 null */
  async cacheLookup(key: string, ext: string): Promise<string | null> {
    if (!isNative) return null
    return invoke<string | null>('cache_lookup', { key, ext })
  },
  /** 申请一个缓存落点（后台补缓存时用） */
  async cacheSlot(key: string, ext: string): Promise<string> {
    if (!isNative) return ''
    return invoke<string>('cache_slot', { key, ext })
  },
  /** 删掉某一条缓存（缓存里那份其实是另一首歌时用） */
  async cacheDrop(key: string, ext: string): Promise<boolean> {
    if (!isNative) return false
    return invoke<boolean>('cache_drop', { key, ext }).catch(() => false)
  },
  /** 缓存占用字节数 */
  async cacheSize(): Promise<number> {
    if (!isNative) return 0
    return invoke<number>('cache_size')
  },
  /** 清空播放缓存，返回释放的字节数（不动用户下载目录） */
  async cacheClear(): Promise<number> {
    if (!isNative) return 0
    return invoke<number>('cache_clear')
  },
  /**
   * 旧版本缓存误落到公共音乐目录的副本：[个数, 字节数]。
   *
   * 0.6.96 及更早，缓存下载复用了「下载」那条命令，文件被发布成
   * `Music/疏音/online_*.mp3`（缓存目录一直是空的）。新版本不再生成，
   * 但已经躺下的那些要能让用户自己收掉。
   */
  async cacheCopies(): Promise<[number, number]> {
    if (!isAndroid) return [0, 0]
    const r = await invoke<{ count: number; bytes: number }>('cache_orphans', {}).catch(() => null)
    return r ? [Number(r.count) || 0, Number(r.bytes) || 0] : [0, 0]
  },
  /** 删掉上面那些副本（只认 `online_` 前缀，不会碰到用户自己下载的歌） */
  async purgeCacheCopies(): Promise<[number, number]> {
    if (!isAndroid) return [0, 0]
    const r = await invoke<{ count: number; bytes: number }>('cache_orphans_clean', {}).catch(() => null)
    return r ? [Number(r.count) || 0, Number(r.bytes) || 0] : [0, 0]
  },
  /**
   * 当前缓存目录 + 是不是用户自选的（设置页据此显示「恢复默认」）。
   * 默认 = 数据目录下的 cache\audio，和音源清单同一个家。
   */
  async cacheDir(): Promise<{ dir: string; custom: boolean }> {
    if (!isNative) return { dir: '', custom: false }
    return invoke<{ dir: string; custom: boolean }>('cache_dir')
  },
  /** 换缓存目录；传空恢复默认。已有缓存会一起搬过去，返回新目录 + 搬迁统计 */
  async cacheSetDir(dir: string | null): Promise<{ dir: string; custom: boolean; moved: number; failed: number }> {
    /*
     * 只有桌面能换。安卓的缓存目录是应用私有目录（系统不让普通应用往任意路径
     * 写缓存），命令表里那条 `cache_set_dir` 也只是个占位；网页预览更没有落盘。
     * 这里直接说人话，别再让上层去撞底层实现。
     */
    if (!isTauri) throw new Error(isAndroid ? '手机上不支持更换缓存目录' : '网页预览版不支持更换缓存目录')
    return invoke<{ dir: string; custom: boolean; moved: number; failed: number }>(
      'cache_set_dir',
      { dir: dir && dir.trim() ? dir.trim() : null },
    )
  },
  /** 写 .lrc 文件（覆盖） */
  /** 选保存位置（配置包导出）。浏览器预览返回 null */
  async pickSaveFile(defaultName?: string): Promise<string | null> {
    if (!isNative) return null
    return invoke<string | null>('pick_save_file', { defaultName: defaultName ?? null })
  },
  /** 写任意路径文本（配置包导出） */
  async writeTextAbs(path: string, text: string): Promise<void> {
    return invoke('write_text_abs', { path, text })
  },

  /**
   * 写 .lrc。返回**实际写到的路径**（安卓上歌词落在「下载/疏音」，
   * 和歌曲不在同一个目录，见 `DownloadStore.textDir`；桌面端就写 `dest`）。
   */
  async saveLyricsFile(path: string, text: string): Promise<string | null> {
    if (!isNative) throw new Error('网页预览版不能保存，请用桌面端')
    return invoke<string | null>('save_lyrics_file', { path, text })
  },

  /**
   * 在资源管理器中定位文件。
   *
   * 安卓上没有这个能力（见 `Paths.kt`）：能映射成 document uri 的就交给文件管理器，
   * 不能的（私有目录、Android/data）把路径写进剪贴板。前端按返回结果给提示——
   * 点了没反应比"打不开"更让人摸不着头脑。
   */
  async revealInFolder(path: string): Promise<void> {
    if (isTauri) {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
      await revealItemInDir(path)
      return
    }
    if (!isAndroid) return
    if (!path || !path.trim()) {
      toast('还没有选择路径', { bad: true })
      return
    }
    try {
      const r = await invoke<{ opened: boolean; copied: boolean }>('reveal_path', { path })
      if (r?.opened) toast('已在文件管理器中打开', { ok: true })
      else if (r?.copied) toast('已复制路径', { ok: true })
      else toast('无法打开该路径', { bad: true })
    } catch (e) {
      toast(e instanceof Error ? e.message : '无法打开该路径', { bad: true })
    }
  },

  /** 订阅播放状态事件 */
  onPlayerEvent(cb: (e: { event: string; payload: unknown }) => void): () => void {
    if (isAndroid) {
      // 首帧先补一条「当前真实状态」：原生每 250ms 才推一次，
      // 界面刚起来那一瞬若拿到空状态，恢复出来的曲目会被判成「没在播」。
      const first = lastKnownPlayerState()
      if (first) cb({ event: 'player://state', payload: first })
      return onNative('player://state', payload => cb({ event: 'player://state', payload }))
    }
    if (!isTauri) {
      const t = setInterval(() => {
        if (mockPlaying) {
          mockPos += 1
          if (mockPos >= 246) mockPos = 0
        }
        cb({ event: 'player://state', payload: { playing: mockPlaying, position: mockPos, duration: 246, volume: mockVolume, trackPath: null, index: -1 } })
      }, 1000)
      return () => clearInterval(t)
    }
    let unlisten: (() => void) | null = null
    let disposed = false
    import('@tauri-apps/api/event').then(({ listen }) => {
      if (disposed) return
      listen('player://state', (e) => cb({ event: 'player://state', payload: e.payload })).then(u => {
        if (disposed) u(); else unlisten = u
      })
    })
    return () => { disposed = true; unlisten?.() }
  },

  /* ---- 系统分享（安卓）---- */

  /**
   * 拉起系统分享面板。
   *
   * 以前前端直接 `navigator.share(...)`：那是 **Google Chrome 浏览器**的 API，
   * WebView 里根本没有这个对象，于是每次都掉到「复制文本」的兜底上——
   * 用户点了分享，界面一动不动，看起来就是「按钮点不了」。
   * 这里改成走原生的 `Intent.ACTION_SEND` + 选择器，微信 / QQ / 短信都在里面。
   *
   * 返回 false 表示这个宿主没有系统分享（桌面），调用方自己退回复制文本。
   */
  async shareText(opts: { text: string; title?: string; chooser?: string }): Promise<boolean> {
    if (!isAndroid) return false
    await invoke<boolean>('share_text', {
      text: opts.text,
      title: opts.title ?? '',
      chooser: opts.chooser ?? '分享到',
    })
    return true
  },

  /* ---- 其他应用「打开方式」送进来的文件（安卓）---- */

  /** 取一次冷启动时收到的文件（取走即清空）；没有就 null */
  async takeOpenFile(): Promise<IncomingFile | null> {
    if (!isAndroid) return null
    try {
      return await invoke<IncomingFile | null>('take_open_file')
    } catch {
      return null
    }
  },

  /** 把暂存的音源脚本导入清单，返回最终落下的名字 */
  async importSourceStaged(path: string, name?: string): Promise<string> {
    if (!isAndroid) throw new Error('只有安卓端能从「其他应用打开」导入')
    return invoke<string>('import_source_staged', { path, name: name ?? '' })
  },

  /** 订阅扫描进度事件 */
  onScanProgress(cb: (p: ScanProgressPayload) => void): () => void {
    // 安卓是一次 MediaStore 查询，几百毫秒就回来了，没有进度可言
    if (!isTauri || isAndroid) return () => {}
    let unlisten: (() => void) | null = null
    let disposed = false
    import('@tauri-apps/api/event').then(({ listen }) => {
      if (disposed) return
      listen('scan://progress', (e) => cb(e.payload as ScanProgressPayload)).then(u => {
        if (disposed) u(); else unlisten = u
      })
    })
    return () => { disposed = true; unlisten?.() }
  },
}
