import type { TerminalSettings, Theme } from '@shared/types'
import type { Profile } from '@shared/profiles'
import { deriveAccent } from '@shared/accent'
import { parseColor } from '@shared/color'

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
  const root = document.documentElement

  /*
   * Every accent token is DERIVED, and it is derived whether or not a profile
   * is active. Two reasons, both of which used to be bugs.
   *
   * First, a profile's stored accent is tuned for a dark ground -- all eight
   * measured 1.43-2.66:1 against the light theme's page -- and this function
   * used to write it straight through with no appearance check. `--accent` is
   * the app-wide focus ring, the context ring's stroke and the tab indicator,
   * so the keyboard focus indicator was effectively invisible in light mode.
   *
   * Second, `--accent-ink` has to exist on every path. `app.css` declares no
   * fallback for any colour token, so a `var(--accent-ink)` that resolves to
   * nothing is invalid at computed-value time and the rule vanishes silently --
   * the same failure mode the `removeProperty` bug above had. Deriving inside
   * the `if (!profile)` branch would have left it unset on the default path.
   */
  const tokens = deriveAccent(profile?.accent ?? theme.colors.accent, theme.appearance, theme.colors.bg)
  root.style.setProperty('--accent', tokens.accent)
  root.style.setProperty('--accent-hover', tokens.accentHover)
  root.style.setProperty('--accent-soft', tokens.accentSoft)
  root.style.setProperty('--accent-contrast', tokens.accentContrast)
  root.style.setProperty('--accent-ink', tokens.accentInk)
}

export function applyTypography(
  fontFamily: string,
  fontSize: number,
  uiScale: number,
  terminal?: TerminalSettings
): void {
  const root = document.documentElement
  root.style.setProperty('--mono', fontFamily)
  root.style.setProperty('--term-size', `${fontSize}px`)
  root.style.setProperty('--ui-scale', String(uiScale))
  if (!terminal) return
  /*
   * What the paused tab's ghost screen and the pane's card read. The ghost
   * used to be drawn at --fs-sm / --lh-tight while the live pane drew at the
   * font setting and 1.2, so a resumed tab visibly jumped; both follow the
   * same two numbers now.
   */
  root.style.setProperty('--term-lh', String(terminal.lineHeight))
  root.style.setProperty('--term-pad', `${terminal.padding}px`)
  root.dataset.termFrame = terminal.frame ? 'true' : 'false'
}

function rgba(hex: string, alpha: number): string {
  const c = parseColor(hex)
  return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` : hex
}

/**
 * xterm wants its own palette object rather than CSS variables.
 *
 * The scrollbar keys are derived here rather than stored on the theme: xterm 6
 * draws its own slider and, with nothing said, falls back to the foreground at
 * 20/40/50% — the one control in the pane that ignored every theme's accent
 * and read the same grey on Moss, Nocturne and Daylight alike.
 */
export function terminalTheme(theme: Theme): Record<string, string> {
  const c = theme.colors
  return {
    ...theme.terminal,
    scrollbarSliderBackground: rgba(c.textFaint, 0.35),
    scrollbarSliderHoverBackground: rgba(c.textMuted, 0.5),
    scrollbarSliderActiveBackground: rgba(c.accent, 0.7),
    overviewRulerBorder: c.borderSubtle
  }
}
