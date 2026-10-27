/**
 * 酷我（kw）
 *
 * 用的是老的 `search.kuwo.cn/r.s` 接口：它返回的是 **JS 字面量**（单引号、未加引号的 key、
 * `&nbsp;` 与 `\u0026` 混在字段里），必须走 `lenientJson` + `clean`。
 * 新版 `www.kuwo.cn/api/www/...` 需要 csrf cookie，Node/Rust 侧拿不到，不要用。
 *
 * **歌单详情走 `nplserver.kuwo.cn/pl.svc`（2026-10 修正）**：
 *   之前记的是「只回标题、`musiclist` 恒空」，那是**参数没给全**——
 *   缺 `keyset=pl2012&identity=kuwo&pcmp4=1&vipver=…&newver=1` 时服务端确实只给标题；
 *   补齐后一次能拿整份歌单（实测 121/121 首）。所以酷我歌单现在可以点进去。
 *
 * **热门歌单走 `wapi.kuwo.cn`**：`www.kuwo.cn/api/pc/…` 会 302 到需要 csrf cookie 的地址，
 * 老域名同样给 `total`，翻页够用。
 *
 * **评论走老的 `comment.kuwo.cn/com.s`**（2026-10 实测，免签名、免 cookie）：
 *   · 最新 `type=get_comment`，热门 `type=get_rec_comment`，`sid` 就是 rid；
 *   · 一页给 `total` / `totalPage`，分页按 1 起；
 *   · 没有楼中楼（列表里连「回复数」字段都没有），所以不实现 `getReplies`；
 *   · `msg` 里的时间是北京时间字符串，正文偶尔带 `<img>`，都交给公共工具处理。
 */
import {
  b64decodeUtf8, clean, cnTimeToSec, commentText, emojiCode, getJson, getText, imageUrlsOf, lrcTime,
  lenientJson, toSeconds,
} from '../http'
import { asRankId, isRankId, rankRawId } from '../types'
import type {
  CommentPage, HotPlaylistItem, HotPlaylistResult, HttpClient, PlatformApi, PlaylistDetail,
  PlaylistSearchItem, PlaylistSearchResult, RankListItem, RankListResult, SearchResult, SearchSong,
  SongComment,
} from '../types'

const HEADERS: Record<string, string> = {
  Referer: 'http://www.kuwo.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

const SEARCH = 'http://search.kuwo.cn/r.s'

/** 出网层注入的账号 cookie（未登录时是空串） */
const cookieFor = (client: HttpClient, url: string): string => client.cookieFor?.(url) ?? ''

/**
 * 从登录 cookie 里挖出 uid。
 *
 * 酷我登录后 cookie 里通常直接有 `userid=123456`；拿不到时退到 `kw_token`——
 * 它是个 JWT，payload 里带着 uid。**不猜**：两处都没有就返回空串，
 * 上层据此不显示「我的歌单」，而不是拿 0 去请求一份别人的歌单。
 */
function uidOfCookie(raw?: string): string {
  if (!raw) return ''
  const jar = new Map<string, string>()
  for (const seg of raw.split(';')) {
    const s = seg.trim()
    const i = s.indexOf('=')
    if (i > 0) jar.set(s.slice(0, i).trim(), s.slice(i + 1).trim())
  }
  for (const k of ['userid', 'uid', 'kw_userid', 'userId']) {
    const v = jar.get(k)
    if (v && /^\d+$/.test(v) && v !== '0') return v
  }
  for (const k of ['kw_token', 'token']) {
    const tok = jar.get(k)
    if (!tok || tok.split('.').length !== 3) continue
    try {
      const part = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = part + '='.repeat((4 - (part.length % 4)) % 4)
      const p = JSON.parse(b64decodeUtf8(padded))
      const v = p?.uid ?? p?.userId ?? p?.userid
      if (v && /^\d+$/.test(String(v))) return String(v)
    } catch { /* token 不是 JWT 就跳过 */ }
  }
  return ''
}

/** `MUSIC_91637031` → `91637031` */
const ridOf = (s: any) => String(s?.MUSICRID ?? s?.DC_TARGETID ?? '').replace(/^MUSIC_/, '')

/**
 * 图片地址归一。
 *
 * 别处都是「http 一律升 https」，酷我不能这么做：它有一部分图挂在
 * `*.kwcdn.kuwo.cn` 上，那个域名**没有自己的证书**（握手只给 qcloud 的共享证书，
 * 任何 https 请求都是 `ERR_CERT_ALTNAME_INVALID`），升上去就是整片空白。
 * 主窗口本身跑在 `http://tauri.localhost`，http 图片不属于混合内容，能直连，
 * 所以这些图保持原样最好。
 */
const imgUrl = (u: unknown): string | undefined => {
  if (!u) return undefined
  const s = String(u)
  if (/^http:\/\/[^/]*kwcdn\.kuwo\.cn/i.test(s)) return s
  return s.replace(/^http:\/\//, 'https://')
}

function coverOf(s: any): string | undefined {
  // r.s 搜索接口的专辑封面上游基本是空的（web_albumpic_short 常为空串），
  // 退到歌手图 web_artistpic_short —— 页面至少不是一块空白，总比没有强。
  const short = s?.web_albumpic_short
  if (short) return `https://img1.kuwo.cn/star/albumcover/${short}`
  const path = s?.PICPATH
  if (path) return `https://img2.kuwo.cn/star/albumcover/${path}`
  const artist = s?.web_artistpic_short
  if (artist) return `https://img2.kuwo.cn/star/artist/${String(artist).replace(/^\//, '')}`
  return undefined
}

/**
 * 这首歌真实可用的档位。
 *
 * 酷我 r.s 已经算好了，直接给 `FORMATS` 字段（`AAC48|ALFLAC|MP3128|MP3H|…`）。
 * 必须按 `|` 拆开再精确比较：`AL` 是「无损」的旧名，而它又是 `ALFLAC` 的前缀，
 * 用 `includes('AL')` 会把每一首都判成有无损。
 */
function qualitiesOf(s: any): string[] | undefined {
  const raw = String(s?.FORMATS ?? '')
  if (!raw) return undefined
  const set = new Set(raw.split('|').map(x => x.trim().toUpperCase()))
  const q: string[] = []
  if (set.has('MP3128')) q.push('128k')
  if (set.has('MP3H')) q.push('192k')
  if (set.has('MP3SQ') || set.has('MP3L')) q.push('320k')
  if (set.has('ALFLAC') || set.has('AL') || set.has('FLAC')) q.push('flac')
  if (set.has('HIFI') || set.has('DTSX')) q.push('flac24bit')
  return q.length ? q : undefined
}

function normalize(s: any): SearchSong {
  const rid = ridOf(s)
  return {
    id: rid,
    // 酷我的播放链接靠 rid；音源里 K×H 认 songmid/songId/rid，长青只认 songmid
    songmid: rid,
    source: 'kw',
    name: clean(s.SONGNAME ?? s.NAME),
    singer: clean(s.ARTIST ?? s.AARTIST).split('&').map(x => x.trim()).filter(Boolean),
    albumName: clean(s.ALBUM),
    albumId: s.ALBUMID != null ? String(s.ALBUMID) : undefined,
    interval: toSeconds(s.DURATION),
    img: coverOf(s),
    qualities: qualitiesOf(s),
    // 原始对象 + 归一化 id：音源脚本要从 musicInfo 里直接读 songmid
    raw: { ...s, songmid: rid, songId: rid, rid },
  }
}

/**
 * 歌单详情里的一首歌 → SearchSong。
 *
 * 字段名和搜索接口完全不是一套：详情是小写的 `name / artist / album / duration /
 * albumpic / formats / albumid`，而搜索是大写的 `SONGNAME / ARTIST / …`。
 * 所以 `qualitiesOf` 要喂一个 `FORMATS` 名字的对象，别直接传。
 */
function normalizeDetailSong(s: any): SearchSong {
  const rid = String(s?.id ?? s?.rid ?? '')
  const pic = String(s?.albumpic ?? s?.musicPic ?? '')
  return {
    id: rid,
    songmid: rid,
    source: 'kw',
    name: clean(s?.name ?? s?.songname),
    singer: clean(s?.artist ?? s?.AARTIST).split(/[&、]/).map((x: string) => x.trim()).filter(Boolean),
    albumName: clean(s?.album ?? s?.albumname),
    albumId: s?.albumid != null ? String(s.albumid) : undefined,
    interval: Number(s?.duration ?? 0) || 0,
    img: pic
      ? pic.replace(/^http:\/\//, 'https://').replace(/\/120\//, '/500/')
      : undefined,
    qualities: qualitiesOf({ FORMATS: s?.formats }),
    raw: { ...s, songmid: rid, songId: rid, rid },
  }
}

/* ------------------------------------------------------------------ */
/* 评论                                                                */
/* ------------------------------------------------------------------ */

const CMT = 'http://comment.kuwo.cn/com.s'
const CMT_HEADERS: Record<string, string> = { ...HEADERS, Referer: 'https://www.kuwo.cn/' }

/** 一条酷我评论 → 统一模型 */
function kwCommentOf(c: any): SongComment {
  const raw = String(c?.msg ?? '')
  const imgs = imageUrlsOf(raw)
  return {
    id: String(c?.id ?? ''),
    user: clean(c?.u_name) || '匿名用户',
    avatar: c?.u_pic ? String(c.u_pic).replace(/^http:\/\//, 'https://') : undefined,
    // 正文里若真的塞了 <img>，换成占位，别把 HTML 直接打印到界面上
    content: emojiCode(commentText(imgs.length ? raw.replace(/<img[^>]*>/gi, ' [图片] ') : raw)),
    images: imgs,
    time: cnTimeToSec(c?.time),
    likes: Number(c?.like_num ?? 0) || 0,
    raw: c,
  }
}

/**
 * 榜单详情：`kbangserver.kuwo.cn/ksong.s`。
 *
 * 走这条路而不是 `pl.svc`：榜单的 `sourceid` 当 `pid` 传给 `pl.svc` 是**空的**
 * （实测 `total: 0`），它只认歌单 id；`wapi.kuwo.cn/api/pc/bang/song` 那条
 * 则直接 404。`ksong.s` 是网页版排行榜用的老接口，免签名，`pn` **从 0 起**、
 * `rn` 是每页条数，`num` 是榜内总曲目数（热歌榜 300 首）。
 *
 * 曲目字段和 `pl.svc` 的详情是同一套小写命名（`name/artist/album/duration/
 * formats`），所以 `normalizeDetailSong` 直接复用——只是这里**没有 `albumpic`**，
 * 单曲封面会是空的，列表行本来也不显示封面，不补。
 */
async function rankSongs(
  client: HttpClient, sourceId: string, page: number, limit: number,
): Promise<PlaylistDetail> {
  const pn = Math.max(0, Math.floor(page) - 1)
  const j = await getJson(client,
    `http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=${pn}&rn=${limit}`
    + `&type=bang&data=content&id=${encodeURIComponent(sourceId)}&show_copyright_off=0`
    + '&pcmp4=1&isbang=1&vipver=MUSIC_9.1.1.2_W2&newver=1',
    { headers: { ...HEADERS, Referer: 'http://www.kuwo.cn/' } })
  const raw = j?.musiclist
  if (!Array.isArray(raw)) throw new Error('这个榜取不到内容，稍后再试')
  const songs: SearchSong[] = raw.map(normalizeDetailSong)
  const total = Number(j?.num ?? 0) || songs.length
  /*
   * `pic` 是 60×60 的榜单缩略图（`.../BangPic/small/…`，实测只有 2KB），
   * 撑到详情页那块方形封面上会糊成一片马赛克。这种小图干脆不返回，
   * 让调用方用它手上那张大图（广场的榜单卡有）；实在没有就走文字占位。
   */
  const pic = String(j?.pic ?? '')
  const cover = pic && !/\/BangPic\/small\//.test(pic)
    ? pic.replace(/^http:\/\//, 'https://')
    : undefined
  return {
    id: asRankId(sourceId),
    source: 'kw',
    name: clean(j?.name),
    cover,
    songCount: total,
    songs,
    total,
    hasMore: pn * limit + songs.length < total,
  }
}

export function createKwApi(client: HttpClient): PlatformApi {
  return {
    source: 'kw',
    supportsSearch: true,
    supportsPlaylistSearch: true,
    supportsPlaylistDetail: true,
    supportsLyric: true,

    async search(keyword, page, limit): Promise<SearchResult> {
      const url = `${SEARCH}?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013`
        + `&client=kt&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8`
      // 这个接口 Content-Type 是 text/plain，回的也不是合法 JSON，
      // 所以只能 getText + lenientJson（getJson 会在这里抛「响应不是 JSON」）
      const j = lenientJson(await getText(client, url, { headers: HEADERS }))
      const list: SearchSong[] = (j?.abslist ?? []).map(normalize)
      return { list, total: Number(j?.TOTAL ?? list.length) || list.length, source: 'kw' }
    },

    async searchPlaylist(keyword, page, limit): Promise<PlaylistSearchResult> {
      const url = `${SEARCH}?all=${encodeURIComponent(keyword)}&ft=playlist&itemset=web_2013`
        + `&client=kt&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8`
      const j = lenientJson(await getText(client, url, { headers: HEADERS }))
      const list: PlaylistSearchItem[] = (j?.abslist ?? []).map((p: any) => ({
        id: String(p.DC_TARGETID ?? p.playlistid ?? ''),
        source: 'kw' as const,
        name: clean(p.name),
        cover: imgUrl(p.pic || p.hts_pic),
        creator: clean(p.nickname),
        songCount: Number(p.songnum ?? 0),
        playCount: Number(p.playcnt ?? 0),
        detailSupported: true,
      }))
      return { list, total: Number(j?.TOTAL ?? list.length) || list.length, source: 'kw' }
    },

    /**
     * 热门歌单：`wapi.kuwo.cn` 的「热门歌单」列表（`order=hot`）。
     *
     * `www.kuwo.cn/api/pc/...` 那条会 302 到需要 csrf cookie 的地址，
     * 所以只能用 `wapi` 这个老域名；它同样给 `total`（1753 这种量级），
     * 翻页按它判断，别用「这页给满了就还有」——最后一页经常正好给满。
     */
    async getHotPlaylists(page, limit): Promise<HotPlaylistResult> {
      const n = Math.min(Math.max(limit || 24, 1), 30)
      const p = Math.max(1, page)
      const j = await getJson(client,
        `http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?pn=${p}&rn=${n}&order=hot`,
        { headers: { ...HEADERS, Referer: 'https://www.kuwo.cn/' } })
      const box = j?.data ?? {}
      const list: HotPlaylistItem[] = (box.data ?? []).map((x: any) => ({
        id: String(x.id ?? ''),
        source: 'kw' as const,
        name: clean(x.name),
        cover: imgUrl(x.img),
        creator: clean(x.uname),
        songCount: Number(x.total ?? 0),
        playCount: Number(x.listencnt ?? 0),
        detailSupported: true,
      }))
      const total = Number(box.total ?? 0)
      return { list, hasMore: total ? p * n < total : list.length >= n, source: 'kw' }
    },

    /**
     * 全部排行榜：`wapi.kuwo.cn/api/pc/bang/list`。
     *
     * 它是**树**：根下面五组（官方 / 特色 / 场景 / 语言 / 全球），组下面才是榜单。
     * 分组名要留着——「酷我热歌榜」「酷我华语榜」光看名字分不清是官方榜还是语言榜，
     * 卡片上有个小组名会清楚很多。榜单自己的 `id` 是页面用的，取歌要用 `sourceid`。
     *
     * 封面取 `pic2`（zimg 上的方形海报，带榜名和第一名歌手），**不要 `pic`**：
     * `pic` 是白字**透明** PNG（酷我自己铺在色块上用），放到深色卡片上等于全白看不见。
     */
    async getRanklists(): Promise<RankListResult> {
      const j = await getJson(client, 'http://wapi.kuwo.cn/api/pc/bang/list', {
        headers: { ...HEADERS, Referer: 'http://www.kuwo.cn/' },
      })
      const list: RankListItem[] = []
      for (const g of j?.child ?? []) {
        const group = clean(g?.disname ?? g?.name) || undefined
        for (const b of g?.child ?? []) {
          if (b?.sourceid == null) continue
          list.push({
            id: asRankId(b.sourceid),
            source: 'kw' as const,
            name: clean(b.name ?? b.disname),
            cover: imgUrl(b.pic2 ?? b.pic5 ?? b.pic),
            intro: clean(b.intro) || undefined,
            group,
            playCount: Number(b.listen ?? 0) || undefined,
          })
        }
      }
      return { list, source: 'kw' }
    },

    /**
     * 歌单详情：`nplserver.kuwo.cn/pl.svc`（老接口，免签名）。
     *
     * 之前这里写的是「musiclist 恒空、酷我详情拿不到」——那是**参数不全**导致的：
     * 少了 `keyset=pl2012&identity=kuwo&pcmp4=1&vipver=…&newver=1` 这几项，
     * 服务端只回标题和总数，列表是空的。补齐之后一次能给整份歌单（实测 121/121 首）。
     * 所以 `supportsPlaylistDetail` 现在是 true，酷我的歌单卡可以点进去了。
     */
    /**
     * 我的歌单：`nplserver.kuwo.cn/pl.svc?op=getuserlist`（老接口，免签名、免 csrf）。
     *
     * 返回固定结构 `{total, plist:[{id,title,musicnum,pic,type,...}]}`；
     * 里面混着几条**系统歌单**（`PC_DEFAULT` / `MOBI_DEFAULT` / `MYFAVORITE`），
     * 未登录或 uid 不存在时它们的 `title` 是空串——按「title 非空且不是系统单」过滤。
     * 未登录（cookie 里挖不到 uid）直接返回 null：这一块是「我的」，
     * 没有账号就不该拿别人的歌单凑数。
     */
    async getUserPlaylists(): Promise<HotPlaylistResult | null> {
      const uid = uidOfCookie(cookieFor(client, 'http://www.kuwo.cn/'))
      if (!uid) return null
      const j = await getJson(client,
        `http://nplserver.kuwo.cn/pl.svc?op=getuserlist&uid=${uid}&pn=1&rn=50&encode=utf8`,
        { headers: HEADERS })
      const SYS = new Set(['PC_DEFAULT', 'MOBI_DEFAULT', 'MYFAVORITE'])
      const list: HotPlaylistItem[] = (j?.plist ?? [])
        .filter((x: any) => x?.id && !SYS.has(String(x.type ?? '')) && clean(x.title))
        .map((x: any) => ({
          id: String(x.id),
          source: 'kw' as const,
          name: clean(x.title),
          cover: imgUrl(x.pic),
          songCount: Number(x.musicnum ?? 0),
          detailSupported: true,
        }))
      // 一条都没有也返回 null：「已登录但还没有歌单」由 UI 的空态处理，
      // 不要在这里伪造一条假歌单
      return list.length ? { list, hasMore: false, source: 'kw' } : null
    },

    async getPlaylistDetail(id, page = 1, limit = 200): Promise<PlaylistDetail> {
      if (isRankId(id)) return rankSongs(client, rankRawId(id), page, limit)
      const pn = Math.max(0, Math.floor(page) - 1)
      const j = await getJson(client,
        `http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${encodeURIComponent(id)}&pn=${pn}&rn=${limit}`
        + `&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.1.1.2_W2&newver=1`,
        { headers: HEADERS })
      const raw = j?.musiclist
      if (!Array.isArray(raw)) throw new Error('这个歌单取不到内容（可能已被删除或设为私密）')
      const songs: SearchSong[] = raw.map(normalizeDetailSong)
      const total = Number(j?.total ?? songs.length) || songs.length
      const pic = String(j?.pic ?? '')
      return {
        id: String(j?.id ?? id),
        source: 'kw',
        name: clean(j?.title),
        // 详情给的 `pic` 是 _150 的缩略图，换成 _500 才看着不糊
        cover: imgUrl(pic)?.replace(/_150\./, '_500.'),
        songCount: total,
        songs,
        total,
        hasMore: pn * limit + songs.length < total,
      }
    },

    /**
     * 评论：最新 + 热门各打一次（只有第一页要热门）。
     *
     * 热评和最新会重叠，这里先按 id 把重叠的从最新里剔掉，UI 那边还有一层兜底。
     * 分页用平台给的 `totalPage`——它比「本地算有没有下一页」准。
     */
    async getComments(song, page = 1, limit = 20): Promise<CommentPage> {
      const sid = String(song.songmid || song.id || '')
      if (!sid) throw new Error('这条酷我记录没有 rid，取不到评论')
      const base = `sid=${encodeURIComponent(sid)}&uid=0&prod=newWeb&digest=15&f=web`
      const [j, hotJ] = await Promise.all([
        getJson(client, `${CMT}?type=get_comment&${base}&page=${page}&rows=${limit}`, { headers: CMT_HEADERS }),
        page === 1
          ? getJson(client, `${CMT}?type=get_rec_comment&${base}&page=1&rows=10`, { headers: CMT_HEADERS })
            .catch(() => null)
          : Promise.resolve(null),
      ])
      const rows: any[] = Array.isArray(j?.rows) ? j.rows : []
      const hot: SongComment[] = (Array.isArray(hotJ?.rows) ? hotJ.rows : []).map(kwCommentOf)
      const hotIds = new Set(hot.map(c => c.id))
      const list = rows.map(kwCommentOf).filter(c => !(page === 1 && hotIds.has(c.id)))
      const total = Number(j?.total ?? 0) || rows.length
      const totalPage = Number(j?.totalPage ?? 0)
      return {
        list,
        total,
        hasMore: totalPage ? page < totalPage : (page - 1) * limit + rows.length < total,
        hot,
      }
    },

    /**
     * 歌词：`songinfoandlrc` 回的是结构化行（`{lineLyric, time}`），
     * 不是 LRC 文本，得自己拼时间轴。`time` 是秒、字符串。
     */
    async getLyric(songmid) {
      const j = await getJson(client,
        `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(songmid)}`,
        { headers: { ...HEADERS, Referer: 'https://www.kuwo.cn/' } })
      const rows: any[] = j?.data?.lrclist ?? []
      const lyric = rows
        .filter(r => r && r.time != null)
        .map(r => `${lrcTime(Number(r.time))}${clean(r.lineLyric)}`)
        .join('\n')
      return { lyric }
    },
  }
}
