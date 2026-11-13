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
import { md5Hex } from '../md5'
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

/** cookie 串 → Map（登录凭证都是分号串，昵称/头像也要按名取，统一走这里） */
function cookieJar(raw?: string): Map<string, string> {
  const jar = new Map<string, string>()
  for (const seg of (raw ?? '').split(';')) {
    const s = seg.trim()
    const i = s.indexOf('=')
    if (i > 0) jar.set(s.slice(0, i).trim(), s.slice(i + 1).trim())
  }
  return jar
}

/**
 * 酷我把昵称和头像写在 cookie 里（`uname3` / `pic3`），而且是**两层编码**：
 * 先 URL 编码一次（`%25u53E3…`），解出来还是 `%u53E3…` 这种 unicode-escape。
 * 只 `decodeURIComponent` 会得到一串 `%uXXXX`，只按 `%u` 解又留着 `%25`。
 */
function cookieText(v?: string): string {
  if (!v) return ''
  let s = v
  try { s = decodeURIComponent(s) } catch { /* 没编码就原样用 */ }
  return s.replace(/%u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
}

/**
 * 从登录 cookie 里挖出 uid。
 *
 * 酷我登录后 cookie 里通常直接有 `userid=123456`；拿不到时退到 `kw_token`——
 * 它是个 JWT，payload 里带着 uid。**不猜**：两处都没有就返回空串，
 * 上层据此不显示「我的歌单」，而不是拿 0 去请求一份别人的歌单。
 */
function uidOfCookie(raw?: string): string {
  if (!raw) return ''
  const jar = cookieJar(raw)
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
    singer: clean(s.ARTIST ?? s.AARTIST).split(/[\\&、]/).map(x => x.trim()).filter(Boolean),
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
  /*
   * 时长必须优先取 `song_duration`。
   *
   * 榜单接口（`kbangserver/ksong.s`）给两个时长：
   *   · `duration`      = **这次能放多长**。会员 / 版权受限曲目只给试听片段，
   *     实测酷我热歌榜 300 首里 292 首是 93~144 秒的片段；
   *   · `song_duration` = 整首歌的真实长度（同一首是 209 秒）。
   * 拿片段长度当 `interval`，下游全跟着错：跨平台兜底按「差 ≥ 40 秒」判错歌、
   * 试听检测（real < expect × 0.6）永远不触发、进度归一也按 93 秒算。
   */
  const full = Number(s?.song_duration ?? 0) || 0
  const frag = Number(s?.duration ?? 0) || 0
  return {
    id: rid,
    songmid: rid,
    source: 'kw',
    name: clean(s?.name ?? s?.songname),
    singer: clean(s?.artist ?? s?.AARTIST).split(/[\\&、]/).map((x: string) => x.trim()).filter(Boolean),
    albumName: clean(s?.album ?? s?.albumname),
    albumId: s?.albumid != null ? String(s.albumid) : undefined,
    interval: Math.max(full, frag),
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

/* ------------------------------------------------------------------ */
/* 按天洗牌（每日推荐用）                                               */
/* ------------------------------------------------------------------ */

/**
 * 酷我飙升榜在 `wapi/pc/bang/list` 里的 `sourceid`（官方榜组，2026-10 实测）。
 * `kbangserver/ksong.s` 只认这个 id，参考 fnos_music_ext 的 `_KW_BANG_ID`。
 */
const KW_BANG_RISE_ID = '93'

/** FNV-1a 32 位：字符串 → 稳定整数种子 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** mulberry32：极小的确定性 PRNG，同种子同序列（够洗牌用，不搞加密） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates 确定性洗牌：不改动入参，返回打乱后的新数组 */
function shuffleSeeded<T>(arr: readonly T[], seed: number): T[] {
  const out = arr.slice()
  const rnd = mulberry32(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** 每日推荐洗牌种子：当天日期 + 登录 uid（未登录空串）。当天恒定，隔天即换 */
function dailySeed(uid: string): number {
  const d = new Date()
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return fnv1a(`${day}|${uid}`)
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
  /*
   * 丢掉「明确不能在线播放」的条目（`payInfo.cannotOnlinePlay=1`，多为无版权）。
   * 留着它们只会让用户点进去听一段杂音然后报错。
   *
   * **不过滤 `listen_fragment=1`**：那是「只有试听片段」，酷我热歌榜 300 首里
   * 有 292 首是这种（前沿新歌基本都在会员池）——全滤掉榜单就空了。
   * 这类条目靠下游兜底：时长已按 `song_duration` 报整首，播放器拿到片段后
   * 会触发「real 时长明显短于预期」→ 跨平台重搜换一家能放整首的。
   */
  const songs: SearchSong[] = raw
    .map(normalizeDetailSong)
    .filter((s: SearchSong) => String((s.raw as any)?.payInfo?.cannotOnlinePlay ?? '0') !== '1')
  const total = Number(j?.num ?? 0) || songs.length
  /*
   * `pic` 是 60×60 的榜单缩略图（`.../BangPic/small/…`，实测只有 2KB），
   * 撑到详情页那块方形封面上会糊成一片马赛克。这种小图干脆不返回，
   * 让调用方用它手上那张大图（广场的榜单卡有）；实在没有就走文字占位。
   *
   * 还有一种更坑的：`pic` 只给了目录、没给文件名——
   * `http://img1.kuwo.cn/star/mboxAlbum/BangPic/`。它不是空串，所以天真的
   * `pic ? … : undefined` 会把它当成可用封面返回出去，前端照着画一张
   * `url(...BangPic/)` 的**空白方框**（热榜 / 飙升榜 / 新歌榜三个榜都是这样）。
   * 判定改成「最后一段得像个文件名」，没有就当作没给。
   */
  const pic = String(j?.pic ?? '').trim()
  const hasFile = /\/[^/?#]+$/.test(pic)
  const cover = pic && hasFile && !/\/BangPic\/small\//.test(pic)
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

/* ------------------------------------------------------------------ */
/* 每日推荐（波点 App 的「潮趣日推」，30 首）                          */
/*                                                                    */
/* 【2026-10 停用】下面这组 bodian* 代码保留备查（酷我若开放合作方       */
/* AppId 可直接复用），但 getDailyRecommend 已改走「飙升榜+按天洗牌」：  */
/* 波点接口只按 uid 出公共池、不校验 token，和手机 App 账号那份永远      */
/* 对不上（`aiPlaylistDetail` 返回不变，逐组试过），此路不通。           */
/* ------------------------------------------------------------------ */

/**
 * 酷我的「每日推荐」不在老的 web 接口里，只在**波点（BoDian）App 的
 * `bd-api.kuwo.cn`** 上有。2026-10 实网打通，链路三段：
 *
 *   GET /api/service/home/module?moduleId=1   → `songList[]`，4 组预览各 3 首
 *   GET /api/service/home/aiPlaylistDetail?index=<日推那组的下标>
 *                                            → `musicList[]`，**一次 30 首**
 *
 * `index` 就是该组在 `songList` 里的位置（实测 0=潮趣日推、1=新歌大赏、
 * 2=排行榜、3=百万收藏），所以必须**先取 module 再算下标**，不能写死 0。
 *
 * 几个踩过的点：
 *   · 签名用的是**绝对路径**（含 `/api`），少了直接 `code=439 sign invalid`；
 *   · `sign = md5("kuwotest" + 归一化query + bodyHash + path)`，query 要
 *     **去掉所有非字母数字字符后逐字符排序**，不是按 key 排序；
 *   · `payload` 头（base64(xor(设备 JSON))）**缺了回 402**；`client` / `api-ver`
 *     反而不需要；UA 要像个客户端，只发 `Mozilla/5.0` 也会 402；
 *   · 这个接口**只认 uid**：`token` 查询参数随便填都出同样结果（实测），
 *     所以登录态只要 cookie 里有 `userid` 就够；但**整条 cookie 必须一起发**，
 *     只带 uid 参数时服务端按「匿名」处理、回的是 uid=-1 那份公共日推，
 *     第一首永远和手机上看到的不一样（2026-10 用户反馈「日推第一首不对」就是这个）。
 */
const BODIAN_BASE = 'https://bd-api.kuwo.cn/api/'
const BODIAN_VER = '5.9.1'
/** 签名固定盐，注意是 `kuwotest` 不是 `kuwo` */
const BODIAN_SALT = 'kuwotest'
/** payload 头与手机号加密共用的异或密钥 */
const BODIAN_XOR = 'bd2025@'
/** 设备 id 固定即可，服务端不校验 */
const BODIAN_DEVICE = 'e3b0c44298fc1c149afbf4c8996fb924'

/** 字符串 → utf8 字节 → 逐字节异或 → base64（payload 头的算法） */
function bodianPayload(): string {
  const enc = new TextEncoder()
  const raw = enc.encode(JSON.stringify({
    devId: BODIAN_DEVICE,
    ver: BODIAN_VER,
    plat: 'ar',
    net: 'wifi',
    channel: 'wenyu',
    qimei36: '',
    ultraHD: 0,
    h265supported: 0,
    svrVer: 50,
    currentOsVersion: 35,
  }))
  const key = enc.encode(BODIAN_XOR)
  let bin = ''
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i] ^ key[i % key.length])
  return btoa(bin)
}

/**
 * 参数编码要对齐 Python 的 `quote(safe='')`：`encodeURIComponent` 会放过
 * `!*'()`，而那四个字符在签名归一化里会被剥掉、保留下来就是不同的 sign。
 */
const bodianQuote = (v: string) =>
  encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** `sign = md5("kuwotest" + 归一化query + "" + "/api/<path>")` */
function bodianSign(query: string, path: string): string {
  const normalized = query.replace(/[^a-zA-Z0-9]/g, '').split('').sort().join('')
  return md5Hex(`${BODIAN_SALT}${normalized}${''}/api/${path}`)
}

async function bodianGet(
  client: HttpClient,
  path: string,
  params: Record<string, string>,
  uid: string,
  token: string,
): Promise<any> {
  /*
   * **必须把真 cookie 一起发过去。**
   *
   * 只带 `uid` / `token` 查询参数时，服务端认得出「有个 uid」，但拿不到会话，
   * 回的是**公共日推**（和 uid=-1 那份一模一样）——表现就是「每日推荐能打开、
   * 但第一首永远不是手机上看到的那首」。参数上的 token 我们是从 cookie 里
   * 硬挖出来的一段，格式对不上它的校验，等于没登录。
   * 官方客户端每一条请求都带完整 cookie，这里照做即可。
   */
  const cookie = cookieFor(client, BODIAN_BASE)
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) q.set(k, v)
  q.set('uid', uid)
  q.set('token', token)
  q.set('timestamp', String(Math.floor(Date.now() / 1000)))
  const query = [...q.entries()]
    .map(([k, v]) => `${bodianQuote(k)}=${bodianQuote(v)}`)
    .join('&')
  const url = `${BODIAN_BASE}${path}?${query}&sign=${bodianSign(query, path)}`
  const j = await getJson(client, url, {
    headers: {
      Accept: 'application/json',
      client: 'android',
      'X-Requested-With': 'cn.wenyu.bodian',
      'api-ver': '2',
      payload: bodianPayload(),
      'User-Agent': `BoDianMusic/${BODIAN_VER} (Android; cn.wenyu.bodian)`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  })
  if (Number(j?.code) !== 200) {
    throw new Error(`酷我每日推荐没拿到（code=${j?.code} ${j?.msg ?? ''}）`.trim())
  }
  return j?.data ?? {}
}

/** 波点歌曲对象（小写字段）→ SearchSong */
function normalizeBodian(s: any): SearchSong {
  const rid = String(s?.id ?? '')
  const audios: any[] = Array.isArray(s?.audios) ? s.audios : []
  const q: string[] = []
  // 按 format 判，不按 level：`mflac`/`mgg` 是加密封装，我们的音源取不了
  if (audios.some(a => String(a?.format) === 'flac')) q.push('flac')
  if (audios.some(a => String(a?.format) === 'ogg' && Number(a?.bitrate) >= 300)) q.push('320k')
  if (audios.some(a => String(a?.format) === 'ogg')) q.push('128k')
  const pic = String(s?.albumPic ?? s?.albumPic120 ?? '')
  const singers: string[] = Array.isArray(s?.artists)
    ? s.artists.map((x: any) => clean(x?.name)).filter(Boolean)
    : []
  return {
    id: rid,
    songmid: rid,
    source: 'kw',
    name: clean(s?.name),
    singer: singers.length ? singers : clean(s?.artist).split(/[\\&、]/).map(x => x.trim()).filter(Boolean),
    albumName: clean(s?.album),
    albumId: s?.albumId != null ? String(s.albumId) : undefined,
    interval: Number(s?.duration ?? 0) || 0,
    img: pic ? pic.replace(/^http:\/\//, 'https://') : undefined,
    qualities: q.length ? q : undefined,
    raw: { ...s, songmid: rid, songId: rid, rid },
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
    // 酷我的日推是免登录榜单池洗出来的（见 getDailyRecommend），前端据此放行未登录用户
    dailyWithoutLogin: true,

    /**
     * 每日推荐：**酷我飙升榜 + 按天洗牌**（免登录可用）。
     *
     * 波点 App 那条真日推链路（`bd-api.kuwo.cn`，见上方协议注释）2026-10 已停用：
     * 它只认合作方 AppId，`token`/`sid` 都不校验、只按 uid 出**公共池**，
     * 和手机 App 每个人自己的那份永远对不上——「第一首不是大天蓬」就是它，
     * 换 cookie、加签名、对 `service/home/module` 逐组试都没用，这条路到头了
     * （同款结论见 fnos_music_ext：它也没调官方日推，用免登录榜单兜的）。
     *
     * 现在的方案（诚实版日推）：
     *   · 主池 = **酷我飙升榜**（官方榜 `sourceid=93`，kbangserver 免签老接口，
     *     复用 `rankSongs`；实测 rn=120 过滤后约 39 首可完整播，凑 30 够用）；
     *   · 过滤 `payInfo.cannotOnlinePlay=1`（无版权）与 `listen_fragment=1`
     *     （只有试听片段——实测占 62%，放出去就是「放到一半没了」，宁缺毋滥）；
     *   · **按天洗牌**：`seed = fnv1a(YYYYMMDD + '|' + uid)`，Fisher-Yates 确定性
     *     打乱后取 30 首——当天内刷新不变、隔天换一批、登录后带 uid 各不相同；
     *   · 名字写明「每日推荐 · 酷我飙升榜」，不冒充官方 App 那一份；
     *     未登录也能看（`dailyWithoutLogin: true`，前端据此放行）。
     */
    async getDailyRecommend(): Promise<PlaylistDetail> {
      const uid = uidOfCookie(cookieFor(client, BODIAN_BASE))
      // ① 大池子：飙升榜前 120（rankSongs 的 pn 从 0 起，这里 page 传 1）
      const pool = await rankSongs(client, KW_BANG_RISE_ID, 1, 120)
      const usable = pool.songs.filter(s => {
        const pay = (s.raw as any)?.payInfo
        if (!pay) return true
        return String(pay.cannotOnlinePlay ?? '0') !== '1'
          && String(pay.listen_fragment ?? '0') !== '1'
      })
      if (usable.length < 5) throw new Error('酷我飙升榜今天取不到足够内容，稍后再试')
      // ② 按天洗牌，取 30
      const picked = shuffleSeeded(usable, dailySeed(uid)).slice(0, Math.min(30, usable.length))
      // ③ 封面：榜单自己的 `pic` 是 2KB 小图（rankSongs 已滤掉），这里用
      //    bang/list 里飙升榜的 `pic2` 方形大海报；失败就空着走前端占位。
      let cover: string | undefined
      try {
        const j = await getJson(client, 'http://wapi.kuwo.cn/api/pc/bang/list', {
          headers: { ...HEADERS, Referer: 'http://www.kuwo.cn/' },
        })
        outer: for (const g of j?.child ?? []) {
          for (const b of g?.child ?? []) {
            if (String(b?.sourceid) === KW_BANG_RISE_ID) {
              const pic = imgUrl(b.pic2 ?? b.pic5 ?? b.pic)
              if (pic && !/\/BangPic\/small\//.test(pic)) cover = pic
              break outer
            }
          }
        }
      } catch { /* 封面是锦上添花，拿不到不挡内容 */ }
      return {
        id: 'daily:kw',
        source: 'kw',
        name: '每日推荐 · 酷我飙升榜',
        cover,
        songCount: picked.length,
        songs: picked,
        total: picked.length,
        hasMore: false,
      }
    },

    /**
     * 当前登录的账号。
     *
     * 酷我没有免签的「拿资料」接口（`wapi`/`bd-api` 那几条都要 csrf 或签名），
     * 但昵称、头像、uid 本来就在登录 cookie 里，直接解出来就行。
     *
     * **这不是可有可无的装饰**：「每日推荐」这类内容是**按账号算**的，
     * 账号登错的时候怎么调接口都对不上手机 App（2026-10 用户反馈日推第一首
     * 永远不对，最后查到是本机登着一个几乎没听过歌的空号）。界面上至少得让人
     * 一眼看出自己登的是谁。
     */
    async getAccount() {
      const raw = cookieFor(client, 'https://www.kuwo.cn/')
      const jar = cookieJar(raw)
      const uid = uidOfCookie(raw)
      if (!uid) return null
      const name = clean(cookieText(jar.get('uname3') ?? jar.get('uname')))
      return {
        userId: uid,
        // 有些登录方式（扫码、车机）不写 uname3，给个能区分人的兜底，别留空
        nickname: name || `酷我用户 ${uid.slice(-6)}`,
        avatar: imgUrl(cookieText(jar.get('pic3') ?? jar.get('pic'))),
      }
    },

    /**
     * 我的歌单：`nplserver.kuwo.cn/pl.svc?op=getuserlist`（老接口、免签名、免 csrf）。
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

    /**
     * 单曲封面：`artistpicserver` 的老接口（免签名、免 cookie）。
     *
     * 榜单详情（`kbangserver/ksong.s`）整份**没有任何封面字段**——300 条里 0 条带
     * `albumpic / musicPic`，于是热歌榜 / 飙升榜 / 新歌榜的歌曲列表全是空封面，
     * 而下面「热门歌单」走 `pl.svc`，那边有 `albumpic`，所以那一块是好的。
     *
     * 能按 rid 换到封面图只有这一条路：它**回的不是图片，而是一行 URL 文本**
     * （69 字节，`http://img1.kwcdn.kuwo.cn/star/albumcover/500/s4s17/95/1740093141.jpg`），
     * 认不出来的就回 `Wrong`。所以这里要判一眼再返回，别把 `Wrong` 当图片地址塞给 <img>。
     *
     * 注意域名：`img1.kwcdn.kuwo.cn` **没有自己的证书**（见 `imgUrl` 上面那段），
     * 拼好的地址必须保持 `http://`，升 https 会整片空白。
     */
    async getPic(song) {
      if (song.img) return song.img
      const rid = String(song.id || song.songmid || '').trim()
      if (!/^\d+$/.test(rid)) return ''
      try {
        const txt = clean(await getText(client,
          'http://artistpicserver.kuwo.cn/pic.web'
          + `?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${rid}`,
          { headers: HEADERS }))
        if (!/^https?:\/\/\S+\.(jpe?g|png|webp)$/i.test(txt)) return ''
        return imgUrl(txt) ?? txt
      } catch {
        /* 换不到就空手回去，列表照常渲染占位 */
        return ''
      }
    },
  }
}
