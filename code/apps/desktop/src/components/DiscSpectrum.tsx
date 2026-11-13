/**
 * 唱片外圈的环形频谱（手机播放页，开「频谱可视化」时顶替黑胶纹路那一圈黑）。
 *
 * 为什么另起一个组件、不复用 `Spectrum`：
 *   · `Spectrum` 是**横向条带**，坐标系从左边基线往右排；硬转 90° 只能做一条边，
 *     做不了「绕圆一圈、从内向外长」；
 *   · 这里要的是极坐标：每根柱子一个角度，半径从标签外缘（0.33R）长到 0.9R。
 *   · 取数、平滑、增益这一套逻辑和 `Spectrum` 一样（同一个 `bridge.spectrum()`），
 *     所以视觉上两边是一回事，只是坐标系不同。
 *
 * 数据是真的：安卓侧 `PlaybackService` 用 `Visualizer` 绑在 MediaPlayer 的
 * audioSessionId 上取 FFT（见 Kotlin 里的 `fillBands`）。没授 RECORD_AUDIO
 * 时它恒回 40 个 0，这里就画一圈贴底的短柱——能看出「开了但没数据」，
 * 而不是整块消失。
 */
import { useEffect, useRef } from 'react'
import { bridge } from '../lib/bridge'
import type { SpectrumStyle } from '../lib/spectrumStyle'

/** 一圈多少根：88 根在 364px 的盘上间距约 9px，再密就糊成一条环 */
const BARS = 88

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

/** 低频能量高、高频低：不抬右边这圈会一边高一边平 */
function lift(src: number[], n: number): number[] {
  const out = resample(src, n)
  for (let i = 0; i < n; i++) {
    const k = 1 + 0.75 * (i / Math.max(1, n - 1))
    out[i] = Math.min(1, (out[i] ?? 0) * k)
  }
  return out
}

/**
 * 把极坐标采样点连成一条平滑闭合曲线。
 * 中点二次曲线（每个点当控制点、相邻中点当端点）比直线连点圆滑，
 * 首尾自动接上，整圈不会有接缝。
 */
function curvePath(pts: Array<[number, number]>): Path2D {
  const p = new Path2D()
  const m = pts.length
  if (!m) return p
  p.moveTo((pts[0][0] + pts[m - 1][0]) / 2, (pts[0][1] + pts[m - 1][1]) / 2)
  for (let i = 0; i < m; i++) {
    const c = pts[i]
    const n = pts[(i + 1) % m]
    p.quadraticCurveTo(c[0], c[1], (c[0] + n[0]) / 2, (c[1] + n[1]) / 2)
  }
  p.closePath()
  return p
}

function accentRgb(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sy-accent').trim()
  const hex = /^#?([0-9a-f]{6})$/i.exec(raw)
  if (hex) {
    const v = parseInt(hex[1], 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(raw)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return [110, 139, 255]
}

export function DiscSpectrum({ playing, active = true, variant = 'bars' }: {
  playing: boolean
  active?: boolean
  /**
   * 频谱样式，和桌面 / 设置页共用同一份选择（lib/spectrumStyle）。
   *
   * 环上本来只有「柱」这一种画法——用户于是觉得「换样式没反应」。
   * 这里把 88 个频段按极坐标重新画成六种：柱 / 电平表 / 点阵 / 镜像 /
   * 音浪 / 丝带。数据、平滑、增益全是同一套，只有几何不同。
   */
  variant?: SpectrumStyle
}) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const target = useRef<number[]>([])
  const smooth = useRef<number[]>([])
  const peak = useRef(0.3)
  /* 绘制循环只跑一次（[] 依赖），拿不到 props 的最新值：暂停要冻结呼吸环，
     所以用一个 ref 每次渲染同步过去 */
  const playingRef = useRef(playing)
  playingRef.current = playing

  /* 取数：播放中 70ms 一次；暂停后目标归零，由绘制循环自然衰减 */
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
    const id = window.setInterval(pull, 70)
    return () => { stopped = true; window.clearInterval(id) }
  }, [playing])

  useEffect(() => {
    /*
     * 不在这一页时**彻底不画**。
     * 封面页被歌词页盖住之后，这块 canvas 依然每 28ms 重绘 88 根柱子——
     * 实测把整页的帧率从 120fps 拖到 25fps，用户在歌词页拖动就是「卡卡的」。
     * 停掉 rAF 之后同一段拖动全程 ≤18ms/帧。
     */
    if (!active) return
    const cv = cvRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    let raf = 0
    let last = 0
    let [ar, ag, ab] = accentRgb()

    const mo = new MutationObserver(() => { [ar, ag, ab] = accentRgb() })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })

    /*
     * 画布尺寸**只在 ResizeObserver 回调里读一次**，绘制循环里不再碰
     * getBoundingClientRect。
     *
     * 这里以前是每帧读一次 r.width/r.height：读布局 = 强制样式/布局同步，
     * 只要这一帧里别处动过 DOM（进度条宽度、歌词高亮、切页动画都算），
     * 浏览器就要在绘制前插一次整页 reflow。35fps 的循环配 35 次强制布局，
     * 表现出来就是「什么都卡一下」。
     */
    let cw = 0
    let ch = 0

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

    /** 连续多少帧一条数据都没有（判「系统没给频谱」） */
    let idleFrames = 0

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      if (t - last < 28) return
      last = t
      const W = cw
      const H = ch
      if (W < 8 || H < 8) return
      ctx.clearRect(0, 0, W, H)

      const cx = W / 2
      const cy = H / 2
      const R = Math.min(W, H) / 2
      /*
       * 跑道就是**黑胶纹路那一圈**：标签直径 68%（半径 0.34R），
       * 频谱从 0.70R 起跳、最长顶到 0.935R（留给盘沿一点余量）。
       *
       * 标签从 58% 放大到 68% 之后，这圈只剩 0.265R 宽——柱子自然就短了，
       * 正好对上用户那句「黑圈窄一些、封面大一些，顺带把频谱柱子弄短一些」。
       * 早先按 0.33R 起跳，结果整圈柱子一半藏在封面下面、又被推到盘外，
       * 看着像封面周围炸开一圈光刺——用户要的是「黑圈换成频谱」，不是加个光环。
       */
      const r0 = R * 0.7
      const room = R * 0.235

      const src = lift(target.current, BARS)
      if (smooth.current.length !== BARS) smooth.current = src.slice()
      const cur = smooth.current

      /*
       * 退化判定。两种都算「这台机器没给可用频谱」：
       *   · 一帧数据都没有（全 0）；
       *   · 整圈几乎全顶满——这块 ROM 的 FFT 标定把整段压成了 0 dB 附近
       *     （实测 1024 字节里 max=0、min=-9），按 dB 解出来就是 40 段恒为 1，
       *     画成一圈死金环，比没有更糟。
       *
       * **只看原始数据**：拿已经画出去的 `cur` 判的话，呼吸环自己会被当成「有数据」，
       * idle 反复开关——表现是偶尔蹿高一圈、多数时候只剩贴底的一圈小毛刺
       * （就是这么被坑了一轮）。
       */
      let rawMax = 0
      let hot = 0
      for (let i = 0; i < BARS; i++) {
        const s = src[i] ?? 0
        if (s > rawMax) rawMax = s
        if (s > 0.97) hot++
      }
      const degenerate = rawMax < 0.01 || hot > BARS * 0.8
      if (degenerate) idleFrames++
      else idleFrames = 0
      const idle = idleFrames > 45

      let frameMax = 0
      for (let i = 0; i < BARS; i++) {
        const tgt = src[i] ?? 0
        const now = cur[i] ?? 0
        cur[i] = tgt > now ? now + (tgt - now) * 0.55 : now * 0.86
        if (cur[i] > frameMax) frameMax = cur[i]
      }
      /*
       * 长时间没有可用数据：这台机器系统层没把音频输出开放给 Visualizer。
       * 这时候**不能**让环变成一圈等长的短线——看着就像「开了但坏了」。
       * 改成一条缓慢起伏的呼吸环：明显不是频谱（幅度小、节奏是固定的正弦），
       * 但看得出「这个东西是活的」。
       */
      if (idle) {
        /* 暂停就把相位钉住：音乐停了环还在呼吸，看着像「还在响」 */
        const ph = playingRef.current ? t / 950 : 1.2
        for (let i = 0; i < BARS; i++) {
          /* 幅度要**看得出是一圈环**：太短就只剩标签外沿的一圈小毛刺，
             在缩略图里等于没有（实测 0.07~0.135 打出来只有 8px） */
          cur[i] = 0.24 + 0.26 * (0.5 + 0.5 * Math.sin(ph + (i / BARS) * Math.PI * 4))
        }
        frameMax = 0.5
      }
      /* 自动增益：安静段落整圈贴底会像「没开」，但放得太狠又会整圈顶满
         （实测 gain 放到 2.4 时 40 段里八成撞上 1.0，看着就是一圈等长的梳子）。 */
      peak.current = Math.max(peak.current * 0.982, frameMax)
      const gain = idle ? 1 : Math.min(1.6, 0.85 / Math.max(0.35, peak.current))

      const step = (Math.PI * 2) / BARS
      /* 线宽按周长算：盘大时柱子跟着粗，密度不变 */
      const lw = Math.max(1.8, (Math.PI * 2 * r0) / BARS * 0.42)
      const ink = (alpha: number) => `rgba(${ar},${ag},${ab},${alpha})`
      const shine = (alpha: number) =>
        `rgba(${Math.min(255, ar + 40)},${Math.min(255, ag + 40)},${Math.min(255, ab + 40)},${alpha})`
      /** 第 i 根柱子、半径 rr 处的坐标（12 点方向起，顺时针） */
      const at = (i: number, rr: number): [number, number] => {
        const a = -Math.PI / 2 + i * step
        return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]
      }
      /** 归一化后的柱高：留一点底，安静段落也看得出「这里有一圈」 */
      const val = (i: number) => Math.max(0.015, Math.min(1, (cur[i] ?? 0) * gain))

      /* 基线一圈：静音段落整圈柱子都贴底时，没有它就看不出「这里本来有一圈频谱」 */
      ctx.lineCap = 'butt'
      ctx.strokeStyle = ink(0.09)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, r0, 0, Math.PI * 2)
      ctx.stroke()

      if (variant === 'wave' || variant === 'ribbon') {
        /*
         * 音浪 / 丝带：88 个采样点连成一条平滑闭合曲线。
         * 环上没有「左边基线」可用，用中点二次曲线串起来、首尾自动接上，
         * 整圈才不会有接缝。丝带是三圈不同长度的曲线叠着，看着有流动感。
         */
        const layers = variant === 'ribbon'
          ? [
              { off: 0, scale: 1, alpha: 0.24 },
              { off: 0.2, scale: 0.72, alpha: 0.4 },
              { off: 0.36, scale: 0.46, alpha: 0.58 },
            ]
          : [{ off: 0, scale: 1, alpha: 0.85 }]
        for (const l of layers) {
          const pts: Array<[number, number]> = []
          for (let i = 0; i < BARS; i++) {
            pts.push(at(i, r0 + (l.off + Math.pow(val(i), 0.72) * l.scale) * room))
          }
          const path = curvePath(pts)
          if (variant === 'wave') {
            /* 曲线与基线之间垫一层淡色：环内是黑胶/封面，不能整块填 */
            const ring = new Path2D()
            ring.arc(cx, cy, r0, 0, Math.PI * 2)
            const area = new Path2D()
            area.addPath(path)
            area.addPath(ring)
            ctx.fillStyle = ink(0.14)
            ctx.fill(area, 'evenodd')
            ctx.strokeStyle = shine(l.alpha)
            ctx.lineWidth = 1.6
          } else {
            ctx.strokeStyle = ink(l.alpha)
            ctx.lineWidth = 1.3
          }
          ctx.lineJoin = 'round'
          ctx.stroke(path)
        }
      } else if (variant === 'meter' || variant === 'dots') {
        /*
         * 电平表 / 点阵：沿半径分三档。
         * 每档路径先攒在一个 Path2D 里再一次性描边——88 根 × 3 档逐根画
         * 是 264 次 draw call，28ms 一帧的预算吃不下。
         */
        const rows = 3
        const paths = Array.from({ length: rows }, () => new Path2D())
        for (let i = 0; i < BARS; i++) {
          const v = val(i)
          const len = lw * 0.6 + v * room
          for (let j = 0; j < rows; j++) {
            const f0 = (j / rows) * len
            const f1 = ((j + 1) / rows) * len - Math.max(0.6, len * 0.06)
            if (f1 <= f0) continue
            if (variant === 'meter') {
              const [ax, ay] = at(i, r0 + f0 + lw * 0.35)
              const [bx, by] = at(i, r0 + f1)
              paths[j].moveTo(ax, ay)
              paths[j].lineTo(bx, by)
            } else {
              const [dx, dy] = at(i, r0 + (f0 + f1) / 2)
              const rr = Math.max(1, lw * 0.22)
              paths[j].moveTo(dx + rr, dy)
              paths[j].arc(dx, dy, rr, 0, Math.PI * 2)
            }
          }
        }
        const alphas = [0.24, 0.46, 0.82]
        ctx.lineCap = 'butt'
        for (let j = 0; j < rows; j++) {
          if (variant === 'meter') {
            ctx.strokeStyle = j === rows - 1 ? shine(alphas[j]) : ink(alphas[j])
            ctx.lineWidth = Math.max(1.2, lw * 0.62)
            ctx.stroke(paths[j])
          } else {
            ctx.fillStyle = ink(alphas[j])
            ctx.fill(paths[j])
          }
        }
      } else if (variant === 'mirror') {
        /* 镜像：以基线圈为轴，里面短一截、外面长一截，整圈像被拉宽了一层 */
        ctx.lineCap = 'round'
        for (let i = 0; i < BARS; i++) {
          const v = val(i)
          const len = lw * 0.6 + v * room
          const [ax, ay] = at(i, r0 - len * 0.32)
          const [bx, by] = at(i, r0 + len)
          ctx.strokeStyle = ink(0.14 + 0.62 * v)
          ctx.lineWidth = lw
          ctx.beginPath()
          ctx.moveTo(ax, ay)
          ctx.lineTo(bx, by)
          ctx.stroke()
        }
      } else {
        /* bars（默认）：从基线圈向外生长的柱子，柱顶一点高光 */
        ctx.lineCap = 'round'
        for (let i = 0; i < BARS; i++) {
          const v = val(i)
          const len = lw * 0.6 + v * room
          const [ax, ay] = at(i, r0)
          const [bx, by] = at(i, r0 + len)
          ctx.strokeStyle = ink(0.28 + 0.62 * v)
          ctx.lineWidth = lw
          ctx.beginPath()
          ctx.moveTo(ax, ay)
          ctx.lineTo(bx, by)
          ctx.stroke()
          if (len > lw * 2.2) {
            const [hx, hy] = at(i, r0 + len - lw * 1.1)
            ctx.strokeStyle = shine(0.5 * v)
            ctx.lineWidth = Math.max(1.2, lw * 0.42)
            ctx.beginPath()
            ctx.moveTo(hx, hy)
            ctx.lineTo(bx, by)
            ctx.stroke()
          }
        }
      }
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect() }
  }, [active, variant])

  return <canvas ref={cvRef} className="imm-disc-spec" aria-hidden="true" />
}
