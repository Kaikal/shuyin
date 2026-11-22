/**
 * 疏音 · 匿名使用统计（云函数）
 *
 * 回答两个问题，两条路径分开存：
 *
 *   POST  { t:'first' }  →  stat/machines/<机型>__<装机号>.json
 *                           一台设备一个文件，只写一次。**文件数 = 用过疏音的设备数**。
 *                           这条跟下载渠道无关：官网、Gitee、别人传的 APK 都算，
 *                           只要 App 真跑起来过一次。
 *                           机型写进**文件名前缀**是刻意的：数目录就能按机型分组，
 *                           不用把每个文件下载下来看内容（读是要花额度的）。
 *   POST  { t:'ping' }   →  stat/days/<YYYY-MM-DD>/<装机号>.json
 *                           按天分目录。当天目录里的文件数 = 当天活跃设备数。
 *   POST  { t:'dl' }     →  同上（装包完成也算一次活跃）
 *
 *   GET  ?             →  { total, today, day, models:[{model,n}] }
 *                         一次汇总，浏览器直接打开就能看；models 是机型分布。
 *
 * 为什么用「一个装机号一个文件」而不是一行一条记录：
 *   1. 不用数据库。云开发新环境是 PG 模式，`app.database()` 在文档库实例上直接报错
 *      （见 lib/cloud.ts 顶部的注释）。
 *   2. 不用读。写入即覆盖，同一天同一台设备上报几次都只占一个文件，天然幂等，
 *      不需要「先查再改」，也就没有并发冲突。
 *   3. 云存储写请求 10 点/万次，比文档库调用（200 点/万次）便宜二十倍，
 *      而且不占数据库容量——数据库额度全留给云同步。
 *
 * 客户端发：t(事件) / app(形态) / ver(版本) / mid(随机装机号)，
 * `first` 那一次另带 dev（机型标签：model/brand/sdk/屏幕/语言）。
 * 没有账号、**没有手机号**、没有设备指纹、没有位置、没有听歌内容。
 */

const cloudbase = require('@cloudbase/node-sdk')

// SYMBOL_CURRENT_ENV：跟随函数部署所在的环境，换环境不用改代码
const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })

/** 装机号只允许 URL 安全字符，且长度有上下限——它会变成文件名，必须挡住路径穿越 */
const MID_RE = /^[A-Za-z0-9_-]{8,64}$/

/** 合法事件类型。白名单之外的一律按 ping 处理，避免有人往目录里塞任意名字 */
const KINDS = new Set(['first', 'ping', 'dl'])

/*
 * 机型字段白名单。客户端传来的是任意 JSON，只认这几个键、只做粗粒度截断，
 * 其余一律丢掉——不能让调接口的人往存储里塞任意内容。
 */
const DEV_KEYS = ['model', 'brand', 'sdk', 'os', 'w', 'h', 'dpr', 'lang']
const DEV_MAX = 32

function cleanDev(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const k of DEV_KEYS) {
    const v = raw[k]
    if (typeof v === 'string') {
      const s = v.trim()
      if (s) out[k] = s.slice(0, DEV_MAX)
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v
    }
  }
  return out
}

/**
 * 机型 slug：把「厂商 + 型号」压成能进文件名的片段。
 *
 * 只留小写字母数字，其余压成 '-'（中文机型名会被压掉，那时就是品牌或 unknown）。
 * 目的是在控制台里扫一眼文件名就知道哪台是什么机器，所以宁可短、可读，
 * 不要完整还原原串。上限 28 字符——文件名还要留出 `__` + 装机号。
 */
function slugOf(dev) {
  const squash = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const raw = [dev && dev.brand, dev && dev.model].filter(Boolean).join(' ')
  let s = squash(raw).slice(0, 28).replace(/-+$/, '')
  /* 桌面 / iOS 没有机型名（Build.MODEL 只有安卓有），退回系统名，别全挤进 unknown */
  if (!s && dev && dev.os) s = squash(dev.os).slice(0, 28)
  return s || 'unknown'
}

/** HTTP 触发器的 body 可能是：JSON 字符串 / base64 / 已解析的对象。三种都兜住 */
function readBody(event) {
  let raw = event && event.body
  if (typeof raw === 'string') {
    if (event.isBase64Encoded) {
      raw = Buffer.from(raw, 'base64').toString('utf8')
    }
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' ? raw : event || {}
}

/** 北京时间（UTC+8）的 YYYY-MM-DD。云函数默认 UTC，不加这 8 小时会跨日错位 */
function beijingDay() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

function reply(code, body, type) {
  return {
    statusCode: code,
    headers: { 'content-type': type || 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

function isGet(event) {
  const m = (event && (event.httpMethod || event.requestContext?.httpMethod)) || ''
  return String(m).toUpperCase() === 'GET'
}

/* ------------------------------------------------------------------ */
/* GET：汇总                                                            */
/* ------------------------------------------------------------------ */

/*
 * 云存储没有「读目录」的 SDK 方法（node-sdk 只有 upload/download/delete/getTempFileURL），
 * 要点数只能靠管理端 SDK 的 listDirectoryFiles。它不是内置依赖，需要单独装，
 * 装不上也不能影响写入，所以整段是「能算就算、算不了就说清楚」。
 */
async function summarize() {
  let CloudBase
  try {
    CloudBase = require('@cloudbase/manager-node')
  } catch {
    return {
      ok: false,
      msg: '报表需要 @cloudbase/manager-node 依赖。写入不受影响；也可以直接在云存储控制台数文件：stat/machines/ 是累计设备数，stat/days/<今天>/ 是今日活跃。',
    }
  }

  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.CLOUDBASE_ENV_ID || ''
  if (!envId) {
    return { ok: false, msg: '取不到环境 ID（TCB_ENV / SCF_NAMESPACE 都为空）' }
  }

  const { storage } = new CloudBase({ envId })

  const list = async (dir) => {
    try {
      const files = await storage.listDirectoryFiles(dir)
      // 目录本身也会作为一条返回，Size 为 0 的跳过
      return (files || []).filter(f => Number(f.Size) > 0)
    } catch {
      // 目录还不存在（一条数据都没有）时返回空数组，不当错误
      return []
    }
  }

  const day = beijingDay()
  const machines = await list('stat/machines')
  const today = (await list(`stat/days/${day}`)).length

  /*
   * 机型分布：直接数文件名前缀，**不读文件内容**。
   * 文件名形如 `xiaomi-m2012k11ac__<装机号>.json`，取 `__` 前那段就够了。
   * 所以这份报表一次下载都不做——这是把机型编进文件名的全部理由
   * （要逐个读内容的话，1000 台设备就是 1000 次读）。
   */
  const tally = new Map()
  for (const f of machines) {
    const base = String(f.Name || f.name || '').split('/').pop()
    const i = base.indexOf('__')
    const model = i > 0 ? base.slice(0, i) : 'unknown'
    tally.set(model, (tally.get(model) || 0) + 1)
  }
  const models = [...tally.entries()]
    .map(([model, n]) => ({ model, n }))
    .sort((a, b) => b.n - a.n)

  return { ok: true, total: machines.length, today, day, models }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

exports.main = async (event) => {
  if (isGet(event)) {
    try {
      return reply(200, await summarize())
    } catch (e) {
      return reply(200, { ok: false, msg: String((e && e.message) || e) })
    }
  }

  const b = readBody(event)

  const mid = String(b.mid || '')
  if (!MID_RE.test(mid)) {
    // 不是攻击就是客户端出了 bug，两种情况都不该写文件
    return reply(400, { code: 400, msg: 'bad mid' })
  }

  const t = KINDS.has(String(b.t)) ? String(b.t) : 'ping'
  const kind = String(b.app || 'unknown').slice(0, 8)
  const ver = String(b.ver || '').slice(0, 24)
  const dev = cleanDev(b.dev)
  const day = beijingDay()

  const record = {
    t,
    app: kind,
    ver,
    at: new Date().toISOString(),
  }
  if (Object.keys(dev).length) record.dev = dev

  /*
   * first 进「设备名册」，永远一份；其余进「当天的活跃」。
   * 两者分开是因为语义不同：名册是累计（含今天没开机的），
   * 当天目录是日活（会自然过期，想看趋势就翻历史目录）。
   *
   * 名册的文件名带机型前缀，`__` 作分隔符：mid 的字符集是
   * `[A-Za-z0-9_-]`（见上面 MID_RE），不含 `__`，所以切分永远可靠。
   */
  const cloudPath = t === 'first'
    ? `stat/machines/${slugOf(dev)}__${mid}.json`
    : `stat/days/${day}/${mid}.json`

  try {
    await app.uploadFile({
      cloudPath,
      fileContent: Buffer.from(JSON.stringify(record)),
    })
  } catch (e) {
    /*
     * 写不进去也返回 200：客户端那边统计是「失败下次再试」的语义，
     * 返回 4xx/5xx 只会让它重试，对谁都没好处。
     * 日志里留一份，事后能补算——真出问题时这是唯一线索。
     */
    console.log('STAT_WRITE_FAIL', cloudPath, JSON.stringify(record), e && e.message)
    return reply(200, { code: 0, stored: false })
  }

  console.log('STAT_OK', cloudPath, kind, ver)
  return reply(200, { code: 0, stored: true })
}
