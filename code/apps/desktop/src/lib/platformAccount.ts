/**
 * 平台账号（目前只有网易云）。
 *
 * 登录本身在 Rust 侧的**官方登录窗**里完成（`src-tauri/src/platform_login.rs`）：
 * 用户在网易云自己的页面上扫码 / 输密码，我们从 WebView2 的 cookie 里取出凭证。
 * 这个文件只管三件事：
 *   1. 把 cookie 存进设置，冷启动读回来；
 *   2. 给 HTTP 客户端**同步**取用（`cookieOf`）——平台 API 层是同步发请求的，
 *      不能每条请求都 await 一次存储；
 *   3. 订阅：登录 / 退出后，歌单广场要立刻换一屏内容（每日推荐、为你推荐）。
 *
 * 依赖方向是单向的：`online.ts` → 这里。这里不 import `online.ts`，
 * 需要账号资料（昵称 / 头像）时由 `online.ts` 在启动时注入 `setProfileLoader`。
 */
import type { PlatformAccountInfo, PlatformSource } from '@shuyin/lx-provider'
import { useEffect, useState } from 'react'
import { invoke, isAndroid, isTauri } from './bridge'
import { KEYS, settings } from './settings'

/** 一个平台的登录态。`cookie` 是能直接塞进请求头的整串，含 httpOnly 凭证 */
export interface PlatformAccount extends PlatformAccountInfo {
  cookie: string
  /** 登录时间（ms），排错用；也用来判断资料要不要重取 */
  at: number
}

/**
 * 有登录通道的平台，和 Rust `platform_login::spec` 那张表**一一对应**。
 *
 * 不看平台层有没有 `getAccount`：那只能说明「能不能验证凭证」，
 * 不能说明「能不能登录」。两家的事分开——登录窗是四家都有的。
 */
export const LOGIN_PLATFORMS: PlatformSource[] = ['wy', 'tx', 'kg', 'kw']

type State = Partial<Record<PlatformSource, PlatformAccount>>

/** 登录事件（Rust `platform_login.rs` 里发的 `platform://login`） */
interface LoginPayload {
  source: PlatformSource
  ok: boolean
  cookie?: string
  cancel?: boolean
  error?: string
}

export interface LoginResult {
  ok: boolean
  cancel?: boolean
  error?: string
}

let state: State = {}
let booted: Promise<void> | null = null
const subs = new Set<() => void>()

const emit = () => subs.forEach(fn => fn())

/** 拿账号资料的函数（`online.ts` 注入，避免这里反过来依赖平台层） */
let profileLoader: ((source: PlatformSource) => Promise<PlatformAccountInfo | null>) | null = null

export function setProfileLoader(fn: typeof profileLoader) {
  profileLoader = fn
}

/** 冷启动读一次存档。可以重复调用（幂等） */
export function bootPlatformAccounts(): Promise<void> {
  if (!booted) {
    booted = settings.get<State>(KEYS.platformAccounts)
      .then(async v => {
        if (!v || typeof v !== 'object') return
        // 只认有 cookie 的条目：删到一半的存档不要复活成「已登录」
        for (const [k, a] of Object.entries(v)) {
          if (a?.cookie) state[k as PlatformSource] = a as PlatformAccount
        }
        emit()
        /*
         * 存档里的 cookie 可能是很久以前存的，早就过期了。
         * 静默留着的话，界面上写着「已登录 XX」，推荐却是公共的——两头都对不上。
         * 所以启动后挨个问一次平台「这凭证还认吗」：明确不认（'no'）就清掉；
         * 网络不通（'unknown'）什么都不做，不能因为一次断网就把人踢下线。
         */
        for (const src of Object.keys(state) as PlatformSource[]) {
          if (await refreshProfile(src) === 'no') await drop(src)
        }
      })
      .catch(() => { /* 读不到就当没登录 */ })
  }
  return booted
}

/** 同步取 cookie：平台 API 的请求头要用，不能等异步 */
export function cookieOf(source: PlatformSource): string | undefined {
  return state[source]?.cookie
}

export function accountOf(source: PlatformSource): PlatformAccount | undefined {
  return state[source]
}

export function isLoggedIn(source: PlatformSource): boolean {
  return !!state[source]?.cookie
}

async function persist(next: State) {
  state = next
  emit()
  await settings.set(KEYS.platformAccounts, next).catch(() => { /* 存不下也不影响本次会话 */ })
}

/** 丢掉某个平台的登录态（凭证失效 / 退出登录） */
async function drop(source: PlatformSource) {
  if (!state[source]) return
  const next: State = { ...state }
  delete next[source]
  await persist(next)
}

/**
 * 拿一次账号资料，顺便当成「凭证还有效吗」的探针。
 *
 * 三种结果必须分开：
 *   · `ok`      —— 资料拿到了（cookie 有效）
 *   · `no`      —— 平台明确说没登录（`profile: null`）→ cookie 已失效，该清
 *   · `unknown` —— 请求抛了（断网 / 接口抖动）→ 什么都不做，别把人踢下线
 */
async function refreshProfile(source: PlatformSource): Promise<'ok' | 'no' | 'unknown'> {
  if (!profileLoader || !state[source]) return 'unknown'
  try {
    const info = await profileLoader(source)
    if (!info) return 'no'
    await persist({ ...state, [source]: { ...state[source]!, ...info } })
    return 'ok'
  } catch {
    return 'unknown'
  }
}

/* ------------------------------------------------------------------ */
/* 登录窗口                                                            */
/* ------------------------------------------------------------------ */

let listener: Promise<void> | null = null
/** 当前等结果的那一次登录（同一时间只允许一个） */
let pending: {
  source: PlatformSource
  /** 发起时间：用来判定「上一次是不是死了」，见 `loginPlatform` */
  at: number
  resolve: (r: LoginResult & { cookie?: string }) => void
} | null = null

function ensureListener(): Promise<void> {
  if (!listener) {
    listener = import('@tauri-apps/api/event').then(({ listen }) =>
      listen<LoginPayload>('platform://login', e => {
        const r = e.payload
        const p = pending
        if (p && p.source === r.source) {
          pending = null
          p.resolve({ ok: !!r.ok, cancel: !!r.cancel, error: r.error, cookie: r.cookie })
          return
        }
        /*
         * 没有在等的那一次（比如等超时了、窗口还开着，用户接着扫完了）：
         * 凭证照样有效，不能因为没人等就把登录丢掉——直接落盘。
         */
        if (r.ok && r.cookie) void applyLogin(r.source, r.cookie)
      }).then(() => { /* 订阅常驻：整个过程可能登录好几次 */ }),
    ).catch(() => { /* 浏览器预览：没有事件系统 */ })
  }
  return listener ?? Promise.resolve()
}

/** 把一次成功的登录落地：存 cookie → 问一次平台「这凭证认不认」→ 不认就清掉 */
async function applyLogin(source: PlatformSource, cookie: string): Promise<'ok' | 'no' | 'unknown'> {
  const prev = state[source]
  await persist({
    ...state,
    [source]: {
      cookie,
      nickname: prev?.nickname ?? '',
      avatar: prev?.avatar,
      userId: prev?.userId ?? '',
      at: Date.now(),
    },
  })
  const r = await refreshProfile(source)
  if (r === 'no') await drop(source)
  return r
}

const LOGIN_TIMEOUT = 180_000

/**
 * 打开官方登录窗并等结果。
 *
 * 返回 `{ ok:true }` 时 cookie **已经落盘**，调用方直接刷新页面数据即可。
 * `cancel` = 用户自己把窗口关了；`error` = 建窗失败 / 等太久。
 */
export async function loginPlatform(source: PlatformSource): Promise<LoginResult> {
  /*
   * 安卓：登录窗是一个独立 Activity（`PlatformLoginActivity`），
   * 它把凭证从 CookieManager 里抓出来直接当命令返回值给我们——
   * 那边没有 Tauri 的事件通道，所以不走下面「等 `platform://login` 事件」那条路。
   */
  if (isAndroid) {
    await bootPlatformAccounts()
    const r = await invoke<{ ok?: boolean; cancel?: boolean; error?: string; cookie?: string }>(
      'platform_login', { source },
    )
    if (!r?.ok || !r.cookie) {
      return { ok: false, cancel: r?.cancel, error: r?.error || '没拿到登录凭证' }
    }
    if (await applyLogin(source, r.cookie) === 'no') {
      return { ok: false, error: '登录没生效，再试一次' }
    }
    return { ok: true }
  }
  if (!isTauri) return { ok: false, error: '网页预览版不能登录，请用桌面端' }
  /*
   * 同一时间只允许一个登录窗。但**不能永久锁住**：窗口被页面自己关掉、
   * 事件没回来时（Rust 侧要几秒才兜底），这里留个时间上限——
   * 超过 3 分钟一律当上一次已经死了，否则用户再点登录只会得到
   * 「已经有一个登录窗口在等着了」，等于把整个登录功能锁死。
   */
  if (pending && Date.now() - pending.at < 180_000) {
    return { ok: false, error: '已经有一个登录窗口在等着了' }
  }
  pending = null
  await bootPlatformAccounts()
  await ensureListener()

  const done = new Promise<LoginResult & { cookie?: string }>(resolve => {
    pending = { source, at: Date.now(), resolve }
  })
  try {
    await invoke('platform_login', { source })
  } catch (e) {
    pending = null
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const timeout = new Promise<LoginResult & { cookie?: string }>(resolve => {
    window.setTimeout(() => {
      // 超时只解除等待，不关窗口——用户可能还在输密码，关不关让他自己定
      if (pending?.source === source) pending = null
      resolve({ ok: false, error: '登录窗口开太久了，可以关掉重开' })
    }, LOGIN_TIMEOUT)
  })

  const res = await Promise.race([done, timeout])
  if (!res.ok || !res.cookie) {
    return { ok: res.ok, cancel: res.cancel, error: res.ok ? '没拿到登录凭证' : res.error }
  }

  // 认不出来就说明登录没成功（扫了码但没在手机上确认、cookie 抓错了），
  // 那种情况下留着 cookie 只会让界面写着「已登录」，推荐却还是公共的
  if (await applyLogin(source, res.cookie) === 'no') {
    return { ok: false, error: '登录没生效，再试一次' }
  }
  return { ok: true }
}

/**
 * 扫码登录的最后一步：把二维码会话换来的 cookie 落地。
 *
 * 和官方登录窗走**同一个** `applyLogin`（存 cookie → 问一次平台「这凭证认不认」），
 * 所以两条路的判定标准完全一致。认不出来就当失败——扫了码却没在手机上确认、
 * 凭证被风控，这些情况下留着 cookie 只会让界面写着「已登录」、推荐却还是公共的。
 */
export async function finishQrLogin(source: PlatformSource, cookie: string): Promise<LoginResult> {
  if (!cookie) return { ok: false, error: '没拿到登录凭证' }
  if (await applyLogin(source, cookie) === 'no') return { ok: false, error: '登录没生效，再试一次' }
  return { ok: true }
}

/**
 * 退出登录。
 *
 * 除了删本地 cookie，还要**通知平台注销**：官方登录窗用的是同一个 WebView2
 * cookie 库，不清服务端会话的话，下次点「登录」一开窗就会被立刻自动登进去。
 * 平台没有 logout 接口时只删本地。
 */
export async function logoutPlatform(
  source: PlatformSource,
  remoteLogout?: () => Promise<void>,
): Promise<void> {
  const has = !!state[source]
  if (has) {
    try { await remoteLogout?.() } catch { /* 网络挂了也要能退出 */ }
  }
  const next: State = { ...state }
  delete next[source]
  await persist(next)
}

/* ------------------------------------------------------------------ */
/* React 订阅                                                          */
/* ------------------------------------------------------------------ */

/** 组件里判断登录态用；登录 / 退出 / 资料回来都会触发重渲染 */
export function subscribeAccount(fn: () => void): () => void {
  subs.add(fn)
  void bootPlatformAccounts()
  return () => { subs.delete(fn) }
}

/** 某个平台的登录态（订阅式）。未登录返回 `undefined` */
export function useAccount(source: PlatformSource): PlatformAccount | undefined {
  const [acc, setAcc] = useState<PlatformAccount | undefined>(() => accountOf(source))
  useEffect(() => {
    const sync = () => setAcc(accountOf(source))
    const un = subscribeAccount(sync)
    sync()
    return un
  }, [source])
  return acc
}

/**
 * **所有**平台的登录态（订阅式）。
 *
 * 「我的」页要一排四个平台，逐个 `useAccount` 属于在循环里调 hook；
 * 这里直接返回整张表，登录 / 退出时换一个新对象触发重渲染（`persist` 本来就是新对象）。
 */
export function useAccounts(): State {
  const [all, setAll] = useState<State>(() => ({ ...state }))
  useEffect(() => {
    const sync = () => setAll({ ...state })
    const un = subscribeAccount(sync)
    sync()
    return un
  }, [])
  return all
}
