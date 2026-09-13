export type ShortcutAction =
  | { type: 'palette' }
  | { type: 'newTab' }
  | { type: 'closeTab' }
  | { type: 'toggleBrowser' }
  | { type: 'settings' }
  | { type: 'tab'; index: number }
  | { type: 'cycleTab'; delta: -1 | 1 }
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

  /*
   * Next / previous tab, and the third exception to the Shift rule — this one
   * needs Shift on BOTH platforms, which no other chord here does.
   *
   * The obvious binding is Ctrl+Tab, and it cannot be used. xterm's Tab branch
   * consults `shiftKey` and nothing else (`Keyboard.ts`: shift gives CBT,
   * otherwise C0.HT), so Ctrl+Tab sends a literal tab to the pty — and it does
   * it from xterm's own listener on the textarea, which runs at target phase,
   * before this window listener ever sees the event. Preventing the default
   * afterwards is too late: `triggerDataEvent` has already fired. Every chord
   * in this file is safe precisely because xterm ignores it, and Ctrl+Tab is
   * not one of those.
   *
   * `⇧⌘]` / `Ctrl+Shift+]` is. On macOS it carries Meta, which xterm's
   * `evaluateKeyboardEvent` never acts on; off macOS the bracket keys are in
   * the same `ctrlKey && !shiftKey` branch as the letters (keyCode 221 -> GS),
   * so holding Shift takes them out of it exactly as it does for Ctrl+K. It is
   * also what Safari, Chrome and VS Code already use on the Mac, so the
   * gesture is one people have.
   *
   * Before the gate below, because that gate REFUSES Shift on macOS and this
   * chord requires it.
   */
  if (e.shiftKey) {
    if (e.code === 'BracketRight') return { type: 'cycleTab', delta: 1 }
    if (e.code === 'BracketLeft') return { type: 'cycleTab', delta: -1 }
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

/** Every chord this file binds that something on screen advertises. */
export type ChordName =
  | 'palette'
  | 'newTab'
  | 'closeTab'
  | 'toggleBrowser'
  | 'settings'
  | 'nextTab'
  | 'prevTab'

const CHORD_KEY: Record<ChordName, string> = {
  palette: 'K',
  newTab: 'T',
  closeTab: 'W',
  toggleBrowser: 'B',
  settings: ',',
  nextTab: ']',
  prevTab: '['
}

/**
 * The chord as the user in front of this machine would actually type it.
 *
 * It lives here, beside `matchShortcut`, because the two cannot be allowed to
 * drift: every tooltip in the title bar said "Ctrl/Cmd+T", which is right on
 * macOS and wrong on the other two platforms — off macOS the letter chords all
 * require Shift, for the readline reason `matchShortcut` documents, so the app
 * was telling Windows and Linux users to press a key combination that does
 * nothing and reaches the CLI's prompt instead. A slash between two platforms'
 * modifiers cannot express a per-platform Shift, so it is derived rather than
 * written out.
 *
 * Mac order is Apple's own — ⌃⌥⇧⌘ — so Shift precedes Command.
 */
export function chordLabel(name: ChordName, isMac: boolean): string {
  const cycles = name === 'nextTab' || name === 'prevTab'
  // Shift on every letter chord off macOS, and on the cycle pair everywhere.
  const shift = cycles || !isMac
  return isMac ? `${shift ? '\u21e7' : ''}\u2318${CHORD_KEY[name]}` : `Ctrl+${shift ? 'Shift+' : ''}${CHORD_KEY[name]}`
}

/* -------------------------------------------------- typing through the chrome */

/**
 * What a keystroke aimed at nothing in particular should send to the terminal.
 *
 * The bug this exists for: click the usage chip, close it, start typing, and
 * the characters go nowhere. They are not lost to a bug in the chip — they are
 * delivered correctly to a `<button>`, which does nothing with them. Every
 * control in the chrome has the same shape, so fixing the chip would leave the
 * tab strip, the status bar and the next control anyone adds still broken. The
 * only fix that stays fixed is a rule about where unclaimed keystrokes go.
 *
 * Pure, and separated from the listener that calls it, because the interesting
 * part is entirely in what it REFUSES. Returning a character that should have
 * gone somewhere else is worse than dropping one: it types into the user's
 * shell behind their back.
 *
 * Refused, and each for its own reason:
 *   - anything with Ctrl, Meta or Alt. Those are chords, and `matchShortcut`
 *     above owns them — routing them here as text would send raw letters to the
 *     pty for every shortcut the app does not happen to bind (gotcha 56).
 *   - anything typed into a real editable: an input, a textarea, a select, a
 *     contenteditable, or xterm's own hidden textarea. Those already work, and
 *     this must never double-deliver.
 *   - anything while an overlay owns the screen. The palette and the settings
 *     sheet have their own fields and their own Escape.
 *   - every named key except Enter and Backspace. `key` is a single character
 *     for printable input and a word for everything else, so length is the test;
 *     Tab, Escape, the arrows and the function keys all have meanings out here.
 *   - Enter with no terminal, which would otherwise mean "run whatever is in
 *     the shell I cannot see".
 *
 * Returns the exact bytes to write, so the caller neither builds nor guesses
 * them: `\r` for Enter (the terminal wants a carriage return, not `\n`) and
 * `\x7f` for Backspace (DEL, which is what a real terminal sends).
 */
export function typeThroughKey(
  e: {
    key: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    /** The element the event was delivered to. */
    target: { tagName?: string; isContentEditable?: boolean } | null
  },
  ctx: { overlayOpen: boolean; hasTerminal: boolean }
): string | null {
  if (!ctx.hasTerminal || ctx.overlayOpen) return null
  if (e.ctrlKey || e.metaKey || e.altKey) return null

  const tag = (e.target?.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null
  if (e.target?.isContentEditable === true) return null

  if (e.key === 'Enter') return '\r'
  if (e.key === 'Backspace') return '\x7f'
  // A printable character is exactly one code point; everything else is a name.
  // `[...key].length` rather than `key.length` so an astral character (an emoji
  // from a picker) counts as one rather than two.
  if ([...e.key].length !== 1) return null
  return e.key
}
