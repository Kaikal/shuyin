/**
 * 歌曲评论（播放页右栏的「评论」标签）。
 *
 * 数据来自各平台自己的评论接口（见 lx-provider 的 `getComments`）：
 *   · 网易云 —— 一首歌动辄几万条，还带「热门」一组，首页先给热门 + 最新
 *   · QQ   —— 热评混在同一个列表里，楼层回复是 `middlecommentcontent`
 *   · 酷狗 —— 手机站 `mcomment` 接口，免签名；首屏**只给回复数量**，
 *            楼中楼要点开再取（`getReplies`）
 *   · 酷我 —— 没有稳定的免签名接口，那里会明确说「该平台暂不支持评论」，
 *            而不是转一圈转出个空白。
 *
 * 三个容易做坏的地方，这里都单独处理了：
 *   1. **回复**：楼中楼是两层结构。`replyTo` 是「回复 @某人」的引用，
 *      `replies` 是这条下面的回复列表——不折叠的话一条评论能撑满三屏。
 *      平台首屏只给前几条（酷狗一条都不给）时，点「展开」按需再取。
 *   2. **图片**：评论里的图经常是 1080 宽的竖图，直接塞进列表会把右栏拉成
 *      一列大图。这里限成 96px 的方格子、点击才放大。
 *   3. **换行**：酷狗 / 网易云的正文有真换行，`.cm-text` 是 `pre-wrap`，
 *      清洗文本时不能把 `\n` 折成空格。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LocalTrack } from '@shuyin/core'
import type { CommentPage, SongComment } from '@shuyin/lx-provider'
import { apiFor, platformName, songOf } from '../lib/online'
import { IconClose, IconRefresh } from './icons'

const PAGE = 20

/** 时间：近期用相对值，久远给日期。评论区里「3 天前」比「2026-10-21」更好读 */
function when(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 头像缺失时给一个首字方块，比破图好 */
function Avatar({ url, name }: { url?: string; name: string }) {
  const [bad, setBad] = useState(false)
  if (url && !bad) {
    return (
      <img
        className="cm-ava"
        src={url}
        alt=""
        decoding="async"
        /*
         * 三个容易踩的点：
         *   · 不能 lazy —— 评论面板是挂载后才滚动的容器，懒加载的图在
         *     WebView2 里常常等不到「进入视口」这一下，头像就一直是灰圈；
         *   · 不能带 Referer —— 各平台的头像 / 评论图 CDN 会拒掉陌生来源；
         *   · 失败退回首字方块，别留一个空 img。
         */
        referrerPolicy="no-referrer"
        onError={() => setBad(true)}
      />
    )
  }
  return <span className="cm-ava cm-ava-ph" aria-hidden="true">{Array.from(name)[0] ?? '?'}</span>
}

/** 评论图里的一张：加载失败时变成可点击的重试格子，而不是一块空白 */
function Thumb({ url, zoom, more }: { url: string; zoom: (u: string) => void; more?: number }) {
  const [bad, setBad] = useState(false)
  const [tryN, setTryN] = useState(0)

  const retry = () => {
    setBad(false)
    setTryN(n => n + 1)
  }
  // 重试时给 URL 挂一个无害的探测参数，绕开「浏览器缓存了那次失败」
  const src = tryN === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}_r=${tryN}`

  return (
    <button
      className={'cm-img' + (bad ? ' bad' : '')}
      onClick={() => (bad ? retry() : zoom(url))}
      title={bad ? '这张图没加载出来，点一下重试' : '点击查看大图'}
    >
      {bad ? <span className="cm-img-bad" aria-hidden="true">图片未加载</span> : (
        <img
          key={tryN}
          src={src}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBad(true)}
        />
      )}
      {!bad && more != null && more > 0 && <span className="cm-img-more">+{more}</span>}
    </button>
  )
}

/**
 * 评论图：格子限宽限高，点开看原图。
 *
 * 大图层必须 **portal 到 body**：直接留在评论列表里的话，`position: fixed`
 * 会被外层（播放页/右栏）的 transform 变成「相对那个祖先定位」，
 * 于是你往下滚，图片跟着列表一起滚走，看着就像「点开的图还停在原地」。
 * 挂到 body 还有个副作用是好的：滚轮不再落在评论列表上，列表也就不会在
 * 大图底下偷偷滚动。
 */
function Images({ list, small = false }: { list: string[]; small?: boolean }) {
  const [zoom, setZoom] = useState<string | null>(null)
  const shown = list.slice(0, 4)
  const rest = list.length - shown.length

  /* 大图开着时禁掉滚轮/键盘滚动，Esc 关闭 */
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null) }
    const stopWheel = (e: WheelEvent) => e.preventDefault()
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', stopWheel, { passive: false })
    document.documentElement.classList.add('cm-zoomed')
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', stopWheel)
      document.documentElement.classList.remove('cm-zoomed')
    }
  }, [zoom])

  return (
    <>
      <div className={'cm-imgs' + (small ? ' sm' : '')}>
        {shown.map((u, i) => (
          <Thumb key={u + i} url={u} zoom={setZoom} more={i === shown.length - 1 ? rest : undefined} />
        ))}
      </div>
      {zoom && createPortal(
        <div className="cm-lightbox" role="dialog" aria-label="查看图片"
          onClick={() => setZoom(null)}>
          <img src={zoom} alt="" referrerPolicy="no-referrer" />
          <button className="cm-lb-x icon-btn" aria-label="关闭" onClick={() => setZoom(null)}>
            <IconClose width={16} height={16} />
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

/** 一条回复（楼中楼里的，或者普通列表里的一条） */
function ReplyRow({ c }: { c: SongComment }) {
  return (
    <div className="cm-reply">
      <Avatar url={c.avatar} name={c.user} />
      <div className="cm-reply-main">
        <div className="cm-reply-head">
          <span className="cm-user">{c.user}</span>
          {c.time > 0 && <span className="cm-time">{when(c.time)}</span>}
        </div>
        <p className="cm-text">{c.content}</p>
        {c.images.length > 0 && <Images list={c.images} small />}
        {c.likes > 0 && <span className="cm-like-num">{c.likes}</span>}
      </div>
    </div>
  )
}

/** 一条主评论 */
function CommentRow({ c, loadReplies }: {
  c: SongComment
  /**
   * 按需取楼层。没有这个函数的平台（网易云 / QQ）沿用首屏里自带的那几条，
   * 「展开」只在本地折叠/展开，不会多发请求。
   */
  loadReplies?: (c: SongComment, page: number) => Promise<CommentPage>
}) {
  const total = c.replyTotal ?? c.replies?.length ?? 0
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<SongComment[]>(c.replies ?? [])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* 已经取到第几页；酷狗首屏一条回复都不给，所以第一次展开必须真的去请求 */
  const pageRef = useRef(1)

  const more = useCallback(() => {
    if (!loadReplies) return
    setBusy(true)
    setErr(null)
    loadReplies(c, pageRef.current)
      .then(r => {
        pageRef.current += 1
        setList(prev => {
          const seen = new Set(prev.map(x => x.id))
          return [...prev, ...r.list.filter(x => !seen.has(x.id))]
        })
      })
      .catch(e => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [c, loadReplies])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && loadReplies && list.length === 0 && total > 0) more()
  }

  const shown = open ? list : list.slice(0, 2)
  const canLoadMore = open && !!loadReplies && list.length < total
  return (
    <article className="cm-row">
      <Avatar url={c.avatar} name={c.user} />
      <div className="cm-main">
        <div className="cm-head">
          <span className="cm-user">{c.user}</span>
          {c.time > 0 && <span className="cm-time">{when(c.time)}</span>}
          {c.location && <span className="cm-loc">{c.location}</span>}
        </div>
        {c.replyTo && (
          <div className="cm-quote">
            <span className="cm-quote-u">{c.replyTo.user}：</span>
            {c.replyTo.content}
          </div>
        )}
        <p className="cm-text">{c.content}</p>
        {c.images.length > 0 && <Images list={c.images} />}
        <div className="cm-foot">
          {c.likes > 0 && (
            <span className="cm-like" title="点赞数">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M8 13.5S2 10 2 6.1A3.1 3.1 0 0 1 8 4.5a3.1 3.1 0 0 1 6 1.6C14 10 8 13.5 8 13.5Z" />
              </svg>
              {c.likes > 9999 ? `${(c.likes / 10000).toFixed(1)} 万` : c.likes}
            </span>
          )}
          {total > 2 && (
            <button className="cm-more" onClick={toggle} aria-expanded={open}
              title={loadReplies ? '按需读取回复' : undefined}>
              {busy && open ? '正在读取回复…' : open ? '收起回复' : `展开 ${total} 条回复`}
            </button>
          )}
          {canLoadMore && !busy && (
            <button className="cm-more" onClick={more}>加载更多回复</button>
          )}
          {err && (
            <button className="cm-more cm-more-bad" onClick={more} title={err}>回复没取到，重试</button>
          )}
        </div>
        {shown.length > 0 && (
          <div className="cm-replies">
            {shown.map(r => <ReplyRow key={r.id || r.user + r.time} c={r} />)}
          </div>
        )}
      </div>
    </article>
  )
}

export function Comments({ track }: { track: LocalTrack }) {
  const song = songOf(track.id)
  const api = song ? apiFor(song.source) : undefined
  const supported = !!api?.getComments

  /**
   * 楼层加载器：只有平台实现了 `getReplies` 才给。
   * 给了之后的语义是「首屏的回复不全，点开再去取」；没给就是「首屏那几条就是全部」。
   */
  const loadReplies = useMemo(() => {
    if (!song || !api?.getReplies) return undefined
    return (c: SongComment, page: number) => api.getReplies!(song, c, page, 10)
  }, [song, api])

  const [list, setList] = useState<SongComment[]>([])
  const [hot, setHot] = useState<SongComment[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback((p: number, append: boolean) => {
    if (!song || !api?.getComments) return
    const id = ++seq.current
    if (append) setMoreLoading(true)
    else { setLoading(true); setError(null) }
    api.getComments(song, p, PAGE)
      .then(r => {
        if (id !== seq.current) return
        setList(prev => (append ? [...prev, ...r.list] : r.list))
        if (!append) setHot(r.hot ?? [])
        setTotal(r.total)
        setHasMore(r.hasMore)
        setPage(p)
      })
      .catch(e => {
        if (id !== seq.current) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (id !== seq.current) return
        setLoading(false)
        setMoreLoading(false)
      })
  }, [song, api])

  /* 换歌立刻重来：不清空的话会先显示上一首的评论，看着像「评论错位」 */
  useEffect(() => {
    setList([]); setHot([]); setTotal(0); setPage(1); setHasMore(false); setError(null)
    if (supported) load(1, false)
  }, [track.id, supported, load])

  if (!song) {
    return <div className="cm-empty">本地歌曲没有平台评论</div>
  }
  if (!supported) {
    return (
      <div className="cm-empty">
        <p>{platformName(song.source)} 暂不支持评论</p>
        <span>换一首别的歌试试</span>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="cm-loading">
        <span className="sr-ring sm" aria-hidden="true"><i /><i /><i /></span>
        <span>正在读取评论…</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="cm-empty">
        <p>评论没取到</p>
        <span>{error}</span>
        <button className="link-btn" onClick={() => load(1, false)}>
          <IconRefresh width={12} height={12} /> 重试
        </button>
      </div>
    )
  }

  const hotIds = new Set(hot.map(c => c.id))
  const rest = list.filter(c => !hotIds.has(c.id))

  return (
    <div className="cm-wrap">
      <div className="cm-sum">
        {total > 0 ? (
          <>
            <b className="cm-count">{total > 9999 ? `${(total / 10000).toFixed(1)} 万` : total}</b>
            <span className="cm-unit">条评论</span>
          </>
        ) : (
          <span className="cm-unit">还没有评论</span>
        )}
        <span className="cm-src" title={`评论来自${platformName(song.source)}`}>
          <i className="cm-src-dot" aria-hidden="true" />
          来自 {platformName(song.source)}
        </span>
      </div>

      {hot.length > 0 && (
        <>
          <div className="cm-group">热门</div>
          {hot.map(c => <CommentRow key={`${song.id}-h-${c.id}`} c={c} loadReplies={loadReplies} />)}
        </>
      )}

      {rest.length > 0 && (
        <>
          {hot.length > 0 && <div className="cm-group">最新</div>}
          {rest.map(c => <CommentRow key={`${song.id}-${c.id}`} c={c} loadReplies={loadReplies} />)}
        </>
      )}

      {!list.length && !hot.length && <div className="cm-empty">这首歌还没有评论</div>}

      {hasMore && (
        <button className="ghost-btn cm-more-btn" disabled={moreLoading} onClick={() => load(page + 1, true)}>
          {moreLoading ? '正在加载…' : '加载更多评论'}
        </button>
      )}
    </div>
  )
}
