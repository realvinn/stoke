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
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { CdpClient, connectBrowserPage, connectStoke, listTargets } from './cdp-lib.mjs'
import { startLoginServer } from './probe/login-server.mjs'

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
const agentsDir = join(root, 'agents')
const shots = join(root, 'shots')
const logs = join(root, 'logs')
const stubBin = join(home, '.local', 'bin')
for (const d of [home, tmp, ud, proj, agentsDir, shots, logs, stubBin]) mkdirSync(d, { recursive: true })
writeFileSync(join(proj, 'README.md'), '# Probe project\n\nA folder the CI probe opens sessions in.\n')

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }
const port = Number(opt.port)
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
  writeFileSync(noRcShell, '#!/bin/sh\nshift\nexec /bin/sh -c "$1"\n', { mode: 0o755 })
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
  const args = [...exePrefix, `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', ...platformFlags]
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
  // child is cmd.exe running the .cmd launcher, so only the fallback can match:
  // the one entry in the folder whose process descends from the pty (gotcha 92),
  // which no run had ever exercised on Windows.
  let states: Array<{ ptyId?: string; status?: string }> = []
  const mine = await waitFor('the registry entry to be matched to the tab', async () => {
    states = await ev<Array<{ ptyId?: string; status?: string }>>('window.stoke.session.states()')
    return states.find((s) => s.ptyId === t.ptyId) ?? null
  }, 20_000).catch(() => null)
  check(
    `the CLI registry entry was matched to the tab ${isWin ? 'through a .cmd launcher, by descent (gotcha 92)' : 'by pid (gotcha 80)'}`,
    !!mine,
    JSON.stringify(states).slice(0, 400)
  )
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
    await ev('(window.stoke.window.close(), true)').catch(() => undefined)
  } else {
    child.kill('SIGTERM')
  }
  ui?.close()
  ui = null
  const exit = await waitFor(`Stoke to exit after ${label}`, () => stokeExit, 60_000, 250).catch(() => null)
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
  const claudeAgain = fresh.find((r) => r.id === 'claude')
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
