/**
 * 歌词搜索表单：点「在线搜索歌词」之后才出现的一行输入。
 *
 * 为什么不常显：大部分时候歌名、歌手都是对的，空态里常摆两个输入框只会更乱。
 * 只有用户主动点了搜索才让他改——元数据错了是搜不到歌词最常见的原因
 * （标题带着 `(Live)` / `伴奏`、歌手是「未知艺术家」、文件名和 tag 对不上），
 * 给他一个改的地方，比让他反复点重搜有用。
 *
 * 两个框都用当前曲目的信息预填：多数情况只需要改其中一个字。
 */
import { useState } from 'react'
import { IconRefresh } from './icons'

export function LyricSearchForm({ title, artist, onSubmit, onCancel }: {
  title: string
  artist: string
  onSubmit(q: { title: string; artist: string }): void
  onCancel(): void
}) {
  const [q, setQ] = useState(title)
  const [a, setA] = useState(artist)
  return (
    <form
      className="lyr-search"
      onSubmit={e => { e.preventDefault(); if (q.trim()) onSubmit({ title: q.trim(), artist: a.trim() }) }}
    >
      <input
        className="text-input"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="歌名"
        aria-label="歌名"
        autoFocus
      />
      <input
        className="text-input"
        value={a}
        onChange={e => setA(e.target.value)}
        placeholder="歌手（可留空）"
        aria-label="歌手"
      />
      <span className="lyr-search-act">
        <button type="submit" className="ghost-btn" disabled={!q.trim()}>
          <IconRefresh width={13} height={13} /> 搜索
        </button>
        <button type="button" className="link-btn" onClick={onCancel}>取消</button>
      </span>
    </form>
  )
}
