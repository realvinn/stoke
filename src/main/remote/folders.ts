/**
 * The phone's folder routes, minus HTTP: which places it may reach, what is
 * inside one, and adding (or creating) a folder as a project.
 *
 * Every decision about WHERE is `remoteFolderVerdict`/`remoteFolderBases`
 * (shared/remotePhone.ts, verify:remote); this file only asks the disk, under
 * the same deadline every other folder check uses (gotcha 40). No `electron`
 * import, so `verify:folders` drives `addRemoteProject` against real symlinks.
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathKey, pathRulesFor } from '../../shared/paths.ts'
import {
  isPlainFolderPath,
  newFolderNameProblem,
  parentFolder,
  remoteFolderBases,
  remoteFolderVerdict,
  type FolderBase,
  type FolderBaseKind
} from '../../shared/remotePhone.ts'
import type { FolderProblem } from '../../shared/stokeArgs.ts'
import { LAUNCH_FOLDER_DEADLINE_MS, launchFolderProblem, realpathFolder } from '../folderCheck.ts'

/** The most subfolders one `/api/folders` answer lists. */
export const MAX_LISTED_FOLDERS = 200

export interface FolderEntry {
  name: string
  path: string
  /** Set on the places list only: why this place is reachable. */
  kind?: FolderBaseKind
}

/** `GET /api/folders`'s body. `path: null` is the places list. */
export interface FolderListing {
  path: string | null
  /** The place `path` is under — where the phone's breadcrumb starts. */
  base: string | null
  /** The folder above `path` while that is still inside `base`, else null. */
  up: string | null
  folders: FolderEntry[]
  truncated: boolean
}

export type RouteResult<T> = { ok: true; body: T } | { ok: false; status: number; error: string }

/** What a place list is computed from, read per call (gotcha 111). */
export interface BaseSources {
  roots: readonly string[]
  defaultCwd: string
  projects: readonly string[]
  platform: string
}

/**
 * The reachable places, from REAL paths: every source is resolved through
 * symlinks in parallel under the deadline first, since a symlinked root can
 * point anywhere and only real paths nest honestly.
 */
export async function resolveFolderBases(src: BaseSources): Promise<FolderBase[]> {
  const all = [...src.roots, src.defaultCwd, ...src.projects]
  const real = await Promise.all(all.map((p) => (p ? realpathFolder(p) : Promise.resolve(''))))
  const roots = real.slice(0, src.roots.length)
  const defaultCwd = real[src.roots.length]
  const projects = real.slice(src.roots.length + 1)
  return remoteFolderBases({ roots, defaultCwd, projects }, pathRulesFor(src.platform))
}

const STATUS_FOR: Record<FolderProblem, { status: number; error: string }> = {
  missing: { status: 404, error: 'That folder no longer exists.' },
  'not-a-folder': { status: 400, error: 'That is a file, not a folder.' },
  denied: { status: 403, error: 'Stoke is not allowed to open that folder.' },
  unreachable: { status: 503, error: 'That folder did not answer in time. Is its disk connected?' }
}

/** Refused as outside: one status and one sentence whether or not it exists, so a probe learns nothing. */
const OUTSIDE = { ok: false as const, status: 403, error: 'Stoke only opens folders under your projects, project roots or default folder.' }
const MALFORMED = { ok: false as const, status: 400, error: 'That is not a folder path.' }

/**
 * Judge a requested folder: resolve it, then ask the verdict. Returns the
 * real path and the place it is under, or the refusal.
 */
async function judge(
  requested: unknown,
  bases: readonly FolderBase[],
  platform: string
): Promise<{ ok: true; real: string; base: FolderBase } | { ok: false; status: number; error: string }> {
  const rules = pathRulesFor(platform)
  // Shape first, so a traversal never even reaches `realpath`.
  if (!isPlainFolderPath(requested, rules)) return MALFORMED
  const real = await realpathFolder(requested.trim())
  const verdict = remoteFolderVerdict({ requested, real, bases }, rules)
  if (!verdict.ok) return verdict.reason === 'malformed' ? MALFORMED : OUTSIDE
  return { ok: true, real, base: verdict.base }
}

/**
 * A folder's immediate subfolders — never deeper, never a file — dot-folders
 * skipped, sorted as a person reads them, at most `cap`. One deadline for the
 * whole read, symlinked folders included (each is stat'ed to see if it is a
 * folder; where it leads is judged only when someone opens it). Null when the
 * disk did not answer in time or refused.
 */
export async function listSubfolders(
  dir: string,
  cap = MAX_LISTED_FOLDERS
): Promise<{ folders: FolderEntry[]; truncated: boolean } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async (): Promise<{ folders: FolderEntry[]; truncated: boolean }> => {
    const entries = await readdir(dir, { withFileTypes: true })
    const visible = entries.filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isSymbolicLink()))
    const checked = await Promise.all(
      visible.map(async (d) => {
        if (d.isDirectory()) return d.name
        try {
          return (await stat(join(dir, d.name))).isDirectory() ? d.name : null
        } catch {
          return null
        }
      })
    )
    const names = checked
      .filter((n): n is string => n !== null)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
    return {
      folders: names.slice(0, cap).map((name) => ({ name, path: join(dir, name) })),
      truncated: names.length > cap
    }
  }
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), LAUNCH_FOLDER_DEADLINE_MS)
        timer.unref?.()
      })
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * `GET /api/folders`: with no path, the places a phone may start from; with
 * one, its subfolders — only for a folder inside a place (403 otherwise, the
 * same answer whether or not it exists).
 */
export async function browseRemoteFolder(
  requested: string | null,
  bases: readonly FolderBase[],
  platform: string
): Promise<RouteResult<FolderListing>> {
  if (requested === null || requested === '') {
    return {
      ok: true,
      body: {
        path: null,
        base: null,
        up: null,
        folders: bases.map((b) => ({ name: basename(b.path) || b.path, path: b.path, kind: b.kind })),
        truncated: false
      }
    }
  }
  const judged = await judge(requested, bases, platform)
  if (!judged.ok) return judged
  const problem = await launchFolderProblem(judged.real)
  if (problem) return { ok: false, ...STATUS_FOR[problem] }
  const listed = await listSubfolders(judged.real)
  if (!listed) return { ok: false, ...STATUS_FOR.unreachable }
  const rules = pathRulesFor(platform)
  // Strictly inside its place, so the folder above is still inside it.
  const atBase = pathKey(judged.real, rules) === pathKey(judged.base.path, rules)
  return {
    ok: true,
    body: {
      path: judged.real,
      base: judged.base.path,
      up: atBase ? null : parentFolder(judged.real, rules) || null,
      folders: listed.folders,
      truncated: listed.truncated
    }
  }
}

export interface AddProjectDeps {
  bases: () => Promise<FolderBase[]>
  platform: string
  /**
   * Remember a folder as a project (`manualProjectPatch`) and tell the desktop
   * (gotcha 53). Given the REAL path (gotcha 91); returns the path as stored.
   */
  remember: (realPath: string) => string
}

/**
 * `POST /api/projects`: `{path}` adds a folder that exists; `{parent, name}`
 * creates one child of an allowed folder first. Either way the folder must be
 * inside a place (`remoteFolderVerdict`), is resolved through symlinks before
 * it is remembered (gotcha 91), and is a real folder (`launchFolderProblem`).
 * Creating is idempotent — a double tap's second `mkdir` finds it there, and
 * that is success (gotcha 20) — but a FILE of that name is not.
 */
export async function addRemoteProject(
  body: unknown,
  deps: AddProjectDeps
): Promise<RouteResult<{ path: string; name: string; created: boolean }>> {
  const b = (body && typeof body === 'object' ? body : {}) as { path?: unknown; parent?: unknown; name?: unknown }
  const bases = await deps.bases()
  let target: string
  const creating = b.parent !== undefined || b.name !== undefined
  let created = false
  if (creating) {
    const nameProblem = newFolderNameProblem(b.name)
    if (nameProblem) return { ok: false, status: 400, error: nameProblem }
    const parent = await judge(b.parent, bases, deps.platform)
    if (!parent.ok) return parent
    const problem = await launchFolderProblem(parent.real)
    if (problem) return { ok: false, ...STATUS_FOR[problem] }
    target = join(parent.real, (b.name as string).trim())
    try {
      await mkdir(target)
      created = true
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { ok: false, ...STATUS_FOR.denied }
      if (code !== 'EEXIST') return { ok: false, status: 500, error: 'Stoke could not create that folder.' }
      // EEXIST: judged below like any existing folder — a file of that name,
      // or a symlink out of the place, is refused there.
    }
  } else if (typeof b.path === 'string') {
    target = b.path
  } else {
    return { ok: false, status: 400, error: 'Send a folder path, or a parent and a name.' }
  }
  const judged = await judge(target, bases, deps.platform)
  if (!judged.ok) return judged
  const problem = await launchFolderProblem(judged.real)
  if (problem) {
    if (problem === 'not-a-folder' && creating) return { ok: false, status: 409, error: 'A file already has that name.' }
    return { ok: false, ...STATUS_FOR[problem] }
  }
  const stored = deps.remember(judged.real)
  return { ok: true, body: { path: stored, name: basename(stored) || stored, created } }
}
