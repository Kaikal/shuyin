/**
 * QQ 音乐（tx）
 *
 * **单曲搜索走 `c.y.qq.com/soso/fcgi-bin/search_for_qq_cp`，不是 musicu。**
 * 这条是 2026-10 实测出来的关键结论，之前踩了很大的坑：
 *
 *   · `u.y.qq.com/cgi-bin/musicu.fcg` 的 `DoSearchForQQMusicDesktop` **匿名态限流极狠**：
 *     真实窗口大约「两三分钟只允许一次」，同一份 payload 隔 30s 打第二次就一路 `code 2001`
 *     （空列表），再等两分钟才恢复。它与参数无关——换 `comm.ct/cv`、加 `grp`、换查询词、
 *     GET 还是 POST，结果都一样。所以「改参数能绕过去」是错的，当初把它当参数问题去调，
 *     导致 QQ 搜索在用户侧长期表现为「一直不可用」。
 *   · `search_for_qq_cp` 是网页版搜索接口，**实测连打 5 次 + 分页 + 换词全部 code 0**，
 *     一次 20~30 条、`totalnum` 600+。字段是老格式（`songname/songmid/albumname/albummid`），
 *     `normalize()` 本来就兼容。
 *
 * `musicu` 只留给**歌单搜索**（`search_type: 3`）——那个接口别处拿不到，且用户搜歌单的频率
 * 远低于搜歌，配上长缓存与长冷却就够了。
 *
 * 旧接口 `client_search_cp` 已经返回 0 条，别用。
 */
import { clean, commentText, emojiCode, getJson, getText, imageUrlsOf, postJson } from '../http'
import { PlatformBusyError, asRankId, isRankId, rankRawId } from '../types'
import type {
  CommentPage, HotPlaylistItem, HotPlaylistResult, HttpClient, PlatformApi, PlaylistDetail,
  PlaylistSearchItem, PlaylistSearchResult, RankListItem, RankListResult, SearchResult, SearchSong,
  SongComment,
} from '../types'

const HEADERS: Record<string, string> = {
  Referer: 'https://y.qq.com/',
  Origin: 'https://y.qq.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const SEARCH_CP = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp'

const https = (u?: string) => (u ? String(u).replace(/^http:\/\//, 'https://') : undefined)

/** 用 album.mid 拼封面，300×300 */
const coverUrl = (albumMid?: string) =>
  albumMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg` : undefined

/**
 * 这首歌真实可用的档位。
 *
 * `search_for_qq_cp` 每首歌都带 `size128` / `size320` / `sizeflac` / `sizeape`，
 * **值为 0 就是没有这一档**（不是「还没算出来」——同一批里别的歌是有值的）。
 * QQ 没有 192k 这一档，所以不给 `192k`，UI 上那颗就该消失。
 */
function qualitiesOf(s: any): string[] | undefined {
  const q: string[] = []
  if (Number(s?.size128 ?? 0) > 0) q.push('128k')
  if (Number(s?.size320 ?? 0) > 0) q.push('320k')
  if (Number(s?.sizeflac ?? 0) > 0 || Number(s?.sizeape ?? 0) > 0) q.push('flac')
  return q.length ? q : undefined
}

function normalize(s: any): SearchSong {
  const album = s.album ?? {}
  const singer = (s.singer ?? []).map((a: any) => clean(a?.name)).filter(Boolean)
  const mid = String(s.mid ?? s.songmid ?? s.id ?? '')
  return {
    id: mid,
    songmid: mid,
    source: 'tx',
    name: clean(s.name ?? s.title ?? s.songname),
    singer,
    albumName: clean(album?.name ?? s.albumname),
    albumId: album?.mid != null ? String(album.mid) : (s.albummid != null ? String(s.albummid) : undefined),
    interval: Number(s.interval ?? 0) || 0,
    img: coverUrl(album?.mid ?? s.albummid),
    qualities: qualitiesOf(s),
    // `search_for_qq_cp` 用的是老字段名（`songid` 而不是 `id`），两个都兜一下：
    // 音源脚本取直链时 `songmid` 是主键，`songId` 只作补充
    raw: {
      ...s,
      songmid: mid,
      songId: s.id != null ? String(s.id) : (s.songid != null ? String(s.songid) : mid),
    },
  }
}

/** QQ 评论：`rootcommentcontent` 是正文，`middlecommentcontent` 是楼中楼的回复串 */
function toComment(c: any): SongComment {
  const raw = String(c?.content ?? c?.rootcommentcontent ?? '')
  /*
   * QQ 的老接口把图片以 `<img src="...">` 直接塞在正文里。
   * 图片地址交给 `imageUrlsOf` 统一清洗（协议相对补 https、`&amp;` 还原、
   * 只认图片后缀），正文则把标签去掉换成一句占位——两者分开，
   * 这样「图片取不到」至少还剩一句「[图片]」，不会变成一条空白评论。
   */
  const imgs = imageUrlsOf(raw)
  const text = raw.replace(/<img[^>]*>/gi, imgs.length ? ' [图片] ' : ' ').replace(/<[^>]+>/g, '')
  const replies = Array.isArray(c?.middlecommentcontent)
    ? c.middlecommentcontent.slice(0, 3).map((r: any): SongComment => ({
        id: String(r?.subcommentid ?? r?.commentid ?? ''),
        user: clean(r?.nick) || '匿名用户',
        content: emojiCode(commentText(r?.content ?? r?.subcommentcontent)),
        images: [],
        time: Number(r?.time ?? 0) || 0,
        likes: Number(r?.praisenum ?? 0) || 0,
      }))
    : []
  return {
    id: String(c?.commentid ?? ''),
    user: clean(c?.nick) || '匿名用户',
    avatar: c?.avatarurl ? String(c.avatarurl).replace(/^http:\/\//, 'https://') : undefined,
    content: emojiCode(commentText(text)),
    images: imgs,
    time: Number(c?.time ?? 0) || 0,
    likes: Number(c?.praisenum ?? 0) || 0,
    replies: replies.length ? replies : undefined,
  }
}

/**
 * musicu.fcg 统一调用（现在只给**歌单搜索**用）。
 *
 * `code 2001` 的真相（2026-10 实测）：**它是匿名态的时间窗口限流**，窗口大约两三分钟一次。
 * 同一份 payload 隔 30 秒打第二次就一路 2001；换 `comm.ct/cv`、加不加 `grp`、中文还是英文、
 * GET 还是 POST 都一样。所以这里做三件事，而不是傻重试：
 *   1. **结果缓存**（30 分钟）——歌单结果本来就不怎么变
 *   2. **请求节流**（两次真实请求至少隔 900ms）
 *   3. **限流冷却**（150 秒）——连续 3 次 2001 就认账，冷却期内直接抛 PlatformBusyError，
 *      不再把「请求失败」当红字甩给用户
 */
const CACHE_TTL = 30 * 60_000
const MIN_GAP = 900
const COOLDOWN = 150_000

const cache = new Map<string, { at: number; data: any }>()
let nextSlot = 0
let blockedUntil = 0

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 排队等一个发送窗口 */
async function throttle() {
  const now = Date.now()
  const wait = Math.max(0, nextSlot - now)
  nextSlot = Math.max(now, nextSlot) + MIN_GAP
  if (wait > 0) await sleep(wait)
}

async function musicu(client: HttpClient, param: Record<string, unknown>): Promise<any> {
  const key = JSON.stringify(param)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data

  if (Date.now() < blockedUntil) {
    throw new PlatformBusyError('tx', blockedUntil - Date.now())
  }

  let data: any = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt)
    await throttle()
    const j = await postJson(client, MUSICU, {
      comm: { ct: '11', cv: '0', uin: '0', format: 'json' },
      req_1: {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param,
      },
    }, { headers: HEADERS })
    // **必须 Number()**：这个接口有时把 code 回成字符串 "2001"，
    // 用 `code !== 2001` 严格比较会把限流当业务失败抛出去，用户就一直看到
    // 「QQ 音乐搜索失败（code 2001）」——明明我们本来要静默跳过的就是它。
    const code = Number(j?.req_1?.code ?? 0)
    if (!code) { data = j?.req_1?.data ?? {}; break }
    if (code !== 2001) throw new Error(`QQ 音乐搜索失败（code ${code}）`)
  }

  if (data == null) {
    // 三次都是 2001：进冷却，别再把「搜索失败」甩给用户
    blockedUntil = Date.now() + COOLDOWN
    throw new PlatformBusyError('tx', COOLDOWN, 'QQ 音乐歌单搜索被临时限流，稍后自动恢复（单曲搜索不受影响）')
  }

  cache.set(key, { at: Date.now(), data })
  // 只留最近的几十条，别让长会话把内存吃掉
  if (cache.size > 60) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - 60)
    for (const [k] of oldest) cache.delete(k)
  }
  return data
}

/**
 * 榜单详情：`fcg_v8_toplist_cp.fcg`。
 *
 * `songlist[i].data` 就是标准老格式的歌曲对象（`songmid / songname / singer /
 * albummid / size128 / size320 / sizeflac`），`normalize()` 直接能吃，所以这里
 * 只需要切页 + 把 `topinfo` 里的榜名和封面捞出来。`type=top` 不能省，
 * 省了返回的是普通歌单的结构（没有 `topinfo`）。
 */
async function rankSongs(
  client: HttpClient, topId: string, page: number, limit: number,
): Promise<PlaylistDetail> {
  const begin = (Math.max(1, page) - 1) * limit
  const j = await getJson(client,
    `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${encodeURIComponent(topId)}&format=json`
    + `&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&tpl=3&page=detail&type=top`
    + `&song_begin=${begin}&song_num=${limit}`,
    { headers: HEADERS })
  const songs: SearchSong[] = (j?.songlist ?? [])
    .map((x: any) => x?.data)
    .filter(Boolean)
    .map(normalize)
  const ti = j?.topinfo ?? {}
  const total = Number(j?.total_song_num ?? 0) || songs.length
  return {
    id: asRankId(topId),
    source: 'tx',
    name: clean(ti.ListName),
    cover: https(ti.pic_v12 ?? ti.headPic_v12 ?? ti.pic),
    songCount: total,
    songs,
    total,
    hasMore: begin + songs.length < total,
  }
}

/* ------------------------------------------------------------------ */
/* 登录态                                                              */
/* ------------------------------------------------------------------ */

/*
 * QQ 音乐不走标准的 Authorization：它把「谁在问」写进请求体的 `comm`
 * （`uin` + `authst`（音乐票据）+ 由票据算出的 `g_tk`），cookie 只是顺带。
 * 这套东西 2026-10 实测：匿名打登录态接口一律 `code 40000/500003`，
 * 所以下面这些接口**必须**拿得到 cookie；拿不到就回 null / 抛错，别装作能用。
 */

/** 从登录 cookie 里取 uin + 音乐票据 */
function authOf(client: HttpClient): { uin: string; key: string } | null {
  const raw = client.cookieFor?.('https://u.y.qq.com/') ?? ''
  if (!raw) return null
  const bag = new Map<string, string>()
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    let v = part.slice(i + 1).trim()
    // 值可能是 URL 编码的（网易云那边踩过同一个坑），解不开就按原样用
    try { v = decodeURIComponent(v) } catch { /* 原样 */ }
    if (!bag.has(k)) bag.set(k, v)
  }
  // QQ 的 uin 常带前导 o（o0123456789），只有数字那部分是账号
  const uin = String(bag.get('uin') || bag.get('wxuin') || bag.get('luin') || '').replace(/\D/g, '')
  const key = bag.get('qm_keyst') || bag.get('qqmusic_key') || bag.get('music_key') || ''
  return uin ? { uin, key } : null
}

/** QQ 网页版的 g_tk（hash33）：登录态按票据算，写死 5381 会被判「凭证不一致」 */
function gtkOf(key: string): number {
  if (!key) return 5381
  let h = 5381
  for (let i = 0; i < key.length; i++) h += (h << 5) + key.charCodeAt(i)
  return h & 0x7fffffff
}

function authComm(a: { uin: string; key: string }) {
  const gtk = gtkOf(a.key)
  return {
    ct: 24,
    cv: 4747474,
    platform: 'yqq.json',
    uin: a.uin,
    g_tk: gtk,
    g_tk_new_20200303: gtk,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: 0,
    need_new_code: 1,
    ...(a.key ? { authst: a.key } : {}),
  }
}

/**
 * 从推荐 feed 里挑出「每日 30 首」那张卡片的 id。
 *
 * feed 是「货架 → 卡位 → 卡片」三层，字段名在不同版本里飘过，所以按语义找：
 * `subtype === 510` 就是日推卡，id 是纯数字，或者藏在 `jump_url` 的
 * `disstid=` / `/playlist/` 后面。找不到就回 null——宁可这一块不显示，
 * 也不要拿别的卡片（比如「猜你喜欢」）冒充每日推荐。
 */
function pickDailyId(node: any, depth = 0): string | null {
  if (!node || typeof node !== 'object' || depth > 9) return null
  if (Array.isArray(node)) {
    for (const x of node) {
      const hit = pickDailyId(x, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (Number(node.subtype ?? node.sub_type ?? node.SubType ?? 0) === 510) {
    const direct = [node.disstid, node.id, node.content_id, node.tid]
      .map(v => String(v ?? ''))
      .find(v => /^\d{6,}$/.test(v))
    if (direct) return direct
    const jump = String(node.jump_url ?? node.jumpUrl ?? node.scheme ?? '')
    const m = jump.match(/(?:disstid=|\/playlist\/)(\d{5,})/)
    if (m) return m[1]
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const hit = pickDailyId(v, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

export function createTxApi(client: HttpClient): PlatformApi {
  return {
    source: 'tx',
    supportsSearch: true,
    supportsPlaylistSearch: true,
    supportsPlaylistDetail: true,
    supportsLyric: true,

    async search(keyword, page, limit): Promise<SearchResult> {
      const n = Math.min(Math.max(limit || 20, 1), 30)
      const j = await getJson(client,
        `${SEARCH_CP}?format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json`
        + `&needNewCode=0&uin=0&t=0&p=${Math.max(1, page)}&n=${n}`
        + `&w=${encodeURIComponent(keyword)}&aggr=1&cr=1&lossless=0`,
        { headers: HEADERS })
      const list: SearchSong[] = (j?.data?.song?.list ?? []).map(normalize)
      return { list, total: Number(j?.data?.song?.totalnum ?? list.length), source: 'tx' }
    },

    async searchPlaylist(keyword, page, limit): Promise<PlaylistSearchResult> {
      const data = await musicu(client, {
        num_per_page: limit,
        page_num: page,
        query: keyword,
        search_type: 3,
      })
      const list: PlaylistSearchItem[] = (data?.body?.songlist?.list ?? []).map((p: any) => ({
        id: String(p.dissid ?? p.content_id ?? ''),
        source: 'tx' as const,
        name: clean(p.dissname),
        cover: p.imgurl ? String(p.imgurl).replace(/^http:\/\//, 'https://') : undefined,
        creator: clean(p.creator?.name),
        songCount: Number(p.song_count ?? 0),
        playCount: Number(p.listennum ?? 0),
        detailSupported: true,
      }))
      return { list, total: Number(data?.meta?.sum ?? list.length), source: 'tx' }
    },

    /**
     * 热门歌单：`fcg_get_diss_by_tag.fcg`（网页版「分类歌单」列表，匿名可用）。
     *
     * `categoryId=10000000` 是「全部」，`sortId=5` 是按热度排——
     * 这就是 QQ 音乐网页上「推荐歌单」那一屏的数据。
     * 注意 `ein` 是**闭区间**（sin=0&ein=5 给 5 条），所以页码换算要 -1；
     * 写成 `sin + n` 会把下一条也带进来，翻页时首尾重复一条。
     */
    async getHotPlaylists(page, limit): Promise<HotPlaylistResult> {
      const n = Math.min(Math.max(limit || 24, 1), 30)
      const sin = (Math.max(1, page) - 1) * n
      const j = await getJson(client,
        `https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.1`
        + `&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0`
        + `&platform=yqq.json&needNewCode=0&categoryId=10000000&sortId=5`
        + `&sin=${sin}&ein=${sin + n - 1}`,
        { headers: HEADERS })
      const list: HotPlaylistItem[] = (j?.data?.list ?? []).map((p: any) => ({
        id: String(p.dissid ?? ''),
        source: 'tx' as const,
        name: clean(p.dissname),
        cover: p.imgurl ? String(p.imgurl).replace(/^http:\/\//, 'https://') : undefined,
        creator: clean(p.creator?.name),
        songCount: Number(p.song_count ?? 0),
        playCount: Number(p.listennum ?? 0),
        detailSupported: true,
        intro: clean(p.introduction) || undefined,
      }))
      const sum = Number(j?.data?.sum ?? 0)
      return { list, hasMore: sum ? sin + list.length < sum : list.length >= n, source: 'tx' }
    },

    /**
     * 全部排行榜：`musicu` 的 `musicToplist.ToplistInfoServer.GetAll`。
     *
     * QQ 网页「排行榜」那一屏就是它，**不分页、一次给完 4 组 30 个榜**
     * （巅峰榜 6 / 地区榜 9 / 特色榜 11 / 全球榜 4）。这里是匿名可用的，
     * 不像 `DoSearchForQQMusicDesktop` 那样会 2001 限流——所以别跟着搜索走那套冷却，
     * 也不要把它塞进 `musicu()` 那个带节流的封装（那个是给歌单搜索用的）。
     *
     * `intro` 里带 `<br>`，卡片上是纯文本，先把标签换成空格再 clean。
     */
    async getRanklists(): Promise<RankListResult> {
      const j = await postJson(client, MUSICU, {
        comm: { ct: 24, cv: 0 },
        topList: { module: 'musicToplist.ToplistInfoServer', method: 'GetAll', param: {} },
      }, { headers: HEADERS })
      const groups: any[] = j?.topList?.data?.group ?? []
      const list: RankListItem[] = []
      for (const g of groups) {
        const group = clean(g?.groupName) || undefined
        for (const t of g?.toplist ?? []) {
          if (t?.topId == null) continue
          list.push({
            id: asRankId(t.topId),
            source: 'tx' as const,
            name: clean(t.title),
            cover: https(t.headPicUrl ?? t.mbHeadPicUrl),
            intro: clean(String(t.intro ?? '').replace(/<[^>]+>/g, ' ')) || clean(t.updateTips) || undefined,
            group,
            songCount: Number(t.totalNum ?? 0) || undefined,
            playCount: Number(t.listenNum ?? 0) || undefined,
          })
        }
      }
      return { list, source: 'tx' }
    },

    /**
     * 我的歌单（登录态）。
     *
     * 走网页版「我的歌单」那条老接口 `fcg_user_created_diss`：按 uin 直接列，
     * 返回 `data.disslist[]`（`diss_name` / `diss_cover` / `song_cnt` / `listen_num` / `tid`）。
     * `tid` 才是 `getPlaylistDetail` 认的 disstid；`dirid` 是内部编号，
     * 205 = QQ 空间背景音乐（不是用户歌单，要滤掉），1 = 默认收藏「我喜欢」。
     *
     * 拿不到（没登录 / 票据过期 / 接口改了）返回 `null`：UI 据此隐藏这一段，
     * 而不是显示一个空壳区块。
     */
    async getUserPlaylists(): Promise<HotPlaylistResult | null> {
      const a = authOf(client)
      if (!a) return null
      const j = await getJson(client,
        `https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?hostuin=${a.uin}&sin=0&size=100`
        + `&format=json&g_tk=${gtkOf(a.key)}&loginUin=${a.uin}&platform=yqq.json&hostUin=0`
        + `&notice=0&needNewCode=0`,
        { headers: HEADERS, retry: 0 })
      if (Number(j?.code ?? 0) !== 0) return null
      const list: HotPlaylistItem[] = (j?.data?.disslist ?? [])
        .filter((p: any) => Number(p?.dirid) !== 205)
        .map((p: any) => ({
          id: String(p?.tid || p?.dirid || ''),
          source: 'tx' as const,
          name: clean(p?.diss_name),
          cover: https(p?.diss_cover),
          songCount: Number(p?.song_cnt ?? 0),
          playCount: Number(p?.listen_num ?? 0),
          detailSupported: true,
        }))
        .filter((p: HotPlaylistItem) => p.id && p.name)
      return list.length ? { list, hasMore: false, source: 'tx' } : null
    },

    /**
     * 每日推荐（登录态）。
     *
     * 两步：
     *   1. `RecommendFeed/get_recommend_feed` 拿一屏卡片，找到 `subtype: 510`
     *      的那张「每日 30 首」（id 每天换一个）；
     *   2. `DissInfo/CgiGetDiss` 按那个 id 把歌取回来。
     *
     * 匿名调用这一步只会回空 shelf（实测 v_shelf 里没有任何卡片），
     * 所以必须带 `comm.uin/authst`。任何一步拿不到就抛错，
     * 由上层（desktop 的 `dailyRecommend`）退回「今天的热门歌单」，
     * 不在这里编一份假推荐。
     */
    async getDailyRecommend(): Promise<PlaylistDetail> {
      const a = authOf(client)
      if (!a) throw new Error('QQ 音乐的每日推荐要登录后才能看')
      const comm = authComm(a)
      const feed = await postJson(client, MUSICU, {
        comm,
        req_0: {
          module: 'music.recommend.RecommendFeed',
          method: 'get_recommend_feed',
          param: { direction: 0, page: 1, v_cache: [], v_uniq: [], s_num: 0 },
        },
      }, { headers: HEADERS })
      const id = pickDailyId(feed?.req_0?.data)
      if (!id) throw new Error('QQ 音乐今天的推荐还没生成')

      const j = await postJson(client, MUSICU, {
        comm,
        req_0: {
          module: 'music.srfDissInfo.DissInfo',
          method: 'CgiGetDiss',
          param: { disstid: id, dirid: 0, tag: true, song_begin: 0, song_num: 100, userinfo: true, orderlist: true },
        },
      }, { headers: HEADERS })
      const d = j?.req_0?.data
      // 新版接口把每首歌包一层 `track`，老格式是扁平的，两种都吃
      const songs: SearchSong[] = (d?.songlist ?? [])
        .map((x: any) => x?.track ?? x)
        .filter((x: any) => x?.mid || x?.songmid)
        .map(normalize)
      if (!songs.length) throw new Error('QQ 音乐今天没有推荐内容')
      return {
        id: `daily:tx:${id}`,
        source: 'tx',
        name: '每日推荐 · QQ 音乐',
        cover: songs[0]?.img,
        songCount: songs.length,
        songs,
        total: songs.length,
        hasMore: false,
      }
    },

    async getPlaylistDetail(id, page = 1, limit = 300): Promise<PlaylistDetail> {
      if (isRankId(id)) return rankSongs(client, rankRawId(id), page, limit)
      // 一次给全量（歌单最多几千首，这一个接口就能拿完）
      // 注意：musicu 的 `PlaylistInfoServer.GetDetail` 匿名态一律 code 500003，只有这个老 fcg 能用；
      // 私有/已删歌单会回 `{code:0, subcode:4000, msg:'check privacy error!'}`，必须抛出来而不是当空歌单。
      const j = await getJson(client,
        `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0`
        + `&disstid=${encodeURIComponent(id)}&format=json&g_tk=5381&loginUin=0&hostUin=0`
        + `&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
        { headers: HEADERS })
      const cd = j?.cdlist?.[0]
      if (!cd) throw new Error(j?.msg === 'check privacy error!' ? '该歌单已被设为私密' : `歌单不存在或已下架（${j?.code ?? '?'}）`)
      const songs: SearchSong[] = (cd.songlist ?? []).map(normalize)
      return {
        id: String(cd.disstid ?? id),
        source: 'tx',
        name: clean(cd.dissname),
        cover: cd.logo ? String(cd.logo).replace(/^http:\/\//, 'https://') : undefined,
        creator: clean(cd.nickname),
        songCount: Number(cd.total_song_num ?? songs.length),
        songs,
        total: songs.length,
        hasMore: false,
      }
    },

    async getLyric(songmid) {
      // 这个接口回的是 JSON，但 lyric 字段里是转义过的 LRC
      const text = await getText(client,
        `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?format=json&nobase64=1`
        + `&songmid=${encodeURIComponent(songmid)}&g_tk=5381&loginUin=0&hostUin=0`
        + `&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
        { headers: { ...HEADERS, Referer: 'https://y.qq.com/portal/player.html' } })
      let j: any = null
      try { j = JSON.parse(text) } catch { j = null }
      const unescapeLrc = (s: string) => s
        .replace(/&#58;/g, ':').replace(/&#10;/g, '\n').replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      return {
        lyric: j?.lyric ? unescapeLrc(String(j.lyric)) : '',
        tlyric: j?.trans ? unescapeLrc(String(j.trans)) : '',
      }
    },

    async getPic(song) {
      return song.img ?? ''
    },

    /**
     * 评论。
     *
     * `topid` 要的是**数字 songid**（不是 songmid 那串 mid）——搜索结果里
     * `raw.songId` 就是这个数，所以取它；没有就退回 id（mid 传进去会拿到空列表）。
     *
     * `cmd=6` 是热评、`cmd=8` 是最新。首屏给热评更有内容感，翻页时再切最新。
     */
    async getComments(song, page = 1, limit = 20): Promise<CommentPage> {
      const raw = song.raw as any
      const topid = String(raw?.songId ?? raw?.songid ?? raw?.id ?? song.id)
      const j = await getJson(client,
        `https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg?g_tk=5381&loginUin=0&hostUin=0`
        + `&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
        + `&cid=205360772&reqtype=2&biztype=1&topid=${encodeURIComponent(topid)}`
        + `&cmd=${page === 1 ? 6 : 8}&needmusiccrit=0&pagenum=${page - 1}&pagesize=${limit}`,
        { headers: HEADERS })
      const c = j?.comment ?? {}
      const list: SongComment[] = (c?.commentlist ?? []).map(toComment)
      const total = Number(c?.commenttotal ?? 0) || list.length
      return {
        list,
        total,
        hasMore: (page - 1) * limit + list.length < total,
        // QQ 的热评混在同一个列表里（`is_hot` 标记），不再单独拆一组
      }
    },
  }
}
