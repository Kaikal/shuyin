/**
 * 音效：三段 EQ（低架 / 峰值 / 高架）+ 前置增益。
 *
 * 处理发生在 Rust 音频线程里（解码之后、频谱取样之前），所以：
 *   · 前端只是「参数面板」，改动立刻生效，不用重载当前曲目；
 *   · 频谱看到的也是处理后的声音。
 *
 * 预设和自定义是同一个东西：预设就是一组数字，用户拖滑块后 preset 变成 custom，
 * 数字照样存下来。这样不必为「自定义」另开一条数据结构。
 */
import { useEffect, useState } from 'react'
import { bridge } from './bridge'
import { KEYS, settings } from './settings'

export interface FxValues {
  /** 低频架增益（dB），120Hz 以下 */
  low: number
  /** 中频峰值增益（dB） */
  mid: number
  /** 高频架增益（dB），8kHz 以上 */
  high: number
  /** 前置增益（dB）：整体音量，配合软限幅做「显得更响」 */
  pre: number
  /** 中频中心频率（Hz） */
  midHz: number
}

export const FX_NEUTRAL: FxValues = { low: 0, mid: 0, high: 0, pre: 0, midHz: 1000 }

export const FX_PRESETS: Array<{ id: string; name: string; desc: string; values: FxValues }> = [
  { id: 'flat', name: '原声', desc: '不做任何处理', values: { ...FX_NEUTRAL } },
  {
    id: 'pop', name: '流行', desc: '人声靠前，整体更亮',
    values: { low: 1.5, mid: 2, high: 2.5, pre: -1, midHz: 1600 },
  },
  {
    id: 'rock', name: '摇滚', desc: '鼓点扎实，吉他有锋芒',
    values: { low: 3.5, mid: -1.5, high: 3, pre: -1.5, midHz: 2200 },
  },
  {
    id: 'vocal', name: '人声', desc: '压低低频，突出中频',
    values: { low: -4, mid: 4, high: 1.5, pre: 0, midHz: 1800 },
  },
  {
    id: 'bass', name: '低音', desc: '下潜更深，适合电子/嘻哈',
    values: { low: 7, mid: -1.5, high: 0.5, pre: -2, midHz: 800 },
  },
  {
    id: 'bright', name: '明亮', desc: '高频通透，细节更多',
    values: { low: -2, mid: 1, high: 6, pre: -1, midHz: 1200 },
  },
  {
    id: 'warm', name: '温暖', desc: '削减齿音，像老式功放',
    values: { low: 3, mid: 2, high: -3, pre: 0, midHz: 900 },
  },
  {
    id: 'night', name: '夜间', desc: '小音量也能听清人声',
    values: { low: -2, mid: 4.5, high: -2, pre: -6, midHz: 1500 },
  },
]

const isPreset = (v: unknown): v is string =>
  typeof v === 'string' && (v === 'custom' || FX_PRESETS.some(p => p.id === v))

const clampVal = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.max(lo, Math.min(hi, n))
}

function sanitize(v: Partial<FxValues> | null | undefined): FxValues {
  const d = FX_NEUTRAL
  return {
    low: clampVal(v?.low, -12, 12, d.low),
    mid: clampVal(v?.mid, -12, 12, d.mid),
    high: clampVal(v?.high, -12, 12, d.high),
    pre: clampVal(v?.pre, -12, 12, d.pre),
    midHz: clampVal(v?.midHz, 200, 4000, d.midHz),
  }
}

let presetId = 'flat'
let values: FxValues = { ...FX_NEUTRAL }
/** 用户给自己调的那套参数取的名字（只在 preset === 'custom' 时有意义） */
let customName = '自定义'
let touched = false
let booting: Promise<void> | null = null
const subs = new Set<() => void>()

function emit() {
  subs.forEach(fn => fn())
}

/** 参数发给 Rust 音频线程 */
function apply() {
  if (!bridge.isTauri) return
  void bridge.invoke('set_fx', {
    low: values.low,
    mid: values.mid,
    high: values.high,
    midHz: values.midHz,
    pre: values.pre,
  }).catch(() => { /* 音频线程没起来时忽略 */ })
}

function persist() {
  void settings.set(KEYS.audioFx, presetId)
  void settings.set(KEYS.audioFxBands, values)
  void settings.set(KEYS.audioFxName, customName)
}

function boot() {
  if (!booting) {
    booting = (async () => {
      const [pid, saved, cname] = await Promise.all([
        settings.get<string>(KEYS.audioFx).catch(() => null),
        settings.get<Partial<FxValues>>(KEYS.audioFxBands).catch(() => null),
        settings.get<string>(KEYS.audioFxName).catch(() => null),
      ])
      if (touched) return
      if (typeof cname === 'string' && cname.trim()) customName = cname.trim()
      if (saved) {
        values = sanitize(saved)
        presetId = isPreset(pid) ? pid : 'custom'
      } else if (isPreset(pid) && pid !== 'custom') {
        const p = FX_PRESETS.find(x => x.id === pid)
        if (p) values = { ...p.values }
        presetId = pid
      }
      emit()
      // 重启应用后音效要真的恢复：把存下来的参数推回 Rust
      apply()
    })().catch(() => { /* 读不到就用原声 */ })
  }
  return booting
}

export function getFx(): { preset: string; values: FxValues; customName: string } {
  return { preset: presetId, values, customName }
}

export function setFxPreset(id: string) {
  const p = FX_PRESETS.find(x => x.id === id)
  if (!p) return
  touched = true
  presetId = id
  values = { ...p.values }
  emit()
  apply()
  persist()
}

/**
 * 保存一套自己调的参数。名字留空就退回「自定义」。
 * 自定义不是「另一种模式」——它只是「preset 这个字段等于 custom」，
 * 参数还是那几个数，所以不必另开一条数据结构。
 */
export function setFxCustom(name: string, v: FxValues) {
  touched = true
  presetId = 'custom'
  customName = name.trim().slice(0, 12) || '自定义'
  values = sanitize(v)
  emit()
  apply()
  persist()
}

/** 拖滑块：任何一段被改就变成「自定义」 */
export function setFxBand(key: keyof FxValues, v: number) {
  touched = true
  const lim = key === 'midHz' ? [200, 4000] : [-12, 12]
  values = { ...values, [key]: clampVal(v, lim[0], lim[1], values[key]) }
  presetId = 'custom'
  emit()
  apply()
  persist()
}

export function resetFx() {
  setFxPreset('flat')
}

/** 一行摘要：「低 +3 · 中 -1.5 · 高 +5」 */
export function fxSummary(v: FxValues): string {
  const s = (n: number) => (n > 0 ? '+' : '') + (Math.round(n * 10) / 10).toString()
  return `低 ${s(v.low)} · 中 ${s(v.mid)} · 高 ${s(v.high)} dB`
}

export function useAudioFx(): { preset: string; values: FxValues; customName: string } {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force(n => n + 1)
    subs.add(fn)
    force(n => n + 1)
    void boot()
    return () => { subs.delete(fn) }
  }, [])
  return { preset: presetId, values, customName }
}
