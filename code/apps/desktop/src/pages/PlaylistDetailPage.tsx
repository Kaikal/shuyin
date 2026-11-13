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
import { apiFor, coverForSong, dailyMix, dailyRecommend, nextMixSeed, platformName, subscribeMixSeed, toLocalTrack, toLocalTracks } from '../lib/online'
import { usePlaylists } from '../lib/localPlaylists'
import { favRecOf, useFavs } from '../lib/favTracks'
import { toast } from '../lib/toast'
import { queueToast } from '../lib/queueToast'
import { consumeLongPress, longPressProps } from '../lib/longPress'
import {
  IconCheck, IconClose, IconDownload, IconHeart, IconHeartFilled, IconLyric, IconMore, IconMusicNote, IconNext,
  IconPlay, IconPlus, IconRefresh, IconStar,
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

/**
 * 这张封面地址能用吗？
 *
 * 上游偶尔回一个「只有目录、没有文件名」的地址（酷我三个榜的 `pic` 就是
 * `http://img1.kuwo.cn/star/mboxAlbum/BangPic/`）。它是非空字符串，任何
 * `cover ? … : …` 都会放行，CSS 拿去 `url(...)` 就是一块**空白方框**——
 * 用户看到的是「封面是空的」，而不是「没有封面所以走了占位」。
 */
const usableCover = (u?: string) => (u && /^https?:\/\/[^?#]*\/[^/?#]+/.test(u) ? u : '')

/** 骨架屏占位行数：够铺满一屏即可，多了纯属浪费渲染 */
const SKEL_ROWS = [0, 1, 2, 3, 4, 5, 6]

export function PlaylistDetailPage({ source, id, name, backLabel = '返回搜索', onBack, fallbackCover }: Props) {
  const p = usePlayer()
  const dl = useDownloads()
  const bookmarks = usePlaylists()
  const favs = useFavs()
  /** `daily:` 开头是「每日推荐」，它不是一个真歌单 id，取数据走另一条路 */
  const isDaily = id.startsWith('daily:')
  /** `daily:mix` = 各平台推荐混排（见 online.dailyMix），和单平台日推共用这一页 */
  const isMix = id === 'daily:mix'
  const faved = !isDaily && bookmarks.isFav(source, id)
  const [detail, setDetail] = useState<PlaylistDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * 「换一批」（只有 `daily:mix` 有）：第几批。
   *
   * `null` = 沿用首页那一批（`dailyMix()` 不带参数就是当前 seed），
   * 点了换一批之后才有值。订阅是为了首页换完再点进来也是同一批——两处
   * 各存一个 seed 的话，退回首页又变回上一批，看着像「换了没用」。
   */
  const [seed, setSeed] = useState<number | null>(null)
  /** 换批中：列表原地留着，只把按钮转起来——整页闪一次骨架比不刷新还糟 */
  const [refreshing, setRefreshing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; song: SearchSong } | null>(null)
  /**
   * 多选：**「是否在多选中」与「选中了哪几首」是两件事**。
   *
   * 以前只有 `sel` 一个状态、用 `sel.size > 0` 反推有没有在多选，
   * 于是把最后一项取消勾选（选中数归零）就等于「退出多选」——工具条凭空消失、
   * 复选框收回、列表跳回普通态。用户反馈「全都没选就自动跳回，应该是我取消了才跳回」。
   *
   * 现在 `selecting` 独立：长按/勾选进多选，只有点工具条的「取消选择」、按 Esc、
   * 换歌单才退出；中途把选中的都取消，工具条还在（显示「已选 0 首」、动作禁用）。
   */
  const [selecting, setSelecting] = useState(false)
  /** 选中的键集合 + 连选锚点 + 「加入歌单」弹窗要加的曲目 id */
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const anchor = useRef(-1)
  const [addTo, setAddTo] = useState<string[] | null>(null)
  const reqId = useRef(0)
  /**
   * 最近一次触摸的时间。
   *
   * 安卓 WebView 在手指长按 500ms 后会**自己补发一个 `contextmenu`**，
   * 所以「长按进多选」的同时又把右键菜单弹了出来——用户看到的就是
   * 「长按同时出现两个选项卡」（上面一份曲目菜单、下面一条多选工具条）。
   * 曲目菜单改由行尾那颗 ⋯ 负责后，触摸唤起的 contextmenu 一律丢掉；
   * 鼠标右键（桌面）照旧弹菜单。
   */
  const touchAt = useRef(0)

  useEffect(() => {
    if (!isMix) { setSeed(null); return }
    return subscribeMixSeed(s => setSeed(s))
  }, [isMix])

  /**
   * 上一个「真正换了歌单」的标识。
   *
   * 进详情页 / 换一张歌单要清空选择、摆骨架屏；**换一批**只是同一页换一组歌，
   * 列表和滚动位置都该留着。两者走同一个 effect，靠这个 ref 区分。
   */
  const loadedKey = useRef('')

  useEffect(() => {
    const seq = ++reqId.current
    const listKey = `${source}:${id}`
    const sameList = loadedKey.current === listKey
    if (sameList) {
      setRefreshing(true)
    } else {
      setLoading(true)
      setDetail(null)
      setSel(new Set())
      setSelecting(false)
      anchor.current = -1
    }
    setError(null)
    const api = apiFor(source)
    const load = isMix
      ? () => dailyMix(seed === null ? {} : { seed })
      : isDaily
        ? () => dailyRecommend(source)
        : api?.getPlaylistDetail
          ? () => api.getPlaylistDetail!(id, 1, 1000)
          : null
    if (!load) {
      setError(isDaily ? '该平台暂不支持每日推荐' : '该平台暂不支持查看歌单详情')
      setLoading(false)
      setRefreshing(false)
      return
    }
    load()
      .then(d => {
        if (seq !== reqId.current) return
        setDetail(d)
        setLoading(false)
        setRefreshing(false)
        loadedKey.current = listKey
      })
      .catch(e => {
        if (seq !== reqId.current) return
        const msg = e instanceof Error ? e.message : String(e)
        setLoading(false)
        setRefreshing(false)
        /*
         * 换批失败时列表还在，就别把它换成一块报错——那一屏原本能播能听，
         * 变成「今天各平台的推荐都取不到」反而像整页坏了。留在原地报一句。
         */
        if (sameList) toast(msg, { bad: true })
        else setError(msg)
      })
  }, [source, id, isDaily, isMix, seed])

  const songs: SearchSong[] = detail?.songs ?? []
  /**
   * 榜单详情（酷狗）不回封面，用列表页带过来的那张。
   *
   * `usableCover` 过滤「只有目录没有文件名」的图（酷我三个榜的 `pic` 就是
   * `…/BangPic/`）：那种 URL 能过真值判断，却画出一块空白方框，比没有更难解释。
   */
  const rawCover = usableCover(detail?.cover) || usableCover(fallbackCover)

  /*
   * 逐行补封面。
   *
   * 酷我三个榜（热歌 / 飙升 / 新歌）的详情接口整份没有任何封面字段，
   * 而广场下面「热门歌单」走的是另一个接口（`pl.svc`，带 `albumpic`），
   * 所以那一块有图、榜单里的行全空——用户看到的差异就来自这里。
   *
   * 补图走 `coverForSong`（单曲向平台要一张，拿不到再跨平台借），
   * 但**只补滚进视野的行**：榜单动辄三百条，一次全发就是三百个请求，
   * 既慢又容易被限速；而且用户根本不会看到第 200 行。
   * 用 IntersectionObserver 盯着缺图的行，露头才排队，并发 3。
   */
  const [covers, setCovers] = useState<Record<string, string>>({})
  const listRef = useRef<HTMLDivElement>(null)
  const songsRef = useRef<SearchSong[]>(songs)
  songsRef.current = songs
  useEffect(() => {
    const root = listRef.current
    if (!root || !detail) return
    /*
     * 观测根必须是**列表自己**，不是外面那个 `.page`。
     *
     * 交集矩形会被中间所有滚动容器裁掉——root 指 `.page` 的时候，
     * `.sr-list` 自己的裁切线照样生效，`rootMargin` 那 240px 全白给，
     * 表现就是「滚到哪补到哪」：新滚进来的行先空白一拍才出图。
     * 换成列表本身，那 240px 才是真正围绕列表可视区往外扩的预取窗口。
     */
    const holder = root
    let alive = true
    let running = 0
    const queue: SearchSong[] = []
    const asked = new Set<string>()
    const pump = () => {
      while (alive && running < 3 && queue.length) {
        const sg = queue.shift()!
        running++
        void coverForSong(sg)
          .then(url => {
            running--
            if (!alive) return
            if (url) {
              const k = keyOf(sg)
              setCovers(c => (c[k] === url ? c : { ...c, [k]: url }))
            }
            pump()
          })
          .catch(() => { running--; pump() })
      }
    }
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const el = e.target as HTMLElement
        const key = el.dataset.cover
        io.unobserve(el)
        if (!key || asked.has(key)) continue
        asked.add(key)
        const sg = songsRef.current.find(s => keyOf(s) === key)
        if (!sg) continue
        queue.push(sg)
      }
      pump()
    }, { root: holder ?? undefined, rootMargin: '240px 0px' })
    root.querySelectorAll<HTMLElement>('[data-cover]').forEach(el => io.observe(el))
    return () => { alive = false; io.disconnect() }
  }, [detail])

  /**
   * 详情页那块方形封面：详情自带 → 列表页带过来的 → **第一行补到的封面**。
   *
   * 最后那一档是给酷我三个榜兜底的——它们的详情接口既没有 `albumpic`，
   * `pic` 又只有目录（见 `usableCover`），而榜单卡被点进来时并不会把大图传下来。
   * 逐行补图本来就会去取第一首的封面，顺手借来当歌单封面，视觉上完全成立，
   * 也不用为一个方框多打一次请求。
   */
  const cover = rawCover || (songs[0] ? covers[keyOf(songs[0])] ?? '' : '')

  const selSongs = useMemo(() => songs.filter(sg => sel.has(keyOf(sg))), [songs, sel])
  const allSel = songs.length > 0 && selSongs.length === songs.length
  const someSel = selSongs.length > 0 && !allSel

  const clearSel = useCallback(() => {
    setSel(new Set())
    setSelecting(false)
    anchor.current = -1
  }, [])

  const toggleOne = (key: string, i: number) => {
    setSelecting(true)
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
    setSelecting(true)
    setSel(prev => {
      const next = additive ? new Set(prev) : new Set<string>()
      keys.forEach(k => next.add(k))
      return next
    })
    anchor.current = to
  }

  const toggleAll = () => {
    /* 取消全选只清空勾选、**不退出多选**：工具条留着，等用户自己按 ✕ 或 Esc */
    if (allSel) { setSel(new Set()); anchor.current = -1; return }
    setSelecting(true)
    setSel(new Set(songs.map(keyOf)))
    anchor.current = -1
  }

  /* Ctrl+A 全选 / Esc 取消（输入框里不抢键） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSelecting(true)
        setSel(new Set(songs.map(keyOf)))
        anchor.current = -1
        return
      }
      if (e.key === 'Escape' && selecting) clearSel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [songs, selecting, clearSel])

  const playAll = useCallback((index = 0) => {
    if (!songs.length) return
    p.playList(toLocalTracks(songs), index)
  }, [songs, p])

  /**
   * 行内播放 = 「播放全部并从这一首开始」。
   *
   * 用户定的规则（2026-11）：「当我在歌单中点击歌曲播放时，直接清空当前播放列表，
   * 并将当前歌单全部添加到播放列表中，只有点下一曲按钮时才不全部替换」。
   * 以前这里走 `playOne`（只插这一首），听完不会自动接下一首，队列也不是这个歌单。
   */
  const onRowClick = (sg: SearchSong, i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current >= 0) { selectRange(anchor.current, i, e.ctrlKey || e.metaKey); return }
    if (e.ctrlKey || e.metaKey) { toggleOne(keyOf(sg), i); return }
    /*
     * 已经在多选里：单击就是勾选 / 取消勾选（和文件管理器一致）。
     * 以前是「只选这一首」——手机上长按进了多选，再点别的行会**把已选的丢掉**，
     * 想选三首得点三次长按，根本没法用。
     */
    if (selecting) { toggleOne(keyOf(sg), i); return }
    playAll(i)
  }

  const addAll = useCallback(() => {
    if (!songs.length) return
    const tracks = toLocalTracks(songs)
    /*
     * 提示必须说清「新加了几首」：队列按 id 去重，已经整单加过一次之后再点，
     * 界面不会有任何变化，不解释一句就只剩「按钮坏了」这一种解读。
     */
    queueToast(tracks, p.queueState.queue, 'end')
    p.addManyToQueue(tracks, 'end')
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
              <span className="sr-badge" data-src={isMix ? undefined : source}>
                {isMix ? '多平台' : platformName(source)}
              </span>
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
              {/* 为你推荐：日推池当天不变，但抽哪几首可以换——首页那颗在详情里也要在，
                  否则「点进来听」就会以为进来以后只能听这一批 */}
              {isMix && (
                <button
                  className={'ghost-btn sr-mixbtn' + (refreshing ? ' is-busy' : '')}
                  disabled={refreshing}
                  title="从各平台今天的推荐里重新抽一批"
                  onClick={() => nextMixSeed()}
                >
                  <IconRefresh width={13} height={13} /> {refreshing ? '换一批…' : '换一批'}
                </button>
              )}
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

      {/*
        加载态：骨架屏，不是一行灰字。
        平台接口要 1~3 秒（酷我榜单还得分页翻），这段时间内容区原本全空，
        用户看不出是在读还是卡死了，手一滑还会点到上一页残留在那的行。
        骨架和真实行同高（62），出数据时是「填进去」，不会整块跳一下。
      */}
      {loading && (
        <div className="sr-skel" role="status" aria-live="polite">
          <div className="sr-skel-head">
            <span className="sr-ring sm" aria-hidden="true"><i /><i /><i /></span>
            <span>{isDaily ? '正在取今天的推荐…' : '正在读取歌单…'}</span>
          </div>
          {SKEL_ROWS.map(i => (
            <div className="sr-skel-row" key={i} style={{ animationDelay: `${i * 80}ms` }}>
              <span className="sr-skel-art" />
              <span className="sr-skel-lines"><i /><i /></span>
            </div>
          ))}
        </div>
      )}
      {error && <div className="empty-state">{error}</div>}

      {/*
        工具条跟着 `selecting`（多选模式）走，不是跟着选中数量走——
        把已选的都点掉时它要留在原地，只是动作全灰、计数变 0。
      */}
      {selecting && (
        <div className="lib-batchbar" role="toolbar" aria-label="批量操作">
          <span className="bb-count">已选 <b className="num">{selSongs.length}</b> 首</span>
          <span className="bb-sep" aria-hidden="true" />
          <div className="bb-actions">
            <button className="bb-btn primary" disabled={!selSongs.length} onClick={() => p.playList(toLocalTracks(selSongs), 0)}>
              <IconPlay width={12} height={12} /> 播放
            </button>
            <button className="bb-btn" disabled={!selSongs.length} onClick={() => { const t = toLocalTracks(selSongs); queueToast(t, p.queueState.queue, 'next'); p.addManyToQueue(t, 'next') }}>
              <IconNext width={12} height={12} /> 下一首播放
            </button>
            <button className="bb-btn" disabled={!selSongs.length} onClick={() => { const t = toLocalTracks(selSongs); queueToast(t, p.queueState.queue, 'end'); p.addManyToQueue(t, 'end') }}>
              <IconPlus width={12} height={12} /> 加入播放列表
            </button>
            <button
              className="bb-btn"
              disabled={!selSongs.length}
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
              disabled={!selSongs.length}
              onClick={() => {
                if (!selSongs.length) return
                setAddTo(toLocalTracks(selSongs).map(t => t.id))
              }}
            >
              <IconMusicNote width={12} height={12} /> 加入其它歌单
            </button>
            <button
              className="bb-btn"
              disabled={!selSongs.length}
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
        <div className="sr-list" ref={listRef} data-selecting={selecting ? 'true' : undefined}>
          {songs.map((sg, i) => {
            const live = p.current?.id === `online:${sg.source}:${sg.id}`
            const key = keyOf(sg)
            const on = sel.has(key)
            return (
              <div
                key={`${sg.id}:${i}`}
                className={'sr-row' + (live ? ' live' : '') + (on ? ' selected' : '')}
                title="点击播放 · 长按多选 · ⋯ 更多"
                onClick={e => { if (consumeLongPress()) return; onRowClick(sg, i, e) }}
                onTouchStart={() => { touchAt.current = Date.now() }}
                {...longPressProps(() => {
                  /*
                   * 触摸屏：长按 = 进入多选并选中这一行。
                   * 以前这里同时弹 `OnlineSongMenu`（贴手指的右键菜单），
                   * 手机上它经常被播放条压住、也放不到屏幕边上——用户反馈
                   * 「长按以后没有可操作空间」说的就是这个。多选工具条贴底，
                   * 空间足够，动作也齐（播放 / 队列 / 下载 / 加入歌单）。
                   */
                  if (!on) { setSel(new Set([key])); anchor.current = i }
                  /* 长按一定进多选；之后把勾选全取消也不会自己退出去 */
                  setSelecting(true)
                })}
                onContextMenu={e => {
                  e.preventDefault()
                  /* 触摸长按补发的 contextmenu：已经进多选了，别再叠一个菜单上去 */
                  if (Date.now() - touchAt.current < 1000) return
                  /*
                   * 右键不碰选择状态：曲目菜单是对着**这一首**的操作，
                   * 顺手改选中集合只会让行上莫名多出高亮（多选态由 selecting 控制，
                   * sel 里有东西但没进多选时，列表会显示一堆勾）。
                   */
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
                <span
                  className="sr-art"
                  aria-hidden="true"
                  data-cover={!(sg.img || covers[key]) ? key : undefined}
                  style={(sg.img || covers[key]) ? { backgroundImage: `url(${sg.img || covers[key]})` } : undefined}
                />
                <span className="sr-idx num">{i + 1}</span>
                <div className="sr-main">
                  <div className="sr-title">
                    {sg.name}
                    {live && <span className="eq-mini" />}
                  </div>
                  <div className="sr-meta">
                    {/*
                     * 混排（「为你推荐」）里每首歌来自不同平台，必须在行内标出来——
                     * 否则列表看着像一家人的歌，点开才发现音质/版权都不一样。
                     *
                     * 放在歌手**前面**而不是行尾独立一列：手机上那条 `.sr-badge`
                     * 是被 `display:none` 掉的（宽度不够，而且手机上整列只剩一个色块），
                     * 塞进 meta 行才在手机和桌面都看得见。
                     * 也别放到 `.sr-dot` 后面：手机 CSS 有 `.sr-dot + span { display:none }`
                     * 专门隐藏专辑名，跟着一起被吞掉。
                     */}
                    {isMix && (
                      <span className="sr-src" data-src={sg.source}>{platformName(sg.source)}</span>
                    )}
                    <span>{sg.singer.join(' / ') || '未知歌手'}</span>
                    {sg.albumName && <span className="sr-dot">·</span>}
                    {sg.albumName && <span>{sg.albumName}</span>}
                  </div>
                </div>
                {/* 混排已有行内标识，行尾这一格留给时长；单平台歌单照旧用整列标签 */}
                {!isMix && <span className="sr-badge sm" data-src={sg.source}>{platformName(sg.source)}</span>}
                <span className="sr-dur num">{fmtTime(sg.interval)}</span>
                {/*
                 * 行尾三颗（手机与桌面同一套）：收藏 / 下一首播放 / ⋯。
                 *
                 * 「播放」去掉了——点这一行本来就是播放，多一颗只会挤占宽度；
                 * 「下载」挪进 ⋯ 里（菜单本来就有，还带进度状态）。
                 * ⋯ 弹的是**曲目菜单**（立即播放 / 下一首 / 加入队列 / 下载 /
                 * 复制 / 来源），不是播放栏上面那个底部面板，也不是多选工具条。
                 */}
                {(() => {
                  const track = toLocalTrack(sg)
                  const favOn = favs.has(track.id)
                  return (
                    <div className="sr-acts" data-acts="fav-next-more">
                      <button
                        className={'icon-btn' + (favOn ? ' on' : '')}
                        title={favOn ? '取消收藏' : '收藏'}
                        aria-label={(favOn ? '取消收藏 ' : '收藏 ') + sg.name}
                        aria-pressed={favOn}
                        onClick={async e => {
                          e.stopPropagation()
                          const on = await favs.toggle(favRecOf(track))
                          toast(on ? '已收藏' : '已取消收藏', { ok: on })
                        }}
                      >
                        {favOn ? <IconHeartFilled width={16} height={16} /> : <IconHeart width={16} height={16} />}
                      </button>
                      <button
                        className="icon-btn"
                        title="下一首播放"
                        aria-label={'下一首播放 ' + sg.name}
                        onClick={e => {
                          e.stopPropagation()
                          p.addToQueue(track, 'next')
                          toast('已设为下一首播放', { ok: true })
                        }}
                      >
                        <IconNext width={16} height={16} />
                      </button>
                      <button
                        className="icon-btn"
                        title="更多操作"
                        aria-label={'更多操作：' + sg.name}
                        onClick={e => {
                          e.stopPropagation()
                          /* 贴着这颗按钮弹：右上角那颗，菜单会自己往左翻，不会出屏 */
                          const r = e.currentTarget.getBoundingClientRect()
                          setMenu({ x: Math.round(r.right), y: Math.round(r.bottom + 4), song: sg })
                        }}
                      >
                        <IconMore width={16} height={16} />
                      </button>
                    </div>
                  )
                })()}
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
