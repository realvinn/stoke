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

## Advanced history search

Implemented: an opt-in Settings › Chat history toggle exposes sidebar filters for local last-activity dates, source, model, folder, conversation span and reported context tokens. Filters apply in SQLite before the result limit, and also support browsing with an empty text query. Hidden projects are excluded before the limit. Activating filters shows this computer's indexed results without mixing in unfiltered project-title or remote hits.

Codex's latest timestamped `token_count` snapshot supplies context tokens; compaction can shrink it. This is explicitly labeled context, not lifetime usage or cost. Unknown metrics are excluded when their filter is used. Existing index data stays searchable through an in-place schema migration; rebuilding reads snapshots from older unchanged chats. Total billed tokens, cost, account attribution and active-work duration remain open.

Span is labeled an estimate because some source dates fall back to file timestamps, and it includes idle time.

Validation: the focused chat-index and settings-search suites, typecheck and the full `npm run check` gate pass (desktop and remote builds included). Tests cover a 23-hour Melbourne DST day, exclusive date ends, unknown versus zero metrics, filter-before-limit behavior, literal folder text, compacted snapshots and hidden projects. Visual verification remains pending.

## Remaining implementation

Every roadmap wave still has open acceptance criteria. Guided MCP credentials, remote transfers, agent updates, the Work/Notion plugin, privilege helpers and the terminal companion are still to be implemented. Live verification and platform-specific proof remain open where called out above.
