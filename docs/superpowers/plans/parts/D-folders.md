## Workstream D — folders, metadata and emoji

Design spec §4.D and §2.5. Eight tasks, 40–47.

**These tasks assume Tasks 1–5 of the shared-contracts section have already landed.** They import
`src/shared/paths.ts` (Task 1), the `ProjectMeta` type, the three new `Project` fields and the
`CH.projectsMeta` channel (Task 2), and `src/main/settingsSchema.ts` with `projectMeta` hydration
(Task 3). Nothing here re-declares any of that. Task 4 (the CSS token block) has also landed, so
`--sp-*` no longer exists and every new rule uses `--space-*`.

**Why this order.** The rules come first and the wiring second, because that is the only split that
can be tested at all: `src/main/index.ts` imports `electron`, so an IPC handler can never be run by
a verify suite, whereas `src/main/projects.ts` imports none and can. So Task 40 puts every decision
("which folder does this record belong to", "does adding a folder un-hide it", "what does a
synthetic project look like") into one electron-free module with a suite, Task 41 wires it into
`listProjects` — which is the step that makes an added folder actually appear — and Task 42 reduces
the two IPC handlers to glue over already-tested functions. The UI (43, 44) needs `Project.emoji`
to already be populated or there is nothing to render. Tasks 45 and 46 are independent bug fixes
that share the same root cause as the rest of the workstream (a path rule that is wrong on APFS,
and a candidate list written for one Windows machine) and can be done in any order relative to
40–44. Task 47 is last on purpose: it is the machine repair, and it asserts its own success through
the gate, which only reads correctly once the scan root is right.

---

### Task 40: The folder-metadata rules, in a module a suite can run

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/projectMeta.ts`
- Create: `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` — the `scripts` block (`verify:profiles`
  is at line 17 today; `check` at line 28)

**Interfaces:**

*Consumes* (all from Tasks 1–3, already landed):
```ts
// src/shared/paths.ts
export interface PathRules { sep: '/' | '\\'; caseInsensitive: boolean }
export function pathRulesFor(platform: string): PathRules
export function normalizePath(p: string, rules: PathRules): string
export function pathKey(p: string, rules: PathRules): string
export function basenameOf(p: string): string
export function parentName(p: string): string
// src/shared/types.ts
export interface ProjectMeta { emoji?: string; label?: string; addedManually?: boolean }
// Project now carries: emoji: string | null; label: string | null; addedManually: boolean
// Settings now carries: projectMeta: Record<string, ProjectMeta>
```

*Produces* — `src/main/projectMeta.ts`:
```ts
export interface ProjectMetaOptions {
  rules: PathRules
  /** `Settings.pinnedProjects`, so a manually added folder can be pinned too. */
  pinned: string[]
  /** Does this folder exist on disk? `existsSync` in the app; a fake in the suite. */
  exists: (path: string) => boolean
}
export function manualProjectPatch(
  settings: Settings,
  rawPath: string,
  rules: PathRules
): Partial<Settings>
export function projectMetaPatch(
  settings: Settings,
  rawPath: string,
  meta: ProjectMeta | null,
  rules: PathRules
): Partial<Settings>
export function applyProjectMeta(
  projects: Project[],
  meta: Record<string, ProjectMeta>,
  opts: ProjectMetaOptions
): Project[]
```

- [ ] **Step 1: Write the failing suite.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts` with exactly this content. The
  assertion helper and the output format are copied from `scripts/verify-worklog-gate.mts:17-26`.

  ```ts
  /*
   * Everything in the sidebar that comes from a folder rather than from Claude's
   * own files: the per-project metadata record, the folder a user added by hand,
   * and the working directory a session with no project lands in.
   *
   * All three failed the same way — silently, by listing nothing — so each case
   * here asserts a value rather than the absence of a throw.
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

  const RULES = pathRulesFor(process.platform)
  const isWin = process.platform === 'win32'

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

  console.log('\nadding a folder by hand')
  check(
    'the folder is recorded, which is the whole of spec 2.5',
    manualProjectPatch(settings({}), p('newthing'), RULES).projectMeta,
    { [p('newthing')]: { addedManually: true } }
  )
  check(
    'a trailing separator does not make a second record',
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
    'an emoji already on the folder survives being added again',
    manualProjectPatch(
      settings({ projectMeta: { [p('newthing')]: { emoji: '🔥' } } }),
      p('newthing'),
      RULES
    ).projectMeta,
    { [p('newthing')]: { emoji: '🔥', addedManually: true } }
  )
  check(
    'adding a folder undoes having hidden it',
    manualProjectPatch(
      settings({ hiddenProjects: [p('newthing'), p('other')] }),
      p('newthing'),
      RULES
    ).hiddenProjects,
    [p('other')]
  )
  check(
    'and leaves every other record alone',
    manualProjectPatch(
      settings({ projectMeta: { [p('kept')]: { emoji: '🌱' } } }),
      p('newthing'),
      RULES
    ).projectMeta,
    { [p('kept')]: { emoji: '🌱' }, [p('newthing')]: { addedManually: true } }
  )
  check('an empty path writes nothing at all', manualProjectPatch(settings({}), '  ', RULES), {})

  console.log('\nsetting one folder’s metadata')
  check(
    'a record replaces what was there, rather than merging into it',
    projectMetaPatch(
      settings({ projectMeta: { [p('a')]: { emoji: '🔥', label: 'Old' } } }),
      p('a'),
      { emoji: '🌱' },
      RULES
    ).projectMeta,
    { [p('a')]: { emoji: '🌱' } }
  )
  check(
    'null deletes the record, which is how an added folder leaves the sidebar',
    projectMetaPatch(
      settings({ projectMeta: { [p('a')]: { addedManually: true }, [p('b')]: { emoji: '🔥' } } }),
      p('a'),
      null,
      RULES
    ).projectMeta,
    { [p('b')]: { emoji: '🔥' } }
  )
  check(
    'a record that says nothing is a deletion, not an empty object',
    projectMetaPatch(
      settings({ projectMeta: { [p('a')]: { emoji: '🔥' } } }),
      p('a'),
      { emoji: '   ' },
      RULES
    ).projectMeta,
    {}
  )
  check(
    'addedManually needs a literal true here too',
    projectMetaPatch(settings({}), p('a'), { addedManually: false, emoji: '🔥' }, RULES).projectMeta,
    { [p('a')]: { emoji: '🔥' } }
  )
  check(
    'hiddenProjects is not touched by a metadata write',
    Object.keys(projectMetaPatch(settings({ hiddenProjects: [p('a')] }), p('a'), null, RULES)),
    ['projectMeta']
  )

  console.log('\nstamping metadata onto the listed projects')
  const listed = [project(p('known'))]
  const opts = { rules: RULES, pinned: [] as string[], exists: () => true }
  check(
    'a manually added folder is appended, because nothing else can produce it',
    applyProjectMeta(listed, { [p('added')]: { addedManually: true } }, opts).map((x) => x.path),
    [p('known'), p('added')]
  )
  check(
    'a folder that is already listed is not appended twice',
    applyProjectMeta(listed, { [p('known')]: { addedManually: true } }, opts).map((x) => x.path),
    [p('known')]
  )
  check(
    'the emoji and label reach the project object',
    applyProjectMeta(listed, { [p('known')]: { emoji: '🔥', label: 'Known' } }, opts).map((x) => [
      x.emoji,
      x.label
    ]),
    [['🔥', 'Known']]
  )
  check(
    'a project with no record keeps the empty shape rather than undefined',
    applyProjectMeta(listed, {}, opts).map((x) => [x.emoji, x.label, x.addedManually]),
    [[null, null, false]]
  )
  check(
    'a synthetic project takes its group from its parent folder',
    applyProjectMeta([], { [p('work', 'thing')]: { addedManually: true } }, opts)[0].group,
    'work'
  )
  check(
    'a synthetic project reports whether the folder is really there',
    applyProjectMeta([], { [p('gone')]: { addedManually: true } }, {
      ...opts,
      exists: () => false
    })[0].exists,
    false
  )
  check(
    'a synthetic project can be pinned like any other',
    applyProjectMeta([], { [p('added')]: { addedManually: true } }, {
      ...opts,
      pinned: [p('added')]
    })[0].pinned,
    true
  )
  check(
    'a record that is only an emoji conjures no project',
    applyProjectMeta([], { [p('nope')]: { emoji: '🔥' } }, opts),
    []
  )
  if (RULES.caseInsensitive) {
    check(
      'a differently-cased key matches the project it belongs to on this OS',
      applyProjectMeta([project(p('Known'))], { [p('known')]: { emoji: '🔥' } }, opts).map(
        (x) => x.emoji
      ),
      ['🔥']
    )
  }

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exitCode = failures ? 1 : 0
  ```

  The `mkdirSync`, `mkdtempSync`, `rmSync`, `tmpdir` and `join` imports are unused until Task 41
  adds the `listProjects` block; leave them, `scripts/` is in neither tsconfig `include` so nothing
  reports them.

- [ ] **Step 2: Run it and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/verify-folders.mts`
  Expected:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/main/projectMeta.ts' imported from /Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts`

- [ ] **Step 3: Create the module.** Write
  `/Users/thevinh/dev/personal/stoke/src/main/projectMeta.ts`:

  ```ts
  /**
   * What the user has said about a folder, over and above what Claude's own files
   * record: an emoji, a display name, and whether they added the folder at all.
   *
   * Kept out of projects.ts and out of index.ts on purpose. index.ts imports
   * electron, so nothing in it can be run by a verify suite — and every one of
   * these rules fails by listing the wrong set of folders rather than by
   * throwing, which is exactly the class a typecheck cannot catch.
   *
   * Paths are compared with `pathKey`, never with `===`: the picker hands back
   * whatever casing the OS dialog produced, and on APFS and NTFS that is a
   * different string for the same folder.
   */
  import type { Project, ProjectMeta, Settings } from '@shared/types'
  import type { PathRules } from '../shared/paths.ts'
  import { basenameOf, normalizePath, parentName, pathKey } from '../shared/paths.ts'

  export interface ProjectMetaOptions {
    rules: PathRules
    /** `Settings.pinnedProjects`, so a manually added folder can be pinned too. */
    pinned: string[]
    /** Does this folder exist on disk? `existsSync` in the app. */
    exists: (path: string) => boolean
  }

  /**
   * Trim and cap one record the same way `hydrateSettings` will on the way to
   * disk, so the patch a caller gets back is byte-for-byte what ends up stored
   * and a test can assert on it.
   *
   * A record that says nothing is dropped rather than kept as `{}` — otherwise
   * the settings file accumulates an empty object for every folder that was ever
   * right-clicked.
   */
  function tidy(meta: ProjectMeta): ProjectMeta | null {
    const out: ProjectMeta = {}
    if (typeof meta.emoji === 'string') {
      const emoji = meta.emoji.trim().slice(0, 16)
      if (emoji) out.emoji = emoji
    }
    if (typeof meta.label === 'string') {
      const label = meta.label.trim().slice(0, 64)
      if (label) out.label = label
    }
    // Only a literal true. A truthy leftover must not conjure a project out of a
    // folder nobody added.
    if (meta.addedManually === true) out.addedManually = true
    return Object.keys(out).length ? out : null
  }

  /** Every stored record except the one for `key`, plus that record if it exists. */
  function split(
    stored: Record<string, ProjectMeta>,
    key: string,
    rules: PathRules
  ): { rest: Record<string, ProjectMeta>; current: ProjectMeta } {
    const rest: Record<string, ProjectMeta> = {}
    let current: ProjectMeta = {}
    for (const [path, value] of Object.entries(stored)) {
      if (pathKey(path, rules) === key) current = value
      else rest[path] = value
    }
    return { rest, current }
  }

  /**
   * The patch for "the user picked this folder in the Open dialog".
   *
   * Un-hiding is not a nicety: `listProjects` applies `hiddenProjects` last, so a
   * folder that was hidden and then explicitly added would be recorded, listed,
   * and then filtered straight back out — the picker would report success and the
   * sidebar would never change, which is precisely the failure spec 2.5 reports.
   */
  export function manualProjectPatch(
    settings: Settings,
    rawPath: string,
    rules: PathRules
  ): Partial<Settings> {
    const path = normalizePath(rawPath.trim(), rules)
    if (!path) return {}
    const key = pathKey(path, rules)
    const { rest, current } = split(settings.projectMeta ?? {}, key, rules)
    const entry = tidy({ ...current, addedManually: true })
    if (entry) rest[path] = entry
    return {
      projectMeta: rest,
      hiddenProjects: (settings.hiddenProjects ?? []).filter((p) => pathKey(p, rules) !== key)
    }
  }

  /**
   * The patch for one folder's metadata record.
   *
   * `meta` REPLACES the record; it is not merged into it. The renderer already
   * holds every field on `Project`, so it can send the whole record, and a
   * replace has one unambiguous way to clear a field — where a merge would need
   * `undefined` to survive a structured clone, which is not something to bet a
   * user's pinned folder on. `null` deletes the record outright, which for a
   * folder that only existed because `addedManually` was set is also how it
   * leaves the sidebar.
   */
  export function projectMetaPatch(
    settings: Settings,
    rawPath: string,
    meta: ProjectMeta | null,
    rules: PathRules
  ): Partial<Settings> {
    const path = normalizePath(rawPath.trim(), rules)
    if (!path) return {}
    const key = pathKey(path, rules)
    const { rest } = split(settings.projectMeta ?? {}, key, rules)
    const entry = meta ? tidy(meta) : null
    if (entry) rest[path] = entry
    return { projectMeta: rest }
  }

  /**
   * Add the folders only the user knows about, then stamp every project with its
   * record.
   *
   * The append half is the missing source spec 2.5 names: `listProjects` learns
   * about folders from Claude's history and from scan roots, and a scan root
   * enumerates its CHILDREN, so a single folder the user picked has never had any
   * way to become a project.
   */
  export function applyProjectMeta(
    projects: Project[],
    meta: Record<string, ProjectMeta>,
    opts: ProjectMetaOptions
  ): Project[] {
    const { rules, pinned, exists } = opts
    const byKey = new Map<string, ProjectMeta>()
    for (const [path, value] of Object.entries(meta)) byKey.set(pathKey(path, rules), value)

    const out = [...projects]
    const present = new Set(out.map((p) => pathKey(p.path, rules)))
    const pinnedKeys = new Set(pinned.map((p) => pathKey(p, rules)))

    for (const [rawPath, value] of Object.entries(meta)) {
      if (value.addedManually !== true) continue
      const path = normalizePath(rawPath, rules)
      const key = pathKey(path, rules)
      if (!path || present.has(key)) continue
      present.add(key)
      out.push({
        path,
        name: basenameOf(path) || path,
        group: parentName(path),
        encodedDir: null,
        sessionCount: 0,
        lastModified: null,
        lastCost: null,
        lastPrompt: null,
        exists: exists(path),
        pinned: pinnedKeys.has(key),
        emoji: null,
        label: null,
        addedManually: true
      })
    }

    return out.map((p) => {
      const record = byKey.get(pathKey(p.path, rules))
      if (!record) return p
      return {
        ...p,
        emoji: record.emoji ?? null,
        label: record.label ?? null,
        addedManually: record.addedManually === true
      }
    })
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  `node scripts/verify-folders.mts` → the last line reads `all pass`.

- [ ] **Step 5: Register the suite.** In `/Users/thevinh/dev/personal/stoke/package.json`, add
  `"verify:folders": "node scripts/verify-folders.mts",` immediately after the `"verify:settings"`
  line, and insert `&& npm run verify:folders` into `check` immediately after
  `npm run verify:settings`.

- [ ] **Step 6: Run the whole check.** `npm run check` exits 0.

- [ ] **Step 7: Commit.**
  `git commit -m "Give a folder somewhere to keep an emoji, a name and the fact you added it"`
  Body records: adding a folder was a no-op because there was no per-project metadata store and no
  source in `listProjects` that could represent a single explicitly added folder; and that adding a
  folder now un-hides it, because `hiddenProjects` is applied last and would otherwise filter the
  new record straight back out.

---

### Task 41: `listProjects` emits added folders and carries their metadata

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/projects.ts` — imports (lines 1-6), the
  `Project` literal inside `put` (lines 160-174), and the return block (lines 215-221)
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts` — append a block
- Test: `node scripts/verify-folders.mts`

**Interfaces:**

*Consumes:* `applyProjectMeta`, `ProjectMetaOptions` (Task 40); `pathRulesFor` from
`src/shared/paths.ts`.

*Produces:* no new signature. `listProjects(settings: Settings): Promise<Project[]>` keeps its
shape and gains two guarantees: every returned `Project` carries `emoji`, `label` and
`addedManually`, and a folder with `projectMeta[path].addedManually === true` is present unless it
is hidden.

- [ ] **Step 1: Extend the suite.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts`, add this import beneath the
  existing `projectMeta.ts` import:

  ```ts
  import { listProjects } from '../src/main/projects.ts'
  ```

  and insert this block immediately before the two final lines of the file (the summary console.log and the process.exitCode assignment):

  ```ts
  console.log('\nlistProjects, against this machine’s real Claude config')
  /*
   * A real run, not a fake: listProjects reads ~/.claude.json and
   * ~/.claude/projects itself, so the only honest way to test the added-folder
   * source is to add a folder that really exists and assert about that one path.
   */
  const tmp = mkdtempSync(join(tmpdir(), 'stoke-folders-'))
  const added = join(tmp, 'added-by-hand')
  mkdirSync(added)
  try {
    const withAdded = await listProjects(
      settings({ projectMeta: { [added]: { addedManually: true, emoji: '🧪', label: 'Bench' } } })
    )
    const hit = withAdded.find((x) => x.path === added)
    check('a folder the user added by hand is listed', hit !== undefined, true)
    check('it carries its emoji', hit?.emoji, '🧪')
    check('it carries its label', hit?.label, 'Bench')
    check('it knows it is there only because someone added it', hit?.addedManually, true)
    check('it reports the folder really exists', hit?.exists, true)
    check('and it has no history attached', [hit?.sessionCount, hit?.encodedDir], [0, null])

    const alsoHidden = await listProjects(
      settings({
        projectMeta: { [added]: { addedManually: true } },
        hiddenProjects: [added]
      })
    )
    check(
      'a manually added folder can still be hidden',
      alsoHidden.some((x) => x.path === added),
      false
    )

    const plain = await listProjects(settings({}))
    check(
      'every project carries the three metadata fields, record or no record',
      plain.every((x) => x.emoji === null && x.label === null && x.addedManually === false),
      true
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-folders.mts`
  Expected, as the first new failing line:
  `  FAIL  a folder the user added by hand is listed`
  `        got false, want true`

- [ ] **Step 3: Import the rule into `projects.ts`.** At
  `/Users/thevinh/dev/personal/stoke/src/main/projects.ts`, replace lines 5-6:

  ```ts
  import type { Project, SessionMeta, Settings } from '@shared/types'
  import { contextLimitFor, contextUsed, parseSession, safeParse } from './sessionFile.ts'
  ```

  with:

  ```ts
  import type { Project, SessionMeta, Settings } from '@shared/types'
  import { pathRulesFor } from '../shared/paths.ts'
  import { applyProjectMeta } from './projectMeta.ts'
  import { contextLimitFor, contextUsed, parseSession, safeParse } from './sessionFile.ts'
  ```

- [ ] **Step 4: Make the metadata reach the list.** In the same file, replace lines 215-221 — the
  block that currently reads:

  ```ts
    const hidden = new Set(settings.hiddenProjects.map(dedupeKey))
    return [...merged.values()]
      .filter((p) => !hidden.has(dedupeKey(p.path)))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return (b.lastModified ?? 0) - (a.lastModified ?? 0)
      })
  ```

  with:

  ```ts
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
  ```

- [ ] **Step 5: Run it and watch it pass.**
  `node scripts/verify-folders.mts` → `all pass`.

- [ ] **Step 6: Typecheck.** `npm run typecheck` exits 0. If it reports
  `src/main/projects.ts(...): error TS2739: ... is missing the following properties from type
  'Project': emoji, label, addedManually`, the literal inside `put` (projects.ts:160-174) still
  needs `emoji: null,`, `label: null,` and `addedManually: false` after its `pinned:` line —
  contracts Task 2 step 6 adds them, so this only bites if that step was skipped.

- [ ] **Step 7: Commit.**
  `git commit -m "List the folders the user added, not only the ones Claude has seen"`
  Body records: `listProjects`' only no-history source was scan roots, which enumerate a folder's
  children, so the root itself never became a project and picking a folder could not work no matter
  what the dialog returned (spec §2.5).

---

### Task 42: Persist the picked folder, and expose `projects:meta`

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` — the `projectsAdd` handler
  (lines 498-505) and one new handler beside it
- Modify: `/Users/thevinh/dev/personal/stoke/src/preload/index.ts` — the `projects` block
  (lines 36-44)
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/api.ts` — the `projects` block
  (lines 112-122)
- Create: `/Users/thevinh/dev/personal/stoke/scripts/cdp-eval.mjs`
- Test: CDP evaluation against a running instance

**Interfaces:**

*Consumes:* `manualProjectPatch`, `projectMetaPatch` (Task 40); `CH.projectsMeta` = `'projects:meta'`
(contracts Task 2); `getSettings`, `setSettings` from `./store.ts`; `pathRulesFor` from
`../shared/paths.ts`.

*Produces* — `src/shared/api.ts`, inside `projects`:
```ts
    /** Set or clear one folder's metadata. `null` deletes the record. */
    setMeta(path: string, meta: ProjectMeta | null): Promise<Settings>
```
`projects.open()` keeps its `Promise<string | null>` signature and gains the guarantee that the
returned path has been persisted.

- [ ] **Step 1: Add the CDP helper.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/cdp-eval.mjs`:

  ```js
  /*
   * Evaluate one expression inside Stoke's own renderer.
   *
   *   npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp
   *   node scripts/cdp-eval.mjs "document.querySelectorAll('.project').length"
   *
   * Targets are filtered by URL, never by `type === 'page'`: the docked browser
   * is its own page target and would happily answer for the wrong document
   * (CLAUDE.md gotcha 6).
   */
  import WebSocket from 'ws'

  const expression = process.argv[2]
  if (!expression) {
    console.error('usage: node scripts/cdp-eval.mjs "<expression>"')
    process.exit(2)
  }

  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const target = list.find(
    (t) =>
      t.type === 'page' &&
      (t.url.startsWith('file://') || /^https?:\/\/localhost:\d+\//.test(t.url))
  )
  if (!target) {
    console.error('no Stoke renderer target. Targets seen:')
    for (const t of list) console.error(`  ${t.type}  ${t.url}`)
    process.exit(1)
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.on('open', () =>
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  )
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id !== 1) return
    const r = msg.result?.result
    if (msg.result?.exceptionDetails) {
      console.error(msg.result.exceptionDetails.text, r?.description ?? '')
      process.exit(1)
    }
    console.log(JSON.stringify(r?.value ?? null, null, 2))
    ws.close()
    process.exit(0)
  })
  ```

- [ ] **Step 2: Persist the picked folder.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, replace the whole `projectsAdd` handler at
  lines 498-505:

  ```ts
  ipcMain.handle(CH.projectsAdd, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ```

  with:

  ```ts
  /*
   * Picking a folder used to return the path and write nothing, so the dialog
   * closed and the sidebar was unchanged (spec 2.5). The record is what makes
   * `listProjects` able to emit a folder Claude has never seen.
   */
  ipcMain.handle(CH.projectsAdd, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    const dir = res.canceled ? null : (res.filePaths[0] ?? null)
    if (!dir) return null
    setSettings(manualProjectPatch(getSettings(), dir, pathRulesFor(process.platform)))
    return dir
  })

  ipcMain.handle(CH.projectsMeta, (_e, path: string, meta: ProjectMeta | null) =>
    setSettings(projectMetaPatch(getSettings(), path, meta, pathRulesFor(process.platform)))
  )
  ```

- [ ] **Step 3: Import what that handler now uses.** In the same file, add to the import block:

  ```ts
  import { manualProjectPatch, projectMetaPatch } from './projectMeta.ts'
  import { pathRulesFor } from '../shared/paths.ts'
  ```

  and add `ProjectMeta` to the existing type-only `@shared/types` import.

- [ ] **Step 4: Bridge it.** In `/Users/thevinh/dev/personal/stoke/src/preload/index.ts`, add this
  line to the `projects` block after `pin` (line 42):

  ```ts
    setMeta: (path: string, meta: ProjectMeta | null) =>
      ipcRenderer.invoke(CH.projectsMeta, path, meta),
  ```

  and add `ProjectMeta` to the type-only import from `@shared/types` on line 5.

- [ ] **Step 5: Declare it.** In `/Users/thevinh/dev/personal/stoke/src/shared/api.ts`, add to the
  `projects` block after `pin` (line 120):

  ```ts
    /** Set or clear one folder's metadata. `null` deletes the record, which is
     *  also how a folder that exists only because it was added leaves the list. */
    setMeta(path: string, meta: ProjectMeta | null): Promise<Settings>
  ```

  and add `ProjectMeta` to that file's type import from `./types`.

- [ ] **Step 6: Typecheck.** `npm run typecheck` exits 0.

- [ ] **Step 7: Prove the bridge over CDP.** Build and launch against a throwaway profile, so this
  cannot disturb the real settings file:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && \
    npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp &
  ```

  Then, once the window is up:

  ```bash
  node scripts/cdp-eval.mjs "window.stoke.projects.setMeta('/tmp/stoke-cdp-fixture', { emoji: '🔥', addedManually: true }).then(s => s.projectMeta)"
  ```

  Expected output:

  ```json
  {
    "/tmp/stoke-cdp-fixture": {
      "emoji": "🔥",
      "addedManually": true
    }
  }
  ```

  Then clear it and confirm the delete path:

  ```bash
  node scripts/cdp-eval.mjs "window.stoke.projects.setMeta('/tmp/stoke-cdp-fixture', null).then(s => s.projectMeta)"
  ```

  Expected output: `{}`

- [ ] **Step 8: Prove the dialog persists, by hand.** With the same instance still running, click
  **Open** in the sidebar and choose `/tmp`. Then:

  ```bash
  node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('/tmp/stoke-cdp/settings.json','utf8')).projectMeta, null, 2))"
  ```

  Expected output:

  ```json
  {
    "/tmp": {
      "addedManually": true
    }
  }
  ```

  Quit the instance and `rm -rf /tmp/stoke-cdp` afterwards.

- [ ] **Step 9: Commit.**
  `git commit -m "Actually keep the folder the Open dialog returned"`
  Body records: `projectsAdd` opened the picker and returned the path with no `setSettings` and no
  write, so choosing a folder did nothing at all (spec §2.5); and adds `projects:meta` as the one
  channel that both sets and clears a folder's record.

---

### Task 43: The emoji picker

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/ProjectMetaPicker.tsx`
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — insert a block
  immediately after the `.project:hover .project-pin, .project:focus-within .project-pin,
  .project-pin[aria-pressed='true']` rule (currently lines 779-783)
- Test: typecheck and build; the component is mounted in Task 44

**Interfaces:**

*Consumes:* `Project` and `ProjectMeta` from `@shared/types`; `IconFolder` from `./Icons`; the
tokens `--space-4/8/12`, `--r-md`, `--r-sm`, `--surface`, `--surface-hover`, `--bg-sunken`,
`--border`, `--border-strong`, `--text`, `--text-muted`, `--text-faint`, `--accent`,
`--accent-soft`, `--danger`, `--shadow-panel`, `--z-dropdown`, `--dur-fast`, `--ease`,
`--fs-xs`, `--fs-sm`, `--icon-sm` (all from contracts Task 4).

*Produces:*
```ts
export interface ProjectMetaPickerProps {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `null` clears the record entirely. */
  onCommit: (meta: ProjectMeta | null) => void
}
export function ProjectMetaPicker(props: ProjectMetaPickerProps): React.JSX.Element
```

- [ ] **Step 1: Write the component.** Create
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/ProjectMetaPicker.tsx`:

  ```tsx
  import { useEffect, useState } from 'react'
  import type { Project, ProjectMeta } from '@shared/types'
  import { IconFolder } from './Icons'

  /**
   * An emoji and a display name for one folder.
   *
   * Neither touches the disk. Renaming the folder would break every transcript
   * path Claude has already written for it — the encoded history directory is the
   * absolute cwd with its punctuation replaced — so the name here is a label over
   * the top and the folder keeps whatever it is really called. The row's tooltip
   * still shows the real path, which is the one thing a label must not hide.
   *
   * A fixed palette rather than a text field: an arbitrary string would have to be
   * validated as an emoji somehow, and every rule for that is wrong for somebody's
   * script. Twenty-four is enough to tell a sidebar apart at a glance.
   */
  const EMOJI = [
    '🔥', '🚀', '🧪', '🛠️', '📦', '🌱',
    '🐙', '🎯', '💡', '📓', '🧠', '🎨',
    '🕹️', '🛒', '💳', '📊', '🔒', '🌐',
    '⚙️', '🧩', '🍀', '🐳', '⚡', '🗂️'
  ]

  export interface ProjectMetaPickerProps {
    project: Project
    open: boolean
    onOpenChange: (open: boolean) => void
    /** `null` clears the record entirely. */
    onCommit: (meta: ProjectMeta | null) => void
  }

  /** The record as it stands, so a change to one field cannot drop the others. */
  function currentMeta(p: Project): ProjectMeta {
    const meta: ProjectMeta = {}
    if (p.emoji) meta.emoji = p.emoji
    if (p.label) meta.label = p.label
    if (p.addedManually) meta.addedManually = true
    return meta
  }

  /** An empty record means "no record", which is a delete rather than a write. */
  function commitOrClear(meta: ProjectMeta): ProjectMeta | null {
    return Object.keys(meta).length ? meta : null
  }

  export function ProjectMetaPicker({
    project,
    open,
    onOpenChange,
    onCommit
  }: ProjectMetaPickerProps): React.JSX.Element {
    const [label, setLabel] = useState(project.label ?? '')

    // The row re-renders whenever the project list refreshes; the field must
    // follow the stored value rather than keep a stale edit alive.
    useEffect(() => {
      setLabel(project.label ?? '')
    }, [project.label, open])

    const setEmoji = (emoji: string | null): void => {
      const meta = currentMeta(project)
      if (emoji) meta.emoji = emoji
      else delete meta.emoji
      onCommit(commitOrClear(meta))
    }

    const commitLabel = (): void => {
      const next = label.trim()
      if (next === (project.label ?? '')) return
      const meta = currentMeta(project)
      if (next) meta.label = next
      else delete meta.label
      onCommit(commitOrClear(meta))
    }

    return (
      <div
        className="project-meta-picker"
        /* Closing on focus leaving the whole popover, rather than on a document
           click: a native WebContentsView paints above renderer DOM, so a
           full-screen click-catching layer is not reliable here (gotcha 14). */
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onOpenChange(false)
        }}
      >
        <button
          className="icon-btn project-emoji"
          aria-expanded={open}
          aria-label={`Icon and name for ${project.name}`}
          title="Icon and display name"
          onClick={(e) => {
            e.stopPropagation()
            onOpenChange(!open)
          }}
          /* The row above is a role="button" that acts on Enter and Space, so
             without this every key that opens the picker also starts a session. */
          onKeyDown={(e) => e.stopPropagation()}
        >
          {project.emoji ? (
            <span className="project-emoji-glyph" aria-hidden="true">
              {project.emoji}
            </span>
          ) : (
            <IconFolder />
          )}
        </button>

        {open && (
          <div
            className="project-meta-pop"
            role="dialog"
            aria-label={`Icon and name for ${project.name}`}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              /* Every key, not just Escape: the row above acts on Enter and on
                 Space, so a space typed into the name field would select the
                 project and never reach the field. */
              e.stopPropagation()
              if (e.key === 'Escape') onOpenChange(false)
            }}
          >
            <div className="project-meta-grid">
              {EMOJI.map((glyph) => (
                <button
                  key={glyph}
                  className="project-emoji-option"
                  aria-pressed={project.emoji === glyph}
                  onClick={() => setEmoji(glyph)}
                  title={glyph}
                >
                  <span aria-hidden="true">{glyph}</span>
                  <span className="sr-only">{glyph}</span>
                </button>
              ))}
            </div>

            <label className="sr-only" htmlFor={`label-${project.path}`}>
              Display name for {project.name}
            </label>
            <input
              id={`label-${project.path}`}
              className="input"
              value={label}
              placeholder={project.name}
              spellCheck={false}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitLabel()
                  onOpenChange(false)
                }
              }}
            />
            <p className="project-meta-note">
              Shown in this list only. The folder on disk keeps its own name.
            </p>

            <div className="project-meta-actions">
              <button
                className="btn"
                data-variant="ghost"
                onClick={() => setEmoji(null)}
                disabled={!project.emoji}
              >
                No icon
              </button>
              {project.addedManually && (
                <button
                  className="btn"
                  data-variant="danger"
                  onClick={() => {
                    onCommit(null)
                    onOpenChange(false)
                  }}
                  title="Stop listing this folder. Nothing on disk is deleted."
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }
  ```

- [ ] **Step 2: Add the styles.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, insert this block
  immediately after the `.project-pin[aria-pressed='true'] { opacity: 1; }` rule:

  ```css
  /* --------------------------------------------------- project icon + name */

  /* A fixed slot whether or not there is an emoji, so every project name in the
     list starts at the same x and adding an icon moves nothing. `flex: none` so
     the wrapper never absorbs the row's spare width and shunts the name right. */
  .project-meta-picker {
    display: flex;
    flex: none;
  }

  .project-emoji {
    --icon-size: var(--icon-sm);
    width: 1.125rem;
    height: 1.125rem;
    flex: none;
  }

  .project-emoji-glyph {
    font-size: var(--fs-sm);
    line-height: 1;
  }

  /* Anchored to the row rather than to the button: .sidebar-scroll is a scroll
     container, so anything wider than the sidebar is clipped and drags a
     horizontal scrollbar in with it. Spanning the row is the only width that is
     correct at every sidebar width from the 200px minimum up. */
  .project-meta-pop {
    position: absolute;
    left: var(--space-8);
    right: var(--space-8);
    top: calc(100% + var(--space-4));
    z-index: var(--z-dropdown);
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    padding: var(--space-8);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow: var(--shadow-panel);
  }

  .project-meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(1.75rem, 1fr));
    gap: var(--space-4);
  }

  .project-emoji-option {
    display: grid;
    place-items: center;
    height: 1.75rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: transparent;
    font-size: var(--fs-sm);
    line-height: 1;
    cursor: default;
    transition:
      background var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }

  .project-emoji-option:hover {
    background: var(--surface-hover);
  }

  .project-emoji-option[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .project-meta-note {
    margin: 0;
    color: var(--text-faint);
    font-size: var(--fs-xs);
    line-height: var(--lh-snug);
  }

  .project-meta-actions {
    display: flex;
    gap: var(--space-8);
  }

  /* Scoped rather than adding a global `data-size="sm"`: the only small-button
     rule in the sheet today is scoped to `.worklog`, and a second convention that
     works in two places out of three is worse than a local rule. */
  .project-meta-actions .btn {
    flex: 1;
    padding: 0.1875rem var(--space-8);
    font-size: var(--fs-sm);
  }
  ```

- [ ] **Step 3: Give the row a positioning context.** In the same file, find the `.project` rule
  (currently line 714) and add `position: relative;` as its first declaration, immediately after
  `.project {`. Without it, `.project-meta-pop` positions against the nearest positioned ancestor,
  which is the window.

- [ ] **Step 4: Typecheck and build.**
  `npm run typecheck && npm run build` — both exit 0. The component is not mounted yet, so this
  proves only that it compiles and the CSS parses; Task 44 renders it.

- [ ] **Step 5: Commit.**
  `git commit -m "Add a per-folder icon and display name that never touch the disk"`
  Body records: renaming the folder itself would move the encoded history directory Claude writes
  transcripts into, so the display name is a label over the top and the row's tooltip keeps showing
  the real path.

---

### Task 44: Render the icon and label in the sidebar

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx` — props
  (lines 9-34), the destructure (lines 36-56), the project row (lines 236-315)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — the `<Sidebar>` element
  (lines 689-720)
- Test: CDP measurement against a running instance

**Interfaces:**

*Consumes:* `ProjectMetaPicker`, `ProjectMetaPickerProps` (Task 43); `window.stoke.projects.setMeta`
(Task 42); `Project.emoji`, `Project.label`, `Project.addedManually` (Task 41).

*Produces* — one new `Sidebar` prop:
```ts
  /** Set or clear one folder's icon and display name. `null` clears the record. */
  onSetMeta: (project: Project, meta: ProjectMeta | null) => void
```

- [ ] **Step 1: Declare the prop.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx`, add to the `Props`
  interface immediately after `onPin: (p: Project) => void` (line 22):

  ```ts
    /** Set or clear one folder's icon and display name. `null` clears the record. */
    onSetMeta: (project: Project, meta: ProjectMeta | null) => void
  ```

  add `onSetMeta,` to the destructured parameter list immediately after `onPin,` (line 49), and
  change the type import on line 2 to:

  ```ts
  import type { Project, ProjectMeta, SessionMeta } from '@shared/types'
  ```

- [ ] **Step 2: Import the picker and hold its open state.** Add to the imports at the top of
  `Sidebar.tsx`:

  ```ts
  import { ProjectMetaPicker } from './ProjectMetaPicker'
  ```

  change line 1 to `import { useMemo, useState } from 'react'`, and add this line as the first
  statement inside the `Sidebar` function body, above the `const available = profiles` comment:

  ```ts
    /* One picker open at a time, keyed by path — two open popovers in a scrolling
       list is a way to change the wrong folder without noticing. */
    const [pickerPath, setPickerPath] = useState<string | null>(null)
  ```

- [ ] **Step 3: Render the picker and the label.** In the same file, replace the `.project-top`
  block (lines 258-295) — everything from `<div className="project-top">` to its closing `</div>` —
  with:

  ```tsx
                      <div className="project-top">
                        <button
                          className="icon-btn"
                          style={{
                            width: '1.125rem',
                            height: '1.125rem',
                            rotate: expanded ? '90deg' : '0deg',
                            transition: 'rotate var(--dur) var(--ease)'
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            onToggleExpand(project)
                          }}
                          aria-expanded={expanded}
                          title={expanded ? 'Hide sessions' : 'Show sessions'}
                        >
                          <IconChevron width={12} height={12} />
                          <span className="sr-only">
                            {expanded ? 'Hide sessions' : 'Show sessions'}
                          </span>
                        </button>

                        <ProjectMetaPicker
                          project={project}
                          open={pickerPath === project.path}
                          onOpenChange={(v) => setPickerPath(v ? project.path : null)}
                          onCommit={(meta) => onSetMeta(project, meta)}
                        />

                        {/* The label replaces the basename in this list only; the
                            row's title attribute still carries the real path. */}
                        <span className="project-name">{project.label ?? project.name}</span>

                        <button
                          className="icon-btn project-pin"
                          style={{ width: '1.25rem', height: '1.25rem' }}
                          aria-pressed={project.pinned}
                          onClick={(e) => {
                            e.stopPropagation()
                            onPin(project)
                          }}
                          title={project.pinned ? 'Unpin' : 'Pin to top'}
                        >
                          <IconPin width={12} height={12} />
                          <span className="sr-only">{project.pinned ? 'Unpin' : 'Pin'}</span>
                        </button>
                      </div>
  ```

- [ ] **Step 4: Search the label too.** In the same file, replace the filter expression inside the
  `filtered` memo (lines 89-91):

  ```ts
      return scoped.filter(
        (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
      )
  ```

  with:

  ```ts
      // The label is what the user sees, so it is what they will type. Searching
      // only the basename made a renamed folder unfindable by its own name.
      return scoped.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q) ||
          (p.label ?? '').toLowerCase().includes(q)
      )
  ```

- [ ] **Step 5: Wire it in App.** In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`,
  add this prop to the `<Sidebar>` element immediately after the `onPin={...}` block (which ends at
  line 713):

  ```tsx
                  onSetMeta={(p, meta) => {
                    void window.stoke.projects.setMeta(p.path, meta).then(async (s) => {
                      setSettings(s)
                      await refreshProjects()
                    })
                  }}
  ```

- [ ] **Step 6: Typecheck and build.** `npm run typecheck && npm run build` — both exit 0.

- [ ] **Step 7: Measure the alignment over CDP.** This is the check that matters: a per-row icon
  that is only present sometimes is the classic way to make a list ragged.

  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp &
  ```

  Give one project an emoji and leave the rest alone:

  ```bash
  node scripts/cdp-eval.mjs "(async () => { const ps = await window.stoke.projects.list(); await window.stoke.projects.setMeta(ps[0].path, { emoji: '🔥' }); return ps[0].path })()"
  ```

  Click the Stoke window to give it focus — App refreshes the project list on `focus`, so this is
  what pulls the new emoji into the DOM. Then:

  ```bash
  node scripts/cdp-eval.mjs "new Set([...document.querySelectorAll('.project-name')].map(n => Math.round(n.getBoundingClientRect().left))).size"
  ```

  Expected output: `1` — every project name starts at the same x whether or not its row has an
  emoji. Anything above 1 means `.project-emoji` is not holding its slot.

  Then confirm the popover does not widen the shell (gotcha 14's second half):

  ```bash
  node scripts/cdp-eval.mjs "(async () => { document.querySelector('.project-emoji').click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return [document.documentElement.scrollWidth, window.innerWidth] })()"
  ```

  Expected: the two numbers are equal — e.g. `[1200, 1200]`. A `scrollWidth` larger than
  `innerWidth` means the popover is pushing the grid column wider instead of being clipped.

- [ ] **Step 8: Screenshot the sidebar.** With the popover open, capture the window and confirm by
  eye that the grid, the name field and the two buttons fit inside the sidebar column at the
  default 260px width. Quit the instance and `rm -rf /tmp/stoke-cdp`.

- [ ] **Step 9: Commit.**
  `git commit -m "Show a folder's icon and chosen name in the sidebar"`
  Body records: the icon slot is fixed width so a row with an emoji and a row without still line up,
  measured over CDP rather than reasoned about; and search now covers the label, because a renamed
  folder that cannot be found by the name on screen is worse than no rename.

---

### Task 45: `planProfile` compares folder names the way the filesystem does

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/profiles.ts` — lines 24-38 (imports and
  `pathKey`), lines 100-153 (`planProfile`'s branch block)
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts` — imports (lines 14-27)
  and a new block before the colour-contrast section (line 321)
- Test: `node scripts/verify-profiles.mts`

**Interfaces:**

*Consumes:* `pathRulesFor`, `pathKey` from `src/shared/paths.ts`; `sameFolderName`, `folderName`
from `src/shared/profiles.ts` (both unchanged).

*Produces:* `planProfile(rawFolder: string, rawName: string): Promise<ProfilePlan>` — signature
unchanged, two behaviours changed:
1. the chosen folder is recognised as already carrying the name whenever this OS would say so, not
   only on Windows;
2. a reused child is returned with the casing it actually has on disk.

- [ ] **Step 1: Extend the suite.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts`, add these imports beneath the
  existing block (after line 27):

  ```ts
  import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { pathRulesFor } from '../src/shared/paths.ts'
  import { planProfile } from '../src/main/profiles.ts'
  ```

  and insert this block immediately before the `console.log('\ncolour contrast')` line (line 321):

  ```ts
  console.log('\nplanProfile against real folders')
  /*
   * None of this logic had a test, and the bug it hides is a folder: on APFS,
   * `isDirectory('/Users/thevinh/dev/Work')` is true because `.../work` exists,
   * so planProfile answered `reuse` with a casing that is not on disk and the
   * app persisted it as a scan root (spec 2.5). The case-blindness of the
   * filesystem is the thing under test, so the expectations are computed from
   * pathRulesFor rather than hardcoded — on Linux the old answers are correct.
   */
  const CASE_BLIND = pathRulesFor(process.platform).caseInsensitive
  const box = mkdtempSync(join(tmpdir(), 'stoke-plan-'))
  try {
    mkdirSync(join(box, 'Work'))
    mkdirSync(join(box, 'Work', 'refinity'))
    mkdirSync(join(box, 'Work', 'buyback'))

    const differentCaseChild = await planProfile(box, 'work')
    check(
      'a child that exists in another case is reused, not nested inside itself',
      differentCaseChild.action,
      CASE_BLIND ? 'reuse' : 'create'
    )
    check(
      'and it is reported with the casing it has on disk',
      differentCaseChild.root,
      join(box, CASE_BLIND ? 'Work' : 'work')
    )
    check(
      'so the group is the real folder name',
      differentCaseChild.group,
      CASE_BLIND ? 'Work' : 'work'
    )
    const alreadyNamed = await planProfile(join(box, 'Work'), 'work')
    check(
      'a folder already carrying the name is used as it is, however it is cased',
      [alreadyNamed.action, alreadyNamed.root],
      CASE_BLIND
        ? ['reuse', join(box, 'Work')]
        : ['create', join(box, 'Work', 'work')]
    )

    const exact = await planProfile(box, 'Work')
    check(
      'an exact match still reuses, on every platform',
      [exact.action, exact.root],
      ['reuse', join(box, 'Work')]
    )
    check(
      'and reports what adopting it would import',
      exact.imports,
      ['buyback', 'refinity']
    )

    const fresh = await planProfile(box, 'Study')
    check(
      'a name nothing matches still creates the child',
      [fresh.action, fresh.root, fresh.willCreate, fresh.imports],
      ['create', join(box, 'Study'), true, []]
    )

    const missing = await planProfile(join(box, 'nope'), 'Work')
    check(
      'a folder that is not there is refused rather than planned',
      missing.error,
      `${join(box, 'nope')} is not a folder that exists.`
    )
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-profiles.mts`
  Expected on macOS, as the first new failing line:
  ```
    FAIL  and it is reported with the casing it has on disk
          got "/var/folders/.../stoke-plan-XXXX/work", want "/var/folders/.../stoke-plan-XXXX/Work"
  ```
  followed by `FAIL  a folder already carrying the name is used as it is, however it is cased`.

- [ ] **Step 3: Use this OS's own path rules.** In
  `/Users/thevinh/dev/personal/stoke/src/main/profiles.ts`, replace lines 24-38:

  ```ts
  import { statSync } from 'node:fs'
  import { mkdir, readdir } from 'node:fs/promises'
  import { join } from 'node:path'
  import type { ProfileConfig, Settings } from '@shared/types'
  import type { CreateProfileInput, ProfilePlan } from '../shared/profiles.ts'
  import { foldGroup, folderName, nextProfileId, sameFolderName } from '../shared/profiles.ts'

  const isWin = process.platform === 'win32'

  /** Native separators, and case-folded on Windows, for comparing two paths. */
  function pathKey(p: string): string {
    const native = isWin ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/')
    const trimmed = native.replace(/[\\/]+$/, '') || native
    return isWin ? trimmed.toLowerCase() : trimmed
  }
  ```

  with:

  ```ts
  import { statSync } from 'node:fs'
  import { mkdir, readdir } from 'node:fs/promises'
  import { join } from 'node:path'
  import type { ProfileConfig, Settings } from '@shared/types'
  import type { CreateProfileInput, ProfilePlan } from '../shared/profiles.ts'
  import { foldGroup, folderName, nextProfileId, sameFolderName } from '../shared/profiles.ts'
  import { pathKey as sharedPathKey, pathRulesFor } from '../shared/paths.ts'

  /*
   * This machine's own comparison rules.
   *
   * It used to be `process.platform === 'win32'`, and that is wrong on macOS:
   * APFS is case-insensitive by default, so `Work` and `work` are one folder and
   * a rule that says otherwise plans against a folder that is not there.
   */
  const RULES = pathRulesFor(process.platform)

  /** Native separators, and case-folded where the filesystem is. */
  function pathKey(p: string): string {
    return sharedPathKey(p, RULES)
  }
  ```

- [ ] **Step 4: Ask the directory for the real spelling.** In the same file, add this helper
  immediately after `isDirectory` (which currently ends at line 86):

  ```ts
  /**
   * The child of `dir` named `name`, as it is really spelled on disk, or null.
   *
   * `statSync` answers yes for a casing that is not the one on disk when the
   * filesystem is case-insensitive, and that wrong spelling was then persisted as
   * the profile's scan root — a path that works until something compares it as a
   * string. Reading the directory's own entries is the only way to get the name
   * the filesystem actually holds. `isDirectory` still does the final say-so, so
   * a symlink to a directory keeps counting as one.
   */
  async function existingChild(dir: string, name: string): Promise<string | null> {
    if (!RULES.caseInsensitive) {
      const exact = join(dir, name)
      return isDirectory(exact) ? exact : null
    }
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => n.toLowerCase() === name.toLowerCase())
    } catch {
      const exact = join(dir, name)
      return isDirectory(exact) ? exact : null
    }
    for (const n of names) {
      const full = join(dir, n)
      if (isDirectory(full)) return full
    }
    return null
  }
  ```

- [ ] **Step 5: Use both in the branch block.** In the same file, replace lines 142-153 — the block
  that currently reads:

  ```ts
    let action: ProfilePlan['action']
    let root: string
    if (sameFolderName(chosen, name, isWin)) {
      action = 'reuse'
      root = chosen
    } else if (isDirectory(child)) {
      action = 'reuse'
      root = child
    } else {
      action = 'create'
      root = child
    }
  ```

  with:

  ```ts
    let action: ProfilePlan['action']
    let root: string
    const existing = await existingChild(chosen, name)
    if (sameFolderName(chosen, name, RULES.caseInsensitive)) {
      action = 'reuse'
      root = chosen
    } else if (existing) {
      action = 'reuse'
      root = existing
    } else {
      action = 'create'
      root = child
    }
  ```

- [ ] **Step 6: Drop the now-unused binding.** In the same file, `const child = join(chosen, name)`
  (line 125) is still used by the `create` branch, so it stays. `noUnusedLocals` is on, so run
  `npm run typecheck` here — it exits 0. If it reports `'isWin' is declared but its value is never
  read`, delete whatever reference remains; `RULES` has replaced every use.

- [ ] **Step 7: Run it and watch it pass.**
  `node scripts/verify-profiles.mts` → `all pass`.

- [ ] **Step 8: Commit.**
  `git commit -m "Plan a profile's folder the way the filesystem spells it"`
  Body records the bug: `planProfile` compared folder names case-sensitively on every non-Windows
  platform, so on case-insensitive APFS `planProfile('/Users/thevinh/dev', 'Work')` returned
  `reuse` with root `/Users/thevinh/dev/Work` — a casing that does not exist — and the app persisted
  it as a scan root. `planProfile` had no test at all before this.

---

### Task 46: A default working directory that exists on this machine

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/workspaceRoots.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/workspace.ts` — lines 14-41
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts` — append a block
- Test: `node scripts/verify-folders.mts`

**Interfaces:**

*Consumes:* nothing new.

*Produces* — `src/main/workspaceRoots.ts`:
```ts
/** Candidate default directories, most preferred first, always ending in `home`. */
export function defaultCwdCandidates(platform: string, home: string): string[]
/** The first candidate that exists, unless an explicit setting names one that does. */
export function resolveDefaultCwd(configured: string | null, platform: string, home: string): string
```
`src/main/workspace.ts` keeps exporting `resolveDefaultCwd(configured: string | null): string`, so
`index.ts:508` is untouched.

- [ ] **Step 1: Extend the suite.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts`, add this import beneath the
  `projects.ts` import:

  ```ts
  import { defaultCwdCandidates, resolveDefaultCwd } from '../src/main/workspaceRoots.ts'
  ```

  and insert this block immediately before the two final lines of the file (the summary console.log and the process.exitCode assignment):

  ```ts
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
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-folders.mts`
  Expected:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/main/workspaceRoots.ts' imported from /Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts`

- [ ] **Step 3: Create the module.** Write
  `/Users/thevinh/dev/personal/stoke/src/main/workspaceRoots.ts`:

  ```ts
  /**
   * Where a session that is not tied to a saved project should run.
   *
   * Split out of workspace.ts, which imports electron for `app.getPath`, so this
   * can be driven by `node scripts/verify-folders.mts` with no app running. The
   * platform and the home folder are arguments for the same reason: the failure
   * this fixes is a list of folders that exist on one machine and no other, and a
   * function that reads `process.platform` can only ever be tested on the machine
   * it is already right for.
   */
  import { existsSync } from 'node:fs'

  /**
   * Most preferred first, always ending in `home` so there is always an answer.
   *
   * `~/Developer` leads on macOS because it is Apple's own convention and Xcode
   * gives it a folder icon; `~/dev`, `~/src` and `~/repos` are here because the
   * original list had none of them and this machine keeps everything in `~/dev`,
   * so every session with no project started in the home folder.
   *
   * Paths are joined with a separator taken from `platform`, NOT with
   * `node:path`'s `join`, which uses the separator of the machine it is running
   * on. Otherwise asking for the Windows list from a Mac returns
   * `C:\Users\v/Code`, and the one thing worth testing here — that a list written
   * for one machine is right on another — could not be tested at all.
   */
  export function defaultCwdCandidates(platform: string, home: string): string[] {
    const sep = platform === 'win32' ? '\\' : '/'
    const root = home.replace(/[\\/]+$/, '') || home
    const under = (...parts: string[]): string => [root, ...parts].join(sep)
    const out: string[] =
      platform === 'win32'
        ? // This machine keeps everything under G:\Code. Harmless when absent.
          ['G:\\Code', under('Code'), under('source', 'repos'), under('dev')]
        : [
            under('Developer'),
            under('Code'),
            under('code'),
            under('dev'),
            under('Projects'),
            under('src'),
            under('repos')
          ]
    out.push(root)
    // On a case-insensitive filesystem `~/Code` and `~/code` are one folder, and
    // offering it twice would have the first hit answer for both.
    return [...new Set(out)]
  }

  /** An explicit setting always wins, provided it is still there. */
  export function resolveDefaultCwd(
    configured: string | null,
    platform: string,
    home: string
  ): string {
    if (configured && existsSync(configured)) return configured
    for (const dir of defaultCwdCandidates(platform, home)) {
      if (existsSync(dir)) return dir
    }
    return home
  }
  ```

  Note the `home` argument is the last candidate, so the loop normally answers with it and the
  final `return home` is only reached when the home folder itself is gone.

- [ ] **Step 4: Point `workspace.ts` at it.** In
  `/Users/thevinh/dev/personal/stoke/src/main/workspace.ts`, replace lines 14-41 — everything from
  the `/** Candidate default directories …` comment through the closing brace of the existing
  `resolveDefaultCwd` — with:

  ```ts
  /** Where a no-project session should run. An explicit setting always wins. */
  export function resolveDefaultCwd(configured: string | null): string {
    return resolveCwd(configured, process.platform, homedir())
  }
  ```

  and change the imports at lines 1-4 to:

  ```ts
  import { app } from 'electron'
  import { existsSync, mkdirSync } from 'node:fs'
  import { homedir } from 'node:os'
  import { join } from 'node:path'
  import { resolveDefaultCwd as resolveCwd } from './workspaceRoots.ts'
  ```

- [ ] **Step 5: Run it and watch it pass.**
  `node scripts/verify-folders.mts` → `all pass`, and `npm run typecheck` exits 0. If typecheck
  reports `'existsSync' is declared but its value is never read`, `createScratchDir` still uses it
  at line 65 — leave the import alone and re-read the error.

- [ ] **Step 6: Confirm the real answer on this machine.**
  ```bash
  cat > /tmp/stoke-cwd-check.mts <<'EOF'
  import { homedir } from 'node:os'
  import { resolveDefaultCwd } from '/Users/thevinh/dev/personal/stoke/src/main/workspaceRoots.ts'
  console.log(resolveDefaultCwd(null, process.platform, homedir()))
  EOF
  node /tmp/stoke-cwd-check.mts
  ```
  Expected output: `/Users/thevinh/dev` — where it printed `/Users/thevinh` before this task.

- [ ] **Step 7: Commit.**
  `git commit -m "Offer a default folder that exists on a Mac"`
  Body records: `resolveDefaultCwd`'s candidate list named no folder present on this machine, so
  every session started without a project ran in the home folder; and the list moved out of
  `workspace.ts` because that file imports electron and nothing in it could be tested.

---

### Task 47: Repair this machine's scan root

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/scripts/repair-work-root.mjs`
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts` — append a block
- Test: `node scripts/repair-work-root.mjs` then `node scripts/verify-folders.mts`

**Interfaces:**

*Consumes:* `shouldWatch(cwd, projects, worklogGroups, roots?)` from `src/main/worklog/gate.ts`
(contracts Task 1 gave it the defaulted `roots` parameter); `hydrateSettings` from
`src/main/settingsSchema.ts` (contracts Task 3); `listProjects` (Task 41).

*Produces:* a repo script, not a module:
```
node scripts/repair-work-root.mjs            # report what it would do, change nothing
node scripts/repair-work-root.mjs --apply    # do it
```

- [ ] **Step 1: Write the repair, with its guard.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/repair-work-root.mjs`:

  ```js
  /*
   * One-off repair for the machine this app was built on, kept in the repo so it
   * is reviewable and re-runnable rather than a paragraph of shell in a chat log.
   *
   *   node scripts/repair-work-root.mjs            # report only
   *   node scripts/repair-work-root.mjs --apply    # make the changes
   *
   * What is wrong: `projectRoots` names /Users/thevinh/dev/work/Work, an empty
   * folder. A scan root enumerates its CHILDREN, so an empty root contributes no
   * projects at all — the Work profile covered nothing and the worklog had almost
   * nothing to watch. The right root is the parent, /Users/thevinh/dev/work,
   * whose children are the actual work repositories.
   *
   * Three refusals, because both halves of getting this wrong are silent:
   *  - Stoke must not be running. It holds settings in memory and rewrites the
   *    whole file on the next setSettings, so an edit made underneath it is
   *    discarded without a word.
   *  - the folder being deleted must be empty, checked by reading it, dotfiles
   *    included. `rmdir` then refuses a second time on its own account.
   *  - the replacement root must exist and be a directory.
   */
  import { execFileSync } from 'node:child_process'
  import {
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
  import { join } from 'node:path'

  const APPLY = process.argv.includes('--apply')
  const SETTINGS = join(homedir(), 'Library', 'Application Support', 'stoke', 'settings.json')
  const WRONG = '/Users/thevinh/dev/work/Work'
  const RIGHT = '/Users/thevinh/dev/work'

  function die(msg) {
    console.error(`\nREFUSED: ${msg}\n`)
    process.exit(1)
  }

  /* 1. Nothing may be holding the settings file. */
  let ps = ''
  try {
    ps = execFileSync('pgrep', ['-fl', 'Stoke'], { encoding: 'utf8' })
  } catch {
    ps = ''
  }
  const running = ps
    .split('\n')
    .filter((l) => l.trim() && !l.includes('repair-work-root'))
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
  const roots = Array.isArray(settings.projectRoots) ? settings.projectRoots : []
  const nextRoots = [...new Set(roots.map((r) => (r === WRONG ? RIGHT : r)))]

  console.log(`  projectRoots: ${JSON.stringify(roots)}`)
  console.log(`            ->  ${JSON.stringify(nextRoots)}`)

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply to make these changes.')
    process.exit(0)
  }

  /* Back up beside the file, then temp + rename, matching store.ts's own write. */
  copyFileSync(SETTINGS, `${SETTINGS}.before-repair`)
  settings.projectRoots = nextRoots
  const tmp = `${SETTINGS}.tmp`
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(tmp, SETTINGS)
  console.log(`  wrote ${SETTINGS} (backup at ${SETTINGS}.before-repair)`)

  /* rmdir, not rm -rf: it refuses a non-empty directory on its own account, so
     the emptiness check above has a second opinion that is not this script's. */
  if (removable) {
    rmdirSync(WRONG)
    console.log(`  removed ${WRONG}`)
  }

  console.log('\nDone.')
  ```

- [ ] **Step 2: Run the report and read it.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/repair-work-root.mjs`
  Expected output:
  ```
    /Users/thevinh/dev/work/Work is empty.
    projectRoots: ["/Users/thevinh/dev/work/Work"]
              ->  ["/Users/thevinh/dev/work"]

  Report only. Re-run with --apply to make these changes.
  ```
  If it prints `REFUSED: Stoke is running…`, quit Stoke and run it again. If it prints
  `REFUSED: … is not empty`, **stop** — the design's §6 assumption is wrong and the folder holds
  something; deal with the contents by hand before going on.

- [ ] **Step 3: Apply it.**
  `node scripts/repair-work-root.mjs --apply`
  Expected: the same first three lines, then `wrote …settings.json (backup at
  …settings.json.before-repair)`, `removed /Users/thevinh/dev/work/Work`, and `Done.`

- [ ] **Step 4: Add the standing assertion.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts`, replace the two node imports at
  the top —

  ```ts
  import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  ```

  — with:

  ```ts
  import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
  import { homedir, tmpdir } from 'node:os'
  ```

  add these two imports beneath the `workspaceRoots.ts` import:

  ```ts
  import { hydrateSettings } from '../src/main/settingsSchema.ts'
  import { shouldWatch } from '../src/main/worklog/gate.ts'
  ```

  and insert this block immediately before the two final lines of the file (the summary console.log and the process.exitCode assignment):

  ```ts
  /*
   * Machine-specific, and a no-op anywhere else. Design section 6 repairs this
   * machine's scan root; the point of the repair is that every folder under it
   * becomes watchable, so that is what is asserted rather than the value of a
   * settings key. Spec 2.4.3 measured 5 of 12 before.
   */
  const WORK_ROOT = '/Users/thevinh/dev/work'
  const REAL_SETTINGS = join(
    homedir(),
    'Library',
    'Application Support',
    'stoke',
    'settings.json'
  )
  if (process.platform === 'darwin' && existsSync(WORK_ROOT) && existsSync(REAL_SETTINGS)) {
    console.log('\nthis machine’s work root (design section 6)')
    const real = hydrateSettings(JSON.parse(readFileSync(REAL_SETTINGS, 'utf8')))
    check('the work folder is the scan root, not its empty child', real.projectRoots, [WORK_ROOT])
    check('the worklog writes to Notion only', real.worklogBoards.targets, ['notion'])

    const realProjects = await listProjects(real)
    const children = readdirSync(WORK_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => join(WORK_ROOT, e.name))
    const unwatched = children.filter(
      (c) => !shouldWatch(c, realProjects, real.worklogGroups, real.projectRoots)
    )
    console.log(`  (${children.length - unwatched.length} of ${children.length} watched)`)
    check('every folder under the work root is watched', unwatched, [])
  }
  ```

- [ ] **Step 5: Run it and watch it pass.**
  `node scripts/verify-folders.mts`
  Expected: a `this machine's work root (design section 6)` section whose parenthesised line reads
  `(N of N watched)` with the two numbers equal, then `all pass`.

  If `every folder under the work root is watched` fails, the cause is one of two things and the
  printed `got` array names which folders: either `projectRoots` was not repointed (re-run Step 3),
  or `index.ts` is not yet passing `getSettings().projectRoots` into the gate — that call-site
  change belongs to workstream C and this assertion calls `shouldWatch` directly, so it is
  independent of it.

- [ ] **Step 6: Run the whole check.** `npm run check` exits 0.

- [ ] **Step 7: Commit.**
  `git commit -m "Repair the scan root that pointed at an empty folder"`
  Body records: `projectRoots` named `/Users/thevinh/dev/work/Work`, an empty directory a
  case-sensitive folder comparison on APFS could produce (fixed in the previous task); a scan root
  enumerates its children, so an empty one contributed nothing and 7 of the 12 work folders were
  never watched by the worklog. The repair is kept as a script with three refusals rather than run
  by hand, and `verify:folders` now asserts the outcome on this machine so it cannot quietly come
  back.
