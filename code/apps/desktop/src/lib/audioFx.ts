/**
 * 音效：五段图形均衡器 + 声道平衡 + 前置增益 + 空间音效。
 *
 * 两端同一套参数、同一套公式：
 *   · 桌面   → 处理在 Rust 音频线程里（解码之后、频谱取样之前）；
 *   · 安卓   → 处理在 media3 的 AudioProcessor 链里（`FxAudioProcessor`），同样在频谱之前。
 *
 * 两条轴，互相独立：
 *   1. **均衡器**（bands / pre / balance）—— 静态曲线，8 套预设是写死的数字。
 *      预设**只读**：点一下套用，想改必须走「自定义」，此时把当前预设的形状原样
 *      接着往下调，预设本身永远不变（用户原话：预设不让改，只能自己加）。
 *   2. **空间音效**（space）—— 3D 旋转 / 宽广 / 耳机 / 现场，靠的是动态处理，
 *      不是一根曲线能画出来的，所以单独一栏，不跟预设绑在一起。
 *
 * 为什么是 5 段：3 段只能整体「多低音 / 多中频」，拖起来没有均衡器的手感；
 * 主流播放器都是一根一根竖推子，频点取常见的 60 / 230 / 910 / 3.6k / 14k。
 */
import { useEffect, useState } from 'react'
import { bridge } from './bridge'
import { KEYS, settings } from './settings'

/** 五段的中心频率（Hz）。两端 DSP 用的必须是同一组 */
export const FX_BANDS_HZ = [60, 230, 910, 3600, 14000] as const
/** 推子下面那行小字 */
export const FX_BAND_LABELS = ['60', '230', '910', '3.6k', '14k'] as const
/** 每段可调范围（dB） */
export const FX_RANGE = 12

export interface FxValues {
  /** 5 段增益（dB），下标对应 FX_BANDS_HZ */
  bands: number[]
  /** 前置增益（dB）：整体音量，配合软限幅做「显得更响」 */
  pre: number
  /** 声道平衡：-1 全左 · 0 居中 · +1 全右 */
  balance: number
}

export const FX_NEUTRAL: FxValues = { bands: [0, 0, 0, 0, 0], pre: 0, balance: 0 }

/* ------------------------------------------------------------------ */
/* 均衡预设：只读                                                     */
/* ------------------------------------------------------------------ */

export interface FxPreset {
  id: string
  name: string
  desc: string
  values: FxValues
}

export const FX_PRESETS: FxPreset[] = [
  {
    id: 'flat', name: '原声', desc: '不做任何处理',
    values: { bands: [0, 0, 0, 0, 0], pre: 0, balance: 0 },
  },
  {
    id: 'pop', name: '流行', desc: '人声靠前，整体更亮',
    values: { bands: [1.5, 2, 2, 2.5, 2], pre: -1, balance: 0 },
  },
  {
    id: 'rock', name: '摇滚', desc: '鼓点扎实，吉他有锋芒',
    values: { bands: [3.5, 2.5, -1.5, 2, 3], pre: -1.5, balance: 0 },
  },
  {
    id: 'vocal', name: '人声', desc: '压低低频，突出中频',
    values: { bands: [-4, -2, 3, 4, 1.5], pre: 0, balance: 0 },
  },
  {
    id: 'bass', name: '低音', desc: '下潜更深，适合电子 / 嘻哈',
    values: { bands: [7, 5, -1.5, 0.5, 0.5], pre: -2, balance: 0 },
  },
  {
    id: 'bright', name: '明亮', desc: '高频通透，细节更多',
    values: { bands: [-2, 0, 1, 3, 6], pre: -1, balance: 0 },
  },
  {
    id: 'warm', name: '温暖', desc: '削减齿音，像老式功放',
    values: { bands: [3, 2.5, 2, -1, -3], pre: 0, balance: 0 },
  },
  {
    id: 'night', name: '夜间', desc: '小音量也能听清人声',
    values: { bands: [-2, 0, 3, 4.5, -2], pre: -6, balance: 0 },
  },
]

/* ------------------------------------------------------------------ */
/* 空间音效：耳机向的几套动态处理                                      */
/* ------------------------------------------------------------------ */

export type FxSpace = 'off' | 'rotate' | 'wide' | 'ear' | 'live'

export interface FxSpaceDef {
  id: FxSpace
  /** 下发给原生的下标，两端 DSP 必须一致 */
  code: number
  name: string
  desc: string
}

/**
 * 主流播放器音效页里最常出现的几个「空间类」效果。
 * 纯 EQ 变体（超重低音 / 纯净人声 / 清澈女声…）不放这里——上面 8 套预设已经覆盖。
 */
export const FX_SPACES: FxSpaceDef[] = [
  { id: 'off', code: 0, name: '关闭', desc: '原样输出，不做空间处理' },
  { id: 'rotate', code: 1, name: '3D 旋转', desc: '声音绕着头转圈，戴耳机才听得出来' },
  { id: 'wide', code: 2, name: '宽广环绕', desc: '拉开左右声场，像坐宽了一点' },
  { id: 'ear', code: 3, name: '耳机增强', desc: '左右轻微串音，久听不累' },
  { id: 'live', code: 4, name: '现场', desc: '加一点厅堂混响，像在小型现场' },
]

const spaceOf = (id: unknown): FxSpace => {
  const hit = FX_SPACES.find(s => s.id === id)
  return hit ? hit.id : 'off'
}

const spaceCode = (id: FxSpace): number =>
  FX_SPACES.find(s => s.id === id)?.code ?? 0

/* ------------------------------------------------------------------ */

const isPreset = (v: unknown): v is string =>
  typeof v === 'string' && FX_PRESETS.some(p => p.id === v)

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.max(lo, Math.min(hi, n))
}

const neutralCopy = (): FxValues => ({ ...FX_NEUTRAL, bands: [...FX_NEUTRAL.bands] })

/**
 * 把存下来的值修正成合法的 5 段。
 *
 * 要兼容 0.6.99 之前的三段结构（`low / mid / high`）：老用户调过音效的话，
 * 把三段按位置插值摊到五段上，而不是一夜之间退回原声。
 */
function sanitize(v: Record<string, unknown> | null | undefined): FxValues {
  if (!v) return neutralCopy()

  let raw: unknown[] = []
  if (Array.isArray(v.bands)) {
    raw = v.bands as unknown[]
  } else if (typeof v.low === 'number' || typeof v.mid === 'number' || typeof v.high === 'number') {
    const lo = typeof v.low === 'number' ? v.low : 0
    const mi = typeof v.mid === 'number' ? v.mid : 0
    const hi = typeof v.high === 'number' ? v.high : 0
    /* 三段 → 五段：中间补两个插值，形状尽量不变 */
    raw = [lo, (lo + mi) / 2, mi, (mi + hi) / 2, hi]
  }

  return {
    bands: FX_BAND_LABELS.map((_, i) => clamp(raw[i], -FX_RANGE, FX_RANGE, 0)),
    pre: clamp(v.pre, -FX_RANGE, FX_RANGE, 0),
    balance: clamp(v.balance, -1, 1, 0),
  }
}

const copyOf = (v: FxValues): FxValues => ({ ...v, bands: [...v.bands] })

let presetId = 'flat'
let values: FxValues = neutralCopy()
let spaceId: FxSpace = 'off'
/** 用户给自己调的那套参数取的名字（只在 preset === 'custom' 时有意义） */
let customName = '自定义'
let touched = false
let booting: Promise<void> | null = null
const subs = new Set<() => void>()

function emit() {
  subs.forEach(fn => fn())
}

/** 参数发给原生音频链（桌面 Rust / 安卓 AudioProcessor） */
function apply() {
  if (!bridge.isNative) return
  void bridge.invoke('set_fx', {
    bands: values.bands,
    pre: values.pre,
    balance: values.balance,
    space: spaceCode(spaceId),
  }).catch(() => { /* 音频线程没起来时忽略 */ })
}

/**
 * 落盘。拖动推子时每秒会来几十次，直接写 localStorage 会把主线程拖住
 * （安卓上一次写盘紧跟着一次重排，推子会「粘手」）。合并成 250ms 一次，
 * 松手之后那一次一定会写进去。
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null
function persist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void settings.set(KEYS.audioFx, presetId)
    /* space 跟着整组值一起存，省一个键；读的时候在 boot 里拆出来 */
    void settings.set(KEYS.audioFxBands, { ...values, space: spaceId })
    void settings.set(KEYS.audioFxName, customName)
  }, 250)
}

function boot() {
  if (!booting) {
    booting = (async () => {
      const [pid, saved, cname] = await Promise.all([
        settings.get<string>(KEYS.audioFx).catch(() => null),
        settings.get<Record<string, unknown>>(KEYS.audioFxBands).catch(() => null),
        settings.get<string>(KEYS.audioFxName).catch(() => null),
      ])
      if (touched) return
      if (typeof cname === 'string' && cname.trim()) customName = cname.trim()
      if (saved) spaceId = spaceOf(saved.space)
      if (saved && isPreset(pid)) {
        /* 预设只读：形状以代码里的那套为准，存下来的数字只在「自定义」时才算数 */
        const p = FX_PRESETS.find(x => x.id === pid)
        if (p) values = copyOf(p.values)
        presetId = pid
      } else if (saved) {
        values = sanitize(saved)
        presetId = 'custom'
      } else if (isPreset(pid)) {
        const p = FX_PRESETS.find(x => x.id === pid)
        if (p) values = copyOf(p.values)
        presetId = pid
      }
      emit()
      // 重启应用后音效要真的恢复：把存下来的参数推回原生音频链
      apply()
    })().catch(() => { /* 读不到就用原声 */ })
  }
  return booting
}

export function getFx(): { preset: string; values: FxValues; customName: string; space: FxSpace } {
  return { preset: presetId, values, customName, space: spaceId }
}

/** 套用一套预设：整体替换形状，**不**把它标成自定义 */
export function setFxPreset(id: string) {
  const p = FX_PRESETS.find(x => x.id === id)
  if (!p) return
  touched = true
  presetId = id
  values = copyOf(p.values)
  emit()
  apply()
  persist()
}

/**
 * 进入自定义：把**当前选中的那套形状**原样接过来，之后推子才可调。
 *
 * 用户要的就是这个：点「自定义」时先给好一个起点，而不是一张白纸。
 * 已经在自定义里就什么都不做（免得把用户刚调好的清零）。
 */
export function enterCustom() {
  if (presetId === 'custom') return
  touched = true
  presetId = 'custom'
  values = copyOf(values)
  emit()
  apply()
  persist()
}

/** 保存一套自己调的参数（留给「存为自定义」） */
export function setFxCustom(name: string, v: FxValues) {
  touched = true
  presetId = 'custom'
  customName = name.trim().slice(0, 12) || '自定义'
  values = sanitize(v as unknown as Record<string, unknown>)
  emit()
  apply()
  persist()
}

/** 拖某一段推子：只有在自定义里才生效（预设是只读的） */
export function setFxBand(index: number, v: number) {
  if (index < 0 || index >= FX_BANDS_HZ.length) return
  if (presetId !== 'custom') return
  touched = true
  const bands = [...values.bands]
  bands[index] = clamp(v, -FX_RANGE, FX_RANGE, 0)
  values = { ...values, bands }
  emit()
  apply()
  persist()
}

/** 拖声道平衡 */
export function setFxBalance(v: number) {
  if (presetId !== 'custom') return
  touched = true
  values = { ...values, balance: clamp(v, -1, 1, 0) }
  emit()
  apply()
  persist()
}

/** 拖前置增益 */
export function setFxPre(v: number) {
  if (presetId !== 'custom') return
  touched = true
  values = { ...values, pre: clamp(v, -FX_RANGE, FX_RANGE, 0) }
  emit()
  apply()
  persist()
}

/** 空间音效和预设是两条轴：换预设不会把 3D 旋转关掉 */
export function setFxSpace(id: FxSpace) {
  touched = true
  spaceId = spaceOf(id)
  emit()
  apply()
  persist()
}

export function resetFx() {
  setFxPreset('flat')
}

/** 全部归零：留在「自定义」里把推子清零，而不是把用户踢回只读的预设 */
export function zeroFx() {
  touched = true
  presetId = 'custom'
  values = neutralCopy()
  emit()
  apply()
  persist()
}

const sgn = (n: number) => (n > 0 ? '+' : '') + (Math.round(n * 10) / 10).toString()

/** 一行摘要：「60 +3 · 230 0 · 910 -1.5 · 3.6k +2 · 14k +5」 */
export function fxSummary(v: FxValues): string {
  return v.bands.map((b, i) => `${FX_BAND_LABELS[i]} ${sgn(b)}`).join(' · ')
}

/** 平衡的一句话：「居中」/「偏左 40%」 */
export function balanceSummary(b: number): string {
  const pct = Math.round(Math.abs(b) * 100)
  if (pct < 2) return '居中'
  return b < 0 ? `偏左 ${pct}%` : `偏右 ${pct}%`
}

export function spaceName(id: FxSpace): string {
  return FX_SPACES.find(s => s.id === id)?.name ?? '关闭'
}

export function useAudioFx(): {
  preset: string
  values: FxValues
  customName: string
  space: FxSpace
} {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force(n => n + 1)
    subs.add(fn)
    force(n => n + 1)
    void boot()
    return () => { subs.delete(fn) }
  }, [])
  return { preset: presetId, values, customName, space: spaceId }
}
