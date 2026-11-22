/**
 * 播放历史（最近播放）。
 *
 * 结构和 favTracks 一致：存**记录**而不是 id——在线曲目重启后不在曲库里，
 * 光存 id 的话整张表都是空的；存下歌名/歌手/封面，断网也能画出来、
 * 点播放时再出网取链（同 favTracks.ts 头部那段的理由，不复述）。
 *
 * 规则：
 *   · 一首歌每次「真正开始播」记一次，同一首只留最新一条（挪到最前）；
 *   · 上限 200 条——历史只服务「找回来放过的歌」，再多没有检索价值，
 *     一条记录几百字节，200 条对 settings 落盘毫无压力；
 *   · 倒序存（最新的在最前），展示不用再 reverse。
 */
import { useCallback, useEffect, useState } from 'react'
import type { LocalTrack } from '@shuyin/core'
import { KEYS, settings } from './settings'
import { favRecOf, type FavRec } from './favTracks'

const MAX = 200

/** 进程内缓存：与 favTracks 同一套 read-once + 订阅模式 */
let cache: FavRec[] | null = null
let loading: Promise<FavRec[]> | null = null
const subs = new Set<(v: FavRec[]) => void>()

function normalize(raw: unknown): FavRec[] {
  if (!Array.isArray(raw)) return []
  const out: FavRec[] = []
  for (const v of raw) {
    if (v && typeof v === 'object' && typeof (v as FavRec).id === 'string') {
      out.push({ ...(v as FavRec), at: (v as FavRec).at ?? 0 })
    }
  }
  return out
}

async function load(): Promise<FavRec[]> {
  if (cache) return cache
  if (!loading) {
    loading = settings.get<unknown>(KEYS.playHistory)
      .then(v => normalize(v))
      .catch(() => [])
      .then(v => { cache = v; loading = null; return v })
  }
  return loading
}

function publish(next: FavRec[]) {
  cache = next
  for (const fn of subs) fn(next)
  void settings.set(KEYS.playHistory, next)
}

/**
 * 记一次播放：同一首挪到最前并刷新时间，没有就插到最前，超出上限裁掉尾部。
 */
export async function recordHistory(t: LocalTrack | FavRec): Promise<void> {
  const rec: FavRec = 'path' in t ? favRecOf(t) : t
  const cur = [...(await load())]
  const i = cur.findIndex(x => x.id === rec.id)
  if (i >= 0) cur.splice(i, 1)
  cur.unshift({ ...rec, at: Date.now() })
  publish(cur.length > MAX ? cur.slice(0, MAX) : cur)
}

/** 清空历史（设置里有入口还是页面上有按钮，由 UI 决定；这里只管数据） */
export async function clearHistory(): Promise<void> {
  publish([])
}

/** 播放记录 → 可播放的 LocalTrack 列表（记录本身已是最前最新） */
export function historyTracksOf(recs: FavRec[], library: LocalTrack[]): LocalTrack[] {
  const byId = new Map(library.map(t => [t.id, t]))
  const out: LocalTrack[] = []
  for (const r of recs) {
    const local = byId.get(r.id)
    if (local) { out.push(local); continue }
    if (!r.id.startsWith('online:')) continue
    out.push({
      id: r.id,
      path: '',
      title: r.name ?? '未知曲目',
      artist: r.artist ?? '',
      album: r.album ?? '',
      duration: r.duration ?? 0,
      format: 'mp3',
      bitrate: null,
      sampleRate: null,
      cover: r.img ?? null,
      mtime: 0,
      size: 0,
    })
  }
  return out
}

/** 播放历史（订阅式，多组件共享同一份缓存） */
export function useHistory() {
  const [list, setList] = useState<FavRec[]>(() => cache ?? [])

  useEffect(() => {
    let alive = true
    void load().then(v => { if (alive) setList(v) })
    const fn = (v: FavRec[]) => setList(v)
    subs.add(fn)
    return () => { alive = false; subs.delete(fn) }
  }, [])

  const clear = useCallback(async () => { await clearHistory() }, [])

  return {
    /** 播放历史（最新的在最前） */
    list,
    clear,
  }
}
