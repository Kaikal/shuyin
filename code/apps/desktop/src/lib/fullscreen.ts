/**
 * 系统全屏（F11）的状态与切换。
 *
 * 为什么单独一个模块：播放页右上角有个全屏按钮，F11 是全局快捷键，
 * 两处必须读同一个状态，否则「按 F11 进去了，按钮却还显示『全屏』」。
 * 不用 React context 是因为 App 与播放页是两层子树，模块级订阅最省事。
 *
 * 进全屏时顺手把标题栏高度变量置 0：主窗口是无边框自绘标题栏，
 * 系统全屏并不会替你藏掉它，留着会顶在屏幕最上面一条。
 */
import { useEffect, useState } from 'react'
import { bridge } from './bridge'

let full = false
const subs = new Set<(v: boolean) => void>()

function applyDom(v: boolean) {
  const root = document.documentElement
  root.dataset.fs = v ? 'true' : 'false'
  root.style.setProperty('--tb-h', v ? '0px' : '38px')
}

function emit() {
  applyDom(full)
  subs.forEach(fn => fn(full))
}

export async function setFullscreen(v: boolean) {
  if (v === full) return
  full = v
  emit()
  if (!bridge.isTauri) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setFullscreen(v)
  } catch {
    // 失败就回滚状态，别让按钮和实际窗口对不上
    full = !v
    emit()
  }
}

export async function toggleFullscreen() {
  await setFullscreen(!full)
}

/** 启动时跟一次真实状态（上次退出时如果还全屏，进来要一致） */
export async function syncFullscreen() {
  applyDom(full)
  if (!bridge.isTauri) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const v = await getCurrentWindow().isFullscreen()
    if (v !== full) { full = v; emit() }
  } catch { /* 预览环境没有窗口 API */ }
}

export function useFullscreen(): boolean {
  const [v, setV] = useState(full)
  useEffect(() => {
    const fn = (n: boolean) => setV(n)
    subs.add(fn)
    setV(full)
    return () => { subs.delete(fn) }
  }, [])
  return v
}
