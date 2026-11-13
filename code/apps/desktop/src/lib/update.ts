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
import { androidAppInfo, onNative } from './native/android'
import { settings, KEYS } from './settings'

export interface UpdateInfo {
  current: string
  latest: string
  has_update: boolean
  notes: string[]
  url: string
  /** 备用下载地址（国内源打不开时用）。没有就空串 */
  urlAlt: string
  date: string
  /** 强制更新（不显示「以后再说」） */
  force: boolean
}

const FEED = 'https://gitee.com/ghpgitee/shuyin-update/raw/master/version.json'

/**
 * 两次自动检查的最小间隔。
 *
 * 原来是 12 小时，本意是「一天开十次别查十次」，实际后果是**新版本发布后
 * 头半天打开应用不会弹窗**（上次检查时间还在窗口里，直接 return null），
 * 用户只能自己去「关于」里手动点。更新提示的全部价值就在「及时」，
 * 一个 json 几百字节，多查几次不值一提 —— 缩到 3 分钟只挡连点/Activity 重建。
 */
const CHECK_GAP = 3 * 60 * 1000

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
       feed 里分字段给，别拿桌面的号去比安卓的包。
       车机包 applicationId 不同（装在同一台车上会变成两个应用），
       所以它另有一套字段；没写就退回手机那套。 */
    const car = bridge.isAndroid && androidAppInfo().car
    const latest = String((car ? (v.car ?? v.android) : v.android) ?? '')
    if (!latest) return null
    const current = await bridge.invoke<string>('app_version').catch(() => '')
    return {
      current,
      latest,
      has_update: !!current && versionGt(latest, current),
      notes: Array.isArray(v.notes) ? v.notes.map(String) : [],
      url: String((car ? (v.car_url ?? v.android_url) : v.android_url) || v.url || ''),
      urlAlt: String((car ? (v.car_url_alt ?? v.android_url_alt) : v.android_url_alt) || ''),
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

/* ------------------------------------------------------------------ *
 * 应用内下载安装（安卓）
 *
 * 为什么不再跳浏览器：手机上「点更新 → 打开浏览器 → 下完 → 通知栏里点开 →
 * 系统又拦一次『未知来源』」，四步里只要有一处卡住，用户就不知道自己在哪。
 * 现在整条链在应用里：进度条 → 下载完直接拉起系统安装器。
 *
 * 原生侧见 `app/src/main/java/cn/shuyin/player/UpdateApk.kt`：
 * 下载到 cacheDir/updates，完成前顺手查一次「允许安装未知应用」，
 * 没开就跳那个设置页，回来自动续上（状态走 `update_install`）。
 * ------------------------------------------------------------------ */

/** 下载进度。原生按 2% 节流推送，别每 64KB 刷一次 DOM */
export interface DlProgress {
  /** 0~100；不知道总长度时是 -1 */
  pct: number
  got: number
  total: number
}

export type InstallResult =
  /** 已经把安装器拉起来了（应用会被系统挂起，用户点「安装」） */
  | { status: 'installed'; path: string }
  /** 缺「安装未知应用」权限，原生已经跳到设置页 */
  | { status: 'need_perm'; path: string }

/** 订阅下载进度；返回取消订阅 */
export function onDownloadProgress(cb: (p: DlProgress) => void): () => void {
  if (!bridge.isAndroid) return () => {}
  return onNative('app://update-dl', raw => {
    const v = raw as Partial<DlProgress> | null
    if (!v) return
    cb({
      pct: typeof v.pct === 'number' ? v.pct : -1,
      got: Number(v.got) || 0,
      total: Number(v.total) || 0,
    })
  })
}

/** 文件名按版本走，系统安装器会用这个名字显示 */
function apkName(latest: string): string {
  return `shuyin-${latest}.apk`
}

/**
 * 下载并安装。先试主源（Gitee），失败自动换备用源（GitHub）——
 * 国内直连 GitHub 的 release 时快时慢，两个都试比只给一个稳。
 */
export async function downloadAndInstall(info: UpdateInfo): Promise<InstallResult> {
  if (!bridge.isAndroid) throw new Error('应用内安装只在安卓上可用')
  const urls = [info.url, info.urlAlt].filter(Boolean)
  if (!urls.length) throw new Error('更新地址是空的')
  const r = await bridge.invoke<InstallResult>('update_download', {
    urls,
    name: apkName(info.latest),
  })
  if (!r || !r.status) throw new Error('下载失败')
  return r
}

/** 从设置页授权回来之后续装（文件已经在缓存里） */
export async function installDownloaded(path: string): Promise<InstallResult> {
  return bridge.invoke<InstallResult>('update_install', { path })
}
