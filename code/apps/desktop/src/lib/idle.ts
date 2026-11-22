/**
 * 「用户此刻正在操作」的全局信号。
 *
 * 用来给**后台活儿让路**：预加载取链、整曲落盘、缓存校验这类事情本身不着急，
 * 可它们会和「手指在屏幕上滑列表」抢同一批东西（网络连接、原生线程、JS 主线程
 * 上几十毫秒的解析）。真机上的观感就是用户说的那句：
 *
 *   「预加载在用户交互的时候要暂停，否则容易出现卡顿」
 *   「播放列表里快速滑动感觉一卡一卡的」
 *
 * 所以这里只做一件事：记录「最后一次用户动作」的时间，并提供一个
 * 「等手停下来再干」的等待器。后台任务在起手前 `await waitIdle()` 即可，
 * 不需要谁去手动暂停/恢复。
 *
 * 只认真正需要主线程的输入：`touchstart/touchmove`（滚动期间这两个会一直发，
 * 而 `pointermove` 在浏览器接管滚动之后就不发了）、`wheel`、`scroll`、`keydown`。
 */

/** 最后一次用户动作的时间戳（毫秒） */
let lastAct = 0
/** 是否装过监听（模块是单例，装一次就够） */
let installed = false

function mark() {
  lastAct = Date.now()
}

/**
 * 挂上全局监听。
 *
 * 全部走捕获阶段 + `passive`：
 *   · 捕获：`scroll` 不冒泡，但捕获阶段能从 window 一路传到目标，
 *     这样列表、弹层、页面**所有**滚动容器都能覆盖到；
 *   · `passive`：绝不阻断滚动，哪怕这里写错了也不会拖慢手势。
 */
export function installIdleTracking(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  window.addEventListener('touchstart', mark, opts)
  window.addEventListener('touchmove', mark, opts)
  window.addEventListener('pointerdown', mark, opts)
  window.addEventListener('wheel', mark, opts)
  window.addEventListener('scroll', mark, opts)
  window.addEventListener('keydown', mark, opts)
  /* 滚动的惯性（fling）期间没有 touchmove，但 scroll 一直在发，上面那条已经覆盖 */
}

/** 用户刚刚是不是还在动（默认 500ms 内有过动作） */
export function userActive(within = 500): boolean {
  if (isHidden()) return false
  return Date.now() - lastAct < within
}

/**
 * 页面在后台（熄屏 / 切走）。
 *
 * 后台没有「手指在滑」这回事，所有让路逻辑都该立刻放行。这不只是省事：
 * `waitIdle` 自己用 `setTimeout` 轮询，而**后台的定时器会被 Chromium 节流到
 * 分钟级**——熄屏后补预告表时，一次 `waitIdle(700)` 可能要等一分钟才返回，
 * 回来时歌都快放完了。所以后台一律直接放行（这也是「缓存的歌能一直播、
 * 在线的放几首就停」的另一半原因）。
 */
function isHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}

/**
 * 等手停下来。
 *
 * `quiet` 是「安静多久算停」：太短会在两次滑动之间插进去（就是卡顿的来源），
 * 太长会让暂停时的缓存预热迟迟不起手。600ms 大约是一次滑动结束到下一次手势之间的空隙。
 *
 * `cap` 是硬上限：用户一直摸着屏幕（比如滚动条按着不放、或者干脆在长按），
 * 也不能让后台任务永远不跑——真到 `cap` 就照跑，反正那时候已经是最坏情况了。
 */
export function waitIdle(quiet = 600, cap = 20000): Promise<void> {
  /* 后台直接放行：没有交互要避让，而且这里的轮询定时器正被节流（见 isHidden） */
  if (isHidden()) return Promise.resolve()
  return new Promise<void>(resolve => {
    const t0 = Date.now()
    const tick = () => {
      if (Date.now() - lastAct >= quiet || Date.now() - t0 >= cap) resolve()
      else window.setTimeout(tick, 120)
    }
    /* 先让一拍：调用点通常正处在某次交互的回调里（点歌、滚动触发） */
    window.setTimeout(tick, 0)
  })
}
