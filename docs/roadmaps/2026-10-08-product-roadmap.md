# Stoke product roadmap — 8 October 2026

Recommended order: fix remote and SSH reliability, improve everyday setup, finish account and agent visibility, extract Work into a plugin, then build privileged execution and a terminal companion.

This covers macOS, Windows and Linux. The terminal companion explicitly includes **macOS and Linux**. Platform-specific features use each OS's native behavior.

## Scope and evidence

This is a proposal, not an implementation report. Reviewed source: `windows-install` at `34165d4`, package version `1.0.0-beta.3`. “Exists” below means there is an implementation in that source; it does not establish that the installed release works on a real device. The reported scrolling, stability and menu problems have not been reproduced during this review. No application tests or live agent calls were run for this document.

The [previous roadmap](../../PLAN.md) records several completed waves and outstanding real-device checks. Some older documentation is stale: for example, the README still describes plaintext keys, while [the current secret registry](../../src/shared/secrets.ts) and [vault](../../src/main/secrets.ts) implement sealed secrets. Use current code as the baseline.

Priority: **P0** = daily regressions; **P1** = usability and missing extensions; **P2** = larger architectural additions. Size: **S** = localized change; **M** = several components; **L** = a new subsystem or substantial migration; **XL** = a new application surface. These are relative sizes, not delivery estimates. Reported bugs need reproduction before their size is dependable.

## Delivery order and coverage

| Wave | IDs | Outcome | Size |
| --- | --- | --- | --- |
| 1 — reliability | R01, R02, R12, R15 | Stable scrolling, attachment and reconnect behavior; smoother SSH; correct macOS menu reveal | M–L |
| 2 — everyday use | R04, R08, R09, R10, R16b | Accessible scratch storage, sensible names, useful search filters, easier coding workflow, better installer animation | S–M per item |
| 3 — tools and agents | R07, R11, R14, R17 | Clear file transfers, guided MCP credentials, proven account isolation, agent updates and accurate session information | M–L per item |
| 4 — Work plugin | R05, R06 | Optional task pipeline and daily board with direct Notion integration; a small extension contract | L |
| 5 — privileged execution | R03, R16a | Explicitly enabled admin operations on Windows and macOS; defined Linux root behavior | L |
| 6 — terminal companion | R13 | Stoke navigation, auth and sessions in a terminal on macOS and Linux | XL |

Each wave ships as focused changes. The installer animation can be done independently. Privileged execution research can begin earlier, but implementation depends on stable session identity and attachment rules. The terminal companion should reuse the account and session contracts completed in earlier waves.

## Wave 1: remote, SSH and macOS menu reliability

### R01 — scrolling across local, SSH and remote sessions · P0

**Baseline:** [TerminalView](../../src/renderer/src/components/TerminalView.tsx), [RemoteTerminal](../../src/renderer/src/components/RemoteTerminal.tsx) and [the phone terminal](../../src/remote/session.ts) have different rendering and replay paths. Desktop scrollback is configured at 20,000 lines; phone scrollback at 5,000. Managed SSH also reconstructs tmux history in [ssh.ts](../../src/main/ssh.ts), while [pty.ts](../../src/main/pty.ts) supplies terminal snapshots to attaching clients. Existing support does not explain the reported regression by itself.

**First change:** reproduce a matrix of local tabs, direct SSH tabs, desktop-to-desktop relay tabs and phone views of both local and SSH sessions. Include normal/alternate terminal buffers, mouse reporting, trackpad/wheel input, touch scrolling, selection, resize and reconnect.

**Desired behavior:** reading older output holds the viewport; new output follows only when already at the bottom; reconnect restores retained history without duplicating it; switching tabs keeps each viewport. When a CLI uses an alternate screen without recoverable history, explain the limit rather than manufacture missing output. Unify shared rules where the reproduction shows divergence.

**Done when:** a live SSH session watched from a Mac and a phone passes those cases under sustained output and after reconnect. Repeat desktop cases on Windows and Linux. Save the reproduction and regression test with the fix.

### R02 — remote stability · P0

**Baseline:** phone WebSockets and heartbeat cleanup exist in [remote/server.ts](../../src/main/remote/server.ts); cross-machine attachment uses the [hub client](../../src/renderer/src/lib/hubRemote.ts) and [remote terminal](../../src/renderer/src/components/RemoteTerminal.tsx). Size ownership is already modeled in [sizeClaim.ts](../../src/shared/sizeClaim.ts).

**Next:** distinguish “host asleep,” “connection lost,” “access refused,” “session ended” and “host restarted.” Audit reconnect backoff, stale subscriptions, snapshot/live-output ordering and size ownership across phone, relay and SSH paths. Reuse the existing mechanisms wherever they work.

**Done when:** Wi-Fi changes, phone background/foreground, Mac sleep/wake, tunnel interruptions and relay drops recover to the same still-running session. A host restart offers a resume of the conversation where supported; it must not claim the old process survived. Retrying cannot launch duplicate agents or silently replay uncertain command submissions.

### R12 — smoother SSH · P1, alongside reliability

**Baseline:** [sshEnroll.ts](../../src/main/sshEnroll.ts) supports key enrollment; [sshSessions.ts](../../src/main/sshSessions.ts), [ssh.ts](../../src/main/ssh.ts) and [HostsSettings](../../src/renderer/src/components/HostsSettings.tsx) support managed tmux sessions and host settings.

**Next:** one host setup flow: select/import the host, verify its identity, test login, offer key enrollment, check the remote agent and tmux, choose the remote folder and start. Show the host, folder, agent, account support and session persistence clearly. Explain whether closing a tab detaches or ends the remote process. Put actionable errors beside the failed step.

**Done when:** a fresh Mac can add a password-only Linux host, enroll a key, start an agent, disconnect, reattach and deliberately end it. Verify a macOS SSH host too. A host without tmux has an explicit fallback with its persistence limitation.

### R15 — macOS top menu timing · P0 · S after reproduction

**Baseline:** [fullScreenReveal.ts](../../src/shared/fullScreenReveal.ts) already addresses premature reveal and defines a 250 ms linger. [App.tsx](../../src/renderer/src/App.tsx) coordinates pointer events and shell position. The source records recent fixes to a very similar report.

**Next:** establish whether the installed build contains those fixes, then reproduce the remaining activation band on a real Mac. Check top corners, notched displays, another display, menu-bar auto-hide settings, tab dragging and open popovers. Adjust the triggering geometry or event logic according to the recording; a blanket extra delay may hide the symptom without fixing it.

**Done when:** Stoke moves when the native reveal actually covers its controls, and returns with it. Merely approaching the top edge must not open an empty menu slot. Extend [verify-fullscreen](../../scripts/verify-fullscreen.mts) and verify with an OS-level screen recording.

## Wave 2: everyday use

### R04 — scratchpad default location · P1 · S–M

**Baseline:** [workspace.ts](../../src/main/workspace.ts) creates persistent timestamped folders under `userData/scratch`. The no-project default working folder is a separate setting.

**Next:** add a dedicated Scratch location setting with Browse, Open folder and Restore default. Proposed fresh-install default: `~/Stoke/Scratch` on macOS/Linux and `%USERPROFILE%\Stoke\Scratch` on Windows. Resolve the user home through the OS, not a hardcoded username. Preserve the current location for existing installs and offer a deliberate move of inactive scratch folders.

**Done when:** folders survive restarts and upgrades, spaces/non-ASCII paths work, unwritable locations produce a useful error, and switching the setting cannot strand active sessions or lose existing files. The phone's scratch creation follows the host setting and its existing folder access rules.

### R08 — automatic scratch folder naming · P1 · M

**Next:** derive a short suggested name from the first meaningful prompt or known session title; show that as the scratchpad's display name. Offer actual folder rename or “Move to project” after the agent has stopped. Auto-naming is a setting, and a manual name wins.

**Why:** changing a running agent's working directory path can break file operations and transcript/resume lookup. Display names can improve the experience immediately. Physical rename needs a migration of Stoke's references and an explicit check of each agent's resume behavior.

**Done when:** duplicate names get unique paths, invalid filename characters are handled, manual names are preserved and a moved scratchpad can still be found and resumed. An unsuccessful move leaves the original intact.

### R09 — advanced search by date, duration and usage · P1 · M

**Baseline:** [the chat index](../../src/main/chatIndex/store.ts) stores creation/update timestamps and a model field, and supports text search. Its current search contract has no structured duration/token/cost filters. [Settings search](../../src/shared/settingsIndex.ts) finds preferences, which is a different feature.

**Next:** an Advanced settings toggle exposes richer **chat/session search** controls: date range first, then agent/project/model/account where indexed, then duration, tokens and cost where supported. Add structured filtering to the index before limiting results; filtering only the first page can omit matches.

**Definitions:** date can mean created or last activity; first-to-last message span is elapsed duration, not active work time. Label a creation/update-derived span as an estimate until message timestamps support it. Token counts and cost need source-specific metadata; missing values stay unknown. Active work time requires future activity instrumentation. Hiding advanced controls does not erase indexed data.

**Done when:** timezone boundaries are correct, unknown metrics have explicit filter behavior, and older/imported chats remain searchable. Start with dates rather than waiting for all providers to supply every metric.

### R10 — make vibecoding easier · P1 initially; extend with Work later · M

Build a clear path through existing capabilities: **idea → short brief → choose folder/agent/account/tools → run → preview → review changes and checks → keep as a project**.

The first increment should preflight the chosen CLI, account, working folder and required MCP credentials; explain missing setup in one place. Add project presets for launch choices, a quick action to open the app being built in Stoke's browser, and a review surface linking changed files and test results. Existing launch settings, [browser.ts](../../src/main/browser.ts) and [gitStatus.ts](../../src/main/gitStatus.ts) are starting points, not proof that the complete workflow exists.

Keep advanced switches available but out of the first-run path. Agent handoff should carry a user-reviewed brief, selected files and validation results, with provider/account selection explicit. Add isolated worktree sessions through a later plugin if users need parallel attempts.

**Done when:** someone can start with a scratch idea, reach a visible preview, inspect what changed and retain it as a project without guessing commands or losing the conversation.

### R16b — installer fire motion · P1 · S

**Baseline:** [campfire.ts](../../src/shared/campfire.ts) defines the shared art; [gen-installer-art.mts](../../scripts/gen-installer-art.mts) generates the shell and PowerShell blocks. The hearth is intentionally static.

**Next:** inspect a recording, slow the upper flicker and vary the lower flame rows more while keeping the hearth anchored. Check the animation clock separately from download progress so a fast download does not cause frantic stage changes. Preserve non-interactive output and cancellation behavior.

**Done when:** motion is readable in macOS/Linux terminals and Windows PowerShell, generated blocks match the source and installer duration is not artificially extended just to display animation. Use [verify-campfire](../../scripts/verify-campfire.mts) and [verify-install](../../scripts/verify-install.mts), plus recordings.

## Wave 3: files, tools, accounts and agent lifecycle

### R07 — sending files through remote · P1 · M–L

**Baseline:** desktop file/image upload to SSH already exists in [sshUpload.ts](../../src/main/sshUpload.ts) and [TerminalView](../../src/renderer/src/components/TerminalView.tsx), including streaming, progress and cancellation. It is separate from terminal input. That does not establish file transfer for phone access or the desktop relay.

**Next, separately:** improve the existing SSH send action and remote destination display; add SSH download; add phone-to-host upload/download; add desktop-to-desktop relay transfer. Start with individual files, then folders. Each path needs its own authorization and destination rules.

Show From, To, destination, progress, Cancel and Retry. Insert the remote path into the agent prompt only after a successful send. Use a binary transfer route with flow control rather than treating file contents as terminal keystrokes. For the relay, preserve the channel's authenticated encryption and device grants.

When a phone or relay client is viewing an SSH session, the destination must be that session's SSH execution host. Add an explicitly authorized forwarding path through the desktop host, and insert a path valid on the execution host. A successful upload to the desktop alone does not complete that transfer.

**Done when:** transfers work from a Mac to Linux and macOS SSH hosts; phone and relay transfers are verified independently. Test Unicode names, interrupted transfers, large files and denied destinations. Downloads cannot expose arbitrary host paths, and partial files cannot appear complete.

### R11 — guided auto-MCP setup and keys · P1 · M

**Baseline:** [mcpServers.ts](../../src/shared/mcpServers.ts) models stdio environment values, HTTP headers and bearer tokens; [mcpLaunch.ts](../../src/main/mcpLaunch.ts) adapts servers per agent. Those credential fields are already in the [secret registry](../../src/shared/secrets.ts). [AgentsSettings](../../src/renderer/src/components/AgentsSettings.tsx) exposes per-agent server selection, but not a complete credential wizard.

**Next:** Connect tool → choose a server recipe → enter required secrets or launch its supported login flow → Test connection → select agents/projects. Detect and name missing values such as `NOTION_TOKEN`; show masked values, Replace and Disconnect. Keep credentials referenced through the vault and resolve them in the process that needs them. Prefer headers/environment over credentials embedded in URLs; existing URL credentials need a migration story.

Auto-discovery should suggest relevant tools, with enablement and scope visible. Reuse the existing per-agent adapters. Each agent retains its own OAuth flow when required; copying another agent's MCP OAuth tokens is not the setup mechanism.

**Done when:** adding a token, replacing it, testing a refused connection and disabling a tool all work without editing JSON. Logs, prompts and generated command arguments do not expose secret values. Unsupported agents explain their capability limit.

### R14 — multiple named accounts and usage · P1 · M

**Baseline:** [accounts.ts](../../src/shared/accounts.ts), [account home preparation](../../src/main/accounts.ts) and [AgentAccounts](../../src/renderer/src/components/AgentsSettings.tsx) already support named accounts, editable labels, defaults and per-launch selection. [usageBoard.ts](../../src/main/usageBoard.ts) tracks sources per account. Current limitations matter:

| Requested provider | Current adapter | Next proof or extension |
| --- | --- | --- |
| Claude Code | Isolated login homes; per-account usage source | Two real logins concurrently on Mac and Windows; refresh/restart and correct history/account attribution |
| ChatGPT via Codex | Isolated `CODEX_HOME`; usage read from rollout files | Two real logins, supported credential-store modes, account switching and stale readings |
| Grok | Login-home and API-key accounts | Verify both auth paths; add usage only when the CLI or a supported API provides it |
| Cursor Agents | API-key accounts; no isolated browser-login accounts in Stoke's current table | Verify separate keys; research an isolated browser-login route before offering it |

This interprets “ChatGPT accounts” as accounts used by the Codex CLI. General ChatGPT website/app account management would be separate scope. Official OpenAI documentation describes file credentials under `CODEX_HOME` and alternative credential-store modes; isolation under every mode still needs testing. [OpenAI authentication](https://learn.chatgpt.com/docs/auth).

**Next:** make the nickname, signed-in identity and active account visible without overwriting a nickname with an email. Give every usage reading a source and freshness. Distinguish plan quota, session tokens and API spending. The current usage chip can fall back to Claude when a provider supplies no readable usage; prefer an explicit unavailable reading for the selected provider so its account cannot be mistaken for another's.

**Done when:** two accounts can run concurrently without switching each other's credentials, relaunch restores the recorded account, and usage follows that exact account. No automatic rotation to another account when a quota is reached. Recheck vendor behavior at implementation time; the capability table is evidence from this checkout, not a permanent vendor guarantee.

### R17 — native agent updates, live model and context information · P1 · L

**Baseline:** [updates.ts](../../src/main/updates.ts) implements the Claude updater and verifies version changes. [codingClis.ts](../../src/shared/codingClis.ts) defines other agents' detection/install/model capabilities. [session launch](../../src/main/index.ts) records requested models for other agents, but the live context watcher is Claude-specific. A requested model is not evidence that the CLI is still using it.

**Next:** add an agent lifecycle adapter with installed path/version, install method, update check/run and post-update verification. Respect the detected installation method: native installer, npm, Homebrew or another package manager. An update failure or unchanged version must be shown honestly. Existing sessions keep running until an explicit relaunch; a busy session offers Wait, Restart or Cancel.

Separately add per-agent telemetry adapters: active model first, context used/limit second, usage/cost where stated. Prefer structured events or files the agent provides; use terminal parsing only with versioned fixtures. Display “configured model” until an active model is observed, and unknown context until the agent states enough data. Do not infer an exact context window from a model name alone.

**Emulation:** extend [fake-agent.mjs](../../scripts/probe/fake-agent.mjs), [probe-clis.mts](../../scripts/probe-clis.mts) and focused fixtures for model switching, resume, malformed/missing telemetry, failed/no-op updates and relaunch while busy. Begin live adapters with Codex and OpenCode, then expand by confirmed capability. Emulation verifies Stoke's response to inputs; it does not prove a real vendor emits them or that an updater works.

**Done when:** a Mac proves a real update/relaunch and active model change for each claimed agent; Windows and Linux prove their own installation routes. Show a provider capability matrix with verified/partial/unavailable status. Refresh README/architecture descriptions alongside the completed features.

## Wave 4: an optional Work plugin

### R05 — Notion API, task pipeline and a daily board · P2 · L

**Baseline:** [worklog/runner.ts](../../src/main/worklog/runner.ts), [recall.ts](../../src/main/worklog/recall.ts), [queue.ts](../../src/main/worklog/queue.ts) and [WorklogSettings](../../src/renderer/src/components/WorklogSettings.tsx) already provide a Sonnet-based proposal/review flow for Notion/ClickUp. Destination writes currently use Claude connector tools. They are not a direct Notion API integration or the requested task scheduler.

**Proposed two linked tables:**

| Table | Purpose | States | Minimum fields |
| --- | --- | --- | --- |
| Tasks | Durable backlog and approval of work | Idea → Approved → Working → Completed | Stable ID, title, brief, project, status, assigned session, completion evidence |
| Daily work | Plans and activity for a specific day | To-Do → Working on → Completed | Stable ID, local date, task relation, daily status, notes, session/commit links |

Task completion keeps the original task and updates or creates the related daily entry. A long task can have several daily entries. Unplanned work can be logged without inventing an approved backlog item. This gives “what I did / am doing / plan to do today” without duplicating the durable task each morning.

**First version:** an opt-in Work panel with local task/daily records and direct Notion read/write adapters. Connect one internal integration token, select the two destinations, inspect their schemas and map their properties/statuses. Notion requires the relevant pages to be shared with the connection; public distribution can later use OAuth. [Notion authorization](https://developers.notion.com/guides/get-started/authorization).

Sonnet drafts task briefs, session summaries and proposed transitions through the existing capped runner. Deterministic plugin code validates and executes accepted API operations. Keep **approval to start a task** distinct from **approval to publish a proposed board change**. Starting Approved → Working requires a user start action in v1; marking Completed requires recorded evidence and an accepted transition. Automatic unattended task execution is a later decision.

Persist a write journal keyed by operation and destination record. Retries must reconcile unknown results before repeating a create. If one table write succeeds and the second fails, show the partial state and finish that same operation on retry. Local editing stays available offline; failed sync remains visible. Day boundaries use the user's timezone.

Proposed sync authority: once a record is linked, Notion owns its synchronized title, brief and status; Stoke keeps local session metadata and pending edits. Re-read external changes before applying a pending edit. Conflicting field edits go back to review instead of silently overwriting either version. Offline drafts remain editable until their destination write is confirmed.

**Extraction:** introduce a built-in Work module behind enable/disable and narrow interfaces, migrate existing settings, proposals, accepted URLs and rejection tombstones, then move its UI and lifecycle registration out of core. Preserve current Worklog behavior for existing users. Disabling stops scanners/writes without deleting records. ClickUp can remain a destination adapter after Notion v1 rather than blocking it.

**Done when:** one idea is approved, started, completed and linked to today's entry; multi-day and unplanned work are represented; retries and partial failures do not duplicate rows; disabling the plugin stops background work; existing Worklog state survives migration. Use a disposable Notion workspace for live verification.

### R06 — other plugin ideas and the minimum plugin contract · P2

A **Stoke plugin** here means an optional Stoke feature module. Claude's `--plugin-dir` skills and MCP servers already exist, but they are different from an extension that registers Stoke UI and background services.

Start with built-in modules: ID/version, enable/disable, settings, declared access to sessions/projects/connectors, commands/panels, lifecycle cleanup and versioned migrations. Keep secrets behind references. Work is the first consumer; build the contract around its actual needs. Third-party executable plugins, distribution and a marketplace need a separate design.

| Idea | First useful feature | Dependencies |
| --- | --- | --- |
| Project starter | Save a brief and launch preset; create a project from scratch work | Scratch promotion, R10 launch preflight |
| Review and release | Collect changes, checks and release notes into a reviewable draft | Git/session events, explicit publish actions |
| Worktree sessions | Start isolated attempts and compare their results | Session lifecycle, git worktree ownership/cleanup |
| Agent handoff | User-reviewed context pack for continuing with another agent/account | R14 identity, R17 capabilities, selected transcript/files |

Recommendation: Work first, Project starter second. Keep connection reliability, credentials, transfer plumbing and account identity in shared core services.

## Wave 5: opt-in admin operations and root behavior

### R03 / R16a — admin mode, fewer prompts and running as root · P2 · L

**Requested experience:** the user explicitly enables elevated agent work and can authorize a session's operations without repeatedly interrupting it. Treat the opt-in as scoped execution permission; a preference alone cannot give an ordinary process administrator privileges.

| Platform | Proposed behavior | Limit to establish |
| --- | --- | --- |
| Windows | An authenticated elevated helper performs approved commands; native UAC authorizes starting/enabling that helper | Automatic clicking of secure-desktop UAC is not a supported application mechanism |
| macOS | A native authorized helper performs privileged commands, with explicit enable/revoke and visible session status | Helper registration, signing, native authorization and supported macOS versions require a prototype |
| Linux | Explicit privileged command/session support through the host's supported authorization route; document existing root launch | Running the Electron GUI as root currently disables Chromium's sandbox |

Windows places elevation prompts on the secure desktop and requires consent under normal UAC policy. The roadmap should promise fewer prompts through previously authorized execution, not a universal “auto-accept UAC” checkbox. [Microsoft UAC behavior](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works).

Apple documents user-authorized launch daemons through Service Management. A helper is the proposed Stoke design, not an existing feature proven by this review. It also keeps ordinary browser/UI work under the user's account. [Apple helper authorization](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos).

**Existing root support:** [install.sh](../../install/install.sh) already generates a Linux uid-0 launcher with `--no-sandbox`; [the Debian probe](../../scripts/probe/debian.sh) covers root launch paths. This is not proof that every wrapped agent accepts root, or that macOS root GUI execution works.

**First milestone:** prototype command execution via helpers on Windows and Mac before designing an “elevated whole session” option. Define which commands can reuse a grant, grant duration, revocation, audit visibility and whether an agent's own sandbox/permissions permit the operation. Remote viewers do not gain admin authority merely by attaching; define separate explicit host grants if remote privileged execution is later enabled. No secret password travels through the model or terminal transcript.

**Whole-app root:** keep it a distinct compatibility investigation for macOS and Linux, including CLI restrictions, data ownership, credential stores, updates and embedded browser behavior. Do not mark it delivered by the helper milestone. The preferred user workflow is elevated operations with normal-user Stoke; whole-GUI root support needs an explicit supported-platform decision after the prototype.

**Done when:** enabled and disabled paths, cancellation of native authorization, restart, expiry/revocation and unauthorized client requests are exercised on real Windows and macOS machines. Test real target agents' privileged behavior; mocked prompts cannot prove UAC or macOS authorization.

## Wave 6: terminal Stoke on macOS and Linux

### R13 — terminal wrapper with chats, search, settings and auth · P2 · XL

**Baseline:** [the existing stoke command](../../build/bin/stoke) launches the desktop app and has limited account subcommands. It is not a standalone terminal UI. Several useful services still depend on Electron setup and IPC.

**Next:** introduce a Node service boundary for session lifecycle, account selection, settings, history/search and SSH. Build a terminal companion against it. Launching the terminal UI should not require an Electron window. Preserve the real agent CLI and PTY rather than replacing it with an API chat implementation.

Before terminal stage 1, add a credential-store adapter usable without Electron, including migration or explicitly authorized access to the existing vault. Define authenticated local service calls and shared-store locking so the desktop and terminal clients can share credentials and state without racing their writes.

**Navigation:** a Stoke shell offers Chats, Search, Agents/accounts, Connections and Settings. Left arrow returns to navigation when navigation owns focus; while the agent owns focus, it edits the prompt normally. Use a dedicated escape/chord to leave agent focus, and show that shortcut. Auth uses the vendor's supported browser/device flow; secrets and account nicknames reuse the shared services.

**Stages:** (1) terminal launcher, settings and account/SSH setup; (2) history/search and one agent session; (3) persisted session switching and remote attachment. Desktop-only embedded browser tools show their availability accurately; a terminal process cannot silently assume the Electron browser exists.

**Done when:** a fresh macOS terminal and a headless Linux host can install, authenticate, select an account, start/resume a chat, search history and manage SSH connections without opening the desktop app. Verify terminal resize, paste, Unicode, mouse reporting, focus shortcuts and reconnect using real CLIs. Define one owner for shared session state so desktop and terminal clients do not launch duplicate processes.

## Verification and the first implementation slice

Roadmap verification consists of checking source references and reviewing scope, dependencies and completion criteria. It does not establish that any requested bug is fixed.

For implementation, extend the relevant existing suites, then run the repository gate for each finished feature. Real-device proofs supplement the suites:

| Area | Existing starting points | Required live proof |
| --- | --- | --- |
| Scrolling, SSH, remote | [verify-ssh](../../scripts/verify-ssh.mts), [verify-remote](../../scripts/verify-remote.mts), [verify-hub-relay](../../scripts/verify-hub-relay.mts), [verify-phone-ui](../../scripts/verify-phone-ui.mts) | Mac/Windows/Linux desktop; real phone; Linux and macOS SSH hosts; drop and sleep/wake |
| Menu, scratch, search | [verify-fullscreen](../../scripts/verify-fullscreen.mts), [verify-folders](../../scripts/verify-folders.mts), [verify-search](../../scripts/verify-search.mts), [verify-chat-sources](../../scripts/verify-chat-sources.mts) | OS-level macOS menu recording; real folder move/resume; mixed source search |
| MCP, accounts, telemetry, updates | [verify-agents](../../scripts/verify-agents.mts), [verify-accounts](../../scripts/verify-accounts.mts), [verify-secrets](../../scripts/verify-secrets.mts), [verify-usage](../../scripts/verify-usage.mts), [verify-updates](../../scripts/verify-updates.mts) | Concurrent real accounts, actual CLI model changes, package-manager update and relaunch |
| Work plugin | Existing worklog gate/runner/retry/autoscan suites in [package.json](../../package.json) | Disposable Notion tables, retry after partial writes, migration and disable behavior |
| Privilege and terminal UI | New focused contracts and PTY fixtures | Native OS authorization; headless Linux and macOS terminal workflows |

**Start with one narrow slice:** reproduce scrolling in a managed SSH session while a Mac desktop and phone both watch it, including a reconnect and a size change. Record the expected viewport/history behavior, fix the responsible layer, and add a focused regression case. Follow with remote drop/sleep/wake handling and the macOS reveal check before adding more background services.
