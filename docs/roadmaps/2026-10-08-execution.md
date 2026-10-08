# Stoke implementation record

The [product roadmap](2026-10-08-product-roadmap.md) defines the requested scope. This record distinguishes implemented behavior from remaining work and live verification.

## Agent access controls (added to the request)

Implemented: Settings › Agents › Default access and a launcher control for supported non-Claude agents. Codex has read-only, workspace, full access with approval on request, and explicit YOLO. Cursor, Grok, Gemini, Qwen, OpenCode, Kilo, Copilot, Kimi and Aider use their documented permission flags with descriptions specific to each CLI. Claude retains its existing permission controls.

Launches record the actual mode. Resume, restart and stored tabs retain it; old non-Claude tabs resume on the agent's own default. Unsupported overrides are refused. These controls change CLI behavior and do not grant OS administrator privileges.

Validation: focused agent, settings-search and restore suites, typecheck, and the full `npm run check` gate pass (build included). An isolated macOS test instance starts. Visual verification is pending: the computer-use tool denied access to the Electron test application. No live permission-bypassing agent task was executed.

## Remaining implementation

Implemented: reconnect snapshots preserve reading positions on phone and desktop relay views; managed SSH bookmarks follow the remote shell across PTY replacement. All viewers and the host screen mirror now share Unicode grapheme widths. Phone reconnects recover closed links immediately on network return and replace potentially stale OPEN sockets after background suspension. Remote panes support the local terminal's macOS Option/Shift selection gestures. The remote regression suite and full gate pass; actual phone and SSH drop/sleep/wake proof remains pending.

All roadmap waves remain open. The existing baseline passes the full repository gate. No requested remote, scratch, search, plugin, Notion, privilege-helper or terminal-companion feature is claimed complete by this record.
