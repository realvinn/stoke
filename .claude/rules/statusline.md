---
paths:
  - "src/main/statusLine.ts"
  - "src/main/pty.ts"
  - "src/main/context.ts"
  - "src/main/sessionFile.ts"
  - "src/main/projects.ts"
  - "src/shared/statusLine.ts"
  - "scripts/verify-context.mts"
  - "scripts/verify-statusline.mts"
  - "src/shared/contextLevel.ts"
  - "src/main/sessionRegistry.ts"
  - "src/shared/claudeRegistry.ts"
  - "scripts/verify-registry.mts"
---

# statusLine payload and context meter

The statusLine wrapper and its payload, the context window and meter, and the Windows shell the
shim runs under. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each.
Numbers are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 2. The context window's primary source is the statusLine payload, not the model id

**The context window's primary source is the statusLine payload, not the model id.** It
cannot be derived from the model id: a 1M-tier session records its model as plain
`claude-opus-5`, no `[1m]` suffix survives into the transcript, and there is no
`context_window` field. Verified again on a session at 713,617 tokens; the only tier-ish
field anywhere is `usage.service_tier`, which is billing. The CLI *used* to state it in its
startup banner and **2.1.221 does not** — the banner is now `Claude Code v2.1.221    Opus 5
with low effort · Claude Max`, and the word "context" appears nowhere in the startup output.

So Stoke installs its own `statusLine` command (`src/main/statusLine.ts`), folded into the
single `--settings` file at launch. The CLI pipes it a JSON payload on stdin whose
`context_window.context_window_size` is the window — per model, and correct from token zero.
The wrapper writes it to `<tmpdir>/stoke/statusline/<statusKey>.json` and prints nothing by
default, which is why suppressing the in-terminal line and reading the data are the same act.
`windowFromBanner` and `contextLimitFor`'s observed-usage inference are kept as **fallbacks**
for CLI versions that emit no payload — and for a remote SSH session, which gets no wrapper
and no payload at all: its `claude` runs on the far machine, so `statusKey` is `''`
(`pty.ts:185,190`; `statusLine.ts:557-563`) and the banner is its only channel, exactly as
before the payload existed. A banner that does say `(1M context)` still works, and escape
codes must still be stripped before matching, because the banner is styled.

Two things that cost time if you forget them. First, **a second `--settings` silently
discards the first**, so the statusLine key and the `ultracode` key have to arrive in one
file. Second, **the payload file is named after the launch key, not necessarily the CLI's own
session id** — `pty.ts` computes `statusKey = opts.host ? '' : sessionId || randomUUID()`.
For every session Stoke mints an id for, the two are the same string; a `--continue` session's
id is chosen by the CLI *after* launch, so it gets a fresh random key instead, and still gets
a wrapper and a payload — verified against a real session whose payload file was named
`78fe5553-…` while the payload's own `session_id` field read `840cbab5-…`. The payload states
its own id precisely so a reader keyed on the launch key can still recover the real one; code
that assumes the file name *is* the session id will not find a `--continue` session's data.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - Those lines have moved. `const statusKey = opts.host ? '' : sessionId || randomUUID()` is now src/main/pty.ts:213, and `const settingsFile = opts.host ? null : sessionSettings(statusKey)` is now pty.ts:218. Line 185 now holds the 'That folder is not there any more' error and line 190 is a comment.
> - The remote-session explanation, `windowFor`'s doc comment (the 'a remote session, which has no key and no payload at all' bullet), is now src/main/statusLine.ts:848-860, with the function itself at :861-862. Lines 557-563 now fall in `readSessionEvents`' return and `parseHookEvent`'s doc comment.

> **Checked against the code on 2026-09-30** — "prints nothing by default" was the cause of the
> blank row under the input box, and it no longer does: with no pass-through the wrapper prints
> `EMPTY_STATUS_LINE`, one SGR reset. Suppressing the line and reading the data are still one
> act; suppressing it with an empty stdout was the wrong way to do it. Gotcha 118.

> **Checked against the code on 2026-10-03: a compaction left the transcript readers at the old size.**
> The owner compacted, and the status bar read right while the sidebar's row said almost full. The
> row (`listSessions`) and any tab without a payload (an SSH tab) read the transcript, and the fold
> took the last assistant turn's usage as the occupancy. A compaction writes no turn. It writes a
> `system` record, `subtype: 'compact_boundary'`, whose `compactMetadata` states `preTokens` and
> `postTokens` (measured on this session: 967,156 → 23,072). So until the next reply the row showed 97%.
> The fold now takes `postTokens` as the occupancy at the boundary; all 17 compactions on this Mac
> state it, and one that does not keeps the old reading. The fold also keeps `peakTokens`, the most the
> session has held on its current model (`preTokens` included, reset only when the model id moves
> between two `claude-` ids), and `sessionLimit` judges the window by it. Judged by 23k alone, a
> compacted 1M chat read as 200k. `verify:folders` holds both. Each mutated out turned it red: the
> boundary branch 2 checks, the peak 4, the model reset 1.

## 26. A `--continue` session has no context ring, and it is the missing *id* that causes it

**A `--continue` session has no context ring, and it is the missing *id* that causes it.** This
is a real limitation of 0.4.0, not a bug waiting somewhere. `pty.ts:165-166` reads
`opts.resume || opts.continueLast ? (opts.sessionId ?? '') : (opts.sessionId ?? randomUUID())`,
and a `--continue` has nothing to pass, because the CLI picks the id itself after launch — so
the id is `''`. `index.ts` hands that straight to `watcher?.watch(result.sessionId)`, and
`ContextWatcher.watch` early-returns on a falsy id (`context.ts:102-103`), so no transcript is
ever polled and the tab's ring stays blank for the whole life of the session. Closing the gap is
not a one-liner: the real id does exist, but only inside the payload the wrapper writes under
the *launch* key (gotcha 2), and `src/shared/ipc.ts` has no channel for a session id that
arrives late — `pty:start`'s return value is the only place the renderer is ever told one, and
it has already returned. The plan-limit chip is unaffected, because `refreshLastStatusLine()`
reads every live `statusKey` directly and a payload's rate limits are account-wide anyway.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - That expression is now src/main/pty.ts:193-194.
> - The early return (`if (!sessionId || this.watches.has(sessionId)) return`) is now src/main/context.ts:112-113. Lines 102-103 are now `snapshot()`.
> - `session:event` (CH.sessionEvent, added in 2c43c3a on 2026-09-02, after this entry was written) now reaches the renderer with the real id. `pollSessionEvents` reads every `ptys.statusKeys()`, which includes a `--continue`'s random launch key (src/main/index.ts:1556-1561), and `parseHookEvent` sets `sessionId` from the payload's real `session_id` (src/main/statusLine.ts:597). The event carries no launch key or ptyId, though, and the tab stores `sessionId: res.sessionId` (`''`, App.tsx:972), so App.tsx:511's `t.sessionId === ev.sessionId` can never match it to the tab. What is missing is a way to match the id to the tab, not a channel.

> **Checked against the code on 2026-09-19 — closed.** The match is by ptyId now, from the CLI's own
> session registry (gotcha 80): `RegistryPoller` reads `<config dir>/sessions/<pid>.json` for the pty,
> `rebindTo('', entry)` names the real id, and `rebindSession` (index.ts) watches it and pushes
> `session:rebind { ptyId, sessionId }`, which moves the tab. Driven against the built app: a
> `--continue` tab launched as `claude --continue` in a throwaway folder came up with `sessionId: ''`
> in `tabs.json`, and within two seconds held `194346ac-…` (the registry's id), with its ring reading
> `68k/200k · 34%` and the relaunch pill offered — both refused for that tab before.

## 49. `ContextWatcher` published only when the *transcript* mtime moved, so a window that became known afterwards never reached the meter

**`ContextWatcher` published only when the *transcript* mtime moved, so a window that became
known afterwards never reached the meter.** On a **resumed** session the payload naming it was
deleted with the old process (`kill` → `clearSessionFiles`), and the new one writes its first
a second or two later, when it renders a status line. The first tick therefore lands with no
stated window, `contextLimitFor` falls back to `WINDOW_STANDARD`, and — the transcript not
moving, nobody having typed anything yet — nothing ever recomputed it.

Measured end to end: a 1M session resumed at 125k read **`125k/200k · 63%`** indefinitely while
its own payload sat on disk saying `context_window_size: 1000000`. After the fix the same
resume reads `125k/1.00M · 13%` and holds it across a relaunch, checked at 8s, 16s and 26s.

The fix is to make the stated window a second trigger rather than only an argument: `Watch`
carries `lastWindow`, and a tick publishes when *either* it or the mtime changed. `undefined`
is distinct from `null` there on purpose — "never published" versus "published, no window
stated" — or the very first tick of a session with no payload would compare equal to itself
and be skipped.

**This predates the relaunch button and is not caused by it.** The paused-tab Resume walks the
identical path, so any restored 1M tab has been reading 200k since restore existed. The button
only made it easy to hit on demand, which is how it was finally seen.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - Not load-bearing in the current code. `lastMtime` starts at 0 (src/main/context.ts:117; `refresh()` and the catch also reset it to 0, :142, :223), and the publish test is `st.mtimeMs !== w.lastMtime || window !== w.lastWindow` (:198). So the mtime half fires on the first tick whatever `lastWindow` starts as, and initialising it to `null` would skip nothing. The `Watch` comment at context.ts:27-30 repeats the claim.

## 61. Windows has TWO shells for a `statusLine`/hook command, and they want opposite syntax

**Windows has TWO shells for a `statusLine`/hook command, and they want opposite syntax.**
Claude Code's own resolver is `cs() ? "bash" : "powershell"` where `cs()` is "not Windows, or
Git Bash was located" — read out of the 2.1.x bundle, along with `de()`, which searches
`CLAUDE_CODE_GIT_BASH_PATH` (accepted only if its basename is `bash.exe`/`sh.exe`/`bash`/`sh`
and the file exists, otherwise ignored with a warning), then `C:\Program Files\Git\bin\bash.exe`,
then `C:\Program Files (x86)\Git\bin\bash.exe`, then `dirname(which git)/../../bin/bash.exe`.
So **Git Bash is the preferred interpreter and PowerShell is the fallback**, and the CLI's own
help text agrees: "the command is executed through Git Bash". Stoke sets no `shell` field on
either entry, so that default governs.

PowerShell parses a line beginning with a quoted string as a string EXPRESSION, so
`"C:\...\run.cmd" "key"` is a ParserError and needs the call operator `&`. A POSIX shell —
which Git Bash is — treats a **leading `&` as a syntax error outright**: `bash -c '& echo hi'`
gives ``syntax error near unexpected token `&'``, and so do sh and zsh. There is no single
string that satisfies both, so the interpreter is detected (`gitBashPath` in `statusLine.ts`,
which mirrors `de()` exactly and takes `env`/`exists` as arguments so it can be asserted from
a Mac).

0.5.4 added the `&` unconditionally under a comment asserting it was "harmless in the Git Bash
branch, where `&` is only meaningful when it *ends* a command". That is false, and it inverted
the bug: the fix for machines without Git for Windows broke every machine with it. On those
the shim never ran — no payload (no context ring, nothing for the plan-limit chip), none of the
three hooks, and the user's own configured statusLine gone too, since the wrapper that re-runs
it as pass-through is what failed to start. **`verify:statusline` was asserting the `&` on
win32 unconditionally**, repeating the same false claim in its own comment — gotcha 10's defect
a second time, a suite pinning a bug as correct.

> **Checked on a real Windows runner on 2026-09-30** (windows-latest, Actions run 36670816756):
> both syntaxes run as claimed. Git Bash runs `"…\run.cmd" "<key>"` and pwsh 7 and Windows
> PowerShell 5.1 run `& "…\run.cmd" "<key>"`, the payload reaching the wrapper on stdin and the
> hook events landing, driven the way 2.1.285's executor runs them. Still read from the bundle rather
> than a live `claude` on Windows. On Windows the status-line command now ends in the shell's name,
> `"bash"` or `"powershell"`, for the wrapper's pass-through (gotcha 123).

## 64. The context meter counted three of the four usage fields

**The context meter counted three of the four usage fields.** `contextUsed` summed
`input + cache_read + cache_creation` — the prompt the model was GIVEN — and dropped
`output_tokens`, which is in the conversation the instant the turn ends, i.e. exactly the
steady state someone reads the ring in. Measured across the four largest real transcripts here,
2,486 consecutive turn pairs: the next prompt grew by at least the previous output in 2,482 of
them, the rest at cache boundaries. It errs the safe way now — verify-context's own comment
names understating context pressure as "the one direction this codebase treats as dangerous".

## 73. A status key is not unique per launch, so "delete this session's files" is ambiguous during a relaunch

**`relaunchTab` fires `pty.kill` without awaiting it and starts the replacement immediately, so the
outgoing PTY is still dying while the incoming one writes — and both use the SAME status key.** The
key comes from the session id (`pty.ts`: `statusKey = opts.host ? '' : sessionId || randomUUID()`,
and a `--resume` carries the original id), so the two launches name the same three files. The
outgoing PTY's `proc.onExit` fires when the child actually dies, not when it was asked to, and it
used to call `clearSessionFiles(statusKey)` unconditionally. When it lost the race it deleted the
INCOMING session's `<key>.settings.json`, and `claude` refused to start:

```
Error: Settings file not found: /var/folders/.../T/stoke/statusline/<id>.settings.json
```

The relaunch pill finishes, the tab comes back dead, and the user resumes by hand.

**This was in CLAUDE.md's standing traps for months as harmless and unexplained** — "gone missing
twice, unexplained and not reproduced; the payload `.json` beside them survived... it is harmless
(the CLI reads `--settings` once at startup)". Every part of that reading was wrong in an
instructive way:

- **"Not reproduced"** because the reproduction is a sequence, not a state. Nothing is wrong with
  any single call; the bug is entirely in which of two calls lands last, and that depends on how
  long `claude` takes to die. `scripts/verify-statusline.mts` reproduces it 100% of the time by
  simply making the four calls in the order `relaunchTab` makes them.
- **"The payload survived"** is the strongest clue in the whole note and it was read as evidence
  AGAINST a deletion. It is evidence for one: `clearSessionFiles` removes all four files, but the
  incoming session's wrapper rewrites the payload roughly three times a second, so it reappears
  within the tick. `.settings.json` and `.cmd` are written once at launch and never again — so
  exactly the two files that cannot heal themselves are the two that stay missing.
- **"The boot sweep and the CLI were ruled out"** was half right, and the half that was wrong is
  gotcha 74. The CLI is innocent. The sweep was acquitted by running it *against a copy* — which
  tested `sweepStaleSessionFiles()` on the real clock, the one call that is genuinely safe, and
  never tested the one the SUITE makes with a 2033 clock against the real shared directory. That
  one empties it. Both mechanisms are real and they are not alternatives: the race breaks a
  relaunch for one session, the suite quietly wipes every session on the machine.
- **"Harmless, the CLI reads `--settings` once at startup"** inverted the risk. Reading it once at
  startup is precisely what makes it fatal: the one moment the file must exist is the moment the
  replacement is starting, which is the moment the outgoing handler is firing.

**The fix is ownership, not ordering.** `claimSessionFiles(statusKey, ptyId)` is called immediately
before the files are written — the `ptyId` is minted early purely so it can be the claim — and
`releaseSessionFiles(statusKey, ptyId)` refuses to delete a key some newer launch has since claimed.
An unclaimed key still clears, so every teardown path that has no successor to worry about is
unchanged. Do not try to fix this by awaiting the kill or sleeping before the start: the exit is
delivered by the OS whenever the child dies, and there is no duration that is correct for every
machine.

The general shape, which is gotcha 20 seen from the other end: **claiming before the first await
protects you from a second caller arriving; it does nothing about a FIRST caller arriving late.**
Any resource named after something stable (a session id, a project path, a host alias) rather than
per-launch needs an owner, or a dying predecessor will clean up its successor.

> **Checked on 2026-09-19.** `relaunchTab` now awaits the old process's exit (`pty:stop`,
> `PtyManager.stop`, capped at 3s) before starting the replacement, to close the ~0.9s in which two
> `claude` processes held one transcript. That does NOT retire ownership: the cap means a replacement
> can still start beside a predecessor that will not die, which is exactly the late exit
> `releaseSessionFiles` exists for. Keep both.

> **Checked on 2026-09-13, after the fix.** An adversarial pass that was asked to refute this could
> not refute the mechanism, but it did refute the ATTRIBUTION: the original note recorded "the
> installed app's sessionS", plural, in one event, and a late `proc.onExit` can only ever touch the
> one key being relaunched. A directory-wide deleter was needed to explain that, and there is one —
> gotcha 74. Ownership does not help there: `sweepStaleSessionFiles` goes straight to `rmSync`
> without consulting `fileOwners`, by design, since its whole job is files whose owner is gone.

## 80. A tab's session id moves while its process runs, and only the CLI's own registry says so

**Stoke learned a tab's session id once, from `pty:start`, and never again — but the id is not fixed
for the life of the process.** Measured against 2.1.278 on 2026-09-19: `/clear` mints a NEW id, the
in-TUI `/resume` switches to another, `/compact` keeps it, and a `--continue` has none until after
launch. A live tab here had been launched with `--session-id 6b80feb4…`, and its process, its
statusLine payload and every hook event all said `39db23cb…`, while `tabs.json` still stored
`6b80feb4`. So the relaunch pill, Resume, tab restore and the sidebar's "already open" de-dupe all
named the conversation the process had left: `claude --resume <old id>` reopened the pre-`/clear`
conversation, or — when the old id never got a transcript — exited 1 with `No conversation found
with session ID: …`. Hook events and payloads carry the new id, so after a drift they matched no tab
either; gotcha 26 was the `--continue` special case of the same thing.

**The CLI already writes the answer: `<CLAUDE_CONFIG_DIR or ~/.claude>/sessions/<pid>.json`.** It is
undocumented, so `parseRegistry` (src/shared/claudeRegistry.ts) treats every field as optional and a
reading that does not parse as none. It holds the CURRENT `sessionId`, `status` (`busy`, `shell`,
`idle`, `waiting` — the binary's own four, `waitingFor` beside `waiting`), `version` and `cwd`.
Measured transitions: a prompt goes `busy` within ~0.1s; Esc goes `idle` with no `Stop` hook at all;
a permission dialog is `waiting`; `/clear` goes busy on the OLD id, then names the new id ~0.05s
later, then idle; `--resume <id>` names that id from its first write (no transient id, so no
debounce); the file appears 1.3-2.5s after the spawn, the `status` key ~0.5s after that, and SIGHUP
removes the file ~0.37s later. The pid in the name is the pty child's on macOS — `claude` itself, or
a shim that `exec`s it (the test shim did, and matched).

`RegistryPoller` (src/main/sessionRegistry.ts) reads it once a second for every live local Claude
pty and nothing else (an SSH tab has no local file; another CLI writes none), async and one pass at a
time (gotchas 40, 20). A changed id is a rebind: `PtyManager.rebind`, the context watcher moves,
`sessionCwds` gains the new id and keeps the old, and `session:rebind` moves the tab and the
session-keyed maps that describe the PROCESS (version line, activity) — not `contexts`, which
describes the conversation left behind. Driven against the built app: a prompt, then `/clear`, took
the tab from `afccf3e1…` to `60481cbf…` in `tabs.json`, matching the registry file.

Three things that are easy to get wrong:

- **The statusLine files do not move.** They are named after the launch and owned by it (gotcha 73),
  so after a rebind the session id and the file name differ, and `readStatusLine(sessionId)` finds
  nothing: no payload, so no version for the pill and no stated window for the meter. Every reader
  holding an id goes through `payloadKeyFor` → `PtyManager.statusKeyFor`.
- **A registry id becomes a `--resume` argument**, and a `.cmd` install runs through `cmd.exe /c`
  (gotcha 13), so `isSafeRegistryId` whitelists it exactly as `SAFE_ID` does for ssh.
- **Matching by anything but the pid is a fallback for a layout this machine cannot produce** — a
  Windows `.cmd` install, whose pty pid is cmd.exe's. `pickEntry` then takes the ONE entry holding the
  id Stoke already has, else the ONE unclaimed entry in the same folder that started after the spawn,
  and refuses ambiguity either way. Unverified on Windows.

> **Checked on 2026-09-30** — both fallbacks have now run on Windows runners under a stub `.cmd`
> launcher: the id key on x64 and arm64, descent on x64 only (the CIM table outlasts its deadline on
> windows-11-arm). Gotcha 92's note has the runs and numbers. A real npm `claude.cmd` is still unproven.

## 92. A dying tab was rebound to a stranger's `claude` in the same folder, and its Resume minted a blank session

**The registry's folder fallback took a foreign process for a tab whose own file had just gone.**
Found by the phone QA (2026-09-19): after `/exit` on a pty holding `cd7a7f25…` (21 messages, titled
"Apple"), the ended row and the desktop tab both carried `98de4ade…`, an id with no transcript, and
the row lost its title. Another Stoke was running `claude` in the SAME folder at the time. The
mechanism, reproduced against the old `RegistryPoller` in a hermetic replay: SIGHUP removes a
process's `<pid>.json` ~0.37s before the pty exits; for that pass the target is not pid-matched and
is older than `REGISTRY_FALLBACK_AFTER_MS`, so it fell to `pickEntry`'s fallbacks, and "the one
unclaimed entry in the same folder that started after the spawn" is exactly a terminal `claude` or
a second Stoke in the same repo. The rebind then followed the tab everywhere (tabs.json, the phone
row).

Then the phone's "Resume conversation" sent `resume: true` with that id, got a 200, and main's
`resumeOrMint` — right for a desktop relaunch of a tab nobody typed into — quietly turned
`--resume` into `--session-id` and started an empty conversation.

Three locks:

- **`everMatched`** (sessionRegistry.ts): a pty whose own file was ever read never falls back. Its
  file going away means dying, never "look elsewhere". Only a pty never matched by pid (a Windows
  `.cmd` install, whose pty pid is cmd.exe's) may use the fallbacks at all.
- **Descent** (`pickEntry`'s `descends`, `descendsFrom` over `readProcessTable`): the folder
  fallback takes only a process under the pty's own pid, and answers nothing with no process
  table. Same folder is not identity. The Windows table (CIM) is UNVERIFIED.
- **`resumeVerdict`** (remotePhone.ts): `POST /api/sessions` with `resume: true` is a 404 for a
  Claude id with no transcript and a 400 with no valid id, before anything spawns. A Resume must
  never silently become a new conversation.

> **Checked on real Windows runners on 2026-09-30** (ci.yml `probe`, `scripts/probe-e2e.mts`, a
> PACKAGED Stoke with a stub `claude` behind a `.cmd` launcher, so the pty is cmd.exe's and no
> registry file carries its pid). This note first said run 36701034597 proved the descent fallback
> and the CIM table on Windows. **It proved neither.** The stub wrote the id Stoke launched it with,
> and `pickEntry` tries that id BEFORE descent, so the tab matched on the second key and the table
> was never consulted; and `RegistryPoller.processTable()` turns every failure into null, so a CIM
> query that failed outright would have left that check just as green. A check of a fallback proves
> it only when every earlier key is unable to answer. What the probe shows now (run 36707295344):
> - **The id key works** on windows-latest (x64) and windows-11-arm: the `--session-id` tab is named.
> - **Descent works on windows-latest.** A `stoke <folder> --continue` tab holds `''`, so nothing but
>   descent can name it: rebound 5.5 s after the request (4 s of `REGISTRY_FALLBACK_AFTER_MS`); the
>   CIM query took 485 ms (471-774 ms in three timings over two runs), chain
>   `node.exe <- cmd.exe <- Stoke.exe`. With the table forced to null on x64 (scratch run
>   36706319439) exactly those three checks went red.
> - **Descent FAILS on windows-11-arm.** The same query took 27.3 s there (23.6-28.2 s in three
>   timings over two runs; `-Property ProcessId,ParentProcessId` 23 s, powershell.exe's bare start
>   0.2 s), so the 5 s deadline always wins, the table is null, and a `--continue` tab is never
>   named: no rebind, no ring (gotcha 26's symptom). Measured on the runner only; a real
>   Windows-on-ARM machine is not.
>   Raising the deadline is not the fix: a pass awaits the table while holding `running`, so every
>   tab's state would freeze for as long as the query runs. A table fetched outside the pass, or the
>   processes attached to the pty's own console (upstream node-pty kills with such a list; not
>   checked in `@lydell/node-pty`'s Windows build, which this Mac does not install), might be —
>   neither is done.
> - **The table was read once a second for a `.cmd` tab's whole life.** Such a pty is never
>   pid-matched, so it fell back on every pass, and every pass that fell back read the table — a
>   PowerShell start and a CIM query — although the id already named the tab. `needsDescent`
>   (`pass`) now asks only for a fallback its id cannot answer: a `--continue` on `''`, or a
>   `/clear` to an id Stoke does not hold yet. `verify:registry` counts the asks (0 for an id-matched
>   tab; the old poller asked on every pass). The CPU this cost was not measured.
>
> Still unproven: a real `claude.cmd` (npm) install, and descent on any Windows-on-ARM machine.

## 103. A whole-transcript parse is one block of the main process, and two pollers ran it on every change

**`parseSession` folded a whole transcript in one synchronous block, and two callers ran it over
and over.** The fold costs 2.2-3.2 ms per MB on an Apple M1, and while it runs nothing else in main
does: no pty byte reaches the renderer (`send(CH.ptyData)`) and no keystroke reaches the pty, so a
Claude terminal visibly froze. `ContextWatcher` re-ran it in full on every 1.5 s tick whose
transcript mtime had moved, for every open Claude tab — several times a minute in a busy session.
`listSessions` ran it over EVERY transcript of the project under an unbounded `Promise.all`, with
no cache, and the renderer re-fetches that list on every window focus while the browsed project
has a live session.

Measured on 2026-09-21, 1 ms `setInterval` gap probe, min / median / max of 7 runs (the machine
was loaded: 1.5 s of idle showed gaps up to 96 ms, so the watcher was driven with `refresh()` to
keep its window short, and an idle window of the same length recorded beside each):

| what | before | after |
| --- | --- | --- |
| watcher tick after a ~3 KB append, 21.6 MB transcript | 42 ms median, 70 max | 1.6 ms, 2.0 max |
| same, 16.5 MB | 48 ms median, 132 max | 1.6 ms, 1.8 max |
| watcher first pass, 21.6 MB | 38 / 40 / 57 ms | 2.6 / 2.9 / 5.4 ms (wall 50 ms) |
| watcher first pass, 38.1 MB | 2 ms, sampled: **87 messages** | 3.6 / 4.6 / 5.5 ms, **2,154 messages** |
| `listSessions`, stoke project (24 files, 119 MB), cold | 43 / 45 / 62 ms, 300 ms wall, RSS +272 MB | 4.6 / 5.4 / 6.4 ms, 243 ms wall, +112 MB |
| same, warm | 41 / 43 / 58 ms, 278 ms wall | 1.2 / 1.6 / 2.0 ms, 1 ms wall |
| same, warm after an append to the 16.5 MB one | as above | 3.4-3.9 ms, 45 ms wall |

A gap includes the 1 ms interval itself (idle windows read 1.2 ms). The fix, in the order it bites:

- **One rule.** The per-line fold is exported as `createFold`/`foldLine`/`foldLines`/`finishFold`,
  and `parseSession`, the watcher and both suites use it. Two copies of the loop would be two
  answers for one transcript.
- **Stream, and cut bytes at a newline before decoding.** `foldFrom` reads 1 MB at a time with
  `FileHandle.read` (a Readable's async iterator can hand over a buffered chunk without the loop
  running), carries the partial last line as BYTES, and decodes only up to the last 0x0A. A read
  can end inside a multi-byte UTF-8 character and 0x0A never occurs inside one; decoding first
  turns the split character into U+FFFD for good.
- **One fold per event-loop turn, process-wide** (`foldTurn`). Yielding between one pass's chunks
  was not enough: eight concurrent `listSessions` passes whose reads completed in the same poll
  phase ran their folds back to back, 21-31 ms. Each chunk over 64 KB now waits for the previous
  fold plus a `setImmediate`, which from inside the check phase runs on the next iteration.
- **The watcher follows the file.** Each `Watch` holds a `TranscriptCursor` (`file`, `dev`, `ino`,
  `offset`, `fold`) — per watch, never a module cache — and `advanceCursor` reads only
  `[offset, size)`. It starts over on a new path, a new dev/inode, a size below the offset, or a
  byte before the offset that is no longer `\n`. A line is folded only once its newline has
  arrived; `parseSession` still folds an unterminated last record as `split` did, and every one of
  the 76 transcripts on this machine ends in `\n`, so the two agree on any settled file.
  `refresh()` during a tick sets `again` instead of starting a second one (gotcha 20): two ticks
  would fold one append twice and leave two timer chains (measured 36 ticks in 450 ms, not 10).
- **An SSH copy is read whole every time.** `fetchRemoteTranscript` writes the remote file's last
  4 MB (`MAX_REMOTE_TRANSCRIPT_BYTES`) in place: once the remote outgrows that the window SLIDES,
  same inode, same size, and — with equal-length records — every newline where it was. No cursor
  check can see that, so a `volatile` source is never given one. `verify:folders` builds exactly
  that file.
- **No 32 MB sampling in the watcher**, deliberately. Sampling bounded a whole-file read's time and
  memory, which a streamed pass bounds by itself, and it cost the status bar and the auto-scan an
  exact message count (87 for a transcript holding 2,154, dropping the moment a file crossed
  32 MB) and could miss the newest usage record. `parseSession` keeps it, so `listSessions` is
  unchanged and re-listing the 38 MB active transcript costs 2 ms, not a 100 ms stream.
- **`listSessions` caches per transcript** on path + mtime + size (`SessionListCache`), the parse
  claimed as a promise before any await so overlapping lists share it, pruned per directory,
  capped at 2000, 8 at a time (`mapLimit`, now shared with `sessionIndex.ts`).

Known floors: one record is parsed in one go, and the largest line here is 1.36 MB (~5 ms). An
in-place rewrite that grows the file and happens to leave `\n` before the offset is invisible to
the cursor; Claude Code only appends, and the one source that rewrites never keeps a cursor.
`npm run check` sees none of this — every value was already right; only the blocks were wrong —
so it is held by `verify:folders` (incremental == one pass at 46 cut points, a split 4-byte
character, the three resets, the watcher end to end, re-parse counts) and `verify:context` (the
same cut-point check on the three largest real transcripts).

> **Checked against the code on 2026-09-21** — review of the change above, two follow-ups.
> - **The exact count invalidated every auto-scan baseline an earlier build saved.** Those were
>   taken against the sampled count (87 for the 2,154-message transcript), so after upgrading the
>   first quiet tick read 2,067 messages of new work and started one automatic, PAID worklog scan
>   nobody asked for. Each `StoredActivity` now carries `countVersion` (`MESSAGE_COUNT_VERSION`,
>   `worklog/autoscan.ts`; a record without one reads as `UNVERSIONED_COUNT`, `autoscanStore.ts`),
>   and `observe` re-takes a baseline at any other version on first sight, keeping its `lastScanAt`
>   and `mutedUntil`: work done just before the upgrade's restart goes unlogged, the same trade a
>   never-seen session gets. The version is per record, not per file, because `snapshot` writes a
>   restored-but-never-observed record back as it came in. Bump `MESSAGE_COUNT_VERSION` whenever
>   what `messageCount` counts changes again. `verify:worklog-autoscan` holds it ("a baseline an
>   earlier build counted another way is re-taken, never scanned", from a file written as that
>   build wrote it).
> - **`verify:context`'s cut-point loops never returned on a small transcript**: `while (cuts.size
>   < 6)` over fewer than six newlines, and `< 9` over a file under ~10 bytes, so `npm run check`
>   hung on a fresh machine. `pickCuts` bounds both by what the file holds and by attempts, prints
>   a NOTE/SKIP when a file offers fewer, and is asserted on those shapes directly.

## 118. Claude Code lays its footer out by whether a status line is CONFIGURED, so an empty one is a blank row

**"Hide Claude's status line in Stoke" left a blank row between the input box and the footer, and
the cause was the wrapper printing nothing.** Measured 2026-09-30 against Claude Code 2.1.285,
driving the built app over CDP and reading the xterm buffer (`window.stokeTerminals`, gotcha 5),
149x38 terminal, the session started in a scratch folder with no prompt typed, in both auto and
manual permission modes. Rows between the input box's bottom border and the footer's last row
(inline, a transient `◐ medium · /effort` notice added a row to baseline and hidden alike):

| renderer | no statusLine at all (baseline) | hidden, before | hidden, after | pass-through (the user's own line) |
| --- | --- | --- | --- | --- |
| fullscreen (this machine's default) | 1, the footer | **2: one blank, then the footer** | 1, the footer | 2: their line, then the footer |
| inline (`CLAUDE_CODE_NO_FLICKER=0`) | 1, the footer | 1, the footer | 1, the footer | 2: their line, then the footer |

Read out of the 2.1.285 bundle, which the table agrees with: the status line element is `text ?
<line/> : fullscreen ? <Text> </Text> : null`, and it is mounted whenever
`settings.statusLine` resolves to anything. So in the fullscreen renderer an empty stdout is a
deliberately reserved one-space row; in the inline one it is nothing. The CLI reads stdout as
`trim()`, then every line trimmed and dropped if empty — whitespace, never escapes. A line holding
only an SGR reset is therefore TEXT to it, and a Text with no visible character lays out at zero
height. `EMPTY_STATUS_LINE` (`'\x1b[0m'`) is what the wrapper prints now whenever there is no
pass-through file, and both renderers match the baseline row for row. The payload is written
exactly as before — the fix changes stdout only (gotcha 2 still stands).

What no output can restore, and why this is the least-bad answer rather than the stock layout:

- **"? for shortcuts" is gone whenever any statusLine is configured** — the footer receives
  `suppressHint: suppressHint || statusLineConfigured`, which also drops the loading hints
  ("esc to interrupt"). Baseline in manual mode: `⏸ manual mode on · ? for shortcuts · ← 1 agent`;
  hidden: `⏸ manual mode on · ← 1 agent`, same row. Printing the hint from the wrapper does not
  bring it back into that row: the status line is its own row ABOVE the footer, so it adds one.
  The payload carries no permission mode either (`permission_mode` is left undefined in 2.1.285),
  so the wrapper could not know when the stock would show the hint.
- **Dropping the statusLine entry when hidden** would give the exact stock footer and lose the only
  exact context-window source (gotcha 2), the fresher plan-limit reading and `cliVersion`. No.
- **The first frame still has the row.** Until the wrapper's first answer lands (~0.5 s after the
  TUI appears, Electron-as-node starting up) the CLI draws its placeholder, then the box drops one
  row into place. Polled at startup: border at row 35 with a blank below it at 2.2-2.4 s, row 36
  from 2.7 s on. The CLI keeps the last text per session in memory, so it is once per launch.

With suppression off, a pass-through that fails or prints nothing still prints NOTHING rather than
the empty line: a bare `claude` whose own command fails keeps the blank row too, and the promise
there is "exactly what your own line does". `verify:statusline` holds both, plus the CLI's own
trimming (`cliText`) applied to the wrapper's real output. The measurement matrix, scripts and
screenshots were under `/tmp/stoke-proof/statusline-gap/`; the baseline was a throwaway local
change to the BUILT bundle adding `disableAllHooks: true` to the `--settings` file — never the
user's `~/.claude/settings.json`, which here configures a statusLine of its own — because that
key makes the CLI resolve `statusLine` to undefined (`Vh()` → policy settings only) while every
other user setting (permission mode, theme) still applies. Unverified: Windows (both shells run
the same node wrapper, so the bytes are identical, but nothing was driven there) and any CLI
other than 2.1.285 — if a later one draws the reset as a row, the result is the old blank row,
never visible text.

> **Checked against the code on 2026-10-02.** The setting itself reached only sessions started after
> it. The owner turned it on, the session in front of them kept their own line, and they asked
> whether it was being done right. The pass-through `.cmd` was written once at launch and never
> again, and the help text's "applies to sessions started after it" was folded away inside a
> FieldHint. Now `applyPassthroughToLive` (called from index.ts when `hideStatusLine` moves) writes
> or removes the `.cmd` of every key a live launch here has claimed (`fileOwners`, never a scan of
> the shared directory). Each wrapper re-reads that file about three times a second, so a running
> session follows within a second. verify:statusline holds it: a live key and a bystander's file,
> and a re-show with a different line, so a no-op cannot pass. Mutated back, 2 checks go red.

## 123. On Windows the user's own status line was re-run in cmd.exe, which the CLI never uses, and a hung one outlived its kill

**With "Hide Claude's status line" off, the wrapper re-runs the user's own `statusLine.command`,
and on Windows it ran it through `cmd.exe /c`.** Claude Code runs statusLine and hook commands
through Git Bash when it finds one and PowerShell when not (gotcha 61). Read again out of the 2.1.285
bundle: one executor, `eU`, serves both, the status line as its event `"StatusLine"`, and with no
`shell` field `RB()` is `Ta() ? "bash" : "powershell"`. So a line written for the shell the CLI
really uses — `~/.claude/statusline.sh`, `$HOME`, `$env:`, `& "…"` — came back blank or wrong once
Stoke wrapped it. Worse, node quotes an argv element holding `"` as `\"`, which cmd.exe cannot read,
so ANY line that began with a quoted path printed nothing. The suite's own flood control failed on
exactly that on the first windows-latest run (Actions run 36670816756).

The wrapper cannot see which shell started it. Stoke's command already commits to one — `&` or not
(gotcha 61) — so on Windows it now names it as a third word, `"bash"` or `"powershell"`
(`statusLineCommand`), and `passthrough()` in the generated wrapper runs the line the way the CLI's
executor does: `bash -c` with bash's own folder first on PATH (`H_n`) and a `.sh` first word run as
`bash <line>` (`O_n`); or `pwsh`/`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass
-Command`, PowerShell found in `mH`'s order, with `${CLAUDE_PROJECT_DIR}` rewritten to `${env:…}`
(`ELo`). The word is sound whenever the wrapper runs at all: the syntax before it parses in no other
shell, so a wrong guess never starts the wrapper. A command with no word — a session an older Stoke
launched, still running against the shared `wrapper.mjs` — keeps cmd.exe, now handed its line
verbatim (`/d /s /c "…"` with `windowsVerbatimArguments`, as node's own `shell: true` does it).
POSIX is unchanged: `/bin/sh -c`, no word.

**A line that hangs held the CLI's render for as long as its child lived, not the 2s the wrapper
promises.** Windows children inherit EVERY inheritable handle, the wrapper's own stdout — the pipe
back to the CLI — among them. `execFileSync`'s timeout killed the shell, and its child (a `ping`, a
`sleep`, a stuck network call) kept the CLI's pipe open until it finished: over 10s against the 2s
timeout on the runner. `runContained` replaces `execFileSync` on every OS, with the same 2s and 256KB
rules, and on Windows kills the whole tree with `taskkill /T /F`. Off Windows a child inherits only
the three descriptors it is given, so killing the shell already released everything.

Measured on windows-latest (run 36672038877), the whole chain — shell, run.cmd, the wrapper, the
line's own shell — for a line written in each shell's syntax: Git Bash 154ms, pwsh 7 671ms, Windows
PowerShell 5.1 618ms, all inside the 2s budget; the hang and the 256KB flood both contained. Run
36670816756 was the first time the shim ran under any real Windows shell: Git Bash runs the no-`&`
form, pwsh 7 and Windows PowerShell 5.1 run the `&` form, stdin reaches the wrapper, and the payload
and hook events land. Still unproven: a real `claude` on Windows driving it.

How it was found is the rule for next time: **run a command the way the thing that runs it does.**
`verify:statusline` ran the shim through `cmd.exe /c` too. It died there on the `\"` quoting before
asking anything, so the `&` split gotcha 61 turns on had never run on Windows at all. It now runs
every shell present (Git Bash, pwsh 7, Windows PowerShell 5.1 on the runner; a GitHub runner missing
one fails) with the syntax Stoke writes for each, and a line in each shell's own syntax through the
pass-through.
