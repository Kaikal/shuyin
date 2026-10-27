/**
 * 全局框架：侧栏（240px 可折叠）+ 底部悬浮玻璃播放条 + 队列抽屉。
 * 布局尺寸严格按设计规范：播放条高 72、距底 16、圆角 20、左右各距 16。
 * 播放条第二行显示当前歌词行（无歌词回落为「歌手 · 专辑」）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtTime } from '@shuyin/core'
import { usePlayer } from '../lib/PlayerProvider'
import { qualityChoicesFor, qualityLabel } from '../lib/online'
import { ChipMenu } from './ChipMenu'
import { useTheme } from '../lib/ThemeProvider'
import { lyricAt } from '../lib/lyrics'
import { Cover } from './Cover'
import {
  IconChevronUp, IconClose, IconCog, IconDesktopLyric, IconDownloads, IconGrip, IconInfo, IconNext,
  IconPause, IconPlay, IconPlaylist, IconPrev, IconQueue, IconRepeat, IconSearch, IconSequence,
  IconShuffle, IconUser, IconVolume, IconVolumeLow, IconVolumeMute,
} from './icons'

/* ------------------------------------------------------------------ */
/* 播放条                                                              */
/* ------------------------------------------------------------------ */

export function PlayBar({ onOpenQueue, queueOpen, onOpenNow, onOpenDetail, onOpenLyrics, lyricsOn }: {
  onOpenQueue(): void
  queueOpen: boolean
  onOpenNow(): void
  onOpenDetail(): void
  onOpenLyrics(): void
  lyricsOn: boolean
}) {
  const p = usePlayer()
  const t = p.current
  const { tokens } = useTheme()
  const repeat = p.queueState.repeat
  const RepeatIcon = repeat === 'one' ? IconRepeat : repeat === 'shuffle' ? IconShuffle : IconSequence

  const lyricLine = useMemo(() => lyricAt(p.lyrics, p.snapshot.position)?.text ?? null, [p.lyrics, p.snapshot.position])

  return (
    <div className="playbar glass themed" data-glass-degraded={tokens.glassBlur === 0}>
      {/* 主流播放器习惯：点封面/标题展开沉浸式播放页 */}
      <div className="pb-left" onClick={onOpenNow} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter') onOpenNow() }}
        title="展开播放页">
        {t
          ? <><span className="pb-cover-wrap">
                <Cover track={t} size={44} radius={8} />
                <span className="pb-expand" aria-hidden="true"><IconChevronUp /></span>
              </span>
              <div className="pb-meta">
                <div className="pb-name on-glass">
                  {t.title}
                  {/* 在线曲目必须标出来：出问题时用户才知道该点「换源」而不是以为本地文件坏了 */}
                  {p.online && (
                    <span
                      className="pb-src"
                      title={p.onlineSource
                        ? `音源：${p.onlineSource}${p.onlineVia ? ` · 平台：${p.onlineVia}` : ''}`
                        : '正在获取音源'}
                    >
                      {/* 跨平台兜底后这里显示「平台 · 音源」，用户才知道实际是从哪儿放的 */}
                      {p.onlineBusy ? '取链中…' : (p.onlineVia ?? p.onlineSource ?? '在线')}
                    </span>
                  )}
                </div>
                <div className="pb-sub on-glass">
                  {p.loading
                    ? '正在加载…'
                    : p.onlineBusy ? '正在解析播放地址…' : (lyricLine ?? `${p.onlineActual?.singer || t.artist} · ${t.album}`)}
                </div>
              </div></>
          : <div className="pb-meta">
              <div className="pb-name on-glass" style={{ color: 'var(--sy-text-3)' }}>未在播放</div>
              <div className="pb-sub on-glass">从本地音乐里选一首吧</div>
            </div>}
      </div>

      <div className="pb-mid">
        <div className="pb-ctl">
          <button className="icon-btn" aria-label="循环模式" onClick={p.cycleMode}
            title={repeat === 'sequence' ? '顺序播放' : repeat === 'one' ? '单曲循环' : '随机播放'}>
            <RepeatIcon width={16} height={16} style={{ color: repeat !== 'sequence' ? 'var(--sy-accent-soft)' : undefined }} />
          </button>
          <button className="icon-btn" aria-label="上一首" onClick={p.prev} disabled={!t}><IconPrev /></button>
          <button className="play-primary" aria-label={p.loading ? '正在加载' : p.snapshot.playing ? '暂停' : '播放'}
            aria-busy={p.loading} onClick={p.togglePlay} disabled={!t}>
            {p.loading
              ? <span className="spin-ring" aria-hidden="true" />
              : p.snapshot.playing ? <IconPause /> : <IconPlay />}
          </button>
          <button className="icon-btn" aria-label="下一首" onClick={p.next} disabled={!t}><IconNext /></button>
          <VolumeControl />
        </div>
        <ProgressControl />
      </div>

      {/* 手机迷你条 v2 的右侧两键（Lumen §7.5：播放/暂停 + 播放列表）。
          桌面那排大控制键在手机上整组隐藏，所以播放键必须在这里补一份。
          桌面布局由 mobile.css 隐藏，只在 phone 形态出现 */}
      <div className="pb-mini-acts">
        <button className="play-primary" aria-label={p.loading ? '正在加载' : p.snapshot.playing ? '暂停' : '播放'}
          aria-busy={p.loading} onClick={p.togglePlay} disabled={!t}>
          {p.loading
            ? <span className="spin-ring" aria-hidden="true" />
            : p.snapshot.playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="icon-btn" data-panel-toggle aria-label="播放列表" title="播放列表"
          aria-expanded={queueOpen} onClick={onOpenQueue}>
          <IconQueue />
        </button>
      </div>

      <div className="pb-right">
        {p.online && (
          /* 原生 select 的下拉列表是系统白底，跟主题完全两个世界；
             换成自绘芯片后，样式、置灰、当前项打勾全都跟播放页一致 */
          <ChipMenu
            label="音质"
            value={p.onlineBusy ? '取链中' : p.onlineQuality ? qualityLabel(p.onlineQuality) : '—'}
            activeId={p.onlineQuality ?? undefined}
            disabled={p.onlineBusy}
            alignEnd
            /* 播放条贴在窗口底部：向下弹会把列表推出屏幕（只露出第一项、还压在页面内容下面，
               看起来就是「下拉框选不到」）。这里必须向上展开 */
            up
            width={200}
            title="音质：这里显示的是**正在播**的档位。某一档取不到会自动降到下一档，不用你再点一次"
            options={[
              // 当前实际生效的档位不在可用列表里（音源降级到了别的档）也要能显示出来
              ...(p.onlineQuality && !p.onlineQualities.includes(p.onlineQuality)
                ? [{ id: p.onlineQuality, name: qualityLabel(p.onlineQuality), note: p.onlineQuality }]
                : []),
              ...qualityChoicesFor(p.onlineQualities).map(q => ({
                id: q,
                name: qualityLabel(q),
                note: q,
              })),
            ]}
            onPick={q => p.changeQuality(q)}
          />
        )}
        {p.online && (
          <button
            className="ghost-btn pb-switch"
            onClick={p.switchSource}
            disabled={p.onlineBusy}
            title="当前音源取不到链接时，换下一个音源再试"
          >
            {p.onlineBusy ? '取链中' : '换源'}
          </button>
        )}
        <button className="icon-btn" data-panel-toggle aria-label="桌面歌词" title="桌面歌词"
          aria-pressed={lyricsOn} onClick={onOpenLyrics} disabled={!t}>
          <IconDesktopLyric width={16} height={16} style={{ color: lyricsOn ? 'var(--sy-accent-soft)' : undefined }} />
        </button>
        <button className="icon-btn" data-panel-toggle aria-label="歌曲详情" title="歌曲详情" onClick={onOpenDetail} disabled={!t}>
          <IconInfo />
        </button>
        <button className="icon-btn" data-panel-toggle aria-label="播放列表" title="播放列表 (Q)"
          aria-expanded={queueOpen} onClick={onOpenQueue}>
          <IconQueue />
        </button>
      </div>
    </div>
  )
}

/*
 * dock 音量：平时只露一颗图标，滑杆悬停才展开；滚轮直接调，不用展开。
 * 图标分三档（静音 / 小声 / 正常）——调完看一眼图标就知道成没成。
 */
function VolumeControl() {
  const p = usePlayer()
  const [muted, setMuted] = useState(false)
  const vol = muted ? 0 : p.snapshot.volume
  const wrapRef = useRef<HTMLSpanElement>(null)
  /*
   * 滚轮调音量。
   *
   * React 的 onWheel 挂在根节点、默认 passive，里面的 preventDefault 是空操作——
   * 页面会跟着一起滚。所以这里挂原生非 passive 监听，只在本控件上生效。
   * 往上滚大声、往下滚小声；两个方向都先解除静音（不然「调了没反应」）。
   */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const d = e.deltaY < 0 ? 0.05 : -0.05
      setMuted(false)
      p.setVolume(Math.min(1, Math.max(0, p.snapshot.volume + d)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [p])
  return (
    <span className="vol-wrap" ref={wrapRef} title="音量：悬停拖动，也可以直接用滚轮">
      <button className="icon-btn" aria-label={muted ? '取消静音' : '静音'} onClick={() => setMuted(m => !m)}>
        {vol === 0 ? <IconVolumeMute width={16} height={16} />
          : vol < 0.5 ? <IconVolumeLow width={16} height={16} />
            : <IconVolume width={16} height={16} />}
      </button>
      <input
        className="slider vol-slider" type="range" min={0} max={1} step={0.01} value={vol}
        aria-label="音量"
        onChange={e => { setMuted(false); p.setVolume(Number(e.target.value)) }}
      />
    </span>
  )
}

export function ProgressControl({ tall = false }: { tall?: boolean }) {
  const p = usePlayer()
  const trackEl = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [hoverRatio, setHoverRatio] = useState(0)
  /**
   * 拖动中的临时位置。
   *
   * 以前是 pointermove 每动一下就给 Rust 发一次 seek——几十毫秒一条命令，
   * 音频线程要一条条处理，听感就是「拖一下卡一下」，而且位置会在旧值与新值之间来回跳。
   * 现在拖动只改这个本地值（进度条跟手），**松手才真正 seek 一次**。
   */
  const [dragPos, setDragPos] = useState<number | null>(null)
  const dur = p.snapshot.duration || (p.current?.duration ?? 0)
  const shown = dragPos ?? p.snapshot.position

  const ratioFromEvent = (e: React.PointerEvent) => {
    const el = trackEl.current!
    const r = el.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  }

  return (
    <div
      className={'progress ' + (tall ? 'tall' : '')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); p.setScrubbing(false) }}
    >
      <span className="num time">{fmtTime(shown)}</span>
      <div
        ref={trackEl}
        className={'track ' + (hover ? 'hover' : '') + (dragPos != null ? ' dragging' : '')}
        role="slider" aria-label="播放进度" aria-valuemin={0} aria-valuemax={dur} aria-valuenow={shown}
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'ArrowRight') p.seek(Math.min(dur, p.snapshot.position + 5))
          if (e.key === 'ArrowLeft') p.seek(Math.max(0, p.snapshot.position - 5))
        }}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId)
          p.setScrubbing(true)
          setDragPos(ratioFromEvent(e) * dur)
        }}
        onPointerMove={e => {
          setHoverRatio(ratioFromEvent(e))
          if (e.buttons & 1 && dur) setDragPos(ratioFromEvent(e) * dur)
        }}
        onPointerUp={e => {
          const at = dragPos ?? ratioFromEvent(e) * dur
          setDragPos(null)
          p.setScrubbing(false)
          p.seek(at)
        }}
        onPointerCancel={() => { setDragPos(null); p.setScrubbing(false) }}
      >
        {/* 已缓冲的第二层（只有在线曲目非 0）：比播放进度淡一档，让用户知道歌已经拉到哪儿了 */}
        <div
          className="fill-buf"
          style={{ width: (dur && p.snapshot.buffered > 0 ? Math.max(shown / dur, p.snapshot.buffered / dur) : 0) * 100 + '%' }}
        />
        <div className="fill" style={{ width: (dur ? shown / dur : 0) * 100 + '%' }} />
        <div className="knob" style={{ left: (dur ? shown / dur : 0) * 100 + '%' }} />
        {hover && dur > 0 && (
          <div className="bubble num" style={{ left: hoverRatio * 100 + '%' }}>
            {fmtTime((dragPos ?? hoverRatio * dur))}
          </div>
        )}
      </div>
      <span className="num time">{fmtTime(dur)}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 侧栏                                                                */
/* ------------------------------------------------------------------ */

export type Page = 'home' | 'search' | 'playlist' | 'downloads' | 'settings'

export function Sidebar({ page, onNavigate, trackCount }: {
  page: Page
  onNavigate(p: Page): void
  trackCount: number
}) {
  const [collapsed, setCollapsed] = useState(false)
  const items: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
    { id: 'home', label: '我的', icon: <IconUser width={17} height={17} /> },
    { id: 'search', label: '在线搜索', icon: <IconSearch width={17} height={17} /> },
    { id: 'playlist', label: '歌单广场', icon: <IconPlaylist width={17} height={17} /> },
    { id: 'downloads', label: '下载', icon: <IconDownloads width={17} height={17} /> },
    { id: 'settings', label: '设置', icon: <IconCog width={17} height={17} /> },
  ]
  return (
    <aside className={'sidebar themed' + (collapsed ? ' collapsed' : '')}>
      <div className="sb-head">
        <div className="sb-logo">疏音</div>
        <button className="icon-btn" aria-label="折叠侧栏" onClick={() => setCollapsed(c => !c)}>
          <IconPanel />
        </button>
      </div>
      <nav className="sb-nav" aria-label="主导航">
        {items.map(it => (
          <button
            key={it.id}
            className={'sb-item ' + (page === it.id ? 'active' : '')}
            aria-current={page === it.id ? 'page' : undefined}
            onClick={() => onNavigate(it.id)}
            title={it.label}
          >
            {it.icon}
            <span className="sb-label">{it.label}</span>
          </button>
        ))}
      </nav>
      <div className="sb-meta">
        <span className="num">{trackCount}</span> 首本地歌曲
      </div>
      <div className="sb-foot">{collapsed ? '' : '疏影横斜 · 澄澈之音'}</div>
    </aside>
  )
}

/*
 * 侧栏图标现在统一放在 components/icons.tsx 里（人形 / 放大镜 / 目录+音符 / 托盘 / 齿轮），
 * 这里只留折叠侧栏那一个。
 */
function IconPanel() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.2" y="3" width="11.6" height="10" rx="2" /><path d="M6 3v10" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* 队列抽屉                                                            */
/* ------------------------------------------------------------------ */

export function QueueDrawer({ open, onClose }: { open: boolean; onClose(): void }) {
  const p = usePlayer()
  const { tokens } = useTheme()
  const q = p.queueState.queue
  const cur = p.current
  const listRef = useRef<HTMLDivElement>(null)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  const toastTimer = useRef(0)
  const [removedTop, setRemovedTop] = useState<Map<string, number>>(new Map())

  const showToast = (text: string, undo?: () => void) => {
    setToast({ text, undo })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 5000)
  }

  const applyFlip = () => {
    const el = listRef.current
    if (!el) return
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.q-row'))
    const map = new Map(rows.map(r => [r.dataset.id, r.getBoundingClientRect().top]))
    requestAnimationFrame(() => {
      rows.forEach(r => {
        const prev = map.get(r.dataset.id)
        if (prev == null) return
        const delta = prev - r.getBoundingClientRect().top
        if (Math.abs(delta) < 1) return
        r.style.transition = 'none'
        r.style.transform = `translateY(${delta}px)`
        requestAnimationFrame(() => {
          r.style.transition = 'transform 240ms var(--sy-ease-panel)'
          r.style.transform = ''
        })
      })
    })
  }

  const dragRef = useRef<{ id: string; startY: number; row: HTMLElement; moved: boolean } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    const row = (e.target as HTMLElement).closest('.q-row') as HTMLElement | null
    if (!row || (e.target as HTMLElement).closest('.q-rm')) return
    dragRef.current = { id: row.dataset.id!, startY: e.clientY, row, moved: false }
    row.setPointerCapture?.(e.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.abs(dy) < 4) return
      d.moved = true
      d.row.classList.add('is-dragging')
    }
    d.row.style.transform = `translateY(${dy}px) scale(1.006)`
    const rows = Array.from(listRef.current!.querySelectorAll<HTMLElement>('.q-row')).filter(r => r !== d.row)
    rows.forEach(r => r.classList.remove('drop-before', 'drop-end'))
    let target: HTMLElement | null = null
    for (const r of rows) {
      const rect = r.getBoundingClientRect()
      if (e.clientY < rect.top + rect.height / 2) { target = r; break }
    }
    if (target) target.classList.add('drop-before')
    else if (rows.length) rows[rows.length - 1].classList.add('drop-end')
  }

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    listRef.current?.querySelectorAll('.q-row').forEach(r => r.classList.remove('drop-before', 'drop-end', 'is-dragging'))
    if (!d.moved) {
      const i = q.findIndex(t => t.id === d.id)
      if (i >= 0) p.playList(q, i)
      return
    }
    const from = q.findIndex(t => t.id === d.id)
    const rows = Array.from(listRef.current!.querySelectorAll<HTMLElement>('.q-row'))
    const dragRect = d.row.getBoundingClientRect()
    let to = rows.filter(r => r !== d.row).findIndex(r => {
      const rect = r.getBoundingClientRect()
      return dragRect.top + dragRect.height / 2 < rect.top + rect.height / 2
    })
    if (to === -1) to = q.length - 1
    else if (to > from) to -= 1
    if (from >= 0 && to !== from) {
      p.reorder(from, to)
      applyFlip()
    } else {
      d.row.style.transform = ''
    }
  }

  const removeAt = (id: string) => {
    const idx = q.findIndex(t => t.id === id)
    if (idx < 0) return
    const snapshotTrack = q[idx]
    p.remove(id)
    setRemovedTop(m => new Map(m).set(id, idx))
    showToast('已从队列移除', () => {
      p.addToQueue(snapshotTrack, 'end')
      setRemovedTop(m => { const n = new Map(m); n.delete(id); return n })
    })
  }

  const total = q.reduce((n, t) => n + t.duration, 0)

  /*
   * 打开抽屉就定位到当前曲目。
   * 队列经常几百首，打开后停在第 1 首等于每次都让用户自己找「现在放到哪了」。
   * 抽屉刚 open 时容器高度还在过渡（clientHeight 可能还是 0），所以等一帧再滚。
   */
  useEffect(() => {
    if (!open) return
    const el = listRef.current
    if (!el) return
    const jump = () => {
      const row = el.querySelector<HTMLElement>('.q-row.current')
      if (!row) return
      el.scrollTop = Math.max(0, row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2)
    }
    jump()
    const raf = requestAnimationFrame(jump)
    return () => cancelAnimationFrame(raf)
  }, [open, cur?.id])

  return (
    <aside
      className={'queue-drawer glass themed' + (open ? ' open' : '')}
      data-glass-degraded={tokens.glassBlur === 0}
      aria-label="播放列表" aria-hidden={!open}
    >
      <div className="q-head">
        <div className="t">
          <h2>播放列表</h2>
          <span className="q-count num">{q.length} 首</span>
        </div>
        <div className="acts">
          <button className="link-btn danger" onClick={() => { p.clear(); showToast('队列已清空') }}>清空</button>
          <button className="icon-btn" aria-label="关闭播放列表" onClick={onClose}><IconClose /></button>
        </div>
      </div>

      <div className="q-label">播放队列 · {q.length} 首</div>

      <div className="q-list" ref={listRef} role="listbox" aria-label="队列" onPointerDown={onPointerDown}>
        {q.length === 0 && <div className="q-empty">队列空了，去本地音乐里加一首</div>}
        {q.map((t, i) => (
          <div
            key={t.id} data-id={t.id}
            className={'q-row' + (cur?.id === t.id ? ' current' : '')}
            role="option" aria-selected={cur?.id === t.id} tabIndex={0}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.playList(q, i) }
              if (e.key === 'Delete') { e.preventDefault(); removeAt(t.id) }
              if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); p.reorder(i, Math.min(i + 1, q.length - 1)); applyFlip() }
              if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); p.reorder(i, Math.max(i - 1, 0)); applyFlip() }
            }}
          >
            <span className="idx num">
              {cur?.id === t.id
                ? <span className="eq-mini" aria-hidden="true"><i /><i /><i /></span>
                : String(i + 1).padStart(2, '0')}
            </span>
            <span className="grip" aria-hidden="true"><IconGrip /></span>
            <Cover track={t} size={28} radius={6} />
            <span className="meta">
              <span className="name">{t.title}</span>
              <span className="singer">{t.artist}</span>
            </span>
            <span className="dur num">{fmtTime(t.duration)}</span>
            <button className="q-rm" aria-label={'移除 ' + t.title} onClick={e => { e.stopPropagation(); removeAt(t.id) }}>
              <IconClose width={12} height={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="q-sep" />
      <div className="q-foot">
        <span>拖动排序 · 点 ✕ 移除</span>
        <span className="num">总时长 {fmtTime(total)}</span>
      </div>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button onClick={() => { toast.undo?.(); setToast(null) }}>撤销</button>}
        </div>
      )}
    </aside>
  )
}
