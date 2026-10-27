/**
 * 频谱样式：全局共享一份选择。
 * 设置页选完，播放页立刻跟着换——两边都不重挂载，靠订阅同步。
 */
import { useEffect, useState } from 'react'
import { KEYS, settings } from './settings'

export type SpectrumStyle = 'bars' | 'meter' | 'wave' | 'dots' | 'ribbon' | 'mirror'

export const SPECTRUM_STYLES: Array<{ id: SpectrumStyle; name: string; desc: string }> = [
  { id: 'bars', name: '柱状', desc: '经典竖条，贴底生长' },
  { id: 'meter', name: '电平表', desc: 'LED 分段 + 峰值余晖' },
  { id: 'wave', name: '音浪', desc: '平滑山形曲线' },
  { id: 'dots', name: '点阵', desc: '圆点堆叠，轻快细密' },
  { id: 'ribbon', name: '丝带', desc: '多层流动叠影' },
  { id: 'mirror', name: '镜像', desc: '上下对称，中间轴' },
]

const isStyle = (v: unknown): v is SpectrumStyle =>
  typeof v === 'string' && SPECTRUM_STYLES.some(s => s.id === v)

let current: SpectrumStyle = 'bars'
let touched = false
let booting: Promise<void> | null = null
const subs = new Set<(s: SpectrumStyle) => void>()

function emit(s: SpectrumStyle) {
  subs.forEach(fn => fn(s))
}

/** 首次使用时从存档读一次；用户已经点过就不再覆盖 */
function boot() {
  if (!booting) {
    booting = settings.get<SpectrumStyle>(KEYS.spectrumStyle).then(v => {
      if (!touched && isStyle(v) && v !== current) {
        current = v
        emit(v)
      }
    }).catch(() => { /* 读不到就用默认柱状 */ })
  }
  return booting
}

export function getSpectrumStyle(): SpectrumStyle {
  return current
}

export function setSpectrumStyle(s: SpectrumStyle) {
  if (!isStyle(s)) return
  touched = true
  current = s
  emit(s)
  void settings.set(KEYS.spectrumStyle, s)
}

/** 轮换到下一种（播放页快捷切换用） */
export function nextSpectrumStyle(): SpectrumStyle {
  const i = SPECTRUM_STYLES.findIndex(x => x.id === current)
  const next = SPECTRUM_STYLES[(i + 1) % SPECTRUM_STYLES.length].id
  setSpectrumStyle(next)
  return next
}

export function spectrumStyleName(s: SpectrumStyle): string {
  return SPECTRUM_STYLES.find(x => x.id === s)?.name ?? '柱状'
}

export function useSpectrumStyle(): [SpectrumStyle, (s: SpectrumStyle) => void] {
  const [s, setS] = useState<SpectrumStyle>(current)
  useEffect(() => {
    const fn = (v: SpectrumStyle) => setS(v)
    subs.add(fn)
    setS(current) // 订阅前可能已经切换过
    void boot()
    return () => { subs.delete(fn) }
  }, [])
  return [s, setSpectrumStyle]
}
