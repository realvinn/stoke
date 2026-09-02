import { useEffect, useRef, useState } from 'react'
import type { ContextSnapshot } from '@shared/types'
import type { WorklogButtonState } from '@shared/worklog'
import { UsageChip } from './UsageMeter'
import { PhonePopover } from './PhonePopover'
import { TabIndicator } from './TabIndicator'
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
import { chordLabel } from '../lib/shortcuts'
import type { SessionActivity, Tab } from '../types'

interface Props {
  platform: string
  maximized: boolean
  /** Full screen hides the macOS traffic lights, so their clearance must go too. */
  fullScreen: boolean
  tabs: Tab[]
  activeTabId: string | null
  contexts: Record<string, ContextSnapshot>
  /** Working / done / needs-attention per session id, from the CLI's hooks. */
  activity: Record<string, SessionActivity>
  /** Session ids the worklog agent is watching. Drives the red dot in the ring. */
  watchedSessions: Set<string>
  sidebarOpen: boolean
  browserOpen: boolean
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  /** Reorder: the dragged tab takes the target's index. */
  onReorderTab: (dragId: string, overId: string) => void
  onToggleSidebar: () => void
  onToggleBrowser: () => void
  /** Proposals awaiting review. Shown in the tooltip; the badge comes from worklogState. */
  worklogCount: number
  /** disarmed / watching / badged — see worklogButtonState. */
  worklogState: WorklogButtonState
  worklogOpen: boolean
  onToggleWorklog: () => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  /** Settings, opened straight at Phone access. */
  onOpenPhoneSettings: () => void
}

export function TitleBar({
  platform,
  maximized,
  fullScreen,
  tabs,
  activeTabId,
  contexts,
  activity,
  watchedSessions,
  sidebarOpen,
  browserOpen,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onReorderTab,
  onToggleSidebar,
  onToggleBrowser,
  worklogCount,
  worklogState,
  worklogOpen,
  onToggleWorklog,
  onOpenPalette,
  onOpenSettings,
  onOpenPhoneSettings
}: Props): React.JSX.Element {
  const isMac = platform === 'darwin'
  const [dragId, setDragId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /*
   * Keep the selected tab on screen.
   *
   * The strip scrolls horizontally once it overflows, and nothing scrolled it:
   * with a dozen tabs open, Cmd+9, the new cycle chord and every OS
   * notification click could all select a tab that stayed off the end of the
   * strip. The terminal changed underneath and the strip did not move, which
   * reads as the wrong tab having been selected.
   *
   * `block: 'nearest'` as well as `inline`, or Chromium scrolls the whole app
   * grid vertically to bring a strip that is already fully visible into a
   * slightly different position.
   */
  useEffect(() => {
    const el = listRef.current?.querySelector('[aria-selected="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  return (
    <header className="titlebar" data-platform={platform} data-fullscreen={fullScreen || undefined}>
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

      {/*
        The strip and the tablist are two different things. The + button lives
        in the strip and is emphatically not a tab: inside the tablist a screen
        reader announced it as one, and arrow-key tab semantics applied to a
        control that does not answer to them.
      */}
      <div className="tabs">
        <div className="tablist" role="tablist" aria-label="Sessions" ref={listRef}>
          {tabs.map((tab) => {
            const ctx = contexts[tab.sessionId]
            const act = tab.kind === 'session' ? activity[tab.sessionId] : undefined
            return (
              <div
                key={tab.id}
                className="tab"
                role="tab"
                aria-selected={tab.id === activeTabId}
                data-activity={act?.state}
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
                title={
                  tab.kind === 'new'
                    ? 'New session — pick a project, or start in the default folder'
                    : `${tab.title}\n${tab.cwd}`
                }
                draggable
                data-dragging={tab.id === dragId ? 'true' : undefined}
                onDragStart={(e) => {
                  setDragId(tab.id)
                  e.dataTransfer.effectAllowed = 'move'
                  // Chromium refuses to begin a drag with an empty payload.
                  e.dataTransfer.setData('text/plain', tab.id)
                }}
                /*
                 * The strip reorders as you drag, rather than marking where the
                 * tab would land and moving it on release. You are moving the
                 * tab, so the tab moves.
                 *
                 * The midpoint test is what makes that stable. Reordering the
                 * moment the pointer enters a neighbour means the list changes
                 * under the cursor, the cursor is then over the tab it just
                 * displaced, and the two swap back and forth for as long as you
                 * hold still — a flicker, not a reorder. Requiring the pointer
                 * to be PAST the target's centre, in the direction of travel,
                 * means the swap it triggers moves the target behind the
                 * pointer rather than under it, so it cannot immediately
                 * re-trigger. `moveTab` returns the same array when there is
                 * nothing to do, so the repeats dragover fires cost nothing.
                 */
                onDragOver={(e) => {
                  if (!dragId || dragId === tab.id) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const from = tabs.findIndex((t) => t.id === dragId)
                  const to = tabs.findIndex((t) => t.id === tab.id)
                  if (from < 0 || to < 0) return
                  const box = e.currentTarget.getBoundingClientRect()
                  const middle = box.left + box.width / 2
                  if (to > from ? e.clientX > middle : e.clientX < middle) {
                    onReorderTab(dragId, tab.id)
                  }
                }}
                onDrop={(e) => {
                  // The move already happened. This only ends the gesture —
                  // and still has to preventDefault, or Chromium treats the
                  // drop as navigation to the text payload.
                  e.preventDefault()
                  setDragId(null)
                }}
                onDragEnd={() => setDragId(null)}
              >
                <TabIndicator
                  kind={tab.kind}
                  context={ctx}
                  status={tab.status}
                  permissionMode={tab.permissionMode}
                  watched={watchedSessions.has(tab.sessionId)}
                />
                <span className="tab-label">{tab.title}</span>
                {/*
                  What happened here since you last looked. Working pulses,
                  done is a solid accent dot, attention is the warning colour.
                  Not red: red in the strip means the worklog is watching.
                */}
                {act && (
                  <span
                    className="tab-activity"
                    data-state={act.state}
                    title={
                      act.state === 'working'
                        ? 'Claude is working'
                        : act.state === 'done'
                          ? `Finished${act.message ? `: ${act.message}` : ''}`
                          : `Needs your attention${act.message ? `: ${act.message}` : ''}`
                    }
                  >
                    <span className="sr-only">
                      {act.state === 'working'
                        ? 'Claude is working. '
                        : act.state === 'done'
                          ? 'Finished since you last looked. '
                          : 'Needs your attention. '}
                    </span>
                  </span>
                )}
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                  title={`Close (${chordLabel('closeTab', isMac)})`}
                >
                  <IconClose />
                  <span className="sr-only">Close {tab.title}</span>

                </button>
              </div>
            )
          })}
        </div>

        <button
          className="icon-btn"
          onClick={onNewTab}
          title={`New session (${chordLabel('newTab', isMac)})`}
        >
          <IconPlus />
          <span className="sr-only">New session</span>
        </button>
      </div>

      <div className="titlebar-actions">
        <button
          className="icon-btn"
          onClick={onOpenPalette}
          title={`Find a project (${chordLabel('palette', isMac)})`}
        >
          <IconSearch />
          <span className="sr-only">Find a project</span>
        </button>
        <button
          className="icon-btn"
          onClick={onToggleBrowser}
          aria-pressed={browserOpen}
          title={`Toggle browser (${chordLabel('toggleBrowser', isMac)})`}
        >
          <IconGlobe />
          <span className="sr-only">Toggle browser</span>
        </button>
        {/*
          Always rendered. Hiding it until something is pending made the feature
          unreachable on a clean install: proposals only arrive from the Scan
          button inside the panel, so nothing could ever raise the count that
          was gating the only way in.
        */}
        <button
          className="icon-btn"
          data-worklog={worklogState}
          onClick={onToggleWorklog}
          aria-pressed={worklogOpen}
          /*
            This opens the activity report, so it says so. It used to promise
            "N awaiting review" and open a page of hours and lines per project —
            left over from 6304e35, which replaced the review panel with the
            report and updated neither this button nor its tooltip. The pending
            count still belongs here, because it is the only always-visible
            place it appears, but the sentence now names where reviewing
            actually happens.
          */
          title={
            worklogCount > 0
              ? `Activity — and ${worklogCount} worklog proposal${worklogCount === 1 ? '' : 's'} pending in the review strip`
              : worklogState === 'watching'
                ? 'Activity — the worklog is watching this session; nothing proposed yet'
                : 'Activity — the worklog watches nothing. Scan a session, or tick a profile in Settings'
          }
        >
          <IconPin />
          <span className="sr-only">Toggle worklog review</span>
        </button>
        <PhonePopover onOpenSettings={onOpenPhoneSettings} />
        <UsageChip />

        <button
          className="icon-btn"
          onClick={onOpenSettings}
          title={`Settings (${chordLabel('settings', isMac)})`}
        >
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
