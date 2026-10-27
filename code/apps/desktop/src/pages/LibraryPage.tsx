/**
 * 本地音乐页：扫描（全部音乐 / 全盘 / 指定文件夹）+ 搜索 + 虚拟滚动列表。
 * 行内 ⋯ 与右键均打开同一套操作菜单；双击行打开歌曲详情。
 *
 * 多选：行首勾选框 / Ctrl(⌘) 点选 / Shift 区间 / 表头全选 / Ctrl+A；
 * 选中后出现批量工具条，可批量播放、加入队列、复制信息、移出曲库。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtTime, type LocalTrack } from '@shuyin/core'
import { usePlayer } from '../lib/PlayerProvider'
import { bridge, type ScanProgressPayload } from '../lib/bridge'
import { KEYS, settings } from '../lib/settings'
import { toast } from '../lib/toast'
import { consumeLongPress, longPressProps } from '../lib/longPress'
import { confirm } from '../lib/confirm'
import { Cover } from '../components/Cover'
import { VList } from '../components/VList'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { AddToPlaylistDialog } from '../components/AddToPlaylistDialog'
import {
  IconCheck, IconClose, IconFolder, IconLyric, IconMusicNote, IconNext, IconPlay, IconPlus,
  IconRefresh, IconSearch, IconTrash,
} from '../components/icons'

interface Props {
  onOpenDetail(track: LocalTrack): void
  /** 嵌在「我的」页面里时不再画自己的大标题，交给外层 */
  embedded?: boolean
  /** 外层滚动容器：给了就让列表跟着页面滚（不再自己套一层滚动条） */
  scrollParent?: React.RefObject<HTMLElement | null>
  /** 作为「我的」的子页打开时，左上角给一个返回 */
  onBack?: () => void
  backLabel?: string
}

export function LibraryPage({
  onOpenDetail, embedded = false, scrollParent, onBack, backLabel = '返回我的',
}: Props) {
  const p = usePlayer()
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; track: LocalTrack } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /** 「加入歌单」弹窗要处理的曲目 id（单首或批量） */
  const [addTo, setAddTo] = useState<string[] | null>(null)
  /** Shift 区间选择的锚点（filtered 里的下标） */
  const anchorRef = useRef(-1)
  /** 用户是否已经动过搜索框：动过就别被存档回填覆盖 */
  const queryTouched = useRef(false)
  const cur = p.current

  const progress: ScanProgressPayload | null = p.scanProgress

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return p.library
    return p.library.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q))
  }, [p.library, query])

  const selectedTracks = useMemo(
    () => filtered.filter(t => selected.has(t.id)),
    [filtered, selected],
  )
  const allChecked = filtered.length > 0 && selectedTracks.length === filtered.length
  const someChecked = selectedTracks.length > 0 && !allChecked

  const scopeLabel = p.scanScope === 'full' ? '全盘扫描' : p.scanScope === 'custom' ? '指定文件夹' : '音乐文件夹'

  const statusText = p.scanning
    ? (progress
        ? (progress.parsed > 0
            ? `正在解析元数据 ${progress.parsed} / ${progress.found}`
            : progress.currentDir || '正在查找音频文件…')
        : '正在扫描…')
    : p.library.length
      ? [
          `共 ${p.library.length} 首`,
          scopeLabel,
          p.lastSkipped > 0 ? `已过滤 ${p.lastSkipped} 个无效文件` : '',
          p.lastTruncated ? '扫描达上限已停止' : '',
          p.lastScanAt ? '上次扫描 ' + relTime(p.lastScanAt) : '',
        ].filter(Boolean).join(' · ')
      : '还没有扫描过本地音乐'

  /* 搜索词：跟上次一样，回来接着看 */
  useEffect(() => {
    void settings.get<string>(KEYS.uiQuery).then(v => {
      if (!queryTouched.current && typeof v === 'string') setQuery(v)
    })
  }, [])
  useEffect(() => {
    if (!queryTouched.current) return
    const id = window.setTimeout(() => void settings.set(KEYS.uiQuery, query), 400)
    return () => window.clearTimeout(id)
  }, [query])

  /* 曲库刷新后清掉已经不在库里的选中项 */
  useEffect(() => {
    setSelected(prev => {
      if (!prev.size) return prev
      const alive = new Set(p.library.map(t => t.id))
      const next = new Set([...prev].filter(id => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [p.library])

  /* ---------- 多选 ---------- */

  const clearSel = useCallback(() => {
    setSelected(new Set())
    anchorRef.current = -1
  }, [])

  const toggleOne = (id: string, index: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    anchorRef.current = index
  }

  const selectRange = (from: number, to: number, additive: boolean) => {
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    const ids = filtered.slice(lo, hi + 1).map(t => t.id)
    setSelected(prev => {
      const next = additive ? new Set(prev) : new Set<string>()
      ids.forEach(id => next.add(id))
      return next
    })
    anchorRef.current = to
  }

  const toggleAll = () => {
    if (allChecked) clearSel()
    else {
      setSelected(new Set(filtered.map(t => t.id)))
      anchorRef.current = -1
    }
  }

  /* Ctrl+A 全选 / Esc 取消（输入框内不抢键） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSelected(new Set(filtered.map(t => t.id)))
        anchorRef.current = -1
        return
      }
      if (e.key === 'Escape' && selected.size) clearSel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filtered, selected.size, clearSel])

  const onRowClick = (t: LocalTrack, i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchorRef.current >= 0) {
      selectRange(anchorRef.current, i, e.ctrlKey || e.metaKey)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      toggleOne(t.id, i)
      return
    }
    // 已在多选状态时，单击变成「只选这一首」，避免误触直接切歌
    if (selected.size > 0) {
      setSelected(new Set([t.id]))
      anchorRef.current = i
      return
    }
    p.playList(filtered, i)
  }

  /* ---------- 批量操作 ---------- */

  const copySelected = () => {
    const text = selectedTracks.map(t => `${t.title} - ${t.artist}`).join('\n')
    void navigator.clipboard?.writeText(text)
  }

  const removeSelected = async () => {
    const n = selectedTracks.length
    if (!n) return
    if (n > 1) {
      const ok = await confirm({
        title: `从曲库移除 ${n} 首歌曲？`,
        message: '只会移出曲库，不会删除磁盘上的文件。',
        confirmText: '移除',
        danger: true,
      })
      if (!ok) return
    }
    await p.removeTracks(selectedTracks.map(t => t.id))
    clearSel()
  }

  const addFolder = async () => {
    const dir = await bridge.pickMusicFolder()
    if (!dir) return
    const saved = (await settings.get<string[]>(KEYS.scanDirs)) ?? []
    const dirs = Array.from(new Set([...saved, dir]))
    await p.scan('custom', dirs)
  }

  const buildMenu = useCallback((track: LocalTrack, index: number): MenuItem[] => [
    { id: 'play', label: '播放', icon: <IconPlay width={14} height={14} />, onSelect: () => p.playList(filtered, index) },
    { id: 'next', label: '下一首播放', icon: <IconNext width={14} height={14} />, onSelect: () => p.addToQueue(track, 'next') },
    { id: 'queue', label: '加入播放列表', icon: <IconPlus width={14} height={14} />, onSelect: () => p.addToQueue(track, 'end') },
    { id: 'addpl', label: '加入歌单…', icon: <IconMusicNote width={14} height={14} />, onSelect: () => setAddTo([track.id]) },
    { id: 'd1', label: '', divider: true, onSelect: () => {} },
    { id: 'detail', label: '歌曲详情', icon: <IconLyric width={14} height={14} />, onSelect: () => onOpenDetail(track) },
    { id: 'reveal', label: '在文件夹中显示', icon: <IconFolder width={14} height={14} />, onSelect: () => void bridge.revealInFolder(track.path) },
    {
      id: 'copy', label: '复制歌曲信息', icon: <IconLyric width={14} height={14} />,
      onSelect: () => { void navigator.clipboard?.writeText(`${track.title} - ${track.artist}`) },
    },
    { id: 'd2', label: '', divider: true, onSelect: () => {} },
    {
      id: 'remove', label: '从曲库移除', danger: true, icon: <IconTrash width={14} height={14} />,
      onSelect: () => void p.removeTrack(track.id),
    },
  ], [filtered, onOpenDetail, p])

  return (
    <div className={'page library-page' + (embedded ? ' embedded' : '')}>
      {onBack && (
        <button className="ghost-btn lib-back" onClick={onBack}>← {backLabel}</button>
      )}
      <header className={'lib-head' + (embedded ? ' compact' : '')}>
        <div className="lib-head-left">
          {embedded ? <p className="lib-status">{statusText}</p> : <h1>本地音乐</h1>}
          {!embedded && <p className="lib-status">{statusText}</p>}
        </div>
        <div className="lib-actions">
          <button className="primary-btn" onClick={() => void p.scan('fast')} disabled={p.scanning}>
            <IconRefresh width={14} height={14} /> 扫描全部音乐
          </button>
          <button className="ghost-btn" onClick={() => void p.scan('full')} disabled={p.scanning}
            title="扫描所有磁盘（自动跳过系统目录）">
            全盘扫描
          </button>
          <button className="ghost-btn" onClick={() => void addFolder()} disabled={p.scanning}>
            <IconFolder width={14} height={14} /> 添加文件夹
          </button>
          <div className="search-box">
            <IconSearch width={14} height={14} />
            <input
              className="text-input" placeholder="搜索本地曲库（按 / 聚焦）"
              value={query}
              onChange={e => { queryTouched.current = true; setQuery(e.target.value) }}
              aria-label="搜索本地曲库"
            />
          </div>
        </div>
      </header>

      {p.scanning && (
        <div className="scan-banner" role="status">
          <div className="scan-bar"><i style={{ width: progress && progress.found > 0 ? Math.min(96, (progress.parsed / Math.max(1, progress.found)) * 100) + '%' : '18%' }} /></div>
          <span className="scan-text">{progress?.currentDir || '正在扫描…'}</span>
        </div>
      )}

      {selectedTracks.length > 0 && (
        <div className="lib-batchbar" role="toolbar" aria-label="批量操作">
          <span className="bb-count">已选 <b className="num">{selectedTracks.length}</b> 首</span>
          <span className="bb-sep" aria-hidden="true" />
          <div className="bb-actions">
            <button className="bb-btn primary" onClick={() => p.playList(selectedTracks, 0)}>
              <IconPlay width={12} height={12} /> 播放
            </button>
            <button className="bb-btn" onClick={() => p.addManyToQueue(selectedTracks, 'next')}>
              <IconNext width={12} height={12} /> 下一首播放
            </button>
            <button className="bb-btn" onClick={() => p.addManyToQueue(selectedTracks, 'end')}>
              <IconPlus width={12} height={12} /> 加入播放列表
            </button>
            <button className="bb-btn" onClick={() => setAddTo(selectedTracks.map(t => t.id))}>
              <IconMusicNote width={12} height={12} /> 加入歌单
            </button>
            <button className="bb-btn" onClick={copySelected}>
              <IconLyric width={12} height={12} /> 复制信息
            </button>
            <button className="bb-btn danger" onClick={() => void removeSelected()}>
              <IconTrash width={12} height={12} /> 从曲库移除
            </button>
          </div>
          <button className="icon-btn bb-clear" onClick={clearSel} aria-label="取消选择" title="取消选择 (Esc)">
            <IconClose width={13} height={13} />
          </button>
        </div>
      )}

      {p.library.length === 0 && !p.scanning && (
        <div className="empty-state">
          <div className="title">曲库还是空的</div>
          <div className="sub">点「扫描全部音乐」会自动查找系统音乐文件夹；也可以全盘扫描或指定文件夹</div>
          <div className="empty-actions">
            <button className="primary-btn" onClick={() => void p.scan('fast')}><IconRefresh width={14} height={14} /> 扫描全部音乐</button>
            <button className="ghost-btn" onClick={() => void p.scan('full')}>全盘扫描</button>
          </div>
          <div className="sub">支持 MP3 / AAC / M4A / FLAC / WAV / OGG / Opus</div>
        </div>
      )}

      {(p.scanning || p.library.length > 0) && (
        <>
          <div className="lib-table-head">
            <span className="col-check">
              <button
                className={'cbx' + (allChecked ? ' on' : '') + (someChecked ? ' half' : '')}
                role="checkbox" aria-checked={allChecked ? true : someChecked ? 'mixed' : false}
                aria-label={allChecked ? '取消全选' : '全选'}
                title={allChecked ? '取消全选' : '全选（Ctrl+A）'}
                onClick={toggleAll}
              >
                {allChecked ? <IconCheck width={10} height={10} /> : someChecked ? <i className="cbx-dash" /> : null}
              </button>
            </span>
            <span className="col-idx num">#</span>
            <span className="col-cover" />
            <span className="col-title">标题</span>
            <span className="col-artist">歌手 · 专辑</span>
            <span className="col-fmt">格式</span>
            <span className="col-dur">时长</span>
            <span className="col-more" />
          </div>
          <VList
            items={filtered}
            rowHeight={60}
            scrollParent={scrollParent}
            getKey={t => t.id}
            renderRow={(t, i) => (
              <TrackRow
                key={t.id}
                track={t}
                index={i}
                playing={cur?.id === t.id}
                checked={selected.has(t.id)}
                onCheck={() => toggleOne(t.id, i)}
                onRowClick={e => (selected.size > 0 ? toggleOne(t.id, i) : onRowClick(t, i, e))}
                onDetail={() => onOpenDetail(t)}
                onMenu={e => setMenu({ x: e.clientX, y: e.clientY, track: t })}
              />
            )}
            empty={<div className="empty-state">
              <div className="title">没有找到「{query}」相关的歌曲</div>
              <div className="sub">试试其他关键词</div>
            </div>}
          />
        </>
      )}

      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y}
          items={buildMenu(menu.track, Math.max(0, filtered.findIndex(t => t.id === menu.track.id)))}
          onClose={() => setMenu(null)}
        />
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

function TrackRow({ track, index, playing, checked, onCheck, onRowClick, onDetail, onMenu }: {
  track: LocalTrack
  index: number
  playing: boolean
  checked: boolean
  onCheck(): void
  onRowClick(e: React.MouseEvent): void
  onDetail(): void
  onMenu(e: React.MouseEvent): void
}) {
  return (
    <div
      className={'track-row' + (playing ? ' playing' : '') + (checked ? ' selected' : '') + (index % 2 === 1 ? ' zebra' : '')}
      {...longPressProps(onCheck)}
      onClick={e => { if (consumeLongPress()) return; onRowClick(e) }}
      onDoubleClick={onDetail}
      onContextMenu={e => { e.preventDefault(); onMenu(e) }}
      title="单击播放 · 双击查看详情 · 长按多选 · 右键更多操作"
    >
      <span className="col-check">
        <button
          className={'cbx' + (checked ? ' on' : '')}
          role="checkbox" aria-checked={checked}
          aria-label={(checked ? '取消选择 ' : '选择 ') + track.title}
          onClick={e => { e.stopPropagation(); onCheck() }}
        >
          {checked && <IconCheck width={10} height={10} />}
        </button>
      </span>
      <span className="col-idx">
        {playing
          ? <span className="eq-mini" aria-hidden="true"><i /><i /><i /></span>
          : <span className="num idx-t">{String(index + 1).padStart(2, '0')}</span>}
      </span>
      <Cover track={track} size={48} radius={10} />
      <span className="col-title"><span className="t-name">{track.title}</span></span>
      <span className="col-artist">{track.artist} · {track.album}</span>
      <span className="col-fmt"><span className="pill">{track.format}</span></span>
      <span className="col-dur num">{fmtTime(track.duration)}</span>
      <button
        className="row-more icon-btn"
        aria-label={'更多操作：' + track.title}
        onClick={e => { e.stopPropagation(); onMenu(e) }}
      >
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <g fill="currentColor"><circle cx="4" cy="9" r="1.3" /><circle cx="9" cy="9" r="1.3" /><circle cx="14" cy="9" r="1.3" /></g>
        </svg>
      </button>
    </div>
  )
}

function relTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}
