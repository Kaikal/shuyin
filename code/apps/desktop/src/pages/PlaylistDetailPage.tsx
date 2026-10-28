/**
 * 在线歌单详情：一次把歌单拉全（平台接口都支持一次给完），
 * 顶部是「播放全部 / 加入队列」，下面是曲目列表。
 *
 * 四个平台现在都能进详情（v0.5.5 补上了酷我：`pl.svc` 补齐 keyset/identity 后
 * `musiclist` 就不再是空的了）。这里只需要处理「详情接口报错」的情况
 * （私密歌单、已下架、平台临时限流）。
 *
 * 多选（v0.5.6）：和本地歌单详情同一套手感——Ctrl 点单选、Shift 连选、
 * 表头全选、Ctrl+A / Esc。多选后可以整批「加入其它歌单」，收进自己的歌单里
 * 慢慢听（在线曲目只存 id，靠在线曲目注册表还原，见 online.trackOfId）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtTime } from '@shuyin/core'
import type { PlaylistDetail, PlatformSource, SearchSong } from '@shuyin/lx-provider'
import { usePlayer } from '../lib/PlayerProvider'
import { useDownloads } from '../lib/DownloadsProvider'
import { apiFor, dailyRecommend, platformName, toLocalTrack, toLocalTracks } from '../lib/online'
import { usePlaylists } from '../lib/localPlaylists'
import { toast } from '../lib/toast'
import { consumeLongPress, longPressProps } from '../lib/longPress'
import {
  IconCheck, IconClose, IconDownload, IconLyric, IconMusicNote, IconNext, IconPlay, IconPlus,
  IconStar,
} from '../components/icons'
import { OnlineSongMenu } from '../components/OnlineSongMenu'
import { AddToPlaylistDialog } from '../components/AddToPlaylistDialog'

interface Props {
  source: PlatformSource
  id: string
  name: string
  onBack(): void
  /** 返回按钮的文案。从「我的」点进来时是「返回我的」 */
  backLabel?: string
  /** 列表页手里那份封面：详情接口不回封面时（酷狗榜单）拿它顶上 */
  fallbackCover?: string
}

/** 选中用的键：同一首歌在不同平台 id 可能撞，带上平台前缀才唯一 */
const keyOf = (s: SearchSong) => `${s.source}:${s.id}`

export function PlaylistDetailPage({ source, id, name, backLabel = '返回搜索', onBack, fallbackCover }: Props) {
  const p = usePlayer()
  const dl = useDownloads()
  const bookmarks = usePlaylists()
  /** `daily:` 开头是「每日推荐」，它不是一个真歌单 id，取数据走另一条路 */
  const isDaily = id.startsWith('daily:')
  const faved = !isDaily && bookmarks.isFav(source, id)
  const [detail, setDetail] = useState<PlaylistDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [menu, setMenu] = useState<{ x: number; y: number; song: SearchSong } | null>(null)
  /** 多选的键集合 + 连选锚点 + 「加入歌单」弹窗要加的曲目 id */
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const anchor = useRef(-1)
  const [addTo, setAddTo] = useState<string[] | null>(null)
  const reqId = useRef(0)

  useEffect(() => {
    const seq = ++reqId.current
    setLoading(true)
    setError(null)
    setDetail(null)
    setSel(new Set())
    anchor.current = -1
    const api = apiFor(source)
    const load = isDaily
      ? () => dailyRecommend(source)
      : api?.getPlaylistDetail
        ? () => api.getPlaylistDetail!(id, 1, 1000)
        : null
    if (!load) {
      setError(isDaily ? '该平台暂不支持每日推荐' : '该平台暂不支持查看歌单详情')
      setLoading(false)
      return
    }
    load()
      .then(d => { if (seq === reqId.current) { setDetail(d); setLoading(false) } })
      .catch(e => {
        if (seq !== reqId.current) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }, [source, id, isDaily])

  const songs: SearchSong[] = detail?.songs ?? []
  /** 榜单详情（酷狗）不回封面，用列表页带过来的那张 */
  const cover = detail?.cover || fallbackCover

  const selSongs = useMemo(() => songs.filter(sg => sel.has(keyOf(sg))), [songs, sel])
  const allSel = songs.length > 0 && selSongs.length === songs.length
  const someSel = selSongs.length > 0 && !allSel

  const clearSel = useCallback(() => { setSel(new Set()); anchor.current = -1 }, [])

  const toggleOne = (key: string, i: number) => {
    setSel(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    anchor.current = i
  }

  const selectRange = (from: number, to: number, additive: boolean) => {
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    const keys = songs.slice(lo, hi + 1).map(keyOf)
    setSel(prev => {
      const next = additive ? new Set(prev) : new Set<string>()
      keys.forEach(k => next.add(k))
      return next
    })
    anchor.current = to
  }

  const toggleAll = () => {
    if (allSel) clearSel()
    else { setSel(new Set(songs.map(keyOf))); anchor.current = -1 }
  }

  /* Ctrl+A 全选 / Esc 取消（输入框里不抢键） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSel(new Set(songs.map(keyOf)))
        anchor.current = -1
        return
      }
      if (e.key === 'Escape' && sel.size) clearSel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [songs, sel.size, clearSel])

  const playAll = useCallback((index = 0) => {
    if (!songs.length) return
    p.playList(toLocalTracks(songs), index)
  }, [songs, p])

  /** 行内播放：只播这一首，不把整个歌单塞进队列（「播放全部」才替换） */
  const playOne = useCallback((song: SearchSong) => {
    p.playOne(toLocalTrack(song))
  }, [p])

  const onRowClick = (sg: SearchSong, i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current >= 0) { selectRange(anchor.current, i, e.ctrlKey || e.metaKey); return }
    if (e.ctrlKey || e.metaKey) { toggleOne(keyOf(sg), i); return }
    // 已在多选状态时，单击改成「只选这一首」，避免误触直接换歌
    if (sel.size > 0) { setSel(new Set([keyOf(sg)])); anchor.current = i; return }
    playOne(sg)
  }

  const addAll = useCallback(() => {
    if (!songs.length) return
    p.addManyToQueue(toLocalTracks(songs), 'end')
  }, [songs, p])

  return (
    <div className="page sr-detail">
      <header className="sr-detail-head">
        <button className="ghost-btn sr-back" onClick={onBack}>← {backLabel}</button>
        <div className="sr-detail-hero">
          <div
            className="sr-detail-cover"
            style={cover ? { backgroundImage: `url(${cover})` } : undefined}
          />
          <div className="sr-detail-info">
            <div className="sr-detail-name">{detail?.name || name}</div>
            <div className="sr-detail-meta">
              <span className="sr-badge" data-src={source}>{platformName(source)}</span>
              {detail?.creator && <span>{detail.creator}</span>}
              <span className="num">{detail?.songCount ?? songs.length} 首</span>
            </div>
            <div className="sr-detail-acts">
              <button className="primary-btn" disabled={!songs.length} onClick={() => playAll(0)}>
                <IconPlay /> 播放全部
              </button>
              <button className="ghost-btn" disabled={!songs.length} onClick={addAll}>
                <IconPlus /> 加入队列
              </button>
              {!isDaily && (
                <button
                  className={'ghost-btn sr-favbtn' + (faved ? ' on' : '')}
                  aria-pressed={faved}
                  onClick={() => bookmarks.toggleFav({
                    source, id, name: detail?.name || name, cover,
                    songCount: detail?.songCount ?? songs.length, creator: detail?.creator,
                  })}
                >
                  <IconStar width={13} height={13} /> {faved ? '已收藏' : '收藏'}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {loading && <div className="sr-hint">{isDaily ? '正在取今天的推荐…' : '正在读取歌单…'}</div>}
      {error && <div className="empty-state">{error}</div>}

      {selSongs.length > 0 && (
        <div className="lib-batchbar" role="toolbar" aria-label="批量操作">
          <span className="bb-count">已选 <b className="num">{selSongs.length}</b> 首</span>
          <span className="bb-sep" aria-hidden="true" />
          <div className="bb-actions">
            <button className="bb-btn primary" onClick={() => p.playList(toLocalTracks(selSongs), 0)}>
              <IconPlay width={12} height={12} /> 播放
            </button>
            <button className="bb-btn" onClick={() => p.addManyToQueue(toLocalTracks(selSongs), 'next')}>
              <IconNext width={12} height={12} /> 下一首播放
            </button>
            <button className="bb-btn" onClick={() => p.addManyToQueue(toLocalTracks(selSongs), 'end')}>
              <IconPlus width={12} height={12} /> 加入播放列表
            </button>
            <button
              className="bb-btn"
              onClick={() => {
                // 同一首歌不同音质是独立任务，重复点不会重复入队（download 内部去重）
                selSongs.forEach(s => dl.download(toLocalTrack(s)))
                toast(`已加入下载队列 ${selSongs.length} 首，进度看「下载」页`, { ok: true })
              }}
            >
              <IconDownload width={12} height={12} /> 下载
            </button>
            <button
              className="bb-btn"
              onClick={() => setAddTo(toLocalTracks(selSongs).map(t => t.id))}
            >
              <IconMusicNote width={12} height={12} /> 加入其它歌单
            </button>
            <button
              className="bb-btn"
              onClick={() => {
                void navigator.clipboard?.writeText(
                  selSongs.map(s => `${s.name} - ${s.singer.join(' / ')}`).join('\n'))
                toast(`已复制 ${selSongs.length} 首的歌名`)
              }}
            >
              <IconLyric width={12} height={12} /> 复制信息
            </button>
          </div>
          <button className="icon-btn bb-clear" onClick={clearSel} aria-label="取消选择" title="取消选择 (Esc)">
            <IconClose width={13} height={13} />
          </button>
        </div>
      )}

      {!loading && !error && songs.length > 0 && (
        <div className="sr-pickhead">
          <button
            className={'cbx' + (allSel ? ' on' : '') + (someSel ? ' half' : '')}
            role="checkbox" aria-checked={allSel ? true : someSel ? 'mixed' : false}
            aria-label={allSel ? '取消全选' : '全选'}
            title={allSel ? '取消全选' : '全选（Ctrl + A）'}
            onClick={toggleAll}
          >
            {allSel ? <IconCheck width={10} height={10} /> : someSel ? <i className="cbx-dash" /> : null}
          </button>
          <span className="sr-pickhint">点击复选框多选 · Ctrl 点单首 · Shift 连选</span>
        </div>
      )}

      {!loading && !error && (
        <div className="sr-list">
          {songs.map((sg, i) => {
            const live = p.current?.id === `online:${sg.source}:${sg.id}`
            const key = keyOf(sg)
            const on = sel.has(key)
            return (
              <div
                key={`${sg.id}:${i}`}
                className={'sr-row' + (live ? ' live' : '') + (on ? ' selected' : '')}
                title="点击播放 · Ctrl 点多选 · 右键更多操作"
                onClick={e => { if (consumeLongPress()) return; onRowClick(sg, i, e) }}
                {...longPressProps(at => {
                  // 触摸屏没有右键：长按 = 选中这一行并弹出同一份菜单
                  setSel(new Set([key])); anchor.current = i
                  setMenu({ x: at.x, y: at.y, song: sg })
                })}
                onContextMenu={e => {
                  e.preventDefault()
                  // 右键一行要是没在多选里，先把选择切成这一行——跟资源管理器一致
                  if (!on) { setSel(new Set([key])); anchor.current = i }
                  setMenu({ x: e.clientX, y: e.clientY, song: sg })
                }}
              >
                <button
                  className={'cbx sr-cbx' + (on ? ' on' : '')}
                  role="checkbox" aria-checked={on} aria-label={'选中 ' + sg.name}
                  onClick={e => { e.stopPropagation(); toggleOne(key, i) }}
                >
                  {on && <IconCheck width={10} height={10} />}
                </button>
                <span className="sr-idx num">{i + 1}</span>
                <div className="sr-main">
                  <div className="sr-title">
                    {sg.name}
                    {live && <span className="eq-mini" />}
                  </div>
                  <div className="sr-meta">
                    <span>{sg.singer.join(' / ') || '未知歌手'}</span>
                    {sg.albumName && <span className="sr-dot">·</span>}
                    {sg.albumName && <span>{sg.albumName}</span>}
                  </div>
                </div>
                <span className="sr-badge sm" data-src={sg.source}>{platformName(sg.source)}</span>
                <span className="sr-dur num">{fmtTime(sg.interval)}</span>
                <div className="sr-acts">
                  <button className="icon-btn" title="播放" onClick={e => { e.stopPropagation(); playOne(sg) }}><IconPlay /></button>
                  <button
                    className="icon-btn"
                    title="下一首播放"
                    onClick={e => { e.stopPropagation(); p.addToQueue(toLocalTrack(sg), 'next') }}
                  >
                    <IconNext />
                  </button>
                  <button
                    className="icon-btn"
                    title="下载这首歌"
                    onClick={e => { e.stopPropagation(); dl.download(toLocalTrack(sg)) }}
                  >
                    <IconDownload />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {menu && (
        <OnlineSongMenu x={menu.x} y={menu.y} song={menu.song} onClose={() => setMenu(null)} />
      )}

      <AddToPlaylistDialog
        open={!!addTo}
        trackIds={addTo ?? []}
        onClose={() => { setAddTo(null); clearSel() }}
        onDone={text => toast(text, { ok: true })}
      />
    </div>
  )
}
