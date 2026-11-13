/**
 * 「我的」页面：这是应用的主页。
 *
 * 一页看全三件事，**不再分 Tab**：
 *   1. 自己建 / 导入的歌单：新建、导入、改名、删除、点开听；
 *   2. 收藏的在线歌单：搜索页点星标收进来，点开走在线歌单详情；
 *   3. 本地音乐：原「本地音乐」页整页搬进来，扫描、搜索、多选、批量全在。
 *
 * 为什么并成一个页面：以前侧栏是「本地音乐 / 导入歌单」两个并列项，
 * 用户想「先建个歌单再把歌放进去」得在两页之间来回跳，而这两件事本来就是一件事。
 * v0.5.1 起连 Tab 也去掉了——切 Tab 等于又藏了一半内容，直接上下排开。
 * 侧栏那个「歌单广场」页保留给后续接各大 APP 歌单，这轮不动。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fmtTime, type LocalTrack } from '@shuyin/core'
import { nicknameText, type HotPlaylistItem, type PlatformSource, type PlaylistDetail } from '@shuyin/lx-provider'
import { usePlayer } from '../lib/PlayerProvider'
import { usePlaylists, mosaicOf, type LocalPlaylist } from '../lib/localPlaylists'
import { useFavs, favTracksOf } from '../lib/favTracks'
import { bridge } from '../lib/bridge'
import { matchSongs, parsePlaylist } from '../lib/playlistImport'
import { KEYS, settings } from '../lib/settings'
import { loadProfile, type CloudProfile } from '../lib/cloud'
import { toast } from '../lib/toast'
import { confirm } from '../lib/confirm'
import { consumeLongPress, isHoldContextMenu } from '../lib/longPress'
import { pushBackLayer } from '../lib/native/android'
import { platKey, usePlatPrefs } from '../lib/platPrefs'
import { SortableGrid, isJustDragged } from '../components/SortableGrid'
import { SortableSections } from '../components/SortableSections'
import { RecoWeightSlider } from '../components/RecoWeightSlider'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { Modal } from '../components/Modal'
import { HelpTip } from '../components/HelpTip'
import { AccountPanel } from '../components/AccountPanel'
import { LoginQrDialog } from '../components/LoginQrDialog'
import { PhoneLoginDialog } from '../components/PhoneLoginDialog'
import { apiFor, clearDailyCache, dailyMix, DEFAULT_RECO_WEIGHTS, minePlaylists, nextMixSeed, platformName, subscribeMixSeed, toLocalTracks, type RecoWeights } from '../lib/online'
import {
  LOGIN_PLATFORMS, loginPlatform, logoutPlatform, useAccounts, type PlatformAccount,
} from '../lib/platformAccount'
import { supportsQr } from '../lib/qrLogin'
import {
  IconChevronDown, IconChevronUp, IconClose, IconFolder, IconGrid, IconGrip, IconMusicNote,
  IconPlay, IconPlus, IconRefresh, IconRows, IconSliders, IconTrash, IconUpload, IconUser,
} from '../components/icons'

/**
 * 「我的」里列出的平台账号。
 *
 * 用的是平台侧的登录通道表（四家都有），不是「谁实现了 getAccount」——
 * 后者只决定登录之后能不能显示昵称，不该决定能不能登录。
 */
/**
 * 能在这里登录的平台。
 *
 * 四家都列出来：桌面走「内嵌官方登录窗」，安卓走「WebView 登录页」
 * （`platform_login` 在两边都有实现），扫码只是网易云多出来的一条快捷路。
 * 哪家走扫码由 `supportsQr` 决定，**不靠隐藏按钮**——按钮少一个，
 * 用户只会以为「这个平台不支持登录」。
 */
const PLATFORMS = LOGIN_PLATFORMS

interface Props {
  onOpenDetail(t: LocalTrack): void
  onOpenLocalPlaylist(id: string): void
  onOpenOnlinePlaylist(p: { source: PlatformSource; id: string; name: string }): void
  /** 打开「本地音乐」列表（横条卡片点进来） */
  onOpenLibrary(): void
  /** 打开「我喜欢的音乐」= 收藏的歌曲（我的歌单里第一张固定卡） */
  onOpenFavs(): void
}

const IMPORT_HELP = [
  '支持网易云 / QQ 音乐 / 酷狗导出的歌单文件：JSON、TXT、CSV、M3U、PLS 都能认，格式自动判断，不用改扩展名。',
  '',
  'TXT 一行一首：「歌名 - 歌手」最省事；',
  'CSV 第一行写表头（歌名,歌手,专辑）；',
  'M3U / PLS 会优先按文件路径对上本地曲库。',
  '',
  '导入后会立刻和本地曲库匹配，匹配不上的歌不会丢——记在歌单里，等曲库补上再对。',
].join('\n')

export function HomePage({ onOpenLocalPlaylist, onOpenOnlinePlaylist, onOpenLibrary, onOpenFavs }: Props) {
  const p = usePlayer()
  const pl = usePlaylists()
  /** 登录入口就在这一页，不用专门跑设置 */
  const [profile, setProfile] = useState<CloudProfile | null>(null)
  const [acctOpen, setAcctOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  /** 新建 / 重命名共用一个弹窗 */
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'rename'; list: LocalPlaylist } | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; list: LocalPlaylist } | null>(null)
  const [favMenu, setFavMenu] = useState<{ x: number; y: number; key: string; name: string } | null>(null)
  /** 整理态里长按/右键平台歌单出的菜单（只有「移除」一项，但留着菜单比直接删安全） */
  const [platMenu, setPlatMenu] = useState<{ x: number; y: number; item: HotPlaylistItem } | null>(null)

  /*
   * 平台账号的登录入口就在这一页：扫码登录是「我的」的事（登录之后长出来的是
   * 我的歌单），没有理由再把按钮放到歌单广场那种「看别人」的页面上。
   */
  const accounts = useAccounts()
  /**
   * 平台账号那一块是展开还是收起。
   *
   * **默认收起**（用户要求：登录这件事办完就不关心了，四行白占半屏）。
   * 没登录的那几家在折叠头上留一句彩色的「N 家待登录」，点一下照样能展开，
   * 所以收起来不等于找不到入口。
   *
   * 存本地而不是存 state：展开过一次的人下次进来应该还是展开的——
   * 否则每次启动都收回去，等于让他每次重新点一遍。
   */
  const [platsWant, setPlatsWant] = useState<boolean>(false)
  const loggedCount = PLATFORMS.filter(s => accounts[s]).length
  const platsNeedLogin = PLATFORMS.some(s => !accounts[s])
  const platsOpen = platsWant
  useEffect(() => {
    let alive = true
    void settings.get<boolean>(KEYS.homePlatsOpen)
      .then(v => { if (alive && typeof v === 'boolean') setPlatsWant(v) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const togglePlats = useCallback(() => {
    setPlatsWant(v => {
      void settings.set(KEYS.homePlatsOpen, !v).catch(() => {})
      return !v
    })
  }, [])
  /**
   * 被手动收起来的平台分组（source 集合）。空集 = 全部展开，这是默认。
   *
   * 默认展开是有原因的：收起后那一组只剩一条标题，卡片看不见就没法拖，
   * 用户要的就是「展开着拖着自己那几张歌单换位置」。
   */
  const [groupsShut, setGroupsShut] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void settings.get<string[]>(KEYS.homeGroupsShut).then(v => {
      if (alive && Array.isArray(v)) setGroupsShut(v.filter(x => typeof x === 'string'))
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  const toggleGroup = useCallback((src: string) => {
    setGroupsShut(cur => {
      const next = cur.includes(src) ? cur.filter(x => x !== src) : [...cur, src]
      void settings.set(KEYS.homeGroupsShut, next).catch(() => {})
      return next
    })
  }, [])
  /** 刷新计数：点一次「刷新」就 +1，平台歌单那边跟着重拉 */
  const [refreshTick, setRefreshTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const { list: platList, errors: platErrors } = usePlatformPlaylists(accounts, refreshTick)
  /*
   * 平台歌单的本地偏好：藏起来哪些、按什么顺序摆。
   *
   * 「刷新」只负责重新拉数据，过滤和排序都在渲染这一层——这样刷新完
   * 被移除的歌单不会又冒出来（用户明确说过「等我刷新的时候重新拉取」）。
   */
  const prefs = usePlatPrefs()
  /** 抖动整理态：卡片摇摆、可拖、右上角出小叉 */
  const [tidy, setTidy] = useState(false)
  /**
   * 歌单的浏览方式：卡片网格 / 单列列表。
   *
   * 默认卡片（封面最容易认），歌单一多就切列表——一个屏幕能看到七八个名字，
   * 找「上周建的那个」不用再滚三屏。选择记在设置里，下次进来还是上次那样。
   * 拖动排序两套都支持：列表本质是「一列网格」，`SortableGrid` 按列数反推，
   * 列数 1 时让位模型自动退化成上下换行。
   */
  const [view, setView] = useState<'grid' | 'list'>('grid')
  useEffect(() => {
    void settings.get<string>(KEYS.homeView).then(v => { if (v === 'list') setView('list') })
  }, [])
  const toggleView = useCallback(() => {
    setView(v => {
      const next = v === 'grid' ? 'list' : 'grid'
      void settings.set(KEYS.homeView, next)
      return next
    })
  }, [])
  const gridCls = view === 'list' ? 'home-grid is-list' : 'home-grid'
  /** 「已移除的平台歌单」弹窗：误删了要能找回来 */
  const [hiddenOpen, setHiddenOpen] = useState(false)

  /** 这一组显示哪些、按什么顺序：先过滤隐藏，再套用户排过的顺序 */
  const platShown = useMemo(
    () => prefs.arrange(platList.filter(i =>
      !prefs.hidden.has(platKey(i.source, i.id))
      /*
       * 平台自带的「我喜欢」这类歌单，一条歌都没有也照样由接口返回。
       * 卡片摆在那儿、点进去空列表，用户只会以为是没加载出来
       * （原话：「本地有个我的喜欢的歌单，不管有没有歌都显示」）。
       * `songCount === 0` 才隐藏——字段缺失（部分平台不给）保留，宁可多不可少。
       */
      && i.songCount !== 0)),
    [platList, prefs.hidden, prefs.arrange],
  )

  /**
   * 「收藏的歌单」这一组同样处理 0 首的。
   *
   * 收藏是**本地快照**（存的是收藏那一刻的 name/cover/songCount），
   * 平台那边后来清空了也不会有任何推送，卡就一直摆着 —— 用户说的
   * 「本地有个我的喜欢的歌单，不管有没有歌都显示」，说的就是这种
   * 已经落到本地、却早已空掉的卡。
   *
   * 规则和上面一致：`songCount === 0` 才藏，字段缺失（老版本存的快照
   * 压根没这个字段）一律保留，宁可多不可少。
   *
   * 整理态反过来**全部显示**：这一组没有「已移除」回收站，
   * 藏起来就等于用户再也点不到 ×、取消不掉这个收藏了。
   */
  const favShown = useMemo(
    () => (tidy ? pl.favs : pl.favs.filter(f => f.songCount !== 0)),
    [pl.favs, tidy],
  )

  /*
   * 平台那边已经删掉的歌单，把它从「已移除」表里清掉。
   *
   * 只对**拉到过歌单**的平台执行：某家拉取失败时它整组都不在 platList 里，
   * 这时候 prune 会把它的隐藏项当成「已删除」全清空，用户下次刷新就看见它们回来了。
   */
  useEffect(() => {
    const bySrc = new Map<PlatformSource, string[]>()
    for (const i of platList) {
      const k = platKey(i.source, i.id)
      const arr = bySrc.get(i.source)
      if (arr) arr.push(k)
      else bySrc.set(i.source, [k])
    }
    for (const [s, keys] of bySrc) prefs.prune(s, keys)
    // prefs.prune 每次渲染都是新函数，依赖它会让这个 effect 反复跑；只认 platList
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platList])
  /*
   * 「为你推荐」的两颗旋钮：第几批、每家出几首。
   *
   * `seed` 只在这次会话里有效（重启回到平台原序）；`weights` 落盘——
   * 口味配比是长期偏好，不该每次开 App 都重调一遍。
   */
  const [mixSeed, setMixSeed] = useState(0)
  /*
   * 详情页里也能换一批，所以 seed 不能只活在这一页的 state 里：
   * 订阅一份，谁换都跟着换（详见 `online.subscribeMixSeed`）。
   */
  useEffect(() => subscribeMixSeed(setMixSeed), [])
  const [recoW, setRecoW] = useState<RecoWeights>(DEFAULT_RECO_WEIGHTS)
  const [recoOpen, setRecoOpen] = useState(false)
  useEffect(() => {
    void settings.get<RecoWeights>(KEYS.recoWeights).then(v => {
      if (v) setRecoW({ ...DEFAULT_RECO_WEIGHTS, ...v })
    })
  }, [])
  /*
   * 参与「为你推荐」的平台：登录过的，或平台本身支持免登录日推（酷我榜单洗牌）。
   * 一家都没登录时混排本来就不出现，所以这里也只列可用的——滑块分成几块，
   * 取决于用户真正登录了几家（四家 = 四块）。
   */
  const recoPlatforms = useMemo(
    () => PLATFORMS.filter(s => {
      const api = apiFor(s)
      /* 和 `dailyMix` 的过滤条件保持一致：没有日推接口的平台压根不参与混排 */
      if (!api?.getDailyRecommend) return false
      return !!accounts[s] || api.dailyWithoutLogin === true
    }),
    [accounts],
  )
  /** 这一批的总首数：每家 8 首（升级前后完全一致），四家 = 32。拖动只改配比，不改总数 */
  const recoTotal = recoPlatforms.length * 8
  /** 改配比：滑块一次给全四家，落盘（口味配比是长期偏好，不该每次开 App 重调） */
  const setWeights = useCallback((next: RecoWeights) => {
    setRecoW(next)
    void settings.set(KEYS.recoWeights, next).catch(() => {})
  }, [])
  /** 各平台个性化推荐混排：「不知道听什么」时点这一条 */
  const { mix, loading: mixLoading } = useDailyMix(accounts, { seed: mixSeed, weights: recoW }, refreshTick)
  const [qrSource, setQrSource] = useState<PlatformSource | null>(null)
  /** 走「手机号 + 短信验证码」的平台：QQ 音乐、酷狗（不扫码、不开网页） */
  const [phoneLogin, setPhoneLogin] = useState<PlatformSource | null>(null)

  const startLogin = useCallback(async (s: PlatformSource) => {
    /*
     * 手机上不摆二维码。
     *
     * 扫码登录的前提是「手边有另一台设备」——安卓 / 平板这台设备本身就是手机，
     * 让用户拿手机扫自己屏幕上的码是走不通的（很多人只有这一台）。
     * 原生壳里直接进手机号登录页（`PlatformLoginActivity` 的移动版分支），
     * 桌面（Tauri）才画二维码。
     *
     * 判的是 `isAndroid` 而不是 `isNative`：桌面 Tauri 也是 native，
     * 用 isNative 会把 Windows 那张好用的二维码一起关掉。
     */
    if (!bridge.isAndroid && supportsQr(s)) { setQrSource(s); return }
    /*
     * QQ 音乐 / 酷狗走验证码（桌面和手机都是）。
     *
     * QQ 那边是官方登录窗在手机上是死结：用户一切去 QQ，登录页就被系统挂起，
     * 回来时页面已经重载换了码（实测二维码 123 秒寿命，离开 2 秒就换）；
     * 密码登录又被风控挡住。收短信全程留在 App 内，不依赖第二台设备。
     *
     * 酷狗那边不光是为了手机：它的网页登录窗签的是网页凭证，读云歌单一律
     * `20017`；验证码接口签的是 App 级 token，「我的歌单」才拉得出来。
     * 所以桌面也不该再开那个登录窗。
     */
    if (s === 'tx' || s === 'kg') { setPhoneLogin(s); return }
    const r = await loginPlatform(s)
    if (r.ok) {
      clearDailyCache()
      toast(`已登录${platformName(s)}`, { ok: true })
    } else if (!r.cancel) {
      toast(r.error || '登录失败', { bad: true })
    }
  }, [])

  const stopLogin = useCallback(async (s: PlatformSource) => {
    const ok = await confirm({
      title: `退出${platformName(s)}账号？`,
      message: '退出后这部分歌单就看不到了，随时可以再登。',
      confirmText: '退出',
      danger: true,
    })
    if (!ok) return
    await logoutPlatform(s, () => apiFor(s)?.logout?.() ?? Promise.resolve())
    clearDailyCache()
    toast(`已退出${platformName(s)}`)
  }, [])

  /**
   * 「凭证读不了歌单」时的一键补救：清掉这一家的登录态，立刻重开登录。
   *
   * 和 `stopLogin` 分开：那边是用户主动退出，要确认一次；这里是界面已经把
   * 原因写清楚了（酷狗老凭证读不了云歌单），再弹一次确认只是多一道门。
   */
  const relogin = useCallback(async (s: PlatformSource) => {
    await logoutPlatform(s)
    clearDailyCache()
    setRefreshTick(t => t + 1)
    await startLogin(s)
  }, [startLogin])

  /**
   * 刷新「我的」：平台上的歌单是会变的（在手机上新建、收藏、取消收藏），
   * 而这一页只在登录态变化时自动重拉——不刷新就只能重启应用才看得到新歌单。
   * 每日推荐的缓存也一起清掉，它按天变。
   */
  const doRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    clearDailyCache()
    setRefreshTick(t => t + 1)
    setProfile(await loadProfile())
    toast('已刷新', { ok: true })
    setRefreshing(false)
  }, [refreshing])

  /* 本地音乐横条卡的封面：取曲库里前 4 张专辑封面拼一格 */
  const libMosaic = useMemo(() => mosaicOf(p.library, 4), [p.library])
  /*
   * 「我喜欢的音乐」= 收藏的歌曲。
   *
   * 以前收藏只往 favs 集合里塞一个 id：播放页那颗心变红了，但「我的」里
   * 什么也看不到——用户的原话是「点了就收藏，也没有加到一个默认歌单中」。
   * 现在把它当成**第一个固定歌单**列出来：有收藏才出现（收藏为 0 时
   * 不占位置，空卡比没有更奇怪），点进去就是曲库的「收藏」分类。
   */
  const favs = useFavs()
  const favTracks = useMemo(() => favTracksOf(favs.list, p.library), [favs.list, p.library])
  const favMosaic = useMemo(() => mosaicOf(favTracks, 4), [favTracks])
  const favMeta = useMemo(() => {
    if (!favTracks.length) return ''
    const total = favTracks.reduce((n, t) => n + (t.duration || 0), 0)
    return `${favTracks.length} 首 · ${fmtTime(total)}`
  }, [favTracks])
  const libMeta = useMemo(() => {
    const scope = p.scanScope === 'full' ? '全盘扫描' : p.scanScope === 'custom' ? '指定文件夹' : '音乐文件夹'
    const parts = [`${p.library.length} 首`, scope]
    if (p.lastScanAt) parts.push('上次扫描 ' + relTime(p.lastScanAt))
    return parts.join(' · ')
  }, [p.library.length, p.scanScope, p.lastScanAt])

  useEffect(() => {
    void (async () => setProfile(await loadProfile()))()
  }, [])

  const openNew = () => { setDraftName(''); setDraftNote(''); setEditing({ mode: 'new' }) }
  const openRename = (l: LocalPlaylist) => { setDraftName(l.name); setDraftNote(l.note ?? ''); setEditing({ mode: 'rename', list: l }) }

  const submitEdit = () => {
    const name = draftName.trim()
    if (!name) return
    if (editing?.mode === 'new') {
      pl.create(name, { note: draftNote })
      toast(`已新建歌单「${name}」`, { ok: true })
    } else if (editing?.mode === 'rename') {
      pl.rename(editing.list.id, name)
      toast('已改名', { ok: true })
    }
    setEditing(null)
  }

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of pl.lists) {
      const byId = new Set(p.library.map(t => t.id))
      map.set(l.id, l.trackIds.filter(id => byId.has(id)).length)
    }
    return map
  }, [pl.lists, p.library])

  /** 导入：选文件 → 解析 → 与曲库匹配 → 存成歌单 */
  const doImport = useCallback(async () => {
    if (importing) return
    setImporting(true)
    try {
      const path = await bridge.invoke<string | null>('pick_playlist_file')
      if (!path) return
      const fileName = path.replace(/^.*[\\/]/, '')

      /* 洛雪 .lxmc：歌带平台直连 id，直接建成「在线歌单」，不走路库匹配 */
      if (/\.lxmc$/i.test(fileName)) {
        const raw = await bridge.invoke<number[] | string>('read_bin_abs', { path })
        const buf = typeof raw === 'string'
          ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
          : new Uint8Array(raw)
        const { isLxmcBuffer, parseLxmc } = await import('../lib/lxmc')
        if (isLxmcBuffer(buf)) {
          const lists = await parseLxmc(buf)
          if (lists.length) {
            for (const lx of lists) {
              if (!lx.tracks.length) continue
              pl.create(lx.name, { trackIds: lx.tracks.map(t => t.id), origin: 'import', originName: fileName })
            }
            const total = lists.reduce((n, l) => n + l.tracks.length, 0)
            toast(`已导入 ${lists.length} 张歌单 · ${total} 首`, { ok: true })
            const item = { name: fileName, at: Date.now(), total, matched: total }
            const recent = (await settings.get<typeof item[]>(KEYS.recentImports)) ?? []
            void settings.set(KEYS.recentImports, [item, ...recent.filter(x => x.name !== fileName)].slice(0, 5))
            return
          }
        }
        toast('无法识别该文件，请确认是洛雪歌单导出的文件', { bad: true })
        return
      }

      const text = await bridge.invoke<string>('read_text_abs', { path })
      const parsed = parsePlaylist(text, fileName)
      if (!parsed.songs.length) {
        toast('文件里没有识别到歌曲', { bad: true })
        return
      }
      const out = matchSongs(parsed.songs, p.library)
      const created = pl.create(parsed.name || fileName.replace(/\.[a-z0-9]+$/i, ''), {
        trackIds: out.matched.map(m => m.track.id),
        missing: out.unmatched.map(s => ({ title: s.title, artist: s.artist })),
        origin: 'import',
        originName: fileName,
      })
      const miss = out.unmatched.length
      toast(
        `已导入「${created.name}」：${out.matched.length} 首${miss ? `，还有 ${miss} 首曲库里没有` : ''}`,
        { bad: miss > 0 && out.matched.length === 0 },
      )
      const item = { name: fileName, at: Date.now(), total: parsed.songs.length, matched: out.matched.length }
      const recent = (await settings.get<typeof item[]>(KEYS.recentImports)) ?? []
      void settings.set(KEYS.recentImports, [item, ...recent.filter(x => x.name !== fileName)].slice(0, 5))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { bad: true })
    } finally {
      setImporting(false)
    }
  }, [importing, p.library, pl])

  const playList = (l: LocalPlaylist) => {
    const tracks = pl.tracksOf(l, p.library)
    if (!tracks.length) { toast('歌单里没有可播放的本地歌曲', { bad: true }); return }
    p.playList(tracks, 0)
  }

  /*
   * 「我的歌单」里各平台组的顺序。
   *
   * 本地那组固定在最前（那是「我的」本体），平台之间可以换位置：
   * 四家各成一堆，「我常用的那家」不该永远排在最后。
   * 没歌单的平台不入列，不会留个空标题。
   */
  const platKeys = useMemo(
    () => prefs.arrangeSources(PLATFORMS.filter(s => platShown.some(i => i.source === s))),
    [platShown, prefs.arrangeSources],
  )

  /** 平台组换位：整表写回，没排过的平台下次会沉到后面 */
  const reorderGroups = useCallback((from: number, to: number) => {
    const next = [...platKeys]
    if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return
    const [k] = next.splice(from, 1)
    next.splice(to, 0, k)
    prefs.setSrcOrder(next)
  }, [platKeys, prefs])

  /** 组头的 ↑ / ↓：一次挪一格，不用拖 */
  const moveGroup = useCallback((i: number, dir: -1 | 1) => reorderGroups(i, i + dir), [reorderGroups])

  /*
   * 触摸手势全部交给 `SortableGrid`：
   *
   *   按住 340ms → 卡片抬起（is-armed）
   *   · 动了        → 拖动排序
   *   · 不动就松手  → 进整理态（卡上出现 × 和手柄）
   *   整理态里按手柄 → **立刻**可拖，不用等长按
   *
   * 最后这条是 2026-11-11 补的。整理态里「整卡按住就拖」和「按住滚页面」
   * 是同一根手指，浏览器永远先判滚动、发 pointercancel 把拖动打断，
   * 用户看到的就是「拖不动 / 拖到一半弹回去」。手柄写死 `touch-action:none`，
   * 从它按下去浏览器就不接管——这条路上手一定跟得上。
   *
   * 以前整理态里还额外挂一层「长按弹菜单」，菜单里只有「从『我的』里移除」——
   * 和卡上那颗 × 完全重复，而且整理态本来就要能上下滚列表：手指按住稍久
   * 就弹出一个盖住卡片的窗，纯属误触。
   *
   * 桌面右键（下面的 `onContextMenu`）保持不变：鼠标用户习惯走那条路。
   */

  /** 进抖动整理态（长按 / 右键 / 标题「整理」三个入口都走这里） */
  const enterEdit = useCallback(() => {
    setTidy(true)
    // 手机上顺带收一下焦点，免得刚进入就弹出输入法（搜索框还在的话）
    const el = document.activeElement
    if (el instanceof HTMLElement && el !== document.body) el.blur()
  }, [])

  /* 整理态按 Esc 退出：鼠标用户在桌面上不用去找「完成」 */
  useEffect(() => {
    if (!tidy) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTidy(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tidy])

  /**
   * 删除态下按系统返回键 = 退出删除态（而不是退出页面 / 退出 App）。
   *
   * 用户原话：「当歌单处于可以删除状态时，点击返回按钮，应该是退出删除歌单这个状态」。
   * 注册在 `pushBackLayer` 上，优先级高于页面自己的返回处理；
   * 桌面端没有这个通道（`pushBackLayer` 在非安卓下是空操作），照旧点空白或 Esc。
   */
  useEffect(() => {
    if (!tidy) return
    return pushBackLayer(() => { setTidy(false); return true })
  }, [tidy])

  /**
   * 平台歌单本地移除。
   *
   * 不碰平台：四家都没有「删我建的歌单」的第三方接口（用户也同意不做）。
   * 这里只是记进 `platPrefs.hidden`，刷新重拉后照样被过滤掉；
   * 想找回就在「已移除」里点恢复。
   */
  const hidePlat = useCallback((item: HotPlaylistItem) => {
    prefs.hide(platKey(item.source, item.id))
    toast(`已从「我的」里移除「${item.name}」`, { ok: true })
  }, [prefs])

  /**
   * 平台组内换位。
   *
   * `items` 是拖动前的顺序，把这一张挪到 `to` 再整表写回。
   * 只写这一家（`prefs.setOrder` 按平台前缀替换），别家排好的顺序不受影响。
   */
  const reorderPlat = useCallback((source: PlatformSource, items: HotPlaylistItem[], from: number, to: number) => {
    const keys = items.map(i => platKey(i.source, i.id))
    if (from < 0 || from >= keys.length || to < 0 || to >= keys.length || from === to) return
    const [k] = keys.splice(from, 1)
    keys.splice(to, 0, k)
    prefs.setOrder(source, keys)
  }, [prefs])

  /** 删本地歌单（菜单和整理态的 × 共用一份确认文案） */
  const removeLocal = useCallback((l: LocalPlaylist) => {
    void confirm({
      title: `删除歌单「${l.name}」？`,
      message: '只删这个歌单，歌还在曲库里。',
      confirmText: '删除',
      danger: true,
    }).then(ok => {
      if (!ok) return
      pl.remove(l.id)
      toast(`已删除「${l.name}」`)
    })
  }, [pl])

  const listMenu = (l: LocalPlaylist): MenuItem[] => [
    { id: 'play', label: '播放', icon: <IconPlay width={14} height={14} />, onSelect: () => playList(l) },
    { id: 'open', label: '打开歌单', icon: <IconFolder width={14} height={14} />, onSelect: () => onOpenLocalPlaylist(l.id) },
    { id: 'd1', label: '', divider: true, onSelect: () => {} },
    { id: 'rename', label: '重命名', onSelect: () => openRename(l) },
    {
      id: 'del', label: '删除歌单', danger: true, icon: <IconTrash width={14} height={14} />,
      onSelect: () => removeLocal(l),
    },
  ]

  return (
    <div
      className="page home-page"
      data-edit={tidy ? 'true' : undefined}
      /*
       * 整理态点空白处退出（iPhone 也是这个手感）。
       *
       * 两个例外必须放过：点在卡片上（交给卡片自己处理，不然拖完一抬手就退出了），
       * 以及刚拖完那一下补发的 click（`isJustDragged`）。少了第二条，
       * 「松手」会被当成「点了空白」，抖动状态一闪就没。
       */
      onClick={e => {
        if (!tidy || isJustDragged()) return
        const t = e.target as HTMLElement
        if (t.closest('[data-skey]')) return
        setTidy(false)
      }}
    >
      <header className="lib-head home-head">
        <div className="lib-head-left">
          <h1>我的</h1>
          <p className="lib-status">
            {/* 「收藏」这里数的是**收藏的歌曲**（= 我喜欢的音乐）；
                收藏的在线歌单另有 `pl.favs`，但两个数混在一行只会让人对不上账 */}
            {pl.lists.length} 个歌单 · {favTracks.length} 首收藏 · 本地 <b className="num">{p.library.length}</b> 首
          </p>
        </div>
        <div className="lib-actions">
          <button className="primary-btn" onClick={openNew}>
            <IconPlus width={13} height={13} /> 新建歌单
          </button>
          <button className="ghost-btn" onClick={() => void doImport()} disabled={importing}>
            <IconUpload width={13} height={13} /> {importing ? '导入中…' : '导入歌单'}
          </button>
          <HelpTip text={IMPORT_HELP} label="歌单导入说明" width={340} />
        </div>
        {/*
         * 右上角两颗工具钮单独成组。
         * 以前它们用绝对定位钉在页头右侧（`right:0/56px; top:-8px`），
         * 页头本身从安全区下沿开始 —— `top:-8` 就把圆钮顶进了状态栏，
         * 看上去像「按钮超出去了」。改成一个独立的 flex 组，跟着网格行走，
         * 高度由内容决定，怎么都不会越界。
         */}
        <div className="lib-tools">
          {/* 刷新：平台歌单在手机上改过之后，这里不会自己变 */}
          <button
            className={'ghost-btn home-refresh' + (refreshing ? ' busy' : '')}
            onClick={() => void doRefresh()}
            disabled={refreshing}
            title="刷新平台歌单与推荐"
            aria-label="刷新"
          >
            <IconRefresh width={13} height={13} />
            <span className="home-refresh-lb">刷新</span>
          </button>
          {/* 登录入口放在这里：同步是「我的」的事，不该逼用户去设置里找 */}
          <button className={'ghost-btn home-acct' + (profile ? ' on' : '')} onClick={() => setAcctOpen(true)}>
            <IconUser width={13} height={13} />
            <span className="acct-label">
              {profile ? (profile.email ? shortMail(profile.email) : '已登录') : '登录'}
            </span>
          </button>
        </div>
      </header>

      <div className="home-scroll">
        {PLATFORMS.length > 0 && (
          <div className="home-plats-wrap">
            {/*
             * 折叠头。
             *
             * 四家都登录之后，这一块对用户就只剩「我登过」这一个信息量，
             * 却一直占着四行（手机 224px，比「本地音乐」那条入口还高）。
             * 收起来一条，需要退出/换号时再点开。
             *
             * 头像叠在右侧：一眼看出「登的是哪几个号」，比写四行名字省地方。
             */}
            <button
              type="button"
              className="home-plats-head"
              aria-expanded={platsOpen}
              aria-controls="home-plat-list"
              onClick={togglePlats}
            >
              <span className="hph-dots" aria-hidden="true">
                {PLATFORMS.map(s => (
                  <i key={s} data-src={s} data-on={accounts[s] ? 'true' : undefined} />
                ))}
              </span>
              <span className="hph-title">平台账号</span>
              {/*
               * 默认收起之后，这一句就是唯一的「入口提示」：
               * 有没登录的写「N 家待登录」（强调色，暗示可以点开），
               * 全登好了写「4/4 已登录」（灰的，纯状态）。
               */}
              <span className="hph-sum" data-need={platsNeedLogin ? 'true' : undefined}>
                {platsNeedLogin
                  ? `${PLATFORMS.length - loggedCount} 家待登录`
                  : `${loggedCount}/${PLATFORMS.length} 已登录`}
              </span>
              <span className="hph-avatars" aria-hidden="true">
                {PLATFORMS.filter(s => accounts[s]?.avatar).slice(0, 4).map(s => (
                  <i key={s} style={{ backgroundImage: `url(${accounts[s]!.avatar})` }} />
                ))}
              </span>
              <span className="hph-chev" data-open={platsOpen ? 'true' : undefined} aria-hidden="true" />
            </button>
            {platsOpen && (
          <div className="home-plats" id="home-plat-list">
            {PLATFORMS.map(s => {
              const acc = accounts[s]
              return (
                <div className={'home-plat' + (acc ? ' on' : '')} data-src={s} key={s}>
                  <span className="home-plat-dot" aria-hidden="true" />
                  <span className="home-plat-name">{platformName(s)}</span>
                  {acc
                    ? (
                      <>
                        <span className="home-plat-user">
                          {/* 没拉到头像时不要画那个灰圆圈：一个空圆看起来像「图挂了」 */}
                          {acc.avatar && (
                            <span
                              className="home-plat-avatar"
                              style={{ backgroundImage: `url(${acc.avatar})` }}
                              aria-hidden="true"
                            />
                          )}
                          {/*
                           * 昵称照平台原样显示。有人故意设成全透明字符（`ㅤ`），
                           * 那就该像 QQ 音乐一样看起来是空的——不能替换成编出来的
                           * 「QQ音乐用户 xxx」，那会让人以为登错了号。
                           * 空白昵称在桌面端把账号挂到 title 上，鼠标一悬停就知道是谁；
                           * 无障碍标签同理（读屏念一串空白等于没念）。
                           */}
                          <span
                            className="home-plat-nick"
                            title={nicknameText(acc.nickname) ? acc.nickname : `${platformName(s)} ${acc.userId}`}
                            aria-label={nicknameText(acc.nickname) ? acc.nickname : `${platformName(s)} ${acc.userId}`}
                          >
                            {acc.nickname || '已登录'}
                          </span>
                        </span>
                        <button className="home-plat-btn quiet" onClick={() => void stopLogin(s)}>退出</button>
                      </>
                    )
                    : <button className="home-plat-btn" onClick={() => void startLogin(s)}>登录</button>}
                </div>
              )
            })}
          </div>
            )}
          </div>
        )}

        {/*
         * 本地音乐：一条横贯整行的卡片，永远排在歌单上面。
         * 以前把它塞在歌单下面，歌单一多就得往下滚才找得到——
         * 「我的」里最常用的是自己的曲库，不该被歌单挡住。
         * 点这条打开完整的曲库页（扫描 / 搜索 / 多选都在那边）。
         */}
        <div
          className="home-band"
          role="button"
          tabIndex={0}
          title="打开本地音乐"
          onClick={onOpenLibrary}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenLibrary() } }}
        >
          <span className="home-band-cover">
            {/* 占位音符必须**垫在底下**：本地曲目抽不到内嵌封面时，安卓壳会回一张
                1×1 全透明 PNG（见 Bridge/MainActivity 的 cover 拦截），
                img 正常加载、只是全透明——条件渲染的分支会以为「有封面」，
                结果是一块空方块。垫一层再盖上去，透明也能看出是「没有封面」。 */}
            <span className="home-cover-blank"><IconMusicNote width={24} height={24} /></span>
            {libMosaic.length > 0 && (
              <span className={'home-mosaic n' + libMosaic.length}>
                {libMosaic.map((src, i) => <img key={i} src={src} alt="" decoding="async" />)}
              </span>
            )}
          </span>
          <span className="home-band-main">
            <span className="home-band-name">本地音乐</span>
            <span className="home-band-meta">
              {p.library.length
                ? libMeta
                : '曲库还是空的 · 点开去扫描'}
            </span>
          </span>
          <span className="home-band-acts">
            {p.library.length > 0 && (
              <button
                className="home-band-play"
                aria-label="播放全部本地音乐"
                onClick={e => { e.stopPropagation(); p.playList(p.library, 0) }}
              >
                <IconPlay width={13} height={13} /> <span className="home-band-play-t">播放全部</span>
              </button>
            )}
            <span className="home-band-more">查看全部 →</span>
          </span>
        </div>

        {/* 「今天听什么」：各平台按你口味推的歌混成一条，点一下就能直接连着听 */}
        {mix && mix.songs.length > 0 && (
          <div
            className="home-band home-reco"
            role="button"
            tabIndex={0}
            title="打开为你推荐"
            onClick={() => onOpenOnlinePlaylist({ source: mix.source, id: 'daily:mix', name: '为你推荐' })}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpenOnlinePlaylist({ source: mix.source, id: 'daily:mix', name: '为你推荐' })
              }
            }}
          >
            <span className="home-band-cover">
              <span className="home-cover-blank"><IconMusicNote width={24} height={24} /></span>
              {mix.cover && <img className="home-reco-art" src={mix.cover} alt="" decoding="async" />}
            </span>
            <span className="home-band-main">
              <span className="home-band-name">为你推荐</span>
              {/* 平台名罗列在桌面是信息，在 390dp 上会挤成一串省略号：
                  手机只留「口味 + 首数」，平台数量交给右侧的小字 */}
              <span className="home-band-meta">
                <span className="hm-long">
                  按你的口味 · {mix.name.replace(/^为你推荐 · /, '')} · {mix.songCount} 首
                </span>
                <span className="hm-short">按你的口味 · {mix.songCount} 首</span>
              </span>
            </span>
            <span className="home-band-acts">
              {/*
               * 换一批 / 调口味。
               *
               * 这两颗按钮是「一次性推荐」和「天天一样的列表」之间的区别：
               * 日推池当天不变，但取哪几首、谁先出可以换；权重只影响配比，
               * 不换歌——用户想的是「今天多听点网易云」而不是「不要 QQ」。
               */}
              <button
                className={'home-band-icon' + (mixLoading ? ' is-busy' : '')}
                title="换一批推荐"
                aria-label="换一批推荐"
                onClick={e => { e.stopPropagation(); nextMixSeed() }}
              >
                <IconRefresh width={14} height={14} />
              </button>
              <button
                className="home-band-icon"
                title="调整各平台推荐权重"
                aria-label="调整各平台推荐权重"
                onClick={e => { e.stopPropagation(); setRecoOpen(true) }}
              >
                <IconSliders width={14} height={14} />
              </button>
              <button
                className="home-band-play"
                aria-label="播放为你推荐"
                onClick={e => { e.stopPropagation(); p.playList(toLocalTracks(mix.songs), 0) }}
              >
                <IconPlay width={13} height={13} /> <span className="home-band-play-t">播放</span>
              </button>
              <span className="home-band-more">查看全部 →</span>
            </span>
          </div>
        )}

          <section className="home-sec">
            <div className="home-sec-head">
              <h2>我的歌单</h2>
              <span className="modal-sp" />
              {/*
               * 整理入口。
               *
               * 触发方式是「长按（手指）/ 右键（鼠标）」，但这两个都是**藏起来的**手势，
               * 不点出来没人知道；所以标题这一行再给一颗明确的按钮。
               * 进到整理态之后同一位置变成「完成」，不用去底部找。
               */}
              {/*
               * 视图切换。放在「整理」旁边：这两件事是同一层的「怎么摆/怎么看」。
               * 图标显示的是**将要切到的那个**形态（现在卡片 → 显示列表图标），
               * 和播放/暂停同一套心智，不用先读 tooltip 才敢按。
               */}
              {(pl.lists.length > 0 || platShown.length > 0 || pl.favs.length > 0) && (
                <button
                  className="icon-btn home-view-btn"
                  onClick={toggleView}
                  aria-pressed={view === 'list'}
                  title={view === 'grid' ? '切换为列表' : '切换为卡片'}
                  aria-label={view === 'grid' ? '切换为列表' : '切换为卡片'}
                >
                  {view === 'grid'
                    ? <IconRows width={15} height={15} />
                    : <IconGrid width={15} height={15} />}
                </button>
              )}
              {tidy ? (
                <>
                  <span className="home-edit-hint">
                    {view === 'grid' ? '按住封面拖动 · 点 × 移除' : '拖右端手柄排序 · 点 × 移除'}
                    {platKeys.length > 1 && <span className="he-desk"> · 拖平台名右边的六点换组序</span>}
                  </span>
                  <button className="ghost-btn home-edit-done" onClick={() => setTidy(false)}>
                    完成
                  </button>
                </>
              ) : (
                (pl.lists.length > 0 || platShown.length > 0 || pl.favs.length > 0) && (
                  <button className="ghost-btn home-edit-btn" onClick={enterEdit} title="整理歌单：拖动排序、移除">
                    整理
                  </button>
                )
              )}
            </div>
            {/*
             * 被移除的平台歌单入口。
             *
             * 必须有一个：移除是**本地**的，平台上那份还在，用户想找回来只能靠这里。
             * 没有这个入口的话，「移错了」就等于永久消失。
             */}
            {prefs.hidden.size > 0 && !tidy && (
              <button className="home-hidden-bar" onClick={() => setHiddenOpen(true)}>
                已移除 {prefs.hidden.size} 个平台歌单
                <span>点这里找回</span>
              </button>
            )}
            {/*
             * 登录了却拿不到歌单的平台，在这里说清楚。
             *
             * 典型是酷狗的老存档：之前用网页登录窗登过，cookie 里的 `t` 读云歌单
             * 一律 20017。现在登录改成验证码（签的是 App token），新登录不会再有
             * 这个问题；但老凭证还在，界面就会显示「已登录却没歌单」。
             * 给一句原因 + 一个能立刻走通的补救（重登 / 导入）。
             */}
            {PLATFORMS.filter(s => platErrors[s]).map(s => (
              <div className="home-plat-err" key={`plerr:${s}`}>
                <span className="home-plat-err-txt">
                  <b>{platformName(s)}的歌单取不到</b>
                  <span>{platErrors[s]}</span>
                </span>
                {/*
                 * 凭证过期 / 类型不对（酷狗老存档）→ 给「重新登录」；
                 * 平台这条路走不通（接口没有）→ 只能给「导入歌单」。
                 * 判据是错误文案自己说了要重登，不是猜平台名。
                 */}
                {/重登/.test(platErrors[s] ?? '') ? (
                  <button className="ghost-btn" onClick={() => void relogin(s)}>
                    <IconUser width={12} height={12} /> 重新登录
                  </button>
                ) : (
                  <button className="ghost-btn" onClick={() => void doImport()}>
                    <IconUpload width={12} height={12} /> 导入歌单
                  </button>
                )}
              </div>
            ))}
            {pl.lists.length === 0 && platShown.length === 0 && favTracks.length === 0 ? (
              <div className="home-empty">
                <div className="t">还没有歌单</div>
                <div className="s">新建一个，把喜欢的歌归到一起</div>
                <div className="home-empty-acts">
                  <button className="primary-btn" onClick={openNew}><IconPlus width={13} height={13} /> 新建歌单</button>
                  <button className="ghost-btn" onClick={() => void doImport()}><IconUpload width={13} height={13} /> 导入歌单</button>
                </div>
              </div>
            ) : (
              <>
                {/*
                 * 分组标题只在「这一组真的有东西」时出现。
                 *
                 * 以前是**一个**网格把本地歌单、我喜欢的音乐、四个平台的歌单全平铺在一起：
                 * 登了四个平台之后一屏十几张卡，谁家的只能看角标那行小字，
                 * 想找「酷我那个歌单」要挨个认封面。分组之后平台名是标题，扫一眼就到。
                 */}
                {(favTracks.length > 0 || pl.lists.length > 0) && (
                  <div className="home-group" data-shut={groupsShut.includes('local') ? 'true' : undefined}>
                    <div className="home-group-head">
                      {/* 「本地」这组也跟着能收：和平台组同一套手感，不然只有一个
                          能收一个不能收，用户会以为是坏的 */}
                      <button
                        type="button"
                        className="hg-toggle"
                        aria-expanded={!groupsShut.includes('local')}
                        title={groupsShut.includes('local') ? '展开「本地」' : '收起「本地」'}
                        onClick={e => { e.stopPropagation(); toggleGroup('local') }}
                      >
                        <span className="hg-chev" data-open={groupsShut.includes('local') ? undefined : 'true'} aria-hidden="true" />
                        <span className="hg-name">本地</span>
                        <span className="home-group-n">
                          {pl.lists.length + (favTracks.length > 0 ? 1 : 0)}
                        </span>
                      </button>
                    </div>
                    {!groupsShut.includes('local') && (
                    <SortableGrid
                      className={gridCls}
                      deleting={tidy}
                      onHold={enterEdit}
                      /*
                       * 整理态里长按卡片 → 这张卡的功能菜单。
                       *
                       * 不再等系统 `contextmenu`（WebView 里常不派发，见 SortableGrid 的
                       * `onMenu` 注释）。落点用 `elementFromPoint` 反查是哪张卡：
                       * 手指就按在卡上，这一下命中的一定是它。
                       */
                      onMenu={at => {
                        const el = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>('.home-card')
                        const sk = el?.dataset.skey ?? ''
                        if (!sk.startsWith('local:')) return
                        const hit = pl.lists.find(x => x.id === sk.slice('local:'.length))
                        if (hit) setMenu({ x: at.x, y: at.y, list: hit })
                      }}
                      /*
                       * 本地这一组的第一格是「我喜欢的音乐」（固定卡，不可拖），
                       * 所以网格下标要减 1 才对应 `pl.lists` 的位置。
                       *
                       * `lead` 必须按「固定卡到底在不在」算：没有收藏的时候
                       * 第一格就是歌单 A，一律减 1 会让每次拖动都只挪半格——
                       * 实测「拖 A 到 C 的位置」最后停在 B、A、C。
                       * `minIndex` 顺带挡住「拖到固定卡那一格」：它不会挪走，
                       * 歌单最多排到第二位。
                       */
                      minIndex={favTracks.length > 0 ? 1 : 0}
                      onReorder={(from, to) => {
                        const lead = favTracks.length > 0 ? 1 : 0
                        pl.reorder(from - lead, to - lead)
                      }}
                    >
                {/*
                 * 第一张固定卡：我喜欢的音乐。
                 *
                 * 它不是一个真歌单（没有 Playlist 对象，也不落盘成歌单），
                 * 而是收藏集合的一个视图 —— 播放页/长按面板里点的那颗心，
                 * 落点就是这里。所以不给「编辑 / 删除」，也不走右键菜单。
                 * 整理态下它照样站着不动（`data-fixed`），只是别拖它。
                 */}
                      {favTracks.length > 0 && (
                        <div
                          className="home-card is-fav"
                          data-skey="fav"
                          data-fixed="true"
                          role="button"
                          tabIndex={0}
                          title={`我喜欢的音乐 · ${favTracks.length} 首`}
                          onClick={() => { if (tidy) return; onOpenFavs() }}
                          onKeyDown={e => { if (e.key === 'Enter') onOpenFavs() }}
                        >
                          <div className="home-cover">
                            <span className="home-cover-blank"><IconMusicNote width={22} height={22} /></span>
                            {favMosaic.length > 0 && (
                              <div className={'home-mosaic n' + favMosaic.length}>
                                {favMosaic.map((src, i) => <img key={i} src={src} alt="" decoding="async" />)}
                              </div>
                            )}
                            <span className="home-badge fav">收藏</span>
                            <button className="home-play" aria-label="播放我喜欢的音乐"
                              onClick={e => { e.stopPropagation(); p.playList(favTracks, 0) }}>
                              <IconPlay width={14} height={14} />
                            </button>
                          </div>
                          <div className="home-card-name">我喜欢的音乐</div>
                          <div className="home-card-meta">{favMeta}</div>
                          {/* 列表模式下封面变小、封面里的播放键就没地方站了：整行右侧单独给一颗 */}
                          <button
                            className="home-row-play" data-nodrag=""
                            aria-label="播放我喜欢的音乐"
                            onClick={e => { e.stopPropagation(); p.playList(favTracks, 0) }}
                          >
                            <IconPlay width={15} height={15} />
                          </button>
                        </div>
                      )}
                      {pl.lists.map(l => {
                        const tracks = pl.tracksOf(l, p.library)
                        const mosaic = mosaicOf(tracks, 4)
                        const total = tracks.reduce((n, t) => n + t.duration, 0)
                        const miss = l.missing?.length ?? 0
                        return (
                          <div
                            key={l.id}
                            className="home-card"
                            data-skey={`local:${l.id}`}
                            role="button"
                            tabIndex={0}
                            title={`${l.name} · ${tracks.length} 首`}
                            onClick={() => {
                              // 整理态里点卡片不打开歌单（否则每次拖完都跳走）
                              if (tidy || consumeLongPress()) return
                              onOpenLocalPlaylist(l.id)
                            }}
                            onKeyDown={e => { if (e.key === 'Enter' && !tidy) onOpenLocalPlaylist(l.id) }}
                            /* 长按：先当「进整理」，已经在整理里才弹菜单 */
                            /* 鼠标右键同理：第一下进整理，整理里再右键才是菜单 */
                            onContextMenu={e => {
                              e.preventDefault()
                              // 安卓长按 500ms 会补一发 contextmenu，别让它在刚进整理态后又弹菜单
                              if (isHoldContextMenu()) return
                              if (tidy) setMenu({ x: e.clientX, y: e.clientY, list: l })
                              else enterEdit()
                            }}
                          >
                            <div className="home-cover">
                              <span className="home-cover-blank"><IconMusicNote width={22} height={22} /></span>
                              {mosaic.length > 0 && (
                                <div className={'home-mosaic n' + mosaic.length}>
                                  {mosaic.map((src, i) => <img key={i} src={src} alt="" decoding="async" />)}
                                </div>
                              )}
                              <span className="home-badge">{l.origin === 'import' ? '导入' : '自建'}</span>
                              <button className="home-play" aria-label={'播放 ' + l.name}
                                onClick={e => { e.stopPropagation(); playList(l) }}>
                                <IconPlay width={14} height={14} />
                              </button>
                              {tidy && (
                                <span className="card-grip in-cover" data-drag-handle="" aria-hidden="true">
                                  <IconGrip width={24} height={24} />
                                </span>
                              )}
                            </div>
                            <div className="home-card-name">{l.name}</div>
                            <div className="home-card-meta">
                              <span className="num">{counts.get(l.id) ?? 0} 首</span>
                              {total > 0 && <span className="num"> · {fmtTime(total)}</span>}
                              {miss > 0 && <span className="home-miss"> · 缺 {miss}</span>}
                            </div>
                            {tidy && (
                              <span className="card-grip in-row" data-drag-handle="" aria-hidden="true">
                                <IconGrip width={24} height={24} />
                              </span>
                            )}
                            {tidy && (
                              <button
                                className="card-x" data-nodrag=""
                                title="删除这个歌单" aria-label={`删除 ${l.name}`}
                                onClick={e => { e.stopPropagation(); removeLocal(l) }}
                              ><IconClose width={11} height={11} /></button>
                            )}
                            {!tidy && (
                              <button
                                className="home-row-play" data-nodrag=""
                                aria-label={'播放 ' + l.name}
                                title={'播放 ' + l.name}
                                onClick={e => { e.stopPropagation(); playList(l) }}
                              >
                                <IconPlay width={15} height={15} />
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </SortableGrid>
                    )}
                        </div>
                      )}
                {/*
                 * 登录平台账号之后，自己在那边的歌单**按平台分开摆**——
                 * 「我的歌单」本来就该是「我建的歌单」，不限本地还是线上。
                 * 点开走在线歌单详情（只读：改平台歌单得回平台）。
                 *
                 * 组与组之间的顺序由用户拖（整理态拖组头右边那枚六点手柄），
                 * 存进 `platPrefs.srcOrder`。没歌单的平台整组不出现。
                 */}
                <SortableSections onReorder={reorderGroups}>
                {platKeys.map((s, gi) => {
                  const items = platShown.filter(i => i.source === s)
                  /**
                   * 这一组是不是收起来了。
                   *
                   * 默认**展开**：收起后只剩一条标题，卡片看不见就没法拖，
                   * 而「把这家那几张歌单拖到前面」正是用户要在这一页干的事。
                   * 收起来只是「这家暂时不想看」时的减负手段。
                   */
                  const shut = groupsShut.includes(s)
                  return (
                    <div className="home-group" key={s} data-gkey={s} data-shut={shut ? 'true' : undefined}>
                      <div className="home-group-head">
                        {/*
                         * 折叠按钮只包「标题 + 数量 + 小箭头」，不包整理态那三颗
                         * （button 里不能再套 button，套了浏览器会把它拆开）。
                         */}
                        <button
                          type="button"
                          className="hg-toggle"
                          aria-expanded={!shut}
                          title={shut ? `展开「${platformName(s)}」` : `收起「${platformName(s)}」`}
                          onClick={e => {
                            /* 整理态里不冒泡：否则页面那层 onClick 会顺手退出整理态 */
                            e.stopPropagation()
                            toggleGroup(s)
                          }}
                        >
                          <span className="hg-chev" data-open={shut ? undefined : 'true'} aria-hidden="true" />
                          <span className="hg-name">{platformName(s)}</span>
                          <span className="home-group-n">{items.length}</span>
                        </button>
                        {/*
                         * 整理态才出现的三颗：↑ / ↓ / 六点手柄。
                         *
                         * 为什么除了拖还要箭头：一组可能有十几张卡、好几百像素高，
                         * 要把第一组拖到第二组后面，手指得在屏幕上走七八百像素——
                         * 手机屏幕根本不够。箭头一步一格，点两下就到，稳妥。
                         * 拖动留给「鼠标」和「顺手」的场合。
                         */}
                        {tidy && platKeys.length > 1 && (
                          <span className="home-group-move">
                            <button
                              className="home-group-arrow"
                              disabled={gi === 0}
                              title={`「${platformName(s)}」上移`}
                              aria-label={`「${platformName(s)}」上移`}
                              onClick={e => { e.stopPropagation(); moveGroup(gi, -1) }}
                            ><IconChevronUp width={14} height={14} /></button>
                            <button
                              className="home-group-arrow"
                              disabled={gi === platKeys.length - 1}
                              title={`「${platformName(s)}」下移`}
                              aria-label={`「${platformName(s)}」下移`}
                              onClick={e => { e.stopPropagation(); moveGroup(gi, 1) }}
                            ><IconChevronDown width={14} height={14} /></button>
                            <button
                              className="home-group-grip"
                              data-section-handle=""
                              title={`拖动调整「${platformName(s)}」的位置`}
                              aria-label={`拖动调整「${platformName(s)}」的位置`}
                              /* 整理态里点空白会退出，点这颗不该退出 */
                              onClick={e => e.stopPropagation()}
                            ><IconGrip width={16} height={16} /></button>
                          </span>
                        )}
                      </div>
                      {/* 收起时整块卡片网格不渲染（不是 display:none）：
                          留一堆看不见的节点在图里，拖分组时会按它们的 offsetHeight 让位 */}
                      {!shut && (
                      <SortableGrid
                        className={gridCls}
                        deleting={tidy}
                        onHold={enterEdit}
                        onReorder={(from, to) => reorderPlat(s, items, from, to)}
                      >
                      {items.map(item => (
                        <div
                          key={platKey(item.source, item.id)}
                          className="home-card"
                          data-skey={platKey(item.source, item.id)}
                          role="button"
                          tabIndex={0}
                          title={`${item.name} · ${platformName(item.source)}`}
                          onClick={() => {
                            if (tidy || consumeLongPress()) return
                            onOpenOnlinePlaylist({ source: item.source, id: item.id, name: item.name })
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !tidy) onOpenOnlinePlaylist({ source: item.source, id: item.id, name: item.name })
                          }}
                          onContextMenu={e => {
                            e.preventDefault()
                            if (isHoldContextMenu()) return
                            if (tidy) setPlatMenu({ x: e.clientX, y: e.clientY, item })
                            else enterEdit()
                          }}
                        >
                          <div className="home-cover">
                            {/* 占位始终在底层：封面取不到 / 加载失败都露出音符，不会留一块空白 */}
                            <span className="home-cover-blank"><IconMusicNote width={22} height={22} /></span>
                            {item.cover && (
                              <img
                                className="home-fav-cover" src={item.cover} alt="" decoding="async"
                                onError={e => { e.currentTarget.style.display = 'none' }}
                              />
                            )}
                            {/* 分组标题已经写了平台名，卡片角标再写一遍是重复的；
                          这里标「在线」是为了和左边本地的「自建/导入」区分开 */}
                      <span className="home-badge online">在线</span>
                            {tidy && (
                              <span className="card-grip in-cover" data-drag-handle="" aria-hidden="true">
                                <IconGrip width={24} height={24} />
                              </span>
                            )}
                          </div>
                          <div className="home-card-name">{item.name}</div>
                          <div className="home-card-meta">
                            {item.songCount ? <span className="num">{item.songCount} 首</span> : <span>在线歌单</span>}
                          </div>
                          {/*
                           * 整理态的小叉：从「我的」里移除。
                           * 移的是**本地这张卡**，平台那边的歌单原封不动——
                           * 四家都没有删歌单的第三方接口，用户也同意不做。
                           */}
                          {tidy && (
                            <span className="card-grip in-row" data-drag-handle="" aria-hidden="true">
                              <IconGrip width={24} height={24} />
                            </span>
                          )}
                          {tidy && (
                            <button
                              className="card-x" data-nodrag=""
                              title="从「我的」里移除（平台上的还在）"
                              aria-label={`移除 ${item.name}`}
                              onClick={e => { e.stopPropagation(); hidePlat(item) }}
                            ><IconClose width={11} height={11} /></button>
                          )}
                        </div>
                      ))}
                      </SortableGrid>
                      )}
                    </div>
                  )
                })}
                </SortableSections>
              </>
            )}
          </section>

          {pl.favs.length > 0 && (
            <section className="home-sec">
              <div className="home-sec-head">
                <h2>收藏的歌单</h2>
                <span className="modal-sp" />
                {tidy ? (
                  <button className="ghost-btn home-edit-done" onClick={() => setTidy(false)}>完成</button>
                ) : (
                  <button className="ghost-btn home-edit-btn" onClick={enterEdit} title="整理歌单：拖动排序、移除">
                    整理
                  </button>
                )}
              </div>
              {/* 空成这样时网格里没有卡可拖，提示要放在网格**外面**：
                  SortableGrid 是按 children 下标算几何和 reorder 的，塞个 <p> 进去会让下标全错位 */}
              {favShown.length === 0 && (
                <p className="home-empty-note">收藏的歌单都空了，点上面「整理」可以取消收藏。</p>
              )}
              <SortableGrid
                className={gridCls}
                deleting={tidy}
                onHold={enterEdit}
                onReorder={(from, to) => pl.moveFav(from, to)}
              >
                {favShown.map(f => (
                  <div
                    key={f.key}
                    className="home-card"
                    data-skey={platKey(f.source, f.id)}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (tidy || consumeLongPress()) return
                      onOpenOnlinePlaylist({ source: f.source, id: f.id, name: f.name })
                    }}
                    onContextMenu={e => {
                      e.preventDefault()
                      if (isHoldContextMenu()) return
                      if (tidy) setFavMenu({ x: e.clientX, y: e.clientY, key: f.key, name: f.name })
                      else enterEdit()
                    }}
                  >
                    <div className="home-cover">
                      <span className="home-cover-blank"><IconMusicNote width={22} height={22} /></span>
                      {f.cover && (
                        <img
                          className="home-fav-cover" src={f.cover} alt="" decoding="async"
                          onError={e => { e.currentTarget.style.display = 'none' }}
                        />
                      )}
                      <span className="home-badge online">{platformName(f.source)}</span>
                      {tidy && (
                        <span className="card-grip in-cover" data-drag-handle="" aria-hidden="true">
                          <IconGrip width={24} height={24} />
                        </span>
                      )}
                    </div>
                    <div className="home-card-name">{f.name}</div>
                    <div className="home-card-meta">
                      {f.songCount ? <span className="num">{f.songCount} 首</span> : <span>在线歌单</span>}
                    </div>
                    {tidy && (
                      <span className="card-grip in-row" data-drag-handle="" aria-hidden="true">
                        <IconGrip width={24} height={24} />
                      </span>
                    )}
                    {tidy && (
                      <button
                        className="card-x" data-nodrag=""
                        title="取消收藏" aria-label={`取消收藏 ${f.name}`}
                        onClick={e => {
                          e.stopPropagation()
                          pl.toggleFav({ source: f.source, id: f.id, name: f.name, cover: f.cover, creator: f.creator, songCount: f.songCount })
                          toast(`已取消收藏「${f.name}」`)
                        }}
                      ><IconClose width={11} height={11} /></button>
                    )}
                  </div>
                ))}
              </SortableGrid>
            </section>
          )}

      </div>

      <Modal
        open={acctOpen}
        title="账号与同步"
        onClose={() => setAcctOpen(false)}
        width={430}
        footer={<><span className="modal-sp" /><button className="ghost-btn" onClick={() => setAcctOpen(false)}>关闭</button></>}
      >
        <AccountPanel compact onProfile={setProfile} />
      </Modal>

      <Modal
        open={!!editing}
        title={editing?.mode === 'rename' ? '重命名歌单' : '新建歌单'}
        onClose={() => setEditing(null)}
        width={400}
        footer={
          <>
            <button className="ghost-btn" onClick={() => setEditing(null)}>取消</button>
            <button className="primary-btn" disabled={!draftName.trim()} onClick={submitEdit}>
              {editing?.mode === 'rename' ? '保存' : '创建'}
            </button>
          </>
        }
      >
        <div className="form-col">
          <label className="form-label" htmlFor="pl-name">名称</label>
          <input
            id="pl-name" className="text-input" autoFocus maxLength={60}
            placeholder="例如「深夜通勤」"
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitEdit() }}
          />
          <label className="form-label" htmlFor="pl-note">备注（可留空）</label>
          <input
            id="pl-note" className="text-input" maxLength={120}
            placeholder="给自己留一句提示"
            value={draftNote}
            onChange={e => setDraftNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitEdit() }}
          />
        </div>
      </Modal>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={listMenu(menu.list)} onClose={() => setMenu(null)} />
      )}
      {favMenu && (
        <ContextMenu
          x={favMenu.x} y={favMenu.y}
          items={[{
            id: 'unfav', label: '取消收藏', danger: true, icon: <IconTrash width={14} height={14} />,
            onSelect: () => {
              const f = pl.favs.find(x => x.key === favMenu.key)
              if (f) pl.toggleFav({ source: f.source, id: f.id, name: f.name, cover: f.cover, creator: f.creator, songCount: f.songCount })
              toast(`已取消收藏「${favMenu.name}」`)
            },
          }]}
          onClose={() => setFavMenu(null)}
        />
      )}

      {/*
       * 整理态里对平台歌单长按 / 右键出的菜单。
       *
       * 只有一个动作，为什么还要菜单而不是直接移除：长按本来就是「进整理」的手势，
       * 在整理态里长按一下就把歌单删掉太容易误触（而且它可恢复，用户未必知道）。
       * 多这一下点击，是给「我按错了」留的余地。
       */}
      {platMenu && (
        <ContextMenu
          x={platMenu.x} y={platMenu.y}
          items={[{
            id: 'hide', label: '从「我的」里移除', danger: true,
            icon: <IconTrash width={14} height={14} />,
            onSelect: () => hidePlat(platMenu.item),
          }]}
          onClose={() => setPlatMenu(null)}
        />
      )}

      {/* 「已移除的平台歌单」：移除是本地记账，想找回只能从这儿进去 */}
      <Modal
        open={hiddenOpen}
        title="已移除的平台歌单"
        hint="只是不在「我的」里显示，平台上的歌单没动过"
        onClose={() => setHiddenOpen(false)}
        width={420}
        footer={<><span className="modal-sp" /><button className="ghost-btn" onClick={() => setHiddenOpen(false)}>关闭</button></>}
      >
        <div className="hidden-pl">
          {platList.filter(i => prefs.hidden.has(platKey(i.source, i.id))).map(i => (
            <div className="hidden-pl-row" key={platKey(i.source, i.id)}>
              <span className="hidden-pl-cover">
                {i.cover
                  ? <img src={i.cover} alt="" decoding="async" onError={e => { e.currentTarget.style.display = 'none' }} />
                  : <IconMusicNote width={16} height={16} />}
              </span>
              <span className="hidden-pl-meta">
                <b>{i.name}</b>
                <span>{platformName(i.source)}{i.songCount ? ` · ${i.songCount} 首` : ''}</span>
              </span>
              <button className="ghost-btn" onClick={() => { prefs.unhide(platKey(i.source, i.id)); toast('已放回「我的」') }}>
                恢复
              </button>
            </div>
          ))}
          {/*
           * 平台把它删了 / 这次没拉到，这里就空了。
           * 不给一句解释的话，用户只会看到「已移除 3 个」点进去一片空白，
           * 以为界面出错了。顺手提示可以退出重新拉一次。
           */}
          {!platList.some(i => prefs.hidden.has(platKey(i.source, i.id))) && (
            <p className="hidden-pl-empty">
              这会儿没取到被移除的歌单：可能是平台那边已经删了，或者这次没拉到。
              点右上角「刷新」重新取一次。
            </p>
          )}
        </div>
      </Modal>

      {/*
       * 「为你推荐」的配比面板。
       *
       * 一根条分成 N 块（登录了几家就几块），拖分割线调整每家的首数，
       * **总首数恒定**——「网易云多 2 首」必然意味着「别家少 2 首」。
       * 以前是每家各挑一个档位，用户调完发现总数从 32 掉到 18，
       * 和「这一批 32 首」对不上，也没法表达「比例」。
       */}
      <Modal
        open={recoOpen}
        title="推荐来源"
        hint="拖动分割线，分配每家出几首。总数固定，左多右就少。"
        onClose={() => setRecoOpen(false)}
        width={430}
        footer={<>
          <span className="reco-w-total">这一批 {mix?.songCount ?? 0} 首</span>
          <span className="modal-sp" />
          <button className="ghost-btn" onClick={() => nextMixSeed()}>
            <IconRefresh width={12} height={12} /> 换一批
          </button>
          <button className="primary-btn" onClick={() => setRecoOpen(false)}>完成</button>
        </>}
      >
        <div className="reco-w">
          <RecoWeightSlider
            platforms={recoPlatforms}
            total={recoTotal}
            value={recoW}
            onChange={setWeights}
          />
          <p className="reco-w-hint">
            出得多的平台排在前面，前面几首也会更偏向它。
            某家今天推的歌不够时会少几首，这一批就凑不满 {recoTotal} 首。
            {recoPlatforms.length < PLATFORMS.length && (
              <>
                <br />
                只算已登录的平台（共 {recoPlatforms.length} 家）；
                没登录的那几家不参与，登录后会自动多分一块。
              </>
            )}
          </p>
        </div>
      </Modal>

      <LoginQrDialog
        open={!!qrSource}
        source={qrSource}
        onClose={() => setQrSource(null)}
        /* 登录态是订阅式的：落地之后 accounts 自己会变，歌单列表跟着重拉 */
        onLogged={() => setQrSource(null)}
      />

      <PhoneLoginDialog
        open={!!phoneLogin}
        source={phoneLogin ?? 'tx'}
        onClose={() => setPhoneLogin(null)}
        onLogged={() => setPhoneLogin(null)}
      />
    </div>
  )
}

/**
 * 已登录平台的「我建的歌单」。
 *
 * 登录 / 退出都会让 `accounts` 换成一个新对象 → `key` 变 → 重新拉一次。
 * 拉不到就当这个平台没有歌单：这是「我的」页的默认内容，不该因为平台抽风弹错误。
 *
 * 但**「拉不到」和「没有」要分开**：酷狗的云歌单只认 App 签发的 token，
 * 网页登录一律回 20017。以前两者都变成「这张卡不存在」，用户只看到
 * 「登录了却没有歌单」。`errors` 就是给这种平台留的一句解释。
 */
function usePlatformPlaylists(
  accounts: Partial<Record<PlatformSource, PlatformAccount>>,
  /** 刷新计数：变一次就重拉一次（值本身不参与请求） */
  tick = 0,
): { list: HotPlaylistItem[]; errors: Partial<Record<PlatformSource, string>> } {
  const key = Object.keys(accounts).sort().join(',')
  const [bySrc, setBySrc] = useState<Partial<Record<PlatformSource, HotPlaylistItem[]>>>({})
  const [errors, setErrors] = useState<Partial<Record<PlatformSource, string>>>({})
  useEffect(() => {
    if (!key) { setBySrc({}); setErrors({}); return }
    let dead = false
    const srcs = key.split(',') as PlatformSource[]
    /*
     * 失败先重试一次，再决定要不要报「XX 的歌单取不到」。
     *
     * 安卓上「切后台听歌 → 切回来」时，系统把后台的 Activity 回收了，再进来
     * 是全新的 WebView：这一批请求就是它启动后打出的第一批网络请求，而那时
     * 网卡可能刚从休眠里醒（后台久了 Wi-Fi 会掉、信号要重连）。一次失败就
     * 把四家全标成「取不到」，用户看到的是「打开 App 歌单全没了」，
     * 其实过一秒自己就好了。热词那边（`hotWordsOf`）踩过同一个坑。
     *
     * 只有真失败才挂错误；重试成功后错误跟着清掉（`setErrors(errs)` 是整体替换）。
     */
    const pullOnce = async (s: PlatformSource) => {
      const first = await minePlaylists(s)
      if (!first.error) return first
      await new Promise(r => window.setTimeout(r, 1200))
      if (dead) return first
      return minePlaylists(s)
    }
    void Promise.all(srcs.map(async s => [s, await pullOnce(s)] as const))
      .then(pairs => {
        if (dead) return
        const next: Partial<Record<PlatformSource, HotPlaylistItem[]>> = {}
        const errs: Partial<Record<PlatformSource, string>> = {}
        for (const [s, r] of pairs) {
          next[s] = r.list
          if (r.error) errs[s] = r.error
        }
        setBySrc(next)
        setErrors(errs)
      })
    return () => { dead = true }
  }, [key, tick])
  const list = useMemo(() => Object.values(bySrc).flatMap(x => x ?? []), [bySrc])
  return { list, errors }
}

/**
 * 「今天听什么」—— 各平台推荐混排（`online.dailyMix`）。
 *
 * 只在有平台登录时才有内容：这整块是**账号专属**的推荐，未登录时各家给的
 * 都是公共池，混在一起既不像「为你推荐」也没有意义，所以干脆不出现。
 *
 * 失败不打扰：拿不到就整块消失（`mix = null`），这一页的主内容是歌单和曲库。
 * 但**换一批 / 改权重失败**是另一回事——条已经在那儿了，突然消失更吓人，
 * 所以那种情况保留上一批，只用提示条说一句。
 */
function useDailyMix(
  accounts: Partial<Record<PlatformSource, PlatformAccount>>,
  opts: { seed: number; weights: RecoWeights },
  tick = 0,
): { mix: PlaylistDetail | null; loading: boolean } {
  const key = Object.keys(accounts).sort().join(',')
  const [mix, setMix] = useState<PlaylistDetail | null>(null)
  const [loading, setLoading] = useState(false)
  /*
   * 权重是对象，每次渲染都是新引用；依赖里放签名字符串，
   * 否则改一次权重会把「同一批」重新拉无数遍。
   */
  const wSig = Object.keys(opts.weights).sort()
    .map(k => k + (opts.weights[k as PlatformSource] ?? 0)).join(',')
  useEffect(() => {
    if (!key) { setMix(null); setLoading(false); return }
    let dead = false
    setLoading(true)
    /*
     * 同样先重试一次（理由见 `usePlatformPlaylists`）：这一块在页面挂载时
     * 就发请求，安卓重建页面那一刻的第一次请求最容易赶上网络还没醒，
     * 一失败就弹「今天各平台的推荐都取不到」——用户刚打开 App 就被兜头一句错误。
     */
    const pull = async () => {
      try {
        return await dailyMix({ seed: opts.seed, weights: opts.weights })
      } catch (e) {
        await new Promise(r => window.setTimeout(r, 1200))
        if (dead) throw e
        return dailyMix({ seed: opts.seed, weights: opts.weights })
      }
    }
    pull()
      .then(d => { if (!dead) { setMix(d); setLoading(false) } })
      .catch(e => {
        if (dead) return
        setLoading(false)
        toast(e instanceof Error ? e.message : String(e), { bad: true })
      })
    return () => { dead = true }
    // opts 只通过 seed / wSig 生效，对象本身不参与
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, opts.seed, wSig])
  return { mix, loading }
}

/** 「3 分钟前 / 2 天前」——曲库状态里那个相对时间 */
function relTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

/** 邮箱太长塞不进按钮：只留 @ 前的部分，超过 10 个字省略 */
function shortMail(mail: string): string {
  const name = mail.split('@')[0] ?? mail
  const short = name.length > 10 ? name.slice(0, 10) + '…' : name
  return short || '已登录'
}
