/**
 * 酷狗登录要用的两段密码学（纯 JS，同步）。
 *
 * 单独拆出来有两个原因：
 *   1. 算法本身可以脱离网络单独验（拿 AES 标准测试向量跑一遍就知道对不对）；
 *   2. `lib/kgLogin.ts` 里混着请求和文案，出问题时不好定位是哪一层错了。
 *
 * **不用 WebCrypto**：`crypto.subtle` 只在安全上下文里存在，安卓 WebView
 * 从 `file://` 起来时整个是 undefined；而且它没有 MD5、也没有 RSA 的
 * NO_PADDING。一次登录只加密几十字节，纯 JS 完全够。
 */
import { md5Hex } from '@shuyin/lx-provider'

/* ------------------------------------------------------------------ */
/* 字节工具                                                            */
/* ------------------------------------------------------------------ */

export function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return Uint8Array.from(out)
}

export function fromUtf8(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length;) {
    const c = b[i++]
    if (c < 0x80) s += String.fromCharCode(c)
    else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 63))
    else if (c < 0xf0) {
      const c2 = b[i++] & 63
      s += String.fromCharCode(((c & 0x0f) << 12) | (c2 << 6) | (b[i++] & 63))
    } else {
      const c2 = b[i++] & 63
      const c3 = b[i++] & 63
      const cp = ((c & 0x07) << 18) | (c2 << 12) | (c3 << 6) | (b[i++] & 63)
      s += String.fromCodePoint(cp)
    }
  }
  return s
}

export const toHex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c?.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256)
  return b
}

/* ------------------------------------------------------------------ */
/* AES-256-CBC                                                         */
/* ------------------------------------------------------------------ */

/** GF(2^8) 乘法，模多项式 0x11b */
function gfMul(a: number, b: number): number {
  let r = 0
  while (b) {
    if (b & 1) r ^= a
    a = ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff
    b >>= 1
  }
  return r
}

/**
 * S 盒现算，不抄 256 个常量。
 *
 * 它就是「GF(2^8) 求逆 + 仿射变换」。抄表看着省事，但抄错一个字节会得到一个
 * 能跑、却解不出明文的实现——现算至少保证和 GF 定义自洽。
 */
function buildSbox(): { sbox: Uint8Array; inv: Uint8Array } {
  const mulInv = new Uint8Array(256)
  for (let i = 1; i < 256; i++) {
    for (let j = 1; j < 256; j++) {
      if (gfMul(i, j) === 1) { mulInv[i] = j; break }
    }
  }
  const sbox = new Uint8Array(256)
  const invSbox = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    let s = mulInv[i]
    let r = s
    for (let k = 0; k < 4; k++) {
      r = ((r << 1) | (r >>> 7)) & 0xff
      s ^= r
    }
    const v = s ^ 0x63
    sbox[i] = v
    invSbox[v] = i
  }
  return { sbox, inv: invSbox }
}

let boxes: { sbox: Uint8Array; inv: Uint8Array } | null = null
const getBoxes = () => (boxes ??= buildSbox())

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]

/** 密钥扩展 → (Nr+1) 个 16 字节轮密钥首尾相接 */
function expandKey(key: Uint8Array): Uint8Array {
  const nk = key.length / 4
  const nr = nk + 6
  const w = new Uint8Array(16 * (nr + 1))
  w.set(key)
  const { sbox } = getBoxes()
  let rc = 0
  for (let i = nk; i < 4 * (nr + 1); i++) {
    const p = (i - 1) * 4
    let t0 = w[p]
    let t1 = w[p + 1]
    let t2 = w[p + 2]
    let t3 = w[p + 3]
    if (i % nk === 0) {
      const tmp = t0
      t0 = sbox[t1] ^ RCON[rc++]
      t1 = sbox[t2]
      t2 = sbox[t3]
      t3 = sbox[tmp]
    } else if (nk > 6 && i % nk === 4) {
      t0 = sbox[t0]
      t1 = sbox[t1]
      t2 = sbox[t2]
      t3 = sbox[t3]
    }
    const q = (i - nk) * 4
    w[i * 4] = w[q] ^ t0
    w[i * 4 + 1] = w[q + 1] ^ t1
    w[i * 4 + 2] = w[q + 2] ^ t2
    w[i * 4 + 3] = w[q + 3] ^ t3
  }
  return w
}

function addRoundKey(s: Uint8Array, w: Uint8Array, round: number) {
  for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i]
}

function subBytes(s: Uint8Array, box: Uint8Array) {
  for (let i = 0; i < 16; i++) s[i] = box[s[i]]
}

/** state 按列存放：`s[r + 4c]` */
function shiftRows(s: Uint8Array) {
  let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t
  t = s[2]; s[2] = s[10]; s[10] = t
  t = s[6]; s[6] = s[14]; s[14] = t
  t = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = t
}

function invShiftRows(s: Uint8Array) {
  let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t
  t = s[2]; s[2] = s[10]; s[10] = t
  t = s[6]; s[6] = s[14]; s[14] = t
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t
}

function mixColumns(s: Uint8Array) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a0 = s[i]
    const a1 = s[i + 1]
    const a2 = s[i + 2]
    const a3 = s[i + 3]
    s[i] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3
    s[i + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3
    s[i + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3)
    s[i + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2)
  }
}

function invMixColumns(s: Uint8Array) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a0 = s[i]
    const a1 = s[i + 1]
    const a2 = s[i + 2]
    const a3 = s[i + 3]
    s[i] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9)
    s[i + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13)
    s[i + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11)
    s[i + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14)
  }
}

function encryptBlock(s: Uint8Array, w: Uint8Array) {
  const { sbox } = getBoxes()
  const nr = w.length / 16 - 1
  addRoundKey(s, w, 0)
  for (let r = 1; r < nr; r++) {
    subBytes(s, sbox)
    shiftRows(s)
    mixColumns(s)
    addRoundKey(s, w, r)
  }
  subBytes(s, sbox)
  shiftRows(s)
  addRoundKey(s, w, nr)
}

function decryptBlock(s: Uint8Array, w: Uint8Array) {
  const { inv } = getBoxes()
  const nr = w.length / 16 - 1
  addRoundKey(s, w, nr)
  for (let r = nr - 1; r > 0; r--) {
    invShiftRows(s)
    subBytes(s, inv)
    addRoundKey(s, w, r)
    invMixColumns(s)
  }
  invShiftRows(s)
  subBytes(s, inv)
  addRoundKey(s, w, 0)
}

function cbcRun(input: Uint8Array, w: Uint8Array, iv: Uint8Array, decrypt: boolean): Uint8Array {
  const out = new Uint8Array(input.length)
  let prev = iv
  for (let off = 0; off < input.length; off += 16) {
    const block = input.subarray(off, off + 16)
    if (decrypt) {
      const t = Uint8Array.from(block)
      decryptBlock(t, w)
      for (let i = 0; i < 16; i++) out[off + i] = t[i] ^ prev[i]
      prev = block
    } else {
      const t = Uint8Array.from(block)
      for (let i = 0; i < 16; i++) t[i] ^= prev[i]
      encryptBlock(t, w)
      out.set(t, off)
      prev = t
    }
  }
  return out
}

/** PKCS#7 补位到 16 的倍数 */
function pkcs7(b: Uint8Array): Uint8Array {
  const pad = 16 - (b.length % 16)
  const out = new Uint8Array(b.length + pad)
  out.set(b)
  out.fill(pad, b.length)
  return out
}

/**
 * 酷狗那套「AES key 由 md5 派生」的规则：
 * `md5(临时串)` 的前 32 个字符当 key，末 16 个当 iv（都是 ASCII 字节）。
 */
function keyIv(tempKey: string): { key: Uint8Array; iv: Uint8Array } {
  const keyHex = md5Hex(tempKey).slice(0, 32)
  return { key: utf8(keyHex), iv: utf8(keyHex.slice(-16)) }
}

/** AES-256-CBC 加密，返回 hex 密文 + 本次的临时 key（解对方回包要用） */
export function aesEncrypt(text: string): { str: string; key: string } {
  const tempKey = toHex(randomBytes(8))
  const { key, iv } = keyIv(tempKey)
  const w = expandKey(key)
  return { str: toHex(cbcRun(pkcs7(utf8(text)), w, iv, false)), key: tempKey }
}

/** 用同一个临时 key 解 `secu_params`（hex） */
export function aesDecrypt(hex: string, tempKey: string): string {
  const { key, iv } = keyIv(tempKey)
  const w = expandKey(key)
  const plain = cbcRun(fromHex(hex), w, iv, true)
  const pad = plain[plain.length - 1]
  const body = pad > 0 && pad <= 16 && pad <= plain.length ? plain.subarray(0, plain.length - pad) : plain
  return fromUtf8(body)
}

/* ------------------------------------------------------------------ */
/* RSA（NO_PADDING）                                                   */
/* ------------------------------------------------------------------ */

const bytesToBig = (b: Uint8Array): bigint => {
  let v = 0n
  for (const x of b) v = (v << 8n) | BigInt(x)
  return v
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return r
}

/** 从 X.509 公钥里抠出 n 和 e（找 `02 81 81 00` 这个 129 字节 INTEGER） */
function publicNumbers(pem: string): { n: bigint; e: bigint } {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(b64)
  const der: number[] = []
  for (let i = 0; i < bin.length; i++) der.push(bin.charCodeAt(i))
  for (let i = 0; i + 132 <= der.length; i++) {
    if (der[i] === 0x02 && der[i + 1] === 0x81 && der[i + 2] === 0x81 && der[i + 3] === 0x00) {
      return {
        n: bytesToBig(Uint8Array.from(der.slice(i + 4, i + 132))),
        e: bytesToBig(Uint8Array.from(der.slice(i + 132 + 2, i + 132 + 5))),
      }
    }
  }
  throw new Error('公钥解析失败')
}

/**
 * RSA NO_PADDING 加密：明文补零到 128 字节，直接 `m^e mod n`，输出 256 位大写 hex。
 *
 * 酷狗用的是 1024 位密钥、没有填充，所以必须自己算——`crypto.subtle`
 * 只提供 OAEP / PKCS#1 v1.5，Node 的 `RSA_NO_PADDING` 在这里也不存在。
 */
export function rsaNoPadding(pem: string, text: string): string {
  const { n, e } = publicNumbers(pem)
  const raw = utf8(text)
  if (raw.length > 128) throw new Error('待加密内容超出密钥长度')
  const buf = new Uint8Array(128)
  buf.set(raw)
  const m = bytesToBig(buf)
  // 明文首字节是 `{`（0x7b），远小于 n 的首字节，不会越界；真越界就是接口变了
  if (m >= n) throw new Error('待加密内容超出密钥范围')
  return modPow(m, e, n).toString(16).padStart(256, '0').toUpperCase()
}
