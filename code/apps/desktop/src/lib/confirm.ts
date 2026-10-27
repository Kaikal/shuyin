/**
 * 应用内确认框（替代 `window.confirm`）。
 *
 * 为什么必须换掉原生的：Tauri 的 WebView2 弹的是**系统对话框**——白底、英文
 * OK / Cancel、和深色主题与应用字体完全不搭，在安卓壳里更糟（出现的是
 * WebView 自己的灰框，按钮还可能被系统字体放大顶出屏幕）。
 *
 * 用法和 `window.confirm` 一样直白，只是要 await：
 *
 *   if (!(await confirm({ title: '删除歌单？', message: '只删歌单，歌还在' }))) return
 *
 * 宿主组件 `<ConfirmHost/>` 挂在 App 根部一次即可；同时来两个请求会排队。
 */

export interface ConfirmOptions {
  title: string
  /** 正文，允许 `\n` 换行 */
  message?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作（删除 / 清空）：确认按钮用警示色 */
  danger?: boolean
}

export interface ConfirmRequest extends ConfirmOptions {
  id: number
  resolve(ok: boolean): void
}

let queue: ConfirmRequest[] = []
const subs = new Set<(q: ConfirmRequest[]) => void>()
let nextId = 1

const emit = () => { for (const fn of subs) fn(queue) }

/** 弹一个确认框，等用户点。点遮罩 / Esc / 取消都算 false */
export function confirm(opts: ConfirmOptions | string): Promise<boolean> {
  const o: ConfirmOptions = typeof opts === 'string' ? { title: opts } : opts
  return new Promise<boolean>(resolve => {
    queue = [...queue, { ...o, id: nextId++, resolve }]
    emit()
  })
}

export function subscribeConfirm(fn: (q: ConfirmRequest[]) => void): () => void {
  subs.add(fn)
  fn(queue)
  return () => { subs.delete(fn) }
}

/** 收尾：把这一条从队列里拿掉并回结果（宿主组件调用） */
export function settleConfirm(id: number, ok: boolean) {
  const req = queue.find(r => r.id === id)
  if (!req) return
  queue = queue.filter(r => r.id !== id)
  emit()
  req.resolve(ok)
}
