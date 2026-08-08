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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, ProjectMeta, Settings } from '../src/shared/types.ts'
import { pathRulesFor } from '../src/shared/paths.ts'
import {
  applyProjectMeta,
  manualProjectPatch,
  projectMetaPatch
} from '../src/main/projectMeta.ts'
import { listProjects } from '../src/main/projects.ts'

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

const tmp = mkdtempSync(join(tmpdir(), 'stoke-folders-'))
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
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
