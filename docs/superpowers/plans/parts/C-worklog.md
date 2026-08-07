## Workstream C — the worklog

**Reads with:** `docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-design.md` §2.4 and §4.C
(authoritative), `docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md`
(shared names — copy them verbatim), `CLAUDE.md` gotchas 15–20, `ARCHITECTURE.md`.

**Prerequisite:** contract Tasks 1–5 must be committed first. Task 1 creates `src/shared/paths.ts`
and rewrites `src/main/worklog/gate.ts` so `groupForCwd` and `shouldWatch` take an optional
`roots` argument and fold path case on macOS; Task 2 creates `src/shared/worklog.ts` and the new
types and channels; Task 3 creates `src/main/settingsSchema.ts` with `Settings.worklogBoards`.
Every task below imports something one of those created.

**Ordering, and why.** The feature does not work at all today, so the order is: make it able to
run, then make it run on the right sessions, then make it say what it did, then make it remember.

1. **Tasks 20–22 make a Notion-only run possible.** Spec §4.C.1 asks for the cost of a *Notion-only*
   recall, and there is no such thing yet — `buildRecallPrompt` always asks for both boards.
   The board-setting plumbing has to land before the measurement it enables, so the number
   measured is the number the shipped code will produce.
2. **Task 23 measures**, twice: what a Notion-only recall really costs, and what the CLI's envelope
   actually looks like when `--max-budget-usd` bites. Nothing downstream guesses either figure.
3. **Tasks 24–26 spend the measurements**: a ceiling above the measured cost, a ceiling and a
   `claudePath` on the write path, and budget exhaustion named as itself instead of arriving as an
   empty result (spec §2.4.1, §2.4.2, §4.C.3).
4. **Tasks 27–28 fix which sessions are watched** — one predicate, root-aware, shared by the dot
   and by the run that costs money (spec §2.4.3, §4.C.4–5).
5. **Tasks 29–30 make it observable** (spec §2.4.4, §4.C.7).
6. **Task 31 makes the baselines survive a restart** (spec §4.C.8).

**Read before writing any code:** `CLAUDE.md` gotcha 15 (`--safe-mode` and MCP are mutually
exclusive — the scan stays hermetic, recall stays a separate run), gotcha 16 (a board's closed
statuses are on none of its open tasks), **gotcha 17 (the queue's dedupe key is load-bearing:
proposal ids are its sha1 and rejections are tombstones keyed on it — nothing in this workstream
touches `dedupeKey`, `proposalId`, or the `create` key format, and Task 21 has an explicit
regression test for it)**, gotcha 18 (an SSH session's `cwd` is the *local* folder), gotcha 19
(never add flags to a user's remote connect command), gotcha 20 (an `await` inside a polling pass
is a window two passes can both walk through — directly relevant to Task 31).

**The rule this workstream must not break** (`gate.ts` header, spec §7): watching is keyed on the
session's own `cwd` and **never** on the sidebar profile chip. There is nowhere to pass the chip
in, by design, and `scripts/verify-worklog-gate.mts:166` asserts the shape of that promise.

---

### Task 20: Recall reads only the boards that are switched on

Recall asks both boards for everything on every run. With ClickUp switched off that is a paid read
of a board nothing will ever be written to — and it is why a "Notion-only recall" cannot be
measured yet.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts` (lines 31–49 the tool
  list, 89–112 `buildRecallPrompt`, 213–231 `RecallOptions`, 241–251 `recallRunOptions`,
  254–269 `readExisting`)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts` (append before the
  final summary lines)

**Interfaces:**
- Consumes: `WORKLOG_TARGETS: readonly WorklogTarget[]` from `src/shared/worklog.ts` (contract
  Task 2); `type WorklogTarget` from `@shared/types`.
- Produces:
  - `export function recallToolsFor(targets: readonly WorklogTarget[]): string[]`
  - `export const RECALL_TOOLS: string[]` (now `recallToolsFor(WORKLOG_TARGETS)`)
  - `RecallOptions` gains `targets?: readonly WorklogTarget[]` — absent means both, which is what
    shipped.
  - `buildRecallPrompt(opts: RecallOptions): string` — unchanged name, now target-aware.

- [ ] **Step 1: Write the failing assertions.** Open
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts`. Add `recallToolsFor` to
  the import list from `../src/main/worklog/recall.ts` (it currently ends `statusesFor`), and paste
  this block immediately **before** the file's closing two lines (`console.log(...)` and
  `process.exitCode = ...`):

  ```ts
  console.log('\nreading one board when only one is switched on')

  const notionOnly = recallRunOptions({ ...BOARDS, targets: ['notion'] })
  check(
    'the allowlist drops every ClickUp tool',
    notionOnly.allowedTools,
    recallToolsFor(['notion'])
  )
  ok(
    'so a ClickUp read is not even possible',
    !(notionOnly.allowedTools ?? []).some((t) => /clickup/i.test(t)),
    (notionOnly.allowedTools ?? []).join(', ')
  )
  ok(
    'the prompt names Notion',
    notionOnly.prompt.includes('collection://abc'),
    notionOnly.prompt
  )
  ok(
    'and never mentions the ClickUp list, which nothing will read',
    !notionOnly.prompt.includes('901615258684'),
    notionOnly.prompt
  )
  ok(
    'it still asks for the status vocabulary, which open pages do not carry',
    /every value its status/.test(notionOnly.prompt),
    notionOnly.prompt
  )

  const clickupOnly = recallRunOptions({ ...BOARDS, targets: ['clickup'] })
  ok(
    'the mirror case drops Notion',
    !(clickupOnly.allowedTools ?? []).some((t) => /notion/i.test(t)),
    (clickupOnly.allowedTools ?? []).join(', ')
  )
  ok(
    'and still asks the list for its own closed statuses',
    /every status it offers/.test(clickupOnly.prompt),
    clickupOnly.prompt
  )

  check('no targets at all allows no tools', recallToolsFor([]), [])
  {
    /*
     * Nowhere to read is a configuration, not a failure: `error` must stay
     * unset, or the scan prompt would tell the model the boards "could not be
     * read" and it would propose creates for everything.
     */
    const stubbed = stub('{"notion":[]}')
    const snap = await readExisting({ ...BOARDS, targets: [], run: stubbed.run }, 42)
    check('no board configured runs nothing at all', stubbed.calls(), 0)
    check('and reports an empty reading rather than an error', snap.error, undefined)
    check('stamped with the time it was decided', snap.readAt, 42)
  }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/verify-worklog-recall.mts`
  Expected: `SyntaxError: The requested module '../src/main/worklog/recall.ts' does not provide an
  export named 'recallToolsFor'`.

- [ ] **Step 3: Build the tool list per destination.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts`, add the value import below the
  existing imports at the top of the file (relative, with the explicit `.ts` — a value import of
  `@shared/*` breaks this module under strip-types):

  ```ts
  import { WORKLOG_TARGETS } from '../../shared/worklog.ts'
  ```

  Then replace the whole `RECALL_TOOLS` declaration (lines 33–49, comment included) with:

  ```ts
  /**
   * The exact queries recall may run, per destination.
   *
   * Two for Notion because the data source id is a `collection://` URI:
   * `query-data-sources` is the direct route and `search` is the fallback when
   * that id will not resolve, and a recall that silently returns nothing is
   * indistinguishable from a board with nothing on it — which would quietly turn
   * every update back into a duplicate.
   *
   * Two for ClickUp because a list's own status vocabulary is NOT derivable from
   * the tasks it holds: recall reads open tasks, so "complete" appears on none of
   * them, and without asking the list directly the agent could read a board but
   * never close anything on it (CLAUDE.md gotcha 16).
   */
  const TOOLS_FOR: Record<WorklogTarget, string[]> = {
    notion: [
      'mcp__claude_ai_Notion__notion-query-data-sources',
      'mcp__claude_ai_Notion__notion-search'
    ],
    clickup: [
      'mcp__claude_ai_ClickUp__clickup_filter_tasks',
      'mcp__claude_ai_ClickUp__clickup_get_list'
    ]
  }

  /**
   * The read tools for a set of destinations, in canonical order.
   *
   * A board that is switched off must not even be reachable. An allowlist is the
   * only thing standing between this run and the write tools of the very same
   * servers, so narrowing it is worth more than narrowing the prompt.
   */
  export function recallToolsFor(targets: readonly WorklogTarget[]): string[] {
    return WORKLOG_TARGETS.filter((t) => targets.includes(t)).flatMap((t) => TOOLS_FOR[t])
  }

  /** Every read tool. The allowlist when nothing narrows it. */
  export const RECALL_TOOLS = recallToolsFor(WORKLOG_TARGETS)
  ```

- [ ] **Step 4: Make the prompt name only the boards being read.** Replace `buildRecallPrompt`
  (lines 89–112) with:

  ```ts
  /** What each destination is asked for. One entry per configured board. */
  const RECALL_ASK: Record<WorklogTarget, (opts: RecallOptions) => string[]> = {
    notion: (o) => [
      `Notion: the pages in data source ${o.notionDataSource}, using`,
      'notion-query-data-sources. If that id will not resolve, fall back to',
      'notion-search over the same workspace. Report every value its status',
      'property allows, not only the ones in use.'
    ],
    clickup: (o) => [
      `ClickUp: the tasks in list ${o.clickupListId}, using clickup_filter_tasks.`,
      'Include every task that is not closed or archived. Then call clickup_get_list',
      'on the same list and report every status it offers, including the closed ones.'
    ]
  }

  /** The reply shape for one destination. Only configured boards are shown one. */
  const RECALL_EXAMPLE: Record<WorklogTarget, string> = {
    notion:
      '"notion":[{"id":"...","title":"...","status":"...","url":"https://www.notion.so/..."}],' +
      '"notionStatuses":["Not started","In progress","Done"]',
    clickup:
      '"clickup":[{"id":"abc123","title":"Fix the context meter","status":"in progress",' +
      '"url":"https://app.clickup.com/t/abc123"}],"clickupStatuses":["open","in progress","complete"]'
  }

  /**
   * Read the configured boards, and only those.
   *
   * `targets` narrows both the prompt and the allowlist. Naming a board the run
   * cannot reach is not harmless: the model spends turns trying, which is the
   * budget this feature has never had enough of.
   */
  export function buildRecallPrompt(opts: RecallOptions): string {
    const targets = configuredTargets(opts)
    const asks = targets.flatMap((t, i) => {
      const lines = RECALL_ASK[t](opts)
      return [`${i + 1}. ${lines[0]}`, ...lines.slice(1).map((l) => `   ${l}`)]
    })

    return [
      'List what is currently on your task boards. Read only — create nothing, change nothing.',
      '',
      ...asks,
      '',
      `At most ${MAX_RECALL_ITEMS} of the most recent records from each. For every record give`,
      'its own id, its title, its status exactly as that board words it, and its URL.',
      '',
      'Reply with JSON and nothing else — no prose, no code fence:',
      `{${targets.map((t) => RECALL_EXAMPLE[t]).join(',')}}`,
      '',
      'A board you cannot reach gets an empty array, not an invented one.'
    ].join('\n')
  }

  /** The destinations this read covers. Absent means both, which is what shipped. */
  function configuredTargets(opts: RecallOptions): WorklogTarget[] {
    const wanted = opts.targets ?? WORKLOG_TARGETS
    return WORKLOG_TARGETS.filter((t) => wanted.includes(t))
  }
  ```

- [ ] **Step 5: Thread `targets` through the options and the run.** In the same file, add the field
  to `RecallOptions` immediately after `notionDataSource: string` (line 215):

  ```ts
    /**
     * Which boards to read. Absent reads both, which is what shipped; the live
     * caller passes `Settings.worklogBoards.targets`.
     */
    targets?: readonly WorklogTarget[]
  ```

  In `recallRunOptions` (line 241), change the `allowedTools` line from
  `allowedTools: RECALL_TOOLS,` to:

  ```ts
    allowedTools: recallToolsFor(configuredTargets(opts)),
  ```

  and in `readExisting` (line 254), insert this as the first statement of the function body, before
  `let result: HeadlessResult`:

  ```ts
    /*
     * No destination is not a failure.
     *
     * Reporting an error here would tell the scan prompt the boards "could not be
     * read", and the model's documented response to that is to propose creates
     * for everything — which is the duplication recall exists to prevent. An
     * empty, successful reading says the true thing: there is nothing tracked
     * anywhere the worklog writes.
     */
    if (configuredTargets(opts).length === 0) return { items: {}, readAt: now }
  ```

- [ ] **Step 6: Run it and watch it pass.**
  `node scripts/verify-worklog-recall.mts` → `all pass`, and
  `node scripts/verify-worklog-runner.mts` → `all pass` (it renders recall into the scan prompt).

- [ ] **Step 7: Commit.**
  `git commit -m "Let recall read one board when only one is switched on"`
  Body records: the allowlist and the prompt both named ClickUp unconditionally, so a Notion-only
  setup paid for a read of a board nothing would ever be written to — and a Notion-only recall,
  which spec §4.C.1 asks to be measured, did not exist.

---

### Task 21: The write path takes its board ids from settings

`runner.ts:37-38` compiles in one person's Notion data source and ClickUp list. Nobody else can use
the feature, and this machine cannot narrow to one destination.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts` (lines 1–6 imports, 29–38
  the constants, 351–436 `buildApplyPrompt`, 456 `TARGETS`, 678–694 `applyRunOptions`, 811–828
  `ApplyOptions`, 846–915 `applyProposal`)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts` (append before the
  final summary lines), `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-retry.mts`
  (append before the final summary lines)

**Interfaces:**
- Consumes: `DEFAULT_WORKLOG_BOARDS: WorklogBoards`, `WORKLOG_TARGETS: readonly WorklogTarget[]`
  from `src/shared/worklog.ts`; `type WorklogBoards` from `@shared/types`.
- Produces:
  - `buildApplyPrompt(proposal: WorklogProposal, target: WorklogTarget, boards?: WorklogBoards): string`
  - `applyRunOptions(proposal: WorklogProposal, target: WorklogTarget, opts?: ApplyOptions): HeadlessOptions`
    — `ApplyOptions` gains `boards?: WorklogBoards`
  - `applyProposal` writes only to `boards.targets`
  - `NOTION_DATA_SOURCE` / `CLICKUP_LIST_ID` stay exported, as re-exports of the defaults

- [ ] **Step 1: Write the failing assertions.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`, add `NOTION_DATA_SOURCE`
  and `CLICKUP_LIST_ID` to the import list from `../src/main/worklog/runner.ts`, and paste this
  block immediately **before** the file's closing summary lines:

  ```ts
  console.log('\nthe board ids come from settings, not the binary')

  const otherBoards = {
    targets: ['notion', 'clickup'] as const,
    notionDataSource: 'collection://other-source',
    clickupListId: '111222333'
  }

  ok(
    'a configured Notion source reaches the prompt',
    buildApplyPrompt(proposal(), 'notion', { ...otherBoards, targets: ['notion', 'clickup'] })
      .includes('collection://other-source')
  )
  ok(
    'and the shipped default is nowhere in it',
    !buildApplyPrompt(proposal(), 'notion', { ...otherBoards, targets: ['notion', 'clickup'] })
      .includes(NOTION_DATA_SOURCE)
  )
  ok(
    'a configured ClickUp list reaches the prompt',
    buildApplyPrompt(proposal(), 'clickup', { ...otherBoards, targets: ['notion', 'clickup'] })
      .includes('111222333')
  )
  check('the defaults are still exported for anything that imports them', typeof CLICKUP_LIST_ID, 'string')

  /*
   * CLAUDE.md gotcha 17. Proposal ids are the sha1 of the dedupe key and every
   * rejection is a tombstone keyed on it, so a create key that changed by one
   * byte would resurrect every proposal the user has ever said no to. Nothing in
   * this workstream touches it; this is the assertion that keeps it that way.
   */
  console.log('\nthe create dedupe key is byte-for-byte what it always was')
  check(
    'the create key is session|flattened title',
    dedupeKey({ sessionId: 'abc-123', title: 'Fixed the context meter!' }),
    'abc-123|fixed the context meter'
  )
  check(
    'and a kind of create does not change it',
    dedupeKey({ sessionId: 'abc-123', title: 'Fixed the context meter!', kind: 'create' }),
    dedupeKey({ sessionId: 'abc-123', title: 'Fixed the context meter!' })
  )
  check(
    'nor does an update with no record to point at',
    dedupeKey({ sessionId: 'abc-123', title: 'Fixed the context meter!', kind: 'update' }),
    'abc-123|fixed the context meter'
  )
  check(
    'while an update that names one is keyed on the record',
    dedupeKey({
      sessionId: 'abc-123',
      title: 'Whatever the model called it this time',
      kind: 'update',
      existing: { clickup: { id: 'ABC123', title: 't' } }
    }),
    'abc-123|update|clickup:abc123'
  )
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-runner.mts`
  Expected: `TypeError: buildApplyPrompt(...) is not a function` is **not** what you should see —
  the real failure is the third argument being ignored:
  `FAIL  and the shipped default is nowhere in it`, followed by
  `FAIL  a configured ClickUp list reaches the prompt`, and the suite exits 1.

- [ ] **Step 3: Re-point the constants at the shared defaults.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts`, add to the imports at the top:

  ```ts
  import { DEFAULT_WORKLOG_BOARDS, WORKLOG_TARGETS } from '../../shared/worklog.ts'
  ```

  and add `WorklogBoards` to the type import on line 6 so it reads:

  ```ts
  import type { WorklogBoards, WorklogKind, WorklogProposal, WorklogTarget } from '@shared/types'
  ```

  Replace lines 31–38 (the "Settled destinations" comment and both constants) with:

  ```ts
  /**
   * The shipped defaults, kept as named exports because other modules import
   * them. The live values come from `Settings.worklogBoards`: an id is one
   * person's board, and compiling it in meant nobody else could use the feature
   * and this machine could not narrow to one destination.
   *
   * The default Notion data source's schema already matches what is written
   * here, and the default ClickUp list is the engineering list — deliberately not
   * the Team Space's `IT Support Tasks`, which is a helpdesk queue whose statuses
   * would make engineering work unreadable.
   */
  export const NOTION_DATA_SOURCE = DEFAULT_WORKLOG_BOARDS.notionDataSource
  export const CLICKUP_LIST_ID = DEFAULT_WORKLOG_BOARDS.clickupListId
  ```

  Replace line 456 (`const TARGETS: WorklogTarget[] = ['notion', 'clickup']`) with:

  ```ts
  const TARGETS: WorklogTarget[] = [...WORKLOG_TARGETS]
  ```

- [ ] **Step 4: Take the ids from the argument.** In `buildApplyPrompt`, change the signature
  (line 351) to:

  ```ts
  export function buildApplyPrompt(
    proposal: WorklogProposal,
    target: WorklogTarget,
    boards: WorklogBoards = DEFAULT_WORKLOG_BOARDS
  ): string {
  ```

  and in the `create` branch near the end of the function replace the two interpolated constants:
  `List id: ${CLICKUP_LIST_ID}.` becomes `List id: ${boards.clickupListId}.`, and
  `Parent data source: ${NOTION_DATA_SOURCE}.` becomes
  `Parent data source: ${boards.notionDataSource}.`

- [ ] **Step 5: Carry the boards through the options.** In `ApplyOptions` (line 811) add, after
  `claudePath`:

  ```ts
    /**
     * Which boards to write to, and their ids. Absent means the shipped
     * defaults — which is what every existing caller and test relies on.
     */
    boards?: WorklogBoards
  ```

  and in `applyRunOptions` (line 678) change the prompt line to:

  ```ts
      prompt: buildApplyPrompt(proposal, target, opts.boards ?? DEFAULT_WORKLOG_BOARDS),
  ```

- [ ] **Step 6: Never write to a board that is switched off.** In `applyProposal` (line 846),
  insert this immediately after the three `let`/`const` declarations of `urls`, `errors` and
  `cost`, before the `for (const target of WRITE_ORDER)` loop:

  ```ts
    /*
     * A destination the user has switched off is not written, however the
     * proposal is addressed. A proposal can outlive the setting that produced it
     * — it sits in the queue until someone reviews it — so the check belongs
     * here, at the only point that changes anything outside Stoke.
     */
    const allowed = opts.boards ? opts.boards.targets : WORKLOG_TARGETS
    const wanted = proposal.targets.filter((t) => allowed.includes(t))
    if (!wanted.length) {
      /*
       * Loud, not silent. Returning an empty success would mark the proposal
       * accepted with nothing written anywhere, which is the exact class of
       * failure this feature already had too much of. The error is keyed on the
       * destination the proposal *asked* for, because that is the one the panel
       * will name.
       */
      const named = proposal.targets[0] ?? 'notion'
      return {
        urls: {},
        errors: {
          [named]:
            'no board is switched on for this entry — turn one on under Settings, Worklog agent'
        },
        costUsd: null,
        ok: false
      }
    }
  ```

  and change the loop's first line from `if (!proposal.targets.includes(target)) continue` to:

  ```ts
      if (!wanted.includes(target)) continue
  ```

- [ ] **Step 7: Prove a switched-off board is never written.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-retry.mts`, immediately **before** its
  closing two lines:

  ```ts
  console.log('\na board switched off in settings is never written')
  {
    const r = recorder()
    const out = await applyProposal(base, {
      run: r.run,
      boards: { targets: ['notion'], notionDataSource: 'collection://x', clickupListId: '1' }
    })
    check('only the configured board ran', r.calls.join(',') === 'notion', r.calls.join(','))
    check('and it is reported as written', !!out.urls.notion)
  }

  console.log('\na proposal addressed only to a switched-off board fails out loud')
  {
    const r = recorder()
    const out = await applyProposal(
      { ...base, targets: ['clickup'] },
      {
        run: r.run,
        boards: { targets: ['notion'], notionDataSource: 'collection://x', clickupListId: '1' }
      }
    )
    check('nothing was written', r.calls.length === 0, r.calls.join(','))
    check('the accept is not reported ok', !out.ok)
    check('and it says why', !!out.errors.clickup, JSON.stringify(out.errors))
  }
  ```

- [ ] **Step 8: Run both and watch them pass.**
  `node scripts/verify-worklog-runner.mts` → `all pass`, then
  `node scripts/verify-worklog-retry.mts` → `all pass`.

- [ ] **Step 9: Commit.**
  `git commit -m "Take the worklog's board ids from settings instead of the binary"`
  Body records: `runner.ts` compiled in one person's Notion data source and ClickUp list, so nobody
  else could use the feature and this machine could not narrow to one board; and that the create
  dedupe key is now covered by a regression test, because changing it would resurrect every
  proposal the user has ever rejected (CLAUDE.md gotcha 17).

---

### Task 22: The scan proposes only to boards that are switched on

With ClickUp off, the scan still asks for `{"kind":"create","targets":["clickup"]}` entries, and
`normaliseTargets` still falls back to both. Every one of those proposals is unwritable.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts` (lines 252–273
  `ScanContext`, 287–348 `buildScanPrompt`, 458–465 `normaliseTargets`, 475–532 `toProposals`,
  542–570 `parseProposals`, 609–623 `ScanInput`, 702–736 `scanSession`, 759–809 `groundProposals`)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`

**Interfaces:**
- Consumes: `WORKLOG_TARGETS`, `DEFAULT_WORKLOG_BOARDS` (already imported by Task 21).
- Produces:
  - `ScanContext` gains `targets?: readonly WorklogTarget[]`
  - `ScanInput` gains `boards?: WorklogBoards`
  - `parseProposals(reply: string, allowed?: readonly WorklogTarget[]): ModelProposal[]`
  - `groundProposals(proposals, input, snapshot, allowed?: readonly WorklogTarget[])`

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`, before the closing
  summary lines:

  ```ts
  console.log('\nwith one board switched on, nothing unwritable is proposed')

  const onePrompt = buildScanPrompt({
    sessionId: 'abc-123',
    cwd: 'G:\\Code\\gitea-company\\refinity',
    group: 'gitea-company',
    digest,
    targets: ['notion']
  })
  ok('the prompt never asks for a ClickUp entry', !/clickup/i.test(onePrompt), onePrompt)
  ok('outstanding items still get asked for', /outstanding item/.test(onePrompt), onePrompt)
  ok(
    'and they are addressed to the board that is on',
    /"targets":\["notion"\]/.test(onePrompt),
    onePrompt
  )

  check(
    'a destination that is off is dropped from a reply',
    parseProposals('[{"title":"a","targets":["notion","clickup"]}]', ['notion'])[0].targets,
    ['notion']
  )
  check(
    'a reply naming only the board that is off falls back to the one that is on',
    parseProposals('[{"title":"a","targets":["clickup"]}]', ['notion'])[0].targets,
    ['notion']
  )
  check(
    'and with nothing configured it falls back to everything, for the user to trim',
    parseProposals('[{"title":"a","targets":["clickup"]}]', [])[0].targets,
    ['notion', 'clickup']
  )
  check(
    'a demoted update lands on the configured board, not both',
    groundProposals(
      [{ kind: 'update', target: 'clickup', existingId: 'gone', title: 'A', body: '', targets: ['clickup'] }],
      { sessionId: 's', cwd: 'c', group: 'g' },
      EMPTY_RECALL_FIXTURE,
      ['notion']
    ).drafts[0].targets,
    ['notion']
  )
  ```

  Add the fixture just above that block (the suite already builds `RecallSnapshot` literals
  elsewhere; this one is deliberately empty so every update demotes):

  ```ts
  const EMPTY_RECALL_FIXTURE: RecallSnapshot = { items: {}, readAt: 1 }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-runner.mts`
  Expected: `FAIL  the prompt never asks for a ClickUp entry`, then
  `FAIL  a destination that is off is dropped from a reply` with
  `got ["notion","clickup"], want ["notion"]`; the suite exits 1.

- [ ] **Step 3: Make the prompt name the configured boards.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts`, add to `ScanContext` (after
  `digest: string`, line 258):

  ```ts
    /**
     * Which boards are switched on. Absent means both, which is what shipped.
     *
     * A proposal addressed to a board nobody writes to is worse than no proposal:
     * it sits in the queue looking reviewable and fails at accept time.
     */
    targets?: readonly WorklogTarget[]
  ```

  In `buildScanPrompt` (line 287), insert after the existing `const existing = ...` line:

  ```ts
    const enabled = WORKLOG_TARGETS.filter((t) => (ctx.targets ?? WORKLOG_TARGETS).includes(t))
    /*
     * The summary is a narrative, so it goes to Notion when Notion is on; the
     * outstanding items are actionable, so they go to ClickUp when ClickUp is on.
     * With one board configured both collapse onto it, which is correct — the
     * work still needs recording, and there is one place to record it.
     */
    const summaryTarget: WorklogTarget = enabled.includes('notion') ? 'notion' : (enabled[0] ?? 'notion')
    const taskTarget: WorklogTarget = enabled.includes('clickup') ? 'clickup' : (enabled[0] ?? 'notion')
  ```

  and change the two lines in the `Produce:` block that name a destination:

  ```ts
      `1. One summary entry: {"kind":"create","targets":["${summaryTarget}"]}. Body: what was worked`,
  ```

  ```ts
      `3. One {"kind":"create","targets":["${taskTarget}"]} per outstanding item NOT listed above:`,
  ```

  (leave every other line of the block exactly as it is, including the example at the end — it
  shows the reply *shape*, and the two `Produce:` lines are what state the destinations.)

  Finally, in the example line at the end of the same array, replace the literal
  `"target":"clickup"` occurrence so the example cannot advertise a board that is off:

  ```ts
      ` {"kind":"update","target":"${taskTarget}","id":"abc123","status":"complete","title":"Finished the SSH work","body":"..."}]`
  ```

- [ ] **Step 4: Clamp the parse to the configured boards.** Replace `normaliseTargets`
  (lines 458–465) with:

  ```ts
  function normaliseTargets(v: unknown, allowed: readonly WorklogTarget[]): WorklogTarget[] {
    // Nothing configured is not a licence to write nowhere: the user reviews
    // every proposal anyway, so falling back to everything leaves them something
    // to trim rather than a queue of entries addressed to no board at all.
    const fallback: WorklogTarget[] = allowed.length ? [...allowed] : [...WORKLOG_TARGETS]
    if (!Array.isArray(v)) return fallback
    // Canonical order, not the model's: what is stored must not be able to change
    // the order anything is written in.
    const picked = WORKLOG_TARGETS.filter((t) => v.includes(t) && fallback.includes(t))
    return picked.length ? picked : fallback
  }
  ```

  Change `toProposals` (line 475) to take the list and pass it on:

  ```ts
  function toProposals(
    value: unknown,
    allowed: readonly WorklogTarget[]
  ): { proposals: ModelProposal[] } | { reason: string } {
  ```

  and inside it, the `targets:` line of the constructed proposal becomes:

  ```ts
        targets: kind === 'update' && target ? [target] : normaliseTargets(entry.targets, allowed),
  ```

  Change `parseProposals` (line 542) to:

  ```ts
  export function parseProposals(
    reply: string,
    allowed: readonly WorklogTarget[] = WORKLOG_TARGETS
  ): ModelProposal[] {
  ```

  and its single `toProposals(value)` call to `toProposals(value, allowed)`.

- [ ] **Step 5: Clamp a demoted update too.** Change `groundProposals` (line 759) to:

  ```ts
  export function groundProposals(
    proposals: ModelProposal[],
    input: Pick<ScanInput, 'sessionId' | 'cwd' | 'group' | 'auto'>,
    snapshot: RecallSnapshot,
    allowed: readonly WorklogTarget[] = WORKLOG_TARGETS
  ): { drafts: ProposalDraft[]; demoted: number } {
  ```

  and inside it, the demotion branch's `draft.targets` line becomes:

  ```ts
        // An update whose record does not exist becomes a create — and a create
        // may only go where a write is possible.
        const fallback = allowed.length ? [...allowed] : [...TARGETS]
        draft.targets = target && allowed.includes(target) ? [target] : fallback
  ```

- [ ] **Step 6: Thread it through `scanSession`.** Add to `ScanInput` (after `auto?: boolean`,
  line 622):

  ```ts
    /** Which boards are switched on, and their ids. Absent means the defaults. */
    boards?: WorklogBoards
  ```

  and in `scanSession` (line 702), add above the `buildScanPrompt` call:

  ```ts
    const targets = (input.boards ?? DEFAULT_WORKLOG_BOARDS).targets
  ```

  pass `targets` into the `buildScanPrompt({ ... })` object literal (as `targets,` after
  `group: input.group,`), and change the `groundProposals` call to:

  ```ts
    const { drafts, demoted } = groundProposals(
      parseProposals(result.text, targets),
      input,
      snapshot,
      targets
    )
  ```

- [ ] **Step 7: Run it and watch it pass.**
  `node scripts/verify-worklog-runner.mts` → `all pass`, then `npm run typecheck` exits 0.

- [ ] **Step 8: Commit.**
  `git commit -m "Stop the scan proposing entries for boards nobody writes to"`
  Body records: with ClickUp switched off the scan still asked for ClickUp creates and
  `normaliseTargets` still fell back to both, so every one of those proposals sat in the queue
  looking reviewable and failed at accept time.

---

### Task 23: Measure what a Notion-only recall costs, and what a budget refusal looks like

Two numbers this plan refuses to guess: the real cost of the run that `recall.ts:248` caps at
$0.15, and the exact envelope the CLI returns when `--max-budget-usd` bites. Both are measured
here, and both are recorded in the code that uses them.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/scripts/measure-worklog-cost.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` (the `scripts` block)

**Interfaces:**
- Consumes: `runHeadless`, `type HeadlessResult` from `src/main/agent.ts`; `readExisting`,
  `recallRunOptions` from `src/main/worklog/recall.ts`; `DEFAULT_WORKLOG_BOARDS` from
  `src/shared/worklog.ts`.
- Produces: a committed measurement tool, deliberately **not** in `npm run check` — it spends real
  money and needs live MCP connectors, exactly like `verify:usage` and `verify:security`.

- [ ] **Step 1: Write the measurement tool.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/measure-worklog-cost.mts`:

  ```ts
  /*
   * What the worklog actually costs, measured rather than assumed.
   *
   * `recall.ts` capped a run at $0.15 and that run could not finish inside it —
   * which is spec §2.4.1, and the single reason the whole feature never did
   * anything. A number that load-bearing is not a taste question, so it is
   * measured here and the measurement is written into the constant's comment.
   *
   * NOT part of `npm run check`. Both modes spawn a real `claude` and the recall
   * mode reads a live board through the user's own MCP connectors, so this costs
   * money and cannot run on a machine with no connectors — the same reason
   * verify:usage and verify:security are excluded.
   *
   *   node scripts/measure-worklog-cost.mts recall
   *   node scripts/measure-worklog-cost.mts budget
   */
  import { runHeadless, type HeadlessResult } from '../src/main/agent.ts'
  import { readExisting, recallRunOptions } from '../src/main/worklog/recall.ts'
  import { DEFAULT_WORKLOG_BOARDS } from '../src/shared/worklog.ts'

  const mode = process.argv[2] ?? 'recall'

  function report(label: string, result: Pick<HeadlessResult, 'isError' | 'subtype' | 'costUsd' | 'durationMs' | 'text'>): void {
    console.log(`\n${label}`)
    console.log(`  isError    ${result.isError}`)
    console.log(`  subtype    ${JSON.stringify(result.subtype)}`)
    console.log(`  costUsd    ${result.costUsd}`)
    console.log(`  durationMs ${result.durationMs}`)
    console.log(`  text       ${JSON.stringify(String(result.text).slice(0, 600))}`)
  }

  if (mode === 'recall') {
    /*
     * A deliberately generous ceiling. The point of this run is to find out what
     * the read costs, and a ceiling below that would abort it and measure the
     * ceiling instead — which is precisely the bug being measured.
     */
    const opts = {
      ...DEFAULT_WORKLOG_BOARDS,
      targets: ['notion'] as const,
      maxBudgetUsd: 2,
      timeoutMs: 300_000
    }
    console.log('running a Notion-only recall against the real board…')
    console.log(`  allowed tools: ${(recallRunOptions(opts).allowedTools ?? []).join(', ')}`)
    const started = Date.now()
    const snapshot = await readExisting(opts)
    console.log(`\nwall clock  ${Date.now() - started}ms`)
    console.log(`records     ${(snapshot.items.notion ?? []).length}`)
    console.log(`statuses    ${JSON.stringify(snapshot.statuses?.notion ?? [])}`)
    console.log(`error       ${JSON.stringify(snapshot.error ?? null)}`)
    console.log(
      '\nreadExisting does not report cost. Re-run the same options through runHeadless for it:'
    )
    const raw = await runHeadless(recallRunOptions(opts))
    report('the same read, measured', raw)
    console.log(`\n>>> RECORD THIS: a Notion-only recall cost $${raw.costUsd} on ${new Date().toISOString().slice(0, 10)}`)
  } else if (mode === 'budget') {
    /*
     * A ceiling nothing can fit inside, so the CLI has to refuse. The whole
     * purpose is the shape of that refusal: `subtype` and the result text are
     * what `isBudgetExhausted` matches on, and guessing them is how a budget
     * failure keeps arriving as an empty result.
     */
    console.log('running a trivial prompt under a $0.0001 ceiling…')
    try {
      const result = await runHeadless({
        prompt: 'Reply with the single word: ok',
        maxBudgetUsd: 0.0001,
        strictMcp: true,
        safeMode: true,
        effort: 'low',
        timeoutMs: 120_000
      })
      report('the refusal', result)
      console.log(`\nraw envelope:\n${JSON.stringify(result.raw, null, 2)}`)
      console.log('\n>>> RECORD THIS: the subtype and the result text above.')
    } catch (err) {
      console.log('\nit threw instead of returning an envelope:')
      console.log(String(err))
      console.log('\n>>> RECORD THIS: budget exhaustion has no envelope on this CLI version.')
    }
  } else {
    console.log('usage: node scripts/measure-worklog-cost.mts [recall|budget]')
    process.exitCode = 1
  }
  ```

- [ ] **Step 2: Register it, and keep it out of `check`.** In
  `/Users/thevinh/dev/personal/stoke/package.json`, add after the `verify:extract` line:

  ```json
      "measure:worklog": "node scripts/measure-worklog-cost.mts",
  ```

  Do **not** add it to `check`.

- [ ] **Step 3: Measure the recall.**
  `cd /Users/thevinh/dev/personal/stoke && npm run measure:worklog -- recall`
  Write the printed `costUsd` and `durationMs` down — Task 24 puts both in a comment. If it comes
  back `isError true` with a budget subtype, the ceiling of 2 was still too low: raise it in the
  script and measure again before continuing, because a truncated run measures the ceiling rather
  than the read.

- [ ] **Step 4: Measure the refusal.**
  `npm run measure:worklog -- budget`
  Write down the exact `subtype` string and the first line of the result text. This is what Task 25
  matches on.

- [ ] **Step 5: Commit.**
  `git commit -m "Add a measurement tool for what the worklog's two paid runs really cost"`
  Body records both measured figures verbatim — the Notion-only recall's cost and duration, and
  the subtype and text a budget-exhausted run returns — so the numbers in the constants that follow
  can be traced back to a run rather than to an opinion.

---

### Task 24: Give both paid runs a ceiling that they fit inside, and the configured `claudePath`

`recall.ts:248` caps at $0.15, below the figure Task 23 measured, so recall dies every time
(spec §2.4.1). `applyProposal` is called from the accept handler with neither `maxBudgetUsd` nor
`claudePath` (spec §2.4.2), so it sits on the CLI's own default and auto-detects an executable the
user may have configured explicitly.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts` (line 248),
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts` (`scanRunOptions` line 648,
  `applyRunOptions` line 678), `/Users/thevinh/dev/personal/stoke/src/main/index.ts`
  (lines 228–246 the recall and scan calls, 742–752 the accept handler)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts` (line 94),
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`

**Interfaces:**
- Produces:
  - `export const RECALL_MAX_BUDGET_USD: number` in `recall.ts`
  - `export const SCAN_MAX_BUDGET_USD: number` and `export const APPLY_MAX_BUDGET_USD: number` in
    `runner.ts`
  - `applyRunOptions` and `scanRunOptions` default `maxBudgetUsd` from those constants rather than
    from the agent's global default.
- Consumes: the two figures measured in Task 23.

- [ ] **Step 1: Write the failing assertions.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts`, add
  `RECALL_MAX_BUDGET_USD` to the import list from `../src/main/worklog/recall.ts`, and replace
  line 94 (`ok('and under a budget ceiling', ...)`) with:

  ```ts
  /**
   * Measured with `npm run measure:worklog -- recall` — a Notion-only read of the
   * real board. Replace BOTH this and the constant if it is ever measured again;
   * they are a pair, and the whole point is that the ceiling is above the cost.
   */
  const MEASURED_RECALL_USD = 0 /* <- the costUsd Task 23 step 3 printed */
  ok(
    'the ceiling is the shared constant, not a literal buried in the options',
    opts.maxBudgetUsd === RECALL_MAX_BUDGET_USD,
    `${opts.maxBudgetUsd} vs ${RECALL_MAX_BUDGET_USD}`
  )
  ok(
    'and it sits well above what the read actually costs',
    RECALL_MAX_BUDGET_USD >= MEASURED_RECALL_USD * 3,
    `ceiling ${RECALL_MAX_BUDGET_USD}, measured ${MEASURED_RECALL_USD}`
  )
  ok(
    'while still being a ceiling rather than a blank cheque',
    RECALL_MAX_BUDGET_USD <= 1.5,
    String(RECALL_MAX_BUDGET_USD)
  )
  ```

  Set `MEASURED_RECALL_USD` to the figure printed in Task 23 step 3.

  In `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`, add
  `APPLY_MAX_BUDGET_USD` and `SCAN_MAX_BUDGET_USD` to the runner import list and replace the line
  `ok('a write run is budget-capped too', writeArgs.includes('--max-budget-usd'))` with:

  ```ts
  check(
    'a write run carries its own explicit ceiling, even when the caller forgets',
    writeArgs[writeArgs.indexOf('--max-budget-usd') + 1],
    String(APPLY_MAX_BUDGET_USD)
  )
  check(
    'and so does a scan',
    scanArgs[scanArgs.indexOf('--max-budget-usd') + 1],
    String(SCAN_MAX_BUDGET_USD)
  )
  ```

- [ ] **Step 2: Run both and watch them fail.**
  `node scripts/verify-worklog-recall.mts`
  Expected: `SyntaxError: The requested module '../src/main/worklog/recall.ts' does not provide an
  export named 'RECALL_MAX_BUDGET_USD'`.
  Then `node scripts/verify-worklog-runner.mts`
  Expected: `SyntaxError: The requested module '../src/main/worklog/runner.ts' does not provide an
  export named 'APPLY_MAX_BUDGET_USD'`.

- [ ] **Step 3: Raise the recall ceiling.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts`, add above `recallRunOptions`
  (line 233, next to its doc comment):

  ```ts
  /**
   * Ceiling on one recall run.
   *
   * Measured, not chosen: `npm run measure:worklog -- recall` read the real
   * Notion board for $<MEASURED> in <MEASURED>ms on <DATE>. The previous $0.15
   * was below that, so recall exhausted its budget before it could answer —
   * spec §2.4.1, and the reason the feature never did anything on this machine.
   *
   * Set at roughly four times the measured cost. The read is not fixed-price: a
   * board that has grown, or a fallback from `query-data-sources` to
   * `notion-search`, both make it dearer, and a recall that dies is silent —
   * the scan then proposes creates for work that is already tracked, which is
   * the duplication recall exists to prevent.
   */
  export const RECALL_MAX_BUDGET_USD = 0 /* <- ceil(measured * 4) to two decimals */
  ```

  and change line 248 from `maxBudgetUsd: opts.maxBudgetUsd ?? 0.15,` to:

  ```ts
      maxBudgetUsd: opts.maxBudgetUsd ?? RECALL_MAX_BUDGET_USD,
  ```

- [ ] **Step 4: Give the scan and the write their own ceilings.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts`, add just above `scanRunOptions`
  (line 641):

  ```ts
  /**
   * Ceiling on one scan.
   *
   * The scan is hermetic and fixed-size — a bounded digest, no MCP, no CLAUDE.md
   * — and the worst measured run of a real 146-turn session cost $0.107 at
   * default effort (see scanRunOptions). Three times that, so a long session
   * cannot silently truncate, and no more, because a prompt-building bug that
   * pasted a whole transcript must fail loudly rather than bill for it.
   */
  export const SCAN_MAX_BUDGET_USD = 0.3

  /**
   * Ceiling on one destination's write.
   *
   * A write is one MCP call against the same connectors recall reads through, so
   * the recall measurement is the only measured figure that applies — and a write
   * that runs out of budget half way through is the worst outcome in the feature,
   * because a record may already exist. Deliberately generous for that reason.
   *
   * This was previously absent entirely: `worklogAccept` called `applyProposal`
   * with no budget and no claudePath (spec §2.4.2), so the write sat on the CLI's
   * own default and auto-detected an executable the user may have set explicitly.
   */
  export const APPLY_MAX_BUDGET_USD = RECALL_MAX_BUDGET_USD
  ```

  and add the import of `RECALL_MAX_BUDGET_USD` to the existing `./recall.ts` import on line 4, so
  it reads:

  ```ts
  import {
    EMPTY_RECALL,
    RECALL_MAX_BUDGET_USD,
    formatRecall,
    statusesFor,
    type RecallSnapshot
  } from './recall.ts'
  ```

  In `scanRunOptions`, change `maxBudgetUsd: input.maxBudgetUsd,` to:

  ```ts
      maxBudgetUsd: input.maxBudgetUsd ?? SCAN_MAX_BUDGET_USD,
  ```

  In `applyRunOptions`, change `maxBudgetUsd: opts.maxBudgetUsd,` to:

  ```ts
      maxBudgetUsd: opts.maxBudgetUsd ?? APPLY_MAX_BUDGET_USD,
  ```

- [ ] **Step 5: Pass the settings through at the call sites.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, change the `recall({ ... })` call
  (lines 228–235) to:

  ```ts
    const boards = settings.worklogBoards
    const snapshot = await recall({
      clickupListId: boards.clickupListId,
      notionDataSource: boards.notionDataSource,
      targets: boards.targets,
      // The same directory the write would use, so both runs see the same MCP
      // servers. runHeadless falls back to a scratch dir if it has been deleted.
      cwd,
      claudePath: settings.claudePath
    })
  ```

  add `boards,` to the `scanSession({ ... })` call immediately below it (after `auto,`), and change
  the `applyProposal` call in the `worklogAccept` handler (line 742) to:

  ```ts
        const settings = getSettings()
        const outcome = await applyProposal(item, {
          // All three were missing. Without claudePath a user with an explicit
          // path in Settings got auto-detection instead; without a budget the
          // write sat on the CLI's default; without boards it wrote to a
          // destination the user may have switched off.
          claudePath: settings.claudePath,
          maxBudgetUsd: APPLY_MAX_BUDGET_USD,
          boards: settings.worklogBoards,
          // Persist each URL the moment its write returns, so a failure on the
          // second destination cannot lose the first - and so a retry can tell
          // what has already been written and skip it.
          onWritten: async (target, url) => {
            if (!url) return
            const current = q.list().find((p) => p.id === id)
            q.update(id, { urls: { ...(current?.urls ?? {}), [target]: url } })
            send(CH.worklogChanged, q.list())
          }
        })
  ```

  and add `APPLY_MAX_BUDGET_USD` to the existing import block from `./worklog/runner.ts`
  (lines 17–22).

- [ ] **Step 6: Run everything and watch it pass.**
  `node scripts/verify-worklog-recall.mts` → `all pass`;
  `node scripts/verify-worklog-runner.mts` → `all pass`;
  `npm run typecheck` exits 0.

- [ ] **Step 7: Commit.**
  `git commit -m "Give the worklog's paid runs ceilings they fit inside"`
  Body records: recall was capped at $0.15 and the measured Notion-only read costs $<MEASURED>, so
  it exhausted its budget before it could answer and the whole feature was dead regardless of
  configuration; and `worklogAccept` called `applyProposal` with neither a budget nor the
  configured `claudePath`.

---

### Task 25: Name budget exhaustion, so it stops arriving as "nothing to report"

Spec §2.4 records the failure that matters most: a run that ran out of money looks exactly like a
session with nothing worth logging.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/agent.ts` (after `HeadlessError`, line 132),
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts` (`RecallSnapshot` line 62,
  `readExisting` line 254), `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts`
  (after `WorklogParseError` line 133, `scanSession` line 721, `applyProposal` line 877)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`,
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts`

**Interfaces:**
- Produces:
  - `export function isBudgetExhausted(result: Pick<HeadlessResult, 'isError' | 'subtype' | 'text'>): boolean`
    in `src/main/agent.ts`
  - `export class WorklogBudgetError extends Error` in `src/main/worklog/runner.ts`, with
    `readonly limitUsd: number` and `readonly costUsd: number | null`
  - `RecallSnapshot` gains `budget?: true`
- Consumes: the `subtype` and result text measured in Task 23 step 4.

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`, before the closing summary
  lines, adding `isBudgetExhausted` to the `../src/main/agent.ts` import and `WorklogBudgetError`
  to the runner import:

  ```ts
  console.log('\na run that ran out of money says so')

  /**
   * The exact envelope `npm run measure:worklog -- budget` returned on <DATE>
   * against claude <VERSION>. Verbatim, because this is somebody else's wire
   * format and the day it changes is the day budget failures go silent again.
   */
  const BUDGET_REFUSAL = {
    isError: true,
    subtype: '<the subtype Task 23 step 4 printed>',
    text: '<the first line of the result text Task 23 step 4 printed>'
  }

  ok('the measured refusal is recognised', isBudgetExhausted(BUDGET_REFUSAL))
  ok(
    'a plain failure is not mistaken for one',
    !isBudgetExhausted({ isError: true, subtype: 'error_during_execution', text: 'the tool failed' })
  )
  ok(
    'and a success never is, whatever it happens to mention',
    !isBudgetExhausted({ isError: false, subtype: 'success', text: 'I stayed within budget.' })
  )

  {
    const budgeted = (async () => BUDGET_REFUSAL_RESULT) as never
    const out = await applyProposal(proposal(), { run: budgeted })
    ok(
      'a write that hit the ceiling says which ceiling',
      /budget/i.test(Object.values(out.errors).join(' ')),
      JSON.stringify(out.errors)
    )
    ok('and is not reported ok', !out.ok)
  }
  ```

  with the full result fixture just above that block:

  ```ts
  const BUDGET_REFUSAL_RESULT = {
    ...BUDGET_REFUSAL,
    costUsd: 0.3,
    durationMs: 900,
    numTurns: 1,
    sessionId: null,
    permissionDenials: [],
    raw: {}
  }
  ```

  Fill both `<…>` placeholders from what Task 23 step 4 printed.

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-runner.mts`
  Expected: `SyntaxError: The requested module '../src/main/agent.ts' does not provide an export
  named 'isBudgetExhausted'`.

- [ ] **Step 3: Recognise a budget refusal.** In
  `/Users/thevinh/dev/personal/stoke/src/main/agent.ts`, add immediately after the `HeadlessError`
  class (line 132):

  ```ts
  /**
   * Did this run stop because it hit `--max-budget-usd`?
   *
   * Measured against claude <VERSION> on <DATE> with
   * `npm run measure:worklog -- budget`: the run exits non-zero but still prints
   * a result envelope, whose `subtype` is <RECORDED SUBTYPE> and whose result
   * text reads <RECORDED TEXT>. agent.ts already keeps that envelope on purpose —
   * "a non-zero exit that still printed a result envelope is a real answer about
   * a real failure (budget exceeded, a tool denied)".
   *
   * Both the subtype and the text are matched. The subtype is a string somebody
   * else owns and can rename; the text is the part the user is shown. Matching
   * either is how this keeps working when one of them changes.
   */
  export function isBudgetExhausted(
    result: Pick<HeadlessResult, 'isError' | 'subtype' | 'text'>
  ): boolean {
    if (!result.isError) return false
    return /budget/i.test(result.subtype ?? '') || /budget/i.test(result.text ?? '')
  }
  ```

- [ ] **Step 4: Give the worklog its own error for it.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts`, add after the `WorklogParseError`
  class (line 133):

  ```ts
  /**
   * The run stopped at its budget ceiling rather than because there was nothing
   * to say.
   *
   * Its own type for the same reason WorklogParseError is: spec §2.4 records that
   * budget exhaustion presented as an empty result, which is indistinguishable
   * from "this session had nothing worth logging" — and one of those is the
   * feature dying silently. Every surface that reports a scan reads this type.
   */
  export class WorklogBudgetError extends Error {
    readonly limitUsd: number
    readonly costUsd: number | null

    // Explicit assignment rather than TS parameter properties, matching the other
    // main-process classes so this stays runnable under node's type stripping.
    constructor(what: string, limitUsd: number, costUsd: number | null) {
      super(
        `The worklog ${what} stopped at its $${limitUsd.toFixed(2)} budget ceiling before it finished, so nothing was written.`
      )
      this.name = 'WorklogBudgetError'
      this.limitUsd = limitUsd
      this.costUsd = costUsd
    }
  }
  ```

  and add `isBudgetExhausted` to the existing `../agent.ts` import on line 2.

- [ ] **Step 5: Raise it from both runs.** In `scanSession`, replace the `if (result.isError)`
  block (lines 723–725) with:

  ```ts
    if (result.isError) {
      if (isBudgetExhausted(result)) {
        throw new WorklogBudgetError('scan', input.maxBudgetUsd ?? SCAN_MAX_BUDGET_USD, result.costUsd)
      }
      throw new Error(
        `The worklog scan failed: ${clip(oneLine(result.text), 300) || result.subtype || 'unknown error'}`
      )
    }
  ```

  In `applyProposal`, replace the `if (result.isError) { throw ... }` block (lines 877–879) with:

  ```ts
        if (result.isError) {
          throw isBudgetExhausted(result)
            ? new WorklogBudgetError(
                `write to ${target}`,
                opts.maxBudgetUsd ?? APPLY_MAX_BUDGET_USD,
                result.costUsd
              )
            : new Error(
                clip(oneLine(result.text), 300) || result.subtype || 'the run reported an error'
              )
        }
  ```

  (the surrounding `catch` already records `err.message` into `errors[target]`, so the sentence
  reaches the panel unchanged.)

- [ ] **Step 6: Mark a budget-starved recall as such.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts`, add to `RecallSnapshot` after
  `error?: string` (line 80):

  ```ts
    /**
     * The read stopped at its budget ceiling. A separate flag from `error`
     * because it is the one failure with a fix the user can act on, and because
     * it is what the scan report turns into the outcome `budget`.
     */
    budget?: true
  ```

  and replace the `if (result.isError)` block in `readExisting` (lines 261–267) with:

  ```ts
    if (result.isError) {
      if (isBudgetExhausted(result)) {
        const limit = opts.maxBudgetUsd ?? RECALL_MAX_BUDGET_USD
        return {
          items: {},
          readAt: now,
          budget: true,
          error: `the recall run stopped at its $${limit.toFixed(2)} budget ceiling before it could read the boards`
        }
      }
      return {
        items: {},
        readAt: now,
        error: clip(oneLine(result.text), 200) || result.subtype || 'the recall run reported an error'
      }
    }
  ```

  adding `import { isBudgetExhausted } from '../agent.ts'` to the existing agent import on line 1.

- [ ] **Step 7: Cover the recall side.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts`, before its closing lines:

  ```ts
  console.log('\na recall that ran out of money does not report an empty board')
  {
    const refused: Runner = async () => ({
      text: '<the result text Task 23 step 4 printed>',
      isError: true,
      subtype: '<the subtype Task 23 step 4 printed>',
      costUsd: 0.15,
      durationMs: 100,
      numTurns: 1,
      sessionId: null,
      permissionDenials: [],
      raw: {}
    })
    const snap = await readExisting({ ...BOARDS, run: refused }, 7)
    check('it is flagged as a budget failure', snap.budget, true)
    ok('and says so in words', /budget ceiling/.test(snap.error ?? ''), snap.error ?? '')
    check('with no items, so nothing is claimed to exist', snap.items, {})
  }
  ```

- [ ] **Step 8: Run everything and watch it pass.**
  `node scripts/verify-worklog-runner.mts` → `all pass`;
  `node scripts/verify-worklog-recall.mts` → `all pass`;
  `npm run typecheck` exits 0.

- [ ] **Step 9: Commit.**
  `git commit -m "Tell budget exhaustion apart from having nothing to report"`
  Body records: a run that hit `--max-budget-usd` came back as `isError` with an envelope and every
  caller turned it into an empty result, so the feature's most common failure was
  indistinguishable from its normal quiet success (spec §2.4).

---

### Task 26: Every scan reports what it did

`index.ts:257` emits `worklogProposed` only `if (auto && added.length)`. A zero-result scan emits
nothing and an error is caught and dropped, so "working but nothing to report" and "never ran" are
the same from outside (spec §2.4.4).

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (lines 183–263 `runWorklogScan`,
  369–378 the AutoScanner `scan` callback, 713–719 the `worklogScan` handler),
  `/Users/thevinh/dev/personal/stoke/src/preload/index.ts` (lines 128–135),
  `/Users/thevinh/dev/personal/stoke/src/shared/api.ts` (lines 219–233)
- Test: launch and read the report over CDP (there is no DOM test runner; `index.ts` imports
  electron and cannot be exercised under strip-types)

**Interfaces:**
- Consumes: `CH.worklogScanned` (`worklog:scanned`), `CH.worklogLastScan` (`worklog:lastScan`) from
  `src/shared/ipc.ts` (contract Task 2); `type WorklogScanReport`, `type WorklogScanOutcome` from
  `@shared/types`; `WorklogBudgetError` from `./worklog/runner.ts`.
- Produces:
  - `async function runWorklogScan(sessionId: string, auto: boolean): Promise<WorklogScanReport>` —
    **never throws**
  - `window.stoke.worklog.lastScan(): Promise<WorklogScanReport | null>`
  - `window.stoke.worklog.onScanned(cb: (report: WorklogScanReport) => void): () => void`

- [ ] **Step 1: Make the scan return a report instead of throwing.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, replace the whole of `runWorklogScan`
  (lines 190–263) with:

  ```ts
  /** The last scan of any session, so a freshly-opened panel is not blank. */
  let lastScanReport: WorklogScanReport | null = null

  /** Record a report, push it, and hand it back to whoever asked for the scan. */
  function reportScan(report: WorklogScanReport): WorklogScanReport {
    lastScanReport = report
    send(CH.worklogScanned, report)
    return report
  }

  /**
   * One worklog scan, however it was asked for.
   *
   * Shared by the Scan button and the automatic trigger deliberately: the two
   * differ only in who asked, and every other behaviour — reading the boards
   * first, resolving the group, folding the result into the queue — has to stay
   * identical or the automatic path becomes a second, less-tested feature.
   *
   * **Never throws.** It used to, and both callers turned the throw into
   * something the user could not tell from "nothing to report": the automatic
   * path logged and returned 0, the button showed a bare string. Every ending —
   * proposals, nothing, out of budget, broken — now comes back as one
   * WorklogScanReport, which is the only record the panel has of whether this
   * thing has ever run (spec §2.4.4).
   */
  async function runWorklogScan(sessionId: string, auto: boolean): Promise<WorklogScanReport> {
    const at = Date.now()
    const end = (
      outcome: WorklogScanOutcome,
      added: number,
      message: string | null
    ): WorklogScanReport => reportScan({ sessionId, at, auto, outcome, added, message })

    try {
      const host = hostForSession(sessionId)
      const file = await transcriptFor(sessionId)
      if (!file) {
        return end(
          'error',
          0,
          host
            ? `could not read a transcript on ${host.label || host.alias} — the session may not have started Claude yet`
            : 'no transcript found for that session yet'
        )
      }

      const settings = getSettings()
      const projects = await listProjects(settings)

      /*
       * A remote session is placed by the machine it runs on, not by a folder.
       * `SessionInfo.cwd` for one is wherever Stoke happened to be pointed
       * locally, so resolving a project group from it would name the wrong
       * project. The real working directory is recorded in the transcript
       * itself, which by this point has been fetched — so the proposal names the
       * remote path, and the host takes the place of the project group.
       */
      const cwd = host ? ((await parseSession(file)).cwd ?? '') : cwdForSession(sessionId)
      const group = host
        ? host.label || host.alias
        : (groupForCwd(cwd, projects, settings.projectRoots) ?? '')

      const boards = settings.worklogBoards
      // Cached and single-flighted, so a scan of two sessions a second apart
      // reads the boards once. A failure here is reported to the scan rather
      // than thrown: proposing creates with no idea what exists is degraded,
      // not broken.
      const snapshot = await recall({
        clickupListId: boards.clickupListId,
        notionDataSource: boards.notionDataSource,
        targets: boards.targets,
        // The same directory the write would use, so both runs see the same MCP
        // servers. runHeadless falls back to a scratch dir if it has been deleted.
        cwd,
        claudePath: settings.claudePath
      })
      if (snapshot.error) console.warn('[stoke] worklog recall failed:', snapshot.error)

      const outcome = await scanSession({
        sessionId,
        transcriptFile: file,
        cwd,
        group,
        recall: snapshot,
        auto,
        boards,
        claudePath: settings.claudePath
      })
      if (outcome.demoted > 0) {
        // Not silent: a steady count means recall is truncating or the model is
        // inventing ids, and both look exactly like the feature working.
        console.warn(
          `[stoke] worklog: ${outcome.demoted} update(s) named a record that is not on the boards, filed as new instead`
        )
      }

      const added = worklogQueue().add(outcome.proposals)
      send(CH.worklogChanged, worklogQueue().list())
      if (auto && added.length) {
        // Reversed to match `list()`, which is newest first — so the prompt walks
        // them in the same order the panel shows them.
        send(CH.worklogProposed, { sessionId, ids: added.map((p) => p.id).reverse() })
      }

      if (added.length) return end('proposed', added.length, null)
      /*
       * Nothing added, and recall could not afford to look. Reported as `budget`
       * rather than `nothing`, because a scan that never saw the boards is not
       * evidence that there was nothing to log — it is the exact silent failure
       * spec §2.4.1 names. When proposals *were* added the run is reported as
       * `proposed` and the recall failure stays in the console: the user has
       * something to review either way, which is the outcome that matters to them.
       */
      if (snapshot.budget) return end('budget', 0, snapshot.error ?? null)
      return end('nothing', 0, null)
    } catch (err) {
      if (err instanceof WorklogBudgetError) return end('budget', 0, err.message)
      return end('error', 0, err instanceof Error ? err.message : String(err))
    }
  }
  ```

  Add `WorklogBudgetError` to the import block from `./worklog/runner.ts` (lines 17–22), and add
  `WorklogScanOutcome` and `WorklogScanReport` to the type import from `@shared/types` on line 5.

- [ ] **Step 2: Adapt both callers.** In the AutoScanner options (line 369), replace the `scan`
  callback with:

  ```ts
      scan: async (sessionId) => {
        // runWorklogScan no longer throws; the report is the record of what
        // happened and has already been pushed to the renderer by the time this
        // returns. AutoScanner only needs the count for its own prompt.
        const report = await runWorklogScan(sessionId, true)
        return report.added
      },
  ```

  and replace the `worklogScan` handler (lines 713–719) with:

  ```ts
    ipcMain.handle(CH.worklogScan, async (_e, sessionId: string) => {
      const report = await runWorklogScan(sessionId, false)
      // The panel reads the full report off `worklog:scanned`; this return value
      // stays the shape it always was so the existing caller is untouched. Only
      // a genuine failure becomes an `error` — "nothing to log" is not one.
      return {
        added: report.added,
        error: report.outcome === 'budget' || report.outcome === 'error' ? report.message : null
      }
    })

    ipcMain.handle(CH.worklogLastScan, () => lastScanReport)
  ```

- [ ] **Step 3: Expose it on the bridge.** In
  `/Users/thevinh/dev/personal/stoke/src/preload/index.ts`, add to the `worklog` object
  (lines 128–135), after `onProposed`:

  ```ts
      lastScan: () => ipcRenderer.invoke(CH.worklogLastScan),
      onScanned: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogScanned, cb)
  ```

  and in `/Users/thevinh/dev/personal/stoke/src/shared/api.ts`, add to the `worklog` block
  (before its closing brace at line 233):

  ```ts
      /** The last scan of any session, for the panel's empty state. */
      lastScan(): Promise<WorklogScanReport | null>
      /**
       * Every scan reports, including the ones that proposed nothing. Distinct
       * from `onProposed`, which only fires when there is something to ask about:
       * this is what lets the panel say "it ran, and there was nothing" instead
       * of looking identical to "it has never run".
       */
      onScanned(cb: (report: WorklogScanReport) => void): () => void
  ```

  adding `WorklogScanReport` to that file's import from `./types`.

- [ ] **Step 4: Run the typecheck and the suites.**
  `npm run typecheck` exits 0, then `npm run check` exits 0.

- [ ] **Step 5: See a real report.** Launch the app with
  `npx electron . --remote-debugging-port=9222`, open a session in any folder, and in the
  renderer's console (attach over CDP and filter targets by URL, **not** `type === 'page'` —
  gotcha 6) run:

  ```js
  window.stoke.worklog.onScanned((r) => console.log('scanned', r))
  await window.stoke.worklog.scan(<the session id from window.stoke.worklog.watch() or the tab>)
  await window.stoke.worklog.lastScan()
  ```

  Expected: the `scanned` line logs an object with `sessionId`, `at`, `auto: false`, and an
  `outcome` of `proposed`, `nothing`, `budget` or `error` — and `lastScan()` returns the same
  object. Before this task, a scan that proposed nothing logged nothing at all.

- [ ] **Step 6: Commit.**
  `git commit -m "Report every worklog scan, including the ones that found nothing"`
  Body records: `worklogProposed` fired only when an automatic scan added something, and every error
  was caught and dropped, so a feature that had never run and a feature working quietly looked
  identical — which is why nobody could tell the recall budget had been killing it all along.

---

### Task 27: One predicate for "is this session the worklog's business", and why

The dot in the tab strip and the run that costs money must not be able to disagree. The rule also
has to answer *why*, because that is the field that separates "nothing to report" from "never ran".

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/worklog/watch.ts`
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts` (append)

**Interfaces:**
- Consumes: `groupForCwd(cwd, projects, roots?)` and `isWatchedGroup(group, worklogGroups)` from
  `./gate.ts` (contract Task 1 gave `groupForCwd` its optional `roots`); `type Project`,
  `type WorklogWatchState` from `@shared/types`.
- Produces:
  - `export interface WatchInput { sessionId: string; cwd: string; host: WatchHost | null; projects: Project[]; roots: string[]; worklogGroups: string[]; now: number }`
  - `export interface WatchHost { label: string; alias: string; worklog?: boolean }`
  - `export function watchStateFrom(input: WatchInput): WorklogWatchState`

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts`, immediately **before** its
  closing two lines, and add
  `import { watchStateFrom } from '../src/main/worklog/watch.ts'` to the imports:

  ```ts
  console.log('\nwhy a session is, or is not, the worklog agent\'s business')

  const at = 1_700_000_000_000
  const watchOf = (over: Partial<Parameters<typeof watchStateFrom>[0]> = {}): unknown =>
    watchStateFrom({
      sessionId: 's1',
      cwd: p('gitea-company', 'refinity'),
      host: null,
      projects,
      roots: [],
      worklogGroups: WATCHED,
      now: at,
      ...over
    })

  check('a watched folder is watched, and says which group', watchOf(), {
    sessionId: 's1',
    watched: true,
    reason: 'watched-group',
    group: 'gitea-company',
    remote: false,
    decidedAt: at
  })
  check(
    'a folder in a group nobody watches says so',
    watchOf({ cwd: p('personal', 'Stoke') }),
    { sessionId: 's1', watched: false, reason: 'unwatched-group', group: 'personal', remote: false, decidedAt: at }
  )
  check(
    'a folder that belongs to no project and no root cannot be placed at all',
    watchOf({ cwd: p('scratch', 'notes') }),
    { sessionId: 's1', watched: false, reason: 'unknown-folder', group: null, remote: false, decidedAt: at }
  )
  check(
    'with nothing ticked the feature is off, not merely unwatched',
    watchOf({ worklogGroups: [] }),
    { sessionId: 's1', watched: false, reason: 'off', group: 'gitea-company', remote: false, decidedAt: at }
  )

  /*
   * The root fallback, reaching through this predicate. `/…/work` is itself a
   * registered project on the real machine, so the longest-prefix rule answered
   * `dev` for every sibling under it and 7 of 12 work folders were never watched
   * (spec §2.4.3).
   */
  const rootProjects: Project[] = [...projects, project(root, isWin ? 'G:' : 'vinn')]
  check(
    'a folder under a watched scan root is watched with no history of its own',
    watchOf({
      cwd: p('unregistered-repo'),
      projects: rootProjects,
      roots: [root],
      worklogGroups: ['Code']
    }),
    { sessionId: 's1', watched: true, reason: 'watched-group', group: 'Code', remote: false, decidedAt: at }
  )

  console.log('\na remote session is gated by its machine, never by a folder')
  const host = { label: 'Build box', alias: 'buildbox', worklog: true }
  check('a ticked host is watched', watchOf({ host }), {
    sessionId: 's1',
    watched: true,
    reason: 'watched-host',
    group: 'Build box',
    remote: true,
    decidedAt: at
  })
  check(
    'an unticked host is not, whatever the local cwd happens to be',
    watchOf({ host: { ...host, worklog: false } }),
    { sessionId: 's1', watched: false, reason: 'unwatched-host', group: 'Build box', remote: true, decidedAt: at }
  )
  check(
    'anything other than a literal true is off',
    watchOf({ host: { label: '', alias: 'buildbox' } }),
    { sessionId: 's1', watched: false, reason: 'unwatched-host', group: 'buildbox', remote: true, decidedAt: at }
  )
  check(
    'and a ticked host works with no project groups ticked at all',
    watchOf({ host, worklogGroups: [] }),
    { sessionId: 's1', watched: true, reason: 'watched-host', group: 'Build box', remote: true, decidedAt: at }
  )
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-gate.mts`
  Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/Users/thevinh/dev/personal/stoke/src/main/worklog/watch.ts'`.

- [ ] **Step 3: Create the predicate.** Create
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/watch.ts`:

  ```ts
  /**
   * Whether the worklog agent may look at one session, and why.
   *
   * One predicate, deliberately. The red dot in the tab strip, the panel's
   * "is this thing on" sentence and the automatic run that costs real money all
   * read this — and if any two of them could disagree, the user would be told
   * one thing while another happened. It answers `why` as well as `whether`
   * because spec §2.4.4 records that "working but nothing to report" and "never
   * ran" were indistinguishable, and the reason is the field that separates them.
   *
   * The gate's own rule is preserved exactly: watching is decided from the
   * session's own working directory and **never** from the profile chip in the
   * sidebar. There is nowhere to pass the chip in — see gate.ts's header for why
   * that matters, and scripts/verify-worklog-gate.mts for the assertion.
   *
   * Two rules that only look like details:
   *
   *  - **A remote session is gated by its machine, before anything else.** An
   *    SSH session's `cwd` is the *local* folder Stoke was pointed at, not the
   *    directory the remote shell is in (CLAUDE.md gotcha 18), so the folder rule
   *    would match by accident or never — both silently.
   *  - **`worklogAuto` is not consulted here.** That switch decides whether a
   *    scan starts on its own; it does not decide whose business a session is.
   *    A watched session with auto off is still watched, and the Scan button
   *    still applies to it.
   *
   * Pure, and imports neither electron nor the filesystem, so
   * scripts/verify-worklog-gate.mts exercises every branch under
   * `node --experimental-strip-types`.
   */
  import { groupForCwd, isWatchedGroup } from './gate.ts'
  import type { Project, WorklogWatchState } from '@shared/types'

  /** The fields of `SshHost` this decision needs, and no more. */
  export interface WatchHost {
    label: string
    alias: string
    /** Only a literal `true` switches a machine on. */
    worklog?: boolean
  }

  export interface WatchInput {
    sessionId: string
    /** The session's own working directory. Ignored entirely when `host` is set. */
    cwd: string
    /** The machine it runs on, when that is not this one. */
    host: WatchHost | null
    /** A current project list, never one cached at boot: a repository cloned
     *  during this run is a project the gate has to be able to see. */
    projects: Project[]
    /** `Settings.projectRoots`. A folder under a root belongs to that root. */
    roots: string[]
    worklogGroups: string[]
    /** Epoch ms this was decided. */
    now: number
  }

  export function watchStateFrom(input: WatchInput): WorklogWatchState {
    const base = { sessionId: input.sessionId, decidedAt: input.now }

    if (input.host) {
      const group = input.host.label || input.host.alias || null
      return input.host.worklog === true
        ? { ...base, watched: true, reason: 'watched-host', group, remote: true }
        : { ...base, watched: false, reason: 'unwatched-host', group, remote: true }
    }

    const group = groupForCwd(input.cwd, input.projects, input.roots)

    /*
     * "Off" is reported before "unwatched", and the group is still named.
     *
     * An empty watch list is the shipped default and means the feature does
     * nothing at all — which is a different sentence from "this folder is not on
     * the list", and the panel says a different thing for each. Naming the group
     * anyway is what lets it say *which* profile to tick.
     */
    if (input.worklogGroups.length === 0) {
      return { ...base, watched: false, reason: 'off', group, remote: false }
    }

    if (!group) {
      return { ...base, watched: false, reason: 'unknown-folder', group: null, remote: false }
    }

    return isWatchedGroup(group, input.worklogGroups)
      ? { ...base, watched: true, reason: 'watched-group', group, remote: false }
      : { ...base, watched: false, reason: 'unwatched-group', group, remote: false }
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  `node scripts/verify-worklog-gate.mts` → `all pass`.

- [ ] **Step 5: Commit.**
  `git commit -m "Give the worklog one predicate that says whether a session is watched, and why"`
  Body records: the rule lived inline in the AutoScanner callback in `index.ts`, where nothing
  could test it and no other surface could read it, so the app had no way to tell the user whether
  the session in front of them was being watched at all.

---

### Task 28: Wire the predicate in, and tell the renderer

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (lines 183–189 the worklog block,
  339–380 the AutoScanner, 413–418 window load, 483–517 the projects handlers, 530 `ptyStart`,
  661–681 the settings handler, 702–711 the worklog handlers),
  `/Users/thevinh/dev/personal/stoke/src/preload/index.ts` (the `worklog` object),
  `/Users/thevinh/dev/personal/stoke/src/shared/api.ts` (the `worklog` block)
- Test: over CDP, against a running instance

**Interfaces:**
- Consumes: `watchStateFrom`, `type WatchInput` from `./worklog/watch.ts`;
  `CH.worklogWatch` (`worklog:watch`), `CH.worklogWatchChanged` (`worklog:watchChanged`);
  `onSettingsChanged` from `./store.ts`.
- Produces:
  - `async function watchStateFor(sessionId: string): Promise<WorklogWatchState>`
  - `async function watchStates(): Promise<WorklogWatchState[]>`
  - `function sendWatchStates(): void`
  - `window.stoke.worklog.watch(): Promise<WorklogWatchState[]>`
  - `window.stoke.worklog.onWatchChanged(cb: (states: WorklogWatchState[]) => void): () => void`

- [ ] **Step 1: Add the two resolvers.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, add immediately below the
  `worklogQueue()` helper (line 188):

  ```ts
  /**
   * Whether the worklog may look at one session, and why.
   *
   * A thin gatherer around the pure predicate: everything it reads is live, so a
   * repository cloned during this run, a profile ticked a second ago and a host
   * switched off mid-session all take effect at once.
   */
  async function watchStateFor(sessionId: string): Promise<WorklogWatchState> {
    const settings = getSettings()
    return watchStateFrom({
      sessionId,
      cwd: cwdForSession(sessionId),
      host: hostForSession(sessionId),
      projects: await listProjects(settings),
      roots: settings.projectRoots,
      worklogGroups: settings.worklogGroups,
      now: Date.now()
    })
  }

  /**
   * Every session started this run, live or exited.
   *
   * `sessionCwds` rather than `ptys.list()` on purpose: closing a tab is when a
   * work block usually ends, and a session keeps being the worklog's business
   * after its PTY has gone (see worklog/autoscan.ts). The project list is read
   * once for the whole set — `watchStateFor` reads it per call, which is right
   * for one session and wasteful for twelve.
   */
  async function watchStates(): Promise<WorklogWatchState[]> {
    const settings = getSettings()
    const projects = await listProjects(settings)
    const now = Date.now()
    return [...sessionCwds.keys()].map((sessionId) =>
      watchStateFrom({
        sessionId,
        cwd: cwdForSession(sessionId),
        host: hostForSession(sessionId),
        projects,
        roots: settings.projectRoots,
        worklogGroups: settings.worklogGroups,
        now
      })
    )
  }

  /**
   * Push the whole list.
   *
   * Never a delta, and never from the ContextWatcher tick: the tick runs every
   * 1.5s per session and would push an identical array each time. The triggers
   * are exactly four — a session starting, any settings write, a change to the
   * project list, and the renderer finishing its first load.
   */
  function sendWatchStates(): void {
    void watchStates()
      .then((states) => send(CH.worklogWatchChanged, states))
      .catch((err) => console.warn('[stoke] could not resolve the worklog watch states', err))
  }
  ```

  Add `import { watchStateFrom } from './worklog/watch.ts'` next to the other worklog imports, and
  `WorklogWatchState` to the type import from `@shared/types` on line 5.

- [ ] **Step 2: Make the money path use it.** Replace the AutoScanner's `watched` callback
  (lines 353–368) with:

  ```ts
      watched: async (sessionId) => {
        // `worklogAuto` gates the automatic trigger only; whether a session is the
        // worklog's business at all is watchStateFor's answer, and it is the same
        // answer the tab strip draws. One predicate, so the dot and the run that
        // costs money cannot disagree.
        if (!getSettings().worklogAuto) return false
        return (await watchStateFor(sessionId)).watched
      },
  ```

- [ ] **Step 3: Fire it on the four triggers.** In the same file:

  In `createWindow`, immediately after the `watcher = new ContextWatcher(...)` block ends
  (line 411), add:

  ```ts
    /*
     * Any settings write can change which sessions are watched — a profile
     * ticked, a host switched on, a scan root added. Settings changes are
     * user-paced, so recomputing unconditionally is cheaper than working out
     * whether this particular write mattered.
     */
    const offSettings = onSettingsChanged(() => sendWatchStates())
    win.webContents.on('did-finish-load', () => sendWatchStates())
  ```

  and in the `win.on('closed', ...)` handler add `offSettings()` as its first statement.

  Add `onSettingsChanged` to the existing `./store.ts` import on line 27.

  In the `ptyStart` handler (line 530), replace it with:

  ```ts
    ipcMain.handle(CH.ptyStart, async (_e, opts: LaunchOptions) => {
      const result = await launchSession(opts)
      // After launchSession, so sessionCwds already holds the new id — the state
      // for a session nobody has recorded a folder for is 'unknown-folder', which
      // would be wrong and would not correct itself until the next settings write.
      sendWatchStates()
      return result
    })
  ```

  In `projectsAddRoot` (line 483), add `sendWatchStates()` immediately before `return dir`.
  In `projectsAdd` (line 498) and `projectsHide` (line 511), add `sendWatchStates()` immediately
  before each `return`. (A folder becoming a project, or a scan root appearing, changes which group
  a cwd resolves to.)

- [ ] **Step 4: Add the handler and the bridge.** In the worklog handler block, next to
  `ipcMain.handle(CH.worklogQueue, ...)` (line 711), add:

  ```ts
    ipcMain.handle(CH.worklogWatch, () => watchStates())
  ```

  In `/Users/thevinh/dev/personal/stoke/src/preload/index.ts`, add to the `worklog` object:

  ```ts
      watch: () => ipcRenderer.invoke(CH.worklogWatch),
      onWatchChanged: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogWatchChanged, cb),
  ```

  In `/Users/thevinh/dev/personal/stoke/src/shared/api.ts`, add to the `worklog` block:

  ```ts
      /**
       * Which sessions the agent may look at, and why. The whole list every time,
       * never a delta — two copies of the same records drift.
       */
      watch(): Promise<WorklogWatchState[]>
      onWatchChanged(cb: (states: WorklogWatchState[]) => void): () => void
  ```

  adding `WorklogWatchState` to that file's import from `./types`.

- [ ] **Step 5: Typecheck and run the suites.**
  `npm run typecheck` exits 0, then `npm run check` exits 0.

- [ ] **Step 6: Prove the root fallback works on the real machine.** This is the fix worth
  measuring, because spec §2.4.3 established it by measurement: 5 of 12 work subfolders were
  watched. Launch `npx electron . --remote-debugging-port=9222`, make sure Settings ›
  Worklog agent has the profile covering `work` ticked and that `/Users/thevinh/dev/work` is a
  scan root (spec §6 asks for exactly that repair), then start a session in a `work` subfolder that
  has no Claude history of its own and evaluate in the renderer console:

  ```js
  window.stoke.worklog.onWatchChanged((s) => console.log('watch', s))
  await window.stoke.worklog.watch()
  ```

  Expected: an array holding one object per open session, and for that subfolder
  `{ watched: true, reason: 'watched-group', group: 'work', remote: false }`. Before this task the
  same folder resolved to group `dev` and `watched: false`. Then tick a different profile in
  Settings and confirm a `watch` line logs without touching anything else — that is trigger 2.

- [ ] **Step 7: Commit.**
  `git commit -m "Watch the folders under a scan root, and let the renderer see what is watched"`
  Body records: `/Users/thevinh/dev/work` is itself a registered Claude project, so the
  longest-prefix rule matched it and answered `dev` for every sibling — 5 of 12 work folders were
  watched and nothing anywhere said so; and the watch decision now reaches the renderer, on four
  triggers and never from the context tick.

---

### Task 29: The panel says whether this thing is on, and what it last did

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/worklog.ts` (append),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/WorklogPanel.tsx` (props at
  lines 6–15, the head at 108–135, the empty state at 184–201),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (worklog state at lines 75–82,
  the subscription block at 139–153, the panel render at 852–864),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (next to `.worklog-note`,
  line 1203)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts` (the sentences are
  pure), then CDP for the rendering

**Interfaces:**
- Consumes: `window.stoke.worklog.watch()`, `.onWatchChanged()`, `.lastScan()`, `.onScanned()`
  (Tasks 26 and 28); `type WorklogWatchState`, `type WorklogScanReport` from `@shared/types`;
  `relativeTime` from `../lib/format`.
- Produces:
  - `export function watchSentence(state: WorklogWatchState | null, watchedGroups: string[]): string`
    in `src/shared/worklog.ts`
  - `export function scanSentence(report: WorklogScanReport): string` in `src/shared/worklog.ts`
  - `WorklogPanel` props gain `watch: WorklogWatchState | null`, `watchedGroups: string[]`,
    `lastScan: WorklogScanReport | null`

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts`, before its closing lines,
  adding `import { scanSentence, watchSentence } from '../src/shared/worklog.ts'`:

  ```ts
  console.log('\nwhat the panel says about itself')

  const state = (over: Record<string, unknown> = {}): never =>
    ({
      sessionId: 's1',
      watched: true,
      reason: 'watched-group',
      group: 'gitea-company',
      remote: false,
      decidedAt: 1,
      ...over
    }) as never

  ok(
    'a watched session names its group',
    watchSentence(state(), ['gitea-company']).includes('gitea-company'),
    watchSentence(state(), ['gitea-company'])
  )
  ok(
    'with nothing ticked it says how to turn it on, not merely that it is off',
    /Settings/.test(watchSentence(state({ watched: false, reason: 'off' }), [])),
    watchSentence(state({ watched: false, reason: 'off' }), [])
  )
  ok(
    'an unwatched group says which groups are armed instead',
    watchSentence(state({ watched: false, reason: 'unwatched-group', group: 'personal' }), [
      'gitea-company'
    ]).includes('gitea-company'),
    watchSentence(state({ watched: false, reason: 'unwatched-group', group: 'personal' }), ['gitea-company'])
  )
  ok(
    'a folder that cannot be placed says so rather than blaming the profile',
    /no project/.test(
      watchSentence(state({ watched: false, reason: 'unknown-folder', group: null }), ['gitea-company'])
    )
  )
  ok(
    'a remote session is described by its machine',
    /machine/.test(
      watchSentence(state({ watched: false, reason: 'unwatched-host', group: 'Build box', remote: true }), [])
    )
  )
  ok(
    'and no session at all is its own sentence',
    /No session/.test(watchSentence(null, ['gitea-company'])),
    watchSentence(null, ['gitea-company'])
  )

  const report = (over: Record<string, unknown> = {}): never =>
    ({ sessionId: 's1', at: 1, auto: false, outcome: 'nothing', added: 0, message: null, ...over }) as never

  ok('a scan that proposed says how many', /2 entries/.test(scanSentence(report({ outcome: 'proposed', added: 2 }))))
  ok('one entry is not "1 entries"', /1 entry\b/.test(scanSentence(report({ outcome: 'proposed', added: 1 }))))
  ok('an empty scan says it looked', /nothing worth logging/.test(scanSentence(report())))
  ok(
    'a budget failure says so verbatim, never as an empty result',
    scanSentence(report({ outcome: 'budget', message: 'the recall run stopped at its $0.60 budget ceiling' })).includes('$0.60'),
    scanSentence(report({ outcome: 'budget', message: 'the recall run stopped at its $0.60 budget ceiling' }))
  )
  ok(
    'an error carries its message through',
    scanSentence(report({ outcome: 'error', message: 'no transcript found' })).includes('no transcript found')
  )
  ok(
    'an automatic scan is marked as one',
    /on its own/.test(scanSentence(report({ auto: true }))),
    scanSentence(report({ auto: true }))
  )
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-gate.mts`
  Expected: `SyntaxError: The requested module '../src/shared/worklog.ts' does not provide an
  export named 'watchSentence'`.

- [ ] **Step 3: Write the two sentences.** Append to
  `/Users/thevinh/dev/personal/stoke/src/shared/worklog.ts`:

  ```ts
  import type { WorklogScanReport, WorklogWatchState } from './types'

  /**
   * Whether the worklog is looking at this session, in one sentence.
   *
   * Lives here rather than in the panel because it is a rule, not a layout: the
   * panel, the settings sheet and anything else that has to answer "is this
   * thing on" must give the same answer. Every branch names a next step where
   * there is one — spec §2.4.4's finding was that the feature was silent, and a
   * sentence that only says "no" is barely less silent than nothing.
   */
  export function watchSentence(
    state: WorklogWatchState | null,
    watchedGroups: string[]
  ): string {
    const armed = watchedGroups.filter((g) => g.trim()).join(', ')
    const armedClause = armed ? ` Watching: ${armed}.` : ''

    if (!state) return 'No session is open, so there is nothing to scan.'

    switch (state.reason) {
      case 'watched-host':
        return `This session runs on ${state.group ?? 'another machine'}, which is watched.`
      case 'unwatched-host':
        return `This session runs on ${state.group ?? 'another machine'}. The worklog is switched off for that machine — turn it on under Settings, in the host's own row.`
      case 'watched-group':
        return `This session is watched (${state.group ?? 'no group'}).${armedClause}`
      case 'unwatched-group':
        return `This session is in ${state.group ?? 'no group'}, which is not watched.${armedClause}`
      case 'unknown-folder':
        return `This session's folder belongs to no project and no scan root, so it cannot be placed in a group.${armedClause}`
      case 'off':
      default:
        return 'Nothing is watched yet. Tick a profile under Settings, Worklog agent, and sessions in its folders are reviewed on their own.'
    }
  }

  /** How many entries, worded rather than counted at the call site. */
  function entries(n: number): string {
    return `${n} ${n === 1 ? 'entry' : 'entries'}`
  }

  /**
   * What the last scan did, in one sentence.
   *
   * `budget` is deliberately not folded into `error`: it is the one failure with
   * a fix, and spec §2.4.1 records that it presented as an empty result for the
   * whole life of the feature. The message is shown verbatim because it names a
   * figure the user can act on.
   *
   * Takes no clock: the caller prepends its own "N minutes ago", so nothing
   * shared has to know how this app formats time.
   */
  export function scanSentence(report: WorklogScanReport): string {
    const how = report.auto ? 'Stoke scanned this on its own' : 'A scan'
    switch (report.outcome) {
      case 'proposed':
        return `${how} and proposed ${entries(report.added)}.`
      case 'budget':
        return `${how} stopped early: ${report.message ?? 'it ran out of budget'}.`
      case 'error':
        return `${how} failed: ${report.message ?? 'no reason was reported'}.`
      case 'nothing':
      default:
        return `${how} and found nothing worth logging.`
    }
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  `node scripts/verify-worklog-gate.mts` → `all pass`.

- [ ] **Step 5: Show it in the panel.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/WorklogPanel.tsx`, add to `Props`
  (after `busy`):

  ```ts
    /** Whether the worklog is watching the session in the active tab. Null when none. */
    watch: WorklogWatchState | null
    /** `Settings.worklogGroups`, so the sentence can name what is armed. */
    watchedGroups: string[]
    /** The last scan of any session, so an empty panel is not a blank one. */
    lastScan: WorklogScanReport | null
  ```

  add them to the destructured parameter list, extend the imports to:

  ```ts
  import type { WorklogProposal, WorklogScanReport, WorklogTarget, WorklogWatchState } from '@shared/types'
  import { scanSentence, watchSentence } from '@shared/worklog'
  import { baseName, relativeTime } from '../lib/format'
  ```

  and replace the `{proposals.length > 0 && (<p className="worklog-note">…</p>)}` block
  (lines 133–135) with:

  ```tsx
        {/*
          Always rendered, above everything. The one question this panel could
          never answer was "is this thing even on" — a queue with nothing in it
          looked identical whether the agent was watching and quiet, switched
          off, or dying on its budget every time (spec §2.4.4).
        */}
        <div className="worklog-state">
          <p className="worklog-state-line" data-tone={watch?.watched ? 'on' : 'off'}>
            {watchSentence(watch, watchedGroups)}
          </p>
          {lastScan && (
            <p className="worklog-state-line" data-tone={lastScan.outcome === 'error' || lastScan.outcome === 'budget' ? 'warning' : 'muted'}>
              {relativeTime(lastScan.at)}: {scanSentence(lastScan)}
            </p>
          )}
          {!lastScan && (
            <p className="worklog-state-line" data-tone="muted">
              No session has been scanned since Stoke started.
            </p>
          )}
        </div>

        {proposals.length > 0 && (
          <p className="worklog-note">Nothing is written until you accept it.</p>
        )}
  ```

  and in the empty state (lines 184–201), replace the long `<p>` with:

  ```tsx
              <p>
                A scan reads a session&apos;s transcript, checks what is already on your boards,
                and drafts the difference: a summary, a task for anything left outstanding, or a
                status change to something already tracked. Drafts land here first — nothing
                reaches either service until you accept it.
              </p>
  ```

  (the "watched profiles are scanned on their own" claim moves into the state block above, where it
  is answered for *this* session rather than asserted in general.)

- [ ] **Step 6: Feed it from App.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add next to the other worklog state
  (line 82):

  ```ts
    /*
     * Which sessions the worklog may look at, keyed by session id. Pushed whole
     * on every change rather than merged, because a delta and a full list cannot
     * both be the source of truth.
     */
    const [worklogWatch, setWorklogWatch] = useState<WorklogWatchState[]>([])
    const [worklogLastScan, setWorklogLastScan] = useState<WorklogScanReport | null>(null)
  ```

  in the subscription effect (next to `const offWorklog = ...`, line 139) add:

  ```ts
      const offWatch = window.stoke.worklog.onWatchChanged(setWorklogWatch)
      const offScanned = window.stoke.worklog.onScanned(setWorklogLastScan)
      void window.stoke.worklog.watch().then(setWorklogWatch)
      void window.stoke.worklog.lastScan().then(setWorklogLastScan)
  ```

  and add `offWatch()` and `offScanned()` to that effect's cleanup return alongside the existing
  `offWorklog()`.

  Pass them to the panel (line 855):

  ```tsx
              proposals={worklog}
              busy={worklogBusy}
              watch={
                worklogWatch.find((w) => w.sessionId === activeTab?.sessionId) ?? null
              }
              watchedGroups={settings.worklogGroups}
              lastScan={worklogLastScan}
  ```

  and add `WorklogScanReport` and `WorklogWatchState` to App.tsx's type import from
  `@shared/types`.

- [ ] **Step 7: Style it.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add immediately after the
  `.worklog-note` rule (line 1203):

  ```css
  .worklog-state {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--border);
  }

  .worklog-state-line {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: var(--lh-snug);
    color: var(--text-muted);
  }

  /* The one line that answers "is this thing on". Its own colour, so the answer
     is readable at a glance rather than by reading the sentence. */
  .worklog-state-line[data-tone='on'] {
    color: var(--text);
  }

  .worklog-state-line[data-tone='warning'] {
    color: var(--warning);
  }
  ```

  (`--space-*` and `--lh-*` come from contract Task 4. If that task has not landed yet, it is a
  prerequisite — do not reintroduce `--sp-*`.)

- [ ] **Step 8: See it render.** `npm run typecheck` exits 0, then launch
  `npx electron . --remote-debugging-port=9222`, open a session and the worklog panel, and evaluate
  against the app's own page:

  ```js
  document.querySelector('.worklog-state').innerText
  ```

  Expected, on a machine with nothing ticked: `Nothing is watched yet. Tick a profile under
  Settings, Worklog agent, …` followed by `No session has been scanned since Stoke started.` Tick
  the profile covering the open session's folder in Settings and evaluate again: the first line
  must become `This session is watched (<group>). Watching: <group>.` without reopening the panel.

- [ ] **Step 9: Commit.**
  `git commit -m "Let the worklog panel say whether it is watching this session, and what it last did"`
  Body records: the panel could not distinguish "watching and quiet", "switched off" and "dying on
  its budget every run", and neither could the user — spec §2.4.4.

---

### Task 30: The title-bar button shows disarmed, watching or badged

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/worklog.ts` (append),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (Props at 19–38,
  the worklog button at 149–167), `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`
  (the `<TitleBar>` props at 678–680),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (after `.icon-btn[aria-pressed='true']`, line 533)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts` (the rule is pure),
  then CDP for the attribute

**Interfaces:**
- Consumes: `type WorklogWatchState` from `@shared/types`; the watch list already in App from
  Task 29.
- Produces:
  - `export type WorklogButtonState = 'disarmed' | 'watching' | 'badged'`
  - `export function worklogButtonState(states: WorklogWatchState[], pending: number): WorklogButtonState`
  - `TitleBar` gains the prop `worklogState: WorklogButtonState`; the button renders
    `data-worklog={worklogState}`.

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts`, before its closing lines,
  adding `worklogButtonState` to the `../src/shared/worklog.ts` import added in Task 29:

  ```ts
  console.log('\nwhat the title-bar button is showing')

  const watching = state()
  const off = state({ watched: false, reason: 'off' })

  check('nothing open at all is disarmed', worklogButtonState([], 0), 'disarmed')
  check('every session off is disarmed', worklogButtonState([off, off] as never[], 0), 'disarmed')
  check('a watched session is watching', worklogButtonState([off, watching] as never[], 0), 'watching')
  check('anything pending badges', worklogButtonState([watching] as never[], 3), 'badged')
  /*
   * A pending proposal outranks the switch, and that is a deliberate departure
   * from the contract's ordering. A queue holding work the user has not decided
   * on must be reachable even after they switch every profile off — otherwise
   * turning the feature off hides three real proposals with no way back to them.
   */
  check('and it badges even with everything switched off', worklogButtonState([off] as never[], 1), 'badged')
  check(
    'an unwatched-but-known session is neither armed nor showing anything',
    worklogButtonState([state({ watched: false, reason: 'unwatched-group' })] as never[], 0),
    'disarmed'
  )
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-gate.mts`
  Expected: `SyntaxError: The requested module '../src/shared/worklog.ts' does not provide an
  export named 'worklogButtonState'`.

- [ ] **Step 3: Write the rule.** Append to
  `/Users/thevinh/dev/personal/stoke/src/shared/worklog.ts`:

  ```ts
  /** What the title-bar worklog control is currently saying. */
  export type WorklogButtonState = 'disarmed' | 'watching' | 'badged'

  /**
   * Three states, in this order of precedence:
   *
   *  1. `badged` — something is waiting for a decision. It outranks everything,
   *     including the feature being switched off: a queue holding work the user
   *     has not ruled on has to stay reachable, or turning the agent off would
   *     hide real proposals with no way back to them.
   *  2. `watching` — at least one open session is the agent's business, so
   *     something may appear without being asked for.
   *  3. `disarmed` — nothing is watched and nothing is waiting. The control stays
   *     visible: hiding it made the feature unreachable on a clean install,
   *     because the only way to raise the count was the button inside the panel.
   */
  export function worklogButtonState(
    states: WorklogWatchState[],
    pending: number
  ): WorklogButtonState {
    if (pending > 0) return 'badged'
    return states.some((s) => s.watched) ? 'watching' : 'disarmed'
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  `node scripts/verify-worklog-gate.mts` → `all pass`.

- [ ] **Step 5: Render it.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`, replace the
  `worklogCount` prop declaration (lines 32–34) with:

  ```ts
    /** Proposals awaiting review. Shown in the tooltip; the badge comes from worklogState. */
    worklogCount: number
    /** disarmed / watching / badged — see worklogButtonState. */
    worklogState: WorklogButtonState
    worklogOpen: boolean
  ```

  add `worklogState` to the destructured parameters, add
  `import type { WorklogButtonState } from '@shared/worklog'` to the imports, and replace the
  worklog button (lines 155–167) with:

  ```tsx
          <button
            className="icon-btn"
            data-worklog={worklogState}
            onClick={onToggleWorklog}
            aria-pressed={worklogOpen}
            title={
              worklogCount > 0
                ? `Worklog — ${worklogCount} awaiting review`
                : worklogState === 'watching'
                  ? 'Worklog — watching this session; nothing to review yet'
                  : 'Worklog — nothing is watched. Scan a session, or tick a profile in Settings'
            }
          >
            <IconPin />
            <span className="sr-only">Toggle worklog review</span>
          </button>
  ```

- [ ] **Step 6: Feed it.** In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add
  above the `return` of the component (next to the other `useMemo`s):

  ```ts
    const worklogPending = worklog.filter((p) => p.status === 'pending').length
    const worklogState = useMemo(
      () => worklogButtonState(worklogWatch, worklogPending),
      [worklogWatch, worklogPending]
    )
  ```

  add `import { worklogButtonState } from '@shared/worklog'`, and in the `<TitleBar>` element
  replace `worklogCount={worklog.filter((p) => p.status === 'pending').length}` with:

  ```tsx
          worklogCount={worklogPending}
          worklogState={worklogState}
  ```

- [ ] **Step 7: Style it.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add immediately after the
  `.icon-btn[aria-pressed='true']` rule (line 535):

  ```css
  /* Watching: something may appear here without being asked for. Full-strength
     text rather than muted — a state, not an alert. */
  .icon-btn[data-worklog='watching'] {
    color: var(--text);
  }

  /* Badged: something is waiting for a decision. Deliberately NOT red — red in
     the tab strip means "the worklog is watching this session" and nothing else,
     so a second red here would put the one meaning back into doubt. */
  .icon-btn[data-worklog='badged'] {
    color: var(--accent);
  }

  .icon-btn[data-worklog='badged']::after {
    content: '';
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    width: 0.375rem;
    height: 0.375rem;
    border-radius: var(--r-full);
    background: var(--accent);
  }
  ```

  and add `position: relative;` to the `.icon-btn` rule (line 508) so the dot has something to
  anchor to.

- [ ] **Step 8: Measure it over CDP.** `npm run typecheck` exits 0, then launch
  `npx electron . --remote-debugging-port=9222` and evaluate against the app's own page:

  ```js
  document.querySelector('[data-worklog]').getAttribute('data-worklog')
  ```

  Expected on a machine with nothing ticked and an empty queue: `"disarmed"`. Tick the profile
  covering the open session's folder in Settings, evaluate again: `"watching"`. Then confirm the
  badge dot exists when the queue has a pending item:

  ```js
  getComputedStyle(document.querySelector('[data-worklog]'), '::after').width
  ```

  Expected: `0px`-wide (no box) when disarmed, and `6px` when badged. Screenshot the title bar —
  the terminal beside it is a WebGL canvas, so only a screenshot proves the strip still renders
  (gotcha 5).

- [ ] **Step 9: Commit.**
  `git commit -m "Say on the title bar whether the worklog is armed, watching or holding something"`
  Body records: the button looked identical whether the agent was disarmed, watching or sitting on
  three unreviewed proposals; and that the badge uses the accent rather than red, because red in
  the strip now means exactly one thing.

---

### Task 31: Autoscan baselines survive a restart

`autoscan.ts:148` and `index.ts:69` hold every baseline in memory, so a restart re-baselines every
session (spec §2.4, closing note). A resumed session then has to accumulate six *fresh* messages
before it can ever be scanned, and the hourly ceiling resets with the app — which is a spending
control that anyone can clear by quitting.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscanStore.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscan.ts` (lines 121–136 options,
  146–163 the class head and constructor, 180–201 `observe`, 212–222 `evict`, 255–293 `evaluate`,
  299–328 `run`), `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (the AutoScanner
  construction, lines 351–380)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-autoscan.mts` (append)

**Interfaces:**
- Produces:
  - `export interface StoredActivity { sessionId: string; scannedMessages: number; lastScanAt: number; mutedUntil: number }` (in `autoscan.ts`)
  - `export interface AutoScanSnapshot { sessions: StoredActivity[]; recentScans: number[] }` (in `autoscan.ts`)
  - `AutoScannerOptions` gains `restore?: () => AutoScanSnapshot | null` and
    `persist?: (snapshot: AutoScanSnapshot) => void`
  - `AutoScanner.snapshot(): AutoScanSnapshot`
  - `export function autoScanStateFile(userDataDir: string): string`,
    `export function readAutoScanState(file: string): AutoScanSnapshot`,
    `export function writeAutoScanState(file: string, snapshot: AutoScanSnapshot): void`
    (in `autoscanStore.ts`)

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-autoscan.mts`, before its closing
  lines, adding to its imports:

  ```ts
  import { mkdtempSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import {
    autoScanStateFile,
    readAutoScanState,
    writeAutoScanState
  } from '../src/main/worklog/autoscanStore.ts'
  ```

  and the block:

  ```ts
  console.log('\nwhat survives a restart')

  {
    /*
     * A resumed session arrives with its whole history in the transcript, so the
     * first reading sets the baseline rather than counting as work. Held only in
     * memory, that rule re-fired on every launch: the baseline jumped to the
     * current count and the work done just before the restart could never be
     * logged by anything.
     */
    const restored: AutoScanSnapshot = {
      sessions: [{ sessionId: 's1', scannedMessages: 100, lastScanAt: NOW - 1000, mutedUntil: 0 }],
      recentScans: [NOW - 1000, NOW - 2 * HOUR_MS]
    }
    const scanner = new AutoScanner({
      enabled: () => true,
      watched: () => true,
      scan: async () => 0,
      now: () => NOW,
      restore: () => restored
    })
    scanner.observe('s1', 140, NOW - cfg.idleMs - 1)
    check('a restored baseline is not overwritten by the first reading', scanner.state('s1')?.scannedMessages, 100)
    check('and the last scan time comes back with it', scanner.state('s1')?.lastScanAt, NOW - 1000)
    check(
      'so the 40 messages written before the restart still count as new work',
      autoScanVerdict(scanner.state('s1')!, NOW, [], cfg),
      { scan: true }
    )

    scanner.observe('s2', 12, NOW - cfg.idleMs - 1)
    check('a session nobody stored still baselines on first sight', scanner.state('s2')?.scannedMessages, 12)

    const snap = scanner.snapshot()
    check('scans older than an hour are not carried forward', snap.recentScans, [NOW - 1000])
    check(
      'and nothing is ever persisted mid-scan',
      snap.sessions.every((s) => !('scanning' in s)),
      true
    )
    scanner.dispose()
  }

  {
    /*
     * The hourly ceiling is a spending control. Held in memory it was cleared by
     * quitting the app, which is not a control at all.
     */
    const spent = Array.from({ length: DEFAULT_AUTOSCAN.maxPerHour }, (_, i) => NOW - i * 1000)
    const scanner = new AutoScanner({
      enabled: () => true,
      watched: () => true,
      scan: async () => 0,
      now: () => NOW,
      restore: () => ({ sessions: [], recentScans: spent })
    })
    scanner.observe('s1', 40, NOW - cfg.idleMs - 1)
    check(
      'the hourly ceiling survives a restart',
      autoScanVerdict(scanner.state('s1')!, NOW, scanner.snapshot().recentScans, cfg),
      { scan: false, reason: 'hourly-limit' }
    )
    scanner.dispose()
  }

  console.log('\nthe file it survives in')
  {
    const dir = mkdtempSync(join(tmpdir(), 'stoke-autoscan-'))
    const file = autoScanStateFile(dir)
    const written: AutoScanSnapshot = {
      sessions: [{ sessionId: 's1', scannedMessages: 7, lastScanAt: 3, mutedUntil: 4 }],
      recentScans: [1, 2]
    }
    writeAutoScanState(file, written)
    check('it round-trips', readAutoScanState(file), written)
    check('a missing file is an empty state, not a crash', readAutoScanState(join(dir, 'nope.json')), {
      sessions: [],
      recentScans: []
    })
    writeAutoScanState(file, { sessions: [{ sessionId: '', scannedMessages: 1, lastScanAt: 0, mutedUntil: 0 }], recentScans: ['x' as never] })
    check('and junk is dropped rather than restored', readAutoScanState(file), { sessions: [], recentScans: [] })
    rmSync(dir, { recursive: true, force: true })
  }
  ```

  Add `AutoScanSnapshot` to the type import from `../src/main/worklog/autoscan.ts`.

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-autoscan.mts`
  Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscanStore.ts'`.

- [ ] **Step 3: Declare the stored shape and restore from it.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscan.ts`, add above `AutoScannerOptions`
  (line 121):

  ```ts
  /**
   * The part of a session's activity worth keeping across a restart.
   *
   * Note what is NOT here: `messageCount`, `updatedAt` and `scanning`.
   *
   * The first two are re-read off the transcript within a tick of launching, so
   * storing them would only create a chance of them being wrong. `scanning`
   * cannot survive a restart by definition — the run it referred to died with the
   * process — and persisting it as true would leave a session permanently
   * unscannable, because `scanning` is the flag every other path checks.
   */
  export interface StoredActivity {
    sessionId: string
    scannedMessages: number
    lastScanAt: number
    mutedUntil: number
  }

  export interface AutoScanSnapshot {
    sessions: StoredActivity[]
    /** Start times of automatic scans, so the hourly ceiling is not cleared by
     *  quitting the app — which would make it not a ceiling. */
    recentScans: number[]
  }
  ```

  add to `AutoScannerOptions` (after `now?`):

  ```ts
    /** Read the state left by the last run. Called once, in the constructor. */
    restore?: () => AutoScanSnapshot | null
    /**
     * Write the state out. Called at the two points that change it: after a scan
     * finishes, and when the gate mutes a session.
     *
     * Deliberately not called on `observe`, which runs on every context reading —
     * that would be a disk write per session per 1.5s for a value that is
     * re-derived at launch anyway.
     */
    persist?: (snapshot: AutoScanSnapshot) => void
  ```

- [ ] **Step 4: Use it in the class.** In the same file, add the field beside the others
  (line 148):

  ```ts
    /** Baselines from the last run, consumed the first time each session is seen. */
    private readonly restored = new Map<string, StoredActivity>()
  ```

  extend the constructor (line 159) to:

  ```ts
    constructor(opts: AutoScannerOptions) {
      this.opts = opts
      this.config = { ...DEFAULT_AUTOSCAN, ...opts.config }
      this.now = opts.now ?? Date.now
      const saved = opts.restore?.() ?? null
      if (saved) {
        const now = this.now()
        // Only the last hour matters to the ceiling, and a stored list from
        // yesterday would otherwise suppress today's first six scans.
        for (const t of saved.recentScans) {
          if (typeof t === 'number' && now - t < HOUR_MS) this.recentScans.push(t)
        }
        this.recentScans.sort((a, b) => a - b)
        // Newest first, then capped: a file from a long-running install must not
        // be able to grow this map beyond what the live one is allowed.
        const ordered = [...saved.sessions].sort((a, b) => b.lastScanAt - a.lastScanAt)
        for (const s of ordered.slice(0, MAX_TRACKED)) this.restored.set(s.sessionId, s)
      }
    }
  ```

  replace the first-sight branch of `observe` (lines 183–194) with:

  ```ts
      if (!found) {
        /*
         * A baseline from the last run beats a fresh one.
         *
         * Without it, restarting Stoke re-baselined every resumed session to its
         * current message count — so the work done in the minutes before the
         * restart became invisible to the scanner and was never logged by
         * anything. The rule "a resumed session's history is not new work" still
         * holds for a session this install has genuinely never seen.
         */
        const prior = this.restored.get(sessionId)
        this.restored.delete(sessionId)
        this.sessions.set(sessionId, {
          sessionId,
          messageCount,
          updatedAt,
          scannedMessages: prior ? Math.min(prior.scannedMessages, messageCount) : messageCount,
          lastScanAt: prior?.lastScanAt ?? 0,
          scanning: false,
          mutedUntil: prior?.mutedUntil ?? 0
        })
        this.evict()
        return
      }
  ```

  and add, next to `state()` (line 224):

  ```ts
    /**
     * What is worth writing down. Public so the caller owns the disk and this
     * file keeps importing nothing.
     *
     * `scanning` is dropped rather than stored — see StoredActivity.
     */
    snapshot(): AutoScanSnapshot {
      const now = this.now()
      return {
        sessions: [...this.sessions.values()].map((s) => ({
          sessionId: s.sessionId,
          scannedMessages: s.scannedMessages,
          lastScanAt: s.lastScanAt,
          mutedUntil: s.mutedUntil
        })),
        recentScans: this.recentScans.filter((t) => now - t < HOUR_MS)
      }
    }

    /** Write the state out, if the caller gave us somewhere to write it. */
    private save(): void {
      try {
        this.opts.persist?.(this.snapshot())
      } catch (err) {
        // A state file that cannot be written is a slower feature, not a broken
        // one. Never take the scanner down over a cache.
        console.error('[stoke] failed to persist the autoscan state', err)
      }
    }
  ```

- [ ] **Step 5: Save at the two points that matter.** In `evaluate` (line 276), the `if (!watched)`
  branch becomes:

  ```ts
          if (!watched) {
            session.scanning = false
            session.mutedUntil = this.now() + this.config.cooldownMs
            /*
             * Written here, after the await and after the claim is released.
             * CLAUDE.md gotcha 20: an await inside a polling pass is a window,
             * and the state written must be the state a second pass would see —
             * `scanning: false`, muted until a known time. Snapshotting before
             * the await would persist a claim that no longer exists.
             */
            this.save()
            continue
          }
  ```

  and in `run` (line 325), the `finally` becomes:

  ```ts
      } finally {
        session.scanning = false
        /*
         * After `scanning` is cleared, never before. The snapshot deliberately
         * cannot carry a scan in flight — a process that dies mid-scan must come
         * back able to scan that session again, and a stored `scanning: true`
         * would make it permanently ineligible.
         */
        this.save()
      }
    }
  ```

- [ ] **Step 6: Create the disk half.** Create
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscanStore.ts`:

  ```ts
  import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
  import { dirname, join } from 'node:path'
  import type { AutoScanSnapshot, StoredActivity } from './autoscan.ts'

  /**
   * Where the auto-scanner's baselines live between runs.
   *
   * Separate from autoscan.ts so that module keeps importing nothing at all and
   * scripts/verify-worklog-autoscan.mts can exercise every rule against a clock
   * it controls. The userData directory is passed in rather than read from
   * electron's `app`, exactly as the queue does — importing electron would stop
   * this loading under plain node and take the tests with it.
   *
   * Everything read from this file is repaired or dropped. It is a cache: a
   * corrupt one must cost at most one re-baselined session, never a launch.
   */

  export const AUTOSCAN_STATE_FILENAME = 'worklog-autoscan.json'

  export function autoScanStateFile(userDataDir: string): string {
    return join(userDataDir, AUTOSCAN_STATE_FILENAME)
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v)
  }

  function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  function activity(v: unknown): StoredActivity | null {
    if (!isRecord(v)) return null
    const sessionId = typeof v.sessionId === 'string' ? v.sessionId : ''
    const scannedMessages = num(v.scannedMessages)
    // A record with no session id addresses nothing, and one with no baseline is
    // the very thing this file exists to carry. Either way it is not a record.
    if (!sessionId || scannedMessages === null) return null
    return {
      sessionId,
      scannedMessages,
      lastScanAt: num(v.lastScanAt) ?? 0,
      mutedUntil: num(v.mutedUntil) ?? 0
    }
  }

  /** Never throws. A state file that cannot be read is an empty state. */
  export function readAutoScanState(file: string): AutoScanSnapshot {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!isRecord(raw)) return { sessions: [], recentScans: [] }
      const sessions = Array.isArray(raw.sessions)
        ? raw.sessions.map(activity).filter((s): s is StoredActivity => s !== null)
        : []
      const recentScans = Array.isArray(raw.recentScans)
        ? raw.recentScans.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
        : []
      return { sessions, recentScans }
    } catch {
      // Missing (the normal first run) or corrupt. Both mean there is nothing to
      // restore, and refusing to start would take the app down over a cache.
      return { sessions: [], recentScans: [] }
    }
  }

  /** Temp file + rename, so a crash mid-write cannot truncate the state. */
  export function writeAutoScanState(file: string, snapshot: AutoScanSnapshot): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      console.error('[stoke] failed to persist the autoscan state', err)
    }
  }
  ```

- [ ] **Step 7: Run it and watch it pass.**
  `node scripts/verify-worklog-autoscan.mts` → `all pass`.

- [ ] **Step 8: Wire it into the app.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, add above the `autoscan = new AutoScanner(`
  line (351):

  ```ts
    const autoscanState = autoScanStateFile(app.getPath('userData'))
  ```

  and add to the options object, after `scan:`:

  ```ts
      // Baselines and the hourly ceiling survive a restart. Without this, quitting
      // re-baselined every resumed session — so the work done just before a
      // restart was invisible to the scanner — and cleared the spending ceiling,
      // which made it not a ceiling.
      restore: () => readAutoScanState(autoscanState),
      persist: (snapshot) => writeAutoScanState(autoscanState, snapshot)
  ```

  with `import { autoScanStateFile, readAutoScanState, writeAutoScanState } from './worklog/autoscanStore.ts'`
  beside the other worklog imports.

- [ ] **Step 9: See the file appear.** `npm run check` exits 0. Then launch
  `npx electron . --remote-debugging-port=9222` with a watched profile ticked, let one automatic
  scan run (or force one from the panel — a manual scan does not write this file; the automatic
  path does), quit, and check:

  ```bash
  cat "$HOME/Library/Application Support/Stoke (dev)/worklog-autoscan.json"
  ```

  Expected: a JSON object with a `sessions` array whose entries carry `sessionId`,
  `scannedMessages`, `lastScanAt` and `mutedUntil` — and **no** `scanning` key anywhere in it.
  Relaunch and confirm the same session is not immediately re-proposed.

- [ ] **Step 10: Commit.**
  `git commit -m "Keep the autoscan baselines and the hourly ceiling across a restart"`
  Body records: every baseline lived in memory, so quitting re-baselined each resumed session to its
  current message count and the work done just before the restart could never be logged; and the
  six-an-hour ceiling was cleared by quitting, which made it not a ceiling. `scanning` is
  deliberately never persisted — a stored claim would leave a session permanently unscannable
  (CLAUDE.md gotcha 20).
