/**
 * One colour, editable in whichever notation the reader thinks in.
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
import { useEffect, useState } from 'react'
import { format, parseNotation, type Notation } from '@shared/notation'

interface Props {
  value: string
  notation: Notation
  label: string
  onChange: (hex: string) => void
}

export function ColorField({ value, notation, label, onChange }: Props): React.JSX.Element {
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

  return (
    <label className="color-field">
      <span className="color-field-swatch" style={{ background: value }} aria-hidden="true" />
      <span className="sr-only">{label}</span>
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
    </label>
  )
}
