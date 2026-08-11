import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Project, SessionMeta, Settings } from '@shared/types'
import { pathRulesFor } from '../shared/paths.ts'
import { applyProjectMeta } from './projectMeta.ts'
import { contextLimitFor, contextUsed, parseSession, safeParse } from './sessionFile.ts'

const isWin = process.platform === 'win32'

export function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

function claudeConfigPath(): string {
  return join(homedir(), '.claude.json')
}

/**
 * Claude Code names a project's history directory by replacing every
 * non-alphanumeric character in the absolute cwd with a dash.
 * `C:\Users\The Vinh Nguyen` -> `C--Users-The-Vinh-Nguyen`
 */
export function encodePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Native separators, and case-folded on Windows, for use as a dedupe key. */
function normalize(p: string): string {
  const native = isWin ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/')
  return native.replace(/[\\/]+$/, '') || native
}

function dedupeKey(p: string): string {
  const n = normalize(p)
  return isWin ? n.toLowerCase() : n
}

/**
 * `~/.claude.json` can legitimately contain two keys that differ only in case
 * (e.g. `.../refinity` and `.../Refinity`), which is why this reads with
 * JSON.parse and folds case itself rather than trusting the raw key set.
 */
async function readClaudeConfig(): Promise<Record<string, Record<string, unknown>>> {
  try {
    const raw = await readFile(claudeConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as { projects?: Record<string, Record<string, unknown>> }
    return parsed.projects ?? {}
  } catch {
    return {}
  }
}

interface DirInfo {
  dir: string
  full: string
  sessionCount: number
  lastModified: number | null
  newestFile: string | null
}

async function scanHistoryDirs(): Promise<DirInfo[]> {
  const root = projectsRoot()
  let entries: string[] = []
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  const out: DirInfo[] = []
  await Promise.all(
    entries.map(async (dir) => {
      const full = join(root, dir)
      try {
        const files = (await readdir(full)).filter((f) => f.endsWith('.jsonl'))
        let lastModified: number | null = null
        let newestFile: string | null = null
        await Promise.all(
          files.map(async (f) => {
            try {
              const st = await stat(join(full, f))
              const ms = st.mtimeMs
              if (lastModified === null || ms > lastModified) {
                lastModified = ms
                newestFile = join(full, f)
              }
            } catch {
              /* file vanished mid-scan */
            }
          })
        )
        out.push({ dir, full, sessionCount: files.length, lastModified, newestFile })
      } catch {
        /* unreadable directory */
      }
    })
  )
  return out
}

/**
 * Recover the real cwd for a history directory whose encoded name we cannot
 * reverse (the encoding is lossy). Read the head of its newest transcript and
 * take the `cwd` off the first record that carries one.
 */
async function cwdFromTranscript(file: string): Promise<string | null> {
  try {
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n', 200)
    for (const line of lines) {
      const rec = safeParse(line)
      if (rec && typeof rec.cwd === 'string' && rec.cwd) return rec.cwd
    }
  } catch {
    /* ignore */
  }
  return null
}

/** One level of subdirectories under each user-configured scan root. */
async function scanRoots(roots: string[]): Promise<string[]> {
  const found: string[] = []
  await Promise.all(
    roots.map(async (root) => {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        for (const e of entries) {
          if (!e.isDirectory()) continue
          if (e.name.startsWith('.')) continue
          if (e.name === 'node_modules') continue
          found.push(join(root, e.name))
        }
      } catch {
        /* root removed or unreadable */
      }
    })
  )
  return found
}

export async function listProjects(settings: Settings): Promise<Project[]> {
  const [config, dirs, rootDirs] = await Promise.all([
    readClaudeConfig(),
    scanHistoryDirs(),
    scanRoots(settings.projectRoots)
  ])

  const byDir = new Map<string, DirInfo>()
  for (const d of dirs) byDir.set(d.dir.toLowerCase(), d)

  const merged = new Map<string, Project>()
  const claimedDirs = new Set<string>()

  const put = (rawPath: string, info: DirInfo | null, cfg?: Record<string, unknown>): void => {
    const path = normalize(rawPath)
    const key = dedupeKey(path)
    const existing = merged.get(key)
    const project: Project = {
      path,
      name: basename(path) || path,
      group: basename(dirname(path)) || '',
      encodedDir: info?.dir ?? null,
      sessionCount: info?.sessionCount ?? 0,
      lastModified: info?.lastModified ?? null,
      lastCost: typeof cfg?.lastCost === 'number' ? (cfg.lastCost as number) : null,
      lastPrompt:
        typeof cfg?.lastSessionFirstPrompt === 'string'
          ? (cfg.lastSessionFirstPrompt as string)
          : null,
      exists: existsSync(path),
      pinned: settings.pinnedProjects.some((p) => dedupeKey(p) === key),
      emoji: null,
      label: null,
      addedManually: false
    }
    if (existing) {
      // Prefer whichever variant actually has history attached.
      merged.set(key, {
        ...existing,
        ...project,
        encodedDir: project.encodedDir ?? existing.encodedDir,
        sessionCount: Math.max(project.sessionCount, existing.sessionCount),
        lastModified: Math.max(project.lastModified ?? 0, existing.lastModified ?? 0) || null,
        lastCost: project.lastCost ?? existing.lastCost,
        lastPrompt: project.lastPrompt ?? existing.lastPrompt
      })
    } else {
      merged.set(key, project)
    }
  }

  // 1. Projects Claude Code already knows about.
  for (const [rawPath, cfg] of Object.entries(config)) {
    const encoded = encodePath(normalize(rawPath)).toLowerCase()
    const info = byDir.get(encoded) ?? null
    if (info) claimedDirs.add(info.dir.toLowerCase())
    put(rawPath, info, cfg)
  }

  // 2. History directories with no matching config entry (new or renamed projects).
  await Promise.all(
    dirs
      .filter((d) => !claimedDirs.has(d.dir.toLowerCase()) && d.newestFile)
      .map(async (d) => {
        const cwd = await cwdFromTranscript(d.newestFile as string)
        if (cwd) put(cwd, d)
      })
  )

  // 3. Folders discovered under user-configured scan roots, even with no history.
  for (const path of rootDirs) {
    const encoded = encodePath(normalize(path)).toLowerCase()
    put(path, byDir.get(encoded) ?? null)
  }

  /*
   * 4. Folders the user added themselves, and everything they have said about
   *    any folder. Appended BEFORE the hidden filter, so an added folder can
   *    still be hidden — the two settings mean different things and neither
   *    overrides the other.
   */
  const withMeta = applyProjectMeta([...merged.values()], settings.projectMeta ?? {}, {
    rules: pathRulesFor(process.platform),
    pinned: settings.pinnedProjects ?? [],
    exists: existsSync
  })

  const hidden = new Set((settings.hiddenProjects ?? []).map(dedupeKey))
  return withMeta
    .filter((p) => !hidden.has(dedupeKey(p.path)))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.lastModified ?? 0) - (a.lastModified ?? 0)
    })
}

/** Directory holding a project's transcripts, or null when it has no history. */
export async function historyDirFor(projectPath: string): Promise<string | null> {
  const encoded = encodePath(normalize(projectPath))
  const direct = join(projectsRoot(), encoded)
  if (existsSync(direct)) return direct
  // Windows history dirs may differ in case from the encoded path.
  try {
    const entries = await readdir(projectsRoot(), { withFileTypes: true })
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === encoded.toLowerCase())
    return hit ? join(projectsRoot(), hit.name) : null
  } catch {
    return null
  }
}

export async function listSessions(projectPath: string): Promise<SessionMeta[]> {
  const dir = await historyDirFor(projectPath)
  if (!dir) return []

  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }

  const metas = await Promise.all(
    files.map(async (f): Promise<SessionMeta | null> => {
      const full = join(dir, f)
      try {
        const st = await stat(full)
        const parsed = await parseSession(full)
        const used = contextUsed(parsed)
        return {
          id: f.replace(/\.jsonl$/, ''),
          file: full,
          projectPath,
          title: parsed.title,
          firstPrompt: parsed.firstPrompt,
          modified: st.mtimeMs,
          sizeBytes: st.size,
          messageCount: parsed.messageCount,
          model: parsed.model,
          contextTokens: used,
          contextLimit: contextLimitFor(parsed.model, used),
          gitBranch: parsed.gitBranch
        }
      } catch {
        return null
      }
    })
  )

  return metas
    .filter((m): m is SessionMeta => m !== null)
    .sort((a, b) => b.modified - a.modified)
}

/**
 * Locate a transcript by session id alone. Session ids are UUIDs, so a scan
 * across history directories is unambiguous — and it keeps the context meter
 * working even if the session was started in a directory we mis-encoded.
 */
export async function findSessionFile(sessionId: string): Promise<string | null> {
  const root = projectsRoot()
  let dirs: string[]
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return null
  }
  for (const d of dirs) {
    const candidate = join(root, d, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}
