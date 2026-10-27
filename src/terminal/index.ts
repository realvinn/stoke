import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { emitKeypressEvents, type Key } from 'node:readline'
import { PassThrough } from 'node:stream'
import { CODING_CLIS, cliFor, isCodingCliId, isSafeResumeId, type CodingCliId } from '../shared/codingClis.ts'
import { isModelId } from '../shared/modelId.ts'
import { atomicJson, terminalHome, configPath, configSchema, exampleConfig, readConfig, selectedAgent, updateConfig, type TerminalConfig } from './config.ts'
import { executableFor, history, sessionLabel, Sessions, type Chat, type LiveChat } from './sessions.ts'
import { AgentInput, ConsoleInput, composerView, nextCursor, previousCursor } from './input.ts'
import { MENU_SECTIONS, menuItems, renderMenu, renderWelcome, type MenuItem, type MenuSection, type MenuView } from './menu.ts'
import { formKey, insertFormText, type FormField } from './forms.ts'
import { z } from 'zod'

const HELP = `Stoke — persistent shells and agents, in one terminal

Usage: stoke [DIR] [--cli AGENT] [--config FILE]
       stoke config init
       stoke doctor [--json]
       stoke sessions [--json]
       stoke attach SESSION_ID
       stoke connect NAME [--check] [--json]
       stoke server start|status|stop

Plain stoke resumes your last live session, or starts a normal shell.
F2 opens New: shell, agent or remote connection. --cli AGENT opens that agent.
  /agent [ID]       search or switch coding agents (starts a separate chat)
  /models [ID]      choose a model for the next chat; default resets it
  /chats [FILTER]   list older chats; Left on an empty prompt opens the chat picker
  /attach NUMBER    return to a live chat or resume a recorded Claude chat
  /resume ID       resume a native session ID using the selected agent
  /continue        open the agent's latest chat in this folder
  /remote [NAME]   search saved OpenCode servers and SSH hosts, or connect
  /settings        edit defaults, appearance and startup behavior
  /connections     manage saved SSH hosts and OpenCode servers
  /config [reload] show the config path/example, or reload it
  /new             choose a shell, agent or remote connection
  /shell           start a normal shell in this folder
  /stop NUMBER     stop a running chat
  /help            these commands
  /quit            detach this UI; chats keep running in the local service
  /detach          detach this UI; use stoke attach to return later

F2 New · F3/F4 switch sessions · F6 detach · F9 settings.
F5 opens the Stoke menu from any shell or agent; F5 / Esc returns to the same chat.
In the menu: type to search, Tab switches sections, Enter opens a selection.
Ctrl+F chats · Ctrl+G agents · Ctrl+R connections · Ctrl+N opens New.
Ctrl+] also returns to Stoke; the agent keeps running.
Agent slash commands and arrow keys belong to that agent while it has focus.
Vendor login, permissions, MCP and settings remain in the real agent CLI.
`
declare const STOKE_TERMINAL_VERSION: string

// Disable modes a child may have enabled before giving the Stoke composer focus.
const SHELL_MODES = '\x1b[?9001l\x1b[?2026l\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?1007l\x1b[?1l\x1b>\x1b[?25h\x1b[0m\x1b[?2004h'
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) if (args[i] === '--config') {
    if (!args[i + 1]) throw new Error('--config needs a file path')
    process.env.STOKE_CONFIG = resolve(args[i + 1]); args.splice(i, 2); i--
  }
  if (args[0] === '--internal-session-server') {
    const { runSessionServer } = await import('./sessionServer.ts')
    await runSessionServer(); return
  }
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`Stoke terminal ${typeof STOKE_TERMINAL_VERSION === 'undefined' ? 'development' : STOKE_TERMINAL_VERSION}\n`); return
  }
  if (args[0] === 'doctor') {
    const { doctor } = await import('./doctor.ts')
    const result = await doctor()
    process.stdout.write(args.includes('--json') ? JSON.stringify(result, null, 2) + '\n' : result.checks.map((check) => `${check.status === 'ok' ? '✓' : check.status === 'error' ? '✗' : '!'} ${check.name}: ${check.message}`).join('\n') + '\n')
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (args[0] === 'connect' && args.includes('--check')) {
    const connection = readConfig().remotes[args[1]]
    if (!connection) throw new Error('Unknown connection. Use /connections to configure it.')
    const { checkConnection } = await import('./connections.ts')
    const result = await checkConnection(connection)
    process.stdout.write(args.includes('--json') ? JSON.stringify(result) + '\n' : result.message + '\n')
    process.exitCode = result.ok ? 0 : 1; return
  }
  if (args[0] === 'sessions' || args[0] === 'server') {
    const service = new Sessions(() => {}, () => {})
    const start = args[0] === 'server' && args[1] === 'start'
    if (args[0] === 'server' && !['start', 'stop', 'status'].includes(args[1])) throw new Error('Usage: stoke server start|status|stop')
    const running = await service.ready(start)
    if (args[0] === 'server') {
      if (args[1] === 'stop' && running) await service.shutdown()
      process.stdout.write(args[1] === 'stop' ? 'Session service stopped.\n' : running ? 'Session service is running.\n' : 'Session service is not running.\n')
    } else {
      const records = history().map((chat) => ({ ...chat, state: service.live.get(chat.id) && !service.live.get(chat.id)!.exited ? 'running' : 'saved' }))
      process.stdout.write(args.includes('--json') ? JSON.stringify(records, null, 2) + '\n' : records.map((chat) => `${chat.id}  ${chat.agent}  ${chat.state}  ${clean(chat.title)}`).join('\n') + '\n')
    }
    service.close(); return
  }
  const attachCommand = args[0] === 'attach', connectCommand = args[0] === 'connect'
  const attachId = attachCommand ? args.splice(0, 2)[1] : undefined
  const remoteName = connectCommand ? args.splice(0, 2)[1] : undefined
  if (attachCommand && !attachId) throw new Error('Usage: stoke attach SESSION_ID')
  if (connectCommand && !remoteName) throw new Error('Usage: stoke connect NAME')
  const requestedChat = attachId ? history().find((entry) => entry.id === attachId) : undefined
  if (attachId && !requestedChat) throw new Error('Unknown session ID. Use stoke sessions to list chats.')
  let cwd = process.cwd(), chosen: CodingCliId | undefined, folderSet = false, initConfig = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--config') {
      if (!args[++i]) throw new Error('--config needs a file path')
      process.env.STOKE_CONFIG = resolve(args[i])
    } else if (arg === '--cli') {
      const id = args[++i]
      if (!isCodingCliId(id)) throw new Error('--cli needs a known agent ID; use /agent to list agents')
      chosen = id
    } else if (arg === 'config' && args[i + 1] === 'init') {
      initConfig = true; i++
    } else if (arg.startsWith('-') || folderSet) throw new Error(`Unknown argument: ${arg}`)
    else { cwd = realpathSync(resolve(arg)); folderSet = true }
  }
  if (initConfig) {
    if (folderSet) throw new Error('config init does not take a working folder')
    const file = configPath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(exampleConfig, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write(`Created ${file}\n`)
    return
  }
  if (!statSync(cwd).isDirectory()) throw new Error(`Not a folder: ${cwd}`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Stoke needs an interactive terminal. Use stoke --help for commands.')
  let config = readConfig(), agent = chosen ?? selectedAgent(config)
  if (remoteName && !config.remotes[remoteName]) throw new Error('Unknown connection. Use /connections to configure it.')
  let model = config.agents[agent]?.model ?? ''
  let attached: LiveChat | null = null, line = '', cursor = 0, paste = false, quitting = false
  let menu: (MenuView & { returnTo: LiveChat | null }) | null = null
  let formAction: ((values: Record<string, string>) => void) | null = null
  let escapeTimer: ReturnType<typeof setTimeout> | null = null
  let visibleChats: Chat[] = [], commandHistory: string[] = [], historyIndex = 0
  const keys = new PassThrough()
  let agentInput = new AgentInput()
  const consoleInput = new ConsoleInput()
  const out = (value: string): void => { process.stdout.write(value) }
  const say = (value: string): void => out(`\r\x1b[2K${value}\r\n`)
  const prompt = (): void => {
    if (attached || quitting) return
    if (menu) {
      menu.theme = config.ui.theme
      menu.context = `${cliFor(agent).label} · ${model || 'agent default'} · ${cwd}`
      out(renderMenu(menu, process.stdout.columns || 80, process.stdout.rows || 24)); return
    }
    const prefix = `stoke · ${agent}${model ? ` · ${model}` : ''} › `
    const frame = composerView(line, cursor, prefix, process.stdout.columns || 80)
    out(`\r\x1b[2K${frame.text}\r${frame.beforeCursor}`)
  }
  const sessions = new Sessions((session, data) => {
    if (attached === session) out(data)
  }, (session) => {
    if (menu) {
      menu.items = itemsFor(menu.section)
      if (menu.returnTo === session) menu.notice = 'That chat has exited. Select another chat or start a new one.'
      prompt()
    }
    if (attached === session) {
      attached = null
      out(SHELL_MODES)
      say(`Session exited (${session.exitCode}). /chats to return to your history.`)
      if (session.chat.agent === 'shell') openMenu('chats')
      else prompt()
    }
  })
  await sessions.ready()
  const attach = (session: LiveChat): void => {
    if (session.exited) throw new Error('That process has exited. Use /attach to resume a saved chat.')
    if (menu) { menu = null; out(SHELL_MODES) }
    line = ''; cursor = 0
    try { atomicJson(join(terminalHome(), 'last-session.json'), { id: session.chat.id }) } catch { /* Read-only state must not prevent attaching a live terminal. */ }
    say('F2 New · F3/F4 switch · F5 menu · F6 detach · F9 settings')
    attached = session
    agentInput = new AgentInput(config.ui.menuKey)
    session.screen.resize(process.stdout.columns || 80, process.stdout.rows || 24)
    session.pty.resize(process.stdout.columns || 80, process.stdout.rows || 24)
    out('\x1b[?2004l\x1b[2J\x1b[H' + (session.screen.snapshot() ?? 'Screen unavailable. Return to Stoke and restart this chat.\r\n'))
    if (process.platform === 'win32') out('\x1b[?9001h')
  }
  const listChats = (filter = ''): void => {
    visibleChats = history().filter((chat) => `${chat.title} ${chat.agent} ${chat.cwd}`.toLowerCase().includes(filter.toLowerCase()))
    if (!visibleChats.length) say('No Stoke terminal chats yet. Type a message or /new to begin.')
    visibleChats.forEach((chat, index) => {
      const live = sessions.live.get(chat.id)
      say(`${index + 1}. ${clean(chat.title)}  [${chat.agent} · ${live && !live.exited ? 'running' : 'saved'}]  ${clean(chat.cwd)}`)
    })
    if (visibleChats.length) say('Use /attach NUMBER. Saved chats without an exact resume ID use /continue in their agent.')
  }
  const chatNumber = (value: string): Chat => {
    if (!/^\d+$/.test(value)) throw new Error('Use a chat number from /chats.')
    const chat = visibleChats[Number(value) - 1]
    if (!chat) throw new Error('No chat at that number. Use /chats first.')
    return chat
  }
  const startShell = (folder = cwd): void => attach(sessions.start(sessions.create('shell', folder, ''), config))
  const switchSession = (direction: number): void => {
    const live = [...sessions.live.values()].filter((s) => !s.exited)
    if (!live.length) { openMenu('new'); return }
    const current = attached ?? menu?.returnTo
    const index = live.findIndex((s) => s === current)
    attach(live[(Math.max(0, index) + direction + live.length) % live.length])
  }
  const restoreChat = (chat: Chat): void => {
    const live = sessions.live.get(chat.id)
    if (live && !live.exited) attach(live)
    else if (chat.agent === 'shell') startShell(chat.cwd)
    else attach(sessions.start(chat, config, '', true))
  }
  const start = (text = ''): void => attach(sessions.start(sessions.create(agent, cwd, model, text), config, text))
  const execute = (text: string): void => {
    if (!text) return
    if (!text.startsWith('/')) { start(text); return }
    const match = /^(\/\S+)\s*(.*)$/s.exec(text)!
    const command = match[1], value = match[2].trim()
    switch (command) {
      case '/menu': openMenu('chats'); break
      case '/commands': openMenu('commands'); break
      case '/settings': openMenu('settings'); break
      case '/connections': openMenu('remote'); break
      case '/help': say(HELP); break
      case '/': openMenu('commands'); break
      case '/agent': case '/agents':
        if (!value) {
          openMenu('agents')
        } else {
          if (!isCodingCliId(value)) throw new Error('Unknown agent. /agent lists supported agents.')
          agent = value; model = config.agents[agent]?.model ?? ''
          say(`Selected ${cliFor(agent).label} for the next chat.`)
        }
        break
      case '/models': case '/model':
        if (!value) {
          openMenu('models')
        } else {
          if (value !== 'default' && agent !== 'claude' && !cliFor(agent).modelArgs) throw new Error('This agent selects its model inside its own interface.')
          if (value !== 'default' && !isModelId(value)) throw new Error('Invalid model ID.')
          model = value === 'default' ? '' : value
          say(`Model for the next chat: ${model || 'agent default'}. Existing chats keep their model.`)
        }
        break
      case '/new': if (value) throw new Error('/new takes no arguments. Select an option in New.'); openMenu('new'); break
      case '/shell': startShell(); break
      case '/chats': case '/search': listChats(value); break
      case '/attach': {
        restoreChat(chatNumber(value))
        break
      }
      case '/resume': {
        if (!isSafeResumeId(value)) throw new Error('Use a native session ID from the agent, not a Stoke chat number.')
        const chat = { ...sessions.create(agent, cwd, model), nativeId: value }
        attach(sessions.start(chat, config, '', true)); break
      }
      case '/continue': {
        const continueArgs = agent === 'claude' ? ['--continue'] : cliFor(agent).continueArgs
        if (!continueArgs) throw new Error('This agent has no supported continue command. Use its native session picker.')
        const file = executableFor(agent, config)
        if (!file) throw new Error(`${agent} is not on PATH.`)
        const chat = sessions.create(agent, cwd, model)
        // A vendor's "latest" session has an unknown identity until an adapter observes it.
        delete chat.nativeId
        const launchConfig: TerminalConfig = configSchema.parse(config)
        launchConfig.agents[agent] = { args: [], model: '', models: [] }
        const modelArgs = model ? (agent === 'claude' ? ['--model', model] : cliFor(agent).modelArgs?.(model) ?? []) : []
        attach(sessions.start(chat, launchConfig, '', false, { file, args: [...(config.agents[agent]?.args ?? []), ...continueArgs, ...modelArgs] }))
        break
      }
      case '/remote': {
        if (!value) { openMenu('remote'); break }
        const remote = config.remotes[value]
        if (!remote) throw new Error('Unknown connection. Add it to remotes in /config, then /config reload.')
        const remoteAgent = remote.kind === 'opencode' ? 'opencode' : 'shell'
        const file = remote.kind === 'ssh' ? 'ssh' : executableFor('opencode', config)
        if (!file) throw new Error('OpenCode is not on PATH.')
        const chat = sessions.create(remoteAgent, cwd, '')
        delete chat.nativeId
        chat.title = `Remote: ${value}`
        const args = remote.kind === 'ssh' ? ['-t', remote.host, 'stoke'] : ['attach', remote.url]
        attach(sessions.start(chat, config, '', false, { file, args })); break
      }
      case '/config':
        if (value && value !== 'reload') throw new Error('Use /config or /config reload.')
        if (value === 'reload') {
          const fresh = readConfig()
          config = fresh; agent = chosen ?? selectedAgent(config); model = config.agents[agent]?.model ?? ''
          say('Reloaded configuration. Running chats keep their launch settings.')
        } else {
          say(configPath())
          if (!existsSync(configPath())) say('Create it with: stoke config init\n' + JSON.stringify(exampleConfig, null, 2))
          else say('Edit this file, then /config reload. Credentials stay in each agent’s own login store.')
        }
        break
      case '/stop': {
        const session = sessions.live.get(chatNumber(value).id)
        if (!session || session.exited) throw new Error('That chat is not running in this Stoke process.')
        session.pty.kill(); say('Stopped chat.'); break
      }
      case '/detach': case '/quit': case '/exit': quit(); break
      default: throw new Error(`Unknown Stoke command: ${command}. Use /help. Agent commands work inside an agent; /new opens one.`)
    }
  }
  const itemsFor = (section: MenuSection): MenuItem[] => {
    if (section === 'commands') return [
      ...MENU_SECTIONS.map((id) => ({ id, title: ({ new: 'New terminal or agent', chats: 'Search sessions', agents: 'Choose an agent', models: 'Choose a model', remote: 'Remote connections', settings: 'Settings', help: 'Help', commands: 'Commands' })[id], subtitle: 'Open workspace section', detail: ['Enter opens this section.', 'Use F5 to return to a running chat.'] })),
      { id: '/shell', title: 'New shell', subtitle: 'Normal interactive shell', detail: ['Start a separate shell without closing existing sessions.'] },
      { id: '/continue', title: 'Continue latest conversation', subtitle: 'Use the agent’s native history', detail: ['Continue the most recent conversation in this folder.'] },
      { id: 'doctor', title: 'Run diagnostics', subtitle: 'Platform, PTY, configuration and installed agents', detail: ['Checks run locally. No agent provider requests are made.', 'For script output, run stoke doctor --json.'] },
      { id: '/detach', title: 'Detach this terminal', subtitle: 'Chats keep running locally', detail: ['Return later with stoke sessions and stoke attach ID.', 'Stop all sessions explicitly with stoke server stop.'] }
    ]
    if (section === 'new') return [
      { id: 'shell', title: 'Shell', subtitle: 'Normal terminal · keeps running when you disconnect', detail: [cwd, '', 'Start your default shell in this folder.', 'Use F3/F4 to switch sessions; F6 to detach Stoke.'] },
      { id: 'agent', title: cliFor(agent).label, subtitle: 'New agent session · selected model', detail: [model || 'Agent default model', cwd, '', 'The real agent runs in its own terminal.'] },
      { id: 'agents', title: 'Choose another agent…', subtitle: 'Installed coding agents', detail: ['Open the agent picker.'] },
      { id: 'remote', title: 'Remote connection…', subtitle: 'SSH hosts and OpenCode servers', detail: ['Open saved connections or add a host.'] },
      { id: 'settings', title: 'Settings', subtitle: 'Appearance, startup and defaults', detail: [configPath()] }
    ]
    if (section === 'chats') return history().map((chat) => {
      const live = sessions.live.get(chat.id)
      return { id: chat.id, title: chat.title, subtitle: `${sessionLabel(chat.agent)} · ${live && !live.exited ? 'running' : 'saved'}`,
        detail: [chat.cwd, chat.agent === 'shell' ? 'Interactive shell' : `Model: ${chat.model || 'agent default'}`, '',
          live && !live.exited ? 'Enter returns to this chat. Its process stays running while you use Stoke.' :
            chat.agent === 'shell' ? 'This shell has ended. Enter opens a new shell in its original folder.' : chat.nativeId ? 'Enter resumes this saved conversation.' : 'No exact session ID saved. Use /continue in this agent to open its latest chat.',
          '', 'Ctrl+G: choose another agent', 'Ctrl+R: remote connections', 'Ctrl+N: new chat'] }
    })
    if (section === 'agents') return CODING_CLIS.map((cli) => ({ id: cli.id, title: cli.label,
      subtitle: `${cli.id}${cli.id === agent ? ' · selected' : ''} · ${executableFor(cli.id, config) ? 'installed' : 'not on PATH'}`,
      detail: [cli.blurb, '', 'Enter starts a new chat with this agent.', 'Existing chats stay running.', '', `Install: ${cli.home}`] }))
    if (section === 'models') return [
      { id: '@default', title: 'Agent default', subtitle: model ? 'Use the agent’s own model selection' : 'Selected for the next chat', detail: ['Let the agent choose from its configured providers.', '', 'Enter selects this for the next chat.', 'Running chats keep their current model.'] },
      ...[...new Set([model, ...(config.agents[agent]?.models ?? [])].filter(Boolean))].map((id) => ({ id: `model:${id}`, title: id,
        subtitle: id === model ? 'Selected for the next chat' : `Saved model · ${cliFor(agent).label}`, detail: [`Agent: ${cliFor(agent).label}`, '', 'Enter selects this model for the next chat.', 'Model availability and sign-in are managed by the agent.'] })),
      { id: '@custom', title: 'Add a model…', subtitle: 'Enter a model ID and save a shortcut', detail: ['Use a model ID supported by your agent and provider.', '', `Example: ${cliFor(agent).modelExample || 'a model ID from your provider'}`, '', 'This list contains your saved shortcuts, not a live provider catalog.'] }
    ]
    if (section === 'settings') return [
      { id: 'default-agent', title: 'Default agent', subtitle: cliFor(selectedAgent(config)).label, detail: ['Choose the agent Stoke selects on startup.', '', 'An explicit --cli option takes precedence.', '', 'Enter to edit.'] },
      { id: 'default-model', title: `Default model · ${cliFor(agent).label}`, subtitle: config.agents[agent]?.model || 'Agent default', detail: ['Set the model used for new chats with this agent.', '', 'Leave blank to let the agent choose.', '', 'Enter to edit.'] },
      { id: 'theme', title: 'Appearance', subtitle: config.ui.theme, detail: ['Ember · warm copper accents', 'Ocean · soft blue accents', 'Terminal · your terminal’s own colors', '', 'Enter cycles the theme. NO_COLOR disables colors.'] },
      { id: 'startup', title: 'Start screen', subtitle: config.ui.startup === 'terminal' ? 'Resume session / shell' : config.ui.startup === 'menu' ? 'Stoke menu' : 'Message composer', detail: ['Choose what appears when Stoke starts.', '', 'Enter cycles terminal, menu and composer.'] },
      { id: 'menu-key', title: 'Extra menu shortcut', subtitle: config.ui.menuKey === 'f5' ? 'F5 only' : config.ui.menuKey === 'f6' ? 'F5 and F6' : 'F5 and Ctrl+\\', detail: ['F5 always opens Stoke.', 'Add F6 or Ctrl+\\ if your terminal reserves F5.', '', 'Enter cycles the extra shortcut. Applies when you return to an agent.'] },
      { id: 'file', title: 'Configuration file', subtitle: existsSync(configPath()) ? 'Saved locally' : 'Created when you save your first setting', detail: [configPath(), '', 'Changes from these menus are saved here.', 'Vendor credentials remain in the agent’s own login store.'] },
      { id: 'reload', title: 'Reload configuration', subtitle: 'Read changes made outside Stoke', detail: ['Reload this file after editing it in another program.', '', 'Running chats keep their launch settings.'] },
      { id: 'shortcuts', title: 'Keyboard shortcuts', subtitle: 'Navigation, agent focus and commands', detail: ['Enter opens the keyboard reference.'] }
    ]
    if (section === 'help') return [
      { id: 'navigation', title: 'Move around Stoke', subtitle: 'F5, Tab and search', detail: ['F2 New · F3/F4 switch sessions', 'F5 / Esc returns to the same running chat.', 'Tab / Shift+Tab switch sections.', 'Type to filter; Up/Down select; Enter opens.', 'Ctrl+F chats · Ctrl+G agents', 'Ctrl+R connections · Ctrl+S settings', 'F2 / Ctrl+N opens New.'] },
      { id: 'connections', title: 'Connect to another computer', subtitle: 'SSH hosts and OpenCode servers', detail: ['Connections → Add connection…', 'SSH: enter a host or ~/.ssh/config alias.', 'The host needs the stoke terminal command on PATH.', 'OpenCode: enter the server’s HTTP(S) URL.', 'Authentication uses SSH or OpenCode’s native flow.', '', 'Stoke Hub login and phone sharing are not part of this terminal preview.'] },
      { id: 'models', title: 'Agents and models', subtitle: 'Your real agents, their own permissions', detail: ['Selecting an agent starts a separate chat.', 'Models apply to the next chat, not one already running.', 'The agent owns its login, permissions, tools and slash commands.', '', 'Ctrl+] returns to the Stoke command prompt.', 'Type /help there to list commands.'] },
      { id: 'history', title: 'Chat history and resume', subtitle: 'What stays running and what is saved', detail: ['Live chats stay running when this UI closes.', 'Use stoke sessions and stoke attach ID to return.', 'Each attachment takes keyboard control for that chat.', 'Use /stop to end one chat, or stoke server stop to end all.', 'Claude chats with recorded IDs can resume after the service stops.', 'Other agents use /continue or /resume NATIVE_ID.', '', 'Desktop history import is still to come.'] }
    ]
    return [{ id: '@add', title: 'Add connection…', subtitle: 'SSH host or OpenCode server', detail: ['Set up a connection without editing JSON.', '', 'Enter opens the connection form.', 'Ctrl+A also adds a connection.', '', 'Saved connections appear below.'] }, ...Object.entries(config.remotes).map(([name, remote]) => ({ id: name, title: name,
      subtitle: `${remote.kind === 'ssh' ? 'SSH' : 'OpenCode'} · ${[...sessions.live.values()].some((s) => !s.exited && s.chat.title === `Remote: ${name}`) ? 'session running' : 'saved connection'}`,
      detail: [remote.kind === 'ssh' ? remote.host : remote.url, '', 'Enter connects without closing your other chats.', '',
        remote.kind === 'ssh' ? 'The remote host needs the stoke terminal command on PATH.' : 'Uses your local OpenCode client and its authentication.', '', 'Ctrl+E edit · Ctrl+D remove', 'A running session is separate from this saved entry.'] }))]
  }
  const openMenu = (section: MenuSection): void => {
    const returnTo = attached ?? menu?.returnTo ?? null
    attached = null
    if (!menu) out(SHELL_MODES + '\x1b[?1049h\x1b[2J')
    menu = { section, query: '', selected: 0, items: itemsFor(section), notice: '',
      active: returnTo ? `${sessionLabel(returnTo.chat.agent)}: ${returnTo.chat.title}` : '', returnTo }
    formAction = null
    prompt()
  }
  const closeMenu = (restore = true): void => {
    const returnTo = menu?.returnTo
    menu = null
    formAction = null
    out(SHELL_MODES)
    if (restore && returnTo && !returnTo.exited) attach(returnTo)
    else prompt()
  }
  const chooseMenuItem = (): void => {
    if (!menu) return
    const snapshot = menu
    const item = menuItems(menu)[menu.selected]
    if (!item) return
    try {
      if (menu.section === 'chats') {
        const chat = history().find((entry) => entry.id === item.id)
        if (!chat) throw new Error('This chat is no longer in history.')
        restoreChat(chat)
      } else if (menu.section === 'new') {
        if (item.id === 'shell') startShell()
        else if (item.id === 'agent') start()
        else openMenu(item.id as MenuSection)
      } else if (menu.section === 'agents') {
        if (!isCodingCliId(item.id)) return
        agent = item.id; model = config.agents[agent]?.model ?? ''
        start()
      } else if (menu.section === 'remote') {
        if (item.id === '@add') connectionForm()
        else execute(`/remote ${item.id}`)
      } else if (menu.section === 'models') {
        if (item.id === '@custom') modelForm(false)
        else {
          execute(`/models ${item.id === '@default' ? 'default' : item.id.slice(6)}`)
          menu.items = itemsFor('models')
          menu.notice = `Selected ${model || 'agent default'} for the next chat. Ctrl+N starts it.`
        }
      } else if (menu.section === 'settings') settingAction(item.id)
      else if (menu.section === 'commands') {
        if (MENU_SECTIONS.includes(item.id as MenuSection)) openMenu(item.id as MenuSection)
        else if (item.id === 'doctor') {
          const current = menu
          menu.notice = 'Running local diagnostics…'
          void import('./doctor.ts').then(({ doctor }) => doctor()).then((report) => {
            if (menu === current) {
              menu.query = ''; menu.selected = 0
              menu.items = report.checks.map((check) => ({ id: `diagnostic:${check.name}`, title: check.name, subtitle: check.status, detail: [check.message] }))
              menu.notice = report.ok ? 'Diagnostics completed. No blocking problems found.' : 'Diagnostics found a problem. Select it for details.'
              prompt()
            }
          }).catch(() => { if (menu === current) { menu.notice = 'Diagnostics could not finish. Run stoke doctor in a shell.'; prompt() } })
        } else if (item.id.startsWith('/')) execute(item.id)
      }
    } catch (error) {
      menu = snapshot
      menu.notice = clean(error instanceof Error ? error.message : String(error))
      prompt()
    }
  }
  const showForm = (title: string, description: string, fields: FormField[], submit: string, action: (values: Record<string, string>) => void): void => {
    if (!menu) return
    menu.form = { title, description, fields, focused: 0, submit, error: '' }
    formAction = action
  }
  const errorText = (error: unknown): string => clean(error instanceof z.ZodError
    ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    : error instanceof Error ? error.message : String(error))
  const saveForm = (): void => {
    if (!menu?.form || !formAction) return
    try {
      const values = Object.fromEntries(menu.form.fields.map((field) => [field.key, field.value.trim()]))
      formAction(values)
      if (menu) {
        delete menu.form; menu.items = itemsFor(menu.section); menu.query = ''
        const id = menu.section === 'remote' ? values.name : menu.section === 'models' ? `model:${values.model}` : ''
        menu.selected = Math.max(0, menu.items.findIndex((item) => item.id === id))
      }
      formAction = null
    } catch (error) { if (menu?.form) menu.form.error = errorText(error) }
  }
  const connectionForm = (name?: string): void => {
    const original = name ? config.remotes[name] : undefined
    if (name && !original) throw new Error('That connection no longer exists. Reload Settings first.')
    showForm(name ? 'Edit connection' : 'Add connection', 'Saved locally. SSH uses your SSH configuration; OpenCode uses its native client authentication.', [
      { key: 'name', label: 'Connection name', value: name || '', placeholder: 'work-server' },
      { key: 'kind', label: 'Connection type', value: original?.kind || 'ssh', choices: ['ssh', 'opencode'] },
      { key: 'target', label: 'SSH host / alias or OpenCode HTTP(S) URL', value: original ? original.kind === 'ssh' ? original.host : original.url : '', placeholder: 'user@server or https://opencode.example.com' }
    ], 'Save connection', (values) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(values.name)) throw new Error('Use letters, numbers, hyphens or underscores for the connection name.')
      config = updateConfig((latest) => {
        if (name && JSON.stringify(latest.remotes[name]) !== JSON.stringify(original)) throw new Error('This connection changed in another window. Cancel and reload Settings before editing.')
        if (values.name !== name && latest.remotes[values.name]) throw new Error('That connection name is already in use.')
        const entry = values.kind === 'ssh' ? { kind: 'ssh' as const, host: values.target } : { kind: 'opencode' as const, url: values.target }
        if (name) delete latest.remotes[name]
        latest.remotes[values.name] = entry
      })
      if (menu) menu.notice = `Saved ${values.name}. Select it and press Enter to connect.`
    })
  }
  const removeConnection = (name: string): void => {
    const original = config.remotes[name]
    if (!original) return
    showForm('Remove connection', `Remove the saved entry “${name}”? Any running session stays open.`, [
      { key: 'name', label: 'Type the connection name to remove it', value: '' }
    ], 'Remove connection', (values) => {
      if (values.name !== name) throw new Error('Enter the exact connection name.')
      config = updateConfig((latest) => {
        if (JSON.stringify(latest.remotes[name]) !== JSON.stringify(original)) throw new Error('This connection changed in another window. Cancel and reload Settings first.')
        delete latest.remotes[name]
      })
      if (menu) menu.notice = `Removed ${name} from saved connections.`
    })
  }
  const modelForm = (asDefault: boolean): void => {
    const id = agent
    showForm(asDefault ? 'Default model' : 'Add model', `Choose a model ID for ${cliFor(id).label}. Leave blank to use the agent default.`, [
      { key: 'model', label: 'Model ID', value: asDefault ? config.agents[id]?.model || '' : '', placeholder: cliFor(id).modelExample || 'Model ID from your provider' }
    ], asDefault ? 'Save default model' : 'Save model', (values) => {
      if (values.model && !isModelId(values.model)) throw new Error('Enter a valid model ID, or leave it blank for the agent default.')
      if (values.model && id !== 'claude' && !cliFor(id).modelArgs) throw new Error('This agent selects its model inside its own interface.')
      config = updateConfig((latest) => {
        const entry = latest.agents[id] ??= { model: '', models: [], args: [] }
        if (asDefault) entry.model = values.model
        if (values.model && !entry.models.includes(values.model)) entry.models.push(values.model)
      })
      model = values.model
      if (menu) menu.notice = `Saved ${model || 'agent default'} for ${cliFor(id).label}. Running chats keep their model.`
    })
  }
  const settingAction = (id: string): void => {
    if (id === 'default-agent') showForm('Default agent', 'Choose an agent ID such as claude, codex or opencode. Your running chats are unchanged.', [
      { key: 'agent', label: 'Agent ID', value: config.agent }
    ], 'Save default agent', (values) => {
      if (!isCodingCliId(values.agent)) throw new Error('Unknown agent ID. The Agents section lists supported agents.')
      const defaultAgent = values.agent
      config = updateConfig((latest) => { latest.agent = defaultAgent })
      if (menu) menu.notice = `Default agent saved: ${cliFor(selectedAgent(config)).label}. Applies on your next launch.`
    })
    else if (id === 'default-model') modelForm(true)
    else if (id === 'theme') {
      const themes = ['ember', 'ocean', 'terminal'] as const
      config = updateConfig((latest) => { latest.ui.theme = themes[(themes.indexOf(latest.ui.theme) + 1) % themes.length] })
      if (menu) { menu.items = itemsFor('settings'); menu.notice = `Appearance saved: ${config.ui.theme}.` }
    } else if (id === 'startup') {
      config = updateConfig((latest) => { latest.ui.startup = ({ terminal: 'menu', menu: 'composer', composer: 'terminal' } as const)[latest.ui.startup] })
      if (menu) { menu.items = itemsFor('settings'); menu.notice = 'Start screen saved for the next launch.' }
    } else if (id === 'menu-key') {
      const keys = ['f5', 'f6', 'ctrl-backslash'] as const
      config = updateConfig((latest) => { latest.ui.menuKey = keys[(keys.indexOf(latest.ui.menuKey) + 1) % keys.length] })
      if (menu) { menu.items = itemsFor('settings'); menu.notice = 'Extra menu shortcut saved. F5 remains available.' }
    } else if (id === 'reload') {
      config = readConfig(); agent = chosen ?? selectedAgent(config); model = config.agents[agent]?.model ?? ''
      if (menu) { menu.items = itemsFor('settings'); menu.notice = 'Configuration reloaded. Running chats keep their settings.' }
    } else if (id === 'shortcuts') openMenu('help')
  }
  const quit = (): void => {
    if (quitting) return
    quitting = true; attached = null
    if (escapeTimer) clearTimeout(escapeTimer)
    sessions.close()
    process.stdin.setRawMode(false)
    out(SHELL_MODES + '\x1b[?2004l\r\n')
    process.stdin.pause()
    process.stdin.removeAllListeners('data')
    keys.removeAllListeners('keypress')
  }
  process.on('SIGTERM', quit)
  process.on('SIGHUP', quit)
  process.on('SIGINT', quit)
  process.stdout.on('resize', () => {
    if (attached) {
      attached.screen.resize(process.stdout.columns || 80, process.stdout.rows || 24)
      attached.pty.resize(process.stdout.columns || 80, process.stdout.rows || 24)
    }
    else prompt()
  })
  emitKeypressEvents(keys)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  keys.on('keypress', (str: string | undefined, key: Key) => {
    if (attached || quitting) return
    if (key.sequence === '\x1b[200~') { paste = true; return }
    if (key.sequence === '\x1b[201~') { paste = false; return }
    if (paste && menu) {
      if (str) {
        if (menu.form) insertFormText(menu.form, str)
        else { menu.query += clean(str); menu.selected = 0 }
      }
      prompt(); return
    }
    if (!paste && !menu?.form) {
      if (key.name === 'f2') { openMenu('new'); return }
      if (key.name === 'f3' || key.name === 'f4') { switchSession(key.name === 'f3' ? -1 : 1); return }
      if (key.name === 'f9') { openMenu('settings'); return }
      if (key.name === 'f6' && config.ui.menuKey !== 'f6') { quit(); return }
    }
    if (!paste && menu) {
      if (menu.form) {
        const action = formKey(menu.form, str, key)
        if (action === 'save') saveForm()
        else if (action === 'cancel') { delete menu.form; formAction = null; menu.notice = 'Edit cancelled.' }
        prompt(); return
      }
      if (key.name === 'f5' || config.ui.menuKey === 'f6' && key.name === 'f6' || config.ui.menuKey === 'ctrl-backslash' && key.sequence === '\x1c' || key.name === 'escape' || key.ctrl && key.name === 'c') closeMenu()
      else if (key.ctrl && key.name === 'n') openMenu('new')
      else if (key.ctrl && key.name === 'f') openMenu('chats')
      else if (key.ctrl && key.name === 'g') openMenu('agents')
      else if (key.ctrl && key.name === 'r') openMenu('remote')
      else if (key.ctrl && key.name === 's') openMenu('settings')
      else if (key.ctrl && key.name === 'p') openMenu('commands')
      else if (key.ctrl && key.name === 't' && menu.section === 'remote') {
        const item = menuItems(menu)[menu.selected]
        const connection = item && config.remotes[item.id]
        if (connection) {
          const current = menu
          menu.notice = 'Testing connection…'
          void import('./connections.ts').then(({ checkConnection }) => checkConnection(connection)).then((result) => {
            if (menu === current) { menu.notice = result.message; prompt() }
          }).catch(() => { if (menu === current) { menu.notice = 'Connection test failed. Check the address and network route.'; prompt() } })
        }
      }
      else if (key.ctrl && key.name === 'a' && menu.section === 'remote') connectionForm()
      else if (key.ctrl && key.name === 'a' && menu.section === 'models') modelForm(false)
      else if (key.ctrl && (key.name === 'e' || key.name === 'd') && menu.section === 'remote') {
        const item = menuItems(menu)[menu.selected]
        if (item && item.id !== '@add') {
          if (key.name === 'e') connectionForm(item.id)
          else removeConnection(item.id)
        }
      }
      else if (key.name === 'tab') {
        openMenu(MENU_SECTIONS[(MENU_SECTIONS.indexOf(menu.section) + (key.shift ? MENU_SECTIONS.length - 1 : 1)) % MENU_SECTIONS.length])
      } else if (key.name === 'up' || key.name === 'down') {
        menu.selected = Math.max(0, Math.min(menuItems(menu).length - 1, menu.selected + (key.name === 'up' ? -1 : 1)))
      } else if (key.name === 'return') chooseMenuItem()
      else if (key.ctrl && key.name === 'u') { menu.query = ''; menu.selected = 0 }
      else if (str === '/' && !menu.query) { closeMenu(false); line = '/'; cursor = 1 }
      else if (key.name === 'backspace') { menu.query = menu.query.slice(0, previousCursor(menu.query, menu.query.length)); menu.selected = 0 }
      else if (str && !key.ctrl && !key.meta && !str.includes('\x1b')) { menu.query += clean(str); menu.selected = 0 }
      prompt()
      return
    }
    if (!paste && (key.name === 'f5' || config.ui.menuKey === 'f6' && key.name === 'f6' || config.ui.menuKey === 'ctrl-backslash' && key.sequence === '\x1c')) { openMenu('chats'); return }
    if (!paste && key.ctrl && key.name === 'p') { openMenu('commands'); return }
    if (paste) {
      if (str) { const inserted = str.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); line = line.slice(0, cursor) + inserted + line.slice(cursor); cursor += inserted.length }
    } else if (key.ctrl && key.name === 'c') {
      if (!line) { quit(); return } else { line = ''; cursor = 0; say('^C') }
    } else if (key.ctrl && key.name === 'd' && !line) { quit(); return
    } else if (key.name === 'return') {
      const text = line.trim(); line = ''; cursor = 0
      out('\r\n')
      if (text) commandHistory.push(text)
      historyIndex = commandHistory.length
      try { execute(text) } catch (error) { line = text; cursor = line.length; say(`Stoke: ${clean(error instanceof Error ? error.message : String(error))}`) }
    } else if (key.name === 'left') {
      if (!line) { openMenu('chats'); return } else cursor = previousCursor(line, cursor)
    } else if (key.name === 'right') { cursor = nextCursor(line, cursor)
    } else if (key.ctrl && key.name === 'u') { line = line.slice(cursor); cursor = 0
    } else if (key.ctrl && key.name === 'k') { line = line.slice(0, cursor)
    } else if (key.ctrl && key.name === 'w') {
      const before = line.slice(0, cursor).replace(/\S+\s*$/, '')
      line = before + line.slice(cursor); cursor = before.length
    } else if (key.name === 'home' || key.ctrl && key.name === 'a') { cursor = 0
    } else if (key.name === 'end' || key.ctrl && key.name === 'e') { cursor = line.length
    } else if (key.name === 'backspace' && cursor > 0) {
      const before = previousCursor(line, cursor)
      line = line.slice(0, before) + line.slice(cursor); cursor = before
    } else if (key.name === 'delete') { line = line.slice(0, cursor) + line.slice(nextCursor(line, cursor))
    } else if (key.name === 'up' || key.name === 'down') {
      historyIndex = Math.max(0, Math.min(commandHistory.length, historyIndex + (key.name === 'up' ? -1 : 1)))
      line = commandHistory[historyIndex] ?? ''; cursor = line.length
    } else if (key.name === 'tab') {
      if (!line || line === '/') { openMenu('commands'); return }
      const commands = ['/commands', '/menu', '/detach', '/stop', '/agent', '/models', '/chats', '/attach', '/remote', '/connections', '/settings', '/config', '/new', '/shell', '/continue', '/resume', '/help', '/quit']
      const matches = commands.filter((c) => c.startsWith(line))
      if (matches.length === 1) { line = matches[0] + ' '; cursor = line.length }
      else { say(''); say(matches.join('  ')) }
    } else if (str && !key.ctrl && !key.meta && !str.includes('\x1b')) {
      const inserted = str.replace(/[\x00-\x1f\x7f]/g, '')
      line = line.slice(0, cursor) + inserted + line.slice(cursor); cursor += inserted.length
    }
    prompt()
  })
  process.stdin.on('data', (data: string) => {
    if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null }
    data = consoleInput.take(data, !!attached)
    if (!attached) {
      keys.write(data)
      if (consoleInput.hasPending) escapeTimer = setTimeout(() => { escapeTimer = null; keys.write(consoleInput.flush()) }, 35)
      return
    }
    const target = attached
    const input = agentInput.take(data)
    if (input.forward) attached.pty.write(input.forward)
    if (input.detach) {
      if (input.menu) { openMenu('chats'); return }
      if (input.action) {
        if (input.action === 'new') openMenu('new')
        else if (input.action === 'settings') openMenu('settings')
        else if (input.action === 'detach') quit()
        else switchSession(input.action === 'previous' ? -1 : 1)
        return
      }
      attached = null
      out(SHELL_MODES)
      say('Returned to Stoke. Your chat is still running. /chats to switch; /agent to choose another agent.')
      prompt()
    } else if (agentInput.hasPending || consoleInput.hasPending) {
      escapeTimer = setTimeout(() => {
        escapeTimer = null
        if (attached === target) target.pty.write(agentInput.flush() + consoleInput.flush())
      }, 35)
    }
  })
  out(SHELL_MODES)
  if (requestedChat) restoreChat(requestedChat)
  else if (remoteName) execute(`/remote ${remoteName}`)
  else if (chosen) start()
  else if (config.ui.startup === 'terminal') {
    let last = ''
    try { last = JSON.parse(readFileSync(join(terminalHome(), 'last-session.json'), 'utf8')).id } catch { /* First launch or corrupt selection: choose a live session. */ }
    const live = [...sessions.live.values()].filter((s) => !s.exited && (!folderSet || s.chat.cwd === cwd))
    const previous = live.find((s) => s.chat.id === last) ?? live.at(-1)
    if (previous) attach(previous)
    else {
      try { startShell() } catch (error) { openMenu('new'); const current = menu as MenuView | null; if (current) current.notice = errorText(error); prompt() }
    }
  } else if (config.ui.startup === 'menu') openMenu('chats')
  else {
    out(renderWelcome(cliFor(agent).label, model, clean(cwd), config.ui.theme, process.stdout.columns || 80, ['claude', 'codex', 'opencode'].includes(agent)))
    prompt()
  }
}

void main().catch((error) => {
  process.stderr.write(`stoke: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
