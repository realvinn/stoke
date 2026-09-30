---
paths:
  - "scripts/verify-*.{mts,mjs}"
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
