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

export interface EndedRecord<T> {
  info: T
  endedAt: number
}

/** Remove ring entries older than `ENDED_RETENTION_MS`, in place. */
export function pruneEnded<T>(ring: Map<string, EndedRecord<T>>, now: number): void {
  for (const [id, rec] of ring) {
    if (now - rec.endedAt > ENDED_RETENTION_MS) ring.delete(id)
  }
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
