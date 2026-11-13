/**
 * 歌曲详情面板：右侧抽屉（实体卡片，不占玻璃预算）。
 * 展示封面、标签、文件技术信息与常用操作。
 *
 * 不再放歌词预览：抽屉高度有限，歌词在播放页/歌词列表里看更舒服；
 * 这里的价值是「这首歌的档案」——本地文件给编码参数，在线曲目给来源与音质。
 */
import { fmtTime, type LocalTrack } from '@shuyin/core'
import { Cover } from './Cover'
import { bridge } from '../lib/bridge'
import { usePlayer } from '../lib/PlayerProvider'
import { qualityLabel } from '../lib/online'
import { IconClose, IconFolder, IconNext, IconPause, IconPlay } from './icons'

interface Props {
  track: LocalTrack | null
  onClose(): void
  onPlay(track: LocalTrack): void
  onQueueNext(track: LocalTrack): void
  currentTime: number
  onSeek(t: number): void
}

function fmtBytes(n: number): string {
  if (!n) return '—'
  const mb = n / 1024 / 1024
  return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
}

/** 在线曲目 id 形如 `online:wy:123` */
const PLATFORM_LABEL: Record<string, string> = {
  wy: '网易云',
  tx: 'QQ 音乐',
  kw: '酷我',
  kg: '酷狗',
}

export function TrackDetail({ track, onClose, onPlay, onQueueNext }: Props) {
  const p = usePlayer()
  const online = track?.id.startsWith('online:') ?? false
  const platform = online ? (track!.id.split(':')[1] ?? '') : ''
  const isCurrent = !!track && p.current?.id === track.id

  return (
    <aside className={'detail-panel' + (track ? ' open' : '')} aria-hidden={!track} aria-label="歌曲详情">
      {track && (
        <>
          <div className="detail-head">
            <span className="detail-title">歌曲详情</span>
            <button className="icon-btn" aria-label="关闭详情" onClick={onClose}><IconClose /></button>
          </div>
          <div className="detail-body">
            <div className="detail-cover">
              <Cover track={track} size={296} radius={18} />
            </div>
            <h2 className="detail-name">{track.title}</h2>
            <p className="detail-sub">{track.artist} · {track.album}</p>
            <div className="detail-tags">
              {online ? (
                <>
                  <span className="pill accent">{PLATFORM_LABEL[platform] ?? '在线'}</span>
                  {isCurrent && p.online && p.onlineQuality && (
                    <span className="pill accent">音质 {qualityLabel(p.onlineQuality)}</span>
                  )}
                  {isCurrent && p.onlineSource && <span className="pill">音源 {p.onlineSource}</span>}
                  {isCurrent && p.online && p.onlineQualities.length > 0 && (
                    <span className="pill" title="当前音源支持的档位">
                      可选 {p.onlineQualities.map(q => qualityLabel(q)).join(' / ')}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="pill">{track.format}</span>
                  {track.year ? <span className="pill">{track.year}</span> : null}
                  {track.trackNo ? <span className="pill">TRACK {track.trackNo}</span> : null}
                  {track.genre ? <span className="pill">{track.genre}</span> : null}
                </>
              )}
            </div>

            <div className="detail-actions">
              {/*
                * 正在播的这一首，按钮要跟着变：
                *   · 「播放」→「暂停 / 继续播放」（点它当然还是这首歌，没必要重头再来一遍）
                *   · 「下一首播放」→ 一颗禁用的状态键「正在播放」
                *
                * 以前两个按钮是写死的：详情里明明写着这首正在放，下面还给一颗
                * 「下一首播放」——用户的原话是「明明已经在播放当前歌曲了，
                * 怎么还会有下一曲播放呢」。语义上讲不通，就把状态说出来。
                */}
              {isCurrent ? (
                <button className="primary-btn" onClick={p.togglePlay}>
                  {p.snapshot.playing
                    ? <><IconPause width={14} height={14} /> 暂停</>
                    : <><IconPlay width={14} height={14} /> 继续播放</>}
                </button>
              ) : (
                <button className="primary-btn" onClick={() => onPlay(track)}>
                  <IconPlay width={14} height={14} /> 播放
                </button>
              )}
              <button
                className={'ghost-btn' + (isCurrent ? ' is-current' : '')}
                onClick={() => onQueueNext(track)}
                disabled={isCurrent}
                title={isCurrent ? '这首正在播，不需要排到下一首' : '插到当前曲后面播放'}
              >
                <IconNext width={13} height={13} /> {isCurrent ? '正在播放' : '下一首播放'}
              </button>
              {!online && (
                <button className="ghost-btn" onClick={() => void bridge.revealInFolder(track.path)}>
                  <IconFolder width={14} height={14} /> {bridge.isAndroid ? '复制路径' : '在文件夹中显示'}
                </button>
              )}
            </div>

            <dl className="detail-meta">
              <div><dt>时长</dt><dd className="num">{fmtTime(track.duration)}</dd></div>
              {online ? (
                <>
                  <div><dt>类型</dt><dd>在线曲目</dd></div>
                  <div><dt>平台</dt><dd>{PLATFORM_LABEL[platform] ?? (platform || '—')}</dd></div>
                  <div><dt>音质</dt><dd className="num">{isCurrent && p.onlineQuality ? qualityLabel(p.onlineQuality) : '播放后可见'}</dd></div>
                </>
              ) : (
                <>
                  <div><dt>码率</dt><dd className="num">{track.bitrate ? track.bitrate + ' kbps' : '—'}</dd></div>
                  <div><dt>采样率</dt><dd className="num">{track.sampleRate ? (track.sampleRate / 1000).toFixed(1) + ' kHz' : '—'}</dd></div>
                  <div><dt>文件大小</dt><dd className="num">{fmtBytes(track.size)}</dd></div>
                  <div className="wide"><dt>文件路径</dt><dd className="path" title={track.path}>{track.path}</dd></div>
                </>
              )}
            </dl>
          </div>
        </>
      )}
    </aside>
  )
}
