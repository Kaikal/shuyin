/**
 * 桌面歌词的「宽窄 + 字号 + 背景浓度」：全局共享一份布局参数。
 *
 * 四个入口改的是同一份状态：
 *   1. 歌词窗口右侧边缘按住拖动（最直观）
 *   2. 悬停条上的 A− / A+ （调字号）
 *   3. 设置 → 桌面歌词 的滑块
 *   4. 滚轮 / Shift+滚轮
 * 改完写存档，跨窗口用 `lyrics://action { action: 'layout' }` 互相同步。
 *
 * 窗口高度不单独暴露：它由字号推出来（主句按最大可能放大量算 + 副句 + 控制条留白），
 * 让用户单独调高度只会得到一堆被裁掉的歌词。
 */
import { useEffect, useState } from 'react'
import { KEYS, settings } from './settings'

export const LYRIC_W_MIN = 520
export const LYRIC_W_MAX = 1400
export const LYRIC_FONT_MIN = 16
/** 主句字号上限：再大就压过桌面了，KTV 也是「一行字横过去」而不是巨型字幕 */
export const LYRIC_FONT_MAX = 52
export const LYRIC_W_DEFAULT = 900
/** 基准字号：实际显示字号按句长在它上面浮动（短句放大、长句缩小） */
export const LYRIC_FONT_DEFAULT = 24
/** 背景浓度：太淡看不出边界，太实挡住桌面 */
export const LYRIC_BG_MIN = 0.18
export const LYRIC_BG_MAX = 0.96
/** 默认偏实：桌面壁纸千差万别，太淡时用户根本找不到歌词卡的边界 */
export const LYRIC_BG_DEFAULT = 0.8

/** 单行歌词相对基准字号最多放大到多少倍（短句要铺满宽度） */
export const LYRIC_GROW = 1.9

/**
 * 布局版本。
 * v1 的默认字号是 34（配上 2.2 倍放大，一行字能到 74px，用户反馈「太大」），
 * 升到 v2 时把存档里的字号重置成新的默认值——只重置一次，之后用户自己调的值不会被碰。
 */
export const LYRIC_LAYOUT_VERSION = 2

export interface LyricsLayout {
  /** 窗口宽度（CSS 像素） */
  width: number
  /** 主句基准字号（CSS 像素），实际字号会按句长在基准上浮动 */
  fontSize: number
  /** 底板浓度 0~1 */
  bg: number
}

/**
 * 高度跟着字号走。
 * 主句可能被放大到 LYRIC_GROW 倍，副句最多到主句那么高——按上限留位置，
 * 否则「这一句字少、下一句字多」时会来回裁字。
 */
export function lyricWindowHeight(fontSize: number): number {
  const main = Math.min(fontSize * LYRIC_GROW, LYRIC_FONT_MAX)
  const sub = Math.min(main, fontSize * 0.52 * 1.6)
  /*
   * 末尾这 +100 是「悬停控制条专用净空」：控制条本身 41px 高、贴窗口底 14px，
   * 加上 6px 间隙 = 61px，取 100 是因为主/副句的估算里已经含了一部分行高余量，
   * 实测（900×154、字号 18）原来的 +78 让控制条压住第二排 12.6px。
   * 与 immersive.css 里 `.dl { padding-bottom: 62px }` 必须成对，改一边就会重新叠上。
   */
  return Math.round(main * 1.28 + sub * 1.34 + 100)
}

export const clampWidth = (v: number) => Math.round(Math.min(LYRIC_W_MAX, Math.max(LYRIC_W_MIN, v)))
export const clampFont = (v: number) => Math.round(Math.min(LYRIC_FONT_MAX, Math.max(LYRIC_FONT_MIN, v)))
export const clampBg = (v: number) => Math.round(Math.min(LYRIC_BG_MAX, Math.max(LYRIC_BG_MIN, v)) * 100) / 100

let current: LyricsLayout = { width: LYRIC_W_DEFAULT, fontSize: LYRIC_FONT_DEFAULT, bg: LYRIC_BG_DEFAULT }
/** 用户/代码改过以后，启动时的存档读取就不能再覆盖它 */
let touched = false
let booting: Promise<void> | null = null
const subs = new Set<(l: LyricsLayout) => void>()

function emit(l: LyricsLayout) {
  subs.forEach(fn => fn(l))
}

const same = (a: LyricsLayout, b: LyricsLayout) =>
  a.width === b.width && a.fontSize === b.fontSize && a.bg === b.bg

function boot() {
  if (!booting) {
    booting = Promise.all([
      settings.get<number>(KEYS.lyricsWidth),
      settings.get<number>(KEYS.lyricsFont),
      settings.get<number>(KEYS.lyricsBg),
      settings.get<number>(KEYS.lyricsLayoutV),
    ]).then(([w, f, b, v]) => {
      if (touched) return
      const oldV = typeof v === 'number' ? v : 1
      const next: LyricsLayout = {
        width: typeof w === 'number' ? clampWidth(w) : current.width,
        // 老版本的默认字号偏大，升级到 v2 时重置一次；之后用户调过的不再动
        fontSize: oldV < LYRIC_LAYOUT_VERSION
          ? LYRIC_FONT_DEFAULT
          : (typeof f === 'number' ? clampFont(f) : current.fontSize),
        bg: typeof b === 'number' ? clampBg(b) : current.bg,
      }
      if (oldV < LYRIC_LAYOUT_VERSION) {
        void settings.set(KEYS.lyricsLayoutV, LYRIC_LAYOUT_VERSION)
        void settings.set(KEYS.lyricsFont, next.fontSize)
      }
      if (same(next, current)) return
      current = next
      emit(next)
    }).catch(() => { /* 读不到就用默认值 */ })
  }
  return booting
}

export function getLyricsLayout(): LyricsLayout {
  return current
}

export function setLyricsLayout(patch: Partial<LyricsLayout>, persist = true): LyricsLayout {
  const next: LyricsLayout = {
    width: patch.width != null ? clampWidth(patch.width) : current.width,
    fontSize: patch.fontSize != null ? clampFont(patch.fontSize) : current.fontSize,
    bg: patch.bg != null ? clampBg(patch.bg) : current.bg,
  }
  if (same(next, current)) return current
  touched = true
  current = next
  emit(next)
  if (persist) {
    void settings.set(KEYS.lyricsWidth, next.width)
    void settings.set(KEYS.lyricsFont, next.fontSize)
    void settings.set(KEYS.lyricsBg, next.bg)
  }
  return current
}

export function useLyricsLayout(): [LyricsLayout, (patch: Partial<LyricsLayout>) => void] {
  const [l, setL] = useState<LyricsLayout>(current)
  useEffect(() => {
    const fn = (v: LyricsLayout) => setL(v)
    subs.add(fn)
    setL(current)
    void boot()
    return () => { subs.delete(fn) }
  }, [])
  return [l, setLyricsLayout]
}
