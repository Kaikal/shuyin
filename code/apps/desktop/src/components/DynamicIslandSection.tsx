/**
 * 设置页 · 灵动岛（**现在只剩安卓**）。
 *
 * iPhone 那条「用疏音胶囊替代系统『正在播放』」的开关 2026-11-28 用户要求
 * 直接去掉：iOS 上岛就是系统自带的「正在播放」——系统按
 * `MPNowPlayingInfoCenter` 自己画胶囊、自己展开播控，点一下打开疏音。
 * 这条路零权限、零配额、零扩展依赖，**永远不会空**，也没有「我们的活动没起来
 * 导致岛上一片空白」的坑。所以 iOS 上这个组件直接不渲染（`null`）。
 *
 * 安卓没有系统灵动岛 API，只能自己用 `TYPE_APPLICATION_OVERLAY` 悬浮窗包挖孔
 * （Kotlin `DynamicIsland`），点一下回疏音、长按展开——这半边保留开关。
 *
 * 状态只认原生：`island_state` 问真值，`island_toggle` 返回开完之后的真值。
 */
import { useCallback, useEffect, useState } from 'react'
import { bridge, isAndroid } from '../lib/bridge'
import { onNative } from '../lib/native/android'
import { toast } from '../lib/toast'

interface IslandState {
  on: boolean
  shown?: boolean
  /** 「显示在其他应用上层」给没给（缺了窗挂不起来） */
  saw?: boolean
}

export function DynamicIslandSection() {
  const [on, setOn] = useState(false)
  /** 缺哪项权限（null = 旧包问不出来） */
  const [saw, setSaw] = useState<boolean | null>(null)

  const read = useCallback(() => {
    void bridge.invoke<IslandState>('island_state')
      .then(r => {
        if (typeof r === 'boolean') { setOn(r); return }
        if (!r) return
        setOn(!!r.on)
        if (typeof r.saw === 'boolean') setSaw(r.saw)
      })
      .catch(() => { /* 旧包没有这条命令：保持原样 */ })
  }, [])

  useEffect(() => { read() }, [read])

  /* 原生单方面挂窗/撤窗（播放暂停策略）：跟着真值走 */
  useEffect(() => {
    if (!isAndroid) return
    return onNative('island://state', p => setOn(!!(p as { on?: boolean } | null)?.on))
  }, [])

  /* 从后台回来补问一次：页面在后台时那条推送到不了 */
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === 'hidden') return
      read()
    }
    document.addEventListener('visibilitychange', sync)
    const off = isAndroid ? onNative('app://resume', sync) : () => {}
    return () => { off(); document.removeEventListener('visibilitychange', sync) }
  }, [read])

  const toggle = () => {
    void bridge.invoke<IslandState | boolean>('island_toggle')
      .then(r => {
        if (typeof r === 'boolean') { setOn(r); return }
        setOn(!!r?.on)
        if (r?.on === true && r.saw === false) {
          toast('缺少「显示在其他应用上层」权限，先去系统设置里允许')
          return
        }
        if (r?.on) toast('灵动岛已开启：播放时贴在摄像头挖孔上，点一下回疏音，长按展开')
      })
      .catch(() => { read() })
  }

  /* iPhone 上岛交给系统「正在播放」，没有可调的东西 */
  if (!isAndroid) return null

  return (
    <section className="set-group" data-pane="shell" data-sec="island">
      <h3>灵动岛</h3>
      <div className="set-row">
        <span className="set-label">播放时在摄像头挖孔处显示迷你胶囊</span>
        <button className="toggle" role="switch" aria-checked={on} onClick={toggle}>
          <span className="sr-only">灵动岛</span>
        </button>
      </div>
      <p className="set-sub">
        走系统悬浮窗：需要「显示在其他应用上层」权限。点一下回疏音，长按展开播控。
      </p>
      {saw === false && (
        <div className="set-row">
          <span className="set-label">缺少权限：显示在其他应用上层</span>
          <span className="set-ctl">
            <button
              className="ghost-btn"
              onClick={() => { void bridge.invoke('overlay_perm_open').catch(() => {}) }}
            >
              去设置
            </button>
          </span>
        </div>
      )}
    </section>
  )
}
