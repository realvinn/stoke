import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaunchPreflight } from '../src/main/launchPreflight.ts'
import { launchFolderProblem, realpathFolder } from '../src/main/folderCheck.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { STOKE_BROWSER_SERVER } from '../src/shared/mcpServers.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const okay = JSON.stringify(actual) === JSON.stringify(expected)
  if (!okay) failures++
  console.log(`  ${okay ? 'PASS' : 'FAIL'} ${name}${okay ? '' : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`)
}
async function rejection(run: Promise<unknown>): Promise<string> { try { await run; return '' } catch (error) { return error instanceof Error ? error.message : String(error) } }
const root = await mkdtemp(join(tmpdir(), 'stoke-launch-setup-'))
try {
  const file = join(root, 'not-a-folder.txt'); await writeFile(file, 'untouched')
  let settings = hydrateSettings({})
  let calls = 0
  const service = new LaunchPreflight({
    settings: () => settings,
    executable: async () => { calls++; return file },
    folder: launchFolderProblem,
    canonical: realpathFolder,
    tools: async () => ({ servers: [] })
  })
  console.log('\nLauncher preflight: configuration, not a sign-in or command run')
  const good = await service.check({ cwd: root, cli: 'claude' })
  check('all five configuration checks share the selected agent and canonical folder', [good.cli, good.cwd, good.items.map(item => item.id)], ['claude', await realpathFolder(root), ['folder', 'cli', 'account', 'provider', 'tools']])
  check('a default account does not claim an authenticated session', good.items.find(item => item.id === 'account')?.message.includes('checks its own sign-in'), true)
  check('MCP availability is separate from authentication', good.items.find(item => item.id === 'tools')?.message.includes('not tested'), true)
  check('the executable and working files are never changed', await readFile(file, 'utf8'), 'untouched')
  check('a real file cannot pass as a working folder', (await service.check({ cwd: file, cli: 'claude' })).items.find(item => item.id === 'folder')?.state, 'blocked')
  const missing = await service.check({ cwd: join(root, 'gone'), cli: 'claude' })
  check('an unavailable working folder prevents a tool read for that path', missing.items.find(item => item.id === 'tools')?.state, 'warning')
  const before = calls
  for (const raw of [null, [], { cwd: root, cli: 'invented' }, { cwd: 'relative', cli: 'claude' }, { cwd: root, cli: 'claude', accountId: 99 }]) check('malformed requests fail before executable lookup', !!await rejection(service.check(raw)), true)
  check('malformed input starts no lookup', calls, before)

  console.log('\nLauncher preflight: selected accounts, keys and tool configuration')
  settings = hydrateSettings({ providers: { claudeAuth: 'anthropic' } })
  check('missing provider keys appear before a launch attempt', (await service.check({ cwd: root, cli: 'claude' })).items.find(item => item.id === 'provider')?.state, 'blocked')
  settings = hydrateSettings({ accounts: { 'codex-work': { id: 'codex-work', cli: 'codex', kind: 'key', label: 'Work', home: '', apiKey: '' } } })
  check('the chosen key account is validated by the actual account rules', (await service.check({ cwd: root, cli: 'codex', accountId: 'codex-work' })).items.find(item => item.id === 'account')?.state, 'blocked')
  check('a named account from another agent never falls back to Default', (await service.check({ cwd: root, cli: 'claude', accountId: 'codex-work' })).items.find(item => item.id === 'account')?.state, 'blocked')
  settings = hydrateSettings({ accounts: { 'claude-work': { id: 'claude-work', cli: 'claude', kind: 'login', label: 'Work', home: join(root, 'missing-home'), apiKey: '' } } })
  check('a missing account home is not repaired or silently created', (await service.check({ cwd: root, cli: 'claude', accountId: 'claude-work' })).items.find(item => item.id === 'account')?.state, 'blocked')
  settings = hydrateSettings({ providers: { claudeAuth: 'anthropic', anthropicApiKey: 'fixture-provider-private-value' }, agents: { mcp: { perAgent: { claude: ['fixture', STOKE_BROWSER_SERVER] }, extra: {} } } })
  const withTools = new LaunchPreflight({ settings: () => settings, executable: async () => file, folder: launchFolderProblem, canonical: realpathFolder, tools: async () => ({ servers: [{ name: 'fixture', transport: 'http', command: '', args: [], url: 'https://fixture.invalid', env: {}, headers: { Authorization: 'fixture-tool-private-value', Missing: '' } }] }) })
  const tools = await withTools.check({ cwd: root, cli: 'claude' })
  check('empty configured credentials and unavailable selections need review', [tools.items.find(item => item.id === 'tools')?.state, tools.items.find(item => item.id === 'tools')?.message.includes('empty')], ['warning', true])
  check('neither provider nor MCP credential values reach the public report', /fixture-(provider|tool)-private-value/.test(JSON.stringify(tools)), false)

  console.log('\nLauncher preflight: settings capture, parallel claims and deadlines')
  let release!: (value: string) => void; let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  const pendingExecutable = new Promise<string>(resolve => { release = resolve })
  settings = hydrateSettings({ providers: { claudeAuth: 'anthropic' } })
  const slow = new LaunchPreflight({ settings: () => settings, executable: async () => { began(); return pendingExecutable }, folder: async () => null, canonical: async cwd => cwd, tools: async () => ({ servers: [] }), timeoutMs: 30 })
  const pending = rejection(slow.check({ cwd: root, cli: 'claude' })); await started
  settings = hydrateSettings({})
  check('a simultaneous check is refused before any new work', (await rejection(slow.check({ cwd: root, cli: 'claude' }))).includes('still running'), true)
  check('a bounded caller deadline does not release real I/O ownership', [(await pending).includes('deadline'), (await rejection(slow.check({ cwd: root, cli: 'claude' }))).includes('still running')], [true, true])
  release(file)
  await new Promise(resolve => setTimeout(resolve, 10))
  check('the claim releases after actual work settles', !!await rejection(slow.check({ cwd: root, cli: 'claude' })), false)

  let complete!: (value: string) => void
  const lookup = new Promise<string>(resolve => { complete = resolve })
  settings = hydrateSettings({ providers: { claudeAuth: 'anthropic' } })
  const captured = new LaunchPreflight({ settings: () => settings, executable: async () => lookup, folder: launchFolderProblem, canonical: realpathFolder, tools: async () => ({ servers: [] }) })
  const old = captured.check({ cwd: root, cli: 'claude' }); settings = hydrateSettings({}); complete(file)
  check('a settings change cannot replace the configuration being checked mid-read', (await old).items.find(item => item.id === 'provider')?.state, 'blocked')
} finally { await rm(root, { recursive: true, force: true }) }
console.log(`\n${failures ? `${failures} failures` : 'All launch setup checks passed'}`)
process.exitCode = failures ? 1 : 0
