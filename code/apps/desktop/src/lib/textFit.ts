/**
 * 单行文字的「视觉宽度」估算。
 *
 * 中文/日文/韩文/全角标点按 1 个字宽算，拉丁字母、数字、半角标点按 0.55 算。
 * 不追求逐字体精确——只用来决定「这句该用多大字号」，差几个像素看不出来，
 * 但差 30% 就会明显跑到窗外面去。
 */
const FULLWIDTH = /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/

export function visualWidth(text: string): number {
  let w = 0
  for (const ch of text) w += FULLWIDTH.test(ch) ? 1 : 0.55
  return w
}

/** 只缩不放：让 text 用 f 号字也放不进 maxPx 时返回更小的字号 */
export function shrinkToFit(text: string, f: number, maxPx: number): number {
  const w = visualWidth(text)
  if (!text || w <= 0 || w * f <= maxPx) return f
  return Math.max(8, Math.floor(maxPx / w))
}

/**
 * 铺满式取字号：短句放大到接近 maxPx，长句缩小到刚好放得下。
 *
 * 桌面歌词的窗宽是用户自己拉的，如果字号一直按「基准值」走，
 * 一句 10 个字只占 900px 窗口的三分之一，看起来就像「缩在中间」。
 * 这里用「可用宽度 ÷ 视觉字宽」直接算出理想字号，再夹在合理区间里。
 */
export function fillToWidth(
  text: string,
  base: number,
  maxPx: number,
  opts?: { maxGrow?: number; maxFont?: number; minRatio?: number },
): number {
  const w = visualWidth(text)
  if (!text || w <= 0) return base
  const maxGrow = opts?.maxGrow ?? 1.35
  const hi = Math.min(base * maxGrow, opts?.maxFont ?? 999)
  const lo = Math.max(10, base * (opts?.minRatio ?? 0.42))
  const ideal = maxPx / w
  return Math.round(Math.min(hi, Math.max(lo, ideal)))
}

/**
 * 字号已经被上限卡住时，把剩下的宽度摊到字缝里（字距），让短句也铺到两端。
 *
 * 桌面歌词的窗口高度是按字号推的，字号不能无限放大（否则字会被裁），
 * 但「宽窗 + 短句」只靠字号永远填不满——加字距是唯一不改变行高的办法。
 * 上限 0.7em 左右，再多就变成散落的字粒了。
 */
export function trackToFill(text: string, size: number, maxPx: number, maxEm = 0.6): number {
  const n = Array.from(text).length
  if (n < 2) return 0
  const used = visualWidth(text) * size
  const extra = (maxPx - used) / (n - 1)
  return Math.round(Math.max(0, Math.min(size * maxEm, extra)))
}
