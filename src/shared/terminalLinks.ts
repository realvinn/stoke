/** xterm's ordinary web provider joins only rows marked isWrapped. SSH/tmux
 * screen repainting can instead place a URL using CRLF or cursor positioning.
 * Repair those full-width boundaries without joining ordinary short lines. */
interface Cell { getChars(): string; getWidth(): number }
interface Line { isWrapped: boolean; getCell(index: number): Cell | undefined }
export interface LinkTerminal {
  cols: number
  buffer: { active: { length: number; getLine(index: number): Line | undefined } }
}
interface Point { x: number; y: number; width: number }
interface Row { text: string; positions: Point[]; wrapped: boolean; full: boolean; y: number }
export interface TerminalLinkRepair {
  text: string
  range: { start: { x: number; y: number }; end: { x: number; y: number } }
}
const MAX_ROWS = 32
const MAX_CHARS = 8192
const fragment = (value: string): boolean => !!value && !/[\s"'<>`{}|\\\^\u2500-\u257f]/u.test(value)

function rowOf(terminal: LinkTerminal, y: number): Row | null {
  const line = terminal.buffer.active.getLine(y)
  if (!line) return null
  let text = ''
  const positions: Point[] = []
  let lastFilled = 0
  let rightEdge = 0
  for (let x = 0; x < Math.min(terminal.cols, 1024); x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars()
    const value = chars || ' '
    text += value
    for (let i = 0; i < value.length; i++) positions.push({ x, y, width: cell.getWidth() })
    if (chars) { lastFilled = text.length; rightEdge = x + cell.getWidth() }
  }
  // Drop unoccupied cells, retaining real printed spaces as delimiters. This
  // also drops the placeholder before a wide glyph wraps to the next row.
  return { y, text: text.slice(0, lastFilled), positions: positions.slice(0, lastFilled), wrapped: line.isWrapped, full: rightEdge >= terminal.cols }
}
function joins(previous: Row, next: Row): boolean {
  if (next.wrapped) return true
  return previous.full && fragment(previous.text.at(-1) ?? '') && fragment(next.text[0] ?? '') && !/^https?:\/\//i.test(next.text)
}
function trimLink(value: string): string {
  let text = value.replace(/[.,;:!?]+$/, '')
  // A URL can contain balanced parentheses (Wikipedia paths, for example).
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0, -1)
  }
  return text
}
export function terminalHttpLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_CHARS || /[\s\x00-\x1f\x7f]/.test(value)) return null
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname ? value : null } catch { return null }
}

/** A user's explicit selection can cover indented or short hard-wrapped rows.
 * Only one complete HTTP(S) URL is offered; prose and multiple URLs are refused. */
export function selectedTerminalLink(value: string): string | null {
  if (value.length > MAX_CHARS * 2 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null
  const lines = value.trim().split(/\r?\n/).map((line) => line.trim())
  if (!lines.length || lines.some((line) => !line || /\s/.test(line))) return null
  const joined = lines.join('')
  if ((joined.match(/https?:\/\//gi)?.length ?? 0) !== 1) return null
  return terminalHttpLink(joined)
}

/** Absolute buffer coordinates, 1-based with an inclusive end, as xterm needs. */
export function terminalLinkRepairs(terminal: LinkTerminal, lineNumber: number): TerminalLinkRepair[] {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > terminal.buffer.active.length || terminal.cols > 1024) return []
  const current = rowOf(terminal, lineNumber - 1)
  if (!current) return []
  const rows = [current]
  let chars = current.text.length
  while (rows[0].y > 0) {
    const previous = rowOf(terminal, rows[0].y - 1)
    if (!previous || !joins(previous, rows[0])) break
    if (rows.length >= MAX_ROWS || chars + previous.text.length > MAX_CHARS) return []
    rows.unshift(previous); chars += previous.text.length
  }
  while (rows.at(-1)!.y + 1 < terminal.buffer.active.length) {
    const next = rowOf(terminal, rows.at(-1)!.y + 1)
    if (!next || !joins(rows.at(-1)!, next)) break
    if (rows.length >= MAX_ROWS || chars + next.text.length > MAX_CHARS) return []
    rows.push(next); chars += next.text.length
  }
  const text = rows.map((r) => r.text).join('')
  const positions = rows.flatMap((r) => r.positions)
  const hard = new Set(rows.slice(1).filter((r) => !r.wrapped).map((r) => r.y))
  const found: TerminalLinkRepair[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`{}|\\\^\u2500-\u257f]+/gi)) {
    const uri = trimLink(match[0])
    if (!terminalHttpLink(uri)) continue
    const start = positions[match.index!]
    const end = positions[match.index! + uri.length - 1]
    if (!start || !end || start.y === end.y || current.y < start.y || current.y > end.y || ![...hard].some((y) => y > start.y && y <= end.y)) continue
    found.push({ text: uri, range: { start: { x: start.x + 1, y: start.y + 1 }, end: { x: end.x + end.width, y: end.y + 1 } } })
  }
  return found
}
