/**
 * 酷狗（kg）
 *
 * 搜索走 `songsearch.kugou.com/song_search_v2`，字段是 `FileHash` / `SongName` /
 * `SingerName` / `Duration`。封面 `Image` 里带 `{size}` 占位，要替换。
 *
 * **歌单搜索/详情走 `mobiles.kugou.com`**（2026-10 实测）：
 *   · 早期这里的结论是「酷狗不支持歌单搜索」，那是因为只试了 `mobilecdn` / `msearchcdn`
 *     两个域名——它们在本机解析出 IPv6 优先，请求直接连不上（curl `http=000`），
 *     于是被当成了「接口没了」。`mobiles.kugou.com` 同一个 v3 接口是通的：
 *     `api/v3/search/special`（歌单搜索）、`api/v3/special/song`（歌单详情）。
 *   · 详情里的 `filename` 是「歌手 - 歌名」拼串，要拆；`hash` 就是播放用的 hash。
 *
 * 音质：搜索结果里同时给了 `FileHash`(128k) / `HQFileHash`(320k) /
 * `SQFileHash`(无损) / `SuperFileHash`(Hi-Res)，**哪一档有 hash 就是真有**。
 * 这比「音源声明支持什么」准得多——很多歌确实没有无损。
 *
 * **评论走手机站 `mcomment.kugou.com/index.php`**（2026-10 实测，免签名）：
 *   · 列表 `r=commentsv2/getCommentWithLike&code=<固定码>&extdata=<hash>&p=&pagesize=`
 *   · 楼层 `r=commentsv2/getReplyWithLike&code=…&childrenid=<special_child_id>&tid=<评论id>`
 *   · `code` 是网页端写死的一串客户端码，不是账号凭据，换歌不用变。
 *   · 首屏只给 `reply_num`（回复数量），**不给回复内容**，要点开再取一次。
 */
import {
  b64decodeUtf8, clean, cnTimeToSec, commentText, emojiCode, getJson, imageUrlsOf, toSeconds,
} from '../http'
import { md5Hex } from '../md5'
import { asRankId, isRankId, rankRawId } from '../types'
import type {
  CommentPage, HotPlaylistItem, HotPlaylistResult, HttpClient, PlatformApi, PlaylistDetail,
  PlaylistSearchItem, PlaylistSearchResult, RankListItem, RankListResult, SearchResult, SearchSong,
  SongComment,
} from '../types'

const HEADERS: Record<string, string> = {
  Referer: 'https://www.kugou.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

/** 封面 `{size}` 占位 → 真尺寸 */
const cover = (u: any, size = 400) =>
  u ? String(u).replace('{size}', String(size)).replace(/^http:\/\//, 'https://') : undefined

/* ------------------------------------------------------------------ */
/* 每日推荐（App 首页那份「每日 30 首」）                              */
/* ------------------------------------------------------------------ */

/**
 * 酷狗网关的安卓签名盐：客户端内置的固定串，不是账号凭据。
 *
 * 签名算法（App 每个请求都这样）：把参数按 key 排序拼成 `k=v` 连起来，
 * 前后各加一次盐取 MD5；POST 还要把请求体原文（本接口为空串）拼在中间。
 * 少了 `signature` 网关只回 `error_code:200103`，看着像「接口没了」。
 */
const APP_SALT = 'OIlwieks28dk2k092lksi2UIkp'

/** 安卓客户端 UA：酷狗网关按 UA 判端，桌面 UA 会被当成非法来源 */
const APP_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'

/** 网关路由头：不带它 `gateway.kugou.com` 一律 502（2026-10 实测） */
const EVERYDAY_ROUTER = 'everydayrec.service.kugou.com'

/** cookie 整串 → 键值表 */
function cookieBag(s: string): Map<string, string> {
  const bag = new Map<string, string>()
  for (const part of s.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) bag.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  return bag
}

/**
 * 登录凭证：酷狗把它整串塞在 `KuGoo` 里（`uid=…&token=…`，值 URL 编码过），
 * 不是单独的同名 cookie。拿不到就是未登录，此时网关给的是公共日推。
 */
function loginOf(bag: Map<string, string>): { uid?: string; token?: string } {
  const raw = bag.get('KuGoo') ?? ''
  let text = raw
  try { text = decodeURIComponent(raw) } catch { /* 不是编码过的就原样用 */ }
  const kv = new Map<string, string>()
  for (const part of text.split('&')) {
    const i = part.indexOf('=')
    if (i > 0) kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim())
  }
  return {
    uid: kv.get('uid') || kv.get('userid') || bag.get('userid'),
    token: kv.get('token') || bag.get('token'),
  }
}

/** 参数 → 带 `signature` 的字符串表（`undefined` 的项直接不参与，别变成 "undefined"） */
function signParams(p: Record<string, string | number | undefined>, data = ''): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(p)) if (v !== undefined) flat[k] = String(v)
  const str = Object.keys(flat).sort().map(k => `${k}=${flat[k]}`).join('')
  return { ...flat, signature: md5Hex(`${APP_SALT}${str}${data}${APP_SALT}`) }
}

/** 设备参数：登录与否都用同一套，`mid` 固定（换掉等于换设备，推荐会重算） */
function deviceParams(client: HttpClient): Record<string, string | number | undefined> {
  const bag = cookieBag(client.cookieFor?.('https://www.kugou.com/') ?? '')
  const { uid, token } = loginOf(bag)
  return {
    dfid: bag.get('dfid') || '-',
    mid: bag.get('mid') || '1600000000000000',
    uuid: bag.get('uuid') || '-',
    appid: 1005,
    clientver: 20489,
    clienttime: String(Math.floor(Date.now() / 1000)),
    userid: uid,
    token,
  }
}

/**
 * 走网关的安卓接口（网关靠 `x-router` 分流，不带就是 502）。
 *
 * `body` 是**发出去的原文**，同时参与签名——所以调用方必须先 JSON.stringify
 * 一次，再把同一个字符串传进来，不能一边传对象、一边传串。
 */
async function gatewayPost(
  client: HttpClient,
  router: string,
  path: string,
  params: Record<string, string | number | undefined>,
  body = '',
): Promise<any> {
  const q = signParams(params, body)
  const res = await client.request({
    url: `https://gateway.kugou.com${path}?${new URLSearchParams(q).toString()}`,
    method: 'POST',
    responseType: 'json',
    timeout: 10_000,
    headers: {
      'User-Agent': APP_UA,
      'Content-Type': 'application/json',
      dfid: q.dfid,
      mid: q.mid,
      clienttime: q.clienttime,
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': '1',
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      'x-router': router,
    },
    body,
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`酷狗接口没响应（${res.status}）`)
  const j = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
  if (Number(j?.error_code ?? 0) !== 0) {
    throw new Error(clean(j?.msg) || clean(j?.error) || `酷狗接口报错（${j?.error_code}）`)
  }
  return j
}

/** 日推里的一首歌 → SearchSong（字段名和搜索结果完全不同，和歌单详情接近） */
function normalizeEveryday(s: any): SearchSong {
  const hash = String(s.hash ?? s.hash_128 ?? '')
  const q: string[] = []
  if (s.hash_128 || Number(s.filesize_128 ?? 0) > 0) q.push('128k')
  if (s.hash_320 || Number(s.filesize_320 ?? 0) > 0) q.push('320k')
  if (s.hash_flac || Number(s.filesize_flac ?? 0) > 0) q.push('flac')
  const rawName = clean(s.filename ?? s.songname)
  // `filename` = 「歌手 - 歌名」，只按第一个 " - " 拆（歌名自己也可能带连字符）
  const cut = rawName.indexOf(' - ')
  const artist = cut > 0 ? rawName.slice(0, cut).trim() : clean(s.author_name ?? '')
  const name = cut > 0 ? rawName.slice(cut + 3).trim() : rawName
  const singers: string[] = Array.isArray(s.singerinfo)
    ? s.singerinfo.map((x: any) => clean(x?.name)).filter(Boolean)
    : []
  // 这个接口的 `time_length` 是**秒**（歌单详情那边是毫秒），按量级兜一下更稳
  const len = Number(s.time_length ?? s.timelength_320 ?? 0) || 0
  return {
    id: hash,
    songmid: hash,
    source: 'kg',
    name,
    singer: singers.length ? singers : artist.split(/[&、,，]/).map(x => x.trim()).filter(Boolean),
    albumName: clean(s.album_name),
    albumId: s.album_id != null ? String(s.album_id) : undefined,
    interval: len > 10_000 ? Math.round(len / 1000) : Math.round(len),
    img: cover(s.sizable_cover ?? s.trans_param?.union_cover),
    qualities: q.length ? q : undefined,
    raw: { ...s, hash, songmid: hash, songId: hash },
  }
}

/**
 * 从搜索结果的几个 hash 字段推出「这首歌真实可用的档位」。
 *
 * 酷狗的分档：普通 `FileHash` = 128k，`HQFileHash` = 320k，
 * `SQFileHash` = 无损，`SuperFileHash` = Hi-Res。空串 / 缺失 = 没有这一档。
 */
function qualitiesOf(s: any): string[] {
  const q: string[] = []
  if (s?.FileHash) q.push('128k')
  if (s?.HQFileHash) q.push('320k')
  if (s?.SQFileHash) q.push('flac')
  if (s?.SuperFileHash) q.push('flac24bit')
  // 一个都没有（字段缺失）：别硬报「什么都不能播」，交给上层按音源声明处理
  return q
}

function normalize(s: any): SearchSong {
  const hash = String(s.FileHash ?? s.HQFileHash ?? '')
  const q = qualitiesOf(s)
  return {
    id: hash,
    // 酷狗靠 hash 取链；音源里 K×H 认 hash/FileHash，长青只认 hash
    songmid: hash,
    source: 'kg',
    name: clean(s.SongName),
    singer: clean(s.SingerName).split(/[&、]/).map(x => x.trim()).filter(Boolean),
    albumName: clean(s.AlbumName),
    albumId: s.AlbumID != null ? String(s.AlbumID) : undefined,
    interval: toSeconds(s.Duration),
    img: cover(s.Image),
    qualities: q.length ? q : undefined,
    raw: { ...s, hash, songmid: hash, songId: hash },
  }
}

/** 歌单详情里的一首歌 → SearchSong（字段名和搜索结果完全不同） */
function normalizeDetail(s: any): SearchSong {
  const hash = String(s.hash ?? s.hash_128 ?? '')
  const rawName = clean(s.filename ?? s.songname ?? s.song_name)
  // `filename` = 「歌手 - 歌名」，按第一个 " - " 拆（歌名里也可能有连字符，只拆一次）
  const cut = rawName.indexOf(' - ')
  const artist = cut > 0 ? rawName.slice(0, cut).trim() : ''
  const name = cut > 0 ? rawName.slice(cut + 3).trim() : rawName
  const q: string[] = []
  if (hash) q.push('128k')
  if (s['320hash']) q.push('320k')
  if (s.sqhash) q.push('flac')
  if (s.superhash) q.push('flac24bit')
  // 详情接口里也会带 xxxfilesize，hash 缺失但 size>0 说明这一档其实存在
  if (!q.includes('320k') && Number(s['320filesize'] ?? 0) > 0) q.push('320k')
  if (!q.includes('flac') && Number(s.sqfilesize ?? 0) > 0) q.push('flac')
  return {
    id: hash,
    songmid: hash,
    source: 'kg',
    name,
    singer: artist ? artist.split(/[&、,，]/).map(x => x.trim()).filter(Boolean) : [],
    albumName: clean(s.album_name ?? s.albumname ?? ''),
    albumId: s.album_id != null ? String(s.album_id) : undefined,
    interval: Number(s.duration ?? s.timelen ?? 0) || 0,
    img: cover(s.album_img ?? s.album_sizable_cover ?? s.img ?? s.image),
    qualities: q.length ? q : undefined,
    raw: { ...s, hash, songmid: hash, songId: hash },
  }
}

/* ------------------------------------------------------------------ */
/* 评论                                                                */
/* ------------------------------------------------------------------ */

/** 手机站评论接口的固定客户端码（网页端 JS 里写死的那一串，不是身份凭据） */
const CMT_CODE = 'fc4be23b4e972707f36b8a828a93ba8a'

/**
 * 评论接口要手机 UA + 手机站 Referer。
 * 用桌面 UA 打过去会被 `Access Deny`（不是空列表，是 15 字节的纯文本），
 * 很容易被当成「酷狗没评论接口」。
 */
const CMT_HEADERS: Record<string, string> = {
  Referer: 'https://m3ws.kugou.com/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
}

/** 正文：公共清洗（保留换行、还原字面 `\n`）+ 酷狗表情代码替换 */
function cmtText(s: unknown): string {
  return emojiCode(commentText(s))
}

/** 酷狗给的是北京时间字符串，交给公共解析（显式 +08:00，不受本机时区影响） */
const cmtTime = cnTimeToSec

/** `images` 在评论里是数组、在楼层里是空字符串；只认图片，别把语音收进来 */
function cmtImages(v: any): string[] {
  return imageUrlsOf(v)
}

/** 一条酷狗评论 / 楼层回复 → 统一模型 */
function cmtOf(c: any): SongComment {
  const like = c?.like?.count ?? c?.like?.likenum ?? 0
  return {
    id: String(c?.id ?? ''),
    user: clean(c?.user_name) || '匿名用户',
    avatar: c?.user_pic ? String(c.user_pic).replace(/^http:\/\//, 'https://') : undefined,
    content: cmtText(c?.content),
    images: cmtImages(c?.images),
    time: cmtTime(c?.addtime),
    likes: Number(like) || 0,
    location: clean(c?.location) || undefined,
    // 首屏只给数量；展开时再按需取正文
    replyTotal: Number(c?.reply_num ?? 0) || 0,
    raw: c,
  }
}

/**
 * 榜单详情：`api/v3/rank/song`。
 *
 * **`version=8000` 不能少**（2026-10 实测）：不带它时 `data.total` 会退化成
 * 「这一页有几首」的怪异值（TOP500 只回 2 首、page=2 直接空），很容易被当成
 * 「酷狗榜单只有两首歌」。带上之后 TOP500 给 500 首、每页 100 首正常翻页。
 */
async function rankSongs(
  client: HttpClient, rankId: string, page: number, limit: number,
): Promise<PlaylistDetail> {
  const p = Math.max(1, page)
  const j = await getJson(client,
    `http://mobilecdn.kugou.com/api/v3/rank/song?rankid=${encodeURIComponent(rankId)}`
    + `&page=${p}&pagesize=${limit}&plat=0&apiver=2&area_code=1&version=8000`,
    { headers: HEADERS })
  const songs = (j?.data?.info ?? []).map(normalizeDetail)
  const total = Number(j?.data?.total ?? songs.length) || songs.length
  return {
    id: asRankId(rankId),
    source: 'kg',
    // 榜单名/封面这个接口不给，调用方（广场）手上有一份，沿用它
    name: '',
    songs,
    total,
    hasMore: (p - 1) * limit + songs.length < total,
  }
}

export function createKgApi(client: HttpClient): PlatformApi {
  return {
    source: 'kg',
    supportsSearch: true,
    supportsPlaylistSearch: true,
    supportsPlaylistDetail: true,
    supportsLyric: true,

    async search(keyword, page, limit): Promise<SearchResult> {
      const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}`
        + `&page=${page}&pagesize=${limit}&platform=WebFilter&userid=0&clientver=2000`
        + `&iscorrection=1&privilege_filter=0&filter=10&appid=1014&token=`
      const j = await getJson(client, url, { headers: HEADERS })
      const list: SearchSong[] = (j?.data?.lists ?? []).map(normalize)
      return { list, total: Number(j?.data?.total ?? list.length) || list.length, source: 'kg' }
    },

    /**
     * 歌单搜索。
     * `mobiles.kugou.com` 的 v3 接口没有签名要求，`showtype` 也不用带。
     */
    async searchPlaylist(keyword, page, limit): Promise<PlaylistSearchResult> {
      const url = `https://mobiles.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(keyword)}`
        + `&page=${page}&pagesize=${limit}`
      const j = await getJson(client, url, { headers: HEADERS })
      const list: PlaylistSearchItem[] = (j?.data?.info ?? [])
        .filter((p: any) => p?.specialid)
        .map((p: any) => ({
          id: String(p.specialid),
          source: 'kg' as const,
          name: clean(p.specialname),
          cover: cover(p.imgurl, 400),
          creator: clean(p.nickname),
          songCount: Number(p.songcount ?? 0),
          playCount: Number(p.playcount ?? 0),
          detailSupported: true,
        }))
      return { list, total: Number(j?.data?.total ?? list.length) || list.length, source: 'kg' }
    },

    /**
     * 热门歌单：手机站 `m.kugou.com/plist/index?json=true`。
     *
     * 为什么不用 `api/v3/special/list`：那个接口对匿名请求一律回
     * `Access Deny ! No Actions !`（200 状态码 + 15 字节纯文本），
     * 换 `mobiles` / `mobilecdn` / `mobilecdnbj` 三个域名、加 `plat`、
     * 加 `version` 都一样，所以不是参数问题，是接口本身关了。
     * 手机站的精选集列表是通的，且字段比 v3 更全（自带 `intro` / `tags`）。
     */
    async getHotPlaylists(page, limit): Promise<HotPlaylistResult> {
      const n = Math.min(Math.max(limit || 24, 1), 30)
      const j = await getJson(client,
        `https://m.kugou.com/plist/index?json=true&page=${Math.max(1, page)}&pagesize=${n}`,
        { headers: HEADERS })
      const box = j?.plist?.list ?? {}
      const list: HotPlaylistItem[] = (box.info ?? [])
        .filter((p: any) => p?.specialid)
        .map((p: any) => ({
          id: String(p.specialid),
          source: 'kg' as const,
          name: clean(p.specialname),
          cover: cover(p.imgurl, 400),
          creator: clean(p.username ?? p.singername),
          songCount: Number(p.songcount ?? 0),
          playCount: Number(p.playcount ?? 0),
          detailSupported: true,
          intro: clean(p.intro) || undefined,
          tag: clean(p.tags) || undefined,
        }))
      const total = Number(box.total ?? 0)
      return {
        list,
        hasMore: total ? Math.max(1, page) * n < total : list.length >= n,
        source: 'kg',
      }
    },

    /**
     * 全部排行榜：`mobilecdn` 的 `api/v3/rank/list`（实测 25 个）。
     *
     * 图标字段都是带 `{size}` 占位的，`cover()` 统一换掉。
     * `intro` 里是 `\r\n` 分行的三段说明，卡片上只当一句话用，`clean` 会把空白压平。
     */
    async getRanklists(): Promise<RankListResult> {
      const j = await getJson(client,
        'http://mobilecdn.kugou.com/api/v3/rank/list?apiver=2&plat=0&area_code=1&ranktype=2',
        { headers: HEADERS })
      const list: RankListItem[] = (j?.data?.info ?? [])
        .filter((r: any) => r?.rankid)
        .map((r: any) => ({
          id: asRankId(r.rankid),
          source: 'kg' as const,
          name: clean(r.rankname),
          // `img_9` 是带榜单排名的方形海报，`album_img_9` 只是第一名的专辑图
          cover: cover(r.img_9 ?? r.album_img_9 ?? r.imgurl, 400),
          intro: clean(r.intro) || clean(r.update_frequency) || undefined,
          songCount: Number(r?.extra?.resp?.all_total ?? 0) || undefined,
          playCount: Number(r.play_times ?? 0) || undefined,
        }))
      return { list, source: 'kg' }
    },

    /**
     * 每日推荐：`POST gateway.kugou.com/everyday_song_recommend`。
     *
     * 就是 App 首页「每日推荐」那一份 30 首（`creation_date` 每天换一次）。
     * 三个都不能少：
     *   · `x-router` 头 —— 网关靠它分流，不带就是 502；
     *   · `signature` —— 安卓盐值的 MD5；
     *   · 登录 cookie 里的 `uid`/`token` —— 有它们才是「按你的口味」，
     *     没有也能拿到一份公共日推，但界面只在登录后才显示这一段。
     */
    async getDailyRecommend(): Promise<PlaylistDetail> {
      const j = await gatewayPost(client, EVERYDAY_ROUTER, '/everyday_song_recommend', {
        ...deviceParams(client),
        platform: 'ios',
      })
      const songs: SearchSong[] = (j?.data?.song_list ?? [])
        .filter((x: any) => x?.hash)
        .map(normalizeEveryday)
      if (!songs.length) throw new Error('酷狗今天没有推荐内容')
      return {
        id: 'daily:kg',
        source: 'kg',
        name: '每日推荐 · 酷狗音乐',
        cover: songs[0]?.img,
        songCount: songs.length,
        songs,
        total: songs.length,
        hasMore: false,
      }
    },

    /**
     * 登录账号自己建的歌单：`POST gateway.kugou.com/v7/get_all_list`
     * （`x-router: cloudlist.service.kugou.com`）。
     *
     * 未登录 `userid=0` 时网关只回 `error_code:20010`，所以先看 cookie 里有没有
     * `uid`，没有就不发请求。这里给的是**云歌单 id（`global_collection_id`）**，
     * 详情要按这个 id 走 `get_list_info`，不能拿去打 `special/song`（那是公开歌单）。
     */
    async getUserPlaylists(): Promise<HotPlaylistResult | null> {
      const p = deviceParams(client)
      if (!p.userid) return null
      const body = JSON.stringify({
        userid: Number(p.userid),
        token: String(p.token ?? ''),
        total_ver: 979,
        type: 2,
        page: 1,
        pagesize: 50,
      })
      let j: any
      try {
        j = await gatewayPost(client, 'cloudlist.service.kugou.com', '/v7/get_all_list', {
          ...p,
          plat: 1,
        }, body)
      } catch {
        return null
      }
      const raw: any[] = j?.data?.info ?? j?.data?.list ?? j?.data?.lists ?? []
      const list: HotPlaylistItem[] = raw
        .map((x: any) => ({
          id: `kgc:${String(x.global_collection_id ?? x.listid ?? x.id ?? '')}`,
          source: 'kg' as const,
          name: clean(x.listname ?? x.list_name ?? x.name),
          cover: cover(x.list_pic ?? x.pic ?? x.img),
          creator: clean(x.nickname ?? x.username) || undefined,
          songCount: Number(x.songcount ?? x.count ?? x.total ?? 0) || undefined,
          detailSupported: true,
        }))
        .filter((x: HotPlaylistItem) => x.id !== 'kgc:' && x.name)
      return list.length ? { list, hasMore: false, source: 'kg' } : null
    },

    async getPlaylistDetail(id, page = 1, limit = 300): Promise<PlaylistDetail> {
      // 云歌单（「我的歌单」）走另一条：用 global_collection_id 换歌
      if (id.startsWith('kgc:')) {
        const gcid = id.slice(4)
        const p = deviceParams(client)
        const body = JSON.stringify({
          data: [{ global_collection_id: gcid }],
          userid: Number(p.userid ?? 0),
          token: String(p.token ?? ''),
        })
        const j = await gatewayPost(client, 'pubsongs.kugou.com', '/v3/get_list_info', p, body)
        const one = j?.data?.list?.[0] ?? j?.data?.info?.[0] ?? j?.data?.data?.[0] ?? j?.data ?? {}
        const raw: any[] = one?.songs ?? one?.songlist ?? one?.song_list ?? one?.info ?? []
        const songs = raw.map(normalizeEveryday)
        if (!songs.length) throw new Error('这个歌单里还没有歌')
        return {
          id,
          source: 'kg',
          name: clean(one?.listname ?? one?.list_name ?? one?.name),
          cover: cover(one?.list_pic ?? one?.pic) ?? songs[0]?.img,
          songCount: songs.length,
          songs,
          total: songs.length,
          hasMore: false,
        }
      }
      if (isRankId(id)) return rankSongs(client, rankRawId(id), page, limit)
      const url = `https://mobiles.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(id)}`
        + `&page=${page}&pagesize=${limit}&total_ver=2&version=8000`
      const j = await getJson(client, url, { headers: HEADERS })
      const songs = (j?.data?.info ?? []).map(normalizeDetail)
      const total = Number(j?.data?.total ?? songs.length) || songs.length
      const start = (page - 1) * limit
      return {
        id: String(id),
        source: 'kg',
        name: '',
        // 歌单名/封面在详情接口里没有，交给调用方沿用搜索结果里的那一份
        songs,
        total,
        hasMore: start + songs.length < total,
      }
    },

    /**
     * 歌词要两步：先用 hash 换 `{id, accesskey}`，再下载。
     * 下载回来的 `content` 是 base64 的 LRC，**必须按 UTF-8 解**（直接 atob 会得到乱码中文）。
     */
    async getLyric(songmid) {
      const s1 = await getJson(client,
        `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${encodeURIComponent(songmid)}`,
        { headers: HEADERS })
      const cand = s1?.candidates?.[0]
      if (!cand?.id || !cand?.accesskey) return { lyric: '' }
      const s2 = await getJson(client,
        `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(cand.id)}`
        + `&accesskey=${encodeURIComponent(cand.accesskey)}&fmt=lrc&charset=utf8`,
        { headers: HEADERS })
      const lyric = b64decodeUtf8(String(s2?.content ?? '')).replace(/\r\n?/g, '\n')
      return { lyric }
    },

    /**
     * 评论。
     *
     * 拿 hash 当 `extdata` 打手机站的 `getCommentWithLike`：
     *   · `count` 是这首歌的评论总数（《晴天》70 万+）；
     *   · `list` 可能**是空字符串**（没评论 / hash 无效），不是空数组；
     *   · `addtime` 是北京时间字符串，要自己转秒；
     *   · 首屏每条只给 `reply_num`，回复正文是空串，需要点开再取。
     *
     * 没有「热门」分组（试过 `getHotCommentWithLike` 等写法，返回 10015），
     * 所以 `hot` 一直是空数组，UI 自动只显示一组列表。
     */
    async getComments(song, page = 1, limit = 20): Promise<CommentPage> {
      const hash = String(song.songmid || song.id || '')
      if (!hash) throw new Error('这条酷狗记录没有 hash，取不到评论')
      const j = await getJson(client,
        `https://mcomment.kugou.com/index.php?r=commentsv2/getCommentWithLike`
        + `&code=${CMT_CODE}&extdata=${encodeURIComponent(hash)}&p=${page}&pagesize=${limit}`,
        { headers: CMT_HEADERS })
      const code = Number(j?.err_code ?? 0)
      if (code !== 0) throw new Error(`酷狗评论返回 ${code}${j?.msg ? `：${clean(j.msg)}` : ''}`)
      const list: SongComment[] = (Array.isArray(j?.list) ? j.list : []).map(cmtOf)
      const total = Number(j?.count ?? 0) || list.length
      return { list, total, hasMore: (page - 1) * limit + list.length < total }
    },

    /**
     * 楼层回复。
     *
     * `childrenid` 必须是这条评论的 `special_child_id`（在搜索结果里叫
     * `Audioid`），**不能省**——只带 `tid` 会返回 10002 + 空列表。
     * 所以 `cmtOf` 把平台原始对象留在了 `raw` 上，这里直接取。
     */
    async getReplies(song, comment, page = 1, limit = 10): Promise<CommentPage> {
      const tid = String(comment.id || '')
      const scid = String(
        comment.raw?.special_child_id
        ?? (song.raw as any)?.Audioid
        ?? (song.raw as any)?.audio_id
        ?? '',
      )
      if (!tid || !scid) throw new Error('这条评论取不到楼层回复')
      const j = await getJson(client,
        `https://mcomment.kugou.com/index.php?r=commentsv2/getReplyWithLike`
        + `&code=${CMT_CODE}&childrenid=${encodeURIComponent(scid)}&tid=${encodeURIComponent(tid)}`
        + `&p=${page}&pagesize=${limit}&ver=1.01&clientver=8323&appid=1001`,
        { headers: CMT_HEADERS })
      const list: SongComment[] = (Array.isArray(j?.list) ? j.list : []).map(cmtOf)
      const total = Number(comment.replyTotal ?? 0) || list.length
      return { list, total, hasMore: page * limit < total }
    },

    async getPic(song) {
      return song.img ?? ''
    },
  }
}
