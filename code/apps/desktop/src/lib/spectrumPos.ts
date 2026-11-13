/**
 * 频谱摆放位置：全局共享一份选择，跟频谱样式一样不重挂载、靠订阅同步。
 *
 *   bottom  底部通栏（默认，沉浸式页原来就在这儿；主界面落在播放条上方）
 *   top     贴窗口顶边，横向铺满
 *   left    贴窗口左边，纵向铺满
 *   right   贴窗口右边，纵向铺满
 *   cover   环绕专辑封面（沉浸式大封面 / 播放条小封面）
 */
import { useEffect, useState } from 'react'
import { KEYS, settings } from './settings'

export type SpectrumPos = 'bottom' | 'top' | 'left' | 'right' | 'cover'

export const SPECTRUM_POSITIONS: Array<{ id: SpectrumPos; name: string; desc: string }> = [
  { id: 'bottom', name: '底部', desc: '贴窗口下沿，柱子向上生长（默认）' },
  { id: 'top', name: '顶部', desc: '贴窗口上沿，一直铺到标题栏，柱子向下生长' },
  { id: 'left', name: '左侧', desc: '贴窗口左沿，柱子向右生长' },
  { id: 'right', name: '右侧', desc: '贴窗口右沿，柱子向左生长' },
  { id: 'cover', name: '封面环绕', desc: '围着播放页的方形封面转一圈' },
]

const isPos = (v: unknown): v is SpectrumPos =>
  typeof v === 'string' && SPECTRUM_POSITIONS.some(p => p.id === v)

let current: SpectrumPos = 'bottom'
let touched = false
let booting: Promise<void> | null = null
const subs = new Set<(p: SpectrumPos) => void>()

function emit(p: SpectrumPos) {
  subs.forEach(fn => fn(p))
}

function boot() {
  if (!booting) {
    booting = settings.get<SpectrumPos>(KEYS.spectrumPos).then(v => {
      if (!touched && isPos(v) && v !== current) {
        current = v
        emit(v)
      }
    }).catch(() => { /* 读不到就用默认位置 */ })
  }
  return booting
}

export function getSpectrumPos(): SpectrumPos {
  return current
}

export function setSpectrumPos(p: SpectrumPos) {
  if (!isPos(p)) return
  touched = true
  current = p
  emit(p)
  void settings.set(KEYS.spectrumPos, p)
}

export function spectrumPosName(p: SpectrumPos): string {
  return SPECTRUM_POSITIONS.find(x => x.id === p)?.name ?? '播放条'
}

export function useSpectrumPos(): [SpectrumPos, (p: SpectrumPos) => void] {
  const [p, setP] = useState<SpectrumPos>(current)
  useEffect(() => {
    const fn = (v: SpectrumPos) => setP(v)
    subs.add(fn)
    setP(current)
    void boot()
    return () => { subs.delete(fn) }
  }, [])
  return [p, setSpectrumPos]
}

/* ------------------------------------------------------------------ */
/* 手机：播放页里的摆放位置                                             */
/* ------------------------------------------------------------------ */

/**
 * 手机只有一块竖屏，桌面那五个「贴窗口四边」的位置照搬过来没意义
 * （贴边光带在小屏上挡手，而且和唱片外圈那圈重复）。
 * 这里给三个**播放页内**的位置，都能一眼看出差别：
 *
 *   art     封面 / 唱片外圈（默认，也是原来唯一的一种）
 *   bottom  底部通栏，控制区上方；六种样式在这条上才真的看得出区别
 *   top     顶部通栏，歌名上方
 */
export type MobileSpecPos = 'art' | 'bottom' | 'top'

export const MOBILE_SPEC_POSITIONS: Array<{ id: MobileSpecPos; name: string; desc: string }> = [
  { id: 'art', name: '封面外圈', desc: '唱片 / 封面周围一圈（默认）' },
  { id: 'bottom', name: '页面底部', desc: '控制区上方一条，六种样式都看得见' },
  { id: 'top', name: '页面顶部', desc: '歌名上方一条' },
]

const isMPos = (v: unknown): v is MobileSpecPos =>
  typeof v === 'string' && MOBILE_SPEC_POSITIONS.some(p => p.id === v)

let mCurrent: MobileSpecPos = 'art'
let mTouched = false
let mBooting: Promise<void> | null = null
const mSubs = new Set<(p: MobileSpecPos) => void>()

function mEmit(p: MobileSpecPos) {
  mSubs.forEach(fn => fn(p))
}

function mBoot() {
  if (!mBooting) {
    mBooting = settings.get<MobileSpecPos>(KEYS.spectrumPosMobile).then(v => {
      if (!mTouched && isMPos(v) && v !== mCurrent) {
        mCurrent = v
        mEmit(v)
      }
    }).catch(() => { /* 读不到就用默认 */ })
  }
  return mBooting
}

export function mobileSpecPosName(p: MobileSpecPos): string {
  return MOBILE_SPEC_POSITIONS.find(x => x.id === p)?.name ?? '封面外圈'
}

export function setMobileSpecPos(p: MobileSpecPos) {
  if (!isMPos(p)) return
  mTouched = true
  mCurrent = p
  mEmit(p)
  void settings.set(KEYS.spectrumPosMobile, p)
}

export function useMobileSpecPos(): [MobileSpecPos, (p: MobileSpecPos) => void] {
  const [p, setP] = useState<MobileSpecPos>(mCurrent)
  useEffect(() => {
    const fn = (v: MobileSpecPos) => setP(v)
    mSubs.add(fn)
    setP(mCurrent)
    void mBoot()
    return () => { mSubs.delete(fn) }
  }, [])
  return [p, setMobileSpecPos]
}
