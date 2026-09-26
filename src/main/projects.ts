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
  mapLimit,
  parseSession,
  readRange,
  safeParse,
  type ParsedSession
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
/*
 * How many of these probes may be inside the filesystem at once, per volume.
 * Keystrokes need the same threads.
 *
 * `fs` calls run on libuv's thread pool, and so does node-pty's write to the
 * pty (`CustomWriteStream` -> `fs.write`): every keystroke sent to a session
 * queues behind whatever holds the pool. The deadline above stops a sleeping
 * disk from delaying the LIST, but not the thread — a timed-out `access` keeps
 * its thread until the disk answers. With every folder probed at once on each
 * window focus, and six projects on an external volume, a disk spinning up
 * could hold all four threads; measured with the pool held, a keystroke's echo
 * arrived 1502 ms late, released the instant the pool was, while the event
 * loop looked perfectly healthy.
 *
 * So a slot is freed only when the call itself settles, not when its caller
 * gives up, and a probe whose deadline passes while it is still queued never
 * reaches the disk at all. Per volume, because one shared limit would let two
 * probes stuck on a sleeping external disk make every local folder time out in
 * the queue behind them and show as missing.
 */
const PROBE_SLOTS_PER_VOLUME = 2

interface VolumeSlots {
  inFlight: number
  queue: Array<() => void>
}
const volumeSlots = new Map<string, VolumeSlots>()

/**
 * The volume a path lives on, as far as sharing a sleeping disk goes: a
 * mount point under `/Volumes`, `/mnt` or `/media/<user>`, a drive letter or a
 * UNC share on Windows, and one key for everything else on the system disk.
 */
export function probeVolume(path: string): string {
  const win = /^([a-zA-Z]:)[\\/]/.exec(path) ?? /^(\\\\[^\\]+\\[^\\]+)/.exec(path)
  if (win) return win[1].toUpperCase()
  const mount = /^(\/Volumes\/[^/]+|\/mnt\/[^/]+|\/media\/[^/]+\/[^/]+)/.exec(path)
  return mount ? mount[1] : '/'
}

/**
 * Run `op` for `path` in one of its volume's slots, raced against `deadlineMs`.
 * The slot is held until `op` itself settles; a probe still queued when its
 * deadline passes is dropped without touching the disk.
 */
export async function probe<T>(path: string, op: () => Promise<T>, deadlineMs = EXISTS_DEADLINE_MS): Promise<T> {
  const key = probeVolume(path)
  const slots = volumeSlots.get(key) ?? { inFlight: 0, queue: [] }
  volumeSlots.set(key, slots)
  const drain = (): void => {
    while (slots.inFlight < PROBE_SLOTS_PER_VOLUME && slots.queue.length > 0) slots.queue.shift()?.()
    if (slots.inFlight === 0 && slots.queue.length === 0) volumeSlots.delete(key)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let run: (() => void) | undefined
  const inSlot = new Promise<T>((resolve, reject) => {
    run = (): void => {
      slots.inFlight++
      op()
        .then(resolve, reject)
        .finally(() => {
          slots.inFlight--
          drain()
        })
    }
    if (slots.inFlight < PROBE_SLOTS_PER_VOLUME) run()
    else slots.queue.push(run)
  })
  try {
    return await Promise.race([
      inSlot,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Still queued: it never reaches the disk, and does not wait there
          // for a volume that may never answer.
          const queued = run ? slots.queue.indexOf(run) : -1
          if (queued >= 0) slots.queue.splice(queued, 1)
          if (slots.inFlight === 0 && slots.queue.length === 0) volumeSlots.delete(key)
          reject(new Error('timed out'))
        }, deadlineMs)
        // Never hold the process open for this; it is a deadline, not work.
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    // A rejected race leaves `inSlot` unobserved; it has nowhere to report to.
    inSlot.catch(() => {})
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await probe(path, () => access(path))
    return true
  } catch {
    return false
  }
}

/** Resolve a whole set of paths at once, deduplicated; `PROBE_SLOTS_PER_VOLUME` per disk reach it. */
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
  try {
    return await probe(path, () => realpath(path))
  } catch {
    return path
  }
}

/** `realpathOf` for a whole set of paths at once, deduplicated, through the same slots. */
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
export async function historyDirFor(
  projectPath: string,
  root: string = projectsRoot()
): Promise<string | null> {
  const encoded = encodePath(normalize(projectPath))
  const direct = join(root, encoded)
  if (await pathExists(direct)) return direct
  // Windows history dirs may differ in case from the encoded path.
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === encoded.toLowerCase())
    return hit ? join(root, hit.name) : null
  } catch {
    return null
  }
}

/**
 * How many transcripts `listSessions` stats and parses at once. Parsing is CPU
 * on the one main thread, so more in flight buys nothing but open handles and
 * memory; `sessionIndex.ts` settled on the same number for the same reason.
 */
const LIST_CONCURRENCY = 8
/**
 * Transcripts `listSessions` remembers a parse for. Each entry is a few hundred
 * bytes, so this bounds a pathological history, not an ordinary one: 76
 * transcripts across every project on the machine this was written on.
 */
const LIST_CACHE_MAX = 2000

interface ListCached {
  /** The history directory the file was listed from, for pruning. */
  dir: string
  mtimeMs: number
  size: number
  /**
   * The parse, as a promise set before anything is awaited, so two overlapping
   * lists (the focus re-fetch landing during a project switch) share one parse
   * of a file rather than both running it (gotcha 20's shape).
   */
  parsed: Promise<ParsedSession | null>
}

/** Transcript path -> its parse, and the mtime and size it was parsed at. */
export type SessionListCache = Map<string, ListCached>

export function createSessionListCache(): SessionListCache {
  return new Map()
}

/** The process's own. A suite passes its own so runs cannot see each other. */
const sharedListCache = createSessionListCache()

/** Counters a suite reads to prove only a changed transcript is parsed again. */
export interface SessionListStats {
  parses: number
  cacheHits: number
}

export interface SessionListOptions {
  /** The directory holding the per-project history folders. `~/.claude/projects` by default. */
  root?: string
  cache?: SessionListCache
  stats?: SessionListStats
}

/**
 * Every session of one project, newest first, with what the expanded sidebar
 * list shows: title, first prompt, message count, context reading.
 *
 * Cached per transcript on (path, mtime, size), bounded to `LIST_CONCURRENCY`
 * at once, and a miss is `parseSession`'s streamed pass (gotcha 103). This ran
 * `parseSession` over every transcript of the project under an unbounded
 * `Promise.all` on every call, and the renderer calls it on every window focus
 * while the browsed project has a live session: 24 transcripts, 119 MB, ~300
 * ms and main-process blocks of 40-80 ms on each focus, with the terminal
 * frozen behind them. Now a focus parses only the transcript that moved.
 */
export async function listSessions(
  projectPath: string,
  opts: SessionListOptions = {}
): Promise<SessionMeta[]> {
  const cache = opts.cache ?? sharedListCache
  const dir = await historyDirFor(projectPath, opts.root)
  if (!dir) return []

  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }

  const metas = await mapLimit(files, LIST_CONCURRENCY, async (f): Promise<SessionMeta | null> => {
    const full = join(dir, f)
    try {
      const st = await stat(full)
      // A directory that happens to end in `.jsonl` is not a transcript.
      if (!st.isFile()) return null
      let entry = cache.get(full)
      if (entry && entry.mtimeMs === st.mtimeMs && entry.size === st.size) {
        if (opts.stats) opts.stats.cacheHits++
        // Re-inserted, so the bound below evicts the least recently listed.
        cache.delete(full)
        cache.set(full, entry)
      } else {
        if (opts.stats) opts.stats.parses++
        const fresh: ListCached = {
          dir,
          mtimeMs: st.mtimeMs,
          size: st.size,
          parsed: parseSession(full).catch(() => null)
        }
        cache.delete(full)
        cache.set(full, fresh)
        // A failed read is not remembered: the next list tries the file again.
        void fresh.parsed.then((r) => {
          if (r === null && cache.get(full) === fresh) cache.delete(full)
        })
        entry = fresh
      }
      const parsed = await entry.parsed
      if (!parsed) return null
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

  // Forget this directory's transcripts that are gone, then hold the bound.
  const present = new Set(files.map((f) => join(dir, f)))
  for (const [file, cached] of cache) {
    if (cached.dir === dir && !present.has(file)) cache.delete(file)
  }
  for (const file of cache.keys()) {
    if (cache.size <= LIST_CACHE_MAX) break
    cache.delete(file)
  }

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
