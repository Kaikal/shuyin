/**
 * 音源管理：把「音源脚本」这一层收在一处。
 *
 * 三件事：
 *   1. 把目录里的 `.js` 交给宿主（桌面端是 Worker）跑起来，等 `inited`，记下它能给哪些平台的哪些音质
 *   2. 维护启用/禁用、状态、最近一次成功记录
 *   3. `getMusicUrl` 的降级链——按「最近成功过的排前面」的顺序逐个试，全挂抛 NoPlayableSourceError
 *
 * 为什么单源超时要收到 8s：长青SVIP 在 kw 上失败一次要 12s，
 * 按 15s 超时做，首次播放会先干等十几秒，用户会以为点坏了。
 */
import {
  NoPlayableSourceError,
  type LxHostAdapter, type LoadedSource, type PlatformSource, type SourceSupport,
} from './types'

/** 单源取链超时。8s 太宽松：起播链路上每一步都在等，慢源该早些让位给下一个 */
export const SOURCE_TIMEOUT_MS = 6_000
/**
 * 同一平台内，下一个音源上场的错开时长。
 *
 * 320ms 的依据：主力音源正常出链（含落地校验）在 250~600ms，
 * 这段时间里再放一个进来，只是多一份并发的请求，帮不上忙；
 * 而它一旦卡住，320ms 之后后备已经在路上，用户感觉不到「等下一个」。
 */
const HEDGE_SOURCE_MS = 320
/** 脚本初始化超时 */
export const INIT_TIMEOUT_MS = 15_000

export interface SourceManagerOptions {
  host: LxHostAdapter
  /** 默认音源目录 */
  dir?: string
  timeoutMs?: number
  /**
   * 出链后的落地校验。
   *
   * 音源脚本「给了个 URL」和「这 URL 真能拉」是两件事：签名过期、要 Referer、
   * 302 到 403、返回一张 HTML 错误页——脚本层都看不出来，只有真请求一次才知道。
   * 不校验的话，用户看到的就是「搜出来一大堆，点一首播不了一首」。
   * 校验抛错 = 这一档不可用，继续往下试（降档 / 换源），而不是直接把失败丢给用户。
   *
   * `expect` 是这一次取链「期望的曲目时长」，用来判断拿到的文件是不是这首。
   * 必须**随调用传**、不能放模块级共享变量：现在多个平台是同时开跑的，
   * 共享变量会被别的平台覆盖，校验就会拿着错的时长去判。
   */
  verify?: (url: string, expect?: { duration?: number }) => Promise<void>
}

export interface GetUrlAttempt {
  sourceId: string
  sourceName: string
  error: string
}

export type SourceManagerListener = (state: { sources: LoadedSource[]; loading: boolean }) => void

/** 音质从低到高，用于「请求的音质这个源不支持时把档位往下压」 */
const QUALITY_ORDER = ['128k', '192k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master']

function pickQuality(supported: string[], wanted: string): string {
  if (supported.includes(wanted)) return wanted
  const wi = QUALITY_ORDER.indexOf(wanted)
  if (wi < 0) return supported[0] ?? wanted
  // 从请求档位往下找第一个支持的；都不支持就取最高档
  for (let i = wi; i >= 0; i--) {
    if (supported.includes(QUALITY_ORDER[i])) return QUALITY_ORDER[i]
  }
  for (let i = wi + 1; i < QUALITY_ORDER.length; i++) {
    if (supported.includes(QUALITY_ORDER[i])) return QUALITY_ORDER[i]
  }
  return supported[0] ?? wanted
}

/**
 * 同一音源内要依次尝试的档位：请求档位 + 往下最多两级。
 *
 * 为什么需要它：高音质档（flac / hires / master）经常要 VIP，第三方接口直接 403 或者
 * 返回空；而降一档往往立刻能出链。只试一个档位，用户看到的就是「很多歌播不了」。
 * 上限三级是延迟与成功率的折中——每次都可能是 8s 超时，再多就没法用了。
 */
function qualitiesToTry(supported: string[], wanted: string, max = 3): string[] {
  const out = [wanted]
  let i = QUALITY_ORDER.indexOf(wanted)
  while (out.length < max && i > 0) {
    i -= 1
    const q = QUALITY_ORDER[i]
    if (supported.includes(q) && !out.includes(q)) out.push(q)
  }
  return out
}

export class SourceManager {
  private host: LxHostAdapter
  private timeoutMs: number
  private sources: LoadedSource[] = []
  private disabled = new Set<string>()
  /** platform → 最近一次成功取链的音源 id，降级链按它优先 */
  private lastGood = new Map<PlatformSource, string>()
  private listeners = new Set<SourceManagerListener>()
  private loading = false
  private verify?: (url: string, expect?: { duration?: number }) => Promise<void>
  /**
   * 要扫描的音源目录。
   *
   * 以前只扫「当前目录」一个：设置里存了自定义目录之后，用户手动丢进数据目录的 .js
   * 就永远不出现——反馈里「只能靠 app 导入才认」就是这个。现在固定目录（应用数据目录）
   * + 自定义目录都扫，按文件路径去重，两边放的文件都能被认到。
   */
  private dirs: string[] = []
  dir: string

  constructor(opts: SourceManagerOptions) {
    this.host = opts.host
    this.dir = opts.dir ?? ''
    if (this.dir) this.dirs = [this.dir]
    this.timeoutMs = opts.timeoutMs ?? SOURCE_TIMEOUT_MS
    this.verify = opts.verify
  }

  /* ---------------- 订阅 ---------------- */

  subscribe(fn: SourceManagerListener): () => void {
    this.listeners.add(fn)
    fn({ sources: this.sources, loading: this.loading })
    return () => { this.listeners.delete(fn) }
  }

  private emit() {
    const snap = { sources: this.sources.map(s => ({ ...s })), loading: this.loading }
    for (const fn of this.listeners) fn(snap)
  }

  /* ---------------- 状态 ---------------- */

  list(): LoadedSource[] {
    return this.sources.map(s => ({ ...s }))
  }

  get(id: string): LoadedSource | undefined {
    return this.sources.find(s => s.id === id)
  }

  /** 禁用的音源不参与降级链，但仍在列表里 */
  isEnabled(id: string): boolean {
    return !this.disabled.has(id)
  }

  setDisabled(ids: string[]) {
    this.disabled = new Set(ids)
    this.emit()
  }

  enabledIds(): string[] {
    return this.sources.filter(s => this.isEnabled(s.id)).map(s => s.id)
  }

  /* ---------------- 装载 ---------------- */

  setDir(dir: string | string[]) {
    this.applyDirs(dir)
  }

  private applyDirs(dir: string | string[]) {
    const list = (Array.isArray(dir) ? dir : [dir])
      .map(d => d.trim())
      .filter(Boolean)
    // 去重（同一个目录传两遍时不要重复扫描）
    this.dirs = [...new Set(list)]
    this.dir = this.dirs[0] ?? ''
  }

  /** 扫所有音源目录并合并；同路径只保留一份（前面的目录优先） */
  private async listAllScripts(): Promise<Array<{ path: string; name: string; code: string }>> {
    const buckets = await Promise.all(
      this.dirs.map(d => this.host.listScripts(d).catch(() => [])),
    )
    const seen = new Set<string>()
    const out: Array<{ path: string; name: string; code: string }> = []
    for (const bucket of buckets) {
      for (const sc of bucket) {
        if (seen.has(sc.path)) continue
        seen.add(sc.path)
        out.push(sc)
      }
    }
    return out
  }

  /** 读目录 + 逐个装载。失败的音源以 status='error' 留在列表里，不静默丢弃 */
  async loadAll(dir?: string | string[]): Promise<LoadedSource[]> {
    if (dir !== undefined) this.applyDirs(dir)
    this.loading = true
    this.emit()

    let scripts: Awaited<ReturnType<LxHostAdapter['listScripts']>> = []
    try {
      scripts = await this.listAllScripts()
    } catch (e) {
      this.loading = false
      this.sources = []
      this.emit()
      throw e
    }

    const next: LoadedSource[] = []
    for (const sc of scripts) {
      const id = hashId(sc.path)
      this.codes.set(id, sc.code)
      const placeholder: LoadedSource = {
        id,
        name: stripExt(sc.name),
        filePath: sc.path,
        status: 'loading',
        outbound: [],
        supports: [],
      }
      next.push(placeholder)
      this.sources = [...next]
      this.emit()

      try {
        const loaded = await withTimeout(
          this.host.load({ id, code: sc.code, filePath: sc.path }),
          INIT_TIMEOUT_MS,
          `音源「${stripExt(sc.name)}」加载超时（${INIT_TIMEOUT_MS / 1000}s）`,
        )
        const meta = loaded.inited.meta ?? {}
        const hm = parseHeaderMeta(sc.code)
        placeholder.status = 'ready'
        placeholder.name = meta.name ? String(meta.name) : (hm.name ?? stripExt(sc.name))
        placeholder.version = meta.version ? String(meta.version) : hm.version
        placeholder.author = meta.author ? String(meta.author) : hm.author
        placeholder.supports = toSupports(loaded.inited.sources)
        placeholder.outbound = scanOutbound(sc.code)
      } catch (e) {
        placeholder.status = 'error'
        placeholder.error = e instanceof Error ? e.message : String(e)
      }
      this.emit()
    }

    this.sources = next
    this.loading = false
    this.emit()
    return this.list()
  }

  /** 重新装载单个音源（设置页的「重试」） */
  async reload(id: string): Promise<LoadedSource | undefined> {
    const target = this.get(id)
    if (!target) return undefined
    target.status = 'loading'
    target.error = undefined
    this.emit()
    try {
      const scripts = await this.listAllScripts()
      const sc = scripts.find(s => hashId(s.path) === id)
      if (!sc) throw new Error('文件已不存在')
      this.codes.set(id, sc.code)
      const loaded = await withTimeout(
        this.host.load({ id, code: sc.code, filePath: sc.path }),
        INIT_TIMEOUT_MS,
        `音源「${target.name}」加载超时`,
      )
      const meta = loaded.inited.meta ?? {}
      const hm = parseHeaderMeta(sc.code)
      target.status = 'ready'
      target.name = meta.name ? String(meta.name) : (hm.name ?? target.name)
      target.version = meta.version ? String(meta.version) : (hm.version ?? target.version)
      target.author = meta.author ? String(meta.author) : (hm.author ?? target.author)
      target.supports = toSupports(loaded.inited.sources)
      target.outbound = scanOutbound(sc.code)
      target.error = undefined
    } catch (e) {
      target.status = 'error'
      target.error = e instanceof Error ? e.message : String(e)
    }
    this.emit()
    return target
  }

  async disposeAll(): Promise<void> {
    for (const s of this.sources) await this.host.dispose(s.id).catch(() => {})
  }

  /* ---------------- 查询能力 ---------------- */

  /** 某个平台能用的音源（已启用 + ready + 声明了 musicUrl） */
  getReadySourcesFor(platform: PlatformSource): LoadedSource[] {
    return this.sources.filter(s =>
      s.status === 'ready'
      && this.isEnabled(s.id)
      && s.supports.some(x => x.source === platform && x.actions.includes('musicUrl')),
    )
  }

  /** 该平台所有音源声明的音质并集（用于音质下拉） */
  qualitysFor(platform: PlatformSource): string[] {
    const set = new Set<string>()
    for (const s of this.getReadySourcesFor(platform)) {
      for (const sup of s.supports) {
        if (sup.source === platform) sup.qualitys.forEach(q => set.add(q))
      }
    }
    return QUALITY_ORDER.filter(q => set.has(q))
  }

  /** 降级链顺序：最近成功的排最前，其余按加载顺序 */
  private chainFor(platform: PlatformSource): LoadedSource[] {
    const ready = this.getReadySourcesFor(platform)
    const lastId = this.lastGood.get(platform)
    if (!lastId) return ready
    return [...ready].sort((a, b) => (a.id === lastId ? -1 : b.id === lastId ? 1 : 0))
  }

  /* ---------------- 取播放链接 ---------------- */

  /**
   * 拿可播放 URL。失败不会静默返回空串，而是抛 NoPlayableSourceError，
   * 由 UI 展示「该音源暂无版权」+「换源」。
   *
   * **多个音源是并行跑的，谁先给出「能播的链接」用谁**（2026-10 改）。
   *
   * 以前是串行：音源 A 试完三档（每档还要落地校验一次，单档最多 6 秒）才轮到 B，
   * 用户点一首歌要等好几秒才出声——反馈里「播放还是很慢」主要就是这一段。
   * 音源之间本来互不依赖，串行唯一的好处是省流量；而失败的音源大多是
   * 「这首它没有版权」，一秒钟内就返回了，并行的额外开销很小。
   */
  /** 宿主的 `load` 幂等：同一个 id 再调一次返回已装载的实例，不会重跑脚本 */
  private codes = new Map<string, string>()

  async getMusicUrl(
    platform: PlatformSource,
    musicInfo: unknown,
    quality = '320k',
    opts: { exclude?: string[]; sourceId?: string; expectDuration?: number } = {},
  ): Promise<{ url: string; sourceId: string; sourceName: string; quality: string }> {
    const chain = this.chainFor(platform).filter(s => !opts.exclude?.includes(s.id))
    const tries = opts.sourceId ? chain.filter(s => s.id === opts.sourceId) : chain
    if (!tries.length) throw new NoPlayableSourceError(platform, [])

    const attempts: GetUrlAttempt[] = []
    return new Promise((resolve, reject) => {
      let started = 0
      let pending = 0
      let done = false
      let timer: ReturnType<typeof setTimeout> | null = null

      /*
       * 音源错开上场，**不是一次性全打出去**。
       *
       * 全并行试过一版：四五个音源同时出链、同时校验，请求全砸在同一个域名上，
       * 互相抢带宽还可能被限流，实测最快那条比「只发一个」还慢。
       * 所以改成闸门式：主力（上次成功过的那个，排在最前）立刻走，之后每
       * HEDGE_SOURCE_MS 才放一个进来。前一个顺利出链的话，后面这些根本不会启动；
       * 它卡住了，后面的正好赶上——两头的等待都不浪费。
       */
      const launchNext = (): void => {
        if (done || started >= tries.length) return
        const src = tries[started++]
        pending++
        this.trySource(platform, src, musicInfo, quality, opts.expectDuration).then(
          hit => {
            if (done) return
            done = true
            if (timer) clearTimeout(timer)
            // 记住「这个平台用哪个源成功过」，下次它排最前
            this.lastGood.set(platform, hit.sourceId)
            resolve(hit)
          },
          (e: unknown) => {
            attempts.push({
              sourceId: src.id,
              sourceName: src.name,
              error: e instanceof Error ? e.message : String(e),
            })
            pending--
            if (!done && started >= tries.length && pending === 0) {
              done = true
              if (timer) clearTimeout(timer)
              reject(new NoPlayableSourceError(platform, attempts))
              return
            }
            // 一个都没在跑了：下一个立刻上，不用再等错开的那 320ms
            if (!done && pending === 0 && started < tries.length) {
              if (timer) clearTimeout(timer)
              launchNext()
            }
          },
        )
        if (!done && started < tries.length) timer = setTimeout(launchNext, HEDGE_SOURCE_MS)
      }
      launchNext()
    })
  }

  /**
   * 单个音源：按档位从高到低试，出链 + 落地校验都过才算成功。
   *
   * 档位仍然是**串行**的（无损 → 320k → 128k）：一首歌通常只有一两档失败，
   * 三档同时打会把请求量翻三倍，而收益只是省几十毫秒。
   */
  private async trySource(
    platform: PlatformSource,
    src: LoadedSource,
    musicInfo: unknown,
    quality: string,
    expectDuration?: number,
  ): Promise<{ url: string; sourceId: string; sourceName: string; quality: string }> {
    const sup = src.supports.find(x => x.source === platform)
    const wanted = pickQuality(sup?.qualitys ?? [], quality)
    const ladder = qualitiesToTry(sup?.qualitys ?? [], wanted)
    let lastErr = ''
    const loaded = await this.host.load({
      id: src.id,
      code: this.codes.get(src.id) ?? '',
      filePath: src.filePath,
    })
    for (const q of ladder) {
      try {
        const url = await loaded.requestMusicUrl(platform, musicInfo, q, this.timeoutMs)
        if (!/^https?:\/\//i.test(url)) throw new Error(`返回了非法的播放地址：${String(url).slice(0, 60)}`)
        // 出链成功不代表能播：落地验一次，坏的当这一档失败，继续降档/换源
        if (this.verify) {
          await withTimeout(
            this.verify(url, { duration: expectDuration }),
            6_000,
            '直链校验超时',
          )
        }
        return { url, sourceId: src.id, sourceName: src.name, quality: q }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        // 脚本没这个档位的能力/超时：档位问题，继续往下降
        // 其它异常（返回非法地址、直链 403 等）也往下试——代价只是一次请求
      }
    }
    // 档位都试过了：把最后一个真实原因带上，别只说「失败」
    throw new Error(ladder.length > 1 ? `${ladder.join('/')} 均失败：${lastErr}` : lastErr)
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function toSupports(sources: Record<string, any> | undefined): SourceSupport[] {
  if (!sources) return []
  return Object.entries(sources).map(([source, v]) => ({
    source: source as PlatformSource,
    qualitys: Array.isArray(v?.qualitys) ? v.qualitys.map(String) : [],
    actions: Array.isArray(v?.actions) ? v.actions.map(String) : [],
  }))
}

/** 从源码里扫出它主动请求的域名（给设置页做「会外联」提示） */
export function scanOutbound(code: string): string[] {
  const set = new Set<string>()
  const re = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const host = m[1].toLowerCase()
    // 平台自家域名不算「外联」
    if (/(^|\.)(qq\.com|kugou\.com|kuwo\.cn|126\.net|163\.com|migu\.cn)$/.test(host)) continue
    set.add(host)
  }
  return [...set].slice(0, 12)
}

/** 路径 → 稳定 id（短 hash，避免文件名里的中文/空格进 DOM id） */
export function hashId(input: string): string {
  let h1 = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193)
  }
  return (h1 >>> 0).toString(36)
}

const stripExt = (name: string) => name.replace(/\.js$/i, '')

/**
 * 从脚本头部的注释里抠元数据：洛雪音源脚本约定用 `/*! … *\/` 块写
 * `@name / @version / @author`，用户看到的「音源叫什么」应该以它为准——
 * 文件名经常是「洛雪音源1.js」「下载 (3).js」这种，拿它当名字没法看。
 * 脚本自己在 inited 里带的 meta 优先级更高（个别脚本会动态生成名字）。
 */
export function parseHeaderMeta(code: string): { name?: string; version?: string; author?: string } {
  const head = code.slice(0, 6000)
  const grab = (key: string): string | undefined => {
    const m = new RegExp(`@${key}[ \\t]+([^\\r\\n]+)`, 'i').exec(head)
    if (!m) return undefined
    // 行尾可能是块注释的收口 `*/`，一起去掉
    const v = m[1].replace(/\*\/\s*$/, '').trim()
    return v || undefined
  }
  const ver = grab('version')?.replace(/^v/i, '')
  return { name: grab('name'), version: ver, author: grab('author') }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}
