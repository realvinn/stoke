/*
 * Everything in the sidebar that comes from a folder rather than from Claude's
 * own files: the per-project metadata record, the folder a user added by hand,
 * and the working directory a session with no project lands in.
 *
 * All three failed the same way — silently, by listing nothing — so each case
 * here asserts a value rather than the absence of a throw.
 *
 * Run under every platform's own path rules explicitly, rather than under
 * `process.platform`: this suite is part of `npm run check`, which must assert
 * the same things on every machine that runs it, not just the one CI happens
 * to be on. `pathRulesFor('darwin')`, `pathRulesFor('win32')` and
 * `pathRulesFor('linux')` are each exercised in full, including the
 * case-insensitive block, which only darwin and win32 trigger.
 *
 *   node scripts/verify-folders.mts
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextSnapshot, Project, ProjectMeta, SessionMeta, Settings } from '../src/shared/types.ts'
import { pathRulesFor } from '../src/shared/paths.ts'
import {
  applyProjectMeta,
  manualProjectPatch,
  projectMetaPatch
} from '../src/main/projectMeta.ts'
import {
  createSessionListCache,
  encodePath,
  listProjects,
  listSessions,
  migrateSymlinkedProjectKeys
} from '../src/main/projects.ts'
import { defaultCwdCandidates, resolveDefaultCwd } from '../src/main/workspaceRoots.ts'
import { ContextWatcher } from '../src/main/context.ts'
import {
  advanceCursor,
  contextLimitFor,
  contextUsed,
  createFold,
  finishFold,
  foldFrom,
  foldLines,
  mapLimit,
  parseSession,
  type ParsedSession,
  type TranscriptCursor
} from '../src/main/sessionFile.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/**
 * Every assertion in this suite, run once per platform's own `PathRules`. Takes
 * the platform as an explicit string rather than reading `process.platform`, so
 * every branch — including the win32/darwin-only case-insensitive block — runs
 * on every machine `npm run check` runs on, not just whichever OS happens to be
 * driving it.
 */
function runFor(platform: 'darwin' | 'win32' | 'linux'): void {
  const RULES = pathRulesFor(platform)
  const isWin = platform === 'win32'

  console.log(`\n[${platform}] sep=${JSON.stringify(RULES.sep)} caseInsensitive=${RULES.caseInsensitive}`)

  /** Fixture paths in this platform's own shape. */
  const base = isWin ? 'G:\\Code' : '/Users/vinn/Code'
  const p = (...parts: string[]): string => [base, ...parts].join(RULES.sep)

  /** Only the keys these functions read carry real values. */
  function settings(patch: Partial<Settings>): Settings {
    return {
      projectMeta: {},
      pinnedProjects: [],
      hiddenProjects: [],
      projectRoots: [],
      ...patch
    } as Settings
  }

  function project(path: string): Project {
    return {
      path,
      name: path.split(RULES.sep).pop() ?? path,
      group: '',
      encodedDir: null,
      sessionCount: 0,
      lastModified: null,
      lastCost: null,
      lastPrompt: null,
      exists: true,
      pinned: false,
      emoji: null,
      label: null,
      addedManually: false
    }
  }

  const tag = (name: string): string => `[${platform}] ${name}`

  console.log('\nadding a folder by hand')
  check(
    tag('the folder is recorded, which is the whole of spec 2.5'),
    manualProjectPatch(settings({}), p('newthing'), RULES).projectMeta,
    { [p('newthing')]: { addedManually: true } }
  )
  check(
    tag('a trailing separator does not make a second record'),
    Object.keys(
      manualProjectPatch(
        settings({ projectMeta: { [p('newthing')]: { addedManually: true } } }),
        p('newthing') + RULES.sep,
        RULES
      ).projectMeta as Record<string, ProjectMeta>
    ),
    [p('newthing')]
  )
  check(
    tag('an emoji already on the folder survives being added again'),
    manualProjectPatch(
      settings({ projectMeta: { [p('newthing')]: { emoji: '🔥' } } }),
      p('newthing'),
      RULES
    ).projectMeta,
    { [p('newthing')]: { emoji: '🔥', addedManually: true } }
  )
  check(
    tag('adding a folder undoes having hidden it'),
    manualProjectPatch(
      settings({ hiddenProjects: [p('newthing'), p('other')] }),
      p('newthing'),
      RULES
    ).hiddenProjects,
    [p('other')]
  )
  check(
    tag('and leaves every other record alone'),
    manualProjectPatch(
      settings({ projectMeta: { [p('kept')]: { emoji: '🌱' } } }),
      p('newthing'),
      RULES
    ).projectMeta,
    { [p('kept')]: { emoji: '🌱' }, [p('newthing')]: { addedManually: true } }
  )
  check(tag('an empty path writes nothing at all'), manualProjectPatch(settings({}), '  ', RULES), {})

  console.log('\ncase folding when adding a folder by hand')
  // Paths are compared with pathKey, never with normalizePath alone: on darwin
  // and win32 a different-case path is the SAME folder and must fold onto the
  // existing record; on linux it is a different folder and must not. Checking
  // only one direction would also pass an implementation that folds case on
  // every platform — the inverse bug src/shared/paths.ts:30-34 already shipped
  // once.
  check(
    tag(
      RULES.caseInsensitive
        ? 'a differently-cased add reuses the existing record on this OS'
        : 'a differently-cased add creates a separate record on this OS'
    ),
    manualProjectPatch(
      settings({ projectMeta: { [p('CaseFold')]: { emoji: '🔥' } } }),
      p('casefold'),
      RULES
    ).projectMeta,
    RULES.caseInsensitive
      ? { [p('casefold')]: { emoji: '🔥', addedManually: true } }
      : { [p('CaseFold')]: { emoji: '🔥' }, [p('casefold')]: { addedManually: true } }
  )
  check(
    tag(
      RULES.caseInsensitive
        ? 'adding a folder undoes having hidden it even under a different case, on this OS'
        : 'a differently-cased add does not un-hide the original casing on this OS'
    ),
    manualProjectPatch(
      settings({ hiddenProjects: [p('CaseFold'), p('other')] }),
      p('casefold'),
      RULES
    ).hiddenProjects,
    RULES.caseInsensitive ? [p('other')] : [p('CaseFold'), p('other')]
  )

  console.log('\nsetting one folder’s metadata')
  check(
    tag('a record replaces what was there, rather than merging into it'),
    projectMetaPatch(
      settings({ projectMeta: { [p('a')]: { emoji: '🔥', label: 'Old' } } }),
      p('a'),
      { emoji: '🌱' },
      RULES
    ).projectMeta,
    { [p('a')]: { emoji: '🌱' } }
  )
  check(
    tag('null deletes the record, which is how an added folder leaves the sidebar'),
    projectMetaPatch(
      settings({ projectMeta: { [p('a')]: { addedManually: true }, [p('b')]: { emoji: '🔥' } } }),
      p('a'),
      null,
      RULES
    ).projectMeta,
    { [p('b')]: { emoji: '🔥' } }
  )
  check(
    tag('a record that says nothing is a deletion, not an empty object'),
    projectMetaPatch(
      settings({ projectMeta: { [p('a')]: { emoji: '🔥' } } }),
      p('a'),
      { emoji: '   ' },
      RULES
    ).projectMeta,
    {}
  )
  check(
    tag('addedManually needs a literal true here too'),
    projectMetaPatch(settings({}), p('a'), { addedManually: false, emoji: '🔥' }, RULES).projectMeta,
    { [p('a')]: { emoji: '🔥' } }
  )
  check(
    // `false` is falsy, same as unset, so it cannot tell `=== true` apart from
    // plain truthiness. A truthy-but-not-`true` value can: only the literal
    // check drops it.
    tag('addedManually also needs a literal true, not just anything truthy'),
    projectMetaPatch(
      settings({}),
      p('a'),
      { addedManually: 1 as unknown as boolean, emoji: '🔥' },
      RULES
    ).projectMeta,
    { [p('a')]: { emoji: '🔥' } }
  )
  check(
    tag('hiddenProjects is not touched by a metadata write'),
    Object.keys(projectMetaPatch(settings({ hiddenProjects: [p('a')] }), p('a'), null, RULES)),
    ['projectMeta']
  )
  check(
    tag(
      RULES.caseInsensitive
        ? 'setting metadata under a different case replaces the existing record on this OS'
        : 'setting metadata under a different case leaves the existing record alone on this OS'
    ),
    projectMetaPatch(
      settings({ projectMeta: { [p('CaseFold')]: { emoji: '🔥', label: 'Old' } } }),
      p('casefold'),
      { emoji: '🌱' },
      RULES
    ).projectMeta,
    RULES.caseInsensitive
      ? { [p('casefold')]: { emoji: '🌱' } }
      : { [p('CaseFold')]: { emoji: '🔥', label: 'Old' }, [p('casefold')]: { emoji: '🌱' } }
  )
  check(
    tag('an emoji is capped at MAX_EMOJI_CHARS, mirroring the label cap in verify-settings.mts'),
    projectMetaPatch(settings({}), p('a'), { emoji: '🔥'.repeat(30) }, RULES).projectMeta,
    { [p('a')]: { emoji: '🔥'.repeat(30).slice(0, 16) } }
  )

  console.log('\nstamping metadata onto the listed projects')
  const listed = [project(p('known'))]
  const opts = { rules: RULES, pinned: [] as string[], exists: () => true }
  check(
    tag('a manually added folder is appended, because nothing else can produce it'),
    applyProjectMeta(listed, { [p('added')]: { addedManually: true } }, opts).map((x) => x.path),
    [p('known'), p('added')]
  )
  check(
    tag('a folder that is already listed is not appended twice'),
    applyProjectMeta(listed, { [p('known')]: { addedManually: true } }, opts).map((x) => x.path),
    [p('known')]
  )
  check(
    tag('the emoji and label reach the project object'),
    applyProjectMeta(listed, { [p('known')]: { emoji: '🔥', label: 'Known' } }, opts).map((x) => [
      x.emoji,
      x.label
    ]),
    [['🔥', 'Known']]
  )
  check(
    tag('a project with no record keeps the empty shape rather than undefined'),
    applyProjectMeta(listed, {}, opts).map((x) => [x.emoji, x.label, x.addedManually]),
    [[null, null, false]]
  )
  check(
    tag('addedManually reaches an already-listed project too, not just an appended one'),
    // record.addedManually === true (:185) is a separate code path from the
    // append loop's own check (:156) — a project that was already in `listed`
    // (from Claude's own history) can still be flagged manually added if its
    // record says so, and a mutation hard-coding this to `false` must be
    // distinguishable from the real thing.
    applyProjectMeta(listed, { [p('known')]: { addedManually: true } }, opts).map(
      (x) => x.addedManually
    ),
    [true]
  )
  // Bound to a local list and asserted with .map() rather than `[0].group` etc:
  // a regression that drops the append entirely must produce a readable FAIL
  // here, not a TypeError that aborts the whole run before win32 and linux get
  // to execute.
  check(
    tag('a synthetic project takes its group from its parent folder'),
    applyProjectMeta([], { [p('work', 'thing')]: { addedManually: true } }, opts).map(
      (x) => x.group
    ),
    ['work']
  )
  check(
    tag('a synthetic project reports whether the folder is really there'),
    applyProjectMeta([], { [p('gone')]: { addedManually: true } }, {
      ...opts,
      exists: () => false
    }).map((x) => x.exists),
    [false]
  )
  check(
    tag('a synthetic project can be pinned like any other'),
    applyProjectMeta([], { [p('added')]: { addedManually: true } }, {
      ...opts,
      pinned: [p('added')]
    }).map((x) => x.pinned),
    [true]
  )
  check(
    // The sidebar row's actual visible text — the feature's own output.
    tag('a synthetic project gets a display name, not the empty string'),
    applyProjectMeta([], { [p('work', 'thing')]: { addedManually: true } }, opts).map(
      (x) => x.name
    ),
    ['thing']
  )
  check(
    // Tells the renderer the folder is removable; :185, not the append loop's
    // own flag at :174.
    tag('a synthetic project is itself flagged addedManually'),
    applyProjectMeta([], { [p('work', 'thing')]: { addedManually: true } }, opts).map(
      (x) => x.addedManually
    ),
    [true]
  )
  check(
    tag('the rest of a synthetic project’s shape is the empty one — there is no history yet'),
    applyProjectMeta([], { [p('added')]: { addedManually: true } }, opts).map((x) => [
      x.encodedDir,
      x.sessionCount,
      x.lastModified,
      x.lastCost,
      x.lastPrompt
    ]),
    [[null, 0, null, null, null]]
  )
  check(
    tag('a record that is only an emoji conjures no project'),
    applyProjectMeta([], { [p('nope')]: { emoji: '🔥' } }, opts),
    []
  )
  check(
    // Same truthy-not-true distinction as tidy() (:63), but this is the
    // append loop's own guard at :156, reached directly here since this suite
    // calls applyProjectMeta with a raw record rather than one that has been
    // through tidy() first.
    tag('a truthy-but-not-true addedManually does not conjure a project either'),
    applyProjectMeta([], { [p('sneaky')]: { addedManually: 1 as unknown as boolean } }, opts),
    []
  )
  // Unconditional, not only under `if (RULES.caseInsensitive)`: that guard left
  // linux with no negative counterpart of its own, so an implementation that
  // folds case on every platform (applyProjectMeta's own byKey map, :149 and
  // :179 — a separate code path from the write-path functions above) went
  // unnoticed there.
  check(
    tag(
      RULES.caseInsensitive
        ? 'a differently-cased key matches the project it belongs to on this OS'
        : 'a differently-cased key does not match the project it belongs to on this OS'
    ),
    applyProjectMeta([project(p('Known'))], { [p('known')]: { emoji: '🔥' } }, opts).map(
      (x) => x.emoji
    ),
    RULES.caseInsensitive ? ['🔥'] : [null]
  )
}

runFor('darwin')
runFor('win32')
runFor('linux')

console.log('\nlistProjects, against this machine’s real Claude config')
/*
 * A real run, not a fake: listProjects reads ~/.claude.json and
 * ~/.claude/projects itself, so the only honest way to test the added-folder
 * source is to add a folder that really exists and assert about that one
 * path — never over the whole returned list.
 *
 * readClaudeConfig() and scanHistoryDirs() (projects.ts) both swallow their
 * own errors and return empty, and scanRoots([]) returns empty too, so
 * listProjects cannot throw on a machine with no Claude config. A folder
 * appended from projectMeta is therefore present regardless of what the real
 * config holds, and its path comes from mkdtempSync, so it can never collide
 * with a real project. This block is deliberately not run per-platform: it
 * exercises the real `process.platform` this machine is actually on.
 */
function listSettings(patch: Partial<Settings>): Settings {
  return {
    projectMeta: {},
    pinnedProjects: [],
    hiddenProjects: [],
    projectRoots: [],
    ...patch
  } as Settings
}

/*
 * Resolved through symlinks right away, deliberately — `tmpdir()` on macOS
 * sits under `/var`, itself a symlink to `/private/var`, and `listProjects`
 * now resolves every manually-added or scan-root path through `realpath`
 * before it becomes a dedupe key (gotcha 91). Without this the fixture would
 * silently exercise the OLD, unresolved behaviour on exactly the platform
 * where the bug this suite is meant to catch is easiest to reproduce.
 */
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-folders-')))
const added = join(tmp, 'added-by-hand')
mkdirSync(added)
try {
  const withAdded = await listProjects(
    listSettings({
      projectMeta: { [added]: { addedManually: true, emoji: '🧪', label: 'Bench' } }
    })
  )
  const hit = withAdded.find((x) => x.path === added)
  check('a folder the user added by hand is listed', hit !== undefined, true)
  check('it carries its emoji', hit?.emoji, '🧪')
  check('it carries its label', hit?.label, 'Bench')
  check('it knows it is there only because someone added it', hit?.addedManually, true)
  check('it reports the folder really exists', hit?.exists, true)
  check('and it has no history attached', [hit?.sessionCount, hit?.encodedDir], [0, null])

  const alsoHidden = await listProjects(
    listSettings({
      projectMeta: { [added]: { addedManually: true } },
      hiddenProjects: [added]
    })
  )
  check(
    'a manually added folder can still be hidden',
    alsoHidden.some((x) => x.path === added),
    false
  )

  /*
   * The seam listProjects itself owns: it builds the ProjectMetaOptions object
   * (projects.ts:226-230) rather than applyProjectMeta's own defaults, and
   * applyProjectMeta's per-option coverage elsewhere in this file (:296-311)
   * never runs through listProjects, so it cannot see whether the real
   * pinnedProjects list or the real existsSync actually get wired through
   * here. Both fixtures below live inside `tmp`, so they are found by
   * `.find()` on the specific path this fixture created — never asserted over
   * the whole returned list.
   */
  const pinnedFolder = join(tmp, 'pinned-by-hand')
  mkdirSync(pinnedFolder)
  const withPinned = await listProjects(
    listSettings({
      projectMeta: { [pinnedFolder]: { addedManually: true } },
      pinnedProjects: [pinnedFolder]
    })
  )
  const pinnedHit = withPinned.find((x) => x.path === pinnedFolder)
  check(
    'a manually added folder that is also in pinnedProjects comes back pinned',
    pinnedHit?.pinned,
    true
  )

  const missingFolder = join(tmp, 'never-created')
  const withMissing = await listProjects(
    listSettings({
      projectMeta: { [missingFolder]: { addedManually: true } }
    })
  )
  const missingHit = withMissing.find((x) => x.path === missingFolder)
  check('a manually added folder is listed even if it was never created', missingHit !== undefined, true)
  check('and it reports honestly that the folder does not exist', missingHit?.exists, false)

  /*
   * Machine-independent replacement for a whole-list assertion: the tmpdir's
   * own child is discovered as a scan-root project (source 3 in
   * listProjects), with no projectMeta record at all, so the rule — every
   * project carries the three metadata fields, record or no record — is
   * checked on that one known path rather than over this machine's real
   * project list, where `[].every(...)` would pass on a machine with no
   * Claude projects while proving nothing.
   */
  const scanned = await listProjects(listSettings({ projectRoots: [tmp] }))
  const plainHit = scanned.find((x) => x.path === added)
  check('a scan-root folder with no metadata record is listed', plainHit !== undefined, true)
  check(
    'a project with no metadata record still carries the three fields',
    [plainHit?.emoji, plainHit?.label, plainHit?.addedManually],
    [null, null, false]
  )

  /*
   * gotcha 91: a folder reached through a symlink used to become a second,
   * session-less project — one row for the typed path, one for Claude's own
   * resolved cwd. Reproduced here without Claude at all: two `projectMeta`
   * keys that resolve to the SAME real folder (one straight, one through a
   * symlink) must collapse to one row, keeping whichever fields either side
   * set.
   */
  const real = join(tmp, 'symlink-target')
  mkdirSync(real)
  const link = join(tmp, 'symlink-alias')
  symlinkSync(real, link)
  const deduped = await listProjects(
    listSettings({
      projectMeta: {
        [real]: { addedManually: true, emoji: '🔗' },
        [link]: { addedManually: true, label: 'Via the symlink' }
      }
    })
  )
  const dupeRows = deduped.filter((x) => x.path === real || x.path === link)
  check('a folder reached two ways through a symlink is exactly one row', dupeRows.length, 1)
  check('the surviving row is keyed by the resolved path', dupeRows[0]?.path, real)
  check('it keeps the emoji either side set', dupeRows[0]?.emoji, '🔗')
  check('and the label the symlinked entry set', dupeRows[0]?.label, 'Via the symlink')
  check('and stays addedManually', dupeRows[0]?.addedManually, true)

  /*
   * gotcha 91 correction (2026-09-19): the collapse above is a VIEW —
   * `listProjects` merges on every read, but `settings.projectMeta` still
   * holds the stale `link` key untouched underneath it. `projectMetaPatch`
   * (the handler behind Remove and "No icon") only ever replaces the key
   * whose `pathKey` equals the path the renderer sent, which is the row's
   * `path`, i.e. `real` — so it can never reach `link`, and clicking Remove
   * left the stale key sitting there forever, re-merged on the very next
   * list. Confirmed live in the sandbox: Remove and clearing the emoji both
   * did nothing, and "No icon" wrote a SECOND key rather than replacing the
   * first. `migrateSymlinkedProjectKeys` is the one-time rewrite that fixes
   * this at the source instead of re-deriving a merge on every read; it also
   * carries `pinnedProjects`/`hiddenProjects` through the same realpath, since
   * both were still compared against the unresolved string.
   */
  const nativeRules = pathRulesFor(process.platform)
  const staleMeta = {
    projectMeta: {
      [real]: { addedManually: true, emoji: '🔗' },
      [link]: { addedManually: true, label: 'Via the symlink' }
    },
    pinnedProjects: [link],
    hiddenProjects: [link]
  }
  const migrated = await migrateSymlinkedProjectKeys(listSettings(staleMeta))
  check('migration finds something to rewrite', migrated !== null, true)
  check(
    'migration collapses the symlinked projectMeta key onto the real one',
    Object.keys(migrated?.projectMeta ?? {}),
    [real]
  )
  check('the merged record keeps the real side’s emoji', migrated?.projectMeta?.[real]?.emoji, '🔗')
  check(
    'and the label only the symlinked side set',
    migrated?.projectMeta?.[real]?.label,
    'Via the symlink'
  )
  check('and stays addedManually after the merge', migrated?.projectMeta?.[real]?.addedManually, true)
  check('a pin stored under the symlinked path moves to the real one', migrated?.pinnedProjects, [real])
  check('a hide stored under the symlinked path moves to the real one', migrated?.hiddenProjects, [real])

  /*
   * A `projectRoots` entry gets the same rewrite, checked on its own settings
   * object so it cannot leave `real` registered as a scan root (whose
   * CHILDREN would then be what the remove/re-list check below sees, rather
   * than `real` itself) by the time that check runs.
   */
  const rootMigrated = await migrateSymlinkedProjectKeys(
    listSettings({ projectRoots: [real, link] })
  )
  check('a duplicate scan root collapses to the real path, once', rootMigrated?.projectRoots, [real])

  /*
   * Once migrated, Remove (`projectMetaPatch(..., null)`) on the CANONICAL
   * path — the only path `listProjects` will ever echo back to the renderer
   * — must clear the record for good. Before `migrateSymlinkedProjectKeys`
   * ran, this same Remove left the untouched `link` key to re-merge
   * `addedManually`/the emoji straight back in on the next list, which is
   * the "Remove does nothing" defect.
   */
  // Only `projectMeta`, deliberately: `migrated` also carries the pin/hide
  // rewrite checked above, and folding `hiddenProjects: [real]` in here would
  // make the row vanish from the next list for the wrong reason.
  const migratedSettings = listSettings({ projectMeta: migrated?.projectMeta })
  const afterRemove = projectMetaPatch(migratedSettings, real, null, nativeRules)
  check('Remove after migration drops the record entirely', afterRemove.projectMeta, {})
  const listedAfterRemove = await listProjects(
    listSettings({ ...migratedSettings, ...afterRemove })
  )
  const removedRow = listedAfterRemove.find((x) => x.path === real)
  check(
    'and the row is gone, not merged back in from a surviving stale key',
    removedRow,
    undefined
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('\nwhere a session with no project lands')
/*
 * The list shipped with `~/Code`, `~/code`, `~/Developer` and `~/Projects`, and
 * this machine keeps its work in `~/dev` — so every no-project session started
 * in the home folder, which is the one place a session should never start
 * (spec 2.5).
 */
const mac = defaultCwdCandidates('darwin', '/Users/v')
check('the home folder is the last resort, never the first', mac[mac.length - 1], '/Users/v')
check(
  'the folders a Mac actually uses are all candidates',
  ['Developer', 'Code', 'code', 'dev', 'Projects', 'src', 'repos'].every((d) =>
    mac.includes(`/Users/v/${d}`)
  ),
  true
)
check('no candidate is offered twice', mac.length, new Set(mac).size)
/*
 * That check above cannot fail on darwin, and it is worth saying why rather
 * than deleting it: the seven folder names are fixed, distinct literals with no
 * separator in them, so `under(a) === under(b)` implies `a === b` for any home.
 * A duplicate is structurally impossible there, and dropping the dedup leaves
 * the whole suite green.
 *
 * Windows is where the dedup earns its place, because `G:\Code` is hardcoded
 * alongside the home-relative candidates. Point home at that same folder and
 * the two collide.
 */
const collide = defaultCwdCandidates('win32', 'G:\\Code')
check('a home that is already a candidate is still offered once', collide.length, new Set(collide).size)
check('and the hardcoded drive is the copy that survives', collide[0], 'G:\\Code')
check(
  'Windows keeps the drive this app was built around, first',
  defaultCwdCandidates('win32', 'C:\\Users\\v')[0],
  'G:\\Code'
)
check(
  'and a Windows list never offers a posix path',
  defaultCwdCandidates('win32', 'C:\\Users\\v').some((d) => d.includes('/')),
  false
)

const home = mkdtempSync(join(tmpdir(), 'stoke-home-'))
try {
  check('with nothing there at all, the home folder wins', resolveDefaultCwd(null, 'darwin', home), home)
  mkdirSync(join(home, 'dev'))
  check('a folder that exists beats the home folder', resolveDefaultCwd(null, 'darwin', home), join(home, 'dev'))
  mkdirSync(join(home, 'Developer'))
  check(
    'and the more preferred of two that exist wins',
    resolveDefaultCwd(null, 'darwin', home),
    join(home, 'Developer')
  )
  check(
    'an explicit setting beats every candidate',
    resolveDefaultCwd(join(home, 'dev'), 'darwin', home),
    join(home, 'dev')
  )
  check(
    'an explicit setting that has been deleted falls back rather than failing',
    resolveDefaultCwd(join(home, 'gone'), 'darwin', home),
    join(home, 'Developer')
  )
} finally {
  rmSync(home, { recursive: true, force: true })
}

/* ---------------------------------------------------------------------------
   Transcripts read in pieces, never in one blocking parse (gotcha 103).

   The context watcher folds only what was appended since its last tick
   (`advanceCursor`), `parseSession` streams a file a chunk at a time
   (`foldFrom`), and `listSessions` caches a parse per transcript. Each is only
   worth having if it answers exactly what one whole-file parse answers, so
   every case below is held to `foldWhole` — the fold over the whole text at
   once, which is what `parseSession` did before it streamed.

   Synthetic transcripts in this suite's own tmp dir, so CI runs all of it:
   `verify:context` repeats the cut-point check against this machine's real
   transcripts, and CI skips that suite.
   --------------------------------------------------------------------------- */
console.log('\ntranscripts read in pieces (gotcha 103)')

/** mulberry32: a fixed sequence, so a failing cut point reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A transcript that reaches every branch of the fold, with 2-, 3- and 4-byte
 * UTF-8 in every kind of record, so a cut point can land inside a character as
 * well as inside a line. Every user record carries 🔥, and nothing else does.
 */
function synthTranscript(n: number, seed: number): string {
  const rnd = rng(seed)
  const lines = [JSON.stringify({ type: 'permission-mode', permissionMode: 'default' })]
  for (let i = 0; i < n; i++) {
    const r = rnd()
    if (r < 0.34) {
      lines.push(
        JSON.stringify({
          type: 'user',
          cwd: `/work/café-${i % 3}`,
          gitBranch: `feat/日本-${i % 4}`,
          message: {
            content:
              i % 2
                ? `prompt ${i} 🔥 naïve 日本語`
                : [{ type: 'text', text: `turn ${i} 🔥 — ✓ ${'ß'.repeat(i % 7)}` }]
          }
        })
      )
    } else if (r < 0.68) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: {
            model: i % 5 ? 'claude-opus-5' : 'claude-fable-5',
            usage: {
              input_tokens: i,
              cache_read_input_tokens: i * 10,
              cache_creation_input_tokens: i * 3,
              output_tokens: i % 11
            },
            content: [{ type: 'text', text: `réponse ${i} ${'€'.repeat(i % 5)} 🎉` }]
          }
        })
      )
    } else if (r < 0.76) {
      lines.push(JSON.stringify({ type: 'ai-title', aiTitle: `Title ${i} ☕ 🧪` }))
    } else if (r < 0.82) {
      const mode = ['plan', 'acceptEdits', 'nonsense', 'bypassPermissions'][i % 4]
      lines.push(JSON.stringify({ type: 'permission-mode', permissionMode: mode }))
    } else if (r < 0.87) {
      lines.push('not json at all ✗')
    } else if (r < 0.9) {
      lines.push('')
    } else {
      lines.push(JSON.stringify({ type: 'system', content: 'x'.repeat((i * 131) % 3000) }))
    }
  }
  return lines.join('\n') + '\n'
}

/** The whole text folded at once: the answer every piecewise reader must match. */
function foldWhole(text: string): ParsedSession {
  const fold = createFold()
  foldLines(fold, text)
  return finishFold(fold)
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(pred: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(10)
  }
  return pred()
}

/*
 * Every write below that a poller must notice also moves the mtime to a value
 * of its own, so no assertion leans on the filesystem's timestamp resolution.
 */
let stamp = Math.floor(Date.now() / 1000) + 100
function touch(file: string): void {
  stamp += 5
  utimesSync(file, stamp, stamp)
}

const tx = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-transcripts-')))
try {
  const text = synthTranscript(400, 7)
  const bytes = Buffer.from(text, 'utf8')
  const whole = foldWhole(text)
  const file = join(tx, 'whole.jsonl')
  writeFileSync(file, bytes)

  check(
    'the synthetic transcript reaches every branch of the fold',
    [
      whole.messageCount > 100,
      whole.title !== null,
      whole.model !== null,
      whole.inputTokens > 0,
      whole.permissionMode !== null && whole.permissionMode !== ('nonsense' as string),
      whole.firstPrompt?.includes('🔥') ?? false
    ],
    [true, true, true, true, true, true]
  )
  check('parseSession, streamed, answers what one whole-text fold answers', await parseSession(file), whole)

  for (const chunk of [5, 13, 64, 4096]) {
    const fh = await open(file, 'r')
    const target = { fold: createFold(), offset: 0 }
    const rest = await foldFrom(fh, target, Infinity, { chunk })
    await fh.close()
    check(
      `a pass in ${chunk}-byte reads folds the same, and consumes every byte`,
      [finishFold(target.fold), target.offset, rest.length],
      [whole, bytes.length, 0]
    )
  }

  // Incremental equals one pass, wherever the first read stopped: random bytes
  // (mid-line, mid-character) and newlines alike.
  {
    const rnd = rng(42)
    const cuts = new Set<number>()
    while (cuts.size < 40) cuts.add(1 + Math.floor(rnd() * (bytes.length - 1)))
    for (let i = 0, n = 0; i < bytes.length && n < 10; i++) {
      if (bytes[i] === 0x0a && rnd() < 0.03) {
        cuts.add(i + 1)
        n++
      }
    }
    const grow = join(tx, 'grow.jsonl')
    const wrong: number[] = []
    let resets = 0
    let overRead = 0
    for (const cut of cuts) {
      writeFileSync(grow, bytes.subarray(0, cut))
      const first = await advanceCursor(null, grow)
      const firstOffset = first.cursor.offset
      appendFileSync(grow, bytes.subarray(cut))
      const second = await advanceCursor(first.cursor, grow)
      if (!same(finishFold(second.cursor.fold), whole)) wrong.push(cut)
      if (second.reset) resets++
      // The bytes after the first cursor, plus the one newline it checks.
      if (second.bytesRead !== bytes.length - firstOffset + (firstOffset > 0 ? 1 : 0)) overRead++
    }
    check(`incremental equals one pass at ${cuts.size} cut points`, wrong, [])
    check('and no append was mistaken for a rewrite', resets, 0)
    check('and each advance read only what was appended, plus the newline it checks', overRead, 0)
  }

  // Many appends of random sizes, the cursor advanced after each.
  {
    const steps = join(tx, 'steps.jsonl')
    writeFileSync(steps, '')
    let cursor: TranscriptCursor | null = null
    let written = 0
    let bad = 0
    let count = 0
    const rnd = rng(9)
    while (written < bytes.length) {
      const next = Math.min(bytes.length, written + 1 + Math.floor(rnd() * 9000))
      appendFileSync(steps, bytes.subarray(written, next))
      written = next
      cursor = (await advanceCursor(cursor, steps)).cursor
      const lastNewline = bytes.lastIndexOf(0x0a, written - 1)
      const expected = foldWhole(bytes.subarray(0, lastNewline + 1).toString('utf8'))
      if (!same(finishFold(cursor.fold), expected) || cursor.offset !== lastNewline + 1) bad++
      count++
    }
    check(`after each of ${count} appends, the fold is exactly the lines whose newline has arrived`, bad, 0)
  }

  // A cut inside a four-byte character, both ways a reader can meet one.
  {
    const at = bytes.indexOf(Buffer.from('🔥'))
    const cut = at + 2
    const fh = await open(file, 'r')
    const target = { fold: createFold(), offset: 0 }
    await foldFrom(fh, target, Infinity, { chunk: cut })
    await fh.close()
    const viaReads = finishFold(target.fold)
    check(
      'a read that ends inside a four-byte character still folds the line whole',
      [viaReads.firstPrompt, viaReads.firstPrompt?.includes('�') ?? true],
      [whole.firstPrompt, false]
    )

    const midchar = join(tx, 'midchar.jsonl')
    writeFileSync(midchar, bytes.subarray(0, cut))
    const early = await advanceCursor(null, midchar)
    check(
      'a file that ends inside a character folds nothing past its last newline',
      [early.cursor.fold.firstPrompt, early.cursor.offset],
      [null, bytes.lastIndexOf(0x0a, cut - 1) + 1]
    )
    appendFileSync(midchar, bytes.subarray(cut))
    const late = await advanceCursor(early.cursor, midchar)
    check(
      'and once the rest lands the prompt is whole, with no replacement character',
      [late.cursor.fold.firstPrompt, late.cursor.fold.firstPrompt?.includes('�') ?? true, late.reset],
      [whole.firstPrompt, false, false]
    )
  }

  // A last line is folded when its newline arrives, never before.
  {
    const base = synthTranscript(30, 3)
    const partial = join(tx, 'partial.jsonl')
    writeFileSync(partial, base)
    const start = await advanceCursor(null, partial)
    const count0 = start.cursor.fold.messageCount
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 123456, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }
      }
    })
    const half = Math.floor(line.length / 2)
    appendFileSync(partial, line.slice(0, half))
    const a = await advanceCursor(start.cursor, partial)
    const afterHalf = [a.cursor.fold.messageCount, a.cursor.fold.inputTokens === 123456, a.cursor.offset]
    appendFileSync(partial, line.slice(half))
    const b = await advanceCursor(a.cursor, partial)
    const afterWhole = [b.cursor.fold.messageCount, b.cursor.fold.inputTokens === 123456, b.cursor.offset]
    /*
     * parseSession is the other reader and keeps the rule it always had: the
     * text after the last newline is folded if it parses, as `split` folded it.
     * Only the watcher waits for the newline, because it will read those bytes
     * again next tick and a fold cannot be taken back.
     */
    check(
      'parseSession still folds a final record with no newline, as the whole-text split did',
      [(await parseSession(partial)).messageCount, await parseSession(partial)],
      [count0 + 1, foldWhole(base + line)]
    )
    appendFileSync(partial, '\n')
    const c = await advanceCursor(b.cursor, partial)
    check('half a record is not folded', afterHalf, [count0, false, Buffer.byteLength(base)])
    check('nor is a whole record whose newline has not arrived', afterWhole, [count0, false, Buffer.byteLength(base)])
    check(
      'its newline folds it, once, with no reset',
      [c.cursor.fold.messageCount, c.cursor.fold.inputTokens, c.reset],
      [count0 + 1, 123456, false]
    )
    check('and the result is the whole file’s parse', finishFold(c.cursor.fold), await parseSession(partial))
  }

  // Anything but an append starts the cursor over.
  {
    const rewrite = join(tx, 'rewrite.jsonl')
    const long = synthTranscript(200, 11)
    const short = synthTranscript(40, 12)
    writeFileSync(rewrite, long)
    const c0 = (await advanceCursor(null, rewrite)).cursor
    writeFileSync(rewrite, short) // truncated in place: same inode, smaller
    const shrunk = await advanceCursor(c0, rewrite)
    check(
      'a transcript truncated under the cursor starts over',
      [shrunk.reset, finishFold(shrunk.cursor.fold)],
      [true, foldWhole(short)]
    )

    // Replaced by a rename, with the old content as its prefix: the size and
    // the newline before the offset both still pass, so only the inode can say.
    const grown = short + synthTranscript(60, 13)
    const swap = join(tx, 'swap.tmp')
    writeFileSync(swap, grown)
    const inoBefore = statSync(rewrite).ino
    renameSync(swap, rewrite)
    const swapped = await advanceCursor(shrunk.cursor, rewrite)
    check(
      'a transcript replaced by a rename starts over, even when it only grew',
      [statSync(rewrite).ino !== inoBefore, swapped.reset, finishFold(swapped.cursor.fold)],
      [true, true, foldWhole(grown)]
    )

    // Rewritten in place, same inode and no smaller, but the byte before the
    // offset is no longer the newline that was there.
    const offset = swapped.cursor.offset
    let seed = 14
    let other = synthTranscript(400, seed)
    while (Buffer.byteLength(other) < offset || Buffer.from(other)[offset - 1] === 0x0a) {
      other = synthTranscript(400, ++seed)
    }
    const inoKept = statSync(rewrite).ino
    writeFileSync(rewrite, other)
    const inPlace = await advanceCursor(swapped.cursor, rewrite)
    check(
      'a transcript rewritten in place starts over when its newline moved',
      [statSync(rewrite).ino === inoKept, inPlace.reset, finishFold(inPlace.cursor.fold)],
      [true, true, foldWhole(other)]
    )
  }

  /*
   * The watcher itself, on a local file: the same readings as a whole parse,
   * through appends, a window stated late (gotcha 49) and a replaced file.
   */
  {
    const local = join(tx, 'local.jsonl')
    writeFileSync(local, synthTranscript(120, 21))
    touch(local)
    let window: number | null = null
    const snaps: ContextSnapshot[] = []
    const watcher = new ContextWatcher(
      (snap) => {
        if (snap.ready) snaps.push(snap)
      },
      () => window,
      { resolve: async () => local, pollMs: () => 20 }
    )
    const fields = (s: ContextSnapshot | undefined): unknown =>
      s && [s.contextTokens, s.contextLimit, s.inputTokens, s.cacheReadTokens, s.cacheCreationTokens,
        s.outputTokens, s.model, s.messageCount, s.title, s.permissionMode]
    const expect = async (w: number | null): Promise<unknown> => {
      const p = await parseSession(local)
      const used = contextUsed(p)
      return [used, contextLimitFor(p.model, used, w), p.inputTokens, p.cacheReadTokens,
        p.cacheCreationTokens, p.outputTokens, p.model, p.messageCount, p.title, p.permissionMode]
    }
    try {
      watcher.watch('local-session')
      await until(() => snaps.length >= 1)
      check('the watcher’s first reading is the whole parse', fields(snaps.at(-1)), await expect(null))

      appendFileSync(local, synthTranscript(50, 22))
      touch(local)
      const n1 = snaps.length
      await until(() => snaps.length > n1)
      check('after an append it is still exactly the whole parse', fields(snaps.at(-1)), await expect(null))

      // Nothing written, only the window stated: it must still republish.
      window = 1_000_000
      const n2 = snaps.length
      await until(() => snaps.length > n2)
      check(
        'a window stated after the transcript went quiet still reaches the meter',
        [snaps.at(-1)?.contextLimit, fields(snaps.at(-1))],
        [1_000_000, await expect(1_000_000)]
      )

      const replacement = join(tx, 'local.tmp')
      writeFileSync(replacement, synthTranscript(90, 23))
      renameSync(replacement, local)
      touch(local)
      const n3 = snaps.length
      await until(() => snaps.length > n3)
      check('a replaced transcript is read afresh, not appended to', fields(snaps.at(-1)), await expect(1_000_000))
    } finally {
      watcher.disposeAll()
    }
  }

  /*
   * `refresh()` while a tick is in flight. Two ticks advancing one cursor would
   * fold the same appended lines twice, and each would keep its own timer, so
   * the count would run ahead of the file for the rest of the watch.
   */
  {
    const busy = join(tx, 'busy.jsonl')
    writeFileSync(busy, synthTranscript(200, 41))
    touch(busy)
    const snaps: ContextSnapshot[] = []
    const watcher = new ContextWatcher(
      (snap) => {
        if (snap.ready) snaps.push(snap)
      },
      () => null,
      { resolve: async () => busy, pollMs: () => 3 }
    )
    try {
      watcher.watch('busy-session')
      watcher.refresh('busy-session') // lands while the first tick awaits its resolve
      for (let i = 0; i < 20; i++) {
        await sleep(4)
        appendFileSync(busy, synthTranscript(8, 50 + i))
        touch(busy)
        watcher.refresh('busy-session')
      }
      await sleep(150)
      const p = await parseSession(busy)
      check(
        'refreshes interleaved with appends still read exactly the file',
        [snaps.at(-1)?.messageCount, snaps.at(-1)?.inputTokens],
        [p.messageCount, p.inputTokens]
      )
    } finally {
      watcher.disposeAll()
    }

    /*
     * The same guard, counted: every refresh that lands mid-tick used to start
     * a tick of its own, and each of those scheduled its own timer. A slow
     * resolve holds the first tick open while three refreshes arrive; one
     * chain at 30 ms plus a 15 ms resolve cannot tick more than ~11 times in
     * 450 ms, and four chains tick ~40. A loaded machine only ticks fewer.
     */
    let resolves = 0
    const chains = new ContextWatcher(
      () => {},
      () => null,
      {
        resolve: async () => {
          resolves++
          await sleep(15)
          return busy
        },
        volatile: () => true,
        pollMs: () => 30
      }
    )
    try {
      chains.watch('chain-session')
      await sleep(5)
      chains.refresh('chain-session')
      chains.refresh('chain-session')
      chains.refresh('chain-session')
      await sleep(100)
      const before = resolves
      await sleep(450)
      const ticks = resolves - before
      check(`refreshes during a tick leave one polling chain (${ticks} ticks in 450 ms)`, ticks <= 14, true)
    } finally {
      chains.disposeAll()
    }
  }

  /*
   * The watcher on a volatile source: an SSH session's local copy is the remote
   * file's last 4 MB, rewritten in place. Every record here is the same length,
   * so sliding the window keeps the inode, the size and every newline where it
   * was — a rewrite no cursor check can see — and only starting over each time
   * reads the new records.
   */
  {
    const fixed = (i: number): string => {
      const rec = {
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 1000 + i, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }
        },
        pad: ''
      }
      const bare = JSON.stringify(rec).length
      rec.pad = 'p'.repeat(200 - bare)
      return JSON.stringify(rec)
    }
    const remote = Array.from({ length: 60 }, (_, i) => fixed(i))
    const windowA = remote.slice(0, 50).join('\n') + '\n'
    const windowB = remote.slice(10, 60).join('\n') + '\n'
    const copy = join(tx, 'remote-copy.jsonl')
    writeFileSync(copy, windowA)
    touch(copy)
    const inoA = statSync(copy).ino
    const snaps: ContextSnapshot[] = []
    const watcher = new ContextWatcher(
      (snap) => {
        if (snap.ready) snaps.push(snap)
      },
      () => null,
      { resolve: async () => copy, volatile: () => true, pollMs: () => 20 }
    )
    try {
      watcher.watch('remote-session')
      await until(() => snaps.length >= 1)
      const firstInput = snaps.at(-1)?.inputTokens
      writeFileSync(copy, windowB) // in place, as fetchRemoteTranscript writes it
      touch(copy)
      check(
        'premise: the slid window kept the inode, the size and every newline',
        [statSync(copy).ino === inoA, statSync(copy).size, windowA.indexOf('\n') === windowB.indexOf('\n')],
        [true, Buffer.byteLength(windowA), true]
      )
      await until(() => snaps.at(-1)?.inputTokens !== firstInput)
      check(
        'a volatile copy is read afresh on every change, so the slid window is read',
        [firstInput, snaps.at(-1)?.inputTokens, snaps.at(-1)?.messageCount],
        [1049, 1059, 50]
      )
    } finally {
      watcher.disposeAll()
    }
  }

  /*
   * listSessions: the same answer as parsing every transcript, from a cache
   * that re-parses only the transcript that moved. A hermetic root, so it
   * never reads (or races) this machine's real history.
   */
  {
    const root = join(tx, 'projects-root')
    const project = join(tx, 'some-project')
    const hist = join(root, encodePath(project))
    mkdirSync(join(hist, 'aaaa', 'subagents'), { recursive: true })
    const name = (id: string): string => join(hist, `${id}.jsonl`)
    writeFileSync(name('aaaa'), synthTranscript(50, 31))
    writeFileSync(name('bbbb'), synthTranscript(80, 32))
    writeFileSync(name('cccc'), synthTranscript(20, 33))
    for (const id of ['aaaa', 'bbbb', 'cccc']) touch(name(id))
    mkdirSync(name('dddd')) // a directory called .jsonl is not a transcript
    writeFileSync(join(hist, 'aaaa', 'subagents', 'agent.jsonl'), synthTranscript(5, 34))

    /** What listSessions returned before it cached anything: a parse of every transcript. */
    const reference = async (): Promise<SessionMeta[]> => {
      const out: SessionMeta[] = []
      for (const id of ['aaaa', 'bbbb', 'cccc']) {
        let st
        try {
          st = statSync(name(id))
        } catch {
          continue
        }
        const p = await parseSession(name(id))
        const used = contextUsed(p)
        out.push({
          id,
          file: name(id),
          projectPath: project,
          title: p.title,
          firstPrompt: p.firstPrompt,
          modified: st.mtimeMs,
          sizeBytes: st.size,
          messageCount: p.messageCount,
          model: p.model,
          contextTokens: used,
          contextLimit: contextLimitFor(p.model, used),
          gitBranch: p.gitBranch
        })
      }
      return out.sort((a, b) => b.modified - a.modified)
    }

    const cache = createSessionListCache()
    const stats = { parses: 0, cacheHits: 0 }
    const opts = { root, cache, stats }
    const cold = await listSessions(project, opts)
    check('listSessions answers what parsing every transcript answers', cold, await reference())
    check('a cold list parses each transcript once', [stats.parses, stats.cacheHits], [3, 0])
    const warm = await listSessions(project, opts)
    check('a warm list is identical and parses nothing', [same(warm, cold), stats.parses, stats.cacheHits], [true, 3, 3])

    appendFileSync(name('bbbb'), synthTranscript(10, 35))
    touch(name('bbbb'))
    const moved = await listSessions(project, opts)
    check('after one transcript changes, only it is parsed again', [stats.parses, stats.cacheHits], [4, 5])
    check('and the list is still exactly the uncached answer', moved, await reference())

    rmSync(name('cccc'))
    const shrunk = await listSessions(project, opts)
    check(
      'a deleted transcript leaves the list and the cache',
      [shrunk.map((s) => s.id).sort(), cache.size],
      [['aaaa', 'bbbb'], 2]
    )

    appendFileSync(name('aaaa'), synthTranscript(10, 36))
    touch(name('aaaa'))
    const parsesBefore = stats.parses
    const [x, y] = await Promise.all([listSessions(project, opts), listSessions(project, opts)])
    check(
      'two overlapping lists share one parse of the changed transcript',
      [stats.parses - parsesBefore, same(x, y)],
      [1, true]
    )
  }

  // The concurrency cap both readers share.
  {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    const out = await mapLimit(items, 3, async (i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(2)
      inFlight--
      return i * 2
    })
    check('mapLimit holds its limit in flight and keeps the order', [peak, out], [3, items.map((i) => i * 2)])
  }
} finally {
  rmSync(tx, { recursive: true, force: true })
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
