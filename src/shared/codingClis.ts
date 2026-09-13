/*
 * The coding CLIs Stoke knows about, and what it can honestly say about them.
 *
 * Stoke wraps the real `claude` binary in a PTY rather than reimplementing it,
 * and the same trick works for any CLI that draws a TUI. This module is the
 * list; `src/main/cli.ts` does the looking.
 *
 * What this is NOT, yet: a way to launch one. Everything Stoke wraps around a
 * session — the context ring, resume, the worklog, the plan-limit chip — is fed
 * by Claude Code's own transcript format and its statusLine hook, and none of
 * that generalises for free. Detection is the honest half and it ships alone
 * rather than behind a picker that records a preference nothing reads.
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
