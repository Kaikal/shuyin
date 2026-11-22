/**
 * 虚拟滚动列表：渲染可视区 + 上下缓冲；行高固定。
 * 1000+ 行不卡顿（transform 定位，不触发布局重排）。
 *
 * 两种滚动模式：
 *   * 默认：自己当滚动容器（独立的 flex 子项，flex:1）；
 *   * `scrollParent`：跟着**外层**滚动容器走（「我的」页要一页滚到底，
 *     列表不能自己再套一层滚动条）。此时列表把自己的高度撑到总行高，
 *     可视区间按外层 scrollTop 与自己的偏移算。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Props<T> {
  items: T[]
  rowHeight: number
  overscan?: number
  className?: string
  /** 行渲染器；playing 行高亮由调用方通过 rowProps 判断 */
  renderRow(item: T, index: number): React.ReactNode
  /** 行 key */
  getKey(item: T, index: number): string
  /** 空态 */
  empty?: React.ReactNode
  /** 外层滚动容器（给了就进入「跟随页面滚动」模式） */
  scrollParent?: React.RefObject<HTMLElement | null>
}

export function VList<T>({
  items, rowHeight, overscan = 8, className, renderRow, getKey, empty, scrollParent,
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  /**
   * 真实行高。
   *
   * `rowHeight` 只是**估值**：桌面 `.track-row` 是 `height: 60px`，但手机上
   * 那张同一行被 CSS 改成了两行网格 + `min-height: 66px`，宽屏手机（`data-wide`）
   * 封面 52 + padding 20 → 72。JS 里写死 60 的话，每行被摆在 `index × 60` 上、
   * 而它自己有 66 高，**每行都压住下一行 6px**，总高度也不够（滚到底少一截）。
   * 视觉上就是滑动时一片错位和闪白（用户 2026-11-15 报的第二条）。
   *
   * 所以这里不猜：渲染完实测第一行的 `offsetHeight`，跟估值差超过 0.5px 就纠正。
   * 放在 `useLayoutEffect` 里，setState 会在浏览器绘制之前生效，用户看不到跳变。
   */
  const [rowH, setRowH] = useState(rowHeight)
  const measureRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 30 })
  const [, setViewport] = useState(600)
  const external = !!scrollParent

  useEffect(() => { setRowH(rowHeight) }, [rowHeight])

  const recalc = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    let start: number
    let end: number
    const parent = scrollParent?.current
    if (parent) {
      /*
       * 列表在滚动内容里的起点：用矩形差 + scrollTop 换算，
       * 比 offsetTop 链稳（中间隔着 flex 容器、padding 都对得上）。
       * 上面歌单增减会让这个值变，所以每次滚动都重算一次。
       */
      const rel = el.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop
      const viewTop = parent.scrollTop - rel
      start = Math.max(0, Math.floor(viewTop / rowH) - overscan)
      end = Math.min(items.length, Math.ceil((viewTop + parent.clientHeight) / rowH) + overscan)
      setViewport(parent.clientHeight)
    } else {
      const h = el.clientHeight
      const scrollTop = el.scrollTop
      start = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
      end = Math.min(items.length, Math.ceil((scrollTop + h) / rowH) + overscan)
      setViewport(h)
    }
    setRange(prev => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [items.length, rowH, overscan, scrollParent])

  useLayoutEffect(() => { recalc() }, [recalc])

  useLayoutEffect(() => {
    const el = measureRef.current
    if (!el) return
    const h = el.offsetHeight
    if (h > 0 && Math.abs(h - rowH) > 0.5) setRowH(h)
  })

  useEffect(() => {
    const self = containerRef.current
    const scroller = scrollParent?.current ?? self
    if (!self || !scroller) return
    scroller.addEventListener('scroll', recalc, { passive: true })
    const ro = new ResizeObserver(recalc)
    ro.observe(scroller)
    ro.observe(self)
    return () => { scroller.removeEventListener('scroll', recalc); ro.disconnect() }
  }, [recalc, scrollParent])

  if (!items.length && empty) {
    return <div className={className} ref={containerRef}>{empty}</div>
  }

  const total = items.length * rowH
  const visible = items.slice(range.start, range.end)

  return (
    <div className={'vlist ' + (external ? 'vlist-ext ' : '') + (className ?? '')} ref={containerRef}>
      <div style={{ height: total, position: 'relative' }}>
        {visible.map((item, i) => {
          const index = range.start + i
          return (
            <div
              key={getKey(item, index)}
              /* 第一行挂 ref，用来量真实行高（见上面 rowH 的说明） */
              ref={i === 0 ? measureRef : undefined}
              /*
               * 用 `transform` 定位，不用 `top`。
               *
               * 改 `top` 是布局属性，每一帧都要让浏览器重算这一行的盒子位置（30 行
               * × 每帧）；`transform` 只改变换矩阵，布局一次都不用重排。
               *
               * **用 `translateY` 而不是 `translate3d`。** 3D 变体会给每一行**强制**
               * 开一个合成层，滚动时新行进视口就要现分配/上传一张 GPU 纹理，
               * 低端机上表现为「滑动时行一片片地闪白」（层数还随 overscan 越滚越多）。
               * 2D 变体不触发重排，也不需要强制分层，浏览器按需自己决定。
               *
               * **不要给这里写 `height`**：行高由 CSS 决定（桌面 60、手机 66、
               * 宽屏手机 72），写死就等于把测量结果盖掉，量永远是估值。
               */
              style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${index * rowH}px)` }}
            >
              {renderRow(item, index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

