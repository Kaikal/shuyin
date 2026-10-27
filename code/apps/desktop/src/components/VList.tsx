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
  const [range, setRange] = useState({ start: 0, end: 30 })
  const [, setViewport] = useState(600)
  const external = !!scrollParent

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
      start = Math.max(0, Math.floor(viewTop / rowHeight) - overscan)
      end = Math.min(items.length, Math.ceil((viewTop + parent.clientHeight) / rowHeight) + overscan)
      setViewport(parent.clientHeight)
    } else {
      const h = el.clientHeight
      const scrollTop = el.scrollTop
      start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
      end = Math.min(items.length, Math.ceil((scrollTop + h) / rowHeight) + overscan)
      setViewport(h)
    }
    setRange(prev => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [items.length, rowHeight, overscan, scrollParent])

  useLayoutEffect(() => { recalc() }, [recalc])

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

  const total = items.length * rowHeight
  const visible = items.slice(range.start, range.end)

  return (
    <div className={'vlist ' + (external ? 'vlist-ext ' : '') + (className ?? '')} ref={containerRef}>
      <div style={{ height: total, position: 'relative' }}>
        {visible.map((item, i) => {
          const index = range.start + i
          return (
            <div
              key={getKey(item, index)}
              style={{ position: 'absolute', top: index * rowHeight, left: 0, right: 0, height: rowHeight }}
            >
              {renderRow(item, index)}
            </div>
  )
        })}
      </div>
    </div>
  )
}

