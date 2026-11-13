/**
 * 本地歌单（自建 / 导入）与收藏的在线歌单。
 *
 * 为什么放在 settings 里而不是数据库：歌单本身很小（几百个 id），
 * 而 settings.json 已经承担了「用户偏好」这一层，读写路径成熟、同步备份也只要读一处。
 * 曲目不存元数据，只存曲库 id——曲库 id 是文件路径的哈希，重扫不会变；
 * 万一文件被删了，渲染时查不到就自然跳过，不会留下一条幽灵记录。
 *
 * 导入的歌单会把**没匹配上的歌**（missing）一起存下来：
 * 用户在别的 APP 里导出的歌单，曲库里暂时没有这些歌，
 * 直接把条目丢掉等于把「我原本想听什么」这个信息弄没了。
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import type { LocalTrack } from '@shuyin/core'
import type { PlatformSource } from '@shuyin/lx-provider'
import { KEYS, settings } from './settings'
import { coverUrlOf } from './coverUrl'
import { trackOfId } from './online'

export interface PlaylistMissing {
  title: string
  artist: string
}

export interface LocalPlaylist {
  id: string
  name: string
  note?: string
  /** 曲库曲目 id，顺序即歌单顺序 */
  trackIds: string[]
  /** 导入时曲库里没有的歌 */
  missing?: PlaylistMissing[]
  origin: 'manual' | 'import'
  /** 导入来源文件名 */
  originName?: string
  createdAt: number
  updatedAt: number
}

export interface FavPlaylist {
  /** `${source}:${id}` */
  key: string
  source: PlatformSource
  id: string
  name: string
  cover?: string
  creator?: string
  songCount?: number
  at: number
}

interface Ctx {
  ready: boolean
  lists: LocalPlaylist[]
  favs: FavPlaylist[]
  create(name: string, opts?: {
    note?: string
    trackIds?: string[]
    origin?: 'manual' | 'import'
    originName?: string
    missing?: PlaylistMissing[]
  }): LocalPlaylist
  rename(id: string, name: string): void
  remove(id: string): void
  /** 歌单卡在「我的」里的排列顺序（拖动排序用，索引是 `lists` 里下标） */
  reorder(from: number, to: number): void
  /** 收藏的在线歌单排序（同上，下标是 `favs` 的） */
  moveFav(from: number, to: number): void
  addTracks(id: string, ids: string[]): number
  removeTrack(id: string, trackId: string): void
  moveTrack(id: string, from: number, to: number): void
  /** 按歌单顺序取曲库里的曲目（找不到的自动跳过） */
  tracksOf(list: LocalPlaylist, library: LocalTrack[]): LocalTrack[]
  isFav(source: PlatformSource, pid: string): boolean
  toggleFav(p: Omit<FavPlaylist, 'at' | 'key'>): boolean
  replaceAll(lists: LocalPlaylist[], favs: FavPlaylist[]): void
}

const PlaylistsCtx = createContext<Ctx | null>(null)

const newId = () => `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

export function PlaylistsProvider({ children }: { children: ReactNode }) {
  const [lists, setLists] = useState<LocalPlaylist[]>([])
  const [favs, setFavs] = useState<FavPlaylist[]>([])
  const [ready, setReady] = useState(false)
  /** 首次读取完成前不许写盘，否则空数组会把存档覆盖掉 */
  const dirty = useRef(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [ls, fs] = await Promise.all([
          settings.get<LocalPlaylist[]>(KEYS.localPlaylists),
          settings.get<FavPlaylist[]>(KEYS.favPlaylists),
        ])
        if (!alive) return
        if (Array.isArray(ls)) setLists(ls.filter(x => x && typeof x.id === 'string'))
        if (Array.isArray(fs)) setFavs(fs.filter(x => x && typeof x.key === 'string'))
      } catch { /* 存档坏了就当空歌单，不能拦住启动 */ }
      if (alive) setReady(true)
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!ready || !dirty.current) return
    void settings.set(KEYS.localPlaylists, lists)
  }, [lists, ready])

  useEffect(() => {
    if (!ready || !dirty.current) return
    void settings.set(KEYS.favPlaylists, favs)
  }, [favs, ready])

  const create = useCallback<Ctx['create']>((name, opts) => {
    const now = Date.now()
    const pl: LocalPlaylist = {
      id: newId(),
      name: (name || '').trim() || '未命名歌单',
      note: opts?.note?.trim() || undefined,
      trackIds: Array.from(new Set(opts?.trackIds ?? [])),
      missing: opts?.missing?.length ? opts.missing : undefined,
      origin: opts?.origin ?? 'manual',
      originName: opts?.originName,
      createdAt: now,
      updatedAt: now,
    }
    dirty.current = true
    setLists(prev => [pl, ...prev])
    return pl
  }, [])

  const rename = useCallback((id: string, name: string) => {
    const n = name.trim()
    if (!n) return
    dirty.current = true
    setLists(prev => prev.map(x => (x.id === id ? { ...x, name: n, updatedAt: Date.now() } : x)))
  }, [])

  const remove = useCallback((id: string) => {
    dirty.current = true
    setLists(prev => prev.filter(x => x.id !== id))
  }, [])

  /**
   * 拖动排序：把第 from 个挪到第 to 个。
   *
   * 数组顺序就是首页的展示顺序（`lists` 原样渲染），所以这里只动数组，
   * 不需要额外的 order 字段——少一份状态就少一处能不一致的地方。
   */
  const reorder = useCallback((from: number, to: number) => {
    if (from === to) return
    dirty.current = true
    setLists(prev => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const arr = [...prev]
      const [item] = arr.splice(from, 1)
      arr.splice(to, 0, item)
      return arr
    })
  }, [])

  const moveFav = useCallback((from: number, to: number) => {
    if (from === to) return
    dirty.current = true
    setFavs(prev => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const arr = [...prev]
      const [item] = arr.splice(from, 1)
      arr.splice(to, 0, item)
      return arr
    })
  }, [])

  const addTracks = useCallback((id: string, ids: string[]) => {
    let added = 0
    dirty.current = true
    setLists(prev => prev.map(x => {
      if (x.id !== id) return x
      const have = new Set(x.trackIds)
      const next = [...x.trackIds]
      for (const t of ids) {
        if (have.has(t)) continue
        have.add(t)
        next.push(t)
        added++
      }
      return added ? { ...x, trackIds: next, updatedAt: Date.now() } : x
    }))
    return added
  }, [])

  const removeTrack = useCallback((id: string, trackId: string) => {
    dirty.current = true
    setLists(prev => prev.map(x =>
      x.id === id ? { ...x, trackIds: x.trackIds.filter(t => t !== trackId), updatedAt: Date.now() } : x))
  }, [])

  const moveTrack = useCallback((id: string, from: number, to: number) => {
    dirty.current = true
    setLists(prev => prev.map(x => {
      if (x.id !== id) return x
      const arr = [...x.trackIds]
      if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return x
      const [item] = arr.splice(from, 1)
      arr.splice(to, 0, item)
      return { ...x, trackIds: arr, updatedAt: Date.now() }
    }))
  }, [])

  const index = useMemo(() => new Map(lists.map(l => [l.id, l])), [lists])

  const tracksOf = useCallback<Ctx['tracksOf']>((list, library) => {
    const byId = new Map(library.map(t => [t.id, t]))
    return list.trackIds
      // 曲库里查不到时再看在线曲目注册表：从平台歌单「加入歌单」进来的曲子
      // 不在曲库（没有本地文件），只有注册表认得它，否则整条会被静默吃掉
      .map(id => byId.get(id) ?? trackOfId(id))
      .filter((t): t is LocalTrack => Boolean(t))
  }, [])

  const isFav = useCallback((source: PlatformSource, pid: string) => {
    const k = `${source}:${pid}`
    return favs.some(f => f.key === k)
  }, [favs])

  const toggleFav = useCallback<Ctx['toggleFav']>(p => {
    const k = `${p.source}:${p.id}`
    const existed = favs.some(f => f.key === k)
    dirty.current = true
    setFavs(prev => (existed
      ? prev.filter(f => f.key !== k)
      : [{ ...p, key: k, at: Date.now() }, ...prev]))
    return !existed
  }, [favs])

  const replaceAll = useCallback<Ctx['replaceAll']>((nextLists, nextFavs) => {
    dirty.current = true
    setLists(nextLists)
    setFavs(nextFavs)
  }, [])

  const value = useMemo<Ctx>(() => ({
    ready, lists, favs, create, rename, remove, reorder, moveFav, addTracks, removeTrack, moveTrack,
    tracksOf, isFav, toggleFav, replaceAll,
  }), [ready, lists, favs, create, rename, remove, reorder, moveFav, addTracks, removeTrack, moveTrack, tracksOf, isFav, toggleFav, replaceAll, index])

  return <PlaylistsCtx.Provider value={value}>{children}</PlaylistsCtx.Provider>
}

export function usePlaylists(): Ctx {
  const c = useContext(PlaylistsCtx)
  if (!c) throw new Error('usePlaylists 必须在 PlaylistsProvider 内使用')
  return c
}

/** 歌单封面用的四宫格：取前四首有封面的曲目 */
export function mosaicOf(tracks: LocalTrack[], max = 4): string[] {
  const out: string[] = []
  for (const t of tracks) {
    /*
     * 必须过 coverUrlOf：本地曲目的 cover 是**磁盘绝对路径**，
     * 直接塞进 <img src> 会被当成相对地址，四格拼图全裂
     * （歌单卡片和「本地音乐」横条都栽在这上面过）。
     */
    const url = coverUrlOf(t.cover)
    if (!url) continue
    out.push(url)
    if (out.length >= max) break
  }
  return out
}
