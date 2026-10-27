/**
 * 移动端媒体库扫描：@nodefinity/react-native-music-library 0.10（TurboModule，读 MediaStore）。
 * 分页拉取（first: 50，游标续取）→ 归一化为 core 的 LocalTrack → MMKV 持久化。
 */
import type { LocalTrack, ScanResult } from '@shuyin/core'
import { formatFromPath } from '@shuyin/core'
import { storage } from './Theme'

const LIB_KEY = 'library.tracks'
const LIB_AT = 'library.scannedAt'

/**
 * 申请读取媒体权限：Android 13+ 用 READ_MEDIA_AUDIO，12 及以下用 READ_EXTERNAL_STORAGE。
 * 权限必须由应用层申请，库本身只负责读 MediaStore。
 */
export async function requestPermission(): Promise<boolean> {
  try {
    const { PermissionsAndroid, Platform } = require('react-native') as typeof import('react-native')
    if (Platform.OS !== 'android') return true
    const api = Number(Platform.Version)
    const perm = api >= 33
      ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO
      : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE
    const granted = await PermissionsAndroid.request(perm, {
      title: '读取本地音乐',
      message: '疏音需要读取设备上的音频文件，才能建立本地曲库。',
      buttonPositive: '允许',
      buttonNegative: '暂不',
    })
    return granted === PermissionsAndroid.RESULTS.GRANTED
  } catch {
    return false
  }
}

/** 媒体库分页拉取（每页 50，游标续取），归一化成 core 的 LocalTrack */
export async function scanMusic(incremental: boolean): Promise<ScanResult> {
  const { getTracksAsync } = require('@nodefinity/react-native-music-library') as
    typeof import('@nodefinity/react-native-music-library')
  const start = Date.now()
  const tracks: LocalTrack[] = []
  let cursor: string | undefined

  for (;;) {
    const page = await getTracksAsync({ first: 50, after: cursor, sortBy: 'title' })
    for (const item of page.items) {
      const path: string = item.url || ''
      const format = formatFromPath(path) ?? 'mp3'
      const dur = item.duration ?? 0
      // 与桌面端保持一致的过滤：时长过短的多半是提示音/录音
      if (dur > 0 && dur < 5) continue
      tracks.push({
        id: 'm' + item.id,
        path,
        title: item.title || '未知标题',
        artist: item.artist || '未知艺术家',
        album: item.album || '未知专辑',
        duration: dur,
        format,
        bitrate: null,
        sampleRate: null,
        cover: item.artwork || null,
        mtime: item.modifiedAt ? Math.floor(item.modifiedAt * 1000) : 0,
        size: item.fileSize ?? 0,
      })
    }
    if (!page.hasNextPage || page.items.length === 0) break
    cursor = page.endCursor
  }

  const prevCount = getCount()
  storage.set(LIB_KEY, JSON.stringify(tracks))
  storage.set(LIB_AT, String(Date.now()))

  return {
    total: tracks.length,
    added: incremental ? Math.max(0, tracks.length - prevCount) : tracks.length,
    updated: 0,
    removed: incremental ? Math.max(0, prevCount - tracks.length) : 0,
    durationMs: Date.now() - start,
    incremental,
    roots: ['MediaStore'],
    skipped: 0,
    truncated: false,
  }
}

export function getCount(): number {
  const raw = storage.getString(LIB_KEY)
  if (!raw) return 0
  try { return (JSON.parse(raw) as LocalTrack[]).length } catch { return 0 }
}

export function getTracks(): LocalTrack[] {
  const raw = storage.getString(LIB_KEY)
  if (!raw) return []
  try { return JSON.parse(raw) as LocalTrack[] } catch { return [] }
}

export function lastScannedAt(): number | null {
  const v = storage.getString(LIB_AT)
  return v ? Number(v) : null
}
