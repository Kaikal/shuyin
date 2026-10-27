/**
 * MD5（输出 32 位小写十六进制）。
 *
 * 有些平台接口要前端自己算签名（酷狗网关的 `signature` 就是
 * `md5(盐 + 排序后的参数串 + 请求体 + 盐)`）。WebView 里既没有 node 的
 * `crypto`，`crypto.subtle` 也不提供 MD5（只有 SHA 系列，而且是异步的），
 * 所以在这里实现一份——签名串基本都是 ASCII，按 UTF-8 处理足够。
 */

const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c))

/** 字符串 → UTF-8 字节（按码点遍历，代理对不会被拆坏） */
function utf8Bytes(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return out
}

/** 每轮的循环左移位数 */
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]

/** K[i] = floor(abs(sin(i + 1)) * 2^32)，标准常量，现算省得写 64 个数 */
const K = (() => {
  const k = new Int32Array(64)
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0
  return k
})()

function le32(n: number): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += ((n >>> (8 * i)) & 0xff).toString(16).padStart(2, '0')
  return s
}

export function md5Hex(input: string): string {
  const bytes = utf8Bytes(input)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  // 长度是 64 位小端；实际串不会超过 2^32 位，高位补 0 就够了
  const lo = bitLen >>> 0
  const hi = Math.floor(bitLen / 0x100000000) >>> 0
  for (let i = 0; i < 4; i++) bytes.push((lo >>> (8 * i)) & 0xff)
  for (let i = 0; i < 4; i++) bytes.push((hi >>> (8 * i)) & 0xff)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let off = 0; off < bytes.length; off += 64) {
    const m = new Int32Array(16)
    for (let i = 0; i < 16; i++) {
      m[i] = bytes[off + i * 4]
        | (bytes[off + i * 4 + 1] << 8)
        | (bytes[off + i * 4 + 2] << 16)
        | (bytes[off + i * 4 + 3] << 24)
    }
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      const tmp = d
      d = c
      c = b
      b = (b + rotl((a + f + K[i] + m[g]) | 0, S[(i >> 4) * 4 + (i % 4)])) | 0
      a = tmp
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  return le32(a0) + le32(b0) + le32(c0) + le32(d0)
}
