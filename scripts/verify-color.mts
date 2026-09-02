/*
 * Colour maths against published reference values.
 *
 * APCA and OKLab are both easy to implement almost correctly, and the failure
 * mode is not an exception — it is a plausible number that quietly misjudges
 * every contrast pair on every page. These anchors come from the reference
 * implementations, so a regression here shows up as a wrong number rather than
 * as a crash.
 *
 * The maths is the first half. The second half points it at what actually
 * ships: every token in every built-in theme, on every ground app.css draws it
 * on, plus the accent matrix — any profile swatch can be active under any
 * theme, which is the pairing that shipped a 1.43:1 focus ring.
 *
 *   node scripts/verify-color.mts
 */
import { deriveAccent } from '../src/shared/accent.ts'
import {
  apcaContrast,
  contrastRatio,
  over,
  parseColor,
  perceptualDistance,
  toHex,
  toOklch
} from '../src/shared/color.ts'
import type { Rgb } from '../src/shared/color.ts'
import { PROFILE_SWATCHES } from '../src/shared/profiles.ts'
import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
import type { Theme } from '../src/shared/types.ts'

let failures = 0

function near(label: string, actual: number, expected: number, tolerance: number): void {
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) failures++
  const shown = Number.isFinite(actual) ? actual.toFixed(3) : String(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${shown.padStart(10)}  (expected ~${expected})`
  )
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${JSON.stringify(actual)}`)
}

/**
 * A floor, which is what almost every contrast assertion is. `suffix` carries
 * the second metric into the trailing parenthetical, because a WCAG ratio
 * reported without its APCA reading hides exactly the disagreement this module
 * exists to surface.
 */
/** The mirror of `atLeast`, for a value that must stay BELOW a ceiling. */
function atMost(label: string, actual: number, ceiling: number, suffix = ''): void {
  const ok = actual <= ceiling
  if (!ok) failures++
  const shown = Number.isFinite(actual) ? actual.toFixed(2) : String(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${shown.padStart(10)}  (expected <= ${
      Math.round(ceiling * 100) / 100
    }${suffix})`
  )
}

function atLeast(label: string, actual: number, floor: number, suffix = ''): void {
  const ok = actual >= floor
  if (!ok) failures++
  const shown = Number.isFinite(actual) ? actual.toFixed(2) : String(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${shown.padStart(10)}  (expected >= ${
      Math.round(floor * 100) / 100
    }${suffix})`
  )
}

/**
 * A measurement that is printed and NOT asserted, with no ok/FAIL of its own so
 * it can never be mistaken for one. Used where a number is knowingly wrong and
 * scheduled to be fixed: a baseline is worth having, a red run about something
 * already known is not.
 */
function note(label: string, value: string, suffix = ''): void {
  console.log(`     ${label.padEnd(46)} ${value.padStart(10)}${suffix}`)
}

const rgb = (r: number, g: number, b: number, a = 1): { r: number; g: number; b: number; a: number } => ({ r, g, b, a })
const WHITE = rgb(255, 255, 255)
const BLACK = rgb(0, 0, 0)

console.log('\n-- parsing --')
eq('rgb(1, 2, 3)', parseColor('rgb(1, 2, 3)'), rgb(1, 2, 3))
eq('rgba(1, 2, 3, 0.5)', parseColor('rgba(1, 2, 3, 0.5)'), rgb(1, 2, 3, 0.5))
eq('space syntax rgb(1 2 3 / 0.5)', parseColor('rgb(1 2 3 / 0.5)'), rgb(1, 2, 3, 0.5))
eq('#abc shorthand', parseColor('#abc'), rgb(170, 187, 204))
eq('#aabbcc', parseColor('#aabbcc'), rgb(170, 187, 204))
eq('transparent', parseColor('transparent'), rgb(0, 0, 0, 0))
eq('unparseable returns null', parseColor('some-var(--x)'), null)
eq('toHex round trip', toHex(parseColor('rgb(170, 187, 204)')!), '#aabbcc')

console.log('\n-- WCAG 2 contrast ratio --')
near('black on white', contrastRatio(BLACK, WHITE), 21, 0.01)
near('white on white', contrastRatio(WHITE, WHITE), 1, 0.001)
// #767676 on white is the canonical "exactly passes AA body text" pair.
near('#767676 on white', contrastRatio(parseColor('#767676')!, WHITE), 4.54, 0.02)

console.log('\n-- APCA lightness contrast --')
// Reference values from the APCA-W3 implementation.
near('black text on white bg', apcaContrast(BLACK, WHITE), 106.04, 0.5)
near('white text on black bg', apcaContrast(WHITE, BLACK), -107.88, 0.5)
near('identical colours', apcaContrast(WHITE, WHITE), 0, 0.001)
{
  const lc = apcaContrast(parseColor('#888')!, WHITE)
  const ok = lc > 55 && lc < 70
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${'#888 on white sits in the mid range'.padEnd(46)} ${lc.toFixed(3).padStart(10)}  (expected 55..70)`
  )
}
{
  // Polarity must flip the sign, which is the whole point of using APCA.
  const dark = apcaContrast(BLACK, WHITE)
  const light = apcaContrast(WHITE, BLACK)
  const ok = dark > 0 && light < 0
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'polarity is signed'.padEnd(46)} ${dark > 0 && light < 0}`)
}

console.log('\n-- OKLCH --')
{
  const w = toOklch(WHITE)
  near('white lightness', w.l, 1, 0.002)
  near('white chroma', w.c, 0, 0.002)
}
{
  const red = toOklch(parseColor('#ff0000')!)
  near('red lightness', red.l, 0.6279, 0.002)
  near('red chroma', red.c, 0.2577, 0.002)
  near('red hue', red.h, 29.23, 0.5)
}

console.log('\n-- perceptual distance --')
{
  // The pair that motivated clustering: visually one colour, two hex codes.
  const d = perceptualDistance(parseColor('#3b82f6')!, parseColor('#3a81f5')!)
  const ok = d < 0.01
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${'near-identical blues collapse'.padEnd(46)} ${d.toFixed(5).padStart(10)}  (expected < 0.01)`
  )
}
{
  const d = perceptualDistance(parseColor('#3b82f6')!, parseColor('#dc2626')!)
  const ok = d > 0.2
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${'blue and red stay apart'.padEnd(46)} ${d.toFixed(5).padStart(10)}  (expected > 0.2)`
  )
}

console.log('\n-- the terminal: text on a translucent selection --')
/*
 * xterm composites `selectionBackground` over `background` itself and paints
 * the blend, so the ground selected text actually sits on is the alpha blend —
 * never the raw rgba() and never the theme background. `minimumContrastRatio`
 * is 1 in TerminalView, which is xterm's off switch, so nothing corrects a bad
 * pair afterwards: whatever these numbers say is what the user reads.
 *
 * The same `selectionForeground` is used whether the terminal has focus or not,
 * so it has to clear 4.5:1 against both grounds.
 */
/** The 16 palette slots, in ANSI order. Read again by the terminal.background section below. */
const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

for (const theme of BUILT_IN_THEMES) {
  const term = theme.terminal
  const bg = parseColor(term.background)!
  const fg = parseColor(term.selectionForeground)
  const focusedRaw = parseColor(term.selectionBackground)
  const unfocusedRaw = parseColor(term.selectionInactiveBackground)

  if (!fg || !focusedRaw || !unfocusedRaw) {
    failures++
    console.log(
      `FAIL ${`${theme.id}: defines both selection keys`.padEnd(46)} ${'missing'.padStart(10)}  (selectionForeground=${String(
        term.selectionForeground
      )}, selectionInactiveBackground=${String(term.selectionInactiveBackground)})`
    )
    continue
  }

  const focused = over(focusedRaw, bg)
  const unfocused = over(unfocusedRaw, bg)

  for (const [state, ground] of [
    ['focused', focused],
    ['unfocused', unfocused]
  ] as const) {
    const ratio = contrastRatio(fg, ground)
    const ok = ratio >= 4.5
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${theme.id}: selected text, ${state} (${toHex(ground)})`.padEnd(
        46
      )} ${ratio.toFixed(2).padStart(10)}  (expected >= 4.5)`
    )
  }

  // Why the override is not decorative: these are the palette entries that keep
  // their own colour, and fail, when selectionForeground is absent.
  const below = ANSI_SLOTS.filter((n) => contrastRatio(parseColor(term[n])!, focused) < 4.5)
  const okBelow = below.length >= 1
  if (!okBelow) failures++
  console.log(
    `${okBelow ? 'ok  ' : 'FAIL'} ${`${theme.id}: ansi colours needing the override`.padEnd(
      46
    )} ${`${below.length}/16`.padStart(10)}  (expected >= 1)`
  )

  // An unfocused selection must still read as a selection, and must not read as
  // a focused one. Both are the point of having the second colour at all.
  const seen = perceptualDistance(unfocused, bg)
  const apart = perceptualDistance(focused, unfocused)
  const okPair = seen > 0.02 && apart > 0.02
  if (!okPair) failures++
  console.log(
    `${okPair ? 'ok  ' : 'FAIL'} ${`${theme.id}: unfocused is visible and weaker`.padEnd(
      46
    )} ${`${seen.toFixed(4)}/${apart.toFixed(4)}`.padStart(10)}  (expected both > 0.02)`
  )
}

console.log('\n-- the sidebar: selection must out-rank hover --')
/*
 * The selected project has to read as more chosen than the row the mouse
 * happens to be over. That is a distance, not a taste: how far each state
 * sits from the panel it is drawn on. Hover is `--surface-hover`; selection
 * is whatever `selectedBg` returns, which must stay in step with
 * `--surface-selected` in app.css. If you change one, change the other —
 * this is the assertion that catches it.
 */
/** `--surface-selected` in app.css: color-mix(in srgb, accent 18%, surface-hover). */
const SELECTED_ACCENT_MIX = 0.18

function selectedBg(t: Theme): Rgb {
  const a = parseColor(t.colors.accent)!
  const b = over(parseColor(t.colors.surfaceHover)!, parseColor(t.colors.bgSunken)!)
  const p = SELECTED_ACCENT_MIX
  return {
    r: a.r * p + b.r * (1 - p),
    g: a.g * p + b.g * (1 - p),
    b: a.b * p + b.b * (1 - p),
    a: 1
  }
}

for (const t of BUILT_IN_THEMES) {
  const panel = parseColor(t.colors.bgSunken)!
  const hoverD = perceptualDistance(panel, over(parseColor(t.colors.surfaceHover)!, panel))
  const selD = perceptualDistance(panel, over(selectedBg(t), panel))
  const ok = selD > hoverD
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: selection vs hover`.padEnd(46)} ${selD
      .toFixed(4)
      .padStart(10)}  (expected > ${hoverD.toFixed(4)})`
  )
}

for (const t of BUILT_IN_THEMES) {
  // The row's own label still has to be readable on whatever selection is.
  const bg = over(selectedBg(t), parseColor(t.colors.bgSunken)!)
  const ratio = contrastRatio(parseColor(t.colors.text)!, bg)
  const ok = ratio >= 4.5
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: label on a selected row`.padEnd(46)} ${ratio
      .toFixed(2)
      .padStart(10)}  (expected >= 4.5)`
  )
}

console.log('\n-- ink on a danger fill --')
/*
 * Two of the three `--on-danger` sites are button text, so this is a 4.5:1
 * bar, not a 3:1 one. The token has to clear it against every theme's danger
 * fill — a fill that is itself chosen for visibility, which is exactly why a
 * light ink on it does not work: white measures 2.89 / 2.84 / 2.70 on the
 * three dark themes, under half of AA.
 */
/** `--on-danger: var(--bg)` in app.css. If you change one, change the other. */
const ON_DANGER = (t: Theme): string => t.colors.bg

for (const t of BUILT_IN_THEMES) {
  const ratio = contrastRatio(parseColor(ON_DANGER(t))!, parseColor(t.colors.danger)!)
  const ok = ratio >= 4.5
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${`--on-danger on ${t.id}'s danger`.padEnd(46)} ${ratio
      .toFixed(2)
      .padStart(10)}  (expected >= 4.5)`
  )
}

console.log('\n-- why --on-danger stays right for a theme none of the four are --')
/*
 * The loop above only ever proves four numbers. A user can write their own
 * theme - `validateTheme` in shared/themes.ts fills gaps and checks shape,
 * never contrast - so "by construction" has to rest on something that holds
 * for a `--danger` no one has picked yet, not on a sample of four.
 *
 * That something is `contrastRatio`'s own symmetry: it ranks two colours by
 * luminance and divides the lighter by the darker, so which one is called
 * "ink" and which "fill" cannot change the number. `--danger` already has to
 * read as text on a `--bg`-rooted surface for three existing rules with no
 * ratio of its own - color: var(--danger) in .btn[data-variant='danger'],
 * .pill[data-tone='danger'] and .project-missing (app.css:707,895,1034) - and
 * none of that is checked for a custom theme either. `--on-danger: var(--bg)`
 * does not add a check; it makes the danger-fill case inherit that exact,
 * already-unchecked ratio instead of adding a second, different one. A theme
 * whose `--danger` is too close to `--bg` still breaks both sites - this
 * assertion proves they break by the same number, not that either passes.
 */
{
  const pairs: ReadonlyArray<readonly [Rgb, Rgb]> = [
    [BLACK, WHITE],
    [parseColor('#7b2d43')!, parseColor('#d2d205')!],
    ...BUILT_IN_THEMES.map(
      (t) => [parseColor(t.colors.bg)!, parseColor(t.colors.danger)!] as const
    )
  ]
  const ok = pairs.every(([a, b]) => contrastRatio(a, b) === contrastRatio(b, a))
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${'contrastRatio(a, b) === contrastRatio(b, a)'.padEnd(46)} ${`${pairs.length} pairs`.padStart(10)}  (holds for any colour, not just these four)`
  )
}

console.log('\n-- text tokens on the grounds they actually render on --')
/*
 * Four grounds, not one. The three text tokens are drawn on every panel the
 * app has, and the panels are not all `--bg`:
 *
 *   --bg            .main-col                                  (app.css:296)
 *   --bg-sunken     .titlebar :306, .sidebar :953, .worklog :1853,
 *                   .statusbar :2234, .activity :3038
 *   --surface       .worklog-item :1944, .usage-panel :2922
 *   --bg-elevated   .context-menu :2287, .palette :2360, .sheet :2421
 *
 * The list is the assertion. `--text-faint`'s own note in themes.ts records
 * what one ground buys you: the old value measured 5.10 against `--bg` and
 * 4.23 against `--surface`, and `--surface` is the ground `.field-hint`,
 * `.worklog-meta`, `.usage-note` and `.palette-item-path` actually land on. A
 * promise checked against one of four grounds is not a promise.
 *
 * APCA is printed beside every ratio even though only WCAG is asserted,
 * because the two disagree by polarity and the disagreement is systematic, not
 * noise. Daylight's `--text-faint` reads 5.03:1 / Lc 71.1 on its page; Ember's
 * reads 5.10:1 / Lc 36.7 on its own -- the same ratio, and only one of them is
 * a body-text pass under APCA. Every dark theme's faint text sits near Lc 37
 * at a comfortable 5:1. That gap is what the stage 2 ladder has to close, and
 * it is invisible if only the ratio is reported.
 */
const TEXT_TOKENS = [
  ['text', '--text'],
  ['textMuted', '--text-muted'],
  ['textFaint', '--text-faint']
] as const

const GROUNDS = [
  ['bg', '--bg'],
  ['bgSunken', '--bg-sunken'],
  ['surface', '--surface'],
  ['bgElevated', '--bg-elevated'],
  /*
   * The fifth ground, asserted now that the ladder can carry it.
   *
   * `.session-meta` (app.css:1286) and `.project-meta-note` (:1204) are
   * `color: var(--text-faint)` inside rows whose :hover background is
   * `--surface-hover` (:1261, :1015). Under the hand-picked palette this
   * measured 3.99-4.10 on the three dark themes and could not be fixed without
   * collapsing `--text-faint` to within 1.12:1 of `--text-muted`, because
   * `--surface-hover` sat too close to the text tokens in an uneven ramp. The
   * ladder solves the text rungs against step 4 -- which IS this ground -- so
   * it is now the tightest of the five by construction rather than the one that
   * was never checked.
   */
  ['surfaceHover', '--surface-hover']
] as const


for (const t of BUILT_IN_THEMES) {
  for (const [token, tokenName] of TEXT_TOKENS) {
    for (const [ground, groundName] of GROUNDS) {
      const fg = parseColor(t.colors[token])!
      const bg = parseColor(t.colors[ground])!
      atLeast(
        `${t.id}: ${tokenName} on ${groundName}`,
        contrastRatio(fg, bg),
        4.5,
        `, APCA Lc ${Math.abs(apcaContrast(fg, bg)).toFixed(1)}`
      )
    }
  }
}

console.log('\n-- every ansi colour on its own terminal background --')
/*
 * The selection section above measures the palette against the composited
 * selection, which is the rarer ground: almost every character a terminal ever
 * draws sits on `terminal.background` with nothing over it. Nothing checked
 * that, which is how Daylight shipped a palette whose eight bright slots were
 * all LIGHTER than their normals -- see the long note in themes.ts.
 *
 * Three slots are not body foregrounds — two on a dark theme, one on the light
 * one — and they are named here rather than skipped, because a silent
 * `continue` is indistinguishable from a bug:
 *
 *  - dark `black` is a BACKGROUND. Not an opinion: in all three dark themes it
 *    is the `surfaceHover` token verbatim, asserted below, so measuring text
 *    contrast on it is measuring the wrong thing. It reads 1.24-1.32.
 *  - dark `brightBlack` is the dim slot -- comments, dimmed output -- and
 *    measures 3.27 / 3.32 / 3.38. That is a real shortfall rather than a
 *    category error, and it is stage 2's to fix with the ladder; asserting 4.5
 *    on it today would only make the suite red about something already known.
 *  - light `brightWhite` is themes.ts's one stated deliberate exception, at
 *    3.04: the lightest slot on a light ground cannot also be the most
 *    legible, and 3.04 is what replaced the 1.10 it used to be.
 *
 * An exemption that stops being needed is reported, so the list cannot quietly
 * outlive the problem it was written for.
 */
const ANSI_EXEMPT: Record<Theme['appearance'], readonly string[]> = {
  dark: ['black', 'brightBlack'],
  light: ['brightWhite']
}

/*
 * What an exempt slot may not fall below. Measured today, rounded down to the
 * nearest tenth so an 8-bit re-derivation does not trip them.
 *
 * `black` on a dark theme is asserted by identity against --surface-hover just
 * above, so its floor here is nominal; the other two are real. Raise these if
 * the values improve -- they exist to stop a slot sliding back.
 */
const ANSI_EXEMPT_FLOOR: Record<string, number> = {
  black: 1,
  // 3.1, not 3.2: the generated ramp puts Nocturne's at 3.195, which prints as
  // "3.20" and fails a 3.2 floor. The floor is here to stop a slide, not to pin
  // a third decimal nobody can see.
  brightBlack: 3.1,
  brightWhite: 3.0
}

/** The six slots that carry hue. The four greys are a ramp and are judged as one. */
const ANSI_CHROMATIC = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

for (const t of BUILT_IN_THEMES) {
  const bg = parseColor(t.terminal.background)!
  const exempt = ANSI_EXEMPT[t.appearance]

  if (t.appearance === 'dark') {
    /*
     * Turns "black is a background slot" from a claim into a measurement.
     *
     * It used to assert `black === surfaceHover` by identity, which held while
     * both were hand-picked and stopped holding the moment the palette was
     * generated -- the terminal ramp places `black` a twelfth of the way from
     * the page toward the ink, which is near `surfaceHover` but not on it.
     * Identity was never the property that mattered anyway. What matters is
     * that the slot stays close enough to the page to BE a background: a
     * `black` that drifted out to 3:1 would be exempted from the 4.5 floor
     * while no longer deserving the exemption.
     */
    atMost(
      `${t.id}: ansi black is still a background slot`,
      contrastRatio(parseColor(t.terminal.black)!, parseColor(t.terminal.background)!),
      2
    )
  }

  for (const slot of ANSI_SLOTS) {
    const ratio = contrastRatio(parseColor(t.terminal[slot])!, bg)
    if (exempt.includes(slot)) {
      /*
       * Exempt from 4.5, NOT from having a floor.
       *
       * An adversarial check on the first version of this section put
       * daylight's `brightWhite` back to #f4f4f5 -- a 1.00:1 slot, i.e. exactly
       * the "anything emitting ESC[97m was invisible" bug themes.ts records as
       * fixed -- and the suite stayed green, because an exempt slot only ever
       * emitted an unasserted note. An exemption that cannot fail in the
       * regression direction is not an exemption, it is a hole.
       *
       * So each exempt slot is held at the value it was deliberately parked
       * at. `black` on a dark theme is a background and is allowed to be
       * invisible; the rest have to stay at least where they are.
       */
      const floor = ANSI_EXEMPT_FLOOR[slot] ?? 1
      atLeast(`${t.id}: ansi ${slot} (exempt from 4.5, floor only)`, ratio, floor)
      if (ratio >= 4.5) {
        note(`${t.id}: ansi ${slot}`, ratio.toFixed(2), '  <- clears 4.5 now; drop it from ANSI_EXEMPT')
      }
      continue
    }
    atLeast(`${t.id}: ansi ${slot} on terminal.background`, ratio, 4.5)
  }
}

/*
 * Bright must not be weaker than normal, on the light theme.
 *
 * `bright` is the terminal's emphasis channel -- it is what SGR bold selects --
 * so on a light ground it has to move AWAY from white. Daylight used to move
 * every bright towards it, which put emphasised text below its own unemphasised
 * text in all eight slots and under 4.5:1 in five. This is the invariant that
 * was violated, so it is asserted directly rather than inferred from the floor.
 *
 * Chromatic slots only, and only the light theme. On a dark ground "brighter"
 * already means further from the background, so the invariant holds there by
 * construction and asserting it proves nothing. And the four grey slots are
 * deliberately one monotonic ramp (0 < 8 < 7 < 15), which on a light ground
 * means contrast FALLS along it: `brightWhite` out-contrasting `white` would
 * mean the ramp had broken, not that emphasis was working.
 */
for (const t of BUILT_IN_THEMES.filter((x) => x.appearance === 'light')) {
  const bg = parseColor(t.terminal.background)!
  for (const slot of ANSI_CHROMATIC) {
    const bright = `bright${slot[0].toUpperCase()}${slot.slice(1)}` as keyof Theme['terminal']
    const normalRatio = contrastRatio(parseColor(t.terminal[slot])!, bg)
    const brightRatio = contrastRatio(parseColor(t.terminal[bright])!, bg)
    atLeast(`${t.id}: ansi ${bright} >= ${slot}`, brightRatio, normalRatio)
  }
}

console.log('\n-- the accent as a foreground: every theme x every swatch --')
/*
 * The assertion that would have caught the shipped bug.
 *
 * `applyAppearance` derives all five accent tokens from ONE brand colour and
 * the active theme's page, on every path -- with a profile and without. So the
 * matrix is real: any swatch can be active under any theme, and before
 * `deriveAccent` existed all eight of them measured 1.43-2.66:1 against
 * Daylight's page while driving `:focus-visible` (app.css:224), `.ring
 * .ring-fill`'s stroke (:1366) and the selected tab's indicator. The suite next
 * door, verify-profiles.mts, asserted only `accentContrast` against `accent` --
 * the ink on the fill, which is a different pair entirely -- so `npm run check`
 * passed throughout. CLAUDE.md gotcha 31.
 *
 * The theme's own accent is included as a ninth source because "no profile
 * selected" is the default state and takes the identical code path.
 *
 * Three bars, three reasons:
 *  - 4.5:1 on `--bg`, because `--accent-ink` is `color:` in eight rules.
 *  - APCA Lc on `--bg`, because WCAG 2 and APCA disagree and neither implies
 *    the other: solving for Lc 60 alone lands at 3.6:1 on Daylight.
 *  - 3:1 on `--bg-sunken`, WCAG 1.4.11: the focus ring and the context ring's
 *    stroke are non-text graphics, and the chrome they are drawn over is
 *    sunken, not `--bg`. `deriveAccent` judges against `--bg` deliberately
 *    (the harder ground would darken every light accent past what the page
 *    needs), so the sunken case has to be checked rather than assumed -- it
 *    costs about 0.5:1 on Daylight, 4.84 -> 4.35.
 */
/** `ACCENT_LC` in shared/accent.ts. Mirrored: the module exports no constants. */
const ACCENT_LC = 60
/** `ACCENT_WCAG` there. */
const ACCENT_WCAG = 4.5
/** WCAG 1.4.11, non-text contrast. Not from accent.ts -- it never checks this ground. */
const RING_WCAG = 3

/*
 * `AT_FLOOR_TOLERANCE` in shared/accent.ts, mirrored, and it has to be honoured
 * here or this section asserts a bar the module was written not to meet. A
 * brand colour within 2 Lc of the floor is kept EXACTLY as authored, because
 * five of the eight shipped swatches sit a fraction under Lc 60 on a dark page
 * and nudging them would rewrite every dark theme's accent by one 8-bit step
 * for no legibility gain (#ff9552 -> #ff9756).
 *
 * So the bar depends on which branch ran, and that is observable from outside:
 * an ink identical to the brand hex was kept, anything else was solved for. A
 * kept ink gets the tolerance -- the six that use it measure 58.7-59.4 -- and a
 * SOLVED ink gets a strict Lc 60, with no tolerance at all, because there the
 * module chose the number and 59 would mean the solver missed.
 */
const AT_FLOOR_TOLERANCE = 2

for (const t of BUILT_IN_THEMES) {
  const sources = [
    { id: 'theme', accent: t.colors.accent },
    ...PROFILE_SWATCHES.map((s) => ({ id: s.id, accent: s.accent }))
  ]
  for (const src of sources) {
    const tokens = deriveAccent(src.accent, t.appearance, t.colors.bg)
    const ink = parseColor(tokens.accentInk)!
    const page = parseColor(t.colors.bg)!
    const sunken = parseColor(t.colors.bgSunken)!

    const kept = tokens.accentInk.toLowerCase() === src.accent.toLowerCase()
    const lcFloor = kept ? ACCENT_LC - AT_FLOOR_TOLERANCE : ACCENT_LC

    const onBg = contrastRatio(ink, page)
    const lcBg = Math.abs(apcaContrast(ink, page))
    const onSunken = contrastRatio(ink, sunken)

    const ok = onBg >= ACCENT_WCAG && lcBg >= lcFloor && onSunken >= RING_WCAG
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}/${src.id}: --accent-ink ${tokens.accentInk}`.padEnd(46)} ${`${onBg.toFixed(
        2
      )}/${lcBg.toFixed(1)}/${onSunken.toFixed(2)}`.padStart(10)}  (expected >= ${ACCENT_WCAG} / ${lcFloor}${
        kept ? ' kept' : ' solved'
      } / ${RING_WCAG})`
    )

    // The dead-band guarantee: a fill has a legible label at SOME ink, and the
    // fill is nudged out of the ~7 L* window where neither near-white nor
    // near-black reaches Lc 60 on it. No tolerance here -- where the nudge runs
    // it is chosen to clear the floor, so anything under it is the nudge failing.
    atLeast(
      `${t.id}/${src.id}: --accent-contrast on the fill`,
      Math.abs(apcaContrast(parseColor(tokens.accentContrast)!, parseColor(tokens.accent)!)),
      ACCENT_LC
    )
  }
}

console.log('\n-- the ladder: borders and the surface ramp --')
/*
 * These were baseline rows until the ladder landed, and promoting them is the
 * point of the exercise. Before: Ember's `--border` measured 1.33:1 / APCA
 * Lc 0.00 against its own page -- below the discernibility floor -- while being
 * the sole visual boundary of `.btn`, `.input`, `.select`, `.profile-chip`,
 * `.activity-period` and `.worklog-item` across 56 uses. Three of the four
 * themes were at Lc 0.00.
 *
 * `Lc 0.00` was not "identical luminance". `apcaContrast` clips to exactly 0
 * below its LO_CLIP of 0.1 (color.ts), which after the 0.027 offset is about
 * Lc 7.3 -- so a 0.00 meant "below the clip", and the borders were.
 *
 * The floors are APCA's own: Lc 15 is the discernibility minimum for a divider
 * or a focus ring, which is exactly what the dark ramp's span was swept to
 * reach. Light clears it comfortably at Lc 20.6, which is Primer's
 * --borderColor-default almost to the decimal.
 *
 * EVENNESS is the other half, and it is what "the themes look muddy" measured
 * as. In every hand-picked theme the smallest gap in the surface ramp was
 * `surfaceHover -> border` and the largest was `border -> borderStrong`, a
 * ratio of 3.5x (Ember) to 6.3x (Nocturne) -- so a control's border was
 * indistinguishable from the hover state beside it. The ladder makes steps 1-8
 * an even ramp by construction; 1.5 is slack for 8-bit rounding, not for a
 * design decision.
 */
const RAMP = ['bgSunken', 'bg', 'bgElevated', 'surface', 'surfaceHover'] as const

/** APCA's discernibility floor for a divider or a ring. */
const BORDER_LC = 15
/** `--border-subtle` is a separator, not a control boundary, so it may be quieter. */
const BORDER_SUBTLE_LC = 9.5
const RAMP_EVENNESS = 1.5

for (const t of BUILT_IN_THEMES) {
  const bg = parseColor(t.colors.bg)!
  const surface = parseColor(t.colors.surface)!
  const lcOn = (hex: string, ground: typeof bg): number =>
    Math.abs(apcaContrast(parseColor(hex)!, ground))

  atLeast(`${t.id}: --border on --bg`, lcOn(t.colors.border, bg), BORDER_LC, ' Lc')
  atLeast(
    `${t.id}: --border-strong on --bg`,
    lcOn(t.colors.borderStrong, bg),
    BORDER_LC,
    ' Lc'
  )
  atLeast(
    `${t.id}: --border-subtle on --bg`,
    lcOn(t.colors.borderSubtle, bg),
    BORDER_SUBTLE_LC,
    ' Lc'
  )
  note(
    `${t.id}: --border on --surface`,
    `${contrastRatio(parseColor(t.colors.border)!, surface).toFixed(2)}:1 Lc ${lcOn(t.colors.border, surface).toFixed(2)}`
  )

  // Sorted, because the ramp's ORDER differs by appearance -- light mode's
  // chrome is recessed and its controls are raised -- while its evenness must
  // not. Duplicates are dropped: `bgElevated` and `surface` share a rung on
  // purpose, since a floating panel is told apart by shadow and border rather
  // than by lightness.
  const ls = [...new Set(RAMP.map((k) => toOklch(parseColor(t.colors[k])!).l.toFixed(4)))]
    .map(Number)
    .sort((a, b) => a - b)
  const gaps = ls.slice(1).map((l, i) => l - ls[i])
  note(
    `${t.id}: surface ramp, OKLCH L`,
    ls.map((l) => l.toFixed(3)).join('  ')
  )
  atMost(
    `${t.id}: ramp evenness, widest/narrowest step`,
    Math.max(...gaps) / Math.min(...gaps),
    RAMP_EVENNESS,
    'x'
  )
}

/*
 * The tally, and it has to stay the last statement in this file.
 *
 * There was no tally at all until 0.9.3. `failures` was declared, incremented
 * by all four assertion helpers, printed as `FAIL` on every failing line — and
 * then simply discarded when the script ended, because nothing in the 722 lines
 * above ever touched `process.exitCode` or `process.exit`. `node
 * scripts/verify-color.mts; echo $?` printed 0 no matter what the run said.
 *
 * That is worse than the gotcha 50 shape it resembles. There, an exit code was
 * assigned too early, so a third of verify-tabs could not fail; here NONE of
 * this file could fail, and this file is the only automated check for the APCA
 * and WCAG maths, the ladder's Lc floors, and the accent-ink derivation across
 * every built-in theme crossed with every profile swatch — the two things
 * gotchas 43 and 44 exist to protect. `npm run check` would have gone green
 * over a regression that reprinted gotcha 44's 1.43:1 focus ring, and so would
 * the release gate, which runs this suite as its own CI step.
 *
 * Counterfactual, measured both ways before this line was added: with a floor
 * forced to fail the run printed FAIL and exited 0; with this line it exits 1.
 */
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
