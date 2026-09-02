/*
 * App shortcuts, and the zoom arithmetic behind Cmd/Ctrl +/-/0.
 *
 * `matchShortcut` had no coverage at all until zoom was added to it, which is
 * the wrong state for the one function standing between the app's chords and
 * the terminal's. Everything it matches is a keystroke it TAKES AWAY from
 * Claude Code: `TerminalView` calls it first and returns false on a match, so a
 * binding added carelessly here does not merely add a shortcut, it silently
 * removes a key from the CLI.
 *
 * The sharpest case is Ctrl+Shift+`-`. On a US layout that is Ctrl+`_`, and
 * xterm turns exactly that into C0.US (`Keyboard.ts:361-364`), which is
 * readline's undo. Binding the Shift variant of zoom-out would have eaten it —
 * so the assertion that it stays unmatched is the point of this file, not a
 * detail in it.
 *
 *   node scripts/verify-shortcuts.mts
 */
import { chordLabel, matchShortcut } from '../src/renderer/src/lib/shortcuts.ts'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  clampZoomTarget,
  zoomStep
} from '../src/shared/ui.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/** A keydown, with every modifier off unless named. */
function key(
  code: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}
): { code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean } {
  return {
    code,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt
  }
}

const onMac = (k: ReturnType<typeof key>): unknown => matchShortcut(k, true)
const onWin = (k: ReturnType<typeof key>): unknown => matchShortcut(k, false)

const ZOOM_IN = { type: 'zoom', direction: 1 }
const ZOOM_OUT = { type: 'zoom', direction: -1 }
const ZOOM_RESET = { type: 'zoom', direction: 0 }

/* ------------------------------------------------- the key the terminal owns */

console.log('\nCtrl+Shift+- is ^_ and must reach the terminal')
/*
 * The whole reason zoom-out refuses Shift. readline binds ^_ to undo and Claude
 * Code's prompt uses it; if this ever starts returning a zoom action, undo stops
 * working in every session and the cause will not be obvious from the symptom.
 */
check('Ctrl+Shift+Minus is not a shortcut on Windows', onWin(key('Minus', { ctrl: true, shift: true })), null)
check('nor on macOS with Cmd+Shift', onMac(key('Minus', { meta: true, shift: true })), null)
check('and Ctrl+Shift+Numpad- is not one either', onWin(key('NumpadSubtract', { ctrl: true, shift: true })), null)

/* --------------------------------------------------------------------- zoom */

console.log('\nzoom takes the chord every other app uses')
check('Ctrl+Minus zooms out on Windows, with no Shift', onWin(key('Minus', { ctrl: true })), ZOOM_OUT)
check('Ctrl+Equal zooms in', onWin(key('Equal', { ctrl: true })), ZOOM_IN)
check('Cmd+Minus zooms out on macOS', onMac(key('Minus', { meta: true })), ZOOM_OUT)
check('Cmd+Equal zooms in', onMac(key('Equal', { meta: true })), ZOOM_IN)

/*
 * Asymmetric on purpose: `+` IS Shift+`=` on most layouts, so someone pressing
 * "Cmd and plus" is holding Shift whether or not they think of it that way.
 * Refusing it would reject the gesture people actually make — and unlike
 * Shift+`-`, Shift+`=` collides with nothing: `ev.key` is `+`, which matches
 * neither of xterm's two Ctrl branches, so nothing is taken from the terminal.
 */
check('Cmd+Shift+Equal still zooms in, because + is Shift+=', onMac(key('Equal', { meta: true, shift: true })), ZOOM_IN)
check('and Ctrl+Shift+Equal does too', onWin(key('Equal', { ctrl: true, shift: true })), ZOOM_IN)

check('Cmd+0 resets', onMac(key('Digit0', { meta: true })), ZOOM_RESET)
check('Ctrl+0 resets', onWin(key('Digit0', { ctrl: true })), ZOOM_RESET)
check('Shift+Ctrl+0 does not', onWin(key('Digit0', { ctrl: true, shift: true })), null)

console.log('\nthe numpad answers to the same chords')
check('Ctrl+Numpad+', onWin(key('NumpadAdd', { ctrl: true })), ZOOM_IN)
check('Ctrl+Numpad-', onWin(key('NumpadSubtract', { ctrl: true })), ZOOM_OUT)
check('Ctrl+Numpad0', onWin(key('Numpad0', { ctrl: true })), ZOOM_RESET)

console.log('\nand nothing zooms without the primary modifier')
check('a bare Minus is just a keystroke', onWin(key('Minus')), null)
check('so is a bare Equal', onMac(key('Equal')), null)
check('Alt is always rejected', onWin(key('Minus', { ctrl: true, alt: true })), null)
/*
 * The wrong-platform modifier. On Windows the primary is Ctrl and Cmd must not
 * stand in for it, or a Mac keyboard on a Windows box would fire shortcuts
 * nobody pressed.
 */
check('Cmd+Minus is nothing on Windows', onWin(key('Minus', { meta: true })), null)
check('Ctrl+Minus is nothing on macOS', onMac(key('Minus', { ctrl: true })), null)

/* -------------------------------------------- the bindings that already existed */

console.log('\nthe existing chords are unchanged')
check('Cmd+K opens the palette on macOS', onMac(key('KeyK', { meta: true })), { type: 'palette' })
check('Ctrl+Shift+K does on Windows', onWin(key('KeyK', { ctrl: true, shift: true })), { type: 'palette' })
/*
 * And bare Ctrl+K stays the terminal's. This is the rule zoom is an exception
 * to, so it is pinned right beside it: Ctrl+K, Ctrl+W and Ctrl+T are readline
 * bindings Claude Code's own prompt uses, which is why every letter chord off
 * macOS demands Shift.
 */
check('bare Ctrl+K is left to readline', onWin(key('KeyK', { ctrl: true })), null)
check('bare Ctrl+W is too', onWin(key('KeyW', { ctrl: true })), null)
check('Cmd+T opens a tab', onMac(key('KeyT', { meta: true })), { type: 'newTab' })
check('Cmd+Comma opens settings', onMac(key('Comma', { meta: true })), { type: 'settings' })
check('Ctrl+3 selects a tab, with no Shift on either platform', onWin(key('Digit3', { ctrl: true })), { type: 'tab', index: 3 })
check('and Cmd+3 does the same', onMac(key('Digit3', { meta: true })), { type: 'tab', index: 3 })
check('Ctrl+Shift+3 does not select a tab', onWin(key('Digit3', { ctrl: true, shift: true })), null)

/* ------------------------------------------------------------ the arithmetic */

console.log('\nzoomStep moves what it is told to and nothing else')
const mid = { uiScale: 1, fontSize: 13 }

check('both moves both', zoomStep(mid, 1, 'both'), { uiScale: 1.1, fontSize: 14 })
check('and down again', zoomStep(mid, -1, 'both'), { uiScale: 0.9, fontSize: 12 })
check('terminal moves only the font', zoomStep(mid, 1, 'terminal'), { uiScale: 1, fontSize: 14 })
check('interface moves only the scale', zoomStep(mid, 1, 'interface'), { uiScale: 1.1, fontSize: 13 })
check('reset returns both defaults', zoomStep({ uiScale: 1.5, fontSize: 20 }, 0, 'both'), { uiScale: 1, fontSize: 13 })
check(
  'and a scoped reset leaves the other alone',
  zoomStep({ uiScale: 1.5, fontSize: 20 }, 0, 'terminal'),
  { uiScale: 1.5, fontSize: 13 }
)

console.log('\neach half stops at its own bound, and they are different bounds')
/*
 * Deliberately not pinned together. The scale tops out at 1.6 while the font
 * still has room to 24, so at the ceiling one keeps moving and the other does
 * not — which is the honest behaviour: coupling them would let the tighter
 * bound silently cap the looser one, and 24px text at 1.6 scale would become
 * unreachable.
 */
const high = zoomStep({ uiScale: UI_SCALE_MAX, fontSize: 20 }, 1, 'both')
check('the scale holds at its ceiling', high.uiScale, UI_SCALE_MAX)
check('while the font keeps going', high.fontSize, 21)
const low = zoomStep({ uiScale: UI_SCALE_MIN, fontSize: 12 }, -1, 'both')
check('the scale holds at its floor', low.uiScale, UI_SCALE_MIN)
check('while the font keeps going down', low.fontSize, 11)
check('the font stops at its own floor', zoomStep({ uiScale: 1, fontSize: FONT_SIZE_MIN }, -1, 'both').fontSize, FONT_SIZE_MIN)
check('and at its ceiling', zoomStep({ uiScale: 1, fontSize: FONT_SIZE_MAX }, 1, 'both').fontSize, FONT_SIZE_MAX)

console.log('\nthe scale stays on a grid a slider can display')
/*
 * Floats do not add cleanly — ten additions of 0.1 reach 0.9999999999999999 —
 * and the Interface scale field is bound straight to this number, so an
 * unsnapped value would show a figure nobody typed. Ten steps up and ten back
 * must return exactly where they started.
 */
let walk = { uiScale: 1, fontSize: 13 }
for (let i = 0; i < 5; i++) walk = zoomStep(walk, 1, 'interface')
for (let i = 0; i < 5; i++) walk = zoomStep(walk, -1, 'interface')
check('five steps up and five down returns exactly 1', walk.uiScale, 1)
check('a single step is exactly 1.1, not 1.1000000000000001', zoomStep(mid, 1, 'interface').uiScale, 1.1)

console.log('\njunk in the stored settings never disables zoom')
check('an unknown target falls back to both', clampZoomTarget('sideways'), 'both')
check('so does undefined', clampZoomTarget(undefined), 'both')
check('and a real one is kept', clampZoomTarget('terminal'), 'terminal')
/*
 * The stored sizes are hydrated by the settings schema, but zoomStep is also
 * called with whatever is in memory — so it clamps its own inputs rather than
 * trusting them, and a corrupt value cannot escape through the zoom path.
 */
check(
  'a junk scale on the way in still lands somewhere usable',
  zoomStep({ uiScale: Number.NaN, fontSize: 13 }, 1, 'interface').uiScale,
  1.1
)
check(
  'and a wildly out-of-range font does too',
  zoomStep({ uiScale: 1, fontSize: 900 }, 1, 'terminal').fontSize,
  FONT_SIZE_MAX
)

/* ------------------------------------------------------- cycling the strip */

console.log('\nnext / previous tab, and the chord it deliberately is not')
/*
 * Ctrl+Tab is the obvious binding and is unusable: xterm's Tab branch reads
 * only `shiftKey`, so Ctrl+Tab sends C0.HT from xterm's own textarea listener
 * — which runs before this window-level handler — and preventing the default
 * afterwards cannot unsend it. If this ever starts matching, every Ctrl+Tab
 * types a tab character into the prompt as well as switching tabs.
 */
check('Ctrl+Tab is not a shortcut on Windows', onWin(key('Tab', { ctrl: true })), null)
check('nor Ctrl+Shift+Tab', onWin(key('Tab', { ctrl: true, shift: true })), null)
check('nor Cmd+Tab on macOS', onMac(key('Tab', { meta: true })), null)

const NEXT = { type: 'cycleTab', delta: 1 }
const PREV = { type: 'cycleTab', delta: -1 }
check('Cmd+Shift+] is next tab', onMac(key('BracketRight', { meta: true, shift: true })), NEXT)
check('Cmd+Shift+[ is previous tab', onMac(key('BracketLeft', { meta: true, shift: true })), PREV)
check('Ctrl+Shift+] is next tab off macOS', onWin(key('BracketRight', { ctrl: true, shift: true })), NEXT)
check('Ctrl+Shift+[ is previous tab off macOS', onWin(key('BracketLeft', { ctrl: true, shift: true })), PREV)

/*
 * The Shift is what keeps the brackets out of xterm's `ctrlKey && !shiftKey`
 * branch, where keyCode 219/221 are ESC and GS. Binding the bare form would
 * take both of those away from the terminal.
 */
check('bare Ctrl+] still reaches the terminal', onWin(key('BracketRight', { ctrl: true })), null)
check('and bare Ctrl+[', onWin(key('BracketLeft', { ctrl: true })), null)
check('bare Cmd+] is unbound on macOS too', onMac(key('BracketRight', { meta: true })), null)

console.log('\nthe label says what this platform actually needs')
/*
 * The title bar used to print "Ctrl/Cmd+T" everywhere, which is a lie off
 * macOS: the letter chords all require Shift there, so the tooltip named a
 * combination that does nothing and reaches the CLI's prompt instead.
 */
check('macOS letter chord carries no Shift', chordLabel('newTab', true), '\u2318T')
check('off macOS it does', chordLabel('newTab', false), 'Ctrl+Shift+T')
check('the cycle chord carries Shift on macOS as well', chordLabel('nextTab', true), '\u21e7\u2318]')
check('and off it', chordLabel('prevTab', false), 'Ctrl+Shift+[')
check('settings is a comma, not a letter', chordLabel('settings', true), '\u2318,')

console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exit(failures ? 1 : 0)
