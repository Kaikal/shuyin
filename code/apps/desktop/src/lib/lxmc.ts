/**
 * 洛雪音乐（LX Music）歌单文件兼容层。
 *
 * `.lxmc` 不是加密格式——它就是 **gzip 压缩的 JSON**（文件头 `1f 8b`）。
 * 里面是 `{"type":"playList_v2","data":[{id,name,list:[…]}]}`，
 * 每首歌带 `source`（tx/wy/kg/kw）+ `meta.songId` + 完整专辑信息，
 * 所以导入后**不需要模糊匹配**，直接转成在线曲目就能播。
 *
 * 老版本（playList，不带 _v2）是 `{"name":…, "list": [...]}` 的平铺结构，
 * 字段一样，一并兼容。
 *
 * 为什么要单独一个模块而不是塞进 playlistImport：那个模块的输出是
 * `ImportedSong`（只够「去曲库里找」），而这里能拿到平台直连 id，
 * 输出的是可直接播放的在线曲目——数据形态和下游路径都不同。
 */
import type { PlatformSource, SearchSong } from '@shuyin/lx-provider'
import type { LocalTrack } from '@shuyin/core'
import { toLocalTracks } from './online'

/** 洛雪的 source 值 → 本应用的 PlatformSource（两边本来就是同一套约定） */
const SOURCES: Record<string, PlatformSource> = {
  tx: 'tx', wy: 'wy', kg: 'kg', kw: 'kw', mg: 'mg',
}

/** "04:29" → 269 秒；老格式里有 "269" 这种纯秒数，也兜一下 */
function parseInterval(v: unknown): number {
  if (typeof v === 'number') return Math.max(0, Math.round(v))
  const s = String(v ?? '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s)
  if (!m) return 0
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) : 0)
}

export interface LxPlaylist {
  name: string
  songs: SearchSong[]
  tracks: LocalTrack[]
}

/** 二进制是不是 gzip（lxmc 的嗅探：认文件头而不是扩展名，别的格式导出也可能叫这名） */
export function isLxmcBuffer(buf: Uint8Array): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
}

function songOf(item: any): SearchSong | null {
  const src = SOURCES[String(item?.source ?? '')]
  const meta = item?.meta ?? {}
  const songId = String(meta.songId ?? item?.songmid ?? '').trim()
  if (!src || !songId) return null
  const singers = String(item?.singer ?? '').split(/[,、/]\s*/).map(s => s.trim()).filter(Boolean)
  return {
    id: songId,
    songmid: songId,
    source: src,
    name: String(item?.name ?? '').trim(),
    singer: singers.length ? singers : ['未知歌手'],
    albumName: String(meta.albumName ?? item?.albumName ?? ''),
    albumId: meta.albumId ?? meta.albumMid,
    interval: parseInterval(item?.interval),
    img: meta.picUrl || undefined,
    qualities: Array.isArray(meta.qualitys)
      ? meta.qualitys.map((q: any) => String(q?.type ?? '')).filter(Boolean)
      : undefined,
    /* 洛雪导出保留了 strMediaMid / 数字 id 等原始字段，音源脚本取链要用 */
    raw: { ...meta, songId, songmid: songId },
  }
}

/**
 * 解析 lxmc：gzip 解压（浏览器原生 DecompressionStream，安卓 WebView 也有）
 * → JSON → 每张歌单转成可直接播放的在线曲目。
 * 解不开（不是 gzip / 不是 JSON / 没有歌）返回空数组，调用方按「格式不认识」提示。
 */
export async function parseLxmc(input: Uint8Array): Promise<LxPlaylist[]> {
  let text: string
  try {
    const buf = input.slice().buffer as ArrayBuffer
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
    text = await new Response(stream).text()
  } catch {
    return []
  }
  return parseLxmcText(text)
}

/** 已解压的 JSON 文本 → 歌单列表（v2 的 data 数组 / v1 的平铺对象都认） */
function parseLxmcText(text: string): LxPlaylist[] {
  let root: any
  try {
    root = JSON.parse(text)
  } catch {
    return []
  }
  const groups: any[] = root?.type === 'playList_v2'
    ? (Array.isArray(root.data) ? root.data : [])
    : Array.isArray(root?.list) ? [root] : []
  const out: LxPlaylist[] = []
  for (const g of groups) {
    const songs: SearchSong[] = (Array.isArray(g?.list) ? g.list : [])
      .map((it: unknown) => songOf(it))
      .filter((s: SearchSong | null): s is SearchSong => !!s)
    if (!songs.length) continue
    out.push({
      name: String(g?.name ?? '导入的歌单').trim() || '导入的歌单',
      songs,
      tracks: toLocalTracks(songs),
    })
  }
  return out
}
