import type { Theme } from './types'

/**
 * Built-in themes.
 *
 * EVERY VALUE BELOW IS GENERATED, not picked. Each theme is one hue plus one
 * accent, run through the twelve-step ladder in `./ladder.ts`; the hexes are
 * checked in rather than computed at boot so nothing at runtime depends on the
 * colour maths, and so a diff shows what actually changed on screen.
 *
 * That is a change of kind, not of taste. The hand-picked palette these replace
 * had surface ramps uneven by 3.5x to 6.3x, borders at APCA Lc 0.00 against
 * their own page, a light theme whose elevation had collapsed to 0.033 OKLCH L
 * against a #ffffff ceiling, and a light terminal whose eight bright slots were
 * all LIGHTER than their normals so bold text was the least legible text. None
 * of those is a wrong colour; each is a missing constraint.
 *
 * To change a theme, change its hue or its accent in `scripts/`-adjacent
 * generation and regenerate. To add a token, add it to the ladder's step map --
 * `validateTheme` below will fill it into every stored custom theme.
 *
 * The house style is warm-neutral rather than pure grey: backgrounds carry a
 * few degrees of hue so the accent reads as part of the surface instead of
 * sitting on top of it.
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

/**
 * The default, and Stoke's identity: a warm near-black under an orange accent.
 *
 * The neutral hue is 56, three degrees off where the hand-picked palette
 * already sat (measured 57.9) and five off the accent's own 51 -- which is what
 * makes the orange read as part of the surface rather than pasted onto it.
 */
export const EMBER: Theme = {
  id: 'ember',
  name: 'Ember',
  appearance: 'dark',
  builtIn: true,
  colors: {
    bg: '#181716',
    bgSunken: '#0d0c0c',
    bgElevated: '#242221',
    surface: '#242221',
    surfaceHover: '#312e2d',
    surfaceActive: '#3e3b39',
    borderSubtle: '#4b4845',
    border: '#595552',
    borderStrong: '#67635f',
    text: '#e3ddd9',
    textMuted: '#b1adaa',
    textFaint: '#989592',
    accent: '#ff9552',
    accentHover: '#ffa773',
    accentSoft: 'rgba(255, 149, 82, 0.14)',
    accentContrast: '#12100e',
    success: '#77cc85',
    warning: '#e4b24d',
    danger: '#ffa092',
    info: '#7fbeff'
  },
  terminal: {
    background: '#181716',
    foreground: '#e3ddd9',
    cursor: '#ff9552',
    cursorAccent: '#181716',
    selectionBackground: 'rgba(255, 149, 82, 0.28)',
    selectionForeground: '#e3ddd9',
    selectionInactiveBackground: 'rgba(255, 149, 82, 0.16)',
    black: '#2e2a27',
    red: '#d45849',
    green: '#17933e',
    yellow: '#a27a00',
    blue: '#1883da',
    magenta: '#af61c0',
    cyan: '#008f8f',
    white: '#a49f9c',
    brightBlack: '#6c6764',
    brightRed: '#ee6f60',
    brightGreen: '#39aa54',
    brightYellow: '#be8f00',
    brightBlue: '#399af4',
    brightMagenta: '#c778d9',
    brightCyan: '#00a8a8',
    brightWhite: '#e3ddd9'
  }
}

/** Cool blue-grey, hue 254 -- four degrees off its own accent. */
export const NOCTURNE: Theme = {
  id: 'nocturne',
  name: 'Nocturne',
  appearance: 'dark',
  builtIn: true,
  colors: {
    bg: '#161719',
    bgSunken: '#0c0d0d',
    bgElevated: '#222325',
    surface: '#222325',
    surfaceHover: '#2d2f31',
    surfaceActive: '#393c3e',
    borderSubtle: '#46494c',
    border: '#53565a',
    borderStrong: '#616468',
    text: '#dbdfe3',
    textMuted: '#abaeb1',
    textFaint: '#939699',
    accent: '#7eb2ff',
    accentHover: '#92beff',
    accentSoft: 'rgba(126, 178, 255, 0.14)',
    accentContrast: '#12100e',
    success: '#6acd8e',
    warning: '#e1b34c',
    danger: '#ffa098',
    info: '#80beff'
  },
  terminal: {
    background: '#161719',
    foreground: '#dbdfe3',
    cursor: '#7eb2ff',
    cursorAccent: '#161719',
    selectionBackground: 'rgba(126, 178, 255, 0.28)',
    selectionForeground: '#dbdfe3',
    selectionInactiveBackground: 'rgba(126, 178, 255, 0.16)',
    black: '#282b2f',
    red: '#d45849',
    green: '#17933e',
    yellow: '#a27900',
    blue: '#1883da',
    magenta: '#ae61c0',
    cyan: '#008f8f',
    white: '#9da1a5',
    brightBlack: '#65696d',
    brightRed: '#ee6f60',
    brightGreen: '#39aa54',
    brightYellow: '#bd8e00',
    brightBlue: '#399af4',
    brightMagenta: '#c778d9',
    brightCyan: '#00a8a8',
    brightWhite: '#dbdfe4'
  }
}

/**
 * Green, hue 146. Its `success` no longer equals its `accent`: the two were
 * byte-identical (#8fd67f), so a success chip and an accent chip were the same
 * colour and neither meant anything. The semantic scale is solved separately
 * now, two degrees away in hue and a different lightness.
 */
export const MOSS: Theme = {
  id: 'moss',
  name: 'Moss',
  appearance: 'dark',
  builtIn: true,
  colors: {
    bg: '#161816',
    bgSunken: '#0c0d0c',
    bgElevated: '#222322',
    surface: '#222322',
    surfaceHover: '#2d2f2d',
    surfaceActive: '#3a3c3a',
    borderSubtle: '#464946',
    border: '#535753',
    borderStrong: '#616561',
    text: '#dbdfdb',
    textMuted: '#aaaeaa',
    textFaint: '#929693',
    accent: '#8fd67f',
    accentHover: '#9ae28a',
    accentSoft: 'rgba(143, 214, 127, 0.14)',
    accentContrast: '#12100e',
    success: '#77cc85',
    warning: '#ddb44b',
    danger: '#ffa091',
    info: '#7fbeff'
  },
  terminal: {
    background: '#161816',
    foreground: '#dbdfdb',
    cursor: '#8fd67f',
    cursorAccent: '#161816',
    selectionBackground: 'rgba(143, 214, 127, 0.28)',
    selectionForeground: '#dbdfdb',
    selectionInactiveBackground: 'rgba(143, 214, 127, 0.16)',
    black: '#292c29',
    red: '#d4584a',
    green: '#19943f',
    yellow: '#a27a00',
    blue: '#1883da',
    magenta: '#af61c0',
    cyan: '#008f8f',
    white: '#9da19d',
    brightBlack: '#666a66',
    brightRed: '#ee6f60',
    brightGreen: '#3bab55',
    brightYellow: '#be8f00',
    brightBlue: '#399af4',
    brightMagenta: '#c778d9',
    brightCyan: '#00a8a8',
    brightWhite: '#dbdfdb'
  }
}

/**
 * The light theme, rebuilt.
 *
 * Its neutrals used to be cool slate (measured hue 286.2, i.e. Tailwind
 * zinc-100 exactly) under a warm orange accent, on the stated reasoning that a
 * warm cream "would fight the orange accent". Two things about that.
 *
 * The reasoning does not hold. Hue distance at negligible chroma is not hue
 * conflict: zinc-100 with orange-600 is an ordinary shipped pairing, and so are
 * slate-50 with orange-600 and Radix slate-1 with tomato-9, all at equal or
 * greater separation. So warming these neutrals is an identity choice, not a
 * contrast fix, and it is made on that basis -- hue 56, the same as Ember, so
 * the light theme belongs to the same family as the dark one instead of
 * reading as a different product.
 *
 * The instinct it was protecting is still right, though, and is preserved: the
 * chroma budget tops out at 0.0078, well under the ~0.014 where the measured
 * named creams start. This is a warm grey, not a beige.
 *
 * What was actually wrong with it was structural, and is fixed by the ladder:
 * the elevation ramp had collapsed to 0.033 OKLCH L against a #ffffff ceiling,
 * and `surfaceHover` sat below `bg` while `surface` sat above it, so a button
 * crossed the page's lightness on hover.
 */
export const DAYLIGHT: Theme = {
  id: 'daylight',
  name: 'Daylight',
  appearance: 'light',
  builtIn: true,
  colors: {
    bg: '#f6f3f2',
    bgSunken: '#e6e3e1',
    bgElevated: '#fdfcfb',
    surface: '#fdfcfb',
    surfaceHover: '#eeebe9',
    surfaceActive: '#dfdbd9',
    borderSubtle: '#d7d3d0',
    border: '#d0cbc8',
    borderStrong: '#c9c3c0',
    text: '#36312f',
    textMuted: '#565250',
    textFaint: '#696563',
    accent: '#b7480a',
    accentHover: '#a93f00',
    accentSoft: 'rgba(183, 72, 10, 0.22)',
    accentContrast: '#ffffff',
    success: '#107537',
    warning: '#875e00',
    danger: '#a8473a',
    info: '#1a68ac'
  },
  terminal: {
    background: '#f6f3f2',
    foreground: '#36312f',
    cursor: '#b7480a',
    cursorAccent: '#f6f3f2',
    selectionBackground: 'rgba(183, 72, 10, 0.2)',
    selectionForeground: '#36312f',
    selectionInactiveBackground: 'rgba(183, 72, 10, 0.11)',
    black: '#36312f',
    red: '#c1463a',
    green: '#008131',
    yellow: '#8e6a00',
    blue: '#0072c5',
    magenta: '#9e50af',
    cyan: '#007c7d',
    white: '#6d6865',
    brightBlack: '#504b48',
    brightRed: '#a82e24',
    brightGreen: '#006826',
    brightYellow: '#745600',
    brightBlue: '#005da2',
    brightMagenta: '#863a97',
    brightCyan: '#006565',
    brightWhite: '#928c89'
  }
}

/**
 * Claude's own palette, offered rather than imposed.
 *
 * The accent is Anthropic's #d97757 and the neutral hue is 52, a couple of
 * degrees off it. Ember stays the default: Stoke is a shell FOR Claude Code,
 * not a reskin of it, and a distinct accent is also how you tell at a glance
 * which window you are in.
 */
export const CLAY: Theme = {
  id: 'clay',
  name: 'Clay',
  appearance: 'dark',
  builtIn: true,
  colors: {
    bg: '#181716',
    bgSunken: '#0d0c0c',
    bgElevated: '#242221',
    surface: '#242221',
    surfaceHover: '#312e2d',
    surfaceActive: '#3e3b39',
    borderSubtle: '#4b4845',
    border: '#595552',
    borderStrong: '#676260',
    text: '#e3ddd9',
    textMuted: '#b1adaa',
    textFaint: '#999592',
    accent: '#d97757',
    accentHover: '#e58261',
    accentSoft: 'rgba(217, 119, 87, 0.14)',
    accentContrast: '#ffffff',
    success: '#87ca79',
    warning: '#e4b24d',
    danger: '#ffa092',
    info: '#7fbeff'
  },
  terminal: {
    background: '#181716',
    foreground: '#e3ddd9',
    cursor: '#d97757',
    cursorAccent: '#181716',
    selectionBackground: 'rgba(217, 119, 87, 0.28)',
    selectionForeground: '#e3ddd9',
    selectionInactiveBackground: 'rgba(217, 119, 87, 0.16)',
    black: '#2e2a27',
    red: '#d45849',
    green: '#17933e',
    yellow: '#a27a00',
    blue: '#1883da',
    magenta: '#af61c0',
    cyan: '#008f8f',
    white: '#a49f9c',
    brightBlack: '#6c6764',
    brightRed: '#ee6f60',
    brightGreen: '#39aa54',
    brightYellow: '#be8f00',
    brightBlue: '#399af4',
    brightMagenta: '#c778d9',
    brightCyan: '#00a8a8',
    brightWhite: '#e3ddd9'
  }
}

/**
 * Clay's light half, from Anthropic's own #faf9f5 -- a warm off-white at hue 75.
 *
 * The accent is #d97757 darkened until it clears the page as a foreground;
 * `deriveAccent` would do that anyway, but the theme's own accent is what the
 * swatch preview draws, so it is stated here in its usable form.
 */
export const PAPER: Theme = {
  id: 'paper',
  name: 'Paper',
  appearance: 'light',
  builtIn: true,
  colors: {
    bg: '#f5f4f2',
    bgSunken: '#e6e3e1',
    bgElevated: '#fdfcfa',
    surface: '#fdfcfa',
    surfaceHover: '#edece9',
    surfaceActive: '#dedbd8',
    borderSubtle: '#d6d3d0',
    border: '#cfccc7',
    borderStrong: '#c7c4bf',
    text: '#34322e',
    textMuted: '#555350',
    textFaint: '#686562',
    accent: '#c25a35',
    accentHover: '#b64f2a',
    accentSoft: 'rgba(194, 90, 53, 0.22)',
    accentContrast: '#ffffff',
    success: '#25742e',
    warning: '#875e00',
    danger: '#a8473a',
    info: '#1a68ac'
  },
  terminal: {
    background: '#f5f4f2',
    foreground: '#34322e',
    cursor: '#c25a35',
    cursorAccent: '#f5f4f2',
    selectionBackground: 'rgba(194, 90, 53, 0.2)',
    selectionForeground: '#34322e',
    selectionInactiveBackground: 'rgba(194, 90, 53, 0.11)',
    black: '#34322e',
    red: '#c1473a',
    green: '#008232',
    yellow: '#8f6a00',
    blue: '#0072c5',
    magenta: '#9e50af',
    cyan: '#007d7e',
    white: '#6b6964',
    brightBlack: '#4e4c47',
    brightRed: '#a82e24',
    brightGreen: '#006927',
    brightYellow: '#745600',
    brightBlue: '#005da2',
    brightMagenta: '#863a97',
    brightCyan: '#006666',
    brightWhite: '#908d88'
  }
}

/*
 * Order is the order the picker draws them: the three dark house themes, then
 * the light one, then Claude's own pair. Ember stays first and stays the
 * default -- Stoke is a shell FOR Claude Code, not a reskin of it, and a
 * distinct accent is how you tell at a glance which window you are in.
 */
export const BUILT_IN_THEMES: Theme[] = [EMBER, NOCTURNE, MOSS, DAYLIGHT, CLAY, PAPER]

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
