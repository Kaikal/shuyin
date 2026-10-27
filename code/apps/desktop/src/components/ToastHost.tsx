/**
 * 轻提示的渲染出口：挂在 App 最外层一次，全局共用。
 *
 * `low` 用于沉浸式播放页打开时把提示挪到下方——
 * 那一页顶部是返回键和音质芯片，提示条压上去会挡住操作。
 */
import { useEffect, useState } from 'react'
import { subscribeToasts, type ToastItem } from '../lib/toast'

export function ToastHost({ low = false }: { low?: boolean }) {
  const [list, setList] = useState<ToastItem[]>([])

  useEffect(() => subscribeToasts(setList), [])

  if (!list.length) return null
  return (
    <div className={'toast-host' + (low ? ' low' : '')} role="status" aria-live="polite">
      {list.map(t => (
        <div
          key={t.id}
          className={'toast-item' + (t.bad ? ' bad' : t.ok ? ' ok' : '')}
        >
          <span className="ti-icon" aria-hidden="true">{t.bad ? '!' : t.ok ? '✓' : 'i'}</span>
          <span className="ti-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
