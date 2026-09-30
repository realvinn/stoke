import type { Appearance } from '@shared/accent'

/**
 * The theme in force, read back off `:root` — the single writer
 * (`applyAppearance`) has already put every colour there, draft previews
 * included, so this is what is painted rather than what is stored.
 *
 * For the colour picker's ink preview: it has to say what Stoke will paint on
 * THIS theme, and the theme editor's draft is only ever on `:root`, never in
 * settings. Only the grounds and reserved colours the preview needs.
 */
export interface RootTheme {
  appearance: Appearance
  colors: { bg: string; bgSunken: string; surfaceHover: string; danger: string; warning: string }
}

export function readRootTheme(): RootTheme {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const v = (name: string): string => css.getPropertyValue(name).trim()
  return {
    appearance: root.dataset.appearance === 'light' ? 'light' : 'dark',
    colors: {
      bg: v('--bg'),
      bgSunken: v('--bg-sunken'),
      surfaceHover: v('--surface-hover'),
      danger: v('--danger'),
      warning: v('--warning')
    }
  }
}
