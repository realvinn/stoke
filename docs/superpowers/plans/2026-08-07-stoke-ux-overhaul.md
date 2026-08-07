# Stoke UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the nine reported UX defects in Stoke — the context meter, the usage chip, the
in-terminal status line, the worklog that never runs, folders that cannot be added, the tab strip,
profiles that do not follow tabs, the sidebar and the spacing scale — by landing 74 independently
testable, individually committed changes.

**Architecture:** Stoke is an Electron desktop shell that wraps the **real `claude` CLI in a PTY**,
so skills, MCP, plugins, hooks and the whole TUI keep working untouched; the main process owns the
PTY, project discovery, the docked Chromium browser, the MCP server and the worklog agent, and a
React renderer draws every pixel through CSS custom properties. This overhaul adds one new data
channel — Stoke installs its own `statusLine` command into the single existing `--settings` file,
and the JSON the CLI pipes to it replaces the banner regex, the observed-usage tier inference and
the OAuth account call at once. Everything else here is a correction to code that already exists:
one shared path rule instead of two, one settings schema that can be tested without Electron, one
4px spacing scale, and one meaning for red.

**Tech Stack:** Electron (main + preload + renderer), electron-vite, React 19, xterm.js with the
WebGL renderer, `@lydell/node-pty`, `@modelcontextprotocol/sdk`, plain CSS custom properties (no
Tailwind, no component library), and verify suites written as standalone `scripts/verify-*.mts`
files run by `node --experimental-strip-types` and chained into `npm run check`. **There is no test
framework and none is being added.**

---

## How this document is organised

Seventy-four tasks, numbered **1–74**, in the order they must be executed. They came from seven
drafts written in parallel — a contracts section and six workstreams, **A** (title bar and tabs),
**B** (profiles), **C** (worklog), **D** (folders), **E** (statusLine channel and terminal widths)
and **F** (sidebar and spacing). Cross-references keep the workstream letter, so "C Task 28" and
"Task 28" are the same task; the letter tells you which workstream it belongs to and nothing more.

**Reads with:** `docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-design.md` (authoritative for
*what* and *why*), `docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md`
(sections §0.1–§0.10: the shared types, channels, tokens and module ownership every task cites by
number), `CLAUDE.md`, `ARCHITECTURE.md`.

**Where each task came from**, for anyone holding an older draft:

| Task | Origin | Task | Origin | Task | Origin |
|---|---|---|---|---|---|
| 1–3 | contracts 1–3 | 22–26 | C 23, 24, 25, 26, 26b | 48–56 | A 81–89 |
| 4 | contracts 4a | 27–33 | C 27, 28, 29, 30, 31, 31b, 33 | 57–59 | A 90a, 90b, 90c |
| 5 | contracts 5 | 34–41 | D 40–47 | 60–63 | A 91–94 |
| 6–17 | E 68–79 | 42–47 | B 61–66 | 64 | F 109 |
| 18–21 | C 20, 21, 22, 32 | | | 65–74 | F 112–115, 117–122 |

> **Line numbers in this plan are hints, not addresses.** Four workstreams insert into
> `src/renderer/src/App.tsx`, `src/renderer/src/styles/app.css`, `src/main/index.ts`,
> `src/renderer/src/components/TitleBar.tsx`, `src/renderer/src/components/Sidebar.tsx` and four
> verify suites, so any figure written as "currently line N" is correct only for the first task that
> runs. **Locate every edit by the quoted text**, not by the number: for CSS, by the selector
> (`grep -n "^\.project-meta {" src/renderer/src/styles/app.css`); for TS/TSX, by a unique quoted
> line from the block being replaced; for the verify suites, by **that suite's own** closing
> summary/exit pair, quoted in the list below, inserting immediately above the first line of it.
> If the quoted text is not found, stop — a prerequisite task has not landed
> or has landed differently, and guessing at the location is how two parts silently overwrite each
> other.

**The closing pair is not one anchor — it is five.** "The file's closing two lines" is true of the
suites copied from `verify-worklog-gate.mts` and false of four others that predate it, so grepping
for the gate's wording in `verify-context.mts` finds nothing and the executor guesses. The exact
pair, per suite this plan appends to:

- `verify-worklog-gate.mts`, `verify-worklog-recall.mts`, `verify-worklog-runner.mts`,
  `verify-worklog-autoscan.mts`, `verify-profiles.mts` — and the five suites this plan creates
  (`verify-settings.mts`, `verify-statusline.mts`, `verify-unicode.mts`, `verify-folders.mts`,
  `verify-tabs.mts`, all of which copy that shape):
  `` console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`) `` then
  `process.exitCode = failures ? 1 : 0`.
- `verify-usage.mts` — same `console.log`, but a **three-line comment** about the libuv assertion
  sits between it and `process.exitCode = failures ? 1 : 0`. Insert above the `console.log`; never
  between the comment and the assignment.
- `verify-worklog-retry.mts` — the counter is `failed`, not `failures`:
  ``console.log(failed === 0 ? '\nall pass' : `\n${failed} failure(s)`)`` then
  `process.exitCode = failed === 0 ? 0 : 1`.
- `verify-color.mts` — a different message and `process.exit`, not `process.exitCode`:
  ``console.log(failures ? `\n${failures} failure(s)` : '\nall colour checks pass')`` then
  `process.exit(failures ? 1 : 0)`.
- `verify-context.mts` — `failures` is an **array** here, and the wording is different again:
  `` console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join(', ')}`}`) ``
  then `process.exit(failures.length === 0 ? 0 : 1)`.

`verify-ssh.mts` prints one more line above its pair —
`` console.log(`\nconfig read from: ${sshConfigPath()}  (home ${homedir()})`) `` — so "the closing
two lines" would land an insertion between that line and the summary. No task here appends to it;
if one ever does, go above that line.

---

## Global Constraints

**House rules — every task obeys all of these.**

- **Relative imports in `src/main` carry an explicit `.ts` extension** (`from '../../shared/paths.ts'`).
  That is what lets the main-process modules run directly under `node --experimental-strip-types`,
  which is how the verify suites test them with no build step.
- **Shared modules (`src/shared/**`) use extensionless relative imports for TYPE-only imports** —
  strip-types erases them — **and an explicit `.ts` for VALUE imports.** `import { foldGroup } from
  './paths.ts'` in `src/shared/profiles.ts` (Task 1) is the first value import between two shared
  modules in the tree. Note it is an `import` plus a separate `export { foldGroup }`, never a bare
  `export … from`: a re-export creates no local binding, and `profiles.ts` calls `foldGroup` at
  eleven of its own call sites. Both
  tsconfigs are `noEmit`, so `allowImportingTsExtensions` is legal, and `tsconfig.node.json` already
  sets it — `tsconfig.node.json:9`, under the comment at `:6-8` explaining why. `tsconfig.json` and
  `tsconfig.web.json` do **not** set it; Task 1 Steps 5a–5b add it to those two. The house-style
  example of the import itself is `src/main/mcp/design.ts:11-16`.
- **A value import of `@shared/*` from a strip-types module breaks its suite at runtime** with
  `ERR_MODULE_NOT_FOUND`, not at compile time. The alias is fine for type-only imports.
- **`src/shared/**` is compiled by both tsconfigs and `tsconfig.web.json` gives it no Node types.**
  No `import 'node:path'`, no bare `process` in a shared module. Pass the platform in instead.
- **No TypeScript parameter properties in main-process classes.** Node's strip-only mode rejects
  them; assign fields explicitly in the constructor.
- **All colour goes through CSS custom properties.** Never hardcode a hex in a component; themes are
  swapped by writing variables onto `:root` (`src/renderer/src/lib/theme.ts`). No Tailwind, no
  component library — a standing preference, not an accident.
- **IPC channel names live in `src/shared/ipc.ts`. Add there first** (Task 2 adds all seven this
  plan needs: `projects:meta`, `statusline:update`, `statusline:last`, `worklog:watch`,
  `worklog:watchChanged`, `worklog:scanned`, `worklog:lastScan`).
- **Tests are standalone `scripts/verify-*.mts` scripts** run under `node --experimental-strip-types`,
  with the `check(name, got, want)` / `ok(name, condition, detail)` helper and the closing
  `` console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`) `` +
  `process.exitCode = failures ? 1 : 0` pair copied from `verify-worklog-gate.mts`. **No test
  framework.** `scripts/` is in neither tsconfig `include`, so a type error there surfaces only when
  the suite runs — run the suite.
- **`npm run check` must pass** before any task is called done. Every registration into its `check`
  chain is an **insertion**; no step may quote or retype the whole line. Six tasks add to it, and a
  pasted "so the whole line now reads…" silently deletes whatever the other five added and nothing
  fails. What guards against that is a `node -e` over `scripts.check`, run immediately after each
  insertion. **Its expected output never varies: it prints nothing and exits 0.** The array it
  iterates does vary — each registering task checks the suites that exist *at that point in the
  order*, never ones a later task creates. A guard that is expected to fail proves nothing and
  trains the executor to ignore it; with the right array, any output at all is a real regression —
  a suite that was in `check` and is no longer. The six commands, in the order they are run:

  ```bash
  # Task 3, after inserting verify:settings
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','profiles','settings','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"

  # Task 6, after inserting verify:unicode
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','unicode','profiles','settings','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"

  # Task 7, after inserting verify:statusline
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','profiles','settings','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"

  # Task 17, after inserting verify:usage
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','usage','profiles','settings','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"

  # Task 34, after inserting verify:folders
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','usage','profiles','settings','folders','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"

  # Task 55, after inserting verify:tabs — the full fifteen
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','usage','profiles','settings','folders','color','worklog-gate','tabs','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"
  ```

  The nine names Task 3's array starts from are the suites `check` runs today; none of them may
  ever leave it. The final chain order is `context → statusline → unicode → usage`, and
  `settings → folders` after `profiles`, with `tabs` after `worklog-gate`.
- **`npm run check` is machine-independent with exactly one grandfathered exception, and every
  suite this plan adds must keep it that way.** `scripts/verify-context.mts` reads
  `join(homedir(), '.claude', 'projects')` at `verify-context.mts:15`, samples the six largest
  transcripts it finds there, and asserts `'at least one transcript yielded messages'`; it then
  takes `basename(sample[0].path)` as a live session id for the watcher half. On a machine with no
  Claude transcripts that suite does not fail an assertion — it **throws** at the first `readdir`
  with `ENOENT: no such file or directory, scandir '<home>/.claude/projects'`, and `check` stops
  there. That is pre-existing, it predates this plan, and this plan does not change it: CLAUDE.md
  already describes the suite as running "against the real transcripts on this machine", and it is
  credited there with catching two genuine bugs precisely *because* it reads real data. A version
  that printed "no transcripts, skipping" and exited 0 would be green on a machine where the context
  meter is completely untested, which is the failure mode CLAUDE.md gotcha 9 exists to warn about.

  So the rule is narrower than "check passes everywhere", and it is this: **`check` must pass on
  any machine that has ever run Claude Code, and no suite added or edited by this plan may add a
  second machine-dependent assertion.** Concretely — no `homedir()`, no `process.platform` branch
  that asserts rather than describes, no hard-coded `/Users/thevinh` or `dev/work` path, and no
  live network or account call inside a suite that `check` runs. Anything that needs this
  machine's real configuration goes in a separate mode that `check` does not invoke, which is what
  D Task 41's `--verify` is and why it is kept out (Task 41 Step 5 greps for exactly those tokens
  in `verify-folders.mts`). E Task 12 adds five assertions to `verify-context.mts` and every one of
  them writes its own payload fixture and deletes it again; it adds no new dependency on this
  machine's contents.
- **UI work is verified by measuring the running app over CDP, and by screenshot.** One probe,
  `scripts/cdp-eval.mjs` (Task 5), is used by every measurement step in the plan; no task writes its
  own. It has the page stringify the value, so **every expected output in this plan is compact JSON
  on one line** — `{"before":"block"}`, never `{ "before": "block" }`. Launch with
  `npm run build && npx electron . --remote-debugging-port=9222 &`.
- **Commit messages explain *why*, and record any bug the change fixes.** One commit per task.

**The 4px scale — exact old → new mapping.** Declared by Task 4, applied in one commit by Task 64.
The whole `--sp-1 … --sp-8` block is **deleted**, not renumbered: a missed `var(--sp-2)` then
resolves to nothing, the declaration is invalid at computed-value time, and the padding visibly
collapses to 0 — loud and greppable, where a renumbered `--sp-4` would silently mean 4px where it
used to mean 12px.

The **Uses** columns count `var(--sp-N)` occurrences, not lines, and they are split by scope
because Task 64 sweeps three of them and a single repo-wide figure hides the half that a
stylesheet-only grep never reports. Counted with
`grep -o -- "var(--sp-N)" <file> | wc -l` on the tree as it stands today.

| Old | Old px | New | New px | Uses: `app.css` | Uses: eight `.tsx` | Uses: `src/remote` | Note |
|---|---|---|---|---|---|---|---|
| `--sp-1` | 4 | `--space-4` | 4 | 16 | 0 | 0 | unchanged |
| `--sp-2` | 6 | `--space-8` | 8 | 51 | 19 | 1 | **+2px** |
| `--sp-3` | 8 | `--space-8` | 8 | 41 | 5 | 0 | unchanged |
| `--sp-4` | 12 | `--space-12` | 12 | 17 | 1 | 0 | unchanged |
| `--sp-5` | 16 | `--space-16` | 16 | 6 | 0 | 0 | unchanged |
| `--sp-6` | 20 | `--space-24` | 24 | 1 | 1 | 0 | **+4px** |
| `--sp-7` | 28 | `--space-24` | 24 | 2 | 0 | 0 | **−4px** |
| `--sp-8` | 40 | `--space-48` | 48 | 0 | 0 | 0 | defined for completeness |
| **total** | | | | **134** | **26** | **1** | 161 repo-wide |

The eight `.tsx` files are `HostsSettings`, `Launcher`, `ProfilesSettings`, `CommandPalette`,
`Sidebar`, `SettingsSheet`, `RemoteSettings` and `WorklogSettings`, all under
`/Users/thevinh/dev/personal/stoke/src/renderer/src/components/`; their uses are inside
`style={{ }}` objects, which is why a `.css`-only sweep leaves them naming a token that no longer
exists.

`--sp-2` rounds **up**: it is the most-used token in the file and overwhelmingly the inner padding
of controls, and rounding it to 4px collapses control heights below the 28px the tab strip and title
bar are built on. `--sp-7` rounds **down** to 24 rather than up to 32: its two uses are both outer
padding — `.launcher` at `app.css:957` and `.empty` at `app.css:1044` — where 32px starts reading as
a gutter rather than as breathing room. `--sp-6` rounds **up** to 24 rather than down to 16: its two
uses are `.sheet-body`'s section `gap` at `app.css:1714` and the command palette's empty-state
padding at `CommandPalette.tsx:91`, and 16px would make that gap exactly equal `.sheet-body`'s own
`padding: var(--sp-5)`, flattening the section rhythm the gap exists to create.
Expect **116 declarations to become 8px** — 92 in `app.css` and
24 in the eight `.tsx` files — and **four** to become 24px (three in `app.css`, one in
`CommandPalette.tsx`). That is the visible density change, and it is why Task 74 reviews every
screen afterwards. `src/remote/style.css:526`'s `var(--sp-2, 8px)` names a token that file never defines,
so it already renders at 8px; it becomes a literal `8px` rather than a `--space-*` token, because
the phone bundle is a separate build that imports none of them.

Guard, and it must be this command: `grep -rn -- '--sp-' src/ | wc -l` prints **0** after Task 64,
and prints **141** today. Do **not** use `grep -rc`, which prints one `<file>:<count>` line per
searched file — 76 lines today, 66 of them reading `:0` — so it can never print a bare `0` and
never prints `141`. The two figures differ in kind: 141 is the number of *lines* holding a `--sp-`
(8 declarations, 132 use-lines, 1 dangling), while the 161 in the table is the number of *token
occurrences*, several of which share a line.

**Gotchas from `CLAUDE.md` that constrain more than one workstream.** Read all twenty before
starting; these five bound tasks in several parts at once.

- **6 — the docked browser is its own CDP target.** A test script that attaches by `type === 'page'`
  and picks by URL drives the wrong page: the browser view exists precisely to show `localhost:<port>`,
  `file://` and `/index.html` pages. `scripts/cdp-eval.mjs` discriminates on the `window.stoke`
  contextBridge object, which only the renderer has.
- **14 — a native `WebContentsView` paints above all renderer DOM.** Any panel that must stay visible
  while the browser is open has to be a sibling column in `.body-row`, never an overlay. `.app` is a
  fixed three-row grid (`titlebar / body / status`), so a new full-width strip goes *inside*
  `.main-col`; adding a fourth row silently shifts the status bar into the body's track. Related:
  `.app` needs its explicit `grid-template-columns: minmax(0, 1fr)` — left implicit, any row that
  resists shrinking makes the whole shell wider than the window rather than clipping itself.
- **17 — the queue's dedupe key is load-bearing beyond dedupe.** Proposal ids are its sha1 and
  rejections are tombstones keyed on it, so changing the key format for a `create` silently
  resurrects every proposal the user has ever rejected. Updates got their own key shape
  (`sessionId|update|board:id`) precisely so the create key could stay byte-for-byte. **Nothing in
  this plan touches `WorklogProposal.id`, its inputs, or the `create` key format.**
- **19 — do not add flags to a user's remote connect command.** A remote `claude` that does not know
  `--session-id` exits with an unknown-option error and the terminal itself then breaks on every
  connection to that host. `sshTranscript.ts` asks for the newest transcript instead; two Claude
  sessions on one host at once cannot be told apart, and that cost is accepted.
- **20 — an `await` inside a polling pass is a window two passes can both walk through.**
  `AutoScanner.evaluate()` awaits the gate, so a pass can outlive its own 15s interval; without a
  reentrancy guard *and* claiming the session **before** the await, two overlapping passes each start
  a paid scan for the same session. Setting the claim after the await is not enough — that *is* the
  window.

Two more that bite repeatedly below: **5** — xterm draws through WebGL, so `.xterm-rows` is empty
and terminal output can only be confirmed from a screenshot; and **15** — `--safe-mode` and MCP are
mutually exclusive, which is why the worklog reads its boards in a separate `recall.ts` run and
keeps the scan itself hermetic.

---

## Order of work

Fifteen positions. Every part is contiguous, so the plan is executed straight through, 1 to 74.

| # | Tasks | Why here |
|---|---|---|
| 1 | **1–3** | They create `src/shared/paths.ts`, the new `src/shared/types.ts` blocks, the rewritten `src/renderer/src/types.ts` (`TabKind`, and `Tab`'s `kind` / `hostId` / `selectedPath` / `expandedPath` — Task 2 Step 6a, the only step in the plan that writes that file), the seven `src/shared/ipc.ts` channels, `src/shared/worklog.ts`, `src/shared/ui.ts` and `src/main/settingsSchema.ts`. Every workstream imports at least one. Task 1 also carries the `.ts`-extension re-export and both `allowImportingTsExtensions` flags, without which its own Step 6 (`node scripts/verify-profiles.mts` → `all pass`) is unreachable. |
| 2 | **4** | Declares every new token *alongside* the existing `--sp-*` block, changing no existing declaration. Nothing may reference them yet except the tasks that land the rules using them. Its verification is that nothing moved. |
| 3 | **5** | `scripts/cdp-eval.mjs` is the harness for ~30 measurement steps across five workstreams. It must precede Task 4's measurement step; if Task 4 runs first, that one step waits for this. |
| 4 | **6** | The Unicode width fix is independent of the payload work and touches only `TerminalView.tsx`, `package.json` and a new suite. First means every terminal screenshot from here on shows a layout the CLI and the terminal agree about. |
| 5 | **7–16** | Everything numeric downstream reads the statusLine payload: the context-ring measurements in Tasks 53 and 63, and the usage chip. Tasks 7–9 are the sole creators of `src/main/statusLine.ts` and `scripts/verify-statusline.mts`. |
| 6 | **17** | Repointing `verify:usage` needs `statusLineWindows` (Task 14), and lands after Task 16 so the CLAUDE.md command list is rewritten once. |
| 7 | **18–21** | The board settings must be threaded through recall, apply and scan before anything else in C reads them; Task 21 gives them controls immediately afterwards, because Task 19's error string and Task 29's watch sentence both send the user to "Settings › Worklog agent". |
| 8 | **22–26** | Budgets and the never-throws scan report. Task 22 is optional and non-blocking: Tasks 23 and 24 ship committed figures, so skipping it leaves nothing at a stand-in value. |
| 9 | **27–33** | Task 28 creates the `worklog:watch` handler, the four `watchChanged` triggers and the `api.ts` / `preload` members. It is a **hard prerequisite of Task 52**, and must precede Task 36, which replaces the `projectsAdd` handler Task 28 Step 3 modifies. |
| 10 | **34–41** | Task 36's replacement `projectsAdd` handler must carry Task 28's `sendWatchStates()` call, so D runs after C. Task 38 is the sole writer of `Sidebar.tsx`'s `.project-top` block and lands its three CSS rules in the same commit, so it must precede Task 68. |
| 11 | **42–47** | Profile-follows-tab reads `Tab.hostId` (Task 2) and `profileIdForCwd` (Task 42, in `src/shared/paths.ts`). Nothing in B depends on A, and running B first keeps A's large `App.tsx` restructure as the last edit to that file before F. |
| 12 | **48–63** | Task 52 needs Tasks 28 and 29; Task 63's context-ring measurements need the statusLine channel. A runs entirely **before** the density migration, so its expected geometry — Task 48's `{"left":6,"right":1}`, Task 49's `{"tabTop":4,"tabBottom":43}` — is today's pre-migration numbers and stays correct. |
| 13 | **64** | The entire 4px density change in **one commit**: the `perl` over `app.css` and the eight `.tsx` files, the deletion of the `--sp-*` block, `body`'s line-height, the seven literal line-height values and `src/remote/style.css`. Nothing between Task 4 and here has moved a pixel, so every measurement above was taken against an intact layout and every commit to this point is visually correct. |
| 14 | **65–73** | Sidebar behaviour, the selection/hover ranking, the one vertical, the icon-size mechanism, the control height, the `uiScale` clamp UI, the traffic-light clearance and the last untokenised colours. All measure against the post-migration layout, which is why Task 64 precedes them and why Task 68's `[-26,-5]` → `[0,0]` pair is only correct on that side of it. |
| 15 | **74** | The density review spec §4.F.6 asks for, run when the migration is one commit old rather than a hundred tasks old, and bounded to four yes/no measurements. Anything found beyond them is recorded as a follow-up issue, not fixed inside the task. |

---

## Contracts — the shared files every workstream imports

**Tasks 1–5.** They create the modules A–F import, and **must land before any workstream task
runs**. Their order is **1, 2, 3, then 4, then 5** — Task 4's own verification step uses
`scripts/cdp-eval.mjs`, which Task 5 creates, so if 4 is executed first that one step waits for 5.

Sections §0.1–§0.10 of
`docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md` are the reference
material these tasks — and every workstream below — cite by number. That file also carries an older
copy of these five tasks, numbered 1, 2, 3, 4a and 5; **this document supersedes it**, and where the
two differ the task text below wins.

### Task 1: Move the path rule into `src/shared/paths.ts`

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/shared/paths.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/gate.ts` (rewritten over the new
  module; same exports, same arities)
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (two call sites, lines 223 and 367)
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/profiles.ts` (`foldGroup` becomes a
  re-export)
- Modify: `/Users/thevinh/dev/personal/stoke/tsconfig.web.json` and
  `/Users/thevinh/dev/personal/stoke/tsconfig.json` (`allowImportingTsExtensions`)
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts` (new cases; the
  `project()` fixture gains three fields)
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (Layout block)
- Test: `node scripts/verify-worklog-gate.mts`, `node scripts/verify-profiles.mts`,
  `npm run typecheck`, `npm run build`

**Interfaces:**
- Consumes: `type Project` from `src/shared/types.ts` (existing; contracts Task 2 adds `emoji`,
  `label` and `addedManually` to it afterwards, which is why Step 1 pre-empts the fixture).
- Produces, all from `src/shared/paths.ts`, and this is the whole module until **B Task 42**
  appends `GroupOwner` and `profileIdForCwd` to it:
  ```ts
  export interface PathRules { sep: '/' | '\\'; caseInsensitive: boolean }
  export function pathRulesFor(platform: string): PathRules
  export function normalizePath(p: string, rules: PathRules): string
  export function pathKey(p: string, rules: PathRules): string
  export function isInside(parent: string, child: string, rules: PathRules): boolean
  export function basenameOf(p: string): string
  export function parentName(p: string): string
  export function foldGroup(value: string): string
  export function groupForCwd(
    cwd: string,
    projects: Project[],
    rules: PathRules,
    roots?: string[]
  ): string | null
  ```
- Produces, from `src/main/worklog/gate.ts` — one new export, three unchanged in name and arity:
  ```ts
  export const GATE_RULES: PathRules
  export { foldGroup }
  export function groupForCwd(cwd: string, projects: Project[], roots?: string[]): string | null
  export function isWatchedGroup(group: string | null, worklogGroups: string[]): boolean
  export function shouldWatch(
    cwd: string,
    projects: Project[],
    worklogGroups: string[],
    roots?: string[]
  ): boolean
  ```
  `shouldWatch.length` stays **3**: a default-valued parameter does not count toward
  `Function.length`, and `verify-worklog-gate.mts` asserts that number as the pin on "the sidebar
  chip cannot be passed in".
- Produces, from `src/shared/profiles.ts`: `foldGroup` continues to be exported, now as
  `import { foldGroup } from './paths.ts'` at the top plus a bare `export { foldGroup }` where the
  function body was. Its existing importers are unaffected, and — because this is an import and not
  a re-export — so are the eleven calls `profiles.ts` makes to it internally.

Who reads what: **C Tasks 27 and 28** and **D Tasks 34, 35, 39, 41** use `pathRulesFor`,
`pathKey`, `isInside`, `basenameOf` and `normalizePath`; **B Tasks 42, 44, 45** and
**D Task 39** use `foldGroup` and `groupForCwd`; **C Task 26** uses the three-argument
`groupForCwd` in `index.ts`. Four workstreams import this file, which is why no signature in it
ships without a body.

- [ ] **Step 1: Extend the gate suite with the cases the shared rule must satisfy.**
  Open `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts`. Add `GATE_RULES` to the
  existing `import { … } from '../src/main/worklog/gate.ts'` line (locate it by that quoted
  specifier, not by a line number).

  First, **stop the `project()` fixture going stale.** Contracts Task 2 adds three required fields
  to `Project`. Find the fixture by its `function project(` line and give every literal it builds
  the three new keys, so the file stays honest even though `scripts/` is typechecked by neither
  project:

  ```ts
    emoji: null,
    label: null,
    addedManually: false
  ```

  Then append these blocks immediately before the file's final two lines — the
  `` console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`) `` and the
  `process.exitCode` assignment. Anchor on those two lines, never on a line number:

  ```ts
  console.log('\na scan root is not a project')
  /*
   * `/Users/thevinh/dev/work` is itself a registered Claude project on the real
   * machine, so the longest-prefix rule matched it and answered `dev` for every
   * sibling under it — 7 of 12 work folders were unwatched. A root is a
   * container of projects, not a project.
   */
  const withRoot: Project[] = [...projects, project(root, isWin ? 'G:' : 'vinn')]
  check(
    'a folder under a scan root resolves to the root name, not the root parent',
    groupForCwd(p('unregistered-repo'), withRoot, [root]),
    'Code'
  )
  check(
    'and a real project inside the root still wins over the root fallback',
    groupForCwd(p('gitea-company', 'refinity'), withRoot, [root]),
    'gitea-company'
  )
  check(
    'with no roots passed, an unregistered folder still resolves to nothing',
    groupForCwd(p('unregistered-repo'), projects),
    null
  )
  /*
   * After A Task 57 every window holds at least one `kind: 'new'` tab whose cwd
   * is the empty string, and both B Task 46's profile effect and C Task 28's
   * watchStates call this rule with it. An empty prefix matches every path, so
   * without the guard the first project in the list wins — and the profile chip
   * and the watch dot both lie about a tab that has no folder at all.
   */
  check('an empty cwd resolves to no group rather than the first project', groupForCwd('', projects, []), null)

  console.log('\nthe signature the sidebar chip cannot reach through')
  check('shouldWatch still reports three required parameters', shouldWatch.length, 3)
  check(
    'a folder under a watched root is watched even with no history of its own',
    shouldWatch(p('unregistered-repo'), withRoot, ['Code'], [root]),
    true
  )

  console.log('\nmacOS folds case like Windows does')
  check(
    'the rules for this platform',
    GATE_RULES.caseInsensitive,
    process.platform === 'win32' || process.platform === 'darwin'
  )
  if (process.platform === 'darwin') {
    check(
      'a differently-cased path matches on APFS',
      shouldWatch(p('GITEA-COMPANY', 'Refinity'), projects, WATCHED),
      true
    )
  }
  ```

  Also change the existing `else` branch at lines 152-158 so it only runs on Linux:
  replace `} else {` with `} else if (process.platform !== 'darwin') {`.

- [ ] **Step 2: Run it and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/verify-worklog-gate.mts`
  Expected: `SyntaxError: The requested module '../src/main/worklog/gate.ts' does not provide an
  export named 'GATE_RULES'`.

- [ ] **Step 3: Create `/Users/thevinh/dev/personal/stoke/src/shared/paths.ts`** with exactly this
  content. This is the whole module — `GroupOwner` and `profileIdForCwd` from §0.7 are **appended by
  B Task 42** and are deliberately absent here. Four workstreams import this file, so no signature
  in it may ship without a body. No Node imports, no `process`, and the type import is
  extensionless because it is erased.

  ```ts
  /**
   * The cwd → project group rule, in the one place both processes can run it.
   *
   * The switch this answers is per project *group* — the parent folder name that
   * already separates `personal` from `gitea-company` on this machine — and it is
   * read off the session's own working directory, **never** off the profile chip
   * in the sidebar. That distinction is the whole point of this module. The chip
   * is a view filter: a Work session can be running in a background tab while the
   * user browses Personal, so keying off the chip would either skip that session
   * or, worse, hand a personal session to an agent that files it into a work
   * tracker. Both failures are silent — the wrong sessions get logged, or none do
   * — which is why the rule lives in one small, tested module rather than inline
   * at each call site.
   *
   * It sits in `src/shared` rather than in `src/main/worklog/gate.ts` because the
   * renderer needs the same answer for the profile chip, and a second
   * implementation over there is exactly how the longest-prefix bug below got in.
   *
   * Everything here is pure and touches neither disk, Electron nor `process`, so
   * `scripts/verify-worklog-gate.mts` and `scripts/verify-profiles.mts` exercise
   * it under `node --experimental-strip-types` with no app running — and so
   * `tsconfig.web.json`, which gives `src/shared` no Node types, still compiles
   * it. The platform is passed in; it is never read.
   */
  import type { Project } from './types'

  /**
   * How this OS compares paths.
   *
   * Passed in rather than read off `process`, because this module is compiled for
   * the renderer too — and because case-folding on macOS is a real fix, not a
   * detail: APFS is case-insensitive by default, and gate.ts folded only on
   * Windows.
   */
  export interface PathRules {
    sep: '/' | '\\'
    caseInsensitive: boolean
  }

  /** `process.platform` in main, `window.stoke.platform` in the renderer. */
  export function pathRulesFor(platform: string): PathRules {
    return {
      sep: platform === 'win32' ? '\\' : '/',
      caseInsensitive: platform === 'win32' || platform === 'darwin'
    }
  }

  /**
   * Native separators, trailing ones removed. Deliberately the same rule as
   * `normalize` in projects.ts, because the paths compared here were written by
   * it — any drift there would quietly stop matching here.
   *
   * The empty string stays empty, and that is contractual: a `new` tab's cwd is
   * `''`, an empty prefix matches every path, and a value that survived as `'/'`
   * would hand every New tab the first project in the list.
   */
  export function normalizePath(p: string, rules: PathRules): string {
    const trimmed = p.trim()
    if (!trimmed) return ''
    const native =
      rules.sep === '\\' ? trimmed.replace(/\//g, '\\') : trimmed.replace(/\\/g, '/')
    // A path that is nothing but separators — `/`, or `\\` — keeps them rather
    // than normalising to the empty string, which every prefix test matches.
    // `G:\\` becomes `G:`, and still compares correctly: everything under it
    // starts `G:\\`.
    return native.replace(/[\\/]+$/, '') || native
  }

  /** Comparison key for a path: normalised, and case-folded where the OS is. */
  export function pathKey(p: string, rules: PathRules): string {
    const n = normalizePath(p, rules)
    return rules.caseInsensitive ? n.toLowerCase() : n
  }

  /**
   * Is `child` the same folder as `parent`, or inside it?
   *
   * The separator on the prefix test is load-bearing: without it a project at
   * `…/Stoke` claims `…/Stoke-old`, which is a different repo in a possibly
   * different group. An empty parent or child is inside nothing — that is the
   * empty-cwd guard, stated once and reused by `groupForCwd`.
   */
  export function isInside(parent: string, child: string, rules: PathRules): boolean {
    const parentKey = pathKey(parent, rules)
    const childKey = pathKey(child, rules)
    if (!parentKey || !childKey) return false
    if (childKey === parentKey) return true
    const prefix = parentKey.endsWith(rules.sep) ? parentKey : parentKey + rules.sep
    return childKey.startsWith(prefix)
  }

  /**
   * Last path segment, either separator, ignoring trailing ones.
   *
   * Separator-agnostic and rules-free on purpose: it is also handed paths that
   * crossed the remote bridge from a machine whose separator is not this one.
   */
  export function basenameOf(p: string): string {
    const trimmed = p.trim().replace(/[\\/]+$/, '')
    if (!trimmed) return ''
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return cut === -1 ? trimmed : trimmed.slice(cut + 1)
  }

  /**
   * The segment before the last — which is what `Project.group` is.
   *
   * Empty for a path whose parent is the filesystem root, because `/` has no
   * name and inventing one would put every top-level folder in a group.
   */
  export function parentName(p: string): string {
    const trimmed = p.trim().replace(/[\\/]+$/, '')
    if (!trimmed) return ''
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    if (cut <= 0) return ''
    return basenameOf(trimmed.slice(0, cut))
  }

  /**
   * Group names are folded on every platform, not just where the filesystem is.
   * They are display strings the user can retype (`ProfileConfig.groups` says
   * "compared case-folded"), so `Personal` and `personal` must be one switch even
   * on a case-sensitive filesystem. Canonical home; `src/shared/profiles.ts`
   * re-exports it, so its existing importers are unaffected.
   */
  export function foldGroup(value: string): string {
    return value.trim().toLowerCase()
  }

  /**
   * Resolve a working directory to the `Project.group` that owns it, or null.
   *
   * Three steps, in this order:
   *
   *  1. Longest-prefix match over `projects`, **skipping any project whose own
   *     path is one of `roots`**. A scan root is a container of projects, not a
   *     project; Claude registered it only because a session was once started
   *     there. Without that skip, `/Users/thevinh/dev/work` — itself a registered
   *     project — swallows every sibling under it and answers with group `dev`,
   *     which is spec §2.4.3 exactly: 7 of 12 work folders were never watched.
   *  2. The longest `root` that contains the cwd. The group is `basenameOf(root)`,
   *     because a project directly inside that root would have had
   *     `parentName(path)` — the root's own name.
   *  3. Null. The group is never invented from the shape of the path: any folder
   *     under a directory called `personal` would otherwise be treated as that
   *     profile's work, including places that are not projects at all.
   *
   * A cwd *inside* a project counts as that project: sessions are often started a
   * level or two down, and the transcript records the real cwd.
   */
  export function groupForCwd(
    cwd: string,
    projects: Project[],
    rules: PathRules,
    roots: string[] = []
  ): string | null {
    if (!pathKey(cwd, rules)) return null

    const rootKeys = new Set(
      roots.map((r) => pathKey(r, rules)).filter((k) => k !== '')
    )

    let best: Project | null = null
    let bestLength = -1
    for (const project of projects) {
      const projectKey = pathKey(project.path, rules)
      if (!projectKey) continue
      // Step 1's skip. A root that is also a registered project is still a root.
      if (rootKeys.has(projectKey)) continue
      if (!isInside(project.path, cwd, rules)) continue
      // Longest match wins, so a project nested inside another beats its parent.
      if (projectKey.length > bestLength) {
        best = project
        bestLength = projectKey.length
      }
    }

    if (best) {
      // `group` is normally already `parentName(path)` (projects.ts:163).
      // Recompute when it is absent rather than reporting "no group": a Project
      // can be rebuilt by hand — a test fixture, or a record that crossed the
      // remote bridge — and losing the group there would silently switch the
      // agent off.
      return best.group || parentName(normalizePath(best.path, rules)) || null
    }

    let bestRoot = ''
    let bestRootLength = -1
    for (const root of roots) {
      const rootKey = pathKey(root, rules)
      if (!rootKey) continue
      if (!isInside(root, cwd, rules)) continue
      if (rootKey.length > bestRootLength) {
        bestRoot = root
        bestRootLength = rootKey.length
      }
    }
    if (bestRoot) return basenameOf(normalizePath(bestRoot, rules)) || null

    return null
  }
  ```

  Two behaviours that body guarantees, and §0.7 states as contract:
  `normalizePath('', rules) === ''` (the `if (!trimmed) return ''` line), and
  `groupForCwd('', projects, rules, roots) === null` (the `if (!pathKey(cwd, rules)) return null`
  line) — the empty-cwd case Step 1 now asserts.

- [ ] **Step 4: Rewrite `/Users/thevinh/dev/personal/stoke/src/main/worklog/gate.ts`** to exactly
  this, deleting its local `normalizePath`, `pathKey`, `foldGroup` and the longest-prefix loop.
  The exported names and their arities are unchanged, so every existing importer — `index.ts`,
  `autoscan.ts`, `verify-worklog-gate.mts` — keeps compiling:

  ```ts
  /**
   * The worklog gate: whether the agent is allowed to look at a session at all.
   *
   * The switch is per project *group* — the parent folder name that already
   * separates `personal` from `gitea-company` on this machine — and it is read off
   * the session's own working directory, **never** off the profile chip in the
   * sidebar. That distinction is the whole point of this file. The chip is a view
   * filter: a Work session can be running in a background tab while the user
   * browses Personal, so keying off the chip would either skip that session or,
   * worse, hand a personal session to an agent that files it into a work tracker.
   * Both failures are silent — the wrong sessions get logged, or none do — which
   * is why the rule lives in one small, tested function rather than inline at the
   * call site.
   *
   * The path arithmetic itself now lives in `src/shared/paths.ts`, so the renderer
   * can apply the identical rule for the profile chip without a second
   * implementation. This file is the main-process face of it: it resolves the
   * platform once and keeps the three-argument signature the gate is tested on.
   */
  import {
    foldGroup,
    groupForCwd as groupForCwdShared,
    pathRulesFor,
    type PathRules
  } from '../../shared/paths.ts'
  import type { Project } from '@shared/types'

  /** This machine's comparison rules, resolved once. */
  export const GATE_RULES: PathRules = pathRulesFor(process.platform)

  export { foldGroup }

  export function groupForCwd(cwd: string, projects: Project[], roots: string[] = []): string | null {
    return groupForCwdShared(cwd, projects, GATE_RULES, roots)
  }

  /** Whether a group is one the user asked the worklog agent to watch. */
  export function isWatchedGroup(group: string | null, worklogGroups: string[]): boolean {
    if (!group) return false
    const wanted = foldGroup(group)
    if (!wanted) return false
    return worklogGroups.some((g) => foldGroup(g) === wanted)
  }

  /**
   * The gate itself: should the worklog agent review a session running in `cwd`?
   *
   * Note what this signature does *not* take: the active profile. There is
   * nowhere to pass the sidebar selection in, by design.
   *
   * An empty `worklogGroups` — the shipped default — watches nothing at all. Off
   * has to be genuinely off, or the first launch after an update would start
   * spending tokens on every session without anyone asking for it.
   */
  export function shouldWatch(
    cwd: string,
    projects: Project[],
    worklogGroups: string[],
    roots: string[] = []
  ): boolean {
    if (worklogGroups.length === 0) return false
    return isWatchedGroup(groupForCwd(cwd, projects, roots), worklogGroups)
  }
  ```

  **`shouldWatch.length` stays 3.** A default-valued parameter does not count toward
  `Function.length`, so `verify-worklog-gate.mts:166` — the assertion that the sidebar chip cannot
  be passed in — keeps passing unchanged and keeps meaning what it says. Do not turn `roots` into a
  required fourth argument.

- [ ] **Step 4a: Pass the scan roots at both main-process call sites.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts` there are exactly two, both with a
  `settings` object already in scope. Make these two edits:

  | Line | Before | After |
  |---|---|---|
  | 223 | `groupForCwd(cwd, projects)` | `groupForCwd(cwd, projects, settings.projectRoots)` |
  | 367 | `shouldWatch(cwdForSession(sessionId), await listProjects(settings), settings.worklogGroups)` | `shouldWatch(cwdForSession(sessionId), await listProjects(settings), settings.worklogGroups, settings.projectRoots)` |

  Without this the root fallback is dead code in the app and lives only in the suite, which is the
  exact shape of the bug spec §2.4.3 reports. Confirm with
  `grep -c "settings\.projectRoots" src/main/index.ts`, which prints `2`. It prints `0` before this
  step.

  > **This task owns both call sites, and it lands first.** Two later tasks quote the line 223
  > region: **C Task 25 Step 2** re-indents `runWorklogScan`'s body into a `try`, and **C Task 26
  > Step 1** replaces the `const group = …` line with a commented version. Both run long after this
  > one — contracts Tasks 1–5 land before any workstream task — so both are written against the
  > **three-argument** call this step produces, and neither reverts it. If you are reading this
  > while executing Task 25 or Task 26 and the file still shows `groupForCwd(cwd, projects)` with
  > two arguments, contracts Task 1 has not landed: stop, because the whole plan is out of order.

- [ ] **Step 5: Import and re-export `foldGroup` in `src/shared/profiles.ts`.** Locate its body by
  the `export function foldGroup` line, delete the function, and put this in its place, keeping the
  doc comment above it. Put the `import` with the file's other imports at the top, not inline:

  ```ts
  /*
   * Relative with an explicit `.ts`, even though this is a shared module and the
   * rest of them import extensionlessly. Extensionless works only for type-only
   * imports, which are erased — this is a value import, and
   * `node scripts/verify-profiles.mts` loads this file directly under
   * --experimental-strip-types, where './paths' resolves to nothing. Both
   * tsconfigs allow the extension after Steps 5a and 5b.
   */
  import { foldGroup } from './paths.ts'
  ```

  and then, where the function body was:

  ```ts
  export { foldGroup }
  ```

  > **It must be an `import` plus a separate `export`, never `export { foldGroup } from './paths.ts'`.**
  > A re-export forwards the name to this module's consumers and creates **no local binding**, so
  > every one of `profiles.ts`'s own eleven internal calls would fail — `deriveProfiles` at lines
  > 264 and 265, `resolveProfiles` at 358 and 368, `visibleProfiles` at 392, 395 and 397,
  > `profileById` at 413 and 414, and `uniqueProfileId` at 420, 421 and 424. Under
  > `tsc` that is `TS2304: Cannot find name 'foldGroup'` eleven times; under
  > `node --experimental-strip-types` it is a `ReferenceError` at first use. Confirm the call sites
  > survive with `grep -c "foldGroup(" src/shared/profiles.ts` → `11`.

  This is the **first value import between two shared modules** in the tree. Extensionless it dies
  at import time with `ERR_MODULE_NOT_FOUND`; with the extension, `tsc -p tsconfig.web.json`
  rejects it with `TS5097` until the next two steps. Both were measured, not reasoned.

- [ ] **Step 5a: Turn the flag on in the web project.** In
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
    // Legal because this project is noEmit. tsconfig.node.json:9 already sets
    // it; src/main/mcp/design.ts:11-16 is the import style it exists for.
    "allowImportingTsExtensions": true,
  ```

- [ ] **Step 5b: Do the same in the root config, so the editor agrees.** In
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

- [ ] **Step 5c: Typecheck.** `npm run typecheck` exits 0 with no output. Without 5a it fails with
  a line naming `src/shared/profiles.ts` and ending
  `error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.`

- [ ] **Step 6: Run it and watch it pass.**
  `node scripts/verify-worklog-gate.mts` → `all pass`, then
  `node scripts/verify-profiles.mts` → `all pass`.

- [ ] **Step 7: Prove the bundlers still resolve it.** `npm run build` exits 0. A resolution
  failure here would be a Vite error naming `src/shared/profiles.ts`, not a silent one.

- [ ] **Step 7a: Put the new module in `CLAUDE.md`'s Layout block.** `src/shared/` is one
  undifferentiated line today (`CLAUDE.md:78`), and this plan adds three modules to it whose
  placement matters. Open `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, locate the line by
  `grep -n "^src/shared/" CLAUDE.md`, and replace

  ```
  src/shared/       types, IPC channel names, themes, profiles, colour maths
  ```

  with

  ```
  src/shared/       types, IPC channel names, themes, profiles, colour maths
    paths.ts          cwd -> project group. Pure, platform passed in, no node imports,
                      so the renderer runs the identical rule for the profile chip
  ```

  Two-space indent under the parent, matching the `src/main/` entries above it. Contracts Task 2
  and E Task 14 each add a line under this one; nothing else in the plan rewrites this parent line.
  Expected: `grep -cE "^  paths\.ts" CLAUDE.md` prints `1`.

- [ ] **Step 8: Commit.**
  `git commit -m "Share the cwd→group rule with the renderer, and stop a scan root eating its siblings"`
  Body records: a registered project that is also a scan root claimed every sibling under it and
  answered with its parent's name, so 7 of 12 work folders were never watched; macOS now folds
  path case, which APFS has always done; and the first value import between two shared modules had
  no working spelling until both tsconfigs set `allowImportingTsExtensions`, which is what
  `src/main` has always relied on.

### Task 2: Land the shared types and channels

This task owns **two** type modules, and they are different files. `src/shared/types.ts` is the
cross-process record set; `src/renderer/src/types.ts` is the renderer-only `Tab`, which is not
shared and is not in `src/shared` at all. Six tasks in workstreams A and F read fields this task
puts on that second file — `Tab.kind`, `Tab.hostId`, `Tab.selectedPath`, `Tab.expandedPath` and
the `TabKind` union — so Step 6a below is the sole producer of all five, and Step 7's `App.tsx`
literals do not typecheck without it.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/shared/worklog.ts`
- Create: `/Users/thevinh/dev/personal/stoke/src/shared/ui.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/types.ts` (a new statusline section, three
  fields on `Project`, five worklog types, `ProjectMeta`, three `Settings` keys, one field each on
  `TabDescriptor` and `ContextSnapshot`)
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/ipc.ts` (seven channels)
- Modify — **overwrite**: `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/projects.ts`,
  `/Users/thevinh/dev/personal/stoke/src/main/context.ts`,
  `/Users/thevinh/dev/personal/stoke/src/main/sessionFile.ts`,
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (make the new required fields valid)
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (Layout block)
- Test: `npm run typecheck` — red after Step 1 and again after Step 6a, green after Step 7

**Interfaces:**
- Consumes: `WorklogTarget`, `PermissionMode`, `EffortLevel`, `Project`, `ContextSnapshot`,
  `TabDescriptor`, `Settings` — all already in `src/shared/types.ts`.
- Produces, in `src/shared/types.ts`: `StatusLinePayload`, `StatusLineModel`,
  `StatusLineContextWindow`, `StatusLineUsage`, `StatusLineRateLimit`, `StatusLineRateLimits`,
  `StatusLineWindowReading`, `StatusLineSnapshot`, `WorklogWatchReason`, `WorklogWatchState`,
  `WorklogScanOutcome`, `WorklogScanReport`, `WorklogBoards`, `ProjectMeta`; the fields
  `Project.emoji`, `Project.label`, `Project.addedManually`, `Settings.projectMeta`,
  `Settings.worklogBoards`, `Settings.hideStatusLine`, `TabDescriptor.hostId` and
  `ContextSnapshot.permissionMode`.
- Produces, in `src/shared/worklog.ts`:
  ```ts
  export const WORKLOG_TARGETS: readonly WorklogTarget[]
  export const DEFAULT_WORKLOG_BOARDS: WorklogBoards
  ```
- Produces, in `src/shared/ui.ts`:
  ```ts
  export const UI_SCALE_MIN: number
  export const UI_SCALE_MAX: number
  export const FONT_SIZE_MIN: number
  export const FONT_SIZE_MAX: number
  export function clampUiScale(value: unknown): number
  export function clampFontSize(value: unknown): number
  ```
- Produces, in `src/shared/ipc.ts`: `CH.projectsMeta`, `CH.statusLineUpdate`, `CH.statusLineLast`,
  `CH.worklogWatch`, `CH.worklogWatchChanged`, `CH.worklogScanned`, `CH.worklogLastScan`.
- Produces, in `src/renderer/src/types.ts`: `TabKind`, and `Tab` carrying `kind`, `hostId`,
  `selectedPath` and `expandedPath`. **Step 6a is the only step in the plan that writes this file.**

Who reads what: E Tasks 7–17 read every `StatusLine*` type; C Tasks 25–33 and A Tasks 50–53 read
`WorklogWatchState` and `WorklogScanReport`; D Tasks 34–38 read `ProjectMeta` and `Project`'s three
new fields; C Tasks 18–21 read `WorklogBoards`, `WORKLOG_TARGETS` and `DEFAULT_WORKLOG_BOARDS`;
Task 3 and F Task 71 read `src/shared/ui.ts`.

- [ ] **Step 1: Add the new types to `src/shared/types.ts`.** Six insertions, written out in full
  below. §0.2–§0.7 of the contracts file say the same thing and are the reference; nothing here is
  deferred to it.

  **1a — the statusline block.** A new section immediately after the `ContextSnapshot` block (find
  it with `grep -n "export interface ContextSnapshot" src/shared/types.ts`). Snake_case is kept for
  the wire shape on purpose: it is the CLI's format, and renaming it would hide the day the CLI
  changes it.

  ```ts
  /* -------------------------------------------------------------- statusline */

  /**
   * The JSON Claude Code pipes to a `statusLine` command on stdin, as captured
   * from 2.1.221. Every field is optional because this is somebody else's wire
   * format: a CLI that drops one must degrade to the older inference, never throw.
   */
  export interface StatusLinePayload {
    session_id?: string
    transcript_path?: string
    cwd?: string
    version?: string
    model?: StatusLineModel
    context_window?: StatusLineContextWindow
    /** True once the session is past the 200k tier boundary. Billing-adjacent. */
    exceeds_200k_tokens?: boolean
    rate_limits?: StatusLineRateLimits
  }

  export interface StatusLineModel {
    id?: string
    display_name?: string
  }

  export interface StatusLineContextWindow {
    /**
     * The window this session actually has, stated by the CLI rather than
     * inferred. 1000000 for Opus 5, 200000 for Haiku — per model, and correct
     * from token zero, which is the whole reason this channel exists.
     */
    context_window_size?: number
    used_percentage?: number
    current_usage?: StatusLineUsage
  }

  export interface StatusLineUsage {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }

  /** `resets_at` is epoch **seconds**, not ms. Convert once, at the edge. */
  export interface StatusLineRateLimit {
    used_percentage?: number
    resets_at?: number
  }

  export interface StatusLineRateLimits {
    five_hour?: StatusLineRateLimit
    seven_day?: StatusLineRateLimit
  }

  /** One rate-limit window, in Stoke's own units. */
  export interface StatusLineWindowReading {
    /** 0-100. */
    percent: number
    /** Epoch **ms**, converted from the payload's seconds. Null when absent. */
    resetsAt: number | null
  }

  /**
   * What the main process hands the renderer, once. Flat, camelCase, and in ms —
   * so no component ever has to know the wire shape or the seconds/ms boundary.
   */
  export interface StatusLineSnapshot {
    sessionId: string
    /** context_window_size, or null when this CLI did not state one. */
    contextWindowSize: number | null
    /** 0-100, as the CLI computed it. Null when absent. */
    usedPercentage: number | null
    modelId: string | null
    modelName: string | null
    exceeds200k: boolean
    fiveHour: StatusLineWindowReading | null
    sevenDay: StatusLineWindowReading | null
    /** Epoch ms the payload file was written. Drives the "as of HH:MM" tooltip. */
    receivedAt: number
  }
  ```

  **1b — `ContextSnapshot` gains one field**, after its `ready` member:

  ```ts
    /** Newest `permission-mode` record in the transcript, or null when none. */
    permissionMode: PermissionMode | null
  ```

  `PermissionMode` is already declared above it in the same file (`types.ts:14`). Spec §2.7:
  `tab.permissionMode` is captured at launch and no writer ever updates it, so Shift+Tab leaves it
  stale; the watcher already parses the transcript, so this costs nothing new. **A Task 53** is the
  only writer.

  **1c — `ProjectMeta`, and three fields on `Project`.** Put the interface immediately above
  `export interface Project` (`types.ts:77`):

  ```ts
  /**
   * What the user has said about one folder, over and above what Claude's own
   * files record. Keyed by `Project.path`.
   *
   * Deliberately **not** the home of `pinned` or `hidden`. Those are already
   * persisted as path arrays on real machines, and folding them in here would make
   * "hidden" and "has an emoji" the same record — so clearing an emoji could
   * resurrect a project the user hid. `addedManually` is the only key that affects
   * membership, and it only ever adds.
   */
  export interface ProjectMeta {
    /** One emoji shown before the name. Absent means none. */
    emoji?: string
    /** Replaces the folder's basename in the sidebar. Absent means use the basename. */
    label?: string
    /**
     * The user picked this folder themselves, so `listProjects` must emit it even
     * with no Claude history and no scan root covering it. Spec §2.5: there was no
     * source that could represent a single explicitly added folder.
     */
    addedManually?: boolean
  }
  ```

  and inside `Project` itself, so no component ever joins two structures:

  ```ts
    /** ProjectMeta.emoji for this path, or null. */
    emoji: string | null
    /** ProjectMeta.label, or null when the basename is in use. */
    label: string | null
    /** True when this project exists only because the user added the folder. */
    addedManually: boolean
  ```

  All three are **required**, not optional. That is what makes Step 5's typecheck failure name
  `projects.ts` instead of letting a missing field reach the sidebar as `undefined`.

  **1d — `TabDescriptor` gains one optional field** (`types.ts:62`), because the remote surface
  reads it:

  ```ts
    /** SshHost.id when this session runs on another machine. */
    hostId?: string
  ```

  **1e — five worklog types**, in the worklog section, after `export type WorklogTarget`
  (`types.ts:227`):

  ```ts
  /** Why a session is, or is not, the worklog agent's business. */
  export type WorklogWatchReason =
    /** Its folder's group is in Settings.worklogGroups. */
    | 'watched-group'
    /** It runs over SSH on a host with `worklog: true`. */
    | 'watched-host'
    /** worklogGroups is empty and no host is ticked — the feature is off entirely. */
    | 'off'
    /** A group resolved, but the user does not watch it. */
    | 'unwatched-group'
    /** No project and no scan root contains the cwd, so there is no group to check. */
    | 'unknown-folder'
    /** An SSH session on a host the user has not ticked. */
    | 'unwatched-host'

  /**
   * Whether the worklog may look at one session, and why.
   *
   * The `reason` is not decoration: spec §2.4.4 records that "working but nothing
   * to report" and "never ran" were indistinguishable, and this is the field that
   * separates them. Every surface that says anything about watching reads it.
   */
  export interface WorklogWatchState {
    sessionId: string
    watched: boolean
    reason: WorklogWatchReason
    /** The resolved project group, or the SSH host's label. Null when neither. */
    group: string | null
    /** True when the session runs on another machine, where the switch is per host. */
    remote: boolean
    /** Epoch ms this was decided. */
    decidedAt: number
  }

  /** How a scan ended. `budget` is separate from `error` on purpose (spec §4 C.3). */
  export type WorklogScanOutcome = 'proposed' | 'nothing' | 'budget' | 'error'

  /**
   * The last thing a scan did, so an empty panel can say which of the four it was.
   */
  export interface WorklogScanReport {
    sessionId: string
    at: number
    /** True when nobody pressed anything. */
    auto: boolean
    outcome: WorklogScanOutcome
    /** Proposals added. Always 0 unless outcome is 'proposed'. */
    added: number
    /** Non-null for 'budget' and 'error'. Shown to the user verbatim. */
    message: string | null
  }

  /**
   * Where the worklog files things, and which board in each.
   *
   * Replaces the compiled-in ids at runner.ts:37-38. An id belongs in settings
   * because it is one person's board: shipping it in the binary meant nobody else
   * could use the feature and this machine could not narrow to one destination.
   */
  export interface WorklogBoards {
    /** Destinations, in canonical order. Empty means the worklog writes nowhere. */
    targets: WorklogTarget[]
    /** Notion data source URI, e.g. `collection://<uuid>`. */
    notionDataSource: string
    /** ClickUp list id, as digits. */
    clickupListId: string
  }
  ```

  **1f — three keys on `Settings`** (`types.ts:326`):

  ```ts
    /** Per-folder metadata, keyed by `Project.path`. See ProjectMeta. */
    projectMeta: Record<string, ProjectMeta>
    /** Which boards the worklog writes to, and their ids. See WorklogBoards. */
    worklogBoards: WorklogBoards
    /**
     * Replace Claude's own status line with Stoke's silent wrapper.
     *
     * On by default: the wrapper is how the context window and the plan limits
     * reach the app at all, and the line it suppresses is a duplicate of chrome
     * Stoke already draws. Off passes the user's own command through unchanged.
     */
    hideStatusLine: boolean
  ```

  Their defaults, which **Task 3** applies, are `{}`, `DEFAULT_WORKLOG_BOARDS` and `true`.

- [ ] **Step 2: Create `/Users/thevinh/dev/personal/stoke/src/shared/worklog.ts`** with exactly
  this content. Shared module, no Node imports: both `settingsSchema.ts` and `worklog/runner.ts`
  need these and `runner.ts` runs under strip-types. The type import is extensionless because it is
  erased.

  ```ts
  import type { WorklogBoards, WorklogTarget } from './types'

  /** Canonical order. Persisted lists are filtered through it, so what is stored
   *  cannot change the order anything is written in. */
  export const WORKLOG_TARGETS: readonly WorklogTarget[] = ['notion', 'clickup']

  /**
   * Notion only, by default.
   *
   * The ClickUp id is kept rather than blanked even though it is unused: it is a
   * real, working list, so ticking ClickUp later is one checkbox instead of a hunt
   * through a URL bar. A default that is present-but-unused costs nothing.
   */
  export const DEFAULT_WORKLOG_BOARDS: WorklogBoards = {
    targets: ['notion'],
    notionDataSource: 'collection://368d3f2d-1f02-817c-b193-000b208e36bd',
    clickupListId: '901615258684'
  }
  ```

  This task changes nothing in `src/main/worklog/runner.ts`. **C Task 19** turns that file's
  existing `NOTION_DATA_SOURCE` and `CLICKUP_LIST_ID` exports into re-exports of these two
  constants; **C Tasks 29 and 30** append to this file later.

- [ ] **Step 3: Create `/Users/thevinh/dev/personal/stoke/src/shared/ui.ts`** with exactly this
  content. Both the settings write path (`store.ts`, through `settingsSchema.ts`) and
  `SettingsSheet.tsx` need the same bounds, because a number input's `min`/`max` are advisory
  inside React's `onChange` (spec §2.11). No Node imports, no `process`.

  ```ts
  /** Interface scale bounds. Below 0.8 the title bar clips; above 1.6 the
   *  940px minimum window can no longer hold the launcher. */
  export const UI_SCALE_MIN = 0.8
  export const UI_SCALE_MAX = 1.6
  export const FONT_SIZE_MIN = 9
  export const FONT_SIZE_MAX = 24

  /** Clamp anything to a usable interface scale. NaN and junk become 1. */
  export function clampUiScale(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return 1
    return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n))
  }

  /** Same, for the terminal font size. */
  export function clampFontSize(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return 13
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)))
  }
  ```

- [ ] **Step 4: Add the seven channels to
  `/Users/thevinh/dev/personal/stoke/src/shared/ipc.ts`.** Each goes in the section its comment
  names, inside the existing `CH` object — `projectsMeta` with the other `projects:*` entries
  (`ipc.ts:17-22`), the four worklog channels with the existing `worklog:*` block
  (`ipc.ts:97-104`), and the statusline pair as a new two-line group. **Add here first**, which is
  the house rule this step exists to satisfy.

  ```ts
    // projects & sessions
    projectsMeta: 'projects:meta',

    // statusline channel (see the design spec, §3)
    statusLineUpdate: 'statusline:update',
    statusLineLast: 'statusline:last',

    // worklog
    worklogWatch: 'worklog:watch',
    worklogWatchChanged: 'worklog:watchChanged',
    worklogScanned: 'worklog:scanned',
    worklogLastScan: 'worklog:lastScan',
  ```

  Expected:
  `grep -cE "'(projects:meta|statusline:(update|last)|worklog:(watch|watchChanged|scanned|lastScan))'" src/shared/ipc.ts`
  prints `7`. It prints `0` before this step.

- [ ] **Step 5: Run the typecheck and watch it fail.**
  `npm run typecheck`
  Expected, from `tsconfig.node.json`: `src/main/projects.ts(…): error TS2739: Type '{ path: string; … }' is missing the following properties from type 'Project': emoji, label, addedManually`.

- [ ] **Step 6: Satisfy the new `Project` fields at their one construction site.** In
  `src/main/projects.ts`, every place a `Project` object is built gains
  `emoji: null, label: null, addedManually: false`. **D Task 35** replaces these with real
  `projectMeta` lookups; this
  step only makes the shape valid.

- [ ] **Step 6a: Replace the renderer's `Tab` interface with the one A and F need.** Overwrite
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts` — the whole file, which is 18 lines
  today — with exactly this. It is the **only** definition of `TabKind`, `Tab.kind`, `Tab.hostId`,
  `Tab.selectedPath` and `Tab.expandedPath` anywhere in the plan; A Tasks 50, 53, 57, 58 and 60 and
  F Task 67 all read them from here.

  ```ts
  import type { EffortLevel, PermissionMode } from '@shared/types'

  /** A New Project tab has no PTY yet; every session tab does. */
  export type TabKind = 'session' | 'new'

  /** A live terminal tab. Distinct from Claude's own session record. */
  export interface Tab {
    id: string
    kind: TabKind
    /** Empty string on a `new` tab, which has no process. */
    ptyId: string
    /** Claude Code session id — the key the context meter watches. Empty on `new`. */
    sessionId: string
    /**
     * The session's working directory; `''` on a `new` tab.
     *
     * For an SSH tab this is the host alias, not a folder — see `hostId`, and
     * CLAUDE.md gotcha 18.
     */
    cwd: string
    projectName: string
    /** Falls back to the project name until Claude generates an ai-title. */
    title: string
    /**
     * Kept live from `ContextSnapshot.permissionMode` rather than frozen at
     * launch, so Shift+Tab inside the session reaches the indicator. Written by
     * A Task 53; before it, no writer ever updated this field.
     */
    permissionMode: PermissionMode
    model: string
    effort: EffortLevel
    status: 'running' | 'exited'
    exitCode: number | null
    /**
     * `SshHost.id` when this session runs on another machine, else null.
     *
     * The only reliable signal that `cwd` is an alias rather than a folder, which
     * is what stops profile-follows-tab from mapping an SSH session to whatever
     * project happens to share its alias's name.
     */
    hostId: string | null
    /**
     * Per-tab launcher selection, so several New Project tabs can be open at once
     * without both pointing at whatever was clicked last. Null on a session tab.
     */
    selectedPath: string | null
    /** The project row expanded in this tab's launcher, or null. */
    expandedPath: string | null
  }
  ```

  Two things this file deliberately does **not** do. It does not import `SessionMeta`:
  `tsconfig.web.json` sets `noUnusedLocals`, and `sessions: SessionMeta[]` does not move onto `Tab`
  — it is fetched list data, two tabs on one project would hold two copies that drift, and A Task
  56 makes it one App-level `Record<string, SessionMeta[]>` cache keyed by path instead. And it
  keeps `permissionMode` non-nullable even though `ContextSnapshot.permissionMode` is
  `PermissionMode | null`: A Task 53 Step 6 only assigns when the snapshot's value is non-null
  (`snap.permissionMode && snap.permissionMode !== t.permissionMode`), so the tab keeps its launch
  value until the transcript states a real one. Widening the field instead would push a null into
  `TabIndicator`, `TitleBar` and every other reader for no gain.

  Expected after the overwrite: `npm run typecheck` fails from `tsconfig.web.json` with
  `src/renderer/src/App.tsx(…): error TS2739: Type '{ id: string; ptyId: string; … }' is missing the following properties from type 'Tab': kind, hostId, selectedPath, expandedPath`.
  Step 7 is what clears it.

- [ ] **Step 7: Add the new fields to `ContextSnapshot` construction** in `src/main/context.ts`
  and `src/main/sessionFile.ts` as `permissionMode: null`, and to both `Tab` literals in
  `src/renderer/src/App.tsx`.

  There are exactly **two** of them — `grep -n "exitCode: null" src/renderer/src/App.tsx` finds
  both, at lines 333 and 434 today. **Field order is pinned**, because A Task 58 Step 3 quotes the
  second of these literals back verbatim as its anchor and a differently-ordered literal will not
  match: `kind` goes immediately after `id`, and the other three immediately after `exitCode: null`,
  in the order `hostId`, `selectedPath`, `expandedPath`.

  - The `startSession` literal (line 333): `kind: 'session'`, then
    `hostId: null, selectedPath: null, expandedPath: null`.
  - The SSH literal inside `startHostSession` (lines 423-435; find it with
    `grep -n "cwd: host.alias" src/renderer/src/App.tsx`, one hit at line 427):
    `kind: 'session'`, then `hostId: host.id, selectedPath: null, expandedPath: null`. **`host.id`,
    not `null`** — that field is the only reliable signal that `cwd` is an alias rather than a
    folder (CLAUDE.md gotcha 18), and B Task 46 reads it to stop an SSH session being mapped to
    whatever project happens to share its alias's name.

- [ ] **Step 8: Run the typecheck and watch it pass.** `npm run typecheck` exits 0.

- [ ] **Step 8a: List the two new shared modules in `CLAUDE.md`'s Layout block.** In
  `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, locate the `paths.ts` line contracts Task 1 Step 7a
  added (`grep -n "  paths.ts" CLAUDE.md`) and insert immediately after it:

  ```
    worklog.ts        the board targets the worklog can write to, and their defaults
    ui.ts             the uiScale / fontSize bounds, and the clamps both processes use
  ```

  Expected: `grep -cE "^  (paths|worklog|ui)\.ts" CLAUDE.md` prints `3`.
  `src/shared/ipc.ts` and `src/shared/types.ts` stay unlisted — the parent line already names them
  and this task adds no file there, only members.

- [ ] **Step 9: Commit.**
  `git commit -m "Declare the shared types the UX overhaul's six workstreams all read"`
  Body records: the renderer's `Tab` is a different module from `src/shared/types.ts` and gained
  `kind`, `hostId`, `selectedPath` and `expandedPath` here, because A Tasks 50, 53, 57, 58 and 60
  and F Task 67 all read them and none of those tasks defines them.

### Task 3: Extract a testable settings schema

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/settingsSchema.ts`
- Create: `/Users/thevinh/dev/personal/stoke/scripts/verify-settings.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/store.ts` (reduced to persistence)
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` (`verify:settings`, and one insertion
  into `check`)
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (verify-suite block and Layout block)
- Test: `node scripts/verify-settings.mts`, then `npm run check`

**Interfaces:**
- Consumes: `Settings`, `ProfileConfig`, `SshHost`, `Theme`, `ProjectMeta`, `WorklogBoards` from
  `@shared/types` (contracts Task 2); `DEFAULT_WORKLOG_BOARDS`, `WORKLOG_TARGETS` from
  `../shared/worklog.ts` (contracts Task 2); `clampUiScale`, `clampFontSize` from
  `../shared/ui.ts` (contracts Task 2); `validateTheme`, `DEFAULT_THEME_ID` from
  `../shared/themes.ts` (existing).
- Produces, from `src/main/settingsSchema.ts`:
  ```ts
  export const DEFAULT_SETTINGS: Settings
  export function hydrateSettings(raw: unknown): Settings
  ```
  and nothing else. In particular it exports **no** `MAX_EMOJI_CHARS` / `MAX_LABEL_CHARS` and no
  second copy of `tidy` — **D Task 34** is the sole home of those, and Step 4a of that task deletes
  the temporary inline `tidy` this task's Step 3 carries.
- Produces, in `package.json`: the `verify:settings` script, and `verify:settings` inside `check`.

Who reads what: `src/main/store.ts` (this task), **D Task 34** (`hydrateProjectMeta`'s `tidy`
import), **C Task 21** and **D Task 41** and **B Task 43** (all extend `hydrateSettings` or its
suite), **F Task 71** (the `uiScale` clamp's UI).

- [ ] **Step 1: Write the failing suite.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/verify-settings.mts`, copying the assertion helper
  and output format from `verify-worklog-gate.mts`:

  ```ts
  /*
   * hydrate() is the only thing standing between a hand-edited settings.json and
   * the app. It used to live behind an `import { app } from 'electron'`, so none
   * of it was ever run outside a window — and it repaired every structured field
   * except the ones that had just been added.
   *
   *   node scripts/verify-settings.mts
   */
  import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'

  let failures = 0
  function check(name: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failures++
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
        (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    )
  }

  console.log('\nproject metadata')
  check('junk is dropped rather than kept', hydrateSettings({ projectMeta: 7 }).projectMeta, {})
  check(
    'an array is not an object of records',
    hydrateSettings({ projectMeta: ['/a'] }).projectMeta,
    {}
  )
  check(
    'a trailing separator is normalised off the key',
    Object.keys(hydrateSettings({ projectMeta: { '/a/b/': { emoji: '🔥' } } }).projectMeta),
    ['/a/b']
  )
  check(
    'an entry that says nothing is dropped',
    hydrateSettings({ projectMeta: { '/a': { emoji: '  ', label: '' } } }).projectMeta,
    {}
  )
  check(
    'addedManually needs a literal true',
    hydrateSettings({ projectMeta: { '/a': { addedManually: 1 } } }).projectMeta,
    {}
  )
  check(
    'a label is trimmed and capped',
    hydrateSettings({ projectMeta: { '/a': { label: `  ${'x'.repeat(200)}  ` } } }).projectMeta[
      '/a'
    ].label?.length,
    64
  )

  console.log('\nworklog boards')
  check(
    'an untouched machine gets Notion only',
    hydrateSettings({}).worklogBoards.targets,
    ['notion']
  )
  check(
    'a target with no id is not a destination',
    hydrateSettings({
      worklogBoards: { targets: ['notion', 'clickup'], notionDataSource: 'x', clickupListId: '' }
    }).worklogBoards.targets,
    ['notion']
  )
  check(
    'the stored order cannot change the write order',
    hydrateSettings({
      worklogBoards: { targets: ['clickup', 'notion'], notionDataSource: 'x', clickupListId: '1' }
    }).worklogBoards.targets,
    ['notion', 'clickup']
  )
  check(
    'a target nobody can write to is dropped',
    hydrateSettings({
      worklogBoards: { targets: ['jira'], notionDataSource: 'x', clickupListId: '1' }
    }).worklogBoards.targets,
    []
  )

  console.log('\ninterface scale, which a number input will not clamp for you')
  check('a hand-typed 40 is clamped', hydrateSettings({ uiScale: 40 }).uiScale, 1.6)
  check('so is 0', hydrateSettings({ uiScale: 0 }).uiScale, 0.8)
  check('and junk falls back to 1', hydrateSettings({ uiScale: 'big' }).uiScale, 1)
  check('a legitimate value is untouched', hydrateSettings({ uiScale: 1.25 }).uiScale, 1.25)

  console.log('\nthe status line')
  check('suppression is on for a machine that has never said', hydrateSettings({}).hideStatusLine, true)
  check('and off stays off', hydrateSettings({ hideStatusLine: false }).hideStatusLine, false)

  console.log('\nnothing already persisted is disturbed')
  check(
    'pinned and hidden keep their own shape',
    hydrateSettings({ pinnedProjects: ['/a'], hiddenProjects: ['/b'] }),
    { ...DEFAULT_SETTINGS, pinnedProjects: ['/a'], hiddenProjects: ['/b'] }
  )

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exitCode = failures ? 1 : 0
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-settings.mts`
  Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/main/settingsSchema.ts'`.

- [ ] **Step 3: Create `src/main/settingsSchema.ts`** holding the current `DEFAULTS` object
  (renamed `DEFAULT_SETTINGS` and exported), the current `isProfileConfig` (`store.ts:12-16`), and
  the current `hydrate` body (`store.ts:84-129`, renamed `hydrateSettings` and exported) — all
  three moved across unchanged except for the rename — plus the four additions written out below.
  Import `validateTheme` and `DEFAULT_THEME_ID` as `from '../shared/themes.ts'`,
  `DEFAULT_WORKLOG_BOARDS` and `WORKLOG_TARGETS` as `from '../shared/worklog.ts'`, and the clamps
  as `from '../shared/ui.ts'` — relative with the explicit `.ts`, because this file is now run
  under strip-types. Types come from `@shared/types` type-only, which is safe. **No `electron`
  import**, which is the whole point of the extraction.

  **3a — the three new defaults.** `DEFAULT_SETTINGS` gains, alongside its existing keys:

  ```ts
    projectMeta: {},
    worklogBoards: DEFAULT_WORKLOG_BOARDS,
    // Default true: the wrapper is how the context window and the plan limits
    // reach the app at all, and the line it suppresses duplicates chrome Stoke
    // already draws.
    hideStatusLine: true
  ```

  **3b — `hydrateProjectMeta`**, a module-level function, verbatim:

  ```ts
  function hydrateProjectMeta(raw: unknown): Record<string, ProjectMeta> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, ProjectMeta> = {}
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      // Same normalisation as Project.path: trimmed, no trailing separator. A key
      // written by hand with one would never match a lookup.
      const key = path.trim().replace(/[\\/]+$/, '')
      if (!key || !value || typeof value !== 'object') continue
      // One implementation of the caps, the trim and the literal-true rule for
      // addedManually, shared with the IPC write path. See projectMeta.ts.
      const entry = tidy(value as Partial<ProjectMeta>)
      // An entry that says nothing is dropped — tidy returns null for it — so the
      // file cannot accumulate an empty object for every folder that was ever
      // right-clicked.
      if (entry) out[key] = entry
    }
    return out
  }
  ```

  **3c — `hydrateWorklogBoards`**, a module-level function, verbatim:

  ```ts
  function hydrateWorklogBoards(raw: unknown): WorklogBoards {
    const d = DEFAULT_WORKLOG_BOARDS
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...d, targets: [...d.targets] }
    }
    const r = raw as Partial<WorklogBoards>
    const notionDataSource =
      typeof r.notionDataSource === 'string' ? r.notionDataSource.trim() : d.notionDataSource
    const clickupListId =
      typeof r.clickupListId === 'string' ? r.clickupListId.trim() : d.clickupListId
    const asked = Array.isArray(r.targets) ? (r.targets as unknown[]) : [...d.targets]
    return {
      // Filtered through WORKLOG_TARGETS rather than trusted, so the write order
      // is canonical whatever order the file happened to hold — and so a typo
      // cannot name a destination no write tool exists for.
      //
      // A destination with no id is not a destination. Dropping it here means the
      // runner never has to check, and the settings sheet shows the truth.
      targets: WORKLOG_TARGETS.filter(
        (t) => asked.includes(t) && (t === 'notion' ? notionDataSource : clickupListId).length > 0
      ),
      notionDataSource,
      clickupListId
    }
  }
  ```

  **3d — five lines inside `hydrateSettings`'s returned object**, alongside the repairs already
  there:

  ```ts
      projectMeta: hydrateProjectMeta(r.projectMeta),
      worklogBoards: hydrateWorklogBoards(r.worklogBoards),
      // `!== false` and not `=== true`: a file written before this key existed
      // must read as on, which is what an untouched machine gets.
      hideStatusLine: r.hideStatusLine !== false,
      uiScale: clampUiScale(r.uiScale),
      fontSize: clampFontSize(r.fontSize)
  ```

  The two clamps are one line each and they cover **every** write path in the app, because
  `setSettings` re-hydrates its own patch (`store.ts:152`) — including the one in
  `SettingsSheet.tsx:128`, where a React `onChange` ignores the input's `min` and `max`.

  `hydrateProjectMeta` calls `tidy()` from `./projectMeta.ts`, which **D Task 34 creates**. Until D
  runs, inline the two caps and the trimming with exactly this body — **`tidy` returns
  `ProjectMeta | null`**, not `{}`, because that is the signature D Task 34 ships and the two must
  agree the day the inline copy is deleted:

  ```ts
  // D Task 34 replaces this with `import { tidy } from './projectMeta.ts'`.
  // It returns null — not an empty object — for a record that says nothing, so
  // the caller's drop test is `if (entry)` and stays correct after the swap.
  function tidy(meta: Partial<ProjectMeta>): ProjectMeta | null {
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
  ```

  and call it as `const entry = tidy(value as Partial<ProjectMeta>)` followed by
  `if (entry) out[key] = entry` — **not** `if (Object.keys(entry).length)`, which throws on the null
  §0.4's prose reads as `{}`. Do **not** export a second `MAX_EMOJI_CHARS` / `MAX_LABEL_CHARS` from
  this file — **D Task 34 Step 4a** deletes the inline copy (Step 3 only creates
  `src/main/projectMeta.ts`), and two exported copies of one pair of magic numbers is exactly how
  they stop agreeing.

- [ ] **Step 4: Reduce `src/main/store.ts` to persistence.** Delete `DEFAULTS`, `isProfileConfig`
  and `hydrate`; add `import { DEFAULT_SETTINGS, hydrateSettings } from './settingsSchema.ts'`
  and replace the two `hydrate(...)` calls and the two `{ ...DEFAULTS }` expressions accordingly.
  Nothing else in the file changes.

- [ ] **Step 5: Run it and watch it pass.** `node scripts/verify-settings.mts` → `all pass`.

- [ ] **Step 6: Register the suite.** In `package.json`, add
  `"verify:settings": "node scripts/verify-settings.mts"` after `verify:profiles`, and **insert**
  `&& npm run verify:settings` immediately after `npm run verify:profiles` in the `check` value.

  **Insert. Never quote or replace the whole `check` line** — six tasks across four parts add to
  it, and any step that pastes a full replacement silently deletes whatever the others added.
  Then run the guard for **this** point in the order. It names exactly the ten suites that must be
  in `check` once this task has landed — the nine there today plus `settings` — and no suite a
  later task creates:

  ```bash
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','profiles','settings','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"
  ```

  Expected: it prints nothing and exits 0. Any name it prints is a suite this step's insertion has
  just deleted from `check` — put it back. The five later registrations (Tasks 6, 7, 17, 34 and 55)
  each run the same guard with one more name in the array; all six commands are listed verbatim
  under Global Constraints.

- [ ] **Step 7: Run the whole check.** `npm run check` exits 0.

- [ ] **Step 7a: Document the new suite and the new module in `CLAUDE.md`.** In
  `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, insert into the verify-suite fenced block
  immediately after the `npm run verify:profiles` line (locate it by that text):

  ```
  npm run verify:settings       # settings hydration: repair, clamps, and what it drops
  ```

  and in the Layout block, immediately after the
  `  store.ts          settings persistence` line:

  ```
    settingsSchema.ts defaults + hydrate, with no electron import so a suite can run it
  ```

  Expected: `grep -cE "verify:settings|settingsSchema\.ts" CLAUDE.md` prints `2`.

- [ ] **Step 8: Commit.**
  `git commit -m "Make settings repair testable, and clamp the values a number input will not"`
  Body records: `hydrate` sat behind an electron import so none of it had ever been run outside a
  window, and `uiScale` was writable to any number because a React `onChange` ignores `min`/`max`.

### Task 4: Declare the token block, alongside the one it will replace

This task **declares** and changes nothing else. The `--sp-1 … --sp-8` block stays exactly where it
is and keeps every one of its 141 uses; the new tokens sit beside it, referenced by nothing. The
whole 4px migration — the perl sweep over app.css and the eight `.tsx` files, deleting the `--sp-*`
block, `body`'s line-height, the seven literal line-height values and `src/remote/style.css:526` —
is **F Task 64**, one commit at the head of workstream F. That is deliberate: every measurement A,
B, C, D and E take is then taken against an intact layout, and every commit up to F Task 64 is
visually correct.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (two blocks: `:root`,
  and `:root[data-appearance='light']` at line 91)
- Test: `npm run build`, then one `scripts/cdp-eval.mjs` measurement proving nothing moved

**Interfaces:**
- Consumes: `--accent`, `--surface-hover`, `--danger`, `--warning`, `--bg` (all existing tokens);
  `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces — twenty-five CSS custom properties, referenced by nothing until the task that lands the
  rule using each:
  `--space-4`, `--space-8`, `--space-12`, `--space-16`, `--space-24`, `--space-32`, `--space-48`
  (**F Task 64**); `--lh-tight`, `--lh-snug`, `--lh-normal` (**A Task 63**, **F Tasks 64 and 70**);
  `--icon-xs`, `--icon-sm`, `--icon-md`, `--icon-lg` (**F Task 69**); `--tab-indicator`,
  `--tab-dot-worklog`, `--ring-full` (**A Tasks 50, 51, 52**); `--traffic-lights-w`
  (**F Task 72**); `--surface-selected` (**F Task 66**); `--chevron` (**D Task 37**, **F Task 68**);
  `--control-h` (**F Task 70**); `--scrim`, `--swatch-ring`, `--shadow-panel`, `--on-danger`
  (**F Task 73**).

- [ ] **Step 1: Add the new tokens.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, immediately **after** the
  existing `--sp-1 … --sp-8` declarations in `:root` (locate them with
  `grep -n -- '--sp-1:' src/renderer/src/styles/app.css`), add exactly this:

  ```css
    /* Strict 4px scale. Named for the pixel value at scale 1, so a rule states
       its own geometry and a wrong one is obvious on sight. */
    --space-4: 0.25rem;
    --space-8: 0.5rem;
    --space-12: 0.75rem;
    --space-16: 1rem;
    --space-24: 1.5rem;
    --space-32: 2rem;
    --space-48: 3rem;

    --lh-tight: 1.25;   /* single-line controls: tab labels, chips, buttons */
    --lh-snug: 1.4;     /* headings, and two-line list rows */
    --lh-normal: 1.55;  /* body copy: prompts, proposal text, settings help */

    /* rem, so an icon grows with Interface scale. Today every icon is a px
       attribute, which is why scale 1.0 -> 1.6 moved every button 37.5% and left
       every glyph exactly where it was. */
    --icon-xs: 0.625rem;  /* 10px at scale 1 */
    --icon-sm: 0.75rem;   /* 12px */
    --icon-md: 0.875rem;  /* 14px */
    --icon-lg: 1rem;      /* 16px */

    /* A fixed slot for the tab indicator, so the empty circle, the filled ring
       and the ring-plus-dot are all the same width and the label never moves. */
    --tab-indicator: 0.875rem;   /* 14px */
    /* The only red in the tab strip: "the worklog is watching this session". */
    --tab-dot-worklog: var(--danger);
    /* A nearly-full context ring. No longer --danger: red means one thing now. */
    --ring-full: var(--warning);
    /* macOS traffic lights are fixed device px, so their clearance must be too.
       A rem here is why Stoke only laid out correctly at Interface scale 1.0. */
    --traffic-lights-w: 78px;
    /* A selected row must out-rank a hovered one in every theme. The mix is
       mirrored as SELECTED_ACCENT_MIX in scripts/verify-color.mts; change one and
       you must change the other, which is what that assertion is for. */
    --surface-selected: color-mix(in srgb, var(--accent) 18%, var(--surface-hover));
    /* The disclosure chevron's box, and the metadata picker's. Four rules have to
       agree with it - the two buttons, the project metadata's indent and where the
       session list's guide rule falls. It was an inline style in Sidebar.tsx,
       which is exactly how they drifted apart. */
    --chevron: 1.125rem;
    /* One height for every single-line control: .btn, .input, .select, .segmented. */
    --control-h: 1.75rem;
  ```

  Then, immediately **after** the existing `--shadow-lg` declaration in the same `:root` block
  (`app.css:88`), add:

  ```css
    --scrim: rgb(0 0 0 / 0.42);
    --swatch-ring: rgb(0 0 0 / 0.25);
    --shadow-panel: 0 12px 32px rgb(0 0 0 / 0.45);
    /* Text on a --danger fill. NOT white: recomputed from src/shared/themes.ts,
       #ffffff on --danger measures 2.89 (Ember), 2.84 (Nocturne), 2.70 (Moss) and
       6.01 (Daylight) - three of four fail 4.5:1, and two of those three sites are
       button text. var(--bg) measures 6.50, 6.66, 6.85 and 5.46: all four clear it.
       Mirrored by an assertion in scripts/verify-color.mts. */
    --on-danger: var(--bg);
  ```

  and, in the `:root[data-appearance='light']` block (it opens at `app.css:91`; locate it by that
  selector), after its `--shadow-lg`:

  ```css
    --scrim: rgb(0 0 0 / 0.28);
    --swatch-ring: rgb(0 0 0 / 0.16);
    --shadow-panel: 0 12px 32px rgb(0 0 0 / 0.16);
  ```

  **There is no `--on-danger` line in the light block, and that is deliberate.** Daylight's own
  `--bg` (`#f4f4f5`) already clears 4.5:1 against its `--danger`, so one declaration covers both
  appearances and a second spelling is a second thing to keep in sync.

  Delete nothing. Change no existing declaration.

- [ ] **Step 2: Build, to prove the CSS still parses and bundles.** `npm run build` exits 0.

- [ ] **Step 3: Measure that nothing moved.** With the app running
  (`npx electron . --remote-debugging-port=9222`), using contracts Task 5's probe:

  ```bash
  node scripts/cdp-eval.mjs "getComputedStyle(document.querySelector('.tab')).paddingInline"
  ```

  Expected: `"8px 6px"` — **unchanged**, exactly what it printed before this task. `.tab` is
  `padding: 0 var(--sp-2) 0 var(--sp-3)`, i.e. 8px left and 6px right today; it becomes a single
  `"8px"` only at F Task 64. A declaration-only task that moves a pixel has moved it by accident.

  (If Task 4 is executed before Task 5, defer this one step until `scripts/cdp-eval.mjs` exists.)

- [ ] **Step 4: Commit.**
  `git commit -m "Declare the 4px scale, the line-height, icon and shared tokens"`
  Body records: declaration only — the `--sp-*` block and all 141 of its uses are untouched, so
  this commit changes no pixel; the migration is one later commit, deliberately, so every
  measurement taken between here and there is taken against an intact layout. Notes that
  `--on-danger` is `var(--bg)` and not `#ffffff`, because white measures 2.70–2.89:1 on `--danger`
  in three of the four themes and two of those sites are button text.

### Task 5: The one CDP probe every measurement step uses

Roughly thirty steps across A, C, D, E and F measure the running app. Without one canonical probe,
four parts each ship their own — and three of the four drafts selected the CDP target by URL
(`file://`, `localhost:<port>`, `/index.html`, `/out/renderer/index.html`), which are exactly the
URLs the **docked browser** legitimately shows. That is CLAUDE.md gotcha 6 verbatim, and
`Array.find` takes whichever target Chromium enumerates first. Only a `window.stoke` probe is safe,
because contextBridge is injected into the renderer alone.

This task is the sole creator of `scripts/cdp-eval.mjs`. Four workstream drafts each wrote their
own probe and all four are gone in favour of this one; every workstream's Interfaces block carries
"Consumes: `scripts/cdp-eval.mjs` from contracts Task 5."

It registers **nothing** in `package.json`: it needs a live window, so it is deliberately not part
of `npm run check`.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/scripts/cdp-eval.mjs`
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (Layout block)
- Test: the three runs in Steps 2–4 — no endpoint, a live window, and the docked browser open

**Interfaces:**
- Consumes: `ws` (already a dependency of this repo — `src/main/remote/server.ts` uses it, so no
  install step); `node:fs`'s `writeFileSync`; the CDP endpoint the app exposes under
  `--remote-debugging-port`. Nothing from this plan.
- Produces: the executable `scripts/cdp-eval.mjs`, with exactly two invocations and no exported
  names:
  ```
  node scripts/cdp-eval.mjs "<javascript expression>"   # prints compact JSON on one line
  node scripts/cdp-eval.mjs --shot <file.png>           # prints the path it wrote
  ```
  Exit codes: **0** success; **1** no endpoint, no renderer, or the expression threw; **2** usage
  error. `CDP_PORT` overrides the default `9222`.
- Produces **nothing** in `package.json`. It needs a live window, so it is deliberately outside
  `npm run check`.

Who reads it: forty-odd measurement steps across A, C, D, E and F. Every workstream task that
measures the running app lists `scripts/cdp-eval.mjs` in its own Consumes and none of them writes
a second probe — four drafts did, and three of those four selected the CDP target by URL, which
gotcha 6 says cannot work.

- [ ] **Step 1: Create `scripts/cdp-eval.mjs`** with exactly this content:

  ```js
  /*
   * Evaluate one expression inside Stoke's own renderer, or screenshot it.
   *
   *   npm run build
   *   npx electron . --remote-debugging-port=9222 &
   *   node scripts/cdp-eval.mjs "getComputedStyle(document.body).lineHeight"
   *   node scripts/cdp-eval.mjs --shot /tmp/stoke.png
   *
   * Why this exists: every alignment defect in the UX overhaul was established by
   * measuring the running app, and none of them is visible any other way — the
   * terminal is a WebGL canvas so its DOM is empty (CLAUDE.md gotcha 5) and the
   * CSS reads correct while laying out wrong (gotcha 14).
   *
   * Page targets are filtered to the one holding a `window.stoke` contextBridge
   * object. Matching on URL is NOT enough: the docked browser is its own page
   * target (gotcha 6) and it exists precisely so the user can point it at a local
   * dev server or a file:// page, so `localhost:<port>`, `/index.html` and
   * `file://` are all URLs it legitimately shows. contextBridge is injected into
   * the renderer only, which is why it is the one reliable discriminator.
   *
   * The expression may be async; its promise is awaited before the value is
   * serialised, which is what lets a measurement dispatch an event and then read
   * the DOM React rendered in response. The page does the stringifying, so output
   * is compact JSON on one line.
   *
   * Deliberately not part of `npm run check`: it needs a live window.
   * Exit codes: 0 success; 1 no endpoint, no renderer, or the expression threw;
   * 2 usage error.
   */
  import { writeFileSync } from 'node:fs'
  import WebSocket from 'ws'

  const port = process.env.CDP_PORT ?? '9222'
  const argv = process.argv.slice(2)
  const wantsShot = argv[0] === '--shot'
  const arg = wantsShot ? argv[1] : argv.join(' ')

  if (!arg) {
    console.error('usage: node scripts/cdp-eval.mjs "<javascript expression>"')
    console.error('       node scripts/cdp-eval.mjs --shot <file.png>')
    process.exit(2)
  }

  let targets
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    targets = await res.json()
  } catch {
    console.error(
      `No CDP endpoint on port ${port}. Launch the app with --remote-debugging-port=${port} first.`
    )
    process.exit(1)
  }

  /** One request, matched back by id — replies and events share the socket. */
  function send(ws, id, method, params) {
    return new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        const msg = JSON.parse(String(raw))
        if (msg.id !== id) return
        ws.off('message', onMessage)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
      ws.on('message', onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(ws, id, expression) {
    const result = await send(ws, id, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let hit = null

  for (const page of pages) {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const isStoke = await evaluate(
        ws,
        1,
        'typeof window.stoke === "object" && typeof window.stoke.platform === "string"'
      )
      if (isStoke) {
        hit = ws
        break
      }
    } catch {
      /* a target that will not talk is not the renderer */
    }
    ws.close()
  }

  if (!hit) {
    console.error(
      `No Stoke renderer among ${pages.length} page target(s): ` +
        `${pages.map((p) => p.url).join(', ') || 'none'}`
    )
    process.exit(1)
  }

  try {
    if (wantsShot) {
      const result = await send(hit, 2, 'Page.captureScreenshot', { format: 'png' })
      writeFileSync(arg, Buffer.from(result.data, 'base64'))
      console.log(arg)
    } else {
      const value = await evaluate(
        hit,
        2,
        `Promise.resolve((() => (${arg}))()).then((v) => JSON.stringify(v))`
      )
      console.log(value)
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e))
    hit.close()
    process.exit(1)
  }

  hit.close()
  ```

- [ ] **Step 2: Run it with nothing listening.**

  ```bash
  node scripts/cdp-eval.mjs "1 + 1"
  ```

  Expected on **stderr**, exit code 1:
  `No CDP endpoint on port 9222. Launch the app with --remote-debugging-port=9222 first.`

- [ ] **Step 3: Run it against the app.**

  ```bash
  npm run build
  npx electron . --remote-debugging-port=9222 &
  node scripts/cdp-eval.mjs "1 + 1"
  node scripts/cdp-eval.mjs "document.title"
  node scripts/cdp-eval.mjs "typeof window.stoke.platform"
  ```

  Expected, one compact line each: `2`, `"Stoke"`, `"string"`. Note the quoting — the page does the
  stringifying, so a string value comes back JSON-quoted and every expected output written anywhere
  in this plan is **compact JSON**, never pretty-printed.

- [ ] **Step 4: Prove it picks the renderer and not the docked browser.** Open the browser panel in
  the app and point it at anything, then:

  ```bash
  node scripts/cdp-eval.mjs "({ targets: 'see stderr', stoke: typeof window.stoke })"
  node scripts/cdp-eval.mjs --shot /tmp/stoke-probe.png
  ```

  Expected: `{"targets":"see stderr","stoke":"object"}`, then `/tmp/stoke-probe.png`, and the image
  shows Stoke's own window. A URL-matching probe answers from the browser view here.

- [ ] **Step 4a: Name it in `CLAUDE.md`'s Layout block.** Thirty steps across five workstreams run
  this file and none of them would find it from the current one-line `scripts/` entry. In
  `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, locate the line by `grep -n "^scripts/" CLAUDE.md`
  and replace

  ```
  scripts/          the verify-*.mts suites, make-icon.cjs
  ```

  with

  ```
  scripts/          the verify-*.mts suites, make-icon.cjs
    cdp-eval.mjs      evaluates one expression in the renderer, or screenshots it.
                      Picks the target by its window.stoke object, never by URL
  ```

  Expected: `grep -cE "^  cdp-eval\.mjs" CLAUDE.md` prints `1`.

- [ ] **Step 5: Commit.**
  `git commit -m "Add the one CDP probe every measurement in this overhaul uses"`
  Body records: three separate drafts selected the target by URL, which is the one thing gotcha 6
  says cannot work — the docked browser is its own page target and exists to show `localhost`,
  `file://` and `/index.html` pages. The probe discriminates on the contextBridge object instead,
  which only the renderer has. Not chained into `npm run check`: it needs a live window.

---

## Workstream E — the statusLine data channel, and the widths the terminal draws with

This workstream lands first, because everything else in the overhaul that shows a number depends
on it. The context meter (spec 2.1) and the usage chip (spec 2.2) currently read two sources that
have both stopped working: `windowFromBanner` greps for a `(1M context)` string that claude
2.1.221 no longer prints, and `readOauthToken` reads `~/.claude/.credentials.json`, which does not
exist on macOS. One channel replaces both — the CLI pipes a JSON payload to whatever
`statusLine` command it is configured with, and that payload states the context window per model
from token zero and carries the plan's rate limits. Because the wrapper owns stdout, suppressing
the in-terminal status line (spec 2.3) is the same act as reading the data.

**Twelve tasks, 6–17.** Task 6 is independent of the payload work and runs **first**: it fixes the
two ways the terminal renders something other than what the CLI drew — the Unicode widths xterm
measures emoji and box drawing with (§2.12), and the colour selected text keeps under a
translucent selection (§2.13) — so every terminal screenshot taken anywhere in this plan from here
on shows a layout the CLI and the terminal agree about, and a selection that can be read.

Tasks 7–9 build `src/main/statusLine.ts` bottom-up (read the payload → generate the wrapper → fold
both settings keys into one file). Task 10 teaches `buildArgs` to take that file. Task 11 wires it
into the launch path. Task 12 points the context meter at it. Task 13 gets it to the renderer.
Tasks 14–15 spend it on the usage chip and the setting. Task 16 fixes the documentation it
invalidates. Task 17 repoints `verify:usage` at the payload, and runs last because it needs
`statusLineWindows` from Task 14 and the CLAUDE.md command list Task 16 rewrites.

**Prerequisite.** Tasks 1–5 of
`docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md` must already be merged.
This workstream imports `StatusLinePayload`, `StatusLineSnapshot`, `StatusLineWindowReading`,
`StatusLineRateLimit` and `Settings.hideStatusLine` from `src/shared/types.ts`, and
`CH.statusLineUpdate` / `CH.statusLineLast` from `src/shared/ipc.ts`. None of them are created here.

**Contracts Task 5 is the CDP probe, not the statusLine module.** There is no contracts task that
creates `src/main/statusLine.ts` or `scripts/verify-statusline.mts` — **E Tasks 7–9 create both,
and nothing else in the plan does.** That is what makes Task 7 Step 2's expected
`ERR_MODULE_NOT_FOUND` genuinely reachable. Contracts §0.2 is the contract those tasks satisfy: its
twelve-export list, `statusLineCommand`'s bare-quoted-path shape, `writeSessionSettingsFile`'s
`<statusLineDir()>/<sessionId>.settings.json` path, `writeStatusLineWrapper`'s unconditional
rewrite, and `windowFor` as a named export rather than an inline lambda.

**Interfaces, workstream-wide.** Consumes: `scripts/cdp-eval.mjs` from contracts Task 5. Every
measurement step below runs it and never writes its own probe. Because that probe has the page
stringify the value, **every expected output in this part is compact JSON on one line** — a string
comes back quoted, an object comes back with no spaces.

**House rules that bite in this workstream specifically.** `src/main/statusLine.ts` is imported by
a verify suite under `node --experimental-strip-types`, so every relative import it makes carries
an explicit `.ts`, and `@shared/types` may only be imported **type-only** (those are erased; a
value import of the alias fails at runtime with `ERR_MODULE_NOT_FOUND`). No TypeScript parameter
properties. The generated `wrapper.mjs` is plain JavaScript on purpose — that is what lets the
suite execute the real artefact rather than a re-implementation of it.

**Never quote the whole `package.json` `check` line.** Three tasks in this part touch it (the
first two and the last) plus contracts Task 3, D Task 34 and A Task 55. Every registration is an **insertion**,
followed by the guard given in each step. A step that pastes a full replacement line deletes
whatever the other five added and nothing fails.

> **Line numbers in this part are hints, not addresses.** Four workstreams insert
> into `src/renderer/src/App.tsx`, `src/renderer/src/styles/app.css`,
> `src/main/index.ts`, `src/renderer/src/components/TitleBar.tsx`,
> `src/renderer/src/components/Sidebar.tsx` and four verify suites, so any figure
> written as "currently line N" is correct only for the first task that runs.
> **Locate every edit by the quoted text**, not by the number: for CSS, by the
> selector (`grep -n "^\.project-meta {" src/renderer/src/styles/app.css`); for
> TS/TSX, by a unique quoted line from the block being replaced; for the verify
> suites, by **that suite's own** closing summary/exit pair — the five shapes are listed in
> Global Constraints, and `verify-context.mts`, `verify-color.mts` and `verify-worklog-retry.mts`
> each differ from the rest — inserting immediately above it. If the
> quoted text is not found, stop — a prerequisite task has not landed or has
> landed differently, and guessing at the location is how two parts silently
> overwrite each other.

---

---

### Task 6: The terminal disagrees with what the CLI drew — glyph widths, and selected text

Runs **first** in workstream E, and is independent of everything else in it: it touches
`TerminalView.tsx`, `src/shared/types.ts`, `src/shared/themes.ts`, `package.json` and two suites,
and nothing in E reads any of them. Only one task anywhere touches the same file afterwards —
F Task 66 appends to `scripts/verify-color.mts`, and appends only; see the note under
**Interfaces**. Landing this first means every terminal screenshot taken from here on — A Task 62,
C Task 30, F Task 74 — shows correctly-spaced glyphs, and a selection that can be read, instead of
a layout the CLI and the terminal disagree about.

**Spec: design §2.12 and §2.13, and workstream §4.E.6–8.** Both findings were made during planning
rather than in the original sweep, so both were written back into
`docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-design.md` — §2.12 with the width measurement
table below, §2.13 with the composited-contrast table — and listed as items 6, 7 and 8 of §4.E.
Read both before starting; this task implements them and adds nothing to either.

**Two defects, one task, deliberately.** They are the same class of bug in the same
`new Terminal({...})` call at `TerminalView.tsx:58-71`: the terminal renders something other than
what the CLI that produced the bytes assumed. They share a commit because they share a
verification pass — one build, one app launch, one scratch session, one `window.stokeTerminals`
handle read by both CDP probes — and because both have to land before any later task photographs a
terminal. Splitting them would mean launching the app twice to prove one constructor, and the
second task would inherit the first's `window.stokeTerminals` as an undeclared dependency. Task
numbers here are fixed at 1–74 and are referenced by number across six workstreams, so inserting a
75th between 6 and 7 is not available either.

#### 6a — glyph widths

`TerminalView.tsx:66` already sets `allowProposedApi: true`, which is the prerequisite for a
Unicode provider, but only `fit`, `web-links` and `webgl` are loaded — so **no provider is ever
registered** and xterm falls back to its built-in **Unicode 6** width tables while Claude Code's
own TUI lays out with modern (string-width) widths. The two disagree, and that disagreement is the
reported misrendering: emoji added since 2010 occupy one cell in the terminal and two everywhere
else, so box drawing and status lines tear.

**The addon, measured rather than assumed.** Use **`@xterm/addon-unicode-graphemes@^0.4.0`** with
`term.unicode.activeVersion = '15-graphemes'`. **Not `@xterm/addon-unicode11`.** Measured under
`@xterm/headless@6.0.0` against the real addons:

| provider | `U+1FA9F` 🪟 | `U+1F5D3 U+FE0F` 🗓️ | `U+2588` █ |
|---|---|---|---|
| built-in `'6'` (today) | width 1 | width 1 | width 1 |
| `addon-unicode11` (`'11'`) | width 1 | width 1 | width 1 |
| `addon-unicode-graphemes` at `'15'` | width 2 | cursorX **3** — the variation selector lands in its own cell | width 1 |
| `addon-unicode-graphemes` at `'15-graphemes'` | width 2 | width 2, one cell holding `🗓️` | width 1 |

`unicode11` fixes **none** of the three characters 6a exists for, so shipping it would give the
task an acceptance test it cannot pass. Plain `'15'` is worse than today for the calendar glyph.
`U+2588` is East-Asian Ambiguous and correctly stays one cell in every provider — which is
also what the CLI assumes, so it must not change. `addon-unicode-graphemes` is xterm's own
successor to `unicode11`, it is on the same 0.x release train as the addons already pinned here
(`fit` 0.11.0, `webgl` 0.19.0), and its widths agree with the string-width model the CLI lays out
with.

#### 6b — selected text keeps its own colour under a translucent wash

Spec §2.13. `terminalTheme()` (`src/renderer/src/lib/theme.ts:59-61`) is
`return { ...theme.terminal }`, so xterm's theme is exactly the 21 keys of `TerminalColors`
(`src/shared/types.ts:155-177`). Neither `selectionForeground` nor `selectionInactiveBackground`
is among them; both are accepted by xterm
(`node_modules/@xterm/xterm/typings/xterm.d.ts:355` and `:360`). Confirm before starting —
`grep -rn "selectionForeground" src scripts` must print nothing.

With no `selectionForeground`, xterm replaces only the *background* of a selected cell. The
foreground stays whatever the CLI set it to, `allowTransparency: true`
(`TerminalView.tsx:67`) honours the selection's alpha, and `minimumContrastRatio: 1`
(`TerminalView.tsx:69`) is xterm's off switch for contrast correction. So selected text is drawn
in its own colour on a ground it was never checked against.

**The ground, computed.** xterm composites the translucent selection over the theme background
itself and paints the blend, so the effective colour is `src/shared/color.ts`'s `over()`. For
ember — `background: '#14110f'` = rgb(20, 17, 15), `selectionBackground:
'rgba(255, 149, 82, 0.28)'`:

```
r = 255×0.28 + 20×0.72 = 71.40 + 14.40 = 85.80  → 0x56
g = 149×0.28 + 17×0.72 = 41.72 + 12.24 = 53.96  → 0x36
b =  82×0.28 + 15×0.72 = 22.96 + 10.80 = 33.76  → 0x22   →  #563622
```

All four, and the values this task writes. Every ratio is WCAG 2 `contrastRatio()` from
`src/shared/color.ts`, computed against the **composited** ground, never against the theme
background:

| theme | background | `selectionBackground` (existing) | composited | **`selectionForeground`** (new) | ratio |
|---|---|---|---|---|---|
| ember | `#14110f` | `rgba(255, 149, 82, 0.28)` | `#563622` | `#f2e9e1` | **9.01** |
| nocturne | `#0d1117` | `rgba(110, 168, 254, 0.28)` | `#283b58` | `#e4ebf3` | **9.39** |
| moss | `#101511` | `rgba(143, 214, 127, 0.26)` | `#31472e` | `#e7f0e6` | **8.68** |
| daylight | `#f4f4f5` | `rgba(183, 72, 10, 0.18)` | `#e9d5cb` | `#1c1c1f` | **12.02** |

Each `selectionForeground` is that theme's **own** `terminal.foreground`, unchanged — no new
colour enters any palette. The lowest margin is moss at 8.68:1, nearly double the 4.5:1 floor.

**`selectionInactiveBackground`** is the same hue at a lower alpha. xterm falls back to
`selectionBackgroundTransparent` when the key is absent, so today a focused and an unfocused
selection composite to the identical colour. The same `selectionForeground` is used in both
states, so it has to clear 4.5:1 on both grounds:

| theme | **`selectionInactiveBackground`** (new) | composited | ratio vs its `selectionForeground` |
|---|---|---|---|
| ember | `rgba(255, 149, 82, 0.16)` | `#3a261a` | **11.91** |
| nocturne | `rgba(110, 168, 254, 0.16)` | `#1d293c` | **12.18** |
| moss | `rgba(143, 214, 127, 0.15)` | `#233222` | **11.62** |
| daylight | `rgba(183, 72, 10, 0.10)` | `#eee3de` | **13.48** |

Lower alpha moves the ground back toward the background, which on a dark theme means *more*
contrast for light text and on a light theme means more for dark text — so the focused ground is
the binding constraint in every theme and the unfocused figures are all slack. What the lower
alpha must not do is vanish, so `perceptualDistance()` pins both edges: unfocused-vs-background
and focused-vs-unfocused, each above 0.02. The tightest is daylight at 0.0473 and 0.0379.

**No change to `TerminalView.tsx` is needed for 6b.** `terminalTheme()` spreads whatever
`theme.terminal` holds, so adding the keys to `src/shared/themes.ts` carries them into the live
terminal, and the theme effect at `TerminalView.tsx:240-243` reapplies them on a theme switch.
**No change to `validateTheme` either** — its `pick` helper iterates the *base* theme's keys
(`src/shared/themes.ts:260-267`), so both new keys are backfilled into every persisted theme the
moment the built-ins carry them.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/scripts/verify-unicode.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TerminalView.tsx`
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/types.ts` — two keys on `TerminalColors`.
  Locate it with `grep -n "^export interface TerminalColors" src/shared/types.ts`.
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/themes.ts` — two keys in each of the four
  `terminal` blocks. Locate each with
  `grep -n "selectionBackground:" src/shared/themes.ts` (four hits, one per theme, in the order
  ember, nocturne, moss, daylight).
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts` — the import block, and one
  new block before the final tally
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` (devDependencies, `verify:unicode`, `check`)
- Test: `node scripts/verify-unicode.mts`, `npm run verify:color`, then a CDP measurement and a
  screenshot

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5.
- Consumes: `Terminal` from `@xterm/xterm` (existing import in `TerminalView.tsx`); `tab.ptyId`
  (existing prop).
- Consumes: `contrastRatio`, `over`, `parseColor`, `perceptualDistance`, `toHex` from
  `src/shared/color.ts`; `BUILT_IN_THEMES` from `src/shared/themes.ts`.
- Produces: `window.stokeTerminals: Map<string, Terminal>` in the renderer — a read-only handle for
  measurement, written **only** by this task and read by nothing in the app.
- Produces: `TerminalColors.selectionForeground` and `TerminalColors.selectionInactiveBackground`,
  both `string` and both **required** — the type is what stops a fifth theme shipping without them.

**The `verify-color.mts` import block is touched again by F Task 66**, which restates it in full
as a strict superset of what this task leaves behind (it adds only the two type-only imports
`Rgb` and `Theme`). Add exactly the two entries named in Step 6 and nothing else, and Task 66's
later rewrite loses nothing.

- [ ] **Step 1: Write the failing suite**

  Create `scripts/verify-unicode.mts`, copying the `check` helper and output format from
  `scripts/verify-worklog-gate.mts`:

  ```ts
  /*
   * xterm measures every character against a width table, and Claude Code's TUI
   * measures the same characters against a different one. When they disagree the
   * terminal tears: a glyph the CLI drew two cells wide is stored in one, so
   * everything after it on that line is off by one and box drawing does not meet.
   *
   * xterm ships Unicode 6 tables — 2010 — so every emoji added since is one cell
   * wide to it. This suite pins which provider is loaded and what it measures,
   * against the real addon rather than a description of it.
   *
   *   node scripts/verify-unicode.mts
   */
  import pkg from '@xterm/headless'
  import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

  // Default import: @xterm/headless is CJS and exposes no named ESM exports, so
  // `import { Terminal } from '@xterm/headless'` throws at link time.
  const { Terminal } = pkg

  let failures = 0
  function check(name: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failures++
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
        (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    )
  }

  const term = new Terminal({ cols: 120, rows: 6, allowProposedApi: true })

  /** The callback form, so nothing here depends on a timer. */
  function write(s: string): Promise<void> {
    return new Promise<void>((r) => term.write(s, r))
  }

  /** Write one string on a fresh line and report what the buffer holds. */
  async function measure(s: string): Promise<{
    cursorX: number
    w0: number
    c0: string
  }> {
    await write('\r\n')
    await write(s)
    const b = term.buffer.active
    const line = b.getLine(b.cursorY)!
    return { cursorX: b.cursorX, w0: line.getCell(0)!.getWidth(), c0: line.getCell(0)!.getChars() }
  }

  console.log('\nwhat xterm measures with out of the box')
  check('the built-in provider is Unicode 6', term.unicode.activeVersion, '6')
  check('and it is the only one registered', term.unicode.versions, ['6'])
  check('U+1FA9F is one cell wide, which is the bug', await measure('\u{1FA9F}'), {
    cursorX: 1,
    w0: 1,
    c0: '\u{1FA9F}'
  })
  check('so is U+1F5D3 with its variation selector', await measure('\u{1F5D3}\u{FE0F}'), {
    cursorX: 1,
    w0: 1,
    c0: '\u{1F5D3}\u{FE0F}'
  })
  check('and so is a 2010 emoji', await measure('\u{1F600}'), {
    cursorX: 1,
    w0: 1,
    c0: '\u{1F600}'
  })
  {
    const box = await measure('█'.repeat(30))
    check('a full block is one cell, and thirty of them are thirty', [box.cursorX, box.w0], [30, 1])
  }

  console.log('\nwith the graphemes provider loaded')
  term.loadAddon(new UnicodeGraphemesAddon())
  check('the addon selects itself', term.unicode.activeVersion, '15-graphemes')
  check('and registers both of its tables', term.unicode.versions, ['6', '15', '15-graphemes'])

  console.log('\nwhy 15-graphemes and not 15')
  term.unicode.activeVersion = '15'
  check(
    "plain '15' splits the variation selector into its own cell, which is worse than today",
    (await measure('\u{1F5D3}\u{FE0F}')).cursorX,
    3
  )
  term.unicode.activeVersion = '15-graphemes'

  console.log('\nthe widths the CLI drew those characters at')
  check('U+1FA9F is two cells, in one cell holding one glyph', await measure('\u{1FA9F}'), {
    cursorX: 2,
    w0: 2,
    c0: '\u{1FA9F}'
  })
  check('U+1F5D3 + VS16 is two cells, clustered', await measure('\u{1F5D3}\u{FE0F}'), {
    cursorX: 2,
    w0: 2,
    c0: '\u{1F5D3}\u{FE0F}'
  })
  check('and a 2010 emoji agrees', await measure('\u{1F600}'), {
    cursorX: 2,
    w0: 2,
    c0: '\u{1F600}'
  })
  {
    const box = await measure('█'.repeat(30))
    check(
      'U+2588 is East-Asian Ambiguous and STAYS one cell, which is what the CLI assumes too',
      [box.cursorX, box.w0],
      [30, 1]
    )
  }
  check('and ASCII is untouched', (await measure('AB')).cursorX, 2)

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exitCode = failures ? 1 : 0
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-unicode.mts
  ```

  Expected, before any output:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@xterm/headless' imported from /Users/thevinh/dev/personal/stoke/scripts/verify-unicode.mts`

- [ ] **Step 3: Install the addon and the headless terminal**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm i -D @xterm/headless@^6.0.0 @xterm/addon-unicode-graphemes@^0.4.0
  ```

  `devDependencies`, matching `@xterm/addon-fit` and `@xterm/addon-webgl` — vite bundles the addon
  into the renderer, and `@xterm/headless` is used only by the suite. Then:

  ```bash
  node scripts/verify-unicode.mts
  ```

  Expected: every line `PASS`, and `all pass`.

- [ ] **Step 4: Load it in the app**

  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TerminalView.tsx`, add to the
  imports:

  ```tsx
  import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
  ```

  and immediately after `const fit = new FitAddon()` / `term.loadAddon(fit)` (locate it by that
  quoted pair), insert:

  ```tsx
    // Unicode 15 widths with grapheme clustering. xterm's built-in tables are
    // Unicode 6, so every emoji added since 2010 is measured one cell wide
    // while the CLI that drew it assumed two — which is why box drawing and
    // status lines tear, locally and over SSH. Set explicitly even though the
    // addon selects it, so the version this app depends on is greppable.
    term.loadAddon(new UnicodeGraphemesAddon())
    term.unicode.activeVersion = '15-graphemes'
  ```

- [ ] **Step 5: Make the renderer measurable**

  Still in `TerminalView.tsx`, immediately after `term.open(host)`:

  ```tsx
    /*
     * A read-only handle on the live terminals, keyed by pty id.
     *
     * xterm draws through WebGL, so `.xterm-rows` is empty and nothing about
     * what the terminal renders is readable from the DOM (CLAUDE.md gotcha 5).
     * Cell widths, the active Unicode version and the cursor column are only
     * readable from the Terminal object, and a CDP probe has no other route to
     * it. Nothing in the app reads this map.
     */
    const live = window as unknown as { stokeTerminals?: Map<string, Terminal> }
    live.stokeTerminals ??= new Map()
    live.stokeTerminals.set(tab.ptyId, term)
  ```

  and add, in that same effect's cleanup function beside the existing `term.dispose()`:

  ```tsx
      live.stokeTerminals?.delete(tab.ptyId)
  ```

- [ ] **Step 6: Assert the selection colours, and watch them fail**

  In `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts`, extend the import block — locate
  it with `grep -n "from '../src/shared/color.ts'" scripts/verify-color.mts` — by adding `over` to
  the named list and one new import line beneath it, so the block reads:

  ```ts
  import {
    apcaContrast,
    contrastRatio,
    over,
    parseColor,
    perceptualDistance,
    toHex,
    toOklch
  } from '../src/shared/color.ts'
  import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
  ```

  Then insert this block immediately **above** this suite's closing pair — for `verify-color.mts`
  that pair is ``console.log(failures ? `\n${failures} failure(s)` : '\nall colour checks pass')``
  followed by `process.exit(failures ? 1 : 0)`, which is different from every other suite's; see
  "The closing pair is not one anchor — it is five" in this plan's preamble:

  ```ts
  console.log('\n-- the terminal: text on a translucent selection --')
  /*
   * xterm composites `selectionBackground` over `background` itself and paints
   * the blend, so the ground selected text actually sits on is the alpha blend —
   * never the raw rgba() and never the theme background. `minimumContrastRatio`
   * is 1 in TerminalView, which is xterm's off switch, so nothing corrects a bad
   * pair afterwards: whatever these numbers say is what the user reads.
   *
   * The same `selectionForeground` is used whether the terminal has focus or not,
   * so it has to clear 4.5:1 against both grounds.
   */
  const SELECTION_ANSI = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite'
  ] as const

  for (const theme of BUILT_IN_THEMES) {
    const term = theme.terminal
    const bg = parseColor(term.background)!
    const fg = parseColor(term.selectionForeground)
    const focusedRaw = parseColor(term.selectionBackground)
    const unfocusedRaw = parseColor(term.selectionInactiveBackground)

    if (!fg || !focusedRaw || !unfocusedRaw) {
      failures++
      console.log(
        `FAIL ${`${theme.id}: defines both selection keys`.padEnd(46)} ${'missing'.padStart(10)}  (selectionForeground=${String(
          term.selectionForeground
        )}, selectionInactiveBackground=${String(term.selectionInactiveBackground)})`
      )
      continue
    }

    const focused = over(focusedRaw, bg)
    const unfocused = over(unfocusedRaw, bg)

    for (const [state, ground] of [
      ['focused', focused],
      ['unfocused', unfocused]
    ] as const) {
      const ratio = contrastRatio(fg, ground)
      const ok = ratio >= 4.5
      if (!ok) failures++
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${`${theme.id}: selected text, ${state} (${toHex(ground)})`.padEnd(
          46
        )} ${ratio.toFixed(2).padStart(10)}  (expected >= 4.5)`
      )
    }

    // Why the override is not decorative: these are the palette entries that keep
    // their own colour, and fail, when selectionForeground is absent.
    const below = SELECTION_ANSI.filter((n) => contrastRatio(parseColor(term[n])!, focused) < 4.5)
    const okBelow = below.length >= 1
    if (!okBelow) failures++
    console.log(
      `${okBelow ? 'ok  ' : 'FAIL'} ${`${theme.id}: ansi colours needing the override`.padEnd(
        46
      )} ${`${below.length}/16`.padStart(10)}  (expected >= 1)`
    )

    // An unfocused selection must still read as a selection, and must not read as
    // a focused one. Both are the point of having the second colour at all.
    const seen = perceptualDistance(unfocused, bg)
    const apart = perceptualDistance(focused, unfocused)
    const okPair = seen > 0.02 && apart > 0.02
    if (!okPair) failures++
    console.log(
      `${okPair ? 'ok  ' : 'FAIL'} ${`${theme.id}: unfocused is visible and weaker`.padEnd(
        46
      )} ${`${seen.toFixed(4)}/${apart.toFixed(4)}`.padStart(10)}  (expected both > 0.02)`
    )
  }
  ```

  `scripts/**` is in neither tsconfig's `include`, so this compiles nowhere and reads two keys that
  do not exist yet — which is the point. Run it:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run verify:color
  ```

  Expected: every pre-existing check still `ok`, then exactly

  ```
  -- the terminal: text on a translucent selection --
  FAIL ember: defines both selection keys                missing  (selectionForeground=undefined, selectionInactiveBackground=undefined)
  FAIL nocturne: defines both selection keys             missing  (selectionForeground=undefined, selectionInactiveBackground=undefined)
  FAIL moss: defines both selection keys                 missing  (selectionForeground=undefined, selectionInactiveBackground=undefined)
  FAIL daylight: defines both selection keys             missing  (selectionForeground=undefined, selectionInactiveBackground=undefined)

  4 failure(s)
  ```

  and exit 1.

- [ ] **Step 7: Make the two keys required, and watch the typecheck fail**

  In `/Users/thevinh/dev/personal/stoke/src/shared/types.ts`, inside `interface TerminalColors`,
  insert between the existing `selectionBackground: string` line and the `black: string` line that
  follows it:

  ```ts
    /**
     * The colour selected text is drawn in.
     *
     * Required, not optional. Without it xterm replaces only the background of a
     * selected cell and the text keeps whatever colour the CLI gave it, on a
     * ground it was never checked against - and `minimumContrastRatio: 1` in
     * TerminalView means nothing corrects the pair afterwards. Every value here
     * is asserted against its own selection background composited over
     * `background` in scripts/verify-color.mts.
     */
    selectionForeground: string
    /**
     * The selection background when the terminal does not have focus.
     *
     * Required for the same reason: xterm falls back to `selectionBackground`
     * when it is absent, so a selection in an unfocused terminal is drawn exactly
     * like the live one.
     */
    selectionInactiveBackground: string
  ```

  Then:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck
  ```

  Expected: **four** errors and nothing else, one per built-in theme, each reading

  ```
  src/shared/themes.ts(39,3): error TS2739: Type '{ background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string; black: string; red: string; green: string; yellow: string; blue: string; magenta: string; ... 9 more ...; brightWhite: string; }' is missing the following properties from type 'TerminalColors': selectionForeground, selectionInactiveBackground
  ```

  with the line numbers `39`, `89`, `139` and `194`. Four and only four: `src/remote/main.ts:633`
  passes an inline object to xterm's own `ITheme`, not to `TerminalColors`, so it is untouched by
  this change and must not appear.

- [ ] **Step 8: Give all four themes their measured values**

  In `/Users/thevinh/dev/personal/stoke/src/shared/themes.ts`, insert two lines immediately after
  each of the four `selectionBackground:` lines. Locate them with
  `grep -n "selectionBackground:" src/shared/themes.ts` — four hits, in the order ember, nocturne,
  moss, daylight. Each `selectionForeground` is that theme's own `terminal.foreground`, so no new
  colour enters any palette; the ratios are in the 6b tables above.

  After `selectionBackground: 'rgba(255, 149, 82, 0.28)',` (ember):

  ```ts
      selectionForeground: '#f2e9e1',
      selectionInactiveBackground: 'rgba(255, 149, 82, 0.16)',
  ```

  After `selectionBackground: 'rgba(110, 168, 254, 0.28)',` (nocturne):

  ```ts
      selectionForeground: '#e4ebf3',
      selectionInactiveBackground: 'rgba(110, 168, 254, 0.16)',
  ```

  After `selectionBackground: 'rgba(143, 214, 127, 0.26)',` (moss):

  ```ts
      selectionForeground: '#e7f0e6',
      selectionInactiveBackground: 'rgba(143, 214, 127, 0.15)',
  ```

  After `selectionBackground: 'rgba(183, 72, 10, 0.18)',` (daylight):

  ```ts
      selectionForeground: '#1c1c1f',
      selectionInactiveBackground: 'rgba(183, 72, 10, 0.10)',
  ```

  Then:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run verify:color
  ```

  Expected: `typecheck` prints only its two `tsc` command lines and exits 0, then `verify:color`
  ends with exactly

  ```
  -- the terminal: text on a translucent selection --
  ok   ember: selected text, focused (#563622)              9.01  (expected >= 4.5)
  ok   ember: selected text, unfocused (#3a261a)           11.91  (expected >= 4.5)
  ok   ember: ansi colours needing the override             3/16  (expected >= 1)
  ok   ember: unfocused is visible and weaker         0.1130/0.0788  (expected both > 0.02)
  ok   nocturne: selected text, focused (#283b58)           9.39  (expected >= 4.5)
  ok   nocturne: selected text, unfocused (#1d293c)        12.18  (expected >= 4.5)
  ok   nocturne: ansi colours needing the override          4/16  (expected >= 1)
  ok   nocturne: unfocused is visible and weaker      0.1061/0.0735  (expected both > 0.02)
  ok   moss: selected text, focused (#31472e)               8.68  (expected >= 4.5)
  ok   moss: selected text, unfocused (#233222)            11.62  (expected >= 4.5)
  ok   moss: ansi colours needing the override              4/16  (expected >= 1)
  ok   moss: unfocused is visible and weaker          0.1120/0.0758  (expected both > 0.02)
  ok   daylight: selected text, focused (#e9d5cb)          12.02  (expected >= 4.5)
  ok   daylight: selected text, unfocused (#eee3de)        13.48  (expected >= 4.5)
  ok   daylight: ansi colours needing the override         12/16  (expected >= 1)
  ok   daylight: unfocused is visible and weaker      0.0473/0.0379  (expected both > 0.02)

  all colour checks pass
  ```

  If a ratio differs from these to the second decimal, a value was mistyped — the arithmetic is
  fixed, so the numbers are too.

- [ ] **Step 9: Register the suite**

  In `package.json`, add after the `"verify:context"` entry:

  ```json
      "verify:unicode": "node scripts/verify-unicode.mts",
  ```

  and **insert** `&& npm run verify:unicode` into the `check` value immediately after
  `npm run verify:context`. Insert — never quote or retype the whole `check` line; six tasks across
  four parts add to it.

  **Anchor on `verify:context`, not on `verify:statusline`.** This task runs first in workstream E,
  so `verify:statusline` does not exist yet: the next task creates it and inserts it immediately
  after `npm run verify:context` as well, which lands it *between* `context` and `unicode` and gives
  the final chain `context → statusline → unicode → usage`. Then run this task's guard — the eleven
  suites that must be in `check` once this insertion has landed, and no name a later task creates:

  ```bash
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','unicode','profiles','settings','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"
  ```

  Expected: it prints nothing and exits 0. Any name it prints is a suite this insertion has just
  deleted — put it back.

- [ ] **Step 10: Measure it rendered, over CDP**

  ```bash
  npm run build
  npx electron . --remote-debugging-port=9222 &
  ```

  In the app, open a **scratch** session — never a terminal running real work, because the next
  command writes into it. Then:

  ```bash
  node scripts/cdp-eval.mjs "[...window.stokeTerminals.values()][0].unicode.activeVersion"
  ```

  Expected: `"15-graphemes"`. Then:

  ```bash
  node scripts/cdp-eval.mjs "(async () => { const t = [...window.stokeTerminals.values()][0]; await new Promise((r) => t.write('\\r\\n\\u{1FA9F}\\u{1F5D3}\\u{FE0F}', r)); const b = t.buffer.active; const l = b.getLine(b.cursorY); return { cursorX: b.cursorX, w0: l.getCell(0).getWidth(), c0: l.getCell(0).getChars(), w2: l.getCell(2).getWidth(), c2: l.getCell(2).getChars() } })()"
  ```

  Expected **after** this task: `{"cursorX":4,"w0":2,"c0":"🪟","w2":2,"c2":"🗓️"}`.
  Run the same expression against the pre-task build to record the failure:
  `{"cursorX":2,"w0":1,"c0":"🪟","w2":1,"c2":""}`.

  Now the selection colours, through the same handle. This reads the theme the running app
  actually applied — not the source file — and recomputes the composite with the same arithmetic
  the suite uses, so it catches a theme or profile switch changing the answer at runtime:

  ```bash
  node scripts/cdp-eval.mjs "(() => { const th = [...window.stokeTerminals.values()][0].options.theme; const p = (s) => { const m = String(s).match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 } }; const px = (h) => ({ r: parseInt(h.slice(1,3),16), g: parseInt(h.slice(3,5),16), b: parseInt(h.slice(5,7),16) }); const hx = (c) => '#' + [c.r,c.g,c.b].map((n) => Math.round(n).toString(16).padStart(2,'0')).join(''); const L = (c) => [c.r,c.g,c.b].map((v) => { const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4) }).reduce((a,v,i) => a + [0.2126,0.7152,0.0722][i]*v, 0); const bg = px(th.background); const s = p(th.selectionBackground); const g = { r: s.r*s.a + bg.r*(1-s.a), g: s.g*s.a + bg.g*(1-s.a), b: s.b*s.a + bg.b*(1-s.a) }; const f = px(th.selectionForeground); const l1 = L(f), l2 = L(g); return { fg: th.selectionForeground, ground: hx(g), ratio: Number((((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))).toFixed(2)) } })()"
  ```

  Expected: the row below for whichever theme is selected in Settings → Appearance. Ember is the
  default (`DEFAULT_THEME_ID`, `src/shared/themes.ts:221`); this machine is set to moss.

  | theme | expected output |
  |---|---|
  | ember | `{"fg":"#f2e9e1","ground":"#563622","ratio":9.01}` |
  | nocturne | `{"fg":"#e4ebf3","ground":"#283b58","ratio":9.39}` |
  | moss | `{"fg":"#e7f0e6","ground":"#31472e","ratio":8.68}` |
  | daylight | `{"fg":"#1c1c1f","ground":"#e9d5cb","ratio":12.02}` |

  There is no soft failure here, so read the error rather than the value: if `terminalTheme()` did
  not carry the key through — Step 8 not saved, or a stale build — the expression throws
  `TypeError: Cannot read properties of undefined (reading 'slice')` from inside `px`, because
  `th.selectionForeground` is `undefined`. Any other error is a probe problem, not a theme one.

  Then take the images, because gotcha 5 says a screenshot is the only way to confirm what the
  terminal actually rendered. First the glyphs:

  ```bash
  node scripts/cdp-eval.mjs --shot /tmp/stoke-unicode.png
  ```

  Confirm from `/tmp/stoke-unicode.png` that the two glyphs are not clipped and the text after them
  is not overlapped. Then the selection: in the scratch session run `claude` far enough to get a
  status line, **Shift**-drag across it (a plain drag is forwarded to the application — `CLAUDE.md`
  gotcha 10), and:

  ```bash
  node scripts/cdp-eval.mjs --shot /tmp/stoke-selection.png
  ```

  Confirm from `/tmp/stoke-selection.png` that every segment of the highlighted status line is
  legible, including the dim ones, and that the selected text is a single colour rather than
  keeping its per-segment colours. Then click into the sidebar and shoot again to
  `/tmp/stoke-selection-unfocused.png`: the selection must still be visible and visibly weaker than
  it was. Close the scratch tab.

- [ ] **Step 11: Run the whole check and commit**

  ```bash
  npm run check
  ```

  Expect exit 0, including `verify:unicode` in its new slot **after `verify:context`**, and
  `verify:color` ending in `all colour checks pass`.

  > Not "after `verify:statusline`" — that suite does not exist yet. Task 7 creates it and inserts it
  > between `verify:context` and `verify:unicode`, which is why Step 9 anchored this insertion on
  > `verify:context`. The final order once Tasks 6, 7 and 17 have all run is
  > `context → statusline → unicode → usage`.

  ```bash
  git add package.json package-lock.json scripts/verify-unicode.mts scripts/verify-color.mts src/renderer/src/components/TerminalView.tsx src/shared/types.ts src/shared/themes.ts
  git commit -m "$(cat <<'EOF'
  Render what the CLI drew: glyph widths, and text under a selection

  Two defects in one terminal constructor, both of them the terminal disagreeing
  with the process that produced the bytes.

  Widths: xterm ships Unicode 6 tables and Claude Code's TUI lays out with modern
  widths, so U+1FA9F and U+1F5D3+VS16 were one cell wide in the terminal and two
  everywhere else — every character after them on the line was off by one, which
  is why box drawing did not meet, locally and over SSH. U+2588 is East-Asian
  Ambiguous and correctly stays one cell in both, so nothing about block-drawn
  output moves. addon-unicode11 was measured first and fixes neither character;
  plain '15' splits the variation selector into its own cell, which is worse than
  today. Only 15-graphemes clusters them.

  Selection: the themes set a translucent selectionBackground and no
  selectionForeground, so xterm replaced only the background of a selected cell
  and the text kept its own colour under a coloured wash — with
  minimumContrastRatio at 1, nothing corrected the pair. Ordinary output survived
  that (9.01:1 on ember) but the status line did not: its dim segments are
  brightBlack, which measures 1.88:1 on ember and 1.86:1 on moss against the
  composited selection ground, and daylight had 12 of 16 palette colours below
  4.5:1. Each theme's selectionForeground is its own foreground, checked against
  the alpha blend rather than against the background, and pinned in
  verify-color.mts. selectionInactiveBackground exists because xterm falls back to
  selectionBackground without it, so an unfocused selection was drawn exactly like
  the live one.

  Both keys are required on TerminalColors, so a fifth theme cannot ship without
  them; validateTheme backfills every persisted theme for free. window.stokeTerminals
  exists purely so a CDP probe can read cell widths and the applied theme, since a
  WebGL terminal has no DOM to read.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 7: Read the statusLine payload

Nothing produces a payload yet, so this task starts at the other end: the parser and the on-disk
reader, with the exact payload captured from claude 2.1.221 as its fixture. The one hazard worth
pinning immediately is that `rate_limits.*.resets_at` is epoch **seconds** while every other
timestamp in Stoke is milliseconds.

**Files:**
- Create: `src/main/statusLine.ts` — **this task is its sole creator.** No contracts task lands it;
  contracts §0.2 is the contract, and Tasks 7–12 satisfy it.
- Create: `scripts/verify-statusline.mts` — same: nothing else in the plan creates it.
- Modify: `package.json` (add the `verify:statusline` script after `verify:context`; insert it into
  `check` — see Step 5, which is an insertion and not a replacement)
- Test: `node scripts/verify-statusline.mts`

**Interfaces:**
- Consumes: `StatusLinePayload`, `StatusLineRateLimit`, `StatusLineSnapshot`, `StatusLineWindowReading` — all type-only from `@shared/types`, landed by the contracts tasks.
- Produces:
  - `export function statusLineDir(): string`
  - `export function statusLinePayloadFile(sessionId: string): string`
  - `export function toSnapshot(key: string, payload: StatusLinePayload, receivedAt: number): StatusLineSnapshot`
  - `export function readStatusLine(sessionId: string): StatusLineSnapshot | null`

  **What the string argument to those three actually is: the statusLine *key*.** For every session
  Stoke mints an id for — which is every session except a `--continue` — the key **is** the session
  id, so contracts §0.2's `sessionId` naming stays true and no caller changes. A `--continue`
  session's id is chosen by the CLI after launch (`pty.ts:137-138` leaves `sessionId` empty for
  it), so E Task 11 names its files after a launch key instead, and `toSnapshot` reads the real id
  back out of `session_id` in the payload. Only `toSnapshot`'s parameter is renamed, because it is
  the one whose returned `sessionId` field would otherwise be a lie.

- [ ] **Step 1: Write the failing suite**

  Create `scripts/verify-statusline.mts`:

  ```ts
  /*
   * Stoke's statusLine wrapper is the only channel that states a session's
   * context window before a token is spent, and the only source of plan limits
   * that works on macOS. Both halves fail silently when they fail: a payload
   * that never lands leaves the meter guessing 200k, and a wrapper that prints
   * something unexpected paints it straight into the user's terminal.
   *
   * So this exercises the REAL generated wrapper under this very node, rather
   * than a re-implementation of it.
   *
   *   node scripts/verify-statusline.mts
   */
  import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { dirname } from 'node:path'
  import {
    readStatusLine,
    statusLineDir,
    statusLinePayloadFile,
    toSnapshot
  } from '../src/main/statusLine.ts'
  import type { StatusLinePayload } from '../src/shared/types.ts'

  let failures = 0

  function check(name: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failures++
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
        (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    )
  }

  /** The payload captured from claude 2.1.221 after one real request. */
  const REAL: StatusLinePayload = {
    session_id: 'a0e0ee79-0000-4000-8000-000000000000',
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    context_window: {
      context_window_size: 1_000_000,
      used_percentage: 28,
      current_usage: { input_tokens: 10, cache_read_input_tokens: 15_645 }
    },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: { used_percentage: 15, resets_at: 1_786_078_200 },
      seven_day: { used_percentage: 3, resets_at: 1_786_647_600 }
    }
  }

  console.log('\nreading the payload')
  const snap = toSnapshot('sess-1', REAL, 1_700_000_000_000)
  check('the window comes straight out of the payload', snap.contextWindowSize, 1_000_000)
  check('so does the percentage', snap.usedPercentage, 28)
  check('and the model', [snap.modelId, snap.modelName], ['claude-opus-5', 'Opus 5'])
  check('resets_at is seconds in, milliseconds out', snap.fiveHour?.resetsAt, 1_786_078_200_000)
  check('the seven-day window converts the same way', snap.sevenDay?.resetsAt, 1_786_647_600_000)
  check(
    'percentages carry over',
    [snap.fiveHour?.percent, snap.sevenDay?.percent],
    [15, 3]
  )
  check('the file mtime is carried as receivedAt', snap.receivedAt, 1_700_000_000_000)

  console.log('\nthe payload names its own session, and that wins')
  /*
   * The files are named after a KEY, which is the session id for every session
   * Stoke mints one for. A `--continue` session's id is picked by the CLI after
   * launch, so its files are named after a launch key instead — and the payload
   * is then the only place the real id appears at all. E Task 11 relies on this.
   */
  check(
    'a payload read under a launch key reports the id the CLI actually chose',
    toSnapshot('launch-key-not-a-session', REAL, 1).sessionId,
    'a0e0ee79-0000-4000-8000-000000000000'
  )
  check(
    'and a payload that names no session falls back to the key it was read under',
    toSnapshot('launch-key-not-a-session', { context_window: { used_percentage: 4 } }, 1).sessionId,
    'launch-key-not-a-session'
  )
  check(
    'a blank session_id is not an id',
    toSnapshot('sess-9', { session_id: '   ' }, 1).sessionId,
    'sess-9'
  )

  console.log('\na CLI that drops fields degrades instead of throwing')
  const bare = toSnapshot('sess-2', {}, 5)
  check('no context window is null, not zero', bare.contextWindowSize, null)
  check('no rate limits is null, not an empty reading', [bare.fiveHour, bare.sevenDay], [null, null])
  check('exceeds_200k_tokens defaults to false', bare.exceeds200k, false)
  check(
    'a window size outside anything plausible is refused, so it cannot hide an overflow',
    toSnapshot('sess-3', { context_window: { context_window_size: 9_000_000_000 } }, 5)
      .contextWindowSize,
    null
  )
  check(
    'a rate limit with a percentage but no reset is still a reading',
    toSnapshot('sess-4', { rate_limits: { five_hour: { used_percentage: 40 } } }, 5).fiveHour,
    { percent: 40, resetsAt: null }
  )

  console.log('\nreading it back off disk')
  const readId = 'stoke-verify-read'
  const readFile = statusLinePayloadFile(readId)
  mkdirSync(dirname(readFile), { recursive: true })
  writeFileSync(readFile, JSON.stringify(REAL), 'utf8')
  const fromDisk = readStatusLine(readId)
  check('a written payload reads back', fromDisk?.contextWindowSize, 1_000_000)
  check(
    'and is stamped with the mtime of the file it came from',
    typeof fromDisk?.receivedAt === 'number' && fromDisk.receivedAt > 0,
    true
  )
  check('an unknown session reads as nothing at all', readStatusLine('stoke-verify-missing'), null)
  writeFileSync(readFile, 'not json', 'utf8')
  check('a truncated or garbled file reads as nothing, never a throw', readStatusLine(readId), null)
  rmSync(readFile, { force: true })
  check('the payload directory lives under the system temp dir', statusLineDir().startsWith(tmpdir()), true)

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exitCode = failures ? 1 : 0
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect it to fail before printing anything, with:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/main/statusLine.ts' imported from /Users/thevinh/dev/personal/stoke/scripts/verify-statusline.mts`

- [ ] **Step 3: Create `src/main/statusLine.ts` with the reader half**

  ```ts
  import { readFileSync, statSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import type {
    StatusLinePayload,
    StatusLineRateLimit,
    StatusLineSnapshot,
    StatusLineWindowReading
  } from '@shared/types'

  /**
   * Stoke's own `statusLine` command, and the payload it captures.
   *
   * The CLI pipes a JSON object to the configured statusLine command on stdin
   * and prints whatever that command writes to stdout. That is the only channel
   * that states the context window before a single token is spent — the
   * transcript never records the tier, and the startup banner stopped saying it
   * in 2.1.221 (see CLAUDE.md gotcha 2). It is also the only source of the
   * plan's rate limits that works on macOS, where the OAuth token is in the
   * Keychain rather than in ~/.claude/.credentials.json.
   *
   * Transport is one file per session under the system temp directory, written
   * temp+rename so a reader never sees half a payload. Not a unix socket: there
   * is no Windows equivalent a shell command can reach as simply. Not an HTTP
   * POST: curl.exe only exists from Windows 10 1803, and a pass-through would
   * have to tee stdin. Not a pure shell wrapper: `more` paginates and re-wraps
   * and `findstr` truncates past ~8KB, and both do it silently.
   *
   * Nothing here writes to the user's own ~/.claude/settings.json. It is read,
   * once, so the line it configures can be passed through.
   */

  const WINDOW_MIN = 1_000
  const WINDOW_MAX = 10_000_000

  export function statusLineDir(): string {
    return join(tmpdir(), 'stoke', 'statusline')
  }

  /**
   * A session id is normally a uuid we minted, but `--session-id` can be handed
   * anything, so it is reduced to something safely joinable before it ever
   * becomes part of a path.
   */
  function key(sessionId: string): string {
    return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  }

  export function statusLinePayloadFile(sessionId: string): string {
    return join(statusLineDir(), `${key(sessionId)}.json`)
  }

  function windowSize(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    const n = Math.round(v)
    // Bounded for the same reason windowFromBanner is: a nonsense value large
    // enough to read 0% forever would hide a real overflow.
    return n >= WINDOW_MIN && n <= WINDOW_MAX ? n : null
  }

  function percent(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    return Math.max(0, Math.min(100, v))
  }

  function text(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  /**
   * `resets_at` is epoch SECONDS in this payload and epoch milliseconds
   * everywhere else in Stoke. This function is the only place the two meet.
   */
  function reading(raw: StatusLineRateLimit | undefined): StatusLineWindowReading | null {
    const pct = percent(raw?.used_percentage)
    if (pct === null) return null
    const secs = raw?.resets_at
    const resetsAt =
      typeof secs === 'number' && Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null
    return { percent: pct, resetsAt }
  }

  /**
   * The wire payload as the rest of the app wants it: flat, camelCase, and in
   * milliseconds, so no component ever meets the snake_case shape or the
   * seconds/ms boundary.
   *
   * `key` is what the payload file is named after, which is the session id for
   * every session Stoke mints an id for. A `--continue` session's id is chosen
   * by the CLI *after* launch, so its files are named after a launch key
   * instead — and `session_id` in the payload is then the only place the real id
   * appears at all. So the payload's own statement wins, and the key is the
   * fallback. (Contracts §0.2 names this parameter `sessionId`; the name is the
   * only thing that changes, and it changes because it is no longer always one.)
   */
  export function toSnapshot(
    key: string,
    payload: StatusLinePayload,
    receivedAt: number
  ): StatusLineSnapshot {
    const cw = payload.context_window
    return {
      sessionId: text(payload.session_id) ?? key,
      contextWindowSize: windowSize(cw?.context_window_size),
      usedPercentage: percent(cw?.used_percentage),
      modelId: text(payload.model?.id),
      modelName: text(payload.model?.display_name),
      exceeds200k: payload.exceeds_200k_tokens === true,
      fiveHour: reading(payload.rate_limits?.five_hour),
      sevenDay: reading(payload.rate_limits?.seven_day),
      receivedAt
    }
  }

  /**
   * The last payload this session's wrapper wrote, or null.
   *
   * Null covers every failure the same way on purpose — no file yet, a CLI too
   * old to run a statusLine command, a half-written file, a temp sweeper that
   * deleted it. Every caller has a fallback, and a throw here would take the
   * context meter down with it.
   */
  export function readStatusLine(sessionId: string): StatusLineSnapshot | null {
    if (!sessionId) return null
    const file = statusLinePayloadFile(sessionId)
    try {
      const raw = readFileSync(file, 'utf8')
      const at = statSync(file).mtimeMs
      const payload = JSON.parse(raw) as unknown
      if (!payload || typeof payload !== 'object') return null
      return toSnapshot(sessionId, payload as StatusLinePayload, at)
    } catch {
      return null
    }
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect every line to read `PASS` and the last line to read `all pass`.

- [ ] **Step 5: Register the suite**

  In `package.json`, add the script immediately after the `"verify:context"` entry:

  ```json
      "verify:statusline": "node scripts/verify-statusline.mts",
  ```

  and **insert** `&& npm run verify:statusline` into the `check` value immediately after
  `npm run verify:context`.

  **Insert. Do not quote or retype the whole `check` line.** Six tasks across four parts add to it
  — contracts Task 3 (`verify:settings`), D Task 34 (`verify:folders`), A Task 55 (`verify:tabs`),
  and E Tasks 6 and 17 (`verify:unicode`, `verify:usage`). A pasted replacement line silently
  deletes whichever of those have already landed, and nothing fails.

  Then run this task's guard — the twelve suites that must be in `check` once this insertion has
  landed, and no name a later task creates:

  ```bash
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','profiles','settings','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"
  ```

  Expected: it prints nothing and exits 0. `unicode` is in that array because E Task 6 registered
  it one task ago; `usage`, `folders` and `tabs` are not, because Tasks 17, 34 and 55 have not run.
  Any name it prints is a suite this insertion has just deleted — put it back.

- [ ] **Step 6: Confirm it runs from npm**

  ```bash
  npm run verify:statusline
  ```

  Expect `all pass` and exit code 0.

- [ ] **Step 7: Commit**

  ```bash
  git add src/main/statusLine.ts scripts/verify-statusline.mts package.json
  git commit -m "$(cat <<'EOF'
  Read the CLI's statusLine payload

  The context window cannot be derived from the model id and claude 2.1.221 no
  longer prints it in the startup banner, so the meter has been reading a 1M
  session against 200k until it crossed over. The statusLine payload states it
  per model from token zero. This is the parser and the on-disk reader; nothing
  produces a payload yet.

  resets_at in that payload is epoch seconds and every other timestamp in Stoke
  is milliseconds, so the conversion happens exactly once, in toSnapshot.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 8: Generate the wrapper the CLI actually runs

The wrapper reads the payload on stdin, stores it, and prints either nothing or the user's own
status line. It is generated rather than shipped as a build asset because it has to be launched
through `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, and that path is only known at runtime
and changes when the app updates.

**The one place in this design where Stoke runs a string as a shell command — bounded here, on
purpose.** Step 3's pass-through does `execFileSync(shell, [win ? '/c' : '-c', cmd], …)`. Read this
before writing it:

- **Whose string it is.** `cmd` is the user's own `statusLine.command` out of their own
  `~/.claude/settings.json`, read by `userStatusLineCommand()` in Task 9 and written by Stoke to
  `<statusLineDir()>/<key>.cmd`. It is not derived from a payload, a project, a model reply or
  anything on the network. Claude Code itself already runs that exact string through that exact
  shell on every status-line render; Stoke re-runs the same string through the same shell so that
  turning suppression **off** restores what the user had. No trust boundary moves.
- **When it runs at all.** Only when the `.cmd` file exists, and Task 9 writes it only when
  `hideStatusLine` is false — the non-default setting, which the user must switch off themselves.
  Task 9 also `rmSync`s the file when suppression is switched back on, so the armed state cannot
  outlive the setting. With the default settings this code path never executes.
- **Non-zero exit, a signal, or a timeout.** `execFileSync` throws for all three, the `catch {}`
  swallows it, and **nothing is printed** — the `process.stdout.write` is inside the `try`, so a
  partial `err.stdout` is deliberately not salvaged. A status line that failed is shown as no
  status line. It must never be shown as its own error text: the CLI paints this stdout straight
  into the TUI, so an exception message would land in the terminal looking like Stoke output.
- **Timeout: 2000 ms, with `killSignal: 'SIGKILL'`.** The CLI re-renders the status line roughly
  every 300 ms (contracts §0.2), so a command that cannot answer inside a couple of frames is not
  a status line and printing it late is worse than not printing it. `SIGKILL` rather than the
  default `SIGTERM` because a shell script that traps or ignores `SIGTERM` would otherwise keep
  the wrapper — and therefore the CLI's render — waiting after the timeout has already fired.
- **Output cap: 262144 bytes (256 KB).** A status line is one or two lines; 256 KB is about 4,000
  lines of 64 characters. Exceeding it kills the child and throws, which by the rule above prints
  nothing. **This deliberately goes the opposite way to CLAUDE.md gotcha 13**, which says to raise
  `maxBuffer` well past the default: that is about `agent.ts` buffering one large model reply we
  asked for, whereas this is somebody else's arbitrary command running every ~300 ms, where a low
  cap is the containment. The other half of gotcha 13 still applies and is already honoured — the
  payload is fed on **stdin** (`input: raw`), never as an argv element, so `cmd.exe /c` has no
  chance to eat an `&`, `|`, `^`, `<` or `>` in it.
- **`stdio: ['pipe', 'pipe', 'ignore']`.** The child's stderr is discarded rather than inherited,
  for the same reason as the failure rule: an inherited stderr writes into the PTY.

**Files:**
- Modify: `src/main/statusLine.ts` (append after `statusLinePayloadFile`)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Test: `node scripts/verify-statusline.mts`

**Interfaces:**
- Consumes: `statusLineDir()`, `statusLinePayloadFile()`, `readStatusLine()` from Task 7.
- Produces (both shapes are pinned by contracts §0.2; do not vary them):
  - `export function writeStatusLineWrapper(): string` — **unconditionally rewrites** `wrapper.mjs`
    plus the platform shim, `chmodSync(shim, 0o755)` on POSIX, never throws, and returns the shim's
    absolute path.
  - `export function statusLineCommand(sessionId: string): string` — pure; the exact string that
    goes into the settings file's `statusLine.command`. **A quoted absolute path and a quoted id and
    nothing else** — no `sh` prefix, no `call` prefix. `run.sh` is chmod 0755 so `sh` is redundant,
    and a `.cmd` invoked as the whole command needs no `call`, which is only required to return
    control inside a batch file. Step 1's `/^"[^"]+" "stoke-verify-junk"$/` assertion forbids any
    prefix.
  - File contract, relied on by Task 9: the wrapper reads its pass-through command from `<statusLineDir()>/<sessionId>.cmd` and writes its payload to `statusLinePayloadFile(sessionId)`.

- [ ] **Step 1: Extend the suite with the wrapper section**

  In `scripts/verify-statusline.mts`, add `execFileSync` and the two extra `node:fs` helpers to the
  imports at the top so those lines read:

  ```ts
  import { execFileSync } from 'node:child_process'
  import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { dirname, join } from 'node:path'
  import {
    readStatusLine,
    statusLineCommand,
    statusLineDir,
    statusLinePayloadFile,
    toSnapshot,
    writeStatusLineWrapper
  } from '../src/main/statusLine.ts'
  ```

  Then insert this section immediately before the two summary lines at the end of the file:

  ```ts
  console.log('\nthe wrapper, run exactly the way the CLI runs it')
  const shim = writeStatusLineWrapper()
  check('the shim exists where the command points at it', existsSync(shim), true)

  const isWin = process.platform === 'win32'
  const shell = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh'
  const shellFlag = isWin ? '/c' : '-c'
  /** A pass-through command that works on both shells and prints one marker. */
  const ECHO_CMD = isWin ? 'echo STOKE-PASSTHROUGH' : "printf 'STOKE-PASSTHROUGH'"

  /** Run the statusLine command the way a shell would, payload on stdin. */
  function runWrapper(sessionId: string, input: string): string {
    return execFileSync(shell, [shellFlag, statusLineCommand(sessionId)], {
      input,
      encoding: 'utf8'
    })
  }

  const suppressed = 'stoke-verify-suppress'
  check('suppressed: the wrapper prints nothing at all', runWrapper(suppressed, JSON.stringify(REAL)), '')
  check(
    'suppressed: the payload landed anyway, byte for byte',
    readFileSync(statusLinePayloadFile(suppressed), 'utf8'),
    JSON.stringify(REAL)
  )
  check(
    'suppressed: and it parses back through the reader',
    readStatusLine(suppressed)?.contextWindowSize,
    1_000_000
  )
  rmSync(statusLinePayloadFile(suppressed), { force: true })

  const through = 'stoke-verify-passthrough'
  writeFileSync(join(statusLineDir(), `${through}.cmd`), ECHO_CMD, 'utf8')
  check(
    'pass-through: the user command owns stdout',
    runWrapper(through, JSON.stringify(REAL)).trim(),
    'STOKE-PASSTHROUGH'
  )
  check(
    'pass-through: the payload is still captured',
    readStatusLine(through)?.contextWindowSize,
    1_000_000
  )
  rmSync(join(statusLineDir(), `${through}.cmd`), { force: true })
  rmSync(statusLinePayloadFile(through), { force: true })

  const junk = 'stoke-verify-junk'
  check('a non-JSON payload prints nothing', runWrapper(junk, 'Error: something went wrong\n'), '')
  check(
    'and is not stored, so the last good reading survives a bad frame',
    readStatusLine(junk),
    null
  )

  check(
    'the command is one quoted path and one quoted id, with no shell metacharacter',
    /^"[^"]+" "stoke-verify-junk"$/.test(statusLineCommand(junk)),
    true
  )

  console.log("\na slow or runaway status line cannot wedge the terminal")
  /*
   * The pass-through is the one place Stoke runs a string as a shell command.
   * The string is the user's own statusLine.command out of their own
   * ~/.claude/settings.json, and the CLI already runs it through this same shell
   * — but the CLI re-renders about three times a second, so a command that
   * hangs, floods or fails has to be contained here rather than reach the PTY.
   *
   * Every case below asserts the SAME outcome: an empty string. A status line
   * that failed is shown as no status line, never as its own error text.
   */
  /** Prints, then hangs — so an empty result proves the timeout, not a dud command. */
  const hangCmd = isWin ? 'ping -n 31 127.0.0.1' : 'printf PARTIAL; sleep 30'
  /** The same command with the wait taken out. The control for the check above. */
  const controlCmd = isWin ? 'ping -n 1 127.0.0.1' : 'printf PARTIAL'

  const control = 'stoke-verify-slow-control'
  writeFileSync(join(statusLineDir(), `${control}.cmd`), controlCmd, 'utf8')
  check(
    'the hang case does print, when it is given no reason to hang',
    runWrapper(control, JSON.stringify(REAL)).length > 0,
    true
  )
  rmSync(join(statusLineDir(), `${control}.cmd`), { force: true })
  rmSync(statusLinePayloadFile(control), { force: true })

  const slow = 'stoke-verify-slow'
  writeFileSync(join(statusLineDir(), `${slow}.cmd`), hangCmd, 'utf8')
  const startedAt = Date.now()
  const slowOut = runWrapper(slow, JSON.stringify(REAL))
  const slowMs = Date.now() - startedAt
  check('a status line that hangs prints nothing at all, partial output included', slowOut, '')
  check('killed at the 2s timeout rather than waited out', slowMs < 10_000, true)
  check(
    'and the payload still landed, because the store happens before the pass-through',
    readStatusLine(slow)?.contextWindowSize,
    1_000_000
  )
  rmSync(join(statusLineDir(), `${slow}.cmd`), { force: true })
  rmSync(statusLinePayloadFile(slow), { force: true })

  const bad = 'stoke-verify-badexit'
  writeFileSync(join(statusLineDir(), `${bad}.cmd`), isWin ? 'exit /b 3' : 'exit 3', 'utf8')
  check('a non-zero exit prints nothing', runWrapper(bad, JSON.stringify(REAL)), '')
  check(
    'and does not stop the payload being stored',
    readStatusLine(bad)?.contextWindowSize,
    1_000_000
  )
  rmSync(join(statusLineDir(), `${bad}.cmd`), { force: true })
  rmSync(statusLinePayloadFile(bad), { force: true })

  /*
   * A quoted absolute path and nothing else — the same command shape as the
   * shim, which the checks above already prove a shell runs correctly on this
   * platform. Written as a file rather than inlined because the Windows form of
   * an infinite loop needs `&`, and cmd.exe eats it (CLAUDE.md gotcha 13).
   *
   * 256 characters per line, so the 256KB cap is reached in about 1000 lines.
   * That is what makes the elapsed-time check below able to tell "maxBuffer
   * killed it" from "the 2s timeout killed it" — without it, both look like an
   * empty string and the cap could have stopped working unnoticed.
   */
  const flood = 'stoke-verify-flood'
  const FLOOD_LINE = 'x'.repeat(256)
  // Named so it cannot be mistaken for `${flood}.cmd`, which is the pass-through
  // file pointing AT it rather than the script itself.
  const floodScript = join(statusLineDir(), isWin ? 'runaway-script.cmd' : 'runaway-script.sh')
  if (isWin) {
    writeFileSync(floodScript, `@echo off\r\n:loop\r\necho ${FLOOD_LINE}\r\ngoto loop\r\n`, 'utf8')
  } else {
    writeFileSync(floodScript, `#!/bin/sh\nwhile :; do echo ${FLOOD_LINE}; done\n`, 'utf8')
    chmodSync(floodScript, 0o755)
  }
  writeFileSync(join(statusLineDir(), `${flood}.cmd`), `"${floodScript}"`, 'utf8')
  const floodStartedAt = Date.now()
  const floodOut = runWrapper(flood, JSON.stringify(REAL))
  const floodMs = Date.now() - floodStartedAt
  check('output past the 256KB cap prints nothing', floodOut, '')
  check(
    'and it was the cap that stopped it, not the timeout: ~1000 lines take well under 2s',
    floodMs < 1_500,
    true
  )
  rmSync(join(statusLineDir(), `${flood}.cmd`), { force: true })
  rmSync(statusLinePayloadFile(flood), { force: true })
  rmSync(floodScript, { force: true })
  ```

  These cases add roughly two to three seconds to the suite, which is the cost of proving the
  bounds exist rather than asserting the constants. The timeout is also the backstop for the flood
  case: if `maxBuffer` ever stopped killing the child, the 2s timeout still ends it — and the
  elapsed check is what turns that from a silent pass into a failure.

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect a link-time failure before any output:
  `SyntaxError: The requested module '../src/main/statusLine.ts' does not provide an export named 'statusLineCommand'`

- [ ] **Step 3: Add the wrapper generator to `src/main/statusLine.ts`**

  Extend the `node:fs` import at the top of the file to
  `import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'`, then
  append this after `statusLinePayloadFile`:

  ```ts
  /**
   * The wrapper, as source. Plain JavaScript rather than TypeScript because it
   * is executed, not built — which is also what lets verify-statusline run the
   * real artefact instead of a copy of its logic.
   *
   * It never parses the payload: the session id arrives on argv, so a malformed
   * frame costs nothing but a skipped write. It never throws, either — a
   * statusLine command that exits non-zero prints its noise into the TUI.
   */
  const WRAPPER_JS = `// Generated by Stoke. See src/main/statusLine.ts; edits here are overwritten.
  import { execFileSync } from 'node:child_process'
  import { readFileSync, renameSync, writeFileSync } from 'node:fs'
  import { basename, dirname, join } from 'node:path'
  import { fileURLToPath } from 'node:url'

  const dir = dirname(fileURLToPath(import.meta.url))
  // basename() and nothing else: the id is already sanitised on the way in, and
  // this makes a hand-edited settings file unable to escape the directory.
  const id = basename(String(process.argv[2] || ''))

  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }

  // Only a JSON object is stored. A CLI that pipes an error message must not be
  // able to overwrite the last good reading with it.
  if (id && raw.trim().startsWith('{')) {
    try {
      const target = join(dir, id + '.json')
      const tmp = target + '.' + process.pid + '.tmp'
      writeFileSync(tmp, raw, 'utf8')
      renameSync(tmp, target)
    } catch {}
  }

  // Pass-through: print the user's own status line, fed the same payload. No
  // file means the line is suppressed, which is the default.
  //
  // This string is the user's own statusLine.command, copied out of their own
  // ~/.claude/settings.json and written here by Stoke. Claude Code already runs
  // that exact string through this exact shell on every render; re-running it is
  // what makes "suppression off" restore what they had. The file only exists
  // when they switched suppression off themselves.
  let cmd = ''
  try {
    cmd = readFileSync(join(dir, id + '.cmd'), 'utf8').trim()
  } catch {}

  if (cmd) {
    try {
      const win = process.platform === 'win32'
      const shell = win ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh'
      process.stdout.write(
        execFileSync(shell, [win ? '/c' : '-c', cmd], {
          // The payload on stdin, never on argv: cmd.exe /c eats & | ^ < >
          // (CLAUDE.md gotcha 13).
          input: raw,
          encoding: 'utf8',
          // The CLI re-renders this line about every 300ms. A command that
          // cannot answer within a couple of frames is not a status line, and
          // printing it late is worse than not printing it. SIGKILL rather than
          // the default SIGTERM, because a script that traps SIGTERM would keep
          // the CLI's render waiting past the timeout it just fired.
          timeout: 2000,
          killSignal: 'SIGKILL',
          // 256KB. A status line is one or two lines; this is ~4000 lines of 64
          // characters. Deliberately the opposite direction to gotcha 13's
          // advice: that is about buffering one large reply we asked an agent
          // for, this is somebody else's command running three times a second,
          // where a low cap is the containment. Over it, node kills the child
          // and throws, and the rule below applies.
          maxBuffer: 262144,
          // stderr discarded, not inherited: an inherited stderr writes into the
          // PTY, which is the one thing this wrapper must never do.
          stdio: ['pipe', 'pipe', 'ignore']
        })
      )
    } catch {}
  }
  // A non-zero exit, a signal, a timeout and a blown maxBuffer all arrive as a
  // throw, and all four print NOTHING. The write is inside the try on purpose,
  // so no partial err.stdout is salvaged either: the CLI paints this stdout
  // straight into the TUI, so an error message here would appear in the
  // terminal looking like Stoke's own output. A status line that failed is
  // shown as no status line.
  `

  function shimName(): string {
    return process.platform === 'win32' ? 'run.cmd' : 'run.sh'
  }

  /**
   * Write the wrapper and the shim that launches it, and return the shim path.
   *
   * The shim exists because the CLI runs a shell command and Stoke has no node
   * of its own: `ELECTRON_RUN_AS_NODE=1 <electron> wrapper.mjs` is the node it
   * has. Both files are rewritten on every call rather than cached, because
   * process.execPath moves when the app updates and a temp sweeper can delete
   * either of them out from under a long-running session — and a shim pointing
   * at a deleted Electron fails as an empty status line, which looks exactly
   * like it working.
   */
  export function writeStatusLineWrapper(): string {
    const dir = statusLineDir()
    mkdirSync(dir, { recursive: true })
    const wrapper = join(dir, 'wrapper.mjs')
    writeFileSync(wrapper, WRAPPER_JS, 'utf8')

    const shim = join(dir, shimName())
    if (process.platform === 'win32') {
      writeFileSync(
        shim,
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${wrapper}" %*\r\n`,
        'utf8'
      )
    } else {
      writeFileSync(
        shim,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${wrapper}" "$@"\n`,
        'utf8'
      )
      // Set explicitly rather than through writeFileSync's mode, which only
      // applies when the file is created and so leaves a rewrite unexecutable.
      chmodSync(shim, 0o755)
    }
    return shim
  }

  /**
   * The command string that goes into the settings file's statusLine key.
   *
   * Pure — it names the shim without writing it, so the JSON can be built and
   * asserted without touching the disk. Two quoted arguments and no shell
   * metacharacter, which is what keeps CLAUDE.md gotcha 13 out of this: the
   * string lives inside a --settings FILE and never on an argv.
   */
  export function statusLineCommand(sessionId: string): string {
    return `"${join(statusLineDir(), shimName())}" "${key(sessionId)}"`
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect `all pass`, after roughly three seconds — the hang case spends its 2s timeout and the
  flood case spends however long 256KB takes to produce. If the pass-through case fails on macOS or
  Linux with a permission error, the `chmodSync` in `writeStatusLineWrapper` is missing; if only
  the flood case fails that way, it is the `chmodSync(floodScript, 0o755)` in the suite.

  Three failures worth reading rather than re-running:
  - `a status line that hangs…` taking 30 seconds means `timeout` is missing from the
    `execFileSync` options.
  - the same check failing with `PARTIAL` in the output means `process.stdout.write` has been moved
    outside the `try`, so a partial `err.stdout` is being salvaged. Put it back inside.
  - `it was the cap that stopped it, not the timeout` failing at ~2000 ms means `maxBuffer` is
    absent or far too large: the output is being buffered until the timeout instead of capped.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/statusLine.ts scripts/verify-statusline.mts
  git commit -m "$(cat <<'EOF'
  Ship the statusLine wrapper Stoke installs per session

  Reads the payload on stdin, stores it temp+rename, and prints either nothing
  or the user's own statusLine command's output. Owning stdout is what makes
  suppressing the in-terminal line the same act as reading the data.

  Generated at runtime rather than shipped as a build asset: it runs through
  process.execPath with ELECTRON_RUN_AS_NODE=1, and that path moves when the app
  updates. Rewritten on every launch for the same reason, plus temp sweepers.

  The pass-through is the one place Stoke runs a string as a shell command. The
  string is the user's own statusLine.command from their own settings.json, and
  Claude Code already runs that exact string through that exact shell — but it
  re-renders about three times a second, so it is bounded here: 2s timeout with
  SIGKILL, a 256KB output cap, stderr discarded, and a failure of any kind
  printing nothing rather than its own error text into the TUI. The cap goes the
  opposite way to gotcha 13 deliberately; that advice is about buffering a reply
  we asked an agent for, not about containing somebody else's command.

  The suite executes the real generated wrapper through a real shell, which is
  only possible because the wrapper is plain JavaScript.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 9: One `--settings` file, carrying both keys

Measured against 2.1.221: **a second `--settings` silently discards the first.** `cli.ts:228-233`
already emits one for `ultracode`, so the statusLine key has to arrive in that same file. This
task builds the file, and the sibling `.cmd` file that carries the pass-through command — the
user's own shell command goes on disk rather than into our command string, so it is never handed
to a second round of shell parsing.

**Files:**
- Modify: `src/main/statusLine.ts` (append)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Test: `node scripts/verify-statusline.mts`

**Interfaces:**
- Consumes: `statusLineDir()`, `statusLinePayloadFile()`, `statusLineCommand()`, `writeStatusLineWrapper()`.
- Produces:
  - `export interface SessionSettingsInput { sessionId: string; ultracode: boolean; hideStatusLine: boolean; passthroughCommand: string }`
  - `export function sessionSettingsJson(input: SessionSettingsInput): Record<string, unknown>` — pure.
  - `export function writeSessionSettingsFile(input: SessionSettingsInput): string | null` — the
    `--settings` path, `<statusLineDir()>/<sessionId>.settings.json` (or `default.settings.json`
    when there is no id), or null when there is nothing to say. One directory for all three of a
    session's files, because the generated wrapper resolves the payload file and the shim from its
    own `dirname(fileURLToPath(import.meta.url))` and `clearSessionFiles` deletes all three
    siblings out of `statusLineDir()`. Contracts §0.2 pins this; it is **not**
    `<tmpdir>/stoke/settings/<sessionId>.json`.
  - The empty-object rule, also pinned by §0.2: `sessionSettingsJson` reads `ultracode` and
    `sessionId` and **not** `hideStatusLine` — that key selects what goes in the pass-through file,
    not whether the `statusLine` key exists, because the payload is how Stoke reads the context
    window at all. A session with an id always gets the key.
  - **`SessionSettingsInput.sessionId` is the statusLine *key*.** The field keeps §0.2's name, but
    what a caller must put in it is whatever string this session's three files are named after. For
    every session Stoke mints an id for the two are the same string. For a `--continue` — whose id
    the CLI chooses after launch, so `pty.ts:137-138` leaves `opts.sessionId` empty — E Task 11
    passes a **launch key** instead. That is the whole reason a `--continue` session gets a wrapper
    at all, and therefore the reason "Hide Claude's status line in Stoke" applies to it, as design
    §4.E.3 requires. The `if (input.sessionId)` guard below stays as the structural floor for a
    caller that hands over nothing; it is no longer the `--continue` path.
  - `export function clearSessionFiles(sessionId: string): void`
  - `export function userStatusLineCommand(settingsFile?: string): string`

- [ ] **Step 1: Extend the suite with the settings-file section**

  In `scripts/verify-statusline.mts`, extend the import from `../src/main/statusLine.ts` to also
  pull in `clearSessionFiles`, `sessionSettingsJson`, `userStatusLineCommand` and
  `writeSessionSettingsFile`, then insert this section immediately before the two summary lines:

  ```ts
  console.log('\none settings file, never two')
  const both = 'stoke-verify-settings'
  const json = sessionSettingsJson({
    sessionId: both,
    ultracode: true,
    hideStatusLine: true,
    passthroughCommand: 'bash ~/.claude/statusline-command.sh'
  })
  check('ultracode and statusLine ride in the same object', Object.keys(json).sort(), [
    'statusLine',
    'ultracode'
  ])
  check('the statusLine entry is a command', (json.statusLine as { type: string }).type, 'command')
  check(
    'and it is the command the wrapper answers to',
    (json.statusLine as { command: string }).command,
    statusLineCommand(both)
  )
  check(
    'no ultracode key when it was not asked for',
    Object.keys(
      sessionSettingsJson({
        sessionId: both,
        ultracode: false,
        hideStatusLine: true,
        passthroughCommand: ''
      })
    ),
    ['statusLine']
  )
  check(
    'an empty key gets no statusLine entry, because nothing would name the files',
    Object.keys(
      sessionSettingsJson({
        sessionId: '',
        ultracode: true,
        hideStatusLine: true,
        passthroughCommand: ''
      })
    ),
    ['ultracode']
  )
  /*
   * ...and that case is unreachable for a session Stoke spawns locally. A
   * `--continue` has no session id at launch, so E Task 11 hands over a launch
   * key, which is an ordinary key here. It gets a wrapper like anything else,
   * which is what makes suppression and pass-through apply to it.
   */
  check(
    'a --continue session is keyed on its launch key, and gets the wrapper like any other',
    (
      sessionSettingsJson({
        sessionId: 'launch-6f1c2b',
        ultracode: false,
        hideStatusLine: true,
        passthroughCommand: ''
      }).statusLine as { command: string }
    ).command,
    statusLineCommand('launch-6f1c2b')
  )
  check(
    'and nothing at all when there is nothing to say',
    writeSessionSettingsFile({
      sessionId: '',
      ultracode: false,
      hideStatusLine: true,
      passthroughCommand: ''
    }),
    null
  )

  const settingsFile = writeSessionSettingsFile({
    sessionId: both,
    ultracode: false,
    hideStatusLine: false,
    passthroughCommand: ECHO_CMD
  })
  check('the file is written', typeof settingsFile === 'string' && existsSync(settingsFile), true)
  check(
    'and parses as the object we built',
    Object.keys(JSON.parse(readFileSync(settingsFile as string, 'utf8'))),
    ['statusLine']
  )
  check(
    'the pass-through command is a file beside the payload, never part of the command string',
    readFileSync(join(statusLineDir(), `${both}.cmd`), 'utf8'),
    ECHO_CMD
  )
  check(
    'and the wrapper honours it end to end',
    runWrapper(both, JSON.stringify(REAL)).trim(),
    'STOKE-PASSTHROUGH'
  )

  writeSessionSettingsFile({
    sessionId: both,
    ultracode: false,
    hideStatusLine: true,
    passthroughCommand: ECHO_CMD
  })
  check(
    'switching suppression back on removes the pass-through file rather than leaving it armed',
    existsSync(join(statusLineDir(), `${both}.cmd`)),
    false
  )
  clearSessionFiles(both)
  check(
    'clearSessionFiles leaves nothing behind',
    [existsSync(statusLinePayloadFile(both)), existsSync(settingsFile as string)],
    [false, false]
  )

  console.log("\nthe user's own statusLine, read and never written")
  const userFile = join(statusLineDir(), 'stoke-verify-user-settings.json')
  writeFileSync(
    userFile,
    JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' } }),
    'utf8'
  )
  check('a command statusLine is what gets passed through', userStatusLineCommand(userFile), 'bash ~/.claude/statusline-command.sh')
  writeFileSync(userFile, JSON.stringify({ statusLine: { type: 'static', text: 'hi' } }), 'utf8')
  check('anything that is not a command has nothing to pass through', userStatusLineCommand(userFile), '')
  check('and a missing file is simply empty', userStatusLineCommand(join(statusLineDir(), 'nope.json')), '')
  rmSync(userFile, { force: true })
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect:
  `SyntaxError: The requested module '../src/main/statusLine.ts' does not provide an export named 'sessionSettingsJson'`

- [ ] **Step 3: Add the settings-file writer to `src/main/statusLine.ts`**

  Extend the `node:fs` import to
  `import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'`
  and the `node:os` import to `import { homedir, tmpdir } from 'node:os'`, then append:

  ```ts
  /** Where the pass-through command lives, when there is one. */
  function passthroughFile(sessionId: string): string {
    return join(statusLineDir(), `${key(sessionId)}.cmd`)
  }

  function settingsFileFor(sessionId: string): string {
    return join(statusLineDir(), `${key(sessionId) || 'default'}.settings.json`)
  }

  export interface SessionSettingsInput {
    /**
     * The statusLine KEY this session's three files are named after — not
     * necessarily a session id. It is the session id for everything Stoke mints
     * an id for, and a launch key for a `--continue`, whose id the CLI chooses
     * after launch. See pty.ts, which is the only caller.
     */
    sessionId: string
    ultracode: boolean
    hideStatusLine: boolean
    /** The user's own statusLine command, or '' when there is nothing to echo. */
    passthroughCommand: string
  }

  /**
   * Everything Stoke puts in one session's `--settings` file.
   *
   * One file, because a second `--settings` silently discards the first —
   * measured against 2.1.221, and the reason this function exists at all rather
   * than each feature appending its own flag.
   *
   * Every session with a key gets the statusLine entry, including a `--continue`
   * — pty.ts gives that one a launch key precisely so it does. Without it, the
   * setting "Hide Claude's status line in Stoke" would silently not apply to the
   * one launch path whose id we do not know in advance.
   *
   * No key at all still means no statusLine entry: there would be nothing to
   * name the payload, the pass-through file or the settings file after.
   */
  export function sessionSettingsJson(input: SessionSettingsInput): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (input.ultracode) out.ultracode = true
    if (input.sessionId) {
      out.statusLine = { type: 'command', command: statusLineCommand(input.sessionId) }
    }
    return out
  }

  /**
   * Write that file and the pass-through command beside it, and return the path
   * for `--settings`. Null means there is nothing to pass.
   *
   * A failure returns null rather than throwing: buildArgs falls back to the
   * ultracode-only file, which does throw if it cannot be written, so the one
   * case that must stay loud — a session that promised ultracode and did not
   * get it — still is.
   */
  export function writeSessionSettingsFile(input: SessionSettingsInput): string | null {
    const json = sessionSettingsJson(input)
    if (!Object.keys(json).length) return null
    try {
      mkdirSync(statusLineDir(), { recursive: true })
      if (json.statusLine) writeStatusLineWrapper()
      if (input.sessionId) {
        const cmdFile = passthroughFile(input.sessionId)
        const passthrough = input.hideStatusLine ? '' : input.passthroughCommand.trim()
        // Removed rather than left in place when suppression is on: a stale
        // file would keep printing a line the user has just turned off.
        if (passthrough) writeFileSync(cmdFile, passthrough, 'utf8')
        else rmSync(cmdFile, { force: true })
      }
      const file = settingsFileFor(input.sessionId)
      writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
      return file
    } catch (err) {
      console.error('[stoke] could not write the session settings file', err)
      return null
    }
  }

  /** Remove everything written for one session. Called when its PTY exits. */
  export function clearSessionFiles(sessionId: string): void {
    if (!sessionId) return
    for (const f of [
      statusLinePayloadFile(sessionId),
      passthroughFile(sessionId),
      settingsFileFor(sessionId)
    ]) {
      try {
        rmSync(f, { force: true })
      } catch {
        /* a temp sweeper got there first */
      }
    }
  }

  /**
   * The user's own statusLine command, so it can be passed through when the
   * line is not suppressed. Read at launch rather than cached, because the file
   * is theirs and they can change it at any time.
   *
   * Read-only, always: Stoke never writes to Claude Code's own files.
   */
  export function userStatusLineCommand(
    settingsFile: string = join(homedir(), '.claude', 'settings.json')
  ): string {
    try {
      const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        statusLine?: { type?: string; command?: string }
      }
      const sl = raw?.statusLine
      if (!sl || sl.type !== 'command') return ''
      return typeof sl.command === 'string' ? sl.command.trim() : ''
    } catch {
      return ''
    }
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect `all pass`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/statusLine.ts scripts/verify-statusline.mts
  git commit -m "$(cat <<'EOF'
  Build one --settings file carrying both session keys

  A second --settings silently discards the first, measured against 2.1.221, so
  the statusLine key has to arrive in the same file cli.ts already writes for
  ultracode. Appending a second flag would have switched ultracode off with no
  warning anywhere.

  The pass-through command goes in a sibling file rather than into our command
  string: it is the user's own shell command and embedding it would hand it to a
  second round of shell parsing.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 10: `buildArgs` takes the settings file

`cli.ts:228-233` currently hardcodes `ultracodeSettingsFile()`. It becomes a fallback, so any
caller that passes no file still gets ultracode and the loud failure that goes with it.

**Files:**
- Modify: `src/main/cli.ts:189` (signature), `src/main/cli.ts:228-233` (the ultracode block)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Test: `node scripts/verify-statusline.mts`

**Interfaces:**
- Consumes: `LaunchOptions` (type-only, `@shared/types`); `ultracodeSettingsFile(): string` (existing, `src/main/cli.ts:161`).
- Produces: `export function buildArgs(opts: LaunchOptions, settingsFile: string | null = null): string[]` — replaces the one-argument form. The only existing caller is `src/main/pty.ts:140`, updated in Task 11.

- [ ] **Step 1: Extend the suite with the argv section**

  Add these imports to the top of `scripts/verify-statusline.mts`:

  ```ts
  import { buildArgs } from '../src/main/cli.ts'
  import type { LaunchOptions, StatusLinePayload } from '../src/shared/types.ts'
  ```

  (replacing the existing `StatusLinePayload` type import line), then insert before the summary
  lines:

  ```ts
  console.log('\nbuildArgs emits exactly one --settings')
  const base: LaunchOptions = {
    cwd: '/tmp',
    permissionMode: 'default',
    model: '',
    effort: 'default',
    cols: 80,
    rows: 24
  }

  const argsBoth = buildArgs({ ...base, ultracode: true, sessionId: 'sid' }, '/tmp/sid.settings.json')
  check('one --settings, not two', argsBoth.filter((a) => a === '--settings').length, 1)
  check(
    'pointing at the file it was handed',
    argsBoth[argsBoth.indexOf('--settings') + 1],
    '/tmp/sid.settings.json'
  )
  check('ultracode still pins the effort flag', argsBoth[argsBoth.indexOf('--effort') + 1], 'xhigh')

  const argsPlain = buildArgs({ ...base, effort: 'high', sessionId: 'sid' }, '/tmp/sid.settings.json')
  check(
    'a session with no ultracode still gets the file, because it carries the statusLine key',
    argsPlain.filter((a) => a === '--settings').length,
    1
  )
  check('and keeps the effort it asked for', argsPlain[argsPlain.indexOf('--effort') + 1], 'high')

  check('no file, no flag', buildArgs({ ...base, sessionId: 'sid' }, null).includes('--settings'), false)

  check(
    'ultracode with no file falls back to its own, so a one-argument caller cannot lose it',
    buildArgs({ ...base, ultracode: true, sessionId: 'sid' }).filter((a) => a === '--settings').length,
    1
  )

  const argsUser = buildArgs(
    { ...base, sessionId: 'sid', extraArgs: ['--settings', '/my/own.json'] },
    '/tmp/sid.settings.json'
  )
  check(
    "a hand-written --settings still comes last, so it still wins",
    argsUser.slice(argsUser.lastIndexOf('--settings')),
    ['--settings', '/my/own.json']
  )
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect two failures in the new section:
  `FAIL  pointing at the file it was handed` with `got undefined, want "/tmp/sid.settings.json"`,
  and `FAIL  a session with no ultracode still gets the file...` with `got 0, want 1` — because
  today `buildArgs` ignores a second argument entirely.

- [ ] **Step 3: Change `buildArgs`**

  In `src/main/cli.ts`, replace the signature on line 189 and the block at lines 228-233.

  The signature becomes:

  ```ts
  /**
   * @param settingsFile the one `--settings` file for this session, holding both
   *   the ultracode key and the statusLine wrapper. Null means the session needs
   *   none — but note the ultracode fallback below, which keeps a caller that
   *   passes nothing working exactly as it did.
   */
  export function buildArgs(opts: LaunchOptions, settingsFile: string | null = null): string[] {
  ```

  and the ultracode block becomes:

  ```ts
    if (opts.ultracode) {
      args.push('--effort', 'xhigh')
    } else if (opts.effort && opts.effort !== 'default') {
      args.push('--effort', opts.effort)
    }

    // Exactly one --settings, ever. A second silently discards the first
    // (measured against 2.1.221), so ultracode and the statusLine wrapper have
    // to share a file rather than each append a flag — which is why this is one
    // push and not two. The fallback keeps a caller that hands over no file
    // getting its ultracode key, including the deliberate throw when that file
    // cannot be written.
    //
    // It sits before extraArgs so a hand-written `--settings` there still wins —
    // a repeated option is last-wins.
    const file = settingsFile ?? (opts.ultracode ? ultracodeSettingsFile() : null)
    if (file) args.push('--settings', file)
  ```

  Leave the long measurement comment above it (lines 210-227) in place; it still explains why
  ultracode pins `--effort xhigh`.

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts && npm run typecheck
  ```

  Expect `all pass` from the suite and no output from `typecheck`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/cli.ts scripts/verify-statusline.mts
  git commit -m "$(cat <<'EOF'
  Let buildArgs be handed the session's settings file

  It hardcoded ultracodeSettingsFile(), so the statusLine key had nowhere to go
  but a second --settings — which silently discards the first and would have
  turned ultracode off with no warning anywhere.

  The old path stays as a fallback so a caller passing no file behaves exactly as
  before, including the deliberate throw when the file cannot be written.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 11: Install the wrapper on every session Stoke starts

The session id is minted inside `PtyManager.start`, so the settings file has to be built there —
but `pty.ts` must not read settings directly (it takes `claudePath` as an argument for the same
reason). It takes a factory instead, in the style `ContextWatcher` already uses for its resolvers.

**The `--continue` case, decided here rather than left to fail quietly.** `pty.ts:137-138` reads
`opts.resume || opts.continueLast ? (opts.sessionId ?? '') : (opts.sessionId ?? randomUUID())`, so
a `--continue` session — the launcher's "Continue last session" button, `App.tsx:804-812` — starts
with an **empty** `sessionId`: the CLI picks the id, after launch. A `--resume` is unaffected, it
always arrives with the id it is resuming.

Keying the wrapper on the session id would therefore give a `--continue` session no `--settings`
at all, and so:

- it would keep printing the user's own status line with "Hide Claude's status line in Stoke" on,
  which contradicts design §4.E.3 — the setting is about the sessions Stoke spawns, and this is
  one; and
- no payload would be written for it at all, so it could not contribute the account-wide rate
  limits the usage chip reads either.

So **the files are keyed on a launch key, not on the session id**:
`statusKey = opts.host ? '' : sessionId || randomUUID()`. For every other local session the key and
the id are the same string and nothing changes; a remote session gets no key because it gets no
wrapper. The payload states `session_id` itself, so `toSnapshot` (Task 7) reads the CLI's real id
back out of it, and a snapshot found under a launch key still identifies its session honestly.

**What this does not deliver, and why — read this rather than expecting a meter.** A `--continue`
session still gets **no per-session context ring**. The chain needs the real id in the *renderer*:
`ContextWatcher.watch()` no-ops on an empty id (`context.ts:99`), the renderer binds a reading with
`contexts[tab.sessionId]` (`App.tsx:134`, `869`), and that tab's `sessionId` is the `''` that
`startSession` returned. Main can learn the true id from the payload, but handing it to the
renderer afterwards needs a main→renderer channel for a *late* session id, and there is no such
channel: `src/shared/ipc.ts` gains exactly seven names in contracts Task 2 and none of them is one.
Inventing an eighth here would put an unreviewed channel, a `preload` member and an `api.ts` member
into a task about installing a wrapper. It is also **not a regression** — a `--continue` session has
never had a context meter, for this same reason. It is recorded in `Notes nobody should
rediscover` as the follow-up it is. What this task *does* deliver for that session is the wrapper
(so suppression and pass-through work) and its payload on disk (so Task 13 can pick the rate limits
up).

**Files:**
- Modify: `src/main/pty.ts:5` (import), `src/main/pty.ts:16-38` (the `Session` interface), `src/main/pty.ts:112-116` (signature), `src/main/pty.ts:137-140` (the id, the launch key and the argv), `src/main/pty.ts:149-155` (comment), `src/main/pty.ts:182-195` (the `Session` literal), `src/main/pty.ts:220-225` (exit cleanup), `src/main/pty.ts:277-279` (beside `sessionIdFor`)
- Modify: `src/main/index.ts:27` (import), `src/main/index.ts:136-144` (`launchSession`)
- Test: launch the app and read the files it wrote (below), including one `--continue` session

**Interfaces:**
- Consumes: `writeSessionSettingsFile(input: SessionSettingsInput): string | null` and `userStatusLineCommand(settingsFile?: string): string` from Task 9; `buildArgs(opts, settingsFile)` from Task 10; `clearSessionFiles(sessionId: string): void` from Task 9; `Settings.hideStatusLine: boolean` from the contracts tasks; `randomUUID` from `node:crypto` (already imported by `pty.ts:1`).
- Produces:
  - `PtyManager.start(opts: LaunchOptions, claudePathOverride: string | null, mcpConfigPath?: string | null, sessionSettings?: (statusKey: string) => string | null): Promise<StartResult>` — a fourth optional parameter, defaulting to `() => null`. Its argument is the **launch key**, not necessarily a session id.
  - `Session` gains `statusKey: string`, empty for a remote session (internal to `pty.ts`; `SessionInfo` is unchanged, because the remote UI has no use for it).
  - `PtyManager.statusKeys(): string[]` — the launch key of every live local session, skipping the remote ones. Task 13 is its only caller.

- [ ] **Step 1: Take the factory in `pty.ts`**

  Change the import on line 5 and add one below it:

  ```ts
  import { buildArgs, buildEnvPath, findClaude, spawnSpec } from './cli.ts'
  import { clearSessionFiles } from './statusLine.ts'
  ```

  Change the `start` signature (lines 112-116) to:

  ```ts
    /**
     * @param sessionSettings builds this session's `--settings` file, given its
     *   statusLine key — which is minted here, so it cannot be passed in
     *   ready-made. Injected rather than read from the store so this module
     *   stays free of electron, like every other dependency it takes.
     */
    async start(
      opts: LaunchOptions,
      claudePathOverride: string | null,
      mcpConfigPath?: string | null,
      sessionSettings: (statusKey: string) => string | null = () => null
    ): Promise<StartResult> {
  ```

  Add the launch key immediately after the `const sessionId = …` assignment (lines 137-138, whose
  comment above it stays as it is):

  ```ts
      /*
       * The statusLine files are named after THIS, not after the session id.
       *
       * A --continue session has no id here: the CLI chooses it after launch, so
       * `sessionId` above is ''. Keying the wrapper on the id would leave that
       * one launch path with no --settings at all, which means it keeps printing
       * the user's own status line with suppression on and never writes a
       * payload — and both failures look exactly like the feature working.
       *
       * For every local session that does have an id, this IS that id, byte for
       * byte. The payload carries `session_id` itself, so `toSnapshot` can name
       * the real session even when the file is named after a launch key.
       *
       * Empty for a remote session, which gets no wrapper at all: it runs ssh,
       * and its `claude` and its settings live on the far machine. That is what
       * makes `statusKeys()` below able to mean "has a payload to read".
       */
      const statusKey = opts.host ? '' : sessionId || randomUUID()
  ```

  Replace line 140 with:

  ```ts
      // One --settings, holding both the ultracode key and the statusLine
      // wrapper: a second silently discards the first. Local only — a remote
      // session runs ssh, and this file is on this disk.
      const settingsFile = opts.host ? null : sessionSettings(statusKey)
      const args = opts.host
        ? buildSshArgs(opts.host)
        : buildArgs({ ...opts, sessionId }, settingsFile)
  ```

  Note `buildArgs` still receives `sessionId`, not `statusKey`: the launch key must never reach the
  CLI's argv. Handing a `--continue` a `--session-id` would change what it continues, and handing a
  fabricated id to `--resume` would fail the launch outright.

- [ ] **Step 2: Keep the launch key on the session**

  Still in `src/main/pty.ts`, add to the `interface Session` block (line 16) immediately after its
  `sessionId: string`, which is line 18. `grep -n "^  sessionId: string" src/main/pty.ts` prints
  **three** hits — line 11 is `StartResult`, line 18 is `Session`, line 43 is `SessionInfo`. Only
  the middle one is the one to change; the other two are the shapes that cross a process boundary
  and a launch key must not appear in either:

  ```ts
    /**
     * What this session's statusLine files are named after, or '' when it has
     * none.
     *
     * The same string as `sessionId` for every local session Stoke mints an id
     * for, a launch uuid for a `--continue` — whose id the CLI chooses after we
     * spawn it — and empty for a remote session, which gets no wrapper because
     * its `claude` runs on the far machine. Kept because the exit handler has to
     * delete the files it names, and `statusKeys()` has to list them.
     */
    statusKey: string
  ```

  and add the field to the `Session` object literal (lines 182-195), immediately after
  `sessionId,`:

  ```ts
        statusKey,
  ```

  `SessionInfo` is deliberately not touched: it is the remote UI's summary, and a phone has no use
  for a temp-file name.

- [ ] **Step 3: Clear the session's files when it exits**

  In `src/main/pty.ts`, replace the `proc.onExit` handler (lines 220-225) with:

  ```ts
      proc.onExit(({ exitCode, signal }) => {
        session.exited = true
        this.sessions.delete(ptyId)
        // The payload, the pass-through command and the settings file are all
        // per-session temp files, named after the launch key rather than the
        // session id — a --continue has no id here. Nothing reads them once the
        // process is gone, and leaving them would accumulate one set per session
        // ever started.
        clearSessionFiles(session.statusKey)
        this.onExit(ptyId, exitCode, signal)
        for (const fn of this.exitSubscribers) fn(ptyId, exitCode)
      })
  ```

  and update the comment block at lines 149-155 so its first sentence reads:

  ```ts
      // Ultracode and the statusLine wrapper both need nothing here: buildArgs
      // has already folded them into the single `--settings <file>` above. Do
      // not be tempted to write `/effort ultracode` into the pty after start
  ```

  (the rest of that comment is unchanged).

- [ ] **Step 4: Let main list the live launch keys**

  Still in `src/main/pty.ts`, add immediately after `sessionIdFor` (lines 277-279):

  ```ts
    /**
     * The statusLine key of every live local session.
     *
     * Exists for one caller: E Task 13's `statusline:last` handler, which has to
     * find the payload of a session whose id it does not know. That is the
     * `--continue` case — the CLI names the session, we name the file, and only
     * the payload joins the two. A session with no key (an SSH session, which
     * gets no wrapper because its `claude` runs on the far machine) is skipped.
     */
    statusKeys(): string[] {
      const keys: string[] = []
      for (const s of this.sessions.values()) if (s.statusKey) keys.push(s.statusKey)
      return keys
    }
  ```

  A method rather than exposing `sessions`: everything else about a session already reaches main
  through one of these narrow accessors, and a leaked map would let a caller hold a `node-pty`
  handle.

- [ ] **Step 5: Build the file in `index.ts`**

  Add the import after line 27 (`import { getSettings, setSettings } from './store.ts'`):

  ```ts
  import { userStatusLineCommand, writeSessionSettingsFile } from './statusLine.ts'
  ```

  and replace `launchSession` (lines 136-144) with:

  ```ts
  async function launchSession(opts: LaunchOptions): Promise<StartResult> {
    if (!ptys) throw new Error('Window is not ready')
    const settings = getSettings()
    // `statusKey` is what the files are named after, not necessarily a session
    // id: a --continue session has no id until the CLI picks one. See pty.ts.
    const result = await ptys.start(opts, settings.claudePath, mcpConfigPath, (statusKey) =>
      writeSessionSettingsFile({
        sessionId: statusKey,
        ultracode: opts.ultracode === true,
        hideStatusLine: settings.hideStatusLine,
        // Read now rather than cached: it is the user's own settings.json and
        // they can edit it between one session and the next.
        passthroughCommand: settings.hideStatusLine ? '' : userStatusLineCommand()
      })
    )
    // Empty for a --continue, and `watch('')` is a no-op by design (context.ts:99).
    // Such a session has never had a context meter; see this task's header for
    // why closing that gap belongs to a later change and not to this one.
    watcher?.watch(result.sessionId)
    const cwd = ptys.list().find((s) => s.sessionId === result.sessionId)?.cwd
    if (cwd) sessionCwds.set(result.sessionId, cwd)
    if (opts.host) sessionHosts.set(result.sessionId, opts.host)
    return result
  }
  ```

- [ ] **Step 6: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expect no output.

- [ ] **Step 7: Prove it against a real session**

  ```bash
  rm -rf "${TMPDIR:-/tmp}/stoke/statusline"
  npm run dev
  ```

  Start any session in the app, type `hello` and press Enter, then in a second terminal:

  ```bash
  ls "${TMPDIR:-/tmp}/stoke/statusline"
  ```

  Expect four entries: `run.sh`, `wrapper.mjs`, `<uuid>.settings.json` and `<uuid>.json`. Then:

  ```bash
  cat "${TMPDIR:-/tmp}/stoke/statusline/"*.settings.json
  node -e "const fs=require('fs'),os=require('os'),p=require('path');const d=p.join(os.tmpdir(),'stoke','statusline');const f=fs.readdirSync(d).find(n=>/^[0-9a-f-]{36}\.json$/.test(n));console.log(JSON.parse(fs.readFileSync(p.join(d,f),'utf8')).context_window)"
  ```

  Expect the settings file to read
  `{ "statusLine": { "type": "command", "command": "\"…/run.sh\" \"<uuid>\"" } }`, and the second
  command to print an object containing `context_window_size` — `1000000` on an Opus 5 session.
  Expect **no status line at the bottom of the terminal in Stoke**, where one used to be.

- [ ] **Step 8: Prove the `--continue` case, which is the whole point of the launch key**

  Close that tab. Then in the launcher press **Continue last session** on the same project, type
  `hello` and press Enter, and in the second terminal:

  ```bash
  node -e "const fs=require('fs'),os=require('os'),p=require('path');const d=p.join(os.tmpdir(),'stoke','statusline');const f=fs.readdirSync(d).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n));console.log(f.length, f.map(n=>({file:n.replace('.json',''), said:JSON.parse(fs.readFileSync(p.join(d,n),'utf8')).session_id})))"
  ```

  Expect `1` payload, and its `file` (the launch key Stoke minted) to be **different** from its
  `said` (the session id the CLI chose). That difference is the case this task exists for: before
  the launch key there was no payload here at all. Confirm too that **no status line is drawn at
  the bottom of this terminal**, which is the design §4.E.3 behaviour that was silently missing.

  The tab's context ring stays empty for this session, and that is expected and stated in this
  task's header — the ring needs the CLI-chosen id in the renderer, and there is no channel that
  carries a late session id.

- [ ] **Step 9: Prove the cleanup**

  Close both tabs in Stoke, then:

  ```bash
  ls "${TMPDIR:-/tmp}/stoke/statusline"
  ```

  Expect only `run.sh` and `wrapper.mjs` to remain. A leftover `<launch-key>.json` means the exit
  handler is still calling `clearSessionFiles(sessionId)` instead of `session.statusKey`, which
  would leak one payload per `--continue` session for the life of the temp directory.

- [ ] **Step 10: Commit**

  ```bash
  git add src/main/pty.ts src/main/index.ts
  git commit -m "$(cat <<'EOF'
  Install Stoke's statusLine wrapper on every session it starts

  This is what makes the payload exist at all: the CLI only runs a statusLine
  command if one is configured, and the user's own settings.json is never
  touched, so it has to arrive per session through --settings.

  pty.ts takes a factory rather than reading the store, because the session id is
  minted inside start() and because pty.ts stays free of electron. The per-session
  temp files are removed when the process exits, so they cannot accumulate one set
  per session ever started.

  The files are named after a launch key, not the session id. A --continue
  session has no id at launch — the CLI picks it — so keying on the id would have
  left the one launch path we cannot predict with no --settings at all: still
  printing the user's status line with suppression on, and never writing a
  payload. Both look exactly like the feature working. The payload states
  session_id itself, so toSnapshot still names the real session.

  A --continue session still gets no context ring: that needs the CLI-chosen id
  in the renderer, and no IPC channel carries a late session id. It never had one
  either, so nothing regresses; it is recorded as a follow-up rather than smuggled
  into this change.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 12: Point the context meter at the payload

`contextLimitFor` is unchanged — it already takes a stated limit that wins over its inference. All
that changes is where index.ts gets that statement from: the payload first, then the banner, then
nothing. The banner path and the observed-usage inference both stay, for CLI versions that emit no
payload.

The precedence rule itself becomes a named function rather than a lambda buried in `index.ts`,
because a lambda in a constructor call is the one shape no suite in this repo can reach — and this
particular rule is the whole point of the workstream.

**Files:**
- Modify: `src/main/statusLine.ts` (append `windowFor`)
- Modify: `src/main/index.ts` (the `./statusLine.ts` import, and `src/main/index.ts:382-392`, the watcher's window resolver)
- Modify: `src/main/sessionFile.ts:175-191` (the now-stale doc comment on the window rules)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Modify: `scripts/verify-context.mts:7-13` (imports); two insertions, after the
  `'unsuffixed id above 200k -> 1M'` check at `:104-108` and after the `}` at `:147` that closes the
  `if (snapshot) {` block (new payload cases)
- Test: `node scripts/verify-statusline.mts && node scripts/verify-context.mts`

**Interfaces:**
- Consumes: `readStatusLine(sessionId: string): StatusLineSnapshot | null` and `statusLinePayloadFile()` from Task 7; `PtyManager.bannerWindowFor(sessionId: string): number | null` (existing, `src/main/pty.ts:270`); `contextLimitFor(model, observedTokens, bannerLimit)` (existing, `src/main/sessionFile.ts:302`); `ContextWatcher` (existing, `src/main/context.ts:27`).
- Produces: `export function windowFor(sessionId: string, bannerWindow: number | null): number | null` in `src/main/statusLine.ts` — the payload first, the banner second, null third. `ContextWatcher`'s second constructor argument becomes `(sessionId) => windowFor(sessionId, ptys?.bannerWindowFor(sessionId) ?? null)`.

- [ ] **Step 1: Pin the precedence rule in `scripts/verify-statusline.mts`**

  Add `windowFor` to the import from `../src/main/statusLine.ts`, then insert immediately above
  that file's closing pair — E Task 7 created it with the `verify-worklog-gate.mts` shape, so the
  two lines are `` console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`) `` and
  `process.exitCode = failures ? 1 : 0`:

  ```ts
  console.log('\nwhich source states the context window')
  const winId = 'stoke-verify-window'
  check(
    'no payload and no banner is no statement at all, so the caller infers',
    windowFor(winId, null),
    null
  )
  check('no payload falls back to the banner', windowFor(winId, 1_000_000), 1_000_000)
  mkdirSync(statusLineDir(), { recursive: true })
  writeFileSync(
    statusLinePayloadFile(winId),
    JSON.stringify({ context_window: { context_window_size: 1_000_000 } }),
    'utf8'
  )
  check('a payload states it', windowFor(winId, null), 1_000_000)
  check(
    'and beats the banner, which is the older and now usually absent source',
    windowFor(winId, 200_000),
    1_000_000
  )
  writeFileSync(
    statusLinePayloadFile(winId),
    JSON.stringify({ context_window: { used_percentage: 4 } }),
    'utf8'
  )
  check(
    'a payload that omits the size falls through rather than reporting zero',
    windowFor(winId, 200_000),
    200_000
  )
  rmSync(statusLinePayloadFile(winId), { force: true })
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect:
  `SyntaxError: The requested module '../src/main/statusLine.ts' does not provide an export named 'windowFor'`

- [ ] **Step 3: Add `windowFor` to `src/main/statusLine.ts`**

  Append:

  ```ts
  /**
   * The context window for a session, in order of authority.
   *
   * 1. The statusLine payload. A direct statement, per model, correct from token
   *    zero, and the only one that still exists — claude 2.1.221 dropped
   *    "(1M context)" from its startup banner.
   * 2. The banner, for a CLI old enough to still print it.
   * 3. Null, and `contextLimitFor` falls back to inferring the tier from observed
   *    usage. That cannot be right below 200k, but it is never wrong in the
   *    dangerous direction.
   *
   * A named function rather than a lambda inside the ContextWatcher construction
   * because this ordering is the whole point of the statusLine channel, and a
   * lambda in a constructor call is the one shape no suite here can reach.
   *
   * `sessionId` is safe to use as the payload key here, though the two are not
   * the same thing in general. This is only ever called from the context
   * watcher, and there are exactly three kinds of session it watches:
   *
   *  - a local session Stoke minted an id for, whose statusLine key IS that id;
   *  - a remote session, which has no key and no payload at all — its `claude`
   *    runs on the far machine — so this falls through to the banner for it,
   *    exactly as it did before the payload existed;
   *  - and not a `--continue`, whose files are named after a launch key: it is
   *    never watched, because context.ts:99 no-ops on the empty id it has.
   *
   * So no caller can reach here holding a key that names somebody else's file.
   */
  export function windowFor(sessionId: string, bannerWindow: number | null): number | null {
    return readStatusLine(sessionId)?.contextWindowSize ?? bannerWindow ?? null
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect `all pass`.

- [ ] **Step 5: Add the payload cases to `scripts/verify-context.mts`**

  Add to the imports at the top of the file:

  ```ts
  import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
  import { dirname } from 'node:path'
  import { readStatusLine, statusLinePayloadFile } from '../src/main/statusLine.ts'
  ```

  (`basename, join` are already imported from `node:path`; add `dirname` to that existing line
  rather than duplicating it.)

  Then insert after the existing `'unsuffixed id above 200k -> 1M'` check (line 104-108):

  ```ts
  /* ---------------------------------------------------------------------------
     The statusLine payload, which is now the primary source for the window size.
     The banner this used to depend on is gone: claude 2.1.221 prints
     "Claude Code v2.1.221    Opus 5 with low effort · Claude Max" and the word
     "context" appears nowhere in its startup output. So these cases assert the
     1M tier is read with no banner at all, at a token count far below 200k —
     which is exactly where the observed-usage inference gets it wrong.
     --------------------------------------------------------------------------- */
  const payloadId = 'verify-context-1m'
  const payloadFile = statusLinePayloadFile(payloadId)
  mkdirSync(dirname(payloadFile), { recursive: true })
  writeFileSync(
    payloadFile,
    JSON.stringify({
      model: { id: 'claude-opus-5', display_name: 'Opus 5' },
      context_window: { context_window_size: 1_000_000, used_percentage: 3 },
      exceeds_200k_tokens: false
    }),
    'utf8'
  )
  const stated = readStatusLine(payloadId)?.contextWindowSize ?? null
  check('statusLine payload states the window', stated === 1_000_000, String(stated))
  check(
    'a 1M session reads 1M at 50k tokens, with no banner anywhere',
    contextLimitFor('claude-opus-5', 50_000, stated) === 1_000_000,
    'the payload beat the observed-usage inference'
  )
  check(
    'a 200k model in the payload stays 200k',
    contextLimitFor('claude-haiku-4-5', 10_000, 200_000) === 200_000,
    '200,000'
  )
  rmSync(payloadFile, { force: true })
  ```

  Then, so the whole watcher path is exercised without a banner, insert this at **top level**,
  immediately after the `}` that closes the `if (snapshot) {` branch — the line below
  `check('watcher snapshot carries a model', …)`, which is line 146; the closing brace is line 147.
  Inside the branch it would be skipped whenever the live watcher timed out, which is the one case
  worth reading:

  ```ts
  /*
   * The same watcher, told the window by a payload instead of a banner. Written
   * against the live session id because that is the only id findSessionFile can
   * resolve, and removed immediately afterwards: leaving it would make a running
   * copy of Stoke read this session against 1M until its next real payload.
   */
  const livePayload = statusLinePayloadFile(liveId)
  writeFileSync(
    livePayload,
    JSON.stringify({ context_window: { context_window_size: 1_000_000 } }),
    'utf8'
  )
  const viaPayload = await new Promise<ContextSnapshot | null>((resolve) => {
    const payloadWatcher = new ContextWatcher(
      (snap) => {
        if (!snap.ready) return
        payloadWatcher.disposeAll()
        resolve(snap)
      },
      (id) => windowFor(id, null)
    )
    payloadWatcher.watch(liveId)
    setTimeout(() => {
      payloadWatcher.disposeAll()
      resolve(null)
    }, 10_000)
  })
  rmSync(livePayload, { force: true })
  check(
    'the watcher takes its window from the payload, banner or no banner',
    viaPayload?.contextLimit === 1_000_000,
    String(viaPayload?.contextLimit ?? 'timed out')
  )
  ```

  Note the import line in that first block must also pull in `windowFor`, so it reads
  `import { readStatusLine, statusLinePayloadFile, windowFor } from '../src/main/statusLine.ts'`.

- [ ] **Step 6: Run it and watch it pass**

  ```bash
  node scripts/verify-context.mts
  ```

  Expect `ALL CHECKS PASSED`, including
  `PASS  the watcher takes its window from the payload, banner or no banner  1000000` and
  `PASS  a 1M session reads 1M at 50k tokens, with no banner anywhere`.

  These are green on the first run and that is correct: `contextLimitFor` has always accepted a
  stated limit, and Step 3 already supplied the source. What this suite adds is the guarantee that
  the whole watcher path — transcript lookup, parse, limit resolution, emitted snapshot — honours
  the payload, which is the path `index.ts` is about to be pointed down in Step 7.

- [ ] **Step 7: Point the watcher at `windowFor` in `src/main/index.ts`**

  Extend the import added in Task 11 to:

  ```ts
  import {
    userStatusLineCommand,
    windowFor,
    writeSessionSettingsFile
  } from './statusLine.ts'
  ```

  and replace the comment and second constructor argument at lines 382-392 with:

  ```ts
    // The window size comes from the statusLine payload first and the CLI's own
    // startup banner second; see windowFor. The banner used to be the only
    // source and 2.1.221 stopped printing it.
    watcher = new ContextWatcher(
      (snap) => {
        send(CH.ctxUpdate, snap)
        // `ready` is false for the placeholder emitted while a brand-new session
        // has no transcript yet; its counts are zeroes and would set a baseline
        // the real first reading then blows straight past.
        if (snap.ready) autoscan?.observe(snap.sessionId, snap.messageCount, snap.updatedAt)
      },
      (sessionId) => windowFor(sessionId, ptys?.bannerWindowFor(sessionId) ?? null),
      {
  ```

  (the options object at lines 393-411 is unchanged).

- [ ] **Step 8: Correct the stale comment in `sessionFile.ts`**

  Replace the doc comment at `src/main/sessionFile.ts:175-191` with:

  ```ts
  /**
   * Context window size for a session.
   *
   * The model id alone is NOT sufficient. A session running the 1M-context tier
   * records its model as plain `claude-opus-5` — the `[1m]` suffix that appears
   * in CLI flags does not survive into the transcript, and no `context_window`
   * field is written either. Verified against a live 1M session sitting at 269k
   * tokens whose every assistant record said `claude-opus-5`.
   *
   * The window is therefore *stated* rather than derived, by the caller: the
   * statusLine payload first (`statusLine.ts`), then the startup banner for a
   * CLI old enough to print one. Both arrive here as `bannerLimit`.
   *
   * With no statement at all, observed usage is the authority: exceeding the
   * standard window is proof the session is on the extended tier. The id is
   * still checked first for the cases where a suffix is present.
   *
   * Known imprecision in that last case only: an extended-tier session below
   * 200k is reported against the 200k window until it crosses over. That reads
   * conservatively (it can over-state pressure, never under-state it) and it can
   * never exceed 100%.
   */
  ```

- [ ] **Step 9: Run both suites, then measure it live**

  ```bash
  node scripts/verify-statusline.mts && node scripts/verify-context.mts && npm run typecheck
  ```

  Expect `all pass`, then `ALL CHECKS PASSED`, then no output.

  Then launch the app on an Opus 5 session and hover the tab's context ring:

  ```bash
  npm run dev
  ```

  Expect the ring's tooltip to read against **1,000,000**, not 200,000, on a fresh session with
  only a few thousand tokens used. Before this change it read 200,000 until the session crossed
  200k.

- [ ] **Step 10: Commit**

  ```bash
  git add src/main/statusLine.ts src/main/index.ts src/main/sessionFile.ts scripts/verify-statusline.mts scripts/verify-context.mts
  git commit -m "$(cat <<'EOF'
  Take the context window from the statusLine payload

  windowFromBanner greps for "(1M context)", which claude 2.1.221 no longer
  prints, so contextLimitFor fell through to inferring the tier from observed
  usage and a 1M session read 200k until it crossed 200k — the exact failure that
  function's doc comment was written to prevent. A session at 182k showed "92%
  full" with 82% of the window still free.

  The banner and the observed-usage inference stay as fallbacks; only the order
  changes. contextLimitFor itself is untouched.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 13: Get the payload to the renderer

Two channels, both already named in `src/shared/ipc.ts` by the contracts tasks. `statusline:update`
is pushed, and must fire **only** when the payload file's mtime has moved — the file is rewritten
on every frame the CLI renders, so pushing unconditionally would be several messages per second
per session.

**Files:**
- Modify: `src/main/index.ts` (module state near `let usageCache`, the watcher's emit callback, one handler in the context IPC section after `CH.ctxUnwatch`, and the `CH.ptyKill` handler)
- Modify: `src/shared/api.ts` (imports, and a `statusLine` block after `context`)
- Modify: `src/preload/index.ts` (a `statusLine` block after the `context: { … },` block)
- Test: `node scripts/cdp-eval.mjs` against a running instance

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5. **This task does not create it** — it is
  one canonical probe for the whole plan, and three of the four independent drafts of it selected
  the CDP target by URL, which is the one thing CLAUDE.md gotcha 6 says cannot work.
- Consumes: `CH.statusLineUpdate` (`'statusline:update'`), `CH.statusLineLast` (`'statusline:last'`), `StatusLineSnapshot` — all from the contracts tasks; `readStatusLine()` from Task 7; `PtyManager.statusKeys(): string[]` from Task 11.
- Produces:
  - `window.stoke.statusLine.last(): Promise<StatusLineSnapshot | null>`
  - `window.stoke.statusLine.onUpdate(cb: (snapshot: StatusLineSnapshot) => void): () => void`

**Why `last()` sweeps rather than just returning the cached value.** The push path is driven by the
context watcher's tick, so it only ever fires for a session Stoke knew the id of at launch. A
`--continue` session is not watched (Task 11), so its payload would never be pushed and its rate
limits would never be seen — even though **rate limits are account-wide** and that session's
payload answers for every other session too. `last()` therefore takes one pass over
`ptys.statusKeys()` before answering. It is an invoke, called when the chip opens, so this is a
handful of small file reads on demand and no new polling.

- [ ] **Step 1: Run it and watch it fail**

  ```bash
  npm run build
  npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp
  ```

  and in a second terminal, with a session open in the app:

  ```bash
  node scripts/cdp-eval.mjs "typeof window.stoke.statusLine"
  ```

  Expect `"undefined"` — the bridge does not exist yet. (The explicit
  `--user-data-dir` is honoured over the app's own dev isolation; see CLAUDE.md gotcha 12. Reuse
  the same one throughout, so settings written in one step are still there in the next.)

- [ ] **Step 2: Declare the API surface**

  In `src/shared/api.ts`, add `StatusLineSnapshot` to the type import from `./types` (the block at
  the top listing `BrowserState, CliInfo, ContextSnapshot, …`), then add this block immediately
  after the `context: { … }` block:

  ```ts
    /**
     * The CLI's own statusLine payload: the context window and the plan limits.
     *
     * Only arrives while a session is open and rendering, which is the accepted
     * trade-off for not bundling a Keychain binding — see `last()`.
     */
    statusLine: {
      /**
       * The newest reading seen this run, from whichever session produced it.
       * Rate limits are account-wide, so any session answers for all of them,
       * and this is what lets the usage chip show figures with an "as of HH:MM"
       * when no session is open. Null before the first payload of the run.
       */
      last(): Promise<StatusLineSnapshot | null>
      onUpdate(cb: (snapshot: StatusLineSnapshot) => void): () => void
    }
  ```

- [ ] **Step 3: Bridge it in the preload**

  In `src/preload/index.ts`, add immediately after the `context: { … },` block (lines 61-65):

  ```ts
    statusLine: {
      last: () => ipcRenderer.invoke(CH.statusLineLast),
      onUpdate: (cb) => on<[Parameters<typeof cb>[0]]>(CH.statusLineUpdate, cb)
    },
  ```

- [ ] **Step 4: Produce it in `src/main/index.ts`**

  Add `StatusLineSnapshot` to the type import on line 5 so it reads:

  ```ts
  import type { LaunchOptions, Rect, Settings, SshHost, StatusLineSnapshot } from '@shared/types'
  ```

  and add `readStatusLine` back to the `./statusLine.ts` import, which Task 12 left holding
  `windowFor` instead, so it reads:

  ```ts
  import {
    readStatusLine,
    userStatusLineCommand,
    windowFor,
    writeSessionSettingsFile
  } from './statusLine.ts'
  ```

  Add this module state after line 57 (`let usageCache: UsageSnapshot | null = null`):

  ```ts
  /**
   * The newest statusLine reading seen this run, whichever session produced it.
   *
   * The rate limits in it are account-wide, so any open session's payload
   * answers for all of them — and keeping one means the usage chip still has
   * figures once every tab is closed, which is the whole "as of HH:MM" case.
   */
  let lastStatusLine: StatusLineSnapshot | null = null
  /** receivedAt of the last payload pushed per session, so nothing is sent twice. */
  const statusLineSeen = new Map<string, number>()

  /**
   * Push a session's payload at the renderer, if it has actually changed.
   *
   * The file is rewritten on every frame the CLI renders, so the mtime guard is
   * load-bearing rather than tidy: without it this is several IPC messages a
   * second per open session, carrying identical objects.
   */
  function pushStatusLine(sessionId: string): void {
    const snap = readStatusLine(sessionId)
    if (!snap) return
    if (statusLineSeen.get(sessionId) === snap.receivedAt) return
    statusLineSeen.set(sessionId, snap.receivedAt)
    lastStatusLine = snap
    send(CH.statusLineUpdate, snap)
  }

  /**
   * Bring `lastStatusLine` up to date from every live session's payload file.
   *
   * `pushStatusLine` above only runs for sessions the context watcher watches,
   * which is every session Stoke minted an id for — but not a `--continue`,
   * whose id the CLI chooses after launch and which is therefore watched by
   * nothing. Its payload exists all the same, under its launch key.
   *
   * That matters because the rate limits in a payload are ACCOUNT-wide: any open
   * session answers for all of them. Without this, the one launch path we cannot
   * predict is also the one that contributes no usage figures at all.
   *
   * Called from the `statusline:last` invoke, not on a timer: the chip asks when
   * it opens, and a handful of small reads on demand is cheaper than polling
   * files that are rewritten three times a second anyway.
   */
  function refreshLastStatusLine(): void {
    for (const key of ptys?.statusKeys() ?? []) {
      const snap = readStatusLine(key)
      if (!snap) continue
      if (!lastStatusLine || snap.receivedAt > lastStatusLine.receivedAt) lastStatusLine = snap
    }
  }
  ```

  In the watcher's emit callback (edited in Task 12), add one line after `send(CH.ctxUpdate, snap)`:

  ```ts
        send(CH.ctxUpdate, snap)
        pushStatusLine(snap.sessionId)
  ```

  In the `ptyKill` handler (line 536-540), add the forget:

  ```ts
    ipcMain.on(CH.ptyKill, (_e, ptyId: string) => {
      const sessionId = ptys?.sessionIdFor(ptyId)
      ptys?.kill(ptyId)
      if (sessionId) {
        watcher?.unwatch(sessionId)
        statusLineSeen.delete(sessionId)
      }
    })
  ```

  And add the handler in the context section, after `CH.ctxUnwatch` (line 544):

  ```ts
    ipcMain.handle(CH.statusLineLast, () => {
      // Sweep first, so a session nothing watches — a --continue — still
      // contributes its account-wide rate limits. See refreshLastStatusLine.
      refreshLastStatusLine()
      return lastStatusLine
    })
  ```

- [ ] **Step 5: Run it and watch it pass**

  ```bash
  npm run typecheck
  ```

  Expect no output. Then rebuild and restart the app
  (`npm run build && npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp`),
  open a session, send it one message, and:

  ```bash
  node scripts/cdp-eval.mjs "await window.stoke.statusLine.last()"
  ```

  The probe has the page stringify the value, so this prints one compact JSON line. Expect it to
  contain `"contextWindowSize":1000000` (on Opus 5) and a `"fiveHour"` object with a `percent` and
  a millisecond `resetsAt` — a 13-digit number, not a 10-digit one. Do **not** wrap the expression
  in `JSON.stringify(...)`: that double-encodes it and every quote comes back escaped.

- [ ] **Step 6: Confirm a `--continue` session still contributes its rate limits**

  Close every tab, then press **Continue last session** in the launcher, send it one message, and:

  ```bash
  node scripts/cdp-eval.mjs "await window.stoke.statusLine.last()"
  ```

  Expect one compact JSON line whose `"sessionId"` is a uuid — the id the **CLI** chose, read out
  of the payload by `toSnapshot`, not the launch key the file is named after — and whose
  `"fiveHour"` object has a `percent`. Cross-check that it is the CLI's id and not ours:

  ```bash
  node -e "const fs=require('fs'),os=require('os'),p=require('path');const d=p.join(os.tmpdir(),'stoke','statusline');const n=fs.readdirSync(d).find(x=>/^[0-9a-f-]{36}\.json$/.test(x));console.log({file:n.replace('.json',''),said:JSON.parse(fs.readFileSync(p.join(d,n),'utf8')).session_id})"
  ```

  Expect `file` and `said` to differ, and `last()`'s `sessionId` to equal `said`.

  Without `refreshLastStatusLine` this step returns `null`: nothing watches that session, so
  nothing ever pushed its payload. That is the failure this step exists to catch — the usage chip
  would show "no data" for an account whose limits are sitting on disk.

- [ ] **Step 7: Confirm the channel is not chatty**

  ```bash
  node scripts/cdp-eval.mjs "new Promise(r => { let n = 0; const off = window.stoke.statusLine.onUpdate(() => n++); setTimeout(() => { off(); r(n) }, 10000) })"
  ```

  With a session sitting idle, expect `0`. A number in the tens means the mtime guard is not
  working.

- [ ] **Step 8: Commit**

  ```bash
  git add src/main/index.ts src/preload/index.ts src/shared/api.ts
  git commit -m "$(cat <<'EOF'
  Publish the statusLine reading to the renderer

  Two channels: a push for the live reading and an invoke for the last one seen,
  which is what lets the usage chip show figures with an "as of" when no session
  is open.

  The push is gated on the payload file's mtime because the CLI reruns the
  statusLine command on every frame it renders — ungated this is several
  identical objects a second per session.

  last() sweeps the live sessions' launch keys before answering. The push path
  runs off the context watcher, which never watches a --continue session, so
  without the sweep the one launch path whose id the CLI chooses would contribute
  no usage figures at all — despite rate limits being account-wide, and despite
  its payload sitting on disk the whole time.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 14: Draw the usage chip from `rate_limits`

Spec 2.2: the chip renders nothing on macOS because `~/.claude/.credentials.json` does not exist
there. The payload carries the same two windows, so the chip gets a source that works on every
platform. The account API path stays exactly as it is, as the fallback where it does work.

**Files:**
- Create: `src/shared/statusLine.ts`
- Modify: `src/renderer/src/components/UsageMeter.tsx:1-2` (imports), `:72-145` (`UsageChip`)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (the Layout block, Step 6a)
- Test: `node scripts/verify-statusline.mts`, then `node scripts/cdp-eval.mjs`

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5.
- Consumes: `StatusLineSnapshot`, `UsageWindow`, `UsageSnapshot` (types); `window.stoke.statusLine.last()` / `.onUpdate()` from Task 13; `window.stoke.usage.read()` (existing).
- Produces (in `src/shared/statusLine.ts`):
  - `export const FIVE_HOUR_MS: number`, `export const SEVEN_DAY_MS: number`
  - `export function elapsedFraction(resetsAt: number | null, windowMs: number, now: number): number | null`
  - `export function statusLineWindows(snap: StatusLineSnapshot, now: number): UsageWindow[]`

- [ ] **Step 1: Extend the suite with the mapping section**

  In `scripts/verify-statusline.mts`, add the import:

  ```ts
  import { statusLineWindows } from '../src/shared/statusLine.ts'
  ```

  and insert before the summary lines:

  ```ts
  console.log('\nthe usage bars the chip draws from it')
  // Half an hour before the five-hour window in REAL resets.
  const barsNow = 1_786_076_400_000
  const windows = statusLineWindows(toSnapshot('sess-5', REAL, barsNow), barsNow)
  check('two windows, in the order the chip reads them', windows.map((w) => w.kind), [
    'session',
    'weekly'
  ])
  check('labels match the ones the account API produces', windows.map((w) => w.label), [
    '5 hours',
    'Weekly'
  ])
  check('percentages carry over', windows.map((w) => w.percent), [15, 3])
  check(
    'the five-hour window is 90% elapsed half an hour before it resets',
    windows[0].elapsed,
    0.9
  )
  check(
    'a window with no reset time gets no pace marker, rather than a wrong one',
    statusLineWindows(
      toSnapshot('sess-6', { rate_limits: { five_hour: { used_percentage: 12 } } }, barsNow),
      barsNow
    )[0].elapsed,
    null
  )
  check(
    'no rate limits at all means no bars, so the chip hides instead of showing zeroes',
    statusLineWindows(toSnapshot('sess-7', {}, barsNow), barsNow),
    []
  )
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/shared/statusLine.ts'`

- [ ] **Step 3: Create `src/shared/statusLine.ts`**

  ```ts
  import type { StatusLineSnapshot, UsageWindow } from './types'

  /**
   * The statusLine payload's rate limits, in the shape the usage meter already
   * draws.
   *
   * Shared rather than renderer-local so a verify suite can pin the mapping —
   * and deliberately producing `UsageWindow`, not a second shape, so one
   * component renders both sources and the two can never drift into disagreeing
   * about what "5 hours" means.
   */

  /** Window lengths, so the pace marker has a start as well as an end. */
  export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
  export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

  /**
   * How far through its window a limit is, 0-1, or null when the reset time is
   * unknown. `resets_at` gives only the end, so the start is inferred from the
   * window's fixed length.
   */
  export function elapsedFraction(
    resetsAt: number | null,
    windowMs: number,
    now: number
  ): number | null {
    if (resetsAt === null) return null
    const startedAt = resetsAt - windowMs
    return Math.max(0, Math.min(1, (now - startedAt) / windowMs))
  }

  export function statusLineWindows(snap: StatusLineSnapshot, now: number): UsageWindow[] {
    const out: UsageWindow[] = []
    if (snap.fiveHour) {
      out.push({
        kind: 'session',
        label: '5 hours',
        percent: Math.round(snap.fiveHour.percent),
        // The payload states no severity, and inventing one would colour a bar
        // by a rule the account does not use. The pace marker still tones it.
        severity: 'normal',
        resetsAt: snap.fiveHour.resetsAt,
        elapsed: elapsedFraction(snap.fiveHour.resetsAt, FIVE_HOUR_MS, now),
        active: true
      })
    }
    if (snap.sevenDay) {
      out.push({
        kind: 'weekly',
        label: 'Weekly',
        percent: Math.round(snap.sevenDay.percent),
        severity: 'normal',
        resetsAt: snap.sevenDay.resetsAt,
        elapsed: elapsedFraction(snap.sevenDay.resetsAt, SEVEN_DAY_MS, now),
        active: true
      })
    }
    return out
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect `all pass`.

- [ ] **Step 5: Rewrite `UsageChip`**

  In `src/renderer/src/components/UsageMeter.tsx`, replace the imports on lines 1-2 with:

  ```tsx
  import { useEffect, useState } from 'react'
  import type { StatusLineSnapshot, UsageSnapshot, UsageWindow } from '@shared/types'
  import { statusLineWindows } from '@shared/statusLine'
  ```

  Add this helper immediately after `countdown` (after line 24):

  ```tsx
  /** Local wall-clock HH:MM, for the "as of" on a reading that may be stale. */
  function clock(at: number): string {
    const d = new Date(at)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  ```

  and replace the whole of `UsageChip` (lines 72-145) with:

  ```tsx
  export function UsageChip(): React.JSX.Element | null {
    const [snap, setSnap] = useState<UsageSnapshot | null>(null)
    const [line, setLine] = useState<StatusLineSnapshot | null>(null)
    const [now, setNow] = useState(() => Date.now())
    const [open, setOpen] = useState(false)

    useEffect(() => {
      let live = true
      const pull = async (): Promise<void> => {
        const next = await window.stoke.usage.read()
        if (live) setSnap(next)
      }
      void pull()
      // The main process caches, and backs off further when rate-limited; this
      // only has to be often enough that the countdown does not visibly stall.
      const poll = setInterval(() => void pull(), 60_000)
      const tick = setInterval(() => setNow(Date.now()), 30_000)
      return () => {
        live = false
        clearInterval(poll)
        clearInterval(tick)
      }
    }, [])

    useEffect(() => {
      let live = true
      // The last reading of the run, so closing every tab does not blank the
      // chip — it goes quiet and says when it last heard anything.
      void window.stoke.statusLine.last().then((s) => {
        if (live && s) setLine(s)
      })
      const off = window.stoke.statusLine.onUpdate((s) => setLine(s))
      return () => {
        live = false
        off()
      }
    }, [])

    useEffect(() => {
      if (!open) return
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false)
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [open])

    /*
     * The statusLine payload wins when there is one. It is the live account
     * state as the CLI itself was just told it, and on macOS it is the only
     * source there is — the OAuth token lives in the Keychain, not in
     * ~/.claude/.credentials.json, which is why this chip rendered nothing there.
     */
    const fromLine = line ? statusLineWindows(line, now) : []
    const windows: UsageWindow[] =
      fromLine.length > 0 ? fromLine : snap && !snap.error ? snap.windows : []

    // Nothing at all rather than a row of zeroes: no reading is not the same as
    // no usage, and a wrong number here would be believed.
    if (!windows.length) return null

    const asOf = fromLine.length > 0 && line ? `as of ${clock(line.receivedAt)}` : null

    // The two windows that actually run out. A model-scoped one is shown in the
    // panel but would make the chip a wall of digits.
    const session = windows.find((w) => w.kind === 'session')
    const weekly = windows.find((w) => w.kind === 'weekly')
    const ahead = windows.some((w) => w.elapsed !== null && w.percent > w.elapsed * 100)

    return (
      <div className="usage-chip-wrap">
        <button
          className="usage-chip"
          data-ahead={ahead || undefined}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={asOf ? `Plan limits, ${asOf} — click for detail` : 'Plan limits — click for detail'}
        >
          {session && <span>{session.percent}%</span>}
          {session && weekly && <span className="usage-chip-sep">·</span>}
          {weekly && <span>{weekly.percent}%</span>}
        </button>

        {open && (
          <>
            {/* Click-away, behind the panel and above everything else. */}
            <div className="usage-backdrop" onClick={() => setOpen(false)} />
            <div className="usage-panel" role="dialog" aria-label="Plan limits">
              {windows.map((w) => (
                <Bar key={`${w.kind}-${w.label}`} window={w} now={now} />
              ))}
              <p className="usage-note">
                the white mark is where you would be using it evenly. fill past it means
                you are going faster than it refills.
              </p>
              {asOf && (
                <p className="usage-note">
                  read from an open session&rsquo;s status line, {asOf}. it only updates while a
                  session is running.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    )
  }
  ```

- [ ] **Step 6: Measure it in a running instance**

  ```bash
  npm run typecheck && npm run build
  npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp
  ```

  With a session open and one message sent:

  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.usage-chip')?.textContent ?? 'NO CHIP'"
  node scripts/cdp-eval.mjs "document.querySelector('.usage-chip')?.title ?? 'NO CHIP'"
  ```

  Expect the first to print two percentages separated by `·` (for example `"15%·3%"`) and the
  second to match `Plan limits, as of HH:MM — click for detail`. On macOS, before this change the
  first command printed `"NO CHIP"`.

- [ ] **Step 6a: List the module in `CLAUDE.md`'s Layout block.** In
  `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, locate the `ui.ts` line contracts Task 2 Step 8a
  added (`grep -n "^  ui\.ts" CLAUDE.md`) and insert immediately after it:

  ```
    statusLine.ts     the two plan-limit windows the usage chip draws, from the payload
  ```

  This is the shared half. E Task 16 Step 2 adds the main-process `statusLine.ts` under
  `src/main/`; the two are different files with the same basename, which is exactly why both are
  listed under their own parent.

  Expected: `grep -cE "^  statusLine\.ts" CLAUDE.md` prints `1`.

- [ ] **Step 7: Commit**

  ```bash
  git add src/shared/statusLine.ts src/renderer/src/components/UsageMeter.tsx scripts/verify-statusline.mts CLAUDE.md
  git commit -m "$(cat <<'EOF'
  Draw the usage chip from the statusLine rate limits

  Fixes the chip rendering nothing on macOS. It was never platform-gated: the
  only OAuth token source is ~/.claude/.credentials.json, which does not exist
  there because the token is in the login Keychain, so fetchUsage bailed with
  "Not signed in to Claude Code." and the chip returned null.

  The payload carries the same two windows. The account API path stays as the
  fallback where it works, and no Keychain binding is bundled — the accepted cost
  is that the figures only move while a session is open, which the chip now says
  with an "as of HH:MM".

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 15: The setting

"Hide Claude's status line in Stoke", default on. On, the wrapper prints nothing. Off, it prints
the user's own statusLine command's output. Either way the payload still arrives — the setting
governs stdout, not the data channel.

**Files:**
- Modify: `src/renderer/src/components/SettingsSheet.tsx:215-228` (insert a `check-row` after the "Start a session on launch" one)
- Test: `node scripts/cdp-eval.mjs` against a running instance, then a real session

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5.
- Consumes: `Settings.hideStatusLine: boolean` (default `true`, hydrated in `src/main/settingsSchema.ts` by the contracts tasks); `onPatch(patch: Partial<Settings>): void` (existing prop, `SettingsSheet.tsx:24`); the launch-time read in `launchSession` from Task 11.
- Produces: nothing new.

- [ ] **Step 1: Add the toggle**

  In `src/renderer/src/components/SettingsSheet.tsx`, insert immediately after the closing
  `</label>` of the "Start a session on launch" row (line 228):

  ```tsx
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.hideStatusLine}
              onChange={(e) => onPatch({ hideStatusLine: e.target.checked })}
            />
            <span>
              <span className="field-label">Hide Claude&rsquo;s status line in Stoke</span>
              <span className="field-hint">
                Stoke reads the context window and your plan limits from the status line the CLI
                pipes to it, and by default prints nothing back — the line duplicates chrome the
                app already draws. Turn this off to keep your own status line, which still runs and
                still shows exactly what it did before. Your{' '}
                <span className="mono">~/.claude/settings.json</span> is never modified, and either
                way this applies to sessions started after the change.
              </span>
            </span>
          </label>
  ```

- [ ] **Step 2: Prove the default and the write path**

  ```bash
  npm run typecheck && npm run build
  rm -rf /tmp/stoke-cdp
  npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp
  ```

  ```bash
  node scripts/cdp-eval.mjs "(await window.stoke.settings.get()).hideStatusLine"
  ```

  Expect `true` — that profile has never seen this key, which is exactly the upgrade case.

  Open Settings in the app, untick the new row, then:

  ```bash
  node scripts/cdp-eval.mjs "(await window.stoke.settings.get()).hideStatusLine"
  ```

  Expect `false`.

- [ ] **Step 3: Prove pass-through against a real session**

  With the box unticked, open a **new** session in Stoke. Expect the status line configured in
  `~/.claude/settings.json` (`bash ~/.claude/statusline-command.sh` on this machine) to appear at
  the bottom of the terminal, exactly as it does outside Stoke. Then:

  ```bash
  node scripts/cdp-eval.mjs "await window.stoke.statusLine.last()"
  ```

  Expect one compact JSON line containing `"contextWindowSize"` — pass-through must not cost the
  data. Re-tick the box, open another new session, and expect no status line and a payload still
  arriving.

- [ ] **Step 4: Commit**

  ```bash
  git add src/renderer/src/components/SettingsSheet.tsx
  git commit -m "$(cat <<'EOF'
  Add "Hide Claude's status line in Stoke"

  Default on: the wrapper is how the context window and the plan limits reach the
  app at all, and the line it suppresses duplicates chrome Stoke already draws.
  Off passes the user's own command through unchanged, so the data still arrives
  either way — the setting governs stdout, not the channel.

  There is no CLI flag for this; --safe-mode and --bare both have unacceptable
  collateral, which is why it is a settings key.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 16: Correct the documentation this invalidates

`CLAUDE.md` gotcha 2 documents a `(1M context)` banner that claude 2.1.221 no longer prints, and
`ARCHITECTURE.md` says the window is inferred from observed usage. Both were true when written.
Leaving them costs the next person exactly the time the gotcha list exists to save.

**Files:**
- Modify: `CLAUDE.md:103-110` (gotcha 2), `CLAUDE.md:27` (verify list), `CLAUDE.md:50` (layout)
- Modify: `ARCHITECTURE.md:102-104` (the two sentences under "### The context meter" that begin
  "The window size is inferred from observed usage"; 101 is the blank line above them)
- Test: `npm run check`

**Interfaces:**
- Consumes: everything landed in Tasks 7-15.
- Produces: nothing.

- [ ] **Step 1: Rewrite gotcha 2**

  In `CLAUDE.md`, replace lines 103-110 with:

  ```markdown
  2. **The context window is stated only by the statusLine payload.** It cannot be derived from
     the model id: a 1M-tier session records its model as plain `claude-opus-5`, no `[1m]` suffix
     survives into the transcript, and there is no `context_window` field. Verified again on a
     session at 713,617 tokens; the only tier-ish field anywhere is `usage.service_tier`, which is
     billing. The CLI *used* to state it in its startup banner and **2.1.221 does not** — the
     banner is now `Claude Code v2.1.221    Opus 5 with low effort · Claude Max`, and the word
     "context" appears nowhere in the startup output.

     So Stoke installs its own `statusLine` command (`src/main/statusLine.ts`), folded into the
     single `--settings` file at launch. The CLI pipes it a JSON payload on stdin whose
     `context_window.context_window_size` is the window — per model, and correct from token zero.
     The wrapper writes it to `<tmpdir>/stoke/statusline/<sessionId>.json` and prints nothing,
     which is why suppressing the in-terminal line and reading the data are the same act.
     `windowFromBanner` and `contextLimitFor`'s observed-usage inference are kept as **fallbacks**
     for CLI versions that emit no payload; a banner that does say `(1M context)` still works, and
     escape codes must still be stripped before matching, because the banner is styled.

     Three things that cost time if you forget them: **a second `--settings` silently discards the
     first**, so the statusLine key and the `ultracode` key have to arrive in one file;
     `rate_limits.*.resets_at` in that payload is epoch **seconds** while every other timestamp in
     Stoke is ms (converted once, in `toSnapshot`); and a `--continue` session has no id up front,
     so it gets no payload — exactly as it already gets no context meter.
  ```

- [ ] **Step 2: List the new suites and the new module**

  In `CLAUDE.md`, insert immediately after the `npm run verify:context` line in the verify-suite
  block (locate it by that text):

  ```
  npm run verify:statusline     # the statusLine wrapper: payload, suppression, pass-through
  npm run verify:unicode        # xterm's cell widths for emoji and box drawing
  ```

  and in the layout block, immediately after the
  `sessionFile.ts    transcript parsing and the context maths` line:

  ```
    statusLine.ts     Stoke's statusLine wrapper: context window + plan limits
  ```

  Leave the `npm run verify:usage` line alone here. **Task 17 Step 5 rewrites it**, once
  `verify:usage` is actually in `check` and its live half is opt-in — rewriting it twice is how the
  two descriptions end up disagreeing.

- [ ] **Step 3: Correct `ARCHITECTURE.md`**

  Replace the paragraph at `ARCHITECTURE.md:102-104` — all three lines, beginning "The window size
  is inferred from observed usage, not the model id — see gotcha 2." and ending "asserts the
  invariant against real transcripts." Locate it with
  `grep -n "The window size is inferred" ARCHITECTURE.md` (one hit). Replace it with:

  ```markdown
  The window size is **stated**, not derived. Stoke installs its own `statusLine` command for the
  sessions it spawns (`statusLine.ts`, folded into the one `--settings` file `cli.ts` writes), and
  the CLI pipes that command a JSON payload whose `context_window.context_window_size` is the
  answer — per model, correct before a token is spent. The CLI's startup banner is the fallback
  for older versions, and inferring the tier from observed usage is the fallback below that; see
  gotcha 2. Inference alone was wrong in the first implementation and reported 140–320% occupancy,
  which is why `npm run verify:context` exists and asserts the invariant against real transcripts.

  That command is the only thing Stoke installs into a session, and it still writes nothing of
  Claude's: the settings file, the wrapper and the payloads all live under the system temp
  directory, and `~/.claude/settings.json` is read for the user's own status line and never
  modified.
  ```

- [ ] **Step 4: Run the full check**

  ```bash
  npm run check
  ```

  Expect it to pass, including `verify:statusline` in its new slot after `verify:context`.

- [ ] **Step 5: Commit**

  ```bash
  git add CLAUDE.md ARCHITECTURE.md
  git commit -m "$(cat <<'EOF'
  Record that the (1M context) banner is gone

  Gotcha 2 documented a startup banner claude 2.1.221 no longer prints, so anyone
  trusting it would have gone looking for a regex that could never match. It now
  describes the statusLine payload as the source and keeps the banner as the
  fallback it has become, plus the two things that bite: one --settings file, and
  resets_at in seconds.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 17: Repoint `verify:usage` at the statusLine payload

Runs **last** in workstream E. It closes design §5's "`verify:usage` — repoint at the statusLine
payload", which no task in any part touches: after Task 14 the chip prefers `statusLineWindows()`
over `window.stoke.usage.read()`, but `scripts/verify-usage.mts` still exercises only the
OAuth/account route — the one spec §2.2 records as returning nothing on macOS. The suite meant to
prove the fix cannot run on the machine the fix is for.

It runs after Task 16 so the CLAUDE.md command list is rewritten once rather than twice.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-usage.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` (`check`)
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (the `verify:usage` line in the suite list)
- Test: `node scripts/verify-usage.mts`, then `npm run check`

**Interfaces:**
- Consumes: `statusLineWindows(snap: StatusLineSnapshot, now: number): UsageWindow[]` from
  `src/shared/statusLine.ts` (Task 14); `toSnapshot(sessionId, payload, receivedAt)` from
  `src/main/statusLine.ts` (Task 7).
- Produces: no new exports. `verify:usage` joins `npm run check`; only its live account section
  stays opt-in, behind `STOKE_LIVE_USAGE=1`.

- [ ] **Step 1: Add the payload section**

  In `scripts/verify-usage.mts`, add to the imports:

  ```ts
  import { statusLineWindows } from '../src/shared/statusLine.ts'
  import { toSnapshot } from '../src/main/statusLine.ts'
  ```

  and insert this block immediately above the file's closing lines — the
  `` console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`) `` and the
  `process.exitCode` assignment with its libuv comment. Anchor on those, never on a line number.
  The file's assertion helper is already named `check`; use it and do not add a second one:

  ```ts
  console.log('\nthe windows the chip actually draws, from a real 2.1.221 payload')
  /*
   * This is the path the chip prefers after E Task 14, and on macOS it is the
   * only path there is: the account route reads ~/.claude/.credentials.json,
   * which does not exist there because the OAuth token is in the login Keychain.
   * Until now the suite proving the usage meter worked exercised only the route
   * that cannot work on the machine the meter was broken on.
   */
  const PAYLOAD = {
    session_id: 'a0e0ee79-0000-4000-8000-000000000000',
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    context_window: { context_window_size: 1_000_000, used_percentage: 28 },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: { used_percentage: 15, resets_at: 1_786_078_200 },
      seven_day: { used_percentage: 3, resets_at: 1_786_647_600 }
    }
  }
  /** Half an hour before the five-hour window in PAYLOAD resets. */
  const at = 1_786_076_400_000
  const drawn = statusLineWindows(toSnapshot('usage-1', PAYLOAD, at), at)

  check(
    'two windows, in the order the chip reads them',
    drawn.map((w) => w.kind),
    ['session', 'weekly']
  )
  check(
    'labelled the way the account route labels them, so one component renders both',
    drawn.map((w) => w.label),
    ['5 hours', 'Weekly']
  )
  check(
    'percentages carry straight over',
    drawn.map((w) => w.percent),
    [15, 3]
  )
  check(
    'the five-hour window is 0.9 elapsed half an hour before it resets',
    drawn[0].elapsed,
    0.9
  )
  check(
    'resets_at is seconds in and milliseconds out',
    drawn.map((w) => w.resetsAt),
    [1_786_078_200_000, 1_786_647_600_000]
  )
  check(
    'a window with no resets_at gets no pace marker rather than a wrong one',
    statusLineWindows(
      toSnapshot('usage-2', { rate_limits: { five_hour: { used_percentage: 12 } } }, at),
      at
    )[0].elapsed,
    null
  )
  check(
    'no rate limits at all means no bars, so the chip hides instead of drawing zeroes',
    statusLineWindows(toSnapshot('usage-3', {}, at), at),
    []
  )
  ```

- [ ] **Step 2: Make the live half opt-in**

  Still in `scripts/verify-usage.mts`, take the block that starts at

  ```ts
  console.log('\nthe live account')
  const live = await fetchUsage()
  ```

  and runs to the closing `}` of its `if (live.retryAfter) … else { … }` chain — the branch
  printing `` `        ${w.label.padEnd(8)} used …` `` — and wrap the whole of it:

  ```ts
  /*
   * The account route needs the network and a token, and on macOS it has
   * neither: the OAuth token is in the login Keychain, not in
   * ~/.claude/.credentials.json, so this section reports "Not signed in to
   * Claude Code." and fails. That is exactly why the payload section above
   * exists — and why this half is opt-in, so the rest of the suite can be part
   * of `npm run check`.
   */
  if (process.env.STOKE_LIVE_USAGE === '1') {
    /* the existing block, moved in unchanged */
  } else {
    console.log('\n  SKIP  the live account call (set STOKE_LIVE_USAGE=1 to run it)')
  }
  ```

  Do not delete it and do not change any of its assertions, including the `failures++` on
  `live.error`. It is the only coverage the account route has, and it still works on Windows.

- [ ] **Step 3: Run it, both ways**

  ```bash
  node scripts/verify-usage.mts
  ```

  Expected: the payload section all `PASS`, then
  `  SKIP  the live account call (set STOKE_LIVE_USAGE=1 to run it)`, then `all pass`, exit 0.

  Then, once, on this machine:

  ```bash
  STOKE_LIVE_USAGE=1 node scripts/verify-usage.mts
  ```

  Expected on macOS: `  FAIL  Not signed in to Claude Code.`, then `1 failure(s)`, exit 1 —
  unchanged from today, and the whole reason the payload path is now the primary one and this half
  sits behind a flag. Record that result in the commit body.

- [ ] **Step 4: Chain it into `check`**

  In `package.json`, **insert** `&& npm run verify:usage` into the `check` value immediately after
  `npm run verify:unicode`. Insert — never quote or retype the whole line. Then run this task's
  guard — the thirteen suites that must be in `check` once this insertion has landed, and no name a
  later task creates:

  ```bash
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','usage','profiles','settings','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"
  ```

  Expected: it prints nothing and exits 0. `folders` and `tabs` are deliberately absent — D Task 34
  and A Task 55 have not run. Any name it prints is a suite this insertion has just deleted.

- [ ] **Step 5: Fix the descriptions this invalidates**

  In `CLAUDE.md`, change the verify-suite line

  ```
  npm run verify:usage          # plan limits, incl. a live account call
  ```

  to

  ```
  npm run verify:usage          # plan limits from the statusLine payload; STOKE_LIVE_USAGE=1 adds the account call
  ```

  and, two lines above the fenced block, change the sentence

  > The verify suites, all runnable alone. `check` runs everything except the last two, which
  > need a live instance or cost money:

  to

  > The verify suites, all runnable alone. `check` runs everything except `verify:extract` and
  > `verify:security`, which need a live instance:

  — after this task `verify:usage` is in `check`, and only its account call is opt-in.

  Then confirm this plan does not still describe `verify:usage` as excluded from `check`:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "verify:usage" docs/superpowers/plans/2026-08-07-stoke-ux-overhaul.md
  ```

  Expected: every hit either belongs to this task or reads "`verify:usage` is in `npm run check`…
  only its live account section is opt-in". A hit calling it a suite that costs money and is
  excluded from `check` is stale — fix that sentence in this commit.

- [ ] **Step 6: Run the whole check and commit**

  ```bash
  npm run check
  ```

  Expect exit 0.

  ```bash
  git add scripts/verify-usage.mts package.json CLAUDE.md
  git commit -m "$(cat <<'EOF'
  Prove the usage chip's real data path, on the platform it was broken on

  verify:usage exercised only the OAuth/account route, which reads
  ~/.claude/.credentials.json — a file that does not exist on macOS, because the
  token is in the login Keychain. So the suite that was supposed to prove the
  usage meter worked could not run on the machine the meter was broken on, and it
  was excluded from `npm run check` on the grounds that it costs money.

  It now asserts the statusLine payload path the chip actually prefers, against
  the captured 2.1.221 payload and with no network at all, and is chained into
  check. The account call is kept exactly as it was, behind STOKE_LIVE_USAGE=1;
  run here once, it still answers "Not signed in to Claude Code." on this Mac.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Workstream C — the worklog

**Reads with:** `docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-design.md` §2.4 and §4.C
(authoritative), `docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md`
(shared names — copy them verbatim), `CLAUDE.md` gotchas 15–20, `ARCHITECTURE.md`.

**Prerequisite:** contract Tasks 1–5 must be committed first. Task 1 creates `src/shared/paths.ts`
(including the `.ts`-extension re-export and both `allowImportingTsExtensions` tsconfig flags) and
rewrites `src/main/worklog/gate.ts` so `groupForCwd` and `shouldWatch` take an optional `roots`
argument and fold path case on macOS; Task 2 creates `src/shared/worklog.ts` and the new types and
channels; Task 3 creates `src/main/settingsSchema.ts` with `Settings.worklogBoards`; Task 4
declares the new CSS tokens; Task 5 creates `scripts/cdp-eval.mjs`. Every task below imports or
runs something one of those created.

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5. Every measurement step in this part runs
  it; nothing here creates it, and no step may write its own CDP probe. It stringifies the value
  inside the page, so **every expected output below is compact JSON on one line** —
  `{"watched":true}`, never a pretty-printed object.

**Tasks in this part: 18–33**, written in the order they run.

**Ordering, and why.** The feature does not work at all today, so the order is: make it able to
run, then give it controls, then make it run on the right sessions, then make it say what it did,
then make it remember.

1. **Tasks 18–20 make a Notion-only run possible.** Spec §4.C.1 asks for the cost of a *Notion-only*
   recall, and there is no such thing yet — `buildRecallPrompt` always asks for both boards.
2. **Task 21 gives that setting controls** (spec §4.C.6's "editable IDs"). It runs here because
   Task 19's error string — *"no board is switched on for this entry — turn one on under Settings,
   Worklog agent"* — and Task 29's `watchSentence` both send the user to a panel that has to exist
   by the time those strings ship.
3. **Task 22 measures, and is optional.** It spends real money and needs live MCP connectors, so it
   is a *follow-up that tightens* the ceilings, never a prerequisite that blocks. Tasks 23 and 24
   ship committed figures and a committed refusal fixture; a skipped Task 22 leaves nothing at a
   stand-in value.
4. **Tasks 23–26 spend those figures**: ceilings both paid runs fit inside, a `claudePath` on the
   write path, budget exhaustion named as itself, and a scan that always reports what it did
   (spec §2.4.1, §2.4.2, §2.4.4, §4.C.3).
5. **Tasks 27–28 fix which sessions are watched** — one predicate, root-aware, shared by the dot
   and by the run that costs money (spec §2.4.3, §4.C.4–5).
6. **Tasks 29–30 make it observable** (spec §2.4.4, §4.C.7).
7. **Tasks 31–33 make it remember** across a restart: the baselines, the hourly ceiling, and the
   session→folder map `watchStates()` iterates (spec §2.4 closing note, §4.C.8).

**No stand-in values, anywhere.** Two of this workstream's constants govern money and one governs
whether a failure is visible at all, and an earlier draft left all three to be filled in later from
a live run. That is now forbidden and the structure prevents it:

- `RECALL_MAX_BUDGET_USD` and `APPLY_MAX_BUDGET_USD` ship as **committed figures with a stated
  derivation** ($0.60 each, Task 23), not as a value awaiting a measurement. A ceiling that is too
  high costs money only when something else is already wrong; a ceiling that is too low — $0, or
  the $0.15 this workstream exists to raise — costs the entire feature, silently. Task 22 may
  tighten them afterwards.
- The assertions guarding them are **absolute bounds** (`>= 0.2 && <= 1.5`), never a comparison
  against a second constant that could also be zero. `0 >= 0 * 3` is how `npm run check` goes
  green on a dead feature.
- `BUDGET_REFUSAL` is one **stated fixture**, written identically into two suites, with the comment
  that says it is the assumed envelope and what replaces it. `isBudgetExhausted` matches
  defensively on two independent signals — the `subtype` and the result text, both tested with
  `/budget/i` — precisely because neither is a documented interface.
- Task 24's last step before its commit is a grep that fails on any surviving angle-bracket marker.

**Line numbers in this part are hints, not addresses.** Four workstreams insert into
`src/renderer/src/App.tsx`, `src/renderer/src/styles/app.css`, `src/main/index.ts`,
`src/renderer/src/components/TitleBar.tsx`, `src/renderer/src/components/Sidebar.tsx` and four
verify suites, so any figure written as "currently line N" is correct only for the first task that
runs. **Locate every edit by the quoted text**, not by the number: for CSS, by the selector
(`grep -n "^\.project-meta {" src/renderer/src/styles/app.css`); for TS/TSX, by a unique quoted
line from the block being replaced; for the verify suites, by **that suite's own** closing
summary/exit pair — the five shapes are listed in Global Constraints, and `verify-context.mts`,
`verify-color.mts` and `verify-worklog-retry.mts` each differ from the rest — inserting immediately
above it. If the quoted text is not found, stop — a prerequisite task has not landed or has
landed differently, and guessing at the location is how two parts silently overwrite each other.

**Read before writing any code:** `CLAUDE.md` gotcha 15 (`--safe-mode` and MCP are mutually
exclusive — the scan stays hermetic, recall stays a separate run), gotcha 16 (a board's closed
statuses are on none of its open tasks), **gotcha 17 (the queue's dedupe key is load-bearing:
proposal ids are its sha1 and rejections are tombstones keyed on it — nothing in this workstream
touches `dedupeKey`, `proposalId`, or the `create` key format, and Task 19 has an explicit
regression test that pins all four key shapes byte-for-byte)**, gotcha 18 (an SSH session's `cwd`
is the *local* folder), gotcha 19 (never add flags to a user's remote connect command), gotcha 20
(an `await` inside a polling pass is a window two passes can both walk through — directly relevant
to Tasks 31, 32 and 33).

**The rule this workstream must not break** (`gate.ts` header, spec §7): watching is keyed on the
session's own `cwd` and **never** on the sidebar profile chip. There is nowhere to pass the chip
in, by design, and `scripts/verify-worklog-gate.mts` asserts the shape of that promise — find it
with `grep -n "the sidebar chip is not consulted" scripts/verify-worklog-gate.mts`.

**Seams with other workstreams, stated once:**
- **C Task 28 is a hard prerequisite of A Task 52.** A Task 52's acceptance criterion calls
  `window.stoke.worklog.watch()`, whose handler Task 28 Step 4 adds. A Task 52 no longer edits
  `src/shared/api.ts` or `src/preload/index.ts` at all — **C Task 28 Step 4 is the sole writer of
  those two object literals**, and its snippets below are byte-for-byte what goes in.
- **C Task 29 Step 7 is the sole writer of App.tsx's worklog subscriptions.** A Task 52 reuses
  `worklogWatch` rather than declaring a second copy; two `const offWatch` in one effect is a hard
  redeclaration error.
- **D Task 36 replaces the `projectsAdd` handler that Task 28 Step 3 modifies.** D's replacement
  carries `sendWatchStates()` and its new `CH.projectsMeta` handler calls it too. C runs first;
  Task 28 Step 3 says so at the call site.
- **`verify:usage` is in `npm run check`** after E Task 17; only its live account section is opt-in
  behind `STOKE_LIVE_USAGE=1`. Nothing in this part may describe it as excluded from `check`.

---

---

### Task 18: Recall reads only the boards that are switched on

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

### Task 19: The write path takes its board ids from settings

`runner.ts:37-38` compiles in one person's Notion data source and ClickUp list. Nobody else can use
the feature, and this machine cannot narrow to one destination.

It also closes the one way this workstream could have moved a dedupe key. Narrowing the boards
narrows `existing`, and the **update** key is a composite of every record a proposal names — so
`s1|update|notion:x,clickup:y` becomes `s1|update|notion:x` the moment ClickUp is switched off.
Steps 10–14 make "already known" survive that, without moving a byte of the key itself.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts` (lines 1–6 imports, 29–38
  the constants, 351–436 `buildApplyPrompt`, 456 `TARGETS`, 678–694 `applyRunOptions`, 811–828
  `ApplyOptions`, 846–915 `applyProposal`)
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/queue.ts` (append `dedupeKeys` after
  `proposalId` at line 110; the three matching sites inside `add` — the `seen` construction at
  line 316, `const key` at 347, and the skip-plus-record pair at 352–353)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts` (append before the
  final summary lines), `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-retry.mts`
  (append before the final summary lines)

**Interfaces:**
- Consumes: `DEFAULT_WORKLOG_BOARDS: WorklogBoards`, `WORKLOG_TARGETS: readonly WorklogTarget[]`
  from `src/shared/worklog.ts`; `type WorklogBoards` from `@shared/types`; `dedupeKey`,
  `proposalId`, `type Identity`, `WorklogQueue` and `type ProposalDraft` from
  `src/main/worklog/queue.ts` (all already exported today).
- Produces:
  - `buildApplyPrompt(proposal: WorklogProposal, target: WorklogTarget, boards?: WorklogBoards): string`
  - `applyRunOptions(proposal: WorklogProposal, target: WorklogTarget, opts?: ApplyOptions): HeadlessOptions`
    — `ApplyOptions` gains `boards?: WorklogBoards`
  - `applyProposal` writes only to `boards.targets`
  - `NOTION_DATA_SOURCE` / `CLICKUP_LIST_ID` stay exported, as re-exports of the defaults
  - `export function dedupeKeys(p: Identity): string[]` in `queue.ts` — every key a proposal
    answers to. `dedupeKey` and `proposalId` are **unchanged**, byte for byte.

- [ ] **Step 1: Check the two imports the gotcha-17 regression test needs.** Run:

  ```bash
  cd /Users/thevinh/dev/personal/stoke
  grep -n "dedupeKey" scripts/verify-worklog-runner.mts
  ```

  Expected: a line inside the existing `from '../src/main/worklog/queue.ts'` import block.
  `dedupeKey` is exported from `queue.ts`, **not** from `runner.ts` — this is the one guard the
  whole overhaul has for CLAUDE.md gotcha 17, and it silently never runs if the import is not
  there. **Verify, do not re-add:** it is already imported today, and a second `import { dedupeKey }`
  statement is a duplicate-binding error that takes the suite down. If the grep prints nothing, a
  prerequisite has removed it — add `dedupeKey` to the existing `queue.ts` import list and nowhere
  else.

- [ ] **Step 2: Write the failing assertions.** In
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
  /*
   * And the id itself, which is the thing the tombstone is actually keyed on.
   * Pinning the key alone would still let a change to `proposalId`'s hash or its
   * 12-character slice resurrect every rejection, so both literals are stated:
   * they are sha1(key).slice(0, 12) and they must never move.
   */
  check(
    'a create proposal keeps the id it has always had',
    proposalId({ sessionId: 'abc-123', title: 'Fixed the context meter!' }),
    '3409a9f77267'
  )
  check(
    'and so does an update that names a record',
    proposalId({
      sessionId: 'abc-123',
      title: 'Whatever the model called it this time',
      kind: 'update',
      existing: { clickup: { id: 'ABC123', title: 't' } }
    }),
    '59d970da5ff4'
  )
  ```

  Add `proposalId` to the existing `../src/main/worklog/queue.ts` import list — the same list
  Step 1 confirmed already carries `dedupeKey`. Nothing else in this workstream imports it.

- [ ] **Step 3: Run it and watch it fail.**
  `node scripts/verify-worklog-runner.mts`
  Expected: `TypeError: buildApplyPrompt(...) is not a function` is **not** what you should see —
  the real failure is the third argument being ignored:
  `FAIL  and the shipped default is nowhere in it`, followed by
  `FAIL  a configured ClickUp list reaches the prompt`, and the suite exits 1.
  The six `dedupeKey` / `proposalId` lines under *"the create dedupe key is byte-for-byte what it
  always was"* must all print `PASS` on this very first run. They are regression pins, not a
  red-green pair: if any of them fails here, stop — something has already changed the key format
  and every previously rejected proposal is about to come back (gotcha 17).

- [ ] **Step 4: Re-point the constants at the shared defaults.** In
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

- [ ] **Step 5: Take the ids from the argument.** In `buildApplyPrompt`, change the signature
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

- [ ] **Step 6: Carry the boards through the options.** In `ApplyOptions` (line 811) add, after
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

- [ ] **Step 7: Never write to a board that is switched off.** In `applyProposal` (line 846),
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

- [ ] **Step 8: Prove a switched-off board is never written.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-retry.mts`, immediately **before** its
  closing pair — which is **not** the `verify-worklog-gate.mts` wording: this suite counts in
  `failed`, so the two lines are
  ``console.log(failed === 0 ? '\nall pass' : `\n${failed} failure(s)`)`` and
  `process.exitCode = failed === 0 ? 0 : 1`. Locate the first of them with
  `grep -n "all pass" scripts/verify-worklog-retry.mts` (one hit, line 114 today). The block below
  uses this suite's own `check(name, ok: boolean, detail = '')` — a `const` arrow declared at its
  line 18, **not** the `check(name, got, want)` of the other suites — and it increments `failed`:

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

- [ ] **Step 9: Run both and watch them pass.**
  `node scripts/verify-worklog-runner.mts` → `all pass`, then
  `node scripts/verify-worklog-retry.mts` → `all pass`.

- [ ] **Step 10: Work out, on paper, what narrowing the boards does to the UPDATE key.**
  Read `/Users/thevinh/dev/personal/stoke/src/main/worklog/queue.ts` lines 72–110 and 315–353
  before writing anything, and confirm all four of these against the code rather than against this
  paragraph:

  1. `dedupeKey` builds an update's key from **every** record the proposal names, joined:
     `` `${p.sessionId}|update|${ref}` `` where `ref` is `notion:x,clickup:y` (line 82–88).
  2. `seen` (line 316) is built from the **full** `dedupeKey` of every stored proposal, whatever its
     status.
  3. `refused` (lines 331–335) is built from `dedupeKey({ sessionId, title })` — **no `kind`, no
     `existing`** — so a rejected proposal's tombstone is always the *title-based create key*, for
     an update as much as for a create. The incoming lookup at line 352 uses that same shape.
  4. Therefore the honest conclusion, and the one to act on: **rejections are not resurrected** by a
     board being switched off — the tombstone is title-keyed at both ends and target-narrowing does
     not touch a title. What breaks is `seen`. A pending or accepted update stored as
     `s1|update|notion:x,clickup:y` does not match a rescan's `s1|update|notion:x`, so the same
     update is queued a second time — and accepting it applies the same write to the same Notion
     page twice, with two visible entries in the panel saying so.

  This is the fix the plan owes CLAUDE.md gotcha 17: the create key stays byte-for-byte (Steps 2–3
  pin it) and the update key gets stability rather than a migration, because there is no stored
  record of a *key* to migrate — `dedupeKey` is recomputed from `existing` on every load, so a
  migration would have to rewrite history that is still true.

- [ ] **Step 11: Write the failing assertions.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`, add `dedupeKeys` and
  `type Identity` to the existing import block from `../src/main/worklog/queue.ts` — the one that
  already carries `MAX_ENTRIES`, `WorklogQueue`, `dedupeKey` and `type ProposalDraft`, plus
  `proposalId` from Step 2. **Add to that list; do not write a second import statement** from the
  same module. Then paste this immediately before the file's closing summary lines:

  ```ts
  /*
   * CLAUDE.md gotcha 17, the other half.
   *
   * An update's key is a composite of every board record it names, so narrowing
   * the configured boards narrows `existing` and changes it:
   * `s1|update|notion:page-1,clickup:abc123` becomes `s1|update|notion:page-1`.
   * Nothing already queued matches that, so the same update is proposed again
   * and accepting it writes to the same Notion page twice.
   *
   * The key itself must not move — ids are its sha1. So a proposal answers to
   * more than one key instead: the composite, plus one per record it names.
   * "Already known" becomes "any record of mine is already spoken for", which is
   * stable when boards are switched off AND when they are switched back on.
   */
  console.log('\nthe update key survives a board being switched off')

  const twoBoards: Identity = {
    sessionId: 's1',
    title: 'Finished the SSH work',
    kind: 'update',
    existing: {
      notion: { id: 'PAGE-1', title: 'Ship SSH sessions' },
      clickup: { id: 'ABC123', title: 'Ship SSH sessions' }
    }
  }
  const notionOnly: Identity = {
    sessionId: 's1',
    // Reworded on purpose: an update is keyed on the record, never the wording.
    title: 'Wrapped up the SSH work',
    kind: 'update',
    existing: { notion: { id: 'PAGE-1', title: 'Ship SSH sessions' } }
  }

  check(
    'the composite key is untouched, so no id and no tombstone moves',
    dedupeKey(twoBoards),
    's1|update|notion:page-1,clickup:abc123'
  )
  check(
    'and it is still the first key the proposal answers to',
    dedupeKeys(twoBoards)[0],
    dedupeKey(twoBoards)
  )
  check('a two-board update also answers to one key per record', dedupeKeys(twoBoards), [
    's1|update|notion:page-1,clickup:abc123',
    's1|update|notion:page-1',
    's1|update|clickup:abc123'
  ])
  check('a one-board update answers to exactly one key, with no duplicate', dedupeKeys(notionOnly), [
    's1|update|notion:page-1'
  ])
  ok(
    'so the Notion-only re-proposal shares a key with the two-board one',
    dedupeKeys(notionOnly).some((k) => dedupeKeys(twoBoards).includes(k)),
    dedupeKeys(notionOnly).join(' ')
  )
  check('a create answers to its one key and nothing else', dedupeKeys({ sessionId: 's1', title: 'Fixed the context meter!' }), [
    's1|fixed the context meter'
  ])
  check(
    'and so does an update with no record to point at',
    dedupeKeys({ sessionId: 's1', title: 'Fixed the context meter!', kind: 'update' }),
    ['s1|fixed the context meter']
  )

  console.log('\nand the queue does not queue it twice')
  {
    /** The same work, once with both boards read and once with only Notion. */
    const bothDraft: ProposalDraft = {
      sessionId: 's1',
      cwd: 'G:\\Code\\personal\\Stoke',
      group: 'personal',
      title: 'Finished the SSH work',
      body: 'Shipped it.',
      targets: ['notion', 'clickup'],
      kind: 'update',
      existing: {
        notion: { id: 'PAGE-1', title: 'Ship SSH sessions' },
        clickup: { id: 'ABC123', title: 'Ship SSH sessions' }
      },
      newStatus: { notion: 'Done', clickup: 'complete' }
    }
    const narrowedDraft: ProposalDraft = {
      ...bothDraft,
      title: 'Wrapped up the SSH work',
      targets: ['notion'],
      existing: { notion: { id: 'PAGE-1', title: 'Ship SSH sessions' } },
      newStatus: { notion: 'Done' }
    }

    const qN = new WorklogQueue(queueFile('narrowed'))
    check('the first scan queues it', qN.add([bothDraft]).length, 1)
    check(
      'the rescan with ClickUp switched off adds nothing',
      qN.add([narrowedDraft]).length,
      0
    )
    check('so the panel still shows one entry', qN.list().length, 1)

    // And the other direction: switched off first, switched back on later.
    const qW = new WorklogQueue(queueFile('widened'))
    check('narrow first', qW.add([narrowedDraft]).length, 1)
    check('and widening the boards again adds nothing either', qW.add([bothDraft]).length, 0)
    check('still one entry', qW.list().length, 1)

    // A rejected update must not come back under the narrowed key either.
    const qR = new WorklogQueue(queueFile('narrow-reject'))
    const rejected = qR.add([bothDraft])[0]
    qR.reject(rejected.id)
    check('a rejected update stays rejected under the narrowed key', qR.add([narrowedDraft]).length, 0)
    check(
      'and it is still one record, still rejected',
      qR.list().map((p) => p.status),
      ['rejected']
    )

    // A different record in the same session is different work, and must not be
    // swallowed by the rule above.
    const otherRecord: ProposalDraft = {
      ...narrowedDraft,
      title: 'Started the worklog panel',
      existing: { notion: { id: 'PAGE-2', title: 'Worklog panel' } },
      newStatus: { notion: 'In progress' }
    }
    check('a different Notion page is still a second proposal', qN.add([otherRecord]).length, 1)
  }
  ```

  `qR.reject(id)` is the queue's existing method (`queue.ts:413`); no new API is needed.

- [ ] **Step 12: Run it and watch it fail.**
  `node scripts/verify-worklog-runner.mts`
  Expected: a link-time failure before any output —
  `SyntaxError: The requested module '../src/main/worklog/queue.ts' does not provide an export named 'dedupeKeys'`.

- [ ] **Step 13: Make a proposal answer to every key it owns.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/queue.ts`, append immediately after
  `proposalId` (line 110):

  ```ts
  /**
   * Every key a proposal answers to, for the purposes of "already known".
   *
   * `dedupeKey` returns exactly one string, `proposalId` is its sha1, and both
   * are frozen byte for byte — CLAUDE.md gotcha 17. This does not touch either.
   *
   * The problem it solves is that an update's key is a COMPOSITE of every board
   * record the proposal names, and that composite is not stable when the user
   * changes which boards are switched on. With ClickUp off, recall reads only
   * Notion, so `existing` carries only Notion and the very same update arrives
   * as `s1|update|notion:x` where it was `s1|update|notion:x,clickup:y`. It
   * matches nothing already queued, so it is queued again and accepting it
   * applies the same write to the same page twice.
   *
   * So an update also answers to one key per record it names, and "already
   * known" becomes "any record of mine is already spoken for". That is stable
   * both ways — switching a board off and switching it back on — and it needs no
   * migration, because nothing on disk stores a key: `dedupeKey` is recomputed
   * from `existing` every time the file is loaded.
   *
   * A create answers to its one key and nothing else. Its only identity is its
   * flattened title, and a second key there would collapse two genuinely
   * different pieces of work, which is the one error this file will not make.
   */
  export function dedupeKeys(p: Identity): string[] {
    const composite = dedupeKey(p)
    if (p.kind !== 'update') return [composite]
    // A Set, because a one-record update's composite IS its per-record key and
    // the two must not be reported as two.
    const keys = new Set<string>([composite])
    for (const t of TARGETS) {
      const id = p.existing?.[t]?.id
      if (id) keys.add(`${p.sessionId}|update|${t}:${id.toLowerCase()}`)
    }
    return [...keys]
  }
  ```

  Then, in `add`, change three lines. Line 316 becomes:

  ```ts
      const seen = new Set(this.items.flatMap((p) => dedupeKeys(p)))
  ```

  line 347 becomes:

  ```ts
        const keys = dedupeKeys(identity)
  ```

  and lines 352–353 become:

  ```ts
        // Both ways round, and against `refused` rather than `seen`: a *rejected*
        // create blocks the same words arriving as an update and vice versa, but a
        // merely pending one must not — losing a better-informed update to an
        // earlier create would be a silent downgrade.
        //
        // `keys.some` rather than a single lookup so an update still matches when
        // the configured boards have changed under it; see dedupeKeys.
        if (
          keys.some((k) => seen.has(k)) ||
          refused.has(dedupeKey({ sessionId: draft.sessionId, title }))
        )
          continue
        for (const k of keys) seen.add(k)
  ```

  Nothing else in `add` changes — `proposalId(identity)` at line 356 still hashes the single
  composite key, which is what keeps every existing id exactly where it was.

- [ ] **Step 14: Run all three suites and watch them pass.**
  `node scripts/verify-worklog-runner.mts` → `all pass`, then
  `node scripts/verify-worklog-retry.mts` → `all pass`, then
  `node scripts/verify-worklog-recall.mts` → `all pass`.
  The six create-key pins from Step 2 must still read `PASS`; if any of them moved, `dedupeKey`
  has been edited when only `add` should have been.

- [ ] **Step 15: Commit.**
  `git commit -m "Take the worklog's board ids from settings instead of the binary"`
  Body records: `runner.ts` compiled in one person's Notion data source and ClickUp list, so nobody
  else could use the feature and this machine could not narrow to one board; that the create dedupe
  key is now covered by a regression test, because changing it would resurrect every proposal the
  user has ever rejected (CLAUDE.md gotcha 17); and that switching a board off changes the *update*
  key, which is a composite of the records a proposal names — so a proposal now answers to one key
  per record as well as to the composite, and a rescan after narrowing recognises its own earlier
  work instead of queueing a duplicate write. `dedupeKey` and `proposalId` are unchanged, and no
  migration is needed because no key is stored: it is recomputed from `existing` on load.

---

### Task 20: The scan proposes only to boards that are switched on

With ClickUp off, the scan still asks for `{"kind":"create","targets":["clickup"]}` entries, and
`normaliseTargets` still falls back to both. Every one of those proposals is unwritable.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts` (lines 252–273
  `ScanContext`, 287–348 `buildScanPrompt`, 458–465 `normaliseTargets`, 475–532 `toProposals`,
  542–570 `parseProposals`, 609–623 `ScanInput`, 702–736 `scanSession`, 759–809 `groundProposals`)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`

**Interfaces:**
- Consumes: `WORKLOG_TARGETS`, `DEFAULT_WORKLOG_BOARDS` (already imported by Task 19).
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

  Three names in that block have to already be in scope. Confirm them rather than assuming:

  ```bash
  grep -n "type RecallSnapshot" scripts/verify-worklog-runner.mts   # the recall.ts import list
  grep -n "^const digest" scripts/verify-worklog-runner.mts          # summariseTurns(long)
  grep -n "^const proposal" scripts/verify-worklog-runner.mts        # the WorklogProposal factory
  ```

  All three print a line today. **Verify, do not re-add** — a second `type RecallSnapshot` import
  from the same module is a duplicate-binding error. If `type RecallSnapshot` is missing, add it to
  the existing `from '../src/main/worklog/recall.ts'` import list and nowhere else. Because
  `digest` and `proposal` are declared part-way down the file, this block goes at the **end**, on
  the closing-lines anchor, where both are in scope.

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

### Task 21: The board target and ids get controls (runs here, after Task 20)

Spec §4.C.6 asks for "target (Notion / ClickUp / both, defaulting to **Notion only**) and editable
IDs". Tasks 18–20 and contracts §0.5 have just landed the whole storage half — the type, the
hydration, and every read site — and there is still no control anywhere. As things stand
"editable" means hand-editing `settings.json`, and Task 19's own error string,
`'no board is switched on for this entry — turn one on under Settings, Worklog agent'`, points at
a panel that has no such switch. So the controls land here, before any string ships that names
them.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/WorklogSettings.tsx`
  (`Props` at lines 3–13, the import on line 1, and the tail of the returned `<div className="field">`,
  immediately above the `field-hint` beginning "Each review costs tokens"),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/SettingsSheet.tsx`
  (the `<WorklogSettings …/>` element, currently line 272)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-settings.mts` (append), then CDP

**Interfaces:**
- Consumes: `WORKLOG_TARGETS` from `@shared/worklog` (contracts Task 2); `type WorklogBoards`,
  `type WorklogTarget` from `@shared/types` (contracts Task 2); `hydrateWorklogBoards`'s rule from
  contracts §0.5 — the panel applies the *same* filter, so what it shows and what the store keeps
  cannot diverge.
- Produces: `WorklogSettings` props `boards: WorklogBoards` and
  `onChangeBoards: (boards: WorklogBoards) => void`. No new module, no new IPC — this writes
  through the existing `onPatch({ worklogBoards })`.

- [ ] **Step 1: Pin the rule the control has to obey.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-settings.mts`, insert immediately above the
  file's closing two lines:

  ```ts
  console.log('\nwhat the boards control is allowed to produce')

  /*
   * These are already true of hydrateWorklogBoards. They are asserted here
   * because the panel in WorklogSettings.tsx now applies the same three rules
   * itself, and a panel that could show a destination the store would drop is a
   * switch that lies about what it did.
   */
  check(
    'a target whose id is empty is not a target',
    hydrateSettings({
      worklogBoards: { targets: ['notion', 'clickup'], notionDataSource: 'x', clickupListId: '  ' }
    }).worklogBoards.targets,
    ['notion']
  )
  check(
    'the stored order cannot change the canonical order',
    hydrateSettings({
      worklogBoards: { targets: ['clickup', 'notion'], notionDataSource: 'x', clickupListId: '1' }
    }).worklogBoards.targets,
    ['notion', 'clickup']
  )
  check(
    'a name no write tool exists for is dropped',
    hydrateSettings({
      worklogBoards: { targets: ['jira', 'notion'], notionDataSource: 'x', clickupListId: '1' }
    }).worklogBoards.targets,
    ['notion']
  )
  ```

- [ ] **Step 2: Run it and watch it pass.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/verify-settings.mts` → `all pass`.
  These are regression cover for a rule contracts Task 3 already implements, not a red-green pair.
  If any of them fails, `hydrateWorklogBoards` did not land as contracts §0.5 specifies and this
  task cannot be written against it.

- [ ] **Step 3: Declare the props.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/WorklogSettings.tsx`, change
  line 1 to:

  ```ts
  import type { ProfileConfig, WorklogBoards, WorklogTarget } from '@shared/types'
  import { WORKLOG_TARGETS } from '@shared/worklog'
  ```

  and add to `Props`, immediately after `auto: boolean` and its doc comment:

  ```ts
    /** `Settings.worklogBoards`: where reviews are filed, and which board in each. */
    boards: WorklogBoards
    /** Called with the whole replacement record; the caller persists it. */
    onChangeBoards: (boards: WorklogBoards) => void
  ```

  Add `boards` and `onChangeBoards` to the destructured parameter list.

- [ ] **Step 4: Build the one function that decides what is stored.** In the same file, add
  immediately below the existing `const fold = …` line:

  ```ts
  /** Labels and hints per destination, so the JSX below stays a loop. */
  const TARGET_UI: Record<WorklogTarget, { label: string; idLabel: string; placeholder: string; need: string }> = {
    notion: {
      label: 'Notion',
      idLabel: 'Notion data source',
      placeholder: 'collection://…',
      need: 'Add a Notion data source first'
    },
    clickup: {
      label: 'ClickUp',
      idLabel: 'ClickUp list id',
      placeholder: '901615258684',
      need: 'Add a ClickUp list id first'
    }
  }

  /** The id field that belongs to a destination. One place, so the tick box and
   *  the disabled state cannot disagree about which id they mean. */
  const idFor = (boards: WorklogBoards, target: WorklogTarget): string =>
    target === 'notion' ? boards.notionDataSource : boards.clickupListId

  /**
   * The record to store, given what the user just did.
   *
   * The same filter `hydrateWorklogBoards` applies (contracts §0.5): canonical
   * order, and a destination with no id is dropped. Applying it here rather than
   * trusting the store means the panel can never show a destination the runner
   * would refuse to write to — which is the failure Task 19's "no board is
   * switched on" error exists to catch, one layer too late.
   */
  function nextBoards(
    boards: WorklogBoards,
    ticked: Set<WorklogTarget>,
    ids: Pick<WorklogBoards, 'notionDataSource' | 'clickupListId'>
  ): WorklogBoards {
    const merged: WorklogBoards = { ...boards, ...ids, targets: boards.targets }
    return {
      ...merged,
      targets: WORKLOG_TARGETS.filter((t) => ticked.has(t) && idFor(merged, t).trim().length > 0)
    }
  }
  ```

- [ ] **Step 5: Render the controls.** In the same file, inside the existing
  `<div className="field">`, immediately **above** the final
  `<span className="field-hint">` that begins "Each review costs tokens", insert:

  ```tsx
        {/*
          Where, not whether. The checkboxes above choose which sessions are
          reviewed; these choose where the review is filed, and until Task 21 the
          answer was compiled into runner.ts:37-38 — one person's board, in the
          binary, with no way for anyone else to use the feature at all.
        */}
        <span className="field-label">Where reviews are filed</span>

        {WORKLOG_TARGETS.map((target) => {
          const ui = TARGET_UI[target]
          const hasId = idFor(boards, target).trim().length > 0
          return (
            <label className="check-row" key={target}>
              <input
                type="checkbox"
                checked={boards.targets.includes(target)}
                disabled={!hasId}
                title={hasId ? undefined : ui.need}
                onChange={(e) => {
                  const ticked = new Set(boards.targets)
                  if (e.target.checked) ticked.add(target)
                  else ticked.delete(target)
                  onChangeBoards(
                    nextBoards(boards, ticked, {
                      notionDataSource: boards.notionDataSource,
                      clickupListId: boards.clickupListId
                    })
                  )
                }}
              />
              <span>
                <span className="field-label">{ui.label}</span>
              </span>
            </label>
          )
        })}

        <label className="field-label" htmlFor="worklog-notion-id">
          {TARGET_UI.notion.idLabel}
        </label>
        <input
          id="worklog-notion-id"
          className="input"
          value={boards.notionDataSource}
          placeholder={TARGET_UI.notion.placeholder}
          spellCheck={false}
          onChange={(e) =>
            onChangeBoards(
              nextBoards(boards, new Set(boards.targets), {
                notionDataSource: e.target.value,
                clickupListId: boards.clickupListId
              })
            )
          }
        />

        <label className="field-label" htmlFor="worklog-clickup-id">
          {TARGET_UI.clickup.idLabel}
        </label>
        <input
          id="worklog-clickup-id"
          className="input"
          inputMode="numeric"
          value={boards.clickupListId}
          placeholder={TARGET_UI.clickup.placeholder}
          spellCheck={false}
          onChange={(e) =>
            onChangeBoards(
              nextBoards(boards, new Set(boards.targets), {
                notionDataSource: boards.notionDataSource,
                clickupListId: e.target.value
              })
            )
          }
        />

        <span className="field-hint">
          A destination with no id is not a destination — it is dropped on save, which is why the
          box will not tick until the id is there. Clearing an id switches its board off rather
          than leaving a tick that writes nowhere.
        </span>
  ```

- [ ] **Step 6: Wire it.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/SettingsSheet.tsx`, on the
  existing `<WorklogSettings …/>` element (find it with
  `grep -n "<WorklogSettings" src/renderer/src/components/SettingsSheet.tsx`), add two props
  beside `onChangeAuto`:

  ```tsx
            boards={settings.worklogBoards}
            onChangeBoards={(worklogBoards) => onPatch({ worklogBoards })}
  ```

- [ ] **Step 7: Typecheck and build.**
  `npm run typecheck` exits 0, then `npm run build` exits 0.

- [ ] **Step 8: Measure it over CDP.** Launch against a throwaway profile so nothing here touches
  the user's real settings:

  ```bash
  npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-boards
  ```

  Open Settings, then in another shell:

  ```bash
  node scripts/cdp-eval.mjs "(async () => (await window.stoke.settings.get()).worklogBoards)()"
  ```

  Expected on a fresh profile:
  `{"targets":["notion"],"notionDataSource":"collection://368d3f2d-1f02-817c-b193-000b208e36bd","clickupListId":"901615258684"}`

  Now clear the **ClickUp list id** field in the panel and re-run the same command. Expected:
  `{"targets":["notion"],"notionDataSource":"collection://368d3f2d-1f02-817c-b193-000b208e36bd","clickupListId":""}`
  — and the ClickUp checkbox is disabled, with the tooltip "Add a ClickUp list id first". Type
  `901615258684` back in, tick ClickUp, and re-run. Expected:
  `{"targets":["notion","clickup"],"notionDataSource":"collection://368d3f2d-1f02-817c-b193-000b208e36bd","clickupListId":"901615258684"}`
  — canonical order, not click order. Then `rm -rf /tmp/stoke-boards`.

- [ ] **Step 9: Commit.**
  `git commit -m "Give the worklog's boards controls, so 'editable ids' means editable"`
  Body records: the ids were compiled into `runner.ts:37-38`, so nobody but their owner could use
  the feature and this machine could not narrow to one destination; the panel applies the same
  drop-a-target-with-no-id rule as `hydrateWorklogBoards`, so the switch cannot show a destination
  the runner would refuse to write to; and Task 19's "turn one on under Settings, Worklog agent"
  now names a control that exists.

---

### Task 22: Measure what a Notion-only recall costs, and what a budget refusal looks like — optional

**This task is optional and blocks nothing.** It ships a *tool*, not a value. Tasks 23 and 24 land
committed figures and a committed refusal fixture and do not read anything from here, so a machine
with no live MCP connectors — or an operator unwilling to spend the money — skips this task
entirely and the workstream still completes with no stand-in value anywhere.

Why it exists anyway: two figures in this feature are somebody else's, not ours. The real cost of
the read that `recall.ts:248` caps at $0.15, and the exact envelope the CLI returns when
`--max-budget-usd` bites. If you can measure them, the constants in Task 23 can be tightened and
the fixture in Task 24 replaced with the observed strings — a follow-up commit, on top of a tree
that already works.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/scripts/measure-worklog-cost.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` (the `scripts` block)

**Interfaces:**
- Consumes: `runHeadless`, `type HeadlessResult` from `src/main/agent.ts`; `readExisting`,
  `recallRunOptions` from `src/main/worklog/recall.ts`; `DEFAULT_WORKLOG_BOARDS` from
  `src/shared/worklog.ts`.
- Produces: `measure:worklog` in `package.json`. Nothing else in the plan imports or reads it.
- Deliberately **not** in `npm run check`: both modes spawn a real `claude`, and the recall mode
  reads a live board through the user's own MCP connectors. (`verify:usage` is *not* a comparable
  case any more — after E Task 17 it is in `check`, with only its live account call behind
  `STOKE_LIVE_USAGE=1`. `verify:security`, which needs a running instance, is the comparable one.)

- [ ] **Step 1: Write the measurement tool.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/measure-worklog-cost.mts`:

  ```ts
  /*
   * What the worklog actually costs, measured rather than assumed.
   *
   * `recall.ts` capped a run at $0.15 and that run could not finish inside it —
   * which is spec §2.4.1, and the single reason the whole feature never did
   * anything. RECALL_MAX_BUDGET_USD and APPLY_MAX_BUDGET_USD ship as stated
   * figures with a stated derivation, so nothing depends on this tool having
   * been run; what it buys is the right to *tighten* them, and to replace the
   * assumed BUDGET_REFUSAL envelope in the two worklog suites with the observed
   * one.
   *
   * NOT part of `npm run check`. Both modes spawn a real `claude` and the recall
   * mode reads a live board through the user's own MCP connectors, so this costs
   * money and cannot run on a machine with no connectors — the same reason
   * verify:security is excluded.
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
    console.log(
      `\n>>> a Notion-only recall cost $${raw.costUsd} on ${new Date().toISOString().slice(0, 10)}.`
    )
    console.log(
      '>>> If that is comfortably below RECALL_MAX_BUDGET_USD (0.6), you may tighten the constant\n' +
        '>>> in src/main/worklog/recall.ts to about four times this figure, and APPLY_MAX_BUDGET_USD\n' +
        '>>> in src/main/worklog/runner.ts alongside it. Keep both inside the 0.2–1.5 band the\n' +
        '>>> suites assert. If it is ABOVE 0.6, raise them instead — a ceiling under the real cost\n' +
        '>>> is the bug this whole workstream exists to fix.'
    )
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
      console.log(
        '\n>>> Copy the subtype and the first line of the text above into the BUDGET_REFUSAL\n' +
          '>>> fixture in BOTH scripts/verify-worklog-runner.mts and\n' +
          '>>> scripts/verify-worklog-recall.mts, keeping the two copies identical. The assertions\n' +
          '>>> around them do not change: isBudgetExhausted matches /budget/i on either field, so a\n' +
          '>>> real envelope must still be recognised and a plain failure must still not be.'
      )
    } catch (err) {
      console.log('\nit threw instead of returning an envelope:')
      console.log(String(err))
      console.log(
        '\n>>> Budget exhaustion has no envelope on this CLI version. Leave BUDGET_REFUSAL as it\n' +
          '>>> is and open an issue: agent.ts keeps a non-zero exit that still printed a result,\n' +
          '>>> so a throw here means the CLI stopped printing one and isBudgetExhausted is never\n' +
          '>>> reached — a different bug from the one it was written for.'
      )
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

- [ ] **Step 3: Prove it loads without spending anything.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/measure-worklog-cost.mts nonsense`
  Expected: `usage: node scripts/measure-worklog-cost.mts [recall|budget]` and exit code 1. That is
  the whole acceptance test for this task — the tool parses, its imports resolve under strip-types,
  and neither paid mode ran.

- [ ] **Step 4: Commit.**
  `git commit -m "Add a measurement tool for what the worklog's two paid runs really cost"`
  Body records: the two figures this feature depends on belong to somebody else's CLI and somebody
  else's boards, so there is a tool to observe them; the constants that use them ship as stated
  figures rather than waiting on it, because a plan that blocks on a paid run does not execute.

**Optional, after the workstream is green — the two live runs.** Neither is a step of this task and
neither gates anything below.

- `npm run measure:worklog -- recall` reads the real Notion board once. If the printed `costUsd` is
  well under `RECALL_MAX_BUDGET_USD` (0.6), you may tighten that constant and `APPLY_MAX_BUDGET_USD`
  to about four times it, staying inside the 0.2–1.5 band `scripts/verify-worklog-recall.mts`
  asserts, and commit that on its own. If the run comes back `isError true` with a budget subtype,
  the tool's own ceiling of 2 was too low — raise it in the script and measure again, because a
  truncated run measures the ceiling rather than the read.
- `npm run measure:worklog -- budget` prints the refusal envelope. If it differs from the
  `BUDGET_REFUSAL` fixture Task 24 ships, replace both copies of the fixture with the observed
  strings — keeping them identical — re-run `node scripts/verify-worklog-runner.mts` and
  `node scripts/verify-worklog-recall.mts`, and commit. The assertions are unchanged either way:
  they are what proves the two suites still agree about what a refusal looks like.

---

### Task 23: Give both paid runs a ceiling that they fit inside, and the configured `claudePath`

`recall.ts:248` caps at $0.15, and the read cannot finish inside it, so recall dies every time
(spec §2.4.1). `applyProposal` is called from the accept handler with neither `maxBudgetUsd` nor
`claudePath` (spec §2.4.2), so it sits on the CLI's own default and auto-detects an executable the
user may have configured explicitly.

**Both ceilings ship as stated figures.** $0.60 each, derived below, inside the 0.2–1.5 band the
suite asserts. They are not waiting on Task 22 and they must never be committed at a stand-in
value: `recall.ts:248` reads `opts.maxBudgetUsd ?? RECALL_MAX_BUDGET_USD`, so a 0 there aborts
every recall before its first turn — strictly worse than the $0.15 bug this task exists to fix,
and invisible, because a dead recall reports an empty board and the scan then proposes creating
everything.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts` (the `maxBudgetUsd:` line
  inside `recallRunOptions` — find it with `grep -n "0.15" src/main/worklog/recall.ts`),
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts` (`scanRunOptions`,
  `applyRunOptions`), `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (the `worklogAccept`
  handler only — find it with `grep -n "CH.worklogAccept" src/main/index.ts`)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts` (the line
  `ok('and under a budget ceiling', …)`),
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`

**Interfaces:**
- Produces:
  - `export const RECALL_MAX_BUDGET_USD: number` in `recall.ts`
  - `export const SCAN_MAX_BUDGET_USD: number` and `export const APPLY_MAX_BUDGET_USD: number` in
    `runner.ts`
  - `applyRunOptions` and `scanRunOptions` default `maxBudgetUsd` from those constants rather than
    from the agent's global default.
- Consumes: nothing from Task 22. That task is an optional follow-up.

**Not in this task:** the `recall({…})` and `scanSession({…})` call sites inside `runWorklogScan`.
Task 25 replaces that whole function and wires the boards there. Editing them here and again there
makes Task 25's diff read as a revert of this one, which is why the edit lives in exactly one
place. Until Task 25 lands, `recall` is called without `targets` and reads both boards — the
shipped behaviour, unchanged.

- [ ] **Step 1: Write the failing assertions.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts`, add
  `RECALL_MAX_BUDGET_USD` to the import list from `../src/main/worklog/recall.ts`, and replace the
  line `ok('and under a budget ceiling', (opts.maxBudgetUsd ?? 1) <= 0.15, String(opts.maxBudgetUsd))`
  with:

  ```ts
  ok(
    'the ceiling is the shared constant, not a literal buried in the options',
    opts.maxBudgetUsd === RECALL_MAX_BUDGET_USD,
    `${opts.maxBudgetUsd} vs ${RECALL_MAX_BUDGET_USD}`
  )
  /*
   * An absolute band, deliberately, and not a comparison against a second
   * constant.
   *
   * "At least three times the measured cost" sounds stronger and is weaker: it
   * needs a second constant holding the measurement, and if nobody fills that in
   * the comparison reads `0 >= 0 * 3` and passes — so the suite goes green on a
   * $0 ceiling, which is a dead feature with a passing test. A band cannot pass
   * vacuously. The floor catches a value nobody filled in; the cap keeps it a
   * ceiling rather than a blank cheque.
   */
  ok(
    'the recall ceiling is a real figure, not a placeholder',
    RECALL_MAX_BUDGET_USD >= 0.2 && RECALL_MAX_BUDGET_USD <= 1.5,
    String(RECALL_MAX_BUDGET_USD)
  )
  ```

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
  /* The write path states its own figure rather than aliasing the recall one, so
     tightening either cannot silently move the other. Same band, same reason. */
  ok(
    'and the write path has its own, equally real',
    APPLY_MAX_BUDGET_USD >= 0.2 && APPLY_MAX_BUDGET_USD <= 1.5,
    String(APPLY_MAX_BUDGET_USD)
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
  and its doc comment:

  ```ts
  /**
   * The ceiling one Notion-only recall may spend.
   *
   * Provisional, and deliberately generous: the previous $0.15 was below what a
   * connector-backed read costs, so every recall aborted before its first turn
   * (spec §2.4.1) and the feature could never work. Re-measure with
   * `npm run measure:worklog -- recall` and tighten this if the real figure
   * allows; a ceiling that is too high costs money only when something is wrong,
   * a ceiling that is too low costs the whole feature.
   */
  export const RECALL_MAX_BUDGET_USD = 0.6
  ```

  and change `maxBudgetUsd: opts.maxBudgetUsd ?? 0.15,` to:

  ```ts
      maxBudgetUsd: opts.maxBudgetUsd ?? RECALL_MAX_BUDGET_USD,
  ```

- [ ] **Step 4: Give the scan and the write their own ceilings.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts`, add just above `scanRunOptions`:

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
   * it costs about what a recall does — and a write that runs out of budget half
   * way through is the worst outcome in the feature, because a record may already
   * exist. Deliberately generous for that reason.
   *
   * Stated independently of the recall ceiling, so tightening one cannot silently
   * move the other. They happen to be equal today; that is a coincidence of two
   * derivations, not a dependency.
   *
   * This was previously absent entirely: `worklogAccept` called `applyProposal`
   * with no budget and no claudePath (spec §2.4.2), so the write sat on the CLI's
   * own default and auto-detected an executable the user may have set explicitly.
   */
  export const APPLY_MAX_BUDGET_USD = 0.6
  ```

  Do **not** import `RECALL_MAX_BUDGET_USD` into `runner.ts` for this — the two constants are
  deliberately unlinked. (`runner.ts`'s existing `./recall.ts` import block is untouched by this
  step; Task 24 Step 6 is the one that touches `recall.ts`'s own use of its constant.)

  In `scanRunOptions`, change `maxBudgetUsd: input.maxBudgetUsd,` to:

  ```ts
      maxBudgetUsd: input.maxBudgetUsd ?? SCAN_MAX_BUDGET_USD,
  ```

  In `applyRunOptions`, change `maxBudgetUsd: opts.maxBudgetUsd,` to:

  ```ts
      maxBudgetUsd: opts.maxBudgetUsd ?? APPLY_MAX_BUDGET_USD,
  ```

- [ ] **Step 5: Give the accept handler the three things it never had.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, find the accept handler with
  `grep -n "CH.worklogAccept" src/main/index.ts` and change its `applyProposal` call to:

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

  and add `APPLY_MAX_BUDGET_USD` to the existing import block from `./worklog/runner.ts` at the
  top of the file.

- [ ] **Step 6: Run everything and watch it pass.**
  `node scripts/verify-worklog-recall.mts` → `all pass`;
  `node scripts/verify-worklog-runner.mts` → `all pass`;
  `npm run typecheck` exits 0.

- [ ] **Step 7: Prove no ceiling shipped at a stand-in value.**

  ```bash
  grep -n "MAX_BUDGET_USD" src/main/worklog/recall.ts src/main/worklog/runner.ts
  ```

  Expected, exactly three declarations, all with a literal number and none of them 0:
  `RECALL_MAX_BUDGET_USD = 0.6`, `SCAN_MAX_BUDGET_USD = 0.3`, `APPLY_MAX_BUDGET_USD = 0.6`, plus
  the three `?? …` uses. If any declaration reads `= 0`, stop: recall aborts before its first turn
  and the failure is silent.

- [ ] **Step 8: Commit.**
  `git commit -m "Give the worklog's paid runs ceilings they fit inside"`
  Body records: recall was capped at $0.15, below what a connector-backed read of a real board
  costs, so it exhausted its budget before it could answer and the whole feature was dead
  regardless of configuration; `worklogAccept` called `applyProposal` with neither a budget nor the
  configured `claudePath`; and the two new ceilings are stated figures with a stated derivation
  rather than values awaiting a paid measurement, because the suite guarding them can only be
  meaningful if it is an absolute band.

---

### Task 24: Name budget exhaustion, so it stops arriving as "nothing to report"

Spec §2.4 records the failure that matters most: a run that ran out of money looks exactly like a
session with nothing worth logging.

**The refusal envelope is stated, not awaited.** Neither the `subtype` nor the result text of a
budget-exhausted run is a documented interface, so this task does not depend on either exact
string. It matches **defensively, on two independent stable signals** — the run reported an error,
*and* the word "budget" appears in the `subtype` or in the result text — and it ships one stated
`BUDGET_REFUSAL` fixture, written identically into both worklog suites, carrying a comment that
says it is the assumed shape and exactly what replaces it. `npm run measure:worklog -- budget`
(Task 22, optional) can replace both copies later; the assertions do not change when it does,
which is the point.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/agent.ts` (immediately after the
  `HeadlessError` class), `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts`
  (`RecallSnapshot`, `readExisting`), `/Users/thevinh/dev/personal/stoke/src/main/worklog/runner.ts`
  (after `WorklogParseError`, in `scanSession`, in `applyProposal`)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`,
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts`

**Interfaces:**
- Produces:
  - `export function isBudgetExhausted(result: Pick<HeadlessResult, 'isError' | 'subtype' | 'text'>): boolean`
    in `src/main/agent.ts`
  - `export class WorklogBudgetError extends Error` in `src/main/worklog/runner.ts`, with
    `readonly limitUsd: number` and `readonly costUsd: number | null`
  - `RecallSnapshot` gains `budget?: true`
- Consumes: nothing measured. `BUDGET_REFUSAL` is stated in Step 1 and repeated verbatim in Step 7.

**Where a failed *write* reaches the user, since this task is what makes it say something useful.**
`worklogAccept` already stores `errors.join('; ')` onto the proposal and sets `status: 'failed'`
(`src/main/index.ts`, the `q.update(id, { status: outcome.ok ? 'accepted' : 'failed', … })` call),
and `WorklogPanel.tsx:315-319` renders exactly that:
`{p.status === 'failed' && p.error && (<p className="field-hint" data-tone="warning">{p.error}</p>)}`.
So the write path needs no new surface — what it needed was for the string in `p.error` to say
*"stopped at its $0.60 budget ceiling"* instead of being an empty result, which is what Step 5
below delivers. Step 1's last two assertions are the regression cover for that sentence.

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-runner.mts`, before the closing summary
  lines. Add `isBudgetExhausted` to the `../src/main/agent.ts` import, and add both
  `WorklogBudgetError` and `applyProposal` to the `../src/main/worklog/runner.ts` import (the suite
  imports neither today — confirm with
  `grep -n "applyProposal\|WorklogBudgetError" scripts/verify-worklog-runner.mts`, which must print
  nothing before this step).

  ```ts
  console.log('\na run that ran out of money says so')

  /* The shape a budget-exhausted headless run returns. Neither string is a
     documented interface, which is why isBudgetExhausted is a substring test on
     both and not an equality test on either. This is the assumed envelope;
     `npm run measure:worklog -- budget` replaces both strings with the measured
     ones the first time anyone runs it, and the assertion below does not change.

     The identical block appears in scripts/verify-worklog-recall.mts. Keep the
     two byte-for-byte the same: two suites that disagree about what a refusal
     looks like is how one of them starts passing for the wrong reason. */
  const BUDGET_REFUSAL = {
    isError: true,
    subtype: 'error_max_budget_exceeded',
    text: 'Reached the maximum budget of $0.15 for this run.'
  }

  ok('a budget refusal is recognised', isBudgetExhausted(BUDGET_REFUSAL))
  ok(
    'the subtype alone is enough, in case the wording changes',
    isBudgetExhausted({ isError: true, subtype: 'error_max_budget_exceeded', text: '' })
  )
  ok(
    'and the text alone is enough, in case the subtype is renamed',
    isBudgetExhausted({ isError: true, subtype: 'error_during_execution', text: 'over budget' })
  )
  ok(
    'a plain failure is not mistaken for one',
    !isBudgetExhausted({ isError: true, subtype: 'error_during_execution', text: 'the tool failed' })
  )
  ok(
    'and a success never is, whatever it happens to mention',
    !isBudgetExhausted({ isError: false, subtype: 'success', text: 'I stayed within budget.' })
  )
  ok(
    'the fixture is a real envelope, not an unfilled marker',
    !/[<>]/.test(BUDGET_REFUSAL.subtype) && !/[<>]/.test(BUDGET_REFUSAL.text),
    `${BUDGET_REFUSAL.subtype} / ${BUDGET_REFUSAL.text}`
  )

  {
    const budgeted = (async () => BUDGET_REFUSAL_RESULT) as never
    const out = await applyProposal(proposal(), { run: budgeted })
    ok(
      'a write that hit the ceiling says which ceiling',
      /budget/i.test(Object.values(out.errors).join(' ')),
      JSON.stringify(out.errors)
    )
    ok(
      'and names the figure, because that is the part the user can act on',
      Object.values(out.errors).join(' ').includes('$0.60'),
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

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-runner.mts`
  Expected: `SyntaxError: The requested module '../src/main/agent.ts' does not provide an export
  named 'isBudgetExhausted'`.

- [ ] **Step 3: Recognise a budget refusal.** In
  `/Users/thevinh/dev/personal/stoke/src/main/agent.ts`, add immediately after the `HeadlessError`
  class:

  ```ts
  /**
   * Did this run stop because it ran out of money, rather than fail?
   *
   * A budget-exhausted run exits non-zero but still prints a result envelope, and
   * both its `subtype` and its result text mention 'budget'. agent.ts already
   * keeps that envelope on purpose — "a non-zero exit that still printed a result
   * envelope is a real answer about a real failure (budget exceeded, a tool
   * denied)".
   *
   * Both are matched because neither is a documented interface, and the cost of
   * guessing wrong is the failure spec §2.4.4 describes: budget exhaustion
   * arriving as "nothing to report". The subtype is a string somebody else owns
   * and can rename; the text is the part the user is shown. Matching either is
   * how this keeps working when one of them changes.
   *
   * `isError` is still required. Without it a successful run whose answer merely
   * mentions a budget — "I stayed within budget." — would be reported as a budget
   * failure, and that is a worse lie than the one this function exists to stop.
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
  class:

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

  and add `isBudgetExhausted` to the existing `../agent.ts` import at the top of the file.

- [ ] **Step 5: Raise it from both runs.** In `scanSession`, replace the `if (result.isError)`
  block — find it with `grep -n "The worklog scan failed" src/main/worklog/runner.ts` — with:

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

  In `applyProposal`, replace the `if (result.isError) { throw … }` block — the one whose fallback
  message is `'the run reported an error'` — with:

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

  The surrounding `catch` already records `err.message` into `errors[target]`; `worklogAccept`
  already joins those into `p.error` and sets `status: 'failed'`; and `WorklogPanel.tsx` already
  renders `p.error` for a failed proposal — locate it with
  `grep -n "p.status === 'failed' && p.error" src/renderer/src/components/WorklogPanel.tsx`. So
  this one sentence *is* the whole of the write path's error reporting, and it now names the
  ceiling, which is what Step 1's *"and names the figure"* assertion pins. No new surface is
  needed and none is added.

- [ ] **Step 6: Mark a budget-starved recall as such.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/recall.ts`, add to `RecallSnapshot` after
  `error?: string`:

  ```ts
    /**
     * The read stopped at its budget ceiling. A separate flag from `error`
     * because it is the one failure with a fix the user can act on, and because
     * it is what the scan report turns into the outcome `budget`.
     */
    budget?: true
  ```

  and replace the `if (result.isError)` block in `readExisting` — the one whose fallback message is
  `'the recall run reported an error'` — with:

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

  adding `isBudgetExhausted` to the existing `../agent.ts` import at the top of the file.

- [ ] **Step 7: Cover the recall side, with the same fixture.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-recall.mts`, before its closing lines.
  The `BUDGET_REFUSAL` block is repeated **byte-for-byte** from Step 1 rather than shared, because
  the two suites run independently and each has to state what it believes a refusal looks like —
  the comment is what keeps them in step:

  ```ts
  console.log('\na recall that ran out of money does not report an empty board')

  /* The shape a budget-exhausted headless run returns. Neither string is a
     documented interface, which is why isBudgetExhausted is a substring test on
     both and not an equality test on either. This is the assumed envelope;
     `npm run measure:worklog -- budget` replaces both strings with the measured
     ones the first time anyone runs it, and the assertion below does not change.

     The identical block appears in scripts/verify-worklog-runner.mts. Keep the
     two byte-for-byte the same: two suites that disagree about what a refusal
     looks like is how one of them starts passing for the wrong reason. */
  const BUDGET_REFUSAL = {
    isError: true,
    subtype: 'error_max_budget_exceeded',
    text: 'Reached the maximum budget of $0.15 for this run.'
  }

  {
    const refused: Runner = async () => ({
      ...BUDGET_REFUSAL,
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
    ok(
      'naming the ceiling it hit, not the cost it reached',
      (snap.error ?? '').includes('$0.60'),
      snap.error ?? ''
    )
    check('with no items, so nothing is claimed to exist', snap.items, {})
  }

  /* A recall that failed for any other reason is NOT flagged as a budget
     failure: `budget` is the flag the panel turns into "stopped early, here is
     the figure", and applying it to a broken connector would send the user to
     change a number that was never the problem. */
  {
    const broken: Runner = async () => ({
      text: 'The MCP server returned 502.',
      isError: true,
      subtype: 'error_during_execution',
      costUsd: 0.01,
      durationMs: 100,
      numTurns: 1,
      sessionId: null,
      permissionDenials: [],
      raw: {}
    })
    const snap = await readExisting({ ...BOARDS, run: broken }, 8)
    check('an ordinary failure is not flagged as a budget one', snap.budget, undefined)
    ok('and carries its own reason', /502/.test(snap.error ?? ''), snap.error ?? '')
  }
  ```

- [ ] **Step 8: Run everything and watch it pass.**
  `node scripts/verify-worklog-runner.mts` → `all pass`;
  `node scripts/verify-worklog-recall.mts` → `all pass`;
  `npm run typecheck` exits 0.

- [ ] **Step 9: Prove nothing shipped with a stand-in marker.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke
  grep -rn -- '<MEASURED>\|<DATE>\|<VERSION>\|<RECORDED\|<the ' src/ scripts/
  ```

  Expected: **no output**, exit code 1 from grep. This is the guard for the whole of Tasks 23 and
  24: three doc comments in `recall.ts`, `runner.ts` and `agent.ts` are the only record of where
  their constants came from, and an angle-bracket marker left in one of them is worse than no
  comment at all. If anything prints, the task is not finished.

- [ ] **Step 10: Commit.**
  `git commit -m "Tell budget exhaustion apart from having nothing to report"`
  Body records: a run that hit `--max-budget-usd` came back as `isError` with an envelope and every
  caller turned it into an empty result, so the feature's most common failure was
  indistinguishable from its normal quiet success (spec §2.4); the detection matches the word
  "budget" in either the subtype or the result text, because neither is a documented interface and
  the cost of matching too narrowly is that failure going silent again; and the fixture both
  suites carry is the assumed envelope, replaceable by `npm run measure:worklog -- budget` without
  changing a single assertion.

---

### Task 25: Every scan reports what it did

`index.ts` emits `worklogProposed` only `if (auto && added.length)`. A zero-result scan emits
nothing and an error is caught and dropped, so "working but nothing to report" and "never ran" are
the same from outside (spec §2.4.4).

**Scope, deliberately narrow.** This task changes `runWorklogScan`'s *contract* and nothing about
what it does: same transcript lookup, same group resolution, same recall call, same queue write.
The three behavioural changes inside it — the root-aware group, the boards threading, and the
budget-versus-nothing branch — are Task 26, so the diff of each can be read against one claim.
An earlier draft landed all five in one 75-line replacement and no reviewer could check any of
them.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (`runWorklogScan`, the AutoScanner
  `scan` callback, the `worklogScan` handler),
  `/Users/thevinh/dev/personal/stoke/src/preload/index.ts` (the `worklog` object),
  `/Users/thevinh/dev/personal/stoke/src/shared/api.ts` (the `worklog` block)
- Test: launch and read the report over CDP (there is no DOM test runner; `index.ts` imports
  electron and cannot be exercised under strip-types)

**Interfaces:**
- Consumes: `CH.worklogScanned` (`worklog:scanned`), `CH.worklogLastScan` (`worklog:lastScan`) from
  `src/shared/ipc.ts` (contracts Task 2); `type WorklogScanReport`, `type WorklogScanOutcome` from
  `@shared/types` (contracts Task 2); `WorklogBudgetError` from `./worklog/runner.ts` (Task 24);
  `scripts/cdp-eval.mjs` from contracts Task 5.
- Produces:
  - `async function runWorklogScan(sessionId: string, auto: boolean): Promise<WorklogScanReport>` —
    **never throws**
  - `let lastScanReport: WorklogScanReport | null` and `function reportScan(...)`, both module-level
    in `index.ts`
  - `window.stoke.worklog.lastScan(): Promise<WorklogScanReport | null>`
  - `window.stoke.worklog.onScanned(cb: (report: WorklogScanReport) => void): () => void`

- [ ] **Step 1: Add the record and the pusher.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, immediately above `runWorklogScan`'s doc
  comment (find it with `grep -n "One worklog scan, however it was asked for" src/main/index.ts`),
  insert:

  ```ts
  /** The last scan of any session, so a freshly-opened panel is not blank. */
  let lastScanReport: WorklogScanReport | null = null

  /** Record a report, push it, and hand it back to whoever asked for the scan. */
  function reportScan(report: WorklogScanReport): WorklogScanReport {
    lastScanReport = report
    send(CH.worklogScanned, report)
    return report
  }
  ```

  and add `WorklogScanOutcome` and `WorklogScanReport` to the `@shared/types` type import at the
  top of the file.

- [ ] **Step 2: Change the signature and the doc comment.** Replace `runWorklogScan`'s doc comment
  and its `async function runWorklogScan(sessionId: string, auto: boolean): Promise<number> {` line
  with:

  ```ts
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
  ```

  Everything from `const host = hostForSession(sessionId)` down to the function's closing brace is
  now inside that `try`. Re-indent it one level and leave every line of it otherwise **untouched**
  — including the `const group = …` line and the `recall({ clickupListId: CLICKUP_LIST_ID,
  notionDataSource: NOTION_DATA_SOURCE, … })` call. Task 26 changes those; doing it here would make
  Task 26's diff unreadable.

  **The `const group` line already reads three arguments, and that is correct.** Contracts Task 1
  Step 4a — which lands before every workstream task — changed it to

  ```ts
    const group = host ? host.label || host.alias : (groupForCwd(cwd, projects, settings.projectRoots) ?? '')
  ```

  Re-indent that line and change nothing in it. If what you find is
  `groupForCwd(cwd, projects)` with **two** arguments, contracts Task 1 has not landed and this task
  must not start. Confirm before you begin, one hit:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -c "settings\.projectRoots" src/main/index.ts
  ```

  Expected: `2`.

- [ ] **Step 3: Turn the two exits into reports.** Inside the `try`, replace the `if (!file)` throw
  with:

  ```ts
        if (!file) {
          return end(
            'error',
            0,
            host
              ? `could not read a transcript on ${host.label || host.alias} — the session may not have started Claude yet`
              : 'no transcript found for that session yet'
          )
        }
  ```

  and replace the function's final `return added.length` with:

  ```ts
        return end(added.length ? 'proposed' : 'nothing', added.length, null)
  ```

- [ ] **Step 4: Close the try, and catch everything.** After that `return`, close the `try` and add:

  ```ts
    } catch (err) {
      /*
       * Every ending is a report, including this one. The old code let the throw
       * out and both callers flattened it: the automatic path logged to a console
       * nobody has open and returned 0, and the button surfaced a bare string with
       * no record that a scan had happened at all.
       */
      if (err instanceof WorklogBudgetError) return end('budget', 0, err.message)
      return end('error', 0, err instanceof Error ? err.message : String(err))
    }
  }
  ```

  and add `WorklogBudgetError` to the existing import block from `./worklog/runner.ts` at the top
  of the file.

- [ ] **Step 5: Adapt the automatic caller.** Replace the AutoScanner options' `scan` callback
  (find it with `grep -n "scan: async (sessionId)" src/main/index.ts`) with:

  ```ts
      scan: async (sessionId) => {
        // runWorklogScan no longer throws; the report is the record of what
        // happened and has already been pushed to the renderer by the time this
        // returns. AutoScanner only needs the count for its own prompt.
        const report = await runWorklogScan(sessionId, true)
        return report.added
      },
  ```

- [ ] **Step 6: Adapt the button's caller, and add the pull.** Replace the `worklogScan` handler
  (find it with `grep -n "CH.worklogScan," src/main/index.ts`) with:

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

- [ ] **Step 7: Expose it on the bridge.** In
  `/Users/thevinh/dev/personal/stoke/src/preload/index.ts`, the `worklog` object currently ends:

  ```ts
      onProposed: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogProposed, cb)
    },
  ```

  Make it read exactly:

  ```ts
      onProposed: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogProposed, cb),
      lastScan: () => ipcRenderer.invoke(CH.worklogLastScan),
      onScanned: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogScanned, cb)
    },
  ```

  — a comma appears after `onProposed`, and the new last member carries none. Task 28 Step 4
  extends this same object again and repeats the pattern; getting the commas wrong here is a build
  error there.

  In `/Users/thevinh/dev/personal/stoke/src/shared/api.ts`, add to the `worklog` block, before its
  closing brace:

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

- [ ] **Step 8: Typecheck and build.**
  `npm run typecheck` exits 0, then `npm run check` exits 0.

- [ ] **Step 9: See a real report.** `npm run build`, then launch
  `npx electron . --remote-debugging-port=9222` and open a session in any folder. From another
  shell:

  ```bash
  node scripts/cdp-eval.mjs "(async () => { const [s] = await window.stoke.worklog.watch(); const r = await window.stoke.worklog.scan(s ? s.sessionId : ''); const last = await window.stoke.worklog.lastScan(); return { returned: r, outcome: last && last.outcome, auto: last && last.auto } })()"
  ```

  Expected: `{"returned":{"added":0,"error":null},"outcome":"nothing","auto":false}` for a session
  with nothing worth logging — the numbers vary, the shape does not, and `outcome` must be one of
  `"proposed"`, `"nothing"`, `"budget"` or `"error"`. Before this task, `lastScan` did not exist
  and a scan that proposed nothing logged nothing at all.

  (`window.stoke.worklog.watch()` is Task 28's; if it has not landed yet, substitute the session id
  from the open tab. Nothing else in this step depends on it.)

- [ ] **Step 10: Commit.**
  `git commit -m "Report every worklog scan, including the ones that found nothing"`
  Body records: `worklogProposed` fired only when an automatic scan added something, and every error
  was caught and dropped, so a feature that had never run and a feature working quietly looked
  identical — which is why nobody could tell the recall budget had been killing it all along.

---

### Task 26: The scan reads the configured boards, places remote sessions, and says when it could not afford to look

Three edits inside the function Task 25 just stabilised. Each is one edit with one claim, which is
the whole reason they are not in Task 25.

**Order, and who owns the group line.** Contracts Task 1 Step 4a already made
`groupForCwd(cwd, projects, settings.projectRoots)` three-argument at both of `index.ts`'s call
sites; it lands before every workstream task. So Step 1 below is **not** where the scan becomes
root-aware — that shipped with contracts Task 1 — and its anchor is the three-argument line. What
Step 1 adds is the comment that states the two different placement rules, remote and local, which
the next reader of this function needs and which nothing in the code says. Steps 2–4 are the two
behavioural changes: the configured boards, and budget-versus-nothing.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (`runWorklogScan` only)
- Test: CDP, plus `npm run check`

**Interfaces:**
- Consumes: `RecallSnapshot.budget` (Task 24 Step 6); `RecallOptions.targets` (Task 18);
  `ScanInput.boards` (Task 20); `groupForCwd(cwd, projects, roots?)` (contracts Task 1) — **already
  called with all three arguments here** by contracts Task 1 Step 4a; this task neither adds nor
  removes an argument.
- Produces: no new names. `runWorklogScan` can now return `outcome: 'budget'` from a recall that
  was starved as well as from a scan that was.

- [ ] **Step 1: State the two placement rules, over the root-aware call contracts Task 1 landed.**
  In `runWorklogScan`, replace this single line — which is what the file holds at this point, at the
  one-level-deeper indentation Task 25 Step 2 gave it, and which you can locate with
  `grep -n "const group = host" src/main/index.ts`:

  ```ts
        const group = host ? host.label || host.alias : (groupForCwd(cwd, projects, settings.projectRoots) ?? '')
  ```

  with:

  ```ts
        /*
         * Root-aware, and remote-aware, and those are two different rules.
         *
         * A remote session is placed by the machine it runs on: `SessionInfo.cwd`
         * for one is wherever Stoke happened to be pointed locally (CLAUDE.md
         * gotcha 18), so the folder rule would name the wrong project or none.
         * The line above already reads the true cwd out of the fetched transcript
         * for that reason — verify it, do not re-add it.
         *
         * A local session is placed by its folder, and by the scan roots too:
         * `/…/work` is itself a registered project on this machine, so the
         * longest-prefix rule answered `dev` for every sibling under it and 7 of
         * 12 work folders were never watched (spec §2.4.3). That third argument
         * is contracts Task 1 Step 4a's, not this task's — verify it is there,
         * do not re-add it.
         */
        const group = host
          ? host.label || host.alias
          : (groupForCwd(cwd, projects, settings.projectRoots) ?? '')
  ```

  The call is byte-for-byte the same call; only its formatting and the comment above it change.
  Confirm both, exactly:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    grep -c "Root-aware, and remote-aware" src/main/index.ts && \
    grep -c "settings\.projectRoots" src/main/index.ts
  ```

  Expected: `1`, then `2` — the comment is in, and the two call sites contracts Task 1 made
  root-aware are both still root-aware. `2` before this step as well; `0` means contracts Task 1
  never ran and this task must not start.

- [ ] **Step 2: Thread the configured boards into the read.** Replace the `recall({ … })` call with:

  ```ts
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
  ```

  `CLICKUP_LIST_ID` and `NOTION_DATA_SOURCE` are now unused in `index.ts`. Remove them from its
  import block from `./worklog/runner.ts` — `npm run typecheck` will name them if you do not.

- [ ] **Step 3: Thread the same boards into the write-up.** In the `scanSession({ … })` call
  immediately below, add `boards,` after `auto,`.

- [ ] **Step 4: Say when the read could not afford to happen.** Replace Task 25 Step 3's
  `return end(added.length ? 'proposed' : 'nothing', added.length, null)` with:

  ```ts
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
  ```

- [ ] **Step 5: Typecheck and check.**
  `npm run typecheck` exits 0, then `npm run check` exits 0.

- [ ] **Step 6: Prove the boards reached the run.** `npm run build`, launch
  `npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-26b`, open Settings and
  clear the **ClickUp list id** so only Notion is on (Task 21's control), start a session in a
  folder with a transcript, and scan it. Then:

  ```bash
  node scripts/cdp-eval.mjs "(async () => { const s = await window.stoke.settings.get(); const last = await window.stoke.worklog.lastScan(); return { targets: s.worklogBoards.targets, outcome: last && last.outcome } })()"
  ```

  Expected: `{"targets":["notion"],"outcome":"nothing"}` or `{"targets":["notion"],"outcome":"proposed"}`.
  Then read the terminal Stoke was launched from: it must **not** contain any `clickup_filter_tasks`
  or `clickup_get_list` in the recall's allowed tools. `rm -rf /tmp/stoke-26b` afterwards.

- [ ] **Step 7: Commit.**
  `git commit -m "Scan the boards the user configured, and say when the read could not be afforded"`
  Body records: the scan read both boards unconditionally and wrote up against compiled-in ids, so a
  Notion-only setup paid for a ClickUp read nothing would ever be written to; and a recall that hit
  its ceiling produced a scan reporting `nothing`, which is the failure spec §2.4.1 describes
  reaching the user as a success. Notes that the group line is only commented here — the scan roots
  reached `groupForCwd` in the commit that moved the rule into `src/shared/paths.ts`, and this
  commit must not be read as a second fix for the same 7-of-12 bug.
---

### Task 27: One predicate for "is this session the worklog's business", and why

The dot in the tab strip and the run that costs money must not be able to disagree. The rule also
has to answer *why*, because that is the field that separates "nothing to report" from "never ran".

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/worklog/watch.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (the Layout block's `worklog/` sub-list,
  Step 4a)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts` (append)

**Interfaces:**
- Consumes: `groupForCwd(cwd, projects, roots?)` and `isWatchedGroup(group, worklogGroups)` from
  `./gate.ts` (contract Task 1 gave `groupForCwd` its optional `roots`); `type Project`,
  `type WorklogWatchState` from `@shared/types`.
- Produces:
  - `export type WatchHost = Pick<SshHost, 'label' | 'alias' | 'worklog'>`
  - `export interface WatchInput { sessionId: string; cwd: string; host: WatchHost | null; projects: Project[]; roots: string[]; worklogGroups: string[]; now: number }`
  - `export function watchStateFrom(input: WatchInput): WorklogWatchState`

**Two names, at two layers, and the contract means both.** Contracts §0.3 asks for "one predicate,
not two". It is one *rule*, split across two layers so the rule itself is testable:

- `src/main/worklog/watch.ts` — `watchStateFrom(input: WatchInput): WorklogWatchState`. Pure, no
  I/O, the sole rule, exercised branch by branch by `scripts/verify-worklog-gate.mts`. **This
  task.**
- `src/main/index.ts` — `watchStateFor(sessionId)`, `watchStates()`, `sendWatchStates()`. Thin
  gatherers that read live settings, projects and hosts and call `watchStateFrom`. **Task 28.**

`watch.ts`, `watchStateFrom`, `WatchInput` and `WatchHost` are on the contracts' shared-module list
for exactly this reason: A Task 52 and C Task 30 both read the contract for the same seam, and a
rule that lives inline in a callback is a rule nothing can test — which is how the gate got the bug
spec §2.4.3 measured.

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
  import type { Project, SshHost, WorklogWatchState } from '@shared/types'

  /**
   * The part of an SSH host the gate reads.
   *
   * Declared as a Pick of SshHost rather than restated, because index.ts passes
   * hostForSession() straight in: if SshHost ever drops or renames one of these,
   * the typecheck fails here instead of the host gate silently widening.
   *
   * It resolves to `{ label: string; alias: string; worklog?: boolean }`. Only a
   * literal `true` in `worklog` switches a machine on.
   */
  export type WatchHost = Pick<SshHost, 'label' | 'alias' | 'worklog'>

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

- [ ] **Step 4a: List the new module in `CLAUDE.md`'s Layout block.** In
  `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, insert into the `worklog/` sub-list immediately
  after the `    gate.ts           which project groups are watched` line:

  ```
      watch.ts          the one predicate: is this session watched, and why not
  ```

  Four-space indent, matching its siblings under `worklog/`.
  Expected: `grep -cE "^    watch\.ts" CLAUDE.md` prints `1`.

- [ ] **Step 5: Commit.**
  `git commit -m "Give the worklog one predicate that says whether a session is watched, and why"`
  Body records: the rule lived inline in the AutoScanner callback in `index.ts`, where nothing
  could test it and no other surface could read it, so the app had no way to tell the user whether
  the session in front of them was being watched at all.

---

### Task 28: Wire the predicate in, and tell the renderer

**This task is a hard prerequisite of A Task 52**, whose acceptance criterion calls
`window.stoke.worklog.watch()` — the handler added in Step 4 below. **Step 4 is also the sole
writer of the `watch` / `onWatchChanged` members** in `src/shared/api.ts` and
`src/preload/index.ts`: A no longer adds them conditionally, because "the conflict resolves to one
copy" is not true of two agents editing one object literal. The snippets below are byte-for-byte
what goes in.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (the worklog block, the
  AutoScanner, `createWindow`'s window-load wiring, the projects handlers, `ptyStart`, the worklog
  handlers), `/Users/thevinh/dev/personal/stoke/src/preload/index.ts` (the `worklog` object),
  `/Users/thevinh/dev/personal/stoke/src/shared/api.ts` (the `worklog` block)
- Test: over CDP, against a running instance

**Interfaces:**
- Consumes: `watchStateFrom`, `type WatchHost` from `./worklog/watch.ts` (Task 27);
  `CH.worklogWatch` (`worklog:watch`), `CH.worklogWatchChanged` (`worklog:watchChanged`) from
  `src/shared/ipc.ts` (contracts Task 2); `onSettingsChanged` from `./store.ts`;
  `scripts/cdp-eval.mjs` from contracts Task 5.
- Produces:
  - `async function watchStateFor(sessionId: string): Promise<WorklogWatchState>`
  - `async function watchStates(): Promise<WorklogWatchState[]>`
  - `function sendWatchStates(): void`
  - `window.stoke.worklog.watch(): Promise<WorklogWatchState[]>`
  - `window.stoke.worklog.onWatchChanged(cb: (states: WorklogWatchState[]) => void): () => void`

**A known limit, closed by Task 33.** `watchStates()` iterates `sessionCwds.keys()`, and that map
is in memory only. Until Task 33 lands, a restart with resumed tabs leaves every session resolving
`cwd: ''` → `reason: 'unknown-folder'` → `watched: false`. Do not work around it here; Task 33
persists the map, which is the second half of the finding spec §2.4's closing note records.

- [ ] **Step 1: Add the two resolvers.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, add immediately below the
  `worklogQueue()` helper:

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
  `WorklogWatchState` to the type import from `@shared/types` at the top of the file.

  `hostForSession(sessionId)` returns `SshHost | null` and `WatchInput.host` is
  `WatchHost | null` — a `Pick` of the same interface (Task 27), so this is assignable with no cast
  and stays assignable only while `SshHost` keeps those three fields. That is the point of the
  `Pick`: a rename over there becomes a typecheck failure here rather than a gate that quietly
  stops gating.

- [ ] **Step 2: Make the money path use it.** Replace the AutoScanner's `watched` callback — find
  it with `grep -n "watched: async (sessionId)" src/main/index.ts` — with:

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

  In `createWindow`, immediately after the `watcher = new ContextWatcher(...)` block ends, add:

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

  Add `onSettingsChanged` to the existing `./store.ts` import at the top of the file.

  Replace the `ptyStart` handler — find it with `grep -n "CH.ptyStart" src/main/index.ts` — with:

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

  Then the three project handlers. A folder becoming a project, or a scan root appearing, changes
  which group a cwd resolves to. **Each gets exactly one call, immediately before the handler's
  final `return` and after whatever that handler persists** — never before an early
  `if (!win) return null`, which has changed nothing, and never before a `setSettings` whose result
  the recomputation needs to see.

  - `CH.projectsAddRoot` (`index.ts:483`): insert `sendWatchStates()` on the line above its
    `return dir`.
  - `CH.projectsAdd` (`index.ts:498`): insert `sendWatchStates()` on the line above its
    `return res.canceled ? null : (res.filePaths[0] ?? null)`, so the handler's last two lines read

    ```ts
        sendWatchStates()
        return res.canceled ? null : (res.filePaths[0] ?? null)
    ```

    **D Task 36 Step 1 replaces this whole handler and quotes those two lines back**, so this is
    the byte-for-byte text it expects to find.
  - `CH.projectsHide` (`index.ts:511`): its one statement is `return setSettings({ hiddenProjects: next })`.
    Split it so the write happens first:

    ```ts
        const saved = setSettings({ hiddenProjects: next })
        sendWatchStates()
        return saved
    ```

    Order matters here and nowhere else in this step: `sendWatchStates()` calls `getSettings()`
    synchronously, so placed above the write it would recompute against the settings the user just
    changed away from and push the previous answer.

  > **Cross-workstream note, and it has bitten once already.** D Task 36 Step 1 **replaces** the
  > whole `CH.projectsAdd` handler. C runs before D, so D's replacement text must carry
  > `sendWatchStates()` immediately before its own `return dir`, and D's new `CH.projectsMeta`
  > handler must call it too — flipping `addedManually` changes which group a cwd resolves to.
  > Task 36 states both, and its quoted "before" text carries the `sendWatchStates()` line this
  > step adds — confirm it does before starting it; if it does not, trigger 3 has been silently
  > dropped for the one handler that can create a project out of thin air.

- [ ] **Step 4: Add the handler and the bridge.** In the worklog handler block, next to
  `ipcMain.handle(CH.worklogQueue, …)`, add:

  ```ts
    ipcMain.handle(CH.worklogWatch, () => watchStates())
  ```

  In `/Users/thevinh/dev/personal/stoke/src/preload/index.ts`, the `worklog` object ends — after
  Task 25 Step 7 — with:

  ```ts
      onScanned: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogScanned, cb)
    },
  ```

  Make it read exactly:

  ```ts
      onScanned: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogScanned, cb),
      watch: () => ipcRenderer.invoke(CH.worklogWatch),
      onWatchChanged: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogWatchChanged, cb)
    },
  ```

  **No trailing comma on the last member** — that is the byte-for-byte text, and it is what A Task
  52 Step 1's grep checks for rather than writing its own copy.

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

  This is the **only** place either file gains these two members. A Task 52 Step 1 verifies them
  with `grep -n "onWatchChanged" src/shared/api.ts src/preload/index.ts`, which must print both
  files; if it does not, this task has not landed and A Task 52 cannot start.

- [ ] **Step 5: Typecheck and run the suites.**
  `npm run typecheck` exits 0, then `npm run check` exits 0.

- [ ] **Step 6: Prove the root fallback works on the real machine.** This is the fix worth
  measuring, because spec §2.4.3 established it by measurement: 5 of 12 work subfolders were
  watched. Launch `npx electron . --remote-debugging-port=9222`, make sure Settings ›
  Worklog agent has the profile covering `work` ticked and that `/Users/thevinh/dev/work` is a
  scan root (spec §6 asks for exactly that repair), then start a session in a `work` subfolder that
  has no Claude history of its own. Then:

  ```bash
  node scripts/cdp-eval.mjs "(async () => (await window.stoke.worklog.watch()).map((s) => ({ watched: s.watched, reason: s.reason, group: s.group, remote: s.remote })))()"
  ```

  Expected, with that one session open:
  `[{"watched":true,"reason":"watched-group","group":"work","remote":false}]`. Before this task the
  same folder resolved to group `dev` and `watched: false`.

  Now prove trigger 2 — a settings write, with nothing else touched. Leave this running in one
  shell:

  ```bash
  node scripts/cdp-eval.mjs "new Promise((resolve) => { const off = window.stoke.worklog.onWatchChanged((s) => { off(); resolve(s.length) }) })"
  ```

  It blocks. Untick that profile in Settings; the command must return `1` — the push arrived
  without a session starting, a project being added or the window reloading.

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
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/WorklogPanel.tsx` (`Props`, the
  head of the returned element, the empty state),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the worklog state, the bootstrap
  subscription effect, the `<WorklogPanel …/>` element),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (immediately after the
  `.worklog-note` rule)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts` (the sentences are
  pure), then CDP for the rendering

**Interfaces:**
- Consumes: `window.stoke.worklog.watch()`, `.onWatchChanged()`, `.lastScan()`, `.onScanned()`
  (Tasks 25 and 28); `type WorklogWatchState`, `type WorklogScanReport` from `@shared/types`;
  `relativeTime` from `../lib/format`; `scripts/cdp-eval.mjs` from contracts Task 5.
- Produces:
  - `export function watchSentence(state: WorklogWatchState | null, watchedGroups: string[]): string`
    in `src/shared/worklog.ts`
  - `export function scanSentence(report: WorklogScanReport): string` in `src/shared/worklog.ts`
  - `WorklogPanel` props gain `watch: WorklogWatchState | null`, `watchedGroups: string[]`,
    `lastScan: WorklogScanReport | null`
  - **App.tsx's `worklogWatch` / `worklogLastScan` state and its two subscriptions.** **Step 7** is
    the sole writer of these — Step 6 edits `WorklogPanel.tsx` and touches no App state.
    A Task 52 reuses `worklogWatch` through a `useMemo` and declares no
    state and no subscription of its own — two `const offWatch` in the one bootstrap effect is a
    hard redeclaration error, and two App-level copies of the same list is exactly the drift the
    contract's "whole list, never a delta" rule exists to prevent.

- [ ] **Step 1: Give the gate suite an `ok()` helper — first, before any assertion.**
  `scripts/verify-worklog-gate.mts` defines only `check(name, got, want)`. This task calls
  `ok(name, condition, detail)` eleven times and Task 30 calls it again in the same file, so
  without this the suite dies with `ReferenceError: ok is not defined` before a single assertion
  runs — and it is chained into `npm run check`, so it takes `check` down with it.

  Insert this immediately beneath the existing `check` function in
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts`, copied byte-for-byte from
  `scripts/verify-worklog-recall.mts` so the two suites report identically:

  ```ts
  function ok(name: string, condition: boolean, detail = ''): void {
    if (!condition) failures++
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
  }
  ```

  Then `node scripts/verify-worklog-gate.mts` → `all pass`, unchanged: the helper is unused so far,
  which is the point — it lands on its own so the failure in Step 3 is the missing export and
  nothing else.

- [ ] **Step 2: Write the failing assertions.** Append to
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

- [ ] **Step 3: Run it and watch it fail.**
  `node scripts/verify-worklog-gate.mts`
  Expected: `SyntaxError: The requested module '../src/shared/worklog.ts' does not provide an
  export named 'watchSentence'`.

- [ ] **Step 4: Write the two sentences.** Append to
  `/Users/thevinh/dev/personal/stoke/src/shared/worklog.ts`.

  **Do not open the appended block with a second `import type … from './types'`.** Contracts Task 2
  Step 2 already wrote one at the top of this file; ESM would hoist a mid-file duplicate and it
  would work, but the module would then have two import statements from one specifier and the next
  appender copies the pattern. Instead, **merge the two names into the existing import**, so the
  first line of `src/shared/worklog.ts` reads:

  ```ts
  import type { WorklogBoards, WorklogScanReport, WorklogTarget, WorklogWatchState } from './types'
  ```

  Then append, with no import of its own:

  ```ts
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

- [ ] **Step 5: Run it and watch it pass.**
  `node scripts/verify-worklog-gate.mts` → `all pass`.

- [ ] **Step 6: Show it in the panel.** In
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

  and replace the `{proposals.length > 0 && (<p className="worklog-note">…</p>)}` block — find it
  with `grep -n "worklog-note" src/renderer/src/components/WorklogPanel.tsx` — with:

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

  and in the empty state — the `<p>` beginning "A scan reads a session's transcript", found with
  `grep -n "A scan reads" src/renderer/src/components/WorklogPanel.tsx` — replace the long `<p>`
  with:

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

- [ ] **Step 7: Feed it from App.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add next to the other worklog state
  (find it with `grep -n "const \[worklogBusy" src/renderer/src/App.tsx`):

  ```ts
    /*
     * Which sessions the worklog may look at, keyed by session id. Pushed whole
     * on every change rather than merged, because a delta and a full list cannot
     * both be the source of truth.
     *
     * ONE copy, App-wide. The tab strip's watched-session dots (A Task 52) read
     * this array through a useMemo rather than subscribing again: a second
     * subscription in the same effect is a `const offWatch` redeclaration, and a
     * second copy of the list is the drift the whole-list rule exists to stop.
     */
    const [worklogWatch, setWorklogWatch] = useState<WorklogWatchState[]>([])
    const [worklogLastScan, setWorklogLastScan] = useState<WorklogScanReport | null>(null)
  ```

  In the bootstrap subscription effect (find it with
  `grep -n "const offWorklog = window.stoke.worklog.onChange" src/renderer/src/App.tsx`) add:

  ```ts
      const offWatch = window.stoke.worklog.onWatchChanged(setWorklogWatch)
      const offScanned = window.stoke.worklog.onScanned(setWorklogLastScan)
      void window.stoke.worklog.watch().then(setWorklogWatch)
      void window.stoke.worklog.lastScan().then(setWorklogLastScan)
  ```

  and add `offWatch()` and `offScanned()` to that effect's cleanup return alongside the existing
  `offWorklog()`. **This is the only place either subscription is created.**

  Pass them to the `<WorklogPanel …/>` element:

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

- [ ] **Step 8: Style it.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add immediately after the
  `.worklog-note` rule — find it with
  `grep -n "^\.worklog-note {" src/renderer/src/styles/app.css`:

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

  (`--space-*` and `--lh-*` are declared by contracts Task 4, which is a prerequisite of this
  whole part. Do not reintroduce `--sp-*`: F Task 64 deletes that block and its perl sweep will
  not know about a rule added afterwards.)

- [ ] **Step 9: See it render.** `npm run typecheck` exits 0, then `npm run build`, then launch
  `npx electron . --remote-debugging-port=9222` and open a session and the worklog panel. With
  nothing ticked in Settings › Worklog agent:

  ```bash
  node scripts/cdp-eval.mjs "[...document.querySelectorAll('.worklog-state-line')].map((n) => n.textContent.slice(0, 40))"
  ```

  Expected: `["Nothing is watched yet. Tick a profile u","No session has been scanned since Stoke "]`.

  Now tick the profile covering the open session's folder in Settings — without reopening the
  panel — and run:

  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.worklog-state-line').getAttribute('data-tone')"
  ```

  Expected: `"on"`. Before this task the panel had no such line at all, and a queue with nothing in
  it looked identical whether the agent was watching and quiet, switched off, or dying on its
  budget every run.

- [ ] **Step 10: Commit.**
  `git commit -m "Let the worklog panel say whether it is watching this session, and what it last did"`
  Body records: the panel could not distinguish "watching and quiet", "switched off" and "dying on
  its budget every run", and neither could the user — spec §2.4.4.

---

### Task 30: The title-bar button shows disarmed, watching or badged

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/worklog.ts` (append),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (the `worklogCount`
  prop declaration and the worklog button in `.titlebar-actions`),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the `<TitleBar …>` element),
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (immediately after the
  `.icon-btn[aria-pressed='true']` rule)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts` (the rule is pure),
  then CDP for the attribute

**Interfaces:**
- Consumes: `type WorklogWatchState` from `@shared/types`; `worklogWatch`, the single App-level
  watch list from Task 29 Step 7; `scripts/cdp-eval.mjs` from contracts Task 5.
- Produces:
  - `export type WorklogButtonState = 'disarmed' | 'watching' | 'badged'`
  - `export function worklogButtonState(states: WorklogWatchState[], pending: number): WorklogButtonState`
  - `TitleBar` gains the prop `worklogState: WorklogButtonState`; the button renders
    `data-worklog={worklogState}`.

**Precedence, stated once so two surfaces cannot disagree.** Contracts §0.3 is amended to this
ordering, and A reads the same contract for the tab-strip signal:

1. `badged` when the queue holds one or more `status: 'pending'` proposals. **This outranks
   everything, including the feature being switched off** — the button is the only route back to
   the queue, so turning the agent off must not hide proposals the user has not ruled on.
2. `watching` when any state has `watched === true`.
3. `disarmed` in every remaining case, including when there are no states at all.

**File ordering:** C runs before A, so this task's edit to `TitleBar.tsx` lands before A Task 54
re-indents the tab `map`. The two regions do not overlap — this one is in `.titlebar-actions` —
but locate the button by its quoted JSX rather than by a line number all the same.

- [ ] **Step 1: Write the failing assertions.** First confirm Task 29's fixture is present — these
  assertions call it and do **not** re-declare it:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -c "^function state(" scripts/verify-worklog-gate.mts
  ```

  Expected: `1`. If it prints `0`, Task 29 has not landed — stop, because this task's assertions
  will not compile. If it prints `2`, a previous run already appended this block; do not append it
  twice.

  Then append to
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
   * A pending proposal outranks the switch. A queue holding work the user has
   * not decided on must be reachable even after they switch every profile off —
   * otherwise turning the feature off hides three real proposals with no way
   * back to them. Contracts §0.3 states this ordering, and the tab strip reads
   * the same contract.
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
  `worklogCount` prop declaration — find it with
  `grep -n "worklogCount" src/renderer/src/components/TitleBar.tsx` — with:

  ```ts
    /** Proposals awaiting review. Shown in the tooltip; the badge comes from worklogState. */
    worklogCount: number
    /** disarmed / watching / badged — see worklogButtonState. */
    worklogState: WorklogButtonState
    worklogOpen: boolean
  ```

  add `worklogState` to the destructured parameters, add
  `import type { WorklogButtonState } from '@shared/worklog'` to the imports, and replace the
  worklog button — the `<button className="icon-btn">` in `.titlebar-actions` that wraps
  `<IconPin />` and `Toggle worklog review` — with:

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

  `worklogWatch` is the array Task 29 Step 7 declared — this task adds no state and no
  subscription. Add `import { worklogButtonState } from '@shared/worklog'`, and in the
  `<TitleBar …>` element replace
  `worklogCount={worklog.filter((p) => p.status === 'pending').length}` with:

  ```tsx
          worklogCount={worklogPending}
          worklogState={worklogState}
  ```

- [ ] **Step 7: Style it.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add immediately after the
  `.icon-btn[aria-pressed='true']` rule — find it with
  `grep -n "icon-btn\[aria-pressed" src/renderer/src/styles/app.css`:

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

  and add `position: relative;` to the `.icon-btn` rule (find it with
  `grep -n "^\.icon-btn {" src/renderer/src/styles/app.css`) so the dot has something to anchor to.

- [ ] **Step 8: Measure it over CDP.** `npm run typecheck` exits 0, then `npm run build`, then
  launch `npx electron . --remote-debugging-port=9222`. With nothing ticked in Settings and an
  empty queue:

  ```bash
  node scripts/cdp-eval.mjs "({ state: document.querySelector('[data-worklog]').getAttribute('data-worklog'), dot: getComputedStyle(document.querySelector('[data-worklog]'), '::after').width })"
  ```

  Expected: `{"state":"disarmed","dot":"auto"}` — no `::after` box is generated, so the computed
  width has no length. Tick the profile covering the open session's folder in Settings and re-run:
  `{"state":"watching","dot":"auto"}`. Scan a session so the queue holds a pending proposal and
  re-run: `{"state":"badged","dot":"6px"}`.

  Then screenshot the title bar — the terminal beside it is a WebGL canvas, so a screenshot is the
  only thing that proves the strip still renders (gotcha 5):

  ```bash
  node scripts/cdp-eval.mjs --shot /tmp/stoke-worklog-button.png
  ```

  Open the image and confirm the button is visible in all three states and the dot sits inside its
  top-right corner rather than clipping the button's edge.

- [ ] **Step 9: Commit.**
  `git commit -m "Say on the title bar whether the worklog is armed, watching or holding something"`
  Body records: the button looked identical whether the agent was disarmed, watching or sitting on
  three unreviewed proposals; and that the badge uses the accent rather than red, because red in
  the strip now means exactly one thing.

---

### Task 31: The auto-scanner can read and write its own state

`autoscan.ts` holds every baseline in memory, so a restart re-baselines every session (spec §2.4,
closing note). A resumed session then has to accumulate six *fresh* messages before it can ever be
scanned, and the hourly ceiling resets with the app — which is a spending control that anyone can
clear by quitting.

**This task lands the halves that can be tested on their own:** the disk module, the two new
options, the `restored` map the constructor fills, and `snapshot()`. Task 32 lands the four call
sites that consume them. Split because an earlier draft changed the options, the constructor,
`observe`, added `snapshot()` and `save()`, and edited two call sites in `index.ts` in one step —
six claims in one diff, none of them separately reviewable.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscanStore.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscan.ts` (`AutoScannerOptions`,
  the class fields, the constructor, and one new method beside `state()`)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-autoscan.mts` (append)

**Interfaces:**
- Produces:
  - `export interface StoredActivity { sessionId: string; scannedMessages: number; lastScanAt: number; mutedUntil: number }` (in `autoscan.ts`)
  - `export interface AutoScanSnapshot { sessions: StoredActivity[]; recentScans: number[] }` (in `autoscan.ts`)
  - `AutoScannerOptions` gains `restore?: () => AutoScanSnapshot | null` and
    `persist?: (snapshot: AutoScanSnapshot) => void`
  - `AutoScanner.snapshot(): AutoScanSnapshot`
  - `export const AUTOSCAN_STATE_FILENAME: string`,
    `export function autoScanStateFile(userDataDir: string): string`,
    `export function readAutoScanState(file: string): AutoScanSnapshot`,
    `export function writeAutoScanState(file: string, snapshot: AutoScanSnapshot): void`
    (in `autoscanStore.ts`)
- Consumes: `HOUR_MS` and `MAX_TRACKED`, both already exported by `autoscan.ts`.

**`evict()` is not touched, here or in Task 32.** Its `MAX_TRACKED` bound already caps the live map, and
the constructor caps the restored one with the same constant before a single entry reaches it — so
a state file from a long-running install cannot grow the map past what the live one is allowed. One
bound, applied at both doors.

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

  and `AutoScanSnapshot` to the type import from `../src/main/worklog/autoscan.ts`. Then the block:

  ```ts
  console.log('\nthe file the state survives in')
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
    writeAutoScanState(file, {
      sessions: [{ sessionId: '', scannedMessages: 1, lastScanAt: 0, mutedUntil: 0 }],
      recentScans: ['x' as never]
    })
    check('and junk is dropped rather than restored', readAutoScanState(file), {
      sessions: [],
      recentScans: []
    })
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('\nwhat the scanner offers up to be written')
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
      restore: () => ({ sessions: [], recentScans: [...spent, NOW - 2 * HOUR_MS] })
    })
    // Two readings, because the first sets the baseline. Without the second this
    // session is 'too-little-work', which autoScanVerdict answers *before* it
    // ever looks at the hourly ceiling — so the assertion below would pass for
    // entirely the wrong reason.
    scanner.observe('s1', 40, NOW - cfg.idleMs - 1)
    scanner.observe('s1', 40 + cfg.minNewMessages, NOW - cfg.idleMs - 1)
    check(
      'the hourly ceiling survives a restart',
      autoScanVerdict(scanner.state('s1')!, NOW, scanner.snapshot().recentScans, cfg),
      { scan: false, reason: 'hourly-limit' }
    )
    check(
      'scans older than an hour are not carried forward',
      scanner.snapshot().recentScans.length,
      DEFAULT_AUTOSCAN.maxPerHour
    )
    check(
      'and nothing is ever offered up mid-scan',
      scanner.snapshot().sessions.every((s) => !('scanning' in s)),
      true
    )
    scanner.dispose()
  }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-autoscan.mts`
  Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscanStore.ts'`.

- [ ] **Step 3: Create the disk half.** Create
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

- [ ] **Step 4: Run it again, and watch the second half fail.**
  `node scripts/verify-worklog-autoscan.mts`
  Expected: the three "the file the state survives in" cases print `PASS`, then
  `TypeError: scanner.snapshot is not a function`. The disk half is done; the scanner half is not.

- [ ] **Step 5: Declare the stored shape and the two options.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscan.ts`, add above `AutoScannerOptions`:

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

  and to `AutoScannerOptions`, after `now?`:

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

- [ ] **Step 6: Restore in the constructor, and offer a snapshot.** In the same file, add the field
  beside the others:

  ```ts
    /** Baselines from the last run, consumed the first time each session is seen. */
    private readonly restored = new Map<string, StoredActivity>()
  ```

  extend the constructor to:

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

  and add, next to `state()`:

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
  ```

- [ ] **Step 7: Run it and watch it pass.**
  `node scripts/verify-worklog-autoscan.mts` → `all pass`, then `npm run typecheck` exits 0.

- [ ] **Step 8: Commit.**
  `git commit -m "Give the auto-scanner a state file it can be handed and asked for"`
  Body records: the hourly ceiling and every baseline lived in memory, so quitting the app cleared
  a spending control; this lands the file format and the two seams — the module never imports
  electron, so the whole rule stays exercisable under strip-types, and `scanning` is deliberately
  absent from the stored shape because a stored claim would leave a session permanently
  unscannable (CLAUDE.md gotcha 20).

---

### Task 32: The state is actually restored, and actually written

The four call sites Task 31 left out. Each one is where a rule meets the state file, and each is
one edit.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscan.ts` (`observe`'s first-sight
  branch, `evaluate`'s `!watched` branch, `run`'s `finally`, and one new private method),
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (the `AutoScanner` construction)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-autoscan.mts` (append), then the
  file on disk

**Interfaces:**
- Consumes: everything Task 31 produced. Adds no new exported name.

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-autoscan.mts`, before its closing
  lines:

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
    /* `lastScanAt` is set one millisecond past the cooldown, so this session is
       eligible on every rule except the one being tested. A more recent value
       would make the verdict below 'cooldown' and prove nothing about baselines. */
    const restored: AutoScanSnapshot = {
      sessions: [
        { sessionId: 's1', scannedMessages: 100, lastScanAt: NOW - cfg.cooldownMs - 1, mutedUntil: 0 }
      ],
      recentScans: [NOW - 1000]
    }
    const scanner = new AutoScanner({
      enabled: () => true,
      watched: () => true,
      scan: async () => 0,
      now: () => NOW,
      restore: () => restored
    })
    scanner.observe('s1', 140, NOW - cfg.idleMs - 1)
    check(
      'a restored baseline is not overwritten by the first reading',
      scanner.state('s1')?.scannedMessages,
      100
    )
    check(
      'and the last scan time comes back with it',
      scanner.state('s1')?.lastScanAt,
      NOW - cfg.cooldownMs - 1
    )
    check(
      'so the 40 messages written before the restart still count as new work',
      autoScanVerdict(scanner.state('s1')!, NOW, [], cfg),
      { scan: true }
    )

    scanner.observe('s2', 12, NOW - cfg.idleMs - 1)
    check('a session nobody stored still baselines on first sight', scanner.state('s2')?.scannedMessages, 12)
    scanner.dispose()
  }

  console.log('\nand when it is written down')
  {
    /* A muted session is a state change worth keeping: without the write, a
       restart un-mutes every session the gate just turned away. */
    const writes: AutoScanSnapshot[] = []
    const scanner = new AutoScanner({
      enabled: () => true,
      watched: () => false,
      scan: async () => 0,
      now: () => NOW,
      persist: (s) => writes.push(s)
    })
    // Two readings again: the first is the baseline, the second is the work that
    // makes this session a scan candidate at all.
    scanner.observe('s1', 40, NOW - cfg.idleMs - 1)
    scanner.observe('s1', 40 + cfg.minNewMessages, NOW - cfg.idleMs - 1)
    await scanner.evaluate()
    check('muting a session writes the state out', writes.length >= 1, true)
    ok(
      'and what it wrote has the session muted, not claimed',
      writes.at(-1)!.sessions.some((s) => s.sessionId === 's1' && s.mutedUntil > NOW),
      JSON.stringify(writes.at(-1))
    )
    scanner.dispose()
  }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-autoscan.mts`
  Expected: `FAIL  a restored baseline is not overwritten by the first reading` with
  `got 140, want 100`, and `FAIL  muting a session writes the state out` with `got false, want true`.

- [ ] **Step 3: Consume the restored baseline.** In
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/autoscan.ts`, replace the first-sight branch
  of `observe` — the `if (!found) { … }` block — with:

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

  `Math.min` rather than the stored value outright: a forked or truncated transcript can come back
  with fewer messages than the baseline claimed, and a baseline above the current count would make
  the session permanently unscannable.

- [ ] **Step 4: Add the writer.** In the same file, immediately below `snapshot()`:

  ```ts
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

- [ ] **Step 5: Call it at the two points that change the state.** In `evaluate`, the `if (!watched)`
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

  and in `run`, the `finally` becomes:

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

- [ ] **Step 6: Run it and watch it pass.**
  `node scripts/verify-worklog-autoscan.mts` → `all pass`.

- [ ] **Step 7: Wire it into the app.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, add above the `autoscan = new AutoScanner(`
  line:

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

- [ ] **Step 8: See the file appear.** `npm run check` exits 0. Then `npm run build` and launch
  `npx electron . --remote-debugging-port=9222` with a watched profile ticked, let one automatic
  scan run — a manual scan does not write this file; the automatic path does — then quit and:

  ```bash
  node -e "const s=require(require('os').homedir()+'/Library/Application Support/stoke (dev)/worklog-autoscan.json'); console.log(JSON.stringify({sessions:s.sessions.length, keys:Object.keys(s.sessions[0]??{}), recent:s.recentScans.length}))"
  ```

  Expected: `{"sessions":1,"keys":["sessionId","scannedMessages","lastScanAt","mutedUntil"],"recent":1}`
  — and **no** `scanning` key anywhere in it. Relaunch and confirm the same session is not
  immediately re-proposed.

  **The folder is `stoke (dev)`, lower-case, and that is not cosmetic.** `npx electron .` is an
  unpackaged run, so `app.getName()` falls back to `package.json`'s `name` field — `stoke`, since
  this project defines no `productName` there — and `src/main/index.ts:839-841` then appends ` (dev)`.
  Verified by running Electron against a one-line probe: `NAME=stoke`,
  `USERDATA=/Users/thevinh/Library/Application Support/stoke`. The **packaged** app is
  `Stoke`, capitalised, because electron-builder writes `productName: Stoke` into the bundle's
  `CFBundleName` — a different directory, holding the settings D Task 41 repairs. macOS's default
  APFS volume is case-insensitive so both spellings happen to resolve here, but the two profiles are
  genuinely different folders and only the `(dev)` one is written by this step.

- [ ] **Step 9: Commit.**
  `git commit -m "Keep the autoscan baselines and the hourly ceiling across a restart"`
  Body records: every baseline lived in memory, so quitting re-baselined each resumed session to its
  current message count and the work done just before the restart could never be logged; and the
  six-an-hour ceiling was cleared by quitting, which made it not a ceiling. `scanning` is
  deliberately never persisted — a stored claim would leave a session permanently unscannable
  (CLAUDE.md gotcha 20) — and the write happens after the claim is released for the same reason.

---

### Task 33: The session→folder map survives a restart too

Task 32 closed one half of spec §2.4's closing note — *"all autoscan state is in-memory
(`src/main/worklog/autoscan.ts:148`, `src/main/index.ts:69`) so a restart resets every baseline"*. This closes the other.
`src/main/index.ts:69`'s `sessionCwds` is still per-run, and Task 28 made it far more load-bearing than it
was: `watchStates()` iterates its keys, so after a restart with resumed tabs every session resolves
`cwd: ''` → `reason: 'unknown-folder'` → `watched: false`. The dot disappears, the scan the restored
baseline was preserved for never fires, and the panel's brand-new "is this thing on" sentence
reports *"No session is open, so there is nothing to scan"* about sessions that are still running.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/worklog/sessionStore.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` (`launchSession`, and the boot
  wiring beside Task 32's `restore`)
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (the Layout block's `worklog/` sub-list,
  Step 7a)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-autoscan.mts` (append), then CDP

**Interfaces:**
- Produces, in `src/main/worklog/sessionStore.ts`:
  ```ts
  export interface StoredSession { sessionId: string; cwd: string; hostId: string | null; at: number }
  export function sessionStateFile(userDataDir: string): string
  export function readSessionState(file: string): StoredSession[]
  export function writeSessionState(file: string, sessions: StoredSession[]): void
  export const MAX_STORED_SESSIONS = 200
  export const STORED_SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
  ```
- Consumes: `Settings.hosts` (the `SshHost[]` field `hostForSession` already reads);
  `scripts/cdp-eval.mjs` from contracts Task 5. Imports no electron, so the suite can run it.

- [ ] **Step 1: Write the failing assertions.** Append to
  `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-autoscan.mts`, before its closing
  lines, adding:

  ```ts
  import {
    MAX_STORED_SESSIONS,
    STORED_SESSION_MAX_AGE_MS,
    readSessionState,
    sessionStateFile,
    writeSessionState,
    type StoredSession
  } from '../src/main/worklog/sessionStore.ts'
  ```

  and the block:

  ```ts
  console.log('\nwhich folder each session was started in, across a restart')
  {
    const dir = mkdtempSync(join(tmpdir(), 'stoke-sessions-'))
    const file = sessionStateFile(dir)

    const local: StoredSession = { sessionId: 's1', cwd: '/Users/x/work/api', hostId: null, at: NOW }
    const remote: StoredSession = { sessionId: 's2', cwd: '/srv/app', hostId: 'h-1', at: NOW }
    writeSessionState(file, [local, remote])
    check('it round-trips', readSessionState(file), [local, remote])
    check(
      'a local session keeps a null host rather than losing the field',
      readSessionState(file)[0].hostId,
      null
    )

    writeSessionState(file, [
      { ...local, at: NOW - STORED_SESSION_MAX_AGE_MS - 1 },
      { ...remote, at: NOW }
    ])
    check(
      'a record older than the age limit is dropped on read',
      readSessionState(file, NOW).map((s) => s.sessionId),
      ['s2']
    )

    const many: StoredSession[] = Array.from({ length: MAX_STORED_SESSIONS + 20 }, (_, i) => ({
      sessionId: `s${i}`,
      cwd: '/x',
      hostId: null,
      at: NOW - i * 1000
    }))
    writeSessionState(file, many)
    const trimmed = readSessionState(file, NOW)
    check('the list is capped', trimmed.length, MAX_STORED_SESSIONS)
    check('and it is the newest that are kept', trimmed[0].sessionId, 's0')

    for (const junk of ['{', '[]', 'null', '[1,2,3]', '[{"cwd":"/x"}]']) {
      writeFileSync(file, junk, 'utf8')
      check(`junk (${junk}) reads back as an empty list`, readSessionState(file, NOW), [])
    }

    rmSync(dir, { recursive: true, force: true })
  }
  ```

  Add `writeFileSync` to the `node:fs` import Task 31 Step 1 introduced.

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-worklog-autoscan.mts`
  Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/Users/thevinh/dev/personal/stoke/src/main/worklog/sessionStore.ts'`.

- [ ] **Step 3: Create the module.** Create
  `/Users/thevinh/dev/personal/stoke/src/main/worklog/sessionStore.ts`:

  ```ts
  import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
  import { dirname, join } from 'node:path'

  /**
   * Which folder each session was started in, kept across a restart.
   *
   * `index.ts`'s `sessionCwds` map is how the worklog places a session at all —
   * `watchStates()` iterates its keys and `watchStateFor` reads its values — and
   * it lived only in memory. A restart with resumed tabs therefore made every
   * running session resolve to an empty cwd, so `reason` came back
   * 'unknown-folder', the tab dot vanished, and the panel said "No session is
   * open" about sessions that were still running (spec §2.4, closing note).
   *
   * Deliberately a sibling of autoscanStore.ts rather than part of it: one file
   * carries the scanner's spending state and this one carries an address book,
   * and a corrupt address book must not cost the hourly ceiling.
   *
   * Imports no electron, so scripts/verify-worklog-autoscan.mts exercises it.
   */

  export const SESSION_STATE_FILENAME = 'worklog-sessions.json'

  /**
   * How many sessions to carry forward.
   *
   * 200 keeps the JSON under about 20 KB on a machine with long paths, and it is
   * far more sessions than the auto-scanner's ceiling of six an hour can ever act
   * on. The cap exists so a long-lived install does not carry years of ids into a
   * list the panel renders one row per entry of.
   */
  export const MAX_STORED_SESSIONS = 200

  /**
   * How long a session stays worth remembering.
   *
   * Fourteen days is the longest gap over which resuming a session and still
   * calling it the worklog's business is plausible. Past that the transcript is
   * a different piece of work wearing the same id.
   */
  export const STORED_SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

  export interface StoredSession {
    sessionId: string
    /** The session's own working directory — the remote one for an SSH session. */
    cwd: string
    /** `SshHost.id`, or null when the session is local. */
    hostId: string | null
    /** Epoch ms this record was last written. */
    at: number
  }

  export function sessionStateFile(userDataDir: string): string {
    return join(userDataDir, SESSION_STATE_FILENAME)
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v)
  }

  function session(v: unknown): StoredSession | null {
    if (!isRecord(v)) return null
    const sessionId = typeof v.sessionId === 'string' ? v.sessionId : ''
    const cwd = typeof v.cwd === 'string' ? v.cwd : ''
    // Both or nothing: a record with no id addresses no session, and one with no
    // folder is exactly the state this file exists to prevent.
    if (!sessionId || !cwd) return null
    return {
      sessionId,
      cwd,
      hostId: typeof v.hostId === 'string' && v.hostId ? v.hostId : null,
      at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0
    }
  }

  /**
   * Never throws. A file that cannot be read is an empty list.
   *
   * `now` is a parameter so the age rule is testable against a clock the suite
   * controls, the same way autoscan.ts takes its own.
   */
  export function readSessionState(file: string, now = Date.now()): StoredSession[] {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // Missing (the normal first run) or corrupt. Both mean nothing to restore.
      return []
    }
    if (!Array.isArray(raw)) return []
    return raw
      .map(session)
      .filter((s): s is StoredSession => s !== null && now - s.at < STORED_SESSION_MAX_AGE_MS)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_STORED_SESSIONS)
  }

  /** Temp file + rename, matching store.ts, so a crash mid-write cannot truncate it. */
  export function writeSessionState(file: string, sessions: StoredSession[]): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(sessions, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      console.error('[stoke] failed to persist the session folders', err)
    }
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  `node scripts/verify-worklog-autoscan.mts` → `all pass`.

- [ ] **Step 5: Seed both maps at boot.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, beside Task 32's `autoscanState` line,
  add:

  ```ts
    const sessionState = sessionStateFile(app.getPath('userData'))
    /*
     * Put the last run's sessions back before anything asks which are watched.
     *
     * A host the user has since deleted is dropped rather than carried: a
     * remembered SshHost would keep gating a machine that is no longer in
     * Settings, and the per-host worklog switch is an opt-in that has to be
     * revocable by deleting the host.
     */
    for (const s of readSessionState(sessionState)) {
      sessionCwds.set(s.sessionId, s.cwd)
      if (!s.hostId) continue
      const host = getSettings().hosts.find((h) => h.id === s.hostId)
      if (host) sessionHosts.set(s.sessionId, host)
    }
  ```

  with `import { readSessionState, sessionStateFile, writeSessionState } from './worklog/sessionStore.ts'`
  beside the other worklog imports.

- [ ] **Step 6: Write on every session start.** In `launchSession`, replace the two lines that
  record the session:

  ```ts
    if (cwd) sessionCwds.set(result.sessionId, cwd)
    if (opts.host) sessionHosts.set(result.sessionId, opts.host)
  ```

  with:

  ```ts
    if (cwd) sessionCwds.set(result.sessionId, cwd)
    if (opts.host) sessionHosts.set(result.sessionId, opts.host)
    /*
     * Synchronous, and after both maps are updated — CLAUDE.md gotcha 20's shape.
     * Nothing awaits between the update and the write, so what lands on disk is
     * always a state some pass could actually have observed. One write per
     * session start is a handful a day; this is not a hot path.
     */
    writeSessionState(
      sessionStateFile(app.getPath('userData')),
      [...sessionCwds.entries()].map(([sessionId, dir]) => ({
        sessionId,
        cwd: dir,
        hostId: sessionHosts.get(sessionId)?.id ?? null,
        at: Date.now()
      }))
    )
  ```

  (`readSessionState` caps and ages the list on the way back in, so nothing has to trim it here.)

- [ ] **Step 7: Prove it over CDP.** `npm run check` exits 0, then `npm run build` and launch
  `npx electron . --remote-debugging-port=9222`. Start a session in a folder whose group is ticked
  in Settings › Worklog agent, then:

  ```bash
  node scripts/cdp-eval.mjs "(async () => (await window.stoke.worklog.watch()).map((s) => ({ watched: s.watched, reason: s.reason })))()"
  ```

  Expected: `[{"watched":true,"reason":"watched-group"}]`.

  Now quit Stoke entirely, relaunch it, and **before opening or resuming any tab** run the same
  command. Expected: `[{"watched":true,"reason":"watched-group"}]` again. Before this task the same
  command returned `[]`, and the panel said "No session is open, so there is nothing to scan".

- [ ] **Step 7a: List the new module in `CLAUDE.md`'s Layout block.** In
  `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, insert into the `worklog/` sub-list immediately
  after the `    watch.ts          the one predicate: is this session watched, and why not` line
  C Task 27 Step 4a added:

  ```
      sessionStore.ts   session -> folder/host, on disk, so a restart keeps placing them
  ```

  Four-space indent, matching its siblings under `worklog/`.
  Expected: `grep -cE "^    sessionStore\.ts" CLAUDE.md` prints `1`.

- [ ] **Step 8: Commit.**
  `git commit -m "Remember which folder each session was started in, across a restart"`
  Body records: `watchStates()` iterates `sessionCwds`, so a restart made every resumed session
  unplaceable — `reason: 'unknown-folder'`, the watch dot gone from tabs that were still running,
  and the panel reporting no session open while one was; the map is capped at 200 entries and 14
  days so a long-lived install does not carry years of ids into a list the panel renders; and a
  host deleted from Settings is dropped on read rather than restored, because a per-host opt-in has
  to be revocable.

---

## Workstream D — folders, metadata and emoji

Design spec §4.D and §2.5. Eight tasks, 34–41.

**These tasks assume contracts Tasks 1, 2, 3, 4 and 5 have already landed.** They import
`src/shared/paths.ts` (Task 1), the `ProjectMeta` type, the three new `Project` fields and the
`CH.projectsMeta` channel (Task 2), and `src/main/settingsSchema.ts` with `projectMeta` hydration
(Task 3). Nothing here re-declares any of that.

**Interfaces for the whole part:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5. Tasks 36 and 38 measure through it; no
  task here creates it, and no task here writes its own probe.
- Consumes: `sendWatchStates()` in `src/main/index.ts` from C Task 28 Step 3. D runs after C, and
  Task 36's replacement `projectsAdd` handler must carry that call — see Task 36 Step 1.

**Where this part sits, and what that means for CSS.** D runs after C and B, and **before**
workstream F. Contracts Task 4 *declares* the `--space-*`, `--lh-*`, `--icon-*`, `--chevron`,
`--control-h` and `--surface-selected` tokens alongside the existing `--sp-*` block and changes no
existing declaration; the `--sp-*` sweep is F Task 64, which has not run yet. So when D's tasks
edit `app.css`: **every new rule uses `--space-*`, and existing `var(--sp-*)` uses are left alone**
for F Task 64's single pass to migrate. Do not migrate a `--sp-*` here — F Task 64's guard counts
them, and a partial migration spread across two workstreams is exactly the thing that guard exists
to make impossible.

> **Line numbers in this part are hints, not addresses.** Four workstreams insert
> into `src/renderer/src/App.tsx`, `src/renderer/src/styles/app.css`,
> `src/main/index.ts`, `src/renderer/src/components/TitleBar.tsx`,
> `src/renderer/src/components/Sidebar.tsx` and four verify suites, so any figure
> written as "currently line N" is correct only for the first task that runs.
> **Locate every edit by the quoted text**, not by the number: for CSS, by the
> selector (`grep -n "^\.project-meta {" src/renderer/src/styles/app.css`); for
> TS/TSX, by a unique quoted line from the block being replaced; for the verify
> suites, by **that suite's own** closing summary/exit pair — the five shapes are listed in
> Global Constraints, and `verify-context.mts`, `verify-color.mts` and `verify-worklog-retry.mts`
> each differ from the rest — inserting immediately above it. If the
> quoted text is not found, stop — a prerequisite task has not landed or has
> landed differently, and guessing at the location is how two parts silently
> overwrite each other.

**Why this order.** The rules come first and the wiring second, because that is the only split that
can be tested at all: `src/main/index.ts` imports `electron`, so an IPC handler can never be run by
a verify suite, whereas `src/main/projects.ts` imports none and can. So Task 34 puts every decision
("which folder does this record belong to", "does adding a folder un-hide it", "what does a
synthetic project look like") into one electron-free module with a suite, Task 35 wires it into
`listProjects` — which is the step that makes an added folder actually appear — and Task 36 reduces
the two IPC handlers to glue over already-tested functions. The UI (43, 44) needs `Project.emoji`
to already be populated or there is nothing to render. Tasks 39 and 40 are independent bug fixes
that share the same root cause as the rest of the workstream (a path rule that is wrong on APFS,
and a candidate list written for one Windows machine) and can be done in any order relative to
Tasks 34–38. Task 41 is last on purpose: it is the machine repair, and its `--verify` mode asserts its own
success through the gate, which only reads correctly once the scan root is right. That verifier is
the one thing in this workstream that is **not** chained into `npm run check`, because it reads this
machine's live settings file — see Task 41's preamble.

---

---

### Task 34: The folder-metadata rules, in a module a suite can run

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/main/projectMeta.ts`
- Create: `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/settingsSchema.ts` — Step 4a only: delete the
  private `tidy` contracts Task 3 inlined and import this module's instead
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` — the `scripts` block. In the tree as it
  stands today `verify:profiles` is line 17 and `check` is line **27**; both move as earlier tasks
  insert their own suites, so locate them with `grep -n '"verify:profiles"' package.json` and
  `grep -n '"check"' package.json` (one hit each) rather than by the number.
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` — the verify-suite block and the Layout
  block (Step 6a)

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
/** The trim caps. Exported because settingsSchema.ts's hydrateProjectMeta calls
 *  tidy() rather than restating them — one implementation, two suites. */
export const MAX_EMOJI_CHARS = 16
export const MAX_LABEL_CHARS = 64
/** Trim, cap and drop-if-empty one metadata record. */
export function tidy(meta: ProjectMeta): ProjectMeta | null
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

  The `mkdirSync`, `mkdtempSync`, `rmSync`, `tmpdir` and `join` imports are unused until Task 35
  adds the `listProjects` block; leave them, `scripts/` is in neither tsconfig `include` so nothing
  reports them.

- [ ] **Step 2: Run it and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/verify-folders.mts`
  Expected:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/main/projectMeta.ts' imported from /Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts`

- [ ] **Step 3: Create the module.** Write
  `/Users/thevinh/dev/personal/stoke/src/main/projectMeta.ts`.

  First establish which of the two states the tree is in:

  ```bash
  \
    ls src/main/projectMeta.ts 2>/dev/null; \
    grep -n "function tidy\|from './projectMeta.ts'" src/main/settingsSchema.ts
  ```

  Contracts Task 3 landed a **private, inline** `tidy` inside `settingsSchema.ts` — returning
  `ProjectMeta | null`, with the 16 and 64 written as literals — precisely because this module did
  not exist yet, so the expected output is *no* `projectMeta.ts` and a `function tidy` hit in
  `settingsSchema.ts`. If some earlier run created a stub `projectMeta.ts` as well, **replace its
  contents** with the module below rather than adding a second one; everything below is a superset
  of what a caps-and-`tidy` stub can contain. Step 4a deletes the inline copy either way, and there
  must be exactly one pair of caps in `src/` when this task ends.

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
   * The trim caps.
   *
   * Exported, and `settingsSchema.ts`'s `hydrateProjectMeta` imports `tidy` from
   * here rather than restating either number. Two copies of the same magic
   * number in two files, with a comment in one asserting they agree, is how the
   * store and the patch end up capping at different lengths and nothing fails.
   *
   * 16 characters of emoji, because a single glyph can be a ZWJ sequence of six
   * code points plus variation selectors; 64 of label, because it is a sidebar
   * row and anything longer is ellipsised into meaninglessness anyway.
   */
  export const MAX_EMOJI_CHARS = 16
  export const MAX_LABEL_CHARS = 64

  /**
   * Trim and cap one record the same way `hydrateSettings` will on the way to
   * disk — because `hydrateSettings` calls this very function — so the patch a
   * caller gets back is byte-for-byte what ends up stored and a test can assert
   * on it.
   *
   * A record that says nothing is dropped rather than kept as `{}` — otherwise
   * the settings file accumulates an empty object for every folder that was ever
   * right-clicked.
   */
  export function tidy(meta: ProjectMeta): ProjectMeta | null {
    const out: ProjectMeta = {}
    if (typeof meta.emoji === 'string') {
      const emoji = meta.emoji.trim().slice(0, MAX_EMOJI_CHARS)
      if (emoji) out.emoji = emoji
    }
    if (typeof meta.label === 'string') {
      const label = meta.label.trim().slice(0, MAX_LABEL_CHARS)
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

- [ ] **Step 4a: Delete the inline copy, and prove there is exactly one pair of caps in the tree.**
  In `/Users/thevinh/dev/personal/stoke/src/main/settingsSchema.ts`, delete the private
  `function tidy(...)` contracts Task 3 inlined — find it with
  `grep -n "function tidy" src/main/settingsSchema.ts` — and add
  `import { tidy } from './projectMeta.ts'` beside the other relative imports. The call site inside
  `hydrateProjectMeta` does not change: it already reads
  `const entry = tidy(value as Partial<ProjectMeta>)` followed by `if (entry) out[key] = entry`,
  which is correct against this module's `ProjectMeta | null` return — `Object.keys(entry).length`
  would throw on the record that says nothing. Then:

  ```bash
  grep -rn "slice(0, 16)\|slice(0, 64)\|MAX_EMOJI_CHARS\|MAX_LABEL_CHARS" src/
  ```

  Expected: every hit is inside `src/main/projectMeta.ts`, and there are none in
  `src/main/settingsSchema.ts`. A `16` or a `64` left inside `hydrateProjectMeta` means two
  implementations of the same rule, `verify-settings.mts` and `verify-folders.mts` are testing two
  different things, and one of them can drift silently. Then re-run
  `npm run verify:settings` → `all pass`.

- [ ] **Step 5: Register the suite, by insertion — never by rewriting the `check` line.**
  In `/Users/thevinh/dev/personal/stoke/package.json`, add
  `"verify:folders": "node scripts/verify-folders.mts",` immediately after the `"verify:settings"`
  line, and **insert `&& npm run verify:folders` immediately after `npm run verify:settings`** inside
  the existing `check` value. Do not retype the whole `check` line: contracts Task 3 and workstream
  E have each inserted a suite into it by now, and a pasted "so the whole line now reads…" quotation
  silently deletes theirs.

  Then run this guard, which must print nothing and exit 0:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','usage','profiles','settings','folders','color','worklog-gate','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"
  ```

  `verify:tabs` is not in that list because A Task 55 has not run yet; A Task 55 Step 6 runs the full
  fifteen-suite guard.

- [ ] **Step 6: Run the whole check.** `npm run check` exits 0.

- [ ] **Step 6a: Document the new suite and the new module in `CLAUDE.md`.** In
  `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, insert into the verify-suite fenced block
  immediately after the `npm run verify:settings` line contracts Task 3 Step 7a added:

  ```
  npm run verify:folders        # folder metadata: trimming, caps, added folders, hide/pin
  ```

  and in the Layout block, immediately after the
  `  projects.ts       project + session discovery from Claude's own files` line:

  ```
    projectMeta.ts    per-folder emoji/label/added-by-hand, and the one pair of caps
  ```

  Expected: `grep -cE "verify:folders|projectMeta\.ts" CLAUDE.md` prints `2`.

- [ ] **Step 7: Commit.**
  `git commit -m "Give a folder somewhere to keep an emoji, a name and the fact you added it"`
  Body records: adding a folder was a no-op because there was no per-project metadata store and no
  source in `listProjects` that could represent a single explicitly added folder; and that adding a
  folder now un-hides it, because `hiddenProjects` is applied last and would otherwise filter the
  new record straight back out.

---

### Task 35: `listProjects` emits added folders and carries their metadata

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/projects.ts` — imports (lines 1-6), the
  `Project` literal inside `put` (lines 160-174), and the return block (lines 215-221)
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-folders.mts` — append a block
- Test: `node scripts/verify-folders.mts`

**Interfaces:**

*Consumes:* `applyProjectMeta`, `ProjectMetaOptions` (Task 34); `pathRulesFor` from
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

### Task 36: Persist the picked folder, and expose `projects:meta`

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/index.ts` — the `projectsAdd` handler
  (lines 498-505) and one new handler beside it
- Modify: `/Users/thevinh/dev/personal/stoke/src/preload/index.ts` — the `projects` block
  (lines 36-44)
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/api.ts` — the `projects` block
  (lines 112-122)
- Test: CDP evaluation against a running instance, through `scripts/cdp-eval.mjs`

**Interfaces:**

*Consumes:* `manualProjectPatch`, `projectMetaPatch` (Task 34); `CH.projectsMeta` = `'projects:meta'`
(contracts Task 2); `getSettings`, `setSettings` from `./store.ts`; `pathRulesFor` from
`../shared/paths.ts`; `sendWatchStates()` from `src/main/index.ts` (C Task 28 Step 3);
`scripts/cdp-eval.mjs` (contracts Task 5).

*Produces* — `src/shared/api.ts`, inside `projects`:
```ts
    /** Set or clear one folder's metadata. `null` deletes the record. */
    setMeta(path: string, meta: ProjectMeta | null): Promise<Settings>
```
`projects.open()` keeps its `Promise<string | null>` signature and gains the guarantee that the
returned path has been persisted.

- [ ] **Step 1: Persist the picked folder.** In
  `/Users/thevinh/dev/personal/stoke/src/main/index.ts`, replace the whole `projectsAdd` handler —
  locate it by `grep -n "CH.projectsAdd," src/main/index.ts` — the trailing comma matters, since
  bare `CH.projectsAdd` also matches the `CH.projectsAddRoot` handler fifteen lines above it —
  which at this point in the order reads:

  ```ts
  ipcMain.handle(CH.projectsAdd, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    sendWatchStates()
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ```

  **Note the `sendWatchStates()` line: it is C Task 28 Step 3's, not the original file's.** D runs
  after C, so that is what is in the file. If what you find is the two-line ending without it, C
  Task 28 has not landed — stop, and do not "restore" the handler to the pre-C shape.

  Replace it with:

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
    sendWatchStates()
    return dir
  })

  ipcMain.handle(CH.projectsMeta, (_e, path: string, meta: ProjectMeta | null) => {
    const next = setSettings(projectMetaPatch(getSettings(), path, meta, pathRulesFor(process.platform)))
    sendWatchStates()
    return next
  })
  ```

  **Both `sendWatchStates()` calls are load-bearing and neither is optional.** C Task 28 Step 3 made
  "the project list changed" one of the four triggers that push a fresh `WorklogWatchState[]` to the
  renderer, and it added the call to the *old* `projectsAdd` handler. Replacing the whole handler
  without carrying it forward silently drops trigger 3, and the symptom is not an error: the watch
  dot in the tab strip goes on reporting the previous answer until something else happens to fire.
  The new `CH.projectsMeta` handler needs it for the same reason — deleting a record whose
  `addedManually` was the only thing making a folder a project removes that project from the list
  the gate reads.

  Confirm before you start that the call exists to be carried:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "sendWatchStates" src/main/index.ts
  ```
  Expected: several hits, one of them inside the handler you are about to replace. If it prints
  nothing, C Task 28 has not landed — stop, because D runs after C.

- [ ] **Step 2: Import what that handler now uses.** In the same file, add to the import block:

  ```ts
  import { manualProjectPatch, projectMetaPatch } from './projectMeta.ts'
  import { pathRulesFor } from '../shared/paths.ts'
  ```

  and add `ProjectMeta` to the existing type-only `@shared/types` import.

- [ ] **Step 3: Bridge it.** In `/Users/thevinh/dev/personal/stoke/src/preload/index.ts`, add this
  line to the `projects` block after `pin` (line 42):

  ```ts
    setMeta: (path: string, meta: ProjectMeta | null) =>
      ipcRenderer.invoke(CH.projectsMeta, path, meta),
  ```

  and add `ProjectMeta` to the type-only import from `@shared/types` on line 5.

- [ ] **Step 4: Declare it.** In `/Users/thevinh/dev/personal/stoke/src/shared/api.ts`, add to the
  `projects` block after `pin` (line 120):

  ```ts
    /** Set or clear one folder's metadata. `null` deletes the record, which is
     *  also how a folder that exists only because it was added leaves the list. */
    setMeta(path: string, meta: ProjectMeta | null): Promise<Settings>
  ```

  and add `ProjectMeta` to that file's type import from `./types`.

- [ ] **Step 5: Typecheck.** `npm run typecheck` exits 0.

- [ ] **Step 6: Prove the bridge over CDP.** Build and launch against a throwaway profile, so this
  cannot disturb the real settings file:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && \
    npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp &
  ```

  Then, once the window is up:

  ```bash
  node scripts/cdp-eval.mjs "window.stoke.projects.setMeta('/tmp/stoke-cdp-fixture', { emoji: '🔥', addedManually: true }).then(s => s.projectMeta)"
  ```

  Expected output, on one line — `scripts/cdp-eval.mjs` has the page do the stringifying, so it
  prints compact JSON, never pretty-printed:

  ```
  {"/tmp/stoke-cdp-fixture":{"emoji":"🔥","addedManually":true}}
  ```

  Then clear it and confirm the delete path:

  ```bash
  node scripts/cdp-eval.mjs "window.stoke.projects.setMeta('/tmp/stoke-cdp-fixture', null).then(s => s.projectMeta)"
  ```

  Expected output: `{}`

- [ ] **Step 7: Prove the dialog persists, by hand.** With the same instance still running, click
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

- [ ] **Step 8: Commit.**
  `git commit -m "Actually keep the folder the Open dialog returned"`
  Body records: `projectsAdd` opened the picker and returned the path with no `setSettings` and no
  write, so choosing a folder did nothing at all (spec §2.5); and adds `projects:meta` as the one
  channel that both sets and clears a folder's record.

---

### Task 37: The emoji picker

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/ProjectMetaPicker.tsx`
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — insert a block
  immediately after the `.project:hover .project-pin, .project:focus-within .project-pin,
  .project-pin[aria-pressed='true']` rule (currently lines 779-783)
- Test: typecheck and build; the component is mounted in Task 38

**Interfaces:**

*Consumes:* `Project` and `ProjectMeta` from `@shared/types`; `IconFolder` from `./Icons`; the
tokens `--chevron`, `--icon-sm` and `--shadow-panel` (contracts Task 4); the
tokens `--space-4/8/12`, `--r-md`, `--r-sm`, `--surface`, `--surface-hover`, `--bg-sunken`,
`--border`, `--border-strong`, `--text`, `--text-muted`, `--text-faint`, `--accent`,
`--accent-soft`, `--danger`, `--shadow-panel`, `--z-dropdown`, `--dur-fast`, `--ease`,
`--fs-xs`, `--fs-sm` (existing) and `--icon-sm` (contracts Task 4).

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

  /* Exactly the chevron's box, from the same token, because the emoji is part of
     the title: the project's metadata line and its session list both align to
     this glyph's left edge, not to the text after it. F Task 68 measures that
     alignment against `.project-meta-picker`, and it is only correct while these
     two rules and `.project-chevron` all read `var(--chevron)`. */
  .project-emoji {
    --icon-size: var(--icon-sm);
    width: var(--chevron);
    height: var(--chevron);
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
  proves only that it compiles and the CSS parses; Task 38 renders it.

- [ ] **Step 5: Commit.**
  `git commit -m "Add a per-folder icon and display name that never touch the disk"`
  Body records: renaming the folder itself would move the encoded history directory Claude writes
  transcripts into, so the display name is a label over the top and the row's tooltip keeps showing
  the real path.

---

### Task 38: Render the icon and label in the sidebar

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx` — props
  (lines 9-34), the destructure (lines 36-56), the project row (lines 236-315)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — the `<Sidebar>` element
  (lines 689-720)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — Step 4 lands
  `.project-chevron`, `.project-pin` and `.project-meta-picker` here, in the same commit as the JSX
  that needs them so no intermediate commit has an unsized chevron. F Task 68 depends on these three
  rules already existing.
- Test: CDP measurement against a running instance

**Interfaces:**

*Consumes:* `ProjectMetaPicker`, `ProjectMetaPickerProps` (Task 37); `window.stoke.projects.setMeta`
(Task 36); `Project.emoji`, `Project.label`, `Project.addedManually` (Task 35); `--chevron`
(contracts Task 4); `scripts/cdp-eval.mjs` (contracts Task 5).

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
                          className="icon-btn project-chevron"
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

  **This task is the sole writer of the `.project-top` block.** Two inline `style={{ }}` objects go
  with it: the chevron's `width` / `height` / `rotate` / `transition`, and the pin's `width` /
  `height`. Both become CSS in Step 3a, in the same commit, so no intermediate commit ships an
  unsized chevron. The `width={12} height={12}` on `IconChevron` and `IconPin` stay for now — F Task
  69 removes every icon size attribute in one pass, and it anchors on those two quoted tags.

- [ ] **Step 3a: Land the three rules the new JSX needs.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, in the block Task 37 Step 2
  added (locate it by `grep -n "^\.project-meta-picker {" src/renderer/src/styles/app.css`), add
  these three rules immediately above `.project-meta-picker`:

  ```css
  /* The disclosure control's box, from the one token that names it. It was an
     inline style, which is exactly how it drifted apart from the metadata indent
     and the session list's guide rule — the two other rules that have to agree
     with it. */
  .project-chevron {
    width: var(--chevron);
    height: var(--chevron);
    transition: rotate var(--dur) var(--ease);
  }

  .project-chevron[aria-expanded='true'] {
    rotate: 90deg;
  }

  /* The pin stays out of the way until the row is hovered, focused, or pinned —
     otherwise it repeats down the whole list as pure noise. The opacity pair is
     already declared further down the file; this rule only carries the box the
     inline style used to. */
  .project-pin {
    width: 1.25rem;
    height: 1.25rem;
  }
  ```

  `--chevron: 1.125rem` is declared by contracts Task 4, not here. Confirm it:
  `grep -n -- "--chevron:" src/renderer/src/styles/app.css` must print exactly one hit, inside
  `:root`. If it prints none, contracts Task 4 has not landed and the chevron will render at 0×0.

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
  add **only** this one prop to the `<Sidebar>` element, immediately after the `onPin={...}` block
  (locate it by `grep -n "onPin={" src/renderer/src/App.tsx`). No other `<Sidebar>` prop is this
  task's: `openSessionIds` is F Task 67's and `onSelectProject` / `onToggleExpand` are A Task 60's.

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

  Expected: the two numbers are equal — e.g. `[1200,1200]` (compact, on one line: the probe has the
  page stringify the value). A `scrollWidth` larger than `innerWidth` means the popover is pushing
  the grid column wider instead of being clipped.

- [ ] **Step 8: Screenshot the sidebar.** With the popover open, capture the window and confirm by
  eye that the grid, the name field and the two buttons fit inside the sidebar column at the
  default 260px width. Quit the instance and `rm -rf /tmp/stoke-cdp`.

- [ ] **Step 9: Commit.**
  `git commit -m "Show a folder's icon and chosen name in the sidebar"`
  Body records: the icon slot is fixed width so a row with an emoji and a row without still line up,
  measured over CDP rather than reasoned about; and search now covers the label, because a renamed
  folder that cannot be found by the name on screen is worse than no rename.

---

### Task 39: `planProfile` compares folder names the way the filesystem does

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

- [ ] **Step 6: Delete the `isWin` binding.** `src/main/profiles.ts` uses `isWin` in exactly one
  place — the `sameFolderName(chosen, name, isWin)` call Step 5 has just changed to
  `sameFolderName(chosen, name, RULES.caseInsensitive)` — so the declaration is now dead. Delete the
  line:

  ```ts
  const isWin = process.platform === 'win32'
  ```

  Then confirm nothing else referenced it:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "isWin" src/main/profiles.ts
  ```
  Expected: nothing.

  `const child = join(chosen, name)` is **not** dead — the `create` branch still returns it — so it
  stays. `noUnusedLocals` is on, so finish with `npm run typecheck`, which exits 0.

- [ ] **Step 7: Run it and watch it pass.**
  `node scripts/verify-profiles.mts` → `all pass`.

- [ ] **Step 8: Commit.**
  `git commit -m "Plan a profile's folder the way the filesystem spells it"`
  Body records the bug: `planProfile` compared folder names case-sensitively on every non-Windows
  platform, so on case-insensitive APFS `planProfile('/Users/thevinh/dev', 'Work')` returned
  `reuse` with root `/Users/thevinh/dev/Work` — a casing that does not exist — and the app persisted
  it as a scan root. `planProfile` had no test at all before this.

---

### Task 40: A default working directory that exists on this machine

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
`src/main/index.ts:508` is untouched.

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

### Task 41: Repair this machine's scan root, and its worklog target

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/scripts/repair-work-root.mts`
- Test: the script's own `--verify` mode

**Interfaces:**

*Consumes:* `shouldWatch(cwd, projects, worklogGroups, roots?)` from `src/main/worklog/gate.ts`
(contracts Task 1 gave it the defaulted `roots` parameter); `hydrateSettings` from
`src/main/settingsSchema.ts` (contracts Task 3); `listProjects` from `src/main/projects.ts`
(Task 35); `DEFAULT_WORKLOG_BOARDS` from `@shared/worklog` (contracts Task 2).

*Produces:* a repo script, not a module. It is `.mts`, not `.mjs`, because it imports three `.ts`
modules and runs under node's strip-types mode like every `scripts/verify-*.mts`:
```
node scripts/repair-work-root.mts            # report what it would do, change nothing
node scripts/repair-work-root.mts --apply    # do it
node scripts/repair-work-root.mts --verify   # assert the outcome; non-zero if wrong
```

**`--verify` is deliberately NOT chained into `npm run check`.** It reads this machine's live
settings file and asserts on its contents, which fails on every other machine and would fail on this
one the moment a second scan root is added or ClickUp is switched on. `npm run check` must always
pass (CLAUDE.md), so `scripts/verify-folders.mts` keeps only tmpdir-built fixture cases: no
`homedir()`, no `existsSync('/Users/thevinh/dev/work')`, no `process.platform === 'darwin'` branch.
Everything machine-specific lives here.

- [ ] **Step 1: Write the repair, with its three refusals and its verifier.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/repair-work-root.mts`:

  ```ts
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
   * Three refusals, because both halves of getting this wrong are silent:
   *  - Stoke must not be running. It holds settings in memory and rewrites the
   *    whole file on the next setSettings, so an edit made underneath it is
   *    discarded without a word.
   *  - the folder being deleted must be empty, checked by reading it, dotfiles
   *    included. `rmdir` then refuses a second time on its own account.
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
  import { DEFAULT_WORKLOG_BOARDS } from '../src/shared/worklog.ts'
  import { listProjects } from '../src/main/projects.ts'
  import { hydrateSettings } from '../src/main/settingsSchema.ts'
  import { shouldWatch } from '../src/main/worklog/gate.ts'

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

    const real = hydrateSettings(JSON.parse(readFileSync(SETTINGS, 'utf8')))

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
    ok(
      'the worklog writes to Notion only',
      JSON.stringify(real.worklogBoards.targets) === JSON.stringify(['notion']),
      JSON.stringify(real.worklogBoards.targets)
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

  /* 1. Nothing may be holding the settings file. */
  let ps = ''
  try {
    ps = execFileSync('pgrep', ['-fl', 'Stoke'], { encoding: 'utf8' })
  } catch {
    ps = ''
  }
  const running = ps.split('\n').filter((l) => l.trim() && !l.includes('repair-work-root'))
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

  const roots: string[] = Array.isArray(settings.projectRoots) ? settings.projectRoots : []
  const nextRoots = [...new Set(roots.map((r) => (r === WRONG ? RIGHT : r)))]

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

  /* Back up beside the file, then temp + rename, matching store.ts's own write. */
  copyFileSync(SETTINGS, `${SETTINGS}.before-repair`)
  settings.projectRoots = nextRoots
  settings.worklogBoards = nextBoards
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
  `node scripts/repair-work-root.mts`
  Expected output:
  ```
    /Users/thevinh/dev/work/Work is empty.
    projectRoots:   ["/Users/thevinh/dev/work/Work"]
                ->  ["/Users/thevinh/dev/work"]
    worklogBoards:  {"targets":["notion"],"notionDataSource":"collection://368d3f2d-1f02-817c-b193-000b208e36bd","clickupListId":"901615258684"}
                ->  {"notionDataSource":"collection://368d3f2d-1f02-817c-b193-000b208e36bd","clickupListId":"901615258684","targets":["notion"]}

  Report only. Re-run with --apply to make these changes.
  ```
  The two `worklogBoards` lines may already agree — that is fine and is the point of reporting both:
  design §6 asks for a *state*, not a change, and a repair that only printed a diff would let "the
  default happens to say notion" stand in for "this machine is set to notion".
  If it prints `REFUSED: Stoke is running…`, quit Stoke and run it again. If it prints
  `REFUSED: … is not empty`, **stop** — design §6's assumption is wrong and the folder holds
  something; deal with the contents by hand before going on.

- [ ] **Step 3: Apply it.**
  `node scripts/repair-work-root.mts --apply`
  Expected: the same report lines, then `wrote …settings.json (backup at
  …settings.json.before-repair)`, `removed /Users/thevinh/dev/work/Work`, and `Done.`

- [ ] **Step 4: Verify the outcome.**
  `node scripts/repair-work-root.mts --verify`
  Expected: four `PASS` lines, a parenthesised `(N of N watched)` with the two numbers equal, and a
  final `all pass`, exit 0.

  If `every folder under the work root is watched` fails, the printed `got` names which folders and
  the cause is one of two things: either `projectRoots` was not repointed (re-run Step 3), or the
  gate's own rule is wrong for those folders — this assertion calls `shouldWatch` directly rather
  than through `index.ts`, so it is independent of whether C's call site passes
  `getSettings().projectRoots` yet.

  Spec §2.4.3 measured **5 of 12** before the repair.

- [ ] **Step 5: Confirm `verify:folders` stayed portable.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "homedir\|Application Support\|dev/work\|process.platform" scripts/verify-folders.mts
  ```
  Expected: nothing. `verify:folders` is chained into `npm run check`, which CLAUDE.md says must
  always pass; a machine-specific assertion in there fails on every other machine and on this one as
  soon as the configuration changes. All of it lives in `--verify` above. This is the rule stated
  under Global Constraints: `check` must pass on any machine that has ever run Claude Code, and
  `verify:context`'s dependence on `~/.claude/projects` is the single grandfathered exception —
  **no suite this plan adds or edits may become a second one.**

- [ ] **Step 6: Run the whole check.** `npm run check` exits 0.

- [ ] **Step 7: Commit.**
  `git commit -m "Repair the scan root that pointed at an empty folder, and pin the worklog to Notion"`
  Body records: `projectRoots` named `/Users/thevinh/dev/work/Work`, an empty directory a
  case-sensitive folder comparison on APFS could produce (fixed in Task 39); a scan root enumerates
  its children, so an empty one contributed nothing and 7 of the 12 work folders were never watched
  by the worklog. The repair is a script with three refusals rather than a paragraph of shell, and
  its `--verify` mode asserts the outcome — deliberately outside `npm run check`, because it reads
  this machine's live settings file and `check` has to pass on any machine that has ever run
  Claude Code.

---

## Workstream B — profiles follow tabs

Spec §4 B, plus §2.9. Six tasks, **42–47**.

**Prerequisites.** Tasks 1, 2 and 3 of
`docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md` must be finished first:
Task 1 creates `src/shared/paths.ts` and rewrites `src/main/worklog/gate.ts` over it, Task 2 adds
`Tab.hostId` and the new `Project` fields, and Task 3 extracts `hydrateSettings` into
`src/main/settingsSchema.ts` and creates `scripts/verify-settings.mts`. Every task below edits or
imports one of those files.

**Already done, do not re-apply.** The `.ts`-extension value import in `src/shared/profiles.ts`
(`import { foldGroup } from './paths.ts'` plus a bare `export { foldGroup }`) and the
`allowImportingTsExtensions` flag in
`tsconfig.web.json` and `tsconfig.json` are **contracts Task 1 Steps 5, 5a–5c**. They had to land
inside Task 1, because without them Task 1's own Step 6 (`node scripts/verify-profiles.mts` →
`all pass`) is unreachable and every suite that imports `src/shared/profiles.ts` is broken for the
whole window in between. Nothing in this workstream touches those three files' import machinery.

**Interfaces, workstream-wide.** Consumes: `scripts/cdp-eval.mjs` from contracts Task 5.

> **Line numbers in this part are hints, not addresses.** Four workstreams insert
> into `src/renderer/src/App.tsx`, `src/renderer/src/styles/app.css`,
> `src/main/index.ts`, `src/renderer/src/components/TitleBar.tsx`,
> `src/renderer/src/components/Sidebar.tsx` and four verify suites, so any figure
> written as "currently line N" is correct only for the first task that runs.
> **Locate every edit by the quoted text**, not by the number: for CSS, by the
> selector (`grep -n "^\.project-meta {" src/renderer/src/styles/app.css`); for
> TS/TSX, by a unique quoted line from the block being replaced; for the verify
> suites, by **that suite's own** closing summary/exit pair — the five shapes are listed in
> Global Constraints, and `verify-context.mts`, `verify-color.mts` and `verify-worklog-retry.mts`
> each differ from the rest — inserting immediately above it. If the
> quoted text is not found, stop — a prerequisite task has not landed or has
> landed differently, and guessing at the location is how two parts silently
> overwrite each other.

**Why this order.**

- **Task 42 first.** It puts the cwd→group→profile rule in `src/shared/paths.ts`, next to `groupForCwd`,
  where a plain node suite can exercise it. That is the decision in the shared contracts —
  share, not IPC — and it keeps `gate.ts`'s property that the rule is pure and testable with no
  app running.
- **Task 43** repairs `activeProfile` in hydrate. It comes before the writer, because the writer
  makes `activeProfile` change far more often than a person ever clicked it.
- **Task 44** fixes `deriveProfiles`. It must land before the wiring or the wiring looks broken on
  a fresh machine: measured against the live `~/.claude.json`, the derived list on this Mac is
  `['personal']` and nothing else — so activating a tab under `/Users/thevinh/dev/work` resolves
  group `work`, finds no profile covering it, and correctly does nothing at all.
- **Task 45** pins the gate's invariant *before* Task 46 introduces the coupling. `grep -rn
  activeProfile src/main/` returns exactly one hit today; after this workstream the chip moves by
  itself, and the one thing that must never start reading it is the worklog.
- **Task 46** wires it: activating a tab sets the profile.
- **Task 47** makes the switch legible. Measured: Ember's accent and Personal's are the same
  string, and Moss's accent sits 0.049 from Work's — closer than the palette's own two nearest
  swatches (0.083). So the accent cannot carry the signal on its own, and the status bar names the
  active profile instead.

---

---

### Task 42: Resolve a working directory to a profile, in a module both processes can use

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
- Produces, in `src/renderer/src/lib/projectProfile.ts`: two re-export lines and nothing else —
  `profileIdForCwd` + `GroupOwner` from `@shared/paths`, `profileFor` + `ResolvedProfile` from
  `@shared/profiles`. This is the import site the shared contracts named; the body lives in
  `paths.ts` so a plain node suite can reach it.
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5.

  Note on the parameter type: `profiles` is `GroupOwner[]`, **not** `ResolvedProfile[]`.
  `ResolvedProfile` and `ProfileConfig` both already carry `id: string` and `groups: string[]`, so
  they are structurally assignable to it and B Task 46 can pass `availableProfiles` straight in —
  while `paths.ts` stays a leaf module that `profiles.ts` imports rather than the other way round.

- [ ] **Step 1: Add the failing cases.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts`, find the line

  ```ts
  import type { ProfileConfig } from '../src/shared/types.ts'
  ```

  and replace it with

  ```ts
  import type { ProfileConfig, Project } from '../src/shared/types.ts'
  import { profileIdForCwd } from '../src/shared/paths.ts'
  ```

  Then insert this block immediately above the file's closing two lines — the
  `` console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`) `` and the
  `process.exitCode` assignment. Anchor on those two lines, never on a line number:

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
  export { profileFor, type ResolvedProfile } from '@shared/profiles'
  ```

  Those two `export` lines are the **whole** file body. Do not add a wrapper, a default argument or
  a memo: a second implementation in the renderer is exactly what §0.7 exists to prevent.

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

### Task 43: Repair `activeProfile` in hydrate

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

### Task 44: Stop the named profiles from suppressing everything else

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

### Task 45: Pin the invariant that nothing in main reads the chip

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

  That one file is the settings schema: it declares the default and, since Task 43, repairs the
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

### Task 46: The active tab decides the profile

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — the `@shared/profiles`
  import (line 15), one new import, and one new effect after the `activeProfile` memo (around
  lines 231-238).
- Test: a CDP measurement against the running app, through `scripts/cdp-eval.mjs`. There is no DOM
  test runner; per CLAUDE.md the app is launched with `--remote-debugging-port` and driven over CDP.

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5.
- Consumes: `profileIdForCwd(cwd, projects, roots, profiles, platform)` from
  `./lib/projectProfile` (Task 42); `foldGroup(value: string): string` from `@shared/profiles`;
  `Tab.hostId: string | null` (contracts Task 2); the existing `patchSettings`,
  `availableProfiles`, `projects`, `projectsLoading`, `settings`, `tabs`, `activeTabId`,
  `platform` locals in `App.tsx`.
- Produces: no new exports. `settings.activeProfile` gains a second writer.

- [ ] **Step 1: Build and launch with the debugger open.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && npx electron . --remote-debugging-port=9222
  ```

  Leave it running. An unpackaged run uses its own `stoke (dev)` userData (`src/main/index.ts:839-841`), so
  nothing measured here touches the installed app's settings.

- [ ] **Step 2: Measure the defect.** Use `scripts/cdp-eval.mjs` — contracts Task 5's probe, the
  only one in this plan. There is no throwaway script; do not write one.

  In the running app, start two sessions in two different groups — in the sidebar, open
  `/Users/thevinh/dev/personal/stoke` and press Start, then open a folder under
  `/Users/thevinh/dev/work` and press Start. Click the first tab, then run:

  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.profile-chip[aria-pressed=\"true\"]')?.textContent ?? 'none'"
  ```

  Click the second tab and run it again. Expected **both times**: the same value — whatever chip
  was pressed before you started, `"All"` on a machine that has never picked one. (The probe has
  the page stringify the value, so output is compact JSON: a string comes back quoted.) That is the
  defect: `App.tsx:719` is the only writer, and it is the chip itself.

- [ ] **Step 3: Import the resolver.** In
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

- [ ] **Step 4: Add the writer.** Still in `App.tsx`, immediately after the
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

- [ ] **Step 5: Rebuild, relaunch, and measure again.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && npx electron . --remote-debugging-port=9222
  ```

  Start the same two sessions, click the first tab, run the Step 2 command: expected `"Personal"`.
  Click the second tab and run it again: expected the label of the profile covering
  `/Users/thevinh/dev/work` — `"Work"` on this machine.

- [ ] **Step 6: Measure that a manual choice still sticks.** With the work tab still in front,
  click the `All` chip, then run:

  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.profile-chip[aria-pressed=\"true\"]')?.textContent ?? 'none'"
  ```

  Expected: `"All"`, and it stays `"All"` while you keep clicking around inside the sidebar. Click
  the *other* tab and run it again: expected `"Personal"` — the next activation takes over, which
  is the intended rule.

- [ ] **Step 7: Measure that an SSH tab changes nothing.** Only if a host is configured in
  Settings: connect to it, then run the Step 2 command. Expected: unchanged from whatever it read
  before the connection. If no host is configured, skip — Task 42's
  `'an ssh alias is not a path, so it resolves to nothing'` case covers the rule itself.

- [ ] **Step 8: Typecheck and commit.**

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

### Task 47: Name the active profile where it cannot be missed

**This task substitutes for what the spec asked for. Read this before Step 1.**

- **What design §4.B.5 asks for:** "Ensure a profile switch is always visible on the default
  theme." §2.9 states the cause it has in mind: "`PROFILES[0].accent` is `#ff9552`, identical to
  EMBER's accent, so a profile switch can be visually invisible on the default theme." Together
  those read as an instruction to recolour — move one profile's accent off the theme's, and the
  accent swap becomes a visible signal again.
- **What measurement showed instead:** recolouring cannot deliver the guarantee. Step 2 runs the
  measurement and prints the two numbers. Ember/Personal are the *same string*, so their perceptual
  distance is **0.000**; the next-worst pair, Moss/Work, is **0.049**; and the closest two swatches
  in the palette — the gap it treats as "two different colours" — is **0.083**. So the collision is
  not one unlucky duplicate, it is two pairs inside the palette's own indistinguishability band.
  Worse, and this is what settles it: a **custom theme can define any accent at all**, so no
  choice of profile colours can make "the accent moved" a reliable signal for every user. The word
  in the spec is *always*, and colour cannot be always.
- **What is delivered instead:** the profile is **named** — a `.pill` in the status bar carrying
  the active profile's label. It is unconditional, it works on every theme including custom ones,
  and it reads correctly when the accent happens not to move at all. It costs no new colour:
  `applyAppearance` already writes the active profile's accent over `--accent` and
  `--accent-soft`, so the existing `.pill[data-tone='accent']` rule is already this profile's
  colour by construction.
- **What is given up:** nothing that was working. The accent still changes where the colours
  differ; this adds a signal rather than replacing one. The recolouring §4.B.5 implies is
  explicitly **not** done — moving `PROFILES[0].accent` off Ember's would change the app's default
  look for every existing user to fix one of the two collisions and none of the custom-theme case.
- **Why the substitution is safe to make here rather than escalating:** the spec's stated
  *intent* — "a profile switch is always visible on the default theme" — is met exactly, and by
  something stronger than what it proposed. Only the mechanism differs, and the reason it differs
  is a measurement this task performs and keeps (Steps 1–3 leave the readout in `verify:profiles`
  permanently, so the day the palette changes the numbers say so).

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/StatusBar.tsx` — `Props`
  (lines 7-15), the destructure (17-24), and both return branches (37-46 and 51-84).
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — the `<StatusBar />`
  element (around lines 867-874).
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-profiles.mts` — the colour measurement
  that says why; plus a CDP reading of the status bar through `scripts/cdp-eval.mjs`.

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5.
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

- [ ] **Step 4: Measure the status bar as it is.** With the app built and running from Task 46
  (`npm run build && npx electron . --remote-debugging-port=9222`), a session open, and the chip
  reading `Personal`:

  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.statusbar').innerText.replace(/\n/g,' | ')"
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
is the right colour by construction.

The design asked for this as a recolouring — make a profile switch visible on
the default theme by moving PROFILES[0].accent off Ember's. That was measured
and rejected: two pairs sit inside the palette's own indistinguishability band,
not one, and a custom theme can define any accent at all, so no palette makes
'the accent moved' reliable for every user. The spec says always. Naming it is
always; recolouring is not. No profile colour is changed."
  ```

---

## Workstream A — title bar and Chrome-style tabs

Covers design §4.A and the defects recorded in §2.6, §2.7 and §2.8.

**Reads with:** `/Users/thevinh/dev/personal/stoke/docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-design.md`
(authoritative), `/Users/thevinh/dev/personal/stoke/docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md`
(Tasks 1, 2, 3, 4 and 5 there **must** have landed first — every task below imports something they
create), `/Users/thevinh/dev/personal/stoke/CLAUDE.md`.

**Tasks in this part: 48–63.** The CDP probe an earlier draft built here is `scripts/cdp-eval.mjs`,
created once by contracts Task 5; and the single "New Project tab" task is split into three
committed units — Tasks 57, 58 and 59.

**Interfaces for the whole part:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5. Every measurement below runs through it;
  no task here creates it, and no task here writes its own probe.
- Consumes: `worklogWatch` in `App.tsx` and `window.stoke.worklog.watch` / `.onWatchChanged` from
  workstream C (Tasks 28 and 29). A runs after C.

**Where this part sits in the overhaul.** A runs *after* C (worklog), D (folders) and B (profiles),
and *before* F. That matters twice. Workstream F's 4px density migration (F Task 64) has **not**
run when these tasks execute, so every number below — Task 48's `{"left":6,"right":1}`, Task 49's
`{"tabTop":4,"tabBottom":43}` — is today's pre-migration geometry and stays correct as written. F
Task 74 re-measures the strip after the migration. And workstream F's icon-size change (F Task 69)
has not run either, so `.tab-close`'s glyph is 11px throughout this part.

**Ordering inside the part, and why it is this order.** Tasks 48–49 fix the two geometry defects
while the strip is still simple, so each measurement has exactly one cause. Tasks 50–52 rebuild the
indicator: the fixed slot first, then the colour semantics, then the worklog signal that fills the
slot's centre — in that order because the slot has to exist before anything can be centred in it,
and red has to be freed before it can be reassigned. Task 53 makes `permissionMode` honest, which
the indicator has been reading since 83. Tasks 54–55 are two small independent corrections. Tasks
56, 57, 58, 59, 60 and 61 are the New Project tab, decomposed so each leaves the app working:
the session cache first (pure refactor), then a New tab at boot, then the replace-on-launch
threading, then the launcher rendered as that tab's content, then per-tab launcher state, then the
`+` button that creates them. Task 62 adds reorder, which needs the tab list to be final. Task 63
closes the loop by re-measuring everything at once.

> **Line numbers in this part are hints, not addresses.** Four workstreams insert
> into `src/renderer/src/App.tsx`, `src/renderer/src/styles/app.css`,
> `src/main/index.ts`, `src/renderer/src/components/TitleBar.tsx`,
> `src/renderer/src/components/Sidebar.tsx` and four verify suites, so any figure
> written as "currently line N" is correct only for the first task that runs.
> **Locate every edit by the quoted text**, not by the number: for CSS, by the
> selector (`grep -n "^\.project-meta {" src/renderer/src/styles/app.css`); for
> TS/TSX, by a unique quoted line from the block being replaced; for the verify
> suites, by **that suite's own** closing summary/exit pair — the five shapes are listed in
> Global Constraints, and `verify-context.mts`, `verify-color.mts` and `verify-worklog-retry.mts`
> each differ from the rest — inserting immediately above it. If the
> quoted text is not found, stop — a prerequisite task has not landed or has
> landed differently, and guessing at the location is how two parts silently
> overwrite each other.

**Two constraints from CLAUDE.md that bound every task here.** `.app` is a fixed three-row grid
(`titlebar / body / status`) with an explicit `grid-template-columns: minmax(0, 1fr)` — do not add a
row, and do not remove that column declaration; a native `WebContentsView` paints above all renderer
DOM, so nothing here may become an overlay (gotcha 14). And `align-self: center` centres the
**margin** box, so cancelling a container's padding for one child needs the *full* padding negated,
not half (gotcha 11) — the `+` button's rule already does this and its comment says so; read it
before touching `.tabs`.

**Before the first task, launch the app with the debugger open** and leave it running for the whole
workstream. Every measurement step below assumes it, and assumes the window is at its default size
with the sidebar open.

```bash
cd /Users/thevinh/dev/personal/stoke && npm run build && \
  npx electron . --remote-debugging-port=9222 &
```

Confirm the probe reaches the renderer and not the docked browser:

```bash
cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "window.stoke.platform"
```

Expected on stdout, exit code 0: `"darwin"`.

---

---

### Task 48: Reset the UA button padding, which is 2.5px of the tab-close offset

Chromium's UA sheet sets `button { padding: 1px 6px }`. The reset at `app.css:26-32` resets `font`
and `color` only, so that padding survives and leaves `.tab-close` — an 18px box — a **6px** content
box for an 11px glyph. The glyph overflows its grid area, alignment falls back to the start edge,
and the ✕ sits 6px from the left and 1px from the right. One declaration fixes this and every
`.icon-btn` in the app at the same time.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the reset block at
  lines 26–32)
- Test: `scripts/cdp-eval.mjs` measurements, before and after.

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing new. A CSS-only change.

- [ ] **Step 1: Open a session so there is a tab to measure.**
  In the running app, start a session in any folder (the launcher's **Start here** button is
  enough). Confirm one tab exists:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "document.querySelectorAll('.tab').length"
  ```
  Expected: `1`.

- [ ] **Step 2: Measure the defect, and watch it fail.**
  `.tab-close` only becomes visible on hover, but it is laid out regardless, so no hover is needed.
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const b = document.querySelector('.tab-close'); const r = b.getBoundingClientRect(); const g = b.querySelector('svg').getBoundingClientRect(); return { left: +(g.left - r.left).toFixed(2), right: +(r.right - g.right).toFixed(2), pad: getComputedStyle(b).paddingLeft } })()"
  ```
  Expected: `{"left":6,"right":1,"pad":"6px"}` — the glyph is 5px further from the right edge than
  from the left, which is the 2.5px visual offset design §2.6 records.

  > The glyph is 11px because workstream F runs after A: F Task 69's icon-size change, which would
  > make it 12px, has not landed. If it prints `{"left":6,"right":0,"pad":"6px"}` then F has been run
  > out of order — the assertion `left === right` still fails either way, but stop and check the
  > ordering, because Task 63's closing measurement expects A's numbers, not F's.

- [ ] **Step 3: Record every button's height, so the reset can be proved harmless.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "Object.fromEntries([...document.querySelectorAll('button')].map((b) => [b.className || '(none)', Math.round(b.getBoundingClientRect().height)]))"
  ```
  Save the printed JSON. Step 6 compares against it. Every button in this app either sets its own
  padding (`.btn`, `.segmented button`, `.project`, `.session`, `.btab`) or is a fixed-size grid box
  (`.icon-btn`, `.tab-close`, `.win-btn`), so the expected diff is **none**.

- [ ] **Step 4: Reset the padding.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace the reset block:

  ```css
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }
  ```

  with:

  ```css
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }

  /*
   * Chromium's UA sheet sets `button { padding: 1px 6px }` and the reset above
   * never touched it. On an 18px `.tab-close` that leaves a 6px content box for
   * an 11px glyph: the glyph overflows its grid area, inline centring stops
   * applying, and the ✕ lands 6px from the left and 1px from the right. It gets
   * worse as Interface scale drops, because the rem-sized box shrinks while the
   * UA padding does not. Every button in this app that wants padding declares
   * it, so zeroing it here costs nothing and fixes `.tab-close` and every
   * `.icon-btn` in one line. Measured, not reasoned.
   */
  button {
    padding: 0;
  }
  ```

- [ ] **Step 5: Rebuild and measure again, and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload the renderer (`node scripts/cdp-eval.mjs "location.reload()"`, then reopen a session), and:
  ```bash
  node scripts/cdp-eval.mjs "(() => { const b = document.querySelector('.tab-close'); const r = b.getBoundingClientRect(); const g = b.querySelector('svg').getBoundingClientRect(); return { left: +(g.left - r.left).toFixed(2), right: +(r.right - g.right).toFixed(2), pad: getComputedStyle(b).paddingLeft } })()"
  ```
  Expected: `{"left":3.5,"right":3.5,"pad":"0px"}`. `left === right` is the assertion.

- [ ] **Step 6: Prove no other button changed height.**
  Re-run the command from Step 3 and diff its output against the saved JSON.
  Expected: byte-identical.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/styles/app.css && \
    git commit -m "Zero the UA button padding, which was pushing every icon off centre

Chromium's UA sheet sets button padding 1px 6px and the reset only ever touched
font and colour. On the 18px .tab-close that left a 6px content box for an 11px
glyph, so the mark overflowed its grid area, inline centring stopped applying,
and the ✕ sat at 6px/1px instead of 3.5/3.5. The same padding eats into every
.icon-btn and gets worse as Interface scale drops, because the rem box shrinks
while the UA pixels do not."
  ```

---

### Task 49: Centre tab contents on the title bar's centreline

Every icon outside the tab strip centres at **y=21.5**; tab contents centre at **y=24.0**.
`.tabs` has `padding-top: var(--sp-1)` — **4px**, and still spelt `--sp-1` at this point in the
order — with `align-items: stretch` (app.css:264-275), so a tab's border box runs 4→43 and, with a
1px top border and `border-bottom: none`, its *content* box runs 5→43 and centres at 24.0. The
tab's painted box must keep meeting the pane below, so the padding cannot simply go: the content is
pulled up instead.

> **What that padding is spelt as, and when.** Today, and at this task, `.tabs` reads
> `padding-top: var(--sp-1)` (`app.css:271`). A Task 54 Step 5 is what rewrites the whole `.tabs`
> rule to `padding-top: var(--space-4)`, and F Task 64 sweeps whatever `--sp-*` is left; both run
> after this task. Nothing in the arithmetic below turns on the spelling — `--sp-1` and
> `--space-4` are both 4px, contracts Task 4 declared `--space-4` alongside the surviving block and
> moved no pixel — so the 4→43 box, the 5px shortfall and every measured figure in this task hold
> either way. The Step 3 replacement writes `calc(var(--space-4) + 1px)` deliberately: the new
> token is already declared, and using it here means F Task 64's sweep has one fewer hit to find.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the `.tab` rule,
  currently 299–316 — 318 already starts `.tab:hover`, which this task does not touch; locate it
  with `grep -n "^\.tab {" src/renderer/src/styles/app.css`)
- Test: `scripts/cdp-eval.mjs` centreline measurements.

**Interfaces:**
- Consumes: `--space-4` (contracts Task 4), `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing new. A CSS-only change.

- [ ] **Step 1: Measure all three centrelines, and watch the tab fail.**
  With one session tab open:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const mid = (el) => { const r = el.getBoundingClientRect(); return +(r.top + r.height / 2).toFixed(2) }; return { icon: mid(document.querySelector('.titlebar-actions .icon-btn')), plus: mid(document.querySelector('.tabs > .icon-btn')), indicator: mid(document.querySelector('.tab-dot, .tab .ring')), label: mid(document.querySelector('.tab-label')) } })()"
  ```
  Expected: `{"icon":21.5,"plus":21.5,"indicator":24,"label":24}` — the strip's own contents are
  2.5px low against everything else in the bar, including the `+` button sitting beside them.

- [ ] **Step 2: Record where the tab's painted box ends, so the fix can be proved not to lift it.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const t = document.querySelector('.tab').getBoundingClientRect(); const h = document.querySelector('.titlebar').getBoundingClientRect(); return { tabTop: +t.top.toFixed(2), tabBottom: +t.bottom.toFixed(2), barBottom: +h.bottom.toFixed(2) } })()"
  ```
  Expected: `{"tabTop":4,"tabBottom":43,"barBottom":44}`. The tab ends at 43 — the title bar's
  content edge, with only its own 1px bottom border below it. This must not change.

- [ ] **Step 3: Pull the tab's contents up by the padding plus the border.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, in the `.tab` rule,
  replace the padding line — which today reads:

  ```css
    padding: 0 var(--sp-2) 0 var(--sp-3);
  ```

  with:

  ```css
    /*
     * Three values: no top padding, 8px inline, and a bottom padding that is the
     * strip's own top padding plus the tab's top border.
     *
     * The strip is padded at the top and stretches its children, so a tab's
     * painted box runs from y=4 to the title bar's content edge and meets the
     * pane below — which is what makes it read as a tab. But the box has a 1px
     * top border and no bottom border, so its content box is 5px shorter at the
     * top than at the bottom and everything inside it centred at 24.0, while
     * every icon outside the strip centres at 21.5.
     *
     * Shortening the content box at the bottom by exactly that 5px moves the
     * centreline up 2.5px and leaves the painted box where it was. This is the
     * same trap as the `+` button below (see CLAUDE.md gotcha 11): the whole
     * offset has to be cancelled, not half of it. Measured, not reasoned.
     */
    padding: 0 var(--space-8) calc(var(--space-4) + 1px);
  ```

  The right-hand inline padding goes from 6px to 8px in the same edit, because `--sp-2` is the only
  6px in the rule and F Task 64's sweep would round it to 8px anyway. Doing it here rather than
  leaving `var(--sp-2)` behind means F Task 64's `grep -rn -- '--sp-'` has one fewer hit to find,
  and `.tab`'s `paddingInline` reads `"8px"` from this commit onwards — which is the figure F Task
  74 re-measures.

  > Locate the line by its text, not by a line number: `grep -n "padding: 0 var(--sp-2) 0 var(--sp-3)" src/renderer/src/styles/app.css`.
  > That is what `.tab` still reads, because contracts Task 4 *declares* `--space-*` alongside the
  > surviving `--sp-*` block and moves no pixel — the `--sp-*` sweep is F Task 64, which runs after
  > this whole workstream. If the grep returns nothing, contracts Task 4 has not landed (the file
  > has no `--space-4` to reference either) or F Task 64 has been run out of order; stop in both
  > cases.

- [ ] **Step 4: Rebuild, then re-measure the centrelines, and watch them agree.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload the renderer and reopen a session, then re-run the Step 1 command.
  Expected: `{"icon":21.5,"plus":21.5,"indicator":21.5,"label":21.5}`.

- [ ] **Step 5: Prove the painted box did not move.**
  Re-run the Step 2 command.
  Expected: `{"tabTop":4,"tabBottom":43,"barBottom":44}` — unchanged.

- [ ] **Step 6: Screenshot the title bar.**
  Capture the running window (macOS: `screencapture -o -x /tmp/stoke-titlebar.png`) and look at it.
  The dot, the label, the ✕ and the icons on both sides must sit on one line. This is the check the
  numbers cannot make.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/styles/app.css && \
    git commit -m "Sit tab contents on the title bar's centreline

Tab contents centred at y=24.0 while every icon in the same bar centred at 21.5,
including the + button four pixels away from them. The strip is padded at the top
and stretches its children so a tab's painted box meets the pane below, and the
tab has a top border and no bottom border, so its content box was 5px shorter at
the top. Cancelling that at the bottom moves the centreline without lifting the
painted box off the pane."
  ```

---

### Task 50: One fixed indicator slot, with the ring always present

Today a 7px `.tab-dot` is swapped for a 14px `.ring` the moment the context watcher becomes ready,
so the label and the ✕ jump 7px sideways with no transition — and the permission and exit states
vanish with the dot. This replaces both with a single 14px slot that is always the same width and
always draws a ring, empty when there is nothing to report.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TabIndicator.tsx`
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/ContextMeter.tsx`
  (lines 43–65: `const R = 5.6` at 43 and `const CIRC` at 44, then the doc comment at 46 and the
  `ContextRing` export at 47–65. Step 2 replaces the whole span, constants included — locate its
  first line with `grep -n "^const R = 5.6" src/renderer/src/components/ContextMeter.tsx`)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (lines 1–17
  imports, 103–112 the dot/ring swap)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (delete the
  `.tab-dot` rules at 375–393; add the `.tab-indicator` block)
- Test: `scripts/cdp-eval.mjs` slot-width and label-position measurements.

**Interfaces:**
- Consumes: `--tab-indicator`, `--border-strong` (contracts Task 4), `scripts/cdp-eval.mjs`
  (contracts Task 5), `ContextSnapshot` and `PermissionMode` from `@shared/types` (contracts Task 2
  Step 1), `Tab.kind` and `TabKind` from
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts` (**contracts Task 2 Step 6a**, the
  only step in this plan that writes that file).
- Produces:
  ```ts
  // src/renderer/src/components/ContextMeter.tsx
  export const RING_R = 5.6
  export function ContextRing(props: {
    used: number
    limit: number
    /** False before the watcher has read anything: draw the empty track only. */
    ready?: boolean
  }): React.JSX.Element

  // src/renderer/src/components/TabIndicator.tsx
  export function TabIndicator(props: {
    kind: TabKind
    context: ContextSnapshot | undefined
    status: 'running' | 'exited'
    permissionMode: PermissionMode
    watched: boolean
  }): React.JSX.Element
  ```

- [ ] **Step 1: Measure the jump, and watch it fail.**
  Open a *fresh* session and run this immediately, before the watcher reports (it polls at 1.5s):
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const l = document.querySelector('.tab-label').getBoundingClientRect(); const t = document.querySelector('.tab').getBoundingClientRect(); return +(l.left - t.left).toFixed(2) })()"
  ```
  Expected: `22` — the tab's 1px left border, its 8px left padding, the 7px dot and the **6px** gap.
  Wait three seconds and run it again.
  Expected: `29` — the label has moved 7px right because the 7px dot became a 14px ring.

  > **The gap is 6px, not 8px.** `.tab` still reads `gap: var(--sp-2)` and `--sp-2` is `0.375rem`
  > at `app.css:55`. A Task 49 replaced `.tab`'s *padding* only — `padding: 0 var(--sp-2) 0
  > var(--sp-3)` became `padding: 0 var(--space-8) calc(var(--space-4) + 1px)` — and left the `gap`
  > declaration alone; F Task 64 is what sweeps it to `var(--space-8)` and takes it to 8px, and that
  > runs after this task. If you measure `24` here rather than `22`, F Task 64 has already run and
  > the plan is out of order.

- [ ] **Step 2: Let `ContextRing` draw an empty ring.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/ContextMeter.tsx`, replace
  everything from `const R = 5.6` through the closing `}` of the `ContextRing` export — lines 43–65
  today, the two constants included — with:

  ```tsx
  /** Radius of the tab ring, shared so anything drawn in the same slot lines up. */
  export const RING_R = 5.6
  const CIRC = 2 * Math.PI * RING_R

  /**
   * Compact ring for tab strips, where there is no room for a bar and caption.
   *
   * `ready` false draws the track and nothing else. That case exists because the
   * strip used to render a 7px dot until the watcher reported and then swap in a
   * 14px ring, which shoved the label and the close button 7px sideways with no
   * transition. An empty circle says the same thing — no reading yet — without
   * moving anything.
   */
  export function ContextRing({
    used,
    limit,
    ready = true
  }: {
    used: number
    limit: number
    ready?: boolean
  }): React.JSX.Element {
    const ratio = ready && limit > 0 ? Math.min(1, used / limit) : 0
    const pct = Math.round(ratio * 100)
    return (
      <svg className="ring" viewBox="0 0 16 16" data-level={ready ? level(ratio) : 'empty'}>
        <title>{ready ? `Context ${pct}% used` : 'Context not read yet'}</title>
        <circle className="ring-track" cx="8" cy="8" r={RING_R} />
        {ready && (
          <circle
            className="ring-fill"
            cx="8"
            cy="8"
            r={RING_R}
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - ratio)}
            strokeLinecap="round"
          />
        )}
      </svg>
    )
  }
  ```

- [ ] **Step 3: Write the indicator component.**
  Create `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TabIndicator.tsx`:

  ```tsx
  import type { ContextSnapshot, PermissionMode } from '@shared/types'
  import { ContextRing, RING_R } from './ContextMeter'
  import type { TabKind } from '../types'

  interface Props {
    kind: TabKind
    /** Undefined until the context watcher has reported for this session. */
    context: ContextSnapshot | undefined
    status: 'running' | 'exited'
    /**
     * The mode the transcript last recorded, not the one the tab launched with.
     * See the ContextSnapshot.permissionMode work in this workstream.
     */
    permissionMode: PermissionMode
    /** The worklog agent is watching this session. The only red in the strip. */
    watched: boolean
  }

  /**
   * Everything one tab has to say about its session, in a slot of fixed width.
   *
   * The slot is fixed because the strip used to swap a 7px dot for a 14px ring
   * the moment the context watcher became ready, and the label and the close
   * button jumped 7px with it. It is also the reason the ring is drawn even with
   * no reading: an empty circle occupies the slot honestly, where a blank space
   * would read as a rendering failure.
   *
   * The red dot in the middle means exactly one thing — the worklog agent is
   * watching this session. Bypass mode and a nearly-full ring both used to be
   * red as well, so red meant three unrelated things at once and therefore
   * nothing; both now have their own treatment.
   */
  export function TabIndicator({
    kind,
    context,
    status,
    permissionMode,
    watched
  }: Props): React.JSX.Element {
    if (kind === 'new') {
      /*
       * A New Project tab has no session, so there is nothing to measure. The
       * plus is drawn inline rather than pulled from Icons.tsx so it inherits
       * the ring's exact geometry and cannot drift out of the slot.
       *
       * `data-level="empty"` is what makes the .ring[data-level='empty']
       * .ring-track rule below apply here too. Without it the plus-in-a-circle
       * inherits the default track stroke rather than --border-strong, and the
       * one tab in the strip that has nothing to report is the one drawn as
       * though it did.
       */
      return (
        <span className="tab-indicator" data-kind="new">
          <svg className="ring" viewBox="0 0 16 16" data-level="empty" aria-hidden="true">
            <circle className="ring-track" cx="8" cy="8" r={RING_R} />
            <path className="ring-plus" d="M8 5.4v5.2M5.4 8h5.2" />
          </svg>
          <span className="sr-only">New session, not started</span>
        </span>
      )
    }

    const ready = context?.ready === true
    const bypass = permissionMode === 'bypassPermissions'

    return (
      <span
        className="tab-indicator"
        data-status={status}
        data-mode={bypass ? 'bypass' : undefined}
      >
        <ContextRing
          used={context?.contextTokens ?? 0}
          limit={context?.contextLimit ?? 0}
          ready={ready}
        />
        {watched && <span className="tab-watch" aria-hidden="true" />}
        <span className="sr-only">
          {watched ? 'Worklog is watching this session. ' : ''}
          {status === 'exited' ? 'Session ended. ' : ''}
          {bypass ? 'Permissions bypassed.' : ''}
        </span>
      </span>
    )
  }
  ```

- [ ] **Step 4: Render it from the tab strip.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`:
  - add `import { TabIndicator } from './TabIndicator'` after the `UsageChip` import, and delete
    `import { ContextRing } from './ContextMeter'` (line 2);
  - replace the whole conditional at lines 103–112 —

  ```tsx
              {ctx?.ready ? (
                <ContextRing used={ctx.contextTokens} limit={ctx.contextLimit} />
              ) : (
                <span
                  className="tab-dot"
                  data-state={
                    tab.status === 'exited' ? 'exited' : bypass ? 'bypass' : 'running'
                  }
                />
              )}
  ```

  — with:

  ```tsx
              <TabIndicator
                kind={tab.kind}
                context={ctx}
                status={tab.status}
                permissionMode={tab.permissionMode}
                watched={false}
              />
  ```

  and delete the now-unused `const bypass = tab.permissionMode === 'bypassPermissions'` beside it
  (locate it by that exact text). `watched={false}` is wired to the real signal in Task 52, and
  Task 52 Step 7 greps for it so this stub cannot survive the workstream.

  > The `kind === 'new'` branch written in Step 3 is **dead code until Task 59**. Nothing
  > constructs a tab with `kind: 'new'` before then, so it cannot be measured here and its own
  > measurement lives in Task 59 Step 4. That is deliberate: the branch has to exist before the
  > tab that renders it, or Task 59 would land two things at once.

- [ ] **Step 5: Style the slot, and delete the dot.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, delete the four `.tab-dot`
  rules (currently lines 375–393) and put this in their place:

  ```css
  /*
   * One fixed slot for whatever a tab has to say about its session.
   *
   * Fixed, because a 7px dot used to be swapped for a 14px ring the instant the
   * context watcher reported, and the label and the close button jumped 7px
   * sideways with it. Both children sit in the same grid cell, so the ring, the
   * empty circle and the ring-plus-dot are all exactly --tab-indicator wide.
   */
  .tab-indicator {
    position: relative;
    display: grid;
    place-items: center;
    width: var(--tab-indicator);
    height: var(--tab-indicator);
    flex: none;
  }

  .tab-indicator > .ring,
  .tab-indicator > .tab-watch {
    grid-area: 1 / 1;
  }

  /* The only red in the tab strip, and it means one thing: the worklog agent is
     watching this session. */
  .tab-watch {
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: var(--r-full);
    background: var(--tab-dot-worklog);
  }

  /* No reading yet — a plain circle, so the slot is never blank. */
  .ring[data-level='empty'] .ring-track {
    stroke: var(--border-strong);
  }

  /* A New Project tab has no session to measure. */
  .ring-plus {
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  /* A finished process reads as absent rather than as an alert. */
  .tab-indicator[data-status='exited'] {
    opacity: 0.45;
  }
  ```

- [ ] **Step 6: Rebuild and prove the label no longer moves.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload the renderer, open a fresh session, and run the Step 1 command **immediately**:
  Expected: `29`.
  Wait three seconds and run it again.
  Expected: `29` — identical. The label does not move when the reading arrives.

  > `29` and not `22`, because the fix works by giving the indicator a fixed 14px slot in *both*
  > states rather than by shrinking the ring. The label starts where it used to end up; what changes
  > is that it no longer moves. Same 6px gap caveat as Step 1: `24`/`31` here means F Task 64 ran early.

- [ ] **Step 7: Prove the slot is 14px in both states.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const s = document.querySelector('.tab-indicator').getBoundingClientRect(); return { w: +s.width.toFixed(2), h: +s.height.toFixed(2), mid: +(s.top + s.height / 2).toFixed(2) } })()"
  ```
  Expected: `{"w":14,"h":14,"mid":21.5}`.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/components/TabIndicator.tsx src/renderer/src/components/ContextMeter.tsx src/renderer/src/components/TitleBar.tsx src/renderer/src/styles/app.css && \
    git commit -m "Give the tab indicator one fixed slot, so a reading never shoves the label

The strip rendered a 7px dot until the context watcher became ready and then
swapped in a 14px ring, so the label and the close button jumped 7px sideways
with no transition — and the permission and exit states disappeared along with
the dot, because the ring replaced the whole element rather than filling it. The
ring is now always drawn, empty when there is nothing to report, inside a slot
that is 14px wide in every state."
  ```

---

### Task 51: Make red mean exactly one thing in the tab strip

Red currently means three unrelated things: bypass permission mode
(`.tab-dot[data-state='bypass']`, `app.css:387-389`), a ≥90% context ring
(`.ring[data-level='critical'] .ring-fill`, `app.css:899-901`), and the close button's hover fill
(`.tab-close:hover`, `app.css:370-373`). On this machine
`defaults.permissionMode` is `bypassPermissions`, so every tab is red all the time and it reads as
an alert when it is only a mode. Task 50 already deleted the bypass dot; this reassigns the two
remaining meanings so the colour is free for the worklog signal.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the
  `.ring[data-level='critical'] .ring-fill` rule — that is the whole selector, there is no bare
  `.ring[data-level='critical']` rule to find — currently at 899–901; the `.tab-indicator` block
  from Task 50)
- Test: `scripts/cdp-eval.mjs` computed-stroke measurements.

**Interfaces:**
- Consumes: `--ring-full` (contracts Task 4), `--warning` (already in `:root`),
  `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing new. A CSS-only change.

- [ ] **Step 1: Measure what is red today, and watch it fail.**
  With a session tab open whose permission mode is bypass:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const s = getComputedStyle(document.documentElement); const red = s.getPropertyValue('--danger').trim(); const track = getComputedStyle(document.querySelector('.tab-indicator .ring-track')).stroke; return { danger: red, bypassTrack: track, critical: [...document.styleSheets].flatMap((ss) => { try { return [...ss.cssRules] } catch { return [] } }).filter((r) => r.selectorText && r.selectorText.includes(\"data-level='critical'\")).map((r) => r.style.stroke) } })()"
  ```
  Expected: `critical` contains `var(--danger)`, and `bypassTrack` is the neutral
  `--border-strong` colour — bypass has no treatment at all since Task 50 removed the dot.

- [ ] **Step 2: Give bypass its own treatment.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, append to the
  `.tab-indicator` block added in Task 50:

  ```css
  /*
   * Bypass mode used to own --danger, which put a red dot on every tab on a
   * machine whose default permission mode is bypassPermissions — an alert that
   * was only ever a setting. A dashed warning-coloured track says "the guard
   * rails are off" and cannot be mistaken for the context fill, which is always
   * a solid arc starting at the top.
   */
  .tab-indicator[data-mode='bypass'] .ring-track {
    stroke: var(--warning);
    stroke-dasharray: 1.6 1.6;
  }
  ```

- [ ] **Step 3: Take red off the nearly-full ring.**
  In the same file, replace:

  ```css
  .ring[data-level='critical'] .ring-fill {
    stroke: var(--danger);
  }
  ```

  with:

  ```css
  /*
   * Not --danger. Red in the tab strip now means one thing only — the worklog is
   * watching this session — and a ring cannot be allowed to say it by accident.
   * At 90% the arc is nearly a closed circle, so the shape already carries the
   * urgency the colour used to.
   */
  .ring[data-level='critical'] .ring-fill {
    stroke: var(--ring-full);
  }
  ```

- [ ] **Step 4: Rebuild and prove red is gone from both.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload, open a bypass session, then:
  ```bash
  node scripts/cdp-eval.mjs "(() => { const root = getComputedStyle(document.documentElement); const t = getComputedStyle(document.querySelector('.tab-indicator .ring-track')); return { warning: root.getPropertyValue('--warning').trim(), trackStroke: t.stroke, dash: t.strokeDasharray } })()"
  ```
  Expected: `trackStroke` equals the resolved `--warning` colour and `dash` is `"1.6px 1.6px"`.

- [ ] **Step 5: Prove no `--danger` remains in the strip except the close button's hover.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n -- "--danger" src/renderer/src/styles/app.css
  ```
  Inspect each hit. In the tab strip the only permitted survivor is `.tab-close:hover`, which is a
  hover affordance and not a state. `.tab-dot[data-state='bypass']` (deleted by Task 50) and
  `.ring[data-level='critical'] .ring-fill` must both have stopped naming `--danger`.

- [ ] **Step 6: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/styles/app.css && \
    git commit -m "Free red in the tab strip, so it can mean one thing

Red meant bypass mode, a ≥90% context ring and a close-button hover all at once,
and on a machine whose default permission mode is bypassPermissions that put a
red dot on every tab permanently — an alert that was only ever a setting. Bypass
now gets a dashed warning track and the nearly-full ring gets --ring-full, which
leaves red for the worklog watch dot alone."
  ```

---

### Task 52: Draw the worklog watch dot from the real signal

The red dot inside the ring means the worklog agent is watching this session. Workstream C computes
the signal; this consumes it. Per contracts §0.3 the dot is drawn when, and only when, that tab's
`sessionId` has a `WorklogWatchState` with `watched === true`.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (one memo beside the other
  derived values; one prop on the `<TitleBar>` element)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (Props,
  the tab map)
- Test: `scripts/cdp-eval.mjs`, against a session in a watched group.

**This task writes nothing into `src/shared/api.ts` or `src/preload/index.ts`.** C Task 28 Step 4 is
the sole writer of the `worklog.watch` / `worklog.onWatchChanged` members, and C Task 29 Step 7 is
the sole writer of App's `worklogWatch` state and its subscription. A consumes both.

**Interfaces:**
- Consumes: `WorklogWatchState` from `@shared/types` and `CH.worklogWatch` / `CH.worklogWatchChanged`
  from `@shared/ipc` (contracts Task 2); `window.stoke.worklog.watch()` and `.onWatchChanged()`
  (C Task 28); the App-level `worklogWatch` state and its subscription (C Task 29 Step 7);
  `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces:
  ```ts
  // TitleBar Props gains:
  /** Session ids the worklog agent is watching. Drives the red dot in the ring. */
  watchedSessions: Set<string>
  ```

- [ ] **Step 1: Confirm the prerequisite, and stop if it is not there.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "onWatchChanged" src/shared/api.ts src/preload/index.ts
  ```
  Both files must print at least one hit. If either prints nothing, **C Task 28 has not landed and
  this task cannot start** — do not add the members here, because C Task 28 Step 4's snippet is the
  byte-for-byte text and two agents editing one object literal does not resolve to one copy.
  Then confirm App already holds the state C Task 29 Step 7 created:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "worklogWatch" src/renderer/src/App.tsx
  ```
  Expected: the `const [worklogWatch, setWorklogWatch] = useState<WorklogWatchState[]>([])`
  declaration, the `onWatchChanged(setWorklogWatch)` subscription and the
  `void window.stoke.worklog.watch().then(setWorklogWatch)` seed. If it prints nothing, land C Task
  29 first.

- [ ] **Step 2: Derive the id set, and watch the strip stay dotless.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add **only** this, next to the
  other derived values (immediately after the `promptQueue` memo — locate it by
  `grep -n "const promptQueue = useMemo" src/renderer/src/App.tsx`):

  ```tsx
    /*
     * The sole input to the red dot in the tab strip, derived from the one
     * App-level copy of the watch list rather than from a second subscription.
     * The list arrives whole on every change (contracts §0.3), so a Set built
     * from it cannot drift the way two copies of the same records would.
     */
    const watchedSessions = useMemo(
      () => new Set(worklogWatch.filter((s) => s.watched).map((s) => s.sessionId)),
      [worklogWatch]
    )
  ```

  Then pass it down: add `watchedSessions={watchedSessions}` to the `<TitleBar>` element.

  Do **not** add a `useState`, a `window.stoke.worklog.onWatchChanged(...)` call or a
  `void window.stoke.worklog.watch()` call in this task. C Task 29 Step 7 put all three in the
  bootstrap effect; a second `const offWatch = …` in that effect is a redeclaration error, and two
  App-level copies of the same list is the drift the whole-list rule exists to prevent.

- [ ] **Step 3: Draw it.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`:
  - add to `Props`, after `contexts`:

  ```ts
    /** Session ids the worklog agent is watching. Drives the red dot in the ring. */
    watchedSessions: Set<string>
  ```

  - add `watchedSessions` to the destructured parameter list;
  - change `watched={false}` on `<TabIndicator>` to `watched={watchedSessions.has(tab.sessionId)}`.

- [ ] **Step 4: Rebuild and prove the dot follows the signal.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload, and with **no** group watched (Settings → worklog groups empty) open a session:
  ```bash
  node scripts/cdp-eval.mjs "({ dots: document.querySelectorAll('.tab-watch').length, tabs: document.querySelectorAll('.tablist .tab').length })"
  ```
  Expected: `{"dots":0,"tabs":1}`.
  Now add that session's project group to the watched list in Settings and re-run.
  Expected: `{"dots":1,"tabs":1}` — the settings write is one of the four triggers that fires
  `worklog:watchChanged` (contracts §0.3), so no reload is needed.

- [ ] **Step 5: Prove the dot did not change the slot.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const s = document.querySelector('.tab-indicator').getBoundingClientRect(); const l = document.querySelector('.tab-label').getBoundingClientRect(); const t = document.querySelector('.tab').getBoundingClientRect(); return { w: +s.width.toFixed(2), label: +(l.left - t.left).toFixed(2) } })()"
  ```
  Expected: `{"w":14,"label":29}` — the same numbers as Task 50 Steps 6 and 7. The watch dot is drawn
  *inside* the 14px ring slot, so adding it must not move the label by even a pixel.

- [ ] **Step 6: Prove Task 50's stub is gone.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n 'watched={false}' src/renderer/src/components/TitleBar.tsx
  ```
  Expected: nothing, exit code 1. Task 50 declared `watched={false}` as a placeholder and this task
  is the only thing that removes it; a surviving hit means the strip is drawing a hardcoded "not
  watched" over the real signal, which looks exactly like the feature working and nothing being
  watched.

- [ ] **Step 7: Typecheck and commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && \
    git add src/renderer/src/App.tsx src/renderer/src/components/TitleBar.tsx && \
    git commit -m "Mark watched sessions in the tab strip, from the gate's own predicate

Nothing in the UI ever said which sessions the worklog agent was allowed to look
at, so 'working but with nothing to report' and 'never armed' looked identical.
The dot reads the same WorklogWatchState the paid scan reads, so the mark in the
strip and the run that costs money cannot disagree."
  ```

---

### Task 53: Keep `permissionMode` live instead of frozen at launch

`tab.permissionMode` is captured when the session starts and no `setTabs` writer in `App.tsx`
(lines 271, 283, 335, 421, 480) ever updates it, so toggling with Shift+Tab inside the session
leaves the indicator stating a mode that stopped being true. The transcript records
`{"type":"permission-mode","permissionMode":"…"}` lines and the watcher already parses the
transcript, so this costs no new polling.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/sessionFile.ts` (the `ParsedSession`
  interface at 21–35, and `parseSession` at 103–166 — its `out` literal at 104–116 and the
  `for (const line of lines)` loop at 121–163)
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/context.ts` (the `publish` call at 163–176)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the title-adoption effect
  at 281–295)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-context.mts` (extended)

**Interfaces:**
- Consumes: `ContextSnapshot.permissionMode` from `@shared/types` (contracts Task 2 Step 1,
  currently hardcoded `null` by Step 7); `Tab.permissionMode: PermissionMode` from
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts` (**contracts Task 2 Step 6a**, the
  only step in this plan that writes that file); `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces:
  ```ts
  // src/main/sessionFile.ts — ParsedSession gains:
  /** Newest `permission-mode` record in the transcript, or null when none. */
  permissionMode: PermissionMode | null
  ```

- [ ] **Step 1: Extend the context suite, and watch it fail.**
  In `/Users/thevinh/dev/personal/stoke/scripts/verify-context.mts`, extend the existing
  `node:fs/promises` import at line 7 to `import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'`
  and the existing `node:os` import at line 8 to `import { homedir, tmpdir } from 'node:os'`
  (`join` is already imported from `node:path` at line 9), then insert this block immediately
  **before** the file's last two lines, which are:

  ```ts
  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join(', ')}`}`)
  process.exit(failures.length === 0 ? 0 : 1)
  ```

  ```ts
  /* ------------------------------------------------------------------------
     The permission mode a session is actually in.
     It is captured in the tab at launch and Shift+Tab inside the session never
     reached it, so a tab could claim `bypass` for a session that had been put
     back into `default` half an hour earlier. The transcript is the only place
     that knows, and the watcher already reads it.
     ------------------------------------------------------------------------ */

  const fixtureDir = await mkdtemp(join(tmpdir(), 'stoke-permission-'))
  const withModes = join(fixtureDir, 'with-modes.jsonl')
  const withoutModes = join(fixtureDir, 'without-modes.jsonl')

  await writeFile(
    withModes,
    [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'x' }),
      JSON.stringify({ type: 'user', message: { content: 'hello' }, cwd: '/tmp' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'nonsense', sessionId: 'x' }),
      ''
    ].join('\n')
  )
  await writeFile(
    withoutModes,
    [JSON.stringify({ type: 'user', message: { content: 'hello' }, cwd: '/tmp' }), ''].join('\n')
  )

  const modes = await parseSession(withModes)
  const noModes = await parseSession(withoutModes)

  check(
    'the newest permission-mode record wins',
    modes.permissionMode === 'bypassPermissions',
    String(modes.permissionMode)
  )
  check(
    'a value that is not a permission mode is ignored rather than adopted',
    modes.permissionMode !== 'nonsense',
    String(modes.permissionMode)
  )
  check(
    'a transcript with no permission-mode record reports null, not a guess',
    noModes.permissionMode === null,
    String(noModes.permissionMode)
  )

  await rm(fixtureDir, { recursive: true, force: true })
  ```

- [ ] **Step 2: Run it and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-context.mts
  ```
  Expected, near the end of the output:
  ```
  FAIL  the newest permission-mode record wins  undefined
  FAIL  a transcript with no permission-mode record reports null, not a guess  undefined
  ```
  and a final line `2 FAILED: the newest permission-mode record wins, a transcript with no permission-mode record reports null, not a guess`.
  (`a value that is not a permission mode is ignored` passes vacuously while the field is
  `undefined`; it starts meaning something once Step 3 lands.)

- [ ] **Step 3: Parse the record.**
  In `/Users/thevinh/dev/personal/stoke/src/main/sessionFile.ts`:
  - add at the top, after the `node:fs/promises` import:

  ```ts
  import type { PermissionMode } from '@shared/types'
  ```

  (type-only, so node's strip-only mode erases it and the verify suite still runs);
  - add to the `ParsedSession` interface, after `model`:

  ```ts
    /** Newest `permission-mode` record in the transcript, or null when none. */
    permissionMode: PermissionMode | null
  ```

  - add above `parseSession`:

  ```ts
  /*
   * Only these five. A transcript is somebody else's file and a mode this app
   * does not understand must not reach the UI as a state nobody can style.
   */
  const PERMISSION_MODES = new Set<string>([
    'default',
    'plan',
    'acceptEdits',
    'auto',
    'bypassPermissions'
  ])
  ```

  - add `permissionMode: null,` to the `out` literal inside `parseSession`, after `model: null,`;
  - add this branch inside the line loop, immediately after the `if (type === 'ai-title') { … }`
    block:

  ```ts
      if (type === 'permission-mode') {
        // Later records win: the mode is toggled with Shift+Tab mid-session and
        // every toggle appends another record.
        const m = rec.permissionMode
        if (typeof m === 'string' && PERMISSION_MODES.has(m)) {
          out.permissionMode = m as PermissionMode
        }
        continue
      }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-context.mts
  ```
  Expected: `ALL CHECKS PASSED`.

- [ ] **Step 5: Put it on the snapshot.**
  In `/Users/thevinh/dev/personal/stoke/src/main/context.ts`, in the `this.publish({ … })` call
  inside `tick`, change `permissionMode: null` to `permissionMode: parsed.permissionMode`.
  Leave `emptySnapshot` at `permissionMode: null` — a session with no file yet has no recorded mode
  and inventing one is what this task exists to stop.

- [ ] **Step 6: Adopt it in the tab.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, replace the title-adoption effect
  (lines 281–295) with:

  ```tsx
    /*
     * Adopt Claude's own generated title, and keep the permission mode live.
     *
     * Both are read out of the transcript because it is the only thing that
     * knows. `tab.permissionMode` was captured at launch and no writer ever
     * updated it, so a tab kept claiming `bypass` for a session that had been
     * put back into `default` with Shift+Tab — the indicator could simply lie.
     */
    useEffect(() => {
      setTabs((list) => {
        let changed = false
        const next = list.map((t) => {
          const snap = contexts[t.sessionId]
          if (!snap) return t
          const title = snap.title && snap.title !== t.title ? snap.title : null
          const mode =
            snap.permissionMode && snap.permissionMode !== t.permissionMode
              ? snap.permissionMode
              : null
          if (!title && !mode) return t
          changed = true
          return {
            ...t,
            ...(title ? { title } : {}),
            ...(mode ? { permissionMode: mode } : {})
          }
        })
        return changed ? next : list
      })
    }, [contexts])
  ```

- [ ] **Step 7: Rebuild and watch the indicator follow a live toggle.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload, start a session in `default` mode, and confirm:
  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.tab-indicator').dataset.mode ?? null"
  ```
  Expected: `null`.
  Press **Shift+Tab** inside the terminal until Claude Code reports bypass mode, wait two seconds
  for the watcher's poll, and re-run.
  Expected: `"bypass"`.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/main/sessionFile.ts src/main/context.ts src/renderer/src/App.tsx scripts/verify-context.mts && \
    git commit -m "Read the permission mode from the transcript, so the tab cannot lie about it

tab.permissionMode was captured at launch and no setTabs writer ever updated it,
so toggling with Shift+Tab left the indicator stating a mode that had stopped
being true — the one failure mode an indicator must not have. The transcript
records every toggle and the context watcher already parses it, so this costs no
new polling. Only the five known modes are adopted; anything else is ignored."
  ```

---

### Task 54: Stop `role="tablist"` containing things that are not tabs

`TitleBar.tsx:80` wraps the `+` button inside the tablist and `BrowserPanel.tsx:106` wraps six
non-tab children in one. A screen reader announces "tab 3 of 3" for a button that is not a tab, and
arrow-key tab semantics apply to controls that do not answer to them.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (the
  `.tabs` element, lines 80 and 133)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/BrowserPanel.tsx` (the
  `.browser-tabs` element: it opens at line 106 and its `</div>` is line **189** — 187 is the
  devtools button's `sr-only` span, four lines inside it)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the `.tabs` rule at
  264–275 **and** its `.tabs::-webkit-scrollbar` rule at 277–279, both replaced in Step 5; the
  `.tabs > .icon-btn` rule at 294–297 gains one declaration; the `.browser-tabs` rule at
  1075–1082 loses two. Locate each with `grep -n "^\.tabs {\|^\.browser-tabs {" src/renderer/src/styles/app.css`)
- Test: `scripts/cdp-eval.mjs` role-child audit; geometry re-measure.

**Interfaces:**
- Consumes: `--space-4` (contracts Task 4), `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: two new class names, `.tablist` and `.btablist`, which are layout-only.

- [ ] **Step 1: Audit the tablists, and watch them fail.**
  Open the docked browser first (Ctrl/Cmd+B) so both strips exist, then:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "[...document.querySelectorAll('[role=\"tablist\"]')].map((l) => ({ label: l.getAttribute('aria-label'), nonTabChildren: [...l.children].filter((c) => c.getAttribute('role') !== 'tab').length }))"
  ```
  Expected: `[{"label":"Sessions","nonTabChildren":1},{"label":"Browser tabs","nonTabChildren":6}]`.

- [ ] **Step 2: Record the strip geometry that must not change.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const mid = (el) => { const r = el.getBoundingClientRect(); return +(r.top + r.height / 2).toFixed(2) }; const t = document.querySelector('.tab').getBoundingClientRect(); return { tabTop: +t.top.toFixed(2), tabBottom: +t.bottom.toFixed(2), plus: mid(document.querySelector('.tabs > .icon-btn')) } })()"
  ```
  Expected: `{"tabTop":4,"tabBottom":43,"plus":21.5}`.

- [ ] **Step 3: Move the role onto a wrapper in the title bar.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`, replace the
  whole `.tabs` element — it opens at line 80 with
  `<div className="tabs" role="tablist" aria-label="Sessions">` and closes at line 133 with the
  `</div>` after the `+` button. Locate it with
  `grep -n 'className="tabs"' src/renderer/src/components/TitleBar.tsx`.

  This is the complete replacement, at the indentation it takes in the file. It is written out in
  full rather than as "wrap it and re-indent" because the tab `map` body moves one level and a
  hand-applied re-indent is where JSX quietly stops balancing. Tasks 50, 52 and 53 have already
  landed, so `<TabIndicator>` is what draws the indicator and `watchedSessions` is already a prop —
  if what you see is a `.tab-dot`, or `watched={false}`, one of those has not landed and this task
  must not start:

  ```tsx
        {/*
          The strip and the tablist are two different things. The + button lives
          in the strip and is emphatically not a tab: inside the tablist a screen
          reader announced it as one, and arrow-key tab semantics applied to a
          control that does not answer to them.
        */}
        <div className="tabs">
          <div className="tablist" role="tablist" aria-label="Sessions">
            {tabs.map((tab) => {
              const ctx = contexts[tab.sessionId]
              return (
                <div
                  key={tab.id}
                  className="tab"
                  role="tab"
                  aria-selected={tab.id === activeTabId}
                  tabIndex={0}
                  onClick={() => onSelectTab(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelectTab(tab.id)
                    }
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) onCloseTab(tab.id)
                  }}
                  title={`${tab.title} — ${tab.cwd}`}
                >
                  <TabIndicator
                    kind={tab.kind}
                    context={ctx}
                    status={tab.status}
                    permissionMode={tab.permissionMode}
                    watched={watchedSessions.has(tab.sessionId)}
                  />
                  <span className="tab-label">{tab.title}</span>
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      onCloseTab(tab.id)
                    }}
                    title="Close session"
                  >
                    <IconClose width={11} height={11} />
                    <span className="sr-only">Close {tab.title}</span>
                  </button>
                </div>
              )
            })}
          </div>

          <button className="icon-btn" onClick={onNewTab} title="New session (Ctrl/Cmd+T)">
            <IconPlus />
            <span className="sr-only">New session</span>
          </button>
        </div>
  ```

  The only changes are the new `.tabs`/`.tablist` split, the `</div>` before the `+` button, and
  two extra levels of indentation on the `map`. Nothing inside a `.tab` moves.

- [ ] **Step 4: Do the same in the browser panel.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/BrowserPanel.tsx`, replace
  everything from the `.browser-tabs` opening tag (line 106) through the end of the `.btab` `map` —
  that is, up to and including the `))}` on line 147, immediately before the blank line and the
  new-tab button. Locate the start with
  `grep -n 'className="browser-tabs"' src/renderer/src/components/BrowserPanel.tsx`. Nothing after
  the `map` changes except the one `</div>` this step adds.

  This is the complete replacement, at the indentation it takes in the file:

  ```tsx
        <div className="browser-tabs">
          {/* Only the tabs. The new-tab button, the spacer and the four page
              actions are controls in the same strip, not tabs in the list. */}
          <div className="btablist" role="tablist" aria-label="Browser tabs">
            {state.tabs.map((tab) => (
              <div
                key={tab.id}
                className="btab"
                role="tab"
                aria-selected={tab.id === state.activeId}
                tabIndex={0}
                title={tab.url || tab.title}
                onClick={() => window.stoke.browser.selectTab(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    window.stoke.browser.selectTab(tab.id)
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) window.stoke.browser.closeTab(tab.id)
                }}
              >
                <span className="btab-label">{tab.loading ? 'Loading…' : tab.title || 'New tab'}</span>
                {/*
                  Always offered, including on the last tab. Hiding it there left no
                  way to close a single tab at all, which reads as the button being
                  broken. Closing the last one dismisses the whole panel, since that
                  is what closing the only tab means - the main process already
                  handles an empty tab list, it just left an empty browser on screen.
                */}
                <button
                  className="tab-close"
                  title={state.tabs.length > 1 ? 'Close tab' : 'Close tab and hide the browser'}
                  onClick={(e) => {
                    e.stopPropagation()
                    window.stoke.browser.closeTab(tab.id)
                    if (state.tabs.length <= 1) onClose()
                  }}
                >
                  <IconClose width={10} height={10} />
                  <span className="sr-only">Close tab</span>
                </button>
              </div>
            ))}
          </div>
  ```

  The `<button className="icon-btn" onClick={() => window.stoke.browser.newTab()} title="New tab">`
  block that followed stays exactly where it is, one level in from `.browser-tabs`, as do the
  spacer and the four page actions after it. The `</div>` that closes `.browser-tabs` (line 189
  today) is unchanged.

- [ ] **Step 5: Give both wrappers the layout the strips used to carry.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace the `.tabs` rule
  and its scrollbar rule with:

  ```css
  .tabs {
    display: flex;
    align-items: stretch;
    gap: var(--space-4);
    flex: 1;
    min-width: 0;
    height: 100%;
    padding-top: var(--space-4);
  }

  /*
   * The list itself. It carries the overflow so the tabs scroll and the + button
   * beside them stays put, and `min-width: 0` is what lets it shrink instead of
   * pushing the shell wider than the window — see CLAUDE.md gotcha 14, which is
   * about exactly this failure one level up.
   */
  .tablist {
    display: flex;
    align-items: stretch;
    gap: var(--space-4);
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tablist::-webkit-scrollbar {
    display: none;
  }
  ```

  and, in the `.browser-tabs` rule, delete `overflow-x: auto;` and `scrollbar-width: none;`, then
  add after it:

  ```css
  .btablist {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .btablist::-webkit-scrollbar {
    display: none;
  }
  ```

  Finally, keep the `+` button from being squeezed: in the `.tabs > .icon-btn` rule (the one whose
  comment explains the margin-box trap), add `flex: none;` as a new declaration. It had implicit
  `flex-shrink: 1` and only survived because nothing had pushed it yet.

- [ ] **Step 6: Rebuild, re-audit, and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload, open a session and the browser, then re-run the Step 1 command.
  Expected: `[{"label":"Sessions","nonTabChildren":0},{"label":"Browser tabs","nonTabChildren":0}]`.

- [ ] **Step 7: Prove the geometry is unchanged.**
  Re-run the Step 2 command.
  Expected: `{"tabTop":4,"tabBottom":43,"plus":21.5}` — identical.

- [ ] **Step 8: Typecheck and commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && \
    git add src/renderer/src/components/TitleBar.tsx src/renderer/src/components/BrowserPanel.tsx src/renderer/src/styles/app.css && \
    git commit -m "Put only tabs inside the tablists

Both strips wrapped their whole toolbar in role=tablist — the session strip's new
-tab button and six controls in the browser strip — so a screen reader announced
buttons as tabs and arrow-key tab semantics applied to controls that ignore them.
The list is now its own element inside the strip, and it carries the overflow, so
the buttons beside it stay put instead of scrolling away with the tabs."
  ```

---

### Task 55: Closing a tab selects its neighbour, not the last tab

`App.tsx:481` selects `next[next.length - 1]` — close the first of five tabs and focus jumps to the
far end of the strip. Every tabbed application selects the neighbour.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (`closeTab`, lines 473–484)
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts`
- Create: `/Users/thevinh/dev/personal/stoke/scripts/verify-tabs.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` (scripts)
- Modify: `/Users/thevinh/dev/personal/stoke/CLAUDE.md` (the verify-suite block, Step 6a)

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces:
  ```ts
  // src/renderer/src/lib/tabs.ts
  /** Which tab id to select once `closedId` is gone. Null when none is left. */
  export function neighbourOf(ids: string[], closedId: string): string | null
  ```

- [ ] **Step 1: Write the failing suite.**
  Create `/Users/thevinh/dev/personal/stoke/scripts/verify-tabs.mts`:

  ```ts
  /*
   * Tab list arithmetic: which tab is selected when one closes, and where a
   * dragged tab lands. Both are pure list operations that were written inline in
   * a React callback, where the only way to check them was to click.
   *
   *   node scripts/verify-tabs.mts
   */
  import { neighbourOf } from '../src/renderer/src/lib/tabs.ts'

  let failures = 0

  function check(name: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failures++
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
        (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    )
  }

  const five = ['a', 'b', 'c', 'd', 'e']

  console.log('\nclosing a tab selects its neighbour')
  check('closing the first selects the one that takes its place', neighbourOf(five, 'a'), 'b')
  check('closing a middle one selects the one that takes its place', neighbourOf(five, 'c'), 'd')
  check('closing the last selects the one before it', neighbourOf(five, 'e'), 'd')
  check('closing the only tab leaves nothing selected', neighbourOf(['a'], 'a'), null)
  check('closing a tab that is not there changes nothing', neighbourOf(five, 'zz'), null)
  check('an empty list has no neighbour', neighbourOf([], 'a'), null)

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exitCode = failures ? 1 : 0
  ```

- [ ] **Step 2: Run it and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-tabs.mts
  ```
  Expected:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts'`.

- [ ] **Step 3: Write the rule.**
  Create `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts`:

  ```ts
  /**
   * Which tab id to select once `closedId` is gone, or null when the list empties.
   *
   * The tab that takes the closed one's index, falling back to the one before it.
   * The old rule selected the *last* tab, so closing the first of five threw the
   * user to the far end of the strip — the one place they were not looking.
   */
  export function neighbourOf(ids: string[], closedId: string): string | null {
    const at = ids.indexOf(closedId)
    if (at < 0) return null
    const rest = ids.filter((id) => id !== closedId)
    if (rest.length === 0) return null
    return rest[Math.min(at, rest.length - 1)]
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-tabs.mts
  ```
  Expected: `all pass`.

- [ ] **Step 5: Use it.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add
  `import { neighbourOf } from './lib/tabs'` beside the other `./lib/` imports, and replace line
  481:

  ```tsx
        if (activeTabId === id) setActiveTabId(next.length ? next[next.length - 1].id : null)
  ```

  with:

  ```tsx
        if (activeTabId === id) {
          setActiveTabId(neighbourOf(tabs.map((t) => t.id), id))
        }
  ```

- [ ] **Step 6: Register the suite, by insertion — never by rewriting the `check` line.**
  In `/Users/thevinh/dev/personal/stoke/package.json`, add after the `verify:worklog-gate` line:

  ```json
      "verify:tabs": "node scripts/verify-tabs.mts",
  ```

  and **insert `&& npm run verify:tabs` immediately after `npm run verify:worklog-gate`** inside the
  existing `check` value. Do not retype the whole `check` line: by the time this task runs, contracts
  Task 3, D Task 34 and E Tasks 6/7/17 have each inserted a suite into it, and a pasted "so the
  whole line now reads…" quotation silently deletes theirs.

  Then run this guard, which must print nothing and exit 0:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','usage','profiles','settings','folders','color','worklog-gate','tabs','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"
  ```

- [ ] **Step 6a: Document the new suite in `CLAUDE.md`.** This is the last of the six `check`
  registrations, so after it the Commands block is accurate for the whole plan. In
  `/Users/thevinh/dev/personal/stoke/CLAUDE.md`, insert into the verify-suite fenced block
  immediately after the `npm run verify:folders` line D Task 34 Step 6a added:

  ```
  npm run verify:tabs           # which tab is selected after one is closed
  ```

  Expected: `grep -c "npm run verify:" CLAUDE.md` prints `18`, and `17` before this step. That is
  the fifteen suites `check` runs, plus `verify:extract` and `verify:security` which are in the
  block but deliberately outside `check`, plus the one prose reference to `verify:context` under
  "Verification expectations". It printed `13` before contracts Task 3.

- [ ] **Step 7: Rebuild and confirm in the app.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && npm run verify:tabs
  ```
  Reload, open three sessions, select the first, close it, and:
  ```bash
  node scripts/cdp-eval.mjs "[...document.querySelectorAll('.tab')].findIndex((t) => t.getAttribute('aria-selected') === 'true')"
  ```
  Expected: `0` — the tab that took the closed one's place. Before this change it was `1`.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/lib/tabs.ts scripts/verify-tabs.mts package.json src/renderer/src/App.tsx && \
    git commit -m "Select a closed tab's neighbour, not the far end of the strip

closeTab selected next[next.length - 1], so closing the first of five tabs threw
focus to the last one — the single place the user was not looking. The rule is now
a pure function with a suite, because the only previous way to check it was to
click five times and watch."
  ```

---

### Task 56: One session cache, keyed by path

`sessions` and `sessionsLoading` are App-level singletons (`App.tsx:62-63`) refetched whenever
`selectedPath` changes. Several New Project tabs each need their own project selection, and the
contract is explicit that `sessions` must **not** move onto `Tab` — two tabs on one project would
hold two copies that drift. It becomes one cache keyed by path. Pure refactor; no visible change.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (state at 62–63; the
  sessions effect at 246–261; the `<Sidebar>` and `<Launcher>` elements)
- Test: `scripts/cdp-eval.mjs` session-row counts before and after.

**Interfaces:**
- Consumes: `SessionMeta` from `@shared/types`; `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing exported. App-internal state shape changes to
  `sessionsByPath: Record<string, SessionMeta[]>` and `sessionsLoadingPath: string | null`.

- [ ] **Step 1: Record the baseline, so the refactor can be proved invisible.**
  Reload, click a project in the sidebar that has session history, expand it, then:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ sidebar: document.querySelectorAll('.sessions .session').length, launcher: document.querySelectorAll('.launcher .session').length })"
  ```
  Save the printed JSON. Step 5 must reproduce it exactly.

- [ ] **Step 2: Replace the state.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, replace lines 62–63:

  ```tsx
    const [sessions, setSessions] = useState<SessionMeta[]>([])
    const [sessionsLoading, setSessionsLoading] = useState(false)
  ```

  with:

  ```tsx
    /*
     * One cache for every project's session list, keyed by path.
     *
     * Deliberately not per-tab: two New Project tabs pointed at the same project
     * would hold two copies of the same fetched list, and the moment one of them
     * refetched they would disagree about the same folder. A cache keyed by the
     * folder cannot do that.
     */
    const [sessionsByPath, setSessionsByPath] = useState<Record<string, SessionMeta[]>>({})
    /** The path currently being fetched, or null. Drives the loading state. */
    const [sessionsLoadingPath, setSessionsLoadingPath] = useState<string | null>(null)
  ```

- [ ] **Step 3: Replace the fetch effect and derive the two old values.**
  Replace the effect at lines 246–261:

  ```tsx
    useEffect(() => {
      if (!selectedPath) {
        setSessions([])
        return
      }
      let cancelled = false
      setSessionsLoading(true)
      void window.stoke.projects.sessions(selectedPath).then((list) => {
        if (cancelled) return
        setSessions(list)
        setSessionsLoading(false)
      })
      return () => {
        cancelled = true
      }
    }, [selectedPath])
  ```

  with:

  ```tsx
    useEffect(() => {
      const path = selectedPath
      if (!path) return
      let cancelled = false
      setSessionsLoadingPath(path)
      void window.stoke.projects.sessions(path).then((list) => {
        if (cancelled) return
        setSessionsByPath((prev) => ({ ...prev, [path]: list }))
        setSessionsLoadingPath((cur) => (cur === path ? null : cur))
      })
      return () => {
        cancelled = true
      }
    }, [selectedPath])

    /*
     * What the sidebar and the launcher read. A cached list is shown immediately
     * on the way back to a project already visited, and the spinner only appears
     * for a folder nothing is known about yet.
     */
    const sessions = selectedPath ? (sessionsByPath[selectedPath] ?? []) : []
    const sessionsLoading = selectedPath !== null && sessionsLoadingPath === selectedPath
  ```

  Nothing at the `<Sidebar>` or `<Launcher>` call sites changes: both still receive `sessions` and
  `sessionsLoading` by those names.

- [ ] **Step 4: Typecheck and rebuild.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Expected: exit 0 from both.

- [ ] **Step 5: Reproduce the baseline exactly.**
  Reload, click the same project, expand it, and re-run the Step 1 command.
  Expected: byte-identical to the saved JSON.

- [ ] **Step 6: Prove a revisit is instant.**
  Click project A, then project B, then A again, and immediately (within the same second):
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ rows: document.querySelectorAll('.sessions .session').length, loading: [...document.querySelectorAll('.sessions .session-meta')].some((n) => n.textContent.startsWith('Loading')) })"
  ```
  Expected: `rows` is the same non-zero count A had. The cached list renders before the refetch
  resolves, so there is no empty frame in between — that is the whole point of the cache.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/App.tsx && \
    git commit -m "Cache session lists by project path, ready for several launcher tabs

A single App-level sessions array cannot serve two New Project tabs pointed at
different projects, and putting the array on the tab would let two tabs on the
same project hold copies that drift. Keying the cache on the folder makes both
problems structurally impossible, and it makes returning to a project instant."
  ```

---

### Task 57: Seed a New Project tab at boot, so `activeTabId` is never null

`App.tsx` does `onNewTab={() => setActiveTabId(null)}`: it clears the selection and appends nothing,
so "new session" has no representation in the strip at all. The Launcher is already the New Project
tab's content — it just is not a tab. This task creates the tab and stops `activeTabId === null`
being a state the app can be in. It deliberately does **not** render the launcher inside it yet
(90c) and does **not** thread `replaceTabId` yet (90b), so each of the three is one reviewable
change.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/newTab.ts`
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the tab state initialiser;
  the exit-attach effect; `closeTab`; `askClaude`)
- Test: `scripts/cdp-eval.mjs` tab-count measurement.

**Interfaces:**
- Consumes: `Tab`, `TabKind` from `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts`
  (**contracts Task 2 Step 6a**, which is the step that puts `kind`, `hostId`, `selectedPath` and
  `expandedPath` on that interface — §0.7 pins the shape);
  `neighbourOf` from `./lib/tabs` (Task 55); `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces:
  ```ts
  // src/renderer/src/lib/newTab.ts
  /** A New Project tab: a strip entry with no process behind it. */
  export function newTab(selectedPath?: string | null, expandedPath?: string | null): Tab
  ```

- [ ] **Step 1: Measure the missing tab, and watch it fail.**
  Reload with no sessions running:
  ```bash
  node scripts/cdp-eval.mjs "({ tabs: document.querySelectorAll('.tablist .tab').length, launcher: !!document.querySelector('.launcher') })"
  ```
  Expected: `{"tabs":0,"launcher":true}` — the launcher is on screen and the strip is empty.

- [ ] **Step 2: Write the factory.**
  Create `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/newTab.ts`:

  ```ts
  import type { Tab } from '../types'

  /**
   * A New Project tab: a strip entry with no process behind it.
   *
   * The launcher was always this tab's content; it just was not a tab, so the
   * "about to start something" state had no place in the strip and `+` could
   * only clear the selection. Everything a session tab needs and this one has no
   * answer for is an empty string, never a fake — `ptyId` and `sessionId` are
   * empty because there is no process and no transcript, and `status` reads
   * `running` only because a tab with no process cannot have exited. Nothing
   * reads `status` for a `new` tab; the indicator branches on `kind` first.
   */
  export function newTab(
    selectedPath: string | null = null,
    expandedPath: string | null = null
  ): Tab {
    return {
      id: `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'new',
      ptyId: '',
      sessionId: '',
      cwd: '',
      projectName: '',
      title: 'New session',
      permissionMode: 'default',
      model: '',
      effort: 'default',
      status: 'running',
      exitCode: null,
      hostId: null,
      selectedPath,
      expandedPath
    }
  }
  ```

  > `cwd: ''` is load-bearing on the main-process side too: contracts Task 1 guarantees
  > `groupForCwd('', …) === null`, so a New tab resolves to no project group rather than to the
  > first project in the list. Do not give it a placeholder path.

- [ ] **Step 3: Seed one at boot.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`:
  - add `import { newTab } from './lib/newTab'` beside the other `./lib/` imports;
  - replace the tab state initialiser — locate it by
    `grep -n "const \[tabs, setTabs\] = useState<Tab\[\]>(\[\])" src/renderer/src/App.tsx` — which
    reads:

  ```tsx
    const [tabs, setTabs] = useState<Tab[]>([])
    const [activeTabId, setActiveTabId] = useState<string | null>(null)
  ```

  with:

  ```tsx
    /*
     * The app always has at least one tab. A New Project tab is a real tab now,
     * so `activeTabId === null` — which used to mean "showing the launcher" —
     * is not a state the app can be in, and every reader that special-cased it
     * is gone.
     */
    const [tabs, setTabs] = useState<Tab[]>(() => [newTab()])
    const [activeTabId, setActiveTabId] = useState<string | null>(null)

    /*
     * Select the first tab as soon as it exists. `cur ?? …` makes this inert
     * after the first pass: it can never replace a real selection, so it is safe
     * to depend on the whole tab list.
     */
    useEffect(() => {
      setActiveTabId((cur) => cur ?? tabs[0]?.id ?? null)
    }, [tabs])
  ```

- [ ] **Step 4: Stop the process-shaped code touching processless tabs.**
  In the same file:
  - the exit-attach effect: change `.filter((t) => t.status === 'running')` to
    `.filter((t) => t.kind === 'session' && t.status === 'running')`;
  - `closeTab` (locate it by `grep -n "const closeTab = useCallback" src/renderer/src/App.tsx`):
    guard the kill and never leave the strip empty —

  ```tsx
        if (tab.kind === 'session') {
          window.stoke.pty.kill(tab.ptyId)
          forgetPty(tab.ptyId)
        }
        // Never leave the strip empty: closing the last tab lands on a fresh New
        // Project tab, which is where the app starts anyway.
        const next = tabs.filter((t) => t.id !== id)
        const replacement = next.length ? next : [newTab()]
        setTabs(replacement)
        if (activeTabId === id) {
          setActiveTabId(
            next.length ? neighbourOf(tabs.map((t) => t.id), id) : replacement[0].id
          )
        }
  ```

  - `askClaude` (locate it by `grep -n "const askClaude = useCallback" src/renderer/src/App.tsx`):
    change the target lookup to session tabs only —

  ```tsx
        const live = tabs.filter((t) => t.kind === 'session')
        const target = live.find((t) => t.id === activeTabId) ?? live[live.length - 1]
  ```

- [ ] **Step 5: Typecheck, rebuild, and watch the tab appear.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build && \
    node scripts/cdp-eval.mjs "document.querySelectorAll('.tablist .tab').length"
  ```
  Reload with no sessions running first. Expected: `1`, where Step 1 measured `0`.

  The launcher is still rendered by the old `activeTabId === null` branch, so with `activeTabId` now
  pointing at the New tab it is **off screen** and the pane below is blank. That is expected and it
  is what Task 59 fixes; it is visible for exactly two commits.

- [ ] **Step 6: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/lib/newTab.ts src/renderer/src/App.tsx && \
    git commit -m "Give the New Project state a tab, so activeTabId is never null

The launcher was already this tab's content and simply was not a tab, so the app
modelled 'about to start something' as activeTabId === null and the strip showed
nothing at all. With a real tab seeded at boot the null state disappears and
closing the last tab lands on a fresh one instead of on an empty window. The
process-shaped code — the exit attach, the kill in closeTab, the ask target — is
filtered to kind === 'session', because a tab with no process must not be sent
one."
  ```

---

### Task 58: `replaceTabId` on `startSession` and `startHostSession`

A session started from a New Project tab must take that tab's place rather than appending beside it.
Appending would leave the launcher sitting next to the terminal it just started, which reads as the
button having failed.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (`startSession`'s options
  type and its `setTabs`; `startHostSession`'s `setTabs`; `startDefault`; `startScratch`;
  `resumeSession`)
- Test: `scripts/cdp-eval.mjs` tab-count after a launch.

**Interfaces:**
- Consumes: `newTab()` and the `kind: 'new'` tabs from Task 57; `Tab.kind`, `Tab.hostId`,
  `Tab.selectedPath`, `Tab.expandedPath` (**contracts Task 2 Step 6a** declares them on the
  interface; Step 7 is what fills them in at `App.tsx`'s existing literals); `scripts/cdp-eval.mjs`
  (contracts Task 5).
- Produces:
  ```ts
  // startSession's options type gains:
  /** Replace this tab in place instead of appending. Used to consume a New tab. */
  replaceTabId?: string
  ```
  and one App-internal derived value:
  ```ts
  /** The New Project tab a launch should consume, or null to append. */
  const activeNewTabId: string | null
  ```

- [ ] **Step 1: Name the tab a launch should consume.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add immediately above
  `startSession` (locate it by `grep -n "const startSession = useCallback" src/renderer/src/App.tsx`):

  ```tsx
    /** The New Project tab a launch should consume, or null to append. */
    const activeNewTabId = useMemo(() => {
      const t = tabs.find((x) => x.id === activeTabId)
      return t && t.kind === 'new' ? t.id : null
    }, [tabs, activeTabId])
  ```

- [ ] **Step 2: Give `startSession` the option, and the replace-or-append writer.**
  In the same function, add `replaceTabId?: string` to the options type — so it reads:

  ```tsx
      async (opts: {
        cwd: string
        name: string
        title?: string
        sessionId?: string
        resume?: boolean
        continueLast?: boolean
        /** Replace this tab in place instead of appending. Consumes a New tab. */
        replaceTabId?: string
      }): Promise<void> => {
  ```

  then **check — do not re-add — the four fields on the `const tab: Tab = { … }` literal below it.**
  Contracts Task 2 Step 7 put them there already, `kind: 'session'` after `id` and
  `hostId: null, selectedPath: null, expandedPath: null` after `exitCode: null`; adding them a
  second time is a duplicate-key literal, which TypeScript reports as
  `error TS1117: An object literal cannot have multiple properties with the same name` and which
  no amount of re-reading the diff makes obvious. Confirm, one hit each:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -c "kind: 'session'" src/renderer/src/App.tsx
  ```

  Expected: `2` — the `startSession` literal and the `startHostSession` one. `0` means contracts
  Task 2 has not landed and this task cannot start; `4` means they have been added twice.

  Then replace `setTabs((list) => [...list, tab])` with:

  ```tsx
          /*
           * A session started from a New Project tab takes that tab's place
           * rather than appending beside it. Appending would leave the launcher
           * sitting next to the terminal it just started, which reads as the
           * button having failed.
           */
          setTabs((list) => {
            const at = opts.replaceTabId ? list.findIndex((t) => t.id === opts.replaceTabId) : -1
            if (at < 0) return [...list, tab]
            const next = [...list]
            next[at] = tab
            return next
          })
  ```

- [ ] **Step 3: Do the same in `startHostSession`, in full.**
  In the same file, replace `startHostSession`'s whole `setTabs(...)` / `setActiveTabId(...)` pair.
  At this point in the order it reads — note the four fields **contracts Task 2 Step 7 already
  added**, in the positions that task pins:

  ```tsx
          setTabs((list) => [
            ...list,
            {
              id: res.ptyId,
              kind: 'session',
              ptyId: res.ptyId,
              sessionId: res.sessionId,
              cwd: host.alias,
              projectName: host.label || host.alias,
              title: host.label || host.alias,
              permissionMode: mode,
              model,
              effort,
              status: 'running',
              exitCode: null,
              hostId: host.id,
              selectedPath: null,
              expandedPath: null
            }
          ])
          setActiveTabId(res.ptyId)
  ```

  If what you find is the twelve-field literal without `kind`, `hostId`, `selectedPath` and
  `expandedPath`, contracts Task 2 has not landed and this task cannot start — the replacement
  below does not typecheck without the interface those fields live on.

  Replace it with:

  ```tsx
          const tab: Tab = {
            id: res.ptyId,
            kind: 'session' as const,
            ptyId: res.ptyId,
            sessionId: res.sessionId,
            cwd: host.alias,
            projectName: host.label || host.alias,
            title: host.label || host.alias,
            permissionMode: mode,
            model,
            effort,
            status: 'running',
            exitCode: null,
            hostId: host.id,
            selectedPath: null,
            expandedPath: null
          }
          /* Same replace-or-append rule as startSession: connecting to a host
             from the launcher consumes the New tab it was launched from. */
          setTabs((list) => {
            const at = activeNewTabId ? list.findIndex((t) => t.id === activeNewTabId) : -1
            if (at < 0) return [...list, tab]
            const next = [...list]
            next[at] = tab
            return next
          })
          setActiveTabId(tab.id)
  ```

  and add `activeNewTabId` to `startHostSession`'s dependency array, so it reads
  `[defaultCwd, mode, model, effort, activeNewTabId]`.

  > `kind`, `hostId`, `selectedPath` and `expandedPath` are fields **contracts Task 2 Step 6a
  > already put on the `Tab` interface**, and Step 7 already filled in at these literals. Verify
  > with `grep -cE "^  (kind|hostId|selectedPath|expandedPath):" src/renderer/src/types.ts`, which
  > prints `4` — do not re-declare them there.

- [ ] **Step 4: Pass `replaceTabId` from the five launcher-initiated call sites.**
  Each is a one-line change; the two inside the `<Launcher>` element are shown in full by Task 59,
  which rewrites that whole element, so make them there rather than twice.

  | Call site | Before | After |
  |---|---|---|
  | `startDefault` | `void startSession({ cwd: defaultCwd, name: baseName(defaultCwd) })` | `void startSession({ cwd: defaultCwd, name: baseName(defaultCwd), replaceTabId: activeNewTabId ?? undefined })` |
  | `startScratch` | `await startSession({ cwd: dir, name: \`Scratch ${baseName(dir)}\` })` | `await startSession({ cwd: dir, name: \`Scratch ${baseName(dir)}\`, replaceTabId: activeNewTabId ?? undefined })` |
  | `resumeSession` | `sessionId: s.id,`<br>`resume: true` | `sessionId: s.id,`<br>`resume: true,`<br>`replaceTabId: activeNewTabId ?? undefined` |
  | `<Launcher onStart>` | see Task 59 Step 1 | see Task 59 Step 1 |
  | `<Launcher onContinueLast>` | see Task 59 Step 1 | see Task 59 Step 1 |

  Leave `Sidebar`'s `onStartNew={(p) => void startSession({ cwd: p.path, name: p.name })}` alone —
  starting a session from the sidebar while a terminal is open must not eat a launcher tab the user
  left open elsewhere in the strip.

- [ ] **Step 5: Add `activeNewTabId` to the four dependency arrays.**
  Name them explicitly, because `react-hooks/exhaustive-deps` is not enforced here and a stale
  closure would silently append instead of replacing:
  - `startSession`: `[mode, model, effort, ultracode]` is unchanged — the option is a parameter, not
    a closure capture.
  - `startHostSession`: `[defaultCwd, mode, model, effort, activeNewTabId]`
  - `startDefault`: `[defaultCwd, startSession, activeNewTabId]`
  - `startScratch`: `[startSession, refreshProjects, activeNewTabId]`
  - `resumeSession`: `[projects, startSession, activeNewTabId]`

- [ ] **Step 6: Typecheck, rebuild, and prove a launch replaces rather than appends.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Reload with one New tab open and no sessions, click **Scratch** in the sidebar head, wait for the
  terminal, then:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({tabs: document.querySelectorAll('.tablist .tab').length, newTabs: document.querySelectorAll('.tab-indicator[data-kind=\"new\"]').length})"
  ```
  Expected: `{"tabs":1,"newTabs":0}` — the New tab was replaced, not appended to.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/App.tsx && \
    git commit -m "Let a launch consume the New Project tab it was launched from

Appending would leave a launcher sitting beside the terminal it had just started,
which reads as the button having failed. startHostSession gets the same rule and
the same tab shape rather than a second one, because two writers of the same list
with two shapes is how a remote tab ends up without a kind."
  ```

---

### Task 59: Render the launcher as the active New tab's content

The launcher is still gated on `activeTabId === null`, which after Task 57 is never true — so it is
off screen. This puts it inside the tab that owns it and retires the null branch for good.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the `.term-stack` block and
  the `{activeTabId === null && (<Launcher … />)}` block)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (the
  `<TabIndicator>` element gains `data-kind` / `data-level` pass-through — see Step 3)
- Test: `scripts/cdp-eval.mjs` pane-visibility measurement.

**Interfaces:**
- Consumes: `activeNewTabId` (Task 58); `activeTab` (already computed in `App.tsx` — locate it by
  `grep -n "const activeTab = " src/renderer/src/App.tsx`); `TabIndicator` (Task 50);
  `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing exported.

- [ ] **Step 1: Replace both render blocks, shown in full.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, replace the `.term-stack` block
  and the `{activeTabId === null && (<Launcher … />)}` block that follows it — locate the pair by
  `grep -n "className=\"term-stack\"" src/renderer/src/App.tsx` and by
  `grep -n "activeTabId === null" src/renderer/src/App.tsx` — with exactly this:

  ```tsx
            <div
              className="term-stack"
              style={{ display: activeTab?.kind === 'session' ? 'block' : 'none' }}
            >
              {tabs
                .filter((tab) => tab.kind === 'session')
                .map((tab) => (
                  <TerminalView
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTabId}
                    theme={theme}
                    fontFamily={settings?.fontFamily ?? 'monospace'}
                    fontSize={settings?.fontSize ?? 13}
                    onOpenUrl={openUrl}
                    onRestart={restartTab}
                    onClose={closeTab}
                  />
                ))}
            </div>

            {/*
              Only the active New Project tab renders. The launcher holds no state
              of its own — its selection lives on the tab — so keying it on the
              tab id remounts it when you switch between two New tabs, which is
              also what re-focuses the primary action.
            */}
            {activeTab?.kind === 'new' && (
              <Launcher
                key={activeTab.id}
                project={selectedProject}
                defaultCwd={defaultCwd}
                permissionMode={mode}
                model={model}
                effort={effort}
                ultracode={ultracode}
                sessions={sessions}
                cli={cli}
                onChangeMode={changeMode}
                onChangeModel={changeModel}
                onChangeEffort={changeEffort}
                onChangeUltracode={changeUltracode}
                onStart={() => {
                  if (selectedProject) {
                    void startSession({
                      cwd: selectedProject.path,
                      name: selectedProject.name,
                      replaceTabId: activeNewTabId ?? undefined
                    })
                  }
                }}
                onContinueLast={() => {
                  if (selectedProject) {
                    void startSession({
                      cwd: selectedProject.path,
                      name: selectedProject.name,
                      continueLast: true,
                      replaceTabId: activeNewTabId ?? undefined
                    })
                  }
                }}
                onResume={resumeSession}
                onOpenFolder={() => void openFolder()}
                onStartDefault={startDefault}
                hosts={settings?.hosts ?? []}
                onConnectHost={(h) => void startHostSession(h)}
                onStartScratch={() => void startScratch()}
              />
            )}
  ```

  `activeTab` and `activeNewTabId` are both `const`s in the same function body, so both are in scope
  at the JSX. The two `replaceTabId` lines are Task 58 Step 4's last two rows.

- [ ] **Step 2: Confirm the null branch is gone from the render.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "activeTabId === null" src/renderer/src/App.tsx
  ```
  Expected: nothing. If it prints a hit, one of the two blocks above was not replaced and the
  launcher will render twice or never.

- [ ] **Step 3: Let the strip say which tabs are New.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`, no change is
  needed: Task 50 Step 3 already emits `data-kind="new"` on the `.tab-indicator` span and
  `data-level="empty"` on its `<svg className="ring">`, and this is the first task in which that
  branch is reachable. Confirm both are there:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n 'data-kind="new"\|data-level="empty"' src/renderer/src/components/TabIndicator.tsx
  ```
  Expected: two hits, one per attribute.

- [ ] **Step 4: Typecheck, rebuild, and measure both states.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Reload with no sessions running, then:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ tabs: document.querySelectorAll('.tablist .tab').length, newTabs: document.querySelectorAll('.tab-indicator[data-kind=\"new\"]').length, launcher: !!document.querySelector('.launcher'), term: getComputedStyle(document.querySelector('.term-stack')).display })"
  ```
  Expected: `{"tabs":1,"newTabs":1,"launcher":true,"term":"none"}`.
  Then start a session from the launcher's **Start here**, wait for the terminal, and re-run — but
  first press `+`… which does nothing yet (Task 61). Instead start a session from the **sidebar**'s
  `onStartNew` (double-click a project), which appends rather than replacing, and re-run:
  Expected: `{"tabs":2,"newTabs":1,"launcher":false,"term":"block"}` — two tabs, one of them still
  the New tab, the session selected and the launcher off screen.
  Then confirm the New tab's own indicator:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ kind: document.querySelector('.tab-indicator[data-kind=\"new\"]').dataset.kind, level: document.querySelector('.tab-indicator[data-kind=\"new\"] .ring').dataset.level })"
  ```
  Expected: `{"kind":"new","level":"empty"}` — the plus-in-a-circle picks up the `--border-strong`
  track rather than the default one.

- [ ] **Step 5: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/App.tsx && \
    git commit -m "Render the launcher inside the tab that owns it

The launcher was gated on activeTabId === null, which stopped being reachable the
moment a New Project tab was seeded at boot — so for two commits it was off
screen. Keying it on the tab id is what lets two New tabs each come back to their
own state, and gating .term-stack on the active tab's kind retires the last reader
of the null state."
  ```

---

### Task 60: Give each New Project tab its own launcher selection

`selectedPath` and `expandedPath` are App-level (`App.tsx:60-61`), so two New Project tabs would
both point at whatever was clicked last. The contract puts both on `Tab`. The sidebar keeps a
single visible selection — it is one list and can only highlight one row — but each New tab
remembers its own target, so switching between them restores what each was aimed at.

This task owns App.tsx's sidebar-selection state outright. `setSelectedPath` and `setExpandedPath`
cease to exist here; nothing in workstream F touches them, because spec §4.F.1 is delivered by these
tasks and not by F.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the `selectedPath` /
  `expandedPath` state; the `<Sidebar>` element's `onSelectProject` / `onToggleExpand`;
  `openFolder`; the palette's `onPick`)
- Test: `scripts/cdp-eval.mjs` selection round-trip and terminal-visibility measurements.

**Interfaces:**
- Consumes: `Tab.selectedPath`, `Tab.expandedPath` from
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts` (**contracts Task 2 Step 6a**;
  §0.7 pins the shape); `Tab.kind` from the same interface, read by the two `useMemo`s in Step 3;
  `activeNewTabId` (Task 58); `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: two App-internal writers,
  ```ts
  const selectProject: (path: string | null) => void
  const toggleExpand: (path: string | null) => void
  ```
  which write the sidebar's visible selection **and** the active New tab's own copy. `selectedPath`
  and `expandedPath` survive as **derived** `useMemo` values with the same names, so every existing
  reader is unchanged.

**There is no red/green measurement at the head of this task, and that is deliberate.** The defect
it fixes — two New Project tabs sharing one selection — cannot be exhibited until Task 61 gives the
user a way to make the second tab, so the failing measurement lives at Task 61 Step 6. What *is*
measurable here is the regression this task must not cause, and Step 8 measures it.

- [ ] **Step 1: Rename the App-level state to what it now is.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, replace — locate it by
  `grep -n "const \[selectedPath, setSelectedPath\]" src/renderer/src/App.tsx`:

  ```tsx
    const [selectedPath, setSelectedPath] = useState<string | null>(null)
    const [expandedPath, setExpandedPath] = useState<string | null>(null)
  ```

  with:

  ```tsx
    /*
     * What the sidebar highlights. One list, one highlight — but a New Project
     * tab also keeps its own copy, so two of them aimed at different projects
     * each come back to their own when selected. The sidebar's copy is written
     * alongside the tab's so switching from a New tab to a session tab does not
     * blank the list.
     */
    const [browsePath, setBrowsePath] = useState<string | null>(null)
    const [browseExpanded, setBrowseExpanded] = useState<string | null>(null)
  ```

- [ ] **Step 2: Derive the visible selection and write both copies.**
  Add immediately after `activeNewTabId` (introduced in Task 58):

  ```tsx
    /** The active New tab's own target, or the sidebar's, in that order. */
    const selectedPath = useMemo(() => {
      const t = tabs.find((x) => x.id === activeTabId)
      return t && t.kind === 'new' ? t.selectedPath : browsePath
    }, [tabs, activeTabId, browsePath])

    const expandedPath = useMemo(() => {
      const t = tabs.find((x) => x.id === activeTabId)
      return t && t.kind === 'new' ? t.expandedPath : browseExpanded
    }, [tabs, activeTabId, browseExpanded])

    const selectProject = useCallback(
      (path: string | null): void => {
        setBrowsePath(path)
        setTabs((list) =>
          list.map((t) =>
            t.id === activeTabId && t.kind === 'new' ? { ...t, selectedPath: path } : t
          )
        )
      },
      [activeTabId]
    )

    const toggleExpand = useCallback(
      (path: string | null): void => {
        setBrowseExpanded(path)
        setTabs((list) =>
          list.map((t) =>
            t.id === activeTabId && t.kind === 'new' ? { ...t, expandedPath: path } : t
          )
        )
      },
      [activeTabId]
    )
  ```

  Every existing reader of `selectedPath` / `expandedPath` — the sessions effect, `selectedProject`,
  and the `<Sidebar>` props — keeps working unchanged, because the names are the same.

- [ ] **Step 3: Point every writer at the new functions.**
  In the same file — locate each by the quoted prop name, not by a line number:
  - `<Sidebar>`'s `onSelectProject` becomes `onSelectProject={(p) => selectProject(p.path)}`; the
    `setActiveTabId(null)` inside it goes with it, because `null` is no longer a state the app can
    be in (Task 57);
  - `<Sidebar>`'s `onToggleExpand` becomes

  ```tsx
                  onToggleExpand={(p) => {
                    selectProject(p.path)
                    toggleExpand(expandedPath === p.path ? null : p.path)
                  }}
  ```

  - the command palette's `onPick` becomes

  ```tsx
          onPick={(p) => {
            setPaletteOpen(false)
            selectProject(p.path)
          }}
  ```

- [ ] **Step 4: Take `setActiveTabId(null)` out of `openFolder` too.**
  In `openFolder` (locate it by `grep -n "const openFolder = useCallback" src/renderer/src/App.tsx`),
  drop its `setActiveTabId(null)` and use `selectProject(dir)` in place of `setSelectedPath(dir)`.
  Add `selectProject` to `openFolder`'s dependency array.

  This is not optional and it is not workstream D's. After Task 57 `activeTabId === null` is not a
  state the app can be in, and `.term-stack` is hidden on exactly that condition — so leaving the
  call would blank the shell every time a folder is picked. Workstream D rewrites the *main-process*
  `projectsAdd` handler behind this call; it must not re-add the line.

- [ ] **Step 5: Typecheck, rebuild, and count what is left.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build && \
    grep -c "setActiveTabId(null)" src/renderer/src/App.tsx
  ```
  Expected: exit 0 from typecheck and build, then **`2`**.

  **The arithmetic, because "nothing" is the wrong answer here and an earlier draft of this task
  said it.** `App.tsx` holds **five** `setActiveTabId(null)` call sites on the tree as it stands —
  `grep -n` finds them at lines 567, 606, 675, 700 and 882 today, and no task between contracts
  Task 1 and this one adds or removes one (Task 55 rewrites `closeTab`'s
  `setActiveTabId(next.length ? … : null)`, which is a different expression and does not match this
  grep; Task 57 rewrites the `useState` declaration and adds a boot effect, neither of which is a
  literal `setActiveTabId(null)`).

  | # | Site | Removed by |
  |---|---|---|
  | 1 | the `case 'newTab':` keyboard shortcut (line 567) | **Task 61 Step 3** |
  | 2 | `openFolder` (line 606) | **this task, Step 4** |
  | 3 | `<TitleBar onNewTab={() => setActiveTabId(null)}>` (line 675) | **Task 61 Step 3** |
  | 4 | `<Sidebar onSelectProject>` (line 700) | **this task, Step 3** |
  | 5 | the command palette's `onPick` (line 882) | **this task, Step 3** |

  5 − 3 = **2 after this task**, and both survivors are the ones that make a *new* tab, which is
  precisely what this task cannot fix: `openNewTab` does not exist until Task 61 Step 2. 2 − 2 = **0
  after Task 61**, which is where the count becomes zero and where Task 61 Step 3 checks it.
  A `3` here means Step 3 or Step 4 was applied incompletely; a `0` here means one of Task 61's two
  sites was rewritten early, and Task 61 Step 1's red measurement is no longer reachable.

- [ ] **Step 6: Confirm one selection still works.**
  Reload, click a project in the sidebar, and:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ title: document.querySelector('.launcher-title').textContent, current: document.querySelectorAll('.project[aria-current=\"true\"]').length })"
  ```
  Expected: the project's name and `{"current":1}`. The two-tab round trip is measured in Task 61
  Step 6, once there is a way to make a second New tab.

- [ ] **Step 7: Prove a project click no longer tears down a running terminal (spec §2.10).**
  This is the regression measurement this task exists to close, and it is the same expression that
  exhibited the defect before Task 57. Against the running window:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const scratch = [...document.querySelectorAll('.sidebar-head .btn')]
      .find((b) => b.textContent.includes('Scratch'))
    scratch.click()
    for (let i = 0; i < 40 && !document.querySelector('.term-stack .term-pane'); i++) await sleep(250)
    const before = getComputedStyle(document.querySelector('.term-stack')).display
    document.querySelector('.project').click()
    await sleep(200)
    return {
      before,
      after: getComputedStyle(document.querySelector('.term-stack')).display,
      selected: document.querySelector('.project[aria-current=\"true\"]') !== null
    }
  })()"
  ```

  Expected now: `{"before":"block","after":"block","selected":true}`.
  Before Task 57 the same expression returned `{"before":"block","after":"none","selected":true}` —
  the terminal was on screen and one project click removed it, because `onSelectProject` cleared
  `activeTabId` and `.term-stack` is `display: none` on exactly that condition.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/App.tsx && \
    git commit -m "Give each New Project tab its own launcher target

Two New Project tabs sharing one App-level selectedPath would both point at
whatever was clicked last, which is the whole reason several of them were not
possible. The sidebar keeps one visible highlight, because it is one list, and
each New tab keeps its own copy alongside it. Three of the five setActiveTabId
(null) call sites go with it — the sidebar's, the palette's and openFolder's —
which stops clicking a project hiding a running terminal. The two that remain
are the ones that ask for a new tab, and they need a callback that does not
exist yet."
  ```

---

### Task 61: `+` appends a real New Project tab, and several are allowed

With the tab kind and the per-tab selection in place, `+` can finally do what it says.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the `<TitleBar>`
  `onNewTab`; the `newTab` keyboard-shortcut case)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (a `.tab` rule for
  the `new` kind)
- Test: `scripts/cdp-eval.mjs` two-tab round trip.

**Interfaces:**
- Consumes: `newTab()` from `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/newTab.ts`
  (Task 57); `browsePath` / `browseExpanded` (Task 60); `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: one App-internal callback,
  ```ts
  /** Append a New Project tab and select it. Several may be open at once. */
  const openNewTab: () => void
  ```

- [ ] **Step 1: Measure what `+` does today, and watch it fail.**
  Reload, start one session so a session tab exists, then press `+` in the title bar and:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ tabs: document.querySelectorAll('.tablist .tab').length, launcher: !!document.querySelector('.launcher') })"
  ```
  Expected: `{"tabs":1,"launcher":false}` — nothing was appended and nothing happened, because
  `onNewTab` still points at `() => setActiveTabId(null)`, and after Task 57 there is a boot effect
  that puts a real id straight back. The button is inert.

- [ ] **Step 2: Write the callback.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add beside the other tab
  callbacks (just above `closeTab`):

  ```tsx
    /**
     * Append a New Project tab and select it.
     *
     * Several may be open at once, which is the point: each one carries its own
     * project selection, so two launchers can be aimed at two different folders
     * while a third terminal keeps running. It inherits the sidebar's current
     * selection so pressing + does not throw away what is on screen.
     */
    const openNewTab = useCallback((): void => {
      const tab = newTab(browsePath, browseExpanded)
      setTabs((list) => [...list, tab])
      setActiveTabId(tab.id)
    }, [browsePath, browseExpanded])
  ```

- [ ] **Step 3: Wire the button and the shortcut.**
  In the same file — locate both by their quoted text:
  - `grep -n "onNewTab={() => setActiveTabId(null)}" src/renderer/src/App.tsx` → change it to
    `onNewTab={openNewTab}`;
  - the `newTab` keyboard-shortcut case (`grep -n "case 'newTab'" src/renderer/src/App.tsx`) →
    change its `setActiveTabId(null)` to `openNewTab()`, and add `openNewTab` to that effect's
    dependency array.

  **These are the last two, and this step is where the count reaches zero.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -c "setActiveTabId(null)" src/renderer/src/App.tsx
  ```

  Expected: `0` — and **`2`** immediately before this step, which is exactly what Task 60 Step 5
  measured and explained. `App.tsx` held five such call sites on the tree as it stands; Task 60
  removed three (the sidebar's `onSelectProject`, the palette's `onPick` and `openFolder`) and left
  these two, because both of them have to *make* a tab and `openNewTab` did not exist until Step 2
  above. 5 − 3 − 2 = 0. If the count before this step is `0`, one of these two was rewritten early
  and Step 1's red measurement was never real; if it is `3` or more, Task 60 Step 3 or Step 4 was
  applied incompletely — go back and finish it rather than fixing it here.

- [ ] **Step 4: Let a New tab read as unstarted in the strip.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add after the `.tab-label`
  rule:

  ```css
  /*
   * A New Project tab has no session behind it, so its label is a placeholder
   * rather than a name. Muting it keeps the strip readable when three of them
   * are open beside two live sessions.
   */
  .tab:has(.tab-indicator[data-kind='new']) .tab-label {
    color: var(--text-muted);
  }
  ```

- [ ] **Step 5: Typecheck, rebuild, and watch `+` work.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Reload, start one session, press `+` twice, and:
  ```bash
  node scripts/cdp-eval.mjs "({ tabs: document.querySelectorAll('.tablist .tab').length, newTabs: document.querySelectorAll('.tab-indicator[data-kind=\"new\"]').length, launcher: !!document.querySelector('.launcher'), term: getComputedStyle(document.querySelector('.term-stack')).display })"
  ```
  Expected: `{"tabs":3,"newTabs":2,"launcher":true,"term":"none"}`.

- [ ] **Step 6: Prove each New tab remembers its own project (Task 60's deliverable).**
  With the two New tabs from Step 5: select the first, click project **A** in the sidebar; select
  the second, click project **B**; then select the first again and:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "new Promise((r) => setTimeout(() => r(document.querySelector('.launcher-title').textContent), 60))"
  ```
  Expected: `"A"` — not `"B"`. Select the second and re-run.
  Expected: `"B"`.

- [ ] **Step 7: Prove a running terminal survives a sidebar click (design §2.10).**
  Select the session tab, then click a project in the sidebar and:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ term: getComputedStyle(document.querySelector('.term-stack')).display, selected: document.querySelector('.tab[aria-selected=\"true\"] .tab-label').textContent })"
  ```
  Expected: `term` is `"block"` and the selected tab is still the session's — the same guarantee
  Task 60 Step 7 measured, re-checked now that several New tabs can be in the strip beside a running
  session. Before Task 57 the click set `activeTabId` to null and the terminal vanished.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/App.tsx src/renderer/src/styles/app.css && \
    git commit -m "Make + append a New Project tab, and allow several at once

onNewTab was setActiveTabId(null): it cleared the selection and appended nothing,
so the button appeared to do nothing whenever a session was already open. Each
New tab now carries its own project selection, so two launchers can be aimed at
two folders while a terminal keeps running — and clicking a project in the sidebar
no longer hides that terminal, because there is no null state left to fall into."
  ```

---

### Task 62: Drag to reorder tabs

**Decision, stated because the plan is otherwise silent on it: the order is not persisted, and
that is correct.** `moveTab` reorders React state and nothing else, and Task 57 seeds
`useState<Tab[]>(() => [newTab()])` on every boot, so a drag is forgotten when the window closes.
A tab is a **live PTY**, not a document: closing Stoke kills every `claude` process it spawned, so
on the next launch there is no tab to have an order — restoring one would mean either resurrecting
sessions (which is `--resume`, a separate deliberate act the launcher already offers) or restoring
a strip of dead placeholders. Nothing else in the app persists per-run window state either;
`store.ts` holds settings, projects and hosts, and no tab has ever been in it. Reordering therefore
does what reordering does in a terminal multiplexer, not what it does in a browser. If tab
persistence is ever wanted it is its own feature — session restore first, order second — and not a
side effect of a drag handler.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts` (add `moveTab`)
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-tabs.mts` (add the cases)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (add `reorderTab`; pass it
  down)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (drag
  handlers on `.tab`)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (drag affordances)

**Interfaces:**
- Consumes: `neighbourOf` already in `lib/tabs.ts` (Task 55); `scripts/cdp-eval.mjs` (contracts
  Task 5).
- Produces:
  ```ts
  // src/renderer/src/lib/tabs.ts
  /** `dragId` moved to `overId`'s index. The same list back when either is unknown. */
  export function moveTab<T extends { id: string }>(list: T[], dragId: string, overId: string): T[]

  // TitleBar Props gains:
  /** Reorder: the dragged tab takes the target's index. */
  onReorderTab: (dragId: string, overId: string) => void
  ```

- [ ] **Step 1: Extend the suite, and watch it fail.**
  In `/Users/thevinh/dev/personal/stoke/scripts/verify-tabs.mts`, change the import to
  `import { moveTab, neighbourOf } from '../src/renderer/src/lib/tabs.ts'` and append before the
  final `console.log`:

  ```ts
  console.log('\ndragging a tab onto another')
  const ids = (list: { id: string }[]): string[] => list.map((t) => t.id)
  const five5 = five.map((id) => ({ id }))

  check('dragging right lands on the target index', ids(moveTab(five5, 'a', 'c')), [
    'b',
    'c',
    'a',
    'd',
    'e'
  ])
  check('dragging left lands on the target index', ids(moveTab(five5, 'e', 'b')), [
    'a',
    'e',
    'b',
    'c',
    'd'
  ])
  check('dropping a tab on itself changes nothing', ids(moveTab(five5, 'c', 'c')), five)
  check('an unknown drag id changes nothing', ids(moveTab(five5, 'zz', 'c')), five)
  check('an unknown target changes nothing', ids(moveTab(five5, 'a', 'zz')), five)
  check('the input list is not mutated', ids(five5), five)
  ```

- [ ] **Step 2: Run it and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-tabs.mts
  ```
  Expected:
  `SyntaxError: The requested module '../src/renderer/src/lib/tabs.ts' does not provide an export named 'moveTab'`.

- [ ] **Step 3: Write it.**
  Append to `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts`:

  ```ts
  /**
   * `dragId` moved to `overId`'s index, as a new array.
   *
   * Splice-out-then-splice-in, so dragging right lands *after* the target and
   * dragging left lands *before* it — which is what the pointer is over in each
   * case. An unknown id on either side returns the same list rather than
   * throwing: a drop can land after the tab it was aimed at has closed.
   */
  export function moveTab<T extends { id: string }>(
    list: T[],
    dragId: string,
    overId: string
  ): T[] {
    const from = list.findIndex((t) => t.id === dragId)
    const to = list.findIndex((t) => t.id === overId)
    if (from < 0 || to < 0 || from === to) return list
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-tabs.mts
  ```
  Expected: `all pass`.

- [ ] **Step 5: Wire it into App.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, change the `lib/tabs` import to
  `import { moveTab, neighbourOf } from './lib/tabs'`, add beside `openNewTab`:

  ```tsx
    const reorderTab = useCallback((dragId: string, overId: string): void => {
      // Keyed by tab id in the render, so React moves the DOM nodes rather than
      // rebuilding them — and ptyBus replays the retained scrollback anyway, so
      // even a rebuild would not blank a terminal.
      setTabs((list) => moveTab(list, dragId, overId))
    }, [])
  ```

  and pass `onReorderTab={reorderTab}` to `<TitleBar>`.

- [ ] **Step 6: Add the drag handlers.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`:
  - add `import { useState } from 'react'` at the top;
  - add to `Props`:

  ```ts
    /** Reorder: the dragged tab takes the target's index. */
    onReorderTab: (dragId: string, overId: string) => void
  ```

  and to the destructured list;
  - add inside the component, before the `return`:

  ```tsx
    const [dragId, setDragId] = useState<string | null>(null)
    const [overId, setOverId] = useState<string | null>(null)
  ```

  - add these attributes to the `.tab` `<div>`, after `title=`:

  ```tsx
              draggable
              data-dragging={tab.id === dragId ? 'true' : undefined}
              data-drop={tab.id === overId ? 'true' : undefined}
              onDragStart={(e) => {
                setDragId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                // Chromium refuses to begin a drag with an empty payload.
                e.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === tab.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setOverId(tab.id)
              }}
              onDragLeave={() => setOverId((cur) => (cur === tab.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dragId !== tab.id) onReorderTab(dragId, tab.id)
                setDragId(null)
                setOverId(null)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
  ```

- [ ] **Step 7: Style the drag.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add after the
  `.tab[aria-selected='true']::before` rule:

  ```css
  .tab[data-dragging='true'] {
    opacity: 0.4;
  }

  /* Where it will land. An inset outline rather than a background, so it does
     not read as hover on the tab the pointer happens to be over. */
  .tab[data-drop='true'] {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }
  ```

- [ ] **Step 8: Rebuild and drive a real drag over CDP.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Reload, open three tabs with distinguishable labels, then:
  ```bash
  node scripts/cdp-eval.mjs "(async () => { const labels = () => [...document.querySelectorAll('.tablist .tab .tab-label')].map((s) => s.textContent); const before = labels(); const tabs = [...document.querySelectorAll('.tablist .tab')]; const dt = new DataTransfer(); tabs[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); await new Promise((r) => setTimeout(r, 30)); tabs[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); tabs[2].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); await new Promise((r) => setTimeout(r, 60)); return { before, after: labels() } })()"
  ```
  Expected: `after` is `before` with its first entry moved to the end — e.g.
  `{"before":["one","two","three"],"after":["two","three","one"]}`.

- [ ] **Step 9: Prove a dragged terminal did not lose its scrollback.**
  Screenshot the window after the drag (`screencapture -o -x /tmp/stoke-after-drag.png`) with the
  moved session tab selected. The terminal must still show its output — the DOM is empty for a
  WebGL renderer (gotcha 5), so a screenshot is the only way to see this.

- [ ] **Step 10: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/lib/tabs.ts scripts/verify-tabs.mts src/renderer/src/App.tsx src/renderer/src/components/TitleBar.tsx src/renderer/src/styles/app.css && \
    git commit -m "Let tabs be dragged into the order you want them in

Tab order was append-only, so a session opened an hour ago could never be moved
next to the one it belongs beside. The list arithmetic is a pure function with a
suite because the alternative — clicking and looking — cannot distinguish 'lands
before' from 'lands after'. Terminals survive the move: the render is keyed by tab
id and ptyBus replays retained scrollback on any remount.

The order is deliberately not persisted. A tab is a live PTY, and closing Stoke
kills every claude process it spawned, so on the next launch there is no tab for
an order to apply to — restoring one would mean either resurrecting sessions,
which is what --resume already is and is a decision the user makes explicitly,
or drawing a strip of dead placeholders. No tab state has ever been in store.ts
and none is added here."
  ```

---

### Task 63: Tighten the tab label, and re-measure the whole strip

The strip is finished. This applies the one typography token it owes (`--lh-tight`, contracts §0.6:
"applied by workstream A to `.tab-label`") and re-measures every number this workstream claimed, in
one pass, on the final code.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the `.tab-label`
  rule)
- Test: one combined `scripts/cdp-eval.mjs` measurement, plus `npm run check`.

**Interfaces:**
- Consumes: `--lh-tight` (contracts Task 4), `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing new.

- [ ] **Step 1: Measure the label's line box, and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "getComputedStyle(document.querySelector('.tab-label')).lineHeight"
  ```
  Expected: `"normal"` — the label sets no line height and inherits none, so the browser picks its
  own from the font metrics and nothing in the repo states what a tab label's line box is.

  **Not a pixel figure, and specifically not `"20.15px"`.** `body` does not carry
  `line-height: var(--lh-normal)` yet: **F Task 64 Step 5** is what puts it there, and F runs after
  the whole of A. F Task 64's own Step 1 records the same fact from the other side — it measures
  `bodyLineHeight` before its sweep and expects `"normal"`. Once F Task 64 has landed, this same
  expression would answer `20.15px` (1.55 × 13px) without Step 2's fix, which is exactly the
  regression Step 2 is there to prevent; measuring it here, before the token reaches `body`, is why
  the answer is the bare keyword.

- [ ] **Step 2: Apply the token.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add to the `.tab-label`
  rule:

  ```css
    /* A single-line control has no use for body leading, and the extra height
       fights the fixed 14px indicator slot beside it. */
    line-height: var(--lh-tight);
  ```

- [ ] **Step 3: Rebuild and re-measure.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload and re-run Step 1.
  Expected: `"16.25px"` (13px × 1.25).

- [ ] **Step 4: Re-measure every claim this workstream made, in one call.**
  With one session tab open, one New Project tab open, and the docked browser open:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const mid = (el) => { const r = el.getBoundingClientRect(); return +(r.top + r.height / 2).toFixed(2) }; const tab = document.querySelector('.tab'); const close = tab.querySelector('.tab-close'); const cr = close.getBoundingClientRect(); const cg = close.querySelector('svg').getBoundingClientRect(); const ind = tab.querySelector('.tab-indicator').getBoundingClientRect(); const t = tab.getBoundingClientRect(); return { closeLeft: +(cg.left - cr.left).toFixed(2), closeRight: +(cr.right - cg.right).toFixed(2), barIcon: mid(document.querySelector('.titlebar-actions .icon-btn')), plus: mid(document.querySelector('.tabs > .icon-btn')), indicatorMid: mid(tab.querySelector('.tab-indicator')), indicatorW: +ind.width.toFixed(2), tabTop: +t.top.toFixed(2), tabBottom: +t.bottom.toFixed(2), nonTabChildren: [...document.querySelectorAll('[role=\"tablist\"]')].map((l) => [...l.children].filter((c) => c.getAttribute('role') !== 'tab').length) } })()"
  ```
  Expected:
  ```json
  {"closeLeft":3.5,"closeRight":3.5,"barIcon":21.5,"plus":21.5,"indicatorMid":21.5,"indicatorW":14,"tabTop":4,"tabBottom":43,"nonTabChildren":[0,0]}
  ```
  These are pre-migration numbers, and that is correct: workstream F runs after A, so neither the
  4px density sweep (F Task 64) nor the 12px icon (F Task 69) has landed. After F, `closeLeft` and
  `closeRight` both read `3` — F Task 74 re-measures the strip on that side of the migration. The
  assertion that survives both is `closeLeft === closeRight`.

- [ ] **Step 5: Screenshot the finished strip.**
  `screencapture -o -x /tmp/stoke-strip-final.png`, with a running session, an exited session, a
  watched session and a New Project tab all in the strip. Confirm by eye: one baseline, one width
  per indicator, exactly one red dot and it is on the watched session.

- [ ] **Step 6: Run the whole check.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run check
  ```
  Expected: exit 0, including `verify:tabs` and `verify:context`.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/styles/app.css && \
    git commit -m "Give the tab label its single-line leading

A tab label stated no line height at all, so it took the browser's default from
the font metrics and nothing in the repo said what a tab label's line box was.
That also left it about to inherit body leading of 1.55 the moment the density
migration puts --lh-normal on body — five pixels a one-line control cannot use,
fighting the fixed 14px indicator slot beside it. Stating --lh-tight here settles
it on both sides of that commit.

Closes workstream A: the close mark, the indicator and every title-bar icon now
share one centreline at 21.5, the indicator is 14px wide in every state, and both
tablists contain only tabs."
  ```

---

## Workstream F — sidebar, spacing and platform

Covers spec §4.F plus §2.10 and §2.11. **Every task here assumes contracts Tasks 1, 2, 3, 4 and 5
have landed** (`docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md`): the
`--space-*`, `--lh-*`, `--icon-*`, `--scrim`, `--swatch-ring`, `--shadow-panel`, `--on-danger`,
`--traffic-lights-w`, `--surface-selected`, `--chevron` and `--control-h` tokens are all *declared*
by contracts Task 4; `src/renderer/src/types.ts` already declares `TabKind` and carries `kind`,
`hostId`, `selectedPath` and `expandedPath` on `Tab` (contracts Task 2 Step 6a); `clampUiScale` /
`clampFontSize` already run inside `hydrateSettings`; and `scripts/cdp-eval.mjs` already exists.
This workstream is what *uses* all of that.

**Tasks in this part: 64–74.** An earlier draft had three more: one built a second
`scripts/cdp-eval.mjs` (contracts Task 5 owns it), one edited App.tsx's selection state (workstream
A owns it), and one was a verification-only pass with nothing to commit (merged into Task 64).

**Interfaces for the whole part:**
- Consumes: `scripts/cdp-eval.mjs` from contracts Task 5. Every measurement below runs through it;
  no task here creates it, and no task here writes its own probe. Because that probe has the page
  stringify the value, **every expected output below is compact JSON on one line** — `{"before":"block"}`,
  not `{ "before": "block" }`.
- Consumes: `.project-chevron`, `.project-pin` and `.project-meta-picker`, in both JSX and CSS, from
  D Task 38 (which lands the markup and its three rules in one commit).
- Consumes: `Tab.kind` and `Tab.selectedPath` (declared by contracts Task 2 Step 6a) and the whole
  New Project tab model from A Tasks 57–61.
  **Spec §4.F.1 — "clicking a project stops tearing down the running terminal" — is delivered by A
  Tasks 57–61, and its measurement is A Task 60 Step 7.** F does not touch App.tsx's selection
  state, and there is no `selectProject` / `setSelectedPath` / `setExpandedPath` edit anywhere in
  this part.

**Ordering, and why it is this order.** F runs last in the whole overhaul, and Task 64 runs first
within it. Task 64 is the entire 4px density migration in one commit — the `perl` over `app.css`
*and* the eight `.tsx` files, the deletion of the `--sp-*` block, `body`'s line height, the seven
literal line-height values and `src/remote/style.css`. It goes first because nothing between
contracts Task 4 and here has moved a pixel: every measurement taken by workstreams A, B, C, D and
E was against an intact layout, and every commit up to this point is visually correct. Everything
after 109 measures against the post-migration layout, which is why Task 68's
`[-26,-5]` → `[0,0]` pair is only correct on that side of it. Then come the sidebar behaviour and
appearance fixes (Tasks 65–68), the mechanisms (Tasks 69–71), the platform fix (Task 72) and the last
untokenised colours (Task 73). Task 74 is the density review the spec asks for, run when the
migration is one commit old rather than a hundred tasks old.

> **Line numbers in this part are hints, not addresses.** Four workstreams insert
> into `src/renderer/src/App.tsx`, `src/renderer/src/styles/app.css`,
> `src/main/index.ts`, `src/renderer/src/components/TitleBar.tsx`,
> `src/renderer/src/components/Sidebar.tsx` and four verify suites, so any figure
> written as "currently line N" is correct only for the first task that runs.
> **Locate every edit by the quoted text**, not by the number: for CSS, by the
> selector (`grep -n "^\.project-meta {" src/renderer/src/styles/app.css`); for
> TS/TSX, by a unique quoted line from the block being replaced; for the verify
> suites, by **that suite's own** closing summary/exit pair — the five shapes are listed in
> Global Constraints, and `verify-context.mts`, `verify-color.mts` and `verify-worklog-retry.mts`
> each differ from the rest — inserting immediately above it. If the
> quoted text is not found, stop — a prerequisite task has not landed or has
> landed differently, and guessing at the location is how two parts silently
> overwrite each other.

**Before the first task, launch the app with the debugger open** and leave it running; every task
below reuses it and each re-launches it after its own build.

```bash
cd /Users/thevinh/dev/personal/stoke
npm run build
npx electron . --remote-debugging-port=9222 &
sleep 6
node scripts/cdp-eval.mjs "getComputedStyle(document.documentElement).getPropertyValue('--space-8').trim()"
```

Expected: `"0.5rem"` — which also confirms contracts Task 4's token block landed.

---

---

### Task 64: The 4px density migration, in one commit

Contracts Task 4 *declared* the `--space-*` scale alongside the surviving `--sp-1 … --sp-8` block
and changed no existing declaration, so nothing has moved yet. This is the task that moves it: the
sweep over every `var(--sp-*)` use in the repo, the deletion of the old block, and the line-height
tokens applied to `body` and to the seven literal values.

It is one commit on purpose. A stylesheet that has been half-migrated is a stylesheet in which a
missed `var(--sp-2)` renders at 0 and looks like a bug in whatever landed next; and the guard that
catches a miss is a repo-wide grep, which can only be zero once.

**Mapping — contracts §0.6's table, verbatim. Do not invent a mapping.**

| Old | Old px | New | New px | Note |
|---|---|---|---|---|
| `--sp-1` | 4 | `--space-4` | 4 | unchanged |
| `--sp-2` | 6 | `--space-8` | 8 | **+2px** |
| `--sp-3` | 8 | `--space-8` | 8 | unchanged |
| `--sp-4` | 12 | `--space-12` | 12 | unchanged |
| `--sp-5` | 16 | `--space-16` | 16 | unchanged |
| `--sp-6` | 20 | `--space-24` | 24 | **+4px** |
| `--sp-7` | 28 | `--space-24` | 24 | **−4px** |
| `--sp-8` | 40 | `--space-48` | 48 | no uses; mapped for completeness |

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — the `--sp-*` block,
  every `var(--sp-*)` use, the `body` rule, and the seven literal `line-height` values
- Modify, all under `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/`:
  `HostsSettings.tsx`, `Launcher.tsx`, `ProfilesSettings.tsx`, `CommandPalette.tsx`, `Sidebar.tsx`,
  `SettingsSheet.tsx`, `RemoteSettings.tsx`, `WorklogSettings.tsx`
- Modify: `/Users/thevinh/dev/personal/stoke/src/remote/style.css` — one dangling token
- Test: the repo-wide `grep` in steps 1 and 4, and the CDP measurements in step 6

**Interfaces:**
- Consumes: `--space-4`, `--space-8`, `--space-12`, `--space-16`, `--space-24`, `--space-48`,
  `--lh-tight`, `--lh-snug`, `--lh-normal` (contracts Task 4); `scripts/cdp-eval.mjs` (contracts
  Task 5).
- Produces: nothing new. After this task `grep -rn -- '--sp-' src/` returns **zero** hits repo-wide
  — the greppability is the whole reason the contract renamed rather than renumbered.

- [ ] **Step 1: Count what has to move, and check its shape.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -rn -- '--sp-' src/ | wc -l
  ```
  Expected: `138`.

  The derivation, so a different number is diagnosable rather than alarming. The repo held **141**
  before the overhaul began — 8 declarations in `:root`, 132 uses across `app.css` and eight `.tsx`
  files, and one dangling `var(--sp-2, 8px)` in `src/remote/style.css`. Workstream A removed exactly
  three of those lines on its way through: A Task 49 rewrote `.tab`'s `padding: 0 var(--sp-2) 0
  var(--sp-3);` and A Task 54 rewrote `.tabs`'s `gap` and `padding-top`. Nothing else in
  workstreams A, B, C, D or E adds or removes a `--sp-` use; every new rule they wrote uses
  `--space-*`, which contracts Task 4 declared for exactly that reason.

  A number **above** 138 means something reintroduced the old names — find it with
  `grep -rn -- '--sp-' src/` and fix that first. A number **below** 138 means part of the migration
  has already happened somewhere, which is the state this task exists to make impossible; find which
  file and check that it used the table above and not a guess. Either way the shape must hold:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -rno -- '--sp-[0-9]' src/ | grep -v -- '--sp-[1-8]'
  ```
  Expected: nothing. Every hit is `--sp-1` … `--sp-8`; there is no `--sp-0`, no `--sp-9`, and
  therefore nothing outside the mapping table.

  Then record the two figures the migration must not silently change:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ tabPadding: getComputedStyle(document.querySelector('.tab')).paddingInline, sidebarGap: getComputedStyle([...document.querySelectorAll('.sidebar-head > div')].pop()).columnGap, bodyLineHeight: getComputedStyle(document.body).lineHeight })"
  ```
  Expected before this task: `{"tabPadding":"8px","sidebarGap":"6px","bodyLineHeight":"normal"}`.
  `tabPadding` is already `"8px"` because A Task 49 rewrote `.tab`'s padding on its way to fixing the
  centreline. `sidebarGap` is `"6px"`: that row is the Open / Scratch pair at `Sidebar.tsx:186`,
  `<div style={{ display: 'flex', gap: 'var(--sp-2)' }}>`, and `--sp-2` is `0.375rem` at
  `app.css:55` — contracts Task 4 declared `--space-*` *alongside* the `--sp-*` block rather than
  replacing it, so the old token still resolves here and this element still computes to 6px. Step 3
  is what rewrites that inline `var(--sp-2)` to `var(--space-8)`, taking it to `"8px"`.
  `bodyLineHeight` is `"normal"` because `body` has never set one.

  > If `sidebarGap` reads `"normal"` rather than `"6px"`, `--sp-2` has already been deleted from
  > `:root` — meaning some earlier task removed the old token block instead of leaving it for Step 2.
  > Stop: every `var(--sp-*)` still in the eight `.tsx` files is rendering at 0, and every geometry
  > measurement taken since that task is wrong.

- [ ] **Step 2: Sweep `app.css`.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke/src/renderer/src/styles && \
  perl -pi -e 's/var\(--sp-1\)/var(--space-4)/g;  s/var\(--sp-2\)/var(--space-8)/g;
               s/var\(--sp-3\)/var(--space-8)/g;  s/var\(--sp-4\)/var(--space-12)/g;
               s/var\(--sp-5\)/var(--space-16)/g; s/var\(--sp-6\)/var(--space-24)/g;
               s/var\(--sp-7\)/var(--space-24)/g; s/var\(--sp-8\)/var(--space-48)/g;' app.css
  ```

- [ ] **Step 3: Sweep the eight `.tsx` files.**
  These are `style={{ }}` objects, which the `app.css` sweep cannot reach and which a stylesheet-only
  grep would never have reported. Until they are migrated they name a token that no longer exists —
  invalid at computed-value time — so those gaps and paddings render at 0.

  ```bash
  cd /Users/thevinh/dev/personal/stoke/src/renderer/src/components && \
  perl -pi -e 's/var\(--sp-1\)/var(--space-4)/g;  s/var\(--sp-2\)/var(--space-8)/g;
               s/var\(--sp-3\)/var(--space-8)/g;  s/var\(--sp-4\)/var(--space-12)/g;
               s/var\(--sp-5\)/var(--space-16)/g; s/var\(--sp-6\)/var(--space-24)/g;
               s/var\(--sp-7\)/var(--space-24)/g; s/var\(--sp-8\)/var(--space-48)/g;' \
    HostsSettings.tsx Launcher.tsx ProfilesSettings.tsx CommandPalette.tsx \
    Sidebar.tsx SettingsSheet.tsx RemoteSettings.tsx WorklogSettings.tsx
  ```

  `WorklogSettings.tsx` has one `var(--sp-2)`; it is a mechanical substitution and does not conflict
  with C Task 21, which added controls to the same file.

- [ ] **Step 4: Delete the old block, fix the phone, and prove nothing is left.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, delete the eight
  `--sp-1: …` … `--sp-8: …` declarations from `:root` (locate them by
  `grep -n -- '--sp-1:' src/renderer/src/styles/app.css`). The `--space-*` block contracts Task 4
  added sits directly beneath them; nothing else in `:root` changes.

  In `/Users/thevinh/dev/personal/stoke/src/remote/style.css`, change
  `padding: var(--sp-2, 8px) 12px;` to `padding: 8px 12px;`. That token was never defined in the
  remote bundle — the phone UI is a separate build that does not import the desktop tokens — so it
  already rendered at 8px and this changes nothing except the dangling name.

  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -rn -- '--sp-' src/ | wc -l
  ```
  Expected: `0`. Any remaining hit is the migration's entire risk — that declaration is now invalid
  and its padding has collapsed to 0. Fix it by the table above before moving on.

- [ ] **Step 5: Apply the line-height tokens.**
  In the same file, add `line-height: var(--lh-normal);` to the **typography** `body` rule.

  There are **two** `body` rules and `grep -n "^body {"` returns both — line 22, the reset, whose
  only declaration is `overflow: hidden`, and line 97, the typography rule that sets `font-family`,
  `font-size`, `color` and `background`. The line height belongs to the second. Locate that one
  unambiguously, one hit:

  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "^  font-family: var(--sans);$" src/renderer/src/styles/app.css
  ```
  Expected: `98:  font-family: var(--sans);` — the rule opens on the line above it. Add
  `line-height: var(--lh-normal);` immediately after that rule's `font-size: var(--fs-base);` line.
  Putting it on the line-22 reset instead would work by inheritance today and silently stop working
  the moment anything sets a line height on `body`, which is exactly what this step is doing.

  Then replace the seven literal `line-height` values **by value, not by line number**:

  | Current value | New |
  |---|---|
  | `line-height: 1.4` | `line-height: var(--lh-snug)` |
  | `line-height: 1.45` | `line-height: var(--lh-normal)` |
  | `line-height: 1.5` | `line-height: var(--lh-normal)` |
  | `line-height: 1.55` (two of them) | `line-height: var(--lh-normal)` |
  | `line-height: 1.6` (two of them) | `line-height: var(--lh-normal)` |

  Find them with `grep -n "line-height: 1\." src/renderer/src/styles/app.css`; after this step that
  grep returns nothing. `line-height: 1` (bare, no decimal point) on `.project-emoji-glyph` and
  `.project-emoji-option` is a deliberate glyph-box collapse and is **not** in this table — leave it.
  `--lh-tight` gains its first uses in Task 70; A Task 63 already put it on `.tab-label`.

- [ ] **Step 6: Rebuild, relaunch, and measure the three figures.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  node scripts/cdp-eval.mjs "({ tabPadding: getComputedStyle(document.querySelector('.tab')).paddingInline, sidebarGap: getComputedStyle([...document.querySelectorAll('.sidebar-head > div')].pop()).columnGap, bodyLineHeight: getComputedStyle(document.body).lineHeight })"
  ```
  Expected: `{"tabPadding":"8px","sidebarGap":"8px","bodyLineHeight":"21.7px"}`.

  `sidebarGap` is the change that proves the `.tsx` half ran: that element is the Open / Scratch
  button row, whose `gap` was an inline `var(--sp-2)`, so the two buttons were touching before this
  task. `21.7px` is `--lh-normal` 1.55 × the 14px `--fs-base`; if the body font size differs on the
  machine the number is `1.55 × fs-base`, and what must never come back is a bare `"normal"`.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add -A src/ && \
    git commit -m "Move to a strict 4px scale, and give line height a token at last

The old scale was 4/6/8/12/16/20/28/40 with five ad-hoc line heights and none on
body. The rename to --space-* rather than a renumber is what makes a missed use
loud: var(--sp-2) now names nothing, the declaration is invalid at computed-value
time, and the padding visibly collapses to 0 — so the migration is verified by a
repo-wide grep returning zero. A sweep over the stylesheet was not the whole job:
26 uses were inside style={{ }} objects in eight .tsx files, which is why the
Open/Scratch row's gap was rendering as 'normal' rather than as a number.

116 declarations become 8px — 92 in app.css and 24 in those eight .tsx files —
and four become 24px. That is the visible density change spec 4.F.6 asks to
review, and Task 74 reviews it."
  ```

---

### Task 65: Enter and Space do what the row's own click does

Spec §2.10: Enter starts a session and Space selects. The row carries `role="button"`, and the one
promise that role makes is that Enter and Space both fire what a click fires — so a keyboard user
pressing the obvious key got a spawned `claude` process instead of the selection the mouse gives.
The double-click escalation keeps a keyboard route of its own.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx` — the
  `onKeyDown` handler and `title` on the `.project` div. Locate them by
  `grep -n 'role="button"' src/renderer/src/components/Sidebar.tsx`; D Task 38 rewrote the
  `.project-top` block inside this element, so its line numbers have moved.
- Test: `node scripts/cdp-eval.mjs`, step 3 below.

**Interfaces:**
- Consumes: the existing `Props` callbacks `onSelectProject: (p: Project) => void` and
  `onStartNew: (p: Project) => void` (`Sidebar.tsx`). No prop changes.
- Consumes: `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: no new exports. Behaviour: `Enter` and `Space` → `onSelectProject`;
  `Cmd+Enter` / `Ctrl+Enter` → `onStartNew`.

- [ ] **Step 1: Measure the defect.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = document.querySelectorAll('.project')[1] ?? document.querySelector('.project')
    row.focus()
    const tabsBefore = document.querySelectorAll('.tabs .tab').length
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(1500)
    return {
      current: row.getAttribute('aria-current'),
      tabsBefore,
      tabsAfter: document.querySelectorAll('.tabs .tab').length
    }
  })()"
  ```

  Expected now: `tabsAfter` is `tabsBefore + 1` and `current` is `"false"` — Enter spawned a session
  and selected nothing.

- [ ] **Step 2: Correct the mapping.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx`, replace the
  `onKeyDown` and `title` on the `.project` div (currently lines 247-256) with:

  ```tsx
                    onKeyDown={(e) => {
                      /*
                       * Enter and Space both do exactly what a click does.
                       *
                       * This row announces itself as `role="button"`, and the
                       * one promise that role makes is that both keys fire the
                       * element's own click. It used to start a session on
                       * Enter and select on Space, so assistive tech said
                       * "button", the user pressed the obvious key, and got a
                       * spawned process instead of a selection.
                       *
                       * Starting a session is the double-click escalation, so
                       * it keeps a modifier of its own rather than losing its
                       * keyboard route. metaKey OR ctrlKey, so the component
                       * needs no platform prop to be right on both.
                       */
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        onStartNew(project)
                      } else if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelectProject(project)
                      }
                    }}
                    title={`${project.path}\nEnter selects · Cmd/Ctrl+Enter starts a session`}
  ```

- [ ] **Step 3: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected: `current` is `"true"` and `tabsAfter` equals
  `tabsBefore` — Enter selected the row and started nothing.

- [ ] **Step 4: Commit.**
  ```bash
  git commit -am "Make Enter on a project row do what clicking it does"
  ```
  Body records the bug: the row is `role="button"` but Enter started a session while Space selected,
  so the key every convention makes primary was the one that spawned a process.

---

### Task 66: Selection out-ranks hover, on every theme, measurably

Spec §2.10: `.project:hover` uses `--surface-hover` and `.project[aria-current]` uses `--surface`,
and in all three dark themes the hover reads stronger — the selected project looks less chosen than
whatever the mouse is over. This is measurable, so it is measured rather than eyeballed.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts` — the import block and a new
  block before the final tally;
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — `.project:hover`,
  `.project[aria-current='true']` and `.project[aria-current='true'] .project-name`. Locate them
  with `grep -n "^\.project:hover {\|^\.project\[aria-current" src/renderer/src/styles/app.css`.
- Test: `npm run verify:color`

**Interfaces:**
- Consumes: `parseColor`, `over`, `perceptualDistance`, `contrastRatio`, `Rgb` from
  `src/shared/color.ts`; `BUILT_IN_THEMES` from `src/shared/themes.ts`; `Theme` from
  `src/shared/types.ts`; the token `--surface-selected` (contracts Task 4).
- Produces: `SELECTED_ACCENT_MIX = 0.18` in `scripts/verify-color.mts` — the mirror of the token's
  own `color-mix` percentage, landed in the same commit as the rule that first uses it.

**This task does not declare `--surface-selected`.** Contracts Task 4 declares it, along with
`--chevron` and `--control-h`, precisely so that no workstream invents a `--row-selected` halfway
down its own part. Confirm it is there before starting:
`grep -n -- "--surface-selected:" src/renderer/src/styles/app.css` must print exactly one hit,
inside `:root`, reading
`--surface-selected: color-mix(in srgb, var(--accent) 18%, var(--surface-hover));`. It follows the
live `--accent`, so it tracks a profile switch with no extra writer. Nothing has referenced it yet,
so declaring it moved no pixel.

- [ ] **Step 1: Encode today's rule as an assertion, and watch it fail.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts`, extend the import block (locate it
  by `grep -n "from '../src/shared/color.ts'" scripts/verify-color.mts`) to:

  ```ts
  import {
    apcaContrast,
    contrastRatio,
    over,
    parseColor,
    perceptualDistance,
    toHex,
    toOklch
  } from '../src/shared/color.ts'
  import type { Rgb } from '../src/shared/color.ts'
  import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
  import type { Theme } from '../src/shared/types.ts'
  ```

  and insert this block immediately **before** the final
  `console.log(failures ? \`\n${failures} failure(s)\` : '\nall colour checks pass')` line:

  ```ts
  console.log('\n-- the sidebar: selection must out-rank hover --')
  /*
   * The selected project has to read as more chosen than the row the mouse
   * happens to be over. That is a distance, not a taste: how far each state
   * sits from the panel it is drawn on. Hover is `--surface-hover`; selection
   * is whatever `selectedBg` returns, which must stay in step with
   * `--surface-selected` in app.css. If you change one, change the other —
   * this is the assertion that catches it.
   */
  function selectedBg(t: Theme): Rgb {
    return parseColor(t.colors.surface)!
  }

  for (const t of BUILT_IN_THEMES) {
    const panel = parseColor(t.colors.bgSunken)!
    const hoverD = perceptualDistance(panel, over(parseColor(t.colors.surfaceHover)!, panel))
    const selD = perceptualDistance(panel, over(selectedBg(t), panel))
    const ok = selD > hoverD
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: selection vs hover`.padEnd(46)} ${selD
        .toFixed(4)
        .padStart(10)}  (expected > ${hoverD.toFixed(4)})`
    )
  }

  for (const t of BUILT_IN_THEMES) {
    // The row's own label still has to be readable on whatever selection is.
    const bg = over(selectedBg(t), parseColor(t.colors.bgSunken)!)
    const ratio = contrastRatio(parseColor(t.colors.text)!, bg)
    const ok = ratio >= 4.5
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: label on a selected row`.padEnd(46)} ${ratio
        .toFixed(2)
        .padStart(10)}  (expected >= 4.5)`
    )
  }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && npm run verify:color`
  Expected, exactly:

  ```
  -- the sidebar: selection must out-rank hover --
  FAIL ember: selection vs hover                            0.0792  (expected > 0.1136)
  FAIL nocturne: selection vs hover                         0.0873  (expected > 0.1279)
  FAIL moss: selection vs hover                             0.0950  (expected > 0.1339)
  ok   daylight: selection vs hover                         0.0536  (expected > 0.0181)
  ```

  followed by four `ok` label lines and `3 failure(s)`, exit 1. The three dark themes are exactly
  the three spec §2.10 named.

- [ ] **Step 3: Apply the token.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace the three project
  rules — locate them with
  `grep -n "^\.project:hover {\|^\.project\[aria-current" src/renderer/src/styles/app.css` — with:

  ```css
  .project:hover {
    background: var(--surface-hover);
  }

  /*
   * Selection out-ranks hover.
   *
   * `--surface` measured *closer* to the panel than `--surface-hover` on all
   * three dark themes, so the row the mouse was over read as more chosen than
   * the row that actually was, and the sidebar read as broken rather than
   * merely subtle. The command palette already had the right idea
   * (`.palette-item[data-active='true']`, an accent wash); this is the same
   * move with enough accent in it to win on every theme.
   *
   * The hover pair is restated so a selected row does not drop back to the
   * hover grey under the pointer.
   */
  .project[aria-current='true'],
  .project[aria-current='true']:hover {
    background: var(--surface-selected);
    border-color: transparent;
  }
  ```

  ```css
  /*
   * `--text`, not `--accent`. The background now carries the selection, and
   * accent-on-selected measures 4.27:1 on Nocturne and 3.59:1 on Daylight —
   * under AA. Weight carries the emphasis instead, which costs no contrast.
   */
  .project[aria-current='true'] .project-name {
    color: var(--text);
    font-weight: 600;
  }
  ```

- [ ] **Step 4: Move the suite onto the new recipe and watch it pass.** In
  `scripts/verify-color.mts`, replace the `selectedBg` function added in step 1 with:

  ```ts
  /** `--surface-selected` in app.css: color-mix(in srgb, accent 18%, surface-hover). */
  const SELECTED_ACCENT_MIX = 0.18

  function selectedBg(t: Theme): Rgb {
    const a = parseColor(t.colors.accent)!
    const b = over(parseColor(t.colors.surfaceHover)!, parseColor(t.colors.bgSunken)!)
    const p = SELECTED_ACCENT_MIX
    return {
      r: a.r * p + b.r * (1 - p),
      g: a.g * p + b.g * (1 - p),
      b: a.b * p + b.b * (1 - p),
      a: 1
    }
  }
  ```

  Run `npm run verify:color`. Expected, exactly:

  ```
  -- the sidebar: selection must out-rank hover --
  ok   ember: selection vs hover                            0.2152  (expected > 0.1136)
  ok   nocturne: selection vs hover                         0.2181  (expected > 0.1279)
  ok   moss: selection vs hover                             0.2409  (expected > 0.1339)
  ok   daylight: selection vs hover                         0.0658  (expected > 0.0181)
  ok   ember: label on a selected row                         8.88  (expected >= 4.5)
  ok   nocturne: label on a selected row                      8.57  (expected >= 4.5)
  ok   moss: label on a selected row                          8.00  (expected >= 4.5)
  ok   daylight: label on a selected row                     11.46  (expected >= 4.5)
  ```

  ending `all colour checks pass`, exit 0.

  `SELECTED_ACCENT_MIX = 0.18` and the token's own `18%` are two statements of one number in two
  files, which is what the comment above `--surface-selected` in `app.css` says out loud. This
  assertion is what catches them disagreeing, and it lands in the same commit as the rule that first
  uses the token — so there is never a build in which the mirror exists and the rule does not.

- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "Make a selected project out-shout a hovered one, and prove it"
  ```
  Body records the bug and the numbers: selection used `--surface` and hover `--surface-hover`, which
  measured 0.0792 vs 0.1136 from the panel on Ember and the same way round on Nocturne and Moss, so
  the selected row was the quieter of the two; and accent-coloured selected text would have measured
  4.27:1 on Nocturne, so the emphasis moved to weight.

---

### Task 67: The session behind the open terminal is marked as such

Spec §2.10: there is no `aria-current`, `data-active` or `aria-selected` on any `.session` rule at
all, so the session you are running is drawn identically to the eleven you are not.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx` — `Props`
  (lines 9-34), the destructure (lines 36-56), a memo, and the `.session` button (lines 327-332);
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — a memo plus one new `<Sidebar>`
  prop; `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — two new rules after
  `.session:hover` (currently lines 810-812).
- Test: `node scripts/cdp-eval.mjs`, step 1 and step 5 below.

**Interfaces:**
- Consumes: `Tab.sessionId: string` from
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts` (**contracts Task 2 Step 6a** is the
  only step that writes that file; `sessionId` itself is one of the fields it carries over
  unchanged); `SessionMeta.id: string` (`@shared/types`); the `--surface-selected` token (contracts
  Task 4, first used by Task 66); `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: new `Sidebar` prop `openSessionIds: string[]` — "session ids that currently have a tab
  open". Passed from `App.tsx` as a memo over `tabs`.

- [ ] **Step 1: Measure the defect.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = [...document.querySelectorAll('.project')].find((r) => /\\\\d+ session/.test(r.textContent))
    row.querySelector('.project-chevron').click()
    for (let i = 0; i < 40 && !document.querySelector('.sessions .session'); i++) await sleep(250)
    document.querySelector('.sessions .session').click()
    for (let i = 0; i < 60 && !document.querySelector('.tabs .tab'); i++) await sleep(250)
    await sleep(800)
    const hit = document.querySelector('.sessions .session[aria-current=\\\"true\\\"]')
    return {
      marked: document.querySelectorAll('.sessions .session[aria-current=\\\"true\\\"]').length,
      bg: hit ? getComputedStyle(hit).backgroundColor : null
    }
  })()"
  ```

  Expected now: `{"marked":0,"bg":null}`.

- [ ] **Step 2: Take the new prop in `Sidebar`.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx`, add to `Props`
  immediately after `sessionsLoading: boolean` (line 16):

  ```tsx
  /**
   * Session ids that currently have a tab open. The row backing the terminal
   * you are looking at is the one row in this list worth finding again, and it
   * had no state of its own at all.
   */
  openSessionIds: string[]
  ```

  add `openSessionIds,` to the destructured parameter list immediately after `sessionsLoading,`,
  and add this memo immediately after the `available` binding (locate it by
  `grep -n "const available = " src/renderer/src/components/Sidebar.tsx`; D Task 38 added a
  `pickerPath` state above it, so it has moved):

  ```tsx
  /* A Set so a project with a long history is one lookup per row, not a scan. */
  const openSessions = useMemo(() => new Set(openSessionIds), [openSessionIds])
  ```

- [ ] **Step 3: Mark the row.** In the same file, replace the opening tag of the session button —
  locate it by `grep -n 'className="session"' src/renderer/src/components/Sidebar.tsx` — with:

  ```tsx
                          <button
                            key={s.id}
                            className="session"
                            aria-current={openSessions.has(s.id) ? 'true' : undefined}
                            onClick={() => onResume(s)}
                            title={s.firstPrompt ?? s.id}
                          >
  ```

- [ ] **Step 4: Feed it from `App`.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, immediately after the `activeTab`
  binding (locate it by `grep -n "const activeTab = " src/renderer/src/App.tsx`), add:

  ```tsx
  /* Memoised: a fresh array each render would rebuild the Sidebar's Set on every tick. */
  const openSessionIds = useMemo(() => tabs.map((t) => t.sessionId), [tabs])
  ```

  and add the prop to `<Sidebar>` immediately after `sessionsLoading={sessionsLoading}`. That is the
  only `<Sidebar>` prop this task adds: `onSetMeta` is D Task 38's and `onSelectProject` /
  `onToggleExpand` are A Task 60's, and all three have already landed.

  ```tsx
                openSessionIds={openSessionIds}
  ```

- [ ] **Step 5: Give it a state.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, immediately after the
  `.session:hover` rule (locate it by `grep -n "^\.session:hover {" src/renderer/src/styles/app.css`),
  add:

  ```css
  /*
   * The session behind the open terminal. There was no such state at all, so
   * the one row you were actually looking at and the twelve you were not were
   * drawn identically. Same wash as a selected project, because it means the
   * same thing one level down.
   */
  .session[aria-current='true'] {
    background: var(--surface-selected);
  }

  .session[aria-current='true'] .session-title {
    font-weight: 600;
  }
  ```

- [ ] **Step 6: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected: `"marked":1`, and `bg` a non-transparent
  colour — `{"marked":1,"bg":"rgb(81, 57, 42)"}` on the default Ember theme (the 18% accent mix; the
  triple differs per theme and per active profile, so `bg !== null` is the assertion).

- [ ] **Step 7: Commit.**
  ```bash
  git commit -am "Mark the session row the open terminal is running"
  ```
  Body records: no `.session` rule carried any selected state, so the row backing the live terminal
  was indistinguishable from every other row in the list.

---

### Task 68: One vertical for a project's name, its metadata and its sessions

Spec §2.10: the nested session list is outdented from its parent project title, and the project's
metadata line hangs left of the project's own name, so a row reads as two fragments. Both are the
same defect — three things that belong on one vertical are on three.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — `.project-meta` and
  `.sessions`, and nothing else. Locate both with
  `grep -n "^\.project-meta {\|^\.sessions {" src/renderer/src/styles/app.css`.
- Test: `node scripts/cdp-eval.mjs`, step 1 and step 3 below.

**This task touches `app.css` only.** It does not declare `--chevron` — contracts Task 4 does — and
it does not touch `Sidebar.tsx`: D Task 38 is the sole writer of the `.project-top` block, and it
landed `.project-chevron`, `.project-pin` and `.project-meta-picker` in both JSX and CSS in one
commit, so there was never an intermediate state with an unsized chevron. Confirm all three are
already there before starting:

```bash
\
  grep -n -- "--chevron:" src/renderer/src/styles/app.css && \
  grep -n "^\.project-chevron {\|^\.project-pin {\|^\.project-meta-picker {" src/renderer/src/styles/app.css && \
  grep -n "project-chevron\|project-meta-picker" src/renderer/src/components/Sidebar.tsx
```

Expected: one `--chevron: 1.125rem;` inside `:root`, the three rules, and the two class names in the
JSX. If any is missing, D Task 38 has not landed and the arithmetic below is wrong.

**Interfaces:**
- Consumes: `--chevron` (contracts Task 4); `--space-4`, `--space-8` (contracts Task 4, migrated
  into use by Task 64); `--border` (existing); `.project-meta-picker` and `.project-chevron`
  (D Task 38); `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing new.

- [ ] **Step 1: Measure the two offsets.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = [...document.querySelectorAll('.project')].find((r) => /\\\\d+ session/.test(r.textContent))
    row.querySelector('.project-chevron').click()
    for (let i = 0; i < 40 && !document.querySelector('.sessions .session'); i++) await sleep(250)
    const name = row.querySelector('.project-meta-picker').getBoundingClientRect().left
    const meta = row.querySelector('.project-meta > *').getBoundingClientRect().left
    const title = row.parentElement.querySelector('.sessions .session-title').getBoundingClientRect().left
    return [Math.round(meta - name), Math.round(title - name)]
  })()"
  ```

  Expected now: `[-26,-5]` — the metadata sits 26px left of the icon-and-name it describes, and a
  session title 5px left of the project it belongs to.

  **The anchor is `.project-meta-picker`, not `.project-name`, and that is the whole arithmetic.**
  D Task 38 put a folder icon in front of the name, and the icon is part of the title: `.project`
  pads 8px, the chevron is 18px (`--chevron`), `.project-top`'s gap is 8px after Task 64 — so the
  picker's left edge is at 34px and `.project-name` is now at 60px. Metadata and session rows have to
  line up with the *emoji*, because that is where the title starts. Measuring from `.project-name`
  would report `[-52,-31]` and lead you to indent everything by another 26px, which would put the
  guide rule through the middle of the folder icon.

- [ ] **Step 2: Put the three on one vertical.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace exactly two rules —
  `.project-meta` and `.sessions`. Locate them with
  `grep -n "^\.project-meta {\|^\.sessions {" src/renderer/src/styles/app.css`. Leave
  `.project-chevron`, `.project-pin` and `.project-meta-picker` alone: D Task 38 owns all three.

  ```css
  .project-meta {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    /* Indented to start under the project's own icon-and-name rather than under
       the chevron's left edge. Unindented, the row read as two fragments 26px
       apart: a title over here, its own session count over there. */
    padding-left: calc(var(--chevron) + var(--space-8));
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
  ```

  ```css
  .sessions {
    display: flex;
    flex-direction: column;
    gap: 1px;
    /*
     * The guide rule falls on the centre of the disclosure chevron, and the two
     * paddings past it add up to the chevron's other half plus the gap after
     * it — so a session title starts on exactly the same pixel as the project
     * name above it. 8 + 9 = 17 to the rule, + 1 border + 8 + 8 = 34, which is
     * .project's padding (8) + the chevron (18) + .project-top's gap (8).
     * Measured, not reasoned: it used to sit 5px to the left of the title it
     * belongs to, which is enough to read as a mistake and not enough to read
     * as a decision.
     */
    margin: var(--space-4) 0 var(--space-8) calc(var(--space-8) + var(--chevron) / 2);
    padding-left: var(--space-8);
    border-left: 1px solid var(--border);
  }
  ```

  The Launcher's "Resume a session" list overrides `margin`, `paddingLeft` and `borderLeft` inline
  (find it with `grep -n "borderLeft" src/renderer/src/components/Launcher.tsx`), so it is
  unaffected by both.

- [ ] **Step 3: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected: `[0,0]`. Then capture the sidebar:
  `node scripts/cdp-eval.mjs --shot /tmp/stoke-sidebar-aligned.png` and confirm from the image that
  the guide rule sits under the chevron and that the folder icon, the metadata line and the session
  titles share one left edge.

- [ ] **Step 4: Commit.**
  ```bash
  git commit -am "Put a project's name, its metadata and its sessions on one vertical"
  ```
  Body records: `.project-meta` was unindented while its own title sat 26px in, and `.sessions`'
  left margin put every session title 5px left of the project it belongs to. Both now derive from
  `--chevron`, the one token that names the disclosure control's box — the size used to be an inline
  style in `Sidebar.tsx`, which is exactly how the rules that have to agree about it drifted apart.

---


### Task 69: Icons size themselves in rem, so Interface scale moves them too

Spec §2.11: every SVG carries fixed px attributes — `width="16"` and `height="16"` at
`Icons.tsx:8-9`, on the `<svg>` opened at line 7 inside `Base` — so Interface scale resizes every
button and leaves every glyph behind — a 37.5% linear (61% areal) change between scale 1.0 and 1.6.
The mechanism is the contract's (§0.6), applied here.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Icons.tsx` (the `Base`
  function); `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (a new `.icon` rule,
  plus `--icon-size` on six containers); and the fifteen call sites listed in step 4.
- Test: `node scripts/cdp-eval.mjs`, steps 1 and 6.

**Interfaces:**
- Consumes: `--icon-xs` (0.625rem), `--icon-sm` (0.75rem), `--icon-md` (0.875rem), `--icon-lg` (1rem)
  — all declared by contracts Task 4; `.project-chevron` and `.project-pin` (D Task 38);
  `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: a `.icon` class emitted by `Base`, and the rule
  `.icon { width: var(--icon-size, var(--icon-lg)); height: var(--icon-size, var(--icon-lg)); flex: none }`.
  A container states its glyph size by setting `--icon-size`; no pixel count passes through a React
  prop again.

- [ ] **Step 1: Measure the defect.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const root = document.documentElement
    const read = () => {
      const btn = document.querySelector('.titlebar-actions .icon-btn')
      return [
        Math.round(btn.getBoundingClientRect().width),
        Math.round(btn.querySelector('svg').getBoundingClientRect().width)
      ]
    }
    const out = {}
    for (const s of ['1', '1.6']) {
      root.style.setProperty('--ui-scale', s)
      await sleep(80)
      out[s] = read()
    }
    root.style.setProperty('--ui-scale', '1')
    return out
  })()"
  ```

  Expected now: `{"1":[28,16],"1.6":[45,16]}` — the button grew 60% and the glyph did not move at
  all.

- [ ] **Step 2: Stop `Base` emitting pixel attributes.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Icons.tsx`, replace the `Base`
  function (locate it by `grep -n "function Base(" src/renderer/src/components/Icons.tsx`) with:

  ```tsx
  /**
   * One consistent icon vocabulary: 16px grid, 1.5 stroke, round caps.
   *
   * No `width`/`height` attributes. Size comes from the `.icon` rule in
   * app.css, in rem, so a glyph grows with Interface scale — every icon used to
   * be a fixed px attribute, which is why scale 1.0 → 1.6 moved every button
   * 37.5% linear and left every glyph exactly where it was. A container states
   * its size by setting `--icon-size`.
   *
   * `{...rest}` stays last so a caller can still override viewBox and stroke
   * width, which IconGear does.
   */
  function Base(props: SVGProps<SVGSVGElement>): React.JSX.Element {
    const { children, className, ...rest } = props
    return (
      <svg
        className={className ? `icon ${className}` : 'icon'}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {children}
      </svg>
    )
  }
  ```

- [ ] **Step 3: Add the one rule that sizes every icon.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, immediately after the
  `.truncate` rule (locate it by `grep -n "^\.truncate {" src/renderer/src/styles/app.css`), add:

  ```css
  /*
   * One rule sizes every icon. A container states its size by setting
   * --icon-size; nothing passes a pixel count through a React prop.
   * `flex: none` because an icon beside a truncating label must not be the
   * thing that shrinks.
   */
  .icon {
    width: var(--icon-size, var(--icon-lg));
    height: var(--icon-size, var(--icon-lg));
    flex: none;
  }
  ```

- [ ] **Step 4: Delete every size attribute at the call sites.** Remove the
  `width={n} height={n}` props from these fifteen `Icons.tsx` usages, leaving the rest of each tag
  untouched. **Anchor on the quoted tag text, not on a line number** — A Task 54 re-indented
  `TitleBar.tsx`'s tab map and D Task 38 rewrote `Sidebar.tsx`'s `.project-top` block, so the
  numbers below are stale by construction. Find them all in one pass:

  ```bash
  grep -rn "width={1[0-3]} height={1[0-3]}" src/renderer/src/components/
  ```

  Expected: fifteen hits across the fourteen rows of the table — `BrowserPanel.tsx` contributes two
  `IconPlus` tags on one row, which is why the counts differ. Per file:
  `BrowserPanel.tsx` 9, `Sidebar.tsx` 2, and one each in `TitleBar.tsx`, `HostsSettings.tsx`,
  `SettingsSheet.tsx` and `ProfilesSettings.tsx`. The `width={180} height={180}` on the QR code in
  `RemoteSettings.tsx` is an `<img>`, **not** an `Icons.tsx` glyph, and the grep above deliberately
  does not match it — leave it alone.

  | File | Tag today | Becomes |
  |---|---|---|
  | `components/TitleBar.tsx` | `<IconClose width={11} height={11} />` | `<IconClose />` |
  | `components/BrowserPanel.tsx` | `<IconClose width={10} height={10} />` | `<IconClose />` |
  | `components/BrowserPanel.tsx` | `<IconPlus width={13} height={13} />` (two of them) | `<IconPlus />` |
  | `components/BrowserPanel.tsx` | `<IconAsk width={13} height={13} />` | `<IconAsk />` |
  | `components/BrowserPanel.tsx` | `<IconMinus width={13} height={13} />` | `<IconMinus />` |
  | `components/BrowserPanel.tsx` | `<IconCode width={13} height={13} />` | `<IconCode />` |
  | `components/BrowserPanel.tsx` | `<IconArrowLeft width={13} height={13} />` | `<IconArrowLeft />` |
  | `components/BrowserPanel.tsx` | `<IconArrowRight width={13} height={13} />` | `<IconArrowRight />` |
  | `components/BrowserPanel.tsx` | `<IconClose width={13} height={13} />` | `<IconClose />` |
  | `components/SettingsSheet.tsx` | `<IconClose width={12} height={12} />` | `<IconClose />` |
  | `components/ProfilesSettings.tsx` | `<IconClose width={12} height={12} />` | `<IconClose />` |
  | `components/HostsSettings.tsx` | `<IconClose width={12} height={12} />` | `<IconClose />` |
  | `components/Sidebar.tsx` | `<IconChevron width={12} height={12} />` | `<IconChevron />` |
  | `components/Sidebar.tsx` | `<IconPin width={12} height={12} />` | `<IconPin />` |

  Those last two rows are inside the `.project-top` block D Task 38 wrote; they are the only two
  lines of `Sidebar.tsx` this task changes, and D deliberately left the attributes on so that every
  icon size in the app is deleted in one pass here.

  The three `width={12}` buttons that are not otherwise classed need a size hook. Add
  `data-size="sm"` to each of those three `<button className="icon-btn" …>` tags — the ones in
  `SettingsSheet.tsx`, `ProfilesSettings.tsx` and `HostsSettings.tsx` that wrap the `<IconClose />`
  rows above — so each reads `<button className="icon-btn" data-size="sm"`, matching the `data-size`
  idiom `.btn` already uses. Verify with
  `grep -rn 'className="icon-btn" data-size="sm"' src/renderer/src/components/` → three hits.

  Finally, prove none survived:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -rn "width={1[0-3]} height={1[0-3]}" src/renderer/src/components/
  ```
  Expected: nothing.

- [ ] **Step 5: Let the containers state their sizes.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add these declarations. Put
  the first inside the existing `.tab-close` rule, the second immediately after it, the third inside
  **both** the `.project-chevron` and `.project-pin` rules that D Task 38 landed, and the last two
  after `.browser-find-count`. Locate all four anchors with
  `grep -n "^\.tab-close {\|^\.project-chevron {\|^\.project-pin {\|^\.browser-find-count {" src/renderer/src/styles/app.css`:

  ```css
    /* was width={11}; the nearest token is 12px and the difference is invisible */
    --icon-size: var(--icon-sm);
  ```

  ```css
  /* The browser's own tab close is a size smaller — its tabs are shorter. */
  .btab .tab-close {
    --icon-size: var(--icon-xs);
  }
  ```

  ```css
    --icon-size: var(--icon-sm);
  ```

  ```css
  .browser-tabs .icon-btn,
  .browser-find .icon-btn {
    --icon-size: var(--icon-md);
  }

  /* Remove-this-row buttons in the settings sheet, profiles and hosts lists. */
  .icon-btn[data-size='sm'] {
    --icon-size: var(--icon-sm);
  }
  ```

- [ ] **Step 6: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected: `{"1":[28,16],"1.6":[45,26]}` — the glyph now
  grows with the button. Then confirm the size hooks landed:

  ```bash
  node scripts/cdp-eval.mjs "[
    Math.round(document.querySelector('.tab-close svg').getBoundingClientRect().width),
    Math.round(document.querySelector('.project-chevron svg').getBoundingClientRect().width)
  ]"
  ```

  Expected: `[12,12]`.

- [ ] **Step 7: Run the full check and commit.**
  ```bash
  npm run check
  git commit -am "Size icons in rem, so Interface scale moves the glyphs and not just the buttons"
  ```
  Body records: every icon was a fixed px attribute, so scale 1.0 → 1.6 grew each button 37.5%
  linear (61% areal) and left its glyph at exactly 16px; sizes now come from one `.icon` rule and a
  container's `--icon-size`, so no pixel count passes through a React prop.

---

### Task 70: One control height, and a line height for single-line controls

Spec §2.11: "inner control paddings bypass [the scale] entirely, producing nine near-but-unequal
control heights", and there is no line-height token. Contracts Task 4 declared `--lh-tight`,
`--lh-snug` and `--lh-normal` and put `--lh-normal` on `body`; `--lh-tight` is unused so far. 28px
is the target because the tab strip and title bar are already built on it — it is the reason the
contract rounded `--sp-2` up rather than down.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — `.btn`, `.icon-btn`,
  `.input`, `.select`, `.segmented`, `.segmented button` and `.pill`. Locate each by its selector:
  `grep -n "^\.btn {\|^\.icon-btn {\|^\.input {\|^\.select {\|^\.segmented {\|^\.segmented button {\|^\.pill {" src/renderer/src/styles/app.css`.
- Test: `node scripts/cdp-eval.mjs`, steps 1 and 3.

**Interfaces:**
- Consumes: `--control-h`, `--space-8`, `--space-12`, `--lh-tight` (all contracts Task 4);
  `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing new.

**This task does not declare `--control-h`.** Contracts Task 4 declares it — 28px, because the tab
strip and the title bar are already built on it, and it is why the spacing scale rounded 6px up to 8
rather than down to 4. Confirm it before starting:
`grep -n -- "--control-h:" src/renderer/src/styles/app.css` must print exactly one hit, inside
`:root`, reading `--control-h: 1.75rem;`. Nothing has referenced it yet, so declaring it moved no
pixel — this task is what moves them.

- [ ] **Step 1: Measure the nine-heights problem.** Against the running window, with a New Project
  tab on screen so the launcher's `<select>` exists:

  ```bash
  node scripts/cdp-eval.mjs "(() => { const hs = ['.btn', '.input', '.select', '.icon-btn', '.segmented'].map((s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().height) : null }); return { heights: hs, distinct: new Set(hs).size } })()"
  ```

  Expected now: `distinct` is **greater than 1** — around four different numbers, with `.icon-btn` at
  28 and `.btn` / `.input` / `.select` near 34 and `.segmented` near 30. The individual figures move
  with the font stack on a different machine, so the assertion is `distinct > 1`: it is the
  *disagreement* that is the defect, and Step 3 asserts the same measurement inverted.

- [ ] **Step 2: Apply the token.** In the same file, change these declarations — every other line in
  each rule stays exactly as it is:

  - `.btn`: replace `padding: 0.375rem var(--space-12);` with
    `height: var(--control-h);` then `padding: 0 var(--space-12);` then
    `line-height: var(--lh-tight);`
  - `.icon-btn`: replace `width: 1.75rem;` / `height: 1.75rem;` with
    `width: var(--control-h);` / `height: var(--control-h);`
  - `.input`: replace `padding: 0.375rem var(--space-8);` with
    `height: var(--control-h);` then `padding: 0 var(--space-8);` then
    `line-height: var(--lh-tight);`
  - `.select`: replace `padding: 0.375rem 1.75rem 0.375rem var(--space-8);` with
    `height: var(--control-h);` then `padding: 0 1.75rem 0 var(--space-8);` then
    `line-height: var(--lh-tight);`
  - `.segmented`: add `height: var(--control-h);` after `padding: 2px;`
  - `.segmented button`: replace `padding: 0.25rem var(--space-8);` with
    `padding: 0 var(--space-8);` then add `line-height: var(--lh-tight);`
  - `.pill`: add `line-height: var(--lh-tight);` after `font-weight: 500;`

  `.palette-input` is a separate class and keeps its own generous padding — the command palette's
  field is a page-level input, not a control in a row of controls.

- [ ] **Step 3: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected, exactly:
  `{"heights":[28,28,28,28,28],"distinct":1}`.

- [ ] **Step 4: Commit.**
  ```bash
  git commit -am "Draw every control at one height, and give single-line controls a line height"
  ```
  Body records: nine near-but-unequal control heights came from each control setting its own
  vertical padding on top of an inherited line height; 28px is the height the tab strip and title
  bar were already built on.

---

### Task 71: The Interface-scale field stops advertising bounds the store will not honour

Spec §2.11: `uiScale` is never clamped on the write path, because a number input's `min`/`max` are
advisory inside React's `onChange`. Contract Task 3 landed the enforcement in `hydrateSettings`, so
a junk value can no longer be *stored*. What is left is the display half: the terminal-size field
still advertises 8–28 while the store enforces 9–24, and both handlers still invent their own
fallback (`|| 1`, `|| 13`) rather than using the shared clamp — so `0` becomes `1` here and `0.8`
there.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/SettingsSheet.tsx` — the
  imports, the Terminal size field and the Interface scale field. Locate the two fields with
  `grep -n "Terminal size\|Interface scale" src/renderer/src/components/SettingsSheet.tsx`; C Task
  21 Step 4 added props to the `<WorklogSettings …/>` element further down this file and Task 69
  added a `data-size` attribute to its close button, so its line numbers have moved.
- Test: `node scripts/cdp-eval.mjs`, steps 1 and 4.

**Interfaces:**
- Consumes: `clampUiScale`, `clampFontSize`, `UI_SCALE_MIN`, `UI_SCALE_MAX`, `FONT_SIZE_MIN`,
  `FONT_SIZE_MAX` from `@shared/ui` (contracts §0.6, created by contracts Task 2);
  `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing new. One source of truth for the bounds, shown and enforced.

- [ ] **Step 1: Measure the lie.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.titlebar-actions .icon-btn[title=\\\"Settings\\\"]').click()
    await sleep(400)
    const field = (label) => [...document.querySelectorAll('.sheet-body .field')]
      .find((f) => f.textContent.startsWith(label)).querySelector('input')
    const size = field('Terminal size')
    const scale = field('Interface scale')
    return { size: [size.min, size.max], scale: [scale.min, scale.max] }
  })()"
  ```

  Expected now: `{"size":["8","28"],"scale":["0.8","1.6"]}` — the spinner offers 8 and 28, and the
  store silently stores 9 and 24.

- [ ] **Step 2: Import the shared bounds.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/SettingsSheet.tsx`, add after the
  `BUILT_IN_THEMES` import (locate it by
  `grep -n "^import { BUILT_IN_THEMES" src/renderer/src/components/SettingsSheet.tsx` — one hit,
  line 3; a bare `BUILT_IN_THEMES` grep also matches its use at line 38):

  ```tsx
  import {
    clampFontSize,
    clampUiScale,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    UI_SCALE_MAX,
    UI_SCALE_MIN
  } from '@shared/ui'
  ```

- [ ] **Step 3: Show and apply the same numbers.** Replace the two fields located in the Files
  block above with:

  ```tsx
            <div className="field">
              <span className="field-label">Terminal size</span>
              <input
                className="input"
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={settings.fontSize}
                onChange={(e) => onPatch({ fontSize: clampFontSize(e.target.value) })}
              />
            </div>

            <div className="field">
              <span className="field-label">Interface scale</span>
              {/*
                min/max are advisory inside React's onChange — the browser will
                not stop a typed or pasted value reaching the handler — so the
                same clamp the store enforces is applied here too, and the two
                bounds come from one place. The field used to offer 8-28 for a
                store that accepts 9-24, and to fall back with `|| 1`, which
                turned a typed 0 into 1 rather than into the floor.
              */}
              <input
                className="input"
                type="number"
                min={UI_SCALE_MIN}
                max={UI_SCALE_MAX}
                step={0.05}
                value={settings.uiScale}
                onChange={(e) => onPatch({ uiScale: clampUiScale(e.target.value) })}
              />
              <span className="field-hint">Scales everything except the terminal contents.</span>
            </div>
  ```

- [ ] **Step 4: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected:
  `{"size":["9","24"],"scale":["0.8","1.6"]}`. Then prove a typed value is clamped rather than
  fallen back on:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const input = [...document.querySelectorAll('.sheet-body .field')]
      .find((f) => f.textContent.startsWith('Interface scale')).querySelector('input')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, '0')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(500)
    const out = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()
    set.call(input, '1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(500)
    return out
  })()"
  ```

  Expected: `"0.8"` — the floor, not the `|| 1` fallback. (Setting `.value` through the prototype's
  native setter is required: React tracks input values internally and ignores a plain assignment.)

- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "Show the same interface-scale bounds the store enforces"
  ```
  Body records: the terminal-size field advertised 8-28 against a store that accepts 9-24, and both
  handlers used `|| n` fallbacks that turned a typed 0 into 1 rather than into the floor; a number
  input's min/max are advisory inside React's onChange, so the clamp has to be called, not declared.

---

### Task 72: macOS traffic-light clearance in device pixels

Spec §2.11: `app.css:216` clears the traffic lights with `padding-left: 4.875rem` — a rem — while
the lights are drawn by macOS at a fixed device size that Interface scale does not touch. Stoke is
only correctly laid out on macOS at Interface scale exactly 1.0.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — the
  `.titlebar[data-platform='darwin']` rule. Locate it by
  `grep -n "data-platform='darwin'" src/renderer/src/styles/app.css`.
- Test: `node scripts/cdp-eval.mjs`, steps 1 and 3. **Must be run on macOS**; the rule does not
  match on any other platform.

**Interfaces:**
- Consumes: `--traffic-lights-w: 78px` (contracts Task 4; 78 = 4.875 × 16, so scale 1.0 is
  pixel-identical to today and every other scale is fixed); `scripts/cdp-eval.mjs` (contracts
  Task 5).
- Produces: nothing new.

- [ ] **Step 1: Measure the defect.** Against the running window on macOS:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const root = document.documentElement
    const out = {}
    for (const s of ['0.8', '1', '1.6']) {
      root.style.setProperty('--ui-scale', s)
      await sleep(80)
      out[s] = getComputedStyle(document.querySelector('.titlebar')).paddingLeft
    }
    root.style.setProperty('--ui-scale', '1')
    return out
  })()"
  ```

  Expected now, exactly: `{"0.8":"62.4px","1":"78px","1.6":"124.8px"}` — at 0.8 the first tab sits
  under the close button, and at 1.6 the strip starts 47px further in than it should.

- [ ] **Step 2: Make it px.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace that rule with:

  ```css
  /*
   * Clear the macOS traffic lights.
   *
   * Device pixels, never rem. The lights are drawn by macOS at a fixed size
   * that Stoke's Interface scale does not touch, so a rem clearance is only
   * correct at scale exactly 1.0 — which is the whole of why Stoke was only
   * laid out correctly on a Mac at that one setting. 78px is 4.875rem x 16, so
   * scale 1.0 is unchanged and every other scale is fixed.
   */
  .titlebar[data-platform='darwin'] {
    padding-left: var(--traffic-lights-w);
  }
  ```

- [ ] **Step 3: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected, exactly:
  `{"0.8":"78px","1":"78px","1.6":"78px"}`. Then capture proof at both extremes:

  ```bash
  node scripts/cdp-eval.mjs "document.documentElement.style.setProperty('--ui-scale', '1.6')"
  node scripts/cdp-eval.mjs --shot /tmp/stoke-titlebar-160.png
  node scripts/cdp-eval.mjs "document.documentElement.style.setProperty('--ui-scale', '0.8')"
  node scripts/cdp-eval.mjs --shot /tmp/stoke-titlebar-080.png
  node scripts/cdp-eval.mjs "document.documentElement.style.setProperty('--ui-scale', '1')"
  ```

  Confirm from both images that no tab is under a traffic light and no gap has opened beside them.

- [ ] **Step 4: Commit.**
  ```bash
  git commit -am "Clear the macOS traffic lights in device pixels, not rem"
  ```
  Body records: the clearance was `4.875rem` against controls macOS draws at a fixed device size, so
  Stoke was only correctly laid out on a Mac at Interface scale exactly 1.0 — at 0.8 the first tab
  sat under the close button.

---

### Task 73: The last untokenised colours, and the ink that goes on a danger fill

Spec §2.11 lists three literal colours in component rules and four `#fff`. CLAUDE.md is explicit
that all colour goes through custom properties. Contracts Task 4 already landed `--scrim`,
`--swatch-ring`, `--shadow-panel` and `--on-danger`; this is what puts them to use, and it adds the
assertion that keeps `--on-danger` honest.

**`--on-danger` is `var(--bg)`, not white, and that was settled in the contract.** White measures
2.89 / 2.84 / 2.70 against Ember's, Nocturne's and Moss's `--danger` — under half of AA — and two of
its three call sites are button *text*. `var(--bg)` measures 6.50 / 6.66 / 6.85 / 5.46 across all
four built-in themes, needs no light-appearance override because `--bg` already flips, and stays
right for a custom theme by construction. Confirm before starting:

```bash
grep -n -- "--on-danger" src/renderer/src/styles/app.css
```

Expected: exactly one hit, `--on-danger: var(--bg);`, inside `:root`. There must be **no**
`--on-danger` line in the `:root[data-appearance='light']` block — a second declaration would freeze
what `--bg` flips. If the value is `#ffffff`, contracts Task 4 landed the superseded value; change
it to `var(--bg)` here and say so in the commit body.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts` — one new block before the
  final tally; `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — seven
  declarations inside component rules. Locate them with
  `grep -n "#fff\|rgb(0 0 0" src/renderer/src/styles/app.css`.
- Test: `npm run verify:color`, then `node scripts/cdp-eval.mjs` in step 4.

**Interfaces:**
- Consumes: `--scrim`, `--swatch-ring`, `--shadow-panel`, `--on-danger` (all contracts Task 4, with
  the light-appearance overrides for the first three); `contrastRatio`, `parseColor`,
  `BUILT_IN_THEMES` and `Theme`, already imported into `verify-color.mts` by Task 66;
  `scripts/cdp-eval.mjs` (contracts Task 5).
- Produces: nothing new.

- [ ] **Step 1: Pin the token's value with an assertion that passes.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts`, insert this block immediately
  **before** the final `console.log(failures ? … )` line:

  ```ts
  console.log('\n-- ink on a danger fill --')
  /*
   * Two of the three `--on-danger` sites are button text, so this is a 4.5:1
   * bar, not a 3:1 one. The token has to clear it against every theme's danger
   * fill — a fill that is itself chosen for visibility, which is exactly why a
   * light ink on it does not work: white measures 2.89 / 2.84 / 2.70 on the
   * three dark themes, under half of AA.
   */
  /** `--on-danger: var(--bg)` in app.css. If you change one, change the other. */
  const ON_DANGER = (t: Theme): string => t.colors.bg

  for (const t of BUILT_IN_THEMES) {
    const ratio = contrastRatio(parseColor(ON_DANGER(t))!, parseColor(t.colors.danger)!)
    const ok = ratio >= 4.5
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`--on-danger on ${t.id}'s danger`.padEnd(46)} ${ratio
        .toFixed(2)
        .padStart(10)}  (expected >= 4.5)`
    )
  }
  ```

  This one is green from the moment it is written, and deliberately so: contracts Task 4 already
  landed the passing value, and a red/green dance that required shipping a knowingly-failing token
  through five workstreams would have been theatre. The failure this task really fixes is in Step 2,
  where three component rules still put literal white on a danger fill regardless of what the token
  says.

- [ ] **Step 2: Run it, and see the assertion hold.**
  `npm run verify:color`
  Expected, exactly:

  ```
  -- ink on a danger fill --
  ok   --on-danger on ember's danger                            6.50  (expected >= 4.5)
  ok   --on-danger on nocturne's danger                         6.66  (expected >= 4.5)
  ok   --on-danger on moss's danger                             6.85  (expected >= 4.5)
  ok   --on-danger on daylight's danger                         5.46  (expected >= 4.5)
  ```

  ending `all colour checks pass`, exit 0. If any line reads `2.89` / `2.84` / `2.70` / `6.01`, the
  `:root` block still says `#ffffff` — go back and fix it, because those are white's numbers.

- [ ] **Step 3: Replace the seven literals.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, anchoring on each rule's
  selector rather than on a line number:

  | Rule | Change |
  |---|---|
  | `.backdrop` | `background: rgb(0 0 0 / 0.42);` → `background: var(--scrim);` |
  | `.theme-chip` | `border: 1px solid rgb(0 0 0 / 0.25);` → `border: 1px solid var(--swatch-ring);` |
  | `.usage-panel` | `box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);` → `box-shadow: var(--shadow-panel);` |
  | `.win-btn[data-variant='close']:hover` | `color: #fff;` → `color: var(--on-danger);` |
  | `.btn[data-variant='danger']:hover:not(:disabled)` | `color: #fff;` → `color: var(--on-danger);` |
  | `.segmented button[data-danger='true'][aria-pressed='true']` | `color: #fff;` → `color: var(--on-danger);` |
  | `.usage-pace` | `background: #fff;` → `background: var(--text);` |

  The three `color: #fff` rows are the real defect this task closes: whatever `--on-danger` says,
  those three rules were putting literal white on a danger fill and measuring 2.70–2.89:1 on the
  dark themes. Two of them are button text.

  `.usage-pace` gets `--text` and no new token: it is a 2px pace marker ringed in `--bg-sunken`, and
  a white bar is invisible on a light theme while `--text` already flips. Add above it:

  ```css
    /* --text, not white: this bar has to read on a light theme too, and --text
       is the token that already flips with appearance. The --bg-sunken ring
       below is what separates it from whatever fill it is standing on. */
  ```

  Then prove no literal survives in a component rule:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n '#fff\|rgb(0 0 0' src/renderer/src/styles/app.css
  ```
  Expected: only hits inside the `:root` / `:root[data-appearance='light']` token blocks and the
  `--shadow-sm/md/lg` declarations — never inside a component rule.

- [ ] **Step 4: Rebuild, relaunch, and confirm the two that are visible.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.titlebar-actions .icon-btn[title=\\\"Settings\\\"]').click()
    await sleep(400)
    return {
      scrim: getComputedStyle(document.querySelector('.backdrop')).backgroundColor,
      chip: getComputedStyle(document.querySelector('.theme-chip')).borderTopColor
    }
  })()"
  ```

  Expected on the default Ember (dark) theme:
  `{"scrim":"rgba(0, 0, 0, 0.42)","chip":"rgba(0, 0, 0, 0.25)"}` — identical to before, which is the
  point: the values did not change, only where they live.

- [ ] **Step 5: Run the full check and commit.**
  ```bash
  npm run check
  git commit -am "Tokenise the last literal colours, and put a legible ink on danger fills"
  ```
  Body records: three component rules declared `color: #fff` on a `--danger` fill, which measures
  2.70-2.89:1 against the three dark themes' reds — under half of AA on two sites that are button
  text. They now read `var(--on-danger)`, which is `var(--bg)`; `verify:color` asserts that ratio on
  every built-in theme, so a new theme with a pale danger cannot be added without the suite saying
  so. The scrim, the swatch ring and the panel shadow moved to their tokens at the same time, with
  no change in value.

---

### Task 74: The density review — every screen, after everything has moved

Spec §4.F.6: "This is a visible density change; every screen is reviewed afterwards." Ninety-two
declarations moved to 8px, three to 24px, every control is now 28px, every glyph now scales, and
the sidebar's whole left edge moved. This is the task that looks at all of it.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/docs/superpowers/plans/2026-08-07-density-review/` (seven
  PNGs; a scratch directory, not shipped code)
- Modify: only whatever the review turns up, plus `CLAUDE.md` in step 5
- Test: the measurements in step 2 and the seven screenshots in step 3

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` (contracts Task 5) and every change from Tasks 64-73.
- Produces: no code interfaces. A recorded before/after, and two CLAUDE.md gotchas.

- [ ] **Step 1: Rebuild and relaunch clean.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  mkdir -p docs/superpowers/plans/2026-08-07-density-review
  ```

- [ ] **Step 2: Take the whole set of measurements at once.**

  ```bash
  node scripts/cdp-eval.mjs "({
    controls: ['.btn', '.input', '.select', '.icon-btn', '.segmented'].map((s) => {
      const el = document.querySelector(s)
      return [s, el ? Math.round(el.getBoundingClientRect().height) : null]
    }),
    tabPadding: getComputedStyle(document.querySelector('.tab')).paddingInline,
    sidebarGap: getComputedStyle([...document.querySelectorAll('.sidebar-head > div')].pop()).columnGap,
    bodyLineHeight: getComputedStyle(document.body).lineHeight,
    trafficLights: getComputedStyle(document.querySelector('.titlebar')).paddingLeft,
    iconLg: getComputedStyle(document.documentElement).getPropertyValue('--icon-lg').trim()
  })"
  ```

  Expected, exactly, on macOS at Interface scale 1.0 — compact, on one line, because the probe has
  the page stringify it:

  ```
  {"controls":[[".btn",28],[".input",28],[".select",28],[".icon-btn",28],[".segmented",28]],"tabPadding":"8px","sidebarGap":"8px","bodyLineHeight":"21.7px","trafficLights":"78px","iconLg":"1rem"}
  ```

  (`21.7px` is `--lh-normal` 1.55 × the 14px `--fs-base`; if the body font size differs on the
  machine, the number is `1.55 × fs-base` and must not be a bare `normal`.)

- [ ] **Step 3: Capture all seven screens.** Run each pair in order; each `--shot` writes into
  `docs/superpowers/plans/2026-08-07-density-review/`.

  ```bash
  S=docs/superpowers/plans/2026-08-07-density-review
  # 1. launcher + sidebar, nothing selected
  node scripts/cdp-eval.mjs --shot $S/1-launcher.png
  # 2. sidebar with a project expanded
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = [...document.querySelectorAll('.project')].find((r) => /\\\\d+ session/.test(r.textContent))
    row.click(); row.querySelector('.project-chevron').click()
    for (let i = 0; i < 40 && !document.querySelector('.sessions .session'); i++) await sleep(250)
    return document.querySelectorAll('.sessions .session').length
  })()"
  node scripts/cdp-eval.mjs --shot $S/2-sidebar-expanded.png
  # 3. a live terminal (WebGL: only a screenshot can confirm it renders)
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.sessions .session').click()
    for (let i = 0; i < 60 && !document.querySelector('.term-stack .term-pane'); i++) await sleep(250)
    await sleep(3000)
    return getComputedStyle(document.querySelector('.term-stack')).display
  })()"
  node scripts/cdp-eval.mjs --shot $S/3-terminal.png
  # 4. settings sheet
  node scripts/cdp-eval.mjs "document.querySelector('.titlebar-actions .icon-btn[title=\\\"Settings\\\"]').click()"
  node scripts/cdp-eval.mjs --shot $S/4-settings.png
  node scripts/cdp-eval.mjs "document.querySelector('.backdrop').click()"
  # 5. command palette
  node scripts/cdp-eval.mjs "document.querySelector('.titlebar-actions .icon-btn[title^=\\\"Find a project\\\"]').click()"
  node scripts/cdp-eval.mjs --shot $S/5-palette.png
  node scripts/cdp-eval.mjs "document.querySelector('.backdrop').click()"
  # 6. worklog panel
  node scripts/cdp-eval.mjs "document.querySelector('.titlebar-actions .icon-btn[title^=\\\"Worklog\\\"]').click()"
  node scripts/cdp-eval.mjs --shot $S/6-worklog.png
  # 7. browser panel
  node scripts/cdp-eval.mjs "document.querySelector('.titlebar-actions .icon-btn[title^=\\\"Toggle browser\\\"]').click()"
  node scripts/cdp-eval.mjs --shot $S/7-browser.png
  ```

  Read all seven. Four things to look for specifically, because they are what the migration could
  plausibly have broken: a control whose label now touches its own border (`--sp-2`'s 6→8px only
  ever added room, so this would mean a fixed `height` clipping); a settings section whose gap
  shrank from 28px to 24px and now reads as a list rather than as sections; an icon that grew from
  11px to 12px inside a box that was exactly 11px; and anything in the terminal pane, which is a
  WebGL canvas whose contents are readable from nowhere but this image.

- [ ] **Step 4: Run the four bounded checks the four failure modes turn into.** A review with no
  stopping condition is not a task, so each of the four things Step 3 says to look for has a yes/no
  measurement here. All four run against the same window:

  ```bash
  # (a) no control's content is taller than the box --control-h gave it
  node scripts/cdp-eval.mjs "[...document.querySelectorAll('.btn,.input,.select')].every(e => e.scrollHeight <= e.clientHeight)"
  ```
  Expected: `true`. `false` means a fixed `height: var(--control-h)` is clipping a label — the
  6→8px rounding only ever added room, so this can only be the height, not the padding.

  ```bash
  # (b) the shell never scrolls horizontally, at three widths
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = {}
    for (const w of [940, 1200, 1600]) {
      window.resizeTo(w, window.outerHeight)
      await sleep(250)
      out[w] = document.documentElement.scrollWidth === window.innerWidth
    }
    return out
  })()"
  ```
  Expected: `{"940":true,"1200":true,"1600":true}`. 940px is the app's minimum width, and CLAUDE.md
  gotcha 14 is entirely about this measurement.

  ```bash
  # (c) every icon still scales with Interface scale
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const root = document.documentElement
    const read = () => document.querySelector('.project-chevron svg').getBoundingClientRect().width
    root.style.setProperty('--ui-scale', '1'); await sleep(80); const a = read()
    root.style.setProperty('--ui-scale', '1.6'); await sleep(80); const b = read()
    root.style.setProperty('--ui-scale', '1')
    return +(b / a).toFixed(3)
  })()"
  ```
  Expected: `1.6` ± 0.05.

  ```bash
  # (d) no project name is out of line with its neighbours
  node scripts/cdp-eval.mjs "new Set([...document.querySelectorAll('.project-name')].map(n => Math.round(n.getBoundingClientRect().left))).size"
  ```
  Expected: `1`.

  A failure in any of the four is fixed here, as a change to a single rule in `app.css`, re-measured
  with the same expression. Do **not** adjust the scale itself — the mapping is the contract's, and a
  one-off exception is how the old 4/6/8/12/16/20/28/40 scale grew in the first place. **Anything
  the screenshots show beyond those four is recorded as a follow-up issue, not fixed inside this
  task**; an open-ended "fix what the images show" is how a review task never finishes.

- [ ] **Step 5: Record the two things worth not rediscovering.** Append to the "Gotchas that cost
  real time" list in `/Users/thevinh/dev/personal/stoke/CLAUDE.md`:

  ```md
  21. **A CSS token rename only fails loudly if the old name is gone.** The spacing migration renamed
      `--sp-*` to `--space-*` on purpose: a missed `var(--sp-2)` names nothing, the declaration is
      invalid at computed-value time, and the padding visibly collapses to 0. Renumbering in place
      would have made `--sp-4` silently mean 4px where it used to mean 12px. Two consequences: the
      migration is verified by `grep -rn -- '--sp-' src/` returning **zero**, and a sweep over the
      stylesheet is not the whole job — 26 uses were inside `style={{ }}` objects in eight `.tsx`
      files and rendered at 0 until they were found.

  22. **macOS traffic lights are device pixels; anything clearing them must be too.** `padding-left`
      in rem was only correct at Interface scale exactly 1.0 — at 0.8 the first tab sat under the
      close button. Same class of bug as sizing an icon with a px attribute inside a rem-scaled
      button: two units that do not move together, so it looks right at exactly one setting.
  ```

- [ ] **Step 6: Run the full check and commit.**
  ```bash
  npm run check
  git add docs/superpowers/plans/2026-08-07-density-review CLAUDE.md
  git commit -m "Review every screen after the 4px migration, and record what it cost to learn"
  ```
  Body records: 116 declarations moved to 8px (92 in `app.css`, 24 in the eight `.tsx` files) and
  four to 24px, every control is now 28px and every
  glyph now scales with Interface scale; the seven screenshots are the evidence that the density
  change is a change and not a regression.

---

## Notes nobody should rediscover

1. **`src/shared/**` is compiled by both tsconfigs.** `tsconfig.web.json` gives it no Node types.
   A `import { sep } from 'node:path'` or a bare `process.platform` in a shared module fails
   `npm run typecheck` on the web project only — which is easy to miss if you only run the app.
2. **Shared modules use extensionless relative imports for TYPE-only imports**, which strip-types
   erases, **and an explicit `.ts` for VALUE imports.** `import { foldGroup } from './paths.ts'` in
   `src/shared/profiles.ts` is
   the first value import between two shared modules in the tree; both tsconfigs are `noEmit`, so
   `allowImportingTsExtensions` is legal, and `tsconfig.node.json` already sets it
   (`tsconfig.node.json:9`; the import style itself is exampled at `src/main/mcp/design.ts:11-16`).
   Task 1 Steps 5a–5b set it on `tsconfig.json` and `tsconfig.web.json`. Separately: a
   value import of `@shared/*` from a strip-types module (`gate.ts`, `watch.ts`, `runner.ts`,
   `recall.ts`, `autoscan.ts`, `settingsSchema.ts`, `projectMeta.ts`, `statusLine.ts`,
   `sessionStore.ts`) breaks its verify suite at runtime with `ERR_MODULE_NOT_FOUND`, not at
   compile time.
3. **`shouldWatch.length` is asserted at `verify-worklog-gate.mts:166`.** Any new parameter must
   have a default value.
4. **The queue's dedupe key is load-bearing** (CLAUDE.md gotcha 17). Nothing in this plan
   touches `WorklogProposal.id`, its inputs, `dedupeKey` itself, or the `create` key format. Keep
   it that way — a changed key resurrects every proposal the user has ever rejected. What C Task 19
   Steps 10–13 *do* change is the **matching** in `WorklogQueue.add`: an update's key is a
   composite of every board record it names, so switching a board off narrows `existing` and the
   composite moves under it. `dedupeKeys` gives a proposal one extra key per record so "already
   known" survives that; the composite is still the key, still first in the list, and still the
   thing `proposalId` hashes. Note also, because it is the opposite of what it looks like:
   `refused` is built from `dedupeKey({ sessionId, title })` with no `kind` and no `existing`, so
   every tombstone — including an update's — is the *title-based create key*. Rejections were
   therefore never at risk from a target change; only `seen` was.
5. **`worklog:watchChanged` must not be computed from a project list cached at boot.** A repository
   cloned during the run is a project the gate has to be able to see (`src/main/index.ts:365-367`).
6. **Do not fire `worklog:watchChanged` from the ContextWatcher tick.** It would push identical
   arrays every 1.5 s per session. The four triggers in §0.3 are the complete list.
7. **`statusline:update` fires only when the payload file's mtime moved.** Same reason.
8. **`scripts/` is in neither tsconfig `include`.** The verify suites are not typechecked; a type
   error there only shows up as a runtime failure when the suite runs. Run the suite.
9. **A red dot means exactly one thing after this work: "the worklog is watching this session".**
   Bypass mode loses red (`.tab-dot[data-state='bypass']`, `app.css:387-389`), the ≥90% ring loses
   red (`.ring[data-level='critical'] .ring-fill`, `app.css:899-901` → `--ring-full`),
   and `.tab-close:hover` (`app.css:370-373`) keeps its own fill because it is a hover affordance
   rather than state.
   If a workstream needs a new red, it needs a different colour instead.
10. **`resets_at` in the statusLine payload is epoch seconds.** `UsageWindow.resetsAt` elsewhere in
    this codebase is ms. Convert exactly once, in `toSnapshot`.
11. **The statusLine files are named after a *launch key*, not a session id.** They are the same
    string for every session Stoke mints an id for. A `--continue` session's id is chosen by the
    CLI *after* launch (`pty.ts:137-138` leaves it `''`), so E Task 11 mints
    `statusKey = sessionId || randomUUID()` and the payload's own `session_id` field is what names
    the real session. Anything that reads a payload must key on the launch key
    (`PtyManager.statusKeys()`) and take the id from the snapshot — never the reverse.
12. **Known gap, left open deliberately: a `--continue` session has no context ring.** After E Task
    11 it does get the wrapper (so suppression works) and its payload does reach the usage chip (so
    the account-wide rate limits work). What it cannot get is a per-session meter: the renderer
    binds a reading with `contexts[tab.sessionId]` and that tab's `sessionId` is the `''` that
    `startSession` returned, so closing the gap means shipping a main→renderer channel for a *late*
    session id. `src/shared/ipc.ts` gains seven names in contracts Task 2 and none of them is that.
    This is not a regression — such a session has never had a meter — and it is a follow-up, not a
    bug to be discovered again from the symptom.
