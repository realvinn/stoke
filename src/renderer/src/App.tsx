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
  WorklogProposal
} from '@shared/types'
import type { UpdateInfo } from '@shared/api'
import { profileFor, resolveProfiles, visibleProfiles } from '@shared/profiles'
import { resolveTheme } from '@shared/themes'
import { BrowserPanel } from './components/BrowserPanel'
import { CommandPalette } from './components/CommandPalette'
import { Launcher } from './components/Launcher'
import { Resizer } from './components/Resizer'
import { SettingsSheet } from './components/SettingsSheet'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TerminalView } from './components/TerminalView'
import { TitleBar } from './components/TitleBar'
import { WorklogPanel } from './components/WorklogPanel'
import { WorklogPrompt } from './components/WorklogPrompt'
import { baseName } from './lib/format'
import { attachExit, forgetPty, initPtyBus } from './lib/ptyBus'
import { matchShortcut } from './lib/shortcuts'
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
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

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    initPtyBus()

    const offCtx = window.stoke.context.onUpdate((snap) =>
      setContexts((prev) => ({ ...prev, [snap.sessionId]: snap }))
    )
    const offBrowser = window.stoke.browser.onState(setBrowserState)
    const offMax = window.stoke.window.onMaximizedChanged(setMaximized)
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

    return () => {
      offCtx()
      offBrowser()
      offMax()
      offSettings()
      offWorklog()
      offProposed()
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

  useEffect(() => {
    if (settings) applyTypography(settings.fontFamily, settings.fontSize, settings.uiScale)
  }, [settings])

  /* -------------------------------------------------------------- sessions */

  useEffect(() => {
    if (!selectedPath) {
      setSessions([])
      return
    }
    let cancelled = false
    setSessionsLoading(true)
    void window.stoke.projects.sessions(selectedPath).then((list) => {
      if (cancelled) return
      setSessions(list)
      setSessionsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [selectedPath])

  /* ------------------------------------------------------------------ tabs */

  // Mark tabs whose process has ended so the pane can offer a restart.
  useEffect(() => {
    const offs = tabs
      .filter((t) => t.status === 'running')
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

  // Adopt Claude's own generated session title once it appears.
  useEffect(() => {
    setTabs((list) => {
      let changed = false
      const next = list.map((t) => {
        const title = contexts[t.sessionId]?.title
        if (title && title !== t.title) {
          changed = true
          return { ...t, title }
        }
        return t
      })
      return changed ? next : list
    })
  }, [contexts])

  const startSession = useCallback(
    async (opts: {
      cwd: string
      name: string
      title?: string
      sessionId?: string
      resume?: boolean
      continueLast?: boolean
    }): Promise<void> => {
      setError(null)
      try {
        const res = await window.stoke.pty.start({
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          resume: opts.resume,
          continueLast: opts.continueLast,
          permissionMode: mode,
          model,
          effort,
          ultracode,
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
          permissionMode: mode,
          model,
          effort,
          status: 'running',
          exitCode: null,
          hostId: null,
          selectedPath: null,
          expandedPath: null
        }
        setTabs((list) => [...list, tab])
        setActiveTabId(tab.id)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
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
      if (res.error) setError(res.error)
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

  /**
   * Open a session on a remote machine.
   *
   * Same PTY machinery, different argv. It deliberately does not watch context:
   * the transcript lives on the far machine, so there is nothing local to read
   * and a meter would have to invent a number.
   */
  const startHostSession = useCallback(
    async (host: SshHost): Promise<void> => {
      setError(null)
      try {
        const res = await window.stoke.pty.start({
          cwd: defaultCwd || '.',
          host,
          permissionMode: mode,
          model,
          effort,
          cols: 120,
          rows: 30
        })
        setTabs((list) => [
          ...list,
          {
            id: res.ptyId,
            kind: 'session',
            ptyId: res.ptyId,
            sessionId: res.sessionId,
            cwd: host.alias,
            projectName: host.label || host.alias,
            title: host.label || host.alias,
            permissionMode: mode,
            model,
            effort,
            status: 'running',
            exitCode: null,
            hostId: host.id,
            selectedPath: null,
            expandedPath: null
          }
        ])
        setActiveTabId(res.ptyId)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [defaultCwd, mode, model, effort]
  )

  /** Quick start with no project: run in the configured default folder. */
  const startDefault = useCallback((): void => {
    if (!defaultCwd) return
    void startSession({ cwd: defaultCwd, name: baseName(defaultCwd) })
  }, [defaultCwd, startSession])

  /** Quick start in a fresh throwaway folder. */
  const startScratch = useCallback(async (): Promise<void> => {
    try {
      const dir = await window.stoke.workspace.createScratch()
      await startSession({ cwd: dir, name: `Scratch ${baseName(dir)}` })
      // The new folder becomes a real project once Claude writes a transcript.
      await refreshProjects()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [startSession, refreshProjects])

  // Optional "open straight into a session" behaviour. The ref keeps it to a
  // single attempt, including under StrictMode's double-invoked effects.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current) return
    if (!settings?.startOnLaunch || !defaultCwd || !cli?.ok) return
    autoStarted.current = true
    startDefault()
  }, [settings?.startOnLaunch, defaultCwd, cli, startDefault])

  const closeTab = useCallback(
    (id: string): void => {
      const tab = tabs.find((t) => t.id === id)
      if (!tab) return
      window.stoke.pty.kill(tab.ptyId)
      forgetPty(tab.ptyId)
      const next = tabs.filter((t) => t.id !== id)
      setTabs(next)
      if (activeTabId === id) setActiveTabId(next.length ? next[next.length - 1].id : null)
    },
    [tabs, activeTabId]
  )

  const restartTab = useCallback(
    (tab: Tab): void => {
      closeTab(tab.id)
      void startSession({ cwd: tab.cwd, name: tab.projectName })
    },
    [closeTab, startSession]
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
      const target = tabs.find((t) => t.id === activeTabId) ?? tabs[tabs.length - 1]
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
          setActiveTabId(null)
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMac, tabs, activeTabId, closeTab])

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
    setSelectedPath(dir)
    setActiveTabId(null)
  }, [refreshProjects])

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
        resume: true
      })
    },
    [projects, startSession]
  )

  return (
    <div className="app">
      <TitleBar
        platform={platform}
        maximized={maximized}
        tabs={tabs}
        activeTabId={activeTabId}
        contexts={contexts}
        sidebarOpen={sidebarOpen}
        browserOpen={browserOpen}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onNewTab={() => setActiveTabId(null)}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleBrowser={() => setBrowserOpen((v) => !v)}
        worklogCount={worklog.filter((p) => p.status === 'pending').length}
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
                onQueryChange={setQuery}
                onSelectProject={(p) => {
                  setSelectedPath(p.path)
                  setActiveTabId(null)
                }}
                onToggleExpand={(p) => {
                  setSelectedPath(p.path)
                  setExpandedPath((cur) => (cur === p.path ? null : p.path))
                }}
                onStartNew={(p) => void startSession({ cwd: p.path, name: p.name })}
                onResume={resumeSession}
                onPin={(p) => {
                  void window.stoke.projects.pin(p.path, !p.pinned).then(async (s) => {
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

          <div className="term-stack" style={{ display: activeTabId ? 'block' : 'none' }}>
            {tabs.map((tab) => (
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
            ))}
          </div>

          {activeTabId === null && (
            <Launcher
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
                  void startSession({ cwd: selectedProject.path, name: selectedProject.name })
                }
              }}
              onContinueLast={() => {
                if (selectedProject) {
                  void startSession({
                    cwd: selectedProject.path,
                    name: selectedProject.name,
                    continueLast: true
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
        onRevealProject={(p) => void window.stoke.projects.reveal(p)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {paletteOpen && (
        <CommandPalette
          projects={projects}
          onPick={(p) => {
            setPaletteOpen(false)
            setSelectedPath(p.path)
            setActiveTabId(null)
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
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
