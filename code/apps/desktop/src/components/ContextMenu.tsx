/**
 * 右键菜单：自定义浮层（非系统原生菜单），支持边界翻转、键盘上下选择、Esc 关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  divider?: boolean
  disabled?: boolean
  onSelect(): void
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [active, setActive] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let nx = x
    let ny = y
    if (nx + r.width + pad > window.innerWidth) nx = Math.max(pad, x - r.width)
    if (ny + r.height + pad > window.innerHeight) ny = Math.max(pad, window.innerHeight - r.height - pad)
    setPos({ x: nx, y: ny })
    el.querySelector<HTMLElement>('.ctx-item')?.focus()
  }, [x, y])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const idxs = items.map((it, i) => (it.divider || it.disabled ? -1 : i)).filter(i => i >= 0)
        if (!idxs.length) return
        const cur = idxs.indexOf(active)
        const nextIdx = e.key === 'ArrowDown'
          ? idxs[(cur + 1) % idxs.length]
          : idxs[(cur - 1 + idxs.length) % idxs.length]
        setActive(nextIdx)
        ref.current?.querySelectorAll<HTMLElement>('.ctx-item')[nextIdx]?.focus()
      }
      if (e.key === 'Enter' && active >= 0) {
        const it = items[active]
        if (it && !it.disabled) { it.onSelect(); onClose() }
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
    }
  }, [items, active, onClose])

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label="歌曲操作"
    >
      {items.map((it, i) => (
        it.divider
          ? <div key={it.id} className="ctx-divider" role="separator" />
          : (
            <button
              key={it.id}
              className={'ctx-item' + (it.danger ? ' danger' : '')}
              role="menuitem"
              disabled={it.disabled}
              onMouseEnter={() => setActive(i)}
              onClick={() => { it.onSelect(); onClose() }}
            >
              <span className="ctx-icon">{it.icon}</span>
              <span className="ctx-label">{it.label}</span>
              {it.shortcut && <span className="ctx-kbd num">{it.shortcut}</span>}
            </button>
          )
      ))}
    </div>
  )
}
