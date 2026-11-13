/**
 * 网易云（wy）
 *
 * 接口选择说明：
 *   - 搜索用 `api/cloudsearch/pc`（POST 表单），因为它直接带 `al.picUrl`。
 *     老的 `api/search/get/web` 只有 `album.picId`，拿封面还要再请求一次。
 *   - 歌单详情用 `api/v6/playlist/detail`，一次给 1000 首。
 *   - 这些接口对 Referer / Cookie 敏感，改 UA 或去掉 Cookie 会 403，不要"优化"。
 */
import { clean, commentText, getJson, imageUrlsOf, postForm, toSeconds } from '../http'
import { asRankId, rankRawId } from '../types'
import type {
  CommentPage, HotPlaylistItem, HotPlaylistResult, HttpClient, PlatformApi, PlaylistDetail,
  PlaylistSearchItem, PlaylistSearchResult, RankListItem, RankListResult, SearchResult, SearchSong,
  SongComment,
} from '../types'

const HEADERS: Record<string, string> = {
  Referer: 'https://music.163.com/',
  Cookie: 'appver=8.9.70; os=pc;',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

const https = (u?: string) => (u ? u.replace(/^http:\/\//, 'https://') : undefined)

/**
 * 封面统一收到 500×500。
 *
 * 网易云原图动辄 1024×1024。搜索页一次渲染上百行、歌单页几十张大卡，
 * 全按原图解码就是几百兆位图——在没 GPU 的机器上（软件光栅）会明显拖慢首帧，
 * 图片还没解码完就合成，屏幕上是先出现半幅条纹再「涨」出封面。
 * 500 足够覆盖播放页大封面（237 CSS px × 1.71 dpr ≈ 405 设备像素）。
 */
const cover = (u?: string) => {
  const url = https(u)
  if (!url) return undefined
  if (!/music\.126\.net/.test(url) || /[?&]param=/.test(url)) return url
  return url + (url.includes('?') ? '&' : '?') + 'param=500y500'
}

/**
 * 这首歌真实可用的档位。
 *
 * cloudsearch 的每首歌都带 `l` / `m` / `h` / `sq` / `hr` 五个对象（128k / 192k /
 * 320k / 无损 / Hi-Res），**没有的那一档是 null**。所以「有没有」不用猜，
 * 也不需要再打一次 song/detail。
 */
function qualitiesOf(s: any): string[] | undefined {
  /*
   * 新版接口（cloudsearch / v3 每日推荐）用 `l/m/h/sq/hr`，老接口（v2 每日推荐）
   * 用 `lMusic/mMusic/hMusic/sqMusic/hrMusic`。两套都认，否则老格式那批歌
   * 会显示成「未知音质」。
   */
  const has = (k: 'l' | 'm' | 'h' | 'sq' | 'hr') => Boolean(s?.[k] ?? s?.[`${k}Music`])
  const q: string[] = []
  if (has('l')) q.push('128k')
  if (has('m')) q.push('192k')
  if (has('h')) q.push('320k')
  if (has('sq')) q.push('flac')
  if (has('hr')) q.push('flac24bit')
  return q.length ? q : undefined
}

function normalize(s: any): SearchSong {
  const singers = (s.ar ?? s.artists ?? []).map((a: any) => clean(a?.name)).filter(Boolean)
  const album = s.al ?? s.album ?? {}
  const id = String(s.id)
  return {
    id,
    // 网易云的数字 id 就是音源要的 songId；长青要 songmid，洛雪在 wy 上也是用这个值
    songmid: id,
    source: 'wy',
    name: clean(s.name),
    singer: singers,
    albumName: clean(album?.name),
    albumId: album?.id != null ? String(album.id) : undefined,
    interval: toSeconds(s.dt ?? s.duration),
    img: cover(album?.picUrl),
    qualities: qualitiesOf(s),
    // 原始对象 + 归一化 id：K×H 认 songId，长青只认 songmid，两边都要能读到
    raw: { ...s, songmid: id, songId: id },
  }
}

/**
 * 评论图片。
 *
 * 网易云把「带图评论」放在 `richContent` 里，只有含图片时它才是 JSON 字符串
 * （形如 `[{"type":1,"value":"http://p1.music.126.net/....jpg"}]`），纯文字时
 * 它就是同一段文字。所以先看首字符是不是 `[` 再解析，解析失败就当纯文本。
 * `contentResource` 是新的图片字段，也一起兜一下。
 */
function imagesOf(c: any): string[] {
  const out: string[] = []
  const rc = c?.richContent
  if (typeof rc === 'string' && rc.trimStart().startsWith('[')) {
    try {
      for (const it of JSON.parse(rc)) {
        const u = it?.type === 1 ? it?.value : null
        if (typeof u === 'string') imageUrlsOf(u, out)
      }
    } catch { /* 不是合法 JSON：当纯文字，不抛 */ }
  }
  /*
   * `contentResource` 里**既有图片也有语音**（语音的 url 是 .mp3）。
   * 以前见到 url 就收，语音评论就变成一块永远空着的灰格子——
   * `imageUrlsOf` 只认图片（显式 imageUrl/picUrl 或图片后缀）。
   */
  if (c?.contentResource) imageUrlsOf(c.contentResource, out)
  return out
}

/** 一条网易云评论 → 统一模型（楼中楼里的同一条也用这个函数，所以递归安全） */
function toComment(c: any): SongComment {
  const rep = Array.isArray(c?.beReplied) ? c.beReplied[0] : null
  return {
    id: String(c?.commentId ?? ''),
    user: clean(c?.user?.nickname) || '匿名用户',
    avatar: c?.user?.avatarUrl ? String(c.user.avatarUrl).replace(/^http:\/\//, 'https://') : undefined,
    content: commentText(c?.content),
    images: imagesOf(c),
    time: Number(c?.time ?? 0) / 1000 || 0,
    likes: Number(c?.likedCount ?? 0) || 0,
    location: clean(c?.ipLocation?.location) || undefined,
    replyTo: rep
      ? { user: clean(rep?.user?.nickname) || '匿名用户', content: clean(rep?.content) }
      : undefined,
  }
}

export function createWyApi(client: HttpClient): PlatformApi {
  /**
   * 登录态每日推荐；没登录（301）或请求失败都返回 null，
   * 由 `getDailyRecommend` 抛错——这里不编一份公共推荐顶上。
   *
   * 定义在 return 外面而不是挂成 `this.xxx`：平台对象被 `createPlatformApis`
   * 拆开后是随便传的，`this` 绑不住。
   */
  const personalDaily = async (): Promise<PlaylistDetail | null> => {
    /*
     * 这两条接口回的**不是同一个格式**，别再按一个写死：
     *   · `/api/v3/discovery/recommend/songs` → 新格式（`ar` / `al` / `dt` / `sq`），
     *     和 `normalize` 完全对齐，封面、时长、音质档位都能拿到；
     *   · `/api/v2/discovery/recommend/songs` → **老格式**（`artists` / `album` /
     *     `duration` / `hMusic`），根本没有 `al` 这个字段。
     *
     * 以前只打 v2 却用 `raw[0].al.picUrl` 取封面 → 永远是 undefined，于是
     * 「歌单广场那张每日推荐卡」和「详情页头图」两块一直是一片空白（列表本身是好的）。
     * 现在 v3 优先、v2 兜底，封面再退到第一首歌的专辑图，三条路都不空。
     */
    const csrf = /(?:^|;\s*)__csrf=([^;]+)/.exec(client.cookieFor?.('https://music.163.com/') ?? '')?.[1]
    const qs = csrf ? `?csrf_token=${encodeURIComponent(csrf)}` : ''
    for (const ver of ['v3', 'v2'] as const) {
      try {
        const j = await getJson(client, `https://music.163.com/api/${ver}/discovery/recommend/songs${qs}`, {
          headers: HEADERS, retry: 0,
        })
        if (Number(j?.code) !== 200) continue
        const raw: any[] = j?.data?.dailySongs ?? []
        const songs: SearchSong[] = raw.filter((x: any) => x?.id).map(normalize)
        if (!songs.length) continue
        // 老格式没有 al，退回 album.picUrl；再不行用第一首歌自己的专辑封面
        const first = raw[0]
        const own = cover(first?.al?.picUrl ?? first?.album?.picUrl) ?? songs[0]?.img
        return {
          id: 'daily:wy',
          source: 'wy',
          name: '每日推荐 · 按你的口味',
          cover: own,
          songCount: songs.length,
          songs,
          total: songs.length,
          hasMore: false,
        }
      } catch {
        /* 换下一个版本再试 */
      }
    }
    return null
  }

  return {
    source: 'wy',
    supportsSearch: true,
    supportsPlaylistSearch: true,
    supportsPlaylistDetail: true,
    supportsLyric: true,

    async search(keyword, page, limit): Promise<SearchResult> {
      const j = await postForm(client, 'https://music.163.com/api/cloudsearch/pc', {
        s: keyword,
        type: 1,
        limit,
        offset: (page - 1) * limit,
      }, { headers: HEADERS })
      const list: SearchSong[] = (j?.result?.songs ?? []).map(normalize)
      return { list, total: Number(j?.result?.songCount ?? list.length), source: 'wy' }
    },

    async searchPlaylist(keyword, page, limit): Promise<PlaylistSearchResult> {
      const j = await postForm(client, 'https://music.163.com/api/cloudsearch/pc', {
        s: keyword,
        type: 1000,
        limit,
        offset: (page - 1) * limit,
      }, { headers: HEADERS })
      const list: PlaylistSearchItem[] = (j?.result?.playlists ?? []).map((p: any) => ({
        id: String(p.id),
        source: 'wy' as const,
        name: clean(p.name),
        cover: cover(p.coverImgUrl),
        creator: clean(p.creator?.nickname),
        songCount: Number(p.trackCount ?? 0),
        playCount: Number(p.playCount ?? 0),
        detailSupported: true,
      }))
      return { list, total: Number(j?.result?.playlistCount ?? list.length), source: 'wy' }
    },

    /**
     * 热门歌单：`api/personalized/playlist`（个性化推荐，匿名可用）。
     *
     * 它和搜索接口不是一套：这里给的是「平台此刻正在推的歌单」，
     * 字段也只有 `picUrl / playCount / trackCount`，没有作者——卡片上就不显示作者，
     * 不去猜（`copywriter` 是推荐语不是作者，曾经被误当成作者名显示）。
     */
    async getHotPlaylists(page, limit): Promise<HotPlaylistResult> {
      const n = Math.min(Math.max(limit || 24, 1), 50)
      const offset = (Math.max(1, page) - 1) * n
      const j = await getJson(client,
        `https://music.163.com/api/personalized/playlist?limit=${n}&offset=${offset}&total=true&n=1000`,
        { headers: HEADERS })
      const list: HotPlaylistItem[] = (j?.result ?? []).map((p: any) => ({
        id: String(p.id),
        source: 'wy' as const,
        name: clean(p.name),
        cover: cover(p.picUrl),
        songCount: Number(p.trackCount ?? 0),
        playCount: Number(p.playCount ?? 0),
        detailSupported: true,
        intro: clean(p.copywriter) || undefined,
      }))
      // 这个接口不回首屏总数，只能按「这一页给满了就还有」判断
      return { list, hasMore: list.length >= n, source: 'wy' }
    },

    /**
     * 全部排行榜：`api/toplist` 一把给完（实测 65 个）。
     *
     * 网易云的榜单**本身就是一个歌单**——`toplist` 里的 `id`（热歌榜 3778678、
     * 飙升榜 19723756、新歌榜 3779629、原创榜 2884035）直接喂给
     * `api/v6/playlist/detail` 就能拿到全部曲目，所以这里只需要加前缀，
     * 取歌那段一行都不用写（`getPlaylistDetail` 会自己剥前缀）。
     * 顺序照平台给的来：它已经把「飙升 / 新歌 / 原创 / 热歌」放在最前面。
     */
    async getRanklists(): Promise<RankListResult> {
      const j = await getJson(client, 'https://music.163.com/api/toplist', { headers: HEADERS })
      const list: RankListItem[] = (j?.list ?? [])
        .filter((x: any) => x?.id)
        .map((x: any) => ({
          id: asRankId(x.id),
          source: 'wy' as const,
          name: clean(x.name),
          cover: cover(x.coverImgUrl),
          intro: clean(x.description) || clean(x.updateFrequency) || undefined,
          songCount: Number(x.trackCount ?? 0) || undefined,
          playCount: Number(x.playCount ?? 0) || undefined,
        }))
      return { list, source: 'wy' }
    },

    /**
     * 每日推荐。
     *
     * 只有一条路：`api/v2/discovery/recommend/songs` —— 账号自己的 30 首，
     * 和手机 App 里点开「每日推荐」看到的是同一份。
     * 未登录（接口回 `code:301`）就抛错：App 未登录时本来就没有每日推荐，
     * 拿 `api/personalized/newsong`（人人一样的官方新歌）顶替会让用户
     * 拿它跟手机里的日推逐首对照，然后问「为什么不一样」。
     */
    async getDailyRecommend(): Promise<PlaylistDetail> {
      const own = await personalDaily()
      if (!own) throw new Error('网易云的每日推荐要登录后才能看')
      return own
    },

    /**
     * 「为你推荐」歌单（登录后才有）。
     *
     * `api/v1/discovery/recommend/resource` 给 30 张账号相关的歌单，每条带
     * `copywriter`（「因为你听过…」），卡片上就用它当一句推荐语。
     * 未登录回 `code:301`，这里回 `null`——UI 用它决定显示登录引导而不是空列表。
     */
    async getForYouPlaylists(): Promise<HotPlaylistResult | null> {
      try {
        const j = await getJson(
          client,
          'https://music.163.com/api/v1/discovery/recommend/resource',
          { headers: HEADERS, retry: 0 },
        )
        if (Number(j?.code) !== 200 || !Array.isArray(j?.recommend)) return null
        const list: HotPlaylistItem[] = j.recommend
          .filter((p: any) => p?.id)
          .map((p: any) => ({
            id: String(p.id),
            source: 'wy' as const,
            name: clean(p.name),
            cover: cover(p.picUrl),
            creator: clean(p.creator?.nickname) || undefined,
            songCount: Number(p.trackCount ?? 0) || undefined,
            playCount: Number(p.playcount ?? p.playCount ?? 0) || undefined,
            detailSupported: true,
            intro: clean(p.copywriter) || undefined,
          }))
        if (!list.length) return null
        return { list, hasMore: false, source: 'wy' }
      } catch {
        return null
      }
    },

    /**
     * 自己建的歌单（「我喜欢的音乐」也在里面，它是 specialType 5 的自建歌单）。
     *
     * `api/user/playlist` 一次把「自建 + 收藏」全给回来，靠 `subscribed` 区分：
     * 收藏的 `subscribed === true`。收藏走疏音自己的「收藏的歌单」，这里只留自建，
     * 否则同一张歌单会在「我的」里出现两遍。
     *
     * 未登录时拿不到 uid → 返回 null（不去猜一个 uid 试）。
     */
    async getUserPlaylists(): Promise<HotPlaylistResult | null> {
      try {
        const acc = await getJson(
          client,
          'https://music.163.com/api/nuser/account/get',
          { headers: HEADERS, retry: 0 },
        )
        const uid = String(acc?.profile?.userId ?? '')
        if (!uid) return null
        // limit 给 200：自建歌单通常几十张，一次取完省得翻页
        const j = await getJson(
          client,
          `https://music.163.com/api/user/playlist?uid=${encodeURIComponent(uid)}&limit=200&offset=0`,
          { headers: HEADERS, retry: 0 },
        )
        const raw: any[] = Array.isArray(j?.playlist) ? j.playlist : []
        const list: HotPlaylistItem[] = raw
          .filter((p: any) => p?.id && !p.subscribed)
          .map((p: any) => ({
            id: String(p.id),
            source: 'wy' as const,
            name: clean(p.name),
            // 封面字段名换过几次（`coverImgUrl` 是主字段，模板歌单给 `coverUrl`），
            // 只认一个的话那批歌单会整片显示成音符占位
            cover: cover(p.coverImgUrl || p.coverUrl || p.picUrl),
            creator: clean(p.creator?.nickname) || undefined,
            /*
             * 「我喜欢的音乐」这类歌单 0 首也照样由接口返回，卡片摆在那儿点进去空列表。
             * 这里保留 0（不写成 `|| undefined`）：上层据此隐藏空歌单，
             * 而 `undefined` 会被当成「平台没给数量」，只能留着。
             */
            songCount: Number(p.trackCount ?? p.songCount ?? 0),
            playCount: Number(p.playCount ?? 0) || undefined,
            detailSupported: true,
          }))
        return list.length ? { list, hasMore: false, source: 'wy' } : null
      } catch {
        return null
      }
    },

    /** 当前登录的账号（未登录 200 + profile:null，按 null 处理） */
    async getAccount() {
      const j = await getJson(client, 'https://music.163.com/api/nuser/account/get', { headers: HEADERS })
      const p = j?.profile
      if (!p?.userId) return null
      return {
        nickname: clean(p.nickname) || clean(p.userName) || '网易云用户',
        avatar: https(p.avatarUrl) ?? undefined,
        userId: String(p.userId),
      }
    },

    /** 退出登录：只发出去，失败也不抛（本地 cookie 该删还是要删） */
    async logout() {
      await getJson(client, 'https://music.163.com/api/logout', { headers: HEADERS, retry: 0 }).catch(() => {})
    },

    async getPlaylistDetail(id, page = 1, limit = 500): Promise<PlaylistDetail> {
      // 榜单是「加了前缀的歌单 id」，剥掉就能走同一段逻辑
      const pid = rankRawId(id)
      const j = await getJson(client, `https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(pid)}&n=1000&s=0`, {
        headers: HEADERS,
      })
      const pl = j?.playlist ?? {}
      const all = (pl.tracks ?? []).map(normalize)
      const start = (page - 1) * limit
      return {
        id: String(pl.id ?? pid),
        source: 'wy',
        name: clean(pl.name),
        cover: cover(pl.coverImgUrl),
        creator: clean(pl.creator?.nickname),
        songCount: Number(pl.trackCount ?? all.length),
        songs: all.slice(start, start + limit),
        total: all.length,
        hasMore: start + limit < all.length,
      }
    },

    async getLyric(songmid) {
      const j = await getJson(client, `https://music.163.com/api/song/lyric?id=${encodeURIComponent(songmid)}&lv=1&kv=1&tv=-1`, {
        headers: HEADERS,
      })
      return { lyric: String(j?.lrc?.lyric ?? ''), tlyric: String(j?.tlyric?.lyric ?? '') }
    },

    async getPic(song) {
      if (song.img) return song.img
      const j = await getJson(client, `https://music.163.com/api/song/detail?ids=%5B${encodeURIComponent(song.id)}%5D`, {
        headers: HEADERS,
      })
      return cover(j?.songs?.[0]?.album?.picUrl) ?? ''
    },

    /**
     * 评论。
     *
     * 走 `api/v1/resource/comments/R_SO_4_{songId}` —— 这个老接口**不需要加密**
     * （w/eapi 那套要 AES + RSA，前端做不了也没必要）。它一次给两段：
     *   · `hotComments` 热门（没有这一组时是空数组）
     *   · `comments` 按时间倒序的常规列表
     * 两段内容会重叠，所以下面按 id 去重。
     *
     * 楼中楼：`beReplied` 是「被回复的那条」，直接挂在评论上；
     * 完整的回复列表要另打一次 `R_SO_4_{id}` 的 reply 接口，首屏不做（点开再说）。
     */
    async getComments(song, page = 1, limit = 20): Promise<CommentPage> {
      const offset = (page - 1) * limit
      const j = await getJson(client,
        `https://music.163.com/api/v1/resource/comments/R_SO_4_${encodeURIComponent(song.id)}`
        + `?limit=${limit}&offset=${offset}`, { headers: HEADERS })
      const hot: SongComment[] = page === 1 ? (j?.hotComments ?? []).map(toComment) : []
      const seen = new Set(hot.map(c => c.id))
      const list: SongComment[] = (j?.comments ?? []).map(toComment).filter((c: SongComment) => {
        if (seen.has(c.id)) return false
        seen.add(c.id)
        return true
      })
      const total = Number(j?.total ?? 0) || list.length
      return { list, total, hasMore: !!j?.more || offset + list.length < total, hot }
    },
  }
}
