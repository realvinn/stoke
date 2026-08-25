import type { ReactNode } from 'react'

/**
 * One scannable line under a control, with the reasoning folded away behind it.
 *
 * The settings panels had grown to roughly 1,800 words of explanation — thirty
 * hints over twenty words, the longest seventy-four — and the problem was never
 * that the prose was wrong. Most of it says something true and useful that
 * cannot be worked out from the control's label. The problem is that all of it
 * arrives at once, so the panel reads as an essay and the sentence that would
 * actually have answered your question is buried in the middle of a paragraph
 * you skipped.
 *
 * So: the short line always shows, and the rest is one click away and closed by
 * default. Nothing is deleted.
 *
 * A native `<details>` rather than a state hook, and that is not laziness. It
 * is keyboard-operable, announced correctly by screen readers, survives a
 * re-render without a `useState`, and Ctrl/Cmd+F finds text inside a closed one
 * in Chromium. Reimplementing it with a button and a boolean would be more code
 * that does less.
 */
export function FieldHint({
  children,
  more,
  tone
}: {
  /** The one line that is always visible. Keep it under about fifteen words. */
  children: ReactNode
  /** Everything the short line had to leave out. Omitted means no disclosure. */
  more?: ReactNode
  tone?: 'warning'
}): React.JSX.Element {
  return (
    <div className="field-hint" data-tone={tone}>
      {children}
      {more != null && (
        <details className="field-detail">
          <summary>Why?</summary>
          <div className="field-detail-body">{more}</div>
        </details>
      )}
    </div>
  )
}
