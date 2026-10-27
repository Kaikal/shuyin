/**
 * 封面亮度 → 沉浸式页背景该压多暗。
 *
 * 为什么不能写死一个 brightness：
 *   专辑图有的近黑、有的纯白。写死 0.62 时纯白封面压完还是浅灰，白字歌词
 *   等于写在白纸上；而近黑封面再压就彻底瞎了。
 * 做法：把封面缩到 8×8 取平均亮度，按「压到目标亮度」反推系数。
 *   白封面（lum≈245）→ 0.4 左右，变成中深灰；深色封面 → 1，一点不动。
 *
 * Tauri 的 asset 协议带 CORS 头，canvas 读得到像素；读不到（比如 file://）
 * 就返回 undefined，CSS 那边有兜底默认值。只在切歌时算一次，代价可以忽略。
 */
import { useEffect, useState } from 'react'

/** 目标平均亮度（0~255）：再低就发黑，再高白字就压不住 */
const TARGET_LUM = 88
/** 最多压到多暗 / 最多提亮到多少 */
const MIN_BRIGHT = 0.34
const MAX_BRIGHT = 1

export function useCoverBrightness(url: string | undefined): number | undefined {
  const [bright, setBright] = useState<number | undefined>(undefined)

  useEffect(() => {
    setBright(undefined)
    if (!url) return
    let alive = true
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = url
    img.decode().then(() => {
      if (!alive) return
      try {
        const c = document.createElement('canvas')
        c.width = 8
        c.height = 8
        const ctx = c.getContext('2d')
        if (!ctx) return
        /*
         * 背景是 cover + 放大 1.14 倍，屏幕上看到的其实只是封面的中间一小块。
         * 所以采样要按「中间 60%」为主（0.7）+ 整图（0.3），
         * 否则一张四角黑、中间白的封面会被算成「很暗」，结果一片惨白。
         */
        const w = img.naturalWidth
        const h = img.naturalHeight
        const lumOf = (sx: number, sy: number, sw: number, sh: number) => {
          ctx.clearRect(0, 0, 8, 8)
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 8, 8)
          const d = ctx.getImageData(0, 0, 8, 8).data
          let sum = 0
          for (let i = 0; i < d.length; i += 4) {
            sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
          }
          return sum / (d.length / 4)
        }
        const center = lumOf(w * 0.2, h * 0.2, w * 0.6, h * 0.6)
        const all = lumOf(0, 0, w, h)
        const lum = center * 0.7 + all * 0.3
        if (!alive || !lum) return
        const v = Math.min(MAX_BRIGHT, Math.max(MIN_BRIGHT, TARGET_LUM / lum))
        setBright(Math.round(v * 100) / 100)
      } catch {
        /* 读不到像素（跨域 / 画布被污染）：用 CSS 的默认值 */
      }
    }).catch(() => { /* 图片加载失败：同上 */ })
    return () => { alive = false }
  }, [url])

  return bright
}
