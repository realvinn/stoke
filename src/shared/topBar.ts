/**
 * The title bar's own items: where the tab in front is, its git state, and the
 * owner's text shortcuts — the `topBar` settings block, its defaults, its
 * repair, and every rule the bar decides by.
 *
 * Pure and import-free apart from types and `codingClis`, so main's
 * `hydrateSettings`, the renderer's bar and `verify:topbar` all run the one
 * copy under node strip-types (gotchas 27, 78). Nothing here touches the DOM.
 *
 * The items live INSIDE the 44px title bar, between the tab strip and the
 * right-hand actions (the owner's choice, 2026-10-02), not on a row of their
 * own: a row would cost every terminal ~30px of height for what is a handful
 * of chips. That makes width the scarce thing, so `fitTopBar` decides how the
 * bar gives way on a narrow window — folder to its name, git to its branch,
 * then shortcuts into a "»" menu — and the tab strip keeps `TABS_FLOOR_REM`.
 */
import { cliIdOf, isClaudeCode } from './codingClis.ts'
import { PRIVATE_CHAT_NAME, PRIVATE_FOLDER_TEXT } from './privateChat.ts'

/** Where the folder chip reads: the whole (shortened) path, or the folder's name. */
export type FolderStyle = 'path' | 'name'

/**
 * Which tabs a shortcut is offered on. `claude` is a Claude Code tab (an SSH tab
 * runs `claude` on the far machine, so it is one too); `any` is every running
 * session, a plain shell or another agent included.
 */
export type ShortcutScope = 'any' | 'claude'

export interface TopBarFolder {
  id: string
  kind: 'folder'
  style: FolderStyle
}

export interface TopBarGit {
  id: string
  kind: 'git'
}

export interface TopBarShortcut {
  id: string
  kind: 'shortcut'
  /** What the chip says. Never empty once repaired. */
  label: string
  /** One emoji drawn before the label, or ''. */
  icon: string
  /** What it types. Newlines are line breaks inside Claude Code's box (ESC CR, gotcha 86). */
  text: string
  /**
   * Press Enter after typing, which sends it. Off by default and chosen when the
   * shortcut is made (the owner, 2026-10-02): a shortcut that only types leaves
   * the text in the box for a look before sending.
   */
  send: boolean
  on: ShortcutScope
}

export interface TopBarSpacer {
  id: string
  kind: 'spacer'
}

export type TopBarItem = TopBarFolder | TopBarGit | TopBarShortcut | TopBarSpacer
export type TopBarKind = TopBarItem['kind']

export interface TopBarSettings {
  /** Draw the items at all. Off leaves the title bar exactly as it was before they existed. */
  enabled: boolean
  items: TopBarItem[]
}

/**
 * On, with git alone — one icon button. The folder chip was a default too
 * (2026-10-02) until the owner asked for it gone (2026-10-03): "we already
 * have the right click and the bottom left for that", and the title bar's
 * width is wanted for the tabs and for grabbing the window. It is one Add
 * away. Fixed ids: a default is not "added", so nothing is minted for it — ids
 * are minted only when an item is added, in the renderer, never in hydrate
 * (gotcha 116: hydrate is not idempotent, and a random id there would make
 * every import preview a change).
 */
export const TOP_BAR_DEFAULTS: TopBarSettings = {
  enabled: true,
  items: [{ id: 'git', kind: 'git' }]
}

/**
 * Empty title bar kept beside the tabs for grabbing the window (rem, so it
 * follows Interface scale), whatever the tabs and the items would take: with
 * a few tabs open the bar had nowhere left to drag (the owner, 2026-10-03).
 * Counted like the bar's own controls (`topBarKeep`), so the tab strip's floor
 * yields to it and the items fit beside it.
 */
export const DRAG_GAP_REM = 3

export const TOP_BAR_MAX_ITEMS = 24
export const SHORTCUT_LABEL_MAX = 24
export const SHORTCUT_TEXT_MAX = 2000
/**
 * Every shortcut's text together, in bytes AS THE HUB CARRIES IT
 * (`shortcutCost`). The block travels as ONE hub item (T1,
 * `t1/settings/topBar`), and an item is at most 128 KiB of plaintext
 * (`MAX_ITEM_PLAINTEXT_BYTES`): 24 shortcuts of 2000 CJK characters would be
 * 144 KB. 48 KiB leaves room for the labels and the rest.
 */
export const SHORTCUT_TEXT_BUDGET = 48 * 1024
/** The least the tab strip keeps when the bar needs room (rem, so it follows Interface scale). */
export const TABS_FLOOR_REM = 16
/** The same while the bar is being edited: the editor needs the room more than the tabs do. */
export const TABS_FLOOR_EDIT_REM = 8

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

const utf8 = (s: string): number => new TextEncoder().encode(s).length

/**
 * What one shortcut's text costs of `SHORTCUT_TEXT_BUDGET`: its UTF-8 bytes
 * once JSON-escaped, which is how the hub item holds it. Raw UTF-8 undercounts
 * by up to six times — a control character is one byte and `\u0001` in the
 * item — so 24 shortcuts of pasted control characters measured 288 KB as an
 * item, and `sealItem`'s "item too large to sync" throws inside the upload's
 * batch, failing the WHOLE pass, every other setting with it (found in review,
 * 2026-10-02). The form and the repair both count with this, so the form never
 * accepts a draft the repair would then drop.
 */
export function shortcutCost(text: string): number {
  return utf8(JSON.stringify(text))
}

/** Cut to at most `max` code points, never inside a surrogate pair. */
function cutPoints(s: string, max: number): string {
  const points = Array.from(s)
  return points.length <= max ? s : points.slice(0, max).join('')
}

/**
 * One emoji, or nothing. A grapheme of up to 16 UTF-16 units that holds a
 * pictograph — so `👍🏽`, `🧑‍💻` and a flag pass, `ab` and `😀😀` do not.
 * `Intl.Segmenter` where the runtime has it (Node 16+, Chromium); without it
 * one code point plus its modifiers is the rule.
 */
export function isSingleEmoji(s: string): boolean {
  if (!s || s.length > 16) return false
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return false
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<unknown> } }).Segmenter
  if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s)).length === 1
  return /^(\p{Extended_Pictographic}|\p{Regional_Indicator}{2})[\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}\p{Extended_Pictographic}]*$/u.test(s)
}

/** What a shortcut with no label is called: its text's first line, cut to fit. */
export function labelFromText(text: string): string {
  const first = text.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? ''
  return cutPoints(first.trim(), SHORTCUT_LABEL_MAX)
}

/**
 * Repair a stored block. Rebuilt from named keys (CLAUDE.md's clamp rule: a
 * field a clamp does not name hydrates as undefined), so:
 * - an unknown kind, a bad or duplicate id, and an item past the cap are dropped;
 * - a second folder or git item is dropped (each can only say one thing);
 * - a shortcut with no text is dropped, an over-long label or text is cut, a
 *   label-less one is named from its text, an icon that is not one emoji goes;
 * - shortcuts past the text budget are dropped from the end, so the block
 *   always fits one hub item.
 * A block that is not an object is the default; an `items` that is not an
 * array is no items, since a person who emptied the bar meant it.
 */
export function clampTopBar(raw: unknown): TopBarSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: TOP_BAR_DEFAULTS.enabled, items: TOP_BAR_DEFAULTS.items.map((i) => ({ ...i })) }
  }
  const r = raw as { enabled?: unknown; items?: unknown }
  const items: TopBarItem[] = []
  const ids = new Set<string>()
  let folder = false
  let git = false
  let budget = SHORTCUT_TEXT_BUDGET
  for (const v of Array.isArray(r.items) ? r.items : []) {
    if (items.length >= TOP_BAR_MAX_ITEMS) break
    if (!v || typeof v !== 'object') continue
    const it = v as Record<string, unknown>
    const id = typeof it.id === 'string' && ID_RE.test(it.id) ? it.id : null
    if (!id || ids.has(id)) continue
    if (it.kind === 'folder') {
      if (folder) continue
      folder = true
      items.push({ id, kind: 'folder', style: it.style === 'name' ? 'name' : 'path' })
    } else if (it.kind === 'git') {
      if (git) continue
      git = true
      items.push({ id, kind: 'git' })
    } else if (it.kind === 'spacer') {
      items.push({ id, kind: 'spacer' })
    } else if (it.kind === 'shortcut') {
      const text = typeof it.text === 'string' ? cutPoints(it.text, SHORTCUT_TEXT_MAX) : ''
      if (!text.trim()) continue
      const cost = shortcutCost(text)
      if (cost > budget) continue
      budget -= cost
      const given = typeof it.label === 'string' ? cutPoints(it.label.trim(), SHORTCUT_LABEL_MAX) : ''
      items.push({
        id,
        kind: 'shortcut',
        label: given || labelFromText(text),
        icon: typeof it.icon === 'string' && isSingleEmoji(it.icon) ? it.icon : '',
        text,
        send: it.send === true,
        on: it.on === 'claude' ? 'claude' : 'any'
      })
    } else continue
    ids.add(id)
  }
  return { enabled: r.enabled !== false, items }
}

/* ------------------------------------------------------------- editing */

/**
 * A fresh id for an item being added, never one already in the list. `rand`
 * is injected so a suite can pin it; the bar passes `Math.random`.
 */
export function mintItemId(kind: TopBarKind, items: readonly TopBarItem[], rand: () => number = Math.random): string {
  const taken = new Set(items.map((i) => i.id))
  for (;;) {
    const id = `${kind}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0')}`
    if (!taken.has(id)) return id
  }
}

/** Why an item of this kind cannot be added now, or null. */
export function addRefusal(kind: TopBarKind, items: readonly TopBarItem[]): string | null {
  if (items.length >= TOP_BAR_MAX_ITEMS) return `The title bar holds at most ${TOP_BAR_MAX_ITEMS} items.`
  if (kind === 'folder' && items.some((i) => i.kind === 'folder')) return 'The folder is already in the title bar.'
  if (kind === 'git' && items.some((i) => i.kind === 'git')) return 'Git is already in the title bar.'
  return null
}

/**
 * Move one item a step left (-1) or right (+1): the keyboard's Alt+arrow.
 * Unchanged at either end, or for an id that is not there.
 */
export function nudgeItem<T extends { id: string }>(items: readonly T[], id: string, delta: -1 | 1): T[] {
  const from = items.findIndex((i) => i.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= items.length) return [...items]
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** Drop one item; the id to focus next (its right neighbour, else its left), or null. */
export function removeItem<T extends { id: string }>(items: readonly T[], id: string): { items: T[]; focus: string | null } {
  const at = items.findIndex((i) => i.id === id)
  if (at < 0) return { items: [...items], focus: null }
  const next = items.filter((i) => i.id !== id)
  return { items: next, focus: next[Math.min(at, next.length - 1)]?.id ?? null }
}

export interface ShortcutDraft {
  label: string
  icon: string
  text: string
  send: boolean
  on: ShortcutScope
}

/**
 * Why the shortcut form cannot save, or null. `others` is every OTHER
 * shortcut's text, for the budget. The repair above would cut or drop quietly;
 * the form says so first, so nothing a person typed is lost without a word.
 */
export function shortcutDraftProblem(d: ShortcutDraft, othersText: readonly string[] = []): string | null {
  if (!d.text.trim()) return 'Type the text this shortcut should type.'
  if (Array.from(d.text).length > SHORTCUT_TEXT_MAX) return `The text is longer than ${SHORTCUT_TEXT_MAX} characters.`
  if (Array.from(d.label.trim()).length > SHORTCUT_LABEL_MAX) return `The label is longer than ${SHORTCUT_LABEL_MAX} characters.`
  if (d.icon && !isSingleEmoji(d.icon)) return 'The icon is one emoji, or nothing.'
  const used = othersText.reduce((n, t) => n + shortcutCost(t), 0)
  if (used + shortcutCost(d.text) > SHORTCUT_TEXT_BUDGET) return 'Your shortcuts together hold as much text as the title bar keeps. Shorten this one or remove another.'
  return null
}

/** The draft as an item, under `id`. Assumes `shortcutDraftProblem` passed. */
export function shortcutFromDraft(id: string, d: ShortcutDraft): TopBarShortcut {
  return {
    id,
    kind: 'shortcut',
    label: d.label.trim() || labelFromText(d.text),
    icon: d.icon && isSingleEmoji(d.icon) ? d.icon : '',
    text: d.text,
    send: d.send,
    on: d.on
  }
}

/* ------------------------------------------------- what a shortcut may do */

/** The tab in front, as far as a shortcut is concerned. */
export interface ShortcutTarget {
  kind: 'session' | 'new' | 'remote'
  status: 'running' | 'exited' | 'paused'
  cliId: string
  /** An install, key-enrollment or sign-in tab: a terminal, but not a session to type a prompt into. */
  utility: boolean
  /** The activity dot (`activityView`): `waiting` is a question on screen. */
  dot: string | null
}

export type ShortcutVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Whether a shortcut may type into the tab in front, and if not, why — the
 * chip is drawn disabled with that sentence as its tooltip.
 *
 * Refused while the tab is `waiting`: a permission prompt or a question takes
 * single keys, so a shortcut starting `1` or `y` would ANSWER it (gotcha 104;
 * the phone's one-tap answer has the same caution). Refused on a tab that is
 * not a running session: there is nothing to type into, and on another
 * machine's session the text would go over the relay, which v1 does not do.
 */
export function shortcutVerdict(item: Pick<TopBarShortcut, 'on'>, tab: ShortcutTarget | null): ShortcutVerdict {
  if (!tab || tab.kind === 'new') return { ok: false, reason: 'Start a session first: there is nothing to type into here.' }
  if (tab.kind === 'remote') return { ok: false, reason: 'Not into another machine’s session.' }
  if (tab.utility) return { ok: false, reason: 'Not into an install, key or sign-in tab.' }
  if (tab.status !== 'running') return { ok: false, reason: 'This session is not running.' }
  if (item.on === 'claude' && !isClaudeCode(cliIdOf(tab.cliId))) return { ok: false, reason: 'Only on Claude Code tabs — this tab runs another agent.' }
  if (tab.dot === 'waiting') return { ok: false, reason: 'Claude is asking you something. Answer it first: typed keys would answer it.' }
  return { ok: true }
}

/* ---------------------------------------------------------- the folder chip */

/**
 * What the folder chip says for the tab in front, or null to draw nothing.
 *
 * An SSH tab's `cwd` is the host ALIAS, not a folder (gotcha 18), so it says
 * which machine and is never openable — `shell.openPath('vps')` opens nothing
 * useful. Another machine's session names that machine. A New tab has no
 * folder yet.
 *
 * A private chat's `cwd` is the scratch folder main made for it under
 * userData and deletes with it (shared/privateChat.ts), so the chip says
 * "Private chat" and is never openable: it drew `…/<uuid>` with an Open that
 * put the file manager on a folder about to go. A host label of only spaces
 * names the alias, as the tab menu does (Settings stores a label as typed).
 */
export function folderChip(
  tab: { kind: 'session' | 'new' | 'remote'; cwd: string; hostId: string | null; private?: boolean } | null,
  opts: { style: FolderStyle; hostLabel: string | null; deviceLabel: string | null }
): { text: string; compact: string; title: string; open: string | null; where: 'local' | 'host' | 'device' | 'private' } | null {
  if (!tab || tab.kind === 'new') return null
  if (tab.kind === 'remote') {
    const name = opts.deviceLabel?.trim() || 'another machine'
    return { text: name, compact: name, title: `A session on ${name}`, open: null, where: 'device' }
  }
  if (tab.hostId) {
    const name = opts.hostLabel?.trim() || tab.cwd.trim()
    return { text: name, compact: name, title: `On ${name} over SSH — its folders are on that machine`, open: null, where: 'host' }
  }
  if (tab.private) {
    return { text: PRIVATE_CHAT_NAME, compact: 'Private', title: PRIVATE_FOLDER_TEXT, open: null, where: 'private' }
  }
  if (!tab.cwd) return null
  const name = baseNameOf(tab.cwd)
  return {
    text: opts.style === 'name' ? name : pathTail(tab.cwd),
    compact: name,
    title: `Open ${tab.cwd}`,
    open: tab.cwd,
    where: 'local'
  }
}

/** The last segment of a path, either separator. */
export function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** The longest a folder chip's path runs before it keeps only its tail. */
export const FOLDER_PATH_MAX = 40

/**
 * A path cut from the LEFT at a separator, so the end — the part that says
 * which folder — stays: `/Users/me/dev/personal/stoke/app` becomes
 * `…/personal/stoke/app`. The last segment is kept whole however long it is.
 */
export function pathTail(path: string, max: number = FOLDER_PATH_MAX): string {
  if (Array.from(path).length <= max) return path
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const parts = path.split(/[\\/]+/).filter(Boolean)
  let out = parts.pop() ?? path
  while (parts.length) {
    const next = `${parts[parts.length - 1]}${sep}${out}`
    if (Array.from(next).length + 2 > max) break
    out = next
    parts.pop()
  }
  return `…${sep}${out}`
}

/* ----------------------------------------------------- giving way on width */

/**
 * The least the tab strip keeps (`--tabs-floor`), in px: its natural width or
 * `TABS_FLOOR_REM`, whichever is less — but never more than the bar has left
 * once the things that never shrink are placed, less `keep` (the bar's own
 * pencil, or its editing controls).
 *
 * `.titlebar-actions` does not shrink (`flex-shrink: 0`), so a floor that does
 * not yield pushes them past the window's right edge: at the 940px minimum
 * with Interface scale 1.6 and four tabs, the floor was 409px and the usage
 * chip and Settings gear ended at 1077px, out of reach (driven in the built
 * app, 2026-10-02). With the items off, the strip is `min-width: 0` and the
 * actions always stayed; with them on — the default — the strip gives way to
 * the actions first, as it always did, and only then holds its floor against
 * the items.
 */
export function tabsFloorPx(input: { natural: number; floor: number; avail: number; keep: number }): number {
  const { natural, floor, avail, keep } = input
  return Math.max(0, Math.floor(Math.min(natural, floor, avail - keep)))
}

/**
 * The least the bar itself must keep (`tabsFloorPx`'s `keep`): its trailing
 * controls and the gap before them, the window's drag space and its gap
 * (`dragGapPx`, 0 while editing, when the list scrolls instead), plus the "»"
 * and its gap whenever a shortcut could be moved into it — out of edit mode,
 * with a shortcut on the bar. Kept to the trail alone, the "»" that appears
 * once every shortcut has moved drew over the Find button at 940px and
 * Interface scale 1.6 (driven, 2026-10-02); and without the gap before the
 * trail, the bar's content ran 6px past its box there (measured, 2026-10-03).
 */
export function topBarKeep(input: {
  trail: number
  more: number
  gap: number
  shortcuts: boolean
  editing: boolean
  drag?: number
}): number {
  const { trail, more, gap, shortcuts, editing, drag = 0 } = input
  return trail + gap + (drag > 0 && !editing ? drag + gap : 0) + (shortcuts && !editing ? more + gap : 0)
}

/**
 * How much of `DRAG_GAP_REM` (`want`, in px) the bar keeps for grabbing the
 * window: all of it while the tab strip still has its floor beside it (`tabs`,
 * the lesser of its natural width and `TABS_FLOOR_REM`), less as the bar runs
 * out, none while editing. It gives way FIRST: held whole, at 940px and
 * Interface scale 1.6 it took the tab strip to nothing and pushed the pencil
 * over the Find button (driven, 2026-10-03).
 */
export function dragGapPx(input: {
  want: number
  avail: number
  /** `topBarKeep` with no drag. */
  keep: number
  gap: number
  tabs: number
  editing: boolean
}): number {
  const { want, avail, keep, gap, tabs, editing } = input
  if (editing) return 0
  return Math.max(0, Math.floor(Math.min(want, avail - keep - gap - tabs)))
}

export interface FitItem {
  id: string
  kind: TopBarKind
  /** Width in px as drawn in full. */
  full: number
  /** Width in px compact: folder as its name, git as its branch; anything else as full. */
  compact: number
  /**
   * The folder and git chips' CSS `min-width`: the least it can be squeezed
   * to, its text cut with an ellipsis — and, being a min-width, also the least
   * it is ever drawn, so a compact chip narrower than this (git's "main" is
   * ~64px against a 5.5rem floor) is counted at it. Absent: it cannot be squeezed.
   */
  min?: number
}

export interface FitInput {
  /** The px the whole bar may use: the title bar's room once the tab strip keeps its floor. */
  room: number
  /** The flex gap between chips. */
  gap: number
  /** What always stays: the pencil, or the editing controls. */
  fixed: number
  /** The "»" button. */
  more: number
  /** The items in display order. A spacer's widths are 0: it only takes what is left. */
  items: readonly FitItem[]
}

export interface FitResult {
  /** Items drawn compact: the folder as its name, git as its branch. Folder first. */
  compact: string[]
  /** Shortcut ids moved into the "»" menu, in display order. */
  overflow: string[]
  /** Folder or git ids not drawn at all — only when even the compact bar with every shortcut moved does not fit. */
  hidden: string[]
}

/**
 * How the bar gives way, in order: everything in full; the folder to its name;
 * git to its branch; shortcuts into "»" from the right end, one at a time;
 * folder and git squeezed to their `min` (an ellipsis, which the CSS does);
 * then git, then the folder, left out. The folder goes first because its path
 * is the widest thing on the bar and its name says nearly as much; git's
 * changes and ahead/behind say what nothing else does. The tab strip never
 * gives more than its floor — that is already taken out of `room` by the caller.
 * Since 2026-10-03 TopBar draws git as one icon, the same in both forms and
 * with no `min`, so its compact and squeeze steps change nothing; the rule is
 * kept general for whatever a chip passes.
 */
export function fitTopBar(input: FitInput): FitResult {
  const { room, gap, fixed, more, items } = input
  let squeeze = false
  const total = (compact: ReadonlySet<string>, out: ReadonlySet<string>, hidden: ReadonlySet<string>): number => {
    const shown = items.filter((i) => !out.has(i.id) && !hidden.has(i.id))
    const widths = shown.map((i) => {
      const w = compact.has(i.id) ? i.compact : i.full
      /*
       * A min-width both floors and grows: squeezed, the chip is its min;
       * otherwise never narrower than it. Counted at its content alone, git
       * compact as "main" read 24px short at 940px, and the chips ran 5px past
       * the list, under the "»" (driven, 2026-10-02).
       */
      if (i.min === undefined) return w
      return squeeze ? i.min : Math.max(w, i.min)
    })
    const count = shown.length + 1 + (out.size > 0 ? 1 : 0)
    return widths.reduce((a, b) => a + b, 0) + fixed + (out.size > 0 ? more : 0) + gap * Math.max(0, count - 1)
  }
  const none = new Set<string>()
  const compact = new Set<string>()
  if (total(compact, none, none) <= room) return { compact: [], overflow: [], hidden: [] }
  for (const kind of ['folder', 'git'] as const) {
    const it = items.find((i) => i.kind === kind)
    if (!it) continue
    compact.add(it.id)
    if (total(compact, none, none) <= room) return { compact: order(items, compact), overflow: [], hidden: [] }
  }
  const out = new Set<string>()
  const shortcuts = items.filter((i) => i.kind === 'shortcut')
  for (let i = shortcuts.length - 1; i >= 0; i--) {
    out.add(shortcuts[i].id)
    if (total(compact, out, none) <= room) return { compact: order(items, compact), overflow: order(items, out), hidden: [] }
  }
  squeeze = true
  if (total(compact, out, none) <= room) return { compact: order(items, compact), overflow: order(items, out), hidden: [] }
  const hidden = new Set<string>()
  for (const kind of ['git', 'folder'] as const) {
    const it = items.find((i) => i.kind === kind)
    if (!it) continue
    hidden.add(it.id)
    if (total(compact, out, hidden) <= room) break
  }
  return { compact: order(items, compact), overflow: order(items, out), hidden: order(items, hidden) }
}

const order = (items: readonly FitItem[], set: ReadonlySet<string>): string[] =>
  items.filter((i) => set.has(i.id)).map((i) => i.id)
