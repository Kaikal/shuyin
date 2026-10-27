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
  uiPage: 'ui.page',                  // 上次停留的页面
  uiQuery: 'ui.query',                // 上次曲库搜索词
  lyricsSolo: 'ui.lyricsSolo',        // 沉浸式歌词（全屏歌词）是否开启
  foliaFx: 'ui.foliaFx',              // Folia 歌词动效（逐字弹出 + 错落排版）
  vinylView: 'ui.vinylView',          // 播放页封面样式：唱片（黑胶）/ 方形封面
  lyricsLook: 'ui.lyricsLook',        // 沉浸式歌词观感（流光 / 浮名 / 群唱）
  lyricAlign: 'ui.lyricAlign',        // 播放页右栏歌词对齐（left | center | right）
  spectrumStyle: 'spectrum.style',     // 频谱样式（柱状 / 电平表 / 音浪 …）
  spectrumPos: 'spectrum.pos',         // 频谱摆放位置（播放条 / 四边 / 封面环绕）
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
  /** 快捷键：总开关 / 媒体键 / 逐动作组合键 */
  hotkeysOn: 'hotkeys.enabled',
  hotkeysMedia: 'hotkeys.media',
  hotkeysMap: 'hotkeys.map',
  /** 云端同步：环境 ID + 同步范围 + 上次同步时间 */
  cloudEnv: 'cloud.envId',
  cloudScopes: 'cloud.scopes',
  cloudLastSync: 'cloud.lastSync',
  cloudProfile: 'cloud.profile',      // 上次登录的账号信息（邮箱/昵称）
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
  /** 歌单广场上一次选的平台（单选，下次打开还是它） */
  squarePlatform: 'square.platform',
  /** 音乐桌面：窗口是否开着 */
  deskOn: 'desk.visible',
} as const
