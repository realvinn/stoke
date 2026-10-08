/** Public xterm buffer surface shared by desktop and phone; no DOM internals. */
interface BufferView {
  type: 'normal' | 'alternate'
  baseY: number
  viewportY: number
  getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined
}

export interface ViewportTerminal {
  rows: number
  buffer: { active: BufferView }
  scrollToLine(line: number): void
  scrollToBottom(): void
}

export interface TerminalViewport {
  following: boolean
  distance: number
  anchor: string
  offset: number
}

/** Capture what the reader sees before replacing a reconnect snapshot. */
export function captureTerminalViewport(term: ViewportTerminal): TerminalViewport {
  const buffer = term.buffer.active
  const distance = Math.max(0, buffer.baseY - buffer.viewportY)
  let anchor = ''
  let offset = 0
  if (buffer.type === 'normal' && distance > 0) {
    for (let row = 0; row < Math.min(term.rows, 5); row++) {
      const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
      if (line.trim()) { anchor = line; offset = row; break }
    }
  }
  return { following: buffer.type !== 'normal' || distance === 0, distance, anchor, offset }
}

/** Call after xterm finishes parsing the snapshot. Prefer the visible text
 * over a row number: mirror history is bounded and output may have arrived
 * while disconnected. With duplicate text choose the nearest expected row.
 */
export function restoreTerminalViewport(term: ViewportTerminal, saved: TerminalViewport, waitForAnchor = false): boolean {
  const buffer = term.buffer.active
  if (saved.following || buffer.type !== 'normal') { term.scrollToBottom(); return true }
  const expected = Math.max(0, buffer.baseY - saved.distance)
  let chosen = expected
  let nearest = Infinity
  if (saved.anchor) {
    for (let row = 0; row <= buffer.baseY; row++) {
      if (buffer.getLine(row)?.translateToString(true) !== saved.anchor) continue
      const distance = Math.abs(row - saved.offset - expected)
      if (distance < nearest) { nearest = distance; chosen = row - saved.offset }
    }
  }
  if (waitForAnchor && saved.anchor && nearest === Infinity) return false
  term.scrollToLine(Math.max(0, Math.min(buffer.baseY, chosen)))
  return true
}
