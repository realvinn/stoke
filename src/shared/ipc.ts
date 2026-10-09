/** Single source of truth for IPC channel names. */
export const CH = {
  quickTerminalRead: 'quick-terminal:read',
  quickTerminalOpen: 'quick-terminal:open',
  quickTerminalMove: 'quick-terminal:move',
  quickTerminalRestart: 'quick-terminal:restart',
  quickTerminalEnd: 'quick-terminal:end',
  quickTerminalWrite: 'quick-terminal:write',
  quickTerminalResize: 'quick-terminal:resize',
  quickTerminalState: 'quick-terminal:state',
  quickTerminalData: 'quick-terminal:data',
  quickTerminalAppearance: 'quick-terminal:appearance',
  quickTerminalCopy: 'quick-terminal:copy',
  quickTerminalPaste: 'quick-terminal:paste',
  quickTerminalOpenLink: 'quick-terminal:open-link',
  // window chrome
  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:isMaximized',
  winMaximizedChanged: 'win:maximizedChanged',
  /*
   * Full screen is its own signal, not a flavour of maximized, because on macOS
   * they are genuinely different states: `isMaximized()` returns **false** while
   * the window is full screen. The existing channel fired on
   * enter/leave-full-screen and then reported `false` both times, so the
   * renderer could not tell full screen from an ordinary restore — which is why
   * the title bar kept reserving 88px for traffic lights macOS had already
   * hidden. They also mean different things downstream: maximized picks the
   * restore icon, full screen decides whether that clearance exists at all.
   */
  winIsFullScreen: 'win:isFullScreen',
  winFullScreenChanged: 'win:fullScreenChanged',
  /** How far macOS's full-screen menu bar reaches over the window, and whether it comes with full screen. Gotcha 105. */
  winRevealInfo: 'win:revealInfo',
  /** Bring the window forward — what a clicked notification asks for. */
  winFocus: 'win:focus',
  /**
   * Whether the OS is in dark mode, and a push when that changes.
   *
   * Read from main rather than `matchMedia('(prefers-color-scheme: dark)')` in
   * the renderer, and the difference is not academic: main sets
   * `nativeTheme.themeSource` to pin the docked browser to the app's own
   * appearance, and that pin is what the media query in every renderer then
   * resolves against. Asking the page would return Stoke's own answer back to
   * Stoke, which is a loop that always agrees with itself.
   */
  systemDark: 'system:dark',
  systemDarkChanged: 'system:darkChanged',

  // cli
  cliInfo: 'cli:info',
  /** Which known coding CLIs are on this machine, and where. */
  cliDetect: 'cli:detect',
  /** Which skills each agent's folders hold. Read-only; see shared/skills.ts. */
  skillsScan: 'skills:scan',
  /**
   * Claude Code's MCP servers as Settings › Agents lists them — names and kinds
   * only, never a value (shared/mcpServers.ts `mcpCatalog`). Read-only.
   */
  mcpCatalog: 'mcp:catalog',
  mcpProbe: 'mcp:probe',
  agentInstallation: 'agents:installation',
  agentUpdate: 'agents:update',

  /*
   * Agent accounts (shared/accounts.ts). Made and removed by main only: a
   * login account's folder becomes an agent's config home, so the renderer
   * names an agent and a label, never a path. `identify` reads each Claude
   * account's signed-in email, read-only, from its own `.claude.json`.
   * `mcp` is what each Claude login account is handed of the Default
   * account's user-scope MCP servers, by name (`accountMcpSummary`).
   */
  accountsCreate: 'accounts:create',
  accountsRemove: 'accounts:remove',
  accountsIdentify: 'accounts:identify',
  accountsMcp: 'accounts:mcp',

  // plan limits, per account and per source (shared/usageSources.ts)
  usageRead: 'usage:read',
  usageAll: 'usage:all',

  // projects & sessions
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsAddRoot: 'projects:addRoot',
  projectsHide: 'projects:hide',
  projectsPin: 'projects:pin',
  projectsReveal: 'projects:reveal',
  projectsMeta: 'projects:meta',
  /**
   * A folder's git state for the title bar's git chip (`main/gitStatus.ts`):
   * branch, changes, ahead/behind as of the last fetch, linked worktree. Runs
   * no repo code and never fetches (gotcha 147).
   */
  gitStatus: 'git:status',
  sessionsList: 'sessions:list',
  /**
   * Every listed project's sessions, as title + first prompt only, for the
   * sidebar's search. `sessionsList` is one project and parses every transcript
   * in full, which is right for the one list a user expanded and far too heavy
   * to run for all of them on a keystroke.
   */
  sessionsIndex: 'sessions:index',
  sessionsChanged: 'sessions:changed',

  /*
   * Chat history (shared/chatIndex.ts): the searchable copy of every AI chat's
   * text, built by a worker in main (src/main/chatIndex/). `detect` is names and
   * sizes only, safe before consent; `status` is an invoke AND a push while a
   * pass runs; `search` answers nothing unless `settings.chatIndex` is `on`.
   */
  chatsDetect: 'chats:detect',
  chatsStatus: 'chats:status',
  chatsSearch: 'chats:search',
  chatsIndexNow: 'chats:indexNow',
  chatsRebuild: 'chats:rebuild',
  chatsDelete: 'chats:delete',
  /*
   * An account export (a claude.ai or ChatGPT zip, or a bare conversations.json)
   * into the index: with no path, main asks with a file dialog; a path comes from
   * a drop on Settings › Chat history. The worker reads it (importer.ts).
   */
  chatsImport: 'chats:import',
  chatsRemoveImport: 'chats:removeImport',
  /** One chat for the read-only viewer: re-read from its tool's own copy, or the store's for an import. */
  chatsOpen: 'chats:open',

  /*
   * Find in a conversation (shared/transcriptFind.ts): the find bar's search of
   * the tab's own transcript, in a worker of its own. An SSH tab's answers
   * `consent` until its host is allowed or the bar says "Just this once".
   */
  transcriptFind: 'transcript:find',

  // sessions that are not tied to a saved project
  workspaceDefault: 'workspace:default',
  workspaceScratch: 'workspace:scratch',
  workspaceScratchRoot: 'workspace:scratch-root',

  /*
   * Private chats (shared/privateChat.ts). A private chat is STARTED through
   * `pty:start` with `private: true`; these only read and report on one.
   * `inspect`: how many files its folder holds, for the close question.
   * `state`: a push when the watchdog finds a transcript the CLI wrote anyway,
   * or the tab `/resume`d into a saved conversation.
   */
  privateInspect: 'private:inspect',
  privateState: 'private:state',
  privateStates: 'private:states',

  // pty
  launchPreflight: 'launch:preflight',
  ptyStart: 'pty:start',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  /**
   * Kill and WAIT for the exit, capped. A relaunch starts its replacement only
   * after this resolves, so two `claude` processes never write one transcript.
   */
  ptyStop: 'pty:stop',
  /**
   * Type text into a session as Claude Code takes it (`PtyManager.submit`:
   * typed chunks, ESC CR newlines — gotchas 85, 86), pressing Enter after it
   * only when asked. The title bar's text shortcuts.
   */
  ptyType: 'pty:type',
  /**
   * main -> renderer: another machine's remote tab resized a pty (ptyId, cols,
   * rows, reason) — `remote` when it claimed the grid by being used, `restore`
   * when the last one left and the desktop's size was put back. The session's
   * own tab draws that grid until it is used here (shared/sizeClaim.ts).
   */
  ptySized: 'pty:sized',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',

  // context meter
  ctxWatch: 'ctx:watch',
  ctxUnwatch: 'ctx:unwatch',
  ctxUpdate: 'ctx:update',

  // statusline channel (see the design spec, §3)
  statusLineUpdate: 'statusline:update',
  statusLineLast: 'statusline:last',
  /** A hook event: a prompt went in, the assistant stopped, or the CLI asked for attention. */
  sessionEvent: 'session:event',
  /** A live pty's `claude` moved to another session id (`/clear`, `/resume`, a `--continue`'s real id). */
  sessionRebind: 'session:rebind',
  /** Push: one pty's registry reading changed. Invoke: every live reading, for a renderer that reloaded. */
  sessionState: 'session:state',

  // embedded browser
  browserSetBounds: 'browser:setBounds',
  browserShow: 'browser:show',
  browserHide: 'browser:hide',
  browserSnapshot: 'browser:snapshot',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserStop: 'browser:stop',
  browserOpenExternal: 'browser:openExternal',
  browserState: 'browser:state',
  browserDevtools: 'browser:devtools',
  browserNewTab: 'browser:newTab',
  browserCloseTab: 'browser:closeTab',
  browserSelectTab: 'browser:selectTab',
  browserFind: 'browser:find',
  browserStopFind: 'browser:stopFind',
  browserZoom: 'browser:zoom',
  browserBookmark: 'browser:bookmark',
  /** The profile switcher: a native menu, since the page view paints over any DOM one (gotcha 14). */
  browserProfileMenu: 'browser:profileMenu',
  browserAddProfile: 'browser:addProfile',
  browserRemoveProfile: 'browser:removeProfile',
  /** Importing Chrome/Safari profiles: find them, import chosen ones, open the privacy pane. */
  browserImportScan: 'browser:importScan',
  browserImportRun: 'browser:importRun',
  browserOpenFullDiskAccess: 'browser:openFullDiskAccess',
  browserRenameProfile: 'browser:renameProfile',
  browserUseProfile: 'browser:useProfile',
  browserDismissImportOffer: 'browser:dismissImportOffer',

  // remote access (phone / tunnel)
  remoteStatus: 'remote:status',
  remoteStart: 'remote:start',
  remoteStop: 'remote:stop',
  remoteNewToken: 'remote:newToken',
  /**
   * The one-press path: pick a transport a phone can actually reach if none is
   * set, mint a key if there is none, start the server, and hand back the
   * link. Exists because "Turn on" with the defaults produced a QR code of
   * 127.0.0.1 under the heading "Open on your phone".
   */
  remoteOpenOnPhone: 'remote:openOnPhone',
  /** Pushed whenever the server, the tunnel or the attached clients change. */
  remoteChanged: 'remote:changed',
  /**
   * A session started from the phone (`POST /api/sessions`) is a real pty
   * running right now; this is what tells the desktop it exists at all.
   * Phone contract point 10 / audit PX-9 / F3 — `App.tsx` adopts it as a tab
   * the same way boot restore adopts one, rather than the desktop showing "No
   * active session" while a phone-started `claude` runs unseen.
   */
  remoteSessionStarted: 'remote:sessionStarted',
  /**
   * Settings › Phone access's "Look it up": the Access team and AUD in front of
   * the public hostname, read from Access's own login redirect and checked
   * against the team's signature (`discoverAccess`, gotcha 124). Returns them;
   * the renderer is the one that saves them.
   */
  remoteLookupAccess: 'remote:lookupAccess',
  tunnelStart: 'tunnel:start',
  tunnelStop: 'tunnel:stop',
  /** Look for cloudflared again, after the user has installed it. */
  tunnelLocate: 'tunnel:locate',
  /**
   * Setting a tunnel UP, as opposed to running one that exists.
   *
   * `setup` changes nothing — it reads the binary, the login certificate and
   * the account's tunnel list — and `step` runs exactly one of the setup
   * commands. Split because the probe is safe to call on every panel open and
   * the steps emphatically are not.
   */
  cloudflareSetup: 'cloudflare:setup',
  cloudflareStep: 'cloudflare:step',

  // claude cli updates
  updateCheck: 'update:check',
  updateRun: 'update:run',
  updateDoctor: 'update:doctor',
  // Both an invoke (read the current state) and a push (the automatic checker
  // has just changed it). One name, because they carry the same payload.
  updateState: 'update:state',

  // stoke's own updates
  selfCheck: 'self:check',
  selfDownload: 'self:download',
  selfInstall: 'self:install',
  selfState: 'self:state',

  // browser find, requested from inside the page view
  browserFindRequested: 'browser:findRequested',

  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',

  /*
   * Settings › Backup & transfer: where the keys live (secrets.json sealed by
   * safeStorage, or plaintext settings.json where no key store protects them),
   * and the passphrase-sealed `.stoke-setup` file. The import is three steps so
   * the decrypted payload never crosses to the renderer: pick (main's own open
   * dialog; the renderer never names a path), preview (main holds the payload
   * and returns only what would change), apply. See src/main/secrets.ts and
   * src/shared/setupFile.ts.
   */
  secretsStatus: 'secrets:status',
  setupExport: 'setup:export',
  setupImportPick: 'setup:importPick',
  setupImportPreview: 'setup:importPreview',
  setupImportApply: 'setup:importApply',
  setupImportCancel: 'setup:importCancel',

  /*
   * Stoke Hub, Settings › Account & sync (src/main/hub/service.ts). Every
   * write goes through main's hub service — the renderer never patches
   * `settings.hub` (gotcha 57) — and every answer is a `HubResult`. What
   * crosses to the renderer is the `HubView` (names, counts, times, the
   * pairing code), plus the Recovery Kit when it is made, once. Keys, tokens
   * and SSH private keys never do; the picker gets names and fingerprints.
   */
  hubView: 'hub:view',
  /** main -> renderer: the view moved. */
  hubChanged: 'hub:changed',
  hubSetUrl: 'hub:set-url',
  hubCheckUrl: 'hub:check-url',
  hubSignIn: 'hub:sign-in',
  hubSignOut: 'hub:sign-out',
  hubCreateVault: 'hub:create-vault',
  /** The Kit still waiting to be confirmed (it lives only in main's memory until then). */
  hubKit: 'hub:kit',
  hubKitConfirm: 'hub:kit-confirm',
  hubKitCancel: 'hub:kit-cancel',
  hubKitSave: 'hub:kit-save',
  hubKitPrint: 'hub:kit-print',
  hubNewKit: 'hub:new-kit',
  hubJoinStart: 'hub:join-start',
  hubJoinCancel: 'hub:join-cancel',
  /** The owner's answer on the JOINING device: do both screens show the same six digits? */
  hubJoinConfirm: 'hub:join-confirm',
  hubRecover: 'hub:recover',
  hubApproveStart: 'hub:approve-start',
  hubApproveConfirm: 'hub:approve-confirm',
  hubRefuse: 'hub:refuse',
  hubSyncNow: 'hub:sync-now',
  hubSetScope: 'hub:set-scope',
  hubSetAccountKeys: 'hub:set-account-keys',
  hubRename: 'hub:rename',
  hubRevoke: 'hub:revoke',
  hubDismissNotes: 'hub:dismiss-notes',
  /** After a hub went back in time: put back, from this device, what it lost (spec §7.3). */
  hubRepublish: 'hub:republish',
  /** A synced change that would run something here: apply it on this computer, or keep this computer's. */
  hubApplyHeld: 'hub:apply-held',
  hubKeepHeld: 'hub:keep-held',
  hubLocalKeys: 'hub:local-keys',
  hubShareKey: 'hub:share-key',
  hubUnshareKey: 'hub:unshare-key',
  hubInstallKey: 'hub:install-key',
  /**
   * "Confirm it's you": is this the hub password? (`HubService.verifyPassword`,
   * spec 2026-10-03 §2). The password crosses once, renderer -> main, and the
   * answer is a `HubVerifyResult`, never anything that holds it.
   */
  hubVerifyPassword: 'hub:verify-password',
  /**
   * The "Confirm it's you" sheet went without using its yes (Cancel, Escape,
   * or unmounted): a check still in flight confirms nothing when it lands,
   * and a confirmation not yet spent goes (`HubService.cancelVerify`).
   */
  hubCancelVerify: 'hub:cancel-verify',
  /*
   * "Other machines" (src/main/hub/remote.ts, spec §6): the owner's other
   * signed-in devices and their sessions, remote tabs, and — on the host —
   * the question and who is attached. What crosses is `HubRemoteView` (names,
   * titles, states) and a remote tab's pty frames; never a key, never a path.
   */
  hubRemoteView: 'hub:remote-view',
  /** main -> renderer: the "Other machines" view moved. */
  hubRemoteChanged: 'hub:remote-changed',
  /** main -> renderer: one pty-socket frame for a remote tab (tabId, frame). */
  hubRemoteFrame: 'hub:remote-frame',
  hubRemoteOpen: 'hub:remote-open',
  /** renderer -> main, fire and forget: keystrokes typed into a remote tab. */
  hubRemoteInput: 'hub:remote-input',
  /**
   * renderer -> main: a transcript dictated here, typed into a remote tab's
   * session by the host with no Enter (`HubRemote.type`). Answers whether it
   * went, and why not, so the words can stay on the strip.
   */
  hubRemoteType: 'hub:remote-type',
  /** renderer -> main, fire and forget: a remote tab is being used, so size the host's pty to its pane (tabId, cols, rows). */
  hubRemoteResize: 'hub:remote-resize',
  hubRemoteClose: 'hub:remote-close',
  hubRemoteRetry: 'hub:remote-retry',
  /** On the host: the owner's answer to "Let <device> open <session>?". */
  hubRemoteAnswer: 'hub:remote-answer',
  /** On the host: drop every attached device. */
  hubRemoteDrop: 'hub:remote-drop',
  /** "Let my other devices see and open my sessions" on this computer. */
  hubSetSharing: 'hub:set-sharing',
  hubRevokeGrant: 'hub:revoke-grant',
  /*
   * Chat history across the owner's computers (spec 2026-10-03 §3). What
   * crosses is per-computer results (`RemoteChatsResult`: hits with a folder
   * NAME, text redacted on the computer it came from) and one read-only chat;
   * never a path, never stored here.
   */
  /** Guest: search every other computer that shares its chat history (query) -> RemoteChatsResult[]. */
  hubSearchChats: 'hub:search-chats',
  /** Guest: one chat from another computer (device, source, nativeId) -> RemoteChatOpen. */
  hubOpenRemoteChat: 'hub:open-remote-chat',
  /** Guest, fire and forget: the search box closed, so the chats relays close now rather than when idle. */
  hubEndChatSearch: 'hub:end-chat-search',
  /** Host: "Let my other computers search this computer's chat history" (on, devices to grant Always). On needs a password confirmed here. */
  hubSetShareChats: 'hub:set-share-chats',
  /** Host: the devices holding Always for this computer's chat history -> RemoteChatGrantView[]. */
  hubChatGrants: 'hub:chat-grants',
  /** Host: Remove one device's chats Always (device id); its searches here close. */
  hubRemoveChatGrant: 'hub:remove-chat-grant',

  /*
   * Claude Code's own configuration, which is not Stoke's Settings. These read
   * and write ~/.claude/settings.json and one key in ~/.claude.json; see
   * src/main/claudeSettings.ts and src/main/claudeGlobalConfig.ts.
   */
  claudeConfigRead: 'claudeConfig:read',
  claudeConfigSet: 'claudeConfig:set',
  claudeWorkflowSize: 'claudeConfig:workflowSize',
  /** What `claude` launches with in a folder when Stoke sends no flag (QA L11). Read-only. */
  claudeLaunchDefaults: 'claudeConfig:launchDefaults',

  // profiles
  profilesPlan: 'profiles:plan',
  profilesCreate: 'profiles:create',

  // ssh
  sshHosts: 'ssh:hosts',
  sshFilesList: 'ssh:files-list',
  sshFilesSave: 'ssh:files-save',
  sshFilesCancel: 'ssh:files-cancel',
  sshFilesProgress: 'ssh:files-progress',
  /** main -> renderer: a remote just asked this session for a password. */
  sshAuthPrompt: 'ssh:auth-prompt',
  /**
   * renderer -> main: is this SSH tab still at a password prompt? Read-only.
   * (Enrolling itself is a `pty:start` with `opts.enroll`: it opens a tab the
   * user types the password into, so it rides the pty channels.)
   */
  sshAwaitingPassword: 'ssh:awaiting-password',
  /** main -> renderer: progress and outcome of an enrollment. */
  sshEnrollEvent: 'ssh:enroll-event',
  /**
   * renderer -> main: the Stoke-managed sessions still running on a host
   * (`SshHost.persist`), by host id. A BatchMode `tmux -L stoke ls`; read-only.
   */
  sshRemoteSessions: 'ssh:remote-sessions',
  /**
   * renderer -> main: end one managed session on a host ("End session" when a
   * kept tab is closed). By host id and a whitelisted name; main builds the argv.
   */
  sshEndRemoteSession: 'ssh:end-remote-session',
  /**
   * renderer -> main: an image for an SSH host — "the clipboard" (main reads it)
   * or a dropped file's bytes. Main checks, names and holds it, and answers with
   * an id, its size and a thumbnail. No path or name from the renderer is used.
   */
  sshImagePrepare: 'ssh:image-prepare',
  /**
   * renderer -> main: a dropped file of any kind for an SSH host, as the path
   * the PRELOAD read off the File (`webUtils.getPathForFile`). Main resolves it,
   * refuses anything but a regular file within the cap, and holds it.
   */
  sshFilePrepare: 'ssh:file-prepare',
  /** renderer -> main: the files Finder/Explorer copied; main reads the clipboard itself. */
  sshClipboardFilesPrepare: 'ssh:clipboard-files-prepare',
  /** main -> renderer: how far a send is (`UploadProgress`), a few times a second. */
  sshUploadProgress: 'ssh:upload-progress',
  /** renderer -> main: send a prepared image (by id) over a second BatchMode ssh. */
  sshImageSend: 'ssh:image-send',
  /** renderer -> main: stop a send in flight, or drop a prepared image. */
  sshImageCancel: 'ssh:image-cancel',

  // tab restore
  tabsSave: 'tabs:save',
  tabsRestore: 'tabs:restore',

  // worklog
  workRead: 'work:read',
  workChange: 'work:change',
  workChanged: 'work:changed',
  workNotionRead: 'work:notion:read',
  workNotionInspect: 'work:notion:inspect',
  workNotionConfigure: 'work:notion:configure',
  workNotionDisconnect: 'work:notion:disconnect',
  workNotionPublish: 'work:notion:publish',
  workNotionRetry: 'work:notion:retry',
  workNotionResolve: 'work:notion:resolve',
  workNotionChanged: 'work:notion:changed',
  workDraftsRead: 'work:drafts:read',
  workDraft: 'work:drafts:generate',
  workDraftAccept: 'work:drafts:accept',
  workDraftReject: 'work:drafts:reject',
  workDraftCancel: 'work:drafts:cancel',
  workDraftsChanged: 'work:drafts:changed',
  workSessionNotes: 'work:session-notes',
  worklogQueue: 'worklog:queue',
  worklogScan: 'worklog:scan',
  worklogAccept: 'worklog:accept',
  worklogReject: 'worklog:reject',
  worklogChanged: 'worklog:changed',
  /** An auto-scan added proposals. The renderer asks about them; see WorklogPrompt. */
  worklogProposed: 'worklog:proposed',
  worklogWatch: 'worklog:watch',
  worklogWatchChanged: 'worklog:watchChanged',
  worklogScanned: 'worklog:scanned',
  worklogLastScan: 'worklog:lastScan',

  // activity
  /** The work report: hours, lines and titles per day. Read-only, no model. */
  activityRead: 'activity:read',

  // clipboard
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',

  // audio
  micCheck: 'audio:micCheck',
  /**
   * The OS microphone permission for Stoke, and whether Claude Code's own
   * `/voice` is on. Cheap on purpose — no PowerShell, unlike `micCheck` — because
   * the terminal asks it every time dictation is switched on.
   */
  voiceState: 'audio:voiceState',
  /** Ask macOS for the microphone now, from a button, rather than mid-recording. */
  micRequest: 'audio:micRequest',
  /** Open the OS microphone privacy page. The URL is chosen in main, never passed in. */
  micPrivacy: 'audio:micPrivacy',
  /**
   * A dictated clip, in. The renderer records and encodes the WAV but never
   * reaches the speech service itself — the sidecar has no auth, and a hosted
   * provider's key is sent only by main. Same rule the phone's
   * `/api/transcribe` route follows.
   */
  transcribe: 'audio:transcribe',
  /**
   * Whether dictation is ready: Settings → Voice's pill. The sidecar or a
   * custom server is probed; a hosted provider is ready when it has a key —
   * never a paid call (`sttReadiness`). Apart from `voiceState` because it can
   * be a network probe, and the terminal asks `voiceState` on every ⇧⌘D.
   */
  sttStatus: 'audio:sttStatus',
  /**
   * Settings → Voice's Test button: prove the configured provider and key
   * with a request no plan bills (a model listing; the sidecar's probe). Takes
   * the panel's drafts, so it tests what is on screen. One at a time — main
   * claims it before its first await (gotcha 20).
   */
  voiceTest: 'audio:voiceTest',

  // wallpaper
  /** Pick an image, copy it under userData, and set `settings.wallpaper.path`. */
  wallpaperPick: 'wallpaper:pick',
  wallpaperClear: 'wallpaper:clear',

  /*
   * `stoke …` from a terminal (src/shared/stokeArgs.ts). Main parses the argv —
   * its own on a cold start, a second instance's on `second-instance` — checks
   * the folder, and QUEUES the request until the renderer asks for the queue:
   * a cold start has a request before the window has even loaded, and a push
   * then would land on nothing. `cliPending` is that ask, made once, after tab
   * restore has settled (gotcha 35: a request must not race the restore that
   * would replace the tab list under it). From then on `cliRequest` pushes.
   */
  cliRequest: 'launch:request',
  cliPending: 'launch:pending',
  /** Settings > Updates > Command line: is `stoke` on PATH, and put it there / take it off. */
  commandState: 'command:state',
  commandInstall: 'command:install',
  commandRemove: 'command:remove',

  // misc
  openExternal: 'shell:openExternal',
  pickFolder: 'dialog:pickFolder'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
