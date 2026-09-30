import { useEffect, useMemo, useRef, useState } from 'react'
import { capsFor, cliFor, cliIdOf, type CodingCliId } from '@shared/codingClis'
import type { ContextSnapshot } from '@shared/types'
import type { WorklogButtonState } from '@shared/worklog'
import { UsageChip } from './UsageMeter'
import { PhonePopover } from './PhonePopover'
import { ContextMenu, type MenuItem } from './ContextMenu'
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
import { agentMark } from '../lib/agentColor'
import type { CloseSide } from '../lib/tabs'
import type { ActivityView } from '@shared/activityView'
import type { Tab } from '../types'

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
  /**
   * What each session tab's activity dot shows, keyed by TAB id — decided by
   * `activityView` from the CLI's hooks and its session registry together.
   */
  activity: Record<string, ActivityView>
  /** Session ids the worklog agent is watching. Drives the red dot in the ring. */
  watchedSessions: Set<string>
  sidebarOpen: boolean
  browserOpen: boolean
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  /** Give a session tab a name (double-click or the menu); a blank name clears it. */
  onRenameTab: (id: string, title: string) => void
  /** Chrome's Close others / to the right / to the left, from the tab's context menu. */
  onCloseTabsSide: (anchorId: string, side: CloseSide) => void
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
  /**
   * What a tab says: `New · stoke` for a New tab aimed at a project, and the
   * agent a tab runs when it is not the default one (QA L16): `agent` always,
   * `agentTag` only while tags are shown. Omitted means the tab's own title.
   */
  labelFor?: (tab: Tab) => {
    text: string
    agentTag: string | null
    agent: CodingCliId | null
    /** The account the tab runs on, when it is not the agent's own sign-in (`tabLabel`). */
    account?: { key: string; text: string } | null
  }
  /** Settings › Agents › Show agent tags on tabs, for the tab menu's toggle. */
  agentTagsShown?: boolean
  onToggleAgentTags?: () => void
  /**
   * The Settings sheet is open right now.
   *
   * PX-26(c): opening Settings by any route OTHER than the phone
   * popover's own buttons (a shortcut, the gear icon) used to leave the
   * popover painted above the sheet, since only its own buttons ever called
   * `setOpen(false)`. Passed through so `PhonePopover` can close itself the
   * moment the sheet appears, however it got opened.
   */
  settingsOpen: boolean
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
  onRenameTab,
  onCloseTabsSide,
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
  onOpenPhoneSettings,
  labelFor,
  agentTagsShown = true,
  onToggleAgentTags,
  settingsOpen
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

  // The right-click menu (its anchor tab) and the inline rename in progress.
  // Both are transient UI, so they live here rather than on the tab model.
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  const titleOf = (tab: Tab): string => (labelFor?.(tab) ?? { text: tab.title }).text

  const startRename = (tab: Tab): void => {
    // A New tab has no conversation to name; renaming it would be renaming the
    // launcher. Session tabs only, the menu item disabled to match.
    if (tab.kind !== 'session') return
    setMenu(null)
    setDraft(titleOf(tab))
    setEditingId(tab.id)
  }
  const commitRename = (): void => {
    // Recreated each render, so `editingId`/`draft` are current. A second call
    // (Enter then the unmount's blur) is a no-op: `renameTab` skips an unchanged
    // name and `setEditingId(null)` is idempotent.
    if (editingId) onRenameTab(editingId, draft)
    setEditingId(null)
  }

  // Focus and select the rename field once it appears, not on every keystroke —
  // a select() per render would fight the caret.
  useEffect(() => {
    if (!editingId) return
    const el = renameRef.current
    el?.focus()
    el?.select()
  }, [editingId])

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

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : null

  return (
    <>
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
            const act = tab.kind === 'session' ? activity[tab.id] : undefined
            const dot = act?.dot ?? null
            const label = labelFor?.(tab) ?? { text: tab.title, agentTag: null, agent: null, account: null }
            const agentName = label.agent ? cliFor(label.agent).label : null
            const account = label.account ?? null
            return (
              <div
                key={tab.id}
                className="tab"
                role="tab"
                aria-selected={tab.id === activeTabId}
                data-activity={dot ?? undefined}
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
                // Double-click to rename, the standard tab gesture (session tabs only).
                onDoubleClick={() => startRename(tab)}
                // Right-click opens the tab menu; select the tab first so the menu
                // and any close acts on the tab under the cursor.
                onContextMenu={(e) => {
                  e.preventDefault()
                  onSelectTab(tab.id)
                  setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
                }}
                title={
                  tab.kind === 'new'
                    ? `${label.text} — press Enter on the page to start, or pick another folder`
                    : `${label.text}${agentName ? ` · running ${agentName}` : ''}${
                        account ? ` · on ${account.text}` : ''
                      }\n${tab.cwd}`
                }
              >
                <TabIndicator
                  kind={tab.kind}
                  context={ctx}
                  status={tab.status}
                  /*
                   * Only a CLI that takes Claude's flags is in a permission
                   * mode (the status bar's pill reads the same `capsFor`).
                   * A Codex tab records the launch choice it was handed but
                   * never ran with it, and drew bypass beads on its ring
                   * under a bypass default.
                   */
                  permissionMode={
                    capsFor(cliIdOf(tab.cliId)).launchFlags.permissionMode ? tab.permissionMode : 'default'
                  }
                  watched={watchedSessions.has(tab.sessionId)}
                />
                {editingId === tab.id ? (
                  <input
                    ref={renameRef}
                    className="tab-rename"
                    value={draft}
                    spellCheck={false}
                    maxLength={60}
                    aria-label="Rename tab"
                    onChange={(e) => setDraft(e.target.value)}
                    // Keep every press inside the field: the tab's own handlers
                    // select, start a drag, close on middle-click (onAuxClick), or
                    // open the tab menu on right-click (onContextMenu). Without the
                    // last two, a middle-click closes the tab mid-edit and a
                    // right-click hijacks the native text menu.
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onAuxClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitRename()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditingId(null)
                      }
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <span className="tab-label">{label.text}</span>
                )}
                {/*
                  The tab's agent, when it is not the default one: the tag, or
                  with tags off a rule along the tab's foot in the agent's
                  colour — so a Codex tab and a Claude tab in one folder still
                  differ at a glance (QA L16), as they do in the tooltip. The
                  colour shows only while more than one agent is in view.
                */}
                {label.agent &&
                  (label.agentTag ? (
                    <span className="tab-agent" {...agentMark(label.agent)} title={`Running ${agentName}`}>
                      {label.agentTag}
                    </span>
                  ) : (
                    <span className="tab-agent-rule" {...agentMark(label.agent)} aria-hidden="true" />
                  ))}
                {/*
                  The account, when it is not the agent's own sign-in: which
                  plan this session spends is not decoration, so it is drawn
                  with tags off too, in the account's own colour (its id is its
                  colour key, shared/accounts.ts).
                */}
                {account && (
                  <span className="tab-account" {...agentMark(account.key)} title={`On the account ${account.text}`}>
                    {account.text}
                  </span>
                )}
                {/*
                  Where this session is. Working (and a turn whose workflow
                  runs on in the background) pulses grey; waiting for you pulses
                  in the warning colour until it is answered, whether or not the
                  tab is in front; done is a solid accent dot, since you last
                  looked. Not red: red in the strip already says two things, a
                  ring past 60% and the worklog dot in its centre.
                */}
                {act && dot && (
                  <span
                    className="tab-activity"
                    data-state={dot}
                    title={act.detail ? `${act.label}: ${act.detail}` : act.label}
                  >
                    <span className="sr-only">{`${act.label.replace(/…$/, '')}. `}</span>
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
                  {/* label.text, not tab.title: a renamed tab's × must name the
                      custom title to a screen reader, like the strip does. */}
                  <span className="sr-only">Close {label.text}</span>
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
        <PhonePopover onOpenSettings={onOpenPhoneSettings} settingsOpen={settingsOpen} />
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

    {menu && menuTab && (
      <ContextMenu
        x={menu.x}
        y={menu.y}
        header={{
          title: titleOf(menuTab),
          // Where Claude was launched: the folder for a local session, the host
          // alias for SSH (its cwd IS the alias, gotcha 18), the aimed project
          // for a New tab. Omitted when there is none yet.
          subtitle: (menuTab.kind === 'new' ? menuTab.projectName : menuTab.cwd) || undefined
        }}
        items={buildTabMenu(tabs, menuTab, isMac, {
          onRename: startRename,
          onClose: onCloseTab,
          onCloseSide: onCloseTabsSide,
          // Only on a tab that has an agent tag to hide or show.
          agentTags:
            onToggleAgentTags && labelFor?.(menuTab).agent
              ? { shown: agentTagsShown, onToggle: onToggleAgentTags }
              : null
        })}
        onClose={() => setMenu(null)}
      />
    )}
    </>
  )
}

/**
 * The tab context menu's items — Rename, the agent-tag toggle on a tab that has
 * an agent to tag, then Chrome's four close actions.
 */
function buildTabMenu(
  tabs: Tab[],
  tab: Tab,
  isMac: boolean,
  on: {
    onRename: (t: Tab) => void
    onClose: (id: string) => void
    onCloseSide: (anchorId: string, side: CloseSide) => void
    agentTags: { shown: boolean; onToggle: () => void } | null
  }
): MenuItem[] {
  const idx = tabs.findIndex((t) => t.id === tab.id)
  const hasRight = idx >= 0 && idx < tabs.length - 1
  const hasLeft = idx > 0
  return [
    {
      label: 'Rename',
      hint: 'Double-click',
      // A New tab has no conversation to name (matches `startRename`).
      disabled: tab.kind !== 'session',
      onSelect: () => on.onRename(tab)
    },
    ...(on.agentTags
      ? [
          {
            label: on.agentTags.shown ? 'Hide agent tags' : 'Show agent tags',
            onSelect: on.agentTags.onToggle
          }
        ]
      : []),
    { label: 'Close', separated: true, hint: chordLabel('closeTab', isMac), onSelect: () => on.onClose(tab.id) },
    { label: 'Close others', disabled: tabs.length <= 1, onSelect: () => on.onCloseSide(tab.id, 'others') },
    { label: 'Close tabs to the right', disabled: !hasRight, onSelect: () => on.onCloseSide(tab.id, 'right') },
    { label: 'Close tabs to the left', disabled: !hasLeft, onSelect: () => on.onCloseSide(tab.id, 'left') }
  ]
}
