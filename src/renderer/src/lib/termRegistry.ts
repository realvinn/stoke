import type { Terminal } from '@xterm/xterm'

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
 * The visible viewport as plain text, trailing blank lines dropped.
 *
 * The viewport rather than the buffer: it is what the user was looking at, and
 * on a byobu tab running Claude Code it is all there is anyway — that pane is on
 * the alternate screen, so no scrollback exists on either side (gotcha 29).
 *
 * `translateToString(true)` trims each line's trailing blanks, which is the
 * difference between a screen and a screen padded to 200 columns.
 */
export function screenOf(ptyId: string): string {
  const term = terms.get(ptyId)
  if (!term) return ''
  const buf = term.buffer.active
  const lines: string[] = []
  for (let row = 0; row < term.rows; row++) {
    lines.push(buf.getLine(buf.viewportY + row)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}
