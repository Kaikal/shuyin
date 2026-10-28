/**
 * 设置页：主题模式 / 内置+自定义主题卡 / 自定义参数面板（实时预览）/
 * 导入导出 JSON / 减弱动效 / 关于。
 */
import { useEffect, useRef, useState } from 'react'
import {
  ACCENT_SWATCHES, BG_PRESETS, BUILTIN_THEMES, MOTION_PRESETS,
  THEME_FILE_EXT, parseThemeFile, serializeTheme, validateTokens, withAlpha,
  type ThemeDef, type ThemeMode, type ThemeTokens,
} from '@shuyin/theme-engine'
import { useTheme } from '../lib/ThemeProvider'
import { IconCheck, IconDownload, IconFolder, IconTrash, IconUpload } from '../components/icons'
import { bridge } from '../lib/bridge'
import { SPECTRUM_STYLES, useSpectrumStyle, type SpectrumStyle } from '../lib/spectrumStyle'
import { SPECTRUM_POSITIONS, useSpectrumPos, type SpectrumPos } from '../lib/spectrumPos'
import {
  FX_NEUTRAL, FX_PRESETS, fxSummary, setFxCustom, setFxPreset, useAudioFx, type FxValues,
} from '../lib/audioFx'
import { Modal } from '../components/Modal'
import { LYRIC_COLORS, lyricColorValue, useLyricColor } from '../lib/lyricsColor'
import {
  LYRIC_BG_MAX, LYRIC_BG_MIN, LYRIC_FONT_MAX, LYRIC_FONT_MIN, LYRIC_W_MAX, LYRIC_W_MIN, useLyricsLayout,
} from '../lib/lyricsLayout'
import { desktopLyrics } from '../lib/desktopLyrics'
import { musicDesk } from '../lib/musicDesk'
import { useFoliaFx, useLyricsSolo } from '../lib/uiPrefs'
import { KEYS, settings } from '../lib/settings'
import { SourcesSection } from '../components/SourcesSection'

import { HotkeySection } from '../components/HotkeySection'
import { AccountSection } from '../components/AccountSection'
import { HelpTip } from '../components/HelpTip'
import { useDownloads } from '../lib/DownloadsProvider'
import { audioCacheSize, clearAudioCache } from '../lib/audioCache'

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

  /** 选下载目录：系统目录选择器，选完立刻生效（Rust 侧会 ensure 目录存在） */
  const pickDlDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ directory: true, multiple: false, title: '选择下载目录' })
      if (typeof picked === 'string' && picked) await dl.setDir(picked)
    } catch { /* 用户取消 / 预览环境 */ }
  }
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [autoResume, setAutoResume] = useState(false)
  const [specStyle, setSpecStyle] = useSpectrumStyle()
  const [specPos, setSpecPos] = useSpectrumPos()
  const fx = useAudioFx()
  const [lyricColor, setLyricColor] = useLyricColor()
  const [dlLayout, setDlLayout] = useLyricsLayout()
  const [lyricsSolo, setLyricsSolo] = useLyricsSolo()
  const [foliaFx, setFoliaFx] = useFoliaFx()
  const fileRef = useRef<HTMLInputElement>(null)

  /* 音效自定义：滑块收进弹窗，只有点了「自定义」才展开 */
  const [fxDlg, setFxDlg] = useState(false)
  const [fxDraft, setFxDraft] = useState<FxValues>(fx.values)
  const [fxName, setFxName] = useState(fx.customName)
  /* 桌面歌词的尺寸调整同理，页面上只留一行当前值 */
  const [dlDlg, setDlDlg] = useState(false)

  const openFxDlg = () => {
    setFxDraft({ ...fx.values })
    setFxName(fx.preset === 'custom' ? fx.customName : '自定义')
    setFxDlg(true)
  }

  const saveFx = () => {
    setFxCustom(fxName, fxDraft)
    setFxDlg(false)
  }

  const patchDraft = (key: keyof FxValues, v: number) => {
    const lim = key === 'midHz' ? [200, 4000] : [-12, 12]
    setFxDraft(d => ({ ...d, [key]: Math.max(lim[0], Math.min(lim[1], v)) }))
  }

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
    <div className="page settings-page">
      <h1>设置</h1>

      <section className="set-group">
        <h3>外观模式</h3>
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

      <section className="set-group">
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

      /* 频谱 / 音效 / 音乐桌面 / 桌面歌词：都是桌面端独有的能力，手机上没有对应物 */
      {bridge.isTauri && (<>
      <section className="set-group">
        <h3>频谱</h3>
        <div className="set-row">
          <span className="set-label">
            可视化样式
            <span className="set-sub">主界面与播放页都生效；播放页右上角也能随手切</span>
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
            <span className="set-sub">贴着窗口的四条边显示</span>
          </span>
        </div>
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
      </section>

      <section className="set-group">
        <h3>音效</h3>
        <div className="set-row">
          <span className="set-label">
            预设
            <span className="set-sub">三段均衡 · 也可以自己调</span>
          </span>
        </div>
        <div className="fx-grid" role="radiogroup" aria-label="音效预设">
          {FX_PRESETS.map(f => (
            <button
              key={f.id} type="button" role="radio" aria-checked={fx.preset === f.id}
              className={'fx-card' + (fx.preset === f.id ? ' active' : '')}
              onClick={() => setFxPreset(f.id)}
              title={f.desc}
            >
              <span className="fx-name">{f.name}</span>
              <span className="fx-desc">{f.desc}</span>
            </button>
          ))}
          <button
            type="button" role="radio" aria-checked={fx.preset === 'custom'}
            className={'fx-card fx-card-custom' + (fx.preset === 'custom' ? ' active' : '')}
            onClick={openFxDlg}
            title="自己调三段增益，取个名字存下来"
          >
            <span className="fx-name">
              {fx.preset === 'custom' ? fx.customName : '自定义'}
              <span className="fx-pen" aria-hidden="true">调</span>
            </span>
            <span className="fx-desc">
              {fx.preset === 'custom' ? fxSummary(fx.values) : '自己调三段增益'}
            </span>
          </button>
        </div>
        <div className="fx-foot">
          <span className="set-sub">
            {fx.preset === 'custom'
              ? `当前为自定义「${fx.customName}」：${fxSummary(fx.values)}`
              : `当前预设：${FX_PRESETS.find(x => x.id === fx.preset)?.name ?? '原声'}`}
          </span>
          <button className="link-btn" onClick={() => setFxPreset('flat')}>恢复原声</button>
        </div>
      </section>

      <section className="set-group">
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

      <section className="set-group">
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

      <section className="set-group">
        <h3>下载</h3>
        <div className="set-row">
          <span className="set-label">
            保存目录
            <HelpTip
              text={'下载的歌曲和 .lrc 歌词都放这里，选一个空文件夹也行（会自动建好）。\n已经在队列里的任务仍按原目录写入，新任务才用新目录。'}
            />
          </span>
          <span className="set-ctl">
            <button className="ghost-btn" onClick={() => void pickDlDir()}>更改…</button>
            <button className="ghost-btn" onClick={() => void dl.setDir('')} disabled={!dl.customDir}>恢复默认</button>
          </span>
        </div>
        <div className="set-path">
          <IconFolder width={13} height={13} />
          <span className="set-path-text" title={dl.dir}>{dl.dir || '（默认：系统「下载」文件夹）'}</span>
          <button className="link-btn" disabled={!dl.dir} onClick={() => void bridge.revealInFolder(dl.dir)}>打开</button>
        </div>
      </section>

      <section className="set-group">
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
              text={'默认在应用数据目录里（和音源同一个家）。\n想换地方就自己选，比如系统盘满了挪到大容量盘；换目录时听过的歌会一起搬过去，不会重下。'}
            />
          </span>
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
          <button className="link-btn" disabled={!cacheDir} onClick={() => void bridge.revealInFolder(cacheDir)}>打开</button>
        </div>
        {cacheMsg && <div className="cache-msg">{cacheMsg}</div>}
      </section>

      <section className="set-group">
        <h3>播放</h3>
        <div className="set-row">
          <span className="set-label">
            Folia 歌词动效
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
            <span className="sr-only">Folia 歌词动效</span>
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

      <section className="set-group">
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

      <section className="set-group">
        <h3>无障碍</h3>
        <div className="set-row">
          <span className="set-label">减弱动效<span className="set-sub">所有过渡降为 100ms 淡入淡出</span></span>
          <button className="toggle" role="switch" aria-checked={th.reducedMotion} onClick={() => th.setReducedMotion(!th.reducedMotion)}>
            <span className="sr-only">减弱动效</span>
          </button>
        </div>
      </section>

      <section className="set-group">
        <h3>关于疏音</h3>
        <div className="about">
          <span className="about-name">疏音</span>
          <span className="about-tag">疏影横斜，澄澈之音</span>
          <span className="about-ver num">v0.5.9 · 第二阶段</span>
        </div>
      </section>

      {/* ---------- 音效自定义 ---------- */}
      <Modal
        open={fxDlg}
        title="自定义音效"
        hint="调完取个名字存下来，会作为「自定义」跟着显示"
        onClose={() => setFxDlg(false)}
        width={480}
        footer={<>
          <button className="ghost-btn" onClick={() => setFxDraft({ ...FX_NEUTRAL })}>全部归零</button>
          <span className="modal-sp" />
          <button className="ghost-btn" onClick={() => setFxDlg(false)}>取消</button>
          <button className="primary-btn" onClick={saveFx}>保存</button>
        </>}
      >
        <div className="fx-dlg-name">
          <label htmlFor="fx-name">名字</label>
          <input
            id="fx-name"
            className="text-input"
            value={fxName}
            maxLength={12}
            placeholder="例如：我的动铁"
            onChange={e => setFxName(e.target.value)}
          />
        </div>
        {FX_BANDS.map(b => (
          <div className="dl-size-row" key={b.key}>
            <span className="dl-size-name">{b.label}</span>
            <input
              className="slider" type="range" aria-label={b.label}
              min={-12} max={12} step={0.5}
              value={fxDraft[b.key]}
              onChange={e => patchDraft(b.key, Number(e.target.value))}
            />
            <span className="dl-size-val num">
              {fxDraft[b.key] > 0 ? '+' : ''}{fxDraft[b.key].toFixed(1)} dB
            </span>
          </div>
        ))}
        <div className="dl-size-row">
          <span className="dl-size-name">中频中心</span>
          <input
            className="slider" type="range" aria-label="中频中心频率"
            min={200} max={4000} step={50}
            value={fxDraft.midHz}
            onChange={e => patchDraft('midHz', Number(e.target.value))}
          />
          <span className="dl-size-val num">{Math.round(fxDraft.midHz)} Hz</span>
        </div>
        <p className="fx-dlg-tip">{fxSummary(fxDraft)}　保存后立刻生效</p>
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

const FX_BANDS: Array<{ key: keyof FxValues; label: string }> = [
  { key: 'low', label: '低频' },
  { key: 'mid', label: '中频' },
  { key: 'high', label: '高频' },
  { key: 'pre', label: '前置增益' },
]

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
