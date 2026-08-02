import type { Theme } from './types'

/**
 * Built-in themes.
 *
 * The house style is warm-neutral rather than pure grey: backgrounds carry a
 * few degrees of hue so the orange accent reads as part of the surface instead
 * of sitting on top of it. Every theme must define the full token set — the
 * renderer writes them straight out as CSS custom properties.
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
    // Kept at >=4.5:1 on `bg` so timestamps and counts stay legible rather than
    // decorative-grey. Anything fainter fails WCAG AA at these sizes.
    textFaint: '#8a7e75',
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
    textFaint: '#76838f',
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
    textFaint: '#7c8a7a',
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
    textFaint: '#78787f',
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
    black: '#1c1c1f',
    red: '#b3372a',
    green: '#2f7d45',
    yellow: '#8a6212',
    blue: '#2a5f96',
    magenta: '#7d4491',
    cyan: '#1c6f6a',
    white: '#dedee1',
    brightBlack: '#5c5c63',
    brightRed: '#cf4c39',
    brightGreen: '#3f9558',
    brightYellow: '#a5771c',
    brightBlue: '#3a76ad',
    brightMagenta: '#9558a8',
    brightCyan: '#2a8a84',
    brightWhite: '#ffffff'
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
