/*
 * The coding agents: what is stored, what is shown, what each launch is handed,
 * and what an install runs.
 *
 * The launch plans are the part worth the most care, for two reasons that fail
 * silently. A plan that forgets a model sends Grok Build to the FIRST model an
 * endpoint lists (measured: an obscure 27B model on OpenRouter), and one that
 * leaves a key in argv puts it in the process table where anything on the
 * machine can read it. Neither throws. So every plan is asserted exactly, and
 * every key is asserted to be in `env` and nowhere in `args`.
 *
 * The install script is the other: it is built from a table and run in a
 * shell, so the suite checks that nothing the renderer sends can become part of
 * a command — only ids that name a table entry survive.
 *
 *   node scripts/verify-agents.mts
 */
import {
  agentLaunchPlan,
  DEFAULT_ENDPOINT,
  endpointProblem,
  ENV_CUSTOM_BASE_URL,
  ENV_CUSTOM_KEY,
  ENV_CUSTOM_MODEL,
  ENV_MCP_TOKEN,
  ENV_OPENROUTER_KEY,
  hydrateAgents,
  hydrateEndpoint,
  httpUrlMcpConfig,
  installScript,
  installSteps,
  powershellEncode,
  scriptFor,
  isEndpointUrl,
  NO_KEY,
  OPENROUTER_OPENAI_BASE_URL,
  PI_PROVIDER_EXTENSION,
  tomlString,
  visibleAgents,
  type AgentEndpoint,
  type LaunchPlanInput
} from '../src/shared/agents.ts'
import { CLI_CAPS, CODING_CLIS, type CodingCliId } from '../src/shared/codingClis.ts'
import { SHARED_SKILLS_DIR, SKILL_DIRS, skillReport } from '../src/shared/skills.ts'
import { scanSkills } from '../src/main/skillsScan.ts'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`)
}

const KEY = 'sk-or-v1-secret'
const CUSTOM_KEY = 'sk-custom-secret'
const MCP = { url: 'http://127.0.0.1:50465/mcp', token: 'mcp-token-secret' }
const or = (model = 'anthropic/claude-sonnet-5'): AgentEndpoint => ({ ...DEFAULT_ENDPOINT, mode: 'openrouter', model })
const custom = (over: Partial<AgentEndpoint> = {}): AgentEndpoint => ({
  mode: 'custom',
  model: 'qwen3-coder',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: CUSTOM_KEY,
  ...over
})
const plan = (id: CodingCliId, endpoint: AgentEndpoint | undefined, over: Partial<LaunchPlanInput> = {}) =>
  agentLaunchPlan({
    id,
    endpoint,
    openrouterKey: KEY,
    continueLast: false,
    mcp: null,
    piExtensionPath: '/Users/u/Library/Application Support/Stoke/agents/pi-provider.ts',
    ...over
  })
const planOk = (r: ReturnType<typeof plan>) => (r.ok ? r.plan : { args: ['<refused>'], env: {} as Record<string, string> })

/** No secret may appear in argv: `ps` shows every argument of every process. */
function keysOnlyInEnv(name: string, r: ReturnType<typeof plan>): void {
  const p = planOk(r)
  const argv = p.args.join('\u0000')
  ok(`${name}: no key in argv`, ![KEY, CUSTOM_KEY, MCP.token].some((k) => argv.includes(k)), JSON.stringify(p.args))
}

console.log('\nwhat is stored')
check('nothing stored is never asked', hydrateAgents(undefined), { chosen: null, endpoints: {} })
check('junk is never asked, not "nothing chosen"', hydrateAgents({ chosen: 'codex' }).chosen, null)
check('an empty choice is kept — it means "show none"', hydrateAgents({ chosen: [] }).chosen, [])
check(
  'unknown ids are dropped and duplicates collapse',
  hydrateAgents({ chosen: ['codex', 'banana', 'codex', 'pi'] }).chosen,
  ['codex', 'pi']
)
check(
  'an endpoint is rebuilt from named keys, trimmed, with no trailing slash',
  hydrateEndpoint({ mode: 'custom', model: ' m ', baseUrl: 'http://h/v1///', apiKey: ' k ', extra: 1 }),
  { mode: 'custom', model: 'm', baseUrl: 'http://h/v1', apiKey: 'k' }
)
check('an unknown mode is the default sign-in', hydrateEndpoint({ mode: 'magic' }).mode, 'default')
check(
  "Claude's endpoint is Settings › Providers, never here (one writer, gotcha 57)",
  hydrateAgents({ endpoints: { claude: or(), codex: or() } }).endpoints,
  { codex: or() }
)
check(
  'an untouched default endpoint is not stored at all',
  hydrateAgents({ endpoints: { codex: DEFAULT_ENDPOINT } }).endpoints,
  {}
)

console.log('\nwhat the launcher shows')
{
  const installed = new Set<CodingCliId>(['claude', 'codex', 'opencode'])
  check('before the picker is answered: everything installed', visibleAgents(null, installed), ['claude', 'codex', 'opencode'])
  check('after: what was chosen AND is installed', visibleAgents(['codex', 'pi'], installed), ['codex'])
  check('in table order, not click order', visibleAgents(['opencode', 'codex'], installed), ['codex', 'opencode'])
}

console.log('\nrefusing a launch that would not work')
check('the default needs nothing', endpointProblem('codex', DEFAULT_ENDPOINT, ''), null)
ok('OpenRouter with no key says where the key goes', /Settings › Providers/.test(endpointProblem('codex', or(), '') ?? ''))
ok('OpenRouter with no model says so', /no model/.test(endpointProblem('grok', or(''), KEY) ?? ''))
ok('a custom endpoint needs an http(s) URL', /http\(s\)/.test(endpointProblem('opencode', custom({ baseUrl: 'ftp://h' }), KEY) ?? ''))
check('a custom endpoint with no key is allowed — local servers take none', endpointProblem('opencode', custom({ apiKey: '' }), KEY), null)
check('isEndpointUrl refuses a bare word', isEndpointUrl('localhost'), false)
check('and accepts a LAN address', isEndpointUrl('http://192.168.1.4:8080/v1'), true)
{
  const r = plan('codex', or(''))
  ok('the refusal reaches the launch rather than a CLI on its own sign-in', !r.ok && /model/.test(r.ok ? '' : r.message))
}

console.log('\ncodex: -c overrides, Responses API, nothing written to config.toml')
{
  const r = plan('codex', or())
  check('OpenRouter', planOk(r), {
    args: [
      '-c', 'model_provider="stoke_openrouter"',
      '-c', 'model_providers.stoke_openrouter.name="OpenRouter"',
      '-c', `model_providers.stoke_openrouter.base_url="${OPENROUTER_OPENAI_BASE_URL}"`,
      '-c', `model_providers.stoke_openrouter.env_key="${ENV_OPENROUTER_KEY}"`,
      '-m', 'anthropic/claude-sonnet-5'
    ],
    env: { [ENV_OPENROUTER_KEY]: KEY }
  })
  keysOnlyInEnv('codex openrouter', r)
  const c = plan('codex', custom({ apiKey: '' }))
  check('a custom endpoint with no key gets the placeholder, not an empty var', planOk(c).env[ENV_CUSTOM_KEY], NO_KEY)
  const m = plan('codex', undefined, { mcp: MCP })
  check('Stoke’s browser tools ride in as an MCP server, token by env var name', planOk(m), {
    args: [
      '-c', `mcp_servers.stoke.url="${MCP.url}"`,
      '-c', `mcp_servers.stoke.bearer_token_env_var="${ENV_MCP_TOKEN}"`
    ],
    env: { [ENV_MCP_TOKEN]: MCP.token }
  })
  keysOnlyInEnv('codex mcp', m)
  check('continue is its resume subcommand, after the global flags', planOk(plan('codex', or(), { continueLast: true })).args.slice(-2), ['resume', '--last'])
  check('a TOML string escapes a quote', tomlString('a"b'), '"a\\"b"')
}

console.log('\nopencode: built-in OpenRouter, everything else in OPENCODE_CONFIG_CONTENT')
{
  const r = plan('opencode', or('z-ai/glm-5'))
  check('OpenRouter', planOk(r), { args: ['-m', 'openrouter/z-ai/glm-5'], env: { OPENROUTER_API_KEY: KEY } })
  const c = planOk(plan('opencode', custom(), { mcp: MCP }))
  const cfg = JSON.parse(c.env.OPENCODE_CONFIG_CONTENT ?? '{}')
  check('custom: the model is addressed through Stoke’s provider', c.args, ['-m', 'stoke_custom/qwen3-coder'])
  check('custom: an openai-compatible provider at the base URL', cfg.provider?.stoke_custom?.options?.baseURL, 'http://127.0.0.1:11434/v1')
  check('custom: the key by reference, not by value', cfg.provider?.stoke_custom?.options?.apiKey, `{env:${ENV_CUSTOM_KEY}}`)
  check('custom: the value in the environment', c.env[ENV_CUSTOM_KEY], CUSTOM_KEY)
  check('mcp: a remote server at Stoke’s URL', cfg.mcp?.stoke?.url, MCP.url)
  check('the default sign-in with no MCP sets nothing at all', planOk(plan('opencode', undefined)), { args: [], env: {} })
  check('continue', planOk(plan('opencode', undefined, { continueLast: true })).args, ['--continue'])
}

console.log('\ngrok build: GROK_MODELS_BASE_URL, and -m is not optional')
{
  const r = plan('grok', or('x-ai/grok-5'))
  check('OpenRouter: the xAI base moves too, or a key that is not xAI’s reads as "Not signed in"', planOk(r), {
    args: ['-m', 'x-ai/grok-5'],
    env: {
      GROK_MODELS_BASE_URL: OPENROUTER_OPENAI_BASE_URL,
      GROK_XAI_API_BASE_URL: OPENROUTER_OPENAI_BASE_URL,
      XAI_API_KEY: KEY
    }
  })
  keysOnlyInEnv('grok', r)
  check('custom', planOk(plan('grok', custom())).env.GROK_MODELS_BASE_URL, 'http://127.0.0.1:11434/v1')
}

console.log('\npi: --provider openrouter, and a Stoke-owned extension for anything else')
{
  check('OpenRouter', planOk(plan('pi', or())), {
    args: ['--provider', 'openrouter', '--model', 'anthropic/claude-sonnet-5'],
    env: { OPENROUTER_API_KEY: KEY }
  })
  const c = plan('pi', custom())
  check('custom: the extension, then the provider it registers', planOk(c).args.slice(0, 4), [
    '-e', '/Users/u/Library/Application Support/Stoke/agents/pi-provider.ts', '--provider', 'stoke_custom'
  ])
  check('custom: endpoint, key and model all through the environment', Object.keys(planOk(c).env).sort(), [
    ENV_CUSTOM_BASE_URL, ENV_CUSTOM_KEY, ENV_CUSTOM_MODEL
  ].sort())
  keysOnlyInEnv('pi custom', c)
  ok('with no extension file the launch is refused, not silently on Pi’s default', !plan('pi', custom(), { piExtensionPath: null }).ok)
  ok(
    'the extension holds no secret — only the names of the variables',
    [ENV_CUSTOM_BASE_URL, ENV_CUSTOM_KEY, ENV_CUSTOM_MODEL].every((v) => PI_PROVIDER_EXTENSION.includes(v)) &&
      !PI_PROVIDER_EXTENSION.includes('sk-')
  )
}

console.log('\nqwen, kimi, copilot: environment only, and every key in it')
{
  const q = plan('qwen', or('qwen/qwen3-coder'))
  check('qwen: --auth-type on the command line, the key in env', planOk(q), {
    args: ['--auth-type', 'openai', '-m', 'qwen/qwen3-coder'],
    env: { OPENAI_BASE_URL: OPENROUTER_OPENAI_BASE_URL, OPENAI_API_KEY: KEY }
  })
  keysOnlyInEnv('qwen', q)
  const k = plan('kimi', or('moonshotai/kimi-k3'))
  check('kimi: a provider synthesised from four variables, typed openai (the default is kimi)', planOk(k), {
    args: [],
    env: {
      KIMI_MODEL_NAME: 'moonshotai/kimi-k3',
      KIMI_MODEL_API_KEY: KEY,
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: OPENROUTER_OPENAI_BASE_URL
    }
  })
  const c = plan('copilot', custom())
  check('copilot: its own BYO-provider variables, model included', planOk(c), {
    args: [],
    env: {
      COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1',
      COPILOT_PROVIDER_API_KEY: CUSTOM_KEY,
      COPILOT_MODEL: 'qwen3-coder'
    }
  })
  const files = { claude: '/u/Stoke/mcp-browser.json', httpUrl: '/u/Stoke/agents/mcp-httpurl.json' }
  check(
    'copilot: Stoke’s own MCP file, by path, so the token is not in argv',
    planOk(plan('copilot', undefined, { mcpFiles: files })).args,
    ['--additional-mcp-config', '@/u/Stoke/mcp-browser.json']
  )
  check(
    'qwen: the httpUrl-shaped file — a plain url is SSE there and never connects',
    planOk(plan('qwen', undefined, { mcpFiles: files })).args,
    ['--mcp-config', '/u/Stoke/agents/mcp-httpurl.json']
  )
  check(
    'the httpUrl file carries the bearer as a header',
    JSON.parse(httpUrlMcpConfig(MCP)).mcpServers.stoke,
    { httpUrl: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } }
  )
  ok('gemini refuses OpenRouter rather than silently using its own sign-in', !plan('gemini', or()).ok)
  ok('and so do cursor and amp', !plan('cursor', or()).ok && !plan('amp', custom()).ok)
}

console.log('\nkilo reads OpenCode’s inline config under its own name; aider takes LiteLLM prefixes')
{
  const k = planOk(plan('kilo', custom(), { mcp: MCP }))
  ok('kilo: KILO_CONFIG_CONTENT, not OpenCode’s variable', !!k.env.KILO_CONFIG_CONTENT && !('OPENCODE_CONFIG_CONTENT' in k.env))
  check('kilo: the same provider and MCP shape', Object.keys(JSON.parse(k.env.KILO_CONFIG_CONTENT ?? '{}')).sort(), ['mcp', 'provider'])
  check('aider: openrouter/<model> with OPENROUTER_API_KEY', planOk(plan('aider', or('deepseek/deepseek-v4'))), {
    args: ['--model', 'openrouter/deepseek/deepseek-v4'],
    env: { OPENROUTER_API_KEY: KEY }
  })
  check('aider: openai/<model> at OPENAI_API_BASE for a custom endpoint', planOk(plan('aider', custom())), {
    args: ['--model', 'openai/qwen3-coder'],
    env: { OPENAI_API_BASE: 'http://127.0.0.1:11434/v1', OPENAI_API_KEY: CUSTOM_KEY }
  })
  check('aider continues by restoring the folder’s chat', planOk(plan('aider', undefined, { continueLast: true })).args, ['--restore-chat-history'])
  ok('crush, droid and cline refuse an endpoint rather than ignore it', ['crush', 'droid', 'cline'].every((id) => !plan(id as CodingCliId, or()).ok))
}

console.log('\nidentity: a file named after the agent is not always the agent')
{
  const byId = (id: CodingCliId) => CODING_CLIS.find((c) => c.id === id)!
  const grok = byId('grok').identify!
  const amp = byId('amp').identify!
  ok('Grok Build’s own version line is Grok Build', grok.test('grok 1.0.34 (3736acbc8658)'))
  ok('the community grok-cli’s bare version is not', !grok.test('1.1.7'))
  ok('nor is Homebrew’s regex tool', !grok.test('grok v0.1.0'))
  ok('Amp’s version is Amp', amp.test('0.0.1789790452-gad4023'))
  ok('Homebrew’s amp editor is not', !amp.test('amp 0.7.1'))
  ok('cursor looks for cursor-agent, never the bare `agent` Grok also installs', !byId('cursor').bins.posix.includes('agent'))
}

console.log('\nevery agent: a continue flag only where CLI_CAPS says there is one')
for (const c of CODING_CLIS) {
  if (c.id === 'claude') continue
  const args = planOk(plan(c.id, undefined, { continueLast: true })).args
  ok(
    `${c.id}: continuing ${CLI_CAPS[c.id].resume === 'continue' ? 'appends its flag' : 'appends nothing'}`,
    CLI_CAPS[c.id].resume === 'continue' ? args.join(' ').endsWith((c.continueArgs ?? []).join(' ')) : args.length === 0,
    JSON.stringify(args)
  )
}
check('claude is never planned here — its launch is buildArgs', planOk(plan('claude', or())), { args: [], env: {} })

console.log('\ninstalling')
{
  check('only ids from the table survive', installSteps(['codex', '$(rm -rf ~)', 'banana'], 'darwin').map((s) => s.id), ['codex'])
  check('in table order', installSteps(['pi', 'codex'], 'linux').map((s) => s.id), ['codex', 'pi'])
  const mac = installScript(['codex', 'pi'], 'darwin') ?? ''
  ok(
    'the script runs each vendor command verbatim — codex told not to stop and ask',
    mac.includes('( curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh )')
  )
  ok('and says what each needs first', /needs %s\\n' 'Node\.js 22\.19 or newer'/.test(mac), mac)
  ok('a failure is recorded and the rest still run', (mac.match(/\|\| failed=/g) ?? []).length === 2)
  ok('and the script exits non-zero if any failed, which the exit card reads', /exit 1; fi/.test(mac))
  /*
   * Run for real — but only ever a SYNTHETIC step, never a table command. The
   * first version of this test built the script from the table and swapped the
   * vendor URL with `String.replace`, which replaces the first occurrence: the
   * printed one. The executed line still fetched the real installer, and two
   * runs upgraded this machine's Codex and installed Pi globally. So the step
   * below is made up, and the script is built with `scriptFor`.
   *
   * What it proves: a download that fails must fail its step. Without pipefail
   * `curl … | sh` took sh's status — 0 on an empty pipe — and the tab printed
   * "Done." (found by review).
   */
  {
    const fake = scriptFor(
      [
        { id: 'codex', label: 'Unreachable', command: 'curl -fsSL http://127.0.0.1:9/none | sh' },
        { id: 'pi', label: 'Harmless', command: 'true' }
      ],
      'darwin'
    ) ?? ''
    ok('the synthetic script runs no table command', !/https:\/\//.test(fake))
    const r = spawnSync('/bin/bash', ['-c', fake], { encoding: 'utf8', timeout: 20_000, cwd: tmpdir() })
    ok(
      'a failed download fails its step, the next step still runs, and the script exits 1 naming it',
      r.status === 1 && /Did not install:.*Unreachable/.test(r.stdout) && /Installing.*Harmless/s.test(r.stdout),
      `status ${r.status}: ${JSON.stringify(r.stdout.slice(-240))}`
    )
  }
  const win = installScript(['codex', 'copilot'], 'win32') ?? ''
  const decode = (b64: string): string => {
    const bin = atob(b64)
    let out = ''
    for (let i = 0; i < bin.length; i += 2) out += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8))
    return out
  }
  const encoded = [...win.matchAll(/-EncodedCommand (\S+)/g)].map((m) => decode(m[1]))
  ok(
    'windows: each step in its OWN PowerShell, so a vendor script’s `exit` ends only its step and its exit code is its own',
    encoded.length === 2 &&
      encoded[1] ===
        'winget install --id GitHub.Copilot -e --source winget --accept-source-agreements --accept-package-agreements; if (@(-1978335189, -1978335135) -contains $LASTEXITCODE) { exit 0 }; exit $LASTEXITCODE',
    JSON.stringify(encoded)
  )
  ok(
    'a winget step counts "already installed" (0x8A15002B / 0x8A150061) as installed, and only a winget step does',
    encoded[1].includes('-1978335189') && !encoded[0].includes('-1978335189')
  )
  ok('every winget command in the table is non-interactive and exact', CODING_CLIS.every((c) => !c.install.win32?.startsWith('winget ') || /--id \S+ -e --source winget --accept-source-agreements --accept-package-agreements$/.test(c.install.win32)))

  /*
   * A fresh Windows has no Node.js, and every `npm install -g` agent needs it.
   * The script installs it first (winget's Node LTS), re-reads PATH so the npm
   * steps can see it, and marks those steps failed — never runs them into a
   * wall — when it cannot. PATH is re-read before EVERY step, deduplicated.
   */
  const npmWin = installScript(['claude', 'gemini'], 'win32') ?? ''
  const plainWin = installScript(['claude', 'codex'], 'win32') ?? ''
  ok('a script with an npm agent installs Node first, when npm is missing', /if \(-not \(Get-Command npm[\s\S]*winget install --id OpenJS\.NodeJS\.LTS -e --source winget/.test(npmWin))
  ok('naming who needs it', npmWin.includes("Installing Node.js, needed by Gemini CLI'"))
  ok('and with no winget, says where to get Node rather than failing obscurely', /no winget to install it with\. Get it from https:\/\/nodejs\.org/.test(npmWin))
  ok('the npm step is skipped and marked failed when Node is still missing', npmWin.includes("if ($nodeMissing) { $failed += 'Gemini CLI' } else {"))
  ok('a script with no npm agent carries no Node step at all', !plainWin.includes('OpenJS.NodeJS.LTS') && !plainWin.includes('$nodeMissing'))
  ok('PATH is re-read from the registry before every step', (npmWin.match(/^Update-StokePath$/gm) ?? []).length === 3)
  ok('and deduplicated, or eighteen steps could pass the 32,767-character limit', /ContainsKey\(\$p\.ToLowerInvariant\(\)\)/.test(npmWin))
  /*
   * pty.ts hands the whole script to powershell.exe as ONE -EncodedCommand
   * argument (installerArgs), and a Windows command line is capped at 32,767
   * characters. Every agent at once — "select all" in the picker — measured
   * 25,024 encoded on 2026-09-21. Held under 30,000 so a new agent that would
   * push it over fails here, not as a tab that dies on CreateProcess.
   */
  {
    const everyWin = installScript(CODING_CLIS.filter((c) => c.install.win32).map((c) => c.id), 'win32') ?? ''
    const encodedLength = powershellEncode(everyWin).length
    ok(`every Windows agent at once fits one command line: ${encodedLength} encoded characters, under 30,000 of Windows' 32,767`, encodedLength < 30_000)
  }

  /*
   * Run through a real PowerShell where there is one (CI's ubuntu runner ships
   * pwsh). Every generated Windows script must PARSE — a syntax slip here is a
   * red card on every Windows machine and nothing else would see it — and a
   * synthetic one is EXECUTED, with `powershell.exe` stood in for by a
   * function. Synthetic steps only, never a table command (the rule above).
   */
  const pwsh = [process.env.STOKE_PWSH, ...(process.env.PATH ?? '').split(delimiter).map((d) => d && join(d, 'pwsh'))].find(
    (p): p is string => !!p && existsSync(p)
  )
  if (!pwsh) {
    console.log('  NOTE  no PowerShell here (set STOKE_PWSH to one): the Windows scripts are read above, not parsed or run. CI runs them.')
  } else {
    const parseErrors = (script: string): string[] => {
      const r = spawnSync(
        pwsh,
        ['-NoProfile', '-NonInteractive', '-Command', '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }'],
        { input: script, encoding: 'utf8', timeout: 60_000 }
      )
      return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    }
    const every = installScript(CODING_CLIS.map((c) => c.id), 'win32') ?? ''
    check('the Windows script for EVERY agent parses in PowerShell', parseErrors(every), [])
    const synthetic = scriptFor(
      [
        { id: 'claude', label: 'Works', command: 'Write-Output step-one-ran' },
        { id: 'codex', label: 'Breaks', command: 'exit 3' },
        { id: 'grok', label: 'After', command: 'Write-Output step-three-ran' }
      ],
      'win32'
    ) ?? ''
    // A file and -File, not stdin: `-Command -` reads line by line like a
    // prompt, so a multi-line function and `exit` do not behave as in a script.
    const shim = `function powershell.exe { & '${pwsh.replace(/'/g, "''")}' @args }\n`
    const dir = mkdtempSync(join(tmpdir(), 'stoke-winscript-'))
    const file = join(dir, 'install.ps1')
    writeFileSync(file, shim + synthetic + '\n')
    const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', timeout: 120_000, cwd: dir })
    rmSync(dir, { recursive: true, force: true })
    ok(
      'windows, run: a failing step is named, the steps after it still run, and the script exits 1',
      run.status === 1 && /step-one-ran/.test(run.stdout) && /step-three-ran/.test(run.stdout) && /Did not install: Breaks/.test(run.stdout),
      `status ${run.status}: ${JSON.stringify((run.stdout + run.stderr).slice(-400))}`
    )
  }
  ok('codex on windows is told not to stop and ask, too', encoded[0]?.startsWith('$env:CODEX_NON_INTERACTIVE="1";') === true, encoded[0])
  check('powershellEncode survives non-ASCII', decode(powershellEncode('Write-Host "héllo — ✓"')), 'Write-Host "héllo — ✓"')
  ok('a failed step is recorded and the script exits 1 on any', win.includes("$failed += 'Copilot CLI'") && /exit 1 }/.test(win))
  check('nothing to install is no script at all', installScript(['banana'], 'darwin'), null)
  for (const c of CODING_CLIS) {
    for (const plat of ['darwin', 'linux', 'win32'] as const) {
      const cmd = c.install[plat]
      if (!cmd) continue
      ok(
        `${c.id}/${plat}: an https source or a package manager, and no single quote to break the printf`,
        /https:\/\/|^npm install -g |^winget install /.test(cmd) && !cmd.includes("'"),
        cmd
      )
    }
  }
}

console.log('\nskills: who can see what, from a fake home (never the real one — gotcha 74)')
{
  const home = mkdtempSync(join(tmpdir(), 'stoke-skills-'))
  const skill = (dir: string, name: string): string => {
    const at = join(home, dir, name)
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
    return at
  }
  try {
    const shared = skill('.agents/skills', 'shared-one')
    mkdirSync(join(home, '.claude/skills'), { recursive: true })
    symlinkSync(shared, join(home, '.claude/skills', 'shared-one'))
    skill('.claude/skills', 'claude-only')
    skill('.claude/skills', 'copied')
    skill('.codex/skills', 'copied')
    mkdirSync(join(home, '.agents/skills', 'not-a-skill'), { recursive: true })
    const scans = await scanSkills(home)
    const names = (dir: string) => scans.find((x) => x.dir === dir)?.skills.map((k) => k.name)
    check('a folder with no SKILL.md is not a skill', names('~/.agents/skills'), ['shared-one'])
    check('a link counts in the folder it sits in', names('~/.claude/skills'), ['claude-only', 'copied', 'shared-one'])
    const r = skillReport(scans, ['claude', 'codex', 'cursor', 'aider'])
    check('three distinct skills', r.total, 3)
    check('per agent — Codex sees its own ~/.codex/skills too', r.perAgent, [
      { id: 'claude', visible: 3 },
      { id: 'codex', visible: 2 },
      { id: 'cursor', visible: 3 },
      { id: 'aider', visible: 0 }
    ])
    check(
      'the Claude-only skill is the one Codex misses — and Aider, which has no skills, misses nothing',
      r.partial.map((x) => [x.name, x.missing]),
      [['claude-only', ['codex']]]
    )
    check('a link is one skill, not a copy; two real folders are', r.duplicated.map((x) => x.name), ['copied'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  ok('every agent has a skills entry, so a new one cannot be forgotten', CODING_CLIS.every((c) => Array.isArray(SKILL_DIRS[c.id])))
  ok('and the shared folder is in nearly all of them', CODING_CLIS.filter((c) => SKILL_DIRS[c.id].includes(SHARED_SKILLS_DIR)).length >= CODING_CLIS.length - 2)
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
