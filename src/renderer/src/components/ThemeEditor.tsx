/**
 * The theme picker and the custom theme editor.
 *
 * The editor edits a five-field SEED, not forty-three colours, and that is the
 * design rather than a simplification. `themes.ts` has always said every value
 * is generated from one hue plus one accent; what was missing was any way to
 * supply them (see `themeGen.ts` on the generator that the repo documented and
 * did not contain). Handing someone forty-three colour fields would have been
 * the other thing gotcha 43 forbids -- the hand-picked palette it replaced
 * passed every suite in the repo while its borders measured APCA Lc 0.00.
 *
 * So: sliders that cannot produce an illegible palette, plus a per-token
 * override for when someone means it, plus a contrast report that says what an
 * override cost. Refuse nothing, hide nothing.
 *
 * The picker lives here too, because "duplicate this one" is the way most
 * custom themes start and the card is where that button belongs. Each card is
 * a small window drawn from the theme -- title bar, sidebar, page, an accent
 * tab rule, the sixteen ANSI dots and an "Aa" -- rather than four chips, since
 * the neutrals of every dark theme are within a few units of each other and
 * four chips could not show a difference the themes actually have.
 *
 * The preview is the whole window, not a swatch grid. Every rule in `app.css`
 * reads its colour from a custom property on `:root`, so the truest preview
 * available is simply to apply the draft. It is applied through `App`'s
 * existing single writer rather than painted here; see `onPreviewTheme` in
 * `App.tsx` for why that rule is worth the extra prop.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Settings, Theme, ThemeColors, ThemeSeed } from '@shared/types'
import { buildTheme, contrastReport, GENERATED_TOKENS } from '@shared/themeGen'
import { PAGE_CHROMA_MAX, TINT_MAX, TINT_MIN } from '@shared/ladder'
import {
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  followPatch,
  resolveTheme,
  themeSlotFor
} from '@shared/themes'
import { ColorField } from './ColorField'
import { IconCheck, IconCopy } from './Icons'
import { NOTATIONS, type Notation } from '@shared/notation'

/**
 * A seed for a theme that has none.
 *
 * Every built-in carries its seed now, so this only ever fires for a custom
 * theme written by hand into `settings.json` before the editor existed. Rather
 * than refuse to open it, the editor starts from a seed whose accent and
 * appearance are taken from the theme itself. The neutrals will not round-trip
 * exactly, and the editor says so rather than hiding it.
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

const ANSI = [
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan'
] as const

/** One theme as a small window. */
function ThemeCard({
  theme,
  active,
  custom,
  onSelect,
  onDuplicate,
  onEdit,
  onDelete
}: {
  theme: Theme
  active: boolean
  custom: boolean
  onSelect: () => void
  onDuplicate: () => void
  onEdit?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  const c = theme.colors
  const t = theme.terminal
  return (
    <div className="theme-card" data-active={active || undefined}>
      <button className="theme-card-pick" aria-pressed={active} onClick={onSelect} title={`Use ${theme.name}`}>
        <span className="theme-card-window" aria-hidden="true" style={{ background: c.bg }}>
          <span className="tc-titlebar" style={{ background: c.bgSunken }}>
            <span className="tc-tab" style={{ background: c.bg, borderTopColor: c.accent }} />
          </span>
          <span className="tc-body">
            <span className="tc-side" style={{ background: c.bgSunken, borderRightColor: c.border }}>
              <span className="tc-chip" style={{ background: c.accent }} />
              <span className="tc-line" style={{ background: c.textMuted }} />
              <span className="tc-line" style={{ background: c.textFaint, width: '60%' }} />
            </span>
            <span className="tc-page">
              <span className="tc-aa" style={{ color: c.text }}>
                Aa
              </span>
              <span className="tc-ansi">
                {ANSI.map((slot) => (
                  <span key={slot} style={{ background: t[slot] }} />
                ))}
              </span>
            </span>
          </span>
        </span>
        <span className="theme-card-name">
          {theme.name}
          {custom && <span className="theme-card-tag">yours</span>}
          {active && <IconCheck className="theme-card-check" />}
        </span>
      </button>
      <span className="theme-card-actions">
        <button className="icon-btn" data-size="sm" onClick={onDuplicate} title={`Duplicate ${theme.name} and edit the copy`}>
          <IconCopy />
          <span className="sr-only">Duplicate {theme.name}</span>
        </button>
        {onEdit && (
          <button className="btn" data-size="sm" onClick={onEdit}>
            Edit
          </button>
        )}
        {onDelete && (
          <button className="btn" data-size="sm" data-variant="danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </span>
    </div>
  )
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
  /** Whether the seed being edited had no seed of its own, so the sliders are a guess. */
  const [guessed, setGuessed] = useState(false)
  const [notation, setNotation] = useState<Notation>('oklch')
  /** Which generated token has its colour field open. One at a time. */
  const [openToken, setOpenToken] = useState<keyof ThemeColors | null>(null)
  /** The custom theme whose Delete is awaiting a second press. */
  const [confirming, setConfirming] = useState<string | null>(null)

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

  /** Open the editor on a theme: in place for a custom, as a fresh copy for a built-in. */
  const start = (from: Theme, copy: boolean): void => {
    const base = seedFrom(from)
    setGuessed(!from.seed)
    setSeed(
      copy || from.builtIn
        ? { ...base, id: freshId(`${base.name} copy`, taken), name: `${base.name} copy` }
        : base
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
    setConfirming(null)
    onPatch({
      customThemes: customs.filter((t) => t.id !== id),
      // Fall back to the default rather than leaving `themeId` naming a theme
      // that is gone: `resolveTheme` would land on the default anyway, but the
      // stored value would keep pointing at nothing.
      ...(settings.themeId === id ? { themeId: DEFAULT_THEME_ID } : {}),
      // Both slots, or deleting the theme sitting in the light half left it
      // naming nothing and the deletion looked like it had not worked at dawn.
      ...(settings.themeIdLight === id ? { themeIdLight: DEFAULT_LIGHT_THEME_ID } : {})
    })
  }

  const following = settings.followSystemTheme

  /**
   * Which card is marked. While following, BOTH picks are — one per group —
   * because both are in force, each at its own time of day. Marking only the
   * one currently painted would make the other look unchosen and invite a
   * click that overwrites the pair.
   */
  const isActive = (t: Theme): boolean =>
    following
      ? t.id === (t.appearance === 'dark' ? settings.themeId : settings.themeIdLight)
      : t.id === settings.themeId

  /** Where a click lands. The shared rule, so main and this cannot disagree. */
  const pick = (t: Theme): Partial<Settings> =>
    following && themeSlotFor(t.appearance) === 'themeIdLight'
      ? { themeIdLight: t.id }
      : { themeId: t.id }

  if (!seed || !draft) {
    const groups: { title: string; themes: Theme[] }[] = [
      { title: 'Dark', themes: allThemes.filter((t) => t.builtIn && t.appearance === 'dark') },
      { title: 'Light', themes: allThemes.filter((t) => t.builtIn && t.appearance === 'light') },
      { title: 'Yours', themes: customs }
    ]
    return (
      <>
        {/*
          Above the cards, because it changes what clicking one of them means.
        */}
        <label className="field theme-follow">
          <span className="theme-follow-text">
            <span className="field-label">Follow my system</span>
            <span className="field-hint">
              {following
                ? 'Your dark pick is used when this Mac is dark, your light pick when it is light. Both are marked below; clicking a card sets the one that matches its own appearance.'
                : 'Use one theme when the system is dark and another when it is light. Off, the theme you pick stays put whatever the system does.'}
            </span>
          </span>
          <input
            type="checkbox"
            checked={following}
            aria-label="Follow my system appearance"
            onChange={(e) =>
              onPatch(
                e.target.checked
                  ? /*
                     * The single theme in force until now may be a LIGHT one,
                     * and moving it into the dark slot unchanged would mean
                     * switching this on at night visibly changes nothing and
                     * then paints white at dawn. followPatch moves it to the
                     * slot that matches its own appearance.
                     */
                    { followSystemTheme: true, ...followPatch(
                      settings.themeId,
                      settings.themeIdLight,
                      resolveTheme(settings.themeId, settings.customThemes).appearance
                    ) }
                  : { followSystemTheme: false }
              )
            }
            style={{
              width: '1rem',
              height: '1rem',
              margin: 0,
              accentColor: 'var(--accent)',
              flexShrink: 0
            }}
          />
        </label>

        {groups.map(
          (g) =>
            g.themes.length > 0 && (
              <div className="field" key={g.title}>
                <span className="field-label">{g.title}</span>
                <div className="theme-grid">
                  {g.themes.map((t) => (
                    <ThemeCard
                      key={t.id}
                      theme={t}
                      active={isActive(t)}
                      custom={!t.builtIn}
                      onSelect={() => onPatch(pick(t))}
                      onDuplicate={() => start(t, true)}
                      onEdit={t.builtIn ? undefined : () => start(t, false)}
                      onDelete={t.builtIn ? undefined : () => setConfirming(t.id)}
                    />
                  ))}
                </div>
                {g.title === 'Yours' && confirming && (
                  <div className="theme-confirm">
                    <span className="field-hint">
                      Delete {customs.find((t) => t.id === confirming)?.name ?? confirming}? This cannot be undone.
                    </span>
                    <button className="btn" data-size="sm" data-variant="danger" onClick={() => remove(confirming)}>
                      Delete
                    </button>
                    <button className="btn" data-size="sm" data-variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </div>
                )}
              </div>
            )
        )}
        <div className="field">
          <span className="field-label">Make your own</span>
          <span className="field-hint">
            Duplicate any theme above and change it, or start fresh. A theme is a hue, a tint, a page
            colour and an accent — every other colour is solved from those against fixed contrast
            floors, so a theme built here cannot have unreadable text or invisible borders. The
            whole window previews as you drag. Hand-written entries in{' '}
            <span className="mono">customThemes</span> still load.
          </span>
          <div className="theme-editor-actions">
            <button
              className="btn"
              onClick={() => {
                const current = allThemes.find((t) => t.id === settings.themeId) ?? allThemes[0]
                start(current, true)
              }}
            >
              Duplicate {allThemes.find((t) => t.id === settings.themeId)?.name ?? 'current'}
            </button>
            <button
              className="btn"
              data-variant="ghost"
              onClick={() =>
                start(
                  {
                    ...allThemes[0],
                    seed: {
                      id: 'custom',
                      name: 'My theme',
                      appearance: 'dark',
                      hue: 200,
                      tint: 1,
                      pageChroma: 0.02,
                      accent: '#4ecdc4'
                    }
                  },
                  true
                )
              }
            >
              Start fresh
            </button>
          </div>
        </div>
      </>
    )
  }

  const patch = (p: Partial<ThemeSeed>): void => {
    const next = { ...seed, ...p }
    /*
     * Setting the accent clears any override on it.
     *
     * `accent` used to appear both here and in the generated-token list below,
     * so a theme saved while that was true can still carry
     * `overrides.accent` — which `buildTheme` applies over the seed. Without
     * this, such a theme has an accent field that visibly changes nothing and
     * no control anywhere to clear the override, because the token that set it
     * is no longer drawn.
     */
    if (p.accent !== undefined && next.overrides?.accent !== undefined) {
      const { accent: _drop, ...rest } = next.overrides
      next.overrides = rest
    }
    setSeed(next)
  }
  const override = (token: keyof ThemeColors, hex: string | null): void => {
    const next = { ...(seed.overrides ?? {}) }
    if (hex) next[token] = hex
    else delete next[token]
    patch({ overrides: next })
  }
  const pageMax = PAGE_CHROMA_MAX[seed.appearance]

  return (
    <div className="field theme-editor">
      <span className="field-label">Editing {seed.name}</span>
      {guessed && (
        <span className="field-hint" data-tone="warning">
          This theme was written by hand, so the sliders start from a guess and the first drag
          regenerates its neutrals.
        </span>
      )}

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
              onClick={() =>
                patch({
                  appearance: a,
                  // The light ladder has no black start and a lower page ceiling.
                  ...(a === 'light' ? { black: false, pageChroma: Math.min(seed.pageChroma ?? 0, PAGE_CHROMA_MAX.light) } : {})
                })
              }
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <label className="theme-editor-row">
        <span>Hue</span>
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
        <span>Page colour</span>
        <input
          type="range"
          min={0}
          max={pageMax}
          step={0.0025}
          value={Math.min(seed.pageChroma ?? 0, pageMax)}
          onChange={(e) => patch({ pageChroma: Number(e.target.value) })}
        />
        <output className="mono">{(seed.pageChroma ?? 0).toFixed(4)}</output>
      </label>
      <span className="field-hint">
        How strongly the page itself is coloured. 0 is a grey; around 0.02–0.03 is where Nord,
        Dracula and Tokyo Night sit. The hue above decides which colour.
      </span>

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
        How far the text and borders carry the hue. Even at the top of this range the page stays a
        near-grey; Page colour above is what colours it.
      </span>

      {seed.appearance === 'dark' && (
        <label className="check-row">
          <input type="checkbox" checked={seed.black === true} onChange={(e) => patch({ black: e.target.checked })} />
          <span>
            <span className="field-label">True black</span>
            <span className="field-hint">
              Start the ladder near black, for an OLED panel. Lantern and Graphite are built this way.
            </span>
          </span>
        </label>
      )}

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
