/**
 * Build a whole theme from a five-field seed.
 *
 * `themes.ts` has always opened by saying "EVERY VALUE BELOW IS GENERATED, not
 * picked... one hue plus one accent, run through the twelve-step ladder", and
 * told the reader to "change its hue or its accent in `scripts/`-adjacent
 * generation and regenerate". That generator is not in this repository and
 * never was: `neutralTokens` and `terminalPalette` are exported from
 * `ladder.ts` and, before this file, had **zero callers** anywhere in `src/` or
 * `scripts/`. The hexes were produced once by something that was not committed,
 * so the documented way to change a theme could not be followed and the only
 * actual way was to hand-edit a hex -- which is the one thing gotcha 43 exists
 * to forbid.
 *
 * So this is not a new capability bolted on for the theme editor. It is the
 * missing half of a design that was already written down, and the editor is
 * what makes it reachable. The same function serves both: the built-ins are
 * regenerated from seeds, and a user's custom theme is the identical call with
 * a different seed.
 *
 * Nothing here decides anything about colour. Every constant below was
 * RECOVERED by reading the shipped themes back into OKLCH rather than chosen,
 * so `buildTheme` reproduces the existing palettes rather than replacing them;
 * `verify:color` then holds them to the same floors as before.
 */
import type { Theme, ThemeColors, TerminalColors, ThemeSeed } from './types.ts'
import type { Appearance } from './ladder.ts'
import { neutralTokens, semantic, terminalPalette, TINT_DEFAULT, clampTint } from './ladder.ts'
import { deriveAccent } from './accent.ts'
import { apcaContrast, contrastRatio, parseColor, toHex, type Rgb } from './color.ts'

export type { ThemeSeed }

/**
 * The four semantic hues, and the chroma budget each is solved at.
 *
 * Recovered, not invented: these are the OKLCH hue and chroma of the values the
 * six built-in themes already ship, read back with `toOklch`. Across all six,
 * `danger` measured H 25.1-29.8, `warning` H 79.0-87.5, `info` H 250.0-250.5
 * and `success` H 140.2-154.1, at C 0.130 everywhere except light-mode warning,
 * which gamut-clips to 0.106 on its own.
 *
 * `success` is the one with real spread, because Moss had to move its success
 * off its own accent -- the two were byte-identical `#8fd67f`, so a success
 * chip and an accent chip were the same colour. 148 is Ember's and is the
 * value used here; a green-accented theme built from this generator will hit
 * the same collision, which `contrastReport` cannot see and a person can.
 */
const SEMANTIC: Record<'success' | 'warning' | 'danger' | 'info', { hue: number; chroma: number }> =
  {
    success: { hue: 148, chroma: 0.13 },
    warning: { hue: 82, chroma: 0.13 },
    danger: { hue: 29, chroma: 0.13 },
    info: { hue: 250, chroma: 0.13 }
  }

/** The alphas the terminal selection has always used, kept as they were. */
const SELECTION_ALPHA = { active: 0.28, inactive: 0.16 } as const

/**
 * The APCA contrast each semantic colour is solved to, per appearance.
 *
 * Also recovered rather than chosen, and NOT `semantic()`'s own default of 60:
 * measured against the shipped themes, all four semantics land at |Lc| 63.7-64.1
 * on every dark theme and 71.5-72.2 on every light one. The asymmetry is the
 * same one the ladder documents everywhere else -- a light page has no headroom,
 * so the same perceived separation costs more contrast -- and using the default
 * 60 here reproduced none of the twenty-four shipped values.
 */
const SEMANTIC_LC: Record<'dark' | 'light', number> = { dark: 64, light: 72 }

function rgba(hex: string, alpha: number): string {
  const c = parseColor(hex)
  if (!c) return hex
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`
}

/** Normalise any accepted colour form to `#rrggbb`, or null if unparseable. */
export function normaliseHex(input: string): string | null {
  const c = parseColor(input)
  return c ? toHex(c) : null
}

/**
 * The tokens a seed generates, in the order the editor lists them.
 *
 * Exported because the editor draws exactly this list and must not maintain its
 * own copy -- the same derive-rather-than-duplicate rule the settings nav's
 * `SECTIONS` follows, and for the same reason: two lists that are merely
 * expected to agree will not.
 */
export const GENERATED_TOKENS = [
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
  'textFaint',
  'accent',
  'success',
  'warning',
  'danger',
  'info'
] as const satisfies readonly (keyof ThemeColors)[]

/**
 * Build the full forty-three-value theme.
 *
 * The order matters in one place: `overrides` are applied to `colors` BEFORE
 * the terminal palette is built, so a theme whose `bg` or `text` was overridden
 * gets ANSI slots solved against the ground that will actually be painted. The
 * obvious alternative -- generate everything, then patch -- leaves sixteen
 * terminal colours contrast-checked against a background that is no longer
 * there, which is exactly the "nominally correct, measurably wrong" failure the
 * tint change had to avoid one layer down.
 */
export function buildTheme(seed: ThemeSeed): Theme {
  const tint = clampTint(seed.tint ?? TINT_DEFAULT)
  const accent = normaliseHex(seed.accent) ?? '#888888'
  const n = neutralTokens(seed.appearance, seed.hue, tint)

  const base: ThemeColors = {
    bg: n.bg,
    bgSunken: n.bgSunken,
    bgElevated: n.bgElevated,
    surface: n.surface,
    surfaceHover: n.surfaceHover,
    surfaceActive: n.surfaceActive,
    borderSubtle: n.borderSubtle,
    border: n.border,
    borderStrong: n.borderStrong,
    text: n.text,
    textMuted: n.textMuted,
    textFaint: n.textFaint,
    accent,
    // Placeholders: overwritten below from the resolved page. Declared because
    // `ThemeColors` requires them and a partial object here would be a lie.
    accentHover: accent,
    accentSoft: rgba(accent, 0.14),
    accentContrast: n.bg,
    success: accent,
    warning: accent,
    danger: accent,
    info: accent
  }

  // Semantics are solved against the PAGE, which may itself have been
  // overridden -- so the override is folded in first.
  const withOverrides: ThemeColors = { ...base, ...stripEmpty(seed.overrides) }
  const page = parseColor(withOverrides.bg)
  if (page) {
    for (const [key, { hue, chroma }] of Object.entries(SEMANTIC)) {
      const k = key as 'success' | 'warning' | 'danger' | 'info'
      if (seed.overrides?.[k]) continue
      withOverrides[k] = semantic(hue, chroma, page, seed.appearance, SEMANTIC_LC[seed.appearance])
    }
  }

  /*
   * `accentHover`/`accentSoft`/`accentContrast` are stored but never rendered:
   * `applyAppearance` re-derives all three (plus `--accent-ink`) at apply time,
   * so what is written here only ever shows up in a theme-preview swatch. They
   * are filled from `deriveAccent` anyway rather than left as the placeholders
   * above, so the stored object agrees with what the app will actually paint.
   */
  const derived = deriveAccent(withOverrides.accent, seed.appearance, withOverrides.bg)
  const colors: ThemeColors = {
    ...withOverrides,
    accentHover: seed.overrides?.accentHover ?? derived.accentHover,
    accentSoft: seed.overrides?.accentSoft ?? derived.accentSoft,
    accentContrast: seed.overrides?.accentContrast ?? derived.accentContrast
  }

  const ansi = terminalPalette(seed.appearance, colors.bg, colors.text)
  const terminal: TerminalColors = {
    background: colors.bg,
    foreground: colors.text,
    cursor: colors.accent,
    cursorAccent: colors.bg,
    selectionBackground: rgba(colors.accent, SELECTION_ALPHA.active),
    selectionForeground: colors.text,
    selectionInactiveBackground: rgba(colors.accent, SELECTION_ALPHA.inactive),
    ...(ansi as unknown as Omit<
      TerminalColors,
      | 'background'
      | 'foreground'
      | 'cursor'
      | 'cursorAccent'
      | 'selectionBackground'
      | 'selectionForeground'
      | 'selectionInactiveBackground'
    >)
  }

  return {
    id: seed.id,
    name: seed.name,
    appearance: seed.appearance,
    colors,
    terminal,
    seed
  }
}

/**
 * Drop blank override entries.
 *
 * An empty string is what a colour field holds while it is being retyped, and
 * spreading it over a generated value would blank the token mid-keystroke --
 * the whole palette flickering to transparent between `#` and the first digit.
 */
function stripEmpty(
  o: Partial<Record<keyof ThemeColors, string>> | undefined
): Partial<Record<keyof ThemeColors, string>> {
  if (!o) return {}
  const out: Partial<Record<keyof ThemeColors, string>> = {}
  for (const [k, v] of Object.entries(o)) {
    const hex = typeof v === 'string' ? normaliseHex(v) : null
    if (hex) out[k as keyof ThemeColors] = hex
  }
  return out
}

/* ------------------------------------------------------------- checking */

export interface ContrastFinding {
  token: keyof ThemeColors
  /** What it was measured against, for the message. */
  against: string
  /** WCAG ratio, or APCA Lc where the floor is stated in APCA. */
  measured: number
  floor: number
  scale: 'wcag' | 'apca'
}

/**
 * What a palette fails, if anything.
 *
 * This exists for `overrides`. A generated theme cannot fail these -- the
 * ladder solves the same numbers to the same floors, so running this over an
 * un-overridden seed is a tautology. The moment a token is set by hand that
 * stops being true, and the honest thing is to SHOW the cost rather than refuse
 * the value: gotcha 46's rule, do not print a diagnosis the tool can disprove,
 * and its converse -- do not silently drop an input the user deliberately gave.
 *
 * The grounds are the ones the ladder itself argues are binding, not the page.
 * `TEXT_WCAG`'s comment is explicit that solving text against `bg` is how
 * `--text-faint` came to promise 4.5:1 and measure 3.99 on a hovered row, so
 * the text rungs are checked against step 4 here for the same reason they are
 * solved against it there: dark's `surfaceHover`, light's `bgSunken`.
 */
export function contrastReport(colors: ThemeColors, appearance: Appearance): ContrastFinding[] {
  const out: ContrastFinding[] = []
  const rgb = (h: string): Rgb | null => parseColor(h)
  const ground = appearance === 'dark' ? colors.surfaceHover : colors.bgSunken
  const groundRgb = rgb(ground)
  const page = rgb(colors.bg)

  const text: [keyof ThemeColors, number][] = [
    ['text', 10],
    ['textMuted', 6],
    ['textFaint', 4.5]
  ]
  for (const [token, floor] of text) {
    const c = rgb(colors[token])
    if (!c || !groundRgb) continue
    const measured = contrastRatio(c, groundRgb)
    if (measured < floor) {
      out.push({
        token,
        against: appearance === 'dark' ? 'surfaceHover' : 'bgSunken',
        measured,
        floor,
        scale: 'wcag'
      })
    }
  }

  /*
   * Borders are judged in APCA against the page, at the Lc 15 discernibility
   * floor `RAMP`'s comment sweeps the whole ramp span to clear. WCAG has no
   * meaningful threshold for a 1px separator, which is why the two scales are
   * mixed here rather than one being used throughout.
   *
   * `borderSubtle` is deliberately NOT in this list, and leaving it out is a
   * correction rather than an omission. `RAMP`'s comment claims the floor for
   * step 7 and step 8 only, and measured across the six shipped themes
   * `borderSubtle` (step 6) sits at Lc 10.2-10.5 on every dark one -- so
   * checking it here failed all four dark built-ins, which is a wrong floor
   * rather than four wrong themes. It is the separator step; being quieter than
   * a control's own boundary is its job.
   */
  for (const token of ['border', 'borderStrong'] as const) {
    const c = rgb(colors[token])
    if (!c || !page) continue
    const measured = Math.abs(apcaContrast(c, page))
    if (measured < 15) out.push({ token, against: 'bg', measured, floor: 15, scale: 'apca' })
  }

  return out
}
