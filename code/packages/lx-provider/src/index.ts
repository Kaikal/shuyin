/**
 * 疏音 · 洛雪音源接入（lx-provider）
 *
 * 两层，别混：
 *   - 平台 API 层：`createPlatformApis(client)` → 搜索 / 歌单 / 歌词 / 封面
 *   - 音源脚本层：`new SourceManager({ host })` → musicUrl 降级链
 */
export * from './types'
export * from './http'
export * from './platforms'
export * from './sourceManager'
/*
 * MD5 也导出来：平台层的签名在里面用，但「酷狗手机号登录」在 App 侧
 * （`lib/kgLogin.ts`），同样要算 md5 盐值，没必要再抄一套实现。
 */
export { md5Hex } from './md5'
