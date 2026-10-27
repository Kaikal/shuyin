/**
 * 歌词加载：本地（同名 .lrc / 内嵌歌词）优先 → 在线 lrclib.net 兜底。
 * 在线请求失败（无网 / 无结果 / 超时）静默降级，不阻塞播放。
 */
import { parseLrc, plainLyricLines, type LocalTrack, type LyricsDoc, type LyricLine } from '@shuyin/core'
import { bridge } from './bridge'

const cache = new Map<string, LyricsDoc>()
const inflight = new Map<string, Promise<LyricsDoc>>()

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
    const res = await fetch('https://lrclib.net/api/get?' + params.toString(), {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json() as { syncedLyrics?: string | null; plainLyrics?: string | null }
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
export function loadLyrics(track: LocalTrack, opts: { online?: boolean } = {}): Promise<LyricsDoc> {
  const hit = cache.get(track.id)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(track.id)
  if (running) return running

  const p = (async () => {
    let doc = await loadLocalLyrics(track).catch(() => ({ source: 'none', lines: [], plain: '' } as LyricsDoc))
    if ((!doc.lines.length) && (opts.online !== false)) {
      const online = await searchOnlineLyrics(track)
      if (online) doc = online
    }
    cache.set(track.id, doc)
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
  const doc = online ?? { source: 'none', lines: [], plain: '' }
  cache.set(track.id, doc)
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
