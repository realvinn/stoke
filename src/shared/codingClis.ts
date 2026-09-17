/*
 * The coding CLIs Stoke knows about, and what it can honestly say about them.
 *
 * Stoke wraps the real `claude` binary in a PTY rather than reimplementing it,
 * and the same trick works for any CLI that draws a TUI. This module is the
 * list; `src/main/cli.ts` does the looking.
 *
 * Stoke can launch these, not merely find them — but only Claude Code gets the
 * whole app around it. Everything Stoke draws beside a session (the context
 * ring, resume, the worklog, the plan-limit chip) is fed by Claude Code's own
 * transcript format and its statusLine hook, and what each OTHER cli can
 * honestly feed is recorded in `CLI_CAPS` below rather than assumed. A tab that
 * cannot measure its context shows nothing there; it never shows Claude's.
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import (gotcha 27).
 */

export type CodingCliId = 'claude' | 'codex' | 'grok' | 'opencode'

export interface CodingCli {
  id: CodingCliId
  /** What to call it in the UI. */
  label: string
  /** Who makes it, for the one-line description. */
  vendor: string
  /**
   * Executable names to look for, in order of preference.
   *
   * Windows needs the variants spelled out: an npm-installed CLI is a `.cmd`
   * shim, not an `.exe`, and `spawnSpec` runs those through `cmd.exe` (gotcha
   * 13). A bare name would find neither.
   */
  bins: { posix: readonly string[]; win32: readonly string[] }
  /** Where to get it, shown when it is not installed. */
  home: string
}

export const CODING_CLIS: readonly CodingCli[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    bins: { posix: ['claude'], win32: ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] },
    home: 'https://claude.com/claude-code'
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    vendor: 'OpenAI',
    bins: { posix: ['codex'], win32: ['codex.exe', 'codex.cmd', 'codex.bat', 'codex'] },
    home: 'https://github.com/openai/codex'
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    vendor: 'xAI',
    bins: { posix: ['grok'], win32: ['grok.exe', 'grok.cmd', 'grok.bat', 'grok'] },
    home: 'https://github.com/superagent-ai/grok-cli'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'opencode.ai',
    bins: { posix: ['opencode'], win32: ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode'] },
    home: 'https://opencode.ai'
  }
]


/**
 * What Stoke may honestly draw beside a session, per CLI.
 *
 * This table is the honesty seam, and it exists because the failure it prevents
 * is silent. Every one of these surfaces reads a Claude Code artefact — the
 * statusLine payload, a `~/.claude/projects/**.jsonl` transcript, an Anthropic
 * OAuth endpoint, a Stoke-minted `--session-id`. Point a tab at another binary
 * and each of them keeps rendering, now describing a session that does not
 * exist: the ring fills from the wrong file, the plan chip states somebody
 * else's quota, and the relaunch pill offers to restart a Codex session with
 * `claude --resume`. None of those throw. A wrong number in a status bar is
 * worse than a blank one, so every capability starts at its floor and is raised
 * only when something real feeds it.
 *
 * Codex is the one with room to grow, and the growth is already mapped:
 * `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl` carries a STATED
 * `model_context_window` (which is what gotcha 2 requires — inferring a window
 * from observed usage reported 140-320% occupancy the first time it was tried),
 * a `total_token_usage` object, and `rate_limits` with `used_percent` and an
 * epoch-seconds `resets_at`. That is a ring and a plan chip from a file
 * watcher, with no wrapper and no hook. Until that watcher exists, `'none'`.
 */
export interface CliCaps {
  /** Where a context reading could come from, or `'none'` for no ring at all. */
  ring: 'statusline' | 'transcript' | 'none'
  /** Whether Stoke can name the session to resume it. */
  resume: 'mintedId' | 'none'
  /** Whether the worklog runner can review this session's work. */
  worklog: boolean
  /** Whose plan the usage chip would be describing. */
  usage: 'anthropic' | 'none'
  /** Which launcher pills mean anything. Claude's flags are Claude's. */
  launchFlags: { permissionMode: boolean; effort: boolean; model: boolean }
}

export const CLI_CAPS: Record<CodingCliId, CliCaps> = {
  claude: {
    ring: 'statusline',
    resume: 'mintedId',
    worklog: true,
    usage: 'anthropic',
    launchFlags: { permissionMode: true, effort: true, model: true }
  },
  codex: {
    ring: 'none',
    resume: 'none',
    worklog: false,
    usage: 'none',
    launchFlags: { permissionMode: false, effort: false, model: false }
  },
  grok: {
    ring: 'none',
    resume: 'none',
    worklog: false,
    usage: 'none',
    launchFlags: { permissionMode: false, effort: false, model: false }
  },
  opencode: {
    ring: 'none',
    resume: 'none',
    worklog: false,
    usage: 'none',
    launchFlags: { permissionMode: false, effort: false, model: false }
  }
}

/**
 * The default, and the answer to every unparseable input.
 *
 * Claude Code rather than a null: every tab that existed before this field did
 * was a Claude tab, so a restored tab with no `cliId` IS one, and a tab with a
 * corrupted one is far better treated as the fully-instrumented case than
 * launched as some other binary on the strength of a bad string.
 */
export const DEFAULT_CLI: CodingCliId = 'claude'

export function isCodingCliId(v: unknown): v is CodingCliId {
  return typeof v === 'string' && CODING_CLIS.some((c) => c.id === v)
}

/**
 * Hydrate a stored or wire-borne cli id.
 *
 * Every field read back off disk needs one of these. `tabStore.ts` restores
 * tabs from a JSON file a user can edit and a previous version wrote, and
 * CLAUDE.md's clamp rule exists for exactly this: a field the hydrator does not
 * name comes back `undefined`, and an `undefined` cli id here would mean
 * `buildArgs` deciding what to spawn from a value nothing validated.
 */
export function cliIdOf(v: unknown): CodingCliId {
  return isCodingCliId(v) ? v : DEFAULT_CLI
}

export function cliFor(id: CodingCliId): CodingCli {
  return CODING_CLIS.find((c) => c.id === id) ?? CODING_CLIS[0]
}

export function capsFor(id: CodingCliId): CliCaps {
  return CLI_CAPS[id] ?? CLI_CAPS.claude
}

/**
 * The one question most of the main process actually wants to ask.
 *
 * Named rather than written out as `id === 'claude'` at each site, because the
 * sites are the gates around the statusLine wrapper, the transcript watcher,
 * the minted session id and the auth validation — and a missed one is not a
 * type error, it is a Codex session being handed `ANTHROPIC_API_KEY` and a
 * `--settings` file it will not understand.
 */
export function isClaudeCode(id: CodingCliId): boolean {
  return id === 'claude'
}

/** The names to look for on this platform. */
export function binNamesFor(cli: CodingCli, platform: string): readonly string[] {
  return platform === 'win32' ? cli.bins.win32 : cli.bins.posix
}

/** What a lookup found. */
export interface CodingCliStatus {
  id: CodingCliId
  /** The resolved path, or null when nothing was found. */
  path: string | null
}

/**
 * One line about a CLI, given what the lookup found.
 *
 * Pure so the wording is assertable, and separated from the component because
 * the interesting case is the one with no good answer: a failed login-shell
 * probe means "not found" is a statement about Stoke's PATH rather than about
 * the machine (gotcha 52), and saying "not installed" there sends someone to
 * reinstall something they already have. `probeFailed` is exactly that
 * distinction and must not be dropped.
 */
export function cliStatusLine(
  cli: CodingCli,
  status: CodingCliStatus | undefined,
  probeFailed: boolean
): string {
  if (status?.path) return status.path
  if (probeFailed) {
    return 'Not found — but Stoke could not read a login shell, so this may be a PATH problem rather than a missing install.'
  }
  return 'Not installed.'
}
