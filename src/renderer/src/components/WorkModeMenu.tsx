/**
 * Work mode's own menu: which file types to type, characters per key, the
 * build panel, and Leave. Opened from the gear, a right-click anywhere, or a
 * fake menu label. It mounts when it opens and focuses its first control after
 * mount — never a `visibility` show-then-focus (gotcha 137).
 *
 * It registers as a floating layer (verify:layers wants every `role="menu"`
 * to); the docked browser is already hidden while Work mode is up (it is an
 * `overlayOpen` overlay), so this is for the rule's sake only.
 */
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useFloatingLayer } from '../lib/floatingLayers'
import { languageOf, WM_CHARS_MAX, WM_CHARS_MIN, WM_TYPES_SHOWN, type WorkModeType } from '@shared/workMode'

interface Props {
  x: number
  y: number
  types: readonly WorkModeType[]
  picks: readonly string[]
  charsPerKey: number
  panel: boolean
  automatic: boolean
  onPicks: (picks: string[]) => void
  onChars: (n: number) => void
  onPanel: (on: boolean) => void
  onAutomatic: (on: boolean) => void
  onLeave: () => void
}

export const WorkModeMenu = forwardRef<HTMLDivElement | null, Props>(function WorkModeMenu(
  { x, y, types, picks, charsPerKey, panel, automatic, onPicks, onChars, onPanel, onAutomatic, onLeave },
  outer
) {
  const ref = useRef<HTMLDivElement>(null)
  useImperativeHandle(outer, () => ref.current as HTMLDivElement, [])
  useFloatingLayer(ref, true)
  const shown = types.slice(0, WM_TYPES_SHOWN)

  // Inside the window, then the first control focused, after mount.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`
    el.querySelector<HTMLElement>('input, button')?.focus()
  }, [x, y])

  return (
    <div ref={ref} className="wm-menu" role="menu" aria-label="Work mode" style={{ left: x, top: y }}>
      <div className="wm-menu-title">File types to type</div>
      {shown.length === 0 && <p className="wm-kbd">No file types to choose from.</p>}
      {shown.map((t) => {
        const on = picks.includes(t.ext)
        const last = on && picks.length === 1
        return (
          <label key={t.ext} role="menuitemcheckbox" aria-checked={on}>
            <input
              type="checkbox"
              checked={on}
              disabled={last}
              onChange={(e) => onPicks(e.target.checked ? [...picks, t.ext] : picks.filter((p) => p !== t.ext))}
            />
            <span>
              {languageOf(t.ext)} <span className="wm-kbd">.{t.ext}</span>
            </span>
            <span className="wm-menu-count">{t.count}</span>
          </label>
        )
      })}
      <div className="wm-menu-sep" />
      <div className="wm-menu-row">
        <span>Characters per key</span>
        <span className="wm-stepper">
          <button type="button" aria-label="Fewer characters per key" disabled={charsPerKey <= WM_CHARS_MIN} onClick={() => onChars(charsPerKey - 1)}>
            −
          </button>
          <span>{charsPerKey}</span>
          <button type="button" aria-label="More characters per key" disabled={charsPerKey >= WM_CHARS_MAX} onClick={() => onChars(charsPerKey + 1)}>
            +
          </button>
        </span>
      </div>
      <label role="menuitemcheckbox" aria-checked={panel}>
        <input type="checkbox" checked={panel} onChange={(e) => onPanel(e.target.checked)} />
        <span>Show build output now and then</span>
      </label>
      <label role="menuitemcheckbox" aria-checked={automatic}>
        <input type="checkbox" checked={automatic} onChange={(e) => onAutomatic(e.target.checked)} />
        <span>Type automatically</span>
      </label>
      <div className="wm-menu-sep" />
      <button type="button" role="menuitem" className="wm-menu-item" onClick={onLeave}>
        <span>Leave Work mode</span>
        <span className="wm-kbd">Esc Esc</span>
      </button>
    </div>
  )
})
