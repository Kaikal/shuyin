/**
 * 设置页 · 状态栏歌词（安卓专属）。
 *
 * 为什么整块搬到这里（2026-11-23 用户要求）：它是**系统层面**的一个常驻开关，
 * 和「锁屏播放页 / 后台活动」是同一类东西，而播放页那张「更多」卡片里
 * 全是对「这一首歌」做什么的动作。以前塞在播放页，用户想调位置还得先点开播放页
 * 再翻更多——现在一次到设置页改完。
 *
 * 那条字幕窗**触摸穿透**（否则顶部的下拉通知栏手势会被它吃掉），窗上既没有 ×
 * 也没有可点区域，所以开关与全部参数只能从 App 里改，这里是唯一入口。
 */
import { useCallback, useEffect, useState } from 'react'
import { bridge } from '../lib/bridge'
import { onNative } from '../lib/native/android'
import { toast } from '../lib/toast'

/**
 * 七套配色。
 *
 * **必须和原生 `StatusLyrics.PALETTE` 顺序逐字一致**：这里点第几个，
 * 原生就按索引取第几个颜色。取值与桌面歌词那批相同，两个功能之间切换不会觉得
 * 是两个产品。
 */
const STATUS_PALETTE = [
  '#FFC94D', // 流金
  '#FF6FAE', // 品红
  '#7BA6FF', // 冰蓝
  '#4FE0B0', // 青碧
  '#B98BFF', // 紫霞
  '#FF8A4C', // 霞橙
  '#FFFFFF', // 纯白
]

interface LyricState {
  on: boolean
  width: number
  pos: number
  top: number
  topMax?: number
  color: number
  needPermission?: boolean
}

export function StatusLyricSection() {
  const [on, setOn] = useState(false)
  /** 宽度（屏宽占比 0.35~1） */
  const [width, setWidth] = useState(0.7)
  /** 水平位置：0 贴左 / 0.5 居中 / 1 贴右 */
  const [pos, setPos] = useState(0.5)
  /** 上下位置：窗口上沿离屏幕顶端多少 dp（0 = 顶到头） */
  const [top, setTop] = useState(24)
  const [topMax, setTopMax] = useState(200)
  const [color, setColor] = useState(0)

  /** 问一次原生真值（开关 / 宽度 / 位置 / 上下 / 配色一起回来） */
  const read = useCallback(() => {
    void bridge.invoke<LyricState>('status_lyric_state')
      .then(r => {
        if (!r) return
        setOn(!!r.on)
        if (typeof r.width === 'number' && r.width > 0) setWidth(r.width)
        if (typeof r.pos === 'number' && r.pos >= 0) setPos(r.pos)
        if (typeof r.top === 'number' && r.top >= 0) setTop(Math.round(r.top))
        if (typeof r.topMax === 'number' && r.topMax > 0) setTopMax(Math.round(r.topMax))
        if (typeof r.color === 'number' && r.color >= 0) setColor(r.color)
      })
      .catch(() => { /* 命令不存在（旧包）就保持原样 */ })
  }, [])

  useEffect(() => { read() }, [read])

  /* 原生侧开/关落地后会推一条，跟着真值走（避免开关显示不准） */
  useEffect(() => {
    return onNative('status://state', payload => {
      setOn(!!(payload as { on?: boolean } | null)?.on)
    })
  }, [])

  /* 从后台回来补问一次：页面在后台时那条推送到不了（和桌面歌词同样的坑） */
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === 'hidden') return
      read()
    }
    const off = onNative('app://resume', sync)
    document.addEventListener('visibilitychange', sync)
    return () => { off(); document.removeEventListener('visibilitychange', sync) }
  }, [read])

  const toggle = () => {
    void bridge.invoke<LyricState>('status_lyric_toggle').then(r => {
      setOn(!!r?.on)
      if (r?.needPermission) toast('请先允许「显示在其他应用上层」，再打开状态栏歌词')
      else if (r?.on) toast('状态栏歌词已开启')
    }).catch(() => { read() })
  }

  const set = (patch: { width?: number; pos?: number; top?: number; color?: number }) => {
    void bridge.invoke('status_lyric_set', patch).catch(() => { /* 窗没开时改了也只是存档 */ })
  }

  return (
    <section className="set-group" data-pane="shell" data-sec="statuslyric">
      <h3>状态栏歌词</h3>
      <div className="set-row">
        <span className="set-label">
          状态栏歌词
          <span className="set-sub">
            贴在屏幕顶端的一条单行字幕，聊天、刷网页时抬头就能看词。
            触摸穿透，不会挡住顶部的下拉手势
          </span>
        </span>
        <button className="toggle" role="switch" aria-checked={on} onClick={toggle}>
          <span className="sr-only">状态栏歌词</span>
        </button>
      </div>

      {/* 上下位置：0 = 顶到头。以前固定贴状态栏下沿，水滴/挖孔这类异形屏上显得太靠下 */}
      <div className="dl-size-row">
        <span className="dl-size-name">上下位置</span>
        <input
          className="slider" type="range" aria-label="状态栏歌词上下位置"
          min={0} max={topMax} step={1}
          value={top}
          onChange={e => {
            const v = Number(e.target.value)
            setTop(v)
            set({ top: v })
          }}
        />
        <span className="dl-size-val num">{top <= 0 ? '顶到头' : `${top}`}</span>
      </div>

      <div className="dl-size-row">
        <span className="dl-size-name">宽度</span>
        <input
          className="slider" type="range" aria-label="状态栏歌词宽度"
          min={35} max={100} step={1}
          value={Math.round(width * 100)}
          onChange={e => {
            const v = Number(e.target.value) / 100
            setWidth(v)
            set({ width: v })
          }}
        />
        <span className="dl-size-val num">{Math.round(width * 100)}%</span>
      </div>

      {/* 宽度拉满时没有可移动空间，这一行置灰（不是隐藏——隐藏会让人以为功能没做） */}
      <div className="dl-size-row" style={{ opacity: width >= 0.995 ? 0.45 : 1 }}>
        <span className="dl-size-name">左右位置</span>
        <input
          className="slider" type="range" aria-label="状态栏歌词左右位置"
          min={0} max={100} step={1}
          value={Math.round(pos * 100)}
          disabled={width >= 0.995}
          onChange={e => {
            const v = Number(e.target.value) / 100
            setPos(v)
            set({ pos: v })
          }}
        />
        <span className="dl-size-val" style={{ minWidth: 30 }}>
          {width >= 0.995
            ? '满屏'
            : pos <= 0.02
              ? '贴左'
              : pos >= 0.98
                ? '贴右'
                : Math.abs(pos - 0.5) < 0.05 ? '居中' : `${Math.round(pos * 100)}%`}
        </span>
      </div>

      <div className="dl-size-row">
        <span className="dl-size-name">配色</span>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
          {STATUS_PALETTE.map((c, i) => (
            <button
              key={c}
              aria-label={`状态栏歌词配色 ${i + 1}`}
              aria-pressed={i === color}
              onClick={() => { setColor(i); set({ color: i }) }}
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: c,
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                boxShadow: i === color
                  ? '0 0 0 2px #fff, 0 0 0 3px rgba(0,0,0,.45)'
                  : '0 0 0 1px rgba(255,255,255,.3)',
              }}
            />
          ))}
        </div>
      </div>
    </section>
  )
}
