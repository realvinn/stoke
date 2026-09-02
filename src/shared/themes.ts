import type { Theme, ThemeSeed } from './types'
import { clampPageChroma, clampTint, TINT_DEFAULT } from './ladder.ts'

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
 * To change a theme, change its `seed` and regenerate the literal with
 * `node scripts/gen-themes.mts <id>`; `verify:theme-gen` fails until the pasted
 * hexes match the seed again. To add a token, add it to the ladder's step map --
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
  seed: { id: 'ember', name: 'Ember', appearance: 'dark', hue: 55, tint: 1, accent: '#ff9552' },
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
  seed: { id: 'nocturne', name: 'Nocturne', appearance: 'dark', hue: 253.5, tint: 1, accent: '#7eb2ff' },
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
  seed: { id: 'moss', name: 'Moss', appearance: 'dark', hue: 146, tint: 1, accent: '#8fd67f' },
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
  seed: { id: 'daylight', name: 'Daylight', appearance: 'light', hue: 55, tint: 1, accent: '#b7480a' },
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
  seed: { id: 'clay', name: 'Clay', appearance: 'dark', hue: 50.5, tint: 1, accent: '#d97757' },
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
  seed: { id: 'paper', name: 'Paper', appearance: 'light', hue: 74.5, tint: 1, accent: '#c25a35' },
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

/**
 * Amber on true black. A `black` ladder starts step 1 at L 0, so on an OLED
 * panel the chrome disappears and the terminal card is the only lit surface.
 *
 * Generated from its seed by scripts/gen-themes.mts.
 */
export const LANTERN: Theme = {
  id: 'lantern',
  name: 'Lantern',
  appearance: 'dark',
  builtIn: true,
  seed: {
    id: 'lantern',
    name: 'Lantern',
    appearance: 'dark',
    hue: 80,
    tint: 1.4,
    black: true,
    accent: '#f7c948'
  },
  colors: {
    bg: '#0e0d0b',
    bgSunken: '#040303',
    bgElevated: '#1b1917',
    surface: '#1b1917',
    surfaceHover: '#292723',
    surfaceActive: '#373531',
    borderSubtle: '#47443f',
    border: '#56534e',
    borderStrong: '#67635d',
    text: '#d8d3cc',
    textMuted: '#a7a49f',
    textFaint: '#908d87',
    accent: '#f7c948',
    accentHover: '#ffd568',
    accentSoft: 'rgba(247, 201, 72, 0.14)',
    accentContrast: '#12100e',
    success: '#76cb84',
    warning: '#e3b14c',
    danger: '#ff9f90',
    info: '#7dbeff'
  },
  terminal: {
    background: '#0e0d0b',
    foreground: '#d8d3cc',
    cursor: '#f7c948',
    cursorAccent: '#0e0d0b',
    selectionBackground: 'rgba(247, 201, 72, 0.28)',
    selectionForeground: '#d8d3cc',
    selectionInactiveBackground: 'rgba(247, 201, 72, 0.16)',
    red: '#cd5244',
    brightRed: '#e8695a',
    green: '#078d38',
    brightGreen: '#32a44e',
    yellow: '#9a7400',
    brightYellow: '#b68900',
    blue: '#0c7dd4',
    brightBlue: '#3194ed',
    magenta: '#a85bba',
    brightMagenta: '#c071d2',
    cyan: '#008888',
    brightCyan: '#00a1a1',
    black: '#23201c',
    brightBlack: '#65625e',
    white: '#989590',
    brightWhite: '#d7d3ce'
  }
}

/**
 * Achromatic, true black, a pale accent: the high-contrast mono. Tint 0 makes
 * every neutral a pure grey, and the black ladder does for it what it does for
 * Lantern.
 *
 * Generated from its seed by scripts/gen-themes.mts.
 */
export const GRAPHITE: Theme = {
  id: 'graphite',
  name: 'Graphite',
  appearance: 'dark',
  builtIn: true,
  seed: {
    id: 'graphite',
    name: 'Graphite',
    appearance: 'dark',
    hue: 0,
    tint: 0,
    black: true,
    accent: '#e8e8e8'
  },
  colors: {
    bg: '#0d0d0d',
    bgSunken: '#030303',
    bgElevated: '#191919',
    surface: '#191919',
    surfaceHover: '#272727',
    surfaceActive: '#353535',
    borderSubtle: '#444444',
    border: '#535353',
    borderStrong: '#636363',
    text: '#d4d4d4',
    textMuted: '#a5a5a5',
    textFaint: '#8d8d8d',
    accent: '#e8e8e8',
    accentHover: '#f4f4f4',
    accentSoft: 'rgba(232, 232, 232, 0.14)',
    accentContrast: '#12100e',
    success: '#76cb84',
    warning: '#e3b14c',
    danger: '#ff9f90',
    info: '#7dbeff'
  },
  terminal: {
    background: '#0d0d0d',
    foreground: '#d4d4d4',
    cursor: '#e8e8e8',
    cursorAccent: '#0d0d0d',
    selectionBackground: 'rgba(232, 232, 232, 0.28)',
    selectionForeground: '#d4d4d4',
    selectionInactiveBackground: 'rgba(232, 232, 232, 0.16)',
    red: '#cd5244',
    brightRed: '#e8695a',
    green: '#078d38',
    brightGreen: '#32a44e',
    yellow: '#9a7400',
    brightYellow: '#b68900',
    blue: '#0c7dd4',
    brightBlue: '#3194ed',
    magenta: '#a85bba',
    brightMagenta: '#c071d2',
    cyan: '#008888',
    brightCyan: '#00a1a1',
    black: '#22201c',
    brightBlack: '#64635e',
    white: '#979590',
    brightWhite: '#d6d4ce'
  }
}

/**
 * Deep teal, the first theme built on `pageChroma`. At C 0.03 the page is in
 * the range Nord, Dracula and Tokyo Night occupy, which no tint could reach.
 *
 * Generated from its seed by scripts/gen-themes.mts.
 */
export const LAGOON: Theme = {
  id: 'lagoon',
  name: 'Lagoon',
  appearance: 'dark',
  builtIn: true,
  seed: {
    id: 'lagoon',
    name: 'Lagoon',
    appearance: 'dark',
    hue: 200,
    tint: 1,
    pageChroma: 0.03,
    accent: '#4ecdc4'
  },
  colors: {
    bg: '#041b1d',
    bgSunken: '#001011',
    bgElevated: '#0f2728',
    surface: '#0f2728',
    surfaceHover: '#1c3435',
    surfaceActive: '#284042',
    borderSubtle: '#45494a',
    border: '#525757',
    borderStrong: '#5f6565',
    text: '#dae2e2',
    textMuted: '#abb0b0',
    textFaint: '#929898',
    accent: '#4ecdc4',
    accentHover: '#5bd8cf',
    accentSoft: 'rgba(78, 205, 196, 0.14)',
    accentContrast: '#12100e',
    success: '#78cd86',
    warning: '#e5b24e',
    danger: '#ffa194',
    info: '#80bfff'
  },
  terminal: {
    background: '#041b1d',
    foreground: '#dae2e2',
    cursor: '#4ecdc4',
    cursorAccent: '#041b1d',
    selectionBackground: 'rgba(78, 205, 196, 0.28)',
    selectionForeground: '#dae2e2',
    selectionInactiveBackground: 'rgba(78, 205, 196, 0.16)',
    red: '#d5584a',
    brightRed: '#ef7060',
    green: '#19943f',
    brightGreen: '#3bab55',
    yellow: '#a27a00',
    brightYellow: '#be8f00',
    blue: '#1983db',
    brightBlue: '#399bf4',
    magenta: '#af62c1',
    brightMagenta: '#c879da',
    cyan: '#008f8f',
    brightCyan: '#00a8a8',
    black: '#272c2c',
    brightBlack: '#646b6b',
    white: '#9ca3a3',
    brightWhite: '#dae2e2'
  }
}

/**
 * Plum, the same page chroma as Lagoon at hue 350.
 *
 * Generated from its seed by scripts/gen-themes.mts.
 */
export const ROSE: Theme = {
  id: 'rose',
  name: 'Rosé',
  appearance: 'dark',
  builtIn: true,
  seed: {
    id: 'rose',
    name: 'Rosé',
    appearance: 'dark',
    hue: 350,
    tint: 1,
    pageChroma: 0.03,
    accent: '#f78ec1'
  },
  colors: {
    bg: '#221119',
    bgSunken: '#16070e',
    bgElevated: '#2e1d25',
    surface: '#2e1d25',
    surfaceHover: '#3b2931',
    surfaceActive: '#48353e',
    borderSubtle: '#4b4749',
    border: '#595456',
    borderStrong: '#676264',
    text: '#e2dcde',
    textMuted: '#b0acad',
    textFaint: '#989495',
    accent: '#f78ec1',
    accentHover: '#ff9ccb',
    accentSoft: 'rgba(247, 142, 193, 0.14)',
    accentContrast: '#12100e',
    success: '#77cc85',
    warning: '#e4b24d',
    danger: '#ffa192',
    info: '#80bfff'
  },
  terminal: {
    background: '#221119',
    foreground: '#e2dcde',
    cursor: '#f78ec1',
    cursorAccent: '#221119',
    selectionBackground: 'rgba(247, 142, 193, 0.28)',
    selectionForeground: '#e2dcde',
    selectionInactiveBackground: 'rgba(247, 142, 193, 0.16)',
    red: '#d45749',
    brightRed: '#ee6f5f',
    green: '#17933e',
    brightGreen: '#39aa54',
    yellow: '#a17900',
    brightYellow: '#bd8e00',
    blue: '#1782d9',
    brightBlue: '#3799f3',
    magenta: '#ae60c0',
    brightMagenta: '#c677d8',
    cyan: '#008e8e',
    brightCyan: '#00a7a7',
    black: '#2e292b',
    brightBlack: '#6c6668',
    white: '#a49ea0',
    brightWhite: '#e3dcde'
  }
}

/**
 * Navy: Nocturne's hue with a coloured page, the Tokyo Night class.
 *
 * Generated from its seed by scripts/gen-themes.mts.
 */
export const INK: Theme = {
  id: 'ink',
  name: 'Ink',
  appearance: 'dark',
  builtIn: true,
  seed: {
    id: 'ink',
    name: 'Ink',
    appearance: 'dark',
    hue: 250,
    tint: 1,
    pageChroma: 0.03,
    accent: '#7eb2ff'
  },
  colors: {
    bg: '#0c1825',
    bgSunken: '#040d19',
    bgElevated: '#182431',
    surface: '#182431',
    surfaceHover: '#23303e',
    surfaceActive: '#303d4b',
    borderSubtle: '#46494c',
    border: '#53565a',
    borderStrong: '#606468',
    text: '#dadfe3',
    textMuted: '#aaaeb1',
    textFaint: '#929699',
    accent: '#7eb2ff',
    accentHover: '#91beff',
    accentSoft: 'rgba(126, 178, 255, 0.14)',
    accentContrast: '#12100e',
    success: '#78cc85',
    warning: '#e4b24d',
    danger: '#ffa192',
    info: '#80bfff'
  },
  terminal: {
    background: '#0c1825',
    foreground: '#dadfe3',
    cursor: '#7eb2ff',
    cursorAccent: '#0c1825',
    selectionBackground: 'rgba(126, 178, 255, 0.28)',
    selectionForeground: '#dadfe3',
    selectionInactiveBackground: 'rgba(126, 178, 255, 0.16)',
    red: '#d45849',
    brightRed: '#ee6f60',
    green: '#17933e',
    brightGreen: '#39aa54',
    yellow: '#a27a00',
    brightYellow: '#be8f00',
    blue: '#1883da',
    brightBlue: '#399af4',
    magenta: '#af61c0',
    brightMagenta: '#c778d9',
    cyan: '#008f8f',
    brightCyan: '#00a8a8',
    black: '#282c2f',
    brightBlack: '#64696d',
    white: '#9ca1a5',
    brightWhite: '#dadfe3'
  }
}

/**
 * Cool light. Page chroma is capped far lower in light mode, where C 0.020 is
 * already cream, so this is a tinted white rather than a coloured page.
 *
 * Generated from its seed by scripts/gen-themes.mts.
 */
export const MIST: Theme = {
  id: 'mist',
  name: 'Mist',
  appearance: 'light',
  builtIn: true,
  seed: {
    id: 'mist',
    name: 'Mist',
    appearance: 'light',
    hue: 200,
    tint: 2.5,
    pageChroma: 0.012,
    accent: '#0f766e'
  },
  colors: {
    bg: '#ebf7f7',
    bgSunken: '#dbe6e7',
    bgElevated: '#f4ffff',
    surface: '#f4ffff',
    surfaceHover: '#e3efef',
    surfaceActive: '#d2dfdf',
    borderSubtle: '#c9d7d8',
    border: '#c0d0d1',
    borderStrong: '#b7c8c9',
    text: '#263536',
    textMuted: '#4a5556',
    textFaint: '#5c6869',
    accent: '#0f766e',
    accentHover: '#006b64',
    accentSoft: 'rgba(15, 118, 110, 0.22)',
    accentContrast: '#ffffff',
    success: '#1b7534',
    warning: '#856000',
    danger: '#a8473c',
    info: '#1a68ad'
  },
  terminal: {
    background: '#ebf7f7',
    foreground: '#263536',
    cursor: '#0f766e',
    cursorAccent: '#ebf7f7',
    selectionBackground: 'rgba(15, 118, 110, 0.28)',
    selectionForeground: '#263536',
    selectionInactiveBackground: 'rgba(15, 118, 110, 0.16)',
    red: '#c2473b',
    brightRed: '#a92f24',
    green: '#008232',
    brightGreen: '#006927',
    yellow: '#8f6a00',
    brightYellow: '#745600',
    blue: '#0073c5',
    brightBlue: '#005da2',
    magenta: '#9e51b0',
    brightMagenta: '#873b98',
    cyan: '#007d7e',
    brightCyan: '#006666',
    black: '#2d3333',
    brightBlack: '#474d4d',
    white: '#646a6b',
    brightWhite: '#888f90'
  }
}


/*
 * Order is the order the picker draws them: every dark theme, then every light
 * one, with the picker grouping them under those two headings. Ember stays
 * first and stays the default -- Stoke is a shell FOR Claude Code, not a reskin
 * of it, and a distinct accent is how you tell at a glance which window you are
 * in. To add one: put its seed in scripts/gen-themes.mts, run it, paste the
 * literal here, and add it to this list; verify:theme-gen then pins it.
 */
export const BUILT_IN_THEMES: Theme[] = [
  EMBER,
  NOCTURNE,
  MOSS,
  CLAY,
  LANTERN,
  GRAPHITE,
  LAGOON,
  ROSE,
  INK,
  DAYLIGHT,
  PAPER,
  MIST
]

export const DEFAULT_THEME_ID = EMBER.id
/** The light half of the pair, when the app is told to follow the system. */
export const DEFAULT_LIGHT_THEME_ID = DAYLIGHT.id

/**
 * Which of the two stored themes is in force.
 *
 * Following the system is two ids, not one plus an inversion. A generated
 * theme's light and dark forms are different themes — the ladder's step maps
 * disagree on purpose (gotcha 43: in light mode interaction darkens, and
 * elevation moves to border and shadow), so there is no "the light version of
 * Nocturne" to compute. The user picks one of each and the OS chooses between
 * them.
 *
 * Pure, and here rather than in the renderer, because main needs the same
 * answer: the window's own `backgroundColor` and the Windows title-bar overlay
 * are painted from it, and a second copy of this rule in `index.ts` is how the
 * two would come to disagree about which theme is on screen.
 */
export function activeThemeId(
  settings: { themeId: string; themeIdLight: string; followSystemTheme: boolean },
  systemDark: boolean
): string {
  if (!settings.followSystemTheme) return settings.themeId
  return systemDark ? settings.themeId : settings.themeIdLight
}

/**
 * Where a picked theme is stored: its own appearance decides which slot.
 *
 * While following, clicking a light card must not overwrite the dark slot —
 * that is how you end up with a light theme painted at midnight and no way to
 * see what happened. The card grid already groups Dark and Light, so the
 * gesture reads as "this is my light one" with no extra control.
 */
export function themeSlotFor(appearance: 'dark' | 'light'): 'themeId' | 'themeIdLight' {
  return appearance === 'dark' ? 'themeId' : 'themeIdLight'
}

/**
 * The pair to store when "follow my system" is switched ON.
 *
 * The single `themeId` in force until now may be a LIGHT theme, and moving it
 * into the dark slot unchanged would mean switching this on at night visibly
 * changes nothing and then paints white at dawn. So a light choice is moved to
 * the light slot and the dark slot falls back to the default dark theme.
 */
export function followPatch(
  themeId: string,
  themeIdLight: string,
  appearance: 'dark' | 'light'
): { themeId: string; themeIdLight: string } {
  return appearance === 'dark'
    ? { themeId, themeIdLight }
    : { themeId: DEFAULT_THEME_ID, themeIdLight: themeId }
}

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

    const out: Theme = {
      id: t.id,
      name: typeof t.name === 'string' && t.name.trim() ? t.name : t.id,
      appearance,
      colors: pick(colors, base.colors),
      terminal: pick(terminal, base.terminal)
    }

    /*
     * Carry the seed through, when there is a valid one.
     *
     * This function is a WHITELIST by construction -- it returns a fresh object
     * with named keys rather than spreading the input -- which is the right
     * shape for something parsing a hand-editable file, and is also why adding
     * a field to `Theme` silently loses it here. It did: the editor saved a
     * theme with a seed, hydration dropped it on the next read, and reopening
     * the theme fell back to `seedFrom`'s guessed hue. The sliders came back in
     * the wrong place with no error anywhere, which is this file's own
     * "validateTheme fills gaps and drops what it does not know" working
     * exactly as designed against a key nobody told it about.
     *
     * The seed is validated rather than trusted for the same reason everything
     * else here is: `customThemes` is a user-editable array in settings.json.
     * An unusable seed is dropped and the theme keeps its forty-three colours,
     * because the colours are what renders -- the seed only decides where the
     * editor's sliders start.
     */
    const seed = validateSeed((t as { seed?: unknown }).seed, appearance)
    if (seed) out.seed = seed
    return out
  } catch {
    return null
  }
}

/** A seed is only kept if every field it needs is usable. */
function validateSeed(input: unknown, appearance: Theme['appearance']): ThemeSeed | null {
  if (!input || typeof input !== 'object') return null
  const s = input as Partial<ThemeSeed>
  if (typeof s.accent !== 'string' || !s.accent.trim()) return null
  if (typeof s.hue !== 'number' || !Number.isFinite(s.hue)) return null

  const overrides: Record<string, string> = {}
  if (s.overrides && typeof s.overrides === 'object') {
    for (const [k, v] of Object.entries(s.overrides)) {
      if (typeof v === 'string' && v.trim()) overrides[k] = v
    }
  }

  const pageChroma = clampPageChroma(typeof s.pageChroma === 'number' ? s.pageChroma : undefined, appearance)
  return {
    id: typeof s.id === 'string' && s.id ? s.id : 'custom',
    name: typeof s.name === 'string' && s.name.trim() ? s.name : 'Custom',
    // The theme's own appearance wins: it is what `colors` was built for, and
    // a seed disagreeing with it would redraw the palette on first edit.
    appearance,
    hue: ((s.hue % 360) + 360) % 360,
    tint: clampTint(typeof s.tint === 'number' ? s.tint : TINT_DEFAULT),
    ...(pageChroma > 0 ? { pageChroma } : {}),
    ...(s.black === true && appearance === 'dark' ? { black: true } : {}),
    accent: s.accent,
    ...(Object.keys(overrides).length ? { overrides: overrides as ThemeSeed['overrides'] } : {})
  }
}
