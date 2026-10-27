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
