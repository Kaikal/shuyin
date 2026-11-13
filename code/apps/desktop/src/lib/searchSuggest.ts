/**
 * 搜索联想（输入框下面那个下拉）。
 *
 * 为什么不用「搜索建议」接口：四家都没有开放的关键词补全接口（那是站内
 * 搜索框的私有服务，要 app 签名才认）。所以这里用**搜索接口本身**取前几首，
 * 把歌名和歌手名当成联想词——点一首就等于拿它去搜，点了一定有结果。
 *
 * 三条约束（都是流量/手感换来的）：
 *   · `LIMIT = 6`：联想只要够点，别每次敲字都拉 30 首；
 *   · `WAIT = 200ms` 防抖 + `TTL` 缓存：删一个字再打回来不该重发一遍；
 *   · 历史命中**立刻**显示，网络的回来再合并——联想面板空着 300ms 会被当成卡了。
 */
import type { PlatformSource, SearchSong } from '@shuyin/lx-provider'
import { useEffect, useState } from 'react'
import { apiFor } from './online'

export type SuggestKind = 'history' | 'song' | 'singer'

export interface Suggest {
  /** React key：同一段文字可能同时以「歌名」和「历史」出现，所以带 kind */
  key: string
  text: string
  kind: SuggestKind
  /** 副标题：歌曲给歌手名 */
  sub?: string
  source?: PlatformSource
}

/** 每家取几首（6 首里通常能凑出 1~2 个歌手名，够用了） */
const LIMIT = 6
/** 面板里最多几条：再长就盖住下面的结果了 */
const SHOW = 8
/** 停手多久才发请求 */
const WAIT = 200
/** 同一个词 10 分钟内不再请求（打字快的人来回改字很常见） */
const TTL = 10 * 60_000

const CACHE = new Map<string, { at: number; songs: SearchSong[] }>()

/** 问一家要几首；失败/不支持都当成「这家没有」，不往上抛 */
async function askSource(source: PlatformSource, q: string): Promise<SearchSong[]> {
  const ck = `${source}:${q}`
  const hit = CACHE.get(ck)
  if (hit && Date.now() - hit.at < TTL) return hit.songs
  const api = apiFor(source)
  if (!api?.supportsSearch) return []
  try {
    const r = await api.search(q, 1, LIMIT)
    /* 简单封顶，别让它变成第二个内存泄漏源 */
    if (CACHE.size > 240) CACHE.clear()
    CACHE.set(ck, { at: Date.now(), songs: r.list })
    return r.list
  } catch {
    return []
  }
}

/** 历史里能匹配上的，立刻给（不等网络） */
function fromHistory(q: string, history: string[]): Suggest[] {
  const lower = q.toLowerCase()
  return history
    .filter(h => h && h.toLowerCase() !== lower && h.toLowerCase().includes(lower))
    .slice(0, 3)
    .map(h => ({ key: 'history:' + h, text: h, kind: 'history' as const }))
}

function build(q: string, history: string[], rows: Array<{ source: PlatformSource; songs: SearchSong[] }>): Suggest[] {
  const out: Suggest[] = []
  const seen = new Set<string>()
  const add = (it: Suggest) => {
    const k = it.kind === 'history' ? 'h:' + it.text.toLowerCase() : 'n:' + it.text.toLowerCase()
    if (!it.text || seen.has(k)) return
    seen.add(k)
    out.push(it)
  }

  fromHistory(q, history).forEach(add)
  for (const r of rows) {
    for (const sg of r.songs) {
      add({ key: `song:${r.source}:${sg.id}`, text: sg.name, kind: 'song', sub: sg.singer.join(' / '), source: r.source })
    }
  }
  /* 歌手名单独成条：想搜「周杰伦」的人不会去打他某首歌的歌名 */
  for (const r of rows) {
    for (const sg of r.songs) {
      for (const name of sg.singer) add({ key: `singer:${name}`, text: name, kind: 'singer', source: r.source })
    }
  }

  const lower = q.toLowerCase()
  const kindRank: Record<SuggestKind, number> = { history: 0, song: 1, singer: 2 }
  return out
    /* 「和输入完全一致」的那条没意义——面板最后本来就有一行「搜索『q』」 */
    .filter(it => it.text.trim().toLowerCase() !== lower)
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const sa = a.it.text.toLowerCase().startsWith(lower) ? 0 : 1
      const sb = b.it.text.toLowerCase().startsWith(lower) ? 0 : 1
      return sa - sb || kindRank[a.it.kind] - kindRank[b.it.kind] || a.i - b.i
    })
    .slice(0, SHOW)
    .map(x => x.it)
}

/**
 * 联想列表。
 *
 * `enabled` 由调用方控制（通常是「输入框有焦点且非空」）——面板关着的时候
 * 不该继续为敲进去的字打请求。
 */
export function useSearchSuggest(
  query: string,
  platforms: PlatformSource[],
  enabled: boolean,
  history: string[],
): { items: Suggest[]; loading: boolean } {
  const [items, setItems] = useState<Suggest[]>([])
  const [loading, setLoading] = useState(false)
  const pKey = platforms.join(',')
  const hKey = history.join('|')

  useEffect(() => {
    const q = query.trim()
    if (!enabled || !q) { setItems([]); setLoading(false); return }
    let dead = false
    /* 先上历史命中：这段不需要网络，晚 200ms 出现就是白等 */
    setItems(fromHistory(q, history))
    setLoading(true)
    const t = window.setTimeout(() => {
      void Promise.all(platforms.map(async s => ({ source: s, songs: await askSource(s, q) })))
        .then(rows => {
          if (dead) return
          setItems(build(q, history, rows))
          setLoading(false)
        })
    }, WAIT)
    return () => { dead = true; window.clearTimeout(t) }
    // platforms / history 只通过签名参与，对象本身每次渲染都是新引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pKey, enabled, hKey])

  return { items, loading }
}
