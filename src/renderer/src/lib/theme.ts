import type { Theme } from '@shared/types'

/** camelCase token -> `--kebab-case` custom property. */
function cssVar(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/**
 * Push a theme onto :root as CSS custom properties. Every rule in app.css reads
 * from these, so switching themes is a single write with no re-render.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(cssVar(key), value)
  }
  root.dataset.appearance = theme.appearance
  root.style.colorScheme = theme.appearance
}

export function applyTypography(fontFamily: string, fontSize: number, uiScale: number): void {
  const root = document.documentElement
  root.style.setProperty('--mono', fontFamily)
  root.style.setProperty('--term-size', `${fontSize}px`)
  root.style.setProperty('--ui-scale', String(uiScale))
}

/** xterm wants its own palette object rather than CSS variables. */
export function terminalTheme(theme: Theme): Record<string, string> {
  return { ...theme.terminal }
}
