/**
 * 轻量诊断：把关键启动事件与未捕获异常写进日志文件，
 * 便于「白屏/闪退」这类无法在界面上描述的问题定位。
 *
 * 日志位置：%LOCALAPPDATA%\cn.shuyin.player\app.log（超过 256KB 自动重写）
 * 前端不依赖 @tauri-apps/api 的初始化顺序——直接走 __TAURI_INTERNALS__，
 * 这样即使打包异常、模块没加载完，也能把原因写下来。
 */

type Payload = Record<string, unknown> | string | undefined

interface Internals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
}

function internals(): Internals | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: Internals }
  return w.__TAURI_INTERNALS__ ?? null
}

export function diag(event: string, data?: Payload): void {
  let detail = ''
  if (typeof data === 'string') detail = data
  else if (data) {
    try { detail = JSON.stringify(data) } catch { detail = String(data) }
  }
  // 控制台留一份，方便开发时直接看
  if (detail) console.warn('[diag]', event, detail)
  else console.warn('[diag]', event)

  const t = internals()
  if (!t) return
  try {
    void t.invoke('diag_log', { event, detail }).catch(() => { /* 日志失败不影响主流程 */ })
  } catch {
    /* ignore */
  }
}

let installed = false

/** 装上全局错误钩子：把白屏的真正原因留下来 */
export function installGlobalDiagnostics(): void {
  if (installed) return
  installed = true
  diag('boot.js', { href: location.href, ua: navigator.userAgent.slice(0, 120) })

  window.addEventListener('error', e => {
    diag('js.error', {
      message: e.message,
      file: (e.filename || '').split('/').pop(),
      line: e.lineno,
      col: e.colno,
      stack: (e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 4).join(' | ') : ''),
    })
  })

  window.addEventListener('unhandledrejection', e => {
    const r = e.reason as { message?: string; stack?: string } | undefined
    diag('js.rejection', {
      message: r?.message ?? String(e.reason),
      stack: r?.stack ? String(r.stack).split('\n').slice(0, 4).join(' | ') : '',
    })
  })

  // 3 秒后回报一次「画出来了吗」：白屏问题看这一行就能分辨是渲染层还是运行时
  window.setTimeout(() => {
    const root = document.getElementById('root')
    const rect = root?.getBoundingClientRect()
    const text = (root?.innerText || '').replace(/\s+/g, ' ').trim()
    diag('paint.check', {
      children: root ? root.childElementCount : -1,
      w: rect ? Math.round(rect.width) : 0,
      h: rect ? Math.round(rect.height) : 0,
      text: text.slice(0, 28),
    })

    // 真的画出内容了才回心跳：后端据此判断要不要走软件渲染重试
    if (root && (root.childElementCount > 0 || text.length > 0)) {
      const t = internals()
      try {
        void t?.invoke('boot_ok').catch(() => { /* ignore */ })
      } catch {
        /* ignore */
      }
    }
  }, 3000)
}
