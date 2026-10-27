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

  const cur = queue[0]
  if (!cur) return null

  const close = (ok: boolean) => settleConfirm(cur.id, ok)

  return (
    <Modal
      open
      title={cur.title}
      onClose={() => close(false)}
      width={404}
      footer={
        <>
          <span className="modal-sp" />
          <button className="ghost-btn" onClick={() => close(false)}>
            {cur.cancelText || '取消'}
          </button>
          <button className={cur.danger ? 'primary-btn danger' : 'primary-btn'} onClick={() => close(true)}>
            {cur.confirmText || '确定'}
          </button>
        </>
      }
    >
      {cur.message && <p className="confirm-msg">{cur.message}</p>}
    </Modal>
  )
}
