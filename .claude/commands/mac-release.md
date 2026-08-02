---
description: Build, verify and fix Stoke on an Apple Silicon Mac
---

# Bring Stoke up on this Mac

Stoke was built and verified entirely on Windows. Every macOS code path is written but has
**never been executed**. Your job is to build it here, exercise the Mac-specific paths, fix
what is broken, and record what you found.

Read `CLAUDE.md` and `ARCHITECTURE.md` first — they carry the conventions and the list of
bugs already found, so you do not rediscover them.

## 1. Build it

```bash
npm install          # do NOT copy node_modules from Windows; the node-pty prebuild is per-platform
npm run check        # typecheck + context tests + build. Must pass before going further.
npm run dist:mac     # arm64 dmg -> release/
```

If electron-builder fails hunting for a signing certificate, retry with
`CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac`.

Install the dmg. If macOS refuses to open the app:

- *"Stoke is damaged and can't be opened"* — Apple Silicon will not launch an arm64 binary
  with a missing or broken signature. Ad-hoc sign it, which is free and needs no developer
  account: `codesign --force --deep --sign - /Applications/Stoke.app`
- *"developer cannot be verified"* — `xattr -cr /Applications/Stoke.app`, or right-click →
  Open once.

## 2. Exercise the Mac-specific paths

These have never run. Check each and report what actually happened.

1. **Window chrome.** `frame: true` + `titleBarStyle: 'hiddenInset'` + traffic-light padding
   (`src/main/index.ts`, and `.titlebar[data-platform='darwin']` in `app.css`, which reserves
   4.875rem). Confirm the traffic lights do not overlap the sidebar toggle or the tabs, and
   that the title bar is still draggable.

2. **Finding the CLI.** `src/main/cli.ts` probes the login shell for PATH because a GUI app
   launched from Finder does not inherit it. **Test by launching Stoke from Finder or the
   Dock, not from a terminal** — launching from a terminal hides exactly the bug this guards
   against. Confirm a session starts.

3. **Keyboard shortcuts.** `src/renderer/src/lib/shortcuts.ts` uses Cmd on macOS and
   Ctrl+Shift elsewhere. Verify Cmd+K, Cmd+T, Cmd+W, Cmd+B, Cmd+, and Cmd+1..9, and that they
   do **not** leak into the terminal as keystrokes.

4. **Terminal clipboard.** Cmd+C with a selection should copy; with no selection Ctrl+C must
   still send SIGINT. Cmd+V should paste into the PTY.

5. **The docked browser.** Open it, check tabs, find-on-page (Cmd+F — it is intercepted in the
   page view via `before-input-event`), and devtools.

6. **Browser tools from a session.** Start a session and ask Claude to use the stoke browser
   tools to open a page and report its title. This proves `--mcp-config` injection works here.

7. **Remote access.** Turn it on in Settings and load the URL on a phone or another browser.

## 3. Fix what breaks

Fix it properly rather than papering over it, keep the conventions in `CLAUDE.md` (explicit
`.ts` extensions in `src/main`, no TS parameter properties, colour only via CSS custom
properties), and make sure `npm run check` still passes on both platforms — do not break
Windows to fix macOS.

Verify by running the app, not by reasoning about it. Launch with
`--remote-debugging-port=9222` and drive it over CDP if you need to confirm what rendered;
`npm run check` alone will not catch this class of bug.

## 4. Record it

Update the verification table in `PLAN.md` with what you tested and the result, replacing the
"Not verified: macOS" note. Add anything surprising to the gotchas list in `CLAUDE.md`.
Commit with a message explaining what was actually broken and why.
