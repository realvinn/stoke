/*
 * Keeping the tabs reachable under macOS's full-screen menu bar. Gotcha 105.
 *
 * The numbers are the ones measured on macOS 27 (MacBookPro17,1): a 30pt menu
 * bar and a 32pt title strip, 62 in all, over a 44px title bar. The pointer
 * sequences are the events a full-screen window actually received while the
 * cursor was put over the reveal and back: a `mouseout` with no relatedTarget
 * at the pointer's own y (0, 45, 61), then a `mouseover`/`mousemove` once it was
 * back on the page (63, 80).
 *
 *   node scripts/verify-fullscreen.mts
 */
import {
  FALLBACK_MENU_BAR,
  FALLBACK_TITLE_BAR,
  nextReveal,
  REVEAL_IDLE,
  REVEAL_LINGER_MS,
  revealInsetFor,
  revealsOnEntry,
  type RevealGeometry,
  type RevealInput,
  type RevealState
} from '../src/shared/fullScreenReveal.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const INSET = 62
const BAR = 44
/** Where the title bar rests: shifted, it sits under the reveal. */
const geometry = (shifted: boolean): RevealGeometry => ({ inset: INSET, barBottom: shifted ? INSET + BAR : BAR })
const move = (y: number, buttons = 0, onTitleBar = false): RevealInput => ({ kind: 'move', y, buttons, onTitleBar })
/** A move over something hanging off the title bar — a popover, its backdrop, a context menu. */
const moveOnBar = (y: number): RevealInput => move(y, 0, true)
const leave = (y: number, overNativeView = false, buttons = 0, throughEdge = false): RevealInput => ({
  kind: 'leave',
  y,
  buttons,
  overNativeView,
  throughEdge
})
/** Out through a side or the bottom of the window, to another display. */
const leaveEdge = (y: number): RevealInput => leave(y, false, 0, true)
const tick: RevealInput = { kind: 'tick', buttons: 0 }
const tickHeld: RevealInput = { kind: 'tick', buttons: 1 }
const key: RevealInput = { kind: 'key', buttons: 0 }
/**
 * Run a timed sequence from `start`, returning whether the shell is shifted
 * after each step. Each step is `[msSinceStart, input]`; a synthetic clock,
 * and nothing else here reads a real one.
 */
function run(
  start: boolean | RevealState,
  steps: [number, RevealInput][],
  g: (shifted: boolean) => RevealGeometry = geometry
): boolean[] {
  let state: RevealState = typeof start === 'boolean' ? { shifted: start, releaseAt: null, onReveal: null } : start
  return steps.map(([t, input]) => {
    state = nextReveal(state, input, g(state.shifted), t)
    return state.shifted
  })
}
/** The same, one step every 100ms, for sequences where time does not matter. */
const at = (...inputs: RevealInput[]): [number, RevealInput][] => inputs.map((e, i) => [i * 100, e])
const L = REVEAL_LINGER_MS

console.log('\nhow far the reveal reaches')
check('macOS 27, no notch: menu bar + title strip', revealInsetFor({ windowTop: 0, menuBar: 30, titleBar: 32 }), 62)
check('macOS 11–15 shape: 24 + 28', revealInsetFor({ windowTop: 0, menuBar: 24, titleBar: 28 }), 52)
check(
  'a notched Mac, full screen already under the camera housing: the strip only',
  revealInsetFor({ windowTop: 37, menuBar: 37, titleBar: 32 }),
  32
)
check(
  'menu bar set never to hide: the window starts below it, the strip only',
  revealInsetFor({ windowTop: 30, menuBar: 30, titleBar: 32 }),
  32
)
check(
  'a menu bar hidden on the desktop too still slides down in full screen: fallback, not 0',
  revealInsetFor({ windowTop: 0, menuBar: 0, titleBar: 32 }),
  FALLBACK_MENU_BAR + 32
)
check(
  'a failed title-bar probe takes the fallback',
  revealInsetFor({ windowTop: 0, menuBar: 30, titleBar: 0 }),
  30 + FALLBACK_TITLE_BAR
)
check('a bad read cannot swallow the window', revealInsetFor({ windowTop: 0, menuBar: 9000, titleBar: 32 }) <= 160, true)
check(
  'a NaN read is no read: both fallbacks, never NaN px',
  revealInsetFor({ windowTop: NaN, menuBar: NaN, titleBar: NaN }),
  FALLBACK_MENU_BAR + FALLBACK_TITLE_BAR
)

console.log('\ngoing up to the tabs')
check(
  'pressing the top edge shifts before macOS has even slid it down',
  run(false, at(move(300), move(120), move(20), move(0))),
  [false, false, false, true]
)
check(
  'approaching from below while it is already out: leaving the page at its bottom edge (61) shifts',
  run(false, at(move(300), move(80), move(63), leave(61))),
  [false, false, false, true]
)
check('a fast flick that leaves the page higher up shifts too', run(false, at(move(300), leave(45))), [false, true])
check('landing on the menu bar itself (0) shifts', run(false, at(leave(0))), [true])

console.log('\nreaching them, and leaving')
check(
  'coming off the reveal onto the moved tabs keeps them there — no chase',
  run(true, at(move(63), move(80), move(100), move(105), tick)),
  [true, true, true, true, true]
)
check('back over the reveal, still shifted', run(true, at(move(80), leave(45), move(70))), [true, true, true])
check(
  'below the shifted title bar it lingers, and goes up only once the linger is out',
  run(true, [
    [0, move(80)],
    [100, move(106)],
    [100 + L - 1, tick],
    [100 + L, tick]
  ]),
  [true, true, true, false]
)
check(
  'moving about below does not restart the linger',
  run(true, [
    [0, move(300)],
    [L - 500, move(400)],
    [L, tick]
  ]),
  [true, true, false]
)
check(
  'coming back onto the tabs inside the linger cancels it',
  run(true, [
    [0, move(300)],
    [1000, move(90)],
    [L, tick],
    [L + 5000, tick]
  ]),
  [true, true, true, true]
)
check(
  'and leaving again starts a fresh one',
  run(true, [
    [0, move(300)],
    [1000, move(90)],
    [2000, move(300)],
    [L + 1000, tick],
    [L + 2000, tick]
  ]),
  [true, true, true, true, false]
)
check(
  'going back over the reveal inside the linger cancels it too',
  run(true, [
    [0, move(300)],
    [1000, leave(40)],
    [L, tick]
  ]),
  [true, true, true]
)
check(
  'leaving for the docked browser, below the bar, lingers like any move below',
  run(true, [
    [0, leave(300, true)],
    [L, tick]
  ]),
  [true, false]
)
check(
  'the timer is the clock: a tick for the due instant releases even if it fired early',
  nextReveal({ shifted: true, releaseAt: 5000, onReveal: null }, tick, geometry(true), 5000),
  REVEAL_IDLE
)
check(
  'an unchanged state is the same object, so the caller can skip the render',
  (() => {
    const s: RevealState = { shifted: true, releaseAt: null, onReveal: null }
    return nextReveal(s, move(80), geometry(true), 0) === s
  })(),
  true
)
check(
  'after it has gone up, a pass under the unshifted bar does nothing until the reveal again',
  run(true, [
    [0, move(200)],
    [L, tick],
    [L + 100, move(50)],
    [L + 200, move(10)],
    [L + 300, leave(30)]
  ]),
  [true, false, false, false, true]
)

console.log('\nwhat is not the reveal')
check(
  'the fullscreen transition itself (out at 385, measured) is not the reveal',
  run(false, at(leave(385), move(385))),
  [false, false]
)
check(
  'leaving for the docked browser (a second page) is not the reveal, even inside the band',
  run(false, at(leave(50, true))),
  [false]
)
check('a tab drag pressed into the top edge moves nothing', run(false, at(move(0, 1))), [false])
check('a selection dragged out over the reveal moves nothing', run(false, at(leave(20, false, 1))), [false])
check(
  'a drag below the shifted bar starts no linger under itself',
  run(true, [
    [0, move(300, 1)],
    [L + 1, tick]
  ]),
  [true, true]
)
check(
  'a countdown due mid-drag waits for the button, then releases on the first buttonless event',
  run(true, [
    [0, move(300)],
    [1000, move(320, 1)],
    [L, tickHeld],
    [L + 800, move(400, 1)],
    [L + 900, move(400)]
  ]),
  [true, true, true, true, false]
)
check(
  'leaving sideways near the top, to a display beside this one, is not the reveal',
  run(false, at(move(20), leaveEdge(20))),
  [false, false]
)
check(
  'leaving sideways below the band while shifted keeps a countdown going',
  run(true, [
    [0, move(300)],
    [1000, leaveEdge(300)],
    [L, tick]
  ]),
  [true, true, false]
)
check(
  'and starts one from the tabs: a pointer on another display has nothing left to reach',
  run(true, [
    [0, moveOnBar(80)],
    [100, leaveEdge(80)],
    [100 + L, tick]
  ]),
  [true, true, false]
)
check(
  'but a sideways leave inside the band may be up into the reveal at a corner: no change',
  run(true, [
    [0, moveOnBar(80)],
    [100, leaveEdge(40)],
    [100 + L, tick]
  ]),
  [true, true, true]
)
check(
  'an open title-bar popover hangs below the bar, and using it is still at the tabs',
  run(true, [
    [0, moveOnBar(180)],
    [1000, moveOnBar(320)],
    [L + 1000, tick]
  ]),
  [true, true, true]
)
check(
  'a popover cancels a countdown already running, like the tabs themselves',
  run(true, [
    [0, move(300)],
    [1000, moveOnBar(250)],
    [L, tick]
  ]),
  [true, true, true]
)

console.log('\ntyping')
check(
  'resting on the shifted tabs and typing: the shell goes up after the linger',
  run(true, [
    [0, move(80)],
    [500, key],
    [500 + L, tick]
  ]),
  [true, true, false]
)
check(
  'a key inside a running linger does not restart it',
  run(true, [
    [0, move(300)],
    [2000, key],
    [L, tick]
  ]),
  [true, true, false]
)
check(
  'a key with the pointer up on the reveal keeps the tabs down — they are under it',
  run(false, [
    [0, leave(45)],
    [500, key],
    [500 + L, tick]
  ]),
  [true, true, true]
)
check(
  'and so does one with the pointer pressed against the top edge',
  run(false, [
    [0, move(0)],
    [500, key],
    [500 + L, tick]
  ]),
  [true, true, true]
)
check(
  'the entry shift, pointer never moved: typing takes it back up',
  run(true, [
    [0, key],
    [L, tick]
  ]),
  [true, false]
)
check('a key while not shifted does nothing', run(false, at(key, tick)), [false, false])

console.log('\nsome other window in the band')
check(
  'a banner reached inside the band shifts, and the page seeing the pointer in the band undoes it',
  run(false, at(move(200), leave(30), move(35))),
  [false, true, false]
)
check(
  'the real reveal: back onto the moved tabs is the page below the band, and keeps the shift',
  run(false, at(leave(61), move(63), move(80))),
  [true, true, true]
)
check(
  'after the tabs have been reached, a move up into the band (reveal hidden) keeps the shift',
  run(false, at(leave(61), move(80), move(40))),
  [true, true, true]
)
check(
  'an edge press followed by a move into the band is not undone — the reveal may still be coming',
  run(false, at(move(0), move(30))),
  [true, true]
)

console.log('\nwhich macOS slides it down on entry')
check('27 does (measured)', revealsOnEntry('27.0.0'), true)
check('a later one is assumed to', revealsOnEntry('28.1'), true)
check('26 is unmeasured, so no', revealsOnEntry('26.4.1'), false)
check('15 waits for the pointer', revealsOnEntry('15.6.1'), false)
check('garbage is no', revealsOnEntry(''), false)

check(
  'no inset — not full screen, not a Mac — never shifts, and drops a stale shift',
  run(true, at(move(0), leave(10)), () => ({ inset: 0, barBottom: BAR })),
  [false, false]
)

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
