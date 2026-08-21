import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrowserState,
  CliInfo,
  ContextSnapshot,
  EffortLevel,
  PermissionMode,
  Project,
  SessionMeta,
  Settings,
  SshHost,
  WorklogProposal,
  WorklogScanReport,
  WorklogWatchState
} from '@shared/types'
import type { UpdateInfo } from '@shared/api'
import { foldGroup, profileFor, resolveProfiles, visibleProfiles } from '@shared/profiles'
import { resolveTheme } from '@shared/themes'
import { worklogButtonState } from '@shared/worklog'
import { BrowserPanel } from './components/BrowserPanel'
import { CommandPalette } from './components/CommandPalette'
import { IconClose } from './components/Icons'
import { Launcher } from './components/Launcher'
import { PausedSession } from './components/PausedSession'
import { Resizer } from './components/Resizer'
import { SettingsSheet } from './components/SettingsSheet'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TerminalView } from './components/TerminalView'
import { TitleBar } from './components/TitleBar'
import { WorklogPanel } from './components/WorklogPanel'
import { WorklogPrompt } from './components/WorklogPrompt'
import { baseName, ipcErrorMessage, properNouns } from './lib/format'
import { attachExit, forgetPty, initPtyBus } from './lib/ptyBus'
import { zoomStep } from '@shared/ui'
import { matchShortcut } from './lib/shortcuts'
import { newTab } from './lib/newTab'
import { profileIdForCwd } from './lib/projectProfile'
import { fromStored, screensFrom, toStored } from './lib/restore'
import { screenOf } from './lib/termRegistry'
import { moveTab, neighbourOf, replaceOrAppend, restartPlan } from './lib/tabs'
import { applyAppearance, applyTypography } from './lib/theme'
import type { Tab } from './types'

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
  const [worklogLastScan, setWorklogLastScan] = useState<WorklogScanReport | null>(null)
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

  // Launch options for the next session, seeded from the saved defaults.
  const [mode, setMode] = useState<PermissionMode>('default')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<EffortLevel>('default')
  /*
   * Ultracode is not an effort level - the CLI's --effort takes only
   * low/medium/high/xhigh/max - but a boolean it reads from its settings, so it
   * rides along as its own launch option rather than as a sixth effort.
   */
  const [ultracode, setUltracode] = useState(false)

  const theme = useMemo(
    () => resolveTheme(settings?.themeId ?? '', settings?.customThemes ?? []),
    [settings?.themeId, settings?.customThemes]
  )

  const refreshProjects = useCallback(async (): Promise<void> => {
    const list = await window.stoke.projects.list()
    setProjects(list)
    setProjectsLoading(false)
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

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    initPtyBus()

    const offCtx = window.stoke.context.onUpdate((snap) =>
      setContexts((prev) => ({ ...prev, [snap.sessionId]: snap }))
    )
    const offBrowser = window.stoke.browser.onState(setBrowserState)
    const offMax = window.stoke.window.onMaximizedChanged(setMaximized)
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
    const offScanned = window.stoke.worklog.onScanned(setWorklogLastScan)
    void window.stoke.worklog.watch().then(setWorklogWatch)
    void window.stoke.worklog.lastScan().then(setWorklogLastScan)

    void (async () => {
      const s = await window.stoke.settings.get()
      setSettings(s)
      setSidebarWidth(s.sidebarWidth)
      setBrowserWidth(s.browser.width)
      setMode(s.defaults.permissionMode)
      setModel(s.defaults.model)
      setEffort(s.defaults.effort)
      setUltracode(s.defaults.ultracode)
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
      offBrowser()
      offFull()
      offMax()
      offSettings()
      offWorklog()
      offProposed()
      offWatch()
      offScanned()
    }
  }, [refreshProjects])

  // The configured folder can change in Settings; re-resolve when it does so
  // the launcher and Settings hint never disagree.
  useEffect(() => {
    if (!settings) return
    void window.stoke.workspace.defaultCwd().then(setDefaultCwd)
  }, [settings?.defaultCwd, settings])

  // Project timestamps go stale while the window is in the background.
  useEffect(() => {
    const onFocus = (): void => void refreshProjects()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshProjects])

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
    if (settings) applyTypography(settings.fontFamily, settings.fontSize, settings.uiScale)
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
  const sessionsLoading = selectedPath !== null && sessionsLoadingPath === selectedPath

  /* ------------------------------------------------------------------ tabs */

  // Mark tabs whose process has ended so the pane can offer a restart.
  useEffect(() => {
    const offs = tabs
      .filter((t) => t.kind === 'session' && t.status === 'running')
      .map((t) =>
        attachExit(t.ptyId, (code) =>
          setTabs((list) =>
            list.map((x) =>
              x.ptyId === t.ptyId ? { ...x, status: 'exited' as const, exitCode: code } : x
            )
          )
        )
      )
    return () => offs.forEach((off) => off())
  }, [tabs])

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
    }): Promise<boolean> => {
      setError(null)
      const permissionMode = opts.permissionMode ?? mode
      const sessionModel = opts.model ?? model
      const sessionEffort = opts.effort ?? effort
      const sessionUltracode = opts.ultracode ?? ultracode
      try {
        const res = await window.stoke.pty.start({
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          resume: opts.resume,
          continueLast: opts.continueLast,
          permissionMode,
          model: sessionModel,
          effort: sessionEffort,
          ultracode: sessionUltracode,
          // A real size arrives from the terminal's own resize observer as soon
          // as it mounts; this is only what the child sees for its first paint.
          cols: 120,
          rows: 30
        })
        const tab: Tab = {
          id: res.ptyId,
          kind: 'session',
          ptyId: res.ptyId,
          sessionId: res.sessionId,
          cwd: opts.cwd,
          projectName: opts.name,
          title: opts.title ?? opts.name,
          permissionMode,
          model: sessionModel,
          effort: sessionEffort,
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
        setActiveTabId(tab.id)
        return true
      } catch (e) {
        setError(ipcErrorMessage(e))
        return false
      }
    },
    [mode, model, effort, ultracode]
  )

  /* --------------------------------------------------------------- worklog */

  const scanWorklog = useCallback(async (): Promise<void> => {
    const sessionId = tabs.find((t) => t.id === activeTabId)?.sessionId
    if (!sessionId) return
    setWorklogBusy(true)
    try {
      const res = await window.stoke.worklog.scan(sessionId)
      if (res.error) setError(properNouns(res.error))
    } finally {
      setWorklogBusy(false)
    }
  }, [tabs, activeTabId])

  const acceptProposal = useCallback(async (id: string): Promise<void> => {
    setWorklogBusy(true)
    try {
      const res = await window.stoke.worklog.accept(id)
      if (res.error) setError(res.error)
    } finally {
      setWorklogBusy(false)
    }
  }, [])

  /*
   * Sequential, not Promise.all. Each accept spawns a headless CLI run that
   * writes to two external services; firing them together would race the queue
   * file and multiply the cost spike with no way to stop partway.
   */
  const acceptAllProposals = useCallback(async (): Promise<void> => {
    setWorklogBusy(true)
    try {
      for (const p of worklog.filter((x) => x.status === 'pending')) {
        const res = await window.stoke.worklog.accept(p.id)
        if (res.error) setError(res.error)
      }
    } finally {
      setWorklogBusy(false)
    }
  }, [worklog])

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
      overrides?: { permissionMode?: PermissionMode; model?: string; effort?: EffortLevel }
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
          cols: 120,
          rows: 30
        })
        const tab: Tab = {
          id: res.ptyId,
          kind: 'session' as const,
          ptyId: res.ptyId,
          sessionId: res.sessionId,
          cwd: host.alias,
          projectName: host.label || host.alias,
          title: host.label || host.alias,
          permissionMode,
          model: sessionModel,
          effort: sessionEffort,
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
        setActiveTabId(tab.id)
        return true
      } catch (e) {
        setError(ipcErrorMessage(e))
        return false
      }
    },
    [defaultCwd, mode, model, effort, activeNewTabId]
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
   */
  const resumeTabFor = useCallback(
    (tab: Tab): (() => void) | null => {
      if (tab.hostId) {
        const host = settings?.hosts.find((h) => h.id === tab.hostId)
        if (!host) return null
        return () => {
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
          void startHostSession(host, tab.id, {
            permissionMode: tab.permissionMode,
            model: tab.model,
            effort: tab.effort
          }).then((ok) => {
            if (ok) dropRestoredScreen(tab.id)
          })
        }
      }
      return () => {
        void startSession({
          cwd: tab.cwd,
          name: tab.projectName,
          title: tab.title,
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
          effort: tab.effort
        }).then((ok) => {
          if (ok) dropRestoredScreen(tab.id)
        })
      }
    },
    [settings, startSession, startHostSession, dropRestoredScreen]
  )

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
        setRestoredScreens(screensFrom(state, back))
        setTabs(back)
        setActiveTabId(activeId)
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
    if (!settings?.startOnLaunch || !defaultCwd || !cli?.ok) return
    // Restored tabs are what the user had; opening a session on top of them is
    // an extra nobody asked for.
    if (restoreCount > 0) return
    autoStarted.current = true
    startDefault()
  }, [restoreSettled, settings?.startOnLaunch, defaultCwd, cli, startDefault, restoreCount])

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
    // Keyed by tab id in the render, so React moves the DOM nodes rather than
    // rebuilding them — and ptyBus replays the retained scrollback anyway, so
    // even a rebuild would not blank a terminal.
    setTabs((list) => moveTab(list, dragId, overId))
  }, [])

  const closeTab = useCallback(
    (id: string): void => {
      const tab = tabs.find((t) => t.id === id)
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
      // Never leave the strip empty: closing the last tab lands on a fresh New
      // Project tab, which is where the app starts anyway.
      const next = tabs.filter((t) => t.id !== id)
      const replacement = next.length ? next : [newTab()]
      setTabs(replacement)
      if (activeTabId === id) {
        setActiveTabId(
          next.length ? neighbourOf(tabs.map((t) => t.id), id) : replacement[0].id
        )
      }
    },
    [tabs, activeTabId, dropRestoredScreen]
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
      if (tab.kind === 'session' && tab.ptyId) forgetPty(tab.ptyId)

      const hosts = settings?.hosts ?? []
      const plan = restartPlan(tab, hosts.map((h) => h.id))

      if (plan.kind === 'impossible') {
        setError(plan.reason)
        return
      }

      if (plan.kind === 'host') {
        const host = hosts.find((h) => h.id === plan.hostId)
        if (!host) return
        void startHostSession(host, tab.id, {
          permissionMode: tab.permissionMode,
          model: tab.model,
          effort: tab.effort
        })
        return
      }

      void startSession({
        cwd: plan.cwd,
        name: tab.projectName,
        replaceTabId: tab.id,
        permissionMode: tab.permissionMode,
        model: tab.model,
        effort: tab.effort
      })
    },
    [settings, startSession, startHostSession]
  )

  /* --------------------------------------------------------------- browser */

  const overlayOpen = paletteOpen || settingsOpen
  const seededBrowser = useRef(false)

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
    setBrowserOpen(true)
    window.stoke.browser.show(url)
  }, [])

  /**
   * Hand the current page to the running session by typing an opening line into
   * its prompt — deliberately unfinished, so the question is still the user's.
   */
  const askClaude = useCallback(
    (url: string, title: string): void => {
      const live = tabs.filter((t) => t.kind === 'session')
      const target = live.find((t) => t.id === activeTabId) ?? live[live.length - 1]
      if (!target) {
        setError('Start a session first — then Ask Claude types the page into its prompt.')
        return
      }
      const label = title ? `"${title}" (${url})` : url
      window.stoke.pty.write(
        target.ptyId,
        `Using the stoke browser tools, look at the page open in the browser — ${label} — and `
      )
      setActiveTabId(target.id)
    },
    [tabs, activeTabId]
  )

  /* ------------------------------------------------------------- shortcuts */

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  /* Memoised: a fresh array each render would rebuild the Sidebar's Set on every tick. */
  const openSessionIds = useMemo(() => tabs.map((t) => t.sessionId), [tabs])
  const selectedProject = projects.find((p) => p.path === selectedPath) ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = matchShortcut(e, isMac)
      if (!action) return
      e.preventDefault()
      switch (action.type) {
        case 'palette':
          setPaletteOpen((v) => !v)
          break
        case 'newTab':
          openNewTab()
          break
        case 'closeTab':
          if (activeTabId) closeTab(activeTabId)
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
  }, [isMac, tabs, activeTabId, closeTab, openNewTab])

  // Escape closes whichever overlay is on top.
  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  /* ---------------------------------------------------------------- render */

  const openFolder = useCallback(async (): Promise<void> => {
    const dir = await window.stoke.projects.open()
    if (!dir) return
    await refreshProjects()
    /*
     * "Open a folder" is one of a New tab's own launcher actions, alongside
     * Start here and Scratch session — like them, it fills the tab it was
     * invoked from (`activeNewTabId`) instead of always spawning another
     * beside it. Only when there is no New tab in view (the sidebar's own
     * Open Folder button while a session tab is active) is a fresh one
     * appended.
     *
     * The id is captured in a local before `selectProject` runs — reading
     * `activeTabId` there instead would still see the tab that was active a
     * moment ago, since React has not re-rendered between the mint and the
     * write. See `selectProject`'s `tabId` parameter.
     */
    let tabId = activeNewTabId
    if (!tabId) {
      const t = newTab()
      setTabs((list) => [...list, t])
      setActiveTabId(t.id)
      tabId = t.id
    }
    selectProject(dir, tabId)
  }, [activeNewTabId, refreshProjects, selectProject])

  const addRoot = useCallback(async (): Promise<void> => {
    const dir = await window.stoke.projects.addRoot()
    if (!dir) return
    const s = await window.stoke.settings.get()
    setSettings(s)
    await refreshProjects()
  }, [refreshProjects])

  const changeMode = useCallback(
    (m: PermissionMode): void => {
      setMode(m)
      if (settings) void patchSettings({ defaults: { ...settings.defaults, permissionMode: m } })
    },
    [settings, patchSettings]
  )

  const changeModel = useCallback(
    (m: string): void => {
      setModel(m)
      if (settings) void patchSettings({ defaults: { ...settings.defaults, model: m } })
    },
    [settings, patchSettings]
  )

  const changeEffort = useCallback(
    (v: EffortLevel): void => {
      setEffort(v)
      if (settings) void patchSettings({ defaults: { ...settings.defaults, effort: v } })
    },
    [settings, patchSettings]
  )

  const changeUltracode = useCallback(
    (v: boolean): void => {
      setUltracode(v)
      if (settings) void patchSettings({ defaults: { ...settings.defaults, ultracode: v } })
    },
    [settings, patchSettings]
  )

  const resumeSession = useCallback(
    (s: SessionMeta): void => {
      const project = projects.find((p) => p.path === s.projectPath)
      void startSession({
        cwd: s.projectPath,
        name: project?.name ?? s.projectPath,
        title: s.title ?? s.firstPrompt ?? undefined,
        sessionId: s.id,
        resume: true,
        replaceTabId: activeNewTabId ?? undefined
      })
    },
    [projects, startSession, activeNewTabId]
  )

  const worklogPending = worklog.filter((p) => p.status === 'pending').length
  const worklogState = useMemo(
    () => worklogButtonState(worklogWatch, worklogPending),
    [worklogWatch, worklogPending]
  )

  return (
    <div className="app">
      <TitleBar
        platform={platform}
        maximized={maximized}
        fullScreen={fullScreen}
        tabs={tabs}
        activeTabId={activeTabId}
        contexts={contexts}
        watchedSessions={watchedSessions}
        sidebarOpen={sidebarOpen}
        browserOpen={browserOpen}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onNewTab={openNewTab}
        onReorderTab={reorderTab}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleBrowser={() => setBrowserOpen((v) => !v)}
        worklogCount={worklogPending}
        worklogState={worklogState}
        worklogOpen={worklogOpen}
        onToggleWorklog={() => setWorklogOpen((v) => !v)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="body-row">
        {sidebarOpen && (
          <>
            <div style={{ width: sidebarWidth, display: 'flex', flexShrink: 0 }}>
              <Sidebar
                projects={projects}
                loading={projectsLoading}
                query={query}
                selectedPath={selectedPath}
                expandedPath={expandedPath}
                sessions={sessions}
                sessionsLoading={sessionsLoading}
                openSessionIds={openSessionIds}
                onQueryChange={setQuery}
                onSelectProject={(p) => selectProject(p.path)}
                onToggleExpand={(p) => {
                  selectProject(p.path)
                  toggleExpand(expandedPath === p.path ? null : p.path)
                }}
                onStartNew={(p) => void startSession({ cwd: p.path, name: p.name })}
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
              <button
                className="btn"
                data-variant="ghost"
                onClick={() => {
                  /*
                   * Same guard `closeTab` uses: a resumed tab has a real
                   * `claude` process behind it — `ptyId` is non-empty and
                   * `status` is 'running' — and nothing else here kills it.
                   * Without this, replacing `tabs` below just drops the tab
                   * from the strip: the process keeps running with no UI, no
                   * owner, and no way back to it short of quitting Stoke,
                   * burning tokens and filling main's replay buffer for as
                   * long as the app stays open. A paused tab needs nothing —
                   * `ptyId` is '' and there is no process to kill.
                   */
                  tabs.forEach((t) => {
                    if (t.kind === 'session' && t.status !== 'paused') {
                      window.stoke.pty.kill(t.ptyId)
                      forgetPty(t.ptyId)
                    }
                  })
                  setTabs([newTab()])
                  setActiveTabId(null)
                  setRestoredScreens({})
                  setRestoreDismissed(true)
                }}
              >
                Start fresh
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
            onReviewAll={() => {
              setWorklogOpen(true)
              setProposedIds([])
            }}
            onDismiss={() => setProposedIds([])}
          />

          <div
            className="term-stack"
            style={{ display: activeTab?.kind === 'session' ? 'block' : 'none' }}
          >
            {tabs
              .filter((tab) => tab.kind === 'session')
              .map((tab) =>
                tab.status === 'paused' ? (
                  <PausedSession
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTabId}
                    screen={restoredScreens[tab.id] ?? ''}
                    onResume={resumeTabFor(tab)}
                    onClose={closeTab}
                  />
                ) : (
                  <TerminalView
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTabId}
                    theme={theme}
                    fontFamily={settings?.fontFamily ?? 'monospace'}
                    fontSize={settings?.fontSize ?? 13}
                    onOpenUrl={openUrl}
                    onRestart={restartTab}
                    onClose={closeTab}
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
              cli={cli}
              onChangeMode={changeMode}
              onChangeModel={changeModel}
              onChangeEffort={changeEffort}
              onChangeUltracode={changeUltracode}
              onStart={() => {
                if (selectedProject) {
                  void startSession({
                    cwd: selectedProject.path,
                    name: selectedProject.name,
                    replaceTabId: activeNewTabId ?? undefined
                  })
                }
              }}
              onContinueLast={() => {
                if (selectedProject) {
                  void startSession({
                    cwd: selectedProject.path,
                    name: selectedProject.name,
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
            <WorklogPanel
              proposals={worklog}
              busy={worklogBusy}
              watch={worklogWatch.find((w) => w.sessionId === activeTab?.sessionId) ?? null}
              watchedGroups={settings?.worklogGroups ?? []}
              lastScan={worklogLastScan}
              onScan={() => void scanWorklog()}
              onAccept={(id) => void acceptProposal(id)}
              onReject={(id) => void window.stoke.worklog.reject(id)}
              onAcceptAll={() => void acceptAllProposals()}
              onClose={() => setWorklogOpen(false)}
            />
          </div>
        )}
      </div>

      <StatusBar
        tab={activeTab}
        context={activeTab ? (contexts[activeTab.sessionId] ?? null) : null}
        cli={cli}
        updateAvailable={update?.updateAvailable ? update.latest : null}
        profileLabel={activeProfile?.label ?? null}
        onRevealProject={(p) => void window.stoke.projects.reveal(p)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {paletteOpen && (
        <CommandPalette
          projects={projects}
          onPick={(p) => {
            setPaletteOpen(false)
            selectProject(p.path)
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {settingsOpen && settings && (
        <SettingsSheet
          settings={settings}
          profiles={availableProfiles}
          defaultCwd={defaultCwd}
          cli={cli}
          onPatch={(patch) => void patchSettings(patch)}
          onAddRoot={() => void addRoot()}
          onProfileCreated={refreshProjects}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
