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
import { chordLabel, matchShortcut, typeThroughKey } from '../src/renderer/src/lib/shortcuts.ts'
import { tabShortcut } from '../src/shared/windowShortcuts.ts'
import {
  chordLetter,
  chromeTakesChord,
  clipboardChord,
  copyAction,
  pasteAction,
  pasteMenuItem,
  selectionHasText,
  type ChordKey,
  type ClipboardChord
} from '../src/shared/clipboardText.ts'
import { readFileSync } from 'node:fs'
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
 * to, so it is pinned right beside it: Ctrl+K and Ctrl+F are readline
 * bindings Claude Code's own prompt uses, so non-tab letter chords off
 * macOS retain Shift.
 */
check('bare Ctrl+K is left to readline', onWin(key('KeyK', { ctrl: true })), null)
check('Ctrl+W closes the selected Stoke tab on Windows', onWin(key('KeyW', { ctrl: true })), { type: 'closeTab' })
check('Ctrl+T opens a Stoke tab on Windows', onWin(key('KeyT', { ctrl: true })), { type: 'newTab' })
check('Ctrl+Shift+T reopens the last closed tab', onWin(key('KeyT', { ctrl: true, shift: true })), { type: 'reopenTab' })
check('Cmd+Shift+T reopens on macOS', onMac(key('KeyT', { meta: true, shift: true })), { type: 'reopenTab' })
check('Ctrl+Tab cycles forward before terminal input', onWin(key('Tab', { ctrl: true })), { type: 'cycleTab', delta: 1 })
check('Ctrl+Shift+Tab cycles backward', onWin(key('Tab', { ctrl: true, shift: true })), { type: 'cycleTab', delta: -1 })
check('Mac Ctrl+Tab cycles without intercepting Cmd+Tab', [onMac(key('Tab', { ctrl: true })), onMac(key('Tab', { meta: true }))], [{ type: 'cycleTab', delta: 1 }, null])
const nativeKey = { type: 'keyDown', key: 't', control: true, meta: false, shift: false, alt: false }
check('native Ctrl+Shift+T reopens from the embedded browser too', tabShortcut({ ...nativeKey, shift: true }, false), { type: 'reopenTab' })
check('the native path works without a physical code', tabShortcut(nativeKey, false), { type: 'newTab' })
check('held keys, key-up, IME and AltGr do not create tabs', [{ ...nativeKey, isAutoRepeat: true }, { ...nativeKey, type: 'keyUp' }, { ...nativeKey, isComposing: true }, { ...nativeKey, alt: true }].map(input => tabShortcut(input, false)), [null, null, null, null])
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
/* Native before-input interception and xterm's custom handler reserve the
 * tab chords before terminal input. The native packaged probe verifies both. */
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

console.log('\nfind in the terminal, and the bare chord it leaves alone')
/*
 * Bare Ctrl+F is readline's forward-char at Claude Code's prompt and a page down
 * in its transcript mode, and xterm sends it as ^F. Binding it would take both
 * from the CLI, so off macOS find is the Shift form, like every letter chord.
 */
check('Cmd+F finds on macOS', onMac(key('KeyF', { meta: true })), { type: 'find' })
check('Ctrl+Shift+F finds off macOS', onWin(key('KeyF', { ctrl: true, shift: true })), { type: 'find' })
check('bare Ctrl+F still reaches the terminal off macOS', onWin(key('KeyF', { ctrl: true })), null)
check('Cmd+Shift+F is not find on macOS', onMac(key('KeyF', { meta: true, shift: true })), null)
check('nor is Ctrl+F on macOS, where Ctrl is the terminal\'s', onMac(key('KeyF', { ctrl: true })), null)
check('Alt+Cmd+F is not find', onMac(key('KeyF', { meta: true, alt: true })), null)
/*
 * A new private chat (shared/privateChat.ts): ⇧⌘N, the private-window chord,
 * taken before the gate that refuses Shift on macOS; Ctrl+Shift+N off it. Bare
 * Ctrl+N is readline's next-history and must stay with the terminal, and bare
 * Cmd+N stays unbound.
 */
const PRIVATE = { type: 'newPrivate' }
check('Cmd+Shift+N is a new private chat', onMac(key('KeyN', { meta: true, shift: true })), PRIVATE)
check('Ctrl+Shift+N off macOS', onWin(key('KeyN', { ctrl: true, shift: true })), PRIVATE)
check('bare Ctrl+N still reaches the terminal (next-history)', onWin(key('KeyN', { ctrl: true })), null)
check('bare Cmd+N is unbound', onMac(key('KeyN', { meta: true })), null)
check('Ctrl+Shift+N on macOS is not it: Ctrl is not the primary there', onMac(key('KeyN', { ctrl: true, shift: true })), null)
check('nor with Alt', onMac(key('KeyN', { meta: true, shift: true, alt: true })), null)

console.log('\nthe label says what this platform actually needs')
/*
 * The title bar used to print "Ctrl/Cmd+T" everywhere, which is a lie off
 * macOS: the letter chords all require Shift there, so the tooltip named a
 * combination that does nothing and reaches the CLI's prompt instead.
 */
check('macOS letter chord carries no Shift', chordLabel('newTab', true), '\u2318T')
check('Windows advertises standard Ctrl+T', chordLabel('newTab', false), 'Ctrl+T')
check('Windows advertises standard Ctrl+W', chordLabel('closeTab', false), 'Ctrl+W')
check('the cycle chord carries Shift on macOS as well', chordLabel('nextTab', true), '\u21e7\u2318]')
check('and off it', chordLabel('prevTab', false), 'Ctrl+Shift+[')
check('settings is a comma, not a letter', chordLabel('settings', true), '\u2318,')
check('find is \u2318F on macOS', chordLabel('find', true), '\u2318F')
check('and Ctrl+Shift+F off it', chordLabel('find', false), 'Ctrl+Shift+F')
check('the private chat carries Shift on macOS too', chordLabel('newPrivate', true), '\u21e7\u2318N')
check('and off it', chordLabel('newPrivate', false), 'Ctrl+Shift+N')

console.log('\nkeystrokes nobody claimed go to the terminal')
/*
 * The bug: click the usage chip, then type, and nothing happens. The characters
 * are delivered correctly — to a <button>, which does nothing with them. Every
 * control in the chrome has that shape, so the fix is a rule rather than a
 * patch, and the rule is mostly about what it REFUSES: a character sent to the
 * wrong place is typed into the user's shell behind their back, which is worse
 * than a character dropped.
 */
{
  const key = (over: Record<string, unknown> = {}) => ({
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { tagName: 'BUTTON', isContentEditable: false },
    ...over
  })
  const live = { overlayOpen: false, hasTerminal: true }

  check('a plain letter on a button goes to the terminal', typeThroughKey(key(), live), 'a')
  check('so does a digit', typeThroughKey(key({ key: '7' }), live), '7')
  check('and a space', typeThroughKey(key({ key: ' ' }), live), ' ')
  check('Shift is not a modifier that claims anything', typeThroughKey(key({ key: 'A' }), live), 'A')
  check('Enter sends a carriage return, not a newline', typeThroughKey(key({ key: 'Enter' }), live), '\r')
  check('Backspace sends DEL, which is what a terminal expects', typeThroughKey(key({ key: 'Backspace' }), live), '\x7f')

  // Chords belong to matchShortcut. Routing them here would send a bare letter
  // to the pty for every shortcut the app does not happen to bind (gotcha 56).
  check('Ctrl is refused', typeThroughKey(key({ ctrlKey: true }), live), null)
  check('Meta is refused', typeThroughKey(key({ metaKey: true }), live), null)
  check('Alt is refused', typeThroughKey(key({ altKey: true }), live), null)

  // These already work, and must never be double-delivered.
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    check(`typing in a ${tagName} is left alone`, typeThroughKey(key({ target: { tagName } }), live), null)
  }
  check(
    "xterm's own textarea is left alone, so nothing is typed twice",
    typeThroughKey(key({ target: { tagName: 'TEXTAREA', isContentEditable: false } }), live),
    null
  )
  check(
    'a contenteditable is left alone whatever its tag',
    typeThroughKey(key({ target: { tagName: 'DIV', isContentEditable: true } }), live),
    null
  )

  // Named keys all mean something out here.
  for (const k of ['Tab', 'Escape', 'ArrowUp', 'ArrowLeft', 'F5', 'Home', 'PageDown', 'Shift', 'Dead']) {
    check(`${k} is not text`, typeThroughKey(key({ key: k }), live), null)
  }

  check('nothing while the palette or settings own the screen', typeThroughKey(key(), { overlayOpen: true, hasTerminal: true }), null)
  check('nothing with no running terminal in front', typeThroughKey(key(), { overlayOpen: false, hasTerminal: false }), null)
  check('and Enter with no terminal does not run an invisible shell', typeThroughKey(key({ key: 'Enter' }), { overlayOpen: false, hasTerminal: false }), null)

  // An emoji from the OS picker is one code point and two UTF-16 units; the
  // length test has to agree with the user about what "one character" is.
  check('an astral character counts as one', typeThroughKey(key({ key: '\u{1F525}' }), live), '\u{1F525}')
  check('a null target does not throw', typeThroughKey(key({ target: null }), live), 'a')
}

console.log('\nthe clipboard chords, on any keyboard layout (shared/clipboardText.ts)')
{
  /** A keydown as the clipboard chords read it: `key` is the character, `code` the physical key. */
  const press = (k: string, code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}): ChordKey => ({
    key: k,
    code,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt
  })
  /*
   * The layout case. On ЙЦУКЕН the C key reports `с` (U+0441) and the V key `м`,
   * so a `key === 'c'` test missed Ctrl+C, and xterm, which keys bare Ctrl by
   * keyCode (Keyboard.ts:308-310), sent ^C: an interrupt instead of a copy.
   */
  check('Cyrillic `с` on the C key is c', chordLetter(press('с', 'KeyC')), 'c')
  check('Cyrillic `м` on the V key is v', chordLetter(press('м', 'KeyV')), 'v')
  check('Greek `ψ` on the C key is c', chordLetter(press('ψ', 'KeyC')), 'c')
  check('a Latin key wins over its position: Dvorak’s C is on the I key', chordLetter(press('c', 'KeyI')), 'c')
  check('and Dvorak’s J on the C key is not a copy', chordLetter(press('j', 'KeyC')), 'j')
  check('Shift’s capital is the same letter', chordLetter(press('C', 'KeyC')), 'c')
  check('a capital of another script falls back too: Shift on ЙЦУКЕН’s C key', chordLetter(press('С', 'KeyC')), 'c')
  check('Hebrew, Arabic and kana letters fall back to the position', [chordLetter(press('ב', 'KeyC')), chordLetter(press('ر', 'KeyV')), chordLetter(press('そ', 'KeyC'))], ['c', 'v', 'c'])
  check('AZERTY keeps the letter printed on its key: its A is where QWERTY’s Q is', chordLetter(press('a', 'KeyQ')), 'a')
  /*
   * Only a letter of ANOTHER script falls back. Windows reports AltGr as
   * Ctrl+Alt, so Polish AltGr+Shift+C (`Ć`) is ctrl+alt+shift on the C key:
   * a fallback for any non-a–z key read it as Ctrl+Shift+C and ate the letter
   * (copying the selection instead). BÉPO's `.` sits on the V key, and macOS
   * Cmd+Option+C/V type `ç`/`√`.
   */
  check('a Latin letter with a mark is itself, not its position', [chordLetter(press('Ć', 'KeyC')), chordLetter(press('ç', 'KeyC'))], ['ć', 'ç'])
  check('punctuation is itself: BÉPO’s `.` on the V key', chordLetter(press('.', 'KeyV')), '.')
  check('Polish AltGr+Shift+C (Ć) is no copy chord', clipboardChord(press('Ć', 'KeyC', { ctrl: true, alt: true, shift: true }), false), null)
  check('BÉPO Ctrl+. is no paste chord', [clipboardChord(press('.', 'KeyV', { ctrl: true }), false), clipboardChord(press('.', 'KeyV', { ctrl: true }), true)], [null, null])
  check('macOS Cmd+Option+C and +V (ç, √) are no clipboard chord', [clipboardChord(press('ç', 'KeyC', { meta: true, alt: true }), true), clipboardChord(press('√', 'KeyV', { meta: true, alt: true }), true)], [null, null])

  check('macOS Cmd+C is the primary copy', clipboardChord(press('c', 'KeyC', { meta: true }), true), { op: 'copy', via: 'cmd' })
  check('macOS Cmd+V on a Cyrillic layout is still a paste', clipboardChord(press('м', 'KeyV', { meta: true }), true), { op: 'paste', via: 'cmd' })
  check('macOS bare Ctrl+C is no clipboard chord: it stays SIGINT', clipboardChord(press('c', 'KeyC', { ctrl: true }), true), null)
  check('macOS bare Ctrl+V is Claude Code’s image chord', clipboardChord(press('v', 'KeyV', { ctrl: true }), true), { op: 'paste', via: 'ctrl' })
  check('Ctrl+Shift+V is the primary paste on every platform', [clipboardChord(press('V', 'KeyV', { ctrl: true, shift: true }), false), clipboardChord(press('V', 'KeyV', { ctrl: true, shift: true }), true)], [{ op: 'paste', via: 'ctrl-shift' }, { op: 'paste', via: 'ctrl-shift' }])
  check('Windows bare Ctrl+C on ЙЦУКЕН is a copy chord, not ^C', clipboardChord(press('с', 'KeyC', { ctrl: true }), false), { op: 'copy', via: 'ctrl' })
  check('Windows bare Ctrl+V on ЙЦУКЕН is a paste chord, not ^V', clipboardChord(press('м', 'KeyV', { ctrl: true }), false), { op: 'paste', via: 'ctrl' })
  check('Ctrl+Alt+V and Ctrl+X are no clipboard chord', [clipboardChord(press('v', 'KeyV', { ctrl: true, alt: true }), false), clipboardChord(press('x', 'KeyX', { ctrl: true }), false)], [null, null])
  check('macOS Ctrl+Cmd+V is not the image chord', clipboardChord(press('v', 'KeyV', { ctrl: true, meta: true }), true), null)

  console.log('\nwhat a copy chord does with the selection')
  const cmdC: ClipboardChord = { op: 'copy', via: 'cmd' }
  const ctrlC: ClipboardChord = { op: 'copy', via: 'ctrl' }
  const shiftC: ClipboardChord = { op: 'copy', via: 'ctrl-shift' }
  check('a selection is copied', copyAction(cmdC, 'text', true), 'copy')
  check('bare Ctrl+C copies and clears, so a second press interrupts', copyAction(ctrlC, 'text', true), 'copy-clear')
  /*
   * Blank cells: `hasSelection` true, the text "". Bare Ctrl+C used to fall
   * through as ^C here — clearing Claude's draft or interrupting the turn under
   * a highlight the user could see — while Cmd+C and Ctrl+Shift+C swallowed it.
   */
  check('a blank-cell selection: Cmd+C swallows', copyAction(cmdC, '', true), 'swallow')
  check('a blank-cell selection: bare Ctrl+C swallows too, and clears it', copyAction(ctrlC, '', true), 'swallow-clear')
  check('nothing selected: bare Ctrl+C is SIGINT', copyAction(ctrlC, '', false), 'xterm')
  check('nothing selected: Ctrl+Shift+C goes to xterm as before', copyAction(shiftC, '', false), 'xterm')
  check('nothing selected: Cmd+C is left to the browser, which copies nothing', copyAction(cmdC, '', false), 'browser')
  /*
   * Blank ROWS: xterm trims blank cells but joins the selected rows with a
   * line break (`\r\n` on Windows), so a drag over two blank rows reads "\n",
   * not "" — and copying that wiped the clipboard as copying "" did.
   */
  check('only line breaks between blank rows is blank', [selectionHasText('\n'), selectionHasText('\r\n\r\n'), selectionHasText(' \t\n '), selectionHasText(' x ')], [false, false, false, true])
  check('blank rows: Cmd+C swallows, never writes "\\n" over the clipboard', copyAction(cmdC, '\n', true), 'swallow')
  check('blank rows on Windows: bare Ctrl+C swallows and clears, never sends ^C', copyAction(ctrlC, '\r\n', true), 'swallow-clear')
  check('blank rows: Ctrl+Shift+C swallows too', copyAction(shiftC, '\n\n', true), 'swallow')

  console.log('\nwhat a paste chord does with the clipboard')
  const cmdV: ClipboardChord = { op: 'paste', via: 'cmd' }
  const ctrlV: ClipboardChord = { op: 'paste', via: 'ctrl' }
  const clip = (c: Partial<{ text: string; hasImage: boolean; files: number }>) => ({ text: '', hasImage: false, files: 0, ...c })
  const local = { isMac: true, uploads: false, imageKey: '\x16' }
  const ssh = { isMac: true, uploads: true, imageKey: '\x16' }
  const win = { isMac: false, uploads: false, imageKey: '\x1bv' }
  const linux = { isMac: false, uploads: false, imageKey: '\x16' }
  // Finder's Cmd+C on a file: the bare name as text, the file, and its icon as an image.
  const finder = clip({ text: 'Screenshot 1.png', hasImage: true, files: 1 })
  check('Finder files on a local tab: their full paths, not the bare names', pasteAction(cmdV, finder, local), 'type-paths')
  check('Finder files on an SSH tab that sends uploads: sent to the machine', pasteAction(cmdV, finder, ssh), 'upload-files')
  check('Explorer files on a local Windows tab with bare Ctrl+V: their paths, not ^V', pasteAction(ctrlV, clip({ files: 1 }), win), 'type-paths')
  check('text is pasted', [pasteAction(cmdV, clip({ text: 'x' }), local), pasteAction(ctrlV, clip({ text: 'x' }), win)], ['text', 'text'])
  check('an image-only clipboard with Cmd+V is handed over', pasteAction(cmdV, clip({ hasImage: true }), local), 'image')
  check('Cmd+V with nothing on the clipboard is taken and does nothing', pasteAction(cmdV, clip({}), local), 'nothing')
  check('Windows Claude reads Alt+V, so bare Ctrl+V hands the image over', pasteAction(ctrlV, clip({ hasImage: true }), win), 'image')
  check('Linux bare Ctrl+V with an image is xterm’s ^V, and a draft', pasteAction(ctrlV, clip({ hasImage: true }), linux), 'xterm-image')
  check('Linux bare Ctrl+V with nothing is xterm’s', pasteAction(ctrlV, clip({}), linux), 'xterm')
  /*
   * macOS bare Ctrl+V is Claude Code's own image chord. On an SSH tab xterm's
   * ^V made the far claude read the FAR clipboard ("No image found"), while
   * Cmd+V and the menu sent the image.
   */
  check('macOS SSH tab, image on the clipboard: Ctrl+V sends it, as Cmd+V does', pasteAction(ctrlV, clip({ hasImage: true }), ssh), 'image')
  check('macOS SSH tab, copied files: Ctrl+V sends them', pasteAction(ctrlV, finder, ssh), 'upload-files')
  check('macOS SSH tab, text: Ctrl+V stays ^V (vim’s visual block, readline)', pasteAction(ctrlV, clip({ text: 'x' }), ssh), 'xterm')
  // Rich content copied from a page carries text AND an image: text wins, so ^V, never an upload.
  check('macOS SSH tab, text and an image: Ctrl+V stays ^V, nothing is uploaded', pasteAction(ctrlV, clip({ text: 'x', hasImage: true }), ssh), 'xterm-image')
  check('macOS local tab, image: Ctrl+V stays ^V, Claude’s own paste — and a draft', pasteAction(ctrlV, clip({ hasImage: true }), local), 'xterm-image')
  check('macOS local tab, files: Ctrl+V stays ^V', pasteAction(ctrlV, clip({ files: 1, text: 'a.png' }), local), 'xterm')

  console.log('\nthe right-click menu’s Paste')
  check('files on a local tab: enabled, and says what it types', pasteMenuItem(clip({ files: 1, text: 'a.png' }), false), { label: 'Paste file path', disabled: false })
  check('several on a local tab', pasteMenuItem(clip({ files: 3 }), false).label, 'Paste 3 file paths')
  check('files on an SSH tab that sends uploads', [pasteMenuItem(clip({ files: 1 }), true).label, pasteMenuItem(clip({ files: 2 }), true).label], ['Paste file', 'Paste 2 files'])
  check('text, then an image, then nothing (disabled)', [pasteMenuItem(clip({ text: 'x', hasImage: true }), false), pasteMenuItem(clip({ hasImage: true }), false), pasteMenuItem(clip({}), false)], [{ label: 'Paste', disabled: false }, { label: 'Paste image', disabled: false }, { label: 'Paste', disabled: true }])

  console.log('\na clipboard chord pressed on the chrome, after a click left focus on a button')
  const button = { hasTerminal: true, overlayOpen: false, editable: false, inPane: false, pageSelection: false, defaultPrevented: false }
  check('a paste on a chrome button goes to the terminal in front', chromeTakesChord(cmdV, button), true)
  check('a copy there copies the terminal’s selection', chromeTakesChord(cmdC, button), true)
  check('but never a copy while the page itself has text selected', chromeTakesChord(cmdC, { ...button, pageSelection: true }), false)
  check('a paste is still the terminal’s with page text selected', chromeTakesChord(cmdV, { ...button, pageSelection: true }), true)
  check('never from a field, which pastes for itself', chromeTakesChord(cmdV, { ...button, editable: true }), false)
  check('never from inside a pane (the terminal, its find bar, its strips)', chromeTakesChord(cmdV, { ...button, inPane: true }), false)
  check('never over an overlay, with no terminal, or once something took the key', [chromeTakesChord(cmdV, { ...button, overlayOpen: true }), chromeTakesChord(cmdV, { ...button, hasTerminal: false }), chromeTakesChord(cmdV, { ...button, defaultPrevented: true })], [false, false, false])

  console.log('\nthe wires (gotcha 31)')
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const tv = read('../src/renderer/src/components/TerminalView.tsx')
  const app = read('../src/renderer/src/App.tsx')
  check('TerminalView reads the chord through clipboardChord, never e.key alone', /const chord = clipboardChord\(e, IS_MAC\)/.test(tv) && !/const key = e\.key\.toLowerCase\(\)/.test(tv), true)
  check('every chord is carried out by one function, decided by copyAction and pasteAction', /switch \(copyAction\(chord, sel, term\.hasSelection\(\)\)\)/.test(tv) && /const action = pasteAction\(chord, clip, pasteCtxRef\.current\(\)\)/.test(tv), true)
  check('a taken chord is cancelled, so the browser’s own copy/paste never runs too', /if \(verdict === 'take'\) e\.preventDefault\(\)\s*return verdict === 'xterm'/.test(tv), true)
  check('swallow-clear clears the selection so a second Ctrl+C interrupts', /case 'swallow-clear':\s*term\.clearSelection\(\)\s*return 'take'/.test(tv), true)
  check('copy-clear copies and then clears the selection, so a second Ctrl+C interrupts', /case 'copy-clear':\s*window\.stoke\.clipboard\.writeText\(sel\)\s*term\.clearSelection\(\)\s*return 'take'/.test(tv), true)
  check(
    'the terminal registers that function for App’s route, as not from the key',
    /registerClipboardKeys\(tab\.ptyId, \(chord\) => runClipboardChord\(chord, false\)\)/.test(tv) && /const verdict = runClipboardChord\(chord, true\)/.test(tv) && /offClipboardKeys\(\)/.test(tv),
    true
  )
  /*
   * xterm's ^V with an image is a draft only where xterm really gets the key.
   * From App's chrome route an `xterm` answer sends nothing, so marking there
   * flagged a draft with nothing pasted.
   */
  const runPaste = /runPasteRef\.current = \(chord, clip\) => \{([\s\S]*?)\n {2}\}/.exec(tv)?.[1] ?? ''
  check(
    'xterm’s own image ^V marks a draft only from the key handler',
    runPaste.includes("case 'xterm-image':") && !/setTyped\(/.test(runPaste) && /if \(action === 'xterm-image' && fromKey\) setTyped\(tab\.ptyId, true\)/.test(tv),
    true
  )
  check('the menu’s Paste is pasteMenuItem’s, through the same route', /\.\.\.pasteMenuItem\(menu\.clip, images\.on\)/.test(tv) && /runPasteRef\.current\(\{ op: 'paste', via: IS_MAC \? 'cmd' : 'ctrl-shift' \}, menu\.clip\)/.test(tv), true)
  check(
    'App hands a chrome chord to the terminal in front only through chromeTakesChord and runClipboardKeys',
    /const chord = ptyId === null \? null : clipboardChord\(e, isMac\)/.test(app) &&
      /const takes = chromeTakesChord\(chord, \{/.test(app) &&
      /if \(takes && runClipboardKeys\(ptyId, chord\) === 'take'\) \{\s*e\.preventDefault\(\)\s*focusTerm\(ptyId\)/.test(app),
    true
  )
}

console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exit(failures ? 1 : 0)
