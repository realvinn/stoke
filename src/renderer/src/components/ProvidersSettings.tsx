import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderSettings, ClaudeAuthMode } from '@shared/providers'
import {
  DEFAULT_PROVIDERS,
  keyFormatHint,
  providersSummary,
  validateClaudeAuth
} from '@shared/providers'
import { FieldHint } from './FieldHint'

interface Props {
  providers: ProviderSettings
  onChange: (providers: ProviderSettings) => void
}

const AUTH_OPTIONS: { id: ClaudeAuthMode; label: string; hint: string }[] = [
  {
    id: 'default',
    label: 'Default',
    hint: 'Claude.ai login or whatever ANTHROPIC_* vars the process already has'
  },
  {
    id: 'anthropic',
    label: 'Anthropic API key',
    hint: 'Console key from console.anthropic.com — sent as X-Api-Key'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'Routes Claude Code through openrouter.ai (Anthropic skin)'
  },
  {
    id: 'custom',
    label: 'Custom gateway',
    hint: 'Any Anthropic-compatible base URL + bearer token (local Grok bridge, etc.)'
  }
]

/**
 * Mask a saved key in a password box without round-tripping the real value on
 * every keystroke through main. Drafts commit on blur / Enter, matching
 * HostsSettings — a settings write mid-type drops characters.
 */
export function ProvidersSettings({ providers, onChange }: Props): React.JSX.Element {
  const p = { ...DEFAULT_PROVIDERS, ...providers }
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [reveal, setReveal] = useState<Record<string, boolean>>({})

  // Drop drafts when the saved value changes from outside (e.g. reset).
  useEffect(() => {
    setDrafts({})
  }, [
    p.anthropicApiKey,
    p.openrouterApiKey,
    p.customAuthToken,
    p.openaiApiKey,
    p.xaiApiKey,
    p.customBaseUrl
  ])

  const patch = useCallback(
    (changes: Partial<ProviderSettings>): void => {
      onChange({ ...p, ...changes })
    },
    [onChange, p]
  )

  const draftOf = (key: keyof ProviderSettings): string =>
    drafts[key] ?? (typeof p[key] === 'string' ? (p[key] as string) : '')

  const setDraft = (key: keyof ProviderSettings, value: string): void => {
    setDrafts((d) => ({ ...d, [key]: value }))
  }

  const commit = (key: keyof ProviderSettings): void => {
    if (!(key in drafts)) return
    const next = drafts[key]
    setDrafts((d) => {
      const { [key]: _, ...rest } = d
      return rest
    })
    if (next !== p[key]) patch({ [key]: next } as Partial<ProviderSettings>)
  }

  /*
   * Escape closes the sheet by UNMOUNTING it (App.tsx owns that key, and
   * SettingsSheet says so in its own comment), and React delivers no blur to a
   * node that is going away - so a draft committed on blur alone is lost.
   *
   * Here that was worse than a lost edit. The auth-mode select patches
   * immediately, so picking "Anthropic API key", pasting the key and pressing
   * Escape saved the MODE and dropped the KEY - after which validateClaudeAuth
   * fails closed in pty.ts and every new local session refuses to start,
   * naming the field the user had just filled in. Measured both ways against
   * the running app: without this the key reads back as "", with it the key
   * survives, and the pre-fix build answers pty:start with "Anthropic API key
   * is empty".
   *
   * Written through a ref assigned on every render with an empty-dep effect,
   * so the cleanup sees the LAST drafts rather than those captured when the
   * effect first ran (gotcha 31's shape). Folded into ONE onChange because
   * `patch` spreads the current render's `p`: committing field by field would
   * have each call overwrite the previous one's result - the reason
   * HostsSettings does the same, and the reason per-field `useDraft` hooks are
   * wrong here.
   */
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = (): void => {
    const pending = Object.entries(drafts)
    if (!pending.length) return
    const changes: Record<string, string> = {}
    let moved = false
    for (const [key, draft] of pending) {
      if (draft === p[key as keyof ProviderSettings]) continue
      changes[key] = draft
      moved = true
    }
    if (moved) onChange({ ...p, ...(changes as Partial<ProviderSettings>) })
  }
  useEffect(() => () => flushRef.current(), [])

  const check = validateClaudeAuth(p)
  const anthropicHint = keyFormatHint('anthropic', draftOf('anthropicApiKey'))
  const openrouterHint = keyFormatHint('openrouter', draftOf('openrouterApiKey'))
  const openaiHint = keyFormatHint('openai', draftOf('openaiApiKey'))
  const xaiHint = keyFormatHint('xai', draftOf('xaiApiKey'))

  return (
    <div className="field">
      <span className="field-label">Providers and API keys</span>
      <span className="field-hint">
        Stoke launches the real <span className="mono">claude</span> CLI. Keys here are
        injected into that process&rsquo;s environment so a Start-menu launch still works —
        shell-profile exports do not reach a GUI app. Keys stay in this machine&rsquo;s{' '}
        <span className="mono">settings.json</span>; they are never uploaded by Stoke.
      </span>
      <span className="field-hint">{providersSummary(p)}</span>

      <div className="cc-group" style={{ marginTop: '0.75rem' }}>
        <span className="cc-group-title">Claude Code authentication</span>
        <div className="cc-rows">
          <div className="cc-row">
            <span className="cc-text">
              <span className="field-label">Auth mode</span>
              <span className="field-hint">
                {AUTH_OPTIONS.find((o) => o.id === p.claudeAuth)?.hint}
              </span>
            </span>
            <select
              className="select"
              aria-label="Claude Code auth mode"
              value={p.claudeAuth}
              onChange={(e) => patch({ claudeAuth: e.target.value as ClaudeAuthMode })}
            >
              {AUTH_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {p.claudeAuth === 'anthropic' && (
            <SecretRow
              label="Anthropic API key"
              hint="From console.anthropic.com. Sets ANTHROPIC_API_KEY and clears gateway overrides."
              value={draftOf('anthropicApiKey')}
              reveal={!!reveal.anthropicApiKey}
              warning={anthropicHint}
              onReveal={(v) => setReveal((r) => ({ ...r, anthropicApiKey: v }))}
              onChange={(v) => setDraft('anthropicApiKey', v)}
              onCommit={() => commit('anthropicApiKey')}
            />
          )}

          {p.claudeAuth === 'openrouter' && (
            <>
              <SecretRow
                label="OpenRouter API key"
                hint="From openrouter.ai/settings/keys. Sets ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, and blanks ANTHROPIC_API_KEY."
                value={draftOf('openrouterApiKey')}
                reveal={!!reveal.openrouterApiKey}
                warning={openrouterHint}
                onReveal={(v) => setReveal((r) => ({ ...r, openrouterApiKey: v }))}
                onChange={(v) => setDraft('openrouterApiKey', v)}
                onCommit={() => commit('openrouterApiKey')}
              />
              <div className="cc-row">
                <span className="cc-text">
                  <span className="field-label">Gateway model picker</span>
                  <span className="field-hint">
                    Opt-in. The picker can list non-Anthropic models; Claude Code only
                    guarantees Anthropic first-party tool use.
                  </span>
                </span>
                <select
                  className="select"
                  aria-label="OpenRouter gateway model discovery"
                  value={p.openrouterModelDiscovery ? 'on' : 'off'}
                  onChange={(e) =>
                    patch({ openrouterModelDiscovery: e.target.value === 'on' })
                  }
                >
                  <option value="off">off</option>
                  <option value="on">on</option>
                </select>
              </div>
            </>
          )}

          {p.claudeAuth === 'custom' && (
            <>
              <div className="field" style={{ margin: 0 }}>
                <span className="field-label">Gateway base URL</span>
                <FieldHint>
                  Anthropic-compatible endpoint, e.g. a local Grok bridge at{' '}
                  <span className="mono">http://127.0.0.1:8080</span>. No trailing slash
                  needed.
                </FieldHint>
                <input
                  className="input"
                  aria-label="Custom gateway base URL"
                  placeholder="https://example.com/api"
                  value={draftOf('customBaseUrl')}
                  onChange={(e) => setDraft('customBaseUrl', e.target.value)}
                  onBlur={() => commit('customBaseUrl')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur()
                    }
                  }}
                />
              </div>
              <SecretRow
                label="Gateway bearer token"
                hint="Sent as ANTHROPIC_AUTH_TOKEN. ANTHROPIC_API_KEY is blanked so Claude Code does not fall back to Anthropic directly."
                value={draftOf('customAuthToken')}
                reveal={!!reveal.customAuthToken}
                onReveal={(v) => setReveal((r) => ({ ...r, customAuthToken: v }))}
                onChange={(v) => setDraft('customAuthToken', v)}
                onCommit={() => commit('customAuthToken')}
              />
            </>
          )}
        </div>
      </div>

      {!check.ok && (
        <span className="field-hint" data-tone="danger">
          {check.message}
        </span>
      )}

      <div className="cc-group" style={{ marginTop: '0.75rem' }}>
        <span className="cc-group-title">OpenAI / Codex and xAI / Grok</span>
        <span className="field-hint">
          These keys are injected whenever set, even if Claude auth stays on Default.
          They do not by themselves make Claude Code speak OpenAI or xAI wire formats —
          use OpenRouter or a Custom Anthropic-compatible bridge for that. Codex CLI
          reads <span className="mono">OPENAI_API_KEY</span>; Grok bridges and MCP
          servers typically read <span className="mono">XAI_API_KEY</span>.
        </span>
        <div className="cc-rows">
          <SecretRow
            label="OpenAI / Codex API key"
            hint="Injected as OPENAI_API_KEY for Codex CLI and OpenAI-compatible tools."
            value={draftOf('openaiApiKey')}
            reveal={!!reveal.openaiApiKey}
            warning={openaiHint}
            onReveal={(v) => setReveal((r) => ({ ...r, openaiApiKey: v }))}
            onChange={(v) => setDraft('openaiApiKey', v)}
            onCommit={() => commit('openaiApiKey')}
          />
          <SecretRow
            label="xAI / Grok API key"
            hint="Injected as XAI_API_KEY. To drive Claude Code with Grok, run a local Anthropic-compatible bridge and pick Custom above."
            value={draftOf('xaiApiKey')}
            reveal={!!reveal.xaiApiKey}
            warning={xaiHint}
            onReveal={(v) => setReveal((r) => ({ ...r, xaiApiKey: v }))}
            onChange={(v) => setDraft('xaiApiKey', v)}
            onCommit={() => commit('xaiApiKey')}
          />
        </div>
      </div>

      {/*
        Shown once the user has actually LEFT default, not while they are still
        on it. A cached Claude.ai login can only fight a gateway or a console
        key, so on 'default' this advice is inert - and it used to disappear at
        the exact moment it became actionable.
      */}
      {p.claudeAuth !== 'default' && (
        <span className="field-hint">
          Tip: if you previously signed in with Claude.ai, run{' '}
          <span className="mono">/logout</span> once inside a session - a cached login
          otherwise fights the credentials set here.
        </span>
      )}
    </div>
  )
}

function SecretRow({
  label,
  hint,
  value,
  reveal,
  warning,
  onReveal,
  onChange,
  onCommit
}: {
  label: string
  hint: string
  value: string
  reveal: boolean
  warning?: string | null
  onReveal: (v: boolean) => void
  onChange: (v: string) => void
  onCommit: () => void
}): React.JSX.Element {
  return (
    <div className="field" style={{ margin: 0 }}>
      <span className="field-label">{label}</span>
      <FieldHint>{hint}</FieldHint>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        <input
          className="input"
          style={{ flex: 1 }}
          aria-label={label}
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder="paste key…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button
          type="button"
          className="btn"
          aria-pressed={reveal}
          onClick={() => onReveal(!reveal)}
        >
          {reveal ? 'Hide' : 'Show'}
        </button>
      </div>
      {warning && (
        <span className="field-hint" data-tone="warning">
          {warning}
        </span>
      )}
    </div>
  )
}
