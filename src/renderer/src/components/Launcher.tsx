import type { CodingCli, CodingCliId } from '@shared/codingClis'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CliInfo, EffortLevel, PermissionMode, Project, SessionMeta, SshHost } from '@shared/types'
import {
  EFFORT_LABELS,
  MODE_LABELS,
  MODEL_OPTIONS,
  modelLabel,
  sourceText,
  type ClaudeLaunchDefaults,
  type LaunchChoice,
  type LaunchOverride,
  type ResolvedLaunch
} from '@shared/launch'
import {
  isActivationKey,
  launcherKey,
  newestConversation,
  sessionTitle,
  sessionView,
  type FolderChoice,
  type ProjectLike
} from '@shared/launcher'
import { ContextBar } from './ContextMeter'
import { FolderSwitcher } from './FolderSwitcher'
import { IconChevron } from './Icons'
import { compactTokens, relativeTime } from '../lib/format'
import { launcherActivationAllowed, launcherHoldingFocus, onDeliberate } from '../lib/pressBurst'
import { EFFORT_LEVELS, PERMISSION_MODES, ULTRACODE_HINT } from '../lib/permissions'

/** Where the next session runs. */
export interface LaunchTarget {
  path: string
  label: string
  /** The disambiguating parent folder when another project shares the label (QA L14). */
  hint: string
  /** The project behind the folder, when it is one. */
  project: Project | null
  exists: boolean
}

/** How many conversations show before "Show all". */
const ROWS = 8

interface Props {
  /** Null while projects are still loading and nothing is selected. */
  target: LaunchTarget | null
  /** The folder switcher's inputs: profile-scoped projects, the default folder, the hosts. */
  switcher: { projects: readonly ProjectLike[]; defaultCwd: string; hosts: readonly SshHost[] }
  onChoose: (choice: FolderChoice) => void
  onOpenFolder: () => void
  onHide?: (path: string) => void
  /** The target is a project the active profile hides (QA L18). */
  profileNote?: { outside: string; switchTo: { id: string; label: string } | null } | null
  /** Switch the sidebar's profile; null shows every project. */
  onSwitchProfile?: (id: string | null) => void
  /** Every launch value, resolved through this tab, Stoke's defaults and Claude Code's files. */
  launch: ResolvedLaunch
  claude: ClaudeLaunchDefaults
  onLaunchChange: (patch: LaunchOverride) => void
  onMakeDefault: (key: keyof LaunchChoice) => void
  sessions: SessionMeta[]
  sessionsLoading: boolean
  openSessionIds: ReadonlySet<string>
  /** The live context window of an open conversation, when one is known (gotcha 2). */
  liveLimit: (sessionId: string) => number | null
  cli: CliInfo | null
  cliChecking: boolean
  onRetryCli: () => void
  onSetCliPath: () => void
  /** An overlay (splash, picker, palette, settings, dialog) is over the page. */
  overlayOpen: boolean
  /**
   * When the splash or the agent picker last went away (`pressClock()`), or
   * null. Enter and Space press nothing here while they are the tail of a
   * burst that was already going then (gotcha 88), nor until a click or a
   * non-activation key has landed since (gotcha 93).
   */
  armedAt?: number | null
  otherClis: CodingCli[]
  onStartCli: (id: CodingCliId) => void
  onAddAgents?: () => void
  onStart: () => void
  /** Continue this conversation, or — with null, while the list is still loading — the folder's latest. */
  onContinue: (s: SessionMeta | null) => void
  onResume: (s: SessionMeta) => void
}

type Pop = 'switcher' | 'agents' | 'mode' | 'model' | 'effort' | 'ultracode' | null

export function Launcher(props: Props): React.JSX.Element {
  const {
    target,
    switcher,
    launch,
    claude,
    sessions,
    sessionsLoading,
    openSessionIds,
    cli,
    overlayOpen,
    otherClis
  } = props

  const startRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const locateRef = useRef<HTMLButtonElement>(null)
  const switcherRef = useRef<HTMLButtonElement>(null)
  const caretRef = useRef<HTMLButtonElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const [pop, setPop] = useState<Pop>(null)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [showEmpty, setShowEmpty] = useState(false)
  const [primaryFocused, setPrimaryFocused] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  /*
   * Gotcha 92: after the first-run splash or agent picker, focus waits on the
   * card rather than on Start until something deliberate happens — a click, or
   * any key but Enter/Space. Enters tapped to get through the intro screens,
   * however slowly, then land on no button at all.
   */
  const armedAt = props.armedAt ?? null
  const [holding, setHolding] = useState(() => launcherHoldingFocus(armedAt))
  useEffect(() => {
    setHolding(launcherHoldingFocus(armedAt))
    if (!launcherHoldingFocus(armedAt)) return
    return onDeliberate(() => setHolding(false))
  }, [armedAt])
  const holdingRef = useRef(holding)
  holdingRef.current = holding

  const cliBroken = !!cli && !cli.ok
  const missing = !!target && !target.exists
  const canStart = !!target && !cliBroken && !missing
  const bypass = launch.permissionMode.choice === 'bypassPermissions'

  // A new target starts with a clean list.
  useEffect(() => {
    setQuery('')
    setShowAll(false)
    setShowEmpty(false)
  }, [target?.path])

  /*
   * Focus the one control Enter should press, so the app is one keystroke from
   * a live session — and NOT while an overlay is up (QA L1): the welcome splash
   * used to sit over a focused "Start here", and an Enter meant for the splash
   * started `claude` in the default folder behind it. `overlayOpen` is in the
   * deps so focus comes back when the overlay closes instead of falling to
   * <body> (QA L7). A missing folder focuses Locate…, a broken CLI Retry.
   */
  const focusPrimary = (): void => {
    const el = missing ? locateRef.current : cliBroken ? retryRef.current : startRef.current
    el?.focus()
  }
  /*
   * `holding` is read through its ref and is deliberately NOT a dependency: it
   * flips false on the very keydown (Tab, say) whose own default then moves
   * focus, and refocusing Start in that render would fight it.
   */
  useEffect(() => {
    if (overlayOpen || pop) return
    if (holdingRef.current && launcherHoldingFocus(armedAt)) cardRef.current?.focus()
    else focusPrimary()
  }, [target?.path, overlayOpen, missing, cliBroken, !!target, armedAt])

  const view = useMemo(
    () => sessionView(sessions, { query, showEmpty, all: showAll, limit: ROWS }),
    [sessions, query, showEmpty, showAll]
  )
  const newest = newestConversation(sessions)

  const rows = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('.launcher-conv') ?? [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    /*
     * The Enters that got someone past the splash and the agent picker must not
     * press Start as well (review of QA L1): measured, a burst of fresh Enters
     * answered the picker and the next one started `claude` in the user's most
     * recent real project. `activationAllowed` holds the burst; this card's
     * handler runs before the focused button's own Enter/Space default.
     */
    if (isActivationKey(e.key) && !launcherActivationAllowed(armedAt)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const el = e.target as HTMLElement
    const inField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
    const action = launcherKey(e, { inField, hasQuery: query.trim() !== '' })
    if (!action) return
    switch (action.type) {
      case 'swallow':
        e.preventDefault()
        e.stopPropagation()
        return
      case 'continue':
        e.preventDefault()
        if (canStart && (newest || sessionsLoading)) props.onContinue(newest)
        return
      case 'agents':
        e.preventDefault()
        if (otherClis.length || props.onAddAgents) setPop('agents')
        return
      case 'switcher':
        e.preventDefault()
        setPop('switcher')
        return
      case 'openFolder':
        e.preventDefault()
        props.onOpenFolder()
        return
      case 'resume': {
        const s = view.shown[action.index]
        if (!s || !canStart) return
        e.preventDefault()
        props.onResume(s)
        return
      }
      case 'filter':
        if (!target || sessions.length === 0) return
        e.preventDefault()
        setQuery((q) => q + action.char)
        filterRef.current?.focus()
        return
      case 'escape':
        if (query) {
          e.preventDefault()
          setQuery('')
        } else if (el === filterRef.current) {
          e.preventDefault()
          focusPrimary()
        }
        return
      case 'move': {
        const list = rows()
        const at = list.indexOf(el)
        if (el === startRef.current || el === filterRef.current) {
          if (action.delta === 1 && list[0]) {
            e.preventDefault()
            list[0].focus()
          }
        } else if (at >= 0) {
          e.preventDefault()
          const next = at + action.delta
          if (next < 0) focusPrimary()
          else list[Math.min(next, list.length - 1)]?.focus()
        }
        return
      }
    }
  }

  const agentMenu = otherClis.length > 0 || !!props.onAddAgents
  /*
   * A chip pick applies to this launch and closes the popover, with focus on
   * Start: a one-off model is chip, pick, Enter. Left open, Enter pressed the
   * focused option again instead of starting. "Make default" is in the same
   * popover when it is reopened, and the chip's dot says a value is changed.
   */
  const picked = (patch: LaunchOverride): void => {
    props.onLaunchChange(patch)
    setPop(null)
    requestAnimationFrame(focusPrimary)
  }


  return (
    <div className="launcher">
      <div className="launcher-card" ref={cardRef} tabIndex={-1} onKeyDown={onKeyDown}>
        {/* Row A: where it runs. */}
        <div className="launcher-head">
          <FolderSwitcher
            label={target?.label ?? ''}
            hint={target?.hint ?? ''}
            path={target?.path ?? ''}
            loading={!target}
            projects={switcher.projects}
            defaultCwd={switcher.defaultCwd}
            hosts={switcher.hosts}
            open={pop === 'switcher'}
            onOpenChange={(v) => setPop(v ? 'switcher' : null)}
            onChoose={(c) => {
              props.onChoose(c)
              // A pick that leaves the target where it was would otherwise leave
              // focus on nothing; one that moves it is refocused by the effect.
              requestAnimationFrame(focusPrimary)
            }}
            triggerRef={switcherRef}
            scratchBlocked={cliBroken}
          />
          <span className="launcher-path mono">{target?.path ?? ' '}</span>
          {props.profileNote && (
            <div className="launcher-note" role="status">
              <span>Not in {props.profileNote.outside}.</span>
              {props.profileNote.switchTo ? (
                <button
                  className="btn"
                  data-variant="ghost"
                  onClick={() => props.onSwitchProfile?.(props.profileNote!.switchTo!.id)}
                >
                  Switch to {props.profileNote.switchTo.label}
                </button>
              ) : (
                <button className="btn" data-variant="ghost" onClick={() => props.onSwitchProfile?.(null)}>
                  Show all projects
                </button>
              )}
            </div>
          )}
          {missing && (
            <div className="launcher-missing" role="status">
              <span className="pill" data-tone="danger">
                This folder no longer exists
              </span>
              <button ref={locateRef} className="btn" onClick={props.onOpenFolder}>
                Locate…
              </button>
              {props.onHide && target?.project && (
                <button
                  className="btn"
                  data-variant="ghost"
                  onClick={() => props.onHide?.(target.path)}
                  title="Stop listing it. Nothing on disk is touched."
                >
                  Hide from list
                </button>
              )}
            </div>
          )}
        </div>

        {cliBroken && (
          <div className="launcher-alert" role="alert">
            <div className="launcher-alert-text">
              <b>Claude Code isn&rsquo;t runnable</b>
              <span>{cli?.error}</span>
            </div>
            <div className="btn-row">
              <button ref={retryRef} className="btn" onClick={props.onRetryCli} disabled={props.cliChecking}>
                {props.cliChecking ? 'Checking…' : 'Retry'}
              </button>
              <button className="btn" data-variant="ghost" onClick={props.onSetCliPath}>
                Set path…
              </button>
            </div>
          </div>
        )}

        {/* Row B: the primary actions, directly under the target. */}
        <div className="launcher-actions">
          <div className="split" data-disabled={!canStart || undefined}>
            <button
              ref={startRef}
              className="btn split-main"
              data-variant="primary"
              onClick={props.onStart}
              disabled={!canStart}
              onFocus={() => setPrimaryFocused(true)}
              onBlur={() => setPrimaryFocused(false)}
            >
              Start Claude Code
            </button>
            {agentMenu && (
              <div className="split-caret-wrap">
                <button
                  ref={caretRef}
                  className="btn split-caret"
                  data-variant="primary"
                  aria-haspopup="menu"
                  aria-expanded={pop === 'agents'}
                  onClick={() => setPop(pop === 'agents' ? null : 'agents')}
                  disabled={!target || missing}
                  title="Start another agent here (Alt+Enter)"
                >
                  <IconChevron className="caret-down" />
                  <span className="sr-only">Other agents</span>
                </button>
                {pop === 'agents' && (
                  <Menu
                    label="Start another agent"
                    onClose={(refocus) => {
                      setPop(null)
                      if (refocus) caretRef.current?.focus()
                    }}
                    items={[
                      ...otherClis.map((c) => ({
                        key: c.id,
                        label: c.label,
                        side: c.vendor,
                        onPick: () => props.onStartCli(c.id)
                      })),
                      ...(props.onAddAgents
                        ? [{ key: 'add', label: 'Add agents…', side: '', onPick: props.onAddAgents }]
                        : [])
                    ]}
                    note="The context ring and the worklog read Claude Code's files only. Some agents show their own update screen on first run."
                  />
                )}
              </div>
            )}
          </div>

          {sessionsLoading && sessions.length === 0 ? (
            <span className="btn launcher-continue skeleton-btn" aria-hidden="true" />
          ) : (
            newest && (
              <button
                className="btn launcher-continue"
                onClick={() => props.onContinue(newest)}
                disabled={!canStart}
                title={`Continue this conversation (${window.stoke.platform === 'darwin' ? '⌘' : 'Ctrl+'}Enter)${
                  openSessionIds.has(newest.id) ? ' — it is already open, so its tab is brought forward' : ''
                }`}
              >
                <span className="truncate">Continue &ldquo;{sessionTitle(newest)}&rdquo;</span>
                <span className="launcher-continue-age">{relativeTime(newest.modified)}</span>
              </button>
            )
          )}

          {canStart && primaryFocused && !holding && (
            <span className="launcher-hint" aria-hidden="true">
              <span className="kbd">Enter</span> to start
            </span>
          )}
          {canStart && holding && (
            <span className="launcher-hint" data-held="">
              Click Start, or <span className="kbd">Tab</span> to it, to begin
            </span>
          )}
        </div>

        {/* Row C: launch chips, resolved, for THIS launch (QA L10, L11). */}
        <div className="launcher-chips" role="group" aria-label="Launch options">
          <Chip
            open={pop === 'mode'}
            onOpen={(v) => setPop(v ? 'mode' : null)}
            label={launch.permissionMode.label}
            danger={bypass}
            changed={launch.permissionMode.changed}
            title={`Permission mode — ${sourceText(launch.permissionMode.source, claude.from.permissionMode)}`}
          >
            <Options
              name="Permission mode"
              value={launch.permissionMode.choice}
              options={PERMISSION_MODES.map((m) => ({
                id: m.id,
                label:
                  m.id === 'default'
                    ? `Claude Code default · ${claude.permissionMode ? MODE_LABELS[claude.permissionMode] : 'Ask'}`
                    : m.label,
                hint: m.hint,
                danger: m.danger
              }))}
              onPick={(id) => picked({ permissionMode: id as PermissionMode })}
            />
            <ChipFoot
              source={sourceText(launch.permissionMode.source, claude.from.permissionMode)}
              changed={launch.permissionMode.changed}
              onMakeDefault={() => props.onMakeDefault('permissionMode')}
            />
          </Chip>

          <Chip
            open={pop === 'model'}
            onOpen={(v) => setPop(v ? 'model' : null)}
            label={launch.model.label}
            changed={launch.model.changed}
            title={`Model — ${sourceText(launch.model.source, claude.from.model)}`}
          >
            <Options
              name="Model"
              value={launch.model.choice}
              options={MODEL_OPTIONS.map((m) => ({
                id: m.id,
                label: m.id === '' ? `Claude Code default · ${claude.model ? modelLabel(claude.model) : 'its own'}` : m.label
              }))}
              onPick={(id) => picked({ model: id })}
            />
            <ChipFoot
              source={sourceText(launch.model.source, claude.from.model)}
              changed={launch.model.changed}
              onMakeDefault={() => props.onMakeDefault('model')}
            />
          </Chip>

          <Chip
            open={pop === 'effort'}
            onOpen={(v) => setPop(v ? 'effort' : null)}
            label={launch.effort.label}
            changed={launch.effort.changed}
            title={`Effort — ${
              launch.ultracode.choice
                ? 'Ultracode runs at Extra high'
                : sourceText(launch.effort.source, launch.effort.settingsFrom)
            }`}
          >
            <Options
              name="Effort"
              value={launch.effort.choice}
              disabled={launch.ultracode.choice}
              options={EFFORT_LEVELS.map((e) => ({
                id: e.id,
                label:
                  e.id === 'default'
                    ? `Claude Code default · ${launch.effort.settingsValue ? EFFORT_LABELS[launch.effort.settingsValue] : 'its own'}`
                    : e.label
              }))}
              onPick={(id) => picked({ effort: id as EffortLevel })}
            />
            {launch.ultracode.choice && (
              <p className="popover-text">Ultracode runs this session at Extra high; the pick comes back when it is off.</p>
            )}
            <ChipFoot
              source={sourceText(launch.effort.source, launch.effort.settingsFrom)}
              changed={launch.effort.changed}
              onMakeDefault={() => props.onMakeDefault('effort')}
            />
          </Chip>

          <Chip
            open={pop === 'ultracode'}
            onOpen={(v) => setPop(v ? 'ultracode' : null)}
            label={launch.ultracode.choice ? 'Ultracode on' : 'Ultracode off'}
            pressed={launch.ultracode.choice}
            changed={launch.ultracode.changed}
            title={ULTRACODE_HINT}
          >
            <Options
              name="Ultracode"
              value={launch.ultracode.choice ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On — Extra high effort plus workflows' }
              ]}
              onPick={(id) => picked({ ultracode: id === 'on' })}
            />
            <p className="popover-text">{ULTRACODE_HINT}</p>
            <ChipFoot
              source={launch.ultracode.source === 'launch' ? 'Changed for this launch only' : "Stoke's default"}
              changed={launch.ultracode.changed}
              onMakeDefault={() => props.onMakeDefault('ultracode')}
            />
          </Chip>
        </div>

        {/* Inline rather than a dialog: visible for as long as it is armed. */}
        {bypass && (
          <div className="launcher-alert" data-tone="danger">
            <div className="launcher-alert-text">
              <b>Permissions are bypassed.</b>
              <span>Claude will run commands and edit files without asking. Use it only where you trust the contents.</span>
            </div>
          </div>
        )}

        {/* Row D: conversations. */}
        {target && (
          <section className="launcher-convs" aria-label="Conversations">
            <div className="launcher-convs-head">
              <span className="sidebar-group">
                Conversations
                {!sessionsLoading && sessions.length > 0 && <span className="launcher-count"> {view.matched}</span>}
              </span>
              {sessions.length > 0 && (
                <input
                  ref={filterRef}
                  className="input launcher-filter"
                  placeholder="Type to filter"
                  aria-label="Filter conversations"
                  spellCheck={false}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
            </div>

            <div className="launcher-conv-list" ref={listRef}>
              {sessionsLoading && sessions.length === 0 ? (
                Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="launcher-conv skeleton-row" aria-hidden="true">
                    <span className="skeleton" style={{ width: `${60 - i * 12}%` }} />
                    <span className="skeleton skeleton-meta" />
                  </div>
                ))
              ) : sessions.length === 0 ? (
                <p className="launcher-empty">
                  No conversations here yet — <b>Start</b> makes the first one.
                </p>
              ) : view.shown.length === 0 ? (
                <p className="launcher-empty">
                  {query ? <>Nothing matches &ldquo;{query}&rdquo;.</> : 'Only empty conversations here.'}
                </p>
              ) : (
                view.shown.map((s, i) => {
                  const open = openSessionIds.has(s.id)
                  const limit = props.liveLimit(s.id)
                  return (
                    <button
                      key={s.id}
                      className="session launcher-conv"
                      aria-current={open ? 'true' : undefined}
                      onClick={() => props.onResume(s)}
                      disabled={cliBroken || missing}
                      title={`${s.firstPrompt ?? s.id}${open ? '\nOpen in a tab — this brings it forward' : ''}`}
                    >
                      <span className="launcher-conv-top">
                        {i < 9 && (
                          <span className="launcher-conv-key" aria-hidden="true">
                            {i + 1}
                          </span>
                        )}
                        <span className="session-title">{sessionTitle(s)}</span>
                        {open && (
                          <span className="pill" data-tone="accent">
                            Open
                          </span>
                        )}
                      </span>
                      <span className="session-meta">
                        <span>{relativeTime(s.modified)}</span>
                        <span>{s.messageCount} msgs</span>
                        {s.gitBranch && s.gitBranch !== 'HEAD' && <span className="truncate">{s.gitBranch}</span>}
                        {s.contextTokens > 0 &&
                          (limit ? (
                            <ContextBar used={s.contextTokens} limit={limit} />
                          ) : (
                            <span className="mono" title="The context window is known only once the conversation is open">
                              {compactTokens(s.contextTokens)} tokens
                            </span>
                          ))}
                      </span>
                    </button>
                  )
                })
              )}
            </div>

            {(view.more > 0 || showAll || view.empty > 0) && (
              <div className="launcher-convs-foot">
                {(view.more > 0 || showAll) && (
                  <button className="session-more" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show fewer' : `Show all ${view.matched}`}
                  </button>
                )}
                {view.empty > 0 && !query && (
                  <button className="session-more" onClick={() => setShowEmpty((v) => !v)}>
                    {showEmpty ? 'Hide empty' : `Show empty (${view.empty})`}
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ small parts */

/**
 * One launch chip: the resolved value, a dot when this launch differs from the
 * default, and a popover. Keys inside the popover stop there, so the card's
 * type-to-filter and digit keys never see them.
 */
function Chip({
  open,
  onOpen,
  label,
  title,
  changed,
  danger,
  pressed,
  children
}: {
  open: boolean
  onOpen: (open: boolean) => void
  label: string
  title: string
  changed: boolean
  danger?: boolean
  pressed?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const first =
      popRef.current?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ??
      popRef.current?.querySelector<HTMLElement>('button:not(:disabled)')
    first?.focus()
  }, [open])
  const close = (refocus: boolean): void => {
    onOpen(false)
    if (refocus) ref.current?.focus()
  }
  return (
    <div className="chip-wrap">
      <button
        ref={ref}
        className="chip"
        data-danger={danger || undefined}
        data-on={pressed || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
        title={title}
      >
        <span>{label}</span>
        {changed && (
          <span className="chip-dot" title="Changed for this launch">
            <span className="sr-only">(changed for this launch)</span>
          </span>
        )}
        <IconChevron className="caret-down" />
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={() => close(false)} />
          <div
            ref={popRef}
            className="popover chip-pop"
            role="dialog"
            aria-label={title}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                close(true)
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const all = Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)') ?? [])
                const at = all.indexOf(document.activeElement as HTMLElement)
                const next = all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]
                next?.focus()
              }
            }}
          >
            {children}
          </div>
        </>
      )}
    </div>
  )
}

function Options({
  name,
  value,
  options,
  onPick,
  disabled
}: {
  name: string
  value: string
  options: { id: string; label: string; hint?: string; danger?: boolean }[]
  onPick: (id: string) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="chip-options" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <button
          key={o.id || 'default'}
          role="radio"
          aria-checked={o.id === value}
          className="chip-option"
          data-danger={o.danger || undefined}
          disabled={disabled}
          onClick={() => onPick(o.id)}
          title={o.hint}
        >
          <span className="chip-check" aria-hidden="true" />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

function ChipFoot({
  source,
  changed,
  onMakeDefault
}: {
  source: string
  changed: boolean
  onMakeDefault: () => void
}): React.JSX.Element {
  return (
    <>
      <p className="popover-text">{source}</p>
      <div className="popover-actions">
        <button
          className="btn"
          disabled={!changed}
          onClick={onMakeDefault}
          title="Use this for every new session, not only this one"
        >
          Make default
        </button>
      </div>
    </>
  )
}

function Menu({
  label,
  items,
  note,
  onClose
}: {
  label: string
  items: { key: string; label: string; side: string; onPick: () => void }[]
  note?: string
  onClose: (refocus: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])
  return (
    <>
      <div className="popover-backdrop" onClick={() => onClose(false)} />
      <div
        ref={ref}
        className="popover agent-menu"
        role="menu"
        aria-label={label}
        onKeyDown={(e) => {
          e.stopPropagation()
          const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
          const at = all.indexOf(document.activeElement as HTMLElement)
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose(true)
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
          } else if (e.key === 'Enter' && e.repeat) {
            e.preventDefault()
          }
        }}
      >
        {items.map((it) => (
          <button
            key={it.key}
            role="menuitem"
            className="context-menu-item"
            onClick={() => {
              onClose(false)
              it.onPick()
            }}
          >
            <span>{it.label}</span>
            {it.side && <span className="context-menu-key">{it.side}</span>}
          </button>
        ))}
        {note && <p className="context-menu-hint">{note}</p>}
      </div>
    </>
  )
}
