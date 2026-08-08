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
    tag('hiddenProjects is not touched by a metadata write'),
    Object.keys(projectMetaPatch(settings({ hiddenProjects: [p('a')] }), p('a'), null, RULES)),
    ['projectMeta']
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
    tag('a synthetic project takes its group from its parent folder'),
    applyProjectMeta([], { [p('work', 'thing')]: { addedManually: true } }, opts)[0].group,
    'work'
  )
  check(
    tag('a synthetic project reports whether the folder is really there'),
    applyProjectMeta([], { [p('gone')]: { addedManually: true } }, {
      ...opts,
      exists: () => false
    })[0].exists,
    false
  )
  check(
    tag('a synthetic project can be pinned like any other'),
    applyProjectMeta([], { [p('added')]: { addedManually: true } }, {
      ...opts,
      pinned: [p('added')]
    })[0].pinned,
    true
  )
  check(
    tag('a record that is only an emoji conjures no project'),
    applyProjectMeta([], { [p('nope')]: { emoji: '🔥' } }, opts),
    []
  )
  if (RULES.caseInsensitive) {
    check(
      tag('a differently-cased key matches the project it belongs to on this OS'),
      applyProjectMeta([project(p('Known'))], { [p('known')]: { emoji: '🔥' } }, opts).map(
        (x) => x.emoji
      ),
      ['🔥']
    )
  }
}

runFor('darwin')
runFor('win32')
runFor('linux')

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
