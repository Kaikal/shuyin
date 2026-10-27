/**
 * 设置页 · 音源区块。
 *
 * **导入式**，不是「指一个目录」。
 * 洛雪的音源脚本本来就是「一段 JS 文本」，用户的实际动作是「我拿到了一个脚本」——
 * 可能是一个 .js 文件、一个 GitHub raw 链接、或者直接从聊天窗口复制的一段代码。
 * 让他自己去资源管理器里找目录、把文件丢进去，等于把「实现细节」当成操作步骤。
 *
 * 所以这里三个入口，全都落到同一个地方（`%APPDATA%\cn.shuyin.player\sources`）：
 *   1. 选文件（可多选）
 *   2. 粘贴链接（raw / gist 直链）
 *   3. 粘贴代码
 *
 * v0.4.5 起音源改成**清单式存储**（`sources.json`，code 内嵌）：
 * 只认清单，不扫目录——用户往文件夹里丢 .js、改里面的 .js 一律不生效，
 * 想加 / 改 / 删音源只能走上面三个入口和列表里的删除。从根上杜绝手改数据
 * （脚本是能主动外联的代码，被悄悄换掉比界面错乱严重得多）。
 *
 * 权限：脚本会主动外联（取链、统计、版本检查），所以**绝不内置、绝不自动下载**。
 * 用户导入的东西，用户自己负责；界面上把「它会连哪些域名」摊开给他看。
 */
import { useCallback, useEffect, useState } from 'react'
import { ALL_PLATFORMS, type LoadedSource } from '@shuyin/lx-provider'
import { bridge } from '../lib/bridge'
import { getPreferredQuality, qualityLabel, setPreferredQuality, sourceManager } from '../lib/online'
import { KEYS, settings } from '../lib/settings'
import { IconFolder, IconImport, IconRefresh, IconTrash } from './icons'
import { Modal } from './Modal'
import { ChipMenu } from './ChipMenu'
import { HelpTip } from './HelpTip'
import { confirm } from '../lib/confirm'

const FALLBACK_QUALITY = ['128k', '320k', 'flac']

export function SourcesSection() {
  /** 应用数据目录（音源清单就在它的 sources 子目录里，固定，不让用户改） */
  const [dataDir, setDataDir] = useState('')
  const [sources, setSources] = useState<LoadedSource[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null)
  const [quality, setQuality] = useState('320k')
  const [qualitys, setQualitys] = useState<string[]>(FALLBACK_QUALITY)
  const [disabled, setDisabled] = useState<string[]>([])
  /** 导入弹窗：'url' 粘贴链接 / 'code' 粘贴代码 */
  const [importMode, setImportMode] = useState<'url' | 'code' | null>(null)
  const [importUrl, setImportUrl] = useState('')
  const [importName, setImportName] = useState('')
  const [importCode, setImportCode] = useState('')
  const [importing, setImporting] = useState(false)

  /* 数据目录 / 禁用列表 / 音质：都从存档或应用目录来 */
  useEffect(() => {
    ;(async () => {
      let dd = ''
      try { dd = (await bridge.sourcesDefaultDir()) ?? '' } catch { dd = '' }
      setDataDir(dd)
      const off = await settings.get<string[]>(KEYS.sourcesOff)
      if (off) { setDisabled(off); sourceManager.setDisabled(off) }
      setQuality(await getPreferredQuality())
    })()
  }, [])

  /** 订阅音源状态 */
  useEffect(() => sourceManager.subscribe(s => {
    setSources(s.sources)
    setLoading(s.loading)
    const set = new Set<string>()
    for (const p of ALL_PLATFORMS) for (const q of sourceManager.qualitysFor(p)) set.add(q)
    if (set.size) setQualitys([...set])
  }), [])

  const reloadAll = useCallback(async (target?: string) => {
    if (!dataDir) return
    try {
      if (target) {
        setBusy(target)
        const s = await sourceManager.reload(target)
        setMsg(s?.status === 'ready'
          ? { text: `「${s.name}」已重新加载` }
          : { text: `加载失败：${s?.error ?? '未知原因'}`, bad: true })
      } else {
        await sourceManager.loadAll([dataDir])
        const errs = sourceManager.list().filter(s => s.status === 'error')
        setMsg(errs.length
          ? { text: `有 ${errs.length} 个音源加载失败（见下方状态）`, bad: true }
          : { text: `已加载 ${sourceManager.list().length} 个音源` })
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true })
    } finally {
      setBusy(null)
    }
  }, [dataDir])

  /** 导入完之后统一收尾：重新装载 + 给一句结果 */
  const afterImport = useCallback(async (names: string[] | string, label: string) => {
    if (dataDir) await sourceManager.loadAll([dataDir])
    const n = Array.isArray(names) ? names.length : 1
    const errs = sourceManager.list().filter(s => s.status === 'error')
    setMsg({
      text: n ? `${label}已导入 ${n} 个音源${errs.length ? `，其中 ${errs.length} 个加载失败` : ''}` : '没有导入任何文件',
      bad: errs.length > 0,
    })
  }, [dataDir])

  const importFiles = useCallback(async () => {
    setMsg(null)
    try {
      const names = await bridge.importSourceFiles()
      if (!names.length) return
      await afterImport(names, '')
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true })
    }
  }, [afterImport])

  const doImport = useCallback(async () => {
    if (importing) return
    setImporting(true)
    try {
      if (importMode === 'url') {
        const p = await bridge.importSourceUrl(importUrl.trim(), importName.trim() || undefined)
        setImportMode(null); setImportUrl(''); setImportName('')
        await afterImport(p.split(/[\\/#]/).pop() ?? '音源', '')
      } else if (importMode === 'code') {
        const p = await bridge.importSourceText(importName.trim() || '导入的音源', importCode)
        setImportMode(null); setImportCode(''); setImportName('')
        await afterImport(p.split(/[\\/#]/).pop() ?? '音源', '')
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true })
    } finally {
      setImporting(false)
    }
  }, [importMode, importUrl, importName, importCode, importing, afterImport])

  const remove = useCallback(async (s: LoadedSource) => {
    const ok = await confirm({
      title: `删除音源「${s.name}」？`,
      message: '它会从音源清单里移除，之后要用得重新导入。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await bridge.deleteSourceScript(s.filePath)
      await sourceManager.loadAll([dataDir])
      setMsg({ text: `已删除「${s.name}」` })
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true })
    }
  }, [dataDir])

  const toggle = useCallback((id: string) => {
    setDisabled(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      sourceManager.setDisabled(next)
      void settings.set(KEYS.sourcesOff, next)
      return next
    })
  }, [])

  const changeQuality = useCallback((q: string) => {
    setQuality(q)
    void setPreferredQuality(q)
  }, [])

  return (
    <section className="set-group">
      <h3>在线音源</h3>

      {/* 这一行右侧是四个按钮，手机上必须换行排（见 mobile.css 的 .set-row-stack） */}
      <div className="set-row set-row-stack">
        <span className="set-label">
          导入音源
          <span className="set-sub">
            洛雪音乐格式的音源脚本。它只负责一件事：把「搜到的歌」换成能播的直链。
            搜索、歌单、歌词都走各平台官方接口，<b>不导入音源也能用</b>；没有音源时，在线歌曲搜得到、点播放会提示。
            脚本会主动联网，请只导入你信任的来源。
          </span>
        </span>
        <div className="src-dir-actions">
          <button className="primary-btn" onClick={() => void importFiles()}>
            <IconImport width={13} height={13} /> 选择脚本文件
          </button>
          <button className="ghost-btn" onClick={() => { setImportName(''); setImportUrl(''); setImportMode('url') }}>
            从链接导入
          </button>
          <button className="ghost-btn" onClick={() => { setImportName(''); setImportCode(''); setImportMode('code') }}>
            粘贴代码
          </button>
          <button className="ghost-btn" disabled={!dataDir || loading} onClick={() => void reloadAll()}>
            <IconRefresh width={13} height={13} /> 重新加载
          </button>
        </div>
      </div>

      <div className="src-dir" title={dataDir}>
        <IconFolder width={13} height={13} />
        <span className="src-dir-text">音源数据：{dataDir || '—'}</span>
        <HelpTip
          width={330}
          text={'音源存在这个目录的 sources.json 清单里，只认上面三个导入入口。\n直接往文件夹里放 .js、或改动里面的文件都不会生效——防止脚本被悄悄换掉。\n同名重新导入 = 更新这一条；列表里删除 = 从清单移除。'}
        />
        <button className="link-btn" disabled={!dataDir} onClick={() => void bridge.revealInFolder(dataDir)}>打开</button>
      </div>

      <div className="set-row">
        <span className="set-label">
          优先音质
          <span className="set-sub">
            取不到会自动降档、再不行换平台找同一首歌；实际生效的档位在播放条上写着
          </span>
        </span>
        <ChipMenu
          label="音质"
          value={qualitys.includes(quality) ? `${qualityLabel(quality)}` : quality}
          activeId={quality}
          alignEnd
          width={220}
          title="优先音质：取不到就自动降档 / 换平台，不用手动切"
          options={qualitys.map(q => ({ id: q, name: qualityLabel(q), note: q }))}
          onPick={changeQuality}
        />
      </div>

      {msg && <div className={'src-msg' + (msg.bad ? ' bad' : '')}>{msg.text}</div>}

      {!sources.length && !loading && (
        <div className="src-empty">
          还没有导入任何音源。搜索、歌单、歌词照常可用；点播放时会提示需要音源。
        </div>
      )}

      <div className="src-list">
        {sources.map(s => {
          const off = disabled.includes(s.id)
          return (
            <div key={s.id} className={'src-item' + (s.status === 'error' ? ' bad' : '') + (off ? ' off' : '')}>
              <div className="src-main">
                <div className="src-name">
                  {s.name}
                  {s.version && <span className="src-ver">v{s.version}</span>}
                  <span className={'src-state ' + s.status}>
                    {s.status === 'ready' ? '可用' : s.status === 'loading' ? '加载中' : '故障'}
                  </span>
                </div>
                <div className="src-sub">
                  {s.status === 'error'
                    ? s.error
                    : s.supports.length
                      ? s.supports.map(x => x.source).join(' · ')
                      : '未声明支持的平台'}
                </div>
                {s.outbound.length > 0 && (
                  <div className="src-out" title={s.outbound.join('\n')}>
                    会外联：{s.outbound.slice(0, 4).join('、')}{s.outbound.length > 4 ? ' 等' : ''}
                  </div>
                )}
              </div>
              <div className="src-acts">
                <button className="ghost-btn" disabled={busy === s.id} onClick={() => void reloadAll(s.id)}>
                  {busy === s.id ? '重试中…' : '重试'}
                </button>
                <button className="ghost-btn" onClick={() => toggle(s.id)}>
                  {off ? '启用' : '停用'}
                </button>
                <button className="icon-btn src-del" aria-label={`删除 ${s.name}`} title="删除这个音源"
                  onClick={() => void remove(s)}>
                  <IconTrash width={13} height={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* ---- 导入弹窗 ---- */}
      <Modal
        open={importMode !== null}
        title={importMode === 'url' ? '从链接导入音源' : '粘贴音源代码'}
        hint={importMode === 'url'
          ? '填 GitHub raw / Gist / 任意能直接返回脚本文本的地址'
          : '把洛雪音源脚本（js）的全部内容粘进来'}
        onClose={() => setImportMode(null)}
        footer={
          <>
            <button className="ghost-btn" onClick={() => setImportMode(null)}>取消</button>
            <button
              className="primary-btn"
              disabled={importing
                || (importMode === 'url' ? !importUrl.trim() : !importCode.trim())}
              onClick={() => void doImport()}
            >
              {importing ? '导入中…' : '导入'}
            </button>
          </>
        }
      >
        <div className="src-import">
          <label className="src-field">
            <span>音源名称（可留空，默认用文件名）</span>
            <input
              className="text-input" value={importName} spellCheck={false}
              placeholder="例如：某音源"
              onChange={e => setImportName(e.target.value)}
            />
          </label>
          {importMode === 'url' ? (
            <label className="src-field">
              <span>脚本地址</span>
              <input
                className="text-input" value={importUrl} spellCheck={false}
                placeholder="https://raw.githubusercontent.com/.../source.js"
                onChange={e => setImportUrl(e.target.value)}
              />
            </label>
          ) : (
            <label className="src-field">
              <span>脚本文本</span>
              <textarea
                className="text-input src-code" value={importCode} spellCheck={false}
                placeholder={'/* lx-music source */\nconst { EVENT_NAMES, request, on, send } = globalThis.lx\n…'}
                onChange={e => setImportCode(e.target.value)}
              />
            </label>
          )}
        </div>
      </Modal>
    </section>
  )
}
