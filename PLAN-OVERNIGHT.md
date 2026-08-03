# PLAN — overnight build

The user is asleep. Decisions below are settled; do not re-ask them.

## Scope, in priority order

1. **Remote site input** — the complaints, all about `code.vinn.dev`:
   - You cannot click the terminal and type. The desktop wires `term.onData`
     (`TerminalView.tsx:87`); the remote never did. Wire it to the websocket.
   - Voice mode is unreachable because it only exists in the unreleased build,
     and it needs to be visibly a mode, not just a held button.
   - Wants shortcut buttons alongside it. A `.keys` row already exists
     (esc/tab/arrows/ctrl-c/enter/shift-tab/ctrl-r) - make it discoverable and
     add what is missing rather than duplicating it.
2. **Usage bars** — data layer is done and verified (`src/main/usage.ts`,
   `npm run verify:usage`). Remaining: IPC handler, poller, and a component
   beside `ContextMeter` in `StatusBar.tsx`. Three windows (5 hours, Weekly,
   Fable), each with percent, a countdown to `resets_at`, and the pace marker.
3. **Profiles** — see below.
4. **Test and security sweep** — subagents, every endpoint, every screen.
5. **Fix what the sweep finds**, including small visual defects (terminal not
   filling, chips invisible, etc).
6. **Build 0.3.0 and test the install**, then first-run setup.
7. **Multi-terminal** — only if 1-6 are genuinely solid.

## Profiles — settled

**A profile is a view filter, never access control.** Every profile can reach
every file and every project. The point is that sitting in a lecture the user
does not see chat history from unrelated work. From any profile it must remain
possible to open Claude's history or a directory and add a previous chat, or
start a new one anywhere.

| folder | profile | colour |
|---|---|---|
| `personal` | Personal | orange (unchanged, the existing accent) |
| `school` | Study | red + blue two-tone: red accent, blue secondary |
| `gitea-company` | Work | green |
| `gitea-vibe` | Vibe | violet |

The `group` field already exists on every project (`src/shared/types.ts:60-76`)
and is the parent folder basename, so profiles filter on it. `Sidebar.tsx:52-59`
currently demotes it deliberately; that comment needs updating, not ignoring.

## Multi-terminal — settled design

- Hovering near a terminal's edge reveals a FAB that **slides out of the edge**,
  visually part of the edge rather than floating over it.
- Pressing `+` opens a panel offering: **new chat in this folder**, **new temp
  chat**, or **a different folder / chat**.
- **Each terminal gets its own browser view**, not one shared browser.
- Two monitors is the motivating case.

## Other decisions

- **Git**: user said not to worry about it. Commit in focused pieces as work
  lands, push to `main`, matching previous sessions.
- **Install**: build **0.3.0** and genuinely test installing it, then first-run.
- **A git tree showing features** was mentioned as "would be cool" — a future
  feature request, not tonight's work. Recorded so it is not lost.

## Already done this session (verified, uncommitted)

- Extractor: `display: contents` pruning whole pages, tag-name-only outline,
  `section()` returning empty bodies on every page. See `PLAN-HARNESS2.md`.
- Voice: `src/remote/voice.ts` + `POST /api/transcribe` proxying to
  `lena-stt-server`. Verified end to end, 0.52s round trip.
- Terminal fit on the site: was defaulting to the desktop's fixed grid.
  Now 96-99% of the pane on phone and desktop.
- Usage data layer: `src/main/usage.ts`, `scripts/verify-usage.mts`, 16
  assertions plus a live call.

## Standing traps

- Verify by running, never by typechecking. Every bug in this project has
  produced plausible wrong output rather than an error.
- Installed Stoke holds a single-instance lock; dev runs need `--user-data-dir`.
- PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM that silently breaks
  `settings.json`. Write JSON with Node.
- Electron ESM: `app.whenReady().then(main)`, never top-level await; add
  `app.on('window-all-closed', () => {})` or a loop that destroys windows quits
  the app mid-run; `app.exit()` does not flush piped stdout.
- Do not force-kill Stoke: it orphans the CLI children and the restarted app
  cannot reattach. Both the tunnel outage and the "nothing active" confusion
  this session came from that.
- The usage endpoint is undocumented. Report unavailable rather than guess.

## Running Stoke on more than one machine (design note)

Nothing in `src/main` or `src/remote` calls `os.hostname()` — the phone has no idea
which machine it is driving. With one machine that is fine; with several it is the
first thing to fix.

**The trap:** `tunnelName` defaults to `stoke` and `hostname` to whatever was set.
Copying `settings.json` to a second machine — or just accepting the defaults and
reusing the same named tunnel — registers both as connectors on *one* tunnel.
Cloudflare then load-balances between them, so `code.vinn.dev` reaches a random
machine per request. It fails as "my sessions vanished", never as an error.

**The rule: one named tunnel and one hostname per machine.** Never share either.

| machine | tunnel | hostname |
|---|---|---|
| windows desktop | `stoke` | `code.vinn.dev` |
| m1 mac | `stoke-mac` | `mac.vinn.dev` |
| anything else | `stoke-<name>` | `<name>.vinn.dev` |

One Cloudflare Access application over `*.vinn.dev` covers all of them with one policy.

**Never copy `settings.json` between machines.** It carries the token, the hostname
and the tunnel name — every field that must differ. Set each up from scratch.

Worth building, in order:

1. `os.hostname()` in the remote header, the connect link and the QR caption. Small,
   and without it two bookmarks are indistinguishable.
2. A machine picker. Cheapest useful version is a bookmark folder; a nicer one is a
   static page listing the hosts, which needs no code in Stoke at all.
3. Settings do not sync and are per-OS. If profiles and themes should match across
   machines, that wants a synced file, not a per-machine one.

**Servers are a different problem.** Stoke is Electron and needs a display; a headless
box has none. For a server, plain `claude` over SSH in tmux is the right tool, and
Stoke is the wrong one. Do not bend the app into being a daemon.
