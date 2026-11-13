/**
 * 触摸手势的「独占锁」—— 这一次触摸归谁。
 *
 * 手机上有两套横滑手势会同时抢同一根手指：
 *   · 页面左右切页（`lib/pageSwipe`，window 捕获阶段监听 touch）；
 *   · 歌单网格的长按拖动（`SortableGrid`，window 上监听 pointer / touch）。
 *
 * 两边都以为自己独占了这根手指，于是长按把卡片拿起来一拖，**页面也跟着横滑**；
 * 用户看到的是「卡片在拖、整页在溜」（2026-11-11 反馈）。
 * 谁也没法从事件里看出对方的存在，只能显式协商：长按到点的那一刹那，
 * 排序把锁拿走，横滑那一套整段让开。
 *
 * 为什么用模块级变量而不是 `<html>` 上的属性：
 * 写 `<html>` 任何一个属性都会触发整棵树重算样式（真机实测 26~36ms），
 * 正好卡在「拿起来」那一帧上，手感直接就废了。
 */

/** 当前独占手指的一方（null = 没人占用） */
let owner: string | null = null
/** 拿走的那一刻。手势万一没收到收尾事件（WebView 被切走、手指抬到窗口外），锁不能永久占着 */
let takenAt = 0

/**
 * 锁的保鲜期。
 *
 * 正常一次拖动最多几秒。超过这个时长还挂着，说明收尾事件丢了（后台切回、
 * 手指在系统手势区抬起……）。这时候必须自动放锁，否则**整个 App 再也切不了页**，
 * 而用户完全不知道为什么。
 */
const STALE_MS = 15000

/** 拿走这根手指。后拿的覆盖先拿的：手势总是「最新的那个意图」算数 */
export function grabGesture(id: string) {
  owner = id
  takenAt = Date.now()
}

/** 释放（只有持有者自己释放才生效，避免 A 被 B 的收尾误放） */
export function releaseGesture(id: string) {
  if (owner === id) { owner = null; takenAt = 0 }
}

/** 这根手指已经被别人接管了吗？ */
export function isGestureTaken(): boolean {
  if (owner === null) return false
  if (Date.now() - takenAt > STALE_MS) { owner = null; takenAt = 0; return false }
  return true
}
