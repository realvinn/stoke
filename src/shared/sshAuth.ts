/*
 * Recognising that a remote is asking for a PASSWORD, and deciding whether to
 * offer the user a key.
 *
 * Everything here is pure and imports nothing, so `verify:ssh-enroll` can
 * replay a scripted byte stream and enumerate the whole decision table with no
 * host, no network and no PTY. That is the entire reason the module exists
 * separately from `src/main/ssh.ts`: the impure half is a few lines in
 * `pty.ts` and the key/config/probe work in `sshEnroll.ts`, and neither is
 * where the detection bugs live.
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
  /** ConPTY only: an escape sequence cut off at the end of the last chunk. */
  pending?: string
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

/*
 * ------------------------------------------------------------ ConPTY
 *
 * On Windows the escape rule above cannot work, and not because ssh changes:
 * node-pty runs every session under ConPTY, which does not pass the child's
 * bytes through. It keeps its own screen buffer and RE-RENDERS it as VT — so
 * the very first frame, before ssh has printed a character, already carries
 * `CSI ?25l`, `CSI 2J`, `CSI H`, an `OSC 0` window title naming ssh.exe, and on
 * current builds `CSI ?9001h CSI ?1004h` (ConPTY asking its host for
 * win32-input-mode and focus events). Under the POSIX rule that first frame
 * closes the window for good and no Windows prompt is ever seen.
 *
 * So on ConPTY the stream is scrubbed first (`conptyScrub`): OSC strings and
 * CSI sequences are removed, and only the handful of DECSETs that mean "a
 * program on the far side has started drawing" still close the window —
 * alternate screen, mouse tracking, bracketed paste. That keeps gotcha 75's
 * rule (something painting ends detection) with a definition of "painting"
 * that ConPTY's own furniture does not meet. `?1004h` and `?9001h` are
 * deliberately NOT closers: ConPTY emits them itself.
 *
 * UNVERIFIED on a real Windows machine: the stream shape is taken from what
 * ConPTY is documented and reported to emit, not measured here (no Windows run
 * in this round). If ConPTY turns out to emit `?2004h` on its own, detection on
 * Windows is dead again — a false negative, the safe direction — and the
 * "Set up key login" button in Settings still works without it.
 */

/** DECSET modes whose enabling means a far-side program is drawing. */
const PAINTING_MODES = new Set([
  '47',
  '1047',
  '1049', // alternate screen: tmux, byobu, vim, less
  '1000',
  '1002',
  '1003',
  '1005',
  '1006',
  '1015', // mouse tracking and its encodings
  '2004' // bracketed paste: bash 5.1+ and zsh 5.1+ at their first prompt, claude
])

/** One complete CSI sequence: parameters, intermediates, final byte. */
const CSI_RE = /\u001b\[([0-?]*)[ -/]*[@-~]/g
/** One complete OSC string, terminated by BEL or ST. */
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
/** Any other complete escape: charset designation, keypad mode, RI, DECSC… — never `[` or `]`. */
const ESC_OTHER_RE = /\u001b(?:[()*+\-./][ -~]|[0-Z\\^-~])/g
/**
 * An escape sequence split across two chunks is held for the next one, up to
 * this many characters. Longer than any real CSI; an OSC title longer than it
 * is dropped rather than held forever.
 */
const PENDING_CAP = 256

/**
 * A ConPTY chunk as the text ssh wrote, whether it enabled a mode that only a
 * far-side program would, and any escape sequence cut off at its end.
 *
 * Pure, so `verify:ssh-enroll` can replay a ConPTY-shaped stream on a Mac.
 * For the offer, cursor moves are dropped rather than turned into spaces or
 * newlines: a guess at layout that put a line break AFTER a prompt would hide
 * it, and one that joined a banner line to the prompt below it only costs a
 * missed offer. The login watch asks for `cursorBreaks`: a cursor POSITION
 * (CUP/HVP) ends the line — `\f` for home, `\v` for anywhere else — because
 * ConPTY repaints the whole screen on a resize, row by row from `CSI H`, and
 * joined to the prompt row the first repainted row read as text after the
 * prompt, which settled the watch.
 */
export function conptyScrub(
  chunk: string,
  opts: { cursorBreaks?: boolean } = {}
): { text: string; painting: boolean; rest: string } {
  let painting = false
  let text = chunk.replace(OSC_RE, '')
  text = text.replace(CSI_RE, (seq, params: string) => {
    if (seq.endsWith('h') && params.startsWith('?')) {
      for (const mode of params.slice(1).split(';')) if (PAINTING_MODES.has(mode)) painting = true
    }
    if (!opts.cursorBreaks || !(seq.endsWith('H') || seq.endsWith('f'))) return ''
    // Home (a repaint starting over) and any other position, told apart for the watch.
    return /^(?:1?(?:;1?)?)$/.test(params) ? '\f' : '\v'
  })
  text = text.replace(ESC_OTHER_RE, '')
  // Whatever escape is left is incomplete: it was cut at the chunk boundary.
  const cut = text.indexOf(ESC)
  if (cut < 0) return { text, painting, rest: '' }
  const rest = text.slice(cut)
  return { text: text.slice(0, cut), painting, rest: rest.length <= PENDING_CAP ? rest : '' }
}

/**
 * ConPTY paints cells, not the bytes ssh wrote, so the trailing space of
 * `user@host's password: ` may never be emitted. Normalise the unterminated
 * line to exactly one trailing space after a colon so the full-match patterns
 * above still apply unchanged.
 */
function conptyTail(tail: string): string {
  const trimmed = tail.replace(/[ \t]+$/, '')
  return trimmed.endsWith(':') ? `${trimmed} ` : trimmed
}

/** Options for one stream: `conpty` on Windows, where node-pty runs ConPTY. */
export interface SshAuthStepOptions {
  conpty?: boolean
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
 *     shuts the detector before any remote program can print the word. Under
 *     ConPTY (`opts.conpty`), only a painting DECSET does — see `conptyScrub`.
 *   - `SSH_AUTH_SCAN_LIMIT` bytes.
 *   - a prompt being reported. ssh asks three times by default
 *     (`numberofpasswordprompts 3`); the user is offered a key once.
 */
export function sshAuthStep(
  state: SshAuthScan,
  chunk: string,
  opts: SshAuthStepOptions = {}
): { next: SshAuthScan; fire: SshAuthPrompt | null } {
  if (!state.open) return { next: state, fire: null }

  const scanned = state.scanned + chunk.length
  let text = chunk
  let pending: string | undefined
  if (opts.conpty) {
    const scrubbed = conptyScrub((state.pending ?? '') + chunk)
    if (scrubbed.painting) {
      const tail = (state.tail + scrubbed.text).slice(-SSH_AUTH_TAIL_BYTES)
      return { next: { scanned, open: false, fired: state.fired, tail }, fire: null }
    }
    text = scrubbed.text
    pending = scrubbed.rest
  }
  const tail = (state.tail + text).slice(-SSH_AUTH_TAIL_BYTES)

  /*
   * Checked before the detector, not after, so a chunk that contains BOTH an
   * escape sequence and something prompt-shaped reports nothing. Within one
   * chunk there is no way to tell which came first without tracking offsets,
   * and the safe answer is the quiet one. (Under ConPTY `text` is already
   * scrubbed, so this only catches an escape the scrub did not recognise.)
   */
  if (text.includes(ESC)) {
    return { next: { scanned, open: false, fired: state.fired, tail }, fire: null }
  }

  const fire = detectSshPasswordPrompt(opts.conpty ? conptyTail(tail) : tail)
  const open = fire === null && scanned < SSH_AUTH_SCAN_LIMIT
  const next: SshAuthScan = { scanned, open, fired: state.fired || fire !== null, tail }
  // Only a ConPTY stream carries a cut-off escape between chunks, and only
  // while it holds one — a POSIX state keeps its original four fields.
  if (pending) next.pending = pending
  return { next, fire }
}

/*
 * ------------------------------------------------ still logging in?
 *
 * After a key is enrolled the renderer reconnects the SSH tabs on that host
 * that are still sitting at ssh's password prompt, so they come back on the
 * key (`PtyManager.awaitingPassword`). "Still sitting at the prompt" is
 * killing a session, so it has to mean the session never got in — and the
 * end of the output cannot say that. A logged-in shell that runs `su` ends in
 * `Password: `; one that runs `ssh other` ends in `v@other's password: `.
 * Both are exact prompt shapes, both follow a successful login, and a check
 * that read only the tail (the first version of this gate did) killed them.
 *
 * So the question is asked of the session's whole history, as a one-way flag:
 * `settled` means the session is past authentication, or can no longer be
 * shown not to be. It is set by the first of:
 *
 *   1. Something painting — an escape byte, or under ConPTY a painting DECSET.
 *      ssh prints no escape before auth (gotcha 75), and bash 5.1+, zsh,
 *      fish, `claude`, tmux and byobu all emit one at once. The same signal
 *      that closes `sshAuthStep`'s window.
 *   2. Output past `SSH_AUTH_SCAN_LIMIT`: authentication is the first breath of
 *      a connection, and past that budget nothing is proved.
 *   3. After the first password prompt, a finished line that is not ssh's own
 *      pre-auth chatter (`isPreAuthLine`): a MOTD, `Last login:`, a shell
 *      prompt with a command on it — for the shells that paint nothing (dash,
 *      ash, bash before 5.1 as on RHEL 8).
 *   4. Enter typed on a line that is not empty, not a password prompt and not
 *      one of ssh's own pre-auth questions (host key, passphrase, PIN). That is
 *      a command typed at a shell, and it catches the session that logged in
 *      by key and so never had a prompt to anchor rule 3 on. Under ConPTY the
 *      line can be blank under a command — a shell that moves its cursor
 *      (Home, PSReadLine's predictions) parks it with a CUP — so Enter on a
 *      blank line a cursor move left under ordinary text counts too (`parked`).
 *
 * The session is waiting for a password only while it is not settled AND a
 * prompt is what it last showed (`atPrompt`): its current line, or — while
 * that line is blank — the last line that had anything on it, unanswered.
 * The second half is ConPTY's: a resize at the prompt (the key offer's own
 * strip takes a row) repaints the screen and parks the cursor with a `CSI H`
 * at the end of the prompt row, so the unfinished line is empty although the
 * prompt is still what is on screen. Measured on Windows 11 (2026-10-03).
 * Every doubtful case settles, because the wrong "yes" kills a session and
 * the wrong "no" leaves one tab asking once more.
 */

/** Questions ssh itself asks before authentication, answered with Enter. */
const SSH_QUESTIONS: RegExp[] = [
  /^Are you sure you want to continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\?/,
  /^Please type 'yes', 'no' or the fingerprint:/,
  /^Enter passphrase for key '/,
  /^Bad passphrase, try again for /,
  /^Enter PIN for /
]

/**
 * Finished lines ssh prints between a password prompt and a login: the newline
 * after the (unechoed) password, the retry notice, and — through a ProxyJump,
 * where the jump host's prompt comes first — the target's host-key exchange.
 * The prompt line itself is recognised separately (`detectSshPasswordPrompt`).
 */
const PRE_AUTH_LINES: RegExp[] = [
  /^Permission denied, please try again\.$/,
  /^The authenticity of host '.*' can't be established\.$/,
  // OpenSSH 10.3 prints `ED25519 key fingerprint is: SHA256:…` (measured);
  // older releases have no colon.
  /^\S+ key fingerprint is:? \S+$/,
  /^This (?:host )?key is not known by any other names\.?$/,
  /^Warning: Permanently added .* to the list of known hosts\.$/,
  ...SSH_QUESTIONS
]

/** Banner rows kept for `SshLoginWatch.preamble`; a longer banner just settles on a repaint. */
const MAX_PREAMBLE = 64

/** One session's authentication, followed for as long as it can be proved. */
export interface SshLoginWatch {
  /** Output bytes seen. */
  seen: number
  /** A password prompt has been seen (or answered). Rule 3 applies from here. */
  prompted: boolean
  /** One-way: past authentication, or not provably still in it. */
  settled: boolean
  /** The current, unterminated line — scrubbed under ConPTY. */
  line: string
  /** The last line with anything on it was a password prompt. Absent means no. */
  atPrompt?: boolean
  /**
   * Enter was pressed at a prompt and ssh has not asked again: the login is in
   * flight, and a repaint of the old prompt row is not a fresh question.
   */
  answered?: boolean
  /** The last line with anything on it was ordinary text: not a prompt, not ssh's own chatter. */
  atText?: boolean
  /**
   * ConPTY: the last line break was a cursor position, not a newline. Enter on
   * the blank line that leaves under text is a command (rule 4) — a shell that
   * repositions its cursor (PSReadLine, Home) leaves exactly that.
   */
  parked?: boolean
  /** Prompt lines finished since the last cursor home (a ConPTY repaint) — or ever, on POSIX. */
  shown?: number
  /**
   * `shown` (+1 for an unfinished prompt line) when Enter answered: only a
   * prompt row past it is ssh asking again, so a repaint of the answered one,
   * even split across chunks, is not.
   */
  answeredAt?: number
  /** ConPTY: lines finished before the first prompt (a Banner), which a repaint finishes again. */
  preamble?: string[]
  /** ConPTY only: an escape sequence cut off at the end of the last chunk. */
  pending?: string
}

export function newSshLoginWatch(): SshLoginWatch {
  return { seen: 0, prompted: false, settled: false, line: '' }
}

function settle(state: SshLoginWatch, seen = state.seen): SshLoginWatch {
  return { seen, prompted: state.prompted, settled: true, line: '' }
}

function promptOn(line: string, opts: SshAuthStepOptions): SshAuthPrompt | null {
  return detectSshPasswordPrompt(opts.conpty ? conptyTail(line) : line)
}

/** A finished line ssh could print before a login — see `PRE_AUTH_LINES`. */
function isPreAuthLine(line: string): boolean {
  const bare = line.replace(/[ \t]+$/, '')
  return bare === '' || PRE_AUTH_LINES.some((re) => re.test(bare))
}

/**
 * Fold one chunk of a session's OUTPUT into its login watch. Pure, and a no-op
 * once settled, so a logged-in session pays one boolean per chunk.
 */
export function sshLoginOutput(state: SshLoginWatch, chunk: string, opts: SshAuthStepOptions = {}): SshLoginWatch {
  if (state.settled) return state
  // Rule 2, judged on what had ALREADY been seen: a prompt in the chunk that
  // crosses the budget is still one, exactly as `sshAuthStep` fires on it.
  if (state.seen >= SSH_AUTH_SCAN_LIMIT) return settle(state)
  const seen = state.seen + chunk.length
  let text = chunk
  let pending = ''
  if (opts.conpty) {
    const scrubbed = conptyScrub((state.pending ?? '') + chunk, { cursorBreaks: true })
    if (scrubbed.painting) return settle(state, seen)
    text = scrubbed.text
    pending = scrubbed.rest
  }
  if (text.includes(ESC)) return settle(state, seen) // rule 1

  let line = state.line
  let prompted = state.prompted
  let atPrompt = state.atPrompt === true
  let answered = state.answered === true
  let atText = state.atText === true
  let shown = state.shown ?? 0
  let parked = state.parked === true
  const answeredAt = state.answeredAt ?? 0
  const preamble = [...(state.preamble ?? [])]
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const cursor = opts.conpty === true && (c === '\f' || c === '\v')
    if (c !== '\r' && c !== '\n' && !cursor) continue
    parked = cursor
    const done = line + text.slice(from, i)
    from = i + 1
    line = ''
    // An answered prompt: the password is not echoed, so the line that the
    // newline finishes is the prompt itself. Set here too, not only at the end
    // of a chunk, so a prompt and what followed it arriving together still
    // count from the prompt on. Under ConPTY it is also a repainted prompt row.
    if (promptOn(done, opts)) {
      prompted = true
      atPrompt = true
      atText = false
      shown++
      if (answered && shown > answeredAt) answered = false // a NEW prompt row: ssh asking again
    } else {
      const bare = done.replace(/[ \t]+$/, '')
      // Rule 3 — but a Banner row a ConPTY repaint finishes again is not news.
      if (prompted && !isPreAuthLine(done) && !preamble.includes(bare)) return settle(state, seen)
      if (opts.conpty && !prompted && bare !== '' && preamble.length < MAX_PREAMBLE) preamble.push(bare)
      if (done.trim() !== '') {
        atPrompt = false
        atText = !isPreAuthLine(done)
      }
    }
    /*
     * A repaint starts counting again from the top — AFTER the row it cut short
     * is counted where it stood. Reset first, and the prompt row being drawn
     * when the repaint began counted as the repaint's own first row: one too
     * many, so a repaint between Enter and ssh's newline read as ssh asking
     * again — a password in flight as "at the prompt" (found in review,
     * 2026-10-03, on the measured repaint).
     */
    if (cursor && c === '\f') shown = 0
  }
  line = (line + text.slice(from)).slice(-SSH_AUTH_TAIL_BYTES)
  if (line.trim() !== '') {
    atPrompt = promptOn(line, opts) !== null
    atText = !atPrompt && !isPreAuthLine(line)
    // A prompt still being written is ssh asking (again) — unless a repaint is redrawing the answered one.
    if (atPrompt) {
      prompted = true
      if (shown + 1 > answeredAt) answered = false
    }
  }
  const next: SshLoginWatch = { seen, prompted, settled: false, line }
  if (atPrompt) next.atPrompt = true
  if (answered) next.answered = true
  if (atText) next.atText = true
  if (parked) next.parked = true
  if (shown) next.shown = shown
  if (answered) next.answeredAt = answeredAt
  if (preamble.length) next.preamble = preamble
  if (pending) next.pending = pending
  return next
}

/**
 * Fold one write of the user's INPUT into the watch (rule 4). Only an Enter
 * counts, and no automatic terminal report (`isTerminalReport`) carries one.
 * Judged against the line as it stands when the key arrives: at a shell prompt
 * that is the prompt and whatever of the command has echoed — never empty.
 */
export function sshLoginInput(state: SshLoginWatch, data: string, opts: SshAuthStepOptions = {}): SshLoginWatch {
  if (state.settled || !/[\r\n]/.test(data)) return state
  const line = state.line.trim()
  // The password, typed at ssh's prompt — on its line, or (ConPTY, after a
  // repaint) with the cursor parked on an empty one. Answered either way:
  // until ssh asks again, a reconnect would kill a login in flight.
  if (state.atPrompt || promptOn(state.line, opts)) {
    const { atPrompt: _gone, ...rest } = state
    const answeredAt = (state.shown ?? 0) + (promptOn(state.line, opts) ? 1 : 0)
    return { ...rest, answered: true, answeredAt }
  }
  // Enter while it connects — unless a cursor move blanked the line under text
  // (ConPTY): that is a command at a shell, rule 4 as if the text were on it.
  if (!line) return state.atText && state.parked ? settle(state) : state
  if (SSH_QUESTIONS.some((re) => re.test(line))) return state // "yes" to a host key, a passphrase
  return settle(state)
}

/**
 * Is this session sitting at ssh's OWN password prompt, never having got in?
 * The gate in front of killing a tab to reconnect it — see the rules above.
 */
export function awaitingSshPassword(state: SshLoginWatch, opts: SshAuthStepOptions = {}): boolean {
  if (state.settled || state.answered) return false
  return state.line.trim() !== '' ? promptOn(state.line, opts) !== null : state.atPrompt === true
}

/** One tab on a host that has just been proven to take a key, as the renderer sees it. */
export interface EnrollReconnectInput {
  /** Its process is still running (else it has exited). */
  running: boolean
  /** Main's `awaitingSshPassword` for it — read only while it runs. */
  awaitingPassword: boolean
  /**
   * Main's login watch at exit (`login.settled`); null/undefined when none ran.
   * `false` means it never got past authentication, or never connected at all
   * (refused, unresolvable, Ctrl+C at the prompt) — nothing ever ran there.
   * `true` proves nothing either way: ssh's own "Connection closed by …" after
   * an unanswered prompt, or its last "Permission denied (…)", settles the
   * watch too (gotcha 126's note).
   */
  loggedIn: boolean | null | undefined
  /** Its exit code once exited (ssh's own failures are 255); null when unknown. */
  exitCode: number | null
  /** The tab the key was added for: in front at the press, or whose prompt raised the offer. */
  isSource: boolean
}

/**
 * After a key is proven, whether a tab on that host is reconnected with it.
 *
 * Only a tab with nothing to lose. A running one only while it still sits at
 * ssh's own prompt (`awaitingSshPassword`). An exited one when nothing ever ran
 * in it (`loggedIn === false`), or when it is the tab the key was for and it
 * did not end cleanly: its ssh gave up at the prompt (exit 255) — which reads
 * as settled — while a session that got in and ended with exit 0 keeps its
 * last screen.
 */
export function reconnectAfterEnroll(t: EnrollReconnectInput): boolean {
  if (t.running) return t.awaitingPassword
  return t.loggedIn === false || (t.isSource && t.exitCode !== 0)
}

/**
 * One output chunk of a remote session, as `pty.ts` folds it: both reducers,
 * and the prompt to offer a key for, if any.
 *
 * The offer is `sshAuthStep`'s, withheld once the login watch has settled. The
 * detector alone reads a window of bytes; a session that logged in by key into
 * a shell that paints nothing (dash, ash, bash before 5.1) and then runs `su`
 * inside that window shows it a PAM `Password: ` exactly like ssh's own. The
 * watch has seen the command typed before it (rule 4) and says so.
 */
export function sshOutputStep(
  scan: SshAuthScan,
  login: SshLoginWatch,
  chunk: string,
  opts: SshAuthStepOptions = {}
): { scan: SshAuthScan; login: SshLoginWatch; offer: SshAuthPrompt | null } {
  const nextLogin = sshLoginOutput(login, chunk, opts)
  const { next, fire } = sshAuthStep(scan, chunk, opts)
  return { scan: next, login: nextLogin, offer: fire && !nextLogin.settled ? fire : null }
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
 *
 * **Wrapped in `sh -c '…'`, because ssh hands this to the remote LOGIN shell,
 * which is whatever the user has.** Unwrapped, the body's `{ …; }` group is a
 * syntax error in fish and the `$(…)` a different thing in csh, so the install
 * failed on exactly the hosts whose owners had chosen a shell. The body holds
 * no single quote of its own (the key is whitelisted and goes in double
 * quotes), so one outer pair survives sh, bash, zsh, dash, fish and tcsh alike.
 * A Windows OpenSSH server, whose login shell is cmd or PowerShell, has no `sh`
 * at all: that fails with ssh's own "not recognized", and the enrollment's
 * failure message says to run `ssh-copy-id` from Git Bash instead.
 */
export function buildRemoteInstallCommand(pubkeyLine: string): string | null {
  const key = pubkeyLine.trim()
  if (!isSafePublicKeyLine(key)) return null
  const body = [
    'cd',
    'umask 077',
    'mkdir -p .ssh',
    '{ [ -z "$(tail -1c .ssh/authorized_keys 2>/dev/null)" ] || echo >> .ssh/authorized_keys; }',
    `printf "%s\\n" "${key}" >> .ssh/authorized_keys`,
    'chmod 700 .ssh',
    'chmod 600 .ssh/authorized_keys',
    // The line `enrollInstallDone` waits for, printed only once every step
    // above has worked — and never spelled out here, so an echo of this command
    // (a `set -x` in a remote rc file) is not mistaken for it.
    'printf "Stoke: key %s.\\n" installed'
  ].join(' && ')
  // Belt and braces: the whitelist already guarantees this, and a body that
  // could close the outer quote must never be sent.
  if (body.includes("'")) return null
  return `sh -c '${body}'`
}

/**
 * What the "Add key" tab prints once the install has run to its end:
 * `ssh-copy-id`'s own report (a key added, or every key already there), or the
 * line `buildRemoteInstallCommand` ends with.
 *
 * Why the tab's output and not only its exit: the enrollment used to finish
 * when that tab's process exited, and nothing else. On the owner's other
 * computer (2026-10-02) the key went on and the process never exited, so the
 * strip sat on "Adding…" with only Not now to press, the tab stayed open and
 * the tab that had asked for the password was never reconnected. This line is
 * a hint to look, never proof — it is text, and the far end can print anything
 * — so all it starts is `finishEnroll`'s probe, which alone decides.
 */
const INSTALL_DONE_RE = /Number of key\(s\) added:\s*\d|All keys were skipped because they already exist|Stoke: key installed\./

/** How much of the install tab's output `enrollTail` keeps: the last lines, escapes and all. */
export const ENROLL_TAIL_CHARS = 4096

/** The install tab's output so far, as much of it as `enrollInstallDone` needs. */
export function enrollTail(tail: string, chunk: string): string {
  const text = tail + chunk
  return text.length > ENROLL_TAIL_CHARS ? text.slice(-ENROLL_TAIL_CHARS) : text
}

/**
 * Whether the install tab has printed that the install ran to its end. Read
 * with every escape sequence taken out (ConPTY repaints as VT from its first
 * frame), over a raw tail rather than chunk by chunk, so a sequence or a line
 * cut across two chunks still reads whole.
 */
export function enrollInstallDone(tail: string): boolean {
  const text = tail.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_OTHER_RE, '')
  return INSTALL_DONE_RE.test(text)
}
