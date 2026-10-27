/**
 * 生成安卓启动图标（PNG）——与 Windows 桌面端 icon 同一套品牌图形。
 *
 * 品牌构图（从桌面 icon.png 像素级还原）：
 *   - 深底 #0F0B0A 圆角方块
 *   - 三根珊瑚色 #FF8B6E 圆头竖条：左短(103/256) 中长(139) 右更短(79)，
 *     像音量条的错落节奏
 *   - 右上一颗淡蓝点 #6EA9C9（“正在播放”的小呼吸点）
 * 仓库里没有位图工具链，所以继续手写 PNG 编码（zlib + CRC32），
 * 只依赖 Node 内置模块。
 *
 * 用法：node tools/gen-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const OUT = 'app/src/main/res'

/* 安卓传统密度（ic_launcher.png）；自适应图标走 mipmap-anydpi-v26 的 XML */
const SIZES = { 'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 }

/* 品牌色（与桌面 icons/icon.png 一致） */
const BG = [15, 11, 10]        // #0F0B0A
const BAR = [255, 139, 110]    // #FF8B6E 珊瑚
const DOT = [110, 169, 201]    // #6EA9C9 淡蓝

/* 三根条在 256 基准坐标里的位置：中心x、顶端y、底端y、宽度（圆头=宽度/2 半径） */
const BARS = [
  { cx: 92,  top: 53, bottom: 155 },
  { cx: 128, top: 37, bottom: 175 },
  { cx: 164, top: 65, bottom: 143 },
]
const BAR_W = 27
const DOT_POS = { cx: 196, cy: 96, r: 9 }

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function png(size) {
  const s = size / 256
  const px = new Uint8Array(size * size * 4)
  const radius = 57 * s          // 圆角半径（与桌面观感一致）
  const barW = BAR_W * s
  const r2 = (barW / 2) * (barW / 2)

  const insideRound = (x, y) => {
    /* 圆角矩形内测试：先当矩形，四角再按圆判 */
    const rx = radius
    if (x < rx && y < rx) { const dx = rx - x - .5, dy = rx - y - .5; return dx * dx + dy * dy <= rx * rx }
    if (x >= size - rx && y < rx) { const dx = x - (size - rx) + .5, dy = rx - y - .5; return dx * dx + dy * dy <= rx * rx }
    if (x < rx && y >= size - rx) { const dx = rx - x - .5, dy = y - (size - rx) + .5; return dx * dx + dy * dy <= rx * rx }
    if (x >= size - rx && y >= size - rx) { const dx = x - (size - rx) + .5, dy = y - (size - rx) + .5; return dx * dx + dy * dy <= rx * rx }
    return true
  }

  /* 每根条 = 两个圆头 + 中间矩形 */
  const inBar = (x, y) => {
    for (const b of BARS) {
      const cx = b.cx * s, top = b.top * s, bot = b.bottom * s
      if (Math.abs(x - cx) > barW / 2) continue
      if (y >= top + barW / 2 && y <= bot - barW / 2) return true          // 躯干
      const cy = y < (top + bot) / 2 ? top + barW / 2 : bot - barW / 2
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy <= r2) return true                              // 圆头
    }
    return false
  }

  const inDot = (x, y) => {
    const dx = x - DOT_POS.cx * s, dy = y - DOT_POS.cy * s
    const rr = DOT_POS.r * s
    return dx * dx + dy * dy <= rr * rr
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const [r, g, b, a] = insideRound(x + .5, y + .5)
        ? inBar(x, y) ? [...BAR, 255]
          : inDot(x, y) ? [...DOT, 255]
            : [...BG, 255]
        : [0, 0, 0, 0]
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
    }
  }

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6   // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [dir, size] of Object.entries(SIZES)) {
  const out = join(OUT, dir, 'ic_launcher.png')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, png(size))
  console.log('✓', out, size + '×' + size)
}

/* 通知栏小图标：纯白剪影（安卓要求单色 alpha 图标）——只留三根条 */
function pngNotif(size) {
  const s = size / 256
  const px = new Uint8Array(size * size * 4)
  const barW = BAR_W * s
  const r2 = (barW / 2) * (barW / 2)
  const inBar = (x, y) => {
    for (const b of BARS) {
      const cx = b.cx * s, top = b.top * s, bot = b.bottom * s
      if (Math.abs(x - cx) > barW / 2) continue
      if (y >= top + barW / 2 && y <= bot - barW / 2) return true
      const cy = y < (top + bot) / 2 ? top + barW / 2 : bot - barW / 2
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy <= r2) return true
    }
    return false
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    const on = inBar(x, y)
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = on ? 255 : 0
  }
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
for (const [dir, size] of Object.entries({ 'mipmap-mdpi': 24, 'mipmap-hdpi': 36, 'mipmap-xhdpi': 48, 'mipmap-xxhdpi': 72, 'mipmap-xxxhdpi': 96 })) {
  const out = join(OUT, dir, 'ic_notif.png')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, pngNotif(size))
  console.log('✓', out)
}
console.log('完成：图形已与 Windows 桌面端图标统一')
