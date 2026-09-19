---
paths:
  - "src/main/statusLine.ts"
  - "src/main/pty.ts"
  - "src/main/context.ts"
  - "src/main/sessionFile.ts"
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
