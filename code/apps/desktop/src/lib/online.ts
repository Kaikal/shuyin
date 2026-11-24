/**
 * 在线音乐层（模块级单例）。
 *
 * 三块拼在一起：
 *   1. 平台 API（搜索 / 歌单 / 歌词 / 封面）—— 走 Rust `net_request` 绕 CORS
 *   2. 音源脚本（SourceManager + Worker 宿主）—— 只负责把「搜到的歌」换成「能播的直链」
 *   3. 在线曲目注册表 —— 队列里只放 `LocalTrack`，在线曲目靠 id 前缀 + 这张表还原上下文
 *
 * 为什么曲目还要伪装成 LocalTrack：队列状态机（@shuyin/core）和整个播放条 /
 * 歌词 / 频谱 UI 全是按 LocalTrack 写的。加一个平行类型会把改动扩散到几十个文件；
 * 只在这一层做映射，播放源分支在 PlayerProvider 的 startLoad 里，符合「不改播放核心」。
 */
import type { LocalTrack } from '@shuyin/core'
import {
  PLATFORM_NAMES, SoftVerifyError, SourceManager,
  createPlatformApis,
  type PlatformApi, type PlatformSource, type PlaylistDetail, type SearchSong,
  type HotPlaylistResult, type HotPlaylistItem,
  type HttpClient,
} from '@shuyin/lx-provider'
import { createTauriHttpClient } from './tauriNet'
import { createLxWorkerHost } from './lxWorkerHost'
import { bridge } from './bridge'
import { KEYS, settings } from './settings'
import { bootPlatformAccounts, cookieOf, setProfileLoader, accountOf } from './platformAccount'
import { bareTitle, titleMismatch, versionMismatch } from './titleMatch'

/* ------------------------------------------------------------------ */
/* 单例                                                                */
/* ------------------------------------------------------------------ */

/** 原始客户端：音源脚本那条链用它（第三方脚本的出网行为保持原样，别塞账号 cookie） */
export const onlineHttp = createTauriHttpClient()

/**
 * 平台 API 用的客户端 = 原始客户端 + 账号 cookie。
 *
 * 为什么在这一层拼而不是各平台自己写：cookie 是**按域名**归属的，
 * 而每个平台的接口分散在十几个 host 上；在请求出口统一加一次，
 * 平台层（以及以后新加的接口）一行都不用改。
 * 只在登录过该平台时才有 cookie，未登录时行为和以前完全一致。
 */
const COOKIE_HOSTS: Array<[RegExp, PlatformSource]> = [
  [/(^|\.)music\.163\.com$/i, 'wy'],
  // QQ 音乐的接口散在 y.qq.com 的子域上（u./c./i.），凭证（qm_keyst / qqmusic_key）
  // 落在 .y.qq.com。以前这里只挂了网易云，QQ 登录成功也等于没登录——
  // musicu 的所有登录态接口都拿不到 comm.uin/authst，界面就一直没有「每日推荐 / 我的歌单」。
  [/(^|\.)y\.qq\.com$/i, 'tx'],
  // 酷我：接口在 nplserver./wapi./search.kuwo.cn，登录凭证（userid / kw_token）落在 .kuwo.cn
  [/(^|\.)kuwo\.cn$/i, 'kw'],
  // 酷狗：gateway./mobiles./m.kugou.com，登录凭证（KuGoo / token / userid）落在 .kugou.com
  [/(^|\.)kugou\.com$/i, 'kg'],
]

/** 合并 cookie：同名以调用方（平台自己那几条 appver 之类的）为准，登录凭证补在后面 */
function mergeCookie(existing: string | undefined, login: string): string {
  const bag = new Map<string, string>()
  for (const part of (existing ?? '').split(';')) {
    const [k, ...rest] = part.split('=')
    const name = k?.trim()
    if (name) bag.set(name, rest.join('=').trim())
  }
  for (const part of login.split(';')) {
    const [k, ...rest] = part.split('=')
    const name = k?.trim()
    if (name && !bag.has(name)) bag.set(name, rest.join('=').trim())
  }
  return [...bag].map(([k, v]) => `${k}=${v}`).join('; ')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

const apiHttp: HttpClient = {
  async request(opts) {
    const host = hostOf(opts.url)
    const platform = host ? COOKIE_HOSTS.find(([re]) => re.test(host))?.[1] : undefined
    const login = platform ? cookieOf(platform) : undefined
    if (!login) return onlineHttp.request(opts)
    const headers = { ...(opts.headers ?? {}) }
    const key = Object.keys(headers).find(k => k.toLowerCase() === 'cookie')
    headers[key ?? 'Cookie'] = mergeCookie(key ? headers[key] : undefined, login)
    return onlineHttp.request({ ...opts, headers })
  },

  /** 给平台层读 uin / 票据用（QQ 的 musicu 要把它们写进 comm） */
  cookieFor(url) {
    const host = hostOf(url)
    const platform = host ? COOKIE_HOSTS.find(([re]) => re.test(host))?.[1] : undefined
    return platform ? cookieOf(platform) : undefined
  },
}

const APIS = createPlatformApis(apiHttp)
const API_MAP = new Map<PlatformSource, PlatformApi>(APIS.map(a => [a.source, a]))

/* 账号资料由平台层取，platformAccount 只管存——依赖方向单向：
   这里 import 它，它不 import 这里（否则循环引用会把模块初始化顺序搞乱）。
   平台层没接账号接口（QQ / 酷狗 / 酷我 目前就是这样）时**抛错而不是回 null**：
   `null` 的意思是「平台明确说没登录」，那会让这三家一登录就被自己的校验踢下线；
   抛错落到 `unknown`，凭证先留着。 */
setProfileLoader(source => {
  const api = apiFor(source)
  if (!api?.getAccount) return Promise.reject(new Error(`${source} 暂不支持查看账号资料`))
  return api.getAccount()
})
void bootPlatformAccounts()

export function apiFor(source: PlatformSource): PlatformApi | undefined {
  return API_MAP.get(source)
}

export function platformName(source: PlatformSource): string {
  return PLATFORM_NAMES[source] ?? source
}

/**
 * 校验用的「这首歌本来该有多长」是**随每次取链传下去**的，不再是模块级变量。
 *
 * 以前用模块级 `expect`（注释里写着「并发时后一轮覆盖前一轮可以接受」）。
 * 那条假设在「多个平台同时开跑」之后就不成立了：自家平台和兜底平台是并行的，
 * 后设的那次会把前面那次的时长覆盖掉，于是校验拿着**另一个平台那条**的时长去判，
 * 正常文件也会被判成「不是这首歌」。现在走 `getMusicUrl` 的 `expectDuration`。
 */

/** 平均码率的合理区间（kbps）。真音乐在 64~5000 之间，越过这两条线基本可以确定不是这首歌 */
const MIN_KBPS = 48
const MAX_KBPS = 6500


export const sourceManager = new SourceManager({
  host: createLxWorkerHost({ client: onlineHttp }),
  /**
   * 出链后真拉一次（Range 2KB）：签名过期 / 要 Referer / 返回 HTML 错误页都在这步暴露，
   * 挡在播放器前面，用户就不会看到「搜得到、点一首坏一首」。
   *
   * 2026-10 追加：**顺便校验「这个文件是不是这首歌」**。
   * 有些源对拿不到版权的歌不回错误，而是回一段试听 / 静音 / 甚至别的歌——
   * 播出来就是「封面写着富士山下，声音不是它」。用总字节数除以曲目时长得到平均码率，
   * 落在正常区间之外就判这一档失败，让降级链继续换档 / 换源。
   */
  verify: async (url, exp) => {
    // 时长太短（<45s）的歌不判：搜索结果给的时长误差在里面占比太大
    // 连探测都省掉——这一步是真实网络请求，不值得为校验不了的歌付这笔钱
    const want = exp?.duration ?? 0
    if (want < 45) return
    const info = await bridge.probeAudioInfo(url)
    /*
     * 非 2xx = 地址本身不可用（签名过期 / 要不要 Referer / 已下架）。
     * **硬失败**：这种地址放给播放器只会换来一条「源错误」，不如在这一步就换源。
     * 只在 status 明确 >= 400 时判——有些服务器对 Range 请求回 206/304，
     * 还有少数干脆不回状态（0），那些不能当失败。
     */
    if (info.status >= 400) throw new Error(`直链返回 HTTP ${info.status}（地址可能已过期）`)
    /*
     * 下面的失败分「软」「硬」两类，这个区分决定了**网络慢的时候能不能出声**：
     *
     *   硬：文件里写着另一首歌 / 另一个版本 —— 放出来就是错的，绝不放过；
     *       时长不到声明的一半 —— 那是试听片段，放出来用户听到 30 秒就断了。
     *   软：码率偏低、时长差十几秒、探测超时 —— 多半是「平台时长标得糙」或「网慢」。
     *       严格路径全灭之后允许拿它兜底（见 SoftVerifyError），否则用户看到的是
     *       「洛雪能播，你这儿没有可用音源」。
     */
    if (info.total && info.total > 0) {
      const kbps = (info.total * 8) / want / 1000
      if (kbps < MIN_KBPS || kbps > MAX_KBPS) {
        /* 码率低到 48 以下更像「30 秒试听被当成整首」：样本太短，按硬失败处理 */
        const msg = `音频与歌曲信息不符（约 ${Math.round(kbps)} kbps / ${Math.round(want)} 秒）`
        if (kbps < MIN_KBPS) throw new Error(msg)
        throw new SoftVerifyError(url, '', msg)
      }
    }
    /*
     * 硬指标：文件头里的真实时长。
     *
     * 2026-10 实测踩到的：搜「花海 (DJ 阿若版)」（声明 210 秒），某个音源给的 FLAC
     * 解出来是邓紫棋《唯一》——253.7 秒，标签里连专辑都写着 T.I.M.E.。
     * 旧的平均码率校验算出来 1943 kbps，正落在合理区间，完全拦不住；
     * 而听感上是「标题写着花海，耳机里唱的是唯一」，用户第一秒就发现了。
     *
     * 同一首歌的翻唱 / 重制最多差几秒，差几十秒就是另一首歌。
     * 容差取「10 秒」和「6%」里更宽的那个：既挡住错歌，又不误杀
     * 平台时长本来就标得糙的那些（官方 3:30、实际 3:41 这种很常见）。
     */
    const tol = Math.max(10, want * 0.06)
    if (info.duration > 0 && Math.abs(info.duration - want) > tol) {
      const msg = `音源给的不是这首歌（实际 ${Math.round(info.duration)} 秒 / 应为 ${Math.round(want)} 秒）`
      /*
       * 短到不足声明时长的 60% —— 试听片段、截断文件、"前奏版"。
       * 这个**必须硬拦**：放出来用户听三十秒就没了，比播不了更让人困惑。
       * 其余的（长十几秒 / 短十几秒）更像平台时长标得糙，留作兜底候选。
       */
      if (info.duration < want * 0.6) throw new Error(msg)
      throw new SoftVerifyError(url, '', msg)
    }
    /*
     * 最后一道：**音频文件自己写的歌名**。
     *
     * 时长拦不住「长度几乎一样的两首歌」。实测栽过两次：
     *   · 《花海》→ 邓紫棋《唯一》（253.7 秒）
     *   · 《孤勇者》（256 秒）→ 还是《唯一》（253.7 秒，差 2.3 秒，稳稳在 6% 容差里）
     * 两次都是某个音源把这条 id 解析成了别处的文件，校验全绿、耳机里是另一首歌。
     *
     * 文件里带着 TITLE 就是硬证据。只在**两边都有正经歌名**且互相完全不包含时判失败：
     *   · 标签是空的（大量 m4a / 无标签源）→ 跳过，不误杀
     *   · 「花海」vs「花海 (DJ 阿若版)」→ 去掉括号后缀后互相包含 → 放行
     *   · 「孤勇者」vs「唯一」→ 完全不沾边 → 判失败，让降级链换下一档 / 换源
     */
    const tagTitle = (info.title || '').trim()
    if (titleMismatch(tagTitle, exp?.title)) {
      throw new Error(`音源给的不是这首歌（文件里写的是《${tagTitle}》）`)
    }
    /*
     * 最后一道之二：**版本**。
     *
     * 上面那条只比「核心歌名」——括号里的东西整块被丢掉，于是
     * 《寂寞才说爱》和《寂寞才说爱 (DJ版)》被当成同一首。用户 2026-11 报的就是
     * 「日推点原版，出来的是 DJ 版，歌词还全对不上」。
     * 文件标签里写着 DJ / 混音 / 伴奏，而我们要的是原版 → 判失败，让降级链
     * 换源、换平台（跨平台那条会按版本扣分，挑到真正的原版）。
     */
    if (versionMismatch(tagTitle, exp?.title)) {
      throw new Error(`音源给的是另一个版本（文件里写的是《${tagTitle}》，要的是《${exp?.title ?? '原版'}》）`)
    }
  },
})

/* ------------------------------------------------------------------ */
/* 跨平台兜底缓存                                                       */
/* ------------------------------------------------------------------ */

/**
 * 「同一首歌在别的平台上的那条」。
 *
 * 为什么需要这张表：第三方音源经常**只有某一个平台**能出链接
 * （比如网易云挂了、酷狗还有），而用户搜到的这条是挂在网易云上的。
 * 让用户自己点「换源」「换平台」是把实现细节推给用户，体感就是「这软件不好用」。
 * 一旦兜底成功，这里记下「这首 → 酷狗那条」，下次直接走它，省掉一轮必然失败的等待。
 */
const subs = new Map<string, SearchSong>()

/** 这首歌**实际**会从哪个平台取链（兜底过就是兜底那次的结果） */
export function effectiveSong(trackId: string): SearchSong | undefined {
  return subs.get(trackId) ?? registry.get(trackId)
}

/** 兜底换过平台时给 UI 用的一句话；没换过返回 null */
export function substitutedTo(trackId: string): SearchSong | null {
  return subs.get(trackId) ?? null
}

export function forgetSubstitute(trackId: string) {
  subs.delete(trackId)
}

/* ------------------------------------------------------------------ */
/* 在线曲目 ↔ LocalTrack                                               */
/* ------------------------------------------------------------------ */

const ONLINE_PREFIX = 'online:'

/** id 形如 `online:wy:3381542797` */
export const onlineId = (s: { source: PlatformSource; id: string }) => `${ONLINE_PREFIX}${s.source}:${s.id}`

export const isOnlineTrack = (t: { id: string } | null | undefined): boolean =>
  !!t && t.id.startsWith(ONLINE_PREFIX)

/**
 * 「这条不是歌，是旧版误落盘的播放缓存副本」。
 *
 * 0.6.96 及更早，播放缓存复用了「下载」那条命令，缓存文件被发布到了公共音乐
 * 目录，名字是 `online_<平台>_<歌曲id>.<ext>`（见 `DownloadStore.isCacheCopyName`）。
 * 这些文件被系统媒体库收成了正常的歌：流式落盘没有 ID3，标题就取了文件名。
 * 于是曲库里多出一批「online_wy_1341482370 / 未知歌手」的条目，点开还能响，
 * 播放条上赫然写着文件名。
 *
 * 用户 2026-11 报的「标题偶尔变成 online_tx_xxx.mp3」就是它——不是标题渲染出错，
 * 是队列里真的躺着这样一条**本地曲目**。
 *
 * 壳里已经不再收录它们（`Library.kt` 的 `name.startsWith("online_")`），
 * 但用户手机上那份队列存档还是旧的：恢复时把非在线曲目、标题却是这个形状的
 * 条目丢掉，否则它会一直跟着队列跑到下一次存盘。
 */
export function isCacheCopyTrack(t: { id: string; title?: string } | null | undefined): boolean {
  if (!t || isOnlineTrack(t)) return false
  return /^online_[a-z]{2}_[0-9a-z]+(\.\w{2,5})?$/i.test((t.title ?? '').trim())
}

const registry = new Map<string, SearchSong>()

/* 搜索结果落盘：重启后队列里那些在线曲目还能播。
   以前只放在内存里，退出再进就「曲目已失效」，用户只能重新搜一遍。 */
const REG_KEY = 'online.songs'
/**
 * 注册表最多留多少条。
 *
 * 2026-11 从 300 提到 1500：一张洛雪歌单动辄三四百首，导入后这些 id 全得靠
 * 注册表还原（歌单只存 id）。300 的窗口装不下一张歌单，重启后前半张会直接
 * 变成「找不到的 id」——歌单里凭空少歌，而且没有任何提示。
 * 单条 SearchSong 约 0.4KB，1500 条约 600KB 存档，安卓的 localStorage 也装得下。
 */
const REG_KEEP = 1500
let regBooted: Promise<void> | null = null
let regTimer = 0

function bootRegistry(): Promise<void> {
  if (!regBooted) {
    regBooted = settings.get<SearchSong[]>(REG_KEY).then(list => {
      if (!Array.isArray(list)) return
      for (const s of list) {
        if (!s?.id || !s.source) continue
        registry.set(onlineId(s), s)
      }
    }).catch(() => { /* 读不到就当空 */ })
  }
  return regBooted
}

/**
 * 等在线曲目注册表从存档里读出来。
 * 恢复播放队列时要先等它：队列里那些 `online:…` 曲目只能从这里还原，
 * 没等的话一整条在线队列会被当成「找不到的 id」丢光（重启后播放列表变空）。
 */
export const ensureRegistry = (): Promise<void> => bootRegistry()

/**
 * 「钉住」的曲目：播放队列里正在用的那些。
 *
 * 注册表只留最近 [REG_KEEP] 条搜索结果。用户隔几天再打开，队列里那几首
 * 早被新搜索刷出去了 —— 恢复播放时 `songOf` 返回 undefined，界面上就是
 * 「每次打开都提示音源问题，但去歌单里点同一首又能播」（2026-11 华为实测：
 * 队列 23 首**全部**不在注册表里）。
 * 队列里的歌不参与淘汰，避免这个死循环。
 */
const pinned = new Set<string>()

/** 队列变化时由播放层调一次：这批 id 永远留在注册表里 */
export function pinSongs(ids: Array<string | null | undefined>): void {
  pinned.clear()
  for (const id of ids) if (id) pinned.add(id)
}

function persistRegistry() {
  window.clearTimeout(regTimer)
  regTimer = window.setTimeout(() => {
    // 只留最近的 REG_KEEP 条：Map 的插入顺序就是使用顺序，超出从头砍
    const all = [...registry.values()]
    const keep = all.slice(Math.max(0, all.length - REG_KEEP))
    /* 队列里的歌必须留下：被挤掉就等于「这首歌的搜索信息丢了」 */
    const kept = new Set(keep.map(s => onlineId(s)))
    for (const id of pinned) {
      if (kept.has(id)) continue
      const s = registry.get(id)
      if (s) { keep.push(s); kept.add(id) }
    }
    void settings.set(REG_KEY, keep).catch(() => {})
  }, 1200)
}

export function songOf(trackId: string): SearchSong | undefined {
  return registry.get(trackId)
}

/**
 * 按 id 还原一条可渲染 / 可播放的曲目（**只对在线曲目有用**）。
 *
 * 本地歌单里除了曲库曲目，还可能存着从平台歌单收进来的在线曲目 id
 * （`online:平台:歌曲id`）。它们不在曲库里，渲染歌单时得靠注册表还原，
 * 否则「加入歌单」加进去的歌会凭空消失。
 */
export function trackOfId(trackId: string): LocalTrack | undefined {
  const s = registry.get(trackId)
  return s ? toLocalTrack(s) : undefined
}

/** 注册表还没从存档里读出来时（冷启动直接点播放）先等它一下 */
export async function songOfAsync(trackId: string): Promise<SearchSong | undefined> {
  await bootRegistry()
  return registry.get(trackId)
}

/** 把平台搜索结果登记进注册表，并转成可入队的 LocalTrack */
export function toLocalTrack(song: SearchSong): LocalTrack {
  const id = onlineId(song)
  registry.set(id, song)
  persistRegistry()
  return {
    id,
    // 在线曲目没有本地路径：播放时走 play_url，其余 UI 只看 title/artist/cover
    path: '',
    title: song.name,
    artist: song.singer.join(' / '),
    album: song.albumName,
    duration: song.interval,
    format: 'mp3',
    bitrate: null,
    sampleRate: null,
    cover: song.img ?? null,
    mtime: 0,
    size: 0,
  }
}

export const toLocalTracks = (songs: SearchSong[]): LocalTrack[] => songs.map(toLocalTrack)

/* ------------------------------------------------------------------ */
/* 每日推荐                                                            */
/* ------------------------------------------------------------------ */

/** 当天日期键（本地时区）：推送内容按天变，当天内保持不变 */
function dayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 一天的缓存：切页面 / 反复点进详情不重复打网络 */
const DAILY = new Map<string, { day: string; data: PlaylistDetail }>()

/**
 * 丢掉每日推荐缓存。
 *
 * 登录 / 退出后必须调：缓存里那份是「换账号之前」取回来的
 * （日推是账号专属的 30 首），不清就会一直显示上一个账号的。
 */
export function clearDailyCache() {
  DAILY.clear()
  MINE.clear()
}

/** 「我建的歌单」缓存：一次会话里变化很少，登录 / 退出（clearDailyCache）时清掉 */
const MINE = new Map<string, { at: number; data: HotPlaylistResult | null; error?: string }>()
const MINE_TTL = 10 * 60_000

/** 「我的歌单」的取数结果：`error` 只在**真的失败**时才有值（未登录不算） */
export interface MinePlaylists {
  list: HotPlaylistItem[]
  error?: string
}

/**
 * 登录账号自己建的歌单（「我的」页面用）。
 *
 * 未登录直接返回空，**不发请求**：平台会回 301，白白多一条错误日志。
 * 缓存键带账号，换号之后不能还显示上一个人的歌单。
 *
 * 为什么要单独返回 `error`：酷狗的云歌单只认 App 签发的 token，用网页登录
 * 拿到的凭证打过去会回 `20017`。以前这里把异常吞成 `null`，界面看起来
 * 就是「登录了，但一张歌单都没有」——用户完全不知道是接口拿不到。
 *
 * **失败的结果绝对不写缓存**（2026-11 修）。以前成功、失败都塞进 `MINE`：
 * 断网那次拿到的 error 会被当成「10 分钟内的有效答案」，
 * 连调用方那句「失败重试一次」也会命中同一份缓存——重试照样拿回同一个错误，
 * 用户看到的就是「第一次没联网，之后它一直是加载失败」。
 * 现在失败只返回、不入表；`force` 连成功缓存也跳过，给「重试」按钮用。
 */
export async function minePlaylists(
  source: PlatformSource,
  opts: { force?: boolean } = {},
): Promise<MinePlaylists> {
  const api = apiFor(source)
  const acc = accountOf(source)
  if (!api?.getUserPlaylists || !acc) return { list: [] }
  const key = `${source}:${acc.userId || acc.cookie.slice(-24)}`
  if (!opts.force) {
    const hit = MINE.get(key)
    if (hit && Date.now() - hit.at < MINE_TTL) return { list: hit.data?.list ?? [], error: hit.error }
  }
  try {
    const data = await api.getUserPlaylists()
    MINE.set(key, { at: Date.now(), data })
    return { list: data?.list ?? [] }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return { list: [], error }
  }
}

/**
 * 同上，只要结果（拿不到就是 `null`）。
 *
 * 保留这个签名是因为调用方多数只关心列表；需要解释「为什么没有」的地方
 * 用 `minePlaylists`。
 */
export async function userPlaylists(source: PlatformSource): Promise<HotPlaylistResult | null> {
  const { list } = await minePlaylists(source)
  return list.length ? { list, hasMore: false, source } : null
}

/**
 * 某个平台的「每日推荐」。多数平台（wy/tx/kg）= **账号自己的那份**，和手机 App
 * 里点开每日推荐看到的是同一批歌。
 *
 * 例外是酷我：App 日推只认合作方 AppId（`code=10004`，2026-10 结案），第三方
 * 拿不到账号那份，所以 kw 的实现是「飙升榜 + 按天洗牌」——免登录可用、按天
 * 变化，但内容是榜单池不是官方日推，歌单名里写清楚了。它声明
 * `dailyWithoutLogin: true`，未登录也放行；其余平台维持老规矩。
 *
 * 三条硬规矩：
 *   · 未登录直接抛错（kw 除外），**不拉公共推荐流冒充**——手机 App 未登录就
 *     没有每日推荐，这边也不能自己造一个「今日精选」出来给人对照；
 *   · 平台没实现 `getDailyRecommend` 同样抛错，由界面整块不显示，
 *     不做「拿热门歌单顶替」这种假数据（四家现在都已实现：wy/tx/kg/kw）；
 *   · 不再有「取不到就换一个歌单」的兜底，失败就是失败。
 */
export async function dailyRecommend(source: PlatformSource): Promise<PlaylistDetail> {
  const api = apiFor(source)
  if (!api) throw new Error('该平台暂不可用')
  if (!api.getDailyRecommend) throw new Error('该平台没有每日推荐')
  const acc = accountOf(source)
  if (!acc && api.dailyWithoutLogin !== true) throw new Error('登录后才能看每日推荐')
  // 缓存键带账号：换号之后不能还显示上一个人的 30 首；免登录的 kw 用固定 'anon'
  // 优先用 userId；资料接口没回来的那次退回 cookie 尾部（一样能区分会话）
  const who = acc ? (acc.userId || acc.cookie.slice(-24)) : 'anon'
  const key = `${source}:${who}:${dayKey()}`
  const hit = DAILY.get(key)
  if (hit) return hit.data

  const data = await api.getDailyRecommend()
  /*
   * 平台层没给封面时，用第一首歌的专辑图顶上：每日推荐那张卡和详情页头图
   * 都是「有封面才画」的，`cover` 空着就是一块空白（网易云 v2 接口就是这么空的）。
   */
  const filled: PlaylistDetail = data.cover ? data : { ...data, cover: data.songs[0]?.img }
  DAILY.set(key, { day: dayKey(), data: filled })
  return filled
}

/**
 * 混排时的「一家贡献几首」。
 *
 * 四家各 8 首 → 32 首，正好是「打开就能连着听一两个小时」的量；
 * 再多意义不大（用户听完前几首就会切歌单），而且会拖慢首屏。
 *
 * 这也是滑块上每一块**默认**占的宽度：四家各 8 首 = 一条平均分的条。
 */
export const MIX_PER = 8

/**
 * 单家上限。
 *
 * 滑块让用户把总数按比例分给几家，某一家完全可能被分到十几首
 * （「今天就想多听网易云」）。这里不能再用 `MIX_PER` 卡上限——
 * 砍回 8 首会直接破坏「拖完总数不变」这件事。
 */
const MIX_CAP = 32

/** 混排只收这几家：和「歌单广场」的平台列表保持一致 */
const MIX_SOURCES: PlatformSource[] = ['wy', 'tx', 'kg', 'kw']

/**
 * 各平台在混排里的权重 = **这家出几首**（0 表示这次不要它）。
 *
 * 不用百分比而用「首数」：用户能直接对上「这一批里有几首 QQ 的」，
 * 调完立刻在条上的「N 首」和详情页里看到结果，不用脑内换算。
 */
export type RecoWeights = Partial<Record<PlatformSource, number>>

/** 默认四家各 8 首：和加权重之前完全一样，升级不会突然变味 */
export const DEFAULT_RECO_WEIGHTS: RecoWeights = {
  wy: MIX_PER, tx: MIX_PER, kg: MIX_PER, kw: MIX_PER,
}

export interface MixOptions {
  /**
   * 第几批。
   *
   * 0 = 平台自己给的原序（默认，和以前一致）；≥1 = 按这个种子洗牌后再取，
   * 于是「换一批」换的是**同样池子里的不同子集 + 不同顺序**，
   * 不会因为换一次就多打一轮网络（日推本身按天缓存着）。
   */
  seed?: number
  weights?: RecoWeights
}

/**
 * 最近一次用的参数。
 *
 * 详情页（`daily:mix`）是无参调用 `dailyMix()` 的——首页换到第 3 批再点进去，
 * 详情页必须看到**同一批**，否则「查看全部」和条上写的首数对不上。
 * 所以参数记在模块里，无参调用沿用上一次。
 */
let lastMix: Required<MixOptions> = { seed: 0, weights: DEFAULT_RECO_WEIGHTS }

/** 确定性伪随机（mulberry32）：同一个 seed 换到同一批，翻页回来也不会变 */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 从池子里取 n 首：seed=0 走原序，否则先洗牌 */
function pickSeeded<T>(arr: T[], n: number, seed: number): T[] {
  if (n <= 0) return []
  if (seed === 0) return arr.slice(0, n)
  const out = [...arr]
  const rand = mulberry32(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out.slice(0, n)
}

/**
 * 「今天听什么」—— 把各平台的**账号个性化推荐**混成一条。
 *
 * 为什么不按平台分开看：歌单广场里每家各有一张「每日推荐」卡，但那是
 * 「挑一个平台」的思路；用户真正的场景是「不知道听什么，随便给我点」，
 * 这时候让他先选平台、再挑歌，等于把问题推回去。
 *
 * 三条规矩：
 *   · 只用**真·个性化**的接口（wy/tx/kg 的账号日推）；酷我是榜单洗牌，
 *     也收进来，但它在各自卡片上写明来源，不在这里冒充「你的口味」；
 *   · 一家失败不影响别家（`catch → null`），全失败才报错；
 *   · 交错排序：第 1 首来自 A、第 2 首来自 B……避免前 8 首全是一个平台。
 *
 * 权重（`weights`）决定两件事：**这家出几首**，以及**每轮谁先出**
 * ——权重高的排在前面，于是第一屏就偏它。权重 0 的平台不但不出歌，
 * 连请求都不发。
 */
export async function dailyMix(opts: MixOptions = {}): Promise<PlaylistDetail> {
  const seed = Math.max(0, Math.floor(opts.seed ?? lastMix.seed))
  const weights = opts.weights ?? lastMix.weights
  lastMix = { seed, weights }

  const wOf = (s: PlatformSource): number => {
    const v = weights[s]
    /*
     * 上限给到 32（四家 × 8）：滑块把「这一批 32 首」按比例分给各家，
     * 某一家被拖到十几首时不能在这里被悄悄砍回 8 首——那正好会破坏
     * 「拖完总数不变」。真正的约束在界面上：分给这一家多，别家就少。
     */
    return typeof v === 'number' ? Math.max(0, Math.min(MIX_CAP, Math.floor(v))) : MIX_PER
  }

  const srcs = MIX_SOURCES.filter(s => {
    if (wOf(s) <= 0) return false
    const api = apiFor(s)
    if (!api?.getDailyRecommend) return false
    return !!accountOf(s) || api.dailyWithoutLogin === true
  })
  if (!srcs.length) throw new Error('登录任意一个平台，就能看到按你口味推的歌')

  /*
   * 缓存键带「参与的平台 + 各自的账号 + 第几批 + 权重」：换号 / 多登一个平台 /
   * 换一批 / 改权重，混排内容都必须跟着变，否则会一直显示上一份。
   */
  const who = srcs.map(s => `${s}:${accountOf(s)?.userId || 'anon'}`).join(',')
  const wSig = srcs.map(s => `${s}${wOf(s)}`).join('')
  const key = `mix:${who}:${dayKey()}:${seed}:${wSig}`
  const hit = DAILY.get(key)
  if (hit) return hit.data

  const parts = await Promise.all(srcs.map(async s => {
    try {
      const d = await dailyRecommend(s)
      return { source: s, name: d.name, w: wOf(s), songs: pickSeeded(d.songs, wOf(s), seed) }
    } catch {
      /* 单家抽风（限流 / 未生成 / 没登录）就当它今天没推荐 */
      return null
    }
  }))
  const pools = parts.filter((x): x is { source: PlatformSource; name: string; w: number; songs: SearchSong[] } => !!x && x.songs.length > 0)
  if (!pools.length) throw new Error('今天各平台的推荐都取不到，稍后再试')

  /*
   * 交错取：一轮一首，直到每家都取完。
   *
   * 权重高的先出（`b.w - a.w`），这样「QQ 调到 8 首、酷我 2 首」时，
   * 前几首确实以 QQ 为主，而不是四家平均轮着来。
   */
  const ordered = [...pools].sort((a, b) => b.w - a.w)
  const songs: SearchSong[] = []
  const maxW = Math.max(...ordered.map(p => p.songs.length))
  for (let i = 0; i < maxW; i++) {
    for (const p of ordered) {
      const s = p.songs[i]
      if (s) songs.push(s)
    }
  }
  const data: PlaylistDetail = {
    id: 'daily:mix',
    // 混排没有单一来源，`source` 只是给类型一个落点；UI 不拿它去请求
    source: ordered[0].source,
    name: `为你推荐 · ${ordered.map(p => platformName(p.source)).join(' / ')}`,
    cover: songs[0]?.img,
    songCount: songs.length,
    songs,
    total: songs.length,
    hasMore: false,
  }
  DAILY.set(key, { day: dayKey(), data })
  return data
}

/**
 * 「第几批」的订阅者。
 *
 * 首页那条横卡和它的详情页（`daily:mix`）是**两块各自取数**的界面，但
 * 「现在是第几批」只能有一个答案：以前详情页里换一批，退回首页还是老那一批，
 * 再点进去又变成新的——两张脸对不上。所以换成一处改、两边跟着改。
 */
const MIX_SEED_SUBS = new Set<(seed: number) => void>()

/** 订阅「换一批」：返回退订函数。回调里直接拿新的 seed 去重取即可 */
export function subscribeMixSeed(fn: (seed: number) => void): () => void {
  MIX_SEED_SUBS.add(fn)
  return () => { MIX_SEED_SUBS.delete(fn) }
}

/**
 * 重新抽一批。
 *
 * 只是把 seed 往前推一格——日推池本身还是当天那 30 首（平台不会因为
 * 你刷新就换歌），但取哪些、什么顺序都变了，听感就是「新的一批」。
 *
 * 顺手广播出去：首页的横卡和详情页都在听，谁在场谁跟着重取。
 */
export function nextMixSeed(): number {
  const seed = lastMix.seed + 1
  lastMix = { ...lastMix, seed }
  for (const fn of MIX_SEED_SUBS) {
    /* 某个订阅方炸了不能连带别家不更新（比如详情页已经卸载又被通知） */
    try { fn(seed) } catch { /* 忽略 */ }
  }
  return seed
}

/* ------------------------------------------------------------------ */
/* 音质                                                                */
/* ------------------------------------------------------------------ */

const QUALITY_LABELS: Record<string, string> = {
  '128k': '标准',
  '192k': '较高',
  '320k': '高品质',
  flac: '无损',
  flac24bit: 'Hi-Res',
  hires: 'Hi-Res',
  atmos: '全景声',
  atmos_plus: '全景声+',
  master: '母带',
}

export const qualityLabel = (q: string): string => QUALITY_LABELS[q] ?? q

/**
 * 音质「层次」：用来判断某次降档**值不值得提醒用户**。
 * 0/1/2 是有损三档，3 是常规无损，4 是各种高码率（母带 / 全景声）。
 */
export function qualityTier(q: string): number {
  if (q === '128k') return 0
  if (q === '192k') return 1
  if (q === '320k') return 2
  if (q === 'flac' || q === 'flac24bit' || q === 'hires') return 3
  return 4
}

/**
 * 这次降档该不该说。
 *
 * 用户在设置里选了「母带」，绝大多数歌最高只到 Hi-Res——每一首都弹一句「已降到 Hi-Res」，
 * 提示就变成了噪音，用户反而觉得这软件一直在报问题。只在**实质听感会差**的时候说：
 * 无损掉成有损（flac → 320k/128k）、或者 320k 掉成 128k。母带 → Hi-Res 不打扰。
 */
export function qualityDropMatters(requested: string, got: string): boolean {
  const a = qualityTier(got)
  const b = qualityTier(requested)
  if (b <= a) return false
  return (b >= 3 && a <= 2) || (b === 2 && a === 0)
}

/**
 * 标题里写着「原唱 X」/「翻唱 X」，但歌手不是 X —— 这条音频是翻唱（或改编）版。
 *
 * 平台自己起的标题常常长这样：「晴天 (原唱 周杰伦)」，歌手栏却是「RyaVocal」。
 * 用户看到的是「名字说周杰伦、歌手说别人」，第一反应是「软件把歌放错了」。
 * 平台的标题我们改不了，但可以把「这是翻唱」这件事显式标出来，
 * 让人一眼知道：听到的是翻唱，不是原唱那一版。
 */
export function coverInfo(title: string, artist: string): { original: string } | null {
  const m =
    title.match(/[（(\[【]\s*(?:原唱|原曲)\s*[:：]?\s*([^)）\]】]+)[)）\]】]/i) ??
    title.match(/(?:翻唱|cover(?:ed)?\s*(?:by|from)?)\s*[:：]?\s*([^)）\]】]+)$/i)
  const original = m?.[1]?.trim()
  if (!original) return null
  const a = normText(artist)
  const o = normText(original)
  if (!a || !o) return null
  // 歌手本身就是「原唱」本人（或名字互相包含）时不算翻唱
  if (a.includes(o) || o.includes(a)) return null
  return { original }
}

/** 音质档位（低 → 高）。UI 的下拉按这个顺序排，音源没声明的档位置灰。 */
export const QUALITY_CHOICES = [
  '128k', '192k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master',
]

/**
 * 菜单里该出现哪些档位。
 *
 * 用户的原话是「有的歌曲没有这些音质，但还是会显示这些音质但是又切换不过去」，
 * 所以这里的取舍是**不显示**而不是置灰：一个点不动的选项对用户没有信息量，
 * 只会让人以为「这软件坏了」。只有一种情况退回全档位——音源还没装载完
 * （`available` 为空），那时置灰反而能说明「还没就绪」。
 */
export function qualityChoicesFor(available: string[]): string[] {
  const list = QUALITY_CHOICES.filter(q => available.includes(q))
  return list.length ? list : QUALITY_CHOICES
}

export async function getPreferredQuality(): Promise<string> {
  return (await settings.get<string>(KEYS.onlineQuality)) ?? '320k'
}

export async function setPreferredQuality(q: string): Promise<void> {
  await settings.set(KEYS.onlineQuality, q)
}

/**
 * 当前曲目真正可选的档位 = 平台说「这首歌有」∩ 音源说「我能取」。
 *
 * 之前直接用 `sourceManager.qualitysFor(platform)` —— 那是**平台级**声明：
 * 音源支持无损，菜单里就永远有无损，可绝大多数歌根本没有无损文件，
 * 点了必然失败（或者在降级链里悄悄退回 320k，用户看到的是「切了没变化」）。
 *
 * 交集为空时退回音源声明而不是给空菜单：宁可让用户试一次并且失败得明白，
 * 也不要让音质下拉变成一片空白。
 */
export function usableQualities(track: LocalTrack | null | undefined): string[] {
  if (!track || !isOnlineTrack(track)) return []
  // 兜底换过平台的话，档位要按**真正出链的那个平台**算，否则菜单里还是原来平台的档位。
  // 但**不能只按它算**——兜底平台往往只声明标准档，取并集前的行为就是
  // 「切一次标准，高音质选项整个消失」（2026-11-21 实测）。原平台与兜底平台
  // 的声明档位取并集；用户想切回高音质时 changeQuality 会清掉兜底记录回原平台重取。
  const song = effectiveSong(track.id)
  if (!song) return []
  const origin = registry.get(track.id)
  const substituted = !!origin && origin !== song
  const declared = new Set(sourceManager.qualitysFor(song.source))
  if (substituted) for (const q of sourceManager.qualitysFor(origin.source)) declared.add(q)
  let own = song.qualities
  if (substituted && origin.qualities?.length) {
    own = Array.from(new Set([...(own ?? []), ...origin.qualities]))
  }
  if (!own?.length) return QUALITY_CHOICES.filter(q => declared.has(q))
  const both = own.filter(q => declared.has(q))
  const out = both.length ? both : Array.from(declared)
  return QUALITY_CHOICES.filter(q => out.includes(q))
}

/* ------------------------------------------------------------------ */
/* 取播放链接                                                          */
/* ------------------------------------------------------------------ */

export interface ResolvedPlay {
  url: string
  /** 实际出链的音源 id（换源时排除用） */
  sourceId: string
  quality: string
  qualityLabel: string
  sourceName: string
  /** 实际出链的平台（可能不是用户搜索时那个——跨平台兜底会换） */
  platform: PlatformSource
  platformName: string
  /** 用户/设置要求的音质（和 `quality` 不同说明降档了） */
  requestedQuality: string
  /** true = 换平台了 */
  switched: boolean
  /**
   * true = 这一轮**刚刚**决定了平台（不是复用上次兜底、也不是命中直链缓存）。
   * UI 只对「刚发生」的换平台/降档弹一句提示，重播同一首不再重复打扰。
   */
  fresh: boolean
  /** 这首音频的预期秒数（换平台后可能和原曲目不同，进度条要用它） */
  duration: number
  /** 兜底匹配到的歌名（换平台且标题有差异时给 UI 说明用） */
  matchedName?: string
  /**
   * 兜底匹配到那条音频的歌手。
   *
   * 为什么必须带回来：用户在 A 平台点的可能是「某首歌」，兜底到 B 平台找到的可能是
   * **另一个人的版本**（翻唱 / 重制）。这时界面上继续显示 A 平台的歌手，就等于
   * 「歌手和实际在放的音频不是同一个人」——用户的原话。有了这个字段，界面就能
   * 在歌手不一致时显示**真正在唱的人**，而不是原来的元数据。
   */
  matchedSinger?: string
  /**
   * true = 这条地址**没通过落地校验**（严格路径全灭之后的兜底）。
   *
   * 取链时探测超时、时长差十几秒这类「软失败」会走到这里。能播的概率很高
   * （地址是音源正常出链的），但也有可能是错歌。UI 上要让用户看得见，
   * 否则「为什么这首听起来有点不对劲」会变成一个查不出来的谜。
   */
  unverified?: boolean
}

/* ------------------------------------------------------------------ */
/* 直链缓存                                                            */
/* ------------------------------------------------------------------ */

/**
 * 直链缓存：同一首歌 + 同一档音质，20 分钟内复用上一次的直链。
 *
 * 两件事一起解决：
 *   1. 「播放能出声、点下载却说取不到地址」——下载走的就是这里，
 *      复用播放刚拿到的直链，成功率自然和播放一致；
 *      音源接口有的一次性签名、有的按分钟限流，重取一遍反而更容易失败。
 *   2. 切歌回来 / 重播同一首不用再走一遍「脚本 → 平台 → 探活」。
 *
 * 直链本身有有效期，所以 TTL 取得保守（20 分钟），过期就当没有。
 */
const URL_TTL = 20 * 60 * 1000
const urlCache = new Map<string, ResolvedPlay & { at: number }>()
const urlKeyOf = (trackId: string, quality: string) => `${trackId}|${quality}`

/** 「换源」要的是**另一个**音源，不能命中缓存；跳过平台时更不能（缓存里就是那段试听） */
const canReuse = (opts: { exclude?: string[]; sourceId?: string; skipPlatform?: PlatformSource }) =>
  !opts.exclude?.length && !opts.sourceId && !opts.skipPlatform

export function forgetResolved(trackId: string) {
  for (const k of [...urlCache.keys()]) {
    if (k.startsWith(trackId + '|')) urlCache.delete(k)
  }
}

/* ------------------------------------------------------------------ */
/* 跨平台找同一首歌                                                     */
/* ------------------------------------------------------------------ */

/** 兜底顺序：酷狗 / 酷我 的第三方接口最稳，其次网易云，然后 QQ、咪咕 */
const FALLBACK_ORDER: PlatformSource[] = ['kg', 'kw', 'wy', 'tx', 'mg']

/**
 * 匹配及格线。低于它就是「同名不同歌」，宁可不播也不给用户放错。
 *
 * 2026-11 从 62 提到 68。真正起作用的不是这个数字（见 `scoreMatch` 的歌手权重），
 * 而是「门槛 + 歌手必须对上」两条一起：光靠歌名拼分数再也凑不到及格线。
 */
const MATCH_MIN = 68

/**
 * 「可以抢跑」的分数。
 *
 * 兜底泳道在 [HEDGE_MS] 就起跑，是为了「本平台卡住时别让用户干等」。但它有个
 * 副作用（2026-11 用户报「原版放出 DJ 版」）：本平台只是**慢**、还没失败，
 * 兜底就已经从别的平台搜到一条歌名相似、歌手对不上的版本抢先返回了。
 *
 * 所以分档：歌名精确 + 歌手命中 + 时长对得上（≈118 分）这种「几乎肯定是同一首歌」
 * 的候选可以抢跑；其余（74、80 这类靠歌名拼出来的）**必须等主泳道真的失败**。
 */
const EARLY_MIN = 100

/** 归一化：去括号内容（Live / Remix / 伴奏）、去 feat、去标点空格，全部小写 */
const normText = (s: string): string =>
  (s || '')
    .toLowerCase()
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
    .replace(/\b(feat|ft)\.?\s.*$/, '')
    .replace(/[\s·・\-_—–/\\.,'"，。、！？:：;；|]+/g, '')

/** 二元组重合率（0~1）。中文按字比很容易「差一个字就完全不同」，二元组稳得多 */
function bigramScore(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (s: string) => {
    const out = new Set<string>()
    if (s.length === 1) out.add(s)
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const A = grams(a)
  const B = grams(b)
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / Math.max(1, Math.min(A.size, B.size))
}

/** 这些字眼说明「不是同一首歌的人声版」，翻出来放给用户等于放错了 */
const INSTRUMENTAL = /伴奏|纯音乐|纯享|消音|instrumental|off\s?vocal|karaoke/i

/**
 * 给「另一个平台的搜索结果」打分。
 *
 * 三件事各有权重：歌名（主）、歌手（次）、时长（交叉验证）。
 * 时长是防「同名不同歌」的关键——翻唱、钢琴版、串烧的标题可能一模一样，
 * 但时长差几十秒，那就不该被当成同一首。
 */
function scoreMatch(
  target: { name: string; singer: string[]; interval: number },
  cand: SearchSong,
): number {
  const tn = normText(target.name)
  const cn = normText(cand.name)
  const title = bigramScore(tn, cn)
  let s = title * 60
  if (tn && tn === cn) s += 15

  const tArts = target.singer.map(normText).filter(Boolean)
  const cArts = cand.singer.map(normText).filter(Boolean)
  const artistHit = tArts.some(a => cArts.some(b => a === b || b.includes(a) || a.includes(b)))
  /*
   * 歌手对不上 = 基本不是同一首（2026-11 加重）。
   *
   * 以前只扣 8 分，等于没有：中文歌名的 bigram 分普遍很高，「歌名完全一致」
   * 就有 75+15=90，扣 8 之后 82 照样过线——于是用户点原版，播出来的是别人翻唱。
   * 跨平台兜底是我们自己发明的路径（洛雪不做这件事，它按 id 取链），
   * 这条路要自己守住「同一个人唱的」这条底线。
   *
   * 两种不判的情况：
   *   · 候选没写歌手（大量冷门文件）→ 无从比较，不加不减；
   *   · 歌手名字互相包含（「周杰伦」vs「周杰伦/Jay Chou」）→ 上面已经算命中。
   */
  const bothHaveArtist = tArts.length > 0 && cArts.length > 0
  if (artistHit) s += 28
  else if (bothHaveArtist) s -= 40

  if (target.interval > 0 && cand.interval > 0) {
    const d = Math.abs(cand.interval - target.interval)
    if (d <= 3) s += 15
    else if (d <= 8) s += 6
    else if (d > 30) s -= 22
  }
  // 伴奏 / 纯音乐：宁可这首不播，也不能把伴奏当原曲放出来
  if (INSTRUMENTAL.test(cand.name)) s -= 45
  /*
   * 版本对不上就重罚，判据与出链校验**同一套**（`versionMismatch`）。
   *
   * 兜底搜索是「按歌名找另一家」，而「寂寞才说爱」和「寂寞才说爱 (DJ版)」
   * 在四家平台上都同时存在、时长还常常只差几秒——光看歌名和时长，DJ 版
   * 完全可能拿最高分。用户点的明明是原版，耳机里却是咚鼓，歌词自然全错。
   *
   * 扣分幅度必须**大过满分**（歌名 75 + 歌手 28 + 时长 15 ≈ 118，及格线 68）。
   * 以前按 -45 算过：DJ 版靠「歌名完全一致 + 歌手一致 + 时长接近」能拿 73，
   * 照样过线被选中——等于没拦。现在落到 48，稳稳出局。
   */
  if (versionMismatch(cand.name, target.name)) s -= 70
  return s
}

interface CrossHit {
  platform: PlatformSource
  matched: SearchSong
  score: number
  url: string
  sourceId: string
  sourceName: string
  quality: string
}

interface CrossFail {
  errors: string[]
}

const shortErr = (e: unknown) => {
  const s = e instanceof Error ? e.message : String(e)
  return s.length > 22 ? s.slice(0, 22) + '…' : s
}

/**
 * 排障开关：`<html data-debug-skip-own="1">` 时跳过「本平台」这一级，直接走跨平台兜底。
 *
 * 存在的理由：跨平台兜底只有在**原平台真的挂了**时才走，而平时很难人为制造这种状态
 * （第三方音源大部分时候是好的），这条路径就永远测不到、坏在哪也不知道。
 * 打开它以后，任何在线曲目都直接从别的平台找同一首歌，用 CDP 就能量到真实结果。
 *
 * 为什么读 DOM 属性而不是 localStorage：这个 WebView 里 localStorage 是**内存级**的
 * （setItem 之后 `length` 仍是 0，刷新就没了），CDP 里设的值模块读不到。
 * 属性挂在 documentElement 上，两条路径看到的是同一个 DOM，最可靠。
 */
const skipOwnPlatform = (): boolean => {
  try {
    return document.documentElement.dataset.debugSkipOwn === '1'
  } catch {
    return false
  }
}

/**
 * 在原平台之外，找同一首歌并取链。
 *
 * 这是这一版的核心：以前降级链只在**同一个平台**的音源之间换，
 * 遇到「网易云没这首 / 音源只支持酷狗」就必然失败，只能由用户去点「换源」。
 * 现在换来的是「平台」，用户不需要知道音源脚本、也不需要知道平台。
 *
 * **每个平台一条独立流水线**（2026-10 改）：`搜 → 打分 → 取链` 串在自己的 Promise 里，
 * 平台之间 `Promise.any` 竞速，谁先拿出能播的链接用谁。
 *
 * 曾经是「所有平台搜完（Promise.all）→ 挑最高分的 → 再一起取链」。
 * 那个写法看起来更「公平」，实际把**最慢的那次搜索**放到了关键路径上：
 * 网易云 300ms 就回来了，酷我卡到 2 秒，用户就得陪着等满 2 秒才开始取链。
 * 现在谁先搜完谁先取链，互不牵连。挑错的版本由落地校验（时长比对）兜着，
 * 不会再出现「明明搜到了却放的是另一首」。
 */
/** 从 `online:kg:xxx` 里取平台 */
function platformOfTrackId(id: string): PlatformSource | null {
  const m = /^online:([a-z]+):/.exec(id)
  return (m?.[1] as PlatformSource) ?? null
}

/**
 * 注册表里没有这首歌时，用 track 上的歌名 / 歌手重新搜一条回来。
 *
 * 为什么需要它：队列落盘只存 id + 展示字段，真正的「搜索信息」（平台原始
 * 数据 `raw`）在注册表里。注册表是**最近 300 条**的滚动窗口，隔几天再打开，
 * 队列里的老歌早被新搜索挤掉了 —— 旧代码直接抛「这首歌的搜索信息已过期，
 * 请重新搜一次」，用户看到的是「每次打开都提示音源问题」，可去歌单里点
 * 同一首又能播（那边刚搜过、注册表里有）。歌名歌手都还在 track 上，
 * 重搜一次就好，搜到的写回注册表，下次冷启动直接命中。
 *
 * 先搜原平台（hash 最准、时长一致），再按兜底顺序换别家。
 */
/** 同一组「歌名 + 歌手」的搜索只发一次（连点切歌时 6 次查找会变成 1 次） */
const findJobs = new Map<string, Promise<SearchSong | null>>()

async function findSongByTrack(track: LocalTrack, bail?: () => void): Promise<SearchSong | null> {
  const name = (track.title || '').trim()
  if (!name) return null
  const singers = (track.artist || '').split(/\s*[/、]\s*/).map(s => s.trim()).filter(Boolean)
  /*
   * 带 `bail` 的那条路（播放取链）**不进去重表**。
   *
   * 去重是为了「补封面的 effect 重跑时别重复发同一个请求」，那一类不会被取消。
   * 而播放这条路会被下一首顶掉、中途作废——把作废结果喂给另一个等同一首歌的调用方，
   * 就成了「明明能搜到，却跟着一起报过期」。宁可多发一次搜索，也不串味。
   */
  if (bail) return searchTrackByKeyword(name, singers, track, 5_000, bail)
  const key = `${name}|${singers.join('/')}|${platformOfTrackId(track.id) ?? ''}`
  const running = findJobs.get(key)
  if (running) return running
  const job = searchTrackByKeyword(name, singers, track, 5_000)
  findJobs.set(key, job)
  try {
    return await job
  } finally {
    findJobs.delete(key)
  }
}

/**
 * 真的去搜：逐平台问，挑分最高的那条。
 *
 * `timeoutMs` 分两轮用：第一轮 5 秒（正常的搜索一秒内就回来了）；
 * 一家都没**答上话**（全是被超时/网络错误打回来的）时再来一轮 8 秒。
 *
 * 为什么要分：连点「下一首」会一次并发几十个请求，原生的命令线程池排队排满之后，
 * 请求根本发不出去，5 秒超时一到就被判成「没搜到」——用户看到的是
 * 「这首歌的搜索信息已过期，请重新搜一次」，其实歌好好的，只是没排上队。
 * 没有一家给出**有效回答**时重试一次，就能把「排队超时」和「真的没有这首歌」分开。
 */
async function searchTrackByKeyword(
  name: string,
  singers: string[],
  track: LocalTrack,
  timeoutMs: number,
  bail?: () => void,
): Promise<SearchSong | null> {
  /*
   * 搜索词：原文优先，实在搜不到再退到「去掉括号后缀的核心歌名」。
   * 队列里那些 `寂寞才说爱 (Live)` / `花海 (DJ 阿若版)` 用原文去平台搜，
   * 常常一条都搜不回来（括号被当字面量），退一步就全都有了。
   */
  const head = `${name} ${singers[0] ?? ''}`.trim()
  const bare = bareTitle(name)
  const keywords = bare && bare !== name ? [head, `${bare} ${singers[0] ?? ''}`.trim()] : [head]
  const target = { name, singer: singers, interval: track.duration || 0 }
  const own = platformOfTrackId(track.id)
  const order: PlatformSource[] = own
    ? [own, ...FALLBACK_ORDER.filter(p => p !== own)]
    : [...FALLBACK_ORDER]

  /** 有几家真的回了话（哪怕回的是空列表）。一家都没有 = 请求根本没跑完 */
  let answered = 0
  for (const p of order) {
    /* 头一家就没答上来、而用户已经切走了：剩下三家更没必要问（每问一家就占一个槽） */
    bail?.()
    if (!apiFor(p)?.supportsSearch) continue
    try {
      const hit = await searchOne(p, target, keywords, bail ?? (() => {}), timeoutMs)
      answered++
      if (hit) return hit.song
    } catch (e) {
      /* 被下一首顶掉：原样往上抛，别当成「这个平台没有」 */
      if (e instanceof StaleResolve) throw e
      /* 这个平台问不出来就换下一个 */
    }
  }
  if (answered === 0 && timeoutMs < 8_000) {
    return searchTrackByKeyword(name, singers, track, 8_000, bail)
  }
  return null
}

/**
 * 在一个平台上搜这首歌，返回**分数最高且过门槛**的那条。
 *
 * `keywords` 可以有多个：先原文，再（可选）去掉括号后缀的核心歌名。
 *
 * 为什么要退一步再搜：平台搜索把括号当字面量。「寂寞才说爱 (Live) 刘可」
 * 在很多平台一条都搜不出来，而「寂寞才说爱 刘可」有几十条。
 * 放宽搜索词**不会**放错版——版本由 `scoreMatch` 里的 versionMismatch 扣 70 分把关，
 * 只是让「本来能搜到」的歌不再白失败一次。
 */
async function searchOne(
  p: PlatformSource,
  target: { name: string; singer: string[]; interval: number },
  keywords: string[],
  bail: () => void,
  timeoutMs = 3_000,
): Promise<{ song: SearchSong; score: number } | null> {
  const api = apiFor(p)
  if (!api?.supportsSearch) return null
  for (const kw of keywords) {
    bail()
    try {
      const res = await withTimeout(api.search(kw, 1, 8), timeoutMs, '搜索超时')
      let best: SearchSong | null = null
      let bestScore = 0
      for (const c of res.list) {
        const sc = scoreMatch(target, c)
        if (sc > bestScore) { bestScore = sc; best = c }
      }
      if (best && bestScore >= MATCH_MIN) return { song: best, score: bestScore }
    } catch (e) {
      /*
       * 网络层失败：**不再试下一个关键词**。
       *
       * 第二个关键词是给「搜到了但没有一条够分」准备的（平台把括号当字面量，
       * 所以搜不到东西）；网络超时说明这家现在根本不通，再搜一遍只是再等一次超时
       * ——而兜底是并行等所有平台，那一次多余的等待会直接加到用户身上。
       */
      throw e
    }
  }
  return null
}
async function searchElsewhere(
  song: SearchSong,
  quality: string,
  skip: Set<PlatformSource>,
  bail: () => void = () => {},
): Promise<CrossHit | CrossFail> {
  const target = { name: song.name, singer: song.singer, interval: song.interval }
  const head = `${song.name} ${song.singer[0] ?? ''}`.trim()
  const bare = bareTitle(song.name)
  const keywords = bare && bare !== song.name
    ? [head, `${bare} ${song.singer[0] ?? ''}`.trim()]
    : [head]

  const candidates = FALLBACK_ORDER.filter(p => {
    if (skip.has(p)) return false
    const api = apiFor(p)
    if (!api?.supportsSearch) return false
    // 没有「能出这个平台链接」的音源脚本，搜到了也播不了 —— 别浪费一次搜索
    return sourceManager.getReadySourcesFor(p).length > 0
  })
  if (!candidates.length) return { errors: ['没有可兜底的平台'] }

  /*
   * 先把所有平台的**搜索结果**收齐，按分数排序，再从最高的往下取链。
   *
   * 以前是「搜到就取链、哪条链接先出来用哪条」（`Promise.any`）。歌名相似度
   * 普遍偏高（两个字的歌名 bigram 很容易 0.8+，中文短歌名更是经常 1.0），
   * 先到的那条常常是 82 分的翻唱，而 118 分的原版后到、被 `settled` 直接丢掉。
   * 用户听到的「原版放成 DJ 版 / 翻唱」有一半来自这里。
   *
   * 兜底本来就是慢路径（本平台已经失败才会走到这一步），多等一次搜索的钱必须花。
   */
  const settled = await Promise.allSettled(
    candidates.map(p => searchOne(p, target, keywords, bail)),
  )

  const errors: string[] = []
  const hits: Array<{ platform: PlatformSource; song: SearchSong; score: number }> = []
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]
    const p = candidates[i]
    if (r.status === 'fulfilled') {
      if (r.value) hits.push({ platform: p, ...r.value })
      else errors.push(`${PLATFORM_NAMES[p]}没有同名版本`)
    } else {
      /* 被下一首顶掉：原样往上抛，别拼成一句假失败 */
      if (r.reason instanceof StaleResolve) throw new StaleResolve()
      errors.push(`${PLATFORM_NAMES[p]}${shortErr(r.reason)}`)
    }
  }

  /* 分数从高到低试；同分时按 FALLBACK_ORDER 的顺序（`sort` 稳定） */
  hits.sort((a, b) => b.score - a.score)
  /*
   * 只试前三条：后面的基本是「同名不同歌」，白花几秒不值得。
   * 每条再给 5 秒预算、整体不超过 12 秒——兜底这条路已经比用户点的慢了，
   * 再让它把三条都等满超时，就是「转圈半分钟然后说没音源」。
   */
  const t0 = Date.now()
  for (const h of hits.slice(0, 3)) {
    bail()
    if (Date.now() - t0 > 12_000) break
    try {
      // 换平台后时长可能不同，校验要按**这条**的时长算
      const r = await sourceManager.getMusicUrl(h.platform, h.song.raw, quality, {
        expectDuration: h.song.interval || song.interval || 0,
        expectTitle: h.song.name,
        budgetMs: 5_000,
      })
      return { platform: h.platform, matched: h.song, score: h.score, ...r }
    } catch (e) {
      if (e instanceof StaleResolve) throw e
      errors.push(`${PLATFORM_NAMES[h.platform]}${shortErr(e)}`)
    }
  }

  const merged = [...new Set(errors)]
  return { errors: merged.length ? merged : ['取链失败'] }
}

/* ------------------------------------------------------------------ */
/* 取播放链接                                                          */
/* ------------------------------------------------------------------ */

/**
 * 「兜底泳道」延迟起跑的时长。
 *
 * 本平台正常时一次取链 150~600ms，所以跑得顺的歌根本不会发出跨平台搜索；
 * 一旦本平台卡住（音源在慢慢超时），兜底在 700ms 就上场抢，用户最多等到
 * 「700ms + 一次搜索 + 一次取链」，而不是「本平台全部失败之后」。
 */
const HEDGE_MS = 700

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 已经有别的泳道赢了，这条泳道静默退出（不算失败，不进错误提示） */
class LaneSkipped extends Error {
  constructor() {
    super('')
    this.name = 'LaneSkipped'
  }
}

/**
 * 这一轮取链已经没人要了（用户又切了一首）。
 *
 * **不给用户看**：调用方本来就按「票号」丢弃旧结果（`PlayerProvider` 的 `onlineSeq`），
 * 这个错误只负责一件事 —— 让旧的那一轮在下一个 await 边界**停止继续发请求**。
 *
 * 为什么必须停：连点 5 次「下一首」，5 轮取链一起跑，每轮都要「注册表重搜 → 本平台取链 →
 * 跨平台搜索」。原生那边的 HTTP 线程池是个有限队列（见 Bridge 的 `pool`），旧轮次排进去
 * 之后，**最新那一首的请求只能排在最后**，5 秒超时一到就被判成「搜索信息已过期」。
 * 用户看到的就是「快速切歌会播放失败」，而歌其实一点问题都没有。
 */
export class StaleResolve extends Error {
  constructor() {
    super('')
    this.name = 'StaleResolve'
  }
}

/** 失败原因里「网的问题」的长相 */
const NETISH = /超时|timeout|resolve host|无法连接|连接被|网络|断开|EAI_AGAIN|ENOTFOUND/i

/**
 * 把泳道失败凑成**一句人话**。
 *
 * 原文是「各平台都没有可用音源（酷狗搜索超时；酷我搜索超时；网易云没有同名版本）」——
 * 信息量低，却很像软件坏了。用户 2026-11 说的「失败率比洛雪高」，一部分观感就来自
 * 提示的形式：失败本来难免，但提示不该长得像报错堆栈。
 *
 * 单条原因时直接用（音源那边的 `NoPlayableSourceError.brief` 已经是人话结论）；
 * 只有「所有原因都指向同一件事」时才归并，别把「音源脚本崩了」说成「网络不好」——
 * 那种情况用户照着原因去查才有用。
 */
function humanizeResolveFail(reasons: string[]): string {
  const uniq = [...new Set(reasons.filter(Boolean))]
  if (!uniq.length) return '这首歌暂时没有可用音源'
  if (uniq.length === 1) return uniq[0]
  if (uniq.every(r => NETISH.test(r))) return '网络不稳，暂时取不到这首歌的音源（恢复后会自动重试）'
  return `暂时取不到这首歌的音源（${uniq.slice(0, 2).join('；')}）`
}

/** 一条泳道跑出来的赢家 */
type LaneWin =
  | {
    kind: 'own' | 'known'
    r: { url: string; sourceId: string; sourceName: string; quality: string }
    platform: PlatformSource
    dur: number
  }
  | { kind: 'alt'; hit: CrossHit; platform: PlatformSource; dur: number }

/**
 * 拿这首歌的搜索信息；注册表里没有就按歌名/歌手重搜一次并**按队列 id 写回**。
 *
 * 注册表只保留最近 300 条，队列里的老歌会被挤出去。取链和取歌词都需要这份
 * 信息（歌词要 `songmid`），所以两条路都要过这一关——以前只有取链做了兜底，
 * 结果「歌能响但歌词是空的」，而且冷启动必现。
 */
async function ensureSong(track: LocalTrack, bail?: () => void): Promise<SearchSong | null> {
  const hit = songOf(track.id) ?? await songOfAsync(track.id)
  if (hit) return hit
  const found = await findSongByTrack(track, bail)
  if (!found) return null
  registry.set(track.id, found)
  persistRegistry()
  return found
}

/**
 * 同一条曲目的补图任务只发一次（id → Promise）。
 *
 * 为什么要有这层：整队补图是在 React effect 里跑的，每补到一张封面就会触发
 * 一次重渲染、effect 重跑，旧的 worker 被 cleanup 掉——**它手上那个请求还在飞**。
 * 如果只是「问过就记一笔」，这些 in-flight 的结果会被丢掉还永远不再重试，
 * 表现就是「补到前几张就不动了」。缓存 Promise 以后，新一拨 worker 拿到的
 * 是同一个 Promise，结果一定落得下来。
 */
const coverJobs = new Map<string, Promise<string | null>>()

/**
 * 队列里这条在线曲目的封面（注册表没图就重搜一次）。给列表 / 播放页补图用。
 *
 * 注意不能直接用 `ensureSong` 的返回值：歌单详情（酷狗 `special/song`）入库时
 * 就把 `img: null` 一起写进注册表了，`ensureSong` 命中缓存就返回，**永远不会重搜**，
 * 表现就是「这批歌的封面怎么都补不出来」。所以这里要判断「命中但没图」，
 * 这种情况必须走一次搜索——搜索接口是带 `trans_param.union_cover` 的。
 */
export function coverForTrack(track: LocalTrack): Promise<string | null> {
  if (track.cover) return Promise.resolve(track.cover)
  const hitJob = coverJobs.get(track.id)
  if (hitJob) return hitJob
  const job = (async (): Promise<string | null> => {
    const hit = songOf(track.id) ?? await songOfAsync(track.id)
    if (hit?.img) return hit.img
    const found = await findSongByTrack(track)
    if (found?.img) {
      /* 按 track.id 注册（酷狗同名不同 hash，别按平台 id 覆盖） */
      registry.set(track.id, found)
      persistRegistry()
      return found.img
    }
    /*
     * 本平台自己就没图 —— 酷我的榜单接口（`kbangserver/ksong.s`）**整份没有
     * 任何封面字段**（300 条里 0 条带 albumpic/musicPic），所以热歌榜怎么补都补不出来。
     * 这类只能跨平台借一张：按「歌名 + 歌手」去别家搜，挑有图且最像的那条。
     * 借图**不覆盖**注册表里的曲目信息（那是别家平台的 id，覆盖了取链会走错），
     * 只把 img 补进当前这条。
     */
    const pic = await findSongWithCover(track)
    if (pic?.img) {
      if (hit) {
        registry.set(track.id, { ...hit, img: pic.img })
        persistRegistry()
      }
      return pic.img
    }
    return hit?.img ?? found?.img ?? null
  })()
  coverJobs.set(track.id, job)
  return job
}

/**
 * 列表里一条在线曲目的封面（**不写注册表、不入队**，纯取图）。
 *
 * 榜单详情是「整份没有封面字段」的（酷我三个榜最典型：`kbangserver/ksong.s`
 * 300 条里 0 条带 albumpic），列表行就只能空着。这里按单曲向平台要一张：
 * 先走平台的 `getPic`（酷我用 `artistpicserver` 按 rid 换，一次一个 69 字节的小请求），
 * 拿不到再跨平台借——**和 `coverForTrack` 的区别是不碰注册表**：
 * 榜单动辄三百条，全塞进注册表会把 300 条的上限挤爆，在线取链就全失效了。
 *
 * 同一条曲目只发一次（缓存 Promise），列表滚动反复触发也只花一个请求。
 */
const songCoverJobs = new Map<string, Promise<string | null>>()

export function coverForSong(sg: SearchSong): Promise<string | null> {
  if (sg.img) return Promise.resolve(sg.img)
  const key = `${sg.source}:${sg.id}`
  const hitJob = songCoverJobs.get(key)
  if (hitJob) return hitJob
  const job = (async (): Promise<string | null> => {
    const api = apiFor(sg.source)
    if (api?.getPic) {
      try {
        const url = await withTimeout(api.getPic(sg), 6_000, '取封面超时')
        if (url) return url
      } catch { /* 换不到就往下走跨平台 */ }
    }
    const pic = await findSongWithCover({
      id: onlineId(sg), path: '', title: sg.name, artist: sg.singer.join(' / '),
      album: sg.albumName, duration: sg.interval, format: 'mp3', bitrate: null,
      sampleRate: null, cover: null, mtime: 0, size: 0,
    })
    return pic?.img ?? null
  })()
  songCoverJobs.set(key, job)
  return job
}

/**
 * 跨平台找一张封面：只要**带图**的候选。
 *
 * 和 `findSongByTrack` 的区别是「宁可多搜几家，也不接受没图的结果」——
 * 那条只要名字对得上就返回，本平台恰好没图时就白跑一趟。
 */
async function findSongWithCover(track: LocalTrack): Promise<SearchSong | null> {
  const name = (track.title || '').trim()
  if (!name) return null
  const singers = (track.artist || '').split(/\s*[/、]\s*/).map(s => s.trim()).filter(Boolean)
  const keyword = `${name} ${singers[0] ?? ''}`.trim()
  const target = { name, singer: singers, interval: track.duration || 0 }
  const own = platformOfTrackId(track.id)
  const order: PlatformSource[] = own
    ? [own, ...FALLBACK_ORDER.filter(p => p !== own)]
    : [...FALLBACK_ORDER]

  for (const p of order) {
    const api = apiFor(p)
    if (!api?.supportsSearch) continue
    try {
      const res = await withTimeout(api.search(keyword, 1, 8), 5_000, '搜索超时')
      let best: SearchSong | null = null
      let bestScore = 0
      for (const c of res.list) {
        if (!c.img) continue
        const sc = scoreMatch(target, c)
        if (sc > bestScore) { bestScore = sc; best = c }
      }
      if (best && bestScore >= MATCH_MIN) return best
    } catch {
      /* 这家问不出来就换下一家 */
    }
  }
  return null
}

/**
 * 在线曲目 → 可播直链。
 *
 * 三级兜底，**任何一级成功就返回**，用户不需要点「换源」：
 *   1. 上次跨平台兜底成功的那条（命中就省掉一轮必然失败的等待）
 *   2. 这首原本所在的平台（音源降级链 + 逐档降音质）
 *   3. 其他平台：搜同名歌 → 打分挑最像的 → 取链
 * 只有三级全挂才抛错，提示里写清「哪几个平台试过、各自为什么不行」。
 */
export async function resolvePlayUrl(
  track: LocalTrack,
  opts: {
    quality?: string
    exclude?: string[]
    sourceId?: string
    /**
     * 跳过这个平台。
     *
     * 用在「只拿到 30 秒试听」之后：试听是**平台账号权限**的问题，同一家的
     * 音源脚本换来换去都是同一段，只有换平台才有完整版（2026-11-01 用户反馈）。
     */
    skipPlatform?: PlatformSource
    /**
     * 「这一轮还有没有人要」。返回 true = 用户已经切到别的歌了，立刻收手。
     *
     * 只有播放那条路径需要传（`PlayerProvider` 按 `onlineSeq` 判断）；下载那条路
     * 不传 —— 下载是「用户明确排进队列的任务」，不该被切歌顶掉。
     */
    cancel?: () => boolean
  } = {},
): Promise<ResolvedPlay> {
  /** 这一轮从什么时候开始：后面用它决定「还值不值得再等一轮兜底」 */
  const t0 = Date.now()
  /** 已经作废就立刻退出：每个 await 边界都要问一次（见 [StaleResolve]） */
  const bail = () => {
    if (opts.cancel?.() === true) throw new StaleResolve()
  }
  /* 注册表里没有这条就重搜一次（见 ensureSong）。队列里存着歌名/歌手，
     能搜到就不该弹「搜索信息已过期」。 */
  const song = await ensureSong(track, bail)
  bail()
  if (!song) {
    // 连搜都搜不到（歌名被改过 / 平台全下架了）。这里不能报「没有音源」——
    // 那会把人骗去设置里导音源，其实换首歌就行。
    throw new Error('这首歌的搜索信息已过期，请重新搜一次')
  }
  const requested = opts.quality ?? (await getPreferredQuality())
  bail()

  /*
   * 档位纠正：这首歌**实际没有**这一档时，落到它真有的最高档。
   *
   * 平台声明的档位（`song.qualities`）比音源声明准得多。走到这里还带着一个不存在的档位，
   * 常见于两种情况：菜单是上一首渲染的、或者用户在设置里选了「无损」但这首只有 320k。
   * 不纠正的话，降级链会白试一遍再往下掉，用户等的那两秒纯属浪费。
   * 注意只纠正**本平台**这一轮；跨平台兜底那一轮用原始请求档位（那个平台可能真有）。
   */
  let ownQuality = requested
  if (song.qualities?.length && !song.qualities.includes(ownQuality)) {
    const usable = QUALITY_CHOICES.filter(q => song.qualities!.includes(q))
    if (usable.length) ownQuality = usable[usable.length - 1]
  }

  const key = urlKeyOf(track.id, requested)
  if (canReuse(opts)) {
    const hit = urlCache.get(key)
    if (hit && Date.now() - hit.at < URL_TTL) {
      const { at: _at, ...rest } = hit
      // 命中缓存不算「刚发生」：重播同一首不再弹一遍提示
      return { ...rest, fresh: false }
    }
  }

  const build = (
    r: { url: string; sourceId: string; sourceName: string; quality: string; unverified?: boolean },
    platform: PlatformSource,
    extra: { switched: boolean; duration: number; matchedName?: string; matchedSinger?: string; fresh: boolean },
  ): ResolvedPlay => {
    const out: ResolvedPlay = {
      url: r.url,
      sourceId: r.sourceId,
      quality: r.quality,
      qualityLabel: qualityLabel(r.quality),
      sourceName: r.sourceName,
      platform,
      platformName: PLATFORM_NAMES[platform] ?? platform,
      requestedQuality: requested,
      switched: extra.switched,
      fresh: extra.fresh,
      duration: extra.duration,
      matchedName: extra.matchedName,
      matchedSinger: extra.matchedSinger,
    }
    if (r.unverified) out.unverified = true
    if (canReuse(opts)) urlCache.set(key, { ...out, at: Date.now() })
    return out
  }

  const wantDur = track.duration || song.interval || 0

  /*
   * 三条泳道同时开跑，**谁先给出能播的链接用谁**（2026-10 改）。
   *
   * 以前是严格串行：先试记住的平台 → 再把本平台所有音源、所有档位依次试完
   * （每档还要落地校验一次，单档超时 6 秒）→ 确认彻底没戏了，才去别的平台搜。
   * 一首在 QQ 没有版权的歌，用户要干等好几秒才出声，这就是「播放还是很慢」。
   *
   * 现在：
   *   · 泳道「本平台」：音源之间**并行**竞速（见 SourceManager.getMusicUrl），
   *     不再是「音源 A 试完三档才轮到 B」；
   *   · 泳道「兜底平台」：上次记下的那个平台，一起跑；
   *   · 泳道「其它平台」：**延迟 HEDGE_MS 起跑**。本平台正常时（150~600ms）
   *     这轮搜索根本不会发出，省掉 4 次搜索 + 取链；本平台卡住了它才上场抢。
   *
   * 第一个成功的立刻返回，慢的那些结果直接丢弃——也不会写缓存，
   * 因为 `build()` 只在赢家身上调一次。
   */
  const lanes: Array<Promise<LaneWin>> = []
  let settled = false

  /* 到这一步还没被顶掉，才值得为它开泳道 */
  bail()

  /*
   * 「兜底泳道提前上场」的记号。
   *
   * 兜底泳道故意延迟 HEDGE_MS 起跑，是为了给本平台留出机会（少发一轮搜索）。
   * 但有些失败**立刻就发生了**：这个平台压根没有能出链的音源脚本、脚本声明不支持、
   * 或者音源同步报错。这种情况下干等那 700ms 纯属浪费——用户点了歌，
   * 屏幕上只有「取链中…」。所以主泳道全部失败完的那一刻，直接把兜底叫醒。
   */
  let pendingMains = 0
  let wakeHedge: () => void = () => {}
  const mainsFailed = new Promise<void>(res => { wakeHedge = res })
  const asMain = (p: Promise<LaneWin>): Promise<LaneWin> => {
    pendingMains++
    return p.then(
      v => v,
      (e: unknown) => {
        if (--pendingMains === 0) wakeHedge()
        throw e
      },
    )
  }

  /* 泳道 1：上次兜底成功过的另一个平台（记得的，不重复提示「刚切过去」） */
  const known = subs.get(track.id)
  if (known && known.source !== opts.skipPlatform) {
    lanes.push(asMain((async (): Promise<LaneWin> => {
      bail()
      try {
        const r = await sourceManager.getMusicUrl(known.source, known.raw, requested, {
          exclude: opts.exclude,
          expectDuration: known.interval || wantDur,
          expectTitle: known.name,
        })
        return { kind: 'known', r, platform: known.source, dur: known.interval || wantDur }
      } catch (e) {
        // 兜底记录过期了：删掉，不影响别的泳道
        subs.delete(track.id)
        throw e
      }
    })()))
  }

  /* 泳道 2：本平台（音源并行 + 逐档降音质）。判定为「只给试听」时直接不进这条泳道 */
  if (!skipOwnPlatform() && song.source !== opts.skipPlatform) {
    lanes.push(asMain((async (): Promise<LaneWin> => {
      bail()
      const r = await sourceManager.getMusicUrl(song.source, song.raw, ownQuality, {
        exclude: opts.exclude,
        sourceId: opts.sourceId,
        expectDuration: wantDur,
        expectTitle: song.name,
      })
      return { kind: 'own', r, platform: song.source, dur: wantDur }
    })()))
  }

  /* 泳道 3：其它平台找同一首歌（延迟起跑；主泳道全灭则立刻上场） */
  lanes.push((async (): Promise<LaneWin> => {
    if (pendingMains > 0) await Promise.race([sleep(HEDGE_MS), mainsFailed])
    // 已经有泳道出结果了：这轮搜索直接不发
    if (settled) throw new LaneSkipped()
    /* 延迟起跑的这 700ms 里用户可能已经切走了：那这轮搜索根本不用发 */
    bail()
    const skipSet = new Set<PlatformSource>([song.source])
    if (opts.skipPlatform) skipSet.add(opts.skipPlatform)
    /*
     * 这条泳道自己也有总预算（9 秒）。
     *
     * 它内部是「5 个平台并行搜 → 排序 → 最多 3 条依次取链」，每一步都有超时，
     * 乘起来可以到十几秒。而 `Promise.any` 要等**所有**泳道都失败才会报错，
     * 于是用户就得陪着这条最长的路走完——实测 17 秒才弹「没有音源」。
     * 到点就收，把失败时间压到 10 秒内：快速失败之后用户才愿意点「重试 / 换源」。
     */
    const alt = await Promise.race([
      searchElsewhere(song, requested, skipSet, bail),
      sleep(7_000).then((): CrossFail => ({ errors: ['兜底平台搜索超时'] })),
    ])
    if (!('platform' in alt)) {
      throw new Error(alt.errors.slice(0, 2).join('；') || '没有同名版本')
    }
    /*
     * 低分候选**不许抢跑**。
     *
     * 主泳道只是「慢」而不是「失败」的时候，一条 74 分的翻唱抢先返回，
     * 用户点的原版就被顶掉了 —— 这是「原版放出 DJ 版 / 别人唱的那版」的另一半来源。
     * 分数够高（歌名精确 + 歌手命中 + 时长对得上，见 `EARLY_MIN`）才允许抢；
     * 不够高就等主泳道真的失败，最多再等 6 秒（这么久还没结果，也基本没戏了）。
     */
    if (alt.score < EARLY_MIN && pendingMains > 0) {
      await Promise.race([mainsFailed, sleep(6_000)])
      if (settled) throw new LaneSkipped()
    }    return { kind: 'alt', hit: alt, platform: alt.platform, dur: alt.matched.interval || wantDur }
  })())

  let win: LaneWin
  try {
    win = await Promise.any(lanes)
  } catch (e) {
    const all = ((e as AggregateError).errors ?? []) as unknown[]
    /* 被顶掉：原样往上抛，别拼成「各平台都没有可用音源」那种假失败 */
    if (all.some(x => x instanceof StaleResolve)) throw new StaleResolve()
    const reasons = all
      .map(x => (x instanceof Error ? x.message : String(x)))
      .filter(Boolean)   // LaneSkipped 是空的，不进提示

    /*
     * 最后一步：**允许未校验的地址**。
     *
     * 这是「失败率」这条线上最实在的一处收口。严格路径挂掉的原因里，很大一部分
     * 不是「没版权」，而是「探测那一下超时了」——慢网 / 大文件头 / 服务器慢响应。
     * 地址本身是好的、放出来能播，而我们把它当成失败弹给用户。
     * 洛雪没有这一步校验，所以它「能播」；用户对比下来就是「你这儿播不了」。
     *
     * 只对本平台这条要一次（跨平台那条匹配本身就不可靠，未校验风险太大）。
     * 硬失败（文件里是另一首歌 / 试听片段）不会走到这里，见 verify 里的软硬之分。
     */
    if (!skipOwnPlatform() && song.source !== opts.skipPlatform) {
      try {
        bail()
        /*
         * 整轮预算 11 秒：主泳道 7s + 兜底 7.7s 都没成的话，这里只剩不到 4 秒。
         * 剩余时间太短（<2s）就别再起一轮了——多等 2 秒还是失败，不如立刻报错
         * 让用户点「重试」，那样至少是他在掌控。
         */
        const left = 11_000 - (Date.now() - t0)
        if (left < 2_000) throw new Error('skip')
        const soft = await sourceManager.getMusicUrl(song.source, song.raw, ownQuality, {
          exclude: opts.exclude,
          sourceId: opts.sourceId,
          expectDuration: wantDur,
          expectTitle: song.name,
          allowUnverified: true,
          budgetMs: Math.min(6_000, left),
        })
        if (soft.unverified) {
          settled = true
          return build(soft, song.source, { switched: false, fresh: false, duration: wantDur })
        }
      } catch {
        /* 连宽松兜底都没有：按原来的原因报错 */
      }
    }
    throw new Error(humanizeResolveFail(reasons))
  }
  // 赢了就把闸门关上：还在路上的兜底搜索看到这个标记就不再发请求
  settled = true

  if (win.kind === 'alt') {
    subs.set(track.id, win.hit.matched)
    return build(win.hit, win.platform, {
      switched: true,
      fresh: true,
      duration: win.dur,
      matchedName: win.hit.matched.name,
      matchedSinger: win.hit.matched.singer.join(' / '),
    })
  }
  if (win.kind === 'known') {
    return build(win.r, win.platform, {
      switched: true,
      fresh: false,
      duration: win.dur,
      matchedName: known?.name,
      matchedSinger: known?.singer.join(' / '),
    })
  }
  /*
   * 本平台赢了：把「记得的兜底平台」清掉。
   *
   * 并行之后，「记住的兜底」不再一定先跑赢——本平台更快的话，播的明明是原平台那条，
   * 而 `subs` 里还留着上一轮的兜底记录，界面就会显示成「实际歌手是别的那条」。
   * 播放来自哪个平台，以赢的那条为准。
   */
  subs.delete(track.id)
  return build(win.r, win.platform, { switched: false, fresh: false, duration: win.dur })
}

/* ------------------------------------------------------------------ */
/* 在线歌词                                                            */
/* ------------------------------------------------------------------ */

/**
 * 平台歌词（LRC 原文）。拿不到返回空串，不抛。
 *
 * 取歌这里**必须走 `songOfAsync`**：注册表是从存档异步读出来的，冷启动直接
 * 点队列里的在线曲目时，播放那条路径有 `songOfAsync` 兜着（所以歌能响），
 * 歌词这条却没有——注册表还空着就返回空串，界面就永久停在「暂无歌词」。
 * 表现是「有时候点歌单播放没有歌词」，重启后点老队列必现。
 *
 * 另外必须带超时：平台歌词接口偶发卡住（限流 / 长尾），不设上限的话
 * 这个 Promise 会一直挂着，调用方那句「读歌词失败也收尾」永远等不到。
 */
export async function onlineLyric(track: LocalTrack): Promise<{ text: string; exact: boolean }> {
  /*
   * 播放走了跨平台兜底时，**耳朵里响的是那一条**，歌词必须跟着它走。
   *
   * 以前这里固定用原平台的 song：兜底换到酷狗播了同一首歌，LRC 却还从网易云取。
   * 两边歌词时间轴不一样，表现就是「歌词整体慢半拍 / 对不上」——用户 2026-11
   * 报「寂寞才说爱歌词全错」时，一半是歌放错了版本，另一半就是这里。
   * `effectiveSong` 是同步的（兜底记录只在内存里，重启即失效），为空再走 ensureSong。
   */
  const song = effectiveSong(track.id) ?? await ensureSong(track)
  let own = ''
  if (song) {
    const api = apiFor(song.source)
    if (api?.getLyric) {
      try {
        const r = await withTimeout(api.getLyric(song.songmid ?? song.id, song.id), 8000, '歌词请求超时')
        own = r.lyric ?? ''
      } catch {
        /* 本平台问不出来：交给下面的跨平台兜底，别直接判定「没有歌词」 */
      }
    }
  }
  if (own.trim()) return { text: own, exact: true }
  const alt = await lyricElsewhere(track, song?.source)
  if (alt) return { text: alt, exact: false }
  /* 兜底也没词：返回本平台那条（可能是空串，也可能只有几行），总比丢掉好 */
  return { text: own, exact: false }
}

/**
 * 本平台拿不到歌词时的兜底：拿「歌名 + 歌手」去别家搜一条，能出词就用。
 *
 * 为什么必须有：酷我的歌词接口 `songinfoandlrc` 对**版权 / 会员受限**的曲目
 * 回 `{"data":null,"msg":"音乐查询失败","status":301}`（实测「晴天」这种下架曲也一样），
 * 而酷我热歌榜 300 首里 292 首落在这一档。以前这是一次请求判生死，用户看到的就是
 * 「热歌榜的歌全都没有歌词」。歌词本质是文本，换一家平台问没任何副作用。
 *
 * 只在**本平台明确拿不到**时才会走到这里，正常歌曲的耗时不增加。
 */
async function lyricElsewhere(track: LocalTrack, skip?: PlatformSource): Promise<string> {
  const name = (track.title || '').trim()
  if (!name) return ''
  const singers = (track.artist || '').split(/\s*[/、]\s*/).map(s => s.trim()).filter(Boolean)
  const keyword = `${name} ${singers[0] ?? ''}`.trim()
  const target = { name, singer: singers, interval: track.duration || 0 }
  for (const p of FALLBACK_ORDER) {
    if (p === skip) continue
    const api = apiFor(p)
    if (!api?.getLyric || !api.supportsSearch) continue
    try {
      const res = await withTimeout(api.search(keyword, 1, 5), 5_000, '搜索超时')
      let best: SearchSong | null = null
      let bestScore = 0
      for (const c of res.list) {
        /*
         * 时长必须先对上（2026-11-21 平板「海屿你歌词对不上」教训）。
         *
         * 别家平台上传的 LRC 经常是另一个版本（MV 版 / 加长版 / DJ 版）的
         * 时间轴——歌名歌手都对、词也是同一首，可每行的时间整体偏移几十秒，
         * 高亮永远落在错的那句上。歌名匹配防不了这个，时长能：
         * 同一首歌在不同平台的音频时长不会差出 12%（音源转码差异兜 8 秒底）。
         */
        if (target.interval > 0 && c.interval > 0) {
          const tol = Math.max(8, target.interval * 0.12)
          if (Math.abs(c.interval - target.interval) > tol) continue
        }
        const sc = scoreMatch(target, c)
        if (sc > bestScore) { bestScore = sc; best = c }
      }
      if (!best || bestScore < MATCH_MIN) continue
      const r = await withTimeout(api.getLyric(best.songmid ?? best.id, best.id), 6000, '歌词请求超时')
      if (r.lyric?.trim()) return r.lyric
    } catch {
      /* 这家没有 / 超时：换下一家 */
    }
  }
  return ''
}

/** 跨平台兜底要搜一轮，必须带超时——某个平台慢不能把整条链路拖住 */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/* ------------------------------------------------------------------ */
/* 原生取链上下文（iOS 后台续播的底座）                                 */
/* ------------------------------------------------------------------ */

/**
 * 交给原生宿主的「接下来能播的歌 + 取链原料」。
 *
 * 为什么需要把原料（平台原始对象）搬过去：iOS 切后台后 WebView 的 JS 会被系统
 * 冻住，前端算好的直链表耗完就没人补了。原生内嵌 QuickJS 跑同一批音源脚本，
 * 只要手里有「平台 + musicInfo + 音质」，它就能自己一直往下接。
 *
 * `items` 的约定：**按播放顺序排，第一项是当前这首**（原生靠它定位「下一首」）。
 */
export interface NativeChainItem {
  index: number
  /** 曲目 id：原生据此去缓存目录找现成文件（离线后台） */
  id: string
  platform: string
  quality: string
  /**
   * 平台原始对象（洛雪 `musicInfo`），**已序列化成 JSON 文本**。
   *
   * 为什么不直接给对象：整张歌单几千首会一直躺在原生内存里，展开成对象树
   * 要十几 MB，iOS 后台会被系统按内存杀掉。原生只在取链时解析当前这一首。
   */
  raw: string | null
  duration: number
  title: string
  artist: string
  album: string
  cover: string
  path?: string
}

/** 启用的音源脚本文件（原生按这个顺序试，和这边的降级链一致） */
export function nativeScriptFiles(): string[] {
  const enabled = new Set(sourceManager.enabledIds())
  return sourceManager
    .list()
    .filter(s => enabled.has(s.id) && s.status !== 'error' && !!s.filePath)
    .map(s => s.filePath)
}

/** 平台登录 cookie（原生按域名注入，与这边 COOKIE_HOSTS 同一张表） */
export function nativeCookies(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of ['wy', 'tx', 'kg', 'kw'] as const) {
    const c = cookieOf(p)
    if (c) out[p] = c
  }
  return out
}

/**
 * 单首曲目的取链原料。返回 null = 原生接不了这首（本地文件另有 path，不走这里）。
 *
 * `raw` 拿不到（注册表被挤掉、还没搜过）时不要硬塞空对象：空对象会让脚本
 * 拼出一个错地址，失败得比「直接告诉原生没有」更晚。
 */
export function nativeChainItem(
  track: { id: string; path?: string; duration?: number; title?: string; artist?: string; album?: string; cover?: string | null },
  index: number,
  quality: string,
): NativeChainItem | null {
  const platform = platformOfTrackId(track.id)
  if (!platform) return null
  const song = effectiveSong(track.id)
  if (!song?.raw) return null
  return {
    index,
    /* 原生拿它去缓存目录里找现成文件：断网时这是「还能不能接着放」的关键 */
    id: track.id,
    platform,
    quality,
    raw: JSON.stringify(song.raw),
    duration: song.interval || track.duration || 0,
    title: track.title ?? song.name ?? '',
    artist: track.artist ?? song.singer?.join('/') ?? '',
    album: track.album ?? song.albumName ?? '',
    cover: track.cover ?? song.img ?? '',
  }
}
