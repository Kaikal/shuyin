#!/usr/bin/env node
/**
 * 把官网拆成两份可上传的产物（页面与安装包分开托管）：
 *
 *   dist/site/      静态托管的部署目录 = index.html + assets/ + downloads.json
 *                   约 70KB。CloudBase 静态托管、Cloudflare Pages 都拖这个目录。
 *
 *   dist/release/   发行版附件，纯 ASCII 文件名，约 13MB。
 *                   上传到 Gitee / GitHub 的 Releases，一个 tag 对应一个版本。
 *
 * 页面里不含任何安装包，下载地址全部由 downloads.json 提供。所以静态托管的
 * 流量只花在几十 KB 的 HTML 上，安装包流量走代码托管平台，互不影响。
 *
 * 用法：
 *   node build-site.mjs
 *   node build-site.mjs --github 你的账号/仓库名
 *   node build-site.mjs --base https://github.com/you/shuyin/releases/download
 *
 * 省略时沿用 downloads.json 里已有的 base，不会清空。
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

/* 端 → dist/ 里的包名规则 + 对外（发行版附件）的文件名 */
const SPECS = [
  { id: 'android', re: /^疏音_([\d.]+)_android_phone\.apk$/, out: v => `shuyin-android-${v}.apk` },
  { id: 'car', re: /^疏音_([\d.]+)_android_car\.apk$/, out: v => `shuyin-car-${v}.apk` },
  { id: 'windows', re: /^Shuyin_([\d.]+)_x64-setup\.exe$/, out: v => `shuyin-windows-${v}.exe` },
]

const argv = process.argv.slice(2)

/*
 * 两个入口：
 *   --github owner/repo   拼成 GitHub Releases 的下载前缀（推荐，少写错）
 *   --base <完整前缀>      直接指定，Gitee 或任何同构的 Releases 都能用
 * 两者都不给就沿用 downloads.json 里的 base。
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
let names = []
try {
  names = fs.readdirSync(DIST)
} catch {
  console.error(`✗ 找不到目录 ${DIST}`)
  process.exit(1)
}

const picked = new Map()
for (const spec of SPECS) {
  const hits = names
    .map(name => ({ name, m: spec.re.exec(name) }))
    .filter(x => x.m)
    .map(x => ({
      name: x.name,
      version: x.m[1],
      size: fs.statSync(path.join(DIST, x.name)).size,
      mtime: fs.statSync(path.join(DIST, x.name)).mtimeMs,
    }))
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
      mirror: prev.mirror || '',
    })
  } else if (prev.id) {
    items.push({ ...prev, mirror: prev.mirror || '' })
  }
}

const base = (baseArg || cfg.base || '').replace(/\/+$/, '')

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
  fs.copyFileSync(path.join(DIST, hit.name), path.join(OUT_REL, hit.out))
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
  log('⚠ base 还是空的，页面上的按钮会停在灰态。建好发行版后重跑：')
  log('    node build-site.mjs --github <你的账号>/<仓库名>')
  log('  用 Gitee 就换成 --base https://gitee.com/<账号>/<仓库名>/releases/download')
  log('  （也可以只改 downloads.json 的 base，传这一个文件就够，不用重传 index.html）')
}
log('')
