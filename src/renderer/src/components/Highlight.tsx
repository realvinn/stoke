import type { Range } from '../lib/projectSearch'

/**
 * `text` with each range wrapped in a `<mark>`. The ranges come from
 * `projectSearch.ts`, in UTF-16 code units of this exact string, sorted and
 * non-overlapping; anything out of bounds is clamped rather than trusted, so a
 * stale range can mis-highlight but never throw or drop text.
 */
export function Highlight({
  text,
  ranges
}: {
  text: string
  ranges: readonly Range[]
}): React.JSX.Element {
  if (ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let at = 0
  ranges.forEach(([s, e], i) => {
    const start = Math.max(at, Math.min(s, text.length))
    const end = Math.max(start, Math.min(e, text.length))
    if (start > at) parts.push(text.slice(at, start))
    if (end > start) {
      parts.push(
        <mark key={i} className="hit">
          {text.slice(start, end)}
        </mark>
      )
    }
    at = end
  })
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
