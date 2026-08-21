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
import { isButtonlessMotionReport } from '../src/renderer/src/lib/mouseReport.ts'

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
    /*
     * The same guard TerminalView installs, built from the SHIPPED function
     * rather than a copy of it — `isButtonlessMotionReport` is imported above
     * and stringified here, so if its rule changes this page changes with it.
     * That is the whole reason it is written without imports or module-scope
     * helpers.
     *
     * Without this, a selection cannot survive any-event tracking: every motion
     * report reaches SelectionService as user input and clears it.
     */
    `  const isButtonlessMotionReport = ${isButtonlessMotionReport.toString()}`,
    '  const __cs = term._core && term._core.coreService',
    '  if (__cs) {',
    '    const __send = __cs.triggerDataEvent.bind(__cs)',
    '    __cs.triggerDataEvent = (d, u) => __send(d, !!u && !isButtonlessMotionReport(d))',
    '  }',
    '  window.__guardInstalled = !!__cs',
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
    '  mouse(screen, "mousedown", 200, 8, { shiftKey: false, altKey: true })',
    '  await new Promise(r => setTimeout(r, 16))',
    '  mouse(document, "mousemove", 60, 26, { shiftKey: false, altKey: true })',
    '  await new Promise(r => setTimeout(r, 16))',
    '  mouse(document, "mouseup", 60, 26, { shiftKey: false, altKey: true })',
    '  await new Promise(r => setTimeout(r, 60))',
    '  record(term, "alt across two rows")',
    '',
    /*
     * The two clones side by side: the one the shim used to dispatch and the one
     * it dispatches now. This is the assertion the suite was missing, and it is
     * missing in a way that mattered — every case here turns mouse reporting ON,
     * and with it on both clones behave identically, because xterm's Mac branch
     * reads `altKey` and ignores Shift entirely. The divergence only appears
     * with reporting OFF, which is the state a VPS tab sits in at a byobu or
     * login prompt and the state no case here ever ran.
     *
     * With reporting off, `handleMouseDown` takes `if (this._enabled &&
     * event.shiftKey) _handleIncrementalClick(e)` (SelectionService.ts:478) —
     * and incremental click only moves the END of an existing selection, so with
     * nothing selected yet it is a no-op and the drag selects nothing at all.
     * Stripping Shift lands on `_handleSingleClick` instead, which is what
     * actually starts one.
     *
     * Both readings are asserted for every run, because "Shift alone does not
     * force a selection" and "the retold event does" are true in both modes and
     * for different reasons — so a single pair of assertions pins the whole
     * matrix.
     */
    '  async function bare(name, opts) {',
    '    term.clearSelection()',
    '    term.write("\\u001b[2J\\u001b[3J\\u001b[H")',
    '    term.write("the quick brown fox jumps over the lazy dog\\r\\n")',
    '    await new Promise(r => setTimeout(r, 80))',
    '    mouse(screen, "mousedown", 10, 8, opts)',
    '    await new Promise(r => setTimeout(r, 16))',
    '    mouse(document, "mousemove", 240, 8, opts)',
    '    await new Promise(r => setTimeout(r, 16))',
    '    mouse(document, "mouseup", 240, 8, opts)',
    '    await new Promise(r => setTimeout(r, 60))',
    '    record(term, name)',
    '  }',
    '  await bare("shift only", { shiftKey: true, altKey: false })',
    '  await bare("alt only", { shiftKey: false, altKey: true })',
    '  await bare("neither modifier", { shiftKey: false, altKey: false })',
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
     * Any-event tracking (1003). No longer a hypothetical contrast case: this
     * is what Claude Code 2.1.237 actually asks for, read out of the shipped
     * binary and confirmed live (`mouseTrackingMode === "any"`). It reports
     * motion with no button held, which is why the guard above exists — with
     * it, a selection has to survive here exactly as it does anywhere else.
     */
    out.push(
      await runCase(
        dir,
        'any-event tracking (1003), altClickMovesCursor off',
        false,
        '\\u001b[?1000h\\u001b[?1003h\\u001b[?1006h'
      )
    )
    /*
     * No mouse reporting at all — the state every case above skipped, and the
     * one a VPS tab is actually in whenever it sits at a shell rather than
     * inside `claude`. `hosts[0].command` is `byobu` here, and byobu enables no
     * reporting, so this is not a hypothetical: it is the tab the user copies
     * out of. xterm's selection is ENABLED in this mode, which flips which
     * branch of `handleMouseDown` a Shift-drag takes, and the branch it lands on
     * with Shift still set does nothing.
     */
    out.push(await runCase(dir, 'no mouse reporting (a plain shell)', false, ''))
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
    const reporting = !run.label.startsWith('no mouse reporting')
    check(
      `${run.label}: mouse reporting is ${reporting ? 'on' : 'off'}, as this case intends`,
      run.mouseEventsActive === reporting,
      `enable-mouse-events=${run.mouseEventsActive}`
    )
    if (reporting) {
      check(
        `${run.label}: so a plain drag selects nothing (the control)`,
        !!control && control.selection.length === 0,
        control ? `got ${JSON.stringify(control.selection)}` : 'no reading'
      )
    } else {
      /*
       * Inverted, and it is the whole reason this case exists: with nothing
       * taking the mouse, a plain unmodified drag selects normally. So a VPS tab
       * at a shell prompt was never short of a way to select — it was short of
       * the one Stoke's own hint told the user to use.
       */
      check(
        `${run.label}: a plain drag selects, with nothing holding the mouse`,
        !!control && control.selection.length > 0,
        control ? `got ${JSON.stringify(control.selection)}` : 'no reading'
      )
    }

    /*
     * Every clone shape, against the one rule that decides them all.
     *
     * Named by shape rather than by vintage, because there is no longer a single
     * "the clone now": `TerminalView`'s shim picks the shape from the mouse mode
     * AND the platform, and the shape that is right on macOS is wrong off it.
     *
     *   reporting ON  -> xterm forces a selection iff `shouldForceSelection`,
     *                    which is `isMac ? altKey : shiftKey` (:437-443)
     *   reporting OFF  -> selection is enabled, so `_enabled && shiftKey` takes
     *                    the incremental-click branch (:478), a no-op with
     *                    nothing selected. Anything WITHOUT Shift selects.
     *
     * Asserting the rule rather than three memorised outcomes is what makes this
     * portable. The old pair asserted "a clone that keeps Shift selects nothing",
     * which is true on macOS in both modes and FALSE off macOS with reporting on
     * — where `shouldForceSelection` is `event.shiftKey` and that clone is
     * exactly what the shim dispatches. It could only ever have passed on a Mac,
     * which by this repo's own standard is a defect in the suite rather than a
     * fact about the machine.
     */
    const isMac = process.platform === 'darwin'
    const forces = (shiftKey: boolean, altKey: boolean): boolean =>
      reporting ? (isMac ? altKey : shiftKey) : !shiftKey

    for (const [name, shiftKey, altKey] of [
      ['shift only', true, false],
      ['alt only', false, true],
      ['neither modifier', false, false]
    ] as const) {
      const step = run.steps.find((s) => s.name === name)
      const want = forces(shiftKey, altKey)
      check(
        `${run.label}: a drag with ${name} ${want ? 'selects' : 'selects nothing'}`,
        !!step && step.selection.length > 0 === want,
        step ? `got ${JSON.stringify(step.selection)}` : 'no reading'
      )
    }

    /*
     * And the shape the shim actually dispatches, spelled the same way it is
     * spelled in `TerminalView.tsx`. This is the assertion that fails if that
     * expression is ever changed to something xterm will not act on — the one
     * the suite could not make while it hard-coded a single clone.
     */
    const shimAlt = reporting && isMac
    const shimShift = reporting && !isMac
    const shimStep = run.steps.find(
      (s) => s.name === (shimAlt ? 'alt only' : shimShift ? 'shift only' : 'neither modifier')
    )
    check(
      `${run.label}: the clone the shim dispatches here does select`,
      !!shimStep && shimStep.selection.length > 0,
      shimStep ? `got ${JSON.stringify(shimStep.selection)}` : 'no reading'
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
       * Under any-event tracking the terminal reports plain mouse MOTION, and
       * xterm hands every such report to `triggerDataEvent(report, true)` —
       * user input, which SelectionService clears the selection on.
       *
       * This block used to assert the OPPOSITE of what it now does, under the
       * name "known limit", on two premises that were both false by the time
       * anyone checked: that Stoke could not fix it from outside xterm, and
       * that Claude Code never asks for motion reports. 2.1.237 asks for 1003,
       * so the "contrast case" below had quietly become the ordinary case —
       * and a selection died on any local tab the moment the mouse moved, while
       * this suite passed an assertion saying so. A test that pins a bug as
       * expected behaviour is worse than no test, because it converts a
       * regression into a green run.
       *
       * The fix is `isButtonlessMotionReport` plus the wrap installed at the
       * top of this page, which withdraws only the "was user input" claim and
       * only for movement with nothing pressed. The report still reaches the
       * application, so hover handling and click-to-focus are untouched. There
       * is nothing special left about this case: it must survive exactly like
       * every other.
       */

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
    const shim = run.steps.find((s) => s.name === 'alt across two rows')
    if (!shim) continue
    check(
      `${run.label}: the retold drag wraps the line rather than cutting a column`,
      shim.selection.includes('lazy dog'),
      JSON.stringify(shim.selection)
    )
  }

  /*
   * The rule itself, directly. The page above proves it works inside real
   * xterm; these prove it says the right thing about each report shape, which
   * is cheaper to read when one of them starts failing.
   *
   * The last two matter most: a keystroke and a button press MUST still count
   * as user input, or this "fix" would stop the selection clearing when it
   * genuinely should.
   */
  console.log('\nwhich payloads count as bare pointer movement')
  const motion = (name: string, data: string, want: boolean): void => {
    const got = isButtonlessMotionReport(data)
    check(name, got === want, `got ${got}, want ${want}`)
  }
  motion('SGR motion, no button held (1003 idle move)', '\x1b[<35;10;5M', true)
  motion('SGR motion while dragging button 0 is NOT buttonless', '\x1b[<32;10;5M', false)
  motion('SGR plain press is an action, not movement', '\x1b[<0;10;5M', false)
  motion('SGR release is an action', '\x1b[<0;10;5m', false)
  motion('SGR wheel is an action even though it sets the motion bit', '\x1b[<64;10;5M', false)
  motion('X10 motion with no button held', '\x1b[M' + String.fromCharCode(35 + 32, 42, 42), true)
  motion('a plain keystroke is not a mouse report', 'a', false)
  motion('a pasted line is not a mouse report', 'hello world\r', false)
  motion('an empty payload is not a mouse report', '', false)
  motion('a truncated SGR sequence is not matched', '\x1b[<35;10;', false)

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
