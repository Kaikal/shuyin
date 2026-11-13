/**
 * 频谱可视化：数据来自 Rust 侧对解码采样的实时 FFT（40 个对数频段）。
 * 浏览器预览时 bridge 用合成波形兜底，保证能看到效果。
 *
 * 样式（variant）：
 *   bars   柱状    经典竖条，贴底生长（默认）
 *   meter  电平表  LED 分段 + 峰值帽，像硬件功放的显示
 *   wave   音浪    平滑山形曲线 + 渐变填充
 *   dots   点阵    圆点堆叠，轻快细密
 *   ribbon 丝带    三层错位曲线叠在一起，有流动感
 *   mirror 镜像    上下对称，中间一条轴
 *
 * 主题适配：所有颜色都从 CSS 变量读（--sy-accent / --sy-accent-soft / --sy-line），
 * 并监听 :root 的 style/class 变化——切主题时频谱立刻换色，不用等重挂载。
 */
import { useEffect, useRef } from 'react'
import { bridge } from '../lib/bridge'
import type { SpectrumStyle } from '../lib/spectrumStyle'

interface Props {
  playing: boolean
  /** 组件高度（CSS px） */
  height?: number
  className?: string
  /** 上下镜像（上下各一半），用于页面中间的「音浪基线」 */
  mirrored?: boolean
  /** 柱宽（CSS px）；不给则按容器宽度自适应 */
  barWidth?: number
  /** 柱间隙（CSS px） */
  gap?: number
  /** 柱数上限，防止超宽屏柱子过密 */
  maxBars?: number
  /** 视觉样式 */
  variant?: SpectrumStyle
  /** 纵向（贴左右边缘用）：绘制坐标系旋转 90°，柱子从底边向右「生长」 */
  vertical?: boolean
  /**
   * 生长方向翻转：顶部通栏让柱子从顶边往下长、左侧通栏让柱子从左沿往右长。
   * 用坐标系镜像实现——所有样式（柱/电平/音浪/点阵/镜像）自动跟着翻，
   * 不用为每种样式各写一套向上/向下的坐标。
   */
  flip?: boolean
  /**
   * 这块频谱现在看不看得见。
   *
   * 默认 true（贴边光带这类常驻装饰）。传 false 时**整个绘制循环不启动**——
   * 播放页里那两条频谱是常驻挂载的，页关掉了它照样 33fps 清屏重画，
   * 主线程和电池都白烧（用户反馈「很多地方的动画还是卡」多半有它一份）。
   */
  active?: boolean
}

/** 40 段对数频段 → 屏幕上 n 根柱子（线性插值，视觉上更细密连贯） */
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

/** 对数频段本身高频能量低：不抬一下右边会贴成一条平地 */
function bands(src: number[], n: number): number[] {
  const out = resample(src, n)
  for (let i = 0; i < n; i++) {
    const lift = 1 + 0.85 * (i / Math.max(1, n - 1))
    out[i] = Math.min(1, (out[i] ?? 0) * lift)
  }
  return out
}

interface Ink {
  accent: string
  soft: string
  line: string
}

function readInk(): Ink {
  const cs = getComputedStyle(document.documentElement)
  const accent = cs.getPropertyValue('--sy-accent').trim() || '#6E8BFF'
  return {
    accent,
    soft: cs.getPropertyValue('--sy-accent-soft').trim() || accent,
    line: cs.getPropertyValue('--sy-line').trim() || 'rgba(255,255,255,0.12)',
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export function Spectrum({
  playing, height = 64, className, mirrored = false, barWidth, gap = 2, maxBars = 160,
  variant = 'bars', vertical = false, flip = false, active = true,
}: Props) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const target = useRef<number[]>([])
  /** 每种样式独立一套平滑曲线 / 峰值帽：切换样式时不会互相拖影 */
  const smooths = useRef<Record<string, number[]>>({})
  const caps = useRef<Record<string, number[]>>({})
  /** 自动增益用的滑动峰值，避免安静段落整条贴在基线 */
  const peakRef = useRef(0.3)
  /**
   * 绘制循环只跑一次（依赖里没有 playing），所以要一个 ref 拿最新值：
   * 没数据时的「呼吸」只在播放中走，暂停就定格。
   */
  const playingRef = useRef(playing)
  playingRef.current = playing

  /* 取数：播放中每 60ms 拉一次；暂停后目标归零，由绘制循环自然衰减 */
  useEffect(() => {
    if (!playing || !active) {
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
  }, [playing, active])

  /* 绘制循环 */
  useEffect(() => {
    if (!active) return
    const cv = cvRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    let raf = 0
    let last = 0
    let ink = readInk()
    /*
     * 画布尺寸只在 ResizeObserver 里读，绘制循环里不碰 getBoundingClientRect。
     * 每帧读一次布局 = 一次强制 reflow；这个循环 33fps 跑着，页面里任何
     * DOM 改动（进度条、歌词高亮、切页动画）都会被它顶着同步一遍布局。
     */
    let cw = 0
    let ch = 0

    // 切主题（style 属性 / class 变化）时立刻换色
    const mo = new MutationObserver(() => { ink = readInk() })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const r = cv.getBoundingClientRect()
      cw = r.width
      ch = r.height
      cv.width = Math.max(1, Math.round(r.width * dpr))
      cv.height = Math.max(1, Math.round(r.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(cv)

    /** 起得快、落得慢的平滑；按 key 各自维护一条曲线 */
    const smoothTo = (key: string, src: number[], rise = 0.58, fall = 0.87) => {
      let arr = smooths.current[key]
      if (!arr || arr.length !== src.length) {
        arr = src.slice()
        smooths.current[key] = arr
        return arr
      }
      for (let i = 0; i < src.length; i++) {
        const tgt = src[i] ?? 0
        const cur = arr[i] ?? 0
        arr[i] = tgt > cur ? cur + (tgt - cur) * rise : cur * fall
      }
      return arr
    }

    /** 连续多少帧一条数据都没有（≈ 1.4 秒），判「这台机器没给频谱」 */
    let idleFrames = 0
    /**
     * 兜底用的「呼吸波」。
     *
     * 安卓上频谱要 RECORD_AUDIO：权限没给、或这台 ROM 不把输出音频开放给
     * Visualizer 时，native 恒回 40 个 0——整条频谱贴成一条 2px 的死线，
     * 用户看到的就是「频谱全是静止的」。真数据一来立刻接管，这里只在
     * 长时间零数据且正在播放时顶上，节奏固定、幅度小，不会被当成真频谱。
     */
    const idleWave = (t: number): number[] => {
      const a = new Array<number>(40)
      for (let i = 0; i < 40; i++) {
        const shape = Math.exp(-Math.pow((i - 7) / 13, 2))
        a[i] = 0.05 + 0.34 * shape * (0.5 + 0.5 * Math.sin(t / 620 + i * 0.42))
      }
      return a
    }

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      if (t - last < 28) return
      last = t

      // 尺寸用 ResizeObserver 缓存下来的 cw/ch；纵向时不改 CSS 尺寸，
      // 只把绘制坐标系转 90°：逻辑宽 = 元素高（沿屏幕竖直方向），逻辑高 = 元素宽
      const W = vertical ? ch : cw
      const H = vertical ? cw : ch
      if (W < 2 || H < 2) return
      ctx.clearRect(0, 0, cw, ch)
      const mirroredAxis = vertical || flip
      if (mirroredAxis) {
        ctx.save()
        if (vertical) {
          ctx.translate(0, ch)
          ctx.rotate(-Math.PI / 2)
          // 左侧通栏：基线要落在窗口左沿（逻辑 y=0），柱子朝右长
          if (flip) { ctx.translate(0, H); ctx.scale(1, -1) }
        } else {
          // 顶部通栏：基线翻到逻辑 y=0，柱子朝下长
          ctx.translate(0, H)
          ctx.scale(1, -1)
        }
      }
      try {

      // 柱状类样式的几何；wave / dots 会按自己的疏密另算
      const bw = barWidth ?? Math.max(3, Math.min(9, W / 128))
      const n = Math.max(12, Math.min(maxBars, Math.floor((W + gap) / (bw + gap))))
      const step = (W + gap) / n
      const startX = (W - (step * n - gap)) / 2
      const baseY = mirrored ? H / 2 : H
      const unit = mirrored ? H / 2 : H

      const gainFor = (vals: number[]) => {
        let frameMax = 0
        for (let i = 0; i < vals.length; i++) frameMax = Math.max(frameMax, vals[i] ?? 0)
        peakRef.current = Math.max(peakRef.current * 0.982, frameMax)
        return Math.min(3.4, 0.92 / Math.max(0.18, peakRef.current))
      }

      /* 一条数据都没有：播放中改画呼吸波，暂停就让它停在原地 */
      let rawMax = 0
      for (let i = 0; i < target.current.length; i++) {
        const v0 = target.current[i] ?? 0
        if (v0 > rawMax) rawMax = v0
      }
      if (rawMax < 0.005) idleFrames++
      else idleFrames = 0
      /*
       * 暂停、而且数据已经完全衰减：**什么也不画**。
       *
       * 每根柱子的高度都有 `Math.max(2, …)` 的下限，没有数据时整条频谱就是
       * 一排 2px 高的点，等距、齐平——深色主题下它埋在近黑底里看不出来，
       * 浅色主题下就变成横在白底上的一条「亮蓝虚线」。
       * 没有声音本来就没有频谱，清屏（上面刚 clearRect 过）比画一条假基线诚实。
       */
      if (!playingRef.current && rawMax < 0.005) return
      const idle = idleFrames > 40 && playingRef.current
      const src = idle ? idleWave(t) : target.current

      const raw = bands(src, n)
      // 只推进一次平滑：重复调用会让柱子追得更急，视觉上忽快忽慢
      const barsVals = smoothTo('bars', raw)
      /* 兜底的呼吸波幅度已经按「看得出在动、但不像真在放歌」定好了，
         别再走自动增益把它顶到满格 */
      const gain = idle ? 1 : gainFor(barsVals)

      if (variant === 'bars' || variant === 'meter' || variant === 'mirror') {
        const vals = barsVals
        const capArr = (() => {
          const a = caps.current[variant]
          if (!a || a.length !== n) { const b = new Array(n).fill(0); caps.current[variant] = b; return b }
          return a
        })()

        if (variant === 'mirror') {
          const axis = H / 2
          const grad = ctx.createLinearGradient(0, axis - unit, 0, axis + unit * 0.7)
          grad.addColorStop(0, hexA(ink.accent, 0.22))
          grad.addColorStop(0.5, hexA(ink.accent, 0.95))
          grad.addColorStop(0.72, hexA(ink.accent, 0.5))
          grad.addColorStop(1, hexA(ink.accent, 0.06))
          ctx.fillStyle = grad
          for (let i = 0; i < n; i++) {
            const v = Math.max(0.02, clamp01((vals[i] ?? 0) * gain))
            const up = Math.max(2, v * unit * 0.95)
            const down = Math.max(2, v * unit * 0.62)
            const x = startX + i * step
            roundRect(ctx, x, axis - up, bw, up + down, Math.min(bw / 2, 3))
          }
          ctx.fillStyle = hexA(ink.accent, 0.35)
          ctx.fillRect(0, axis - 0.5, W, 1)
          return
        }

        if (variant === 'meter') {
          const segH = 3.4
          const segGap = 1.5
          const pitch = segH + segGap
          const rows = Math.max(4, Math.floor(unit / pitch))
          const colW = Math.max(2, Math.min(bw * 0.9, 6))

          for (let i = 0; i < n; i++) {
            const v = Math.max(0.02, clamp01((vals[i] ?? 0) * gain))
            const lit = v * rows
            const x = startX + i * step + (bw - colW) / 2
            // 未点亮的格：极淡的"刻度"，让整条看起来像一块仪表
            ctx.fillStyle = hexA(ink.accent, 0.07)
            for (let j = 0; j < rows; j++) {
              const y = baseY - (j + 1) * pitch + segGap
              ctx.fillRect(x, y, colW, segH)
            }
            // 点亮的格：越高越亮，顶上两格用 soft 收口
            for (let j = 0; j < rows; j++) {
              const level = (j + 1) / rows
              if (j + 1 > lit + 0.001) break
              const partial = Math.min(1, Math.max(0.25, lit - j))
              const alpha = (0.42 + 0.58 * level) * partial
              ctx.fillStyle = level > 0.8 ? hexA(ink.soft, alpha) : hexA(ink.accent, alpha)
              const y = baseY - (j + 1) * pitch + segGap
              ctx.fillRect(x, y, colW, segH)
            }
            capArr[i] = Math.max(capArr[i] * 0.94, Math.min(unit, lit * pitch))
          }

          // 峰值帽：一小段悬停的亮线，缓慢回落
          for (let i = 0; i < n; i++) {
            const y = baseY - Math.min(unit, capArr[i])
            if (y > baseY - 3) continue
            ctx.fillStyle = hexA(ink.soft, 0.85)
            ctx.fillRect(startX + i * step + (bw - colW) / 2, y - 1.5, colW, 1.6)
          }
          ctx.fillStyle = ink.line
          ctx.globalAlpha = 0.5
          ctx.fillRect(0, H - 0.5, W, 1)
          ctx.globalAlpha = 1
          return
        }

        // bars：底部实、顶部虚，像从底边长出来
        const grad = ctx.createLinearGradient(0, baseY - unit, 0, baseY)
        grad.addColorStop(0, hexA(ink.accent, 0.28))
        grad.addColorStop(0.45, hexA(ink.accent, 0.82))
        grad.addColorStop(1, hexA(ink.accent, 1))
        ctx.fillStyle = grad

        const capH = Math.max(1.5, Math.min(2.5, bw * 0.36))
        for (let i = 0; i < n; i++) {
          const v = Math.max(0.02, clamp01((vals[i] ?? 0) * gain))
          const h = Math.max(2, v * unit)
          const x = startX + i * step
          roundRect(ctx, x, baseY - h, bw, h, Math.min(bw / 2, 3))
          capArr[i] = Math.max(capArr[i] * 0.95, h)
        }

        // 柱顶高亮：紧贴柱子的亮头（不是悬空的一段），让柱体有层次
        if (!mirrored) {
          ctx.fillStyle = hexA(ink.soft, 0.85)
          for (let i = 0; i < n; i++) {
            const v = Math.max(0.02, clamp01((vals[i] ?? 0) * gain))
            const h = Math.max(2, v * unit)
            if (h < 4) continue
            const x = startX + i * step
            roundRect(ctx, x, baseY - h, bw, Math.min(capH, h), capH / 2)
          }
          // 底部基线：跟着主题走的一条极淡横线，给「地平线」的存在感
          ctx.fillStyle = ink.line
          ctx.globalAlpha = 0.55
          ctx.fillRect(0, H - 0.5, W, 1)
          ctx.globalAlpha = 1
        }
        return
      }

      if (variant === 'dots') {
        const pitchX = Math.max(5.2, Math.min(9, W / 150))
        const dn = Math.max(16, Math.min(280, Math.floor(W / pitchX)))
        const dx = W / dn
        const vals = smoothTo('dots', bands(src, dn), 0.66, 0.84)
        const g = idle ? 1 : gainFor(vals)
        const pitchY = Math.max(5, Math.min(7.5, unit / 14))
        const radius = Math.max(1.2, Math.min(2.1, pitchY * 0.31))
        const rows = Math.max(5, Math.floor(unit / pitchY))

        for (let i = 0; i < dn; i++) {
          const v = Math.max(0.02, clamp01((vals[i] ?? 0) * g))
          const lit = v * rows
          const cx = dx * (i + 0.5)
          for (let j = 0; j < rows; j++) {
            const level = (j + 1) / rows
            const partial = Math.min(1, Math.max(0.18, lit - j))
            if (j + 1 > lit + 0.001) break
            const cy = baseY - (j + 0.5) * pitchY
            ctx.beginPath()
            ctx.arc(cx, cy, radius * (0.55 + 0.45 * partial), 0, Math.PI * 2)
            ctx.fillStyle = hexA(level > 0.84 ? ink.soft : ink.accent, 0.32 + 0.62 * level * partial)
            ctx.fill()
          }
        }
        ctx.fillStyle = ink.line
        ctx.globalAlpha = 0.5
        ctx.fillRect(0, H - 0.5, W, 1)
        ctx.globalAlpha = 1
        return
      }

      // wave / ribbon：按曲线采样，柱宽无关
      const wn = Math.max(48, Math.min(180, Math.floor(W / 6.5)))

      const fillWave = (
        vals: number[],
        g: number,
        topAlpha: number,
        bottomAlpha: number,
        stroke: string | null,
        lineWidth = 1.6,
        yScale = 1,
      ) => {
        const pts: Array<{ x: number; y: number }> = []
        for (let i = 0; i < wn; i++) {
          const v = Math.max(0.02, clamp01((vals[i] ?? 0) * g)) * yScale
          pts.push({ x: (i / (wn - 1)) * W, y: baseY - v * unit })
        }
        const path = new Path2D()
        path.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = (pts[i].x + pts[i + 1].x) / 2
          const yc = (pts[i].y + pts[i + 1].y) / 2
          path.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc)
        }
        path.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
        path.lineTo(W, baseY)
        path.lineTo(0, baseY)
        path.closePath()

        const grad = ctx.createLinearGradient(0, baseY - unit, 0, baseY)
        grad.addColorStop(0, hexA(ink.accent, topAlpha))
        grad.addColorStop(1, hexA(ink.accent, bottomAlpha))
        ctx.fillStyle = grad
        ctx.fill(path)

        if (stroke) {
          ctx.save()
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          // 先画一条更宽更淡的，算是廉价的发光
          ctx.strokeStyle = hexA(ink.accent, 0.16)
          ctx.lineWidth = lineWidth * 3
          ctx.stroke(path)
          ctx.strokeStyle = stroke
          ctx.lineWidth = lineWidth
          ctx.stroke(path)
          ctx.restore()
        }
      }

      if (variant === 'ribbon') {
        const layers = [
          { key: 'rib0', scale: 1, top: 0.02, bottom: 0.13, stroke: hexA(ink.accent, 0.26), rise: 0.42, fall: 0.9 },
          { key: 'rib1', scale: 0.72, top: 0.04, bottom: 0.24, stroke: hexA(ink.accent, 0.38), rise: 0.32, fall: 0.92 },
          { key: 'rib2', scale: 0.45, top: 0.08, bottom: 0.42, stroke: hexA(ink.soft, 0.6), rise: 0.24, fall: 0.94 },
        ]
        for (const l of layers) {
          const vals = smoothTo(l.key, bands(src, wn), l.rise, l.fall)
          fillWave(vals, gain, l.top, l.bottom, l.stroke, 1, l.scale)
        }
      } else {
        const vals = smoothTo('wave', bands(src, wn), 0.5, 0.8)
        fillWave(vals, gain, 0.02, 0.34, hexA(ink.soft, 0.9), 1.7)
      }

      ctx.fillStyle = ink.line
      ctx.globalAlpha = 0.5
      ctx.fillRect(0, H - 0.5, W, 1)
      ctx.globalAlpha = 1
      } finally {
        if (mirroredAxis) ctx.restore()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect() }
  }, [barWidth, gap, mirrored, maxBars, variant, vertical, flip, active])

  return (
    <div
      className={'spectrum ' + (className ?? '')}
      data-variant={variant}
      data-vertical={vertical ? 'true' : 'false'}
      data-flip={flip ? 'true' : 'false'}
      style={vertical ? undefined : { height }}
      aria-hidden="true"
    >
      <canvas ref={cvRef} className="spectrum-canvas" />
    </div>
  )
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h)
  ctx.beginPath()
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
  ctx.fill()
}

/** #RRGGBB / rgb() → rgba(...)；其它写法原样返回（浏览器会忽略非法 alpha 值） */
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
