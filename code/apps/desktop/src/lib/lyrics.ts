/**
 * 歌词加载：本地（同名 .lrc / 内嵌歌词）优先 → 在线 lrclib.net 兜底。
 * 在线请求失败（无网 / 无结果 / 超时）静默降级，不阻塞播放。
 */
import { parseLrc, plainLyricLines, type LocalTrack, type LyricsDoc, type LyricLine } from '@shuyin/core'
import { bridge } from './bridge'
import { cachedLyric, rememberLyric } from './mediaCache'
import { titleMismatch } from './titleMatch'

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
 * `q` 是用户在搜索表单里手动填的歌名 / 歌手：**改过了就按它模糊搜**（/api/get，
 * 不带 duration——用户改名字往往就是在找另一个版本，拿本首的时长去卡会把
 * 结果全部挡掉）。没改过就走**核对过的搜索**（/api/search + 歌名/时长校验，
 * 见 fetchVerified）——自动路径拿到的词必须证明是这首的，核对不过宁可没有，
 * 也不能把别首歌的词挂上来。
 */
export async function searchOnlineLyrics(
  track: LocalTrack,
  q?: { title?: string; artist?: string },
): Promise<LyricsDoc | null> {
  try {
    const title = (q?.title ?? '').trim()
    const artist = (q?.artist ?? '').trim()
    const manual = !!q && (title !== (track.title || '') || artist !== (track.artist || ''))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    /*
     * 安卓不能走 fetch：页面挂在虚拟域 `appassets.androidplatform.net` 上，
     * 跨域请求 lrclib 会被 WebView 判 CORS（真机日志里就是
     * "blocked by CORS policy: No 'Access-Control-Allow-Origin'"），
     * 安卓那台从头到尾拿不到在线歌词。改走原生 `net_request`（Kotlin Http，无同源限制）。
     */
    const req = (url: string): Promise<{ status: number; body: string } | null> =>
      bridge.isNative
        ? bridge.invoke<{ status: number; body: string }>('net_request', {
            req: { url, method: 'GET', headers: { accept: 'application/json' }, timeout: 6000 },
          })
        : fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
            .then(async res => ({ status: res.status, body: await res.text() }))
    const getJson = async <T,>(url: string): Promise<T | null> => {
      const r = await req(url)
      clearTimeout(timer)
      if (!r || r.status >= 400) return null
      return JSON.parse(r.body) as T
    }
    const text = manual
      ? await fetchGet(getJson, title || (track.title || ''), artist || (track.artist || ''), track.album || '')
      : await fetchVerified(getJson, track)
    if (!text?.trim()) return null
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

/** lrclib 精确查一条（/api/get）：没查到按最近似返回，**结果没法核对**——只给手动搜索用 */
async function fetchGet(
  getJson: <T>(url: string) => Promise<T | null>,
  trackName: string, artistName: string, album: string,
): Promise<string | null> {
  const p = new URLSearchParams({ artist_name: artistName, track_name: trackName, album_name: album })
  const data = await getJson<{ syncedLyrics?: string | null; plainLyrics?: string | null }>(
    'https://lrclib.net/api/get?' + p.toString(),
  )
  return data?.syncedLyrics || data?.plainLyrics || null
}

interface LrcHit {
  trackName: string
  artistName: string
  duration: number | null
  syncedLyrics: string | null
  plainLyrics: string | null
}

/**
 * 自动路径：/api/search 拿一批带元数据的候选，**逐条核对再取词**。
 *
 * 为什么不能再用 /api/get（2026-11-21 平板「海屿你歌词不对」的教训）：
 * 它在库里有这首时返回精确结果，没有时**悄悄返回最近似的另一首**——
 * 歌名歌手对不上也照给，而我们拿到手只剩一坨歌词文本，根本无从核对
 * 是不是这首歌的词。/api/search 每条都带 trackName / artistName / duration，
 * 核对是实的：歌名必须互含（titleMismatch 挡掉完全不同的）、时长差不出
 * 12%（音源转码差异兜 8 秒底）、都过了才收；有逐行时间轴的优先。
 */
async function fetchVerified(
  getJson: <T>(url: string) => Promise<T | null>,
  track: LocalTrack,
): Promise<string | null> {
  const p = new URLSearchParams({
    track_name: (track.title || '').trim(),
    artist_name: (track.artist || '').trim(),
  })
  const hits = await getJson<LrcHit[]>('https://lrclib.net/api/search?' + p.toString())
  if (!Array.isArray(hits) || !hits.length) return null
  const dur = track.duration || 0
  const tol = dur > 0 ? Math.max(8, dur * 0.12) : 0
  const artists = (track.artist || '').split(/\s*[/、]\s*/).map(s => s.trim().toLowerCase()).filter(Boolean)
  let best: LrcHit | null = null
  let bestScore = -1
  for (const h of hits) {
    if (titleMismatch(track.title, h.trackName)) continue
    if (dur > 0 && h.duration && Math.abs(h.duration - dur) > tol) continue
    let s = 0
    const a = (h.artistName || '').toLowerCase()
    if (a && artists.some(x => a.includes(x) || x.includes(a))) s += 20
    if (h.syncedLyrics?.trim()) s += 10
    if (s > bestScore) { bestScore = s; best = h }
  }
  if (!best) return null
  return best.syncedLyrics || best.plainLyrics || null
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
    /*
     * 本地没有就先用**上次在线拿到的那份**（断网时这是唯一能显示的东西）。
     * 顺序是「本地文件 → 落盘的在线歌词 → 重新联网取」：网络那次要等超时，
     * 有存量就先用存量把界面填上，用户点「重新加载」才会强制走网络。
     */
    if (!doc.lines.length && !opts.retry) {
      const saved = await cachedLyric(track.id).catch(() => null)
      if (saved) doc = fromText(saved, 'online')
    }
    if ((!doc.lines.length) && (opts.online !== false)) {
      const online = await searchOnlineLyrics(track)
      if (online) doc = online
    }
    if (doc.lines.length || doc.plain.trim()) {
      cache.set(track.id, doc)
      miss.delete(track.id)
      /* 在线歌词顺手落盘：下次断网也有词 */
      if (doc.source === 'online' && doc.plain.trim()) {
        void rememberLyric(track.id, doc.plain, opts.retry === true)
      }
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
