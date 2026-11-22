/**
 * 离线可用的「封面 + 歌词」缓存。
 *
 * 为什么单独做一层：在线曲目的音频有整曲缓存（`audioCache.ts`），断网也能放；
 * 但封面是平台 CDN 的图、歌词是平台接口的文本，**两者都没落过盘**。
 * 于是「没网听已缓存的歌」时，用户看到的是：歌在响，封面是灰色渐变，
 * 歌词写着「暂无歌词」（用户 2026-11 的原话）。音频都下到本地了，
 * 这两样却不跟着走，说不通。
 *
 * 落点复用播放缓存目录（`cache_slot`），所以「设置 → 清空缓存」会一起清掉，
 * 不额外占用户心里的一份额度。
 *
 * 两条路径要分开看：
 *   · **歌词**是文本 → `write_text_abs` / `read_text_abs`，和路径无关；
 *   · **封面**要能塞进 `<img src>` → 桌面走 `convertFileSrc`（asset 协议），
 *     安卓走壳里新加的 `/cachefile/?p=` 路由（见 MainActivity 的 shouldInterceptRequest），
 *     因为那边 `allowFileAccess = false`，`file://` 图片一律不显示。
 */
import { convertFileSrc } from '@tauri-apps/api/core'
import { bridge, isAndroid, isTauri } from './bridge'
import { settings } from './settings'

const COVER_IDX = 'cache.covers'
const LYRIC_IDX = 'cache.lyrics'

/** 平台封面地址 → 本地文件绝对路径 */
const covers = new Map<string, string>()
/** 曲目 id → 歌词文件绝对路径 */
const lyricFiles = new Map<string, string>()

let booted: Promise<void> | null = null
let saveTimer = 0
/** 封面下载中被问过几次（同一地址只下一次） */
const pending = new Set<string>()
/** 缓存有变化时通知界面（Cover 要重新取一帧） */
const subs = new Set<() => void>()
/** 版本号：给 `useSyncExternalStore` 当快照用（数字天然稳定） */
let ver = 0
const emit = () => { ver++; for (const fn of subs) fn() }

/** 当前版本（封面索引一变就 +1） */
export const mediaCacheVersion = () => ver

/** 订阅缓存变化（封面刚下完 / 索引失效），返回退订函数 */
export function subscribeMediaCache(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** 稳定短名：地址太长，直接当文件名会超长；FNV-1a 够用且不引入依赖 */
function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36) + '_' + s.length.toString(36)
}

function boot(): Promise<void> {
  if (!booted) {
    booted = Promise.all([
      settings.get<Record<string, string>>(COVER_IDX).catch(() => null),
      settings.get<Record<string, string>>(LYRIC_IDX).catch(() => null),
    ]).then(([c, l]) => {
      if (c && typeof c === 'object') for (const [k, v] of Object.entries(c)) if (v) covers.set(k, v)
      if (l && typeof l === 'object') for (const [k, v] of Object.entries(l)) if (v) lyricFiles.set(k, v)
      /* 索引是异步载入的：载完通知一次订阅者，meta 推送才有机会把 CDN 换成本地路径 */
      emit()
    })
  }
  return booted
}
void boot()

function persist() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void settings.set(COVER_IDX, Object.fromEntries(covers)).catch(() => {})
    void settings.set(LYRIC_IDX, Object.fromEntries(lyricFiles)).catch(() => {})
  }, 800)
}

/**
 * 本地文件 → 能塞进 `<img src>` 的地址。
 * 桌面是 asset 协议；安卓是壳里那条 `/cachefile/` 路由；浏览器预览返回空。
 */
export function localFileUrl(abs: string): string {
  if (!abs) return ''
  if (isTauri) return convertFileSrc(abs)
  if (isAndroid) return `${location.origin}/cachefile/?p=${encodeURIComponent(abs)}`
  return ''
}

/** 这个封面地址是否已经有本地副本（同步，渲染路径里用） */
export function cachedCoverUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  const p = covers.get(url)
  return p ? localFileUrl(p) || undefined : undefined
}

/**
 * 封面地址 → 本地文件**绝对路径**（没有返回 undefined）。
 *
 * 给原生侧（通知大图 / 锁屏页）用：它们不吃 `/cachefile/` 路由，离线时
 * 拿着 CDN 直链去联网只会失败——推 meta 时换成这份本地路径，断网也有封面
 * （用户 2026-11-20：「离线使用时锁屏页封面是黑的，歌词都在」）。
 */
export function cachedCoverPath(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return covers.get(url) || undefined
}

/** 本地副本坏了（文件被清掉）：丢掉索引，下一次渲染回落到远端地址 */
export function forgetCover(url: string | null | undefined): void {
  if (!url) return
  if (!covers.delete(url)) return
  persist()
  emit()
}

/** 封面 URL → 落盘扩展名（安卓那条 `/cachefile/` 路由按它决定 Content-Type） */
function coverExt(url: string): string {
  const m = /\.(jpg|jpeg|png|webp)(?:[?#]|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg'
}

/**
 * 把一张封面存到本地（后台，失败无所谓）。
 *
 * 只在**真的会用到**的时机调（当前曲目 / 刚收藏的歌）：列表里几十张图全下
 * 会白白吃掉用户的流量和磁盘，而用户离线时真正想看的只有正在听的那张。
 */
export function rememberCover(url: string | null | undefined, delay = 1500): void {
  if (!url || !/^https?:\/\//i.test(url)) return
  if (!isTauri && !isAndroid) return
  if (covers.has(url) || pending.has(url)) return
  pending.add(url)
  window.setTimeout(() => {
    void (async () => {
      try {
        const slot = await bridge.cacheSlot('cv_' + hash(url), coverExt(url))
        if (!slot) return
        const n = await bridge.downloadTrack(url, slot)
        if (n > 0) {
          covers.set(url, slot)
          persist()
          emit()
        }
      } catch { /* 存不下就下次再说 */ } finally {
        pending.delete(url)
      }
    })()
  }, delay)
}

/* ------------------------------------------------------------------ */
/* 歌词                                                                */
/* ------------------------------------------------------------------ */

/** 读本地歌词（没有 / 文件丢了返回 null） */
export async function cachedLyric(trackId: string): Promise<string | null> {
  await boot()
  const p = lyricFiles.get(trackId)
  if (!p) return null
  try {
    const t = await bridge.invoke<string>('read_text_abs', { path: p })
    if (t && t.trim()) return t
  } catch { /* 文件没了：清索引 */ }
  lyricFiles.delete(trackId)
  persist()
  return null
}

/** 存一份歌词（在线拿到就顺手落盘，下次断网也有词）。`force` = 覆盖旧的那份 */
export async function rememberLyric(trackId: string, text: string, force = false): Promise<void> {
  if (!trackId || !text.trim()) return
  if (!isTauri && !isAndroid) return
  await boot()
  if (!force && lyricFiles.has(trackId)) return
  try {
    const slot = await bridge.cacheSlot('lrc_' + hash(trackId), '.lrc')
    if (!slot) return
    await bridge.writeTextAbs(slot, text)
    lyricFiles.set(trackId, slot)
    persist()
  } catch { /* 落盘失败不影响本次播放 */ }
}
