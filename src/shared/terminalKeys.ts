/*
 * Raw terminal keys for the remote controls. Pure shared code: no DOM/Node
 * imports, so both browser surfaces and the phone verify suite can use it.
 *
 * F keys and cursor keys follow xterm.js 6's common/input/Keyboard.ts.
 * Editing-keypad modifiers follow XTerm's PC-Style Function Keys protocol:
 * https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-PC-Style-Function-Keys
 * These controls send keys directly, so Shift+PageUp and Shift+Insert reach
 * the application instead of invoking the browser terminal's scroll/paste.
 */

export const TERMINAL_FUNCTION_KEYS = [
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
] as const

export type TerminalFunctionKey = typeof TERMINAL_FUNCTION_KEYS[number]

export type TerminalKey = TerminalFunctionKey
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Home' | 'End' | 'PageUp' | 'PageDown' | 'Delete' | 'Insert'
  | 'Tab' | 'Enter' | 'Escape' | 'Backspace'

export interface TerminalKeyModifiers {
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly alt?: boolean
}

const CURSOR_KEYS: ReadonlyMap<string, string> = new Map([
  ['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D'],
  ['Home', 'H'], ['End', 'F']
])

const FUNCTION_SUFFIXES: ReadonlyMap<string, string> = new Map([
  ['F1', 'P'], ['F2', 'Q'], ['F3', 'R'], ['F4', 'S']
])

const TILDE_KEYS: ReadonlyMap<string, number> = new Map([
  ['Insert', 2], ['Delete', 3], ['PageUp', 5], ['PageDown', 6],
  ['F5', 15], ['F6', 17], ['F7', 18], ['F8', 19],
  ['F9', 20], ['F10', 21], ['F11', 23], ['F12', 24]
])

/**
 * Encode one named key, or return null when that combination has no supported
 * legacy encoding. Never invent modifier bytes for Tab/Enter/Escape/Backspace.
 * The caller may keep its modifier latch on a null result without sending.
 *
 * Cursor application mode affects only unmodified arrows/Home/End. Modified
 * keys always use CSI and the XTerm parameter 1 + Shift + 2*Alt + 4*Ctrl.
 */
export function terminalKeySequence(
  key: string,
  modifiers: TerminalKeyModifiers = {},
  applicationCursorMode = false
): string | null {
  const parameter = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0)
  const modified = parameter !== 1
  const cursor = CURSOR_KEYS.get(key)
  if (cursor) {
    return modified ? `\x1b[1;${parameter}${cursor}` : `\x1b${applicationCursorMode ? 'O' : '['}${cursor}`
  }
  const fn = FUNCTION_SUFFIXES.get(key)
  if (fn) return modified ? `\x1b[1;${parameter}${fn}` : `\x1bO${fn}`
  const tilde = TILDE_KEYS.get(key)
  if (tilde !== undefined) return `\x1b[${tilde}${modified ? `;${parameter}` : ''}~`

  if (key === 'Tab') {
    if (modifiers.ctrl || modifiers.alt) return null
    return modifiers.shift ? '\x1b[Z' : '\t'
  }
  if (key === 'Enter' || key === 'Escape' || key === 'Backspace') {
    if (modifiers.shift || modifiers.ctrl) return null
    const bare = key === 'Enter' ? '\r' : key === 'Escape' ? '\x1b' : '\x7f'
    return modifiers.alt ? `\x1b${bare}` : bare
  }
  return null
}
