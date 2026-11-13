/**
 * 主题 Provider：Token 解析 → 降级 → CSS 自定义属性下发。
 * 关键约束：主题切换不得重置播放状态、不得卸载播放条。
 * 播放器状态在 PlayerProvider（更上层），ThemeProvider 只管样式。
 */
import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import {
  BUILTIN_THEMES, degradeTokens, isDarkBase, resolveActiveTheme, withAlpha,
  type DegradationContext, type ThemeDef, type ThemeMode, type ThemeTokens,
} from '@shuyin/theme-engine'
import { KEYS, settings } from './settings'

interface ThemeCtx {
  /** 实际生效的 Token（已降级） */
  tokens: ThemeTokens
  /** 实际生效的主题定义（含 id/name，用于 UI 标识） */
  activeTheme: ThemeDef
  mode: ThemeMode
  setMode(m: ThemeMode): void
  /** 用户选择的主题 id（可能与 mode 不匹配而被回落） */
  selectedThemeId: string
  selectTheme(id: string): void
  customThemes: ThemeDef[]
  upsertCustomTheme(t: ThemeDef): void
  deleteCustomTheme(id: string): void
  /** 自定义面板草稿（实时预览即应用，不做"应用"按钮） */
  draftTokens: ThemeTokens | null
  setDraftTokens(t: ThemeTokens | null): void
  reducedMotion: boolean
  setReducedMotion(v: boolean): void
  /** 玻璃是否已降级（无模糊） */
  glassDegraded: boolean
  systemDark: boolean
}

const Ctx = createContext<ThemeCtx | null>(null)

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useTheme must be used within ThemeProvider')
  return c
}

function detectDegradation(): DegradationContext {
  if (typeof window === 'undefined') return { lowEndDevice: false, reducedTransparency: false, noBackdropSupport: false }
  const supportsBackdrop = typeof CSS !== 'undefined'
    && (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'))
  let reducedTransparency = false
  try {
    reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)').matches
  } catch { /* 老WebView */ }
  const cores = (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency ?? 8
  const lowEndDevice = cores <= 4 || (navigator as Navigator & { deviceMemory?: number }).deviceMemory !== undefined && ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4
  return { lowEndDevice, reducedTransparency, noBackdropSupport: !supportsBackdrop }
}

function applyTokensToCss(t: ThemeTokens): void {
  const root = document.documentElement
  /*
   * 半透明 accent（选中胶囊底、播放键光晕）必须在 JS 里算成 rgba。
   *
   * 这些值本来可以写成 `color-mix(in srgb, var(--sy-accent) 16%, transparent)`，
   * 但 color-mix 要 Chrome 111+；用户那台真机是 WebView 104，遇到它会**不回退**，
   * 直接把整条声明判成计算值无效 → 底色变透明（Tab 选中胶囊整个消失）。
   * rgba 是纯值，哪一代 WebView 都认，桌面也一样。
   */
  const tint = (hex: string, a: number): string => {
    const v = withAlpha(hex, a)
    return v.startsWith('rgba') ? v : `rgba(255,255,255,${a})`
  }
  /*
   * 往白色那边提一档：给「永远近黑」的播放页做前景色。
   *
   * 播放页在浅色主题下也强制近黑底，但强调色仍然取主题的 accent。
   * 浅色主题的 accent（「清浅」#3E9BD8、accentSoft 更是 #2F7FB8）是为白底选的，
   * 直接当文字色压在 #0a0b0f 上对比度只有 2.7:1 —— 选中的标签、当前播放那行
   * 只剩一团看不清的蓝。提亮 45% 之后同一个色相，落在黑底上才立得住。
   */
  const lift = (hex: string, k: number): string => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
    if (!m) return '#E8ECF5'
    const n = parseInt(m[1], 16)
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map(v => Math.round(v + (255 - v) * k))
    return `rgb(${ch[0]},${ch[1]},${ch[2]})`
  }
  const vars: Record<string, string> = {
    '--sy-bg-base': t.backgroundBase,
    '--sy-bg-elevated': t.backgroundElevated,
    '--sy-text-1': t.textPrimary,
    '--sy-text-2': t.textSecondary,
    '--sy-text-3': t.textTertiary,
    '--sy-accent': t.accent,
    '--sy-accent-soft': t.accentSoft,
    /* 触屏一套令牌（styles/handoff.css）里带 alpha 的强调色，见上面 tint() 的注释 */
    '--hd-accent-weak': tint(t.accent, 0.16),
    '--hd-glow': tint(t.accent, 0.36),
    /*
     * Folia 歌词要用的几档强调色透明度。
     *
     * 原来这几处写的是 `color-mix(in srgb, var(--sy-accent) 74%, transparent)`，
     * 而真机 WebView 104 没有 color-mix：整条声明判无效 → 唱到哪个字都不变色、
     * 光晕也没有——「歌词动效好像坏了」很大一部分是这里。算成 rgba 落成变量，
     * 哪一代 WebView 都认，桌面端视觉不变。
     */
    '--sy-accent-a15': tint(t.accent, 0.15),
    '--sy-accent-a20': tint(t.accent, 0.2),
    '--sy-accent-a26': tint(t.accent, 0.26),
    '--sy-accent-a40': tint(t.accent, 0.4),
    '--sy-accent-a42': tint(t.accent, 0.42),
    '--sy-accent-a74': tint(t.accent, 0.74),
    /*
     * 播放页 / 播放队列里几档更细的强调色。
     *
     * 这几处原来在 handoff.css 里写死了默认主题的靛蓝 `rgba(110,139,255,…)`
     * （正在播放那行的底色、已缓冲的进度、拖拽时的描边）。换到「清浅」之后
     * 播放键是青蓝 #3E9BD8、进度条缓冲段却是靛蓝——**一个屏幕上两套蓝**，
     * 就是「播放页和整体主题不搭」最直接的那一半。
     */
    '--sy-accent-a08': tint(t.accent, 0.08),
    '--sy-accent-a32': tint(t.accent, 0.32),
    '--sy-accent-a38': tint(t.accent, 0.38),
    '--sy-accent-a55': tint(t.accent, 0.55),
    /** 近黑底上的强调色文字（播放页 / 播放队列） */
    '--sy-accent-on-dark': lift(t.accent, 0.45),
    '--sy-glass-tint': t.glassTint,
    '--sy-glass-highlight': t.glassHighlight,
    '--sy-glass-border': t.glassBorder,
    '--sy-row-hover': t.rowHover,
    '--sy-zebra': t.zebra,
    '--sy-line': t.line,
    '--sy-radius-container': t.radiusContainer + 'px',
    '--sy-radius-card': t.radiusCard + 'px',
    '--sy-radius-pill': t.radiusPill + 'px',
    '--sy-radius-small': t.radiusSmall + 'px',
    '--sy-glass-blur': t.glassBlur + 'px',
    '--sy-glass-saturate': String(t.glassSaturate),
    '--sy-dur-fast': t.durationFast + 'ms',
    '--sy-dur-panel': t.durationPanel + 'ms',
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.dataset.glassDegraded = String(t.glassBlur === 0)
  /*
   * 明暗标记：设计交付包（styles/handoff.css）里的 --hd-* 是按**深色**画的，
   * 浅色主题下如果照用，就变成「页面是浅的、播放条和 dock 是黑的」——
   * 两套材质拼在一屏上，看起来就是「乱」。挂一个属性让它能整套换令牌。
   * 只在 :root 上多写一个 data-dark，不参与主题引擎的任何判断。
   */
  root.dataset.dark = String(isDarkBase(t.backgroundBase))
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark')
  const [selectedThemeId, setSelectedThemeId] = useState('shuyin')
  const [customThemes, setCustomThemes] = useState<ThemeDef[]>([])
  const [draftTokens, setDraftTokens] = useState<ThemeTokens | null>(null)
  const [reducedMotion, setReducedMotionState] = useState(false)
  const [systemDark, setSystemDark] = useState(true)
  const degradeRef = useRef<DegradationContext>({ lowEndDevice: false, reducedTransparency: false, noBackdropSupport: false })
  const [loaded, setLoaded] = useState(false)

  /* 初始化：读取持久化配置 */
  useEffect(() => {
    (async () => {
      const [m, at, ct, rm, sd] = await Promise.all([
        settings.get<ThemeMode>(KEYS.mode),
        settings.get<string>(KEYS.activeTheme),
        settings.get<ThemeDef[]>(KEYS.customThemes),
        settings.get<boolean>(KEYS.reducedMotion),
        settings.get<string[]>(KEYS.scanDirs),
      ])
      if (m) setModeState(m)
      if (at) setSelectedThemeId(at)
      if (ct) setCustomThemes(ct)
      if (rm) setReducedMotionState(rm)
      void sd
      degradeRef.current = detectDegradation()
      setLoaded(true)
    })()
  }, [])

  /* 系统深浅色监听 */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mq.matches)
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  /* 实际生效主题：draft（自定义面板实时预览）> 持久化选择 */
  const activeTheme = useMemo(
    () => resolveActiveTheme(selectedThemeId, customThemes, mode, systemDark),
    [selectedThemeId, customThemes, mode, systemDark]
  )

  const tokens = useMemo(
    () => degradeTokens(draftTokens ?? activeTheme.tokens, degradeRef.current),
    [draftTokens, activeTheme, loaded]
  )

  /* Token → CSS 变量（首次渲染前不闪烁：index.html 已有固定底色） */
  useEffect(() => { applyTokensToCss(tokens) }, [tokens])

  /* reduced-motion 全局属性 */
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(reducedMotion)
  }, [reducedMotion])

  /* 主题切换动画标记：切换时给 html 加 theme-anim 类 200ms */
  const firstApply = useRef(true)
  useEffect(() => {
    if (firstApply.current) { firstApply.current = false; return }
    const root = document.documentElement
    root.classList.add('theme-anim')
    const t = setTimeout(() => root.classList.remove('theme-anim'), 260)
    return () => clearTimeout(t)
  }, [tokens])

  const setMode = (m: ThemeMode) => {
    setModeState(m)
    void settings.set(KEYS.mode, m)
  }
  const selectTheme = (id: string) => {
    setSelectedThemeId(id)
    setDraftTokens(null) // 切主题清除草稿
    void settings.set(KEYS.activeTheme, id)
    // 点选主题卡时同步外观模式到该主题的明暗，避免「点了没反应」
    const t = [...BUILTIN_THEMES, ...customThemes].find(x => x.id === id)
    if (t) {
      const nextMode: ThemeMode = isDarkBase(t.tokens.backgroundBase) ? 'dark' : 'light'
      if (nextMode !== mode) {
        setModeState(nextMode)
        void settings.set(KEYS.mode, nextMode)
      }
    }
  }
  const upsertCustomTheme = (t: ThemeDef) => {
    setCustomThemes(prev => {
      const next = prev.some(x => x.id === t.id) ? prev.map(x => x.id === t.id ? t : x) : [...prev, t]
      void settings.set(KEYS.customThemes, next)
      return next
    })
  }
  const deleteCustomTheme = (id: string) => {
    setCustomThemes(prev => {
      const next = prev.filter(x => x.id !== id)
      void settings.set(KEYS.customThemes, next)
      return next
    })
  }
  const setReducedMotion = (v: boolean) => {
    setReducedMotionState(v)
    void settings.set(KEYS.reducedMotion, v)
  }

  const value: ThemeCtx = {
    tokens, activeTheme, mode, setMode,
    selectedThemeId, selectTheme,
    customThemes, upsertCustomTheme, deleteCustomTheme,
    draftTokens, setDraftTokens,
    reducedMotion, setReducedMotion,
    glassDegraded: tokens.glassBlur === 0,
    systemDark,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export { BUILTIN_THEMES }
