/**
 * 下载页面：所有下载任务的进度、结果与历史都在这儿。
 *
 * 以前下载只有一个「转圈图标」：进度看不见、切歌就糊了、关掉播放页连痕迹都没有。
 * 这里把「正在下 / 已完成 / 失败」摊开，并且提供重试、定位、清空。
 *
 * 数据全部来自 `DownloadsProvider`（全局单例），所以：
 *   · 从播放页点了下载 → 切页过来就能看到它在跑；
 *   · 关掉应用再开，已完成的记录还在（未完成的标成「已中断」，可以重试）。
 */
import { useMemo } from 'react'
import { coverUrlOf } from '../lib/coverUrl'
import { dlLabel, useDownloads, type DownloadTask } from '../lib/DownloadsProvider'
import { bridge } from '../lib/bridge'
import { IconDownload, IconFolder, IconRefresh, IconTrash } from '../components/icons'

const mb = (n: number) => (n / 1048576).toFixed(1)

function pctOf(t: DownloadTask): number {
  if (t.status === 'done') return 100
  if (t.total <= 0) return 0
  return Math.min(100, (t.done / t.total) * 100)
}

export function DownloadsPage() {
  const dl = useDownloads()

  const { live, finished } = useMemo(() => {
    const live: DownloadTask[] = []
    const finished: DownloadTask[] = []
    for (const t of dl.tasks) {
      if (t.status === 'queued' || t.status === 'resolving' || t.status === 'downloading') live.push(t)
      else finished.push(t)
    }
    return { live, finished }
  }, [dl.tasks])

  const row = (t: DownloadTask) => {
    const pct = pctOf(t)
    const bad = t.status === 'error'
    return (
      <div key={t.id} className={'dlp-row' + (bad ? ' bad' : '')} data-status={t.status}>
        <div className="dlp-cover">
          {t.cover
            ? <img src={coverUrlOf(t.cover) ?? ''} alt="" />
            : <span className="dlp-cover-ph">{t.kind === 'lyric' ? 'LRC' : '♪'}</span>}
        </div>
        <div className="dlp-main">
          <div className="dlp-title" title={t.title}>{t.title}</div>
          <div className="dlp-sub">
            {t.artist || '未知歌手'}
            {t.qualityLabel && <span className="dlp-tag">{t.qualityLabel}</span>}
            {t.kind === 'lyric' && <span className="dlp-tag">歌词</span>}
          </div>
          {t.status !== 'done' && (
            <div className="dlp-bar" data-bad={bad ? 'true' : 'false'}>
              <i style={{ width: bad ? '100%' : `${pct}%` }} />
            </div>
          )}
        </div>
        <div className="dlp-state">
          {/* 成功态是一句话（「已下载 10.3 MB · 高品质 · 酷狗」），不该折行——以前窄窗下
              会把「酷狗」拆成上下两个字。失败态才需要两行说明原因，所以用显式 class 区分
              （老 WebView2 不支持 :has，也不用 :not）。完整文本照旧挂在 title 上。 */}
          <span className={'dlp-label' + (bad ? ' bad' : ' ok')} title={dlLabel(t)}>{dlLabel(t, true)}</span>
          {t.status === 'downloading' && t.total > 0 && (
            <span className="dlp-num">{mb(t.done)} / {mb(t.total)} MB</span>
          )}
          {t.status === 'done' && t.kind === 'audio' && (
            <span className="dlp-num">{mb(t.done)} MB</span>
          )}
        </div>
        <div className="dlp-act">
          {t.status === 'done' && t.path && (
            <button className="icon-btn dlp-act-btn" title="在文件夹中显示" aria-label="在文件夹中显示"
              onClick={() => void bridge.revealInFolder(t.path)}>
              <IconFolder width={14} height={14} />
            </button>
          )}
          {bad && (
            <button className="icon-btn dlp-act-btn" title="重试" aria-label="重试"
              onClick={() => dl.retry(t.id)}>
              <IconRefresh width={14} height={14} />
            </button>
          )}
          <button className="icon-btn dlp-act-btn" title="从列表移除（不会删文件）" aria-label="从列表移除"
            onClick={() => dl.remove(t.id)}>
            <IconTrash width={14} height={14} />
          </button>
        </div>
      </div>
    )
  }

  const empty = !dl.tasks.length

  return (
    <div className="page downloads-page">
      <header className="lib-head">
        <div className="lib-head-left">
          <h1>下载</h1>
          <span className="sub">
            {live.length > 0 ? `${live.length} 个进行中` : '没有进行中的任务'}
            {finished.length > 0 && ` · ${finished.length} 个已完成`}
          </span>
        </div>
        <div className="lib-actions">
          <button className="ghost-btn" onClick={() => void bridge.revealInFolder(dl.dir || '')} disabled={!dl.dir}>
            <IconFolder width={14} height={14} /> 打开下载目录
          </button>
          <button className="ghost-btn" onClick={dl.clearFinished} disabled={!finished.length}>
            清除已完成
          </button>
        </div>
      </header>

      <div className="dlp-dir">
        <span className="dlp-dir-label">保存到</span>
        <span className="dlp-dir-path" title={dl.dir}>{dl.dir || '（还没取到）'}</span>
        <span className="dlp-dir-hint">想换位置去「设置 → 下载目录」</span>
      </div>

      {empty ? (
        <div className="dlp-empty">
          <IconDownload width={30} height={30} />
          <p>还没有下载任务</p>
          <span>在播放页点「下载」选一个音质，任务就会出现在这里。下载过程中可以随便切歌、切页面。</span>
        </div>
      ) : (
        <div className="dlp-list">
          {live.length > 0 && (
            <>
              <div className="dlp-group">进行中</div>
              {live.map(row)}
            </>
          )}
          {finished.length > 0 && (
            <>
              <div className="dlp-group">已完成 / 失败</div>
              {finished.map(row)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
