/*
 * Does an Option-drag selection survive letting go of the mouse?
 *
 * This runs xterm in a real Electron renderer — the same Chromium, the same
 * xterm build, and the exact options `TerminalView.tsx` passes — because the
 * bug it exists for is invisible to every cheaper check. It is not a
 * misconfiguration and not a type error; it is two xterm features that both
 * key off the Option modifier, fighting over one gesture.
 *
 * The gesture, on macOS:
 *
 *   1. Claude Code turns mouse reporting on, so a plain drag is forwarded to
 *      the application instead of selecting.
 *   2. `macOptionClickForcesSelection` makes Option-drag bypass that, so the
 *      drag selects (d34cf8e).
 *   3. `altClickMovesCursor` — on by default, and never set by Stoke — reads
 *      the *same* Option key on mouseup. When it fires it calls
 *      `triggerDataEvent(…, true)`, and SelectionService's own
 *      `onUserInput` handler clears the selection on any user input.
 *
 * So the selection appears while dragging and vanishes on release.
 *
 *   npm run verify:selection
 */
import { app, BrowserWindow } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const XTERM_DIR = fileURLToPath(new URL('../node_modules/@xterm/xterm/', import.meta.url))

interface Step {
  name: string
  selection: string
  cells: number
}

interface Run {
  mouseEventsActive?: boolean
  altClickMovesCursor: boolean
  label: string
  steps: Step[]
  error?: string
}

/*
 * The page. Everything interesting happens here, in the renderer, because the
 * behaviour under test is xterm's DOM event handling.
 *
 * Built from an array of lines rather than one template literal: a nested
 * backtick terminates the outer literal early and throws a SyntaxError before
 * a line of it runs (CLAUDE.md, standing traps).
 */
function page(altClickMovesCursor: boolean, modes: string): string {
  return [
    '<!doctype html><html><head>',
    `<link rel="stylesheet" href="${XTERM_DIR}css/xterm.css">`,
    '<style>html,body{margin:0;background:#111} #host{width:900px;height:400px}</style>',
    '</head><body><div id="host"></div>',
    `<script src="${XTERM_DIR}lib/xterm.js"></script>`,
    '<script>',
    'const steps = []',
    'const results = { label: "", steps }',
    'function sel(term) { return term.getSelection() }',
    // xterm paints the selection into .xterm-selection as positioned divs, so
    // the DOM can be asked what the user can actually see. getSelection() alone
    // would not catch a selection that is live in the model but unpainted.
    'function cells() { const n = document.querySelector(".xterm-selection"); return n ? n.children.length : -1 }',
    'function record(term, name) { steps.push({ name, selection: sel(term), cells: cells() }) }',
    '',
    // Coordinates always come from the screen element; the dispatch target may
    // be the document, because that is where xterm listens for the mousemove
    // and mouseup that continue a drag past the terminal's own bounds.
    'function mouse(target, type, x, y, opts) {',
    '  const r = document.querySelector(".xterm-screen").getBoundingClientRect()',
    '  const ev = new MouseEvent(type, Object.assign({',
    '    bubbles: true, cancelable: true, view: window,',
    '    clientX: r.left + x, clientY: r.top + y,',
    '    button: 0, buttons: type === "mouseup" ? 0 : 1,',
    '    altKey: true, detail: 1',
    '  }, opts || {}))',
    '  target.dispatchEvent(ev)',
    '  return ev',
    '}',
    '',
    'async function main() {',
    '  const term = new Terminal({',
    '    fontFamily: "monospace", fontSize: 14, lineHeight: 1.2, letterSpacing: 0,',
    '    cursorBlink: false, cursorStyle: "bar", scrollback: 20000,',
    '    allowProposedApi: true, allowTransparency: true,',
    '    macOptionIsMeta: true,',
    '    macOptionClickForcesSelection: true,',
    `    altClickMovesCursor: ${altClickMovesCursor ? 'true' : 'false'},`,
    '    minimumContrastRatio: 1',
    '  })',
    '  term.open(document.getElementById("host"))',
    '  await new Promise(r => setTimeout(r, 300))',
    '',
    // Exactly what a TUI like Claude Code sends to take the mouse: normal
    // tracking, button-event tracking, and SGR extended coordinates.
    `  term.write("${modes}")`,
    '  term.write("the quick brown fox jumps over the lazy dog\\r\\n")',
    '  term.write("second line of text to drag across\\r\\n")',
    '  await new Promise(r => setTimeout(r, 300))',
    '',
    '  const screen = document.querySelector(".xterm-screen")',
    '',
    // THE CONTROL, and the whole suite depends on it. If mouse reporting never
    // actually came on, `shouldForceSelection` is irrelevant, a plain drag
    // selects happily, and every assertion below passes while testing nothing.
    // A plain drag must select NOTHING for the rest of this to mean anything.
    '  results.mouseEventsActive = !!document.querySelector(".enable-mouse-events")',
    '  mouse(screen, "mousedown", 10, 8, { altKey: false })',
    '  mouse(document, "mousemove", 240, 8, { altKey: false })',
    '  mouse(document, "mouseup", 240, 8, { altKey: false })',
    '  await new Promise(r => setTimeout(r, 60))',
    '  record(term, "control: plain drag")',
    '  term.clearSelection()',
    '',
    '  async function drag(name, opts) {',
    '    term.clearSelection()',
    // Reset the buffer every time. A scenario that scrolls output would
    // otherwise leave the next one dragging across blank rows, selecting
    // nothing, and reporting that as a failure of the thing under test.
    '    term.write("\\u001b[2J\\u001b[3J\\u001b[H")',
    '    term.write("the quick brown fox jumps over the lazy dog\\r\\n")',
    '    term.write("second line of text to drag across\\r\\n")',
    '    await new Promise(r => setTimeout(r, 80))',
    '    mouse(screen, "mousedown", 10, opts.y || 8)',
    '    await new Promise(r => setTimeout(r, opts.hold || 16))',
    '    mouse(screen, "mousemove", (opts.to || 240) / 2, opts.y || 8)',
    '    mouse(document, "mousemove", opts.to || 240, opts.y || 8)',
    '    await new Promise(r => setTimeout(r, 8))',
    '    record(term, name + " [mid-drag]")',
    '    mouse(document, "mouseup", opts.to || 240, opts.y || 8)',
    '    await new Promise(r => setTimeout(r, 40))',
    '    if (opts.thenWrite) { term.write(opts.thenWrite); await new Promise(r => setTimeout(r, 120)) }',
    // The one thing the harness was missing: the mouse keeps existing after
    // you let go of it. Under button-event or any-event tracking the terminal
    // reports motion to the application, and every such report is user input.
    '    if (opts.thenMove) {',
    '      mouse(document, "mousemove", 300, 8, { altKey: false, buttons: 0 })',
    '      mouse(screen, "mousemove", 320, 8, { altKey: false, buttons: 0 })',
    '      await new Promise(r => setTimeout(r, 80))',
    '    }',
    '    if (opts.thenKey) {',
    '      const t = document.querySelector(".xterm-helper-textarea") || document',
    '      t.dispatchEvent(new KeyboardEvent("keydown", { key: opts.thenKey, bubbles: true, cancelable: true }))',
    '      await new Promise(r => setTimeout(r, 80))',
    '    }',
    '    record(term, name + " [released]")',
    '  }',
    '',
    '  await drag("a long option-drag", { to: 240 })',
    // The altClickMovesCursor window: <=1 char selected, released inside 500ms.
    '  await drag("a tiny quick option-drag", { to: 14, hold: 4 })',
    // What the real app does that this harness otherwise does not: the TUI
    // redraws after the gesture.
    '  await drag("then the app redraws", { to: 240, thenWrite: "\\u001b[2K\\rredrawn prompt > " })',
    // And a scroll, which is what a redraw that adds lines really does.
    '  await drag("then output scrolls", { to: 240, thenWrite: "\\r\\n".repeat(30) + "more output" })',
    '  await drag("then a key is pressed", { to: 240, thenKey: "a" })',
    '  await drag("then the mouse moves", { to: 240, thenMove: true })',
    '',
    /*
     * The macOS Shift shim, and specifically the thing worth fearing about it.
     * TerminalView retells a Shift-drag as the same event with `altKey` set,
     * because that is the only modifier xterm's `shouldForceSelection` accepts
     * on a Mac. Alt is also xterm's block-select modifier — but
     * `shouldColumnSelect` is `altKey && !(isMac && macOptionClickForcesSelection)`,
     * so with that option on it can never fire. This drags row 1 to row 2 and
     * checks the shape of what came back: a NORMAL selection runs to the end of
     * the first line and wraps, a COLUMN selection would take the same narrow
     * x-range out of both rows and never include the first line's tail.
     */
    '  term.clearSelection()',
    '  term.write("\\u001b[2J\\u001b[3J\\u001b[H")',
    '  term.write("the quick brown fox jumps over the lazy dog\\r\\n")',
    '  term.write("second line of text to drag across\\r\\n")',
    '  await new Promise(r => setTimeout(r, 80))',
    '  mouse(screen, "mousedown", 200, 8, { shiftKey: true, altKey: true })',
    '  await new Promise(r => setTimeout(r, 16))',
    '  mouse(document, "mousemove", 60, 26, { shiftKey: true, altKey: true })',
    '  await new Promise(r => setTimeout(r, 16))',
    '  mouse(document, "mouseup", 60, 26, { shiftKey: true, altKey: true })',
    '  await new Promise(r => setTimeout(r, 60))',
    '  record(term, "shift+alt across two rows")',
    '  return results',
    '}',
    '',
    'window.__run = main().catch(e => ({ label: "", steps, error: String(e && e.stack || e) }))',
    '</script></body></html>'
  ].join('\n')
}

async function runCase(
  dir: string,
  label: string,
  altClickMovesCursor: boolean,
  modes = '\\u001b[?1000h\\u001b[?1002h\\u001b[?1006h'
): Promise<Run> {
  const file = join(dir, `${label.replace(/\W+/g, '-')}.html`)
  await writeFile(file, page(altClickMovesCursor, modes), 'utf8')

  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 500,
    webPreferences: { offscreen: false, backgroundThrottling: false }
  })
  try {
    await win.loadFile(file)
    const out = (await win.webContents.executeJavaScript('window.__run')) as Run
    return { ...out, label, altClickMovesCursor }
  } finally {
    win.destroy()
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'stoke-selection-'))
  const out: Run[] = []
  try {
    out.push(await runCase(dir, 'altClickMovesCursor default (true)', true))
    out.push(await runCase(dir, 'altClickMovesCursor off', false))
    /*
     * The modes Claude Code actually asks for, read straight out of the shipped
     * binary: 1000 (button press/release), 1004 (focus reporting), 1006 (SGR
     * coordinates) and 1007 (alternate scroll). Notably NOT 1002 or 1003, so it
     * never asks for motion reports — which is why moving the mouse after a
     * selection does not destroy it here.
     */
    out.push(
      await runCase(
        dir,
        "Claude Code's real modes, altClickMovesCursor default",
        true,
        '\\u001b[?1000h\\u001b[?1004h\\u001b[?1006h\\u001b[?1007h'
      )
    )
    out.push(
      await runCase(
        dir,
        "Claude Code's real modes, altClickMovesCursor off",
        false,
        '\\u001b[?1000h\\u001b[?1004h\\u001b[?1006h\\u001b[?1007h'
      )
    )
    /*
     * Any-event tracking (1003), kept as the contrast case. It reports motion
     * with no button held and every report is a user-input data event, which
     * SelectionService clears the selection on. Claude Code does not ask for
     * it — but a TUI Stoke hosts might, and this pins what that would cost.
     */
    out.push(
      await runCase(
        dir,
        'any-event tracking (1003), altClickMovesCursor off',
        false,
        '\\u001b[?1000h\\u001b[?1003h\\u001b[?1006h'
      )
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  let failures = 0
  const check = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  }

  for (const run of out) {
    console.log(`\n${run.label}`)
    if (run.error) {
      console.log(`  ERROR ${run.error}`)
      failures++
      continue
    }
    for (const s of run.steps) {
      console.log(`  ${s.name.padEnd(28)} selection=${JSON.stringify(s.selection)} cells=${s.cells}`)
    }
    /*
     * The control first. Everything else is meaningless without it: if mouse
     * reporting is not really on, a plain drag selects, `shouldForceSelection`
     * never matters, and every assertion below would pass while proving
     * nothing at all.
     */
    const control = run.steps.find((s) => s.name.startsWith('control'))
    check(
      `${run.label}: mouse reporting really is on`,
      run.mouseEventsActive === true,
      `enable-mouse-events=${run.mouseEventsActive}`
    )
    check(
      `${run.label}: so a plain drag selects nothing (the control)`,
      !!control && control.selection.length === 0,
      control ? `got ${JSON.stringify(control.selection)}` : 'no reading'
    )

    for (const mid of run.steps.filter((s) => s.name.endsWith('[mid-drag]'))) {
      const name = mid.name.replace(' [mid-drag]', '')
      const after = run.steps.find((s) => s.name === `${name} [released]`)
      check(`${run.label}: ${name} selects while dragging`, mid.selection.length >= 1, '')
      const survived = !!after && after.selection === mid.selection
      const detail = after
        ? `was ${JSON.stringify(mid.selection)}, now ${JSON.stringify(after.selection)}`
        : 'no reading'

      /*
       * The invariant, stated the way the user would: whatever the drag
       * selected is still selected once the mouse is let go. Compared against
       * the mid-drag reading rather than a length threshold, because the case
       * that actually breaks is a ONE character selection — a threshold of
       * "more than one" could never have caught it.
       */
      /*
       * Under any-event tracking the terminal reports plain mouse MOTION to the
       * application, and every such report is a user-input data event, which
       * SelectionService clears the selection on. Stoke cannot fix that from
       * outside xterm: suppressing the reports would break the hover handling
       * of whatever TUI asked for them.
       *
       * It does not bite today — the shipped `claude` binary asks for
       * 1000/1004/1006/1007 and never for 1002 or 1003, which is exactly why
       * the long-drag cases above survive. Pinned rather than ignored so that a
       * future TUI Stoke hosts, or a Claude Code that starts asking for motion,
       * is a failing assertion here instead of a bug report.
       */
      if (run.label.startsWith('any-event') && name === 'then the mouse moves') {
        check(
          `${run.label}: known limit — motion reports still eat the selection`,
          !survived,
          detail
        )
        continue
      }

      if (!run.altClickMovesCursor) {
        check(`${run.label}: ${name} survives letting go`, survived, detail)
        continue
      }

      /*
       * The runs with xterm's default left ON are not expected to pass, and
       * failing them would just mean this suite fails forever. They are here to
       * pin the CAUSE: the tiny drag must still break with the default, because
       * that is the whole reason TerminalView sets `altClickMovesCursor: false`.
       * If this ever stops breaking, xterm changed and the workaround can go —
       * which is worth being told about rather than discovering by accident.
       */
      if (name.startsWith('a tiny quick')) {
        check(
          `${run.label}: still the cause — the tiny drag breaks without the fix`,
          !survived,
          detail
        )
      } else {
        check(`${run.label}: ${name} survives letting go`, survived, detail)
      }
    }
  }

  /*
   * The shim's safety property, asserted once against the config Stoke ships.
   * Only the runs with `macOptionClickForcesSelection` on are meaningful here,
   * and every run in this suite sets it.
   */
  for (const run of out) {
    const shim = run.steps.find((s) => s.name === 'shift+alt across two rows')
    if (!shim) continue
    check(
      `${run.label}: a shift+alt drag wraps the line rather than cutting a column`,
      shim.selection.includes('lazy dog'),
      JSON.stringify(shim.selection)
    )
  }

  console.log(failures ? `\n${failures} failed` : '\nall pass')
  // `app.exit()` does not flush a piped stdout, so the exit is deferred a tick
  // past the last write rather than taken immediately (CLAUDE.md).
  setTimeout(() => app.exit(failures ? 1 : 0), 50)
}

// Never a top-level await, and a no-op `window-all-closed`: the default is to
// quit, so destroying the last window would end the run mid-measure, silently,
// with exit 0.
app.on('window-all-closed', () => {})
app.whenReady().then(main)
