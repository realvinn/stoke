---
paths:
  - "src/main/usage.ts"
  - "src/main/statusLine.ts"
  - "src/shared/statusLine.ts"
  - "src/shared/usageView.ts"
  - "src/renderer/src/components/UsageMeter.tsx"
  - "scripts/verify-usage.mts"
  - "scripts/verify-statusline.mts"
  - "src/shared/usageSources.ts"
  - "src/shared/codexUsage.ts"
  - "src/shared/openRouterUsage.ts"
  - "src/shared/clineUsage.ts"
  - "src/shared/kimiUsage.ts"
  - "src/main/codexUsage.ts"
  - "src/main/usageBoard.ts"
  - "src/main/usageVendors.ts"
---

# Plan-limit usage chip

The plan-limit chip: the payload's rate limits, the account endpoint, token choice, backoff, and
which reading wins. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of
each. Numbers are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 21. A statusLine payload's `rate_limits` has real gaps a naive reader gets wrong

**A statusLine payload's `rate_limits` has real gaps a naive reader gets wrong.** It is
absent at session mount and only starts appearing from the first render *after* an API
response completes — a brand-new session legitimately has none, and that absence must never
be drawn as "0% used." `used_percentage` is 0–100 but unrounded and carries float noise —
`7.000000000000001` is a real value the CLI sent, not a bug in Stoke — so round it before
display. `resets_at` is Unix epoch **seconds**, unlike every other timestamp in Stoke;
`statusLine.ts`'s `reading()` is the one place that converts it to ms. `five_hour` and
`seven_day` are independently optional, and the whole `rate_limits` key is omitted when
neither is present — check each window separately, not as a pair. It also appears to
populate only under Claude.ai subscription (OAuth) auth; under an API key it appears never
to arrive (inferred from the CLI's own bundle, not observed — API-key auth was not tested).
One more field worth knowing while you're in this payload: `model.id` carries the tier
suffix in full (`"claude-opus-5[1m]"`), unlike the transcript's bare `model` field (gotcha
2) — though nothing in Stoke actually reads it for window resolution; `windowFor` takes the
number straight from `context_window.context_window_size` instead
(`statusLine.ts:296,568-569`). `modelId`'s only two readers today are the type declaration
and a test assertion (`src/shared/types.ts:236`, `scripts/verify-statusline.mts:93`).

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - `contextWindowSize: windowSize(cw?.context_window_size)` in `toSnapshot` is now src/main/statusLine.ts:460, and `windowFor` is now :861-862. Line 296 is now inside `hookCommand`.
> - No longer true. src/renderer/src/components/StatusBar.tsx:186 displays it (`const model = line?.modelId ?? context?.model ?? (tab.model || null)`), and src/renderer/src/App.tsx:569,578 caches it per session from `statusLine.onUpdate`. The declaration is now src/shared/types.ts:248 (line 236 is now `export interface StatusLineSnapshot {`), and the assertion is now scripts/verify-statusline.mts:111. It is still not used to resolve the window.

## 36. The plan-limit chip needed a running session only because of where macOS keeps the token, and the Keychain blob has a trap in it

**The plan-limit chip needed a running session only because of where macOS keeps the token,
and the Keychain blob has a trap in it.** `readOauthToken` read `~/.claude/.credentials.json`
and nothing else. That file does not exist on macOS — the credential is a login-Keychain
generic password under the service name `Claude Code-credentials` — so `fetchUsage` reported
"Not signed in to Claude Code" on every call, the account route contributed nothing, and the
statusLine payload was the chip's only source. The payload exists only while `claude` is
running, so closing the last tab took the numbers with it, exactly as the panel's own note
admitted. `readCredentials` (`usage.ts`) now falls back to
`security find-generic-password -s "Claude Code-credentials" -w` on darwin, and
`STOKE_LIVE_USAGE=1 npm run verify:usage` passes here against the real account with nothing
else running.

**The blob is not just the account, and first-match-wins picks the wrong token.** It is
`{ mcpOAuth, claudeAiOauth }`, where `mcpOAuth` holds one record per connected MCP server —
around fifty here — each with its own `accessToken`, several non-empty (a Figma `figu_…`).
`mcpOAuth` is enumerated **before** `claudeAiOauth`, and the old scan returned the first key
matching `/access.?token/i`, so it handed back a *connector's* token. `api.anthropic.com`
answers that with 401, which renders identically to being signed out — on the one platform
where signed-out was already the expected outcome, so it would never have looked like a bug.
The search is two passes now: an `sk-ant-oat`-prefixed value anywhere wins, and only if
nothing carries the prefix does the lenient key-name match run, with `mcpOAuth` skipped.
Pinned by `verify:usage` against the real blob's shape.

**A macOS machine can hold BOTH stores, and they disagree — so "the file does not exist on
macOS" above is no longer true and must not be relied on.** Measured 2026-09-02:
`~/.claude/.credentials.json` existed with a token that had expired 24 hours earlier, while
the login Keychain held one good for another 8. `readCredentials` read the file first and
returned it, so `fetchUsage` short-circuited on `expiresAt <= now` and answered *"Claude Code
sign-in has expired"* **without ever making the request** — for as long as the app stayed
open. The chip therefore fell back to the statusLine payload, which exists only while `claude`
runs, which is exactly the symptom this whole entry was written to remove: a chip that dies
with the last session.

The trap is not the stale file, it is preferring by LOCATION. That was only ever safe while
one of the two could not exist. `freshestCredentials` compares expiry instead — an unexpired
token wins wherever it lives, a token with no stated expiry counts as usable, and with nothing
live the least stale still comes back so the message can name a time. The Keychain is still
not read when the file already holds a live token, so the ordinary case costs one read.

**A poll that faithfully re-fetches an error is indistinguishable from a poll that is not
running**, and that is why this read as "the usage chip will not refresh". The 30s poll
(`POLL_MS` in UsageMeter, matched by `USAGE_POLL_MS`'s cache floor in main) was working
perfectly the whole time. Check what a poll RETURNS before concluding it is not firing.

**"The chip never works" was two more faults on top of all of the above, and neither was
the endpoint.** Measured 2026-09-02, with the account route answering 200 (5h 17%, week
61%, Fable 100%) and the live session's payload holding the same figures on disk, while
the panel read *"Usage unavailable (429)"*.

First, **a failed read replaced the good one.** `fetchUsage`'s failure snapshot carries an
empty `windows`, the handler assigned it straight over the cache, and `UsageMeter` read
`!snap.error ? snap.windows : []` — so the error was allowed to veto data already in hand.
"We cannot refresh this right now" and "we know nothing" are different statements and only
the first is ever true here. `keepLastGood` keeps the previous windows *and their own*
`fetchedAt`, because that timestamp belongs to the data: "as of 18:02" stays true and the
existing staleness marking starts working for free.

Second, **the fifteen-minute backoff was Stoke's invention, not Anthropic's.** The app took
a 429 at 18:08 and sat out until 18:23; a direct call with the same token answered **200 at
18:16**. So it declined to look for ~7 minutes of a limit that had already lifted, having
thrown its numbers away to do it — and a few of those a day is exactly "it never works".
`nextBackoff` honours `Retry-After` exactly when sent, and otherwise starts at 60s and
doubles to a 15-minute ceiling. There is nothing better to pace against: the endpoint sends
**no rate-limit headers at all** on a success (checked — only `anthropic-organization-id`
and `anthropic-workspace-id`), so the budget can only be discovered by hitting it.

**A third fault sits underneath both, and it is the one that survives them.** The payload
side chose its reading by `receivedAt` alone — in main (`pushStatusLine`, and again in
`refreshLastStatusLine`) and independently in the renderer's `take`. But **a payload states
no rate limits until the first render after an API response completes** (gotcha 21), so a
tab that was just opened writes the newest payload on the machine and states nothing —
and under newest-wins it EVICTED a live session's real figures. Reproduced through the real
`toSnapshot`: session A carrying `session:18%, weekly:61%` at t-10s against a one-second-old
session B carrying none selects B, and the chip gets `[]`.

That is the exact opposite of the intent written directly above the value: *"the rate limits
in it are account-wide, so any open session's payload answers for all of them"*. A payload
with no rate limits answers for nothing. It is sticky, too — the idle session's later pushes
carry its own older payload mtime, so it keeps losing the comparison and cannot win its
numbers back until its CLI happens to render a fresh status line.

`keepUsage` retains the two account-wide readings per window (`five_hour` and `seven_day`
are independently optional, so a newer payload stating only the first must not take the
second down with it) while everything genuinely per-session still follows the newer
snapshot. Its timestamp is that of the OLDEST reading being shown, so a borrowed window is
never advertised as fresher than it is — overstating a payload's freshness is gotcha 45.

Why this one hid behind the other two: with a healthy account the chip draws the account's
windows and the loss is invisible. It shows exactly when the payload is the only source —
during a backoff, with an expired token, offline, or before the first account read.

`retryUntil` is absolute rather than a duration precisely because those two came apart: with
`fetchedAt` now belonging to the data, `fetchedAt + retryAfter` names a time already past and
the panel silently stops saying anything. Both functions are pure and asserted in
`verify:usage`, because the handler that uses them needs Electron — gotcha 31 again, and the
reason the veto survived being written down as correct.

One more, met while testing the above: the endpoint rate-limits, answers **429** with a
`Retry-After` of 900s, and main honours it — so every read for fifteen minutes returns the
same cached failure with the same `fetchedAt`. Correct, and again indistinguishable from a
dead poll, so the panel names the time the pause ends and disables its own "Try again", which
could otherwise only hand back the same cached object.

Two smaller things. `security` **blocks on a GUI Keychain prompt** when the item's ACL does
not already trust it — it did not prompt here, but a fresh machine will — so the call carries
a 5s timeout rather than being allowed to hang a main-process handler. And the account token
**expires** (`claudeAiOauth.expiresAt`, epoch ms, refreshed whenever Claude Code runs); Stoke
reads it and never refreshes it, because rotating the token would invalidate the copy the CLI
is holding. An expired one is reported as expired before the request rather than discovered
as a 401.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - Only up to an hour. `nextBackoff` returns `Math.min(stated, BACKOFF_STATED_MAX_MS)` with `BACKOFF_STATED_MAX_MS = 60 * 60_000` (src/main/usage.ts:316,341), and verify-usage.mts asserts the cap ('a nonsense Retry-After cannot retire the chip for the whole run'). The cap came in the same commit as the fix (c2d052f), so the text left it out rather than drifting from it.

## 45. "The payload is fresher than the account" is true during a session and false after it, and believing it unconditionally is what froze the usage chip

**"The payload is fresher than the account" is true during a session and false after it, and
believing it unconditionally is what froze the usage chip.** `mergeUsageWindows` took the
statusLine payload's `percent`/`resetsAt` over the account endpoint's whenever both existed,
on the reasoning that a payload is seconds old where the account is a poll. That reasoning
has an unstated precondition: something has to still be *writing* the payload. Nothing
rewrites it once its session ends, and `lastStatusLine` in `index.ts` is deliberately kept
for the whole run so the chip does not blank when the last tab closes — so an hours-old
reading went on outranking a thirty-second-old account poll for as long as the app stayed
open. From outside, that is a chip whose numbers never move again however much of the plan
gets spent, with an "as of HH:MM" beside them that was also quoting the payload.

The merge compares the two timestamps now, ties going to the payload, and the panel's "read
from…" sentence follows the same comparison rather than assuming an answer. Neither half was
visible to a suite: `verify:statusline` and `verify:usage` both called the merge with two
arguments and asserted the payload won, which is exactly half the rule. Both suites now run
the same fixtures in both directions.

**The message boundary is `prompt_id`, not the file's mtime.** The chip refreshes the account
reading every 30s *or* whenever a new message starts, whichever is first, and the second half
needs a way to tell "a new message" from "the CLI redrew". The payload file is rewritten about
three times a second for the whole of a turn, so `receivedAt` moving means nothing;
`prompt_id` changes exactly once per user message. It is keyed per session in the renderer,
because two open sessions have unrelated prompt ids and alternating pushes would otherwise
read as a message every time. Main applies a 5s floor to a message-triggered read and 30s to
a polled one, and `retryAfter` outranks both — a 429 is not something a message boundary gets
to ignore. Verified against the running app: three reads inside the floor returned one
`fetchedAt`, and the 15-minute 429 backoff held for `message` reads too.

> **Checked against the code on 2026-09-30** — "account-wide" now means per ACCOUNT. With a second
> Claude sign-in (gotcha 127) two sets of rate limits exist, so main keeps one `lastStatusLines`
> entry per account (the pty's `accountIdForKey`, stamped on the payload as `accountId`), the
> renderer keeps one line per account, `keepUsage` never borrows across accounts, and
> `claudeWindowsFor` merges an account's endpoint reading only with that account's own payloads.
> Proven in the built app with a stub `claude` piping payloads per account: the Work tab's chip read
> the Work payload (77%), the Default tab's the Default one (3%), read moments apart. The floors and
> the backoff above hold per source and account (`UsageScheduler`, `USAGE_FLOORS`).

## 132. Every usage reading is one ACCOUNT's, in its vendor's own unit — and a Codex reading is its last turn's

**The plan-limit chip became a usage chip for every account, and each new source had its own way
to show a wrong number.** Written 2026-09-30 while adding them (`usageBoard.ts`,
`usageSources.ts`); every rule below is held by `verify:usage`, and the account guards, the
seconds conversion, the micro-dollar unit, the per-home token read and the rollout ordering were
each shown to fail it when broken.

**Keyed by account, everywhere.** A reading, its cache, its attempt time and its backoff are one
`<source>:<account>` key (`usageKey`): a 429 on one Claude sign-in pauses that one only, and one
account's last good figures are never kept in another's place. A Claude account's token is read
only from its own two stores — `<home>/.credentials.json` and the Keychain item named after that
exact home string (`credentialSources`, the sha256/NFC name of gotcha 127) — with the same
`mcpOAuth` skip and freshness rule as Default. A removed account or another agent's account id
routes to NOTHING (`usageRouteFor`), never to the Default account's figures, and a key account
has no readable usage at all.

**Codex: the newest rollout that STATES limits, and only the windows that have not reset since.**
Measured on this machine the day this was written: the newest rollout (today's) held no
`token_count` at all — a session opened with no finished turn — while the one before it did; and
the live run of `verify:usage` read `Weekly 4%` and no 5-hour window, because that turn's
`primary.resets_at` (epoch SECONDS) had passed two days earlier. Codex empties a window on its side
when it resets, so the old figure is false and the new one unknown (another client on the same
plan may have spent it): the window is dropped with a note, never drawn at its old percent and
never guessed as 0%. `codexResetMs` is the one seconds-to-ms conversion; `newestRollouts` orders by
mtime across the newest day folders, because `codex resume` appends to the day the session
STARTED; the tail read cuts bytes at a newline before decoding (gotcha 103). Codex also reports
model buckets (`limit_id`): the plan's own `codex` bucket wins over a newer model one.

**Each vendor in its own unit, read from its own shipped code, never a third party's.** Cline's
balance is MICRO-dollars (`normalizeCreditBalance` divides by 1,000,000; its test prints 500,000
as `$0.50`) — a community monitor that divided by 100 is exactly the wrong number. Kimi's
`expires_at` is epoch seconds and its `used_ratio` is 0–1. Codex credits are Codex's own unit and
are never shown as dollars. OpenRouter's key `label` holds part of the key and is never carried.

**Another app's token is read, never refreshed, and never sent anywhere else.** Cline's and
Kimi's tokens sit in plaintext in their own homes; Stoke reads them for one GET, as it reads
Claude Code's. An expired one is reported and NOT sent — Cline treats a token with no stated
expiry as expired (it would refresh), Kimi treats `expires_at: 0` as never expiring, and each is
mirrored. A Cline or Kimi pointed at another server (`baseUrl`, `CLINE_API_BASE_URL`,
`CLINE_ENVIRONMENT`, `KIMI_CODE_BASE_URL`/`*_OAUTH_HOST`) gets no reading rather than its token
sent to a server Stoke did not choose. `verify:usage` asserts the token file is byte-for-byte
unchanged after a read.

**Not verified live:** Cline's balance call (this machine's Cline token was expired, so none was
sent) and Kimi Code (not installed); both stand on the vendor's own code and fixtures. Cline
states no free-model or ClinePass allowance anywhere — its core learns of one only from an error's
text — so none is shown; OpenRouter's `free_model_daily_requests` is the one honest "free usage"
number. The Cline balance is the personal one; Cline's CLI shows an active organization's instead.
