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

## Guided MCP credentials

Implemented: Settings › Agents › Tools (MCP) now adds and edits Stoke-held HTTP endpoints and local commands, with argument fields, masked environment/header values and a bearer-token field. Existing vault paths seal credentials. Each agent keeps its own server selection; removing a held server removes its stale selections across agents. Native agent configurations and OAuth sessions remain owned by their agents.

An explicit connection test starts a local command or connects to the entered endpoint, initializes MCP and lists tools without invoking them. It bounds time and response size, closes the test session, refuses redirects and returns credential-free errors. Embedded URL credentials and query parameters are refused in this guided editor. Windows batch-shim tests refuse shell syntax and explain the executable/Node-entry alternative.

Validation: focused agent, secret-store and settings-search suites, typecheck and the full `npm run check` gate pass (desktop and remote builds included). Real local HTTP and stdio mock servers exercise authentication, credential echoes, redirects, denied access, timeouts, oversized responses and missing executables. Visual verification remains pending.

## Installer fire

Implemented: the shared animation clock slows from 125 ms to 180 ms per frame. Every stage now varies its lower flame rows, while the two hearth rows remain identical. Download progress still chooses the stage; no animation-only wait was added. The shell and PowerShell blocks are regenerated from the shared source.

Validation: all twelve plain frames were inspected before updating the four color-tier snapshots. The focused campfire and installer suites and the full `npm run check` gate pass. The actual POSIX shell harness reproduces the art byte for byte. Native terminal recordings and a real Windows console run remain pending.

## Native agent updates

Implemented: non-Claude agent pages inspect the installed executable and version, identify a verified native updater or the owning npm/Homebrew prefix, and show the exact update command. An explicit update rechecks the reviewed path/version, serializes updates and refuses active local sessions or pending launches/sign-ins. Other agents can keep running. The launch guard remains claimed through asynchronous preparation and PTY creation.

The updater probes the installed version afterward and distinguishes changed, unchanged, failed and unverified outcomes. It never restarts sessions, guesses an unknown updater or inherits running agents’ provider keys. Unknown installers remain actionable through their original package manager. Claude Code keeps its existing channel-aware updater.

Validation: installation fixtures cover native, npm and Homebrew ownership, mismatched prefixes, no-op/failing/unverifiable updates and concurrent launch claims. A real Node subprocess emulates an update and subsequent version probe; another proves timeout reporting. Read-only inspection on this Mac correctly recognizes Codex 0.161.0 as a native install and OpenCode 1.18.34 as Homebrew-owned. No real agent installation was updated. The full `npm run check` gate passes, including desktop and remote builds. Live vendor updates, Windows installer ownership and visual verification remain open. Live model/context/usage adapters are the next part of R17.

## Phone file transfers

Implemented: a phone session’s options offer file sending with destination, progress, cancel, retry and a verified-path insertion button. Local uploads stream into unique owner-only folders in that session’s working folder; existing files are never overwritten. SSH uploads stream through the existing second-connection uploader to the session’s configured execution host and honor that host’s upload opt-out. A local file browser downloads visible regular files as attachments, confined by realpath to the live session’s working folder. Files have a 100 MB cap. Stopping Phone access aborts active operations.

The key, Access gate and browser-origin check protect the binary routes. Private, ended, sign-in and enrollment sessions cannot expose a folder. Operations are bounded to two globally and one per session. Interrupted uploads do not publish a complete path. A lost reply is shown as uncertain; retries require an explicit press and can create a second copy.

Validation: typecheck, the focused remote/phone UI suites and the full `npm run check` gate pass, including desktop and remote builds. Tests stream Unicode-named and empty files, compare bytes, protect bystander files, reject wrong sizes, cancellation, duplicate claims, traversal, symlink escapes and opted-out SSH hosts. The production HTTP router runs against isolated PTYs and a stub Electron shell; real requests verify auth/origin, attachments, exact bytes and interrupted-body cleanup. SSH forwarding is emulated here; the existing SSH suite exercises its shell uploader. Real phone use, Mac/Linux SSH transfer proof, SSH downloads, folders and encrypted desktop relay transfers remain open.

## Account usage and model labels

Implemented: usage results name the agent/account they answer for. Switching tabs immediately hides a previous account’s figures, and late replies cannot select the wrong account. An agent with no readable source shows an explicit unavailable state, with its own agent/account name and color; the chip no longer falls back to Claude’s quotas. Remote and SSH sessions show their own status readings without a local quota chip. The panel can still show every supported account’s separately labeled readings and freshness. Existing account nicknames remain separate from discovered Claude sign-in emails.

Model labels distinguish a requested model from one Claude’s status line or transcript has actually reported. Other agents currently show “configured” until a live adapter can prove their active model.

Validation: typecheck, the focused usage/agent suites and the full `npm run check` gate pass, including desktop and remote builds. Fixtures cover account switches, late replies, unsupported agents and shared OpenRouter routing. This is not a new quota source for Grok/Cursor or a live model/context adapter. Launch-source binding is implemented in the follow-up below. [Official Codex authentication docs](https://learn.chatgpt.com/docs/auth) and local `codex login --help` confirm file/keyring/auto/ephemeral stores and command-line overrides. No credential store, sign-in or token was changed during this inspection; concurrent real-account proof remains open.

## Native macOS build

Built the ARM64 DMG and ZIP at commit `e91f894`, without a version bump, release or install over the running copy. `npm run dist:mac` succeeds. The packaged PTY is `@lydell/node-pty-darwin-arm64`, the cookie-encryption and RunAsNode fuses pass, and `codesign --verify --strict --deep` succeeds with `Authority=Stoke`. Notarization was skipped because notarization options were not configured. Artifacts: `release/Stoke-1.0.0-beta.3-arm64.dmg` and `.zip`. This build includes the Work boards, Notion connector, Sonnet proposals, quick terminal, footer simplification, captured usage bindings and PTY cleanup. It predates reviewed Work session excerpts.

## Work plugin: local task and daily boards

Implemented: an opt-in built-in Work module with a versioned manifest, declared capabilities, durable module-owned state and cleanup. The Activity dock gains a Work boards view; Settings › Worklog gains its enable switch and boards. Tasks follow Idea → Approved → Working → Completed. Approval does not execute an agent or publish externally. Starting can associate the current ordinary local session. Completion requires evidence and updates or creates the selected day’s related entry. A task can span several days; past entries retain their historical state. Unplanned work has no invented backlog task. Local day and timezone are recorded independently from timestamps.

Async owner-only atomic storage serializes mutations before any await, bounds queue size and I/O time, and rejects stale record revisions. Renderer drafts retain the revision they opened, so a background update cannot silently turn an old draft into a current write. Disabling keeps records and blocks board changes. The existing Worklog settings, connector review flow, accepted URLs and rejection tombstones remain separate and unchanged for now.

Validation: the focused Work suite passes approval/start rules, linked multi-day completion, Unicode, unplanned entries, revision conflicts, simultaneous saves, disk reloads, reply isolation, corrupt/future store refusal and preservation of legacy queue bytes. Typecheck, Settings search verification and the full `npm run check` gate pass, including desktop and remote builds. Native visual verification remains pending.

## Work plugin: direct Notion connection

Implemented: schema inspection and mapping for separate Tasks and Daily work data sources, with existing status options, Stoke identity text fields, completion evidence, project, date and task relation. The token is encrypted through the protected system key store in module-owned storage; existing token values never reach the renderer. An unprotected Linux key store is refused. Each publish previews saved records and validates their captured revisions. Approval to start work remains separate from approval to publish.

Every write has a durable journal attempt. Partial operations resume without recreating the first table's row. Unknown creates survive restart and only retry lookup; an empty lookup cannot prove absence and never triggers a second create. External synced fields merge against separate local and remote baselines. Same-field conflicts show both versions and reread Notion before accepting a choice. Newer local drafts survive late replies. Import receipts recover the gap between journal confirmation and local import. Disabling Work aborts in-flight requests and retains the recovery journal; disconnecting removes the token while retaining records.

Validation: the loopback API suite exercises real HTTP, the production coordinator, encrypted test credentials and atomic disk stores. It covers schema/type/status mapping, Unicode limits, identity, bystander properties, external field merges, both conflict choices, changes during conflict review, stale previews, concurrent publish claims, disable during an uncertain write, lost create replies across restart, empty retry lookups, partial task/daily writes, evidence-free completion, redacted errors, redirects, request deadlines, corrupt journals and Linux key-store refusal. Typecheck, Settings search verification and the full `npm run check` gate pass, including desktop and remote builds.

The API contract was checked against [Notion versioning](https://developers.notion.com/reference/versioning), [data-source queries](https://developers.notion.com/reference/query-a-data-source), [page creation](https://developers.notion.com/reference/post-page) and [page updates](https://developers.notion.com/reference/patch-page). Requests pin version 2026-03-11. No real Notion workspace or user credential was used. External edits are read during publish/retry; standalone refresh and imports of unrelated rows remain open. There is no atomic compare-and-swap across the final GET and PATCH, so an external edit in that interval can still race. Legacy review extraction and native visual proof remain open.

## Work plugin: Sonnet proposals

Implemented: explicit Sonnet drafting for saved idea briefs, daily summaries and completion evidence from supplied source notes. Runs use the configured Claude provider/default Claude sign-in, a neutral directory, safe mode, no MCP, no built-in tools and a $1 CLI budget. The CLI checks its budget after a turn, so it can exceed that figure. Each proposal, its captured record revisions and reported cost are stored durably. Generation changes no board fields. Interrupted runs never resume automatically.

Accepting a proposal applies only the selected local action: edit an Idea, summarize a daily entry while preserving its status/evidence, or complete unfinished work with evidence. Model-supplied status and command fields cannot choose actions. Completion checks both the task and related day. Atomic acceptance receipts protect newer edits after a lost reply or restart. Pending acceptances block another draft for the same record. Discarding changes no board fields; publishing remains a separate Notion review. Cancellation and disabling retain ownership until the owned CLI exits; POSIX children that ignore SIGTERM are forced after two seconds. Windows uses an owned-tree termination command, still needing native Windows proof.

Validation: the focused suite covers separate generation/acceptance, rejected model actions, receipt recovery over a later edit, stale record/day refusals, summaries, completion, budget exhaustion, malformed output, simultaneous generation, disabling, interrupted-run recovery and discard. A real synthetic Node CLI subprocess proves exact argv, Unicode stdin, an empty tool set, empty MCP, budget flags, cancellation and deadlines through process close and refusal before spawn. No real model call or paid drafting run was performed. Typecheck, Settings search and the full `npm run check` gate pass, including desktop and remote builds. Native visual proof and automatic session-digest input remain open; reviewed session excerpts are described below. The existing Worklog transcript scanner remains separate.

## Remaining implementation

Every roadmap wave still has open acceptance criteria. SSH downloads and relay transfers, live agent telemetry, remaining Work plugin lifecycle and automatic session digests, privilege helpers and the terminal companion are still to be implemented. Live verification and platform-specific proof remain open where called out above.

## CI portability follow-up

The Linux gate passes on commit `c4682c0`; the Work drafting subprocess suite also passes in the macOS and Windows verification jobs. The non-gating Windows verification found an MCP missing-executable diagnostic flattened by the SDK; path-based commands now get an asynchronous preflight before transport creation. The macOS file-transfer test reached its next assertion before the previous download released its cleanup claim; it now waits for the production router to report availability, keeping the production claim intact. The full local gate passes with both corrections and an added real subprocess deadline check. Windows ARM64 continued-session process discovery still has three failing packaged-probe assertions and remains open.

## Optional quick terminal

Implemented: an off-by-default local shell with a singleton Terminal item in the editable top bar. Adding that item explicitly enables the feature. Appearance settings can disable it. Explicit Open starts the ordinary platform login shell in the current local folder, falling back to home for remote/private views. The side panel and native pop-out keep one PTY and its screen mirror; hiding either view retains commands. End shell has a concrete stop prompt, and New shell is explicit after exit. Enabling, reading settings and restarting Stoke never launch it automatically. Closing the main window or disabling ends the owned shell.

The shell has its own IPC channels and is absent from agent/session history, Work, phone access and relay sharing. It inherits the OS environment with wrapper/runtime markers removed; Stoke injects no selected provider keys or agent configuration. Both IPC sender and main-frame identity are checked. Only the current view can send input or resize, and stale shell IDs are refused. The pop-out preload exposes only terminal actions, clipboard and public appearance; it has no agent, settings or credentials bridge. Narrow title bars retain Terminal in the action overflow. A sibling panel remains visible beside the native browser. Search, copy/paste and grapheme widths use the existing terminal libraries.

Validation: the focused suite runs actual native PTYs in isolated folders and verifies real command-created files, canonical Unicode cwd, same-shell transfers, inactive-view input/resize refusal, explicit restart, disable while preparing, snapshot boundaries and environment markers. A real POSIX shell that ignores HUP retains its ownership through the two-second grace period and is forced only afterward. The full local gate passes, including typecheck, all verify suites and desktop/remote builds. CI at `e91f894` also passes the native suite on Windows and Linux, including transport cleanup. Native visual handoff and real detached-job behavior remain open. The signed ARM64 Mac package includes this change (see Native macOS build).

## Desktop footer simplification

Removed bottom-right usage and context meters, retaining the title-bar usage control, tab context indicators, message count, activity, model and update controls. No quota source or telemetry contract was removed. The full local gate passes.

## Windows continued-session discovery

Replaced the slow Windows CIM/WMI process-table query with a read-only Toolhelp kernel snapshot. The helper chooses the native buffer size and parent offset for its reader’s bitness, closes its snapshot handle and frees its buffer in a finally block, and prints PID/parent PID pairs only. The existing five-second deadline and refusal to match a folder without proven ancestry remain intact. The packaged probe now reports the exact production query rather than a separate sixty-second CIM diagnostic. The native registry suite creates its own real Node child and verifies the production snapshot identifies that parent on every OS.

The API structure and handle lifecycle were checked against Microsoft’s [PROCESSENTRY32W](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w) and [snapshot documentation](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot). The full local gate passes; native Windows and ARM64 CI proof is pending. This is a read-only query with no elevation or process control.

CI at `2a157cd` passes the Linux gate, Mac verification and packaged Mac ARM64/Intel, Windows x64 and Linux probes. Windows ARM64 retains the known continued-session failure that this follow-up addresses. The preceding Linux encryption test had a random-ciphertext false positive on the three-letter word “Fix”; that assertion now checks whole encoded project/title values, alongside the existing tamper, wrong-key, wrong-context and schema checks. Windows verification for the quick terminal was still running when this entry was written.

The `cdfd999` ARM64 packaged diagnostic still timed out at 5,028 ms with no rows. Runtime `Add-Type` compilation remained on that path. The follow-up emits the four native declarations directly in memory through documented [Reflection.Emit](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.emit.typebuilder.definepinvokemethod), without a compiler child, generated file, elevation or longer polling deadline. Native Windows/ARM64 proof remains pending.

## Windows PTY transport cleanup

The `cdfd999` Windows verification passed every quick-terminal assertion, then stayed alive after the final tally until the next push cancelled it. Inspection of the pinned `@lydell/node-pty` 1.2.0-beta.14 distribution shows that natural ConPTY exit leaves its input pipe and output worker referenced. A narrow compatibility shim now releases those two transports from the exact terminal object after its exit event, for both ordinary sessions and the quick terminal. It performs no PID-based process control after exit. The native terminal suite reports success only when Node reaches `beforeExit`; a leak fails after five seconds instead of hanging CI. The focused native Mac suite, typecheck and full local gate pass. Windows CI at `e91f894` confirms all native quick-terminal assertions and clean process exit. That Windows verification job still fails the separate process-snapshot assertions; ARM64 and x64 packaged probes also fail continued-session discovery. The ARM64 snapshot exits in 419 ms with no rows, so compiler startup is no longer the observed failure. The next probe prints the snapshot error to diagnose it.

## Usage follows the running session

Implemented: each ordinary local PTY captures its source, provider key and credential locations from its launch configuration in main-process memory. Changing Providers, account homes or defaults cannot redirect an existing session’s usage read. Per-configuration opaque cache identities keep request floors, backoff and readings separate when two live sessions use different keys. Late replies preserve the selected configuration’s figures. Bindings are released on PTY exit and window close; credentials are not written to tab metadata or sent to the renderer.

Message-triggered refreshes and remote status use the same captured source. Status-line quota data is admitted only for a proven native Anthropic source; API keys, custom gateways and inherited auth overrides cannot borrow subscription figures. Default Claude credential locations include inherited config-directory and Mac secure-store overrides. Only environment fields needed by a vendor’s usage reader are retained.

Validation: fixtures cover source/key changes during live sessions, account and PTY identity, opaque cache separation, same-source request floors, late replies, captured credential file/Keychain locations, inherited credentials, unknown sources and cleanup. An isolated real credential-file read proves that a captured location survives a later home selection. The full local gate passes, including desktop and remote builds. No live provider request was made. Native credential stores are reread for freshness; detecting a sign-in changed outside Stoke, Codex keyring isolation and concurrent real-account proof remain open. The Mac package at `e91f894` includes this follow-up.

## Work plugin: reviewed session excerpts

Implemented: an explicit read of the current ordinary local Claude conversation from Sonnet drafts. The exact live PTY must still own the requested session. Private, remote, ended, setup and other-agent sessions are refused. A bounded recent JSONL tail supplies complete user/assistant text only, with forced secret redaction; tool input/output, reasoning, metadata and sidechains are excluded. A read-only preview shows its source, capture time and shortening. Choosing to use it replaces source notes; drafting with Sonnet and accepting a proposal remain separate actions. Reading changes no transcript or board and starts no model call.

Late replies are refused after session, selection or record revision changes. Disabling Work blocks delivery. A timed-out read retains its claim until actual I/O settles. The focused suite uses isolated real transcript files to cover admission, Unicode tail boundaries, redaction, unchanged bytes, symlink refusal, owner changes, disabling, simultaneous reads and timeout ownership. Typecheck and the full `npm run check` gate pass, including the new suite and desktop/remote builds. No real user conversation or paid model call was used; native visual verification remains pending.
