/**
 * 设置页：主题模式 / 内置+自定义主题卡 / 自定义参数面板（实时预览）/
 * 导入导出 JSON / 减弱动效 / 关于。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ACCENT_SWATCHES, BG_PRESETS, BUILTIN_THEMES, MOTION_PRESETS,
  THEME_FILE_EXT, parseThemeFile, serializeTheme, validateTokens, withAlpha,
  type ThemeDef, type ThemeMode, type ThemeTokens,
} from '@shuyin/theme-engine'
import { useTheme } from '../lib/ThemeProvider'
import {
  IconCheck, IconDownload, IconFolder, IconGitee, IconGithub, IconGlobe, IconMusicNote, IconTrash, IconUpload,
} from '../components/icons'
import { bridge } from '../lib/bridge'
import { useShell, isIOS } from '../lib/shellMode'
import { SPECTRUM_STYLES, useSpectrumStyle, type SpectrumStyle } from '../lib/spectrumStyle'
import {
  MOBILE_SPEC_POSITIONS, SPECTRUM_POSITIONS, useSpectrumPos, useMobileSpecPos, type SpectrumPos,
} from '../lib/spectrumPos'
import {
  FX_BAND_LABELS, FX_PRESETS, FX_RANGE, FX_SPACES, balanceSummary, enterCustom, resetFx, zeroFx,
  setFxBalance, setFxBand, setFxPre, setFxPreset, setFxSpace, spaceName, useAudioFx,
} from '../lib/audioFx'
import { Modal } from '../components/Modal'
import { LYRIC_COLORS, lyricColorValue, useLyricColor } from '../lib/lyricsColor'
import {
  LYRIC_BG_MAX, LYRIC_BG_MIN, LYRIC_FONT_MAX, LYRIC_FONT_MIN, LYRIC_W_MAX, LYRIC_W_MIN, useLyricsLayout,
} from '../lib/lyricsLayout'
import { desktopLyrics } from '../lib/desktopLyrics'
import { musicDesk } from '../lib/musicDesk'
import { useFoliaFx, useLyricsSolo, useVinylView } from '../lib/uiPrefs'
import { KEYS, settings } from '../lib/settings'
import { fetchUpdate, openDownload, openLink, type UpdateInfo } from '../lib/update'
import { QualitySection, SourcesDirSection, SourcesSection } from '../components/SourcesSection'

import { HotkeySection } from '../components/HotkeySection'
import { AccountSection } from '../components/AccountSection'
import { StatusLyricSection } from '../components/StatusLyricSection'
import { FloatLyricSection } from '../components/FloatLyricSection'
import { DynamicIslandSection } from '../components/DynamicIslandSection'
import { HelpTip } from '../components/HelpTip'
import { useDownloads } from '../lib/DownloadsProvider'
import { audioCacheSize, clearAudioCache } from '../lib/audioCache'
import { usePlayer } from '../lib/PlayerProvider'
import { toast } from '../lib/toast'
import { SleepSheet } from '../components/SleepSheet'

/**
 * 设置分类。
 *
 * 以前这里是 13 个分组一路平铺：主题 → 音源 → 主题卡 → 锁屏 → 频谱 → 音效 →
 * 音乐桌面 → 桌面歌词 → 下载 → 缓存 → 播放 → 启动 → 快捷键 → 账号 → 无障碍 → 关于。
 * 想找「桌面歌词的字号」得先记住它在下载前面，找「接着上次播放」得先滑过频谱和音效——
 * 用户的原话是「很乱，要找什么菜单也不好找」。
 *
 * 现在按「我要改什么」分七类，类名就是用户嘴里的词（外观 / 播放 / 界面 / 存储…），
 * 一次只显示一类，找东西不用滚也不用记位置。
 */
type SetPane = 'look' | 'play' | 'shell' | 'source' | 'account' | 'storage' | 'about'

const SET_PANES: Array<{ id: SetPane; label: string }> = [
  { id: 'look', label: '外观' },
  { id: 'play', label: '播放' },
  { id: 'shell', label: '界面' },
  { id: 'source', label: '音源' },
  { id: 'account', label: '账号' },
  { id: 'storage', label: '存储' },
  { id: 'about', label: '关于' },
]

/**
 * 项目主页入口（关于 → 仓库地址）。
 *
 * 只放**常量地址**，点一下交给系统浏览器（顺序就是显示顺序，官网放最前）。
 * 两端的打开能力已经统一在
 * `lib/update.ts` 的 `openLink()`：安卓走 `open_url` intent，桌面走 Tauri
 * shell open，浏览器预览退回 `window.open`。
 */
const PROJECT_LINKS: Array<{
  id: string
  name: string
  sub: string
  url: string
  Icon: typeof IconGithub
}> = [
  /*
   * 官网放最前：这是唯一一个「既能看介绍又能下载各平台安装包」的地址，
   * 别人问「去哪下」直接给这条就够了。`id` 用 site，底色走强调色（见 pages.css）。
   */
  { id: 'site', name: '官网', sub: 'shuyin.pages.dev', url: 'https://shuyin.pages.dev/', Icon: IconGlobe },
  { id: 'github', name: 'GitHub', sub: 'github.com/Kaikal/shuyin', url: 'https://github.com/Kaikal/shuyin', Icon: IconGithub },
  /*
   * Gitee 主仓（ghpgitee/shuyin）是**私有**的：浏览器直接打开就是 403「访问受限」，
   * 用户报过这条。这里放**公开**的发布仓 `shuyin-update`（更新清单、安装包镜像都
   * 在里面，匿名可读），不暴露私有源码仓。
   */
  { id: 'gitee', name: 'Gitee', sub: 'gitee.com/ghpgitee/shuyin-update', url: 'https://gitee.com/ghpgitee/shuyin-update', Icon: IconGitee },
]

/**
 * `lock_state` 的返回。
 *
 * 锁屏页是主 Activity 里的一层 View（`setShowWhenLocked`），**不需要任何额外权限**
 * 就能在「用户在应用里熄屏」时出现。只有「在桌面/别的应用里熄屏」那一半，
 * 要系统允许我们把窗口从后台拉回来 —— 那是系统开关，读不到，只能试过一次才知道
 * （`bgBlocked`）。
 */
interface LockState {
  /** **有效**开关：缺权限时原生一律报 false（界面不能显示一个假的「已开」） */
  on: boolean
  /** 用户上次自己选的（不管权限），只在诊断时用 */
  prefOn?: boolean
  /** 小米：MIUI 自己的「显示在锁屏上」（10020） */
  miui?: boolean
  allowed?: 'allow' | 'deny' | 'unknown'
  /** 原生能给 intent 打上 MIUI 的系统级标志（绕开 10020/10021） */
  bypass?: boolean
  /** 上一次熄屏拉起被系统拦住了（事后回看窗口有没有到前台） */
  bgBlocked?: boolean
  /** 悬浮窗（SAW）：跨应用熄屏拉起的前置条件，没给时开关锁死 */
  saw?: boolean
  /** 这次 toggle 因为缺悬浮窗权限被原生按下了（原生已带 Toast + 跳授权页） */
  needPermission?: boolean
  /** 缺哪一项权限：目前只有 `overlay`（显示在其他应用上层）能读到 */
  need?: 'overlay' | ''
}

export interface SettingsPageProps {
  /** 音乐桌面开着吗（App 持有，播放页那颗按钮要跟它一致） */
  deskOn: boolean
  /** 开关音乐桌面。**必须走 App**：App 才知道要把当前曲目推给桌面窗，
   *  自己直接调 musicDesk.open() 的话，桌面屏上歌名/封面/歌词全是空的。 */
  onToggleDesk: () => void
}

export function SettingsPage({ deskOn, onToggleDesk }: SettingsPageProps) {
  const th = useTheme()
  const dl = useDownloads()
  /* 定时关闭 / 音量保护的真值都在原生（安卓），这里只读显示 + 发命令 */
  const p = usePlayer()
  /*
   * 车机上没有对应物的设置整块收掉（用户：「车机版不用的设置选项也可以去掉」）：
   * 锁屏播放页（车机不存在「解锁回到原应用」的场景）、下载（导轨里没有下载页，
   * 车里插 USB 听本地，主动下载不成立）。频谱 / 音效 / 缓存 / 睡眠定时这些
   * 车机上照常有用，保留。
   */
  const shellMode = useShell()
  const isCar = shellMode === 'car'
  const [sleepOpen, setSleepOpen] = useState(false)

  /**
   * 当前分类。
   *
   * 记住上次停在哪个分类：改完音效下次进来还在音效，不用每次从「外观」重新找。
   * 存储只存 id，认不出来的（比如降级包里的旧值）回落到外观。
   */
  const [pane, setPaneState] = useState<SetPane>('look')
  /**
   * 这台设备上真的有东西的分类。
   *
   * 「界面」只在原生里有内容：安卓是锁屏播放页，桌面是音乐桌面 / 桌面歌词 / 快捷键。
   * 浏览器预览时两样都没有，把这个分类留着就是个「点进去全白」的死胡同。
   */
  const panes = useMemo(
    () => SET_PANES.filter(x => x.id !== 'shell' || bridge.isAndroid || bridge.isTauri),
    [],
  )
  useEffect(() => {
    void settings.get<string>(KEYS.settingsPane).then(v => {
      if (v && panes.some(x => x.id === v)) setPaneState(v as SetPane)
    }).catch(() => {})
  }, [panes])
  const setPane = (id: SetPane) => {
    setPaneState(id)
    void settings.set(KEYS.settingsPane, id).catch(() => {})
  }

  /**
   * 锁屏播放页（安卓）：开关真值在原生（`lock_screen` 那份 prefs），这里只是显示。
   *
   * 顺带问一次「是不是小米 + 小米的锁屏显示放不放行」——MIUI 默认拦第三方应用
   * 压锁屏，不提示的话用户只会看到「解锁之后才冒出来」这个莫名其妙的现象。
   */
  const [lockState, setLockState] = useState<LockState | null>(null)
  const refreshLockState = () => {
    if (!bridge.isAndroid) return
    void bridge.invoke<LockState>('lock_state').then(setLockState).catch(() => { /* 老版本没有这条命令 */ })
  }
  useEffect(() => {
    refreshLockState()
    refreshBattery()
    if (!bridge.isAndroid) return
    /*
     * 从系统「权限管理」页退回来时刷一次。
     *
     * 用户点「去开启」会被甩到小米的权限页，开完开关再回来——不刷的话
     * 这里仍然写着「没打开」，用户会以为没生效、再去开一遍。
     * WebView 里 useFocusEffect 不可靠，`visibilitychange` 是稳的。
     */
    const onVis = () => { if (!document.hidden) { refreshLockState(); refreshBattery() } }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const lockOn = !!lockState?.on
  const toggleLockPage = async () => {
    try {
      const r = await bridge.invoke<LockState>('lock_toggle')
      setLockState(r)
      /*
       * 缺权限时不自动跳系统页（用户 2026-11-23：别帮我开，告诉我缺哪个）。
       * 只在下面常驻一行「缺少权限：…」，他自己去系统设置里点。
       */
      if (r?.needPermission) toast('缺少「显示在其他应用上层」权限，开关保持关闭')
    } catch { /* 命令不存在：保持不变 */ }
  }
  const openLockPerm = async () => {
    try {
      await bridge.invoke('lock_perm_open')
    } catch { /* 打不开就算了，副标题里写了手动路径 */ }
  }
  /** 跳系统「显示在其他应用上层」授权页（锁屏页跨应用拉起的前置条件） */
  const openOverlayPerm = async () => {
    try {
      await bridge.invoke('overlay_perm_open')
    } catch { /* 老包没有这条命令：让用户自己去系统设置 */ }
  }

  /**
   * 电池优化白名单（Doze）。
   *
   * 在线曲目边下边放，系统一进 Doze 就把后台网络掐掉 —— 表现是「播放在线歌单
   * 过一段时间就停，而本地缓存的歌一点事没有」（缓存不需要网）。
   * 这一步是唯一能根治的：进白名单后 Doze 不再限制本应用。
   */
  const [batteryOk, setBatteryOk] = useState<boolean | null>(null)
  const refreshBattery = () => {
    if (!bridge.isAndroid) return
    void bridge
      .invoke<{ ignoring: boolean }>('battery_state')
      .then(r => setBatteryOk(!!r?.ignoring))
      .catch(() => { /* 老包没有这条命令 */ })
  }
  const openBattery = async () => {
    try {
      await bridge.invoke('battery_open')
    } catch { /* 打不开就让用户自己进系统设置 */ }
  }

  /**
   * 音乐桌面：独立全屏窗口，WorkerW 嵌进桌面壁纸层（图标保留、Win+D 收不走）。
   * 设置页这里只做一个开关。
   * 状态和动作都由 App 给——见 props 注释。
   */
  const [deskMsg, setDeskMsg] = useState('')
  const toggleDesk = async () => {
    onToggleDesk()
    if (deskOn) return
    setDeskMsg('已打开。主窗口还在最上面——最小化它，或者双击桌面屏上的任意位置回来')
  }

  /* 检查更新：手动点的那一路。自动检查在 App 里（启动 4 秒后、12 小时一次）。 */
  const [updBusy, setUpdBusy] = useState(false)
  const [updMsg, setUpdMsg] = useState('')
  const [updNew, setUpdNew] = useState<UpdateInfo | null>(null)
  /**
   * 「关于」里显示的版本号。
   *
   * 以前是手写 `v0.5.24 · 第二阶段`，三个问题一起犯了：
   *   · 每次发版要记得改第四处（package.json / tauri.conf.json / Cargo.toml / 这里）；
   *   · 安卓包里跟着前端构建走，永远显示桌面的 0.5.x，而安卓其实是 0.6.x；
   *   · 「第二阶段」是内部迭代名，不该出现在用户界面上。
   * 现在：真机读原生 `app_version`，桌面/浏览器用构建时注入的 package.json 版本。
   */
  const [ver, setVer] = useState(__APP_VERSION__)
  useEffect(() => {
    void bridge.invoke<string>('app_version')
      .then(v => { if (v) setVer(String(v)) })
      .catch(() => { /* 浏览器预览没有这个命令，用注入值 */ })
  }, [])
  const doCheckUpdate = async () => {
    setUpdBusy(true)
    setUpdNew(null)
    const info = await fetchUpdate()
    setUpdBusy(false)
    if (!info) {
      setUpdMsg('检查失败，看看网络或稍后再试')
      return
    }
    if (!info.has_update) {
      setUpdMsg(`已是最新版 v${info.current}`)
      return
    }
    setUpdNew(info)
    setUpdMsg(`发现新版本 v${info.latest}`)
  }

  /** 缓存占用（MB）。进入设置页时读一次，清空后重新读 */
  const [cacheBytes, setCacheBytes] = useState(0)
  useEffect(() => {
    void audioCacheSize().then(setCacheBytes)
  }, [])
  const cacheMb = Math.round((cacheBytes / 1048576) * 10) / 10
  const clearCache = async () => {
    const freed = await clearAudioCache()
    setCacheBytes(b => Math.max(0, b - freed))
    void audioCacheSize().then(setCacheBytes)
  }

  /**
   * 导出诊断日志（最近 3 天）。
   *
   * 日志现在放在应用数据目录（不再是下载目录），手机上用户进不去，
   * 所以由原生复制一份到公共下载目录：iOS 是「文件 → 我的 iPhone → 疏音」，
   * 安卓是 `Download/疏音/日志-<时间戳>`。
   */
  const exportLogs = async () => {
    try {
      const dir = await bridge.invoke<string>('logs_export')
      if (!dir) {
        toast('还没有日志可以导出')
        return
      }
      toast(`日志已导出到：${dir}`, { ok: true })
      /* 桌面顺手打开那个文件夹；手机上开了也没用 */
      if (bridge.isDesktop) void bridge.revealInFolder(dir).catch(() => {})
    } catch (e) {
      toast(e instanceof Error ? e.message : '导出日志失败', { bad: true })
    }
  }

  /**
   * 旧版本缓存误落盘的副本（`Music/疏音/online_*`）。
   *
   * 见 bridge.cacheCopies 的说明：以前缓存被发布成了下载文件，缓存目录一直空着，
   * 用户音乐库里却多出一堆 `online_kw_123456.m4a`。新版本不再产生，
   * 但已经在新版本之前的那些要给他一个能收掉的地方——不自动删，
   * 因为那毕竟是他的「音乐」目录。
   */
  const [orphans, setOrphans] = useState<[number, number]>([0, 0])
  useEffect(() => {
    if (!bridge.isAndroid) return
    void bridge.cacheCopies().then(setOrphans).catch(() => {})
  }, [])
  const purgeOrphans = async () => {
    const [n, bytes] = await bridge.purgeCacheCopies()
    setOrphans([0, 0])
    setCacheMsg(n > 0
      ? `已清理 ${n} 个缓存副本，释放 ${Math.round((bytes / 1048576) * 10) / 10} MB`
      : '没有可清理的缓存副本')
  }

  /**
   * 缓存目录（v0.4.5）：默认在数据目录下（和音源清单同一个家），
   * 也可以让用户自己选——比如数据盘满了，把缓存挪到大容量盘。
   * 切换时 Rust 会把已有缓存一起搬过去，换个目录不会丢掉听过的歌。
   */
  const [cacheDir, setCacheDir] = useState('')
  const [cacheCustom, setCacheCustom] = useState(false)
  const [cacheMsg, setCacheMsg] = useState<string | null>(null)
  useEffect(() => {
    void bridge.cacheDir().then(v => { setCacheDir(v.dir); setCacheCustom(v.custom) }).catch(() => {})
  }, [])
  /** 选缓存目录：系统目录选择器，选完立刻生效并搬迁旧缓存 */
  const pickCacheDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ directory: true, multiple: false, title: '选择缓存目录' })
      if (typeof picked === 'string' && picked) {
        const r = await bridge.cacheSetDir(picked)
        setCacheDir(r.dir); setCacheCustom(r.custom)
        setCacheMsg(r.failed
          ? `已切换到新目录，${r.moved} 个缓存文件搬过去了，${r.failed} 个没搬动（会被重新下载）`
          : `已切换到新目录，${r.moved} 个缓存文件一起搬过来了`)
        void audioCacheSize().then(setCacheBytes)
      }
    } catch (e) {
      setCacheMsg(e instanceof Error ? e.message : String(e))
    }
  }
  const resetCacheDir = async () => {
    try {
      const r = await bridge.cacheSetDir(null)
      setCacheDir(r.dir); setCacheCustom(r.custom)
      setCacheMsg(`已恢复默认目录，${r.moved} 个缓存文件搬回来了`)
      void audioCacheSize().then(setCacheBytes)
    } catch (e) {
      setCacheMsg(e instanceof Error ? e.message : String(e))
    }
  }

  /** 选下载目录：安卓走 SAF、桌面走系统对话框，两边都由原生弹窗，选完立刻生效 */
  const pickDlDir = async () => { await dl.pickDir() }
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [autoResume, setAutoResume] = useState(false)
  const [specStyle, setSpecStyle] = useSpectrumStyle()
  const [specPos, setSpecPos] = useSpectrumPos()
  /* 手机那套位置和桌面不同（播放页内三个位置），所以分开取 */
  const [specPosM, setSpecPosM] = useMobileSpecPos()
  const fx = useAudioFx()
  const [lyricColor, setLyricColor] = useLyricColor()
  const [dlLayout, setDlLayout] = useLyricsLayout()
  const [lyricsSolo, setLyricsSolo] = useLyricsSolo()
  const [foliaFx, setFoliaFx] = useFoliaFx()
  const [vinylView, setVinylView] = useVinylView()
  const fileRef = useRef<HTMLInputElement>(null)

  /* 桌面歌词的尺寸调整收在弹窗里，页面上只留一行当前值 */
  const [dlDlg, setDlDlg] = useState(false)
  /** 均衡器 / 声道 / 前置增益的调音面板：同样收进弹窗，页面上只留一行形状 */
  const [eqDlg, setEqDlg] = useState(false)

  /** 滑块改动：存到共享状态 + 推给已打开的桌面歌词窗口 */
  const patchLyrics = (patch: { width?: number; fontSize?: number; bg?: number }) => {
    const next = { ...dlLayout, ...patch }
    setDlLayout(patch)
    void desktopLyrics.applyLayoutToWindow(next)
  }

  useEffect(() => {
    void settings.get<boolean>(KEYS.autoResume).then(v => setAutoResume(!!v))
  }, [])

  const toggleAutoResume = () => {
    const next = !autoResume
    setAutoResume(next)
    void settings.set(KEYS.autoResume, next)
  }

  const saveDraftAsTheme = (name: string) => {
    if (!th.draftTokens) return
    const def: ThemeDef = {
      id: 'custom-' + Date.now().toString(36),
      name,
      builtin: false,
      tagline: '自定义主题',
      tokens: th.draftTokens,
    }
    th.upsertCustomTheme(def)
    th.selectTheme(def.id)
  }

  const doExport = async () => {
    const theme = th.activeTheme
    const text = serializeTheme(theme)
    if (bridge.isTauri) {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        defaultPath: theme.name + THEME_FILE_EXT,
        filters: [{ name: '疏音主题', extensions: ['json'] }],
      })
      if (!path) return
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      await writeTextFile(path, text)
      setImportMsg('主题已导出到 ' + path)
    } else {
      const blob = new Blob([text], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = theme.name + '.shuyin-theme.json'
      a.click()
      URL.revokeObjectURL(a.href)
      setImportMsg('主题已导出（浏览器下载）')
    }
    window.setTimeout(() => setImportMsg(null), 4000)
  }

  const doImport = async (file: File) => {
    const text = await file.text()
    const r = parseThemeFile(text)
    if (!r.ok) {
      setImportMsg('导入失败：' + r.errors.join('；'))
      return
    }
    const def: ThemeDef = {
      id: 'custom-' + Date.now().toString(36),
      name: r.theme.name,
      builtin: false,
      tagline: '导入的主题',
      tokens: r.theme.tokens,
    }
    th.upsertCustomTheme(def)
    th.selectTheme(def.id)
    setImportMsg('已导入主题「' + def.name + '」')
    window.setTimeout(() => setImportMsg(null), 4000)
  }

  return (
    <div className="page settings-page" data-pane={pane}>
      <h1>设置</h1>

      {/*
       * 分类条：贴顶吸住，滚到哪儿都能换类。
       *
       * 用 role=tablist 而不是导航链接——这里切的是同一页里的面板，不是换页面，
       * 读屏软件念「外观，选项卡，1/7，已选中」比念「链接」准确。
       */}
      <div className="set-tabs" role="tablist" aria-label="设置分类">
        {panes.map(x => (
          <button
            key={x.id} type="button" role="tab"
            aria-selected={pane === x.id}
            className={'set-tab' + (pane === x.id ? ' on' : '')}
            onClick={() => setPane(x.id)}
          >{x.label}</button>
        ))}
      </div>

      <section className="set-group" data-pane="look" data-sec="appearance">
        <h3>主题模式</h3>
        <div className="set-row">
          <span className="set-label">浅色 / 深色 / 跟随系统</span>
          <div className="segmented" role="radiogroup" aria-label="外观模式">
            {([['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']] as Array<[ThemeMode, string]>).map(([id, label]) => (
              <button key={id} role="radio" aria-checked={th.mode === id} onClick={() => th.setMode(id)}>{label}</button>
            ))}
          </div>
        </div>
      </section>

      <SourcesSection />

      <section className="set-group" data-pane="look" data-sec="theme">
        <h3>主题</h3>
        <div className="theme-cards">
          {BUILTIN_THEMES.map(tdef => (
            <ThemeCard
              key={tdef.id} def={tdef} active={th.activeTheme.id === tdef.id}
              onClick={() => th.selectTheme(tdef.id)}
            />
          ))}
          {th.customThemes.map(tdef => (
            <ThemeCard
              key={tdef.id} def={tdef} active={th.activeTheme.id === tdef.id}
              onClick={() => th.selectTheme(tdef.id)}
              onDelete={tdef.builtin ? undefined : () => th.deleteCustomTheme(tdef.id)}
            />
          ))}
        </div>
        <CustomPanel onSave={saveDraftAsTheme} />
        <div className="set-row io-row">
          <button className="ghost-btn" onClick={doExport}><IconDownload width={14} height={14} /> 导出当前主题</button>
          <button className="ghost-btn" onClick={() => fileRef.current?.click()}><IconUpload width={14} height={14} /> 导入主题 JSON</button>
          <input
            ref={fileRef} type="file" accept=".json,application/json" hidden
            onChange={e => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = '' }}
          />
          {importMsg && <span className={'io-msg ' + (importMsg.startsWith('导入失败') ? 'err' : '')}>{importMsg}</span>}
        </div>
      </section>

      {/*
       * 锁屏播放页：从播放页「更多」面板搬过来的。
       *
       * 它是**系统层面**的一个开关（息屏时弹不弹锁屏页），和「收藏 / 下载 / 分享」
       * 那种「对这首歌做什么」的动作不是一类东西，挤在播放页那张卡片里也容易被误开。
       * 顺带修掉旧行为：以前打开它的一瞬间会立刻把锁屏页弹出来「预览」，
       * 用户的意思是「我锁屏了以后再跳」，不是「我点开关你就跳」。
       */}
      {bridge.isAndroid && !isCar && (
        <section className="set-group" data-pane="shell" data-sec="lock">
          <h3>锁屏</h3>
          <div className="set-row">
            <span className="set-label">锁屏播放页</span>
            <button
              className="toggle" role="switch" aria-checked={lockOn}
              onClick={() => void toggleLockPage()}
            >
              <span className="sr-only">锁屏播放页</span>
            </button>
          </div>
          {/*
           * 缺哪一项权限就直说哪一项（用户 2026-11-23：别帮我开，告诉我缺哪个我自己开）。
           * 开关本身已经是关的（原生 `on` 里含权限），这里只负责把名字念出来。
           */}
          {lockState?.saw === false && (
            <div className="set-row">
              <span className="set-label">缺少权限：显示在其他应用上层</span>
              <span className="set-ctl">
                <button className="ghost-btn" onClick={() => void openOverlayPerm()}>去设置</button>
              </span>
            </div>
          )}
          {/* 华为/荣耀把后台启动也掐了：事后由服务回写 bg_blocked。
              电池白名单没给时下面那行「允许后台活动」已经说过了，不重复摆两行 */}
          {lockOn && lockState?.bgBlocked && batteryOk === true && (
            <div className="set-row">
              <span className="set-label">缺少权限：后台弹出界面</span>
            </div>
          )}
          {/* 小米自己那道「显示在锁屏上」（10020）：原生绕不过去时才需要用户动手 */}
          {lockOn && lockState?.miui && !lockState.bypass && lockState.allowed !== 'allow' && (
            <div className="set-row">
              <span className="set-label">缺少权限：显示在锁屏上</span>
              <span className="set-ctl">
                <button className="ghost-btn" onClick={() => void openLockPerm()}>去设置</button>
              </span>
            </div>
          )}
          {batteryOk !== null && (
            <div className="set-row">
              <span className="set-label">允许后台活动</span>
              <span className="set-ctl">
                {batteryOk
                  ? <button className="ghost-btn" disabled>已允许</button>
                  : <button className="ghost-btn" onClick={() => void openBattery()}>去允许</button>}
              </span>
            </div>
          )}
        </section>
      )}

      {/*
       * 灵动岛（2026-11-27）：安卓走 TYPE_APPLICATION_OVERLAY 悬浮窗包挖孔，
       * 形态对齐酷狗：点一下回 App，长按展开播控胶囊。
       * **iPhone 不再出现这一块**（2026-11-28 用户定案）：iOS 岛上就是系统自带的
       * 「正在播放」，系统自己画胶囊、自己展开，没有可调的选项。
       * 车机不做（没有挖孔，也没有「别的应用」）。
       */}
      {bridge.isAndroid && !isCar && <DynamicIslandSection />}

      {/*
       * 状态栏歌词：整块从播放页「更多」搬过来（用户 2026-11-23「开关放在设置页去」）。
       * 和上面的锁屏一样是**系统层面**的常驻开关，不是「对这一首歌做什么」，
       * 放在播放页那张动作卡片里本来就不对路。
       */}
      {bridge.isAndroid && !isCar && <StatusLyricSection />}

      {/*
       * 桌面歌词：手机上（安卓悬浮窗 / iOS 画中画）本来只有播放页底部那颗芯片，
       * 不播歌就找不到入口。用户 2026-11-25 要求设置页也放一颗。
       * 车机不做（没有「别的应用」可浮）。
       */}
      {(bridge.isAndroid || bridge.isIOS) && !isCar && <FloatLyricSection />}

      {/* 音质排在「播放」页最前：它决定听到什么，比频谱样式更靠前 */}
      <QualitySection />

      {/*
       * 频谱：桌面和手机都有，所以**不能**包在 isTauri 里。
       * 以前这一段只在桌面渲染，安卓上根本没有入口——用户只能看到播放页
       * 默认那一圈，改不了样式也换不了位置。
       */}
      <section className="set-group" data-pane="play" data-sec="spectrum">
        <h3>频谱</h3>
        <div className="set-row">
          <span className="set-label">可视化样式</span>
        </div>
        <div className="spec-grid" role="radiogroup" aria-label="频谱样式">
          {SPECTRUM_STYLES.map(st => (
            <button
              key={st.id} type="button" role="radio" aria-checked={specStyle === st.id}
              className={'spec-card' + (specStyle === st.id ? ' active' : '')}
              onClick={() => setSpecStyle(st.id)}
            >
              <SpecPreview id={st.id} />
              <span className="spec-name">{st.name}</span>
              <span className="spec-desc">{st.desc}</span>
            </button>
          ))}
        </div>

        <div className="set-row">
          <span className="set-label">展示位置</span>
        </div>
        {/*
         * 展示位置：**手机和桌面是两套真值**。
         *
         * 桌面挂的是贴边层（`SpectrumPos`，可以贴屏幕四边）；手机是播放页自绘
         * 的那一圈（`MobileSpecPos`）。以前这里只判 `isAndroid`，iOS 落到桌面那套
         * 选项上——iPhone 上选「贴左边」什么都不会发生（2026-11-24 用户要求
         * iPhone 功能与安卓一致）。
         */}
        {bridge.isAndroid || isIOS ? (
          <div className="pos-grid" role="radiogroup" aria-label="频谱展示位置">
            {MOBILE_SPEC_POSITIONS.map(pp => (
              <button
                key={pp.id} type="button" role="radio" aria-checked={specPosM === pp.id}
                className={'pos-card' + (specPosM === pp.id ? ' active' : '')}
                onClick={() => setSpecPosM(pp.id)}
                title={pp.desc}
              >
                <span className="pos-name">{pp.name}</span>
                <span className="pos-desc">{pp.desc}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="pos-grid" role="radiogroup" aria-label="频谱展示位置">
            {SPECTRUM_POSITIONS.map(pp => (
              <button
                key={pp.id} type="button" role="radio" aria-checked={specPos === pp.id}
                className={'pos-card' + (specPos === pp.id ? ' active' : '')}
                onClick={() => setSpecPos(pp.id)}
                title={pp.desc}
              >
                <PosPreview id={pp.id} />
                <span className="pos-name">{pp.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/*
       * 音效：**两端都有**。
       * 桌面在 Rust 音频线程里做，安卓挂在 media3 的 PCM 链上（`FxAudioProcessor`），
       * 用的是同一套 biquad 公式，所以 8 套预设不用分平台调参。
       */}
      <section className="set-group" data-pane="play" data-sec="fx">
        <h3>音效</h3>
        <div className="set-row">
          <span className="set-label">均衡预设</span>
          <span className="set-ctl">
            <button className="link-btn" onClick={resetFx}>恢复原声</button>
          </span>
        </div>
        {/*
         * 预设卡**只读**：点了只是套用，绝不把它改写成一个「改过的预设」。
         * 想动推子必须点最后那张「自定义」——点下去会把当前选中的形状原样接过来，
         * 于是用户拿到的是一个已经摆好的起点，而不是一张白纸。
         */}
        <div className="fx-grid" role="radiogroup" aria-label="音效预设">
          {FX_PRESETS.map(f => (
            <button
              key={f.id} type="button" role="radio" aria-checked={fx.preset === f.id}
              className={'fx-card' + (fx.preset === f.id ? ' active' : '')}
              onClick={() => setFxPreset(f.id)}
              title={f.desc}
            >
              <span className="fx-head">
                <span className="fx-name">{f.name}</span>
                <span className="fx-badge">预设</span>
              </span>
              <span className="fx-desc">{f.desc}</span>
            </button>
          ))}
          <button
            type="button" role="radio" aria-checked={fx.preset === 'custom'}
            className={'fx-card fx-card-custom' + (fx.preset === 'custom' ? ' active' : '')}
            onClick={enterCustom}
            title="把当前选中的预设接过来，再自己拖推子"
          >
            <span className="fx-head">
              <span className="fx-name">自定义</span>
              <span className="fx-badge fx-badge-own">可调</span>
            </span>
            <span className="fx-desc">
              {fx.preset === 'custom' ? '正在用自己调的这一套' : '接着当前预设自己调'}
            </span>
          </button>
        </div>

        {/*
         * 调音面板收进弹窗：页面上只留「预设 + 一行入口」。
         * 五根推子常驻会占掉大半屏，而用户一年也不一定拖两次——
         * 想看形状时点进去，拖完关掉，页面上仍然只占一行。
         */}
        <button type="button" className="eq-entry" onClick={() => setEqDlg(true)}>
          <span className="eq-entry-label">均衡器</span>
          <span className="eq-entry-shape" aria-hidden="true">
            {fx.values.bands.map((v, i) => (
              <i key={i} style={{ height: `${5 + ((v + FX_RANGE) / (FX_RANGE * 2)) * 13}px` }} />
            ))}
          </span>
          <span className="eq-entry-sum">
            {fx.preset === 'custom'
              ? '自定义'
              : (FX_PRESETS.find(x => x.id === fx.preset)?.name ?? '原声')}
            {' · '}
            {balanceSummary(fx.values.balance)}
          </span>
          <span className="eq-entry-chev" aria-hidden="true" />
        </button>

        {/*
         * 空间音效：和均衡器是两条独立的轴（一个静态曲线、一个动态处理），
         * 所以换预设不会把 3D 旋转关掉。
         */}
        <div className="set-row">
          <span className="set-label">空间音效</span>
          {fx.space !== 'off' && <span className="set-ctl num">{spaceName(fx.space)}</span>}
        </div>
        <div className="fx-spaces" role="radiogroup" aria-label="空间音效">
          {FX_SPACES.map(s => (
            <button
              key={s.id} type="button" role="radio" aria-checked={fx.space === s.id}
              className={'space-chip' + (fx.space === s.id ? ' active' : '')}
              onClick={() => setFxSpace(s.id)}
              title={s.desc}
            >
              {s.name}
            </button>
          ))}
        </div>
      </section>

      {/*
       * 音乐桌面 / 桌面歌词：**Windows 桌面独有的能力**（WorkerW 嵌壁纸层、
       * 独立置顶歌词窗），手机上没有对应物。
       *
       * 判据必须是 `isDesktop` 而不是 `isTauri`：iOS 也是 Tauri 壳，以前这两块
       * 跟着漏到 iPhone 上——点「打开」不会有任何反应（2026-11-24 用户反馈
       * 「iPhone 端功能应该和安卓端一样」）。
       */}
      {bridge.isDesktop && (<>
      <section className="set-group" data-pane="shell" data-sec="desk">
        <h3>音乐桌面</h3>
        <div className="set-row">
          <span className="set-label">铺满屏幕的音乐屏</span>
          <span className="set-ctl">
            <button className="ghost-btn" onClick={() => void toggleDesk()}>
              {deskOn ? '收起' : '打开'}
            </button>
          </span>
        </div>
        {deskMsg && <p className="set-sub">{deskMsg}</p>}
        <DeskLockRow />
      </section>

      <section className="set-group" data-pane="shell" data-sec="dl">
        <h3>桌面歌词</h3>
        <div className="set-row">
          <span className="set-label">逐字高亮颜色</span>
        </div>
        <div className="lc-preview" aria-hidden="true">
          <div className="lc-prev-a">
            <span style={{ color: lyricColorValue(lyricColor), fontSize: Math.min(30, Math.max(14, Math.round(dlLayout.fontSize * 0.62))) }}>疏影横斜</span>
            <span className="lc-dim" style={{ fontSize: Math.min(30, Math.max(14, Math.round(dlLayout.fontSize * 0.62))) }}>水清浅</span>
          </div>
          <div className="lc-prev-b" style={{ fontSize: Math.min(16, Math.max(9, Math.round(dlLayout.fontSize * 0.32))) }}>暗香浮动月黄昏</div>
        </div>
        <div className="lc-grid" role="radiogroup" aria-label="桌面歌词高亮颜色">
          {LYRIC_COLORS.map(c => (
            <button
              key={c.id} type="button" role="radio" aria-checked={lyricColor === c.id}
              className={'lc-card' + (lyricColor === c.id ? ' active' : '')}
              onClick={() => setLyricColor(c.id)}
            >
              <span className="lc-top">
                <i style={{ background: c.color }} />
                <span className="lc-name">{c.name}</span>
              </span>
              <span className="lc-desc">{c.desc}</span>
            </button>
          ))}
        </div>
        <div className="set-row">
          <span className="set-label">字号与宽度</span>
        </div>
        <div className="dl-size">
          <div className="dl-size-sum">
            <span className="dl-sum-i">字号 <b className="num">{dlLayout.fontSize}</b></span>
            <span className="dl-sum-i">宽度 <b className="num">{dlLayout.width}</b></span>
            <span className="dl-sum-i">底板 <b className="num">{Math.round(dlLayout.bg * 100)}%</b></span>
            <button className="ghost-btn" onClick={() => setDlDlg(true)}>调整…</button>
          </div>
        </div>
        <div className="set-row">
          <span className="set-label">排版</span>
        </div>
      </section>
      </>)}

      {/* 下载在车机上没有入口（导轨不放下载页），设置项跟着收掉 */}
      {!isCar && (
      <section className="set-group" data-pane="storage" data-sec="download">
        <h3>下载</h3>
        <div className="set-row">
          <span className="set-label">
            保存目录
            <HelpTip
              text={isIOS
                ? 'iOS 只允许 App 写自己的沙箱：歌曲和 .lrc 都放在「文件」App → 我的 iPhone → 疏音 里，\n可以在那儿拷贝、隔空投送或分享出去。系统不提供「换目录」的能力（没有 SAF / 文件对话框持久授权）。'
                : bridge.isAndroid
                  ? '下载的歌曲和 .lrc 歌词默认存到系统公共的「音乐/疏音」文件夹——文件管理器、其他播放器都能看到、能播。\n点「更改…」可以选任意文件夹（会记住这个授权）。'
                  : '下载的歌曲和 .lrc 歌词都放这里，选一个空文件夹也行（会自动建好）。\n已经在队列里的任务仍按原目录写入，新任务才用新目录。'}
            />
          </span>
          <span className="set-ctl">
            {/* iOS 没有「换目录」这条路，放两颗按不动的按钮比不放更糟 */}
            {!isIOS && (
              <>
                <button className="ghost-btn" onClick={() => void pickDlDir()}>更改…</button>
                <button className="ghost-btn" onClick={() => void dl.setDir('')} disabled={!dl.customDir}>恢复默认</button>
              </>
            )}
          </span>
        </div>
        <div className="set-path">
          <IconFolder width={13} height={13} />
          <span className="set-path-text" title={dl.dir}>
            {dl.dir || (isIOS
              ? '（App 的「文件」目录）'
              : bridge.isAndroid ? '（默认：公共「音乐/疏音」）' : '（默认：系统「下载」文件夹）')}
          </span>
          <button className="link-btn" disabled={!dl.dir} onClick={() => void bridge.revealInFolder(dl.dir)}>
            {bridge.isAndroid || isIOS ? '复制路径' : '打开'}
          </button>
        </div>
      </section>
      )}

      <section className="set-group" data-pane="storage" data-sec="cache">
        <h3>播放缓存</h3>
        <div className="set-row">
          <span className="set-label">
            离线缓存
            <HelpTip
              text={'听过的在线歌曲会在后台留一份在本机，下次直接按本地文件播放——点下去就出声，不用再等取地址。\n缓存只放应用自己的缓存目录，不会动你下载的歌。'}
            />
          </span>
          <span className="set-ctl">
            <span className="set-num">{cacheMb} MB</span>
            <button className="ghost-btn" disabled={!cacheMb} onClick={() => void clearCache()}>
              清空缓存
            </button>
          </span>
        </div>
        {/*
         * 缓存目录整块只在桌面出现。
         *
         * 手机上的缓存是应用私有目录：既换不了位置，「复制路径 / 打开」也没有任何
         * 用处（安卓复制出来在文件管理器里也进不去；iOS 压根没有这回事）。
         * 用户 2026-11-24 的说法很直接：「除了下载歌曲目录，其他目录不显示了，
         * 反正也打不开」。所以手机上只留上面那行「多大、清空」。
         *
         * 判据是 `isDesktop`（`isTauri` 在 iOS 上也是 true，那样这块又会冒出来）。
         */}
        {bridge.isDesktop && (
          <>
            <div className="set-row">
              <span className="set-label">缓存目录</span>
              <span className="set-ctl">
                <button className="ghost-btn" onClick={() => void pickCacheDir()}>更改…</button>
                <button className="ghost-btn" onClick={() => void resetCacheDir()} disabled={!cacheCustom}>恢复默认</button>
              </span>
            </div>
            <div className="set-path">
              <IconFolder width={13} height={13} />
              <span className="set-path-text" title={cacheDir}>
                {cacheDir || '（默认：数据目录下的 cache\\audio）'}
              </span>
              <button className="link-btn" disabled={!cacheDir} onClick={() => void bridge.revealInFolder(cacheDir)}>
                打开
              </button>
            </div>
          </>
        )}
        {cacheMsg && <div className="cache-msg">{cacheMsg}</div>}
        {/*
         * 诊断日志：只留最近 3 天，出问题时点一下导出到下载目录。
         * 和「缓存」同属存储类，放在这一块。
         */}
        <div className="set-row">
          <span className="set-label">
            诊断日志
            <span className="set-sub">只保留最近 3 天；出问题时导出发给开发者</span>
          </span>
          <span className="set-ctl">
            <button className="ghost-btn" onClick={() => void exportLogs()}>导出日志</button>
          </span>
        </div>
        {/*
         * 旧版本留下的缓存副本：只在真有的时候出现，避免平时多一行看不懂的东西。
         * 文案说清「不是你的下载」，否则用户不敢点。
         */}
        {bridge.isAndroid && orphans[0] > 0 && (
          <div className="set-row">
            <span className="set-label">
              音乐目录里的缓存副本
              <span className="set-sub">
                {orphans[0]} 个 / {Math.round((orphans[1] / 1048576) * 10) / 10} MB
              </span>
            </span>
            <span className="set-ctl">
              <button className="ghost-btn" onClick={() => void purgeOrphans()}>清理</button>
            </span>
          </div>
        )}
      </section>

      {/* 音源脚本目录：和下载目录、缓存目录是同类东西，一起放「存储」 */}
      <SourcesDirSection />

      {/*
       * 播放页长什么样 → 归「界面」。
       *
       * 原来这三项里有两项塞在「播放」页（和音效、启动挤在一起），可它们改的是
       * 界面而不是播放行为；手机上的「界面」页又只剩「锁屏」一项，空得发慌。
       * 换到这里，「我要改播放页的样子」去界面页就是直觉。
       */}
      <section className="set-group" data-pane="shell" data-sec="view">
        <h3>播放页</h3>
        <div className="set-row">
          <span className="set-label">封面样式</span>
          <div className="segmented" role="radiogroup" aria-label="播放页封面样式">
            {([['vinyl', '黑胶唱片'], ['cover', '方形封面']] as Array<['vinyl' | 'cover', string]>).map(([id, label]) => (
              <button
                key={id} role="radio" aria-checked={(id === 'vinyl') === vinylView}
                onClick={() => setVinylView(id === 'vinyl')}
              >{label}</button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <span className="set-label">歌词动效</span>
          <button
            className="toggle" role="switch" aria-checked={foliaFx}
            onClick={() => {
              const next = !foliaFx
              setFoliaFx(next)
              if (next) setLyricsSolo(true)
            }}
          >
            <span className="sr-only">歌词动效</span>
          </button>
        </div>
        <div className="set-row">
          <span className="set-label">沉浸式歌词</span>
          <button className="toggle" role="switch" aria-checked={lyricsSolo} onClick={() => setLyricsSolo(!lyricsSolo)}>
            <span className="sr-only">沉浸式歌词</span>
          </button>
        </div>
      </section>

      {/*
       * 定时关闭 / 音量保护。
       *
       * 定时关闭：安卓 = Kotlin `SleepTimer`，iOS/桌面 = Rust `sleep` 模块，
       * 两边都是原生对表（熄屏后前端 JS 冻住，`setTimeout` 不走）。
       * 音量保护只有安卓有：它挂在 ExoPlayer 的输出链上，Rust 这条链没有对应实现。
       * 2026-11-28 用户问「苹果端为啥没有定时关闭」——这里放开到 iOS。
       */}
      {(bridge.isAndroid || bridge.isIOS) && (
        <section className="set-group" data-pane="play" data-sec="guard">
          <h3>睡眠与音量</h3>
          <div className="set-row">
            <span className="set-label">
              定时关闭
              <span className="set-sub">
                {p.sleep.track
                  ? '播完当前这首就暂停'
                  : p.sleep.on
                    ? `还有 ${Math.max(1, Math.ceil(p.sleep.remain / 60))} 分钟，到点淡出并暂停`
                    : '到点淡出并暂停，不会退出应用；播放页「更多」里也能设'
                }
              </span>
            </span>
            <span className="set-ctl">
              <button className="ghost-btn" onClick={() => setSleepOpen(true)}>
                {p.sleep.on ? '修改' : '设置'}
              </button>
            </span>
          </div>
          {/* 音量保护只挂在安卓 ExoPlayer 的输出链上，Rust 那条链没有对应实现 */}
          {bridge.isAndroid && (
          <div className="set-row">
          <span className="set-label">音量保护</span>
            <button
              className="toggle" role="switch" aria-checked={p.audioGuard}
              onClick={() => p.setAudioGuard(!p.audioGuard)}
            >
              <span className="sr-only">音量保护</span>
            </button>
          </div>
          )}
        </section>
      )}
      <section className="set-group" data-pane="play" data-sec="boot">
        <h3>启动</h3>
        <div className="set-row">
          <span className="set-label">启动时接着上次播放</span>
          <button className="toggle" role="switch" aria-checked={autoResume} onClick={toggleAutoResume}>
            <span className="sr-only">启动时接着上次播放</span>
          </button>
        </div>
        <div className="set-row">
          <span className="set-label">自动恢复的内容</span>
        </div>
      </section>

      {/* 快捷键是桌面专属：手机没有物理键盘（耳机键走系统媒体会话，那条路在
          设置里没得配）。留着这一整块等于给用户一堆按了不会有反应的快捷键。
          判据用 `isDesktop`——`isTauri` 在 iOS 上也是 true，那块会漏到 iPhone 上
          （用户 2026-11-24 就是看到这个）。 */}
      {bridge.isDesktop && <HotkeySection />}

      <AccountSection />

      <section className="set-group" data-pane="look" data-sec="a11y">
        <h3>无障碍</h3>
        <div className="set-row">
          <span className="set-label">减弱动效<span className="set-sub">所有过渡降为 100ms 淡入淡出</span></span>
          <button className="toggle" role="switch" aria-checked={th.reducedMotion} onClick={() => th.setReducedMotion(!th.reducedMotion)}>
            <span className="sr-only">减弱动效</span>
          </button>
        </div>
      </section>

      <section className="set-group ab-card" data-pane="about" data-sec="about">
        {/*
         * 关于页以前是「一行字 + 一个弹窗」：手机上整页几乎空白，要点开才看到版本。
         * 现在整页摊开——品牌头、项目主页、检查更新。没有弹窗了。
         */}
        <div className="ab-hero">
          <span className="ab-mark" aria-hidden="true"><IconMusicNote width={24} height={24} /></span>
          <span className="ab-main">
            <span className="ab-name">疏音</span>
            <span className="ab-tag">疏影横斜，澄澈之音</span>
          </span>
          <span className="ab-ver num">v{ver}</span>
        </div>

        <div className="ab-sub">项目主页</div>
        <div className="ext-links">
          {PROJECT_LINKS.map(({ id, name, sub, url, Icon }) => (
            <button className="ext-link" key={id} onClick={() => void openLink(url)}>
              <span className={'ext-ico ext-ico-' + id} aria-hidden="true">
                <Icon width={18} height={18} />
              </span>
              <span className="ext-main">
                <span className="ext-name">{name}</span>
                <span className="ext-url">{sub}</span>
              </span>
              <span className="eq-entry-chev" aria-hidden="true" />
            </button>
          ))}
        </div>

        {/* 自动检查是「发现就弹窗」，这里给一个手动入口：不确定有没有新版时点一下 */}
        <div className="set-row">
          <span className="set-label">
            检查更新
            <span className="set-sub">{updMsg || '启动时会自动查一次；有新版在这里也能看到'}</span>
          </span>
          <span className="set-ctl">
            {updNew
              ? (
                <button className="primary-btn" onClick={() => void openDownload(updNew.url)}>
                  前往下载 v{updNew.latest}
                </button>
              )
              : (
                <button className="ghost-btn" onClick={() => void doCheckUpdate()} disabled={updBusy}>
                  {updBusy ? '检查中…' : '检查更新'}
                </button>
              )}
          </span>
        </div>
      </section>

      {/* ---------- 均衡器与声道 ---------- */}
      <Modal
        open={eqDlg}
        title="均衡器与声道"
        hint="拖动即时生效；关掉就记住了，页面只显示形状"
        onClose={() => setEqDlg(false)}
        width={520}
        footer={<>
          <button className="ghost-btn" onClick={zeroFx}>全部归零</button>
          <span className="modal-sp" />
          <button className="primary-btn" onClick={() => setEqDlg(false)}>完成</button>
        </>}
      >
        {/*
         * 五根竖推子 + 顶部一条实时曲线。
         * 频点固定 60 / 230 / 910 / 3.6k / 14k，和两端 DSP 里那几个滤波器一一对应，
         * 所以曲线不是「示意」，画的就是真实的频率响应形状。
         */}
        {/*
         * 五根竖推子 + 顶部一条实时曲线。
         * 频点固定 60 / 230 / 910 / 3.6k / 14k，和两端 DSP 里那几个滤波器一一对应，
         * 所以曲线不是「示意」，画的就是真实的频率响应形状。
         *
         * 当前是预设时推子是锁住的：预设本身不允许被拖成「修改过的预设」，
         * 想调就在这儿一键接手（拿到的就是当前这套形状）。
         */}
        {fx.preset !== 'custom' && (
          <div className="eq-lock">
            <span className="eq-lock-text">
              现在是预设「{FX_PRESETS.find(x => x.id === fx.preset)?.name ?? '原声'}」，推子只读
            </span>
            <button type="button" className="ghost-btn xs" onClick={enterCustom}>
              接着它自己调
            </button>
          </div>
        )}
        <div className="eq-wrap">
          <svg className="eq-curve" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="20" x2="100" y2="20" className="eq-mid-line" />
            <polyline
              points={fx.values.bands
                .map((v, i) => `${(i / (FX_BAND_LABELS.length - 1)) * 100},${20 - (v / FX_RANGE) * 18}`)
                .join(' ')}
              className="eq-line"
            />
          </svg>
          <div className="eq-bands">
            {FX_BAND_LABELS.map((label, i) => (
              <div className="eq-band" key={label}>
                <span className="eq-val num">
                  {fx.values.bands[i] > 0 ? '+' : ''}{fx.values.bands[i].toFixed(1)}
                </span>
                <span className="eq-fader-wrap">
                  <input
                    className="slider eq-fader" type="range"
                    min={-FX_RANGE} max={FX_RANGE} step={0.5}
                    value={fx.values.bands[i]}
                    disabled={fx.preset !== 'custom'}
                    aria-label={`${label} Hz`}
                    onChange={e => setFxBand(i, Number(e.target.value))}
                  />
                </span>
                <span className="eq-hz">{label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="eq-line-row">
          <span className="eq-line-name">声道平衡</span>
          <span className="eq-line-val num">{balanceSummary(fx.values.balance)}</span>
        </div>
        <div className="eq-balance">
          <span className="eq-bal-end">左</span>
          <input
            className="slider" type="range" min={-1} max={1} step={0.05}
            value={fx.values.balance} disabled={fx.preset !== 'custom'}
            aria-label="声道平衡"
            onChange={e => setFxBalance(Number(e.target.value))}
          />
          <span className="eq-bal-end">右</span>
        </div>

        <div className="eq-line-row">
          <span className="eq-line-name">
            前置增益
            <span className="eq-line-sub">整体音量；拉高由软限幅兜住，不会削波</span>
          </span>
          <span className="eq-line-val num">
            {fx.values.pre > 0 ? '+' : ''}{fx.values.pre.toFixed(1)} dB
          </span>
        </div>
        <input
          className="slider eq-pre" type="range" min={-FX_RANGE} max={FX_RANGE} step={0.5}
          value={fx.values.pre} disabled={fx.preset !== 'custom'} aria-label="前置增益"
          onChange={e => setFxPre(Number(e.target.value))}
        />
      </Modal>

      {/* ---------- 桌面歌词尺寸 ---------- */}
      <Modal
        open={dlDlg}
        title="桌面歌词：字号与宽度"
        hint="拖动即时生效；窗宽和字号也会被记住"
        onClose={() => setDlDlg(false)}
        footer={<button className="primary-btn" onClick={() => setDlDlg(false)}>完成</button>}
      >
        <div className="dl-size-row">
          <span className="dl-size-name">字号</span>
          <input
            className="slider" type="range" aria-label="桌面歌词字号"
            min={LYRIC_FONT_MIN} max={LYRIC_FONT_MAX} step={1}
            value={dlLayout.fontSize}
            onChange={e => patchLyrics({ fontSize: Number(e.target.value) })}
          />
          <span className="dl-size-val num">{dlLayout.fontSize}</span>
        </div>
        <div className="dl-size-row">
          <span className="dl-size-name">宽度</span>
          <input
            className="slider" type="range" aria-label="桌面歌词宽度"
            min={LYRIC_W_MIN} max={LYRIC_W_MAX} step={10}
            value={dlLayout.width}
            onChange={e => patchLyrics({ width: Number(e.target.value) })}
          />
          <span className="dl-size-val num">{dlLayout.width}</span>
        </div>
        <div className="dl-size-row">
          <span className="dl-size-name">悬停底板</span>
          <input
            className="slider" type="range" aria-label="悬停时的桌面歌词底板浓度（不悬停时始终全透明）"
            min={Math.round(LYRIC_BG_MIN * 100)} max={Math.round(LYRIC_BG_MAX * 100)} step={1}
            value={Math.round(dlLayout.bg * 100)}
            onChange={e => patchLyrics({ bg: Number(e.target.value) / 100 })}
          />
          <span className="dl-size-val num">{Math.round(dlLayout.bg * 100)}%</span>
        </div>
      </Modal>

      {/* 定时关闭（安卓）：和播放页「更多」里那个是同一个面板、同一个真值 */}
      <SleepSheet open={sleepOpen} onClose={() => setSleepOpen(false)} />
    </div>
  )
}

/** 音乐锁屏：全屏大字时钟 + 当前歌词，用户主动唤起（快捷键 / 这里），Esc 退出 */
function DeskLockRow() {
  return (
    <div className="set-row">
      <span className="set-label">
        音乐锁屏
        <span className="set-sub">Ctrl + Alt + K</span>
      </span>
      <span className="set-ctl">
        <button className="ghost-btn" onClick={() => void musicDesk.enterLock()}>进入</button>
      </span>
    </div>
  )
}

function ThemeCard({ def, active, onClick, onDelete }: {
  def: ThemeDef; active: boolean; onClick(): void; onDelete?(): void
}) {
  const t = def.tokens
  return (
    <div
      className={'theme-card' + (active ? ' active' : '')}
      style={{
        // 卡片预览固定用主题自己的 token，不受当前主题影响
        '--card-bg': t.backgroundBase, '--card-elev': t.backgroundElevated,
        '--card-text': t.textPrimary, '--card-sub': t.textSecondary,
        '--card-accent': t.accent, '--card-line': t.line,
        /*
         * 半透明档在这里算好：CSS 那边原来用 color-mix(accent 30%, transparent)，
         * 而安卓 WebView 104 没有 color-mix（整条声明失效）——
         * 主题卡预览里的强调条、选中环、右上角小圆点会一起消失。
         */
        '--card-accent-a35': withAlpha(t.accent, 0.35),
        '--card-accent-a30': withAlpha(t.accent, 0.3),
        '--card-text-a10': withAlpha(t.textPrimary, 0.1),
      } as React.CSSProperties}
      onClick={onClick}
      role="button" tabIndex={0}
      aria-pressed={active}
      onKeyDown={e => { if (e.key === 'Enter') onClick() }}
    >
      <div className="tc-preview">
        <div className="tc-bar" />
        <div className="tc-dot" />
      </div>
      <div className="tc-name">{def.name}</div>
      <div className="tc-tag">{def.tagline}</div>
      {active && <span className="tc-check"><IconCheck width={12} height={12} /></span>}
      {onDelete && (
        <button className="tc-del" aria-label={'删除主题 ' + def.name} onClick={e => { e.stopPropagation(); onDelete() }}>
          <IconTrash width={13} height={13} />
        </button>
      )}
    </div>
  )
}

function CustomPanel({ onSave }: { onSave(name: string): void }) {
  const th = useTheme()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('我的主题')
  // 草稿：打开面板时从当前主题快照复制
  const [draft, setDraft] = useState<ThemeTokens | null>(null)

  useEffect(() => {
    if (open && !draft) setDraft(th.draftTokens ?? th.activeTheme.tokens)
  }, [open])

  if (!open) {
    return (
      <div className="set-row">
        <button className="ghost-btn" onClick={() => setOpen(true)}> Customize · 自定义主题</button>
      </div>
    )
  }

  const set = (patch: Partial<ThemeTokens>) => {
    const next = { ...(draft ?? th.activeTheme.tokens), ...patch }
    setDraft(next)
    th.setDraftTokens(next) // 实时预览即应用
  }
  const close = () => {
    th.setDraftTokens(null)
    setDraft(null)
    setOpen(false)
  }

  const motion = MOTION_PRESETS.find(m => {
    const base = draft ?? th.activeTheme.tokens
    return Math.abs(base.durationFast - 120 * m.scale) < 1
  })?.id ?? 'standard'

  const d = draft ?? th.activeTheme.tokens
  const bgPreset = BG_PRESETS.find(b => b.backgroundBase.toLowerCase() === d.backgroundBase.toLowerCase())?.id

  return (
    <div className="custom-panel card">
      <div className="set-row">
        <span className="set-label">自定义主题<span className="set-sub">实时预览，保存后生效并持久化</span></span>
        <div className="cp-actions">
          <button className="ghost-btn" onClick={close}>收起</button>
          <button className="primary-btn" onClick={() => { onSave(name); close() }}>保存</button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">主题名称</span>
        <input className="text-input" style={{ width: 180 }} value={name} onChange={e => setName(e.target.value)} aria-label="主题名称" />
      </div>
      <div className="set-row">
        <span className="set-label">强调色</span>
        <div className="swatches">
          {ACCENT_SWATCHES.map(c => (
            <button key={c} className={'swatch' + (d.accent.toLowerCase() === c.toLowerCase() ? ' sel' : '')}
              style={{ background: c }} aria-label={'强调色 ' + c}
              onClick={() => set({ accent: c, accentSoft: withAlpha(c, 0.85) })} />
          ))}
          <input className="text-input hex-input" value={d.accent} aria-label="强调色 HEX"
            onChange={e => {
              const v = e.target.value.trim()
              set({ accent: v, accentSoft: withAlpha(/^#[0-9a-fA-F]{6}$/.test(v) ? v : d.accent, 0.85) })
            }} />
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">背景风格</span>
        <div className="segmented" role="radiogroup" aria-label="背景风格">
          {BG_PRESETS.map(b => (
            <button key={b.id} role="radio" aria-checked={bgPreset === b.id}
              onClick={() => set({
                backgroundBase: b.backgroundBase, backgroundElevated: b.backgroundElevated,
                textPrimary: b.textPrimary, textSecondary: b.textSecondary, textTertiary: b.textTertiary,
                line: b.line,
              })}>{b.label}</button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">玻璃模糊<span className="set-sub num">{d.glassBlur}px</span></span>
        <input className="slider" type="range" min={8} max={24} step={1} value={d.glassBlur}
          aria-label="玻璃模糊强度" onChange={e => set({ glassBlur: Number(e.target.value) })} style={{ width: 200 }} />
      </div>
      <div className="set-row">
        <span className="set-label">玻璃饱和度<span className="set-sub num">{d.glassSaturate.toFixed(1)}</span></span>
        <input className="slider" type="range" min={1} max={2} step={0.1} value={d.glassSaturate}
          aria-label="玻璃饱和度" onChange={e => set({ glassSaturate: Number(e.target.value) })} style={{ width: 200 }} />
      </div>
      <div className="set-row">
        <span className="set-label">容器圆角<span className="set-sub num">{d.radiusContainer}px</span></span>
        <input className="slider" type="range" min={16} max={28} step={1} value={d.radiusContainer}
          aria-label="容器圆角" onChange={e => set({ radiusContainer: Number(e.target.value) })} style={{ width: 200 }} />
      </div>
      <div className="set-row">
        <span className="set-label">动效速度</span>
        <div className="segmented" role="radiogroup" aria-label="动效速度">
          {MOTION_PRESETS.map(m => (
            <button key={m.id} role="radio" aria-checked={motion === m.id}
              onClick={() => set({ durationFast: Math.round(120 * m.scale), durationPanel: Math.round(280 * m.scale) })}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 位置预览：一个窗口轮廓 + 一条高亮的边；封面环绕画中心方块 + 虚线光环 */
function PosPreview({ id }: { id: SpectrumPos }) {
  return (
    <svg className="spv" viewBox="0 0 120 34" aria-hidden="true">
      <rect x="18" y="4" width="84" height="26" rx="4" fill="none" stroke="currentColor" strokeOpacity=".2" />
      {id === 'bottom' && <rect x="23" y="23" width="74" height="4.4" rx="2.2" fill="currentColor" opacity=".85" />}
      {id === 'top' && <rect x="23" y="6.6" width="74" height="4.4" rx="2.2" fill="currentColor" opacity=".85" />}
      {id === 'left' && <rect x="21" y="9" width="4.4" height="16" rx="2.2" fill="currentColor" opacity=".85" />}
      {id === 'right' && <rect x="94.6" y="9" width="4.4" height="16" rx="2.2" fill="currentColor" opacity=".85" />}
      {id === 'cover' && (
        <>
          <rect x="52" y="11" width="16" height="16" rx="3" fill="currentColor" opacity=".32" />
          <circle cx="60" cy="19" r="12.5" fill="none" stroke="currentColor" strokeOpacity=".45" strokeDasharray="2 2.6" />
        </>
      )}
    </svg>
  )
}

/** 样式预览：纯 SVG/CSS 画的缩略图，不启动真正的频谱（设置页不该有动画开销） */
const PREVIEW_COLS = [0.42, 0.7, 0.95, 0.6, 0.38, 0.82, 0.5, 0.34, 0.72, 0.9, 0.55, 0.4, 0.66, 0.48]

function SpecPreview({ id }: { id: SpectrumStyle }) {
  return (
    <svg className="spv" viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true">
      {id === 'bars' && PREVIEW_COLS.map((v, i) => (
        <rect key={i} x={2 + i * 8.6} y={32 - v * 28} width={5} height={v * 28} rx={2} fill="currentColor" opacity={0.55 + v * 0.4} />
      ))}

      {id === 'meter' && PREVIEW_COLS.map((v, i) => {
        const lit = Math.round(v * 5)
        return Array.from({ length: 5 }).map((_, r) => (
          <rect
            key={i + '-' + r} x={2 + i * 8.6} y={31 - r * 5.4} width={5} height={3.4} rx={0.8}
            fill="currentColor" opacity={r < lit ? 0.35 + r * 0.14 : 0.1}
          />
        ))
      })}

      {id === 'wave' && (
        <>
          <path
            d="M0 27 Q7 27 11 16 T22 21 T33 9 T44 15 T55 25 T66 18 T77 8 T88 14 T99 24 T110 17 T120 21 L120 34 L0 34Z"
            fill="currentColor" opacity="0.26"
          />
          <path
            d="M0 27 Q7 27 11 16 T22 21 T33 9 T44 15 T55 25 T66 18 T77 8 T88 14 T99 24 T110 17 T120 21"
            fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.9" strokeLinecap="round"
          />
        </>
      )}

      {id === 'dots' && PREVIEW_COLS.map((v, i) => {
        const rows = Math.max(1, Math.round(v * 5))
        return Array.from({ length: rows }).map((_, r) => (
          <circle
            key={i + '-' + r} cx={4.5 + i * 8.4} cy={31 - r * 5.2} r={1.8}
            fill="currentColor" opacity={0.35 + r * 0.13}
          />
        ))
      })}

      {id === 'ribbon' && (
        <>
          <path d="M0 29 Q12 29 20 22 T40 25 T60 15 T80 20 T100 12 T120 18 L120 34 L0 34Z" fill="currentColor" opacity="0.16" />
          <path d="M0 24 Q12 24 20 26 T40 17 T60 22 T80 12 T100 17 T120 11 L120 34 L0 34Z" fill="currentColor" opacity="0.24" />
          <path d="M0 20 Q12 20 20 24 T40 15 T60 19 T80 10 T100 15 T120 9 L120 34 L0 34Z" fill="currentColor" opacity="0.36" />
        </>
      )}

      {id === 'mirror' && PREVIEW_COLS.map((v, i) => (
        <g key={i} fill="currentColor" opacity={0.55 + v * 0.4}>
          <rect x={2 + i * 8.6} y={17 - v * 13} width={5} height={v * 13} rx={1.6} />
          <rect x={2 + i * 8.6} y={17} width={5} height={v * 9} rx={1.6} opacity={0.55} />
        </g>
      ))}
    </svg>
  )
}

const srOnlyStyle = document.createElement('style')
srOnlyStyle.textContent = '.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}'
document.head.appendChild(srOnlyStyle)
