/**
 * 启动页 · 「疏影横斜，错落成诗」
 * 固定底色 #0A0B0F，不读用户主题；不阻塞初始化（扫描/主题加载在背后并行）。
 *
 * 版式：诗句竖排（writing-mode: vertical-rl），两列由右向左读；
 *      左列整体下沉、每字带轻微水平位移与旋转，形成「错落」而非机械对齐；
 *      左下角朱印「疏音」压角，配一条细竖线与小字，取题跋之意。
 *
 * 时序参数来自 theme-engine 的 SPLASH 常量（桌面与移动端共享）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SPLASH,
  SPLASH_OFFSETS_LINE1, SPLASH_OFFSETS_LINE2,
  SPLASH_POEM_LINE1, SPLASH_POEM_LINE2,
  SPLASH_ROTATIONS_LINE1, SPLASH_ROTATIONS_LINE2,
} from '@shuyin/theme-engine'
import { KEYS, settings } from '../lib/settings'

interface Props {
  firstLaunch: boolean
  reducedMotion: boolean
  onDone(): void
}

type Phase = 'in' | 'hold' | 'out'

export function Splash({ firstLaunch, reducedMotion, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('in')
  const [leaving, setLeaving] = useState(false)
  const [lastLabel, setLastLabel] = useState<string | null>(null)
  const timers = useRef<number[]>([])
  const doneRef = useRef(false)

  const finish = (fast: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    setLeaving(true)
    const dur = fast ? SPLASH.skipFadeMs : (reducedMotion ? 200 : SPLASH.fadeOutMs)
    timers.current.push(window.setTimeout(onDone, dur))
  }

  /* 读取「上次在听」：异步但极快（store 本地文件）；失败不影响启动 */
  useEffect(() => {
    let alive = true
    settings.get<string>(KEYS.lastTrackLabel)
      .then(v => { if (alive && v) setLastLabel(v) })
      .catch(() => { /* 忽略：启动页不应该因为读设置失败而卡住 */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const schedule = (fn: () => void, ms: number) => {
      timers.current.push(window.setTimeout(fn, ms))
    }
    if (reducedMotion) {
      schedule(() => setPhase('hold'), 300)
      schedule(() => finish(false), 900)
    } else if (firstLaunch) {
      schedule(() => finish(false), SPLASH.firstDurationMs)
    } else {
      schedule(() => setPhase('hold'), 200)
      // 别写死 1000：诗句逐字淡入要 ~670ms，留够驻留时间才看得完
      schedule(() => finish(false), SPLASH.repeatDurationMs)
    }
    return () => { timers.current.forEach(clearTimeout); timers.current = [] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 任意点击/按键跳过 */
  useEffect(() => {
    const skip = () => finish(true)
    window.addEventListener('pointerdown', skip)
    window.addEventListener('keydown', skip)
    return () => {
      window.removeEventListener('pointerdown', skip)
      window.removeEventListener('keydown', skip)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fontSize = useSplashFontSize()
  const chars1 = useMemo(() => splitPoem(SPLASH_POEM_LINE1, SPLASH_OFFSETS_LINE1, SPLASH_ROTATIONS_LINE1), [])
  const chars2 = useMemo(() => splitPoem(SPLASH_POEM_LINE2, SPLASH_OFFSETS_LINE2, SPLASH_ROTATIONS_LINE2), [])
  const anim = reducedMotion ? 'reduced' : firstLaunch ? 'full' : 'quick'

  return (
    <div
      className="splash"
      style={{ opacity: leaving ? 0 : 1, transition: `opacity ${SPLASH.skipFadeMs}ms var(--sy-ease-panel)` }}
      aria-hidden="true"
    >
      <div className="splash-inner" data-anim={anim} data-phase={phase}>
        <div className="splash-stage">
          <div className="splash-poem" style={{ fontSize }}>
            {/* 竖排：右列先读，左列整体下沉达成错落 */}
            <div className="poem-col" data-col="1">
              {chars1.map((c, i) => (
                <span
                  key={'a' + i}
                  className="poem-char"
                  style={{ '--d': i, '--tx': c.offset * 0.55 + 'px', '--rot': c.rot + 'deg' } as React.CSSProperties}
                >
                  {c.char}
                </span>
              ))}
            </div>
            <div className="poem-col" data-col="2">
              {chars2.map((c, i) => (
                <span
                  key={'b' + i}
                  className="poem-char"
                  style={{ '--d': i, '--tx': c.offset * 0.55 + 'px', '--rot': c.rot + 'deg' } as React.CSSProperties}
                >
                  {c.char}
                </span>
              ))}
            </div>
          </div>

          <div className="splash-side">
            <div className="splash-seal" aria-label="疏音">
              <span>疏</span><span>音</span>
            </div>
            <div className="splash-vrule" />
            <div className="splash-tag">疏影横斜 · 澄澈之音</div>
          </div>
        </div>

        {lastLabel && <div className="splash-last">上次在听 · {lastLabel}</div>}
      </div>
    </div>
  )
}

function splitPoem(line: string, offsets: number[], rotations: number[]): Array<{ char: string; offset: number; rot: number }> {
  return Array.from(line).map((char, i) => ({
    char,
    offset: offsets[i] ?? 0,
    rot: rotations[i] ?? 0,
  }))
}

/** 字号 = clamp(22, 屏宽×6.5%, 32)；高度不足时按高度收敛，避免竖排顶出屏幕 */
function useSplashFontSize(): number {
  const [size, setSize] = useState(28)
  useEffect(() => {
    const calc = () => {
      const byWidth = Math.min(window.innerWidth, window.innerHeight * 1.6) * SPLASH.fontScale
      // 竖排每列 7 字，列高约 7×字号×1.34；给上下留 30% 余量
      const byHeight = (window.innerHeight * 0.62) / (7 * 1.34)
      const v = Math.min(byWidth, byHeight)
      setSize(Math.max(SPLASH.fontMin, Math.min(SPLASH.fontMax, v)))
    }
    calc()
    window.addEventListener('resize', calc)
    return () => window.removeEventListener('resize', calc)
  }, [])
  return size
}
