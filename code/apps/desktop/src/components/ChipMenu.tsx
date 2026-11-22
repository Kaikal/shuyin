/**
 * 播放页的下拉芯片：一个按钮 + 一块弹出列表，**直接选**而不是逐个轮换。
 *
 * 为什么要有这个东西：频谱样式六种、位置五种、音效八套、音质九档，
 * 原来都是「点一下换下一个」，想从「柱状」切回「音丝带」得点五次，
 * 而且完全不知道下一个是什么。列表一拉，一眼看全，一次点到位。
 *
 * 交互细节：
 *   · 点外面 / 选完 / 按 Esc 都关；Esc 在 capture 阶段吃掉，避免顺手把整个播放页也关了
 *   · 当前项打勾；不可用的档位置灰但保留在列表里（用户得知道「有这个档位只是现在不行」）
 *   · **自动避让屏幕边缘**：弹出层默认向下展开，但打开那一刻会量一下按钮四周
 *     还剩多少空间——下方放不下就翻上去，右边放不下就改左对齐，两个方向都紧张
 *     就把列表高度压到放得下为止。以前「设置 · 播放」里的音质下拉贴着屏幕底部，
 *     选项一半在屏幕外面（2026-11-21 用户反馈），各调用点自己猜 `up` / `alignEnd`
 *     猜不准，现在统一在这里量。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconCheck, IconChevronDown } from './icons'

export interface ChipOption {
  id: string
  name: string
  desc?: string
  /** 右侧补充信息（音质档位、状态之类） */
  note?: string
  disabled?: boolean
}

interface Props {
  icon?: ReactNode
  /** 芯片上的名字，如「频谱」 */
  label: string
  /** 当前值，如「柱状」 */
  value: string
  options: ChipOption[]
  activeId?: string
  onPick(id: string): void
  title?: string
  disabled?: boolean
  /** 弹出层最小宽度 */
  width?: number
  /** 列表从右边对齐（靠右的芯片用）——只是**初始猜测**，实际以测量结果为准 */
  alignEnd?: boolean
  /** 列表向上展开（芯片已经贴近页面底部时用）——同样是初始猜测 */
  up?: boolean
}

const POP_GAP = 8
const POP_MAX = 320
const POP_MIN = 140

interface Fit {
  up: boolean
  end: boolean
  maxH: number
}

export function ChipMenu({
  icon, label, value, options, activeId, onPick, title, disabled, width = 188, alignEnd, up,
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  /** 避让结果：方向 + 高度上限。打开时量一次，关掉就回到调用点的初始猜测 */
  const [fit, setFit] = useState<Fit>({ up: !!up, end: !!alignEnd, maxH: POP_MAX })

  /*
   * 退场留白：列表是「小浮层」这一档，110ms 就够。
   * 直接 `open && …` 的话点完选项面板是瞬间消失的，和进场那 120ms 不对称，
   * 看着像「闪了一下」。
   */
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (open) { setShown(true); return }
    const t = window.setTimeout(() => setShown(false), 130)
    return () => window.clearTimeout(t)
  }, [open])

  /* 关掉后恢复初始猜测，下次打开重新量 */
  useEffect(() => {
    if (!open) setFit({ up: !!up, end: !!alignEnd, maxH: POP_MAX })
  }, [open, up, alignEnd])

  /*
   * 打开那一刻量一次可用空间（useLayoutEffect：改状态发生在绘制前，不会闪）。
   *
   * 用 `visualViewport` 而不是 `innerHeight`：手机上键盘弹起 / WebView 缩放时
   * 后者可能比真实可视区大，量出来的「下方空间」是假的。
   */
  useLayoutEffect(() => {
    if (!open) return
    const root = rootRef.current
    const pop = popRef.current
    if (!root) return
    const r = root.getBoundingClientRect()
    const vv = window.visualViewport
    const vh = vv?.height ?? window.innerHeight
    const vw = vv?.width ?? window.innerWidth
    /* 弹出层此刻的真实高度（首次渲染还带着 CSS 的 320 上限） */
    const h = pop?.offsetHeight ?? Math.min(POP_MAX, options.length * 42 + 14)
    const w = Math.max(pop?.offsetWidth ?? 0, width)
    const below = vh - r.bottom - POP_GAP
    const above = r.top - POP_GAP

    let useUp = !!up
    /* 初猜向下但下面放不下、上面更宽裕 → 翻上去；反之亦然 */
    if (!useUp && below < h && above > below) useUp = true
    if (useUp && above < h && below > above) useUp = false

    let useEnd = !!alignEnd
    if (!useEnd && r.left + w > vw && r.right - w >= 0) useEnd = true
    if (useEnd && r.right - w < 0 && r.left + w <= vw) useEnd = false

    /* 选定方向后把高度压进可用空间：两个方向都放不下时取更宽裕的那边 */
    const space = Math.max(useUp ? above : below, POP_MIN)
    const maxH = Math.min(POP_MAX, Math.max(POP_MIN, Math.floor(space)))
    setFit(prev => (prev.up === useUp && prev.end === useEnd && prev.maxH === maxH
      ? prev
      : { up: useUp, end: useEnd, maxH }))
    // options.length 变化（音源装载完补档位）会改高度，跟着重量一次
  }, [open, options.length, width, up, alignEnd])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 播放页的 Esc 是「收起整页」：菜单开着的时候只关菜单
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className={'chip-menu' + (fit.end ? ' end' : '') + (fit.up ? ' up' : '')} ref={rootRef}>
      <button
        className={'imm-chip chip-menu-btn' + (open ? ' on' : '')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        title={title ?? `${label}：${value}`}
        disabled={disabled}
      >
        {icon}
        <span className="cm-label">{label}</span>
        <span className="cm-value">{value}</span>
        <IconChevronDown width={11} height={11} />
      </button>

      {shown && (
        <div
          className="chip-pop"
          role="listbox"
          aria-label={label}
          ref={popRef}
          style={{ minWidth: width, maxHeight: fit.maxH }}
          data-closing={open ? undefined : 'true'}
        >
          {options.map(o => {
            const on = o.id === activeId
            return (
              <button
                key={o.id}
                role="option"
                aria-selected={on}
                className={'chip-opt' + (on ? ' on' : '')}
                disabled={o.disabled}
                onClick={() => { onPick(o.id); setOpen(false) }}
              >
                <span className="co-main">
                  <span className="co-name">{o.name}</span>
                  {o.desc && <span className="co-desc">{o.desc}</span>}
                </span>
                {o.note && <span className="co-note">{o.note}</span>}
                {on && <IconCheck width={12} height={12} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
