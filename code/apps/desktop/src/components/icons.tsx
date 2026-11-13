/** 线性图标集：1.5px 描边、圆头端点；播放/暂停等高频图标用实心（与设计规范一致） */
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

const wrap = (children: React.ReactNode, viewBox: string, filled = false) =>
  function Icon(props: P) {
    return (
      <svg width="18" height="18" viewBox={viewBox} fill="none" aria-hidden="true" {...props}
        stroke={filled ? 'none' : 'currentColor'} strokeWidth={filled ? 0 : 1.5}
        strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    )
  }

export const IconPrev = wrap(<><path d="M14 4.2v9.6L6.4 9 14 4.2Z" fill="currentColor" stroke="none" /><rect x="3.4" y="4.2" width="1.8" height="9.6" rx=".9" fill="currentColor" stroke="none" /></>, '0 0 18 18')
export const IconNext = wrap(<><path d="M4 4.2v9.6L11.6 9 4 4.2Z" fill="currentColor" stroke="none" /><rect x="12.8" y="4.2" width="1.8" height="9.6" rx=".9" fill="currentColor" stroke="none" /></>, '0 0 18 18')
export const IconPlay = wrap(<path d="M5.2 2.4 15 9 5.2 15.6V2.4Z" fill="currentColor" stroke="none" />, '0 0 18 18')
export const IconPause = wrap(<><rect x="4" y="3" width="3.6" height="12" rx="1.2" fill="currentColor" stroke="none" /><rect x="10.4" y="3" width="3.6" height="12" rx="1.2" fill="currentColor" stroke="none" /></>, '0 0 18 18')
export const IconShuffle = wrap(<><path d="M2.6 4.8h2.3l6.3 6.5h2.2M2.6 11.3h2.3l6.3-6.5h2.2" /><path d="M12.2 2.9l1.9 1.9-1.9 1.9M12.2 9.4l1.9 1.9-1.9 1.9" /></>, '0 0 16 16')
/*
 * 单曲循环：箭头中间那个 "1" 用 **path 画**，不用 `<text>`。
 * `<text fontSize="5.4">` 在 18px 的图标里只剩 3px 高，屏幕上一团墨点，
 * 看着既不像 1 也不像循环（用户原话「单曲播放的图标看起来好丑」）。
 * 两笔 path 的粗细和箭头一致，缩到 16px 依然清楚。
 */
export const IconRepeat = wrap(<><path d="M3 6.4A4 4 0 0 1 7 2.6h4.2M13 9.6a4 4 0 0 1-4 3.8H4.8" /><path d="M9.6 1.2 11.4 2.9 9.6 4.6M6.4 11.4 4.6 13.1l1.8 1.7" /><path d="M6.6 6.2 8.5 5v5.4" /></>, '0 0 16 16')
export const IconRepeatAll = wrap(<><path d="M3 6.4A4 4 0 0 1 7 2.6h4.2M13 9.6a4 4 0 0 1-4 3.8H4.8" /><path d="M9.6 1.2 11.4 2.9 9.6 4.6M6.4 11.4 4.6 13.1l1.8 1.7" /></>, '0 0 16 16')
export const IconSequence = wrap(<><path d="M3 4.5h10M3 8.5h7M3 12.5h4" /><path d="M13.5 11v4M13.5 15l-1.8-1.8M13.5 15l1.8-1.8" transform="translate(0,-2)" /></>, '0 0 16 16')
export const IconQueue = wrap(<><path d="M2.6 4.4h12.8M2.6 9h8.7M2.6 13.6h6.3" /><path d="M12.3 10.2 16.1 13 12.3 15.8V10.2Z" /></>, '0 0 18 18')
export const IconVolume = wrap(<><path d="M8.5 3.5 4.8 6.8H2.4v4.4h2.4l3.7 3.3V3.5Z" fill="currentColor" stroke="none" /><path d="M11 6.5a3.4 3.4 0 0 1 0 5M13 4.5a6.2 6.2 0 0 1 0 9" /></>, '0 0 18 18')
/** 小声：只剩一圈声波（音量三档的中间档，dock 音量图标用） */
export const IconVolumeLow = wrap(<><path d="M8.5 3.5 4.8 6.8H2.4v4.4h2.4l3.7 3.3V3.5Z" fill="currentColor" stroke="none" /><path d="M11 6.5a3.4 3.4 0 0 1 0 5" /></>, '0 0 18 18')
export const IconVolumeMute = wrap(<><path d="M8.5 3.5 4.8 6.8H2.4v4.4h2.4l3.7 3.3V3.5Z" fill="currentColor" stroke="none" /><path d="M11.5 7l4 4M15.5 7l-4 4" /></>, '0 0 18 18')
export const IconSearch = wrap(<><circle cx="7.5" cy="7.5" r="4.7" /><path d="M11.2 11.2 15 15" /></>, '0 0 16 16')
export const IconSettings = wrap(<><circle cx="8" cy="8" r="2.4" /><path d="M8 1.8v1.6M8 12.6v1.6M2.8 8H1.2M14.8 8h-1.6M4.2 4.2 3 3M13 13l-1.2-1.2M11.8 4.2 13 3M3 13l1.2-1.2" /></>, '0 0 16 16')
export const IconMusicNote = wrap(<><path d="M6 12.5V4l7-1.4v8.6" /><circle cx="3.8" cy="13" r="2.2" /><circle cx="10.8" cy="11.6" r="2.2" /></>, '0 0 16 16')
export const IconClose = wrap(<path d="M3.4 3.4 10.6 10.6M10.6 3.4 3.4 10.6" />, '0 0 14 14')
export const IconGrip = wrap(<g fill="currentColor" stroke="none"><circle cx="5" cy="3.6" r="1" /><circle cx="9" cy="3.6" r="1" /><circle cx="5" cy="7" r="1" /><circle cx="9" cy="7" r="1" /><circle cx="5" cy="10.4" r="1" /><circle cx="9" cy="10.4" r="1" /></g>, '0 0 14 14')
export const IconPlus = wrap(<path d="M9 3.2v11.6M3.2 9h11.6" />, '0 0 18 18')
/** 行尾「更多」：触摸屏上用来替代右键菜单 */
export const IconMore = wrap(
  <g fill="currentColor" stroke="none">
    <circle cx="3.4" cy="9" r="1.35" /><circle cx="9" cy="9" r="1.35" /><circle cx="14.6" cy="9" r="1.35" />
  </g>,
  '0 0 18 18',
)
export const IconFolder = wrap(<><path d="M2.5 5.2A1.7 1.7 0 0 1 4.2 3.5h2.4l1.7 1.7h7.5A1.7 1.7 0 0 1 17.5 7v7.3a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7V5.2Z" /></>, '0 0 20 20')
/** 刷新：单环 + 一个箭头。旧版是四段拼接弧线、其中两段还带 transform 偏移，
 *  缩到 13~20px 就成了一团碎线（用户：「刷新按钮图标有点奇怪」）。
 *  现在是「从右侧开口顺时针绕一圈」的闭环：起点 (14,8) 绕 3/4 圈到顶，
 *  贝塞尔收口接箭头，箭头尖在 (14,5.33) 指向顺时针方向。 */
export const IconRefresh = wrap(
  <>
    <path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.287.667 4.493 1.827L14 5.333" />
    <path d="M14 2v3.333h-3.333" />
  </>,
  '0 0 16 16',
)
export const IconDownload = wrap(<><path d="M8 2.5v8M4.8 7.6 8 10.8l3.2-3.2" /><path d="M2.8 13.5h10.4" /></>, '0 0 16 16')
/** 导航「下载」：箭头落进托盘（与「导入」的箭头落进文件区分开） */
export const IconDownloads = wrap(
  <>
    <path d="M8 2v7.2" />
    <path d="M5 6.4 8 9.4l3-3" />
    <path d="M2.6 11.2v1.4a1.4 1.4 0 0 0 1.4 1.4h8a1.4 1.4 0 0 0 1.4-1.4v-1.4" />
  </>,
  '0 0 16 16',
)
export const IconUpload = wrap(<><path d="M8 10.5v-8M4.8 5.4 8 2.2l3.2 3.2" /><path d="M2.8 13.5h10.4" /></>, '0 0 16 16')
export const IconTrash = wrap(<><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.2 4.5l.6 8.2h6.4l.6-8.2" /></>, '0 0 16 16')
/** 导入：箭头落进托盘 */
export const IconImport = wrap(<><path d="M8 2v7M5.4 6.6 8 9.2l2.6-2.6" /><path d="M2.8 11v1.6a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2V11" /></>, '0 0 16 16')
export const IconCheck = wrap(<path d="M3 8.2 6.5 11.7 13 4.8" />, '0 0 16 16')
/** 收藏：五角星（收藏态由 CSS 填色） */
export const IconStar = wrap(
  <path d="M8 2.1l1.86 3.77 4.16.6-3.01 2.94.71 4.14L8 11.59l-3.72 1.96.71-4.14L1.98 6.47l4.16-.6L8 2.1Z" />,
  '0 0 16 16',
)
export const IconSidebar = wrap(<><rect x="2.2" y="3" width="11.6" height="10" rx="2" /><path d="M6 3v10" /></>, '0 0 16 16')

/* ---- 侧栏导航 ---- */
/**
 * 「我的」：人形。
 * 以前画的是唱片（一圈套一点），远看像个靶心，跟「在线搜索」的放大镜、
 * 「歌单广场」的列表都看不出区别。人形是「我的 / 账号」的通用符号。
 */
export const IconUser = wrap(
  <>
    <circle cx="8" cy="5.8" r="2.7" />
    <path d="M2.9 13.8c0-2.5 2.3-4.1 5.1-4.1s5.1 1.6 5.1 4.1" />
  </>,
  '0 0 16 16',
)
/** 「歌单广场」：三行目录 + 一个音符（列表 = 歌单，音符 = 音乐，一眼分得开） */
export const IconPlaylist = wrap(
  <>
    <path d="M2.3 4.2h6.2M2.3 8h6.2M2.3 11.8h4.4" />
    <path d="M12.9 4.4v7.1" />
    <circle cx="11.5" cy="12" r="1.5" />
  </>,
  '0 0 16 16',
)
/**
 * 「设置」：带齿的齿轮。
 * 旧版是一个圆加 8 根细线，看着就是一个小太阳/台灯——用户第一眼认不出来。
 * 这里用真正的齿轮轮廓（8 齿闭合路径），语义唯一。
 */
export const IconCog = wrap(
  <>
    <circle cx="12" cy="12" r="3" />
    <path
      strokeWidth="2"
      d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
    />
  </>,
  '0 0 24 24',
)

export const IconLyric = wrap(<><path d="M3 4.5h10M3 8h7M3 11.5h5" /><path d="M13 11.5h.01" /></>, '0 0 16 16')
/* 歌词对齐三件套：三条横线，靠哪一侧齐就把三条的起始端对齐到哪一侧。
   中间那条短一档，才看得出「这是一段文字」而不是汉堡菜单。 */
export const IconAlignLeft = wrap(<><path d="M2.4 4h11.2M2.4 8h6.8M2.4 12h11.2" /></>, '0 0 16 16')
export const IconAlignCenter = wrap(<><path d="M2.4 4h11.2M4.6 8h6.8M2.4 12h11.2" /></>, '0 0 16 16')
export const IconAlignRight = wrap(<><path d="M2.4 4h11.2M6.8 8h6.8M2.4 12h11.2" /></>, '0 0 16 16')
/** 频谱样式：一条起伏的波形 */
export const IconWave = wrap(
  <path d="M2 8.4c1.4 0 1.7-4 3.1-4s1.7 7.4 3.1 7.4 1.7-6.2 3.1-6.2 1.6 4.2 3 4.2" />,
  '0 0 16 16',
)

/** Folia 歌词动效：一颗迸开的星 */
export const IconSparkle = wrap(
  <>
    <path d="M9 2.3l1.5 4.2 4.2 1.5-4.2 1.5L9 13.7 7.5 9.5 3.3 8l4.2-1.5L9 2.3Z" />
    <path d="M14.1 12.4l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7Z" opacity="0.62" />
  </>,
  '0 0 18 18',
)

/* ---- 沉浸式播放 / 桌面歌词 ---- */
export const IconChevronUp = wrap(<path d="M4 11.5 9 6.5l5 5" />, '0 0 18 18')
/** 返回上一级（设计稿 07 队列页左上角那颗 ‹） */
export const IconChevronLeft = wrap(<path d="M11.5 4 6.5 9l5 5" />, '0 0 18 18')
/** 进入下一级（卡片右侧那颗 ›） */
export const IconChevronRight = wrap(<path d="M6.5 4 11.5 9l-5 5" />, '0 0 18 18')
/** 队列排序手柄（设计稿 07）：三条横线，六个点那版留给桌面 */
export const IconGripLines = wrap(<path d="M3.6 5.4h10.8M3.6 9h10.8M3.6 12.6h10.8" />, '0 0 18 18')
export const IconChevronDown = wrap(<path d="M4 6.5 9 11.5l5-5" />, '0 0 18 18')
export const IconInfo = wrap(<><circle cx="9" cy="9" r="6.6" /><path d="M9 8.2v4.4M9 5.9v.01" /></>, '0 0 18 18')
/** 桌面歌词：气泡 + 两行字 */
export const IconDesktopLyric = wrap(
  <>
    <rect x="1.6" y="3.4" width="14.8" height="9.6" rx="2.6" />
    <path d="M4.6 7h6M4.6 9.8h4" />
    <path d="M11.6 13v2.2" />
  </>,
  '0 0 18 18',
)
export const IconLock = wrap(
  <>
    <rect x="3.6" y="7.6" width="9.2" height="7.2" rx="1.8" />
    <path d="M6.2 7.6V5.4a2.6 2.6 0 0 1 5.2 0v2.2" />
  </>,
  '0 0 16 16',
)
export const IconUnlock = wrap(
  <>
    <rect x="3.6" y="7.6" width="9.2" height="7.2" rx="1.8" />
    <path d="M6.2 7.6V5.4a2.6 2.6 0 0 1 5.2 0" />
  </>,
  '0 0 16 16',
)
export const IconFile = wrap(
  <>
    <path d="M4 1.8h4.4L12.6 6v8.2H4V1.8Z" />
    <path d="M8.2 1.9V6h4.2" />
  </>,
  '0 0 16 16',
)
/** 音效：三条带滑块的推子（设置页/播放页共用） */
export const IconSliders = wrap(
  <>
    <path d="M3 4.2h10M3 8h10M3 11.8h10" />
    <circle cx="6" cy="4.2" r="1.5" />
    <circle cx="10.4" cy="8" r="1.5" />
    <circle cx="5.2" cy="11.8" r="1.5" />
  </>,
  '0 0 16 16',
)
/** 频谱摆放位置：窗口四边 + 中间一块封面 */
export const IconFrame = wrap(
  <>
    <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.8" />
    <rect x="5.6" y="6" width="4.8" height="4" rx="1" />
  </>,
  '0 0 16 16',
)

/**
 * 音乐桌面：一块显示器 + 屏幕里的音符。
 * 区别于「全屏」（四个角向外张开）：它是**铺在桌面上的那块屏**，不是把应用放大。
 */
export const IconMonitor = wrap(
  <>
    <rect x="2" y="2.6" width="12" height="8.6" rx="1.6" />
    <path d="M5.6 13.4h4.8M8 11.2v2.2" />
    <path d="M6.6 5.4v3.1l2.6-1.55-2.6-1.55Z" fill="currentColor" stroke="none" />
    <path d="M10.2 5.4v3.1" />
  </>,
  '0 0 16 16',
)

/** 进入全屏：四个角向外张开的直角 */
export const IconFullscreen = wrap(
  <path d="M2.4 6V2.4H6M10 2.4h3.6V6M13.6 10v3.6H10M6 13.6H2.4V10" />,
  '0 0 16 16',
)
/** 退出全屏：四个角向内收 */
export const IconFullscreenExit = wrap(
  <path d="M6 2.4V6H2.4M13.6 6H10V2.4M10 13.6V10h3.6M2.4 10H6v3.6" />,
  '0 0 16 16',
)

/* ---------- 设计交付包（Android/design-handoff/icons）对应图标 ---------- */

/** 收藏：心形（描边 → 选中时 CSS 填强调色） */
export const IconHeart = wrap(
  <path d="M9 15.2S2.4 11.2 2.4 6.9a3.7 3.7 0 0 1 6.6-2.3 3.7 3.7 0 0 1 6.6 2.3c0 4.3-6.6 8.3-6.6 8.3Z" />,
  '0 0 18 18',
)
/** 收藏（已收藏）：同一颗心形填满——只换颜色在深色底上太难分辨 */
export const IconHeartFilled = wrap(
  <path d="M9 15.2S2.4 11.2 2.4 6.9a3.7 3.7 0 0 1 6.6-2.3 3.7 3.7 0 0 1 6.6 2.3c0 4.3-6.6 8.3-6.6 8.3Z"
    fill="currentColor" stroke="none" />,
  '0 0 18 18',
)
/** 唱片视图：同心圆纹路 + 中心孔（页头上切「封面 / 唱片」用） */
export const IconDisc = wrap(
  <>
    <circle cx="9" cy="9" r="7.2" />
    <circle cx="9" cy="9" r="2.1" />
    <path d="M9 1.8a7.2 7.2 0 0 1 7.2 7.2" opacity=".55" />
  </>,
  '0 0 18 18',
)
/** 评论：对话气泡 */
export const IconComment = wrap(
  <>
    <path d="M15 10.6a2 2 0 0 1-2 2H6.2L2.8 15.4V4.4a2 2 0 0 1 2-2h8.2a2 2 0 0 1 2 2Z" />
  </>,
  '0 0 18 18',
)
/** 分享：从方框里出去的箭头 */
export const IconShare = wrap(
  <>
    <path d="M7 3.2H4.4a1.8 1.8 0 0 0-1.8 1.8v8.2a1.8 1.8 0 0 0 1.8 1.8h8.2a1.8 1.8 0 0 0 1.8-1.8V10" />
    <path d="M10.6 2.8h4.2v4.2" />
    <path d="M8.6 8.8 14.6 2.8" />
  </>,
  '0 0 18 18',
)
/** 拖动排序手柄：三条横线（设计稿 20×20，命中区扩到 44） */
export const IconHandle = wrap(
  <path d="M3 5.4h12M3 9h12M3 12.6h12" />,
  '0 0 18 18',
)
/** 正在播放指示：四根高低柱（设计稿波形） */
export const IconWaveform = wrap(
  <g fill="currentColor" stroke="none">
    <rect x="2.2" y="7" width="1.9" height="4" rx=".95" />
    <rect x="5.4" y="4.4" width="1.9" height="9.2" rx=".95" />
    <rect x="8.6" y="2.4" width="1.9" height="13.2" rx=".95" />
    <rect x="11.8" y="5.6" width="1.9" height="6.8" rx=".95" />
    <rect x="15" y="7.6" width="1.9" height="2.8" rx=".95" />
  </g>,
  '0 0 19 18',
)
/** 音质胶囊左侧的小喇叭（设计稿 ic-speaker 12） */
export const IconSpeaker = wrap(
  <>
    <path d="M6.2 3.6 3.4 6H1.6v4h1.8l2.8 2.4V3.6Z" fill="currentColor" stroke="none" />
    <path d="M8.2 5.8a3 3 0 0 1 0 4.4" />
  </>,
  '0 0 12 12',
)
/** 队列/列表（设计稿 ic-queue：三行 + 三角） */
export const IconQueueLines = wrap(
  <>
    <path d="M2.6 4.4h9M2.6 9h6.4M2.6 13.4h4.6" />
    <path d="M12.2 9.6 15.6 12l-3.4 2.4V9.6Z" />
  </>,
  '0 0 18 18',
)

/** 视图切换：卡片/网格（四宫格） */
export const IconGrid = wrap(
  <>
    <rect x="2.6" y="2.6" width="5.2" height="5.2" rx="1.3" />
    <rect x="10.2" y="2.6" width="5.2" height="5.2" rx="1.3" />
    <rect x="2.6" y="10.2" width="5.2" height="5.2" rx="1.3" />
    <rect x="10.2" y="10.2" width="5.2" height="5.2" rx="1.3" />
  </>,
  '0 0 18 18',
)

/** 视图切换：列表（封面 + 两行字） */
export const IconRows = wrap(
  <>
    <rect x="2.6" y="3.4" width="3.6" height="3.6" rx="1" />
    <path d="M8.2 4.2h7.2M8.2 6.2h4.6" />
    <rect x="2.6" y="11" width="3.6" height="3.6" rx="1" />
    <path d="M8.2 11.8h7.2M8.2 13.8h4.6" />
  </>,
  '0 0 18 18',
)
