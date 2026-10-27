/**
 * 在线搜索页：单曲 / 歌单 两个 Tab，四个平台可任选。
 *
 * 三个必须做对的地方（都是踩过的坑）：
 *   1. **300ms 防抖** —— 每敲一个字就发 4 个平台的请求，会被风控，也会把 UI 打满
 *   2. **requestId 竞态保护** —— 后发的请求可能先回来，回填前必须校验序号，
 *      否则「搜周杰」的结果会盖掉「搜周杰伦」的结果
 *   3. **来源标签不可省** —— 四个平台的歌重名极多，不标平台用户根本分不清点了哪个
 *
 * 动效克制：不做逐项 stagger 入场（列表几十行，入场动画会让滚动发飘）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtTime } from '@shuyin/core'
import { PlatformBusyError } from '@shuyin/lx-provider'
import type {
  PlaylistSearchItem, PlatformSource, SearchSong,
} from '@shuyin/lx-provider'
import { ALL_PLATFORMS } from '@shuyin/lx-provider'
import { usePlayer } from '../lib/PlayerProvider'
import { apiFor, onlineId, platformName, toLocalTrack } from '../lib/online'
import { KEYS, settings } from '../lib/settings'
import { toast } from '../lib/toast'
import { usePlaylists } from '../lib/localPlaylists'
import { IconNext, IconPause, IconPlay, IconPlus, IconSearch, IconStar } from '../components/icons'
import { OnlineSongMenu } from '../components/OnlineSongMenu'

type Tab = 'song' | 'playlist'

interface Props {
  onOpenPlaylist(p: { source: PlatformSource; id: string; name: string }): void
}

interface Row {
  song: SearchSong
  /** 该行所属平台（= song.source，展开写是为了渲染时少一次属性访问） */
  platform: PlatformSource
}

export function SearchPage({ onOpenPlaylist }: Props) {
  const bookmarks = usePlaylists()
  /** 收藏/取消收藏的轻提示 */
  const p = usePlayer()
  const [tab, setTab] = useState<Tab>('song')
  /** 右键菜单：在线曲目以前没有菜单，右键等于没反应 */
  const [menu, setMenu] = useState<{ x: number; y: number; song: SearchSong } | null>(null)
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [platforms, setPlatforms] = useState<PlatformSource[]>(ALL_PLATFORMS)
  const [history, setHistory] = useState<string[]>([])
  const [songs, setSongs] = useState<Row[]>([])
  const [playlists, setPlaylists] = useState<PlaylistSearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Array<{ platform: PlatformSource; message: string }>>([])
  /** 平台限流造成的「暂时跳过」：不是失败，单独用一行灰字提示，不糊红条 */
  const [busy, setBusy] = useState<PlatformSource[]>([])
  /** 每轮搜索一个序号，只有最新一轮的结果能写进 UI */
  const reqId = useRef(0)

  /* 历史 + 平台偏好 */
  useEffect(() => {
    void settings.get<string[]>(KEYS.searchHistory).then(v => { if (v) setHistory(v) })
    void settings.get<PlatformSource[]>(KEYS.searchPlatforms).then(v => {
      if (v && v.length) setPlatforms(v)
    })
  }, [])

  const pushHistory = useCallback((kw: string) => {
    setHistory(prev => {
      const next = [kw, ...prev.filter(x => x !== kw)].slice(0, 12)
      void settings.set(KEYS.searchHistory, next)
      return next
    })
  }, [])

  const togglePlatform = useCallback((s: PlatformSource) => {
    setPlatforms(prev => {
      const has = prev.includes(s)
      // 至少留一个，全关掉就没有搜索目标了
      if (has && prev.length === 1) return prev
      const next = has ? prev.filter(x => x !== s) : [...prev, s]
      void settings.set(KEYS.searchPlatforms, next)
      return next
    })
  }, [])

  /* 300ms 防抖：停止输入后才发请求 */
  useEffect(() => {
    const kw = input.trim()
    const t = window.setTimeout(() => setKeyword(kw), 300)
    return () => window.clearTimeout(t)
  }, [input])

  /* 真正搜索：并发打各平台，失败的平台单独记录但不影响其它平台 */
  useEffect(() => {
    if (!keyword) {
      setSongs([])
      setPlaylists([])
      setErrors([])
      setBusy([])
      setLoading(false)
      return
    }
    const id = ++reqId.current
    setLoading(true)
    setErrors([])
    setBusy([])

    const targets = platforms
    const jobs = targets.map(async (s): Promise<{ s: PlatformSource; songs?: SearchSong[]; playlists?: PlaylistSearchItem[]; err?: string; busy?: boolean }> => {
      const api = apiFor(s)
      if (!api) return { s, err: '该平台暂不支持' }
      try {
        if (tab === 'song') {
          if (!api.supportsSearch) return { s, err: '该平台不支持搜索' }
          const r = await api.search(keyword, 1, 30)
          return { s, songs: r.list }
        }
        if (!api.supportsPlaylistSearch || !api.searchPlaylist) return { s, err: '该平台不支持歌单搜索' }
        const r = await api.searchPlaylist(keyword, 1, 24)
        return { s, playlists: r.list }
      } catch (e) {
        // 限流是可以自己恢复的，对用户来说什么也做不了：不当错误展示
        if (e instanceof PlatformBusyError) return { s, busy: true }
        return { s, err: e instanceof Error ? e.message : String(e) }
      }
    })

    void Promise.all(jobs).then(results => {
      // 竞态：期间又发了新的一轮，这批结果直接丢弃
      if (id !== reqId.current) return
      const rows: Row[] = []
      const lists: PlaylistSearchItem[] = []
      const errs: Array<{ platform: PlatformSource; message: string }> = []
      const buses: PlatformSource[] = []
      for (const r of results) {
        if (r.busy) { buses.push(r.s); continue }
        if (r.err) { errs.push({ platform: r.s, message: r.err }); continue }
        if (r.songs) for (const sg of r.songs) rows.push({ song: sg, platform: r.s })
        if (r.playlists) lists.push(...r.playlists)
      }
      setSongs(rows)
      setPlaylists(lists)
      setErrors(errs)
      setBusy(buses)
      setLoading(false)
      if (rows.length || lists.length) pushHistory(keyword)
    })
  }, [keyword, platforms, tab, pushHistory])

  const submit = useCallback((kw?: string) => {
    const v = (kw ?? input).trim()
    setInput(v)
    setKeyword(v)
  }, [input])

  /**
   * 点行内播放。
   *
   * **点在正在播的这一首上 = 暂停 / 继续**，不是「从头再放一遍」。
   * 以前无条件 `playOne`：用户想暂停，点一下却重新加载（在线曲目还要重新取链），
   * 结果「点了没反应」和「歌从头开始」两种体验都出现过。
   * 队列也不会重复：`playOne` 本来就按 id 找位置，暂停这条路根本不碰队列。
   */
  const playSong = useCallback((row: Row) => {
    const id = onlineId(row.song)
    if (p.current?.id === id) {
      // 正在取链 / 加载中不给切：这时 toggle 会把「加载」打断成一个空暂停
      if (!p.onlineBusy && !p.loading) p.togglePlay()
      return
    }
    p.playOne(toLocalTrack(row.song))
  }, [p])

  const addSong = useCallback((row: Row, position: 'end' | 'next') => {
    p.addToQueue(toLocalTrack(row.song), position)
  }, [p])

  const grouped = useMemo(() => (
    tab === 'song'
      ? platforms.filter(s => songs.some(r => r.platform === s))
      : platforms.filter(s => playlists.some(x => x.source === s))
  ), [tab, platforms, songs, playlists])

  return (
    <div className="page search-page">
      <header className="lib-head">
        <div className="lib-head-left">
          <h1>在线搜索</h1>
          <span className="sub">网易云 · QQ 音乐 · 酷我 · 酷狗</span>
          {/* 和洛雪一样：搜索/歌单/歌词走平台官方接口，音源脚本只在取直链时用。
              这句放在这里，是为了不再让人以为「不导入音源就搜不了」。 */}
          <span className="sr-note" title="音源脚本只负责把搜到的歌换成能播的直链">
            搜索无需音源 · 播放/下载才需要
          </span>
        </div>
        <div className="lib-actions">
          <div className="search-box">
            <IconSearch />
            <input
              value={input}
              placeholder="搜歌名、歌手、专辑"
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              spellCheck={false}
            />
            {input && (
              <button className="icon-btn" aria-label="清空" onClick={() => { setInput(''); submit('') }}>
                ×
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="sr-bar">
        <div className="sr-tabs">
          <button className={'sr-tab' + (tab === 'song' ? ' active' : '')} onClick={() => setTab('song')}>单曲</button>
          <button className={'sr-tab' + (tab === 'playlist' ? ' active' : '')} onClick={() => setTab('playlist')}>歌单</button>
        </div>
        <div className="sr-platforms">
          {ALL_PLATFORMS.map(s => (
            <button
              key={s}
              className={'sr-plat' + (platforms.includes(s) ? ' active' : '')}
              onClick={() => togglePlatform(s)}
            >
              {platformName(s)}
            </button>
          ))}
        </div>
      </div>

      {!keyword && history.length > 0 && (
        <div className="sr-history">
          <span className="sr-history-label">最近搜索</span>
          {history.map(h => (
            <button key={h} className="sr-ghost" onClick={() => submit(h)}>{h}</button>
          ))}
        </div>
      )}

      {/*
       * 搜索中：内容区居中放一个转圈 + 一行小字。
       * 以前只有左上角一句「正在搜索…」，四平台并发通常要 1~3 秒，
       * 这段时间整块内容是空的——看起来像页面没反应。
       */}
      {loading && (
        <div className="sr-loading" role="status" aria-live="polite">
          <span className="sr-ring" aria-hidden="true">
            <i /><i /><i />
          </span>
          <div className="sr-loading-t">正在搜索「{keyword}」</div>
          <div className="sr-loading-s">
            同时问 {platforms.map(s => platformName(s)).join(' · ')}，谁先回来先显示
          </div>
        </div>
      )}

      {!loading && errors.length > 0 && (
        <div className="sr-errors">
          {errors.map(e => (
            <span key={e.platform} className="sr-error">{platformName(e.platform)}：{e.message}</span>
          ))}
        </div>
      )}

      {!loading && busy.length > 0 && (
        <div className="sr-busy">
          {busy.map(s => platformName(s)).join(' · ')} 触发了限流，已自动跳过（稍后恢复）
        </div>
      )}

      {!loading && keyword && !songs.length && !playlists.length && !errors.length && !busy.length && (
        <div className="empty-state">没有找到「{keyword}」</div>
      )}

      {tab === 'song' && songs.length > 0 && (
        <div className="sr-list">
          {grouped.map(plat => {
            const rows = songs.filter(r => r.platform === plat)
            return (
              <section key={plat} className="sr-group">
                <div className="sr-group-head">
                  <span className="sr-badge" data-src={plat}>{platformName(plat)}</span>
                  <span className="sr-group-count num">{rows.length}</span>
                </div>
                {rows.map(row => {
                  const live = p.current?.id === onlineId(row.song)
                  const livePlaying = live && p.snapshot.playing
                  return (
                    <div
                      key={`${plat}:${row.song.id}`}
                      className={'sr-row' + (live ? ' live' : '') + (livePlaying ? ' playing' : '')}
                      title={live ? '点一下暂停 / 继续' : '点击播放 · 右键更多操作'}
                      /* 点行就播：不必精确点到右侧那个小三角（双击同样有效）。
                         用户点的是一首歌，不是一行表格。 */
                      onClick={() => playSong(row)}
                      onContextMenu={e => {
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, song: row.song })
                      }}
                    >
                      <div className="sr-cover" style={row.song.img ? { backgroundImage: `url(${row.song.img})` } : undefined} />
                      <div className="sr-main">
                        <div className="sr-title">
                          {row.song.name}
                          {livePlaying && <span className="eq-mini" />}
                        </div>
                        <div className="sr-meta">
                          <span>{row.song.singer.join(' / ') || '未知歌手'}</span>
                          {row.song.albumName && <span className="sr-dot">·</span>}
                          {row.song.albumName && <span>{row.song.albumName}</span>}
                        </div>
                      </div>
                      <span className="sr-badge sm" data-src={plat}>{platformName(plat)}</span>
                      <span className="sr-dur num">{fmtTime(row.song.interval)}</span>
                      <div className="sr-acts">
                        {/* 当前这首：按钮变成暂停；其余仍是播放 */}
                        <button className="icon-btn" title={live ? (livePlaying ? '暂停' : '继续播放') : '播放'}
                          onClick={e => { e.stopPropagation(); playSong(row) }}>
                          {livePlaying ? <IconPause width={14} height={14} /> : <IconPlay />}
                        </button>
                        <button className="icon-btn" title="下一首播放" onClick={e => { e.stopPropagation(); addSong(row, 'next') }}><IconNext /></button>
                        <button className="icon-btn" title="加入队列" onClick={e => { e.stopPropagation(); addSong(row, 'end') }}><IconPlus /></button>
                      </div>
                    </div>
                  )
                })}
              </section>
            )
          })}
        </div>
      )}

      {tab === 'playlist' && playlists.length > 0 && (
        <div className="sr-grid">
          {playlists.map(item => {
            const canOpen = item.detailSupported !== false
            const faved = bookmarks.isFav(item.source, item.id)
            return (
              <div className="sr-card-wrap" key={`${item.source}:${item.id}`}>
                <button
                  className={'sr-card' + (canOpen ? '' : ' disabled')}
                  disabled={!canOpen}
                  title={canOpen ? item.name : '该平台暂不支持查看歌单详情'}
                  onClick={() => canOpen && onOpenPlaylist({ source: item.source, id: item.id, name: item.name })}
                >
                  {/* 封面用 <img> 而不是 background-image：卡片一次几十张，
                      交给图片解码器的 lazy/异步解码比背景图重绘省太多；
                      缺图时留着底色，不至于变成一张破图 */}
                  <div className="sr-card-cover">
                    {item.cover
                      ? <img src={item.cover} alt="" decoding="async"
                          onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                      : null}
                  </div>
                  <div className="sr-card-body">
                    <div className="sr-card-name">{item.name}</div>
                    <div className="sr-card-meta">
                      <span className="sr-badge sm" data-src={item.source}>{platformName(item.source)}</span>
                      {item.songCount ? <span className="num">{item.songCount} 首</span> : null}
                      {canOpen ? null : <span className="sr-soon">暂无详情</span>}
                    </div>
                  </div>
                </button>
                {/* 收藏：搜到别人的歌单一颗星就收到「我的 → 收藏的歌单」，
                    不用先打开详情再找入口 */}
                <button
                  className={'sr-fav' + (faved ? ' on' : '')}
                  aria-pressed={faved}
                  aria-label={faved ? '取消收藏' : '收藏歌单'}
                  title={faved ? '取消收藏' : '收藏到「我的」'}
                  onClick={() => {
                    const on = bookmarks.toggleFav({
                      source: item.source, id: item.id, name: item.name,
                      cover: item.cover, songCount: item.songCount,
                    })
                    toast(on ? `已收藏「${item.name}」` : `已取消收藏「${item.name}」`, { ok: on })
                  }}
                >
                  <IconStar width={14} height={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {menu && (
        <OnlineSongMenu x={menu.x} y={menu.y} song={menu.song} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
