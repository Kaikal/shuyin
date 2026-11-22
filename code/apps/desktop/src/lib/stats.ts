/**
 * 匿名使用统计（2026-11-20 用户拍板，2026-11-22 改口径）。
 *
 * 要回答的是两个数：
 *   · 有多少人用过 —— 每台设备首次启动上报一次，服务端按装机号落一个文件，
 *     文件数就是「装过并跑过疏音的设备数」。**跟下载渠道无关**：从官网、
 *     从 Gitee、别人传的 APK 都算，只要 App 真跑起来过一次。
 *   · 今天有多少人在用 —— 每天首次启动的心跳，服务端按天分目录，
 *     当天目录里的文件数就是日活。
 *
 * 上报刻意保持最小：
 *   · app   —— 形态：phone / car / desk
 *   · ver   —— 当前版本号
 *   · mid   —— 装机号：首次运行时随机生成、落盘的 UUID。
 *     注意它**不是**硬件地址：拿 MAC/序列号既拿不到也不该拿；
 *     随机号区分机器的效果一样，换机/清数据就是一台新机器
 *     （所以「多少人用过」会略微高估，重装算新设备）。
 *   · dev   —— 机型标签（只在 `first` 里带一次）：型号/厂商/系统版本/屏幕/语言。
 *     用途只有一个：知道大家在什么机器上跑，出「某几个机型卡顿」时能定位。
 *     **没有** IMEI / ANDROID_ID / 序列号 / MAC / 手机号——这些既拿不到也不该拿，
 *     机型是全人类共用的标签，反查不到任何个人。
 *   · t     —— 事件类型：first（只发一次）/ ping（每天首次启动）/ dl（装包完成）
 *
 * 隐私边界：没有账号、没有设备指纹、没有位置、没有任何使用内容。
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

/**
 * 每日心跳（`ping`）总开关，默认**关**（2026-11-22 拍板：先只上 `first`）。
 *
 * 为什么关：CloudBase 新版环境的云存储建在 PG 上，写一次存储就唤醒一次
 * PG 的计费窗口（5 分钟一个，窗口内有任何访问就算 0.04167 CU，与请求数无关）。
 * `first` 一辈子只发一次、只有新设备首次启动才写，代价可以忽略；而 `ping`
 * 是每台设备每天一次，上千台设备散落在全天 = PG 全天不睡 = 每月几十倍放大消耗。
 *
 * 也就是说：**这个开关一打开，「多少人用过」不受影响，但「今天多少人在用」
 * 会开始吃掉额度**。真要开，先想清楚是不是接受这个代价。
 */
export const STAT_PING_ENABLED = false

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

/** 版本号取不到就发空串，服务端会当 unknown 处理 */
async function appVersion(): Promise<string> {
  try {
    return await bridge.invoke<string>('app_version')
  } catch {
    return ''
  }
}

/**
 * 机型标签：**匿名、粗粒度、只随 first 发一次**。
 *
 * 想知道的是「有多少人在小屏/低版本安卓上跑」，用来判断优化方向；
 * 不是「这个人是谁」。所以这里刻意只取这些：
 * 型号（Build.MODEL）、厂商（Build.MANUFACTURER）、系统版本号、屏幕 CSS 尺寸、像素比、语言。
 *
 * 拿不到的也列清楚：手机号、IMEI、ANDROID_ID、序列号、MAC 一律不取——
 * 安卓 10 起前几项普通应用已经读不到了，而后几项属于设备指纹，跟统计目的无关。
 */
function deviceTag(): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  if (bridge.isAndroid) {
    const a = androidAppInfo()
    if (a.device) out.model = a.device
    if (a.brand) out.brand = a.brand
    if (a.sdk) out.sdk = a.sdk
  }
  /*
   * 系统单独标一个：`app` 字段只有 phone/car/desk 三档，
   * 而 iOS 和 macOS 都是 Tauri（都落进 desk），桌面版也混在里面。
   * 有了 os 才分得清「多少人装了 iOS 版」。
   */
  const os = osTag()
  if (os) out.os = os
  if (typeof window !== 'undefined') {
    const s = window.screen
    /* CSS 像素（不是物理像素）：看布局压力用这个比看分辨率准 */
    if (s && s.width) out.w = s.width
    if (s && s.height) out.h = s.height
    const dpr = window.devicePixelRatio
    if (dpr) out.dpr = Math.round(dpr * 100) / 100
  }
  if (typeof navigator !== 'undefined' && navigator.language) out.lang = navigator.language
  return out
}

/** 系统标识。不比 UA 更细——够区分 ios / mac / win / linux 就行 */
function osTag(): string {
  if (bridge.isAndroid) return 'android'
  if (typeof navigator === 'undefined') return ''
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  /* iPadOS 13 起默认要桌面 UA（Macintosh），靠触点数认出来 */
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'ios' : 'mac'
  if (/Windows/.test(ua)) return 'win'
  if (/Linux|Android/.test(ua)) return 'linux'
  return ''
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

  /*
   * 先做一次性登记。放在心跳之前是因为它只发一次、且决定「多少人用过」这个数：
   * 万一这条失败，后面还有整天的重试机会（每次启动都会进来一次）。
   * 成功才落标记——写早了就等于永久丢掉这台设备。
   */
  if (!(await settings.get<boolean>(KEYS.statRegistered))) {
    try {
      await post({
        t: 'first',
        app: appKind(),
        ver: await appVersion(),
        mid: await machineId(),
        /* 机型只在这一次带（一辈子一条），ping/dl 不带：省体积也少一层暴露 */
        dev: deviceTag(),
        at: Date.now(),
      })
      await settings.set(KEYS.statRegistered, true)
    } catch { /* 失败不标记，下次启动再试 */ }
  }

  /* 心跳总闸：现在只上 `first`（见 STAT_PING_ENABLED 的说明） */
  if (!STAT_PING_ENABLED) return

  const last = (await settings.get<number>(KEYS.statLastPing)) ?? 0
  if (Date.now() - last < PING_GAP) return
  try {
    await post({
      t: 'ping',
      app: appKind(),
      ver: await appVersion(),
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
