/**
 * Creating a profile: the folder half.
 *
 * A profile is a colour and a grouping, and the grouping is a real folder on
 * disk. `Project.group` is `basename(dirname(projectPath))` (projects.ts:163),
 * so a profile is only ever "the projects inside folder X" — which means making
 * one comes down to deciding which folder X is, and then scanning it.
 *
 * The rule is the user's, verbatim:
 *
 *   "it will ask me to create a name and location like if I do G:/Code name Task
 *    it creates task or if I do G:/Code/Task name Task it just uses that file so
 *    theres not weird double nesting, but if I create a new profile and select a
 *    folder with exsisting sub folders with projects we should auto import all
 *    of them"
 *
 * Nothing here imports `store.ts`, and that is deliberate: `createProfile`
 * returns a settings *patch* for the IPC handler to apply. Keeping electron out
 * of this module is what lets `node --experimental-strip-types` drive the folder
 * rule against real directories with no app running, which is the only way this
 * kind of bug gets caught — it fails by choosing the wrong folder, never by
 * throwing.
 */
import { realpathSync, statSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ProfileConfig, Settings } from '@shared/types'
import type { CreateProfileInput, ProfilePlan } from '../shared/profiles.ts'
import { foldGroup, folderName, nextProfileId } from '../shared/profiles.ts'
import { pathKey as sharedPathKey, pathRulesFor } from '../shared/paths.ts'

/*
 * This machine's own comparison rules — used only for `pathKey` below, which
 * dedupes `settings.projectRoots` (a list, compared as strings). It used to
 * also decide whether two folder names are "the same" on disk, and that is
 * wrong: `process.platform === 'win32'` was wrong on macOS (APFS is
 * case-insensitive by default), and `pathRulesFor(process.platform)` is
 * itself only a platform *guess* — a Mac can be running a case-sensitive
 * APFS volume, and even the case-insensitive default folds less than the
 * filesystem actually does (see `existingChild` and `isNamed` below, which
 * ask the filesystem directly instead).
 */
const RULES = pathRulesFor(process.platform)

/** Native separators, and case-folded where the filesystem is. */
function pathKey(p: string): string {
  return sharedPathKey(p, RULES)
}

/**
 * The sub-folders of `dir` that will show up as projects.
 *
 * This mirrors `scanRoots` in projects.ts:123-141 exactly — a directory, not
 * dot-prefixed, not `node_modules` — rather than inventing a stricter test such
 * as "has a .git". It has to: whatever this counts as importable is precisely
 * what the sidebar will list once the folder becomes a scan root, and a preview
 * that promises a different number than the app then shows is worse than no
 * preview at all.
 */
async function projectChildren(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    // Unreadable or gone. An empty list means "create the child", which is the
    // safe answer: it makes a new folder rather than adopting an unknown one.
    return []
  }
}

/**
 * Drop a trailing separator, because the chosen folder is stored verbatim as a
 * scan root and `G:\Code\Task\` and `G:\Code\Task` are the same folder written
 * two ways — the second would be added a second time by the Add-a-folder handler,
 * which compares roots as plain strings.
 *
 * A drive root and the posix root keep their separator: `G:` on its own means
 * "the current directory on G:", which is a different place entirely.
 */
function trimTrailingSep(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  if (!trimmed) return p.slice(0, 1)
  if (/^[a-zA-Z]:$/.test(trimmed)) return `${trimmed}${p.slice(trimmed.length, trimmed.length + 1)}`
  return trimmed
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The real path `p` resolves to right now, or null if no spelling of it
 * exists.
 *
 * `realpathSync.native` is the filesystem's own answer, not a platform
 * guess: measured against a real case-sensitive APFS volume it throws
 * `ENOENT` for a wrong-cased spelling that a case-insensitive volume
 * resolves without complaint, and it folds by the volume's own Unicode
 * normalisation — an NFD-typed `Café` resolves against an NFC `Café` on
 * disk, and `STRASSE` resolves against `Straße`, neither of which
 * `String.toLowerCase()` ever matched.
 *
 * `ENOENT` is the only "no such spelling" answer. Anything else — `EACCES`,
 * `ELOOP`, a bad file descriptor — is a real failure and is left to
 * propagate rather than being read as "create".
 *
 * It resolves symlinks, so the path it returns can point somewhere else
 * entirely. Neither caller below persists it as-is; see each for how it
 * keeps the result from relocating anything.
 */
function resolveOnDisk(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Does `chosen` already carry the name `name` — the same real directory a
 * sibling spelled `name` next to it would resolve to?
 *
 * A filesystem identity check, not a string comparison: it asks whether
 * `join(dirname(chosen), name)` and `chosen` resolve to the same place,
 * which agrees with `existingChild` about what this volume considers the
 * same spelling. Nothing here is persisted — only the boolean matters — so
 * `resolveOnDisk` resolving through a symlink is harmless.
 */
function isNamed(chosen: string, name: string): boolean {
  if (!name) return false
  const candidate = resolveOnDisk(join(dirname(chosen), name))
  if (candidate === null) return false
  return candidate === resolveOnDisk(chosen)
}

/**
 * The child of `dir` named `name`, as it is really spelled on disk, or null.
 *
 * `statSync` answers yes for a casing that is not the one on disk when the
 * filesystem is case-insensitive, and that wrong spelling was then persisted as
 * the profile's scan root — a path that works until something compares it as a
 * string. `resolveOnDisk` is the fix, but its result cannot be returned
 * directly: it resolves symlinks, so `dir` (or the child itself) being a
 * symlink would hand back a path under the *target*, and persisting that as
 * a scan root silently relocates the profile. Keeping only the basename and
 * rejoining it onto the caller's own `dir` keeps the profile where the user
 * pointed it, while still reporting the child's true on-disk spelling.
 *
 * `isDirectory` still does the final say-so — a symlink to a directory keeps
 * counting as one — and it also catches the one case this basename trick
 * cannot fix: a child that is itself a symlink to somewhere with a
 * *different* name (`dir/Link` -> `/elsewhere/Target`) resolves to a
 * basename, `Target`, that is not an entry of `dir` at all, so the
 * reconstructed path does not exist and this returns null rather than a
 * path that looks plausible and is not real.
 */
function existingChild(dir: string, name: string): string | null {
  const resolved = resolveOnDisk(join(dir, name))
  if (resolved === null) return null
  const real = join(dir, basename(resolved))
  return isDirectory(real) ? real : null
}

function failed(chosen: string, name: string, error: string): ProfilePlan {
  return {
    action: 'create',
    chosen,
    root: '',
    group: name.trim(),
    imports: [],
    willCreate: false,
    error
  }
}

/**
 * Work out what creating this profile would do, without touching anything.
 *
 * The order of the branches is the whole rule:
 *
 *  1. the folder is already called that            -> use it
 *  2. the child already exists                     -> use the child
 *     (same anti-nesting intent as 1, from the other direction: picking
 *      `G:/Code` with the name `Task` when `G:/Code/Task` is already there must
 *      not make `G:/Code/Task/Task`)
 *  3. the folder holds projects                    -> adopt it, import them all
 *  4. otherwise                                    -> make the child
 */
export async function planProfile(rawFolder: string, rawName: string): Promise<ProfilePlan> {
  const chosen = trimTrailingSep((rawFolder ?? '').trim())
  const name = (rawName ?? '').trim()

  if (!name) return failed(chosen, name, 'Give the profile a name.')
  if (/[\\/:*?"<>|]/.test(name)) {
    return failed(chosen, name, 'A profile name cannot contain \\ / : * ? " < > or |.')
  }
  if (name === '.' || name === '..') return failed(chosen, name, 'That is not a folder name.')
  if (!chosen) return failed(chosen, name, 'Choose a folder to keep this profile in.')
  if (!isDirectory(chosen)) return failed(chosen, name, `${chosen} is not a folder that exists.`)

  const child = join(chosen, name)

  /*
   * The name decides the folder; nothing else does.
   *
   * An earlier version adopted the chosen folder whenever it already held
   * projects, which quietly broke the case this feature was specified around:
   * picking G:/Code and naming the profile "Task" made the profile G:/Code
   * itself, covering every project on the machine, rather than creating
   * G:/Code/Task. It looked like it had worked - a profile appeared, with a
   * plausible import count - which is the worst way for it to be wrong.
   *
   * So: reuse the chosen folder only when it is already the one being named,
   * reuse an existing child of that name, and otherwise create the child.
   * Importing existing projects is a consequence of the root that falls out of
   * that, never a reason to pick a different root.
   */
  let action: ProfilePlan['action']
  let root: string
  const existing = existingChild(chosen, name)
  if (isNamed(chosen, name)) {
    action = 'reuse'
    root = chosen
  } else if (existing) {
    action = 'reuse'
    root = existing
  } else {
    action = 'create'
    root = child
  }

  const group = folderName(root)
  /*
   * A drive root has no folder name of its own, and `Project.group` is
   * `basename(dirname(path))` — so a profile rooted at `G:\` would match the
   * empty group and quietly cover nothing. Refuse it rather than create a chip
   * that filters everything away.
   */
  if (!group || /^[a-zA-Z]:$/.test(group)) {
    return failed(chosen, name, 'Pick a folder inside the drive rather than the drive itself.')
  }

  const willCreate = !isDirectory(root)
  return {
    action,
    chosen,
    root,
    group,
    imports: willCreate ? [] : await projectChildren(root),
    willCreate,
    error: null
  }
}

export interface CreateProfileResult {
  plan: ProfilePlan
  /** Apply with `setSettings`. Only the two keys that change are present. */
  patch: Partial<Settings>
  record: ProfileConfig
}

/**
 * Carry out a plan: make the folder if it is missing, add it as a scan root so
 * its children are discovered, and append the stored record.
 *
 * The scan root is the profile's folder itself, not its parent. Adding the
 * parent would pull in every sibling as a project of a different group and the
 * profile would then match none of them.
 */
export async function createProfile(
  settings: Settings,
  input: CreateProfileInput
): Promise<CreateProfileResult> {
  const plan = await planProfile(input.folder, input.name)
  if (plan.error) throw new Error(plan.error)

  const stored = settings.profiles ?? []
  const clash = stored.find((p) => p.groups.some((g) => foldGroup(g) === foldGroup(plan.group)))
  if (clash) {
    throw new Error(
      `${clash.label || clash.id} already covers ${plan.group}. Rename or recolour it instead of adding a second one.`
    )
  }

  if (plan.willCreate) await mkdir(plan.root, { recursive: true })

  const record: ProfileConfig = {
    id: nextProfileId(plan.group, stored.map((p) => p.id)),
    groups: [plan.group],
    label: input.name.trim(),
    accent: input.accent,
    accentHover: input.accentHover,
    accentSoft: input.accentSoft,
    accentContrast: input.accentContrast,
    createdByUser: true
  }

  const roots = settings.projectRoots ?? []
  const known = new Set(roots.map(pathKey))
  const projectRoots = known.has(pathKey(plan.root)) ? roots : [...roots, plan.root]

  return { plan, patch: { profiles: [...stored, record], projectRoots }, record }
}
