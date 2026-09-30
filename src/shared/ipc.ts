/** Single source of truth for IPC channel names. */
export const CH = {
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

  // plan limits
  usageRead: 'usage:read',

  // projects & sessions
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsAddRoot: 'projects:addRoot',
  projectsHide: 'projects:hide',
  projectsPin: 'projects:pin',
  projectsReveal: 'projects:reveal',
  projectsMeta: 'projects:meta',
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

  // sessions that are not tied to a saved project
  workspaceDefault: 'workspace:default',
  workspaceScratch: 'workspace:scratch',

  // pty
  ptyStart: 'pty:start',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  /**
   * Kill and WAIT for the exit, capped. A relaunch starts its replacement only
   * after this resolves, so two `claude` processes never write one transcript.
   */
  ptyStop: 'pty:stop',
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

  // tab restore
  tabsSave: 'tabs:save',
  tabsRestore: 'tabs:restore',

  // worklog
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
