/*
 * One stand-in for every coding agent, for the CI probe (scripts/probe-e2e.mts).
 *
 * Paid CLIs cannot sign in on a CI runner, and the probe must never start a
 * real one anyway (gotcha 112: a stub is only a stub if nothing real is found
 * first). So each agent id the probe uses gets a tiny launcher —
 * `<home>/.local/bin/<bin>` (sh) or `<bin>.cmd` (Windows, which spawnSpec runs
 * through `cmd.exe /c`, gotcha 13) — that runs this file as that id:
 *
 *   node scripts/probe/fake-agent.mjs <id> [the agent's own argv...]
 *   STOKE_PROBE_DIR=<dir>   where every record goes (set by the launcher)
 *
 * What it does is the part of each agent's contract Stoke depends on, and
 * nothing else — so a green probe says Stoke's side held, never that the real
 * CLI still behaves this way (that is what the verify suites' measured
 * fixtures and a real session are for):
 *
 *   every id  records its argv, cwd and a redacted slice of its environment;
 *             prints `STOKE-PROBE <id> ready`; echoes each typed line as
 *             `GOT <line>`; on `mcp <url>` calls Stoke's browser MCP server
 *             (browser_open, then browser_read) with whatever endpoint and
 *             bearer its launch handed it, and prints what came back; on
 *             SIGHUP/SIGTERM/SIGINT or end of input writes an exit marker, so
 *             the probe can prove a quit reached it (before-quit's killAll)
 *             rather than orphaning it.
 *   claude    as Claude Code 2.1.x: `--session-id`/`--resume` pick the
 *             session, and `--continue` the newest transcript in its folder
 *             (a fresh id when there is none — where the real CLI would say
 *             there is nothing to continue), so Stoke launches it holding NO
 *             id and must learn it from the registry (gotchas 26, 92); a
 *             transcript is written under the config dir's
 *             projects/, a registry entry under sessions/<pid>.json; the
 *             `--settings` file's statusLine command is run with a payload on
 *             stdin, and its UserPromptSubmit/Stop hooks on every prompt — each
 *             through the shell the CLI itself would use: /bin/sh -c, or on
 *             Windows Git Bash when found, else PowerShell (gotchas 61, 123).
 *   codex     reads `-c mcp_servers.stoke.url=…` and the bearer's variable name.
 *   opencode  reads OPENCODE_CONFIG_CONTENT's `mcp.stoke`.
 *
 * Records are JSON lines in `<dir>/<id>-<pid>.jsonl`; the exit marker is
 * `<dir>/exit-<id>-<pid>`. Secrets are never written: the MCP bearer and any
 * long hex run are replaced by their length (these logs are uploaded as CI
 * artifacts of a public repository).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'

const id = process.argv[2] || 'unknown'
const argv = process.argv.slice(3)
const dir = process.env.STOKE_PROBE_DIR || join(process.cwd(), '.stoke-probe')
mkdirSync(dir, { recursive: true })
const logFile = join(dir, `${id}-${process.pid}.jsonl`)
const isWin = process.platform === 'win32'

/** Anything that looks like a bearer or a key, replaced by its length. */
function redact(s) {
  return String(s)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, (m) => `Bearer <${m.length - 7} chars>`)
    .replace(/\b[0-9a-f]{32,}\b/gi, (m) => `<hex:${m.length}>`)
}

function record(kind, data = {}) {
  try {
    appendFileSync(logFile, JSON.stringify({ t: Date.now(), kind, ...data }, (_k, v) => (typeof v === 'string' ? redact(v) : v)) + '\n')
  } catch {
    /* a probe record is never worth crashing the agent over */
  }
}

const say = (line) => process.stdout.write(line + '\r\n')

/* ------------------------------------------------------------- one-shots */

// What Stoke asks a binary outside a session: `--version` (probeClaude, and
// the identity check for agents that have one), a headless `-p` (the worklog
// runner), `update`/`doctor`. Answered and exited, never a session.
if (argv[0] === '--version' || argv[0] === '-v') {
  record('version')
  process.stdout.write(id === 'claude' ? '2.1.999 (Claude Code)\n' : `${id} 0.0.0-stoke-probe\n`)
  process.exit(0)
}
if (argv.includes('-p') || argv.includes('--print')) {
  record('print', { argv })
  process.stdout.write(JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, result: 'stoke probe' }]) + '\n')
  process.exit(0)
}
if (['update', 'doctor', 'install', 'login', 'logout', 'mcp', 'config'].includes(argv[0] ?? '')) {
  record('subcommand', { argv })
  process.stdout.write(`${id} (stoke probe): nothing to do for ${argv[0]}\n`)
  process.exit(0)
}

/* ------------------------------------------------------------ the record */

const ENV_KEYS = /^(STOKE_|OPENCODE_CONFIG_CONTENT$|KILO_CONFIG_CONTENT$|CLAUDE_CONFIG_DIR$|HOME$|USERPROFILE$|TERM$|TERM_PROGRAM$|COLORTERM$|COLORFGBG$|ANTHROPIC_|CODEX_HOME$|SHELL$)/
const env = {}
for (const [k, v] of Object.entries(process.env)) if (ENV_KEYS.test(k)) env[k] = k === 'STOKE_MCP_TOKEN' ? `<set, ${String(v).length} chars>` : v
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env.PATH_HEAD = String(process.env[pathKey] ?? '').split(delimiter).slice(0, 4)
record('start', { id, pid: process.pid, argv, cwd: process.cwd(), env, platform: process.platform })

/** The value after `flag`, or null. */
function flagValue(flag) {
  const at = argv.indexOf(flag)
  return at !== -1 && at + 1 < argv.length ? argv[at + 1] : null
}

/** Every value after `flag` up to the next `--option`. */
function flagValues(flag) {
  const at = argv.indexOf(flag)
  if (at === -1) return []
  const out = []
  for (let i = at + 1; i < argv.length && !argv[i].startsWith('--'); i++) out.push(argv[i])
  return out
}

/** A TOML/JSON string as codex receives it: quoted, or bare once cmd.exe ate the quotes. */
function unquote(v) {
  const s = String(v ?? '').trim()
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.replace(/^"|"$/g, '')
    }
  }
  return s
}

/* ----------------------------------------------------- the MCP endpoint */

/** Where this launch was told Stoke's browser MCP server is, and its bearer. */
function mcpEndpoint() {
  if (id === 'claude') {
    for (const file of flagValues('--mcp-config')) {
      try {
        const cfg = JSON.parse(readFileSync(file, 'utf8'))
        const s = cfg?.mcpServers?.stoke
        if (s?.url) return { url: s.url, headers: s.headers ?? {}, via: `--mcp-config ${file}` }
      } catch (e) {
        record('mcp-config-unreadable', { file, error: String(e) })
      }
    }
    return null
  }
  if (id === 'codex') {
    const sets = {}
    argv.forEach((a, i) => {
      if (a !== '-c' || i + 1 >= argv.length) return
      const kv = argv[i + 1]
      const eq = kv.indexOf('=')
      if (eq > 0) sets[kv.slice(0, eq)] = unquote(kv.slice(eq + 1))
    })
    const url = sets['mcp_servers.stoke.url']
    if (!url) return null
    const varName = sets['mcp_servers.stoke.bearer_token_env_var']
    const token = varName ? process.env[varName] : undefined
    return { url, headers: token ? { Authorization: `Bearer ${token}` } : {}, via: `-c mcp_servers.stoke.* (bearer from ${varName ?? 'nothing'})` }
  }
  const raw = process.env[id === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT']
  if (raw) {
    try {
      const s = JSON.parse(raw)?.mcp?.stoke
      if (s?.url) return { url: s.url, headers: s.headers ?? {}, via: 'OPENCODE_CONFIG_CONTENT' }
    } catch (e) {
      record('mcp-env-unreadable', { error: String(e) })
    }
  }
  return null
}

/** One JSON-RPC call over streamable HTTP; the reply may come as JSON or as one SSE message. */
async function rpc(ep, body) {
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...ep.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  if (body.id === undefined) return null
  const json = text.trimStart().startsWith('{')
    ? text
    : text
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .find((l) => l.startsWith('{')) ?? '{}'
  const msg = JSON.parse(json)
  if (msg.error) throw new Error(`${msg.error.code}: ${msg.error.message}`)
  return msg.result
}

async function mcpVisit(target) {
  const ep = mcpEndpoint()
  if (!ep) {
    record('mcp', { ok: false, error: 'no MCP endpoint in this launch' })
    say('MCP-FAIL no endpoint in this launch')
    return
  }
  try {
    await rpc(ep, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `stoke-probe-${id}`, version: '1' } } })
    await rpc(ep, { jsonrpc: '2.0', method: 'notifications/initialized' })
    const opened = await rpc(ep, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_open', arguments: { url: target } } })
    const read = await rpc(ep, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_read', arguments: {} } })
    const textOf = (r) => (r?.content ?? []).map((c) => c.text ?? '').join('\n')
    record('mcp', { ok: true, via: ep.via, url: target, open: textOf(opened), read: textOf(read), readIsError: !!read?.isError })
    say(`MCP-OPEN ${textOf(opened).split('\n')[0]}`)
    say(`MCP-READ ${textOf(read).split('\n').find((l) => l.startsWith('# ')) ?? '(no heading)'}`)
  } catch (e) {
    record('mcp', { ok: false, via: ep.via, url: target, error: String(e?.message ?? e) })
    say(`MCP-FAIL ${String(e?.message ?? e)}`)
  }
}

/* ------------------------------------------------ Claude Code's contract */

const claude = id === 'claude'
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const slug = process.cwd().replace(/[^A-Za-z0-9]/g, '-')
const resumeId = claude ? flagValue('--resume') : null
const continueLast = claude && argv.includes('--continue')

/** The newest conversation in this folder, as `--continue` picks it, or null. */
function newestInFolder() {
  const at = join(configDir, 'projects', slug)
  try {
    const newest = readdirSync(at)
      .filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n))
      .map((n) => ({ id: n.slice(0, -'.jsonl'.length), at: statSync(join(at, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]
    return newest ? newest.id : null
  } catch {
    return null
  }
}

const sessionId = claude
  ? (flagValue('--session-id') ?? resumeId ?? (continueLast ? newestInFolder() : null) ?? randomUUID())
  : null
const sessionHow = !claude ? null : resumeId ? 'resumed' : continueLast ? 'continued' : 'session'
if (claude) record('claude-session', { sessionId, how: sessionHow })
const transcript = sessionId ? join(configDir, 'projects', slug, `${sessionId}.jsonl`) : null
const registryFile = claude ? join(configDir, 'sessions', `${process.pid}.json`) : null
const settings = (() => {
  const file = claude ? flagValue('--settings') : null
  if (!file) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    record('settings-unreadable', { file, error: String(e) })
    return null
  }
})()
let turns = 0
let lastUuid = null

function writeRegistry(status) {
  if (!registryFile) return
  try {
    mkdirSync(dirname(registryFile), { recursive: true })
    writeFileSync(
      registryFile,
      JSON.stringify({ pid: process.pid, sessionId, cwd: process.cwd(), startedAt: started, status, statusUpdatedAt: Date.now(), version: '2.1.999', kind: 'interactive' })
    )
  } catch (e) {
    record('registry-unwritable', { error: String(e) })
  }
}

function appendTranscript(entry) {
  if (!transcript) return
  mkdirSync(dirname(transcript), { recursive: true })
  const uuid = randomUUID()
  appendFileSync(
    transcript,
    JSON.stringify({ parentUuid: lastUuid, isSidechain: false, userType: 'external', cwd: process.cwd(), sessionId, version: '2.1.999', uuid, timestamp: new Date().toISOString(), ...entry }) + '\n'
  )
  lastUuid = uuid
}

/** Git Bash where the CLI would find it (statusLine.ts gitBashPath mirrors the same locator). */
function gitBash() {
  const o = process.env.CLAUDE_CODE_GIT_BASH_PATH
  if (o && /^bash(\.exe)?$/i.test(o.split(/[\\/]/).pop() ?? '') && existsSync(o)) return o
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) if (existsSync(p)) return p
  for (const d of String(process.env[pathKey] ?? '').split(';')) {
    if (!d || !existsSync(join(d, 'git.exe'))) continue
    const candidate = join(d.replace(/[\\/]+$/, ''), '..', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Run a statusLine or hook command as Claude Code 2.1.285's executor does
 * (read out of the bundle; verify-statusline.mts holds the same three routes):
 * `/bin/sh -c` off Windows; on it Git Bash (`bash -c`, bash's folder first on
 * PATH) when found, else PowerShell with -NoProfile -NonInteractive
 * -ExecutionPolicy Bypass -Command.
 */
function runLikeTheCli(command, payload) {
  const input = JSON.stringify(payload)
  const base = { input, encoding: 'utf8', timeout: 20_000, windowsHide: true }
  if (!isWin) return { shell: '/bin/sh', ...spawnSync(command, [], { ...base, shell: true }) }
  const bash = gitBash()
  if (bash) {
    const e = { ...process.env }
    e[pathKey] = `${dirname(bash)};${e[pathKey] ?? ''}`
    return { shell: bash, ...spawnSync(command, [], { ...base, shell: bash, env: e }) }
  }
  const pf = process.env.ProgramFiles ?? ''
  const pwsh = pf && existsSync(join(pf, 'PowerShell', '7', 'pwsh.exe')) ? join(pf, 'PowerShell', '7', 'pwsh.exe') : null
  const ps = pwsh ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return { shell: ps, ...spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], base) }
}

function renderStatusLine(promptId) {
  const command = settings?.statusLine?.command
  if (!command) {
    record('statusline', { ran: false, why: settings ? 'no statusLine in --settings' : 'no --settings' })
    return
  }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    session_id: sessionId,
    prompt_id: promptId,
    transcript_path: transcript,
    cwd: process.cwd(),
    version: '2.1.999',
    model: { id: 'claude-probe-1', display_name: 'Probe' },
    context_window: {
      context_window_size: 200000,
      used_percentage: 7,
      current_usage: { input_tokens: 12000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }
    },
    exceeds_200k_tokens: false,
    rate_limits: { five_hour: { used_percentage: 23, resets_at: now + 3600 }, seven_day: { used_percentage: 41, resets_at: now + 86400 } }
  }
  const r = runLikeTheCli(command, payload)
  record('statusline', { ran: true, command, shell: r.shell, status: r.status, signal: r.signal, error: r.error ? String(r.error) : null, stdout: r.stdout, stderr: String(r.stderr ?? '').slice(0, 2000) })
}

function fireHook(event, extra) {
  const entries = settings?.hooks?.[event] ?? []
  const commands = entries.flatMap((e) => (e.hooks ?? []).map((h) => h.command)).filter(Boolean)
  if (!commands.length) {
    record('hook', { event, ran: false })
    return
  }
  for (const command of commands) {
    const r = runLikeTheCli(command, { hook_event_name: event, session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), ...extra })
    record('hook', { event, ran: true, command, shell: r.shell, status: r.status, error: r.error ? String(r.error) : null, stderr: String(r.stderr ?? '').slice(0, 2000) })
  }
}

/* ------------------------------------------------------------- lifetime */

const started = Date.now()
let ended = false
function end(why) {
  if (ended) return
  ended = true
  record('exit', { why })
  try {
    writeFileSync(join(dir, `exit-${id}-${process.pid}`), `${why}\n`)
  } catch {
    /* nothing to be done */
  }
  if (registryFile) rmSync(registryFile, { force: true })
}
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    end(sig)
    process.exit(0)
  })
}
process.on('exit', () => end('exit'))

say(`STOKE-PROBE ${id} ready pid=${process.pid}`)
if (claude) {
  say(`STOKE-PROBE claude ${sessionHow} ${sessionId}`)
  writeRegistry('idle')
  renderStatusLine(null)
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (raw) => {
  const line = raw.replace(/\r$/, '')
  record('input', { line })
  say(`GOT ${line}`)
  const mcp = /^mcp\s+(\S+)/.exec(line)
  if (mcp) {
    await mcpVisit(mcp[1])
    return
  }
  const link = /^hardlink\s+(\S+)/.exec(line)
  if (link) {
    const cols = process.stdout.columns || 80
    const url = link[1] + 'x'.repeat(cols * 2) + '&end=terminal-tail'
    record('hardlink', { url, cols })
    // A TUI repaint: two full rows with explicit CRLF, rather than xterm's
    // ordinary autowrap flag. A click on the last row must open the whole URL.
    process.stdout.write('\r\n\x1b[?7l' + Array.from({ length: Math.ceil(url.length / cols) }, (_, i) => url.slice(i * cols, (i + 1) * cols)).join('\r\n') + '\x1b[?7h\r\n')
    return
  }
  if (!claude || !line.trim()) return
  // One turn, as the CLI makes one: the prompt hook, a busy registry, the
  // transcript's user and assistant records, a re-rendered status line, Stop.
  turns++
  const promptId = randomUUID()
  writeRegistry('busy')
  fireHook('UserPromptSubmit', { prompt: line })
  appendTranscript({ type: 'user', message: { role: 'user', content: line } })
  const reply = `stoke probe reply ${turns}`
  appendTranscript({
    type: 'assistant',
    message: {
      id: `msg_probe_${turns}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-probe-1',
      content: [{ type: 'text', text: reply }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }
    }
  })
  renderStatusLine(promptId)
  fireHook('Stop', { last_assistant_message: reply, stop_hook_active: false })
  writeRegistry('idle')
  say(`REPLY ${reply}`)
})
rl.on('close', () => {
  end('eof')
  process.exit(0)
})
