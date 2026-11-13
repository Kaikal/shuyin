/**
 * 把「250ms 一跳」的播放位置快照插值成看起来连续的时间。
 *
 * 为什么要这个东西：
 * Rust 侧每 250ms 广播一次快照，主窗口的 `snapshot.position` 因此是台阶状的。
 * 逐字歌词按这个台阶推进，字与字之间最多差 250ms 才亮——人眼对这个很敏感，
 * 表现出来就是「歌词染色一顿一顿的 / 总觉得慢半拍」。
 *
 * 做法：记住每次快照到达的时刻，之后按 `performance.now()` 自己往前走，
 * 每 1/hz 秒触发一次重渲染（默认 15Hz，比字速快得多）。
 * 600ms 没有新快照就认为暂停 / 卡住了，停止外推——否则暂停后时间还会一直爬。
 */
import { useEffect, useRef, useState } from 'react'

/** 快照之间最多外推这么快（秒），防止一次丢包把歌词推到天边 */
const MAX_EXTRAPOLATE = 1
/** 超过这么久没有新快照就不再外推 */
/*
 * 900ms 而不是 600ms：`snapshot.position` 现在按「跨过半秒」才提交一次
 * （见 PlayerProvider 的 commitSnapshot），两帧之间本来就隔 500ms。
 * 卡在 600 的话，只要原生那两帧稍微晚一点，外推就会先停一瞬，
 * 歌词表现为「一顿一顿」。
 */
const STALE_MS = 900

export function useSmoothTime(raw: number, hz = 15, enabled = true): number {
  const st = useRef({ raw, base: raw, at: performance.now() })
  const [, force] = useState(0)

  // 新快照到了：把基准挪到它身上（渲染期同步，界面立刻跟上）
  if (raw !== st.current.raw) {
    st.current = { raw, base: raw, at: performance.now() }
  }

  useEffect(() => {
    if (!enabled) return
    const period = Math.max(16, Math.round(1000 / hz))
    const id = window.setInterval(() => {
      if (performance.now() - st.current.at > STALE_MS) return
      force(v => (v + 1) % 100000)
    }, period)
    return () => window.clearInterval(id)
  }, [hz, enabled])

  const elapsed = (performance.now() - st.current.at) / 1000
  return st.current.base + Math.min(MAX_EXTRAPOLATE, Math.max(0, elapsed))
}

/** 从小到大的时间轴里找「最后一个 time <= t」的下标，没有就 -1 */
export function indexAt(lines: { time: number }[], t: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= t + 0.05) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * 一句话「应该唱多久」：LRC 只给整行时间，字与字之间按字数均分。
 * 正常一句按 0.34s/字 估（夹在 2~8 秒），实际间隔夹在「估值 ~ 2.4 倍」之间：
 * 下一句离得近就唱满整段，隔得太远（长间奏）也不会一路慢慢爬到天荒地老。
 *
 * 主窗口、桌面歌词窗口都用这一个公式算，两边的染色才不会对不上。
 */
export function lineSpan(chars: number, lineStart: number, nextTime: number, duration: number): number {
  const est = Math.min(8, Math.max(2, chars * 0.34))
  const gap = nextTime > lineStart ? nextTime - lineStart : (duration > lineStart ? duration - lineStart : 0)
  return gap > 0 ? Math.min(Math.max(gap, est), est * 2.4) : est
}
