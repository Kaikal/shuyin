/**
 * 全局快捷键与媒体键。
 *
 * 两条不同的通道，别混：
 *   * **组合键**（Ctrl+Alt+Space 之类）：Rust 侧 `RegisterHotKey` 注册，前端只负责定义与派发；
 *   * **媒体键**（播放/暂停、上一首、下一首）：Windows 上走**系统媒体会话（SMTC）**，
 *     由 `src-tauri/src/smtc.rs` 接管。耳机线控、蓝牙 AVRCP、键盘媒体键都从这儿进来。
 *     不能用 `RegisterHotKey`——媒体键不走热键表，注册往往「成功」但永远收不到，
 *     而且一旦真的注册上，反而会把键从系统那里抢走，媒体会话也就收不到了。
 *
 * 播放/暂停、上一首、下一首这三项**两条通道都开**：用户可以给它们另绑一个普通组合键
 * （默认 Ctrl+Alt+Space / PageDown / PageUp），耳机和键盘媒体键照旧走 SMTC。
 * 只有把主键改写成 `Media*` 键名时才交给 SMTC 单独处理。
 *
 * SMTC 发上来的事件带 `source: 'smtc'`，据此判断「接管媒体键」开关。
 */
import { useCallback, useEffect, useRef } from 'react'
import { bridge, isAndroid } from './bridge'
import { KEYS, settings } from './settings'

export type HotkeyAction =
  | 'playpause' | 'next' | 'prev' | 'fav'
  | 'volumeUp' | 'volumeDown' | 'mute'
  | 'seekBack' | 'seekFwd'
  | 'toggleLyrics' | 'openSearch' | 'toggleWindow' | 'musicLock'

export interface HotkeyDef {
  id: HotkeyAction
  label: string
  hint?: string
  /** 默认组合键；空字符串 = 默认不绑 */
  def: string
  /**
   * 媒体键入口（Windows 的系统媒体会话）。写在这里的三项**同时**支持两种触发：
   * 耳机线控 / 键盘媒体键走 SMTC，键盘组合键走 `RegisterHotKey`——
   * 两者通道不同、互不抢占，这正是「快捷键和耳机都要能用」的前提。
   * 值是这个动作对应的系统媒体键名，只用于设置页展示。
   */
  mediaKey?: string
}

export const HOTKEY_DEFS: HotkeyDef[] = [
  { id: 'playpause', label: '播放 / 暂停', mediaKey: '播放 / 暂停键', def: 'Ctrl+Alt+Space' },
  { id: 'next', label: '下一首', mediaKey: '下一首键', def: 'Ctrl+Alt+PageDown' },
  { id: 'prev', label: '上一首', mediaKey: '上一首键', def: 'Ctrl+Alt+PageUp' },
  { id: 'volumeUp', label: '音量 +', def: 'Ctrl+Alt+Up' },
  { id: 'volumeDown', label: '音量 −', def: 'Ctrl+Alt+Down' },
  { id: 'mute', label: '静音 / 取消静音', def: 'Ctrl+Alt+M' },
  { id: 'seekFwd', label: '快进 5 秒', def: 'Ctrl+Alt+Right' },
  { id: 'seekBack', label: '后退 5 秒', def: 'Ctrl+Alt+Left' },
  { id: 'toggleLyrics', label: '桌面歌词开关', def: 'Ctrl+Alt+L' },
  { id: 'openSearch', label: '打开在线搜索', def: 'Ctrl+Alt+F' },
  { id: 'toggleWindow', label: '显示 / 收起主窗口', def: 'Ctrl+Alt+H' },
  { id: 'musicLock', label: '音乐锁屏（全屏时钟）', def: 'Ctrl+Alt+K' },
]

export type HotkeyMap = Partial<Record<HotkeyAction, string>>

export interface HotkeyState {
  on: boolean
  media: boolean
  map: HotkeyMap
}

export const DEFAULT_HOTKEYS: HotkeyState = { on: true, media: true, map: {} }

/** 某项最终生效的组合键（存档里没写就用默认） */
export function accelOf(state: HotkeyState, id: HotkeyAction): string {
  const v = state.map[id]
  if (typeof v === 'string') return v
  return HOTKEY_DEFS.find(d => d.id === id)?.def ?? ''
}

export async function loadHotkeys(): Promise<HotkeyState> {
  const [on, media, map] = await Promise.all([
    settings.get<boolean>(KEYS.hotkeysOn),
    settings.get<boolean>(KEYS.hotkeysMedia),
    settings.get<HotkeyMap>(KEYS.hotkeysMap),
  ])
  return {
    on: on !== false,
    media: media !== false,
    map: map && typeof map === 'object' ? map : {},
  }
}

export async function saveHotkeys(s: HotkeyState): Promise<void> {
  await Promise.all([
    settings.set(KEYS.hotkeysOn, s.on),
    settings.set(KEYS.hotkeysMedia, s.media),
    settings.set(KEYS.hotkeysMap, s.map),
  ])
}

export interface ApplyResult {
  id: string
  ok: boolean
  error?: string | null
}

/**
 * 把配置推给 Rust。总开关关掉就全部注销。
 * 返回逐项结果——某个键被别的程序占了，前端要能指出来是哪一行。
 */
let lastResults: ApplyResult[] = []
let lastAt = 0
/** 最近一次注册结果：设置页晚于启动挂载，靠它拿到「到底哪项没注册上」 */
export function lastHotkeyResults(): { results: ApplyResult[]; at: number } {
  return { results: lastResults, at: lastAt }
}

export async function applyHotkeys(s: HotkeyState): Promise<ApplyResult[]> {
  if (!bridge.isTauri) return []
  if (!s.on) {
    try { await bridge.invoke('hotkeys_clear') } catch { /* 忽略 */ }
    lastResults = []; lastAt = Date.now()
    window.dispatchEvent(new CustomEvent(HOTKEYS_APPLIED, { detail: lastResults }))
    return []
  }
  /*
   * 除「组合键」外，其余项也要注册。
   *
   * 媒体键（耳机线控、键盘播放键）走的是系统媒体会话（SMTC），
   * `RegisterHotKey` 收不到；一旦注册成功还会把键从系统那里抢走，
   * 反而让媒体会话也拿不到——这正是「快捷键都好、耳机没反应」的成因。
   * 所以**只有主键写成媒体键名的项不注册**（由 Rust 侧 smtc.rs 接管），
   * 用户给这三项改成的普通组合键照常注册：两种通道同时生效。
   */
  const items = HOTKEY_DEFS
    .map(d => ({ id: d.id, accel: accelOf(s, d.id) }))
    .filter(x => x.accel.trim() !== '' && !/^Media[A-Z]/.test(x.accel))
  try {
    const res = await bridge.invoke<ApplyResult[]>('hotkeys_apply', { items })
    lastResults = res
    lastAt = Date.now()
    window.dispatchEvent(new CustomEvent(HOTKEYS_APPLIED, { detail: res }))
    return res
  } catch {
    return []
  }
}

/** 改完配置后通知 App 重新注册（设置页 → 运行中的快捷键） */
export const HOTKEYS_CHANGED = 'sy:hotkeys-changed'
/** 注册结果变了（启动时、或用户改键后） */
export const HOTKEYS_APPLIED = 'sy:hotkeys-applied'
export function notifyHotkeysChanged() {
  window.dispatchEvent(new CustomEvent(HOTKEYS_CHANGED))
}

/* ------------------------------------------------------------------ */
/* 录制：键盘事件 → 组合键写法                                          */
/* ------------------------------------------------------------------ */

const CODE_MAP: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Escape: 'Escape',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowUp: 'Up', ArrowRight: 'Right', ArrowDown: 'Down',
  Minus: 'Minus', Equal: 'Equal', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaTrackNext', MediaTrackPrevious: 'MediaTrackPrev',
}

/** 键盘事件 → `Ctrl+Alt+Space` 这类写法；只按修饰键时返回 null */
export function accelFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const code = (e as KeyboardEvent).code || ''
  const key = (e as KeyboardEvent).key || ''
  if (/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(key)) return null

  let base = CODE_MAP[code]
  if (!base) {
    if (/^Key[A-Z]$/.test(code)) base = code.slice(3)
    else if (/^Digit[0-9]$/.test(code)) base = code.slice(5)
    else if (/^Numpad[0-9]$/.test(code)) base = 'Num' + code.slice(6)
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) base = code
  }
  if (!base && e.key && e.key.length === 1) base = e.key.toUpperCase()
  if (!base) return null

  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Win')
  // 纯单键（字母/数字）也能用，但必须提醒：不组合修饰键会抢掉打字
  return [...mods, base].join('+')
}

const PRETTY: Record<string, string> = {
  MediaPlayPause: '播放/暂停键',
  MediaTrackNext: '下一首键',
  MediaTrackPrev: '上一首键',
  Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Win: 'Win',
  Left: '←', Right: '→', Up: '↑', Down: '↓',
  Space: '空格', Enter: '回车', Escape: 'Esc', Delete: 'Del', Backspace: '退格',
  Minus: '−', Equal: '=',
}

/** 展示用：MediaPlayPause → 播放/暂停键，Ctrl+Alt+Up → Ctrl + Alt + ↑ */
export function prettyAccel(accel: string): string {
  if (!accel) return '未绑定'
  return accel.split('+').map(p => PRETTY[p] ?? p).join(' + ')
}

/* ------------------------------------------------------------------ */
/* 运行期派发                                                          */
/* ------------------------------------------------------------------ */

export interface HotkeyHandlers {
  playpause(): void
  next(): void
  prev(): void
  /** 收藏当前曲目（安卓通知栏的收藏键走这条通道；不进热键表，无需注册） */
  fav(): void
  setVolume(v: number): void
  getVolume(): number
  /** 增量调音量（±0.05）：静音态下以静音前的音量为基准 */
  nudgeVolume(delta: number): void
  /** 静音 / 取消静音（真调输出音量，见 PlayerProvider） */
  toggleMute(): void
  seek(delta: number): void
  seekable(): boolean
  toggleLyrics(): void
  openSearch(): void
  toggleWindow(): void
  musicLock(): void
}

/**
 * 挂上 Rust 的 hotkey 事件并按动作派发。
 *
 * 关键点：**任何动作都不能因为窗口在后台而失效**。播放控制直接调播放器；
 * 「打开搜索」会先把窗口抬起来（不然用户按了快捷键却什么都没看见）。
 */
export function useGlobalHotkeys(h: HotkeyHandlers) {
  const ref = useRef(h)
  ref.current = h
  /** 媒体键开关的实时值：配置还没读出来时按「开」处理 */
  const mediaOn = useRef(true)

  /* 配置变了就重新注册（设置页保存后广播事件） */
  useEffect(() => {
    if (!bridge.isTauri) return
    let alive = true
    const push = async () => {
      const s = await loadHotkeys()
      if (!alive) return
      mediaOn.current = s.media && s.on
      const res = await applyHotkeys(s)
      const bad = res.filter(r => !r.ok)
      if (bad.length) {
        console.warn('[疏音] 快捷键注册失败：', bad)
        window.dispatchEvent(new CustomEvent('sy:hotkeys-failed', { detail: bad }))
      }
    }
    void push()
    const onChange = () => void push()
    window.addEventListener(HOTKEYS_CHANGED, onChange)
    return () => {
      alive = false
      window.removeEventListener(HOTKEYS_CHANGED, onChange)
    }
  }, [])

  /* 动作分发：桌面（Rust 注册的热键 / SMTC）与安卓（媒体会话 / 通知栏 / 方向盘）共用这一份 */
  const runAction = useCallback((id: HotkeyAction, source?: string) => {
    const fn = ref.current
    /*
     * 系统媒体键（耳机 / 键盘媒体键）受「接管媒体键」开关控制。
     *
     * 但**安卓不受它管**：那个开关在手机上没有入口（设置里整块是桌面专属），
     * 而安卓原生把「通知栏 / 锁屏 / 车机方控」按下的动作也用 source='smtc' 送上来。
     * 一起判的话，用户在桌面端随手关掉它，手机上整排通知栏按钮就全哑了。
     */
    if (source === 'smtc' && !isAndroid && !mediaOn.current) return
    switch (id) {
      case 'playpause': fn.playpause(); break
      case 'next': fn.next(); break
      case 'prev': fn.prev(); break
      case 'fav': fn.fav(); break
      /*
       * 音量 / 静音：状态归 `PlayerProvider` 管（真调输出音量、记住静音前的值）。
       * 这里原来自己记了一个 `mutedAt`，于是「快捷键静音 → 再点界面上的按钮」
       * 两条路各记一份，恢复不到上次的音量。
       */
      case 'volumeUp': fn.nudgeVolume(0.05); break
      case 'volumeDown': fn.nudgeVolume(-0.05); break
      case 'mute': fn.toggleMute(); break
      case 'seekFwd': if (fn.seekable()) fn.seek(5); break
      case 'seekBack': if (fn.seekable()) fn.seek(-5); break
      case 'toggleLyrics': fn.toggleLyrics(); break
      case 'openSearch': fn.openSearch(); break
      case 'toggleWindow': fn.toggleWindow(); break
      /* 音乐锁屏：接口和 App 里的映射上一轮就加了，但这条 switch 漏了一项——
         事件到了前端却没人接，「Ctrl+Alt+K 没反应」就是这么来的。
         新增动作时这里必须一起补，否则注册成功也等于没注册。 */
      case 'musicLock': fn.musicLock(); break
    }
  }, [])

  useEffect(() => {
    if (!bridge.isTauri) return
    let un: (() => void) | undefined
    let live = true
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const off = await listen<{ id: HotkeyAction; source?: string }>('hotkey://action', e => {
          const id = e.payload?.id
          if (!id) return
          runAction(id, e.payload?.source)
        })
        if (live) un = off
        else off()
      } catch { /* 浏览器预览 */ }
    })()
    return () => { live = false; un?.() }
  }, [runAction])

  /*
   * 安卓：没有「组合键」这回事，但媒体会话（蓝牙耳机、车机方控、通知栏）
   * 一样要有反应。原生把动作转成 `sy:hotkey` DOM 事件，这里接进同一张动作表。
   */
  useEffect(() => {
    if (!isAndroid) return
    const onHot = (e: Event) => {
      const d = (e as CustomEvent<{ id?: HotkeyAction; source?: string }>).detail
      if (!d?.id) return
      runAction(d.id, d.source)
    }
    window.addEventListener('sy:hotkey', onHot as EventListener)
    return () => window.removeEventListener('sy:hotkey', onHot as EventListener)
  }, [runAction])

  /* 退出前让出热键：注册是进程级的，正常退出时系统会回收，但注销更干净 */
  useEffect(() => () => { void applyHotkeys({ on: false, media: false, map: {} }) }, [])
}

/** 主窗口显示/收起（快捷键用） */
export async function toggleMainWindow(): Promise<void> {
  if (!bridge.isTauri) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const w = getCurrentWindow()
    const visible = await w.isVisible()
    if (visible) await w.hide()
    else { await w.show(); await w.setFocus() }
  } catch { /* 忽略 */ }
}
