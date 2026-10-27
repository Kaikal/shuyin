/**
 * 歌单广场：每个平台「此刻在推什么」。
 *
 * 和在线搜索的区别：这里**没有关键词**，打开就该有一屏能听的歌单。
 * 平台只能单选（用户要求「一屏一个平台」）：
 *   · 四个平台的中文歌单名字高度相似（「全网热歌」「抖音热歌」…），混排时
 *     扫一眼根本分不清哪个是哪家的；
 *   · 单选 + 记住选择，下次打开还是上次那个平台，切换成本只有一下点击。
 *
 * 一屏里有两段：上面的**排行榜**（热歌榜 / 飙升榜 / 新歌榜 …）和下面的推荐歌单。
 * 榜单在用户心里就是「最该听的那批歌」，比推荐歌单更常用，所以放前面；
 * 它和歌单共用详情页——`RankListItem.id` 自带 `rank:` 前缀，
 * 点进去仍然是 `getPlaylistDetail(id)`，平台层自己分流。
 *
 * 数据来自各平台的推荐位（不是搜索）：网易云的个性化推荐、QQ 按热度排的
 * 推荐歌单、酷我的热门歌单、酷狗手机站的精选集。四家的翻页语义不一样，
 * 「还有没有下一页」由平台层算好（`hasMore`），这一页不自己猜。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { PlatformBusyError } from '@shuyin/lx-provider'
import type { HotPlaylistItem, PlatformSource, PlaylistDetail, RankListItem } from '@shuyin/lx-provider'
import { apiFor, dailyRecommend, platformName } from '../lib/online'
import { useAccount } from '../lib/platformAccount'
import { usePlaylists } from '../lib/localPlaylists'
import { KEYS, settings } from '../lib/settings'
import { toast } from '../lib/toast'
import { IconRefresh, IconStar, IconUpload } from '../components/icons'

/** 一页取多少：正好铺满一屏多两行的网格，翻页时不会「只冒出来一条」 */
const PAGE_SIZE = 24
/**
 * 排行榜默认只露一行（`is-clip` 按高度裁，不是按条数），
 * 超过这个数才给「展开全部」——常见窗口一行正好 7~8 个。
 * 网易云有 65 个榜，全铺开会把「热门歌单」挤到首屏之外。
 */
const RANK_CLIP_ABOVE = 8

interface Props {
  onOpenPlaylist(p: { source: PlatformSource; id: string; name: string; cover?: string }): void
  /** 打开「导入歌单」（本地文件匹配曲库）——它以前就挂在这一页上 */
  onImport(): void
}

/** 播放量：三万以下给原数，再往上换「万 / 亿」，卡片位置窄，别堆一长串数字 */
function fmtPlays(n?: number): string {
  const v = Number(n ?? 0)
  if (!v) return ''
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')} 亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')} 万`
  return String(v)
}

/** 平台层是否真的实现了热门歌单（没实现的平台不出现胶囊，不给空壳按钮） */
const HOT_PLATFORMS: PlatformSource[] = (['wy', 'tx', 'kw', 'kg'] as PlatformSource[])
  .filter(s => !!apiFor(s)?.getHotPlaylists)

/**
 * 一张歌单卡。「热门歌单」和登录后的「为你推荐」共用同一套——
 * 两处各写一份的话，收藏按钮的状态和样式迟早会走偏。
 */
function PlaylistCard({ item, faved, onOpen, onFav }: {
  item: HotPlaylistItem
  faved: boolean
  onOpen(): void
  onFav(): void
}) {
  const canOpen = item.detailSupported !== false
  const plays = fmtPlays(item.playCount)
  const tags = (item.tag || '').split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 2)
  return (
    <div className="sq-card">
      <button
        className={'sq-art' + (canOpen ? '' : ' disabled')}
        disabled={!canOpen}
        title={canOpen ? `打开「${item.name}」` : '该平台暂不支持查看歌单内容'}
        onClick={() => canOpen && onOpen()}
      >
        {item.cover
          ? (
            <img
              src={item.cover} alt="" decoding="async"
              onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
            />
          )
          : <span className="sq-art-empty" aria-hidden="true" />}
        {plays && <span className="sq-plays">{plays}</span>}
        {item.intro && <span className="sq-intro">{item.intro}</span>}
      </button>
      <button
        className={'sq-fav' + (faved ? ' on' : '')}
        aria-pressed={faved}
        aria-label={faved ? '取消收藏' : '收藏歌单'}
        title={faved ? '取消收藏' : '收藏到「我的」'}
        onClick={onFav}
      >
        <IconStar width={13} height={13} />
      </button>
      <button className="sq-name" disabled={!canOpen} title={item.name} onClick={() => canOpen && onOpen()}>
        {item.name}
      </button>
      <div className="sq-meta">
        <span className="sq-tag" data-src={item.source}>{platformName(item.source)}</span>
        {item.songCount ? <span className="num">{item.songCount} 首</span> : null}
        {tags.map(t => <span className="sq-tag ghost" key={t}>{t}</span>)}
      </div>
    </div>
  )
}

export function PlaylistSquarePage({ onOpenPlaylist, onImport }: Props) {
  const bookmarks = usePlaylists()
  const [platform, setPlatform] = useState<PlatformSource>('wy')
  /**
   * 当前平台的登录态。
   *
   * 登录入口不在这页（在「我的」）：广场是「看别人」的地方，
   * 登录之后才长的「每日推荐 / 为你推荐」本来就属于「我的」。
   * 这里只读登录态，用来决定这两段显示还是不显示。
   */
  const account = useAccount(platform)
  const [list, setList] = useState<HotPlaylistItem[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [err, setErr] = useState('')
  /** 排行榜：一次给完，不分页；失败就整段不显示（它是次要信息，不再糊第二条错误） */
  const [ranks, setRanks] = useState<RankListItem[]>([])
  const [rankOpen, setRankOpen] = useState(false)
  /** 每日推荐：每个平台一份，跟着平台走（懒加载，失败就整段不显示） */
  const [daily, setDaily] = useState<PlaylistDetail | null>(null)
  const [dailyLoad, setDailyLoad] = useState(false)
  /** 「为你推荐」歌单：只有登录后才有内容，未登录这一段整块不出现 */
  const [forYou, setForYou] = useState<HotPlaylistItem[]>([])
  /** 每次请求一个序号：切平台那一下后发的请求可能先回来，旧结果不能盖新平台 */
  const req = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  /** 读上次选的平台（没选过就网易云——推荐位最稳，不用登录也有内容） */
  useEffect(() => {
    void settings.get<PlatformSource>(KEYS.squarePlatform).then(v => {
      if (v && HOT_PLATFORMS.includes(v)) setPlatform(v)
    })
  }, [])

  const load = useCallback(async (p: PlatformSource, next: number, append: boolean) => {
    const api = apiFor(p)
    if (!api?.getHotPlaylists) {
      setErr('该平台暂不支持热门歌单')
      setLoading(false)
      return
    }
    const id = ++req.current
    if (append) setMore(true)
    else {
      setLoading(true)
      setErr('')
      setHasMore(true)
      setList([])
    }
    try {
      const r = await api.getHotPlaylists(next, PAGE_SIZE)
      if (id !== req.current) return
      setList(prev => {
        if (!append) return r.list
        // 平台翻页偶尔给重复条目（QQ 的 sin/ein 是闭区间、酷我最后一页会给满），
        // 按 source+id 去重，否则滚到底会看到同一张卡出现两次
        const seen = new Set(prev.map(x => `${x.source}:${x.id}`))
        return prev.concat(r.list.filter(x => !seen.has(`${x.source}:${x.id}`)))
      })
      setPage(next)
      setHasMore(r.hasMore && r.list.length > 0)
    } catch (e) {
      if (id !== req.current) return
      if (e instanceof PlatformBusyError) {
        setErr('这个平台暂时被限流了，等一两分钟再试')
      } else {
        setErr(e instanceof Error ? e.message : String(e))
      }
      if (!append) setList([])
    } finally {
      if (id === req.current) {
        setLoading(false)
        setMore(false)
      }
    }
  }, [])

  /* 首次 + 切平台：重新从第一页拉 */
  useEffect(() => {
    void load(platform, 1, false)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [platform, load])

  /* 排行榜和歌单是两次独立请求：榜单慢/挂了不该拦住歌单 */
  useEffect(() => {
    const api = apiFor(platform)
    setRanks([])
    setRankOpen(false)
    if (!api?.getRanklists) return
    let dead = false
    api.getRanklists()
      .then(r => { if (!dead) setRanks(r.list) })
      .catch(() => { if (!dead) setRanks([]) })
    return () => { dead = true }
  }, [platform])

  /* 每日推荐：**登录之后才有，没登录和平台不支持时整块不出现**。
     手机 App 里不登录就没有每日推荐，这边拿公共推荐流顶替只会让人
     拿它跟 App 逐首对照。哪些平台真有这个接口，看 `getDailyRecommend`。 */
  useEffect(() => {
    setDaily(null)
    if (!account?.cookie || !apiFor(platform)?.getDailyRecommend) { setDailyLoad(false); return }
    setDailyLoad(true)
    let dead = false
    dailyRecommend(platform)
      .then(d => { if (!dead) { setDaily(d); setDailyLoad(false) } })
      // 取不到就整块不显示：这一段不是主内容，不弹错误，也不拿别的歌单顶替
      .catch(() => { if (!dead) setDailyLoad(false) })
    return () => { dead = true }
  }, [platform, account?.cookie])

  /* 为你推荐：登录后才有。未登录直接不发请求（平台会回 301，平白多一条错误日志） */
  useEffect(() => {
    setForYou([])
    const api = apiFor(platform)
    if (!api?.getForYouPlaylists || !account?.cookie) return
    let dead = false
    api.getForYouPlaylists()
      .then(r => { if (!dead && r) setForYou(r.list) })
      .catch(() => { /* 拿不到就整段不显示，不打扰 */ })
    return () => { dead = true }
  }, [platform, account?.cookie])

  const pick = useCallback((s: PlatformSource) => {
    if (s === platform) return
    setPlatform(s)
    void settings.set(KEYS.squarePlatform, s)
  }, [platform])

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (loading || more || !hasMore || err) return
    const el = e.currentTarget
    // 离底 320px 就预取：等真的滚到底再发，用户会看到一段空白
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 320) {
      void load(platform, page + 1, true)
    }
  }, [loading, more, hasMore, err, platform, page, load])

  return (
    <div className="page sq-page">
      <header className="lib-head">
        <div className="lib-head-left">
          <h1>歌单广场</h1>
          <span className="sub">
            {HOT_PLATFORMS.map(s => platformName(s)).join(' · ')} 的排行榜与热门歌单
          </span>
        </div>
        <div className="lib-actions">
          <button className="ghost-btn sq-import" onClick={onImport}>
            <IconUpload width={14} height={14} />
            导入歌单
          </button>
        </div>
      </header>

      <div className="sq-bar">
        <div className="sq-plats" role="tablist" aria-label="音乐平台">
          {HOT_PLATFORMS.map(s => (
            <button
              key={s}
              role="tab"
              aria-selected={platform === s}
              className={'sq-plat' + (platform === s ? ' active' : '')}
              onClick={() => pick(s)}
            >
              {platformName(s)}
            </button>
          ))}
        </div>
        <div className="sq-bar-right">
          <span className="sq-hint-sub">点平台换一屏，选过的会记住</span>
        </div>
      </div>

      <div className="sq-scroll" ref={scrollRef} onScroll={onScroll}>
        {account && !!apiFor(platform)?.getDailyRecommend && (dailyLoad || daily) && (
          <section className="sq-sec">
            <div className="sq-sec-head">
              <h2>每日推荐</h2>
              <span className="sq-sec-n">
                {daily ? `${daily.songs.length} 首 · 每天换一批` : '正在取…'}
              </span>
            </div>
            <button
              className={'sq-daily' + (daily ? '' : ' is-loading')}
              disabled={!daily}
              onClick={() => daily && onOpenPlaylist({
                source: platform, id: `daily:${platform}`, name: '每日推荐', cover: daily.cover,
              })}
            >
              <span
                className="sq-daily-art"
                style={daily?.cover ? { backgroundImage: `url(${daily.cover})` } : undefined}
              />
              <span className="sq-daily-txt">
                <span className="sq-daily-name">每日推荐</span>
                <span className="sq-daily-sub">{daily?.name || '正在取今天的推荐…'}</span>
              </span>
            </button>
          </section>
        )}

        {forYou.length > 0 && (
          <section className="sq-sec">
            <div className="sq-sec-head">
              <h2>为你推荐</h2>
              <span className="sq-sec-n">{forYou.length} 个 · 按你的口味</span>
            </div>
            <div className="sq-grid">
              {forYou.map(item => (
                <PlaylistCard
                  key={`foryou:${item.source}:${item.id}`}
                  item={item}
                  faved={bookmarks.isFav(item.source, item.id)}
                  onOpen={() => onOpenPlaylist({ source: item.source, id: item.id, name: item.name, cover: item.cover })}
                  onFav={() => {
                    const on = bookmarks.toggleFav({
                      source: item.source, id: item.id, name: item.name,
                      cover: item.cover, songCount: item.songCount,
                    })
                    toast(on ? `已收藏「${item.name}」` : `已取消收藏「${item.name}」`, { ok: on })
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {ranks.length > 0 && (
          <section className="sq-sec">
            <div className="sq-sec-head">
              <h2>排行榜</h2>
              <span className="sq-sec-n">{ranks.length} 个</span>
              {ranks.length > RANK_CLIP_ABOVE && (
                <button className="sq-sec-more" onClick={() => setRankOpen(v => !v)}>
                  {rankOpen ? '收起' : '展开全部'}
                </button>
              )}
            </div>
            <div className={'sq-ranks' + (rankOpen ? '' : ' is-clip')}>
              {ranks.map(r => {
                // 有分组就先显分组（「官方」「巅峰榜」），没有就用首数兜住那一行
                const sub = r.group || (r.songCount ? `${r.songCount} 首` : fmtPlays(r.playCount))
                return (
                  <button
                    key={r.id}
                    className="sq-rank"
                    title={r.intro || `打开「${r.name}」`}
                    onClick={() => onOpenPlaylist({ source: r.source, id: r.id, name: r.name, cover: r.cover })}
                  >
                    <span className="sq-rank-art">
                      {r.cover
                        ? (
                          <img
                            src={r.cover} alt="" decoding="async"
                            onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
                          />
                        )
                        : <span className="sq-rank-ph" aria-hidden="true">{r.name.slice(0, 1)}</span>}
                    </span>
                    <span className="sq-rank-name">{r.name}</span>
                    {sub && <span className="sq-rank-sub">{sub}</span>}
                  </button>
                )
              })}
            </div>
          </section>
        )}

        <div className="sq-sec-head sq-sec-head-pl">
          <h2>热门歌单</h2>
        </div>

        {loading && (
          <div className="sq-grid" aria-hidden="true">
            {Array.from({ length: 12 }).map((_, i) => (
              <div className="sq-sk" key={i}>
                <div className="sq-sk-cover" />
                <div className="sq-sk-line" />
                <div className="sq-sk-line short" />
              </div>
            ))}
          </div>
        )}

        {!loading && err && (
          <div className="sq-err">
            <span>{err}</span>
            <button className="ghost-btn" onClick={() => void load(platform, 1, false)}>
              <IconRefresh width={13} height={13} />
              重试
            </button>
          </div>
        )}

        {!loading && !err && !list.length && (
          <div className="empty-state">
            <div className="title">这个平台这会儿没有推荐歌单</div>
            <div className="sub">换一个平台看看，或者稍后再来</div>
          </div>
        )}

        {!loading && list.length > 0 && (
          <div className="sq-grid">
            {list.map(item => (
              <PlaylistCard
                key={`${item.source}:${item.id}`}
                item={item}
                faved={bookmarks.isFav(item.source, item.id)}
                onOpen={() => onOpenPlaylist({ source: item.source, id: item.id, name: item.name, cover: item.cover })}
                onFav={() => {
                  const on = bookmarks.toggleFav({
                    source: item.source, id: item.id, name: item.name,
                    cover: item.cover, songCount: item.songCount,
                  })
                  toast(on ? `已收藏「${item.name}」` : `已取消收藏「${item.name}」`, { ok: on })
                }}
              />
            ))}
          </div>
        )}

        {more && <div className="sq-more">正在加载更多…</div>}
        {!loading && !more && !err && list.length > 0 && !hasMore && (
          <div className="sq-end">— 就到这儿了 · 共 {list.length} 个歌单 —</div>
        )}
      </div>
    </div>
  )
}
