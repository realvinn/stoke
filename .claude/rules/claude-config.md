---
paths:
  - "src/main/claudeGlobalConfig.ts"
  - "src/main/claudePaths.ts"
  - "src/main/claudeSettings.ts"
  - "src/main/statusLine.ts"
  - "src/shared/claudeConfig.ts"
  - "src/renderer/src/components/ClaudeCodeSettings.tsx"
  - "scripts/verify-claude-config.mts"
  - "src/shared/launch.ts"
  - "scripts/verify-launcher.mts"
---

# Writing Claude Code's own config

`~/.claude/settings.json` and `~/.claude.json`: what Stoke may write, where, and how without
losing the user's config. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index
of each. Numbers are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 37. Claude Code's Remote Control turns itself on from a server-side flag, and `/remote-control` cannot turn it off for good

**Claude Code's Remote Control turns itself on from a server-side flag, and `/remote-control`
cannot turn it off for good.** The resolver runs once at REPL bootstrap and, with no local
setting, falls through to the GrowthBook feature `tengu_cobalt_harbor` — `true` for this
account. `/remote-control` -> "Disconnect this session" is a **pure in-memory state reducer
with no settings write**, so it resets every launch. The one-time disclosure banner has a
three-impression cap (`cSr="remote-control-auto-on", qWh=3`), so once you have seen it three
times the feature starts silently. And the `d` key in the RC dialog, which *does* persist an
off, is gated on `replBridgeExplicit` — `false` for exactly the auto-on sessions that need it.

The flag's value cannot be overridden locally: the env-override path is dead code
(`getEnvironmentOverrides()` returns before it reads `CLAUDE_INTERNAL_FC_OVERRIDES`), the
config-override reader/writer are empty stubs, and there is no
`CLAUDE_CODE_DISABLE_REMOTE_CONTROL`. But the flag is never *consulted* when a local setting
exists. **`"remoteControlAtStartup": false` in `~/.claude/settings.json`** is the fix;
`disableRemoteControl: true` is the bigger hammer. Only policy/flag/user scope may *enable*
it — a repo-scoped `true` is ignored — but a repo-scoped `false` works, and so does a
checked-in `disableRemoteControl: true`, which silently kills RC for anyone who opens
that repo.

## 38. Writing Claude Code's own config: two files, two completely different risk profiles

**Writing Claude Code's own config: two files, two completely different risk profiles.**
`~/.claude/settings.json` is small and hand-owned — temp+rename is enough.
`~/.claude.json` is the global config, 155 KB here, rewritten constantly by every live
session, and **a parse failure makes the CLI back it up and reset to defaults** — measured at
16 keys down to 5, destroying `oauthAccount`, `userID` and every project entry, with no
automatic restore. `src/main/claudeGlobalConfig.ts` therefore refuses to write over a file it
could not parse, refuses one with no sign-in recorded (dropping the auth keys freezes the
CLI's own persistence via `GDe()`), and never creates the file.

**The lock is a directory, and taking it is necessary but not sufficient.** The CLI bundles
proper-lockfile v4: `mkdir <config>.lock`, stale at 10s by the directory's own mtime,
refreshed every 5s. A live session does *not* clobber an external edit with a cached object —
every writer re-reads from disk inside its critical section, verified by a sentinel surviving
a session's full exit payload. The loss window is narrower: `[the CLI's read completes -> its
rename completes]`, which sits inside its lock hold. But the CLI acquires with **`retries: 0`**
and falls straight through to an unlocked, un-backed-up write — so Stoke holding the lock is
what *forces* it onto the unguarded path — and its exit handlers take no lock at all. Hence
lock, hold briefly, **and verify the write survived, then retry**. All three.

Three smaller traps, each measured. A stale lock **file** is worse than a stale directory:
the CLI breaks stale locks with `rmdir`, which can never remove a file, so one left there
degrades every CLI config write permanently — Stoke unlinks it, which repairs the CLI rather
than just itself. The CLI's own rename retry predicate is **stubbed to `false`**, so it never
retries; on Windows an `EPERM`/`EBUSY` there sends it down a non-atomic in-place write.
And `<CLAUDE_CONFIG_DIR||~/.claude>/.config.json` **wins outright** over `~/.claude.json` when
it exists, so a writer that hardcodes the latter edits a file nothing reads.

## 39. `workflowSizeGuideline` is dual-homed and the two homes are not equivalent

**`workflowSizeGuideline` is dual-homed and the two homes are not equivalent.** It is a valid
`settings.json` key *and* a `~/.claude.json` key. `/config`'s "Dynamic workflow size" row
writes the global config — and `aur()` hides that row entirely whenever settings.json defines
the key (`iz()?.settings.workflowSizeGuideline !== void 0`). So putting it in the settings
file takes the control away from the CLI. Stoke writes the global config for that reason, and
pays for it with gotcha 38's whole protocol. Absent means `medium` (`LRf`), so unset and an
explicit medium behave identically.

While you are in that schema: **`effortLevel` accepts only `low|medium|high|xhigh`, not
`max`** — and it carries `.catch(void 0)`, like most of these enums, so writing `"max"` is
*silently dropped* and the session ends up with no effort level at all. `claude config` no
longer exists in 2.1.237 either; `claude config list` is parsed as a prompt and starts a
session. Editing the JSON is the only route.

One Stoke-specific rule that is easy to get backwards: **Stoke's own `--settings` file is
`flagSettings`**, and precedence is `userSettings < projectSettings < localSettings <
flagSettings < policySettings`. Anything Stoke folds into that file *outranks* what the
settings panel writes to `~/.claude/settings.json` — which is why `statusLine` and `ultracode`
are on `NEVER_OFFERED` in `src/shared/claudeConfig.ts`. Adding a key to
`writeSessionSettingsFile` means adding it there in the same change, or drawing a control
that visibly moves and changes nothing.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The session file's keys are built by `sessionSettingsJson` (src/main/statusLine.ts:640-660), which `writeSessionSettingsFile` (:671) calls. That function now also writes `hooks` (Stop/Notification/UserPromptSubmit, :656-657), and `hooks` is not on `NEVER_OFFERED` (src/shared/claudeConfig.ts:65-87). The comment at statusLine.ts:645-655 says hooks in a `--settings` file merge with the user's own instead of overriding them. So the rule now applies only to keys the file overrides (`statusLine`, `ultracode`), not to every key it carries.

## 66. A read-modify-write with an `await` in it needs a queue even when only Stoke writes

**A read-modify-write with an `await` in it needs a queue even when only Stoke writes.**
`patchClaudeSetting` reads `~/.claude/settings.json`, sets one key and renames; two overlapping
calls both read the pre-write file and the later rename discards the earlier key, while BOTH
callers are returned `ok: true`. Reproduced against a real temp file: patching `verbose` and
`autoCompactEnabled` through `Promise.all` left only `autoCompactEnabled`. Not exotic —
ClaudeCodeSettings disables only the row currently in flight, so a second control pressed
inside one IPC round trip is the ordinary case. A promise chain is enough here (unlike
`~/.claude.json`, whose lock exists to arbitrate with the CLI — gotcha 38).

The same shape reached three more places this round, all of them "a second press before the
first resolved": `resumeTabFor` and `restartTab` lacked the guard gotcha 51 gave `relaunchTab`,
and `Resume all` + `Close them` (adjacent buttons) dropped every tab while its resume was still
in flight, after which each `pty.start` found its `replaceTabId` gone and **appended** — the
tabs came back with live processes the close had never killed, because a paused tab has no PTY
to kill. And the manual "Update now" shared no lock with the six-hourly `refreshCliUpdate`, so
it could run a second `claude update` against the same install.

## 89. The effort Claude Code runs at is per model version, and the top-level key is only the fallback

**The launcher resolved "Default effort" from `~/.claude/settings.json`'s `effortLevel: "high"` and
said High, and the session banner said `Opus 5 (1M context) with medium effort`.** The same file
also held `modelSettings: { "claude-opus-5": { "effortLevel": "medium" } }` — the CLI's own
`/effort` writes there, keyed by the canonical model id, and that table OUTRANKS the top-level key
for its model. Confirmed in the CLI's settings schema (`modelSettings` … `effortLevel`, "Persisted
effort level for this model") and by the banner, on 2.1.278.

So `resolveLaunch` resolves effort as: a Stoke flag (or ultracode's xhigh), else the per-model
entry for the model THIS launch runs — which can be a chip override, so picking Sonnet for one
launch falls back to the top-level High, and the banner agreed (`Sonnet 5 with high effort`) —
else the top-level key. An alias (`opus[1m]`) is matched to entries of its family; when two
versions of that family disagree, Stoke cannot know which version the alias resolves to, so the
chip names no level rather than guessing.

The general form: a label that describes "what happens with no flag" has to resolve through every
layer the CLI reads, in the CLI's order — user < project < local file, `ANTHROPIC_MODEL` over the
files for the model, per-model over top-level for effort — or it is a second opinion, not a
reading. Managed (policy) settings are the one layer `readLaunchDefaults` does not read.
