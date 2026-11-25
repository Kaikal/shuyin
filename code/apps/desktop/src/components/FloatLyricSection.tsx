/**
 * 设置页 →「桌面歌词」（手机端）。
 *
 * 两个平台的落地通道完全不同，但用户嘴里的词是同一个：
 *   · 安卓：`SYSTEM_ALERT_WINDOW` 悬浮窗（Kotlin `FloatingLyrics`）
 *   · iOS：系统画中画 + 自绘字幕（`ShuyinLyricsPiP.swift`），离开 App 才浮起来
 *
 * 为什么设置页也要有：以前这颗开关只在播放页底部的芯片里，用户不播歌就找不到
 * 入口（2026-11-25「在设置页中也需要添加桌面歌词的开关」）。
 *
 * **状态只认原生**：`*_state` 问真值，`*_toggle` 返回开完之后的真值。
 * 原生单方面关掉窗的时候（画中画按了 ×、悬浮窗被系统回收）会推一条事件，
 * 这里跟着灭——否则就是用户说的「开关和实际显示不一致」。
 */
import { useCallback, useEffect, useState } from 'react'
import { bridge, isAndroid } from '../lib/bridge'
import { isIOS } from '../lib/shellMode'
import { onNative } from '../lib/native/android'
import { toast } from '../lib/toast'

export function FloatLyricSection() {
  const [on, setOn] = useState(false)
  const stateCmd = isAndroid ? 'float_lyric_state' : 'pip_lyric_state'
  const toggleCmd = isAndroid ? 'float_lyric_toggle' : 'pip_lyric_toggle'

  const read = useCallback(() => {
    void bridge.invoke<boolean | { on: boolean }>(stateCmd)
      .then(r => setOn(typeof r === 'boolean' ? r : !!r?.on))
      .catch(() => { /* 旧包没有这条命令：保持原样 */ })
  }, [stateCmd])

  useEffect(() => { read() }, [read])

  /* 原生单方面关掉：安卓 `float://state`，iOS `pip://state` */
  useEffect(() => {
    if (isAndroid) {
      return onNative('float://state', p => setOn(!!(p as { on?: boolean } | null)?.on))
    }
    if (isIOS) return bridge.onPipState(v => setOn(v))
    return
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
    void bridge.invoke<boolean | { on: boolean; needPermission?: boolean }>(toggleCmd)
      .then(r => {
        const v = typeof r === 'boolean' ? r : !!r?.on
        setOn(v)
        if (typeof r === 'object' && r?.needPermission) {
          toast('请先允许「显示在其他应用上层」，再打开桌面歌词')
          return
        }
        if (!v) return
        toast(isIOS
          ? '桌面歌词已开启：切到别的应用或回桌面就会浮起来'
          : '桌面歌词已开启，可以切到别的应用看词')
      })
      .catch(() => {
        /* 命令没回来别急着说没权限，先问一次真值 */
        read()
      })
  }

  return (
    <section className="set-group" data-pane="shell" data-sec="float">
      <h3>桌面歌词</h3>
      <div className="set-row">
        <span className="set-label">离开应用时浮在其它界面之上</span>
        <button
          className="toggle" role="switch" aria-checked={on}
          onClick={toggle}
        >
          <span className="sr-only">桌面歌词</span>
        </button>
      </div>
      <p className="set-sub">
        {isIOS
          ? 'iOS 走系统画中画：窗口上的 ±10 秒就是上一首 / 下一首；回到疏音会自动收起。'
          : '安卓走系统悬浮窗：需要「显示在其他应用上层」权限。'}
      </p>
    </section>
  )
}
