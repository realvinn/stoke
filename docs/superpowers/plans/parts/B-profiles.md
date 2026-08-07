## Workstream B — profiles follow tabs

Spec §4 B, plus §2.9. Seven tasks, 60–66.

**Prerequisites.** Tasks 1, 2 and 3 of the contracts section must be finished first:
Task 1 creates `src/shared/paths.ts` and rewrites `src/main/worklog/gate.ts` over it, Task 2 adds
`Tab.hostId` and the new `Project` fields, and Task 3 extracts `hydrateSettings` into
`src/main/settingsSchema.ts` and creates `scripts/verify-settings.mts`. Every task below edits or
imports one of those files.

**Why this order.**

- **Task 60 first, and it is not optional.** Contracts Task 1 leaves `src/shared/profiles.ts`
  re-exporting `foldGroup` from `./paths` — the first *value* import between two shared modules
  this repo has ever had. Extensionless, that specifier does not resolve under
  `node --experimental-strip-types`, so `node scripts/verify-profiles.mts` dies at import time;
  with the `.ts` extension it does resolve, but `tsc -p tsconfig.web.json` rejects it with TS5097
  because that project does not set `allowImportingTsExtensions`. Both were measured, not reasoned
  (see the task). Every later task in this workstream extends `verify-profiles.mts`, so nothing
  else can be verified until this is settled.
- **Task 61** puts the cwd→group→profile rule in `src/shared/paths.ts`, next to `groupForCwd`,
  where a plain node suite can exercise it. That is the decision in the shared contracts —
  share, not IPC — and it keeps `gate.ts`'s property that the rule is pure and testable with no
  app running.
- **Task 62** repairs `activeProfile` in hydrate. It comes before the writer, because the writer
  makes `activeProfile` change far more often than a person ever clicked it.
- **Task 63** fixes `deriveProfiles`. It must land before the wiring or the wiring looks broken on
  a fresh machine: measured against the live `~/.claude.json`, the derived list on this Mac is
  `['personal']` and nothing else — so activating a tab under `/Users/thevinh/dev/work` resolves
  group `work`, finds no profile covering it, and correctly does nothing at all.
- **Task 64** pins the gate's invariant *before* Task 65 introduces the coupling. `grep -rn
  activeProfile src/main/` returns exactly one hit today; after this workstream the chip moves by
  itself, and the one thing that must never start reading it is the worklog.
- **Task 65** wires it: activating a tab sets the profile.
- **Task 66** makes the switch legible. Measured: Ember's accent and Personal's are the same
  string, and Moss's accent sits 0.049 from Work's — closer than the palette's own two nearest
  swatches (0.083). So the accent cannot carry the signal on its own, and the status bar names the
  active profile instead.

---

### Task 60: Let one shared module import another without breaking the verify suites

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/profiles.ts` — the `foldGroup` re-export
  contracts Task 1 leaves around line 206.
- Modify: `/Users/thevinh/dev/personal/stoke/tsconfig.web.json` — `compilerOptions`.
- Modify: `/Users/thevinh/dev/personal/stoke/tsconfig.json` — `compilerOptions`, for editor parity.
- Test: `node scripts/verify-profiles.mts` (existing, unchanged) and `npm run typecheck`.

**Interfaces:**
- Consumes: `foldGroup` and the rest of `src/shared/paths.ts`, created by contracts Task 1.
- Produces: no new exports. It produces the *ability* for `src/shared/**` to value-import
  `src/shared/**` — used by nothing else in this workstream, and by anything later that needs it.

- [ ] **Step 1: Run the profiles suite and watch it fail.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts
  ```

  Expected:

  ```
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/shared/paths' imported from /Users/thevinh/dev/personal/stoke/src/shared/profiles.ts
  ```

  If instead the suite prints `all pass`, contracts Task 1 already wrote the specifier as
  `'./paths.ts'`. Skip Step 2 and go straight to Step 3, which is where that form fails.

- [ ] **Step 2: Give the re-export its extension.** In
  `/Users/thevinh/dev/personal/stoke/src/shared/profiles.ts`, replace

  ```ts
  export { foldGroup } from './paths'
  ```

  with

  ```ts
  /*
   * Relative with an explicit `.ts`, even though this is a shared module and the
   * rest of them import extensionlessly. Extensionless works only for type-only
   * imports, which are erased — this is a value re-export, and
   * `node scripts/verify-profiles.mts` loads this file directly under
   * --experimental-strip-types, where './paths' resolves to nothing. Both
   * tsconfigs allow the extension; see allowImportingTsExtensions.
   */
  export { foldGroup } from './paths.ts'
  ```

- [ ] **Step 3: Run the typecheck and watch it fail.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck
  ```

  Expected: `tsconfig.node.json` passes, then a line naming `src/shared/profiles.ts` and ending

  ```
  error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.
  ```

  (`tsconfig.node.json` already sets the flag — that is the precedent recorded at
  `src/main/mcp/design.ts:11-16`. `tsconfig.web.json` does not, and it compiles `src/shared/**`.)

- [ ] **Step 4: Turn the flag on in the web project.** In
  `/Users/thevinh/dev/personal/stoke/tsconfig.web.json`, replace

  ```json
    "isolatedModules": true,
  ```

  with

  ```json
    "isolatedModules": true,
    // A shared module that value-imports another shared module has to carry the
    // .ts extension: those files are also executed directly by node's
    // strip-types mode from the verify suites, where an extensionless relative
    // specifier resolves to nothing. Vite resolves the extension the same way.
    // Legal because this project is noEmit.
    "allowImportingTsExtensions": true,
  ```

- [ ] **Step 5: Do the same in the root config, so the editor agrees.** In
  `/Users/thevinh/dev/personal/stoke/tsconfig.json`, replace

  ```json
    "isolatedModules": true,
  ```

  with

  ```json
    "isolatedModules": true,
    // Matches tsconfig.web.json — this file is what an editor loads, and without
    // it every shared .ts import is underlined in red while both real projects
    // compile cleanly.
    "allowImportingTsExtensions": true,
  ```

- [ ] **Step 6: Run both and watch them pass.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts && npm run typecheck
  ```

  Expected: `all pass` from the suite, then `npm run typecheck` exits 0 with no output.

- [ ] **Step 7: Prove the bundlers still resolve it.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```

  Expected: exit 0. The renderer bundle contains `foldGroup` by way of `paths.ts`; a resolution
  failure here would be a Vite error naming `src/shared/profiles.ts`, not a silent one.

- [ ] **Step 8: Commit.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add -A && git commit -m "Let a shared module import a shared module without killing a verify suite

The path rule moved into src/shared/paths.ts and profiles.ts re-exports
foldGroup from it — the first value import between two shared modules. That
combination had no working spelling: extensionless, node's strip-types mode
cannot resolve it and verify-profiles.mts dies at import time with
ERR_MODULE_NOT_FOUND; with the .ts extension, tsconfig.web.json rejects it with
TS5097 because only tsconfig.node.json had allowImportingTsExtensions. The web
and root projects now set it too, which is what src/main has always relied on."
  ```

---

### Task 61: Resolve a working directory to a profile, in a module both processes can use

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/paths.ts` — append `GroupOwner` and
  `profileIdForCwd` after `groupForCwd`.
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/projectProfile.ts`.
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts` — new imports and a new
  block.

**Interfaces:**
- Consumes, all from `src/shared/paths.ts` (contracts Task 1):
  `groupForCwd(cwd: string, projects: Project[], rules: PathRules, roots?: string[]): string | null`,
  `pathRulesFor(platform: string): PathRules`,
  `foldGroup(value: string): string`.
- Consumes `Project` from `src/shared/types.ts`, with the `emoji` / `label` / `addedManually`
  fields contracts Task 2 adds.
- Produces, in `src/shared/paths.ts`:
  ```ts
  export interface GroupOwner {
    id: string
    groups: string[]
  }
  export function profileIdForCwd(
    cwd: string,
    projects: Project[],
    roots: string[],
    profiles: GroupOwner[],
    platform: string
  ): string | null
  ```
- Produces, in `src/renderer/src/lib/projectProfile.ts`: re-exports of `profileIdForCwd` and
  `profileFor`. This is the import site the shared contracts named; the body lives in
  `paths.ts` so a plain node suite can reach it.

- [ ] **Step 1: Add the failing cases.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts`, replace line 14

  ```ts
  import type { ProfileConfig } from '../src/shared/types.ts'
  ```

  with

  ```ts
  import type { ProfileConfig, Project } from '../src/shared/types.ts'
  import { profileIdForCwd } from '../src/shared/paths.ts'
  ```

  Then insert this block immediately before the final
  `console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)` line:

  ```ts
  console.log('\na working directory resolves to a profile')
  /*
   * The renderer needs this to point the chip at whatever tab is in front, and
   * duplicating the longest-prefix rule there is exactly what the design
   * forbids. It lives in shared/paths.ts beside groupForCwd, takes the
   * platform's rules as an argument rather than reading `process`, and is
   * therefore the same function in both processes — and testable here.
   *
   * POSIX paths and an explicit 'darwin' throughout, so these cases mean the
   * same thing whichever machine runs the suite.
   */
  const proj = (path: string, group: string): Project => ({
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    group,
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
  })

  const MAC = 'darwin'
  /* `/Users/v/dev/work` is both a scan root and — because a session was once
     started in it — a registered project whose own group is `dev`. That is the
     shape that made 7 of 12 work folders unwatched. */
  const macProjects: Project[] = [
    proj('/Users/v/dev/personal/stoke', 'personal'),
    proj('/Users/v/dev/work/buyback', 'work'),
    proj('/Users/v/dev/work', 'dev')
  ]
  const macRoots = ['/Users/v/dev/work']
  const macProfiles = [
    { id: 'personal', groups: ['personal'] },
    { id: 'Work', groups: ['work'] }
  ]

  check(
    'a tab in a project resolves to the profile covering its group',
    profileIdForCwd('/Users/v/dev/personal/stoke', macProjects, macRoots, macProfiles, MAC),
    'personal'
  )
  check(
    'a cwd a level down inside it resolves the same',
    profileIdForCwd('/Users/v/dev/personal/stoke/src/main', macProjects, macRoots, macProfiles, MAC),
    'personal'
  )
  check(
    'the profile id is returned, not the folder name',
    profileIdForCwd('/Users/v/dev/work/buyback', macProjects, macRoots, macProfiles, MAC),
    'Work'
  )
  check(
    'a folder under a scan root with no history of its own still resolves',
    profileIdForCwd('/Users/v/dev/work/postable', macProjects, macRoots, macProfiles, MAC),
    'Work'
  )
  check(
    'APFS case is folded, so a differently-cased path is the same path',
    profileIdForCwd('/Users/V/DEV/Work/Buyback', macProjects, macRoots, macProfiles, MAC),
    'Work'
  )
  check(
    'a group no profile covers resolves to nothing — the chip is left alone',
    profileIdForCwd('/Users/v/dev/personal/stoke', macProjects, macRoots, [macProfiles[1]], MAC),
    null
  )
  check(
    'an ssh alias is not a path, so it resolves to nothing',
    profileIdForCwd('vps-syd', macProjects, macRoots, macProfiles, MAC),
    null
  )
  check(
    'an empty cwd resolves to nothing rather than the first project',
    profileIdForCwd('', macProjects, macRoots, macProfiles, MAC),
    null
  )
  check(
    'a profile covering several groups matches on any of them',
    profileIdForCwd(
      '/Users/v/dev/personal/stoke',
      macProjects,
      macRoots,
      [{ id: 'Everything', groups: ['work', 'personal'] }],
      MAC
    ),
    'Everything'
  )
  check(
    'and windows paths resolve under the windows rules',
    profileIdForCwd(
      'G:\\Code\\gitea-company\\refinity',
      [proj('G:\\Code\\gitea-company\\refinity', 'gitea-company')],
      [],
      [{ id: 'gitea-company', groups: ['gitea-company'] }],
      'win32'
    ),
    'gitea-company'
  )
  ```

- [ ] **Step 2: Run it and watch it fail.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts
  ```

  Expected:

  ```
  SyntaxError: The requested module '../src/shared/paths.ts' does not provide an export named 'profileIdForCwd'
  ```

- [ ] **Step 3: Implement it.** Append to
  `/Users/thevinh/dev/personal/stoke/src/shared/paths.ts`, after `groupForCwd`:

  ```ts
  /**
   * The two fields of a profile this rule needs.
   *
   * Structural rather than an import of `ResolvedProfile`, so paths.ts stays a
   * leaf: profiles.ts already imports this module, and a type-only import back
   * would be erased at runtime but would still read as a cycle to anyone
   * following the file.
   */
  export interface GroupOwner {
    id: string
    groups: string[]
  }

  /**
   * Which profile owns the work in `cwd`, or null.
   *
   * Null means **leave the chip where it is**, not "select nothing". A tab whose
   * folder belongs to no profile must not clear whatever the user is looking at.
   *
   * Never call this for an SSH tab. `ssh -t <alias>` runs claude on the far
   * machine, so the tab's `cwd` holds the host alias rather than a folder — see
   * CLAUDE.md gotcha 18 — and resolving it would name whichever local project
   * happened to share that word. `Tab.hostId` is the signal that it is one.
   *
   * `roots` is the scan-root list, passed through to `groupForCwd` so a folder
   * that has no Claude history of its own still resolves through the root that
   * contains it.
   */
  export function profileIdForCwd(
    cwd: string,
    projects: Project[],
    roots: string[],
    profiles: GroupOwner[],
    platform: string
  ): string | null {
    const group = groupForCwd(cwd, projects, pathRulesFor(platform), roots)
    if (!group) return null
    const key = foldGroup(group)
    const owner = profiles.find((p) => p.groups.some((g) => foldGroup(g) === key))
    return owner ? owner.id : null
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts
  ```

  Expected: the ten new lines all read `PASS`, and the suite ends `all pass`.

- [ ] **Step 5: Give the renderer its import site.** Create
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/projectProfile.ts`:

  ```ts
  /**
   * cwd → group → profile, for the renderer.
   *
   * A face over `@shared/paths`, not a second implementation: the sidebar chip
   * and the worklog gate must not be able to disagree about which folder belongs
   * to which group, and duplicating the longest-prefix rule here is how they
   * would start to.
   *
   * The body lives in `src/shared/paths.ts` rather than in this file because
   * this file resolves `@shared/*`, an alias only Vite and tsc understand — a
   * plain `node scripts/verify-*.mts` cannot load it, and an untested path rule
   * is how the gate got its longest-prefix bug in the first place.
   *
   * Pass `window.stoke.platform` as `platform`.
   */
  export { profileIdForCwd, type GroupOwner } from '@shared/paths'
  export { profileFor } from '@shared/profiles'
  ```

- [ ] **Step 6: Typecheck.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck
  ```

  Expected: exit 0, no output.

- [ ] **Step 7: Commit.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add -A && git commit -m "Make cwd -> group -> profile answerable from the renderer

Tabs carry no profile identity; it is derivable only from cwd, and the helper
that did so lived in the main process, so App.tsx had no way to ask. The rule
now sits in src/shared/paths.ts next to groupForCwd, takes the platform's
comparison rules as an argument rather than reading process.platform, and is
exercised by verify:profiles — including the case that a folder under a scan
root with no Claude history of its own still resolves, and that an ssh alias
resolves to nothing at all."
  ```

---

### Task 62: Repair `activeProfile` in hydrate

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/settingsSchema.ts` — the object
  `hydrateSettings` returns (contracts Task 3 moved it here out of `store.ts:84-130`).
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-settings.mts` — new block.

**Interfaces:**
- Consumes: `hydrateSettings(raw: unknown): Settings` and `DEFAULT_SETTINGS: Settings` from
  `src/main/settingsSchema.ts` (contracts Task 3).
- Produces: no new exports. `hydrateSettings` gains one repaired key, `activeProfile`.

- [ ] **Step 1: Add the failing cases.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-settings.mts`, insert this block immediately
  before the final `console.log(`\n${failures ? ... }`)` line:

  ```ts
  console.log('\nthe active profile chip')
  /*
   * hydrate validated every other structured field and passed this one straight
   * through, back when the only thing that ever wrote it was a click on a chip.
   * The tab strip writes it now, so a value that is not a profile id has to be
   * repaired rather than handed to profileFor.
   */
  check('a number is not a profile id', hydrateSettings({ activeProfile: 7 }).activeProfile, null)
  check(
    'nor is an object that merely contains one',
    hydrateSettings({ activeProfile: { id: 'Work' } }).activeProfile,
    null
  )
  check(
    'an empty string is no selection, not a profile named ""',
    hydrateSettings({ activeProfile: '   ' }).activeProfile,
    null
  )
  check('a real id survives, trimmed', hydrateSettings({ activeProfile: ' Work ' }).activeProfile, 'Work')
  /*
   * Deliberately kept: a profile can legitimately belong to another machine, and
   * resolveProfiles keeps those records for the same reason. App resolves the id
   * against the visible list every render and shows no filter when it misses, so
   * an unknown id costs nothing — while dropping it would silently rewrite the
   * Windows selection the first time the Mac saved anything.
   */
  check(
    'an id with no profile behind it is kept, because the profile may be on another machine',
    hydrateSettings({ activeProfile: 'gitea-vibe' }).activeProfile,
    'gitea-vibe'
  )
  check('and an untouched machine has no selection', hydrateSettings({}).activeProfile, null)
  ```

- [ ] **Step 2: Run it and watch it fail.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-settings.mts
  ```

  Expected, as the first new failure:

  ```
    FAIL  a number is not a profile id
          got 7, want null
  ```

- [ ] **Step 3: Repair it.** In
  `/Users/thevinh/dev/personal/stoke/src/main/settingsSchema.ts`, inside the object literal
  `hydrateSettings` returns, immediately after the `profiles:` entry, add:

  ```ts
    /*
     * A view filter, and now one the tab strip writes on every activation — so
     * it is repaired like every other structured field rather than trusted. An
     * id that matches no profile is deliberately kept: profileFor resolves it
     * against the visible list each render and yields no filter when it misses,
     * and a record can legitimately live on another machine.
     */
    activeProfile:
      typeof r.activeProfile === 'string' && r.activeProfile.trim() !== ''
        ? r.activeProfile.trim()
        : null,
  ```

- [ ] **Step 4: Run it and watch it pass.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-settings.mts
  ```

  Expected: the seven new lines read `PASS`, and the suite ends `all pass`.

- [ ] **Step 5: Commit.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add -A && git commit -m "Repair activeProfile in hydrate like every other structured field

hydrate validated customThemes, profiles, hosts, worklogGroups and the rest and
passed activeProfile through untouched, so a hand-edited settings.json could put
a number or an object where an id belongs. That was survivable while the only
writer was a click on a chip; the tab strip writes it on every activation now.
An id matching no profile is still kept on purpose — profileFor already renders
that as no filter, and dropping it would erase another machine's selection."
  ```

---

### Task 63: Stop the named profiles from suppressing everything else

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/profiles.ts:263-280` — `deriveProfiles`.
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts` — one existing case
  rewritten (lines 69-73), one fixture narrowed (line 133), one new block.

**Interfaces:**
- Consumes: `PROFILES`, `FALLBACK`, `titleCase`, `foldGroup` — all already in
  `src/shared/profiles.ts`.
- Produces: `deriveProfiles(counts: Map<string, number>): Profile[]` — unchanged signature,
  changed result. It now returns the named seeds *plus* folder-derived ones, instead of returning
  early with the named seeds alone.

- [ ] **Step 1: Rewrite the case that encodes the bug.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts`, replace lines 69-73:

  ```ts
  check(
    'named folders are recognised, stray ones ignored',
    ids({ personal: 6, school: 3, 'gitea-company': 3, Documents: 2, WINDOWS: 1 }),
    ['personal', 'school', 'gitea-company']
  )
  ```

  with:

  ```ts
  check(
    'named folders no longer swallow the rest of the machine',
    ids({ personal: 6, school: 3, 'gitea-company': 3, Documents: 2, WINDOWS: 1 }),
    ['personal', 'school', 'gitea-company', 'Documents']
  )
  ```

- [ ] **Step 2: Narrow the fixture the frozen lock uses.** Still in
  `verify-profiles.mts`, replace line 133:

  ```ts
  const namedMachine = counts({ personal: 6, school: 3, 'gitea-company': 3, Documents: 2 })
  ```

  with:

  ```ts
  /* No stray folder in here: this fixture backs the frozen LEGACY_NAMED lock and
     the deletion cases below, all of which are about the named seeds themselves.
     The folder-derived half of the list has its own block above. */
  const namedMachine = counts({ personal: 6, school: 3, 'gitea-company': 3 })
  ```

- [ ] **Step 3: Add the new block.** Insert immediately after the
  `console.log('\none profile is still a choice')` case (the `ids({ Code: 4 })` check, around line
  97):

  ```ts
  console.log('\nnamed folders no longer suppress the rest of the machine')
  /*
   * The early return was `if (known.length) return known`. Measured against the
   * live ~/.claude.json on this Mac: `personal` is the only folder matching a
   * named profile, so the derived list was exactly ['personal'] — the
   * five-project `work` folder, which is the entire reason profiles exist here,
   * could never be seeded, and neither could anything else. A user-made record
   * was the only way to get a second chip, which is why one exists in settings.
   */
  check(
    'a folder holding real work beside the named ones is seeded too',
    ids({ personal: 8, work: 5, dev: 3, Documents: 1 }),
    ['personal', 'work', 'dev']
  )
  check(
    'this machine, measured: work, dev, scratch and Codes were all invisible',
    ids({ personal: 8, work: 5, dev: 3, scratch: 3, Codes: 2 }),
    ['personal', 'work', 'dev', 'scratch', 'Codes']
  )
  check(
    'the named ones still come first, in their own order',
    labels({ clients: 9, personal: 1, school: 2 }),
    ['Personal', 'Study', 'Clients']
  )
  check(
    'extras wear the fallback colours, which no named seed wears',
    deriveProfiles(counts({ personal: 6, work: 5, side: 2 })).map((p) => p.accent),
    ['#ff9552', '#6ea8fe', '#f7c948']
  )
  /* `gitea-company` is labelled Work. A folder literally called `work` beside it
     would put two chips reading Work in one row, and the chip is the only thing
     the user sees — so the named profile's label claims that name too. */
  check(
    'a folder a named profile already speaks for is not seeded twice',
    ids({ 'gitea-company': 3, work: 2 }),
    ['gitea-company']
  )
  check('nor is one folder in two spellings', ids({ Work: 5, work: 2 }), ['Work'])
  check(
    'a stray with one project is still not a category of work',
    ids({ personal: 6, Downloads: 1 }),
    ['personal']
  )
  check(
    'at most four extras are seeded, so the chip row cannot run away',
    ids({ personal: 2, a: 9, b: 8, c: 7, d: 6, e: 5 }),
    ['personal', 'a', 'b', 'c', 'd']
  )
  ```

- [ ] **Step 4: Run it and watch it fail.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts
  ```

  Expected, as the first failure:

  ```
    FAIL  named folders no longer swallow the rest of the machine
          got ["personal","school","gitea-company"], want ["personal","school","gitea-company","Documents"]
  ```

- [ ] **Step 5: Merge the two halves.** In
  `/Users/thevinh/dev/personal/stoke/src/shared/profiles.ts`, replace the body of
  `deriveProfiles` (lines 263-280) — keep the doc comment above it, and add the paragraph shown —
  with:

  ```ts
  export function deriveProfiles(counts: Map<string, number>): Profile[] {
    const folded = new Set([...counts.keys()].map(foldGroup))
    const known = PROFILES.filter((p) => folded.has(foldGroup(p.id)))

    /*
     * What the named profiles already speak for: their ids, and their labels.
     * The labels matter — `gitea-company` is labelled Work, so a folder called
     * `work` sitting beside it would produce two chips reading Work, and the
     * chip is all the user sees.
     */
    const claimed = new Set<string>()
    for (const p of known) {
      claimed.add(foldGroup(p.id))
      claimed.add(foldGroup(p.label))
    }

    const extras: Profile[] = []
    const candidates = [...counts.entries()]
      .filter(([id, n]) => id.trim() !== '' && n > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

    for (const [id] of candidates) {
      if (extras.length >= FALLBACK.length) break
      const key = foldGroup(id)
      if (claimed.has(key) || claimed.has(foldGroup(titleCase(id)))) continue
      claimed.add(key)
      const c = FALLBACK[extras.length]
      extras.push({
        id,
        label: titleCase(id),
        accent: c.accent,
        accentHover: c.accentHover,
        accentSoft: c.accentSoft,
        accentContrast: c.accentContrast
      })
    }

    return [...known, ...extras]
  }
  ```

  And add this paragraph to the end of the doc comment above it, replacing the two sentences that
  begin "This is only a **seed**." — keep the rest of the comment as it stands:

  ```
   * This is only a **seed**, and it used to be less than that: with any named
   * folder present it returned the named list and stopped, so on a machine whose
   * only named folder is `personal` the whole of `work` had no chip and there
   * was no route to one except making a record by hand. The two halves are
   * merged now — named first in their own order, then whatever else holds more
   * than one project, capped at the four fallback colours. User records are
   * still layered on top by `resolveProfiles` rather than fighting for a place
   * in here.
  ```

- [ ] **Step 6: Run it and watch it pass.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts && npm run typecheck
  ```

  Expected: `all pass` — including the unchanged contrast block at the end, where the four derived
  profiles A–D must still each clear 4.5:1 — then a clean typecheck.

- [ ] **Step 7: Commit.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add -A && git commit -m "Seed a profile for every folder holding work, not only the named four

deriveProfiles early-returned the hardcoded list the moment one named folder
matched, so the folder-derived fallback was unreachable on any machine that had
even one of them. Measured against the live ~/.claude.json: personal was the
only match here, so work (5 projects), dev, scratch and Codes had no chip and no
way to get one except a hand-made record. The lists are merged now, named first;
a folder a named profile already speaks for by id or by label is not seeded
twice, so gitea-company's Work label cannot be joined by a second Work chip."
  ```

---

### Task 64: Pin the invariant that nothing in main reads the chip

**Files:**
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts` — two node imports and a
  new block. No source file changes.

**Interfaces:**
- Consumes: `readdirSync`, `readFileSync` from `node:fs`; `fileURLToPath` from `node:url`;
  `join` from `node:path`.
- Produces: nothing importable. It produces a failing suite the moment a main-process file starts
  reading `activeProfile`.

- [ ] **Step 1: Add the check, at its strictest.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts`, add these imports at the top,
  after the existing `import ... from '../src/shared/paths.ts'` line:

  ```ts
  import { readdirSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { fileURLToPath } from 'node:url'
  ```

  and insert this block immediately before the final
  `console.log(`\n${failures ? ... }`)` line:

  ```ts
  console.log('\nthe chip stays out of the main process')
  /*
   * The worklog gate is keyed on a session's own folder and never on the sidebar
   * selection — gate.ts's header is three paragraphs on why, and both failures
   * are silent. Making the chip follow the active tab is only safe because
   * nothing over there reads it, so that is asserted rather than remembered.
   *
   * A source scan, not a type: the coupling this guards against is one `import
   * { getSettings }` away and would typecheck perfectly.
   */
  const MAIN = fileURLToPath(new URL('../src/main/', import.meta.url))

  function tsFilesUnder(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...tsFilesUnder(full))
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  const mentionsChip = tsFilesUnder(MAIN)
    .filter((f) => readFileSync(f, 'utf8').includes('activeProfile'))
    .map((f) => f.slice(MAIN.length).split('\\').join('/'))

  check('nothing in the main process mentions the chip at all', mentionsChip, [])
  ```

- [ ] **Step 2: Run it and watch it fail — which is what proves the scan reads anything.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts
  ```

  Expected:

  ```
    FAIL  nothing in the main process mentions the chip at all
          got ["settingsSchema.ts"], want []
  ```

  That one file is the settings schema: it declares the default and, since Task 62, repairs the
  value. If the list contains anything else, stop — something already reads the selection in the
  main process and the rest of this workstream is not safe to build on it.

- [ ] **Step 3: Narrow it to the real invariant.** Replace the single `check(...)` line added in
  Step 1 with:

  ```ts
  /*
   * The two files that may name it: one declares the default and repairs the
   * stored value, the other persists what it is given. Neither decides anything
   * with it. Adding a third is a deliberate act — read gate.ts's header first.
   */
  const SETTINGS_FILES = ['settingsSchema.ts', 'store.ts']
  check(
    'only the settings files name it, and they only store it',
    mentionsChip.filter((f) => !SETTINGS_FILES.includes(f)),
    []
  )
  check(
    'the worklog in particular never sees it',
    mentionsChip.filter((f) => f.startsWith('worklog/')),
    []
  )
  ```

- [ ] **Step 4: Run it and watch it pass.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts
  ```

  Expected: both new lines read `PASS`, and the suite ends `all pass`.

- [ ] **Step 5: Commit.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add -A && git commit -m "Assert that the main process cannot read the sidebar chip

Auto-switching the chip from the active tab is safe for exactly one reason:
grep -rn activeProfile src/main/ returns only the settings schema, so the
worklog gate's rule — watching is keyed on a session's own cwd and never on the
sidebar selection — cannot be disturbed by it. That was a fact about today's
tree, held only in a design note. It is a suite failure now, and the failure
names the file that broke it."
  ```

---

### Task 65: The active tab decides the profile

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — the `@shared/profiles`
  import (line 15), one new import, and one new effect after the `activeProfile` memo (around
  lines 231-238).
- Test: a CDP measurement against the running app. There is no DOM test runner; per CLAUDE.md the
  app is launched with `--remote-debugging-port` and driven over CDP.

**Interfaces:**
- Consumes: `profileIdForCwd(cwd, projects, roots, profiles, platform)` from
  `./lib/projectProfile` (Task 61); `foldGroup(value: string): string` from `@shared/profiles`;
  `Tab.hostId: string | null` (contracts Task 2); the existing `patchSettings`,
  `availableProfiles`, `projects`, `projectsLoading`, `settings`, `tabs`, `activeTabId`,
  `platform` locals in `App.tsx`.
- Produces: no new exports. `settings.activeProfile` gains a second writer.

- [ ] **Step 1: Build and launch with the debugger open.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && npx electron . --remote-debugging-port=9222
  ```

  Leave it running. An unpackaged run uses its own `stoke (dev)` userData (`index.ts:839-841`), so
  nothing measured here touches the installed app's settings.

- [ ] **Step 2: Write the throwaway CDP probe.** Create `/tmp/stoke-cdp.mjs` — a scratch tool, not
  repo code, and not to be committed:

  ```js
  /* Evaluate one expression in Stoke's own renderer and print the result.
     Usage: node /tmp/stoke-cdp.mjs "document.title"
     The docked browser is its own CDP target (CLAUDE.md gotcha 6), so the target
     is chosen by URL and never by type === 'page'. */
  import WebSocket from '/Users/thevinh/dev/personal/stoke/node_modules/ws/index.js'

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
  const page = targets.find((t) => t.url.includes('/out/renderer/'))
  if (!page) {
    console.error('no renderer target; is the app running with --remote-debugging-port=9222?')
    process.exit(1)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.once('open', r))
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: process.argv[2], returnByValue: true, awaitPromise: true }
    })
  )
  ws.on('message', (m) => {
    const res = JSON.parse(m.toString()).result
    console.log(JSON.stringify(res?.result?.value ?? res?.exceptionDetails?.text ?? null))
    ws.close()
  })
  ```

- [ ] **Step 3: Measure the defect.** In the running app, start two sessions in two different
  groups — in the sidebar, open `/Users/thevinh/dev/personal/stoke` and press Start, then open a
  folder under `/Users/thevinh/dev/work` and press Start. Click the first tab, then run:

  ```bash
  node /tmp/stoke-cdp.mjs "document.querySelector('.profile-chip[aria-pressed=\"true\"]')?.textContent ?? 'none'"
  ```

  Click the second tab and run it again. Expected **both times**: the same value — whatever chip
  was pressed before you started, `"All"` on a machine that has never picked one. That is the
  defect: `App.tsx:719` is the only writer, and it is the chip itself.

- [ ] **Step 4: Import the resolver.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, change line 15 from

  ```tsx
  import { profileFor, resolveProfiles, visibleProfiles } from '@shared/profiles'
  ```

  to

  ```tsx
  import { foldGroup, profileFor, resolveProfiles, visibleProfiles } from '@shared/profiles'
  ```

  and add, immediately after the existing `import { matchShortcut } from './lib/shortcuts'` line:

  ```tsx
  import { profileIdForCwd } from './lib/projectProfile'
  ```

- [ ] **Step 5: Add the writer.** Still in `App.tsx`, immediately after the
  `useEffect(() => { applyAppearance(theme, activeProfile) }, [theme, activeProfile])` block
  (around line 238), insert:

  ```tsx
  /*
   * The active tab decides the profile: colour and filter both follow it.
   *
   * Keyed on the tab id through a ref rather than on the resolved value, because
   * this effect also reruns whenever settings change — and without the ref,
   * clicking All while a work tab is in front would be undone on the very next
   * render and the chip could not be moved by hand at all. A manual choice
   * stands until the next time a tab is activated.
   *
   * Three deliberate non-actions:
   *  - An SSH tab never resolves. `ssh -t <alias>` runs claude on the far
   *    machine, so `cwd` holds the host alias rather than a folder (CLAUDE.md
   *    gotcha 18) and mapping it would name whichever local project happened to
   *    share that word. `hostId` is the only reliable signal that it is one.
   *  - A folder belonging to no profile leaves the chip exactly where it is,
   *    rather than clearing it to All.
   *  - Nothing happens until the project list has loaded, or a startOnLaunch
   *    session would resolve against an empty list, find nothing, and be marked
   *    as already handled.
   */
  const profiledTabId = useRef<string | null>(null)
  useEffect(() => {
    if (!settings || projectsLoading) return
    if (profiledTabId.current === activeTabId) return
    profiledTabId.current = activeTabId
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab || tab.hostId) return
    const id = profileIdForCwd(
      tab.cwd,
      projects,
      settings.projectRoots,
      availableProfiles,
      platform
    )
    if (!id || foldGroup(id) === foldGroup(settings.activeProfile ?? '')) return
    void patchSettings({ activeProfile: id })
  }, [
    activeTabId,
    tabs,
    projects,
    projectsLoading,
    settings,
    availableProfiles,
    platform,
    patchSettings
  ])
  ```

- [ ] **Step 6: Rebuild, relaunch, and measure again.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && npx electron . --remote-debugging-port=9222
  ```

  Start the same two sessions, click the first tab, run the Step 3 command: expected `"Personal"`.
  Click the second tab and run it again: expected the label of the profile covering
  `/Users/thevinh/dev/work` — `"Work"` on this machine.

- [ ] **Step 7: Measure that a manual choice still sticks.** With the work tab still in front,
  click the `All` chip, then run:

  ```bash
  node /tmp/stoke-cdp.mjs "document.querySelector('.profile-chip[aria-pressed=\"true\"]')?.textContent ?? 'none'"
  ```

  Expected: `"All"`, and it stays `"All"` while you keep clicking around inside the sidebar. Click
  the *other* tab and run it again: expected `"Personal"` — the next activation takes over, which
  is the intended rule.

- [ ] **Step 8: Measure that an SSH tab changes nothing.** Only if a host is configured in
  Settings: connect to it, then run the Step 3 command. Expected: unchanged from whatever it read
  before the connection. If no host is configured, skip — Task 61's
  `'an ssh alias is not a path, so it resolves to nothing'` case covers the rule itself.

- [ ] **Step 9: Typecheck and commit.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && git add -A && git commit -m "Point the profile at whatever tab is in front

App.tsx had exactly one writer of activeProfile — the sidebar chip — so a work
session running in a background tab left the accent and the project filter set
to wherever the user last clicked. Activating a tab now resolves its cwd through
the shared path rule and moves the chip with it. A tab that resolves to nothing
leaves the chip alone rather than clearing it, and an SSH tab never resolves at
all: its cwd is the host alias, not a folder. The ref keying is load-bearing —
without it, settings changing would re-run the effect and a manual click on All
would be undone before it rendered."
  ```

---

### Task 66: Name the active profile where it cannot be missed

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/StatusBar.tsx` — `Props`
  (lines 7-15), the destructure (17-24), and both return branches (37-46 and 51-84).
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — the `<StatusBar />`
  element (around lines 867-874).
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts` — the colour measurement
  that says why; plus a CDP reading of the status bar.

**Interfaces:**
- Consumes: `parseColor(input: string | undefined | null): Rgb | null`,
  `perceptualDistance(a: Rgb, b: Rgb): number`, `type Rgb` from `src/shared/color.ts`;
  `BUILT_IN_THEMES: Theme[]` from `src/shared/themes.ts`; `PROFILES`, `PROFILE_SWATCHES` from
  `src/shared/profiles.ts`; the `activeProfile: ResolvedProfile | null` memo already in `App.tsx`.
- Produces: `StatusBar`'s `Props` gains `profileLabel: string | null`. No new CSS: the pill uses
  the existing `.pill[data-tone='accent']` rule, whose `--accent` / `--accent-soft` are already
  overwritten with the active profile's colours by `applyAppearance`.

- [ ] **Step 1: Write the measurement, asserting the comfortable answer.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts`, add to the import block at the
  top:

  ```ts
  import { parseColor, perceptualDistance, type Rgb } from '../src/shared/color.ts'
  import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
  ```

  and insert this block immediately before the final
  `console.log(`\n${failures ? ... }`)` line:

  ```ts
  console.log('\ncolour alone cannot say which profile is active')
  /*
   * A profile overrides the theme's accent, so "the accent changed" looks like a
   * sufficient signal. It is not: PROFILES[0].accent is the app's own accent by
   * design, so selecting Personal on Ember changes nothing at all — and that is
   * not the only collision. The numbers below are printed, not asserted
   * individually, because the point is the comparison.
   */
  const rgb = (hex: string): Rgb => {
    const c = parseColor(hex)
    if (!c) throw new Error(`unparseable colour ${hex}`)
    return c
  }
  const gap = (a: string, b: string): number => perceptualDistance(rgb(a), rgb(b))

  /** The smallest gap the palette itself treats as two different colours. */
  let nearestSwatches = Infinity
  for (let i = 0; i < PROFILE_SWATCHES.length; i++) {
    for (let j = i + 1; j < PROFILE_SWATCHES.length; j++) {
      nearestSwatches = Math.min(
        nearestSwatches,
        gap(PROFILE_SWATCHES[i].accent, PROFILE_SWATCHES[j].accent)
      )
    }
  }

  const wearableAccents = [
    ...PROFILES.map((p) => p.accent),
    ...PROFILE_SWATCHES.map((s) => s.accent)
  ]
  let nearestThemeToProfile = Infinity
  for (const theme of BUILT_IN_THEMES) {
    for (const accent of wearableAccents) {
      nearestThemeToProfile = Math.min(nearestThemeToProfile, gap(theme.colors.accent, accent))
    }
  }

  console.log(
    `  nearest two swatches ${nearestSwatches.toFixed(3)}; ` +
      `nearest theme accent to a profile accent ${nearestThemeToProfile.toFixed(3)}`
  )
  check(
    'no profile colour is closer to a theme accent than two swatches are to each other',
    nearestThemeToProfile >= nearestSwatches,
    true
  )
  ```

- [ ] **Step 2: Run it and read the measurement off the failure.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts
  ```

  Expected:

  ```
    nearest two swatches 0.083; nearest theme accent to a profile accent 0.000
    FAIL  no profile colour is closer to a theme accent than two swatches are to each other
          got false, want true
  ```

  0.000 is Ember/Personal — literally the same string. The next worst is Moss/Work at 0.049, also
  inside the palette's own 0.083 band. A custom theme can produce any accent at all, so this is not
  fixable by recolouring.

- [ ] **Step 3: Assert what is actually true.** Replace the `check(...)` added in Step 1 with:

  ```ts
  check(
    'some profile wears a built-in theme accent, so an accent swap is not a signal',
    nearestThemeToProfile < nearestSwatches,
    true
  )
  ```

  and run it again:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-profiles.mts
  ```

  Expected: `PASS`, and `all pass` at the end. If this check ever fails it means every profile
  colour has become distinct from every built-in theme accent — a nice change, and still not a
  guarantee, because custom themes exist. The readout stays either way.

- [ ] **Step 4: Measure the status bar as it is.** With the app built and running from Task 65
  (`npm run build && npx electron . --remote-debugging-port=9222`), a session open, and the chip
  reading `Personal`:

  ```bash
  node /tmp/stoke-cdp.mjs "document.querySelector('.statusbar').innerText.replace(/\n/g,' | ')"
  ```

  Expected: the path, the permission label, the model, the message count — and no profile name
  anywhere.

- [ ] **Step 5: Take the label.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/StatusBar.tsx`, replace the
  `Props` interface (lines 7-15) with:

  ```tsx
  interface Props {
    tab: Tab | null
    context: ContextSnapshot | null
    cli: CliInfo | null
    /** Newer CLI version found at launch, or null when up to date. */
    updateAvailable: string | null
    /**
     * The profile the sidebar is filtered to, or null for All.
     *
     * Named, not merely coloured, and here rather than only on the sidebar chip:
     * the profile follows the active tab now, so it changes without anyone
     * pressing anything, and the sidebar can be closed. Colour cannot carry it —
     * verify:profiles measures Ember's accent as identical to Personal's and
     * Moss's as 0.049 from Work's, inside the palette's own 0.083 "same colour"
     * band.
     */
    profileLabel: string | null
    onRevealProject: (path: string) => void
    onOpenSettings: () => void
  }
  ```

  and the destructure (lines 17-24) with:

  ```tsx
  export function StatusBar({
    tab,
    context,
    cli,
    updateAvailable,
    profileLabel,
    onRevealProject,
    onOpenSettings
  }: Props): React.JSX.Element {
  ```

- [ ] **Step 6: Render it in both branches.** Still in `StatusBar.tsx`, immediately after the
  `const updatePill = ...` declaration (which ends at line 35), add:

  ```tsx
    /*
     * No colour of its own: `applyAppearance` writes the active profile's accent
     * over --accent and --accent-soft, so data-tone="accent" is already this
     * profile's colour, and stays right when there is no profile to override it.
     */
    const profilePill = profileLabel ? (
      <span
        className="pill"
        data-tone="accent"
        title={`Profile: ${profileLabel} — follows the folder of the tab in front`}
      >
        {profileLabel}
      </span>
    ) : null
  ```

  In the `if (!tab)` branch, replace

  ```tsx
        <span className="status-item">No active session</span>
        <span className="status-spacer" />
  ```

  with

  ```tsx
        <span className="status-item">No active session</span>
        {profilePill}
        <span className="status-spacer" />
  ```

  and in the main branch, replace

  ```tsx
        <span className="pill" data-tone={bypass ? 'danger' : undefined}>
          {PERMISSION_LABELS[tab.permissionMode]}
        </span>
  ```

  with

  ```tsx
        {profilePill}

        <span className="pill" data-tone={bypass ? 'danger' : undefined}>
          {PERMISSION_LABELS[tab.permissionMode]}
        </span>
  ```

- [ ] **Step 7: Pass it in.** In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`,
  in the `<StatusBar ... />` element (around line 867), add one prop after `updateAvailable`:

  ```tsx
          updateAvailable={update?.updateAvailable ? update.latest : null}
          profileLabel={activeProfile?.label ?? null}
  ```

- [ ] **Step 8: Rebuild and measure again.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && npx electron . --remote-debugging-port=9222
  ```

  With the personal tab in front, run the Step 4 command: expected the same line, now containing
  `Personal`. Click the work tab and run it again: expected the same line containing `Work`. That
  is the switch being visible on the default theme, where the accent does not move at all.

- [ ] **Step 9: Screenshot both, because the terminal is a WebGL canvas.** Capture the window with
  each tab in front (CLAUDE.md gotcha 5 — `.xterm-rows` is empty in the DOM, so a screenshot is the
  only honest confirmation the pane still renders around the change).

- [ ] **Step 10: Typecheck, build, commit.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run check && git add -A && git commit -m "Name the active profile in the status bar, since its colour cannot say it

A profile overrides the theme accent, so switching one looked self-evident. It
is not: PROFILES[0].accent is the app's own accent, so selecting Personal on
Ember changes nothing on screen, and Moss's accent sits 0.049 from Work's —
inside the 0.083 band the palette itself treats as two different colours. Both
numbers are measured in verify:profiles. With the profile now following the tab
in front, the change happens without anyone pressing anything and the sidebar
may be closed, so the status bar names it. No new colour: applyAppearance has
already written the profile's accent over --accent, so the existing accent pill
is the right colour by construction."
  ```
