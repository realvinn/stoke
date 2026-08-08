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
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import type { ProfileConfig, Settings } from '@shared/types'
import type { CreateProfileInput, ProfilePlan } from '../shared/profiles.ts'
import { foldGroup, folderName, nextProfileId } from '../shared/profiles.ts'
import { normalizePath } from '../shared/paths.ts'

/**
 * The string form of a path, for the one comparison the filesystem cannot
 * answer.
 *
 * It normalises separators and drops a trailing one. It deliberately does
 * **not** case-fold. It used to, by `pathRulesFor(process.platform)`, and that
 * guess is what made `createProfile` disagree with its own plan: on a
 * case-sensitive APFS volume `planProfile` answered `reuse <box>/Work` while
 * this key folded a stale `<box>/work` in `projectRoots` onto it, decided the
 * root was already registered, and never added it. The profile was stored, its
 * folder was there, and it rendered empty — the original "pressed Create and
 * nothing appeared" bug, on the very volume the case-sensitivity work set out
 * to support.
 *
 * `sep` is node's own separator rather than a platform guess: which character
 * separates path segments is a fact about the running OS, unlike how a volume
 * folds case, which is a fact about the volume and is asked of it directly.
 */
function pathKey(p: string): string {
  return normalizePath(p, { sep: sep === '\\' ? '\\' : '/', caseInsensitive: false })
}

/**
 * `realpathSync.native`, or null for *any* failure.
 *
 * Deliberately a different contract from `resolveOnDisk` below, which lets
 * everything but `ENOENT` through. This one only ever answers the question
 * "are these two entries in `settings.projectRoots` the same folder", where an
 * unreadable stale root is a normal thing to find and must not become a throw
 * on the create path.
 */
function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

/**
 * Are these two scan roots the same folder on this machine?
 *
 * The filesystem answers first, the same way `existingChild` and `isNamed` ask
 * it; the string key is only the fallback for a path that resolves to nothing
 * at all — a Windows root in a config opened on a Mac, or a folder since
 * deleted. That fallback direction is the safe one: a spelling that names
 * nothing here is not the same folder as one that names something, whatever
 * the two strings look like, and being wrong that way adds a duplicate root
 * rather than silently dropping the real one.
 */
function sameRoot(a: string, b: string): boolean {
  if (pathKey(a) === pathKey(b)) return true
  const real = realOrNull(a)
  return real !== null && real === realOrNull(b)
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
 * `lstat` of `p`, or null if no spelling of it exists.
 *
 * Same "`ENOENT` is the only no-such-spelling answer" contract as
 * `resolveOnDisk`, and the same volume-driven matching: the kernel resolves
 * every component but the last, then looks the last one up by the volume's own
 * folding rules, so a wrong-cased or NFD-typed spelling is found exactly where
 * `realpath` would find it.
 *
 * `lstat` rather than `stat` on purpose. Whether the entry is *itself* a
 * symlink is the question `existingChild` has to answer before it can trust a
 * basename, and `stat` erases it.
 */
function lstatOnDisk(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Which entry of `dir` is `requested`, found by filesystem identity rather
 * than by name.
 *
 * The listing is the only place the true entry name lives once a symlink is
 * involved, and `dev` + `ino` is the only reliable way to say which entry the
 * requested spelling actually reached: string comparison is precisely the
 * folding question this module refuses to guess at.
 *
 * `lstat` on both sides, and `bigint` so a large inode compares exactly. A
 * symlink has an inode of its own; following either side would compare the
 * target's identity against the entries' own and match nothing — or, worse,
 * match the target's directory entry when the target happens to be a sibling.
 *
 * This is the rare path: `existingChild` only reaches it for an entry that is
 * a symlink. Every ordinary folder is answered without a listing at all.
 */
function entryByIdentity(dir: string, requested: string): string | null {
  let want: { dev: bigint; ino: bigint }
  try {
    want = lstatSync(requested, { bigint: true })
  } catch {
    return null
  }
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    try {
      const st = lstatSync(join(dir, entry), { bigint: true })
      if (st.dev === want.dev && st.ino === want.ino) return entry
    } catch {
      // Gone between the listing and the stat, so it is not the match.
    }
  }
  return null
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
 * That basename trick is only sound while the entry is *not itself a symlink*,
 * and getting that wrong adopted a real but unrelated folder. `dir/Link` ->
 * `dir/Elsewhere/Archive` resolves to a basename of `Archive`; if `dir` also
 * holds a genuine, unrelated `Archive/`, `join(dir, 'Archive')` exists, is a
 * directory, and became the profile's scan root and group — the user named
 * `Link` and got somebody else's projects. Silently adopting the wrong folder
 * is, in this module's own words below, the worst way for it to be wrong. A
 * sibling of the *same* directory (`dir/Link` -> `dir/Archive`) breaks it
 * identically, so "did the path leave `dir`" is not the discriminator either.
 *
 * So `lstat` first, which costs nothing extra because it also says whether the
 * entry is a directory:
 *
 *  - not a symlink -> `basename(resolved)` *is* the entry name in `dir`, since
 *    only components before the last could have been redirected. Two syscalls,
 *    and this is every ordinary folder.
 *  - a symlink -> the true entry name is in the directory listing and nowhere
 *    else, so `entryByIdentity` goes and finds it. `isDirectory` then decides,
 *    following the link, so a symlink to a directory still counts as one.
 */
function existingChild(dir: string, name: string): string | null {
  const requested = join(dir, name)
  const link = lstatOnDisk(requested)
  if (link === null) return null

  if (!link.isSymbolicLink()) {
    if (!link.isDirectory()) return null
    const resolved = resolveOnDisk(requested)
    return resolved === null ? null : join(dir, basename(resolved))
  }

  const entry = entryByIdentity(dir, requested)
  if (entry === null) return null
  const real = join(dir, entry)
  return isDirectory(real) ? real : null
}

/**
 * A refusal sentence for a filesystem error that is not "no such spelling".
 *
 * `profiles:plan` (index.ts:1136) is a debounced keystroke handler, and before
 * `resolveOnDisk` narrowed its catch to `ENOENT` it could not throw at all.
 * Letting one out now crosses IPC as `Error invoking remote method
 * 'profiles:plan': Error: EACCES: permission denied, realpath '…'`, and the
 * renderer's catch (ProfilesSettings.tsx:214-216) skips `setPlan` — so the
 * preview goes on describing the *previous* name while the banner shows the
 * new failure. A refusal plan keeps the failure visible and replaces the stale
 * preview, because it is a plan.
 *
 * This is reachable with nothing broken: on macOS an unentitled build gets
 * `EPERM`/`EACCES` out of `realpath` under ~/Documents, ~/Desktop and iCloud
 * Drive, which are exactly the folders someone would pick. It is deliberately
 * *not* a widening back to "anything unreadable means create" — that answer
 * made a wrong folder either way.
 */
function unreadable(chosen: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') {
    return `Stoke is not allowed to read ${chosen}. Give it access to that folder, or pick another one.`
  }
  return `${chosen} could not be read${code ? ` (${code})` : ''}.`
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
  try {
    // `existingChild` is asked only once the first branch has lost: it costs a
    // real `lstat` and `realpath`, and the reuse-chosen branch never uses the
    // answer.
    const existing = isNamed(chosen, name) ? chosen : existingChild(chosen, name)
    if (existing) {
      action = 'reuse'
      root = existing
    } else {
      action = 'create'
      root = child
    }
  } catch (err) {
    return failed(chosen, name, unreadable(chosen, err))
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

  /*
   * `create` is a promise that a folder gets made, and `describePlan` states it
   * in those words — "It starts empty; anything you put in it joins this
   * profile." When the root is already a directory nothing is created, that
   * sentence is false, and ProfilesSettings.tsx:467-476 prints it directly
   * above the list of projects already inside. So the two agree by
   * construction rather than by coincidence: for a plan with no error, `create`
   * with `willCreate: false` is not producible. (A refused plan keeps
   * `action: 'create'` with an empty root and no `willCreate`, and never
   * reaches `describePlan`'s switch — the error is the whole sentence.)
   */
  const willCreate = !isDirectory(root)
  if (!willCreate) action = 'reuse'

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

  /*
   * By here `plan.root` is on disk — either it already was, or the `mkdir`
   * above just made it — so `sameRoot` always has a real path to compare
   * against and never has to fall back to string equality for this side.
   */
  const roots = settings.projectRoots ?? []
  const projectRoots = roots.some((r) => sameRoot(r, plan.root)) ? roots : [...roots, plan.root]

  return { plan, patch: { profiles: [...stored, record], projectRoots }, record }
}
