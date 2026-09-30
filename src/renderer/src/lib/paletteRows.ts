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

export type PaletteRow = { kind: 'project'; hit: ProjectHit } | { kind: 'setting'; hit: SettingsHit }

/**
 * Projects rank by their tier (`TIERS` in projectSearch.ts, 6 a name prefix
 * down to 1 a letter-by-letter match), settings by `paletteTier` on the same
 * scale. Higher first; a tie goes to the project, because the palette is
 * "Find a project" first and its empty query lists only projects. Within each
 * kind the order each search chose is kept.
 */
export function paletteRows(projects: readonly ProjectHit[], settings: readonly SettingsHit[]): PaletteRow[] {
  const tagged = [
    ...projects.map((hit, i) => ({ row: { kind: 'project', hit } as PaletteRow, tier: hit.score, kind: 0, i })),
    ...settings.map((hit, i) => ({ row: { kind: 'setting', hit } as PaletteRow, tier: paletteTier(hit.score), kind: 1, i }))
  ]
  tagged.sort((a, b) => b.tier - a.tier || a.kind - b.kind || a.i - b.i)
  return tagged.map((t) => t.row)
}
