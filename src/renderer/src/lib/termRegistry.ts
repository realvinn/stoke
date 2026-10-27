import type { Terminal } from '@xterm/xterm'
import { bufferRows, joinBufferRows, type ClipboardChord } from '@shared/clipboardText'

/**
 * The live terminals, so anything outside a TerminalView can read one.
 *
 * xterm draws through WebGL, so `.xterm-rows` is empty and the screen is
 * readable only from the Terminal object (CLAUDE.md gotcha 5). The tab snapshot
 * needs exactly that, for every tab at once, which is why this is a registry
 * rather than a prop.
 */
const terms = new Map<string, Terminal>()

/*
 * Also published on `window` for a CDP probe. xterm draws through WebGL, so
 * `.xterm-rows` is empty and nothing about what the terminal renders is
 * readable from the DOM (gotcha 5): cell widths, the active Unicode version
 * and the cursor column are only readable from the Terminal object, and a
 * probe has no other route to it. Nothing in the app reads this; the suites
 * and `scripts/cdp-eval.mjs` do, against release builds too, which is why it
 * is not gated on a dev flag. TerminalView used to keep a second copy.
 */
;(window as unknown as { stokeTerminals?: Map<string, Terminal> }).stokeTerminals = terms

export function registerTerm(ptyId: string, term: Terminal): void {
  terms.set(ptyId, term)
}

export function unregisterTerm(ptyId: string): void {
  terms.delete(ptyId)
}

/**
 * The size a new pty should START at: this pty's terminal if it is still
 * mounted (a reconnect's dead tab), else any live one — every pane shares the
 * one terminal area — else null for the caller's default.
 *
 * For a kept SSH tab this is not cosmetic (gotcha 126): tmux resizes the
 * session to the size the reattaching client starts at, BEFORE the terminal's
 * own fit arrives, and a start taller than the session was pulls lines back out
 * of tmux's history that the reconnect has just printed — each one shown twice.
 */
export function termSizeHint(ptyId?: string): { cols: number; rows: number } | null {
  const own = ptyId ? terms.get(ptyId) : undefined
  const term = own ?? terms.values().next().value
  return term ? { cols: term.cols, rows: term.rows } : null
}

/**
 * Put the caret back in a terminal, from outside its TerminalView.
 *
 * For the unclaimed-keystroke route in App (`typeThroughKey`): once a chrome
 * control has taken focus, every later keystroke is delivered to a button
 * unless something moves it back, and App has no ref to the terminal. Silent
 * when the id is not registered, which is the ordinary case for a paused or
 * exited tab.
 */
export function focusTerm(ptyId: string): void {
  terms.get(ptyId)?.focus()
}

/*
 * The find bar of the terminal in front, for whatever opens it from outside its
 * TerminalView: App's Cmd+F / Ctrl+Shift+F, the command palette's row, and the
 * docked browser's own Cmd+F listener asking whether a terminal would take the
 * chord (`findOwner`). A pane registers only while it is the one shown, so
 * "the find bar" never means a background tab's.
 */
const finders = new Map<string, () => void>()

/** Register `open` as the find bar of the pane in front; returns the unregister. */
export function registerFinder(ptyId: string, open: () => void): () => void {
  finders.set(ptyId, open)
  return () => {
    if (finders.get(ptyId) === open) finders.delete(ptyId)
  }
}

/** Whether a terminal is in front with a find bar to open. */
export function hasActiveFinder(): boolean {
  return finders.size > 0
}

/*
 * Each terminal's own copy and paste, for a chord pressed OUTSIDE it: App's
 * unclaimed-key route (`chromeTakesChord`) after a click left focus on a chrome
 * button. Registered per pty with the key handler's own action, so a paste
 * from there takes exactly the route Cmd/Ctrl+V takes in the terminal — files,
 * images, cleaned text. The answer is the key handler's: `take` means it acted
 * (the caller cancels the key); anything else means it would have left the key
 * to xterm or the browser, which from a button reaches neither.
 */
export type ClipboardKeyVerdict = 'take' | 'xterm' | 'browser'
const clipboardKeys = new Map<string, (chord: ClipboardChord) => ClipboardKeyVerdict>()

/** Register a terminal's clipboard-chord action; returns the unregister. */
export function registerClipboardKeys(ptyId: string, run: (chord: ClipboardChord) => ClipboardKeyVerdict): () => void {
  clipboardKeys.set(ptyId, run)
  return () => {
    if (clipboardKeys.get(ptyId) === run) clipboardKeys.delete(ptyId)
  }
}

/** Run a clipboard chord in the terminal on `ptyId`; null when none is mounted. */
export function runClipboardKeys(ptyId: string, chord: ClipboardChord): ClipboardKeyVerdict | null {
  return clipboardKeys.get(ptyId)?.(chord) ?? null
}

/** Open (or re-focus) the find bar of the terminal in front; false when there is none. */
export function openActiveFinder(): boolean {
  const open = [...finders.values()].pop()
  if (!open) return false
  open()
  return true
}

/**
 * The visible viewport as plain text, trailing blank lines dropped.
 *
 * The viewport rather than the buffer: it is what the user was looking at, and
 * on a byobu tab running Claude Code it is all there is anyway — that pane is on
 * the alternate screen, so no scrollback exists on either side (gotcha 29).
 *
 * `translateToString(true)` trims each line's trailing blanks, which is the
 * difference between a screen and a screen padded to 200 columns.
 *
 * Row for row by default: the tab snapshot draws it back as a ghost of the
 * screen (`.paused-screen`, `white-space: pre`), where a joined line would run
 * off the card and every row under it would move up. `joinWrapped` is for TEXT
 * someone takes away (Copy screen): a soft-wrapped row continues the line above
 * it (`joinBufferRows`), so a long URL or command printed at a shell comes back
 * whole instead of with a newline at the pane's width.
 */
export function screenOf(ptyId: string, opts: { joinWrapped?: boolean } = {}): string {
  const term = terms.get(ptyId)
  if (!term) return ''
  const buf = term.buffer.active
  if (opts.joinWrapped) return joinBufferRows(bufferRows(buf, buf.viewportY, buf.viewportY + term.rows)).replace(/\n+$/, '')
  const lines: string[] = []
  for (let row = 0; row < term.rows; row++) {
    lines.push(buf.getLine(buf.viewportY + row)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}
