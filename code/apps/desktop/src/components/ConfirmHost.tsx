/**
 * 确认框宿主：`<ConfirmHost/>` 挂在 App 根部一次，全局的 `confirm()` 就有地方渲染。
 *
 * 一次只显示队首那一条 —— 用户点掉才轮到下一个，不会出现两层遮罩叠在一起、
 * 点一下同时关掉两个框这种莫名其妙的事。
 */
import { useEffect, useState } from 'react'
import { settleConfirm, subscribeConfirm, type ConfirmRequest } from '../lib/confirm'
import { Modal } from './Modal'

export function ConfirmHost() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([])
  useEffect(() => subscribeConfirm(setQueue), [])

  const cur = queue[0] ?? null
  /*
   * 队首被结算掉之后，队列立刻变空。**内容要留一帧**：
   * Modal 的退场动画（160ms）需要标题和按钮还在 DOM 里，
   * 否则遮罩淡出的同时卡片内容先一步消失，看起来像「框闪了一下白」。
   * 只是留着渲染，`open` 已经是 false，不会再响应点击。
   */
  const [last, setLast] = useState<ConfirmRequest | null>(null)
  useEffect(() => { if (cur) setLast(cur) }, [cur])

  const view = cur ?? last
  if (!view) return null

  const close = (ok: boolean) => { if (cur) settleConfirm(cur.id, ok) }

  return (
    <Modal
      open={!!cur}
      title={view.title}
      onClose={() => close(false)}
      width={404}
      footer={
        <>
          <span className="modal-sp" />
          <button className="ghost-btn" onClick={() => close(false)}>
            {view.cancelText || '取消'}
          </button>
          <button className={view.danger ? 'primary-btn danger' : 'primary-btn'} onClick={() => close(true)}>
            {view.confirmText || '确定'}
          </button>
        </>
      }
    >
      {view.message && <p className="confirm-msg">{view.message}</p>}
    </Modal>
  )
}
