/**
 * 歌单导入：解析其他音乐 APP 导出的歌单文件，并在本地曲库里做匹配。
 *
 * 支持的格式（自动嗅探，不依赖扩展名）
 *   - JSON：网易云 `tracks/ar/al`、QQ 音乐 `songlist/singer/album`、通用 `songs/title/artist`
 *   - CSV / TSV：带表头（歌名/歌手/专辑）或不带表头
 *   - M3U / M3U8 / PLS：本地播放列表，命中路径可直接对上曲库文件
 *   - TXT：「歌名 - 歌手」「歌名<TAB>歌手」「1. 歌名 - 歌手」等常见写法
 *
 * 匹配策略：路径 → 标题+歌手全等 → 标题全等 → 标题包含 → 字二元组相似度。
 * 全部失败才判为未匹配，宁可少匹配也不要把歌单塞进不相干的歌。
 */
import type { LocalTrack } from '@shuyin/core'

export interface ImportedSong {
  title: string
  artist: string
  album?: string
  duration?: number
  /** M3U / PLS 里记录的本地路径 */
  path?: string
  /** 原始行（未匹配时展示给用户） */
  raw?: string
}

export type PlaylistFormat = 'json' | 'csv' | 'm3u' | 'pls' | 'txt'

export interface ParsedPlaylist {
  format: PlaylistFormat
  /** 歌单名（部分格式里带） */
  name: string | null
  songs: ImportedSong[]
  /** 解析过程中的提示（例如被忽略的行数） */
  notes: string[]
}

export interface SongMatch {
  song: ImportedSong
  track: LocalTrack
  score: number
}

export interface MatchOutcome {
  matched: SongMatch[]
  unmatched: ImportedSong[]
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

export function parsePlaylist(text: string, filename = ''): ParsedPlaylist {
  const src = text.replace(/^\uFEFF/, '')
  const head = src.trimStart()
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ''

  if (head.startsWith('{') || head.startsWith('[') || ext === 'json') {
    const r = parseJson(src)
    if (r.songs.length) return r
  }
  if (/^#EXTM3U/im.test(src)) return parseM3u(src)
  if (/^\[playlist\]/im.test(src) || /\bFile\d+\s*=/i.test(src)) return parsePls(src)
  if (ext === 'csv' || ext === 'tsv' || looksLikeTable(src)) {
    const r = parseTable(src)
    if (r.songs.length) return r
  }
  return parseLines(src)
}

function looksLikeTable(src: string): boolean {
  const first = src.split(/\r?\n/, 3).find(l => l.trim())
  if (!first) return false
  const cells = first.split(first.includes('\t') ? '\t' : ',')
  if (cells.length < 2) return false
  return /歌名|歌曲|标题|曲名|title|song|track/i.test(cells[0])
}

/* ---------- JSON ---------- */

const TITLE_KEYS = ['name', 'title', 'songName', 'songname', 'song_name', 'trackName', 'trackname', 'track_name', 'song', 'track', '曲名', '歌名', '歌曲']
const ARTIST_KEYS = ['artist', 'artists', 'singer', 'singers', 'singername', 'singerName', 'ar', 'artistName', 'artist_name', 'author', '歌手', '演唱']
const ALBUM_KEYS = ['album', 'albums', 'al', 'albumName', 'album_name', 'albumname', '专辑']
const DUR_KEYS = ['duration', 'dt', 'interval', 'time', 'length', '时长']
const NAME_OF_LIST_KEYS = ['tracks', 'songs', 'songlist', 'list', 'data', 'items', 'playlist', 'items', 'result', 'resources', 'songList']

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function firstString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && k.toLowerCase().includes('name')) return String(v)
  }
  return null
}

/** 歌手字段可能是字符串、对象数组、逗号串 */
function readArtist(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) {
    return v
      .map(x => (typeof x === 'string' ? x : firstString(asRecord(x) ?? {}, ['name', 'title'])))
      .filter((s): s is string => Boolean(s && s.trim()))
      .join(' / ')
  }
  const r = asRecord(v)
  if (r) return firstString(r, ['name', 'title']) ?? ''
  return ''
}

function readNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) {
      // 毫秒字段转秒
      return v > 10000 ? Math.round(v / 1000) : v
    }
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  }
  return undefined
}

function toSong(o: Record<string, unknown>): ImportedSong | null {
  const title = firstString(o, TITLE_KEYS)
  if (!title) return null
  const artist = readArtist(o.artist ?? o.artists ?? o.singer ?? o.singers ?? o.ar ?? o.artistName ?? o.author ?? '')
  const albumRaw = o.album ?? o.albums ?? o.al
  const album = typeof albumRaw === 'string'
    ? albumRaw.trim()
    : firstString(asRecord(albumRaw) ?? {}, ['name', 'title'])
  return {
    title,
    artist,
    album: album ?? undefined,
    duration: readNumber(o, DUR_KEYS),
    path: typeof o.path === 'string' ? o.path : typeof o.url === 'string' && /^[a-z]:\\/i.test(o.url) ? o.url : undefined,
  }
}

function walkJson(node: unknown, out: ImportedSong[], depth = 0): void {
  if (depth > 6 || node == null) return
  if (Array.isArray(node)) {
    for (const item of node) {
      if (typeof item === 'string') {
        const s = parseLooseLine(item)
        if (s) out.push(s)
        continue
      }
      const rec = asRecord(item)
      if (!rec) continue
      const song = toSong(rec)
      if (song) out.push(song)
      else walkJson(rec, out, depth + 1)
    }
    return
  }
  const rec = asRecord(node)
  if (!rec) return
  const song = toSong(rec)
  if (song && (song.artist || song.duration || song.album)) {
    out.push(song)
    return
  }
  for (const key of Object.keys(rec)) {
    if (NAME_OF_LIST_KEYS.includes(key) || Array.isArray(rec[key])) {
      walkJson(rec[key], out, depth + 1)
    }
  }
}

function parseJson(src: string): ParsedPlaylist {
  const notes: string[] = []
  let root: unknown
  try {
    root = JSON.parse(src)
  } catch {
    return { format: 'json', name: null, songs: [], notes: ['文件不是合法 JSON'] }
  }
  const songs: ImportedSong[] = []
  walkJson(root, songs)

  const rec = asRecord(root)
  let name: string | null = null
  if (rec) {
    name = firstString(rec, ['playlistName', 'playlist_name', 'name', 'title'] satisfies string[])
    // 顶层 name 可能就是唯一一首歌的名字，避免误当歌单名
    if (name && (songs.length === 1 || (!Array.isArray(rec.songs) && !Array.isArray(rec.tracks)))) name = null
  }
  const dedup = dedupe(songs)
  if (!dedup.length) notes.push('JSON 里没有识别到歌曲字段')
  return { format: 'json', name, songs: dedup, notes }
}

/* ---------- CSV / TSV ---------- */

function splitRow(line: string, delim: string): string[] {
  if (delim !== ',') return line.split(delim).map(s => s.trim())
  // 简易 CSV：支持双引号包裹
  const cells: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ } else quoted = !quoted
    } else if (ch === ',' && !quoted) {
      cells.push(cur.trim()); cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function parseTable(src: string): ParsedPlaylist {
  const lines = src.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return { format: 'csv', name: null, songs: [], notes: ['文件为空'] }
  const delim = lines[0].includes('\t') ? '\t' : ','
  const head = splitRow(lines[0], delim)
  const idxTitle = head.findIndex(h => /歌名|歌曲|标题|曲名|title|song|track/i.test(h))
  const idxArtist = head.findIndex(h => /歌手|演唱|艺人|artist|singer/i.test(h))
  const idxAlbum = head.findIndex(h => /专辑|album/i.test(h))
  const hasHeader = idxTitle >= 0

  const songs: ImportedSong[] = []
  const body = hasHeader ? lines.slice(1) : lines
  for (const line of body) {
    const cells = splitRow(line, delim)
    if (!cells.length) continue
    if (hasHeader) {
      const title = cells[idxTitle]?.trim()
      if (!title) continue
      songs.push({
        title,
        artist: idxArtist >= 0 ? (cells[idxArtist] ?? '').trim() : '',
        album: idxAlbum >= 0 ? (cells[idxAlbum] ?? '').trim() || undefined : undefined,
        raw: line,
      })
    } else {
      const t = cells[0]?.trim()
      if (!t) continue
      if (cells.length >= 2) songs.push({ title: t, artist: cells[1].trim(), raw: line })
      else {
        const s = parseLooseLine(t)
        if (s) songs.push(s)
      }
    }
  }
  return {
    format: 'csv',
    name: null,
    songs: dedupe(songs),
    notes: hasHeader ? [`识别表头：${head.join(' / ')}`] : ['未检测到表头，按「第 1 列歌名 / 第 2 列歌手」读取'],
  }
}

/* ---------- M3U / PLS ---------- */

function parseM3u(src: string): ParsedPlaylist {
  const songs: ImportedSong[] = []
  let pending: { title: string; artist: string; duration?: number } | null = null
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^#EXTINF:/i.test(line)) {
      const body = line.slice(line.indexOf(':') + 1)
      const comma = body.indexOf(',')
      const durRaw = comma >= 0 ? body.slice(0, comma) : body
      const label = comma >= 0 ? body.slice(comma + 1).trim() : ''
      const split = splitArtistTitle(label)
      pending = { title: split.title, artist: split.artist, duration: Number(durRaw) || undefined }
      continue
    }
    if (line.startsWith('#')) continue
    if (!pending) {
      const split = splitArtistTitle(stripExt(line))
      songs.push({ ...split, path: line, raw: line })
      continue
    }
    songs.push({ ...pending, path: line, raw: line })
    pending = null
  }
  return {
    format: 'm3u',
    name: null,
    songs: dedupe(songs).filter(s => s.title),
    notes: ['M3U 播放列表：优先按文件路径匹配'],
  }
}

function parsePls(src: string): ParsedPlaylist {
  const map = new Map<number, Record<string, string>>()
  for (const raw of src.split(/\r?\n/)) {
    const m = /^([A-Za-z]+)(\d+)\s*=\s*(.+)$/.exec(raw.trim())
    if (!m) continue
    const key = m[1].toLowerCase()
    const i = Number(m[2])
    const rec = map.get(i) ?? {}
    rec[key] = m[3].trim()
    map.set(i, rec)
  }
  const songs: ImportedSong[] = []
  for (const rec of map.values()) {
    if (!rec.file) continue
    const title = rec.title?.trim() || stripExt(rec.file)
    const artist = rec.artist?.trim() || ''
    songs.push({ title, artist, path: rec.file, raw: rec.file })
  }
  return { format: 'pls', name: null, songs: dedupe(songs), notes: ['PLS 播放列表：优先按文件路径匹配'] }
}

/* ---------- 纯文本 ---------- */

function parseLines(src: string): ParsedPlaylist {
  const songs: ImportedSong[] = []
  let skipped = 0
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^[#;]/.test(line)) continue          // 注释
    if (/^(歌单|播放列表|playlist|total)/i.test(line) && line.length < 12) { skipped++; continue }
    const s = parseLooseLine(line)
    if (s) songs.push(s)
    else skipped++
  }
  return {
    format: 'txt',
    name: null,
    songs: dedupe(songs),
    notes: skipped ? [`忽略了 ${skipped} 行无法识别的内容`] : [],
  }
}

/** 单行文本 → 歌曲：兼容「1. 歌名 - 歌手」「歌名<TAB>歌手」「歌名 — 歌手」 */
export function parseLooseLine(line: string): ImportedSong | null {
  let s = line.trim()
  if (!s) return null
  s = s.replace(/^\d+\s*[.、)．]\s*/, '')            // 去掉序号
  if (!s) return null
  const byTab = s.split('\t').map(x => x.trim()).filter(Boolean)
  if (byTab.length >= 2) return { title: byTab[0], artist: byTab[1], album: byTab[2], raw: line }
  if (s.includes('|')) {
    const parts = s.split('|').map(x => x.trim()).filter(Boolean)
    if (parts.length >= 2) return { title: parts[0], artist: parts[1], raw: line }
  }
  const split = splitArtistTitle(s)
  if (!split.title) return null
  return { ...split, raw: line }
}

/** 在 "A - B" 上判断哪半边是歌名：默认左歌名右歌手 */
function splitArtistTitle(s: string): { title: string; artist: string } {
  const m = /^(.{1,120}?)\s+[-–—－]{1,2}\s+(.{1,120})$/.exec(s)
  if (!m) return { title: s.trim(), artist: '' }
  return { title: m[1].trim(), artist: m[2].trim() }
}

function stripExt(p: string): string {
  return p.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '')
}

function dedupe(list: ImportedSong[]): ImportedSong[] {
  const seen = new Set<string>()
  const out: ImportedSong[] = []
  for (const s of list) {
    const key = normalizeText(s.title) + '|' + normalizeText(s.artist)
    if (!s.title || seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 匹配                                                                */
/* ------------------------------------------------------------------ */

export function normalizeText(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·•・.\-_'’"“”‘`~,，、!！?？:：;；/\\|&+*=<>《》「」]/g, '')
}

function normPath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

function bigrams(s: string): string[] {
  const out: string[] = []
  if (s.length <= 2) return s ? [s] : []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return out
}

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const map = new Map<string, number>()
  for (const g of a) map.set(g, (map.get(g) ?? 0) + 1)
  let hit = 0
  for (const g of b) {
    const c = map.get(g)
    if (c) { hit++; map.set(g, c - 1) }
  }
  return (2 * hit) / (a.length + b.length)
}

export function matchSongs(songs: ImportedSong[], library: LocalTrack[]): MatchOutcome {
  const byPath = new Map<string, LocalTrack>()
  const byTitle = new Map<string, LocalTrack[]>()
  const byPair = new Map<string, LocalTrack>()
  const gramIndex = new Map<string, Set<number>>()

  library.forEach((t, i) => {
    byPath.set(normPath(t.path), t)
    const nt = normalizeText(t.title)
    const na = normalizeText(t.artist)
    if (!nt) return
    if (!byTitle.has(nt)) byTitle.set(nt, [])
    byTitle.get(nt)!.push(t)
    if (na) byPair.set(nt + '|' + na, t)
    for (const g of new Set(bigrams(nt))) {
      if (!gramIndex.has(g)) gramIndex.set(g, new Set())
      gramIndex.get(g)!.add(i)
    }
  })

  const used = new Set<string>()
  const matched: SongMatch[] = []
  const unmatched: ImportedSong[] = []

  for (const song of songs) {
    const variants = buildVariants(song)
    let best: { track: LocalTrack; score: number } | null = null

    for (const v of variants) {
      // 1. 路径命中
      if (v.path) {
        const t = byPath.get(normPath(v.path))
        if (t) { best = { track: t, score: 1 }; break }
      }
      const nt = normalizeText(v.title)
      if (!nt) continue
      const na = normalizeText(v.artist)

      // 2. 标题 + 歌手全等
      if (na) {
        const t = byPair.get(nt + '|' + na)
        if (t) { best = { track: t, score: 1 }; break }
      }

      // 3. 标题全等
      const sameTitle = byTitle.get(nt)
      if (sameTitle?.length) {
        const pick = na
          ? sameTitle.find(t => normalizeText(t.artist).includes(na) || na.includes(normalizeText(t.artist))) ?? sameTitle[0]
          : sameTitle[0]
        best = { track: pick, score: na ? 0.95 : 0.9 }
        break
      }

      // 4. 标题包含（长度 ≥3 才认为可信，避免「风」这类短标题乱配）
      if (nt.length >= 3) {
        let hit: LocalTrack | null = null
        for (const [k, list] of byTitle) {
          if (k.length < 3) continue
          if (k.includes(nt) || nt.includes(k)) { hit = list[0]; break }
        }
        if (hit) { best = { track: hit, score: 0.78 }; break }
      }

      // 5. 二元组相似度（倒排索引取候选，避免全库比对）
      const qg = [...new Set(bigrams(nt))]
      const counter = new Map<number, number>()
      for (const g of qg) {
        for (const idx of gramIndex.get(g) ?? []) {
          counter.set(idx, (counter.get(idx) ?? 0) + 1)
        }
      }
      let candBest = { i: -1, score: 0 }
      for (const [i, hitCount] of counter) {
        if (hitCount < Math.min(2, qg.length)) continue
        const t = library[i]
        const s = dice(qg, bigrams(normalizeText(t.title)))
        const bonus = na && normalizeText(t.artist).includes(na) ? 0.12 : 0
        const score = Math.min(0.88, s * 0.86 + bonus)
        if (score > candBest.score) candBest = { i, score }
      }
      if (candBest.i >= 0 && candBest.score > (best?.score ?? 0)) {
        best = { track: library[candBest.i], score: candBest.score }
      }
    }

    if (best && best.score >= 0.6 && !used.has(best.track.id)) {
      used.add(best.track.id)
      matched.push({ song, track: best.track, score: best.score })
    } else {
      unmatched.push(song)
    }
  }

  return { matched, unmatched }
}

/** 同一首歌可能有两种「歌名/歌手」顺序，都试一遍 */
function buildVariants(song: ImportedSong): Array<{ title: string; artist: string; path?: string }> {
  const list: Array<{ title: string; artist: string; path?: string }> = [
    { title: song.title, artist: song.artist, path: song.path },
  ]
  if (song.artist && song.title) {
    list.push({ title: song.artist, artist: song.title, path: song.path })
  }
  return list
}
