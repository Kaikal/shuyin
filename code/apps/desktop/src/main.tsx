import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DesktopLyricsWindow } from './components/DesktopLyrics'
import { MusicDeskWindow } from './components/MusicDesk'
import { TrayMenuWindow } from './components/TrayMenu'
import { PlayerProvider } from './lib/PlayerProvider'
import { DownloadsProvider } from './lib/DownloadsProvider'
import { PlaylistsProvider } from './lib/localPlaylists'
import { ThemeProvider } from './lib/ThemeProvider'
import { diag, installGlobalDiagnostics } from './lib/diag'
import './styles/global.css'
import './styles/shell.css'
import './styles/pages.css'
import './styles/home.css'
import './styles/splash.css'
import './styles/immersive.css'
import './styles/playlist.css'
import './styles/search.css'
import './styles/square.css'
import './styles/musicdesk.css'
import './styles/tray.css'
import './styles/login.css'
// 形态适配必须最后引：它要覆盖上面这些桌面布局
import './styles/mobile.css'

/**
 * 一个 main.tsx 承载五个窗口：
 *   主窗口        → #root 里跑完整应用
 *   桌面歌词窗口  → Rust 侧以 lyrics.html 创建，只渲染歌词层
 *   音乐桌面窗口  → Rust 侧以 musicdesk.html 创建，铺满主屏的壁纸式音乐屏
 *   音乐锁屏窗口  → Rust 侧以 musiclock.html 创建，独立的置顶全屏时钟（与音乐桌面互不干扰）
 *   托盘菜单窗口  → Rust 侧以 tray.html 创建，自绘菜单
 */
const where = (pathname: string, hash: string) =>
  pathname.includes('lyrics') || hash.includes('lyrics') ? 'lyrics'
    : pathname.includes('musiclock') || hash.includes('musiclock') ? 'musiclock'
      : pathname.includes('musicdesk') || hash.includes('musicdesk') ? 'musicdesk'
        : pathname.includes('tray') || hash.includes('tray') ? 'tray'
          : 'main'

const surface = typeof window !== 'undefined'
  ? where(window.location.pathname, window.location.hash)
  : 'main'
const isLyricsWindow = surface === 'lyrics'
const isMusicDeskWindow = surface === 'musicdesk'
const isMusicLockWindow = surface === 'musiclock'
const isTrayWindow = surface === 'tray'
if (isLyricsWindow) document.documentElement.classList.add('lyrics-mode')
// 锁屏复用音乐桌面的根样式（同一套 --md-* 色板与铺满规则），
// 只是渲染时钉死成时钟形态
if (isMusicDeskWindow || isMusicLockWindow) document.documentElement.classList.add('musicdesk-mode')
if (isTrayWindow) document.documentElement.classList.add('tray-mode')

installGlobalDiagnostics()
diag('boot.' + surface)

/*
 * 关掉 WebView 自带的右键菜单（刷新 / 另存为 / 检查元素）。
 *
 * 桌面歌词窗口右键弹这个太出戏了——点「刷新」还会让歌词窗口白一下再重载。
 * 桌面播放器一律没有这个菜单。输入框里保留：复制粘贴还得用它。
 * 注意用捕获阶段之外的默认冒泡，React 自己的 onContextMenu（曲库行菜单）不受影响。
 */
document.addEventListener('contextmenu', e => {
  const el = e.target as HTMLElement | null
  if (el?.closest('input, textarea, [contenteditable="true"]')) return
  e.preventDefault()
  // capture 阶段就拦：万一哪天某个组件在冒泡链上把事件吃了，系统菜单也不会再弹出来
}, true)

createRoot(document.getElementById('root')!).render(
  isLyricsWindow ? (
    <ThemeProvider>
      <DesktopLyricsWindow />
    </ThemeProvider>
  ) : isMusicDeskWindow ? (
    <MusicDeskWindow />
  ) : isMusicLockWindow ? (
    <MusicDeskWindow lock />
  ) : isTrayWindow ? (
    <ThemeProvider>
      <TrayMenuWindow />
    </ThemeProvider>
  ) : (
    <StrictMode>
      <ThemeProvider>
        <PlayerProvider>
          <DownloadsProvider>
            <PlaylistsProvider>
              <App />
            </PlaylistsProvider>
          </DownloadsProvider>
        </PlayerProvider>
      </ThemeProvider>
    </StrictMode>
  ),
)

diag('render.' + surface)

