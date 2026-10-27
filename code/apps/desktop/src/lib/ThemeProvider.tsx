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
  BUILTIN_THEMES, degradeTokens, isDarkBase, resolveActiveTheme,
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
  const vars: Record<string, string> = {
    '--sy-bg-base': t.backgroundBase,
    '--sy-bg-elevated': t.backgroundElevated,
    '--sy-text-1': t.textPrimary,
    '--sy-text-2': t.textSecondary,
    '--sy-text-3': t.textTertiary,
    '--sy-accent': t.accent,
    '--sy-accent-soft': t.accentSoft,
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
