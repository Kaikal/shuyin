/**
 * 沉浸式歌词舞台（Folia 风格的全屏歌词）。
 *
 * 和「一列行在滚动」的普通歌词（LyricsView）是两种东西：
 *   · 当前句被拆成一个个「字」，每个字唱到的瞬间从雾里弹出、落到自己的位置
 *   · 每个字有固定的随机偏移 / 旋转 / 缩放（按行起始时间做种子，同一句不会每帧乱跳），
 *     所以一句歌词不是规整的一行，而是微错落的文字排版——这是 Folia 最像「文字 PV」的地方
 *   · 唱过的字落回常态并带一点余辉，正在唱的那个字是强调色 + 强辉光
 *   · 整行有缓慢的呼吸浮动，背景光晕随播放进度漂移
 *
 * 仿的是 Folia（github.com/chthollyphile/folia-major）的 classic / 流光模式：
 * 三态 waiting → active → passed，active 用弹性曲线弹出（spring 观感）。
 *
 * 流畅度（v0.1.9 专门修过一轮）：
 *   · 位置快照 250ms 一跳，直接拿它推进状态会「一顿一顿」——这里用 useSmoothTime
 *     插值到 16Hz，字亮起的时刻才和歌对得上
 *   · waiting 态不再用 filter: blur（WebView2 在软件渲染下逐字虚化非常贵），
 *     改成纯 opacity + transform，合成器只做位移和透明度
 *   · 前后句的 JSX 用 useMemo 锁住，只有换句时才重建
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LyricsDoc } from '@shuyin/core'
import { IconRefresh } from './icons'
import { LyricSearchForm } from './LyricSearchForm'
import { lyricsLookDef, useLyricsLook } from '../lib/lyricsLook'
import { indexAt, lineSpan, useSmoothTime } from '../lib/smoothClock'
import { visualWidth } from '../lib/textFit'

interface Props {
  doc: LyricsDoc | null
  loading: boolean
  currentTime: number
  /** 0~1，驱动背景光晕漂移 */
  progress?: number
  onSeek?(t: number): void
  /** 点了「在线搜索歌词」并提交歌名/歌手后才触发：q 是用户改过的关键词 */
  onSearchOnline?(q: { title: string; artist: string }): void
  /** 预填到搜索框里的当前曲目信息 */
  trackTitle?: string
  trackArtist?: string
}

/** 用户滚轮翻歌词后，多久回到「跟随当前句」 */
const HOLD_MS = 3200

/** 攒够这么多 deltaY 才算翻一句：触摸板一次手势会发几十个 3~8 的小值 */
const WHEEL_STEP = 56

/** 拉丁字母/数字连成一个「字」，中文逐字拆——和 Folia 的分词结果观感一致 */
const LATIN = /[A-Za-z0-9'’\-.]/

function splitUnits(text: string): string[] {
  const out: string[] = []
  let buf = ''
  for (const ch of text) {
    if (LATIN.test(ch)) {
      buf += ch
      continue
    }
    if (buf) { out.push(buf); buf = '' }
    out.push(ch)
  }
  if (buf) out.push(buf)
  return out
}

/** LRC 时间 → 3:07 / 1:02:33（小时位只在真的需要时出现） */
function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return ''
  const t = Math.floor(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 确定性伪随机：同一句（同一 time）每次渲染都得到同样的错落，不会抖 */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export function FoliaLyrics({ doc, loading, currentTime, progress = 0, onSeek, onSearchOnline, trackTitle, trackArtist }: Props) {
  const [lookId] = useLyricsLook()
  const look = lyricsLookDef(lookId)
  const boxRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 900, h: 420 })
  /** 滚轮临时偏移（正 = 往后看） */
  const [off, setOff] = useState(0)
  /** 空态里「在线搜索歌词」点开后才显示歌名/歌手输入框 */
  const [searching, setSearching] = useState(false)
  const holdRef = useRef(0)
  /** 还没凑满一句的滚轮残余：见 onWheel 的累积 */
  const wheelAcc = useRef(0)

  /* 250ms 的台阶插值成连续时间：字亮起的时机跟着歌走，而不是跟着快照走 */
  const now = useSmoothTime(currentTime, 16)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => () => window.clearTimeout(holdRef.current), [])

  const lines = doc?.lines ?? []

  const active = useMemo(() => (lines.length ? indexAt(lines, now) : -1), [lines, now])

  /** 前奏还没到第一句时，先把第一句当焦点，画面不至于空着 */
  const focus = active >= 0 ? active : (lines.length ? 0 : -1)

  /*
   * 视图中心 = 播放句 + 滚轮偏移。
   * v0.1.9 修掉的 bug：以前滚轮只改「周围显示哪些行」，大字永远钉在播放句上，
   * 用户滚半天画面不动，还以为滚轮坏了。现在翻到哪句，哪句就到中央当大字，
   * 播放句按距离排到前后，过几秒自动回到播放句。
   */
  const viewIndex = Math.max(0, Math.min(lines.length - 1, focus + off))

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!lines.length) return
    /*
     * 三个坑，一次修完：
     * 1. deltaMode：行模式（1）/ 页模式（2）的数值和像素模式（0）不是一个量纲，先归一成像素
     * 2. 累积步进：触摸板和高精度鼠标一次手势会发几十个 3~8 的小 deltaY，
     *    按「事件个数」翻页会让偏移瞬间打满，看起来像滚轮失控
     * 3. 翻完后不自动清零：偏移停留几秒让用户看清，再由下面的 HOLD 定时器收回
     */
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
    wheelAcc.current += dy
    let steps = 0
    while (Math.abs(wheelAcc.current) >= WHEEL_STEP) {
      const s = wheelAcc.current > 0 ? 1 : -1
      steps += s
      wheelAcc.current -= s * WHEEL_STEP
    }
    if (!steps) return
    setOff(v => Math.max(-5, Math.min(5, v + steps)))
    window.clearTimeout(holdRef.current)
    holdRef.current = window.setTimeout(() => setOff(0), HOLD_MS)
  }, [lines.length])

  /* 基准字号：跟着窗口长，窄窗收一档，别让一句 20 字直接顶出画面 */
  const base = Math.max(24, Math.min(72, Math.min(box.w * 0.062, box.h * 0.15)))
  const gap = base * look.gap
  const avail = Math.max(240, box.w * 0.9)

  const cur = viewIndex >= 0 ? lines[viewIndex] : undefined
  const curText = cur?.text || ' '
  const units = useMemo(() => splitUnits(curText), [curText])

  /** 唱到第几个字：LRC 只有整行时间，按字数均分 */
  let activeUnit = -1
  if (cur && cur.time >= 0 && units.length) {
    const total = Array.from(curText).length
    const nx = lines[viewIndex + 1]
    const span = lineSpan(total, cur.time, nx ? nx.time : 0, 0)
    if (viewIndex === active) {
      const ratio = Math.min(1, Math.max(0, (now - cur.time) / span))
      activeUnit = Math.min(units.length - 1, Math.floor(ratio * total))
    } else {
      // 翻到了别的句子：按播放位置判「这句已经唱完」还是「还没唱到」
      activeUnit = now >= cur.time + span ? units.length : -1
    }
  }

  /*
   * 一句放不下就整体收字号；长句收得更多，短句贴到 ~90% 宽。
   * 下限从 0.52 放到 0.30：以前一句 30 多字只能收到 0.52，
   * 结果还是比容器宽，直接顶出屏幕。收到 0.3 再加允许换行（见 .folia-line），
   * 极端长句也不会跑出窗口。
   */
  const fit = Math.min(1, Math.max(0.3, avail / Math.max(1, visualWidth(curText) * base * 1.05)))
  const size = Math.round(base * fit)
  const spread = Math.min(16, Math.max(5, size * 0.18))

  const rows = useMemo(() => {
    if (focus < 0) return []
    const from = Math.max(0, viewIndex - look.span)
    const to = Math.min(lines.length - 1, viewIndex + look.span)
    const out: number[] = []
    for (let i = from; i <= to; i++) if (i !== viewIndex) out.push(i)
    return out
  }, [viewIndex, lines.length, look.span])

  /* 前后句只在换句 / 改窗口尺寸时重建：它们在动画里只是淡入淡出，不需要逐帧参与 */
  const chorus = useMemo(() => rows.map(i => {
    const l = lines[i]
    const d = i - viewIndex
    const k = Math.min(Math.abs(d), 2)
    const text = l.text || ' '
    const f = Math.min(1.2, Math.max(0.34, (avail * 0.72) / Math.max(1, visualWidth(text) * base)))
    return (
      <div
        key={i}
        className="fline"
        style={{
          fontSize: base,
          fontWeight: look.weight,
          letterSpacing: look.tracking,
          opacity: look.opacity[k - 1],
          filter: look.blur[k - 1] ? `blur(${look.blur[k - 1]}px)` : undefined,
          transform: `translate(0, calc(-50% + ${d * gap}px)) rotateX(${d * look.tilt}deg) scale(${look.scale[k - 1] * f})`,
          zIndex: 6 - Math.abs(d),
        }}
        onClick={() => { if (l.time >= 0) onSeek?.(l.time) }}
      >
        {text}
      </div>
    )
  }), [rows, lines, viewIndex, base, gap, avail, look, onSeek])

  /* 逐字：偏移/旋转按行时间 + 序号做种子，同一句永远同一套错落 */
  const chars = useMemo(() => units.map((u, i) => {
    const seed = (cur?.time ?? 0) + i * 3.77
    return {
      u,
      dx: Math.round((rand(seed) - 0.5) * spread * 2 * 10) / 10,
      dy: Math.round((rand(seed + 1) - 0.5) * spread * 1.5 * 10) / 10,
      rot: Math.round((rand(seed + 2) - 0.5) * 9 * 10) / 10,
      sc: Math.round((1.03 + rand(seed + 3) * 0.13) * 100) / 100,
      rp: Math.round((rand(seed + 4) - 0.5) * 30),
    }
  }), [units, cur?.time, spread])

  /* hooks 全部走完了，下面才可以写条件 return（React #310 的教训） */
  if (loading) {
    return <div className="folia" ref={boxRef}><div className="folia-empty">正在读取歌词…</div></div>
  }
  if (!lines.length) {
    return (
      <div className="folia" ref={boxRef}>
        <div className="folia-empty">
          <div className="t">暂无歌词</div>
          <div className="s">已检查同名 .lrc 文件与内嵌歌词标签</div>
          {onSearchOnline && (searching ? (
            /* 点了「在线搜索歌词」才展开：歌名 / 歌手都能改，预填当前曲目 */
            <LyricSearchForm
              title={trackTitle ?? ''}
              artist={trackArtist ?? ''}
              onSubmit={q => { setSearching(false); onSearchOnline(q) }}
              onCancel={() => setSearching(false)}
            />
          ) : (
            <button className="ghost-btn" onClick={() => setSearching(true)}>
              <IconRefresh width={13} height={13} /> 在线搜索歌词
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className="folia"
      ref={boxRef}
      data-look={look.id}
      data-fx="folia"
      data-scrolling={off !== 0 ? 'true' : 'false'}
      onWheel={onWheel}
    >
      <div className="folia-aura" aria-hidden="true" style={{ ['--fl-prog' as never]: Math.min(1, Math.max(0, progress)) }}>
        <i className="folia-blob a" />
        <i className="folia-blob b" />
      </div>
      <div className="folia-beam" aria-hidden="true" />

      <div className="folia-stage">
        {chorus}

        {/* 当前句：每个字自己飞进来，唱到哪亮到哪 */}
        <div className="folia-cur">
          <div
            className="folia-line"
            data-prelude={activeUnit < 0 ? 'true' : undefined}
            style={{
              fontSize: size,
              fontWeight: look.weight,
              letterSpacing: look.tracking,
            }}
            onClick={() => { if (cur && cur.time >= 0) onSeek?.(cur.time) }}
          >
            {chars.map((c, i) => {
              const s = i < activeUnit ? 'passed' : i === activeUnit ? 'active' : 'waiting'
              return (
                <span
                  key={i}
                  className="fw"
                  data-s={s}
                  style={{
                    ['--tx' as never]: c.dx + 'px',
                    ['--ty' as never]: c.dy + 'px',
                    ['--rot' as never]: c.rot + 'deg',
                    ['--sc' as never]: c.sc,
                    ['--rp' as never]: c.rp + 'deg',
                  }}
                >{c.u}</span>
              )
            })}
          </div>
        </div>

        {/*
         * 时间列单独一层：不能塞进 .fline 里——每行都带 scale / rotateX，
         * 时间戳会跟着缩放漂移，长句还会把它顶到屏幕外。
         * 这里用和行完全相同的 y 公式（48% + d*gap），左右就对齐了。
         */}
        {cur && cur.time >= 0 && (
          <span className="folia-time" style={{ top: '48%' }} aria-hidden="true">{clock(cur.time)}</span>
        )}
        {rows.map(i => (
          <span
            key={'t' + i}
            className="fline-time"
            style={{ top: `calc(48% + ${(i - viewIndex) * gap}px)` }}
            aria-hidden="true"
          >{clock(lines[i].time)}</span>
        ))}
      </div>

      <div className="folia-foot">
        {doc?.source === 'lrc' ? '本地 .lrc' : doc?.source === 'embedded' ? '内嵌歌词' : doc?.source === 'online' ? '在线歌词 · lrclib' : ''}
      </div>
    </div>
  )
}
