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

export interface SkillReport {
  /** Distinct skills found anywhere. */
  total: number
  /** Per agent: how many of those it can see. */
  perAgent: { id: CodingCliId; visible: number }[]
  /** Skills that at least one of the given agents cannot see, with who. */
  partial: { name: string; dirs: string[]; missing: CodingCliId[] }[]
  /** The same skill name in more than one folder — the copies that drift. */
  duplicated: { name: string; dirs: string[] }[]
}

export function skillReport(scans: readonly SkillDirScan[], agents: readonly CodingCliId[]): SkillReport {
  const where = new Map<string, string[]>()
  const reals = new Map<string, Set<string>>()
  for (const s of scans) {
    for (const k of s.skills) {
      where.set(k.name, [...(where.get(k.name) ?? []), s.dir])
      reals.set(k.name, (reals.get(k.name) ?? new Set()).add(k.real))
    }
  }
  const sees = (id: CodingCliId, dirs: string[]): boolean => dirs.some((d) => SKILL_DIRS[id].includes(d))
  // An agent with no skill folders at all (Aider) is not "missing" anything.
  const readers = agents.filter((id) => SKILL_DIRS[id].length > 0)
  const names = [...where.keys()].sort()
  return {
    total: names.length,
    perAgent: agents.map((id) => ({ id, visible: names.filter((n) => sees(id, where.get(n)!)).length })),
    partial: names
      .map((name) => {
        const dirs = where.get(name)!
        return { name, dirs, missing: readers.filter((id) => !sees(id, dirs)) }
      })
      .filter((r) => r.missing.length > 0),
    // Two folders holding the same skill through a link is one skill; two real
    // folders with the same name are two copies, and the next edit splits them.
    duplicated: names.filter((n) => reals.get(n)!.size > 1).map((name) => ({ name, dirs: where.get(name)! }))
  }
}
