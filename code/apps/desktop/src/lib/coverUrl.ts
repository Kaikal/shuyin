/**
 * 封面地址归一。
 *
 * 本地曲目的 `cover` 是磁盘绝对路径，必须经 Tauri 的 asset 协议转换
 * （`convertFileSrc`）；在线曲目的 `cover` 是平台 CDN 直链，
 * 再丢给 convertFileSrc 会被当成相对路径编码成 `asset.localhost/https%3A%2F%2F...`，
 * 图直接裂掉。
 */
import { convertFileSrc } from '@tauri-apps/api/core'
import { isTauri } from './bridge'

export function coverUrlOf(cover: string | null | undefined): string | undefined {
  if (!cover) return undefined
  if (/^https?:\/\//i.test(cover)) return cover
  return isTauri ? convertFileSrc(cover) : undefined
}
