import { useEffect, useRef } from 'react'
import { useFloatingLayer } from '../lib/floatingLayers'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Draw a divider above this item. */
  separated?: boolean
  /**
   * The chord that does the same thing, drawn muted at the right edge. A menu
   * is where someone looks when they cannot find a gesture, so it is the one
   * place a keyboard shortcut is worth spelling out.
   */
  hint?: string
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  /**
   * A title and dim subtitle drawn above the items — what the menu is acting on.
   * The tab menu uses it for the tab's name and the project folder it launched
   * from. Not focusable and not a menu item, so it stays out of `role="menu"`.
   */
  header?: {
    title: string
    subtitle?: string
    /**
     * Facts about it, a line each, in ordinary muted text that wraps — the git
     * button's changes and upstream. Never menu items: dimmed like disabled
     * ones they fell to ~2.3:1, and a screen reader calls those unavailable.
     * With lines the title wraps too, rather than cutting a long branch name.
     */
    lines?: readonly string[]
  }
  /**
   * Explanatory text below the items. Not a menu item: it is not focusable and
   * cannot be chosen, so it stays out of `role="menu"`'s children.
   */
  footer?: string
  onClose: () => void
}

/*
 * A renderer-drawn menu rather than Electron's native one, because a native
 * Menu cannot be themed and every colour in this app comes from a CSS custom
 * property. It renders hidden for one frame so it can be measured and nudged
 * back on screen before it is ever seen.
 */
export function ContextMenu({ x, y, items, header, footer, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Mounted only while open. A tab's menu drops over the docked browser, and a
  // terminal's can reach it near the column's edge (gotcha 14).
  useFloatingLayer(ref, true)

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
    /*
     * An Escape that closes the menu is the menu's, and stops here. Focus is
     * usually still in the terminal (a press on a tab or a title-bar chip never
     * takes it), so one that went on to xterm reached the session as ESC and
     * interrupted Claude — measured over CDP with a stub that logs its input:
     * closing a title-bar chip's menu with Escape wrote `\x1b` to the pty.
     */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
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
      {header && (
        <div className="context-menu-header" data-lines={header.lines?.length ? true : undefined}>
          <span className="context-menu-title">{header.title}</span>
          {header.subtitle && <span className="context-menu-subtitle">{header.subtitle}</span>}
          {header.lines?.map((line, i) => (
            <span key={i} className="context-menu-line">
              {line}
            </span>
          ))}
        </div>
      )}
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
          <span>{item.label}</span>
          {item.hint && <span className="context-menu-key">{item.hint}</span>}
        </button>
      ))}
      {footer && <p className="context-menu-hint">{footer}</p>}
    </div>
  )
}
