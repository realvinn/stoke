import { access, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { allSkillDirs, type SkillDirScan } from '../shared/skills.ts'

/**
 * Read every folder any agent takes skills from, and list the skills in each —
 * a sub-folder holding a SKILL.md — with the real path each one resolves to.
 *
 * Read-only by design (see shared/skills.ts): the report says where a skill
 * should live; Stoke never moves one. `home` is a parameter so a suite can hand
 * it a whole fake tree rather than the real one (gotcha 74: fake every input or
 * none). Async throughout — a sync walk of a home directory is exactly gotcha
 * 40's stall.
 */
export async function scanSkills(home: string = homedir()): Promise<SkillDirScan[]> {
  return Promise.all(
    allSkillDirs().map(async (dir) => {
      const abs = join(home, dir.replace(/^~[\\/]?/, ''))
      let names: string[]
      try {
        names = (await readdir(abs, { withFileTypes: true }))
          .filter((e) => e.isDirectory() || e.isSymbolicLink())
          .map((e) => e.name)
      } catch {
        return { dir, skills: [] }
      }
      const skills: SkillDirScan['skills'] = []
      for (const name of names.sort()) {
        const path = join(abs, name)
        try {
          await access(join(path, 'SKILL.md'))
          skills.push({ name, real: await realpath(path) })
        } catch {
          // Not a skill: no SKILL.md, or a link whose target is gone.
        }
      }
      return { dir, skills }
    })
  )
}
