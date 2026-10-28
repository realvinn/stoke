---
paths:
  - "scripts/verify-*.{mts,mjs}"
  - "scripts/drive-*.mts"
  - "scripts/touch-drag.mts"
  - "scripts/suite-tmpdir.mts"
  - "scripts/ci-verify.mjs"
  - "package.json"
  - "tsconfig.node.json"
  - "tsconfig.web.json"
  - "src/preload/index.ts"
  - "src/renderer/src/lib/tabs.ts"
  - "src/shared/*.ts"
  - ".github/workflows/release.yml"
  - ".github/workflows/ci.yml"
---

# Verify-suite hygiene

What makes a verify suite able to fail, what the typecheck does not cover, and where the CI list
comes from. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each.
Numbers are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 9. `window.stoke` cannot be monkey-patched from the page

**`window.stoke` cannot be monkey-patched from the page.** contextBridge freezes it, so
assigning over a method to stub IPC in a test silently does nothing and the real value
comes back. A test that appears to pass this way is testing production behaviour.

## 27. `src/shared/**` is compiled by both tsconfigs, and only one of them has Node's types

**`src/shared/**` is compiled by both tsconfigs, and only one of them has Node's types.** Both
`tsconfig.node.json` and `tsconfig.web.json` include `src/shared/**/*.ts`, but the web project
sets `"types": ["vite/client"]` with no `node` — so a `node:` import added to a shared module
fails the *web* half of `npm run typecheck` while the main half stays green, and the error names
a file you were not editing. (`voice.ts` is the mirror image of the same split: browser-only,
and excluded from the node project by name rather than moved.) Related, and easy to trust
wrongly: **`scripts/` is in neither include**, so the verify suites are never typechecked. They
are run, which is most of the point — but node's strip-only mode checks nothing, so a suite can
be type-wrong and still exit 0 with every assertion passing, and `typecheck` will never say so.

## 50. `verify-tabs.mts` printed its own tally two thirds of the way up, so a third of the file could not fail

**`verify-tabs.mts` printed its own tally two thirds of the way up, so a third of the file
could not fail.** `process.exitCode` is assigned once; every assertion after that line printed
`PASS`/`FAIL` into a total nobody read again. Proven by forcing one: the run printed `all
pass`, then `FAIL`, then exited **0**, and `npm run check` went green. Six `restartPlan`
assertions — the ones protecting gotcha 18's "a remote tab's cwd is an alias, not a folder" —
were unfalsifiable for as long as that ordering stood.

The tally is the last statement in the file now, and the fix was verified in both directions:
an injected failure exits 1, and removing it exits 0. Worth checking in any suite that grew a
new section: a summary is only a summary if nothing runs after it, and a suite that cannot
fail is worse than no suite, because it is also a claim that the thing was checked.

## 62. A suite with no exit code is not a weaker suite, it is not a suite

**A suite with no exit code is not a weaker suite, it is not a suite.** `verify-color.mts`
declared `failures`, incremented it in all four assertion helpers, printed `FAIL` on every
failing line — and never touched `process.exitCode` or `process.exit` in 722 lines, so
`node scripts/verify-color.mts; echo $?` printed 0 whatever the run said. It is the only
automated check for the APCA and WCAG maths, the ladder's Lc floors and the accent-ink
derivation, so `npm run check` AND the release gate would both have gone green over a
regression reprinting gotcha 44's 1.43:1 focus ring. Worse than gotcha 50's ordering bug, where
only a third of a file could not fail. Check both: `grep -L 'process.exit' scripts/verify-*.mts`
(note `verify-selection` legitimately uses `app.exit`), and that the tally is the LAST statement.

Related, and the same class one level up: **two lists that must agree, maintained by hand, will
diverge — including a list whose own comment tells you to keep it in step.** The release
workflow carried twenty `- run:` lines under exactly that instruction; it had already drifted
when the instruction was written, was fixed by hand in 36d491f, and drifted again within two
days as verify:theme-gen, verify:remote and verify:drop each joined `check` and not the
workflow. `scripts/ci-verify.mjs` derives the list from the `check` chain now and fails on a
stale exclusion; `npm run verify:ci -- --list` prints the plan without running it.

## 74. A fixed clock is not hermeticity — it is what makes a real directory dangerous

**`scripts/verify-statusline.mts` swept the machine's real, shared statusLine directory with a clock
seven years in the future, and so deleted the live `.settings.json`, `.cmd` and `.events.jsonl` of
every Stoke session open on the machine — dev and installed alike — on every `npm run check`.** It
did this for five weeks (the sweep and its test landed 2026-08-07, found 2026-09-13) and nothing
went red, because from inside the suite everything passed.

The call was `sweepStaleSessionFiles(SWEEP_NOW)` with `SWEEP_NOW = 2_000_000_000_000`, and the
comment above it said *"Entirely hermetic: SWEEP_NOW is a fixed instant far from the real clock, and
every fixture's mtime is set explicitly."* Both halves of that sentence are true. The conclusion is
backwards. The function takes a clock AND a directory; faking one of two inputs does not isolate
anything, it just makes the real input more exposed:

- Relative to an instant seven years ahead, **every real file in that directory is stale**, so pass
  1's `freshPayloadKeys` comes back empty.
- Which means the protection this very block exists to prove — "a long-running session's write-once
  `.settings.json` is protected by its sibling payload's freshness" — **cannot fire for any real
  file**, only for the fixtures that were backdated relative to the same fake clock.
- So the one assertion that names the hazard out loud, *"a fresh payload survives — the
  dev-vs-installed hazard: a concurrently-running Stoke install would look exactly like this to the
  sweep, and must not be touched"*, passed on a fixture while the run deleted exactly that.

**The signature it leaves is the one that misled everyone for months** (gotcha 73): the payload
`.json` comes back within the tick, because the wrapper rewrites it about three times a second,
while `.settings.json` and `.cmd` are written once at launch and never heal. So the directory
afterwards looks like "only the settings file went" — which reads like a targeted writer bug and
not like a wipe. It also explains a detail the relaunch race cannot: the original sighting was of
several sessions at once.

Two rules come out of it:

1. **Fake every input or none.** If a test hands a function a synthetic clock, it must hand it
   synthetic paths too — `sweepStaleSessionFiles(now, dir)` takes both for exactly this reason. Any
   suite that reaches `tmpdir()`, `homedir()` or `~/.claude` and then *writes or deletes* is sharing
   state with whatever else is running; this repo's suites deliberately use the real directory (they
   run the real wrapper under the real node), and that is fine for writing under a synthetic key.
   Directory-WIDE operations are the ones that cannot be aimed.
2. **Assert the blast radius, not just the result.** The fix adds a bystander file in the shared
   directory and checks it survives. Reverting the sweep to `statusLineDir()` now turns that check
   red — measured — where before, every assertion stayed green while the damage happened beside
   them. A suite that cannot observe its own side effects will report success on a run that broke
   the machine.

> **Checked against the code on 2026-10-27: "fine for writing under a synthetic key" was wrong, and
> it was clobbering the installed app's live shim.** Rule 1 above allowed the suites to write the real
> shared directory as long as each file had a key of its own. But `writeStatusLineWrapper()` has no
> key. It rewrites `wrapper.mjs` and `run.sh`/`run.cmd`, the two files every Stoke session on the
> machine runs for its status line and its Stop/Notification/UserPromptSubmit hooks. Measured on the
> owner's Mac: `$TMPDIR/stoke/statusline/run.sh` read `ELECTRON_RUN_AS_NODE=1 exec
> "<…>/node/bin/node" …/wrapper.mjs`, not Stoke's own binary. Its mtime and wrapper.mjs's matched
> the last `npm run check`, and wrapper.mjs was the working tree's copy, while the installed app's
> live `*.settings.json` pointed at both. verify:statusline also deleted `wrapper.mjs` and put a
> DIRECTORY there for the length of its "never throws" block. Any live status line or hook call in
> that window failed, and a lost Stop leaves a tab's dot on "working", which looks just like a stuck
> terminal. verify:private wrote the wrapper too, and verify:context wrote and deleted payloads
> there, all on every check, many times a day.
>
> The fix fakes the whole input, not part of it. `scripts/suite-tmpdir.mts` is the FIRST import of
> verify-statusline, verify-private and verify-context. ESM runs it before any module under test,
> and it points `TMPDIR`/`TMP`/`TEMP` at a fresh mkdtemp for that process alone. It refuses to run
> if `tmpdir()` does not then answer the scratch folder, and it removes the folder on exit, SIGINT,
> SIGTERM and SIGHUP included (a signal skips `'exit'`; measured, a TERM mid-run left the folder
> behind until the helper turned signals into `process.exit(128 + n)`). Children
> inherit the variable, so the real wrapper still runs under the real node. Nothing in `src/` reads
> a new switch, so the packaged app cannot be pointed anywhere by accident. The bystander check
> above now sits in the scratch folder's own statusline directory, and mutating the sweep back to
> `statusLineDir()` still turns it red (3 checks). Each suite's FIRST statement is
> `requireScratch(statusLineDir(), …)`, which exits 1 on the spot when the directory under test is
> not in the scratch folder: a counted check there only reported the clobber after the suite had
> carried on and done it. Each suite also adds two checks. `inScratch(statusLineDir())` records the
> mechanism in the tally. `sharedStatusLineDamage()`, run just before the tally, compares the REAL
> directory's shim files (inode, mtime ns, size, sha256) with what the run found. A change counts as
> a SUITE's when the shim now names this process's own `process.execPath` (which an unfixed suite
> run elsewhere on the same node also leaves, so the finding says "this run, or an unfixed one"),
> when a shim file is gone or is not a file, or when the directory appeared without a Stoke's shim in
> it. A Stoke launching a session beside the run also rewrites both files, but its shim names
> Stoke's binary, so that change is printed as a NOTE and is not a failure. That was driven:
> rewriting the shim mid-run gave two NOTEs and a pass, and so did a directory that did not exist
> at the start and appeared mid-run holding a Stoke-style shim (which, when "the directory
> appeared" was a finding by itself, failed the run).
>
> Shown red against an outer `TMPDIR` scratch seeded with stand-in shim files, so the owner's
> directory was never at stake. With the redirect and its import-time guard removed, each of the
> three suites now stops at `requireScratch` with exit 1 and the stand-in files byte-identical;
> before it existed, verify:statusline and verify:private failed both checks and the stand-in
> `run.sh` came back naming plain node: the measured clobber, reproduced. With `requireScratch`
> removed too, that is still what the two checks catch. The damage check also fails on its own: one
> extra `writeStatusLineWrapper()` aimed at the shared directory, everything else isolated, turned
> only it red.
>
> **Closed the same day: the rest of `<tmpdir()>/stoke`.** That folder also holds fixed-content files
> every Stoke shares, rewritten in place with `writeFileSync`. verify:worklog-runner and
> verify:work-drafts rewrote `empty-mcp.json` through `emptyMcpConfigFile` (agent.ts, reached by
> every strict `buildHeadlessArgs`/`runHeadless`), the file the installed app hands its own headless
> worklog and draft runs as `--mcp-config`. Both now take the same first import, and their first
> statement is `requireScratch(join(tmpdir(), 'stoke'), …)`, spelled the way `emptyMcpConfigFile`
> spells it, because that call is itself the write. Each also checks that the `--mcp-config` path on
> the real argv is `inScratch`. Against an outer scratch `TMPDIR`: with the redirect removed, both
> stop at `requireScratch` (exit 1, nothing written); with `requireScratch` also a no-op, each fails
> exactly that check and the outer `empty-mcp.json` is written. The shared `ultracode-settings.json`
> touched at 17:42 came from verify:statusline's `buildArgs({ ultracode: true })` with no settings
> file (`ultracodeSettingsFile`), isolated by the fix above. Grepping every `verify-*.mts` for
> `statusLineDir`, the statusLine.ts writers, `emptyMcpConfigFile`, `ultracodeSettingsFile`,
> `agentScratchDir`, `buildHeadlessArgs`/`runHeadless`, a real `PtyManager` spawn, a launch of the
> app's main bundle and a literal `tmpdir()/stoke`, plus the modules that reach them (worklog
> recall and retry inject `run`; no suite calls `scanSession`), found no other suite that writes
> there. A new suite that writes anywhere under `tmpdir()/stoke` takes the same import and call.

## 78. A path alias in a module a suite imports typechecks, builds, and dies only when the suite runs

**A verify suite runs its subject under `node --experimental-strip-types`, which resolves no
path aliases and compiles nothing** — so an `@shared/...` specifier anywhere in the import graph
of a module a suite loads is invisible to every gate except the suite itself. `npm run
typecheck` passes (tsconfig has the alias), `npm run build` passes (vite has the alias), and
`node scripts/verify-<x>.mts` dies with `ERR_MODULE_NOT_FOUND` on a path nobody wrote.

`src/renderer/src/lib/tabs.ts` carried the blunt version of this rule in its header — *"No
imports, so `scripts/verify-tabs.mts` runs it under `node --experimental-strip-types`"* — which
is a true constraint stated one size too large, and the cost of stating it that way is that the
first person who needs an import has to rediscover what the real limit is. It is the same rule
`src/main` already follows and CLAUDE.md already states for main: **relative path, `.ts`
extension spelled out, and nothing outside `src/shared`.** `src/main/cli.ts` importing
`'../shared/codingClis.ts'` is the shape; `'@shared/codingClis'` is the shape that breaks.

Two corollaries worth carrying:

- **`src/shared` is the only safe destination**, because gotcha 27 already forbids `node:`
  imports there. A pure module that reaches into `src/renderer` or `src/main` instead can pull
  `electron` or `@lydell/node-pty` into a suite's process, and those fail differently and later.
- **The failure is loud but the window is narrow.** It surfaces only in `npm run check`, after
  typecheck and before build, so an edit verified by typechecking alone looks completely clean.
  That is gotcha 31's lesson pointing the other way: some things only a suite can see, and some
  things only the app can.

## 113. A suite kept off an OS never learns it cannot pass there — rehearse its other branch before CI runs it

**`verify:selection` could only pass on a Mac, and its own comments said it was portable.** It was
kept out of CI from the day it was written (fcb4dc9, "needs a display"), so the only machine that
ever ran it was a Mac. Its assertions had been rewritten to read the rule off `process.platform`
(`isMac ? altKey : shiftKey`, gotcha 10) — but every DRAG it made was still an Option-drag, and only
a Mac's xterm treats Option as the force-selection modifier. Off macOS each "selects while
dragging" reading was `""`. Nobody could see it: the Mac run was green and nothing else ran it.

Measured on 2026-09-30, before wiring it into the Linux gate under xvfb: loading xterm with
`navigator.platform` overridden to `Linux x86_64` (xterm reads it once, at load, in
`common/Platform.ts`) made **43 assertions fail**; the Mac run stayed 124/124. Had the gate simply
been wired, its first push would have gone red for a reason that looks like xvfb, the sandbox or
the runner, and none of it was.

The fix is `selectingDrag(isMac, reporting)` — Option on macOS, Shift off it while the mouse is
reported, no modifier when it is not — feeding the page AND the assertions, plus a check that holds
the drag itself to the suite's force rule. Afterwards: 130/130 on the Mac, and 130/130 with xterm's
platform read as Linux and as Win32. The old drag under the Linux read fails 43 again, so the
rehearsal can tell the two apart.

Two rules:

1. **Before a suite joins a new OS's CI, run its off-platform branch once.** For xterm that is a
   `<script>` defining `Navigator.prototype.platform` before `xterm.js` loads, plus the suite's own
   platform flag — cheap, and it found this in one run. It is a rehearsal, not proof: only the
   real runner is proof, which is what ci.yml's `verify` (Linux) and `portability` legs are for.
2. **A missing reading is a failure, not a skip.** The two-row wrap check was
   `if (!shim) continue`, so renaming its step would have deleted the check silently.

> **Checked against the code on 2026-09-30** — the same rehearsal for a Node suite's PATHS. A
> path built with node's `join` has backslashes on Windows, so comparing it to a `'/a/b'` literal
> (or taking a file name with `split('/').pop()`) passes on the Mac and fails on the portability
> leg: verify:usage shipped ten such checks. On the Mac, rehearse it with an `--import` preload
> that sets `path.join = path.win32.join` (and `basename`), wraps the fs calls the suite makes
> to turn `\` into `/` (Windows accepts both, so files still nest for real; a bare swap
> writes flat backslash-named files and misleads), then calls `syncBuiltinESMExports()`. That run failed
> exactly those ten, and passes once the suite compares `slashed(...)` values and uses `basename`.

The same shape one level up: `ci-verify.mjs` had never run on Windows either, and could not have —
it started every suite with `execFileSync('npm')`, which cannot start `npm.cmd` there. Nothing
showed it until a Windows leg was about to call it.

**And a route decided by the runner is inherited by every workflow that runs the script** (found
in review, 2026-09-30, before anything was pushed). `displayRoute` sends the window suite to
`xvfb-run -a` whenever `xvfb-run` is on PATH. ci.yml installed xvfb and relaxed Ubuntu 24.04's
`kernel.apparmor_restrict_unprivileged_userns`; release.yml's `verify` got neither. But GitHub's
ubuntu-24.04 image already ships xvfb (runner-images' `Ubuntu2404-Readme.md`, image
20260920.314.1: `| xvfb | 2:21.1.12-1ubuntu1.6 |`) and leaves the knob on
(actions/runner-images#11489, closed with "Workaround for that issue already provided" — the
sysctl). So the release gate would have started Electron with no usable sandbox, watched it abort,
and failed the job every installer build `needs:`. `verify:targets` stayed green through it,
because its "mirror" compared only the `uses:` steps and the npm commands — the one part of the two
jobs that had not drifted.

Three rules:

1. **Hold two copies of a gate to EVERY step, keys and values, not to the parts you expect to
   change.** `verify:targets` now compares the two `verify` jobs step for step, and also names each
   gate's xvfb and sysctl steps on their own, so deleting the pair from both files at once — which
   a mirror calls agreement — still fails. Each was shown to fail against a mutated copy, and the
   release.yml under review fails seven assertions.
2. **Read every precondition of a route, not only the first one you thought of.** A display is
   not enough for Electron on Linux: `sandboxProblem` skips the suite, naming the sysctl, where a
   userns knob refuses (`apparmor_restrict_unprivileged_userns=1`, Debian's
   `unprivileged_userns_clone=0`) and `chrome-sandbox` is not setuid root, or as root (gotcha 76).
   A skip is right there for the same reason no display is a skip: it is a fact about the runner.
   Neither gate should reach it: both relax the knob first, and `verify:targets` holds that.
3. **Grep the image, not the workflow, for what a runner has.** "ci.yml installs xvfb" was true
   and irrelevant: the route asks PATH, and PATH belongs to the image.

## 157. A secret-shaped test fixture written out whole is a leaked secret to GitHub, and the push is refused

**Found 2026-10-04, pushing redaction rule set 4.** `verify:chat-sources` proves each redaction rule
by feeding it a fake secret of the provider's shape, and GitHub's push protection scans every pushed
commit for those shapes. A Slack webhook URL in the suite, Slack's documented all-zero placeholder
(`T0000…/B0000…/XXXX…` under its hooks host; not spelled out here for the same reason), was refused
as a "Slack Incoming Webhook URL" (GH013).
Every commit in the push is scanned, so editing the file at HEAD was not enough. The literal had to
leave the history of the seven unpushed commits that carried it. That was a `git filter-branch
--tree-filter` over `origin/windows-install..HEAD`, run behind a backup branch, and its result
differed from the backup by that one file.

The rule: **build every secret-shaped fixture from pieces at run time.** Use `fake(prefix, n)` for
the body, and split the provider's own marker (`SLACK_HOOKS = 'hooks.' + 'slack.com/services/'`) so
no line holds a whole provider shape. This applies to test ids, placeholders and "obviously fake"
values alike. The scanner reads shapes, not intent. A suite that needs the literal form (a placeholder
the rule must leave alone) assembles it the same way. If a push is refused anyway, never use the
"allow this secret" link: rewrite the unpushed commits.

## 161. Under reduced motion every property change is a 1 ms transition, so a same-task read is stale and a window drawing no frames never finishes it

**Found 2026-10-27, on the macOS and Windows CI legs.** app.css ends with a global block,
`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … transition-duration: 1ms
!important } }`. `transition-property` defaults to `all`, so under it EVERY property change on
every element is a transition, 1 ms long but still a transition. Two consequences for anything
that measures:

- **A `getComputedStyle` in the same task as the change reads the OLD value.** A transition
  starts on the next frame. verify:tab-overflow's palette audit switched theme and read the tab
  edge's colours in one evaluation, and under forced reduced motion got the previous theme's
  ("tab edge contrast on daylight" failed).
- **In a window that draws no frames, the transition never finishes.** It holds its start value
  while non-animatable properties (`position`) land at once. verify:remote-draft's dock measured
  1 + 4 + 28 + 4 = 37 px for 68, because `padding-top` stayed at 4px. That is the windows-latest
  number exactly (ffa9975, job 122052788712). Rehearsed on a Mac with `--force-prefers-reduced-motion`
  plus frozen animations (CDP `Animation.setPlaybackRate` 0), and separately in a hidden window that
  stops painting: both 68 → 37 without the fix. Reduced motion alone passed on the Mac, whose
  hidden window kept drawing frames.

CI runners can report reduce (inferred: the same Windows leg failed tab-overflow's pulse check,
which only reduce turns off). The rule: **a suite that reads computed style or geometry pins
`prefers-reduced-motion` through CDP `Emulation.setEmulatedMedia`** for the whole run. It switches
to `reduce` only for its reduced-motion checks, asserts that each emulation took, and clears it at
the end, asserting the machine's own setting is back. Each suite prints that setting first, so a
CI log says which case ran. verify-tab-overflow.mts and verify-remote-draft.mts are the shape;
in each, removing a pin turned its rehearsal red. Pinning only around one check is not enough: a
cleared emulation before the palette audit failed it again.

Two guards ride with the pin in verify-remote-draft, because only screenshots need frames:

- **A bounded frame probe** after the window's reload. `requestAnimationFrame` raced against a 1 s
  timeout prints how many frames were drawn and cancels its last request. `document.visibilityState`
  cannot tell: it reads `visible` for a hidden window with `backgroundThrottling: false`.
- **A 10 s deadline on each `captureTestWindow`** (it waits on `requestAnimationFrame` with no
  deadline of its own) that throws `ScreenshotStalled`. `ci-verify.mjs` has no per-suite timeout,
  so a capture waiting on a frame that never comes would hold the leg until the job's own timeout.
  Rehearsed in the stopped window: with the deadline it failed by name at 16 s; without it, it was
  still waiting when stopped at 45 s.

**Unverified, in app code:** the same block makes any app code that measures right after a style
change read stale values for a person with Reduce Motion on, for example the title bar's hidden
measurer (`fitTopBar`, gotcha 155) and anything reading a theme's colours just after
`applyTheme`. Observed only through the suites; no app path has been checked.

> **Checked on 2026-10-28** — the Windows leg's verify:tab-overflow failure (runs 40520686629,
> 40582687313: the strip at 285, the left scroll button still disabled) was this entry's second
> case without reduced motion. `useTabOverflow` re-reads its edges from the strip's `scroll` event
> and a `requestAnimationFrame`, and Chromium runs both only in its rendering steps, which a hidden
> window on windows-latest barely has (verify:remote-draft printed 1 frame in 1 s there). The suite
> read the button 100 ms after a scroll. Rehearsed on a Mac in a hidden window that stops painting
> (`paintWhenInitiallyHidden: false`, `backgroundThrottling: true`): 0 to 4 frames a second and the
> same failure at 291. So:
> - **Wait on frame-driven state with a bounded poll that names what never happened**, never a
>   fixed short sleep and a read. At one frame a second every such poll then passed in under a
>   second; a mutant `useTabOverflow` with no scroll listener still failed by name. The same shape
>   fixed verify:hub-server's graceful-shutdown check, which closed the hub 30 ms after starting a
>   sign-in and, at load average 31, before the request had arrived: it now waits for Node's
>   `http.server.request.start` diagnostics channel for that request.
> - **On Windows the suite shows its window without focus** (`showInactive`, plus
>   `disable-backgrounding-occluded-windows` at module scope), where it draws at full rate; Linux
>   under Xvfb always was shown. macOS stays hidden: its hidden window drew 144 frames a second, and
>   a shown one would come up over the owner's work on every `npm run check`. A 1 s frame probe
>   prints what each run got.
> - **`captureTestWindow` (scripts/capture-test-window.mts) is bounded over the whole capture**, the
>   frame wait AND `capturePage`, which also never answers in a stopped window (still waiting at
>   40 s), and throws `ScreenshotStalled` after 10 s. Every suite that screenshots through it is
>   bounded now, not only verify:remote-draft, whose own wrapper is redundant but harmless.

## 174. A server a suite starts runs its real timers against the suite's fake clock

**Found 2026-10-28: verify:hub-server failed "nor did a sign-in counter move through the second
lockout" twice in the shared tree, both under heavy load (runs of 115 s and 3:39), and passed in a
scratch copy at normal load (46 s).** The hub sweeps old rows on a real `setInterval` of `SWEEP_MS`
(60 s), while the suite's clock is fake and by then 45 minutes ahead. Any run slower than a minute
let the real timer fire, and the sweep, judging by the fake clock, deleted the per-IP throttle rows
the check compares (25 `ip:…/64` rows gone): exactly what a lockout regression looks like. Proven on
HEAD's own code: a copy with `SWEEP_MS = 1_000` failed exactly that check. `HubConfig.sweepMs`
(default `SWEEP_MS`, so production is unchanged) is set to an hour in the suite's main hub and its
storage-cap hub, as `pingMs` already was; with the default forced to 1 s the suite then passes.

The rule: **every real timer a server starts gets a config override, and a suite that runs that
server on a fake clock sets it.** A timer the suite does not control fires only on a slow run, which
means a CI runner or a loaded machine, and reads as a flaky product bug. When a suite gains a fake
clock, grep the server for `setInterval` and `setTimeout`.

## 175. A mutation that stays green is a finding about the suite, not proof the guard is redundant

**Collected 2026-10-28 from five groups' mutation runs, each on a scratch copy of the tree.** Four
shapes let a guard be deleted with every suite green. Each was found because a mutant survived, and
each was fixed with a check, never by deleting the guard:

- **A suite whose fakes carry their own constants never tests the shipped ones.** verify:pty-exit
  drove `settleQuit` with fake deps, so `deadlineMs: 30_000` in `systemQuitSettle` and a no-op
  shipped `lastResort` both stayed green. It now asserts `systemQuitSettle(platform)`'s bounds for
  darwin, linux and win32, and runs the REAL last resort against two children it starts itself.
- **A harness that crashed passes "nothing was removed".** The stand-in `arecord`'s python owner
  check (micStandIn.ts), mutated out, stayed green: the harness's wrapper defined a global `real`
  that clashed with the connector's own, so the connector crashed (a Traceback), and "another
  user's socket is kept" held vacuously. The harness now also requires the connector to run
  to its own end (exit 1, no Traceback). Any check that asserts an absence must also assert the code
  reached the place where it would have acted.
- **Two layers hide each other.** A guard built twice survives any single mutation of either: the
  connection log's tag table and its field rule (gotcha 171), the join deadline's timer cleared at
  the handshake AND checked against the channel's state (gotcha 173). Give each layer its own unit
  check, and show the end-to-end check red with both off.
- **A source-text check must pin each holder, not just the call.** verify:tabs read that
  `resumeSession` asks `chatOpenPlan`, and a mutant that stopped passing the paused card as the
  plan's holder (a paused chat picked in the sidebar would start a second `claude` on its
  transcript) stayed green, as did one where `openChat` never released its claim. Both are pinned
  now (gotcha 176).

One mutant stays green honestly. Perl's "no pattern" mutation in the stand-in is EQUIVALENT: the
perl loop's own token regex already skips such names before `gone` is reached. Record an equivalent
mutant as one, with the reason, rather than writing a check that cannot fail; only a fixture that
passes the outer layer reaches the inner one.

## 180. A synthesized touch scroll gesture sends no touchmove on Linux, so drive a finger with dispatched touches

**Found 2026-10-28: CI's gating Verify job was red on four pushes in a row** (runs 40650955792,
40658756289, 40664680841, 40687038232), every time on verify:account-remote's "a finger scrolls the
list under a fixed bar to its last session", every time with the same reading,
`{"top":0,"bar":0,"page":0,"row":1021}`. The macOS leg passed it on the one run that reached it
(c561409); on the other three it stopped a check earlier, at gotcha 182's layout lag. The suite
swiped with CDP `Input.synthesizeScrollGesture` and `gestureSourceType: 'touch'`, Chromium's own
synthetic gesture.

The page was not at fault. A throwaway diagnostic on the same ubuntu runner (Electron 43.2, X11
under `xvfb-run -a -s '-screen 0 1280x1024x24'`, branch `diag/linux-touch`, deleted after) drove a
plain overflow box, the control, with every input, in the suite's own window shape, and counted the
page's events:

| Input | Linux | macOS |
|---|---|---|
| `synthesizeScrollGesture` touch, at y 300 or 640 | 1 touchstart, **0 touchmove**, scrollTop 0 | 4-5 touchmove, ~400 px |
| the same with phone emulation, or with `--touch-events=enabled` | the same: nothing scrolls | — |
| `synthesizeScrollGesture` mouse (wheel) | 17 wheel, 400 px | 400 px |
| `Input.dispatchTouchEvent`: start, 20 moves 16 ms apart, end | 20 touchmove, ~450 px | ~480 px |

So on Linux the synthetic touch gesture delivers its touchstart and then nothing: no page or CSS
can scroll from it. A screen-size clamp was ruled out first: ci-verify gives xvfb 1280x1024, and the
window measured 390x844 inside it.

The rule: **drive a finger through `Input.dispatchTouchEvent` (`scripts/touch-drag.mts`'s
`touchDrag`): touchstart, touchmoves a frame apart, touchend, all inside the viewport.** These are
trusted events through the browser's input pipeline, not events a script dispatched, and they
scroll on Linux and macOS alike. verify:account-remote and verify:phone-scroll both swiped with the
synthetic gesture; both use the helper now, and both pass on the Linux runner and on the Mac.

**And once the swipe was fixed, the next suite hit the same runner's other half.** verify:phone-scroll's
"Ctrl+D, second tap" ended "Confirm, nothing sent" on Linux (passing on the Mac). A timestamped event
log of the real fixture on the runner showed why: there, a driven touch REACHES THE PAGE 1.4-2 s after
`Input.dispatchTouchEvent` is sent, and the reply follows delivery. The suite sent touchEnd only after
touchStart's reply, so each tap's halves landed 2,033 ms apart, the two Ctrl+D clicks 4,066 ms apart
(684 ms on the Mac), and the key's 3 s confirm window had closed. The app was right. Two runs pinned the
mechanism: sending both halves together and awaiting both put them in the page in the same
millisecond and passed, while not awaiting at all left the page empty when the suite read it 250 ms
later (`events: []`). A plain button on the same runner tapped in 6-12 ms and touchmoves in a drag were
not slow (verify:account-remote's ~80 awaited moves ran in 29 s), so the delay belongs to that fixture
on that runner; its cause was not found. The rules: **send a tap's two halves together and await both
replies**, and **never let a test depend on a window shorter than the runner's delivery delay**. Ctrl+D's
window is now an option (`eofConfirmMs`, default `EOF_CONFIRM_MS`, 3 s), widened in the suite only, with
the shipped 3 s asserted on its own (gotcha 174's rule for real timers, applied to a component).

Two smaller lessons from the same four red runs:

- **Watch CI after every push, not only before a release.** The gate went red on the first push of
  the touch checks and stayed red for three more pushes before anyone looked.
- **A gesture check needs a control on the same runner before its failure means anything.** The
  diagnostic's plain overflow box is what turned "the list does not scroll on Linux" into "nothing
  scrolls from that gesture on Linux".

> **Checked on 2026-10-28, later the same day** — the 1.4-2 s delivery delay above, "its cause was not
> found", was verify:phone-scroll's HIDDEN window (gotcha 183). Shown, the same suite runs in 17 s on
> the Linux runner against 59 s hidden; its window is now shown off macOS. Sending a tap's halves
> together and the suite-only `eofConfirmMs` stay: both are right whatever the runner's delay.

## 181. A deadline shrunk to 1 ms against a real process is a race, not a test

**Found twice, the second time because the first fix lived only in a code comment.** verify:git
(2026-10-02, on the v1.0.0-beta.1 release gate) and verify:work-mode (2026-10-28, the gating Verify
job, run 40692270523) each proved "git took too long" by handing the REAL git a 1 ms deadline
(`timeouts: { status: 1 }`, `timeouts: { list: 1 }`). On a developer's Mac the timer always wins,
because spawning git there takes longer than 1 ms, so the check passed every local run and every
`npm run check`. On the Linux runner git listed a three-file repository first, and Work mode's check
read `[null, 2, false]` where it wanted `["slow", 0, false]`. execFile arms its timer once the spawn
has returned, and the timer and the child's exit are two events that nothing orders. verify:git had
been fixed with a stand-in git that stalls before `status`; Work mode's suite, written later, repeated
the 1 ms pattern, since no rule named it.

The rule: **to prove a deadline fires, give it a process that cannot answer in time, never a real one
that is usually slower.** Both suites now hand the reader a POSIX stand-in git (`slow-git`) that
stalls on the one subcommand under test and runs the real git for everything else, against a
deadline of a few hundred ms. Work mode's `exec`s the sleep (`exec sleep 30`), so the process the
deadline kills is the sleep itself and nothing outlives it; verify:git's sleeps and then runs git, so
its sleep is left running for the rest of its 2 s after the kill. Mutated to map `killed` to
`null`, Work mode's check goes red with `["unreadable",0,false,true]`. On Windows both checks are a
SKIP: execFile cannot start a script there, and the timeout is the same code on every platform.

A 1 ms deadline is still fine where the check accepts either outcome: verify:work-mode's "with every
deadline at 1 ms it resolves in under 500 ms and never throws … with a reason or some files" asserts
only that nothing hangs, throws or leaks.

## 182. An emulated screen reaches `innerHeight` at once and laid-out elements a frame later

**Found 2026-10-28, on the non-gating macOS and Windows legs.** verify:account-remote's phone checks
set `Emulation.setDeviceMetricsOverride` to a 390x844 phone, waited for `innerHeight === 844`, and at
once read "the list is a scroller bounded by the screen". The macos-14 leg failed it three runs in
four with `{"client":764,"scroll":1026,"bottom":816}`, the Windows leg with `"bottom":655`: each the
REAL height of the suite's window there (844 less macOS's 28 px title bar; a window clamped to a
1024x768 desktop's 720 px work area). The ubuntu gate passed every time, because under xvfb, with no
window manager, the window's real height is 844.

The emulation was not lost, only late for what was already on the page. Polled every 25 ms from the
moment `innerHeight` said 844 (branch `diag/linux-touch`, deleted after):

| runner | real window | first read | 27 ms later |
|---|---|---|---|
| macos-14 | 390x816 | `innerHeight`, `visualViewport` and `clientHeight` 844; `#app` (100dvh) and the list end at 816 | both at 844 |
| windows-latest | 374x655 | the same, ending at 655 | both at 844 |

On the owner's Mac the two agree from the first read, in a 568 px window and at a forced 1x scale,
which is why every local run passed.

The rule: **after any screen emulation, wait until an element laid out in viewport units BEFORE the
override has the new size, never until `innerHeight` does** (`screenIs` in drive-account-remote.mts:
a fixed, hidden 100dvw x 100dvh probe of the suite's own, made and measured first, then the
override, then the wait). The first cut made the probe after the override, and it waited for
nothing: an element made then is laid out fresh, at the new size at once, while the page's own still
had the old one, and the same check failed with the same `816` and `655`. A probe of the suite's own,
not the page's `#app`, because waiting on the element under test turns its failure into a timeout.
Every emulation in that drive goes through `screenIs`: the 470 px "keyboard" and the 1280x800 laptop
too. probe-e2e.mts, the only other driver that emulates, sleeps 200-300 ms after each override,
which covers 27 ms but is a guess; left alone.

Once the layout was read late enough (the diagnostic's own 6 s of polling), the Windows leg died with
"Unhandled 'error' event" (ECONNRESET) and printed nothing of what the page had done. The suite's front
proxy took WebSocket upgrades with no `error` listener on the upgraded socket, which is the caller's to
guard once the http server hands it over. The reset came from the suite itself: its 60 s limit killed
the page's Electron mid-swipe (gotcha 183), and Windows resets a killed process's connections. With a
listener the same kill reports as an exit code of `null`, the suite's own kill, instead of a crash,
which is how gotcha 183 was found.

## 183. A touch dispatched into a hidden window answers after about a second off macOS, so show the window there

**Found 2026-10-28, on the non-gating Windows leg.** With gotcha 182's layout wait in place,
verify:account-remote still failed on windows-latest, now as `null !== 0` with no output: the suite's
own 60 s limit had killed the page's Electron. Every call over 300 ms, timed on that runner (branch
`diag/linux-touch`), showed where the time went. Each `Input.dispatchTouchEvent` into the drive's
hidden window answered after 983 ms, steadily, over the device list, and after 2,983 ms over the
terminal, so the two list swipes alone took 70 s and the phone checks 132-160 s in two runs. The same
drive with its window shown, on the same runner image, finished the phone checks in 16 s with no call
over 300 ms at all. A hidden window on the macos-14 runner and on the owner's Mac takes the same
touches at once (the whole suite 26-31 s), which is why the window was hidden there in the first
place: nothing is shown over the owner's work. The near-exact 1 s and 3 s read like timeouts, as if
the browser gives up waiting for the hidden page's answer to each touch and hands it on; that is a
reading of the numbers, not of Chromium's source.

The rule: **drive touches only into a window that is shown, except on macOS** (`show:
process.platform !== 'darwin'` in drive-account-remote.mts and verify-phone-scroll.mts). It holds on
Linux too. verify:phone-scroll's window was hidden on every platform, and the 1.4-2 s touch delay
gotcha 180 measured in it on the Linux runner, cause then unknown, was this one: the whole suite took
59 s hidden and 17 s shown on ubuntu-latest, 64 s and 17 s on windows-latest, passing all four ways.
Off macOS a shown window is a real window on a developer's screen for the length of the suite (under
xvfb nobody sees it). Suites that dispatch no touches keep their windows hidden off Linux.
