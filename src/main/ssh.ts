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
import type { RemoteSessionInfo, SshHost } from '@shared/types'
// Relative and with the extension, not the `@shared` alias: this module is run
// directly by `verify-ssh.mts` under `node --experimental-strip-types`, which
// resolves no aliases. A type-only import would be erased and could use either.
import { buildRemoteInstallCommand, isEnrollableAlias } from '../shared/sshAuth.ts'
import { MAX_IMAGE_BYTES, isSafeUploadName } from '../shared/imageUpload.ts'
import {
  MANAGED_TMUX_SOCKET,
  hostPersists,
  isPersistableCommand,
  isSafeRemoteSessionName,
  persistRefusal
} from '../shared/sshPersist.ts'

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

/** Expand `~` at the front of an Include argument, or of an `ssh -G` identityfile. ssh does this too. */
export function expandTilde(p: string): string {
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
 *
 * `remoteCommand` replaces `host.command` when given — the managed-session
 * wrapper (`buildPersistentCommand`), which carries the user's own command
 * inside it verbatim. See `sshHostArgs`, which is what the pty actually calls.
 */
export function buildSshArgs(host: SshHost, remoteCommand?: string): string[] {
  const alias = host.alias.trim()
  const command = (remoteCommand ?? host.command).trim()
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

  /*
   * 5. **Keepalives, so a dead link ENDS rather than hangs.** Without them a
   * connection whose other end vanished — a laptop that slept, wifi that
   * changed, a NAT that forgot the flow — sits in `read()` until TCP gives
   * up, which is hours, and the tab shows a frozen screen that looks alive.
   * Every 15 s ssh asks the server over the encrypted channel; three missed
   * answers end it with exit 255, which is what a managed session's tab
   * reconnects on. Local options: nothing reaches the remote command, so this
   * is not gotcha 19. A `ServerAliveInterval` in the user's own config is
   * overridden for these tabs only — command-line options win over the file.
   */
  args.push('-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_S}`, '-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`)

  if (command) args.push('-t')
  if (alias.startsWith('-')) args.push('--')
  args.push(alias)
  if (command) args.push(command)

  return args
}

/** Seconds between keepalives, and how many may go unanswered. 15 x 3 = a dead link ends in ~45 s. */
export const SERVER_ALIVE_INTERVAL_S = 15
export const SERVER_ALIVE_COUNT_MAX = 3

/* ------------------------------------------------- the managed remote session */

/**
 * The remote command that puts an SSH tab inside its own tmux session.
 *
 * Null when either input is not provably safe to hand to a shell: the name
 * must pass `isSafeRemoteSessionName` and `host.command` must pass
 * `isPersistableCommand`. Refuse, never escape — this string is parsed by the
 * far machine's login shell, whatever that is, and then by tmux.
 *
 * The shape, and why each piece is there (each measured against real tmux
 * 3.5a on Debian and 3.4 on Ubuntu — see gotcha 126):
 *
 * - **`sh -c '…'`.** The login shell parses the command first, and it may be
 *   fish or tcsh: fish rejects `{ …; }` and `||` chains written for sh. Inside
 *   single quotes every shell leaves the body alone, so the body is sh's. The
 *   same reason `buildRemoteInstallCommand` does it.
 * - **`command -v tmux || { …; exec "$SHELL" -l; }`.** No tmux on the machine
 *   is not a failed connection: the tab gets the plain shell (or the user's
 *   command) it would have had with persistence off, and one line saying the
 *   shell ends with the connection this time.
 * - **`-L stoke -f /dev/null`.** A private server with no config file: the
 *   user's own tmux/byobu server and `~/.tmux.conf` are never read or touched,
 *   and nothing of theirs (a prefix key, `mouse on`) changes a session they
 *   never see as tmux.
 * - **`-u`.** tmux writes `_` for every non-ASCII character when the remote
 *   locale is not UTF-8 — and ssh does not always forward `LANG`. Stoke's
 *   terminal is always UTF-8; Claude Code's box drawing depends on it.
 * - **`set -s escape-time 10`.** tmux 3.4 holds a lone Esc for 500 ms to see
 *   whether it starts a sequence, which makes Esc in Claude Code feel broken.
 * - **`set -s set-clipboard on`.** An app inside the session (vim `"+y`,
 *   nvim's osc52) reaches Stoke's clipboard; tmux's `external` default would
 *   drop it (gotcha 29's table).
 * - **`set -s terminal-overrides` (`MANAGED_TERMINAL_OVERRIDES`).** tmux stays
 *   on the outer NORMAL screen and scrolls with newlines, so with one
 *   full-width pane and no status line a scrolled line scrolls in Stoke's own
 *   xterm too and lands in its scrollback: the wheel, a plain drag and Select
 *   all work as they do locally, with no copy mode. `-s` REPLACES the array
 *   rather than appending (`-ga`), because this runs on every reconnect and
 *   `-ga` grew it by one entry each time. The limit: tmux draws SCREENS, not a
 *   byte stream — a burst bigger than the screen in one read reaches the
 *   terminal as the screen tmux last drew (`seq 1 3000` kept 148 lines live).
 *   The capture below is what makes the whole history come back.
 * - **`set -g status off`, `set -g mouse off`.** No chrome, and the wheel and
 *   drags stay Stoke's. An app inside that asks for the mouse (claude) still
 *   gets it: tmux forwards a pane's own mouse mode even with `mouse off`
 *   (gotcha 10).
 * - **`set -g prefix None`, `set -g prefix2 None`.** `-f /dev/null` skips the
 *   user's config, not tmux's built-in table, so C-b was still tmux's: the
 *   shell's backward-char and Claude Code's own Ctrl+B needed a double press,
 *   C-b d detached with exit 0 (read as "the shell ended", so the tab closed
 *   unasked), C-b c and C-b " broke the one-pane model and C-b [ opened tmux's
 *   copy mode (measured on 3.5a and 3.4, gotcha 126). With no prefix no key
 *   reaches the prefix table, and the root table holds only mouse bindings,
 *   which `mouse off` forwards to the pane. NOT `unbind -a -T prefix`: once
 *   it has run, the table is gone and the next run — every reconnect, every
 *   second tab — fails with "table prefix doesn't exist", which aborts the
 *   rest of the sequence, `new-session` included. `-q` only hides that: it
 *   still aborts, and the client exits 0.
 * - **`capture-pane -p -e -J -S - -E -1` first.** The session's own history,
 *   printed into the fresh terminal a reconnect opens, before the attach
 *   paints the screen below it (the terminal keeps it through tmux's clear:
 *   `scrollOnEraseInDisplay`, TerminalView). Measured after `seq 1 3000`: all
 *   2001 lines tmux still held came back, in order.
 * - **`new-session -A -s <name> [command]`.** Attach if it exists, create it
 *   if not: one command for first connect, reconnect and restore alike. The
 *   user's command runs as the session's shell command, verbatim — never with
 *   a flag added (gotcha 19) — and is ignored on an attach, as it should be.
 */
export function buildPersistentCommand(host: SshHost, name: string): string | null {
  if (!isSafeRemoteSessionName(name)) return null
  const command = host.command.trim()
  if (!isPersistableCommand(command)) return null
  const quoted = command ? ` "${command}"` : ''
  const fallback = command ? `exec "$SHELL" -c "${command}"` : 'exec "$SHELL" -l'
  const tmux = [
    `exec tmux -u -L ${MANAGED_TMUX_SOCKET} -f /dev/null start-server`,
    'set -s escape-time 10',
    'set -s set-clipboard on',
    `set -s terminal-overrides "${MANAGED_TERMINAL_OVERRIDES}"`,
    'set -g status off',
    'set -g mouse off',
    'set -g prefix None',
    'set -g prefix2 None',
    `set -g history-limit ${MANAGED_HISTORY_LIMIT}`,
    `new-session -A -s ${name}${quoted}`
  ].join(' \\; ')
  const body = [
    'command -v tmux >/dev/null 2>&1 || {',
    `printf "%s\\n" "${NO_TMUX_NOTICE}" >&2;`,
    `${fallback}; };`,
    /*
     * The history first, then the attach. A reconnect or a restore opens a
     * FRESH terminal, and tmux's attach redraws only the visible screen, so
     * without this everything above it is gone from Stoke's scrollback. The
     * session's own history (everything that scrolled off, up to tmux's
     * `history-limit`) is printed as plain output, so it scrolls into the new
     * terminal's scrollback before the attach paints the screen below it. No
     * session yet (a first connect) or no server: nothing, silently.
     *
     * The capture has to end exactly where the attach's screen will begin,
     * and the attach can RESIZE the pane to this pty's size first — which
     * moves that line. Measured in the app, each of these doubled or dropped
     * lines at the seam until it was accounted for:
     * - No history: tmux clamps `-E -1` to the screen's first line, so a
     *   session whose output had never scrolled showed its top line twice.
     * - Shorter: tmux drops blank rows below the cursor first, and pushes
     *   the rest into history — `cursor_y + 1 - rows` of them, after this
     *   capture and off the new screen, so on neither (a 38-row pane
     *   reattached at 36 lost two lines). Captured here, into the screen.
     * - Taller: tmux pulls up to `rows - pane_height` lines back OUT of
     *   history onto the screen, so they would show twice. Left out here.
     * `stty size` is this pty's own size; `$(( ))` runs only once tmux has
     * answered all three numbers, since dash dies on an empty operand.
     */
    `set -- $(tmux -L ${MANAGED_TMUX_SOCKET} display -p -t "=${name}:" "#{history_size} #{pane_height} #{cursor_y}" 2>/dev/null);`,
    'r=$(stty size 2>/dev/null); r=${r%% *}; e=-1;',
    'if [ -n "$3" ] && [ "${r:-0}" -gt 0 ] 2>/dev/null; then',
    'if [ "$r" -lt "$2" ]; then p=$(($3 + 1 - r)); [ "$p" -gt 0 ] && e=$((p - 1)); fi;',
    'if [ "$r" -gt "$2" ]; then q=$((r - $2)); [ "$q" -gt "$1" ] && q=$1; e=$((-1 - q)); fi;',
    'fi;',
    '[ -n "$3" ] && [ "$e" -ge "$((0 - $1))" ] &&',
    `tmux -L ${MANAGED_TMUX_SOCKET} capture-pane -p -e -J -S - -E "$e" -t "=${name}:" 2>/dev/null;`,
    tmux
  ].join(' ')
  return `sh -c '${body}'`
}

/**
 * `smcup@:rmcup@` keeps tmux on the outer NORMAL screen; `indn@` makes it
 * scroll by newlines. With the capability, a burst of output is scrolled with
 * one `CSI n S`, which xterm.js carries out WITHOUT keeping the lines — so
 * nothing reached Stoke's scrollback at all (measured: `seq 1 3000` left a
 * 30-line buffer). With plain newlines each scrolled line is kept.
 */
export const MANAGED_TERMINAL_OVERRIDES = 'xterm*:smcup@:rmcup@:indn@'

/**
 * Lines of history each managed session keeps, which is also what a reconnect
 * prints back into the new terminal before attaching. tmux's own 2000 is less
 * than one long build log; 5000 is ~0.5 MB with colours, a second at worst
 * over a slow link, once per reconnect.
 */
export const MANAGED_HISTORY_LIMIT = 5000

/** Printed on a host with no tmux, where the tab falls back to a plain shell. */
export const NO_TMUX_NOTICE =
  'Stoke: tmux is not installed on this machine, so this shell will not survive a dropped connection.'

/**
 * The argv for an SSH tab: plain `buildSshArgs` for a host that does not
 * persist, the managed-session wrapper for one that does.
 *
 * A persisting host with no valid session name, or with a command that cannot
 * be wrapped, is REFUSED with a sentence rather than silently connected
 * without persistence: a tab that looks kept and is not loses its work on the
 * first dropped link, which is the one thing the setting promises against.
 */
export function sshHostArgs(
  host: SshHost,
  remoteSession?: string | null
): { ok: true; args: string[] } | { ok: false; message: string } {
  if (!hostPersists(host)) return { ok: true, args: buildSshArgs(host) }
  const refusal = persistRefusal(host.command)
  if (refusal) return { ok: false, message: refusal }
  if (!isSafeRemoteSessionName(remoteSession)) {
    return { ok: false, message: 'This tab has no valid kept-session name, so Stoke will not connect it.' }
  }
  const command = buildPersistentCommand(host, remoteSession)
  if (!command) return { ok: false, message: 'Stoke could not build the kept-session command for this machine.' }
  return { ok: true, args: buildSshArgs(host, command) }
}

/**
 * `tmux -L stoke ls` with the fields the launcher shows, one session per line.
 *
 * Split on `|`, not a tab: tmux 3.4 printed each tab of an `-F` format as `_`
 * to a client with no UTF-8 locale — which a BatchMode ssh, with no pty and
 * no `LANG`, is (measured: `stoke-abab0007_1790748189_1_bash_/home/v`). No
 * field before the path can hold a `|` (a whitelisted name, two numbers, a
 * process name), and the path is last, so one containing `|` is rejoined.
 * Run with BatchMode: a host that wants a password answers "cannot say",
 * never a prompt nobody will see.
 */
export const REMOTE_SESSION_FORMAT =
  '#{session_name}|#{session_activity}|#{session_attached}|#{pane_current_command}|#{pane_current_path}'

/**
 * A one-shot BatchMode ssh running `body` under `sh -c '…'`, or null.
 *
 * `sh -c` for the reason `buildPersistentCommand` gives: the login shell may be
 * fish or tcsh, and tcsh reads `2>/dev/null` as an argument `2` plus a stdout
 * redirect. The body is built here from fixed text and whitelisted names and
 * never holds a single quote; one that did would be refused, not escaped.
 * `ControlPath=none` so a multiplexed master (the user's own `ControlMaster`)
 * cannot answer for a host that would otherwise ask for a password.
 */
function batchArgs(host: SshHost, body: string): string[] | null {
  const alias = host.alias.trim()
  if (!alias || alias.startsWith('-')) return null
  if (body.includes("'")) return null
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ControlPath=none',
    '-e',
    'none',
    alias,
    `sh -c '${body}'`
  ]
}

/* --------------------------------------------- an image sent to the machine */

/**
 * The far side of an image upload: sh reads the bytes from stdin into a file
 * of Stoke's naming and says where it put it. Null when the name or size is
 * not provably safe to put in a command (refused, never escaped).
 *
 * Measured against a real sshd before it was written (the scout's run, on
 * loopback): a 4.2 MB file arrived byte-identical, the folder 0700 and the
 * file 0600, and a cut-off stream did not publish the file. Each piece:
 *
 * - **`umask 077`**: the folder and the file are the user's alone.
 * - **`${XDG_CACHE_HOME:-$HOME/.cache}/stoke/paste`**, else
 *   **`${TMPDIR:-/tmp}/stoke-paste-<uid>`**. Never the project folder: the
 *   remote cwd is unknowable from here (gotcha 18). The folder must be a real
 *   directory owned by this user and not a symlink (`-O`, `! -L`), so a
 *   `stoke-paste-1000` planted in a shared /tmp is refused, not written into.
 * - **The sweep**: files there older than a day are removed. Safe, because
 *   Claude Code copies the image into its transcript the moment it is
 *   attached; the file is only the hand-over.
 * - **`cat > NAME.part`, then a `wc -c` check against SIZE, then `mv`**: a
 *   stream cut short (a dropped link, Cancel) never becomes the file Claude
 *   would read, and `.part` is removed on every failure — the measured run
 *   left it behind until `rm -f` was added.
 * - **`printf "STOKE_PATH %s\n"`**: the absolute path, on a line of its own,
 *   since rc files may print too (`parseUploadPath` takes the last one).
 *
 * Exit codes: 3 no folder, 4 write failed, 5 wrong size, 6 mv failed
 * (`uploadExitMessage`); ssh's own failures are 255.
 */
export function buildUploadBody(name: string, size: number): string | null {
  if (!isSafeUploadName(name)) return null
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) return null
  const usable = '[ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]'
  return [
    'umask 077;',
    'd="${XDG_CACHE_HOME:-$HOME/.cache}/stoke/paste";',
    `mkdir -p "$d" 2>/dev/null && ${usable} ||`,
    `{ d="\${TMPDIR:-/tmp}/stoke-paste-$(id -u)"; mkdir -p "$d" 2>/dev/null && ${usable}; } || exit 3;`,
    'chmod 700 "$d" 2>/dev/null;',
    'find "$d" -type f -mtime +0 -exec rm -f {} + 2>/dev/null;',
    `f="$d/${name}";`,
    'cat > "$f.part" || { rm -f "$f.part"; exit 4; };',
    'n=$(wc -c < "$f.part");',
    `[ $n -eq ${size} ] 2>/dev/null || { rm -f "$f.part"; exit 5; };`,
    'mv -f "$f.part" "$f" || { rm -f "$f.part"; exit 6; };',
    'printf "STOKE_PATH %s\\n" "$f"'
  ].join(' ')
}

/**
 * The argv that sends an image to `host` (bytes on stdin), or null.
 *
 * `batchArgs`' shape, with these differences, each for this job:
 *
 * - **`-T`**: never a pty. A user's `RequestTTY force` would otherwise give
 *   the far `cat` a terminal, which rewrites CR/LF and eats ^D in the bytes.
 * - **`RemoteCommand=none`**: a `RemoteCommand` in the user's config refuses
 *   any command on the line ("Cannot execute command-line and remote command").
 * - **`ControlMaster=no` and NO `ControlPath=none`**: a multiplexed master the
 *   user already runs to this host may answer — which is how a password host
 *   with `ControlMaster auto` in its config gets its images with no key — but
 *   this connection never becomes a master itself, so no persisted master is
 *   ever left behind by Stoke.
 * - **What scp sets for its own ssh** (scp.c's `do_cmd`), because this
 *   connection is a file copy too, not a session: `ClearAllForwardings=yes`,
 *   `PermitLocalCommand=no`, `ForwardAgent=no`, `-x`. Measured against a host
 *   whose config has `LocalForward` and `ExitOnForwardFailure yes` while its
 *   tab held the port: without the first, every image failed (exit 255,
 *   "Could not request local forwarding."); without the second, the host's
 *   `LocalCommand` ran once per image. An upload has no use for the agent or
 *   X11 on the far side, so they are not handed there.
 * - It is not a probe: nothing here decides `keyEnrolled` (gotcha 75), and the
 *   tab's own connection and command are untouched (gotcha 19, 126).
 */
export function buildUploadArgs(host: SshHost, name: string, size: number): string[] | null {
  const body = buildUploadBody(name, size)
  if (!body) return null
  const alias = host.alias.trim()
  if (!alias || alias.startsWith('-')) return null
  if (body.includes("'")) return null
  return [
    '-T',
    '-x',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ControlMaster=no',
    '-o',
    'RemoteCommand=none',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ForwardAgent=no',
    '-e',
    'none',
    alias,
    `sh -c '${body}'`
  ]
}

/**
 * The argv that lists a host's managed sessions, or null for an alias that
 * could be read as an option. A missing tmux, and a server with no sessions,
 * both print nothing and exit 0 (`2>/dev/null; true`): "none running" rather
 * than an error the launcher has to explain.
 */
export function buildRemoteSessionListArgs(host: SshHost): string[] | null {
  // Double-quoted inside the sh body: `#{…}` would start a comment unquoted,
  // and a bare `|` would be a pipe.
  return batchArgs(host, `tmux -L ${MANAGED_TMUX_SOCKET} ls -F "${REMOTE_SESSION_FORMAT}" 2>/dev/null; true`)
}

/**
 * The argv that ends one managed session ("End session" on close), or null
 * when the name or alias is not provably safe. Only ever a session on Stoke's
 * own socket: `-L stoke` is fixed here, so no name can reach a user's own
 * tmux server, and `=` makes the target an exact match, never a prefix.
 */
export function buildRemoteSessionKillArgs(host: SshHost, name: string): string[] | null {
  if (!isSafeRemoteSessionName(name)) return null
  return batchArgs(host, `tmux -L ${MANAGED_TMUX_SOCKET} kill-session -t "=${name}"`)
}

/**
 * Read what `tmux ls -F` printed with `REMOTE_SESSION_FORMAT`.
 *
 * Every row is text a remote machine sent, so a name that fails the whitelist
 * is dropped rather than offered: it would be handed back to a shell on
 * reattach. Activity is epoch SECONDS from tmux, kept as ms here.
 */
export function parseRemoteSessionList(stdout: string): RemoteSessionInfo[] {
  const out: RemoteSessionInfo[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('|')
    const [name = '', activity = '', attached = '', command = '', ...path] = parts
    if (!isSafeRemoteSessionName(name)) continue
    const secs = Number(activity)
    const clients = Number(attached)
    out.push({
      name,
      activity: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null,
      attached: Number.isFinite(clients) && clients > 0 ? clients : 0,
      command,
      path: path.join('|')
    })
  }
  return out.sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))
}

/* ---------------------------------------------------------- key enrollment */

/**
 * The `ssh-copy-id` to spawn, or null if the machine has none.
 *
 * Null is a real branch rather than a defensive one: `ssh-copy-id` is a
 * `#!/bin/sh` script, and Windows OpenSSH ships `ssh.exe`, `ssh-keygen.exe` and
 * `ssh-add.exe` and no such script. Returning a bare name there — the way
 * `sshExecutable` deliberately does — would turn "not installed" into an ENOENT
 * from a spawn, which reads like a crash rather than like a platform that needs
 * the fallback path.
 */
export function sshCopyIdExecutable(): string | null {
  const out: string[] = []
  if (!isWin) out.push('/usr/bin/ssh-copy-id', '/usr/local/bin/ssh-copy-id', '/opt/homebrew/bin/ssh-copy-id')
  const name = isWin ? 'ssh-copy-id.exe' : 'ssh-copy-id'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) out.push(join(dir, name))
  }
  for (const candidate of out) if (isFile(candidate)) return candidate
  return null
}

/**
 * `ssh-copy-id`'s argv.
 *
 * `-o EscapeChar=none` rather than `-e none`: gotcha 29 must survive here too —
 * the user types a password into this PTY and a `~` after a newline would be an
 * ssh escape — but `ssh-copy-id` is a wrapper with no `-e` flag of its own. It
 * forwards `-o` to ssh, and `EscapeChar` is the `ssh_config` spelling of the
 * same setting (`ssh -G -o EscapeChar=none` reports `escapechar none`).
 *
 * `NumberOfPasswordPrompts=1` so a mistyped password fails immediately instead
 * of sitting through ssh's default three, which from inside a pane looks like
 * the tool having hung.
 *
 * `ControlPath=none` because a multiplexed connection would reuse an existing
 * authenticated channel and prove nothing about whether the key works.
 *
 * Every `-o` precedes the alias: ssh stops parsing options at the first
 * non-option argument, the same rule `buildSshArgs` is pinned on.
 */
export function buildCopyIdArgs(host: SshHost, pubPath: string): string[] | null {
  const alias = host.alias.trim()
  if (!isEnrollableAlias(alias)) return null
  return [
    '-i',
    pubPath,
    '-o',
    'EscapeChar=none',
    '-o',
    'ControlPath=none',
    '-o',
    'NumberOfPasswordPrompts=1',
    alias
  ]
}

/**
 * The no-`ssh-copy-id` path: plain ssh running an append command.
 *
 * Null when the key line is not provably safe to embed, or the alias is not
 * provably safe to hand to ssh as a destination. Refuse, never escape — the
 * same rule `SAFE_ID` applies to session ids, and for the same reason: this
 * string is executed by the far machine's login shell.
 */
export function buildEnrollFallbackArgs(host: SshHost, pubkeyLine: string): string[] | null {
  const alias = host.alias.trim()
  if (!isEnrollableAlias(alias)) return null
  const command = buildRemoteInstallCommand(pubkeyLine)
  if (!command) return null
  return ['-e', 'none', '-t', '-o', 'ControlPath=none', '-o', 'NumberOfPasswordPrompts=1', alias, command]
}

/**
 * Does the TAB's own connection now get in without a password?
 *
 * The only thing that may set `SshHost.keyEnrolled`, and it asks exactly the
 * question the flag answers: what will `ssh <alias>` — `buildSshArgs`, the
 * argv every SSH tab runs — do next time. So no `-i` and no `IdentitiesOnly`:
 * the identities come from the user's config and agent, the same as the tab's.
 *
 * The first draft probed with `-i <key> -o IdentitiesOnly=yes` instead, which
 * proves the SERVER accepts that key and says nothing about whether plain ssh
 * will offer it. With a key minted as `~/.ssh/stoke_ed25519` — not one of
 * ssh's default names — that probe passed, `keyEnrolled` went true, and the
 * next tab still asked for a password. That probe survives as
 * `buildPubkeyProbeArgs`, only to word a failure of this one.
 *
 * `ssh-copy-id` exiting 0 is not evidence either (`PubkeyAuthentication no`,
 * an `AuthorizedKeysFile` elsewhere, a group-writable home all give a happy
 * install and a server that still asks). `BatchMode=yes` means this can never
 * prompt, so it either succeeds on a key or exits non-zero; `ControlPath=none`
 * so a multiplexed master cannot answer for it; `PreferredAuthentications=
 * publickey` so a host that also allows keyboard-interactive does not count.
 */
export function buildLoginProbeArgs(host: SshHost): string[] | null {
  const alias = host.alias.trim()
  if (!isEnrollableAlias(alias)) return null
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'PreferredAuthentications=publickey',
    '-o',
    'ControlPath=none',
    '-o',
    'ConnectTimeout=10',
    '-e',
    'none',
    alias,
    'exit'
  ]
}

/**
 * Does the SERVER accept this one key?
 *
 * Not what sets `keyEnrolled` — see `buildLoginProbeArgs`. Run only after the
 * login probe failed, to tell "the server refuses the key" (sshd config,
 * permissions) from "the server takes it but plain ssh does not offer it"
 * (the local config), which need opposite fixes.
 *
 * Lifted from `ssh-copy-id`'s own pre-flight check, which uses the same three
 * options for the same reason.
 */
export function buildPubkeyProbeArgs(host: SshHost, keyPath: string): string[] | null {
  const alias = host.alias.trim()
  if (!isEnrollableAlias(alias)) return null
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'PreferredAuthentications=publickey',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ControlPath=none',
    '-o',
    'ConnectTimeout=10',
    '-e',
    'none',
    '-i',
    keyPath,
    alias,
    'exit'
  ]
}

/* ------------------------------------------------- the key, saved locally */

/**
 * The identity files `ssh -G <alias>` prints, in ssh's order, `~` expanded.
 *
 * `ssh -G` resolves the whole config — `Host` blocks, `Match`, `Include`, the
 * defaults when nothing names a file — and prints every keyword lower-cased,
 * one per line, value after a single space. This is the list plain
 * `ssh <alias>` will offer from disk, which is the list a new key has to be on.
 */
export function identityFilesFromSshG(stdout: string, home?: string): string[] {
  const out: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('identityfile ')) continue
    const raw = line.slice('identityfile '.length).trim()
    if (!raw) continue
    out.push(home && (raw === '~' || raw.startsWith('~/')) ? join(home, raw.slice(2)) : expandTilde(raw))
  }
  return out
}

/**
 * The `Host` pattern that makes a block apply to this alias, or null.
 *
 * ssh matches `Host` patterns against the destination's HOST part, so a bare
 * `user@1.2.3.4` needs `Host 1.2.3.4`, not the whole string. Whitelisted, never
 * escaped: the result is written into a file every ssh on the machine reads,
 * so anything that could be a second pattern, a negation, a wildcard or the
 * start of another keyword is refused (`ssh://` URIs and IPv6 brackets too —
 * rare enough that "add it yourself" is the right answer).
 */
export function sshConfigHostPattern(alias: string): string | null {
  const a = alias.trim()
  if (!isEnrollableAlias(a)) return null
  const at = a.lastIndexOf('@')
  const hostPart = at >= 0 ? a.slice(at + 1) : a
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostPart) ? hostPart : null
}

/**
 * The block that makes plain `ssh <alias>` offer `keyPath`, or null.
 *
 * `IdentityFile` ACCUMULATES across matching blocks — it is one of the few
 * keywords where ssh does not stop at the first value — so a block appended
 * at the end adds this key to whatever the user's config already offers and
 * overrides nothing. That is what makes appending safe where editing would
 * not be.
 *
 * The path is double-quoted (a home folder can hold a space) and refused if it
 * holds a `"`, a newline or a `%` — ssh expands `%d`, `%u` and friends inside
 * `IdentityFile`, so a literal `%` would silently name another file.
 */
export function buildIdentityBlock(alias: string, keyPath: string): string | null {
  const pattern = sshConfigHostPattern(alias)
  if (!pattern) return null
  if (!keyPath || /["%\r\n]/.test(keyPath)) return null
  return [
    `# Added by Stoke when it set up key login for ${alias.trim()}.`,
    `Host ${pattern}`,
    `  IdentityFile "${keyPath}"`,
    ''
  ].join('\n')
}

/**
 * `existing` with `block` after it, and nothing before it changed.
 *
 * Append-only by construction: the result always starts with `existing`
 * byte for byte (`verify:ssh-enroll` asserts exactly that), a missing final
 * newline is supplied rather than letting the block's `Host` line join the
 * user's last line, and one blank line separates the two so the block reads
 * as its own.
 */
export function appendIdentityBlock(existing: string, block: string): string {
  if (!existing) return block
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const body = eol === '\r\n' ? block.replace(/\n/g, '\r\n') : block
  const sep = existing.endsWith('\n') ? eol : `${eol}${eol}`
  return `${existing}${sep}${body}`
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
