import { useEffect, useRef, useState } from 'react'
import {
  CODING_CLIS,
  capsFor,
  cliFor,
  isClaudeCode,
  type CodingCli,
  type CodingCliDetection,
  type CodingCliId
} from '@shared/codingClis'
import {
  AGENT_TAG_MAX,
  cleanTagLabel,
  DEFAULT_ENDPOINT,
  endpointProblem,
  installedAgents,
  installSteps,
  isModelId,
  resolveDefaultAgent,
  visibleAgents,
  type AgentEndpoint,
  type AgentSettings,
  type EndpointMode
} from '@shared/agents'
import type { EffortLevel, PermissionMode, Settings } from '@shared/types'
import { CLAUDE_SHARED_PLUGIN, SHARED_SKILLS_DIR, skillReport, type SkillDirScan } from '@shared/skills'
import { AGENT_SEEDS, agentSeed } from '@shared/agentColors'
import { Spinner } from './Spinner'
import { ColorField } from './ColorField'
import { FieldHint } from './FieldHint'
import { agentMark } from '../lib/agentColor'
import { EFFORT_LEVELS, MODEL_OPTIONS, PERMISSION_MODES, ULTRACODE_HINT } from '../lib/permissions'

/*
 * Settings › Agents: every coding agent Stoke can run, Claude Code included,
 * each on a page of its own with the same kinds of setting — whether the
 * launcher offers it, where it sends requests, its default model, its colour
 * and its tab tag. Stoke stays agent-agnostic by keeping each one's settings in
 * the same shape; what differs is only what each agent can honestly be handed
 * at launch (codingClis.ts), and every one of them is a flag or an environment
 * variable for one process, never a write into the agent's own config
 * (gotchas 38/39).
 *
 * Laid out as a header (the default agent, choosing and re-detecting agents,
 * the tab-tag switch and the skills report), then a sub-nav of the agents that
 * are installed or ticked, one page each, then "More agents" — the rest,
 * folded, each with its install button. Eighteen full rows end to end was the
 * layout this replaced.
 *
 * Claude Code's page holds its four launch defaults (moved from Sessions: the
 * same `settings.defaults` writer, so still one writer, gotcha 57) and the way
 * to Providers and Claude Code's own config. Never an endpoint: that is
 * Settings › Providers, and `hydrateAgents` refuses a Claude entry.
 *
 * Endpoint fields commit on blur and are flushed on unmount through a ref,
 * because Escape closes the sheet by unmounting it and delivers no blur
 * (gotcha 63) — and switching agent pages unmounts one too. The whole `agents`
 * block is sent on every commit: `setSettings` merges shallowly, so a partial
 * block would drop the other agents' entries.
 */
export function AgentsSettings({
  settings,
  onPatch,
  detection,
  claudeRunnable,
  onRefresh,
  onOpenPicker,
  onInstall,
  page,
  onPage,
  onOpenProviders,
  onOpenClaudeConfig
}: {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
  detection: CodingCliDetection | null
  /** Never rejects (App swallows a failed detection); settles when the look is done. */
  onRefresh: () => Promise<void>
  /** Claude Code's own probe answered (`CliInfo.ok`), which honours an explicit path. */
  claudeRunnable: boolean
  onOpenPicker: () => void
  onInstall: (ids: CodingCliId[]) => void
  /** The agent page on show; null for the default agent's. Held by the sheet so Sessions can open Claude's. */
  page: CodingCliId | null
  onPage: (id: CodingCliId) => void
  onOpenProviders: () => void
  onOpenClaudeConfig: () => void
}): React.JSX.Element {
  const agents = settings.agents
  const platform = window.stoke.platform
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  /*
   * "Look again" re-reads the login shell (gotcha 52), which takes seconds, and
   * a re-check keeps the last detection on screen — so the pages' "checking…"
   * pills, which only a `null` detection draws, never appeared, and the button
   * looked like it had done nothing. Its own state, and a ref claimed before
   * the await so a second press cannot start a second probe (gotcha 20).
   */
  const [looking, setLooking] = useState(false)
  const lookingRef = useRef(false)
  const lookAgain = (): void => {
    if (lookingRef.current) return
    lookingRef.current = true
    setLooking(true)
    void onRefresh().finally(() => {
      lookingRef.current = false
      setLooking(false)
    })
  }

  /*
   * The ref moves with the patch, not only on the next render: two commits in
   * one tick — a field flushed on unmount beside one committed on blur — would
   * otherwise each spread the SAME stale block, and the second would put the
   * first one's change back.
   */
  const patchAgents = (next: AgentSettings): void => {
    agentsRef.current = next
    onPatch({ agents: next })
  }

  const found = new Set(detection?.clis.filter((c) => c.path).map((c) => c.id) ?? [])
  const shown = (id: CodingCliId): boolean =>
    agents.chosen === null ? found.has(id) : agents.chosen.includes(id)

  const setShown = (id: CodingCliId, on: boolean): void => {
    // The first toggle turns "never asked" into an explicit list, starting from
    // what the launcher was showing — so it changes only the one clicked.
    const base = agentsRef.current.chosen ?? CODING_CLIS.map((c) => c.id).filter((x) => found.has(x))
    const next = on ? [...new Set([...base, id])] : base.filter((x) => x !== id)
    patchAgents({ ...agentsRef.current, chosen: CODING_CLIS.map((c) => c.id).filter((x) => next.includes(x)) })
  }

  /*
   * The default agent: what the launcher can offer (installed AND chosen), with
   * Claude Code counted when its own probe answered, and the stored value kept
   * in the list even when it is no longer on offer so the select never shows a
   * value it does not have — with a line saying what new sessions start instead.
   */
  const installed = installedAgents(detection?.clis ?? [], claudeRunnable)
  const offered = visibleAgents(agents.chosen, installed)
  const defaultOptions = offered.includes(agents.defaultCli) ? offered : [agents.defaultCli, ...offered]
  const startsInstead = detection ? resolveDefaultAgent(agents.defaultCli, offered) : agents.defaultCli

  /** An agent's colour; null or its own seed clears the override. */
  const setColor = (id: CodingCliId, hex: string | null): void => {
    const colors = { ...agentsRef.current.colors }
    if (!hex || hex.toLowerCase() === AGENT_SEEDS[id]) delete colors[id]
    else colors[id] = hex.toLowerCase()
    patchAgents({ ...agentsRef.current, colors })
  }

  /** An agent's tab tag; blank, or its executable's own name, clears it. */
  const setTagLabel = (id: CodingCliId, raw: string): void => {
    const label = cleanTagLabel(raw)
    const labels = { ...agentsRef.current.tag.labels }
    if (!label || label === cliFor(id).bins.posix[0]) delete labels[id]
    else labels[id] = label
    patchAgents({ ...agentsRef.current, tag: { ...agentsRef.current.tag, labels } })
  }

  const setEndpoint = (id: CodingCliId, ep: AgentEndpoint): void => {
    const endpoints = { ...agentsRef.current.endpoints }
    if (ep.mode === 'default' && !ep.model && !ep.baseUrl && !ep.apiKey) delete endpoints[id]
    else endpoints[id] = ep
    patchAgents({ ...agentsRef.current, endpoints })
  }

  const install = (id: CodingCliId): void => {
    // Installing an agent is choosing it: without this the launcher, which
    // shows only chosen agents, would not offer what was just installed —
    // while the exit card said it did.
    if (!shown(id)) setShown(id, true)
    onInstall([id])
  }

  /*
   * Pages for Claude Code, whatever its state — its launch defaults live
   * there — and for every agent that is installed or ticked; the rest are
   * "More agents". Ticking one there gives it a page.
   */
  const paged = CODING_CLIS.filter((c) => isClaudeCode(c.id) || installed.has(c.id) || shown(c.id))
  const more = CODING_CLIS.filter((c) => !paged.includes(c))
  const current =
    paged.find((c) => c.id === page) ?? paged.find((c) => c.id === startsInstead) ?? paged[0]

  const tabsRef = useRef<HTMLDivElement>(null)
  const onTabKey = (e: React.KeyboardEvent): void => {
    const i = paged.findIndex((c) => c.id === current.id)
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (i + 1) % paged.length
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (i - 1 + paged.length) % paged.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? paged.length - 1
              : -1
    if (to < 0) return
    e.preventDefault()
    // Kept from reaching the sheet's own section nav, which listens above.
    e.stopPropagation()
    onPage(paged[to].id)
    tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus()
  }

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="agents-default">
          Default agent
        </label>
        <span className="field-hint">
          What a new session starts: the launcher&rsquo;s Start, the sidebar&rsquo;s new session,
          Start on launch, a scratch folder, <span className="mono">stoke .</span> and the
          phone&rsquo;s New session. Resuming or continuing a conversation stays with Claude Code,
          whose conversations they are.
        </span>
        <select
          id="agents-default"
          className="select"
          value={agents.defaultCli}
          onChange={(e) => patchAgents({ ...agentsRef.current, defaultCli: e.target.value as CodingCliId })}
        >
          {defaultOptions.map((id) => (
            <option key={id} value={id}>
              {cliFor(id).label}
              {offered.includes(id) ? '' : ' — not installed, or not shown in the launcher'}
            </option>
          ))}
        </select>
        {startsInstead !== agents.defaultCli && (
          <span className="field-hint" data-tone="warning">
            {cliFor(agents.defaultCli).label} is not installed, or not shown in the launcher, so new
            sessions start {cliFor(startsInstead).label} until it is both.
          </span>
        )}
        <div className="agent-actions">
          <button className="btn" onClick={onOpenPicker}>
            Choose agents…
          </button>
          <button
            className="btn"
            data-variant="ghost"
            disabled={looking}
            aria-busy={looking}
            onClick={lookAgain}
          >
            {looking && <Spinner />}
            {looking ? 'Looking…' : 'Look again'}
          </button>
        </div>
        {detection?.probeFailed && (
          <span className="field-hint" data-tone="warning">
            Stoke could not read your shell’s PATH, so an agent you have may be listed as not
            installed. Look again after opening a terminal once, or set its path in your shell profile.
          </span>
        )}
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={agents.tag.show}
          onChange={(e) =>
            patchAgents({ ...agentsRef.current, tag: { ...agentsRef.current.tag, show: e.target.checked } })
          }
        />
        <span>
          <span className="field-label">Show agent tags on tabs</span>
          <FieldHint
            more={
              <>
                Each agent&rsquo;s page names its tag. Off, the tab keeps a rule in the agent&rsquo;s
                colour and its tooltip still names it. Colours show once more than one agent is in
                use.
              </>
            }
          >
            A tab running an agent other than the default says which, in a small tag.
          </FieldHint>
        </span>
      </label>

      <SkillsReport
        agents={CODING_CLIS.map((c) => c.id).filter((id) => shown(id) && found.has(id))}
        share={agents.shareSkillsToClaude}
        onShare={(on) => patchAgents({ ...agentsRef.current, shareSkillsToClaude: on })}
      />

      <div className="agent-area">
        <div
          className="agent-tabs"
          role="tablist"
          aria-label="Agents"
          ref={tabsRef}
          onKeyDown={onTabKey}
        >
          {paged.map((c) => (
            <button
              key={c.id}
              className="agent-tab"
              role="tab"
              id={`agent-tab-${c.id}`}
              aria-controls="agent-page"
              aria-selected={c.id === current.id}
              tabIndex={c.id === current.id ? 0 : -1}
              title={c.vendor}
              onClick={() => onPage(c.id)}
              {...agentMark(c.id)}
            >
              <span className="agent-tab-dot" aria-hidden="true" />
              {c.label}
              {!installed.has(c.id) && detection && <span className="agent-tab-note">not installed</span>}
            </button>
          ))}
        </div>

        <div className="agent-page" role="tabpanel" id="agent-page" aria-labelledby={`agent-tab-${current.id}`}>
          <AgentPage
            key={current.id}
            cli={current}
            path={detection?.clis.find((s) => s.id === current.id)?.path ?? null}
            installed={installed.has(current.id)}
            conflict={detection?.clis.find((s) => s.id === current.id)?.conflict ?? null}
            checking={detection === null}
            isDefault={startsInstead === current.id}
            shown={shown(current.id)}
            onShown={(on) => setShown(current.id, on)}
            endpoint={agents.endpoints[current.id] ?? DEFAULT_ENDPOINT}
            onEndpoint={(ep) => setEndpoint(current.id, ep)}
            color={agentSeed(current.id, agents.colors)}
            colorOverridden={agents.colors[current.id] !== undefined}
            onColor={(hex) => setColor(current.id, hex)}
            tagLabel={agents.tag.labels[current.id] ?? ''}
            onTagLabel={(label) => setTagLabel(current.id, label)}
            openrouterKey={settings.providers.openrouterApiKey}
            installCommand={installSteps([current.id], platform)[0]?.command ?? null}
            onInstall={() => install(current.id)}
            claude={
              isClaudeCode(current.id) ? (
                <ClaudePage
                  settings={settings}
                  onPatch={onPatch}
                  onOpenProviders={onOpenProviders}
                  onOpenClaudeConfig={onOpenClaudeConfig}
                />
              ) : null
            }
          />
        </div>
      </div>

      {more.length > 0 && (
        <details className="agent-more" data-testid="more-agents">
          <summary>
            More agents <span className="agent-more-count">{more.length} not installed</span>
          </summary>
          <div className="agent-more-list">
            {more.map((c) => (
              <AgentBrief
                key={c.id}
                cli={c}
                conflict={detection?.clis.find((s) => s.id === c.id)?.conflict ?? null}
                checking={detection === null}
                shown={shown(c.id)}
                onShown={(on) => setShown(c.id, on)}
                installCommand={installSteps([c.id], platform)[0]?.command ?? null}
                onInstall={() => install(c.id)}
              />
            ))}
          </div>
        </details>
      )}
    </>
  )
}

/** Where an agent is, or how to get it: its path, a name clash, or its install. */
function AgentWhere({
  cli,
  path,
  conflict,
  checking,
  installCommand,
  onInstall
}: {
  cli: CodingCli
  path: string | null
  conflict: string | null
  checking: boolean
  installCommand: string | null
  onInstall: () => void
}): React.JSX.Element | null {
  return (
    <>
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
    </>
  )
}

/** One agent's page: what and where it is, then everything Stoke can set for it. */
function AgentPage({
  cli,
  path,
  installed,
  conflict,
  checking,
  isDefault,
  shown,
  onShown,
  endpoint,
  onEndpoint,
  openrouterKey,
  installCommand,
  onInstall,
  color,
  colorOverridden,
  onColor,
  tagLabel,
  onTagLabel,
  claude
}: {
  cli: CodingCli
  path: string | null
  /** Detection found it, or — for Claude Code — its own probe answered. */
  installed: boolean
  conflict: string | null
  checking: boolean
  /** New sessions start this agent (`resolveDefaultAgent`). */
  isDefault: boolean
  shown: boolean
  onShown: (on: boolean) => void
  endpoint: AgentEndpoint
  onEndpoint: (ep: AgentEndpoint) => void
  openrouterKey: string
  installCommand: string | null
  onInstall: () => void
  /** The colour it is drawn in: the user's, else its seed. */
  color: string
  colorOverridden: boolean
  /** Null resets to the seed. */
  onColor: (hex: string | null) => void
  /** The stored tab tag, '' for the executable's name. */
  tagLabel: string
  onTagLabel: (label: string) => void
  /** Claude Code's own section, drawn in place of an endpoint. */
  claude: React.ReactNode
}): React.JSX.Element {
  const caps = capsFor(cli.id)
  return (
    <>
      <div className="agent-page-intro">
        <div className="agent-page-head" {...agentMark(cli.id)}>
          <span className="agent-tab-dot" aria-hidden="true" />
          <h3 className="agent-page-title">{cli.label}</h3>
          <span className="pill" data-tone={installed ? 'success' : undefined}>
            {checking ? 'checking…' : installed ? 'installed' : 'not installed'}
          </span>
          {isDefault && <span className="pill" data-tone="accent">default</span>}
        </div>
        <span className="field-hint">
          {cli.vendor} · {cli.blurb}
        </span>
        <AgentWhere
          cli={cli}
          path={path}
          conflict={conflict}
          checking={checking}
          installCommand={installCommand}
          onInstall={onInstall}
        />
      </div>

      <label className="check-row">
        <input type="checkbox" checked={shown} onChange={(e) => onShown(e.target.checked)} />
        <span>
          <span className="field-label">Show in the launcher</span>
          {!isClaudeCode(cli.id) && (
            <span className="field-hint">
              {caps.resume === 'continue'
                ? 'Resuming a paused tab continues the most recent session in its folder.'
                : 'A paused tab starts a new session when resumed.'}
            </span>
          )}
        </span>
      </label>

      {claude ?? <AgentEndpointFields cli={cli} endpoint={endpoint} onEndpoint={onEndpoint} openrouterKey={openrouterKey} />}

      <AgentLook
        cli={cli}
        color={color}
        colorOverridden={colorOverridden}
        onColor={onColor}
        tagLabel={tagLabel}
        onTagLabel={onTagLabel}
      />
    </>
  )
}

/**
 * Where a non-Claude agent sends its requests, and the model it asks for — one
 * `endpoint.model` field for both (gotcha 57): the endpoint's model off its own
 * sign-in, and its Default model on it, passed through the flag the table
 * confirmed (`modelArgs`). An agent with no confirmed flag chooses its own.
 */
function AgentEndpointFields({
  cli,
  endpoint,
  onEndpoint,
  openrouterKey
}: {
  cli: CodingCli
  endpoint: AgentEndpoint
  onEndpoint: (ep: AgentEndpoint) => void
  openrouterKey: string
}): React.JSX.Element {
  const canEndpoint = cli.endpoints.openrouter || cli.endpoints.custom !== null

  // Local drafts for the text fields, committed together on blur.
  const [draft, setDraft] = useState(endpoint)
  const editing = useRef(false)
  const latest = useRef({ draft, endpoint, onEndpoint })
  latest.current = { draft, endpoint, onEndpoint }
  useEffect(() => {
    if (!editing.current) setDraft(endpoint)
  }, [endpoint])
  /*
   * A model that is not a model id is never committed: the store would drop it
   * (`hydrateEndpoint`) and the field would empty itself under the user. It
   * stays in the field, beside the sentence saying why, and the rest of the
   * draft — a base URL typed in the same pass — is committed without it.
   */
  const commit = (): void => {
    const { draft: d, endpoint: e, onEndpoint: set } = latest.current
    const model = d.model.trim()
    const bad = model !== '' && !isModelId(model)
    editing.current = bad
    const next = bad ? { ...d, model: e.model } : { ...d, model }
    if (JSON.stringify(next) !== JSON.stringify(e)) set(next)
  }
  useEffect(() => () => commit(), [])
  const edit = (patch: Partial<AgentEndpoint>): void => {
    editing.current = true
    setDraft((cur) => ({ ...cur, ...patch }))
  }
  /*
   * A mode change clears the model: an id means something only to the
   * endpoint it was picked for, and an OpenRouter id carried back to the
   * agent's own sign-in would now be passed there as its Default model.
   */
  const setMode = (mode: EndpointMode): void => {
    const next = { ...latest.current.draft, mode, model: '' }
    setDraft(next)
    editing.current = false
    onEndpoint(next)
  }

  const problem = endpointProblem(cli.id, { ...draft, model: draft.model.trim() }, openrouterKey)
  const onOwnSignIn = draft.mode === 'default'
  const askable = !!cli.modelArgs
  const flagShape = cli.modelArgs ? [cli.bins.posix[0], ...cli.modelArgs('<model>')].join(' ') : ''

  return (
    <div className="agent-endpoint">
      <div className="field">
        <span className="field-label">Where it sends requests</span>
        {canEndpoint ? (
          <>
            <select
              className="select"
              value={draft.mode}
              onChange={(e) => setMode(e.target.value as EndpointMode)}
              aria-label={`Where ${cli.label} sends requests`}
            >
              <option value="default">Its own sign-in</option>
              {cli.endpoints.openrouter && <option value="openrouter">OpenRouter</option>}
              {cli.endpoints.custom && <option value="custom">Custom endpoint</option>}
            </select>
            {draft.mode === 'openrouter' && (
              <span className="field-hint">Uses the OpenRouter key in Settings › Providers.</span>
            )}
          </>
        ) : (
          <span className="field-hint">
            Its own sign-in; it has no way to be pointed at another endpoint from outside.
          </span>
        )}
      </div>

      {draft.mode === 'custom' && (
        <div className="field">
          <span className="field-label">Endpoint</span>
          <input
            className="input mono"
            placeholder="https://host/v1"
            aria-label={`${cli.label} endpoint base URL`}
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
            aria-label={`${cli.label} endpoint API key`}
            value={draft.apiKey}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => edit({ apiKey: e.target.value })}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
          {cli.endpoints.custom && <span className="field-hint">Must speak the {cli.endpoints.custom}.</span>}
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor={`agent-model-${cli.id}`}>
          {onOwnSignIn ? 'Default model' : 'Model'}
        </label>
        {!onOwnSignIn || askable ? (
          <>
            <input
              id={`agent-model-${cli.id}`}
              className="input mono"
              placeholder={
                draft.mode === 'openrouter'
                  ? 'e.g. anthropic/claude-sonnet-5'
                  : onOwnSignIn
                    ? cli.modelExample
                      ? `Blank lets ${cli.label} choose — e.g. ${cli.modelExample}`
                      : `Blank lets ${cli.label} choose`
                    : 'Model id'
              }
              value={draft.model}
              spellCheck={false}
              onChange={(e) => edit({ model: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && commit()}
            />
            {onOwnSignIn && (
              <span className="field-hint">
                Asked for at every launch as <code className="mono">{flagShape}</code>, on its own
                sign-in. Blank sends nothing.
              </span>
            )}
          </>
        ) : (
          <span className="field-hint" data-testid="agent-model-inside">
            {cli.label} chooses its model inside the agent: Stoke has no confirmed flag to ask it
            for one.
          </span>
        )}
      </div>

      {problem && (
        <span className="field-hint" data-tone="warning">
          {problem}
        </span>
      )}
    </div>
  )
}

/*
 * Claude Code's page: the four launch defaults every new Claude session starts
 * with, and the two sections that hold the rest of Claude — its keys and
 * gateway, and its own settings file. The defaults moved here from Sessions
 * and still write `settings.defaults`, the one value the launcher derives its
 * chips from (gotcha 57).
 */
function ClaudePage({
  settings,
  onPatch,
  onOpenProviders,
  onOpenClaudeConfig
}: {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
  onOpenProviders: () => void
  onOpenClaudeConfig: () => void
}): React.JSX.Element {
  const d = settings.defaults
  return (
    <>
      <div className="field">
        <span className="field-label">Default permissions</span>
        <div className="segmented" role="group" aria-label="Default permission mode">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.id}
              aria-pressed={d.permissionMode === m.id}
              data-danger={m.danger ? 'true' : undefined}
              title={m.hint}
              onClick={() => onPatch({ defaults: { ...d, permissionMode: m.id as PermissionMode } })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="field-hint">Applied to every new session unless changed at launch.</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="claude-default-model">
          Default model
        </label>
        <select
          id="claude-default-model"
          className="select"
          value={d.model}
          onChange={(e) => onPatch({ defaults: { ...d, model: e.target.value } })}
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m.id || 'default'} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="claude-default-effort">
          Default effort
        </label>
        <select
          id="claude-default-effort"
          className="select"
          value={d.effort}
          onChange={(e) => onPatch({ defaults: { ...d, effort: e.target.value as EffortLevel } })}
        >
          {EFFORT_LEVELS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </div>

      {/*
        The fourth launch default. The launcher has had an Ultracode toggle
        since it shipped and the old Sessions pane had the other three, so the
        one option you would most want on by default was the one that had to be
        re-ticked for every session.
      */}
      <label className="check-row">
        <input
          type="checkbox"
          checked={d.ultracode}
          onChange={(e) => onPatch({ defaults: { ...d, ultracode: e.target.checked } })}
        />
        <span>
          <span className="field-label">Start sessions with Ultracode</span>
          <FieldHint
            more={
              <>
                Ultracode is a key in the settings file Stoke writes for each session, not a flag,
                and the CLI resolves effort to its own maximum while it is on — so the Effort
                control above is overridden for as long as this is ticked, and comes back when it
                is not.
              </>
            }
          >
            {ULTRACODE_HINT}
          </FieldHint>
        </span>
      </label>

      <div className="field">
        <span className="field-label">Endpoint and keys</span>
        <span className="field-hint">
          Claude Code&rsquo;s API keys, gateway and the shared OpenRouter key are in Providers.
        </span>
        <div className="agent-actions">
          <button className="btn" onClick={onOpenProviders}>
            Open Providers
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field-label">Its own settings</span>
        <span className="field-hint">
          What Claude Code keeps in <span className="mono">~/.claude/settings.json</span>: thinking,
          its theme, its update channel and the rest.
        </span>
        <div className="agent-actions">
          <button className="btn" onClick={onOpenClaudeConfig}>
            Open Claude Code settings
          </button>
        </div>
      </div>
    </>
  )
}

/** A not-installed, unticked agent under "More agents": what it is, and how to get it. */
function AgentBrief({
  cli,
  conflict,
  checking,
  shown,
  onShown,
  installCommand,
  onInstall
}: {
  cli: CodingCli
  conflict: string | null
  checking: boolean
  shown: boolean
  onShown: (on: boolean) => void
  installCommand: string | null
  onInstall: () => void
}): React.JSX.Element {
  return (
    <div className="agent-brief">
      <label className="check-row">
        <input type="checkbox" checked={shown} onChange={(e) => onShown(e.target.checked)} />
        <span>
          <span className="field-label">{cli.label}</span>
          <span className="field-hint">
            {cli.vendor} · {cli.blurb}
          </span>
        </span>
      </label>
      <AgentWhere
        cli={cli}
        path={null}
        conflict={conflict}
        checking={checking}
        installCommand={installCommand}
        onInstall={onInstall}
      />
    </div>
  )
}

/*
 * How an agent looks in the strip: its colour and its tab tag.
 *
 * The tag commits on blur and Enter, and is flushed on unmount through a ref,
 * because Escape closes the sheet by unmounting it and delivers no blur
 * (gotcha 63); the colour field does the same through `commitOnUnmount`.
 */
function AgentLook({
  cli,
  color,
  colorOverridden,
  onColor,
  tagLabel,
  onTagLabel
}: {
  cli: CodingCli
  color: string
  colorOverridden: boolean
  onColor: (hex: string | null) => void
  tagLabel: string
  onTagLabel: (label: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(tagLabel)
  const editing = useRef(false)
  const latest = useRef({ draft, tagLabel, onTagLabel })
  latest.current = { draft, tagLabel, onTagLabel }
  useEffect(() => {
    if (!editing.current) setDraft(tagLabel)
  }, [tagLabel])
  const commit = (): void => {
    editing.current = false
    const { draft: d, tagLabel: stored, onTagLabel: set } = latest.current
    if (d.trim() !== stored) set(d)
  }
  useEffect(() => () => commit(), [])

  return (
    <div className="field">
      <span className="field-label">In the tab strip</span>
      <div className="agent-look">
        <span className="agent-look-row">
          <span className="agent-look-label">Colour</span>
          <ColorField
            value={color}
            notation="hex"
            label={`${cli.label} colour`}
            onChange={(hex) => onColor(hex)}
            commitOnUnmount
          />
          {colorOverridden && (
            <button className="btn" data-variant="ghost" onClick={() => onColor(null)}>
              Reset
            </button>
          )}
        </span>
        <label className="agent-look-row">
          <span className="agent-look-label">Tab tag</span>
          <input
            className="input mono"
            value={draft}
            placeholder={cli.bins.posix[0]}
            maxLength={AGENT_TAG_MAX}
            spellCheck={false}
            aria-label={`${cli.label} tab tag`}
            onChange={(e) => {
              editing.current = true
              setDraft(e.target.value)
            }}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
        </label>
      </div>
    </div>
  )
}

/*
 * Which skills each of your agents can see. Read-only: it says where a skill
 * has to live to reach everyone, and never moves one (shared/skills.ts says
 * why a sync would be worse than the problem). The one thing it switches is
 * the launch-time lending of the shared folder to Claude Code, which writes
 * nothing into any agent's folder either (skillsProject.ts).
 */
function SkillsReport({
  agents,
  share,
  onShare
}: {
  agents: CodingCliId[]
  share: boolean
  onShare: (on: boolean) => void
}): React.JSX.Element {
  const [scans, setScans] = useState<SkillDirScan[] | null>(null)
  useEffect(() => {
    let live = true
    void window.stoke.cli.skills().then((s) => {
      if (live) setScans(s)
    })
    return () => {
      live = false
    }
  }, [])
  const report = scans && agents.length > 0 ? skillReport(scans, agents, { shareToClaude: share }) : null
  const label = (id: CodingCliId): string => cliFor(id).label
  return (
    <div className="field" data-testid="skills-report">
      <span className="field-label">Skills</span>
      <span className="field-hint">
        Every agent here reads the same SKILL.md format, from different folders.{' '}
        <span className="mono">{SHARED_SKILLS_DIR}</span> is the one nearly all of them share.
        Claude Code reads only <span className="mono">~/.claude/skills</span> and its own plugins.
      </span>
      <label className="check-row">
        <input type="checkbox" checked={share} onChange={(e) => onShare(e.target.checked)} />
        <span>
          <span className="field-label">Lend Claude Code the shared skills</span>
          <FieldHint
            more={
              <>
                Each local Claude Code session also gets the skills in{' '}
                <span className="mono">{SHARED_SKILLS_DIR}</span> it would not otherwise see, as a
                plugin for that session only: linked, not copied, and nothing is written into{' '}
                <span className="mono">~/.claude</span>. Claude names them{' '}
                <span className="mono">{CLAUDE_SHARED_PLUGIN}:</span>
                <em>skill</em>, so a shared <span className="mono">pdf</span> is{' '}
                <span className="mono">/{CLAUDE_SHARED_PLUGIN}:pdf</span>. A project’s{' '}
                <span className="mono">skillOverrides</span> still apply. SSH tabs are not lent
                anything. <span className="mono">claude import</span> does the opposite: it copies
                the shared folder into <span className="mono">~/.claude/skills</span>, and those
                copies drift from the originals on the next edit.
              </>
            }
          >
            As a plugin for each local session: linked, not copied, nothing written into ~/.claude.
          </FieldHint>
        </span>
      </label>
      {report && share && (
        <span className="field-hint">
          {report.projected.length === 0
            ? 'Claude Code already sees every shared skill.'
            : `${report.projected.length} shared skill${report.projected.length === 1 ? '' : 's'} reach Claude Code this way: ${report.projected.join(', ')}.`}
        </span>
      )}
      {report && report.total > 0 && (
        <span className="field-hint">
          {report.perAgent.map((a) => `${label(a.id)} ${a.visible}`).join(' · ')} — of {report.total}.
        </span>
      )}
      {report && report.partial.length > 0 && (
        <details>
          <summary className="field-hint">
            {report.partial.length} skill{report.partial.length === 1 ? '' : 's'} some of your agents
            cannot see
          </summary>
          <ul className="field-hint" style={{ margin: 0, paddingLeft: 'var(--space-16)' }}>
            {report.partial.map((r) => (
              <li key={r.name}>
                <span className="mono">{r.name}</span> — not {r.missing.map(label).join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {report && report.duplicated.length > 0 && (
        <details>
          <summary className="field-hint" data-tone="warning">
            {report.duplicated.length} skill{report.duplicated.length === 1 ? ' exists' : 's exist'} as
            separate copies, which drift apart on the next edit
          </summary>
          <ul className="field-hint" style={{ margin: 0, paddingLeft: 'var(--space-16)' }}>
            {report.duplicated.map((r) => (
              <li key={r.name}>
                <span className="mono">{r.name}</span> — {r.dirs.join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
