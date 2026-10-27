/**
 * 疏音 · 主题引擎
 * 主题 = 一组语义化 Design Tokens，而非散落的颜色值。
 * 本文件纯 TS，无平台依赖；桌面映射 CSS 自定义属性，移动经 ThemeContext 注入。
 */

export type ThemeMode = 'light' | 'dark' | 'system'

export interface ThemeTokens {
  /* 色彩 */
  backgroundBase: string
  backgroundElevated: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  accent: string
  /** 玻璃上的强调色文字（保证 AA 对比度的提亮版） */
  accentSoft: string
  glassTint: string
  glassHighlight: string
  glassBorder: string
  /** 行悬停底色 rgba */
  rowHover: string
  /** 列表斑马纹 rgba */
  zebra: string
  /** 分隔线 rgba */
  line: string

  /* 形状 */
  radiusContainer: number  // 20–24
  radiusCard: number       // 16
  radiusPill: number       // 999
  radiusSmall: number      // 8–10

  /* 玻璃 */
  glassBlur: number        // 8–24（降级时强制 0）
  glassSaturate: number    // 1–2

  /* 动效 */
  durationFast: number     // 120–160
  durationPanel: number    // 240–280
  springStiffness: number  // 260
  springDamping: number    // 30
}

export type ThemeTokenKey = keyof ThemeTokens

export interface ThemeDef {
  id: string
  name: string
  /** 内置主题不可删除 */
  builtin: boolean
  /** 主题气质一句话（设置页主题卡片副标题） */
  tagline: string
  tokens: ThemeTokens
}

export interface ThemeFile {
  /** 主题文件格式版本 */
  version: 1
  name: string
  tokens: ThemeTokens
}

export const THEME_FILE_EXT = '.shuyin-theme.json'

/* ------------------------------------------------------------------ */
/* 内置主题                                                            */
/* ------------------------------------------------------------------ */

export const BUILTIN_THEMES: ThemeDef[] = [
  {
    id: 'shuyin',
    name: '疏影',
    tagline: '疏朗通透 · 近黑底 + 疏音蓝',
    builtin: true,
    tokens: {
      backgroundBase: '#0A0B0F',
      backgroundElevated: '#14161C',
      textPrimary: '#EAEBF1',
      textSecondary: '#9B9EAE',
      textTertiary: '#5F6272',
      accent: '#6E8BFF',
      accentSoft: '#8FA4FF',
      glassTint: 'rgba(15,18,23,0.72)',
      glassHighlight: 'rgba(255,255,255,0.10)',
      glassBorder: 'rgba(255,255,255,0.18)',
      rowHover: 'rgba(255,255,255,0.055)',
      zebra: 'rgba(255,255,255,0.015)',
      line: 'rgba(255,255,255,0.06)',
      radiusContainer: 20,
      radiusCard: 16,
      radiusPill: 999,
      radiusSmall: 10,
      glassBlur: 20,
      glassSaturate: 1.8,
      durationFast: 120,
      durationPanel: 280,
      springStiffness: 260,
      springDamping: 30,
    },
  },
  {
    id: 'qingqian',
    name: '清浅',
    tagline: '浅色通透 · 白 + 冷灰',
    builtin: true,
    tokens: {
      backgroundBase: '#F6F7F9',
      backgroundElevated: '#FFFFFF',
      textPrimary: '#1A1D26',
      textSecondary: '#5A5E6C',
      textTertiary: '#9A9EAC',
      accent: '#3E9BD8',
      accentSoft: '#2F7FB8',
      glassTint: 'rgba(255,255,255,0.60)',
      glassHighlight: 'rgba(255,255,255,0.75)',
      glassBorder: 'rgba(255,255,255,0.90)',
      rowHover: 'rgba(20,24,36,0.045)',
      zebra: 'rgba(20,24,36,0.015)',
      line: 'rgba(20,24,36,0.08)',
      radiusContainer: 22,
      radiusCard: 16,
      radiusPill: 999,
      radiusSmall: 10,
      glassBlur: 18,
      glassSaturate: 1.6,
      durationFast: 120,
      durationPanel: 280,
      springStiffness: 260,
      springDamping: 30,
    },
  },
  {
    id: 'yuehuanghun',
    name: '月黄昏',
    tagline: '暖灰暗调 · 呼应「暗香浮动」',
    builtin: true,
    tokens: {
      backgroundBase: '#141210',
      backgroundElevated: '#1E1B17',
      textPrimary: '#EFEAE2',
      textSecondary: '#A99F90',
      textTertiary: '#6E6558',
      accent: '#C9A96E',
      accentSoft: '#D9BE8C',
      glassTint: 'rgba(26,22,17,0.72)',
      glassHighlight: 'rgba(255,244,224,0.08)',
      glassBorder: 'rgba(255,240,214,0.16)',
      rowHover: 'rgba(255,240,214,0.05)',
      zebra: 'rgba(255,240,214,0.012)',
      line: 'rgba(255,240,214,0.07)',
      radiusContainer: 20,
      radiusCard: 16,
      radiusPill: 999,
      radiusSmall: 10,
      glassBlur: 20,
      glassSaturate: 1.4,
      durationFast: 130,
      durationPanel: 260,
      springStiffness: 260,
      springDamping: 30,
    },
  },
  {
    id: 'yuanshan',
    name: '远山',
    tagline: '青绿暗调 · 空山新雨',
    builtin: true,
    tokens: {
      backgroundBase: '#0B1110',
      backgroundElevated: '#131C1A',
      textPrimary: '#E7EFEC',
      textSecondary: '#9BAFA8',
      textTertiary: '#5E736C',
      accent: '#4FC3A1',
      accentSoft: '#7FD8BC',
      glassTint: 'rgba(14,22,20,0.72)',
      glassHighlight: 'rgba(255,255,255,0.09)',
      glassBorder: 'rgba(255,255,255,0.16)',
      rowHover: 'rgba(255,255,255,0.05)',
      zebra: 'rgba(255,255,255,0.015)',
      line: 'rgba(255,255,255,0.06)',
      radiusContainer: 20,
      radiusCard: 16,
      radiusPill: 999,
      radiusSmall: 10,
      glassBlur: 20,
      glassSaturate: 1.7,
      durationFast: 120,
      durationPanel: 280,
      springStiffness: 260,
      springDamping: 30,
    },
  },
  {
    id: 'shuanglan',
    name: '霜蓝',
    tagline: '冷灰蓝调 · 霜色清冷',
    builtin: true,
    tokens: {
      backgroundBase: '#0C1016',
      backgroundElevated: '#141A22',
      textPrimary: '#E8ECF2',
      textSecondary: '#98A2B3',
      textTertiary: '#5B6673',
      accent: '#5B8DEF',
      accentSoft: '#8FB2FF',
      glassTint: 'rgba(16,22,30,0.72)',
      glassHighlight: 'rgba(226,236,255,0.09)',
      glassBorder: 'rgba(226,236,255,0.16)',
      rowHover: 'rgba(226,236,255,0.05)',
      zebra: 'rgba(226,236,255,0.015)',
      line: 'rgba(226,236,255,0.07)',
      radiusContainer: 22,
      radiusCard: 16,
      radiusPill: 999,
      radiusSmall: 10,
      glassBlur: 22,
      glassSaturate: 1.6,
      durationFast: 110,
      durationPanel: 270,
      springStiffness: 260,
      springDamping: 30,
    },
  },
  {
    id: 'chabai',
    name: '茶白',
    tagline: '米白纸感 · 一盏清茶',
    builtin: true,
    tokens: {
      backgroundBase: '#F5F2EA',
      backgroundElevated: '#FFFDF8',
      textPrimary: '#241F1A',
      textSecondary: '#5F574C',
      textTertiary: '#9A9084',
      accent: '#9C6B3F',
      accentSoft: '#7E5530',
      glassTint: 'rgba(255,253,248,0.62)',
      glassHighlight: 'rgba(255,255,255,0.75)',
      glassBorder: 'rgba(255,255,255,0.90)',
      rowHover: 'rgba(36,31,26,0.045)',
      zebra: 'rgba(36,31,26,0.02)',
      line: 'rgba(36,31,26,0.10)',
      radiusContainer: 22,
      radiusCard: 16,
      radiusPill: 999,
      radiusSmall: 10,
      glassBlur: 16,
      glassSaturate: 1.4,
      durationFast: 130,
      durationPanel: 280,
      springStiffness: 260,
      springDamping: 30,
    },
  },
]

export function getBuiltinTheme(id: string): ThemeDef | undefined {
  return BUILTIN_THEMES.find(t => t.id === id)
}

/* ------------------------------------------------------------------ */
/* 校验 / 导入导出                                                     */
/* ------------------------------------------------------------------ */

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const RGBA_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

const REQUIRED_TOKENS: Record<string, 'color' | 'number'> = (() => {
  const sample = BUILTIN_THEMES[0].tokens
  const map: Record<string, 'color' | 'number'> = {}
  for (const k of Object.keys(sample) as ThemeTokenKey[]) {
    map[k] = typeof sample[k] === 'number' ? 'number' : 'color'
  }
  return map
})()

/** 数值型 Token 的合法范围（超出即校验失败，不静默 clamp） */
export const NUMBER_RANGES: Partial<Record<ThemeTokenKey, [number, number]>> = {
  radiusContainer: [16, 28],
  radiusCard: [12, 20],
  radiusSmall: [6, 14],
  glassBlur: [8, 24],
  glassSaturate: [1, 2],
  durationFast: [80, 240],
  durationPanel: [180, 400],
  springStiffness: [180, 400],
  springDamping: [20, 40],
}

function isColorLike(v: unknown): boolean {
  return typeof v === 'string' && (HEX_RE.test(v) || RGBA_RE.test(v))
}

/** 校验一份主题 Token 集（导入 JSON 或本地持久化数据均走这里） */
export function validateTokens(input: unknown): ValidationResult {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['主题数据必须是对象'] }
  }
  const obj = input as Record<string, unknown>
  for (const [key, kind] of Object.entries(REQUIRED_TOKENS)) {
    const v = obj[key]
    if (v === undefined || v === null) {
      errors.push(`缺少必填 Token：${key}`)
      continue
    }
    if (kind === 'color' && !isColorLike(v)) {
      errors.push(`${key} 不是合法颜色（HEX 或 rgba）：${String(v)}`)
    }
    if (kind === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n)) {
        errors.push(`${key} 必须是数字：${String(v)}`)
      } else {
        const range = NUMBER_RANGES[key as ThemeTokenKey]
        if (range && (n < range[0] || n > range[1])) {
          errors.push(`${key} 超出范围 ${range[0]}–${range[1]}：${n}`)
        }
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 解析并校验主题文件内容；失败给出明确错误，不静默吞掉 */
export function parseThemeFile(text: string): { ok: true; theme: ThemeFile } | { ok: false; errors: string[] } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['不是合法的 JSON 文件'] }
  }
  if (typeof json !== 'object' || json === null) {
    return { ok: false, errors: ['主题文件必须是 JSON 对象'] }
  }
  const obj = json as Record<string, unknown>
  if (obj.version !== 1) {
    return { ok: false, errors: [`不支持的主题版本：${String(obj.version)}（当前支持 1）`] }
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    return { ok: false, errors: ['缺少主题名称 name'] }
  }
  const v = validateTokens(obj.tokens)
  if (!v.ok) return { ok: false, errors: v.errors }
  return { ok: true, theme: { version: 1, name: obj.name.trim(), tokens: obj.tokens as ThemeTokens } }
}

export function serializeTheme(theme: ThemeDef): string {
  const file: ThemeFile = { version: 1, name: theme.name, tokens: theme.tokens }
  return JSON.stringify(file, null, 2)
}

/* ------------------------------------------------------------------ */
/* 降级：低端设备 / prefers-reduced-transparency                        */
/* ------------------------------------------------------------------ */

export interface DegradationContext {
  /** 低端设备（低内存 / API < 33 / navigator.hardwareConcurrency <= 4） */
  lowEndDevice: boolean
  /** 用户系统开启减弱透明度 */
  reducedTransparency: boolean
  /** WebView 不支持 backdrop-filter */
  noBackdropSupport: boolean
}

/** 玻璃降级发生在主题解析阶段，而非组件渲染阶段（所有玻璃组件行为一致） */
export function degradeTokens(tokens: ThemeTokens, ctx: DegradationContext): ThemeTokens {
  const need = ctx.lowEndDevice || ctx.reducedTransparency || ctx.noBackdropSupport
  if (!need) return tokens
  const dark = isDarkBase(tokens.backgroundBase)
  return {
    ...tokens,
    glassBlur: 0,
    glassTint: dark ? 'rgba(20,22,28,0.78)' : 'rgba(255,255,255,0.86)',
    glassHighlight: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
    glassBorder: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
  }
}

export function isDarkBase(bg: string): boolean {
  const m = HEX_RE.exec(bg)
  let r = 0; let g = 0; let b = 0
  if (m) {
    const hex = m[1]
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16); g = parseInt(hex[1] + hex[1], 16); b = parseInt(hex[2] + hex[2], 16)
    } else {
      r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16)
    }
  } else {
    const rm = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(bg)
    if (rm) { r = +rm[1]; g = +rm[2]; b = +rm[3] }
  }
  // WCAG 相对亮度
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L < 0.35
}

/* ------------------------------------------------------------------ */
/* 模式（浅色 / 深色 / 跟随系统）                                        */
/* ------------------------------------------------------------------ */

/**
 * 模式与主题的关系：模式决定用「深色系主题」还是「浅色系主题」。
 * 内置三主题中「清浅」为浅色，其余为深色；自定义主题按底色明暗归类。
 * 当激活主题与所选模式不匹配时，回落到该模式的默认内置主题。
 */
export const DEFAULT_DARK_THEME = 'shuyin'
export const DEFAULT_LIGHT_THEME = 'qingqian'

export function themeMatchesMode(theme: ThemeDef, mode: ThemeMode, systemDark: boolean): boolean {
  const wantDark = mode === 'dark' || (mode === 'system' && systemDark)
  return isDarkBase(theme.tokens.backgroundBase) === wantDark
}

/** 根据模式解析出实际生效的主题（含自定义主题） */
export function resolveActiveTheme(
  activeId: string,
  customThemes: ThemeDef[],
  mode: ThemeMode,
  systemDark: boolean
): ThemeDef {
  const all = [...BUILTIN_THEMES, ...customThemes]
  const active = all.find(t => t.id === activeId)
  if (active && themeMatchesMode(active, mode, systemDark)) return active
  const wantDark = mode === 'dark' || (mode === 'system' && systemDark)
  return all.find(t => t.id === (wantDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME))
    ?? BUILTIN_THEMES[0]
}

/* ------------------------------------------------------------------ */
/* 启动页共享设计参数（两端各一份实现，共享这里的常量）                    */
/* ------------------------------------------------------------------ */

export const SPLASH_POEM_LINE1 = '疏影横斜水清浅'
export const SPLASH_POEM_LINE2 = '暗香浮动月黄昏'

/** 每字固定垂直偏移（px，负值向上）；顺序与诗句字序一致 */
export const SPLASH_OFFSETS_LINE1 = [0, -10, 6, -14, 4, -6, 10]
export const SPLASH_OFFSETS_LINE2 = [8, -4, 12, -8, 2, -12, 6]

/** 每字轻微旋转（度）：让两行呈现「疏影横斜」的错落感，而非机械对齐 */
export const SPLASH_ROTATIONS_LINE1 = [-2.4, 1.6, -1.2, 2.8, -1.8, 1.2, -2.6]
export const SPLASH_ROTATIONS_LINE2 = [1.8, -2.2, 1.4, -1.6, 2.4, -1.2, 2.0]

/** 两行整体水平错位（px）：第一行略左、第二行略右 */
export const SPLASH_SHIFT_LINE1 = -8
export const SPLASH_SHIFT_LINE2 = 8

export const SPLASH = {
  /** 首次启动总时长 */
  firstDurationMs: 2900,
  /** 后续启动总时长 */
  repeatDurationMs: 2100,
  /** 减弱动效时总时长 */
  reducedDurationMs: 900,
  /** 逐字间隔 */
  charStaggerMs: 58,
  /** 单字淡入时长 */
  charDurationMs: 420,
  /** 单字上浮起始位移 */
  charRiseFrom: 8,
  /** 第二行相对第一行起始的延迟 */
  line2DelayMs: 560 - 200,
  /** 产品名淡入延迟（相对动画起点） */
  nameDelayMs: 1300 - 200,
  nameDurationMs: 360,
  /** 细线展开延迟 */
  lineDelayMs: 1500 - 200,
  lineGrowMs: 240,
  /** 「上次在听」延迟 */
  lastTrackDelayMs: 1750 - 200,
  /** 整体淡出延迟 */
  fadeOutDelayMs: 2000 - 200,
  fadeOutMs: 300,
  /** 跳过时淡出时长 */
  skipFadeMs: 200,
  /** 行距（字号倍数） */
  lineHeightRatio: 2.2,
  /** 字号 = min(屏幕宽 × 0.072, 40)，下限 24（竖排 7 字，字号可以比横排更大） */
  fontScale: 0.072,
  fontMax: 40,
  fontMin: 24,
  /** 产品名字号 = 诗句 × 0.62 */
  nameScale: 0.62,
  charOpacity: 0.72,
  letterSpacingEm: 0.12,
  nameLetterSpacingEm: 0.4,
  /** 固定底色（不读用户主题） */
  background: '#0A0B0F',
  poemTextOnSplash: 'rgba(234,235,241,0.72)',
  /** 诗句与产品名之间距 = 行距 × 1.6 */
  nameGapRatio: 1.6,
  underlineWidth: 24,
  underlineHeight: 1,
  underlineGap: 12,
} as const

/* ------------------------------------------------------------------ */
/* 自定义主题参数面板的预设                                             */
/* ------------------------------------------------------------------ */

export interface BgPreset {
  id: string
  label: string
  backgroundBase: string
  backgroundElevated: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  line: string
}

export const BG_PRESETS: BgPreset[] = [
  {
    id: 'near-black', label: '近黑',
    backgroundBase: '#0A0B0F', backgroundElevated: '#14161C',
    textPrimary: '#EAEBF1', textSecondary: '#9B9EAE', textTertiary: '#5F6272',
    line: 'rgba(255,255,255,0.06)',
  },
  {
    id: 'blue-gray', label: '深蓝灰',
    backgroundBase: '#10141D', backgroundElevated: '#181E2A',
    textPrimary: '#E6E9F2', textSecondary: '#969CAD', textTertiary: '#5B6172',
    line: 'rgba(255,255,255,0.07)',
  },
  {
    id: 'warm-gray', label: '暖灰',
    backgroundBase: '#141210', backgroundElevated: '#1E1B17',
    textPrimary: '#EFEAE2', textSecondary: '#A99F90', textTertiary: '#6E6558',
    line: 'rgba(255,240,214,0.07)',
  },
  {
    id: 'light', label: '浅色',
    backgroundBase: '#F6F7F9', backgroundElevated: '#FFFFFF',
    textPrimary: '#1A1D26', textSecondary: '#5A5E6C', textTertiary: '#9A9EAC',
    line: 'rgba(20,24,36,0.08)',
  },
]

export const ACCENT_SWATCHES = [
  '#6E8BFF', '#5AC8FA', '#C9A96E', '#7ED6A5',
  '#E08A72', '#B48CF2', '#F2A3B3', '#6ED4D4',
] as const

/** 动效速度档位 → 缩放系数（作用于 durationFast/Panel） */
export const MOTION_PRESETS = [
  { id: 'slow', label: '慢', scale: 1.5 },
  { id: 'standard', label: '标准', scale: 1 },
  { id: 'fast', label: '快', scale: 0.6 },
] as const

export type MotionPresetId = (typeof MOTION_PRESETS)[number]['id']

/** 生成一个自定义主题的默认 Token（基于当前主题快照 + 参数面板默认值） */
export function makeCustomTokens(base: ThemeTokens): ThemeTokens {
  return { ...base }
}

/** rgba(hex, alpha)：把 hex 与透明度合成 rgba 字符串 */
export function withAlpha(hex: string, alpha: number): string {
  const m = HEX_RE.exec(hex)
  if (!m) return hex
  let r = 0; let g = 0; let b = 0
  const h = m[1]
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16)
  } else {
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16)
  }
  return `rgba(${r},${g},${b},${alpha})`
}
