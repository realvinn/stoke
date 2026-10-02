/**
 * The command palette's one list: projects and settings, interleaved by how
 * good a match each is.
 *
 * Pure and here rather than in the component so `verify:settings-search` can
 * hold the order: it is the difference between Cmd+K "font" opening a project
 * that happened to contain f, o, n and t in that order, and opening Terminal ›
 * Font. Runtime imports carry `.ts` and reach only `src/shared` (gotcha 78);
 * `ProjectHit` is a type, which strip-types erases.
 */
import type { ProjectHit } from './projectSearch'
import { paletteTier, type SettingsHit } from '../../../shared/settingsIndex.ts'

/** The most settings one query lists. The palette is for going somewhere, not browsing Settings. */
export const SETTINGS_IN_PALETTE = 8

export type PaletteRow =
  | { kind: 'project'; hit: ProjectHit }
  | { kind: 'setting'; hit: SettingsHit }
  | { kind: 'action'; hit: ActionHit }

/**
 * Something the palette can DO rather than open: today only a new private
 * chat (shared/privateChat.ts). Found by its label or the words people use for
 * the thing — "temporary", "incognito" — and only for a query: the empty
 * palette is "Find a project" and lists projects alone.
 */
export interface PaletteAction {
  id: 'private'
  label: string
  /** The line under it: what it does. */
  hint: string
  /** Other words that find it, matched at a word's start. */
  words: readonly string[]
}

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'private',
    label: 'New private chat',
    hint: 'Claude Code that saves nothing; closing the tab deletes it',
    words: ['private', 'temporary', 'incognito', 'ghost', 'scratch']
  }
]

export interface ActionHit {
  action: PaletteAction
  /** On the same scale as a project's tier (6 a label prefix, 5 a word in it, 4 another word). */
  score: number
  ranges: Array<readonly [number, number]>
}

/** The actions a query finds, best first. */
export function searchPaletteActions(query: string, actions: readonly PaletteAction[] = PALETTE_ACTIONS): ActionHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: ActionHit[] = []
  for (const action of actions) {
    const label = action.label.toLowerCase()
    if (label.startsWith(q)) {
      out.push({ action, score: 6, ranges: [[0, q.length]] })
      continue
    }
    const at = [...label.matchAll(/\b\w/g)].map((m) => m.index ?? 0).find((i) => label.startsWith(q, i))
    if (at !== undefined) {
      out.push({ action, score: 5, ranges: [[at, at + q.length]] })
      continue
    }
    if (action.words.some((w) => w.startsWith(q))) out.push({ action, score: 4, ranges: [] })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * Projects rank by their tier (`TIERS` in projectSearch.ts, 6 a name prefix
 * down to 1 a letter-by-letter match), settings by `paletteTier` on the same
 * scale. Higher first; a tie goes to the project, because the palette is
 * "Find a project" first and its empty query lists only projects. Within each
 * kind the order each search chose is kept.
 */
export function paletteRows(
  projects: readonly ProjectHit[],
  settings: readonly SettingsHit[],
  actions: readonly ActionHit[] = []
): PaletteRow[] {
  const tagged = [
    ...projects.map((hit, i) => ({ row: { kind: 'project', hit } as PaletteRow, tier: hit.score, kind: 0, i })),
    ...settings.map((hit, i) => ({ row: { kind: 'setting', hit } as PaletteRow, tier: paletteTier(hit.score), kind: 1, i })),
    // Last on a tie: a project or a setting named for the query is what was asked for.
    ...actions.map((hit, i) => ({ row: { kind: 'action', hit } as PaletteRow, tier: hit.score, kind: 2, i }))
  ]
  tagged.sort((a, b) => b.tier - a.tier || a.kind - b.kind || a.i - b.i)
  return tagged.map((t) => t.row)
}
