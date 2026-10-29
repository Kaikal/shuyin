/**
 * 「发现新版本」弹窗。
 *
 * 用应用内 Modal，不用系统框：这个应用是深色玻璃质感，系统白框一弹就出戏
 * （和删除歌单那次是同一个教训，见 lib/confirm.ts）。
 *
 * 注意版本号不是「必须更新」就不拦人：主按钮是「前往下载」，次要按钮「以后再说」
 * 会把这一版记进 `update.skip`，同一个版本不再弹，直到下一版出现。
 */
import { Modal } from './Modal'
import type { UpdateInfo } from '../lib/update'

export function UpdateDialog({
  info,
  onSkip,
  onGo,
}: {
  info: UpdateInfo | null
  /** 以后再说 / 关掉 */
  onSkip(): void
  /** 前往下载 */
  onGo(): void
}) {
  if (!info) return null
  return (
    <Modal
      open
      title={`发现新版本 v${info.latest}`}
      hint={`当前 v${info.current}${info.date ? ` · 新版发布于 ${info.date}` : ''}`}
      onClose={onSkip}
      width={470}
      footer={<>
        {!info.force && (
          <button className="ghost-btn" onClick={onSkip}>以后再说</button>
        )}
        <span className="modal-sp" />
        <button className="primary-btn" onClick={onGo}>前往下载</button>
      </>}
    >
      {info.notes.length > 0
        ? (
          <ul className="upd-notes">
            {info.notes.map(n => <li key={n}>{n}</li>)}
          </ul>
        )
        : <p className="upd-meta">这一版没有写更新说明。</p>}
    </Modal>
  )
}
