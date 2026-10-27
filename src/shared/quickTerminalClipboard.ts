/**
 * The quick terminal's clipboard rules.
 *
 * QuickTerminal.tsx wires these into closures, and main wires two of them into
 * IPC handlers. A node suite can reach neither (gotcha 31), so every decision
 * lives here and verify:quick-terminal holds it. Cleaning a paste and reading a
 * chord's letter come from clipboardText.ts, which every terminal shares.
 * Pure, no `node:` or DOM imports (gotcha 27): main, the renderer and the suite
 * all load it.
 */
import { chordLetter, safePasteText } from './clipboardText.ts'
import type { ChordKey as ClipboardChordKey } from './clipboardText.ts'

/**
 * Whether a selection's text holds nothing visible, so copying it would only
 * replace the clipboard with blanks.
 *
 * Not just '': xterm trims each row to its last WRITTEN cell and joins the rows
 * with '\n' ('\r\n' on Windows), so a drag over two empty rows reads "\n". A
 * full-screen program (claude, vim) paints its blank area with written spaces,
 * which the trim keeps: measured on @xterm/headless 6.0, a row of ten written
 * spaces reads as ten spaces. Both used to count as text, so the copy replaced
 * the clipboard with blanks and a right-click copied instead of pasting.
 */
export function selectionIsBlank(text: string): boolean {
  return !/\S/.test(text)
}

/**
 * The most one quick-terminal write may carry. `QuickTerminal.write` drops a
 * bigger write whole, without a word.
 *
 * That cap is why pastes used to be cut short. xterm hands a paste to `onData`
 * as ONE string (bracketed, LF turned to CR), so main cut the clipboard to
 * 200,000 characters to keep the write under 256,000. The cut was silent and
 * could split a surrogate pair. Agent tabs have no such cap. The panel now
 * sends a long paste as several writes instead (`quickTerminalWrites`), so
 * nothing is cut.
 */
export const QUICK_TERMINAL_WRITE_MAX = 256_000

/**
 * `data` split into writes `QuickTerminal.write` accepts, in order. A cut never
 * falls between the two halves of a surrogate pair, so an emoji at the boundary
 * arrives whole.
 */
export function quickTerminalWrites(data: string, max: number = QUICK_TERMINAL_WRITE_MAX): string[] {
  if (data.length <= max) return [data]
  const parts: string[] = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(start + max, data.length)
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff && end - 1 > start) end--
    parts.push(data.slice(start, end))
    start = end
  }
  return parts
}

/**
 * The text main writes to the clipboard for a copy from the panel, or null for
 * no write at all.
 *
 * A blank selection is refused (`selectionIsBlank`): a selection of blank
 * cells reads as '', "\n" or spaces, because xterm's `hasSelection` compares
 * coordinates while `getSelection` trims. Writing it replaced the user's
 * clipboard with nothing. The panel already refuses it; this is the backstop
 * for any other sender. There is no length cap: agent
 * tabs have none (`CH.clipboardWrite`), and a select-all of the panel's 2,000
 * rows of scrollback at 150 columns is 300,000 characters. The old 200,000 cap
 * dropped that copy silently, so the next paste gave the OLD clipboard.
 */
export function quickTerminalCopyText(text: unknown): string | null {
  return typeof text === 'string' && !selectionIsBlank(text) ? text : null
}

/** What a paste types: the clipboard without the control characters a paste must not carry. */
export function quickTerminalPasteText(clip: unknown): string {
  return typeof clip === 'string' ? safePasteText(clip) : ''
}

/** What xterm reports about its selection: `getSelection()` and `hasSelection()`. */
export interface SelectionReading { text: string; any: boolean }

/**
 * Whether the panel stops a DOM copy event before xterm's own copy listener.
 * That covers Ctrl+Insert, which xterm leaves to Chromium, and Copy from a
 * menu. xterm's listener gates on `hasSelection` and writes the trimmed text,
 * so a blank-cell selection replaced the clipboard with ''. Stopped, the event
 * runs Chromium's default copy of the DOM selection instead. That selection is
 * xterm's empty textarea, so nothing is written (not driven).
 */
export function quickTerminalStopsCopy(selection: SelectionReading): boolean {
  return selection.any && selectionIsBlank(selection.text)
}

/** The keyboard event fields a chord is judged on: clipboardText's, plus the event type. */
export interface ChordKey extends ClipboardChordKey { type: string }

export type QuickTerminalKeyAction = { kind: 'copy'; text: string } | { kind: 'paste' } | { kind: 'swallow' } | { kind: 'pass' }
const PASS: QuickTerminalKeyAction = { kind: 'pass' }

/**
 * What a key does with the clipboard. 'pass' leaves the key to xterm.
 *
 * Cmd+C/V on macOS and Ctrl+Shift+C/V elsewhere. Bare Ctrl+C and Ctrl+V stay
 * the shell's interrupt and literal-next keys. The letter comes from
 * `chordLetter`, so a Cyrillic or Greek layout copies too. Testing `e.key`
 * alone missed it, and the key reached the shell instead. Alt chords pass, as
 * they do in hub remote tabs (`installTerminalClipboard`). With Option held,
 * `e.key` is another character, so the letter test never matched them before
 * either.
 *
 * Copy with a blank-cell selection swallows the key and writes nothing. If the
 * key passed instead, Chromium's own copy event would reach xterm's copy
 * listener, which gates on `hasSelection` and writes '' to the clipboard.
 * `selection` is read only for a copy chord.
 */
export function quickTerminalKey(e: ChordKey, isMac: boolean, selection: () => SelectionReading): QuickTerminalKeyAction {
  if (e.type !== 'keydown' || e.altKey) return PASS
  if (!(isMac ? e.metaKey : e.ctrlKey && e.shiftKey)) return PASS
  const letter = chordLetter(e)
  if (letter === 'v') return { kind: 'paste' }
  if (letter !== 'c') return PASS
  const { text, any } = selection()
  if (!selectionIsBlank(text)) return { kind: 'copy', text }
  return any || text ? { kind: 'swallow' } : PASS
}

/** 'ignore' is a contextmenu that belongs to a claimed Shift+Ctrl-drag (`QuickTerminalPresses`). */
export type QuickTerminalRightClick = { kind: 'copy'; text: string } | { kind: 'paste'; clear: boolean } | { kind: 'ignore' }

/**
 * What a right-click does: copy a selection, or else paste. A blank selection
 * (`selectionIsBlank`) is cleared and the click pastes, because copying it
 * would write blanks over the clipboard. Judged on the selection BEFORE xterm sees the click.
 * xterm's own right-click on macOS (`rightClickSelectsWord`) selects the word
 * under the pointer first. That is how a right-click came to copy that word
 * over the clipboard instead of pasting.
 */
export function quickTerminalRightClick(selection: SelectionReading): QuickTerminalRightClick {
  if (!selectionIsBlank(selection.text)) return { kind: 'copy', text: selection.text }
  return { kind: 'paste', clear: selection.any || selection.text !== '' }
}

/** The press fields `quickTerminalTakesPress` and `QuickTerminalPresses` read. */
export interface PressEvent { button: number; ctrlKey: boolean; shiftKey: boolean; isTrusted: boolean; defaultPrevented: boolean }

/**
 * Whether the panel takes a press before xterm sees it: a secondary click, its
 * mouseup and its contextmenu. Agent tabs do the same (TerminalView's
 * `onMouseDown`).
 *
 * With mouse reporting on (`claude`, vim with mouse=a), xterm sends the press
 * to the program, and Claude Code answers a right-click by pasting the
 * clipboard itself. The panel's own paste then landed as a second copy. So the
 * right-click is Stoke's alone, as it is in an agent tab. A macOS Ctrl+click
 * counts too: Chromium reports it as button 0 with ctrlKey (gotcha 28).
 *
 * Two presses are never taken (gotcha 34):
 * - the synthetic clone `installShiftSelection` dispatches. It is untrusted,
 *   and a Shift+Ctrl-drag's clone keeps ctrlKey.
 * - the original press that clone was made from. `installShiftSelection` has
 *   already called preventDefault on it.
 * Taking either one stopped that drag from selecting anything.
 */
export function quickTerminalTakesPress(e: PressEvent, isMac: boolean): boolean {
  if (!e.isTrusted || e.defaultPrevented) return false
  return e.button === 2 || (isMac && e.button === 0 && e.ctrlKey)
}

/**
 * The panel's pointer state between a press, its release and its contextmenu.
 * The panel's three capture listeners only ask it. A node suite can then drive
 * whole sequences, which it cannot do with the listeners themselves (gotcha 31).
 *
 * - `down` says whether to stop a mousedown. Every trusted press sets the state
 *   afresh. A press that is not taken clears `swallowed`, so a release that was
 *   ever lost cannot make the next left drag's mouseup be stopped. That is the
 *   gotcha-34 leak: xterm's document drag listeners outlive the drag. It is
 *   TerminalView's `swallowed = secondary && !e.defaultPrevented ? …` rule. The
 *   untrusted Shift-drag clone changes nothing.
 * - `up` says whether to stop a mouseup: only the release of a press `down`
 *   took.
 * - `context` decides a contextmenu. On macOS, Chromium sends a contextmenu for
 *   a Ctrl+left press even when the press was cancelled. A Shift+Ctrl-drag is
 *   such a press: `installShiftSelection` cancels it and starts the selection
 *   from its clone. Its contextmenu then found no selection yet and pasted the
 *   clipboard into the shell. Before the right-click was Stoke's, xterm selected
 *   the word under it and Stoke copied it over the clipboard. So the
 *   contextmenu of a claimed drag does nothing (not driven: it rests on
 *   Chromium's behaviour on macOS). On macOS the menu comes on the PRESS, so a
 *   release ends the claim, and a later menu-key contextmenu still acts.
 *
 * No parameter properties (strip-types): fields are assigned in the constructor.
 */
export class QuickTerminalPresses {
  isMac: boolean
  /** The button whose press was taken, so its release is stopped too; null when the last press went through. */
  swallowed: number | null
  /** The last press was a Shift+Ctrl-drag `installShiftSelection` claimed on macOS, and its contextmenu has not come yet. */
  claimedDrag: boolean
  constructor(isMac: boolean) {
    this.isMac = isMac
    this.swallowed = null
    this.claimedDrag = false
  }

  down(e: PressEvent): boolean {
    const take = quickTerminalTakesPress(e, this.isMac)
    if (!e.isTrusted) return take
    this.swallowed = take ? e.button : null
    this.claimedDrag = this.isMac && e.defaultPrevented && e.button === 0 && e.ctrlKey && e.shiftKey
    return take
  }

  up(e: { button: number }): boolean {
    this.claimedDrag = false
    if (this.swallowed === null || e.button !== this.swallowed) return false
    this.swallowed = null
    return true
  }

  context(selection: SelectionReading): QuickTerminalRightClick {
    if (this.claimedDrag) {
      this.claimedDrag = false
      return { kind: 'ignore' }
    }
    return quickTerminalRightClick(selection)
  }
}
