/**
 * 封面地址归一 + 按需取尺寸。
 *
 * 本地曲目的 `cover` 是磁盘绝对路径，必须经 Tauri 的 asset 协议转换
 * （`convertFileSrc`）；在线曲目的 `cover` 是平台 CDN 直链，
 * 再丢给 convertFileSrc 会被当成相对路径编码成 `asset.localhost/https%3A%2F%2F...`，
 * 图直接裂掉。
 */
import { convertFileSrc } from '@tauri-apps/api/core'
import { isTauri } from './bridge'

/** CDN 上真正拿得到的两档：列表 / 播放页大图 */
const SMALL = 500
const BIG = 800

/**
 * 把在线封面换成「够这块地方用」的尺寸。
 *
 * 为什么要有这一步：平台接口给的封面尺寸是写死在 URL 里的（QQ 300、
 * 网易 500、酷狗 400），而播放页那张封面在手机上要占 200dp —— 3 倍屏
 * 就是 600 物理像素，300 的图拉上去必然发虚（用户反馈「专辑封面很糊」）。
 *
 * 三家的写法都不一样，所以按各家的 URL 形态替换，认不出来的一律原样返回
 * （宁可糊也不能裂）：
 *   · QQ    `y.qq.com/music/photo_new/T002R500x500M000{albummid}.jpg`
 *           —— **只有 300 / 500 / 800 三档**，600 会 404（实测）
 *   · 网易云 `p1.music.126.net/...jpg?param=500y500` —— 任意尺寸
 *   · 酷狗   `imge.kugou.com/stdmusic/500/...jpg` —— 任意尺寸
 *   · 酷我   路径里没有尺寸参数，原样返回
 */
function sized(url: string, px: number): string {
  if (/y\.qq\.com\/music\/photo_new\//.test(url)) {
    // 只能落在这三档上，别写 px 本身
    const qq = px > SMALL ? BIG : SMALL
    return url.replace(/T002R\d+x\d+M000/, `T002R${qq}x${qq}M000`)
  }
  if (/music\.126\.net/.test(url) && /[?&]param=\d+y\d+/.test(url)) {
    return url.replace(/([?&])param=\d+y\d+/, `$1param=${px}y${px}`)
  }
  if (/imge\.kugou\.com\/stdmusic\/\d+\//.test(url)) {
    return url.replace(/(stdmusic\/)\d+(\/)/, `$1${px}$2`)
  }
  return url
}

/**
 * @param needPx 这块 `<img>` 实际要铺的物理像素（CSS 宽度 × devicePixelRatio）。
 *   不传就按列表小图那一档给（500）。
 */
export function coverUrlOf(cover: string | null | undefined, needPx?: number): string | undefined {
  if (!cover) return undefined
  if (!/^https?:\/\//i.test(cover)) return isTauri ? convertFileSrc(cover) : undefined
  return sized(cover, needPx && needPx > SMALL ? BIG : SMALL)
}
