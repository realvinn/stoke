# Stoke implementation record

The [product roadmap](2026-10-08-product-roadmap.md) defines the requested scope. This record distinguishes implemented behavior from remaining work and live verification.

## Agent access controls (added to the request)

Implemented: Settings › Agents › Default access and a launcher control for supported non-Claude agents. Codex has read-only, workspace, full access with approval on request, and explicit YOLO. Cursor, Grok, Gemini, Qwen, OpenCode, Kilo, Copilot, Kimi and Aider use their documented permission flags with descriptions specific to each CLI. Claude retains its existing permission controls.

Launches record the actual mode. Resume, restart and stored tabs retain it; old non-Claude tabs resume on the agent's own default. Unsupported overrides are refused. These controls change CLI behavior and do not grant OS administrator privileges.

Validation: focused agent, settings-search and restore suites, typecheck, and the full `npm run check` gate pass (build included). An isolated macOS test instance starts. Visual verification is pending: the computer-use tool denied access to the Electron test application. No live permission-bypassing agent task was executed.

## Remote and SSH reliability

Implemented: reconnect snapshots preserve reading positions on phone and desktop relay views; managed SSH bookmarks follow the remote shell across PTY replacement. All viewers and the host screen mirror now share Unicode grapheme widths. Phone reconnects recover closed links immediately on network return and replace potentially stale OPEN sockets after background suspension. Remote panes support the local terminal's macOS Option/Shift selection gestures. The remote regression suite and full gate pass; actual phone and SSH drop/sleep/wake proof remains pending.

## Scratch storage and names

Implemented: Settings › Sessions has a dedicated scratch location. Fresh installs use the OS home directory's `Stoke/Scratch`; existing settings retain the original app-data location until changed. Desktop and phone scratch creation use the same setting. Creation is asynchronous, bounded by a deadline, resolves symlinks and claims unique timestamped directories atomically. A small ownership marker identifies folders Stoke created.

Opt-in automatic naming uses the first meaningful Claude Code prompt or title as the sidebar label and preserves manual labels. It keeps the physical path stable. Moving or physically renaming an inactive scratchpad, and naming from other agents' transcripts, remain open.

Validation: settings migration, concurrent folder creation, non-ASCII paths, marker bounds and portable-settings partition checks pass. The full `npm run check` gate passes, including the desktop and remote builds. Visual verification remains pending for the reason above.

## Remaining implementation

Every roadmap wave still has open acceptance criteria. Advanced search, guided MCP credentials, remote transfers, agent updates, the Work/Notion plugin, privilege helpers and the terminal companion are still to be implemented. Live verification and platform-specific proof remain open where called out above.
