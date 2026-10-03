---
paths:
  - "src/main/**/*.ts"
  - "electron.vite.config.ts"
  - "src/renderer/src/components/HostsSettings.tsx"
  - "src/renderer/src/components/ProfilesSettings.tsx"
  - "src/renderer/src/components/ProvidersSettings.tsx"
  - "src/renderer/src/components/SettingsSheet.tsx"
  - "src/renderer/src/lib/useDraft.ts"
  - "src/shared/ui.ts"
  - "src/shared/secrets.ts"
  - "src/shared/setupFile.ts"
  - "src/renderer/src/components/BackupSettings.tsx"
  - "src/shared/hub/*.ts"
  - "scripts/verify-hub.mts"
  - "hub/**/*.ts"
  - "hub/build.mjs"
  - "scripts/verify-hub-server.mts"
  - "scripts/verify-hub-client.mts"
  - "src/renderer/src/components/AccountSyncSettings.tsx"
  - "src/shared/privateChat.ts"
  - "scripts/verify-private.mts"
---

# Anywhere in the main process

Rules for all main-process code: no sync fs or eager heavy imports, claim-before-await, execFile,
nativeTheme, settings writes, userData. Loaded when a file in `paths` is read; CLAUDE.md keeps a
one-line index of each. Numbers are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 12. An explicit `--user-data-dir` must win over dev isolation

**An explicit `--user-data-dir` must win over dev isolation.** An unpackaged run picks its
own `(dev)` userData so it never fights the installed app, but that override has to be
skipped when the flag is present, or a test profile boots the wrong settings and looks
fine doing it.

> **Checked against the code on 2026-09-30** — the isolation stops at userData. Anything Stoke
> writes OUTSIDE it (`~/.stoke/accounts/index.json`, the account folders beside it) is shared by
> the installed app, `npm run dev` and every `--user-data-dir` sandbox that does not also move
> HOME, and each of them knows only its own settings. The first account index was written from
> one Stoke's list alone, so a dev build with no accounts booted, found the installed app's
> index and wrote it back EMPTY — `stoke account env work` then failed for the app's accounts,
> and the app's own write cache kept it from repairing the file until it restarted (found in
> review; reproduced by `verify:accounts` against the old write: 10 failures, including the
> shim printing nothing). A shared file is merged per writer and never replaced
> (`updateAccountIndex`: a `writers` record keyed by the realpath'd userData, a `mkdir` lock
> around the read-merge-write, a writer whose userData is gone dropped), and a Stoke with
> nothing of its own in it never writes at all (`accountIndexNeedsWrite`). Proven live with two
> userData folders under one scratch HOME: the dev instance's boot left the app's index
> byte-for-byte, and its add-then-remove put it back to exactly the app's.

## 13. `execFile` defaults to a 1 MB `maxBuffer`, and `spawnSpec` routes `.cmd` installs through `cmd.exe /c`

**`execFile` defaults to a 1 MB `maxBuffer`, and `spawnSpec` routes `.cmd` installs
through `cmd.exe /c`**, which eats `&`, `|`, `^`, `<` and `>`. Feed a prompt on **stdin**,
never as an argv element, and raise `maxBuffer` well past the default.

## 20. An `await` inside a polling pass is a window two passes can both walk through

**An `await` inside a polling pass is a window two passes can both walk through.**
`AutoScanner.evaluate()` awaits the gate (a disk read), so a pass can outlive its own 15s
interval; without a reentrancy guard *and* claiming the session before the await, two
overlapping passes each started a paid scan for the same session. Setting the claim after
the await is not enough — that is the window.

> **Checked against the code on 2026-09-30** — a claim must say WHOSE it is, not just that one
> exists, wherever the claim can be dropped while its await is pending (a Stop, a restart, an
> unmount). Settings → Voice's Test meter (`MicPicker`) claimed with a shared placeholder
> (`stopTestRef.current = () => {}`), and its `.then` kept the stream whenever the ref was non-null.
> A Stop during the open cleared it and the next Test set a new placeholder, so the first open read
> the second's claim as its own and both installed: Test, Stop, Test left a microphone stream and its
> AudioContext running after Stop AND after closing Settings. Measured over CDP against the built app
> with Chromium's fake microphone, in four orderings including none added: 1 live track and 1 open
> context before the fix, 0 and 0 after. The `.catch` had the mirror bug — an older start's failure
> cleared a newer claim, orphaning the newer stream and showing an error for a test already stopped.
> The fix is a fresh object per start (`const mine = { stop: null }; claimRef.current = mine`), and
> every continuation acts only while `claimRef.current === mine`; `createRecorder`'s `generation`
> counter is the same idea. Truthiness cannot tell two starts apart.

## 25. `execFile`'s error packs three unrelated things into `code`

**`execFile`'s error packs three unrelated things into `code`.** A POSIX errno string when the
spawn failed, one of Node's own `ERR_*` identifiers, and a plain **number** when the child ran
and exited non-zero. A timeout is none of them: Node kills the child, so the error arrives with
`killed: true`, `signal: 'SIGTERM'` and `code: null`. Test `killed` *before* the numeric code or
every timeout reports as "exited with code null" — and note the real-process test does not catch
that reordering, because a genuine timeout has no numeric code to be confused by; only a process
carrying both (`killed: true, code: 143`) distinguishes the two orderings, which is why
`verify:updates` asserts that case explicitly. Related: returning `stdout + stderr` from both the
success path and the catch, as `updates.ts` used to, makes a failure and a success literally the
same value.

## 40. A synchronous `fs` call in the main process is a bet that every path in the list is on the internal disk — and the project list is exactly where that bet loses

**A synchronous `fs` call in the main process is a bet that every path in the list is on the
internal disk — and the project list is exactly where that bet loses.** This was the cause of
"Stoke sometimes takes ages to start", and the "sometimes" is the whole tell: a constant cost
would have been found years ago.

`listProjects` ran `existsSync` once per project (`projects.ts:174`) plus once per manually
added folder (`:229`), and `findSessionFile` ran one per history directory in a `for` loop.
Instrumenting the built main process — a prologue that wraps every sync `fs` method, spliced
into a copy of `out/main/index.js`, run under a copy of the real settings — counted **392
synchronous `existsSync` calls in the first six seconds of one boot, 40 of them against paths
on an external USB SSD**. That machine had eight projects under `/Volumes/NVME (1TB)`, and
`pmset -g` reports `disksleep 10`: after ten idle minutes the disk is asleep and its first
access has to wake it.

The cost is not the wait, it is *where* the wait happens. A sync call blocks the Node event
loop, so it stops every IPC reply and every frame with it. Measured by injecting a delay into
`/Volumes` stats only: at 200ms per stat, `ready-to-show` moved **733ms → 2012ms** and the main
thread was blocked **6.4s of the first 6s** — the window appears and then sits frozen. It is a
race, too, which is the other half of "sometimes": with a fast disk `listProjects` has not
started by the time the window paints, and with a slow one it gets there first and holds the
paint. After the fix (async `access` + a shared deadline + one parallel resolve for the whole
set): **52 sync calls, none on `/Volumes`**, and the same 200ms injection changes nothing at
all — 414ms to `ready-to-show`.

Two things worth carrying beyond this one bug. **`existsSync` is never the cheap option it
looks like** in a process that also draws a UI; the deadline in `folderExists` matters as much
as the `await`, because it decides that a list may be briefly *wrong* rather than late. And
**`String.prototype.split`'s limit caps the array, not the read that produced it** —
`cwdFromTranscript` did `readFile(file, 'utf8')` then `split('\n', 200)` and read 14.76 MB per
`listProjects()` on this machine, unbounded in principle, while `sessionFile.ts`'s `readLines`
had had the bounded head+tail reader all along. `listProjects()` went from ~30ms to ~6ms warm
on that change alone.

None of this is visible to `npm run check`, and that is gotcha 31's lesson again: every one of
these calls is a side effect inside a function whose return value is correct. It took wrapping
`fs` in a real launch to see any of it.

**The other half of the boot cost was a static import list, and `externalizeDepsPlugin` is why
it is invisible.** electron-vite does not bundle dependencies, it re-emits them as bare
`require()` calls at the top of `out/main/index.js` — so a static import in any main-process
module is resolved and *evaluated* before `app.whenReady()` fires, whether or not the feature
is ever used. Seven externals were required at module scope. `@modelcontextprotocol/sdk`
dominated: 230 module files across 11 packages (hono, ajv, zod-to-json-schema and friends) for
53-91ms, all so that `handle()` could answer an HTTP request that most launches never receive
— `BrowserMcpServer.start()` itself needs only `node:http` and one 221-byte `writeFileSync`.
`electron-updater` cost 23-51ms for a check deliberately deferred to +8s, and `qrcode` 5-16ms
for one panel.

Deferring those three (memoised `loadSdk()` in `mcp/server.ts`, a memoised `updater()` in
`selfUpdate.ts`, one `await import('qrcode')`) took **`whenReady` from 336ms to ~50ms and
`ready-to-show` from 733ms to ~260ms**, and dropped module resolution from 649 `realpathSync`
and 470 `readFileSync` calls to 27 and 23. Check it stayed fixed by grepping the built bundle,
not the source — `grep -nE '^const [A-Za-z_$]+ = require\("' out/main/index.js` should list
node builtins, `electron`, `@lydell/node-pty` and `ws`, and nothing else. A dynamic `import()`
of an externalised dependency survives the build as a lazy require; a static one does not.

Unlike the `/Volumes` stalls this is a *constant* cost with no variance, so it was never the
"sometimes" — it is simply floor. Both were worth fixing and only the first one explains the
complaint.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - There is no `folderExists` anywhere in src/ or scripts/. The async check with a deadline is the module-private `pathExists` in src/main/projects.ts:49 (a `Promise.race` of `access` against `EXISTS_DEADLINE_MS = 1500`, :25), batched in parallel by `existsMap` at :69.
> - Both line numbers now point at unrelated code: :173-174 is `cwdFromTranscript`, :229 is blank and :230 declares `merged`. Both existence checks are now one `existsMap(...)` call over the merged project paths plus `addedPaths`, at src/main/projects.ts:319.

## 55. `nativeTheme.themeSource` is both the pin and the question, and pinning it makes the answer meaningless

**`nativeTheme.themeSource` is both the pin and the question, and pinning it makes the
answer meaningless.** Stoke sets `themeSource` to its own theme's appearance so the docked
browser's `prefers-color-scheme` matches the window around it (see `applyNativeTheme`). That
same pin decides what `nativeTheme.shouldUseDarkColors` returns — so "does the OS want dark"
cannot be asked while the pin is on, in EITHER process: `matchMedia('(prefers-color-scheme:
dark)')` in the renderer resolves against the pin too, and would hand Stoke's own setting
back to Stoke forever. Following the system therefore has to release the pin (`'system'`),
which is why `applyNativeTheme` takes the settings rather than a resolved theme.

Two consequences worth carrying. **Order matters in the settings handler**: that call CHANGES
what `effectiveTheme` reads, so the previous theme has to be resolved *before* it or the
comparison is the new state against itself and the window's `backgroundColor` is never
repainted. And **`nativeTheme.on('updated')` also fires when Stoke writes `themeSource`** —
every settings save — so the handler is guarded on the value actually having moved.

A theme pair is two ids, not one plus an inversion. There is no light version of Nocturne to
compute: the ladder's light and dark step maps disagree on purpose (gotcha 43), so a light
theme is a different theme. `activeThemeId`, `themeSlotFor` and `followPatch` are pure and in
`themes.ts` because MAIN needs the same answers — the QR quiet zone and the palette served to
the phone are resolved there, and a second copy of the rule is how the phone would come to
paint one theme while the desktop painted another.

## 63. `setSettings` writes the whole settings file synchronously, and seven controls in the sheet are sliders

**`setSettings` writes the whole settings file synchronously, and seven controls in the sheet
are sliders.** `persist` is `writeFileSync` + `renameSync` on the main thread, and a
`<input type="range">` fires `onChange` continuously while dragged — so a drag was tens of full
serialise-and-rename cycles a second, each blocking the event loop and with it every PTY reply.
Gotcha 40 reached through a slider. Coalesced in `store.ts` on BOTH edges, deliberately: a
single discrete change still writes immediately, so the ordinary case gains no window in which
a crash loses a setting, and only a burst collapses. Measured: a 40-tick drag produces one file
version during the burst and one after. `flushSettings()` runs from `before-quit` **and** the
window's `closed` handler, because on macOS the former does not fire when the last window
closes (gotcha 35).

Two more in the same panel, both invisible to any suite. **Closing the sheet fires no `blur`**
— App renders it as `{settingsOpen && <SettingsSheet …>}`, so Escape unmounts the tree, and a
draft committed on blur is simply lost. HostsSettings and ProfilesSettings flush from an
unmount cleanup, through a ref updated on render so the cleanup sees the last drafts rather
than the first (gotcha 31). And **`Number("")` is 0, which is finite**, so `clampUiScale` on an
emptied number field returned the FLOOR rather than rejecting it — selecting the Interface
scale box and typing shrank the whole UI to 0.8 on the first keypress.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - It still does, and it is still reachable. `clampUiScale('')` returns 0.8 today (src/shared/ui.ts:9-13, evaluated under node strip-types): the function was never changed. The fix is only a `trim() !== ''` guard in the Interface scale field's `onChange` (src/renderer/src/components/SettingsSheet.tsx:487). Its `onBlur` (:492) passes an emptied `scaleDraft` straight to `clampUiScale`, so clearing the box and tabbing away still sets `uiScale` to the 0.8 floor.

> **Checked against the code on 2026-09-19** — fixed. The `onBlur` handler now reverts empty or
> non-numeric drafts to the current `settings.uiScale` instead of passing them to `clampUiScale`.
> An empty field followed by blur leaves the scale unchanged (src/renderer/src/components/SettingsSheet.tsx:547-557).

## 91. A folder reached through a symlink stored one path while `claude` recorded another

`stoke .`/`--open`/the Open-folder dialog used to remember whatever string the shim or the dialog
handed back — `/tmp/foo` on macOS, where `/tmp` is a symlink to `/private/tmp`. The `claude` that
Stoke then spawned in that cwd reports its OWN cwd through `getcwd(2)`, which the OS resolves
through symlinks, so its transcript and `pty.ts`'s `realCwd` both say `/private/tmp/foo`. Two
different strings for one folder means two different sidebar rows once `listProjects` merges
opened folders with transcript-derived ones — one carrying the live session, one permanently
empty — for every symlinked path anyone opens: `/tmp`, `/var`, an iCloud-synced folder, a
symlinked dev directory.

Fixed at every place a folder enters, not at the merge: `realpathFolder` (`index.ts`) resolves
`acceptLaunch`'s folder and both `dialog.showOpenDialog` handlers (project roots and manual add)
before the path is ever remembered, stored, or sent to the renderer — `withFolder` (`stokeArgs.ts`)
rewrites the checked `StokeCliRequest` in place so the renderer sees the resolved path too. A
project stored under the OLD, unresolved path before this shipped — or one written into
`~/.claude.json` by hand — still needs to collapse onto the same row: `listProjects` (`projects.ts`)
now resolves every scan-root and `projectMeta` key through `realpathOf`/`realpathMap` before using
it as a dedupe key, merging two keys that resolve to the same folder with `addedManually` surviving
if EITHER side set it (losing that would silently un-list a folder nobody removed).

Both resolvers fall back to the typed path, under the same deadline `pathExists` uses (gotcha 40),
when `realpath` cannot answer in time or the folder does not exist — a folder that is gone still
needs a stable key, and a slow volume must not delay the whole launch or the whole project list.

Proven without a live `claude`: `scripts/verify-folders.mts` adds a real symlink under a
(`realpathSync`-resolved, since macOS's own `$TMPDIR` is itself symlinked) tmp dir, gives the two
paths it resolves to different `projectMeta` fields, and asserts `listProjects` returns exactly one
row, keyed by the real path, carrying both sides' fields.

> **Checked against the code on 2026-09-19.** The merge above is a VIEW, and three things still
> read or wrote the UNRESOLVED string underneath it, all confirmed live with a planted stale key:
> `projectMetaPatch` (Remove, "No icon") only ever replaces the exact key matching the path the
> renderer sent — the row's realpath — so the stale symlinked key it can never reach re-merged its
> old fields back in on every list, making Remove and clearing the emoji no-ops and "No icon" write
> a second key. `pinnedProjects`/`hiddenProjects` were compared against the unresolved string even
> after this fix shipped, so a pin or hide saved under a symlinked path matched nothing — a pinned
> folder lost its pin, a hidden one came back. And `CH.workspaceDefault` (the launcher's "Start
> here" and the default New-tab folder) was never realpath'd, only `acceptLaunch`'s `req.cwd` was
> — so a launcher tab and a `stoke DIR` in the same symlinked folder disagreed on `pathKey` and
> `handleLaunch` started a second `claude` beside the first. Fixed by `migrateSymlinkedProjectKeys`
> (`projects.ts`), a one-time boot-time rewrite of every stored `projectMeta`/`projectRoots`/
> `pinnedProjects`/`hiddenProjects` key still under a symlinked path onto its real one, plus
> realpathing `pinnedProjects`/`hiddenProjects` in `listProjects` for a project added mid-session,
> plus realpathing `CH.workspaceDefault`'s result the same way `acceptLaunch` already did.

## 101. PowerShell has five single quotes, so a path spliced into a `'…'` literal is not safe

**PowerShell's tokenizer treats U+2018, U+2019, U+201A and U+201B as single quotes too**
(`CharTraits.cs`), so the familiar "double every `'`" escape is not an escape: a profile folder
like `C:\Users\O’Brien` — a curly apostrophe, which autocorrecting keyboards and some account
setups produce — ends the literal early and turns the rest of the path into code. Measured with
pwsh 7.6.6: `$x = 'C:\Users\O’Brien\Stoke'` is a ParserError, "The string is missing the
terminator". Anything Stoke
hands PowerShell must carry its variable parts as DATA, never as code: `portableSwap.ts`'s
helper is a constant ASCII script that reads its paths from a UTF-8 JSON plan (`-File` with
`-Plan`); `build/installer.nsh` passes `$INSTDIR` in the environment; `extractZip`'s fallback
passes both paths through `STOKE_ZIP`/`STOKE_DEST`. Two related traps the same code avoids:
Windows PowerShell 5.1 reads a BOM-less script file as the ANSI code page, so a script written to
disk must be pure ASCII (`verify:portable` pins it), and `-EncodedCommand` — which the picker's
install tab uses for its fixed, table-built text — is a stock Defender/ASR heuristic, so an
unattended helper uses `-File` instead.

> **2026-09-21:** the install tab's `-EncodedCommand` is now a short FIXED stub that reads the
> script from a file (`windowsInstallerArgs`, path in `STOKE_INSTALL_SCRIPT`) — a script file run
> with `-File` is subject to execution policy, which an AllSigned Group Policy enforces over the
> command line's `Bypass`, while a script block built from text is not. The portable-update helper
> still uses `-File`; under AllSigned it never starts, and the next launch says so.

## 116. `hydrateSettings` is not idempotent, so two settings are comparable only after the same number of hydrates

**An import of a file made from an identical fresh profile previewed "Worklog boards: changes
targets".** Found driving the Backup & transfer import on 2026-09-30, not by the suite.
`hydrateWorklogBoards` returns `DEFAULT_WORKLOG_BOARDS` whole for a settings file with no
`worklogBoards` key — `targets: ['notion']` with an empty `notionDataSource` — and the SAME object
hydrated again loses `'notion'`, because a destination with no id is dropped. So a profile that has
never written a setting holds `['notion']` in the cache, the first `setSettings` of any field turns
it into `[]`, and anything that diffs the cache against `hydrateSettings(merged)` reports a change
that is only a second pass. Measured with `hydrateSettings(null)` exported and imported into
`hydrateSettings(null)`: one phantom change before, none after.

A second false change came from key ORDER, not value: a merged host is `{ ...theirs, keyEnrolled }`,
so its keys come back in a different order from the stored record while every value is equal, and
`JSON.stringify(a) === JSON.stringify(b)` calls that a change ("SSH hosts: updates Box" for a file
made from this very setup).

`planImport` (shared/setupFile.ts) hydrates the CURRENT settings once more before merging and
diffing, so both sides have been through hydrate the same number of times, and `previewSetup`
compares with `stable` (keys sorted). `verify:secrets` holds both: fresh into fresh, and a setup
into itself, must preview zero changes. The rule reaches past this file — the auth-hub design's
Phase 2 sync is per-field last-writer-wins over hydrated records, and a phantom diff there is a
phantom WRITE on every device on every sync. Whether to make `hydrateWorklogBoards`'s default branch
filter like its other branch is a behaviour change to the worklog panel's fresh state, left open.

## 125. node:sqlite binds a JS number as REAL, and an FTS5 table ignores a REAL rowid without a word

**Chat search showed twenty hits from twenty different conversations with ONE snippet.** Found
driving the built app on 2026-09-30 against a sandbox index of this machine's real chats (79 chats,
4,355 messages): every "In conversations" row for "screenshot" quoted the same sentence. The store
picked the best message of each chat correctly — twenty distinct message ids, twenty distinct texts
(hashes compared, no text printed) — and then asked FTS5 for each one's snippet with
`… WHERE message_fts MATCH ? AND rowid = ?`, binding the id as a plain JS number.

node:sqlite binds every JS `number` as a REAL (a `BigInt` is the only way to bind an INTEGER without
SQL help). An ordinary table compares `rowid = 2930.0` with 2930 and finds the row. FTS5 does not:
its rowid constraint with a REAL value is simply not applied, the MATCH runs unfiltered, and
`.get()` returns the FIRST match — measured with the same three ids, bound as a number the query
answered rowid 6 three times; as a `BigInt`, as `CAST(? AS INTEGER)` and as a literal it answered
2930, 3041 and 2514. No error, no warning, and a plausible-looking result, which is why only a
screenshot of real data showed it: `verify:chat-sources` had one hit per snippet check until then.

`ChatStore.search` casts in SQL (`rowid = CAST(? AS INTEGER)`), so call sites stay plain numbers,
and the suite now asserts that every hit quotes its OWN chat (`each hit quotes its own chat`, shown
to fail with the cast removed). The rule reaches every virtual table and every `node:sqlite` caller:
a rowid or an id that a virtual table's `xBestIndex` compares should be bound as a `BigInt` or cast.
Ordinary tables tolerate the REAL: the store's own `id = ?` deletes and lookups, bound the same way,
are what `verify:chat-sources`' pruning checks exercise, and they pass.

Two neighbours from the same round, both commented in `ChatStore.search`: an FTS5 auxiliary function
(`bm25`, `snippet`) errors with "unable to use function bm25 in the requested context" once the
subquery holding it is flattened into an aggregate — `WITH h AS MATERIALIZED (…)` keeps its FTS
context — and grouping best-message-per-chat must happen in SQL before the limit, or one chat that
matches more messages than the limit crowds every other chat out of the result.

> **2026-09-30, the same store: FTS5 frees no page when a row is deleted.** The store's ceiling
> first evicted "until the used pages fit" (`page_count - freelist_count`). With external content a
> delete writes a tombstone into a NEW segment beside the old postings and frees neither until a
> merge rewrites both. Measured with 200 synthetic chats: deleting half of them (text 11.22 → 5.86
> MB) moved used pages 20.64 → 18.19 MB, and only `optimize` brought them to 10.92 (a Zipf
> vocabulary: 7.77 → 5.54, then 3.89). So page-counted eviction took two to four times what it
> needed — 11 of 12 chats to shed 30% in `verify:chat-sources` — and could empty the store with
> the pages still over. Measure an FTS5 store by the text it holds (`evictToText`; merged, real
> chats come to 1.73 disk bytes per text byte), never let a deleting loop wait on page counts, and
> run `optimize` only where its whole-index rewrite is affordable (`tidy` after a big pass). Its
> sibling in the same fix: an eviction that deletes a chat's read positions must leave a cut
> behind (`storeCutMs`), or the next pass admits, re-reads and evicts the same chats every time.

## 139. `SshHost.id` is a per-machine counter, so two machines' `host-1` are usually two different servers

**Found 2026-10-01, writing the Stoke Hub contract's host sync.** HostsSettings' `newHostId` mints
`host-1`, `host-2`, … — the first free number in THIS machine's list — and its comment says the ids
"only have to be unique inside this list and never leave settings.json". They left it anyway: the
`.stoke-setup` export carries every host with its id, and `mergeSetup` (setupFile.ts) folds hosts in
with `mergeById`. Measured against the shipped code with a synthetic pair of profiles: a Windows
profile holding `host-1` = "NUC" (`nuc`) imported a Mac setup holding `host-1` = "VPS" (`vps`), and
`planImport` returned `[["host-1","VPS","vps"]]` — the NUC gone — and previewed it as
`SSH hosts: updates VPS`, which reads like an edit to a host the user has, not the loss of one.

The rule: **never match an SSH host across machines by `SshHost.id`.** The hub's T3 items are keyed
by a SYNC id (`h…`, `ID_BYTES.host` in `src/shared/hub/codec.ts`) that travels on the host
(`SyncableHost.syncId`, hydrate keeps it because it spreads `...h`); `applySyncedSettings` matches
by that, lets a local host with no sync id ADOPT one only when alias and command are both equal
(the same server, known on both machines before either synced), and appends anything else under a
free LOCAL id (`freeHostId`, the same rule as `newHostId`). `parseItemPath` refuses `t3/host/host-1`
outright, and `verify:hub` holds the two-`host-1` case (`two machines' host-1 stay two hosts`).

**Not fixed here:** `mergeSetup` still matches by id, so a `.stoke-setup` import can still replace a
different host. The fix is the same rule — by `syncId`, else alias + command, else append with a
free id — and needs its own `verify:secrets` case (the one above, which the old merge fails).

## 140. A device id is a name anyone with the password can claim, so a hub device is ACTIVE only by id AND key

**Found 2026-10-01, building the hub server (`hub/app.ts`).** A device picks its own id and posts
it with its public keys at sign-in (`LoginRequest.device`); the session is bound to both. The
obvious "is this device active" test — is `session.device_id` in the chain's active list — is
wrong in a way no honest flow ever exercises: someone holding the password signs in FIRST under
the id a real device is about to join with (a squatter: pending, since the chain does not list
that id yet), the real device then joins with its own keys, and the squatter's session now names
an active id. By id alone the hub hands it every active-only route — read all of the account's
items and every change to them (ciphertext, but all of it), and PUT over them as that device:
junk no device can open, which destroys the data as surely as reading it would expose it. The
spec's promise (§7.1) that a guessed password "cannot read items" would be false.

The rule, in three places:

- `authenticate` counts a session active only when the chain lists its id WITH
  `sign === session.sign_pub` (`Authed.active`).
- `login` refuses an id the chain binds to another key, and any revoked id: a revoked device
  comes back as a new identity or not at all.
- `verify:hub-server` holds the squatter: sign in under C's id first, let C join by the Recovery
  Kit, and the squatter's `GET /v1/items` must still be `pending` (and its next sign-in
  `forbidden`). Measured by mutation: with the key match dropped
  (`find((d) => d.id === session.device_id)`), that check was the ONLY failure in the whole suite.

The same holds wherever else "is this device active" is decided — the Stoke-side sync engine, and
the relay host judging who is attaching (which already verifies the handshake against the
chain's key for that id): compare the chain's record by id AND key, never by id.

The suite-level lesson from the same round: `verify:hub-server` went green on its first run, so
every refusal in the server was mutated one at a time (`/tmp/.../mut/run.mjs`, eighteen of them:
drop the replay check, the edge secret, the invite claim, the wraps rule, the account scope on
relay ids, …) until each turned it red. Two did not at first, and both were real gaps: the only
text-frame check was on a frame the relay had QUEUED before the host joined, which takes a
different delivery path from a live one; and nothing ever logged a secret-named field, so the
log's redaction was untested. A suite that passes first time has not yet shown it can fail.

> **Checked against the code on 2026-10-01 (a review of the hub server)** — the rule had reached
> only `authenticate`. The pairing routes still judged a PENDING device by id alone: `visiblePair`,
> `pairReveal`, `pairRefuse` and `pairCreate`'s expiry loop compared the pair's `device_id` with the
> session's, and refusals were counted per id. So a squatter signed in under a joining device's id
> could read its pair, refuse it (its own mismatched reveal refused it too), expire it by opening
> one of its own, and run the id's refusal count to three — the real device locked out of pairing
> for the hour, and again the next hour. The SAS still kept a wrong key from joining: denial of
> service, not compromise. A pair now stores the opening session's key (`device_sign`), `ownsPair`
> compares id AND key, and refusals count per (id, key). `verify:hub-server` holds it: the squatter
> gets 404 on B's pair and on its reveal and refuse, its own pair leaves B's open, and three
> refusals under one key do not lock another. Mutated back to id alone, the squatter's reveal
> refused B's pair and B's own pairing failed outright. Wraps got the same rule in the same review:
> `chainAppend` takes them only from a device active before or after the entries, by id and key.

> **Checked against the code on 2026-10-01 (a review of the hub client)** — "active by id AND key"
> is only half the rule on the CLIENT, because there the chain itself is the hub's word. `verifyChain`
> accepts any self-signed genesis for the account id, and a signing-in device posts its public keys in
> the login body — so a compromised NUC, the Cloudflare edge or an http MITM could answer a device's
> FIRST sign-in with a whole list of its own (its genesis, then an `add` of those keys, a `vk` commit
> for a vault key it chose), and the device, listed by id and key, took the key, pulled a forged
> `acct/pref/sync-keys {on:true}` and uploaded every portable API key under it in the same pass. Two
> reset paths did the same to a device that already held a pin: a re-sign-in answered with another
> account id threw the pin away, and the alarm's "Take the hub's copy" set `pinned = null`. The client
> now counts itself active only where the served chain holds its own ANCHOR — the link of the entry
> it entered through: its genesis, the `add` it took after the owner confirmed the code ON IT
> (`joinConfirm`), or its Kit `add` — kept in hub-state.json and dropped only by `signOut`
> (`isActiveIn`, `anchorHolds`). A list that names it without the anchor is the `chain` alarm; a
> login answering another account is refused ("sign out first"); `setUrl` is refused while the
> device belongs to an account; and "take the hub's copy" became `republish`, which accepts only an
> earlier copy of the device's own list (`isPrefixOf`). `verify:hub-client` holds each through the
> device's injected `fetch` playing the hub: mutated back, the fake vault, the fake approver, the
> other account id, the lapsed-session `setUrl` and the republish over a different list each go red.

## 141. The hub demands the Recovery Kit's wrap of every new epoch, and a device that could make one could open it

**Found 2026-10-01, building the hub client's revoke (`HubService.rotate`).** Spec §4.6 says a
revoke makes `VK_{e+1}`, "wraps it to every remaining active device and re-wraps the recovery
copy" — and the server (`chainAppend`) refuses any revoke or rotate without a recovery wrap for the
new epoch. A recovery wrap is AES-GCM under `RK = HKDF(Kit secret, account)`, so the revoking device
must hold RK. The obvious way to make that painless is to keep RK on every device (sealed, or as a
vault item). That quietly defeats revocation: RK never changes for the life of a Kit, and
`GET /v1/vault/recovery` is a `session` route — a pending device may read it by design, because the
wrap is useless without the Kit. A removed device that kept RK, plus the account password (a stolen
laptop, or malware that saw it typed), signs in as a NEW pending device, fetches the recovery wrap
of every later epoch and opens it. Spec §7.1's "cannot: anything after revocation" would be false.

The rule: **never keep RK (or the Kit) on a device.** Removing a device asks for the Kit, typed and
used once (`revokeDevice(target, { kit })`), or makes a NEW Kit in the same append (`{ newKit: true }`:
a `revoke` then a `rotate` naming the new recovery key, wraps for the final epoch only, the new Kit
shown and confirmed before anything is posted — `PendingKit.purpose: 'revoke'`). The panel says why
it needs the Kit. The costs, accepted: revoking is impossible without the Kit or a new one, and a
removed device holding RK from a Kit typed on it (the Kit join, `recover`) is exactly why the panel
recommends a new Kit after joining that way.

Held by `verify:hub-client` (`removing a device needs the Kit`, a wrong Kit refused; after the
revoke, the removed device's sealed vault keys open none of the re-sealed items and the hub holds
no wrap of the new epoch for it) and proven in two sandbox Stokes against the real server: after
the revoke, `wraps` held epoch 2 for the remaining device only, every item sat at epoch 2, and a key
added afterwards never reached the removed one.

> **Checked against the code on 2026-10-01 (a review of the hub client)** — the typed Kit was the
> PRIMARY Remove path, and it keeps the Kit: useless against a device that has had that Kit in hand.
> A device added with it (`signer: 'recovery'`), the device that made it (shown there, and "Save as
> file…" writes it into ~/Documents there), and a device that had it typed to remove another can each
> open the new epoch's recovery wrap as a pending session with the password — while the panel told
> the owner the removed device "cannot read anything synced from now on". `kitHandlers` reads those
> devices off the verified chain (from the entry that set the current `recovery` key on); removing
> one needs `{ newKit: true }`, and the Devices list offers only that for it (`kitSeen`). And the
> spec's rotate after a Kit join is no longer a hint: `recover` checks the typed Kit, then makes a new
> Kit, and only once that is confirmed posts the `add` and a `rotate` naming the new Kit in ONE append
> (`postRecovery`) — the typed Kit never opens an epoch the joining device is in. Mutated back, the
> refusal to remove C with the Kit C made, and C's "nothing posted before the new Kit", each go red.

## 142. A pty's replay passes the hub's 1 MiB frame cap once it is JSON inside JSON, and a status is ordered only by the sender's own clock

**Found 2026-10-01, building "Other machines" (the hub relay's host and guest, spec §6).** A remote
tab speaks the phone's pty-socket protocol inside the encrypted channel, and the first thing a pty
socket sends is `attached`, carrying the session's scrollback — up to `MAX_HISTORY` (512 K
characters) — as a JSON string; the relay then wraps that JSON as the `data` of a `ws-msg`, a
second JSON layer, and seals it as ONE hub frame. The hub closes any relay that sends a frame over
`RELAY_MAX_FRAME_BYTES` (1 MiB) with 1009. Measured with node: 512 K characters of a Claude-like
redraw stream (`ESC[2K ESC[1A …` with box drawing, what Ink writes all day) come to **1,234,730
bytes** once wrapped — 2.36 bytes per character, because every ESC becomes `\u001b` and then
`\\u001b`. Every long Claude session would have failed to attach, from any machine, with a close
code that reads like a network fault. (A lighter sample, mostly text, came to 952 KB: under the cap,
which is how a first test passes.) So every inner frame goes through `relayFrameParts`: past
`RELAY_CHUNK_CHARS` (200 K UTF-16 units, at most ~600 KB sealed) it is sent as `part` frames the
receiving `RelayChannel` joins before parsing, capped at `RELAY_MAX_MESSAGE_CHARS`, and a part never
holds a part. `verify:hub-relay` sends a 1.5 MB replay (escapes, accents, emoji) and checks every
sealed part is under the cap and the join is byte-for-byte.

From the same round: **a presence status must carry a time only its SENDER moves forward.**
`newerStatus` keeps the later of two statuses from one device, so a hub replaying an old one
cannot roll the list back — and the first `HubRemote` stamped each status with its raw wall clock.
Under `verify:hub-relay`'s fixed clock every `at` was equal, so the second status — the one that
said "sharing" — was dropped without a word and the other machine kept "Not sharing its sessions";
it showed only as an `until()` that quietly timed out. On a real clock the same drop happens to any
two statuses sent inside one millisecond, and to every status after the sender's clock steps back
(not reproduced live). `publish` now stamps `max(now, lastAt + 1)`, the hybrid clock items already
use (`nextEditedAt`).

The rules around the host that are easy to widen by accident, all in `src/shared/hub/remote.ts`
and held by `verify:hub-relay` (dropping the scope check, the named-guest check, the host's
active-device check or the sharing refusal each turned it red): a frame is served only after BOTH
the grant's mode (`relayFrameVerdict`) and the answer's reach (`relayScopeVerdict`); "Allow once"
reaches one session and NOT `/api/sessions`, whose rows carry every session's folder path (the
presence summary carries folder names only); the host refuses an `hs1` whose guest is not the
device the hub named, and takes no relay at all from a device its own chain does not hold as
active (gotcha 140).

> **Checked against the code on 2026-10-01 (a review of "Other machines")** — four gaps and a
> misleading button, each now held by `verify:hub-relay` and each shown red by mutating its fix back:
> - **The chain was read only at the handshake.** After it, `hostFrame` served every frame on the
>   grant alone, and nothing told `HubRemote` when `refreshChain` installed a new verdict — so a
>   guest removed from the host's chain kept its pty for as long as its relay stayed open, a waiting
>   question could still be answered Always (storing a grant for it), and a tab kept typing into a
>   host since removed (a stolen laptop). `refreshChain` (both branches) and the hub's "removed" bye
>   now call `HubRemote.chainChanged()`: it ends every hosted relay and question whose guest the
>   chain no longer holds BY THE KEY ITS HANDSHAKE PINNED (`RelayChannel.peerSignKey`, gotcha 140),
>   every tab to a host it no longer holds (never reconnected), and deletes that device's Allow once
>   and Always. `hostFrame`, `answer` and `serve` re-check too, so a frame that lands before the
>   hook runs is refused.
> - **Nothing sent the inner `ping`.** Both ends only answered one. The hub's idle close
>   (`RELAY_IDLE_MS`, 10 min) counts forwarded frames only — its WebSocket pings do not move
>   `lastActivity` — so a tab on a quiet session (Claude at its prompt, the owner reading) was closed
>   every ten minutes, dropping keys typed during the reconnect. The guest pings every
>   `RELAY_PING_MS` (4 min) and closes a channel with no pong inside `RELAY_PONG_WAIT_MS`.
> - **The replay guard was the status on show**, which `presenceClosed` and an offline clear, so
>   after a reconnect a hub could hand back any older status of the epoch (one from before sharing
>   was unticked). The mark is per (device, epoch), kept for the process. An EQUAL `at` is taken: the
>   hub hands every device's latest back on each connect, and refusing it (`<=`) blanked the list
>   after every reconnect — the suite holds both directions.
> - **Every status string was capped, the whole never.** 24 sessions of emoji and CJK titles and
>   folder names (each at its cap) sealed to 30,955 characters, measured, past `HUB_LIMITS.statusBytes`
>   (24,576); the hub's `parsePresenceClientFrame` dropped it silently and the sender recorded it as
>   sent. `sealToFit` drops the last-listed sessions until `sealedStatusProblem` passes (18 fit).
> - **"Always" was `{ kind: 'any' }`** — every relayed route, so starting agents, creating folders,
>   every project path and every past conversation — under a button that said "open any session
>   here without asking", in a question about one session. Both answers now reach only the session
>   the relay attached to (`RelayScope` has no `any`); Always only stops the question. The guest
>   never used anything wider, so nothing a remote tab does changed.

## 143. A device outside the vault has no presence socket and no sync timer, so it must poll for the one thing it waits for

**Found by the owner on 2026-10-02, the first day the hub was live.** They signed in on the Mac,
made the vault on their other computer, and the Mac showed nothing. Its `hub-state.json` held the
account with an empty `chain` and no `anchor`. It had looked for a vault once, at sign-in, before
there was one, and never looked again. Only a device in the vault gets the presence socket
(`startPresence` returns unless `isActiveIn`), and `pass` re-armed its timer only for an active
device. So a device in `new-account` or `locked` heard of nothing until Stoke restarted, and it went
on offering "Make the vault". A press there would have made a Kit for a genesis the hub refuses.

The rule: **every waiting state needs its own way of learning what it is waiting for.** While the
phase is `new-account`, `pass` re-arms itself after `waitDelay`: every 5 s for 60 looks, then every
30 s, with failures backing off as sync does. Each look is one `GET /v1/chain`, quiet (no
"Syncing…"). When a vault appears (`vaultAppeared`), a genesis Kit still on screen is dropped and
the device asks to join by itself (`autoJoin`). It also asks at sign-in to an account whose vault
does not hold it. It asks once per sign-in and never at app start, so a device left unjoined does
not put a card in front of the owner on every launch. A Kit join withdraws that request
(`withdrawJoin`), and so does sign-out, or every device in the vault would show it for its ten
minutes. Sign-out gives the next sign-in a new device id, so the hub does not expire the old request
for it. `joinStart` on top of a live request opens no second one. While no device has answered yet,
the waiting card still offers the Recovery Kit, because an owner who lost every device sees that
card first. A sign-in resets `failures`, so the first look is not minutes away behind an old backoff.
The `new-account` panel shows the alarm too, since a forged list met while waiting both raises it
and stops the looking. Auto-joining takes nothing on its own: the codes are still
confirmed on both screens, and while the request is live the unanchored-list alarm is withheld
exactly as it is for a manual join. The active devices learn of the request over presence (`pair`),
and `HubJoinPrompt` says so above the terminal. Before this, it was only listed inside Account &
sync.

`verify:hub-client` holds it with a device that signs in and starts its own Kit before A makes the
vault. It must look again (waited for, not counted in a fixed window), quietly, then go `locked` with
a live request and no Kit, appear on A, stop looking, and withdraw cleanly. Further checks: D's Kit
join and kitCheck's sign-out each leave no request behind, and a press on top of a live request
keeps the same pair id. The pair id is what matters, because the hub expires a device's older
requests itself, so a count on A could not fail.

Each was mutated back to red:
- dropping the re-arm turned 4 checks red;
- dropping each withdrawal turned 1 red;
- dropping the guard turned 1 red;
- labelling waiting passes "Syncing…" turned 1 red.

The first version of the looking check counted looks over 400 ms, and it failed 5 runs in 11 on a
loaded Mac. A whole signed request does not fit in a fixed slice: a review found the time is spent
inside fetch's keep-alive reuse, not in the hub.

## 147. A plain `git status` runs the repository's own code: its fsmonitor hook, and its clean filter

**Found 2026-10-02, building the title bar's git chip (`src/main/gitStatus.ts`).** The chip reads
`git status` in the folder of the tab in front, every 10 s, the moment a tab opens there — before
the person has looked at the folder, and before Claude Code's own trust prompt has been answered.
A folder can be an unpacked archive or a checkout whose `.git/config` and `.git/info/attributes`
nobody has read, and two of the ways a status reads the work tree run commands named there.
Measured with git 2.55 on scratch repos:

- **`core.fsmonitor` set to a script runs it on every plain status** (it touched a marker), as the
  scout found first.
- **`filter.<x>.clean` runs on any stat-dirty file** — one whose mtime moved — because status
  re-hashes it through the clean filter to decide whether it changed. A `touch` was enough. The
  attribute can live in `.git/info/attributes`, so it never shows in a diff. This one survives
  `-c core.fsmonitor=false` and `--no-optional-locks`.

What the reader does, every run: `-c core.fsmonitor=false`; `--no-optional-locks` (and
`GIT_OPTIONAL_LOCKS=0`), so no index write and no `post-index-change` hook, and no fight with the
agent's own `git add`; and, from one `git config --null --show-scope --name-only --get-regexp
'^filter\.'` first (reading config runs nothing), `-c filter.<name>.clean= -c
filter.<name>.process= -c filter.<name>.required=false` for every filter of `local`, `worktree` or
unknown scope (`filterOverrides`). The user's own `global`/`system` filters (git-lfs) stay on:
they are the user's, and turning LFS off reads every touched LFS file as changed. A filter name
`-c` cannot carry (an `=`) refuses the status outright: the chip then says the changes are unknown
rather than run it. `--ignore-submodules=dirty` keeps status out of submodules entirely. It never
fetches, so ahead/behind is "as of your last fetch" and the tooltip says so.

`verify:git` arms a repo with both traps and a `post-index-change` hook, proves each trap with a
plain `git status` first (the controls), then reads it through `readGitStatus` and requires all
three markers absent. Mutated back, dropping `core.fsmonitor=false` turned the fsmonitor check red,
dropping the overrides turned the filter check red, and dropping both lock switches turned the
hook check red.

Not covered, reasoned only: on a Mac without the Command Line Tools `/usr/bin/git` is a stub that
opens Apple's install dialog, so `findGit` takes that path only when `xcode-select -p` answers
(this Mac has the tools; not reproduced). And on Windows the trap scripts are POSIX `sh`, which
Git for Windows runs for hooks and filters — not run there yet.

## 148. A private chat is one env var away from saving everything, and its cleanup is one `includes` away from deleting someone else's files

**Built 2026-10-02 (the ghost button: a local Claude Code tab whose conversation is not kept and is
deleted when the tab closes).** Two things decide whether that promise holds, and neither is visible
from the tab.

**What turns saving off.** Read out of the installed 2.1.287 binary, never run: the documented
`--no-session-persistence` is refused outside `-p` ("can only be used with --print mode"), and
`cleanupPeriodDays: 0` is refused too. The interactive switch is the ENV VAR
`CLAUDE_CODE_SKIP_PROMPT_HISTORY`: the persistence predicate `eln()` returns `skip_prompt_history`
for it (after the print flag, before the gotcha 1 nested marker), every transcript writer starts
with `shouldSkipPersistence(){return Ha()||…}`, and the prompt-history writer returns early on it.
The TUI pins its own line, "Transcript saving is off — CLAUDE_CODE_SKIP_PROMPT_HISTORY is set".
It is NOT documented as a privacy switch, so `PRIVATE_ENV` (shared/privateChat.ts) also sets
`CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and
`CLAUDE_CODE_DISABLE_AGENT_VIEW` — the last because the daemon hand-off scrubs the skip variable
from the env it passes on, so a chat sent to `/background` would start saving again — and pty.ts
applies them LAST, after the provider or account env. The settings half (`PRIVATE_SETTINGS`: plans
inside the folder, auto-memory and remote control off) joins Stoke's one `--settings` file (gotcha
2). If a release ever stops honouring the variable, the transcript appears under the chat's own
`projects/<slug>`, and the watchdog (`PrivateChats.scan`, every 5 s) turns the strip into a warning;
the close deletes it with the rest.

**What is deleted.** Only paths `privateCleanupTargets` builds by exact join from a uuid-validated
id, the chat's own slug and a config dir main named at launch (the default and an account's), each
removed only after its parent's REALPATH resolves inside an allowed base (`cleanupAllowed`) — never
"whatever is in the folder". The marker naming them is written before the folder exists and removed
last, so a crash leaves nothing the boot sweep cannot find, and a folder under the root with no
marker is never touched. A `/clear` successor joins the delete set (the marker is rewritten); an id
the chat `/resume`d INTO whose transcript lives under another folder is `foreign` and never joins —
its file-history and session-env are a real conversation's. Files named for a session
(`telemetry/1p_failed_events.<session>.<event uuid>.json`, `todos/<session>-agent-<agent>.json`)
belong to the FIRST uuid in the name: verify:private's own fixture caught the first cut matching
`name.includes(id)`, which deleted another session's telemetry file because its random event uuid was
one of the chat's ids. Cleanup runs from the pty's own exit (`subscribeExit`), never from the kill
that asked for it; a quit removes only the folders (`quitSync`) and leaves the markers to the sweep.

Proven in the built app on 2026-10-02 against a stub `claude` that mirrors the predicate and writes
where the real CLI does under the `CLAUDE_CONFIG_DIR` it was given (`/tmp/f-private/stub.mjs`): the
four variables and seven settings keys arrived; a private chat wrote no transcript and no
`history.jsonl` line while a Scratch tab beside it wrote both; its hook events carried no reply or
transcript path; `tabs.json`, the sidebar, the launcher, the phone's `/api/sessions` and its
`/ws` attach never saw it; its OS notification was titled "Private chat" with the body "Finished."; Cmd+W on an idle empty
chat closed at once, a chat with a file or a running turn asked "Delete this private chat?"; a
`/clear` then a forced leak were both deleted at `/exit`; a resume into a saved chat left that chat
whole; a quit left markers only, and the next boot swept them. Every check in verify:private was
mutated back to red. **Not proven:** the real CLI honouring the variable (only its binary was read),
subagents, `/compact`, plan mode and a pasted image with saving off, the trust prompt on a machine
whose home is not trusted, and Windows.

> **Checked against the code on 2026-10-02 (a review of the private chat).** Three holes in the
> cleanup and one in the chord, each shown red by its suite case or measured in the built app:
> - **"No transcript found" was also what a FAILED lookup said.** The rebind looked the new id up
>   through `findSessionFile`, which answers null for a folder it could not read and for a
>   `pathExists` past its deadline (gotcha 40's "briefly wrong rather than late"), and the rebind
>   caught any throw as null too. Null is `adopt`, so a `/resume` into a saved conversation on a
>   slow or unreadable disk joined the delete set, and the close took that conversation's
>   `file-history` checkpoints, `session-env`, `image-cache` and telemetry. The lookup is
>   `findTranscriptStrict` now (rejects unless every `projects` folder was listed and every stat
>   said ENOENT/ENOTDIR), a reject or the deadline is `unsure` (`privateRebindVerdict`), and an
>   unsure id is looked at again by the watchdog and the close and never adopted on a guess.
> - **The marker went even when a removal failed.** A folder a process still holds (Windows
>   refuses to remove one), a permission, a tree past the 4 s deadline: the target stayed and the
>   only list naming it was deleted, so no sweep could ever find it. `cleanup` keeps the marker when
>   anything but absence or a refusal by containment stops a removal. Driven: `session-env` made
>   0500, the close left the marker and logged "the next start tries again", and the next start
>   swept it.
> - **A close during a rebind's lookup** listed its targets before the `/clear` id joined them and
>   then had its marker rewritten after it was removed. `finish` waits for pending rebinds (`pending`).
> - **A held ⇧⌘N started one `claude` per key repeat**: `startPrivate`'s claim is released once a
>   chat has started, so it guards a double click, not a held key. Measured on the built app with
>   one second of synthetic repeats at 33 ms: 30 private chats; with `e.repeat` refused, 1.
>
> And the strip's disclosure was an ellipsis: the SSH offer's one-line style cut "Anthropic still
> receives what you send" first (661 px of text in 622 px with the docked browser open). It wraps.

## 156. A search over raw rows answers yes or no for any prefix of a secret, however its snippets are redacted

**Found 2026-10-03, joining the three halves of cross-machine chats (spec 2026-10-03).** The relay's
`/api/chats/search` route lets another of the owner's computers search this one's chat index. The
obvious wiring is the index's own `search`, with every snippet, title and message passed through
`redactSecrets` on the way out — and the snippets come out clean. It still leaks: the index's
local `search`/`open` follow THIS computer's "Leave out anything that looks like an API key"
setting, so with it off (or for a chat stored before it went on, or under an older rule set) the
FTS rows hold the key as typed. A query for `sk-ant-api03-a` either finds a chat or does not, and
the guest walks the key one character at a time from hit counts alone (reasoned from the route's
shape; no such walk was run); a snippet can also start part-way through a key, where no pattern
recognises what is left of it. The phone and a local
viewer never had this exposure, since they are the owner on their own computer.

The rule: **what leaves the computer is searched and read only through the index's CLEANED
reads** — `ChatIndexHost.searchCleaned` (rows whose `redact_level` is today's `REDACTION_VERSION`
only; a raw row is left out, never redacted on the way out) and `openCleaned` (the tool's file
re-read with redaction forced, the stored copy only if it was cleaned) — whatever the local setting
says. `chatIndexForGuests` (index.ts) hands `sharedChats` those two and nothing else, and
`chatShare.ts` still runs `redactSecrets` over every string as a second belt. A raw row becomes
searchable from elsewhere once a pass with redaction on cleans it in place (`recleanStale`).

Held by `verify:chat-sources` (the cleaned-only filter, the level that only drops on a write, the
in-place clean; each mutated red by the builder) and `verify:remote` (the seam's text: `searchCleaned`
and `openCleaned`, never `chatHost().search(`/`.open(`; mutated to `search` and it went red).
Driven end to end the same day: a headless host with a real index over a scratch HOME holding a
chat with an `sk-ant-api03-…` key, a local hub, and the built app as the guest — the sidebar's
"On Studio" hit and the viewer showed `QUOKKA_KEY=[redacted]`, and the key's canary was in no
byte of the guest's page.
