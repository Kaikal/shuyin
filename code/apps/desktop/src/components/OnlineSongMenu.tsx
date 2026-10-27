/**
 * 在线曲目的右键菜单（搜索页 / 歌单详情页共用）。
 *
 * 主窗口在 `main.tsx` 里把系统右键菜单（刷新 / 另存为 / 检查元素）全局关掉了，
 * 所以**页面上没有自定义菜单的地方，右键就等于「什么都没发生」**。
 * 之前只有本地曲库做了菜单，搜出来的歌和在线歌单里右键都没反应——
 * 用户看到的就是「右键菜单不见了」。这里补上在线曲目的那一份。
 *
 * 下载：以前只能先播这首、再展开播放页、再点下载图标选音质——
 * 一首不想听的歌为了下载得先播一遍。右键直接下载，按当前首选音质取，
 * 取完落在「下载」文件夹，进度去下载页看。
 */
import { usePlayer } from '../lib/PlayerProvider'
import { useDownloads } from '../lib/DownloadsProvider'
import { platformName, toLocalTrack } from '../lib/online'
import type { SearchSong } from '@shuyin/lx-provider'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { IconDownload, IconNext, IconPlay, IconPlus } from './icons'

interface Props {
  x: number
  y: number
  song: SearchSong
  onClose(): void
}

export function OnlineSongMenu({ x, y, song, onClose }: Props) {
  const p = usePlayer()
  const dl = useDownloads()
  const track = toLocalTrack(song)
  const label = [song.name, song.singer.join(' / ')].filter(Boolean).join(' - ')

  const task = dl.taskOf(track.id)
  const done = task?.status === 'done'
  const busy = !!task && (task.status === 'queued' || task.status === 'resolving' || task.status === 'downloading')

  const copy = () => {
    const text = label
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {})
      return
    }
    // 兜底：老 WebView 没有剪贴板 API
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* 复制失败就静默 */ }
    document.body.removeChild(ta)
  }

  const items: MenuItem[] = [
    { id: 'play', label: '立即播放', icon: <IconPlay width={13} height={13} />, onSelect: () => p.playOne(track) },
    { id: 'next', label: '下一首播放', icon: <IconNext width={13} height={13} />, onSelect: () => p.addToQueue(track, 'next') },
    { id: 'queue', label: '加入播放列表', icon: <IconPlus width={13} height={13} />, onSelect: () => p.addToQueue(track, 'end') },
    { id: 'div', divider: true, label: '', onSelect: () => {} },
    {
      id: 'dl',
      label: done ? '已下载' : busy ? '正在下载…' : '下载这首歌',
      icon: <IconDownload width={13} height={13} />,
      disabled: done || busy,
      onSelect: () => dl.download(track),
    },
    { id: 'copy', label: '复制「歌名 - 歌手」', onSelect: copy },
    {
      id: 'src',
      label: `来源：${platformName(song.source)}`,
      disabled: true,
      onSelect: () => {},
    },
  ]

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
