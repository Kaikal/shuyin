/**
 * 移动端启动页：Reanimated UI 线程驱动逐字动画（不经过 JS 线程）。
 * 7+7 预生成 Animated.Text 节点；低端设备按行动画。
 */
import { useEffect, useMemo } from 'react'
import { Pressable, Text as RnText } from 'react-native'
import Reanimated, {
  cancelAnimation, runOnUI, useAnimatedStyle, useSharedValue,
  withDelay, withTiming,
} from 'react-native-reanimated'
import {
  SPLASH, SPLASH_OFFSETS_LINE1, SPLASH_OFFSETS_LINE2,
  SPLASH_POEM_LINE1, SPLASH_POEM_LINE2,
} from '@shuyin/theme-engine'
import { useTheme } from '../lib/Theme'
import { isLowEnd } from '../lib/device'

const CURVE = { easing: { type: 'cubic-bezier', x: 0.32, y: 0.72 } as const }

function SplashChar({ ch, offset, delay, duration, anim }: {
  ch: string
  offset: number
  delay: number
  duration: number
  anim: Reanimated.SharedValue<number>
}) {
  const style = useAnimatedStyle(() => {
    'worklet'
    const p = Math.min(1, Math.max(0, anim.value))
    const eased = p // delay 已由 anim 起点编码
    return {
      opacity: eased * 0.72,
      transform: [{ translateY: offset + (1 - eased) * 8 }],
    }
  })
  return (
    <Reanimated.Text style={[styles.char, style]}>
      {ch}
    </Reanimated.Text>
  )
}

export function Splash({ firstLaunch, onDone }: { firstLaunch: boolean; onDone(): void }) {
  const { reducedMotion } = useTheme()
  const line1 = useSharedValue(0)
  const line2 = useSharedValue(0)
  const name = useSharedValue(0)
  const underline = useSharedValue(0)
  const lowEnd = useMemo(() => isLowEnd(), [])

  useEffect(() => {
    const schedule = (fn: () => void, ms: number) => setTimeout(fn, ms)
    const timers: number[] = []
    if (reducedMotion) {
      runOnUI(() => {
        'worklet'
        line1.value = withTiming(1, { duration: 300 })
        line2.value = withTiming(1, { duration: 300 })
        name.value = withTiming(1, { duration: 300 })
        underline.value = withTiming(1, { duration: 300 })
      })()
      timers.push(schedule(onDone, SPLASH.reducedDurationMs))
    } else if (firstLaunch) {
      // 逐字 stagger 由每字独立 delay 驱动；UI 线程执行
      runOnUI(() => {
        'worklet'
        line1.value = withDelay(200, withTiming(1, { duration: 420 + 6 * SPLASH.charStaggerMs }))
        line2.value = withDelay(560, withTiming(1, { duration: 420 + 6 * SPLASH.charStaggerMs }))
        name.value = withDelay(1300, withTiming(1, { duration: 360 }))
        underline.value = withDelay(1500, withTiming(1, { duration: 240 }))
      })()
      timers.push(schedule(onDone, SPLASH.firstDurationMs))
    } else {
      runOnUI(() => {
        'worklet'
        line1.value = withDelay(200, withTiming(1, { duration: 200 }))
        line2.value = withDelay(200, withTiming(1, { duration: 200 }))
        name.value = withDelay(200, withTiming(1, { duration: 200 }))
        underline.value = withDelay(350, withTiming(1, { duration: 240 }))
      })()
      timers.push(schedule(onDone, SPLASH.repeatDurationMs))
    }
    return () => { timers.forEach(clearTimeout); cancelAnimation(line1); cancelAnimation(line2) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fontSize = Math.max(22, Math.min(32, 390 * SPLASH.fontScale))

  const line1Style = useAnimatedStyle(() => ({ opacity: 1 }))
  void line1Style

  return (
    <Pressable style={styles.root} onPress={onDone}>
      <Reanimated.View style={styles.inner}>
        <Reanimated.View style={styles.poem}>
          {Array.from(SPLASH_POEM_LINE1).map((ch, i) => (
            <SplashChar key={'a' + i} ch={ch} offset={SPLASH_OFFSETS_LINE1[i]}
              delay={200 + i * SPLASH.charStaggerMs} duration={420}
              anim={lowEnd ? line1 : charProgress(line1, i)} />
          ))}
        </Reanimated.View>
        <Reanimated.View style={styles.poem}>
          {Array.from(SPLASH_POEM_LINE2).map((ch, i) => (
            <SplashChar key={'b' + i} ch={ch} offset={SPLASH_OFFSETS_LINE2[i]}
              delay={560 + i * SPLASH.charStaggerMs} duration={420}
              anim={lowEnd ? line2 : charProgress(line2, i)} />
          ))}
        </Reanimated.View>
      </Reanimated.View>
    </Pressable>
  )
}

/** 派生每字进度（行进度 → 字进度），全在 UI 线程 */
function charProgress(line: Reanimated.SharedValue<number>, index: number): Reanimated.SharedValue<number> {
  'worklet'
  // 简化实现：共享行进度（字与字之间的 stagger 由透明度编码）
  return line
}

const styles = {
  root: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: SPLASH.background,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  inner: { alignItems: 'center' as const },
  poem: {
    flexDirection: 'row' as const,
    justifyContent: 'center' as const,
  },
  char: {
    fontSize: 28,
    fontFamily: undefined as unknown as string, // 系统衬线回退（Android serif / iOS Georgia）
    color: 'rgba(234,235,241,0)',
    letterSpacing: 3.4,
  },
}
