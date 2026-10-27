import stringWidth from 'string-width'

/** ConPTY's CSI Vk;Sc;Uc;Kd;Cs;Rc_ records can arrive after a child enables
 * mode 9001. Decode Stoke shortcuts, retaining other physical events for the
 * native agent. See https://github.com/microsoft/terminal/issues/4999. */
export class ConsoleInput {
  private pending = ''
  private rawPaste = false
  get hasPending(): boolean { return !!this.pending }
  flush(): string { const value = this.pending; this.pending = ''; return value }
  take(chunk: string, preservePhysical = false): string {
    const data = this.pending + chunk
    this.pending = ''
    let result = ''
    for (let i = 0; i < data.length;) {
      if (data[i] !== '\x1b') { result += data[i++]; continue }
      const rest = data.slice(i)
      if (this.rawPaste) {
        if (rest.startsWith('\x1b[201~')) { this.rawPaste = false; result += '\x1b[201~'; i += 6; continue }
        if ('\x1b[201~'.startsWith(rest)) { this.pending = rest; break }
        result += data[i++]; continue
      }
      if (rest.startsWith('\x1b[200~')) { this.rawPaste = true; result += '\x1b[200~'; i += 6; continue }
      const record = /^\x1b\[(\d*(?:;\d*){1,5})_/.exec(rest)
      if (!record) {
        if (rest.length < 90 && (rest === '\x1b' || /^\x1b\[\d*(?:;\d*){0,5}$/.test(rest))) { this.pending = rest; break }
        result += data[i++]; continue
      }
      i += record[0].length
      const fields = record[1].split(';')
      const [vk, , uc, down, control, repeat] = Array.from({ length: 6 }, (_, j) => fields[j] ? Number(fields[j]) : j === 5 ? 1 : 0)
      if (![vk, uc, down, control, repeat].every(Number.isSafeInteger) || uc > 65535 || repeat > 65535 || down > 1) { result += record[0]; continue }
      if (repeat > 1024) { result += record[0]; continue } // Keep unreasonable repeat records encoded, without allocating an expanded paste.
      const shortcut = ([113, 114, 115, 116, 117, 120].includes(vk) && !(control & 31)) || uc === 29 || uc === 28
      if (preservePhysical && vk !== 0 && !shortcut) { result += record[0]; continue }
      if (!down || !repeat) continue
      const shift = !!(control & 16), alt = !!(control & 3), ctrl = !!(control & 12)
      const modifier = 1 + Number(shift) + Number(alt) * 2 + Number(ctrl) * 4
      let key = ''
      if (uc || vk === 0) key = (alt && !ctrl ? '\x1b' : '') + String.fromCharCode(uc)
      else if (ctrl && vk >= 65 && vk <= 90) key = String.fromCharCode(vk - 64)
      else if (ctrl && vk === 32) key = '\0'
      else if (vk === 9) key = shift ? '\x1b[Z' : '\t'
      else if (vk === 13) key = '\r'
      else if (vk === 8) key = '\x7f'
      else if (vk === 27) key = '\x1b'
      else if ([35, 36, 37, 38, 39, 40].includes(vk)) {
        const end = ({ 35: 'F', 36: 'H', 37: 'D', 38: 'A', 39: 'C', 40: 'B' } as Record<number, string>)[vk]
        key = modifier === 1 ? `\x1b[${end}` : `\x1b[1;${modifier}${end}`
      } else if (vk >= 112 && vk <= 115) key = modifier === 1 ? `\x1bO${'PQRS'[vk - 112]}` : `\x1b[1;${modifier}${'PQRS'[vk - 112]}`
      else {
        const code = ({ 33: 5, 34: 6, 45: 2, 46: 3, 116: 15, 117: 17, 118: 18, 119: 19, 120: 20, 121: 21, 122: 23, 123: 24 } as Record<number, number>)[vk]
        if (code) key = `\x1b[${code}${modifier === 1 ? '' : `;${modifier}`}~`
      }
      result += key.repeat(repeat)
    }
    return result
  }
}

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

  take(data: string): { forward: string; detach: boolean; menu?: boolean; action?: 'new' | 'previous' | 'next' | 'settings' | 'detach' } {
    data = this.pending + data
    this.pending = ''
    let forward = ''
    const start = '\x1b[200~', end = '\x1b[201~'
    const shortcuts = ['\x1b[15~', '\x1b[15;1~', '\x1b[[E', ...(this.menuKey === 'f6' ? ['\x1b[17~', '\x1b[17;1~'] : [])]
    const actions = new Map<string, 'new' | 'previous' | 'next' | 'settings' | 'detach'>([
      ...['\x1bOQ', '\x1b[12~', '\x1b[1;1Q', '\x1b[[B'].map((s) => [s, 'new'] as const),
      ...['\x1bOR', '\x1b[13~', '\x1b[1;1R', '\x1b[[C'].map((s) => [s, 'previous'] as const),
      ...['\x1bOS', '\x1b[14~', '\x1b[1;1S', '\x1b[[D'].map((s) => [s, 'next'] as const),
      ['\x1b[20~', 'settings'], ['\x1b[20;1~', 'settings'],
      ...(this.menuKey === 'f6' ? [] : [['\x1b[17~', 'detach'], ['\x1b[17;1~', 'detach']] as const)
    ])
    for (let i = 0; i < data.length; i++) {
      const char = data[i]
      if (!this.pasting && char === '\x1c' && this.menuKey === 'ctrl-backslash') return { forward, detach: true, menu: true }
      if (!this.pasting && char === '\x1b') {
        const rest = data.slice(i)
        const shortcut = shortcuts.find((sequence) => rest.startsWith(sequence))
        if (shortcut) { this.recent = ''; return { forward, detach: true, menu: true } }
        const action = [...actions].find(([sequence]) => rest.startsWith(sequence))
        if (action) { this.recent = ''; return { forward, detach: true, action: action[1] } }
        if ([...shortcuts, ...actions.keys()].some((sequence) => sequence.startsWith(rest))) { this.pending = rest; break }
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
