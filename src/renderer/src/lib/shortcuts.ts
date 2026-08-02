export type ShortcutAction =
  | { type: 'palette' }
  | { type: 'newTab' }
  | { type: 'closeTab' }
  | { type: 'toggleBrowser' }
  | { type: 'settings' }
  | { type: 'tab'; index: number }

/**
 * App-level shortcuts, chosen so they never collide with what the terminal
 * needs.
 *
 * macOS uses Cmd, which terminal programs leave alone. Windows and Linux
 * require Shift as well, because bare Ctrl+K / Ctrl+W / Ctrl+T are readline
 * bindings that Claude Code's own prompt uses.
 *
 * Matching is on `event.code` rather than `event.key` so that holding Shift
 * (which turns "," into "<") does not break the match.
 */
export function matchShortcut(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): ShortcutAction | null {
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary || e.altKey) return null

  const digit = /^Digit([1-9])$/.exec(e.code)
  if (digit && !e.shiftKey) return { type: 'tab', index: Number(digit[1]) }

  const gate = isMac ? !e.shiftKey : e.shiftKey
  if (!gate) return null

  switch (e.code) {
    case 'KeyK':
      return { type: 'palette' }
    case 'KeyT':
      return { type: 'newTab' }
    case 'KeyW':
      return { type: 'closeTab' }
    case 'KeyB':
      return { type: 'toggleBrowser' }
    case 'Comma':
      return { type: 'settings' }
    default:
      return null
  }
}

export function shortcutHint(isMac: boolean, key: string): string {
  return isMac ? `⌘${key.toUpperCase()}` : `Ctrl+Shift+${key.toUpperCase()}`
}
