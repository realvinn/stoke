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

/*
 * A held Space, once Stoke's dictation is armed: a tap types a space, and only
 * a HOLD opens the microphone.
 *
 * It used to be the first keydown that started a recording, with no duration
 * test at all. So an armed tab could not type a space — every tap opened the
 * microphone (the OS indicator lit), recorded a few milliseconds, and threw the
 * clip away as under 1 KB — and a person dictating into a shell prompt had to
 * disarm, type the space, and re-arm. Now the first keydown only arms a timer
 * (`pending`); the strip says "Keep holding…", and the recorder starts when the
 * timer fires — or when an auto-repeat arrives once the threshold has passed,
 * should the timer be late. An earlier repeat used to start it at once ("the
 * OS saying the key is held"), which capped every threshold at the OS repeat
 * delay and made a longer hold setting do nothing (2026-10-04). A release
 * while still pending types the space.
 *
 * What must survive from gotcha 79: EVERY repeat of Space is taken, in every
 * phase. A repeat that reaches xterm reaches the pty, and the repeat stream is
 * exactly what Claude Code's own `/voice` listens for.
 *
 * Pure, and the caller owns the clock, the timer and the side effects. Both
 * surfaces run it: the desktop terminal (`TerminalView`) and the phone's voice
 * mode (`src/remote/session.ts`).
 */

/**
 * `pending` is a Space that is down but not yet a hold; `starting` is a hold
 * whose microphone is still opening (getUserMedia can wait on a permission
 * prompt); `recording` is audio being captured.
 */
export type SpaceHoldState =
  | { phase: 'idle' }
  | { phase: 'pending'; since: number }
  | { phase: 'starting' }
  | { phase: 'recording' }

export const SPACE_IDLE: SpaceHoldState = { phase: 'idle' }

/**
 * `composing` is an IME composition (`isComposing`, or keyCode 229): Space
 * there is the IME's conversion key and is never taken. `timer` is the hold
 * timer firing; `opened` is the recorder's start resolving with the microphone
 * open; `failed` is it rejecting.
 */
export type SpaceHoldEvent =
  | { type: 'keydown'; code: string; repeat: boolean; composing?: boolean }
  | { type: 'keyup'; code: string; composing?: boolean }
  | { type: 'timer' }
  | { type: 'opened' }
  | { type: 'failed' }

/**
 * What the caller does.
 *
 *  - `pass`       nothing; a key event goes on to xterm untouched.
 *  - `swallow`    nothing, but the key is taken so nothing below sees it.
 *  - `arm-timer`  (re)start the hold timer for `wait` ms.
 *  - `start`      open the microphone and begin recording.
 *  - `type-space` type the space the pending press stood for, as typing would.
 *  - `finish`     stop, transcribe and insert.
 *  - `cancel`     drop the recording — or the microphone still opening — unsent.
 */
export type SpaceHoldOutput = 'pass' | 'swallow' | 'arm-timer' | 'start' | 'type-space' | 'finish' | 'cancel'

export interface SpaceHoldStep {
  state: SpaceHoldState
  output: SpaceHoldOutput
  /**
   * Whether to `preventDefault` + `stopPropagation` the key event that caused
   * this step. Only a Space is ever taken; any other key always goes through,
   * after the pending space when there is one, so "a b" typed with the space
   * still down comes out in order.
   */
  take: boolean
  /** For `arm-timer`: how long to wait. */
  wait?: number
}

export function spaceHold(state: SpaceHoldState, event: SpaceHoldEvent, now: number, holdMs: number): SpaceHoldStep {
  const step = (next: SpaceHoldState, output: SpaceHoldOutput, take = false, wait?: number): SpaceHoldStep =>
    wait === undefined ? { state: next, output, take } : { state: next, output, take, wait }

  switch (event.type) {
    case 'timer':
      if (state.phase !== 'pending') return step(state, 'pass')
      // setTimeout never fires early, but a timer armed by an older press and
      // not yet cleared could; re-arm for what is left rather than start short.
      if (now - state.since < holdMs) return step(state, 'arm-timer', false, holdMs - (now - state.since))
      return step({ phase: 'starting' }, 'start')
    case 'opened':
      if (state.phase === 'starting') return step({ phase: 'recording' }, 'pass')
      // Opened after the hold already ended: release it at once.
      return step(state, state.phase === 'recording' ? 'pass' : 'cancel')
    case 'failed':
      return step(SPACE_IDLE, 'pass')
    case 'keydown':
      if (event.code !== 'Space') {
        // Another key while a space is pending: it was typing, not a hold.
        // Type the space first, then let this key through behind it.
        return state.phase === 'pending' ? step(SPACE_IDLE, 'type-space') : step(state, 'pass')
      }
      if (event.composing) return step(state, 'pass')
      if (state.phase === 'idle') {
        // A repeat with no press of ours before it (Space was already down
        // when dictation was armed, or the recorder just failed under it):
        // still taken, never started from and never passed on.
        if (event.repeat) return step(state, 'swallow', true)
        return step({ phase: 'pending', since: now }, 'arm-timer', true, holdMs)
      }
      /*
       * A repeat while pending is taken (gotcha 79) and starts nothing until
       * the threshold has passed: the threshold is the user's, and it is now
       * longer than the OS repeat delay (500ms by default on macOS, measured
       * with NSEvent.keyRepeatDelay on 2026-10-04), so a repeat that started
       * the recorder would cut every hold setting past that delay back to it.
       * Past the threshold a repeat does start — the timer is late (a stalled
       * loop), and the key being held that long is the hold.
       */
      if (state.phase === 'pending' && event.repeat && now - state.since >= holdMs) {
        return step({ phase: 'starting' }, 'start', true)
      }
      return step(state, 'swallow', true)
    case 'keyup':
      if (event.code !== 'Space' || event.composing) return step(state, 'pass')
      switch (state.phase) {
        case 'pending':
          // Released before the hold threshold: a tap, which is a space. At or
          // past it with the timer not yet run (a stalled loop), it was a hold
          // that never got to record — type nothing rather than a stray space.
          return now - state.since < holdMs
            ? step(SPACE_IDLE, 'type-space', true)
            : step(SPACE_IDLE, 'cancel', true)
        case 'starting':
          // Released while the microphone was still opening (a permission
          // prompt, a slow device): nothing was recorded, and nothing may stay
          // open that nobody asked to keep on.
          return step(SPACE_IDLE, 'cancel', true)
        case 'recording':
          return step(SPACE_IDLE, 'finish', true)
        default:
          return step(state, 'swallow', true)
      }
  }
}

/** The key fields `spaceHold` reads, from a DOM KeyboardEvent. */
export function spaceKey(
  e: { code: string; repeat: boolean; isComposing: boolean; keyCode: number },
  type: 'keydown' | 'keyup'
): SpaceHoldEvent {
  // keyCode 229 is the key an IME is consuming; `isComposing` can still be
  // false on the keydown that starts a composition.
  const composing = e.isComposing || e.keyCode === 229
  return type === 'keydown' ? { type, code: e.code, repeat: e.repeat, composing } : { type, code: e.code, composing }
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
