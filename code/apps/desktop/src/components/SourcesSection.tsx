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
  const [disabled, setDisabled] = useState<string[]>([])
  /** 导入弹窗：'url' 粘贴链接 / 'code' 粘贴代码 */
  const [importMode, setImportMode] = useState<'url' | 'code' | null>(null)
  const [importUrl, setImportUrl] = useState('')
  const [importName, setImportName] = useState('')
  const [importCode, setImportCode] = useState('')
  const [importing, setImporting] = useState(false)

  /* 数据目录 / 禁用列表：从存档或应用目录来（音质已挪到「播放」页，见 QualitySection） */
  useEffect(() => {
    ;(async () => {
      let dd = ''
      try { dd = (await bridge.sourcesDefaultDir()) ?? '' } catch { dd = '' }
      setDataDir(dd)
      const off = await settings.get<string[]>(KEYS.sourcesOff)
      if (off) { setDisabled(off); sourceManager.setDisabled(off) }
    })()
  }, [])

  /** 订阅音源状态 */
  useEffect(() => sourceManager.subscribe(s => {
    setSources(s.sources)
    setLoading(s.loading)
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

  /*
   * 批量开关。
   *
   * 音源出问题时，用户能干的第一件事就是「关掉可疑的那个」。四五个音源逐个点
   * 太笨，加一对「全部停用 / 全部启用」：排查完一键恢复，比记住原来哪几个是开的省事。
   * 只是把 id 列表整体写一遍，`sourceManager.setDisabled` 本来就是这个语义。
   */
  const knownIds = sources.map(s => s.id)
  const offIds = disabled.filter(id => knownIds.includes(id))
  const allOff = knownIds.length > 0 && offIds.length === knownIds.length
  const setAll = useCallback((on: boolean) => {
    const next = on ? [] : sources.map(s => s.id)
    setDisabled(next)
    sourceManager.setDisabled(next)
    void settings.set(KEYS.sourcesOff, next)
  }, [sources])

  /** 概览那三个数：可用 = 装好了且没被停用；故障单列，别混进「可用」里充数 */
  const stat = {
    ready: sources.filter(s => s.status === 'ready' && !offIds.includes(s.id)).length,
    off: offIds.length,
    bad: sources.filter(s => s.status === 'error').length,
    loading: sources.filter(s => s.status === 'loading').length,
  }

  return (
    <section className="set-group" data-pane="source" data-sec="sources">
      <h3>在线音源</h3>

      {/*
       * 概览：先给结论，再给操作。
       *
       * 原来这一页一进来就是「导入音源 + 四个按钮 + 一条路径 + 音质」，全是操作项，
       * 用户读完不知道自己现在到底能不能放歌。三个数字排在最上面，
       * 「有没有音源、坏没坏」一眼就有答案。
       */}
      <div className="src-stat" data-empty={sources.length === 0 ? 'true' : undefined}>
        <div className="src-stat-cells">
          <div className="src-stat-cell" data-kind="ready">
            <b className="num">{stat.ready}</b>
            <span>可用</span>
          </div>
          <div className="src-stat-cell" data-kind="off">
            <b className="num">{stat.off}</b>
            <span>{stat.loading > 0 ? `加载中 ${stat.loading}` : '已停用'}</span>
          </div>
          <div className="src-stat-cell" data-kind="bad" data-active={stat.bad > 0 ? 'true' : undefined}>
            <b className="num">{stat.bad}</b>
            <span>加载失败</span>
          </div>
        </div>
        <p className="src-stat-note">
          {sources.length === 0
            ? '还没导入音源：搜索、歌单、歌词照常可用，点播放时才需要它'
            : stat.ready === 0
              ? '当前没有可用音源，在线歌曲点播放会提示'
              : '音源只负责取播放直链，搜索 / 歌单 / 歌词走平台官方接口'}
        </p>
      </div>

      {/* 这一行右侧只放三个导入入口（手机上一行刚好放得下，见 mobile.css 的 .set-row-stack） */}
      <div className="set-row set-row-stack">
        <span className="set-label">
          音源脚本
          <HelpTip
            width={340}
            text={'音源存在应用数据目录的 sources.json 清单里，只认下面三个导入入口。\n直接往文件夹里放 .js、或改动里面的文件都不会生效——防止脚本被悄悄换掉。\n同名重新导入 = 更新这一条；列表里删除 = 从清单移除。'}
          />
          <span className="set-sub">
            洛雪音乐格式，只负责把「搜到的歌」换成能播的直链。脚本会主动联网，
            请只导入你信任的来源。
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
        </div>
      </div>

      {/*
       * 维护行：重新加载 + 批量开关。
       * 重新加载原本挤在导入按钮里，390 宽下会掉到第二行右对齐，看着像漏了一颗；
       * 它和「全部停用」一样是维护动作，放一行更顺。
       */}
      <div className="set-row">
        <span className="set-label">
          维护
          <span className="set-sub">
            {sources.length > 1
              ? '脚本改动后点重新加载生效；音源出问题时先全关，再逐个打开定位'
              : '改过脚本后点重新加载生效'}
          </span>
        </span>
        <span className="set-ctl src-maint">
          <button className="ghost-btn" disabled={!dataDir || loading} onClick={() => void reloadAll()}>
            <IconRefresh width={13} height={13} /> 重新加载
          </button>
          {sources.length > 1 && (
            <button className="link-btn" onClick={() => setAll(allOff)}>
              {allOff ? '全部启用' : '全部停用'}
            </button>
          )}
        </span>
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

/*
 * 下面两块是从「音源」页拆出来的。
 *
 * 音源页原来把「装脚本」和「放歌用什么码率」「文件存在哪」混在一起，
 * 后半截全是路径和技术细节，看着又乱又满，而真正要操作的「导入」被挤在中间。
 * 现在各归各位：音质属于「播放」，目录属于「存储」，音源页只管脚本本身。
 */

/** 设置 · 播放 · 优先音质 */
export function QualitySection() {
  const [quality, setQuality] = useState('320k')
  const [qualitys, setQualitys] = useState<string[]>(FALLBACK_QUALITY)

  useEffect(() => {
    void getPreferredQuality().then(setQuality).catch(() => {})
    /* 档位由「当前装载的音源声明了什么」决定：没装音源时只留三档通用值，
       装完 flac 音源刷新一下就能选 flac 了 */
    const collect = () => {
      const set = new Set<string>()
      for (const p of ALL_PLATFORMS) for (const q of sourceManager.qualitysFor(p)) set.add(q)
      if (set.size) setQualitys([...set])
    }
    collect()
    return sourceManager.subscribe(collect)
  }, [])

  return (
    <section className="set-group" data-pane="play" data-sec="quality">
      <h3>音质</h3>
      <div className="set-row">
        <span className="set-label">
          优先音质
          <span className="set-sub">
            取不到会自动降档、再不行换平台找同一首歌；实际生效的档位在播放条上写着。
            可选项来自当前装载的音源声明
          </span>
        </span>
        <ChipMenu
          label="音质"
          value={qualitys.includes(quality) ? qualityLabel(quality) : quality}
          activeId={quality}
          alignEnd
          width={220}
          title="优先音质：取不到就自动降档 / 换平台，不用手动切"
          options={qualitys.map(q => ({ id: q, name: qualityLabel(q), note: q }))}
          onPick={q => { setQuality(q); void setPreferredQuality(q) }}
        />
      </div>
    </section>
  )
}

/** 设置 · 存储 · 音源文件目录 */
export function SourcesDirSection() {
  const [dir, setDir] = useState('')
  useEffect(() => {
    void bridge.sourcesDefaultDir().then(d => setDir(d ?? '')).catch(() => {})
  }, [])

  return (
    <section className="set-group" data-pane="storage" data-sec="sources-dir">
      <h3>音源文件</h3>
      <div className="set-row">
        <span className="set-label">
          音源数据目录
          <span className="set-sub">
            导入的脚本以清单形式存在这里。别手动往里丢 .js——只认音源页那三个导入入口，
            直接改文件不会生效（防止脚本被悄悄换掉）
          </span>
        </span>
        <span className="set-ctl">
          <button className="ghost-btn" disabled={!dir} onClick={() => void bridge.revealInFolder(dir)}>
            {bridge.isAndroid ? '复制路径' : '打开'}
          </button>
        </span>
      </div>
      <div className="src-dir" title={dir}>
        <IconFolder width={13} height={13} />
        <span className="src-dir-text">{dir || '—'}</span>
      </div>
    </section>
  )
}
