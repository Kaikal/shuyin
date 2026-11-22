#!/usr/bin/env node
/**
 * 把官网拆成两份可上传的产物（页面与安装包分开托管）：
 *
 *   dist/site/      静态托管的部署目录 = index.html + assets/ + downloads.json
 *                   约 70KB。CloudBase 静态托管、Cloudflare Pages 都拖这个目录。
 *
 *   dist/release/   发行版附件，纯 ASCII 文件名，约 22MB。
 *                   上传到 Gitee 的 Releases（仓库 ghpgitee/shuyin-update），
 *                   一个 tag 对应一个版本。
 *
 * 页面里不含任何安装包，下载地址全部由 downloads.json 提供。所以静态托管的
 * 流量只花在几十 KB 的 HTML 上，安装包流量走代码托管平台，互不影响。
 *
 * 为什么不走 Gitee 的 raw 地址：raw 匿名下载有大小上限，实测 4.8MB 的 IPA 能下、
 * 10.7MB 的 dmg 直接 403。Releases 附件没有这个问题（0.5.25 的 dmg 10.3MB 实测 200）。
 *
 * 用法：
 *   node build-site.mjs                       # 默认发到 Gitee Releases
 *   node build-site.mjs --base https://...    # 换成任意同构的下载前缀
 *   node build-site.mjs --github owner/repo   # 临时用 GitHub Releases
 *
 * 省略时沿用 downloads.json 里已有的 base；只有它指向别处（比如旧版留下的
 * github.com）才会被改回默认的 Gitee 地址。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const DIST = path.join(ROOT, 'dist')
const OUT_SITE = path.join(DIST, 'site')
const OUT_REL = path.join(DIST, 'release')
const CFG_PATH = path.join(HERE, 'downloads.json')

/*
 * 端 → dist/ 里的包名规则 + 对外（发行版附件）的文件名。
 *
 * 只认这些「规整过」的名字：dist/ 里同时躺着最新包和历史包时，靠文件名里的
 * 版本号 + mtime 挑最新的一份（见下面第 2 步）。名字对不上就会被当成陌生文件
 * 跳过——所以从 CI 拉包回来要按这个格式改名。
 */
const SPECS = [
  { id: 'android', re: /^疏音_([\d.]+)_android_phone\.apk$/, out: v => `shuyin-android-${v}.apk` },
  { id: 'car', re: /^疏音_([\d.]+)_android_car\.apk$/, out: v => `shuyin-car-${v}.apk` },
  { id: 'windows', re: /^Shuyin_([\d.]+)_x64-setup\.exe$/, out: v => `shuyin-windows-${v}.exe` },
  { id: 'ios', re: /^疏音_([\d.]+)_ios_unsigned\.ipa$/, out: v => `shuyin-ios-${v}.ipa` },
  { id: 'macos', re: /^Shuyin_([\d.]+)_macos\.dmg$/, out: v => `shuyin-macos-${v}.dmg` },
]

const argv = process.argv.slice(2)

/**
 * 默认下载源：Gitee 的释放附件。
 *
 * 对国内用户，Gitee 是唯一能稳定跑满带宽的一条；GitHub 的 releases 在这里
 * 经常要几百 KB/s 甚至直连失败。所以默认值写死 Gitee，别再用 GitHub 当主地址。
 */
const DEFAULT_BASE = 'https://gitee.com/ghpgitee/shuyin-update/releases/download'

/*
 * 两个入口：
 *   --base <完整前缀>      直接指定，任何同构的 Releases 都能用
 *   --github owner/repo   拼成 GitHub Releases 的下载前缀（备用）
 * 都不给就用 downloads.json 里已有的 base；它若是空的或还指着 GitHub，落回默认。
 */
const baseArg = (() => {
  const i = argv.indexOf('--base')
  if (i >= 0) return argv[i + 1] || ''

  const g = argv.indexOf('--github')
  if (g >= 0) {
    const slug = (argv[g + 1] || '').replace(/^\/+|\/+$/g, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
      console.error('✗ --github 要写成 「账号/仓库名」，例如 --github yourname/shuyin')
      process.exit(1)
    }
    return `https://github.com/${slug}/releases/download`
  }
  return ''
})()

const mb = n => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB')
const log = (...a) => console.log(...a)

/* ---------- 1. 读旧配置（用来兜住还没出的包） ---------- */
let cfg = { base: '', headline: '', items: [] }
try {
  cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
} catch {
  log('· 没有可用的 downloads.json，按全新生成')
}
const old = new Map((cfg.items || []).map(it => [it.id, it]))

/* ---------- 2. 在 dist/ 里挑最新包 ---------- */
/*
 * 两处都要扫：dist/ 根目录，以及按日期归档的子目录（dist/2026-11-22/）。
 * 从 CI 拉回来的包习惯先归到日期目录里，只扫根目录会一个都找不到。
 * dist/site 与 dist/release 是本脚本自己的产物，跳过——那里面是改过名的副本，
 * 名字本来就不匹配 SPECS，但扫进来会让「找最新」这一步读到上一轮的 mtime。
 */
const SKIP = new Set([OUT_SITE, OUT_REL])
let searched = []
try {
  searched = [
    DIST,
    ...fs.readdirSync(DIST, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SKIP.has(path.join(DIST, e.name)))
      .map(e => path.join(DIST, e.name)),
  ]
} catch {
  console.error(`✗ 找不到目录 ${DIST}`)
  process.exit(1)
}

const candidates = []
for (const dir of searched) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isFile()) continue
    candidates.push({ name, full, size: st.size, mtime: st.mtimeMs })
  }
}

const picked = new Map()
for (const spec of SPECS) {
  const hits = candidates
    .map(c => ({ c, m: spec.re.exec(c.name) }))
    .filter(x => x.m)
    .map(x => ({ ...x.c, version: x.m[1] }))
    .sort((a, b) => b.mtime - a.mtime)

  if (hits.length) picked.set(spec.id, { ...hits[0], out: spec.out(hits[0].version) })
  else if (old.has(spec.id)) log(`! dist/ 里没有 ${spec.id} 的新包，沿用上次记录`)
  else log(`! dist/ 里没有 ${spec.id} 的包，本次跳过`)
}

/* ---------- 3. 生成 downloads.json ---------- */
const items = []
for (const spec of SPECS) {
  const hit = picked.get(spec.id)
  const prev = old.get(spec.id) || {}
  if (hit) {
    items.push({
      id: spec.id,
      version: hit.version,
      tag: `v${hit.version}`,
      file: hit.out,
      size: hit.size,
      /*
       * mirror 只在人工配置时才有意义（比如某个平台临时换线路）。
       * 默认留空——页面上就不会多出「备用线路」那一行，主地址已经是 Gitee 了。
       */
      mirror: '',
    })
  } else if (prev.id) {
    items.push({ ...prev, mirror: prev.mirror || '' })
  }
}

/* 旧版把 base 写在 downloads.json 里指着 github.com，这里纠正回 Gitee */
const stored = (cfg.base || '').replace(/\/+$/, '')
const base = (baseArg || (stored && !/github\.com/i.test(stored) ? stored : DEFAULT_BASE)).replace(/\/+$/, '')

/* 首屏那行小字：版本号自动跟着走，后半句（功能点）保留手写的那部分 */
const androidVer = items.find(i => i.id === 'android')?.version
const suffix = /^v[\d.]+\s*·\s*(.+)$/.exec(cfg.headline || '')?.[1] || '已支持平板大屏'
const headline = androidVer ? `v${androidVer} · ${suffix}` : cfg.headline || ''

const nextCfg = { base, headline, items }
fs.writeFileSync(CFG_PATH, JSON.stringify(nextCfg, null, 2) + '\n', 'utf8')

/* ---------- 4. 产出 dist/site/ ---------- */
fs.rmSync(OUT_SITE, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT_SITE, 'assets'), { recursive: true })
fs.copyFileSync(path.join(HERE, 'index.html'), path.join(OUT_SITE, 'index.html'))
for (const f of fs.readdirSync(path.join(HERE, 'assets'))) {
  fs.copyFileSync(path.join(HERE, 'assets', f), path.join(OUT_SITE, 'assets', f))
}
fs.copyFileSync(CFG_PATH, path.join(OUT_SITE, 'downloads.json'))

/* ---------- 5. 产出 dist/release/ ---------- */
fs.rmSync(OUT_REL, { recursive: true, force: true })
fs.mkdirSync(OUT_REL, { recursive: true })
for (const [id, hit] of picked) {
  fs.copyFileSync(hit.full, path.join(OUT_REL, hit.out))
  void id
}

/* ---------- 6. 汇报 ---------- */
const sizeOf = p => {
  const walk = d =>
    fs.readdirSync(d, { withFileTypes: true }).reduce(
      (s, e) => s + (e.isDirectory() ? walk(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size),
      0,
    )
  return walk(p)
}

log('')
log('dist/site/    ' + mb(sizeOf(OUT_SITE)).padStart(8) + '   → 传到静态托管')
for (const it of items) {
  const live = picked.has(it.id)
  log(`  ${live ? '✓' : '·'} ${it.file.padEnd(32)} ${mb(it.size).padStart(8)}`)
}
log('')
log('dist/release/ ' + mb(sizeOf(OUT_REL)).padStart(8) + '   → 传到 Releases')
for (const [, hit] of picked) log('  ' + hit.out)
log('')
if (base) {
  log('下载地址：')
  for (const it of items) log(`  ${base}/${it.tag}/${it.file}`)
} else {
  log('⚠ base 还是空的，页面上的按钮会停在灰态。')
}
log('')
