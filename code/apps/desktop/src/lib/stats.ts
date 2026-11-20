/**
 * 匿名使用统计（2026-11-20 用户拍板）。
 *
 * 目的只有一个：开发者想知道「有多少人在用」。上报刻意保持最小：
 *   · app   —— 形态：phone / car / desk（车机包是独立 applicationId）
 *   · ver   —— 当前版本号
 *   · mid   —— 装机号：首次运行时随机生成、落盘的 UUID。
 *     注意它**不是**硬件地址：拿 MAC/序列号既拿不到也不该拿；
 *     随机号区分机器的效果一样，换机/清数据就是一台新机器。
 *   · t     —— 事件类型：ping（每天首次启动）/ dl（APK 下载完成）
 *
 * 隐私边界：没有账号、没有设备指纹、没有位置、没有任何使用内容；
 * 服务器只留一份「装机号 → 最后上线时间/版本」的映射。
 *
 * **端点未配置时整个模块是 no-op**：不连网、不写盘，调用方不用判空。
 * 失败一律静默——统计是锦上添花，断网/端点抽风不许影响应用本身。
 */
import { bridge } from './bridge'
import { androidAppInfo } from './native/android'
import { settings, KEYS } from './settings'

/**
 * 统计端点（云端函数地址）。开通云服务后由部署脚本写进来；
 * 空串 = 统计关闭。
 */
export const STAT_ENDPOINT = ''

const PING_GAP = 24 * 60 * 60 * 1000

/** 装机号：没有就生成一个。crypto 不可用时退回 Math.random 拼一段 */
async function machineId(): Promise<string> {
  const got = await settings.get<string>(KEYS.statMachine)
  if (got) return got
  let id = ''
  try {
    id = crypto.randomUUID()
  } catch {
    id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
  await settings.set(KEYS.statMachine, id)
  return id
}

/** 形态：车机包 / 手机包 / 桌面 */
function appKind(): 'phone' | 'car' | 'desk' {
  if (bridge.isTauri) return 'desk'
  if (bridge.isAndroid) return androidAppInfo().car ? 'car' : 'phone'
  return 'phone'
}

/** 出网统一走 net_request（三端同一条路，见 Bridge.kt / net.rs） */
async function post(payload: Record<string, unknown>): Promise<void> {
  const res = await bridge.invoke<{ status: number }>('net_request', {
    req: {
      url: STAT_ENDPOINT,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 8000,
    },
  })
  if (!res || res.status >= 400) throw new Error(`stat HTTP ${res?.status ?? '?'}`)
}

/**
 * 每天首次启动上报一次心跳。失败静默，且**失败不写时间戳**——
 * 下次启动再试，别让一次断网吃掉一整天的样本。
 */
export async function statPing(): Promise<void> {
  if (!STAT_ENDPOINT || !bridge.isNative) return
  const last = (await settings.get<number>(KEYS.statLastPing)) ?? 0
  if (Date.now() - last < PING_GAP) return
  try {
    await post({
      t: 'ping',
      app: appKind(),
      ver: await bridge.invoke<string>('app_version').catch(() => ''),
      mid: await machineId(),
      at: Date.now(),
    })
    await settings.set(KEYS.statLastPing, Date.now())
  } catch { /* 静默：统计不许影响应用 */ }
}

/** APK 下载完成（应用内更新装包）时上报。失败静默。 */
export async function statDownload(ver: string): Promise<void> {
  if (!STAT_ENDPOINT || !bridge.isNative) return
  try {
    await post({
      t: 'dl',
      app: appKind(),
      ver,
      mid: await machineId(),
      at: Date.now(),
    })
  } catch { /* 静默 */ }
}
