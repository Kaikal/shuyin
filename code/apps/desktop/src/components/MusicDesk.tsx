/**
 * 音乐桌面：铺满主屏的「壁纸式」音乐屏。
 *
 * 它要解决的场景很具体：**听歌时把屏幕当成一张会呼吸的桌面背景**——
 * 大号时间、当前歌词、封面化开的色雾，控制条只在鼠标动的时候浮出来。
 *
 * 几条刻意的取舍：
 *   · 固定深色，不跟应用主题走。它替代的是壁纸，浅色背景上白字看不清、
 *     压暗又失去「壁纸」的通透，所以这里自己一套色板（--md-*）。
 *   · 背景取的是**封面**，不是主题色：壁纸要跟着这张专辑变。
 *     封面过 canvas 取一次主色（`accentOf`），提到 0.4 以上饱和度再铺成两团光。
 *   · 歌词逐字上色用两层文字 + `clip-path`：`background-clip:text` 的百分比
 *     没法过渡，clip-path 可以，250ms linear 正好接上 Rust 每 250ms 推的进度。
 *   · 控件 4 秒不动鼠标就淡出；双击背景回主窗口，Esc 收起（与播放页一致）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtTime } from '@shuyin/core'
import { musicDesk, type DeskData } from '../lib/musicDesk'
import { IconClose, IconNext, IconPause, IconPlay, IconPrev } from './icons'
import { Spectrum } from './Spectrum'

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 从封面里取两个「像这张专辑」的颜色（主色 + 偏移 26° 的第二色） */
function accentOf(url: string): Promise<{ a: string; b: string } | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const n = 18
        const c = document.createElement('canvas')
        c.width = n
        c.height = n
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, n, n)
        const d = ctx.getImageData(0, 0, n, n).data
        let r = 0, g = 0, b = 0, w = 0
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2]
          const l = R * 0.299 + G * 0.587 + B * 0.114
          // 近黑 / 近白像素不代表「这张封面是什么色调」（纯黑封面、白底封面都有），
          // 权重压到 0.12 而不是直接丢掉：全黑封面也得有个能用的底色
          const k = l < 24 || l > 236 ? 0.12 : 0.6 + Math.min(0.4, Math.abs(l - 128) / 320)
          r += R * k
          g += G * k
          b += B * k
          w += k
        }
        if (!w) return resolve(null)
        let rr = r / w / 255, gg = g / w / 255, bb = b / w / 255
        const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
        const l = (max + min) / 2
        let h = 0
        let s = 0
        if (max !== min) {
          const dd = max - min
          s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min)
          h = max === rr ? (gg - bb) / dd + (gg < bb ? 6 : 0)
            : max === gg ? (bb - rr) / dd + 2
              : (rr - gg) / dd + 4
          h *= 60
        }
        // 灰色封面（s≈0）也要有颜色：给一个低饱和的暖调，不要变成一块水泥
        const S = Math.round(Math.min(0.66, Math.max(0.34, s * 1.35 || 0.34)) * 100)
        const L = Math.round(Math.min(0.64, Math.max(0.4, l)) * 100)
        resolve({
          a: `hsl(${Math.round(h)} ${S}% ${L}%)`,
          b: `hsl(${Math.round((h + 26) % 360)} ${Math.max(20, S - 12)}% ${Math.max(26, L - 8)}%)`,
        })
      } catch {
        // canvas 被污染（封面来自不允许读像素的源）：退回中性色，不报错
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * `lock` = 这是「音乐锁屏」窗口（musiclock.html）而不是音乐桌面窗口。
 *
 * 两者是**完全独立的两个窗口**：锁屏不该顺手把桌面壁纸打开，桌面也不该被锁屏
 * 拔来拔去（v0.5.5 之前共用 musicdesk 窗口，开锁屏就等于开了桌面——用户报的就是这个）。
 * 同一个组件、同一份数据通道，只由入口页决定宿主的身份。
 */
export function MusicDeskWindow({ lock = false }: { lock?: boolean }) {
  const [data, setData] = useState<DeskData | null>(null)
  const [live, setLive] = useState({ playing: false, position: 0, duration: 0 })
  const [clock, setClock] = useState(() => new Date())
  /** 壁纸形态没有「模式」可选：封面 + 歌词 + 底部频谱，时钟只留给音乐锁屏 */
  const [accent, setAccent] = useState<{ a: string; b: string } | null>(null)
  /** 锁屏窗口恒为锁屏态；桌面窗口恒为壁纸态 */
  const lockMode = lock
  /** 控件是否浮出来（鼠标 4 秒不动就收起，壁纸不该一直挂着按钮） */
  const [chrome, setChrome] = useState(true)
  const hideTimer = useRef<number | null>(null)
  const posRef = useRef(0)

  posRef.current = live.position

  /* 窗口 → 数据 */
  useEffect(() => musicDesk.onData(setData), [])
  useEffect(() => musicDesk.onState(s => setLive(s)), [])

  /* 窗口刚起来：告诉主窗口「我准备好了」，让它把当前这首补推一次
     （窗口创建到 WebView 就绪之间，主窗口那一推是收不到的） */
  useEffect(() => {
    void musicDesk.action('ready')
  }, [])

  /* 时钟：对齐到下一个整秒再开始 tick，避免秒数跳得忽快忽慢 */
  useEffect(() => {
    let timer = 0
    const tick = () => {
      setClock(new Date())
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000))
    }
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000))
    return () => window.clearTimeout(timer)
  }, [])

  /* 换歌才重新取主色（同一首歌的封面不变） */
  const cover = data?.cover || ''
  useEffect(() => {
    setAccent(null)
    if (!cover) return
    let alive = true
    void accentOf(cover).then(c => { if (alive && c) setAccent(c) })
    return () => { alive = false }
  }, [cover])

  /* 频谱配色：把封面的 hsl 交给 canvas 归一成 #rrggbb 再写到 :root——
     Spectrum 内部的 hexA() 只认 #hex / rgb()，直接塞 hsl 会让它丢掉透明度。
     柱顶高亮用同色提亮一档：黑白封面取出来的主色偏灰，不提亮就是一排土黄柱子。 */
  useEffect(() => {
    const el = document.documentElement
    if (!accent) {
      el.style.removeProperty('--sy-accent')
      el.style.removeProperty('--sy-accent-soft')
      return
    }
    const cv = document.createElement('canvas').getContext('2d')
    const norm = (c: string) => {
      if (!cv) return c
      cv.fillStyle = '#000'
      cv.fillStyle = c
      return cv.fillStyle
    }
    /** 往白色混 k，做柱顶/高亮色（'#rrggbb' 入、'#rrggbb' 出） */
    const lift = (hex: string, k: number) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
      if (!m) return hex
      const n = parseInt(m[1], 16)
      const f = (v: number) => Math.round(v + (255 - v) * k)
      return '#' + [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
        .map(v => v.toString(16).padStart(2, '0')).join('')
    }
    const base = norm(accent.a)
    el.style.setProperty('--sy-accent', base)
    el.style.setProperty('--sy-accent-soft', lift(base, 0.42))
  }, [accent])

  const poke = useCallback(() => {
    setChrome(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setChrome(false), 4000)
  }, [])

  useEffect(() => {
    poke()
    return () => { if (hideTimer.current) window.clearTimeout(hideTimer.current) }
  }, [poke])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void musicDesk.action('close')
      } else if (e.key === ' ') {
        e.preventDefault()
        void musicDesk.action('playpause')
      } else if (e.key === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
        void musicDesk.action('next')
      } else if (e.key === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
        void musicDesk.action('prev')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const playing = live.playing || Boolean(data?.playing)
  const duration = live.duration || data?.duration || 0
  const position = Math.min(live.position || 0, duration || Number.MAX_SAFE_INTEGER)
  const pct = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0

  /** 当前歌词行：按 position 找最后一条 time <= position 的 */
  const { cur, next, fill, idx } = useMemo(() => {
    const lines = data?.lines ?? []
    if (!lines.length) return { cur: null, next: null, fill: 0, idx: -1 }
    let i = -1
    for (let k = 0; k < lines.length; k++) {
      if (lines[k].time <= position + 0.12) i = k
      else break
    }
    if (i < 0) return { cur: lines[0], next: lines[1] ?? null, fill: 0, idx: 0 }
    const start = lines[i].time
    const end = lines[i + 1]?.time ?? Math.max(start + 4, duration || start + 4)
    const p = end > start ? (position - start) / (end - start) : 1
    return { cur: lines[i], next: lines[i + 1] ?? null, fill: Math.min(1, Math.max(0, p)), idx: i }
  }, [data?.lines, position, duration])

  const hh = String(clock.getHours()).padStart(2, '0')
  const mm = String(clock.getMinutes()).padStart(2, '0')
  const ss = String(clock.getSeconds()).padStart(2, '0')
  const dateText = `${clock.getFullYear()} 年 ${clock.getMonth() + 1} 月 ${clock.getDate()} 日 · ${WEEK[clock.getDay()]}`

  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    void musicDesk.action('seek', { sec: ratio * duration })
  }

  const title = data?.title || ''
  const artist = data?.artist || ''

  /** 壁纸形态固定是「封面 + 歌词 + 底部频谱」；时钟只在音乐锁屏里出现 */
  const view: 'lyric' | 'clock' = lockMode ? 'clock' : 'lyric'

  /* 壁纸层收不到鼠标（图标层在它上面），所以壁纸形态**不画任何按钮**——
     画了就是「点了没反应」。控件只在音乐锁屏（置顶、可点击）里出现。 */
  const interactive = lockMode

  /* 歌词桌面的可视窗口：当前行居中偏下一点（眼睛看中央那句更自然），上下各两行 */
  const lines = data?.lines ?? []
  const lyrWin = useMemo(() => {
    if (idx < 0) return []
    const start = Math.max(0, idx - 2)
    return lines.slice(start, start + 5).map((_, k) => start + k)
  }, [lines, idx])

  return (
    <div
      className={'md-root' + (playing ? ' playing' : '')}
      data-mode={view}
      onMouseMove={poke}
      onDoubleClick={() => void musicDesk.action('open-main')}
      style={accent
        ? ({ ['--md-a' as never]: accent.a, ['--md-b' as never]: accent.b })
        : undefined}
    >
      {/* 三层背景：封面（模糊放大）+ 专辑色光雾 + 四周压暗。
          分开三层是为了让「换歌」时色雾能单独过渡，而不是整块重绘。 */}
      <div
        className={'md-bg' + (cover ? ' has' : '')}
        style={cover ? { backgroundImage: `url("${cover}")` } : undefined}
      />
      <div className="md-tint" aria-hidden="true" />
      <div className="md-vignette" aria-hidden="true" />

      {interactive && <header className={'md-top' + (chrome ? ' show' : '')}>
        <div className="md-brand">
          <b>疏音</b>
          <span>音乐锁屏</span>
        </div>
        <div className="md-tools">
          <button
            className="md-tool md-x"
            aria-label="收起音乐桌面"
            title="收起 (Esc)"
            onClick={() => void musicDesk.action('close')}
          >
            <IconClose width={15} height={15} />
          </button>
        </div>
      </header>}

      <main className="md-main" data-mode={view}>
        {view === 'lyric'
          ? (
            /* 壁纸形态：封面（清晰一张）+ 歌名 + 歌词。不要时间——桌面是「正在听什么」，
               不是钟；时间交给音乐锁屏。 */
            <>
              <div className={'md-art' + (cover ? ' has' : '')} aria-hidden="true">
                {cover ? <img src={cover} alt="" /> : <span className="md-art-empty" />}
              </div>
              <div className="md-song">
                {title ? `${title}${artist ? ` · ${artist}` : ''}` : '还没有在播放的歌 · 从「我的」里挑一首'}
              </div>
              <div className="md-lyr-stack">
                {lines.length
                  ? lyrWin.map(k => {
                    const line = lines[k]
                    if (k === idx) {
                      return (
                        <div className="md-k-line act" key={k}>
                          <span className="md-k-dim">{line.text}</span>
                          <span
                            className="md-k-hi"
                            style={{ clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)` }}
                          >
                            {line.text}
                          </span>
                        </div>
                      )
                    }
                    return <div className={'md-k-line ' + (k < idx ? 'past' : 'fut')} key={k}>{line.text}</div>
                  })
                  : <div className="md-k-line fut">{title || '等待播放…'}</div>}
              </div>
            </>
          )
          : (
            <>
              <div className="md-clock">
                <span className="md-hm num">{hh}:{mm}</span>
                <span className="md-sec num">{ss}</span>
              </div>
              <div className="md-date">{dateText}</div>

              <div className="md-lyric">
                {cur
                  ? (
                    <>
                      <div className="md-lyr-line active">
                        <span className="md-lyr-dim">{cur.text}</span>
                        <span
                          className="md-lyr-hi"
                          style={{ clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)` }}
                        >
                          {cur.text}
                        </span>
                      </div>
                      {next && <div className="md-lyr-line next">{next.text}</div>}
                    </>
                  )
                  : (
                    <div className="md-lyr-empty">
                      {title
                        ? title
                        : '还没有在播放的歌 · 从「我的」里挑一首'}
                    </div>
                  )}
              </div>
            </>
          )}
      </main>

      {/* 底部频谱：贴在最下方一条，只属于壁纸形态（音乐锁屏有控制条，不再挤一条）。
          颜色跟着封面主色走——Spectrum 从 :root 的 --sy-accent 读色，
          这个窗口独立渲染，写在这里不会影响主窗口。 */}
      {!lockMode && (
        <div className="md-spec">
          <Spectrum
            playing={playing}
            variant="bars"
            height={Math.max(72, Math.round(window.innerHeight * 0.11))}
            barWidth={6}
            gap={5}
            maxBars={220}
          />
        </div>
      )}

      {interactive && <footer className={'md-foot' + (chrome ? ' show' : '')}>
        <div className="md-progress" onClick={seekTo} role="presentation">
          <i style={{ width: `${pct * 100}%` }} />
          <b style={{ left: `${pct * 100}%` }} />
        </div>
        <div className="md-bar">
          <div className="md-now">
            {cover
              ? <img className="md-cover" src={cover} alt="" />
              : <span className="md-cover md-cover-empty" aria-hidden="true" />}
            <div className="md-now-txt">
              <div className="md-now-t" title={title}>{title || '未在播放'}</div>
              <div className="md-now-a" title={artist}>{artist || '疏音'}</div>
            </div>
          </div>

          <div className="md-ctl">
            <button className="md-btn" aria-label="上一首" onClick={() => void musicDesk.action('prev')}>
              <IconPrev width={17} height={17} />
            </button>
            <button
              className="md-btn md-play"
              aria-label={playing ? '暂停' : '播放'}
              onClick={() => void musicDesk.action('playpause')}
            >
              {playing ? <IconPause width={19} height={19} /> : <IconPlay width={19} height={19} />}
            </button>
            <button className="md-btn" aria-label="下一首" onClick={() => void musicDesk.action('next')}>
              <IconNext width={17} height={17} />
            </button>
          </div>

          <div className="md-times num">
            {fmtTime(position)}{duration ? ` / ${fmtTime(duration)}` : ''}
          </div>
        </div>
        <div className="md-hint">双击回到疏音 · Esc 收起 · 空格播放 / 暂停</div>
      </footer>}
    </div>
  )
}
