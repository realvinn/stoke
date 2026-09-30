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
  AGENT_TAG_MAX,
  cleanTagLabel,
  DEFAULT_ENDPOINT,
  endpointProblem,
  installedAgents,
  installSteps,
  resolveDefaultAgent,
  visibleAgents,
  type AgentEndpoint,
  type AgentSettings,
  type EndpointMode
} from '@shared/agents'
import type { Settings } from '@shared/types'
import { CLAUDE_SHARED_PLUGIN, SHARED_SKILLS_DIR, skillReport, type SkillDirScan } from '@shared/skills'
import { cliFor } from '@shared/codingClis'
import { AGENT_SEEDS, agentSeed } from '@shared/agentColors'
import { Spinner } from './Spinner'
import { ColorField } from './ColorField'

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
  claudeRunnable,
  onRefresh,
  onOpenPicker,
  onInstall
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
}): React.JSX.Element {
  const agents = settings.agents
  const platform = window.stoke.platform
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  /*
   * "Look again" re-reads the login shell (gotcha 52), which takes seconds, and
   * a re-check keeps the last detection on screen — so the rows' "checking…"
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

  /*
   * The default agent: what the launcher can offer (installed AND chosen), with
   * Claude Code counted when its own probe answered, and the stored value kept
   * in the list even when it is no longer on offer so the select never shows a
   * value it does not have — with a line saying what new sessions start instead.
   */
  const offered = visibleAgents(agents.chosen, installedAgents(detection?.clis ?? [], claudeRunnable))
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
              {offered.includes(id) ? '' : ' — not installed, or not ticked below'}
            </option>
          ))}
        </select>
        {startsInstead !== agents.defaultCli && (
          <span className="field-hint" data-tone="warning">
            {cliFor(agents.defaultCli).label} is not installed, or not ticked below, so new sessions
            start {cliFor(startsInstead).label} until it is both.
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
          <span className="field-hint">
            A tab running an agent other than the default says which, in a small tag named below.
            Off, the tab keeps a rule in the agent&rsquo;s colour and its tooltip still names it.
            Colours show once more than one agent is in use.
          </span>
        </span>
      </label>

      <div className="field">
        <span className="field-label">Coding agents</span>
        <span className="field-hint">
          Each agent runs in its own terminal tab. The launcher offers the ones ticked here. Claude
          Code gets the whole of Stoke around it; the others get the terminal, their own sign-in or
          an endpoint below, and Stoke’s browser tools where they accept an MCP server at launch
          (Codex, OpenCode, Kilo, Copilot, Qwen).
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
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

      <SkillsReport
        agents={CODING_CLIS.map((c) => c.id).filter((id) => shown(id) && installed.has(id))}
        share={agents.shareSkillsToClaude}
        onShare={(on) => patchAgents({ ...agentsRef.current, shareSkillsToClaude: on })}
      />

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
            color={agentSeed(c.id, agents.colors)}
            colorOverridden={agents.colors[c.id] !== undefined}
            onColor={(hex) => setColor(c.id, hex)}
            tagLabel={agents.tag.labels[c.id] ?? ''}
            onTagLabel={(label) => setTagLabel(c.id, label)}
            openrouterKey={settings.providers.openrouterApiKey}
            installCommand={installSteps([c.id], platform)[0]?.command ?? null}
            onInstall={() => {
              // Installing an agent is choosing it: without this the launcher,
              // which shows only chosen agents, would not offer what was just
              // installed — while the exit card said it did.
              if (!shown(c.id)) setShown(c.id, true)
              onInstall([c.id])
            }}
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
  onInstall,
  color,
  colorOverridden,
  onColor,
  tagLabel,
  onTagLabel
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
  /** The colour it is drawn in: the user's, else its seed. */
  color: string
  colorOverridden: boolean
  /** Null resets to the seed. */
  onColor: (hex: string | null) => void
  /** The stored tab tag, '' for the executable's name. */
  tagLabel: string
  onTagLabel: (label: string) => void
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

      {(path || shown) && (
        <AgentLook
          cli={cli}
          color={color}
          colorOverridden={colorOverridden}
          onColor={onColor}
          tagLabel={tagLabel}
          onTagLabel={onTagLabel}
        />
      )}

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

/*
 * How an agent looks in the strip: its colour and its tab tag. Only for an
 * agent that is installed or ticked — the rest cannot have a tab to colour.
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
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-8)' }}>
        <input type="checkbox" checked={share} onChange={(e) => onShare(e.target.checked)} />
        Lend Claude Code the shared skills
      </label>
      <span className="field-hint">
        Each local Claude Code session also gets the skills in{' '}
        <span className="mono">{SHARED_SKILLS_DIR}</span> it would not otherwise see, as a plugin
        for that session only: linked, not copied, and nothing is written into{' '}
        <span className="mono">~/.claude</span>. Claude names them{' '}
        <span className="mono">{CLAUDE_SHARED_PLUGIN}:</span>
        <em>skill</em>, so a shared <span className="mono">pdf</span> is{' '}
        <span className="mono">/{CLAUDE_SHARED_PLUGIN}:pdf</span>. A project’s{' '}
        <span className="mono">skillOverrides</span> still apply. SSH tabs are not lent anything.
      </span>
      {report && share && (
        <span className="field-hint">
          {report.projected.length === 0
            ? 'Claude Code already sees every shared skill.'
            : `${report.projected.length} shared skill${report.projected.length === 1 ? '' : 's'} reach Claude Code this way: ${report.projected.join(', ')}.`}
        </span>
      )}
      <span className="field-hint" data-tone="warning">
        <span className="mono">claude import</span> does the opposite: it copies the shared folder
        into <span className="mono">~/.claude/skills</span>, and those copies drift from the originals
        on the next edit.
      </span>
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
