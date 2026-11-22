/**
 * 「其他应用打开」送进来的**歌单文件**在这里中转一次。
 *
 * 为什么不直接导：
 * - 导入要落到「我的」页（歌单在那儿建），可文件可能是应用还没起来、
 *   或者用户正停在播放页时送进来的 —— 收到的一方（App）没有歌单 store 的写入权。
 * - 真正做导入的 HomePage 可能还没挂载。先把它存成 pending，
 *   等 HomePage 注册监听时立刻补发，不丢。
 *
 * 音源脚本不走这里：那个流程要用户确认（别人的文件不该悄悄改配置），
 * 在 App 里直接弹框（见 App.tsx 的 open-file）。
 */

export interface IncomingPlaylist {
  /** 原生给的地址：iOS 是 `file://`、安卓是 `content://`、桌面是普通路径 */
  path: string
  /** 原始文件名（带后缀）。百分比编码已经在原生侧解掉了 */
  name: string
}

type Handler = (f: IncomingPlaylist) => void

let handler: Handler | null = null
let pending: IncomingPlaylist | null = null

/** 收到文件：有人接就直接给，没人接先存着 */
export function pushIncomingPlaylist(f: IncomingPlaylist) {
  if (handler) handler(f)
  else pending = f
}

/** HomePage 注册消费方；注册当时若有积压，立刻补发一次 */
export function onIncomingPlaylist(fn: Handler): () => void {
  handler = fn
  if (pending) {
    const f = pending
    pending = null
    fn(f)
  }
  return () => {
    if (handler === fn) handler = null
  }
}

/** 这个文件名像不像歌单（音源脚本 .js 归另一条路） */
export function isPlaylistFile(name: string): boolean {
  return /\.(lxmc|json|txt|csv|m3u8?|pls)$/i.test(name)
}

/** 这个文件名像不像音源脚本 */
export function isSourceScript(name: string): boolean {
  return /\.(js|mjs)$/i.test(name)
}
