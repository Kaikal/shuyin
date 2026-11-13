/**
 * 收藏的歌曲 = 「我喜欢的音乐」。
 *
 * v0.6.5 起存的是**记录**而不是光秃秃的 id。原因：
 *   · 以前只存 id，收藏的如果是**在线**曲目（`online:wy:123`），它就只存在于
 *     播放页那颗心里 —— 曲库按本地 id 过滤根本遇不到它，「我的」里什么也不显示。
 *     用户的原话是「收藏按钮点了就收藏，也没有加到一个默认歌单中」。
 *   · 存下歌名 / 歌手 / 专辑 / 时长 / 来源 / 封面之后，收藏列表不依赖曲库也不依赖
 *     在线接口，断网也能把整张表画出来、点播放时再出网取链。
 *
 * 本地曲目只写 id 也够用（曲库扫描会刷新元数据），但统一存记录更省心：
 * 重扫之后 id 不变、记录的字段可能旧了，展示时以曲库为准（见 FavPage）。
 *
 * 老存档是 `string[]`（纯 id），读的时候就地升级，不用迁移脚本。
 */
import { useCallback, useEffect, useState } from 'react'
import type { LocalTrack } from '@shuyin/core'
import { KEYS, settings } from './settings'

export interface FavRec {
  /** 曲目 id：本地是文件 id，在线是 `online:<src>:<id>` */
  id: string
  name?: string
  /** 歌手，多个用「 / 」拼（和 LocalTrack.artist 一致） */
  artist?: string
  album?: string
  duration?: number
  /** 在线曲目才有（wy / tx / kg / kw）；本地曲目为 undefined */
  source?: string
  img?: string
  /** 收藏时间（毫秒）。列表按它倒序：刚收的在最上面 */
  at?: number
}

/** 进程内缓存：多个组件同时挂载时只读一次 */
let cache: FavRec[] | null = null
let loading: Promise<FavRec[]> | null = null
const subs = new Set<(v: FavRec[]) => void>()

function normalize(raw: unknown): FavRec[] {
  if (!Array.isArray(raw)) return []
  const out: FavRec[] = []
  for (const v of raw) {
    if (typeof v === 'string') {
      if (v) out.push({ id: v })
    } else if (v && typeof v === 'object' && typeof (v as FavRec).id === 'string') {
      out.push({ ...(v as FavRec) })
    }
  }
  return out
}

async function load(): Promise<FavRec[]> {
  if (cache) return cache
  if (!loading) {
    loading = settings.get<unknown>(KEYS.favTracks)
      .then(v => normalize(v))
      .catch(() => [])
      .then(v => { cache = v; loading = null; return v })
  }
  return loading
}

function publish(next: FavRec[]) {
  cache = next
  for (const fn of subs) fn(next)
  void settings.set(KEYS.favTracks, next)
}

/**
 * 切换收藏。`rec` 给了就带上元数据（在线曲目必须给，否则列表里只剩一个 id）。
 * 返回切换后的状态：`true` = 现在是收藏的。
 */
export async function toggleFav(rec: FavRec | string): Promise<boolean> {
  const r: FavRec = typeof rec === 'string' ? { id: rec } : rec
  const cur = [...(await load())]
  const at = cur.findIndex(x => x.id === r.id)
  const on = at < 0
  if (on) {
    cur.push({ ...r, at: r.at ?? Date.now() })
    publish(cur)
  } else {
    cur.splice(at, 1)
    publish(cur)
  }
  return on
}

export async function isFav(id: string): Promise<boolean> {
  return (await load()).some(x => x.id === id)
}

/**
 * LocalTrack → 收藏记录。
 *
 * 在线曲目的 id 形如 `online:wy:123456`，把来源抠出来存着：
 * 以后要重取链 / 重搜歌词都得知道是哪家。
 */
export function favRecOf(t: LocalTrack): FavRec {
  const m = /^online:([^:]+):/.exec(t.id)
  return {
    id: t.id,
    name: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    img: t.cover ?? undefined,
    source: m?.[1],
  }
}

/**
 * 收藏记录 → 可播放的 LocalTrack 列表（最新的排最前）。
 *
 * 本地曲目以**曲库**那份为准（重扫后标签可能改过）；在线曲目用记录重建。
 * 曲库里已经没有、又不是在线 id 的（文件被删了）直接跳过。
 */
export function favTracksOf(recs: FavRec[], library: LocalTrack[]): LocalTrack[] {
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
  return out.reverse()
}

/** 收藏状态（随其它组件的改动同步刷新） */
export function useFavs() {
  const [list, setList] = useState<FavRec[]>(() => cache ?? [])

  useEffect(() => {
    let alive = true
    void load().then(v => { if (alive) setList(v) })
    const fn = (v: FavRec[]) => setList(v)
    subs.add(fn)
    return () => { alive = false; subs.delete(fn) }
  }, [])

  const ids = useMemoSet(list)

  const toggle = useCallback(async (rec: FavRec | string) => toggleFav(rec), [])

  return {
    /** 收藏列表（按收藏时间正序，最新的在最后） */
    list,
    ids,
    has: (id: string) => ids.has(id),
    toggle,
    count: list.length,
  }
}

/** 从记录数组派生 id 集合；records 没变就不新建 Set，避免每次渲染都换引用 */
function useMemoSet(list: FavRec[]): Set<string> {
  const [set, setSet] = useState<Set<string>>(() => new Set(list.map(x => x.id)))
  useEffect(() => {
    setSet(prev => {
      if (prev.size === list.length && list.every(x => prev.has(x.id))) return prev
      return new Set(list.map(x => x.id))
    })
  }, [list])
  return set
}
