import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrowserState,
  CliInfo,
  ContextSnapshot,
  EffortLevel,
  PermissionMode,
  Project,
  SessionMeta,
  Settings
} from '@shared/types'
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
import { attachExit, forgetPty, initPtyBus } from './lib/ptyBus'
import { matchShortcut } from './lib/shortcuts'
import { applyTheme, applyTypography } from './lib/theme'
import type { Tab } from './types'

const EMPTY_BROWSER: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false
}

export function App(): React.JSX.Element {
  const platform = window.hearth.platform
  const isMac = platform === 'darwin'

  const [settings, setSettings] = useState<Settings | null>(null)
  const [cli, setCli] = useState<CliInfo | null>(null)

  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
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

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Launch options for the next session, seeded from the saved defaults.
  const [mode, setMode] = useState<PermissionMode>('default')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<EffortLevel>('default')

  const theme = useMemo(
    () => resolveTheme(settings?.themeId ?? '', settings?.customThemes ?? []),
    [settings?.themeId, settings?.customThemes]
  )

  const refreshProjects = useCallback(async (): Promise<void> => {
    const list = await window.hearth.projects.list()
    setProjects(list)
    setProjectsLoading(false)
  }, [])

  const patchSettings = useCallback(async (patch: Partial<Settings>): Promise<void> => {
    const next = await window.hearth.settings.set(patch)
    setSettings(next)
  }, [])

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    initPtyBus()

    const offCtx = window.hearth.context.onUpdate((snap) =>
      setContexts((prev) => ({ ...prev, [snap.sessionId]: snap }))
    )
    const offBrowser = window.hearth.browser.onState(setBrowserState)
    const offMax = window.hearth.window.onMaximizedChanged(setMaximized)
    const offSettings = window.hearth.settings.onChange(setSettings)

    void (async () => {
      const s = await window.hearth.settings.get()
      setSettings(s)
      setSidebarWidth(s.sidebarWidth)
      setBrowserWidth(s.browser.width)
      setMode(s.defaults.permissionMode)
      setModel(s.defaults.model)
      setEffort(s.defaults.effort)
      void window.hearth.cli.info().then(setCli)
      await refreshProjects()
    })()

    void window.hearth.window.isMaximized().then(setMaximized)

    return () => {
      offCtx()
      offBrowser()
      offMax()
      offSettings()
    }
  }, [refreshProjects])

  // Project timestamps go stale while the window is in the background.
  useEffect(() => {
    const onFocus = (): void => void refreshProjects()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshProjects])

  /* ---------------------------------------------------------------- theme */

  useEffect(() => applyTheme(theme), [theme])

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
    void window.hearth.projects.sessions(selectedPath).then((list) => {
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
        const res = await window.hearth.pty.start({
          cwd: opts.cwd,
          sessionId: opts.sessionId,
          resume: opts.resume,
          continueLast: opts.continueLast,
          permissionMode: mode,
          model,
          effort,
          // A real size arrives from the terminal's own resize observer as soon
          // as it mounts; this is only what the child sees for its first paint.
          cols: 120,
          rows: 30
        })
        const tab: Tab = {
          id: res.ptyId,
          ptyId: res.ptyId,
          sessionId: res.sessionId,
          cwd: opts.cwd,
          projectName: opts.name,
          title: opts.title ?? opts.name,
          permissionMode: mode,
          model,
          effort,
          status: 'running',
          exitCode: null
        }
        setTabs((list) => [...list, tab])
        setActiveTabId(tab.id)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [mode, model, effort]
  )

  const closeTab = useCallback(
    (id: string): void => {
      const tab = tabs.find((t) => t.id === id)
      if (!tab) return
      window.hearth.pty.kill(tab.ptyId)
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
        window.hearth.browser.show()
      } else {
        seededBrowser.current = true
        window.hearth.browser.show(settings.browser.lastUrl || settings.browser.homepage)
      }
    } else {
      window.hearth.browser.hide()
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
    window.hearth.browser.show(url)
  }, [])

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
    const dir = await window.hearth.projects.open()
    if (!dir) return
    await refreshProjects()
    setSelectedPath(dir)
    setActiveTabId(null)
  }, [refreshProjects])

  const addRoot = useCallback(async (): Promise<void> => {
    const dir = await window.hearth.projects.addRoot()
    if (!dir) return
    const s = await window.hearth.settings.get()
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
                  void window.hearth.projects.pin(p.path, !p.pinned).then(async (s) => {
                    setSettings(s)
                    await refreshProjects()
                  })
                }}
                onAddRoot={() => void addRoot()}
                onOpenFolder={() => void openFolder()}
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
              permissionMode={mode}
              model={model}
              effort={effort}
              sessions={sessions}
              cli={cli}
              onChangeMode={changeMode}
              onChangeModel={changeModel}
              onChangeEffort={changeEffort}
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
              <BrowserPanel state={browserState} onClose={() => setBrowserOpen(false)} />
            </div>
          </>
        )}
      </div>

      <StatusBar
        tab={activeTab}
        context={activeTab ? (contexts[activeTab.sessionId] ?? null) : null}
        cli={cli}
        onRevealProject={(p) => void window.hearth.projects.reveal(p)}
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
          cli={cli}
          onPatch={(patch) => void patchSettings(patch)}
          onAddRoot={() => void addRoot()}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
