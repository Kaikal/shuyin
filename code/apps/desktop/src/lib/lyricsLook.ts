/**
 * 沉浸式歌词的「观感」预设（参考 Folia 的全屏歌词主题）。
 *
 * 只调排版参数，不换骨架：当前句始终是舞台主角，上下句按距离缩小、变暗、虚化。
 * 三套差异在「字号节奏 / 行距 / 倾斜 / 字重 / 字距」，对应三种气质：
 *   流光 —— 有纵深、字重稳，信息量最大，默认
 *   浮名 —— 极简，字轻、字距开、只留前后各一句
 *   群唱 —— 前后句留得更多、更亮，像多声部一起铺开
 */
import { useEffect, useState } from 'react'
import { KEYS, settings } from './settings'

export type LyricsLookId = 'lumi' | 'fume' | 'chorus'

export interface LyricsLook {
  id: LyricsLookId
  name: string
  desc: string
  /** 行距，相对基准字号 */
  gap: number
  /** |d| = 1 / >= 2 的缩放 */
  scale: [number, number]
  /** |d| = 1 / >= 2 的不透明度 */
  opacity: [number, number]
  /** |d| = 1 / >= 2 的虚化（px） */
  blur: [number, number]
  weight: number
  tracking: string
  /** 每往上一级倾斜多少度（0 = 完全平面） */
  tilt: number
  /** 舞台上下各留几行 */
  span: number
}

export const LYRICS_LOOKS: LyricsLook[] = [
  {
    id: 'lumi', name: '流光', desc: '有纵深，字重稳，信息量最大',
    gap: 1.6, scale: [0.6, 0.4], opacity: [0.26, 0.09], blur: [3.4, 6.4],
    weight: 600, tracking: '0.03em', tilt: -5, span: 2,
  },
  {
    id: 'fume', name: '浮名', desc: '极简留白，字轻、字距开',
    gap: 1.95, scale: [0.52, 0.34], opacity: [0.2, 0.07], blur: [4, 7],
    weight: 300, tracking: '0.14em', tilt: 0, span: 1,
  },
  {
    id: 'chorus', name: '群唱', desc: '前后句更亮，像多声部铺开',
    gap: 1.44, scale: [0.68, 0.5], opacity: [0.36, 0.14], blur: [1.8, 3.6],
    weight: 700, tracking: '0.01em', tilt: -3, span: 2,
  },
]

const isLook = (v: unknown): v is LyricsLookId =>
  typeof v === 'string' && LYRICS_LOOKS.some(l => l.id === v)

let current: LyricsLookId = 'lumi'
let touched = false
let booting: Promise<void> | null = null
const subs = new Set<(v: LyricsLookId) => void>()

function emit(v: LyricsLookId) {
  subs.forEach(fn => fn(v))
}

function boot() {
  if (!booting) {
    booting = settings.get<LyricsLookId>(KEYS.lyricsLook).then(v => {
      if (touched || !isLook(v) || v === current) return
      current = v
      emit(v)
    }).catch(() => { /* 读不到就用默认「流光」 */ })
  }
  return booting
}

export function getLyricsLook(): LyricsLookId {
  return current
}

export function setLyricsLook(v: LyricsLookId) {
  if (!isLook(v)) return
  touched = true
  current = v
  emit(v)
  void settings.set(KEYS.lyricsLook, v)
}

export function nextLyricsLook(): LyricsLookId {
  const i = LYRICS_LOOKS.findIndex(l => l.id === current)
  const next = LYRICS_LOOKS[(i + 1) % LYRICS_LOOKS.length].id
  setLyricsLook(next)
  return next
}

export const lyricsLookName = (id: LyricsLookId) =>
  LYRICS_LOOKS.find(l => l.id === id)?.name ?? '流光'

export const lyricsLookDef = (id: LyricsLookId): LyricsLook =>
  LYRICS_LOOKS.find(l => l.id === id) ?? LYRICS_LOOKS[0]

export function useLyricsLook(): [LyricsLookId, (v: LyricsLookId) => void] {
  const [v, setV] = useState<LyricsLookId>(current)
  useEffect(() => {
    const fn = (n: LyricsLookId) => setV(n)
    subs.add(fn)
    setV(current)
    void boot()
    return () => { subs.delete(fn) }
  }, [])
  return [v, setLyricsLook]
}
