/*
 * The theme generator: does a seed reproduce the shipped palettes, can it
 * produce an illegible one, and does typed colour text round-trip.
 *
 * Run: npm run verify:theme-gen
 *
 * The first block is the one that matters most. `themes.ts` claims every hex in
 * it was generated from one hue plus one accent, and until `themeGen.ts` there
 * was no code in the repo that could do that -- `neutralTokens` and
 * `terminalPalette` had zero callers. So the claim was unfalsifiable. It is
 * asserted here: each built-in's twelve neutral tokens must come back
 * BYTE-IDENTICAL from the generator at the seed recorded below. That both
 * proves the claim was true and pins the generator to the palette people are
 * already looking at, so a future change to the ladder cannot quietly move six
 * shipped themes.
 */
import { BUILT_IN_THEMES, validateTheme } from '../src/shared/themes.ts'
import { buildTheme, contrastReport, GENERATED_TOKENS } from '../src/shared/themeGen.ts'
import {
  clampPageChroma,
  clampTint,
  neutralTokens,
  PAGE_CHROMA_MAX,
  TINT_DEFAULT,
  TINT_MAX
} from '../src/shared/ladder.ts'
import { format, parseNotation, NOTATIONS } from '../src/shared/notation.ts'
import { parseColor, toOklch } from '../src/shared/color.ts'
import type { ThemeColors } from '../src/shared/types.ts'

let failures = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
function ok(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

/*
 * The seeds are read off the themes themselves, not kept in a table here. Every
 * built-in now carries its `seed` (the hues were RECOVERED by sweeping every
 * half-degree for the one at which all twelve neutrals matched), which is what
 * lets the editor duplicate a built-in — and means a theme added to
 * BUILT_IN_THEMES without a seed fails here rather than silently going
 * uncovered, which the old hand list would have allowed.
 */
const SEEDS = BUILT_IN_THEMES.map((t) => {
  if (!t.seed) throw new Error(`${t.id} has no seed; every built-in must carry one`)
  return t.seed
})

const NEUTRALS = [
  'bg',
  'bgSunken',
  'bgElevated',
  'surface',
  'surfaceHover',
  'surfaceActive',
  'borderSubtle',
  'border',
  'borderStrong',
  'text',
  'textMuted',
  'textFaint'
] as const satisfies readonly (keyof ThemeColors)[]

console.log('every built-in theme regenerates from a five-field seed')
for (const s of SEEDS) {
  const want = BUILT_IN_THEMES.find((t) => t.id === s.id)!
  const got = buildTheme(s)
  const wrong = NEUTRALS.filter((k) => got.colors[k] !== want.colors[k])
  ok(
    `${want.name}: all twelve neutrals byte-identical at hue ${s.hue}`,
    wrong.length === 0,
    wrong.length ? wrong.map((k) => `${k} ${want.colors[k]}!=${got.colors[k]}`).join(' ') : ''
  )
  ok(`${want.name}: accent survives the round trip`, got.colors.accent === want.colors.accent)
  ok(
    `${want.name}: terminal background is the page and foreground is the text`,
    got.terminal.background === got.colors.bg && got.terminal.foreground === got.colors.text
  )
}

/*
 * The tint default must be a no-op, because that is the entire reason the
 * parameter could be added to a shipped ladder at all. If this fails, six
 * themes moved.
 */
console.log('\ntint 1 is exactly the historical ladder')
for (const appearance of ['dark', 'light'] as const) {
  for (const hue of [0, 55, 146, 253.5, 300]) {
    const withDefault = neutralTokens(appearance, hue)
    const explicit = neutralTokens(appearance, hue, 1)
    check(`${appearance} hue ${hue}: default === 1`, withDefault, explicit)
  }
}

console.log('\npage chroma 0 is exactly the historical ladder')
for (const appearance of ['dark', 'light'] as const) {
  for (const hue of [0, 55, 146, 253.5, 300]) {
    check(`${appearance} hue ${hue}: pageChroma 0 === omitted`, neutralTokens(appearance, hue, 1, 0), neutralTokens(appearance, hue, 1))
  }
}
check('the page chroma ceiling is per appearance', [clampPageChroma(9, 'dark'), clampPageChroma(9, 'light')], [PAGE_CHROMA_MAX.dark, PAGE_CHROMA_MAX.light])
check('and undefined is zero, so old seeds are untouched', clampPageChroma(undefined, 'dark'), 0)

console.log('\nthe page chroma actually colours the page, which the tint could not')
{
  const grey = buildTheme({ id: 'g', name: 'g', appearance: 'dark', hue: 200, tint: 1, accent: '#4ecdc4' })
  const teal = buildTheme({ id: 't', name: 't', appearance: 'dark', hue: 200, tint: 1, pageChroma: 0.03, accent: '#4ecdc4' })
  const cGrey = toOklch(parseColor(grey.colors.bg)!).c
  const cTeal = toOklch(parseColor(teal.colors.bg)!).c
  ok(`page chroma rises from ${cGrey.toFixed(4)} to ${cTeal.toFixed(4)} — past the 0.02 where Nord and Tokyo Night sit`, cTeal > 0.02)
  ok('and the borders keep their floor at that chroma', contrastReport(teal.colors, 'dark').length === 0, contrastReport(teal.colors, 'dark').map((f) => `${String(f.token)} ${f.measured.toFixed(2)}`).join(' '))
  ok('steps 6-12 are left to the tint: the text stays near-achromatic', toOklch(parseColor(teal.colors.text)!).c < 0.012)
}

console.log('\na saved seed survives hydration with its new fields')
{
  const teal = buildTheme({ id: 't2', name: 't2', appearance: 'dark', hue: 200, tint: 1, pageChroma: 0.03, black: true, accent: '#4ecdc4' })
  const back = validateTheme(JSON.parse(JSON.stringify(teal)))
  check('pageChroma comes back', back?.seed?.pageChroma, 0.03)
  check('black comes back', back?.seed?.black, true)
  const light = validateTheme(JSON.parse(JSON.stringify({ ...teal, appearance: 'light', seed: { ...teal.seed, appearance: 'light' } })))
  check('black is dropped on a light theme, which has no black ladder', light?.seed?.black, undefined)
  check('and pageChroma is clamped to the light ceiling', light?.seed?.pageChroma, PAGE_CHROMA_MAX.light)
}

console.log('\nclampTint bounds the slider rather than trusting it')
check('above the ceiling clamps', clampTint(99), TINT_MAX)
check('below the floor clamps', clampTint(-4), 0)
check('NaN falls back to the default', clampTint(Number.NaN), TINT_DEFAULT)

/*
 * The claim the whole seed-based design rests on: sliders cannot produce an
 * illegible palette. Swept rather than spot-checked, because the failure this
 * guards against is hue-specific -- RAMP's own comment records a span that left
 * two themes at Lc 14.95 "under the floor by 8-bit rounding at their particular
 * hues".
 */
console.log('\nno seed in the whole slider range produces a contrast failure')
let swept = 0
let bad: string[] = []
for (const appearance of ['dark', 'light'] as const) {
  for (let hue = 0; hue < 360; hue += 15) {
    for (const tint of [0, 0.5, 1, 1.6, 2.0, 2.25, TINT_MAX]) {
      for (const pageChroma of [0, 0.02, PAGE_CHROMA_MAX[appearance]]) {
        for (const black of appearance === 'dark' ? [false, true] : [false]) {
          const t = buildTheme({
            id: 'sweep',
            name: 'sweep',
            appearance,
            hue,
            tint,
            pageChroma,
            black,
            accent: '#ff9552'
          })
          swept++
          const findings = contrastReport(t.colors, appearance)
          if (findings.length)
            bad.push(`${appearance} h${hue} t${tint} pc${pageChroma}${black ? ' black' : ''}: ${findings.map((f) => f.token).join(',')}`)
        }
      }
    }
  }
}
ok(`${swept} seeds swept, none fails its floors`, bad.length === 0, bad.slice(0, 4).join(' | '))

/*
 * The ceiling is enforced by the generator, not merely by the slider's `max`.
 *
 * This replaced an assertion that tried to prove the floor is breached ABOVE
 * the ceiling by building themes at tint 3+. It could never have failed:
 * `buildTheme` runs `clampTint` first, so it never saw a tint above 2.5 and
 * dutifully reported no failures -- a test that passes because its input was
 * silently rewritten, which is worse than no test. The measurement that set the
 * ceiling (first failure at tint 2.85) is recorded in `ladder.ts` where the
 * constant is; what is assertable here is that the clamp is real, so a settings
 * file hand-edited to tint 9 cannot walk past it.
 */
const overTinted = buildTheme({
  id: 'hot',
  name: 'hot',
  appearance: 'dark',
  hue: 0,
  tint: 9,
  accent: '#ff9552'
})
const atCeiling = buildTheme({
  id: 'ceil',
  name: 'ceil',
  appearance: 'dark',
  hue: 0,
  tint: TINT_MAX,
  accent: '#ff9552'
})
check('an out-of-range tint is clamped, not honoured', overTinted.colors.bg, atCeiling.colors.bg)
ok('and the clamped result still clears its floors', contrastReport(overTinted.colors, 'dark').length === 0)

/*
 * ...and the counterfactual, without which the sweep above proves nothing. A
 * check that can only pass is not a check -- this repo has shipped one (gotcha
 * 50, a suite whose tally ran two thirds of the way up the file) and the lesson
 * is cheap to apply here.
 */
console.log('\nbut a hand override that breaks a floor IS reported')
const sabotaged = buildTheme({
  id: 'bad',
  name: 'bad',
  appearance: 'dark',
  hue: 55,
  tint: 1,
  accent: '#ff9552',
  // Text one shade off the page it is drawn on, and a border the same.
  overrides: { text: '#1a1918', border: '#191817' }
})
const found = contrastReport(sabotaged.colors, 'dark')
ok(
  'an unreadable text override is caught',
  found.some((f) => f.token === 'text'),
  found.map((f) => `${String(f.token)} ${f.measured.toFixed(2)}`).join(' ')
)
ok(
  'an invisible border override is caught',
  found.some((f) => f.token === 'border')
)

/*
 * The five tokens the report used to say nothing about.
 *
 * The editor offers an override on all seventeen colours and tells the user
 * "anything it breaks is reported above rather than refused" — while
 * contrastReport only ever looked at text and borders. An override setting
 * `danger` to the page's own colour, invisible at 1:1, produced an EMPTY
 * report, and so did the same on success, warning, info and accent. A report
 * that is silent on five of the tokens it covers is read as "nothing is
 * broken", which is worse than having no report.
 */
console.log('\nthe semantics and the accent are reported too')
const semanticsBroken = buildTheme({
  id: 'sem',
  name: 'sem',
  appearance: 'dark',
  hue: 55,
  tint: 1,
  accent: '#ff9552',
  // Each set to the page's own colour: as invisible as a colour can be.
  overrides: { success: '#181716', warning: '#181716', danger: '#181716', info: '#181716' }
})
const semFound = contrastReport(semanticsBroken.colors, 'dark')
for (const token of ['success', 'warning', 'danger', 'info']) {
  ok(
    `an invisible ${token} override is caught`,
    semFound.some((f) => f.token === token),
    semFound.map((f) => String(f.token)).join(' ')
  )
}
const accentBroken = buildTheme({
  id: 'acc',
  name: 'acc',
  appearance: 'dark',
  hue: 55,
  tint: 1,
  accent: '#ff9552',
  overrides: { accent: '#181716' }
})
ok(
  'and an accent that cannot be told apart from the page',
  contrastReport(accentBroken.colors, 'dark').some((f) => f.token === 'accent')
)

/*
 * And the invariant that makes the report worth reading: a GENERATED theme
 * reports nothing at all.
 *
 * This is the assertion that catches a floor set too high, which is a much
 * easier mistake than it looks. `semantic()` solves in OKLCH and then rounds to
 * 8-bit, so the shipped semantics measure Lc 63.7-64.1 against a 64 target —
 * checking the bare target fired on SIX of the twelve built-ins the first time
 * this was written. CLAUDE.md records the same trap for `borderSubtle`: a wrong
 * floor rather than wrong themes.
 */
for (const t of BUILT_IN_THEMES) {
  const findings = contrastReport(t.colors, t.appearance)
  ok(
    `${t.id}: a generated theme reports nothing`,
    findings.length === 0,
    findings.map((f) => `${String(f.token)} ${f.measured.toFixed(2)} < ${f.floor}`).join(', ')
  )
}

console.log('\noverrides reach the terminal palette, not just the page')
const overridden = buildTheme({
  id: 'ov',
  name: 'ov',
  appearance: 'dark',
  hue: 55,
  tint: 1,
  accent: '#ff9552',
  overrides: { bg: '#000000' }
})
check('terminal background follows an overridden page', overridden.terminal.background, '#000000')
ok(
  'and the ANSI slots were solved against it rather than the generated page',
  overridden.terminal.black !== BUILT_IN_THEMES[0].terminal.black
)

console.log('\nthe tint actually moves the page, which is the point of adding it')
const flat = buildTheme({ id: 'a', name: 'a', appearance: 'dark', hue: 55, tint: 1, accent: '#ff9552' })
const tinted = buildTheme({ id: 'b', name: 'b', appearance: 'dark', hue: 55, tint: 3, accent: '#ff9552' })
const flatC = toOklch(parseColor(flat.colors.bg)!).c
const tintedC = toOklch(parseColor(tinted.colors.bg)!).c
ok(
  `page chroma rises with tint (${flatC.toFixed(4)} -> ${tintedC.toFixed(4)})`,
  tintedC > flatC * 2
)
/*
 * Named because it is the measured fact behind "the themes all look the same":
 * at tint 1 a 200-degree hue swing moves the page by less than one 8-bit step,
 * so the hue control is inert until the tint is raised.
 */
const h0 = buildTheme({ id: 'c', name: 'c', appearance: 'dark', hue: 0, tint: 1, accent: '#fff' })
const h200 = buildTheme({ id: 'd', name: 'd', appearance: 'dark', hue: 200, tint: 1, accent: '#fff' })
ok(
  `at tint 1 a 200-degree hue swing barely moves the page (${h0.colors.bg} vs ${h200.colors.bg})`,
  true,
  h0.colors.bg === h200.colors.bg ? 'identical' : 'differs by rounding only'
)

console.log('\nevery generated token is a real key and the list is complete')
const sample = buildTheme({ id: 'e', name: 'e', appearance: 'dark', hue: 55, tint: 1, accent: '#ff9552' })
for (const token of GENERATED_TOKENS) {
  ok(`${token} is present and is a hex`, /^#[0-9a-f]{6}$/i.test(sample.colors[token]))
}

/*
 * Colour notation. This is the only place in Stoke that turns arbitrary typed
 * text into a colour, so it is asserted directly rather than through a
 * rendered input -- gotcha 31's rule, which is also why it lives in
 * `shared/notation.ts` rather than inside the component.
 */
console.log('\nevery notation round-trips through format -> parse')
const SAMPLES = ['#ff9552', '#181716', '#e3ddd9', '#7eb2ff', '#000000', '#ffffff']
for (const hex of SAMPLES) {
  for (const n of NOTATIONS) {
    const text = format(hex, n.id)
    const back = parseNotation(text)
    const a = parseColor(hex)!
    const b = parseColor(back ?? '#000')!
    // Hex and rgb are exact; oklch and hsl are rounded for display, so they are
    // allowed to land within one 8-bit step per channel rather than dead on.
    const slack = n.id === 'hex' || n.id === 'rgb' ? 0 : 2
    const off = Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b))
    ok(`${n.label} ${hex} -> ${text} -> ${back}`, back !== null && off <= slack, `off by ${off}`)
  }
}

console.log('\nparseNotation accepts what a person actually types')
check('bare hex', parseNotation('  #FF9552 '), '#ff9552')
check('rgb with spaces', parseNotation('rgb(255 149 82)'), '#ff9552')
/*
 * Worked by hand rather than pasted from the implementation, which is the only
 * way this assertion means anything: h=24 s=1 l=0.66 gives C=0.68, X=0.272,
 * m=0.32, and h<60 puts (C,X,0)+m at (255, 151, 82).
 */
check('hsl with commas', parseNotation('hsl(24, 100%, 66%)'), '#ff9752')
ok('oklch out of sRGB gamut is fitted, not refused', parseNotation('oklch(0.7 0.4 30)') !== null)
check('nonsense is refused', parseNotation('not a colour'), null)
check('an empty field is refused rather than becoming black', parseNotation('   '), null)

console.log(failures === 0 ? '\nall pass' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
