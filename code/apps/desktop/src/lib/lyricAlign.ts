/**
 * 播放页歌词的对齐方式：居左 / 居中 / 居右。
 *
 * 为什么需要它：右栏是「一整块很宽的区域」（实测 1121 宽的窗口里，歌词栏有 641px），
 * 但歌词一直写死靠左，短句只占左边 120px 左右——眼睛看到的是「歌词只有一小条，
 * 右边空着一大片」。三种对齐让这块区域真正被用上：居中时句子落在整栏中线上，
 * 长句也才有地方铺开。
 *
 * 只影响播放页右栏（`.imm-lyric`），不动详情面板和全屏歌词——那两处各有自己的排版。
 */
import { useEffect, useState } from 'react'
import { KEYS, settings } from './settings'

export type LyricAlign = 'left' | 'center' | 'right'

export const LYRIC_ALIGN_LIST: { id: LyricAlign; name: string }[] = [
  { id: 'left', name: '居左' },
  { id: 'center', name: '居中' },
  { id: 'right', name: '居右' },
]

const isAlign = (v: unknown): v is LyricAlign => v === 'left' || v === 'center' || v === 'right'

/** 默认居中：右栏是整块宽阔区域，居左会把每句都顶到最左边、右边留一大片空白 */
let current: LyricAlign = 'center'
let touched = false
let booting: Promise<void> | null = null
const subs = new Set<(v: LyricAlign) => void>()

function emit(v: LyricAlign) {
  subs.forEach(fn => fn(v))
}

function boot() {
  if (!booting) {
    booting = settings.get<LyricAlign>(KEYS.lyricAlign).then(v => {
      if (touched || !isAlign(v) || v === current) return
      current = v
      emit(v)
    }).catch(() => { /* 读不到就用默认「居中」 */ })
  }
  return booting
}

export function getLyricAlign(): LyricAlign {
  return current
}

export function setLyricAlign(v: LyricAlign) {
  if (!isAlign(v) || v === current) return
  touched = true
  current = v
  emit(v)
  void settings.set(KEYS.lyricAlign, v)
}

export const lyricAlignName = (id: LyricAlign) =>
  LYRIC_ALIGN_LIST.find(a => a.id === id)?.name ?? '居中'

export function useLyricAlign(): [LyricAlign, (v: LyricAlign) => void] {
  const [v, setV] = useState<LyricAlign>(current)
  useEffect(() => {
    const fn = (n: LyricAlign) => setV(n)
    subs.add(fn)
    setV(current)
    void boot()
    return () => { subs.delete(fn) }
  }, [])
  return [v, setLyricAlign]
}
