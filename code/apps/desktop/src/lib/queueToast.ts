/**
 * 「加入播放列表」之后的一句反馈。
 *
 * 用户 2026-11-11：「歌单加入播放队列后，没有什么提示，导致我会一直点击」。
 *
 * 队列去重做在 core 的 `enqueue` 里：已经在队尾的歌再点一次「加入播放列表」
 * 是**真的什么都不发生**。以前这里既不报结果也不说原因，用户看到界面毫无变化，
 * 只能以为没点上，继续点——点几次都一样，就成了「这个按钮坏了」。
 *
 * 所以文案必须回答两件事：加进去了几首、剩下几首为什么没动。
 */
import type { LocalTrack } from '@shuyin/core'
import { toast } from './toast'

export function queueToast(
  added: LocalTrack[],
  existing: Array<{ id: string }>,
  position: 'end' | 'next' = 'end',
) {
  if (!added.length) return
  const have = new Set(existing.map(t => t.id))
  const fresh = added.filter(t => !have.has(t.id)).length
  const dup = added.length - fresh

  if (position === 'next') {
    if (!fresh) toast('这首本来就在播放列表里')
    else toast(fresh > 1 ? `已设为下一首播放 · ${fresh} 首` : '已设为下一首播放', { ok: true })
    return
  }

  if (!fresh) {
    toast(added.length > 1 ? `这 ${added.length} 首已经在播放列表里了` : '这首已经在播放列表里了')
    return
  }
  if (dup > 0) {
    toast(`已加入播放列表 · ${fresh} 首（${dup} 首已经在里面）`, { ok: true })
    return
  }
  toast(added.length > 1 ? `已加入播放列表 · ${fresh} 首` : '已加入播放列表', { ok: true })
}
