# PLAN — 0.3.2

Current: **0.3.1**, tagged `3393c4d`. Five commits sit unreleased on `main`.

## What is already in, unreleased

These ship in 0.3.2 whatever else is decided. They are done and pushed; none has been
exercised through an installed build.

| commit | change |
|---|---|
| `779ac9d` | Window is draggable; Windows draws its own buttons |
| `ca9b724` | Limits moved from the sidebar to the title bar, numbers first |
| `ae212dc` | The phone says which machine it is driving — phase 2 of `PLAN-MULTI-MACHINE.md` |

`fbe326e` and `eafb26b` are plan documents only and change no behaviour.

## Scope

The shape of this release is **close the loose ends, verify the frame-and-title-bar work
against a real install, and leave the structure alone.** Multi-terminal is deliberately
not here; see the bottom.

Status: items 2 and 3 are built and uncommitted (`npm run typecheck` passes, exit 0, both
tsconfigs). Items 1, 4 and 5 are blocked on decisions only the user can make — see
**Blocked** below.

### 1. First-run setup, tested for real

The oldest debt in the project. 0.3.0 and 0.3.1 were both upgrades over an existing
`%APPDATA%\Stoke`, so the first-run path has **never executed**. Every setting it is
supposed to create was already on disk.

Move `%APPDATA%\Stoke` aside, launch the installed build, and walk the setup as a new
user would. Restore afterwards.

Watch for: settings written before the directory exists, a token generated twice or not
at all, the tunnel prompting for something a first-time user cannot answer yet, and the
profile list derived from folders that do not exist on a clean machine (`e8fda2c` made
profiles folder-derived, which a first run has none of).

### 2. `sttUrl` in desktop Settings — BUILT

Landed in `RemoteSettings.tsx`, not `SettingsSheet.tsx`: `sttUrl` lives inside the
`settings.remote` sub-object beside `hostname` and `port`, and `SettingsSheet` only
patches top-level keys. Copies the Public hostname field's idiom; empty falls back to the
default the way the Port field falls back to 7878.

Two things the work surfaced, both left alone deliberately:

- **The field is inert until the remote server restarts.** `CH.settingsSet` never calls
  `remote.start`; only token regeneration does. Every neighbouring remote field behaves
  the same way, so this matches the neighbours rather than inventing a restart. The field
  hint says so.
- **There is now no in-app way to disable voice.** The old doc comment on
  `types.ts:223` claimed an empty `sttUrl` hides the microphone button. It never did —
  `voiceSupported()` (`src/remote/voice.ts:22-29`) gates the button on browser capability
  alone, so empty instead fails at press time with a 503 from `/api/transcribe`. The
  comment has been corrected to describe reality. Making empty genuinely mean "voice off"
  is a small follow-up, not this release.

### 3. The site's shortcut row — BUILT

The row was not merely un-scrollable-looking, it was **truncated**: eight keys came to
495.7px of content in a 390px viewport, so `ctrl-r` sat entirely off-screen and
`shift-tab` was clipped. `.keys` sets `overflow-x: auto` but suppresses the scrollbar on
both engines, and mobile overlay scrollbars only appear once already scrolling — so the
row read as a complete set that happened to end at the screen edge. Worse, `enter` and
`shift-tab`, the two keys a Claude Code user presses most, sat at and past the fold.

Added `←` `\x1b[D`, `→` `\x1b[C`, `ctrl-l` `\x0c`, `ctrl-d` `\x04`, and reordered by tap
frequency. Overflow is now signalled by gradient fades on a `.key-row` wrapper, driven by
a `markOverflow()` that sets `data-more` on scroll, on a `ResizeObserver`, and on first
frame. Touch targets went from ~30px to a 38px minimum, which matters with `ctrl-c`
sitting beside `enter`.

Two placement decisions were reversed under review, and the reasoning is worth keeping:

- **"`ctrl-d` last so it costs a scroll" does not work.** The row keeps its scroll
  position, so after one legitimate scroll to reach `ctrl-r` the key sits permanently
  under the thumb, styled like the harmless ones. The cost is paid once, not per tap, and
  the composer sends text+CR so the prompt is empty essentially always — a mistap is an
  unconditional session kill. It is now arm-then-fire: first tap arms and relabels, second
  fires, three-second self-disarm.
- **`esc` must not sit beside `enter`.** They are reject and accept on a permission
  prompt, the highest-traffic pair here, so adjacency means one mistap inverts the answer.
  The arrows now separate them, with both still above the fold.

## Found under review, not fixed

`RemoteSettings.tsx:29` polls remote status every 4 seconds and re-renders the whole
component. A poll landing inside the async `patchSettings` round trip rewrites a
controlled input with a stale value and parks the caret. This is pre-existing and shared
with the `hostname` field (`:111`) — the speech-server box only inherits it. It is a real
typing hazard in Settings and wants a local-draft pattern, but fixing it properly touches
every field in the sheet, so it is not this release.

## Blocked on the user

- **First-run test (item 1)** needs `%APPDATA%\Stoke` moved aside. That directory holds
  `remote.token` and the tunnel config. Reversible rename, but it disrupts the running
  app and must not happen without a go-ahead.
- **Title bar verification (item 4)** needs a 0.3.2 build and a restart of Stoke.
- **Nothing here has been exercised on a real phone.** The shortcut row was measured in a
  browser harness at 390px, not on a device. Specifically unconfirmed: whether the fade
  reads as "scroll me", whether the first-frame measure fires after layout on iOS Safari,
  whether `overscroll-behavior-x: contain` actually suppresses the iOS back-swipe, and
  whether the 8px-taller row still clears the soft keyboard and home indicator.

### 4. Verify the title bar and window frame against the install

`779ac9d` and `ca9b724` are the first changes to touch the window frame. `779ac9d`
hands the buttons to Windows, which is exactly the class of change that behaves
differently packaged than it does in dev. Check drag regions, the buttons, and that the
usage numbers still render in the title bar at the installed window's real width.

### 5. Re-run the suites against 0.3.2

```bash
npm run typecheck
npm run verify:usage
npm run verify:security http://127.0.0.1:7878 <token> --access
```

`--access` is not optional against an installed build: `requireAccessHeader` is on, and
without the header all 16 checks fail identically for a reason unrelated to what they
test. Token is in `%APPDATA%\Stoke\settings.json` under `remote.token`.

## Not in 0.3.2

- **Multi-terminal and per-terminal browser views.** Designed in `PLAN-OVERNIGHT.md`,
  still unbuilt. It is a structural change to how terminals are owned and rendered.
- **The Cloudflare Worker router** (`/u/0`, `/u/1`). Phases 3 and 4 of
  `PLAN-MULTI-MACHINE.md`. That document's own recommendation is to build it when the
  bookmark sprawl irritates, not before.
- **macOS.** No Mac code path has ever run. Needs a Mac, not a plan.
- **The git tree showing features.** Recorded as a wish, still a wish.

## The honest recommendation

Ship 0.3.2 small. Three window-and-title-bar commits are already unreleased and have not
met an installer; adding multi-terminal on top means a release where a regression could
come from either, and this project's bugs do not announce themselves — they produce
plausible wrong output. Get the frame changes verified against a real install, close the
three loose ends, tag it, and start multi-terminal against a known-good 0.3.2.

If multi-terminal should be in this release instead, it becomes the release and items
1-3 come along as incidental. That is a fine choice, but it is a different plan and the
verification burden roughly doubles.

## Standing traps

Unchanged from `PLAN-OVERNIGHT.md`, repeated because they keep costing time:

- **Verify by running.** Every bug in this project has produced plausible wrong output
  rather than an error. A passing typecheck has caught none of them.
- **Do not force-kill Stoke.** It orphans the CLI children and the restarted app cannot
  reattach. Two separate confusions last session came from this.
- Installed Stoke holds a single-instance lock; dev runs need `--user-data-dir`.
- PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM that silently breaks
  `settings.json`. Write JSON with Node.
- Electron ESM: `app.whenReady().then(main)`, never top-level await.
- The usage endpoint is undocumented. Report unavailable rather than guess.
- One named tunnel and one hostname per machine. Never copy `settings.json` between them.
