/**
 * 设置页 · 账号与同步。
 *
 * 这一块整体只是「加分项」：不登录时它安静地摆在那里，登录后才出现同步按钮。
 * 登录/同步的实体在 AccountPanel 里（「我的」页那个小窗也用同一份），
 * 这里只负责：标题、快速备份（配置包）、云开发环境设置。
 */
import { useEffect, useState } from 'react'
import { HelpTip } from './HelpTip'
import { IconDownload, IconUpload } from './icons'
import { AccountPanel } from './AccountPanel'
import {
  DEFAULT_ENV, SYNC_PREFIX, appHost, getEnvId, lastCloudError, setEnvId,
} from '../lib/cloud'
import { applyBundle, exportBundleToFile, readBundleFromFile, summarize } from '../lib/backup'
import { cloudFetchActive } from '../lib/cloudFetch'
import { toast } from '../lib/toast'
import { confirm } from '../lib/confirm'

export function AccountSection() {
  const [env, setEnv] = useState(DEFAULT_ENV)
  const [envDraft, setEnvDraft] = useState('')
  const [envOpen, setEnvOpen] = useState(false)
  const [busy, setBusy] = useState('')
  /** 最近一次失败原文——只在这里出现，不打扰正常流程 */
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      const e = await getEnvId()
      setEnv(e)
      setEnvDraft(e)
    })()
  }, [])

  // 面板开着的时候顺手把错误原文跟着刷（它只在报错后才有值，空着不打扰）
  useEffect(() => {
    if (!envOpen) return
    setErr(lastCloudError())
    const id = window.setInterval(() => setErr(lastCloudError()), 800)
    return () => window.clearInterval(id)
  }, [envOpen])

  const saveEnv = async () => {
    const v = envDraft.trim()
    if (!v) return
    await setEnvId(v)
    setEnv(v)
    setEnvOpen(false)
    toast('环境已切换，重新登录后生效')
  }

  const doExport = async () => {
    if (busy) return
    setBusy('export')
    try {
      const path = await exportBundleToFile()
      if (path) toast('配置包已导出', { ok: true })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { bad: true })
    } finally {
      setBusy('')
    }
  }

  const doImport = async () => {
    if (busy) return
    setBusy('import')
    try {
      const bundle = await readBundleFromFile()
      if (!bundle) return
      const s = summarize(bundle)
      const ok = await confirm({
        title: '导入这份配置包？',
        message: `导出于：${s.at}\n歌单 ${s.playlists} 个 · 收藏 ${s.favorites} 个 · 自定义主题 ${s.themes} 个 · 音源 ${s.sources} 个\n\n歌单会合并到本机，其它设置以配置包为准。`,
        confirmText: '导入',
      })
      if (!ok) return
      const r = await applyBundle(bundle, true)
      toast(`已导入：设置 ${r.settings} 项、歌单 ${r.playlists} 个、音源 ${r.sources} 个`, { ok: true })
      window.setTimeout(() => window.location.reload(), 1000)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { bad: true })
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="set-group">
      <h3>
        账号与同步
        <HelpTip
          width={330}
          text={[
            '不登录也能用：歌单、音源、主题、设置全都存在本机。',
            '登录后可以同步到云端，换电脑登录同一个邮箱就能接着用。',
            '',
            '用邮箱验证码登录。云开发控制台 → 身份认证 → 登录方式 → 邮箱验证码 →',
            '开启邮件代发，配一次就不用再动。',
            '',
            '不想登录也行：下面的「导出配置包」是一个 JSON 文件，',
            '拷到另一台机器导入即可（歌单、音源、主题、快捷键都在里面）。',
          ].join('\n')}
        />
      </h3>

      <AccountPanel />

      <div className="set-row">
        <span className="set-label">快速备份</span>
        <span className="set-ctl">
          <button className="ghost-btn" disabled={!!busy} onClick={() => void doExport()}>
            <IconDownload width={13} height={13} /> {busy === 'export' ? '导出中…' : '导出配置包'}
          </button>
          <button className="ghost-btn" disabled={!!busy} onClick={() => void doImport()}>
            <IconUpload width={13} height={13} /> {busy === 'import' ? '导入中…' : '导入配置包'}
          </button>
        </span>
      </div>

      <div className="cloud-env">
        <button className="link-btn" onClick={() => setEnvOpen(o => !o)}>
          {envOpen ? '收起环境设置' : `云开发环境：${env.slice(0, 12)}${env.length > 12 ? '…' : ''}（点这里改）`}
        </button>
        {envOpen && (
          <div className="cloud-env-panel">
            <input
              className="text-input" value={envDraft}
              onChange={e => setEnvDraft(e.target.value)}
              placeholder="envId，例如 xxx-1a2b3c4d"
            />
            <button className="ghost-btn" disabled={!envDraft.trim() || envDraft.trim() === env} onClick={() => void saveEnv()}>
              保存环境
            </button>

            <p className="cloud-env-hint">
              环境 ID 在控制台左上角（环境名旁边 / 「环境总览」里复制），形如 <code>xxx-1a2b3c4d</code>。
              自己新建了环境就换成那一串——<b>数据库名不是环境 ID</b>，登录认的是环境。
            </p>
            <p className="cloud-env-hint">
              同步存的是<b>云存储</b>（<code>{SYNC_PREFIX}/账号.json</code>），不用建集合、不用配数据库——
              控制台里把「存储」开通一次就行（默认就开着）。
            </p>
            <p className="cloud-env-hint">
              桌面版的请求由本机直接发出，<b>不需要在控制台配「安全来源」</b>——
              那儿加不加、免费套餐让不让加，都不影响登录。
            </p>
            {err && (
              <p className="cloud-env-hint bad">最近一次失败：{err}</p>
            )}
            <div className="cloud-env-line">
              <button
                className="link-btn"
                onClick={() => {
                  const txt = [
                    `环境 ID：${env}`,
                    `页面来源：${appHost()}`,
                    `请求通道：${cloudFetchActive() ? '桌面端直连（不经浏览器）' : '浏览器 fetch'}`,
                    `最近错误：${err || '（还没失败过）'}`,
                  ].join('\n')
                  void navigator.clipboard?.writeText(txt)
                  toast('已复制，直接把这段发给我')
                }}
              >
                复制诊断信息
              </button>
              <span>登录失败后复制这段，比截图清楚</span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
