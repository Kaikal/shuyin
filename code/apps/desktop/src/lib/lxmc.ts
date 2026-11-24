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

/**
 * 封面地址归一化：`http://` 一律升到 `https://`。
 *
 * 洛雪导出的是平台的原始 `picUrl`，酷狗 / 酷我有一部分到今天还是明文 http。
 * 安卓 WebView 放行明文，iPhone 的 ATS 默认拦掉——同一个歌单在安卓上封面
 * 正常、在 iPhone 上一片空白（用户 2026-11-23：「导入歌单的专辑封面加载不出来」）。
 * 网易云 / QQ / 酷狗 / 酷我的图片 CDN 都同时支持 https，就地升级最省事；
 * Info.plist 里另有一层 `NSAllowsArbitraryLoadsInWebContent` 兜住音源脚本
 * 自己返回的 http 图。
 */
function httpsImg(v: unknown): string | undefined {
  const s = String(v ?? '').trim()
  if (!s) return undefined
  return s.startsWith('http://') ? 'https://' + s.slice('http://'.length) : s
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
    img: httpsImg(meta.picUrl),
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

/**
 * 按「是不是压缩包」自己选路：gzip 就解压，否则当纯文本 JSON 读。
 *
 * 为什么不能只认 gzip：洛雪不同版本导出的 `.lxmc` 形态不一样——
 * v2 是 gzip 容器，但也有人（以及部分第三方工具）直接存成明文 JSON，
 * 文件名还叫 `.lxmc`。以前 `isLxmcBuffer` 一判死就弹「这个 .lxmc 打不开」，
 * 安卓上「音源能导、洛雪歌单导不进来」正是这个（2026-11-24 反馈）。
 */
export async function parseLxAny(input: Uint8Array): Promise<LxPlaylist[]> {
  if (isLxmcBuffer(input)) {
    const lists = await parseLxmc(input)
    if (lists.length) return lists
    /* gzip 解压成功但结构不认识：继续按明文再试一次（有些工具会压两层/带 BOM） */
  }
  return parseLxText(decodeText(input))
}

/** 字节 → 文本：优先 UTF-8（洛雪就是 UTF-8），带 BOM 时去掉 */
export function decodeText(input: Uint8Array): string {
  let s = ''
  try {
    s = new TextDecoder('utf-8').decode(input)
  } catch {
    s = String.fromCharCode(...Array.from(input.slice(0, 4096)))
  }
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** 已解码的文本 → 歌单列表（空数组 = 不是洛雪歌单） */
export function parseLxText(text: string): LxPlaylist[] {
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
