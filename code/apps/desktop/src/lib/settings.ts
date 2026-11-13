/**
 * 设置存储层：Tauri 环境走 tauri-plugin-store（settings.json），
 * 浏览器 mock 走 localStorage；file:// 下 Chromium 禁止访问 localStorage，
 * 因此带内存回退，保证应用不会因存储异常而白屏。
 */
import { bridge } from './bridge'

const isTauri = bridge.isTauri

/** 扫描规则版本：改动过滤规则时 +1，客户端会强制全量重扫一次 */
export const SCAN_VERSION = '2'

let store: Awaited<ReturnType<typeof import('@tauri-apps/plugin-store').load>> | null = null
let storeReady: Promise<void> | null = null

/** localStorage 不可用时的内存回退（file:// 场景） */
const memory = new Map<string, string>()

const local = {
  get(key: string): string | null {
    if (memory.has(key)) return memory.get(key) ?? null
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    memory.set(key, value)
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* file:// 等受限环境：仅内存生效 */
    }
  },
}

/**
 * 存储初始化：必须容错。
 * plugin-store 若因文件损坏 / 权限 / 版本不匹配而 load 失败，不能把异常抛给调用方——
 * 调用方（App 的首启判定）一旦等到 rejected，界面就会永远空白。
 * 这里降级为 localStorage + 内存，功能可用性优先于持久化。
 */
function ensureStore(): Promise<void> {
  if (!storeReady) {
    storeReady = (async () => {
      if (!isTauri) return
      try {
        const { load } = await import('@tauri-apps/plugin-store')
        store = await load('settings.json', { autoSave: true })
      } catch (e) {
        console.error('[疏音] 设置存储加载失败，已降级为本地缓存', e)
        store = null
        // 让用户看到具体原因（白屏报告时这项信息最关键）
        void import('./diag').then(m => m.diag('settings.load.failed', { error: String(e) })).catch(() => {})
      }
    })()
  }
  return storeReady
}

export const settings = {
  async get<T>(key: string): Promise<T | null> {
    try {
      await ensureStore()
      if (isTauri && store) {
        return (await store.get<T>(key)) ?? null
      }
    } catch (e) {
      console.warn('[疏音] 读取设置失败', key, e)
    }
    const raw = local.get('sy.' + key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  },
  async set<T>(key: string, value: T): Promise<void> {
    try {
      await ensureStore()
      if (isTauri && store) {
        await store.set(key, value)
        return
      }
    } catch (e) {
      console.warn('[疏音] 写入设置失败', key, e)
    }
    try {
      local.set('sy.' + key, JSON.stringify(value))
    } catch {
      /* ignore */
    }
  },
}

/* ---------------- 键定义 ---------------- */

export const KEYS = {
  launched: 'app.launched',           // 是否已启动过（首启仪式判定）
  mode: 'theme.mode',                 // light | dark | system
  activeTheme: 'theme.active',        // 主题 id
  customThemes: 'theme.custom',       // ThemeDef[]（自定义主题）
  editingTokens: 'theme.editing',     // 自定义面板的草稿 Token 快照
  reducedMotion: 'a11y.reducedMotion',// 减弱动效
  scanDirs: 'scan.directories',       // 扫描目录列表（自定义）
  scanScope: 'scan.scope',            // fast | full | custom
  scanRoots: 'scan.roots',            // 上次扫描覆盖的根目录
  lastScanAt: 'scan.lastAt',          // 上次扫描时间 ms
  volume: 'player.volume',            // 音量
  lastTrackId: 'player.lastTrackId',  // 上次在听的曲目（启动时恢复高亮）
  lastTrackLabel: 'player.lastTrackLabel', // 上次在听「标题 · 歌手」（启动页展示）
  lastPosition: 'player.lastPosition', // 上次播放到第几秒（启动时接着上次）
  wasPlaying: 'player.wasPlaying',    // 退出时是否在播（配合「自动续播」开关）
  autoResume: 'player.autoResume',    // 启动时自动接着播放
  repeat: 'queue.repeat',             // sequence | one | shuffle
  queueIds: 'queue.ids',              // 队列曲目 id 顺序
  /**
   * 队列曲目的完整快照（LocalTrack[]）。
   *
   * 只存 id 是不够的：在线曲目（`online:平台:id`）根本不在本地曲库里，
   * 重启后拿曲库 map 去还原会把它们全部过滤掉——表现就是「每次打开
   * 播放列表都是空的」（用户 2026-11 反馈）。存一份完整数据，
   * 本地曲目改名/换路径也还能原样显示。
   */
  queueTracks: 'queue.tracks',
  uiPage: 'ui.page',                  // 上次停留的页面
  settingsPane: 'ui.settingsPane',    // 设置页上次停在哪个分类（外观 / 播放 / 界面 …）
  uiQuery: 'ui.query',                // 上次曲库搜索词
  lyricsSolo: 'ui.lyricsSolo',        // 沉浸式歌词（全屏歌词）是否开启
  foliaFx: 'ui.foliaFx',              // Folia 歌词动效（逐字弹出 + 错落排版）
  vinylView: 'ui.vinylView',          // 播放页封面样式：唱片（黑胶）/ 方形封面
  swipeHint: 'ui.swipeHint',          // 手机播放页「左右滑动切换」提示是否已经看过（看一次就不再打扰）
  lyricsLook: 'ui.lyricsLook',        // 沉浸式歌词观感（流光 / 浮名 / 群唱）
  lyricAlign: 'ui.lyricAlign',        // 播放页右栏歌词对齐（left | center | right）
  spectrumStyle: 'spectrum.style',     // 频谱样式（柱状 / 电平表 / 音浪 …）
  spectrumPos: 'spectrum.pos',         // 频谱摆放位置（播放条 / 四边 / 封面环绕）
  /** 手机播放页的频谱位置（封面外圈 / 页面底部 / 页面顶部）——和桌面那套位置语义不同，分开存 */
  spectrumPosMobile: 'spectrum.posMobile',
  spectrumOn: 'spectrum.on',           // 边缘频谱要不要显示（关掉就只剩安静的黑边）
  audioFx: 'audio.fx',                 // 音效预设 id
  audioFxBands: 'audio.fxBands',       // 音效自定义三段增益 + 前置增益
  audioFxName: 'audio.fxName',         // 自定义音效的名字（用户自己取）
  scanVersion: 'scan.version',        // 扫描规则版本（升级时强制重扫一次，清掉旧噪音）
  lyricsOn: 'lyrics.visible',         // 桌面歌词窗口是否打开
  lyricsFont: 'lyrics.fontSize',      // 桌面歌词字号（滚轮 / A± / 设置页调，记住）
  lyricsWidth: 'lyrics.width',        // 桌面歌词窗口宽度（拖边缘 / 设置页调，记住）
  lyricsBg: 'lyrics.background',      // 桌面歌词底板浓度（0~1）
  lyricsLayoutV: 'lyrics.layoutVersion', // 桌面歌词布局版本（升级时重置过大字号）
  lyricsColor: 'lyrics.highlight',    // 桌面歌词逐字高亮配色
  recentImports: 'playlist.recent',   // 最近导入的歌单摘要
  /** 自建 / 导入的本地歌单（LocalPlaylist[]） */
  localPlaylists: 'playlists.local',
  /** 收藏的在线歌单（FavPlaylist[]） */
  favPlaylists: 'playlists.fav',
  /** 平台同步歌单的本地偏好：隐藏了哪些、按什么顺序摆（PlatPrefs） */
  platPrefs: 'playlists.platPrefs',
  /**
   * 「我的」页几个折叠区的开合状态。
   *
   * `homePlatsOpen` 默认 **false**（用户要求「登录那里默认折叠」——登完就
   * 不太关心了，四行白占半屏）；`homeGroupsShut` 存的是被手动收起来的
   * 平台分组 source 列表，**默认空表 = 全部展开**（用户要展开着拖卡片换位置）。
   */
  homePlatsOpen: 'home.platsOpen',
  homeGroupsShut: 'home.groupsShut',
  /**
   * 「为你推荐」各平台的权重 = 每家出几首（`Record<平台, 首数>`）。
   *
   * 存在本地而不是账号里：它调的是这台设备上的口味配比，
   * 和登录哪个账号无关，换号也不该跟着变。
   */
  recoWeights: 'reco.weights',
  /** 收藏的本地歌曲 id（设计稿「收藏」心形 / 媒体库分类） */
  favTracks: 'tracks.fav',
  /** 快捷键：总开关 / 媒体键 / 逐动作组合键 */
  hotkeysOn: 'hotkeys.enabled',
  hotkeysMedia: 'hotkeys.media',
  hotkeysMap: 'hotkeys.map',
  /** 云端同步：环境 ID + 同步范围 + 上次同步时间 */
  cloudEnv: 'cloud.envId',
  /** 云存储桶名（PG 模式的环境不自动建桶，默认 shuyin，可在设置里改） */
  cloudBucket: 'cloud.bucket',
  cloudScopes: 'cloud.scopes',
  cloudLastSync: 'cloud.lastSync',
  cloudProfile: 'cloud.profile',      // 上次登录的账号信息（邮箱/昵称）
  cloudSession: 'cloud.session',      // refresh_token：SDK 不落盘，重启后靠它接回会话
  /** 音源脚本目录（默认 %APPDATA%\cn.shuyin.player\sources） */
  sourcesDir: 'sources.dir',
  /** 被禁用的音源 id 列表 */
  sourcesOff: 'sources.disabled',
  /** 在线音质偏好（128k / 320k / flac …） */
  onlineQuality: 'playback.quality',
  /** 平台账号登录态（cookie + 昵称 + 头像；目前只有网易云） */
  platformAccounts: 'online.accounts',
  /** 搜索历史（最近 N 条，新的在前） */
  searchHistory: 'search.history',
  /** 搜索时勾选的平台 */
  searchPlatforms: 'search.platforms',
  /** 各平台热搜词（搜索页空态用；按天缓存，隔天重取） */
  searchHotWords: 'search.hotWords',
  /** 歌单广场上一次选的平台（单选，下次打开还是它） */
  squarePlatform: 'square.platform',
  /** 「我的」歌单的浏览方式：卡片网格 / 列表（用户选了就记住） */
  homeView: 'home.view',
  /** 音乐桌面：窗口是否开着 */
  deskOn: 'desk.visible',
  /** 上次检查更新的时间戳（毫秒），太频繁就不查了 */
  updateLastAt: 'update.lastAt',
  /** 用户点过「以后再说」的那个版本，同一个版本不再弹 */
  updateSkip: 'update.skip',
} as const
