import stringWidth from 'string-width'

/** Ctrl+] belongs to Stoke, except inside a bracketed paste. Track partial
 * markers between stdin chunks so paste never becomes a navigation command. */
export class AgentInput {
  private recent = ''
  private pasting = false
  private pending = ''
  private readonly menuKey: 'f5' | 'f6' | 'ctrl-backslash'
  constructor(menuKey: 'f5' | 'f6' | 'ctrl-backslash' = 'f5') { this.menuKey = menuKey }

  get hasPending(): boolean { return !!this.pending }

  /** A lone Escape still belongs to the agent after the caller's sequence timeout. */
  flush(): string { const value = this.pending; this.pending = ''; return value }

  take(data: string): { forward: string; detach: boolean; menu?: boolean } {
    data = this.pending + data
    this.pending = ''
    let forward = ''
    const start = '\x1b[200~', end = '\x1b[201~'
    const shortcuts = ['\x1b[15~', '\x1b[15;1~', '\x1b[[E', ...(this.menuKey === 'f6' ? ['\x1b[17~', '\x1b[17;1~'] : [])]
    for (let i = 0; i < data.length; i++) {
      const char = data[i]
      if (!this.pasting && char === '\x1c' && this.menuKey === 'ctrl-backslash') return { forward, detach: true, menu: true }
      if (!this.pasting && char === '\x1b') {
        const rest = data.slice(i)
        const shortcut = shortcuts.find((sequence) => rest.startsWith(sequence))
        if (shortcut) { this.recent = ''; return { forward, detach: true, menu: true } }
        if (shortcuts.some((sequence) => sequence.startsWith(rest))) { this.pending = rest; break }
      }
      if (char === '\x1d' && !this.pasting) {
        this.recent = ''
        return { forward, detach: true }
      }
      forward += char
      this.recent = (this.recent + char).slice(-start.length)
      if (this.recent === start) this.pasting = true
      if (this.recent === end) this.pasting = false
    }
    return { forward, detach: false }
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export function previousCursor(line: string, cursor: number): number {
  let previous = 0
  for (const part of graphemes.segment(line)) {
    if (part.index >= cursor) break
    previous = part.index
  }
  return previous
}
export function nextCursor(line: string, cursor: number): number {
  for (const part of graphemes.segment(line)) if (part.index > cursor) return part.index
  return line.length
}

/** Keep the composer on one terminal row, scrolling by whole graphemes. */
export function composerView(line: string, cursor: number, prefix: string, columns: number): { text: string; beforeCursor: string } {
  // Render a visible newline while keeping cursor offsets and the submitted text intact.
  line = line.replace(/\n/g, '↵')
  const cols = Math.max(4, columns)
  if (stringWidth(prefix) > cols / 2) prefix = cols > 16 ? 'stoke › ' : '› '
  const available = Math.max(1, cols - stringWidth(prefix) - 1)
  let start = 0
  while (start < cursor && stringWidth(line.slice(start, cursor)) > Math.max(0, available - 3)) {
    start = nextCursor(line, start)
  }
  const left = start ? '‹' : ''
  let end = start, width = stringWidth(left)
  for (const part of graphemes.segment(line.slice(start))) {
    const size = stringWidth(part.segment)
    if (width + size > available - 1) break
    width += size; end += part.segment.length
  }
  const right = end < line.length ? '›' : ''
  return { text: prefix + left + line.slice(start, end) + right,
    beforeCursor: prefix + left + line.slice(start, Math.min(cursor, end)) }
}
