/**
 * 洛雪接入层的公共类型。
 *
 * 分两层，不要混：
 *   1. 平台 API 层（platforms/*）—— 搜索、歌单、歌词、封面，走各平台公开接口
 *   2. 音源脚本层（SourceManager）—— 只解决「搜到了但播不了」，产出可播放 URL
 */

/** 平台标识，和洛雪音源脚本里 `sources` 的 key 完全一致 */
export type PlatformSource = 'kw' | 'kg' | 'tx' | 'wy' | 'mg'

export const PLATFORM_NAMES: Record<PlatformSource, string> = {
  kw: '酷我',
  kg: '酷狗',
  tx: 'QQ音乐',
  wy: '网易云',
  mg: '咪咕',
}

export const ALL_PLATFORMS: PlatformSource[] = ['wy', 'tx', 'kw', 'kg']

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

export interface HttpRequestOptions {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** 毫秒，默认 10000 */
  timeout?: number
  responseType?: 'json' | 'text' | 'arraybuffer'
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  /** responseType=json 时是对象，其余是字符串；arraybuffer 时是 Uint8Array */
  body: any
}

/**
 * 平台 API 层唯一允许的出网方式。
 * 桌面端由 Rust `net_request` 实现（绕开 WebView 的 CORS），
 * 移动端将来用 RN 的 fetch 实现。**层内不得直接调 fetch。**
 */
export interface HttpClient {
  request(options: HttpRequestOptions): Promise<HttpResponse>
  /**
   * 这个地址能拿到的**登录 cookie**（只读，没登录就是 undefined）。
   *
   * 平台层本身不持有账号状态，但有些平台的接口必须把「谁在问」写进请求体
   * （QQ 的 `comm.uin` / `comm.authst` 就是），所以留这一个口子。
   * 出网时会不会真的带上 cookie 由实现方按域名决定，平台层不要拿它做鉴权判断。
   */
  cookieFor?(url: string): string | undefined
}

/* ------------------------------------------------------------------ */
/* 搜索 / 歌单 归一化模型                                               */
/* ------------------------------------------------------------------ */

/** 归一化后的在线歌曲 */
export interface SearchSong {
  /** 平台内唯一 id（songmid / rid / hash 等） */
  id: string
  source: PlatformSource
  name: string
  singer: string[]
  albumName: string
  albumId?: string
  /** 秒 */
  interval: number
  img?: string
  /** 洛雪 musicUrl 所需的原始标识（wy 是数字 id，kg 是 hash，tx 是 songmid） */
  songmid?: string
  /**
   * 平台原始对象。**必须保留**：
   * 不同音源脚本对 musicInfo 的字段要求不同（长青只认 songmid / hash），
   * 只给归一化字段会有一半场景取不到播放链接。
   */
  raw: unknown
  /**
   * 这首歌在平台上**真实存在**的音质档位（key 与音源脚本一致：`128k` / `320k` / `flac` …）。
   *
   * 为什么不能只看音源声明：音源脚本声明的是「我这个源支持哪些档位」，
   * 是平台级的。拿它当每首歌的菜单，就会出现「这首根本没有无损，菜单里却有无损，
   * 点下去必然失败」——用户看到的是「音质切换不过去」。
   * `undefined` 表示平台没给这个信息，UI 退回音源声明。
   */
  qualities?: string[]
}

export interface SearchResult {
  list: SearchSong[]
  total: number
  source: PlatformSource
}

export interface PlaylistSearchItem {
  id: string
  source: PlatformSource
  name: string
  cover?: string
  creator?: string
  songCount?: number
  playCount?: number
  /** 该平台的歌单详情是否可用（四个平台都已支持，UI 据此决定卡片能不能点进去） */
  detailSupported?: boolean
}

export interface PlaylistSearchResult {
  list: PlaylistSearchItem[]
  total: number
  source: PlatformSource
}

/**
 * 歌单广场里的一条「热门 / 推荐歌单」。
 *
 * 比搜索结果多两样：`intro`（推荐语，卡片上最多显示两行）和 `tag`（平台分类，
 * 例如酷我的「华语,伤感」）。都是可选的——拿不到就不显示，不编造。
 */
export interface HotPlaylistItem extends PlaylistSearchItem {
  /** 平台给的推荐语 / 简介 */
  intro?: string
  /** 平台分类标签（逗号分隔的原文，UI 自己切） */
  tag?: string
}

export interface HotPlaylistResult {
  list: HotPlaylistItem[]
  /** 还有下一页（广场滚到底部时按它决定要不要继续拉） */
  hasMore: boolean
  source: PlatformSource
}

/* ------------------------------------------------------------------ */
/* 排行榜                                                              */
/* ------------------------------------------------------------------ */

/**
 * 榜单 id 的前缀。
 *
 * 排行榜在界面上就是「一个能点进去听的歌单」，所以它跟歌单**共用同一个入口**
 * `getPlaylistDetail(id)`，靠这个前缀分流。这样详情页、我的收藏、断点恢复
 * 那几处调用点一行都不用改，也就不会出现「从收藏点进去取不到歌」。
 */
export const RANK_PREFIX = 'rank:'

export const isRankId = (id: string): boolean => id.startsWith(RANK_PREFIX)
/** 去掉前缀，拿到平台自己的榜单标识 */
export const rankRawId = (id: string): string => (isRankId(id) ? id.slice(RANK_PREFIX.length) : id)
/** 平台榜单标识 → 全局唯一的歌单 id */
export const asRankId = (rawId: string | number): string => RANK_PREFIX + String(rawId)

export interface RankListItem {
  /** 已经是 `rank:<平台标识>`，可以直接当歌单 id 用 */
  id: string
  source: PlatformSource
  name: string
  cover?: string
  /** 榜单说明 / 更新频率，卡片上最多两行 */
  intro?: string
  /** 所属分组（QQ 的「巅峰榜」、酷我的「官方」）；网易云和酷狗不分 */
  group?: string
  songCount?: number
  playCount?: number
}

export interface RankListResult {
  list: RankListItem[]
  source: PlatformSource
}

export interface PlaylistDetail {
  id: string
  source: PlatformSource
  name: string
  cover?: string
  creator?: string
  songCount?: number
  /** 当前页拿到的歌曲 */
  songs: SearchSong[]
  /** 平台声明的总数（可能大于 songs.length，说明还有下一页） */
  total: number
  /** 是否还有下一页 */
  hasMore: boolean
}

/** 平台账号资料（登录后才有） */
export interface PlatformAccountInfo {
  nickname: string
  avatar?: string
  userId: string
}

/** 平台 API 模块 */
export interface PlatformApi {
  source: PlatformSource
  /** 该平台是否有搜索能力 */
  supportsSearch: boolean
  /** 该平台是否有歌单搜索 */
  supportsPlaylistSearch: boolean
  supportsPlaylistDetail: boolean
  supportsLyric: boolean
  search(keyword: string, page: number, limit: number): Promise<SearchResult>
  searchPlaylist?(keyword: string, page: number, limit: number): Promise<PlaylistSearchResult>
  /**
   * 平台此刻在推的歌单（歌单广场用）。
   *
   * 和 `searchPlaylist` 的区别：这里没有关键词，**只翻页**。
   * 四个平台的数据源各不相同（网易云是个性化推荐、QQ 是按热度排的推荐歌单、
   * 酷我是「热门歌单」、酷狗是手机站精选集），但都是「打开就有一屏能听的」。
   * 没实现的平台在广场里不出现胶囊，不做假数据兜底。
   */
  getHotPlaylists?(page: number, limit: number): Promise<HotPlaylistResult>
  /**
   * 平台的全部排行榜（热歌榜 / 飙升榜 / 新歌榜 …）。
   *
   * 数量不多（十几到六十几个），一次全给，不分页也不带参数。
   * 返回的 `id` 已经带上 `rank:` 前缀，拿去调 `getPlaylistDetail` 就能取歌。
   * 没实现的平台在广场里就不显示「排行榜」那一排。
   */
  getRanklists?(): Promise<RankListResult>
  /**
   * 平台「每日推荐」：账号专属的那一份（返回结构当歌单用）。
   *
   * 多数平台（wy/tx/kg）就是它 App 里「每日推荐」的登录态接口，
   * Windows 上看到的和手机 App 里是同一批歌；未登录抛错、没实现也抛错，
   * 上层据此让整块不显示——**不做「拿热门歌单顶替」的假推荐**。
   *
   * 例外：kw（酷我）App 的日推只认合作方 AppId，第三方拿不到账号那份
   * （`code=10004`，2026-10 结案），所以 kw 用「飙升榜 + 按天洗牌」自建：
   * 免登录可用、按天变化，但**内容是榜单池不是官方日推**，名字要写清楚。
   */
  getDailyRecommend?(): Promise<PlaylistDetail>
  /**
   * 平台的每日推荐是否**免登录可用**。
   *
   * 不声明（默认）= 需要登录，前端未登录直接挡住；声明 `true` 的平台
   * （目前只有 kw）未登录也放行——它的日推是免登录榜单池洗出来的，
   * 登录只影响洗牌种子（带 uid 更个性），不拦。
   */
  dailyWithoutLogin?: boolean
  /**
   * 登录态的「为你推荐」歌单（账号个性化，不是平台热榜）。
   *
   * 未登录 / 拿不到时返回 `null` —— UI 据此决定「显示这一段」还是「显示登录引导」，
   * 不要用空数组假装「今天没有推荐」。
   */
  getForYouPlaylists?(): Promise<HotPlaylistResult | null>
  /**
   * 登录账号**自己建的**歌单（不含收藏别人的）。
   *
   * 未登录返回 `null`：UI 用它决定「我的」页面要不要显示这一段，
   * 而不是显示一个空壳区块。
   */
  getUserPlaylists?(): Promise<HotPlaylistResult | null>
  /** 当前登录的账号资料；未登录返回 `null` */
  getAccount?(): Promise<PlatformAccountInfo | null>
  /** 通知平台注销当前会话（退出登录时调，别只删本地 cookie） */
  logout?(): Promise<void>
  getPlaylistDetail?(id: string, page?: number, limit?: number): Promise<PlaylistDetail>
  getLyric?(songmid: string, id?: string): Promise<{ lyric: string; tlyric?: string }>
  getPic?(song: SearchSong): Promise<string>
  /** 歌曲评论（含楼层回复与图片）。没有实现的平台在 UI 上说「该平台暂不支持评论」 */
  getComments?(song: SearchSong, page?: number, limit?: number): Promise<CommentPage>
  /**
   * 楼层回复（楼中楼）。
   *
   * 首屏评论里通常只带前几条回复，甚至一条都不带（酷狗就是这样，只给
   * `reply_num` 这个数量），展开「N 条回复」时再按需取。
   * 没实现的平台沿用首屏里自带的那几条，UI 也不会给「加载更多」。
   */
  getReplies?(song: SearchSong, comment: SongComment, page?: number, limit?: number): Promise<CommentPage>
}

/* ------------------------------------------------------------------ */
/* 评论                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一条评论。
 *
 * `replyTo` 与 `replies` 是两种不同的东西，别混：
 *   · `replyTo` —— 楼中楼里「回复 @某人」的那一条，只有一条，用来在正文上方标出来；
 *   · `replies` —— 这条评论下的回复列表（平台一次只给前几条，剩下的要点开）。
 */
export interface SongComment {
  id: string
  user: string
  avatar?: string
  content: string
  /** 正文里带的图片（网易云 richContent / QQ pic）。正文里对应的位置会被替换成占位 */
  images: string[]
  /** 秒级时间戳（0 = 未知） */
  time: number
  likes: number
  /** 被回复的那条（楼中楼父评论） */
  replyTo?: { user: string; content: string }
  /** 楼层回复（可能为空） */
  replies?: SongComment[]
  /**
   * 回复总数（平台声明的）。
   *
   * 和 `replies.length` 不是一回事：首屏只塞前几条，甚至一条都不塞。
   * UI 用它决定「展开」按钮上写多少条，以及展开后还要不要「加载更多」。
   */
  replyTotal?: number
  /**
   * 平台原始对象。
   *
   * 只给平台自己的后续请求用（例如酷狗楼中楼必须带这条评论的
   * `special_child_id`），**UI 不要读它**。
   */
  raw?: any
  /** IP 属地（网易云给） */
  location?: string
  /** 自己点的赞——只影响按钮状态，不做服务端写入 */
  liked?: boolean
}

export interface CommentPage {
  list: SongComment[]
  total: number
  hasMore: boolean
  /** 热门评论（网易云单独给一组；其它平台为空） */
  hot?: SongComment[]
}

/* ------------------------------------------------------------------ */
/* 音源脚本层                                                          */
/* ------------------------------------------------------------------ */

/** 单个音源对某个平台的声明 */
export interface SourceSupport {
  source: PlatformSource
  qualitys: string[]
  actions: string[]
}

export type SourceStatus = 'loading' | 'ready' | 'error'

export interface LoadedSource {
  /** 文件路径的稳定 hash，用作 id */
  id: string
  /** 脚本 meta.name，没有就退回文件名 */
  name: string
  version?: string
  author?: string
  filePath: string
  status: SourceStatus
  error?: string
  /** 该音源会主动外联的域名（如长青的统计/更新检查），用于在设置页提示 */
  outbound: string[]
  supports: SourceSupport[]
}

/** 音源脚本能拿到的宿主接口。桌面端与移动端实现必须一致。 */
export interface LxHostAdapter {
  /** 读取目录下的脚本文件 */
  listScripts(dir: string): Promise<Array<{ path: string; name: string; code: string }>>
  /**
   * 执行一个脚本，等它 `send(EVENT_NAMES.inited)`。
   * 超时或抛错都要 reject，并把错误信息带出来（不要静默）。
   */
  load(script: { id: string; code: string; filePath: string }, signal?: AbortSignal): Promise<LxLoadedScript>
  /** 卸载 / 停止某个脚本 */
  dispose(id: string): Promise<void>
}

export interface LxLoadedScript {
  inited: LxInitPayload
  /** 向脚本要一个播放链接，返回 Promise<string> */
  requestMusicUrl(source: PlatformSource, musicInfo: unknown, quality: string, timeoutMs?: number): Promise<string>
  /** 脚本自己吐出来的日志（调试用） */
  logs: string[]
}

/** `send(EVENT_NAMES.inited, payload)` 的结构 */
export interface LxInitPayload {
  openDevTools?: boolean
  meta?: {
    name?: string
    desc?: string
    version?: string
    author?: string
    homepage?: string
    [k: string]: unknown
  }
  sources: Record<string, {
    name?: string
    type?: string
    actions?: string[]
    qualitys?: string[]
    [k: string]: unknown
  }>
}

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

/** 所有已启用音源都拿不到链接 */
export class NoPlayableSourceError extends Error {
  readonly source: PlatformSource
  readonly attempts: Array<{ sourceId: string; sourceName: string; error: string }>
  /** 人话总结（一句话说清「为什么播不了」） */
  readonly brief: string
  constructor(source: PlatformSource, attempts: Array<{ sourceId: string; sourceName: string; error: string }>) {
    /*
     * 提示条只有一行空间，所以分两层：
     *   前半句是「人话结论」——用户真正需要的（没版权？要会员？超时？）
     *   后半句是「哪个源为什么」——排查时需要的，截得很短
     * 以前把每个源的原始报错直接拼上去，一条 150 字的红条糊在屏幕上，
     * 用户既看不懂又挡住了播放条。
     */
    const brief = briefReason(attempts.map(a => String(a.error)))
    /*
     * 只给结论，不拼「哪个源报了什么」。
     * 以前把源名 + 原始报错拼在括号里，用户看到的是一行看不懂的技术噪音
     * （「…（Kugou：直链不可用 HTTP 403；wy：…）」），红条还特别长。
     * 源名和原因留在 `attempts` 里给「换源」和排查用，不进 UI 文案。
     */
    super(attempts.length
      ? brief
      // 搜索不依赖播放源，只有「出直链」这一步需要——提示里必须说清，否则用户会以为连搜索都错了
      : '还没有可用的播放源：去「设置 → 在线音源」导入一个')
    this.name = 'NoPlayableSourceError'
    this.source = source
    this.attempts = attempts
    this.brief = brief
  }
}

/** 把一堆原始报错归纳成一句人话 */
export function briefReason(errors: string[]): string {
  const s = errors.join(' ').toLowerCase()
  if (!errors.length) return '暂时取不到播放地址，稍后再试'
  if (/403|401|forbidden|denied|no permission|http\s*40[34]|直链不可用/.test(s)) return '播放地址已失效，点「换源」试试'
  if (/vip|会员|版权|付费/.test(s)) return '这首歌需要会员才能听'
  if (/timeout|超时|timed out/.test(s)) return '网络有点慢，取地址超时了'
  if (/空|empty/.test(s)) return '没拿到可用的播放地址'
  if (/非法的播放地址/.test(s)) return '播放地址不合法，点「换源」试试'
  if (/未声明|不支持|no such|not support/.test(s)) return '这个平台暂时不支持'
  return '暂时取不到播放地址，稍后再试'
}

/** 网络层错误（带状态码，方便上层区分 403 / 404） */
export class HttpError extends Error {
  readonly status: number
  readonly url: string
  constructor(url: string, status: number, detail?: string) {
    super(`请求失败 ${status}${detail ? `：${detail}` : ''}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

/**
 * 平台临时不可用（限流 / 冷却中）。
 *
 * 和真正的失败要分开：这类错误不该在搜索页糊一条红字——它自己会恢复，
 * 用户什么也做不了。UI 应该弱化成一句「已暂时跳过」。
 */
export class PlatformBusyError extends Error {
  readonly source: PlatformSource
  readonly retryAfterMs: number
  constructor(source: PlatformSource, retryAfterMs: number, message?: string) {
    super(message ?? `${PLATFORM_NAMES[source]} 请求过于频繁，${Math.ceil(retryAfterMs / 1000)} 秒后自动恢复`)
    this.name = 'PlatformBusyError'
    this.source = source
    this.retryAfterMs = retryAfterMs
  }
}
