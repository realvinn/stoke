# HANDOFF — Stoke

Repo: `G:\Code\personal\Stoke` · `github.com/realvinn/stoke` · `main` · **v0.3.0 built and installed**

> **Superseded.** This is the 0.3.0 handoff, kept as a record of that session. The current
> state of the project and everything still open live in `PLAN.md`; 0.3.2 has since shipped.

## Task

The overnight brief, verbatim:

> okay im going to sleep now can you build all of that then build profiles I want study to be
> red/blue personal to stay orange and work green, if possible since I work with 2 monitors some way
> to have multiple terminals and a live page view of what claude is doing but most importantly we
> need to double check spawn a few sub agents to try out all the features make sure all the
> endpoints work and is secure [...] also if you can test installing the application then first time
> setup

Earlier in the same session: voice mode, typing directly into the terminal on the site, shortcut
buttons, and the 5-hour / weekly / Fable limits with a pace marker.

## State

**DONE and verified.** 0.3.0 is installed and running; every claim below was measured.

| area | evidence |
|---|---|
| Extractor: `display: contents`, inferred outline, `section()` | `fbe9e18`. claude.com 0 -> 1,553 chars; mistral outline 0 -> 34; Wikipedia section 0 -> 11,098 |
| Voice on the phone | `d787bf7`. Live through the installed build: WAV in, correct transcript out |
| Type into the terminal on the site | `d787bf7`. `term.onData` was never wired; composer kept for phones |
| Terminal fills its pane | `d787bf7`. 96-98% on a phone, 99% on a desktop; was rendering the desktop's fixed grid |
| Security | `172ac46`, `21a85db`. `npm run verify:security` — **16/16 against the installed app** |
| Plan limits + pace marker | `c05216f`. `npm run verify:usage` — 16 assertions plus a live call |
| Profiles | `43e3a88`. Four colours, all clearing 4.5:1 (6.83:1 worst) |
| 0.3.0 installer | `282ad21`. Built, installed silently, relaunched, serving on 7878 and through the tunnel |

**NOT DONE**

1. **Multi-terminal and the per-terminal browser.** Not started. The design is settled and written
   down in `PLAN.md` — edge-hugging FAB, `+` opens a panel offering new chat here / new
   temp chat / different folder, each terminal with its own browser view.
2. **First-run setup was never tested.** The install was an upgrade over 0.2.0, so existing settings
   were already present. A genuine first run needs a clean `%APPDATA%\Stoke`.
3. **Shortcut buttons on the site.** A `.keys` row already exists (esc/tab/arrows/ctrl-c/enter/
   shift-tab/ctrl-r); it was never reviewed for what is missing or how discoverable it is.
4. **No `sttUrl` field in desktop Settings.** It defaults to `http://127.0.0.1:17890` and can only
   be changed by editing `settings.json`.
5. **macOS still unverified.** No Mac code path has ever run.
6. **A git tree showing features** — asked for as "would be cool". Not started.

## Security findings that were fixed

Worth knowing, because they were all silent:

- `POST /api/sessions` forwarded `permissionMode` verbatim, so one request could start
  `--dangerously-skip-permissions` **anywhere on disk**. The desktop guards this behind a
  confirmation; the remote route had none and the UI never offered it.
- `cwd` went straight into spawn unvalidated; a bad one threw a message leaking absolute paths.
- `?id=../../../../x` on `/api/transcript` read any `.jsonl` on the machine.
- `readJson` was unbounded while `readBody` two lines above capped at 25 MB.
- A malformed body read as "no body" and quietly started a session in the default directory.
- The cookie — a shell credential — lacked `Secure`.
- The WebSocket upgrade had no origin check.
- Wrong methods on `/api/*` returned the app shell with status 200.
- Attaching to a dead pty succeeded silently.

## How to verify

```bash
cd G:\Code\personal\Stoke
npm run typecheck
npm run verify:usage       # plan limits + pace marker, includes a live call
npm run verify:extract -- <profile>\mcp-browser.json   # needs a running app
npm run verify:security http://127.0.0.1:7878 <token> --access
```

`--access` is required against the installed app: it has `requireAccessHeader` on, so without the
header every check fails identically for a reason unrelated to what it tests.

The token is in `%APPDATA%\Stoke\settings.json` under `remote.token`.

## Decisions & gotchas

- **Profiles are a view filter, never access control.** Every profile reaches every file; search
  deliberately crosses all of them. Do not let this grow into permissions.
- **Verify by running.** Every bug in this project has produced plausible wrong output, never an
  error. A passing typecheck has caught none of them.
- **A metric can reward the failure it should catch.** "Words not in the DOM" scored a hallucinated
  OCR result as the best run of the night. Read outputs; do not only count them.
- **Do not force-kill Stoke.** It orphans the CLI children and the restarted app cannot reattach.
  Both the tunnel outage and the "nothing active" confusion this session came from that.
- **Electron ESM:** `app.whenReady().then(main)`, never top-level await. Add
  `app.on('window-all-closed', () => {})` or a loop destroying windows quits the app mid-run.
  `app.exit()` does not flush a piped stdout.
- **Nested backticks inside a template literal** end it early — a SyntaxError before anything runs.
- **Do not patch JS with Python heredocs.** Escaping ate a string literal twice.
- **PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM** that silently breaks `settings.json`.
- **The usage endpoint is undocumented.** Report unavailable rather than guess.
- **Rejected, do not re-propose:** Claude Code's native Remote Control.

## Next actions

1. Multi-terminal, to the design in `PLAN.md`.
2. Test first-run against a clean `%APPDATA%\Stoke`.
3. ~~Add `sttUrl` to desktop Settings.~~ Done, `9ddd435`.
4. ~~Review the site's shortcut row.~~ Done, `44e0df4`.
