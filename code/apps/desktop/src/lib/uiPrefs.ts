/**
 * 界面偏好里需要跨页面共享的开关：沉浸式歌词（只留歌词）与 Folia 歌词动效。
 *
 * 为什么单独放一个模块而不是塞进 React context：
 * 播放页和设置页是两棵独立的子树，设置页改完要立刻反映到播放页，
 * 走模块级订阅比在最顶层再套一层 Provider 轻。
 */
import { useEffect, useState } from 'react'
import { KEYS, settings } from './settings'

type Setter = (v: boolean, persist?: boolean) => void
type Hook = () => [boolean, Setter]

/**
 * 一个布尔偏好的最小实现：模块内单例 + 订阅 + 首次异步补读存档。
 * `touched` 是必需的——存档读回来是异步的，用户在读回来之前手动改过就不能被覆盖。
 */
function createPref(key: string, initial: boolean) {
  let value = initial
  let touched = false
  let booting: Promise<void> | null = null
  const subs = new Set<(v: boolean) => void>()

  const emit = (v: boolean) => subs.forEach(fn => fn(v))

  function boot() {
    if (!booting) {
      booting = settings.get<boolean>(key).then(v => {
        if (touched || typeof v !== 'boolean' || v === value) return
        value = v
        emit(v)
      }).catch(() => { /* 读不到就用默认值 */ })
    }
    return booting
  }

  const set: Setter = (v, persist = true) => {
    if (v === value) {
      if (persist) touched = true
      return
    }
    touched = true
    value = v
    emit(v)
    if (persist) void settings.set(key, v)
  }

  const use: Hook = () => {
    const [v, setV] = useState(value)
    useEffect(() => {
      const fn = (n: boolean) => setV(n)
      subs.add(fn)
      setV(value)
      void boot()
      return () => { subs.delete(fn) }
    }, [])
    return [v, set]
  }

  return { get: () => value, set, use }
}

/** 沉浸式歌词：播放页只留歌词（L 键 / 右上角按钮切换） */
const solo = createPref(KEYS.lyricsSolo, false)

/** Folia 歌词动效：逐字弹出、错落排版、唱到的字发光（默认开） */
const folia = createPref(KEYS.foliaFx, true)

/**
 * 播放页封面样式：黑胶唱片 / 方形封面（默认唱片）。
 * 唱片是照着「一张唱片摆在桌上」的构图做的：圆盘 + 唱臂 + 左侧大留白，
 * 比一张圆角方图更有「在听歌」的感觉。不喜欢可以在这里切回方形。
 */
const vinyl = createPref(KEYS.vinylView, true)

/**
 * 手机播放页「左右滑动切换」的提示看过没（默认没看过 → 首次进播放页提示一次）。
 *
 * 存成偏好而不是每次进页面都弹：翻页这个手势用户学会一次就够了，
 * 之后每首歌都飘一句「左滑看歌词」纯属噪音。
 */
const swipeHint = createPref(KEYS.swipeHint, false)

/**
 * 贴边频谱（窗口上下左右那一圈柱子）显示与否，默认开。
 *
 * 以前这件事没有开关，频谱常驻：暂停时柱子全归零，只剩 `.sedge::before`
 * 那层极淡的径向光——在近黑底上看着就是**屏幕下方一条莫名其妙的虚线**，
 * 用户的第一反应是「这是干嘛的」。
 * 现在两道闸：暂停时整层淡出（见 App.tsx 的 `idle`），想彻底不要就关掉这个开关。
 */
const spectrumOn = createPref(KEYS.spectrumOn, true)

export const getLyricsSolo = solo.get
export const setLyricsSolo = solo.set
export const useLyricsSolo = solo.use

export const getFoliaFx = folia.get
export const setFoliaFx = folia.set
export const useFoliaFx = folia.use

export const getVinylView = vinyl.get
export const setVinylView = vinyl.set
export const useVinylView = vinyl.use

export const getSwipeHint = swipeHint.get
export const setSwipeHint = swipeHint.set
export const useSwipeHint = swipeHint.use

export const getSpectrumOn = spectrumOn.get
export const setSpectrumOn = spectrumOn.set
export const useSpectrumOn = spectrumOn.use
