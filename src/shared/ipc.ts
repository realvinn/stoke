/** Single source of truth for IPC channel names. */
export const CH = {
  // window chrome
  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:isMaximized',
  winMaximizedChanged: 'win:maximizedChanged',

  // cli
  cliInfo: 'cli:info',

  // projects & sessions
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsAddRoot: 'projects:addRoot',
  projectsHide: 'projects:hide',
  projectsPin: 'projects:pin',
  projectsReveal: 'projects:reveal',
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

  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',

  // misc
  openExternal: 'shell:openExternal',
  pickFolder: 'dialog:pickFolder'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
