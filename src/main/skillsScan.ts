import { access, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { allSkillDirs, CLAUDE_PLUGIN_SKILLS, pluginSkillName, type SkillDirScan } from '../shared/skills.ts'

/**
 * Read every folder any agent takes skills from, and list the skills in each —
 * a sub-folder holding a SKILL.md — with the real path each one resolves to.
 * Plus one pseudo-folder, `CLAUDE_PLUGIN_SKILLS`: the skills Claude Code's own
 * plugins carry, which only Claude sees.
 *
 * Read-only by design (see shared/skills.ts): the report says where a skill
 * should live; Stoke never moves one. `home` is a parameter so a suite can hand
 * it a whole fake tree rather than the real one (gotcha 74: fake every input or
 * none). Async throughout — a sync walk of a home directory is exactly gotcha
 * 40's stall.
 */
export async function scanSkills(home: string = homedir()): Promise<SkillDirScan[]> {
  const folders = await Promise.all(allSkillDirs().map((dir) => scanSkillDir(dir, expandHome(dir, home))))
  return [...folders, await scanClaudePluginSkills(join(home, '.claude'))]
}

/** `~/x` under `home`. The table's folders are all home-relative. */
export function expandHome(dir: string, home: string): string {
  return join(home, dir.replace(/^~[\\/]?/, ''))
}

/** One skills folder: each child holding a SKILL.md, with its real path. */
export async function scanSkillDir(dir: string, abs: string): Promise<SkillDirScan> {
  return { dir, skills: await skillsIn(abs) }
}

async function skillsIn(abs: string, rename: (name: string) => string = (n) => n): Promise<SkillDirScan['skills']> {
  let names: string[]
  try {
    names = (await readdir(abs, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch {
    return []
  }
  const skills: SkillDirScan['skills'] = []
  for (const name of names.sort()) {
    const path = join(abs, name)
    try {
      await access(join(path, 'SKILL.md'))
      skills.push({ name: rename(name), real: await realpath(path) })
    } catch {
      // Not a skill: no SKILL.md, or a link whose target is gone.
    }
  }
  return skills
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const v: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The skills of every plugin Claude Code has installed at user scope and not
 * switched off, named as Claude invokes them: `<plugin>:<folder>`.
 *
 * Read from `installed_plugins.json` (version 2: `plugins` maps
 * `name@marketplace` to install records with `scope` and `installPath`) and the
 * user settings' `enabledPlugins`. Read-only, and forgiving: the file is the
 * CLI's and undocumented, so anything that does not parse is no plugins rather
 * than an error. Project- and local-scope installs are left out for the same
 * reason the report leaves out project folders: they are per project.
 *
 * Where a plugin keeps its skills follows the CLI's loader (2.1.285): the
 * `skills/` folder, plus any path its manifest's `skills` names — a path that
 * itself holds a SKILL.md is one skill, any other is a folder of them.
 */
export async function scanClaudePluginSkills(claudeDir: string): Promise<SkillDirScan> {
  const out: SkillDirScan = { dir: CLAUDE_PLUGIN_SKILLS, skills: [] }
  const installed = await readJson(join(claudeDir, 'plugins', 'installed_plugins.json'))
  const plugins = installed?.plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return out
  const enabled = (await readJson(join(claudeDir, 'settings.json')))?.enabledPlugins
  const off = (id: string): boolean =>
    !!enabled && typeof enabled === 'object' && !Array.isArray(enabled) && (enabled as Record<string, unknown>)[id] === false
  const found = await Promise.all(
    Object.entries(plugins as Record<string, unknown>).map(async ([id, records]) => {
      if (off(id) || !Array.isArray(records)) return []
      const rec = records.find(
        (r): r is { installPath: string } =>
          !!r && typeof r === 'object' && (r as { scope?: unknown }).scope === 'user' &&
          typeof (r as { installPath?: unknown }).installPath === 'string' &&
          isAbsolute((r as { installPath: string }).installPath)
      )
      if (!rec) return []
      const manifest = await readJson(join(rec.installPath, '.claude-plugin', 'plugin.json'))
      const name = typeof manifest?.name === 'string' && manifest.name ? manifest.name : id.split('@')[0]
      const extra = manifest?.skills
      const paths = [
        join(rec.installPath, 'skills'),
        ...(typeof extra === 'string' ? [extra] : Array.isArray(extra) ? extra.filter((p) => typeof p === 'string') : [])
          .map((p) => resolve(rec.installPath, p))
          // Never outside the plugin: a manifest is someone else's file.
          .filter((p) => p === rec.installPath || p.startsWith(rec.installPath.replace(/[\\/]+$/, '') + sep))
      ]
      const lists = await Promise.all(
        [...new Set(paths)].map(async (p) => {
          try {
            await access(join(p, 'SKILL.md'))
            return [{ name: `${name}:${pluginSkillName(basename(p))}`, real: await realpath(p) }]
          } catch {
            return skillsIn(p, (folder) => `${name}:${pluginSkillName(folder)}`)
          }
        })
      )
      return lists.flat()
    })
  )
  const seen = new Set<string>()
  for (const k of found.flat().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (seen.has(k.name)) continue
    seen.add(k.name)
    out.skills.push(k)
  }
  return out
}
