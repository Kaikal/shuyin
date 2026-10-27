/**
 * 平台注册表。新增平台只要在这里挂一个工厂，搜索页会自动出现对应胶囊。
 */
import type { HttpClient, PlatformApi, PlatformSource } from '../types'
import { createKgApi } from './kg'
import { createKwApi } from './kw'
import { createTxApi } from './tx'
import { createWyApi } from './wy'

type Factory = (client: HttpClient) => PlatformApi

const FACTORIES: Partial<Record<PlatformSource, Factory>> = {
  wy: createWyApi,
  tx: createTxApi,
  kw: createKwApi,
  kg: createKgApi,
}

export function createPlatformApis(
  client: HttpClient,
  sources: PlatformSource[] = ['wy', 'tx', 'kw', 'kg'],
): PlatformApi[] {
  const out: PlatformApi[] = []
  for (const s of sources) {
    const f = FACTORIES[s]
    if (f) out.push(f(client))
  }
  return out
}

export function createPlatformApi(client: HttpClient, source: PlatformSource): PlatformApi | null {
  const f = FACTORIES[source]
  return f ? f(client) : null
}

export { createWyApi, createTxApi, createKwApi, createKgApi }
