import type { ContextSnapshot } from '@shared/types'
import { ContextRing } from './ContextMeter'
import { UsageChip } from './UsageMeter'
import {
  BrandMark,
  IconClose,
  IconGear,
  IconGlobe,
  IconMaximize,
  IconMinimize,
  IconPin,
  IconPlus,
  IconRestore,
  IconSearch,
  IconSidebar
} from './Icons'
import type { Tab } from '../types'

interface Props {
  platform: string
  maximized: boolean
  tabs: Tab[]
  activeTabId: string | null
  contexts: Record<string, ContextSnapshot>
  sidebarOpen: boolean
  browserOpen: boolean
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  onToggleSidebar: () => void
  onToggleBrowser: () => void
  /** Proposals awaiting review. Zero hides the control entirely. */
  worklogCount: number
  worklogOpen: boolean
  onToggleWorklog: () => void
  onOpenPalette: () => void
  onOpenSettings: () => void
}

export function TitleBar({
  platform,
  maximized,
  tabs,
  activeTabId,
  contexts,
  sidebarOpen,
  browserOpen,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onToggleSidebar,
  onToggleBrowser,
  worklogCount,
  worklogOpen,
  onToggleWorklog,
  onOpenPalette,
  onOpenSettings
}: Props): React.JSX.Element {
  const isMac = platform === 'darwin'

  return (
    <header className="titlebar" data-platform={platform}>
      <button
        className="icon-btn"
        onClick={onToggleSidebar}
        aria-pressed={sidebarOpen}
        title="Toggle sidebar"
      >
        <IconSidebar />
        <span className="sr-only">Toggle sidebar</span>
      </button>

      {!isMac && (
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Stoke</span>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Sessions">
        {tabs.map((tab) => {
          const ctx = contexts[tab.sessionId]
          const bypass = tab.permissionMode === 'bypassPermissions'
          return (
            <div
              key={tab.id}
              className="tab"
              role="tab"
              aria-selected={tab.id === activeTabId}
              tabIndex={0}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectTab(tab.id)
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) onCloseTab(tab.id)
              }}
              title={`${tab.title} — ${tab.cwd}`}
            >
              {ctx?.ready ? (
                <ContextRing used={ctx.contextTokens} limit={ctx.contextLimit} />
              ) : (
                <span
                  className="tab-dot"
                  data-state={
                    tab.status === 'exited' ? 'exited' : bypass ? 'bypass' : 'running'
                  }
                />
              )}
              <span className="tab-label">{tab.title}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseTab(tab.id)
                }}
                title="Close session"
              >
                <IconClose width={11} height={11} />
                <span className="sr-only">Close {tab.title}</span>
              </button>
            </div>
          )
        })}

        <button className="icon-btn" onClick={onNewTab} title="New session (Ctrl/Cmd+T)">
          <IconPlus />
          <span className="sr-only">New session</span>
        </button>
      </div>

      <div className="titlebar-actions">
        <button className="icon-btn" onClick={onOpenPalette} title="Find a project (Ctrl/Cmd+K)">
          <IconSearch />
          <span className="sr-only">Find a project</span>
        </button>
        <button
          className="icon-btn"
          onClick={onToggleBrowser}
          aria-pressed={browserOpen}
          title="Toggle browser (Ctrl/Cmd+B)"
        >
          <IconGlobe />
          <span className="sr-only">Toggle browser</span>
        </button>
        {/*
          Only offered when there is something to review or a session to scan.
          A permanent button would advertise a feature most sessions never use,
          and the count is the only thing that makes it worth a glance.
        */}
        {(worklogCount > 0 || worklogOpen) && (
          <button
            className="icon-btn"
            onClick={onToggleWorklog}
            aria-pressed={worklogOpen}
            title={`Worklog — ${worklogCount} awaiting review`}
          >
            <IconPin />
            <span className="sr-only">Toggle worklog review</span>
          </button>
        )}
        <UsageChip />

        <button className="icon-btn" onClick={onOpenSettings} title="Settings">
          <IconGear />
          <span className="sr-only">Settings</span>
        </button>

        {/*
          Windows draws its own controls in a native overlay, which is also what
          keeps Snap Layouts working when you hover maximise. Only Linux, which
          has no overlay, still needs these drawn here.
        */}
        {!isMac && platform !== 'win32' && (
          <div className="win-controls">
            <button
              className="win-btn"
              onClick={() => window.stoke.window.minimize()}
              title="Minimize"
            >
              <IconMinimize />
              <span className="sr-only">Minimize</span>
            </button>
            <button
              className="win-btn"
              onClick={() => window.stoke.window.maximize()}
              title={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? <IconRestore /> : <IconMaximize />}
              <span className="sr-only">{maximized ? 'Restore' : 'Maximize'}</span>
            </button>
            <button
              className="win-btn"
              data-variant="close"
              onClick={() => window.stoke.window.close()}
              title="Close"
            >
              <IconClose />
              <span className="sr-only">Close window</span>
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
