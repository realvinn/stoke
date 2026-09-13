---
paths:
  - "scripts/verify-*.{mts,mjs}"
  - "scripts/ci-verify.mjs"
  - "package.json"
  - "tsconfig.node.json"
  - "tsconfig.web.json"
  - "src/preload/index.ts"
  - "src/shared/*.ts"
  - ".github/workflows/release.yml"
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
