/*
 * Pure logic behind the phone contract in `src/main/remote/server.ts`.
 *
 * Kept out of that file, which needs `electron` and `ws`, so
 * `scripts/verify-remote.mts` can run every rule here under node's
 * type-stripping with no build step and no live server (gotcha 78: a
 * strip-types suite resolves no aliases, so every import here is relative
 * with a `.ts` extension). No `node:` import (gotcha 27) — this file is
 * compiled by both tsconfigs.
 */

import type { RegistryStatus } from './claudeRegistry.ts'
import type { EffortLevel, PermissionMode, PushSubscriptionRecord, RemotePushSettings } from './types.ts'
import { launchModel, resolveDefaultAgent, type AgentEndpoint } from './agents.ts'
import { accountProblem, accountsOf, DEFAULT_ACCOUNT_ID, resolveLaunchAccount, type AgentAccount } from './accounts.ts'
import { accessRefusalForPhone, type AccessRefusal } from './cfAccess.ts'
import { capsFor, cliFor, isClaudeCode, isCodingCliId, type CodingCliId } from './codingClis.ts'
import { MODEL_OPTIONS, modelLabel } from './launch.ts'
import { isInside, normalizePath, pathKey, type PathRules } from './paths.ts'

/** What the phone shows for a session, distinct from the CLI's own vocabulary. */
export type PhoneSessionStatus = 'waiting' | 'busy' | 'idle' | 'ended' | 'unknown'

/**
 * A session's registry reading, as far as this mapping needs it.
 *
 * `instrumented` is Claude Code specifically — another CLI writes no registry
 * file at all, so nothing about it can be more precise than "unknown" (PX-2's
 * fix, phone contract point 3).
 */
export interface PhoneStatusInput {
  exited: boolean
  instrumented: boolean
  registryStatus: RegistryStatus | null
}

/**
 * Map a live pty onto what the phone draws.
 *
 * `shell` counts as busy, same as the desktop's own reading of the registry
 * (`isBusyStatus`) — it is the CLI's own name for "a command is running", and
 * treating it as idle would show a green dot on a session running a build.
 * `ended` outranks everything: `exited` is checked first, because a session
 * kept in the 10-minute ring (see `ENDED_RETENTION_MS`) may still have a stale
 * registry reading sitting in the map that reported it as busy the instant
 * before it exited.
 */
export function phoneStatusFor(input: PhoneStatusInput): PhoneSessionStatus {
  if (input.exited) return 'ended'
  if (!input.instrumented) return 'unknown'
  switch (input.registryStatus) {
    case 'waiting':
      return 'waiting'
    case 'busy':
    case 'shell':
      return 'busy'
    case 'idle':
      return 'idle'
    default:
      return 'unknown'
  }
}

/** Attention order: what needs you first, what is quietly finished last. */
const STATUS_RANK: Record<PhoneSessionStatus, number> = {
  waiting: 0,
  busy: 1,
  idle: 2,
  unknown: 3,
  ended: 4
}

/**
 * Sort session rows the way the phone list groups them: waiting, then busy,
 * then idle, then a session Stoke cannot read, then ended — ties broken by
 * most recently active first. A stable sort (`Array.prototype.sort` is
 * stable per spec since ES2019), so two rows in the same bucket with the same
 * `lastActivityAt` keep their incoming order rather than jittering on every
 * poll.
 */
export function sortSessionRows<T extends { status: PhoneSessionStatus; lastActivityAt: number | null }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (byStatus !== 0) return byStatus
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  })
}

/**
 * How long a session that exited on its own stays in the list, dimmed, with
 * its history still readable — phone contract point 3 / audit F1.
 *
 * `PtyManager` used to delete a session from its map the instant the child
 * process exited, whether that was a user closing the tab or `claude`
 * crashing on its own — so `/api/sessions` could never report `exited: true`
 * for a real exit, and a phone watching a session that died got nothing: no
 * error, no final output, the row simply gone. A session closed BY the user
 * (the tab's own kill/stop) still disappears at once — that half of the old
 * behaviour was correct and phone contract point 3 keeps it.
 */
export const ENDED_RETENTION_MS = 10 * 60 * 1000

/**
 * Whether an exited session has sat in `PtyManager`'s ring past
 * `ENDED_RETENTION_MS` and is due to be dropped. `endedAt` null is a session
 * still running, which never expires. The one rule `PtyManager.pruneEnded`
 * applies, kept here so `verify:remote` tests the predicate production calls.
 */
export function isEndedExpired(endedAt: number | null, now: number): boolean {
  return endedAt !== null && now - endedAt > ENDED_RETENTION_MS
}

/**
 * How the server frames a phone's `{type:'submit', text}` before writing it
 * to the pty — phone contract point 6 / audit PX-1, CLAUDE.md gotchas 85, 86.
 *
 * The composer used to send the text and a trailing `\r` as ONE write, and
 * the `\r` inside that chunk landed as a newline in Claude Code's input box
 * rather than submitting. The first fix wrapped the text in bracketed-paste
 * markers — and Claude Code then records every phone message as
 * `<pasted_content>` with "nothing you typed around it", and the model
 * declines to act on it (measured 2026-09-19 against 2.1.278: "Your message
 * is entirely pasted text … so I haven't acted on it yet"). So for Claude:
 *
 * - no brackets, ever: the text is TYPED, not pasted;
 * - in chunks of at most `SUBMIT_CHUNK` characters, written a few ms apart
 *   (a single 1287-character write was read as a paste by length alone and
 *   wrapped the same way; 64-character chunks 10ms apart were not);
 * - a newline is `ESC CR` (meta-Enter), which Claude Code's box takes as a
 *   line break — a bare `\n`/`\r` there would submit early;
 * - the `\r` that submits is its own write, after a delay (`pty.ts`).
 *
 * Another agent's CLI gets the same typed chunks for one line; a multi-line
 * text goes to it inside bracketed paste when the pty has DECSET 2004 on (a
 * shell's own way to keep newlines), plain otherwise.
 */
export const SUBMIT_CHUNK = 64

export function submitFrames(
  text: string,
  opts: { bracketedPaste: boolean; claude: boolean }
): { chunks: string[]; enter: string } {
  const multiline = /[\r\n]/.test(text)
  if (opts.claude) {
    return { chunks: typingChunks(text.replace(/\r\n|\r|\n/g, '\u001b\r'), SUBMIT_CHUNK), enter: '\r' }
  }
  if (multiline && opts.bracketedPaste) {
    return { chunks: [`\u001b[200~${text}\u001b[201~`], enter: '\r' }
  }
  return { chunks: typingChunks(text, SUBMIT_CHUNK), enter: '\r' }
}

/**
 * Split text into writes of at most `size` UTF-16 units, never between an
 * `ESC CR` pair (half of one is a bare Escape — which cancels) and never
 * inside a surrogate pair (half an emoji is two replacement characters).
 */
export function typingChunks(text: string, size: number): string[] {
  const chunks: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(text.length, at + size)
    if (end < text.length) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end--
      else if (text[end - 1] === '\u001b' && text[end] === '\r') end--
      if (end <= at) end = Math.min(text.length, at + 2)
    }
    chunks.push(text.slice(at, end))
    at = end
  }
  return chunks
}

/** Waits `ms`; injected so a suite can drive `SubmitQueue` without real time. */
export type Sleep = (ms: number) => Promise<void>

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export interface SubmitTiming {
  /** Between two typed chunks of one submit. */
  chunkGapMs: number
  /** After the last chunk, before the bare `\r` that submits it. */
  enterDelayMs: number
  /** After that `\r`, before the NEXT queued submit starts typing. */
  afterEnterMs: number
}

/**
 * One pty's submits, strictly one after another.
 *
 * `PtyManager.submit` types a message as `submitFrames`' chunks a few ms apart
 * and then its Enter, which takes real time — about 10ms a chunk plus 80ms.
 * It used to start its own `setTimeout` chain per call with nothing between
 * one call and the next, so two submits sent close together (the phone's
 * queued-message flush sends them back to back; so does a double-tap on Send,
 * or End session while a long message is still typing) were written
 * INTERLEAVED: Claude got one garbled turn that was half of each. Measured by
 * the review of qa/phone: a 228-character "apple" prompt and a 32-character
 * "banana" one arrived as a single user turn with the second spliced into the
 * first. Each job here starts only after the previous one's Enter is written.
 *
 * `write` returns false once the session is gone; a job stops there and the
 * queue moves on (every later job then stops at its first write too).
 */
export class SubmitQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly timing: SubmitTiming
  private readonly sleep: Sleep

  constructor(timing: SubmitTiming, sleep: Sleep = realSleep) {
    this.timing = timing
    this.sleep = sleep
  }

  /** Queue one submit; settles once its Enter is written, or it was abandoned. */
  push(frames: { chunks: string[]; enter: string }, write: (data: string) => boolean): Promise<void> {
    const run = async (): Promise<void> => {
      if (frames.chunks.length === 0) return
      for (let i = 0; i < frames.chunks.length; i++) {
        if (i > 0) await this.sleep(this.timing.chunkGapMs)
        if (!write(frames.chunks[i])) return
      }
      await this.sleep(this.timing.enterDelayMs)
      if (!write(frames.enter)) return
      await this.sleep(this.timing.afterEnterMs)
    }
    const job = this.tail.then(run, run)
    this.tail = job.catch(() => {})
    return job
  }
}

/** DECSET 2004 (bracketed paste mode) escape sequences, as they appear in pty output. */
const BRACKETED_PASTE_ON = '\u001b[?2004h'
const BRACKETED_PASTE_OFF = '\u001b[?2004l'

/**
 * Update whether the pty currently has bracketed paste on, from one chunk of
 * its output. The LAST occurrence in the chunk wins, so a chunk carrying both
 * an on and a later off (or vice versa) lands on the one that actually took
 * effect last, not the first one found.
 */
export function trackBracketedPaste(chunk: string, current: boolean): boolean {
  let state = current
  let at = 0
  for (;;) {
    const onAt = chunk.indexOf(BRACKETED_PASTE_ON, at)
    const offAt = chunk.indexOf(BRACKETED_PASTE_OFF, at)
    if (onAt === -1 && offAt === -1) return state
    if (onAt !== -1 && (offAt === -1 || onAt < offAt)) {
      state = true
      at = onAt + BRACKETED_PASTE_ON.length
    } else {
      state = false
      at = offAt + BRACKETED_PASTE_OFF.length
    }
  }
}

/**
 * `POST /api/sessions/:ptyId/answer` — phone contract point 7.
 *
 * A permission prompt's numbered options select on the digit alone in
 * Claude Code's own TUI (an Ink `useInput` shortcut, not a form field), so
 * `1`/`2`/`3` are sent bare, matching how a real keypress reaches the pty.
 * `esc` and `enter` are themselves already a complete keypress. Measured
 * against a real `claude` permission prompt before shipping — if a future
 * CLI version needs a trailing `\r` after the digit, that is a one-line
 * change here, not in the route.
 */
export type AnswerKey = '1' | '2' | '3' | 'esc' | 'enter'

const ANSWER_BYTES: Record<AnswerKey, string> = {
  '1': '1',
  '2': '2',
  '3': '3',
  esc: '\u001b',
  enter: '\r'
}

export function answerBytes(key: AnswerKey): string {
  return ANSWER_BYTES[key]
}

/**
 * Is this xterm `onData` an automatic REPLY the phone's terminal generated,
 * rather than a key somebody pressed?
 *
 * Every attach replays the pty's history into the phone's xterm, and xterm
 * answers every query in it as if it were live: device attributes
 * (`ESC[?1;2c`), the background colour (`ESC]11;rgb:…`), cursor position,
 * mode reports, focus in/out. The old client forwarded all of `onData` to the
 * pty, so opening a session on a phone typed stale answers into Claude — one
 * of them telling it the page's background colour, which Claude Code uses to
 * pick its palette. The desktop's own terminal already answers the live
 * queries; the phone must never answer any.
 *
 * `PtyManager.write` uses it too: a reply is not somebody typing, so it must
 * not make a permission prompt look answered (`answerVerdict`). The desktop's
 * xterm sends focus reports and colour-scheme reports on its own.
 */
export function isTerminalReport(data: string): boolean {
  return (
    /^\u001b\[[?>=]?[\d;]*c$/.test(data) || // primary/secondary/tertiary device attributes
    /^\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)$/.test(data) || // OSC replies (colours, clipboard)
    /^\u001b\[\??\d+;\d+R$/.test(data) || // cursor position report
    /^\u001b\[\??[\d;]*\$y$/.test(data) || // DECRPM mode report
    /^\u001b\[[IO]$/.test(data) || // focus in/out
    /^\u001b\[\??[\d;]*n$/.test(data) || // DSR replies, incl. the colour-scheme report (gotcha 42)
    /^\u001b\[\d+;\d+;\d+t$/.test(data) || // window size reports
    /^\u001bP[\s\S]*\u001b\\$/.test(data) // DCS replies (XTVERSION, DECRQSS)
  )
}

/* ------------------------------------------------------ prompt identity */

/**
 * One permission prompt, as far as the phone's one-tap answer knows it —
 * review finding "stale tap" on PX-12.
 *
 * The answer route used to gate on the registry's `waiting` alone, and the
 * registry is polled once a second: a prompt answered at the desk still read
 * `waiting` for up to a second, so a tap from the list in that window returned
 * 200 and wrote a stray digit into whatever came next (measured: a `2` written
 * 150ms after a desk `1`, status turned busy 46ms after that). The request also
 * named no prompt, so prompt B arriving within one poll of prompt A was
 * answered from a list still showing A's question.
 *
 * `id` is what the phone sends back. `since` is when this prompt was known to
 * be on screen with nothing typed after it: the registry's own
 * `statusUpdatedAt` for a new prompt, or the reading's time when a later pass
 * re-confirms it after some input (below).
 */
export interface PromptTrack extends PromptIdentity {
  id: string
  since: number
}

/**
 * What makes a prompt THIS prompt: the registry's own `waitingFor` and
 * `statusUpdatedAt`, which the CLI moves only when it writes a status
 * (sessionRegistry.ts `sameState`). Never the answer id — `trackPrompt` mints
 * a new one for the same prompt after input, which is right for the answer
 * route and wrong for anything that asks "is this a new prompt?" (`pushFor`).
 */
export interface PromptIdentity {
  waitingFor: string | null
  statusUpdatedAt: number | null
}

/** Whether two readings name the same prompt (`PromptIdentity`). */
export function samePrompt(a: PromptIdentity, b: PromptIdentity): boolean {
  return a.waitingFor === b.waitingFor && a.statusUpdatedAt === b.statusUpdatedAt
}

/**
 * How long after the last pty input a registry reading must have been taken
 * before it can re-confirm a prompt. The file follows the TUI within ~0.1s
 * (claudeRegistry.ts); half a second is margin, not measurement.
 */
export const PROMPT_SETTLE_MS = 500

export interface PromptReading {
  waiting: boolean
  waitingFor: string | null
  statusUpdatedAt: number | null
  /** When the pass that produced this reading started (conservative: the file was read after). */
  readAt: number
}

/**
 * The prompt a pty is showing now, from the last one and a fresh reading.
 *
 * - not waiting: none.
 * - a new waiting state (none before, or `waitingFor`/`statusUpdatedAt`
 *   moved): a new prompt, `since` its own `statusUpdatedAt`.
 * - the same waiting state, but input reached the pty after `since`: whoever
 *   typed may have answered it, so `answerVerdict` refuses it. Once a reading
 *   taken `PROMPT_SETTLE_MS` after that input STILL says waiting, the prompt
 *   on screen is re-confirmed under a new id — otherwise an arrow key pressed
 *   at the desk would leave the phone unable to answer for good.
 */
export function trackPrompt(
  prev: PromptTrack | null,
  reading: PromptReading,
  lastInputAt: number | null
): PromptTrack | null {
  if (!reading.waiting) return null
  const fresh = !prev || !samePrompt(prev, reading)
  let since: number
  if (fresh) since = reading.statusUpdatedAt ?? reading.readAt
  else if (lastInputAt !== null && lastInputAt >= prev.since && reading.readAt >= lastInputAt + PROMPT_SETTLE_MS) {
    since = reading.readAt
  } else return prev
  // Never reuse the previous id: a phone holding it must not match the new one.
  if (prev && since <= prev.since) since = Math.max(reading.readAt, prev.since + 1)
  return {
    id: String(since),
    since,
    waitingFor: reading.waitingFor,
    statusUpdatedAt: reading.statusUpdatedAt
  }
}

export type AnswerVerdict = 'ok' | 'not waiting' | 'stale'

/**
 * Whether `POST /api/sessions/:ptyId/answer` may write. `stale` (409) when the
 * phone named another prompt, named none, or anything was typed into the pty
 * since this prompt was known — including the phone's own previous answer, so
 * a double tap writes one digit, not two.
 */
export function answerVerdict(
  track: PromptTrack | null,
  promptId: unknown,
  lastInputAt: number | null
): AnswerVerdict {
  if (!track) return 'not waiting'
  if (typeof promptId !== 'string' || promptId !== track.id) return 'stale'
  if (lastInputAt !== null && lastInputAt >= track.since) return 'stale'
  return 'ok'
}

/* ------------------------------------------------------- server decisions */

export type ResumeVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; error: string; live?: true; ptyId?: string }

/**
 * Whether `POST /api/sessions` with `resume: true` may start a process.
 *
 * Resume must never quietly become a new conversation (gotcha 92). Main's
 * `resumeOrMint` turns `--resume` on an id with no transcript into
 * `--session-id`, which is right for a desktop relaunch of a tab nobody typed
 * into — and wrong for a phone that pressed "Resume conversation" on a row with
 * a title and twenty messages: it got a 200 and an empty session. So a Claude
 * resume of an id with no transcript is a 404 here, before anything spawns,
 * and a resume that names no valid id at all is a 400 (it used to spawn with
 * `resume` set and no id). `hasTranscript` is null for an agent whose
 * transcripts Stoke cannot look up, which is not checked.
 */
export function resumeVerdict(opts: {
  resume: boolean
  sessionId: string | null
  livePty: string | null
  hasTranscript: boolean | null
}): ResumeVerdict {
  if (!opts.resume) return { ok: true }
  if (!opts.sessionId) return { ok: false, status: 400, error: 'Resume needs a session id.' }
  if (opts.livePty) {
    return { ok: false, status: 409, error: 'That conversation is already open.', live: true, ptyId: opts.livePty }
  }
  if (opts.hasTranscript === false) {
    return { ok: false, status: 404, error: 'No transcript for that session — it cannot be resumed.' }
  }
  return { ok: true }
}

/**
 * Whether the remote server should be (re)started for a settings write —
 * review finding on PX-8.
 *
 * The busy-port error says "Pick a different port", and the settings handler
 * restarted only a RUNNING server when a bound field moved. A server that
 * failed to bind is not running, so changing the port as advised did nothing
 * until Phone access was turned off and on. A failed server with Phone access
 * still on is retried too; one the user turned off is left off.
 */
export interface RemoteBindFields {
  enabled: boolean
  port: number
  bindLan: boolean
  bindTailscale: boolean
  requireAccessHeader: boolean
  /** Whose Access tokens are accepted (gotcha 124): a policy change drops every socket. */
  accessTeamDomain: string
  accessAud: string
  hostname: string
  token: string
}

/**
 * What the server binds or checks: moving one needs a restart to take effect.
 * Every one is a string, number or boolean, so `!==` compares values — an array
 * here would differ by reference after every hydrate and restart the server on
 * each settings write, which is why the AUD is one string and not a list.
 */
const REMOTE_BIND_KEYS = [
  'port',
  'bindLan',
  'bindTailscale',
  'requireAccessHeader',
  'accessTeamDomain',
  'accessAud',
  'hostname',
  'token'
] as const

export function shouldRestartRemote(
  prev: RemoteBindFields,
  next: RemoteBindFields,
  server: { running: boolean; error: string | null } | null
): boolean {
  if (!server) return false
  if (!REMOTE_BIND_KEYS.some((k) => prev[k] !== next[k])) return false
  return server.running || (next.enabled && server.error !== null)
}

/**
 * The key to put in the QR code / connect link.
 *
 * The QR is built from settings while the running server authorises against the
 * token it was STARTED with. If a token change reaches settings without the
 * server picking it up (a restart race — seen on Windows: the server rejected
 * the key its own QR advertised, "This link's key isn't current"), the two
 * diverge and every scan fails. Advertise the RUNNING server's token whenever it
 * has one, so the link can never carry a key the live server will refuse; fall
 * back to settings only when nothing is running (the off-state preview).
 */
export function advertisedRemoteToken(runningToken: string | null, settingsToken: string): string {
  return runningToken || settingsToken
}

/**
 * What the server decided about one request's credentials.
 *
 * Three answers, not a boolean, because the phone must be told WHICH check
 * failed. Both refusals used to be one 401, and the phone reads every 401 as a
 * key problem ("Your key was replaced", "This link's key isn't current") — so a
 * machine that could not fetch its Access keys, held a stale AUD or had a
 * skewed clock sent its owner off to re-scan a key that was fine (gotcha 124).
 * `access` is only ever reached with the right key: the key is checked first.
 */
export type RemoteAuthVerdict =
  | { ok: true }
  | { ok: false; refused: 'key' }
  | { ok: false; refused: 'access'; reason: AccessRefusal }

/**
 * The answer to a refused HTTP request, or null for an authorised one.
 *
 * A wrong or missing key is 401 with the old plain-text body — the phone's
 * `api()` turns a 401 into the Connect screen, which is right for that case. An
 * Access refusal is 403 with a JSON `{error, refused: 'access'}`: `api()`
 * surfaces `error` for any non-401 status, so the list, the Connect check and
 * the session strip each show the machine's own reason instead of a key story.
 * The WebSocket upgrade uses the same status (`refusalStatusLine`).
 */
export function remoteRefusal(
  verdict: RemoteAuthVerdict
): { status: 401 | 403; contentType: string; body: string } | null {
  if (verdict.ok) return null
  if (verdict.refused === 'key') {
    return {
      status: 401,
      contentType: 'text/plain; charset=utf-8',
      body: 'Unauthorized. Open the link from Stoke, which carries the key.'
    }
  }
  return {
    status: 403,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: accessRefusalForPhone(verdict.reason), refused: 'access' })
  }
}

/**
 * The phone's half of `remoteRefusal`: the computer's sentence when an answer
 * is an Access refusal, else null. Kept beside the writer so `verify:remote`
 * holds the round trip — a 401 is never one, and neither is any other 403 (a
 * bypass-mode refusal carries `error` but not `refused`).
 */
export function accessRefusalMessage(status: number | undefined, body: unknown): string | null {
  if (status !== 403 || typeof body !== 'object' || body === null) return null
  const { refused, error } = body as { refused?: unknown; error?: unknown }
  return refused === 'access' && typeof error === 'string' && error !== '' ? error : null
}

/** The raw status line a refused WebSocket handshake gets: 401 for the key, 403 for Access. */
export function refusalStatusLine(verdict: RemoteAuthVerdict): string | null {
  if (verdict.ok) return null
  return verdict.refused === 'key' ? 'HTTP/1.1 401 Unauthorized' : 'HTTP/1.1 403 Forbidden'
}

/**
 * Whether a phone's `?k=` may be stored as the key cookie — review finding on
 * PX-14. Once the shell went public the cookie was built from ANY `k`, so a
 * link with a wrong key (or any page navigating the phone to one) overwrote a
 * working 90-day cookie and logged the phone out. Only the key the request
 * was actually checked against and MATCHED is stored.
 *
 * That includes a request whose key matched and whose Access token this machine
 * then refused. Storing it gives nothing away — the sender already holds that
 * exact key, and every later request still has to pass Access — and withholding
 * it is what made an Access refusal read as a key problem: the shell loaded
 * with no cookie, the next `/api` call carried no key, 401, and the phone said
 * "This link's key isn't current". With the cookie, that call reaches the
 * Access check and gets its 403 and the real reason.
 */
export function mayStoreKeyCookie(queryKey: string | null, verdict: RemoteAuthVerdict): boolean {
  return queryKey !== null && queryKey !== '' && (verdict.ok || verdict.refused === 'access')
}

/**
 * Which HTTP paths the phone contract serves without the bearer key — phone
 * contract point 1.
 *
 * Everything under `/api/` is gated, exactly as today. Everything else is the
 * public shell: `index.html` (and every path the SPA fallback would hand
 * `index.html` to, since none of it embeds session data), `/assets/*`, the
 * manifest and the icons. A WebSocket upgrade is never matched by this — it
 * is gated unconditionally in `handleUpgrade`, by transport rather than path,
 * exactly as before this split existed.
 */
export function isGatedRemotePath(pathname: string): boolean {
  return pathname.startsWith('/api/')
}

/**
 * What the public shell's static handler answers for a path with no file
 * behind it: the SPA shell, or a plain 404.
 *
 * Only a path that names no file (`/`, `/session/x`) is a page and gets the
 * shell. A missing FILE — `/assets/index-<old hash>.js` after an update,
 * `/sw.js` from a build without one — used to get `index.html` with a 200 as
 * well, which a browser then ran as a script, or a service worker cached as
 * the script it asked for, and kept serving. A 404 is the truthful answer, and
 * the one a service worker's install and a module loader both treat as failure.
 */
export function staticMissAnswer(pathname: string): 'shell' | 'not-found' {
  const last = pathname.split('/').pop() ?? ''
  const ext = /\.[A-Za-z0-9]+$/.exec(last)?.[0].toLowerCase() ?? ''
  return ext === '' || ext === '.html' ? 'shell' : 'not-found'
}

/**
 * The `Cache-Control` a public shell file is served with. The bundle's files
 * carry a content hash in their names (vite.remote.config.ts), so an
 * `/assets/` URL names one exact file forever and may be kept; everything
 * else — the shell, the service worker, the manifest, the icons — is revalidated
 * every time, so a Stoke update reaches the phone on its next load.
 */
export function staticCacheControl(pathname: string): string {
  return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
}

/** A machine's hostname, without the local-network suffix mDNS often adds. */
export function stripLocalHostnameSuffix(host: string): string {
  return host.replace(/\.(local|localdomain)$/i, '')
}

/** `/api/host`'s `defaults` — phone contract point 2. */
export interface PhoneHostDefaults {
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  /**
   * The agent the New session sheet starts on: the desktop's default agent
   * (Settings › Agents), resolved against the agents this reply offers
   * so it is always one of them. Added beside the other three rather than
   * renaming anything — the contract's names are load-bearing.
   */
  cli: CodingCliId
}

/**
 * What the phone's New session sheet starts from. Bypass is never offered to
 * the phone, so a desktop default of `bypassPermissions` reads as `default`
 * here; and the default agent falls back the way the launcher's does
 * (`resolveDefaultAgent`) when the stored one is not among `agentIds`.
 */
export function phoneHostDefaults(
  d: { permissionMode: PermissionMode; model: string; effort: EffortLevel },
  defaultCli: CodingCliId,
  agentIds: readonly string[]
): PhoneHostDefaults {
  return {
    permissionMode: d.permissionMode === 'bypassPermissions' ? 'default' : d.permissionMode,
    model: d.model,
    effort: d.effort,
    cli: resolveDefaultAgent(defaultCli, agentIds.filter(isCodingCliId))
  }
}

/* ------------------------------------------- what each agent takes, per launch */

/*
 * The New session sheet's confirm step drew Claude Code's four permission
 * modes, five models and six efforts for EVERY start, and hid them only for an
 * agent other than Claude — so a Codex start showed nothing of the model it
 * would run, and a Claude start offered a list the desktop's launcher had
 * outgrown (no 1M variants). `/api/host` now serves each agent's own choices
 * (`choices`, phone contract point 2), built here from the same facts a launch
 * reads, and `POST /api/sessions` holds a start to them (`phoneLaunchVerdict`).
 */

/** One chip on the confirm step. */
export interface PhoneChoice {
  id: string
  label: string
  /** A line under the group while this one is picked (a permission mode's meaning). */
  hint?: string
  /** Why this one cannot start right now (an account with no key); the chip is drawn disabled. */
  problem?: string
}

/** What one agent takes when the phone starts it (`/api/host` `choices[<agent id>]`). */
export interface PhoneAgentChoices {
  /** Permission modes the phone may offer, bypass never; empty when the agent takes none (`CLI_CAPS`). */
  modes: PhoneChoice[]
  /**
   * The models. For Claude Code the aliases its `--model` accepts; for another
   * agent the ONE model its launch will run (`launchModel`: its endpoint's, or
   * its Default model where Stoke can pass one), which the phone shows and
   * cannot change — it is Settings › Agents' to decide (`modelFixed`).
   */
  models: PhoneChoice[]
  modelFixed: boolean
  /** Effort levels; empty when the agent takes none. */
  efforts: PhoneChoice[]
  /** Default first, then the agent's own accounts (shared/accounts.ts). A picker only when more than one. */
  accounts: PhoneChoice[]
  /** The account a start that names none runs on (`resolveLaunchAccount`). */
  account: string
}

/** Claude Code's permission modes as the phone offers them. Bypass is not here, and never will be. */
export const PHONE_MODES: readonly PhoneChoice[] = [
  { id: 'default', label: 'Ask', hint: 'Asks before each tool use.' },
  { id: 'plan', label: 'Plan', hint: 'Researches and proposes; touches no files.' },
  { id: 'acceptEdits', label: 'Edits', hint: 'File edits apply; other tools still ask.' },
  { id: 'auto', label: 'Auto', hint: 'Decides when to ask by how risky the action is.' }
]

/** `--effort`'s levels, plus Default (no flag). */
export const PHONE_EFFORTS: readonly PhoneChoice[] = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
]

/** What the launch reads, per agent — settings as they are, read per call (gotcha 111). */
export interface PhoneLaunchFacts {
  endpoints: Partial<Record<CodingCliId, AgentEndpoint>>
  accounts: Record<string, AgentAccount>
  defaultAccount: Partial<Record<CodingCliId, string>>
  /** The desktop's default Claude model (`settings.defaults.model`), offered even when it is no alias. */
  defaultModel: string
}

/** One agent's choices. */
export function agentChoicesFor(id: CodingCliId, facts: PhoneLaunchFacts): PhoneAgentChoices {
  const caps = capsFor(id)
  const claude = isClaudeCode(id)
  let models: PhoneChoice[]
  if (claude) {
    models = MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label }))
    const d = facts.defaultModel.trim()
    if (d && !models.some((m) => m.id === d)) models.push({ id: d, label: modelLabel(d) })
  } else {
    const m = launchModel(id, facts.endpoints[id])
    models = [{ id: m, label: m || `Chosen by ${cliFor(id).label}` }]
  }
  const mode = claude ? 'default' : (facts.endpoints[id]?.mode ?? 'default')
  const accounts: PhoneChoice[] = [{ id: DEFAULT_ACCOUNT_ID, label: 'Default' }]
  for (const a of accountsOf(id, facts.accounts)) {
    const problem = accountProblem(a, mode)
    accounts.push(problem ? { id: a.id, label: a.label, problem } : { id: a.id, label: a.label })
  }
  const resolved = resolveLaunchAccount({ cli: id, requested: null, accounts: facts.accounts, defaults: facts.defaultAccount })
  return {
    modes: caps.launchFlags.permissionMode ? PHONE_MODES.map((m) => ({ ...m })) : [],
    models,
    modelFixed: !claude,
    efforts: caps.launchFlags.effort ? PHONE_EFFORTS.map((e) => ({ ...e })) : [],
    accounts,
    account: resolved.ok ? resolved.accountId : DEFAULT_ACCOUNT_ID
  }
}

/**
 * Every offered agent's choices, keyed by id, and always Claude Code's — a
 * start that names no agent (a Resume, an older phone) is Claude's. Ids this
 * build does not know are skipped.
 */
export function phoneAgentChoices(agentIds: readonly string[], facts: PhoneLaunchFacts): Record<string, PhoneAgentChoices> {
  const out: Record<string, PhoneAgentChoices> = {}
  for (const id of ['claude', ...agentIds]) {
    if (isCodingCliId(id) && !out[id]) out[id] = agentChoicesFor(id, facts)
  }
  return out
}

/**
 * A remote machine's start: Claude Code on the far side, run by the host's own
 * command with nothing added (gotcha 19) — so no mode, model, effort or
 * account the phone could pick would reach it.
 */
export function hostChoices(): PhoneAgentChoices {
  return {
    modes: [],
    models: [{ id: '', label: 'The remote machine’s own' }],
    modelFixed: true,
    efforts: [],
    accounts: [{ id: DEFAULT_ACCOUNT_ID, label: 'Default' }],
    account: DEFAULT_ACCOUNT_ID
  }
}

export type PhoneLaunchVerdict =
  | { ok: true; permissionMode: PermissionMode; model: string; effort: EffortLevel; accountId: string | undefined }
  | { ok: false; status: 400; error: string }

/**
 * Whether a phone's start asks only for what this agent takes, and what it runs
 * with. Held in main, from the same choices `/api/host` served — the phone's
 * sheet is a convenience, never the check. `label` names the agent in a refusal.
 *
 * Absent values are the agent's defaults. For an agent that takes no mode or
 * effort, only `default` (or nothing) passes; for one whose model is fixed,
 * only that model (or nothing). An account must be one of this agent's, and
 * one that can start: a key account with no key is refused here with its own
 * sentence instead of a bare 500 from the launch. Bypass is refused before
 * this, with its own 403.
 */
export function phoneLaunchVerdict(
  body: { permissionMode?: unknown; model?: unknown; effort?: unknown; accountId?: unknown } | null,
  choices: PhoneAgentChoices,
  label: string
): PhoneLaunchVerdict {
  const bad = (error: string): PhoneLaunchVerdict => ({ ok: false, status: 400, error })
  const given = (v: unknown): boolean => v !== undefined && v !== null
  const mode = given(body?.permissionMode) ? body?.permissionMode : 'default'
  if (typeof mode !== 'string') return bad('permissionMode must be a string.')
  if (choices.modes.length) {
    if (!choices.modes.some((m) => m.id === mode)) return bad('That permission mode is not one Stoke offers the phone.')
  } else if (mode !== 'default') return bad(`${label} takes no permission mode from Stoke.`)

  const effort = given(body?.effort) ? body?.effort : 'default'
  if (typeof effort !== 'string') return bad('effort must be a string.')
  if (choices.efforts.length) {
    if (!choices.efforts.some((e) => e.id === effort)) return bad('That effort is not one Stoke offers.')
  } else if (effort !== 'default') return bad(`${label} takes no effort level from Stoke.`)

  const model = given(body?.model) ? body?.model : ''
  if (typeof model !== 'string') return bad('model must be a string.')
  let runs = model
  if (choices.modelFixed) {
    const fixed = choices.models[0]?.id ?? ''
    if (model !== '' && model !== fixed) {
      return bad(`${label} runs ${choices.models[0]?.label ?? 'its own model'}, set in Stoke’s Settings › Agents; the phone cannot change it.`)
    }
    // The launch reads the agent's own model from settings; nothing is passed.
    runs = ''
  } else if (!choices.models.some((m) => m.id === model)) return bad('That model is not one Stoke offers.')

  const asked = body?.accountId
  if (given(asked) && typeof asked !== 'string') return bad('accountId must be a string.')
  const accountId = typeof asked === 'string' && asked !== '' ? asked : undefined
  const pick = choices.accounts.find((a) => a.id === (accountId ?? choices.account))
  if (accountId !== undefined && !pick) return bad(`That account is not one of ${label}’s.`)
  if (pick?.problem) return bad(pick.problem)
  return { ok: true, permissionMode: mode as PermissionMode, model: runs, effort: effort as EffortLevel, accountId }
}

/* ----------------------------------------------------------------- Web Push */

/*
 * A phone with the installed shell can be told when a session needs it,
 * without the page open: Web Push (main/remote/push.ts). These are the parts
 * that decide WHEN, WHAT and TO WHERE, pure so `verify:remote` holds them.
 */

/** What one push says. Content-free: a project name and a status word — never a prompt, a line of output or a path. */
export interface PushPayload {
  /** The project, or the remote machine's name (gotcha 18). */
  title: string
  /** "Needs you" or "Finished". */
  body: string
  /** One per session, so a newer notification replaces the older. */
  tag: string
  /** Where a tap opens, inside the shell: `#/s/<ptyId>` or `#/`. */
  url: string
}

export type PushKind = 'needs-you' | 'finished' | 'test'

/**
 * One session's last reading, as Web Push sees it. The prompt is its
 * IDENTITY (`PromptIdentity`), never `PromptTrack.id`: that id is re-minted for
 * the same prompt once input reached the pty and a later reading still says
 * waiting — an arrow key in a permission menu, a wheel scroll (a mouse report
 * is input), a pause while typing an answer — and a push keyed on it sent
 * "Needs you" at high urgency once per pause, for a prompt someone was
 * already answering at the desk.
 */
export interface PushState {
  status: PhoneSessionStatus
  prompt: PromptIdentity | null
}

/** A session's `PushState` from its status and the prompt `trackPrompt` holds for it. */
export function pushStateOf(status: PhoneSessionStatus, track: PromptTrack | null): PushState {
  return {
    status,
    prompt: status === 'waiting' && track ? { waitingFor: track.waitingFor, statusUpdatedAt: track.statusUpdatedAt } : null
  }
}

/**
 * Whether a session's move from `prev` to `next` is worth a push.
 *
 * - First sight (`prev` null) is a baseline, never a push: a server that starts,
 *   or a session it has not seen yet, does not announce what was already so.
 * - Into `waiting` from anything else: it needs you — once.
 * - `waiting` to `waiting`: only when a NEW prompt is on screen — the registry
 *   wrote another `waitingFor` or `statusUpdatedAt` (`samePrompt`). The same
 *   prompt read again is silent, and so is the same prompt re-confirmed under
 *   a new answer id after input (`PushState`).
 * - Into `ended` (the process exited on its own): finished — once. A session
 *   closed at the desk is gone from the list instead, and the server sends
 *   nothing for it.
 */
export function pushFor(prev: PushState | null, next: PushState): PushKind | null {
  if (!prev) return null
  if (next.status === 'ended') return prev.status === 'ended' ? null : 'finished'
  if (next.status !== 'waiting') return null
  if (prev.status !== 'waiting') return 'needs-you'
  return prev.prompt && next.prompt && !samePrompt(prev.prompt, next.prompt) ? 'needs-you' : null
}

/** Longer than any folder name worth reading on a lock screen; cut rather than wrapped. */
const PUSH_TITLE_MAX = 60

/** The payload for one push (`pushFor`'s kind), for a session named `project`. */
export function pushPayload(kind: PushKind, project: string, ptyId: string): PushPayload {
  if (kind === 'test') return { title: 'Stoke', body: 'Notifications are on.', tag: 'stoke-test', url: '#/' }
  const name = Array.from(project.replace(/\s+/g, ' ').trim()).slice(0, PUSH_TITLE_MAX).join('') || 'A session'
  return {
    title: name,
    body: kind === 'needs-you' ? 'Needs you' : 'Finished',
    tag: `stoke-${ptyId}`,
    url: `#/s/${encodeURIComponent(ptyId)}`
  }
}

/**
 * The push services a subscription may point at — where the browsers a phone
 * or laptop runs actually subscribe. Anything else is refused: the endpoint is
 * a URL this machine will POST to, and the bearer key must not buy "make the
 * desktop send requests anywhere" (an address on its LAN included). A leading
 * dot is a suffix.
 *
 *   fcm.googleapis.com, android.googleapis.com   Chrome, Edge on Android, Samsung Internet, Opera, Brave
 *   updates.push.services.mozilla.com             Firefox
 *   web.push.apple.com, .push.apple.com           Safari and iOS home-screen apps
 *   .notify.windows.com                           Edge on Windows
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  '.push.apple.com',
  '.notify.windows.com'
]

/** More subscriptions than phones anyone carries; the oldest goes first. */
export const MAX_PUSH_SUBSCRIPTIONS = 8

const MAX_PUSH_ENDPOINT = 2048

/**
 * Whether Stoke may POST to `endpoint`: https on a push service above, or —
 * only where `allowLoopback` (an unpackaged build told so, for a suite's fake
 * push service) — plain http on 127.0.0.1. No credentials in it, ever.
 */
export function pushEndpointOk(endpoint: unknown, allowLoopback: boolean): endpoint is string {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_PUSH_ENDPOINT) return false
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (u.protocol === 'http:') return allowLoopback && u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return false
  const host = u.hostname.toLowerCase()
  return PUSH_SERVICE_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h))
}

/** base64url of exactly `bytes` bytes, unpadded (a trailing `=` is tolerated and dropped). */
function isB64u(v: unknown, bytes: number): v is string {
  if (typeof v !== 'string') return false
  const s = v.replace(/=+$/, '')
  return /^[A-Za-z0-9_-]+$/.test(s) && s.length === Math.ceil((bytes * 4) / 3)
}

export type PushSubscriptionVerdict =
  | { ok: true; sub: { endpoint: string; p256dh: string; auth: string } }
  | { ok: false; error: string }

/**
 * A subscription from a phone (`PushSubscription.toJSON()`), or why not. The
 * key must be an uncompressed P-256 point (65 bytes, leading 0x04 — base64url
 * `B`) and the auth secret 16 bytes: anything else could never be encrypted
 * to, and would be kept for nothing.
 */
export function pushSubscriptionFrom(raw: unknown, allowLoopback: boolean): PushSubscriptionVerdict {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { endpoint?: unknown; keys?: unknown }) : null
  if (!r) return { ok: false, error: 'Send the subscription as JSON.' }
  if (!pushEndpointOk(r.endpoint, allowLoopback)) return { ok: false, error: 'That push service is not one Stoke sends to.' }
  const keys = r.keys && typeof r.keys === 'object' ? (r.keys as { p256dh?: unknown; auth?: unknown }) : {}
  if (!isB64u(keys.p256dh, 65) || !keys.p256dh.startsWith('B')) return { ok: false, error: 'The subscription’s key is not a P-256 public key.' }
  if (!isB64u(keys.auth, 16)) return { ok: false, error: 'The subscription’s auth secret is not 16 bytes.' }
  return { ok: true, sub: { endpoint: r.endpoint, p256dh: keys.p256dh.replace(/=+$/, ''), auth: keys.auth.replace(/=+$/, '') } }
}

/**
 * The list after one phone subscribes under the key tagged `keyTag`: its old
 * record for the same endpoint replaced, every record made under another key
 * dropped (that key is gone), newest last, at most `MAX_PUSH_SUBSCRIPTIONS`.
 */
export function withPushSubscription(
  list: readonly PushSubscriptionRecord[],
  sub: { endpoint: string; p256dh: string; auth: string },
  keyTag: string,
  now: number
): PushSubscriptionRecord[] {
  const kept = list.filter((s) => s.keyTag === keyTag && s.endpoint !== sub.endpoint)
  return [...kept, { ...sub, keyTag, addedAt: now }].slice(-MAX_PUSH_SUBSCRIPTIONS)
}

/** Who is sent a push now: made under the key in force, and still a place Stoke may POST to. */
export function livePushSubscriptions(
  list: readonly PushSubscriptionRecord[],
  keyTag: string,
  allowLoopback: boolean
): PushSubscriptionRecord[] {
  return list.filter((s) => s.keyTag === keyTag && pushEndpointOk(s.endpoint, allowLoopback))
}

export const EMPTY_REMOTE_PUSH: RemotePushSettings = { vapidPublic: '', vapidPrivate: '', subscriptions: [] }

/**
 * Repair `remote.push`, rebuilt from named keys (the clamp rule). A key that is
 * not base64url of the right size is dropped with its pair, and a subscription
 * that does not hold up is dropped alone; the loopback shape passes here and
 * is refused at send time outside a test build (`livePushSubscriptions`). The
 * private key may be `''` while the vault has not opened.
 */
export function hydrateRemotePush(raw: unknown): RemotePushSettings {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const pub = isB64u(r.vapidPublic, 65) && (r.vapidPublic as string).startsWith('B') ? (r.vapidPublic as string) : ''
  const priv = typeof r.vapidPrivate === 'string' && (r.vapidPrivate === '' || isB64u(r.vapidPrivate, 32)) ? r.vapidPrivate : ''
  const subscriptions: PushSubscriptionRecord[] = []
  if (Array.isArray(r.subscriptions)) {
    for (const s of r.subscriptions) {
      if (!s || typeof s !== 'object') continue
      const rec = s as Record<string, unknown>
      const v = pushSubscriptionFrom({ endpoint: rec.endpoint, keys: { p256dh: rec.p256dh, auth: rec.auth } }, true)
      if (!v.ok || typeof rec.keyTag !== 'string' || !/^[0-9a-f]{8,64}$/.test(rec.keyTag)) continue
      subscriptions.push({ ...v.sub, keyTag: rec.keyTag, addedAt: typeof rec.addedAt === 'number' && Number.isFinite(rec.addedAt) ? rec.addedAt : 0 })
    }
  }
  return pub ? { vapidPublic: pub, vapidPrivate: priv, subscriptions: subscriptions.slice(-MAX_PUSH_SUBSCRIPTIONS) } : { ...EMPTY_REMOTE_PUSH, subscriptions: [] }
}

/* ------------------------------------------------ folders a phone may reach */

/*
 * Where a phone may browse and create folders (`GET /api/folders`, `POST
 * /api/projects`): only under a Settings project root, the default folder, or
 * the folder holding a known project — never anywhere else on the disk. The
 * bearer key is the whole defence (Cloudflare Access is checked for presence
 * only, never verified — `RemoteConfig.requireAccessHeader`), so a leaked key
 * must not become "list and create folders anywhere" — nor able to get there a
 * folder at a time by adding the places themselves (`remoteFolderBases`).
 */

/** Why a folder is reachable: which of the three places it is under. */
export type FolderBaseKind = 'root' | 'default' | 'parent'

export interface FolderBase {
  path: string
  kind: FolderBaseKind
}

/**
 * A base shallower than this is dropped. A project in the home folder makes
 * its parent `/Users` (or `/home`, `C:\Users`) — every account on the machine
 * — and one at a drive root would make its parent the whole disk. Two folders
 * below the root, a drive letter not counted, is the first depth that is
 * somebody's own.
 */
export const MIN_FOLDER_BASE_DEPTH = 2

/** Is `p` absolute under these rules: a drive or UNC path on Windows, `/…` elsewhere? */
export function isAbsoluteFor(p: string, rules: PathRules): boolean {
  if (rules.sep === '\\') return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p)
  return p.startsWith('/')
}

/** How many folders deep `p` is below its filesystem root; a drive letter is not a folder. */
export function folderDepth(p: string): number {
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return /^[A-Za-z]:$/.test(segs[0] ?? '') ? segs.length - 1 : segs.length
}

/** The folder holding `p` under these rules, or '' when it has none. */
export function parentFolder(p: string, rules: PathRules): string {
  const n = normalizePath(p, rules)
  const cut = n.lastIndexOf(rules.sep)
  if (cut < 0) return ''
  return n.slice(0, cut) || rules.sep
}

/** `p` normalised when it may be a place — absolute and deep enough — else ''. */
function placePath(p: unknown, rules: PathRules): string {
  const path = normalizePath(typeof p === 'string' ? p : '', rules)
  return path && isAbsoluteFor(path, rules) && folderDepth(path) >= MIN_FOLDER_BASE_DEPTH ? path : ''
}

/**
 * The places a phone may reach, in order: project roots, the default folder,
 * then the folder holding each known project. Pass REAL paths (resolved
 * through symlinks): nesting and depth only mean something on those, since a
 * symlinked root can point anywhere. Too-shallow places are dropped, and a
 * place inside another is folded into it — browsing the outer one reaches it,
 * and a flat list of every project's parent would be a second sidebar.
 *
 * A project lends the folder holding it only when that project is not itself
 * a place, since a phone can make a place a project (gotcha 121): Start here
 * on a place's own folder adds it (`POST /api/projects`), and its parent was
 * then a place on the next listing — one folder up per tap, to the depth
 * floor: the home folder, a whole volume, the app's data folder from its
 * scratch root. So a project inside (or equal to) a root or the default folder
 * lends nothing — anything it could lend is inside that place already, or is
 * the place's own parent — and neither does one that is the folder holding
 * another project. Everything a phone may add is inside a place already, so
 * its adds can shrink the places (a project that gains a project inside it
 * stops lending) but never widen them; verify:remote holds that for every add
 * in every small configuration.
 */
export function remoteFolderBases(
  input: { roots: readonly string[]; defaultCwd: string; projects: readonly string[] },
  rules: PathRules
): FolderBase[] {
  const named: FolderBase[] = [
    ...input.roots.map((path): FolderBase => ({ path: placePath(path, rules), kind: 'root' })),
    { path: placePath(input.defaultCwd, rules), kind: 'default' }
  ]
  const fixed = named.filter((b) => b.path)
  const projects = input.projects
    .map((p) => normalizePath(typeof p === 'string' ? p : '', rules))
    .filter((p) => p && isAbsoluteFor(p, rules))
  // The folders holding a project. A project that is one of them sits in or above a
  // place already, and its own parent is exactly the climb, so it lends nothing.
  const holders = new Set<string>()
  for (const p of projects) {
    const up = pathKey(parentFolder(p, rules), rules)
    if (up && up !== pathKey(p, rules)) holders.add(up)
  }
  const lends = (p: string): boolean =>
    !holders.has(pathKey(p, rules)) && !fixed.some((b) => isInside(b.path, p, rules))
  const candidates: FolderBase[] = [
    ...fixed,
    ...projects.filter(lends).map((p): FolderBase => ({ path: parentFolder(p, rules), kind: 'parent' }))
  ]
  const kept: FolderBase[] = []
  for (const c of candidates) {
    const path = placePath(c.path, rules)
    if (!path) continue
    // Already reachable through one kept earlier: the same folder, or inside it.
    if (kept.some((k) => isInside(k.path, path, rules))) continue
    // Wider than some kept earlier: it takes the first one's place, the rest go.
    const swallowed = kept.map((k, i) => (isInside(path, k.path, rules) ? i : -1)).filter((i) => i >= 0)
    if (swallowed.length) {
      kept[swallowed[0]] = { path, kind: c.kind }
      for (const i of swallowed.slice(1).reverse()) kept.splice(i, 1)
    } else {
      kept.push({ path, kind: c.kind })
    }
  }
  return kept
}

export type RemoteFolderVerdict = { ok: true; base: FolderBase } | { ok: false; reason: 'malformed' | 'outside' }

/**
 * A plain absolute path: a string, absolute under these rules, with no NUL
 * and no `.` or `..` segment. Checked before a path ever reaches `realpath`,
 * so no answer depends on how the disk resolves a traversal.
 */
export function isPlainFolderPath(p: unknown, rules: PathRules): p is string {
  if (typeof p !== 'string') return false
  const t = p.trim()
  if (!t || t.includes('\0') || !isAbsoluteFor(t, rules)) return false
  return !t.split(/[\\/]+/).some((s) => s === '..' || s === '.')
}

/**
 * May a phone reach this folder? `requested` is what it sent; `real` is that
 * path resolved through symlinks by the caller (the typed path when it does
 * not exist). The REAL path is what is judged, so a symlink inside a root that
 * points out of it is outside. `requested` must be a plain absolute path
 * (`isPlainFolderPath`). Case folds only where the OS does (`isInside`,
 * `pathKey`): on Linux `/home/v/Dev` is not `/home/v/dev`.
 */
export function remoteFolderVerdict(
  input: { requested: unknown; real: string; bases: readonly FolderBase[] },
  rules: PathRules
): RemoteFolderVerdict {
  if (!isPlainFolderPath(input.requested, rules)) return { ok: false, reason: 'malformed' }
  const real = normalizePath(typeof input.real === 'string' ? input.real : '', rules)
  if (!real || !isAbsoluteFor(real, rules)) return { ok: false, reason: 'malformed' }
  const base = input.bases.find(
    (b) => folderDepth(normalizePath(b.path, rules)) >= MIN_FOLDER_BASE_DEPTH && isInside(b.path, real, rules)
  )
  return base ? { ok: true, base } : { ok: false, reason: 'outside' }
}

/** The longest folder name `newFolderNameProblem` accepts. */
export const MAX_FOLDER_NAME = 120

/**
 * Why `name` cannot be a new folder's name, or null when it can. One segment
 * only — no separator, no `.`/`..` — so `POST /api/projects {parent, name}` can
 * only ever create a child of a folder already allowed. It also refuses what
 * Windows cannot hold, since the desktop may be Windows, and a leading dot,
 * which `/api/folders` would hide. Judged on the trimmed name, which is the
 * one created.
 */
export function newFolderNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Give the folder a name.'
  const n = name.trim()
  if (n === '.' || n === '..') return 'Pick a real name, not . or ..'
  if (/[\\/]/.test(n)) return 'A folder name cannot contain / or \\.'
  if (/[\u0000-\u001f\u007f]/.test(n)) return 'That name has a control character in it.'
  if (/[<>:"|?*]/.test(n)) return 'A folder name cannot contain < > : " | ? or *.'
  if (n.startsWith('.')) return 'A name that starts with a dot would be hidden.'
  if (n.endsWith('.')) return 'A folder name cannot end with a dot.'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) return 'That name is reserved on Windows.'
  if (n.length > MAX_FOLDER_NAME) return `Keep the name under ${MAX_FOLDER_NAME} characters.`
  return null
}
