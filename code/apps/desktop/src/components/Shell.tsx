/**
 * 全局框架：侧栏（240px 可折叠）+ 底部悬浮玻璃播放条 + 队列抽屉。
 * 布局尺寸严格按设计规范：播放条高 72、距底 16、圆角 20、左右各距 16。
 * 播放条第二行显示当前歌词行（无歌词回落为「歌手 · 专辑」）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtTime, nextIndex, prevIndex, type LocalTrack } from '@shuyin/core'
import { usePlayer } from '../lib/PlayerProvider'
import { isOnlineTrack, qualityChoicesFor, qualityLabel } from '../lib/online'
import { ChipMenu } from './ChipMenu'
import { useTheme } from '../lib/ThemeProvider'
import { useShell } from '../lib/shellMode'
import { lyricAt, loadLyrics } from '../lib/lyrics'
import { Cover } from './Cover'
import { ActionSheet } from './ActionSheet'
import { AddToPlaylistDialog } from './AddToPlaylistDialog'
import { useDownloads } from '../lib/DownloadsProvider'
import { consumeLongPress, longPressProps } from '../lib/longPress'
import { useFavs, favRecOf } from '../lib/favTracks'
import {
  IconChevronLeft, IconChevronUp, IconClose, IconCog, IconDesktopLyric, IconDownloads, IconGrip, IconHeart, IconHeartFilled, IconInfo, IconMore, IconMusicNote, IconNext,
  IconPause, IconPlay, IconPlaylist, IconPrev, IconQueue, IconRepeat, IconRepeatAll, IconSearch,
  IconShuffle, IconSliders, IconUser, IconVolume, IconVolumeLow, IconVolumeMute,
} from './icons'

/* ------------------------------------------------------------------ */
/* 播放条                                                              */
/* ------------------------------------------------------------------ */

/**
 * 预览层的第二行：拿隔壁那首歌的第一句歌词。
 *
 * 用户：「如果能显示歌词就显示歌词，不能显示歌词就空着，显示歌名和歌手就行」——
 * 不要「下一首」这种标签，那行本来就该是歌词位。
 *
 * `loadLyrics` 自带 Map 缓存和 inflight 去重（见 lib/lyrics.ts），
 * 来回滑同一首不会重复读盘/联网；空结果只记 60s，之后还允许再查。
 */
function usePeekLyric(track: LocalTrack | null): string | null {
  const [line, setLine] = useState<string | null>(null)
  const idRef = useRef<string | null>(null)
  const id = track?.id ?? null

  useEffect(() => {
    if (idRef.current === id) return
    idRef.current = id
    if (!id || !track) { setLine(null); return }
    let alive = true
    setLine(null)
    void loadLyrics(track)
      .then(doc => {
        if (!alive) return
        const l = doc.lines.find(x => x.text.trim())
        setLine(l ? l.text.trim() : null)   // 没歌词就空着，不编造占位文案
      })
      .catch(() => { /* 读不到就当没有 */ })
    return () => { alive = false }
    /* 只认 id：track 每次渲染都是新对象，挂在对象上会无限重取 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return line
}

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
  const shell = useShell()
  const repeat = p.queueState.repeat
  const RepeatIcon = repeat === 'one' ? IconRepeat : repeat === 'shuffle' ? IconShuffle : IconRepeatAll

  const lyricLine = useMemo(() => lyricAt(p.lyrics, p.snapshot.position)?.text ?? null, [p.lyrics, p.snapshot.position])

  /* 封面进度环（手机）：时长优先用真解码时长，在线曲在 prepare 前用平台的时长顶着 */
  const dur = p.snapshot.duration || t?.duration || 0
  const ringRatio = dur > 0 ? Math.min(1, Math.max(0, p.snapshot.position / dur)) : 0

  /*
   * 进度环跟随封面的**圆角矩形**（用户：「专辑图片是方形，但进度条是圆形」）：
   * 以前画的是 r=25 的正圆，套在圆角 8 的方形封面外，四角对不上。
   * 改成 pathLength=100 的 rounded-rect——进度用百分比表示，
   * 尺寸变化不用重算周长，圆角和封面同款。
   */
  /* 46 = 封面 40 + 每边 3；矩形留 1.25 的呼吸位（恰好是 2.5 描边的一半，
     描边外沿不会顶出 SVG 视口被裁）。
     圆角 11.75 = 封面自己的 10 + 中心线外扩 1.75 —— 两圈弧的圆心重合才叫「贴合」，
     原来写 11 是拍脑袋的绝对值，环比封面更方，看着就是两个盒子（见 mobile.css 的 .pb-ring） */
  const RING_RECT = { x: 1.25, y: 1.25, w: 43.5, h: 43.5, rx: 11.75 }

  /*
   * 播放条横滑切歌（手机）：和封面手势同一个判定——横移 48px 且横向占优才算。
   *
   * 跟手的只有**歌名 / 歌词那两行字**，封面、控制键、进度环一概不动。
   * 第一版把 `translateX(dx)` 写在整条 `.playbar` 上，用户的原话是「整个组件都
   * 跟着左右滑」——条子连边框一起平移，像在挪窗口，不像在换歌。
   *
   * 为什么不走 state：`setState` 每次 move 都要重渲染整条播放栏（封面、歌词行、
   * 进度环、音量…），60Hz 下掉帧就变成「跟手但不顺」。这里直接写 element.style，
   * 浏览器只做一次合成层位移；只有「判定成不成立」那一下才进 React。
   *
   * 裁切靠 `.pb-meta { overflow: hidden }`：两行字各自的盒子宽度不变（省略号照旧），
   * 平移后超出的部分被 `.pb-meta` 裁在封面右边，不会糊到控制键上。
   */
  const metaRef = useRef<HTMLDivElement>(null)
  const barTouch = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  /* 滑动成立后补发的 click 会落到 `.pb-left` 上 → 打开播放页。滑一下弹一次，得挡掉 */
  const barTapGuard = useRef(0)

  /* 手指停在哪（px）：弹回要从这个位置起算，不能凭空从 0 开始 */
  const barDx = useRef(0)

  /*
   * 拖到一半时从边缘顶进来的「下一首 / 上一首」预览。
   *
   * 用户：「左右滑动一段距离的时候能不能把下一首歌加进来，这样它能知道下一首歌是什么」——
   * 原来滑出去只有自己被推走，右边是空的，滑不滑都一样。
   *
   * 曲目按 `nextIndex/prevIndex` 算，和 `p.next()/p.prev()` 完全同源：
   * 随机模式、列表循环、单曲循环下预览的才是真会播的那一首，不能拿 `queue[i+1]` 糊弄。
   */
  const peekRef = useRef<HTMLDivElement>(null)
  const [peekDir, setPeekDir] = useState<'next' | 'prev'>('next')
  const peekDirRef = useRef<'next' | 'prev' | null>(null)

  const qs = p.queueState
  const nextI = nextIndex(qs, false)
  const prevI = prevIndex(qs)
  const peekTrack = (peekDir === 'prev' ? prevI : nextI) != null
    ? qs.queue[(peekDir === 'prev' ? prevI : nextI)!] ?? null
    : null
  /** 预览的那首歌的第一句歌词；拿不到就是 null（第二行留白） */
  const peekLine = usePeekLyric(peekTrack)

  /** 把预览层摆到「刚好接在当前内容后面」的位置：next 从右边来，prev 从左边来 */
  const barPeek = (dx: number | null) => {
    const el = peekRef.current
    const box = metaRef.current
    if (!el || !box) return
    const w = box.clientWidth
    const dir = peekDirRef.current
    if (dx == null) {
      /* 复位到屏幕外：被 .pb-meta 裁掉，看不见，不用做动画 */
      el.style.transition = 'none'
      el.style.transform = `translateX(${(dir === 'prev' ? -w : w).toFixed(1)}px)`
      return
    }
    const next: 'next' | 'prev' = dx < 0 ? 'next' : 'prev'
    if (peekDirRef.current !== next) {
      peekDirRef.current = next
      setPeekDir(next)
    }
    el.style.transition = 'none'
    el.style.transform = `translateX(${(next === 'next' ? w + dx : -w + dx).toFixed(1)}px)`
  }

  /**
   * 动画一律走 `element.animate()`，不用 CSS transition。
   *
   * 踩过的坑：起点（translateX(dx)）和终点（回到 0）必须在**同一次**事件里提交，
   * 因为文本已经换好了、中间没有第二帧可用。而 transition 的起点取的是「上一次
   * 已渲染的样式」——同帧改 transition + transform，浏览器要么按旧 transition（none）
   * 直接瞬移，要么从上一帧的位置硬滑。加 `getBoundingClientRect()` 也没用：
   * transform 不参与布局，那个调用不会真的把合成层的值刷下去。
   * 实测 300ms 的入场动画 58ms 就到位了。animate() 自己管关键帧，起点不依赖上一帧。
   */
  const barStopAnim = (el: HTMLElement) => {
    for (const a of el.getAnimations()) a.cancel()
  }

  const barSetX = (dx: number | null) => {
    const el = metaRef.current
    if (!el) return
    barPeek(dx)
    if (dx == null) {
      const from = barDx.current
      barDx.current = 0
      barStopAnim(el)
      el.style.transition = 'none'
      el.style.transform = ''
      el.style.opacity = ''
      if (Math.abs(from) < 0.5) return
      el.animate(
        [
          { transform: `translateX(${from.toFixed(1)}px)`, opacity: Math.max(0.28, 1 - Math.abs(from) / 240) },
          { transform: 'translateX(0px)', opacity: 1 },
        ],
        { duration: 240, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
      )
      return
    }
    barStopAnim(el)
    barDx.current = dx
    el.style.transition = 'none'
    el.style.transform = `translateX(${dx.toFixed(1)}px)`
    /* 滑走的那半句渐渐淡下去：硬切在封面边上会显得像被撕掉一块 */
    el.style.opacity = String(Math.max(0.28, 1 - Math.abs(dx) / 240).toFixed(2))
  }

  /**
   * 切歌后新内容**从来的方向滑进去**：左滑（下一首）从右边进，右滑（上一首）从左边进。
   *
   * 用户原话：「往左边滑下一首应该从右边出来，往右边滑应该往左边出来，你这太不合理了」——
   * 之前松手就是硬换一行字，方向感全靠猜。
   *
   * 动画必须挂在 `.pb-meta-in`（两行字的固定外壳）上，不能挂 `.pb-name`：
   * 切歌时 React 会把 `.pb-name` 的子树整块换掉（歌手有时有有时没有），
   * 直接写在它身上的 transform 跟着节点一起被丢掉，等于没做（实测）。
   */
  const barEnter = (dir: 'next' | 'prev') => {
    const el = metaRef.current
    if (!el) return
    barDx.current = 0
    barStopAnim(el)
    el.style.transition = 'none'
    el.style.transform = ''
    el.style.opacity = ''
    const from = dir === 'next' ? 26 : -26
    el.animate(
      [
        { transform: `translateX(${from}px)`, opacity: 0 },
        { transform: 'translateX(0px)', opacity: 1 },
      ],
      { duration: 300, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    )
    /* 换完歌，预览层要换人：不清空的话下次同方向滑动不会触发 setPeekDir，
       露出来的还是上一首的「下一首」 */
    barPeek(null)
    peekDirRef.current = null
  }

  const barGesture = shell === 'phone' ? {
    onTouchStart: (e: React.TouchEvent) => {
      const tp = e.touches[0]
      barTouch.current = { x: tp.clientX, y: tp.clientY, moved: false }
      /* 手指落下就归零：上一次的回弹/入场还挂着也别接着播，不然第一帧位置是错的 */
      const el = metaRef.current
      if (el) {
        barStopAnim(el)
        el.style.transition = 'none'
        el.style.transform = ''
        el.style.opacity = ''
      }
      barDx.current = 0
      barPeek(null)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = barTouch.current
      if (!s) return
      const dx = e.touches[0].clientX - s.x
      /* 竖向为主时不要横推：那是在滚页面，不是在滑播放条 */
      const dy = e.touches[0].clientY - s.y
      if (!s.moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) s.moved = true
      if (s.moved) barSetX(dx)
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = barTouch.current
      barTouch.current = null
      if (!s) { barSetX(null); return }
      const tp = e.changedTouches[0]
      const dx = tp.clientX - s.x
      const dy = tp.clientY - s.y
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        /* 先立闸再切歌：切歌会重挂整个播放条，闸晚立一步就挡不住补发的 click */
        barTapGuard.current = Date.now() + 420
        /* 不弹回原位：停在手指松开的位置，新内容从反方向追上来，接得上 */
        barEnter(dx < 0 ? 'next' : 'prev')
        if (dx < 0) p.next(); else p.prev()
        return
      }
      barSetX(null)
    },
    onTouchCancel: () => { barTouch.current = null; barSetX(null) },
  } : {}

  return (
    <div
      className="playbar glass themed"
      data-glass-degraded={tokens.glassBlur === 0}
      /*
       * 迷你条上的横划是**切歌**，页面不能跟着横滑。
       *
       * lib/pageSwipe 在 window 捕获阶段监听 touchstart，条子没被列进它的禁区，
       * 于是同一根手指被两边同时接管：歌切了、整页也滑走了
       * （用户：「我只是想切歌，但是上面也会跟着滑动」2026-11-11）。
       */
      data-no-swipe=""
      {...barGesture}
    >
      {/* 主流播放器习惯：点封面/标题展开沉浸式播放页 */}
      <div className="pb-left" onClick={() => { if (Date.now() < barTapGuard.current) return; onOpenNow() }} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter') onOpenNow() }}
        title="展开播放页">
        {t
          ? <><span className="pb-cover-wrap">
                <Cover track={t} size={44} radius={8} />
                {/* 手机：进度环贴着封面外沿一圈（圆角矩形，样式见 mobile.css 的 .pb-ring）。
                    viewBox 必须和环盒同尺寸（46）：写 48 会被等比缩到 46，
                    rect 的 x/w 跟着 ×0.958，右侧就多贴进去 0.3px，四边立刻不对称 */}
                {shell === 'phone' && dur > 0 && (
                  <svg className="pb-ring" viewBox="0 0 46 46" aria-hidden="true">
                    <rect className="pb-ring-bg"
                      x={RING_RECT.x} y={RING_RECT.y} width={RING_RECT.w} height={RING_RECT.h} rx={RING_RECT.rx}
                      pathLength={100} />
                    <rect className="pb-ring-fg"
                      x={RING_RECT.x} y={RING_RECT.y} width={RING_RECT.w} height={RING_RECT.h} rx={RING_RECT.rx}
                      pathLength={100}
                      strokeDasharray={`${(ringRatio * 100).toFixed(2)} 100`} />
                  </svg>
                )}
                <span className="pb-expand" aria-hidden="true"><IconChevronUp /></span>
              </span>
              {/* `.pb-meta` 只负责裁切，位移/入场动画作用在内层 `.pb-meta-in`：
                  React 换歌时会重建 `.pb-name` 的子树，写在那上面的 transform 会丢 */}
              <div className="pb-meta">
                <div className="pb-meta-in" ref={metaRef}>
                <div className="pb-name on-glass">
                  {/* 手机上歌名后面接歌手（用户：「歌名后边还有空位，可以把歌手也加上」）。
                      桌面不加：那一行只有 280 宽，歌手在第二行「歌手 · 专辑」里已经有了 */}
                  {shell === 'phone'
                    ? <>
                        <span className="pb-t">{t.title}</span>
                        {t.artist && <span className="pb-ar">{t.artist}</span>}
                      </>
                    : t.title}
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
                </div>
                {/* 横滑时从边缘顶进来的「下一首 / 上一首」：滑到一半就能看见它是什么歌 */}
                {peekTrack && (
                  <div className="pb-meta-peek" ref={peekRef} aria-hidden="true">
                    <div className="pb-name on-glass">
                      <span className="pb-t">{peekTrack.title}</span>
                      {peekTrack.artist && <span className="pb-ar">{peekTrack.artist}</span>}
                    </div>
                    {/* 第二行是歌词位：有就显示第一句，没有就空着（不写「下一首」这类标签） */}
                    <div className="pb-sub on-glass">{peekLine ?? '\u00a0'}</div>
                  </div>
                )}
              </div></>
          : <div className="pb-meta">
              <div className="pb-meta-in" ref={metaRef}>
                <div className="pb-name on-glass" style={{ color: 'var(--sy-text-3)' }}>未在播放</div>
                <div className="pb-sub on-glass">从本地音乐里选一首吧</div>
              </div>
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
        <button className="icon-btn" aria-label="下一首" onClick={p.next} disabled={!t}><IconNext /></button>
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
 *
 * 静音归 `PlayerProvider` 管（`p.muted` / `p.toggleMute`）：这里原来自己存了一个
 * `muted`，只把滑杆的**显示值**算成 0，播放器音量一点没动 —— 点下去图标变了、
 * 声音没变，看着就是「按了没反应」。播放页那颗静音是同一个毛病，两边一起改。
 */
function VolumeControl() {
  const p = usePlayer()
  const vol = p.snapshot.volume
  const wrapRef = useRef<HTMLSpanElement>(null)
  /* 回调里读最新的 p，effect 就能只在挂载时跑一次；否则每次音量变化都重挂监听 */
  const pRef = useRef(p)
  pRef.current = p
  /*
   * 滚轮调音量。
   *
   * React 的 onWheel 挂在根节点、默认 passive，里面的 preventDefault 是空操作——
   * 页面会跟着一起滚。所以这里挂原生非 passive 监听，只在本控件上生效。
   * 往上滚大声、往下滚小声；`nudgeVolume` 在静音态下以静音前的音量为基准，
   * 不会从 0 一档一档往上爬。
   */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      pRef.current.nudgeVolume(e.deltaY < 0 ? 0.05 : -0.05)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  return (
    <span className="vol-wrap" ref={wrapRef} title="音量：悬停拖动，也可以直接用滚轮">
      <button
        className="icon-btn"
        aria-label={p.muted ? '取消静音' : '静音'}
        aria-pressed={p.muted}
        onClick={p.toggleMute}
      >
        {vol === 0 ? <IconVolumeMute width={16} height={16} />
          : vol < 0.5 ? <IconVolumeLow width={16} height={16} />
            : <IconVolume width={16} height={16} />}
      </button>
      <input
        className="slider vol-slider" type="range" min={0} max={1} step={0.01} value={vol}
        aria-label="音量"
        onChange={e => p.setVolume(Number(e.target.value))}
      />
    </span>
  )
}

export function ProgressControl({ tall = false }: { tall?: boolean }) {
  const p = usePlayer()
  const trackEl = useRef<HTMLDivElement>(null)
  /**
   * 时间气泡的开关。
   *
   * 它以前挂在一个叫 `hover` 的布尔上：鼠标点一下进度条，只有 `onMouseLeave`
   * 会把它收掉——指针还停在轨道上，气泡就一直亮着（用户原话是
   * 「滑动时抬手会消失，点击的时候不会」）。触摸屏那条分支写的是
   * `if (e.pointerType !== 'mouse') setHover(false)`，可 WebView 把触摸派生成
   * `mouse` 指针时这句等于没写。
   *
   * 现在口径只有一句：**抬手就收，指针再动才重新亮**。
   * 拖动松手、单击、pointercancel 三种收场走同一条路，不再分设备猜 pointerType。
   */
  const [bubble, setBubble] = useState(false)
  const [hoverRatio, setHoverRatio] = useState(0)
  /**
   * 上次按下用的是哪种指针。
   *
   * 触摸屏上「点一下」之后，Chrome / WebView 会补一整套**兼容鼠标事件**
   * （mouseover → mousemove → mousedown → mouseup → click），而且是在 `pointerup`
   * **之后**才发。`onMouseEnter` 要是无条件开气泡，刚在抬手时收掉的那颗
   * 会被这一串又点亮一次——用户看到的还是「点了不消失」。
   *
   * 所以悬停这条路只认真实鼠标：手指按过之后，兼容鼠标事件一律不认。
   */
  const lastPointer = useRef<'mouse' | 'touch'>('mouse')
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
      onMouseEnter={() => { if (lastPointer.current === 'mouse') setBubble(true) }}
      onMouseLeave={() => { setBubble(false); p.setScrubbing(false) }}
    >
      <span className="num time">{fmtTime(shown)}</span>
      <div
        ref={trackEl}
        className={'track ' + (bubble ? 'hover' : '') + (dragPos != null ? ' dragging' : '')}
        role="slider" aria-label="播放进度" aria-valuemin={0} aria-valuemax={dur} aria-valuenow={shown}
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'ArrowRight') p.seek(Math.min(dur, p.snapshot.position + 5))
          if (e.key === 'ArrowLeft') p.seek(Math.max(0, p.snapshot.position - 5))
        }}
        onPointerDown={e => {
          lastPointer.current = e.pointerType === 'mouse' ? 'mouse' : 'touch'
          e.currentTarget.setPointerCapture(e.pointerId)
          /*
           * **按下就把气泡打开**。
           *
           * 以前气泡只由 `onMouseEnter` 驱动：触摸屏上根本没有「悬停」，
           * 于是手机上拖动进度条时那颗时间气泡**一次都不会出现**，
           * 手指底下只有一条线——用户的原话是「拖动或者点击的时候显示的时间感觉有点怪」，
           * 其实是他压根没看到自己在拖到哪一秒。鼠标这边行为不变。
           */
          setBubble(true)
          p.setScrubbing(true)
          setDragPos(ratioFromEvent(e) * dur)
        }}
        onPointerMove={e => {
          /* 指针一动就亮（鼠标悬停、手指拖动都走这里）；不按着也亮，方便确认落点 */
          setBubble(true)
          setHoverRatio(ratioFromEvent(e))
          if (e.buttons & 1 && dur) setDragPos(ratioFromEvent(e) * dur)
        }}
        onPointerUp={e => {
          const at = dragPos ?? ratioFromEvent(e) * dur
          setDragPos(null)
          p.setScrubbing(false)
          /*
           * 抬手就收——**拖动松手和「点一下」是同一个结尾**。
           * 以前这里只有 `pointerType !== 'mouse'` 才收，指针被派生成 mouse 时
           * 点一下就留在那儿不走了；桌面鼠标虽然会靠 mouseleave 收掉，
           * 但指针停在轨道上时同样一直亮着。
           */
          setBubble(false)
          p.seek(at)
        }}
        onPointerCancel={() => { setDragPos(null); p.setScrubbing(false); setBubble(false) }}
      >
        {/* 已缓冲的第二层（只有在线曲目非 0）：比播放进度淡一档，让用户知道歌已经拉到哪儿了 */}
        <div
          className="fill-buf"
          style={{ width: (dur && p.snapshot.buffered > 0 ? Math.max(shown / dur, p.snapshot.buffered / dur) : 0) * 100 + '%' }}
        />
        <div className="fill" style={{ width: (dur ? shown / dur : 0) * 100 + '%' }} />
        {/*
          * 圆点**必须夹在轨道里**。
          * 它自己是 `translate(-50%,-50%)`：`left:0%` 时左半边在轨道外，
          * `left:100%` 时右半边在轨道外。手机上轨道几乎顶到屏幕边，
          * 于是「拖到最右」时那个白点半个身子挂在屏幕外——用户看到的就是
          * 「歌曲进度条超出屏幕边缘了」。6px = 圆点半径（12 / 2）。
          */}
        <div
          className="knob"
          style={{ left: `clamp(6px, ${(dur ? shown / dur : 0) * 100}%, calc(100% - 6px))` }}
        />
        {bubble && dur > 0 && (
          /*
           * 气泡贴边要夹住：`left: 0%` 配 `translateX(-50%)` 时右半边在轨道外，
           * 100% 时左半边在轨道外——两个端点的时间都被切掉一截（手机上最明显，
           * 因为轨道几乎顶到屏幕边）。用 clamp 把中心点限制在 24px 里侧。
           */
          <div
            className="bubble num"
            style={{ left: `clamp(26px, ${hoverRatio * 100}%, calc(100% - 26px))` }}
          >
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

export function Sidebar({ page, onNavigate, trackCount, onOpenNow, onOpenLibrary, nowOpen }: {
  page: Page
  onNavigate(p: Page): void
  trackCount: number
  /** 车机导轨的第一项「正在播放」：打开沉浸播放页 */
  onOpenNow?(): void
  /** 车机导轨的第二项「媒体库」：进我的页并展开本地曲库 */
  onOpenLibrary?(): void
  nowOpen?: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const shell = useShell()
  const items: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
    { id: 'home', label: '我的', icon: <IconUser width={17} height={17} /> },
    { id: 'search', label: '在线搜索', icon: <IconSearch width={17} height={17} /> },
    { id: 'playlist', label: '歌单广场', icon: <IconPlaylist width={17} height={17} /> },
    { id: 'downloads', label: '下载', icon: <IconDownloads width={17} height={17} /> },
    { id: 'settings', label: '设置', icon: <IconCog width={17} height={17} /> },
  ]
  /* 车机导轨（设计稿 10/11）：只有四格——正在播放 / 媒体库 / 搜索 / 设置。
     歌单广场、下载在车里没有必要，方向盘也只管上下一首。 */
  const car = shell === 'car'
  return (
    <aside className={'sidebar themed' + (collapsed ? ' collapsed' : '') + (car ? ' car-rail' : '')}>
      <div className="sb-head">
        <div className="sb-logo">疏音</div>
        <button className="icon-btn" aria-label="折叠侧栏" onClick={() => setCollapsed(c => !c)}>
          <IconPanel />
        </button>
      </div>
      {car && (
        <div className="rail-brand" aria-hidden="true">疏</div>
      )}
      <nav className="sb-nav" aria-label="主导航">
        {car ? (
          <>
            {/* 播放页是全屏浮层，压在上面时「媒体库」仍然满足 page === 'home'——
                两格会同时亮起（像两个入口都在等你点）。正在播放优先。 */}
            <button className={'sb-item' + (nowOpen ? ' active' : '')} onClick={() => onOpenNow?.()} title="正在播放">
              <IconMusicNote width={26} height={26} />
              <span className="sb-label">正在播放</span>
            </button>
            <button className={'sb-item' + (!nowOpen && page === 'home' ? ' active' : '')} onClick={() => onOpenLibrary?.()} title="媒体库">
              <IconPlaylist width={26} height={26} />
              <span className="sb-label">媒体库</span>
            </button>
            <button className={'sb-item' + (page === 'search' ? ' active' : '')} onClick={() => onNavigate('search')} title="搜索">
              <IconSearch width={26} height={26} />
              <span className="sb-label">搜索</span>
            </button>
            <button className={'sb-item' + (page === 'settings' ? ' active' : '')} onClick={() => onNavigate('settings')} title="设置">
              <IconSliders width={26} height={26} />
              <span className="sb-label">设置</span>
            </button>
          </>
        ) : items.map(it => (
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

export function QueueDrawer({ open, onClose, overPlayer = false }: {
  open: boolean
  onClose(): void
  /**
   * 是不是从深色播放页拉起来的。
   * 抽屉挂在 `.imm` 外面（z-index 70 > 60），拿不到播放页那套「强制深色」的令牌，
   * 浅色主题下就会变成黑屏里弹出一张白纸。这个标记给 CSS 用（见 handoff.css）。
   */
  overPlayer?: boolean
}) {
  const p = usePlayer()
  const { tokens } = useTheme()
  /*
   * 手机上队列是**底部 sheet**（用户：「默认只展示一半屏幕，可以手动拖动高度」）：
   * 顶部一枚抓手，按住上下拖就能在 35%~92% 屏高之间调；高度记进 localStorage，
   * 下次打开还是自己调过的那个。桌面仍是右侧抽屉，一条不改。
   */
  const phone = useShell() === 'phone'
  const q = p.queueState.queue
  const cur = p.current
  const favs = useFavs()
  const listRef = useRef<HTMLDivElement>(null)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  /** 排序态（设计稿 07）：标题右侧「排序 / 完成」，行尾露出拖动手柄 */
  const [sorting, setSorting] = useState(false)

  /*
   * 关掉播放队列 = 这次排序结束了，下次打开必须是干净的初始态
   * （用户 2026-11-11：「排序状态关闭队列，又打开时，排序状态应该能自动关闭」）。
   *
   * 关闭时**推后 210ms** 再复位：抽屉退场是 200ms，当场清掉的话
   * 下滑那半截画面里手柄「啪」地消失、行跟着重排，看着像界面错了一下。
   * 打开时也复位一次兜底——万一上一次是被外部直接改 `open` 关掉的。
   */
  useEffect(() => {
    if (open) { setSorting(false); return }
    const t = window.setTimeout(() => setSorting(false), 210)
    return () => window.clearTimeout(t)
  }, [open])
  const toastTimer = useRef(0)
  const [removedTop, setRemovedTop] = useState<Map<string, number>>(new Map())
  /** 行内「⋯」/ 长按弹出的底部动作面板（和曲库长按菜单同一套形态） */
  const [sheet, setSheet] = useState<{ t: typeof q[number]; i: number } | null>(null)
  /** 「加入歌单」弹窗要处理的曲目 id */
  const [addTo, setAddTo] = useState<string[] | null>(null)
  const dl = useDownloads()

  /*
   * sheet 高度：默认半屏，拖动后持久化。
   *
   * **必须按当前视口再夹一次**：存的是上一回的像素高（竖屏 1178 高时半屏 589），
   * 横过来屏幕只剩 372，589 高的底部 sheet 会把顶部（抓手 + 「← 播放队列 排序」）
   * 整块顶到屏幕外面——用户看到的就是「横屏打开播放列表，关闭 / 排序按钮都不见了」。
   */
  const sheetMax = () => Math.max(240, Math.round(window.innerHeight * 0.92))
  const [sheetH, setSheetH] = useState(() => {
    const v = Number(window.localStorage.getItem('sy-q-sheet-h'))
    const init = Number.isFinite(v) && v >= 260 ? v : Math.round(window.innerHeight * 0.5)
    return Math.min(init, sheetMax())
  })
  useEffect(() => {
    if (!phone) return
    const fit = () => setSheetH(h => Math.min(h, sheetMax()))
    fit()
    window.addEventListener('resize', fit)
    window.addEventListener('orientationchange', fit)
    return () => {
      window.removeEventListener('resize', fit)
      window.removeEventListener('orientationchange', fit)
    }
  }, [phone])
  const gripDrag = useRef<{ startY: number; startH: number; h: number } | null>(null)
  const onGripDown = (e: React.PointerEvent) => {
    if (!phone) return
    /* 指针序号异常（合成事件 / 已释放的指针）时 setPointerCapture 会抛 NotFoundError，
       不吞掉的话一个捕获失败就把整页拖没了 */
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
    gripDrag.current = { startY: e.clientY, startH: sheetH, h: sheetH }
    /* 拖动期间摘掉外阴影（见 handoff.css 的 data-drag 规则）：那片 48px 的
       模糊阴影随高度每帧重算，留着只能跑 60fps，摘掉才是真正跟手。 */
    const el = (e.currentTarget as HTMLElement).parentElement
    if (el) el.dataset.drag = '1'
  }
  const onGripMove = (e: React.PointerEvent) => {
    const d = gripDrag.current
    if (!d) return
    const max = Math.round(window.innerHeight * 0.92)
    /* 下限压到 200：原来夹在 280（约 1/3 屏），手指往下再走抽屉就不动了——
       用户体感就是「拖到一半追不上手」。现在能一直拖到很矮（要关就直接关，
       不给它自己判断，免得想留小一点结果被关掉）。 */
    const min = Math.min(200, Math.round(window.innerHeight * 0.24))
    d.h = Math.min(max, Math.max(min, Math.round(d.startH + (d.startY - e.clientY))))
    /*
     * 拖动期间**直接改 DOM**，不走 state。
     *
     * 以前每次 pointermove 都 setSheetH，等于把整份播放队列（几百行）重渲染一遍，
     * 一帧几十毫秒，手指走一米列表才挪半格——用户原话「上下拖动改变高度不太跟手」。
     * height 是这一层自己的内联样式，React 只在 props 值变化时才改它，
     * 抬手时再 `setSheetH` 交回去就不会打架。
     */
    const el = (e.currentTarget as HTMLElement).parentElement
    if (el) el.style.height = d.h + 'px'
  }
  const onGripUp = () => {
    const d = gripDrag.current
    gripDrag.current = null
    if (!d) return
    const el = document.querySelector<HTMLElement>('.queue-drawer')
    if (el) delete el.dataset.drag
    setSheetH(d.h)
    window.localStorage.setItem('sy-q-sheet-h', String(d.h))
  }

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

  const dragRef = useRef<{
    id: string
    startY: number
    row: HTMLElement
    moved: boolean
    scrolled: number
    /** 拖动开始时每一行的 offsetTop（内容坐标，不随滚动变） */
    tops: number[]
    /** 行高（队列行等高，用首行近似足够） */
    rowH: number
    /** 起点下标 */
    from: number
    /** 当前落点（插到 others 的第几行之前） */
    to: number
    /** 行元素（不含被拖那一行） */
    others: HTMLElement[]
  } | null>(null)
  /** 手指最后停留的 y：自动滚动靠它判「贴到边缘了没有」 */
  const dragY = useRef(0)
  const autoRaf = useRef(0)

  /**
   * 按拖动中的位置重算落点，并让邻居**让位**。
   *
   * 以前只画一条「插到这里」的提示线（`.drop-before`），别的行动都不动——
   * 用户原话「为什么不会自动占位，下一首往上滑或者往下滑那种，就是固定的在那里」。
   * 现在改成和歌单整理同一套让位模型：拖动期间数组不动，只给邻居写 `translateY`，
   * 松手才真正重排一次。
   *
   * **位移量用 `offsetTop` 的差，不用「行高 × 行数」**：队列行里有「正在播放」
   * 那一行会多一行小字，高度并不完全一致，按固定行高算会越拖越歪。
   */
  const applyShift = () => {
    const d = dragRef.current
    if (!d) return
    /*
     * 被拖那一行「现在的中点」落在哪一行的中线上。
     *
     * 三个量必须放在**同一套坐标**里：`tops` 是拖动开始时各行自己的 `offsetTop`
     * （内容坐标，不随滚动变），所以中点也只能用内容坐标去比。
     * 老代码在这里多加了 `listTop - list.scrollTop`（把中点换算成了视口坐标），
     * 而右边的比较还是内容坐标——中点被凭空抬高了一个「列表顶边」的高度，
     * 插入位整整偏下两行：用户看到的就是「歌还在上面，空出来的行却在下面两行」
     * （2026-11-11 反馈）。
     */
    const center = d.tops[d.from] + d.rowH / 2 + (dragY.current - d.startY + d.scrolled)
    let idx = 0
    for (let i = 0; i < d.tops.length; i++) {
      /* `>=`：手指正好走到「下一行的中心」时就算进去。用 `>` 的话要再多走一点才换位，
         拖两行却只走一行（用户会觉得「拖了没反应」） */
      if (center >= d.tops[i] + d.rowH / 2) idx = i + 1
    }
    // idx 是「插到原顺序第 idx 行之前」，扣掉被拖那一行自己
    let to = idx > d.from ? idx - 1 : idx
    to = Math.max(0, Math.min(d.others.length, to))
    if (to === d.to) return
    d.to = to
    /*
     * 让位的位移量：`tops` 是全量（含被拖那一行）的原始 offsetTop。
     *
     * `others[i]` 在原数组里的下标要跳过被拖那一行（`real`），
     * 它在新顺序里的位置是 `j`（插到第 `to` 位之前：前面的不动、后面的各退一格）。
     * 用同一个 `i` 直接当两边的下标会在「往上拖」时把位移算反。
     */
    for (let i = 0; i < d.others.length; i++) {
      const real = i < d.from ? i : i + 1
      const j = i < to ? i : i + 1
      const dy = d.tops[j] - d.tops[real]
      const r = d.others[i]
      if (dy) {
        r.style.transition = 'transform 160ms var(--sy-ease-soft)'
        r.style.transform = `translateY(${dy}px)`
      } else {
        r.style.transform = ''
      }
    }
  }

  const paintDrag = () => {
    const d = dragRef.current
    if (!d) return
    /* 加上 `scrolled`：自动滚动把列表往上顶了，被拖那一行得跟着顶回去，
       否则手指不动、行却越滚越远 */
    const dy = dragY.current - d.startY + d.scrolled
    d.row.style.transform = `translateY(${dy}px) scale(1.006)`
    applyShift()
  }

  /**
   * 拖到列表上/下边缘时自己滚。
   *
   * 队列几百首时没有这个就只能把行拖到屏幕边上一格一格挪——「排序怎么也排不对」
   * 一半是落点算错（见 onPointerUp），另一半是根本够不着远处的行。
   */
  const autoScroll = () => {
    autoRaf.current = 0
    const d = dragRef.current
    const list = listRef.current
    if (!d || !list) return
    const r = list.getBoundingClientRect()
    const edge = Math.min(72, r.height * 0.22)
    const y = dragY.current
    let step = 0
    if (y < r.top + edge) step = -Math.min(16, (r.top + edge - y) / 4)
    else if (y > r.bottom - edge) step = Math.min(16, (y - (r.bottom - edge)) / 4)
    if (step) {
      const before = list.scrollTop
      list.scrollTop = before + step
      const moved = list.scrollTop - before
      if (moved) {
        d.scrolled += moved
        paintDrag()
      }
    }
    autoRaf.current = requestAnimationFrame(autoScroll)
  }

  /*
   * 按住行拖动 = 调整顺序。**这是桌面交互**：安卓端手指一落在行上就 press 住，
   * 本想上下滚列表却被判成拖行（用户：「应该是电脑端滑动选中迁移过来的 bug」）——
   * 所以手机上只在「排序」模式（手柄露出的那态）才接拖动，平时触摸只管滚动。
   * 行内按钮（移除 / 收藏 / 下一首 / 更多）永远不触发拖动。
   *
   * 排序模式在手机上还必须**从手柄起手**：整行都接拖动的话，浏览器会把这次
   * 纵向拖动判成「滚列表」并发 pointercancel，排序就走不完一半就断——
   * 用户看到的是「排序怎么也拖不动 / 排不对」。手柄上写了 `touch-action:none`，
   * 从那里起手才不会被抢走。
   */
  const onPointerDown = (e: React.PointerEvent) => {
    if (phone && !sorting) return
    const el = e.target as HTMLElement
    if (el.closest('.q-rm') || el.closest('.q-acts')) return
    if (phone && !el.closest('.grip')) return
    const row = el.closest('.q-row') as HTMLElement | null
    if (!row) return
    const list = listRef.current
    if (!list) return
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.q-row'))
    const from = rows.indexOf(row)
    if (from < 0) return
    /* 让位用的几何量只在这里量一次：拖动期间每帧再读 offsetTop 就是强制重排 */
    const tops = rows.map(r => r.offsetTop)
    const rowH = row.offsetHeight || 44
    dragRef.current = {
      id: row.dataset.id!, startY: e.clientY, row, moved: false, scrolled: 0,
      tops, rowH,
      from, to: from, others: rows.filter(r => r !== row),
    }
    dragY.current = e.clientY
    row.setPointerCapture?.(e.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }

  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    dragY.current = e.clientY
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < 4) return
      d.moved = true
      d.row.classList.add('is-dragging')
      if (!autoRaf.current) autoRaf.current = requestAnimationFrame(autoScroll)
    }
    paintDrag()
  }

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    if (autoRaf.current) { cancelAnimationFrame(autoRaf.current); autoRaf.current = 0 }
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.q-row')
    rows?.forEach(r => r.classList.remove('is-dragging'))
    if (!d.moved) {
      /* 手机上排序态起手的位置是手柄：那一下只是「想拖」，不是「想播」 */
      if (phone && sorting) { d.row.style.transform = ''; return }
      const i = q.findIndex(t => t.id === d.id)
      if (i >= 0) p.playList(q, i)
      return
    }
    /*
     * 落点就是拖动中算出来的 `d.to`（在**去掉被拖那一行**之后的数组里的下标），
     * 最终位置也正好是这个值 —— 以前这里多写了一句 `if (to > from) to -= 1`，
     * 把向下拖的落点整体减了一格：往下拖一行等于没动，拖两行只走一格，
     * 用户看到的就是「排序不准 / 拖了没反应」。
     */
    const from = q.findIndex(t => t.id === d.id)
    const to = d.to
    /*
     * 先清掉位移和过渡，再让父层重排：留着过渡清空会「滑回原位」，
     * 和歌单网格那边踩的是同一个坑（见 SortableGrid 的注释）。
     */
    const all = [d.row, ...d.others]
    for (const r of all) { r.style.transition = 'none'; r.style.transform = '' }
    if (from >= 0 && to >= 0 && to !== from) {
      p.reorder(from, to)
    }
    requestAnimationFrame(() => {
      for (const r of all) r.style.transition = ''
    })
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
    <>
      {/*
       * 手机 sheet 的遮罩。
       *
       * 以前这块「暗区」是抽屉自己的 box-shadow（`0 0 0 100vmax rgba(0,0,0,.42)`）——
       * 阴影不是元素，命中测试测不到它：点那片暗处等于直接点在**后面的播放页**上，
       * 于是「想点空白关掉播放队列」变成了按到暂停 / 切歌（2026-11-01 用户反馈）。
       * 补一层真遮罩：点它收抽屉，收起动画那 240ms 里它仍然可命中，连点也漏不下去。
       */}
      {phone && (
        <div
          className={'q-scrim' + (open ? ' open' : '')}
          aria-hidden="true"
          onClick={onClose}
        />
      )}
      <aside
        className={'queue-drawer glass themed' + (open ? ' open' : '') + (sorting ? ' sorting' : '')}
      data-glass-degraded={tokens.glassBlur === 0}
      aria-label="播放列表" aria-hidden={!open}
      data-over-player={overPlayer ? '1' : '0'}
      /* 手机：默认半屏，抓手拖动改高（inline style 只在 phone 生效，桌面不动） */
      style={phone ? { height: sheetH } : undefined}
    >
      {phone && (
        <div
          className="q-grip"
          role="separator" aria-label="拖动调整播放列表高度"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        />
      )}
      <div className={'q-head' + (phone ? ' q-head-m' : '')}>
        {phone ? (
          <>
            <button className="icon-btn q-back" aria-label="返回正在播放" onClick={onClose}>
              <IconChevronLeft width={26} height={26} />
            </button>
            <h2>播放队列</h2>
            <button className="link-btn q-sort" aria-pressed={sorting} onClick={() => setSorting(v => !v)}>
              {sorting ? '完成' : '排序'}
            </button>
          </>
        ) : (
          <>
            <div className="t">
              <h2>播放列表</h2>
              <span className="q-count num">{q.length} 首</span>
            </div>
            <div className="acts">
              <button className="link-btn danger" onClick={() => { p.clear(); showToast('队列已清空') }}>清空</button>
              <button className="link-btn q-sort" aria-pressed={sorting} onClick={() => setSorting(v => !v)}>
                {sorting ? '完成' : '排序'}
              </button>
              <button className="icon-btn" aria-label="关闭播放列表" onClick={onClose}><IconClose /></button>
            </div>
          </>
        )}
      </div>

      <div className="q-label">
        {sorting ? `长按并拖动右侧手柄调整顺序 · 共 ${q.length} 首` : `播放队列 · ${q.length} 首`}
      </div>

      <div className="q-list" ref={listRef} role="listbox" aria-label="队列" onPointerDown={onPointerDown}>
        {q.length === 0 && <div className="q-empty">队列空了，去本地音乐里加一首</div>}
        {q.map((t, i) => (
          <div
            key={t.id} data-id={t.id}
            className={'q-row' + (cur?.id === t.id ? ' current' : '')}
            role="option" aria-selected={cur?.id === t.id} tabIndex={0}
            /* 手机：长按一行弹出底部动作面板（和曲库的长按菜单同一套），
               补发的 click 要吞掉，否则长按完顺手把这首播了。
               排序态要关掉：那会儿长按是在拖行，弹面板等于把拖动打断 */
            {...(phone && !sorting ? longPressProps(() => setSheet({ t, i })) : {})}
            /* 手机非排序态不再走 pointerup 播放（那条路让给滚动），改用 click */
            onClick={phone && !sorting ? e => { if (consumeLongPress()) return; p.playList(q, i) } : undefined}
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
            <span className="grip" aria-hidden="true">
              {phone ? <IconGrip width={20} height={20} /> : <IconGrip />}
            </span>
            <Cover track={t} size={28} radius={6} />
            <span className="meta">
              <span className="name">{t.title}</span>
              {/* 设计稿 07 的副标题是「歌手 · 时长」一行，手机上不再单开时长列 */}
              <span className="singer">
                {t.artist}{phone && t.duration ? ` · ${fmtTime(t.duration)}` : ''}
              </span>
            </span>
            <span className="dur num">{fmtTime(t.duration)}</span>
            {/*
              * 手机行尾三按钮（用户点名）：收藏 / 下一首播放 / 更多。
              * 「更多」弹的是长按那套底部动作面板，不是多选工具条。
              * 桌面保持原来的移除按钮 + 排序手柄不动。
              */}
            {phone ? (
              <span className="q-acts" onClick={e => e.stopPropagation()}>
                <button
                  className={'icon-btn' + (favs.has(t.id) ? ' on' : '')}
                  aria-label={(favs.has(t.id) ? '取消收藏 ' : '收藏 ') + t.title}
                  aria-pressed={favs.has(t.id)}
                  onClick={async e => {
                    e.stopPropagation()
                    const on = await favs.toggle(favRecOf(t))
                    showToast(on ? '已收藏' : '已取消收藏')
                  }}
                >
                  {favs.has(t.id) ? <IconHeartFilled width={16} height={16} /> : <IconHeart width={16} height={16} />}
                </button>
                <button
                  className="icon-btn"
                  aria-label={'下一首播放 ' + t.title}
                  onClick={e => { e.stopPropagation(); p.addToQueue(t, 'next'); showToast('已设为下一首播放') }}
                >
                  <IconNext width={16} height={16} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={'更多操作：' + t.title}
                  onClick={e => { e.stopPropagation(); setSheet({ t, i }) }}
                >
                  <IconMore width={16} height={16} />
                </button>
              </span>
            ) : (
              <button className="q-rm" aria-label={'移除 ' + t.title} onClick={e => { e.stopPropagation(); removeAt(t.id) }}>
                <IconClose width={12} height={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="q-sep" />
      <div className="q-foot">
        {phone ? (
          <>
            <button
              className="link-btn danger q-clear"
              onClick={() => { p.clear(); showToast('队列已清空') }}
            >清空队列</button>
            <span className="num">总时长 {fmtTime(total)}</span>
          </>
        ) : (
          <>
            <span>拖动排序 · 点 ✕ 移除</span>
            <span className="num">总时长 {fmtTime(total)}</span>
          </>
        )}
      </div>

      {/* 手机：行「⋯」/ 长按弹出的动作面板（用户：「点了就弹出长按那个菜单」）。
          和曲库长按面板同一套形态：常用动作摊成圆钮，其余收在文字行里。 */}
      <ActionSheet
        open={!!sheet && phone}
        title={sheet?.t.title ?? ''}
        sub={sheet ? [sheet.t.artist || '未知歌手', sheet.t.album].filter(Boolean).join(' · ') : ''}
        cover={sheet ? <Cover track={sheet.t} size={44} radius={10} /> : undefined}
        actions={sheet ? [
          {
            id: 'next', label: '下一首播放', icon: <IconNext width={20} height={20} />,
            onClick: () => { p.addToQueue(sheet.t, 'next'); showToast('已设为下一首播放') },
          },
          {
            id: 'fav', label: '收藏',
            icon: favs.has(sheet.t.id) ? <IconHeartFilled width={20} height={20} /> : <IconHeart width={20} height={20} />,
            on: favs.has(sheet.t.id),
            onClick: () => { void favs.toggle(favRecOf(sheet.t)) },
          },
          /* 「加入歌单 / 下载」才是对队列里这一首真用得上的两件事。
             原来这里第三颗是「加入队列」——它**已经在队列里了**，
             点下去除了弹一句「已加入队列」什么也没发生（用户点名要换掉）。 */
          { id: 'addpl', label: '加入歌单', icon: <IconMusicNote width={20} height={20} />, onClick: () => setAddTo([sheet.t.id]) },
          {
            id: 'dl', label: '下载', icon: <IconDownloads width={20} height={20} />,
            disabled: !isOnlineTrack(sheet.t),
            onClick: () => {
              dl.download(sheet.t)
              showToast('已开始下载')
            },
          },
        ] : []}
        rows={sheet ? [
          { id: 'play', label: '立即播放', chevron: true, onClick: () => p.playList(q, sheet.i) },
          { id: 'copy', label: '复制歌曲信息', chevron: true, onClick: () => { void navigator.clipboard?.writeText(`${sheet.t.title} - ${sheet.t.artist}`) } },
          { id: 'rm', label: '从队列移除', danger: true, onClick: () => removeAt(sheet.t.id) },
        ] : []}
        onClose={() => setSheet(null)}
      />

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button onClick={() => { toast.undo?.(); setToast(null) }}>撤销</button>}
        </div>
      )}
    </aside>

    {/* 「加入歌单」弹窗挂在抽屉**外面**：抽屉开合带 transform，fixed 子元素
        会以它为定位基准，弹窗会被贴到抽屉那一块、还会被圆角裁掉。 */}
    <AddToPlaylistDialog
      open={!!addTo}
      trackIds={addTo ?? []}
      onClose={() => setAddTo(null)}
      onDone={msg => showToast(msg)}
    />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 平板右侧「正在播放」面板（设计稿 08）                                 */
/* 平板没有底部播放条：控制、进度、接下来播放都收在这一栏里。             */
/* ------------------------------------------------------------------ */

export function TabletDock({ onOpenNow, onOpenQueue }: { onOpenNow(): void; onOpenQueue(): void }) {
  const p = usePlayer()
  const t = p.current
  const q = p.queueState.queue
  /** 当前曲目后面那几首（当前曲目不在队列里时从头取） */
  const next = useMemo(() => {
    const i = t ? q.findIndex(x => x.id === t.id) : -1
    const rest = i >= 0 ? q.slice(i + 1) : q
    return rest.slice(0, 4)
  }, [q, t?.id])

  return (
    <aside className="tab-dock themed" aria-label="正在播放">
      <div className="td-head">
        <span>正在播放</span>
        <button className="icon-btn" aria-label="展开播放页" onClick={onOpenNow}>
          <IconPanel />
        </button>
      </div>

      {!t && <div className="td-empty">还没有正在播放的歌曲</div>}

      {t && (
        <>
          <button className="td-cover" onClick={onOpenNow} aria-label="展开播放页">
            <Cover track={t} size={300} radius={18} />
          </button>
          <div className="td-meta">
            <div className="td-name" title={t.title}>{t.title}</div>
            <div className="td-sub">
              {[t.artist, t.album, t.format?.toUpperCase(), t.bitrate ? `${Math.round(t.bitrate / 1000)}k` : null]
                .filter(Boolean).join(' · ')}
            </div>
          </div>
          <div className="td-prog"><ProgressControl /></div>
          <div className="td-ctl">
            <button className="icon-btn" aria-label="循环模式" onClick={p.cycleMode}>
              <IconRepeat width={17} height={17} />
            </button>
            <button className="icon-btn" aria-label="上一首" onClick={p.prev}>
              <IconPrev width={20} height={20} />
            </button>
            <button className="play-primary td-play" aria-label={p.snapshot.playing ? '暂停' : '播放'} onClick={p.togglePlay}>
              {p.snapshot.playing ? <IconPause width={20} height={20} /> : <IconPlay width={20} height={20} />}
            </button>
            <button className="icon-btn" aria-label="下一首" onClick={p.next}>
              <IconNext width={20} height={20} />
            </button>
            <button className="icon-btn" aria-label="播放队列" onClick={onOpenQueue}>
              <IconQueue width={17} height={17} />
            </button>
          </div>

          <div className="td-next">
            <div className="td-next-head">
              <span>接下来播放</span>
              <span className="num">{q.length} 首</span>
            </div>
            {next.map(x => (
              <button
                key={x.id}
                className="td-next-row"
                onClick={() => p.playList(q, Math.max(0, q.findIndex(y => y.id === x.id)))}
              >
                <Cover track={x} size={40} radius={10} />
                <span className="td-nx-meta">
                  <span className="td-nx-name">{x.title}</span>
                  <span className="td-nx-sub">{x.artist}</span>
                </span>
                <span className="td-nx-dur num">{fmtTime(x.duration)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
