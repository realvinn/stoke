import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import {
  addRefusal,
  fitTopBar,
  folderChip,
  mintItemId,
  nudgeItem,
  removeItem,
  SHORTCUT_LABEL_MAX,
  SHORTCUT_TEXT_MAX,
  shortcutDraftProblem,
  shortcutFromDraft,
  shortcutVerdict,
  TABS_FLOOR_REM,
  tabsFloorPx,
  topBarKeep,
  TOP_BAR_DEFAULTS,
  DRAG_GAP_REM,
  dragGapPx,
  type FitItem,
  type FitResult,
  type ShortcutDraft,
  type ShortcutTarget,
  type TopBarItem,
  type TopBarKind,
  type TopBarSettings,
  type TopBarShortcut
} from '@shared/topBar'
import { gitChip, shownGitStatus } from '@shared/gitStatus'
import { ContextMenu, type MenuItem } from './ContextMenu'
import {
  IconBranch,
  IconChevronsRight,
  IconClose,
  IconEnter,
  IconFolder,
  IconGhost,
  IconGrip,
  IconPencil,
  IconPlus,
  IconServer
} from './Icons'
import { useFloatingLayer } from '../lib/floatingLayers'
import { useGitStatus } from '../lib/useGitStatus'
import { useTabDrag } from '../lib/useTabDrag'
import { moveTab } from '../lib/tabs'
import { noteInput } from '../lib/ptyBus'
import { focusTerm } from '../lib/termRegistry'
import type { Tab } from '../types'

/**
 * The title bar's own items, between the tab strip and the actions: where the
 * tab in front is, its git state, and the owner's text shortcuts — and the
 * WYSIWYG editor that arranges them (asked for 2026-10-02: "make it
 * customisable with being able to add text shortcuts moving them around and
 * just a nice visual editor").
 *
 * It lives INSIDE the 44px title bar, so width is what it spends. A hidden
 * measurer draws every chip in both forms off screen, and `fitTopBar` decides
 * how the bar gives way — folder to its name, git to its branch, shortcuts into
 * "»" — while the tab strip keeps `TABS_FLOOR_REM`, written onto the bar as
 * `--tabs-floor`. Nothing here can widen the shell (gotcha 14).
 *
 * Every chip is `-webkit-app-region: no-drag`; the gaps between them and the
 * flexible spaces stay the window's drag region. Everything that floats — the
 * shortcut form, the menus — registers with `useFloatingLayer` (gotcha 14) and
 * is either under `.titlebar` or a `.context-menu`, which App's full-screen
 * reveal counts as still being on the tabs (gotcha 105).
 */

interface Props {
  isMac: boolean
  topBar: TopBarSettings
  editing: boolean
  onEditing: (on: boolean) => void
  /** One write per commit: a drop, an add, a save, a delete — never a drag tick (gotcha 63). */
  onChange: (next: TopBarSettings) => void
  /** The tab in front, or null. */
  tab: Tab | null
  /** How many tabs the strip holds: its natural width moves with it. */
  tabCount: number
  /** The SSH host's label for an SSH tab (its `cwd` is the alias, gotcha 18). */
  hostLabel: string | null
  /** The tab's activity dot (`activityView`): `waiting` refuses a shortcut; the end of `working` re-reads git. */
  dot: string | null
  onReveal: (path: string) => void
}

/** One item as drawn now: both forms, what a click does, and a key that changes when its text does. */
interface ChipView {
  item: TopBarItem
  full: React.ReactNode
  /** Null when the compact form is the full one. */
  compact: React.ReactNode
  title: string
  /** What a click (or Enter) does out of edit mode, given the chip. Null for a chip that only shows. */
  act: ((el: HTMLElement) => void) | null
  disabled: boolean
  /** Its right-click menu, out of edit mode. */
  menu: MenuItem[]
  /** Everything that changes its width, for re-measuring. */
  key: string
}

const sameItems = (a: readonly TopBarItem[], b: readonly TopBarItem[]): boolean => JSON.stringify(a) === JSON.stringify(b)

const EMPTY_DRAFT: ShortcutDraft = { label: '', icon: '', text: '', send: false, on: 'claude' }

const NO_FIT: FitResult = { compact: [], overflow: [], hidden: [] }

/** An edit-mode space chip's least width (`.topbar[data-editing] .tb-chip[data-kind='spacer']`). */
const SPACER_EDIT_REM = 6.5

/** The least the folder chip narrows to, an ellipsis in its text (app.css, `.topbar-items .tb-chip`). */
const SQUEEZE_REM = { folder: 4 }

export function TopBar({
  isMac,
  topBar,
  editing,
  onEditing,
  onChange,
  tab,
  tabCount,
  hostLabel,
  dot,
  onReveal
}: Props): React.JSX.Element {
  /*
   * The order on screen the moment an edit lands. The settings round trip is
   * async, and a drag's FLIP settle measures the DOM in the same frame as its
   * commit, so the new order is drawn from here until main's copy says the
   * same — or a few seconds pass: a write that failed must not stick.
   */
  const [pending, setPending] = useState<TopBarItem[] | null>(null)
  useEffect(() => {
    if (!pending) return
    if (sameItems(pending, topBar.items)) {
      setPending(null)
      return
    }
    const t = window.setTimeout(() => setPending(null), 4000)
    return () => window.clearTimeout(t)
  }, [pending, topBar.items])
  const items = pending ?? topBar.items

  // A drag's commit already runs inside useTabDrag's `flushSync`, so the new
  // order is in the DOM before its settle measures it.
  const commit = (next: TopBarItem[]): void => {
    setPending(next)
    onChange({ ...topBar, items: next })
  }

  /* ------------------------------------------------------- the tab in front */

  /*
   * A folder on this computer git may be asked about: never an SSH tab (its
   * cwd is an alias, gotcha 18) and never a private chat, whose folder is
   * Stoke's own scratch under userData — git there would walk up into
   * whatever repo holds it (a home kept in git) and show that as the chat's.
   */
  const local = !!tab && tab.kind === 'session' && !tab.hostId && !tab.private && !!tab.cwd
  const hasGit = items.some((i) => i.kind === 'git')
  const busy = dot === 'working' || dot === 'background'
  const git = useGitStatus(local && tab ? tab.cwd : null, { enabled: hasGit && local, busy })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => setNow(Date.now()), [git.status])
  const chip = gitChip(shownGitStatus(git.status, now))

  const target: ShortcutTarget | null = tab
    ? {
        kind: tab.kind,
        status: tab.status,
        cliId: tab.cliId,
        utility: !!(tab.installing?.length || tab.enrollHostId || tab.accountLogin),
        dot
      }
    : null

  const runShortcut = (item: TopBarShortcut): void => {
    if (!tab || !shortcutVerdict(item, target).ok) return
    const ptyId = tab.ptyId
    // What a person typing it would record: the draft guard (gotcha 82).
    noteInput(ptyId, item.text)
    void window.stoke.pty
      .type(ptyId, item.text, item.send)
      .catch(() => false)
      .finally(() => focusTerm(ptyId))
  }

  const customise: MenuItem = { label: 'Customise the title bar…', separated: true, onSelect: () => onEditing(true) }

  const views: ChipView[] = []
  for (const item of items) {
    if (item.kind === 'folder') {
      const f = folderChip(tab ? { kind: tab.kind, cwd: tab.cwd, hostId: tab.hostId, private: tab.private } : null, {
        style: item.style,
        hostLabel,
        deviceLabel: tab?.remote?.deviceLabel ?? null
      })
      if (!f) {
        if (editing) views.push(placeholder(item, <IconFolder />, 'Folder', 'Where the tab in front is'))
        continue
      }
      const icon = f.where === 'local' ? <IconFolder /> : f.where === 'private' ? <IconGhost /> : <IconServer />
      const open = f.open
      views.push({
        item,
        full: <ChipText icon={icon} text={f.text} mono={f.where === 'local' && item.style === 'path'} />,
        compact: f.compact === f.text ? null : <ChipText icon={icon} text={f.compact} />,
        title: f.title,
        act: open ? () => onReveal(open) : null,
        disabled: false,
        menu: open
          ? [
              { label: 'Open folder', onSelect: () => onReveal(open) },
              { label: 'Copy path', onSelect: () => window.stoke.clipboard.writeText(open) },
              customise
            ]
          : [customise],
        key: `${f.text}|${f.compact}|${f.where}`
      })
    } else if (item.kind === 'git') {
      if (!chip) {
        if (editing) views.push(placeholder(item, <IconBranch />, 'Git', 'Branch, changes and ahead/behind of a local tab’s folder'))
        continue
      }
      /*
       * One icon button (the owner, 2026-10-03: "move the git as a button like
       * that git tree"), a dot when there are changes. The branch, the counts
       * and ahead/behind are its tooltip and its click: a menu headed by the
       * branch with the rest as lines — width the tabs and the window's drag
       * space need more than a branch name does.
       */
      const [heading, ...details] = chip.title.split('\n')
      const actions: MenuItem[] = [
        { label: 'Look again', onSelect: git.refresh },
        { label: 'Copy branch name', disabled: !git.status?.branch, onSelect: () => window.stoke.clipboard.writeText(git.status?.branch ?? '') },
        customise
      ]
      const dirty = chip.changes === null ? 'unknown' : chip.changes > 0 ? 'dirty' : null
      views.push({
        item,
        full: (
          <>
            <IconBranch />
            {/* Not while editing: there it sat on the chip's × and took its clicks. */}
            {dirty && !editing && <span className="tb-git-badge" data-tone={dirty} aria-hidden="true" />}
            <span className="sr-only">
              Git: {chip.head}
              {chip.changes === null ? ', changes unknown' : chip.changes > 0 ? `, ${chip.changes} changed` : ''}
            </span>
          </>
        ),
        compact: null,
        title: chip.title,
        act: (el) => openMenu(el, actions, { title: heading, lines: details }),
        disabled: false,
        menu: actions,
        key: `${chip.head}|${dirty}`
      })
    } else if (item.kind === 'shortcut') {
      const v = shortcutVerdict(item, target)
      const what = `${item.send ? 'Types and sends' : 'Types'}: ${item.text.length > 140 ? `${item.text.slice(0, 140)}…` : item.text}`
      views.push({
        item,
        full: (
          <>
            {item.icon && (
              <span className="tb-emoji" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="tb-text">{item.label}</span>
            {item.send && (
              <>
                <IconEnter className="tb-send" />
                <span className="sr-only">, then presses Enter</span>
              </>
            )}
          </>
        ),
        compact: null,
        title: v.ok ? what : `${v.reason}\n${what}`,
        act: () => runShortcut(item),
        disabled: !v.ok,
        menu: [{ label: item.send ? 'Type and send' : 'Type', disabled: !v.ok, onSelect: () => runShortcut(item) }, customise],
        key: `${item.icon}|${item.label}|${item.send}`
      })
    } else {
      views.push({ item, full: null, compact: null, title: 'Flexible space', act: null, disabled: false, menu: [customise], key: '' })
    }
  }

  /* ------------------------------------------------------------- fitting */

  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const trailRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<FitResult>(NO_FIT)
  const viewsRef = useRef(views)
  viewsRef.current = views
  const editingRef = useRef(editing)
  editingRef.current = editing

  /** Read the title bar's geometry and decide how the bar gives way. Reads refs only, so it is stable. */
  const measure = useCallback((): void => {
    const root = rootRef.current
    const bar = root?.closest<HTMLElement>('.titlebar')
    const meas = measureRef.current
    if (!root || !bar || !meas) return
    const cs = getComputedStyle(bar)
    const gap = parseFloat(cs.columnGap) || 0
    let others = 0
    let count = 0
    let tabs: HTMLElement | null = null
    for (const child of Array.from(bar.children) as HTMLElement[]) {
      const pos = getComputedStyle(child).position
      if (pos === 'absolute' || pos === 'fixed') continue
      count++
      if (child === root) continue
      if (child.classList.contains('tabs')) tabs = child
      else others += child.getBoundingClientRect().width
    }
    // The strip's natural width: every tab unscrolled, plus the + beside them.
    let natural = 0
    if (tabs) {
      const kids = Array.from(tabs.children) as HTMLElement[]
      for (const k of kids) natural += k.classList.contains('tablist') ? k.scrollWidth : k.getBoundingClientRect().width
      natural += (parseFloat(getComputedStyle(tabs).columnGap) || 0) * Math.max(0, kids.length - 1)
    }
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    // What the strip and the items share: the bar less its padding, everything
    // else on it (the actions never shrink) and the gaps between.
    const avail =
      bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - others - gap * Math.max(0, count - 1)
    const width = (sel: string): number => meas.querySelector<HTMLElement>(sel)?.getBoundingClientRect().width ?? 0
    const trail = trailRef.current?.getBoundingClientRect().width ?? 0
    const innerGap = parseFloat(getComputedStyle(root).columnGap) || 0
    const more = width('[data-measure="more"]')
    const keepInput = {
      trail,
      more,
      gap: innerGap,
      shortcuts: viewsRef.current.some((v) => v.item.kind === 'shortcut'),
      editing: editingRef.current
    }
    // The window's drag space (`.topbar-drag`): whole while the tabs keep their
    // floor beside it, the first thing to give way after that (`dragGapPx`).
    const drag = dragGapPx({
      want: DRAG_GAP_REM * rem,
      avail,
      keep: topBarKeep(keepInput),
      gap: innerGap,
      tabs: Math.min(natural, TABS_FLOOR_REM * rem),
      editing: editingRef.current
    })
    root.style.setProperty('--topbar-drag', `${drag}px`)
    // The floor yields to the actions, never the other way (`tabsFloorPx`),
    // and leaves the bar its own controls, the drag space and, if shortcuts
    // can spill, the "»".
    const floor = tabsFloorPx({
      natural,
      floor: TABS_FLOOR_REM * rem,
      avail,
      keep: topBarKeep({ ...keepInput, drag })
    })
    bar.style.setProperty('--tabs-floor', `${floor}px`)
    const room = avail - floor
    // A space takes only what is left — except in edit mode, where it is a chip
    // with a floor (`SPACER_EDIT_REM`, app.css) that must fit like any other.
    const spacer = editingRef.current ? SPACER_EDIT_REM * rem : 0
    const fitItems: FitItem[] = viewsRef.current.map((v) => ({
      id: v.item.id,
      kind: v.item.kind,
      full: v.item.kind === 'spacer' ? spacer : width(`[data-measure="${CSS.escape(v.item.id)}"][data-form="full"]`),
      compact: v.item.kind === 'spacer' ? spacer : width(`[data-measure="${CSS.escape(v.item.id)}"][data-form="compact"]`),
      // What the CSS lets these two narrow to, out of edit mode (`.tb-chip` min-widths).
      ...(editingRef.current ? {} : v.item.kind === 'folder' ? { min: SQUEEZE_REM.folder * rem } : {})
    }))
    const input = { room, gap: innerGap, fixed: trail + (drag > 0 ? drag + innerGap : 0), more, items: fitItems }
    // Editing shows every item, so only compaction applies; the list scrolls past that.
    const decided = fitTopBar(input)
    const next = editingRef.current ? { compact: decided.compact, overflow: [], hidden: [] } : decided
    setFit((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
  }, [])

  const measureKey = `${editing}|${views.map((v) => `${v.item.id}:${v.key}`).join('/')}`
  useLayoutEffect(() => {
    measure()
  }, [measure, measureKey, tabCount])

  useEffect(() => {
    const bar = rootRef.current?.closest<HTMLElement>('.titlebar')
    if (!bar) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(bar)
    /*
     * Every child of the bar, not only the actions: measuring reads them all
     * as fixed width, and a squeezed one (the sidebar toggle, mid-resize) that
     * relaxes a frame later moves nothing the bar itself reports — the fit
     * stayed 10px over until the next resize (driven, 2026-10-03).
     */
    for (const el of [measureRef.current, bar.querySelector('.tablist'), ...Array.from(bar.children)]) {
      if (el) ro.observe(el)
    }
    return () => {
      ro.disconnect()
      bar.style.removeProperty('--tabs-floor')
    }
  }, [measure])

  /* ------------------------------------------------------------ the editor */

  const ids = useMemo(() => items.map((i) => i.id), [items])
  const drag = useTabDrag({
    listRef,
    ids,
    isMac,
    itemAttr: 'tbItem',
    ignore: '.tb-chip-x',
    onReorder: (dragId, overId) => commit(moveTab(items, dragId, overId))
  })

  const [menu, setMenu] = useState<{
    x: number
    y: number
    items: MenuItem[]
    header?: { title: string; lines?: readonly string[] }
  } | null>(null)
  const [form, setForm] = useState<{ id: string | null; left: number; draft: ShortcutDraft; dirty: boolean; problem: string | null } | null>(null)
  const formRef = useRef<HTMLDivElement>(null)
  useFloatingLayer(formRef, form !== null)

  // Leaving edit mode closes whatever the editor had open.
  useEffect(() => {
    if (!editing) setForm(null)
    setMenu(null)
  }, [editing])

  // A chip moved by the keyboard keeps focus: React moves the node, and a moved node loses it.
  const focusAfter = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = focusAfter.current
    if (!id) return
    focusAfter.current = null
    listRef.current?.querySelector<HTMLElement>(`[data-tb-item="${CSS.escape(id)}"]`)?.focus()
  })

  const openForm = (anchor: HTMLElement | null, existing: TopBarShortcut | null): void => {
    const root = rootRef.current
    if (!root) return
    const r = root.getBoundingClientRect()
    const a = anchor?.getBoundingClientRect() ?? r
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const width = 22 * rem
    // Under the chip, held inside the window. Relative to the bar, so it rides
    // along when the full-screen reveal slides the shell (gotcha 105).
    const left = Math.max(8 - r.left, Math.min(a.left - r.left, window.innerWidth - r.left - width - 8))
    setMenu(null)
    setForm({
      id: existing?.id ?? null,
      left,
      draft: existing
        ? { label: existing.label, icon: existing.icon, text: existing.text, send: existing.send, on: existing.on }
        : { ...EMPTY_DRAFT },
      dirty: false,
      problem: null
    })
  }

  const saveForm = (): void => {
    if (!form) return
    const others = items.filter((i): i is TopBarShortcut => i.kind === 'shortcut' && i.id !== form.id).map((i) => i.text)
    const problem = shortcutDraftProblem(form.draft, others)
    if (problem) {
      setForm({ ...form, problem })
      return
    }
    if (form.id) {
      const id = form.id
      commit(items.map((i) => (i.id === id ? shortcutFromDraft(id, form.draft) : i)))
    } else {
      const refusal = addRefusal('shortcut', items)
      if (refusal) {
        setForm({ ...form, problem: refusal })
        return
      }
      commit([...items, shortcutFromDraft(mintItemId('shortcut', items), form.draft)])
    }
    setForm(null)
  }

  const add = (kind: TopBarKind): void => {
    if (addRefusal(kind, items)) return
    if (kind === 'shortcut') {
      openForm(trailRef.current, null)
      return
    }
    const id = mintItemId(kind, items)
    const item: TopBarItem =
      kind === 'folder' ? { id, kind: 'folder', style: 'path' } : kind === 'git' ? { id, kind: 'git' } : { id, kind: 'spacer' }
    commit([...items, item])
  }

  const remove = (id: string): void => {
    const r = removeItem(items, id)
    focusAfter.current = r.focus
    commit(r.items)
  }

  const editItem = (item: TopBarItem, el: HTMLElement | null): void => {
    if (item.kind === 'shortcut') openForm(el, item)
    else if (item.kind === 'folder') commit(items.map((i) => (i.id === item.id ? { ...item, style: item.style === 'path' ? 'name' : 'path' } : i)))
  }

  const onChipKey = (e: ReactKeyboardEvent<HTMLElement>, v: ChipView): void => {
    /*
     * Every key this handles stops here: App's window listener would otherwise
     * send Enter, Space and Backspace on to the terminal (`typeThroughKey`).
     * Escape is taken only with focus on a chip — one that reached xterm
     * would interrupt Claude.
     */
    const item = v.item
    const stop = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (editing) {
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        stop()
        focusAfter.current = item.id
        commit(nudgeItem(items, item.id, e.key === 'ArrowLeft' ? -1 : 1))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        stop()
        remove(item.id)
      } else if (e.key === 'Enter' || e.key === ' ') {
        stop()
        editItem(item, e.currentTarget)
      } else if (e.key === 'Escape') {
        stop()
        onEditing(false)
      }
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      stop()
      if (v.act && !v.disabled) v.act(e.currentTarget)
    }
  }

  const onChipClick = (e: ReactMouseEvent<HTMLElement>, v: ChipView): void => {
    if (editing) editItem(v.item, e.currentTarget)
    else if (v.act && !v.disabled) v.act(e.currentTarget)
  }

  /* --------------------------------------------------------------- drawing */

  const overflow = new Set(editing ? [] : fit.overflow)
  const hidden = new Set(editing ? [] : fit.hidden)
  const shown = views.filter((v) => !overflow.has(v.item.id) && !hidden.has(v.item.id))
  const overflowed = views.filter((v) => overflow.has(v.item.id))

  const addItems: MenuItem[] = [
    { label: 'Folder', hint: 'where the tab is', disabled: addRefusal('folder', items) !== null, onSelect: () => add('folder') },
    { label: 'Git', hint: 'branch, changes', disabled: addRefusal('git', items) !== null, onSelect: () => add('git') },
    { label: 'Flexible space', disabled: addRefusal('spacer', items) !== null, onSelect: () => add('spacer') },
    { label: 'New text shortcut…', separated: true, disabled: addRefusal('shortcut', items) !== null, onSelect: () => add('shortcut') },
    { label: 'Reset to the default (git)', separated: true, onSelect: () => commit(TOP_BAR_DEFAULTS.items.map((i) => ({ ...i }))) }
  ]
  const moreItems: MenuItem[] = [
    ...overflowed.map(
      (v): MenuItem => ({
        label: v.item.kind === 'shortcut' ? `${v.item.icon ? `${v.item.icon} ` : ''}${v.item.label}` : v.item.kind,
        hint: v.disabled ? 'not here' : v.item.kind === 'shortcut' && v.item.send ? 'sends' : 'types',
        disabled: v.disabled || !v.act,
        onSelect: () => {
          const el = listRef.current
          if (el) v.act?.(el)
        }
      })
    ),
    { ...customise, separated: overflowed.length > 0 }
  ]

  const openMenu = (el: HTMLElement, list: MenuItem[], header?: { title: string; lines?: readonly string[] }): void => {
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4, items: list, header })
  }

  return (
    <div className="topbar" ref={rootRef} data-editing={editing || undefined} data-compact={fit.compact.length > 0 || undefined}>
      {/* Nothing but somewhere to grab the window, which nothing else on the bar may take (`DRAG_GAP_REM`). */}
      {!editing && <div className="topbar-drag" aria-hidden="true" />}
      <div
        className="topbar-items"
        ref={listRef}
        role="toolbar"
        aria-label={editing ? 'Title bar items: drag, or Alt+arrow keys, to move; Delete to remove' : 'Title bar'}
      >
        {shown.map((v) =>
          v.item.kind === 'spacer' && !editing ? (
            <div key={v.item.id} className="tb-spacer" data-tb-item={v.item.id} aria-hidden="true" />
          ) : (
            <div
              key={v.item.id}
              className="tb-chip"
              data-kind={v.item.kind}
              data-tb-item={v.item.id}
              role="button"
              tabIndex={0}
              aria-disabled={(!editing && v.disabled) || undefined}
              aria-haspopup={!editing && v.item.kind === 'git' ? 'menu' : undefined}
              title={editing ? editTitle(v.item) : v.title}
              onPointerDown={editing ? (e) => drag.onPointerDown(e, v.item.id) : undefined}
              // Out of edit mode a press leaves focus in the terminal, as a tab's does.
              onMouseDown={editing ? undefined : (e) => e.preventDefault()}
              onClick={(e) => onChipClick(e, v)}
              onKeyDown={(e) => onChipKey(e, v)}
              onContextMenu={(e) => {
                e.preventDefault()
                if (!editing) setMenu({ x: e.clientX, y: e.clientY, items: v.menu })
              }}
            >
              {editing && <IconGrip className="tb-grip" />}
              {v.item.kind === 'spacer' ? <span className="tb-text">Space</span> : fit.compact.includes(v.item.id) && v.compact ? v.compact : v.full}
              {editing && (
                <button
                  className="tb-chip-x"
                  tabIndex={-1}
                  title="Remove"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(v.item.id)
                  }}
                >
                  <IconClose />
                  <span className="sr-only">Remove</span>
                </button>
              )}
            </div>
          )
        )}
      </div>

      {overflowed.length > 0 && (
        <button
          className="icon-btn tb-more"
          title={`${overflowed.length} more shortcut${overflowed.length === 1 ? '' : 's'}`}
          aria-haspopup="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => openMenu(e.currentTarget, moreItems)}
        >
          <IconChevronsRight />
          <span className="sr-only">More shortcuts</span>
        </button>
      )}

      <div className="topbar-trail" ref={trailRef}>
        {editing ? (
          <>
            <button
              className="btn tb-btn"
              data-variant="ghost"
              aria-haspopup="menu"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => openMenu(e.currentTarget, addItems, { title: 'Add to the title bar' })}
            >
              <IconPlus />
              Add
            </button>
            <button className="btn tb-btn" data-variant="primary" onClick={() => onEditing(false)}>
              Done
            </button>
          </>
        ) : (
          <button
            className="icon-btn tb-pencil"
            title="Customise the title bar: git, text shortcuts, folder"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onEditing(true)}
          >
            <IconPencil />
            <span className="sr-only">Customise the title bar</span>
          </button>
        )}
      </div>

      {/* Every chip in both forms, off screen, for `fitTopBar`. Spans, never buttons. */}
      <div className="topbar-measure" ref={measureRef} aria-hidden="true">
        {views.map((v) =>
          v.item.kind === 'spacer' ? null : (
            <span key={v.item.id} className="topbar-measure-pair">
              {(['full', 'compact'] as const).map((form) => (
                <span key={form} className="tb-chip" data-kind={v.item.kind} data-measure={v.item.id} data-form={form}>
                  {editing && <IconGrip className="tb-grip" />}
                  {form === 'compact' && v.compact ? v.compact : v.full}
                  {editing && <span className="tb-chip-x" />}
                </span>
              ))}
            </span>
          )
        )}
        <span className="icon-btn tb-more" data-measure="more">
          <IconChevronsRight />
        </span>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} header={menu.header} items={menu.items} onClose={() => setMenu(null)} />}

      {form && (
        <>
          <div
            className="popover-backdrop"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              // Never saved by clicking away (gotchas 63, 119); a form with
              // nothing typed into it just goes, one with a draft stays.
              if (!form.dirty) setForm(null)
            }}
          />
          <ShortcutForm
            ref={formRef}
            isMac={isMac}
            left={form.left}
            editingExisting={form.id !== null}
            draft={form.draft}
            problem={form.problem}
            onDraft={(draft) => setForm({ ...form, draft, dirty: true, problem: null })}
            onSave={saveForm}
            onCancel={() => setForm(null)}
            onDelete={
              form.id
                ? () => {
                    remove(form.id as string)
                    setForm(null)
                  }
                : null
            }
          />
        </>
      )}
    </div>
  )
}

function placeholder(item: TopBarItem, icon: React.ReactNode, text: string, title: string): ChipView {
  return { item, full: <ChipText icon={icon} text={text} />, compact: null, title, act: null, disabled: false, menu: [], key: text }
}

function editTitle(item: TopBarItem): string {
  const how = 'Drag, or Alt+arrow keys, to move · Delete to remove'
  if (item.kind === 'shortcut') return `Click to edit · ${how}`
  if (item.kind === 'folder') return `Click to show ${item.style === 'path' ? 'the folder’s name only' : 'the whole path'} · ${how}`
  return how
}

function ChipText({ icon, text, mono }: { icon: React.ReactNode; text: string; mono?: boolean }): React.JSX.Element {
  return (
    <>
      {icon}
      <span className={mono ? 'tb-text mono' : 'tb-text'}>{text}</span>
    </>
  )
}

/* ------------------------------------------------------- the shortcut form */

interface FormProps {
  ref: React.Ref<HTMLDivElement>
  isMac: boolean
  left: number
  editingExisting: boolean
  draft: ShortcutDraft
  problem: string | null
  onDraft: (d: ShortcutDraft) => void
  onSave: () => void
  onCancel: () => void
  onDelete: (() => void) | null
}

/**
 * Label, text, "Press Enter and send" (off unless ticked — the owner's rule:
 * a shortcut only types by default) and which tabs it shows on. Saved by its
 * button or Cmd/Ctrl+Enter, never on blur (gotchas 63, 119).
 */
function ShortcutForm({ ref, isMac, left, editingExisting, draft, problem, onDraft, onSave, onCancel, onDelete }: FormProps): React.JSX.Element {
  const labelRef = useRef<HTMLInputElement>(null)
  // Focused as it mounts; never shown-then-focused through `visibility` (gotcha 137).
  useEffect(() => {
    labelRef.current?.focus()
  }, [])

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Nothing typed here may reach App's routing to the terminal.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSave()
    }
  }
  const multiline = /[\r\n]/.test(draft.text)
  const title = editingExisting ? 'Edit text shortcut' : 'New text shortcut'

  return (
    <div className="popover tb-form" role="dialog" aria-label={title} ref={ref} style={{ left, right: 'auto' }} onKeyDown={onKey}>
      <p className="popover-title">{title}</p>
      <div className="tb-form-row">
        <label className="tb-form-field tb-form-icon">
          <span className="field-label">Icon</span>
          <input
            className="input"
            value={draft.icon}
            placeholder="🙂"
            maxLength={16}
            spellCheck={false}
            aria-label="Icon: one emoji, or none"
            onChange={(e) => onDraft({ ...draft, icon: e.target.value.trim() })}
          />
        </label>
        <label className="tb-form-field tb-form-label">
          <span className="field-label">Label</span>
          <input
            ref={labelRef}
            className="input"
            value={draft.label}
            placeholder="Named from the text if empty"
            maxLength={SHORTCUT_LABEL_MAX * 2}
            onChange={(e) => onDraft({ ...draft, label: e.target.value })}
          />
        </label>
      </div>
      <label className="tb-form-field">
        <span className="field-label">Text</span>
        <textarea
          className="input tb-form-text mono"
          value={draft.text}
          rows={4}
          maxLength={SHORTCUT_TEXT_MAX * 2}
          spellCheck={false}
          placeholder="What it types, e.g. Run the tests and fix any failures"
          onChange={(e) => onDraft({ ...draft, text: e.target.value })}
        />
      </label>
      <label className="check-row tb-form-check">
        <input type="checkbox" checked={draft.send} onChange={(e) => onDraft({ ...draft, send: e.target.checked })} />
        <span>
          <span className="field-label">Press Enter and send</span>
          <span className="field-hint">
            {draft.send ? 'Types the text, then presses Enter.' : 'Off: it only types, and you press Enter.'}
          </span>
        </span>
      </label>
      <div className="tb-form-field">
        <span className="field-label">Show on</span>
        <div className="segmented" role="group" aria-label="Which tabs this shortcut is offered on">
          <button type="button" aria-pressed={draft.on === 'claude'} onClick={() => onDraft({ ...draft, on: 'claude' })}>
            Claude tabs
          </button>
          <button type="button" aria-pressed={draft.on === 'any'} onClick={() => onDraft({ ...draft, on: 'any' })}>
            Any tab
          </button>
        </div>
      </div>
      <p className="popover-text">
        {multiline ? 'Line breaks are typed as line breaks in Claude Code; another agent gets the text as a paste where it takes one. ' : ''}
        Shortcuts travel with your settings to your other computers, so keep secrets out of them.
      </p>
      {problem && (
        <p className="popover-text" data-tone="danger" role="alert">
          {problem}
        </p>
      )}
      <div className="popover-actions tb-form-actions">
        {onDelete && (
          <button type="button" className="btn" data-variant="ghost" onClick={onDelete}>
            Delete
          </button>
        )}
        <span className="tb-form-gap" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn" data-variant="primary" onClick={onSave} title={`Save (${isMac ? '⌘↩' : 'Ctrl+Enter'})`}>
          Save
        </button>
      </div>
    </div>
  )
}
