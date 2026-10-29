/**
 * 更新检查。
 *
 * 版本信息放在一个**公开**仓库的 `version.json` 里（`shuyin-update`）——
 * 源码仓库是私有的，匿名拉不到，所以单独开了一个只放这一个文件的库。
 *
 * 两条实现：
 *   桌面  → Rust 的 `check_update`（顺带把编译进去的版本号带回来）
 *   安卓  → `net_request` 拉 json，版本比较在 TS 里做（Kotlin 那边只加了 `app_version`）
 * 为什么要两套：桌面版本号在 Cargo.toml、安卓在 build.gradle，两个号本来就不一样
 * （0.5.x / 0.6.x），比较必须拿各自真实的当前版本。
 *
 * 检查失败**不弹错**：更新是锦上添花，断网或仓库抽风不该在用户面前报错。
 */
import { bridge } from './bridge'
import { settings, KEYS } from './settings'

export interface UpdateInfo {
  current: string
  latest: string
  has_update: boolean
  notes: string[]
  url: string
  date: string
  /** 强制更新（不显示「以后再说」） */
  force: boolean
}

const FEED = 'https://gitee.com/ghpgitee/shuyin-update/raw/master/version.json'

/** 两次自动检查的最小间隔：同一天连着开十次，不该查十次 */
const CHECK_GAP = 12 * 60 * 60 * 1000

/** 只认数字段：0.5.10 > 0.5.9；段数不同按 0 补齐 */
function versionGt(a: string, b: string): boolean {
  const seg = (s: string) => s.split(/[^0-9]+/).filter(Boolean).map(n => parseInt(n, 10) || 0)
  const pa = seg(a)
  const pb = seg(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** 安卓：用原生 net_request 拉一份 json（前端不能直接 fetch，见 net.rs 的铁律） */
async function fetchFeed(url: string): Promise<Record<string, unknown>> {
  const res = await bridge.invoke<{ status: number; body: string }>('net_request', {
    req: { url, method: 'GET', timeout: 8000 },
  })
  if (!res || res.status >= 400) throw new Error(`HTTP ${res?.status ?? '?'}`)
  return JSON.parse(res.body) as Record<string, unknown>
}

/** 查一次。失败返回 null。 */
export async function fetchUpdate(url?: string): Promise<UpdateInfo | null> {
  if (bridge.isTauri) {
    try {
      return await bridge.invoke<UpdateInfo>('check_update', { url: url ?? null })
    } catch {
      return null
    }
  }
  if (!bridge.isNative) return null
  try {
    const v = await fetchFeed(url || FEED)
    /* 两个平台的版本号本来就不同（桌面 0.5.x / 安卓 0.6.x），
       feed 里分字段给，别拿桌面的号去比安卓的包。 */
    const latest = String(v.android ?? '')
    if (!latest) return null
    const current = await bridge.invoke<string>('app_version').catch(() => '')
    return {
      current,
      latest,
      has_update: !!current && versionGt(latest, current),
      notes: Array.isArray(v.notes) ? v.notes.map(String) : [],
      url: String(v.android_url || v.url || ''),
      date: String(v.date ?? ''),
      force: v.force === true,
    }
  } catch {
    return null
  }
}

/**
 * 启动时自动查：有新版、且用户没对这个版本点过「以后再说」才返回它。
 * 顺带把「上次检查时间」写盘，避免频繁出网。
 */
export async function autoCheckUpdate(): Promise<UpdateInfo | null> {
  if (!bridge.isNative) return null
  const last = (await settings.get<number>(KEYS.updateLastAt)) ?? 0
  if (Date.now() - last < CHECK_GAP) return null
  const info = await fetchUpdate()
  if (!info) return null
  void settings.set(KEYS.updateLastAt, Date.now())
  if (!info.has_update) return null
  const skip = (await settings.get<string>(KEYS.updateSkip)) ?? ''
  if (skip === info.latest) return null
  return info
}

/** 记住「这个版本先不更新」 */
export async function skipVersion(v: string): Promise<void> {
  await settings.set(KEYS.updateSkip, v)
}

/** 用系统浏览器打开下载页；浏览器预览（非 Tauri / 非安卓）时退回 window.open */
export async function openDownload(url: string): Promise<void> {
  const u = url || 'https://gitee.com/ghpgitee/shuyin'
  if (bridge.isNative) {
    await bridge.invoke('open_url', { url: u }).catch(() => {})
    return
  }
  window.open(u, '_blank', 'noopener')
}
