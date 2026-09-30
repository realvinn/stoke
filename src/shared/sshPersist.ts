/*
 * The Stoke-managed remote session: the names and the rules that decide what
 * may be handed to a far machine's shell as part of one.
 *
 * An SSH tab on a host with `persist: 'tmux'` runs inside its own invisible
 * tmux session on a private socket (`tmux -L stoke`), so the shell outlives the
 * connection: a dropped link, a sleeping laptop and a Stoke restart all come
 * back to the same shell. `buildPersistentCommand` (src/main/ssh.ts) builds the
 * command; this file holds the pure halves both processes need — the renderer
 * mints the name and warns in Settings, main refuses anything that fails here.
 *
 * No `node:` import and no browser-only API (gotcha 27): `crypto.getRandomValues`
 * is a global in Node and in Chromium alike.
 */

/**
 * The tmux socket every managed session lives on: `tmux -L stoke`.
 *
 * Private on purpose. A user's own tmux or byobu server is `default`, so
 * nothing Stoke starts, lists or kills can ever touch a session they made
 * themselves, and `-f /dev/null` keeps their `~/.tmux.conf` (a prefix key,
 * `mouse on`, a status bar) out of a session they never see as tmux at all.
 */
export const MANAGED_TMUX_SOCKET = 'stoke'

/**
 * Session names that may be interpolated into a remote shell command.
 *
 * The same rule as `SAFE_ID` (ssh.ts): a whitelist of what a name is made of,
 * never an escape of what would hurt. Stoke mints `stoke-<8 hex>`; the wider
 * pattern admits a name typed on the far machine, and still nothing a shell or
 * tmux would read as syntax — no `.` or `:`, which tmux takes as a window or
 * pane separator in a target, and no leading `-`, which would be an option.
 */
const SAFE_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isSafeRemoteSessionName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_SESSION_NAME.test(name)
}

/** The prefix every name Stoke mints carries, so a `tmux -L stoke ls` reads as Stoke's. */
export const REMOTE_SESSION_PREFIX = 'stoke-'

/**
 * A fresh name for a new tab's managed session: `stoke-` and 8 hex digits.
 *
 * 32 random bits per tab; a clash needs two live sessions on ONE host with the
 * same name, and `new-session -A` would then attach the second tab to the
 * first's shell — visible, not destructive. `bytes` is injectable for tests.
 */
export function mintRemoteSessionName(bytes?: Uint8Array): string {
  const b = bytes ?? globalThis.crypto.getRandomValues(new Uint8Array(4))
  let hex = ''
  for (let i = 0; i < 4; i++) hex += (b[i] ?? 0).toString(16).padStart(2, '0')
  return `${REMOTE_SESSION_PREFIX}${hex}`
}

/**
 * A connect command that may run INSIDE a managed session, or not.
 *
 * `buildPersistentCommand` embeds it in double quotes inside an `sh -c '…'`
 * body that the user's LOGIN shell parses first — bash, zsh, dash, fish or
 * tcsh — and then hands it to tmux, which runs it with `$SHELL -c`. So:
 *
 * - no `'`, which would end the outer single-quoted body in every shell;
 * - no `\`, which fish reads as an escape even inside single quotes;
 * - no `"`, `$` or backtick, which would end the double quotes or expand in sh
 *   instead of in the command's own shell later;
 * - no `!` (tcsh history, even single-quoted), no newline or tab, no control;
 * - not ending in `;`: tmux reads an ARGUMENT that ends in `;` as the end of
 *   one command in its sequence, and would drop the `;` and run the rest;
 * - not starting with `-`, which tmux would parse as an option.
 *
 * Everything else a connect command is actually written with passes: `cd /srv
 * && claude`, `claude --model opus`, `htop`, `~/bin/x | tee log`. Refuse, never
 * escape — anything that fails keeps working with persistence off, and
 * Settings says why (`persistRefusal`).
 */
const PERSISTABLE_COMMAND = /^[A-Za-z0-9 _.,:=@%+~/&|;<>()*?[\]{}#^-]*$/

export function isPersistableCommand(command: string): boolean {
  const c = command.trim()
  if (!c) return true
  if (!PERSISTABLE_COMMAND.test(c)) return false
  if (c.startsWith('-')) return false
  if (c.endsWith(';')) return false
  return true
}

/**
 * Why this host's command cannot run in a kept session, in the user's words,
 * or null when it can. Shown in Settings under the command and thrown by main
 * when a launch is refused, so both say the same thing.
 */
export function persistRefusal(command: string): string | null {
  if (isPersistableCommand(command)) return null
  return (
    'This command cannot run inside a kept session: Stoke passes it through a remote shell ' +
    "untouched, so it may not contain ' \" \\ $ ` or !, start with - or end with ;. " +
    'Simplify it, or turn off "Keep sessions running" for this machine.'
  )
}

/** Does this host keep its tabs' shells running between connections? */
export function hostPersists(host: { persist?: 'tmux' | 'off' } | null | undefined): boolean {
  return host?.persist === 'tmux'
}
