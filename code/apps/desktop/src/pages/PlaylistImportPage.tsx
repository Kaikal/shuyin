/**
 * 导入歌单页：把别的音乐 APP 导出的歌单文件，匹配成本地曲库里的歌。
 *
 * 流程：读文件 → 解析（json/csv/txt/m3u/pls 自动嗅探）→ 与曲库匹配 → 一键入队播放。
 * 匹配不上的歌单独列出来，方便用户回原 APP 里补下载。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtTime, type LocalTrack } from '@shuyin/core'
import { usePlayer } from '../lib/PlayerProvider'
import { usePlaylists } from '../lib/localPlaylists'
import { bridge } from '../lib/bridge'
import { KEYS, settings } from '../lib/settings'
import {
  matchSongs, parsePlaylist,
  type MatchOutcome, type ParsedPlaylist,
} from '../lib/playlistImport'
import { isLxmcBuffer, parseLxmc, type LxPlaylist } from '../lib/lxmc'
import { toast } from '../lib/toast'
import { Cover } from '../components/Cover'
import { HelpTip } from '../components/HelpTip'
import { IconCheck, IconFile, IconFolder, IconPlay, IconPlus, IconUpload } from '../components/icons'

interface RecentImport {
  name: string
  at: number
  total: number
  matched: number
}

export function PlaylistImportPage({ onBack }: { onBack?(): void }) {
  const p = usePlayer()
  const pl = usePlaylists()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<{ name: string; path: string } | null>(null)
  const [parsed, setParsed] = useState<ParsedPlaylist | null>(null)
  const [outcome, setOutcome] = useState<MatchOutcome | null>(null)
  /** lxmc（洛雪）路线：每张歌单直接是可播的在线曲目，不走曲库匹配 */
  const [lxLists, setLxLists] = useState<LxPlaylist[] | null>(null)
  const [tab, setTab] = useState<'matched' | 'unmatched'>('matched')
  const [dragging, setDragging] = useState(false)
  const [recent, setRecent] = useState<RecentImport[]>([])
  const dropReady = useRef(false)
  /** 拖拽事件只在挂载时注册一次，通过 ref 拿到最新的解析函数（避免闭包里的旧曲库） */
  const loadRef = useRef<(path: string) => void>(() => {})

  useEffect(() => {
    void settings.get<RecentImport[]>(KEYS.recentImports).then(v => { if (v) setRecent(v) })
  }, [])

  /* 桌面端原生拖拽（WebView2 会拦截 HTML5 drop，只能走 Tauri 事件） */
  useEffect(() => {
    if (!bridge.isTauri || dropReady.current) return
    dropReady.current = true
    let un: (() => void) | undefined
    let disposed = false
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')
        const off = await getCurrentWebview().onDragDropEvent(e => {
          if (e.payload.type === 'enter' || e.payload.type === 'over') setDragging(true)
          else if (e.payload.type === 'leave') setDragging(false)
          else if (e.payload.type === 'drop') {
            setDragging(false)
            const first = e.payload.paths?.[0]
            if (first) void loadRef.current(first)
          }
        })
        if (disposed) off()
        else un = off
      } catch { /* 浏览器预览 */ }
    })()
    return () => { disposed = true; un?.() }
  }, [])

  const loadFile = useCallback(async (path: string) => {
    setBusy(true)
    setError(null)
    try {
      const name = path.replace(/^.*[\\/]/, '')

      /* 洛雪 .lxmc：gzip 容器，按文件头嗅探（扩展名只是参考）。
       * 里面的歌带平台直连 id，直接转在线曲目建歌单，不走模糊匹配。 */
      if (/\.lxmc$/i.test(name) || path.toLowerCase().endsWith('.lxmc')) {
        /* 桌面回数字数组（Vec<u8> 的 JSON 形态），安卓回 base64 文本——都归一成 Uint8Array */
        const raw = await bridge.invoke<number[] | string>('read_bin_abs', { path })
        const buf = typeof raw === 'string'
          ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
          : new Uint8Array(raw)
        if (isLxmcBuffer(buf)) {
          const lists = await parseLxmc(buf)
          if (lists.length) {
            setFile({ name, path })
            setParsed(null)
            setOutcome(null)
            setLxLists(lists)
            const total = lists.reduce((n, l) => n + l.tracks.length, 0)
            const item: RecentImport = { name, at: Date.now(), total, matched: total }
            setRecent(prev => {
              const next = [item, ...prev.filter(x => x.name !== name)].slice(0, 5)
              void settings.set(KEYS.recentImports, next)
              return next
            })
            return
          }
        }
        setFile({ name, path })
        setParsed(null)
        setOutcome(null)
        setLxLists(null)
        setError('这个 .lxmc 打不开（不是洛雪歌单导出的格式）')
        return
      }

      const text = await bridge.invoke<string>('read_text_abs', { path })
      const pr = parsePlaylist(text, name)
      setLxLists(null)
      if (!pr.songs.length) {
        setFile({ name, path })
        setParsed(pr)
        setOutcome(null)
        setError('没有从文件里识别出歌曲。可以试试带「歌名 - 歌手」的 txt、CSV 或 JSON。')
        return
      }
      const out = matchSongs(pr.songs, p.library)
      setFile({ name, path })
      setParsed(pr)
      setOutcome(out)
      setTab(out.matched.length ? 'matched' : 'unmatched')

      const item: RecentImport = { name, at: Date.now(), total: pr.songs.length, matched: out.matched.length }
      setRecent(prev => {
        const next = [item, ...prev.filter(x => x.name !== name)].slice(0, 5)
        void settings.set(KEYS.recentImports, next)
        return next
      })
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).slice(0, 200))
    } finally {
      setBusy(false)
    }
  }, [p.library])

  useEffect(() => { loadRef.current = path => void loadFile(path) }, [loadFile])

  const pick = async () => {
    const path = await bridge.invoke<string | null>('pick_playlist_file')
    if (path) await loadFile(path)
  }

  const matchedTracks: LocalTrack[] = outcome?.matched.map(m => m.track) ?? []

  /** lxmc：把某张（或全部）歌单一键存进「我的歌单」 */
  const saveLxList = (lx: LxPlaylist) => {
    pl.create(lx.name, { trackIds: lx.tracks.map(t => t.id), origin: 'import', originName: file?.name })
    toast(`已导入「${lx.name}」：${lx.tracks.length} 首（在线曲目，可直接播放）`, { ok: true })
  }

  const playLxList = (lx: LxPlaylist) => {
    if (!lx.tracks.length) return
    p.playList(lx.tracks, 0)
  }

  const appendAll = () => {
    if (!matchedTracks.length) return
    matchedTracks.forEach(t => p.addToQueue(t, 'end'))
  }

  const playAll = () => {
    if (!matchedTracks.length) return
    p.playList(matchedTracks, 0)
  }

  const copyUnmatched = () => {
    const text = (outcome?.unmatched ?? []).map(s => `${s.title}${s.artist ? ' - ' + s.artist : ''}`).join('\n')
    void navigator.clipboard?.writeText(text)
  }

  return (
    <div className="page pl-page">
      <header className="lib-head">
        <div className="lib-head-left">
          {/* 从歌单广场点进来时给一条退路：它现在挂在广场下面，不是侧栏的独立页 */}
          {onBack && (
            <button className="link-btn sq-back" onClick={onBack}>← 返回歌单广场</button>
          )}
          <h1>导入歌单</h1>
          <p className="lib-status">拖进文件，自动匹配本地曲库；缺的歌单独列出</p>
        </div>
        <div className="lib-actions">
          <HelpTip
            width={360}
            label="支持哪些格式、怎么导出"
            text={[
              '支持：JSON、TXT、CSV、M3U、M3U8、PLS，格式自动判断，不用改扩展名。',
              '',
              '怎么从别的 APP 导出：',
              '· 网易云音乐：歌单页「…」→ 分享，或用第三方工具导出 JSON；',
              '· QQ 音乐：歌单页「…」→ 导出歌单（txt / csv）；',
              '· 最省事：歌名一行一首，「歌名 - 歌手」存成 txt 拖进来。',
              '',
              '认这几种写法：',
              'TXT　夜航西飞 - 陈默',
              'CSV　歌名,歌手,专辑（第一行表头）',
              'JSON　[{"name":"歌名","ar":[{"name":"歌手"}]}]',
              'M3U　#EXTINF:246,歌手 - 歌名',
            ].join('\n')}
          />
        </div>
      </header>

      <div
        className="pl-drop"
        data-dragging={dragging}
        data-busy={busy}
        onClick={() => void pick()}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void pick() } }}
      >
        <span className="pl-drop-icon"><IconUpload width={22} height={22} /></span>
        <div className="pl-drop-main">
          <div className="t">{busy ? '正在解析…' : dragging ? '松手即可导入' : '把歌单文件拖进来，或点击选择'}</div>
          <div className="s">JSON / TXT / CSV / M3U / LXMC（洛雪）· 最大 16MB · txt 自动识别 UTF-8 与 GBK</div>
        </div>
        <div className="pl-formats">
          <span className="pill">JSON</span>
          <span className="pill">TXT</span>
          <span className="pill">CSV</span>
          <span className="pill">M3U</span>
          <span className="pill">LXMC</span>
        </div>
      </div>

      {p.library.length === 0 && !lxLists && (
        <div className="pl-warn">
          本地曲库还是空的，先到「本地音乐」扫描一次，导入的歌单才能真正匹配上。
        </div>
      )}

      {error && <div className="pl-warn danger">{error}</div>}

      {/* 洛雪 lxmc：每张歌单直接是可播的在线曲目（带平台 id），存进「我的歌单」即可 */}
      {lxLists && (
        <div className="pl-card">
          <div className="pl-card-head">
            <div className="pl-file">
              <IconFile width={15} height={15} />
              <span className="name" title={file?.path}>{file?.name}</span>
              <span className="pill">洛雪歌单</span>
            </div>
            <div className="pl-stat">
              <span className="ok num"><IconCheck width={12} height={12} /> {lxLists.reduce((n, l) => n + l.tracks.length, 0)} 首</span>
              <span className="all num">{lxLists.length} 张歌单</span>
            </div>
            <div className="pl-actions">
              <button className="ghost-btn" onClick={() => void pick()}>
                <IconFolder width={13} height={13} /> 换一个文件
              </button>
            </div>
          </div>
          <div className="pl-lx-list">
            {lxLists.map(lx => (
              <div key={lx.name} className="pl-lx-row">
                <div className="pl-lx-info">
                  <span className="name">{lx.name}</span>
                  <span className="num">{lx.tracks.length} 首 · 在线曲目</span>
                </div>
                <div className="pl-lx-acts">
                  <button className="primary-btn" onClick={() => playLxList(lx)} disabled={!lx.tracks.length}>
                    <IconPlay width={12} height={12} /> 播放
                  </button>
                  <button className="ghost-btn" onClick={() => saveLxList(lx)}>
                    <IconPlus width={13} height={13} /> 存为我的歌单
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="pl-lx-hint">
            洛雪歌单里的歌带平台编号，不用匹配本地曲库——存成歌单后直接点播，走在线取链。
          </p>
        </div>
      )}

      {parsed && (
        <div className="pl-card">
          <div className="pl-card-head">
            <div className="pl-file">
              <IconFile width={15} height={15} />
              <span className="name" title={file?.path}>{file?.name}</span>
              <span className="pill">{parsed.format.toUpperCase()}</span>
            </div>
            <div className="pl-stat">
              <span className="ok num"><IconCheck width={12} height={12} /> {outcome?.matched.length ?? 0}</span>
              <span className="miss num">{(outcome?.unmatched.length ?? parsed.songs.length)} 未匹配</span>
              <span className="all num">共 {parsed.songs.length} 首</span>
            </div>
            <div className="pl-actions">
              <button className="primary-btn" onClick={playAll} disabled={!matchedTracks.length}>
                <IconPlay width={12} height={12} /> 播放匹配的歌
              </button>
              <button className="ghost-btn" onClick={appendAll} disabled={!matchedTracks.length}>
                <IconPlus width={13} height={13} /> 加入播放列表
              </button>
              <button className="ghost-btn" onClick={() => void pick()}>
                <IconFolder width={13} height={13} /> 换一个文件
              </button>
            </div>
          </div>

          {parsed.notes.length > 0 && (
            <div className="pl-notes">{parsed.notes.join(' · ')}</div>
          )}

          <div className="pl-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'matched'} onClick={() => setTab('matched')}>
              已匹配 <span className="num">{outcome?.matched.length ?? 0}</span>
            </button>
            <button role="tab" aria-selected={tab === 'unmatched'} onClick={() => setTab('unmatched')}>
              未匹配 <span className="num">{outcome?.unmatched.length ?? 0}</span>
            </button>
            {tab === 'unmatched' && (outcome?.unmatched.length ?? 0) > 0 && (
              <button className="link-btn pl-copy" onClick={copyUnmatched}>复制未匹配清单</button>
            )}
          </div>

          <div className="pl-list">
            {tab === 'matched' && (outcome?.matched.length ?? 0) === 0 && (
              <div className="empty-state"><div className="title">没有匹配到本地歌曲</div>
                <div className="sub">确认曲库已经扫描过，或检查歌单里的歌名是否被改写过</div></div>
            )}
            {tab === 'matched' && outcome?.matched.map((m, i) => (
              <div className="pl-row" key={m.track.id}
                onClick={() => p.playList(matchedTracks, i)}>
                <span className="idx num">{String(i + 1).padStart(2, '0')}</span>
                <Cover track={m.track} size={36} radius={8} />
                <span className="meta">
                  <span className="name">{m.track.title}</span>
                  <span className="singer">{m.track.artist}</span>
                </span>
                <span className="from" title="歌单原文">{m.song.title}{m.song.artist ? ' · ' + m.song.artist : ''}</span>
                <span className={'score num' + (m.score >= 0.95 ? ' high' : '')}>
                  {m.score >= 0.999 ? '精确' : Math.round(m.score * 100) + '%'}
                </span>
                <span className="dur num">{fmtTime(m.track.duration)}</span>
              </div>
            ))}

            {tab === 'unmatched' && outcome?.unmatched.map((s, i) => (
              <div className="pl-row miss" key={s.title + s.artist + i}>
                <span className="idx num">{String(i + 1).padStart(2, '0')}</span>
                <span className="pl-blank" />
                <span className="meta">
                  <span className="name">{s.title}</span>
                  <span className="singer">{s.artist || '未知歌手'}{s.album ? ' · ' + s.album : ''}</span>
                </span>
                <span className="from">曲库里没有</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="pl-recent">
          <div className="pl-recent-head">最近导入</div>
          {recent.map(r => (
            <div className="pl-recent-row" key={r.name + r.at}>
              <IconFile width={13} height={13} />
              <span className="name">{r.name}</span>
              <span className="num">{r.matched} / {r.total}</span>
              <span className="num time">{new Date(r.at).toLocaleDateString('zh-CN')}</span>
            </div>
          ))}
        </div>
      )}

    </div>
  )
}
