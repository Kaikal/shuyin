/**
 * 「我喜欢的音乐」页 = 收藏的歌曲。
 *
 * 为什么单独开一页而不是复用曲库的「收藏」分类：
 *   · 收藏里有**在线**曲目（搜索页/播放页收的那些），曲库按本地 id 过滤永远遇不到；
 *   · 这一页的主要动作是「顺着听一遍 / 取消几首」，不需要曲库的扫描、搜索、多选。
 *
 * 列表沿用曲库那套 `.sr-list` / `.sr-row` 标记，手机与平板的行样式、封面尺寸、
 * 长按进多选的行为都直接继承，不用再造一套。
 *
 * 本地曲目以**曲库**为准更新元数据（可能在别处改过标签 / 重扫换了 id），
 * 在线曲目用收藏时存下来的记录（断网也能画出来，点播放才出网取链）。
 */
import { useMemo, useState } from 'react'
import { fmtTime, type LocalTrack } from '@shuyin/core'
import { usePlayer } from '../lib/PlayerProvider'
import { useFavs, favTracksOf } from '../lib/favTracks'
import { longPressProps } from '../lib/longPress'
import { toast } from '../lib/toast'
import { queueToast } from '../lib/queueToast'
import {
  IconCheck, IconClose, IconDownload, IconNext, IconPlay, IconPlus, IconTrash,
} from '../components/icons'

interface Props {
  onBack(): void
}

export function FavPage({ onBack }: Props) {
  const p = usePlayer()
  const favs = useFavs()
  /** 多选：长按一行进入，和歌单详情是同一套手感 */
  const [sel, setSel] = useState<Set<string>>(() => new Set())

  /* 收藏记录 → 可播放的曲目（本地优先用曲库那份，在线用记录重建；最新收藏在最前） */
  const tracks = useMemo<LocalTrack[]>(() => favTracksOf(favs.list, p.library), [favs.list, p.library])

  const total = useMemo(() => tracks.reduce((n, t) => n + (t.duration || 0), 0), [tracks])
  const selTracks = useMemo(() => tracks.filter(t => sel.has(t.id)), [tracks, sel])

  const toggleOne = (id: string) => {
    setSel(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSel = () => setSel(new Set())

  const removeSel = () => {
    const n = sel.size
    for (const t of selTracks) void favs.toggle({ id: t.id })
    clearSel()
    toast(`已取消收藏 ${n} 首`)
  }

  return (
    <div className="page fav-page">
      <header className="lib-head">
        <div className="lib-head-left">
          <button className="ghost-btn lib-back" onClick={onBack}>← 返回我的</button>
          <h1>我喜欢的音乐</h1>
          <p className="lib-status">
            <b className="num">{tracks.length}</b> 首{total > 0 ? <> · <span className="num">{fmtTime(total)}</span></> : null}
          </p>
        </div>
        <div className="lib-actions">
          {tracks.length > 0 && (
            <button
              className="primary-btn"
              onClick={() => { clearSel(); p.playList(tracks, 0) }}
            >
              <IconPlay width={13} height={13} /> 播放全部
            </button>
          )}
        </div>
      </header>

      {selTracks.length > 0 && (
        <div className="lib-batchbar" role="toolbar" aria-label="批量操作">
          <span className="bb-count">已选 <b className="num">{selTracks.length}</b> 首</span>
          <span className="bb-sep" aria-hidden="true" />
          <div className="bb-actions">
            <button className="bb-btn primary" onClick={() => p.playList(selTracks, 0)}>
              <IconPlay width={12} height={12} /> 播放
            </button>
            <button className="bb-btn" onClick={() => { queueToast(selTracks, p.queueState.queue, 'next'); p.addManyToQueue(selTracks, 'next') }}>
              <IconNext width={12} height={12} /> 下一首播放
            </button>
            <button className="bb-btn" onClick={() => { queueToast(selTracks, p.queueState.queue, 'end'); p.addManyToQueue(selTracks, 'end') }}>
              <IconPlus width={12} height={12} /> 加入播放列表
            </button>
            <button className="bb-btn" onClick={removeSel}>
              <IconTrash width={12} height={12} /> 取消收藏
            </button>
          </div>
          <button className="icon-btn bb-clear" onClick={clearSel} aria-label="取消选择">
            <IconClose width={13} height={13} />
          </button>
        </div>
      )}

      {tracks.length === 0 ? (
        <div className="empty-state">
          <div className="title">还没有收藏的歌</div>
          <div className="sub">播放页那颗心点一下，就会收到这里</div>
        </div>
      ) : (
        <div className="sr-list" data-selecting={sel.size > 0 ? 'true' : undefined}>
          {tracks.map(t => {
            const on = sel.has(t.id)
            const live = p.current?.id === t.id
            const online = t.id.startsWith('online:')
            return (
              <div
                key={t.id}
                className={'sr-row' + (live ? ' live' : '') + (on ? ' selected' : '')}
                title="点击播放 · 长按多选"
                onClick={() => { if (sel.size > 0) { toggleOne(t.id); return } p.playOne(t) }}
                {...longPressProps(() => { if (!on) setSel(new Set([t.id])) })}
              >
                <button
                  className={'cbx sr-cbx' + (on ? ' on' : '')}
                  role="checkbox" aria-checked={on} aria-label={'选中 ' + t.title}
                  onClick={e => { e.stopPropagation(); toggleOne(t.id) }}
                >
                  {on && <IconCheck width={10} height={10} />}
                </button>
                <span
                  className="sr-art"
                  aria-hidden="true"
                  style={t.cover ? { backgroundImage: `url(${t.cover})` } : undefined}
                />
                <div className="sr-main">
                  <div className="sr-title">
                    {t.title}
                    {live && <span className="eq-mini" />}
                  </div>
                  <div className="sr-meta">
                    <span>{t.artist || '未知歌手'}</span>
                    {online && <span className="sr-dot">·</span>}
                    {online && <span>在线</span>}
                  </div>
                </div>
                <span className="sr-dur num">{fmtTime(t.duration)}</span>
                <div className="sr-acts">
                  <button
                    className="icon-btn"
                    title="下一首播放"
                    onClick={e => {
                      e.stopPropagation()
                      queueToast([t], p.queueState.queue, 'next')
                      p.addToQueue(t, 'next')
                    }}
                  >
                    <IconNext />
                  </button>
                  {online && (
                    <button
                      className="icon-btn"
                      title="下载这首歌"
                      onClick={e => { e.stopPropagation(); toast('下载入口在播放页') }}
                    >
                      <IconDownload />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
