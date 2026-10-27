/**
 * 频谱的另外几种摆放形态（位置由 lib/spectrumPos 决定）：
 *
 *   SpectrumEdges  贴窗口四边：一条长条，横向或纵向铺满整条边。
 *                  方向永远是「从窗口边缘朝里长」——底部从下往上、顶部从上往下、
 *                  左侧从左往右、右侧从右往左，四条边用的是同一套观感。
 *                  纯装饰层，pointer-events: none，不吃点击。
 *   CoverRing      环绕专辑封面：一圈柱状光环，从封面边缘向外跳。
 *                  封面本身是方的，所以环也是方的（圆角矩形），不是圆。
 *
 * 两者都只画柱状/弧段——横向的六种样式（电平表、丝带…）在一条细长条上
 * 辨识度反而下降，边缘位置统一用「柱」最稳。
 */
import { useEffect, useRef } from 'react'
import { bridge } from '../lib/bridge'
import { useSpectrumPos } from '../lib/spectrumPos'
import type { SpectrumStyle } from '../lib/spectrumStyle'
import { Spectrum } from './Spectrum'

/* ------------------------------------------------------------------ */
/* 贴边                                                               */
/* ------------------------------------------------------------------ */

export function SpectrumEdges({ playing, variant, imm }: {
  playing: boolean
  variant: SpectrumStyle
  /** 沉浸式播放页打开时，层级要抬到整屏覆盖层之上，否则看不见 */
  imm?: boolean
}) {
  const [pos] = useSpectrumPos()
  if (pos === 'cover') return null

  const vertical = pos === 'left' || pos === 'right'
  /* 顶部往下长、左侧往右长；右侧和底部本来就是从边缘朝里长 */
  const flip = pos === 'top' || pos === 'left'
  return (
    <div className="sedge" data-pos={pos} data-imm={imm ? 'true' : 'false'} aria-hidden="true">
      <Spectrum
        playing={playing}
        variant={variant}
        vertical={vertical}
        flip={flip}
        className={'sedge-spec' + (vertical ? ' is-vertical' : '')}
        barWidth={vertical ? 7 : 5}
        gap={3}
        maxBars={vertical ? 90 : 180}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 封面环绕                                                            */
/* ------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 圆角矩形路径（只建路径，不填充） */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

/** 40 段 → n 段（环上柱数少一点更好看） */
function resample(src: number[], n: number): number[] {
  if (!src.length) return new Array(n).fill(0)
  if (src.length === n) return src.slice()
  const out = new Array<number>(n)
  const last = src.length - 1
  for (let i = 0; i < n; i++) {
    const p = (i / Math.max(1, n - 1)) * last
    const i0 = Math.floor(p)
    const i1 = Math.min(last, i0 + 1)
    const f = p - i0
    out[i] = src[i0] * (1 - f) + src[i1] * f
  }
  return out
}

function hexA(color: string, alpha: number): string {
  const c = color.trim()
  const hex = /^#?([0-9a-f]{6})$/i.exec(c)
  if (hex) {
    const int = parseInt(hex[1], 16)
    return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c)
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
  return c
}

interface Pt { x: number; y: number; nx: number; ny: number; corner?: boolean }

/**
 * 圆角矩形周长参数化：t ∈ [0,1) 顺时针从「上边中点」出发，
 * 返回该点的坐标与外法线。四条直边 + 四段圆角弧按真实弧长分配参数，
 * 柱子沿周长才疏密均匀（直接按角度分会在四个角上挤成一团）。
 */
function makeWalker(hw: number, hh: number, rad: number) {
  const r = Math.max(0, Math.min(rad, hw, hh))
  const edgeX = 2 * Math.max(0, hw - r)
  const edgeY = 2 * Math.max(0, hh - r)
  const arc = (Math.PI / 2) * r
  const total = edgeX * 2 + edgeY * 2 + arc * 4
  /* 每一段的累计起点（按顺时针：上边 → 右上角 → 右边 → 右下角 → 下边 → 左下角 → 左边 → 左上角） */
  const bounds: number[] = []
  let acc = 0
  const push = (len: number) => { bounds.push(acc); acc += len }
  push(edgeX); push(arc); push(edgeY); push(arc); push(edgeX); push(arc); push(edgeY); push(arc)

  return (t: number): Pt => {
    let d = ((t % 1) + 1) % 1 * total
    // 上边中点 → 右上角起点：上边只用后半段
    d = (d + edgeX / 2) % total
    for (let s = 0; s < 8; s++) {
      const start = bounds[s]
      const end = s === 7 ? total : bounds[s + 1]
      if (d <= end || s === 7) {
        const k = end > start ? (d - start) / (end - start) : 0
        switch (s) {
          case 0: // 上边：左 → 右
            return { x: -hw + r + edgeX * k, y: -hh, nx: 0, ny: -1 }
          case 1: { // 右上角
            const a = -Math.PI / 2 + (Math.PI / 2) * k
            return { x: hw - r + Math.cos(a) * r, y: -hh + r + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a), corner: true }
          }
          case 2: // 右边：上 → 下
            return { x: hw, y: -hh + r + edgeY * k, nx: 1, ny: 0 }
          case 3: { // 右下角
            const a = (Math.PI / 2) * k
            return { x: hw - r + Math.cos(a) * r, y: hh - r + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a), corner: true }
          }
          case 4: // 下边：右 → 左
            return { x: hw - r - edgeX * k, y: hh, nx: 0, ny: 1 }
          case 5: { // 左下角
            const a = Math.PI / 2 + (Math.PI / 2) * k
            return { x: -hw + r + Math.cos(a) * r, y: hh - r + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a), corner: true }
          }
          case 6: // 左边：下 → 上
            return { x: -hw, y: hh - r - edgeY * k, nx: -1, ny: 0 }
          default: { // 左上角
            const a = Math.PI + (Math.PI / 2) * k
            return { x: -hw + r + Math.cos(a) * r, y: -hh + r + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a), corner: true }
          }
        }
      }
    }
    return { x: -hw, y: -hh, nx: 0, ny: -1 }
  }
}

/**
 * 环绕封面的频谱光环（方形）。
 * 容器要 relative，本组件绝对定位铺满并向外扩出 PAD，光环才不会被裁掉。
 *
 * 形状跟着全局的频谱样式走（用户反馈过「换形状时环绕不变」）：
 *   bars/meter/dots/mirror 沿法线画分段几何，wave/ribbon 沿环画平滑闭合曲线。
 *   环上数据沿用「沿周长对折」的口径，与贴边频谱的观感保持一致。
 */
interface Pt2 { x: number; y: number }

export function CoverRing({ playing, pad = 100, className, variant = 'bars' }: {
  playing: boolean
  /** 父容器四周留出的外扩空间（px），要和 CSS 的 --ring-pad 一致 */
  pad?: number
  className?: string
  variant?: SpectrumStyle
}) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const target = useRef<number[]>([])
  const smooth = useRef<number[]>([])
  /** wave / ribbon 每层自己的平滑曲线 */
  const extra = useRef<Record<string, number[]>>({})
  const peak = useRef(0.3)

  useEffect(() => {
    if (!playing) {
      target.current = target.current.map(() => 0)
      return
    }
    let stopped = false
    const pull = async () => {
      const v = await bridge.spectrum()
      if (stopped || !v.length) return
      target.current = v
    }
    void pull()
    const id = window.setInterval(pull, 60)
    return () => { stopped = true; window.clearInterval(id) }
  }, [playing])

  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    let raf = 0
    let last = 0
    let accent = '#6E8BFF'
    let soft = '#9DB2FF'
    const readInk = () => {
      const cs = getComputedStyle(document.documentElement)
      accent = cs.getPropertyValue('--sy-accent').trim() || '#6E8BFF'
      soft = cs.getPropertyValue('--sy-accent-soft').trim() || accent
    }
    readInk()
    const mo = new MutationObserver(() => readInk())
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const r = cv.getBoundingClientRect()
      cv.width = Math.max(1, Math.round(r.width * dpr))
      cv.height = Math.max(1, Math.round(r.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(cv)

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      if (t - last < 30) return
      last = t

      const r = cv.getBoundingClientRect()
      const W = r.width
      const H = r.height
      if (W < 8 || H < 8) return
      ctx.clearRect(0, 0, W, H)

      const cx = W / 2
      const cy = H / 2
      // 画布 = 封面 + 两侧 pad：内框正好压在封面边缘上，外框是柱子的最大长度
      const cover = Math.max(8, Math.min(W, H) - pad)
      const half = cover / 2 + 1.5
      const room = Math.max(10, pad / 2 - 4)
      // 封面圆角 18 / 236 ≈ 0.076，环跟着封面走才不显得「外面套了个圆的」
      const rad = cover * 0.076
      const walk = makeWalker(half, half, rad)

      const n = 72
      /*
       * 沿周长「对折」取频谱：上边中点是低频，往下两边对称地走到高频。
       * 直接把 40 段铺满一圈的话，高频段能量小，下半圈会几乎没有柱子，
       * 一个方框看起来缺了一半。对折之后左右必然对称，形状永远是完整的一框。
       */
      const halfN = n / 2
      const vals = resample(target.current, halfN)
      // 高频能量本来就低，抬一下，不然下半圈会几乎看不到柱子（整框就缺了一块）
      for (let k = 0; k < halfN; k++) {
        vals[k] = Math.min(1, (vals[k] ?? 0) * (1 + 1.7 * (k / Math.max(1, halfN - 1))))
      }
      if (smooth.current.length !== halfN) smooth.current = vals.slice()
      for (let k = 0; k < halfN; k++) {
        const tgt = vals[k] ?? 0
        const cur = smooth.current[k] ?? 0
        smooth.current[k] = tgt > cur ? cur + (tgt - cur) * 0.55 : cur * 0.86
      }

      let frameMax = 0
      for (let k = 0; k < halfN; k++) frameMax = Math.max(frameMax, smooth.current[k] ?? 0)
      peak.current = Math.max(peak.current * 0.982, frameMax)
      const gain = Math.min(3.2, 0.9 / Math.max(0.16, peak.current))

      const isPath = variant === 'wave' || variant === 'ribbon'

      if (isPath) {
        /*
         * wave / ribbon：沿环采样 n 个点，按各自数值向外偏移，再连成平滑闭合曲线。
         * wave 一层（描边 + 与内框之间填淡色）；ribbon 三层错落曲线叠出流动感。
         */
        const layers = variant === 'ribbon'
          ? [
              { key: 'rib0', scale: 1, alpha: 0.3, rise: 0.45, fall: 0.9 },
              { key: 'rib1', scale: 0.66, alpha: 0.42, rise: 0.34, fall: 0.92 },
              { key: 'rib2', scale: 0.4, alpha: 0.55, rise: 0.26, fall: 0.94 },
            ]
          : [{ key: 'wave', scale: 1, alpha: 0.85, rise: 0.5, fall: 0.82 }]

        // 内框基准多边形（fill 波形与框之间用）
        const basePts: Pt2[] = []
        for (let i = 0; i < n; i++) {
          const w = walk(i / n)
          basePts.push({ x: cx + w.x, y: cy + w.y })
        }

        for (let li = 0; li < layers.length; li++) {
          const l = layers[li]
          let arr = extra.current[l.key]
          if (!arr || arr.length !== halfN) { arr = vals.slice(); extra.current[l.key] = arr }
          for (let k = 0; k < halfN; k++) {
            const tgt = clamp01((vals[k] ?? 0) * gain)
            const cur = arr[k] ?? 0
            arr[k] = tgt > cur ? cur + (tgt - cur) * l.rise : cur * l.fall
          }
          const pts: Pt2[] = []
          for (let i = 0; i < n; i++) {
            const k = Math.min(i, n - 1 - i)
            const w = walk(i / n)
            const v = Math.pow(clamp01(arr[k] ?? 0), 0.72)
            const off = (3 + v * room) * l.scale * (w.corner ? 0.75 : 1)
            pts.push({ x: cx + w.x + w.nx * off, y: cy + w.y + w.ny * off })
          }
          const m = pts.length
          // 中点平滑的闭合曲线（先建一次，wave 要描两遍）
          const strokeCurve = () => {
            ctx.beginPath()
            ctx.moveTo((pts[0].x + pts[m - 1].x) / 2, (pts[0].y + pts[m - 1].y) / 2)
            for (let i = 0; i < m; i++) {
              const c = pts[i]
              const nx2 = pts[(i + 1) % m]
              ctx.quadraticCurveTo(c.x, c.y, (c.x + nx2.x) / 2, (c.y + nx2.y) / 2)
            }
            ctx.closePath()
          }

          if (variant === 'wave') {
            // 波形与内框之间垫一层淡色：同一条 path 里逆序补上内框多边形，
            // 外圈顺时针 + 内圈逆时针，nonzero 填充只落在两者之间（不会染到封面上）
            strokeCurve()
            for (let i = m - 1; i >= 0; i--) ctx.lineTo(basePts[i].x, basePts[i].y)
            ctx.closePath()
            ctx.fillStyle = hexA(accent, 0.17)
            ctx.fill()
          }

          strokeCurve()
          ctx.strokeStyle = hexA(li === layers.length - 1 ? soft : accent, l.alpha)
          ctx.lineWidth = li === layers.length - 1 ? 1.6 : 1.1
          ctx.lineJoin = 'round'
          ctx.stroke()
        }
      } else {
        // 分段几何类：柱 / 电平表 / 点阵 / 镜像，共用一套沿法线的定位
        const gapT = 0.26 / n
        for (let i = 0; i < n; i++) {
          const k = Math.min(i, n - 1 - i)
          // 开方压动态 + 抬底：安静段落也不至于只剩 2px 的一排短线，框才完整
          const v = Math.max(0.16, Math.pow(clamp01((smooth.current[k] ?? 0) * gain), 0.72))
          const t0 = i / n + gapT / 2
          const t1 = (i + 1) / n - gapT / 2
          const a = walk(t0)
          const b = walk(t1)
          const nlen = Math.hypot(a.nx + b.nx, a.ny + b.ny) || 1
          const nx = (a.nx + b.nx) / nlen
          const ny = (a.ny + b.ny) / nlen
          const mx = cx + (a.x + b.x) / 2
          const my = cy + (a.y + b.y) / 2
          const segLen = Math.hypot(b.x - a.x, b.y - a.y)
          const baseOff = 3.5
          /*
           * 四个圆角上的柱子压短一半：那里柱子的内边只有几个像素，
           * 长度还给满就会变成四根斜着炸出去的尖刺。
           */
          const full = (baseOff + v * room) * (a.corner ? 0.45 : 1)

          const quad = (f0: number, f1: number) => {
            ctx.beginPath()
            ctx.moveTo(cx + a.x + nx * f0, cy + a.y + ny * f0)
            ctx.lineTo(cx + b.x + nx * f0, cy + b.y + ny * f0)
            ctx.lineTo(cx + b.x + nx * f1, cy + b.y + ny * f1)
            ctx.lineTo(cx + a.x + nx * f1, cy + a.y + ny * f1)
            ctx.closePath()
            ctx.fill()
          }

          if (variant === 'meter') {
            // LED 分段：4 格，点亮格随高度变亮、顶格用 soft，未点亮的留极淡刻度
            const rows = 4
            for (let j = 0; j < rows; j++) {
              const level = (j + 1) / rows
              const lit = v * rows - j
              const f0 = baseOff + (j / rows) * (full - baseOff)
              const f1 = baseOff + ((j + 1) / rows) * (full - baseOff)
              if (lit > 0.001) {
                ctx.fillStyle = hexA(level > 0.8 ? soft : accent, (0.2 + 0.6 * level) * Math.min(1, lit + 0.25))
              } else {
                ctx.fillStyle = hexA(accent, 0.07)
              }
              quad(f0, f1)
            }
          } else if (variant === 'dots') {
            // 点阵：沿法线一串小圆点，点亮的亮、没点亮的极淡
            const cnt = 3
            for (let j = 0; j < cnt; j++) {
              const level = (j + 1) / cnt
              const lit = v * cnt - j
              const d = baseOff + ((j + 0.6) / cnt) * (full - baseOff)
              ctx.beginPath()
              ctx.arc(mx + nx * d, my + ny * d, Math.max(1.1, Math.min(2.4, segLen * 0.3)), 0, Math.PI * 2)
              ctx.fillStyle = hexA(level > 0.8 ? soft : accent, lit > 0.001 ? (0.28 + 0.55 * level) * Math.min(1, lit + 0.3) : 0.08)
              ctx.fill()
            }
          } else if (variant === 'mirror') {
            // 镜像：从内侧 30% 处向外长，视觉上像环内外各长了一层
            ctx.fillStyle = hexA(v > 0.7 ? soft : accent, 0.14 + 0.62 * v)
            quad(-0.32 * full, full)
          } else {
            // bars（默认）：两头共用一条法线，圆角才不会摊成扇形
            ctx.fillStyle = hexA(v > 0.7 ? soft : accent, 0.14 + 0.62 * v)
            quad(0, full)
          }
        }
      }

      // 一圈极淡的内描边：把「频谱框」和封面分开，不然两者糊在一起
      ctx.strokeStyle = hexA(accent, 0.22)
      ctx.lineWidth = 1
      ctx.beginPath()
      roundedRect(ctx, cx - half, cy - half, half * 2, half * 2, rad)
      ctx.stroke()
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect() }
  }, [pad, variant])

  return (
    <canvas
      ref={cvRef}
      className={'cover-ring ' + (className ?? '')}
      aria-hidden="true"
    />
  )
}
