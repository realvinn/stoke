import { createServer as createHttpServer } from 'node:http'
/*
 * The packaged-app probe: boot a real, PACKAGED Stoke and drive it over CDP
 * through the flows a person depends on, on the machine it runs on.
 *
 *   node scripts/probe-e2e.mts --app <Stoke.app | win-unpacked | linux-unpacked> --work <dir>
 *   node scripts/probe-e2e.mts --dev --work <dir>          the unpackaged build in out/, for a rehearsal
 *       [--port 9339]   the CDP port
 *       [--ssh]         also the SSH checks — CI only (see below)
 *
 * NOT a verify suite and never in `check`: it launches the app, and every check
 * acts on the machine (the same header rule as windows-e2e.mts). ci.yml's
 * `probe` job runs it on every target in scripts/targets.mjs (`--probe-matrix`),
 * against the `electron-builder --dir` build of that target.
 *
 * What it proves, each against the real app — never a copy of its logic:
 *
 *   boot       the window comes up, `window.stoke.platform` is this OS, and the
 *              shell is NOT inert (gotcha 88: a first-run gate left up would
 *              leave nothing typeable)
 *   session    `stoke <folder> --new`'s own argv, sent to the running app as a
 *              second instance (stokeArgs.ts), opens a Claude tab whose process
 *              got `--session-id`, `--settings` and `--mcp-config`; keystrokes
 *              reach it; its statusLine command ran Stoke's shim, which is
 *              Stoke's binary with ELECTRON_RUN_AS_NODE — so the payload file
 *              appearing proves the runAsNode fuse (gotcha 108); its hooks
 *              landed; its transcript is where the relaunch will look
 *   continue   `stoke <folder> --continue` opens a Claude tab holding NO id,
 *              and the registry names it and rebinds the tab from '' (gotcha
 *              26) — on Windows by descent over the Toolhelp process table alone,
 *              since cmd.exe's pid matches no file and there is no id to key on
 *              (gotcha 92)
 *   agents     two other agents started the same way sit in tabs of their own,
 *              each its own process, and each can call Stoke's browser MCP with
 *              what its launch handed it (agentLaunchPlan)
 *   browser    the docked browser logs in through a form, `/whoami` agrees, a
 *              second browser profile does NOT see the cookie (gotcha 107), and
 *              an agent's `browser_read` sees the logged-in page
 *   phone      remote access starts and verify-remote-security.mjs's whole
 *              matrix passes against it
 *   ssh        (--ssh) a kept (tmux) tab to a real sshd: an echo round trip,
 *              `~.` that does NOT hang up (gotcha 29), a password-only host
 *              that raises the key offer ONCE, and an enrollment that installs
 *              a key a BatchMode ssh then uses (gotchas 75, 109)
 *   quit       a GRACEFUL quit — SIGTERM on POSIX, the window's own close on
 *              Windows, never a kill — exits 0, releases every session's
 *              statusLine files (before-quit's killAll), reaches every agent
 *              (their exit markers), and leaves the login cookie ENCRYPTED on
 *              disk (gotcha 108: the value column empty, encrypted_value not)
 *   relaunch   the same profile comes back with its tabs paused; resuming the
 *              Claude tab hands the stub `--resume <the same id>` (gotcha 81),
 *              the other agents their continue flags, the browser is still
 *              logged in, and a kept SSH tab reattaches to the SAME shell
 *
 * Every input is faked, none borrowed (gotcha 74): HOME/USERPROFILE, TMPDIR/
 * TEMP (the statusLine directory lives under it), the XDG dirs, userData and
 * the project folder all live under --work, and every agent is
 * scripts/probe/fake-agent.mjs behind a launcher in the fake home's
 * ~/.local/bin, first on a PATH that a no-rc SHELL answers verbatim — so no
 * login-shell rc can put a REAL agent ahead of a stub (gotcha 112). The one
 * exception is SSH, which reads the passwd home, not $HOME: `--ssh` links the
 * fake home's .ssh to the real one and so is refused anywhere but a CI runner.
 *
 * Output: PASS/FAIL per check, screenshots and every log under <work>, a
 * summary in <work>/probe-summary.json (and the job summary on Actions). The
 * tally and process.exitCode are the file's last statement (gotcha 50).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { windowsProcessTableSpec } from '../src/main/windowsProcessTable.ts'
import { cliFor } from '../src/shared/codingClis.ts'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  appendFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { CdpClient, connectBrowserPage, connectStoke, connectPage, listTargets } from './cdp-lib.mjs'
import { startLoginServer } from './probe/login-server.mjs'
import { createCertificate, startTlsServer } from './probe/tls-server.mjs'
import { createSshFileFixture, removeSshFileFixture } from './probe/ssh-files.mjs'
import { terminalLinkPoint } from './probe/terminal-link.mjs'
import { nativeCrashScript } from './probe/native-crash.mjs'
import { accountSyncFixture } from './probe/account-sync.mts'
import type { HubView } from '../src/shared/hub/client.ts'
import type { BrowserState } from '../src/shared/types.ts'
import type { QuickTerminalResult, QuickTerminalState } from '../src/shared/quickTerminal.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

const { values: opt } = parseArgs({
  options: {
    app: { type: 'string' },
    dev: { type: 'boolean', default: false },
    work: { type: 'string' },
    port: { type: 'string', default: '9339' },
    ssh: { type: 'boolean', default: false },
    'gbot-cli': { type: 'string' },
    'ssh-key-alias': { type: 'string', default: 'stoke-key' },
    'ssh-pw-alias': { type: 'string', default: 'stoke-pw' }
  }
})

if (!opt.work || (!opt.app && !opt.dev)) {
  console.error('usage: node scripts/probe-e2e.mts (--app <packaged app> | --dev) --work <dir> [--port N] [--ssh]')
  process.exit(2)
}
if (opt.ssh && process.env.GITHUB_ACTIONS !== 'true') {
  // ssh reads ~/.ssh from the passwd entry, not $HOME, so SSH mode links the
  // fake home's .ssh to the REAL one and an enrollment writes a key and a
  // config block there. On a throwaway runner that is the point; on a
  // developer's machine it would edit their own ~/.ssh.
  console.error('--ssh edits the real ~/.ssh (ssh ignores $HOME) and runs only on a CI runner (GITHUB_ACTIONS=true).')
  process.exit(2)
}

/* --------------------------------------------------------------- tallying */

interface Result {
  name: string
  ok: boolean
  detail: string
}
const results: Result[] = []

function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail.replace(/\n/g, '\n        ')}` : ''}`)
  return ok
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/** Run a group of checks; anything it throws is one FAIL named after the group, never a crash. */
async function step(name: string, body: () => Promise<void>): Promise<boolean> {
  section(name)
  const before = results.filter((r) => !r.ok).length
  try {
    await body()
  } catch (e) {
    check(`${name}: ran to the end`, false, e instanceof Error ? (e.stack ?? e.message) : String(e))
  }
  return results.filter((r) => !r.ok).length === before
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll until `fn` returns something truthy; throws naming `what` and the last error. */
async function waitFor<T>(what: string, fn: () => Promise<T> | T, timeoutMs = 30_000, intervalMs = 300): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs
  let last: unknown = null
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (e) {
      last = e
    }
    if (Date.now() > until) {
      const why = last instanceof Error ? ` (last error: ${last.message.split('\n')[0]})` : ''
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${why}`)
    }
    await sleep(intervalMs)
  }
}

/* ------------------------------------------------------------- the world */

const work = resolve(opt.work)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
// Realpathed once, before anything is remembered (gotcha 91): macOS's /tmp is
// /private/tmp, and a folder remembered under both is two sidebar rows.
const root = realpathSync(work)
const home = join(root, 'home')
const tmp = join(root, 'tmp')
const ud = join(root, 'ud')
const proj = join(root, 'project')
/** A second folder, for the `--continue` tab: a running Claude tab in `proj` would be reused. */
const projContinue = join(root, 'project-continue')
const agentsDir = join(root, 'agents')
const shots = join(root, 'shots')
const logs = join(root, 'logs')
const stubBin = join(home, '.local', 'bin')
for (const d of [home, tmp, ud, proj, projContinue, agentsDir, shots, logs, stubBin]) mkdirSync(d, { recursive: true })
writeFileSync(join(proj, 'README.md'), '# Probe project\n\nA folder the CI probe opens sessions in.\n')
const gitInit = spawnSync('git', ['-c', 'init.defaultBranch=probe-ui', 'init', '--template=', proj], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } })
if (gitInit.status !== 0) throw new Error(`the owned Git UI fixture could not be initialized: ${gitInit.stderr}`)

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }
const port = Number(opt.port)
// Only this disposable fixture gets a main-process debugger. Native key-hook
// emulation needs it: CDP Input.dispatchKeyEvent bypasses Electron's before-input-event.
// Crash diagnostics remain limited to Windows CI. Clients disconnect before quit.
const nativeInspectorPort = await new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const address = server.address(); const assigned = typeof address === 'object' && address ? address.port : 0; server.close(error => error ? reject(error) : resolve(assigned)) })
})
const sid = `probe-sid-${process.pid}-${Date.now()}`

/** A single-quoted POSIX word, or a refusal: these paths are written into launchers. */
function shWord(p: string): string {
  if (p.includes("'")) throw new Error(`a path with a single quote cannot go into a launcher: ${p}`)
  return `'${p}'`
}

/*
 * The stub launchers. One per agent the probe starts, named as Stoke will look
 * them up (codingClis.ts `bins`): a sh `exec` on POSIX, so the pty's child IS
 * the stub (the registry matches by pid); a .cmd on Windows, which spawnSpec
 * runs through `cmd.exe /c` exactly as it runs an npm-installed agent.
 */
const AGENTS = ['claude', 'codex', 'opencode'] as const
type AgentId = (typeof AGENTS)[number]
const fakeAgent = join(repo, 'scripts', 'probe', 'fake-agent.mjs')
const launcherOf: Record<string, string> = {}
for (const id of AGENTS) {
  if (isWin) {
    const file = join(stubBin, `${id}.cmd`)
    writeFileSync(file, `@echo off\r\nset "STOKE_PROBE_DIR=${agentsDir}"\r\n"${process.execPath}" "${fakeAgent}" ${id} %*\r\n`)
    launcherOf[id] = file
  } else {
    const file = join(stubBin, id)
    writeFileSync(file, `#!/bin/sh\nSTOKE_PROBE_DIR=${shWord(agentsDir)} exec ${shWord(process.execPath)} ${shWord(fakeAgent)} ${id} "$@"\n`, { mode: 0o755 })
    launcherOf[id] = file
  }
}

/*
 * A login shell that runs its command and nothing else. Stoke asks `$SHELL
 * -ilc 'printf %s "$PATH"'` for the PATH every agent is looked up on, and a
 * real rc would put ~/.local/bin or a version manager's shims — and so a REAL
 * agent — ahead of the stubs (gotcha 112). `shift` drops `-ilc`.
 */
const noRcShell = join(root, 'bin', 'sh-norc')
if (!isWin) {
  mkdirSync(dirname(noRcShell), { recursive: true })
  writeFileSync(noRcShell, '#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "-l" ]; then exec /bin/sh; fi\nshift\nexec /bin/sh -c "$1"\n', { mode: 0o755 })
}

/* ------------------------------------------------------------- the app */

function packagedExe(app: string): string {
  const s = statSync(app)
  if (s.isFile()) return app
  if (app.endsWith('.app')) {
    const macos = join(app, 'Contents', 'MacOS')
    const names = readdirSync(macos)
    if (names.length !== 1) throw new Error(`expected one executable in ${macos}, found ${names.join(', ')}`)
    return join(macos, names[0])
  }
  for (const name of ['Stoke.exe', 'stoke']) if (existsSync(join(app, name))) return join(app, name)
  throw new Error(`no Stoke executable in ${app}`)
}

const require = createRequire(import.meta.url)
const exe = opt.dev ? (require('electron') as string) : packagedExe(resolve(opt.app!))
/** Arguments before Stoke's own: the app folder, for an unpackaged Electron. */
const exePrefix = opt.dev ? [repo] : []

/** What this OS needs to run unattended: no Keychain prompt (gotcha 108's method), no keyring. */
const platformFlags = isMac ? ['--use-mock-keychain'] : !isWin ? ['--password-store=basic'] : []

const site = { base: '', port: 0 }

/** The environment Stoke runs in: this process's, with every input that could reach the real machine faked. */
function stokeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Whatever runs the probe (a Claude session, an Actions step) must not leak
  // its own session markers into the app — the same list STRIP_ENV drops.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CONFIG_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[k]
  env.HOME = home
  env.TMPDIR = tmp
  env.TEMP = tmp
  env.TMP = tmp
  env.ELECTRON_ENABLE_LOGGING = '1'
  env.STOKE_PROBE_SITE = site.base
  if (isWin) {
    env.USERPROFILE = home
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
    env[key] = `${stubBin};${env[key] ?? ''}`
  } else {
    env.SHELL = noRcShell
    env.XDG_CONFIG_HOME = join(home, '.config')
    env.XDG_DATA_HOME = join(home, '.local', 'share')
    env.XDG_CACHE_HOME = join(home, '.cache')
    // Not node's own folder: a version-managed node keeps its global npm bins
    // beside it, a real `claude` or `codex` among them. The launchers name node
    // by absolute path, so nothing here needs it on PATH.
    env.PATH = [stubBin, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)
  }
  return env
}

let stoke: ChildProcess | null = null
let stokeExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
let launchNo = 0

function launch(): ChildProcess {
  launchNo++
  const log = openSync(join(logs, `stoke-${launchNo}.log`), 'a')
  const args = [...exePrefix, `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', ...platformFlags, ...(nativeInspectorPort ? [`--inspect=127.0.0.1:${nativeInspectorPort}`] : [])]
  console.log(`  launch ${launchNo}: ${exe} ${args.join(' ')}`)
  const child = spawn(exe, args, { env: stokeEnv(), stdio: ['ignore', log, log], cwd: root })
  stokeExit = null
  child.on('exit', (code, signal) => {
    stokeExit = { code, signal }
  })
  stoke = child
  return child
}

/** `stoke …` as the shim sends it: a second instance that hands its request over and quits. */
async function stokeCli(...userArgs: string[]): Promise<number | null> {
  const args = [...exePrefix, `--user-data-dir=${ud}`, ...platformFlags, '--stoke-cli', `--stoke-cwd=${proj}`, '--', ...userArgs]
  const log = openSync(join(logs, 'stoke-cli.log'), 'a')
  appendFileSync(join(logs, 'stoke-cli.log'), `\n$ stoke ${userArgs.join(' ')}\n`)
  const child = spawn(exe, args, { env: stokeEnv(), stdio: ['ignore', log, log], cwd: proj })
  const code = await new Promise<number | null>((res) => {
    const t = setTimeout(() => res(null), 30_000)
    child.on('exit', (c) => {
      clearTimeout(t)
      res(c)
    })
  })
  return code
}

let ui: CdpClient | null = null

async function attach(): Promise<CdpClient> {
  const client = await waitFor('Stoke\'s renderer on the CDP port', async () => {
    await listTargets(port)
    return connectStoke(port)
  }, 90_000, 500)
  // Driven while another window may have OS focus: without this a synthetic
  // focus can go nowhere (gotcha 119).
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
  ui = client
  if (nativeInspectorPort && isWin && process.env.GITHUB_ACTIONS === 'true') {
    await step('Windows CI main-process crash diagnostics', async () => {
      const target = await waitFor('the disposable app\'s main inspector', async () => (await listTargets(nativeInspectorPort)).find(target => target.type === 'node' && target.webSocketDebuggerUrl), 10_000)
      const main = await CdpClient.open(target)
      try {
        const directory = join(logs, `native-crashes-${launchNo}`)
        const state = await main.evaluate(nativeCrashScript(directory))
        check('CI crash reports stay in this fixture with submission disabled', state.installed === true && state.uploads === false && state.directory === directory)
      } finally { main.close() }
    })
  }
  return client
}

async function ev<T = unknown>(expr: string, timeoutMs = 10_000): Promise<T> {
  if (!ui) throw new Error('not attached to the renderer')
  return (await ui.evaluate(expr, { timeoutMs })) as T
}

async function shot(name: string): Promise<void> {
  try {
    if (ui) await ui.screenshot(join(shots, `${name}.png`))
  } catch (e) {
    console.log(`  (screenshot ${name} failed: ${e instanceof Error ? e.message : String(e)})`)
  }
}

/* ------------------------------------------------------- reading the app */

/** Every live terminal's whole buffer, by pty id — xterm paints a canvas, so this is the only read (gotcha 5). */
const BUFFERS = [
  '(() => {',
  '  const out = {}',
  '  const m = window.stokeTerminals',
  '  if (!m) return out',
  '  for (const [id, t] of m) {',
  '    const b = t.buffer.active',
  '    const lines = []',
  '    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "")',
  '    out[id] = lines.join("\\n")',
  '  }',
  '  return out',
  '})()'
].join('\n')

async function buffers(): Promise<Record<string, string>> {
  return ev<Record<string, string>>(BUFFERS)
}

/** The pty whose terminal shows `marker` and is not in `exclude`. */
async function termShowing(marker: string | RegExp, what: string, timeoutMs = 45_000, exclude: string[] = []): Promise<string> {
  return waitFor(what, async () => {
    const all = await buffers()
    return Object.entries(all).find(([id, text]) => !exclude.includes(id) && (typeof marker === 'string' ? text.includes(marker) : marker.test(text)))?.[0] ?? null
  }, timeoutMs)
}

async function bufferOf(ptyId: string): Promise<string> {
  return (await buffers())[ptyId] ?? ''
}

/** The pty of the terminal on screen now, or null. */
const ACTIVE_PTY = [
  '(() => {',
  '  for (const [id, t] of window.stokeTerminals ?? []) {',
  '    if (t.element && !t.element.closest("[hidden]") && t.element.offsetParent !== null) return id',
  '  }',
  '  return null',
  '})()'
].join('\n')

/** Click through the tab strip until `ptyId`'s terminal is the one on screen. */
async function activate(ptyId: string): Promise<void> {
  if ((await ev(ACTIVE_PTY)) === ptyId) return
  const count = await ev<number>('document.querySelectorAll(".tablist .tab").length')
  for (let i = 0; i < count; i++) {
    await ev(`document.querySelectorAll(".tablist .tab")[${i}]?.click(), true`)
    await sleep(250)
    if ((await ev(ACTIVE_PTY)) === ptyId) return
  }
  throw new Error(`no tab in the strip brings pty ${ptyId} to the front`)
}

/** Type as a person does: into the focused terminal, through xterm, then Enter. */
async function typeLine(ptyId: string, text: string): Promise<void> {
  await activate(ptyId)
  await ev(`window.stokeTerminals.get(${JSON.stringify(ptyId)}).focus(), true`)
  if (text) await ui!.send('Input.insertText', { text })
  await pressEnter()
}

async function pressEnter(): Promise<void> {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await ui!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await ui!.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', ...key })
  await ui!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/* ------------------------------------------------------ the stubs' records */

interface StubRecord {
  file: string
  pid: number
  id: string
  start: { argv: string[]; cwd: string; env: Record<string, unknown> } & Record<string, unknown>
  events: Array<Record<string, unknown> & { kind: string }>
}

function stubRecords(id?: string): StubRecord[] {
  const out: StubRecord[] = []
  for (const name of readdirSync(agentsDir)) {
    const m = /^([a-z]+)-(\d+)\.jsonl$/.exec(name)
    if (!m || (id && m[1] !== id)) continue
    const events = readFileSync(join(agentsDir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown> & { kind: string })
    const start = events.find((e) => e.kind === 'start') as StubRecord['start'] | undefined
    if (start) out.push({ file: name, pid: Number(m[2]), id: m[1], start, events })
  }
  return out.sort((a, b) => Number(a.events[0]?.t ?? 0) - Number(b.events[0]?.t ?? 0))
}

function stubByPid(pid: number): StubRecord | null {
  return stubRecords().find((r) => r.pid === pid) ?? null
}

/** The pid a terminal's banner names. */
async function pidIn(ptyId: string, id: string): Promise<number> {
  const m = new RegExp(`STOKE-PROBE ${id} ready pid=(\\d+)`).exec(await bufferOf(ptyId))
  if (!m) throw new Error(`pty ${ptyId} shows no ${id} banner`)
  return Number(m[1])
}

function argAfter(argv: string[], flag: string): string | null {
  const at = argv.indexOf(flag)
  return at !== -1 && at + 1 < argv.length ? argv[at + 1] : null
}

function exitMarkers(): string[] {
  return readdirSync(agentsDir).filter((n) => n.startsWith('exit-'))
}

/* --------------------------------------------------------- seeded settings */

function seedSettings(): void {
  const hosts = opt.ssh
    ? [
        { id: 'probekey', label: 'Probe key host', alias: opt['ssh-key-alias'], command: '', persist: 'tmux' },
        { id: 'probepw', label: 'Probe password host', alias: opt['ssh-pw-alias'], command: '', persist: 'off' }
      ]
    : []
  const settings = {
    // Every first-run gate answered, so the shell is live from the first frame
    // (gotcha 88): the agent picker, the campfire, the chat-history offer, the
    // browser-import offer.
    agents: { chosen: [...AGENTS], endpoints: {}, defaultCli: 'claude' },
    welcomeSeenVersion: pkg.version,
    chatIndex: 'off',
    // Nothing that would reach the network or replace a binary on its own.
    cliAutoUpdate: false,
    selfUpdateAuto: false,
    worklogAuto: false,
    claudePath: launcherOf.claude,
    defaultCwd: proj,
    // Saved legacy title-bar Git remains readable but is drawn only in the footer.
    topBar: { enabled: true, items: [{ id: 'legacy-git', kind: 'git' }] },
    hosts,
    // A port of its own: 7878 may be an installed Stoke's phone server.
    remote: { port: remotePort },
    browser: {
      homepage: `${site.base}/login`,
      lastUrl: '',
      width: 520,
      bookmarks: [],
      profiles: [{ id: 'default', label: 'Default', source: '', origin: '' }],
      currentProfile: 'default',
      importOffer: 'dismissed'
    }
  }
  writeFileSync(join(ud, 'settings.json'), JSON.stringify(settings, null, 2))
}

/* ================================================================ the run */

const login = await startLoginServer({ sid })
site.port = login.port
site.base = `http://127.0.0.1:${login.port}`
/** A loopback port nothing holds right now, for the phone server. */
const remotePort = await new Promise<number>((res, rej) => {
  const s = createServer()
  s.once('error', rej)
  s.listen(0, '127.0.0.1', () => {
    const a = s.address()
    s.close(() => res(typeof a === 'object' && a ? a.port : 0))
  })
})
seedSettings()

if (opt.ssh) {
  // ssh reads the passwd home's ~/.ssh, never $HOME (see the header). Link
  // the fake home's to it, so Stoke's enrollment (homedir()/.ssh) writes
  // where ssh will read.
  const realSsh = join(userInfo().homedir, '.ssh')
  mkdirSync(realSsh, { recursive: true, mode: 0o700 })
  symlinkSync(realSsh, join(home, '.ssh'), isWin ? 'junction' : 'dir')
}

console.log(`Stoke ${pkg.version} probe on ${process.platform}-${process.arch}`)
console.log(`  app   ${exe}${opt.dev ? ' (unpackaged)' : ''}`)
console.log(`  work  ${root}`)
console.log(`  site  ${site.base}`)

const tabs: Partial<Record<AgentId, { ptyId: string; pid: number }>> = {}
let claudeSession = ''
let codexNativeId = ''
const sshTabs: { key?: string } = {}

/* ---------------------------------------------------------------- boot */

await step('boot', async () => {
  launch()
  await attach()
  const platform = await ev<string>('window.stoke.platform')
  check('window.stoke.platform names this OS', platform === process.platform, `got ${platform}`)
  await waitFor('the shell to mount', () => ev<boolean>('!!document.querySelector(".app > .titlebar")'), 30_000)
  const inert = await waitFor('the shell to leave the first-run gates', async () => {
    const v = await ev<boolean>('!!document.querySelector(".app > .body-row") && !document.querySelector(".app > .body-row").inert')
    return v ? 'live' : null
  }, 30_000).catch(() => 'inert')
  check('the shell is not inert — no first-run gate left up (gotcha 88)', inert === 'live')
  const gl = await ev<{ webgl2: boolean; canvas: number }>(
    '({ webgl2: !!document.createElement("canvas").getContext("webgl2"), canvas: document.querySelectorAll(".xterm canvas").length })'
  )
  console.log(`  (renderer: webgl2 ${gl.webgl2 ? 'available' : 'unavailable'} — the terminal draws on the ${gl.webgl2 ? 'WebGL' : 'DOM'} path)`)
  await shot('01-boot')
})

/* ------------------------------------------------------------- session */

await step('launcher setup review does not start an agent', async () => {
  const before = stubRecords().length
  await waitFor('the launcher setup button', () => ev<boolean>('!!document.querySelector(".launcher-setup > button:not(:disabled)")'), 15_000)
  await ev('document.querySelector(".launcher-setup > button").click(), true')
  const text = await waitFor('the setup report in the launcher', async () => {
    const value = await ev<string>('document.querySelector(".launcher-setup-result")?.textContent ?? ""')
    return value.includes('Working folder') ? value : null
  }, 15_000)
  check('the mounted review includes folder, CLI, account, provider and tools', (await ev<number>('document.querySelectorAll(".launcher-setup-result li").length')) === 5, text)
  check('the selected fixture setup has no blocking problem', text.includes('No blocking setup issues found'), text)
  check('the report leaves sign-in and connections unverified', text.includes('checks its own sign-in') && text.includes('not tested'), text)
  check('checking setup did not start an agent session', stubRecords().length === before)
})

await step('a Claude session from `stoke <folder> --new`', async () => {
  const code = await stokeCli(proj, '--new')
  check('the second instance handed its request over and quit', code === 0, `exit ${code}`)
  const ptyId = await termShowing('STOKE-PROBE claude ready', 'the Claude stub\'s banner in a terminal')
  const pid = await pidIn(ptyId, 'claude')
  tabs.claude = { ptyId, pid }
  const rec = await waitFor('the Claude stub\'s start record', () => stubByPid(pid) ?? stubRecords('claude').at(-1) ?? null, 10_000)
  const argv = rec.start.argv
  claudeSession = argAfter(argv, '--session-id') ?? ''
  check('it was started with --session-id <uuid>', /^[0-9a-f-]{36}$/.test(claudeSession), `argv ${JSON.stringify(argv)}`)
  const settingsFile = argAfter(argv, '--settings')
  check('with one --settings file', !!settingsFile && argv.filter((a) => a === '--settings').length === 1)
  check('and --mcp-config naming Stoke\'s browser server', !!argAfter(argv, '--mcp-config'))
  check('in the folder asked for', rec.start.cwd === proj || realpathSync(rec.start.cwd) === proj, `cwd ${rec.start.cwd}`)
  check('the launcher the settings name, not some other claude', argv.length > 0 && rec.id === 'claude')
  const statusRun = await waitFor('the first statusLine render', () => stubRecords('claude').find((r) => r.pid === rec.pid)?.events.find((e) => e.kind === 'statusline') ?? null, 20_000)
  check('--settings carries a statusLine command', statusRun.ran === true, JSON.stringify(statusRun).slice(0, 600))
  check('which exited 0 in the shell the CLI would use', statusRun.status === 0, `shell ${String(statusRun.shell)} status ${String(statusRun.status)} stderr ${String(statusRun.stderr ?? '').slice(0, 400)}`)
  const payloadFile = join(tmp, 'stoke', 'statusline', `${claudeSession}.json`)
  const payload = await waitFor('the payload file the shim writes', () => (existsSync(payloadFile) ? readFileSync(payloadFile, 'utf8') : null), 15_000).catch(() => '')
  check(
    'the shim — Stoke\'s own binary under ELECTRON_RUN_AS_NODE — stored the payload (runAsNode fuse, gotcha 108)',
    payload.includes(claudeSession),
    payload ? '' : `nothing at ${payloadFile}; the directory holds ${existsSync(dirname(payloadFile)) ? readdirSync(dirname(payloadFile)).join(', ') : '(no directory)'}`
  )
  const last = await waitFor('window.stoke.statusLine.last() to name the session', async () => {
    const s = await ev<unknown>('window.stoke.statusLine.last()')
    return JSON.stringify(s ?? null).includes(claudeSession) ? s : null
  }, 20_000).catch(() => null)
  check('and main read it back: statusLine.last() names the session', !!last, JSON.stringify(last).slice(0, 300))
  await shot('02-claude-session')
})

await step('typing reaches the session, and its hooks land', async () => {
  const t = tabs.claude
  if (!t) throw new Error('no Claude tab to type into')
  await ev('(window.__probeEvents = [], window.stoke.session.onEvent((e) => window.__probeEvents.push(e)), true)')
  await typeLine(t.ptyId, 'hello from the probe')
  const got = await waitFor('GOT in the Claude tab', async () => ((await bufferOf(t.ptyId)).includes('GOT hello from the probe') ? true : null), 15_000).catch(() => false)
  check('keystrokes typed into the terminal reached the process (GOT …)', got === true, got ? '' : (await bufferOf(t.ptyId)).slice(-800))
  const reply = await waitFor('the reply', async () => ((await bufferOf(t.ptyId)).includes('REPLY stoke probe reply 1') ? true : null), 15_000).catch(() => false)
  check('the stub answered the turn', reply === true)
  const rec = stubRecords('claude').find((r) => r.pid === t.pid)
  const hooks = (rec?.events ?? []).filter((e) => e.kind === 'hook')
  check('UserPromptSubmit and Stop hooks ran and exited 0', ['UserPromptSubmit', 'Stop'].every((ev) => hooks.some((h) => h.event === ev && h.status === 0)), JSON.stringify(hooks).slice(0, 600))
  const eventsFile = join(tmp, 'stoke', 'statusline', `${claudeSession}.events.jsonl`)
  const lines = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8') : ''
  check('the hook shim appended both events for Stoke to read', /"UserPromptSubmit"/.test(lines) && /"Stop"/.test(lines), lines ? '' : `nothing at ${eventsFile}`)
  const seen = await waitFor('the renderer to receive a hook event', async () => {
    const evs = await ev<Array<{ kind: string; sessionId: string }>>('window.__probeEvents')
    return evs.some((e) => e.sessionId === claudeSession && e.kind === 'stop') ? evs : null
  }, 15_000).catch(() => null)
  check('main polled them and the renderer got the Stop (activity dot)', !!seen, JSON.stringify(seen).slice(0, 300))
  const transcript = join(home, '.claude', 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'), `${claudeSession}.jsonl`)
  check('the transcript is on disk where a resume will look for it', existsSync(transcript), transcript)
  // POSIX matches by pid (the launcher execs the stub). On Windows the pty's
  // child is cmd.exe running the .cmd launcher, so the pid never matches and
  // `pickEntry` falls to its SECOND key: the one entry carrying the id Stoke
  // launched with — which this stub writes, so descent is never asked here.
  // The `--continue` step below is the one where only descent can answer.
  let states: Array<{ ptyId?: string; status?: string }> = []
  const mine = await waitFor('the registry entry to be matched to the tab', async () => {
    states = await ev<Array<{ ptyId?: string; status?: string }>>('window.stoke.session.states()')
    return states.find((s) => s.ptyId === t.ptyId) ?? null
  }, 20_000).catch(() => null)
  check(
    `the CLI registry entry was matched to the tab ${isWin ? 'through a .cmd launcher, by the session id it was launched with (pickEntry\'s second key)' : 'by pid (gotcha 80)'}`,
    !!mine,
    JSON.stringify(states).slice(0, 400)
  )
})

/**
 * What the descent fallback stands on here, measured beside it so a red
 * above says WHY (gotcha 92): the exact production Toolhelp snapshot, timed
 * against its 5 s deadline, and the stub's ancestry. The former CIM query
 * took 23.6-28.2 s on Windows ARM64. Printed, never checked: the continued
 * session assertions below prove whether Stoke actually used that ancestry.
 */
function windowsProcessTableReport(stubPid: number): void {
  const t0 = Date.now()
  const [command, args] = windowsProcessTableSpec()
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const ms = Date.now() - t0
  const rows = new Map<number, number>()
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const m = /^(\d+) (\d+)$/.exec(line.trim())
    if (m) rows.set(Number(m[1]), Number(m[2]))
  }
  const chain: string[] = []
  for (let at: number | undefined = stubPid, hops = 0; at && hops < 6; hops++) {
    chain.push(String(at))
    at = rows.get(at)
  }
  console.log(
    `  (process table, readProcessTable's Toolhelp snapshot: ${ms} ms — its deadline is 5000 ms; ${rows.size} rows, exit ${r.status}` +
      `${r.error ? `, ${r.error.message}` : ''})`
  )
  console.log(`  (the stub's ancestry: ${chain.join(' <- ')})`)
  if (r.status !== 0 && r.stderr) console.log(`  (snapshot error: ${String(r.stderr).replace(/\s+/g, ' ').trim().slice(0, 2000)})`)
}

/*
 * A tab Stoke launches holding NO id: `stoke <folder> --continue` is
 * `claude --continue`, which picks its own conversation after launch, so the
 * tab starts on '' and only the registry can name it (gotcha 26). On POSIX the
 * pid does. On Windows the pty is cmd.exe's and there is no id to key on, so
 * `pickEntry`'s descent fallback is the ONLY thing that can match it — the
 * process table (Toolhelp) read and `descendsFrom` walked from cmd.exe to the stub
 * (gotcha 92). With that table unreadable `pickEntry` answers null and this
 * goes red, which is what a first-key match above could never show. A folder
 * of its own, since a running Claude tab in `proj` would be reused instead;
 * the tab is closed at the end, so the restore steps see the three they expect.
 */
await step('a `stoke <folder> --continue` tab: Stoke holds no id and learns it from the registry', async () => {
  // A conversation for --continue to pick up, as a person's folder would hold.
  const seeded = randomUUID()
  const seedDir = join(home, '.claude', 'projects', projContinue.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(seedDir, { recursive: true })
  const at = new Date().toISOString()
  writeFileSync(
    join(seedDir, `${seeded}.jsonl`),
    [
      { type: 'user', sessionId: seeded, cwd: projContinue, uuid: randomUUID(), timestamp: at, message: { role: 'user', content: 'an earlier conversation' } },
      { type: 'assistant', sessionId: seeded, cwd: projContinue, uuid: randomUUID(), timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] } }
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  )
  await ev('(window.__probeRebinds = [], window.stoke.session.onRebind((r) => window.__probeRebinds.push(r)), true)')
  const taken = Object.keys(await buffers())
  const asked = Date.now()
  const code = await stokeCli(projContinue, '--continue')
  check('the request was handed over', code === 0, `exit ${code}`)
  const ptyId = await termShowing('STOKE-PROBE claude continued', 'the continued Claude stub\'s banner', 45_000, taken)
  const pid = await pidIn(ptyId, 'claude')
  const rec = await waitFor('the continued stub\'s start record', () => stubByPid(pid), 10_000)
  const argv = rec.start.argv
  check('it was started with --continue, and neither --session-id nor --resume', argv.includes('--continue') && !argv.includes('--session-id') && !argv.includes('--resume'), JSON.stringify(argv))
  const stubId = String(rec.events.find((e) => e.kind === 'claude-session')?.sessionId ?? '')
  check('(the stub continued the conversation seeded in its folder)', stubId === seeded, `stub on ${stubId}, seeded ${seeded}`)
  let rebinds: Array<{ ptyId: string; sessionId: string; previous: string }> = []
  const moved = await waitFor('the registry rebind for the continued tab', async () => {
    rebinds = await ev<typeof rebinds>('window.__probeRebinds')
    return rebinds.find((r) => r.ptyId === ptyId && r.sessionId === stubId) ?? null
  }, 30_000).catch(() => null)
  if (moved) console.log(`  (rebound ${((Date.now() - asked) / 1000).toFixed(1)} s after the request, at most one poll late)`)
  check(
    isWin
      ? 'Stoke held no id, so only descent could name it: the Toolhelp process table was read and descendsFrom walked cmd.exe to the stub (gotcha 92)'
      : 'matched by pid, though Stoke held no id (gotcha 80)',
    !!moved,
    JSON.stringify(rebinds).slice(0, 400)
  )
  check('and the tab was rebound from \'\' to the id the CLI chose (gotcha 26)', moved?.previous === '', JSON.stringify(moved))
  const state = (await ev<Array<{ ptyId?: string; sessionId?: string }>>('window.stoke.session.states()')).find((s) => s.ptyId === ptyId)
  check('session.states() reads the continued tab on that id', state?.sessionId === stubId, JSON.stringify(state ?? null))
  if (isWin) windowsProcessTableReport(pid)
  await shot('02b-continued-session')
  // Closed through the tab's own ×: an idle Claude tab closes without asking
  // (gotcha 90), and its process is told.
  await activate(ptyId)
  await ev('(document.querySelector(".tablist .tab[aria-selected=\'true\'] .tab-close")?.click(), true)')
  const gone = await waitFor('the continued tab\'s process to be told', () => exitMarkers().some((n) => n === `exit-claude-${pid}`), 20_000).catch(() => false)
  check('closing the tab ended its process (its exit marker)', gone === true, exitMarkers().join(', '))
})

/* --------------------------------------------------------------- agents */

for (const id of ['codex', 'opencode'] as const) {
  await step(`${id} from \`stoke --cli ${id} --new\`, in a tab of its own`, async () => {
    const code = await stokeCli('--cli', id, '--new', proj)
    check('the request was handed over', code === 0, `exit ${code}`)
    const taken = Object.values(tabs).map((t) => t!.ptyId)
    const ptyId = await termShowing(`STOKE-PROBE ${id} ready`, `the ${id} stub's banner`, 45_000, taken)
    const pid = await pidIn(ptyId, id)
    tabs[id] = { ptyId, pid }
    check('in a new terminal, not one already open', !taken.includes(ptyId))
    const others = AGENTS.filter((a) => a !== id).map((a) => `STOKE-PROBE ${a} ready`)
    const text = await bufferOf(ptyId)
    check('that shows only its own agent', !others.some((o) => text.includes(o)))
    const rec = await waitFor(`the ${id} stub's start record`, () => stubByPid(pid) ?? stubRecords(id).at(-1) ?? null, 10_000)
    check('its process is the stub launcher, not a real install', rec.id === id, rec.file)
    if (id === 'codex') {
      check('handed Stoke\'s MCP server as -c mcp_servers.stoke.* (agentLaunchPlan)', rec.start.argv.some((a) => a.startsWith('mcp_servers.stoke.url=')), JSON.stringify(rec.start.argv))
      check('with the bearer by variable name, never in argv', rec.start.argv.some((a) => a.includes('bearer_token_env_var')) && String((rec.start.env as Record<string, string>).STOKE_MCP_TOKEN ?? '').startsWith('<set'))
    } else {
      check('handed Stoke\'s MCP server in OPENCODE_CONFIG_CONTENT', String((rec.start.env as Record<string, string>).OPENCODE_CONFIG_CONTENT ?? '').includes('"stoke"'))
    }
  })
}
await step('Codex reports its native model and current context', async () => {
  await activate(tabs.codex!.ptyId)
  await ev('(window.__stokeCodexContext = null, window.__stokeCodexContextOff = window.stoke.context.onUpdate(s => { if (s.model === "gpt-6.1-sol") window.__stokeCodexContext = s }), true)')
  try {
    await typeLine(tabs.codex!.ptyId, 'codex-context-reading')
    await waitFor('Codex rollout context to reach the renderer', () => ev<boolean>('window.__stokeCodexContext?.ready && window.__stokeCodexContext.contextTokens === 12000 && window.__stokeCodexContext.contextLimit === 258400'))
    check('Codex context uses its last-response tokens instead of the cumulative fixture', true)
    codexNativeId = await ev<string>('window.__stokeCodexContext.agentResumeId')
    check('the renderer receives the confirmed native Codex thread', /^[a-f0-9-]{36}$/i.test(codexNativeId))
    check('the status bar names the reported Codex model', await ev<boolean>('document.querySelector(\'[data-model-source="reported"]\')?.textContent.includes("gpt-6.1-sol")') === true)
  } finally { await ev('(window.__stokeCodexContextOff?.(), delete window.__stokeCodexContextOff, true)') }
})

await step('native plugin lifecycle and Grok Bot account isolation', async () => {
  const openPlugins = async () => {
    await ev(`document.querySelector('[data-testid="active-account"]').click(), true`)
    await waitFor('owned account menu for plugin navigation', () => ev<boolean>('!!document.querySelector(".account-panel")'))
    await ev(`[...document.querySelectorAll('.account-panel button')].find(button => button.textContent === 'Manage agent accounts').click(), true`)
    await waitFor('settings navigation mounted', () => ev<boolean>(`!!document.querySelector('[data-node="plugins"]')`))
    await ev(`document.querySelector('[data-node="plugins"]').click(), true`)
    await waitFor('native plugin manager', () => ev<boolean>(`!!document.querySelector('[data-setting="plugins.manager"]')`))
  }
  let server: ReturnType<typeof createHttpServer> | null = null
  try {
    await openPlugins()
    check('Grok Bot contributes no account controls while disabled', await ev<boolean>(`!document.querySelector('[aria-label="Grok Bot"]') && !document.querySelector('[aria-label="Saved Grok Bot accounts"]')`) === true)
    await ev(`window.stoke.plugins.install('project-summary')`)
    check('native marketplace package installs disabled', await ev<boolean>(`window.stoke.plugins.read().then(view => view.entries.find(entry => entry.manifest.id === 'project-summary').installed && !view.entries.find(entry => entry.manifest.id === 'project-summary').enabled)`) === true)
    await ev(`window.stoke.plugins.toggle('project-summary', true)`)
    await ev(`[...document.querySelectorAll('.plugin-row')].find(row => row.textContent.includes('Project summary')).querySelector('button').click(), true`)
    const output = await ev<{ ok: boolean; output: string }>(`window.stoke.plugins.run('project-summary', 'read', ${JSON.stringify(proj)})`)
    check('packaged Electron runs a native extension with chosen project context', output.ok && JSON.parse(output.output).project === proj, output.output)
    await shot('04-plugin-manager')
    await ev(`window.stoke.plugins.toggle('project-summary', false)`)
    check('disabled extension panel disappears immediately', await waitFor('extension panel unmounted', () => ev<boolean>(`![...document.querySelectorAll('.plugin-panel h3')].some(node => node.textContent === 'Project summary')`)) === true)
    await ev(`window.stoke.plugins.remove('project-summary')`)
    await ev(`document.querySelector('[data-testid="plugin-back"]').click(), true`)
    await ev(`window.stoke.plugins.install('grok-bot')`)
    await ev(`window.stoke.plugins.toggle('grok-bot', true)`)
    await ev(`[...document.querySelectorAll('.plugin-row')].find(row => row.textContent.includes('Grok Bot')).querySelector('button').click(), true`)
    await waitFor('enabled Grok Bot panel', () => ev<boolean>(`!!document.querySelector('[aria-label="Grok Bot"]')`))
    if (opt['gbot-cli']) {
      const runtime = join(ud, 'plugins', 'runtime', 'grok-bot', '0.12.4'); mkdirSync(runtime, { recursive: true })
      for (const filename of ['gbot.mjs', 'gbot-flight.mjs']) copyFileSync(join(resolve(opt['gbot-cli']), filename), join(runtime, filename))
      const requests: { token: string; route: string; method: string }[] = []
      server = createHttpServer(async (request, response) => {
        for await (const _chunk of request) { /* drain only owned request bodies */ }
        const method = request.url?.split('/').at(-1) ?? ''
        requests.push({ token: String(request.headers.authorization), route: String(request.headers['x-owned-route']), method })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(method === 'listAgents' ? { agents: [{ id: 'owned-bot', name: 'Owned native bot' }, { id: 'owned-group', name: 'Owned group', isGroup: true }] } : method === 'sendPrompt' ? { messageId: 'owned-message' } : { entries: [] }))
      })
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
      const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      for (let index = 1; index <= 5; index++) await ev(`window.stoke.grokBot.change(${JSON.stringify({ kind: 'manual', label: `Grok account ${index}`, gatewayUrl: gateway, token: `owned-native-token-${index}`, headers: { 'x-owned-route': `route-${index}` }, allowLocal: true })})`)
      const view = await ev<{ accounts: { id: string }[] }>('window.stoke.grokBot.read()')
      await waitFor('five native account rows', () => ev<boolean>(`document.querySelectorAll('.plugin-account-list .plugin-account').length === 5`))
      check('native manager supports five separately sealed account sessions', view.accounts.length === 5)
      for (let index = 0; index < 5; index++) {
        const result = await ev<{ ok: boolean; message?: string }>(`window.stoke.grokBot.operate(${JSON.stringify({ accountId: view.accounts[index].id, kind: 'list' })})`, 30000)
        check(`native pinned CLI selects Grok account ${index + 1}`, result.ok && requests.slice(-2).every(request => request.token === `Bearer owned-native-token-${index + 1}` && request.route === `route-${index + 1}`), result.message ?? '')
      }
      await ev(`document.querySelectorAll('.plugin-account-list .plugin-account')[4].click(), true`)
      check('selecting a native account changes the visible active nickname', await waitFor('fifth account selection', () => ev<boolean>(`[...document.querySelectorAll('[aria-label="Grok Bot"] .plugin-controls')].some(node => node.textContent.includes('Active: Grok account 5'))`)) === true)
      await ev(`[...document.querySelectorAll('[aria-label="Grok Bot"] button')].find(button => button.textContent.includes('List bots and groups')).click(), true`)
      await waitFor('selected-account native bot roster', () => ev<boolean>(`document.querySelector('[aria-label="Grok Bot"] .plugin-output')?.textContent.includes('Owned native bot') && document.querySelector('[aria-label="Grok Bot"] select')?.options.length >= 3`))
      check('the visible list action routes through the selected fifth account', requests.slice(-2).every(request => request.token === 'Bearer owned-native-token-5'))
      await ev(`(() => { const field = document.querySelector('[aria-label="Grok Bot"] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'owned native message'); field.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`)
      await waitFor('native send action enabled', () => ev<boolean>(`[...document.querySelectorAll('[aria-label="Grok Bot"] button')].some(button => button.textContent === 'Send message' && !button.disabled)`))
      await ev(`[...document.querySelectorAll('[aria-label="Grok Bot"] button')].find(button => button.textContent === 'Send message').click(), true`)
      await waitFor('native send receipt', () => ev<boolean>(`document.querySelector('[aria-label="Grok Bot"] .plugin-output')?.textContent.includes('accepted')`))
      check('the native send action uses account 5 and the owned local gateway', requests.at(-1)?.method === 'sendPrompt' && requests.at(-1)?.token === 'Bearer owned-native-token-5')
      await ui!.send('Emulation.setDeviceMetricsOverride', { width: 940, height: 720, deviceScaleFactor: 1, mobile: false })
      await sleep(200); await shot('04-grok-bot-five-accounts'); await ui!.send('Emulation.clearDeviceMetricsOverride')
      const sealed = readFileSync(join(ud, 'plugins', 'grok-bot-accounts.json'), 'utf8')
      check('native saved accounts expose no gateway token in the file', !sealed.includes('owned-native-token-'))
    }
    await ev(`window.stoke.plugins.toggle('grok-bot', false)`)
    check('disabling Grok Bot removes its account rows and all controls', await waitFor('Grok controls unmounted', () => ev<boolean>(`!document.querySelector('[aria-label="Grok Bot"]') && !document.querySelector('.plugin-account-list')`)) === true)
    check('disabled Grok Bot cannot run through preload IPC', await ev<boolean>(`window.stoke.grokBot.read().then(() => false, () => true)`) === true)
  } finally {
    await ui!.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    await ev(`window.stoke.plugins.toggle('grok-bot', false).catch(() => null)`).catch(() => {})
    await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), true`).catch(() => {})
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  }
})

await step('three agents side by side', async () => {
  const ids = Object.values(tabs).map((t) => t!.ptyId)
  check('three tabs, three terminals', new Set(ids).size === 3, JSON.stringify(tabs))
  const pids = Object.values(tabs).map((t) => t!.pid)
  check('three processes', new Set(pids).size === 3, JSON.stringify(pids))
  const tabCount = await ev<number>('document.querySelectorAll(".tablist .tab").length')
  check('the strip shows a tab for each', tabCount >= 3, `${tabCount} tabs`)
  const tags = await ev<string[]>('[...document.querySelectorAll(".tablist .tab .tab-agent")].map((e) => e.getAttribute("title"))')
  console.log(`  (agent tags: ${JSON.stringify(tags)})`)
  await shot('03-three-agents')
})

await step('the active account follows the agent and fits the title bar', async () => {
  let created = ''
  try {
    for (const id of AGENTS) {
      await activate(tabs[id]!.ptyId)
      const expected = id === 'opencode' ? 'Identity unavailable' : `${id}@example.test`
      await waitFor(`${id}'s own account indicator`, () => ev<boolean>(`document.querySelector('[data-testid="active-account"] .account-chip-identity')?.textContent === ${JSON.stringify(expected)}`))
      check(`${id}: the top bar names its own agent and account`, await ev<boolean>(`document.querySelector('[data-testid="active-account"]')?.textContent.includes(${JSON.stringify(id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'OpenCode')}) && document.querySelector('[data-testid="active-account"]')?.getAttribute('data-account') === 'default'`) === true)
    }
    await activate(tabs.claude!.ptyId)
    await ui!.send('Emulation.setDeviceMetricsOverride', { width: 940, height: 720, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    check('every visible title-bar action fits at the minimum window width', await ev<boolean>(`[...document.querySelectorAll('.titlebar-actions button')].filter(button => button.offsetWidth).every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight; })`) === true)
    await ev(`document.querySelector('[data-testid="active-account"]').click(), true`)
    await waitFor('the account popover', () => ev<boolean>(`document.querySelector('[data-testid="account-identity"]')?.textContent === 'claude@example.test'`))
    check('the account popover fits and receives keyboard focus', await ev<boolean>(`(() => { const panel = document.querySelector('.account-panel'), r = panel.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight && document.activeElement === panel; })()`) === true)
    check('the popover includes Stoke’s own sync sign-in', await ev<boolean>(`document.querySelector('.account-panel-sync')?.textContent.includes('Stoke account')`) === true)
    await shot('04-account-details-narrow')
    await ui!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await ui!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    check('Escape closes account details and returns focus to its button', await ev<boolean>(`!document.querySelector('.account-panel') && document.activeElement === document.querySelector('[data-testid="active-account"]')`) === true)
    await ui!.send('Emulation.clearDeviceMetricsOverride')
    const account = await ev<{ ok: boolean; account?: { id: string } }>(`window.stoke.accounts.create({ cli: 'claude', kind: 'login', name: 'work' })`)
    if (!account.ok || !account.account) throw new Error('the isolated Work account could not be created')
    created = account.account.id
    await ev(`document.querySelector('[data-testid="active-account"]').click(), true`)
    await waitFor('account details reopened', () => ev<boolean>('!!document.querySelector(".account-panel")'))
    await ev(`[...document.querySelectorAll('.account-panel button')].find(button => button.textContent === 'Manage agent accounts').click(), true`)
    await waitFor('Default and Work identities in account settings', () => ev<boolean>(`document.querySelector('[data-testid="default-account-identity"]')?.textContent === 'claude@example.test' && document.querySelector('.agent-account-stored[data-account="${created}"]')?.textContent.includes('work@example.test')`))
    check('Settings shows each account’s own signed-in email', await ev<boolean>(`!!document.querySelector('[data-testid="agent-accounts"]') && !document.querySelector('.account-panel')`) === true)
    check('the existing login is clearly Default; saved accounts and add forms start compact', await ev<boolean>(`document.querySelector('.account-manager-existing')?.textContent.includes('You don’t need to add it again') && !document.querySelector('.agent-account-stored form') && !document.querySelector('[data-testid="add-login-account"]').open && !document.querySelector('[data-testid="add-api-account"]').open && !!document.querySelector('[data-testid="add-account-start"]')`) === true)
    await ui!.send('Emulation.setDeviceMetricsOverride', { width: 940, height: 720, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    check('account summaries and actions fit the minimum desktop width', await ev<boolean>(`(() => { const pane = document.querySelector('[data-testid="agent-accounts"]'), r = pane.getBoundingClientRect(); return [...pane.querySelectorAll('.account-manager-existing, .account-manager-summary, button')].filter(el => el.offsetWidth).every(el => { const box = el.getBoundingClientRect(); return box.left >= r.left && box.right <= r.right + 1 }); })()`) === true)
    await waitFor('the Settings highlight to settle before its screenshot', () => ev<boolean>(`!document.querySelector('[data-testid="agent-accounts"]').hasAttribute('data-flash')`))
    await shot('04-account-settings')
    await ev(`document.querySelector('[data-testid="add-account-start"]').click(), true`)
    await waitFor('account connection methods', () => ev<boolean>(`!!document.querySelector('[data-testid="choose-login-account"]') && !!document.querySelector('[data-testid="choose-api-account"]')`))
    check('Add account presents subscription and API access without showing saved-account controls', await ev<boolean>(`document.querySelector('.agent-account-list').hidden && !document.querySelector('[data-testid="add-login-account"]').open && !document.querySelector('[data-testid="add-api-account"]').open`) === true)
    await shot('04-account-add-choice')
    await ev(`document.querySelector('[data-testid="choose-api-account"]').click(), true`)
    await waitFor('focused API form', () => ev<boolean>(`document.querySelector('[data-testid="add-api-account"]').open`))
    await ev(`document.querySelector('[data-testid="add-api-account"] input[type="password"]').focus(), true`)
    await ui!.send('Input.insertText', { text: 'owned-unsaved-key' })
    await shot('04-account-add-api')
    await ev(`[...document.querySelectorAll('.account-manager-heading button')].find(b => b.textContent === 'Cancel').click(), true`)
    await waitFor('cancel restores the account list and keyboard focus', () => ev<boolean>(`!document.querySelector('.agent-account-list').hidden && document.activeElement === document.querySelector('[data-testid="add-account-start"]')`))
    check('Cancel clears the unsaved API key and preserves the active account', await ev<boolean>(`document.querySelector('[data-testid="add-api-account"] input[type="password"]').value === '' && document.querySelector('.account-manager-existing input').checked`) === true)
    await ui!.send('Emulation.clearDeviceMetricsOverride')
  } finally {
    await ui!.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), document.querySelector('[data-testid="active-account"][aria-expanded="true"]')?.click(), true`).catch(() => {})
    if (created) await ev(`window.stoke.accounts.remove(${JSON.stringify(created)})`).catch(() => {})
  }
})

async function openAccountAdd(kind: 'login' | 'key'): Promise<void> {
  await ev(`document.querySelector('[data-testid="add-account-start"]').click(), true`)
  await waitFor('one add-account choice or form', () => ev<boolean>(`!!document.querySelector('[data-testid="choose-login-account"]') || document.querySelector('[data-testid="add-api-account"]')?.open === true`))
  await ev(`document.querySelector('[data-testid="choose-${kind === 'login' ? 'login' : 'api'}-account"]')?.click(), true`)
  await waitFor('the chosen account form', () => ev<boolean>(`document.querySelector('[data-testid="add-${kind === 'login' ? 'login' : 'api'}-account"]')?.open === true`))
}

await step('sidebar accounts, repository details and bottom-left terminal are discoverable', async () => {
  const savedWidth = await ev<number>('Number(document.querySelector(\'[aria-label="Resize sidebar"]\')?.getAttribute("aria-valuenow") || 260)')
  const hadSidebar = await ev<boolean>('!!document.querySelector(".sidebar")')
  const closeSettings = async () => { await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), true`) }
  const resizeSidebar = async (width: number) => {
    await waitFor('the sidebar resize handle to be live and unobstructed', () => ev<boolean>(`(() => { const handle = document.querySelector('[aria-label="Resize sidebar"]'); if (!handle || handle.closest('[inert]')) return false; const r = handle.getBoundingClientRect(); return r.width > 0 && r.height > 0 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === handle; })()`))
    const point = await ev<{ x: number; y: number; delta: number }>(`(() => { const handle = document.querySelector('[aria-label="Resize sidebar"]'), r = handle.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, delta: ${width} - Number(handle.getAttribute('aria-valuenow')) }; })()`)
    await ui!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
    try {
      // Resizer's pointer-move handler uses React's committed dragging state.
      // CDP can otherwise move and release before that first render lands.
      await waitFor('the sidebar drag to start', () => ev<boolean>(`document.querySelector('[aria-label="Resize sidebar"]')?.getAttribute('data-dragging') === 'true'`))
      await ui!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + point.delta, y: point.y, button: 'left', buttons: 1 })
      await waitFor('the sidebar resize to reach the renderer', () => ev<boolean>(`document.querySelector('[aria-label="Resize sidebar"]')?.getAttribute('aria-valuenow') === '${width}'`))
    } finally {
      await ui!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + point.delta, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
    }
    await waitFor('the sidebar drag to finish', () => ev<boolean>(`document.querySelector('[aria-label="Resize sidebar"]')?.getAttribute('data-dragging') === 'false'`))
    await waitFor('the sidebar resize to reach the renderer', () => ev<boolean>(`document.querySelector('[aria-label="Resize sidebar"]')?.getAttribute('aria-valuenow') === '${width}'`))
  }
  const overview = async () => {
    await ev(`document.querySelector('[data-testid="stoke-account"]').click(), true`)
    await waitFor('the sidebar account menu', () => ev<boolean>('!!document.querySelector(".account-panel")'))
    await ev(`[...document.querySelectorAll('.account-panel button')].find(button => button.textContent === 'Manage accounts').click(), true`)
    await waitFor('the shared Accounts overview', () => ev<boolean>('!!document.querySelector(\'[data-testid="accounts-overview"]\')'))
  }
  try {
    await activate(tabs.claude!.ptyId)
    if (!hadSidebar) await ev('document.querySelector(\'button[title="Toggle sidebar"]\').click(), true')
    await ui!.send('Emulation.setDeviceMetricsOverride', { width: 940, height: 720, deviceScaleFactor: 1, mobile: false })
    await resizeSidebar(200)
    await waitFor('the owned repository branch in the bottom bar', () => ev<boolean>(`document.querySelector('[data-testid="footer-repository"] .status-repository-branch')?.textContent === 'probe-ui'`))
    check('Git sits immediately after the local folder in the bottom bar and is absent from the title bar', await ev<boolean>(`document.querySelector('.statusbar > .status-shrink')?.nextElementSibling === document.querySelector('[data-testid="footer-repository"]') && !document.querySelector('.topbar [data-kind="git"]')`) === true)
    check('footer repository and fixed actions fit at the minimum window width', await ev<boolean>(`[...document.querySelectorAll('.statusbar button, .statusbar > .pill')].filter(el => el.offsetWidth).every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })`) === true)
    await ev(`document.querySelector('.status-repository-button').click(), true`)
    await waitFor('repository details', () => ev<boolean>('!!document.querySelector(".context-menu")'))
    check('repository details name untracked files and the last-fetch caveat', await ev<boolean>(`document.querySelector('.context-menu')?.textContent.includes('untracked') && document.querySelector('.context-menu')?.textContent.includes('last fetch')`) === true)
    await ev(`[...document.querySelectorAll('.context-menu-item')].find(button => button.textContent === 'Copy branch name').click(), true`)
    check('Copy branch name uses the actual repository branch', (await ev<{ ok: boolean; text?: string }>('window.stoke.clipboard.readSync()')).text === 'probe-ui')
    await ev(`document.querySelector('[data-testid="stoke-account"]').click(), true`)
    await waitFor('sidebar Stoke account details', () => ev<boolean>('!!document.querySelector(".account-panel")'))
    check('the sidebar popup opens above its account row, fits at 940px and receives focus', await ev<boolean>(`(() => { const panel = document.querySelector('.account-panel'), r = panel.getBoundingClientRect(), button = document.querySelector('[data-testid="stoke-account"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= button.top && document.activeElement === panel; })()`) === true)
    check('Stoke sign-in is distinct from the active agent email', await ev<boolean>(`document.querySelector('.account-panel-sync')?.textContent.includes('Not signed in') && !document.querySelector('[data-testid="account-identity"]') && document.querySelector('[data-testid="active-account"]')?.textContent.includes('claude@example.test')`) === true)
    await waitFor('the account popup animation to finish', () => ev<boolean>(`getComputedStyle(document.querySelector('.account-panel')).opacity === '1'`))
    await shot('04-sidebar-account-git')
    await ui!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await ui!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    check('Escape returns focus to the sidebar account row', await ev<boolean>(`!document.querySelector('.account-panel') && document.activeElement === document.querySelector('[data-testid="stoke-account"]')`) === true)
    await overview()
    check('the overview separates Stoke sign-in and the Claude/Codex account editors', await ev<boolean>(`!!document.querySelector('[data-setting="accounts.stoke"]') && ['claude','codex'].every(cli => document.querySelector('.accounts-agent[data-cli="' + cli + '"]')?.textContent.includes('Default · Existing setup')) && !document.querySelector('.accounts-settings input')`) === true)
    check('overview actions fit inside the narrow settings pane', await ev<boolean>(`(() => { const pane = document.querySelector('[data-testid="accounts-overview"]').getBoundingClientRect(); return [...document.querySelectorAll('.accounts-settings button')].every(button => { const r = button.getBoundingClientRect(); return r.left >= pane.left && r.right <= pane.right + 1 }); })()`) === true)
    await waitFor('overview highlight to settle', () => ev<boolean>(`!document.querySelector('[data-testid="accounts-overview"]').hasAttribute('data-flash')`))
    await waitFor('the settings animation to finish', () => ev<boolean>(`getComputedStyle(document.querySelector('.settings-modal')).opacity === '1'`))
    await shot('04-accounts-overview')
    await ev(`document.querySelector('.accounts-agent[data-cli="codex"]').click(), true`)
    await waitFor('dedicated Codex accounts submenu', () => ev<boolean>(`document.querySelector('[data-testid="agent-account-page"]')?.dataset.cli === 'codex' && !document.querySelector('#agent-page')`))
    await openAccountAdd('login')
    await waitFor('Codex subscription setup from the overview', () => ev<boolean>(`document.querySelector('[data-testid="add-login-account"]')?.open && !!document.querySelector('[aria-label="New ${cliFor('codex').label} account name"]')`))
    check('Add sign-in opens the correct scoped subscription form', true)
    await closeSettings()
    await overview()
    await ev(`document.querySelector('.accounts-agent[data-cli="claude"]').click(), true`)
    await waitFor('dedicated Claude accounts submenu', () => ev<boolean>(`document.querySelector('[data-testid="agent-account-page"]')?.dataset.cli === 'claude' && !document.querySelector('#agent-page')`))
    await openAccountAdd('key')
    await waitFor('Claude API setup from the overview', () => ev<boolean>(`document.querySelector('[data-testid="add-api-account"]')?.open && !!document.querySelector('[aria-label="New Claude Code API account name"]')`))
    check('Add API account opens the correct scoped API form', true)
    await closeSettings()
    const before = await ev<{ state: QuickTerminalState }>('window.stoke.quickTerminal.read()')
    check('quick terminal remains disabled until the user enables it', before.state.enabled === false && !before.state.id)
    await ev(`document.querySelector('[data-testid="footer-terminal"]').focus(), true`)
    await pressEnter()
    await waitFor('terminal opt-in Settings from the footer', () => ev<boolean>(`!!document.querySelector('[data-setting="appearance.quick-terminal"]')`))
    check('pressing Enter on the disabled terminal button opens setup without starting a shell', await ev<boolean>(`!document.querySelector('[data-setting="appearance.quick-terminal"] input').checked && window.stoke.quickTerminal.read().then(snapshot => !snapshot.state.id && !snapshot.state.enabled)`) === true)
    await closeSettings()
    await ev('document.querySelector(\'button[title="Toggle sidebar"]\').click(), true')
    check('Terminal stays at bottom left with the sidebar hidden', await ev<boolean>(`(() => { const r = document.querySelector('[data-testid="footer-terminal"]').getBoundingClientRect(); return !document.querySelector('.sidebar') && !!document.querySelector('[data-testid="footer-repository"]') && r.left <= 16 && r.bottom <= innerHeight && r.top > innerHeight - 50; })()`) === true)
    await ev('document.querySelector(\'button[title="Toggle sidebar"]\').click(), true')
  } finally {
    await ui!.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    await closeSettings().catch(() => {})
    await ev(`document.querySelector('[data-testid="stoke-account"][aria-expanded="true"]')?.click(), true`).catch(() => {})
    if (!await ev<boolean>('!!document.querySelector(".sidebar")')) await ev('document.querySelector(\'button[title="Toggle sidebar"]\').click(), true')
    await resizeSidebar(savedWidth).catch(() => {})
    if (!hadSidebar && await ev<boolean>('!!document.querySelector(".sidebar")')) await ev('document.querySelector(\'button[title="Toggle sidebar"]\').click(), true')
  }
})

await step('completed sign-ins close with the verified email; failed and unknown sign-ins stay visible', async () => {
  const created: string[] = []
  const signInPtys: string[] = []
  const openAccounts = async (cli: 'claude' | 'codex') => {
    await activate(tabs[cli]!.ptyId)
    await ev(`document.querySelector('[data-testid="active-account"]').click(), true`)
    await waitFor('account details for sign-in', () => ev<boolean>('!!document.querySelector(".account-panel")'))
    await ev(`[...document.querySelectorAll('.account-panel button')].find(button => button.textContent === 'Manage agent accounts').click(), true`)
    await waitFor('agent sign-in settings', () => ev<boolean>('!!document.querySelector(\'[data-testid="add-account"]\')'))
    await ev(`document.querySelectorAll('.toast-close').forEach(button => button.click()), true`)
    await waitFor('previous account notifications to dismiss', () => ev<boolean>('!document.querySelector(".toast")'))
  }
  try {
    for (const cli of ['claude', 'codex'] as const) {
      await openAccounts(cli)
      await openAccountAdd('login')
      await waitFor('the add sign-in form to open', () => ev<boolean>(`document.querySelector('[data-testid="add-login-account"]').open`))
      const before = await ev<string[]>('[...window.stokeTerminals.keys()]')
      const accountId = `${cli}-login-probe`
      if (cli === 'claude') writeFileSync(join(agentsDir, 'login-wait'), 'owned CI fixture')
      await ev(`document.querySelector('[aria-label="New ${cliFor(cli).label} account name"]').focus(), true`)
      await ui!.send('Input.insertText', { text: 'Login probe' })
      await ev(`document.querySelector('[data-testid="add-account"]').click(), true`)
      await waitFor('the isolated login account to persist', () => ev<boolean>(`window.stoke.settings.get().then(s => !!s.accounts[${JSON.stringify(accountId)}])`))
      created.push(accountId)
      if (cli === 'claude') {
        const ptyId = await termShowing('Signing in with the owned probe account', 'the owned sign-in tab', 20_000, before)
        signInPtys.push(ptyId)
        await activate(tabs.codex!.ptyId)
        rmSync(join(agentsDir, 'login-wait'), { force: true })
      }
      // Codex exits immediately, also exercising the cached PTY-exit replay
      // when the native process finishes before React adopts its tab.
      const title = `Successfully signed in to ${cli === 'claude' ? 'Claude Code' : 'Codex'} as ${cli}@example.test`
      await waitFor('a success popup naming the native account email', () => ev<boolean>(`[...document.querySelectorAll('.toast-title')].some(node => node.textContent === ${JSON.stringify(title)})`))
      await waitFor('the completed sign-in tab to close automatically', () => ev<boolean>(`![...document.querySelectorAll('.tablist .tab')].some(tab => tab.textContent.includes('Sign in · Login probe')) && [...window.stokeTerminals.keys()].every(id => ${JSON.stringify(before)}.includes(id))`))
      if (cli === 'claude') check('a background sign-in finishing preserves the foreground session', await ev(ACTIVE_PTY) === tabs.codex!.ptyId)
      check(`${cli}: successful sign-in closes its tab and identifies the reported email`, true)
      await shot(`04-${cli}-login-success`)
    }

    for (const outcome of ['failed', 'unverified'] as const) {
      const cli = outcome === 'failed' ? 'codex' : 'claude'
      await openAccounts(cli)
      const before = await ev<string[]>('[...window.stokeTerminals.keys()]')
      const marker = join(agentsDir, outcome === 'failed' ? 'login-fail' : 'identity-unavailable')
      writeFileSync(marker, 'owned CI fixture')
      writeFileSync(join(agentsDir, 'login-wait'), 'owned CI fixture')
      await ev(`[...document.querySelectorAll('.agent-account-stored[data-account="${cli}-login-probe"] button')].find(button => ['Sign in', 'Reconnect'].includes(button.textContent.trim())).click(), true`)
      const ptyId = await termShowing('Signing in with the owned probe account', 'the unsuccessful sign-in tab', 20_000, before)
      signInPtys.push(ptyId)
      rmSync(join(agentsDir, 'login-wait'), { force: true })
      const title = `${cli === 'claude' ? 'Claude Code' : 'Codex'} sign-in ${outcome === 'failed' ? 'did not complete' : 'could not be verified'}`
      await waitFor('the unsuccessful sign-in notification', () => ev<boolean>(`[...document.querySelectorAll('.toast-title')].some(node => node.textContent === ${JSON.stringify(title)})`))
      check(`${outcome}: the sign-in output stays visible and no success is announced`, await ev<boolean>(`window.stokeTerminals.has(${JSON.stringify(ptyId)}) && ![...document.querySelectorAll('.toast-title')].some(node => node.textContent.startsWith('Successfully signed in'))`) === true)
      await shot(`04-login-${outcome}`)
      rmSync(marker, { force: true })
      await activate(ptyId)
      await ev('(document.querySelector(".tablist .tab[aria-selected=\'true\'] .tab-close")?.click(), true)')
      await waitFor('the reviewed sign-in tab to close', () => ev<boolean>(`!window.stokeTerminals.has(${JSON.stringify(ptyId)})`))
    }

    await ev('document.querySelector(\'button[title^="New session"]\').click(), true')
    await waitFor('Stoke account access on a New tab', () => ev<boolean>(`document.querySelector('[data-testid="active-account"] .account-chip-label')?.textContent === 'Accounts'`))
    check('a New tab shows Stoke sign-in without borrowing a local agent account', await ev<boolean>(`!document.querySelector('[data-testid="active-account"]').hasAttribute('data-account')`) === true)
    await ev(`document.querySelector('[data-testid="active-account"]').click(), true`)
    await waitFor('Stoke-only account details', () => ev<boolean>(`!!document.querySelector('.account-panel-sync') && !document.querySelector('[data-testid="account-identity"]')`))
    await shot('04-stoke-account-new-tab')
    await ev(`[...document.querySelectorAll('.account-panel button')].find(button => button.textContent === 'Codex / OpenAI API').click(), true`)
    await waitFor('API setup directly from a New tab', () => ev<boolean>(`!!document.querySelector('[aria-label="New ${cliFor('codex').label} API account name"]')`))
    await ev(`document.querySelector('button[title="Close settings (Esc)"]').click(), document.querySelector('.tablist .tab[aria-selected="true"] .tab-close').click(), true`)
  } finally {
    for (const marker of ['login-wait', 'login-fail', 'identity-unavailable']) rmSync(join(agentsDir, marker), { force: true })
    await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), document.querySelector('[data-testid="active-account"][aria-expanded="true"]')?.click(), true`).catch(() => {})
    for (const ptyId of signInPtys) {
      await ev(`document.querySelector('.tablist .tab[data-tab-id="${ptyId}"] .tab-close')?.click(), true`).catch(() => {})
    }
    for (const id of created) await ev(`window.stoke.accounts.remove(${JSON.stringify(id)})`).catch(() => {})
    await activate(tabs.claude!.ptyId)
  }
})

await step('named API profiles save in Settings and launch with their own credentials', async () => {
  const savedDefaults = await ev<Record<string, string>>('window.stoke.settings.get().then(s => s.agents.defaultAccount)')
  const created: string[] = []
  const opened: string[] = []
  try {
    for (const cli of ['claude', 'codex'] as const) {
      await activate(tabs[cli]!.ptyId)
      await ev(`document.querySelector('[data-testid="active-account"]').click(), true`)
      await waitFor('account details for API setup', () => ev<boolean>('!!document.querySelector(".account-panel")'))
      await ev(`[...document.querySelectorAll('.account-panel button')].find(button => button.textContent === 'Add API account').click(), true`)
      await waitFor('API account fields', () => ev<boolean>('!!document.querySelector(\'[aria-label="New API account provider"]\')'))
      await waitFor('the API shortcut to reveal its Settings fields', () => ev<boolean>(`(() => { const r = document.querySelector('[data-setting="agent-accounts.api"]').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()`))
      // The settings jump focuses its first control after the disclosure settles.
      // Starting to type before that focus transfer can put a key in the nickname.
      await waitFor('the API shortcut to finish moving focus', () => ev<boolean>(`document.activeElement === document.querySelector('[aria-label="New ${cliFor(cli).label} API account name"]')`))
      check(`${cli}: the API provider menu groups gateways under Custom`, await ev<boolean>(`(() => { const options = [...document.querySelector('[aria-label="New API account provider"]').options].map(option => option.value); return options.length === 2 && options.includes('${cli === 'claude' ? 'anthropic' : 'openai'}') && options.includes('custom') })()`) === true)
      if (cli === 'codex') {
        await ev(`(() => { const s = document.querySelector('[aria-label="New API account provider"]'); s.value = 'custom'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
        await waitFor('custom gateway presets', () => ev<boolean>(`!!document.querySelector('[aria-label="New API account custom service"]')`))
        await ev(`(() => { const s = document.querySelector('[aria-label="New API account custom service"]'); s.value = 'nanogpt'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
        await waitFor('the NanoGPT preset to apply its route', () => ev<boolean>(`document.querySelector('[data-testid="add-api-account"] [data-api-provider="nanogpt"]')?.textContent.includes('https://nano-gpt.com/api/v1')`))
      }
      let model = cli === 'claude' ? 'claude-api-probe' : 'openai/api-probe'
      await ev(`document.querySelector('[aria-label="New API account model ID"]').focus(), true`)
      await ui!.send('Input.insertText', { text: model })
      await ev(`document.querySelector('[aria-label="New ${cliFor(cli).label} API account name"]').focus(), true`)
      await ui!.send('Input.insertText', { text: 'API probe' })
      let key = ['owned', cli, 'probe', 'credential'].join('-')
      await ev(`document.querySelector('[data-testid="add-api-account"] input[type="password"]').focus(), true`)
      await ui!.send('Input.insertText', { text: key })
      await waitFor('the three API account fields to retain their typed values', () => ev<boolean>(`document.querySelector('[aria-label="New ${cliFor(cli).label} API account name"]').value === 'API probe' && document.querySelector('[aria-label="New API account model ID"]').value === ${JSON.stringify(model)} && document.querySelector('[data-testid="add-api-account"] input[type="password"]').value === ${JSON.stringify(key)}`))
      await ev(`[...document.querySelectorAll('.agent-accounts button')].find(button => button.textContent.trim() === 'Add API account').click(), true`)
      const accountId = `${cli}-api-probe`
      await waitFor('the named API account to persist', () => ev<boolean>(`window.stoke.settings.get().then(s => s.accounts[${JSON.stringify(accountId)}]?.apiProfile?.model === ${JSON.stringify(model)})`))
      created.push(accountId)
      await waitFor('the saved API account summary', () => ev<boolean>(`document.querySelector('.agent-account-stored[data-account="${accountId}"]')?.textContent.includes('API probe')`))
      check(`${cli}: saved API keys and settings stay behind Edit`, await ev<boolean>(`!document.querySelector('.agent-account-stored[data-account="${accountId}"] input[type="password"]') && !document.querySelector('[data-testid="add-api-account"]').open`) === true)
      const edit = async () => {
        await ev(`[...document.querySelectorAll('.agent-account-stored[data-account="${accountId}"] button')].find(button => button.textContent.trim() === 'Edit').click(), true`)
        await waitFor('the account editor', () => ev<boolean>(`!!document.querySelector('.agent-account-stored[data-account="${accountId}"] form')`))
      }
      const fill = async (aria: string, text: string) => {
        await ev(`(() => { const input = document.querySelector(${JSON.stringify(`[aria-label="${aria}"]`)}); input.scrollIntoView({ block: 'center' }); input.focus(); input.select(); return true })()`)
        await ui!.send('Input.insertText', { text })
      }
      await edit()
      if (cli === 'codex') check('saved NanoGPT accounts retain their preset, pinned URL and model under Custom', await ev<boolean>(`document.querySelector('[aria-label="API probe provider"]').value === 'custom' && document.querySelector('[aria-label="API probe custom service"]').value === 'nanogpt' && document.querySelector('[data-api-provider="nanogpt"]').textContent.includes('https://nano-gpt.com/api/v1') && document.querySelector('[aria-label="API probe model ID"]').value === ${JSON.stringify(model)}`) === true)
      await fill('API probe name', 'Unsaved nickname')
      await fill('API probe model ID', 'unsaved-model')
      await fill('API probe API key', ['owned', 'unsaved', 'credential'].join('-'))
      await ev(`[...document.querySelectorAll('.agent-account-stored[data-account="${accountId}"] form button')].find(button => button.textContent.trim() === 'Cancel').click(), true`)
      check(`${cli}: Cancel discards nickname, model and key drafts`, await ev<boolean>(`window.stoke.settings.get().then(s => s.accounts[${JSON.stringify(accountId)}].label === 'API probe' && s.accounts[${JSON.stringify(accountId)}].apiProfile.model === ${JSON.stringify(model)} && s.accounts[${JSON.stringify(accountId)}].apiKey === ${JSON.stringify(key)} && !document.querySelector('.agent-account-stored[data-account="${accountId}"] form'))`) === true)
      await edit()
      model += '-edited'
      key += '-edited'
      await fill('API probe name', 'API edited')
      await fill('API probe model ID', model)
      await fill('API probe API key', key)
      await shot(`04-${cli}-api-account-edit`)
      await ev(`[...document.querySelectorAll('.agent-account-stored[data-account="${accountId}"] form button')].find(button => button.textContent.trim() === 'Save changes').click(), true`)
      await waitFor('nickname, model and key to save together', () => ev<boolean>(`window.stoke.settings.get().then(s => s.accounts[${JSON.stringify(accountId)}].label === 'API edited' && s.accounts[${JSON.stringify(accountId)}].apiProfile.model === ${JSON.stringify(model)} && s.accounts[${JSON.stringify(accountId)}].apiKey === ${JSON.stringify(key)} && s.accounts[${JSON.stringify(accountId)}].apiProfile.provider === '${cli === 'claude' ? 'anthropic' : 'nanogpt'}' && !document.querySelector('.agent-account-stored[data-account="${accountId}"] form'))`))
      await ev(`document.querySelector('.agent-account-stored[data-account="${accountId}"] input[type="radio"]').click(), true`)
      await waitFor('the API account to become the launch default', () => ev<boolean>(`window.stoke.settings.get().then(s => s.agents.defaultAccount.${cli} === ${JSON.stringify(accountId)})`))
      await ev(`document.querySelector('.agent-account-stored[data-account="${accountId}"]').scrollIntoView({ block: 'center' }), true`)
      await shot(`04-${cli}-api-account-settings`)
      await ev(`document.querySelector('button[title="Close settings (Esc)"]').click(), true`)
      const folder = join(root, `${cli}-api-project`)
      mkdirSync(folder, { recursive: true })
      const taken = await ev<string[]>('[...window.stokeTerminals.keys()]')
      await stokeCli('--cli', cli, '--new', folder)
      const ptyId = await termShowing(`STOKE-PROBE ${cli} ready`, `the ${cli} API terminal`, 45_000, taken)
      opened.push(ptyId)
      await activate(ptyId)
      const pid = await pidIn(ptyId, cli)
      const rec = await waitFor('the API agent launch record', () => stubByPid(pid), 10_000)
      const env = rec!.start.env as Record<string, string>
      check(`${cli}: only its selected API credential reaches the launch`, env[cli === 'claude' ? 'ANTHROPIC_API_KEY' : 'STOKE_ACCOUNT_API_KEY'] === `<set, ${key.length} chars>` && !JSON.stringify(rec!.start.argv).includes(key))
      const flag = cli === 'claude' ? '--model' : '-m'
      check(`${cli}: the API profile supplies the configured model`, rec!.start.argv[rec!.start.argv.indexOf(flag) + 1] === model)
      check(`${cli}: the header names the selected API account`, await ev<boolean>(`document.querySelector('[data-testid="active-account"]')?.getAttribute('data-account') === ${JSON.stringify(accountId)} && document.querySelector('[data-testid="active-account"]')?.textContent.includes('API edited')`) === true)
      if (cli === 'claude') check('Anthropic API route clears inherited gateway auth', env.ANTHROPIC_BASE_URL === 'https://api.anthropic.com' && !env.ANTHROPIC_AUTH_TOKEN)
      else check('NanoGPT Codex route uses Responses without a saved OpenAI login', rec!.start.argv.includes('model_providers.stoke_account.requires_openai_auth=false') && rec!.start.argv.includes('model_providers.stoke_account.wire_api="responses"'))
      await waitFor('the API model/account to save for resume', () => ev<boolean>(`window.stoke.tabs.restore().then(s => s.tabs.some(t => t.accountId === ${JSON.stringify(accountId)} && t.model === ${JSON.stringify(model)}))`))
      await ev('(document.querySelector(".tablist .tab[aria-selected=\'true\'] .tab-close")?.click(), true)')
      await waitFor('the API fixture tab to close', () => ev<boolean>(`!window.stokeTerminals.has(${JSON.stringify(ptyId)})`))
    }
    await ev(`document.querySelector('[data-testid="stoke-account"]').click(), true`)
    await waitFor('account directory menu for OpenCode', () => ev<boolean>('!!document.querySelector(".account-panel")'))
    await ev(`[...document.querySelectorAll('.account-panel button')].find(button => button.textContent === 'Manage accounts').click(), true`)
    await waitFor('account directory for OpenCode', () => ev<boolean>(`!!document.querySelector('.accounts-agent[data-cli=opencode]')`))
    await ev(`document.querySelector('.accounts-agent[data-cli="opencode"]').click(), true`)
    await waitFor('focused OpenCode accounts page', () => ev<boolean>(`document.querySelector('[data-testid=agent-account-page]')?.dataset.cli === 'opencode'`))
    check('OpenCode accounts omit unrelated installation and tool settings', await ev<boolean>(`!document.querySelector('#agent-page') && !document.querySelector('[data-setting="agent.endpoint"]')`) === true)
    await openAccountAdd('key')
    await waitFor('saved API key source picker', () => ev<boolean>(`!!document.querySelector('[aria-label="OpenCode API key source"]')`))
    const sourceId = created.find(id => id.startsWith('claude-'))!
    const source = await ev<{ apiKey: string; apiProfile: { model: string } }>(`window.stoke.settings.get().then(settings => settings.accounts[${JSON.stringify(sourceId)}])`)
    await ev(`(() => { const select = document.querySelector('[aria-label="OpenCode API key source"]'); select.value = ${JSON.stringify(sourceId)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await waitFor('Anthropic key and model reused in OpenCode', () => ev<boolean>(`document.querySelector('[aria-label="New API account provider"]').value === 'anthropic' && document.querySelector('[aria-label="New API account model ID"]').value === ${JSON.stringify(source.apiProfile.model)} && document.querySelector('[data-testid="add-api-account"] input[type="password"]').value === ${JSON.stringify(source.apiKey)}`))
    check('OpenCode lists first-party APIs separately from Custom', await ev<boolean>(`[...document.querySelector('[aria-label="New API account provider"]').options].map(option => option.value).join(',') === 'anthropic,openai,custom'`) === true)
    await shot('04-opencode-reuse-anthropic-key')
    const accountId = 'opencode-api-edited'
    created.push(accountId)
    await ev(`[...document.querySelectorAll('.agent-accounts button')].find(button => button.textContent.trim() === 'Add API account').click(), true`)
    await waitFor('reused API account saved', () => ev<boolean>(`window.stoke.settings.get().then(settings => settings.accounts[${JSON.stringify(accountId)}]?.apiKey === ${JSON.stringify(source.apiKey)} && settings.accounts[${JSON.stringify(accountId)}]?.apiProfile.baseUrl === 'https://api.anthropic.com/v1')`))
    await ev(`document.querySelector('.agent-account-stored[data-account="${accountId}"] input[type="radio"]').click(), true`)
    await waitFor('OpenCode API account selected', () => ev<boolean>(`window.stoke.settings.get().then(settings => settings.agents.defaultAccount.opencode === '${accountId}')`))
    await ev(`document.querySelector('button[title="Close settings (Esc)"]').click(), true`)
    const folder = join(root, 'opencode-api-project'); mkdirSync(folder, { recursive: true })
    const taken = await ev<string[]>('[...window.stokeTerminals.keys()]')
    await stokeCli('--cli', 'opencode', '--new', folder)
    const ptyId = await termShowing('STOKE-PROBE opencode ready', 'OpenCode on its selected Anthropic account', 45_000, taken)
    opened.push(ptyId); await activate(ptyId)
    const pid = await pidIn(ptyId, 'opencode')
    const record = await waitFor('OpenCode API launch record', () => stubByPid(pid), 10_000)
    const env = record!.start.env as Record<string, string>
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    check('OpenCode uses the selected Anthropic key and Messages adapter', env.STOKE_ACCOUNT_API_KEY === `<set, ${source.apiKey.length} chars>` && config.provider.stoke_account.npm === '@ai-sdk/anthropic' && config.provider.stoke_account.options.apiKey === '{env:STOKE_ACCOUNT_API_KEY}' && config.provider.stoke_account.options.baseURL === 'https://api.anthropic.com/v1')
    check('OpenCode model and small model stay on the chosen account', record!.start.argv.includes(`stoke_account/${source.apiProfile.model}`) && config.model === config.small_model && config.enabled_providers.join(',') === 'stoke_account')
    check('OpenCode header names the API account', await ev<boolean>(`document.querySelector('[data-testid="active-account"]')?.getAttribute('data-account') === '${accountId}'`) === true)
    await ev('(document.querySelector(".tablist .tab[aria-selected=\'true\'] .tab-close")?.click(), true)')
    await waitFor('OpenCode API fixture tab to close', () => ev<boolean>(`!window.stokeTerminals.has(${JSON.stringify(ptyId)})`))
  } finally {
    await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), document.querySelector('[data-testid="active-account"][aria-expanded="true"]')?.click(), true`).catch(() => {})
    for (const ptyId of opened) await ev(`window.stoke.pty.kill(${JSON.stringify(ptyId)})`).catch(() => {})
    for (const id of created) await ev(`window.stoke.accounts.remove(${JSON.stringify(id)})`).catch(() => {})
    await ev(`window.stoke.settings.get().then(s => window.stoke.settings.set({ agents: { ...s.agents, defaultAccount: ${JSON.stringify(savedDefaults)} } }))`).catch(() => {})
    await activate(tabs.claude!.ptyId)
  }
})

await step('selected Claude logins own their authentication despite inherited and global API settings', async () => {
  const saved = await ev<{ providers: Record<string, unknown>; defaults: Record<string, string> }>('window.stoke.settings.get().then(s => ({ providers: s.providers, defaults: s.agents.defaultAccount }))')
  const target = await waitFor('the owned account fixture main inspector', async () => (await listTargets(nativeInspectorPort)).find(t => t.type === 'node' && t.webSocketDebuggerUrl), 10_000)
  const main = await CdpClient.open(target)
  const created: string[] = []
  const opened: string[] = []
  const poison = { ANTHROPIC_API_KEY: 'owned-old-api-key', ANTHROPIC_AUTH_TOKEN: 'owned-old-gateway-token', ANTHROPIC_BASE_URL: 'https://gateway.example.test', CLAUDE_CODE_OAUTH_TOKEN: 'owned-other-login', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, 'wrong-keychain') }
  const names = Object.keys(poison)
  const oneShots = (): Array<Record<string, unknown>> => readdirSync(agentsDir).filter(name => /^claude-\d+\.jsonl$/.test(name)).flatMap(name => readFileSync(join(agentsDir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
  const accountSettings = async (): Promise<void> => {
    await ev(`document.querySelector('[data-testid="active-account"]').click(), true`)
    await waitFor('the selected account popup', () => ev<boolean>('!!document.querySelector(".account-panel")'))
    await ev(`[...document.querySelectorAll('.account-panel button')].find(button => button.textContent === 'Manage agent accounts').click(), true`)
    await waitFor('Claude account settings', () => ev<boolean>('!!document.querySelector(\'[data-testid="agent-accounts"]\')'))
  }
  try {
    // This is the disposable fixture's main process only. Keep original values
    // inside it, never in the probe's output, and restore them before later tests.
    await main.evaluate(`(() => { const names = ${JSON.stringify(names)}; globalThis.__stokeProbeAccountAuth = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.includes(name.toUpperCase()))); Object.assign(process.env, ${JSON.stringify(poison)}); return true; })()`)
    await ev(`window.stoke.settings.set({ providers: { ...${JSON.stringify(saved.providers)}, claudeAuth: 'anthropic', anthropicApiKey: 'owned-global-api-key' } })`)
    await activate(tabs.claude!.ptyId)
    for (const number of [1, 2]) {
      const made = await ev<{ ok: boolean; account?: { id: string; home: string } }>(`window.stoke.accounts.create({ cli: 'claude', kind: 'login', name: 'Profile ${number}' })`)
      if (!made.ok || !made.account) throw new Error(`owned Profile ${number} could not be created`)
      const account = made.account
      created.push(account.id)
      await accountSettings()
      await waitFor('the named login row', () => ev<boolean>(`!!document.querySelector('.agent-account-stored[data-account="${account.id}"]')`))
      await ev(`document.querySelector('.agent-account-stored[data-account="${account.id}"] input[type="radio"]').click(), true`)
      await waitFor('the named login to be selected', () => ev<boolean>(`window.stoke.settings.get().then(s => s.agents.defaultAccount.claude === ${JSON.stringify(account.id)})`))
      await ev(`[...document.querySelectorAll('.agent-account-stored[data-account="${account.id}"] button')].find(button => ['Sign in', 'Reconnect'].includes(button.textContent.trim())).click(), true`)
      await waitFor('the named login completion to report its own email', () => ev<boolean>(`[...document.querySelectorAll('.toast-title')].some(node => node.textContent === 'Successfully signed in to Claude Code as profile${number}@example.test')`))
      const login = await waitFor('the named sign-in process record', async () => oneShots().find(event => event.kind === 'account-login' && event.home === account.home))
      check(`Profile ${number}: auth login receives its own home and no inherited credential selectors`, Array.isArray(login.authOverrides) && login.authOverrides.length === 0)
      await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), true`)
      const folder = join(root, `claude-profile-${number}-project`)
      mkdirSync(folder, { recursive: true })
      const taken = await ev<string[]>('[...window.stokeTerminals.keys()]')
      await stokeCli('--cli', 'claude', '--new', folder)
      const ptyId = await termShowing('STOKE-PROBE claude ready', `Profile ${number}'s terminal`, 45_000, taken)
      opened.push(ptyId)
      await activate(ptyId)
      const pid = await pidIn(ptyId, 'claude')
      const rec = await waitFor('the selected login launch record', () => stubByPid(pid), 10_000)
      check(`Profile ${number}: the selected login launches in its own credential home`, rec!.start.env.CLAUDE_CONFIG_DIR === account.home)
      check(`Profile ${number}: API, gateway, OAuth and cloud-provider overrides cannot leak into the login`, names.every(name => !Object.keys(rec!.start.env).some(key => key.toUpperCase() === name)))
      await waitFor('the header to identify the running login account', () => ev<boolean>(`document.querySelector('[data-testid="active-account"]')?.getAttribute('data-account') === ${JSON.stringify(account.id)} && document.querySelector('[data-testid="active-account"]')?.textContent.includes('profile${number}@example.test')`))
      check(`Profile ${number}: the active account matches its native signed-in email`, true)
      const identity = await waitFor('the native identity process record', async () => oneShots().find(event => event.kind === 'account-identity' && event.home === account.home))
      check(`Profile ${number}: auth status uses the same isolated credential environment`, Array.isArray(identity.authOverrides) && identity.authOverrides.length === 0)
      await shot(`04-claude-profile-${number}-selected`)
    }
    await activate(opened[0])
    check('choosing Profile 2 for new sessions keeps the existing Profile 1 session on its own account', await ev<boolean>(`document.querySelector('[data-testid="active-account"]')?.getAttribute('data-account') === ${JSON.stringify(created[0])} && document.querySelector('[data-testid="active-account"]')?.textContent.includes('profile1@example.test')`) === true)
    for (const ptyId of opened) {
      await activate(ptyId)
      await ev(`document.querySelector('.tablist .tab[aria-selected="true"] .tab-close').click(), true`)
      await waitFor('the owned login fixture tab to close', () => ev<boolean>(`!window.stokeTerminals.has(${JSON.stringify(ptyId)})`))
    }
  } finally {
    await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), document.querySelector('[data-testid="active-account"][aria-expanded="true"]')?.click(), true`).catch(() => {})
    for (const ptyId of opened) await ev(`window.stoke.pty.kill(${JSON.stringify(ptyId)})`).catch(() => {})
    for (const id of created) await ev(`window.stoke.accounts.remove(${JSON.stringify(id)})`).catch(() => {})
    await ev(`window.stoke.settings.get().then(s => window.stoke.settings.set({ providers: ${JSON.stringify(saved.providers)}, agents: { ...s.agents, defaultAccount: ${JSON.stringify(saved.defaults)} } }))`).catch(() => {})
    await main.evaluate(`(() => { const names = ${JSON.stringify(names)}; for (const name of Object.keys(process.env)) if (names.includes(name.toUpperCase())) delete process.env[name]; Object.assign(process.env, globalThis.__stokeProbeAccountAuth ?? {}); delete globalThis.__stokeProbeAccountAuth; return true; })()`).catch(() => {})
    main.close()
    await activate(tabs.claude!.ptyId)
  }
})

await step('encrypted accounts arrive through native IPC and select the right Codex login', async () => {
  const before = await ev<any>('window.stoke.settings.get()')
  const fixture = await accountSyncFixture(join(root, 'account-sync'))
  const received: string[] = [], opened: string[] = [], grokIds: string[] = []
  try {
    await ev(`window.stoke.hub.setScope({ settings: false, hosts: false, keys: false, accounts: true })`)
    await ev(`window.stoke.hub.setUrl(${JSON.stringify(fixture.url)})`)
    const signed = await ev<{ ok: boolean }>(`window.stoke.hub.signIn(${JSON.stringify({ email: fixture.email, password: fixture.password, label: 'Native recipient' })})`)
    if (!signed.ok) throw new Error('the owned recipient could not sign in')
    const joining = await ev<{ ok: boolean; message?: string }>('window.stoke.hub.joinStart()')
    const recipient = await ev<HubView>('window.stoke.hub.view()')
    if (!recipient.keyStore.protected) {
      check('the native unprotected key store refuses vault access and credential sync', !joining.ok && !!joining.message?.includes('cannot join the vault'))
      check('a refused native vault import leaves all local accounts intact', await ev<boolean>('window.stoke.settings.get().then(s => JSON.stringify(s.accounts) === '+JSON.stringify(JSON.stringify(before.accounts))+')') === true)
      return
    }
    if (!joining.ok) throw new Error(joining.message ?? 'The owned device could not ask to join.')
    await fixture.svc.syncNow()
    const pair = await waitFor('the owned native pairing request', () => fixture.svc.view().pairs[0])
    await fixture.svc.approveStart(pair.pair)
    const joined = await waitFor('pairing codes on both owned devices', () => ev<HubView>('window.stoke.hub.view()').then(v => v.join?.code && fixture.svc.view().pairs.find(p => p.pair === pair.pair)?.code ? v : null))
    check('the native recipient sees the same approval code as the source', joined.join!.code === fixture.svc.view().pairs.find(p => p.pair === pair.pair)?.code)
    await fixture.svc.approveConfirm(pair.pair)
    await waitFor('native device approved', () => ev<HubView>('window.stoke.hub.view()').then(v => v.join?.state === 'approved'))
    await ev('window.stoke.hub.joinConfirm(true)')
    await waitFor('native vault active', () => ev<HubView>('window.stoke.hub.view()').then(v => v.phase === 'active'))
    await activate(tabs.codex!.ptyId)
    await ev(`document.querySelector('[data-testid="active-account"]').click(), true`)
    await waitFor('the native sync navigation', () => ev<boolean>('!!document.querySelector(".account-panel")'))
    await ev(`[...document.querySelectorAll('.account-panel button')].find(b => b.textContent === 'Manage agent accounts').click(), true`)
    await waitFor('Accounts settings navigation', () => ev<boolean>(`!!document.querySelector('[data-node="accounts"]')`))
    await ev(`document.querySelector('[data-node="accounts"]').click(), true`)
    await waitFor('the Stoke sync settings button', () => ev<boolean>('!!document.querySelector(".accounts-stoke button")'))
    await ev('document.querySelector(".accounts-stoke button").click(), true')
    await waitFor('the rendered credential sync switch', () => ev<boolean>(`!!document.querySelector('[data-hub="account-sync"]')`))
    check('the native account sync control starts off', await ev<boolean>(`!document.querySelector('[data-hub="account-sync"]').checked`) === true)
    await ev(`document.querySelector('[data-hub="account-sync"]').scrollIntoView({ block: 'center' }), document.querySelector('[data-hub="account-sync"]').click(), true`)
    await waitFor('account-wide opt-in saved through the rendered switch', () => ev<HubView>('window.stoke.hub.view()').then(v => v.accountSync === true && v.busy === null))
    await fixture.svc.syncNow(); await ev('window.stoke.hub.syncNow()')
    const accounts = await waitFor('both Codex profiles received by the packaged app', () => ev<any>('window.stoke.settings.get().then(s => Object.values(s.accounts).filter(a => !'+JSON.stringify(Object.keys(before.accounts))+'.includes(a.id)))').then(rows => rows.filter(a => a.cli === 'codex' && a.kind === 'login').length === 2 ? rows : null))
    received.push(...accounts.map(a => a.id))
    const work = accounts.find(a => a.label === 'Synced Work')!
    check('native imported profiles use local homes and the file credential store', accounts.every(a => a.home.includes(a.id) && !a.home.includes('source-home') && a.credentialStore === 'file'))
    check('native sync retains the receiving device’s active account', await ev<boolean>('window.stoke.settings.get().then(s => JSON.stringify(s.agents.defaultAccount) === '+JSON.stringify(JSON.stringify(before.agents.defaultAccount))+')') === true)
    await shot('04-account-sync-enabled')
    check('Grok Bot stays disabled after credential imports', await ev<boolean>(`window.stoke.grokBot.read().then(() => false, () => true)`) === true)
    await ev(`window.stoke.plugins.toggle('grok-bot', true)`)
    const grok = await ev<{ accounts: { id: string; label: string }[] }>('window.stoke.grokBot.read()')
    grokIds.push(...grok.accounts.filter(a => a.label.startsWith('Synced Grok ')).map(a => a.id))
    check('five Grok Bot accounts arrive without enabling their plugin', grokIds.length === 5)
    await ev(`window.stoke.plugins.toggle('grok-bot', false)`)
    await ev(`document.querySelector('button[title="Close settings (Esc)"]').click(), true`)
    const identity = await ev<any>(`window.stoke.accounts.identity({cli:'codex',accountId:${JSON.stringify(work.id)}},true)`)
    check('the native identity probe names the imported subscription email', identity.email === 'synced-work@example.test', JSON.stringify(identity))
    await ev(`window.stoke.settings.get().then(s => window.stoke.settings.set({ agents: { ...s.agents, defaultAccount: { ...s.agents.defaultAccount, codex: ${JSON.stringify(work.id)} }, endpoints: { ...s.agents.endpoints, codex: {mode:'custom',baseUrl:'https://wrong-api.example.test/v1',apiKey:'owned-global-key',model:'wrong-api-model'} } } }))`)
    const taken = await ev<string[]>('[...window.stokeTerminals.keys()]'), project = join(root, 'synced-account-project')
    mkdirSync(project, { recursive: true }); await stokeCli('--cli', 'codex', '--new', project)
    const ptyId = await termShowing('STOKE-PROBE codex ready', 'the synced subscription session', 45_000, taken)
    opened.push(ptyId)
    const rec = await waitFor('the synced account launch record', async () => stubByPid(await pidIn(ptyId, 'codex')))
    check('the native launch uses the selected imported home and login store', rec!.start.env.CODEX_HOME === work.home && rec!.start.argv.includes('cli_auth_credentials_store="file"'))
    check('the native subscription launch excludes the global API endpoint', !rec!.start.argv.some(arg => arg.includes('wrong-api') || arg.startsWith('model_provider=')))
    await activate(ptyId)
    await waitFor('the synced account email in the title bar', () => ev<boolean>(`document.querySelector('[data-testid="active-account"]')?.textContent.includes('synced-work@example.test')`))
    await shot('04-account-sync-codex-selected')
  } finally {
    await ev('window.stoke.hub.setAccountSync(false)').catch(() => {})
    await ev('window.stoke.hub.signOut()').catch(() => {})
    await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), true`).catch(() => {})
    for (const id of opened) { await ev(`window.stoke.pty.kill(${JSON.stringify(id)})`).catch(() => {}); await activate(id).catch(() => {}); await ev(`document.querySelector('.tablist .tab[aria-selected="true"] .tab-close')?.click(), true`).catch(() => {}) }
    for (const id of received) await ev(`window.stoke.accounts.remove(${JSON.stringify(id)})`).catch(() => {})
    if (grokIds.length) {
      await ev(`window.stoke.plugins.toggle('grok-bot', true)`).catch(() => {})
      for (const id of grokIds) await ev(`window.stoke.grokBot.change({kind:'remove',id:${JSON.stringify(id)}})`).catch(() => {})
      await ev(`window.stoke.plugins.toggle('grok-bot', false)`).catch(() => {})
    }
    await ev(`window.stoke.settings.set({agents:${JSON.stringify(before.agents)}})`)
    await ev(`window.stoke.hub.setScope(${JSON.stringify(before.hub.sync)})`)
    await ev(`window.stoke.hub.setUrl(${JSON.stringify(before.hub.url)})`).catch(() => {})
    await fixture.stop()
    await activate(tabs.claude!.ptyId)
  }
})

/* -------------------------------------------------------------- browser */

let profileTwo = ''
await step('dragging a live agent into a separate Stoke window keeps the process and returns it on close', async () => {
  const primary = ui!
  const t = tabs.codex!
  const recordsBefore = stubRecords('codex').length
  let popup: CdpClient | null = null
  try {
    await activate(t.ptyId)
    const point = await ev<{ x: number; y: number }>(`(() => { const r = document.querySelector('.tablist .tab[aria-selected="true"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    await primary.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point })
    await primary.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: point.x + 12, y: point.y + 10 })
    await primary.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: point.x + 12, y: point.y + 110 })
    await primary.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: point.x + 12, y: point.y + 110 })
    popup = await waitFor('the detached Stoke renderer', () => connectPage(port, client => client.evaluate('window.stoke?.window.detached === true'), { what: 'the detached Stoke renderer' }), 25_000)
    await popup.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    ui = popup
    await waitFor('the original PTY in the detached terminal', () => ev<boolean>(`window.stokeTerminals?.has(${JSON.stringify(t.ptyId)}) === true`))
    check('a detached Stoke window starts with its sidebar hidden', await ev<boolean>(`!document.querySelector('.sidebar')`) === true)
    check('the original window releases its transferred terminal', await primary.evaluate(`!window.stokeTerminals.has(${JSON.stringify(t.ptyId)})`) === true)
    check('the detached window has the same running agent process', stubRecords('codex').length === recordsBefore && !!stubRecords('codex').find(record => record.pid === t.pid && !record.events.some(event => event.kind === 'exit')))
    // Flush any incidental input in the disposable stub before this exact-line contract.
    await typeLine(t.ptyId, '')
    await typeLine(t.ptyId, 'detached-window-input')
    await waitFor('typing in the moved terminal to reach its original process', async () => (await bufferOf(t.ptyId)).includes('GOT detached-window-input'))
    await shot('04-detached-agent-window')
    const windowKey = async (client: CdpClient, key: 'ArrowLeft' | 'ArrowRight'): Promise<void> => {
      const target = await waitFor('the disposable fixture main inspector', async () => (await listTargets(nativeInspectorPort)).find(t => t.type === 'node' && t.webSocketDebuggerUrl), 10000)
      const main = await CdpClient.open(target)
      try {
        const prevented = await main.evaluate(`(() => {
          const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/probe-input.cjs')('electron');
          const wc = electron.webContents.fromDevToolsTargetId(${JSON.stringify(client.page.id)});
          if (!wc || wc.isDestroyed()) throw new Error('fixture key target is missing');
          let prevented = false;
          wc.emit('before-input-event', { preventDefault() { prevented = true } }, { type: 'keyDown', key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, meta: ${process.platform === 'darwin'}, control: ${process.platform !== 'darwin'}, shift: false, alt: false, isAutoRepeat: false, isComposing: false });
          return prevented;
        })()`)
        if (!prevented) throw new Error('the registered native window shortcut did not consume its chord')
      } finally { main.close() }
    }
    await ev('window.stoke.window.focus(), true')
    await waitFor('detached window native focus', () => ev<boolean>('window.stoke.window.isFocused()'))
    await windowKey(popup, 'ArrowLeft')
    await waitFor('previous Stoke window native focus', () => primary.evaluate('window.stoke.window.isFocused()'))
    check('the previous-window shortcut focuses the primary shell from the terminal', true)
    await windowKey(primary, 'ArrowRight')
    await waitFor('next Stoke window native focus', () => ev<boolean>('window.stoke.window.isFocused()'))
    check('the next-window shortcut wraps to the detached shell', true)
    await primary.evaluate('(window.__stokeDetachedBrowserChanged = false, window.__stokeDetachedBrowserOff = window.stoke.browser.onState(() => { window.__stokeDetachedBrowserChanged = true }), true)')
    await ev('(window.__stokeDetachedBrowserState = null, window.stoke.browser.onState(s => { window.__stokeDetachedBrowserState = s }), true)')
    await ev(`window.stoke.browser.show(${JSON.stringify(`${site.base}/whoami?window=detached`)}), true`)
    await waitFor('the separate window browser to navigate', () => ev<boolean>(`window.__stokeDetachedBrowserState?.url.includes('window=detached') && !window.__stokeDetachedBrowserState.loading`))
    check('a separate window navigates its own browser', await primary.evaluate('window.__stokeDetachedBrowserChanged === false') === true)
    const detachedPage = await connectBrowserPage(port, (url: string) => url.includes('window=detached'))
    try {
      await windowKey(detachedPage, 'ArrowLeft')
      await waitFor('switching from a focused browser page', () => primary.evaluate('window.stoke.window.isFocused()'))
      check('window cycling also intercepts the embedded browser input', true)
    } finally { detachedPage.close() }
    await ev('window.stoke.window.focus(), true')
    await ev('window.stoke.browser.hide(), true')
    // Closing the primary shell with a child open must not shut down shared PTYs.
    await primary.evaluate('window.stoke.window.close(), true')
    await typeLine(t.ptyId, 'primary-window-closed')
    await waitFor('the process to keep working after the primary shell closes', async () => (await bufferOf(t.ptyId)).includes('GOT primary-window-closed'))
    await ev('window.stoke.window.close(), true')
    ui = primary
    await waitFor('the same terminal to return to the primary window', () => ev<boolean>(`window.stokeTerminals.has(${JSON.stringify(t.ptyId)})`))
    check('closing the separate window returns the same PTY without launching another agent', stubRecords('codex').length === recordsBefore)
    await activate(t.ptyId)
  } finally {
    if (popup) { await popup.evaluate('window.stoke.window.close(), true').catch(() => {}); popup.close() }
    ui = primary
    await primary.evaluate('(window.__stokeDetachedBrowserOff?.(), delete window.__stokeDetachedBrowserOff, delete window.__stokeDetachedBrowserChanged, true)').catch(() => {})
  }
})

await step('sidebar project menus edit metadata and close only their own tabs', async () => {
  const folder = join(root, 'menu-project')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'README.md'), 'keep project files')
  await ev(`window.stoke.projects.setMeta(${JSON.stringify(folder)}, { addedManually: true })`)
  await stokeCli('--cli', 'codex', '--new', folder)
  const taken = Object.values(tabs).map(t => t!.ptyId)
  const own = await termShowing('STOKE-PROBE codex ready', 'project menu fixture', 45000, taken)
  const row = `[...document.querySelectorAll('.sidebar .project')].find(e => e.title.startsWith(${JSON.stringify(folder + '\n')}))`
  const openMenu = async (): Promise<void> => {
    await waitFor('the project sidebar row', () => ev<boolean>(`!!(${row})`))
    await ev(`(${row}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 200 })), true`)
    await waitFor('the project menu', () => ev<boolean>(`!!document.querySelector('.context-menu')`))
  }
  const choose = async (label: string): Promise<void> => {
    await ev(`[...document.querySelectorAll('.context-menu [role="menuitem"]')].find(e => e.textContent.trim() === ${JSON.stringify(label)}).click(), true`)
  }
  try {
    await openMenu()
    await shot('04-project-context-menu')
    const labels = await ev<string[]>('[...document.querySelectorAll(\'.context-menu [role="menuitem"]\')].map(e => e.textContent.trim())')
    check('the existing project offers rename, icon, pin, copy and removal', ['Rename / change icon…', 'Pin to top', 'Copy folder path', 'Remove from sidebar', 'Close 1 tab'].every(label => labels.includes(label)), JSON.stringify(labels))
    await choose('Rename / change icon…')
    await waitFor('the project name editor', () => ev<boolean>('!!document.querySelector(".project-meta-pop input")'))
    await ev('document.querySelector(".project-meta-pop input").focus(), true')
    await ui!.send('Input.insertText', { text: 'Menu fixture renamed' })
    await ev('document.querySelector(".project-meta-pop input").blur(), true')
    await waitFor('the renamed display label', () => ev<boolean>(`(${row})?.textContent.includes('Menu fixture renamed')`))
    await openMenu(); await choose('Pin to top')
    await waitFor('the project pin to persist', async () => (await ev<any>('window.stoke.projects.list()')).find((p: any) => p.path === folder)?.pinned === true)
    await openMenu(); await choose('Copy folder path')
    check('copy path retains the real folder after a display rename', await ev<string>('window.stoke.clipboard.readSync().text') === folder)
    await openMenu(); await choose('Close 1 tab')
    await waitFor('only the fixture terminal to close', () => ev<boolean>(`!window.stokeTerminals.has(${JSON.stringify(own)})`))
    check('closing a project leaves all three original agent terminals alive', await ev<boolean>(`${JSON.stringify(taken)}.every(id => window.stokeTerminals.has(id))`) === true)
    await openMenu(); await choose('Remove from sidebar')
    await waitFor('the removed project row to disappear', () => ev<boolean>(`!(${row})`))
    check('removal and rename preserve the project files', readFileSync(join(folder, 'README.md'), 'utf8') === 'keep project files')
    await shot('04-project-context-menu-result')
  } finally {
    await ev(`window.stoke.projects.hide(${JSON.stringify(folder)}, false)`)
    await ev(`window.stoke.projects.pin(${JSON.stringify(folder)}, false)`)
    await ev(`window.stoke.projects.setMeta(${JSON.stringify(folder)}, null)`)
    await activate(tabs.claude!.ptyId)
  }
})

await step('the docked browser logs in, and keeps it to its own profile', async () => {
  await ev('document.querySelector(\'button[title^="Toggle browser"]\').click(), true')
  const page = await waitFor('the docked browser to load the login page', () => connectBrowserPage(port, (u: string) => u.startsWith(`${site.base}/login`)), 45_000, 500)
  check('the panel opened the homepage from settings', true, page.page.url)
  // The target shows up as soon as the URL commits, before the form is parsed:
  // wait for the button, and press it again if the page is still the form.
  await waitFor('the login form\'s button', () => page.evaluate('!!document.querySelector("#go")'), 20_000)
  let presses = 0
  const who = await waitFor('/whoami after the form posts', async () => {
    const where = await page.evaluate('location.pathname').catch(() => '')
    if (where === '/login' && presses < 3) {
      presses++
      await page.evaluate('(document.querySelector("#go")?.click(), true)').catch(() => undefined)
      return null
    }
    const text = await page.evaluate('location.pathname === "/whoami" ? document.body.innerText : ""').catch(() => '')
    return typeof text === 'string' && text.includes('authed') ? text : null
  }, 30_000, 1000)
  check('the form logged the browser in: /whoami says authed', /"authed":\s*true/.test(who), who)
  try {
    await page.screenshot(join(shots, '04-browser-page.png'))
  } catch {
    /* the view may be hidden behind the panel's still; the renderer shot below is enough */
  }
  page.close()
  await shot('04-browser')
  const withTwo = await ev<{ browser: { profiles: Array<{ id: string }> } }>('window.stoke.browser.addProfile()')
  profileTwo = withTwo.browser.profiles.map((p) => p.id).find((p) => p !== 'default') ?? ''
  check('a second browser profile was made', !!profileTwo, JSON.stringify(withTwo.browser.profiles))
  await ev(`window.stoke.browser.useProfile(${JSON.stringify(profileTwo)})`)
  await sleep(500)
  await ev(`(window.stoke.browser.navigate(${JSON.stringify(`${site.base}/whoami?profile=two`)}), true)`)
  const other = await waitFor('the second profile\'s /whoami', async () => {
    const p = await connectBrowserPage(port, (u: string) => u.includes('/whoami?profile=two'))
    try {
      const t = await p.evaluate('document.body ? document.body.innerText : ""')
      return typeof t === 'string' && t.includes('authed') ? t : null
    } finally {
      p.close()
    }
  }, 30_000)
  check('the second profile does NOT carry the first one\'s login (gotcha 107)', /"authed":\s*false/.test(other), other)
  await ev('window.stoke.browser.useProfile("default")')
  await sleep(500)
})

await step('browser links retain popup navigation, POST data and profile isolation', async () => {
  await ev('(window.__stokeLinkProbeOff = window.stoke.browser.onState(state => { window.__stokeLinkProbeState = state }), true)')
  const state = () => ev<BrowserState | null>('window.__stokeLinkProbeState ?? null')
  try {
    for (const profile of ['default', profileTwo].filter(Boolean)) {
      await ev(`window.stoke.browser.useProfile(${JSON.stringify(profile)})`)
      const sourceUrl = `${site.base}/links?owner=${profile}`
      await ev(`(window.stoke.browser.newTab(${JSON.stringify(sourceUrl)}), true)`)
      const sourceTab = await waitFor('the links fixture tab', async () => (await state())?.tabs.find(t => t.url === sourceUrl && !t.loading) ?? null, 20_000)
      const source = await connectBrowserPage(port, (url: string) => url === sourceUrl)
      try {
        for (const kind of profile === 'default' ? ['plain', 'background', 'delayed', 'post', 'multipart'] : ['plain']) {
          await ev(`(window.stoke.browser.selectTab(${JSON.stringify(sourceTab.id)}), true)`)
          const rect = await source.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(`#${kind}`)}).getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2} })()`)
          // Native Chromium click on the fixture, with a user gesture. A
          // modified anchor click covers its guest-less OpenURLFromTab path.
          const modifiers = kind === 'background' ? (process.platform === 'darwin' ? 4 : 2) : 0
          await source.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect, modifiers })
          await source.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect, modifiers })
          const target = `${site.base}/popup-result?case=${kind}`
          const opened = await waitFor(`${profile}/${kind} popup to commit`, async () => (await state())?.tabs.find(t => t.url === target && !t.loading) ?? null, 20_000)
          const child = await connectBrowserPage(port, (url: string) => url === target)
          try {
            const result = await waitFor('the popup response', () => child.evaluate('document.querySelector("#result")?.textContent || null'), 10_000)
            const data = JSON.parse(result)
            check(`${profile}/${kind}: stays in its opener's profile and cookie jar`, opened.profileId === profile && data.authed === (profile === 'default'), JSON.stringify({ profile: opened.profileId, ...data }))
            check(`${profile}/${kind}: has no Stoke bridge or Node access`, await child.evaluate('typeof window.stoke === "undefined" && typeof require === "undefined"'), 'sandboxed web page')
            if (kind === 'background') check('modified link click keeps the source tab selected', (await state())?.activeId === sourceTab.id)
            else check(`${kind}: the popup becomes the selected tab`, (await state())?.activeId === opened.id)
            if (kind === 'post') check('new-tab form keeps the exact POST payload and encoding', data.method === 'POST' && new URLSearchParams(data.body).get('note') === 'Unicode 界 & symbols' && data.contentType.startsWith('application/x-www-form-urlencoded'), JSON.stringify(data))
            if (kind === 'multipart') check('new-tab multipart form keeps its boundary and Unicode body', data.method === 'POST' && data.body.includes('Multipart 界') && data.contentType.startsWith('multipart/form-data; boundary=') && data.body.includes(data.contentType.split('boundary=')[1]), JSON.stringify(data))
            if (kind === 'delayed') {
              check('script-created blank window keeps its opener', await child.evaluate('!!window.opener'))
              await source.evaluate('(window.probePopup.close(), true)')
              await waitFor('self-closing popup to leave the tab strip', async () => !(await state())?.tabs.some(t => t.id === opened.id), 10_000)
              check('window.close removes the popup tab', true)
            }
            check(`${kind}: browser referrer survives`, data.referrer === sourceUrl, String(data.referrer))
          } finally {
            child.close()
            await ev(`(window.stoke.browser.closeTab(${JSON.stringify(opened.id)}), true)`)
          }
        }
      } finally {
        source.close()
        await ev(`(window.stoke.browser.closeTab(${JSON.stringify(sourceTab.id)}), true)`)
      }
    }
  } finally {
    await ev('(window.__stokeLinkProbeOff?.(), delete window.__stokeLinkProbeOff, delete window.__stokeLinkProbeState, true)')
    await ev('window.stoke.browser.useProfile("default")')
  }
})

await step('browser load errors and explicit certificate reviews work in native Chromium', async () => {
  const directory = join(root, 'tls-fixture')
  mkdirSync(directory, { recursive: true })
  const certificate = createCertificate(directory)
  const rotatedCertificate = createCertificate(directory, 'rotated')
  let tls = await startTlsServer(certificate)
  const otherPort = await startTlsServer(certificate)
  await ev('window.stoke.browser.useProfile("default")')
  await ev('(window.__stokeTlsOff = window.stoke.browser.onState(state => { window.__stokeTlsState = state }), true)')
  const state = () => ev<BrowserState | null>('window.__stokeTlsState ?? null')
  // Capture the existing tabs after a normal browser event, before any fixture tabs.
  await ev('(window.stoke.browser.show(), true)')
  const original = await waitFor('the original browser state', state)
  const known = new Set(original.tabs.map(tab => tab.id))
  const owned = new Set<string>()
  const review = async (url: string): Promise<BrowserState> => {
    const before = (await state())?.activeId
    await ev(`(window.stoke.browser.newTab(${JSON.stringify(url)}), true)`)
    const failed = await waitFor('a visible certificate review', async () => {
      const next = await state()
      return next?.activeId !== before && next?.loadError?.url === url && next.loadError.certificate?.canContinue ? next : null
    }, 20_000)
    owned.add(failed.activeId!)
    return failed
  }
  const continueReview = async (failed: BrowserState): Promise<CdpClient> => {
    const point = await waitFor('the visible certificate Continue button', () => ev<{x:number;y:number} | null>(`(() => {
      const b = document.querySelector('.browser-load-error button[data-variant="primary"]');
      if (!b) return null; const r = b.getBoundingClientRect();
      return r.width && r.height && r.right <= innerWidth && r.bottom <= innerHeight ? {x:r.x+r.width/2,y:r.y+r.height/2} : null;
    })()`))
    await ui!.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point})
    await ui!.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point})
    const page = await waitFor('the approved HTTPS document', () => connectBrowserPage(port, (url: string) => url === failed.loadError!.url), 20_000)
    await waitFor('the approved HTTPS body', () => page.evaluate('!!document.querySelector("#tls-ready")'), 10_000)
    return page
  }
  try {
    const first = await review(`${tls.origin}/first`)
    check('untrusted HTTPS exposes a certificate review instead of a blank view', await ev<boolean>('!!document.querySelector(".browser-load-error") && document.querySelector(".browser-load-error").textContent.includes("Continue in this profile")'))
    check('certificate review includes a SHA-256 leaf identity', /^[A-F0-9]{2}(?::[A-F0-9]{2}){31}$/.test(first.loadError!.certificate!.sha256))
    await shot('04-certificate-review')
    check('a stale certificate approval cannot authorize the request', await ev(`window.stoke.browser.continueCertificate(${JSON.stringify(first.activeId)}, "stale")`) === false)
    const accepted = await continueReview(first)
    accepted.close()
    const successful = await waitFor('the certificate exception indicator', async () => {
      const next = await state()
      return next?.certificateException && !next.loadError ? next : null
    })
    check('visible Continue resumes the original HTTPS navigation', successful.url === first.loadError!.url)
    await ev(`(window.stoke.browser.newTab(${JSON.stringify(`${tls.origin}/same-profile`)}), true)`)
    const sameProfile = await waitFor('the shared profile certificate exception', async () => {
      const next = await state()
      return next?.url === `${tls.origin}/same-profile` && !next.loading && next.certificateException && !next.loadError ? next : null
    }, 20_000)
    check('another tab in the same profile shares its reviewed site and certificate', sameProfile.activeId !== first.activeId)
    const anotherPort = await review(`${otherPort.origin}/different-port`)
    check('a certificate grant cannot cross a port boundary', anotherPort.loadError?.certificate?.origin === otherPort.origin)
    await ev(`window.stoke.browser.useProfile(${JSON.stringify(profileTwo)})`)
    const profile = await review(`${tls.origin}/other-profile`)
    check('another browser profile does not inherit the certificate grant', profile.tabs.find(tab => tab.id === profile.activeId)?.profileId === profileTwo)
    await ev(`(window.stoke.browser.closeTab(${JSON.stringify(profile.activeId)}), true)`)
    await ev('window.stoke.browser.useProfile("default")')
    await ev(`(window.stoke.browser.selectTab(${JSON.stringify(first.activeId)}), true)`)
    const removed = await ev<boolean>(`window.stoke.browser.revokeCertificate(${JSON.stringify(first.activeId)}, ${JSON.stringify(first.loadError!.certificate!.sha256)})`)
    const revoked = await waitFor('revoked certificate to need review again', async () => (await state())?.loadError?.certificate?.canContinue ?? false, 20_000)
    check('removing the profile exception restores certificate review', removed && revoked)
    const old = await state()
    const resumed = await continueReview(old!)
    resumed.close()
    await tls.close()
    tls = await startTlsServer(rotatedCertificate, tls.port)
    await ev(`(window.stoke.browser.navigate(${JSON.stringify(`${tls.origin}/rotated`)}), true)`)
    const rotated = await waitFor('a rotated certificate to need fresh review', async () => {
      const next = await state()
      return next?.loadError?.certificate?.canContinue && next.loadError.certificate.sha256 !== first.loadError!.certificate!.sha256 ? next : null
    }, 20_000)
    check('a changed certificate at the same origin needs another review', rotated.loadError?.certificate?.origin === tls.origin)

    // A real popup form to untrusted HTTPS must retain its original POST on Continue.
    const sourceUrl = `${site.base}/links?tls-form=1`
    await ev(`(window.stoke.browser.newTab(${JSON.stringify(sourceUrl)}), true)`)
    await waitFor('the HTTPS form source to finish its navigation', async () => {
      const next = await state()
      return next?.url === sourceUrl && !next.loading && !next.loadError ? true : null
    })
    const source = await waitFor('the HTTPS form source', () => connectBrowserPage(port, (url: string) => url === sourceUrl))
    try {
      await waitFor('the actual loaded links document', () => source.evaluate('document.readyState === "complete" && !!document.querySelector("#plain")'))
      const before = (await state())?.activeId
      await source.evaluate(`(() => { const f = document.createElement('form'); f.method='post'; f.target='_blank'; f.action=${JSON.stringify(`${tls.origin}/posted`)}; const i=document.createElement('input'); i.name='note'; i.value='Reviewed 界'; const b=document.createElement('button'); b.id='tls-post'; b.textContent='Submit HTTPS form'; f.append(i,b); document.body.append(f); return true })()`)
      const point = await waitFor('the ready HTTPS form button', () => source.evaluate('(() => {const b=document.querySelector("#tls-post"); if(!b)return null; b.scrollIntoView({block:"center"}); const r=b.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2; return r.width && r.height && document.elementFromPoint(x,y) === b ? {x,y} : null})()'))
      await source.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point})
      await source.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point})
      const posted = await waitFor('the popup POST certificate review', async () => {
        const next = await state()
        return next?.activeId !== before && next?.loadError?.url === `${tls.origin}/posted` && next.loadError.certificate?.canContinue ? next : null
      }, 20_000).catch(async error => {
        await shot('04-https-form-failure')
        console.log('  HTTPS form state:', JSON.stringify(await state()))
        console.log('  HTTPS form page:', JSON.stringify(await source.evaluate('({url:location.href,ready:document.readyState,button:!!document.querySelector("#tls-post"),viewport:[innerWidth,innerHeight]})')))
        throw error
      })
      owned.add(posted.activeId!)
      const page = await continueReview(posted)
      try {
        const request = await page.evaluate('JSON.parse(document.querySelector("#tls-request").textContent)') as {method:string;body:string}
        check('certificate Continue preserves a popup form POST and Unicode fields', request.method === 'POST' && new URLSearchParams(request.body).get('note') === 'Reviewed 界', JSON.stringify(request))
      } finally { page.close() }
    } finally { source.close() }
    const closedPort = tls.port
    await tls.close()
    await ev(`(window.stoke.browser.newTab(${JSON.stringify(`https://127.0.0.1:${closedPort}/unavailable`)}), true)`)
    const unavailable = await waitFor('a visible refused-connection error', async () => {
      const next = await state()
      return next?.loadError?.code.includes('CONNECTION_REFUSED') ? next : null
    }, 20_000)
    check('a refused connection offers Retry without a certificate bypass', !unavailable.loadError?.certificate && await ev<boolean>('!!document.querySelector(".browser-load-error") && !document.querySelector(".browser-load-error button[data-variant=primary]")'))
    await shot('04-browser-load-error')
  } finally {
    // Collect even a tab created just before a thrown wait, then restore the login tab.
    await ev('window.stoke.browser.useProfile("default")')
    for (const tab of (await state())?.tabs ?? []) if (!known.has(tab.id)) owned.add(tab.id)
    for (const id of owned) await ev(`(window.stoke.browser.closeTab(${JSON.stringify(id)}), true)`)
    if (original.activeId) await ev(`(window.stoke.browser.selectTab(${JSON.stringify(original.activeId)}), true)`)
    await ev('(window.__stokeTlsOff?.(), delete window.__stokeTlsOff, delete window.__stokeTlsState, true)')
    await tls.close()
    await otherPort.close()
    // Only the public certificate remains in artifacts.
    for (const file of readdirSync(directory)) if (file.endsWith('.key')) rmSync(join(directory, file))
  }
})

await step('a click on a hard-wrapped terminal URL opens its complete address', async () => {
  const t = tabs.codex!
  await activate(t.ptyId)
  await typeLine(t.ptyId, '')
  const cols = await ev<number>(`window.stokeTerminals.get(${JSON.stringify(t.ptyId)}).cols`)
  await typeLine(t.ptyId, `hardlink ${site.base}/whoami?terminal=hard&padding= ${cols}`)
  const link = await waitFor('the stub\'s hard link output', () => stubRecords('codex').find(r => r.pid === t.pid)?.events.find(e => e.kind === 'hardlink') ?? null, 10_000)
  const target = String(link.url)
  const point = await waitFor('the hard-wrapped tail in the production terminal', () => ev<{ x: number; y: number; hardBoundary: boolean } | null>(`(() => {
    const t = window.stokeTerminals.get(${JSON.stringify(t.ptyId)}), screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
    return (${terminalLinkPoint.toString()})(t, ${JSON.stringify(target)}, screen);
  })()`), 10_000)
  check('the terminal URL crosses an explicit hard line, not only normal soft wraps', point.hardBoundary === true)
  await ev('(window.__stokeTerminalLinkOff = window.stoke.browser.onState(state => { window.__stokeTerminalLinkState = state }), true)')
  try {
    await ui!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await sleep(150)
    await ui!.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
    await ui!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y })
    const opened = await waitFor('the whole terminal URL to commit in Stoke', () => ev<BrowserState | null>(`window.__stokeTerminalLinkState?.url === ${JSON.stringify(target)} && !window.__stokeTerminalLinkState.loading ? window.__stokeTerminalLinkState : null`), 20_000)
    check('clicking the terminal tail preserves the full URL including its query', opened.url === target, opened.url)
  } finally {
    await ev('(window.__stokeTerminalLinkOff?.(), delete window.__stokeTerminalLinkOff, delete window.__stokeTerminalLinkState, true)')
  }
})

await step('quick terminal switches installed shells, opens wrapped links and retains processes through a pop-out', async () => {
  const fixture = join(root, 'quick-link.mjs')
  const base = `${site.base}/whoami?terminal=quick&padding=`
  writeFileSync(fixture, `const cols = Number(process.argv[2]); const url = ${JSON.stringify(base)} + 'x'.repeat(cols * 2) + '&end=quick-tail'; process.stdout.write('\\r\\n\\x1b[?7l'); for (let at = 0; at < url.length; at += cols) process.stdout.write(url.slice(at, at + cols) + '\\r\\n'); process.stdout.write('\\x1b[?7h');`)
  await ev('window.stoke.settings.set({ quickTerminal: true })')
  let id = ''
  let popup: CdpClient | null = null
  try {
    await activate(tabs.claude!.ptyId)
    await waitFor('the enabled footer Terminal button', () => ev<boolean>(`document.querySelector('[data-testid="footer-terminal"]')?.title === 'Open local quick terminal'`))
    await ev(`document.querySelector('[data-testid="footer-terminal"]').click(), true`)
    const result = await waitFor('the shell opened from the footer', () => ev<QuickTerminalResult | null>('window.stoke.quickTerminal.read().then(snapshot => snapshot.state.mode === "panel" && snapshot.state.phase === "running" ? { ok: true, state: snapshot.state } : null)'))
    if (!result.ok || !result.state.id) throw new Error('the quick shell did not start')
    id = result.state.id
    check('the footer opens a local shell in the current project', result.state.cwd === proj)
    await ev(`document.querySelector('[data-testid="footer-terminal"]').click(), true`)
    await waitFor('the footer hiding the panel', () => ev<boolean>('window.stoke.quickTerminal.read().then(snapshot => snapshot.state.mode === "hidden")'))
    check('hiding from the footer preserves the running shell', (await ev<{ state: QuickTerminalState }>('window.stoke.quickTerminal.read()')).state.id === id)
    await waitFor('the footer reflects the hidden panel', () => ev<boolean>(`document.querySelector('[data-testid="footer-terminal"]')?.getAttribute('aria-pressed') === 'false'`))
    await ev(`document.querySelector('[data-testid="footer-terminal"]').click(), true`)
    await waitFor('the existing shell shown again', () => ev<boolean>(`window.stoke.quickTerminal.read().then(snapshot => snapshot.state.mode === 'panel' && snapshot.state.id === ${JSON.stringify(id)})`))
    const cols = await waitFor('the fitted quick shell', () => ev<number | null>(`(() => {
      const t = window.stokeQuickTerminals.get(${JSON.stringify(id)}), screen = t?.element?.querySelector('.xterm-screen');
      return screen && screen.getBoundingClientRect().width <= t.element.clientWidth + 1 ? t.cols : null;
    })()`))
    check('the quick panel and its controls fit beside the native browser', await ev<boolean>(`(() => {
      const panel = document.querySelector('.quick-terminal-dock'), controls = panel?.querySelectorAll('.quick-terminal-actions button');
      return !!panel && panel.getBoundingClientRect().right <= innerWidth + 1 && [...controls].every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight; });
    })()`) === true)
    const quote = (value: string): string => {
      if (isWin) { if (/["%\r\n]/.test(value)) throw new Error('unsupported cmd fixture path'); return `"${value}"` }
      return shWord(value)
    }
    await ev(`(window.stokeQuickTerminals.get(${JSON.stringify(id)}).focus(), true)`)
    await ui!.send('Input.insertText', { text: `${quote(process.execPath)} ${quote(fixture)} ${cols}` })
    await pressEnter()
    const target = base + 'x'.repeat(cols * 2) + '&end=quick-tail'
    const point = await waitFor('the quick shell\'s complete URL', () => ev<{ x: number; y: number; hardBoundary: boolean } | null>(`(() => {
      const t = window.stokeQuickTerminals.get(${JSON.stringify(id)}), screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      return (${terminalLinkPoint.toString()})(t, ${JSON.stringify(target)}, screen);
    })()`))
    check('the quick-shell fixture crosses a hard row boundary', point.hardBoundary === true)
    await ev('(window.__stokeQuickLinkOff = window.stoke.browser.onState(state => { window.__stokeQuickLinkState = state }), true)')
    await ui!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await sleep(150)
    await ui!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await ui!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    const opened = await waitFor('the quick-shell URL in Stoke', () => ev<BrowserState | null>(`window.__stokeQuickLinkState?.url === ${JSON.stringify(target)} && !window.__stokeQuickLinkState.loading ? window.__stokeQuickLinkState : null`))
    check('a real quick-terminal tail click retains the complete query', opened.url === target)
    await shot('05-quick-terminal-panel')
    const shellChoices = await waitFor('the installed-shell picker', () => ev<{ id: string; label: string }[] | null>(`(() => {
      const select = document.querySelector('[aria-label="Terminal shell"]');
      return select && !select.disabled && select.options.length > 1 ? [...select.options].map(option => ({ id: option.value, label: option.textContent })) : null;
    })()`))
    check('Windows offers PowerShell alongside Command Prompt; Unix offers another installed shell', isWin ? shellChoices.some(shell => shell.id === 'powershell') : shellChoices.length > 1, JSON.stringify(shellChoices))
    const otherShell = shellChoices[1].id
    const pickShell = async (client: CdpClient, bridge: string, shellId: string): Promise<QuickTerminalState> => {
      // CDP key injection does not commit macOS's native select menu. Exercise
      // the rendered form's change event, then read the actual owned PTY.
      await client.evaluate(`(() => { const select = document.querySelector('[aria-label="Terminal shell"]'); if (!select || select.disabled || ![...select.options].some(option => option.value === ${JSON.stringify(shellId)})) throw new Error('the shell picker is unavailable'); select.focus(); select.value = ${JSON.stringify(shellId)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`)
      return waitFor('the shell selected through its picker', () => client.evaluate(`${bridge}.read().then(snapshot => snapshot.state.shellId === ${JSON.stringify(shellId)} && snapshot.state.phase === 'running' && document.querySelector('[aria-label="Terminal shell"]').value === ${JSON.stringify(shellId)} ? snapshot.state : null)`))
    }
    const other = await pickShell(ui!, 'window.stoke.quickTerminal', otherShell)
    check('the panel switches to another process without ending the first', other.id !== id && other.sessions.filter(session => session.phase === 'running').length === 2)
    await waitFor('the second shell buffer to attach', () => ev<boolean>(`!!window.stokeQuickTerminals.get(${JSON.stringify(other.id)})`))
    await ev(`(window.stokeQuickTerminals.get(${JSON.stringify(other.id)}).focus(), true)`)
    await ui!.send('Input.insertText', { text: 'echo STOKE_UI_OTHER_SHELL' })
    await pressEnter()
    const hasMarker = `(() => { const t = window.stokeQuickTerminals.get(${JSON.stringify(other.id)}); if (!t) return false; const b = t.buffer.active; for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString(true).trim() === 'STOKE_UI_OTHER_SHELL') return true; return false; })()`
    await waitFor('real output from the second shell', () => ev<boolean>(hasMarker))
    check('the newly selected shell accepts commands through xterm', true)
    await shot('05-quick-terminal-shell-picker')
    const original = await pickShell(ui!, 'window.stoke.quickTerminal', 'default')
    check('switching back retains the original shell and its wrapped link', original.id === id && (await ev<{ data: string }>('window.stoke.quickTerminal.read()')).data.includes('&end=quick-tail'))
    await ev(`document.querySelector('[aria-label="Terminal options"]').click(), true`)
    // ContextMenu is deliberately hidden for its first frame, then positioned.
    // A native click must wait for that effect and the pop animation to finish.
    await waitFor('visible, settled footer terminal options', () => ev<boolean>(`(() => { const menu = document.querySelector('.context-menu'); return !!menu && getComputedStyle(menu).visibility === 'visible' && getComputedStyle(menu).opacity === '1' && !![...menu.querySelectorAll('.context-menu-item')].find(button => button.textContent === 'Open in separate window'); })()`))
    const menuBounds = await ev<{ top: number; bottom: number; height: number; hit: boolean; visible: string }>(`(() => { const menu = document.querySelector('.context-menu'), r = menu.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight, hit: menu.contains(document.elementFromPoint(r.left + 10, r.top + 10)), visible: getComputedStyle(menu).visibility }; })()`)
    check('footer options are visible above the clipped status bar', menuBounds.top >= 0 && menuBounds.bottom <= menuBounds.height && menuBounds.hit, JSON.stringify(menuBounds))
    await shot('05-quick-terminal-options')
    const popoutButton = await ev<{ x: number; y: number }>(`(() => { const r = [...document.querySelectorAll('.context-menu-item')].find(button => button.textContent === 'Open in separate window').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
    await ui!.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...popoutButton, button: 'left', clickCount: 1 })
    await ui!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...popoutButton, button: 'left', clickCount: 1 })
    const moved = await waitFor('the clicked native pop-out', () => ev<QuickTerminalResult | null>('window.stoke.quickTerminal.read().then(snapshot => snapshot.state.mode === "popout" ? { ok: true, state: snapshot.state } : null)'))
    check('moving into a native pop-out keeps the same shell', moved.ok && moved.state.id === id && moved.state.phase === 'running')
    popup = await waitFor('the native quick-terminal window', async () => {
      for (const target of await listTargets(port)) {
        if (target.type !== 'page' || !target.webSocketDebuggerUrl || !target.url.includes('quick-terminal.html')) continue
        const client = await CdpClient.open(target)
        if (await client.evaluate('!!window.stokeQuickTerminal && !!window.stokeQuickTerminals?.size')) return client
        client.close()
      }
      return null
    })
    check('the pop-out exposes its terminal bridge and no agent or Node bridge', await popup.evaluate('typeof window.stoke === "undefined" && typeof require === "undefined" && typeof process === "undefined" && typeof window.stokeQuickTerminal.openLink === "function"') === true)
    const snapshot = await popup.evaluate(`window.stokeQuickTerminal.read()`)
    const replayed = await waitFor('the URL replayed into the pop-out', () => popup!.evaluate(`(() => {
      const t = window.stokeQuickTerminals.get(${JSON.stringify(id)}), screen = t?.element?.querySelector('.xterm-screen');
      return screen ? (${terminalLinkPoint.toString()})(t, ${JSON.stringify(target)}, screen.getBoundingClientRect()) : null;
    })()`))
    check('the native pop-out replays the existing shell output', snapshot.state.id === id && !!replayed)
    await popup.screenshot(join(shots, '06-quick-terminal-popout.png'))
    await waitFor('the pop-out shell picker', () => popup!.evaluate(`!document.querySelector('[aria-label="Terminal shell"]').disabled`))
    const otherInPopup = await pickShell(popup, 'window.stokeQuickTerminal', otherShell)
    check('the pop-out reuses the second shell instead of launching another', otherInPopup.id === other.id && otherInPopup.sessions.length === 2)
    await waitFor('the retained second-shell output in the pop-out', () => popup!.evaluate(hasMarker))
    await popup.screenshot(join(shots, '06-quick-terminal-shell-picker.png'))
    const originalInPopup = await pickShell(popup, 'window.stokeQuickTerminal', 'default')
    check('switching back in the pop-out still preserves the original process', originalInPopup.id === id)
    const dockButton = await popup.evaluate(`(() => { const r = document.querySelector('.quick-terminal-actions button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
    await popup.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...dockButton, button: 'left', clickCount: 1 })
    await popup.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...dockButton, button: 'left', clickCount: 1 })
    await waitFor('the shell returning to its panel', () => ev(`!!window.stokeQuickTerminals.get(${JSON.stringify(id)})`))
    check('returning to the panel still uses the same process', (await ev<{ state: QuickTerminalState }>('window.stoke.quickTerminal.read()')).state.id === id)
  } finally {
    popup?.close()
    if (id) {
      await ev('window.stoke.quickTerminal.move("panel")').catch(() => {})
      await ev(`(window.stoke.quickTerminal.write(${JSON.stringify(id)}, 'exit\\r'), true)`).catch(() => {})
      const exited = await waitFor('the disposable quick shell to exit', () => ev('window.stoke.quickTerminal.read().then(snapshot => snapshot.state.phase === "exited")'), 10_000).catch(() => false)
      check('the disposable quick shell exits normally after the handoff', exited === true)
    }
    await ev('(window.__stokeQuickLinkOff?.(), delete window.__stokeQuickLinkOff, delete window.__stokeQuickLinkState, true)').catch(() => {})
    await ev('window.stoke.quickTerminal.move("hidden")').catch(() => {})
    await ev('window.stoke.settings.set({ quickTerminal: false })').catch(() => {})
    check('turning off Quick terminal ends inactive shells too', await waitFor('all disposable quick shells to exit', () => ev('window.stoke.quickTerminal.read().then(snapshot => snapshot.state.sessions.every(session => session.phase === "exited"))'), 10_000).catch(() => false) === true)
  }
})

await step('agents read the logged-in page through Stoke\'s browser MCP', async () => {
  for (const id of AGENTS) {
    const t = tabs[id]
    if (!t) {
      check(`${id}: has a tab to ask from`, false)
      continue
    }
    const target = `${site.base}/account?via=${id}`
    await typeLine(t.ptyId, `mcp ${target}`)
    const rec = await waitFor(`${id}'s MCP record`, () => stubRecords(id).find((r) => r.pid === t.pid)?.events.find((e) => e.kind === 'mcp' && e.url === target) ?? null, 90_000).catch(() => null)
    check(`${id}: browser_open and browser_read answered, over ${String(rec?.via ?? 'nothing')}`, rec?.ok === true, JSON.stringify(rec).slice(0, 600))
    check(`${id}: and the page it read is signed in`, String(rec?.read ?? '').includes('Signed in as probe-user'), String(rec?.read ?? '').slice(0, 300))
  }
  await shot('05-mcp')
})

/* ---------------------------------------------------------------- phone */

await step('phone access starts, and holds its security matrix', async () => {
  const state = await ev<{ server: { running: boolean; port: number; error: string | null } }>('window.stoke.remote.start()', 30_000)
  check('the remote server is running', state.server.running, JSON.stringify(state.server))
  const settings = await ev<{ remote: { token: string } }>('window.stoke.settings.get()')
  const token = settings.remote.token
  check('it has a key', typeof token === 'string' && token.length >= 16)
  const run = spawnSync(process.execPath, [join(repo, 'scripts', 'verify-remote-security.mjs'), `http://127.0.0.1:${state.server.port}`, token], {
    encoding: 'utf8',
    timeout: 240_000
  })
  writeFileSync(join(logs, 'verify-remote-security.log'), `${run.stdout ?? ''}\n${run.stderr ?? ''}`)
  const tally = /(\d+) passed, (\d+) failed/.exec(run.stdout ?? '')?.[0] ?? (run.stdout ?? '').trim().split('\n').at(-1) ?? ''
  check('verify-remote-security.mjs passes against the live server', run.status === 0, `${tally}${run.status === 0 ? '' : `\n${(run.stdout ?? '').split('\n').filter((l) => l.includes('FAIL')).join('\n')}\n${run.stderr ?? ''}`}`)
})

/* ------------------------------------------------------------------ ssh */

if (opt.ssh) {
  await step('SSH: a kept (tmux) tab to a real sshd', async () => {
    const before = Object.keys(await buffers())
    await ev('document.querySelector(\'button[title^="New session"]\').click(), true')
    await waitFor('a New tab\'s launcher', () => ev<boolean>('!!document.querySelector(".launcher .switcher-trigger")'), 10_000)
    await ev('document.querySelector(".launcher .switcher-trigger").click(), true')
    const alias = opt['ssh-key-alias']!
    const clicked = await waitFor('the host in the folder switcher', () =>
      ev<boolean>(
        `(() => { const el = [...document.querySelectorAll(".switcher-item")].find((e) => e.textContent.includes(${JSON.stringify(`ssh ${alias}`)})); if (!el) return false; el.click(); return true })()`
      ), 10_000)
    check('the key host is offered in the switcher', clicked === true)
    const ptyId = await waitFor('the SSH tab\'s terminal', async () => Object.keys(await buffers()).find((id) => !before.includes(id)) ?? null, 20_000)
    sshTabs.key = ptyId
    await sleep(3000)
    await typeLine(ptyId, 'echo STOKE-SSH-$((6*7))')
    const echoed = await waitFor('the remote echo', async () => ((await bufferOf(ptyId)).includes('STOKE-SSH-42') ? true : null), 30_000).catch(() => false)
    check('an echo makes the round trip to the remote shell', echoed === true, echoed ? '' : (await bufferOf(ptyId)).slice(-1200))
    check('an SSH tab never shows the local project’s Git branch or account', await ev<boolean>(`!document.querySelector('[data-testid="footer-repository"]') && !document.querySelector('[data-testid="active-account"]')?.hasAttribute('data-account')`) === true)
    await typeLine(ptyId, '[ -n "$TMUX" ] && echo IN-TMUX-$((1+1))')
    const inTmux = await waitFor('the tmux check', async () => ((await bufferOf(ptyId)).includes('IN-TMUX-2') ? true : null), 15_000).catch(() => false)
    check('the shell is inside the tab\'s managed tmux session (gotcha 126)', inTmux === true)
    await typeLine(ptyId, 'export PROBE_MARK=kept-$((3*3))')
    // Enter, then `~.` at the start of a line, then Enter: with ssh's escape
    // character live that hangs up the connection (gotcha 29).
    await typeLine(ptyId, '')
    await typeLine(ptyId, '~.')
    await sleep(1500)
    await typeLine(ptyId, 'echo STILL-$((40+2))')
    const still = await waitFor('the connection after ~.', async () => ((await bufferOf(ptyId)).includes('STILL-42') ? true : null), 15_000).catch(() => false)
    check('`~.` does not hang up — ssh runs with -e none (gotcha 29)', still === true, still ? '' : (await bufferOf(ptyId)).slice(-800))
    await shot('06-ssh-kept')
  })

  await step('SSH: explicit file consent, real-host listings and verified binary downloads', async () => {
    if (!sshTabs.key) throw new Error('No live SSH key tab for the file probe')
    const alias = opt['ssh-key-alias']!
    const fixture = createSshFileFixture(alias)
    try {
      const server = await ev<{ server: { port: number } }>('window.stoke.remote.status()')
      const settings = await ev<{ remote: { token: string } }>('window.stoke.settings.get()')
      const base = `http://127.0.0.1:${server.server.port}`
      const headers = { authorization: `Bearer ${settings.remote.token}` }
      const get = (operation: string, path = '') => fetch(`${base}/api/files/${operation}?${new URLSearchParams({ ptyId: sshTabs.key!, path })}`, { headers, signal: AbortSignal.timeout(30_000) })
      const consent = (folder: string) => ev(`(async () => { const s = await window.stoke.settings.get(); return window.stoke.settings.set({hosts: s.hosts.map(h => h.id === 'probekey' ? {...h, downloadFolder: ${JSON.stringify(folder)}} : h)}) })()`)
      // The last network byte can precede the production router's owned cleanup.
      const listWhenReady = () => waitFor('SSH file cleanup to release its claim', async () => {
        const res = await get('list'); const body = await res.json()
        if (res.status === 409) return null
        if (!res.ok) throw new Error(`SSH listing returned ${res.status}: ${JSON.stringify(body)}`)
        return body
      }, 20_000)
      try {
        const off = await get('list'); await off.arrayBuffer()
        check('real SSH files stay off before explicit folder consent', off.status === 403)
        await consent(fixture.root)
        const listing = await listWhenReady()
        const names = listing.entries.map((entry: { name: string }) => entry.name)
        check('real SSH listing preserves Unicode/metacharacters and excludes links and hidden files', names.includes(fixture.name) && names.includes('empty.bin') && !names.includes('escape.bin') && !names.includes('inside-link.bin') && !names.includes('.hidden'), JSON.stringify(names))
        const response = await get('download', fixture.name)
        const bytes = Buffer.from(await response.arrayBuffer())
        const expected = Buffer.alloc(fixture.size)
        for (let i = 0; i < expected.length; i++) expected[i] = i % 256
        check('real SSH download preserves every binary byte and attachment headers', response.status === 200 && Buffer.compare(bytes, expected) === 0 && response.headers.get('content-disposition')?.includes('attachment') && response.headers.get('content-length') === String(expected.length), `${response.status}, ${bytes.length} bytes`)
        await listWhenReady()
        const empty = await get('download', 'empty.bin')
        const emptyBytes = await empty.arrayBuffer()
        check('real SSH empty download completes with exactly zero bytes', empty.status === 200 && emptyBytes.byteLength === 0)
        for (const path of ['escape.bin', 'inside-link.bin', '../outside.bin']) {
          await listWhenReady()
          const denied = await get('download', path); await denied.arrayBuffer()
          check(`real SSH refuses ${path}`, denied.status === (path.startsWith('..') ? 400 : 403), `${denied.status}`)
        }
        await listWhenReady()
        await consent('')
        const revoked = await get('download', fixture.name); await revoked.arrayBuffer()
        check('revoking consent stops real SSH reads', revoked.status === 403)
      } finally {
        await consent('')
      }
    } finally {
      check('the disposable remote file fixture is removed', removeSshFileFixture(alias, fixture.scope).removed === true)
    }
  })

  await step('SSH: a password-only host offers a key once, and the enrollment works', async () => {
    const pw = process.env.STOKE_PROBE_SSH_PASSWORD
    if (!pw) throw new Error('STOKE_PROBE_SSH_PASSWORD is not set')
    await ev('(window.__probePrompts = [], window.__probeEnroll = [], window.stoke.ssh.onPasswordPrompt((e) => window.__probePrompts.push(e)), window.stoke.ssh.onEnrollEvent((e) => window.__probeEnroll.push(e)), true)')
    const before = Object.keys(await buffers())
    await ev('document.querySelector(\'button[title^="New session"]\').click(), true')
    await waitFor('a New tab\'s launcher', () => ev<boolean>('!!document.querySelector(".launcher .switcher-trigger")'), 10_000)
    await ev('document.querySelector(".launcher .switcher-trigger").click(), true')
    const alias = opt['ssh-pw-alias']!
    await waitFor('the password host in the switcher', () =>
      ev<boolean>(
        `(() => { const el = [...document.querySelectorAll(".switcher-item")].find((e) => e.textContent.includes(${JSON.stringify(`ssh ${alias}`)})); if (!el) return false; el.click(); return true })()`
      ), 10_000)
    const source = await waitFor('the password host\'s terminal', async () => Object.keys(await buffers()).find((id) => !before.includes(id)) ?? null, 20_000)
    await waitFor('ssh\'s password prompt', async () => (/password:\s*$/im.test(await bufferOf(source)) ? true : null), 30_000)
    const offer = await waitFor('the key offer', () => ev<boolean>('!!document.querySelector(".ssh-prompt")'), 20_000).catch(() => false)
    check('the prompt raised the add-a-key offer', offer === true)
    await sleep(2000)
    const prompts = await ev<unknown[]>('window.__probePrompts')
    check('exactly once (gotcha 75: fire-once per connection)', prompts.length === 1, JSON.stringify(prompts))
    check('main says the tab is at the prompt', (await ev<boolean>(`window.stoke.ssh.awaitingPassword(${JSON.stringify(source)})`)) === true)
    await shot('07-ssh-offer')
    const withEnroll = Object.keys(await buffers())
    await ev('document.querySelector(\'.ssh-prompt button[aria-label^="Add a key to"]\').click(), true')
    const enrollPty = await waitFor('the "Add key" tab', async () => Object.keys(await buffers()).find((id) => !withEnroll.includes(id)) ?? null, 30_000)
    await waitFor('ssh-copy-id\'s password prompt in that tab', async () => (/password:\s*$/im.test(await bufferOf(enrollPty)) ? true : null), 60_000)
    // Typed as a person types it, into the tab (gotcha 109). Never logged.
    await typeLine(enrollPty, pw)
    const done = await waitFor('the enrollment to finish', async () => {
      const evs = await ev<Array<{ stage?: string; ok?: boolean; message?: string }>>('window.__probeEnroll')
      return evs.find((e) => e.stage === 'done') ?? null
    }, 120_000).catch(() => null)
    check('the enrollment finished and says it worked', done?.ok !== false && !!done, JSON.stringify(await ev('window.__probeEnroll')).slice(0, 800))
    const hosts = (await ev<{ hosts: Array<{ id: string; keyEnrolled?: boolean }> }>('window.stoke.settings.get()')).hosts
    check('the host is marked keyEnrolled — set only after a BatchMode probe', hosts.find((h) => h.id === 'probepw')?.keyEnrolled === true, JSON.stringify(hosts))
    const batch = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, 'echo', 'KEY-OK'], { encoding: 'utf8', timeout: 30_000 })
    check('and plain `ssh -o BatchMode=yes <alias>` now gets in with no password', batch.status === 0 && batch.stdout.includes('KEY-OK'), `${batch.status} ${batch.stderr}`)
    await shot('08-ssh-enrolled')
  })
}

/* ----------------------------------------------------------------- quit */

/** Quit the way a person does, never a kill: SIGTERM is Electron's own graceful quit on POSIX; on Windows, the window's close. */
async function quitGracefully(label: string): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  const child = stoke
  if (!child || stokeExit) return stokeExit
  if (isWin) {
    // Leave an actual quick shell alive too: earlier link/handoff coverage
    // ends its shell, which cannot prove native cleanup on window close.
    const before = await ev<{ state: QuickTerminalState }>('window.stoke.quickTerminal.read()')
    check(`quick terminal did not auto-start before ${label}`, before.state.phase === 'idle' || before.state.phase === 'exited')
    await ev('window.stoke.settings.set({ quickTerminal: true })')
    const opened = await ev<QuickTerminalResult>(`window.stoke.quickTerminal.open('panel', ${JSON.stringify(proj)})`)
    const quick = opened.ok && opened.state.phase === 'exited'
      ? await ev<QuickTerminalResult>('window.stoke.quickTerminal.restart()') : opened
    check(`a real quick shell is running before ${label}`, quick.ok && quick.state.phase === 'running' && !!quick.state.id)
    await ev('window.stoke.quickTerminal.move("hidden")')
  }
  // Hold an actual owned identity child at quit, including a Windows .cmd
  // launcher tree. EOF and SIGTERM are deliberately ignored by this fixture.
  const previous = readdirSync(agentsDir).filter(name => name.startsWith('identity-owned-'))
  writeFileSync(join(agentsDir, 'identity-hang'), 'owned CI fixture')
  let identityPid = 0
  let identityError = ''
  try {
    let requestedAt = 0
    const request = async () => {
      requestedAt = Date.now()
      await ev(`(window.__stokeQuitIdentityFinished = false, window.__stokeQuitIdentity = window.stoke.accounts.identity({ cli: 'codex', accountId: 'default' }, true).then(value => { window.__stokeQuitIdentityResult = value; window.__stokeQuitIdentityFinished = true }).catch(() => { window.__stokeQuitIdentityFinished = true }), true)`)
    }
    await request()
    const marker = await waitFor('the owned identity child before quit', async () => {
      const marker = readdirSync(agentsDir).find(name => name.startsWith('identity-owned-') && !previous.includes(name))
      if (marker) return marker
      // Discovery has its own Windows PATH probes before the native child's
      // five-second limit starts. A busy two-slot queue can also ask to retry.
      if (Date.now() - requestedAt >= 2_000 && await ev<boolean>('window.__stokeQuitIdentityFinished === true')) await request()
      return null
    }, 30_000)
    identityPid = Number(marker.slice('identity-owned-'.length))
  } catch (error) {
    identityError = error instanceof Error ? error.message : String(error)
    const detail = await ev<string>(`JSON.stringify({ state: window.__stokeQuitIdentityResult?.state, detail: window.__stokeQuitIdentityResult?.detail })`).catch(() => '')
    identityError += ` ${detail}`
  } finally { rmSync(join(agentsDir, 'identity-hang'), { force: true }) }
  check(`an owned account lookup starts before ${label}`, identityPid > 0, identityError)
  // Preparation failure must still go through the real quit. Otherwise the
  // next launch reuses the old app and produces misleading resume failures.
  if (isWin) {
    await ev('(window.stoke.window.close(), true)').catch(() => undefined)
  } else {
    child.kill('SIGTERM')
  }
  ui?.close()
  ui = null
  const exit = await waitFor(`Stoke to exit after ${label}`, () => stokeExit, 60_000, 250).catch(() => null)
  if (identityPid) {
    let identityAlive = true
    try { process.kill(identityPid, 0) } catch { identityAlive = false }
    check(`the owned account lookup is reaped before ${label} completes`, !identityAlive, `owned pid ${identityPid}`)
  }
  if (isWin) {
    const log = readFileSync(join(logs, `stoke-${launchNo}.log`), 'utf8')
    check(`all owned PTY exit callbacks drain before ${label}`, log.includes('[stoke] PTY quit drain: 0 pending') && !/PTY quit drain: [1-9]\d* pending/.test(log))
  }
  return exit
}

await step('a graceful quit reaches every session and seals the cookie', async () => {
  const markersBefore = exitMarkers().length
  const releasedBefore = existsSync(join(tmp, 'stoke', 'statusline', `${claudeSession}.settings.json`))
  check('(the session\'s --settings file exists before the quit)', releasedBefore)
  const exit = await quitGracefully('the quit')
  check('Stoke exited on its own, status 0, no signal', !!exit && exit.code === 0 && exit.signal === null, JSON.stringify(exit))
  check(
    'before-quit ran killAll: the Claude session\'s statusLine files were released (gotcha 73)',
    !existsSync(join(tmp, 'stoke', 'statusline', `${claudeSession}.settings.json`))
  )
  const markers = await waitFor('every agent\'s exit marker', () => {
    const m = exitMarkers()
    return AGENTS.every((id) => m.some((n) => n.startsWith(`exit-${id}-${tabs[id]?.pid}`))) ? m : null
  }, 15_000).catch(() => exitMarkers())
  const reached = AGENTS.filter((id) => markers.some((n) => n === `exit-${id}-${tabs[id]?.pid}`))
  const detail = `${markers.length - markersBefore} new marker(s): ${markers.join(', ')}`
  // On Windows it is conpty's close that reaches node as SIGHUP; measured on
  // windows-latest and windows-11-arm, every stub wrote its marker.
  check('every agent process was told (its SIGHUP/SIGTERM exit marker)', reached.length === AGENTS.length, detail)
  const saved = existsSync(join(ud, 'tabs.json')) ? (JSON.parse(readFileSync(join(ud, 'tabs.json'), 'utf8')) as { tabs: Array<{ cliId: string; sessionId: string; kind: string }> }) : null
  const kinds = (saved?.tabs ?? []).filter((t) => t.kind === 'session').map((t) => t.cliId).sort()
  check('the tabs were saved for restore', AGENTS.every((a) => kinds.includes(a)), JSON.stringify(saved?.tabs ?? null).slice(0, 600))
  check('the Claude tab under its own session id', (saved?.tabs ?? []).some((t) => t.cliId === 'claude' && t.sessionId === claudeSession))
  // The jar, read from a COPY with node:sqlite: a quit flushes it.
  const cookieDb = findCookieDb(join(ud, 'Partitions', 'stoke-browser'))
  check('the Default profile\'s cookie store is on disk', !!cookieDb, cookieDb ?? `nothing under ${join(ud, 'Partitions')}`)
  if (cookieDb) {
    const row = readCookie(cookieDb, 'sid')
    check('it holds the login cookie', !!row, JSON.stringify(row))
    check('ENCRYPTED: an empty value and a non-empty encrypted_value (gotcha 108)', !!row && row.value === '' && row.encLen > 0, JSON.stringify(row))
  }
  const twoDb = profileTwo ? findCookieDb(join(ud, 'Partitions', `stoke-browser-${profileTwo}`)) : null
  check('the second profile\'s store has no such cookie', !twoDb || !readCookie(twoDb, 'sid'), twoDb ?? '(no store written)')
})

function findCookieDb(dir: string): string | null {
  if (!existsSync(dir)) return null
  for (const rel of ['Network/Cookies', 'Cookies']) if (existsSync(join(dir, rel))) return join(dir, rel)
  return null
}

function readCookie(file: string, name: string): { value: string; encLen: number; httpOnly: number } | null {
  const copy = join(logs, `cookies-${Date.now()}.sqlite`)
  copyFileSync(file, copy)
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(copy, { readOnly: true })
  try {
    const row = db.prepare('SELECT value, length(encrypted_value) AS encLen, is_httponly AS httpOnly FROM cookies WHERE name = ?').get(name) as
      | { value: string; encLen: number; httpOnly: number }
      | undefined
    return row ? { value: row.value, encLen: Number(row.encLen), httpOnly: Number(row.httpOnly) } : null
  } finally {
    db.close()
    // The copy is not an artifact: it holds the jar.
    rmSync(copy, { force: true })
  }
}

/* -------------------------------------------------------------- relaunch */

await step('relaunch: the tabs come back, and resume what they were', async () => {
  const seenPids = new Set(stubRecords().map((r) => r.pid))
  launch()
  await attach()
  await waitFor('the shell to mount again', () => ev<boolean>('!!document.querySelector(".app > .titlebar")'), 30_000)
  const paused = await waitFor('the restored tabs', async () => {
    const n = await ev<number>('document.querySelectorAll(".paused-card").length')
    return n >= 3 ? n : null
  }, 30_000).catch(() => 0)
  check('the three agent tabs came back paused', paused >= 3, `${paused} paused`)
  await shot('09-restored')
  // Every paused LOCAL tab, by its own Resume. An SSH tab is left for the SSH
  // step, which reattaches it on purpose: its card names the host, or — a kept
  // one — "the machine", under a Reattach button.
  const count = await ev<number>('document.querySelectorAll(".tablist .tab").length')
  for (let i = 0; i < count; i++) {
    await ev(`document.querySelectorAll(".tablist .tab")[${i}]?.click(), true`)
    await sleep(300)
    await ev(
      [
        '(() => {',
        '  const pane = document.querySelector(".term-pane:not([hidden])")',
        '  const note = pane?.querySelector(".paused-note")?.textContent ?? ""',
        '  const b = pane?.querySelector(".paused-actions .btn[data-variant=primary]")',
        '  if (!b || /host|machine/i.test(note) || /Reattach/.test(b.textContent)) return false',
        '  b.click()',
        '  return true',
        '})()'
      ].join('\n')
    )
    await sleep(700)
  }
  const fresh = await waitFor('the resumed agents to start', () => {
    const now = stubRecords().filter((r) => !seenPids.has(r.pid))
    return AGENTS.every((a) => now.some((r) => r.id === a)) ? now : null
  }, 60_000).catch(() => stubRecords().filter((r) => !seenPids.has(r.pid)))
  // The main tab's, if two Claude tabs came back (the --continue tab is closed
  // in its own step; if that failed, it is not this check's failure).
  const claudeAgain = fresh.find((r) => r.id === 'claude' && argAfter(r.start.argv, '--resume') === claudeSession) ?? fresh.find((r) => r.id === 'claude')
  check('Claude came back with --resume <the same session id> (gotcha 81)', argAfter(claudeAgain?.start.argv ?? [], '--resume') === claudeSession, JSON.stringify(claudeAgain?.start.argv ?? null))
  check('and no --session-id beside it (the CLI refuses the pair)', !(claudeAgain?.start.argv ?? []).includes('--session-id'))
  const codexAgain = fresh.find((r) => r.id === 'codex')
  check('Codex resumes its confirmed native conversation instead of account-wide latest', !!codexNativeId && (codexAgain?.start.argv ?? []).includes(codexNativeId) && (codexAgain?.start.argv ?? []).includes('resume') && !(codexAgain?.start.argv ?? []).includes('--last'), JSON.stringify(codexAgain?.start.argv ?? null))
  const opencodeAgain = fresh.find((r) => r.id === 'opencode')
  check('OpenCode came back with --continue', (opencodeAgain?.start.argv ?? []).includes('--continue'), JSON.stringify(opencodeAgain?.start.argv ?? null))
  if (claudeAgain) {
    const ptyId = await termShowing(`STOKE-PROBE claude resumed ${claudeSession}`, 'the resumed Claude tab', 20_000)
    tabs.claude = { ptyId, pid: claudeAgain.pid }
  }
  if (codexAgain) {
    const ptyId = await termShowing(`STOKE-PROBE codex ready pid=${codexAgain.pid}`, 'the resumed Codex tab', 20_000)
    tabs.codex = { ptyId, pid: codexAgain.pid }
  }
  await shot('10-resumed')
})

await step('relaunch: the browser is still logged in', async () => {
  const t = tabs.codex
  if (!t) throw new Error('no resumed Codex tab to ask through')
  const target = `${site.base}/account?via=codex-after-relaunch`
  await typeLine(t.ptyId, `mcp ${target}`)
  const rec = await waitFor('the MCP read after relaunch', () => stubRecords('codex').find((r) => r.pid === t.pid)?.events.find((e) => e.kind === 'mcp' && e.url === target) ?? null, 90_000).catch(() => null)
  check('the login survived the quit: the page reads signed in', String(rec?.read ?? '').includes('Signed in as probe-user'), JSON.stringify(rec).slice(0, 600))
})

if (opt.ssh) {
  await step('relaunch: the kept SSH tab reattaches to the SAME shell', async () => {
    const count = await ev<number>('document.querySelectorAll(".tablist .tab").length')
    const before = Object.keys(await buffers())
    let started: string | null = null
    for (let i = 0; i < count && !started; i++) {
      await ev(`document.querySelectorAll(".tablist .tab")[${i}]?.click(), true`)
      await sleep(300)
      const pressed = await ev<boolean>(
        '(() => { const b = [...document.querySelectorAll(".term-pane:not([hidden]) .paused-actions .btn[data-variant=primary]")].find((x) => x.textContent.includes("Reattach")); if (b) b.click(); return !!b })()'
      )
      if (pressed) started = await waitFor('the reattached terminal', async () => Object.keys(await buffers()).find((id) => !before.includes(id)) ?? null, 30_000)
    }
    if (!started) throw new Error('no restored tab offered Reattach')
    await sleep(3000)
    await typeLine(started, 'echo MARK=$PROBE_MARK')
    const kept = await waitFor('the kept variable', async () => ((await bufferOf(started!)).includes('MARK=kept-9') ? true : null), 30_000).catch(() => false)
    check('the variable set before the quit is still there — the shell lived on the host', kept === true, kept ? '' : (await bufferOf(started)).slice(-1200))
    await shot('11-ssh-reattached')
  })
}

await step('the second quit is graceful too', async () => {
  const exit = await quitGracefully('the second quit')
  check('Stoke exited on its own, status 0', !!exit && exit.code === 0 && exit.signal === null, JSON.stringify(exit))
})

/* --------------------------------------------------------------- report */

await login.close()
if (stoke && !stokeExit) {
  // Never a SIGKILL of Stoke (it would orphan its children, CLAUDE.md). A
  // second SIGTERM, and then the runner's own teardown, is all that is left.
  console.log('  Stoke is still running after the probe; sending one more SIGTERM')
  if (!isWin) stoke.kill('SIGTERM')
  stoke.unref()
}
ui?.close()

const failed = results.filter((r) => !r.ok)
writeFileSync(join(root, 'probe-summary.json'), JSON.stringify({ platform: process.platform, arch: process.arch, version: pkg.version, results }, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [`### Probe — ${process.platform}-${process.arch}${opt.dev ? ' (unpackaged)' : ''}`, '', `${results.length - failed.length} passed, ${failed.length} failed`, '']
  for (const r of results) lines.push(`- ${r.ok ? '✅' : '❌'} ${r.name}`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
for (const r of failed) console.log(`  FAIL  ${r.name}`)
process.exitCode = failed.length ? 1 : 0
// A failed first quit can leave an older owned app's stdio referenced after
// `launch` replaced stoke with the second instance. Finish the CI probe after
// its report and stdout flush; runner teardown owns the disposable processes.
// This exits only the probe, never force-kills Stoke or its agent children.
if (failed.length && process.env.GITHUB_ACTIONS === 'true') process.stdout.write('', () => process.exit(1))
