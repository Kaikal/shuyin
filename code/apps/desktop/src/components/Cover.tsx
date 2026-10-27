/**
 * 封面组件：有真实封面（Rust 导出缓存文件）时显示图片；
 * 否则用确定性多段线性渐变占位（同一曲目跨会话颜色稳定）。
 */
import { useMemo, useState } from 'react'
import type { LocalTrack } from '@shuyin/core'
import { coverUrlOf } from '../lib/coverUrl'

const PALETTES: Array<[string, string, string]> = [
  ['#2E3F73', '#131A2A', '#0B0E16'],
  ['#312B57', '#0B0A14', '#1A2338'],
  ['#1D3D4A', '#080D12', '#0E2430'],
  ['#4A2E3F', '#140B10', '#241521'],
  ['#2E4A34', '#0A140E', '#12241A'],
  ['#4A442E', '#14120A', '#242014'],
  ['#2E3A4A', '#0B0F14', '#122030'],
  ['#3F2E4A', '#100B14', '#211530'],
]

/**
 * `fill`：尺寸交给外层（宽高都 100%）。
 * 黑胶唱片的标签是「盘径的 58%」，盘径本身跟着窗口变，用固定 px 的封面
 * 在窄窗里会溢出被裁、在宽窗里又缩成一小块，只有百分比才跟得上。
 */
export function Cover({ track, size, radius, fill }: {
  track: LocalTrack
  size: number
  radius?: number
  fill?: boolean
}) {
  const grad = useMemo(() => {
    let h = 0
    for (const ch of track.title + track.album) h = (h * 31 + ch.charCodeAt(0)) | 0
    return PALETTES[Math.abs(h) % PALETTES.length]
  }, [track.title, track.album])

  const url = coverUrlOf(track.cover)
  const dim = fill ? '100%' : size
  /*
   * 图裂了要退回渐变，而不是把浏览器的「破图标」露出来。
   *
   * 桌面端封面是本地文件，基本不会失败；安卓这边封面走本地资产域按专辑 id 现取，
   * 没有内嵌封面的曲目会 404 —— 用户看到的就是一个绿色破图，
   * 比「干脆没有封面」难看得多。加载失败就切到渐变兜底。
   */
  const [failed, setFailed] = useState(false)
  const showImg = !!url && !failed

  return (
    <div
      className="cover-art"
      style={{
        width: dim, height: dim,
        borderRadius: radius ?? Math.round(size * 0.21),
        background: showImg ? undefined : `linear-gradient(140deg, ${grad[0]}, ${grad[1]} 62%, ${grad[2]})`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10)',
        flex: 'none',
      }}
    >
      {showImg && <img src={url} alt="" width={size} height={size}
        onError={() => setFailed(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />}
      {!showImg && size >= 120 && (
        <span className="cover-fallback-glyph" aria-hidden="true">
          <svg width={size * 0.34} height={size * 0.34} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l11-2.2v12.8" />
            <circle cx="6.2" cy="18.4" r="2.8" />
            <circle cx="17.2" cy="16.2" r="2.8" />
          </svg>
        </span>
      )}
    </div>
  )
}
