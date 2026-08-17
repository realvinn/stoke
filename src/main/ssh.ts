/**
 * SSH sessions: reaching a VPS or a NUC from the Stoke that is already running,
 * rather than installing Stoke on a headless box.
 *
 * Almost nothing new is needed for this. Stoke already spawns a process in a PTY
 * and fans its output to the phone, so a remote session is the same machinery
 * with a different argv — a session *type*, not a subsystem.
 *
 * The one design decision worth defending: Stoke stores **no connection
 * details**. `SshHost` carries a label, an alias and a command, and that alias
 * names a `Host` entry in the user's own `~/.ssh/config`. Keys, ports, users,
 * jump hosts and ProxyCommand therefore stay in the single file that already
 * works and that git, scp, rsync and every other tool on the machine reads.
 * Copying them into settings.json would create a second source of truth, and the
 * two would drift silently — the failure would look like "it connects as the
 * wrong user", never like an error.
 *
 * This module imports no electron and touches no state, so it runs directly
 * under `node --experimental-strip-types`. See scripts/verify-ssh.mts.
 */
import { existsSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { SshHost } from '@shared/types'

const isWin = process.platform === 'win32'

/* ------------------------------------------------------------- ssh_config */

/** Where OpenSSH looks for the per-user config, on every platform it supports. */
export function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

/** One directive worth acting on. Everything else in the file is ignored. */
export interface SshConfigEntry {
  kind: 'host' | 'include'
  /** A single Host pattern, or one raw (unexpanded) Include argument. */
  value: string
}

/**
 * OpenSSH's own limit on nested Includes (`MAX_READCONF_DEPTH`). Matched rather
 * than invented so a config ssh accepts is never rejected here.
 */
const MAX_INCLUDE_DEPTH = 16

/**
 * Split one config line into its keyword and arguments, or null for a blank
 * line or a whole-line comment.
 *
 * Mirrors OpenSSH's `strdelim`: the keyword may be separated from its value by
 * whitespace, by `=`, or by both — `Host web`, `Host=web` and `Host = web` are
 * all the same line. Verified against OpenSSH_for_Windows_9.5p2, which resolves
 * `Host=eq` exactly like the spaced form.
 */
function splitLine(line: string): { keyword: string; args: string[] } | null {
  let rest = line.replace(/^\s+/, '')
  if (!rest || rest.startsWith('#')) return null

  const at = rest.search(/[\s=]/)
  if (at === -1) return { keyword: rest, args: [] }

  const keyword = rest.slice(0, at)
  rest = rest.slice(at).replace(/^\s+/, '')
  if (rest.startsWith('=')) rest = rest.slice(1).replace(/^\s+/, '')

  return { keyword, args: splitArgs(rest) }
}

/**
 * Split the arguments of one directive, honouring double quotes.
 *
 * The `#` rule is not a guess. Probed against 9.5p2 with a fixture config:
 *
 *   Host web # prod   -> `web` matches; `prod` and `#` match nothing
 *   Host web#1        -> `web#1` matches; `web` matches nothing
 *
 * So a `#` begins a comment only where a token begins, and is an ordinary
 * character anywhere else. Getting that backwards would either offer `prod` as a
 * machine the user could connect to, or drop a legitimate alias.
 */
function splitArgs(rest: string): string[] {
  const args: string[] = []
  let cur = ''
  let quoted = false
  let started = false

  for (const ch of rest) {
    if (ch === '"') {
      // A quoted empty string is still an argument, so remember that a token
      // began even when nothing has been added to it.
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) args.push(cur)
      cur = ''
      started = false
      continue
    }
    if (!quoted && !started && ch === '#') break
    cur += ch
    started = true
  }
  if (started) args.push(cur)

  return args
}

/**
 * Pull the Host and Include directives out of a config file's text, in the order
 * they appear. Pure: no disk, no throw, so the awkward cases can be tested
 * directly rather than through a fixture tree.
 */
export function parseSshConfig(text: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = []

  for (const line of text.split(/\r?\n/)) {
    const parsed = splitLine(line)
    if (!parsed) continue
    const keyword = parsed.keyword.toLowerCase()

    // `Match` blocks are deliberately not read: they set options for hosts, they
    // do not name one, so there is nothing in them to offer as a suggestion.
    if (keyword === 'host') {
      for (const pattern of parsed.args) entries.push({ kind: 'host', value: pattern })
    } else if (keyword === 'include') {
      for (const pattern of parsed.args) entries.push({ kind: 'include', value: pattern })
    }
  }

  return entries
}

/**
 * Is this Host pattern a machine, or a family of them?
 *
 * `*`, `web?` and `*.example.com` are rules that apply to many hosts, and
 * `!bad` is an exclusion. None of them is something `ssh` can be pointed at, so
 * offering any of them as a suggestion would hand the user an alias that cannot
 * connect.
 */
export function isConnectableAlias(pattern: string): boolean {
  if (!pattern) return false
  if (pattern.startsWith('!')) return false
  return !/[*?]/.test(pattern)
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/** Expand `~` at the front of an Include argument. ssh does this too. */
function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  // Windows filenames are case-insensitive, so a case-sensitive match would skip
  // a `Config.d` that ssh itself would have found.
  return new RegExp(`^${body}$`, isWin ? 'i' : '')
}

/**
 * Resolve one glob to real files. Only the final segment is expanded, which
 * covers the shapes people actually write (`conf.d/*`, `*.conf`); a glob in a
 * middle segment costs a suggestion, never a crash.
 */
async function expandGlob(p: string): Promise<string[]> {
  if (!/[*?]/.test(p)) return isFile(p) ? [p] : []

  const dir = dirname(p)
  if (/[*?]/.test(dir)) return []
  const base = p.slice(dir.length + 1)

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const re = globToRegExp(base)
  return names
    .filter((n) => re.test(n))
    .sort()
    .map((n) => join(dir, n))
    .filter(isFile)
}

/**
 * Every file one Include argument names.
 *
 * ssh_config(5): a relative path in a *user* config is taken as relative to
 * `~/.ssh`, not to the including file. The including file's own directory is
 * tried second so a config read from anywhere else — a fixture, a copied tree —
 * still resolves. In the vanishingly rare case that both exist, ssh would take
 * the first and so does this.
 */
async function expandInclude(pattern: string, includingFile: string): Promise<string[]> {
  const p = expandTilde(pattern)
  const candidates = isAbsolute(p)
    ? [p]
    : [join(homedir(), '.ssh', p), join(dirname(includingFile), p)]

  const out: string[] = []
  for (const c of candidates) out.push(...(await expandGlob(c)))
  return out
}

/**
 * The Host aliases in the user's ssh config, in file order, deduplicated.
 *
 * This exists so the settings UI can offer what the user already has instead of
 * making them retype it — which is also the check that catches a typo before it
 * becomes a session that hangs on an unresolvable name.
 *
 * Never throws. A machine with no `~/.ssh/config` is entirely normal, and an
 * unreadable one must leave the settings sheet rendering rather than take it
 * down; both come back as `[]`, and the alias box stays free-form so a host that
 * is not in the config can still be typed in full.
 *
 * `file` is a parameter only so the tests can point it somewhere else.
 */
export async function readSshConfigHosts(file: string = sshConfigPath()): Promise<string[]> {
  const out: string[] = []
  // ssh matches Host patterns case-insensitively, so fold before deduplicating.
  const seen = new Set<string>()
  const visited = new Set<string>()

  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) return
    // Two files that Include each other would otherwise recurse until the depth
    // cap on every settings open. Cheap to prevent, so prevent it.
    const key = isWin ? path.toLowerCase() : path
    if (visited.has(key)) return
    visited.add(key)

    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return
    }

    for (const entry of parseSshConfig(text)) {
      if (entry.kind === 'host') {
        if (!isConnectableAlias(entry.value)) continue
        const folded = entry.value.toLowerCase()
        if (seen.has(folded)) continue
        seen.add(folded)
        out.push(entry.value)
        continue
      }
      // Walked in place rather than after the file, so the aliases come back in
      // the order ssh itself would have read them.
      for (const inc of await expandInclude(entry.value, path)) await walk(inc, depth + 1)
    }
  }

  try {
    await walk(file, 0)
  } catch {
    /* Whatever went wrong, a partial list beats a broken settings sheet. */
  }

  return out
}

/* ---------------------------------------------------------------- the exe */

function sshCandidates(): string[] {
  const out: string[] = []

  if (isWin) {
    /*
     * Windows' own OpenSSH first, ahead of PATH.
     *
     * On a developer machine PATH usually leads with Git for Windows' MSYS
     * build, and the two do not agree. Asked for the same host on this machine:
     *
     *   native  userknownhostsfile C:\Users\...\.ssh\known_hosts
     *   MSYS    userknownhostsfile /c/Users/.../.ssh/known_hosts
     *
     * Cygwin path semantics leak into anything that reads those paths back, and
     * which binary a user happens to have installed for git is not a thing
     * Stoke's behaviour should depend on. Pin the one Windows ships.
     */
    const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    out.push(join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe'))
    out.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenSSH', 'ssh.exe'))
  } else {
    out.push('/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh')
  }

  const name = isWin ? 'ssh.exe' : 'ssh'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) out.push(join(dir, name))
  }

  return out
}

/**
 * The ssh binary to spawn: the platform's own build if it is where it should be,
 * otherwise the first one on PATH, otherwise the bare name so the OS resolves it
 * and the failure is ssh's own "not found" rather than a path Stoke invented.
 */
export function sshExecutable(): string {
  for (const candidate of sshCandidates()) if (isFile(candidate)) return candidate
  return isWin ? 'ssh.exe' : 'ssh'
}

/* --------------------------------------------------------------- the argv */

/**
 * The argv that follows the ssh executable.
 *
 * Three things here are load-bearing:
 *
 * 1. **`-t` whenever a command is given.** `ssh host command` runs the command
 *    with no controlling terminal. Claude Code's TUI — the entire reason for
 *    connecting — then renders nothing at all, and nothing anywhere says why.
 *    This is the most likely silent failure in the whole feature.
 *
 * 2. **The command stays one argument.** ssh joins its trailing argv with
 *    spaces and hands the result to the remote login shell, so splitting on
 *    spaces here would be equivalent at best and wrong the moment a quote or a
 *    `&&` appears. Keeping it whole means Stoke never has to guess at quoting.
 *
 * 3. **`--` before an alias that starts with `-`.** Without it `ssh` reads the
 *    alias as options — a settings file is not a security boundary, but an alias
 *    typed with a leading dash would otherwise do something arbitrary instead of
 *    failing. Sent only when needed, and confirmed accepted by 9.5p2.
 *
 * Options must precede the destination: ssh stops parsing them at the first
 * non-option argument, so a `-t` after the alias becomes part of the remote
 * command instead.
 */
export function buildSshArgs(host: SshHost): string[] {
  const alias = host.alias.trim()
  const command = host.command.trim()
  const args: string[] = []

  /*
   * 4. **`-e none`, or pasting into a remote session corrupts itself.**
   *
   * ssh runs on a pty here, so its client-side escape character is live, and it
   * is `~`. The rule is that `~` is read as an escape only directly after a
   * newline — which is exactly where a multi-line paste puts it, because
   * xterm's paste rewrites every newline to a bare `\r` and brackets the blob
   * as a whole rather than line by line (`Clipboard.ts:14,21-26`). So the first
   * line of a paste is safe and lines 2..n are not: a leading `~~` collapses to
   * `~`, `~?` and `~#` print ssh's own help over the session, and `~.` kills
   * the connection outright while the user watches their paste do it.
   *
   * It looks intermittent because it is content-dependent, and `~/some/path`
   * survives — `/` is not an escape — which is what makes it easy to misread as
   * "paste is flaky" rather than as ssh doing precisely what it documents.
   * Nothing is lost by turning it off: the escapes are an interactive
   * convenience for a session Stoke closes by closing the tab.
   */
  args.push('-e', 'none')

  if (command) args.push('-t')
  if (alias.startsWith('-')) args.push('--')
  args.push(alias)
  if (command) args.push(command)

  return args
}

/* ------------------------------------------------------ the remote transcript */

/**
 * Reading a remote session's transcript.
 *
 * The far machine writes exactly the JSONL Stoke already parses; the only reason
 * a remote session has never had a context meter or a worklog entry is that
 * nothing ever went and fetched it. This is that fetch, expressed as a command
 * for the remote login shell.
 *
 * **Nothing here mutates the user's own `host.command`.** Passing `--session-id`
 * to the remote `claude` would correlate the session exactly, and was the
 * obvious first design — but a remote CLI old enough not to know the flag would
 * exit with an unknown-option error, and the *terminal itself* would break on
 * every connection to that host. Breaking the thing that works to improve the
 * thing that does not is the wrong trade, so the newest transcript is asked for
 * instead. The cost is real and worth stating: two Claude sessions running on
 * one host at the same time cannot be told apart, and the newer wins.
 */

/** Bytes of transcript pulled back. The tail is what matters; the head is history. */
export const MAX_REMOTE_TRANSCRIPT_BYTES = 4_000_000

/**
 * Session ids that may be interpolated into a remote shell command.
 *
 * The command below is handed to the far machine's login shell, so anything
 * placed in it is executed there. A uuid is hex and dashes; nothing else is
 * allowed anywhere near it, whatever it claims to be.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

export function isSafeSessionId(id: string): boolean {
  return SAFE_ID.test(id)
}

/**
 * The command that prints a remote transcript: its path on the first line, then
 * its last `MAX_REMOTE_TRANSCRIPT_BYTES` bytes.
 *
 * Plain POSIX `sh`, because the remote login shell is whatever the user has.
 * `ls` failing (no such directory on a machine that has never run Claude) is
 * routed to /dev/null and leaves `$f` empty, so the whole thing prints nothing
 * and exits cleanly rather than looking like a broken connection.
 *
 * The path is printed first so the caller can say *which* transcript it read —
 * which is the only defence the user has against the ambiguity noted above.
 *
 * `sessionId` narrows the glob when it is known and trustworthy. It is not
 * passed today; the parameter exists because the narrowing is the correct
 * behaviour the moment there is a reliable id, and a rule about what may be
 * interpolated is worth having tested before then, not after.
 */
export function buildTranscriptCommand(sessionId?: string | null): string {
  const name = sessionId && isSafeSessionId(sessionId) ? sessionId : '*'
  return [
    'd="$HOME/.claude/projects"',
    `f=$(ls -1t "$d"/*/${name}.jsonl 2>/dev/null | head -n 1)`,
    `if [ -n "$f" ]; then printf '%s\\n' "$f"; tail -c ${MAX_REMOTE_TRANSCRIPT_BYTES} "$f"; fi`
  ].join('; ')
}

/**
 * The argv for the fetch. Never `-t`: this is a pipe, not a terminal, and a
 * pseudo-terminal would translate newlines and corrupt the JSONL.
 *
 * `BatchMode=yes` so a host that wants a passphrase fails in seconds instead of
 * hanging a background poll on a prompt nobody will ever see.
 */
export function buildTranscriptArgs(host: SshHost, sessionId?: string | null): string[] {
  const alias = host.alias.trim()
  const args = ['-o', 'BatchMode=yes']
  if (alias.startsWith('-')) args.push('--')
  args.push(alias, buildTranscriptCommand(sessionId))
  return args
}

/**
 * Split what the fetch printed into the transcript's remote path and its JSONL.
 *
 * When the tail hit its cap the first line of content is half a record. The
 * parsers already drop an unreadable line, so this is belt and braces — but a
 * fragment that happens to parse is a made-up turn, and that is worse than a
 * missing one.
 */
export function splitTranscriptOutput(
  stdout: string,
  cap = MAX_REMOTE_TRANSCRIPT_BYTES
): { path: string; jsonl: string } | null {
  const firstBreak = stdout.indexOf('\n')
  if (firstBreak < 0) return null
  const path = stdout.slice(0, firstBreak).trim()
  if (!path) return null

  let jsonl = stdout.slice(firstBreak + 1)
  if (jsonl.length >= cap) {
    const nextBreak = jsonl.indexOf('\n')
    jsonl = nextBreak < 0 ? '' : jsonl.slice(nextBreak + 1)
  }
  return { path, jsonl }
}
