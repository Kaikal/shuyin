/**
 * 桌面歌词「逐字高亮」配色：全局共享一份选择。
 * 设置页、桌面歌词窗口（悬停条换色）都读同一份，换完立刻生效。
 */
import { useEffect, useState } from 'react'
import { KEYS, settings } from './settings'

export type LyricsColorId = 'gold' | 'rose' | 'azure' | 'mint' | 'violet' | 'amber'

export interface LyricsColorPreset {
  id: LyricsColorId
  /** 预设名（口语化，方便在悬停条上认） */
  name: string
  /** 已唱歌词的颜色 */
  color: string
  /** 一句话说明，设置页副标题用 */
  desc: string
}

/** 参考 QQ 音乐桌面歌词的几套经典配色 */
export const LYRIC_COLORS: LyricsColorPreset[] = [
  { id: 'gold', name: '流金', color: '#FFC94D', desc: '经典金 · QQ 音乐默认' },
  { id: 'rose', name: '品红', color: '#FF6FAE', desc: '偏暖的粉，夜里最显眼' },
  { id: 'azure', name: '冰蓝', color: '#7BA6FF', desc: '冷调蓝，配深色壁纸' },
  { id: 'mint', name: '青碧', color: '#4FE0B0', desc: '清爽薄荷，护眼' },
  { id: 'violet', name: '紫霞', color: '#B98BFF', desc: '梦幻紫，偏柔和' },
  { id: 'amber', name: '霞橙', color: '#FF8A4C', desc: '落日橙，暖而克制' },
]

export const DEFAULT_LYRIC_COLOR: LyricsColorId = 'gold'

const isColor = (v: unknown): v is LyricsColorId =>
  typeof v === 'string' && LYRIC_COLORS.some(c => c.id === v)

export function lyricColorValue(id: LyricsColorId): string {
  return LYRIC_COLORS.find(c => c.id === id)?.color ?? LYRIC_COLORS[0].color
}

export function lyricColorName(id: LyricsColorId): string {
  return LYRIC_COLORS.find(c => c.id === id)?.name ?? LYRIC_COLORS[0].name
}

let current: LyricsColorId = DEFAULT_LYRIC_COLOR
let touched = false
let booting: Promise<void> | null = null
const subs = new Set<(c: LyricsColorId) => void>()

function emit(c: LyricsColorId) {
  subs.forEach(fn => fn(c))
}

function boot() {
  if (!booting) {
    booting = settings.get<LyricsColorId>(KEYS.lyricsColor).then(v => {
      if (!touched && isColor(v) && v !== current) {
        current = v
        emit(v)
      }
    }).catch(() => { /* 读不到就用流金 */ })
  }
  return booting
}

export function getLyricColor(): LyricsColorId {
  return current
}

export function setLyricColor(c: LyricsColorId) {
  if (!isColor(c)) return
  touched = true
  current = c
  emit(c)
  void settings.set(KEYS.lyricsColor, c)
}

/** 悬停条上一键换色 */
export function nextLyricColor(): LyricsColorId {
  const i = LYRIC_COLORS.findIndex(x => x.id === current)
  const next = LYRIC_COLORS[(i + 1) % LYRIC_COLORS.length].id
  setLyricColor(next)
  return next
}

export function useLyricColor(): [LyricsColorId, (c: LyricsColorId) => void] {
  const [c, setC] = useState<LyricsColorId>(current)
  useEffect(() => {
    const fn = (v: LyricsColorId) => setC(v)
    subs.add(fn)
    setC(current)
    void boot()
    return () => { subs.delete(fn) }
  }, [])
  return [c, setLyricColor]
}
