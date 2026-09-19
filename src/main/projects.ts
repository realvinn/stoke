import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Project, ProjectMeta, SessionMeta, Settings } from '@shared/types'
import { normalizePath, pathRulesFor } from '../shared/paths.ts'
import { applyProjectMeta } from './projectMeta.ts'
import {
  CHUNK,
  contextLimitFor,
  contextUsed,
  parseSession,
  readRange,
  safeParse
} from './sessionFile.ts'

const isWin = process.platform === 'win32'

/**
 * How long a path gets to say whether it exists before it is called absent.
 *
 * Not a guess at disk latency — a cap on how wrong the list may be. A folder on
 * a volume that cannot answer is reported the same way a deleted one is, and
 * the next refresh corrects it once the volume is awake.
 */
const EXISTS_DEADLINE_MS = 1500

/**
 * Does this path exist? Asynchronously, and with a deadline.
 *
 * This was `existsSync`, and that is the single most expensive thing Stoke did
 * at boot. `listProjects` runs in the main process, so a synchronous stat stops
 * the whole app — every IPC reply, every frame, every keystroke — for however
 * long the filesystem takes to answer. On an internal SSD that is microseconds
 * and invisible. It is neither on anything else: an external USB disk that
 * macOS has spun down (`pmset disksleep`, ten minutes by default) answers its
 * first stat in seconds, and a disconnected network share may not answer at all.
 *
 * Measured on the machine this was found on: one boot made 392 synchronous
 * `existsSync` calls, 40 of them against paths on an external USB SSD. Injecting
 * 200ms into each of those moved `ready-to-show` from 733ms to 2012ms and held
 * the main thread for 6.4s of the first six seconds — the window appears and
 * then sits frozen, which is exactly what "sometimes it takes ages to start"
 * looks like from outside. Off the main thread the same delay costs nothing
 * visible, because nothing is waiting on it.
 *
 * The deadline is the other half, and it is what stops one asleep disk from
 * delaying the list for everyone else in it.
 */
async function pathExists(path: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      access(path),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), EXISTS_DEADLINE_MS)
        // Never hold the process open for this; it is a deadline, not work.
        timer.unref?.()
      })
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Resolve a whole set of paths at once, deduplicated, in parallel. */
async function existsMap(paths: Iterable<string>): Promise<Map<string, boolean>> {
  const unique = [...new Set(paths)]
  const answers = await Promise.all(unique.map(pathExists))
  return new Map(unique.map((p, i) => [p, answers[i]]))
}

/**
 * A path's realpath, or the path unchanged when it cannot be resolved in
 * time (same deadline `pathExists` uses, for the same reason: one asleep
 * volume must not delay the whole list) or does not exist. A folder that is
 * gone still needs SOME dedupe key, and falling back to the typed string is
 * what lets a stale, deleted, manually-added entry keep showing as missing
 * (gotcha 40's stance) rather than vanish or crash the whole merge.
 *
 * This is the other half of gotcha 91 (`src/main/index.ts`'s launch-time
 * realpath is the first half): `stoke`/the Open dialog resolve a folder
 * BEFORE it is ever stored, but a project added before that fix shipped, or
 * one added straight into `~/.claude.json` by hand, still has the typed
 * (symlinked) path sitting in `settings.projectMeta` or `projectRoots` — this
 * is what collapses that onto the same entry Claude's own history already
 * resolved through symlinks.
 */
async function realpathOf(path: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      realpath(path),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), EXISTS_DEADLINE_MS)
        timer.unref?.()
      })
    ])
  } catch {
    return path
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** `realpathOf` for a whole set of paths at once, deduplicated, in parallel. */
async function realpathMap(paths: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(paths)]
  const answers = await Promise.all(unique.map(realpathOf))
  return new Map(unique.map((p, i) => [p, answers[i]]))
}

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
    /*
     * The head of the file, never the whole of it.
     *
     * This read `readFile(file, 'utf8')` and then `raw.split('\n', 200)`, which
     * reads as bounded and is not: split's limit caps the array it returns, not
     * the read that produced it. So the entire transcript was pulled into memory
     * to look at its first record — 14.76 MB on every single `listProjects()`
     * on the machine this was found on, and unbounded in principle, since one
     * unclaimed directory holding a 300 MB transcript would have read all of it.
     * `sessionFile.ts` already had the bounded reader `readLines` uses; this
     * simply was not using it. The cwd is on the first record that carries one,
     * so 256 KB is many hundreds of records more than enough.
     */
    const head = await readRange(file, 0, CHUNK)
    for (const line of head.split('\n')) {
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
  const rules = pathRulesFor(process.platform)
  const [config, dirs, rootDirs] = await Promise.all([
    readClaudeConfig(),
    scanHistoryDirs(),
    scanRoots(settings.projectRoots)
  ])

  const byDir = new Map<string, DirInfo>()
  for (const d of dirs) byDir.set(d.dir.toLowerCase(), d)

  /*
   * Every path that will need its realpath — scan-root children, projectMeta
   * keys, and now `pinnedProjects`/`hiddenProjects` too — resolved in ONE
   * pass rather than three sequential deadline-bound stages (each up to
   * `EXISTS_DEADLINE_MS`). `pinnedProjects`/`hiddenProjects` used to be
   * compared against the UNRESOLVED string even after gotcha 91 rewrote
   * scan-root and `projectMeta` keys to the realpath: a pin or a hide saved
   * under the typed, symlinked path (from before that fix, or from
   * `~/.claude.json` written by hand) then matched nothing, so a pinned
   * folder lost its pin and a hidden one came back — both confirmed live.
   */
  const metaEntries = Object.entries(settings.projectMeta ?? {})
  const realOf = await realpathMap([
    ...rootDirs,
    ...metaEntries.map(([raw]) => normalizePath(raw, rules)),
    ...settings.pinnedProjects.map((p) => normalizePath(p, rules)),
    ...settings.hiddenProjects.map((p) => normalizePath(p, rules))
  ])
  const resolvedOf = (raw: string): string => {
    const n = normalizePath(raw, rules)
    return realOf.get(n) ?? n
  }
  const pinnedRealPaths = settings.pinnedProjects.map(resolvedOf)
  const hiddenRealPaths = settings.hiddenProjects.map(resolvedOf)
  const pinnedKeys = new Set(pinnedRealPaths.map(dedupeKey))
  const hiddenKeys = new Set(hiddenRealPaths.map(dedupeKey))

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
      // Filled in below, once every folder has been asked at once and off the
      // main thread. `put` is synchronous and must stay that way — it is called
      // from three places and merges duplicates — so it cannot do the asking.
      exists: false,
      pinned: pinnedKeys.has(key),
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

  /*
   * 3. Folders discovered under user-configured scan roots, even with no
   *    history. Resolved through symlinks first (gotcha 91): a root itself
   *    can be a symlink (macOS's /tmp is the everyday case), and without this
   *    every child folder under it merges as a path Claude's own,
   *    already-resolved history entry for the same folder never matches.
   */
  for (const path of rootDirs) {
    const real = realOf.get(path) ?? path
    const encoded = encodePath(normalize(real)).toLowerCase()
    put(real, byDir.get(encoded) ?? null)
  }

  /*
   * 4. Folders the user added themselves, and everything they have said about
   *    any folder. Appended BEFORE the hidden filter, so an added folder can
   *    still be hidden — the two settings mean different things and neither
   *    overrides the other.
   *
   * Every stored key is resolved through symlinks before it is used as a
   * dedupe key or handed to `applyProjectMeta`, and not only for a folder
   * added after this fix shipped: `stoke DIR`/the Open dialog now store the
   * realpath (`src/main/index.ts`), but a project added before that, or one
   * written into `~/.claude.json` by hand, still has the SYMLINKED path
   * sitting in `projectMeta` — this is what collapses that stale entry onto
   * the one Claude's own history already resolved, rather than leaving both
   * rows in the sidebar forever. Two stored keys that resolve to the same
   * folder merge into one record, the later one's fields winning except that
   * `addedManually` survives if EITHER said so — losing that would silently
   * un-list a folder nobody removed.
   */
  const meta: Record<string, ProjectMeta> = {}
  for (const [raw, value] of metaEntries) {
    const key = resolvedOf(raw)
    const prior = meta[key]
    meta[key] = {
      ...prior,
      ...value,
      addedManually: prior?.addedManually === true || value?.addedManually === true || undefined
    }
  }

  /*
   * Every folder whose existence anyone is about to ask about, asked once, in
   * parallel, off the main thread.
   *
   * `applyProjectMeta` is pure and takes a synchronous predicate — that is what
   * makes it testable without a filesystem, and `verify:folders` depends on it —
   * so the answers are gathered here and handed to it as a lookup rather than
   * the contract being made async. The manually-added paths are already
   * resolved and normalised the same way `applyProjectMeta` normalises them
   * before it asks, or the lookup would miss and every added folder would be
   * reported as gone.
   */
  const addedPaths = Object.entries(meta)
    .filter(([, value]) => value?.addedManually === true)
    .map(([path]) => path)
  const found = await existsMap([...[...merged.values()].map((p) => p.path), ...addedPaths])
  for (const project of merged.values()) project.exists = found.get(project.path) ?? false

  const withMeta = applyProjectMeta([...merged.values()], meta, {
    rules,
    pinned: pinnedRealPaths,
    exists: (path) => found.get(path) ?? false
  })

  return withMeta
    .filter((p) => !hiddenKeys.has(dedupeKey(p.path)))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.lastModified ?? 0) - (a.lastModified ?? 0)
    })
}

/**
 * One-time rewrite of every stored key `listProjects` merges on the fly
 * (gotcha 91): a `projectMeta` key, a `projectRoots`, `pinnedProjects` or
 * `hiddenProjects` entry saved under a symlinked path before that fix, or
 * written into `~/.claude.json` by hand.
 *
 * The merge in `listProjects` makes the sidebar show one row, but the row is
 * a VIEW: the settings keys underneath are untouched, so `projectMetaPatch`'s
 * exact-key `split` (`projectMeta.ts`) can only ever touch the realpath side
 * — the renderer's `Project.path` — and the stale, symlinked key it never
 * matches sits there forever. Confirmed live: Remove and clearing the emoji
 * on a folder added before this fix both left the stale key in place, and
 * "No icon" wrote a SECOND key rather than replacing the first.
 *
 * Run once after boot (same deadline `pathExists` uses, so one asleep volume
 * cannot hang it) rather than threading an extra "also drop this alias" path
 * through every one of `projectMetaPatch`/`manualProjectPatch`/the
 * pin/hide handlers — those stay exact-key operations, correct once this has
 * run, and the merge in `listProjects` is left as-is because a project added
 * mid-session, before the NEXT boot's migration, still needs it.
 *
 * Returns only the settings keys that actually changed, or null when every
 * key was already canonical — so a caller can skip the write (and the
 * `settingsChanged` broadcast) on every ordinary boot.
 */
export async function migrateSymlinkedProjectKeys(
  settings: Settings
): Promise<Partial<Settings> | null> {
  const rules = pathRulesFor(process.platform)
  const metaEntries = Object.entries(settings.projectMeta ?? {})
  const real = await realpathMap([
    ...settings.projectRoots.map((p) => normalizePath(p, rules)),
    ...metaEntries.map(([raw]) => normalizePath(raw, rules)),
    ...settings.pinnedProjects.map((p) => normalizePath(p, rules)),
    ...settings.hiddenProjects.map((p) => normalizePath(p, rules))
  ])
  const resolvedOf = (raw: string): string => {
    const n = normalizePath(raw, rules)
    return real.get(n) ?? n
  }

  const patch: Partial<Settings> = {}

  let metaChanged = false
  const meta: Record<string, ProjectMeta> = {}
  for (const [raw, value] of metaEntries) {
    const key = resolvedOf(raw)
    if (key !== raw) metaChanged = true
    const prior = meta[key]
    meta[key] = prior
      ? {
          ...prior,
          ...value,
          addedManually: prior.addedManually === true || value.addedManually === true || undefined
        }
      : value
  }
  if (metaChanged) patch.projectMeta = meta

  /** Resolve, then drop duplicates that collapse onto the same real folder. */
  const dedupeList = (paths: string[]): { list: string[]; changed: boolean } => {
    const seen = new Set<string>()
    const out: string[] = []
    let changed = false
    for (const raw of paths) {
      const key = resolvedOf(raw)
      if (key !== raw) changed = true
      const dedupe = dedupeKey(key)
      if (seen.has(dedupe)) {
        changed = true
        continue
      }
      seen.add(dedupe)
      out.push(key)
    }
    return { list: out, changed }
  }

  const roots = dedupeList(settings.projectRoots)
  if (roots.changed) patch.projectRoots = roots.list
  const pinned = dedupeList(settings.pinnedProjects)
  if (pinned.changed) patch.pinnedProjects = pinned.list
  const hidden = dedupeList(settings.hiddenProjects)
  if (hidden.changed) patch.hiddenProjects = hidden.list

  return Object.keys(patch).length ? patch : null
}

/** Directory holding a project's transcripts, or null when it has no history. */
export async function historyDirFor(projectPath: string): Promise<string | null> {
  const encoded = encodePath(normalize(projectPath))
  const direct = join(projectsRoot(), encoded)
  if (await pathExists(direct)) return direct
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
export async function findSessionFile(
  sessionId: string,
  root: string = projectsRoot()
): Promise<string | null> {
  let dirs: string[]
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return null
  }
  /*
   * All of them at once, not one after another.
   *
   * This was a `for` loop around `existsSync`, so a miss cost one synchronous
   * stat per history directory — 44 of them here — on the main thread, and the
   * context watcher calls this every time it picks up a session it has not
   * placed yet. Asked in parallel it is one round trip, and asked
   * asynchronously it does not stop the app while the answer comes back.
   */
  const candidates = dirs.map((d) => join(root, d, `${sessionId}.jsonl`))
  const present = await Promise.all(candidates.map(pathExists))
  const hit = present.indexOf(true)
  return hit === -1 ? null : candidates[hit]
}
