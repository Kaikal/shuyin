/**
 * 歌词加载：本地（同名 .lrc / 内嵌歌词）优先 → 在线 lrclib.net 兜底。
 * 在线请求失败（无网 / 无结果 / 超时）静默降级，不阻塞播放。
 */
import { parseLrc, plainLyricLines, type LocalTrack, type LyricsDoc, type LyricLine } from '@shuyin/core'
import { bridge } from './bridge'

const cache = new Map<string, LyricsDoc>()
const inflight = new Map<string, Promise<LyricsDoc>>()
/**
 * 「这首确实没有歌词」的记录 + 时间戳。
 *
 * 和 `cache` 分开存：命中 `cache` 就彻底不再问了，但空结果不能这样——
 * 本地没 .lrc、lrclib 也没有，可能只是这一下没连上。以前空结果也进 `cache`，
 * 一旦写进去，重试也只会立刻拿回同一份空文档，界面上就永远「暂无歌词」。
 * 现在空结果只记 60s：这段时间内不重复打接口，过了就允许再查一次。
 */
const miss = new Map<string, number>()
const MISS_TTL = 60_000
const EMPTY: LyricsDoc = { source: 'none', lines: [], plain: '' }

function fromText(text: string, source: LyricsDoc['source']): LyricsDoc {
  const lines = parseLrc(text)
  if (lines.length) return { source, lines, plain: text }
  const plain = plainLyricLines(text)
  return { source: lines.length ? source : 'none', lines: plain, plain: text }
}

/** 本地歌词（同目录 .lrc / 内嵌标签） */
export async function loadLocalLyrics(track: LocalTrack): Promise<LyricsDoc> {
  const raw = await bridge.getLyrics(track.id)
  if (raw.source === 'none' || !raw.text.trim()) {
    return { source: 'none', lines: [], plain: '' }
  }
  return fromText(raw.text, raw.source === 'lrc' ? 'lrc' : 'embedded')
}

/**
 * 在线歌词（lrclib.net，支持 CORS；6s 超时）。
 *
 * `q` 是用户在搜索表单里手动填的歌名 / 歌手：**改过了就按它模糊搜**，
 * 并且不带 duration——用户改名字往往就是在找另一个版本（Live、翻唱、
 * 另一个专辑收录），拿本首的时长去卡会把结果全部挡掉。没改过就还是
 * 原来的精确匹配（带专辑 + 时长），别把自动路径的结果改模糊了。
 */
export async function searchOnlineLyrics(
  track: LocalTrack,
  q?: { title?: string; artist?: string },
): Promise<LyricsDoc | null> {
  try {
    const title = (q?.title ?? '').trim()
    const artist = (q?.artist ?? '').trim()
    const manual = !!q && (title !== (track.title || '') || artist !== (track.artist || ''))
    const params = new URLSearchParams({
      artist_name: manual ? artist : (track.artist || ''),
      track_name: manual ? title : (track.title || ''),
    })
    if (!manual) {
      params.set('album_name', track.album || '')
      params.set('duration', String(Math.round(track.duration || 0)))
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    /*
     * 安卓不能走 fetch：页面挂在虚拟域 `appassets.androidplatform.net` 上，
     * 跨域请求 lrclib 会被 WebView 判 CORS（真机日志里就是
     * "blocked by CORS policy: No 'Access-Control-Allow-Origin'"），
     * 安卓那台从头到尾拿不到在线歌词。改走原生 `net_request`（Kotlin Http，无同源限制）。
     */
    const data = await (async () => {
      if (bridge.isNative) {
        const r = await bridge.invoke<{ status: number; body: string }>('net_request', {
          req: {
            url: 'https://lrclib.net/api/get?' + params.toString(),
            method: 'GET',
            headers: { accept: 'application/json' },
            timeout: 6000,
          },
        })
        clearTimeout(timer)
        if (!r || r.status >= 400) return null
        return JSON.parse(r.body) as { syncedLyrics?: string | null; plainLyrics?: string | null }
      }
      const res = await fetch('https://lrclib.net/api/get?' + params.toString(), {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      })
      clearTimeout(timer)
      if (!res.ok) return null
      return await res.json() as { syncedLyrics?: string | null; plainLyrics?: string | null }
    })()
    if (!data) return null
    const text = data.syncedLyrics || data.plainLyrics || ''
    if (!text.trim()) return null
    const doc: LyricsDoc = {
      source: 'online',
      lines: parseLrc(text),
      plain: text,
    }
    if (!doc.lines.length) {
      doc.lines = plainLyricLines(text)
    }
    return doc
  } catch {
    return null
  }
}

/**
 * 统一入口：本地优先，miss 后尝试在线。
 * 结果按曲目缓存；同一曲目并发请求去重。
 */
/**
 * 统一入口：本地优先，miss 后尝试在线。
 * 结果按曲目缓存；同一曲目并发请求去重。
 *
 * `retry` 是给「播放器自动重试」用的：重试就是要重新打一次接口，
 * 不能被上面那条 60s 的空结果记录挡住。
 */
export function loadLyrics(
  track: LocalTrack,
  opts: { online?: boolean; retry?: boolean } = {},
): Promise<LyricsDoc> {
  const hit = cache.get(track.id)
  if (hit) return Promise.resolve(hit)
  const missed = miss.get(track.id)
  if (!opts.retry && missed && Date.now() - missed < MISS_TTL) return Promise.resolve(EMPTY)
  const running = inflight.get(track.id)
  if (running) return running

  const p = (async () => {
    let doc = await loadLocalLyrics(track).catch(() => EMPTY)
    if ((!doc.lines.length) && (opts.online !== false)) {
      const online = await searchOnlineLyrics(track)
      if (online) doc = online
    }
    if (doc.lines.length || doc.plain.trim()) {
      cache.set(track.id, doc)
      miss.delete(track.id)
    } else {
      miss.set(track.id, Date.now())
    }
    inflight.delete(track.id)
    return doc
  })()
  inflight.set(track.id, p)
  return p
}

/** 强制在线搜索（详情页「在线搜索歌词」按钮）；`q` 是用户手动填的歌名 / 歌手 */
export async function forceOnlineLyrics(
  track: LocalTrack,
  q?: { title?: string; artist?: string },
): Promise<LyricsDoc> {
  const online = await searchOnlineLyrics(track, q)
  const doc = online ?? EMPTY
  // 手动搜索拿到歌词就立刻生效，把「这首没歌词」的记录清掉
  if (doc.lines.length || doc.plain.trim()) {
    cache.set(track.id, doc)
    miss.delete(track.id)
  } else {
    miss.set(track.id, Date.now())
  }
  return doc
}

export function lyricAt(doc: LyricsDoc | null, t: number): LyricLine | null {
  if (!doc || !doc.lines.length) return null
  let lo = 0
  let hi = doc.lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (doc.lines[mid].time <= t + 0.05) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans >= 0 ? doc.lines[ans] : null
}
