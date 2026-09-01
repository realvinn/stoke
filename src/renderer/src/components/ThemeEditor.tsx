/**
 * The custom theme editor.
 *
 * It edits a five-field SEED, not forty-three colours, and that is the design
 * rather than a simplification. `themes.ts` has always said every value is
 * generated from one hue plus one accent; what was missing was any way to
 * supply them (see `themeGen.ts` on the generator that the repo documented and
 * did not contain). Handing someone forty-three colour fields would have been
 * the other thing gotcha 43 forbids -- the hand-picked palette it replaced
 * passed every suite in the repo while its borders measured APCA Lc 0.00.
 *
 * So: sliders that cannot produce an illegible palette, plus a per-token
 * override for when someone means it, plus a contrast report that says what an
 * override cost. Refuse nothing, hide nothing.
 *
 * The preview is the whole window, not a swatch grid. Every rule in `app.css`
 * reads its colour from a custom property on `:root`, so the truest preview
 * available is simply to apply the draft -- the sidebar, the tab strip, the
 * status bar and this dialog all repaint together, which is the only way to see
 * that a border has gone invisible against a hovered row. It is applied through
 * `App`'s existing single writer rather than painted here; see `onPreviewTheme`
 * in `App.tsx` for why that rule is worth the extra prop.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Settings, Theme, ThemeColors, ThemeSeed } from '@shared/types'
import { buildTheme, contrastReport, GENERATED_TOKENS } from '@shared/themeGen'
import { TINT_MAX, TINT_MIN } from '@shared/ladder'
import { ColorField } from './ColorField'
import { NOTATIONS, type Notation } from '@shared/notation'

/**
 * A seed for a theme that has none.
 *
 * Every built-in predates the seed field, and a custom theme written by hand
 * into `settings.json` never had one either. Rather than refuse to open those,
 * the editor starts from a seed whose accent and appearance are taken from the
 * theme itself, so "duplicate Ember and make it bluer" works on a theme that
 * knows nothing about hues. The neutrals will not round-trip exactly -- that is
 * stated in the UI rather than hidden, because a silent near-miss is worse than
 * a named one.
 */
function seedFrom(theme: Theme): ThemeSeed {
  return (
    theme.seed ?? {
      id: `${theme.id}-copy`,
      name: `${theme.name} copy`,
      appearance: theme.appearance,
      hue: 55,
      tint: 1,
      accent: theme.colors.accent
    }
  )
}

/** A slug that cannot collide with a built-in or with an existing custom. */
function freshId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom'
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

interface Props {
  settings: Settings
  /** Built-ins plus customs, so ids can be kept unique across both. */
  allThemes: Theme[]
  onPatch: (patch: Partial<Settings>) => void
  onPreviewTheme: (theme: Theme | null) => void
}

export function ThemeEditor({
  settings,
  allThemes,
  onPatch,
  onPreviewTheme
}: Props): React.JSX.Element {
  const [seed, setSeed] = useState<ThemeSeed | null>(null)
  const [notation, setNotation] = useState<Notation>('oklch')
  /** Which generated token has its colour field open. One at a time. */
  const [openToken, setOpenToken] = useState<keyof ThemeColors | null>(null)

  const draft = useMemo(() => (seed ? buildTheme(seed) : null), [seed])
  const findings = useMemo(
    () => (draft ? contrastReport(draft.colors, draft.appearance) : []),
    [draft]
  )

  /*
   * Push the draft at App on every change, and withdraw it on unmount.
   *
   * The cleanup is not tidiness: `SettingsSheet` is unmounted outright by the
   * Escape handler in `App.tsx` rather than closed through `onClose`, so
   * unmount is a real exit path and the only one some cancels take. Without
   * this, pressing Escape mid-edit would leave a theme applied that exists in
   * no settings file -- indistinguishable from having saved it.
   */
  useEffect(() => {
    onPreviewTheme(draft)
    return () => onPreviewTheme(null)
  }, [draft, onPreviewTheme])

  const customs = settings.customThemes ?? []
  const taken = new Set(allThemes.map((t) => t.id))

  const start = (from: Theme): void => {
    const base = seedFrom(from)
    const editing = from.seed && !from.builtIn
    setSeed(
      editing
        ? base
        : { ...base, id: freshId(base.name, taken), name: base.name }
    )
    setOpenToken(null)
  }

  const save = (): void => {
    if (!seed || !draft) return
    const rest = customs.filter((t) => t.id !== draft.id)
    onPatch({ customThemes: [...rest, draft], themeId: draft.id })
    onPreviewTheme(null)
    setSeed(null)
  }

  const remove = (id: string): void => {
    onPatch({
      customThemes: customs.filter((t) => t.id !== id),
      // Fall back to the default rather than leaving `themeId` naming a theme
      // that is gone: `resolveTheme` would land on the default anyway, but the
      // stored value would keep pointing at nothing.
      ...(settings.themeId === id ? { themeId: 'ember' } : {})
    })
  }

  if (!seed || !draft) {
    return (
      <div className="field">
        <span className="field-label">Custom themes</span>
        <span className="field-hint">
          A theme is one hue, one accent and a tint — every other colour is solved from those
          against fixed contrast floors, so a theme built here cannot have unreadable text or
          invisible borders. The whole window previews as you drag.
        </span>
        <div className="theme-editor-actions">
          <button
            className="btn"
            onClick={() =>
              start({
                ...allThemes[0],
                seed: {
                  id: 'custom',
                  name: 'My theme',
                  appearance: 'dark',
                  hue: 55,
                  tint: 1.6,
                  accent: '#ff9552'
                }
              })
            }
          >
            New theme
          </button>
          {customs.map((t) => (
            <span className="theme-editor-chip" key={t.id}>
              <button className="btn" onClick={() => start(t)}>
                Edit {t.name}
              </button>
              <button
                className="btn"
                data-danger="true"
                onClick={() => remove(t.id)}
                title={`Delete ${t.name}`}
              >
                Delete
              </button>
            </span>
          ))}
        </div>
      </div>
    )
  }

  const patch = (p: Partial<ThemeSeed>): void => setSeed({ ...seed, ...p })
  const override = (token: keyof ThemeColors, hex: string | null): void => {
    const next = { ...(seed.overrides ?? {}) }
    if (hex) next[token] = hex
    else delete next[token]
    patch({ overrides: next })
  }

  return (
    <div className="field theme-editor">
      <span className="field-label">Editing {seed.name}</span>

      <label className="theme-editor-row">
        <span>Name</span>
        <input
          className="input"
          value={seed.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>

      <div className="theme-editor-row">
        <span>Appearance</span>
        <div className="segmented" role="group" aria-label="Appearance">
          {(['dark', 'light'] as const).map((a) => (
            <button
              key={a}
              aria-pressed={seed.appearance === a}
              onClick={() => patch({ appearance: a })}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <label className="theme-editor-row">
        <span>Neutral hue</span>
        <input
          type="range"
          min={0}
          max={360}
          step={0.5}
          value={seed.hue}
          onChange={(e) => patch({ hue: Number(e.target.value) })}
        />
        <output className="mono">{seed.hue.toFixed(1)}°</output>
      </label>

      <label className="theme-editor-row">
        <span>Tint</span>
        <input
          type="range"
          min={TINT_MIN}
          max={TINT_MAX}
          step={0.05}
          value={seed.tint}
          onChange={(e) => patch({ tint: Number(e.target.value) })}
        />
        <output className="mono">{seed.tint.toFixed(2)}×</output>
      </label>
      <span className="field-hint">
        How far the greys carry the hue. At 1× — where every built-in sits — the page is
        near-achromatic and the hue above is almost invisible, which is why Ember and Clay ship the
        identical background. Past about 2× it starts reading as a colour.
      </span>

      <div className="theme-editor-row">
        <span>Accent</span>
        <ColorField
          value={draft.colors.accent}
          notation={notation}
          label="Accent colour"
          onChange={(hex) => patch({ accent: hex })}
        />
      </div>

      <div className="theme-editor-row">
        <span>Notation</span>
        <div className="segmented" role="group" aria-label="Colour notation">
          {NOTATIONS.map((n) => (
            <button key={n.id} aria-pressed={notation === n.id} onClick={() => setNotation(n.id)}>
              {n.label}
            </button>
          ))}
        </div>
      </div>

      {findings.length > 0 && (
        <div className="theme-editor-findings">
          {findings.map((f) => (
            <span className="field-hint" data-tone="warning" key={String(f.token)}>
              <span className="mono">{String(f.token)}</span> measures{' '}
              {f.scale === 'wcag'
                ? `${f.measured.toFixed(2)}:1 against ${f.against}, under its ${f.floor}:1 floor`
                : `APCA Lc ${f.measured.toFixed(1)} against ${f.against}, under the ${f.floor} discernibility floor`}
              .
            </span>
          ))}
        </div>
      )}

      <span className="field-label">Colours</span>
      <span className="field-hint">
        All solved from the seed. Click one to set it by hand — an override is kept exactly as
        typed, and anything it breaks is reported above rather than refused.
      </span>
      <div className="theme-token-list">
        {GENERATED_TOKENS.map((token) => {
          const overridden = seed.overrides?.[token] !== undefined
          return (
            <div className="theme-token" key={token} data-overridden={overridden || undefined}>
              <button
                className="theme-token-head"
                aria-expanded={openToken === token}
                onClick={() => setOpenToken(openToken === token ? null : token)}
              >
                <span className="theme-token-swatch" style={{ background: draft.colors[token] }} />
                <span className="theme-token-name">{token}</span>
                <span className="theme-token-value mono">{draft.colors[token]}</span>
              </button>
              {openToken === token && (
                <div className="theme-token-edit">
                  <ColorField
                    value={draft.colors[token]}
                    notation={notation}
                    label={`${token} colour`}
                    onChange={(hex) => override(token, hex)}
                  />
                  {overridden && (
                    <button className="btn" onClick={() => override(token, null)}>
                      Reset to generated
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="theme-editor-actions">
        <button className="btn" data-variant="primary" onClick={save}>
          Save theme
        </button>
        <button
          className="btn"
          onClick={() => {
            onPreviewTheme(null)
            setSeed(null)
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
