/**
 * One colour, editable in whichever notation the reader thinks in — or picked
 * on the wheel its swatch opens (ColorPicker).
 *
 * The four notations are not four formats to store -- everything is stored as
 * `#rrggbb`. They are four ways to TYPE the same value, and the reason to offer
 * more than hex is that hex is the one notation you cannot reason about:
 * nudging a colour's lightness without changing its hue is a single-field edit
 * in OKLCH and arithmetic on three bytes in hex.
 *
 * OKLCH is first and is the default for that reason, and because it is the
 * space the whole palette is solved in (`ladder.ts`, `accent.ts`) -- so a value
 * read here is directly comparable to the numbers those files talk about.
 *
 * The parsing and formatting live in `@shared/notation` so a suite can assert
 * them without rendering anything.
 */
import { useEffect, useRef, useState } from 'react'
import { format, parseNotation, type Notation } from '@shared/notation'
import { ColorPicker, type ColorPreset, type InkPreview } from './ColorPicker'

interface Props {
  value: string
  notation: Notation
  label: string
  onChange: (hex: string) => void
  /**
   * Commit a parseable draft that differs from `value` when the field
   * unmounts. Escape closes the Settings sheet by unmounting it and delivers no
   * blur, so a colour typed there and never blurred was lost (gotcha 63). Opt-in
   * so the theme editor, whose draft is its own, keeps its behaviour.
   */
  commitOnUnmount?: boolean
  /** The picker's preset row. */
  presets?: readonly ColorPreset[]
  /** The picker's "Reset to default". */
  defaultValue?: string
  /** What the picker previews the colour as ("on this theme"). */
  ink?: InkPreview | null
  /**
   * Unsaved preview while the picker moves, null to withdraw it. Where the
   * owner's value is itself a draft — the theme editor's seed — pass `live`
   * instead, and every frame of a drag goes to `onChange`, which repaints the
   * whole window and writes nothing.
   */
  onPreview?: (hex: string | null) => void
  live?: boolean
}

export function ColorField({
  value,
  notation,
  label,
  onChange,
  commitOnUnmount,
  presets,
  defaultValue,
  ink,
  onPreview,
  live
}: Props): React.JSX.Element {
  /*
   * A draft, not a controlled field on `value`.
   *
   * Every keystroke of "oklch(0.7 0.15 51)" passes through states that parse to
   * something else or to nothing -- "oklch(0" is not a colour, and "oklch(0.7 0"
   * is a different one. Committing on each would repaint the whole app to
   * garbage between keystrokes, which is the live-preview version of the
   * blank-token flicker `stripEmpty` guards against one layer down.
   */
  const [draft, setDraft] = useState(() => format(value, notation))
  const [bad, setBad] = useState(false)
  const [open, setOpen] = useState(false)
  const swatchRef = useRef<HTMLButtonElement>(null)
  /** What the value was when the picker opened, for a `live` revert. */
  const openedAt = useRef(value)

  const latest = useRef({ draft, value, onChange, commitOnUnmount })
  latest.current = { draft, value, onChange, commitOnUnmount }
  useEffect(
    () => () => {
      const { draft: d, value: v, onChange: set, commitOnUnmount: flush } = latest.current
      if (!flush) return
      const hex = parseNotation(d)
      if (hex && hex.toLowerCase() !== v.toLowerCase()) set(hex)
    },
    []
  )

  // Re-sync when the value or the notation changes from outside: switching
  // notation must rewrite the field, and a seed change must move it.
  useEffect(() => {
    setDraft(format(value, notation))
    setBad(false)
  }, [value, notation])

  const commit = (raw: string): void => {
    const hex = parseNotation(raw)
    if (!hex) {
      setBad(true)
      return
    }
    setBad(false)
    onChange(hex)
  }

  const preview = live
    ? (hex: string | null): void => onChange(hex ?? openedAt.current)
    : onPreview

  return (
    <div className="color-field">
      <button
        ref={swatchRef}
        type="button"
        className="color-field-swatch"
        style={{ background: value }}
        aria-label={`${label}: open the colour picker`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Pick a colour"
        onClick={() => {
          // A second press closes it, keeping the pick: the picker's unmount
          // commits (it treats the swatch as its own, not as "outside").
          if (!open) openedAt.current = value
          setOpen(!open)
        }}
      />
      <input
        className="input mono"
        value={draft}
        spellCheck={false}
        aria-label={label}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setDraft(e.target.value)
          setBad(false)
        }}
        // Commit on blur and on Enter rather than per keystroke, for the reason
        // on `draft` above.
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
          if (e.key === 'Escape') setDraft(format(value, notation))
        }}
      />
      {open && (
        <ColorPicker
          anchor={swatchRef.current}
          value={value}
          label={label}
          presets={presets}
          defaultValue={defaultValue}
          ink={ink}
          onPreview={preview}
          onCommit={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
