/**
 * 右键菜单：自定义浮层（非系统原生菜单），支持边界翻转、键盘上下选择、Esc 关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 视口底部被**常驻栏**占掉的地方。
 *
 * 手机上这一屏的底部是三样东西叠起来的：底部导航（`.sidebar`，64dp）、
 * 浮在它上面的播放条（`.playbar`，60dp）、多选时的工具条（`.lib-batchbar`）。
 * 菜单只拿 `window.innerHeight` 做边界，就会算到「屏幕最下面那条线」，
 * 结果落在播放条下面、被导航栏压住——用户看到的就是「底部歌曲的菜单超出屏幕」。
 *
 * 所以这里把这些常驻层挨个量一遍，取最靠上的那个 top 当作真正的下界。
 * 两条排除条件，避免把侧边栏误当成底栏：
 *   - 宽度不到视口一半的（桌面左侧导航 240px）；
 *   - 完全在视口外的。
 */
const DOCK_SELECTORS = ['.playbar', '.sidebar', '.lib-batchbar']

function bottomLimit(pad: number): number {
  const vh = window.innerHeight
  const vw = window.innerWidth
  let bottom = vh - pad
  for (const sel of DOCK_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
    const r = el.getBoundingClientRect()
    if (r.height < 8 || r.width < vw * 0.55) continue
    if (r.top < 0 || r.top > vh) continue
    bottom = Math.min(bottom, r.top - pad)
  }
  return Math.max(pad + 120, bottom)
}

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  divider?: boolean
  disabled?: boolean
  onSelect(): void
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [active, setActive] = useState(-1)
  /*
   * items / active 走 ref 给下面的全局监听读最新值。
   *
   * 曾经它们直接写在 effect 依赖里，于是父组件每渲染一次（`items` 是 JSX 里
   * 现算的数组，引用每次都新）effect 就重装一遍，连带把 `armedRef` 归零。
   * 触摸屏上更要命：手指按下会有一次 `mouseenter` → `setActive` → 又一次重跑，
   * 结果**每次点击都只是把 armed 打开，永远轮不到第二次**——菜单点外面关不掉。
   * 监听器只装一次、要读的东西走 ref，这样 armed 只在挂载（或换位置重开）时归零。
   */
  const itemsRef = useRef(items)
  itemsRef.current = items
  const activeRef = useRef(active)
  activeRef.current = active
  /** 见过一次「新的按下」没有——没有就说明还在开菜单那次手势里，别急着关 */
  const armedRef = useRef(false)
  /*
   * 退场动画。
   *
   * 菜单是「小浮层」这一档：手指刚抬、眼睛还在原处，动画必须短（110ms），
   * 长了会像卡了一下。做法跟弹窗一样——先标 closing 放动画，120ms 后再真卸载；
   * `closingRef` 挡住重复请求，否则连着两次点击会排两个定时器。
   */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const requestClose = useRef(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    window.setTimeout(() => onCloseRef.current(), 120)
  }).current

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    /*
     * 量尺寸用 offsetWidth/offsetHeight，不用 getBoundingClientRect——
     * 进场动画是 `translateY(-4px) scale(0.98)`，rect 会把这两样算进去
     * （高度少 2%、位置高 4px），菜单就总是往下探一点、最底一条被切掉半边。
     * offset* 是布局尺寸，不含 transform。
     */
    const pad = 10
    const vw = window.innerWidth
    const limit = bottomLimit(pad)

    let w = el.offsetWidth
    let h = el.offsetHeight
    /* 可用高度都装不下（小屏 + 底部栏）→ 限高 + 内部滚动，别硬塞到屏外 */
    const avail = limit - pad
    if (h > avail) {
      el.style.maxHeight = `${avail}px`
      el.style.overflowY = 'auto'
      h = el.offsetHeight
    }

    let nx = x
    let ny = y
    if (nx + w + pad > vw) nx = Math.max(pad, x - w)
    if (nx + w + pad > vw) nx = Math.max(pad, vw - w - pad)
    /* 优先开在下方；下方不够就整个翻到上方；还不行就贴可用区底边 */
    if (ny + h + pad > limit) {
      const above = y - h - pad
      ny = above >= pad ? above : Math.max(pad, limit - h)
    }

    setPos({ x: Math.round(nx), y: Math.round(ny) })
    /*
     * 只有鼠标设备才自动聚焦第一项（键盘上下选要用）。
     * 手指上聚焦没有意义，反而会带出焦点框、还可能把页面滚一下；
     * preventScroll 再兜一层。
     */
    if (!window.matchMedia?.('(pointer: coarse)').matches) {
      el.querySelector<HTMLElement>('.ctx-item')?.focus({ preventScroll: true })
    }
  }, [x, y])

  useEffect(() => {
    /*
     * 点在菜单外面：**只关菜单，不能让下面那一行也收到这一下**。
     *
     * 这里踩过一个很难看的坑：以前在 `pointerdown` 就把菜单关掉，遮罩跟着被卸载，
     * 可手指还没抬起来——浏览器在 `touchend` 之后补发的 `click` 是按**当下**
     * 命中测试算目标的，遮罩没了，这一下就落到下面的歌曲行上，于是「点外面想关菜单」
     * 变成了「顺手播了首歌」。桌面鼠标同理：`mousedown` 关掉、`click` 落到别处。
     *
     * 所以关的时机必须挪到 `click`——它是整串手势的最后一个事件，这时候遮罩仍在，
     * 命中测试一定命中它；再在 window 的捕获阶段 `stopPropagation`，目标元素
     * （歌曲行 / 播放键 / 三点按钮）连事件都收不到。
     *
     * `pointerdown` 只拦不关：让下面那些靠 pointerdown 起手的东西（长按多选、
     * 拖动）也拿不到这一下。
     */
    const outside = (t: EventTarget | null) => !ref.current?.contains(t as Node)
    /*
     * 菜单是**在手指还按着的时候**弹出来的（长按 480ms 触发）。
     * 之后手指一抬，浏览器还会补一个 click，按当下命中测试算目标——
     * 那时光标下面是刚挂上的遮罩，于是这一下「落在外面」，菜单刚出现就自己关了。
     * 用户看到的是「长按没反应」，还以为功能被去掉了。
     *
     * 所以关闭要等**新的一次按下**（armed）：从那之后才允许「点外面关闭」。
     * 开菜单那一次手势的尾巴（pointerup 补发的 click、安卓长按自带的 contextmenu）
     * 全部放行不关。按住三秒再松手也一样——不是靠时间窗兜的。
     */
    armedRef.current = false
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      e.stopPropagation()
      /*
       * 已经是「新的一次按下」了还点在菜单外 → 直接收。
       *
       * 这是给「抬手补发的 click 不一定存在」的设备兜底（华为部分 WebView 在
       * 触摸手势里会吞掉这一次 click）。第一次按下只负责解锁（armed），
       * 第二次按下就是明确的外点，不必再等 click。
       */
      if (armedRef.current) { requestClose(); return }
      armedRef.current = true
    }
    const onClick = (e: MouseEvent) => {
      if (!outside(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      if (!armedRef.current) return
      requestClose()
    }
    const onCtx = (e: MouseEvent) => {
      if (!outside(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      if (!armedRef.current) return
      requestClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); requestClose() }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const list = itemsRef.current
        const idxs = list.map((it, i) => (it.divider || it.disabled ? -1 : i)).filter(i => i >= 0)
        if (!idxs.length) return
        const cur = idxs.indexOf(activeRef.current)
        const nextIdx = e.key === 'ArrowDown'
          ? idxs[(cur + 1) % idxs.length]
          : idxs[(cur - 1 + idxs.length) % idxs.length]
        // 先写 ref 再 setState：连按两次方向键时第二次要拿到刚移过去的那个下标
        activeRef.current = nextIdx
        setActive(nextIdx)
        ref.current?.querySelectorAll<HTMLElement>('.ctx-item')[nextIdx]?.focus()
      }
      if (e.key === 'Enter' && activeRef.current >= 0) {
        const it = itemsRef.current[activeRef.current]
        if (it && !it.disabled) { it.onSelect(); requestClose() }
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('contextmenu', onCtx, true)
    window.addEventListener('keydown', onKey, true)
    /*
     * 失焦就收菜单（切窗口、系统弹窗）。但**刚挂上来的那一瞬不算**：
     * 安卓的长按同时还触发系统自己的「长按菜单 / 文字选择」，WebView 会跟着
     * 失焦一次——以前这一下直接把刚弹出来的菜单关掉，用户看到的就是
     * 「长按了但什么都没出现」（华为那台就是这样）。
     */
    const mountedAt = Date.now()
    const onBlur = () => {
      if (Date.now() - mountedAt < 700) return
      requestClose()
    }
    window.addEventListener('blur', onBlur)
    /*
     * 滚动就让菜单退场。
     *
     * 菜单是 fixed 定位、只算一次位置；列表一滚它就悬在原地，
     * 和刚点的那一行彻底错位，手指再点下去就是另一首。滚一下收掉最省事——
     * 桌面右键菜单被滚动关掉也是同样的习惯。capture 才能听见内部滚动容器的 scroll。
     * 菜单自己在滚动（限高时）要放过，否则刚滑就没了。
     */
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return
      requestClose()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('contextmenu', onCtx, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('scroll', onScroll, true)
    }
    /* 只装一次。依赖写成 [ ] 是关键，见上面 itemsRef 那段注释 */
  }, [])

  /* 换位置重开 = 另一次手势，armed 要归零（同位置重开时组件本来就重新挂载了） */
  useEffect(() => {
    armedRef.current = false
  }, [x, y])

  return (
    <>
      {/* 全屏透明遮罩：吃掉落在菜单外的点击，下面的行/按钮都收不到。
          滚轮直接收菜单——菜单是 fixed 的，列表一滚它就悬在别处了。
          **不带 onPointerDown 关闭**：关闭动作统一交给上面 window 捕获的 click，
          否则遮罩会在手指抬起前被卸载，补发的 click 就穿透到下面那一行。 */}
      <div
        className="ctx-scrim"
        aria-hidden="true"
        onWheel={() => requestClose()}
      />
      <div
        ref={ref}
        className="ctx-menu"
        data-closing={closing ? 'true' : undefined}
        style={{ left: pos.x, top: pos.y }}
        role="menu"
        aria-label="歌曲操作"
      >
        {items.map((it, i) => (
          it.divider
            ? <div key={it.id} className="ctx-divider" role="separator" />
            : (
              <button
                key={it.id}
                className={'ctx-item' + (it.danger ? ' danger' : '')}
                role="menuitem"
                disabled={it.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => { it.onSelect(); requestClose() }}
              >
                <span className="ctx-icon">{it.icon}</span>
                <span className="ctx-label">{it.label}</span>
                {it.shortcut && <span className="ctx-kbd num">{it.shortcut}</span>}
              </button>
            )
        ))}
      </div>
    </>
  )
}
