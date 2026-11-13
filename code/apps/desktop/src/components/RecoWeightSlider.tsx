/**
 * 「为你推荐」各平台的配比滑块。
 *
 * 一根条分给 N 家（登录了几家就几块），每条分割线都能拖；拖一条线，
 * 只是把**它左右两家的首数**互相倒一点，总首数恒定——这就是用户说的
 * 「拖动调整数量，总数不变」。
 *
 * 为什么不是 N 个独立的档位按钮：
 *   档位的组合空间是 5^4，用户想「网易云多一点、QQ 少一点」时得试好几遍
 *   才对得上总数；滑块一眼就能看出「现在 10/8/8/6」，拖一下就到位。
 *
 * 手势注意：
 *   · 把手（`.reco-sl-h`）上 `touch-action: none`，否则拖动会被当成滚页面
 *     （这条坑在歌单排序上踩过一次，见 MEMORY）；
 *   · 拖动中只改本地草稿，**松手才提交**：每次提交都会重算一批推荐，
 *     跟着 move 提交等于拖一下打十几次平台请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlatformSource } from '@shuyin/lx-provider'
import { platformName, type RecoWeights } from '../lib/online'

/** 每家至少留 1 首：0 首的段宽度会变成 0，用户就再也拖不回来了 */
const MIN_PER = 1
/** 没调过的平台默认出几首（和 `DEFAULT_RECO_WEIGHTS` 一致） */
const DEFAULT_PER = 8

/**
 * 条上用的短名。
 *
 * 一段被拖到 4 首时宽度只有 40px，「QQ音乐」会被裁成「QQ…」；
 * 写「QQ」刚好三格字，四家都是 2~3 字，窄段也读得出来。
 */
const SHORT_NAME: Partial<Record<PlatformSource, string>> = {
  wy: '网易云', tx: 'QQ', kg: '酷狗', kw: '酷我', mg: '咪咕',
}
const labelOf = (s: PlatformSource) => SHORT_NAME[s] ?? platformName(s)

interface Props {
  /** 参与混排的平台（已登录 / 免登录的那几家），顺序决定左右 */
  platforms: PlatformSource[]
  /** 这一批的总首数 = 平台数 × 8，恒定 */
  total: number
  value: RecoWeights
  onChange(next: RecoWeights): void
}

/** 把任意历史值收拾成「N 段、每段 ≥1、总和正好 total」 */
function normalize(platforms: PlatformSource[], total: number, value: RecoWeights): number[] {
  const n = platforms.length
  if (n === 0) return []
  const segs = platforms.map(s => {
    const v = value[s]
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(MIN_PER, Math.round(v)) : DEFAULT_PER
  })
  /* 段数比总首数还多是不可能的（total = 8n），但 total 传错时要能兜住 */
  const floor = n * MIN_PER
  const cap = Math.max(total, floor)
  let sum = segs.reduce((a, b) => a + b, 0)
  let guard = 0
  while (sum !== cap && guard++ < 512) {
    if (sum > cap) {
      /* 从最大的那段里减，视觉上不会突然把某一家的条压没 */
      let idx = -1
      for (let i = 0; i < segs.length; i++) {
        if (segs[i] > MIN_PER && (idx < 0 || segs[i] > segs[idx])) idx = i
      }
      if (idx < 0) break
      segs[idx] -= 1
      sum -= 1
    } else {
      let idx = 0
      for (let i = 1; i < segs.length; i++) if (segs[i] < segs[idx]) idx = i
      segs[idx] += 1
      sum += 1
    }
  }
  return segs
}

export function RecoWeightSlider({ platforms, total, value, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  /** 拖动中的草稿；null = 没在拖，显示外部值 */
  const [draft, setDraft] = useState<number[] | null>(null)
  const draftRef = useRef<number[] | null>(null)
  const dragRef = useRef<{ i: number; rect: DOMRect } | null>(null)

  const base = useMemo(() => normalize(platforms, total, value), [platforms, total, value])
  const segs = draft ?? base

  /* 外部值变了（换平台 / 提交完）就把草稿扔掉，否则界面会停在旧配比上 */
  useEffect(() => { draftRef.current = null; setDraft(null) }, [base])

  const commit = useCallback((next: number[]) => {
    const out: RecoWeights = {}
    platforms.forEach((s, i) => { out[s] = next[i] })
    onChange(out)
  }, [platforms, onChange])

  /** 累计边界：第 i 条线左边的总首数 */
  const bounds = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (let i = 0; i < segs.length - 1; i++) {
      acc += segs[i]
      out.push(acc)
    }
    return out
  }, [segs])

  const start = (i: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    const host = hostRef.current
    if (!host) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = { i, rect: host.getBoundingClientRect() }
    draftRef.current = segs
    setDraft(segs)
  }

  const move = (i: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    const cur = draftRef.current
    if (!d || d.i !== i || !cur) return
    e.preventDefault()

    const { rect } = d
    if (rect.width <= 0) return
    /* 手指位置 → 落在第几首：按整数吸附，条上写的就是结果 */
    let pos = Math.round(((e.clientX - rect.left) / rect.width) * total)

    const prevB = i === 0 ? 0 : cur.slice(0, i).reduce((a, b) => a + b, 0)
    const nextB = i === cur.length - 2 ? total : prevB + cur[i] + cur[i + 1]
    const lo = prevB + MIN_PER
    const hi = nextB - MIN_PER
    if (hi < lo) return
    pos = Math.min(hi, Math.max(lo, pos))

    /* 只动相邻两段：总和恒定，别的段一根像素都不跳 */
    const next = [...cur]
    next[i] = pos - prevB
    next[i + 1] = nextB - pos
    if (next[i] === cur[i] && next[i + 1] === cur[i + 1]) return
    draftRef.current = next
    setDraft(next)
  }

  const end = () => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    dragRef.current = null
    const n = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (n) commit(n)
  }

  /** 键盘：方向键一格一首（桌面 / 无障碍都能用） */
  const key = (i: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const prevB = i === 0 ? 0 : segs.slice(0, i).reduce((a, b) => a + b, 0)
    const nextB = i === segs.length - 2 ? total : prevB + segs[i] + segs[i + 1]
    const pos = prevB + segs[i] + dir
    if (pos < prevB + MIN_PER || pos > nextB - MIN_PER) return
    const next = [...segs]
    next[i] = pos - prevB
    next[i + 1] = nextB - pos
    commit(next)
  }

  if (platforms.length === 0 || total <= 0) return null

  return (
    <div
      className="reco-sl"
      ref={hostRef}
      role="group"
      aria-label="各平台推荐首数"
      /* 面板打开时把焦点落在这条上（Modal 认这个属性）：落在关闭按钮上会
         顶出一圈蓝色焦点环，触屏上看着像「按钮坏了」 */
      data-modal-focus
      tabIndex={-1}
    >
      {platforms.map((s, i) => (
        <div
          className="reco-sl-seg"
          key={s}
          style={{ flexGrow: segs[i], flexBasis: 0 }}
          aria-hidden="true"
        >
          <span className="reco-sl-name">{labelOf(s)}</span>
          <span className="reco-sl-n">{segs[i]}</span>
        </div>
      ))}
      {bounds.map((b, i) => (
        <button
          key={platforms[i]}
          className="reco-sl-h"
          style={{ left: `${(b / total) * 100}%` }}
          role="slider"
          aria-orientation="horizontal"
          aria-label={`${platformName(platforms[i])} 与 ${platformName(platforms[i + 1])} 的分界，拖动调整各出几首`}
          aria-valuemin={MIN_PER}
          aria-valuemax={total - MIN_PER * (platforms.length - 1)}
          aria-valuenow={segs[i]}
          onPointerDown={start(i)}
          onPointerMove={move(i)}
          onPointerUp={end()}
          onPointerCancel={end()}
          onKeyDown={key(i)}
        ><i /></button>
      ))}
    </div>
  )
}
