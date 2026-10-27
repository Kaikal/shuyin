/**
 * 移动端播放器：react-native-track-player v4。
 * 本地文件 file:// URI；后台播放与锁屏控制由 v4 内建。
 */
import TrackPlayer, { Event } from 'react-native-track-player'
import type { LocalTrack } from '@shuyin/core'

export async function setupPlayer(): Promise<void> {
  await TrackPlayer.setupPlayer({
    contentType: 'music',
    handleAudioBecomingNoisy: true,
  })
  await TrackPlayer.updateOptions({
    android: {
      appKilledPlaybackBehavior: 'StopPlaybackAndRemoveNotification',
    },
    capabilities: [
      { capability: 'Play' }, { capability: 'Pause' },
      { capability: 'SkipToNext' }, { capability: 'SkipToPrevious' },
      { capability: 'SeekTo' },
    ],
    compactCapabilities: ['Play', 'Pause', 'SkipToNext', 'SkipToPrevious'],
    notificationCapabilities: ['Play', 'Pause', 'SkipToNext', 'SkipToPrevious'],
  })
}

/** UI 単位转换：LocalTrack → TrackPlayer Track */
export function toTpTrack(t: LocalTrack) {
  return {
    id: t.id,
    url: t.path.startsWith('file://') || t.path.startsWith('content://') ? t.path : 'file://' + t.path,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    artwork: t.cover ?? undefined,
  }
}

export async function playQueue(tracks: LocalTrack[], startIndex: number): Promise<void> {
  await TrackPlayer.reset()
  await TrackPlayer.add(tracks.map(toTpTrack))
  await TrackPlayer.skip(startIndex)
  await TrackPlayer.play()
}

/** 后台事件注册（index.js 中调用，UI 卸载不影响） */
export async function registerPlaybackService(): Promise<void> {
  TrackPlayer.registerPlaybackService(async () => {
    TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play())
    TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause())
    TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext())
    TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious())
    TrackPlayer.addEventListener(Event.RemoteSeek, e => TrackPlayer.seekTo(e.position))
  })
}
