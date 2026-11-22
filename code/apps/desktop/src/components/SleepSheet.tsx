/**
 * 定时关闭（睡眠定时器）面板。
 *
 * ## 为什么真值在原生
 *
 * 用户设定时的主场景是「熄屏躺着听」。息屏之后 WebView 的定时器会被系统摁住
 * （同一根因坑过「放完一首就停」，见 PlayerProvider 里那块注释），
 * 前端 `setTimeout` 在被冻结的进程里根本不走。所以倒计时由原生
 * `SleepTimer` 走，这里只发命令、显示原生回报的剩余时间。
 *
 * ## 样式
 *
 * 复用频谱弹层（`SpectrumSheet`）那套 `.sheet* / .spx-*`：底部面板的骨架和
 * 「卡片单选」是同一个形状，再造一份只会多一份要跟着改的 CSS。
 */
import { useEffect, useState } from 'react'
import { IconCheck, IconClose } from './icons'
import { usePlayer } from '../lib/PlayerProvider'

/** 预设档位。没有「1 小时」以外的更长档：睡觉用不到，列表也不会长到滚不动 */
const PRESETS = [15, 30, 45, 60, 90]

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function SleepSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const p = usePlayer()
  const { sleep } = p
  /* 关闭时先把动画放完再卸载：直接 return null 会「啪」一下消失 */
  const [shown, setShown] = useState(open)

  useEffect(() => {
    if (open) { setShown(true); return }
    const t = window.setTimeout(() => setShown(false), 200)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!shown) return null

  const sub = sleep.track
    ? '播完当前这首就暂停'
    : sleep.on
      ? `还有 ${mmss(sleep.remain)}，到点会淡出并暂停`
      : '到点后淡出并暂停，不会关掉应用'

  /* 选完就收起：这是个「一锤子」设置，留在面板上没有任何后续操作 */
  const pick = (min: number | 'track' | null) => {
    p.setSleep(min)
    onClose()
  }

  return (
    <div className={'sheet-scrim spx-scrim' + (open ? ' open' : '')} onClick={onClose}>
      <div
        className={'sheet spx' + (open ? ' open' : '')}
        role="dialog"
        aria-modal="true"
        aria-label="定时关闭"
        onClick={e => e.stopPropagation()}
      >
        <span className="sheet-grip" aria-hidden="true" />

        <header className="sheet-head">
          <span className="sheet-meta">
            <span className="sheet-title">定时关闭</span>
            <span className="sheet-sub">{sub}</span>
          </span>
          <button className="icon-btn sheet-x" aria-label="关闭" onClick={onClose}>
            <IconClose width={16} height={16} />
          </button>
        </header>

        <div className="spx-body">
          <div className="spx-sec">
            <div className="spx-label">分钟后暂停</div>
            <div className="spx-grid spx-pos">
              {PRESETS.map(min => {
                /* 现在正在倒计时的那一档：用「剩余时间」反推出用户选的是哪个档 */
                const on = sleep.on && !sleep.track
                  && sleep.remain > (min - 1) * 60 && sleep.remain <= min * 60
                return (
                  <button
                    key={min}
                    className={'spx-card' + (on ? ' on' : '')}
                    aria-pressed={on}
                    onClick={() => pick(min)}
                  >
                    <span className="spx-n">{min} 分钟</span>
                    <span className="spx-d">{on ? `还剩 ${mmss(sleep.remain)}` : '到点暂停'}</span>
                    {on && <IconCheck className="spx-tick" width={12} height={12} />}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="spx-sec">
            <div className="spx-label">其他</div>
            <div className="spx-grid">
              <button
                className={'spx-card' + (sleep.track ? ' on' : '')}
                aria-pressed={sleep.track}
                onClick={() => pick('track')}
              >
                <span className="spx-n">播完这首</span>
                <span className="spx-d">当前这首放完就停，不接下一首</span>
                {sleep.track && <IconCheck className="spx-tick" width={12} height={12} />}
              </button>
              <button
                className="spx-card"
                disabled={!sleep.on}
                style={sleep.on ? undefined : { opacity: 0.45 }}
                onClick={() => pick(null)}
              >
                <span className="spx-n">关闭定时</span>
                <span className="spx-d">{sleep.on ? '恢复一直播放' : '当前没有定时'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
