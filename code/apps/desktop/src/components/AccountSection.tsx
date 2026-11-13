/**
 * 设置页 · 账号与同步。
 *
 * 这一块整体只是「加分项」：不登录时它安静地摆在那里，登录后才出现同步按钮。
 * 登录/同步的实体在 AccountPanel 里（「我的」页那个小窗也用同一份），
 * 这里只负责：标题和快速备份（配置包）。
 *
 * 原来这里还挂着一整套「云开发环境」调试面板（改 envId、改存储桶、复制建桶 SQL、
 * 复制诊断信息）。那是我们自己搭环境时用的东西：环境 ID 对用户没有意义，
 * 填错了还会把同步整个弄坏。用户原话「这个云开发环境是什么，这个不要」
 * （2026-11-13）——整块撤掉，envId 仍在 `lib/cloud` 里用默认值，
 * 真要换环境走配置文件，不上界面。
 */
import { useState } from 'react'
import { HelpTip } from './HelpTip'
import { IconDownload, IconUpload } from './icons'
import { AccountPanel } from './AccountPanel'
import { applyBundle, exportBundleToFile, readBundleFromFile, summarize } from '../lib/backup'
import { toast } from '../lib/toast'
import { confirm } from '../lib/confirm'

export function AccountSection() {
  const [busy, setBusy] = useState('')

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
    <section className="set-group" data-pane="account" data-sec="account">
      <h3>
        账号与同步
        <HelpTip
          width={330}
          text={[
            '未登录也可正常使用，数据保存在本机。',
            '登录后可同步至云端，换设备登录同一邮箱即可继续使用。',
            '',
            '也可用「导出配置包」备份成文件，在另一台设备导入。',
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
    </section>
  )
}
