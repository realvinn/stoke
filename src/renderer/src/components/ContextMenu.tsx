import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Draw a divider above this item. */
  separated?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/*
 * A renderer-drawn menu rather than Electron's native one, because a native
 * Menu cannot be themed and every colour in this app comes from a CSS custom
 * property. It renders hidden for one frame so it can be measured and nudged
 * back on screen before it is ever seen.
 */
export function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const gap = 6
    const left = Math.max(gap, Math.min(x, window.innerWidth - r.width - gap))
    const top = Math.max(gap, Math.min(y, window.innerHeight - r.height - gap))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.visibility = 'visible'
  }, [x, y])

  useEffect(() => {
    /*
     * Listen in the capture phase so a click lands on the menu before anything
     * else can act on it - the terminal underneath would otherwise steal focus.
     * stopPropagation on the menu itself would not help, since capture runs
     * before the target's own handlers, so test containment instead.
     */
    const dismiss = (e: Event): void => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', dismiss, true)
    window.addEventListener('wheel', dismiss, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('wheel', dismiss, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      style={{ left: x, top: y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className="context-menu-item"
          role="menuitem"
          type="button"
          disabled={item.disabled}
          data-separated={item.separated ? 'true' : undefined}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
