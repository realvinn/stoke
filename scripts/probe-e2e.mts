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

import { CdpClient, connectBrowserPage, connectStoke, listTargets } from './cdp-lib.mjs'
import { startLoginServer } from './probe/login-server.mjs'
import { createCertificate, startTlsServer } from './probe/tls-server.mjs'
import { createSshFileFixture, removeSshFileFixture } from './probe/ssh-files.mjs'
import { terminalLinkPoint } from './probe/terminal-link.mjs'
import { nativeCrashScript } from './probe/native-crash.mjs'
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

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }
const port = Number(opt.port)
// Only the disposable Windows CI fixture gets a main-process debugger. It
// enables local crash reports, then disconnects before any quit is tested.
const nativeInspectorPort = isWin && process.env.GITHUB_ACTIONS === 'true' ? await new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const address = server.address(); const assigned = typeof address === 'object' && address ? address.port : 0; server.close(error => error ? reject(error) : resolve(assigned)) })
}) : 0
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
  if (nativeInspectorPort) {
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
    await shot('04-account-settings')
  } finally {
    await ui!.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    await ev(`document.querySelector('button[title="Close settings (Esc)"]')?.click(), document.querySelector('[data-testid="active-account"][aria-expanded="true"]')?.click(), true`).catch(() => {})
    if (created) await ev(`window.stoke.accounts.remove(${JSON.stringify(created)})`).catch(() => {})
  }
})

/* -------------------------------------------------------------- browser */

let profileTwo = ''
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

await step('quick terminal opens wrapped links and retains its shell through a pop-out', async () => {
  const fixture = join(root, 'quick-link.mjs')
  const base = `${site.base}/whoami?terminal=quick&padding=`
  writeFileSync(fixture, `const cols = Number(process.argv[2]); const url = ${JSON.stringify(base)} + 'x'.repeat(cols * 2) + '&end=quick-tail'; process.stdout.write('\\r\\n\\x1b[?7l'); for (let at = 0; at < url.length; at += cols) process.stdout.write(url.slice(at, at + cols) + '\\r\\n'); process.stdout.write('\\x1b[?7h');`)
  await ev('window.stoke.settings.set({ quickTerminal: true })')
  let id = ''
  let popup: CdpClient | null = null
  try {
    const result = await ev<QuickTerminalResult>(`window.stoke.quickTerminal.open('panel', ${JSON.stringify(proj)})`)
    if (!result.ok || !result.state.id) throw new Error('the quick shell did not start')
    id = result.state.id
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
    const popoutButton = await ev<{ x: number; y: number }>(`(() => { const r = document.querySelector('.quick-terminal-actions button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
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
  try {
    await ev(`(window.__stokeQuitIdentity = window.stoke.accounts.identity({ cli: 'codex', accountId: 'default' }, true), true)`)
    const marker = await waitFor('the owned identity child before quit', () => readdirSync(agentsDir).find(name => name.startsWith('identity-owned-') && !previous.includes(name)), 10_000)
    identityPid = Number(marker.slice('identity-owned-'.length))
  } finally { rmSync(join(agentsDir, 'identity-hang'), { force: true }) }
  if (isWin) {
    await ev('(window.stoke.window.close(), true)').catch(() => undefined)
  } else {
    child.kill('SIGTERM')
  }
  ui?.close()
  ui = null
  const exit = await waitFor(`Stoke to exit after ${label}`, () => stokeExit, 60_000, 250).catch(() => null)
  let identityAlive = true
  try { process.kill(identityPid, 0) } catch { identityAlive = false }
  check(`the owned account lookup is reaped before ${label} completes`, identityPid > 0 && !identityAlive, `owned pid ${identityPid}`)
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
  check('Codex came back with its own continue flag (resume --last)', (codexAgain?.start.argv ?? []).join(' ').includes('resume --last'), JSON.stringify(codexAgain?.start.argv ?? null))
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
