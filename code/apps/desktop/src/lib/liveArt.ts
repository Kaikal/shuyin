/**
 * Live Activity（iOS 灵动岛 / 锁屏实时活动）的封面缩略图。
 *
 * 为什么不能直接把封面路径交给原生：
 *   Widget 扩展和主 App 是两个沙箱，`file://` 路径在扩展那边读不到；
 *   网络 URL 也不行——扩展加载图片有时间预算，锁屏刷新时会空一片。
 *   所以只能把图**变成字节**塞进 ContentState。
 *
 * 尺寸为什么是 72：
 *   ContentState 整体上限 4KB，base64 后还要再涨 1/3。72×72 的 JPEG 在
 *   quality 0.55 下大约 1.5~2.5KB，给歌名/进度这些字段留足余量；
 *   灵动岛上那张图最大只画到 46pt（@3x ≈ 138px），但 72px 放大到那个
 *   尺寸看着并不糊——因为岛的显示尺寸本身小，且是不透明圆角裁切。
 */
import { invoke, isTauri } from './bridge'

/** 缩略图边长（px） */
const SIZE = 72
/**
 * base64 软上限。
 *
 * ContentState 整体 4KB，而这一份几乎是全部占用。以前留 400B 给文字，
 * 2026-11-22 加了歌词行之后不够了：歌名/歌手/专辑 + 一句最多 40 字（JSON 里
 * 中文会变成 `\uXXXX`，每字 6 字节 ≈ 240B）＋字段名，加起来能顶到 4KB 边缘。
 * 超了 `Activity.request` 会直接抛错（整条灵动岛都不出现），所以压到 3000。
 * 72×72 / q0.55 正常在 1.5~2.5KB，3000 仍有富余；真压不下会退到 q0.38。
 */
const MAX_B64 = 3000

/** 上一次的结果。切歌/暂停会反复调这个，同一张封面没必要重算 */
let cachedPath = ''
let cachedB64 = ''

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('cover decode failed'))
    img.src = src
  })
}

function encode(img: HTMLImageElement, quality: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  const side = Math.min(w, h)
  if (!side) return ''
  // 居中裁成正方形：封面多数是方的，非方的（写真、横版）裁中间比拉变形好看
  ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, SIZE, SIZE)
  const url = canvas.toDataURL('image/jpeg', quality)
  const comma = url.indexOf(',')
  return comma >= 0 ? url.slice(comma + 1) : ''
}

/**
 * 把一张本地封面文件压成 base64 JPEG（不含 data URI 前缀）。
 *
 * @param localPath 磁盘上的封面路径（`cachedCoverPath()` 的返回值）。
 *   **不要传 CDN 直链**：这里不会去下载，拿不到就返回空串，
 *   灵动岛那边会画一个音符占位。
 * @returns base64 字符串；空串 = 没有可用封面
 */
export async function liveArtOf(localPath: string | null | undefined): Promise<string> {
  if (!localPath || !isTauri) return ''
  if (localPath === cachedPath) return cachedB64
  cachedPath = localPath
  cachedB64 = ''
  try {
    /*
     * 先让 Rust 读成 data URL，再在 canvas 上缩放。
     * 为什么不直接 `<img src=convertFileSrc(path)>`：asset:// 跟页面不同源，
     * canvas 会被污染，`toDataURL()` 直接抛 SecurityError。而 data: URL
     * 是同源的，怎么读都不受限。
     */
    const dataUrl = await invoke<string>('read_cover_data_url', { path: localPath })
    const img = await loadImage(dataUrl)
    let b64 = encode(img, 0.55)
    if (!b64) return ''
    // 塞不下就降一档质量再试（极少数噪点封面压不下去）
    if (b64.length > MAX_B64) b64 = encode(img, 0.38)
    if (b64.length > MAX_B64) b64 = ''
    cachedB64 = b64
    return b64
  } catch {
    // 读不到就当没有封面，不要因为一张图把整条灵动岛搞挂
    return ''
  }
}
