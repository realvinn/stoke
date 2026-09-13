/*
 * Recognising that a remote is asking for a PASSWORD, and deciding whether to
 * offer the user a key.
 *
 * Everything here is pure and imports nothing, so `verify:ssh-enroll` can
 * replay a scripted byte stream and enumerate the whole decision table with no
 * host, no network and no PTY. That is the entire reason the module exists
 * separately from `src/main/ssh.ts`: the impure half is ten lines in `pty.ts`
 * and a spawn in `sshEnroll.ts`, and neither is where the bugs live.
 *
 * No `node:` import and no browser API may appear in this file — it is compiled
 * by both tsconfigs (gotcha 27).
 *
 * The hard part is not finding the word "password". It is refusing the dozen
 * other things that contain it. See gotcha 75.
 */
import type { SshKeyEnroll } from './types'

/**
 * How much of a session's output the detector is allowed to look at.
 *
 * Authentication happens in the first breath of a connection — before the
 * remote command has printed anything — so a budget this size is generous for
 * the real case and still bounds the window in which a later, unrelated
 * "Password:" could be mistaken for one. 16 KB is roughly one screenful of a
 * verbose MOTD plus the whole of ssh's own chatter.
 */
export const SSH_AUTH_SCAN_LIMIT = 16 * 1024

/**
 * How much trailing output is kept between chunks.
 *
 * PTY output routinely arrives split mid-sequence — `pty.ts`'s banner scanner
 * records the same thing — so a prompt can land as `"v@we"` + `"b's password: "`.
 * Anything longer than this cannot be a prompt: ssh's longest is the `Retype`
 * form, and a username and hostname that together exceed 512 bytes are not a
 * case worth carrying unbounded memory for.
 */
export const SSH_AUTH_TAIL_BYTES = 512

// Written as an escape, never as a raw 0x1b byte: a literal control
// character in source survives npm but not every editor, diff or paste.
const ESC = '\u001b'

/** The rolling state of one session's authentication window. */
export interface SshAuthScan {
  /** Bytes seen while the window was open. */
  scanned: number
  /** False once the window has closed, for any reason. Never reopens. */
  open: boolean
  /** True once a prompt has been reported. One offer per session, ever. */
  fired: boolean
  /** The last `SSH_AUTH_TAIL_BYTES` of output, for prompts split across chunks. */
  tail: string
}

/**
 * A recognised password prompt.
 *
 * `user` and `host` come from text the REMOTE sent, so they are display-only.
 * Nothing is ever connected to, or installed on, a destination parsed from
 * here — enrollment uses `SshHost.alias`, the same string the session itself
 * was built from. See gotcha 75 and the security table in the commit message.
 */
export interface SshAuthPrompt {
  kind: 'password' | 'kbdinteractive' | 'change'
  /** '' when the prompt did not name one (bare PAM prompts do not). */
  user: string
  host: string
}

export function newSshAuthScan(): SshAuthScan {
  return { scanned: 0, open: true, fired: false, tail: '' }
}

/*
 * ssh's own prompt strings, taken from the strings in the shipped binary rather
 * than from memory:
 *
 *   %s@%s's password:
 *   Enter %.30s@%.128s's old password:
 *   Enter %.30s@%.128s's new password:
 *   Retype %.30s@%.128s's new password:
 *   Enter passphrase for key '%.100s':          <- NOT one of these
 *
 * Full matches, never substring searches. A substring test is what lets
 * `[sudo] password for v: ` and `Password for 'https://v@github.com': ` through,
 * and both of those are things the user is about to type a DIFFERENT secret into.
 */
const CLIENT_PROMPTS: { re: RegExp; kind: SshAuthPrompt['kind'] }[] = [
  { re: /^(\S+)@(\S+)'s password: $/, kind: 'password' },
  { re: /^Enter (\S+)@(\S+)'s (?:old|new) password: $/, kind: 'change' },
  { re: /^Retype (\S+)@(\S+)'s new password: $/, kind: 'change' }
]

/**
 * Keyboard-interactive, i.e. whatever the server's PAM stack decided to print.
 *
 * Deliberately narrow: an optional `(user@host) ` prefix and nothing else. There
 * is no free-form "for <something>" clause, because that is exactly the shape of
 * `[sudo] password for v:` and of git's `Password for 'https://…':`, and a
 * pattern loose enough to admit a real PAM prompt with a suffix is loose enough
 * to admit those. A host that prompts `Enter your LDAP password: ` is missed —
 * a false negative, which costs one unoffered key rather than one misread
 * secret.
 */
const PAM_PROMPT = /^(?:\((\S+)@(\S+)\) )?[Pp]assword:\s?$/

/**
 * The prompt at the end of `tail`, or null.
 *
 * Five conditions, all required. The first is the one doing the real work: a
 * password prompt is written WITHOUT a trailing newline, because the program is
 * about to block on the tty. So only the text after the last line break can be
 * one — which is what makes a server `Banner` reading "never share your
 * password" structurally unable to match, however it is worded. That banner is
 * pre-auth, inside the window, and sent by a machine Stoke does not control; the
 * tail anchor is the only thing in front of it.
 */
export function detectSshPasswordPrompt(tail: string): SshAuthPrompt | null {
  if (!tail) return null

  // 1. Only the current, unterminated line.
  const nl = Math.max(tail.lastIndexOf('\n'), tail.lastIndexOf('\r'))
  const line = nl >= 0 ? tail.slice(nl + 1) : tail
  if (!line) return null

  // 2. Nothing that paints. ssh's pre-auth output is plain ASCII with no escape
  //    byte in it at all (measured); anything with one is a TUI, not a prompt.
  if (line.includes(ESC)) return null

  // 3. Cheap shape gate before the regexes.
  if (!line.endsWith(':') && !line.endsWith(': ')) return null

  // 4. A passphrase unlocks a key the user ALREADY has. Offering to add a key
  //    there is both wrong and insulting. Checked before the matches rather
  //    than after, because ssh's own wording never says "password" and a future
  //    pattern must not be able to reach past this.
  if (/passphrase/i.test(line)) return null

  for (const { re, kind } of CLIENT_PROMPTS) {
    const m = re.exec(line)
    if (m) return { kind, user: m[1] ?? '', host: m[2] ?? '' }
  }

  const pam = PAM_PROMPT.exec(line)
  if (pam) return { kind: 'kbdinteractive', user: pam[1] ?? '', host: pam[2] ?? '' }

  return null
}

/**
 * Fold one chunk of output into the window.
 *
 * A reducer rather than a handful of `if`s inside `onData` so the suite can
 * replay a stream: the failures worth catching here are all about ORDER — a
 * prompt split across chunks, a second prompt after the first, a prompt that
 * arrives after the remote command has started painting — and none of them is
 * reachable by testing the detector alone.
 *
 * The window closes, permanently, on the first of:
 *   - an escape byte, meaning something is now drawing to the screen. `claude`,
 *     `tmux` and `byobu` all emit one in their first frame, so in practice this
 *     shuts the detector before any remote program can print the word.
 *   - `SSH_AUTH_SCAN_LIMIT` bytes.
 *   - a prompt being reported. ssh asks three times by default
 *     (`numberofpasswordprompts 3`); the user is offered a key once.
 */
export function sshAuthStep(
  state: SshAuthScan,
  chunk: string
): { next: SshAuthScan; fire: SshAuthPrompt | null } {
  if (!state.open) return { next: state, fire: null }

  const scanned = state.scanned + chunk.length
  const tail = (state.tail + chunk).slice(-SSH_AUTH_TAIL_BYTES)

  /*
   * Checked before the detector, not after, so a chunk that contains BOTH an
   * escape sequence and something prompt-shaped reports nothing. Within one
   * chunk there is no way to tell which came first without tracking offsets,
   * and the safe answer is the quiet one.
   */
  if (chunk.includes(ESC)) {
    return { next: { scanned, open: false, fired: state.fired, tail }, fire: null }
  }

  const fire = detectSshPasswordPrompt(tail)
  const open = fire === null && scanned < SSH_AUTH_SCAN_LIMIT
  return { next: { scanned, open, fired: state.fired || fire !== null, tail }, fire }
}

/** What `shouldOfferKey` is deciding over. */
export interface OfferKeyInput {
  /** The app-level setting. */
  setting: SshKeyEnroll
  /** This host's "Never for this host". */
  refused: boolean
  /**
   * Stoke has already installed a key here.
   *
   * Deliberately does NOT suppress the offer: if the host is asking for a
   * password again, the key is not working, and going silent is the one
   * response that leaves the user with no way to find out why. It changes the
   * wording instead.
   */
  enrolled: boolean
  /** An enrollment for this host is already running. */
  inFlight: boolean
}

/**
 * Whether to offer, do it straight away, or stay quiet.
 *
 * Separate from the reducer so the truth table can be enumerated without bytes.
 * `'auto'` still shows the enrollment pane and still needs the user to type
 * their password — it only skips the Yes/No. Nothing here can install anything.
 */
export function shouldOfferKey(input: OfferKeyInput): 'ask' | 'auto' | 'no' {
  if (input.setting === 'off') return 'no'
  if (input.refused) return 'no'
  if (input.inFlight) return 'no'
  return input.setting === 'auto' ? 'auto' : 'ask'
}

/**
 * Whether an alias may be handed to the enrollment tools.
 *
 * Stricter than `isConnectableAlias` in `main/ssh.ts`, on purpose. That one
 * decides what to OFFER in a list, and `buildSshArgs` can cope with a leading
 * dash by emitting `--` before the destination. `ssh-copy-id` has no `--` in
 * its usage line, so an alias that looks like an option would become one. This
 * refuses rather than guesses.
 */
export function isEnrollableAlias(alias: string): boolean {
  if (!alias) return false
  if (alias.startsWith('-')) return false
  if (/\s/.test(alias)) return false
  if (/[*?!]/.test(alias)) return false
  return true
}

/**
 * A public key line safe to embed in a remote shell command.
 *
 * The same rule as `SAFE_ID` in `main/ssh.ts`: a whitelist of what the thing is
 * actually made of, not a blacklist of what would hurt. A base64 key and an
 * ASCII comment need none of the characters that would matter, so anything
 * carrying one is refused outright rather than escaped — `buildRemoteInstall-
 * Command` returns null and the user is told to run `ssh-copy-id` by hand.
 *
 * Only the fallback path embeds the key at all. `ssh-copy-id` sends it on
 * stdin, where it cannot be shell in the first place.
 */
const PUBKEY_LINE =
  /^(?:ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [A-Za-z0-9._@-]+)*$/

export function isSafePublicKeyLine(line: string): boolean {
  return PUBKEY_LINE.test(line)
}

/**
 * The remote `sh` body that appends a public key to `authorized_keys`.
 *
 * Modelled on `ssh-copy-id`'s own `INSTALLKEYS_SH`, because every clause in it
 * is a bug somebody already had: `umask 077` so the file is not created
 * world-readable, the `tail -1c` test because a file whose last line has no
 * newline would otherwise get two keys concatenated onto one line, and the
 * explicit `chmod`s because sshd silently ignores an `authorized_keys` with
 * loose permissions — which presents as "the key did nothing" with no error
 * anywhere.
 *
 * Returns null rather than escaping anything. See `isSafePublicKeyLine`.
 */
export function buildRemoteInstallCommand(pubkeyLine: string): string | null {
  const key = pubkeyLine.trim()
  if (!isSafePublicKeyLine(key)) return null
  return [
    'cd',
    'umask 077',
    'mkdir -p .ssh',
    '{ [ -z "$(tail -1c .ssh/authorized_keys 2>/dev/null)" ] || echo >> .ssh/authorized_keys; }',
    `printf '%s\\n' '${key}' >> .ssh/authorized_keys`,
    'chmod 700 .ssh',
    'chmod 600 .ssh/authorized_keys'
  ].join(' && ')
}
