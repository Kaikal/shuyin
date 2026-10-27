/**
 * 通用弹窗：遮罩 + 卡片 + 标题栏 + 底部动作区。
 *
 * 为什么要有它：设置页里「拖动即时生效」的滑块（音效三段增益、桌面歌词字号…）
 * 常驻在页面上非常占地方——用户一年也不调两次，却每天都要往下滚过去。
 * 收进弹窗之后，页面上只留「预设 / 当前值摘要」，要动手才展开。
 *
 * 交互：Esc 关闭、点遮罩关闭、打开时把焦点收进来、关闭后还给原来的元素。
 */
import { useEffect, useRef } from 'react'
import { IconClose } from './icons'

interface Props {
  open: boolean
  title: string
  /** 标题下面的一行说明 */
  hint?: string
  onClose(): void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}

export function Modal({ open, title, hint, onClose, children, footer, width = 460 }: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  /**
   * 最新一次的 onClose。调用方基本都是内联箭头函数，每次渲染都是新引用；
   * 如果把它放进下面的 effect 依赖里，那么**每敲一个字符**（父组件重渲染）
   * 这个 effect 就会清理一次再执行一次——清理会把焦点还给打开前的按钮，
   * 30ms 后再抢回输入框。表现就是输入框一直闪、中文输入法直接被打断。
   * 所以走 ref：effect 只认 open。
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    // 焦点进来，键盘用户才能直接 Tab 到第一个控件
    const id = window.setTimeout(() => {
      const card = cardRef.current
      if (!card) return
      // 用户手快，已经自己点进某个输入框了——别抢
      const cur = document.activeElement as HTMLElement | null
      if (cur && cur !== document.body && card.contains(cur) && cur !== card) return
      // 优先把焦点给「要填写/拖动的东西」，没有才落在按钮上
      const first =
        card.querySelector<HTMLElement>('input:not([type=range]), textarea, select')
        ?? card.querySelector<HTMLElement>('input[type=range]')
        ?? card.querySelector<HTMLElement>('button')
      first?.focus({ preventScroll: true })
    }, 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('keydown', onKey)
      // 只在真正关闭时才把焦点还回去（open 变了才清理，输入过程中不会触发）
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true })
    }
    // onClose 走 ref，故意不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  return (
    <div className="modal-scrim" role="presentation" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="modal-card themed"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
      >
        <header className="modal-head">
          <div className="modal-title-wrap">
            <h4 className="modal-title">{title}</h4>
            {hint && <span className="modal-hint">{hint}</span>}
          </div>
          <button className="icon-btn modal-x" aria-label="关闭" onClick={onClose}>
            <IconClose width={15} height={15} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}
