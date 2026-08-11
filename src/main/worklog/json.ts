/**
 * Reading JSON out of whatever a model actually replied with.
 *
 * Extracted from runner.ts when recall.ts needed the same rescue: two copies of
 * a defensive parser drift, and the copy that drifts is the one that stops
 * rescuing a reply the other one still handles.
 *
 * Nothing here imports electron or node built-ins, so every verify suite can
 * exercise it under `node --experimental-strip-types`.
 */

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function stripFence(text: string): string {
  const fenced = /```(?:json|jsonc|json5)?\s*\r?\n?([\s\S]*?)```/i.exec(text)
  return fenced ? fenced[1].trim() : text
}

/**
 * The first balanced `[...]` or `{...}` in a string, string literals respected.
 *
 * A naive first-bracket-to-last-bracket slice breaks on the reply this exists
 * for: prose either side of the JSON, or a body text that itself contains a
 * bracket.
 */
export function balanced(text: string, open: '[' | '{', close: ']' | '}'): string | null {
  const start = text.indexOf(open)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/**
 * Every balanced run of the given brackets, not just the first.
 *
 * The first one is often not the JSON: "I found [3] things worth logging: [...]"
 * puts a decoy ahead of the real list, and stopping at it would take the decoy —
 * or, worse, fall through to the first balanced *object*, which is proposal one
 * of several and looks like a perfectly good answer.
 */
export function allBalanced(text: string, open: '[' | '{', close: ']' | '}'): string[] {
  const out: string[] = []
  let from = 0
  // Bounded: a reply needing more than a handful of attempts is not a reply this
  // parser should be rescuing.
  while (out.length < 8) {
    const at = text.indexOf(open, from)
    if (at < 0) break
    const slice = balanced(text.slice(at), open, close)
    if (slice) out.push(slice)
    from = at + 1
  }
  return out
}

/** Every shape the JSON might arrive in, best first. */
export function candidates(text: string): string[] {
  const out: string[] = []
  const unfenced = stripFence(text).trim()
  const push = (s: string | null): void => {
    if (s && !out.includes(s)) out.push(s)
  }
  push(unfenced)
  push(text.trim())
  // Every array before any object: an array of proposals also contains balanced
  // objects, and taking one of those would silently drop every proposal but it.
  for (const s of allBalanced(unfenced, '[', ']')) push(s)
  for (const s of allBalanced(text, '[', ']')) push(s)
  for (const s of allBalanced(unfenced, '{', '}')) push(s)
  for (const s of allBalanced(text, '{', '}')) push(s)
  return out
}

/** Every candidate that parses, in the same best-first order. */
export function parsedCandidates(text: string): unknown[] {
  const out: unknown[] = []
  for (const candidate of candidates(text)) {
    try {
      out.push(JSON.parse(candidate))
    } catch {
      /* not this one */
    }
  }
  return out
}
