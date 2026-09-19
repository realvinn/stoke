/*
 * Who owns a held Space bar, and what to say when the microphone does not answer.
 *
 * There are two dictation features in a Stoke tab and they want the same key.
 * Claude Code's `/voice` is push-to-talk on a held Space: it watches the
 * auto-repeat stream of spaces arriving at an empty prompt, records through its
 * own native audio module, and streams to Anthropic's speech service over the
 * user's Claude.ai login. Stoke's dictation (⇧⌘D) is ALSO push-to-talk on a held
 * Space, records with getUserMedia in the renderer, and posts a WAV to a speech
 * server the user runs themselves.
 *
 * Measured on 2026-09-19, against the installed 0.9.5 over CDP with real key
 * events: with Stoke's dictation on, one held Space started BOTH. Stoke's
 * capture-phase handler took the first keydown and returned early on every
 * `e.repeat` without preventDefault, so each auto-repeat reached xterm and the
 * pty, and Claude Code saw exactly the repeat stream it listens for. Stoke's
 * recorder then failed ("Speech server unreachable: fetch failed" — a speech
 * server is a separate thing to set up) while Claude's reported "No speech
 * detected", and the user's reading of that was "Claude Code cannot access my
 * microphone in Stoke". It could, the whole time: with Stoke's dictation off,
 * `/voice` recorded and transcribed in a Stoke tab first try.
 *
 * So the rule is ownership, decided before a key is ever pressed:
 *
 *  - On a LOCAL Claude Code tab whose `/voice` is switched on, Space belongs to
 *    Claude Code, and Stoke's dictation refuses to start there — saying why,
 *    rather than silently taking the key from a feature the user enabled.
 *  - Anywhere else Stoke's dictation may own it, and when it does it owns the
 *    WHOLE hold, repeats included, so nothing downstream records a second time.
 *
 * An SSH tab stays Stoke's even when it runs `claude`: that `claude` is on the
 * far machine, where there is no microphone to record from (the CLI's own check
 * says "no audio device is available in this environment"), which is exactly
 * the case Stoke's dictation exists for.
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import (gotcha 27).
 */

/**
 * The operating system's answer about the microphone, for Stoke.
 *
 * On macOS this is also the answer for every CLI Stoke runs, which is the part
 * nobody expects: TCC attributes a child process's request to its RESPONSIBLE
 * process, and a `claude` spawned in Stoke's pty has Stoke as that — measured,
 * `responsibility_get_pid_responsible_for_pid` on a child of the pty returns
 * Stoke's own pid. So the switch that decides whether `/voice` can hear you is
 * the one labelled "Stoke" in Privacy & Security, and there is no "claude" entry
 * to find.
 */
export type MicAccess =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  /** Linux, where there is no per-app microphone gate to ask about. */
  | 'not-applicable'

export function isMicAccess(v: unknown): v is MicAccess {
  return (
    v === 'granted' ||
    v === 'denied' ||
    v === 'restricted' ||
    v === 'not-determined' ||
    v === 'unknown' ||
    v === 'not-applicable'
  )
}

/**
 * Whether Claude Code's own voice mode is switched on — by the CLI's own rule.
 *
 * `/voice` writes both shapes, `voiceEnabled` and `voice: { enabled, mode }`,
 * and the 2.1.278 bundle reads them as `(e.voice?.enabled ?? e.voiceEnabled)
 * === true`: the NESTED key wins and the top-level one is only its fallback.
 *
 * This used to take either as enough, under a comment claiming the precedence
 * could not be known and a wrong guess would cost only a hint. Both halves were
 * wrong (found by review, by reading the bundle): the answer decides whether
 * Stoke's dictation is REFUSED on the tab, and with the keys disagreeing
 * (`voiceEnabled: true, voice.enabled: false`, reachable by hand-editing) the
 * refusal told the user to run `/voice` to turn it off — which, the CLI reading
 * it as off already, turned it on.
 */
export function claudeVoiceEnabled(values: Record<string, unknown> | null | undefined): boolean {
  if (!values) return false
  const voice = values.voice
  const nested = typeof voice === 'object' && voice !== null ? (voice as { enabled?: unknown }).enabled : undefined
  return (nested ?? values.voiceEnabled) === true
}

export interface DictationTab {
  /** The tab's coding CLI id; only `'claude'` has a voice mode Stoke knows of. */
  cliId: string
  /** Non-null for an SSH tab, whose CLI runs on another machine. */
  hostId: string | null
}

/** Who a held Space belongs to on this tab. */
export type SpaceOwner = 'cli' | 'stoke'

export function spaceOwner(tab: DictationTab, claudeVoice: boolean): SpaceOwner {
  if (tab.hostId) return 'stoke'
  return tab.cliId === 'claude' && claudeVoice ? 'cli' : 'stoke'
}

/**
 * What Stoke's dictation does with one keydown while it is switched on.
 *
 * `start` begins a recording, `swallow` takes the key so that nothing below —
 * xterm, the pty, the CLI — ever sees it, and `pass` leaves it alone. The case
 * that used to be `pass` and must never be again is a repeat of Space: that is
 * the stream Claude Code's `/voice` listens for.
 */
export type SpaceAction = 'start' | 'swallow' | 'pass'

export function dictationKeyAction(e: { code: string; repeat: boolean }): SpaceAction {
  if (e.code !== 'Space') return 'pass'
  return e.repeat ? 'swallow' : 'start'
}

/** The sentence shown instead of starting Stoke's dictation on a tab whose CLI owns Space. */
export const CLI_OWNS_SPACE =
  'Claude Code’s own /voice is on in this tab — hold Space to talk to it. Run /voice to turn it off if you want Stoke’s dictation here instead.'

/**
 * Why getUserMedia refused, in words that name the thing to change.
 *
 * `NotAllowedError` is the permission, and on macOS the permission is the
 * operating system's, not Chromium's: the main window grants `media` to its own
 * renderer unconditionally, so a refusal that reaches here came from TCC.
 * `NotFoundError` is no input device at all. Anything else keeps the browser's
 * own message, which is more specific than any paraphrase of it.
 */
export function microphoneError(err: unknown, platform: string): string {
  const name = err instanceof Error || (typeof err === 'object' && err !== null) ? (err as { name?: unknown }).name : undefined
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return platform === 'darwin'
      ? 'macOS has not allowed Stoke to use the microphone. Turn Stoke on in System Settings → Privacy & Security → Microphone.'
      : platform === 'win32'
        ? 'Windows has not allowed desktop apps to use the microphone. Turn it on in Settings → Privacy & security → Microphone.'
        : 'The microphone was refused.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Connect one, or choose one as the system’s default input.'
  }
  const message = err instanceof Error ? err.message : ''
  return message || 'Could not open the microphone.'
}

/** One line about the OS permission, for Settings. Null when there is nothing to say. */
export function micAccessLine(access: MicAccess, platform: string): string | null {
  switch (access) {
    // The pill beside the label already says allowed or denied, so these say
    // what that MEANS rather than repeating it.
    case 'granted':
      return platform === 'darwin'
        ? 'Claude Code’s /voice and every other CLI in a Stoke tab record as Stoke, so this one switch covers them all.'
        : null
    case 'denied':
      return platform === 'darwin'
        ? 'Claude Code’s /voice records as Stoke — there is no separate “claude” entry — so it reports “Microphone access is denied” until Stoke is turned on in System Settings → Privacy & Security → Microphone.'
        : 'Turn microphone access for desktop apps on in Windows Settings → Privacy & security → Microphone.'
    case 'restricted':
      return 'Restricted by a device-management profile or parental controls; only an administrator can change it.'
    case 'not-determined':
      return 'Not asked yet. The first recording — Stoke’s dictation or a CLI’s voice mode — makes macOS ask, and it will ask about Stoke.'
    case 'unknown':
      return 'The system would not say.'
    case 'not-applicable':
      return null
  }
}
