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
