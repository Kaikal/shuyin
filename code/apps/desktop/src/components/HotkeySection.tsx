/**
 * 设置页 · 快捷键与控制。
 *
 * 一行一个动作，右边是当前键位。点「设置」进入录制态：按下什么就是什么
 * （Esc 取消、Backspace 清空）。保存后立刻推给 Rust 重新注册，
 * **被别的程序占用会指名道姓地说出来**——不然用户只会觉得「按键没反应」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { HelpTip } from './HelpTip'
import {
  DEFAULT_HOTKEYS, HOTKEY_DEFS, HOTKEYS_APPLIED, accelFromEvent, accelOf, applyHotkeys, lastHotkeyResults,
  loadHotkeys, prettyAccel, saveHotkeys, type ApplyResult, type HotkeyAction, type HotkeyState,
} from '../lib/hotkeys'

export function HotkeySection() {
  const [state, setState] = useState<HotkeyState>(DEFAULT_HOTKEYS)
  const [recording, setRecording] = useState<HotkeyAction | null>(null)
  /** 逐项注册结果：id → 错误文案 */
  const [errors, setErrors] = useState<Partial<Record<HotkeyAction, string>>>({})
  const [msg, setMsg] = useState('')
  const recRef = useRef<HotkeyAction | null>(null)
  recRef.current = recording

  /** 把 Rust 的逐项结果翻成行内红字 */
  const showResults = useCallback((res: ApplyResult[], fallback: string) => {
    const map: Partial<Record<HotkeyAction, string>> = {}
    for (const r of res) if (!r.ok) map[r.id as HotkeyAction] = r.error || '注册失败'
    setErrors(map)
    const bad = Object.keys(map).length
    // 前三项现在也注册组合键（和耳机媒体键两条通道并行），所以只说「已注册」不说「组合键」
    const media = HOTKEY_DEFS.filter(d => d.mediaKey).length
    setMsg(res.length
      ? (bad
        ? `${bad} 个键位没注册上（见红字）`
        : `${res.length} 项已注册${state.media ? ` · 耳机 / 键盘媒体键 ${media} 项由系统接管` : ''}`)
      : fallback)
  }, [state.media])

  useEffect(() => {
    void loadHotkeys().then(setState)
    // 启动时那一轮注册发生在设置页挂载之前，把结果取回来
    const { results, at } = lastHotkeyResults()
    if (at) showResults(results, '')
    const onApplied = (e: Event) => showResults((e as CustomEvent<ApplyResult[]>).detail ?? [], '')
    window.addEventListener(HOTKEYS_APPLIED, onApplied)
    return () => window.removeEventListener(HOTKEYS_APPLIED, onApplied)
  }, [showResults])

  const commit = useCallback(async (next: HotkeyState, note?: string) => {
    setState(next)
    await saveHotkeys(next)
    const res = await applyHotkeys(next)
    showResults(res, note ?? '')
    if (note) setMsg(note)
  }, [showResults])

  /* 录制：捕获阶段拦下按键，别让它触发别的快捷键 */
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); return }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const id = recRef.current
        if (!id) return
        const next = { ...state, map: { ...state.map, [id]: '' } }
        setRecording(null)
        void commit(next, '已清空这一项')
        return
      }
      const accel = accelFromEvent(e)
      if (!accel) return
      const id = recRef.current
      if (!id) return
      const next = { ...state, map: { ...state.map, [id]: accel } }
      setRecording(null)
      void commit(next, `${HOTKEY_DEFS.find(d => d.id === id)?.label ?? id} → ${prettyAccel(accel)}`)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, state, commit])

  return (
    <section className="set-group" data-pane="shell" data-sec="hotkeys">
      <h3>
        快捷键与控制
        <HelpTip
          width={330}
          text={[
            '播放 / 暂停、上一首、下一首这三项**两条通道同时生效**：',
            '耳机线控、蓝牙耳机、键盘上的播放键走 Windows 的系统媒体会话；',
            '键盘组合键（默认 Ctrl+Alt+空格 / PageDown / PageUp）走全局热键，窗口收在托盘里也响应。',
            '',
            '「接管媒体键」关掉后，媒体键会还给系统里其它播放器，自定组合键仍然有效。',
            '',
            '任何一行点「设置」后直接按新的组合键，Esc 取消，Backspace 清空；',
            '这三项若改回「播放/暂停键」这类媒体键名，则只由系统媒体会话接管。',
            '建议都带上 Ctrl/Alt——只绑一个字母会抢掉打字。',
          ].join('\n')}
        />
      </h3>

      <div className="set-row">
        <span className="set-label">
          启用全局快捷键
          <span className="set-sub">关掉后所有组合键与媒体键都不再响应</span>
        </span>
        <button
          className="toggle" role="switch" aria-checked={state.on}
          onClick={() => void commit({ ...state, on: !state.on }, state.on ? '已关闭全局快捷键' : '已开启')}
        >
          <span className="sr-only">启用全局快捷键</span>
        </button>
      </div>

      <div className="set-row">
        <span className="set-label">
          接管媒体键（耳机控制）
          <span className="set-sub">播放/暂停、上一首、下一首；线控耳机、蓝牙耳机、键盘媒体键都算</span>
        </span>
        <button
          className="toggle" role="switch" aria-checked={state.media} disabled={!state.on}
          onClick={() => void commit({ ...state, media: !state.media }, state.media ? '媒体键已让给系统' : '已接管媒体键')}
        >
          <span className="sr-only">接管媒体键</span>
        </button>
      </div>

      <div className={'hk-list' + (state.on ? '' : ' off')}>
        {HOTKEY_DEFS.map(d => {
          const accel = accelOf(state, d.id)
          const err = errors[d.id]
          const rec = recording === d.id
          const isMedia = !!d.mediaKey
          const mediaHandled = isMedia && /^Media[A-Z]/.test(accel)
          return (
            <div className={'hk-row' + (rec ? ' rec' : '') + (err ? ' bad' : '')} key={d.id}>
              <span className="hk-name">{d.label}</span>
              <span className="hk-keys">
                {/* 媒体项有两行含义：耳机/键盘媒体键（固定）+ 自定组合键（可改） */}
                {isMedia && <kbd className="hk-kbd">耳机 / 键盘媒体键</kbd>}
                {isMedia && !mediaHandled && accel && (
                  <kbd className="hk-kbd">{prettyAccel(accel)}</kbd>
                )}
                {isMedia && mediaHandled && (
                  <kbd className="hk-kbd">{prettyAccel(accel)}</kbd>
                )}
                {!isMedia &&
                  (rec
                    ? <span className="hk-rec">按下新的组合键…</span>
                    : accel
                      ? <kbd className="hk-kbd">{prettyAccel(accel)}</kbd>
                      : <span className="hk-none">未绑定</span>)}
                {err && <span className="hk-err">{err}</span>}
              </span>
              <span className="hk-acts">
                {isMedia
                  ? <span className="hk-none">{state.media ? '系统接管' : '已让出'}</span>
                  : null}
                <button
                  className="ghost-btn hk-btn"
                  disabled={!state.on}
                  onClick={() => setRecording(rec ? null : d.id)}
                >
                  {rec ? '取消' : '设置'}
                </button>
                <button
                  className="link-btn hk-clear"
                  disabled={!state.on || (!accel && !rec)}
                  onClick={() => {
                    const next = { ...state, map: { ...state.map, [d.id]: '' } }
                    void commit(next, `已清空「${d.label}」`)
                  }}
                >
                  清除
                </button>
              </span>
              {isMedia && !state.media && <span className="hk-tag">媒体键已让出</span>}
            </div>
          )
        })}
      </div>

      <div className="hk-foot">
        <span className={'hk-msg' + (Object.keys(errors).length ? ' bad' : '')}>{msg}</span>
        <button className="link-btn" onClick={() => void commit(DEFAULT_HOTKEYS, '已恢复默认键位')}>
          恢复默认
        </button>
      </div>
    </section>
  )
}
