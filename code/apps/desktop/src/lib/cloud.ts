/**
 * 云端同步（腾讯云开发）。
 *
 * 三条硬约束决定了这里怎么写：
 *   1. **不登录必须完全可用**：所有云调用都在 try 里，失败只影响「同步」这一行，不影响播放。
 *   2. **envId 用户可改**：填在设置里，代码里给的是默认环境；换环境不用重装。
 *   3. **同步内容 = 配置包**：直接复用 backup.ts 的 collect/apply，
 *      保证「云端同步」和「U 盘拷配置包」覆盖的东西一模一样。
 *
 * **为什么存云存储而不是数据库**：
 * 新版云开发环境预置的是 PostgreSQL，没有文档库实例，`app.database()` 会直接报
 * `This environment has no document database instance`。要动 SQL 就得建表、配数据模型，
 * 而「一人一份配置」这种需求用数据库本来也过重。
 * 云存储按路径存取（`app.storage.from().upload/download`），跟环境用哪种数据库无关，
 * 零配置就能用——一个账号一个 JSON 文件，路径 = `shuyin-sync/<uid>.json`。
 */
import { KEYS, settings } from './settings'
import { applyBundle, collectBundle, type BackupBundle } from './backup'
import { cloudFetchActive, installCloudFetch } from './cloudFetch'

/*
 * 云开发的请求必须走原生代理，不能在 WebView 里发：
 * 浏览器调用会带 Origin，而安全来源白名单免费套餐改不了，必然 403。
 * 这里在模块加载时装上（SDK 是动态 import 的，一定晚于这里）。
 */
installCloudFetch()

/** 默认环境（用户提供）。可以在设置里改，存档优先 */
export const DEFAULT_ENV = 'basic-goldfish-d8gw3lzl9219b11d4'
/** 云存储里的同步目录（每个账号一个 JSON） */
export const SYNC_PREFIX = 'shuyin-sync'

/** 同步范围：勾了才同步（默认全开） */
export interface SyncScopes {
  playlists: boolean
  sources: boolean
  settings: boolean
  theme: boolean
}
export const DEFAULT_SCOPES: SyncScopes = { playlists: true, sources: true, settings: true, theme: true }

export interface CloudProfile {
  uid: string
  phone?: string
  email?: string
  nickname?: string
  at: number
}

let appCache: { env: string; app: any } | null = null

export async function getEnvId(): Promise<string> {
  const v = await settings.get<string>(KEYS.cloudEnv)
  return (v && v.trim()) || DEFAULT_ENV
}
export async function setEnvId(v: string): Promise<void> {
  await settings.set(KEYS.cloudEnv, v.trim())
  appCache = null
}

export async function getScopes(): Promise<SyncScopes> {
  const v = await settings.get<SyncScopes>(KEYS.cloudScopes)
  return { ...DEFAULT_SCOPES, ...(v ?? {}) }
}
export async function setScopes(s: SyncScopes): Promise<void> {
  await settings.set(KEYS.cloudScopes, s)
}

export async function loadProfile(): Promise<CloudProfile | null> {
  return await settings.get<CloudProfile>(KEYS.cloudProfile)
}
export async function saveProfile(p: CloudProfile | null): Promise<void> {
  await settings.set(KEYS.cloudProfile, p)
}

async function sdk(): Promise<any> {
  const m: any = await import('@cloudbase/js-sdk')
  // 3.x 同时有 default 与命名导出，按存在哪一个取
  return m?.default ?? m
}

/** 惰性初始化 SDK（浏览器预览里会抛，调用方兜住就行） */
export async function cloudApp(): Promise<any> {
  const env = await getEnvId()
  if (appCache && appCache.env === env) return appCache.app
  const cloudbase = await sdk()
  if (typeof cloudbase?.init !== 'function') throw new Error('云开发 SDK 未正确加载')
  const app = cloudbase.init({ env })
  appCache = { env, app }
  return app
}

async function authOf(app: any): Promise<any> {
  return app.auth({ persistence: 'local' })
}

/* ------------------------------------------------------------------ */
/* 登录：只做邮箱验证码                                                  */
/*                                                                     */
/* 手机号（短信）登录整条路撤掉了：短信要上海地域 + 腾讯云短信签名/模板   */
/* 审核，还要按条计费（约 0.05 元/条）。邮箱验证码用云开发的内置邮件代发， */
/* 零配置、不单独计费，对「偶尔同步一下配置」的场景完全够用。             */
/* ------------------------------------------------------------------ */

export interface Verification {
  id: string
  isUser: boolean
  /** SDK 原始返回。signInWithEmail 直接把它当 verificationInfo 传回 */
  raw?: any
}

/** 发邮箱验证码。云开发的「邮箱验证码」可以零配置开启（内置邮件代发） */
export async function sendEmailCode(email: string): Promise<Verification> {
  const app = await cloudApp()
  const auth = await authOf(app)
  const addr = email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw new Error('邮箱格式看着不对')
  const r = await auth.getVerification({ email: addr })
  const id = r?.verification_id
  if (!id) throw new Error('验证码没发出去（检查云开发是否开启了「邮箱验证码」并配好发件邮箱）')
  return { id, isUser: Boolean(r?.is_user), raw: r }
}

export async function signInWithEmail(email: string, code: string, v: Verification): Promise<CloudProfile> {
  const app = await cloudApp()
  const auth = await authOf(app)
  const addr = email.trim()
  await auth.signInWithEmail({
    verificationInfo: v.raw ?? { verification_id: v.id, is_user: v.isUser },
    verificationCode: code.trim(),
    email: addr,
  })
  const profile = await readProfile(auth)
  profile.email = addr
  await saveProfile(profile)
  return profile
}


async function readProfile(auth: any): Promise<CloudProfile> {
  let uid = ''
  let nick: string | undefined
  try {
    const u = await auth.getCurrentUser()
    uid = u?.uid ?? u?.userInfo?.uid ?? ''
    nick = u?.nickName ?? u?.nickname ?? u?.userInfo?.nickName ?? undefined
  } catch { /* 拿不到就用时间戳兜底 */ }
  return { uid: uid || `local-${Date.now().toString(36)}`, nickname: nick, at: Date.now() }
}

/** 启动时恢复登录态（有本地缓存就是登录状态） */
export async function restoreSession(): Promise<CloudProfile | null> {
  const saved = await loadProfile()
  if (!saved) return null
  try {
    const app = await cloudApp()
    const auth = await authOf(app)
    const u = await auth.getCurrentUser(true)
    if (!u) return null
    return { ...saved, uid: u?.uid ?? saved.uid, at: Date.now() }
  } catch {
    return saved
  }
}

export async function signOut(): Promise<void> {
  try {
    const app = await cloudApp()
    const auth = await authOf(app)
    await auth.signOut()
  } catch { /* 没登录 / 网络断了都当退出成功 */ }
  await saveProfile(null)
  await settings.set(KEYS.cloudLastSync, 0)
}

/* ------------------------------------------------------------------ */
/* 同步                                                                */
/* ------------------------------------------------------------------ */

function pickScopes(bundle: BackupBundle, sc: SyncScopes): BackupBundle {
  const keep = new Set<string>()
  if (sc.playlists) { keep.add(KEYS.localPlaylists); keep.add(KEYS.favPlaylists) }
  if (sc.theme) { keep.add(KEYS.activeTheme); keep.add(KEYS.mode); keep.add(KEYS.customThemes) }
  if (sc.settings) {
    for (const k of Object.keys(bundle.settings)) {
      if (k.startsWith('playlists.') || k.startsWith('theme.')) continue
      keep.add(k)
    }
  }
  const out: BackupBundle = {
    ...bundle,
    sources: sc.sources ? bundle.sources : [],
    settings: {},
  }
  for (const [k, v] of Object.entries(bundle.settings)) {
    if (keep.has(k)) out.settings[k] = v
  }
  return out
}

/** 把这个账号的同步文件路径算出来（同一个 uid 永远得到同一个路径） */
function syncPath(uid: string): string {
  return `${SYNC_PREFIX}/${fileId(uid)}.json`
}

/** 云存储的路径规则：只吃有限字符，uid 里可能有 `:` `@`，统一换成 `_` */
function fileId(uid: string): string {
  const safe = uid.replace(/[^0-9a-zA-Z_-]/g, '_').slice(0, 60)
  return safe || 'default'
}

/** 推到云端；返回推上去的字节数（给界面一句「已同步」的实感） */
export async function pushToCloud(profile: CloudProfile): Promise<number> {
  const app = await cloudApp()
  const sc = await getScopes()
  const bundle = pickScopes(await collectBundle(), sc)
  const payload = { ...bundle, updatedAt: Date.now(), uid: profile.uid }
  const text = JSON.stringify(payload)
  const box = app.storage.from()
  const { error } = await box.upload(syncPath(profile.uid), new Blob([text], { type: 'application/json' }))
  if (error) throw new Error(errText(error) || '上传失败')
  await settings.set(KEYS.cloudLastSync, payload.updatedAt)
  return text.length
}

/**
 * 从云端拉；没有记录返回 null（第一次同步不算错误）。
 *
 * 先 `exists` 再 `download`：文件不存在时 download 抛的是 COS 的 404，
 * 混在真正的错误里会让「第一次同步」看起来像失败。
 */
export async function pullFromCloud(profile: CloudProfile): Promise<BackupBundle | null> {
  const app = await cloudApp()
  const path = syncPath(profile.uid)
  const box = app.storage.from()

  const has = await box.exists(path)
  if (has.error) throw new Error(errText(has.error) || '读取云端失败')
  if (!has.data) return null

  const { data, error } = await box.download(path)
  if (error || !data) throw new Error(errText(error) || '下载失败')
  const text = typeof data === 'string' ? data : await data.text()
  if (!text) return null
  return JSON.parse(text) as BackupBundle
}

/** 拉下来直接套用（合并模式，不冲掉本机独有的歌单） */
export async function syncDown(profile: CloudProfile) {
  const bundle = await pullFromCloud(profile)
  if (!bundle) return null
  const report = await applyBundle(bundle, true)
  await settings.set(KEYS.cloudLastSync, Date.now())
  return report
}

/**
 * 从任意形态的错误里抠出一句人话。
 *
 * 云开发 SDK 抛的往往**不是 Error**，而是 `{ code, message }`、`{ error: {...} }`
 * 这类普通对象；`String(e)` 得到的是 `[object Object]`——用户盯着这串字符什么也做不了。
 * 这里按常见字段优先级递归找第一条非空文字，实在找不到才回到 code。
 */
export function errText(e: unknown): string {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): string => {
    if (v == null || depth > 4) return ''
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (v instanceof Error) return (v.message || '').trim()
    if (typeof v !== 'object') return ''
    if (seen.has(v)) return ''
    seen.add(v)
    const o = v as Record<string, unknown>
    for (const k of [
      'message', 'msg', 'errMsg', 'errmsg', 'errorMessage', 'error_description',
      'error', 'detail', 'details', 'data', 'cause', 'result',
    ]) {
      const s = walk(o[k], depth + 1)
      if (s) return s
    }
    const code = o.code ?? o.errorCode ?? o.errCode ?? o.err_code
    return code ? String(code) : ''
  }
  const s = walk(e, 0)
  return s && s !== '[object Object]' ? s : ''
}

/** 云开发/Auth 的英文错误码翻成人话。按「用户下一步该做什么」写，不复述技术细节 */
const CODE_HINTS: Array<[RegExp, string]> = [
  [/no document database|document database instance/i,
    '这个环境预置的是 PostgreSQL，没有文档库。新版同步已改走云存储，把程序更新到最新版即可'],
  [/STORAGE_NOT_OPEN|storage.*not.*(open|enable)|存储.*未开通/i,
    '这个环境还没开云存储：云开发控制台 → 存储 → 开通（同步就是把一份配置 JSON 存到那里）'],
  [/PERMISSION_DENIED|permission denied|403|STORAGE_EXCEED|NO_PERMISSION/i,
    '云存储拒绝了这次读写：控制台 → 存储 → 权限设置，选「所有用户可读，仅创建者可写」'],
  [/ENV_NOT_FOUND|INVALID_ENV|env.*not.*exist|env.*invalid/i,
    '环境 ID 不对：设置 → 账号与同步 → 云开发环境，填形如 xxx-1a2b3c4d 的环境 ID'],
  [/SAFE_DOMAIN|safe.?domain|domain.*not.*allowed|来源/i,
    '云开发拒绝了这次请求：桌面版已经改走本机直连，正常不该出现这条——把设置里的「复制诊断信息」发我'],
  [/LOGIN_METHOD|METHOD_NOT_ENABLED|NOT_ENABLED|NOT_SUPPORT|unsupported|SMS_NOT_OPEN/i,
    '邮箱验证码登录还没开启：云开发控制台 → 身份认证 → 登录方式 → 邮箱验证码 → 开启邮件代发'],
  [/SMTP|MAIL_CONFIG|email.*config|发送邮箱|sender/i,
    '发件邮箱没配好：云开发控制台 → 身份认证 → 登录方式 → 邮箱验证码 → 配置发件邮箱'],
  [/INVALID_VERIFICATION|VERIFICATION_CODE|INVALID_CODE|captcha|验证码/i,
    '验证码不对或已过期：重新发一次，5 分钟内有效'],
  [/EXCEED|FREQUENCY|TOO_MANY|LIMIT|rate/i,
    '操作太频繁了，等一分钟再试'],
  [/DNS|dns error|ENOTFOUND|no such host|域名/i,
    '找不到这个环境：环境 ID 拼错了（设置 → 账号与同步 → 云开发环境），或者本机 DNS 有问题'],
  [/NETWORK|TIMEOUT|Failed to fetch|ECONN|connect|连接/i,
    '连不上云开发：检查本机网络；开了代理/VPN 的话，先把系统代理关掉再试一次'],
]

/**
 * 本应用的页面来源。云开发控制台的「安全来源」里要填的就是这一串。
 * Tauri 打包后 Windows 是 `tauri.localhost`（不是 localhost，也不是 localhost:1420）——
 * 填错成开发地址是最常见的失败原因，所以界面上直接把真值显示出来给用户抄。
 */
export function appHost(): string {
  try {
    const h = window.location.host
    return h || 'tauri.localhost'
  } catch {
    return 'tauri.localhost'
  }
}

/** 最近一次云端请求的原始错误（诊断行用：翻译后的文案给人看，原文给排错用） */
let lastError = ''
export function lastCloudError(): string {
  return lastError
}
export function clearLastCloudError(): void {
  lastError = ''
}


/**
 * 把云开发的报错翻成一句中文。
 * 认不出来的错误不硬编：只要 SDK 给了可读文字就带上，但**绝不吐出 [object Object]**。
 */
export function humanizeCloudError(e: unknown): string {
  const msg = errText(e)
  // 原文留一份：翻译是给人看的，原文是排错用的（设置页「环境」里能看到）
  lastError = msg || (e instanceof Error ? e.message : String(e ?? ''))
  for (const [re, hint] of CODE_HINTS) {
    if (re.test(msg)) return hint
  }
  // 已经是中文（SDK 偶尔也会给中文提示）就直接用
  if (/[\u4e00-\u9fa5]/.test(msg)) return msg
  if (!msg) return '登录没成功，稍后再试一次'
  const short = msg.replace(/\s+/g, ' ').slice(0, 90)
  return `登录没成功：${short}`
}
