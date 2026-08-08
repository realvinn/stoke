/*
 * One-off repair for the machine this app was built on, kept in the repo so it
 * is reviewable and re-runnable rather than a paragraph of shell in a chat log.
 *
 *   node scripts/repair-work-root.mts            # report only
 *   node scripts/repair-work-root.mts --apply    # make the changes
 *   node scripts/repair-work-root.mts --verify   # assert the outcome
 *
 * What is wrong, and it is two things:
 *
 *  1. `projectRoots` names /Users/thevinh/dev/work/Work, an empty folder. A
 *     scan root enumerates its CHILDREN, so an empty root contributes no
 *     projects at all — the Work profile covered nothing and the worklog had
 *     almost nothing to watch. The right root is the parent,
 *     /Users/thevinh/dev/work, whose children are the actual repositories.
 *  2. `worklogBoards.targets` is whatever the store happens to hold. Design §6
 *     asks for Notion only on this machine, and "the default already says
 *     notion" is not the same statement: the default only applies to a file
 *     that has never been written, and this one has.
 *
 * Four refusals, because both halves of getting this wrong are silent:
 *  - Stoke must not be running. It holds settings in memory and rewrites the
 *    whole file on the next setSettings, so an edit made underneath it is
 *    discarded without a word — and if it cannot even be determined whether
 *    Stoke is running, that refuses too, rather than assume not.
 *  - the folder being deleted must exist and be a directory, and if it does,
 *    it must be empty, checked by reading it, dotfiles included. `rmdir`
 *    then refuses a second time on its own account.
 *  - the replacement root must exist and be a directory.
 *
 * NOT chained into `npm run check`: --verify reads the live settings file, so
 * it is true of one machine and one configuration.
 *
 * WHICH settings file, because there are two and they are not interchangeable.
 * The installed app is packaged, and electron-builder writes productName
 * "Stoke" into CFBundleName, so its userData is
 *   ~/Library/Application Support/Stoke
 * An unpackaged run (npm run dev, npm run start, npx electron .) has no
 * CFBundleName to read, falls back to package.json's `name` — "stoke", since
 * this project sets no productName there — and src/main/index.ts:839-841
 * then appends " (dev)", giving
 *   ~/Library/Application Support/stoke (dev)
 * This script repairs the FIRST of those: the packaged profile is the one
 * holding projectRoots: ["/Users/thevinh/dev/work/Work"]. The literal below is
 * spelled lower-case because that is how the directory is actually named on
 * disk here — it was created by a pre-0.3.x unpackaged run, before the (dev)
 * isolation landed, and this volume is case-insensitive APFS, so the packaged
 * app has been writing into it ever since. On a case-sensitive volume the
 * literal would have to be "Stoke".
 */
import { execFileSync } from 'node:child_process'
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_WORKLOG_BOARDS } from '../src/shared/worklog.ts'
import { listProjects } from '../src/main/projects.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { shouldWatch } from '../src/main/worklog/gate.ts'
import { pathKey, pathRulesFor } from '../src/shared/paths.ts'

const APPLY = process.argv.includes('--apply')
const VERIFY = process.argv.includes('--verify')
const SETTINGS = join(homedir(), 'Library', 'Application Support', 'stoke', 'settings.json')
const WRONG = '/Users/thevinh/dev/work/Work'
const RIGHT = '/Users/thevinh/dev/work'

function die(msg: string): never {
  console.error(`\nREFUSED: ${msg}\n`)
  process.exit(1)
}

/** Every non-dot, non-node_modules child directory of the work root. */
function workChildren(): string[] {
  return readdirSync(RIGHT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => join(RIGHT, e.name))
}

if (VERIFY) {
  let failures = 0
  function ok(name: string, condition: boolean, detail = ''): void {
    if (!condition) failures++
    console.log(
      `  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`
    )
  }

  if (!existsSync(SETTINGS)) die(`${SETTINGS} does not exist. Run Stoke once first.`)
  if (!existsSync(RIGHT)) die(`${RIGHT} does not exist. This verifier is for one machine.`)

  const raw = JSON.parse(readFileSync(SETTINGS, 'utf8'))
  const real = hydrateSettings(raw)

  /* CONTAINS, not equals: adding a second scan root later is a normal thing to
     do and must not be reported as a regression. What must never come back is
     the empty child. */
  ok(
    'the work folder is a scan root',
    real.projectRoots.includes(RIGHT),
    JSON.stringify(real.projectRoots)
  )
  ok(
    'and its empty child is not',
    !real.projectRoots.includes(WRONG),
    JSON.stringify(real.projectRoots)
  )
  /* Asserted on the RAW parsed file, not `real` (hydrateSettings' output): the
     live file had no worklogBoards key at all before any repair, and hydration
     fills that gap with the Notion-only default — so an assertion against
     `real` would pass before the repair ran and after it identically. Only the
     raw JSON can tell "pinned to notion" apart from "key absent". */
  ok(
    'the worklog writes to Notion only',
    JSON.stringify(raw.worklogBoards?.targets) === JSON.stringify(['notion']),
    JSON.stringify(raw.worklogBoards?.targets)
  )

  const projects = await listProjects(real)
  const children = workChildren()
  const unwatched = children.filter(
    (c) => !shouldWatch(c, projects, real.worklogGroups, real.projectRoots)
  )
  console.log(`  (${children.length - unwatched.length} of ${children.length} watched)`)
  ok('every folder under the work root is watched', unwatched.length === 0, unwatched.join(', '))

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exit(failures ? 1 : 0)
}

/* 1. Nothing may be holding the settings file.
 *
 * The predicate is "a process whose --user-data-dir is dirname(SETTINGS)", not
 * a name match on "Stoke": a packaged Stoke.app's own argv carries no such
 * flag, but every one of its Chromium helper processes (renderer, GPU,
 * network) does — verified against the real running instance — so the flag is
 * still there to find. It also catches an unpackaged run handed that flag
 * explicitly (gotcha #12), which a "Stoke" name match misses outright since
 * the binary is named Electron. The -f pattern below only has to find
 * candidates carrying *some* --user-data-dir; the exact-path comparison is
 * plain string matching in JS, not part of the pattern, so a home directory
 * containing regex metacharacters can't misfire the match.
 *
 * pgrep exits 1 for "ran fine, nothing matched" — a real, expected outcome,
 * not a failure. Anything else (exit >= 2, or pgrep missing from PATH
 * entirely) means the check itself did not run, and that must refuse rather
 * than be read as "not running": a `catch { ps = '' }` here previously let a
 * broken pgrep sail straight past this refusal.
 */
const settingsDir = dirname(SETTINGS)
let ps = ''
try {
  ps = execFileSync('pgrep', ['-fl', '--', '--user-data-dir='], { encoding: 'utf8' })
} catch (e) {
  const status = (e as { status?: number | null }).status
  if (status === 1) {
    ps = '' // pgrep ran fine and matched nothing
  } else {
    die(
      `could not check whether Stoke is running (pgrep ${status == null ? 'failed to start' : `exited ${status}`}). ` +
        'Refusing rather than risk a silently discarded edit. Nothing has been changed.'
    )
  }
}
const running = ps
  .split('\n')
  .filter((l) => l.includes(`--user-data-dir=${settingsDir}`))
  .filter((l) => !l.includes('repair-work-root'))
if (running.length) {
  die(`Stoke is running and would overwrite this edit:\n  ${running.join('\n  ')}\nQuit it first.`)
}

/* 2. The replacement must be real. */
if (!existsSync(RIGHT) || !statSync(RIGHT).isDirectory()) {
  die(`${RIGHT} is not a folder. Nothing has been changed.`)
}

/* 3. The folder being removed must be empty — dotfiles count. */
let removable = false
if (!existsSync(WRONG)) {
  console.log(`  ${WRONG} is already gone.`)
} else {
  // A symlink resolves through here (statSync follows it); a plain file does
  // not, and readdirSync would throw ENOTDIR on it with a raw stack before any
  // write. Refuse in this script's own register instead.
  if (!statSync(WRONG).isDirectory()) {
    die(`${WRONG} exists but is not a directory. Nothing has been changed.`)
  }
  const entries = readdirSync(WRONG)
  if (entries.length) {
    die(
      `${WRONG} is not empty. It holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:\n  ` +
        `${entries.join('\n  ')}\n` +
        'Nothing has been changed. Move or delete them yourself, then run this again.'
    )
  }
  removable = true
  console.log(`  ${WRONG} is empty.`)
}

if (!existsSync(SETTINGS)) die(`${SETTINGS} does not exist.`)
const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))

/* pathKey(), not ===: a stored root differing only by a trailing separator or
   case (this volume is case-insensitive APFS, see the header) is the SAME
   folder on disk. Missed with a raw string compare, that folder still gets
   emptiness-checked and removed below by its literal path either way — so a
   mismatch here would leave projectRoots pointing at a directory this script
   had just deleted out from under it. */
const rules = pathRulesFor(process.platform)
const wrongKey = pathKey(WRONG, rules)
const roots: string[] = Array.isArray(settings.projectRoots) ? settings.projectRoots : []
const nextRoots = [...new Set(roots.map((r) => (pathKey(r, rules) === wrongKey ? RIGHT : r)))]

/* Design §6: Notion only on this machine. The ids are preserved rather than
   reset, because they are the user's own and a repair that quietly forgot a
   ClickUp list id would be a second bug. */
const prevBoards = settings.worklogBoards ?? {}
const nextBoards = {
  notionDataSource: prevBoards.notionDataSource ?? DEFAULT_WORKLOG_BOARDS.notionDataSource,
  clickupListId: prevBoards.clickupListId ?? DEFAULT_WORKLOG_BOARDS.clickupListId,
  targets: ['notion']
}

console.log(`  projectRoots:   ${JSON.stringify(roots)}`)
console.log(`              ->  ${JSON.stringify(nextRoots)}`)
console.log(`  worklogBoards:  ${JSON.stringify(prevBoards)}`)
console.log(`              ->  ${JSON.stringify(nextBoards)}`)

if (!APPLY) {
  console.log('\nReport only. Re-run with --apply to make these changes.')
  process.exit(0)
}

/* Back up beside the file, then temp + rename, matching store.ts's own write.
 *
 * COPYFILE_EXCL, not a plain overwrite: the header calls this script
 * re-runnable, and a second --apply used to overwrite run 1's backup with
 * run 1's OWN OUTPUT — measured, so the one file that could undo an edit was
 * destroyed by exactly the re-run the header invites (and Important 3, below,
 * is a real reason to invite one). A timestamped name per run was the other
 * option; this one was chosen because the backup's only job is to be the
 * untouched pre-repair snapshot — once that exists, keeping it beats
 * accumulating copies, and a re-run has no need to make a second one. If it's
 * already there, this leaves it alone rather than failing the whole apply.
 */
const backupPath = `${SETTINGS}.before-repair`
try {
  copyFileSync(SETTINGS, backupPath, fsConstants.COPYFILE_EXCL)
  console.log(`  backed up to ${backupPath}`)
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
    console.log(`  ${backupPath} already exists — leaving it alone, it is the original`)
  } else {
    throw e
  }
}
settings.projectRoots = nextRoots
settings.worklogBoards = nextBoards
const tmp = `${SETTINGS}.tmp`
writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
renameSync(tmp, SETTINGS)
console.log(`  wrote ${SETTINGS}`)

/* rmdir, not rm -rf: it refuses a non-empty directory on its own account, so
 * the emptiness check above has a second opinion that is not this script's.
 *
 * By this point the settings write above has already happened and cannot be
 * undone by failing here — so a thrown ENOTDIR (WRONG turned out to be a
 * symlink) or ENOTEMPTY (something landed in it between the emptiness check
 * and here) must not become an unhandled stack trace with no `Done.` and no
 * sentence about what state that leaves behind. Every other failure in this
 * script says "Nothing has been changed"; this is the one place that would be
 * a lie, so it says the opposite instead.
 */
if (removable) {
  try {
    rmdirSync(WRONG)
    console.log(`  removed ${WRONG}`)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    console.error(
      `\nPARTIAL: settings.json was repaired (backup at ${backupPath}), but ${WRONG} could ` +
        `not be removed (${err.code ?? err.message}).\nRemove it yourself, then re-run this ` +
        'script to confirm — or with --verify.\n'
    )
    process.exit(1)
  }
}

console.log('\nDone.')
