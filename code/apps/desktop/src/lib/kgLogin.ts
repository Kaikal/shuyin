/**
 * 酷狗「手机验证码」登录（全程在应用内完成，不弹网页、不扫码）。
 *
 * 和 QQ 音乐那条同一个理由——手机上扫码的前提是手边还有第二台设备，
 * 而这台本身就是手机；密码登录又被风控挡。收短信是唯一不依赖外设的路。
 *
 * 但它比 QQ 那条多一层价值：**网页登录窗签的 cookie 读不了云歌单**
 * （`get_all_list` 回 `20017`），这条接口签的是 App 级 token，登录完
 * 「我的歌单」就能直接拉出来。所以酷狗这边不是「换条路登录」，
 * 而是「换一条能拿到正确凭证的路」。
 *
 * 协议（实网验证到 `20021 验证码错误`，说明参数 / 加密 / 签名全部对得上）：
 *
 *   POST {gateway}/v7/send_mobile_code    x-router: login.user.kugou.com
 *        { businessid: 5, mobile, plat: 3 }              → status 1 即已发出
 *
 *   POST {gateway}/v7/login_by_verifycode x-router: login.user.kugou.com
 *        { plat, support_multi, t1, t2, clienttime_ms, mobile(打码), key,
 *          t3, params(AES 密文), pk(RSA 加密的 AES key) }
 *        → data.secu_params（用同一个临时 key 解）→ token / userid / vip_type
 *
 * 三个必须踩准的点：
 *   1. **别直连 `login.user.kugou.com`**：那个域名的证书只覆盖 `*.kugou.com`，
 *      https 会 `ERR_TLS_CERT_ALTNAME_INVALID`。两条请求都走
 *      `gateway.kugou.com` + `x-router` 头（网关靠它分流，不带就是 502）。
 *   2. 手机号和验证码要 AES 加密成一个 `params` 串，AES 的临时 key 再用 RSA 包一层 `pk`。
 *   3. 签名里**请求体原文也要参与**：`md5(盐 + 排序后的 k=v 串 + body + 盐)`，
 *      和平台层 `kg.ts` 的 `signParams` 是同一套，只是参数集不同。
 *
 * 加解密细节在 `kgCrypto.ts`，那边可以脱离网络单独验。
 */
import { md5Hex } from '@shuyin/lx-provider'
import { aesDecrypt, aesEncrypt, rsaNoPadding } from './kgCrypto'
import { createTauriHttpClient } from './tauriNet'

/** 安卓客户端身份，和平台层 `kg.ts` 同一套（appid / clientver / 盐值） */
const APPID = 1005
const CLIENTVER = 20489
const APP_SALT = 'OIlwieks28dk2k092lksi2UIkp'
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'

/** 酷狗登录用的 1024 位公钥（App 内置，只用来加密 AES 的临时 key） */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`

const http = createTauriHttpClient()

/** 和设备相关的公共参数。`dfid` 固定 `-`，与平台层默认值一致 */
function deviceParams(): Record<string, string | number> {
  const dfid = '-'
  const mid = md5Hex(dfid) + md5Hex(dfid).slice(0, 7)
  return {
    dfid,
    mid,
    uuid: md5Hex(dfid + mid),
    appid: APPID,
    clientver: CLIENTVER,
    userid: 0,
    clienttime: Math.floor(Date.now() / 1000),
  }
}

/** `md5(盐 + 按 key 排序的 k=v 串 + 请求体 + 盐)` */
function signParams(params: Record<string, string | number>, body: string): string {
  const s = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('')
  return md5Hex(`${APP_SALT}${s}${body}${APP_SALT}`)
}

async function postJson(
  url: string,
  params: Record<string, string | number>,
  body: string,
  router: string,
): Promise<any> {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const res = await http.request({
    url: `${url}?${q.toString()}`,
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      dfid: String(params.dfid),
      mid: String(params.mid),
      clienttime: String(params.clienttime),
      'x-router': router,
    },
    body,
    timeout: 12_000,
  })
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
  if (res.status < 200 || res.status >= 300) throw new Error(`酷狗登录接口没响应（${res.status}）`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`酷狗返回了无法解析的内容：${text.slice(0, 200)}`)
  }
}

/** 业务码 → 人话。平台自己给的 `msg` 优先，没有才按码翻译 */
const CODE_TEXT: Record<number, string> = {
  20021: '验证码不对或已经过期，重新发一条再试',
  20020: '验证码填错了',
  20010: '登录状态没拿到，再试一次',
  20002: '这个号码暂时收不到验证码，等一会儿再试',
  20004: '号码格式不对，检查一下',
  // 兜底：正常情况下这个码会被 `readChoices` 接走，只有拿不到账号列表才落到这里
  34175: '这个手机号下绑了多个账号，但没取到账号列表，重新发一条验证码试试',
}

/**
 * 「这个手机号绑了多个账号，请选一个」的业务码。
 *
 * 它**不是失败**：`status` 是 0，但 `data.info_list` 会把该号码下的账号全列出来。
 * 以前只判 `status !== 1`，于是把这一步当成登录失败，界面上只有一句
 * 「登录失败（34175）」——而 34175 这个码平台连 `msg` 都不给，用户完全猜不到
 * 原因是要选账号。实网验证：同一个验证码在 body 里补上 `userid` 就能直接登进去
 * （`status: 1`，token 照旧在 `secu_params` 里）。
 */
const CODE_MULTI_ACCOUNT = 34175

/** 该手机号下的一个候选账号 */
export interface KgAccount {
  userid: string
  nickname: string
  avatar?: string
}

/** 登录结果：要么拿到 cookie，要么要用户先选账号 */
export type KgLoginResult =
  | { ok: true; cookie: string }
  | { needChoose: true; accounts: KgAccount[] }

/** 从 34175 的响应里取候选账号。不是这个码 / 结构不对就返回空 */
function readChoices(j: any): KgAccount[] {
  if (Number(j?.error_code ?? 0) !== CODE_MULTI_ACCOUNT) return []
  const list = j?.data?.info_list
  if (!Array.isArray(list)) return []
  return list
    .map((x: any) => ({
      userid: String(x?.userid ?? '').replace(/\D/g, ''),
      nickname: String(x?.nickname ?? '').trim(),
      avatar: typeof x?.pic === 'string' && x.pic ? x.pic : undefined,
    }))
    .filter(x => x.userid)
}

function errText(j: any): string {
  const msg = typeof j?.data === 'string' ? j.data : (j?.data?.msg ?? j?.msg ?? j?.error)
  if (msg) return String(msg)
  const code = Number(j?.error_code ?? 0)
  return CODE_TEXT[code] || `登录失败（${code || '无错误码'}）`
}

/**
 * 发短信验证码。
 *
 * 走网关 `https://gateway.kugou.com` + `x-router: login.user.kugou.com`，
 * **不要直连** `login.user.kugou.com`：那个域名的证书只覆盖 `*.kugou.com`，
 * https 会 `ERR_TLS_CERT_ALTNAME_INVALID`，退回 http 又要求客户端放行明文流量。
 * 网关这条实网验证过能发（`{"data":{"count":9},"status":1}`），两边行为一致。
 */
export async function sendKgSms(phone: string): Promise<{ sent: true }> {
  const params = deviceParams()
  const body = JSON.stringify({ businessid: 5, mobile: phone, plat: 3 })
  params.signature = signParams(params, body)
  const j = await postJson('https://gateway.kugou.com/v7/send_mobile_code', params, body, 'login.user.kugou.com')
  if (Number(j?.status) !== 1 || Number(j?.error_code ?? 0) !== 0) throw new Error(errText(j))
  return { sent: true }
}

/**
 * 验证码换登录凭证，并拼成平台层认的 cookie 串。
 *
 * 平台层（`platforms/kg.ts`）只从 cookie 里取两样：`KuGoo` 里的 `uid`/`token`
 * （`loginOf`）和 `dfid`/`mid`/`uuid`（`deviceParams`）。所以这里把登录响应
 * 整理成一行 cookie 就够，不必另建一套存储。
 *
 * `mid`/`uuid` 必须跟着一起写：登录时的 token 绑在这套设备标识上，
 * 后续请求换成默认的 `1600000000000000` 会被当成另一台手机。
 *
 * `userid` 只在「该号码有多个账号」时传：第一次不传，平台回 34175 并给出
 * `info_list`；用户选完再带着它重提一次同一个验证码（验证码不会被那一步消耗）。
 * 单账号号码不传这个字段，行为和以前完全一致。
 */
export async function loginKgWithSms(phone: string, code: string, userid?: string): Promise<KgLoginResult> {
  const now = Date.now()
  const enc = aesEncrypt(JSON.stringify({ mobile: phone, code }))
  const params = deviceParams()
  const body = JSON.stringify({
    plat: 1,
    support_multi: 1,
    t1: 0,
    t2: 0,
    clienttime_ms: now,
    // 平台要求这里给打码后的号码（真号在 AES 密文里）
    mobile: `${phone.slice(0, 2)}*****${phone.slice(10, 11)}`,
    key: md5Hex(`${APPID}${APP_SALT}${CLIENTVER}${now}`),
    t3: 'MCwwLDAsMCwwLDAsMCwwLDA=',
    params: enc.str,
    pk: rsaNoPadding(PUBLIC_KEY, JSON.stringify({ clienttime_ms: now, key: enc.key })),
    // 选定账号时才带；`undefined` 会被 JSON.stringify 丢掉
    userid: userid ? Number(userid) : undefined,
  })
  params.signature = signParams(params, body)
  const j = await postJson('https://gateway.kugou.com/v7/login_by_verifycode', params, body, 'login.user.kugou.com')
  if (Number(j?.status) !== 1) {
    // 多账号：交给界面去选，别报成登录失败
    const accounts = readChoices(j)
    if (accounts.length) return { needChoose: true, accounts }
    throw new Error(errText(j))
  }

  const data: any = { ...(j.data ?? {}) }
  // token 在 `secu_params` 里又加了一层 AES，用发请求时的临时 key 解
  if (typeof data.secu_params === 'string' && data.secu_params) {
    try {
      const obj = JSON.parse(aesDecrypt(data.secu_params, enc.key))
      if (obj && typeof obj === 'object') Object.assign(data, obj)
    } catch {
      /* 解不开就退回用 data 里明文的那些字段 */
    }
  }
  const token = String(data.token ?? data.Token ?? '')
  const uid = String(data.userid ?? data.user_id ?? '').replace(/\D/g, '')
  if (!token || !uid || uid === '0') throw new Error('酷狗没有返回登录凭证，再试一次')

  // `KuGoo` 是平台层唯一认的凭证载体；昵称/头像也在里面，省一次资料请求
  const kv: string[] = [`uid=${uid}`, `token=${token}`]
  if (data.nickname) kv.push(`NickName=${encodeURIComponent(String(data.nickname))}`)
  if (data.pic) kv.push(`Pic=${encodeURIComponent(String(data.pic))}`)
  const cookie = [
    `KuGoo=${kv.join('&')}`,
    `userid=${uid}`,
    `token=${token}`,
    `dfid=${params.dfid}`,
    `mid=${params.mid}`,
    `uuid=${params.uuid}`,
  ].join('; ')
  return { ok: true, cookie }
}
