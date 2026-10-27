/**
 * 本地歌单详情：一个歌单里到底有哪些歌。
 *
 * 曲目只存曲库 id，渲染时按顺序查曲库——文件被移走/删掉就自然不显示（并提示缺几首），
 * 不会出现「点了没反应」的幽灵条目。
 *
 * 导入歌单里「曲库里没有」的歌单独列在下方：那些是用户原本想听、
 * 但本地还没有的，留着比直接丢掉有用得多。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtTime, type LocalTrack } from '@shuyin/core'
import { usePlayer } from '../lib/PlayerProvider'
import { usePlaylists, mosaicOf } from '../lib/localPlaylists'
import { Cover } from '../components/Cover'
import { Modal } from '../components/Modal'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { AddToPlaylistDialog } from '../components/AddToPlaylistDialog'
import { toast } from '../lib/toast'
import { confirm } from '../lib/confirm'
import { consumeLongPress, longPressProps } from '../lib/longPress'
import { bridge } from '../lib/bridge'
import {
  IconCheck, IconClose, IconFolder, IconLyric, IconMusicNote, IconNext, IconPlay, IconPlus,
  IconSearch, IconTrash,
} from '../components/icons'

interface Props {
  id: string
  onBack(): void
  onOpenDetail(t: LocalTrack): void
}

export function LocalPlaylistPage({ id, onBack, onOpenDetail }: Props) {
  const p = usePlayer()
  const pl = usePlaylists()
  const list = pl.lists.find(x => x.id === id)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  /* 列表里的多选：Ctrl 点单选、Shift 点连选，右键出菜单 */
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const anchor = useRef(-1)
  const [menu, setMenu] = useState<{ x: number; y: number; track: LocalTrack; index: number } | null>(null)
  const [addTo, setAddTo] = useState<string[] | null>(null)

  const tracks = useMemo(() => (list ? pl.tracksOf(list, p.library) : []), [list, pl, p.library])
  const total = tracks.reduce((n, t) => n + t.duration, 0)
  const mosaic = useMemo(() => mosaicOf(tracks, 4), [tracks])
  const missing = list?.missing ?? []
  const selTracks = useMemo(() => tracks.filter(t => sel.has(t.id)), [tracks, sel])
  const allSel = tracks.length > 0 && selTracks.length === tracks.length
  const someSel = selTracks.length > 0 && !allSel

  const clearSel = useCallback(() => { setSel(new Set()); anchor.current = -1 }, [])

  const toggleOne = (id: string, index: number) => {
    setSel(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    anchor.current = index
  }

  const selectRange = (from: number, to: number, additive: boolean) => {
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    const ids = tracks.slice(lo, hi + 1).map(t => t.id)
    setSel(prev => {
      const next = additive ? new Set(prev) : new Set<string>()
      ids.forEach(id => next.add(id))
      return next
    })
    anchor.current = to
  }

  const toggleAll = () => {
    if (allSel) clearSel()
    else { setSel(new Set(tracks.map(t => t.id))); anchor.current = -1 }
  }

  /* Ctrl+A 全选 / Esc 取消（输入框里不抢键） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSel(new Set(tracks.map(t => t.id)))
        anchor.current = -1
        return
      }
      if (e.key === 'Escape' && sel.size) clearSel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tracks, sel.size, clearSel])

  const onRowClick = (t: LocalTrack, i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current >= 0) { selectRange(anchor.current, i, e.ctrlKey || e.metaKey); return }
    if (e.ctrlKey || e.metaKey) { toggleOne(t.id, i); return }
    // 已在多选状态时，单击改成「只选这一首」，避免误触直接切歌
    if (sel.size > 0) { setSel(new Set([t.id])); anchor.current = i; return }
    p.playList(tracks, i)
  }

  const removeSel = async () => {
    if (!list || !selTracks.length) return
    const n = selTracks.length
    if (n > 1) {
      const ok = await confirm({
        title: `从歌单移除 ${n} 首？`,
        message: '只从这个歌单里拿掉，歌还在曲库里。',
        confirmText: '移除',
        danger: true,
      })
      if (!ok) return
    }
    selTracks.forEach(t => pl.removeTrack(list.id, t.id))
    clearSel()
    toast(`已从歌单移除 ${n} 首`)
  }

  const rowMenu = (t: LocalTrack, i: number): MenuItem[] => [
    { id: 'play', label: '播放', icon: <IconPlay width={14} height={14} />, onSelect: () => p.playList(tracks, i) },
    { id: 'next', label: '下一首播放', icon: <IconNext width={14} height={14} />, onSelect: () => p.addToQueue(t, 'next') },
    { id: 'queue', label: '加入播放列表', icon: <IconPlus width={14} height={14} />, onSelect: () => p.addToQueue(t, 'end') },
    { id: 'addpl', label: '加入其它歌单…', icon: <IconMusicNote width={14} height={14} />, onSelect: () => setAddTo([t.id]) },
    { id: 'd1', label: '', divider: true, onSelect: () => {} },
    { id: 'detail', label: '歌曲详情', icon: <IconLyric width={14} height={14} />, onSelect: () => onOpenDetail(t) },
    { id: 'reveal', label: '在文件夹中显示', icon: <IconFolder width={14} height={14} />, onSelect: () => void bridge.revealInFolder(t.path) },
    {
      id: 'copy', label: '复制歌曲信息', icon: <IconLyric width={14} height={14} />,
      onSelect: () => { void navigator.clipboard?.writeText(`${t.title} - ${t.artist}`) },
    },
    { id: 'd2', label: '', divider: true, onSelect: () => {} },
    { id: 'rm', label: '从歌单移除', danger: true, icon: <IconTrash width={14} height={14} />, onSelect: () => { if (list) pl.removeTrack(list.id, t.id) } },
  ]

  /** 添加歌曲的候选：曲库去掉已在歌单里的 */
  const candidates = useMemo(() => {
    const have = new Set(list?.trackIds ?? [])
    const q = query.trim().toLowerCase()
    return p.library
      .filter(t => !have.has(t.id))
      .filter(t => !q || t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q))
      .slice(0, 200)
  }, [p.library, list, query])

  const addPicked = useCallback(() => {
    if (!list || !picked.size) return
    pl.addTracks(list.id, [...picked])
    setPicked(new Set())
    setPicking(false)
  }, [list, picked, pl])

  if (!list) {
    return (
      <div className="page home-page">
        <header className="lib-head">
          <div className="lib-head-left">
            <h1>歌单不存在</h1>
            <p className="lib-status">它可能已经被删掉了</p>
          </div>
          <button className="ghost-btn" onClick={onBack}>← 返回我的</button>
        </header>
      </div>
    )
  }

  return (
    <div className="page home-page pl-detail">
      <header className="plp-head">
        <button className="ghost-btn plp-back" onClick={onBack}>← 我的</button>
        <div className="plp-hero">
          <div className="plp-cover">
            {mosaic.length ? (
              <div className={'home-mosaic n' + mosaic.length}>
                {mosaic.map((src, i) => <img key={i} src={src} alt="" decoding="async" />)}
              </div>
            ) : <span className="home-cover-blank"><IconMusicNote width={26} height={26} /></span>}
          </div>
          <div className="plp-info">
            <div className="plp-kind">{list.origin === 'import' ? `导入自 ${list.originName ?? '歌单文件'}` : '自建歌单'}</div>
            <h1 className="plp-name">{list.name}</h1>
            {list.note && <div className="plp-note">{list.note}</div>}
            <div className="plp-meta">
              <span className="num">{tracks.length} 首</span>
              {total > 0 && <span className="num"> · {fmtTime(total)}</span>}
              {missing.length > 0 && <span className="home-miss"> · 缺 {missing.length} 首</span>}
            </div>
            <div className="plp-acts">
              <button className="primary-btn" disabled={!tracks.length} onClick={() => p.playList(tracks, 0)}>
                <IconPlay width={13} height={13} /> 播放全部
              </button>
              <button className="ghost-btn" disabled={!tracks.length} onClick={() => p.addManyToQueue(tracks, 'next')}>
                <IconNext width={13} height={13} /> 下一首播放
              </button>
              <button className="ghost-btn" onClick={() => { setPicked(new Set()); setQuery(''); setPicking(true) }}>
                <IconPlus width={13} height={13} /> 添加歌曲
              </button>
              <button className="ghost-btn" onClick={() => { setDraft(list.name); setRenaming(true) }}>重命名</button>
              <button
                className="ghost-btn danger"
                onClick={() => {
                  void confirm({
                    title: `删除歌单「${list.name}」？`,
                    message: '只删这个歌单，歌还在曲库里。',
                    confirmText: '删除',
                    danger: true,
                  }).then(ok => {
                    if (!ok) return
                    pl.remove(list.id)
                    onBack()
                  })
                }}
              >
                <IconTrash width={13} height={13} /> 删除
              </button>
            </div>
          </div>
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
            <button className="bb-btn" onClick={() => p.addManyToQueue(selTracks, 'next')}>
              <IconNext width={12} height={12} /> 下一首播放
            </button>
            <button className="bb-btn" onClick={() => p.addManyToQueue(selTracks, 'end')}>
              <IconPlus width={12} height={12} /> 加入播放列表
            </button>
            <button className="bb-btn" onClick={() => setAddTo(selTracks.map(t => t.id))}>
              <IconMusicNote width={12} height={12} /> 加入其它歌单
            </button>
            <button className="bb-btn" onClick={() => {
              void navigator.clipboard?.writeText(selTracks.map(t => `${t.title} - ${t.artist}`).join('\n'))
              toast(`已复制 ${selTracks.length} 首的歌名`)
            }}>
              <IconLyric width={12} height={12} /> 复制信息
            </button>
            <button className="bb-btn danger" onClick={removeSel}>
              <IconTrash width={12} height={12} /> 从歌单移除
            </button>
          </div>
          <button className="icon-btn bb-clear" onClick={clearSel} aria-label="取消选择" title="取消选择 (Esc)">
            <IconClose width={13} height={13} />
          </button>
        </div>
      )}

      {tracks.length === 0 ? (
        <div className="empty-state">
          <div className="title">这个歌单还是空的</div>
          <div className="sub">点「添加歌曲」从本地曲库里挑；也可以等导入的歌单匹配上</div>
          <div className="empty-actions">
            <button className="primary-btn" onClick={() => { setPicked(new Set()); setQuery(''); setPicking(true) }}>
              <IconPlus width={13} height={13} /> 添加歌曲
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="plp-listhead">
            <button
              className={'cbx' + (allSel ? ' on' : '') + (someSel ? ' half' : '')}
              role="checkbox" aria-checked={allSel ? true : someSel ? 'mixed' : false}
              aria-label={allSel ? '取消全选' : '全选'}
              title={allSel ? '取消全选' : '全选（Ctrl+A）'}
              onClick={toggleAll}
            >
              {allSel ? <IconCheck width={10} height={10} /> : someSel ? <i className="cbx-dash" /> : null}
            </button>
            <span className="plp-idx num">#</span>
            <span className="plp-covercol" />
            <span className="plp-titlecol">标题</span>
            <span className="plp-dur">时长</span>
            <span className="plp-rmcol" />
          </div>
          <div className="plp-list">
            {tracks.map((t, i) => {
              const live = p.current?.id === t.id
              const on = sel.has(t.id)
              return (
                <div
                  key={t.id}
                  className={'plp-row' + (live ? ' live' : '') + (on ? ' selected' : '')}
                  {...longPressProps(() => toggleOne(t.id, i))}
                  onClick={e => { if (consumeLongPress()) return; onRowClick(t, i, e) }}
                  onDoubleClick={() => onOpenDetail(t)}
                  onContextMenu={e => {
                    e.preventDefault()
                    // 右键一行要是没在多选里，先把选择切成这一行——跟资源管理器一致
                    if (!on) { setSel(new Set([t.id])); anchor.current = i }
                    setMenu({ x: e.clientX, y: e.clientY, track: t, index: i })
                  }}
                  title="单击播放 · Ctrl 点多选 · 右键更多"
                >
                  <button
                    className={'cbx plp-cbx' + (on ? ' on' : '')}
                    role="checkbox" aria-checked={on} aria-label={'选中 ' + t.title}
                    onClick={e => { e.stopPropagation(); toggleOne(t.id, i) }}
                  >
                    {on && <IconCheck width={10} height={10} />}
                  </button>
                  <span className="plp-idx num">{live ? <span className="eq-mini"><i /><i /><i /></span> : String(i + 1).padStart(2, '0')}</span>
                  <Cover track={t} size={38} radius={8} />
                  <span className="plp-main">
                    <span className="plp-title">{t.title}</span>
                    <span className="plp-sub">{t.artist} · {t.album}</span>
                  </span>
                  <span className="pill">{t.format}</span>
                  <span className="plp-dur num">{fmtTime(t.duration)}</span>
                  <button
                    className="icon-btn plp-rm" aria-label={'从歌单移除 ' + t.title}
                    title="从歌单移除（不会删文件）"
                    onClick={e => { e.stopPropagation(); pl.removeTrack(list.id, t.id) }}
                  >
                    <IconClose width={13} height={13} />
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}

      {missing.length > 0 && (
        <section className="plp-missing">
          <div className="plp-missing-head">
            曲库里还没有的 <b className="num">{missing.length}</b> 首
          </div>
          <div className="plp-missing-list">
            {missing.map((m, i) => (
              <div className="plp-miss-row" key={m.title + m.artist + i}>
                <span className="plp-miss-idx num">{String(i + 1).padStart(2, '0')}</span>
                <span className="plp-miss-name">{m.title}</span>
                <span className="plp-miss-artist">{m.artist || '未知歌手'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <Modal
        open={picking}
        title="添加到歌单"
        hint={`已选 ${picked.size} 首`}
        onClose={() => setPicking(false)}
        width={560}
        footer={
          <>
            <span className="modal-note">{candidates.length} 首可选</span>
            <button className="ghost-btn" onClick={() => setPicking(false)}>取消</button>
            <button className="primary-btn" disabled={!picked.size} onClick={addPicked}>
              加入 {picked.size || ''} 首
            </button>
          </>
        }
      >
        <div className="search-box atp-search">
          <IconSearch width={14} height={14} />
          <input
            className="text-input" placeholder="搜索本地曲库" autoFocus
            value={query} onChange={e => setQuery(e.target.value)}
          />
        </div>
        <div className="atp-picklist">
          {candidates.length === 0 && <div className="atp-empty">曲库里没有可加的歌了</div>}
          {candidates.map(t => {
            const on = picked.has(t.id)
            return (
              <button
                key={t.id}
                className={'atp-pickrow' + (on ? ' on' : '')}
                onClick={() => setPicked(prev => {
                  const n = new Set(prev)
                  if (n.has(t.id)) n.delete(t.id)
                  else n.add(t.id)
                  return n
                })}
              >
                <span className={'cbx' + (on ? ' on' : '')} aria-hidden="true" />
                <Cover track={t} size={32} radius={7} />
                <span className="atp-pickmain">
                  <span className="atp-pickname">{t.title}</span>
                  <span className="atp-picksub">{t.artist}</span>
                </span>
                <span className="num atp-pickdur">{fmtTime(t.duration)}</span>
              </button>
            )
          })}
        </div>
      </Modal>

      <Modal
        open={renaming}
        title="重命名歌单"
        onClose={() => setRenaming(false)}
        width={380}
        footer={
          <>
            <button className="ghost-btn" onClick={() => setRenaming(false)}>取消</button>
            <button
              className="primary-btn" disabled={!draft.trim()}
              onClick={() => { pl.rename(list.id, draft); setRenaming(false) }}
            >
              保存
            </button>
          </>
        }
      >
        <input
          className="text-input" autoFocus maxLength={60} value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) { pl.rename(list.id, draft); setRenaming(false) } }}
        />
      </Modal>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={rowMenu(menu.track, menu.index)} onClose={() => setMenu(null)} />
      )}

      <AddToPlaylistDialog
        open={!!addTo}
        trackIds={addTo ?? []}
        onClose={() => setAddTo(null)}
        onDone={text => toast(text, { ok: true })}
      />
    </div>
  )
}
