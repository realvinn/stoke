import { useEffect, useRef, useState } from 'react'
import {
  CODING_CLIS,
  capsFor,
  isClaudeCode,
  type CodingCli,
  type CodingCliDetection,
  type CodingCliId
} from '@shared/codingClis'
import {
  DEFAULT_ENDPOINT,
  endpointProblem,
  installSteps,
  type AgentEndpoint,
  type AgentSettings,
  type EndpointMode
} from '@shared/agents'
import type { Settings } from '@shared/types'

/*
 * Settings › Coding agents: which agents show in the launcher, installing the
 * missing ones, and where each non-Claude agent sends its requests.
 *
 * Claude Code's endpoint is not here. It is Settings › Providers, and a second
 * control for the same thing would be two writers for one value (gotcha 57);
 * its row says so and nothing more.
 *
 * Endpoint fields commit on blur and are flushed on unmount through a ref,
 * because Escape closes the sheet by unmounting it and delivers no blur
 * (gotcha 63). The whole `agents` block is sent on every commit — `setSettings`
 * merges shallowly, so a partial block would drop the other agents' entries.
 */
export function AgentsSettings({
  settings,
  onPatch,
  detection,
  onRefresh,
  onOpenPicker,
  onInstall
}: {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
  detection: CodingCliDetection | null
  onRefresh: () => void
  onOpenPicker: () => void
  onInstall: (ids: CodingCliId[]) => void
}): React.JSX.Element {
  const agents = settings.agents
  const platform = window.stoke.platform
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  const patchAgents = (next: AgentSettings): void => onPatch({ agents: next })

  const installed = new Set(detection?.clis.filter((c) => c.path).map((c) => c.id) ?? [])
  const shown = (id: CodingCliId): boolean =>
    agents.chosen === null ? installed.has(id) : agents.chosen.includes(id)

  const setShown = (id: CodingCliId, on: boolean): void => {
    // The first toggle turns "never asked" into an explicit list, starting from
    // what the launcher was showing — so it changes only the row clicked.
    const base = agentsRef.current.chosen ?? CODING_CLIS.map((c) => c.id).filter((x) => installed.has(x))
    const next = on ? [...new Set([...base, id])] : base.filter((x) => x !== id)
    patchAgents({ ...agentsRef.current, chosen: CODING_CLIS.map((c) => c.id).filter((x) => next.includes(x)) })
  }

  const setEndpoint = (id: CodingCliId, ep: AgentEndpoint): void => {
    const endpoints = { ...agentsRef.current.endpoints }
    if (ep.mode === 'default' && !ep.model && !ep.baseUrl && !ep.apiKey) delete endpoints[id]
    else endpoints[id] = ep
    patchAgents({ ...agentsRef.current, endpoints })
  }

  return (
    <>
      <div className="field">
        <span className="field-label">Coding agents</span>
        <span className="field-hint">
          Each agent runs in its own terminal tab. The launcher offers the ones ticked here. Claude
          Code gets the whole of Stoke around it; the others get the terminal, their own sign-in or
          an endpoint below, and Stoke’s browser tools where they accept an MCP server at launch
          (Codex, OpenCode).
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <button className="btn" onClick={onOpenPicker}>
            Choose agents…
          </button>
          <button className="btn" data-variant="ghost" onClick={onRefresh}>
            Look again
          </button>
        </div>
        {detection?.probeFailed && (
          <span className="field-hint" data-tone="warning">
            Stoke could not read your shell’s PATH, so an agent you have may be listed as not
            installed. Look again after opening a terminal once, or set its path in your shell profile.
          </span>
        )}
      </div>

      <div className="agent-settings">
        {CODING_CLIS.map((c) => (
          <AgentRow
            key={c.id}
            cli={c}
            path={detection?.clis.find((s) => s.id === c.id)?.path ?? null}
            conflict={detection?.clis.find((s) => s.id === c.id)?.conflict ?? null}
            checking={detection === null}
            shown={shown(c.id)}
            onShown={(on) => setShown(c.id, on)}
            endpoint={agents.endpoints[c.id] ?? DEFAULT_ENDPOINT}
            onEndpoint={(ep) => setEndpoint(c.id, ep)}
            openrouterKey={settings.providers.openrouterApiKey}
            installCommand={installSteps([c.id], platform)[0]?.command ?? null}
            onInstall={() => onInstall([c.id])}
          />
        ))}
      </div>
    </>
  )
}

function AgentRow({
  cli,
  path,
  conflict,
  checking,
  shown,
  onShown,
  endpoint,
  onEndpoint,
  openrouterKey,
  installCommand,
  onInstall
}: {
  cli: CodingCli
  path: string | null
  conflict: string | null
  checking: boolean
  shown: boolean
  onShown: (on: boolean) => void
  endpoint: AgentEndpoint
  onEndpoint: (ep: AgentEndpoint) => void
  openrouterKey: string
  installCommand: string | null
  onInstall: () => void
}): React.JSX.Element {
  const claude = isClaudeCode(cli.id)
  const canEndpoint = cli.endpoints.openrouter || cli.endpoints.custom !== null
  const caps = capsFor(cli.id)

  // Local drafts for the three text fields, committed together on blur.
  const [draft, setDraft] = useState(endpoint)
  const editing = useRef(false)
  const latest = useRef({ draft, endpoint, onEndpoint })
  latest.current = { draft, endpoint, onEndpoint }
  useEffect(() => {
    if (!editing.current) setDraft(endpoint)
  }, [endpoint])
  const commit = (): void => {
    editing.current = false
    const { draft: d, endpoint: e, onEndpoint: set } = latest.current
    if (JSON.stringify(d) !== JSON.stringify(e)) set(d)
  }
  useEffect(() => () => commit(), [])
  const edit = (patch: Partial<AgentEndpoint>): void => {
    editing.current = true
    setDraft((cur) => ({ ...cur, ...patch }))
  }
  const setMode = (mode: EndpointMode): void => {
    const next = { ...latest.current.draft, mode }
    setDraft(next)
    editing.current = false
    onEndpoint(next)
  }

  const problem = canEndpoint ? endpointProblem(cli.id, draft, openrouterKey) : null

  return (
    <div className="agent-setting">
      <span className="field-label">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-8)' }}>
          <input type="checkbox" checked={shown} onChange={(e) => onShown(e.target.checked)} />
          {cli.label}
        </label>{' '}
        <span className="pill" data-tone={path ? 'success' : undefined}>
          {checking ? 'checking…' : path ? 'installed' : 'not installed'}
        </span>
      </span>
      <span className="field-hint">
        {cli.vendor} · {cli.blurb}
      </span>
      {!path && conflict && (
        <span className="field-hint" data-tone="warning">
          A different program named {cli.bins.posix[0]} is at{' '}
          <span className="mono">{conflict}</span> — its --version is not {cli.label}’s, so Stoke
          will not launch it.
        </span>
      )}
      {path ? (
        <span className="field-hint mono" style={{ overflowWrap: 'anywhere' }}>
          {path}
        </span>
      ) : !checking ? (
        installCommand ? (
          <span className="field-hint">
            <button className="btn" onClick={onInstall}>
              Install {cli.label}
            </button>{' '}
            runs <code className="mono">{installCommand}</code>
            {cli.installNeeds && <> · needs {cli.installNeeds}</>}
            {cli.installNote && <> · {cli.installNote}</>}
          </span>
        ) : (
          <span className="field-hint">
            Not installed. See{' '}
            <a
              href={cli.home}
              onClick={(e) => {
                e.preventDefault()
                window.stoke.openExternal(cli.home)
              }}
            >
              {cli.home}
            </a>
          </span>
        )
      ) : null}

      {!claude && (
        <span className="field-hint">
          {caps.resume === 'continue'
            ? 'Resuming a paused tab continues the most recent session in its folder.'
            : 'A paused tab starts a new session when resumed.'}
        </span>
      )}

      {claude ? (
        <span className="field-hint">Its endpoint and keys are in Settings › Providers.</span>
      ) : canEndpoint ? (
        <div className="agent-endpoint">
          <select
            className="input"
            value={draft.mode}
            onChange={(e) => setMode(e.target.value as EndpointMode)}
            aria-label={`Where ${cli.label} sends requests`}
          >
            <option value="default">Its own sign-in</option>
            {cli.endpoints.openrouter && <option value="openrouter">OpenRouter</option>}
            {cli.endpoints.custom && <option value="custom">Custom endpoint</option>}
          </select>
          {draft.mode !== 'default' && (
            <input
              className="input mono"
              placeholder={draft.mode === 'openrouter' ? 'Model, e.g. anthropic/claude-sonnet-5' : 'Model id'}
              value={draft.model}
              spellCheck={false}
              onChange={(e) => edit({ model: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && commit()}
            />
          )}
          {draft.mode === 'custom' && (
            <>
              <input
                className="input mono"
                placeholder="https://host/v1"
                value={draft.baseUrl}
                spellCheck={false}
                onChange={(e) => edit({ baseUrl: e.target.value })}
                onBlur={commit}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
              />
              <input
                className="input mono"
                type="password"
                placeholder="API key (blank for a local server)"
                value={draft.apiKey}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => edit({ apiKey: e.target.value })}
                onBlur={commit}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
              />
            </>
          )}
          {draft.mode === 'custom' && cli.endpoints.custom && (
            <span className="field-hint">Must speak the {cli.endpoints.custom}.</span>
          )}
          {draft.mode === 'openrouter' && (
            <span className="field-hint">Uses the OpenRouter key in Settings › Providers.</span>
          )}
          {problem && (
            <span className="field-hint" data-tone="warning">
              {problem}
            </span>
          )}
        </div>
      ) : (
        <span className="field-hint">
          Uses its own sign-in; it has no way to be pointed at another endpoint from outside.
        </span>
      )}
    </div>
  )
}
