/** 低端设备判定（缓存结果；精确判定在 ThemeProvider 内异步完成） */
let cached: boolean | null = null

export function isLowEnd(): boolean {
  if (cached !== null) return cached
  try {
    require('react-native-device-info')
    cached = false
    return cached
  } catch {
    return false
  }
}
