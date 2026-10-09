import type { CliInfo, NotificationMode, Settings, Theme } from '@shared/types'
import type { ResolvedProfile } from '@shared/profiles'
import { BUILT_IN_THEMES, resolveTheme } from '@shared/themes'
import {
  clampFontSize,
  clampTerminal,
  clampUiScale,
  type ZoomTarget,
  type FullScreenReveal,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  TERM_PADDING_MAX,
  TERMINAL_DEFAULTS,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  WALLPAPER_BLUR_MAX,
  WALLPAPER_DEFAULTS,
  WALLPAPER_DIM_MAX,
  WALLPAPER_OPACITY_MIN,
  clampWallpaper
} from '@shared/ui'
import { installedAgents } from '@shared/agents'
import { TOP_BAR_DEFAULTS } from '@shared/topBar'
import {
  ancestorsOf,
  navAgents,
  navTree,
  nodeIdOf,
  pathOf,
  resolveSettingsTarget,
  sameLocation,
  searchSettings,
  settingsEntries,
  visibleHolder,
  visibleNodes,
  type NavNode,
  type SettingsHit,
  type SettingsLocation,
  type SettingsTarget,
  type VisibleNode
} from '@shared/settingsIndex'
import { FieldHint } from './FieldHint'
import { IconClose } from './Icons'
import { Highlight } from './Highlight'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDraft } from '../lib/useDraft'
import { agentMark } from '../lib/agentColor'
import { flashSettingRow, markSettingHits } from '../lib/settingsJump'
import { HostsSettings } from './HostsSettings'
import { BrowserSettings } from './BrowserSettings'
import { ProfilesSettings } from './ProfilesSettings'
import { ClaudeCodeSettings } from './ClaudeCodeSettings'
import { ProvidersSettings } from './ProvidersSettings'
import { ThemeEditor } from './ThemeEditor'
import { RemoteSettings, SelfUpdateSettings, StokeCommandSettings, UpdatesSettings } from './RemoteSettings'
import { VoiceSettings } from './VoiceSettings'
import { AgentManager, AgentSettingsPage, ClaudeLaunchDefaults, type AgentPagesProps } from './AgentsSettings'
import { BackupSettings } from './BackupSettings'
import { AccountSyncSettings } from './AccountSyncSettings'
import { ChatHistorySettings } from './ChatHistorySettings'
import type { ChatDetection, ChatIndexStatus } from '@shared/chatIndex'
import type { CodingCliDetection, CodingCliId } from '@shared/codingClis'
import { WorklogSettings } from './WorklogSettings'
import { WorkPanel } from './WorkPanel'

/**
 * The zoom targets, worded as what they move rather than as their ids.
 *
 * "Both" first because it is the default and the one most people mean; the
 * hints say what the other two deliberately leave alone, since a zoom key that
 * visibly changes nothing is the failure mode here — pick "Interface" and the
 * terminal text genuinely will not move, because xterm takes its size in px
 * from the font setting and never from the interface scale.
 */
const ZOOM_TARGET_LABELS: { id: ZoomTarget; label: string; hint: string }[] = [
  { id: 'both', label: 'Both', hint: 'Interface scale and terminal font together' },
  { id: 'terminal', label: 'Terminal', hint: 'Terminal font only — the interface stays put' },
  { id: 'interface', label: 'Interface', hint: 'Interface only — the terminal text stays put' }
]

/**
 * What the tabs do about the menu bar macOS slides down over them in full
 * screen (gotcha 105). "Move tabs down" first, as the default: the room is
 * only taken while the menu bar is actually out.
 */
const FULL_SCREEN_REVEAL_LABELS: { id: FullScreenReveal; label: string; hint: string }[] = [
  { id: 'follow', label: 'Move tabs down', hint: 'The tabs slide below the menu bar while it is out, and back up as you move away from them' },
  { id: 'reserve', label: 'Keep room', hint: 'Always leave the menu bar its own space, so the tabs never move' },
  { id: 'off', label: 'Cover tabs', hint: "macOS's own behaviour: the menu bar slides over the tabs" }
]

/**
 * When a finished turn raises an OS notification. "In the background" is the
 * default: a notification for the tab you are looking at is noise, one for a
 * tab behind another — or a window behind another app — is the point.
 */
const NOTIFICATION_MODES: { id: NotificationMode; label: string; hint: string }[] = [
  {
    id: 'background',
    label: 'In the background',
    hint: 'Only for a tab you are not looking at, or when Stoke is behind another app'
  },
  { id: 'always', label: 'Always', hint: 'Every finished turn, even for the tab in front' },
  { id: 'off', label: 'Off', hint: 'Never. The dot in the tab strip still shows' }
]

/*
 * The settings menu.
 *
 * This used to be one 26rem drawer holding every section end to end, and the
 * problem was not that it was long — it was that length was the only structure
 * it had. Splitting it into named sections cost a click and bought an answer to
 * "where is X" that did not involve scrolling; the groups run from what you
 * change to what merely reports.
 *
 * Two things now answer "where is X" faster than reading the menu:
 *
 * - A search box at the top of the menu. It finds any page or row by what it
 *   is called, what people call it instead, and where it is
 *   (shared/settingsIndex.ts), lists them in the menu's place while there is a
 *   query, and jumps to the row — scrolled into the middle of the pane, any
 *   closed disclosure around it opened, and flashed. Cmd+K finds the same rows.
 * - A tree rather than a flat list. Agents opens to the Agent manager and each
 *   installed agent; Claude Code opens to its launch defaults, its settings
 *   file and its provider and keys, which were three separate rows (and a
 *   pointer in Sessions) before. The old section ids all still land
 *   (`resolveSettingsTarget`).
 *
 * `hint` is the nav item's tooltip and does the job a subtitle would without
 * making every row two lines tall.
 */

/** A row to scroll to and flash when the page opens (from the palette). */
export interface SettingsRowTarget {
  id: string
  /** Where to land when `id` is not drawn right now. */
  fallback: string | null
}

interface Props {
  settings: Settings
  /**
   * The resolved profile list, passed in rather than derived here so the worklog
   * checkboxes and the sidebar chips can never disagree about which profiles
   * exist.
   */
  profiles: ResolvedProfile[]
  /** Resolved default working directory, shown when none is configured. */
  defaultCwd: string
  cli: CliInfo | null
  onPatch: (patch: Partial<Settings>) => void
  onAddRoot: () => void
  /** Forwarded to ProfilesSettings; see the comment on its `onCreated` prop. */
  onProfileCreated: () => void | Promise<void>
  /**
   * State the theme the window should paint, or `null` for the saved one.
   *
   * Threaded down to `ThemeEditor` rather than let it paint for itself, because
   * `lib/theme.ts` keeps exactly one writer of colour onto `:root` and a second
   * one is what the accent bug in `applyAppearance`'s comment already cost.
   */
  onPreviewTheme: (theme: Theme | null) => void
  /**
   * The coding-agent detection App already holds, and the three things the
   * Agents pages can ask App to do. App owns them because the picker,
   * the launcher row and an install tab all read the same detection.
   */
  agents: {
    detection: CodingCliDetection | null
    /** Settles when the look is done, so "Look again" can say it is looking. */
    onRefresh: () => Promise<void>
    onOpenPicker: () => void
    onInstall: (ids: CodingCliId[]) => void
    /** Open an account's sign-in tab (shared/accounts.ts). App's, because it opens a tab. */
    onSignIn: (accountId: string) => void
    /** An agent's colour while its picker moves, unsaved; App paints it (null withdraws). */
    onPreviewColor: (id: CodingCliId, hex: string | null) => void
  }
  /**
   * Which page to open on. Other panels say "open Settings" and used to land on
   * Appearance regardless of what they were talking about. Absent means a plain
   * open: Appearance, with the search box focused.
   */
  initialSection?: SettingsTarget
  /** A row on that page to scroll to and flash — a pick from the command palette. */
  initialRow?: SettingsRowTarget | null
  /**
   * Which of the menu's nodes are open (Agents, Claude Code). App's, not the
   * sheet's: the sheet is remounted on every open, and the menu should come
   * back the way it was left for as long as the app runs.
   */
  expanded: readonly string[]
  /** Open or close menu nodes. A functional update in App, so two in one tick both land. */
  onExpand: (ids: readonly string[], open: boolean) => void
  /**
   * "Restart and install" for Stoke's own update. App's, not a direct IPC call,
   * because only App knows whether a turn is running anywhere — and restarting
   * over one loses it, so App asks first.
   */
  onRestartToUpdate: () => void
  /**
   * SSH hosts' "Set up key login" and the host it is running for. App's,
   * because the enrollment opens a tab and the guard lives beside the strip
   * that reports it.
   */
  sshKeys: {
    enrollingHostId: string | null
    onSetUpKey: (hostId: string) => void
  }
  /** Chat history's status and detection, which App holds for the offer and the sidebar too. */
  chats: { status: ChatIndexStatus | null; detection: ChatDetection | null }
  /**
   * Appearance › Title bar's "Customise on the title bar…": App closes the
   * sheet, turns the items on and leaves the bar in edit mode — the editor is
   * the bar itself.
   */
  onCustomiseTitleBar: () => void
  onClose: () => void
}

/**
 * What Tab can reach. `summary` is in the list because every disclosure in this
 * sheet is a native <details>, and its summary is the thing that opens it.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** How many results the menu lists for one query. More than fit is a query that needs another word. */
const RESULT_LIMIT = 40

export function SettingsSheet({
  settings,
  profiles,
  defaultCwd,
  cli,
  onPatch,
  onAddRoot,
  onProfileCreated,
  onPreviewTheme,
  initialSection,
  initialRow,
  expanded,
  onExpand,
  agents,
  onRestartToUpdate,
  sshKeys,
  chats,
  onCustomiseTitleBar,
  onClose
}: Props): React.JSX.Element {
  const themes: Theme[] = [...BUILT_IN_THEMES, ...settings.customThemes]
  const [loc, setLoc] = useState<SettingsLocation>(() => resolveSettingsTarget(initialSection))

  /*
   * The agents the menu lists: Claude Code, then every installed one — plus
   * the agent whose page is open, if it is not installed, so the page on
   * screen always has a row. A string key, so the tree and the search entries
   * are rebuilt only when that list changes, not on every detection push.
   */
  const installed = installedAgents(agents.detection?.clis ?? [], cli?.ok === true)
  const menuAgents = navAgents(installed, loc.page === 'agent' ? (loc.agent ?? null) : null)
  const agentsKey = menuAgents.join(',')
  const tree = useMemo(() => navTree(menuAgents), [agentsKey])
  const open = useMemo(() => new Set(expanded), [expanded])
  const visible = useMemo(() => visibleNodes(tree, open), [tree, open])
  const holder = visibleHolder(visible, loc)
  const current = nodeIdOf(loc)

  /*
   * A pending jump: the row to show once the page it is on has rendered. A
   * sequence number, so jumping to the row already flashed flashes it again.
   */
  const [jump, setJump] = useState<{ row: SettingsRowTarget; focus: boolean; seq: number } | null>(() =>
    initialRow ? { row: initialRow, focus: true, seq: 0 } : null
  )
  const seqRef = useRef(1)

  /**
   * The one way the sheet moves: to a page, with its menu ancestors opened so
   * its row is on screen, and optionally to a row on it.
   */
  const go = useCallback(
    (next: SettingsLocation, row?: SettingsRowTarget | null, focus = false): void => {
      const up = ancestorsOf(next)
      if (up.length) onExpand(up, true)
      // The same page keeps its object, so going where you already are moves nothing.
      setLoc((cur) => (sameLocation(cur, next) ? cur : next))
      if (row) setJump({ row, focus, seq: seqRef.current++ })
    },
    [onExpand]
  )

  // The page opened on may sit under a node that was closed since.
  useEffect(() => {
    const up = ancestorsOf(loc)
    if (up.length && up.some((id) => !open.has(id))) onExpand(up, true)
    // Only on open: after that, closing Agents over the page on show is allowed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * The scrolling pane, reset to the top on every page change.
   *
   * Without this a tall section scrolled halfway down leaves the next one
   * opening mid-content, which reads as a section with its heading missing
   * rather than as retained scroll position. A jump scrolls again after this.
   *
   * Keyed on the page's node id, a string, not the `loc` object: a press on the
   * menu row of the page already on show, or a search pick on it, is not a
   * page change, and resetting then threw away the reader's place (and made a
   * pick snap to the top before scrolling back down to its row).
   */
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 })
  }, [current])

  // Show the row a jump named, once its page has drawn it (settingsJump.ts).
  useEffect(() => {
    if (!jump) return
    const pane = paneRef.current
    if (!pane) return
    return flashSettingRow(pane, jump.row.id, jump.row.fallback, { focus: jump.focus })
  }, [jump])

  /* ------------------------------------------------------------- search */

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => settingsEntries({ agents: menuAgents, platform: window.stoke.platform }), [agentsKey])
  const hits = useMemo(() => searchSettings(entries, query).slice(0, RESULT_LIMIT), [entries, query])
  const searching = query.trim() !== ''

  useEffect(() => {
    setActive(0)
  }, [query])

  // Keep the active result inside the list's scroll viewport.
  useEffect(() => {
    const el = resultsRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  /*
   * While there is a query, every row of the page on show that it matches is
   * marked, so the pane answers "which one is it" as well as the list does.
   */
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const rows = new Set(
      searching ? hits.filter((h) => h.entry.row && sameLocation(h.entry.loc, loc)).map((h) => h.entry.row as string) : []
    )
    return markSettingHits(pane, rows)
  }, [hits, loc, searching])

  const pick = (hit: SettingsHit | undefined, focus: boolean): void => {
    if (!hit) return
    const row = hit.entry.row ? { id: hit.entry.row, fallback: hit.entry.fallback } : null
    go(hit.entry.loc, row, focus)
  }

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault()
      setActive((i) => Math.min(hits.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Enter goes to the row and puts the keyboard on its control, which is
      // what the search was for; Cmd+F comes back to the query.
      pick(hits[active], true)
    } else if (e.key === 'Escape' && query) {
      /*
       * Escape clears a query before it closes anything. Stopped here so App's
       * window listener, which closes the sheet on Escape, never sees it; with
       * the box already empty it goes through and closes the sheet as before.
       */
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  /* ------------------------------------------------------- focus and Tab */

  /*
   * Focus moves into the dialog when it opens, and Tab stays inside it.
   *
   * `aria-modal` is a promise to assistive technology and nothing else: it
   * does not move focus and it does not stop Tab walking out. A plain open
   * puts the keyboard in the search box, since typing is the fastest way to
   * anything here; an open aimed at a page puts it on that page's menu row, so
   * the sheet announces where something else chose to bring you; an open aimed
   * at a row puts it on the row's control (the jump effect does that).
   */
  const modalRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = modalRef.current
    if (!root || initialRow) return
    if (!initialSection) {
      searchRef.current?.focus()
      return
    }
    const selected = root.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
    ;(selected ?? root).focus()
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onModalKey = (e: React.KeyboardEvent): void => {
    // Cmd+F / Ctrl+F: back to the search box from anywhere in the sheet.
    const primary = window.stoke.platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    if (primary && !e.altKey && !e.shiftKey && e.code === 'KeyF') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    if (e.key !== 'Tab') return
    const root = modalRef.current
    if (!root) return
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      // `offsetParent` is null for anything inside a closed <details>, which is
      // most of the Remote and Hosts sections at any moment.
      (el) => el.offsetParent !== null
    )
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const activeEl = document.activeElement
    if (!e.shiftKey && activeEl === last) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && (activeEl === first || activeEl === root)) {
      e.preventDefault()
      last.focus()
    }
  }

  /* ---------------------------------------------------------------- tree */

  /*
   * The menu's one tab stop (a roving tabindex): the row last focused while it
   * is still on screen, else the row that holds the page on show.
   */
  const [focusId, setFocusId] = useState<string | null>(null)
  const tabStop = focusId && visible.some((v) => v.node.id === focusId) ? focusId : (holder ?? visible[0]?.node.id)
  const treeRef = useRef<HTMLDivElement>(null)

  /*
   * The menu row of the page on show stays in sight. With Agents open the menu
   * is taller than its column, so a jump to a page low in it (Backup &
   * transfer, Account & sync, Updates) from the palette, or a search cleared
   * after a pick there, showed the page with nothing in the menu selected
   * (found in review, 2026-10-02). On every page change, and whenever the tree
   * comes back from the results list.
   */
  useEffect(() => {
    if (searching) return
    treeRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, searching])

  const focusNode = (id: string): void => {
    treeRef.current?.querySelector<HTMLElement>(`[data-node="${id}"]`)?.focus()
  }

  const toggle = (id: string): void => onExpand([id], !open.has(id))

  /**
   * A click or Enter on a row. Agents only opens and closes. Claude Code is a
   * page AND a parent: the first press goes to its page and opens it, a press
   * on it while its page is on show opens or closes it.
   */
  const activate = (node: NavNode): void => {
    if (!node.loc) {
      toggle(node.id)
      return
    }
    if (node.children) {
      if (sameLocation(node.loc, loc)) toggle(node.id)
      else {
        go(node.loc)
        if (!open.has(node.id)) onExpand([node.id], true)
      }
      return
    }
    go(node.loc)
  }

  /*
   * A tree's keys (WAI-ARIA's tree pattern): Up and Down walk the rows on
   * screen and wrap, as the old flat menu did; Right opens a closed parent or
   * steps into an open one; Left closes an open one or steps out to its
   * parent; Home and End go to the ends. Moving onto a page shows it — focus
   * follows selection, so a screen reader hears the page it moved to. A
   * printable key starts a search, which is the type-ahead worth having here.
   */
  const onTreeKey = (e: React.KeyboardEvent): void => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-node]')?.dataset.node
    const i = visible.findIndex((v) => v.node.id === id)
    if (i < 0) return
    const here = visible[i]
    const moveTo = (v: VisibleNode | undefined): void => {
      if (!v) return
      focusNode(v.node.id)
      if (v.node.loc && !sameLocation(v.node.loc, loc)) go(v.node.loc)
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveTo(visible[(i + 1) % visible.length])
        return
      case 'ArrowUp':
        e.preventDefault()
        moveTo(visible[(i - 1 + visible.length) % visible.length])
        return
      case 'Home':
        e.preventDefault()
        moveTo(visible[0])
        return
      case 'End':
        e.preventDefault()
        moveTo(visible[visible.length - 1])
        return
      case 'ArrowRight':
        if (!here.node.children) return
        e.preventDefault()
        if (!open.has(here.node.id)) onExpand([here.node.id], true)
        else moveTo(visible[i + 1])
        return
      case 'ArrowLeft':
        e.preventDefault()
        if (here.node.children && open.has(here.node.id)) onExpand([here.node.id], false)
        else if (here.parent) moveTo(visible.find((v) => v.node.id === here.parent))
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        activate(here.node)
        return
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      setQuery((q) => q + e.key)
      searchRef.current?.focus()
    }
  }

  const agentProps: AgentPagesProps = {
    settings,
    onPatch,
    detection: agents.detection,
    claudeRunnable: cli?.ok === true,
    onRefresh: agents.onRefresh,
    onOpenPicker: agents.onOpenPicker,
    onInstall: agents.onInstall,
    onSignIn: agents.onSignIn,
    onGo: (next) => go(next),
    onPreviewColor: agents.onPreviewColor
  }

  /*
   * The default folder, committed on blur rather than per keystroke. Typed into
   * character by character it wrote a settings file — and a round trip to disk
   * re-renders the controlled value, so characters typed during one were
   * dropped. `useDraft`'s own comment has the full account.
   */
  const cwdField = useDraft(settings.defaultCwd ?? '', (v) =>
    onPatch({ defaultCwd: v.trim() || null })
  )
  const scratchRef = useRef(settings.scratch)
  scratchRef.current = settings.scratch
  const patchScratch = (patch: Partial<Settings['scratch']>): void => {
    scratchRef.current = { ...scratchRef.current, ...patch }
    onPatch({ scratch: scratchRef.current })
  }
  const scratchField = useDraft(settings.scratch.directory ?? '', (value) =>
    patchScratch({ directory: value.trim() || null, legacyLocation: false })
  )
  const [scratchRoot, setScratchRoot] = useState('')
  useEffect(() => {
    let live = true
    void window.stoke.workspace.scratchRoot().then((root) => { if (live) setScratchRoot(root) }, () => { if (live) setScratchRoot('Unavailable') })
    return () => { live = false }
  }, [settings.scratch.directory, settings.scratch.legacyLocation])

  /**
   * What the Interface scale box shows while it is being typed into.
   *
   * Null means "show the stored value" — the ordinary state, and where it
   * returns on blur. See the comment on the input itself.
   */
  const [scaleDraft, setScaleDraft] = useState<string | null>(null)

  /*
   * Offer the Host aliases the user already has rather than making them retype
   * connection details. Read once when the sheet opens; ~/.ssh/config is not
   * something that changes while it is on screen.
   */
  const [sshAliases, setSshAliases] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void window.stoke.ssh.configHosts().then((a) => {
      if (live) setSshAliases(a)
    })
    return () => {
      live = false
    }
  }, [])

  /*
   * Escape is NOT bound here for closing. App.tsx already owns it for every
   * overlay ("closes whichever overlay is on top") and unmounts this component
   * outright — which several sections below depend on: WorklogSettings and
   * RemoteSettings each flush a draft field on unmount precisely because React
   * delivers no blur to a node that is disappearing. The one Escape handled
   * here is the search box's, which clears a query and stops there.
   */

  const crumbs = pathOf(loc)

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onModalKey}
      >
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close settings (Esc)">
            <IconClose />
            <span className="sr-only">Close settings</span>
          </button>
        </div>

        <div className="settings-cols">
          <nav className="settings-nav" aria-label="Settings sections">
            {/*
              A combobox over the results list below it. The list replaces the
              menu while there is a query, in the same column, so nothing else
              in the sheet moves as you type.
            */}
            <div className="settings-search">
              <input
                ref={searchRef}
                className="input settings-search-input"
                type="search"
                placeholder="Search settings"
                aria-label="Search settings"
                role="combobox"
                aria-expanded={searching && hits.length > 0}
                aria-controls={searching && hits.length > 0 ? 'settings-search-results' : undefined}
                aria-autocomplete="list"
                aria-activedescendant={searching && hits[active] ? `settings-hit-${active}` : undefined}
                value={query}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
              />
              {/*
                Mounted for the sheet's whole life and empty with no query, so
                the first count is a CHANGE a screen reader announces — a live
                region mounted with its text already in it is usually skipped.
                Outside the listbox, which may hold only options.
              */}
              <span className="sr-only" role="status" aria-live="polite">
                {!searching ? '' : hits.length === 0 ? 'No matching settings' : `${hits.length} matching settings`}
              </span>
            </div>

            {searching && hits.length === 0 ? (
              // The same track as the results, so nothing moves; not a listbox, as it lists nothing.
              <div className="settings-results">
                <p className="settings-results-empty">Nothing in Settings matches &ldquo;{query.trim()}&rdquo;.</p>
              </div>
            ) : searching ? (
              <div className="settings-results" id="settings-search-results" role="listbox" aria-label="Matching settings" ref={resultsRef}>
                {hits.map((h, i) => {
                  const here = sameLocation(h.entry.loc, loc)
                  return (
                    <button
                      key={h.entry.key}
                      id={`settings-hit-${i}`}
                      data-index={i}
                      className="settings-result"
                      role="option"
                      aria-selected={i === active}
                      data-here={here ? 'true' : undefined}
                      tabIndex={-1}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setActive(i)
                        pick(h, false)
                      }}
                      {...(h.entry.loc.page === 'agent' && !h.entry.row ? agentMark(h.entry.loc.agent) : {})}
                    >
                      <span className="settings-result-label">
                        {h.entry.loc.page === 'agent' && !h.entry.row && <span className="agent-tab-dot" aria-hidden="true" />}
                        {/*
                          Its own span: the label row is a flex box (for the
                          dot), and a flex box makes every text run and <mark>
                          an item of its own, so its gap landed between "SSH"
                          and " hosts".
                        */}
                        <span>
                          <Highlight text={h.entry.label} ranges={h.ranges} />
                        </span>
                      </span>
                      <span className="settings-result-path">
                        {h.entry.path.length ? h.entry.path.join(' › ') : h.entry.row ? '' : 'Section'}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              /*
               * One `tree` per group, for the reason there was one `tablist`
               * per group before: a heading inside a single tree would have
               * to be hidden from assistive technology to stay valid, which
               * deletes the grouping for exactly the readers who cannot see
               * the indentation. The rows are flat siblings with
               * `aria-level`/`aria-setsize`/`aria-posinset` rather than nested
               * groups, so the arrow keys walk the DOM order and the order on
               * screen as one list; the key handler sits on the wrapper above
               * all four trees, so they still read as one run.
               */
              <div className="settings-tree" ref={treeRef} onKeyDown={onTreeKey}>
                {tree.map((g) => {
                  const titleId = `settings-group-${g.title.toLowerCase()}`
                  return (
                    <div className="settings-nav-group" key={g.title}>
                      <div className="settings-nav-group-title" id={titleId}>
                        {g.title}
                      </div>
                      <div role="tree" aria-labelledby={titleId}>
                        {visible
                          .filter((v) => v.group === g.title)
                          .map((v) => {
                            const isCurrent = v.node.id === current
                            const mark = v.node.agent ? agentMark(v.node.agent) : {}
                            return (
                              <button
                                key={v.node.id}
                                role="treeitem"
                                data-node={v.node.id}
                                id={`settings-node-${v.node.id.replace(':', '-')}`}
                                aria-level={v.level}
                                aria-setsize={v.setSize}
                                aria-posinset={v.posInSet}
                                aria-expanded={v.node.children ? open.has(v.node.id) : undefined}
                                aria-selected={v.node.loc ? isCurrent : undefined}
                                aria-current={isCurrent ? 'page' : undefined}
                                data-holds={!isCurrent && holder === v.node.id ? 'true' : undefined}
                                tabIndex={v.node.id === tabStop ? 0 : -1}
                                title={v.node.hint}
                                data-agent={mark['data-agent']}
                                style={{ ...mark.style, ['--nav-level' as string]: v.level }}
                                onFocus={() => setFocusId(v.node.id)}
                                onClick={() => activate(v.node)}
                              >
                                {v.node.children && (
                                  <span
                                    className="settings-nav-caret"
                                    aria-hidden="true"
                                    onClick={(e) => {
                                      // The caret only opens and closes, even on Claude Code.
                                      e.stopPropagation()
                                      toggle(v.node.id)
                                    }}
                                  />
                                )}
                                {v.node.agent && <span className="agent-tab-dot" aria-hidden="true" />}
                                <span className="settings-nav-label">{v.node.label}</span>
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </nav>

          <div
            className="settings-pane"
            ref={paneRef}
            role="region"
            id="settings-pane"
            aria-label={crumbs.join(' › ')}
            // Focusable so the pane itself can be scrolled from the keyboard
            // when the section it holds is all read-only text.
            tabIndex={0}
          >
            {crumbs.length > 1 && (
              <div className="settings-crumbs" aria-hidden="true">
                {crumbs.map((c, i) => (
                  <span key={c + i} className="settings-crumb">
                    {c}
                  </span>
                ))}
              </div>
            )}

            {loc.page === 'appearance' && (
              <>
                <ThemeEditor
                  settings={settings}
                  allThemes={themes}
                  onPatch={onPatch}
                  onPreviewTheme={onPreviewTheme}
                />

                <ClaudeThemeToggle appearance={resolveTheme(settings.themeId, settings.customThemes).appearance} />

                <WallpaperField settings={settings} onPatch={onPatch} />

                {/*
                  Offered on macOS too, where it does nothing, and that is
                  deliberate: the brand is never drawn beside the traffic
                  lights, so hiding the row on a Mac would make a setting that
                  exists on one of your machines and not another — and nobody
                  can search for a row that is not there. The hint says so.
                */}
                <label className="check-row" data-setting="appearance.brand">
                  <input
                    type="checkbox"
                    checked={settings.showBrand}
                    onChange={(e) => onPatch({ showBrand: e.target.checked })}
                  />
                  <span>
                    <span className="field-label">Show the Stoke mark in the title bar</span>
                    <FieldHint>
                      {window.stoke.platform === 'darwin'
                        ? 'Windows and Linux only — on macOS that corner belongs to the traffic lights.'
                        : 'The mark and name in the top-left corner.'}
                    </FieldHint>
                  </span>
                </label>

                {/*
                  The title bar's own items. The editor is the bar itself
                  (drag, Alt+arrows, Delete, + Add); this row turns them on and
                  off, opens that editor, and puts the default back.
                */}
                <div className="field" data-setting="appearance.title-bar">
                  <span className="field-label">Title bar</span>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={settings.topBar.enabled}
                      onChange={(e) => onPatch({ topBar: { ...settings.topBar, enabled: e.target.checked } })}
                    />
                    <span>
                      <span className="field-label">Show git and text shortcuts in the title bar</span>
                      <FieldHint>
                        Between the tabs and the buttons on the right. A shortcut types its text into the session in
                        front; one marked to send presses Enter too.
                      </FieldHint>
                    </span>
                  </label>
                  <div className="btn-row">
                    <button className="btn" onClick={onCustomiseTitleBar}>
                      Customise on the title bar…
                    </button>
                    <button
                      className="btn"
                      data-variant="ghost"
                      onClick={() =>
                        onPatch({ topBar: { enabled: true, items: TOP_BAR_DEFAULTS.items.map((i) => ({ ...i })) } })
                      }
                    >
                      Reset to the default (git)
                    </button>
                  </div>
                </div>

                <div className="field" data-setting="appearance.interface-scale">
                  <span className="field-label">Interface scale</span>
                  {/*
                    min/max are advisory inside React's onChange — the browser will
                    not stop a typed or pasted value reaching the handler — so the
                    same clamp the store enforces is applied here too, and the two
                    bounds come from one place. The field used to offer 8-28 for a
                    store that accepts 9-24, and to fall back with `|| 1`, which
                    turned a typed 0 into 1 rather than into the floor.
                  */}
                  {/*
                    A local draft while the box has focus, because clamping every
                    keystroke made the field unusable to type into. An empty
                    <input type="number"> reports value "", `Number("")` is 0, and
                    0 is finite — so `clampUiScale` returned the FLOOR rather than
                    rejecting it. Selecting the contents and typing a new number
                    therefore shrank the entire interface to 0.8 on the first
                    keypress, under the very field being typed into, and the same
                    happened at every intermediate state a number field reports as
                    empty (a lone "1." among them).

                    The draft is only what is displayed. onChange applies every
                    non-empty value live; onBlur commits valid values through the
                    clamp and reverts invalid or empty ones by clearing the draft.
                    A pasted 99 is still bounded — the browser's own min/max are
                    advisory inside onChange and cannot be relied on.
                  */}
                  <input
                    className="input"
                    type="number"
                    min={UI_SCALE_MIN}
                    max={UI_SCALE_MAX}
                    step={0.05}
                    value={scaleDraft ?? settings.uiScale}
                    onChange={(e) => {
                      setScaleDraft(e.target.value)
                      // Still applied live when the box holds a real number, so
                      // the spinner arrows and a fully typed value keep their
                      // immediate feedback.
                      if (e.target.value.trim() !== '') {
                        onPatch({ uiScale: clampUiScale(e.target.value) })
                      }
                    }}
                    onBlur={() => {
                      if (scaleDraft !== null) {
                        // Only patch if the draft is a valid number; otherwise just
                        // revert the display by clearing the draft state. onChange
                        // has already applied every non-empty value live.
                        if (scaleDraft.trim() !== '' && Number.isFinite(Number(scaleDraft))) {
                          onPatch({ uiScale: clampUiScale(scaleDraft) })
                        }
                      }
                      setScaleDraft(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }}
                  />
                  <span className="field-hint">Scales everything except the terminal contents.</span>
                </div>

                {/*
                  Which of the two sizes above the zoom keys move. Offered rather than
                  decided, because both answers are the convention somewhere: a
                  terminal scales only its font, an editor scales everything, and
                  Stoke is an editor-shaped app full of terminal-shaped content.
                */}
                <div className="field" data-setting="appearance.zoom-keys">
                  <span className="field-label">Zoom keys change</span>
                  <div
                    className="segmented"
                    role="group"
                    aria-label="What the zoom shortcut changes"
                  >
                    {ZOOM_TARGET_LABELS.map((z) => (
                      <button
                        key={z.id}
                        aria-pressed={settings.zoomTarget === z.id}
                        title={z.hint}
                        onClick={() => onPatch({ zoomTarget: z.id })}
                      >
                        {z.label}
                      </button>
                    ))}
                  </div>
                  <span className="field-hint">
                    {window.stoke.platform === 'darwin' ? 'Cmd' : 'Ctrl'} with <kbd>+</kbd>,{' '}
                    <kbd>−</kbd> or <kbd>0</kbd> to reset.
                  </span>
                </div>

                {/* Offered everywhere, like the brand row above, and for the same reason. */}
                <div className="field" data-setting="appearance.full-screen">
                  <span className="field-label">Menu bar in full screen</span>
                  <div
                    className="segmented"
                    role="group"
                    aria-label="What the tabs do when the full-screen menu bar slides down"
                  >
                    {FULL_SCREEN_REVEAL_LABELS.map((r) => (
                      <button
                        key={r.id}
                        aria-pressed={settings.fullScreenReveal === r.id}
                        title={r.hint}
                        onClick={() => onPatch({ fullScreenReveal: r.id })}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <span className="field-hint">
                    {window.stoke.platform === 'darwin'
                      ? 'macOS slides the menu bar down over the tabs when the pointer reaches the top.'
                      : 'macOS only — full screen elsewhere has no menu bar to cover the tabs.'}
                  </span>
                </div>
              </>
            )}

            {loc.page === 'terminal' && (
              <TerminalSettingsPane settings={settings} onPatch={onPatch} />
            )}

            {loc.page === 'sessions' && (
              <>
                {/*
                  Claude Code's four launch defaults — permissions, model,
                  effort, Ultracode — are a page of their own under Agents ›
                  Claude Code now. Still `settings.defaults`, still one writer
                  (gotcha 57); this says where they went.
                */}
                <div className="field">
                  <span className="field-label">Launch defaults</span>
                  <span className="field-hint">
                    Claude Code&rsquo;s default permissions, model, effort and Ultracode are under
                    Agents › Claude Code, beside every other agent&rsquo;s default model.
                  </span>
                  <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
                    <button className="btn" onClick={() => go({ page: 'claude-launch' })}>
                      Open Agents › Claude Code › Launch defaults
                    </button>
                  </div>
                </div>

                <div className="field" data-setting="sessions.default-folder">
                  <span className="field-label">Default folder</span>
                  <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
                    <input
                      className="input mono"
                      placeholder={defaultCwd}
                      value={cwdField.draft}
                      spellCheck={false}
                      onChange={(e) => cwdField.setDraft(e.target.value)}
                      onBlur={cwdField.onBlur}
                      onKeyDown={cwdField.onKeyDown}
                    />
                    <button
                      className="btn"
                      onClick={async () => {
                        const dir = await window.stoke.pickFolder()
                        if (dir) onPatch({ defaultCwd: dir })
                      }}
                    >
                      Choose
                    </button>
                  </div>
                  <span className="field-hint">
                    Where <b>Start here</b> opens a session when no project is selected. Leave it
                    empty to auto-detect — currently <span className="mono">{defaultCwd}</span>.
                  </span>
                </div>

                <div className="field" data-setting="sessions.scratch-folder">
                  <label className="field-label" htmlFor="scratch-folder">Scratch folder</label>
                  <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
                    <input id="scratch-folder" className="input mono" placeholder={scratchRoot}
                      value={scratchField.draft} spellCheck={false}
                      onChange={(event) => scratchField.setDraft(event.target.value)}
                      onBlur={scratchField.onBlur} onKeyDown={scratchField.onKeyDown} />
                    <button className="btn" onClick={async () => {
                      const directory = await window.stoke.pickFolder()
                      if (directory) patchScratch({ directory, legacyLocation: false })
                    }}>Choose</button>
                    <button className="btn" onClick={() => patchScratch({ directory: null, legacyLocation: false })}>Use home</button>
                  </div>
                  <span className="field-hint">New scratch sessions go to <span className="mono">{scratchRoot}</span>. Existing folders stay in their current location.</span>
                </div>
                <label className="check-row" data-setting="sessions.scratch-name">
                  <input type="checkbox" checked={settings.scratch.autoName}
                    onChange={(event) => patchScratch({ autoName: event.target.checked })} />
                  <span><span className="field-label">Name scratch projects automatically</span>
                    <span className="field-hint">Use the first Claude Code prompt or title for the sidebar label. Keeps the folder path and your custom names.</span></span>
                </label>

                <label className="check-row" data-setting="sessions.start-on-launch">
                  <input
                    type="checkbox"
                    checked={settings.startOnLaunch}
                    onChange={(e) => onPatch({ startOnLaunch: e.target.checked })}
                  />
                  <span>
                    <span className="field-label">Start a session on launch</span>
                    <span className="field-hint">
                      Opens a session in the default folder the moment Stoke starts, so the app is
                      never sitting on an empty screen.
                    </span>
                  </span>
                </label>

                <div className="field" data-setting="sessions.notifications">
                  <span className="field-label">Notify me when Claude finishes</span>
                  <div className="segmented" role="group" aria-label="Notifications">
                    {NOTIFICATION_MODES.map((n) => (
                      <button
                        key={n.id}
                        aria-pressed={settings.notifications === n.id}
                        title={n.hint}
                        onClick={() => onPatch({ notifications: n.id })}
                      >
                        {n.label}
                      </button>
                    ))}
                  </div>
                  <span className="field-hint">
                    A system notification when a turn ends or Claude asks for something. The tab
                    shows a dot either way, so a session you are not looking at can be left to run.
                  </span>
                </div>

                <label className="check-row" data-setting="sessions.status-line">
                  <input
                    type="checkbox"
                    checked={settings.hideStatusLine}
                    onChange={(e) => onPatch({ hideStatusLine: e.target.checked })}
                  />
                  <span>
                    <span className="field-label">Hide Claude&rsquo;s status line in Stoke</span>
                    {/*
                      Ninety words, folded to eleven. Every sentence below is
                      true and none of it can be worked out from the label —
                      which is exactly the case FieldHint exists for: all of it
                      arriving at once is what made the pane read as an essay.
                    */}
                    <FieldHint
                      more={
                        <>
                          Stoke installs its own status line to read the context window and your
                          plan limits from what the CLI pipes to it, and prints an empty line
                          back, because the line duplicates chrome the app already draws. The
                          footer then sits directly under the input box, as with no status line
                          at all — except for &ldquo;? for shortcuts&rdquo;, which Claude Code
                          itself leaves out whenever any status line is set. Turn this off to
                          keep your own: it still runs and still shows exactly what it did
                          before. Your <span className="mono">~/.claude/settings.json</span> is
                          never modified either way, and the change reaches running sessions within
                          a second. Plan limits additionally need a Claude.ai sign-in rather than
                          an API key — under an API key the CLI sends none, so they stay blank
                          however this is set.
                        </>
                      }
                    >
                      The chrome above already shows the context ring and your plan limits.
                    </FieldHint>
                  </span>
                </label>
              </>
            )}

            {loc.page === 'browser' && <BrowserSettings browser={settings.browser} />}

            {loc.page === 'chats' && (
              <ChatHistorySettings settings={settings} onPatch={onPatch} status={chats.status} detection={chats.detection} />
            )}

            {loc.page === 'projects' && (
              <>
                <div className="field" data-setting="projects.roots">
                  <span className="field-label">Scanned folders</span>
                  {settings.projectRoots.length === 0 && (
                    <span className="field-hint">
                      None yet. Add a folder such as your code directory and every project inside it
                      appears in the sidebar, even ones Claude has never opened.
                    </span>
                  )}
                  {settings.projectRoots.map((root) => (
                    <div
                      key={root}
                      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}
                    >
                      <span className="mono truncate" style={{ flex: 1, fontSize: 'var(--fs-xs)' }}>
                        {root}
                      </span>
                      <button
                        className="icon-btn"
                        data-size="sm"
                        title={`Stop scanning ${root}`}
                        onClick={() =>
                          onPatch({ projectRoots: settings.projectRoots.filter((r) => r !== root) })
                        }
                      >
                        <IconClose />
                        <span className="sr-only">Remove {root}</span>
                      </button>
                    </div>
                  ))}
                  <button className="btn" onClick={onAddRoot}>
                    Add a folder
                  </button>
                </div>

                <div className="field" data-setting="projects.hidden">
                  <span className="field-label">Hidden projects</span>
                  {settings.hiddenProjects.length > 0 ? (
                    <>
                      <span className="field-hint">
                        Hidden from the sidebar. Nothing on disk was touched, so showing one
                        again brings back its whole history.
                      </span>
                      {/*
                        Listed, and restorable one at a time. The only control
                        here was "Show them all again", so a user who had hidden
                        eight folders and wanted one of them back had to unhide
                        all eight and re-hide seven — and could not see which
                        eight they were, since the panel stated a count and no
                        names.
                      */}
                      <div className="hidden-projects">
                        {settings.hiddenProjects.map((path) => (
                          <div className="hidden-project" key={path}>
                            <span className="truncate mono" title={path}>
                              {path}
                            </span>
                            <button
                              className="btn"
                              data-variant="ghost"
                              onClick={() =>
                                onPatch({
                                  hiddenProjects: settings.hiddenProjects.filter((p) => p !== path)
                                })
                              }
                            >
                              Show
                            </button>
                          </div>
                        ))}
                      </div>
                      {settings.hiddenProjects.length > 1 && (
                        <button className="btn" onClick={() => onPatch({ hiddenProjects: [] })}>
                          Show them all again
                        </button>
                      )}
                    </>
                  ) : (
                    // Shown empty rather than hidden entirely: in a flat scroll a
                    // missing section was invisible, but in a named section the
                    // question "where did Hidden projects go" has to have an answer.
                    <span className="field-hint">
                      None. Hide one from the menu behind a folder&rsquo;s icon in the sidebar.
                    </span>
                  )}
                </div>
              </>
            )}

            {loc.page === 'updates' && (
              <>
                <SelfUpdateSettings
                  betaUpdates={settings.betaUpdates}
                  onChangeBeta={(betaUpdates) => onPatch({ betaUpdates })}
                  autoDownload={settings.selfUpdateAuto}
                  onChangeAutoDownload={(selfUpdateAuto) => onPatch({ selfUpdateAuto })}
                  onInstall={onRestartToUpdate}
                />
                <StokeCommandSettings />
                <UpdatesSettings
                  autoUpdate={settings.cliAutoUpdate}
                  onChangeAuto={(cliAutoUpdate) => onPatch({ cliAutoUpdate })}
                  relaunch={settings.cliRelaunch}
                  onChangeRelaunch={(cliRelaunch) => onPatch({ cliRelaunch })}
                />
                <ClaudePathField settings={settings} cli={cli} onPatch={onPatch} />
              </>
            )}

            {loc.page === 'agents' && <AgentManager {...agentProps} />}

            {loc.page === 'agent' && (
              <AgentSettingsPage key={loc.agent ?? 'claude'} {...agentProps} agent={loc.agent ?? 'claude'} />
            )}

            {loc.page === 'claude-launch' && <ClaudeLaunchDefaults settings={settings} onPatch={onPatch} />}

            {loc.page === 'claude-settings' && <ClaudeCodeSettings cliVersion={cli?.version ?? null} />}

            {loc.page === 'providers' && (
              <ProvidersSettings
                providers={settings.providers}
                onChange={(providers) => onPatch({ providers })}
              />
            )}

            {loc.page === 'profiles' && (
              <ProfilesSettings settings={settings} onPatch={onPatch} onCreated={onProfileCreated} />
            )}

            {loc.page === 'worklog' && (
              <>
              <WorkPanel />
              <WorklogSettings
                profiles={profiles}
                worklogGroups={settings.worklogGroups}
                auto={settings.worklogAuto}
                boards={settings.worklogBoards}
                onChangeBoards={(worklogBoards) => onPatch({ worklogBoards })}
                onChange={(worklogGroups) => onPatch({ worklogGroups })}
                onChangeAuto={(worklogAuto) => onPatch({ worklogAuto })}
              />
              </>
            )}

            {loc.page === 'hosts' && (
              <HostsSettings
                hosts={settings.hosts}
                suggestions={sshAliases}
                onChange={(hosts) => onPatch({ hosts })}
                keyEnroll={settings.sshKeyEnroll}
                onChangeKeyEnroll={(sshKeyEnroll) => onPatch({ sshKeyEnroll })}
                onSetUpKey={sshKeys.onSetUpKey}
                enrollingHostId={sshKeys.enrollingHostId}
              />
            )}

            {loc.page === 'remote' && <RemoteSettings settings={settings} onPatch={onPatch} />}

            {loc.page === 'voice' && <VoiceSettings settings={settings} onPatch={onPatch} />}
            {loc.page === 'account' && (
              <AccountSyncSettings
                remoteBar={settings.remoteBar}
                onRemoteBar={(remoteBar) => onPatch({ remoteBar })}
                chatIndexOn={settings.chatIndex === 'on'}
                redactOn={settings.chatIndexOptions.redact}
                onOpenChatHistory={(row) =>
                  // The redaction tick sits at the foot of "Where Stoke looks": shown, not focused — that row's first control is a source.
                  row === 'redact'
                    ? go({ page: 'chats' }, { id: 'chats.sources', fallback: null }, false)
                    : go({ page: 'chats' }, { id: 'chats.enabled', fallback: null }, true)
                }
              />
            )}

            {loc.page === 'backup' && <BackupSettings />}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * Where the `claude` executable is, when it should not be auto-detected.
 *
 * A component rather than three lines inline, because it needs `useDraft` and a
 * hook cannot be called inside the section's conditional JSX. It committed on
 * every keystroke before, which is the worst possible field to do that in: each
 * character was written to settings, and a half-typed path is a path that does
 * not exist, so `probeClaude` ran against `/Users/me/.l` and reported the CLI
 * missing while you were still typing its name.
 */
function ClaudePathField({
  settings,
  cli,
  onPatch
}: {
  settings: Settings
  cli: CliInfo | null
  onPatch: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const path = useDraft(settings.claudePath ?? '', (v) => onPatch({ claudePath: v.trim() || null }))
  return (
    <div className="field" data-setting="updates.cli-path">
      <span className="field-label">Claude CLI path</span>
      <input
        className="input mono"
        placeholder="Auto-detected"
        value={path.draft}
        spellCheck={false}
        onChange={(e) => path.setDraft(e.target.value)}
        onBlur={path.onBlur}
        onKeyDown={path.onKeyDown}
      />
      <FieldHint
        more={
          <>
            Leave it empty and Stoke looks in the version-manager shim directories first
            (mise, asdf, fnm), then the system ones, and finally asks a login shell — which is
            the only channel that finds a `claude` installed by a version manager when Stoke
            was started from the Dock. Set it only when that has failed.
          </>
        }
      >
        {cli?.ok
          ? `Using ${cli.path}${cli.version ? ` — ${cli.version}` : ''}`
          : (cli?.error ?? 'Looking for the claude executable…')}
      </FieldHint>
    </div>
  )
}

/**
 * The pane's drawing options. A `range` for every number, because a number
 * box that clamps on each keystroke cannot be typed into (the old Terminal
 * size box turned "1" of "12" into 9), and because the pane repaints live as
 * the slider moves, which is the only way to judge a line height.
 */
function TerminalSettingsPane({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  // Defaulted so a settings object from before the block existed still renders.
  const t = settings.terminal ?? TERMINAL_DEFAULTS
  const patchTerm = (p: Partial<Settings['terminal']>): void =>
    onPatch({ terminal: clampTerminal({ ...t, ...p }) })
  const fontField = useDraft(settings.fontFamily, (v) => onPatch({ fontFamily: v.trim() || settings.fontFamily }))
  return (
    <>
      <div className="field" data-setting="terminal.font">
        <span className="field-label">Font</span>
        <input
          className="input mono"
          value={fontField.draft}
          spellCheck={false}
          onChange={(e) => fontField.setDraft(e.target.value)}
          onBlur={fontField.onBlur}
          onKeyDown={fontField.onKeyDown}
        />
        <span className="field-hint">A CSS font stack. The first installed family wins.</span>
      </div>

      <label className="theme-editor-row" data-setting="terminal.font-size">
        <span>Font size</span>
        <input
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          value={settings.fontSize}
          onChange={(e) => onPatch({ fontSize: clampFontSize(e.target.value) })}
        />
        <output className="mono">{settings.fontSize}px</output>
      </label>

      <label className="theme-editor-row" data-setting="terminal.line-height">
        <span>Line height</span>
        <input
          type="range"
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={0.05}
          value={t.lineHeight}
          onChange={(e) => patchTerm({ lineHeight: Number(e.target.value) })}
        />
        <output className="mono">{t.lineHeight.toFixed(2)}</output>
      </label>
      <span className="field-hint">
        1.2 is a terminal; around 1.3–1.4 the CLI&rsquo;s prose reads like a chat. Box drawing stays
        joined at any value.
      </span>

      <label className="theme-editor-row" data-setting="terminal.letter-spacing">
        <span>Letter spacing</span>
        <input
          type="range"
          min={LETTER_SPACING_MIN}
          max={LETTER_SPACING_MAX}
          step={0.5}
          value={t.letterSpacing}
          onChange={(e) => patchTerm({ letterSpacing: Number(e.target.value) })}
        />
        <output className="mono">{t.letterSpacing}px</output>
      </label>

      <div className="theme-editor-row" data-setting="terminal.cursor">
        <span>Cursor</span>
        <div className="segmented" role="group" aria-label="Cursor shape">
          {(['bar', 'block', 'underline'] as const).map((c) => (
            <button key={c} aria-pressed={t.cursorStyle === c} onClick={() => patchTerm({ cursorStyle: c })}>
              {c}
            </button>
          ))}
        </div>
        <label className="check-row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={t.cursorBlink} onChange={(e) => patchTerm({ cursorBlink: e.target.checked })} />
          <span className="field-hint">blink</span>
        </label>
      </div>

      <div className="theme-editor-row" data-setting="terminal.bold-weight">
        <span>Bold weight</span>
        <div className="segmented" role="group" aria-label="Bold weight">
          <button aria-pressed={t.boldWeight === 600} onClick={() => patchTerm({ boldWeight: 600 })}>
            Semibold
          </button>
          <button aria-pressed={t.boldWeight === 700} onClick={() => patchTerm({ boldWeight: 700 })}>
            Bold
          </button>
        </div>
        <span />
      </div>

      <div className="theme-editor-row" data-setting="terminal.contrast">
        <span>Text contrast</span>
        <div className="segmented" role="group" aria-label="Minimum contrast">
          <button aria-pressed={t.contrastBoost === 1} onClick={() => patchTerm({ contrastBoost: 1 })}>
            As drawn
          </button>
          <button aria-pressed={t.contrastBoost === 4.5} onClick={() => patchTerm({ contrastBoost: 4.5 })}>
            AA
          </button>
          <button aria-pressed={t.contrastBoost === 7} onClick={() => patchTerm({ contrastBoost: 7 })}>
            AAA
          </button>
        </div>
        <span />
      </div>
      <span className="field-hint">
        Recolours dim text the CLI draws until it clears the ratio. It changes Claude Code&rsquo;s own
        palette, so it is off unless you want it.
      </span>

      <label className="check-row" data-setting="terminal.smooth-scroll">
        <input type="checkbox" checked={t.smoothScroll} onChange={(e) => patchTerm({ smoothScroll: e.target.checked })} />
        <span>
          <span className="field-label">Smooth scrolling</span>
        </span>
      </label>

      <label className="check-row" data-setting="terminal.frame">
        <input type="checkbox" checked={t.frame} onChange={(e) => patchTerm({ frame: e.target.checked })} />
        <span>
          <span className="field-label">Frame the terminal</span>
          <span className="field-hint">
            Off, the terminal fills the pane edge to edge, which is what a terminal does. On, it
            is a rounded card inset from the page — worth turning on with a wallpaper behind the
            window, which is what it was built for.
          </span>
        </span>
      </label>

      <label className="theme-editor-row" data-setting="terminal.padding">
        <span>Inner padding</span>
        <input
          type="range"
          min={0}
          max={TERM_PADDING_MAX}
          step={2}
          value={t.padding}
          onChange={(e) => patchTerm({ padding: Number(e.target.value) })}
        />
        <output className="mono">{t.padding}px</output>
      </label>
    </>
  )
}

/**
 * "Draw Claude Code in this theme's colours."
 *
 * Only the CLI's two `-ansi` themes consume Stoke's sixteen terminal slots;
 * its other four hardcode truecolor and ignore the palette entirely (gotcha
 * 42), which is why picking a theme here used to leave Claude's own panels a
 * neutral grey over a tinted page. The control that sets the CLI's theme lived
 * three sections away and nobody picking a theme found it. This is that one
 * key, as a checkbox, next to the thing it belongs to; the full vocabulary
 * stays in the Claude Code section.
 */
function ClaudeThemeToggle({ appearance }: { appearance: 'dark' | 'light' }): React.JSX.Element | null {
  const [value, setValue] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const wanted = appearance === 'light' ? 'light-ansi' : 'dark-ansi'

  useEffect(() => {
    let live = true
    void window.stoke.claudeConfig.read().then((state) => {
      if (!live) return
      const v = state.values.theme
      setValue(typeof v === 'string' ? v : null)
    })
    return () => {
      live = false
    }
  }, [])

  /*
   * Follow the theme's side: a box ticked under a dark theme means dark-ansi,
   * and switching to a light theme must move it to light-ansi rather than
   * leave the CLI painting a dark palette on a light page.
   */
  const on = value === 'dark-ansi' || value === 'light-ansi'
  useEffect(() => {
    if (!on || value === wanted) return
    void window.stoke.claudeConfig.set('theme', wanted).then((r) => {
      if (r.ok) setValue(wanted)
    })
  }, [on, value, wanted])

  if (value === undefined) return null

  const toggle = async (checked: boolean): Promise<void> => {
    setError(null)
    const r = await window.stoke.claudeConfig.set('theme', checked ? wanted : 'auto')
    if (r.ok) setValue(checked ? wanted : 'auto')
    else setError(r.error ?? 'Could not write ~/.claude/settings.json.')
  }

  return (
    <label className="check-row" data-setting="appearance.claude-theme">
      <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
      <span>
        <span className="field-label">Draw Claude Code in this theme&rsquo;s colours</span>
        <span className="field-hint">
          Uses the sixteen terminal colours above for Claude&rsquo;s own prompt box and panels, for
          every new session. Off, Claude picks its own greys and only follows light or dark.
          {error && (
            <>
              {' '}
              <span data-tone="danger">{error}</span>
            </>
          )}
        </span>
      </span>
    </label>
  )
}

/**
 * The image behind the window. Choose / Remove, then three sliders that
 * decide whether text is still readable over it: blur, dim, and how opaque
 * the panels are. The opacity floor is in `clampWallpaper`; the ladder's
 * contrast guarantees stop at the page, and this is what stands in for them.
 */
function WallpaperField({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const w = settings.wallpaper ?? WALLPAPER_DEFAULTS
  const [error, setError] = useState<string | null>(null)
  const patchW = (p: Partial<Settings['wallpaper']>): void => onPatch({ wallpaper: clampWallpaper({ ...w, ...p }) })
  return (
    <div className="field" data-setting="appearance.wallpaper">
      <span className="field-label">Wallpaper</span>
      <span className="field-hint">
        An image behind everything, with the page and panels drawn translucent over it. Dim and
        blur it enough that text still sits on something quiet; the theme&rsquo;s contrast floors
        stop at the page.
      </span>
      <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center', flexWrap: 'wrap' }}>
        {w.path && (
          <img
            className="wallpaper-thumb"
            src={window.stoke.wallpaper.url(w.path)}
            alt=""
            width={96}
            height={54}
          />
        )}
        <button
          className="btn"
          onClick={() => {
            setError(null)
            void window.stoke.wallpaper.pick().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          }}
        >
          {w.path ? 'Change image…' : 'Choose an image…'}
        </button>
        {w.path && (
          <button className="btn" data-variant="ghost" onClick={() => void window.stoke.wallpaper.clear()}>
            Remove
          </button>
        )}
      </div>
      {error && (
        <span className="field-hint" data-tone="danger">
          {error}
        </span>
      )}
      {w.path && (
        <>
          <label className="theme-editor-row">
            <span>Blur</span>
            <input type="range" min={0} max={WALLPAPER_BLUR_MAX} step={1} value={w.blur} onChange={(e) => patchW({ blur: Number(e.target.value) })} />
            <output className="mono">{w.blur}px</output>
          </label>
          <label className="theme-editor-row">
            <span>Dim</span>
            <input type="range" min={0} max={WALLPAPER_DIM_MAX} step={0.05} value={w.dim} onChange={(e) => patchW({ dim: Number(e.target.value) })} />
            <output className="mono">{Math.round(w.dim * 100)}%</output>
          </label>
          <label className="theme-editor-row">
            <span>Panel opacity</span>
            <input type="range" min={WALLPAPER_OPACITY_MIN} max={1} step={0.05} value={w.opacity} onChange={(e) => patchW({ opacity: Number(e.target.value) })} />
            <output className="mono">{Math.round(w.opacity * 100)}%</output>
          </label>
        </>
      )}
    </div>
  )
}
