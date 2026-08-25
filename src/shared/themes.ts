import type { Theme } from './types'

/**
 * Built-in themes.
 *
 * The house style is warm-neutral rather than pure grey: backgrounds carry a
 * few degrees of hue so the orange accent reads as part of the surface instead
 * of sitting on top of it. Every theme must define the full token set — the
 * renderer writes them straight out as CSS custom properties.
 *
 * ONE EXCEPTION, and it is worth knowing before editing an accent here.
 * `accent` is an input; `accentHover`, `accentSoft` and `accentContrast` are
 * not. `applyAppearance` runs `deriveAccent` (src/shared/accent.ts) after
 * writing these and overwrites all three, plus a fifth token `--accent-ink`
 * that no theme declares. So editing `accentHover` in this file changes
 * nothing that renders, and editing `accent` changes all four.
 *
 * They are kept rather than deleted because `Theme` is a public shape: it is
 * what a user's `customThemes` entry in settings.json looks like, and
 * `validateTheme` fills missing keys from these built-ins. Removing them would
 * silently invalidate every theme anyone has already written by hand.
 */

export const EMBER: Theme = {
  id: 'ember',
  name: 'Ember',
  appearance: 'dark',
  builtIn: true,
  colors: {
    bg: '#14110f',
    bgSunken: '#0e0c0b',
    bgElevated: '#1c1815',
    surface: '#221d1a',
    surfaceHover: '#2b2521',
    border: '#302a25',
    borderStrong: '#443b34',
    text: '#f2e9e1',
    textMuted: '#a89c92',
    /*
     * >=4.5:1 on four of the FIVE grounds it is drawn on. The fifth is still
     * short, and is named here rather than left to be rediscovered.
     *
     * This comment used to promise 4.5:1 "on bg", and the value delivered
     * exactly that: 5.10 there and 4.23 on `surface`, which is the ground
     * `.field-hint`, `.worklog-meta`, `.usage-note` and `.palette-item-path`
     * actually render against. Raising it fixed `bg`, `bgSunken`, `surface`
     * and `bgElevated` -- and an adversarial check then found the same mistake
     * one ground later: `.session-meta` (app.css:1286) and
     * `.project-meta-note` (:1204) are `color: var(--text-faint)` inside rows
     * whose :hover background is `--surface-hover` (:1015, :1261). There it
     * still measures 4.10 (Ember), 4.01 (Nocturne) and 3.99 (Moss) -- under the
     * bar. Daylight clears it at 4.77.
     *
     * It is not raised further on purpose. Clearing `--surface-hover` too
     * needs #978a81, which lands 1.25:1 from `--text-muted` (1.12 on Nocturne)
     * -- the two text tiers become the same grey, always, to fix a ratio that
     * is wrong only while the pointer is over the row. The real defect is that
     * `--surface-hover` sits too close to the text tokens at all, because the
     * surface ramp is uneven: `surfaceHover -> border` is the smallest step in
     * every dark theme (0.012-0.020 OKLCH L) while `border -> borderStrong` is
     * the largest (0.070-0.076). The 12-step ladder fixes the ramp, and this
     * value gets revisited then. verify:color prints the shortfall as a
     * baseline row so it cannot be forgotten, and promotes it to an assertion
     * in the same change as the ladder.
     */
    textFaint: '#8f837a',
    accent: '#ff9552',
    accentHover: '#ffab74',
    accentSoft: 'rgba(255, 149, 82, 0.14)',
    accentContrast: '#1a1108',
    success: '#7fc98a',
    warning: '#e8b552',
    danger: '#f2705f',
    info: '#79aee0'
  },
  terminal: {
    background: '#14110f',
    foreground: '#f2e9e1',
    cursor: '#ff9552',
    cursorAccent: '#14110f',
    selectionBackground: 'rgba(255, 149, 82, 0.28)',
    selectionForeground: '#f2e9e1',
    selectionInactiveBackground: 'rgba(255, 149, 82, 0.16)',
    black: '#2b2521',
    red: '#f2705f',
    green: '#7fc98a',
    yellow: '#e8b552',
    blue: '#79aee0',
    magenta: '#c79ae0',
    cyan: '#6fc9c1',
    white: '#d9cdc3',
    brightBlack: '#6f645c',
    brightRed: '#ff8b7b',
    brightGreen: '#9be0a5',
    brightYellow: '#ffd07a',
    brightBlue: '#9cc9f0',
    brightMagenta: '#dcb4f2',
    brightCyan: '#8fe0d8',
    brightWhite: '#fff6ee'
  }
}

export const NOCTURNE: Theme = {
  id: 'nocturne',
  name: 'Nocturne',
  appearance: 'dark',
  builtIn: true,
  colors: {
    bg: '#0d1117',
    bgSunken: '#090d13',
    bgElevated: '#141b24',
    surface: '#19212b',
    surfaceHover: '#212b37',
    border: '#242e3a',
    borderStrong: '#35424f',
    text: '#e4ebf3',
    textMuted: '#8d9bab',
    textFaint: '#7c8995',
    accent: '#6ea8fe',
    accentHover: '#8fbdff',
    accentSoft: 'rgba(110, 168, 254, 0.14)',
    accentContrast: '#08131f',
    success: '#5fd18c',
    warning: '#e5b95c',
    danger: '#f2726b',
    info: '#6ea8fe'
  },
  terminal: {
    background: '#0d1117',
    foreground: '#e4ebf3',
    cursor: '#6ea8fe',
    cursorAccent: '#0d1117',
    selectionBackground: 'rgba(110, 168, 254, 0.28)',
    selectionForeground: '#e4ebf3',
    selectionInactiveBackground: 'rgba(110, 168, 254, 0.16)',
    black: '#212b37',
    red: '#f2726b',
    green: '#5fd18c',
    yellow: '#e5b95c',
    blue: '#6ea8fe',
    magenta: '#b98ce8',
    cyan: '#5cc9c9',
    white: '#c8d3df',
    brightBlack: '#5b6875',
    brightRed: '#ff8f88',
    brightGreen: '#84e5ab',
    brightYellow: '#ffd484',
    brightBlue: '#9cc4ff',
    brightMagenta: '#d3aef5',
    brightCyan: '#82e0e0',
    brightWhite: '#f4f9ff'
  }
}

export const MOSS: Theme = {
  id: 'moss',
  name: 'Moss',
  appearance: 'dark',
  builtIn: true,
  colors: {
    bg: '#101511',
    bgSunken: '#0a0d0a',
    bgElevated: '#161d17',
    surface: '#1b241c',
    surfaceHover: '#232e24',
    border: '#263127',
    borderStrong: '#374536',
    text: '#e7f0e6',
    textMuted: '#93a291',
    textFaint: '#7e8c7c',
    accent: '#8fd67f',
    accentHover: '#aae59c',
    accentSoft: 'rgba(143, 214, 127, 0.14)',
    accentContrast: '#0c1509',
    success: '#8fd67f',
    warning: '#e0bd63',
    danger: '#ee7d6d',
    info: '#78bcd6'
  },
  terminal: {
    background: '#101511',
    foreground: '#e7f0e6',
    cursor: '#8fd67f',
    cursorAccent: '#101511',
    selectionBackground: 'rgba(143, 214, 127, 0.26)',
    selectionForeground: '#e7f0e6',
    selectionInactiveBackground: 'rgba(143, 214, 127, 0.15)',
    black: '#232e24',
    red: '#ee7d6d',
    green: '#8fd67f',
    yellow: '#e0bd63',
    blue: '#78bcd6',
    magenta: '#bb9ad9',
    cyan: '#6fc9ba',
    white: '#cdd8cb',
    brightBlack: '#606d5f',
    brightRed: '#ff988a',
    brightGreen: '#a9e79a',
    brightYellow: '#f2d585',
    brightBlue: '#9ad4ea',
    brightMagenta: '#d4b8ee',
    brightCyan: '#8fe0d2',
    brightWhite: '#f4fbf3'
  }
}

/**
 * Deliberately a neutral off-white rather than a warm cream: the cream/sand/
 * beige band is the default "warm light theme" reflex, and it would fight the
 * orange accent instead of letting it carry the identity.
 */
export const DAYLIGHT: Theme = {
  id: 'daylight',
  name: 'Daylight',
  appearance: 'light',
  builtIn: true,
  colors: {
    bg: '#f4f4f5',
    bgSunken: '#e8e8ea',
    bgElevated: '#ffffff',
    surface: '#fafafa',
    surfaceHover: '#eeeef0',
    border: '#dedee1',
    borderStrong: '#c3c3c8',
    text: '#1c1c1f',
    textMuted: '#5c5c63',
    textFaint: '#68686f',
    accent: '#b7480a',
    accentHover: '#963a06',
    accentSoft: 'rgba(183, 72, 10, 0.10)',
    accentContrast: '#ffffff',
    success: '#2f7d45',
    warning: '#8a6212',
    danger: '#b3372a',
    info: '#2a5f96'
  },
  terminal: {
    background: '#f4f4f5',
    foreground: '#1c1c1f',
    cursor: '#b7480a',
    cursorAccent: '#f4f4f5',
    selectionBackground: 'rgba(183, 72, 10, 0.18)',
    selectionForeground: '#1c1c1f',
    selectionInactiveBackground: 'rgba(183, 72, 10, 0.10)',
    /*
     * A light ANSI palette is not a dark one with the background swapped, and
     * three things about it are counter-intuitive enough to state.
     *
     * 1. BRIGHT IS DARKER. `bright` is the terminal's emphasis channel -- it is
     *    what SGR bold selects -- so it has to gain contrast, and on a light
     *    ground that means moving away from white. This palette used to do the
     *    opposite: all eight brights were LIGHTER than their normals, so
     *    contrast fell in all eight (green 4.61 -> 3.38, cyan 5.41 -> 3.77) and
     *    five of them landed under 4.5:1. Emphasised text was the least legible
     *    text on screen. Every bright is now 8-9 L* darker than its normal.
     *
     * 2. THE GREYS ARE A RAMP, NOT A POLARITY. `white` was #dedee1 at 1.22:1
     *    and `brightWhite` #ffffff at 1.10:1 -- anything emitting ESC[37m or
     *    ESC[97m was invisible. Slots 0/8/7/15 are now one monotonic ramp from
     *    darkest to lightest, which is what GitHub Light does, so no slot is
     *    unreadable and the relative ordering a program expects survives.
     *
     *    The alternative -- Catppuccin Latte and Rosé Pine Dawn invert the pair
     *    outright, making `black` a light grey -- was measured and rejected: it
     *    does not fix the problem, it moves it, leaving `black` at 1.52:1 and
     *    `brightBlack` at 2.37:1 instead. `brightWhite` at 3.04:1 is the one
     *    deliberate exception here, because the lightest slot on a light ground
     *    cannot also be the most legible. That is inherent, and 3.04 beats 1.10.
     *
     * 3. CHROMA IS PER HUE, NOT GLOBAL. At L* ~47 sRGB allows far more chroma
     *    for red and magenta than for yellow or cyan, so each slot takes the
     *    largest chroma its own hue can hold at the lightness that clears both
     *    4.5:1 and APCA Lc 60. All twelve chromatic slots clear both.
     */
    black: '#26262a',
    red: '#cc2418',
    green: '#04813a',
    yellow: '#936700',
    blue: '#2b72ba',
    magenta: '#954aaf',
    cyan: '#007d78',
    white: '#6f6f76',
    brightBlack: '#55555c',
    brightRed: '#ad0500',
    brightGreen: '#00692d',
    brightYellow: '#785300',
    brightBlue: '#0e5ca1',
    brightMagenta: '#7e3397',
    brightCyan: '#006560',
    brightWhite: '#8c8c94'
  }
}

export const BUILT_IN_THEMES: Theme[] = [EMBER, NOCTURNE, MOSS, DAYLIGHT]

export const DEFAULT_THEME_ID = EMBER.id

export function resolveTheme(id: string, custom: Theme[]): Theme {
  return (
    custom.find((t) => t.id === id) ??
    BUILT_IN_THEMES.find((t) => t.id === id) ??
    EMBER
  )
}

/**
 * Repair a persisted theme, or drop it.
 *
 * A theme is applied by writing whatever keys are on the object onto `:root`,
 * and `app.css` declares no fallbacks for the colour tokens. So a theme missing
 * a key does not fail loudly - it renders an app with invisible text, or throws
 * during boot before there is a window to show an error in. Themes also carry
 * no version field, so a token added in a later release is simply absent from
 * every theme a user already saved.
 *
 * Every missing token is therefore filled from the built-in with the same
 * appearance. Only something that cannot be identified at all is dropped, and
 * this must never throw: it runs inside `hydrate`, before the window exists.
 *
 * `builtIn` is deliberately NOT carried through. This only ever runs on themes
 * read from `settings.json`, and a stored theme claiming to be built-in would
 * present as uneditable and undeletable in the editor with no way to undo it.
 */
export function validateTheme(input: unknown): Theme | null {
  try {
    if (!input || typeof input !== 'object') return null
    const t = input as Partial<Theme>
    if (typeof t.id !== 'string' || !t.id) return null

    const appearance: Theme['appearance'] = t.appearance === 'light' ? 'light' : 'dark'
    const base = appearance === 'light' ? DAYLIGHT : EMBER
    const colors = (t.colors ?? {}) as Partial<Theme['colors']>
    const terminal = (t.terminal ?? {}) as Partial<Theme['terminal']>

    const pick = <T extends object>(from: Partial<T>, fallback: T): T => {
      const out = { ...fallback }
      for (const key of Object.keys(fallback) as (keyof T)[]) {
        const v = from[key]
        if (typeof v === 'string' && v.trim()) out[key] = v as T[keyof T]
      }
      return out
    }

    return {
      id: t.id,
      name: typeof t.name === 'string' && t.name.trim() ? t.name : t.id,
      appearance,
      colors: pick(colors, base.colors),
      terminal: pick(terminal, base.terminal)
    }
  } catch {
    return null
  }
}
