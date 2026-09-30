/*
 * Which skills each coding agent can see, from the folders it reads.
 *
 * Every agent here reads skills in the same format — a folder holding a
 * `SKILL.md` with `name`/`description` frontmatter — so there is nothing to
 * translate. What differs is WHERE each one looks, and that is the whole
 * problem: a skill in `~/.claude/skills` is invisible to Codex, and one copied
 * into `~/.codex/skills` to reach Codex drifts from its original on the next
 * edit. Measured on the machine this was written on (2026-09-18): dozens of
 * skills Claude Code could see that Codex could not, and 14 physical copies
 * between the two.
 *
 * `~/.agents/skills` is the folder nearly all of them share. So the answer this
 * module gives is a REPORT — who sees what, and where to put a skill so everyone
 * does — and never a sync. Copying or linking between these folders on the
 * user's behalf would give the agents that read both folders every skill twice.
 *
 * The one exception is made at launch, not on disk: Claude Code is the only
 * agent that ignores the shared folder, so `claudeProjection` picks the shared
 * skills it would not otherwise see and Stoke hands them to that one process as
 * a plugin (`--plugin-dir`, skillsProject.ts) built of links inside Stoke's own
 * userData. Nothing is written into any agent's folder, nothing is copied, and a
 * Claude Code run outside Stoke is exactly as it was. (`claude import` is the
 * CLI's own answer, and it COPIES the shared folder into `~/.claude/skills` —
 * the drifting copies this report counts.)
 *
 * The folders are each agent's home-level skill directories, from its docs and
 * checked against its --help or source on 2026-09-19. Project-level folders
 * (`.agents/skills` in the repo, `.claude/skills`, …) exist too and follow the
 * same pattern; they are per project, so a machine-wide report leaves them out.
 *
 * Pure, compiled by both tsconfigs, no `node:` import (gotcha 27).
 */
import { CODING_CLIS, type CodingCliId } from './codingClis.ts'

export const SHARED_SKILLS_DIR = '~/.agents/skills'

export const SKILL_DIRS: Record<CodingCliId, readonly string[]> = {
  claude: ['~/.claude/skills'],
  // `~/.codex/skills` first: Codex's own first user root. An earlier version
  // of this table left it out on the word of the docs; running
  // `codex debug prompt-input` against a throwaway home listed it as `r0`.
  codex: ['~/.codex/skills', '~/.agents/skills'],
  grok: ['~/.grok/skills', '~/.agents/skills', '~/.claude/skills', '~/.cursor/skills'],
  opencode: ['~/.config/opencode/skills', '~/.agents/skills', '~/.claude/skills'],
  pi: ['~/.pi/agent/skills', '~/.agents/skills'],
  gemini: ['~/.gemini/skills', '~/.agents/skills'],
  qwen: ['~/.qwen/skills', '~/.agents/skills'],
  kimi: ['~/.kimi-code/skills', '~/.agents/skills'],
  copilot: ['~/.copilot/skills', '~/.agents/skills'],
  cursor: ['~/.cursor/skills', '~/.agents/skills', '~/.claude/skills', '~/.codex/skills'],
  amp: ['~/.config/amp/skills', '~/.config/agents/skills', '~/.agents/skills', '~/.claude/skills'],
  kilo: ['~/.kilo/skills', '~/.config/kilo/skills', '~/.agents/skills', '~/.claude/skills'],
  // Aider has no skills.
  aider: [],
  crush: ['~/.config/crush/skills', '~/.config/agents/skills', '~/.agents/skills', '~/.claude/skills'],
  droid: ['~/.factory/skills', '~/.agents/skills'],
  cline: ['~/.cline/skills', '~/.agents/skills'],
  auggie: ['~/.augment/skills', '~/.agents/skills', '~/.claude/skills'],
  vibe: ['~/.vibe/skills', '~/.agents/skills']
}

/** Every folder any agent reads, once each, in a stable order. */
export function allSkillDirs(): string[] {
  return [...new Set(CODING_CLIS.flatMap((c) => SKILL_DIRS[c.id]))]
}

/**
 * What a scan of one folder found: each skill (a folder holding a SKILL.md) and
 * the real path it resolves to. The real path is what tells a symlink — which
 * cannot drift, it IS the original — from a copy, which can.
 */
export interface SkillDirScan {
  dir: string
  skills: { name: string; real: string }[]
}

/**
 * The skills Claude Code's installed plugins carry, as one pseudo-folder of a
 * scan. Not a folder anyone reads — `skillsScan.ts` builds it from
 * `~/.claude/plugins/installed_plugins.json` — and every name in it is already
 * namespaced the way Claude invokes it (`superpowers:brainstorming`), so it can
 * never be mistaken for a same-named skill in a folder. Only Claude Code sees
 * these; they are the half of the "invisible to others" list a folder scan
 * alone misses.
 */
export const CLAUDE_PLUGIN_SKILLS = '~/.claude/plugins'

const CLAUDE_SKILLS_DIR = '~/.claude/skills'

/**
 * The plugin Stoke hands Claude Code at launch (`--plugin-dir`) to carry the
 * shared folder's skills. Claude names a plugin's skills `<plugin>:<folder>`,
 * so a shared `pdf` is invoked as `/stoke-shared:pdf`, not `/pdf`. Kebab-case
 * because the CLI refuses a path-loaded plugin whose name is not (2.1.285).
 */
export const CLAUDE_SHARED_PLUGIN = 'stoke-shared'

/** What Claude calls a plugin skill's folder: anything outside `[A-Za-z0-9_-]` becomes `-`. */
export function pluginSkillName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9_-]/g, '-')
}

/** Does this folder read as a skill Claude Code can see, by name or by the folder it is? */
function claudeSees(dir: string): boolean {
  return dir === CLAUDE_SKILLS_DIR || dir === CLAUDE_PLUGIN_SKILLS
}

/**
 * The skills in `~/.agents/skills` that Claude Code would NOT otherwise see —
 * the set Stoke projects into one launch as the `stoke-shared` plugin.
 *
 * A shared skill is left out when Claude already has it:
 *   - by NAME in `~/.claude/skills` (a link there, or a same-named skill of its
 *     own, which wins — two skills answering one name is the drift the report
 *     warns about, not something to add a third copy of);
 *   - by REAL PATH anywhere Claude reads, plugins included, so a link under
 *     another name is one skill, not two.
 * Two shared entries resolving to one folder are projected once, by name order,
 * and so are two whose names Claude would flatten to the same `stoke-shared:`
 * name.
 *
 * `overrides` is the merged `skillOverrides` Claude reads for the launch's
 * folder (`skillOverridesFor` in main: the local layer is the git root's). Claude
 * Code applies that setting to its own skills only — its resolver returns "on"
 * for any skill whose source is a plugin (read out of 2.1.285; gotcha 117) —
 * so a per-project trim of a shared skill would be bypassed by the projection
 * unless it is honoured here. Any value but "on" leaves the skill out: "name-only" and
 * "user-invocable-only" cannot be expressed for a plugin skill, and a trim is a
 * decision to spend less context, so the conservative reading is not to add it.
 * The key may be the bare name or the namespaced one.
 */
export function claudeProjection(
  scans: readonly SkillDirScan[],
  overrides: Readonly<Record<string, unknown>> = {}
): { name: string; real: string }[] {
  const shared = scans.find((s) => s.dir === SHARED_SKILLS_DIR)?.skills ?? []
  const claudeNames = new Set(scans.filter((s) => s.dir === CLAUDE_SKILLS_DIR).flatMap((s) => s.skills.map((k) => k.name)))
  const claudeReals = new Set(scans.filter((s) => claudeSees(s.dir)).flatMap((s) => s.skills.map((k) => k.real)))
  const trimmed = (name: string): boolean => {
    for (const key of [name, `${CLAUDE_SHARED_PLUGIN}:${pluginSkillName(name)}`]) {
      const v = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined
      if (v !== undefined && v !== 'on') return true
    }
    return false
  }
  const out: { name: string; real: string }[] = []
  const reals = new Set<string>()
  const flat = new Set<string>()
  for (const k of [...shared].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (claudeNames.has(k.name) || claudeReals.has(k.real)) continue
    if (reals.has(k.real) || flat.has(pluginSkillName(k.name))) continue
    if (trimmed(k.name)) continue
    reals.add(k.real)
    flat.add(pluginSkillName(k.name))
    out.push({ name: k.name, real: k.real })
  }
  return out
}

export interface SkillReport {
  /** Distinct skills found anywhere. */
  total: number
  /** Per agent: how many of those it can see. */
  perAgent: { id: CodingCliId; visible: number }[]
  /** Skills that at least one of the given agents cannot see, with who. */
  partial: { name: string; dirs: string[]; missing: CodingCliId[] }[]
  /** The same skill name in more than one folder — the copies that drift. */
  duplicated: { name: string; dirs: string[] }[]
  /**
   * Shared skills Claude Code sees only because Stoke projects them at launch
   * (`claudeProjection`, machine-wide: a project's own trims can take more out).
   * Empty when sharing is off.
   */
  projected: string[]
}

export function skillReport(
  scans: readonly SkillDirScan[],
  agents: readonly CodingCliId[],
  opts: { shareToClaude?: boolean } = {}
): SkillReport {
  const where = new Map<string, string[]>()
  const reals = new Map<string, Set<string>>()
  for (const s of scans) {
    for (const k of s.skills) {
      where.set(k.name, [...(where.get(k.name) ?? []), s.dir])
      reals.set(k.name, (reals.get(k.name) ?? new Set()).add(k.real))
    }
  }
  const lending = opts.shareToClaude ? claudeProjection(scans) : []
  const projected = lending.map((k) => k.name)
  /*
   * Visible by FOLDER, or by REAL PATH: a skill linked under another name, or
   * the same folder reached through a plugin, is the same skill, and an agent
   * that has it under one name is not missing it under the other. Claude also
   * reads its plugins, and what Stoke lends it at launch.
   */
  const readsDir = (id: CodingCliId, dir: string): boolean =>
    SKILL_DIRS[id].includes(dir) || (id === 'claude' && dir === CLAUDE_PLUGIN_SKILLS)
  const realsFor = new Map<CodingCliId, Set<string>>()
  for (const id of agents) {
    const set = new Set(scans.filter((s) => readsDir(id, s.dir)).flatMap((s) => s.skills.map((k) => k.real)))
    if (id === 'claude') for (const k of lending) set.add(k.real)
    realsFor.set(id, set)
  }
  const sees = (id: CodingCliId, name: string): boolean => {
    if (where.get(name)!.some((d) => readsDir(id, d))) return true
    const mine = realsFor.get(id)!
    return [...reals.get(name)!].some((r) => mine.has(r))
  }
  // An agent with no skill folders at all (Aider) is not "missing" anything.
  const readers = agents.filter((id) => SKILL_DIRS[id].length > 0)
  const names = [...where.keys()].sort()
  return {
    total: names.length,
    perAgent: agents.map((id) => ({ id, visible: names.filter((n) => sees(id, n)).length })),
    partial: names
      .map((name) => ({ name, dirs: where.get(name)!, missing: readers.filter((id) => !sees(id, name)) }))
      .filter((r) => r.missing.length > 0),
    // Two folders holding the same skill through a link is one skill; two real
    // folders with the same name are two copies, and the next edit splits them.
    duplicated: names.filter((n) => reals.get(n)!.size > 1).map((name) => ({ name, dirs: where.get(name)! })),
    projected
  }
}
