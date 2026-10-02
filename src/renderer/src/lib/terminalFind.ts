/**
 * The find bar's rules that are not drawing: which find a Cmd+F opens, what the
 * count line says, how a hit is labelled. Pure, and imports only `src/shared`
 * by relative `.ts` path (gotcha 78), so `verify:find` runs it as it ships.
 */
import type { FindConsent, FindRole, TranscriptFindResult } from '../../../shared/transcriptFind.ts'

/* ------------------------------------------------- a key pressed in the bar */

/**
 * What the bar does with a key pressed anywhere inside it, before the key can
 * bubble on to App's window listener.
 *
 * That listener hands every key nobody claimed to the terminal in front
 * (`typeThroughKey`), and it refuses only text fields — a focused BUTTON is
 * exactly the case it was written for (a click on a chip leaves focus there).
 * In the bar that was a trap, found driving the built app on 2026-10-02: click
 * Aa and go on typing the query, and the letters landed in Claude's prompt; Tab
 * to Copy message and press Enter, and the Enter was written to the pty — it
 * SUBMITTED the prompt — instead of pressing the button. So:
 *
 * - `close`: Escape, from the input or any control.
 * - `chord`: anything with Ctrl, Cmd or Alt goes on to App, so Cmd+F still
 *   re-focuses the bar and Cmd+K, Cmd+W and the rest still work.
 * - `type`: a printable character or Backspace on one of the bar's controls is
 *   the query being edited: it goes into the input (`typedInto`).
 * - `keep`: every other plain key stays in the bar — Enter and Space press the
 *   focused button natively, Tab moves between controls, the input takes its own.
 */
export type BarKey = 'close' | 'chord' | 'type' | 'keep'

export function barKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, onInput: boolean): BarKey {
  if (e.key === 'Escape') return 'close'
  if (e.ctrlKey || e.metaKey || e.altKey) return 'chord'
  if (onInput) return 'keep'
  if (e.key === 'Backspace') return 'type'
  // One code point is a character (an astral one too); a name ("Enter") is not.
  // Space is a button's own key, so it presses the control rather than typing.
  return [...e.key].length === 1 && e.key !== ' ' ? 'type' : 'keep'
}

/** The query after a `type` key pressed on one of the bar's controls. */
export function typedInto(query: string, key: string): string {
  return key === 'Backspace' ? [...query].slice(0, -1).join('') : query + key
}

/**
 * The host answer to send with the NEXT search, given the one just sent.
 * "Just this once" holds for the bar's life: every search re-copies under it.
 * "Allow for this host" is recorded by main on the request that carries it, so
 * it is sent once and then dropped — kept, it re-ticked the host on the next
 * letter typed after the user unticked it in Settings with the bar still open.
 */
export function consentAfterSend(sent: FindConsent | null): FindConsent | null {
  return sent === 'once' ? 'once' : null
}

/* ------------------------------------------------- stepping on the screen */

/** A move of the screen engine: as the query is typed, or one match older or newer. */
export type ScreenStep = 'incremental' | 'older' | 'newer'

/**
 * Which SearchAddon call a screen step is. Newest first, as the conversation
 * half lists its hits: with no selection `findNext` starts at row 0 — the
 * OLDEST line of up to 20,000 of scrollback — so typing the first letter of a
 * query threw the viewport to the top of the history and left it there, and
 * the first match was the earliest one rather than the one "a bit back up".
 * Measured in the built app on 2026-10-02: viewport at row 115 of 115, type
 * "stub line 1", and the selection landed on row 0, "1 of 62". `findPrevious`
 * starts at the bottom and walks up, which is also what Enter does after it.
 */
export function screenCall(step: ScreenStep): 'findPrevious' | 'findNext' {
  return step === 'newer' ? 'findNext' : 'findPrevious'
}

/* --------------------------------------------------------- who takes Cmd+F */

/** Where a key event landed, read off the DOM by `findTargetOf`. */
export interface FindTarget {
  /** Inside the docked browser panel's own chrome (its address bar, its find box). */
  inBrowser: boolean
  /** Inside a terminal pane. */
  inTerminal: boolean
}

/** Anything with `closest`, so the suite can hand in a fake element. */
export function findTargetOf(target: unknown): FindTarget {
  const el = target as { closest?: (sel: string) => unknown } | null
  if (!el || typeof el.closest !== 'function') return { inBrowser: false, inTerminal: false }
  return { inBrowser: !!el.closest('section.browser'), inTerminal: !!el.closest('.term-pane') }
}

export interface FindOwnerInput extends FindTarget {
  /** The chord is the terminal's (`matchShortcut` says `find`). */
  terminalChord: boolean
  /** The chord is the docked browser's page find (primary + F, no Alt). */
  pageChord: boolean
  /** A terminal is in front with a find bar (`hasActiveFinder`). */
  terminalShown: boolean
  browserOpen: boolean
}

/**
 * Which find a find chord opens. Focus decides: in the browser panel's chrome,
 * the page's; anywhere else, the terminal's when one is in front; and the
 * page's from elsewhere only when no terminal would take it. On macOS the two
 * share Cmd+F, which is why this exists — the browser panel's window listener
 * used to open the PAGE find bar from any focus, the terminal included. Off
 * macOS they are different chords (Ctrl+F the page, Ctrl+Shift+F the
 * terminal), and a bare Ctrl+F inside a terminal is the CLI's, never a find.
 * App and the browser panel both ask this, so exactly one of them acts.
 */
export function findOwner(i: FindOwnerInput): 'terminal' | 'page' | null {
  if (!i.terminalChord && !i.pageChord) return null
  if (i.inBrowser) return i.browserOpen ? 'page' : null
  if (i.terminalChord && i.terminalShown) return 'terminal'
  if (i.inTerminal && i.terminalShown) return null
  return i.pageChord && i.browserOpen ? 'page' : null
}

/* ----------------------------------------------------------- the count line */

/**
 * The screen half of the count: "2 of 7 on screen". "On screen" on the
 * alternate buffer (a fullscreen TUI: what is visible is all xterm has), "in
 * the terminal" on the normal one, which has scrollback too. `index` is -1
 * when the addon is past its highlight limit and cannot say which one.
 */
export function screenCountLabel(count: number, index: number, buffer: 'normal' | 'alternate'): string {
  const where = buffer === 'alternate' ? 'on screen' : 'in the terminal'
  if (count === 0) return `None ${where}`
  if (index < 0) return `${count}+ ${where}`
  return `${index + 1} of ${count} ${where}`
}

/** The conversation half: "12 in the conversation", or why there is none. */
export function conversationCountLabel(result: TranscriptFindResult | null, busy: boolean): string | null {
  if (!result) return busy ? 'Searching the conversation…' : null
  if (!result.ok) return null
  if (result.total === 0) return 'None in the conversation'
  return `${result.total} in the conversation`
}

/** How a hit's author is named on its card. */
export function roleLabel(role: FindRole, tool: string | null, isError: boolean): string {
  switch (role) {
    case 'user':
      return 'You'
    case 'assistant':
      return 'Claude'
    case 'tool-call':
      return tool ? `${tool} call` : 'Tool call'
    case 'tool-output':
      return `${tool ? `${tool} output` : 'Tool output'}${isError ? ' (error)' : ''}`
  }
}

/* ------------------------------------------------------------ the palette */

export const FIND_PALETTE_LABEL = 'Find in this conversation'
const FIND_PALETTE_WORDS = ['find', 'search', 'conversation', 'scrollback', 'terminal', 'transcript', 'text']

/**
 * Whether the palette's query asks for the find row, and where to mark its
 * label. Every word of the query must start a word of the label or one of its
 * keywords; an empty query does not list it (the palette's empty list is
 * projects).
 */
export function paletteFindMatch(query: string): [number, number][] | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const label = FIND_PALETTE_LABEL.toLowerCase()
  const ranges: [number, number][] = []
  for (const w of words) {
    let at = -1
    for (let i = label.indexOf(w); i >= 0; i = label.indexOf(w, i + 1)) {
      if (i === 0 || label[i - 1] === ' ') {
        at = i
        break
      }
    }
    if (at >= 0) ranges.push([at, at + w.length])
    else if (!FIND_PALETTE_WORDS.some((k) => k.startsWith(w))) return null
  }
  // Sorted and merged: `Highlight` takes non-overlapping ranges ("find fin").
  const merged: [number, number][] = []
  for (const [s, e] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  return merged
}
