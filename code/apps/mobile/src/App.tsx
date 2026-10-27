/**
 * 移动端 App 根组件：启动页 → Tab 导航（本地音乐/播放列表/设置）+ 迷你播放条。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import TrackPlayer, { State, useProgress } from 'react-native-track-player'
import { fmtTime, initialQueueState, playTracks, type LocalTrack, type QueueState } from '@shuyin/core'
import { BUILTIN_THEMES, storage, useTheme } from './lib/Theme'
import { getTracks, lastScannedAt, requestPermission, scanMusic } from './lib/library'
import { playQueue, setupPlayer } from './lib/player'
import { Splash } from './components/Splash'

type Tab = 'library' | 'queue' | 'settings'

export function App() {
  const th = useTheme()
  const [showSplash, setShowSplash] = useState(true)
  const [firstLaunch] = useState(() => {
    const launched = storageGetBool('app.launched')
    if (launched === null) { storageSetBool('app.launched', true); return true }
    return false
  })
  const [tab, setTab] = useState<Tab>('library')
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null)
  const [scanning, setScanning] = useState(false)
  const [library, setLibrary] = useState<LocalTrack[]>([])
  const [queue, setQueue] = useState<QueueState>(initialQueueState)
  const [query, setQuery] = useState('')

  /* 初始化：播放器 setup（并行于启动页） */
  useEffect(() => {
    void setupPlayer().catch(() => {})
  }, [])

  const doScan = useCallback(async (incremental: boolean) => {
    setScanning(true)
    try {
      const granted = await requestPermission()
      setPermissionGranted(granted)
      if (!granted) return
      await scanMusic(incremental)
      setLibrary(getTracks())
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    const existing = getTracks()
    if (existing.length) setLibrary(existing)
    else void doScan(false)
  }, [doScan])

  const play = useCallback((tracks: LocalTrack[], index: number) => {
    const st = playTracks(queue, tracks, index)
    setQueue({ queue: st.queue, index: st.index, repeat: st.repeat, order: st.order })
    void playQueue(st.queue, st.index)
  }, [queue])

  if (showSplash) {
    return <Splash firstLaunch={firstLaunch} reducedMotion={th.reducedMotion} onDone={() => setShowSplash(false)} />
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.root, { backgroundColor: th.tokens.backgroundBase }]}>
        {tab === 'library' && (
          <LibraryTab library={library} query={query} onQuery={setQuery} scanning={scanning}
            permission={permissionGranted} onPlay={play} onRescan={() => void doScan(true)} />
        )}
        {tab === 'queue' && <QueueTab queue={queue} onPlay={play} />}
        {tab === 'settings' && <SettingsTab />}
        <MiniBar />
        <TabBar tab={tab} onChange={setTab} />
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

/* ---------------- Tab：本地音乐 ---------------- */

function LibraryTab({ library, query, onQuery, scanning, permission, onPlay, onRescan }: {
  library: LocalTrack[]
  query: string
  onQuery(q: string): void
  scanning: boolean
  permission: boolean | null
  onPlay(tracks: LocalTrack[], i: number): void
  onRescan(): void
}) {
  const th = useTheme()
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return library
    return library.filter(t =>
      t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q))
  }, [library, query])

  if (permission === false) {
    return (
      <Empty title="还没有媒体库权限" sub="在系统设置里允许疏音访问音频文件后重试"
        actionLabel="重新请求权限" onAction={onRescan} />
    )
  }

  return (
    <View style={styles.tabContent}>
      <View style={styles.libHead}>
        <Text style={[styles.h1, { color: th.tokens.textPrimary }]}>本地音乐</Text>
        <Text style={[styles.status, { color: th.tokens.textTertiary }]}>
          {scanning ? '正在扫描…' : library.length ? `共 ${library.length} 首` : '暂无歌曲'}
        </Text>
      </View>
      <TextInput
        style={[styles.search, { color: th.tokens.textPrimary, borderColor: th.tokens.line, backgroundColor: 'rgba(255,255,255,0.04)' }]}
        placeholder="搜索本地曲库"
        placeholderTextColor={th.tokens.textTertiary}
        value={query} onChangeText={onQuery}
      />
      <FlatList
        data={filtered}
        keyExtractor={t => t.id}
        initialNumToRender={16}
        maxToRenderPerBatch={16}
        windowSize={7}
        renderItem={({ item, index }) => <TrackRow track={item} onPlay={() => onPlay(filtered, index)} />}
        ListEmptyComponent={
          scanning
            ? <Text style={[styles.emptyText, { color: th.tokens.textTertiary }]}>正在扫描本地音乐…</Text>
            : <Empty title="没有找到歌曲" sub="试试重新扫描" actionLabel="重新扫描" onAction={onRescan} />
        }
      />
    </View>
  )
}

function TrackRow({ track, onPlay }: { track: LocalTrack; onPlay(): void }) {
  const th = useTheme()
  return (
    <Pressable
      onPress={onPlay}
      style={({ pressed }) => [styles.trackRow, pressed && { opacity: 0.7 }]}
    >
      <View style={[styles.cover, { backgroundColor: th.tokens.backgroundElevated }]} />
      <View style={styles.trackMeta}>
        <Text numberOfLines={1} style={[styles.trackTitle, { color: th.tokens.textPrimary }]}>{track.title}</Text>
        <Text numberOfLines={1} style={[styles.trackSub, { color: th.tokens.textSecondary }]}>{track.artist} · {track.album}</Text>
      </View>
      <Text style={[styles.trackDur, { color: th.tokens.textTertiary }]}>{track.format.toUpperCase()}</Text>
    </Pressable>
  )
}

/* ---------------- Tab：队列 ---------------- */

function QueueTab({ queue, onPlay }: { queue: QueueState; onPlay(t: LocalTrack[], i: number): void }) {
  const th = useTheme()
  const q = queue.queue
  return (
    <View style={styles.tabContent}>
      <Text style={[styles.h1, { color: th.tokens.textPrimary }]}>播放列表</Text>
      <FlatList
        data={q}
        keyExtractor={t => t.id}
        renderItem={({ item, index }) => (
          <TrackRow track={item} onPlay={() => onPlay(q, index)} />
        )}
        ListEmptyComponent={<Empty title="队列空了" sub="去本地音乐里加一首" />}
      />
    </View>
  )
}

/* ---------------- Tab：设置（主题 + 减弱动效 + 关于） ---------------- */

function SettingsTab() {
  const th = useTheme()
  return (
    <ScrollView style={styles.tabContent} contentContainerStyle={{ paddingBottom: 160 }}>
      <Text style={[styles.h1, { color: th.tokens.textPrimary }]}>设置</Text>

      <Text style={[styles.groupTitle, { color: th.tokens.textSecondary }]}>外观模式</Text>
      <View style={styles.modeRow}>
        {(['light', 'dark', 'system'] as const).map(m => (
          <Pressable key={m} onPress={() => th.setMode(m)}
            style={[styles.modeBtn, th.mode === m && { backgroundColor: 'rgba(255,255,255,0.12)' }]}>
            <Text style={[styles.modeBtnText, { color: th.mode === m ? th.tokens.textPrimary : th.tokens.textSecondary }]}>
              {m === 'light' ? '浅色' : m === 'dark' ? '深色' : '跟随系统'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.groupTitle, { color: th.tokens.textSecondary }]}>主题</Text>
      {BUILTIN_THEMES.map(t => (
        <Pressable key={t.id} onPress={() => th.selectTheme(t.id)}
          style={[styles.themeItem, { backgroundColor: t.tokens.backgroundElevated, borderColor: th.activeTheme.id === t.id ? t.tokens.accent : 'transparent' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: t.tokens.accent }} />
            <View>
              <Text style={{ color: t.tokens.textPrimary, fontSize: 13, fontWeight: '600' }}>{t.name}</Text>
              <Text style={{ color: t.tokens.textSecondary, fontSize: 10.5 }}>{t.tagline}</Text>
            </View>
          </View>
        </Pressable>
      ))}

      <Text style={[styles.groupTitle, { color: th.tokens.textSecondary }]}>无障碍</Text>
      <View style={styles.modeRow}>
        <Text style={{ color: th.tokens.textSecondary, fontSize: 12.5 }}>减弱动效</Text>
        <Pressable onPress={() => th.setReducedMotion(!th.reducedMotion)}
          style={[styles.switch, th.reducedMotion && { backgroundColor: 'rgba(255,255,255,0.25)' }]}>
          <View style={[styles.switchKnob, th.reducedMotion && { transform: [{ translateX: 18 }] }]} />
        </Pressable>
      </View>

      <Text style={[styles.groupTitle, { color: th.tokens.textSecondary }]}>关于疏音</Text>
      <Text style={{ color: th.tokens.textTertiary, fontSize: 11 }}>疏影横斜，澄澈之音 · v0.1.0 第一阶段</Text>
    </ScrollView>
  )
}

/* ---------------- 迷你播放条 ---------------- */

function MiniBar() {
  const th = useTheme()
  const progress = useProgress()
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    const sub = TrackPlayer.addEventListener('playback-state', e => {
      setPlaying(e.state === State.Playing)
    })
    return () => sub.remove()
  }, [])
  const [track, setTrack] = useState<{ title: string; artist: string } | null>(null)
  useEffect(() => {
    const sub = TrackPlayer.addEventListener('playback-track-changed', async () => {
      const t = await TrackPlayer.getActiveTrack()
      setTrack(t ? { title: t.title ?? '', artist: (t.artist as string) ?? '' } : null)
    })
    return () => sub.remove()
  }, [])

  const ratio = progress.duration > 0 ? progress.position / progress.duration : 0

  return (
    <View style={[styles.miniBar, { backgroundColor: th.tokens.glassTint, borderColor: th.tokens.glassBorder }]}>
      <View style={[styles.miniProgressTrack, { backgroundColor: 'rgba(255,255,255,0.10)' }]}>
        <View style={[styles.miniProgressFill, { width: `${ratio * 100}%`, backgroundColor: th.tokens.accent }]} />
      </View>
      <View style={styles.miniRow}>
        <View style={styles.miniMeta}>
          <Text numberOfLines={1} style={[styles.miniTitle, { color: th.tokens.textPrimary }]}>
            {track?.title ?? '未在播放'}
          </Text>
          <Text numberOfLines={1} style={[styles.miniSub, { color: th.tokens.textSecondary }]}>
            {track ? track.artist + ' · 歌词将在后续版本支持' : '从本地音乐里选一首吧'}
          </Text>
        </View>
        <Pressable onPress={() => (playing ? TrackPlayer.pause() : TrackPlayer.play())} hitSlop={8}>
          <Text style={{ color: th.tokens.textPrimary, fontSize: 18 }}>{playing ? '⏸' : '▶'}</Text>
        </Pressable>
        <Pressable onPress={() => TrackPlayer.skipToNext()} hitSlop={8}>
          <Text style={{ color: th.tokens.textSecondary, fontSize: 16 }}>⏭</Text>
        </Pressable>
      </View>
    </View>
  )
}

/* ---------------- Tab 栏 ---------------- */

function TabBar({ tab, onChange }: { tab: Tab; onChange(t: Tab): void }) {
  const th = useTheme()
  const items: Array<[Tab, string]> = [['library', '本地音乐'], ['queue', '播放列表'], ['settings', '设置']]
  return (
    <View style={[styles.tabBar, { backgroundColor: th.tokens.glassTint, borderColor: th.tokens.glassBorder }]}>
      {items.map(([id, label]) => (
        <Pressable key={id} onPress={() => onChange(id)} style={styles.tabItem}>
          <Text style={{ fontSize: 12.5, fontWeight: tab === id ? '600' : '400',
            color: tab === id ? th.tokens.textPrimary : th.tokens.textSecondary }}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

/* ---------------- 空态 ---------------- */

function Empty({ title, sub, actionLabel, onAction }: {
  title: string; sub: string; actionLabel?: string; onAction?(): void
}) {
  const th = useTheme()
  return (
    <View style={styles.empty}>
      <Text style={{ color: th.tokens.textSecondary, fontSize: 13.5 }}>{title}</Text>
      <Text style={{ color: th.tokens.textTertiary, fontSize: 11.5, marginTop: 6 }}>{sub}</Text>
      {actionLabel && onAction && (
        <Pressable onPress={onAction} style={[styles.emptyBtn, { backgroundColor: th.tokens.accent }]}>
          <Text style={{ color: '#fff', fontSize: 12.5 }}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  )
}

/* ---------------- MMKV bool 工具 ---------------- */

function storageGetBool(key: string): boolean | null {
  const v = storage.getBoolean(key)
  return v === undefined ? null : v
}
function storageSetBool(key: string, v: boolean): void {
  storage.set(key, v)
}

/* ---------------- 样式 ---------------- */

const styles = StyleSheet.create({
  root: { flex: 1 },
  tabContent: { flex: 1, paddingHorizontal: 16 },
  h1: { fontSize: 20, fontWeight: '600', marginTop: 8 },
  libHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 8 },
  status: { fontSize: 11 },
  search: {
    height: 34, borderRadius: 10, borderWidth: 1,
    paddingHorizontal: 12, fontSize: 12.5, marginVertical: 10,
  },
  trackRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    height: 58, paddingHorizontal: 4,
  },
  cover: { width: 40, height: 40, borderRadius: 9 },
  trackMeta: { flex: 1, gap: 3 },
  trackTitle: { fontSize: 13, fontWeight: '500' },
  trackSub: { fontSize: 10.5 },
  trackDur: { fontSize: 9, fontWeight: '600', opacity: 0.7 },
  groupTitle: { fontSize: 13, fontWeight: '600', marginTop: 22, marginBottom: 10 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  modeBtn: {
    paddingHorizontal: 14, height: 30, borderRadius: 15,
    justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)',
  },
  modeBtnText: { fontSize: 12 },
  themeItem: {
    borderRadius: 12, borderWidth: 1.5, padding: 12, marginBottom: 8,
  },
  switch: {
    width: 38, height: 22, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center', padding: 2,
  },
  switchKnob: {
    width: 18, height: 18, borderRadius: 9, backgroundColor: '#EAEBF1',
  },
  miniBar: {
    position: 'absolute', left: 16, right: 16, bottom: 74,
    height: 64, borderRadius: 18, borderWidth: 1, overflow: 'hidden',
  },
  miniProgressTrack: { height: 2, marginHorizontal: 12, marginTop: 0 },
  miniProgressFill: { height: 2 },
  miniRow: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 14 },
  miniMeta: { flex: 1, gap: 3 },
  miniTitle: { fontSize: 12.5, fontWeight: '500' },
  miniSub: { fontSize: 10 },
  tabBar: {
    position: 'absolute', left: 21, right: 21, bottom: 12,
    height: 62, borderRadius: 36, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center',
  },
  tabItem: { flex: 1, alignItems: 'center' },
  empty: { alignItems: 'center', paddingVertical: 48, gap: 4 },
  emptyText: { fontSize: 12, paddingVertical: 24, textAlign: 'center' },
  emptyBtn: {
    marginTop: 14, paddingHorizontal: 18, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
})
