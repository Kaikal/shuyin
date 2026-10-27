/**
 * Worker 启动脚本（纯字符串生成，**不 import 任何东西**）。
 *
 * 单独一个文件的原因：它要能在 Node 里被直接编译出来做无浏览器的联调，
 * 一旦掺进 `@tauri-apps/api` 之类的运行时依赖就跑不动了。
 *
 * 注入的 `__SHUYIN_SCRIPT__` 是 `JSON.stringify(脚本体)`：
 * 用「间接 eval」在全局作用域执行，与洛雪宿主的行为一致（脚本依赖顶层声明可见）。
 */
export function buildWorkerSource(rawScript: string): string {
  const literal = JSON.stringify(rawScript)
    // U+2028 / U+2029 在旧引擎里会截断字符串字面量
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

  return `(function () {
  var handlers = []
  var pending = new Map()
  var seq = 0

  function post(m) { self.postMessage(m) }

  function fmt(args) {
    return Array.prototype.map.call(args, function (a) {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.message
      try { return JSON.stringify(a) } catch (e) { return String(a) }
    }).join(' ')
  }

  // 脚本自己打的日志转给主线程，音源管理页可见
  self.console = {
    log: function () { post({ type: 'log', text: fmt(arguments) }) },
    info: function () { post({ type: 'log', text: fmt(arguments) }) },
    warn: function () { post({ type: 'log', text: fmt(arguments) }) },
    error: function () { post({ type: 'log', text: fmt(arguments) }) },
    debug: function () { post({ type: 'log', text: fmt(arguments) }) },
    trace: function () { post({ type: 'log', text: fmt(arguments) }) }
  }

  function settle(id, err, response) {
    var cb = pending.get(id)
    pending.delete(id)
    if (typeof cb === 'function') cb(err, response)
  }

  self.lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    env: { lang: 'zh_cn', version: '2.9.1' },
    version: '2.9.1',
    currentScriptInfo: { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' },
    on: function (name, fn) {
      if (name === 'request' && typeof fn === 'function') handlers.push(fn)
    },
    send: function (name, data) {
      if (name === 'inited') post({ type: 'inited', payload: data })
    },
    request: function (url, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      var o = opts || {}
      var id = ++seq
      pending.set(id, cb)
      post({
        type: 'http',
        id: id,
        url: String(url),
        options: { method: o.method || 'GET', headers: o.headers || {}, body: o.body, timeout: o.timeout }
      })
      setTimeout(function () { settle(id, new Error('请求超时')) }, 14000)
    },
    utils: { crypto: {}, buffer: {} }
  }

  self.addEventListener('message', function (ev) {
    var m = ev.data || {}
    if (m.type === 'http-res') {
      settle(m.id, m.error ? new Error(m.error) : null, m.response)
      return
    }
    if (m.type === 'call') {
      if (!handlers.length) {
        post({ type: 'call-res', id: m.id, ok: false, error: '该音源没有注册 request 处理器' })
        return
      }
      // 处理器可能返回 Promise（K×H / 长青都是），统一兜一层
      Promise.resolve()
        .then(function () { return handlers[0](m.payload) })
        .then(function (v) {
          post({ type: 'call-res', id: m.id, ok: true, value: typeof v === 'string' ? v : (v == null ? '' : String(v)) })
        })
        .catch(function (e) {
          post({ type: 'call-res', id: m.id, ok: false, error: (e && e.message) || String(e) })
        })
    }
  })

  try {
    ;(0, eval)(${literal})
  } catch (e) {
    post({ type: 'error', message: (e && e.message) || String(e) })
  }
})()`
}
