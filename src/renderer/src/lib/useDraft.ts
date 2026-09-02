import { useEffect, useRef, useState } from 'react'

/**
 * A text field that is edited locally and committed on blur or Enter.
 *
 * Every settings input used to call `onPatch` in `onChange`, and `patchSettings`
 * is a round trip to disk that comes back and re-renders the controlled value —
 * so characters typed while a write was in flight were dropped, a cleared box
 * snapped straight back to its default before you could retype, and a number
 * that clamps could not be typed at all ("1" of "12" became 9). HostsSettings
 * and WorklogSettings each grew their own draft-and-commit for exactly this;
 * this is that pattern once.
 *
 * The draft follows `value` whenever the field is NOT being edited, so a change
 * made elsewhere (another control, another machine's settings sync) still shows
 * up. It is flushed on unmount as well, because Escape closes the sheet by
 * unmounting it and React delivers no blur to a node that is going away.
 */
export function useDraft(
  value: string,
  commit: (next: string) => void
): {
  draft: string
  setDraft: (v: string) => void
  onBlur: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
} {
  const [draft, setDraft] = useState(value)
  const editing = useRef(false)
  const latest = useRef({ draft, value, commit })
  latest.current = { draft, value, commit }

  useEffect(() => {
    if (!editing.current) setDraft(value)
  }, [value])

  const flush = (): void => {
    editing.current = false
    const { draft: d, value: v, commit: c } = latest.current
    if (d !== v) c(d)
  }

  // Unmount is a real exit path (Escape), so an edit in progress lands.
  useEffect(() => () => flush(), [])

  return {
    draft,
    setDraft: (v) => {
      editing.current = true
      setDraft(v)
    },
    onBlur: flush,
    onKeyDown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        flush()
        ;(e.target as HTMLElement).blur()
      }
    }
  }
}
