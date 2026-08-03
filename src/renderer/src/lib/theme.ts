import type { Theme } from '@shared/types'
import type { Profile } from '@shared/profiles'

/** camelCase token -> `--kebab-case` custom property. */
function cssVar(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/**
 * Push a theme onto :root as CSS custom properties. Every rule in app.css reads
 * from these, so switching themes is a single write with no re-render.
 *
 * Prefer `applyAppearance`. This writes the theme only, and the profile accent
 * has to be re-applied after it or the two fight - see below.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.colors ?? {})) {
    root.style.setProperty(cssVar(key), value)
  }
  root.dataset.appearance = theme.appearance
  root.style.colorScheme = theme.appearance
}

/**
 * The single owner of every colour written to :root.
 *
 * This exists because the theme and the active profile both want to set the
 * accent, and they used to do it from two effects. The profile effect cleared
 * the four accent tokens with `removeProperty` whenever no profile was
 * selected - which is the default state - and that removed the *theme's* accent
 * along with it. `app.css` declares no fallback for these tokens, so
 * `var(--accent)` became invalid and every accent-coloured control rendered
 * transparent. It failed by looking slightly wrong, never by erroring, which is
 * why it survived three releases.
 *
 * So: always write the complete theme, then let a profile override the four
 * accent tokens on top. Never remove a property; overwrite it. Nothing else in
 * the codebase should touch `documentElement.style` for colour.
 */
export function applyAppearance(theme: Theme, profile: Profile | null): void {
  applyTheme(theme)
  if (!profile) return
  const root = document.documentElement
  root.style.setProperty('--accent', profile.accent)
  root.style.setProperty('--accent-hover', profile.accentHover)
  root.style.setProperty('--accent-soft', profile.accentSoft)
  root.style.setProperty('--accent-contrast', profile.accentContrast)
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
