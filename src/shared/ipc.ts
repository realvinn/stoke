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

  // cli
  cliInfo: 'cli:info',

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
  sessionsChanged: 'sessions:changed',

  // sessions that are not tied to a saved project
  workspaceDefault: 'workspace:default',
  workspaceScratch: 'workspace:scratch',

  // pty
  ptyStart: 'pty:start',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',

  // context meter
  ctxWatch: 'ctx:watch',
  ctxUnwatch: 'ctx:unwatch',
  ctxUpdate: 'ctx:update',

  // statusline channel (see the design spec, §3)
  statusLineUpdate: 'statusline:update',
  statusLineLast: 'statusline:last',

  // embedded browser
  browserSetBounds: 'browser:setBounds',
  browserShow: 'browser:show',
  browserHide: 'browser:hide',
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

  // remote access (phone / tunnel)
  remoteStatus: 'remote:status',
  remoteStart: 'remote:start',
  remoteStop: 'remote:stop',
  remoteNewToken: 'remote:newToken',
  tunnelStart: 'tunnel:start',
  tunnelStop: 'tunnel:stop',

  // claude cli updates
  updateCheck: 'update:check',
  updateRun: 'update:run',
  updateDoctor: 'update:doctor',

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

  // profiles
  profilesPlan: 'profiles:plan',
  profilesCreate: 'profiles:create',

  // ssh
  sshHosts: 'ssh:hosts',

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

  // clipboard
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',

  // audio
  micCheck: 'audio:micCheck',
  /**
   * A dictated clip, in. The renderer records and encodes the WAV but never
   * reaches the speech server itself — the sidecar has no auth, so only main
   * may talk to it. Same rule the phone's `/api/transcribe` route follows.
   */
  transcribe: 'audio:transcribe',

  // misc
  openExternal: 'shell:openExternal',
  pickFolder: 'dialog:pickFolder'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
