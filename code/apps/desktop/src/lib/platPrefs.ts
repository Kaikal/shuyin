/**
 * 平台歌单的**本地**偏好：藏起来哪些、按什么顺序摆。
 *
 * 为什么是「本地隐藏」而不是「去平台上删掉」：
 * 四家里没有一家提供「删除我建的歌单」的第三方接口（酷狗的云歌单连读都要 App
 * token，写更不可能）。用户也说了「原平台移除不了可以不做」——所以这里只解决
 * 「它别再占着我的首页」，平台上那份原封不动，用户在官方 App 里还能看到。
 *
 * 三条约定，少一条就会出「移除不掉」或「移除了又回来」：
 *   · 隐藏是**持久**的：刷新会重新拉平台歌单，但拉回来还会过一遍这张表；
 *   · 平台那边真删掉了的，刷新时顺手从表里清掉，免得恢复列表越积越脏；
 *   · 顺序也是持久化的：平台返回的顺序是它自己排的（按更新时间），
 *     用户拖过之后就该听用户的。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { KEYS, settings } from './settings'

export interface PlatPrefs {
  /** `${source}:${id}` —— 不在首页显示的平台歌单 */
  hidden: string[]
  /** `${source}:${id}` 的展示顺序；表里没有的排在后面，保持平台返回的相对顺序 */
  order: string[]
  /**
   * 首页「我的歌单」里各**分组**的上下顺序。
   *
   * 元素是 `'local'`（本地那组）或平台 source（`'wy'` / `'tx'` …）。
   * 和 `order` 分开存：一个是卡在组内的位置，一个是组与组之间的位置，
   * 合成一张表的话，「把 QQ 拖到网易云前面」和「把 QQ 某张歌单拖到第一」
   * 会互相覆盖。
   */
  srcOrder: string[]
}

const EMPTY: PlatPrefs = { hidden: [], order: [], srcOrder: [] }

/** 平台歌单的稳定键。平台 id 只在各自平台内唯一，必须带 source */
export function platKey(source: string, id: string): string {
  return `${source}:${id}`
}

export interface PlatPrefsApi {
  hidden: Set<string>
  /** 按用户拖过的顺序排；没排过的保持原序跟在后面 */
  arrange<T extends { source: string; id: string }>(items: T[]): T[]
  hide(key: string): void
  unhide(key: string): void
  /** 某一家平台的新顺序：只替换这个平台的，别家的顺序保持原样 */
  setOrder(source: string, keys: string[]): void
  /**
   * 平台那边已经不存在了的键，从两张表里一起清掉。
   *
   * 必须**按平台**清理：调用方只有在那家的拉取成功时才知道它有哪些歌单。
   * 一次传全部平台的键是不行的——某家拉取失败时，它的歌单会被当成「已删除」
   * 从隐藏表里抹掉，用户下次刷新就看见那些歌单全回来了。
   */
  prune(source: string, liveKeys: string[]): void
  /** 分组（本地 / 各平台）的上下顺序：整表覆盖，只由「拖分组」这一个动作写 */
  arrangeSources<T extends string>(groups: T[]): T[]
  setSrcOrder(groups: string[]): void
}

export function usePlatPrefs(): PlatPrefsApi {
  const [prefs, setPrefs] = useState<PlatPrefs>(EMPTY)

  useEffect(() => {
    let alive = true
    void settings.get<PlatPrefs>(KEYS.platPrefs).then(v => {
      if (!alive || !v) return
      setPrefs({
        hidden: Array.isArray(v.hidden) ? v.hidden.filter(x => typeof x === 'string') : [],
        order: Array.isArray(v.order) ? v.order.filter(x => typeof x === 'string') : [],
        srcOrder: Array.isArray(v.srcOrder) ? v.srcOrder.filter(x => typeof x === 'string') : [],
      })
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const commit = useCallback((next: PlatPrefs) => {
    setPrefs(next)
    void settings.set(KEYS.platPrefs, next).catch(() => {})
  }, [])

  const hidden = useMemo(() => new Set(prefs.hidden), [prefs.hidden])

  const arrange = useCallback(<T extends { source: string; id: string }>(items: T[]): T[] => {
    if (!prefs.order.length) return items
    const rank = new Map(prefs.order.map((k, i) => [k, i]))
    // 排过的按 rank，没排过的保持原序沉到后面
    return [...items].sort((a, b) => {
      const ra = rank.get(platKey(a.source, a.id))
      const rb = rank.get(platKey(b.source, b.id))
      if (ra == null && rb == null) return 0
      if (ra == null) return 1
      if (rb == null) return -1
      return ra - rb
    })
  }, [prefs.order])

  const hide = useCallback((key: string) => {
    commit({
      hidden: prefs.hidden.includes(key) ? prefs.hidden : [...prefs.hidden, key],
      order: prefs.order,
      srcOrder: prefs.srcOrder,
    })
  }, [prefs, commit])

  const unhide = useCallback((key: string) => {
    commit({ hidden: prefs.hidden.filter(k => k !== key), order: prefs.order, srcOrder: prefs.srcOrder })
  }, [prefs, commit])

  const setOrder = useCallback((source: string, keys: string[]) => {
    /*
     * 只替换自己那一段。
     *
     * 早先的写法是「整表覆盖」——拖一下酷狗，网易云的顺序就没了（变成平台原序）。
     * 用户根本看不出来发生了什么，只会觉得「我排好的又乱了」。
     * 前缀保留、本前缀整段换掉，其它平台一个字节都不动。
     */
    const prefix = source + ':'
    const other = prefs.order.filter(k => !k.startsWith(prefix))
    commit({ hidden: prefs.hidden, order: [...other, ...keys], srcOrder: prefs.srcOrder })
  }, [prefs, commit])

  const prune = useCallback((source: string, liveKeys: string[]) => {
    const prefix = source + ':'
    const live = new Set(liveKeys)
    const own = (k: string) => k.startsWith(prefix)
    const hidden2 = prefs.hidden.filter(k => !own(k) || live.has(k))
    const order2 = prefs.order.filter(k => !own(k) || live.has(k))
    if (hidden2.length === prefs.hidden.length && order2.length === prefs.order.length) return
    commit({ hidden: hidden2, order: order2, srcOrder: prefs.srcOrder })
  }, [prefs, commit])

  /**
   * 分组顺序：排过的按存下来的顺序，没排过的沉到后面保持原序。
   *
   * 和 `arrange` 同一套规则——新登录一个平台、它那组是「没排过的」，
   * 会跟在用户排好的后面，而不是插到中间把顺序打乱。
   */
  const arrangeSources = useCallback(<T extends string>(groups: T[]): T[] => {
    if (!prefs.srcOrder.length) return groups
    const rank = new Map(prefs.srcOrder.map((k, i) => [k, i]))
    return [...groups].sort((a, b) => {
      const ra = rank.get(a)
      const rb = rank.get(b)
      if (ra == null && rb == null) return 0
      if (ra == null) return 1
      if (rb == null) return -1
      return ra - rb
    })
  }, [prefs.srcOrder])

  const setSrcOrder = useCallback((groups: string[]) => {
    commit({ hidden: prefs.hidden, order: prefs.order, srcOrder: groups })
  }, [prefs, commit])

  return { hidden, arrange, hide, unhide, setOrder, prune, arrangeSources, setSrcOrder }
}
