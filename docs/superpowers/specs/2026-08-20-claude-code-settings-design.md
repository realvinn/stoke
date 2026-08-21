# Claude Code settings inside Stoke — design

*2026-08-20. Covers three asks: Remote Control turning itself on, the plan-limit chip needing a
live session, and a Claude Code settings section in Stoke's own Settings sheet.*

Stoke wraps the real `claude` CLI, so it already lives next to that CLI's configuration without
ever having read or written it. This adds a narrow, deliberate window onto it.

## 1. Remote Control was never a Stoke bug

Claude Code 2.1.237 decides Remote Control once at REPL bootstrap, in a resolver whose fallback
is a **server-side GrowthBook flag**, `tengu_cobalt_harbor`, which is `true` for this account:

```js
function RGo(){ if(vX())return{value:!1,source:"remote_env"};
                if(nPt())return{value:!0,source:"persistent_remote_session"};
                let e=tXs("remote_control_at_startup");
                if(e!==void 0)return{value:e,source:"org_policy"};
                return{value:nt("tengu_cobalt_harbor",!1),source:"growthbook"} }
```

Three things made it feel broken rather than merely default-on:

- **`/remote-control` → "Disconnect this session" does not persist.** Its handler (`kpE`) is a
  pure in-memory state reducer with no settings write, so every launch started fresh.
- **The disclosure banner has a 3-impression cap** (`cSr="remote-control-auto-on", qWh=3`), and
  this account is at 3. Reaching the cap silences the banner, not the feature — so it began
  turning on with no notice at all.
- **The one keystroke that does persist an off** (`d` in the RC dialog) is gated on
  `replBridgeExplicit`, which is `false` precisely for an auto-on session. The user who most
  needs to persist an off is the one who cannot. Worth filing upstream.

The flag's *value* cannot be overridden locally — the env-override path is dead code
(`getEnvironmentOverrides()` has an unconditional `return` before it reads
`CLAUDE_INTERNAL_FC_OVERRIDES`) and there is no `CLAUDE_CODE_DISABLE_REMOTE_CONTROL`. But the
flag is never consulted when a local setting exists, because the resolver guards on
`n.value===void 0`. So:

**Fix: `"remoteControlAtStartup": false` in `~/.claude/settings.json`.** Applied. `--rc` and
`/remote-control` still work on demand. `disableRemoteControl: true` is the bigger hammer and
also hides the command.

Only `policySettings > flagSettings > userSettings` may *enable* it; a repo-scoped `true` is
explicitly ignored. A repo-scoped `false` does work. Note the asymmetry: a checked-in
`.claude/settings.json` carrying `disableRemoteControl: true` silently kills Remote Control for
anyone who opens that repo.

## 2. The plan-limit chip no longer needs a live session

`readOauthToken` read `~/.claude/.credentials.json` and nothing else. **That file does not exist
on macOS** — the credential is a login-Keychain generic password under the service name
`Claude Code-credentials`. So `fetchUsage` reported "Not signed in to Claude Code" on every
call, the account route contributed nothing, and the statusLine payload — which exists only
while `claude` is running — was the chip's only source.

`readCredentials` now falls back to `security find-generic-password -s "Claude Code-credentials"
-w` on darwin. `STOKE_LIVE_USAGE=1 npm run verify:usage` passes here against the real account
with nothing else running.

**The blob is not just the account, and that is a trap.** It is `{ mcpOAuth, claudeAiOauth }`,
where `mcpOAuth` holds one record per connected MCP server — around fifty here — each with its
own `accessToken`, several non-empty. `mcpOAuth` is enumerated **before** `claudeAiOauth`, so the
old first-match-wins scan returned a *connector's* token, which the endpoint answers 401 to —
indistinguishable from being signed out, on the one platform where signed-out was already the
expected outcome. The search is two passes now: an `sk-ant-oat`-prefixed value anywhere wins, and
only if nothing carries the prefix does the lenient key-name match run, with `mcpOAuth` skipped.

Two bounds: `security` blocks on a GUI Keychain prompt where the item's ACL does not already
trust it, so the call carries a 5s timeout; and the token expires, so an expired one is reported
as expired rather than discovered as a 401. Stoke never refreshes it — rotating the token would
invalidate the copy the CLI holds.

The per-tab context ring is inherently per-session and is unaffected.

## 3. The Claude Code settings panel

### Scope: tier 1

One new panel in the existing Settings sheet, editing a **curated allowlist** of keys in
`~/.claude/settings.json`, plus `workflowSizeGuideline` in `~/.claude.json`. No plugin, skill or
MCP management in this pass.

Every control is **tri-state** — on / off / *unset* — because "absent" is a distinct and
meaningful state in this schema, not a synonym for false. `remoteControlAtStartup` is the proof:
unset means "let the rollout decide", which is exactly what went wrong.

### Keys offered

From `~/.claude/settings.json`, vocabularies read out of the binary's own zod schema:

| key | kind | note |
|---|---|---|
| `remoteControlAtStartup` | bool | the fix above |
| `disableRemoteControl` | bool | also hides `/remote-control` |
| `disableWorkflows` | bool | also `CLAUDE_CODE_DISABLE_WORKFLOWS` |
| `workflowKeywordTriggerEnabled` | bool | the "ultracode" keyword trigger |
| `effortLevel` | `low\|medium\|high\|xhigh` | **not `max`** — see below |
| `editorMode` | `normal\|vim` | |
| `autoUpdatesChannel` | `latest\|stable\|rc` | |
| `cleanupPeriodDays` | int ≥ 1 | transcript retention |
| `disableBundledSkills` | bool | |
| `enableAllProjectMcpServers` | bool | auto-approves project MCP |
| `alwaysThinkingEnabled` | bool | |
| `autoCompactEnabled` | bool | |
| `verbose` | bool | |
| `includeCoAuthoredBy` | bool | deprecated upstream in favour of `attribution` |

**`effortLevel` refuses `max` deliberately.** The schema is
`Hr(["low","medium","high","xhigh"]).optional().catch(void 0)` — `.catch(void 0)` means an
out-of-range value is *silently dropped*, so writing `"max"` yields no effort level at all even
though `--effort max` is valid everywhere else. The picker must not offer it.

### Keys deliberately excluded

- **`statusLine` and `ultracode`.** Stoke passes `--settings`, which is `flagSettings` —
  precedence is `userSettings < projectSettings < localSettings < flagSettings < policySettings`,
  so Stoke's own file **outranks** anything this panel writes. Offering these two would draw a
  control that silently does nothing. Any key later added to Stoke's session settings file must
  be removed from this panel at the same time.
- **The 11 shell-executing keys** — `apiKeyHelper`, `proxyAuthHelper`, `awsCredentialExport`,
  `awsAuthRefresh`, `gcpAuthRefresh`, `otelHeadersHelper`, `processWrapper`, `policyHelpers`,
  `fileSuggestion`, `statusLine`, `subagentStatusLine`.
- **Permissions, `sandbox.*`, and anything managed-settings-only.** A GUI that can write
  `permissions.defaultMode: "bypassPermissions"` or `hasTrustDialogAccepted` is a GUI that can
  silently grant trust.

### `workflowSizeGuideline` goes to `~/.claude.json`

It is dual-homed, and the two homes are not equivalent:

```js
function aur(){ return iz()?.settings.workflowSizeGuideline!==void 0 }   // hides the /config row
function D2t(e){ let t=SGn(iz()?.settings.workflowSizeGuideline)??SGn(e)
                 return t===void 0?{size:LRf,isDefault:!0}:{size:t,isDefault:!1} }  // LRf="medium"
```

Writing it to `settings.json` **hides the `/config` → "Dynamic workflow size" row entirely**,
taking the control away from the CLI. So Stoke writes the global config instead, matching
`/config` exactly — at the cost of having to implement the lock protocol properly.

Vocabulary `unrestricted | small | medium | large`, plus *unset*. `small` aims for fewer than 5
agents, `medium` fewer than 15, `large` fewer than 50. Read live: the Workflow tool's own prompt
calls `ar().workflowSizeGuideline` per use, so a change lands at the next prompt with no restart.

### The `~/.claude.json` write protocol

Reverse-engineered from the bundled `proper-lockfile` v4 and confirmed empirically, including a
three-way concurrency hammer test. **The critical question — does a live session serialise its
cached object and clobber an external edit? — answers no:** every CLI writer re-reads from disk
inside its critical section and applies a reducer to the disk value. A key written externally
survived a live session's full exit payload.

But an external write *can* still be lost, and the window was measured: it is
`[the CLI's readFile completes → its rename completes]`, entirely inside its lock hold. Taking
the lock is therefore sufficient against the CLI's locked path — and insufficient overall,
because of paths that ignore the lock:

1. **`retries: 0`.** The CLI never waits. `ELOCKED` sends it straight to an unlocked,
   un-backed-up read-modify-write. Stoke holding the lock is what *forces* it down that path.
2. **Exit handlers write synchronously with no lock at all.**

Hence lock **and** verify-after-settle **and** retry. The steps:

0. Resolve the path as `W9y()` does: `<CLAUDE_CONFIG_DIR||~/.claude>/.config.json` wins if it
   exists; else `join(CLAUDE_CONFIG_DIR||homedir(), '.claude' + suffix + '.json')`.
1. Acquire by `mkdir(cfg + '.lock')` — a **directory**, which is the whole mutual-exclusion
   primitive. Poll ~25ms, give up after ~2s and proceed anyway. Break a directory older than
   10s with `rmdir`; **unlink a stale non-directory**, because proper-lockfile never creates a
   file there and a stale one wedges the CLI's locking permanently.
2. Keep it fresh with `utimes` every 4s; never hold longer than ~1s.
3. Read inside the lock, strip a leading `U+FEFF`, parse strictly.
4. **Abort — do not write —** on parse failure, on a non-object, or if
   `oauthAccount === undefined && hasCompletedOnboarding !== true`. Writing over a failed parse is
   exactly how this file gets wiped, and dropping the auth keys freezes CLI persistence entirely.
5. Mutate the one key. Never touch `userID`, `machineID`, or `projects[*].history`.
6. Write atomically: sibling temp `<cfg>.tmp.<pid>.<12hex>`, `O_EXCL`, preserve the existing
   mode, **fsync before rename**, close, rename. **Retry the rename on `EPERM`/`EBUSY`/`EEXIST`**
   — the CLI's own retry predicate is stubbed to `false`, so it does not, and on Windows a
   failure there sends it down a non-atomic in-place path.
7. Release in `finally`, plus a `before-quit` sweep.
8. Verify after ≥1500ms (past the CLI's 1000ms `fs.watchFile` poll), and retry from step 1 up to
   four times.

**Corruption is catastrophic and has no auto-recovery.** A parse failure makes the CLI back the
file up and then reset to defaults — measured at 16 keys → 5, destroying `userID`, `machineID`,
`oauthAccount` and every project entry. Step 4 exists for that reason alone.

One cosmetic consequence to know: the CLI strips any key whose value equals its own default
before writing (lodash `pickBy`), so an explicitly-written value may later vanish. It does not
matter here — an absent `workflowSizeGuideline` means `medium`, which is what an explicit
`medium` meant too — and the panel always re-reads, so it never shows a stale claim.

### Files

Three new main-process modules, kept small and each with one job:

- `src/main/claudePaths.ts` — path resolution only. Takes `env` and `home` as arguments (the
  `workspaceRoots.ts` shape) so a suite can ask about another machine's layout.
- `src/main/claudeSettings.ts` — `~/.claude/settings.json`: read, and patch preserving unknown keys.
- `src/main/claudeGlobalConfig.ts` — `~/.claude.json`: the lock protocol above.

Plus `src/shared/claudeConfig.ts` for the key catalogue — pure, no node imports (a `node:` import
in `src/shared/**` fails the *web* half of typecheck, gotcha 27), shared by the renderer, the main
process and the suite.

Then the standard panel wiring: `src/shared/ipc.ts`, `src/shared/api.ts`,
`src/main/index.ts` (a new banner in `registerIpc()`), `src/preload/index.ts`,
`src/renderer/src/components/ClaudeCodeSettings.tsx`, mounted in `SettingsSheet.tsx`.

**Name collision to fix in the same change:** `UpdatesSettings` already renders a "Claude Code"
heading. It becomes "Claude Code CLI", so two blocks in one flat sheet do not share a title.

### Round-trip safety

Never re-serialise through a typed model. Unknown keys must survive verbatim, and
`enabledPlugins` values are a union of `boolean | string[] | <extended object>` — flattening one
would silently change plugin resolution. Read, patch one key, write.

The panel **names** the CLI version it was transcribed against rather than gating on it. The
design first said the enum controls should degrade to read-only on an unrecognised version; that
is wrong in practice, because the CLI auto-updates — the panel would be read-only within days of
every release and useful almost never. A warning line that lets a reader judge an odd-looking
control is the honest trade.

### Verification

`scripts/verify-claude-config.mts`, in the `check` chain:

- path resolution across platforms and `CLAUDE_CONFIG_DIR`, including the `.config.json` override
- patching preserves unknown keys, and unset removes rather than writing `null`
- the abort guards: bad parse, non-object, missing auth
- the lock: acquire, a stale *directory* is broken, a stale *file* is unlinked, a fresh one is not
- enum validation refuses `effortLevel: "max"`

## What was verified by driving the real app

Not `npm run check` — none of this is reachable from a pure suite (gotcha 31). The built app was
launched with `--remote-debugging-port` and `CLAUDE_CONFIG_DIR` pointed at a scratch tree, so
every read and write exercised the real IPC and the real files without touching the user's own:

- the panel renders, 15 rows, reading the seeded config correctly
- a select change writes `settings.json` and **every unknown key survives verbatim** —
  `statusLine`, `enabledPlugins`, `theme`, and an invented future key
- the workflow-size change takes the lock, lands in `~/.claude.json`, leaves `oauthAccount` and
  `projects` intact, and leaves **no lock directory and no temp file** behind
- the Escape-unmount flush: `7` typed into the transcript-retention box and Escape pressed
  immediately reached disk, which is the path that has no blur event
- no horizontal overflow at any level — `document.scrollWidth - innerWidth` is 0

Two defects were found this way and only this way, both invisible in the CSS:

1. **The selects clipped their own values.** `default — let Claude Code decide` rendered as
   `default — let Claude C`; a `<select>` cannot ellipsis its closed value. What "default" means
   moved into the hint, and the options became one word each.
2. **A hint ran off the right edge of the sheet.** `white-space: nowrap` on the trailing
   "default: …" span, in a column with `min-width: 0` and nothing left to give — gotcha 14 again,
   one level down.

Widths were also ragged (each select sized to its content, right-aligned), so they are one fixed
`9rem` column now.

## What is still unverified

- **Windows.** None of this research ran there. `%USERPROFILE%\.claude`, the credential store in
  place of the Keychain, and `cmd.exe` quoting are all unexercised.
- **A Stoke write reaching a live PTY**, and what the CLI's `ConfigChange` hook does when it
  fires on an external edit — it can run arbitrary shell.
- **The panel rendered at the 940px minimum** with both side panels open (gotcha 14).
