/**
 * 托盘菜单窗口（自绘）。
 *
 * 系统原生菜单在 Windows 上是一块 Win32 灰板：字体、圆角、间距、强调色全都改不了，
 * 跟疏音的界面放在一起就是两个年代的东西。这里改成一个小透明窗，右击托盘时
 * 在光标处弹出，内容按主题 token 渲染，配色/圆角/焦点态和主界面完全一致。
 *
 * 排版是「卡片」而不是「菜单列表」：上面一张正在播放的唱片卡（封面 + 曲名 + 播放控制 +
 * 进度），下面按组列操作项。分组小标题用 9.5px 大写字距，跟设置页的组标题一个语气。
 *
 * 数据：每次弹出（tray://show）重新向 Rust 拉一次状态；播放进度靠 player://state 实时补。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtTime } from '@shuyin/core'
import { bridge } from '../lib/bridge'
import { coverUrlOf } from '../lib/coverUrl'
import { trayMenu, type TrayState } from '../lib/trayMenu'
import {
  IconClose, IconDesktopLyric, IconLock, IconNext, IconPause, IconPlay, IconPrev,
  IconSettings, IconSidebar, IconUnlock, IconWave,
} from './icons'

export function TrayMenuWindow() {
  const [s, setS] = useState<TrayState | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    void trayMenu.state().then(v => { if (v) setS(v) })
  }, [])

  useEffect(() => {
    refresh()
    const offShow = trayMenu.onShow(refresh)
    const offState = trayMenu.onPlayerState(st => {
      setS(prev => (prev ? { ...prev, playing: st.playing, position: st.position, duration: st.duration } : prev))
    })
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void trayMenu.hide() }
    window.addEventListener('keydown', onKey)
    return () => { offShow(); offState(); window.removeEventListener('keydown', onKey) }
  }, [refresh])

  /* 内容尺寸 + DPR 报给 Rust：Windows 下逻辑尺寸与 DPR 不是一回事，必须按物理像素定窗口 */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const report = () => {
      const w = Math.ceil(el.offsetWidth)
      const h = Math.ceil(el.offsetHeight)
      if (w > 0 && h > 0) void trayMenu.fit(w, h, window.devicePixelRatio || 1)
    }
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => ro.disconnect()
  }, [])

  /* 开关类动作（播放/歌词/锁定）菜单不关（Rust 侧决定），状态标签要自己刷一次 */
  const act = (id: string) => {
    void trayMenu.action(id)
    window.setTimeout(refresh, 150)
  }

  const title = s?.title || '疏音'
  const hasTrack = !!s?.title
  const playing = s?.playing ?? false
  const dur = s?.duration ?? 0
  const pos = s?.position ?? 0
  const pct = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0
  const coverUrl = coverUrlOf(s?.cover)

  return (
    <div className="tmwrap" ref={rootRef}>
      <div className="tm" role="menu" aria-label="疏音托盘菜单">
        <div className="tm-head">
          <div
            className={'tm-cover' + (coverUrl ? '' : ' empty')}
            style={coverUrl ? { backgroundImage: `url("${coverUrl}")` } : undefined}
            aria-hidden="true"
          >
            {!coverUrl && <IconWave width={17} height={17} />}
          </div>
          <div className="tm-meta">
            <div className="tm-title" title={title}>{title}</div>
            <div className="tm-sub">
              {s?.artist || (hasTrack ? '未知歌手' : '本地音乐')}
              {s && s.total > 0 && <span className="tm-count"> · {s.index}/{s.total}</span>}
            </div>
          </div>
          {hasTrack && dur > 0 && <span className="tm-pct num">{Math.round(pct * 100)}%</span>}
        </div>

        <div className="tm-deck">
          <div className="tm-ctrl">
            <button className="tm-btn" onClick={() => act('prev')} aria-label="上一首" disabled={!hasTrack}>
              <IconPrev width={15} height={15} />
            </button>
            <button className="tm-btn tm-play" onClick={() => act('playpause')} aria-label={playing ? '暂停' : '播放'} disabled={!hasTrack}>
              {playing ? <IconPause width={14} height={14} /> : <IconPlay width={14} height={14} />}
            </button>
            <button className="tm-btn" onClick={() => act('next')} aria-label="下一首" disabled={!hasTrack}>
              <IconNext width={15} height={15} />
            </button>
            <span className="tm-time num">{hasTrack ? `${fmtTime(pos)} / ${fmtTime(dur)}` : '未在播放'}</span>
          </div>
          <div className="tm-prog" aria-hidden="true"><i style={{ width: pct * 100 + '%' }} /></div>
        </div>

        <div className="tm-label">歌词</div>

        <button className="tm-item" role="menuitem" onClick={() => act('lyrics')}>
          <IconDesktopLyric width={15} height={15} />
          <span>桌面歌词</span>
          <em className={'tm-tag' + (s?.lyrics ? ' on' : '')}>{s?.lyrics ? '显示中' : '已关闭'}</em>
        </button>
        <button className="tm-item" role="menuitem" onClick={() => act('locklyrics')} disabled={!s?.lyrics}>
          {s?.locked ? <IconLock width={15} height={15} /> : <IconUnlock width={15} height={15} />}
          <span>锁定桌面歌词</span>
          {s?.locked && <em className="tm-tag on">已锁</em>}
        </button>
        <button className="tm-item" role="menuitem" onClick={() => act('musiclock')}>
          <IconLock width={15} height={15} />
          <span>音乐锁屏</span>
          <em className="tm-tag">Ctrl+Alt+K</em>
        </button>

        <div className="tm-sep" />

        <div className="tm-label">窗口</div>

        <button className="tm-item" role="menuitem" onClick={() => act('show')}>
          <IconSidebar width={15} height={15} />
          <span>显示主界面</span>
        </button>
        <button className="tm-item" role="menuitem" onClick={() => act('settings')}>
          <IconSettings width={15} height={15} />
          <span>设置</span>
        </button>

        <div className="tm-sep" />

        <button className="tm-item tm-quit" role="menuitem" onClick={() => act('quit')}>
          <IconClose width={13} height={13} />
          <span>退出疏音</span>
        </button>
      </div>
    </div>
  )
}
