import { capsFor, cliFor, DEFAULT_CLI, isClaudeCode } from '@shared/codingClis'
import type { CodingCliDetection, CodingCliId } from '@shared/codingClis'
import { visibleAgents } from '@shared/agents'
import { AgentPicker } from './components/AgentPicker'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrowserState,
  CliInfo,
  ContextSnapshot,
  EffortLevel,
  LiveSessionState,
  PermissionMode,
  Project,
  SessionEvent,
  SessionIndexEntry,
  SessionMeta,
  Settings,
  SshHost,
  Theme,
  WorklogProposal,
  WorklogWatchState
} from '@shared/types'
import type { UpdateInfo } from '@shared/api'
import { foldGroup, profileFor, resolveProfiles, visibleProfiles } from '@shared/profiles'
import { pathKey, pathRulesFor } from '@shared/paths'
import type { StokeCliRequest } from '@shared/stokeArgs'
import { activeThemeId, resolveTheme } from '@shared/themes'
import { worklogButtonState } from '@shared/worklog'
import { BrowserPanel } from './components/BrowserPanel'
import { BusyDialog } from './components/BusyDialog'
import { CommandPalette } from './components/CommandPalette'
import { IconClose } from './components/Icons'
import { Launcher } from './components/Launcher'
import { PausedSession } from './components/PausedSession'
import { Resizer } from './components/Resizer'
import { SettingsSheet, type SectionId } from './components/SettingsSheet'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TerminalView } from './components/TerminalView'
import { TitleBar } from './components/TitleBar'
import { ActivityPanel } from './components/ActivityPanel'
import { WorklogPrompt } from './components/WorklogPrompt'
import { baseName, ipcErrorMessage } from './lib/format'
import {
  attachExit,
  clearTyped,
  forgetPty,
  initPtyBus,
  noteInput,
  typedSinceSubmit
} from './lib/ptyBus'
import { TERMINAL_DEFAULTS, zoomStep } from '@shared/ui'
import { welcomePlan, type WelcomeReason } from '@shared/welcome'
import { matchShortcut, typeThroughKey } from './lib/shortcuts'
import { newTab } from './lib/newTab'
import { profileIdForCwd } from './lib/projectProfile'
import { fromStored, screensFrom, toStored } from './lib/restore'
import { focusTerm, screenOf } from './lib/termRegistry'
import {
  autoRelaunchKey,
  autoRelaunchStep,
  busyTabIds,
  cycleTab,
  focusAfterStart,
  moveKey,
  moveTab,
  neighbourOf,
  paneOrder,
  pendingRelaunchStep,
  rebindTabs,
  relaunchPlan,
  replaceOrAppend,
  restartPlan,
  type PendingOrigin,
  type RelaunchPlan
} from './lib/tabs'
import { applyAppearance, applyTypography, applyWallpaper } from './lib/theme'
import type { SessionActivity, Tab } from './types'

/*
 * The first-run campfire, as a chunk of its own.
 *
 * `lazy()` here does NOT start the import — React calls the factory the first
 * time the element is rendered, which is only ever on the launch after an
 * install or an upgrade. Static-importing it instead would put its module and
 * its SVG into the one renderer bundle, where every launch pays to parse and
 * evaluate it in order to render null. That is gotcha 40's finding (a static
 * import of something most launches never use is simply boot cost) applied one
 * process over; measured in the built bundle, the split is ~4 KB of JS that a
 * repeat launch never fetches.
 *
 * The `.then` mapping is only because `lazy` wants a default export and this
 * repo exports components by name.
 *
 * The `.catch` is the part that is not decoration. `lazy` rethrows a rejected
 * factory during render, and this tree has NO error boundary anywhere — main.tsx
 * renders `<App/>` straight into `createRoot` — so a chunk that cannot be
 * fetched or evaluated does not lose the splash, it unmounts the whole window
 * and leaves a blank one. That would land on the single launch after an install
 * or an upgrade, which is the worst launch available to break, and the failure
 * needs no exotic disk: a future edit to Campfire.tsx that throws at module
 * scope on some machine has exactly this shape. Falling back to a component
 * that dismisses itself keeps the app up AND records the version, so it does
 * not merely fail silently once — it fails silently once and then stops asking.
 */
type CampfireModule = typeof import('./components/Campfire')

const Campfire = lazy(() =>
  import('./components/Campfire')
    .then((m) => ({ default: m.Campfire }))
    .catch(() => ({ default: SkipCampfire }))
)

/** The campfire when its chunk will not load: no splash, and mark it as seen. */
const SkipCampfire: CampfireModule['Campfire'] = ({ onDismiss }) => {
  useEffect(() => onDismiss(), [onDismiss])
  return <></>
}

/** What the splash needs to draw itself, and what to record once it is gone. */
interface WelcomeScreen {
  reason: WelcomeReason
  version: string
  record: string | null
}

/** A relaunch the plan has cleared to happen. */
type RelaunchOffer = Extract<RelaunchPlan, { kind: 'offer' }>

/**
 * The "a prompt is running" question, and what it is about: one tab's relaunch
 * onto a newer CLI, Stoke restarting to install its own update, or closing a
 * tab whose session is mid-turn (gotcha 90).
 */
type BusyPrompt =
  | { kind: 'relaunch'; tabId: string }
  | { kind: 'restart'; tabIds: string[] }
  | { kind: 'close'; tabId: string }

/**
 * How long a relaunch waits for the old `claude` to exit before starting the
 * new one anyway. It takes ~0.8-0.95s after SIGHUP (measured); the cap is for a
 * process that will not die, and gotcha 73's file ownership covers that case.
 */
const RELAUNCH_EXIT_CAP_MS = 3000

const EMPTY_BROWSER: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  tabs: [],
  activeId: null,
  zoom: 0,
  findTotal: 0,
  findActive: 0,
  bookmarked: false
}

export function App(): React.JSX.Element {
  const platform = window.stoke.platform
  const isMac = platform === 'darwin'

  const [settings, setSettings] = useState<Settings | null>(null)
  const [cli, setCli] = useState<CliInfo | null>(null)
  /** The first-run campfire, or null on every launch that is not one. */
  const [welcome, setWelcome] = useState<WelcomeScreen | null>(null)

  /*
   * Which coding agents are on this machine, and whether the PATH could be read
   * (gotcha 52). One copy for the launcher row, the picker and Settings, read
   * on mount and again after an install tab exits — `fresh` re-reads the login
   * shell, since the installer has just added its bin directory to the rc.
   * `null` is "still looking", which the picker shows as such.
   */
  const [agentDetection, setAgentDetection] = useState<CodingCliDetection | null>(null)
  const refreshAgents = useCallback((fresh = false): void => {
    void window.stoke.cli
      .detect({ fresh })
      .then(setAgentDetection)
      .catch(() => {
        /* Detection is a convenience; a failure leaves the last answer standing. */
      })
  }, [])
  /** The agent picker: opened by hand, or once on a launch that has never answered it. */
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)

  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  /** Resolved folder for sessions started without picking a project. */
  const [defaultCwd, setDefaultCwd] = useState('')
  const [query, setQuery] = useState('')
  /*
   * What the sidebar highlights. One list, one highlight — but a New Project
   * tab also keeps its own copy, so two of them aimed at different projects
   * each come back to their own when selected. The sidebar's copy is written
   * alongside the tab's so switching from a New tab to a session tab does not
   * blank the list.
   */
  const [browsePath, setBrowsePath] = useState<string | null>(null)
  const [browseExpanded, setBrowseExpanded] = useState<string | null>(null)
  /*
   * One cache for every project's session list, keyed by path.
   *
   * Deliberately not per-tab: two New Project tabs pointed at the same project
   * would hold two copies of the same fetched list, and the moment one of them
   * refetched they would disagree about the same folder. A cache keyed by the
   * folder cannot do that.
   */
  const [sessionsByPath, setSessionsByPath] = useState<Record<string, SessionMeta[]>>({})
  /** The path currently being fetched, or null. Drives the loading state. */
  const [sessionsLoadingPath, setSessionsLoadingPath] = useState<string | null>(null)

  /*
   * Every session's title and first prompt, across every project, for the
   * sidebar's search — a separate thing from `sessionsByPath`, which holds only
   * the projects clicked this run, and so could never answer "which of all my
   * conversations mentions this".
   *
   * Null until the first search asks for it: a sidebar nobody searches never
   * pays for it. One writer, `loadSessionIndex` below.
   */
  const [sessionIndex, setSessionIndex] = useState<SessionIndexEntry[] | null>(null)
  const [sessionIndexLoading, setSessionIndexLoading] = useState(false)
  const [sessionIndexError, setSessionIndexError] = useState<string | null>(null)

  /*
   * The app always has at least one tab: a New Project tab is a real tab now,
   * and the strip is never left empty.
   *
   * `activeTabId === null` used to mean "showing the launcher", back when the
   * launcher rendered outside the tab strip on that sentinel. Now the launcher
   * is a New tab's own content (`activeTab?.kind === 'new'`), so landing on
   * `null` shows neither pane — five call sites used to set it that way (the
   * `+` button, the newTab shortcut, openFolder, the sidebar's project select,
   * and the command palette). The `+` button and the newTab shortcut call
   * `openNewTab` below instead, which always appends a fresh tab and selects
   * it — several may be open at once, on purpose (see `openNewTab`'s own
   * comment). `openFolder` fills the New tab already in view when there is
   * one, the same rule its other two launcher actions (Start here, Scratch
   * session) already follow, and only appends when there is not. The sidebar's
   * project select and the command palette no longer switch tabs at all —
   * selecting a project must not itself hide whatever tab is showing (spec
   * §2.10) — they only move the selection, via `selectProject`.
   * The type stays `string | null` because the very first render, before the
   * mount effect below picks tabs[0], is still
   * null.
   */
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

  /*
   * Select the first tab as soon as it exists. `cur ?? …` makes this inert
   * after the first pass: it can never replace a real selection, so it is safe
   * to depend on the whole tab list.
   */
  useEffect(() => {
    setActiveTabId((cur) => cur ?? tabs[0]?.id ?? null)
  }, [tabs])

  /** Screens for tabs restored from the last run, keyed by tab id. */
  const [restoredScreens, setRestoredScreens] = useState<Record<string, string>>({})
  /**
   * How many *paused* tabs are still in the strip, recomputed on every render
   * rather than snapshotted once when the boot restore lands. A one-time
   * snapshot never decrements, so the bar kept claiming "Restored 3 paused
   * tabs" after two of them had been resumed or closed — Resume in
   * particular gives a tab a live process, and the count needs to notice.
   * Not `tabs.length`: a restored `kind: 'new'` tab comes back with
   * `status: 'running'` (`fromStored` — only a session tab can be paused), so
   * counting every restored tab overstates it whenever a New tab was open at
   * quit, and can name a positive count when nothing at all was paused (quit
   * with only a New tab open).
   */
  const pausedTabCount = useMemo(() => tabs.filter((t) => t.status === 'paused').length, [tabs])
  /**
   * Whether the bar has been told to go away by hand — Dismiss, or Start
   * fresh — as distinct from `pausedTabCount` having reached zero on its own
   * because the user resumed or closed every restored tab, which hides the
   * bar exactly the same way with no flag needed.
   */
  const [restoreDismissed, setRestoreDismissed] = useState(false)
  /**
   * The bar's actual input: 0 both before the restore has run and once the
   * user has dismissed it, started fresh, or worked through every paused tab
   * by hand — the bar has no other way to tell "nothing to restore" from
   * "already handled it", and it does not need one.
   */
  const restoreCount = restoreDismissed ? 0 : pausedTabCount
  /**
   * Whether the boot restore has settled — resolved or rejected — as opposed
   * to not having come back yet. `restoreCount` alone cannot carry this: it is
   * `0` in both "still in flight" and "resolved with nothing to restore", and
   * the `startOnLaunch` effect below needs to tell those apart or it can fire
   * before the restore's own veto has had a chance to land. Plain state, not a
   * ref — flipping a ref would not cause that effect to re-run and reconsider
   * once the restore actually settles.
   */
  const [restoreSettled, setRestoreSettled] = useState(false)
  /**
   * Guards the boot restore effect below against running twice — a plain
   * StrictMode double-invoke guard for that one effect, nothing more. It
   * flips true synchronously as soon as the effect body runs, before the
   * restore's IPC round trip has even started, so it does *not* stop the
   * debounced save effect from writing over the restore in flight; that
   * effect never reads this ref at all and fires purely off its own
   * dependencies (`tabs`, `activeTabId`, `contexts`, `restoredScreens`).
   * `restoreSettled` is the flag that actually tracks whether the restore
   * has resolved.
   */
  const restored = useRef(false)
  /**
   * Whether the boot restore brought back any session tab — the startOnLaunch
   * veto. Not `restoreCount`, which counts tabs STILL paused: after an update
   * restart the restored tabs resume themselves within a second, the count
   * falls to 0 before `cli` has answered, and the auto-start then opened an
   * extra session beside them (measured: three `claude` processes for two
   * restored tabs). What vetoes it is that the restore had anything, not that
   * it still does.
   */
  const restoredSessions = useRef(false)

  /*
   * The visible selection: the active New tab's own target when there is one,
   * the sidebar's browse state otherwise. Declared here — right after `tabs`
   * and `activeTabId` exist — rather than by `activeNewTabId` further down,
   * because the sessions effect a little below reads `selectedPath` and a
   * `const` cannot be read before its own declaration runs.
   */
  const selectedPath = useMemo(() => {
    const t = tabs.find((x) => x.id === activeTabId)
    return t && t.kind === 'new' ? t.selectedPath : browsePath
  }, [tabs, activeTabId, browsePath])

  const expandedPath = useMemo(() => {
    const t = tabs.find((x) => x.id === activeTabId)
    return t && t.kind === 'new' ? t.expandedPath : browseExpanded
  }, [tabs, activeTabId, browseExpanded])

  /**
   * Write the sidebar's visible selection and, when `tabId` names a New tab —
   * the active one by default — that tab's own copy too.
   *
   * `tabId` can be pinned explicitly because `openFolder` decides, in the same
   * tick, which tab (the New one already in view, or a freshly minted one)
   * the selection has to land on; `activeTabId` read here would still be
   * whichever tab was active *before* that switch, since React does not
   * re-render between the mint and this call.
   */
  const selectProject = useCallback(
    (path: string | null, tabId: string | null = activeTabId): void => {
      setBrowsePath(path)
      setTabs((list) =>
        list.map((t) => (t.id === tabId && t.kind === 'new' ? { ...t, selectedPath: path } : t))
      )
    },
    [activeTabId]
  )

  const toggleExpand = useCallback(
    (path: string | null): void => {
      setBrowseExpanded(path)
      setTabs((list) =>
        list.map((t) =>
          t.id === activeTabId && t.kind === 'new' ? { ...t, expandedPath: path } : t
        )
      )
    },
    [activeTabId]
  )

  const [contexts, setContexts] = useState<Record<string, ContextSnapshot>>({})

  /*
   * Where each session is — working, done, or asking for attention — keyed by
   * session id, from the CLI's own hooks (see SessionEvent). This is what the
   * tab strip's activity dot and the status bar's "Claude is working…" read,
   * and what decides whether a finished turn raises an OS notification.
   *
   * A `done` or `attention` entry is cleared when its tab is looked at, so the
   * dot means "something happened here since you last looked" and nothing
   * else. `working` is never cleared by looking; it ends when the turn does.
   */
  const [activity, setActivity] = useState<Record<string, SessionActivity>>({})

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserWidth, setBrowserWidth] = useState(460)
  const [browserState, setBrowserState] = useState<BrowserState>(EMPTY_BROWSER)

  /*
   * The worklog review queue. Proposals only ever arrive from a scan; nothing
   * reaches Notion or ClickUp until accept is called on an item, so this state
   * is a review surface rather than a record of anything written.
   */
  const [worklogOpen, setWorklogOpen] = useState(false)
  const [worklog, setWorklog] = useState<WorklogProposal[]>([])
  const [worklogBusy, setWorklogBusy] = useState(false)
  /*
   * Which sessions the worklog may look at, keyed by session id. Pushed whole
   * on every change rather than merged, because a delta and a full list cannot
   * both be the source of truth.
   *
   * ONE copy, App-wide. The tab strip's watched-session dots (A Task 52) read
   * this array through a useMemo rather than subscribing again: a second
   * subscription in the same effect is a `const offWatch` redeclaration, and a
   * second copy of the list is the drift the whole-list rule exists to stop.
   */
  const [worklogWatch, setWorklogWatch] = useState<WorklogWatchState[]>([])
  /*
   * What the last automatic scan proposed, and what has been waved past here.
   *
   * Ids rather than proposals: the queue is broadcast in full on every change,
   * so keeping a second copy of the records would drift the moment one is
   * accepted. `asked` is the strip's own memory — skipping something must not
   * reject it, only stop this one control from asking again.
   */
  const [proposedIds, setProposedIds] = useState<string[]>([])
  const [asked, setAsked] = useState<Set<string>>(new Set())

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Where the sheet opens. Set by whoever asked for it, cleared with the sheet. */
  const [settingsSection, setSettingsSection] = useState<SectionId | undefined>(undefined)
  /*
   * Remounts the sheet on every open. The sheet reads `initialSection` once,
   * into its own state, so an open that arrives while it is already showing —
   * `stoke update` from a terminal while Appearance is up — would otherwise
   * leave it where it was.
   */
  const [settingsKey, setSettingsKey] = useState(0)
  const openSettings = useCallback((section?: SectionId): void => {
    setSettingsSection(section)
    setSettingsKey((k) => k + 1)
    setSettingsOpen(true)
  }, [])
  const [maximized, setMaximized] = useState(false)
  /*
   * Tracked apart from `maximized`, because on macOS they are different states
   * and full screen is the one that hides the traffic lights. The title bar
   * reserves fixed device pixels for those lights, so it has to stop when they
   * are gone or the first tab sits behind empty space.
   */
  const [fullScreen, setFullScreen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Result of the launch-time CLI version check. */
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  /*
   * Which CLI version each live session is actually running, keyed by session
   * id, straight from its own statusLine payload.
   *
   * A session keeps whichever binary it spawned with for its whole life, so
   * this diverges from `cli.version` the moment the CLI updates under an open
   * tab — which is precisely the state the relaunch offer exists to name. It
   * is not derivable from anything Stoke already holds: `cli` describes the
   * disk, and a version stamped on the tab at launch would be a cache that
   * goes stale in exactly this case.
   */
  const [sessionLine, setSessionLine] = useState<
    Record<string, { cliVersion: string | null; modelId: string | null; modelName: string | null }>
  >({})
  /*
   * A relaunch in flight, so the pill can say so and cannot be fired twice.
   *
   * Both halves are load-bearing and they are not the same mechanism. The ref
   * is the correctness half: a second click lands before React has re-rendered
   * with the disabled button, and the damage is worse than a wasted spawn —
   * `activeTab` still names the OLD tab, so `replaceOrAppend` finds nothing to
   * replace the second time and **appends**, leaving two tabs and two live
   * `claude` processes resuming one transcript. The state is the honest half:
   * the relaunch takes a couple of seconds during which nothing visibly
   * happens, which is exactly what invites the second click.
   */
  /*
   * Per TAB now, not one flag: an automatic relaunch (`cliRelaunch: 'auto'`)
   * can be moving a background tab while the pill in front is pressed, and one
   * shared flag would refuse the second for the wrong reason. The ref is still
   * the correctness half, the state still the honest half — gotcha 51.
   */
  const relaunchingRef = useRef<Set<string>>(new Set())
  const [relaunching, setRelaunching] = useState<readonly string[]>([])

  /*
   * Relaunches waiting for a running turn to end, by tab id, and who asked:
   * the user (Wait, in the busy dialog) or the automatic relaunch. Same split
   * as above — the ref is claimed synchronously so a second Wait, or the
   * automatic pass, cannot queue the same tab twice; the state is what lets
   * the pill say "relaunch when idle…".
   */
  const pendingRef = useRef<Map<string, PendingOrigin>>(new Map())
  const [pending, setPending] = useState<Readonly<Record<string, PendingOrigin>>>({})
  const syncPending = useCallback((): void => {
    setPending(Object.fromEntries(pendingRef.current))
  }, [])

  /** The busy dialog, when it is up. */
  const [busyPrompt, setBusyPrompt] = useState<BusyPrompt | null>(null)
  const busyPromptRef = useRef<BusyPrompt | null>(null)
  busyPromptRef.current = busyPrompt

  /*
   * Stoke's own "Restart and install", deferred until no session is mid-turn.
   * A ref claimed before the install call so the effect that fires it cannot
   * fire it twice across two renders.
   */
  const selfRestartPendingRef = useRef(false)
  const [selfRestartPending, setSelfRestartPending] = useState(false)

  /*
   * What the CLI's own session registry says about each live local pty, keyed
   * by ptyId: the session it is on now, whether a turn is running, and the
   * version it runs. See src/shared/claudeRegistry.ts. The ref is written in
   * the listener as well as on render, so two pushes in one tick each see the
   * one before (gotcha 56's shape).
   */
  const [live, setLive] = useState<Record<string, LiveSessionState>>({})
  const liveRef = useRef<Record<string, LiveSessionState>>(live)
  liveRef.current = live

  /*
   * The same claim, per tab, for Resume and Start again.
   *
   * `relaunchTab` got the guard above when gotcha 51 was written, and the two
   * paths that do the identical thing — `resumeTabFor` for a restored card,
   * `restartTab` for an ended one — were left without it. Both call
   * `startSession`/`startHostSession` and then `replaceOrAppend` by id, and
   * `replaceOrAppend` APPENDS when the id it is given is no longer in the list.
   * So both carry the same two failures:
   *
   *   Pressing Resume twice inside the couple of seconds a PTY takes to come up
   *   starts two `claude --resume <id>` against one transcript. The button has
   *   no busy state, so nothing on screen says the first press landed.
   *
   *   Worse, `Resume all` followed by `Close them` — two buttons sitting beside
   *   each other in the same bar. `Close them` filters on `status === 'paused'`
   *   and the resumes have not resolved yet, so every tab is dropped; each
   *   `pty.start` then resolves, finds its `replaceTabId` gone, and APPENDS.
   *   The tabs you just closed reappear at the end of the strip, each backed by
   *   a real process that the close never killed because a paused tab has no
   *   PTY to kill.
   *
   * A Set rather than a boolean, because these are per-tab and `Resume all`
   * legitimately runs several at once. The ref is the correctness half, claimed
   * synchronously before the async call; the state is what lets the button say
   * so. Same split, same reason, as the relaunch pill above.
   */
  const startingRef = useRef<Set<string>>(new Set())
  const [starting, setStarting] = useState<readonly string[]>([])

  const claimStart = useCallback((tabId: string): boolean => {
    if (startingRef.current.has(tabId)) return false
    startingRef.current.add(tabId)
    setStarting([...startingRef.current])
    return true
  }, [])

  const releaseStart = useCallback((tabId: string): void => {
    startingRef.current.delete(tabId)
    setStarting([...startingRef.current])
  }, [])

  /*
   * Launch options for the next session, DERIVED from the saved defaults rather
   * than mirrored into state beside them.
   *
   * They were four `useState`s seeded once on boot and written by the launcher.
   * Settings has a second writer — the Sessions pane's own Default permissions,
   * Default model and Default effort controls — and it did not touch this copy,
   * so changing a default in Settings updated the file and left the launcher
   * showing the old value AND launching with it. Two writers, one of them
   * invisible to the other; the drift lasted until the app was restarted, which
   * is exactly when it re-seeded and the evidence disappeared.
   *
   * Ultracode is not an effort level — the CLI's --effort takes only
   * low/medium/high/xhigh — but a boolean it reads from its settings, so it
   * rides along as its own launch option rather than as a sixth effort.
   */
  const mode: PermissionMode = settings?.defaults.permissionMode ?? 'default'
  const model = settings?.defaults.model ?? ''
  const effort: EffortLevel = settings?.defaults.effort ?? 'default'
  const ultracode = settings?.defaults.ultracode ?? false

  /*
   * Whether the OS is in dark mode, which decides which of the two stored
   * themes is on screen while `followSystemTheme` is on.
   *
   * From main rather than `matchMedia`, because main pins
   * `nativeTheme.themeSource` to Stoke's own appearance whenever following is
   * OFF — so the media query in this page answers with Stoke's setting, not the
   * system's, and would agree with itself forever. Defaults to dark so the
   * first paint before the answer arrives matches the default theme.
   */
  const [systemDark, setSystemDark] = useState(true)
  const systemDarkRef = useRef(true)
  systemDarkRef.current = systemDark

  const savedTheme = useMemo(
    () =>
      resolveTheme(
        settings ? activeThemeId(settings, systemDark) : '',
        settings?.customThemes ?? []
      ),
    [settings, systemDark]
  )

  /*
   * The theme editor's live preview, and the reason it is a piece of App state
   * rather than something the editor paints for itself.
   *
   * `lib/theme.ts` ends with "Nothing else in the codebase should touch
   * documentElement.style for colour", and that rule is load-bearing rather
   * than stylistic: it is what the accent bug in `applyAppearance`'s own
   * comment cost, two writers disagreeing about who owned four tokens. An
   * editor that wrote its preview straight onto :root would be a second writer
   * with no way to hand back -- cancelling would have to reconstruct the saved
   * appearance itself, which is the same reconstruction the effect below
   * already does correctly.
   *
   * So the editor states an intent and the one existing writer keeps writing.
   * `null` means "no preview", not "no theme"; cancel is `setPreviewTheme(null)`
   * and the effect repaints the saved theme with no further help.
   */
  const [previewTheme, setPreviewTheme] = useState<Theme | null>(null)
  const theme = previewTheme ?? savedTheme

  const refreshProjects = useCallback(async (): Promise<void> => {
    const list = await window.stoke.projects.list()
    setProjects(list)
    setProjectsLoading(false)
  }, [])

  /*
   * (Re)fetch the session index. Cheap to call again — main re-reads only the
   * transcripts whose mtime or size moved — so it is simply called whenever
   * the answer might have changed while someone is searching.
   *
   * Numbered so a slow reply cannot land on top of a newer one: only the
   * latest request may write, and only it clears the loading flag.
   */
  const searching = query.trim() !== ''
  const searchingRef = useRef(searching)
  searchingRef.current = searching
  const indexRequest = useRef(0)
  const loadSessionIndex = useCallback((): void => {
    const req = ++indexRequest.current
    setSessionIndexLoading(true)
    window.stoke.projects.sessionIndex().then(
      (list) => {
        if (req !== indexRequest.current) return
        setSessionIndex(list)
        setSessionIndexError(null)
        setSessionIndexLoading(false)
      },
      (e: unknown) => {
        if (req !== indexRequest.current) return
        setSessionIndexError(ipcErrorMessage(e))
        setSessionIndexLoading(false)
      }
    )
  }, [])

  const patchSettings = useCallback(async (patch: Partial<Settings>): Promise<void> => {
    const next = await window.stoke.settings.set(patch)
    setSettings(next)
  }, [])

  /*
   * The live settings, readable from the window keydown handler without putting
   * `settings` in that effect's dependency array.
   *
   * Both halves of that matter. Settings load asynchronously, so the handler is
   * first built while this is still null — leave it out of the deps and the
   * closure keeps that null forever, which is exactly how the zoom shortcut
   * shipped doing nothing at all until it was driven in the running app. Put it
   * IN the deps and the listener is torn down and rebuilt on every settings
   * write, which for zoom is every keypress, since zooming *is* a settings
   * write. A ref is the one option that is neither.
   */
  const settingsRef = useRef<Settings | null>(settings)
  settingsRef.current = settings

  /*
   * The tab list and the selection, readable from the hook-event listener
   * without re-subscribing on every tab change — the same ref-on-render idiom
   * as `settingsRef`, and for the same reason (gotcha 31). The listener has to
   * know which tab an event belongs to and whether that tab is the one in
   * front, and it is bound once in the bootstrap effect.
   */
  const tabsRef = useRef<Tab[]>(tabs)
  tabsRef.current = tabs
  const activeTabIdRef = useRef<string | null>(activeTabId)
  activeTabIdRef.current = activeTabId

  /*
   * The appearance a session should be launched with, read at call time.
   *
   * `startSession` and `connectHost` are useCallbacks whose dependency arrays
   * do not list `theme`, and adding it there would rebuild both on every theme
   * change for a value only read inside the call. Closing over the memo instead
   * would freeze whatever `theme` was on the first render -- and since settings
   * load asynchronously that is always the default dark theme, so every session
   * started under the light theme would have been told the window was dark.
   * Same shape as the zoom-shortcut bug the ref above exists for.
   */
  const launchAppearance = useCallback((): Theme['appearance'] => {
    const s = settingsRef.current
    if (!s) return resolveTheme('', []).appearance
    return resolveTheme(activeThemeId(s, systemDarkRef.current), s.customThemes).appearance
  }, [])

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    initPtyBus()

    const offCtx = window.stoke.context.onUpdate((snap) =>
      setContexts((prev) => ({ ...prev, [snap.sessionId]: snap }))
    )
    /*
     * Hook events. A prompt starts a turn; a stop ends it; a notification is
     * the CLI asking for something. The transition to `done` or `attention`
     * is also the moment an OS notification may be raised, and whether it is
     * depends on where the user is looking — read through refs, because this
     * listener is bound once.
     */
    const offEvents = window.stoke.session.onEvent((ev: SessionEvent) => {
      const tab = tabsRef.current.find((t) => t.sessionId === ev.sessionId)
      if (ev.kind === 'prompt') {
        // Submitted: whatever was typed has left the prompt box.
        if (tab) clearTyped(tab.ptyId)
        setActivity((prev) => ({
          ...prev,
          [ev.sessionId]: { state: 'working', at: ev.at, message: null }
        }))
        return
      }
      /*
       * The CLI's idle nudge ("Claude is waiting for your input", a minute
       * after a reply) says what `done` already says, so it neither changes
       * the state nor raises a second notification. Measured: it arrived 60s
       * after every Stop and turned a quiet done dot into a warning one.
       */
      if (ev.kind === 'notification' && ev.notificationType === 'idle_prompt') return
      const state: SessionActivity['state'] = ev.kind === 'stop' ? 'done' : 'attention'
      const inFront = tab !== undefined && tab.id === activeTabIdRef.current
      /*
       * A `done` or `attention` for the tab in front, with the window focused,
       * is not news: it is on screen. It is recorded all the same and cleared
       * by the activation effect below on the next render, so the strip never
       * flashes a dot for it — and stays if the window is behind another app,
       * which is when the dot earns its keep.
       */
      setActivity((prev) => ({
        ...prev,
        [ev.sessionId]: { state, at: ev.at, message: ev.message }
      }))

      const mode = settingsRef.current?.notifications ?? 'background'
      const background = !document.hasFocus() || !inFront
      if (mode === 'off' || (mode === 'background' && !background)) return
      if (typeof Notification === 'undefined' || Notification.permission === 'denied') return
      const title = tab?.title ?? tab?.projectName ?? 'Claude Code'
      const body =
        ev.kind === 'stop'
          ? (ev.message ?? 'Finished — waiting for you.')
          : (ev.message ?? 'Needs your attention.')
      try {
        const n = new Notification(title, { body, silent: false, tag: ev.sessionId })
        n.onclick = () => {
          window.stoke.window.focus()
          if (tab) setActiveTabId(tab.id)
        }
      } catch {
        /* the platform refused; the dot in the strip still says it */
      }
    })
    /*
     * The CLI's own session registry, per live local pty (main's
     * sessionRegistry.ts): which session it is on now, whether a turn is
     * running, which binary it runs.
     */
    const offState = window.stoke.session.onState((st) => {
      const before = liveRef.current[st.ptyId]
      liveRef.current = { ...liveRef.current, [st.ptyId]: st }
      setLive((prev) => ({ ...prev, [st.ptyId]: st }))
      // Busy means something was submitted, so the prompt box is empty again.
      if (st.busy === true) clearTyped(st.ptyId)
      /*
       * A turn that ended without a `Stop` hook — Esc, or an API error — left
       * the activity dot saying "working" until the next prompt. The registry
       * sees the process go idle either way, so a working dot is settled here.
       * Only on the transition, and only from `working`: a `Stop` that
       * arrives a moment later still writes its own message over this.
       */
      if (st.busy === false && before?.busy === true && st.sessionId) {
        const id = st.sessionId
        setActivity((prev) => {
          const cur = prev[id]
          if (!cur || cur.state !== 'working') return prev
          return { ...prev, [id]: { state: 'done', at: Date.now(), message: null } }
        })
      }
    })
    void window.stoke.session.states().then((list) =>
      setLive((prev) => {
        const next = { ...prev }
        // A push that has already landed is newer than this snapshot.
        for (const st of list) if (!(st.ptyId in next)) next[st.ptyId] = st
        liveRef.current = next
        return next
      })
    )
    /*
     * A live pty's `claude` moved to another session: `/clear`, the in-TUI
     * `/resume`, or a `--continue` learning its id. The tab follows, and so
     * does everything keyed by session id that describes the PROCESS — its
     * version line and its activity dot. The context reading does not: that
     * describes the conversation left behind, and the watcher publishes the
     * new one's (empty until its first prompt). Nothing moves off an id another
     * tab still holds.
     */
    const offRebind = window.stoke.session.onRebind(({ ptyId, sessionId, previous }) => {
      const shared = tabsRef.current.some((t) => t.ptyId !== ptyId && t.sessionId === previous)
      setTabs((list) => rebindTabs(list, ptyId, sessionId))
      if (!previous || shared) return
      setSessionLine((m) => moveKey(m, previous, sessionId))
      setActivity((m) => moveKey(m, previous, sessionId))
      setContexts((m) => {
        if (!(previous in m)) return m
        const next = { ...m }
        delete next[previous]
        return next
      })
    })
    /*
     * Per-session CLI versions. Cheap: these pushes already happen for the
     * usage chip, and this reads one more field off the same payload.
     */
    const offLine = window.stoke.statusLine.onUpdate((snap) => {
      setSessionLine((prev) => {
        const cur = prev[snap.sessionId]
        if (
          cur &&
          cur.cliVersion === snap.cliVersion &&
          cur.modelId === snap.modelId &&
          cur.modelName === snap.modelName
        ) {
          return prev
        }
        return {
          ...prev,
          [snap.sessionId]: {
            cliVersion: snap.cliVersion,
            modelId: snap.modelId,
            modelName: snap.modelName
          }
        }
      })
    })
    /*
     * Re-read the disk whenever the updater reports anything.
     *
     * `cli` was fetched once at boot and never again, which is fine until
     * something changes the binary — and the automatic checker does exactly
     * that, twelve seconds in and every six hours after, with no UI attached.
     * Without this the installed version on screen stays at whatever was true
     * at launch, so the one comparison that drives the relaunch offer would be
     * old-vs-old and never fire.
     */
    const offUpdates = window.stoke.updates.onState((st) => {
      setUpdate(st.info)
      void window.stoke.cli.info().then(setCli)
    })
    const offBrowser = window.stoke.browser.onState(setBrowserState)
    const offMax = window.stoke.window.onMaximizedChanged(setMaximized)
    void window.stoke.window.systemDark().then(setSystemDark)
    const offSystemDark = window.stoke.window.onSystemDarkChanged(setSystemDark)
    const offFull = window.stoke.window.onFullScreenChanged(setFullScreen)
    const offSettings = window.stoke.settings.onChange(setSettings)
    const offWorklog = window.stoke.worklog.onChange(setWorklog)
    /*
     * Only an automatic scan raises the prompt.
     *
     * The queue is restored on every launch and the panel already shows it, so
     * asking about whatever happens to be sitting in it would greet the user
     * with a question about work from last week. This fires when Stoke went and
     * looked without being asked, which is the only case where the user does
     * not already know there is something to decide.
     */
    const offProposed = window.stoke.worklog.onProposed((e) => {
      setProposedIds(e.ids)
      setAsked(new Set())
    })
    void window.stoke.worklog.queue().then(setWorklog)
    const offWatch = window.stoke.worklog.onWatchChanged(setWorklogWatch)
    void window.stoke.worklog.watch().then(setWorklogWatch)

    void (async () => {
      const s = await window.stoke.settings.get()
      setSettings(s)
      setSidebarWidth(s.sidebarWidth)
      setBrowserWidth(s.browser.width)
      void window.stoke.cli.info().then(setCli)
      void window.stoke.workspace.defaultCwd().then(setDefaultCwd)
      // Quiet check; surfaces as a status-bar pill only when something is newer.
      void window.stoke.updates.check().then(setUpdate)
      await refreshProjects()
    })()

    void window.stoke.window.isMaximized().then(setMaximized)
    // Asked as well as subscribed: a window can start full screen, and no
    // enter-full-screen event fires for a state it was already in.
    void window.stoke.window.isFullScreen().then(setFullScreen)

    return () => {
      offCtx()
      offEvents()
      offState()
      offRebind()
      offLine()
      offUpdates()
      offBrowser()
      offFull()
      offMax()
      offSystemDark()
      offSettings()
      offWorklog()
      offProposed()
      offWatch()
    }
  }, [refreshProjects])

  // The configured folder can change in Settings; re-resolve when it does so
  // the launcher and Settings hint never disagree.
  useEffect(() => {
    if (!settings) return
    void window.stoke.workspace.defaultCwd().then(setDefaultCwd)
  }, [settings?.defaultCwd, settings])

  // Project timestamps go stale while the window is in the background — and so
  // do session titles, which Claude rewrites as a conversation goes on.
  useEffect(() => {
    const onFocus = (): void => {
      void refreshProjects()
      if (searchingRef.current) loadSessionIndex()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshProjects, loadSessionIndex])

  /*
   * Looking at a tab clears its `done` / `attention`, because the dot means
   * "since you last looked". Both selecting the tab and the window regaining
   * focus count as looking; a `working` entry is left alone, since it ends
   * when the turn does rather than when anyone looks.
   */
  const seenActive = useCallback((): void => {
    if (!document.hasFocus()) return
    const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current)
    if (!tab?.sessionId) return
    setActivity((prev) => {
      const cur = prev[tab.sessionId]
      if (!cur || cur.state === 'working') return prev
      const next = { ...prev }
      delete next[tab.sessionId]
      return next
    })
  }, [])
  useEffect(() => {
    seenActive()
  }, [activeTabId, activity, seenActive])
  useEffect(() => {
    window.addEventListener('focus', seenActive)
    return () => window.removeEventListener('focus', seenActive)
  }, [seenActive])

  /* ---------------------------------------------------------------- theme */

  /*
   * Resolved here rather than only inside the sidebar, because the accent has to
   * resolve against the same list. It was resolving against the hardcoded
   * PROFILES instead, so a folder-derived profile coloured its sidebar chip and
   * then failed to repaint the accent - the one place the two lists could
   * disagree was the one place it mattered.
   *
   * `resolveProfiles` keeps every stored record, including ones belonging to
   * another machine; `visibleProfiles` is what the chips and the accent read, so
   * a record that matches nothing here is not rendered and is not erased either.
   */
  const availableProfiles = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of projects) counts.set(p.group, (counts.get(p.group) ?? 0) + 1)
    const resolved = resolveProfiles(counts, settings?.profiles ?? [])
    return visibleProfiles(resolved, counts, settings?.projectRoots ?? [])
  }, [projects, settings?.profiles, settings?.projectRoots])

  /*
   * One effect, one writer. The theme and the profile accent used to be applied
   * from two separate effects, and the profile one cleared the four accent
   * tokens with removeProperty whenever no profile was selected - the default
   * state - which removed the theme's accent along with them. See
   * applyAppearance for why that failed silently rather than loudly.
   */
  /*
   * The selection, but only while it still resolves. Deleting the active profile
   * in Settings must not leave the sidebar quietly filtered by a chip that is no
   * longer in the row - the accent would clear and the project list would not,
   * and there would be nothing on screen explaining why half the projects are
   * missing. Restoring the profile brings the selection back with it.
   */
  const activeProfile = useMemo(
    () => profileFor(settings?.activeProfile ?? null, availableProfiles),
    [settings?.activeProfile, availableProfiles]
  )

  useEffect(() => {
    applyAppearance(theme, activeProfile)
  }, [theme, activeProfile])

  const wallpaper = settings?.wallpaper ?? null
  useEffect(() => {
    if (!wallpaper) return
    applyWallpaper(wallpaper, wallpaper.path ? window.stoke.wallpaper.url(wallpaper.path) : null)
  }, [wallpaper])
  // The canvas is fully see-through over its card while a wallpaper is set;
  // the card carries the tint (see app.css's wallpaper block).
  const termAlpha = wallpaper?.path ? 0 : 1

  /*
   * The active tab decides the profile: colour and filter both follow it.
   *
   * Keyed on the tab id through a ref rather than on the resolved value, because
   * this effect also reruns whenever settings change — and without the ref,
   * clicking All while a work tab is in front would be undone on the very next
   * render and the chip could not be moved by hand at all. A manual choice
   * stands until the next time a tab is activated.
   *
   * Three deliberate non-actions:
   *  - An SSH tab never resolves. `ssh -t <alias>` runs claude on the far
   *    machine, so `cwd` holds the host alias rather than a folder (CLAUDE.md
   *    gotcha 18) and mapping it would name whichever local project happened to
   *    share that word. `hostId` is the only reliable signal that it is one.
   *  - A folder belonging to no profile leaves the chip exactly where it is,
   *    rather than clearing it to All.
   *  - Nothing happens until the project list has loaded, or a startOnLaunch
   *    session would resolve against an empty list, find nothing, and be marked
   *    as already handled.
   */
  const profiledTabId = useRef<string | null>(null)
  useEffect(() => {
    if (!settings || projectsLoading) return
    if (profiledTabId.current === activeTabId) return
    profiledTabId.current = activeTabId
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab || tab.hostId) return
    const id = profileIdForCwd(
      tab.cwd,
      projects,
      settings.projectRoots,
      availableProfiles,
      platform
    )
    if (!id || foldGroup(id) === foldGroup(settings.activeProfile ?? '')) return
    void patchSettings({ activeProfile: id })
  }, [
    activeTabId,
    tabs,
    projects,
    projectsLoading,
    settings,
    availableProfiles,
    platform,
    patchSettings
  ])

  useEffect(() => {
    if (settings) applyTypography(settings.fontFamily, settings.fontSize, settings.uiScale, settings.terminal)
  }, [settings])

  /* -------------------------------------------------------------- sessions */

  useEffect(() => {
    const path = selectedPath
    if (!path) return
    let cancelled = false
    setSessionsLoadingPath(path)
    void window.stoke.projects.sessions(path).then((list) => {
      if (cancelled) return
      setSessionsByPath((prev) => ({ ...prev, [path]: list }))
      setSessionsLoadingPath((cur) => (cur === path ? null : cur))
    })
    return () => {
      cancelled = true
    }
  }, [selectedPath])

  /*
   * What the sidebar and the launcher read.
   *
   * The cached rows are available the instant a project is reselected — but the
   * spinner still appears, because the effect above refetches on every change of
   * `selectedPath` with no cache-hit guard. That is deliberate, not an
   * oversight: nothing invalidates this cache. `startSession` never writes into
   * it, so a session started in the currently selected project is missing from
   * the list until the path changes and comes back. Serving a cache hit without
   * refetching would make that staleness permanent.
   *
   * What the cache buys is what the per-tab launcher needs: it can hold two
   * projects' lists at once, which the single `sessions` array it replaced
   * could not.
   */
  const sessions = selectedPath ? (sessionsByPath[selectedPath] ?? []) : []

  /*
   * When search reads the index: the moment a query appears — the first one,
   * and every time the box goes from empty to not — so a search always starts
   * from the disk as it is now rather than as it was the last time someone
   * searched. Not per keystroke: matching is local, and the list of sessions
   * does not change because a letter was typed.
   */
  useEffect(() => {
    if (searching) loadSessionIndex()
  }, [searching, loadSessionIndex])

  /*
   * And again whenever a session tab starts, ends or goes away while a query is
   * showing: that is when a transcript appears, is retitled or stops growing.
   * Keyed on the session tabs' ids and statuses rather than on `tabs`, which
   * changes on every title update and selection.
   */
  const sessionTabsKey = useMemo(
    () =>
      tabs
        .filter((t) => t.kind === 'session')
        .map((t) => `${t.id}:${t.status}`)
        .join('|'),
    [tabs]
  )
  useEffect(() => {
    if (searchingRef.current) loadSessionIndex()
  }, [sessionTabsKey, loadSessionIndex])

  /* ------------------------------------------------------------------ tabs */

  // Mark tabs whose process has ended so the pane can offer a restart.
  useEffect(() => {
    const offs = tabs
      .filter((t) => t.kind === 'session' && t.status === 'running')
      .map((t) =>
        attachExit(t.ptyId, (code) => {
          /*
           * A relaunch kills this process on purpose and replaces the tab in
           * place once the new one is up. Its exit arrives in between, and
           * marking the tab "Session ended" for that second would flash the
           * exit card over a session that is merely being moved.
           */
          if (relaunchingRef.current.has(t.id)) return
          setTabs((list) =>
            list.map((x) =>
              x.ptyId === t.ptyId ? { ...x, status: 'exited' as const, exitCode: code } : x
            )
          )
          // An install tab has just changed what is on this machine.
          if (t.installing?.length) refreshAgents(true)
        })
      )
    return () => offs.forEach((off) => off())
  }, [tabs, refreshAgents])

  /*
   * Adopt Claude's own generated title, and keep the permission mode live.
   *
   * Both are read out of the transcript because it is the only thing that
   * knows. `tab.permissionMode` was captured at launch and no writer ever
   * updated it, so a tab kept claiming `bypass` for a session that had been
   * put back into `default` with Shift+Tab — the indicator could simply lie.
   */
  useEffect(() => {
    setTabs((list) => {
      let changed = false
      const next = list.map((t) => {
        const snap = contexts[t.sessionId]
        if (!snap) return t
        const title = snap.title && snap.title !== t.title ? snap.title : null
        const mode =
          snap.permissionMode && snap.permissionMode !== t.permissionMode
            ? snap.permissionMode
            : null
        if (!title && !mode) return t
        changed = true
        return {
          ...t,
          ...(title ? { title } : {}),
          ...(mode ? { permissionMode: mode } : {})
        }
      })
      return changed ? next : list
    })
  }, [contexts])

  /*
   * Persist the open tabs, debounced.
   *
   * Debounced rather than written on quit, and that is the load-bearing choice:
   * `before-quit` cannot ask the renderer for state and wait for the answer, and
   * a snapshot taken only at quit is worthless in exactly the cases that hurt
   * most — a crash, an OOM kill, or the force-kill CLAUDE.md warns against.
   *
   * A paused tab has no process, so `screenOf` finds no terminal for its empty
   * `ptyId` and would return ''. The resolver checks status instead of calling
   * `screenOf` unconditionally, so a paused tab keeps the screen it was
   * restored with rather than having the very first debounce after launch
   * silently overwrite it with an empty string.
   */
  useEffect(() => {
    const id = window.setTimeout(() => {
      window.stoke.tabs.save(
        toStored(
          tabs,
          activeTabId,
          contexts,
          (t) => (t.status === 'paused' ? (restoredScreens[t.id] ?? '') : screenOf(t.ptyId)),
          Date.now()
        )
      )
    }, 500)
    return () => window.clearTimeout(id)
  }, [tabs, activeTabId, contexts, restoredScreens])

  /** The New Project tab a launch should consume, or null to append. */
  const activeNewTabId = useMemo(() => {
    const t = tabs.find((x) => x.id === activeTabId)
    return t && t.kind === 'new' ? t.id : null
  }, [tabs, activeTabId])

  /*
   * Resolves `true` once the session tab is actually up, `false` on a caught
   * failure — `error` is already set either way. `resumeTabFor` needs this to
   * know whether it may drop a paused tab's restored screen: dropping it
   * unconditionally, before the result is known, would erase the preview out
   * from under a tab that stayed paused because the resume failed.
   */
  const startSession = useCallback(
    async (opts: {
      cwd: string
      name: string
      title?: string
      sessionId?: string
      resume?: boolean
      continueLast?: boolean
      /** Replace this tab in place instead of appending. Consumes a New tab. */
      replaceTabId?: string
      /** See `focusAfterStart`. Omitted means focus, as every single start does. */
      focus?: boolean
      /**
       * Override the App-level launch defaults below. `resumeTabFor` passes the
       * paused tab's own stored values here — the tab a card displays must be
       * the tab Resume actually launches, not whatever `mode`/`model`/`effort`
       * happen to be selected in the toolbar right now. Every other caller
       * omits these and gets today's globals, unchanged.
       */
      permissionMode?: PermissionMode
      model?: string
      effort?: EffortLevel
      ultracode?: boolean
      /**
       * Which coding CLI to spawn. Omitted means Claude Code, which is what
       * every existing caller means and what every tab was before this existed.
       */
      cli?: CodingCliId
      /** Install these agents in this tab instead of running one (agents.ts). */
      install?: CodingCliId[]
    }): Promise<boolean> => {
      setError(null)
      const launchCli = opts.cli ?? DEFAULT_CLI
      const caps = capsFor(launchCli)
      const permissionMode = opts.permissionMode ?? mode
      const sessionModel = opts.model ?? model
      const sessionEffort = opts.effort ?? effort
      const sessionUltracode = opts.ultracode ?? ultracode
      try {
        const res = await window.stoke.pty.start({
          cwd: opts.cwd,
          cli: launchCli,
          /*
           * Claude's flags go only to Claude. `--session-id`, `--resume` and
           * `--continue` are what mint and address a Claude transcript, and
           * gotcha 19 is the version of this mistake that has already been
           * paid for: an older remote `claude` EXITS on a flag it does not
           * know, so a flag sent to the wrong binary is not a no-op, it is a
           * session that will not start.
           */
          sessionId: caps.resume === 'mintedId' ? opts.sessionId : undefined,
          resume: caps.resume === 'mintedId' ? opts.resume : undefined,
          /*
           * A CLI that can only continue "the latest session in this folder"
           * turns a resume into that: it is the same session unless another
           * was started here since, and the paused card says so.
           */
          continueLast:
            caps.resume === 'mintedId'
              ? opts.continueLast
              : caps.resume === 'continue'
                ? opts.continueLast === true || opts.resume === true
                : undefined,
          install: opts.install,
          permissionMode,
          model: sessionModel,
          effort: sessionEffort,
          ultracode: sessionUltracode,
          appearance: launchAppearance(),
          // A real size arrives from the terminal's own resize observer as soon
          // as it mounts; this is only what the child sees for its first paint.
          cols: 120,
          rows: 30
        })
        const tab: Tab = {
          id: res.ptyId,
          kind: 'session',
          cliId: launchCli,
          ...(opts.install?.length ? { installing: opts.install } : {}),
          ptyId: res.ptyId,
          sessionId: res.sessionId,
          cwd: opts.cwd,
          projectName: opts.name,
          title: opts.title ?? opts.name,
          permissionMode,
          model: sessionModel,
          effort: sessionEffort,
          // What this session was launched with, so a relaunch or a Resume can
          // bring back the same one rather than today's global.
          ultracode: sessionUltracode,
          status: 'running',
          exitCode: null,
          hostId: null,
          selectedPath: null,
          expandedPath: null
        }
        /*
         * A session started from a New Project tab takes that tab's place
         * rather than appending beside it. Appending would leave the launcher
         * sitting next to the terminal it just started, which reads as the
         * button having failed.
         */
        setTabs((list) => replaceOrAppend(list, tab, opts.replaceTabId))
        focusAfterStart(setActiveTabId, tab.id, opts.replaceTabId, opts.focus)
        return true
      } catch (e) {
        setError(ipcErrorMessage(e))
        return false
      }
    },
    [mode, model, effort, ultracode, launchAppearance]
  )

  /* --------------------------------------------------------------- worklog */

  const acceptProposal = useCallback(async (id: string): Promise<void> => {
    setWorklogBusy(true)
    try {
      const res = await window.stoke.worklog.accept(id)
      if (res.error) setError(res.error)
    } finally {
      setWorklogBusy(false)
    }
  }, [])

  /**
   * Tombstone a proposal: never write it, and stop the scan offering it again.
   *
   * `window.stoke.worklog.reject` and its main-process handler have both worked
   * end to end since they were written and had NO caller anywhere in the
   * renderer — the surface that was going to call them was replaced by the
   * activity report in 6304e35. Rejection is the only thing that adds to
   * `queue.ts`'s `refused` set, so without it the sole way to stop a proposal
   * coming back was to accept it, and the pending count only ever went up.
   *
   * No `worklogBusy`, unlike accept: this writes one line to a local JSON file
   * rather than spawning a headless CLI run against two external services, so
   * there is nothing to guard the rest of the strip against.
   */
  const rejectProposal = useCallback(async (id: string): Promise<void> => {
    // Returns nothing: the handler tombstones and pushes the new list, so the
    // queue arriving over `worklog:changed` is the confirmation.
    await window.stoke.worklog.reject(id)
  }, [])

  /*
   * Sequential, not Promise.all. Each accept spawns a headless CLI run that
   * writes to two external services; firing them together would race the queue
   * file and multiply the cost spike with no way to stop partway.
   */
  /*
   * What the prompt still has to ask about.
   *
   * Read off the live queue rather than stored, so a proposal accepted from the
   * panel — or one that has since failed — drops out of the strip on its own
   * instead of being offered twice. Ordered by the event, which is newest first.
   */
  const promptQueue = useMemo(() => {
    if (!proposedIds.length) return []
    const byId = new Map(worklog.map((p) => [p.id, p]))
    return proposedIds
      .filter((id) => !asked.has(id))
      .map((id) => byId.get(id))
      .filter((p): p is WorklogProposal => !!p && p.status === 'pending')
  }, [proposedIds, asked, worklog])

  /*
   * The sole input to the red dot in the tab strip, derived from the one
   * App-level copy of the watch list rather than from a second subscription.
   * The list arrives whole on every change (contracts §0.3), so a Set built
   * from it cannot drift the way two copies of the same records would.
   */
  const watchedSessions = useMemo(
    () => new Set(worklogWatch.filter((s) => s.watched === true).map((s) => s.sessionId)),
    [worklogWatch]
  )

  /**
   * Open a session on a remote machine.
   *
   * Same PTY machinery, different argv. It deliberately does not watch context:
   * the transcript lives on the far machine, so there is nothing local to read
   * and a meter would have to invent a number.
   */
  const startHostSession = useCallback(
    // Same true/false contract as startSession, and for the same reason:
    // resumeTabFor must be able to tell a successful reconnect from a failed
    // one before it decides whether the paused tab's screen may be dropped.
    //
    // `overrides` mirrors startSession's own optional permissionMode/model/
    // effort: `resumeTabFor` passes the paused tab's own stored values so a
    // restored remote card resumes in the mode it displays rather than
    // whatever the toolbar's globals currently are. Omitted by every other
    // caller, which gets today's globals unchanged.
    async (
      host: SshHost,
      replaceTabId?: string,
      overrides?: {
        permissionMode?: PermissionMode
        model?: string
        effort?: EffortLevel
        /** See `focusAfterStart`. Omitted means focus, as every single start does. */
        focus?: boolean
      }
    ): Promise<boolean> => {
      setError(null)
      const permissionMode = overrides?.permissionMode ?? mode
      const sessionModel = overrides?.model ?? model
      const sessionEffort = overrides?.effort ?? effort
      try {
        const res = await window.stoke.pty.start({
          cwd: defaultCwd || '.',
          host,
          permissionMode,
          model: sessionModel,
          effort: sessionEffort,
          appearance: launchAppearance(),
          cols: 120,
          rows: 30
        })
        const tab: Tab = {
          id: res.ptyId,
          kind: 'session' as const,
          // An SSH tab runs `claude` on the far machine (gotcha 18). It is a
          // Claude tab whose instrumentation is off for a different reason.
          cliId: 'claude',
          ptyId: res.ptyId,
          sessionId: res.sessionId,
          cwd: host.alias,
          projectName: host.label || host.alias,
          title: host.label || host.alias,
          permissionMode,
          model: sessionModel,
          effort: sessionEffort,
          // Ultracode reaches `claude` through a local `--settings` file, which
          // an SSH session's far-side `claude` never sees.
          ultracode: false,
          status: 'running',
          exitCode: null,
          hostId: host.id,
          selectedPath: null,
          expandedPath: null
        }
        /*
         * Same replace-or-append rule as startSession: connecting to a host
         * from the launcher consumes the New tab it was launched from. A
         * caller resuming a paused remote tab passes its own id instead, so
         * `replaceTabId` wins when given — `activeNewTabId` is only the
         * fallback for the launcher's own call site.
         */
        setTabs((list) => replaceOrAppend(list, tab, replaceTabId ?? activeNewTabId))
        focusAfterStart(setActiveTabId, tab.id, replaceTabId ?? activeNewTabId, overrides?.focus)
        return true
      } catch (e) {
        setError(ipcErrorMessage(e))
        return false
      }
    },
    [defaultCwd, mode, model, effort, activeNewTabId, launchAppearance]
  )

  /**
   * A paused tab's restored screen is only useful until the tab it belongs to
   * stops being paused — resumed (it gets a live terminal instead) or closed
   * (it stops existing). Both call sites prune it so the map does not keep an
   * entry for the life of the run for every tab that ever got restored.
   */
  const dropRestoredScreen = useCallback((id: string): void => {
    setRestoredScreens((cur) => {
      if (!(id in cur)) return cur
      const next = { ...cur }
      delete next[id]
      return next
    })
  }, [])

  /*
   * Resuming a paused tab replaces it at its own index — `replaceOrAppend`
   * does that already (lib/tabs.ts:31-41) — so the tab does not jump to the
   * end of the strip the moment you start it.
   *
   * Returns null when there is nothing to resume, which the card turns into a
   * Close-only state rather than a button that fails.
   *
   * `focus` is passed through to the start: a single Resume takes you to the
   * tab you just resumed, and `Resume all` does not, because there the tab that
   * would win is decided by whichever PTY happens to come up last.
   *
   * The function it returns resolves once that start has settled, so the
   * update-restart resume below can bring tabs back one at a time.
   */
  const resumeTabFor = useCallback(
    (tab: Tab, focus = true): (() => Promise<void>) | null => {
      if (tab.hostId) {
        const host = settings?.hosts.find((h) => h.id === tab.hostId)
        if (!host) return null
        return async () => {
          if (!claimStart(tab.id)) return
          // Dropped only on success. `startHostSession`'s catch leaves this
          // tab paused and just sets `error` — pruning the screen unconditionally,
          // before the outcome is known, would discard the preview out from
          // under a tab that is still paused and has nothing else to show.
          //
          // The tab's own stored mode/model/effort, not the toolbar's current
          // globals — a paused card displaying "Bypass permissions" must
          // actually resume in bypass, and a card displaying `default` must
          // not silently inherit a global that has since been switched to
          // bypass. See CLAUDE.md's tab-restore finding on this exact bug.
          await startHostSession(host, tab.id, {
            permissionMode: tab.permissionMode,
            model: tab.model,
            effort: tab.effort,
            focus
          })
            .then((ok) => {
              if (ok) dropRestoredScreen(tab.id)
            })
            .finally(() => releaseStart(tab.id))
        }
      }
      return async () => {
        if (!claimStart(tab.id)) return
        await startSession({
          cwd: tab.cwd,
          name: tab.projectName,
          title: tab.title,
          /*
           * The tab's own CLI. Without it `startSession` fell back to
           * DEFAULT_CLI, so resuming a restored Codex tab ran `claude --resume
           * <the id Stoke had minted for the Codex launch>` and relabelled the
           * tab Claude. `startSession` drops the id and the resume flags for a
           * CLI whose caps cannot name a session, so this starts that CLI again
           * in the same folder.
           */
          cli: tab.cliId,
          sessionId: tab.sessionId || undefined,
          // No id means a --continue session, which never learned its own
          // (gotcha 26). Continue in the same folder instead.
          resume: Boolean(tab.sessionId),
          continueLast: !tab.sessionId,
          replaceTabId: tab.id,
          // Same reasoning as the host branch above: the tab's own stored
          // values, so the tab the user sees paused is the tab they get back.
          permissionMode: tab.permissionMode,
          model: tab.model,
          effort: tab.effort,
          ultracode: tab.ultracode,
          focus
        })
          .then((ok) => {
            if (ok) dropRestoredScreen(tab.id)
          })
          .finally(() => releaseStart(tab.id))
      }
    },
    [settings, startSession, startHostSession, dropRestoredScreen, claimStart, releaseStart]
  )
  const resumeTabForRef = useRef(resumeTabFor)
  resumeTabForRef.current = resumeTabFor

  /** Quick start with no project: run in the configured default folder. */
  const startDefault = useCallback((): void => {
    if (!defaultCwd) return
    void startSession({
      cwd: defaultCwd,
      name: baseName(defaultCwd),
      replaceTabId: activeNewTabId ?? undefined
    })
  }, [defaultCwd, startSession, activeNewTabId])

  /** Quick start in a fresh throwaway folder. */
  const startScratch = useCallback(async (): Promise<void> => {
    try {
      const dir = await window.stoke.workspace.createScratch()
      await startSession({
        cwd: dir,
        name: `Scratch ${baseName(dir)}`,
        replaceTabId: activeNewTabId ?? undefined
      })
      // The new folder becomes a real project once Claude writes a transcript.
      await refreshProjects()
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }, [startSession, refreshProjects, activeNewTabId])

  /*
   * Bring back the tabs from the last run, paused.
   *
   * Runs once. The guard is a ref rather than a dep list because a second pass
   * would overwrite whatever the user has already done in this run — including
   * under StrictMode's double-invoked effects, the same reason `autoStarted`
   * next door is a ref.
   */
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    void window.stoke.tabs
      .restore()
      .then((state) => {
        if (!state.tabs.length) return
        const { tabs: back, activeId } = fromStored(state)
        // Before `restoreSettled` flips in the `.finally` below, so the
        // startOnLaunch effect reads it on the very pass that is allowed to run.
        restoredSessions.current = back.some((t) => t.status === 'paused')
        setRestoredScreens(screensFrom(state, back))
        setTabs(back)
        setActiveTabId(activeId)
        /*
         * The last quit was Stoke installing its own update — pressed by the
         * user, from a dialog that already asked about running turns — so the
         * tabs come back running, not paused. Any other quit, the silent
         * install-on-quit included, restores them paused exactly as before.
         */
        if (state.afterUpdate) {
          setAutoResume(back.filter((t) => t.status === 'paused').map((t) => t.id))
        }
        // No setRestoreCount here: `pausedTabCount` derives from `tabs` above,
        // so the `setTabs(back)` on the line above already gives it its
        // opening value once this render commits.
        /*
         * A paused tab has no live watcher, so `contexts[sessionId]` stays
         * undefined and its ring would draw the empty "not read yet" track —
         * indistinguishable from a brand-new tab that has never had a turn.
         * Seed one from what was actually saved (`toStored` only persists
         * `{ tokens, limit }`, gotcha-33-adjacent: it is deliberately not the
         * whole ContextSnapshot).
         *
         * Every required field gets a real value, not a placeholder cast:
         *  - sessionId/contextTokens/contextLimit/model/title come straight
         *    from the stored tab.
         *  - permissionMode is the tab's own restored mode, not a hardcoded
         *    'default' — the "keep the permission mode live" effect above
         *    copies `contexts[t.sessionId].permissionMode` back onto the tab
         *    whenever it differs from `t.permissionMode`, so seeding the
         *    wrong constant here would silently overwrite a restored
         *    bypass-mode tab back to default the instant this runs.
         *  - updatedAt uses `lastActiveAt`, the real moment this snapshot was
         *    taken before quitting, rather than `Date.now()` here, which
         *    would claim the reading is as fresh as the current boot.
         *  - ready is true: the field's contract is "the session file exists
         *    on disk" (context.ts), which is true for a completed prior
         *    session — that is a separate question from *liveness*, which is
         *    what the new `paused` flag on ContextRing now carries instead.
         *  - inputTokens/cacheReadTokens/cacheCreationTokens/outputTokens/
         *    messageCount have no restorable value — `toStored` never saved
         *    a breakdown, only the total. Zero mirrors context.ts's own
         *    `emptySnapshot()` convention for "not currently known" and,
         *    like that function's callers, is never read by the ring or the
         *    tab strip (Task 7's actual scope). The status bar's message
         *    count would have shown these zeros for a paused active tab, but
         *    d2d1337 gave StatusBar its own paused-awareness and suppresses
         *    the message count there instead of stating a false zero.
         */
        setContexts((prev) => {
          const next = { ...prev }
          state.tabs.forEach((s) => {
            if (s.sessionId && s.context) {
              next[s.sessionId] = {
                sessionId: s.sessionId,
                contextTokens: s.context.tokens,
                contextLimit: s.context.limit,
                inputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                model: s.model || null,
                messageCount: 0,
                title: s.title || null,
                updatedAt: s.lastActiveAt,
                ready: true,
                permissionMode: s.permissionMode
              }
            }
          })
          return next
        })
      })
      .catch(() => {})
      // Runs whether the round trip resolved or rejected. A rejection with no
      // `.finally` would leave `restoreSettled` false forever and the
      // `startOnLaunch` effect below would never be allowed to fire.
      .finally(() => setRestoreSettled(true))
  }, [])

  /* ------------------------------------------------- `stoke …` from a shell */

  /*
   * A (cli, folder) a `stoke` request is starting a session in, claimed before
   * the first await and held until that session's TAB is in the list — not
   * merely until `startSession` resolves. Gotcha 51's shape one step further
   * on: `startSession` puts the tab into state, and `tabsRef` only sees it on
   * the next render, so a second `stoke .` landing in between would find no
   * running tab, find no claim, and start a twin `claude` in the same folder.
   * The effect below lets a claim go once its tab shows up.
   */
  const launchClaims = useRef<Set<string>>(new Set())
  const launchKey = useCallback(
    (cli: CodingCliId, cwd: string): string => `${cli}\n${pathKey(cwd, pathRulesFor(platform))}`,
    [platform]
  )
  useEffect(() => {
    if (!launchClaims.current.size) return
    for (const t of tabs) {
      if (t.kind === 'session' && t.status === 'running' && !t.hostId) {
        launchClaims.current.delete(launchKey(t.cliId, t.cwd))
      }
    }
  }, [tabs, launchKey])

  /**
   * One request from `stoke`, already checked by main (the folder exists; the
   * words parsed). Rebuilt every render and called through `launchRef`, because
   * the listener that calls it is bound once (gotcha 31).
   */
  const handleLaunch = async (req: StokeCliRequest): Promise<void> => {
    if (req.kind === 'focus') return
    if (req.kind === 'error') {
      setError(req.message)
      return
    }
    if (req.kind === 'update') {
      // Brings the panel up and asks; installing stays the button's job.
      openSettings('updates')
      void window.stoke.self.check()
      return
    }
    const rules = pathRulesFor(platform)
    const key = pathKey(req.cwd, rules)
    // The sidebar's own spelling of the folder when it has one: on APFS
    // `~/Dev/foo` and `~/dev/foo` are one folder, and the launcher selects
    // by the path string it listed.
    const project = projects.find((p) => pathKey(p.path, rules) === key)
    const cwd = project?.path ?? req.cwd

    if (req.kind === 'open') {
      /*
       * `selectInNewTab`, with the tab list read through the refs and written
       * back to them at once. Its closure's `activeNewTabId` is a render old,
       * so two `stoke --open` in one tick would each append a New tab; this way
       * the second finds the one the first made, and selects in it.
       */
      const cur = tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      let tabId = cur?.kind === 'new' ? cur.id : null
      if (!tabId) {
        const t = newTab(cwd)
        tabsRef.current = [...tabsRef.current, t]
        activeTabIdRef.current = t.id
        setTabs((list) => [...list, t])
        setActiveTabId(t.id)
        tabId = t.id
      }
      selectProject(cwd, tabId)
      void refreshProjects()
      return
    }

    const claim = launchKey(req.cli, cwd)
    if (req.launch !== 'new') {
      // RUNNING only, as `resumeSession` decides: a paused or ended tab in the
      // same folder has its own Resume, and focusing it would look like a
      // press that did nothing.
      const open = tabsRef.current.find(
        (t) =>
          t.kind === 'session' &&
          t.status === 'running' &&
          !t.hostId &&
          t.cliId === req.cli &&
          pathKey(t.cwd, rules) === key
      )
      if (open) {
        activeTabIdRef.current = open.id
        setActiveTabId(open.id)
        return
      }
      if (launchClaims.current.has(claim)) return
      launchClaims.current.add(claim)
    }
    // A New tab in front is consumed, as every launcher start consumes it.
    const front = tabsRef.current.find((t) => t.id === activeTabIdRef.current)
    const ok = await startSession({
      cwd,
      cli: req.cli,
      name: project?.label ?? project?.name ?? baseName(cwd),
      continueLast: req.launch === 'continue',
      replaceTabId: front?.kind === 'new' ? front.id : undefined
    })
    // `startSession` has set the error already; the claim must not outlive it.
    if (!ok) launchClaims.current.delete(claim)
    void refreshProjects()
  }
  const launchRef = useRef(handleLaunch)
  launchRef.current = handleLaunch

  // Bound once, from the start: main pushes only after `pending()` below has
  // told it this renderer is ready, so nothing can arrive early.
  useEffect(() => window.stoke.launch.onRequest((req) => void launchRef.current(req)), [])

  /*
   * The queue main held while this window loaded — on a cold start from
   * `stoke .`, the reason the window exists at all. Asked for ONCE, and only
   * after the tab restore has settled (gotcha 35): the restore replaces the
   * whole tab list, so a session started before it lands would be wiped out
   * from under the request that opened it. Settings too, because a session
   * launches with the saved defaults.
   */
  const [launchSettled, setLaunchSettled] = useState(false)
  const launchAsked = useRef(false)
  useEffect(() => {
    if (!restoreSettled || !settings || launchAsked.current) return
    launchAsked.current = true
    window.stoke.launch
      .pending()
      .then(
        (reqs) => {
          // A launch that came with a folder is not one for "start a session on
          // launch" to add a second session to.
          if (reqs.some((r) => r.kind === 'session' || r.kind === 'open')) autoStarted.current = true
          for (const r of reqs) void launchRef.current(r)
        },
        () => {}
      )
      .finally(() => setLaunchSettled(true))
  }, [restoreSettled, settings])

  /*
   * Resume the restored tabs after an update restart — one at a time, each
   * through the same `resumeTabFor` (and so the same `claimStart` guard) a
   * press of Resume uses, so a click landing mid-way cannot start a second
   * `claude` for a tab this is already starting. Sequential rather than all at
   * once: every one is a `claude --resume` loading a transcript and its MCP
   * servers, and a dozen at once is a stampede on the machine that has just
   * restarted. Waits for settings, which an SSH tab needs to find its host.
   * The ref keeps it to one run, StrictMode included.
   */
  const [autoResume, setAutoResume] = useState<string[] | null>(null)
  const autoResumed = useRef(false)
  useEffect(() => {
    if (!autoResume || autoResumed.current || !settings) return
    autoResumed.current = true
    void (async () => {
      for (const id of autoResume) {
        const tab = tabsRef.current.find((t) => t.id === id && t.status === 'paused')
        if (!tab) continue
        const go = resumeTabForRef.current(tab, false)
        if (go) await go()
      }
    })()
  }, [autoResume, settings])

  // Optional "open straight into a session" behaviour. The ref keeps it to a
  // single attempt, including under StrictMode's double-invoked effects.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current) return
    // The boot restore has to have actually settled before this may fire at
    // all. `restoreCount` is 0 both while the restore is still in flight and
    // once it has resolved with nothing to restore, so gating on it alone —
    // even as a dependency — does not stop this effect from running during
    // the window before the IPC round trip comes back: if `startOnLaunch`,
    // `defaultCwd` and `cli?.ok` all become true first, `restoreCount > 0`
    // reads false (not yet populated), the guard below passes, and
    // `autoStarted.current` latches — so when the restore *does* land moments
    // later this effect re-runs but exits immediately on the ref, unable to
    // undo the session it already started. `restoreSettled` closes that
    // window structurally: it is set only from the restore promise's
    // `.finally` (see above), so this effect cannot pass this line until the
    // restore has resolved (with or without tabs) or rejected, by which point
    // `restoreCount` already carries its final value.
    if (!restoreSettled) return
    // And after the `stoke` queue has been read, which may veto it the same way.
    if (!launchSettled) return
    if (!settings?.startOnLaunch || !defaultCwd || !cli?.ok) return
    // Restored tabs are what the user had; opening a session on top of them is
    // an extra nobody asked for — whether they are still paused or have been
    // resumed already (see `restoredSessions`).
    if (restoreCount > 0 || restoredSessions.current) return
    autoStarted.current = true
    startDefault()
  }, [restoreSettled, launchSettled, settings?.startOnLaunch, defaultCwd, cli, startDefault, restoreCount])

  /**
   * Append a New Project tab and select it.
   *
   * Several may be open at once, which is the point: each one carries its own
   * project selection, so two launchers can be aimed at two different folders
   * while a third terminal keeps running. It inherits the sidebar's current
   * selection so pressing + does not throw away what is on screen.
   */
  const openNewTab = useCallback((): void => {
    const tab = newTab(browsePath, browseExpanded)
    setTabs((list) => [...list, tab])
    setActiveTabId(tab.id)
  }, [browsePath, browseExpanded])

  const reorderTab = useCallback((dragId: string, overId: string): void => {
    // Once per drag, on release (`useTabDrag`). Only the strip's own nodes
    // move: the terminal panes render in `paneOrder`, which a reorder cannot
    // change, so no xterm is moved, remounted or blurred by it.
    setTabs((list) => moveTab(list, dragId, overId))
  }, [])

  /*
   * Closing several tabs inside one frame used to close ONE of them.
   *
   * Every call read `tabs` as the last render left it, so five clicks in a tick
   * each computed "the whole list minus my own tab" from the same starting
   * list, and the last `setTabs` won — four closes silently discarded, with the
   * processes behind them already killed. Measured over CDP: five close buttons
   * clicked in one expression left five tabs standing, one of them pointing at
   * a `claude` that had been terminated.
   *
   * The fix is the ref pair this file already keeps for the keydown listener,
   * written here as well as on render, so a second call in the same tick reads
   * what the first one decided. That is gotcha 20's shape — claim before the
   * act, not after — and it is why this no longer depends on `tabs` at all,
   * which also stops the window keydown listener rebuilding on every tab
   * change. `cycleTab`'s functional-updater fix is the same bug one commit
   * earlier; a stepping or filtering handler cannot read render-time state.
   */
  /**
   * Forget everything keyed by a session id that has gone away.
   *
   * The mirror of `dropRestoredScreen` for the three maps that are keyed by
   * session rather than by tab. One helper so a fourth such map cannot be added
   * and pruned in only two of the three places.
   */
  const dropSessionState = useCallback((sessionId: string): void => {
    const without = <T,>(cur: Record<string, T>): Record<string, T> => {
      if (!(sessionId in cur)) return cur
      const next = { ...cur }
      delete next[sessionId]
      return next
    }
    setContexts(without)
    setActivity(without)
    setSessionLine(without)
  }, [])

  const closeTab = useCallback(
    (id: string): void => {
      const list = tabsRef.current
      const tab = list.find((t) => t.id === id)
      if (!tab) return
      // A paused tab has no process — `ptyId` is '' — so there is nothing for
      // `pty.kill` to do. `PtySessions.kill('')` is already a harmless no-op
      // today (pty.ts:331-333); this guard is defensive, not a fix for a
      // crash, and just keeps a nonsense call from being made at all.
      if (tab.kind === 'session' && tab.status !== 'paused') {
        window.stoke.pty.kill(tab.ptyId)
        forgetPty(tab.ptyId)
      }
      dropRestoredScreen(id)
      /*
       * The three session-keyed maps are pruned with it.
       *
       * `restoredScreens` had this from the start and the others did not, so
       * `contexts`, `activity` and `sessionLine` accumulated one entry per
       * session for the life of the run — every tab ever opened and closed,
       * every relaunch (which mints a new id), every resumed conversation. Not
       * large individually, but they are also the maps three components iterate
       * on every render, so the cost is not only memory.
       *
       * Keyed on the session id rather than the tab id, which is what put them
       * out of reach of the tab-shaped cleanup that already existed.
       */
      if (tab.sessionId) dropSessionState(tab.sessionId)
      // Keyed by pty rather than session, so pruned here rather than there. A
      // relaunch waiting on this tab goes with it — it has nothing to relaunch.
      if (tab.ptyId) {
        const ptyId = tab.ptyId
        setLive((cur) => {
          if (!(ptyId in cur)) return cur
          const next = { ...cur }
          delete next[ptyId]
          return next
        })
      }
      if (pendingRef.current.delete(id)) syncPending()
      // Never leave the strip empty: closing the last tab lands on a fresh New
      // Project tab, which is where the app starts anyway.
      const next = list.filter((t) => t.id !== id)
      const replacement = next.length ? next : [newTab()]
      tabsRef.current = replacement
      setTabs(replacement)
      if (activeTabIdRef.current === id) {
        const nextId = next.length ? neighbourOf(list.map((t) => t.id), id) : replacement[0].id
        activeTabIdRef.current = nextId
        setActiveTabId(nextId)
      }
    },
    [dropRestoredScreen, dropSessionState, syncPending]
  )

  /**
   * The one guarded door to `closeTab` — Cmd+W, every tab's × button, and the
   * paused/exited-tab "Close tab" buttons all call this, never `closeTab`
   * directly, so none of them can bypass the check (gotcha 90).
   *
   * `closeTab` sends `pty.kill`, which is the same SIGHUP a relaunch sends
   * (gotcha 82), and mid-turn that loses the turn exactly the same way: no
   * `Stop` hook fires, the reply being streamed is never persisted, and a
   * later Resume opens on "Interrupted". Only a STATED busy/shell/waiting
   * (`live[...].busy === true`, the same threshold `relaunchPlan` reads) asks
   * first — an idle or exited tab, a paused one (no process to kill), and a
   * tab with no registry reading at all close at once, as they always did.
   * "No reading" covers a non-Claude CLI (the registry is Claude Code's own
   * file, gotcha 80; `registryTargets` never lists another CLI's pty) and the
   * half-second before Claude's first write — asking about every non-Claude
   * tab forever would be a worse cost than the rare miss, and matches what
   * the relaunch pill already does with an unknown reading.
   */
  const requestCloseTab = useCallback(
    (id: string): void => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      if (
        tab.kind === 'session' &&
        tab.status === 'running' &&
        liveRef.current[tab.ptyId]?.busy === true
      ) {
        setBusyPrompt({ kind: 'close', tabId: id })
        return
      }
      closeTab(id)
    },
    [closeTab]
  )

  /**
   * "Start again", on the bar a session leaves behind when it exits.
   *
   * Three things were wrong with this, and the first one made the button
   * actively misleading on a remote tab.
   *
   * **A host tab has to restart over SSH, not locally.** This read
   * `startSession({ cwd: tab.cwd })` unconditionally, and `startHostSession`
   * records `cwd: host.alias` — the alias, not a path, because an SSH session's
   * real working directory is on the far machine (gotcha 18). So pressing Start
   * again on a dropped VPS session launched a *local* `claude` in a folder
   * named `vps`, which does not exist. Measured against a host alias that
   * cannot resolve: ssh exited 255, Start again produced a second tab that
   * exited 1 with an empty terminal, and the status bar still named the alias
   * as the working directory. `resumeTabFor` already branches on `hostId`
   * correctly — this is the same branch, which it simply never had.
   *
   * **The tab's own mode/model/effort, not the toolbar's current globals.**
   * Exactly the bug `resumeTabFor` was fixed for: a tab showing `default` must
   * not come back in bypass because a global was switched since it started.
   *
   * **Replace in place rather than close-then-append.** `closeTab` dropped the
   * tab before the new session was known to have started, so a failure lost the
   * tab entirely and a success moved it to the end of the strip. The dead PTY
   * still has to be released, which `forgetPty` does — that is the only part of
   * `closeTab` a restart actually wanted.
   */
  const restartTab = useCallback(
    (tab: Tab): void => {
      /*
       * Claimed before `forgetPty`, which is the irreversible part — gotcha
       * 20's rule that the claim precedes the act rather than the await.
       *
       * "Start again" sits on a card that has just said the session ended, so a
       * second press while the first is still starting is the ordinary
       * impatience this whole class of bug comes from; without the claim it
       * appended a second tab and a second process, exactly as gotcha 51
       * measured for the relaunch pill.
       */
      if (!claimStart(tab.id)) return
      if (tab.kind === 'session' && tab.ptyId) forgetPty(tab.ptyId)

      const hosts = settings?.hosts ?? []
      const plan = restartPlan(tab, hosts.map((h) => h.id))

      if (plan.kind === 'impossible') {
        setError(plan.reason)
        releaseStart(tab.id)
        return
      }

      if (plan.kind === 'host') {
        const host = hosts.find((h) => h.id === plan.hostId)
        if (!host) {
          releaseStart(tab.id)
          return
        }
        void startHostSession(host, tab.id, {
          permissionMode: tab.permissionMode,
          model: tab.model,
          effort: tab.effort
        }).finally(() => releaseStart(tab.id))
        return
      }

      if (plan.kind === 'install') {
        void startSession({
          cwd: defaultCwd,
          name: tab.projectName,
          title: tab.title,
          cli: plan.ids[0],
          install: plan.ids,
          replaceTabId: tab.id
        }).finally(() => releaseStart(tab.id))
        return
      }

      void startSession({
        cwd: plan.cwd,
        // From the plan, not from the tab, so there is one decision and one
        // place it is made.
        cli: plan.cli,
        name: tab.projectName,
        replaceTabId: tab.id,
        permissionMode: tab.permissionMode,
        model: tab.model,
        effort: tab.effort,
        ultracode: tab.ultracode
      }).finally(() => releaseStart(tab.id))
    },
    [settings, startSession, startHostSession, claimStart, releaseStart, defaultCwd]
  )

  /**
   * Move this session onto the installed `claude`, keeping the conversation.
   *
   * The same two steps `resumeTabFor` performs for a tab restored from the last
   * run — stop, then start again with `--resume <id>` in the same tab slot —
   * with the kill added, because here the process is still alive. Nothing about
   * the conversation lives in the process: it is on disk in the transcript, and
   * `--resume` replays it, which is why this reads as a refresh rather than a
   * restart from the user's side.
   *
   * The id is the PLAN's, which is the session the process is on now (the
   * CLI's registry) — not necessarily the one the tab was launched with. A
   * `/clear` moves it; relaunching the launch id resumed the pre-`/clear`
   * conversation, or exited 1 when that id had no transcript. And the old
   * process is WAITED for, capped, before the new one starts: `claude` takes
   * ~0.9s to die after SIGHUP, and for that long two processes held one
   * transcript. Gotcha 73's file ownership still covers a process that outlives
   * the cap.
   *
   * `forgetPty` before the kill, not after, and never `closeTab`: the exit that
   * follows must not reach the tab, or the strip would show "Session ended"
   * for the instant between the two calls (the exit sink also checks
   * `relaunchingRef`, for an effect that re-attaches in between). That is the
   * same reason `restartTab` above releases the pty by hand rather than closing
   * the tab.
   *
   * The tab's own stored mode/model/effort/ultracode, not the toolbar's
   * current globals, for the reason the paused-resume path gives: what comes
   * back has to be the session that was there, not one wearing whatever is
   * selected right now. Ultracode used to be missing from this list, so a
   * relaunch fell back to the global.
   *
   * No busy check here: that is `requestRelaunch`'s job, and this is what it
   * calls once the question is settled.
   */
  const relaunchTab = useCallback(
    (tab: Tab, plan: RelaunchOffer): Promise<boolean> => {
      // Claimed before anything irreversible, which is the half of gotcha 20
      // that is easy to get wrong: the kill below cannot be taken back, so the
      // guard has to be in place before it, not after the await that follows.
      if (relaunchingRef.current.has(tab.id)) return Promise.resolve(false)
      relaunchingRef.current.add(tab.id)
      setRelaunching([...relaunchingRef.current])

      const oldPty = tab.ptyId
      forgetPty(oldPty)
      /*
       * Forget the version this session reported, because the session that
       * reported it is the one being killed.
       *
       * A relaunch reuses the session id, and `relaunchPlan` reads the version
       * out of `sessionLine[sessionId]` — so the old reading survived the
       * relaunch and the pill lit again, offering an update to the binary the
       * new process had just been started on. It cleared itself seconds later
       * when the first statusLine payload arrived, which made it look like a
       * flicker rather than a wrong answer. Cleared, `relaunchPlan` returns
       * "has not reported its version yet", which is both true and quiet. The
       * registry reading is keyed by the OLD pty, so it cannot be mistaken for
       * the new process's; it is dropped all the same.
       */
      setSessionLine((cur) => {
        if (!(plan.sessionId in cur)) return cur
        const next = { ...cur }
        delete next[plan.sessionId]
        return next
      })
      setLive((cur) => {
        if (!(oldPty in cur)) return cur
        const next = { ...cur }
        delete next[oldPty]
        return next
      })
      return (async (): Promise<boolean> => {
        try {
          await window.stoke.pty.stop(oldPty, RELAUNCH_EXIT_CAP_MS)
        } catch {
          /* the process is gone either way; start the replacement */
        }
        // Its exit re-created the entry `forgetPty` released.
        forgetPty(oldPty)
        return startSession({
          cwd: tab.cwd,
          cli: tab.cliId,
          name: tab.projectName,
          title: tab.title,
          sessionId: plan.sessionId,
          // What the renderer believes; main checks the disk and has the last
          // word (`resumeOrMint`), because `--resume` on an id with no
          // transcript exits 1 and `--session-id` on one with a transcript is
          // refused.
          resume: !plan.fresh,
          replaceTabId: tab.id,
          permissionMode: tab.permissionMode,
          model: tab.model,
          effort: tab.effort,
          ultracode: tab.ultracode,
          // Follows only if this tab was the one in front: a background
          // relaunch must not pull the selection away from what you are doing.
          focus: false
        })
      })()
        // Released on failure as well as success. `startSession` catches its
        // own errors and resolves false, so a refused launch would otherwise
        // leave the pill saying "relaunching…" for the rest of the run with no
        // way back — and the session it killed is already gone.
        .finally(() => {
          relaunchingRef.current.delete(tab.id)
          setRelaunching([...relaunchingRef.current])
        })
    },
    [startSession]
  )

  /**
   * The relaunch plan for any tab — not only the one in front, because the
   * automatic relaunch and a pending Wait both act on background tabs.
   */
  const planFor = useCallback(
    (tab: Tab | null): RelaunchPlan =>
      relaunchPlan({
        tab: tab && tab.kind === 'session' ? tab : null,
        running: tab ? (sessionLine[tab.sessionId]?.cliVersion ?? null) : null,
        installed: cli?.version ?? null,
        live: tab ? (live[tab.ptyId] ?? null) : null,
        // The context watcher found a file, or published its empty "not yet"
        // snapshot; no reading at all is "cannot say".
        hasTranscript: (id) => (contexts[id] ? contexts[id].ready : null)
      }),
    [sessionLine, cli, live, contexts]
  )
  const planForRef = useRef(planFor)
  planForRef.current = planFor

  /**
   * What the relaunch pill does: relaunch now, or ask first when a turn is
   * running.
   *
   * A relaunch kills the process, and killing it mid-turn loses the turn —
   * SIGHUP fires no `Stop`, the reply being streamed is never written, and the
   * resumed session opens on "Interrupted · What should Claude do instead?".
   * Measured: that is exactly what the pill did before this, with no check at
   * all. Only a stated busy asks; an unknown (no registry reading) relaunches
   * as it always has.
   */
  const requestRelaunch = useCallback(
    (tab: Tab): void => {
      const plan = planForRef.current(tab)
      if (plan.kind !== 'offer') return
      if (pendingRef.current.has(tab.id) || relaunchingRef.current.has(tab.id)) return
      if (plan.busy === true) {
        setBusyPrompt({ kind: 'relaunch', tabId: tab.id })
        return
      }
      void relaunchTab(tab, plan)
    },
    [relaunchTab]
  )

  /** Drop a relaunch that was waiting for idle. */
  const cancelPendingRelaunch = useCallback(
    (tabId: string): void => {
      if (pendingRef.current.delete(tabId)) syncPending()
    },
    [syncPending]
  )

  /*
   * Relaunches waiting for idle, fired the moment their turn ends.
   *
   * Re-evaluated whenever a registry reading, the tab list or the selection
   * moves. `pendingRelaunchStep` decides; the entry is taken out of the ref
   * BEFORE `relaunchTab` is called, so a re-render in between cannot fire it
   * twice (gotcha 51). A tab that exited or closed is dropped, not kept for
   * later: a relaunch that outlives its reason would kill a session nobody
   * asked to have killed.
   */
  useEffect(() => {
    if (!pendingRef.current.size) return
    let changed = false
    for (const [tabId, origin] of [...pendingRef.current]) {
      const tab = tabs.find((t) => t.id === tabId) ?? null
      const plan = planFor(tab)
      const step = pendingRelaunchStep({
        origin,
        plan,
        inFront: tabId === activeTabId,
        typedSinceSubmit: tab ? typedSinceSubmit(tab.ptyId) : false
      })
      if (step === 'wait') continue
      pendingRef.current.delete(tabId)
      changed = true
      if (step === 'fire' && tab && plan.kind === 'offer') void relaunchTab(tab, plan)
    }
    if (changed) syncPending()
  }, [tabs, activeTabId, planFor, relaunchTab, syncPending])

  /*
   * `Settings.cliRelaunch: 'auto'`: once a newer `claude` is installed, move
   * the background sessions onto it without being asked — now if idle, queued
   * until idle if not. Level-triggered off the plan rather than edge-triggered
   * off a version change, so a CLI updated by hand, by the six-hourly checker,
   * or before the setting was switched on are all the same case; the
   * one-attempt-per-session-per-version key is what stops a relaunch that comes
   * back on the old version from looping. `autoRelaunchStep` holds the rules.
   */
  const autoTriedRef = useRef<Set<string>>(new Set())
  const relaunchMode = settings?.cliRelaunch ?? 'ask'
  useEffect(() => {
    if (relaunchMode !== 'auto') return
    let queued = false
    for (const tab of tabs) {
      if (tab.kind !== 'session' || tab.status !== 'running') continue
      const plan = planFor(tab)
      const step = autoRelaunchStep({
        mode: relaunchMode,
        plan,
        inFront: tab.id === activeTabId,
        alreadyTried: plan.kind === 'offer' && autoTriedRef.current.has(autoRelaunchKey(plan)),
        pending: pendingRef.current.has(tab.id),
        relaunching: relaunchingRef.current.has(tab.id),
        typedSinceSubmit: typedSinceSubmit(tab.ptyId)
      })
      if (step === 'skip' || plan.kind !== 'offer') continue
      autoTriedRef.current.add(autoRelaunchKey(plan))
      if (step === 'relaunch') {
        void relaunchTab(tab, plan)
      } else {
        pendingRef.current.set(tab.id, 'auto')
        queued = true
      }
    }
    if (queued) syncPending()
  }, [relaunchMode, tabs, activeTabId, planFor, relaunchTab, syncPending])

  /*
   * Stoke's own "Restart and install", asked the same question.
   *
   * Restarting ends every session, so a turn running anywhere is lost the same
   * way a relaunch loses one. The tabs come back resumed afterwards (main
   * records the update restart; see `afterUpdate` above), so the only thing at
   * stake is what is mid-flight.
   */
  const installSelfUpdateNow = useCallback((): void => {
    // Claimed first: the effect below must not fire it a second time.
    selfRestartPendingRef.current = false
    setSelfRestartPending(false)
    void window.stoke.self.install().then((started) => {
      if (!started) setError('The update is not ready to install yet — try again once it has downloaded.')
    })
  }, [])

  const requestSelfRestart = useCallback((): void => {
    const busy = busyTabIds(tabsRef.current, liveRef.current)
    if (!busy.length) {
      installSelfUpdateNow()
      return
    }
    setBusyPrompt({ kind: 'restart', tabIds: busy })
  }, [installSelfUpdateNow])

  useEffect(() => {
    if (!selfRestartPendingRef.current) return
    if (busyTabIds(tabs, live).length) return
    installSelfUpdateNow()
  }, [tabs, live, installSelfUpdateNow])

  /** The busy dialog's three answers. */
  const answerBusy = useCallback(
    (answer: 'force' | 'wait' | 'cancel'): void => {
      const prompt = busyPromptRef.current
      setBusyPrompt(null)
      if (!prompt || answer === 'cancel') return
      if (prompt.kind === 'restart') {
        if (answer === 'force') {
          installSelfUpdateNow()
        } else {
          selfRestartPendingRef.current = true
          setSelfRestartPending(true)
        }
        return
      }
      if (prompt.kind === 'close') {
        // No Wait here (only 'force' or the 'cancel' handled above): closing
        // has nowhere to come back to the way a relaunch or a restart does,
        // and the session stays on the sidebar to resume later regardless.
        if (answer === 'force') closeTab(prompt.tabId)
        return
      }
      const tab = tabsRef.current.find((t) => t.id === prompt.tabId)
      if (!tab) return
      if (answer === 'force') {
        const plan = planForRef.current(tab)
        if (plan.kind === 'offer') void relaunchTab(tab, plan)
        return
      }
      if (pendingRef.current.has(tab.id)) return
      pendingRef.current.set(tab.id, 'user')
      syncPending()
    },
    [installSelfUpdateNow, relaunchTab, syncPending, closeTab]
  )

  /* --------------------------------------------------------------- browser */

  // The busy dialog and the agent picker are overlays like the other two: the
  // docked browser has to come off the window while one is up, or it paints
  // over it (gotcha 14).
  const overlayOpen = paletteOpen || settingsOpen || agentPickerOpen || busyPrompt !== null
  const seededBrowser = useRef(false)

  useEffect(() => {
    refreshAgents()
  }, [refreshAgents])

  /*
   * The launcher's agent row: what the picker chose, installed, and not Claude
   * — Claude Code is not an "other agent", it is what every other control on
   * the launcher already means. Before the picker has been answered, every
   * installed agent, which is exactly what the row showed before it existed.
   */
  const otherClis = useMemo(() => {
    const installed = new Set(agentDetection?.clis.filter((c) => c.path).map((c) => c.id) ?? [])
    return visibleAgents(settings?.agents.chosen ?? null, installed)
      .filter((id) => !isClaudeCode(id))
      .map((id) => cliFor(id))
  }, [agentDetection, settings?.agents.chosen])

  /*
   * Ask once. A launch whose settings have never answered the picker opens it
   * as soon as the campfire is out of the way and detection has landed — after,
   * so the picker can pre-tick what is installed rather than flash empty. The
   * ref makes it once per launch even if the user closes it without choosing.
   */
  const pickerAsked = useRef(false)
  useEffect(() => {
    if (pickerAsked.current || !settings || welcome || !agentDetection) return
    if (settings.agents.chosen !== null) return
    pickerAsked.current = true
    setAgentPickerOpen(true)
  }, [settings, welcome, agentDetection])

  /** Open a tab that installs these agents, from the vendors' own commands. */
  const installAgents = useCallback(
    (ids: CodingCliId[]): void => {
      if (!ids.length) return
      const labels = ids.map((id) => cliFor(id).label).join(', ')
      void startSession({
        cwd: defaultCwd,
        name: 'Install agents',
        title: `Installing ${labels}`,
        cli: ids[0],
        install: ids
      })
    },
    [startSession, defaultCwd]
  )

  // The WebContentsView paints above the DOM, so it must be detached while a
  // palette or settings sheet is open or it would cover them.
  useEffect(() => {
    if (!settings) return
    if (browserOpen && !overlayOpen) {
      if (seededBrowser.current) {
        window.stoke.browser.show()
      } else {
        seededBrowser.current = true
        window.stoke.browser.show(settings.browser.lastUrl || settings.browser.homepage)
      }
    } else {
      window.stoke.browser.hide()
    }
  }, [browserOpen, overlayOpen, settings])

  // Remember the last page, so reopening the panel returns you to it.
  useEffect(() => {
    if (!settings) return
    const url = browserState.url
    if (!url || url === 'about:blank' || settings.browser.lastUrl === url) return
    const id = window.setTimeout(() => {
      void patchSettings({ browser: { ...settings.browser, lastUrl: url } })
    }, 1500)
    return () => window.clearTimeout(id)
  }, [browserState.url, settings, patchSettings])

  const openUrl = useCallback((url: string): void => {
    /*
     * Claim the seed here, not only in the effect below.
     *
     * `setBrowserOpen(true)` runs that effect, and on the first open of a run
     * it took the `else` branch and called `browser.show(lastUrl || homepage)`
     * — AFTER the `show(url)` on the next line, so the homepage won. The first
     * terminal link anyone clicked in a session opened the wrong page, every
     * run, and the second one worked, which is exactly the shape that gets
     * written off as a misclick.
     */
    seededBrowser.current = true
    setBrowserOpen(true)
    window.stoke.browser.show(url)
  }, [])

  /**
   * Hand the current page to the running session by typing an opening line into
   * its prompt — deliberately unfinished, so the question is still the user's.
   */
  const askClaude = useCallback(
    (url: string, title: string): void => {
      /*
       * Running only. An exited tab still has a `ptyId` and still matches
       * `kind === 'session'`, so Ask Claude would write the opening line into a
       * process that is not there — accepted silently by `pty.write`, which
       * no-ops on an unknown id. Nothing appeared anywhere and the browser
       * button read as broken.
       */
      const live = tabs.filter((t) => t.kind === 'session' && t.status === 'running')
      const target = live.find((t) => t.id === activeTabId) ?? live[live.length - 1]
      if (!target) {
        setError('Start a session first — then Ask Claude types the page into its prompt.')
        return
      }
      const label = title ? `"${title}" (${url})` : url
      const line = `Using the stoke browser tools, look at the page open in the browser — ${label} — and `
      // Deliberately unsent, so it IS a draft: noted, so an automatic relaunch
      // leaves this tab alone until it is submitted.
      noteInput(target.ptyId, line)
      window.stoke.pty.write(target.ptyId, line)
      setActiveTabId(target.id)
    },
    [tabs, activeTabId]
  )

  /* ------------------------------------------------------------- shortcuts */

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  /*
   * Read by the window keydown listener, which is bound once and must not be
   * rebound per keystroke (gotcha 31: a listener reads changing values through
   * a ref, never through its deps). Both are assigned during render, so the
   * listener always sees the frame the user is looking at.
   *
   * The target is null unless there is a RUNNING session tab in front — a
   * paused or exited tab has no pty, and an unclaimed keystroke must not
   * quietly start one or be swallowed on the New Project tab.
   */
  const overlayRef = useRef(false)
  overlayRef.current = overlayOpen
  const typeThroughTargetRef = useRef<string | null>(null)
  typeThroughTargetRef.current =
    activeTab && activeTab.kind === 'session' && activeTab.status === 'running'
      ? activeTab.ptyId
      : null

  /*
   * Whether the tab in front is running a `claude` that is no longer the one
   * installed. Every refusal is a stated reason rather than a silent false, so
   * the status bar can explain itself on hover instead of simply not being
   * there — which is what "why is there no button" looks like from outside.
   */
  const relaunch = useMemo(() => planFor(activeTab), [activeTab, planFor])

  /*
   * What the launcher offers when nothing is selected: pinned folders first,
   * then the ones used most recently. Six, because the point is to get back to
   * something you were in the middle of, not to duplicate the sidebar.
   */
  const recentProjects = useMemo(
    () =>
      [...projects]
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) || (b.lastModified ?? 0) - (a.lastModified ?? 0)
        )
        .slice(0, 6),
    [projects]
  )

  /* Memoised: a fresh array each render would rebuild the Sidebar's Set on every tick. */
  const openSessionIds = useMemo(() => tabs.map((t) => t.sessionId), [tabs])

  /*
   * The terminal panes, in an order a strip reorder cannot change.
   *
   * They used to render in strip order, so dragging the active tab rightwards
   * made React move that pane's DOM node — and a moved node loses focus, which
   * took the keyboard away from the session being typed into. Only one pane is
   * ever visible, so their order means nothing on screen. See `paneOrder`.
   */
  const panes = useMemo(() => paneOrder(tabs), [tabs])

  /*
   * Folders with a session running right now, for the sidebar's live dot.
   *
   * By cwd rather than by session id, because that is the question the row can
   * answer: a project row knows its path and nothing about which conversation
   * is open in it. SSH tabs are excluded — `cwd` on one of those is the host
   * alias, not a folder (gotcha 18), and matching it against a project path
   * would light up any local folder that happened to share the alias's name.
   */
  const runningPaths = useMemo(
    () =>
      tabs
        .filter((t) => t.kind === 'session' && t.status === 'running' && !t.hostId)
        .map((t) => t.cwd),
    [tabs]
  )
  const selectedProject = projects.find((p) => p.path === selectedPath) ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = matchShortcut(e, isMac)
      if (!action) {
        /*
          Nobody claimed this keystroke, so the terminal gets it.

          Without this, clicking anything in the chrome — the usage chip is how
          it was found, but the tab strip and the status bar are the same shape
          — leaves focus on a <button>, and everything typed afterwards is
          delivered correctly to an element that does nothing with it. The
          characters are not lost to a bug in the chip; they are lost to there
          being no rule about where an unclaimed keystroke goes.

          `typeThroughKey` decides, and refuses far more than it accepts (see
          it for the list). The one it produces is written straight to the pty,
          because focus moves asynchronously and this event will never reach
          xterm; the focus call is what makes the SECOND keystroke land without
          coming back through here.
        */
        const ptyId = typeThroughTargetRef.current
        const send = typeThroughKey(
          {
            key: e.key,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            altKey: e.altKey,
            target: e.target as HTMLElement | null
          },
          { overlayOpen: overlayRef.current, hasTerminal: ptyId !== null }
        )
        if (send === null || ptyId === null) return
        e.preventDefault()
        noteInput(ptyId, send)
        window.stoke.pty.write(ptyId, send)
        focusTerm(ptyId)
        return
      }
      e.preventDefault()
      switch (action.type) {
        case 'palette':
          setPaletteOpen((v) => !v)
          break
        case 'newTab':
          openNewTab()
          break
        case 'closeTab':
          if (activeTabId) requestCloseTab(activeTabId)
          break
        case 'toggleBrowser':
          setBrowserOpen((v) => !v)
          break
        case 'settings':
          setSettingsOpen((v) => !v)
          break
        case 'tab': {
          const target = tabs[action.index - 1]
          if (target) setActiveTabId(target.id)
          break
        }
        case 'cycleTab': {
          /*
           * The functional form, and not for tidiness. `activeTabId` in this
           * closure is whatever the last render committed, so two presses
           * inside one frame — a held key, or a fast double press — both
           * computed their step from the SAME starting tab and landed on the
           * same one. Measured over CDP: two next-tab events dispatched in one
           * tick moved the selection exactly one place. Reading the pending
           * value instead makes the second press start where the first left
           * off. Gotcha 51's shape, one layer down: state that has not
           * re-rendered yet is not the state you are in.
           */
          const ids = tabs.map((t) => t.id)
          setActiveTabId((cur) => cycleTab(ids, cur, action.delta) ?? cur)
          break
        }
        case 'zoom': {
          /*
           * Read through the ref, and off settings rather than local state: the
           * sizes live in settings, the Settings sheet writes the same two
           * values, and two writers on one number is how a slider and a
           * shortcut end up disagreeing about the current size.
           */
          const now = settingsRef.current
          if (!now) break
          void patchSettings(
            zoomStep(
              { uiScale: now.uiScale, fontSize: now.fontSize },
              action.direction,
              now.zoomTarget
            )
          )
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMac, tabs, activeTabId, requestCloseTab, openNewTab])

  /* ------------------------------------------------- first-run campfire */

  /*
   * Whether the splash plays is decided once, on the first render that has
   * settings, and never again for the life of the process.
   *
   * The ref is claimed BEFORE the `self.state()` await rather than after it
   * (gotcha 20): settings arrive as one state write and then change again on
   * every later patch, so without a claim ahead of the await two passes could
   * both read `welcomeSeenVersion` as null and both decide to play.
   */
  const welcomeDecided = useRef(false)
  const welcomeRef = useRef<WelcomeScreen | null>(null)
  useEffect(() => {
    if (!settings || welcomeDecided.current) return
    welcomeDecided.current = true
    void (async () => {
      /*
       * `self.state()` is a plain getter over `app.getVersion()` — it starts no
       * update check and touches no network. package.json's version is what an
       * unpackaged run reports, which is what makes this testable at all.
       */
      const version = (await window.stoke.self.state()).currentVersion
      const plan = welcomePlan(settings.welcomeSeenVersion, version)
      if (!plan.play) return
      const screen = { reason: plan.reason, version, record: plan.record }
      welcomeRef.current = screen
      setWelcome(screen)
    })()
  }, [settings])

  /*
   * Dismissal, from any of the three routes, at most once. The ref is cleared
   * first so a click that lands in the same tick as the auto-dismiss timer
   * cannot write the setting twice — gotcha 51's shape, smaller: state has not
   * re-rendered yet when the second call arrives.
   */
  const dismissWelcome = useCallback((): void => {
    const record = welcomeRef.current?.record ?? null
    if (!welcomeRef.current) return
    welcomeRef.current = null
    setWelcome(null)
    // Written on dismissal rather than on mount: a splash recorded as seen
    // before it finished would, if the app went away mid-animation, be a
    // screen nobody watched that can never be shown again. `store.ts` writes a
    // single discrete change straight through, so this is on disk at once.
    if (record) void patchSettings({ welcomeSeenVersion: record })
  }, [patchSettings])

  // Escape closes whichever overlay is on top.
  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      // The busy dialog can sit over the sheet ("Restart and install"), and
      // then Escape is its Cancel — not a second, unasked close of the sheet.
      if (busyPromptRef.current) return
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  /* ---------------------------------------------------------------- render */

  /**
   * Point a launcher at `path`: the New tab already in view when there is one,
   * a freshly appended New tab when there is not.
   *
   * Distinct from `selectProject`, and the distinction is not stylistic. A
   * sidebar click must NOT switch tabs — selecting a project cannot be allowed
   * to hide the terminal in front of you (spec §2.10). But the two gestures
   * that name a folder outright, Cmd+K's palette and Open a folder, are asking
   * to go there; moving a selection that nothing on screen is showing made both
   * of them look like they had failed. The palette was the worse of the two,
   * because it closes itself on pick: press Cmd+K over a running session, pick
   * a project, and the entire visible result was the palette disappearing.
   */
  const selectInNewTab = useCallback(
    (path: string): void => {
      let tabId = activeNewTabId
      if (!tabId) {
        const t = newTab(path)
        setTabs((list) => [...list, t])
        setActiveTabId(t.id)
        tabId = t.id
      }
      selectProject(path, tabId)
    },
    [activeNewTabId, selectProject]
  )

  const openFolder = useCallback(async (): Promise<void> => {
    const dir = await window.stoke.projects.open()
    if (!dir) return
    await refreshProjects()
    /*
     * "Open a folder" is one of a New tab's own launcher actions, alongside
     * Start here and Scratch session — like them, it fills the tab it was
     * invoked from instead of always spawning another beside it. Only when
     * there is no New tab in view (the sidebar's own Open Folder button while
     * a session tab is active) is a fresh one appended. `selectInNewTab` holds
     * both halves, including the reason the tab id is captured in a local
     * rather than re-read from `activeTabId`.
     */
    selectInNewTab(dir)
  }, [refreshProjects, selectInNewTab])

  const addRoot = useCallback(async (): Promise<void> => {
    const dir = await window.stoke.projects.addRoot()
    if (!dir) return
    const s = await window.stoke.settings.get()
    setSettings(s)
    await refreshProjects()
  }, [refreshProjects])

  /*
   * One writer each. The settings patch is the whole change now — there is no
   * local copy left to keep in step, which is what let the Sessions pane and
   * the launcher disagree about the same four values.
   */
  const changeMode = useCallback(
    (m: PermissionMode): void => {
      if (settings) void patchSettings({ defaults: { ...settings.defaults, permissionMode: m } })
    },
    [settings, patchSettings]
  )

  const changeModel = useCallback(
    (m: string): void => {
      if (settings) void patchSettings({ defaults: { ...settings.defaults, model: m } })
    },
    [settings, patchSettings]
  )

  const changeEffort = useCallback(
    (v: EffortLevel): void => {
      if (settings) void patchSettings({ defaults: { ...settings.defaults, effort: v } })
    },
    [settings, patchSettings]
  )

  const changeUltracode = useCallback(
    (v: boolean): void => {
      if (settings) void patchSettings({ defaults: { ...settings.defaults, ultracode: v } })
    },
    [settings, patchSettings]
  )

  /*
   * Takes the index entry's shape, which a full `SessionMeta` also satisfies:
   * a search hit and a row of an expanded list resume through this one path,
   * reading the same four fields, so the two cannot start different sessions.
   */
  const resumeSession = useCallback(
    (s: SessionIndexEntry): void => {
      /*
       * A conversation already open is focused, not started again.
       *
       * Nothing stopped a second tab being opened on the same session id, and
       * the two were not independent: `closeTab` prunes the session-keyed maps
       * with `dropSessionState(tab.sessionId)`, so closing EITHER twin wiped
       * the context ring, the activity dot and the version line of the one
       * still open. Two `claude` processes also then held the same transcript.
       *
       * Reachable from three places that cannot see each other — a search hit,
       * a row in an expanded project, and the command palette — so "I already
       * have that open" is not something the user can be expected to track.
       *
       * `running` only. A paused or exited tab on the same id has its own
       * answer already ("Resume session", "Start again"), and short-circuiting
       * those would turn a deliberate resume into a press that looks like it
       * did nothing.
       */
      const open = tabsRef.current.find(
        (t) => t.kind === 'session' && t.sessionId === s.id && t.status === 'running'
      )
      if (open) {
        setActiveTabId(open.id)
        return
      }
      const project = projects.find((p) => p.path === s.projectPath)
      void startSession({
        cwd: s.projectPath,
        name: project?.label ?? project?.name ?? s.projectPath,
        title: s.title ?? s.firstPrompt ?? undefined,
        sessionId: s.id,
        resume: true,
        replaceTabId: activeNewTabId ?? undefined
      })
    },
    [projects, startSession, activeNewTabId]
  )

  /*
   * The busy dialog's words. Built here rather than inside BusyDialog so the
   * component stays a plain question with three answers, and everything it
   * says about a tab is read from the same live state the decision was made on.
   */
  const busyDialog = ((): React.JSX.Element | null => {
    if (!busyPrompt) return null
    const quote = (t: Tab | undefined): string => `“${t?.title || t?.projectName || 'this tab'}”`
    if (busyPrompt.kind === 'relaunch') {
      const tab = tabs.find((t) => t.id === busyPrompt.tabId)
      const st = tab ? live[tab.ptyId] : undefined
      const plan = planFor(tab ?? null)
      const target = plan.kind === 'offer' ? plan.installed : 'the installed version'
      const doing =
        st?.status === 'waiting'
          ? `Claude is waiting for your answer${st.waitingFor ? ` (${st.waitingFor})` : ''}, in the middle of a turn.`
          : st?.status === 'shell'
            ? 'A shell command Claude started is still running.'
            : 'Claude is working on a reply.'
      return (
        <BusyDialog
          title={`A prompt is running in ${quote(tab)}`}
          forceLabel="Force restart"
          waitLabel="Wait"
          waitHint={`Relaunch on ${target} the moment this turn ends`}
          onForce={() => answerBusy('force')}
          onWait={() => answerBusy('wait')}
          onCancel={() => answerBusy('cancel')}
        >
          <p>{doing}</p>
          <p>
            Relaunching now stops it, and <strong>the turn in flight is lost</strong>: the reply so far
            is not saved, and the conversation comes back as it was after the last finished reply.
          </p>
          <p>
            <strong>Wait</strong> relaunches it on {target} the moment it goes idle.
          </p>
        </BusyDialog>
      )
    }
    if (busyPrompt.kind === 'close') {
      const tab = tabs.find((t) => t.id === busyPrompt.tabId)
      const st = tab ? live[tab.ptyId] : undefined
      const doing =
        st?.status === 'waiting'
          ? `Claude is waiting for your answer${st.waitingFor ? ` (${st.waitingFor})` : ''}, in the middle of a turn.`
          : st?.status === 'shell'
            ? 'A shell command Claude started is still running.'
            : 'Claude is working on a reply.'
      return (
        <BusyDialog
          title={`A prompt is running in ${quote(tab)}`}
          forceLabel="Close anyway"
          onForce={() => answerBusy('force')}
          onCancel={() => answerBusy('cancel')}
        >
          <p>{doing}</p>
          <p>
            Closing this tab now stops it, and <strong>the turn in flight is lost</strong>: the reply
            so far is not saved. The session itself is not deleted — it stays on the sidebar to
            resume later.
          </p>
        </BusyDialog>
      )
    }
    const busyTabs = busyPrompt.tabIds
      .map((id) => tabs.find((t) => t.id === id))
      .filter((t): t is Tab => !!t)
    return (
      <BusyDialog
        title={
          busyTabs.length === 1
            ? `A prompt is running in ${quote(busyTabs[0])}`
            : `Prompts are running in ${busyTabs.length} tabs`
        }
        forceLabel="Force restart"
        waitLabel="Wait"
        waitHint="Restart and install the moment every session is idle"
        onForce={() => answerBusy('force')}
        onWait={() => answerBusy('wait')}
        onCancel={() => answerBusy('cancel')}
      >
        <p>
          Restarting Stoke to install its update ends every session.{' '}
          {busyTabs.length > 1 && <>Still working: {busyTabs.map((t) => quote(t)).join(', ')}.</>}
        </p>
        <p>
          Restarting now loses <strong>the turns in flight</strong>. Every tab comes back resumed once
          Stoke is up again.
        </p>
        <p>
          <strong>Wait</strong> restarts the moment every session is idle.
        </p>
      </BusyDialog>
    )
  })()

  const worklogPending = worklog.filter((p) => p.status === 'pending').length
  const worklogState = useMemo(
    () => worklogButtonState(worklogWatch, worklogPending),
    [worklogWatch, worklogPending]
  )

  return (
    <div className="app">
      <TitleBar
        platform={platform}
        showBrand={settings?.showBrand !== false}
        maximized={maximized}
        fullScreen={fullScreen}
        tabs={tabs}
        activeTabId={activeTabId}
        contexts={contexts}
        activity={activity}
        watchedSessions={watchedSessions}
        sidebarOpen={sidebarOpen}
        browserOpen={browserOpen}
        onSelectTab={setActiveTabId}
        onCloseTab={requestCloseTab}
        onNewTab={openNewTab}
        onReorderTab={reorderTab}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleBrowser={() => setBrowserOpen((v) => !v)}
        worklogCount={worklogPending}
        worklogState={worklogState}
        worklogOpen={worklogOpen}
        onToggleWorklog={() => setWorklogOpen((v) => !v)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => openSettings()}
        onOpenPhoneSettings={() => openSettings('remote')}
      />

      <div className="body-row">
        {sidebarOpen && (
          <>
            <div style={{ width: sidebarWidth, display: 'flex', flexShrink: 0 }}>
              <Sidebar
                projects={projects}
                loading={projectsLoading}
                query={query}
                sessionIndex={sessionIndex}
                sessionIndexLoading={sessionIndexLoading}
                sessionIndexError={sessionIndexError}
                selectedPath={selectedPath}
                expandedPath={expandedPath}
                sessionsByPath={sessionsByPath}
                sessionsLoadingPath={sessionsLoadingPath}
                openSessionIds={openSessionIds}
                runningPaths={runningPaths}
                onQueryChange={setQuery}
                onSelectProject={(p) => selectProject(p.path)}
                onToggleExpand={(p) => {
                  selectProject(p.path)
                  toggleExpand(expandedPath === p.path ? null : p.path)
                }}
                onStartNew={(p) =>
                  void startSession({
                    cwd: p.path,
                    // The label, when the folder has one. It is what the user
                    // renamed this project to and what every list already
                    // shows; the tab strip was the one place still saying the
                    // basename, so a folder renamed "Client site" opened a tab
                    // called "www".
                    name: p.label ?? p.name,
                    replaceTabId: activeNewTabId ?? undefined
                  })
                }
                onResume={resumeSession}
                onPin={(p) => {
                  void window.stoke.projects.pin(p.path, !p.pinned).then(async (s) => {
                    setSettings(s)
                    await refreshProjects()
                  })
                }}
                onSetMeta={(p, meta) => {
                  void window.stoke.projects.setMeta(p.path, meta).then(async (s) => {
                    setSettings(s)
                    await refreshProjects()
                  })
                }}
                /*
                 * `projects.hide` was built end to end — IPC channel, main
                 * handler, preload method — and then never called from
                 * anywhere. So `hiddenProjects` could not be populated by any
                 * gesture, and the Settings block that offers to show hidden
                 * projects again renders only when the list is non-empty, which
                 * made it unreachable dead UI. This is the missing call site.
                 */
                onHide={(p) => {
                  void window.stoke.projects.hide(p.path, true).then(async (s) => {
                    setSettings(s)
                    await refreshProjects()
                  })
                }}
                onAddRoot={() => void addRoot()}
                onOpenFolder={() => void openFolder()}
                onStartScratch={() => void startScratch()}
                profiles={availableProfiles}
                activeProfile={activeProfile?.id ?? null}
                onSelectProfile={(id) => void patchSettings({ activeProfile: id })}
              />
            </div>
            <Resizer
              value={sidebarWidth}
              min={200}
              max={520}
              label="Resize sidebar"
              onChange={setSidebarWidth}
              onCommit={(v) => void patchSettings({ sidebarWidth: v })}
            />
          </>
        )}

        <div className="main-col">
          {error && (
            <div className="banner" role="alert">
              <span style={{ flex: 1 }}>{error}</span>
              <button className="btn" data-variant="ghost" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}

          {restoreCount > 0 && (
            <div className="restore-bar" role="status">
              <span className="restore-text">
                Restored {restoreCount} paused {restoreCount === 1 ? 'tab' : 'tabs'} from last
                time.
              </span>
              {/*
                Resume every one, from the bar that announces them.
                Each paused card already has its own Resume, which is right for
                picking one out of six and wrong for the common case — you left
                three sessions open and you want the three of them back. Doing
                that by hand means selecting each tab in turn, because a card
                only renders for the tab in front.

                `resumeTabFor` per tab, not one shared launch: each carries its
                own stored permission mode, model and effort, and each replaces
                its own tab by id, so they neither collide nor inherit today's
                toolbar globals.
              */}
              <button
                className="btn"
                data-variant="primary"
                onClick={() => {
                  // `focus: false` — with several starting at once the winner
                  // would otherwise be whichever PTY resolved last, which is a
                  // race deciding what you are looking at. See focusAfterStart.
                  /*
                   * One "latest session in this folder" per agent and folder.
                   * A continue-only CLI — or a Claude tab with no id — can only
                   * reach the newest session there, so two such tabs in one
                   * folder would both attach to the SAME session, two writers
                   * on one transcript (found by review). The first continues;
                   * the rest stay paused, each still resumable from its card.
                   */
                  const seen = new Set<string>()
                  tabs
                    .filter((t) => t.status === 'paused')
                    .forEach((t) => {
                      const latestOnly =
                        !t.hostId && (capsFor(t.cliId).resume === 'continue' || !t.sessionId)
                      if (latestOnly) {
                        const key = `${t.cliId}\0${t.cwd}`
                        if (seen.has(key)) return
                        seen.add(key)
                      }
                      resumeTabFor(t, false)?.()
                    })
                }}
                title="Start every restored tab again"
              >
                Resume all
              </button>
              <button
                className="btn"
                data-variant="ghost"
                onClick={() => {
                  /*
                   * Closes the RESTORED tabs, and only those.
                   *
                   * This button used to be "Start fresh" and killed every tab
                   * in the strip, live sessions included. The bar it sits in
                   * says "Restored N paused tabs from last time", so the one
                   * thing it names is the paused set — and resuming one of
                   * them, or starting anything new, while the bar was still up
                   * put a running `claude` in the blast radius of a button
                   * that never mentioned it. The tab you had just started was
                   * killed by a control offering to tidy up the old ones.
                   *
                   * A paused tab needs no kill: `ptyId` is '' and there is no
                   * process behind it. That is exactly why nothing is killed
                   * here any more — the tabs this touches never had one.
                   *
                   * Except for one that is mid-resume, which is why the
                   * in-flight set is consulted. `Resume all` sits immediately
                   * to the left of this button and its tabs stay `paused` for
                   * the couple of seconds their PTYs take to come up — so
                   * pressing both in sequence used to drop every tab, and then
                   * each `pty.start` resolved, found its `replaceTabId` gone
                   * and APPENDED. The tabs came back at the end of the strip
                   * with live processes behind them, and the close had killed
                   * nothing because a paused tab has no PTY to kill.
                   */
                  const keep = tabs.filter(
                    (t) => t.status !== 'paused' || startingRef.current.has(t.id)
                  )
                  const next = keep.length ? keep : [newTab()]
                  setTabs(next)
                  if (!next.some((t) => t.id === activeTabId)) setActiveTabId(next[0].id)
                  setRestoredScreens({})
                  setRestoreDismissed(true)
                }}
              >
                Close {restoreCount === 1 ? 'it' : 'them'}
              </button>
              <button
                className="icon-btn"
                onClick={() => setRestoreDismissed(true)}
                title="Dismiss"
              >
                <IconClose />
              </button>
            </div>
          )}

          {/*
            In the flow above the terminal, exactly like the error banner, and
            deliberately not floating. The docked browser is a native
            WebContentsView that paints over every pixel of renderer DOM — but
            its bounds are this row's *sibling* column, so anything inside
            `.main-col` stays visible with the browser open. An overlay would
            not.
          */}
          {/*
            Suppressed while the review panel is open. The strip and the panel
            draw the same proposals from the same queue, and the strip's own
            "Review all" button just opens that panel — so with it open the strip
            is a duplicate of what is already on screen, and one that costs a row
            of height in `.main-col` (see gotcha 14) every time a scan lands.
          */}
          {!worklogOpen && (
            <WorklogPrompt
              proposals={promptQueue}
              busy={worklogBusy}
              onAccept={(id) => {
                // Dropped from the strip at once. The write takes tens of seconds
                // and the answer has already been given; leaving the question up
                // while it runs invites a second press.
                setAsked((prev) => new Set(prev).add(id))
                void acceptProposal(id)
              }}
              onSkip={(id) => setAsked((prev) => new Set(prev).add(id))}
              onReject={(id) => {
                setAsked((prev) => new Set(prev).add(id))
                void rejectProposal(id)
              }}
              /*
               * Brings EVERY pending proposal into the strip, rather than the
               * ids from this session's own scan events.
               *
               * It used to open the activity report — `setWorklogOpen(true)` —
               * which shows hours and lines per project and has never so much
               * as imported WorklogProposal. That was left behind when 6304e35
               * replaced the review panel with the report: the button, its
               * label and the title bar's "N awaiting review" all went on
               * naming a surface that no longer existed. So a proposal skipped
               * with "Not now", or one left pending from an earlier run, was
               * unreachable — the badge counted up and nothing could act on it.
               */
              onReviewAll={() => {
                setAsked(new Set())
                setProposedIds(
                  worklog.filter((p) => p.status === 'pending').map((p) => p.id)
                )
              }}
              onDismiss={() => setProposedIds([])}
            />
          )}

          <div
            className="term-stack"
            style={{ display: activeTab?.kind === 'session' ? 'block' : 'none' }}
          >
            {panes.map((tab) =>
              tab.status === 'paused' ? (
                <PausedSession
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  screen={restoredScreens[tab.id] ?? ''}
                  onResume={resumeTabFor(tab)}
                  resuming={starting.includes(tab.id)}
                  onClose={requestCloseTab}
                />
              ) : (
                <TerminalView
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  theme={theme}
                  fontFamily={settings?.fontFamily ?? 'monospace'}
                  fontSize={settings?.fontSize ?? 13}
                  terminal={settings?.terminal ?? TERMINAL_DEFAULTS}
                  accent={activeProfile?.accent ?? null}
                  alpha={termAlpha}
                  onOpenUrl={openUrl}
                  onRestart={restartTab}
                  onClose={requestCloseTab}
                />
              )
            )}
          </div>

          {/*
            Only the active New Project tab renders. The launcher holds no state
            of its own — its selection lives on the tab — so keying it on the
            tab id remounts it when you switch between two New tabs, which is
            also what re-focuses the primary action.
          */}
          {activeTab?.kind === 'new' && (
            <Launcher
              key={activeTab.id}
              project={selectedProject}
              defaultCwd={defaultCwd}
              permissionMode={mode}
              model={model}
              effort={effort}
              ultracode={ultracode}
              sessions={sessions}
              recentProjects={recentProjects}
              onPickProject={(p) => selectProject(p.path)}
              onStartProject={(p) =>
                void startSession({
                  cwd: p.path,
                  name: p.label ?? p.name,
                  replaceTabId: activeNewTabId ?? undefined
                })
              }
              cli={cli}
              otherClis={otherClis}
              onAddAgents={() => setAgentPickerOpen(true)}
              onStartCli={(id) => {
                const target = selectedProject?.path ?? defaultCwd
                if (!target) return
                void startSession({
                  cwd: target,
                  cli: id,
                  name: selectedProject?.label ?? selectedProject?.name ?? baseName(target),
                  replaceTabId: activeNewTabId ?? undefined
                })
              }}
              onChangeMode={changeMode}
              onChangeModel={changeModel}
              onChangeEffort={changeEffort}
              onChangeUltracode={changeUltracode}
              onStart={() => {
                if (selectedProject) {
                  void startSession({
                    cwd: selectedProject.path,
                    name: selectedProject.label ?? selectedProject.name,
                    replaceTabId: activeNewTabId ?? undefined
                  })
                }
              }}
              onContinueLast={() => {
                if (selectedProject) {
                  void startSession({
                    cwd: selectedProject.path,
                    name: selectedProject.label ?? selectedProject.name,
                    continueLast: true,
                    replaceTabId: activeNewTabId ?? undefined
                  })
                }
              }}
              onResume={resumeSession}
              onOpenFolder={() => void openFolder()}
              onStartDefault={startDefault}
              hosts={settings?.hosts ?? []}
              onConnectHost={(h) => void startHostSession(h)}
              onStartScratch={() => void startScratch()}
            />
          )}
        </div>

        {browserOpen && (
          <>
            <Resizer
              value={browserWidth}
              min={320}
              max={900}
              invert
              label="Resize browser"
              onChange={setBrowserWidth}
              onCommit={(v) => {
                if (settings) void patchSettings({ browser: { ...settings.browser, width: v } })
              }}
            />
            <div style={{ width: browserWidth, display: 'flex', flexShrink: 0 }}>
              <BrowserPanel
                state={browserState}
                bookmarks={settings?.browser.bookmarks ?? []}
                onAskClaude={askClaude}
                onClose={() => setBrowserOpen(false)}
              />
            </div>
          </>
        )}

        {/*
          A sibling column, never an overlay. The docked browser is a native
          WebContentsView that paints above all renderer DOM, so an overlaid
          panel would be invisible whenever the browser was open.
        */}
        {worklogOpen && (
          <div style={{ width: 340, display: 'flex', flexShrink: 0 }}>
            <ActivityPanel onClose={() => setWorklogOpen(false)} />
          </div>
        )}
      </div>

      <StatusBar
        tab={activeTab}
        context={activeTab ? (contexts[activeTab.sessionId] ?? null) : null}
        activity={activeTab ? (activity[activeTab.sessionId] ?? null) : null}
        line={activeTab ? (sessionLine[activeTab.sessionId] ?? null) : null}
        cli={cli}
        updateAvailable={update?.updateAvailable ? update.latest : null}
        relaunch={relaunch}
        relaunchBusy={activeTab ? relaunching.includes(activeTab.id) : false}
        onRelaunch={() => {
          if (activeTab) requestRelaunch(activeTab)
        }}
        relaunchPending={activeTab ? activeTab.id in pending : false}
        onCancelRelaunch={() => {
          if (activeTab) cancelPendingRelaunch(activeTab.id)
        }}
        selfRestartPending={selfRestartPending}
        onCancelSelfRestart={() => {
          selfRestartPendingRef.current = false
          setSelfRestartPending(false)
        }}
        liveVersion={activeTab ? (live[activeTab.ptyId]?.version ?? null) : null}
        profileLabel={activeProfile?.label ?? null}
        onRevealProject={(p) => void window.stoke.projects.reveal(p)}
        onOpenSettings={() => openSettings('updates')}
      />

      {paletteOpen && (
        <CommandPalette
          projects={projects}
          onPick={(p) => {
            setPaletteOpen(false)
            selectInNewTab(p.path)
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {settingsOpen && settings && (
        <SettingsSheet
          key={settingsKey}
          settings={settings}
          profiles={availableProfiles}
          defaultCwd={defaultCwd}
          cli={cli}
          onPatch={(patch) => void patchSettings(patch)}
          onAddRoot={() => void addRoot()}
          onProfileCreated={refreshProjects}
          onPreviewTheme={setPreviewTheme}
          initialSection={settingsSection}
          agents={{
            detection: agentDetection,
            onRefresh: () => refreshAgents(true),
            onOpenPicker: () => setAgentPickerOpen(true),
            onInstall: (ids) => {
              setSettingsOpen(false)
              installAgents(ids)
            }
          }}
          onRestartToUpdate={requestSelfRestart}
          onClose={() => {
            // Drop any live preview with the sheet. Closing settings mid-edit
            // is a cancel by any other name, and leaving the preview applied
            // would paint a theme that is in no settings file and would
            // survive until the next theme change -- looking exactly like a
            // save that happened.
            setPreviewTheme(null)
            setSettingsOpen(false)
          }}
        />
      )}

      {busyDialog}

      {/*
        Last in the tree and highest in z, so it sits over whatever the launch
        restored. `fallback={null}` rather than a spinner: the chunk is a few
        kilobytes off the local disk, and a spinner that flashes for one frame
        before a welcome screen is worse than one frame of nothing.
      */}
      {agentPickerOpen && settings && (
        <AgentPicker
          detection={agentDetection}
          chosen={settings.agents.chosen}
          platform={platform}
          onDone={(chosen, install) => {
            setAgentPickerOpen(false)
            void patchSettings({ agents: { ...settings.agents, chosen } })
            installAgents(install)
          }}
          onClose={() => {
            setAgentPickerOpen(false)
            /*
             * Closing a first-run picker without choosing records the agents
             * that are installed, which is what the launcher was showing anyway.
             * Leaving it null would re-open the picker on every launch until
             * the user gave in.
             */
            if (settings.agents.chosen === null && agentDetection) {
              const installed = agentDetection.clis.filter((c) => c.path).map((c) => c.id)
              void patchSettings({ agents: { ...settings.agents, chosen: installed } })
            }
          }}
        />
      )}

      {welcome && (
        <Suspense fallback={null}>
          <Campfire
            reason={welcome.reason}
            version={welcome.version}
            onDismiss={dismissWelcome}
          />
        </Suspense>
      )}
    </div>
  )
}
