import { useEffect, useRef, useState, type RefObject } from 'react'

/** Keep overflow navigation outside the clipped tab list, beside the + button. */
export function useTabOverflow(listRef: RefObject<HTMLDivElement | null>, count: number, busy: () => boolean) {
  const [edges, setEdges] = useState({ overflowing: false, left: false, right: false })
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const max = list.scrollWidth - list.clientWidth
      const next = { overflowing: max > 1, left: list.scrollLeft > 1, right: list.scrollLeft < max - 1 }
      setEdges((old) => old.overflowing === next.overflowing && old.left === next.left && old.right === next.right ? old : next)
    }
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(measure) }
    const wheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey || busyRef.current() || list.scrollWidth <= list.clientWidth + 1) return
      // Preserve trackpad direction; translate an ordinary mouse's vertical
      // wheel into horizontal movement. Never consume Ctrl+wheel zoom.
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1
      if (!delta) return
      event.preventDefault()
      list.scrollLeft += delta * scale
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(list)
    for (const tab of list.children) observer.observe(tab)
    list.addEventListener('scroll', schedule, { passive: true })
    list.addEventListener('wheel', wheel, { passive: false })
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      list.removeEventListener('scroll', schedule)
      list.removeEventListener('wheel', wheel)
    }
  }, [listRef, count])

  const scroll = (direction: -1 | 1): void => {
    const list = listRef.current
    if (!list || busyRef.current()) return
    list.scrollBy({ left: direction * Math.max(112, list.clientWidth * 0.75), behavior: 'auto' })
  }
  return { ...edges, scroll }
}
