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
import { IconCheck, IconDownload, IconFolder, IconTrash, IconUpload } from '../components/icons'
import { bridge } from '../lib/bridge'
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
import { fetchUpdate, openDownload, type UpdateInfo } from '../lib/update'
import { QualitySection, SourcesDirSection, SourcesSection } from '../components/SourcesSection'

import { HotkeySection } from '../components/HotkeySection'
import { AccountSection } from '../components/AccountSection'
import { HelpTip } from '../components/HelpTip'
import { useDownloads } from '../lib/DownloadsProvider'
import { audioCacheSize, clearAudioCache } from '../lib/audioCache'

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

/** `lock_state` 的返回：开关态 + 是不是小米 + MIUI「锁屏显示」放不放行 + 我们能不能绕过去 */
interface LockState {
  on: boolean
  miui: boolean
  allowed: 'allow' | 'deny' | 'unknown'
  /** 原生侧能给 intent 打上 MIUI 的系统级标志（绕开「锁屏显示」appop）。老版本没这个字段 */
  bypass?: boolean
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
    if (!bridge.isAndroid) return
    /*
     * 从系统「权限管理」页退回来时刷一次。
     *
     * 用户点「去开启」会被甩到小米的权限页，开完开关再回来——不刷的话
     * 这里仍然写着「没打开」，用户会以为没生效、再去开一遍。
     * WebView 里 useFocusEffect 不可靠，`visibilitychange` 是稳的。
     */
    const onVis = () => { if (!document.hidden) refreshLockState() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const lockOn = !!lockState?.on
  const toggleLockPage = async () => {
    try {
      const r = await bridge.invoke<LockState>('lock_toggle')
      setLockState(r)
    } catch { /* 命令不存在：保持不变 */ }
  }
  const openLockPerm = async () => {
    try {
      await bridge.invoke('lock_perm_open')
    } catch { /* 打不开就算了，副标题里写了手动路径 */ }
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
  /** 手机端「关于」弹窗（设计稿把关于收成一行） */
  const [aboutOpen, setAboutOpen] = useState(false)
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
      {bridge.isAndroid && (
        <section className="set-group" data-pane="shell" data-sec="lock">
          <h3>锁屏</h3>
          <div className="set-row">
            <span className="set-label">
              锁屏播放页
              <span className="set-sub">
                锁屏之后按亮屏幕，显示整屏播放页（封面 + 歌词 + 播控）。不会自己点亮屏幕，
                也不会拦住系统息屏；打开这个开关不会立刻跳过去，没在放歌也不会弹
              </span>
            </span>
            <button
              className="toggle" role="switch" aria-checked={lockOn}
              onClick={() => void toggleLockPage()}
            >
              <span className="sr-only">锁屏播放页</span>
            </button>
          </div>
          {/*
           * 只有「我们自己也绕不过去」时才提示用户去开系统权限。
           * 原生侧能给 intent 打上 MIUI 的系统级标志（bypass=true）时，
           * appop 仍然是 deny，但系统在检查开头就放行了 —— 这时候再显示
           * 「去开启」就是让用户白跑一趟设置。
           */}
          {lockOn && lockState?.miui && !lockState.bypass && lockState.allowed !== 'allow' && (
            <div className="set-row">
              <span className="set-label">
                小米要「显示在锁屏上」才压得住锁屏
                <span className="set-sub">
                  {lockState.allowed === 'deny'
                    ? '这是 MIUI 自己的限制：它默认不许第三方应用显示在锁屏上，所以这一页要等你解锁之后才冒出来。点右边「去开启」→ 在「其他权限」里打开「显示在锁屏上」（部分版本叫「锁屏显示」），之后按亮屏幕就会直接看到它'
                    : '如果锁屏时这一页要等解锁才出现，点「去开启」→ 在「其他权限」里打开「显示在锁屏上」；能直接显示就不用管这一行'}
                </span>
              </span>
              <span className="set-ctl">
                <button className="ghost-btn" onClick={() => void openLockPerm()}>去开启</button>
              </span>
            </div>
          )}
        </section>
      )}

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
          <span className="set-label">
            可视化样式
            <span className="set-sub">
              {bridge.isAndroid ? '播放页里那圈 / 那条的形状，播放页「更多」里也能随手改' : '主界面与播放页都生效；播放页右上角也能随手切'}
            </span>
          </span>
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
          <span className="set-label">
            展示位置
            <span className="set-sub">
              {bridge.isAndroid ? '在播放页里摆在哪儿' : '贴着窗口的四条边显示'}
            </span>
          </span>
        </div>
        {bridge.isAndroid ? (
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
          <span className="set-label">
            均衡预设
            <span className="set-sub">点一下套用；想改就点「自定义」</span>
          </span>
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
          <span className="set-label">
            空间音效
            <span className="set-sub">耳机下最明显</span>
          </span>
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

      {/* 音乐桌面 / 桌面歌词：桌面端独有的能力，手机上没有对应物 */}
      {bridge.isTauri && (<>
      <section className="set-group" data-pane="shell" data-sec="desk">
        <h3>音乐桌面</h3>
        <div className="set-row">
          <span className="set-label">
            铺满屏幕的音乐屏
            <span className="set-sub">
              专辑封面 + 大字歌词逐句染色 + 底部频谱，嵌在桌面图标后面当壁纸
              （图标照常在、Win + D 也收不走）
            </span>
          </span>
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
          <span className="set-label">
            逐字高亮颜色
            <span className="set-sub">随播放进度「唱」过去</span>
          </span>
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
          <span className="set-label">
            字号与宽度
            <span className="set-sub">
              字号是基准值：短句会自动放大、长句自动缩到放得下，剩下的宽度摊到字缝里铺满整条。
              也能在桌面歌词上按住右边缘拖动改宽、滚轮调字号（Shift+滚轮改宽）。
              不悬停时背景全透明，锁定后连悬停也不显示底板
            </span>
          </span>
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
          <span className="set-label">
            排版
            <span className="set-sub">
              上排当前句左对齐（KTV 从左往右染色），下排下一句右对齐。
              按住歌词拖动位置，双击回主窗口
            </span>
          </span>
        </div>
      </section>
      </>)}

      <section className="set-group" data-pane="storage" data-sec="download">
        <h3>下载</h3>
        <div className="set-row">
          <span className="set-label">
            保存目录
            <HelpTip
              text={bridge.isAndroid
                ? '下载的歌曲和 .lrc 歌词默认存到系统公共的「音乐/疏音」文件夹——文件管理器、其他播放器都能看到、能播。\n点「更改…」可以选任意文件夹（会记住这个授权）。'
                : '下载的歌曲和 .lrc 歌词都放这里，选一个空文件夹也行（会自动建好）。\n已经在队列里的任务仍按原目录写入，新任务才用新目录。'}
            />
          </span>
          <span className="set-ctl">
            <button className="ghost-btn" onClick={() => void pickDlDir()}>更改…</button>
            <button className="ghost-btn" onClick={() => void dl.setDir('')} disabled={!dl.customDir}>恢复默认</button>
          </span>
        </div>
        <div className="set-path">
          <IconFolder width={13} height={13} />
          <span className="set-path-text" title={dl.dir}>
            {dl.dir || (bridge.isAndroid ? '（默认：公共「音乐/疏音」）' : '（默认：系统「下载」文件夹）')}
          </span>
          <button className="link-btn" disabled={!dl.dir} onClick={() => void bridge.revealInFolder(dl.dir)}>
            {bridge.isAndroid ? '复制路径' : '打开'}
          </button>
        </div>
      </section>

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
        <div className="set-row">
          <span className="set-label">
            缓存目录
            <HelpTip
              text={bridge.isTauri
                ? '默认在应用数据目录里（和音源同一个家）。\n想换地方就自己选，比如系统盘满了挪到大容量盘；换目录时听过的歌会一起搬过去，不会重下。'
                : '缓存在应用的私有目录里，跟着系统「清除数据」一起走。\n手机上不提供换位置：系统不允许普通应用随便往任意文件夹写缓存。'}
            />
          </span>
          {/*
           * 「更改…」只在桌面出现。
           *
           * 它走的是 Tauri 的目录选择器（`@tauri-apps/plugin-dialog`），安卓壳里没有
           * 这套 IPC，点下去 JS 侧直接 `undefined.invoke` 抛错（用户看到的就是
           * "Cannot read properties of undefined (reading 'invoke')"）。安卓的缓存
           * 目录本来也是应用私有目录，"换位置"这件事在手机上不成立。
           */}
          {bridge.isTauri ? (
            <span className="set-ctl">
              <button className="ghost-btn" onClick={() => void pickCacheDir()}>更改…</button>
              <button className="ghost-btn" onClick={() => void resetCacheDir()} disabled={!cacheCustom}>恢复默认</button>
            </span>
          ) : (
            /* 手机上的右槽不能空着：空着像是「本来该有按钮但没渲染出来」 */
            <span className="set-ctl"><span className="set-sub">应用私有目录</span></span>
          )}
        </div>
        <div className="set-path">
          <IconFolder width={13} height={13} />
          <span className="set-path-text" title={cacheDir}>
            {cacheDir || '（默认：数据目录下的 cache\\audio）'}
          </span>
          <button className="link-btn" disabled={!cacheDir} onClick={() => void bridge.revealInFolder(cacheDir)}>
            {bridge.isAndroid ? '复制路径' : '打开'}
          </button>
        </div>
        {cacheMsg && <div className="cache-msg">{cacheMsg}</div>}
        {/*
         * 旧版本留下的缓存副本：只在真有的时候出现，避免平时多一行看不懂的东西。
         * 文案说清「不是你的下载」，否则用户不敢点。
         */}
        {bridge.isAndroid && orphans[0] > 0 && (
          <div className="set-row">
            <span className="set-label">
              音乐目录里的缓存副本
              <span className="set-sub">
                旧版本把 {orphans[0]} 个缓存错误地存成了「下载」，约 {Math.round((orphans[1] / 1048576) * 10) / 10} MB。
                删掉它们不影响你真正下载的歌（那些文件名是「歌手 - 歌名」）
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
          <span className="set-label">
            封面样式
            <span className="set-sub">
              {bridge.isAndroid
                ? '黑胶唱片会慢慢转；开频谱外圈时自动用唱片，把频谱画在黑圈上'
                : '黑胶唱片会慢慢转，方形封面更安静；播放页右上角也能随手切'}
            </span>
          </span>
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
          <span className="set-label">
            歌词动效
            <span className="set-sub">
              歌词逐字弹出、错落排版、唱到哪亮到哪（参考 Folia 的流光主题）。
              开启后播放页右侧歌词栏和全屏歌词都用它；关闭则退回可滚动的普通歌词。播放页按 F 也能切
            </span>
          </span>
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
          <span className="set-label">
            沉浸式歌词
            <span className="set-sub">
              播放页只留歌词：居中、逐字上色、上下淡出。
              进入后按 L 或点右上角按钮可切回「封面 + 歌词」
            </span>
          </span>
          <button className="toggle" role="switch" aria-checked={lyricsSolo} onClick={() => setLyricsSolo(!lyricsSolo)}>
            <span className="sr-only">沉浸式歌词</span>
          </button>
        </div>
      </section>

      <section className="set-group" data-pane="play" data-sec="boot">
        <h3>启动</h3>
        <div className="set-row">
          <span className="set-label">
            启动时接着上次播放
            <span className="set-sub">关闭时只恢复到上次的进度并暂停，不会突然出声</span>
          </span>
          <button className="toggle" role="switch" aria-checked={autoResume} onClick={toggleAutoResume}>
            <span className="sr-only">启动时接着上次播放</span>
          </button>
        </div>
        <div className="set-row">
          <span className="set-label">
            自动恢复的内容
            <span className="set-sub">播放队列、播放进度、循环模式、停留页面、搜索词、窗口位置与大小</span>
          </span>
        </div>
      </section>

      {/* 快捷键是桌面专属：安卓没有物理键盘，耳机键走系统媒体会话（SMTC 那条路在
          桌面才有意义）。留着这一整块等于给用户一个按了不会有反应的设置项。 */}
      {bridge.isTauri && <HotkeySection />}

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

      <section className="set-group" data-pane="about" data-sec="about">
        <h3>关于疏音</h3>
        {/* 手机上一行就够（设计稿 05 的 34 高行），点开才是完整信息 */}
        {bridge.isNative && (
          <button className="hd-about-row" onClick={() => setAboutOpen(true)}>
            <span className="hd-about-name">关于疏音</span>
            <span className="hd-about-ver num">v{ver} · 疏影横斜，澄澈之音 <i aria-hidden="true">›</i></span>
          </button>
        )}
        <div className="about">
          <span className="about-name">疏音</span>
          <span className="about-tag">疏影横斜，澄澈之音</span>
          <span className="about-ver num">v{ver}</span>
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

      <Modal
        open={aboutOpen}
        title="关于疏音"
        onClose={() => setAboutOpen(false)}
        width={420}
        footer={<button className="primary-btn" onClick={() => setAboutOpen(false)}>知道了</button>}
      >
        <div className="hd-about-card">
          <div className="hd-about-logo">疏音</div>
          <div className="hd-about-tag">疏影横斜，澄澈之音</div>
          <div className="hd-about-line"><span>版本</span><b className="num">v{ver}</b></div>
          <div className="hd-about-line"><span>更新</span>
            <span className="hd-about-upd">
              {updMsg || '启动时自动检查一次'}
              {updNew
                ? <button className="link-btn" onClick={() => void openDownload(updNew.url)}>下载 v{updNew.latest}</button>
                : <button className="link-btn" onClick={() => void doCheckUpdate()} disabled={updBusy}>{updBusy ? '检查中…' : '检查更新'}</button>}
            </span>
          </div>
        </div>
      </Modal>

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
    </div>
  )
}

/** 音乐锁屏：全屏大字时钟 + 当前歌词，用户主动唤起（快捷键 / 这里），Esc 退出 */
function DeskLockRow() {
  return (
    <div className="set-row">
      <span className="set-label">
        音乐锁屏
        <span className="set-sub">
          全屏大字时钟 + 当前歌词，像手机锁屏。快捷键 Ctrl + Alt + K、托盘右键菜单，
          或点右边「进入」；Esc / 右上角 × 退出。它和音乐桌面互不影响：
          进锁屏不会打开桌面，退锁屏也不会收起桌面
        </span>
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
