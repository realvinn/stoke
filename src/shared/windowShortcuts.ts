/** Native input interception also covers the embedded browser's separate WebContents. */
export type TabShortcut = { type: 'newTab' } | { type: 'reopenTab' } | { type: 'closeTab' } | { type: 'cycleTab'; delta: -1 | 1 } | { type: 'tab'; index: number }

/** Tab controls are caught before xterm can send Ctrl+T/W/Tab to the PTY. */
export function tabShortcut(input: { type: string; key: string; code?: string; control: boolean; meta: boolean; shift: boolean; alt: boolean; isAutoRepeat?: boolean; isComposing?: boolean }, isMac: boolean): TabShortcut | null {
  if (input.type !== 'keyDown' || input.alt || input.isAutoRepeat || input.isComposing) return null
  const code = input.code || (input.key.length === 1 ? (/^[1-9]$/.test(input.key) ? 'Digit' : 'Key') + input.key.toUpperCase() : input.key)
  if (code === 'Tab' && input.control && !input.meta) return { type: 'cycleTab', delta: input.shift ? -1 : 1 }
  if (!(isMac ? input.meta && !input.control : input.control && !input.meta)) return null
  const digit = /^Digit([1-9])$/.exec(code)
  if (digit && !input.shift) return { type: 'tab', index: Number(digit[1]) }
  if (input.shift && (code === 'BracketLeft' || code === 'BracketRight')) return { type: 'cycleTab', delta: code === 'BracketLeft' ? -1 : 1 }
  if (code === 'KeyT' && input.shift) return { type: 'reopenTab' }
  if (isMac && input.shift) return null
  return code === 'KeyT' ? { type: 'newTab' } : code === 'KeyW' ? { type: 'closeTab' } : null
}

export function windowShortcut(input: { type: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean; isAutoRepeat?: boolean; isComposing?: boolean }, isMac: boolean, count: number): -1 | 1 | null {
  if (count < 2 || input.type !== 'keyDown' || input.shift || input.alt || input.isAutoRepeat || input.isComposing) return null
  if (!(isMac ? input.meta && !input.control : input.control && !input.meta)) return null
  return input.key === 'ArrowLeft' ? -1 : input.key === 'ArrowRight' ? 1 : null
}

export function nextWindow<T>(windows: readonly T[], current: T, delta: -1 | 1): T | null {
  const index = windows.indexOf(current)
  return windows.length > 1 && index >= 0 ? windows[(index + delta + windows.length) % windows.length] : null
}
