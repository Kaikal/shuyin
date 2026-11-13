/**
 * 手机播放页的「频谱」设置弹窗（样式 + 位置）。
 *
 * 以前手机上这两项只能去设置页改，而设置页的那一段还是 `bridge.isTauri` 包着的
 * ——安卓上压根没有入口，等于「唱片外面那一圈是什么样」全凭默认。
 * 用户要的是「在播放页就能点开选，像电脑端那样」。
 *
 * 位置说明：手机上不提供桌面那五种「贴窗口四边」，
 * 竖屏小屏上贴边光带既挡手又和唱片外圈重复，改成播放页内的三个位置
 * （封面外圈 / 页面底部 / 页面顶部，见 lib/spectrumPos 的 MOBILE_SPEC_POSITIONS）。
 */
import { useEffect, useState } from 'react'
import { IconCheck, IconClose } from './icons'
import { SPECTRUM_STYLES, spectrumStyleName, useSpectrumStyle } from '../lib/spectrumStyle'
import { MOBILE_SPEC_POSITIONS, mobileSpecPosName, useMobileSpecPos } from '../lib/spectrumPos'
import { useSpectrumOn } from '../lib/uiPrefs'

export function SpectrumSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const [specStyle, setSpecStyle] = useSpectrumStyle()
  const [specPos, setSpecPos] = useMobileSpecPos()
  const [specOn, setSpecOn] = useSpectrumOn()
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

  return (
    <div className={'sheet-scrim spx-scrim' + (open ? ' open' : '')} onClick={onClose}>
      <div
        className={'sheet spx' + (open ? ' open' : '')}
        role="dialog"
        aria-modal="true"
        aria-label="频谱设置"
        onClick={e => e.stopPropagation()}
      >
        <span className="sheet-grip" aria-hidden="true" />

        <header className="sheet-head">
          <span className="sheet-meta">
            <span className="sheet-title">频谱</span>
            <span className="sheet-sub">
              {specOn ? `${spectrumStyleName(specStyle)} · ${mobileSpecPosName(specPos)}` : '已关闭，打开后才显示'}
            </span>
          </span>
          <button
            className="sheet-sw spx-swb"
            data-on={specOn ? '1' : '0'}
            role="switch"
            aria-checked={specOn}
            aria-label="频谱可视化"
            onClick={() => {
              const next = !specOn
              setSpecOn(next)
            }}
          />
          <button className="icon-btn sheet-x" aria-label="关闭" onClick={onClose}>
            <IconClose width={16} height={16} />
          </button>
        </header>

        {/* 关掉频谱时这两组没有意义：压暗 + 不吃点击，但保留内容——
            用户得看到「有这些选项，只是现在关了」 */}
        <div className="spx-body" data-off={specOn ? undefined : '1'}>
          <div className="spx-sec">
            <div className="spx-label">样式</div>
            <div className="spx-grid">
              {SPECTRUM_STYLES.map(s => (
                <button
                  key={s.id}
                  className={'spx-card' + (specStyle === s.id ? ' on' : '')}
                  aria-pressed={specStyle === s.id}
                  onClick={() => setSpecStyle(s.id)}
                >
                  <span className="spx-n">{s.name}</span>
                  <span className="spx-d">{s.desc}</span>
                  {specStyle === s.id && <IconCheck className="spx-tick" width={12} height={12} />}
                </button>
              ))}
            </div>
          </div>

          <div className="spx-sec">
            <div className="spx-label">位置</div>
            <div className="spx-grid spx-pos">
              {MOBILE_SPEC_POSITIONS.map(p => (
                <button
                  key={p.id}
                  className={'spx-card' + (specPos === p.id ? ' on' : '')}
                  aria-pressed={specPos === p.id}
                  onClick={() => setSpecPos(p.id)}
                >
                  <span className="spx-n">{p.name}</span>
                  <span className="spx-d">{p.desc}</span>
                  {specPos === p.id && <IconCheck className="spx-tick" width={12} height={12} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
