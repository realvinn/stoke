---
paths:
  - "src/main/cli.ts"
  - "src/main/pty.ts"
  - "src/main/agent.ts"
  - "src/main/updates.ts"
  - "src/renderer/src/lib/updateVerdict.ts"
  - "src/shared/claudeConfig.ts"
  - "scripts/verify-cli.mts"
  - "scripts/verify-updates.mts"
  - "scripts/verify-worklog-runner.mts"
  - "src/shared/agents.ts"
  - "src/shared/codingClis.ts"
  - "scripts/verify-agents.mts"
  - "scripts/probe-clis.mts"
---

# Finding and running `claude`

Locating and spawning `claude`, its env, headless `claude -p` output, and CLI update channels.
Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are
permanent — code comments cite them as "CLAUDE.md gotcha N".

## 1. Inherited Claude env vars silently break transcripts

**Inherited Claude env vars silently break transcripts.** If Stoke is launched from
inside a Claude Code session it inherits `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PID`. The spawned session is
then a "nested child" and **transcript saving is disabled**, which kills session resume
*and* the context meter. `pty.ts` strips them. Auth/config vars are preserved.

## 41. `--output-format json` stopped being one object, and it took every headless run with it

**`--output-format json` stopped being one object, and it took every headless run with it.**
The help text still reads `"json" (single result)`, and up to `claude` 2.1.221 it was one.
**2.1.237 prints the whole message array** — `system/init`, `rate_limit_event`, the assistant
turns, then the `type: "result"` object last. Measured here on 2026-08-25: a successful run
returned an 8-element array and exited 0, a budget-exhausted one a 4-element array and
exited 1.

`agent.ts`'s `parseEnvelope` rejected that **twice**, and the second rejection is why the
failure was unreadable rather than merely wrong. `JSON.parse` succeeded and the
`!Array.isArray(v)` guard threw the value away; the brace-scan fallback then sliced from the
first `{` to the last `}` and produced `{…},{…},{…}`, which is not JSON. So every worklog
scan, recall and apply failed: a clean run raised `The headless run returned no JSON result`,
and a non-zero exit raised `The headless run failed (exit 1): [{"type":"system"…` — 400
characters of raw stdout in place of the reason the CLI had just stated in the envelope it
printed. The reported error is therefore never the real one; fix the parse before diagnosing
anything else.

**`npm run check` could not see it, and the reason generalises.** Every budget assertion in
`verify-worklog-runner.mts` is handed a `HeadlessResult` that has *already* been parsed, so
all of them stayed green while no headless run on this machine could complete. Gotcha 31 one
layer down: the wire from stdout to that object was the only untested part of the path, and
it was the part that broke. `parseEnvelope` is exported now and both shapes are asserted,
array first — an object's own `permission_denials: [...]` is the first `[` in its text, so
the array scan has to fall through rather than win, and the result is found by `type` rather
than by being last.

While measuring this, two costs worth carrying. A **trivial** sonnet run under `--safe-mode
--strict-mcp-config` cost **$0.1224**, of which $0.1215 was 20,239 cache-*creation* tokens
for the system prompt and 26 tool definitions — $6.00/Mtok, the **1-hour** cache-write tier.
That is the fixed floor of any sonnet headless run before the prompt is considered, and
`--max-budget-usd` cannot prevent it: the cap is checked *after* the turn, so a $0.05 ceiling
still billed $0.12. `SCAN_MAX_BUDGET_USD` ($0.30) clears it with a 6000-char digest
(~$0.13 total) but not by much. Second, `--allowedTools` prunes the tool schemas actually
sent, so the apply and recall runs do **not** pay for all 427 tools of 30 MCP servers —
measured at 15,610 cache-creation tokens with the allowlist down to one name.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - SCAN_MAX_BUDGET_USD is now 10 (src/main/worklog/runner.ts:853), as are APPLY_MAX_BUDGET_USD (runner.ts:880), RECALL_MAX_BUDGET_USD (src/main/worklog/recall.ts:357) and agent.ts's DEFAULT_MAX_BUDGET_USD (src/main/agent.ts:69). The note at runner.ts:816-837 says every ceiling was raised to $10 as a runaway guard, so 'clears the $0.12 floor but not by much' no longer holds. The ~$0.13 figure for floor plus a full digest is still what runner.ts:845 states.

## 46. The CLI has a release *channel*, it is a setting, and Stoke spent several releases asking one channel a question and acting on another's answer

**The CLI has a release *channel*, it is a setting, and Stoke spent several releases asking
one channel a question and acting on another's answer.** Measured 2026-08-28: the registry
said 2.1.250, the installed CLI was 2.1.237, and `claude update` answered *"You're running
2.1.237, which is newer than the stable channel's 2.1.236. Skipping update."* — exit 0,
nothing changed, `updateAvailable` still true afterwards.

**This entry used to call that "a stable disagreement" between two sources and leave it
there. That was wrong, and the correction is the useful half.** It is one source read two
ways. `~/.claude/settings.json` carries **`autoUpdatesChannel`**, the CLI defaults it to
`latest` (`settings?.autoUpdatesChannel ?? "latest"`, read out of the 2.1.237 bundle), and
`claude doctor` prints it as `Auto-update channel:`. This machine had it set to `stable`.
`checkForUpdate` hardcoded the npm `latest` dist-tag, so the panel advertised 2.1.251 against
an install following a channel that sat at 2.1.236 — fifteen releases apart, permanently.
It reads `channelFrom(readClaudeSettings())` now and fetches that dist-tag, which on this
machine turns `latest: 2.1.251, updateAvailable: true` into `latest: 2.1.236,
updateAvailable: false, channel: "stable"` — the same answer `claude update` gives.

**The sharpest part is that Stoke already drew the control it was ignoring.**
`shared/claudeConfig.ts:200` offers `autoUpdatesChannel` as "CLI update channel". So one half
of the app wrote the key and the other half did not read it. Anything that both draws a CLI
setting and acts on the same subject has to read it back; there is no third source of truth.

**The two channels agree across their two publishers, which is what makes one npm request
enough.** Measured 2026-08-31 in both directions — npm `dist-tags` and the GCS objects under
`claude-code-releases/<channel>` both give `stable` 2.1.236 and `latest` 2.1.251. `next` is
an npm tag with no GCS object; **`rc` and `slow` appear in the CLI's own config-row
vocabulary and publish neither**, so `distTagFor` lets them 404 and `checkForUpdate` reports
*"the CLI follows the "rc" channel, which npm does not publish"* rather than silently
substituting a number from a channel the CLI is not on. Stoke's own option list still offers
`rc`; selecting it pins the CLI to a stream with no releases. `disabled` is the fourth value
and is not a channel at all — it maps to `latest` for *display* so "switched off" and
"already current" are not the same screen, and `shouldAutoUpdate` refuses to act on it,
before the error gate so a disabled channel whose check also failed still names the real
cause.

**A stable channel can move backwards, so "newer than stable" is not a paradox.** Doctor
reported `Last update attempt: success → 2.1.237 (2026-08-20)` on a machine where stable was
2.1.236 four days later. The tag was rolled back under an install that had already taken it.
An install being *ahead* of its channel is a normal state, and the only thing to do about it
is switch channel or `claude install <version>` — `claude update` is right to decline.

`AutoUpdateAttempt` (target, from, failed) stays even though its first cause is fixed,
because the shape outlives it: an install `claude update` cannot write to, and a channel that
moves between the check and the run, both look like a clean run that bridged nothing. A
**failure** can be transient and is retried on a timer; a **clean run that changed nothing**
is not retried until one of the two versions moves. Related, and the reason `runUpdate` reads
the version either side at all: exit status cannot answer "did it update", because
0-with-no-change is what both "already current" and "cannot write to this install" look like.
The panel quotes the CLI's own last output line for that case rather than paraphrasing it.

**And do not print a diagnosis the tool can disprove.** `updateVerdict` used to end that case
with *"an npm-global or Homebrew install usually has to be updated by its own package
manager"* — confident, printed exactly when someone is looking for a cause, and wrong for the
case that produced it: `claude doctor` answered `Running: npm-global (2.1.237) …
Auto-updates: enabled … **No installation issues found**`. The install was fine; the channel
was the whole story. Following that advice means reinstalling a working install. It names
`claude doctor` now, which prints both candidate causes, and asserts neither.

None of this was reachable from `npm run check`: every assertion in `verify-updates.mts` was
handed an `UpdateInfo` that had already been built, so the wire from settings to that object
was the one untested part of the path — gotcha 31 again, and the same shape as gotcha 41's
pre-parsed `HeadlessResult`. `channelFrom` and `distTagFor` are exported and pure so the rule
is assertable at all.

**Reading the channel correctly then made Stoke silent about the channel itself, and that
silence was its own bug.** Measured here 2026-09-02: installed 2.1.237, `stable` at 2.1.236,
`latest` at 2.1.258. Every part of the machine was behaving — `claude update` declined
because the install was *ahead* of its channel, the panel reported nothing to install
because on that channel there was nothing to install, `claude doctor` found no installation
issues — and the CLI sat twenty-two releases behind for weeks with nothing anywhere saying
so. Fixing "we advertise updates the CLI will refuse" had quietly created "we never mention
that the pin is the reason". It surfaced only because a feature needed 2.1.255 and someone
went looking.

`channelLag` is the missing sentence. When the channel is not `latest`, `checkForUpdate`
now fetches **both** tags — in parallel, and the second request is not made at all on the
machines already on `latest`, which is most of them — and reports the gap as `behindLatest`
*alongside*, never instead of, `latest`. That separation is the whole design: `info.latest`
must keep meaning "what the configured channel would install", because it is the only number
`claude update` will act on, and overwriting it with the other channel's version is exactly
the bug this entry opens with. The panel offers to switch and update in one press; Stoke
never does it unasked, because a deliberate `stable` is a legitimate choice and the channel
is a setting Stoke merely draws.

Two things worth carrying. A channel that publishes **nothing** (`rc`, which Stoke's own
control offers) is reported as a lag rather than only as a 404 — "you will never update
again" wants the same remedy as "you are stale" — which is why the lag is computed *before*
the error return. And the notice is a plain string rendered as-is: backticks written round
`claude update` painted as literal backticks, which no assertion saw and one screenshot did.
The neighbouring hints wrap code in a `mono` span; a function that has to stay JSX-free so
`verify:updates` can run it cannot, so the suite asserts the absence of markdown instead.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The `autoUpdatesChannel` row is now at src/shared/claudeConfig.ts:231-239 (key at :232, label 'CLI update channel', options ['latest','stable','rc']). Line 200 is now `label: 'Thinking'` inside the `alwaysThinkingEnabled` row. The doc comment at src/main/updates.ts:222 repeats the same stale `:200` reference.
> - `readClaudeSettings()` is async and returns a `ClaudeSettingsRead` (src/main/claudeSettings.ts:97). The real call is `channelFrom((await readClaudeSettings()).values)` at src/main/updates.ts:229, and it has had that form since it was added in 4a5f32a. So the quoted shape is a loose paraphrase that would not typecheck, not something that drifted later.

## 52. "Stoke cannot access claude" was one probe away from being permanent, and the binary was fine the whole time

**"Stoke cannot access claude" was one probe away from being permanent, and the binary was
fine the whole time.** `claude --version` answered `2.1.237` from a shell while the app
insisted *"Could not find the `claude` executable. Install Claude Code."* Following that
message means reinstalling a working install.

Three facts compose into it, and only the third is a bug on its own.

**`claude` can live in exactly one directory.** Installed through a version manager it sits
at `~/.local/share/mise/installs/node/lts/bin/claude` and **nowhere else** — measured here
as absent from all ten directories `extraSearchDirs()` fell back to, `~/.local/bin` and
`~/.claude/local` included. **`mise activate zsh` is in `.zshrc`**, so that directory reaches
PATH only in an *interactive* shell, which is why the probe is `-ilc` and why the `-i` is
load-bearing. And a Finder-launched app inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin` —
read straight out of the running process with `ps -E`, which is the quickest way to settle
what a GUI launch actually got.

So the login-shell probe was not an optimisation, it was **the only channel**, with a 5s
timeout, in front of a `.zshrc` that runs `pyenv init`, `starship init`, `fzf`, `zoxide`,
zsh-syntax-highlighting and a stat against an external USB volume. Warm it measures
366-934ms. It does not have to fail often to be a problem, because —

**a failure was cached for the life of the process.** `loginPathProbe ??=` treats `null` as
"nothing cached yet", so the previous fix held the *promise* to stop two boot callers
stampeding (`App.tsx:363,366`). That overshot: one slow boot and the app could never find
`claude` again until it was quit and reopened. Both extremes are wrong, which is what makes
"sometimes, and a restart fixes it" the signature. The failure now stands for
`PROBE_RETRY_MS` (30s) and no longer, and `shouldReprobe` is a pure exported gate separate
from the spawn, for gotcha 31's reason.

**The durable half is that the probe is no longer load-bearing.** Every version manager
publishes a shim directory that needs no shell hook at all:
`~/.local/share/mise/shims/claude` answers `--version` correctly with PATH set to nothing
but the four system directories — verified. `shimDirs()` names mise, asdf and fnm, honours
`MISE_DATA_DIR`/`ASDF_DATA_DIR`/`FNM_DIR`/`XDG_DATA_HOME`, and sits **before** the system
directories so a stale `/usr/local/bin/claude` cannot outrank the managed one. nvm is
deliberately absent: it has no stable shim dir, only `versions/node/<version>/bin`.

Counterfactual, both directions: with the probe forced past its timeout, `findClaude`
returned `null` before the change and `~/.local/share/mise/shims/claude` after it, with
`probeClaude` going from the not-found message to `ok: true, version 2.1.237`.

Two smaller things. An **empty** stdout from the probe used to be cached as a success
(`stdout.trim() || null` returns null, which the guard then re-reads as "not cached") — it
is a failure now. And the not-found message is two messages: gotcha 46's rule again, do not
print a diagnosis the tool can disprove.

**There are four places that can miss, not one, and the one that matters is not the one
with the good message.** `probeClaude` feeds the settings chip; `pty.ts:157` is the throw a
user actually hits when starting a session, and `updates.ts:246` and `agent.ts:389` cover
`claude update`/`doctor` and every headless worklog run. All four go through
`notFoundError()` now, or the useful message reaches only the surface nobody was looking at.

**And the first draft of that message broke gotcha 46 in the act of citing it.** It said
*"this retries by itself shortly"* — which nothing performs: the renderer sets `CliInfo` on
boot and on an `updates:state` push (`App.tsx:394,427`), and the only automatic push lands
at 12s (`index.ts:856`, inside the 30s cooldown) and then every six hours. What IS true is
that `pty.ts` calls `findClaude` afresh on every session start, so *trying again* re-probes.
The number in the text is derived from `PROBE_RETRY_MS` rather than retyped, so a cooldown
change cannot silently make it a lie.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The two boot callers are now at src/renderer/src/App.tsx:627 (`cli.info()`) and :630 (`updates.check()`). The comment at src/main/cli.ts:24-25 repeats the same stale 363/366 references.
> - The findClaude call and the notFoundError throw are now at src/main/pty.ts:163-164.
> - The update/doctor miss is now in `runCli` at src/main/updates.ts:339-341. Line 246 is a comment inside `checkForUpdate`. agent.ts:389 is still correct (`if (!exe) {`, with the throw at :390).
> - Boot is now src/renderer/src/App.tsx:627 (`void window.stoke.cli.info().then(setCli)`). The `updates.onState` handler that re-reads CliInfo is at App.tsx:594-597, with the `cli.info()` call at :596.
> - The 12s `setTimeout(() => void refreshCliUpdate(), 12_000)` is now at src/main/index.ts:1116, and the six-hour `setInterval(..., AUTO_CHECK_MS)` is at :1117. `refreshCliUpdate` (index.ts:190-249) sends CH.updateState.

## 81. `--resume` and `--session-id` fail in opposite cases, so the flag is decided against the disk

**Which of the two flags works depends on one fact — whether the id has a transcript — and nothing
the renderer holds states it reliably.** Measured against 2.1.278 on 2026-09-19:

```
--resume U       U has no transcript   -> exit 1: "No conversation found with session ID: U"
--session-id U   U has a transcript    -> refused: "Session ID U is already in use"
--resume U --session-id U              -> refused: --session-id with --resume needs --fork-session
--session-id U   U has none, and the previous process on U is still dying -> ACCEPTED
```

A session has no transcript until something is written to it, yet its statusLine payload — and so
the relaunch pill — arrives before the first prompt. So relaunching a session nobody had typed into
ran `--resume` on nothing and the tab came back dead; the same happened to a restored tab whose
conversation was never written (gotcha 35's "resumes to nothing"). What writes a transcript is
machine-dependent, too: here `/clear` writes one for its new id at once, because the user's own
`SessionStart` hooks produce output the CLI records — on a machine without such hooks it would not.

`resumeOrMint` (cli.ts) is the one decision: an id with a transcript is resumed, one without is
started afresh under the SAME id with `--session-id`, which keeps the tab's identity and the meter's
key. `launchSession` (index.ts) calls it right before the spawn, against both `~/.claude/projects`
and `CLAUDE_CONFIG_DIR/projects` — `projectsRoot()` ignores `CLAUDE_CONFIG_DIR`, and a wrong "no
transcript" is the expensive direction, since the CLI then refuses a conversation that exists. The
renderer's `relaunchPlan` still says `fresh` (from `contexts[id].ready`), but only as what it asks
for and what the tooltip says; main has the last word. `verify:cli` holds the table. Driven against
the built app: a never-prompted session relaunched as `--session-id b4adba2f…` and came up on the
banner; the counterfactual, `--resume` on an id with no transcript, exited 1 with "No conversation
found" in a probe run beside it.

## 84. `proc.onExit` deleting a session at once made every crash indistinguishable from the session never having existed

**`PtyManager.start()`'s `proc.onExit` used to call `this.sessions.delete(ptyId)` unconditionally**,
whether the process was killed by closing its tab or exited on its own — a crash, a fatal error, a
plain `/exit`. `server.ts`'s own `sessionList()`/`handleSocket` already had a branch for "a process
that has already ended is still listed... say so" (`info?.exited`), written on the assumption the
desktop keeps an ended tab visible the way `App.tsx`'s OWN, main-process-independent tab list does —
but nothing fed it, because the map entry the phone's `/api/sessions` reads was gone by the time
anyone asked. Audit finding F1: sent `/exit` over a phone WebSocket, got the documented
`{type:'exit', code:0}` frame live, then `GET /api/sessions` returned `[]` at once — the session
vanished with no trace rather than showing as ended.

The fix is to stop deleting on exit and start deleting on a timer. `onExit` now sets `session.exited
= true`, stamps `session.endedAt`/`session.exitCode`, and leaves the entry in `this.sessions`;
`list()` prunes anything past `ENDED_RETENTION_MS` (ten minutes, `src/shared/remotePhone.ts`) before
mapping. `write()`/`resize()` already refuse an exited session (`s.exited` check), so the ring is
read-only for free. **Only the explicit-close path (`kill()`/`stop()`) still deletes at once** — a
tab the user closed by hand must disappear immediately, which is the one piece of the old behaviour
that was correct and phone contract point 3 keeps. `registryTargets()` already excluded exited
sessions, so this changes nothing about what the registry poller watches.

> Recorded 2026-09-19, alongside the phone contract that needed it (`src/main/remote/server.ts`'s
> header comment).

> **Checked against the code on 2026-09-19** (review of qa/phone). Two corrections.
> - The suite used to test a shared `pruneEnded` that production never called; `PtyManager` pruned
>   through its own private copy. Both now go through `isEndedExpired(endedAt, now)` in
>   `src/shared/remotePhone.ts`, which `verify:remote` tests on a fake clock. It still does not
>   drive a real `PtyManager`.
> - "Changes nothing about the registry poller" held only for `registryTargets()`. `statusKeyFor`,
>   `bannerWindowFor` and `statusKeys` iterated exited entries too, and Map order puts the older,
>   exited one first: a session rebound by `/clear` (statusKey still the launch key K), exited, then
>   resumed on its new id S2, had `payloadKeyFor(S2)` answer K, whose files were released at exit,
>   for up to ten minutes. All three skip `exited` now; any new by-session-id lookup on
>   `this.sessions` must too.

## 99. On Windows a terminal got TWO PATH variables, and the stale one came first

**`pty.ts` copied `process.env` and then set `env.PATH = await buildEnvPath()`.** On Windows the
variable is spelled `Path`, and `Object.entries(process.env)` keeps that spelling — so the object
carried `Path` (inherited, stale) AND `PATH` (Stoke's, with every vendor install folder). The
line meant to repair it, `if (process.platform !== 'win32') env.Path = env.PATH`, was on the
wrong side of its condition: a meaningless `Path` everywhere except the one platform where it
matters. node-pty builds the Windows environment block in insertion order and a
case-insensitive lookup takes the first, so the child very likely saw the stale one. `agent.ts`
had the same shape and got away with it only because Node's own `child_process` sorts keys and
`PATH` sorts before `Path`. `setPathKey` (cli.ts) deletes every other spelling first, so exactly
one survives; `verify:cli` holds it and the old two-key counterfactual.

**And on Windows the PATH was never re-read at all.** `loginShellPath()` returned null there, so
a Stoke started before an install kept the PATH it was born with: an agent installed from its
own picker — or Node.js, which every `npm install -g` agent needs — sat "not found" until Stoke
restarted. The win32 branch now reads what a NEW process gets: the registry's machine then user
`Path` (`reg.exe query`, by absolute path, under the probe timeout), `%VAR%`-expanded
case-insensitively, memoised and forgotten after installs like the POSIX probe — but never
reported as a login-shell failure, whose wording would be false there. The picker's Windows
script does the same between steps (`Update-StokePath`, deduplicated: eighteen steps appending
unchecked could pass the 32,767-character limit), installs Node LTS through winget first when an
npm agent is chosen and npm is missing, and treats winget's "already installed" exits
(0x8A15002B, 0x8A150061) as installed. `findClaude` passes over `WindowsApps` without running
anything there: that folder holds Store aliases (Claude Desktop's can answer to `claude.exe`, and
it precedes `~\.local\bin`, which the native installer never puts on PATH), and asking it
`--version` could open a window. Claude Code is never installed there by any route.

Unverified until `.github/workflows/windows.yml` runs: the two-key block's actual effect inside a
conpty, `reg.exe`'s output shape on a real machine, and the Node install on a runner stripped of
Node (its `fresh-node` job).

> **Checked on 2026-09-21, after review and a first Windows run.** The registry is read through
> PowerShell now, not `reg.exe`: reg.exe converts piped output to the console code page (an
> accented profile folder arrived as U+FFFD) and cannot report the other Environment values, so
> a `%PNPM_HOME%` an installer defined after Stoke started stayed literal. `pathFromRegistry`
> expands against process env < machine vars < user vars, as Windows builds a new process.
> `gitBashPath` now decides the statusLine/hook syntax from the PATH the child gets
> (`buildEnvPath`), since the two can differ once the registry is read. And the install tab runs
> its script from a temp `.ps1` via `-File` (UTF-8 WITH a BOM for 5.1), not `-EncodedCommand`:
> every step inside is itself encoded, so "select all" measured 29,640 of Windows' 32,767
> command-line characters. A winget step on a machine with NO winget had ended `exit
> $LASTEXITCODE` — `exit $null`, exit 0 — and was reported installed (measured on the arm64
> runner, which has no winget); it fails with a reason now. The Windows workflow's build job
> proves the registry re-read (a tool only on the user PATH in the registry, found by a process
> whose PATH predates it) and runs `cmd /c echo %PATH%` through the real node-pty with the old
> two-key env and the new one.

> **Checked on 2026-09-21, after a second review and a third Windows run.** Three corrections.
> - The registry read came back EMPTY on windows-latest in one run (35564109862) and fine in the
>   run before, same commit shape: a cold Windows PowerShell 5.1 does not reliably answer inside the
>   login shell's 5 s. `windowsRegistryPath` now has its own `WIN_PROBE_TIMEOUT_MS` (20 s), closes
>   the child's stdin at once (execFile leaves a pipe open and nothing is written), and records why a
>   read failed (`windowsPathProbeError`), which `windows-e2e.mts registry-path` prints over three
>   fresh reads so a flake cannot hide either way. A session start does not pay the 20 s:
>   `buildEnvPath` races the read against `PROBE_TIMEOUT_MS` on Windows and the read carries on,
>   memoised, for the next caller.
> - `pathFromRegistry` layered the machine key over this process's env unfiltered, and HKLM's
>   Environment carries `USERNAME=SYSTEM`, so `%USERNAME%` expanded to `SYSTEM`; values that named
>   other values (`JAVA_HOME=%ProgramFiles%\Java`) stayed half-expanded. It now builds the scope as
>   CreateEnvironmentBlock does — profile variables (`PROFILE_VARS`) never from the machine key, each
>   value expanded against the scope so far — and `verify:cli` holds both cases.
> - The install tab no longer runs its script with `-File`: a script FILE is governed by execution
>   policy, and where Group Policy enforces AllSigned the command-line `Bypass` is overridden. It is a
>   fixed `-EncodedCommand` stub (`windowsInstallerArgs`, agents.ts) that reads the file named by
>   `STOKE_INSTALL_SCRIPT` into a script block, which execution policy does not govern; measured
>   under pwsh, the script's own `exit N` and a `throw` (1) still reach the process exit code. The
>   file is also removed in `kill()`, not only from `proc.onExit`, which a quit does not reliably run.
