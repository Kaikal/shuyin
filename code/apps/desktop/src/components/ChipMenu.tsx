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
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  /** 列表从右边对齐（靠右的芯片用） */
  alignEnd?: boolean
  /** 列表向上展开（芯片已经贴近页面底部时用，否则弹出层会被裁在屏幕外） */
  up?: boolean
}

export function ChipMenu({
  icon, label, value, options, activeId, onPick, title, disabled, width = 188, alignEnd, up,
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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
    <div className={'chip-menu' + (alignEnd ? ' end' : '') + (up ? ' up' : '')} ref={rootRef}>
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

      {open && (
        <div className="chip-pop" role="listbox" aria-label={label} style={{ minWidth: width }}>
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
