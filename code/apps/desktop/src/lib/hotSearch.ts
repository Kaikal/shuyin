/**
 * 各平台「热搜」——搜索页空态里那一块。
 *
 * 为什么不是真的热搜词：四家平台都没有开放的「热搜关键词」接口（那是站内
 * 运营位，只在自家 App 里下发）。能稳定拿到的是**榜单**，所以这里取各平台
 * 热歌榜前 N 首的**歌名**当关键词——点一下就是拿这首歌去搜。
 *
 * 这么选的两个好处：
 *   · 点下去一定有结果（热搜词里常有活动词、明星名，搜出来是空的）；
 *   · 和「大家正在听什么」是同一件事，比运营位更接近用户想搜的东西。
 *
 * 缓存按天：榜单一天变几次但没必要每次都拉（四家 = 8 个请求），
 * 隔天自动重取；同一台机器上切换平台勾选不会重复请求。
 */
import type { PlatformSource, RankListItem } from '@shuyin/lx-provider'
import { useEffect, useState } from 'react'
import { apiFor } from './online'
import { KEYS, settings } from './settings'

/**
 * 一家给几个词。
 *
 * 8 个是量出来的：四家 × 8 个，手机上每家两行出头，四条正好铺满一屏空态；
 * 给 10 个就得多半行，而这一块再长也无非是「多列几个热歌」。
 */
const COUNT = 8

/**
 * 榜单名的偏好顺序。
 *
 * 四家的榜单列表里有十几个到几十个（飙升榜 / 新歌榜 / 原创榜 / 各种分区榜），
 * 「热歌榜」最接近「热搜」，没有就退到飙升榜。名字匹配用 includes 是因为
 * 各家常带后缀（「热歌榜」「酷狗热歌榜」「TOP500」）。
 */
const PREFER = ['热歌榜', 'TOP500', '飙升榜', '热歌', '新歌榜', '热门']

function pickRank(list: RankListItem[]): RankListItem | undefined {
  for (const k of PREFER) {
    const hit = list.find(r => r.name.replace(/\s/g, '').toUpperCase().includes(k.toUpperCase()))
    if (hit) return hit
  }
  return list[0]
}

/** 本地日期（按用户所在的时区，不是 UTC） */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

interface Cache {
  day: string
  data: Partial<Record<PlatformSource, string[]>>
}

/** 内存这一层是必须的：搜索页每次进出都会重新挂载，没有它就要重拉一遍。
 *  带 day 是为了长期挂着的桌面端——不然过了零点还在用昨天的词。 */
const MEM = new Map<PlatformSource, { day: string; words: string[] }>()
let cache: Cache | null = null

async function readCache(): Promise<Cache> {
  if (cache) return cache
  const raw = await settings.get<Cache>(KEYS.searchHotWords).catch(() => null)
  cache = raw && raw.day === today() && raw.data ? raw : { day: today(), data: {} }
  return cache
}

/** 某一个平台的热搜词；拿不到就返回空数组（调用方自己决定要不要显示这一行） */
export async function hotWordsOf(source: PlatformSource): Promise<string[]> {
  const day = today()
  const mem = MEM.get(source)
  if (mem && mem.day === day) return mem.words

  const c = await readCache()
  const saved = c.data[source]
  if (saved?.length) {
    MEM.set(source, { day, words: saved })
    return saved
  }

  const api = apiFor(source)
  if (!api?.getRanklists || !api.getPlaylistDetail) return []

  /* 网络这层重试一次：热搜在冷启动 / 弱网的第一次请求最容易挂（DNS 未就绪、
   * 链路刚唤醒），挂了当天 localStorage 里就一直没有这家，用户看到的永远是
   * 「三家有、酷狗没有」。重试只花几百毫秒，换来的是四家稳定到齐。 */
  const tryOnce = async () => {
    const ranks = await api.getRanklists!()
    const rank = pickRank(ranks.list)
    if (!rank) throw new Error('没有可用榜单')
    const d = await api.getPlaylistDetail!(rank.id, 1, COUNT)
    const words = d.songs.map(s => s.name.trim()).filter(Boolean)
    if (!words.length) throw new Error('榜单详情为空')
    return words
  }
  let words: string[]
  try {
    words = await tryOnce()
  } catch {
    words = await tryOnce()
  }

  MEM.set(source, { day, words })
  c.data[source] = words
  void settings.set(KEYS.searchHotWords, c).catch(() => {})
  return words
}

export interface HotGroup {
  source: PlatformSource
  words: string[]
}

/**
 * 按当前勾选的平台拿热搜。
 *
 * 平台全失败就返回空列表（页面保持原样，不做「暂无热搜」这种空壳提示——
 * 那只是把一块空白换成一行字）。
 */
export function useHotWords(platforms: PlatformSource[]): { groups: HotGroup[]; loading: boolean } {
  const key = platforms.join(',')
  const [groups, setGroups] = useState<HotGroup[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const list = (key ? key.split(',') : []) as PlatformSource[]
    if (!list.length) { setGroups([]); setLoading(false); return }
    let dead = false
    setLoading(true)
    void Promise.all(list.map(async (s): Promise<HotGroup | null> => {
      try {
        return { source: s, words: await hotWordsOf(s) }
      } catch {
        /* 单家抽风（限流 / 榜单结构变了）就当这家没有热搜，不影响别家 */
        return null
      }
    })).then(res => {
      if (dead) return
      setGroups(res.filter((x): x is HotGroup => !!x && x.words.length > 0))
      setLoading(false)
    })
    return () => { dead = true }
  }, [key])

  return { groups, loading }
}
