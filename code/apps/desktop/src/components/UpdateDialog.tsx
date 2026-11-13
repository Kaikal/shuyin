/**
 * 「发现新版本」弹窗。
 *
 * 用应用内 Modal，不用系统框：这个应用是深色玻璃质感，系统白框一弹就出戏
 * （和删除歌单那次是同一个教训，见 lib/confirm.ts）。
 *
 * 版本号不是「必须更新」就不拦人：主按钮是「立即更新」，次要按钮「以后再说」
 * 会把这一版记进 `update.skip`，同一个版本不再弹，直到下一版出现。
 *
 * 安卓上**在主按钮里直接下载并拉起安装器**（见 lib/update 尾部的说明）：
 * 以前是跳浏览器，手机上要经过「浏览器 → 下载完 → 通知栏 → 未知来源授权」，
 * 四步里任何一步卡住用户就不知道自己在哪。进度条是原生推上来的，
 * 下载完若缺「安装未知应用」权限，会自动跳到那个设置页，回来再点一次即可。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import {
  downloadAndInstall, installDownloaded, onDownloadProgress,
  type UpdateInfo,
} from '../lib/update'
import { bridge } from '../lib/bridge'

type Stage = 'idle' | 'downloading' | 'need_perm' | 'error'

export function UpdateDialog({
  info,
  onSkip,
  onGo,
}: {
  info: UpdateInfo | null
  /** 以后再说 / 关掉 */
  onSkip(): void
  /** 桌面：交给外部打开浏览器（安卓自己处理） */
  onGo(): void
}) {
  const [stage, setStage] = useState<Stage>('idle')
  const [pct, setPct] = useState(-1)
  const [err, setErr] = useState('')
  /** 下载好的 APK 路径：从「未知来源」设置页回来之后要用它续装 */
  const pathRef = useRef('')

  /* 换了一个版本要重新开始，别把上一版的 100% 留着 */
  useEffect(() => {
    setStage('idle')
    setPct(-1)
    setErr('')
    pathRef.current = ''
  }, [info?.latest])

  useEffect(() => {
    if (stage !== 'downloading') return
    return onDownloadProgress(p => setPct(p.pct))
  }, [stage])

  const start = useCallback(async () => {
    if (!info) return
    if (!bridge.isAndroid) { onGo(); return }
    setStage('downloading')
    setPct(-1)
    setErr('')
    try {
      const r = await downloadAndInstall(info)
      pathRef.current = r.path || ''
      setStage(r.status === 'need_perm' ? 'need_perm' : 'idle')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setStage('error')
    }
  }, [info, onGo])

  const retry = useCallback(async () => {
    if (!pathRef.current) { void start(); return }
    setStage('downloading')
    setPct(100)
    try {
      const r = await installDownloaded(pathRef.current)
      setStage(r.status === 'need_perm' ? 'need_perm' : 'idle')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setStage('error')
    }
  }, [start])

  if (!info) return null

  const busy = stage === 'downloading'
  const primary: Record<Stage, string> = {
    idle: '立即更新',
    downloading: pct >= 0 ? `下载中 ${pct}%` : '下载中…',
    need_perm: '我已允许，继续安装',
    error: '重试',
  }

  return (
    <Modal
      open
      title={`发现新版本 v${info.latest}`}
      hint={`当前 v${info.current}${info.date ? ` · 新版发布于 ${info.date}` : ''}`}
      onClose={busy ? () => {} : onSkip}
      width={470}
      footer={<>
        {!info.force && !busy && (
          <button className="ghost-btn" onClick={onSkip}>以后再说</button>
        )}
        <span className="modal-sp" />
        <button
          className="primary-btn"
          disabled={busy}
          onClick={() => { if (stage === 'need_perm' || stage === 'error') void retry(); else void start() }}
        >
          {primary[stage]}
        </button>
      </>}
    >
      {info.notes.length > 0
        ? (
          <ul className="upd-notes">
            {info.notes.map(n => <li key={n}>{n}</li>)}
          </ul>
        )
        : <p className="upd-meta">这一版没有写更新说明。</p>}

      {busy && (
        <div className="upd-prog" data-unknown={pct < 0 ? 'true' : undefined}>
          <i style={pct >= 0 ? { width: `${pct}%` } : undefined} />
        </div>
      )}

      {stage === 'need_perm' && (
        <p className="upd-tip">
          系统要求允许「疏音」安装应用。已经帮你打开设置页，打开开关后回来点下面这颗按钮即可。
        </p>
      )}
      {stage === 'error' && (
        <p className="upd-tip bad">下载没完成：{err || '网络中断'}。可以再试一次，或者去官网下载。</p>
      )}
    </Modal>
  )
}
