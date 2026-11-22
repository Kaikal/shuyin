/**
 * 播放历史页 = 最近播放。
 *
 * 结构完全沿用 FavPage（`.sr-list` / `.sr-row` 那套标记直接继承，
 * 手机和平板的行样式、封面尺寸不用再造）。差异只有两点：
 *   · 没有多选——历史的典型动作是「点一首接着放 / 顺着听一遍」，
 *     批量操作没有意义；倒是给个「清空」。
 *   · 记录以**播放时间**倒序，同一首重复播只留最新一条（见 history.ts）。
 */
import { useMemo, useState } from 'react'
import { fmtTime, type LocalTrack } from '@shuyin/core'
import { usePlayer } from '../lib/PlayerProvider'
import { useHistory, historyTracksOf } from '../lib/history'
import { confirm } from '../lib/confirm'
import { toast } from '../lib/toast'
import { queueToast } from '../lib/queueToast'
import { IconNext, IconPlay, IconTrash } from '../components/icons'

interface Props {
  onBack(): void
}

/** 播放时间 → 人话：今天/昨天给钟点，一周内给星期，再早给日期 */
function whenLabel(at: number): string {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  const day = (x: Date) => Math.floor((x.getTime() - x.getTimezoneOffset() * 60000) / 86400000)
  const diff = day(now) - day(d)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diff <= 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  if (diff < 7) return '周' + '日一二三四五六'[d.getDay()] + ` ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function HistoryPage({ onBack }: Props) {
  const p = usePlayer()
  const hist = useHistory()
  const [wiping, setWiping] = useState(false)

  const tracks = useMemo<LocalTrack[]>(() => historyTracksOf(hist.list, p.library), [hist.list, p.library])

  const wipe = async () => {
    const ok = await confirm({
      title: '清空播放历史？',
      message: `将删除 ${tracks.length} 条播放记录，不可恢复`,
      confirmText: '清空',
      danger: true,
    })
    if (!ok) return
    setWiping(true)
    await hist.clear()
    setWiping(false)
    toast('已清空播放历史')
  }

  return (
    <div className="page fav-page">
      <header className="lib-head">
        <div className="lib-head-left">
          <button className="ghost-btn lib-back" onClick={onBack}>← 返回我的</button>
          <h1>播放历史</h1>
          <p className="lib-status">
            <b className="num">{tracks.length}</b> 首 · 最近播放按时间倒序
          </p>
        </div>
        <div className="lib-actions">
          {tracks.length > 0 && (
            <>
              <button
                className="ghost-btn"
                disabled={wiping}
                onClick={() => void wipe()}
              >
                <IconTrash width={13} height={13} /> 清空
              </button>
              <button
                className="primary-btn"
                onClick={() => p.playList(tracks, 0)}
              >
                <IconPlay width={13} height={13} /> 播放全部
              </button>
            </>
          )}
        </div>
      </header>

      {tracks.length === 0 ? (
        <div className="empty-state">
          <div className="title">还没有播放记录</div>
          <div className="sub">放过的歌都会自动收进这里</div>
        </div>
      ) : (
        <div className="sr-list">
          {tracks.map((t, i) => {
            const live = p.current?.id === t.id
            const online = t.id.startsWith('online:')
            const rec = hist.list[i]
            return (
              <div
                key={t.id}
                className={'sr-row' + (live ? ' live' : '')}
                title="点击播放"
                onClick={() => p.playOne(t)}
              >
                <span
                  className="sr-art"
                  aria-hidden="true"
                  style={t.cover ? { backgroundImage: `url(${t.cover})` } : undefined}
                />
                <div className="sr-main">
                  <div className="sr-title">
                    {t.title}
                    {live && <span className="eq-mini" />}
                  </div>
                  <div className="sr-meta">
                    <span>{t.artist || '未知歌手'}</span>
                    {online && <span className="sr-dot">·</span>}
                    {online && <span>在线</span>}
                    <span className="sr-dot">·</span>
                    <span>{whenLabel(rec?.at ?? 0)}</span>
                  </div>
                </div>
                <span className="sr-dur num">{fmtTime(t.duration)}</span>
                <div className="sr-acts">
                  <button
                    className="icon-btn"
                    title="下一首播放"
                    onClick={e => {
                      e.stopPropagation()
                      queueToast([t], p.queueState.queue, 'next')
                      p.addToQueue(t, 'next')
                    }}
                  >
                    <IconNext />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
