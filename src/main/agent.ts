import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEnvPath, findClaude, spawnSpec } from './cli.ts'

/**
 * A headless `claude -p` run: one prompt in, one JSON result out.
 *
 * Modelled on updates.ts — spawnSpec() plus a captured, timed exec — and
 * deliberately NOT on pty.ts, which exists to stream scrollback to a terminal
 * and has no notion of a result. Nothing here attaches to a session, writes to
 * a tty, or survives the call.
 *
 * This is the plumbing under the worklog agent, but it knows nothing about
 * worklogs: it is a general "ask the CLI one question with these tools" call.
 */

/**
 * Environment variables that must never reach the spawned CLI.
 *
 * Duplicated from pty.ts rather than imported: pty.ts pulls in @lydell/node-pty
 * at module load, and this module has to stay runnable under
 * `node --experimental-strip-types` for scripts/verify-worklog-runner.mts. The
 * list itself matters more than it looks — if Stoke is started from inside a
 * Claude Code session these markers are inherited, the child is treated as a
 * nested session, and transcript saving is silently disabled. Keep the two
 * lists in step.
 */
const STRIP_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
  'GDK_BACKEND',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID'
]

/**
 * Sonnet, always, unless a caller overrides it.
 *
 * Not a preference. The probe that proved connector tools reach a headless run
 * cost $0.50 for one trivial prompt, because it defaulted to Opus and paid for
 * 44k tokens of cache creation. A run per session at that price costs more than
 * the feature saves, so the model is pinned rather than inherited.
 */
export const DEFAULT_HEADLESS_MODEL = 'sonnet'

/**
 * Hard ceiling per run, enforced by the CLI itself (`--max-budget-usd`), not by
 * us watching afterwards. A prompt-building bug that accidentally pastes a whole
 * transcript fails loudly against this instead of quietly billing for it.
 */
export const DEFAULT_MAX_BUDGET_USD = 0.3

/**
 * execFile buffers all of stdout in memory and defaults to 1 MB. `--output-format
 * json` returns the result text inside a JSON envelope, and a chatty run blows
 * past a megabyte easily — at which point execFile kills the child and reports a
 * buffer error, losing the answer that had already been produced.
 */
const MAX_BUFFER = 16 * 1024 * 1024

const DEFAULT_TIMEOUT_MS = 180_000

export interface HeadlessOptions {
  /** Sent on stdin, never as argv. See runHeadless. */
  prompt: string
  /** Working directory for the run. Defaults to a neutral scratch folder. */
  cwd?: string
  /** Model alias or id. Defaults to sonnet — see DEFAULT_HEADLESS_MODEL. */
  model?: string
  /** Exact tool names the run may use. Omitted entirely when empty. */
  allowedTools?: string[]
  disallowedTools?: string[]
  timeoutMs?: number
  /**
   * Load no MCP servers at all: an empty `--mcp-config` plus
   * `--strict-mcp-config`. For a run that needs no tools this removes every
   * write-capable server from the picture rather than trusting an allowlist.
   */
  strictMcp?: boolean
  /**
   * `--safe-mode`: no CLAUDE.md, skills, plugins, hooks or MCP servers. Auth and
   * the built-in tools still work. Worth it for a run that needs nothing but the
   * prompt, because every one of those is context that is paid for per run.
   */
  safeMode?: boolean
  /**
   * `--effort`. Worth setting explicitly on a cheap run: thinking tokens bill as
   * output, and they dominated the first measured scan.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxBudgetUsd?: number
  /** Explicit path to the claude executable; null auto-detects. */
  claudePath?: string | null
}

export interface HeadlessResult {
  /** The `result` field of the JSON envelope: what the model actually said. */
  text: string
  isError: boolean
  subtype: string | null
  costUsd: number | null
  durationMs: number | null
  numTurns: number | null
  sessionId: string | null
  /** Non-empty means the run wanted a tool the allowlist did not grant. */
  permissionDenials: unknown[]
  raw: Record<string, unknown>
}

/** Thrown for anything that is not a result: no CLI, a crash, a timeout, junk. */
export class HeadlessError extends Error {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null

  // Explicit fields rather than TS parameter properties, so this module keeps
  // running under node's strip-only type handling.
  constructor(message: string, detail?: { stdout?: string; stderr?: string; exitCode?: number | null }) {
    super(message)
    this.name = 'HeadlessError'
    this.stdout = detail?.stdout ?? ''
    this.stderr = detail?.stderr ?? ''
    this.exitCode = detail?.exitCode ?? null
  }
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Scratch directory the headless runs execute in when the caller has no opinion.
 *
 * A neutral folder is the cheap default: CLAUDE.md discovery walks up from the
 * working directory, so running inside a real project silently loads that
 * project's memory files into a run that does not need them, and bills for it.
 */
export function agentScratchDir(): string {
  const dir = join(tmpdir(), 'stoke', 'agent')
  mkdirSync(dir, { recursive: true })
  return dir
}

const EMPTY_MCP_JSON = '{\n  "mcpServers": {}\n}\n'
let emptyMcpPath: string | null = null

/**
 * Path to an MCP config declaring no servers.
 *
 * A file rather than an inline `--mcp-config '{"mcpServers":{}}'` for the reason
 * recorded next to --settings in cli.ts: a .cmd install is spawned through
 * `cmd.exe /c`, which eats the quotes and braces, and the failure is silent.
 * Re-checked on every call because a temp sweeper can delete it, and a
 * `--mcp-config` pointing at nothing is worse than not passing it at all.
 */
export function emptyMcpConfigFile(): string {
  if (emptyMcpPath && isFile(emptyMcpPath)) return emptyMcpPath
  const dir = join(tmpdir(), 'stoke')
  const file = join(dir, 'empty-mcp.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, EMPTY_MCP_JSON, 'utf8')
  emptyMcpPath = file
  return file
}

/**
 * The argv for a run. Exported so the flags can be asserted without spawning
 * anything — the model pin and the absence of any bypass flag are cost and
 * blast-radius promises, and both are the kind of thing that regresses quietly.
 *
 * Note what is NOT here: the prompt.
 */
export function buildHeadlessArgs(opts: HeadlessOptions): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    opts.model || DEFAULT_HEADLESS_MODEL,
    // These runs are Stoke talking to itself. Persisting them would put agent
    // transcripts in ~/.claude/projects, where they show up in Stoke's own
    // session list — and, for the worklog watcher, would be scanned in turn.
    '--no-session-persistence',
    '--max-budget-usd',
    String(opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD)
  ]

  if (opts.safeMode) args.push('--safe-mode')
  if (opts.effort) args.push('--effort', opts.effort)

  if (opts.strictMcp) {
    args.push('--mcp-config', emptyMcpConfigFile(), '--strict-mcp-config')
  }

  // Comma-joined into ONE argv element. The flag is declared variadic
  // (`--allowedTools <tools...>`), so passing several bare words would let it
  // swallow the flags that follow; the CLI accepts "comma or space-separated".
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','))
  if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(','))

  return args
}

/** Pull the result envelope out of stdout, tolerating anything printed around it. */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    const v: unknown = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* fall through to the scan below */
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1))
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* not JSON at all */
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** First 400 characters of whatever the CLI said, for an error message. */
function snippet(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > 400 ? `${t.slice(0, 400)}…` : t
}

/**
 * Run the CLI once and return its result.
 *
 * **The prompt goes in on stdin.** Never as an argv element: on Windows a .cmd
 * install is spawned through `cmd.exe /c`, which eats `&`, `|`, `^`, `<` and
 * `>`. A prompt carrying any of those — a transcript digest carries all of them
 * — would arrive mangled or truncated, and the run would still succeed, against
 * a question nobody asked.
 *
 * Throws rather than returning an empty success: a non-zero exit, a timeout or
 * unparseable output are all failures, and the caller must be able to tell them
 * from "the model had nothing to say".
 */
export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const exe = await findClaude(opts.claudePath ?? null)
  if (!exe) {
    throw new HeadlessError(
      'Could not find the `claude` executable. Install Claude Code, or set an explicit path in Settings.'
    )
  }

  const args = buildHeadlessArgs(opts)
  const spec = spawnSpec(exe, args)

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (STRIP_ENV.includes(k)) continue
    env[k] = v
  }
  env.PATH = await buildEnvPath()

  // A cwd that has since been deleted (a scratch project, a removed worktree)
  // makes the spawn fail with ENOENT, which reads like "claude is missing".
  const wanted = opts.cwd
  const cwd = wanted && existsSync(wanted) ? wanted : agentScratchDir()
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const run = await new Promise<{
    err: (Error & { code?: number | string; killed?: boolean; signal?: string }) | null
    stdout: string
    stderr: string
  }>((resolve) => {
    const child = execFile(
      spec.file,
      spec.args,
      { cwd, env, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => resolve({ err: err as never, stdout, stderr })
    )
    // A child that exits before reading stdin turns the write into EPIPE, which
    // would otherwise take the whole process down as an unhandled error event.
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.prompt)
  })

  const envelope = parseEnvelope(run.stdout)

  if (run.err) {
    const e = run.err
    if (e.killed) {
      throw new HeadlessError(`The headless run timed out after ${timeout}ms.`, {
        stdout: run.stdout,
        stderr: run.stderr
      })
    }
    if (typeof e.message === 'string' && e.message.includes('maxBuffer')) {
      throw new HeadlessError('The headless run produced more output than the buffer allows.', {
        stdout: run.stdout,
        stderr: run.stderr
      })
    }
    // A non-zero exit that still printed a result envelope is a real answer
    // about a real failure (budget exceeded, a tool denied). Keep it, but never
    // let it read as success.
    if (!envelope) {
      const code = typeof e.code === 'number' ? e.code : null
      throw new HeadlessError(
        `The headless run failed${code === null ? '' : ` (exit ${code})`}: ${
          snippet(run.stderr) || snippet(run.stdout) || e.message
        }`,
        { stdout: run.stdout, stderr: run.stderr, exitCode: code }
      )
    }
  }

  if (!envelope) {
    throw new HeadlessError(
      `The headless run returned no JSON result. Output was: ${snippet(run.stdout) || '(nothing)'}`,
      { stdout: run.stdout, stderr: run.stderr }
    )
  }

  const text = str(envelope.result) ?? ''
  const isError = envelope.is_error === true || run.err !== null

  return {
    text,
    isError,
    subtype: str(envelope.subtype),
    costUsd: num(envelope.total_cost_usd),
    durationMs: num(envelope.duration_ms),
    numTurns: num(envelope.num_turns),
    sessionId: str(envelope.session_id),
    permissionDenials: Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [],
    raw: envelope
  }
}
