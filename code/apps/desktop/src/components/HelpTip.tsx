/**
 * 问号提示：把「一大段解释」收进一个图标里，点一下才展开。
 *
 * 起因很直接：设置页、导入页里那些说明性文字（支持什么格式、缓存放在哪、怎么导出歌单……）
 * 一年看一次，却天天占掉半屏，把真正的操作项挤到很下面。用户原话是「文字提示太多了」。
 *
 * 交互约定：
 *   - 默认只显示一颗 14px 的问号，鼠标悬停不变形、不抢焦点；
 *   - 点击展开气泡，点别处 / 再点一次 / Esc 收起；
 *   - 气泡用 fixed 定位按图标位置算，避免被设置页的滚动容器裁掉。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Props {
  /** 展开后的说明文字，允许换行（用 \n） */
  text: string
  /** 无障碍标签，默认「说明」 */
  label?: string
  /** 气泡最大宽度 */
  width?: number
}

export function HelpTip({ text, label = '说明', width = 300 }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean }>({ left: 0, top: 0, up: false })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const w = Math.min(width, window.innerWidth - 24)
    // 默认在图标右下方展开；右边放不下就往左收，下面放不下就翻到上方
    let left = r.left + r.width / 2 - 10
    if (left + w > window.innerWidth - 12) left = window.innerWidth - 12 - w
    if (left < 12) left = 12
    const downSpace = window.innerHeight - r.bottom
    const up = downSpace < 180 && r.top > 200
    setPos({ left, top: up ? r.top - 8 : r.bottom + 8, up })
  }, [open, width])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={'help-dot' + (open ? ' on' : '')}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
      >
        ?
      </button>
      {open && (
        <div
          ref={popRef}
          className={'help-pop' + (pos.up ? ' up' : '')}
          style={{ left: pos.left, top: pos.top, width: Math.min(width, window.innerWidth - 24) }}
          role="tooltip"
        >
          {text}
        </div>
      )}
    </>
  )
}
