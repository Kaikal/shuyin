/**
 * 封面组件：有真实封面（Rust 导出缓存文件）时显示图片；
 * 否则用确定性多段线性渐变占位（同一曲目跨会话颜色稳定）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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

/** 同一个地址的「再来一次」：换一个 query 就绕开了 WebView 里那份失败缓存 */
function bust(u: string, n: number): string {
  const sep = u.includes('?') ? '&' : '?'
  return `${u}${sep}_sy=${n}`
}

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

  /*
   * 大封面要按屏幕密度要图。
   *
   * 播放页那张是 200~300 CSS px，3 倍屏就是 600~900 物理像素；平台接口给的是
   * 300/400 的图（见各平台 `cover()`），直接铺上去就是一层糊（用户反馈）。
   * 这里把需要多少物理像素告诉 `coverUrlOf`，由它决定要不要换大尺寸档；
   * `fill` 的场合没有固定 px，同样按 300 估（黑胶标签实际就在这个量级）。
   */
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1
  const url = coverUrlOf(track.cover, Math.round((fill ? 300 : size) * dpr))
  /** 小图那一档：大图拿不到时退一步（QQ 部分老专辑没有 800 那档，会 404） */
  const small = coverUrlOf(track.cover, 500)
  const dim = fill ? '100%' : size

  /*
   * 加载失败要**重试**，不能一次判死。
   *
   * 用户看到的现象是「封面偶尔出不来」：弱网下 CDN 偶尔超时、安卓本地曲目
   * 第一次抽内嵌封面还可能抽不到（原生回 1×1 透明 PNG）。以前这里只有一个
   * `failedUrl`，失败一次就永久退回渐变——曲子还在放，那一页就一直没有封面。
   *
   * 现在按「第几次尝试」走三步：
   *   0  原地址
   *   1  原地址 + 一个固定后缀（换 URL 才能绕开失败缓存）
   *   2  退到 500 那档（大图 404 的场合靠它救回来）
   * 三次都失败才用渐变占位。
   */
  const [tries, setTries] = useState<{ url: string; n: number }>({ url: '', n: 0 })
  const n = tries.url === url ? tries.n : 0
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  /* 换歌了：上一首挂着的重试没有意义，掐掉 */
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = undefined
  }, [url])

  const src = useMemo(() => {
    if (!url) return undefined
    if (n === 0) return url
    if (n === 1) return bust(url, 1)
    if (small && small !== url) return bust(small, 2)
    return undefined
  }, [url, small, n])

  const retry = () => {
    if (!url || n >= 2) return
    const target: string = url
    const from = n
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setTries(s => {
        const cur = s.url === target ? s.n : 0
        return cur === from ? { url: target, n: from + 1 } : s
      })
    }, from === 0 ? 320 : 900)
  }

  return (
    <div
      className="cover-art"
      style={{
        width: dim, height: dim,
        borderRadius: radius ?? Math.round(size * 0.21),
        background: src ? undefined : `linear-gradient(140deg, ${grad[0]}, ${grad[1]} 62%, ${grad[2]})`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10)',
        flex: 'none',
      }}
    >
      {src && <img
        /* key=url：换歌时让 <img> 重建，别复用上一首的节点——
           复用时 `src` 换掉的瞬间会先画一帧旧图，窄封面还会闪一下拉伸 */
        key={src}
        src={src} alt="" width={size} height={size}
        onError={retry}
        /* 安卓壳抽不到内嵌封面时回的是 **1×1 全透明 PNG**（见 Bridge.kt：宁可给张透明图
           也不许 404，否则 WebView 会画破图标）。它一样是「没有封面」，
           必须退回渐变——不然播放页那块 264 的封面就是一片透明，看着像没加载出来。 */
        onLoad={e => { if (e.currentTarget.naturalWidth <= 1) retry() }}
        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />}
      {!src && size >= 120 && (
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
