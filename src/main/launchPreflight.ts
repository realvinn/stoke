import { isAbsolute } from 'node:path'
import { accountProblem, resolveLaunchAccount } from '../shared/accounts.ts'
import { DEFAULT_ENDPOINT, endpointProblem } from '../shared/agents.ts'
import { capsFor, cliFor, isClaudeCode, isCodingCliId, type CodingCliId } from '../shared/codingClis.ts'
import { mcpTicksFor, type McpServerSpec } from '../shared/mcpServers.ts'
import { validateClaudeAuth } from '../shared/providers.ts'
import type { Settings } from '../shared/types.ts'
import type { FolderProblem } from '../shared/stokeArgs.ts'
import type { LaunchPreflightItem, LaunchPreflightReport, LaunchPreflightRequest } from '../shared/launchPreflight.ts'

interface Deps {
  settings: () => Settings
  executable: (cli: CodingCliId, override: string | null) => Promise<string | null>
  folder: (cwd: string) => Promise<FolderProblem | null>
  canonical: (cwd: string) => Promise<string>
  tools: (settings: Settings, cli: CodingCliId, cwd: string) => Promise<{ servers: McpServerSpec[] }>
  timeoutMs?: number
}

/** Configuration checks only: no agent, sign-in, MCP connection or repair. */
export class LaunchPreflight {
  private deps: Deps
  private running = false
  constructor(deps: Deps) { this.deps = deps }
  check(raw: unknown): Promise<LaunchPreflightReport> {
    if (this.running) return Promise.reject(new Error('A setup check is still running. Wait before retrying.'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Promise.reject(new Error('Choose a local folder and agent.'))
    const input = raw as Partial<LaunchPreflightRequest>
    if (typeof input.cwd !== 'string' || !input.cwd || input.cwd.length > 4096 || !isAbsolute(input.cwd) || !isCodingCliId(input.cli) || input.accountId !== undefined && (typeof input.accountId !== 'string' || input.accountId.length > 128)) return Promise.reject(new Error('Choose a local folder, agent and account.'))
    const { cwd, cli, accountId } = input as LaunchPreflightRequest
    this.running = true
    const run = this.inspect({ cwd, cli, accountId }).finally(() => { this.running = false })
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([run, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Setup could not be checked within the deadline. Try again when the folder and login shell are available.')), this.deps.timeoutMs ?? 5000)
    })]).finally(() => clearTimeout(timer))
  }
  private async inspect(input: LaunchPreflightRequest): Promise<LaunchPreflightReport> {
    const settings = this.deps.settings()
    const { cwd, cli } = input
    const items: LaunchPreflightItem[] = []
    const add = (id: LaunchPreflightItem['id'], label: string, state: LaunchPreflightItem['state'], message: string): void => { items.push({ id, label, state, message }) }
    const account = resolveLaunchAccount({ cli, requested: input.accountId, accounts: settings.accounts, defaults: settings.agents.defaultAccount })
    const mode = isClaudeCode(cli) ? 'default' : settings.agents.endpoints[cli]?.mode ?? 'default'
    const problem = account.ok && account.account ? accountProblem(account.account, mode) : account.ok ? null : account.message
    const [folderRead, executableRead] = await Promise.allSettled([
      this.deps.folder(cwd),
      this.deps.executable(cli, isClaudeCode(cli) ? settings.claudePath : null)
    ])
    const folder = folderRead.status === 'fulfilled' ? folderRead.value : 'unreachable'
    const executable = executableRead.status === 'fulfilled' ? executableRead.value : null
    const canonical = folder === null ? await this.deps.canonical(cwd) : cwd
    const folderMessages: Record<FolderProblem, string> = {
      missing: 'This folder no longer exists. Choose its new location.',
      'not-a-folder': 'This path is a file. Choose a folder.',
      denied: 'Stoke cannot read this folder. Check its access permissions.',
      unreachable: 'This folder did not answer in time. Check its drive or connection.'
    }
    add('folder', 'Working folder', folder ? 'blocked' : 'configured', folder ? folderMessages[folder] : canonical)
    add('cli', cliFor(cli).label, executable ? 'configured' : 'blocked', executable ? 'Executable located. This check does not run it or verify its version.' : 'Executable not found on Stoke’s login-shell PATH. Check the agent install or configured path in Settings.')
    if (problem) add('account', 'Account', 'blocked', problem)
    else if (account.ok && account.account?.kind === 'login') {
      const homeProblem = await this.deps.folder(account.account.home)
      add('account', 'Account', homeProblem ? 'blocked' : 'configured', homeProblem ? 'The selected account folder is unavailable. Check it in Settings.' : `${account.account.label}. The agent checks its sign-in when launched.`)
    } else add('account', 'Account', 'configured', account.ok && account.account ? `${account.account.label}. Key configured; validity is checked by the agent.` : 'Default account. The agent checks its own sign-in when launched.')
    const ownProvider = account.ok && account.account && (isClaudeCode(cli) || !!account.account.apiProfile)
    const provider = isClaudeCode(cli) && !ownProvider ? validateClaudeAuth(settings.providers) : null
    const providerProblem = ownProvider ? problem : provider && !provider.ok ? provider.message : isClaudeCode(cli) ? null : endpointProblem(cli, settings.agents.endpoints[cli] ?? DEFAULT_ENDPOINT, settings.providers.openrouterApiKey)
    add('provider', 'Provider and model', providerProblem ? 'blocked' : 'configured', providerProblem ?? 'Configuration is present. Model access, credentials and quota are checked by the agent; no provider request was made.')
    const ticks = mcpTicksFor(settings.agents.mcp, cli)
    if (capsFor(cli).mcp === 'none') add('tools', 'Tools (MCP)', ticks.length ? 'warning' : 'configured', 'This agent has no Stoke launch-time MCP route. Its native configuration remains its own.')
    else if (folder) add('tools', 'Tools (MCP)', 'warning', 'Choose an available working folder before checking its tools.')
    else {
      try {
        const tools = await this.deps.tools(settings, cli, canonical)
        const available = new Set(tools.servers.map(server => server.name))
        const missing = ticks.filter(name => !available.has(name))
        const empty = tools.servers.some(server => Object.values(server.env).some(value => !value.trim()) || Object.values(server.headers).some(value => !value.trim()))
        add('tools', 'Tools (MCP)', missing.length || empty ? 'warning' : 'configured', `${tools.servers.length} selected server${tools.servers.length === 1 ? '' : 's'} resolved for Stoke to supply.${missing.length ? ` ${missing.length} selection${missing.length === 1 ? ' is' : 's are'} not supplied here; check Tools in Settings and the agent’s native configuration.` : ''}${empty ? ' Some configured environment or header values are empty; review the server’s required credentials.' : ''} Connections and authentication were not tested.`)
      } catch { add('tools', 'Tools (MCP)', 'warning', 'Tool configuration could not be read. Review Tools in Settings; no server was started or contacted.') }
    }
    return { cwd: canonical, cli, checkedAt: Date.now(), items }
  }
}
