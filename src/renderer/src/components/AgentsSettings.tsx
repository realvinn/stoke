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
import { agentAccessOptions, type AgentAccessMode } from '@shared/agentAccess'
import {
  ACCOUNT_KEY_ENV,
  ACCOUNT_LABEL_MAX,
  accountKindsFor,
  accountsOf,
  DEFAULT_ACCOUNT_ID,
  type AccountKind,
  type AgentAccount
} from '@shared/accounts'
import {
  accountMcpLines,
  mcpTicksFor,
  STOKE_BROWSER_SERVER,
  urlInArgvProblem,
  withMcpTick,
  type AccountMcpSummary,
  type McpCatalog,
  type McpServerSpec
} from '@shared/mcpServers'
import { Spinner } from './Spinner'
import { ColorField } from './ColorField'
import { FieldHint } from './FieldHint'
import { agentMark } from '../lib/agentColor'
import { agentRowId, type SettingsLocation } from '@shared/settingsIndex'
import { EFFORT_LEVELS, MODEL_OPTIONS, PERMISSION_MODES, ULTRACODE_HINT } from '../lib/permissions'

/*
 * Settings › Agents: every coding agent Stoke can run, Claude Code included.
 *
 * It was one section with a strip of agent tabs inside it, and the owner asked
 * for what the menu now is: Agents opens in the Settings menu itself to the
 * Agent manager and each INSTALLED agent, and Claude Code opens further to its
 * launch defaults, its own settings file and its provider and keys — the three
 * things that used to be three unrelated places (a pointer in Sessions, the
 * "Claude Code" section, and "Providers"). This file draws three of those
 * pages; the sheet draws the tree (`navTree`, shared/settingsIndex.ts).
 *
 * - `AgentManager` — everything about agents as a set: the default agent,
 *   choosing and re-detecting them, installing one, which the launcher shows,
 *   each one's colour, the tab-tag switch and the skills report.
 * - `AgentSettingsPage` — one agent: what and where it is, where it sends
 *   requests and its default model, its accounts, its tools, its colour and
 *   tab tag. Claude Code's has no endpoint (that is Provider & keys, and
 *   `hydrateAgents` refuses a Claude entry); it points at its three sub-pages.
 * - `ClaudeLaunchDefaults` — Claude Code's four launch defaults, still the
 *   one `settings.defaults` writer the launcher derives its chips from
 *   (gotcha 57).
 *
 * Each agent's settings keep the same shape, so Stoke stays agent-agnostic;
 * what differs is only what each can honestly be handed at launch
 * (codingClis.ts), and every one of them is a flag or an environment variable
 * for one process, never a write into the agent's own config (gotchas 38/39).
 *
 * Endpoint fields commit on blur and are flushed on unmount through a ref,
 * because Escape closes the sheet by unmounting it and delivers no blur
 * (gotcha 63) — and moving to another page unmounts one too. The whole `agents`
 * block is sent on every commit: `setSettings` merges shallowly, so a partial
 * block would drop the other agents' entries.
 */

/** What every agent page needs from the sheet. App owns the detection and the tab-opening actions. */
export interface AgentPagesProps {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
  detection: CodingCliDetection | null
  /** Claude Code's own probe answered (`CliInfo.ok`), which honours an explicit path. */
  claudeRunnable: boolean
  /** Never rejects (App swallows a failed detection); settles when the look is done. */
  onRefresh: () => Promise<void>
  onOpenPicker: () => void
  onInstall: (ids: CodingCliId[]) => void
  /** Open an account's sign-in tab (App's, like an install: it opens a tab and closes the sheet). */
  onSignIn: (accountId: string) => void
  /** Move the sheet to another page — an agent's own, or one of Claude Code's. */
  onGo: (loc: SettingsLocation) => void
  /**
   * An agent's colour while its picker moves, unsaved; null withdraws it.
   * App's, because `applyAppearance` is the one writer of every colour on
   * :root — the tab tags and pane rules repaint through it, not beside it.
   */
  onPreviewColor?: (id: CodingCliId, hex: string | null) => void
}

/*
 * The agents block's one set of writers, for whichever page is mounted. Only
 * one agent page is ever on screen, so each holds its own ref; the ref moves
 * with the patch, not only on the next render: two commits in one tick — a
 * field flushed on unmount beside one committed on blur — would otherwise each
 * spread the SAME stale block, and the second would put the first one's
 * change back.
 */
function useAgentControls({ settings, onPatch, detection, claudeRunnable, onInstall }: AgentPagesProps) {
  const agents = settings.agents
  const agentsRef = useRef(agents)
  agentsRef.current = agents

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
  const startsInstead = detection ? resolveDefaultAgent(agents.defaultCli, offered) : agents.defaultCli

  /** An agent's colour; null or its own seed clears the override. */
  const setColor = (id: CodingCliId, hex: string | null): void => {
    const colors = { ...agentsRef.current.colors }
    if (!hex || hex.toLowerCase() === AGENT_SEEDS[id]) delete colors[id]
    else colors[id] = hex.toLowerCase()
    patchAgents({ ...agentsRef.current, colors })
  }

  const install = (id: CodingCliId): void => {
    // Installing an agent is choosing it: without this the launcher, which
    // shows only chosen agents, would not offer what was just installed —
    // while the exit card said it did.
    if (!shown(id)) setShown(id, true)
    onInstall([id])
  }

  return { agents, agentsRef, patchAgents, found, shown, setShown, installed, offered, startsInstead, setColor, install }
}

/*
 * Settings › Agents › Agent manager: the agents as a set. The default agent and
 * the two ways to change which agents there are (the picker, and looking
 * again), then one row per agent you have — its colour, whether the launcher
 * shows it, and the way to its own page — then the ones you do not, each with
 * its install. The tab-tag switch and the skills report are about every agent
 * at once, so they are here too.
 */
export function AgentManager(props: AgentPagesProps): React.JSX.Element {
  const { detection, onRefresh, onOpenPicker, onGo } = props
  const c = useAgentControls(props)
  const { agents, agentsRef, patchAgents, installed, offered, startsInstead } = c
  const platform = window.stoke.platform

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

  const defaultOptions = offered.includes(agents.defaultCli) ? offered : [agents.defaultCli, ...offered]

  /*
   * Yours: Claude Code, whatever its state — its launch defaults live under it
   * — and every agent that is installed or ticked. The rest are More agents,
   * and ticking one there moves it up here.
   */
  const yours = CODING_CLIS.filter((x) => isClaudeCode(x.id) || installed.has(x.id) || c.shown(x.id))
  const more = CODING_CLIS.filter((x) => !yours.includes(x))

  return (
    <>
      <div className="field" data-setting="agents.default">
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

      <div className="field" data-setting="agents.list">
        <span className="field-label">Your agents</span>
        <span className="field-hint">
          Each one&rsquo;s colour marks its tabs and its usage once more than one agent is in use.
          Its own page — where it sends requests, its model, accounts and tools — is under Agents in
          the menu.
        </span>
        <div className="agent-roster">
          {yours.map((x) => (
            <AgentRosterRow
              key={x.id}
              cli={x}
              installed={installed.has(x.id)}
              checking={detection === null}
              isDefault={startsInstead === x.id}
              shown={c.shown(x.id)}
              onShown={(on) => c.setShown(x.id, on)}
              color={agentSeed(x.id, agents.colors)}
              colorOverridden={agents.colors[x.id] !== undefined}
              tagLabel={agents.tag.labels[x.id] ?? ''}
              onColor={(hex) => c.setColor(x.id, hex)}
              onPreviewColor={props.onPreviewColor ? (hex) => props.onPreviewColor?.(x.id, hex) : undefined}
              onOpen={() => onGo({ page: 'agent', agent: x.id })}
            />
          ))}
        </div>
      </div>

      {more.length > 0 && (
        <details className="agent-more" data-testid="more-agents" data-setting="agents.more">
          <summary>
            More agents <span className="agent-more-count">{more.length} not installed</span>
          </summary>
          <div className="agent-more-list">
            {more.map((x) => (
              <AgentBrief
                key={x.id}
                cli={x}
                conflict={detection?.clis.find((s) => s.id === x.id)?.conflict ?? null}
                checking={detection === null}
                shown={c.shown(x.id)}
                onShown={(on) => c.setShown(x.id, on)}
                installCommand={installSteps([x.id], platform)[0]?.command ?? null}
                onInstall={() => c.install(x.id)}
              />
            ))}
          </div>
        </details>
      )}

      <label className="check-row" data-setting="agents.tags">
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
        agents={CODING_CLIS.map((x) => x.id).filter((id) => c.shown(id) && c.found.has(id))}
        share={agents.shareSkillsToClaude}
        onShare={(on) => patchAgents({ ...agentsRef.current, shareSkillsToClaude: on })}
      />
    </>
  )
}

/**
 * One of your agents in the manager: its dot, name and state, whether the
 * launcher shows it, its colour, and the way to its page. The colour is the
 * same `ColorField` the agent's own page uses (and the theme editor), so a
 * better picker lands in every one of them at once.
 */
function AgentRosterRow({
  cli,
  installed,
  checking,
  isDefault,
  shown,
  onShown,
  color,
  colorOverridden,
  tagLabel,
  onColor,
  onPreviewColor,
  onOpen
}: {
  cli: CodingCli
  installed: boolean
  checking: boolean
  isDefault: boolean
  shown: boolean
  onShown: (on: boolean) => void
  color: string
  colorOverridden: boolean
  /** The agent's own tab tag, '' for none: the picker's sample shows what the tab draws. */
  tagLabel: string
  onColor: (hex: string | null) => void
  onPreviewColor?: (hex: string | null) => void
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div className="agent-roster-row" data-setting={agentRowId(cli.id)} {...agentMark(cli.id)}>
      <div className="agent-roster-head">
        <span className="agent-tab-dot" aria-hidden="true" />
        <span className="agent-roster-name">{cli.label}</span>
        <span className="pill" data-tone={installed ? 'success' : undefined}>
          {checking ? 'checking…' : installed ? 'installed' : 'not installed'}
        </span>
        {isDefault && (
          <span className="pill" data-tone="accent">
            default
          </span>
        )}
        <button
          className="btn agent-roster-open"
          data-variant="ghost"
          onClick={onOpen}
          title={`${cli.label}’s own settings`}
        >
          Settings ›
        </button>
      </div>
      <div className="agent-roster-controls">
        <label className="check-row agent-roster-shown">
          <input
            type="checkbox"
            checked={shown}
            onChange={(e) => onShown(e.target.checked)}
            aria-label={`Show ${cli.label} in the launcher`}
          />
          <span className="field-hint">In the launcher</span>
        </label>
        <span className="agent-look-row">
          <span className="agent-look-label">Colour</span>
          <ColorField
            value={color}
            notation="hex"
            label={`${cli.label} colour`}
            onChange={(hex) => onColor(hex)}
            commitOnUnmount
            presets={AGENT_PRESETS}
            defaultValue={AGENT_SEEDS[cli.id]}
            ink={{ kind: 'agent', key: cli.id, tag: tagLabel.trim() || cli.bins.posix[0] }}
            onPreview={onPreviewColor}
          />
          {colorOverridden && (
            <button className="btn" data-variant="ghost" onClick={() => onColor(null)}>
              Reset
            </button>
          )}
        </span>
      </div>
    </div>
  )
}

/*
 * Settings › Agents › <an agent>: one agent's own page. Claude Code's has no
 * endpoint of its own and instead points at the three pages under it.
 */
export function AgentSettingsPage(props: AgentPagesProps & { agent: CodingCliId }): React.JSX.Element {
  const { settings, onPatch, detection, onSignIn, onGo, agent } = props
  const c = useAgentControls(props)
  const { agents, agentsRef, patchAgents, installed, startsInstead } = c
  const platform = window.stoke.platform
  const current = cliFor(agent)

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

  /*
   * Claude Code's MCP servers, as names and kinds only (main never sends a
   * value). Read once when the page opens; every LAUNCH reads the file
   * afresh, so this list is only what can be ticked, never what is handed.
   */
  const [catalog, setCatalog] = useState<McpCatalog | null>(null)
  useEffect(() => {
    let live = true
    void window.stoke.cli.mcpServers().then(
      (cat) => live && setCatalog(cat),
      () =>
        live &&
        setCatalog({
          user: [],
          local: [],
          project: [],
          unapproved: [],
          refused: [],
          own: {},
          error: 'Stoke could not read Claude Code’s MCP servers.'
        })
    )
    return () => {
      live = false
    }
  }, [])
  const setMcpTick = (id: CodingCliId, name: string, on: boolean): void => {
    patchAgents({ ...agentsRef.current, mcp: withMcpTick(agentsRef.current.mcp, id, name, on) })
  }

  return (
    <div className="agent-page" id="agent-page">
      <AgentPage
        key={current.id}
        cli={current}
        path={detection?.clis.find((s) => s.id === current.id)?.path ?? null}
        installed={installed.has(current.id)}
        conflict={detection?.clis.find((s) => s.id === current.id)?.conflict ?? null}
        checking={detection === null}
        isDefault={startsInstead === current.id}
        shown={c.shown(current.id)}
        onShown={(on) => c.setShown(current.id, on)}
        endpoint={agents.endpoints[current.id] ?? DEFAULT_ENDPOINT}
        onEndpoint={(ep) => setEndpoint(current.id, ep)}
        color={agentSeed(current.id, agents.colors)}
        colorOverridden={agents.colors[current.id] !== undefined}
        onColor={(hex) => c.setColor(current.id, hex)}
        onPreviewColor={props.onPreviewColor ? (hex) => props.onPreviewColor?.(current.id, hex) : undefined}
        tagLabel={agents.tag.labels[current.id] ?? ''}
        onTagLabel={(label) => setTagLabel(current.id, label)}
        openrouterKey={settings.providers.openrouterApiKey}
        installCommand={installSteps([current.id], platform)[0]?.command ?? null}
        onInstall={() => c.install(current.id)}
        accounts={
          <AgentAccounts
            cli={current}
            accounts={accountsOf(current.id, settings.accounts)}
            defaultId={agents.defaultAccount[current.id]}
            onDefault={(id) => {
              const defaultAccount = { ...agentsRef.current.defaultAccount }
              if (id === DEFAULT_ACCOUNT_ID) delete defaultAccount[current.id]
              else defaultAccount[current.id] = id
              patchAgents({ ...agentsRef.current, defaultAccount })
            }}
            onPatchAccount={(id, patch) => {
              const mine = settings.accounts[id]
              if (mine) onPatch({ accounts: { [id]: { ...mine, ...patch } } })
            }}
            onSignIn={onSignIn}
          />
        }
        access={
          !isClaudeCode(current.id) && (
            <AgentAccess
              id={current.id}
              value={agents.access[current.id] ?? 'default'}
              onChange={(mode) => {
                const access = { ...agentsRef.current.access }
                if (mode === 'default') delete access[current.id]
                else access[current.id] = mode
                patchAgents({ ...agentsRef.current, access })
              }}
            />
          )
        }
        tools={
          <AgentTools
            cli={current}
            catalog={catalog}
            ticks={mcpTicksFor(agents.mcp, current.id)}
            extra={agents.mcp.extra}
            onTick={(name, on) => setMcpTick(current.id, name, on)}
          />
        }
        claude={isClaudeCode(current.id) ? <ClaudeParts onGo={onGo} /> : null}
      />
    </div>
  )
}

function AgentAccess({ id, value, onChange }: {
  id: CodingCliId
  value: AgentAccessMode
  onChange: (value: AgentAccessMode) => void
}): React.JSX.Element {
  const options = agentAccessOptions(id)
  const current = options.find((option) => option.id === value) ?? options[0]
  return (
    <div className="agent-brief" data-setting="agent.access">
      <label className="field-label" htmlFor={`agent-access-${id}`}>Default access</label>
      <select className="select" id={`agent-access-${id}`} value={current.id} disabled={options.length === 1}
        onChange={(event) => onChange(event.target.value as AgentAccessMode)}>
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <span className="field-hint">
        {options.length === 1 ? 'Stoke has no verified permission override for this agent. Use its own controls.' : current.hint}
        {' '}Applies on the next launch. OS administrator privileges are separate.
      </span>
    </div>
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
  onPreviewColor,
  tagLabel,
  onTagLabel,
  accounts,
  access,
  tools,
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
  /** Unsaved, while the colour picker moves (App's `applyAppearance` paints it). */
  onPreviewColor?: (hex: string | null) => void
  /** The stored tab tag, '' for the executable's name. */
  tagLabel: string
  onTagLabel: (label: string) => void
  /** Its Tools (MCP) list (`AgentTools`). */
  tools: React.ReactNode
  /** Claude Code's own section, drawn in place of an endpoint. */
  claude: React.ReactNode
  /** Its accounts (`AgentAccounts`), under where it sends requests. */
  accounts: React.ReactNode
  access: React.ReactNode
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

      {accounts}
      {access}
      {tools}

      <AgentLook
        cli={cli}
        color={color}
        colorOverridden={colorOverridden}
        onColor={onColor}
        onPreviewColor={onPreviewColor}
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
      <div className="field" data-setting="agent.endpoint">
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
              <span className="field-hint">
                Uses the OpenRouter key in Agents › Claude Code › Provider &amp; keys, which every agent
                shares.
              </span>
            )}
          </>
        ) : (
          <span className="field-hint">
            Its own sign-in; it has no way to be pointed at another endpoint from outside.
          </span>
        )}
      </div>

      {draft.mode === 'custom' && (
        <div className="field" data-setting="agent.custom-endpoint">
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

      <div className="field" data-setting="agent.model">
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
 * Settings › Agents › Claude Code › Launch defaults: the four defaults every
 * new Claude session starts with. They moved here from Sessions (and then off
 * Claude Code's own page into a page of their own under it), and still write
 * `settings.defaults`, the one value the launcher derives its chips from
 * (gotcha 57).
 */
export function ClaudeLaunchDefaults({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const d = settings.defaults
  return (
    <>
      <div className="field" data-setting="claude-launch.permissions">
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

      <div className="field" data-setting="claude-launch.model">
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

      <div className="field" data-setting="claude-launch.effort">
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
      <label className="check-row" data-setting="claude-launch.ultracode">
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

    </>
  )
}

/*
 * What Claude Code's own page says in place of an endpoint: the three pages
 * under it in the menu, which hold the rest of Claude — the launch defaults,
 * its settings file, and its keys and gateway. Buttons as well as menu rows,
 * because a page that only says "look in the menu" makes the reader hunt.
 */
function ClaudeParts({ onGo }: { onGo: (loc: SettingsLocation) => void }): React.JSX.Element {
  return (
    <div className="field">
      <span className="field-label">The rest of Claude Code</span>
      <span className="field-hint">
        Under Claude Code in the menu: the permissions, model and effort every new session starts
        with; what Claude Code keeps in <span className="mono">~/.claude/settings.json</span>; and its
        API keys, gateway and the OpenRouter key every agent shares.
      </span>
      <div className="agent-actions">
        <button className="btn" onClick={() => onGo({ page: 'claude-launch' })}>
          Launch defaults
        </button>
        <button className="btn" onClick={() => onGo({ page: 'claude-settings' })}>
          Claude Code settings
        </button>
        <button className="btn" onClick={() => onGo({ page: 'providers' })}>
          Provider &amp; keys
        </button>
      </div>
    </div>
  )
}

/** How each agent is handed servers at launch, in the user's terms (`CLI_CAPS[id].mcp`). */
const MCP_ROUTE_HINT = {
  flags: 'as launch flags, every secret by variable name only',
  env: 'in its environment, for that process only',
  file: 'in a file only you can read, written for the launch'
} as const

/*
 * An agent's Tools (MCP): which MCP servers it is handed at launch.
 *
 * The list is Claude Code's own — its user servers, each project's local ones
 * from `~/.claude.json`, and each known folder's `.mcp.json` servers Claude
 * Code may run there — plus any Stoke holds itself, and Stoke's docked-browser
 * server. A name the agent's own config defines is greyed: Stoke never
 * replaces or merges into it. Only the ticks are stored (`agents.mcp.perAgent`,
 * one writer, gotcha 57); the servers are read again at every launch, so a
 * server edited in Claude Code reaches the next session as edited. Only the
 * browser is on until another is ticked: every server's tools cost context on
 * every turn. Greyed where the agent has no launch-time route.
 */
function AgentTools({
  cli,
  catalog,
  ticks,
  extra,
  onTick
}: {
  cli: CodingCli
  catalog: McpCatalog | null
  ticks: readonly string[]
  extra: Record<string, McpServerSpec>
  onTick: (name: string, on: boolean) => void
}): React.JSX.Element {
  const route = capsFor(cli.id).mcp
  const off = route === 'none'
  const claude = isClaudeCode(cli.id)
  const own = new Set(catalog?.own[cli.id] ?? [])
  const on = new Set(ticks)
  const extraNames = Object.keys(extra)
  // What a launch in a folder with every listed server would be handed.
  const listed = new Set([
    STOKE_BROWSER_SERVER,
    ...extraNames,
    ...(claude ? [] : [...(catalog?.user ?? []), ...(catalog?.local ?? []), ...(catalog?.project ?? [])].map((s) => s.name))
  ])
  const where = (folders: string[]): string => (folders.length === 1 ? folders[0] : `${folders.length} folders`)
  const cannot = catalog
    ? [
        ...catalog.refused,
        ...catalog.unapproved.map((u) => ({
          name: u.name,
          reason: `the .mcp.json in ${where(u.folders)} defines it, and Claude Code has not been allowed to run it there — approve it in Claude Code first`
        }))
      ]
    : []
  /*
   * An agent whose only route for a URL is argv (Codex's `-c`) is never handed
   * one that may carry a key (`urlInArgvProblem`): each such row says why.
   */
  const urlProblems = new Map<string, string>()
  if (route === 'flags') {
    for (const s of [...(catalog?.user ?? []), ...(catalog?.local ?? []), ...(catalog?.project ?? [])]) {
      if (s.urlProblem) urlProblems.set(s.name, s.urlProblem)
    }
    for (const name of extraNames) {
      const p = urlInArgvProblem(extra[name])
      if (p) urlProblems.set(name, p)
    }
  }
  const count = off ? 0 : ticks.filter((n) => listed.has(n) && !own.has(n) && !urlProblems.has(n)).length

  const row = (name: string, detail: string, note?: string): React.JSX.Element => {
    const mine = own.has(name)
    const urlProblem = urlProblems.get(name)
    const blocked = mine || urlProblem !== undefined
    return (
      <label className="check-row agent-tool" key={name}>
        <input
          type="checkbox"
          checked={!off && !blocked && on.has(name)}
          disabled={off || blocked}
          aria-label={`Hand ${name} to ${cli.label}`}
          onChange={(e) => onTick(name, e.target.checked)}
        />
        <span>
          <span className="agent-tool-name">
            <span className="mono">{name}</span>
            {detail && <span className="agent-tool-kind">{detail}</span>}
          </span>
          {mine ? (
            <span className="field-hint">
              {cli.label}’s own configuration defines a server with this name, so Stoke leaves it be.
            </span>
          ) : urlProblem ? (
            <span className="field-hint">
              Not handed: {urlProblem}, and {cli.label} takes a URL only as a launch argument, which every
              process on this machine can read. Add it to {cli.label}’s own configuration instead.
            </span>
          ) : (
            note && <span className="field-hint">{note}</span>
          )}
        </span>
      </label>
    )
  }
  const kind = (transport: string, detail: string): string => (detail ? `${transport} · ${detail}` : transport)

  return (
    <div className="field agent-tools" data-testid="agent-tools" data-route={route} data-setting="agent.tools">
      <span className="field-label">
        Tools (MCP)
        {!off && <span className="agent-tool-count">{count} on</span>}
      </span>
      {off ? (
        <span className="field-hint" data-tone="warning">
          Stoke has no confirmed way to hand {cli.label} MCP servers at launch, so it gets none from here.
          Its own configuration still applies.
        </span>
      ) : (
        <FieldHint
          more={
            claude ? (
              <>
                Claude Code reads its own servers from <span className="mono">~/.claude.json</span> and a
                folder’s <span className="mono">.mcp.json</span> as it always has. Stoke adds only its browser
                and servers it holds itself, in a separate file for that launch, and never one named like
                one of yours. SSH tabs are handed nothing.
              </>
            ) : (
              <>
                The list is Claude Code’s own, from <span className="mono">~/.claude.json</span> and a
                folder’s <span className="mono">.mcp.json</span>, read again at every launch — so a server
                changed there reaches the next session as changed, and one a folder turned off stays off.
                A folder’s <span className="mono">.mcp.json</span> server is handed only in that folder.
                Nothing is written to {cli.label}’s own configuration, and a server it already defines —
                in its own settings, or in the folder it starts in — is left to it, never replaced. A server
                Claude Code signs in to with OAuth is handed over as its address alone, and
                {` ${cli.label} `}signs in itself. SSH tabs are handed nothing.
              </>
            )
          }
        >
          Handed to {cli.label} {MCP_ROUTE_HINT[route]}. Each server’s tools cost context on every turn,
          so only Stoke’s browser is on until you tick another.
        </FieldHint>
      )}
      <div className="agent-tool-list">
        {row(STOKE_BROWSER_SERVER, 'Stoke', 'The docked browser: open, read, click and inspect pages.')}
        {claude ? (
          (() => {
            // Every server Claude loads, the ones other agents cannot be handed included.
            const names = catalog
              ? [...catalog.user, ...catalog.local, ...catalog.project, ...catalog.refused].map((s) => s.name)
              : []
            return (
              names.length > 0 && (
                <span className="field-hint">
                  Claude Code loads its own {names.length} server{names.length === 1 ? '' : 's'} itself:{' '}
                  <span className="mono">{names.join(', ')}</span>.
                </span>
              )
            )
          })()
        ) : (
          <>
            {catalog?.user.map((s) => row(s.name, kind(s.transport, s.detail)))}
            {catalog?.local.map((s) =>
              row(s.name, kind(s.transport, s.detail), `Only in ${where(s.folders)}, where Claude Code defines it.`)
            )}
            {catalog?.project.map((s) =>
              row(s.name, kind(s.transport, s.detail), `Only in ${where(s.folders)}, from its .mcp.json.`)
            )}
          </>
        )}
        {extraNames.map((name) => row(name, kind(extra[name].transport, 'held by Stoke')))}
      </div>
      {catalog === null && <span className="field-hint">Reading Claude Code’s servers…</span>}
      {catalog?.error && (
        <span className="field-hint" data-tone="warning">
          {catalog.error}
        </span>
      )}
      {!claude && cannot.length > 0 && (
        <details>
          <summary className="field-hint">
            {cannot.length} of Claude Code’s servers cannot be handed to other agents
          </summary>
          <ul className="field-hint" style={{ margin: 0, paddingLeft: 'var(--space-16)' }}>
            {cannot.map((r) => (
              <li key={r.name}>
                <span className="mono">{r.name}</span> — {r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
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
    <div className="agent-brief" data-setting={agentRowId(cli.id)}>
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

/**
 * The colour picker's presets on an agent's page: every agent's own colour,
 * named for its agent, so "Codex's purple" is one click from any page.
 */
const AGENT_PRESETS = CODING_CLIS.map((c) => ({ name: c.label, hex: AGENT_SEEDS[c.id] }))

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
  onPreviewColor,
  tagLabel,
  onTagLabel
}: {
  cli: CodingCli
  color: string
  colorOverridden: boolean
  onColor: (hex: string | null) => void
  onPreviewColor?: (hex: string | null) => void
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
    <div className="field" data-setting="agent.look">
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
            presets={AGENT_PRESETS}
            defaultValue={AGENT_SEEDS[cli.id]}
            ink={{ kind: 'agent', key: cli.id, tag: draft.trim() || cli.bins.posix[0] }}
            onPreview={onPreviewColor}
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
 * An agent's accounts (shared/accounts.ts): its own sign-in (Default), then
 * every account Stoke holds for it, which one new sessions start on, and how
 * to add another. A login account is made by main — the renderer names an
 * agent and a label, never a folder — and signed in by the agent's own login,
 * in a tab (`onSignIn`). A key account's key is sealed like every other.
 *
 * Labels and keys commit on blur or Enter and are flushed on unmount through
 * a ref (gotcha 63). The whole map is not needed on a commit: main applies a
 * label, swatch or key to the one account named and ignores everything else
 * (`accountsFromRenderer`).
 */
function AgentAccounts({
  cli,
  accounts,
  defaultId,
  onDefault,
  onPatchAccount,
  onSignIn
}: {
  cli: CodingCli
  accounts: AgentAccount[]
  /** The stored default account for this agent, or absent for its own sign-in. */
  defaultId: string | undefined
  onDefault: (id: string) => void
  onPatchAccount: (id: string, patch: { label?: string; apiKey?: string }) => void
  onSignIn: (id: string) => void
}): React.JSX.Element | null {
  const kinds = accountKindsFor(cli.id)
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [message, setMessage] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [emails, setEmails] = useState<Record<string, string | null>>({})
  const [mcp, setMcp] = useState<Record<string, AccountMcpSummary>>({})
  const homes = accounts.map((a) => `${a.id}:${a.home}`).join('|')
  useEffect(() => {
    if (cli.id !== 'claude') return
    let live = true
    void window.stoke.accounts.identify().then((e) => {
      if (live) setEmails(e)
    })
    // What each account is handed of Default's user-scope MCP servers.
    void window.stoke.accounts.mcp().then((m) => {
      if (live) setMcp(m)
    })
    return () => {
      live = false
    }
  }, [cli.id, homes])

  if (kinds.length === 0) {
    return (
      <div className="field" data-testid="agent-accounts" data-setting="agent.accounts">
        <span className="field-label">Accounts</span>
        <span className="field-hint">
          {cli.label} keeps one sign-in for the whole machine and takes no key from Stoke, so it
          runs on its own sign-in only.
        </span>
      </div>
    )
  }

  const current = defaultId && accounts.some((a) => a.id === defaultId) ? defaultId : DEFAULT_ACCOUNT_ID
  // What a blank name becomes: main's rule, the first free `<cli>-<n>` from 2.
  let nextNumber = 2
  while (accounts.some((a) => a.id === `${cli.id}-${nextNumber}`)) nextNumber++
  const add = async (kind: AccountKind): Promise<void> => {
    // Claimed before the await (gotcha 20): a second press would make a second account.
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.stoke.accounts.create({ cli: cli.id, name, kind, apiKey: kind === 'key' ? key : undefined })
      if (!res.ok) {
        setMessage(res.message)
        return
      }
      setName('')
      setKey('')
      if (!res.created) setMessage(`${res.account.label} is already here.`)
      // A login account is signed in at once, in a tab: that is what it is for.
      if (kind === 'login') onSignIn(res.account.id)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="field agent-accounts" data-testid="agent-accounts" data-setting="agent.accounts">
      <span className="field-label">Accounts</span>
      <span className="field-hint">
        {kinds.includes('login')
          ? `Another ${cli.label} sign-in, kept in its own folder under ~/.stoke/accounts and signed in by ${cli.label} itself.`
          : `Another ${cli.label} API key, sealed like every key Stoke holds.`}
        {cli.id === 'claude' &&
          ' Every Claude Code account shares one history, so a conversation started on one resumes on another. Each account\u2019s plan limits are its own: the usage chip follows the account of the tab in front, and its panel lists them all.'}
      </span>
      <div className="agent-account-list" role="radiogroup" aria-label={`Account new ${cli.label} sessions start on`}>
        <label className="agent-account-row">
          <input type="radio" name={`account-${cli.id}`} checked={current === DEFAULT_ACCOUNT_ID} onChange={() => onDefault(DEFAULT_ACCOUNT_ID)} />
          <span className="agent-account-name">Default</span>
          <span className="field-hint">its own sign-in, as {cli.label} is set up on this machine</span>
        </label>
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            cli={cli}
            account={a}
            email={emails[a.id] ?? null}
            mcp={mcp[a.id] ?? null}
            checked={current === a.id}
            onDefault={() => onDefault(a.id)}
            onPatch={(patch) => onPatchAccount(a.id, patch)}
            onSignIn={() => onSignIn(a.id)}
            removing={removing === a.id}
            onRemove={() => {
              if (removing !== a.id) {
                setRemoving(a.id)
                return
              }
              setRemoving(null)
              void window.stoke.accounts.remove(a.id)
            }}
            onKeepIt={() => setRemoving(null)}
          />
        ))}
      </div>
      <div className="agent-account-add">
        <input
          className="input"
          value={name}
          placeholder={`Name, e.g. work (blank: ${cli.label} ${nextNumber})`}
          aria-label={`New ${cli.label} account name`}
          maxLength={ACCOUNT_LABEL_MAX}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && kinds.includes('login')) void add('login')
          }}
        />
        {kinds.includes('login') && (
          <button className="btn" data-testid="add-account" disabled={busy} aria-busy={busy} onClick={() => void add('login')}>
            {busy && <Spinner />}
            Add account
          </button>
        )}
      </div>
      {kinds.includes('key') && (
        <div className="agent-account-add">
          <input
            className="input mono"
            type="password"
            value={key}
            placeholder={`${ACCOUNT_KEY_ENV[cli.id]?.key ?? 'API key'} for a key account`}
            aria-label={`New ${cli.label} account API key`}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="btn" disabled={busy || !key.trim()} onClick={() => void add('key')}>
            Add key account
          </button>
        </div>
      )}
      {message && (
        <span className="field-hint" data-tone="warning">
          {message}
        </span>
      )}
    </div>
  )
}

/** One stored account: its colour, name, where it lives or its key, and what can be done with it. */
function AccountRow({
  cli,
  account,
  email,
  mcp,
  checked,
  onDefault,
  onPatch,
  onSignIn,
  removing,
  onRemove,
  onKeepIt
}: {
  cli: CodingCli
  account: AgentAccount
  email: string | null
  /** A Claude login account: what it gets of Default's user-scope MCP servers. */
  mcp: AccountMcpSummary | null
  checked: boolean
  onDefault: () => void
  onPatch: (patch: { label?: string; apiKey?: string }) => void
  onSignIn: () => void
  removing: boolean
  onRemove: () => void
  onKeepIt: () => void
}): React.JSX.Element {
  const [label, setLabel] = useState(account.label)
  const [key, setKey] = useState(account.apiKey)
  const editing = useRef(false)
  const latest = useRef({ label, key, account, onPatch })
  latest.current = { label, key, account, onPatch }
  useEffect(() => {
    if (!editing.current) {
      setLabel(account.label)
      setKey(account.apiKey)
    }
  }, [account.label, account.apiKey])
  const commit = (): void => {
    editing.current = false
    const { label: l, key: k, account: a, onPatch: set } = latest.current
    const patch: { label?: string; apiKey?: string } = {}
    if (l.trim() && l.trim() !== a.label) patch.label = l.trim()
    if (a.kind === 'key' && k.trim() !== a.apiKey) patch.apiKey = k.trim()
    if (Object.keys(patch).length) set(patch)
  }
  useEffect(() => () => commit(), [])
  const edit = (f: () => void): void => {
    editing.current = true
    f()
  }
  return (
    <div className="agent-account-row agent-account-stored" data-account={account.id}>
      <input type="radio" name={`account-${cli.id}`} checked={checked} onChange={onDefault} aria-label={`Start new ${cli.label} sessions on ${account.label}`} />
      <span className="agent-tab-dot" {...agentMark(account.id)} aria-hidden="true" />
      <div className="agent-account-body">
        <input
          className="input agent-account-label"
          value={label}
          maxLength={ACCOUNT_LABEL_MAX}
          spellCheck={false}
          aria-label={`${account.label} name`}
          onChange={(e) => edit(() => setLabel(e.target.value))}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        {account.kind === 'login' ? (
          <span className="field-hint mono agent-account-home" title={account.home}>
            {email && email !== account.label ? `${email} · ` : ''}
            {account.home}
          </span>
        ) : (
          <input
            className="input mono"
            type="password"
            value={key}
            placeholder={ACCOUNT_KEY_ENV[cli.id]?.key ?? 'API key'}
            aria-label={`${account.label} API key`}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => edit(() => setKey(e.target.value))}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
        )}
      </div>
      <div className="btn-row">
        {account.kind === 'login' && (
          <button className="btn" onClick={onSignIn} title={`Run ${cli.label}'s own sign-in for this account, in a tab`}>
            Sign in
          </button>
        )}
        {removing ? (
          <>
            <button className="btn" data-variant="danger" onClick={onRemove} title="Its folder stays on disk">
              Remove
            </button>
            <button className="btn" data-variant="ghost" onClick={onKeepIt}>
              Keep
            </button>
          </>
        ) : (
          <button className="btn" data-variant="ghost" onClick={onRemove}>
            Remove…
          </button>
        )}
      </div>
      {/* Its own grid row under the name, so the radio and buttons stay level with the name. */}
      {account.kind === 'login' && mcp && accountMcpLines(mcp).length > 0 && (
        <div className="agent-account-mcp">
          {accountMcpLines(mcp).map((line) => (
            <span
              key={line}
              className="field-hint"
              data-testid="account-mcp"
              data-tone={mcp.error || line.startsWith('Not passed') ? 'warning' : undefined}
            >
              {line}
            </span>
          ))}
        </div>
      )}
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
    <div className="field" data-testid="skills-report" data-setting="agents.skills">
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
