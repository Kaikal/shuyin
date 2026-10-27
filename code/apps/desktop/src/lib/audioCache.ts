/**
 * 在线音频的本地缓存。
 *
 * 解决的是这一句：「每次打开都要重新请求吗」。
 *
 * 在线曲目的直链是**一次性**的——签名十几分钟就过期，而且每次都要走一遍
 * 「音源脚本 → 平台接口 → 拼直链 → 探活」，慢的时候要两三秒才出声。
 * 于是这里在后台把整首歌落到本地：下次再听同一首，直接把它当本地文件播，
 * 秒开，也不需要网络。
 *
 * 三条约束：
 *   1. **不阻塞播放**：补缓存是 `void` 的后台任务，失败无所谓（下次再补）；
 *   2. **不占用户下载目录**：缓存放 `AppCache/cache/audio`，设置页有「清空缓存」，
 *      清缓存只删这个目录，用户主动下载到「下载」文件夹的歌一份都不动；
 *   3. **索引要落盘**：文件名是「曲目 id + 扩展名」，但找回来的时候得先知道扩展名，
 *      所以单独存一张 `id → { ext, at, size }` 的索引表。
 */
import { bridge } from './bridge'
import { settings } from './settings'

interface CacheEntry {
  /** 文件扩展名（含点），如 `.mp3` */
  ext: string
  /** 落盘时间戳 */
  at: number
  /** 字节数，0 表示还没写完 */
  size: number
}

const INDEX_KEY = 'cache.audioIndex'

/** id → 索引（权威数据在内存，写盘节流） */
const index = new Map<string, CacheEntry>()
/** 正在补缓存的 id：避免同一首歌并发下两遍 */
const warming = new Set<string>()
let booted: Promise<void> | null = null
let saveTimer = 0

function boot(): Promise<void> {
  if (!booted) {
    booted = settings.get<Record<string, CacheEntry>>(INDEX_KEY).then(v => {
      if (!v || typeof v !== 'object') return
      for (const [k, e] of Object.entries(v)) {
        if (e && e.ext) index.set(k, e)
      }
    }).catch(() => { /* 读不到就当空 */ })
  }
  return booted
}

function persist() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const obj: Record<string, CacheEntry> = {}
    for (const [k, v] of index) obj[k] = v
    void settings.set(INDEX_KEY, obj).catch(() => {})
  }, 800)
}

/** 从直链猜扩展名（和下载用的是同一套规则，猜不到按 mp3） */
function extOf(url: string): string {
  const m = /\.(mp3|m4a|aac|flac|wav|ogg)(?:[?#]|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase()}` : '.mp3'
}

/**
 * 命中缓存返回可直接播放的本地路径，否则 null（索引会顺手清掉已失效的条目）。
 *
 * `expectSec` 是「这首歌本来该多长」，用来验一验缓存里那份到底是不是它。
 *
 * 为什么非要验：缓存是按「曲目 id + 扩展名」存的，一旦某次出网拿到的是**另一首歌**
 * （音源给错、平台串了），那首歌从此就跟着 id 定居在硬盘上了。之后每次点这首歌
 * 都命中缓存，压根不出网，`verify` 一次都不会跑——用户听到的就是「标题写着花海，
 * 声音是邓紫棋唯一」，而且怎么重开都还是它。只有把文件本身读一遍才能发现。
 */
export async function cachedAudio(trackId: string, expectSec = 0): Promise<string | null> {
  await boot()
  const e = index.get(trackId)
  if (!e) return null
  const p = await bridge.cacheLookup(trackId, e.ext).catch(() => null)
  if (!p) {
    // 文件被用户手动删了 / 清了缓存：索引跟着失效，别再反复查
    index.delete(trackId)
    persist()
    return null
  }
  // 短于 45 秒的不判（搜索结果时长误差占比太大，见 online.ts 里的同一套阈值）
  if (expectSec >= 45) {
    const real = await bridge.localAudioDuration(p).catch(() => 0)
    if (real > 0 && Math.abs(real - expectSec) > Math.max(10, expectSec * 0.06)) {
      // 缓存里是别人的歌：索引和文件一起清掉，让上层重新取链
      index.delete(trackId)
      persist()
      void bridge.cacheDrop(trackId, e.ext).catch(() => false)
      return null
    }
  }
  return p
}

/**
 * 后台补缓存。
 *
 * `delay` 是故意的，而且比看上去重要：刚点播放的头几秒正在抢带宽
 * （要立刻出声，Rust 侧那 4 个分段线程全在跑），这时候再起一个 4 线程下载
 * 会和流式播放抢同一批连接——用户感知到的就是「怎么点了半天才响」。
 * 6 秒后声音已经稳定、首段也缓够了，再补下载才不影响体感。
 */
export function warmCache(trackId: string, url: string, delay = 6000): void {
  if (!bridge.isNative || !url) return
  if (index.has(trackId) || warming.has(trackId)) return
  warming.add(trackId)
  const ext = extOf(url)
  window.setTimeout(() => {
    void (async () => {
      try {
        const slot = await bridge.cacheSlot(trackId, ext)
        if (!slot) return
        const n = await bridge.downloadTrack(url, slot)
        if (n > 0) {
          index.set(trackId, { ext, at: Date.now(), size: n })
          persist()
        }
      } catch { /* 缓存失败不影响播放，下次再补 */ } finally {
        warming.delete(trackId)
      }
    })()
  }, delay)
}

/** 缓存占用（字节）。索引只记已知条目，真值问 Rust 目录 */
export const audioCacheSize = () => bridge.cacheSize().catch(() => 0)

/** 清空缓存：删目录 + 清索引，返回释放的字节数 */
export async function clearAudioCache(): Promise<number> {
  index.clear()
  warming.clear()
  persist()
  return bridge.cacheClear().catch(() => 0)
}
