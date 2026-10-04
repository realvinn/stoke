/**
 * The terminal modes a replay has to put back in front of its bytes.
 *
 * Two places keep a pty's recent output to replay into a fresh terminal: main
 * (`PtyManager.historyFor`, 512 KB) for the phone and the hub's remote tabs,
 * which replay it on every attach and every reconnect, and the renderer
 * (`ptyBus`, 1 MB) for a remount. Both drop whole chunks from the FRONT, and
 * once a session has printed that much, the chunks dropped hold the escape
 * sequences that switched its modes on at launch.
 *
 * Claude Code's full-screen renderer enters the alternate screen once per
 * session (`CSI ?1049h`; measured 2026-10-04 against 2.1.289, from the tab's
 * first byte through a resize and a refocus: one, while it re-sent mouse
 * reporting on three later redraws). So a terminal rebuilt from a trimmed
 * replay drew Claude's frames on the NORMAL screen. Its scrollback filled with
 * stale frames, and the wheel, until some redraw re-sent mouse reporting,
 * scrolled those rather than reaching Claude, taking the input box and the
 * status line off the bottom: the view "mid scroll" or "at the very top" on
 * coming back to a session from another machine.
 *
 * `ReplayModes` reads the chunks as they are DROPPED, so it always holds the
 * modes in force where the kept bytes begin, and `preamble()` sets them again.
 * It follows xterm's own rules (InputHandler's setModePrivate and
 * resetModePrivate, 6.0.0): one mouse protocol and one encoding, the last one
 * set winning; resetting any protocol turns tracking off; RIS (`ESC c`) puts
 * everything back to the defaults.
 *
 * main serves a whole screen now (`ScreenMirror`) and uses this for the modes
 * xterm's serializer leaves out, and as its fallback; the renderer's replay
 * still uses it on its own. CLAUDE.md gotcha 159.
 */

/** The alternate screen, by any of its three numbers. */
const ALT = new Set([47, 1047, 1049])
/** Mouse protocols: xterm keeps one. */
const MOUSE = new Set([9, 1000, 1002, 1003])
/** Mouse encodings xterm still supports: it keeps one. */
const ENCODING = new Set([1006, 1016])
/**
 * Plain on/off modes, each with xterm's default: application cursor keys,
 * autowrap, cursor shown, application keypad, focus reports, bracketed paste,
 * and colour-scheme reports (2031, which xterm ignores but TerminalView reads
 * from the stream to decide whether to send them, gotcha 42).
 */
const FLAGS: ReadonlyMap<number, boolean> = new Map([
  [1, false],
  [7, true],
  [25, true],
  [66, false],
  [1004, false],
  [2004, false],
  [2031, false]
])

/** DECSET/DECRST (`CSI ? Pm h` / `l`) or RIS. */
const MODE_SEQUENCE = /\u001b(?:\[\?([\d;]*)([hl])|c)/g
/** What a chunk may end with that the next chunk could finish into a mode sequence. */
const UNFINISHED = /^\u001b(?:\[(?:\?[\d;]*)?)?$/
/** No real mode sequence is longer; anything past this is not one. */
const MAX_CARRY = 64

export class ReplayModes {
  private alt = false
  private mouse = 0
  private encoding = 0
  private flags = new Map<number, boolean>()
  /** The start of a sequence the last chunk ended in. */
  private carry = ''

  /** Read a chunk of output, in order. */
  feed(chunk: string): void {
    const text = this.carry + chunk
    this.carry = ''
    for (const m of text.matchAll(MODE_SEQUENCE)) {
      if (m[2] === undefined) {
        this.reset()
        continue
      }
      for (const p of m[1].split(';')) if (p) this.set(Number(p), m[2] === 'h')
    }
    const esc = text.lastIndexOf('\u001b')
    if (esc >= 0 && text.length - esc <= MAX_CARRY && UNFINISHED.test(text.slice(esc))) this.carry = text.slice(esc)
  }

  /**
   * The sequence that takes a fresh terminal to these modes, or '' when they
   * are all the defaults. `screen: false` leaves the alternate screen out, for
   * a caller that has already drawn it (ScreenMirror: entering it again
   * would be harmless in xterm, but is not the caller's to repeat).
   */
  preamble(opts: { screen?: boolean } = {}): string {
    const on: number[] = []
    const off: number[] = []
    // The screen first: what follows draws on it.
    if (this.alt && opts.screen !== false) on.push(1049)
    if (this.mouse) on.push(this.mouse)
    if (this.encoding) on.push(this.encoding)
    for (const [n, dflt] of FLAGS) {
      const v = this.flags.get(n) ?? dflt
      if (v !== dflt) (v ? on : off).push(n)
    }
    return (on.length ? `\u001b[?${on.join(';')}h` : '') + (off.length ? `\u001b[?${off.join(';')}l` : '')
  }

  private set(n: number, on: boolean): void {
    if (ALT.has(n)) this.alt = on
    else if (MOUSE.has(n)) this.mouse = on ? n : 0
    else if (ENCODING.has(n)) this.encoding = on ? n : 0
    else if (FLAGS.has(n)) this.flags.set(n, on)
  }

  private reset(): void {
    this.alt = false
    this.mouse = 0
    this.encoding = 0
    this.flags.clear()
  }
}
