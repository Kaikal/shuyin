/**
 * 底部动作面板（设计稿 06 长按选项 / 播放页「更多」共用）。
 *
 * 为什么单独做一个、而不是把右键菜单 `ContextMenu` 改一改：
 * 两者是**两种交互**——右键菜单要贴指针、要考虑边界翻转、键盘上下选；
 * 底部面板是整屏遮罩 + 贴底、要抓手、进入是位移淡入。塞进一个组件里
 * 只会让两边的分支互相绊。数据（`items` 那种动作清单）在各调用点本来就不一样大，
 * 这里用更直白的 `actions` / `rows` 两组，谁调谁清楚。
 *
 * 动效按规格：面板 translateY(24→0) + 淡入 200ms，遮罩同步淡入；
 * 减弱动效时只做 100ms 淡入（见 handoff.css）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconCheck, IconChevronDown, IconClose } from './icons'
import { pushBackLayer } from '../lib/native/android'

export interface SheetAction {
  id: string
  label: string
  icon: ReactNode
  onClick(): void
  disabled?: boolean
  /** 当前已生效（收藏 / 已在队列 …）：按钮底与文字换成强调色 */
  on?: boolean
}

export interface SheetRow {
  id: string
  label: string
  onClick?(): void
  danger?: boolean
  chevron?: boolean
  disabled?: boolean
  /**
   * 开关型行（频谱 / Folia 这类「开着还是关着」的设置）。
   * 右侧画一个开关，`on` 是当前状态——不用点进去、也不用二次确认，
   * 一眼就知道现在是开还是关。
   */
  sw?: boolean
  on?: boolean
  /** 开关型行点完**不要**关面板：连着拨两项时不用再点一次「更多」 */
  keepOpen?: boolean
  /**
   * 单选的当前项（音质 / 频谱样式这类「从几档里挑一个」的行）。
   * 右侧画一个勾，和「开关」区分开：开关是开/关，勾是「现在是这一档」。
   */
  checked?: boolean
}

interface Props {
  open: boolean
  title: string
  sub?: string
  /** 头部左侧那块封面（调用方传 `<Cover …/>`，这里不关心它怎么来的） */
  cover?: ReactNode
  actions?: SheetAction[]
  rows?: SheetRow[]
  onClose(): void
}

export function ActionSheet({ open, title, sub, cover, actions = [], rows = [], onClose }: Props) {
  const [shown, setShown] = useState(open)

  /* 关闭时先把动画放完再卸载：直接 return null 会「啪」一下消失 */
  useEffect(() => {
    if (open) setShown(true)
    else {
      const t = window.setTimeout(() => setShown(false), 200)
      return () => window.clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /*
   * 安卓返回键：面板开着时先关面板。
   *
   * 这一层以前没有——用户在播放页点「更多」之后按返回，直接退回了首页
   * （App 那套返回栈只知道播放页，看不见这个组件内部的 open）。
   */
  useEffect(() => {
    if (!open) return
    return pushBackLayer(() => { onClose(); return true })
  }, [open, onClose])

  const startY = useRef<number | null>(null)
  const [dy, setDy] = useState(0)

  if (!shown) return null

  return (
    <div className={'sheet-scrim' + (open ? ' open' : '')} onClick={onClose}>
      <div
        className={'sheet' + (open ? ' open' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
        onClick={e => e.stopPropagation()}
        onPointerDown={e => { startY.current = e.clientY }}
        onPointerMove={e => {
          if (startY.current == null) return
          const d = e.clientY - startY.current
          if (d > 0) setDy(d)
        }}
        onPointerUp={() => {
          if (dy > 80) onClose()
          setDy(0)
          startY.current = null
        }}
      >
        {/* 这里**不放抓手**：这个面板的高度是固定的，「抓手」会让人以为能拖高，
            拖不动就成了误导（用户：「不能拖动那就不要拖动的按钮」）。
            下滑关闭仍然可用，只是不再给一个假的拖动提示。 */}

        <header className="sheet-head">
          {cover && <span className="sheet-cover">{cover}</span>}
          <span className="sheet-meta">
            <span className="sheet-title">{title}</span>
            {sub && <span className="sheet-sub">{sub}</span>}
          </span>
          <button className="icon-btn sheet-x" aria-label="关闭" onClick={onClose}>
            <IconClose width={16} height={16} />
          </button>
        </header>

        {actions.length > 0 && (
          /* data-count 给 CSS 用：格子数要跟着实际动作数走，固定 5 列时
             少一颗就变成「左边四颗、右边空一格」，看着像漏了一个按钮。 */
          <div className="sheet-acts" data-count={actions.length}>
            {actions.map(a => (
              <button
                key={a.id}
                className={'sheet-act' + (a.on ? ' on' : '')}
                disabled={a.disabled}
                onClick={() => { a.onClick(); onClose() }}
              >
                <span className="sa-ico">{a.icon}</span>
                <span className="sa-lb">{a.label}</span>
              </button>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="sheet-rows">
            {rows.map(r => (
              <button
                key={r.id}
                className={'sheet-row' + (r.danger ? ' danger' : '') + (r.checked ? ' is-checked' : '')}
                disabled={r.disabled}
                role={r.sw ? 'switch' : undefined}
                aria-checked={r.sw ? !!r.on : undefined}
                onClick={() => { r.onClick?.(); if (!r.keepOpen) onClose() }}
              >
                <span>{r.label}</span>
                {r.sw
                  ? <span className="sheet-sw" data-on={r.on ? '1' : '0'} aria-hidden="true" />
                  : r.chevron ? <IconChevronDown className="sheet-chev" width={14} height={14} /> : null}
                {r.checked && <IconCheck className="sheet-check" width={15} height={15} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
