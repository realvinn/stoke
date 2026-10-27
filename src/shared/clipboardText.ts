/**
 * Text going into and out of a terminal through the clipboard.
 *
 * Shared by the desktop terminal, the quick terminal, hub remote tabs and the
 * phone/web UI so all of them clean pastes, match chords and copy wrapped rows
 * by one rule. Pure, no `node:` or DOM imports (gotcha 27): both tsconfigs and
 * the node suites load it.
 */

/**
 * Control characters a paste may carry: TAB, LF and CR only.
 *
 * xterm.js wraps a paste in ESC[200~ … ESC[201~ (bracketed paste) as is, so a
 * clipboard holding its own ESC[201~ ended the bracket early and everything
 * after it reached the program as TYPED keys, the next CR submitting it. Any
 * web page can put such text on the clipboard, and so can any program a tab
 * prints through OSC 52. Alacritty, VTE and foot strip escapes from pastes
 * for the same reason. Removed: C0 (except the three), DEL and C1.
 */
const PASTE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** `text` with every control character a paste must not carry removed. */
export function safePasteText(text: string): string {
  return text.replace(PASTE_CONTROLS, '')
}

/** Whether cleaning `text` would change it (for a note that something was left out). */
export function pasteNeedsCleaning(text: string): boolean {
  PASTE_CONTROLS.lastIndex = 0
  const hit = PASTE_CONTROLS.test(text)
  PASTE_CONTROLS.lastIndex = 0
  return hit
}

/**
 * The letter a copy/paste chord was pressed on, whatever the keyboard layout.
 *
 * `e.key` is the CHARACTER: on a Cyrillic, Greek, Hebrew or Arabic layout
 * Ctrl+C reports `с`, `ψ`, `ב`… so a `key === 'c'` test missed it and xterm sent
 * ^C (it keys bare Ctrl by keyCode) — an interrupt instead of a copy. `e.code`
 * is the physical key. A Latin `e.key` wins, so Dvorak and AZERTY users keep
 * the letter printed on their key.
 *
 * Only a single LETTER of another script falls back to the position. Anything
 * else is what the key typed and stays itself: a Latin letter with a mark
 * (Polish AltGr+Shift+C is `Ć`, and Windows reports AltGr as Ctrl+Alt, so a
 * fallback read it as a Ctrl+Shift copy and ate the letter), punctuation
 * (BÉPO's `.` sits on the V key) and macOS Cmd+Option's `ç` / `√`.
 */
export function chordLetter(e: { key: string; code?: string }): string {
  const key = e.key.toLowerCase()
  if (/^[a-z]$/.test(key)) return key
  if (!/^\p{L}$/u.test(e.key) || /\p{Script=Latin}/u.test(e.key)) return key
  const m = /^Key([A-Z])$/.exec(e.code ?? '')
  return m ? m[1].toLowerCase() : key
}

/**
 * Whether a selection's text holds anything to copy. xterm trims blank cells
 * but joins the selected rows with a line break (`\r\n` on Windows), so a drag
 * across two blank rows reads `"\n"`, not `""` — and copying that wiped the
 * clipboard just as copying `""` did. Blank is blank, whatever joins it.
 */
export function selectionHasText(text: string): boolean {
  return /\S/.test(text)
}

/** One buffer row, as xterm's IBufferLine reports it. */
export interface BufferRow {
  /** `translateToString(false)`: the row untrimmed, so a space at the wrap point survives. */
  text: string
  /** True when this row continues the one above (a soft wrap, not a newline). */
  isWrapped: boolean
}

/**
 * Rows joined the way they were written: a soft-wrapped row continues the line
 * above it rather than starting a new one, and each logical line loses only its
 * trailing blanks. A long URL or command copied from the screen therefore comes
 * back in one piece instead of split at the terminal's width.
 */
export function joinBufferRows(rows: readonly BufferRow[]): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.isWrapped && lines.length) lines[lines.length - 1] += row.text
    else lines.push(row.text)
  }
  return lines.map((line) => line.replace(/\s+$/, '')).join('\n')
}

/** One xterm cell, as much of IBufferCell as `bufferRows` reads. */
interface CellLike {
  getChars(): string
  getWidth(): number
}

/** One xterm row, as much of IBufferLine as `bufferRows` reads. */
interface LineLike {
  translateToString(trimRight?: boolean): string
  isWrapped: boolean
  length?: number
  getCell?(x: number): CellLike | undefined
}

/**
 * Whether `line`'s last cell is only the gap a wide character left: xterm
 * moves a CJK character or an emoji that does not fit in the last column to
 * the next row and leaves an empty cell behind, which `translateToString`
 * spells as a space. Joined as it is, "…末" copied back as "… 末".
 */
function padsWideWrap(line: LineLike, next: LineLike | undefined): boolean {
  if (!next?.isWrapped || !line.getCell || !next.getCell || !line.length) return false
  const last = line.getCell(line.length - 1)
  const first = next.getCell(0)
  return !!last && !!first && last.getChars() === '' && last.getWidth() === 1 && first.getWidth() === 2
}

/** The rows `from` (inclusive) to `to` (exclusive) of an xterm buffer, as BufferRows. */
export function bufferRows(buffer: { getLine(y: number): LineLike | undefined }, from: number, to: number): BufferRow[] {
  const rows: BufferRow[] = []
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y)
    let text = line?.translateToString(false) ?? ''
    if (line && padsWideWrap(line, buffer.getLine(y + 1))) text = text.slice(0, -1)
    rows.push({ text, isWrapped: line?.isWrapped === true })
  }
  return rows
}

/* ------------------------------------------------------- pasting, safely */

/**
 * Paste `text` into a terminal with the controls a paste must not carry left
 * out (`safePasteText`), through xterm's own `paste` so the bracket and the
 * CRLF rewrite are still xterm's. Every desktop paste of text that came from
 * outside the terminal goes through here: the clipboard, a drop, dictation, a
 * far path. Returns true when something was left out, for a note.
 */
export function pasteSafely(term: { paste(data: string): void }, text: string): boolean {
  const clean = safePasteText(text)
  if (clean) term.paste(clean)
  return clean !== text
}

/**
 * The largest OSC 52 payload Stoke will put on the clipboard, in base64
 * characters. A terminal write is untrusted input — anything the far machine
 * renders can ask for the clipboard — so the sequence is bounded rather than
 * trusted to be a sane size.
 */
export const MAX_OSC52_BASE64 = 200_000

/**
 * What an OSC 52 sequence's data (`<Pc>;<Pd>`) puts on the clipboard, or null
 * for nothing: no `;`, an empty payload, the `?` READ (refused, gotcha 29),
 * one past `MAX_OSC52_BASE64`, base64 that does not decode, or text with
 * nothing left once cleaned.
 *
 * Cleaned with `safePasteText` before it is written, because the clipboard is
 * where a paste comes from: anything a tab prints — a `cat`ed README, a web
 * page curl'd to the screen — could otherwise plant `ESC[201~` plus a command
 * on it, and the next Cmd+V anywhere would end its bracket early and run the
 * command as typed keys. `cleaned` says something was left out.
 */
export function osc52Write(data: string): { text: string; cleaned: boolean } | null {
  const semi = data.indexOf(';')
  // `Pc` selects the clipboard and is ignored; Stoke has one.
  if (semi < 0) return null
  const payload = data.slice(semi + 1)
  if (!payload || payload === '?' || payload.length > MAX_OSC52_BASE64) return null
  let decoded: string
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    decoded = new TextDecoder().decode(bytes)
  } catch {
    // Not valid base64: the sequence is malformed, so it is dropped.
    return null
  }
  const text = safePasteText(decoded)
  return text ? { text, cleaned: text !== decoded } : null
}

/* -------------------------------------------------------------- the chords */

/**
 * A copy or paste chord, by how it was pressed. `cmd` is macOS's Cmd;
 * `ctrl-shift` is Ctrl+Shift on any platform; `ctrl` is bare Ctrl — a copy or
 * paste only off macOS, and on macOS only Ctrl+V, which is Claude Code's own
 * image chord there (an SSH tab sends the image, `pasteAction`).
 */
export interface ClipboardChord {
  op: 'copy' | 'paste'
  via: 'cmd' | 'ctrl-shift' | 'ctrl'
}

/** The parts of a KeyboardEvent a chord is read from. */
export interface ChordKey {
  key: string
  code?: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * Which clipboard chord a keydown is, or null. The letter is `chordLetter`'s,
 * so a Cyrillic or Greek layout's Ctrl+C is still a copy rather than xterm's
 * ^C (it keys bare Ctrl by keyCode), and Ctrl+V still a paste.
 */
export function clipboardChord(e: ChordKey, isMac: boolean): ClipboardChord | null {
  const letter = chordLetter(e)
  if (letter !== 'c' && letter !== 'v') return null
  const op = letter === 'c' ? 'copy' : 'paste'
  if (e.ctrlKey && e.shiftKey) return { op, via: 'ctrl-shift' }
  if (isMac && e.metaKey && !e.ctrlKey) return { op, via: 'cmd' }
  if (!e.ctrlKey || e.shiftKey || e.altKey) return null
  if (!isMac) return { op, via: 'ctrl' }
  return op === 'paste' && !e.metaKey ? { op, via: 'ctrl' } : null
}

/**
 * What a copy chord does with the terminal's selection.
 *
 * - `copy`: write it. `copy-clear` also clears it, for bare Ctrl+C off macOS,
 *   so a second press interrupts — a selection left lying around would
 *   otherwise stop Ctrl+C reaching Claude, the most pressed key in the app.
 * - `swallow` / `swallow-clear`: cells are selected but all blank
 *   (`hasSelection` true, the text "" — or only the line breaks between blank
 *   rows, `selectionHasText`). Copying nothing must neither wipe the
 *   clipboard with "" nor, for bare Ctrl+C, send ^C to a prompt someone is
 *   looking at a highlight in.
 * - `xterm`: nothing selected — the key is xterm's (^C, SIGINT).
 * - `browser`: nothing selected and Cmd+C: neither xterm nor Stoke acts, and the
 *   Edit menu's copy finds nothing to copy.
 */
export type CopyAction = 'copy' | 'copy-clear' | 'swallow' | 'swallow-clear' | 'xterm' | 'browser'

export function copyAction(chord: ClipboardChord, selection: string, hasSelection: boolean): CopyAction {
  const bare = chord.via === 'ctrl'
  if (selectionHasText(selection)) return bare ? 'copy-clear' : 'copy'
  if (hasSelection) return bare ? 'swallow-clear' : 'swallow'
  return chord.via === 'cmd' ? 'browser' : 'xterm'
}

/** What a peek at the clipboard says is on it (`ClipboardPeek`). */
export interface ClipboardContents {
  text: string
  hasImage: boolean
  files: number
}

/**
 * What a paste chord does with what is on the clipboard.
 *
 * - `upload-files`: files a file manager copied, sent to an SSH tab's machine
 *   and their far paths typed (gotcha 152).
 * - `type-paths`: the same files' full LOCAL paths typed, as a drop types
 *   them — where Finder also puts the bare names on as text, which name
 *   nothing in the session's folder, and Explorer puts no text at all.
 * - `text`: the text, cleaned (`pasteSafely`).
 * - `image`: an image-only clipboard handed over — sent to an SSH tab's
 *   machine, or the agent's own paste key on a local tab (`imagePasteKeys`).
 * - `xterm-image`: the key left to xterm, whose ^V IS the agent's image paste;
 *   it puts an image in the prompt, so it counts as a draft.
 * - `xterm`: the key left to xterm.
 * - `nothing`: the chord taken, nothing to paste.
 *
 * Text wins over an image when the clipboard carries both, which is what
 * copying rich content from a page produces; an image-only clipboard is
 * handed to the agent, which reads it off the OS clipboard itself on its paste
 * key, so no image bytes cross the pty (an SSH tab sends it instead).
 *
 * Bare Ctrl+V on macOS is Claude Code's image chord, so there it hands over
 * only what xterm's ^V cannot reach — an SSH tab's image or files, since the
 * far `claude` reads the far clipboard — and leaves text to ^V (vim's visual
 * block, readline's quoted insert).
 */
export type PasteAction = 'upload-files' | 'type-paths' | 'text' | 'image' | 'xterm-image' | 'xterm' | 'nothing'

export function pasteAction(
  chord: ClipboardChord,
  clip: ClipboardContents,
  ctx: { isMac: boolean; uploads: boolean; imageKey: string }
): PasteAction {
  if (chord.via === 'ctrl' && ctx.isMac) {
    if (ctx.uploads && clip.files > 0) return 'upload-files'
    if (ctx.uploads && clip.hasImage && !clip.text) return 'image'
    return clip.hasImage ? 'xterm-image' : 'xterm'
  }
  if (clip.files > 0) return ctx.uploads ? 'upload-files' : 'type-paths'
  if (clip.text) return 'text'
  if (chord.via !== 'ctrl') return clip.hasImage ? 'image' : 'nothing'
  if (!clip.hasImage) return 'xterm'
  // Bare Ctrl+V's own ^V is right for an image only where ^V is the agent's paste key.
  return ctx.uploads || ctx.imageKey !== '\x16' ? 'image' : 'xterm-image'
}

/**
 * The right-click menu's Paste item for what is on the clipboard: files go
 * first (to the machine on an SSH tab that sends uploads, as their paths
 * everywhere else), then text, then an image.
 */
export function pasteMenuItem(clip: ClipboardContents, uploads: boolean): { label: string; disabled: boolean } {
  if (clip.files > 0) {
    const n = clip.files
    if (uploads) return { label: n > 1 ? `Paste ${n} files` : 'Paste file', disabled: false }
    return { label: n > 1 ? `Paste ${n} file paths` : 'Paste file path', disabled: false }
  }
  if (clip.text) return { label: 'Paste', disabled: false }
  if (clip.hasImage) return { label: 'Paste image', disabled: false }
  return { label: 'Paste', disabled: true }
}

/**
 * Whether App's unclaimed-key route hands a clipboard chord pressed outside
 * the terminal to the terminal in front.
 *
 * A click on a chrome button (the usage chip, a status-bar button, a tab)
 * leaves focus on that button, and `typeThroughKey` already types plain keys
 * through to the terminal from there. It refuses every chord, so Cmd/Ctrl+V
 * then pasted into the button — nothing — and a selection still showing in the
 * terminal could not be copied until the terminal was clicked.
 *
 * Never from a field (its own copy and paste), from inside a terminal pane
 * (the terminal, its find bar and strips decide their own keys), over an
 * overlay, or with no terminal in front; and never a copy while the page itself
 * has text selected, which is the browser's to copy.
 */
export function chromeTakesChord(
  chord: ClipboardChord,
  ctx: {
    hasTerminal: boolean
    overlayOpen: boolean
    editable: boolean
    inPane: boolean
    pageSelection: boolean
    defaultPrevented: boolean
  }
): boolean {
  if (!ctx.hasTerminal || ctx.overlayOpen || ctx.editable || ctx.inPane || ctx.defaultPrevented) return false
  return chord.op === 'paste' || !ctx.pageSelection
}

/* --------------------------------------------------------------- dictation */

/**
 * Whether dictated words are TYPED into this tab rather than pasted.
 *
 * Claude Code files a bracketed paste as `<pasted_content>`, and the model will
 * not act on a message that is nothing but one (gotcha 86, measured against
 * 2.1.278 from the phone). A dictated message is usually exactly that: the
 * words, then Enter. So a local Claude tab gets them typed, the way the phone
 * and a remote tab already do (`pty.type`: `submitFrames`' chunks, newlines as
 * ESC CR, no Enter). Every other tab keeps the paste — a shell, or an SSH tab
 * whose far program Stoke cannot see, needs the bracket to keep its newlines.
 */
export function typesDictation(tab: { cliId?: string; hostId?: string | null; kind?: string }): boolean {
  return tab.cliId === 'claude' && !tab.hostId && (tab.kind === undefined || tab.kind === 'session')
}

/**
 * Cleaned text cut into parts of at most `max` code points for `pty.type`,
 * whose cap is the title bar's `SHORTCUT_TEXT_MAX`. CRLF becomes LF first, so
 * no cut lands between the two and types one line break as two; a cut never
 * splits a surrogate pair, because it counts code points.
 */
export function typingParts(text: string, max: number): string[] {
  const points = Array.from(safePasteText(text).replace(/\r\n/g, '\n'))
  const parts: string[] = []
  for (let at = 0; at < points.length; at += Math.max(1, max)) parts.push(points.slice(at, at + Math.max(1, max)).join(''))
  return parts
}
