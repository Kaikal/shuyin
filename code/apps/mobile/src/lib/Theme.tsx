import { DefaultTheme, extendTheme } from '@react-navigation/native'

/**
 * 移动端主题注入：ThemeContext + Reanimated。
 * Token 通过 Context 注入，组件经 useTheme() 读取；
 * 主题切换用 withTiming(200) 在 UI 线程驱动（不经过 JS 线程）。
 */
import {
  createContext, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { useColorScheme } from 'react-native'
import { MMKV } from 'react-native-mmkv'
import Reanimated, {
  useAnimatedStyle, useSharedValue, withTiming,
} from 'react-native-reanimated'
import {
  BUILTIN_THEMES, degradeTokens, resolveActiveTheme,
  type DegradationContext, type ThemeDef, type ThemeMode, type ThemeTokens,
} from '@shuyin/theme-engine'

export const storage = new MMKV({ id: 'shuyin-settings' })

interface ThemeCtx {
  tokens: ThemeTokens
  activeTheme: ThemeDef
  mode: ThemeMode
  setMode(m: ThemeMode): void
  selectedThemeId: string
  selectTheme(id: string): void
  customThemes: ThemeDef[]
  upsertCustomTheme(t: ThemeDef): void
  deleteCustomTheme(id: string): void
  reducedMotion: boolean
  setReducedMotion(v: boolean): void
  glassDegraded: boolean
  systemDark: boolean
}

const Ctx = createContext<ThemeCtx | null>(null)

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useTheme within ThemeProvider')
  return c
}

function load<T>(key: string, fallback: T): T {
  const raw = storage.getString(key)
  return raw ? (JSON.parse(raw) as T) : fallback
}

function save(key: string, value: unknown): void {
  storage.set(key, JSON.stringify(value))
}

/** 低端设备检测：内存 ≤ 4GB 或 Android API < 33 → 玻璃降级 */
async function detectDegradation(): Promise<DegradationContext> {
  try {
    const { getMemoryInfo, getApiLevel, isLowRamDevice } = require('react-native-device-info')
    const [mem, api, lowRam] = await Promise.all([
      getMemoryInfo().catch(() => ({ totalMemory: 8 })),
      Promise.resolve(typeof getApiLevel === 'function' ? getApiLevel() : Promise.resolve(33)).catch(() => 33),
      Promise.resolve(isLowRamDevice()).catch(() => false),
    ])
    const lowEnd = lowRam || (mem.totalMemory ?? 8) <= 4 || api < 33
    return { lowEndDevice: lowEnd, reducedTransparency: false, noBackdropSupport: true }
  } catch {
    // device-info 未装时保守降级（RN 无原生 backdrop-filter，玻璃本来就是实体面板）
    return { lowEndDevice: false, reducedTransparency: false, noBackdropSupport: true }
  }
}

const KEYS = {
  mode: 'theme.mode',
  active: 'theme.active',
  custom: 'theme.custom',
  reduced: 'a11y.reducedMotion',
  launched: 'app.launched',
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => load(KEYS.mode, 'dark'))
  const [selectedThemeId, setSelectedThemeId] = useState(() => load(KEYS.active, 'shuyin'))
  const [customThemes, setCustomThemes] = useState<ThemeDef[]>(() => load(KEYS.custom, []))
  const [reducedMotion, setReducedMotionState] = useState(() => load(KEYS.reduced, false))
  const [degradation, setDegradation] = useState<DegradationContext>({
    lowEndDevice: false, reducedTransparency: false, noBackdropSupport: true,
  })
  const systemDark = useColorScheme() === 'dark'

  useEffect(() => { void detectDegradation().then(setDegradation) }, [])

  const activeTheme = useMemo(
    () => resolveActiveTheme(selectedThemeId, customThemes, mode, systemDark),
    [selectedThemeId, customThemes, mode, systemDark]
  )
  const tokens = useMemo(
    () => degradeTokens(activeTheme.tokens, degradation),
    [activeTheme, degradation]
  )

  const value: ThemeCtx = {
    tokens, activeTheme, mode,
    setMode: m => { setModeState(m); save(KEYS.mode, m) },
    selectedThemeId,
    selectTheme: id => { setSelectedThemeId(id); save(KEYS.active, id) },
    customThemes,
    upsertCustomTheme: t => {
      setCustomThemes(prev => {
        const next = prev.some(x => x.id === t.id) ? prev.map(x => (x.id === t.id ? t : x)) : [...prev, t]
        save(KEYS.custom, next)
        return next
      })
    },
    deleteCustomTheme: id => {
      setCustomThemes(prev => {
        const next = prev.filter(x => x.id !== id)
        save(KEYS.custom, next)
        return next
      })
    },
    reducedMotion,
    setReducedMotion: v => { setReducedMotionState(v); save(KEYS.reduced, v) },
    glassDegraded: tokens.glassBlur === 0,
    systemDark,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export { BUILTIN_THEMES }

/* ------------------------------------------------------------------ */
/* 玻璃容器：API 33+ 真实模糊；否则半透明实体面板（降级）                 */
/* ------------------------------------------------------------------ */

export function GlassPanel({ children, style }: { children: ReactNode; style?: object }) {
  const { tokens } = useTheme()
  // RN 侧统一走降级实体面板（react-native-android-liquid-glass 属于二阶段增强）
  return (
    <Reanimated.View
      style={[{
        backgroundColor: tokens.glassTint,
        borderRadius: tokens.radiusContainer,
        borderWidth: 1,
        borderColor: tokens.glassBorder,
      }, style]}
    >
      {children}
    </Reanimated.View>
  )
}

/** 主题过渡动画色：UI 线程驱动的背景色（fade + 轻微背景色过渡） */
export function useThemeTransitionColor(tokens: ThemeTokens): Reanimated.AnimatedStyleProp<{}> {
  const bg = useSharedValue(tokens.backgroundBase)
  useEffect(() => {
    bg.value = withTiming(tokens.backgroundBase, { duration: 200 })
  }, [tokens.backgroundBase])
  return useAnimatedStyle(() => ({ backgroundColor: bg.value }))
}
