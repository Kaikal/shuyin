/**
 * 全局轻提示（顶部居中，几秒后自己消失）。
 *
 * 为什么要有这一层：以前提示是散在各处的一行行内文字——设置页底部的红字、
 * 「我的」标题下面那条、曲库页的浮条……同一句「已保存」有三套长相，
 * 而且行内红字会把下面的内容顶下去，用户点完按钮页面蹦一下。
 *
 * 现在统一成：**不占布局**、出现在视线中上方、2~6 秒自己走。
 * 错误给 6 秒（要读完），成功给 2.6 秒（扫一眼就够）。
 */

export interface ToastItem {
  id: number
  text: string
  bad?: boolean
  ok?: boolean
}

type Listener = (list: ToastItem[]) => void

/** 最多同时显示 3 条，再多就把最老的挤掉——提示条不该糊一屏 */
const MAX = 3

let seq = 0
let items: ToastItem[] = []
const listeners = new Set<Listener>()
const timers = new Map<number, number>()

function emit() {
  const snapshot = items.slice()
  for (const fn of listeners) fn(snapshot)
}

function schedule(id: number, ms: number) {
  const old = timers.get(id)
  if (old) window.clearTimeout(old)
  timers.set(id, window.setTimeout(() => dismissToast(id), ms))
}

export function toast(text: string, opt: { bad?: boolean; ok?: boolean; ms?: number } = {}) {
  const t = (text ?? '').toString().trim()
  if (!t) return
  // 同一句话连点两下（比如「已复制」）不该叠两条，续命就好
  const same = items.find(x => x.text === t && !!x.bad === !!opt.bad)
  if (same) {
    schedule(same.id, opt.ms ?? (opt.bad ? 6000 : 2600))
    return
  }
  const item: ToastItem = { id: ++seq, text: t, bad: opt.bad, ok: opt.ok }
  items = [...items, item].slice(-MAX)
  emit()
  schedule(item.id, opt.ms ?? (opt.bad ? 6000 : 2400))
}

export function dismissToast(id: number) {
  const t = timers.get(id)
  if (t) {
    window.clearTimeout(t)
    timers.delete(id)
  }
  const next = items.filter(x => x.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn)
  fn(items.slice())
  return () => { listeners.delete(fn) }
}
