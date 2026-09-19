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
export interface PromptTrack {
  id: string
  since: number
  waitingFor: string | null
  statusUpdatedAt: number | null
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
  const fresh =
    !prev || prev.waitingFor !== reading.waitingFor || prev.statusUpdatedAt !== reading.statusUpdatedAt
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
  hostname: string
  token: string
}

/** What the server binds or checks: moving one needs a restart to take effect. */
const REMOTE_BIND_KEYS = ['port', 'bindLan', 'bindTailscale', 'requireAccessHeader', 'hostname', 'token'] as const

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
 * Whether a phone's `?k=` may be stored as the key cookie — review finding on
 * PX-14. Once the shell went public the cookie was built from ANY `k`, so a
 * link with a wrong key (or any page navigating the phone to one) overwrote a
 * working 90-day cookie and logged the phone out. Only the key the request
 * was actually authorised with is stored.
 */
export function mayStoreKeyCookie(queryKey: string | null, authorized: boolean): boolean {
  return queryKey !== null && queryKey !== '' && authorized
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

/** A machine's hostname, without the local-network suffix mDNS often adds. */
export function stripLocalHostnameSuffix(host: string): string {
  return host.replace(/\.(local|localdomain)$/i, '')
}
