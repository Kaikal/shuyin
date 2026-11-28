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
import { createPortal } from 'react-dom'
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
  /* 自定义分钟数（字符串：允许用户先删空再输，不要被 number 强转成 0） */
  const [custom, setCustom] = useState('')
  /**
   * 软键盘占掉的高度（px，0 = 没弹）。
   *
   * 「自定义」这一行在面板最下面，一点输入框键盘弹起来就把它连同「开始」
   * 按钮一起盖住——用户 2026-11-28 两次反馈「自定义按钮被遮挡」，第一次我
   * 以为是设置页被迷你播放条压住（垫了 68px，那也确实该垫），真正的原因是键盘：
   * iOS 弹键盘不改布局视口，`position: fixed` 的底部面板原地不动，直接被压在
   * 键盘底下。`visualViewport` 是唯一能拿到键盘高度的口子，跟着把面板顶上去。
   */
  const [kb, setKb] = useState(0)

  useEffect(() => {
    if (open) { setShown(true); return }
    const t = window.setTimeout(() => setShown(false), 200)
    return () => window.clearTimeout(t)
  }, [open])

  /*
   * 键盘高度跟读。
   *
   * `innerHeight - visualViewport.height - offsetTop` 就是被键盘（或系统
   * 缩放）吃掉的那一条。80px 以下当作没弹：地址栏收起、输入法候选条这些小
   * 抖动不该让整个面板上下跳。
   */
  useEffect(() => {
    if (!open) { setKb(0); return }
    const vv = window.visualViewport
    if (!vv) return
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      setKb(inset > 80 ? Math.round(inset) : 0)
    }
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
    sync()
    return () => {
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
    }
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
      ? `还有 ${mmss(sleep.remain)}，到点会暂停`
      : '到点后暂停，不会关掉应用'

  /* 1~720 分钟之外的不算数（空串 / 0 / 超长）：按钮据此置灰 */
  const customMin = (() => {
    const n = Number.parseInt(custom, 10)
    return Number.isFinite(n) && n >= 1 && n <= 720 ? n : 0
  })()

  /* 选完就收起：这是个「一锤子」设置，留在面板上没有任何后续操作 */
  const pick = (min: number | 'track' | null) => {
    p.setSleep(min)
    onClose()
  }

  const sheet = (
    <div className={'sheet-scrim spx-scrim' + (open ? ' open' : '')} onClick={onClose}>
      <div
        className={'sheet spx' + (open ? ' open' : '')}
        role="dialog"
        aria-modal="true"
        aria-label="定时关闭"
        onClick={e => e.stopPropagation()}
        /*
         * 键盘弹起时整块往上顶，不去改内部 padding：sheet 是 flex-end 贴底的，
         * margin-bottom 就是「键盘多高、我抬多高」，内容布局一点不变。
         */
        style={kb ? { marginBottom: kb } : undefined}
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
            <div className="spx-label">自定义</div>
            {/*
             * 自定义分钟数：预设只有 15/30/45/60/90，用户 2026-11-28 反馈
             * 「没有自定义时长」。范围卡 1~720（12 小时）——再长就不是「定时
             * 关闭」而是「忘了关」，原生那边也是按 32 位秒数存的，不设上限没意义。
             */}
            {/*
             * 用 form 收口：数字键盘上那颗「前往」等于「开始」。
             *
             * 键盘弹起时面板已经被 marginBottom 顶到键盘上方，但「输完还要
             * 伸手去点按钮」这件事本身在手机上是多余动作——回车直接生效，
             * 按钮留着给不想用键盘的人。
             */}
            <form
              className="sleep-in-row"
              onSubmit={e => { e.preventDefault(); if (customMin) pick(customMin) }}
            >
              <input
                className="sleep-in"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                enterKeyHint="go"
                placeholder="分钟数"
                value={custom}
                onChange={e => setCustom(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                aria-label="自定义分钟数"
              />
              <span className="sleep-in-unit">分钟后暂停</span>
              <button
                type="submit"
                className="ghost-btn"
                disabled={!customMin}
                style={customMin ? undefined : { opacity: 0.45 }}
              >
                开始
              </button>
            </form>
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

  /*
   * 挂到 body 上，而不是留在原地。
   *
   * 这个面板从两处打开：设置页（`.page`）和播放页「更多」（`.imm`，带
   * `transform` 的常驻全屏层）。留在原地时，面板的 `position: fixed` 与
   * z-index 会被祖先的层叠上下文圈住，底部那截很容易被迷你播放条之类压在
   * 下面——`overflow: hidden` 的 `.page` 还会顺手把超出的部分裁掉。
   * portal 到 body 之后它相对真正的视口定位，谁来都盖得住。
   */
  return createPortal(sheet, document.body)
}
