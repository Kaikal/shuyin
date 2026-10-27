/**
 * 配置包：把「能带走的东西」打成一个 JSON。
 *
 * 没有账号也能用——这是「换台电脑接着用」的底线方案：
 * 歌单（自建/导入/收藏）、音源脚本、主题与各项设置全在一个文件里，
 * 拷到另一台机器导入即恢复。登录云端之后，同一个函数产出的包就是同步内容，
 * 所以两条路的数据范围永远一致（不会出现「同步有、备份没有」这种破事）。
 *
 * 刻意**不打包**的东西：数据库里的曲库索引、播放缓存、下载的音乐。
 * 那些是「这台机器上的文件」，拷到别的机器路径就错了，体积也大；
 * 歌单里存的是曲库 id，到了新机器重扫一次曲库，同路径的歌会自动对上。
 */
import { bridge } from './bridge'
import { KEYS, settings } from './settings'

export const BACKUP_APP = 'shuyin'
export const BACKUP_VERSION = 1

export interface BackupSource {
  name: string
  code: string
}

export interface BackupBundle {
  app: typeof BACKUP_APP
  version: number
  createdAt: number
  /** 设置项（含歌单、快捷键、主题、音源开关…） */
  settings: Record<string, unknown>
  /** 音源脚本（代码内嵌，导入时走「粘贴代码」那条正规通道） */
  sources: BackupSource[]
}

/** 参与备份的设置项：只挑用户自己的配置，不含窗口/会话之类的瞬时状态 */
const BACKUP_KEYS: string[] = [
  KEYS.mode,
  KEYS.activeTheme,
  KEYS.customThemes,
  KEYS.reducedMotion,
  KEYS.volume,
  KEYS.autoResume,
  KEYS.repeat,
  KEYS.onlineQuality,
  KEYS.localPlaylists,
  KEYS.favPlaylists,
  KEYS.recentImports,
  KEYS.hotkeysOn,
  KEYS.hotkeysMedia,
  KEYS.hotkeysMap,
  KEYS.lyricAlign,
  KEYS.lyricsLook,
  KEYS.lyricsFont,
  KEYS.lyricsWidth,
  KEYS.lyricsBg,
  KEYS.lyricsColor,
  KEYS.foliaFx,
  KEYS.lyricsSolo,
  KEYS.vinylView,
  KEYS.spectrumStyle,
  KEYS.spectrumPos,
  KEYS.audioFx,
  KEYS.audioFxBands,
  KEYS.audioFxName,
  KEYS.scanDirs,
  KEYS.sourcesOff,
  KEYS.searchHistory,
  KEYS.uiQuery,
]

/** 收集当前状态 → 配置包 */
export async function collectBundle(): Promise<BackupBundle> {
  const map: Record<string, unknown> = {}
  await Promise.all(BACKUP_KEYS.map(async k => {
    try {
      const v = await settings.get<unknown>(k)
      if (v !== null && v !== undefined) map[k] = v
    } catch { /* 单项失败不影响整包 */ }
  }))
  let sources: BackupSource[] = []
  try {
    sources = (await bridge.listSourceScripts()).map(s => ({ name: s.name, code: s.code }))
  } catch { sources = [] }
  return { app: BACKUP_APP, version: BACKUP_VERSION, createdAt: Date.now(), settings: map, sources }
}

export interface ApplyReport {
  settings: number
  playlists: number
  favorites: number
  sources: number
  skippedSources: string[]
}

/** 合并两个歌单数组：同 id 的以新的为准，其余追加（不覆盖对方独有的歌单） */
function mergeLists<T extends { id?: string; key?: string; name?: string }>(oldV: unknown, newV: unknown): T[] {
  const a = Array.isArray(oldV) ? (oldV as T[]) : []
  const b = Array.isArray(newV) ? (newV as T[]) : []
  const out = [...a]
  for (const item of b) {
    const k = item.id ?? item.key ?? item.name
    const i = out.findIndex(x => (x.id ?? x.key ?? x.name) === k)
    if (i >= 0) out[i] = item
    else out.push(item)
  }
  return out
}

/**
 * 导入配置包。
 * @param merge true = 合并歌单（默认，不会把本机原有歌单冲掉）；false = 完全覆盖
 */
export async function applyBundle(bundle: BackupBundle, merge = true): Promise<ApplyReport> {
  if (!bundle || bundle.app !== BACKUP_APP) throw new Error('这不是疏音的配置包')
  const report: ApplyReport = { settings: 0, playlists: 0, favorites: 0, sources: 0, skippedSources: [] }

  for (const [k, v] of Object.entries(bundle.settings ?? {})) {
    if (!BACKUP_KEYS.includes(k)) continue
    let value = v
    if (merge && k === KEYS.localPlaylists) {
      value = mergeLists(await settings.get(KEYS.localPlaylists), v)
    } else if (merge && k === KEYS.favPlaylists) {
      value = mergeLists(await settings.get(KEYS.favPlaylists), v)
    }
    await settings.set(k, value)
    report.settings++
  }
  report.playlists = Array.isArray((await settings.get(KEYS.localPlaylists))) ? ((await settings.get<unknown[]>(KEYS.localPlaylists))?.length ?? 0) : 0
  report.favorites = ((await settings.get<unknown[]>(KEYS.favPlaylists))?.length) ?? 0

  for (const s of bundle.sources ?? []) {
    if (!s?.code || !s.name) continue
    try {
      await bridge.importSourceText(s.name, s.code)
      report.sources++
    } catch {
      report.skippedSources.push(s.name)
    }
  }
  return report
}

/** 导出到文件，返回写到的路径（用户取消返回 null） */
export async function exportBundleToFile(): Promise<string | null> {
  const bundle = await collectBundle()
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const name = `疏音配置-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`
  const path = await bridge.pickSaveFile(name)
  if (!path) return null
  await bridge.writeTextAbs(path, JSON.stringify(bundle, null, 2))
  return path
}

/** 从文件读配置包（不应用） */
export async function readBundleFromFile(): Promise<BackupBundle | null> {
  const path = await bridge.invoke<string | null>('pick_playlist_file')
  if (!path) return null
  const text = await bridge.invoke<string>('read_text_abs', { path })
  const data = JSON.parse(text) as BackupBundle
  if (!data || data.app !== BACKUP_APP) throw new Error('这不是疏音的配置包（缺少 app: shuyin 标记）')
  return data
}

/** 配置包里到底有多少东西（导入前给用户看一眼） */
export function summarize(bundle: BackupBundle) {
  const ls = (bundle.settings?.[KEYS.localPlaylists] as unknown[]) ?? []
  const fs = (bundle.settings?.[KEYS.favPlaylists] as unknown[]) ?? []
  const th = (bundle.settings?.[KEYS.customThemes] as unknown[]) ?? []
  return {
    at: bundle.createdAt ? new Date(bundle.createdAt).toLocaleString('zh-CN') : '未知时间',
    playlists: ls.length,
    favorites: fs.length,
    themes: th.length,
    sources: bundle.sources?.length ?? 0,
    keys: Object.keys(bundle.settings ?? {}).length,
  }
}
