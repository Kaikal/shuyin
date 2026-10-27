/**
 * 沉浸式播放页：整屏覆盖，背景取自当前封面（模糊 + 压暗 + 强调色光斑）。
 * 交互对齐主流播放器：点播放条封面进入，Esc / 收起按钮退出，歌词可点行跳转。
 *
 * 两种排布：
 *   默认   —— 左封面 + 右歌词（一眼看清「在放什么」）
 *   沉浸式歌词 —— 只留歌词，居中、逐字上色、上下淡出（参考 Folia）
 * 后者可用右上角按钮或 L 键随时切换，状态会被记住。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtTime } from '@shuyin/core'
import { bridge } from '../lib/bridge'
import { coverUrlOf } from '../lib/coverUrl'
import { useCoverBrightness } from '../lib/coverTone'
import { usePlayer } from '../lib/PlayerProvider'
import { useTheme } from '../lib/ThemeProvider'
import { Cover } from './Cover'
import { LyricsView } from './LyricsView'
import { FoliaLyrics } from './FoliaLyrics'
import { CoverRing } from './SpectrumLayer'
import { ProgressControl } from './Shell'
import { ChipMenu } from './ChipMenu'
import { Comments } from './Comments'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { SPECTRUM_STYLES, spectrumStyleName, useSpectrumStyle } from '../lib/spectrumStyle'
import { SPECTRUM_POSITIONS, spectrumPosName, useSpectrumPos } from '../lib/spectrumPos'
import { LYRICS_LOOKS, lyricsLookName, useLyricsLook } from '../lib/lyricsLook'
import { FX_PRESETS, fxSummary, setFxPreset, useAudioFx } from '../lib/audioFx'
import { coverInfo, qualityChoicesFor, qualityLabel } from '../lib/online'
import { dlLabel, toLrcText, useDownloads } from '../lib/DownloadsProvider'
import { useFoliaFx, useLyricsSolo, useVinylView } from '../lib/uiPrefs'
import { toggleFullscreen, useFullscreen } from '../lib/fullscreen'
import {
  IconAlignCenter, IconAlignLeft, IconAlignRight,
  IconCheck, IconChevronDown, IconDesktopLyric, IconDownload, IconFolder, IconFrame, IconFullscreen,
  IconFullscreenExit, IconInfo, IconLyric, IconMonitor, IconNext, IconPause, IconPlay,
  IconPrev, IconQueue, IconRefresh, IconRepeat, IconSequence, IconShuffle, IconSliders, IconSparkle,
  IconVolume, IconVolumeMute, IconWave,
} from './icons'
import { LYRIC_ALIGN_LIST, useLyricAlign } from '../lib/lyricAlign'

interface Props {
  open: boolean
  onClose(): void
  onOpenDetail(): void
  onOpenQueue(): void
  onToggleLyrics(): void
  /** 关掉播放页并跳到下载页（下载弹层里的「打开下载页面」） */
  onOpenDownloads(): void
  lyricsOn: boolean
  /** 音乐桌面（铺满屏幕的壁纸式音乐屏）：开着时按钮高亮，再点收起 */
  onToggleDesk(): void
  deskOn: boolean
}

export function ImmersivePlayer({ open, onClose, onOpenDetail, onOpenQueue, onToggleLyrics, onOpenDownloads, lyricsOn, onToggleDesk, deskOn }: Props) {
  const p = usePlayer()
  const { tokens } = useTheme()
  const t = p.current
  const repeat = p.queueState.repeat
  const RepeatIcon = repeat === 'one' ? IconRepeat : repeat === 'shuffle' ? IconShuffle : IconSequence
  const [muted, setMuted] = useState(false)
  const [specStyle, setSpecStyle] = useSpectrumStyle()
  const [specPos, setSpecPos] = useSpectrumPos()
  const [solo, setSolo] = useLyricsSolo()
  const [foliaFx, setFoliaFx] = useFoliaFx()
  const [vinyl, setVinyl] = useVinylView()
  const [look, setLook] = useLyricsLook()
  const fx = useAudioFx()
  const rootRef = useRef<HTMLDivElement>(null)
  /** 系统级全屏（F11 / 右上角按钮），跟「全屏歌词」是两件事 */
  const full = useFullscreen()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const toggleFull = toggleFullscreen

  /* ---------------- 下载 ----------------
   * 状态已经搬到 `DownloadsProvider`：任务跟着**曲目**走，不再是一个全局 busy 标志。
   * 以前切歌之后那颗图标照旧转圈（它根本不知道自己在下哪首），看着就像「没切成功」。
   * 现在只有「当前这首歌正在下」才转，其余情况该是正常的下载图标。
   */
  const dl = useDownloads()
  /** 当前曲目的音频任务（歌词任务单独一条，不参与这颗按钮的转圈）。
   *  同一首歌可以下多个音质，各是一条任务、各是一个文件 */
  const myDl = t ? dl.taskOf(t.id) : undefined
  const dlTasks = useMemo(
    () => (t ? dl.tasks.filter(x => x.trackId === t.id && x.kind === 'audio') : []),
    [dl.tasks, t],
  )
  const dlBusy = dlTasks.some(x => x.status === 'queued' || x.status === 'resolving' || x.status === 'downloading')
  /** 已经下完 / 正在下的音质：弹层里按档位打勾、挡住重复点击，别的档位照样能下 */
  const dlDoneQs = useMemo(
    () => new Set(dlTasks.filter(x => x.status === 'done').map(x => x.quality).filter(Boolean) as string[]),
    [dlTasks],
  )
  const dlBusyQs = useMemo(
    () => new Set(dlTasks.filter(x => x.status !== 'done' && x.status !== 'error').map(x => x.quality).filter(Boolean) as string[]),
    [dlTasks],
  )
  /** 档位列表：可用音质 + 已经下过/在下的（音源降档时，实际档位可能不在可用列表里） */
  const dlQualities = useMemo(() => {
    const base = qualityChoicesFor(p.onlineQualities)
    const extra = [...dlDoneQs, ...dlBusyQs].filter(q => !base.includes(q))
    return extra.length ? [...base, ...extra] : base
  }, [p.onlineQualities, dlDoneQs, dlBusyQs])
  /**
   * 完全没有歌词（本地大多是录音片段：没有 .lrc、也没有内嵌标签）。
   *
   * 只用来藏「歌词对齐」按钮组——没歌词可对齐。**布局不再随它变**：
   * 有没有歌词都是同一套两列，免得画面晃来晃去还误点（用户明确要求）。
   */
  const noLyric = !p.lyricsLoading && !p.lyrics?.lines.length
  /** 下载用的音质档位（独立于播放档位：想存无损但听流畅是常见诉求） */
  const [dlQuality, setDlQuality] = useState<string | null>(null)
  /** 右栏显示什么：歌词 / 评论。切歌回歌词——评论是「给这首歌看的」，不能留到下一首 */
  const [panel, setPanel] = useState<'lyric' | 'comments'>('lyric')
  useEffect(() => { setPanel('lyric') }, [t?.id])
  /** 歌词对齐（居左 / 居中 / 居右）：右栏是一整块很宽的区域，让用户自己决定贴哪边 */
  const [lyrAlign, setLyrAlign] = useLyricAlign()
  const [dlOpen, setDlOpen] = useState(false)
  const dlRoot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dlOpen) return
    const onDown = (e: PointerEvent) => {
      if (!dlRoot.current?.contains(e.target as Node)) setDlOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [dlOpen])

  const doDownload = (q?: string) => {
    if (!t || !p.online) return
    if (q) setDlQuality(q)
    dl.download(t, q ?? dlQuality ?? p.onlineQuality ?? undefined)
    /* 弹层**不要**关：点了音质就该马上开始下，用户得看得见进度条和最后的「已下载」。
       关掉的话只剩一颗图标在转，得再点一次才知道下完没有。 */
  }

  const doDownloadLyrics = () => {
    if (!t || !p.lyrics?.lines.length) return
    dl.downloadLyric(t, toLrcText(p.lyrics.lines))
  }

  /** 音效芯片上显示的名字：自定义就用用户起的名字 */
  const fxName = fx.preset === 'custom'
    ? fx.customName
    : (FX_PRESETS.find(x => x.id === fx.preset)?.name ?? '原声')

  /* 音效列表：预设 + 用户自己调的那套（有的话） */
  const fxOptions = [
    ...FX_PRESETS.map(f => ({ id: f.id, name: f.name, desc: f.desc })),
    ...(fx.preset === 'custom'
      ? [{ id: 'custom', name: fx.customName, desc: fxSummary(fx.values) }]
      : []),
  ]

  // 打开时把焦点收进页面，便于键盘操作；关闭后还回去
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => prev?.focus?.()
  }, [open])

  /* L 键切换「只留歌词」，鼠标党用右上角的按钮；F 键切 Folia 动效 */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        setSolo(!solo)
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        const next = !foliaFx
        setFoliaFx(next)
        if (next) setSolo(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, solo, setSolo, foliaFx, setFoliaFx])

  /** 开 Folia 动效就顺手进全屏歌词——那个效果在右侧窄栏里看不出味道 */
  const toggleFolia = () => {
    const next = !foliaFx
    setFoliaFx(next)
    if (next) setSolo(true)
  }

  /**
   * 点歌词 = 「从这里开始听」。
   * 暂停时只 seek 不播会让人以为点击没反应（声音没变），所以跳转后顺手续播。
   * 进度条拖拽不走这里——那里的语义是「看/定位」，保持原有暂停态。
   */
  const seekToLine = (sec: number) => {
    p.seek(sec)
    if (!p.snapshot.playing) p.togglePlay()
  }

  const bgUrl = coverUrlOf(t?.cover)
  const bgBright = useCoverBrightness(bgUrl)
  const vol = muted ? 0 : p.snapshot.volume
  const bitrate = t?.bitrate ? `${t.bitrate} kbps` : null

  /*
   * 「这一秒在响的，到底是谁的歌」。
   *
   * 两处不诚实要在这里解决：
   *   1. 跨平台兜底后，真正在放的可能**不是**原曲目的歌手（B 平台只有翻唱）。
   *      继续显示原歌手，就成了「歌手和实际播放的音频不是同一个人」。
   *      → 歌手字段一律显示 `onlineActual.singer`（真正在唱的人）。
   *   2. 平台自己的标题常常写「晴天 (原唱 周杰伦)」而歌手是别人——名字读起来像
   *      原唱那一版，其实放的是翻唱。标题改不了，但可以标一个「翻唱」。
   *      → `coverInfo` 判断「标题点了原唱、歌手却不是他」。
   */
  const actual = p.online ? p.onlineActual : null
  const shownArtist = actual?.singer || t?.artist || ''
  const shownTitle = actual?.name || t?.title || ''
  const cov = t && p.online ? coverInfo(t.title, shownArtist) : null

  /**
   * 播放页的按钮分两层（用户明确反馈过「别全挤在播放按钮周围」）：
   *
   *   menus —— 需要二次选择的下拉芯片（音质 / 音效 / 频谱 / 位置 / 歌词观感），
   *            放回**顶部右上角**：它们是「设置」，不是「控制」，靠上看合理；
   *   quick —— 点一下就生效的开关（Folia / 全屏歌词 / 桌面歌词 / 播放列表），
   *            留在**播放按钮下方**：手就停在控制区，切换不用满屏找。
   */
  const menus = (
    <>
      {p.online && (
        <ChipMenu
          label="音质"
          value={p.onlineQuality ? qualityLabel(p.onlineQuality) : (p.onlineBusy ? '取链中' : '—')}
          activeId={p.onlineQuality ?? undefined}
          disabled={p.onlineBusy}
          title="音质：只列这首歌真实有的档位。某一档取不到时会自动降到下一档，不用你再点一次"
          /* 只列这首歌真有的档位：平台没有的真无损，列出来也是点不动的摆设。
             正在播的那一档如果不在列表里（自动降档 / 换了平台），补一条进去——
             否则下拉里没有任何一项带勾，看着像「音质未知」。 */
          options={[
            ...(p.onlineQuality && !p.onlineQualities.includes(p.onlineQuality)
              ? [{ id: p.onlineQuality, name: qualityLabel(p.onlineQuality), note: p.onlineQuality }]
              : []),
            ...qualityChoicesFor(p.onlineQualities).map(q => ({
              id: q,
              name: qualityLabel(q),
              note: q,
            })),
          ]}
          onPick={q => p.changeQuality(q)}        />
      )}
      <ChipMenu
        icon={<IconSliders width={13} height={13} />}
        label="音效"
        value={fxName}
        activeId={fx.preset}
        title="音效：三段均衡 + 前置增益，改完立刻生效"
        options={fxOptions}
        onPick={id => { if (id !== 'custom') setFxPreset(id) }}
        width={230}      />
      <ChipMenu
        icon={<IconWave width={13} height={13} />}
        label="频谱"
        value={spectrumStyleName(specStyle)}
        activeId={specStyle}
        options={SPECTRUM_STYLES.map(s => ({ id: s.id, name: s.name, desc: s.desc }))}
        onPick={setSpecStyle}
        width={230}      />
      <ChipMenu
        icon={<IconFrame width={13} height={13} />}
        label="位置"
        value={spectrumPosName(specPos)}
        activeId={specPos}
        title="频谱摆在哪儿"
        options={SPECTRUM_POSITIONS.map(x => ({ id: x.id, name: x.name, desc: x.desc }))}
        onPick={setSpecPos}
        width={256}      />
      {foliaFx && (
        <ChipMenu
          icon={<IconLyric width={13} height={13} />}
          label="歌词"
          value={lyricsLookName(look)}
          activeId={look}
          options={LYRICS_LOOKS.map(l => ({ id: l.id, name: l.name, desc: l.desc }))}
          onPick={setLook}
          width={230}        />
      )}
      <ChipMenu
        label="视图"
        value={vinyl ? '唱片' : '封面'}
        activeId={vinyl ? 'vinyl' : 'cover'}
        title="播放页封面样式"
        options={[
          { id: 'vinyl', name: '黑胶唱片', desc: '圆盘 + 唱臂，播放时转动' },
          { id: 'cover', name: '方形封面', desc: '更紧凑' },
        ]}
        onPick={id => setVinyl(id === 'vinyl')}
        width={214}
      />
    </>
  )

  /* 下载：一颗图标，放在播放控制那一行（循环 / 上一首 / 播放 / 下一首 / 下载 / 音量）。
     ·
     · 为什么不用胶囊 `.imm-tool`：那一排已经有 4 个（Folia / 全屏歌词 / 桌面歌词 / 列表），
     · 封面列的宽度只有 320，加第 5 个必然换行——实测它会单独占一整行、还撑满列宽，
     · 观感像是「多出来一块」。播放控制这一行的按钮本来就是纯图标，没有底板没有圆圈，
     · 正好符合「和其他按钮保持样式统一」。
     ·
     · 本地曲目直接 disabled：它已经在磁盘上，亮着只会骗用户点一次。
     */
  const dlMenu = (
    <span className="imm-dl-wrap chip-menu up" ref={dlRoot}>
      <button
        className={'icon-btn imm-dl' + (dlBusy ? ' busy' : '')}
        aria-label={p.online ? (dlDoneQs.size ? '已下载' : '下载') : '本地歌曲，不需要下载'}
        aria-haspopup="menu"
        aria-expanded={dlOpen}
        disabled={!p.online}
        title={
          !p.online
            ? '本地歌曲已经在磁盘上，不需要下载'
            : dlDoneQs.size
              ? `已下载 ${dlDoneQs.size} 个音质 · 点开可以再下一个或看进度`
              : '下载歌曲（可选音质）'
        }
        onClick={() => setDlOpen(o => !o)}
      >
        {dlBusy ? <span className="spin-ring sm" aria-hidden="true" />
          : dlDoneQs.size ? (
            /* 已下载：**保留下载图标**，右下角叠一个小勾。
               只画一个勾的话，这一排图标里它就变成了「另一个功能」——
               用户找不到「下载」在哪了（他反馈过这一点）。 */
            <span className="imm-dl-done" aria-hidden="true">
              <IconDownload width={17} height={17} />
              <IconCheck className="imm-dl-tick" width={9} height={9} />
            </span>
          )
          : <IconDownload width={17} height={17} />}
      </button>
      {dlOpen && (
        <div className="chip-pop dl-pop" role="menu" aria-label="下载" style={{ minWidth: 240 }}>
          {/* 标题下面不再写「选一个音质，立即开始」——点一下就下了，这句话纯属噪音 */}
          <div className="dl-pop-title">下载歌曲</div>
          {dlQualities.map(q => {
            const rowDone = dlDoneQs.has(q)
            const rowBusy = dlBusyQs.has(q)
            return (
              <button
                key={q}
                className={'chip-opt' + (rowDone ? ' on done' : rowBusy ? ' on' : '')}
                disabled={rowDone || rowBusy}
                title={rowDone ? `已下载 ${qualityLabel(q)}` : rowBusy ? '这一档正在下载' : `下载 ${qualityLabel(q)}`}
                onClick={() => doDownload(q)}
              >
                <span className="co-main"><span className="co-name">{qualityLabel(q)}</span></span>
                {/* 只有**真正下过的那一档**才标「已下载」：下 320k 不该把无损也打上勾，
                    否则用户想再下一个音质时，所有档位都灰着，路被堵死 */}
                <span className={'co-note' + (rowDone ? ' done' : '')}>
                  {rowDone ? '已下载' : q}
                </span>
                {rowDone && <IconCheck width={12} height={12} />}
              </button>
            )
          })}
          <div className="ctx-divider" />
          <button
            className="chip-opt"
            disabled={!p.lyrics?.lines.length}
            title={p.lyrics?.lines.length ? '保存为 .lrc（与音频同目录）' : '当前没有可用歌词'}
            onClick={doDownloadLyrics}
          >
            <span className="co-main"><span className="co-name">歌词 .lrc</span></span>
          </button>
          {myDl && (
            <div className={'dl-status' + (myDl.error ? ' bad' : '')}>
              {myDl.error ? (
                <>
                  <span className="dl-status-text">{myDl.error}</span>
                  <button className="link-btn" onClick={() => dl.retry(myDl.id)}>重试</button>
                </>
              ) : (
                <>
                  <span className="dl-status-text">{dlLabel(myDl)}</span>
                  {myDl.status === 'downloading' && myDl.total > 0 && (
                    <span className="side-dl-bar">
                      <i style={{ width: `${Math.min(100, (myDl.done / myDl.total) * 100)}%` }} />
                    </span>
                  )}
                  {myDl.status === 'done' && myDl.path && (
                    <button className="link-btn" onClick={() => void bridge.revealInFolder(myDl.path)}>在文件夹中显示</button>
                  )}
                </>
              )}
            </div>
          )}
          <div className="dl-pop-foot">
            <button className="link-btn" onClick={() => { setDlOpen(false); onOpenDownloads() }}>打开下载页面</button>
          </div>
        </div>
      )}
    </span>
  )

  /** 播放按钮下面那一排：点一下即生效的开关（Folia / 全屏歌词 / 桌面歌词 / 列表）。
   *  文字包在 `.it-lbl` 里：窄窗（列宽只有 264）时 CSS 会把它藏起来只留图标，
   *  否则 4 颗芯片必然换行，第二行孤零零一颗特别难看。 */
  const quick = (
    <div className="imm-tools" role="toolbar" aria-label="播放控制">
      <button className="imm-tool" onClick={toggleFolia} aria-pressed={foliaFx}
        title={foliaFx ? 'Folia 歌词动效：开（F 切换）' : 'Folia 歌词动效：关（F 切换）'}>
        <IconSparkle width={13} height={13} /> <span className="it-lbl">Folia</span>
      </button>
      <button className="imm-tool" onClick={() => setSolo(!solo)} aria-pressed={solo}
        title={solo ? '回到播放页 (L)' : '只留歌词，全屏显示 (L)'}>
        <IconLyric width={13} height={13} /> <span className="it-lbl">全屏歌词</span>
      </button>
      <button className="imm-tool" onClick={onToggleLyrics} aria-pressed={lyricsOn} title="桌面歌词">
        <IconDesktopLyric width={13} height={13} /> <span className="it-lbl">桌面歌词</span>
      </button>
      <button className="imm-tool" data-panel-toggle onClick={onOpenQueue} title="播放列表 (Q)">
        <IconQueue width={13} height={13} /> <span className="it-lbl">列表</span>
      </button>
    </div>
  )

  /**
   * 播放页右键菜单。
   * 以前这里什么都不弹：主窗口全局把系统菜单（刷新/另存为）关掉了，
   * 而播放页自己没有兜一个自定义菜单，右键就等于没反应。
   */
  const immMenu: MenuItem[] = t ? [
    { id: 'detail', label: '歌曲详情', icon: <IconInfo width={13} height={13} />, onSelect: onOpenDetail },
    { id: 'queue', label: '播放列表', icon: <IconQueue width={13} height={13} />, onSelect: onOpenQueue },
    {
      id: 'lyrics', label: lyricsOn ? '关闭桌面歌词' : '打开桌面歌词',
      icon: <IconDesktopLyric width={13} height={13} />, onSelect: onToggleLyrics,
    },
    {
      id: 'full', label: full ? '退出全屏' : '全屏',
      icon: <IconFullscreen width={13} height={13} />, onSelect: () => void toggleFull(),
    },
    ...(p.online ? [
      {
        id: 'dl',
        label: `下载歌曲${p.onlineQuality ? `（${qualityLabel(p.onlineQuality)}）` : ''}`,
        icon: <IconDownload width={13} height={13} />,
        onSelect: () => void doDownload(p.onlineQuality ?? undefined),
      },
      {
        id: 'lrc', label: '下载歌词 .lrc',
        icon: <IconLyric width={13} height={13} />,
        disabled: !p.lyrics?.lines.length,
        onSelect: () => void doDownloadLyrics(),
      },
    ] : [
      {
        id: 'reveal', label: '在文件夹中显示',
        icon: <IconFolder width={13} height={13} />,
        onSelect: () => void bridge.revealInFolder(t.path),
      },
    ]),
  ] : []

  return (
    <div
      ref={rootRef}
      className="imm themed"
      data-open={open}
      data-solo={solo}
      data-cover={bgUrl ? 'true' : 'false'}
      aria-hidden={!open}
      role="dialog"
      aria-modal={open}
      aria-label="正在播放"
      tabIndex={-1}
      onContextMenu={e => {
        if (!t) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div
        className="imm-bg"
        style={bgUrl
          ? { backgroundImage: `url("${bgUrl}")`, ['--imm-bright' as never]: bgBright }
          : undefined}
        data-glass-degraded={tokens.glassBlur === 0}
      />
      <div className="imm-scrim" />
      <div className="imm-beam" aria-hidden="true" />
      <div className="imm-flare" />
      {/* 有封面时再垫一层「专辑色」的柔光，让模糊底不像一块灰板 */}
      {bgUrl && <div className="imm-tint" aria-hidden="true" />}

      <div className="imm-shell" data-solo={solo} data-tauri-drag-region>
        {/* data-tauri-drag-region：播放页整屏盖住了标题栏，用户没法拖窗口换位置。
            顶部这一条和四周留白都标成拖动区——点在按钮上不生效（按钮是更深的 target），
            空白处按住就能拖，双击空白处会走系统的最小化/最大化行为。 */}
        <header className="imm-top" data-tauri-drag-region>
          <div className="imm-top-l" data-tauri-drag-region>
            <span className="imm-mark">疏音</span>
            <span className="imm-sep" aria-hidden="true" />
            <span className="imm-kicker">{solo ? '歌词' : '正在播放'}</span>
            {p.queueState.queue.length > 0 && (
              <span className="imm-pos num">
                {p.queueState.index + 1} / {p.queueState.queue.length}
              </span>
            )}
          </div>
          <div className="imm-top-r">
            {/* 下拉设置芯片：音质 / 音效 / 频谱 / 位置（+Folia 的歌词观感）。
                点一下就生效的开关在下面的播放按钮旁，别把两类混在一起。 */}
            <div className="imm-top-menus">{menus}</div>
            {/* 音乐桌面 / 全屏：两个都是桌面窗口层面的事。
                安卓上 musicDesk 是空实现、全屏按钮只是把系统栏再藏一次（=没有全屏），
                留着就是「点了没反应」——直接不渲染。 */}
            {bridge.isTauri && (
              <>
                {/* 音乐桌面：铺满屏幕的壁纸式音乐屏。放在全屏按钮左边——
                    两者都是「换一种看法」，但一个是把应用放大，一个是把它退到桌面背景。 */}
                <button
                  className="icon-btn imm-icobtn"
                  aria-label={deskOn ? '收起音乐桌面' : '打开音乐桌面'}
                  aria-pressed={deskOn}
                  title={deskOn ? '收起音乐桌面' : '音乐桌面（铺满屏幕，可置底当壁纸）'}
                  onClick={onToggleDesk}
                >
                  <IconMonitor width={15} height={15} />
                </button>
                <button
                  className="icon-btn imm-icobtn"
                  aria-label={full ? '退出全屏' : '全屏'}
                  aria-pressed={full}
                  title={full ? '退出全屏 (F11)' : '全屏 (F11)'}
                  onClick={() => void toggleFull()}
                >
                  {full
                    ? <IconFullscreenExit width={15} height={15} />
                    : <IconFullscreen width={15} height={15} />}
                </button>
              </>
            )}
            <button className="icon-btn imm-close" aria-label="收起播放页" title="收起 (Esc)" onClick={onClose}>
              <IconChevronDown width={18} height={18} />
            </button>
          </div>
        </header>

        {!t && (
          <div className="empty-state" style={{ height: '100%' }}>
            <div className="title">还没有正在播放的歌曲</div>
            <div className="sub">从本地音乐里选一首开始</div>
          </div>
        )}

        {t && solo && (
          <div className="imm-solo" data-tauri-drag-region>
            <div className="imm-solo-lyrics">
              {/* Folia 动效开启时是「逐字弹出」的文字 PV；关闭时退回可滚动的普通歌词 */}
              {foliaFx ? (
                <FoliaLyrics
                  doc={p.lyrics}
                  loading={p.lyricsLoading}
                  currentTime={p.snapshot.position}
                  progress={p.snapshot.duration > 0 ? p.snapshot.position / p.snapshot.duration : 0}
                  onSeek={seekToLine}
                  onSearchOnline={q => p.reloadLyrics(true, q)}
                  trackTitle={t.title || ''}
                  trackArtist={t.artist || ''}
                />
              ) : (
                <LyricsView
                  doc={p.lyrics}
                  loading={p.lyricsLoading}
                  currentTime={p.snapshot.position}
                  onSeek={seekToLine}
                  onSearchOnline={q => p.reloadLyrics(true, q)}
                  trackTitle={t.title || ''}
                  trackArtist={t.artist || ''}
                  immersive
                />
              )}
            </div>

            <div className="imm-solo-foot">
              <div className="imm-solo-meta">
                <span className="n">{t.title}</span>
                <span className="dot" aria-hidden="true">·</span>
                <span className="a">{t.artist || '未知歌手'}</span>
              </div>
              <ProgressControl />
              <div className="imm-solo-ctl">
                <button className="icon-btn" aria-label="上一首" onClick={p.prev}>
                  <IconPrev width={20} height={20} />
                </button>
                <button className="play-primary imm-play" aria-label={p.loading ? '正在加载' : p.snapshot.playing ? '暂停' : '播放'}
                  aria-busy={p.loading} onClick={p.togglePlay}>
                  {p.loading
                    ? <span className="spin-ring" aria-hidden="true" />
                    : p.snapshot.playing ? <IconPause width={22} height={22} /> : <IconPlay width={22} height={22} />}
                </button>
                <button className="icon-btn" aria-label="下一首" onClick={p.next}>
                  <IconNext width={20} height={20} />
                </button>
              </div>
              {quick}
            </div>
          </div>
        )}

        {t && !solo && (
          <div
            className="imm-grid"
            data-view={vinyl ? 'vinyl' : 'cover'}
            /* 永远是两列：有没有歌词、在看哪一页，布局都不动——
               曾经没歌词会并成单列居中，用户反馈「晃来晃去的容易误点」 */
            data-tauri-drag-region
          >
            <section
              className="imm-art"
              data-tauri-drag-region
              /*
               * 手机上「视图」那颗芯片是藏起来的（顶栏只留返回和菜单，放不下），
               * 但切换唱片 / 封面的能力不能跟着消失——点封面本体来切换，
               * 和网易云、酷狗「点封面展开」是同一个手势，不用多认一个按钮。
               */
              onClick={() => {
                const shell = document.documentElement.dataset.shell
                if (shell === 'phone' || shell === 'tablet') setVinyl(!vinyl)
              }}
            >
              {vinyl ? (
                /* 黑胶：整块圆盘 + 唱臂。转动的是内层 `.imm-disc-spin`（含纹路与标签），
                   暂停时 animation-play-state: paused——不停在别的角度，看着才像「唱片停住了」 */
                <div className="imm-disc" data-playing={p.snapshot.playing && open ? 'true' : 'false'}>
                  <div className="imm-disc-spin">
                    <div className="imm-disc-grooves" aria-hidden="true" />
                    <div className="imm-disc-label">
                      <Cover track={t} size={220} radius={999} fill />
                    </div>
                  </div>
                  <span className="imm-disc-hole" aria-hidden="true" />
                  <span className="imm-disc-gloss" aria-hidden="true" />
                  {/* 唱臂：暂停时抬到唱片外面（唱臂架），播放时压到外圈纹路上 */}
                  <svg className="imm-arm" viewBox="0 0 160 132" fill="none" aria-hidden="true">
                    <circle cx="30" cy="24" r="13" fill="#d7dae3" />
                    <circle cx="30" cy="24" r="5" fill="#8f95a5" />
                    <path d="M36 32 L104 100" stroke="#e6e8ef" strokeWidth="4" strokeLinecap="round" />
                    <path d="M98 94 L118 112" stroke="#cfd3dd" strokeWidth="9" strokeLinecap="round" />
                    <path d="M118 112 L124 118" stroke="#9aa1b1" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                </div>
              ) : (
                <div className="imm-cover" data-playing={p.snapshot.playing} data-ring={specPos === 'cover' ? 'true' : 'false'}>
                  <Cover track={t} size={300} radius={18} />
                  {/* pad 必须和 styles/immersive.css 里 .cover-ring 的 --ring-pad 一致，
                      否则柱子按更长的尺寸算，超出画布被裁成平头 */}
                  {specPos === 'cover' && <CoverRing playing={p.snapshot.playing && open} pad={100} variant={specStyle} />}
                </div>
              )}

              {/* 唱片模式把标题/专辑搬到右栏顶部（像一张唱片摆在那儿，右边是它的信息）；
                  封面模式没有右栏头部，标题才留在左列 */}
              {!vinyl && (
                <>
                  <h1 className="imm-title" title={t.title}>{t.title}</h1>
                  <p className="imm-artist">
                    {shownArtist || '未知歌手'}
                    {cov && <i className="imm-badge cov imm-cov" title={`这是翻唱版 · 原唱：${cov.original}`}>翻唱</i>}
                  </p>
                  <p className="imm-album">
                    {[t.album, t.year ? String(t.year) : null, t.format?.toUpperCase(), bitrate].filter(Boolean).join(' · ')}
                  </p>
                </>
              )}

              <div className="imm-progress">
                <ProgressControl tall />
              </div>

              {/*
                * 三格网格：左（循环+上一首）/ 中间（播放键）/ 右（下一首+下载+音量）。
                * 以前是一排 flex，左边两颗、右边四颗，播放键实际偏左 60 多 px，
                * 跟上面的封面中线对不上，整排看着是歪的。1fr auto 1fr 把播放键
                * 钉死在列中线上，两侧各自靠向自己那一侧。
                */}
              <div className="imm-ctl">
                <div className="imm-ctl-l">
                  <button className="icon-btn" aria-label="循环模式" onClick={p.cycleMode}
                    title={repeat === 'sequence' ? '顺序播放' : repeat === 'one' ? '单曲循环' : '随机播放'}>
                    <RepeatIcon width={18} height={18}
                      style={{ color: repeat !== 'sequence' ? 'var(--sy-accent-soft)' : undefined }} />
                  </button>
                  <button className="icon-btn imm-step" aria-label="上一首" onClick={p.prev}>
                    <IconPrev width={22} height={22} />
                  </button>
                </div>
                <button className="play-primary imm-play" aria-label={p.loading ? '正在加载' : p.snapshot.playing ? '暂停' : '播放'}
                  aria-busy={p.loading} onClick={p.togglePlay}>
                  {p.loading
                    ? <span className="spin-ring" aria-hidden="true" />
                    : p.snapshot.playing ? <IconPause width={22} height={22} /> : <IconPlay width={22} height={22} />}
                </button>
                <div className="imm-ctl-r">
                  <button className="icon-btn imm-step" aria-label="下一首" onClick={p.next}>
                    <IconNext width={22} height={22} />
                  </button>
                  {dlMenu}
                  <span className="imm-vol">
                    <button className="icon-btn" aria-label="静音" onClick={() => setMuted(m => !m)}>
                      {vol === 0 ? <IconVolumeMute width={17} height={17} /> : <IconVolume width={17} height={17} />}
                    </button>
                    <input
                      className="slider" type="range" min={0} max={1} step={0.01} value={vol}
                      aria-label="音量"
                      onChange={e => { setMuted(false); p.setVolume(Number(e.target.value)) }}
                    />
                  </span>
                </div>
              </div>

              {quick}

              <div className="imm-meta-line">
                <button className="link-btn" data-panel-toggle onClick={onOpenDetail}>
                  <IconInfo width={13} height={13} /> 歌曲详情
                </button>
                <span className="imm-dur num">{fmtTime(p.snapshot.position)} / {fmtTime(p.snapshot.duration || t.duration)}</span>
              </div>
            </section>

            {/* 右栏永远在场：歌词 / 评论 / 「暂无歌词」占的都是同一块地方，
                布局不随有没有歌词变化（用户：不要晃来晃去、容易误点）。
                「暂无歌词 + 在线搜索歌词」由 LyricsView / FoliaLyrics 的空态渲染，
                位置和看歌词时完全一致。 */}
            <section className="imm-lyric" data-tauri-drag-region>
                {/* 唱片模式的右栏顶部：标题 + 专辑/歌手/来源 + 标签行。
                    照「一张唱片 + 它的说明」排，歌词从下面接着往下走。 */}
                {vinyl && (
                  <header className="imm-head">
                    <h1 className="imm-head-title" title={t.title}>
                      <span className="imm-head-name">{t.title}</span>
                      <span className="imm-badges">
                        {cov && <i className="imm-badge cov" title={`这是翻唱版 · 原唱：${cov.original}`}>翻唱</i>}
                        {p.online && (
                          <i className="imm-badge">{p.onlineQuality ? qualityLabel(p.onlineQuality) : '在线'}</i>
                        )}
                        {bitrate && <i className="imm-badge">{bitrate.replace(/\s*kbps/i, '')}</i>}
                        {!p.online && t.format && <i className="imm-badge">{t.format.toUpperCase()}</i>}
                      </span>
                    </h1>
                    <p className="imm-head-meta">
                      <span>专辑：{t.album || '—'}</span>
                      <span title={actual ? `原曲目歌手：${t.artist || '未知'}（这一条来自兜底平台）` : undefined}>
                        歌手：{shownArtist || '未知歌手'}
                      </span>
                      {/* 兜底到的版本连歌名都不一样时也要说清楚，不然「名字」这一栏还是假的 */}
                      {actual && shownTitle && shownTitle !== t.title && (
                        <span>实际曲目：{shownTitle}</span>
                      )}
                      <span>
                        来源：
                        {p.online
                          ? [p.onlineVia, p.onlineSource].filter(Boolean).join(' · ') || '在线'
                          : '本地'}
                      </span>
                    </p>
                    <div className="imm-tagrow">
                      <button className={'imm-tag' + (panel === 'lyric' ? ' on' : '')}
                        onClick={() => setPanel('lyric')}>歌词</button>
                      <button className={'imm-tag' + (panel === 'comments' ? ' on' : '')}
                        onClick={() => setPanel('comments')}>评论</button>
                      <button className="imm-tag" onClick={onOpenDetail}>歌曲详情</button>
                      <button className="imm-tag" onClick={onOpenQueue}>播放列表</button>
                    </div>
                  </header>
                )}
                {/* 标签行原本只挂在唱片模式的头部里。关掉唱片视图后右栏就没有
                    「歌词 / 评论」的入口了，评论功能等于消失——非唱片模式补一行。 */}
                {!vinyl && (
                  <div className="imm-tagrow imm-tabrow-solo">
                    <button className={'imm-tag' + (panel === 'lyric' ? ' on' : '')}
                      onClick={() => setPanel('lyric')}>歌词</button>
                    <button className={'imm-tag' + (panel === 'comments' ? ' on' : '')}
                      onClick={() => setPanel('comments')}>评论</button>
                  </div>
                )}
                {/* Folia 是「歌词渲染方式」，不是「沉浸式专属」：只要开了动效，
                    右侧这栏也要用它，否则会出现「Folia 开着却完全没效果」的错觉 */}
                <div className="imm-lyric-body">
                  {panel === 'comments' ? (
                    <Comments track={t} />
                  ) : foliaFx ? (
                    <FoliaLyrics
                      doc={p.lyrics}
                      loading={p.lyricsLoading}
                      currentTime={p.snapshot.position}
                      progress={p.snapshot.duration > 0 ? p.snapshot.position / p.snapshot.duration : 0}
                      onSeek={seekToLine}
                      onSearchOnline={q => p.reloadLyrics(true, q)}
                      trackTitle={t.title || ''}
                      trackArtist={t.artist || ''}
                    />
                  ) : (
                    <LyricsView
                      doc={p.lyrics}
                      loading={p.lyricsLoading}
                      currentTime={p.snapshot.position}
                      onSeek={seekToLine}
                      onSearchOnline={q => p.reloadLyrics(true, q)}
                      trackTitle={t.title || ''}
                      trackArtist={t.artist || ''}
                      /* 右栏这块很宽：按用户选的对齐方式贴边，
                         长句不缩字号、唱到那句时横向滚动 */
                      align={lyrAlign}
                      scrollOverflow
                    />
                  )}
                </div>
                {/* 歌词对齐：三个图标（居左 / 居中 / 居右），摆在歌词区右下角 */}
                {panel === 'lyric' && !noLyric && !foliaFx && (
                  <div className="imm-lyrbar">
                    <div className="imm-align" role="group" aria-label="歌词对齐">
                      {LYRIC_ALIGN_LIST.map(a => (
                        <button
                          key={a.id}
                          type="button"
                          className={'imm-align-btn' + (lyrAlign === a.id ? ' on' : '')}
                          aria-pressed={lyrAlign === a.id}
                          aria-label={a.name + '对齐'}
                          title={'歌词' + a.name}
                          onClick={() => setLyrAlign(a.id)}
                        >
                          {a.id === 'left' ? <IconAlignLeft width={15} height={15} />
                            : a.id === 'center' ? <IconAlignCenter width={15} height={15} />
                              : <IconAlignRight width={15} height={15} />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>

          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={immMenu} onClose={() => setMenu(null)} />}
    </div>
  )
}
