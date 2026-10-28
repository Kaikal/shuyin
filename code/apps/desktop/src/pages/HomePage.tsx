/**
 * 「我的」页面：这是应用的主页。
 *
 * 一页看全三件事，**不再分 Tab**：
 *   1. 自己建 / 导入的歌单：新建、导入、改名、删除、点开听；
 *   2. 收藏的在线歌单：搜索页点星标收进来，点开走在线歌单详情；
 *   3. 本地音乐：原「本地音乐」页整页搬进来，扫描、搜索、多选、批量全在。
 *
 * 为什么并成一个页面：以前侧栏是「本地音乐 / 导入歌单」两个并列项，
 * 用户想「先建个歌单再把歌放进去」得在两页之间来回跳，而这两件事本来就是一件事。
 * v0.5.1 起连 Tab 也去掉了——切 Tab 等于又藏了一半内容，直接上下排开。
 * 侧栏那个「歌单广场」页保留给后续接各大 APP 歌单，这轮不动。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fmtTime, type LocalTrack } from '@shuyin/core'
import type { HotPlaylistItem, PlatformSource } from '@shuyin/lx-provider'
import { usePlayer } from '../lib/PlayerProvider'
import { usePlaylists, mosaicOf, type LocalPlaylist } from '../lib/localPlaylists'
import { bridge } from '../lib/bridge'
import { matchSongs, parsePlaylist } from '../lib/playlistImport'
import { KEYS, settings } from '../lib/settings'
import { loadProfile, type CloudProfile } from '../lib/cloud'
import { toast } from '../lib/toast'
import { confirm } from '../lib/confirm'
import { consumeLongPress, longPressProps } from '../lib/longPress'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { Modal } from '../components/Modal'
import { HelpTip } from '../components/HelpTip'
import { AccountPanel } from '../components/AccountPanel'
import { LoginQrDialog } from '../components/LoginQrDialog'
import { apiFor, clearDailyCache, platformName, userPlaylists } from '../lib/online'
import {
  LOGIN_PLATFORMS, loginPlatform, logoutPlatform, useAccounts, type PlatformAccount,
} from '../lib/platformAccount'
import { supportsQr } from '../lib/qrLogin'
import {
  IconFolder, IconMusicNote, IconPlay, IconPlus, IconRefresh, IconTrash, IconUpload, IconUser,
} from '../components/icons'

/**
 * 「我的」里列出的平台账号。
 *
 * 用的是平台侧的登录通道表（四家都有），不是「谁实现了 getAccount」——
 * 后者只决定登录之后能不能显示昵称，不该决定能不能登录。
 */
/**
 * 能在这里登录的平台。
 *
 * 四家都列出来：桌面走「内嵌官方登录窗」，安卓走「WebView 登录页」
 * （`platform_login` 在两边都有实现），扫码只是网易云多出来的一条快捷路。
 * 哪家走扫码由 `supportsQr` 决定，**不靠隐藏按钮**——按钮少一个，
 * 用户只会以为「这个平台不支持登录」。
 */
const PLATFORMS = LOGIN_PLATFORMS

interface Props {
  onOpenDetail(t: LocalTrack): void
  onOpenLocalPlaylist(id: string): void
  onOpenOnlinePlaylist(p: { source: PlatformSource; id: string; name: string }): void
  /** 打开「本地音乐」列表（横条卡片点进来） */
  onOpenLibrary(): void
}

const IMPORT_HELP = [
  '支持网易云 / QQ 音乐 / 酷狗导出的歌单文件：JSON、TXT、CSV、M3U、PLS 都能认，格式自动判断，不用改扩展名。',
  '',
  'TXT 一行一首：「歌名 - 歌手」最省事；',
  'CSV 第一行写表头（歌名,歌手,专辑）；',
  'M3U / PLS 会优先按文件路径对上本地曲库。',
  '',
  '导入后会立刻和本地曲库匹配，匹配不上的歌不会丢——记在歌单里，等曲库补上再对。',
].join('\n')

export function HomePage({ onOpenLocalPlaylist, onOpenOnlinePlaylist, onOpenLibrary }: Props) {
  const p = usePlayer()
  const pl = usePlaylists()
  /** 登录入口就在这一页，不用专门跑设置 */
  const [profile, setProfile] = useState<CloudProfile | null>(null)
  const [acctOpen, setAcctOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  /** 新建 / 重命名共用一个弹窗 */
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'rename'; list: LocalPlaylist } | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; list: LocalPlaylist } | null>(null)
  const [favMenu, setFavMenu] = useState<{ x: number; y: number; key: string; name: string } | null>(null)

  /*
   * 平台账号的登录入口就在这一页：扫码登录是「我的」的事（登录之后长出来的是
   * 我的歌单），没有理由再把按钮放到歌单广场那种「看别人」的页面上。
   */
  const accounts = useAccounts()
  /** 刷新计数：点一次「刷新」就 +1，平台歌单那边跟着重拉 */
  const [refreshTick, setRefreshTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const platList = usePlatformPlaylists(accounts, refreshTick)
  const [qrSource, setQrSource] = useState<PlatformSource | null>(null)

  const startLogin = useCallback(async (s: PlatformSource) => {
    // 有扫码协议的直接画二维码（不弹网页）；没有的退回官方登录窗
    if (supportsQr(s)) { setQrSource(s); return }
    const r = await loginPlatform(s)
    if (r.ok) {
      clearDailyCache()
      toast(`已登录${platformName(s)}`, { ok: true })
    } else if (!r.cancel) {
      toast(r.error || '登录没成功', { bad: true })
    }
  }, [])

  const stopLogin = useCallback(async (s: PlatformSource) => {
    const ok = await confirm({
      title: `退出${platformName(s)}账号？`,
      message: '退出后这部分歌单就看不到了，随时可以再登。',
      confirmText: '退出',
      danger: true,
    })
    if (!ok) return
    await logoutPlatform(s, () => apiFor(s)?.logout?.() ?? Promise.resolve())
    clearDailyCache()
    toast(`已退出${platformName(s)}`)
  }, [])

  /**
   * 刷新「我的」：平台上的歌单是会变的（在手机上新建、收藏、取消收藏），
   * 而这一页只在登录态变化时自动重拉——不刷新就只能重启应用才看得到新歌单。
   * 每日推荐的缓存也一起清掉，它按天变。
   */
  const doRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    clearDailyCache()
    setRefreshTick(t => t + 1)
    setProfile(await loadProfile())
    toast('已刷新', { ok: true })
    setRefreshing(false)
  }, [refreshing])

  /* 本地音乐横条卡的封面：取曲库里前 4 张专辑封面拼一格 */
  const libMosaic = useMemo(() => mosaicOf(p.library, 4), [p.library])
  const libMeta = useMemo(() => {
    const scope = p.scanScope === 'full' ? '全盘扫描' : p.scanScope === 'custom' ? '指定文件夹' : '音乐文件夹'
    const parts = [`${p.library.length} 首`, scope]
    if (p.lastScanAt) parts.push('上次扫描 ' + relTime(p.lastScanAt))
    return parts.join(' · ')
  }, [p.library.length, p.scanScope, p.lastScanAt])

  useEffect(() => {
    void (async () => setProfile(await loadProfile()))()
  }, [])

  const openNew = () => { setDraftName(''); setDraftNote(''); setEditing({ mode: 'new' }) }
  const openRename = (l: LocalPlaylist) => { setDraftName(l.name); setDraftNote(l.note ?? ''); setEditing({ mode: 'rename', list: l }) }

  const submitEdit = () => {
    const name = draftName.trim()
    if (!name) return
    if (editing?.mode === 'new') {
      pl.create(name, { note: draftNote })
      toast(`已新建歌单「${name}」`, { ok: true })
    } else if (editing?.mode === 'rename') {
      pl.rename(editing.list.id, name)
      toast('已改名', { ok: true })
    }
    setEditing(null)
  }

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of pl.lists) {
      const byId = new Set(p.library.map(t => t.id))
      map.set(l.id, l.trackIds.filter(id => byId.has(id)).length)
    }
    return map
  }, [pl.lists, p.library])

  /** 导入：选文件 → 解析 → 与曲库匹配 → 存成歌单 */
  const doImport = useCallback(async () => {
    if (importing) return
    setImporting(true)
    try {
      const path = await bridge.invoke<string | null>('pick_playlist_file')
      if (!path) return
      const fileName = path.replace(/^.*[\\/]/, '')

      /* 洛雪 .lxmc：歌带平台直连 id，直接建成「在线歌单」，不走路库匹配 */
      if (/\.lxmc$/i.test(fileName)) {
        const raw = await bridge.invoke<number[] | string>('read_bin_abs', { path })
        const buf = typeof raw === 'string'
          ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
          : new Uint8Array(raw)
        const { isLxmcBuffer, parseLxmc } = await import('../lib/lxmc')
        if (isLxmcBuffer(buf)) {
          const lists = await parseLxmc(buf)
          if (lists.length) {
            for (const lx of lists) {
              if (!lx.tracks.length) continue
              pl.create(lx.name, { trackIds: lx.tracks.map(t => t.id), origin: 'import', originName: fileName })
            }
            const total = lists.reduce((n, l) => n + l.tracks.length, 0)
            toast(`已导入 ${lists.length} 张洛雪歌单（${total} 首，在线曲目可直接播放）`, { ok: true })
            const item = { name: fileName, at: Date.now(), total, matched: total }
            const recent = (await settings.get<typeof item[]>(KEYS.recentImports)) ?? []
            void settings.set(KEYS.recentImports, [item, ...recent.filter(x => x.name !== fileName)].slice(0, 5))
            return
          }
        }
        toast('这个 .lxmc 打不开（不是洛雪歌单导出的格式）', { bad: true })
        return
      }

      const text = await bridge.invoke<string>('read_text_abs', { path })
      const parsed = parsePlaylist(text, fileName)
      if (!parsed.songs.length) {
        toast('这个文件里没认出歌来，换一个试试', { bad: true })
        return
      }
      const out = matchSongs(parsed.songs, p.library)
      const created = pl.create(parsed.name || fileName.replace(/\.[a-z0-9]+$/i, ''), {
        trackIds: out.matched.map(m => m.track.id),
        missing: out.unmatched.map(s => ({ title: s.title, artist: s.artist })),
        origin: 'import',
        originName: fileName,
      })
      const miss = out.unmatched.length
      toast(
        `已导入「${created.name}」：${out.matched.length} 首${miss ? `，还有 ${miss} 首曲库里没有` : ''}`,
        { bad: miss > 0 && out.matched.length === 0 },
      )
      const item = { name: fileName, at: Date.now(), total: parsed.songs.length, matched: out.matched.length }
      const recent = (await settings.get<typeof item[]>(KEYS.recentImports)) ?? []
      void settings.set(KEYS.recentImports, [item, ...recent.filter(x => x.name !== fileName)].slice(0, 5))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { bad: true })
    } finally {
      setImporting(false)
    }
  }, [importing, p.library, pl])

  const playList = (l: LocalPlaylist) => {
    const tracks = pl.tracksOf(l, p.library)
    if (!tracks.length) { toast('这个歌单里还没有本地能播的歌', { bad: true }); return }
    p.playList(tracks, 0)
  }

  const listMenu = (l: LocalPlaylist): MenuItem[] => [
    { id: 'play', label: '播放', icon: <IconPlay width={14} height={14} />, onSelect: () => playList(l) },
    { id: 'open', label: '打开歌单', icon: <IconFolder width={14} height={14} />, onSelect: () => onOpenLocalPlaylist(l.id) },
    { id: 'd1', label: '', divider: true, onSelect: () => {} },
    { id: 'rename', label: '重命名', onSelect: () => openRename(l) },
    {
      id: 'del', label: '删除歌单', danger: true, icon: <IconTrash width={14} height={14} />,
      onSelect: () => {
        void confirm({
          title: `删除歌单「${l.name}」？`,
          message: '只删这个歌单，歌还在曲库里。',
          confirmText: '删除',
          danger: true,
        }).then(ok => {
          if (!ok) return
          pl.remove(l.id)
          toast(`已删除「${l.name}」`)
        })
      },
    },
  ]

  return (
    <div className="page home-page">
      <header className="lib-head home-head">
        <div className="lib-head-left">
          <h1>我的</h1>
          <p className="lib-status">
            {pl.lists.length} 个歌单 · {pl.favs.length} 个收藏 · 本地 <b className="num">{p.library.length}</b> 首
          </p>
        </div>
        <div className="lib-actions">
          <button className="primary-btn" onClick={openNew}>
            <IconPlus width={13} height={13} /> 新建歌单
          </button>
          <button className="ghost-btn" onClick={() => void doImport()} disabled={importing}>
            <IconUpload width={13} height={13} /> {importing ? '导入中…' : '导入歌单'}
          </button>
          <HelpTip text={IMPORT_HELP} label="歌单导入说明" width={340} />
          {/* 刷新：平台歌单在手机上改过之后，这里不会自己变 */}
          <button
            className={'ghost-btn home-refresh' + (refreshing ? ' busy' : '')}
            onClick={() => void doRefresh()}
            disabled={refreshing}
            title="刷新平台歌单与推荐"
            aria-label="刷新"
          >
            <IconRefresh width={13} height={13} />
            <span className="home-refresh-lb">刷新</span>
          </button>
          {/* 登录入口放在这里：同步是「我的」的事，不该逼用户去设置里找 */}
          <button className={'ghost-btn home-acct' + (profile ? ' on' : '')} onClick={() => setAcctOpen(true)}>
            <IconUser width={13} height={13} />
            <span className="acct-label">
              {profile ? (profile.email ? shortMail(profile.email) : '已登录') : '登录'}
            </span>
          </button>
        </div>
      </header>

      <div className="home-scroll">
        {PLATFORMS.length > 0 && (
          <div className="home-plats">
            {PLATFORMS.map(s => {
              const acc = accounts[s]
              return (
                <div className={'home-plat' + (acc ? ' on' : '')} data-src={s} key={s}>
                  <span className="home-plat-dot" aria-hidden="true" />
                  <span className="home-plat-name">{platformName(s)}</span>
                  {acc
                    ? (
                      <>
                        <span className="home-plat-user">
                          <span
                            className="home-plat-avatar"
                            style={acc.avatar ? { backgroundImage: `url(${acc.avatar})` } : undefined}
                            aria-hidden="true"
                          />
                          <span className="home-plat-nick" title={acc.nickname || platformName(s)}>
                            {acc.nickname || '已登录'}
                          </span>
                        </span>
                        <button className="home-plat-btn quiet" onClick={() => void stopLogin(s)}>退出</button>
                      </>
                    )
                    : <button className="home-plat-btn" onClick={() => void startLogin(s)}>登录</button>}
                </div>
              )
            })}
          </div>
        )}

        {/*
         * 本地音乐：一条横贯整行的卡片，永远排在歌单上面。
         * 以前把它塞在歌单下面，歌单一多就得往下滚才找得到——
         * 「我的」里最常用的是自己的曲库，不该被歌单挡住。
         * 点这条打开完整的曲库页（扫描 / 搜索 / 多选都在那边）。
         */}
        <div
          className="home-band"
          role="button"
          tabIndex={0}
          title="打开本地音乐"
          onClick={onOpenLibrary}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenLibrary() } }}
        >
          <span className="home-band-cover">
            {libMosaic.length ? (
              <span className={'home-mosaic n' + libMosaic.length}>
                {libMosaic.map((src, i) => <img key={i} src={src} alt="" decoding="async" />)}
              </span>
            ) : (
              <span className="home-cover-blank"><IconMusicNote width={24} height={24} /></span>
            )}
          </span>
          <span className="home-band-main">
            <span className="home-band-name">本地音乐</span>
            <span className="home-band-meta">
              {p.library.length
                ? libMeta
                : '曲库还是空的 · 点开去扫描'}
            </span>
          </span>
          <span className="home-band-acts">
            {p.library.length > 0 && (
              <button
                className="home-band-play"
                aria-label="播放全部本地音乐"
                onClick={e => { e.stopPropagation(); p.playList(p.library, 0) }}
              >
                <IconPlay width={13} height={13} /> 播放全部
              </button>
            )}
            <span className="home-band-more">查看全部 →</span>
          </span>
        </div>

          <section className="home-sec">
            <div className="home-sec-head">
              <h2>我的歌单</h2>
            </div>
            {pl.lists.length === 0 && platList.length === 0 ? (
              <div className="home-empty">
                <div className="t">还没有歌单</div>
                <div className="s">新建一个，把喜欢的歌归到一起</div>
                <div className="home-empty-acts">
                  <button className="primary-btn" onClick={openNew}><IconPlus width={13} height={13} /> 新建歌单</button>
                  <button className="ghost-btn" onClick={() => void doImport()}><IconUpload width={13} height={13} /> 导入歌单</button>
                </div>
              </div>
            ) : (
              <div className="home-grid">
                {pl.lists.map(l => {
                  const tracks = pl.tracksOf(l, p.library)
                  const mosaic = mosaicOf(tracks, 4)
                  const total = tracks.reduce((n, t) => n + t.duration, 0)
                  const miss = l.missing?.length ?? 0
                  return (
                    <div
                      key={l.id}
                      className="home-card"
                      role="button"
                      tabIndex={0}
                      title={`${l.name} · ${tracks.length} 首`}
                      onClick={() => { if (consumeLongPress()) return; onOpenLocalPlaylist(l.id) }}
                      onKeyDown={e => { if (e.key === 'Enter') onOpenLocalPlaylist(l.id) }}
                      {...longPressProps(at => setMenu({ x: at.x, y: at.y, list: l }))}
                      onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, list: l }) }}
                    >
                      <div className="home-cover">
                        {mosaic.length ? (
                          <div className={'home-mosaic n' + mosaic.length}>
                            {mosaic.map((src, i) => <img key={i} src={src} alt="" decoding="async" />)}
                          </div>
                        ) : (
                          <span className="home-cover-blank"><IconMusicNote width={22} height={22} /></span>
                        )}
                        <span className="home-badge">{l.origin === 'import' ? '导入' : '自建'}</span>
                        <button className="home-play" aria-label={'播放 ' + l.name}
                          onClick={e => { e.stopPropagation(); playList(l) }}>
                          <IconPlay width={14} height={14} />
                        </button>
                      </div>
                      <div className="home-card-name">{l.name}</div>
                      <div className="home-card-meta">
                        <span className="num">{counts.get(l.id) ?? 0} 首</span>
                        {total > 0 && <span className="num"> · {fmtTime(total)}</span>}
                        {miss > 0 && <span className="home-miss"> · 缺 {miss}</span>}
                      </div>
                    </div>
                  )
                })}
                {/*
                 * 登录平台账号之后，自己在那边的歌单也摆在这里——
                 * 「我的歌单」本来就该是「我建的歌单」，不限本地还是线上。
                 * 点开走在线歌单详情（只读：改平台歌单得回平台）。
                 */}
                {platList.map(item => (
                  <div
                    key={`${item.source}:${item.id}`}
                    className="home-card"
                    role="button"
                    tabIndex={0}
                    title={`${item.name} · ${platformName(item.source)}`}
                    onClick={() => onOpenOnlinePlaylist({ source: item.source, id: item.id, name: item.name })}
                    onKeyDown={e => {
                      if (e.key === 'Enter') onOpenOnlinePlaylist({ source: item.source, id: item.id, name: item.name })
                    }}
                  >
                    <div className="home-cover">
                      {/* 占位始终在底层：封面取不到 / 加载失败都露出音符，不会留一块空白 */}
                      <span className="home-cover-blank"><IconMusicNote width={22} height={22} /></span>
                      {item.cover && (
                        <img
                          className="home-fav-cover" src={item.cover} alt="" decoding="async"
                          onError={e => { e.currentTarget.style.display = 'none' }}
                        />
                      )}
                      <span className="home-badge online">{platformName(item.source)}</span>
                    </div>
                    <div className="home-card-name">{item.name}</div>
                    <div className="home-card-meta">
                      {item.songCount ? <span className="num">{item.songCount} 首</span> : <span>在线歌单</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {pl.favs.length > 0 && (
            <section className="home-sec">
              <div className="home-sec-head">
                <h2>收藏的歌单</h2>
              </div>
              <div className="home-grid">
                {pl.favs.map(f => (
                  <div
                    key={f.key}
                    className="home-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (consumeLongPress()) return
                      onOpenOnlinePlaylist({ source: f.source, id: f.id, name: f.name })
                    }}
                    {...longPressProps(at => setFavMenu({ x: at.x, y: at.y, key: f.key, name: f.name }))}
                    onContextMenu={e => { e.preventDefault(); setFavMenu({ x: e.clientX, y: e.clientY, key: f.key, name: f.name }) }}
                  >
                    <div className="home-cover">
                      <span className="home-cover-blank"><IconMusicNote width={22} height={22} /></span>
                      {f.cover && (
                        <img
                          className="home-fav-cover" src={f.cover} alt="" decoding="async"
                          onError={e => { e.currentTarget.style.display = 'none' }}
                        />
                      )}
                      <span className="home-badge online">{platformName(f.source)}</span>
                    </div>
                    <div className="home-card-name">{f.name}</div>
                    <div className="home-card-meta">
                      {f.songCount ? <span className="num">{f.songCount} 首</span> : <span>在线歌单</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

      </div>

      <Modal
        open={acctOpen}
        title="账号与同步"
        onClose={() => setAcctOpen(false)}
        width={430}
        footer={<><span className="modal-sp" /><button className="ghost-btn" onClick={() => setAcctOpen(false)}>关闭</button></>}
      >
        <AccountPanel compact onProfile={setProfile} />
      </Modal>

      <Modal
        open={!!editing}
        title={editing?.mode === 'rename' ? '重命名歌单' : '新建歌单'}
        onClose={() => setEditing(null)}
        width={400}
        footer={
          <>
            <button className="ghost-btn" onClick={() => setEditing(null)}>取消</button>
            <button className="primary-btn" disabled={!draftName.trim()} onClick={submitEdit}>
              {editing?.mode === 'rename' ? '保存' : '创建'}
            </button>
          </>
        }
      >
        <div className="form-col">
          <label className="form-label" htmlFor="pl-name">名称</label>
          <input
            id="pl-name" className="text-input" autoFocus maxLength={60}
            placeholder="例如「深夜通勤」"
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitEdit() }}
          />
          <label className="form-label" htmlFor="pl-note">备注（可留空）</label>
          <input
            id="pl-note" className="text-input" maxLength={120}
            placeholder="给自己留一句提示"
            value={draftNote}
            onChange={e => setDraftNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitEdit() }}
          />
        </div>
      </Modal>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={listMenu(menu.list)} onClose={() => setMenu(null)} />
      )}
      {favMenu && (
        <ContextMenu
          x={favMenu.x} y={favMenu.y}
          items={[{
            id: 'unfav', label: '取消收藏', danger: true, icon: <IconTrash width={14} height={14} />,
            onSelect: () => {
              const f = pl.favs.find(x => x.key === favMenu.key)
              if (f) pl.toggleFav({ source: f.source, id: f.id, name: f.name, cover: f.cover, creator: f.creator, songCount: f.songCount })
              toast(`已取消收藏「${favMenu.name}」`)
            },
          }]}
          onClose={() => setFavMenu(null)}
        />
      )}

      <LoginQrDialog
        open={!!qrSource}
        source={qrSource}
        onClose={() => setQrSource(null)}
        /* 登录态是订阅式的：落地之后 accounts 自己会变，歌单列表跟着重拉 */
        onLogged={() => setQrSource(null)}
      />
    </div>
  )
}

/**
 * 已登录平台的「我建的歌单」。
 *
 * 登录 / 退出都会让 `accounts` 换成一个新对象 → `key` 变 → 重新拉一次。
 * 拉不到就当这个平台没有歌单：这是「我的」页的默认内容，不该因为平台抽风弹错误。
 */
function usePlatformPlaylists(
  accounts: Partial<Record<PlatformSource, PlatformAccount>>,
  /** 刷新计数：变一次就重拉一次（值本身不参与请求） */
  tick = 0,
): HotPlaylistItem[] {
  const key = Object.keys(accounts).sort().join(',')
  const [bySrc, setBySrc] = useState<Partial<Record<PlatformSource, HotPlaylistItem[]>>>({})
  useEffect(() => {
    if (!key) { setBySrc({}); return }
    let dead = false
    const srcs = key.split(',') as PlatformSource[]
    void Promise.all(srcs.map(async s => [s, (await userPlaylists(s))?.list ?? []] as const))
      .then(pairs => {
        if (dead) return
        const next: Partial<Record<PlatformSource, HotPlaylistItem[]>> = {}
        for (const [s, list] of pairs) next[s] = list
        setBySrc(next)
      })
    return () => { dead = true }
  }, [key, tick])
  return useMemo(() => Object.values(bySrc).flatMap(x => x ?? []), [bySrc])
}

/** 「3 分钟前 / 2 天前」——曲库状态里那个相对时间 */
function relTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

/** 邮箱太长塞不进按钮：只留 @ 前的部分，超过 10 个字省略 */
function shortMail(mail: string): string {
  const name = mail.split('@')[0] ?? mail
  const short = name.length > 10 ? name.slice(0, 10) + '…' : name
  return short || '已登录'
}
