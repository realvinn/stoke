export type ShortcutAction =
  | { type: 'palette' }
  | { type: 'newTab' }
  | { type: 'closeTab' }
  | { type: 'toggleBrowser' }
  | { type: 'settings' }
  | { type: 'tab'; index: number }
  | { type: 'zoom'; direction: -1 | 0 | 1 }

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
 *
 * The digit shortcuts are the exception to the Shift rule: Ctrl+1..9 are not
 * readline bindings, so they need no Shift on any platform and are rejected
 * when it is held. Anything that renders these as text has to special-case
 * them — a hint helper that printed "Ctrl+Shift+" for every binding shipped
 * here once, unused and wrong for exactly the digits, and was deleted.
 */
export function matchShortcut(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): ShortcutAction | null {
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary || e.altKey) return null

  const digit = /^Digit([1-9])$/.exec(e.code)
  if (digit && !e.shiftKey) return { type: 'tab', index: Number(digit[1]) }

  /*
   * Zoom, and the second exception to the Shift rule below — a stronger one than
   * the digits, because there Shift is merely unnecessary and here it is
   * actively harmful.
   *
   * Ctrl+Shift+`-` is Ctrl+`_`, and xterm turns exactly that into `C0.US`
   * (`Keyboard.ts:361-364`: `if (ev.key === '_') result.key = C0.US`), which is
   * readline's undo and something Claude Code's prompt uses. Binding the Shift
   * variant would swallow it. Bare Ctrl+`-` and Ctrl+`=` match neither branch
   * there, so the terminal does nothing with them at all — which is what makes
   * them free to take, and is also why every other app on both platforms already
   * uses them for this.
   *
   * Zoom-in accepts Shift and zoom-out does not, which looks asymmetric and is
   * not: `+` IS Shift+`=` on most layouts, so someone pressing "Cmd and plus" is
   * holding Shift whether they think about it or not. Refusing that would reject
   * the gesture people actually make. `-` needs no Shift to type, so requiring
   * its absence costs nothing and keeps `^_` reaching the terminal.
   *
   * Placed before the gate because zoom needs no Shift on any platform.
   */
  switch (e.code) {
    case 'Equal':
    case 'NumpadAdd':
      return { type: 'zoom', direction: 1 }
    case 'Minus':
    case 'NumpadSubtract':
      if (!e.shiftKey) return { type: 'zoom', direction: -1 }
      break
    case 'Digit0':
    case 'Numpad0':
      if (!e.shiftKey) return { type: 'zoom', direction: 0 }
      break
  }

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
