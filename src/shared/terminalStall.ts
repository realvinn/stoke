/**
 * Is this terminal stuck, and whose fault is it — the program's, or Stoke's?
 *
 * The owner, 2026-10-27: "sometimes I do see that stoke freezes. I can't tell if
 * it's a terminal issue … it should say like, terminal's loading or something …
 * just so we know that it isn't stoke that's frozen". And on 2026-10-28: "stoke
 * freezes it's terminal I think". So a tab terminal (TerminalView) puts a grey
 * scrim over itself in exactly three cases, decided here and nowhere else:
 *
 * - **starting**: the pty has printed nothing since it spawned. Shown after
 *   `STARTING_SHOW_MS`, so a fast start never flashes it; past
 *   `STARTING_SLOW_MS` it says so and offers Force restart.
 * - **not-responding**: someone typed a printable key or Enter (`isTypedInput`)
 *   and NOTHING at all has come back for `SILENT_MS`. Claude Code redraws on a
 *   key and animates while it works, so a live one answers; a cooked-mode shell
 *   echoes from the kernel, so it never trips this. Gone the moment any byte
 *   arrives.
 * - **stoke-busy**: the same silence, but Stoke's own main process did not
 *   answer a ping inside `PING_DEADLINE_MS`. Pty output reaches the renderer
 *   through main, so a stalled main silences EVERY terminal, and blaming the
 *   program would be the lie this whole feature exists to stop telling.
 *   (diagnosticsLog.ts writes main's stalls to the freeze log, gotcha 160.)
 *
 * Pure — the clock is an argument and every effect (the ping, the probe, a
 * timer) is something the caller is TOLD to do — so verify:terminal-stall runs
 * every state on a fake clock. TerminalStallOverlay.tsx's `useTerminalStall`
 * is the only caller.
 *
 * What does NOT count, each one a false alarm the rule has to rule out:
 *
 * - **A key a live program ignores.** "A live claude always outputs" is not
 *   quite true: Enter on an empty prompt, or a letter typed at a permission
 *   dialog, changes nothing on screen, and an Ink renderer writes nothing for a
 *   frame that did not change. So before saying "isn't responding" the program
 *   is ASKED, when it can be: a program that has turned on DEC mode 2031 (Claude
 *   Code, for as long as it holds the terminal) re-runs its OSC 11 query when
 *   told the colour scheme changed (`CSI ? 997 ; 1|2 n`, gotcha 42) — a byte of
 *   output from anything alive, and the reply xterm sends back is a terminal
 *   report, not typing. The class sent is the one in force, so nothing repaints.
 *   BUT only some programs answer it. Read out of Claude Code 2.1.312: it turns
 *   2031 on whenever it holds the terminal in raw mode (`themeReports`), and
 *   only `watchSystemTheme` listens for the report, which runs only while its
 *   own theme is `auto`. With a pinned theme (the owner's is `dark`) a probe is
 *   never answered, by a live Claude as much as a hung one. So an unanswered
 *   probe is evidence only from a program that has answered one before
 *   (`probeAnswers`, set by an OSC 11 query arriving while a probe is out).
 *   Any other program, including one that cannot be asked at all (no 2031),
 *   needs `UNPROBED_MIN_INPUTS` keystrokes in a row with nothing back, and
 *   among them both a character AND an Enter (`typedParts`): a live Claude
 *   echoes a character at its prompt and answers an Enter at a dialog, so only
 *   both together owe something back. Enter tapped on an empty prompt, or
 *   letters typed at a permission dialog, never raise it. A pager, an editor
 *   or a dialog that ignores one key is not hung either.
 * - **A password prompt.** ssh, sudo, gpg and git's credential helper turn
 *   echo off, so typing prints nothing. While the last line on screen looks like
 *   such a prompt (`looksLikeSecretPrompt`, a looser cousin of gotcha 75's
 *   `detectSshPasswordPrompt`: missing a prompt costs a false alarm, matching a
 *   non-prompt only costs a missed one) no keystroke counts.
 * - **Anything xterm sends that a person did not type**: mouse reports (SGR and
 *   the X10 form, whose three payload bytes are printable), focus in/out,
 *   bracketed-paste markers, device-attribute and cursor-position replies, OSC
 *   colour answers, DCS replies, arrows and function keys. A resize is not input
 *   at all (it never reaches `onData`).
 * - **Keep waiting**: hidden until the next keystroke, which starts the clock
 *   again rather than bringing the scrim straight back.
 */

import { cliFor, cliIdOf } from './codingClis.ts'

/** No scrim for a start faster than this: no flash. */
export const STARTING_SHOW_MS = 300
/** A start this slow says "It hasn't printed anything yet" and offers Force restart. */
export const STARTING_SLOW_MS = 20_000
/** Typed, and nothing at all back for this long: worth asking why. */
export const SILENT_MS = 5_000
/** Main must answer a ping inside this, or it is Stoke that is busy. */
export const PING_DEADLINE_MS = 1_000
/** How long a probed program has to say anything before it is "not responding". */
export const PROBE_WAIT_MS = 2_000
/** While the scrim is up, ask main again this often: a stall that starts later is Stoke's. */
export const RECHECK_MS = 5_000
/** Keystrokes in a row with nothing back, for a program that cannot be probed. */
export const UNPROBED_MIN_INPUTS = 3
/** How much recent output is kept to read the last line from. */
export const TAIL_CHARS = 1024

export type StallView =
  | { kind: 'none' }
  | { kind: 'starting'; slow: boolean }
  | { kind: 'not-responding' }
  | { kind: 'stoke-busy' }

export const NO_STALL: StallView = { kind: 'none' }

/** The one thing the caller should do now. */
export type StallAction = 'ping' | 'probe'

export interface StallState {
  /** When the pty was attached here (its spawn, for a fresh tab). */
  spawnedAt: number
  /** The last output byte, or null while there has been none. */
  outputAt: number | null
  exited: boolean
  /** The first counted keystroke since the last output: the episode's start. */
  inputAt: number | null
  /** Counted keystrokes (onData calls) since the last output. */
  inputs: number
  /** Among them, a printable character, and an Enter (`typedParts`). */
  typedChar: boolean
  typedEnter: boolean
  /** Keep waiting was pressed: nothing shows until the next keystroke. */
  dismissed: boolean
  /** The last `TAIL_CHARS` of output, raw: read for a password prompt only when a key is typed. */
  tail: string
  /** DEC mode 2031 is on, so the program may answer a colour-scheme report: it can be probed. */
  reportsScheme: boolean
  /**
   * Since it turned 2031 on, the program has answered a probe (an OSC 11 query
   * while one was out). Only then does an unanswered probe mean anything.
   */
  probeAnswers: boolean
  pingSeq: number
  /** The ping in flight, if any: at most one. */
  pingOut: { seq: number; at: number } | null
  /** When the last ping answered INSIDE the deadline was sent. */
  okAt: number | null
  /** When the last ping that missed the deadline was sent. */
  lateAt: number | null
  /** When this episode's probe was sent, or null. */
  probeAt: number | null
}

export interface StallVerdict {
  view: StallView
  act: StallAction | null
  /** When to look again if nothing else happens first, or null for "only on an event". */
  nextAt: number | null
}

export function newStall(now: number): StallState {
  return {
    spawnedAt: now,
    outputAt: null,
    exited: false,
    inputAt: null,
    inputs: 0,
    typedChar: false,
    typedEnter: false,
    dismissed: false,
    tail: '',
    reportsScheme: false,
    probeAnswers: false,
    pingSeq: 0,
    pingOut: null,
    okAt: null,
    lateAt: null,
    probeAt: null
  }
}

/* ------------------------------------------------------------ classifiers */

/** OSC, DCS, SOS, PM and APC strings, ended by BEL or ST. */
const STRING_SEQ = /\x1b[P\]X^_][\s\S]*?(?:\x07|\x1b\\)/g
/** One CSI sequence: parameters, intermediates, final byte. */
const CSI_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]/g

/**
 * Whether a chunk xterm handed to `onData` holds something a person TYPED that
 * a live program would answer: a printable character, or Enter.
 *
 * Everything else is stripped first. The X10 mouse report goes before the CSI
 * rule, because `ESC [ M` alone is a complete CSI and would leave its three
 * payload bytes — printable characters — behind to count as typing
 * (`looksTyped` in lib/tabs.ts has exactly that hole; it errs the safe way for
 * its own job). Alt+key (`ESC` + a character) is a chord, not typing, and an
 * arrow or a function key is a cursor move a program may well ignore.
 */
export function isTypedInput(data: string): boolean {
  const t = typedParts(data)
  return t.char || t.enter
}

/** What `isTypedInput` found: a printable character, an Enter, or both. */
export function typedParts(data: string): { char: boolean; enter: boolean } {
  if (!data) return { char: false, enter: false }
  const rest = data
    .replace(STRING_SEQ, '')
    // X10/normal mouse: ESC [ M and three raw bytes.
    .replace(/\x1b\[M[\s\S]{3}/g, '')
    // SGR mouse, urxvt mouse, focus in/out, bracketed-paste markers, DA/CPR/DECRPM replies, keys.
    .replace(CSI_SEQ, '')
    // SS3: application-mode arrows and F1-F4.
    .replace(/\x1bO[\s\S]?/g, '')
    // Alt+key, and anything else that starts with ESC.
    .replace(/\x1b[\s\S]?/g, '')
  return { char: /[^\x00-\x1f\x7f]/.test(rest), enter: rest.includes('\r') }
}

/** A word that names a secret someone is about to type with echo off. */
const SECRET_WORD =
  /pass(?:word|phrase|code)?\b|passwd|\bpin\b|\btoken\b|\bsecret\b|\botp\b|one[- ]time|verification code|security code|\b2fa\b|two[- ]factor|authenticat(?:ion|or) code/i

/**
 * Whether the last line on screen looks like a prompt for a secret, which a
 * program reads with echo off — so typing into it prints nothing, by design.
 *
 * Gotcha 75's detector (`detectSshPasswordPrompt`) is deliberately narrow: it
 * OFFERS something, so a wrong match is a dialog over a sudo password. This one
 * only WITHHOLDS a scrim, so it is deliberately loose — `[sudo] password for v:`,
 * git's `Password for 'https://…':`, `Enter passphrase for key …:`, `Enter PIN`,
 * `Verification code:` all count. The line is the last one with anything on it,
 * after escapes are stripped and a cursor POSITION is read as a line end:
 * ConPTY repaints a resized screen row by row and parks the cursor after the
 * prompt with a CUP (gotcha 75's 2026-10-03 note), which would otherwise leave
 * the "current" line empty.
 */
export function looksLikeSecretPrompt(tail: string): boolean {
  if (!tail) return false
  const text = tail
    .replace(STRING_SEQ, '')
    .replace(/\x1b\[[0-9;?]*[Hf]/g, '\n')
    .replace(CSI_SEQ, '')
    .replace(/\x1b[\s\S]?/g, '')
  const lines = text.split(/\r\n|\r|\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/[\x00-\x1f\x7f]/g, '').trim()
    if (!line) continue
    if (line.length > 200 || !/[:?]$/.test(line)) return false
    return SECRET_WORD.test(line)
  }
  return false
}

/**
 * Mode 2031 after this chunk: the last of `CSI ? 2031 h` / `l` in it wins, and
 * a chunk with neither leaves it as it was. The same substring rule as
 * TerminalView's theme nudge (gotcha 42), which is wrong only in the safe
 * direction: a missed `h` costs a probe, a missed `l` a report a shell ignores.
 */
/** What a program re-reading the background asks: OSC 11 with `?` (gotcha 42). Claude Code's answer to the probe. */
const OSC11_QUERY = '\x1b]11;?'

function schemeReports(was: boolean, data: string): boolean {
  const on = data.lastIndexOf('\x1b[?2031h')
  const off = data.lastIndexOf('\x1b[?2031l')
  if (on < 0 && off < 0) return was
  return on > off
}

/* ----------------------------------------------------------------- events */

export function stallOutput(s: StallState, data: string, now: number): StallState {
  if (!data) return s
  const tail = (s.tail + data).slice(-TAIL_CHARS)
  const reportsScheme = schemeReports(s.reportsScheme, data)
  // Learned per program: a 2031 turned on afresh (a new program, or Claude back
  // from a shell escape) has answered nothing yet, and one turned off is gone.
  const probeAnswers =
    reportsScheme && ((s.reportsScheme && s.probeAnswers) || (s.probeAt !== null && data.includes(OSC11_QUERY)))
  return {
    ...s,
    outputAt: now,
    // Any byte answers the episode, and ends Keep waiting's hold with it.
    inputAt: null,
    inputs: 0,
    typedChar: false,
    typedEnter: false,
    dismissed: false,
    probeAt: null,
    tail,
    reportsScheme,
    probeAnswers
  }
}

export function stallInput(s: StallState, data: string, now: number): StallState {
  const t = typedParts(data)
  if (s.exited || !(t.char || t.enter)) return s
  // A secret prompt reads with echo off: what is typed there owes nothing back.
  // Read here, per keystroke, never per output chunk: output is the hot path.
  if (looksLikeSecretPrompt(s.tail)) return s
  // The first keystroke after Keep waiting starts the clock again.
  if (s.inputAt === null || s.dismissed) {
    return { ...s, inputAt: now, inputs: 1, typedChar: t.char, typedEnter: t.enter, dismissed: false, probeAt: null }
  }
  return { ...s, inputs: s.inputs + 1, typedChar: s.typedChar || t.char, typedEnter: s.typedEnter || t.enter }
}

export function stallExit(s: StallState): StallState {
  return s.exited ? s : { ...s, exited: true }
}

/** Keep waiting: hidden until the next keystroke. */
export function stallKeepWaiting(s: StallState): StallState {
  return { ...s, dismissed: true }
}

export function stallPingSent(s: StallState, now: number): { state: StallState; seq: number } {
  const seq = s.pingSeq + 1
  return { state: { ...s, pingSeq: seq, pingOut: { seq, at: now } }, seq }
}

/**
 * Main answered ping `seq` (a rejected invoke counts: main's loop ran to
 * reject it). An answer for any other ping is stale and changes nothing.
 */
export function stallPingAnswered(s: StallState, seq: number, now: number): StallState {
  if (!s.pingOut || s.pingOut.seq !== seq) return s
  const at = s.pingOut.at
  return now - at <= PING_DEADLINE_MS
    ? { ...s, pingOut: null, okAt: at }
    : { ...s, pingOut: null, lateAt: at }
}

export function stallProbeSent(s: StallState, now: number): StallState {
  return { ...s, probeAt: now }
}

/* ---------------------------------------------------------------- verdict */

type MainReading = { verdict: 'ok' | 'late' | 'unknown'; ping: boolean; nextAt: number | null }

/**
 * What main's pings say about the time from `since` on.
 *
 * A ping still unanswered past its deadline means main is busy NOW, whenever it
 * was sent — and another is never sent beside it. Otherwise the newest answered
 * ping sent at or after `since` decides: in time is `ok` (asked again every
 * `RECHECK_MS`), late is `late` (asked again at once: a late answer is main
 * waking up, and its queued pty bytes may be a moment behind it, so the next
 * answer is the one that counts). Nothing yet is `unknown`: ask.
 */
function mainReading(s: StallState, now: number, since: number): MainReading {
  const out = s.pingOut
  if (out && now - out.at > PING_DEADLINE_MS) return { verdict: 'late', ping: false, nextAt: null }
  const ok = s.okAt !== null && s.okAt >= since ? s.okAt : null
  const late = s.lateAt !== null && s.lateAt >= since ? s.lateAt : null
  const pendingAt = out ? out.at + PING_DEADLINE_MS + 1 : null
  if (late !== null && (ok === null || late > ok)) return { verdict: 'late', ping: !out, nextAt: pendingAt }
  if (ok !== null) {
    const recheckAt = ok + RECHECK_MS
    return { verdict: 'ok', ping: !out && now >= recheckAt, nextAt: out ? pendingAt : recheckAt }
  }
  return { verdict: 'unknown', ping: !out, nextAt: pendingAt }
}

const NONE: StallView = NO_STALL

function verdict(view: StallView, act: StallAction | null, nextAt: number | null): StallVerdict {
  return { view, act, nextAt }
}

/** Which scrim, if any, what to do, and when to look again. */
export function stallVerdict(s: StallState, now: number): StallVerdict {
  if (s.exited) return verdict(NONE, null, null)

  if (s.outputAt === null) {
    const age = now - s.spawnedAt
    if (age < STARTING_SHOW_MS) return verdict(NONE, null, s.spawnedAt + STARTING_SHOW_MS)
    if (age < STARTING_SLOW_MS) return verdict({ kind: 'starting', slow: false }, null, s.spawnedAt + STARTING_SLOW_MS)
    // Slow: before offering Force restart, make sure it is not Stoke that is slow.
    const m = mainReading(s, now, s.spawnedAt + STARTING_SLOW_MS)
    const act = m.ping ? 'ping' : null
    if (m.verdict === 'late') return verdict({ kind: 'stoke-busy' }, act, m.nextAt)
    return verdict({ kind: 'starting', slow: m.verdict === 'ok' }, act, m.nextAt)
  }

  if (s.inputAt === null || s.dismissed) return verdict(NONE, null, null)
  const since = s.inputAt + SILENT_MS
  if (now < since) return verdict(NONE, null, since)

  const m = mainReading(s, now, since)
  if (m.verdict === 'late') return verdict({ kind: 'stoke-busy' }, m.ping ? 'ping' : null, m.nextAt)
  if (m.verdict === 'unknown') return verdict(NONE, m.ping ? 'ping' : null, m.nextAt)

  // Main answers: the silence is the program's. Ask it, when it can be asked.
  if (s.reportsScheme) {
    if (s.probeAt === null || s.probeAt < since) return verdict(NONE, 'probe', now + PROBE_WAIT_MS)
    const probeDue = s.probeAt + PROBE_WAIT_MS
    if (now < probeDue) return verdict(NONE, null, probeDue)
  }
  // An unanswered probe is proof only from a program that answers probes (a
  // Claude Code on a pinned theme never does). Anything else needs the run of
  // ignored keys; the next keystroke looks again.
  if (!(s.reportsScheme && s.probeAnswers) && !(s.inputs >= UNPROBED_MIN_INPUTS && s.typedChar && s.typedEnter)) {
    return verdict(NONE, null, null)
  }
  return verdict({ kind: 'not-responding' }, m.ping ? 'ping' : null, m.nextAt)
}

export function sameStallView(a: StallView, b: StallView): boolean {
  return a.kind === b.kind && (a.kind !== 'starting' || b.kind !== 'starting' || a.slow === b.slow)
}

/* ------------------------------------------------------------------- copy */

/** The fields of a tab the words and the restart route read. */
export interface StallTab {
  cliId?: string
  hostId: string | null
  installing?: readonly string[]
  enrollHostId?: string
  accountLogin?: string
  private?: boolean
  /** A kept SSH session's name (gotcha 126): a reconnect reattaches it, losing nothing there. */
  remoteSession?: string
}

export interface StallText {
  title: string
  detail: string | null
  /** Force restart is offered. */
  canRestart: boolean
  /** Keep waiting is offered. */
  canWait: boolean
  /** The inline confirm's question. */
  confirm: string
  /** The confirm's button. */
  confirmLabel: string
  /** While the restart runs. */
  restarting: string
}

/**
 * The words for a scrim. `hostLabel` is the SSH host's label (or alias) for a
 * tab that runs on another machine, else null.
 */
export function stallText(view: StallView, tab: StallTab, hostLabel: string | null): StallText {
  const remote = tab.hostId !== null || !!tab.enrollHostId
  const host = hostLabel || 'the machine'
  const name = tab.installing?.length ? 'the installer' : cliFor(cliIdOf(tab.cliId)).label
  const Name = name.charAt(0).toUpperCase() + name.slice(1)
  const confirm = tab.private
    ? 'Restart this private chat? It is deleted, and a new one starts.'
    : remote && tab.remoteSession && !tab.enrollHostId
      ? `Reconnect to ${host}? The session there keeps running.`
      : remote
        ? `Reconnect to ${host}? Anything it hasn't saved is lost.`
        : `Restart ${name}? Anything it hasn't saved is lost.`
  const base = {
    confirm,
    confirmLabel: remote ? 'Reconnect' : 'Restart',
    restarting: remote ? `Reconnecting to ${host}…` : `Restarting ${name}…`
  }
  switch (view.kind) {
    case 'starting':
      return {
        ...base,
        title: remote ? `Connecting to ${host}…` : `Starting ${name}…`,
        detail: view.slow ? "It hasn't printed anything yet." : null,
        canRestart: view.slow,
        canWait: false
      }
    case 'not-responding':
      return {
        ...base,
        title: remote ? `${host} isn't responding` : `${Name} isn't responding`,
        detail: remote
          ? 'Nothing has come back over the connection since you typed. Stoke itself is fine.'
          : 'Nothing has come back since you typed. Stoke itself is fine.',
        canRestart: true,
        canWait: true
      }
    case 'stoke-busy':
      return {
        ...base,
        title: 'Stoke is busy',
        detail: "Stoke's own process is not answering, so output cannot reach this terminal yet. It usually catches up by itself.",
        canRestart: false,
        canWait: false
      }
    case 'none':
      return { ...base, title: '', detail: null, canRestart: false, canWait: false }
  }
}

/**
 * How a forced restart brings the tab back, once its process tree is gone.
 *
 * `relaunch`: the relaunch pill's own path (App's `relaunchTab`): the same
 * agent, the same session resumed (main decides `--resume` or `--session-id`
 * against the disk, gotcha 81), in place. `start-again`: everything that has no
 * session of its own to resume here takes its "Start again" — an SSH tab
 * reconnects (a kept one reattaches its shell, gotcha 126), an install, a key
 * enrollment or a sign-in runs again, and a private chat, which kept nothing,
 * starts a new one (its old folder goes with its process, gotcha 148).
 */
export function forceRestartRoute(tab: StallTab): 'relaunch' | 'start-again' {
  if (tab.hostId || tab.private || tab.installing?.length || tab.enrollHostId || tab.accountLogin) return 'start-again'
  return 'relaunch'
}

/**
 * The colour-scheme report a probe sends: the class in force, so the program
 * re-reads the same answer and nothing repaints (gotcha 42).
 */
export function schemeProbe(light: boolean): string {
  return light ? '\x1b[?997;2n' : '\x1b[?997;1n'
}
