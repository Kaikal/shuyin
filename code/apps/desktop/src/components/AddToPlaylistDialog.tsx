/**
 * 「加入歌单」弹窗：曲库里的歌（单首或批量）挑一个本地歌单放进去。
 *
 * 顺手支持当场新建：用户整理歌单的心态是「这批歌归到一起」，
 * 让他先关掉弹窗、去我的页面建一个、再回来选一遍，等于把一步拆成四步。
 */
import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { IconMusicNote, IconPlus } from './icons'
import { usePlaylists } from '../lib/localPlaylists'

interface Props {
  open: boolean
  trackIds: string[]
  onClose(): void
  /** 加完之后回调一句结果，交给调用方做轻提示 */
  onDone?(text: string): void
}

export function AddToPlaylistDialog({ open, trackIds, onClose, onDone }: Props) {
  const pl = usePlaylists()
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!open) { setName(''); setMsg('') }
  }, [open])

  const add = (id: string, listName: string) => {
    const n = pl.addTracks(id, trackIds)
    const text = n ? `已把 ${n} 首加入「${listName}」` : `「${listName}」里已经有这些歌了`
    setMsg(text)
    onDone?.(text)
    if (n) window.setTimeout(onClose, 420)
  }

  const createAndAdd = () => {
    const n = name.trim()
    if (!n) return
    const created = pl.create(n, { trackIds })
    setMsg(`已新建「${created.name}」并放进 ${trackIds.length} 首`)
    onDone?.(`已新建歌单「${created.name}」`)
    window.setTimeout(onClose, 420)
  }

  return (
    <Modal
      open={open}
      title="加入歌单"
      hint={`${trackIds.length} 首`}
      onClose={onClose}
      width={420}
      footer={
        <>
          <span className="modal-note">{msg}</span>
          <button className="ghost-btn" onClick={onClose}>取消</button>
        </>
      }
    >
      <div className="atp-list">
        {pl.lists.length === 0 && <div className="atp-empty">还没有歌单，下面新建一个</div>}
        {pl.lists.map(l => (
          <button key={l.id} className="atp-row" onClick={() => add(l.id, l.name)}>
            <IconMusicNote width={14} height={14} />
            <span className="atp-name">{l.name}</span>
            <span className="atp-count num">{l.trackIds.length} 首</span>
          </button>
        ))}
      </div>
      <div className="atp-new">
        <input
          className="text-input"
          placeholder="新建歌单，例如「深夜通勤」"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createAndAdd() }}
        />
        <button className="primary-btn" disabled={!name.trim()} onClick={createAndAdd}>
          <IconPlus width={12} height={12} /> 新建并加入
        </button>
      </div>
    </Modal>
  )
}
