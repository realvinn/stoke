/**
 * Telling a mouse *movement* report apart from a mouse *action* report.
 *
 * xterm sends every mouse report to the pty through
 * `CoreService.triggerDataEvent(report, true)` — note the `true`
 * (`CoreMouseService.triggerMouseEvent`, `:331`). That second argument means
 * "this was user input", and `SelectionService` listens for exactly that in
 * order to clear the selection (`SelectionService.ts:139`). For a keypress or a
 * click that is right. For the pointer merely *moving* it is not, and the
 * difference became load-bearing when Claude Code 2.1.237 began requesting
 * mode 1003 — any-event tracking, which reports motion with no button held.
 *
 * The effect was that a selection died the instant the mouse moved, anywhere in
 * the terminal, by one pixel, on every local tab. Right-click -> Copy was
 * unreachable in practice, because right-clicking means moving to the menu.
 * Shift-drag, Option-drag and the since-removed Copy mode were all affected
 * identically, since they all end with a selection that the next motion report
 * destroys.
 *
 * So: send the report exactly as before — the CLI still gets every byte, and
 * click-to-focus inside the TUI still works — but do not call it user input
 * when nothing was pressed.
 *
 * Kept pure and in its own module because the wiring around it is a closure in
 * TerminalView, and CLAUDE.md gotcha 31 is the standing lesson about what that
 * costs: a rule nobody can test is a rule that silently stops being true.
 */

/**
 * Is this payload a mouse report describing movement with no button held?
 *
 * Both encodings xterm can emit are recognised. Anything that is not a mouse
 * report at all — ordinary keystrokes, pastes, OSC replies — returns false and
 * is left to behave exactly as before, which is the important half: this must
 * never make a keypress stop clearing the selection.
 *
 * **Deliberately self-contained: no imports, no module-scope constants, no
 * helper calls.** `verify:selection` builds its own page and cannot bundle
 * anything, so it injects this function by `Function.prototype.toString()` and
 * exercises the shipped source rather than a hand-written copy of it. That is
 * the difference between a suite that guards this rule and one that only
 * appears to — the same suite used to hand-copy xterm's clone shapes, and
 * consequently went on passing while the behaviour it named was broken.
 */
export function isButtonlessMotionReport(data: string): boolean {
  // Motion sets bit 32; wheel reports also set bit 64 and are actions, not
  // movement; the low two bits carry the button, where 3 means "none".
  const MOTION = 32
  const WHEEL = 64
  const BUTTON_MASK = 3
  const BUTTON_NONE = 3

  let code = NaN

  // SGR (1006) and SGR_PIXELS (1016): ESC [ < code ; a ; b (M|m)
  const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data)
  if (sgr) {
    code = Number(sgr[1])
  } else if (data.length === 6 && data.startsWith('\x1b[M')) {
    // DEFAULT (X10): ESC [ M then three bytes, each offset by 32.
    code = data.charCodeAt(3) - 32
  } else {
    return false
  }

  if (!Number.isFinite(code)) return false
  if (!(code & MOTION)) return false
  if (code & WHEEL) return false
  return (code & BUTTON_MASK) === BUTTON_NONE
}
