/**
 * 设置页 · 灵动岛。
 *
 * 两个平台的落地通道完全不同，形态也不一样：
 *   · **iPhone（默认走系统）**：岛上就是 iOS 自带的「正在播放」——系统按
 *     `MPNowPlayingInfoCenter` 自己画胶囊、自己展开播控，点一下打开疏音。
 *     这条路零权限、零配额，永远不会空。**2026-11-28 用户定案：用系统那个，
 *     不要自绘**，所以这里的开关默认关，打开才换成我们自己的 ActivityKit 胶囊
 *     （封面款，需要系统允许「实时活动」，且会压掉系统卡避免两颗胶囊打架）。
 *   · **安卓**：`TYPE_APPLICATION_OVERLAY` 悬浮窗包住摄像头挖孔
 *     （Kotlin `DynamicIsland`），点按/长按手势同上，自己画胶囊。
 *
 * 状态只认原生：`island_state` 问真值，`island_toggle` 返回开完之后的真值。
 * 安卓的开关在原生侧，iOS 的开关在 Swift 侧（UserDefaults `shuyin.island.own`），
 * 前端只是显示。
 */
import { useCallback, useEffect, useState } from 'react'
import { bridge, isAndroid } from '../lib/bridge'
import { isIOS } from '../lib/shellMode'
import { onNative } from '../lib/native/android'
import { toast } from '../lib/toast'

interface IslandState {
  on: boolean
  shown?: boolean
  /** 「显示在其他应用上层」给没给（仅安卓需要；缺了窗挂不起来） */
  saw?: boolean
  /** 系统设置里「实时活动」允许了没有（仅 iOS；false = Live Activity 起不来） */
  enabled?: boolean
}

export function DynamicIslandSection() {
  const [on, setOn] = useState(false)
  /** 缺哪项权限（null = 旧包问不出来）；iOS 永远不需要 */
  const [saw, setSaw] = useState<boolean | null>(isAndroid ? null : true)
  /** iOS 系统级实时活动授权（null = 旧包问不出来） */
  const [enabled, setEnabled] = useState<boolean | null>(isIOS ? null : true)

  const read = useCallback(() => {
    void bridge.invoke<IslandState>('island_state')
      .then(r => {
        /* iOS 的命令返回布尔值（旧包）或对象 {on,enabled}，安卓返回对象——都要接 */
        if (typeof r === 'boolean') { setOn(r); return }
        if (!r) return
        setOn(!!r.on)
        if (typeof r.saw === 'boolean') setSaw(r.saw)
        if (typeof r.enabled === 'boolean') setEnabled(r.enabled)
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
        if (typeof r === 'boolean') { setOn(r); if (r) toast('灵动岛已开启：播放时胶囊出现在灵动岛上'); return }
        setOn(!!r?.on)
        if (isAndroid && r?.on === true && r.saw === false) {
          toast('缺少「显示在其他应用上层」权限，先去系统设置里允许')
          return
        }
        if (r?.on) {
          toast(isIOS
            ? '换成疏音胶囊了：播放时出现在灵动岛上，长按展开播控'
            : '灵动岛已开启：播放时贴在摄像头挖孔上，点一下回疏音，长按展开')
          /* 开了开关但系统没允许实时活动：我们的胶囊起不来，岛上只剩系统卡 */
          void bridge.invoke<IslandState>('island_state')
            .then(s => {
              if (s && typeof s === 'object' && s.enabled === false) {
                toast('系统设置 → 疏音 → 实时活动 未允许，疏音胶囊不会出现（岛上仍是系统的「正在播放」）')
              }
            })
            .catch(() => {})
        } else if (isIOS) {
          toast('已改回系统灵动岛：胶囊与播控都交给 iOS 自己画')
        }
      })
      .catch(() => { read() })
  }

  return (
    <section className="set-group" data-pane="shell" data-sec="island">
      <h3>灵动岛</h3>
      <div className="set-row">
        <span className="set-label">
          {isIOS ? '用疏音的封面胶囊替代系统「正在播放」' : '播放时在摄像头挖孔处显示迷你胶囊'}
        </span>
        <button className="toggle" role="switch" aria-checked={on} onClick={toggle}>
          <span className="sr-only">灵动岛</span>
        </button>
      </div>
      <p className="set-sub">
        {isIOS
          ? '默认关闭 = 走 iOS 自带的「正在播放」灵动岛：点胶囊打开疏音、长按展开系统播控，不用授任何权限。打开后换成疏音的封面胶囊（需系统允许「实时活动」）。'
          : '走系统悬浮窗：需要「显示在其他应用上层」权限。点一下回疏音，长按展开播控。'}
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
      {isIOS && on && enabled === false && (
        <div className="set-row">
          <span className="set-label">系统未允许实时活动，疏音胶囊不会出现</span>
          <span className="set-ctl">
            <span className="set-sub">系统设置 → 疏音 → 实时活动（岛上仍是系统「正在播放」）</span>
          </span>
        </div>
      )}
    </section>
  )
}
