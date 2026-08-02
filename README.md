# Stoke

A desktop shell for Claude Code. One window for every project, every session, and
the browser — instead of a pile of terminals.

Stoke wraps the real `claude` CLI in a PTY rather than reimplementing it against the
SDK, so every Claude Code feature (skills, MCP, plugins, hooks, slash commands, the
whole TUI) works exactly as it does in a terminal.

Windows and macOS.

## What it does

- **Every project in one sidebar.** Reads the folders Claude Code already knows about
  from `~/.claude.json` and `~/.claude/projects`, grouped as Pinned / Recent / Other.
  Point it at a folder like `G:\Code\personal` and it also lists projects you have never
  opened in Claude yet.
- **Start without picking a project.** The launcher opens on a default folder
  (`G:\Code` on Windows, `~/Code` on macOS, configurable in Settings) — press Enter and
  you are in a session. **Scratch session** instead creates a dated throwaway folder for
  something you do not want landing in a real project. Turn on *Start a session on launch*
  in Settings and opening Stoke drops you straight into one.
- **Sessions as tabs.** Several live sessions at once, each its own PTY. Resume any past
  session with its full history, or continue the most recent one in a folder.
- **Context windows at a glance.** A ring on each tab and a bar in the status bar, read
  live from the session transcript. Turns amber at 70% and red at 90%.
- **Permissions on one control.** Ask / Plan / Edits / Auto / Bypass, switchable per
  session before launch, with the active mode always visible in the status bar.
- **A docked browser Claude shares.** A real Chromium view with tabs, find-in-page,
  bookmarks, zoom and devtools. Links clicked in the terminal open there — and Claude
  can drive the very same pane. See below.
- **Themes as plain CSS variables.** Four built in (Ember, Nocturne, Moss, Daylight).
  Add your own to `customThemes` in `settings.json` and it appears in the picker.

## Running it

```bash
npm install
npm run dev          # live-reload development
npm run check        # typecheck + context-meter tests + production build
```

Packaging:

```bash
npm run dist:win     # -> release/Stoke-0.1.0-x64-setup.exe
npm run dist:mac     # -> release/Stoke-0.1.0-arm64.dmg   (must run on a Mac)
```

`@lydell/node-pty` ships prebuilt N-API binaries for all six platform/arch targets, so
there is no native rebuild step on either OS. Do not copy `node_modules` between machines,
though — run `npm install` on each, or the Mac ends up with a Windows-only PTY binary.

**macOS packages can only be built on macOS.** Windows can emit Windows and Linux
packages; a Mac can emit all three. See [BUILDING.md](BUILDING.md) for the M1 walkthrough
and the Gatekeeper fixes an unsigned personal build needs.

## Keyboard

Shortcuts deliberately avoid the keys Claude Code's own prompt uses. macOS takes `Cmd`,
which terminal programs leave alone; Windows and Linux need `Shift` as well, because bare
`Ctrl+K` / `Ctrl+W` / `Ctrl+T` are readline bindings the TUI relies on.

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Find a project | `Cmd K` | `Ctrl Shift K` |
| New session | `Cmd T` | `Ctrl Shift T` |
| Close session | `Cmd W` | `Ctrl Shift W` |
| Toggle browser | `Cmd B` | `Ctrl Shift B` |
| Settings | `Cmd ,` | `Ctrl Shift ,` |
| Jump to tab *n* | `Cmd 1…9` | `Ctrl 1…9` |

Copy and paste inside the terminal use the platform's normal keys. With no selection,
`Ctrl+C` still sends SIGINT.

## How it reads Claude Code's state

Everything comes from files Claude Code already writes; Stoke never modifies them.

- `~/.claude.json` → the `projects` map, for known folders and their last activity.
  This file can contain keys differing only in case, so paths are compared case-folded.
- `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` → one JSON object per line.
  `ai-title` records supply session titles; `assistant` records supply model and usage.
- Context in use is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
  from the most recent assistant turn.

New sessions are launched with a `--session-id` that Stoke generates, so the transcript
path is known before the process starts and the meter can attach immediately.

**The context window cannot be inferred from the model id.** A session on the 1M tier
records its model as plain `claude-opus-5` — no `[1m]` suffix survives into the transcript
and no `context_window` field is written. Stoke therefore treats observed usage as the
authority: crossing 200k proves the extended tier. See `src/main/sessionFile.ts`.

## Claude drives the same browser you do

Stoke launches the CLI, so it injects `--mcp-config` at spawn time pointing at an MCP
server it runs in-process (loopback only, ephemeral port, per-run bearer token). Every
session gets browser tools automatically — nothing to install or configure.

The point is that it is *your* pane: same tabs, same cookies, same logins. Claude can read
a dashboard you are signed into, which a cold headless browser cannot, and you watch it
work and can take the wheel at any moment.

The tools are shaped for an agent rather than for a DOM:

| Tool | What it does |
| --- | --- |
| `browser_open` | Navigate, wait for the page to settle, return the heading outline and a token estimate |
| `browser_read` | Main content as markdown — nav and ads stripped, tables and code blocks intact. Scopes to a section or an element |
| `browser_outline` | Heading map, for skimming before reading |
| `browser_find` | Matching passages with their heading and nearest clickable ref |
| `browser_snapshot` | Visible interactive elements with short refs |
| `browser_click` / `_type` / `_select` | Act by ref, never a CSS selector |
| `browser_inspect` | Console and network, filterable to just the problems |
| `browser_screenshot` | Whole page or one element |
| `browser_changes` | What changed since the last read |

Two decisions do most of the work. **Actions return a diff, not the page** — after a click,
re-sending an entire page that is 95% identical is what makes browser agents expensive.
And **every read waits for the page to settle**, because reading a skeleton loader produces
confidently wrong answers rather than obviously wrong ones.

### Worth knowing before you use it

These tools go through Claude Code's normal permission system, so in **Bypass** mode Claude
can click and type in a browser holding your logged-in sessions, and a hostile page can
attempt prompt injection to steer that. The shared session is what makes this useful, and
it is also the risk. If that trade stops being worth it, the partition is a one-line change
in `src/main/browser.ts`.

## Layout

```
src/main/      index.ts   app lifecycle, window, IPC
               pty.ts     PTY sessions, environment sanitising
               cli.ts     locating claude, building its arguments
               projects.ts project + session discovery
               context.ts  live context-window watcher
               sessionFile.ts transcript parsing
               browser.ts  docked WebContentsView
               store.ts    settings persistence
src/preload/   contextBridge -> window.stoke
src/renderer/  React UI; all colour via CSS custom properties
src/shared/    types, IPC channel names, themes
scripts/       verify-context.mts — runs the meter against your real transcripts
```

## Verification

`npm run verify:context` parses your largest real transcripts and asserts the meter's
arithmetic, the window inference, and the live watcher path (session id → file → parsed
snapshot). It caught two genuine bugs during development; keep it passing.
