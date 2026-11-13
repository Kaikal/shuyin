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
import { applyBundle, collectBundle, mergeLists, type BackupBundle } from './backup'
import { cloudFetchActive, installCloudFetch } from './cloudFetch'

/*
 * 云开发的请求必须走原生代理，不能在 WebView 里发：
 * 浏览器调用会带 Origin，而安全来源白名单免费套餐改不了，必然 403。
 * 这里在模块加载时装上（SDK 是动态 import 的，一定晚于这里）。
 */
installCloudFetch()

/** 默认环境（用户提供）。可以在设置里改，存档优先 */
export const DEFAULT_ENV = 'basic-goldfish-d8gw3lzl9219b11d4'
/**
 * 同步文件在桶里的路径：`<uid>/sync.json`。
 *
 * **第一级目录必须是 uid**，不是审美问题：PG 模式云存储的权限靠 RLS，
 * 官方策略写法就是 `(storage.foldername(name))[1] = auth.uid()`。
 * 把文件放进 `shuyin-sync/<uid>.json` 这种「uid 在第二级」的路径，
 * 策略一对就 403（自己读自己的文件都读不到）。
 */
export const SYNC_FILE = 'sync.json'
/** 存储桶默认名。PG 模式的环境不会自动建桶，这个名字在设置里可改 */
export const DEFAULT_BUCKET = 'shuyin'

/**
 * 一次性建桶 SQL。
 *
 * 为什么非要人跑一次：PG 模式的云存储把桶放在 `storage.buckets` 表里，
 * 客户端角色（authenticated）没有建桶权限，`app.storage.createBucket()`
 * 直接回 403 `STORAGE_ACCESS_DENIED`。控制台里跑一次这段，之后永远不用再管。
 *
 * 策略只放「自己目录下的对象」：路径第一级是 uid（见 `SYNC_FILE` 上面的说明），
 * 所以一个人的配置别人读不到，也不需要「所有用户可读」那种宽权限。
 */
export const BUCKET_SETUP_SQL = `-- 疏音 · 云端同步：建桶 + 只允许读写自己目录
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('${DEFAULT_BUCKET}', '${DEFAULT_BUCKET}', false, 10485760)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS shuyin_select_own ON storage.objects;
CREATE POLICY shuyin_select_own ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = '${DEFAULT_BUCKET}' AND (storage.foldername(name))[1] = auth.uid());

DROP POLICY IF EXISTS shuyin_insert_own ON storage.objects;
CREATE POLICY shuyin_insert_own ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = '${DEFAULT_BUCKET}' AND (storage.foldername(name))[1] = auth.uid());

DROP POLICY IF EXISTS shuyin_update_own ON storage.objects;
CREATE POLICY shuyin_update_own ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = '${DEFAULT_BUCKET}' AND (storage.foldername(name))[1] = auth.uid())
  WITH CHECK (bucket_id = '${DEFAULT_BUCKET}' AND (storage.foldername(name))[1] = auth.uid());

DROP POLICY IF EXISTS shuyin_delete_own ON storage.objects;
CREATE POLICY shuyin_delete_own ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = '${DEFAULT_BUCKET}' AND (storage.foldername(name))[1] = auth.uid());

-- 可选：让客户端能列出桶，这样桶名换一个也能被自动认出来
DROP POLICY IF EXISTS buckets_select_all ON storage.buckets;
CREATE POLICY buckets_select_all ON storage.buckets FOR SELECT TO anon, authenticated
  USING (true);`

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
  bucketCache = null
}

export async function getBucketName(): Promise<string> {
  const v = await settings.get<string>(KEYS.cloudBucket)
  return (v && v.trim()) || DEFAULT_BUCKET
}
export async function setBucketName(v: string): Promise<void> {
  await settings.set(KEYS.cloudBucket, v.trim())
  bucketCache = null
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

/* ------------------------------------------------------------------ */
/* 会话：把登录态从上一进程接回来                                        */
/* ------------------------------------------------------------------ */

/**
 * 云开发 SDK 只把**用户资料**写进 localStorage（`user_info_<env>`），
 * token 不落盘。进程一退（换包、系统回收、用户划掉），下次启动
 * `getCurrentUser()` 就是 null —— 表现是「明明登录过，同步却一直失败」，
 * 而用户根本没有"我掉线了"的概念，只会觉得功能坏了。
 *
 * 所以自己存一份 refresh_token：登录成功后取一次，启动时用
 * `auth.setSession()` 换回会话。换不回来（过期 / 被吊销）就安静地当没登录，
 * 等下次登录再存一份新的。
 */
let authCache: { app: any; auth: any } | null = null
let sessionTried = false

async function authOf(app: any): Promise<any> {
  if (authCache && authCache.app === app) return authCache.auth
  const auth = app.auth({ persistence: 'local' })
  authCache = { app, auth }
  await restoreSessionToken(auth)
  return auth
}

async function restoreSessionToken(auth: any): Promise<void> {
  if (sessionTried) return
  sessionTried = true
  const rt = await settings.get<string>(KEYS.cloudSession)
  if (!rt) return
  try {
    const u = await auth.getCurrentUser()
    if (u) return
  } catch { /* 没登录，继续往下换 */ }
  try {
    await auth.setSession(rt)
  } catch {
    await settings.set(KEYS.cloudSession, null)
  }
}

async function rememberSession(auth: any): Promise<void> {
  try {
    const r = await auth.getSession()
    const s = r?.data?.session ?? r?.session ?? r?.data ?? r
    const rt = s?.refresh_token ?? s?.refreshToken
    if (rt) await settings.set(KEYS.cloudSession, rt)
  } catch { /* 拿不到就算了：大不了下次重新收验证码 */ }
}

/** 同步前确认登录态还在，不然 SDK 只会给一句无信息量的「上传失败」 */
async function requireLogin(app: any): Promise<void> {
  const auth = await authOf(app)
  let u: any = null
  try {
    u = await auth.getCurrentUser()
  } catch { /* 下面统一报 */ }
  if (!u) throw new Error('登录状态已失效，请重新登录后再同步')
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
  await rememberSession(auth)
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
    if (!u) {
      /*
       * 会话是真的没了（refresh_token 也换不回来），本地资料一并清掉。
       * 留着它只有一个后果：界面一直显示「已登录」，点同步却只得到一句
       * 「上传失败」——用户完全不知道发生了什么。宁可让他看到「未登录」。
       */
      await saveProfile(null)
      return null
    }
    return { ...saved, uid: u?.uid ?? saved.uid, at: Date.now() }
  } catch {
    // 网络问题不该当成掉线：保留本地资料，下次打开再试
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
  await settings.set(KEYS.cloudSession, null)
  // 主动退出就别在本次进程里用旧 refresh_token 去换回来了
  sessionTried = true
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

/**
 * 当前环境里该用哪个桶。
 *
 * PG 模式的云存储**不会自动建桶**（`size/buckets` 是普通表，一行一个桶），
 * 没桶时上传下载一律回 `STORAGE_BUCKET_NOT_FOUND`——用户看到的正是这条。
 * 客户端没有建桶权限（`createBucket` 直接 403 `STORAGE_ACCESS_DENIED`），
 * 所以这里只能「找」：列一下桶列表，有就认，没有就用默认名（后续报错里给建桶 SQL）。
 *
 * 三个优先级：设置里填的 > 名叫 shuyin 的 > 列表里第一个。
 * 用户自己建了个别的名字的桶，也能被自动认出来，不用去设置里改。
 */
let bucketCache: { env: string; name: string } | null = null

async function resolveBucket(app: any): Promise<string> {
  const env = await getEnvId()
  if (bucketCache && bucketCache.env === env) return bucketCache.name

  let name = await getBucketName()
  try {
    const r = await app.storage.listBuckets({ limit: 100 })
    const list: any[] = Array.isArray(r?.data) ? r.data : []
    const names = list
      .map(b => b?.name ?? b?.id ?? b?.bucketId)
      .filter((x): x is string => typeof x === 'string' && !!x)
    if (names.length && !names.includes(name)) {
      name = names.includes(DEFAULT_BUCKET) ? DEFAULT_BUCKET : names[0]
    }
  } catch { /* 列不出来（没给 buckets 的读策略）就用默认名，让下一步的报错说话 */ }

  bucketCache = { env, name }
  return name
}

async function boxOf(app: any): Promise<any> {
  return app.storage.from(await resolveBucket(app))
}

/** 把这个账号的同步文件路径算出来（同一个 uid 永远得到同一个路径） */
function syncPath(uid: string): string {
  return `${fileId(uid)}/${SYNC_FILE}`
}

/** 云存储的路径规则：只吃有限字符，uid 里可能有 `:` `@`，统一换成 `_` */
function fileId(uid: string): string {
  const safe = uid.replace(/[^0-9a-zA-Z_-]/g, '_').slice(0, 60)
  return safe || 'default'
}

export interface PushReport {
  /** 传上去的字节数 */
  bytes: number
  /** 云端有、本机没有，这次合并进来的歌单数（>0 时界面要刷新一次） */
  adopted: number
}

/**
 * 推到云端。
 *
 * **先拉再推，按「合并」写**——这不是优化，是数据安全。
 *
 * 上一版是「本机整包 upsert」：在一台刚装好、还什么都没同步的设备上点
 * 「立即同步」，本机的 `[]` 会把云端已有的歌单直接覆盖成空数组。
 * 用户 2026-11 就这么丢的：平板显示 0 个歌单，回 Windows 看还有，
 * 再在任意一端点「从云端恢复」都只能恢复出 0 个——因为云端那份已经空了。
 * 之后每台设备都会「同步成功」，但什么也不会同步过来。
 *
 * 现在的规则：
 *   · 歌单（自建 / 收藏）**合并**：两边的并集，同 id 以本机为准；
 *   · 其余设置项仍以本机为准（那是「我在这台机器上的当前状态」，合并没意义）；
 *   · 合并结果同时写回本机，所以推完云端那些歌单在本机也看得见。
 *
 * 拉失败（弱网、桶刚建、文件还没生成）不算错误，退回「本机整包上传」。
 */
export async function pushToCloud(profile: CloudProfile): Promise<PushReport> {
  const app = await cloudApp()
  await requireLogin(app)
  const sc = await getScopes()
  const local = pickScopes(await collectBundle(), sc)

  let remote: BackupBundle | null = null
  try {
    remote = await pullFromCloud(profile)
  } catch { remote = null }

  const remoteSettings = (remote?.settings ?? {}) as Record<string, unknown>
  const mergedSettings: Record<string, unknown> = { ...local.settings }
  let adopted = 0
  if (sc.playlists && remote) {
    for (const k of [KEYS.localPlaylists, KEYS.favPlaylists]) {
      const before = Array.isArray(mergedSettings[k]) ? (mergedSettings[k] as unknown[]).length : 0
      const next = mergeLists(mergedSettings[k], remoteSettings[k])
      mergedSettings[k] = next
      const delta = next.length - before
      if (delta > 0) {
        adopted += delta
        /* 合并结果写回本机：否则「点了同步」在本机看不到任何变化 */
        await settings.set(k, next)
      }
    }
  }

  const payload = { ...local, settings: mergedSettings, updatedAt: Date.now(), uid: profile.uid }
  const text = JSON.stringify(payload)
  const box = await boxOf(app)
  const blob = new Blob([text], { type: 'application/json' })
  const { error } = await box.upload(syncPath(profile.uid), blob, {
    contentType: 'application/json',
    upsert: true,
  })
  if (error) throw new Error(errText(error) || '上传失败')
  await settings.set(KEYS.cloudLastSync, payload.updatedAt)
  return { bytes: text.length, adopted }
}

/**
 * 从云端拉；没有记录返回 null（第一次同步不算错误）。
 *
 * 先 `exists` 再 `download`：文件不存在时 download 抛的是 COS 的 404，
 * 混在真正的错误里会让「第一次同步」看起来像失败。
 */
export async function pullFromCloud(profile: CloudProfile): Promise<BackupBundle | null> {
  const app = await cloudApp()
  await requireLogin(app)
  const path = syncPath(profile.uid)
  const box = await boxOf(app)

  const has = await box.exists(path)
  if (has.error) throw new Error(errText(has.error) || '读取云端失败')
  if (!has.data) return null

  const { data, error } = await box.download(path)
  if (error || !data) throw new Error(errText(error) || '下载失败')
  const text = typeof data === 'string' ? data : await data.text()
  if (!text) return null
  /*
   * 云端文件不可读时给一句能执行的建议，而不是把 `JSON.parse` 的
   * 「No number after minus sign in JSON at position 1」直接糊到用户脸上——
   * 那句话对用户没有任何意义（那是早期的上传把 multipart 当文本发出去、
   * 文件开头成了 `------` 边界留下的残骸）。重新同步一次会覆盖掉它。
   */
  try {
    return JSON.parse(text) as BackupBundle
  } catch {
    throw new Error('云端备份已损坏，请点「立即同步」用本机数据覆盖一次')
  }
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
  [/STORAGE_BUCKET_NOT_FOUND|bucket not found/i,
    '云端存储尚未初始化：设置 → 账号与同步 → 云开发环境 → 复制建桶 SQL，在控制台运行一次后重试'],
  [/STORAGE_ACCESS_DENIED|row-level security|new row violates|RLS|policy/i,
    '存储桶权限未配置：请运行「建桶 SQL」中的权限部分'],
  [/STORAGE_FILE_NONEXIST|STORAGE_NOT_EXIST/i,
    '云端文件不存在，请重新同步一次'],
  [/no document database|document database instance/i,
    '当前云环境不支持这种方式，请更新到最新版本'],
  [/STORAGE_NOT_OPEN|storage.*not.*(open|enable)|存储.*未开通/i,
    '云存储未开通，请在控制台「存储」中开通'],
  [/PERMISSION_DENIED|permission denied|403|STORAGE_EXCEED|NO_PERMISSION/i,
    '云存储拒绝了本次读写，请检查存储桶权限'],
  [/ENV_NOT_FOUND|INVALID_ENV|env.*not.*exist|env.*invalid/i,
    '环境 ID 有误，请在设置中填写形如 xxx-1a2b3c4d 的环境 ID'],
  [/SAFE_DOMAIN|safe.?domain|domain.*not.*allowed|来源/i,
    '云开发拒绝了本次请求，请复制诊断信息后反馈'],
  [/LOGIN_METHOD|METHOD_NOT_ENABLED|NOT_ENABLED|NOT_SUPPORT|unsupported|SMS_NOT_OPEN/i,
    '未开启邮箱验证码登录，请在控制台「身份认证 → 登录方式 → 邮箱验证码」中开启邮件代发'],
  [/SMTP|MAIL_CONFIG|email.*config|发送邮箱|sender/i,
    '未配置发件邮箱，请在控制台「身份认证 → 邮箱验证码」中配置'],
  [/INVALID_VERIFICATION|VERIFICATION_CODE|INVALID_CODE|captcha|验证码/i,
    '验证码错误或已过期，请重新获取（5 分钟内有效）'],
  [/EXCEED|FREQUENCY|TOO_MANY|LIMIT|rate/i,
    '操作过于频繁，请稍后再试'],
  [/DNS|dns error|ENOTFOUND|no such host|域名/i,
    '找不到云环境，请检查环境 ID 与网络'],
  [/NETWORK|TIMEOUT|Failed to fetch|ECONN|connect|连接/i,
    '无法连接云端，请检查网络；如已开启代理请先关闭'],
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
 *
 * `act` 只影响兜底文案的前缀——同步失败顶着「登录没成功：」会让人以为掉登录了，
 * 白跑一趟重新登录。
 */
export function humanizeCloudError(e: unknown, act: 'login' | 'sync' = 'login'): string {
  const msg = errText(e)
  const head = act === 'sync' ? '同步失败' : '登录失败'
  // 原文留一份：翻译是给人看的，原文是排错用的（设置页「环境」里能看到）
  lastError = msg || (e instanceof Error ? e.message : String(e ?? ''))
  for (const [re, hint] of CODE_HINTS) {
    if (re.test(msg)) return hint
  }
  // 已经是中文（SDK 偶尔也会给中文提示）就直接用
  if (/[\u4e00-\u9fa5]/.test(msg)) return msg
  if (!msg) return `${head}，稍后再试一次`
  const short = msg.replace(/\s+/g, ' ').slice(0, 90)
  return `${head}：${short}`
}
