export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
  }
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function relativeTime(ms: number | null): string {
  if (!ms) return 'never'
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const min = diff / 60_000
  if (min < 1) return 'just now'
  if (min < 60) return `${Math.floor(min)}m ago`
  const hr = min / 60
  if (hr < 24) return `${Math.floor(hr)}h ago`
  const day = hr / 24
  if (day < 7) return `${Math.floor(day)}d ago`
  if (day < 365) return `${Math.floor(day / 7)}w ago`
  return `${Math.floor(day / 365)}y ago`
}

/** Last path segment, tolerant of either separator. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Shorten a long path for display, keeping the tail. */
export function shortPath(p: string, max = 46): string {
  if (p.length <= max) return p
  return `…${p.slice(p.length - max + 1)}`
}

/** Human label for a model id, e.g. `claude-opus-5[1m]` -> `Opus 5 · 1M`. */
export function modelLabel(model: string | null): string {
  // The transcript stamps `<synthetic>` on messages the CLI generated itself
  // (a usage-limit notice, for one), and that is not a model anyone chose.
  if (!model || model.startsWith('<')) return 'default'
  const oneM = /\[1m\]|-1m\b/i.test(model)
  const base = model.replace(/\[1m\]/i, '').replace(/^claude-/, '')
  const parts = base.split('-').filter(Boolean)
  const pretty = parts
    .slice(0, 2)
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
  return oneM ? `${pretty} · 1M` : pretty
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * Freeform strings that reach the UI — errors thrown deep in the main
 * process, then joined together — are built out of the same lowercase
 * `WorklogTarget` values ('notion', 'clickup') the rest of the codebase uses
 * as keys, not as words to show someone. Every other mention of these two
 * services goes through a fixed label map and reads "Notion" / "ClickUp";
 * this catches the ones that arrive as plain text instead, at the point they
 * are rendered.
 */
export function properNouns(text: string): string {
  return text.replace(/\bnotion\b/gi, 'Notion').replace(/\bclickup\b/gi, 'ClickUp')
}

/**
 * A main-process error as the user should read it.
 *
 * Electron wraps anything thrown inside an `ipcMain.handle` before the renderer
 * sees it: `Error invoking remote method 'pty:start': Error: <the real
 * message>`. That prefix is a fact about the transport, not about what went
 * wrong, and it is the first thing on the line — so a message written to be
 * read by a person ("That folder is not there any more: …") arrives buried
 * behind a channel name and two occurrences of the word Error.
 *
 * Both wrappers are stripped, and only from the front, so a message that
 * happens to contain the word later keeps it.
 */
export function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}
