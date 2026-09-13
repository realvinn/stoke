import { useEffect, useMemo, useRef } from 'react'
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
import { useTabDrag } from '../lib/useTabDrag'
import type { SessionActivity, Tab } from '../types'

interface Props {
  platform: string
  /**
   * Draw the Stoke mark and name. Off macOS only — that corner is the traffic
   * lights' on macOS and the brand is never drawn there.
   */
  showBrand: boolean
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
  /**
   * Reorder: the dragged tab takes the target's index. Called once per drag,
   * on release — the strip previews the move itself until then.
   */
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
  showBrand,
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
  const listRef = useRef<HTMLDivElement>(null)
  const ids = useMemo(() => tabs.map((t) => t.id), [tabs])
  const drag = useTabDrag({
    listRef,
    ids,
    isMac,
    onSelect: onSelectTab,
    onReorder: onReorderTab
  })

  /*
   * Keep the selected tab on screen.
   *
   * The strip scrolls horizontally once it overflows, and nothing scrolled it:
   * with a dozen tabs open, Cmd+9, the new cycle chord and every OS
   * notification click could all select a tab that stayed off the end of the
   * strip. The terminal changed underneath and the strip did not move, which
   * reads as the wrong tab having been selected.
   *
   * Not while a tab is pressed. Selection happens on the press now, and
   * scrolling a half-visible tab into view at that moment slides the strip out
   * from under a pointer that may be about to drag it. A plain click brings
   * its tab into view from `onClick`, after the release, as it always did.
   *
   * `block: 'nearest'` as well as `inline`, or Chromium scrolls the whole app
   * grid vertically to bring a strip that is already fully visible into a
   * slightly different position.
   */
  useEffect(() => {
    if (drag.busy()) return
    const el = listRef.current?.querySelector('[aria-selected="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length, drag])

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

      {!isMac && showBrand && (
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
                /*
                 * What `useTabDrag` finds tabs by. It also writes
                 * `data-dragging` and an inline transform onto this node while
                 * a drag runs; neither is a prop here, so a re-render mid-drag
                 * leaves both alone.
                 */
                data-tab-id={tab.id}
                tabIndex={0}
                /*
                 * Selection happens on the PRESS (`useTabDrag`), as in Chrome,
                 * so the tab you drag is the tab on screen. The click still
                 * selects, for a tap and for anything that clicks without
                 * pressing, and brings a half-hidden tab into view once the
                 * button is up rather than while a drag might be starting.
                 */
                onPointerDown={(e) => drag.onPointerDown(e, tab.id)}
                /*
                 * No focus for the tab on a press. Focus stays in the terminal,
                 * which is where the keystrokes after a tab switch are meant to
                 * go — pressing the tab that was already selected used to leave
                 * them on the tab — and no press on a label starts a text
                 * selection. Enter and Space still select a keyboard-focused
                 * tab.
                 *
                 * Every button, not only the primary. A middle press focused
                 * the tab it was about to close, so focus fell to <body> and
                 * the next keystrokes went nowhere; a right press parked them
                 * on the tab. Both measured in the running app. It also keeps
                 * a middle press on the scrollable strip from starting
                 * Chromium's autoscroll where that is on. `auxclick` still
                 * fires, so middle-click still closes.
                 */
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  onSelectTab(tab.id)
                  e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
                }}
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
                  Not red: red in the strip already says two things, a ring
                  past 60% and the worklog dot in its centre.
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
