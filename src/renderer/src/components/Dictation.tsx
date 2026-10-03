import { useEffect, useRef, useState } from 'react'
import type { VoiceSettings } from '@shared/types'
import { noSignalLine } from '@shared/micDevice'
import { createRecorder, type Recorder } from '@shared/voice'
import { createSignalWatch } from '@shared/voiceLevel'
import {
  microphoneError,
  SPACE_IDLE,
  spaceHold,
  spaceKey,
  type SpaceHoldEvent,
  type SpaceHoldState,
  type SpaceHoldStep
} from '@shared/voiceRoute'

/*
 * Stoke's dictation in a terminal pane: the held Space, the recorder, the
 * strip — one copy, for the two panes that type into a session. A local or SSH
 * tab (TerminalView) and another machine's session in a remote tab
 * (RemoteTerminal) differ only in who may own Space there and how a transcript
 * reaches the session, so those are the caller's (`DictationTarget`) and
 * everything else is here: one hold rule (`spaceHold`, gotcha 79), one
 * recorder per pane, one strip.
 *
 * The microphone is THIS computer's, and so is the speech service
 * (`window.stoke.audio.transcribe`, main's `stt.ts`): on a remote tab that is
 * the point. Claude Code's own `/voice` records the mic of the machine its CLI
 * runs on, which for a remote tab is the other computer's.
 *
 * Only the tab in front records: the keys are bound on the pane's host only
 * while `active`, and leaving it releases the microphone. A transcript that
 * comes back after the tab was left still goes to the session it was spoken
 * for — the recorder detaches the take before it uploads.
 *
 * Words are never dropped silently. When the target cannot take them (a remote
 * link that went down while the speech service worked, a session that ended),
 * they stay on the strip, with why, to type again or copy.
 */

const IS_MAC = window.stoke.platform === 'darwin'

/** How long a sentence shown instead of switching dictation on stays up. */
const NOTICE_MS = 9000

export interface DictationTarget {
  /**
   * Asked as dictation is switched on: null to arm it, or the sentence that
   * says why not in this tab (Claude Code's own `/voice` owns Space here; the
   * tab may only watch). Read at the moment of switching, never cached.
   */
  refusal: () => Promise<string | null>
  /** Type the space a tap stood for, the way a typed space goes. */
  typeSpace: () => void
  /**
   * Put a transcript into the session. Resolves null once it is typed, or the
   * sentence saying why it was not — the words then stay on the strip.
   */
  deliver: (text: string) => Promise<string | null>
}

export interface Dictation {
  /** Armed: a held Space records in this pane. */
  on: boolean
  /** Arm (after asking the target) or disarm; the chord, a menu item and a button all call this. */
  toggle: () => void
  /** Which strip is drawn — 0 none, 1 a notice or kept words, 2 the live strip — for a pane that measures its floats. */
  stripKey: number
  strip: React.JSX.Element | null
}

/** Words the session did not take, and why. */
interface Kept {
  text: string
  why: string
}

export function useDictation({
  hostRef,
  active,
  voice,
  target
}: {
  /** The pane's terminal host: keys are taken there, in the capture phase, before xterm sees them. */
  hostRef: React.RefObject<HTMLDivElement | null>
  active: boolean
  /** The hold threshold and the chosen microphone, read per press. */
  voice: VoiceSettings
  target: DictationTarget
}): Dictation {
  /*
   * Off until asked for, because arming it takes Space away from the terminal
   * — the most-pressed key there after Enter — so it must never be a mode you
   * are in without having said so.
   */
  const [on, setOn] = useState(false)
  /*
   * `holding` is a Space that is down but not yet a hold: the strip says "Keep
   * holding…" and no microphone is open, so a tap costs nothing and types a
   * space (`spaceHold`, voiceRoute.ts).
   */
  const [status, setStatus] = useState<'idle' | 'holding' | 'recording' | 'working'>('idle')
  const [error, setError] = useState<string | null>(null)
  /** The chosen microphone was not there, so this recording is on the default. */
  const [deviceNote, setDeviceNote] = useState<string | null>(null)
  /** The level line has lain flat for NO_SIGNAL_MS while recording. */
  const [noSignal, setNoSignal] = useState(false)
  /**
   * A one-off sentence shown INSTEAD of switching dictation on (`refusal`).
   * Separate from `error` because nothing failed: the key, or the session,
   * simply is not this pane's to dictate into.
   */
  const [notice, setNotice] = useState<string | null>(null)
  const [kept, setKept] = useState<Kept | null>(null)
  /** A Type again in flight (claimed before its await, gotcha 20). */
  const retryingRef = useRef(false)
  const [retrying, setRetrying] = useState(false)

  const recorderRef = useRef<Recorder | null>(null)
  /*
   * Where the held Space is: idle, pending (down, not yet a hold), starting
   * (the microphone opening — getUserMedia can wait on a permission prompt, so
   * Space is routinely released in this phase) or recording. A ref, not state:
   * the key handlers step it synchronously, several times inside one frame.
   */
  const holdRef = useRef<SpaceHoldState>(SPACE_IDLE)
  const holdTimerRef = useRef<number | null>(null)
  /** Read at each press and each start, so a Settings change reaches the next one. */
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  /** The caller's hooks, as of the last render: the key effect is bound once per arming. */
  const targetRef = useRef(target)
  targetRef.current = target
  /*
   * The level line's fill. Written straight from the recorder's animation
   * frame (`style.transform`), never through React state: that would be sixty
   * renders a second of the whole terminal pane.
   */
  const levelRef = useRef<HTMLSpanElement>(null)
  const signalWatchRef = useRef<((level: number, now: number) => boolean) | null>(null)
  const noSignalRef = useRef(false)
  /** The label of the device recording now, for naming a virtual cable. */
  const micLabelRef = useRef('')
  /** Bumped by each recording, so an older one's transcript cannot reset a newer one's strip. */
  const takeRef = useRef(0)

  /** Keep words the session did not take, after any already kept: nothing said is dropped. */
  const keep = (text: string, why: string): void =>
    setKept((k) => ({ text: k ? `${k.text} ${text}` : text, why }))

  /*
   * Switch Stoke's dictation, after asking the target whether this tab is
   * dictation's to arm. Asked at the moment of switching, not cached at mount:
   * `/voice` is typed inside the session and flips the setting while the tab
   * is open, and a remote tab's link and grant move while it is open.
   */
  const toggle = (): void => {
    setError(null)
    setNotice(null)
    if (on) {
      setOn(false)
      return
    }
    void targetRef.current
      .refusal()
      .catch(() => null)
      .then((why) => {
        if (why) setNotice(why)
        else setOn(true)
      })
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  /*
   * Dictation's keys, bound on the host in the capture phase so they are taken
   * before xterm's hidden textarea ever sees them — while a CLI is running,
   * anything that reaches the terminal is forwarded to it.
   *
   * Pane-scoped rather than in `lib/shortcuts.ts` with the app's chords. Those
   * act on the window; this one acts on *this* terminal and the transcript
   * goes into *this* session, so it belongs to the pane that owns them. It is
   * also why the listeners hang off the host rather than `window`: dictation
   * follows the focused terminal with no routing, and a background tab cannot
   * record.
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host || !active) return

    /*
     * Only refs and state setters inside the options: the recorder outlives
     * this effect (it is kept in a ref for the pane's life), so a closure over
     * anything else would be the first render's copy.
     */
    const recorder = (recorderRef.current ??= createRecorder(
      async (wav) => {
        // The renderer never reaches the speech server itself; main proxies it,
        // because the sidecar has no authentication of its own.
        const res = await window.stoke.audio.transcribe(wav)
        if (!res.ok) throw new Error(res.error)
        return res.text
      },
      {
        onLevel: (level) => {
          const fill = levelRef.current
          if (fill) fill.style.transform = `scaleX(${level.toFixed(3)})`
          const watch = signalWatchRef.current
          if (!watch) return
          const flat = watch(level, performance.now())
          if (flat !== noSignalRef.current) {
            noSignalRef.current = flat
            setNoSignal(flat)
          }
        },
        device: () => ({ id: voiceRef.current.micDeviceId, label: voiceRef.current.micLabel })
      }
    ))

    const stopWatch = (): void => {
      signalWatchRef.current = null
      if (noSignalRef.current) {
        noSignalRef.current = false
        setNoSignal(false)
      }
    }

    const clearHoldTimer = (): void => {
      if (holdTimerRef.current === null) return
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }

    const beginRecording = async (): Promise<void> => {
      ++takeRef.current
      setError(null)
      setDeviceNote(null)
      setStatus('recording')
      micLabelRef.current = ''
      signalWatchRef.current = createSignalWatch()
      try {
        const info = await recorder.start()
        // Null: released (or Esc) while the microphone was still opening. The
        // step that cancelled has already put the strip back.
        if (!info) return
        micLabelRef.current = info.label
        if (info.notice) setDeviceNote(info.notice)
        dispatch({ type: 'opened' })
      } catch (err) {
        dispatch({ type: 'failed' })
        stopWatch()
        setStatus('idle')
        setError(microphoneError(err, window.stoke.platform))
      }
    }

    const finishRecording = async (): Promise<void> => {
      stopWatch()
      const take = takeRef.current
      setStatus('working')
      let text: string
      try {
        text = await recorder.finish()
      } catch (err) {
        setStatus('idle')
        setError(err instanceof Error && err.message ? err.message : 'Transcription failed.')
        return
      }
      if (takeRef.current === take) setStatus('idle')
      if (!text) return
      /*
       * Handed to the target, which says whether the session took it. A no —
       * or a throw — keeps the words on the strip rather than losing them: the
       * speech service has already been paid for them, and they were spoken.
       */
      let why: string | null
      try {
        why = await targetRef.current.deliver(text)
      } catch (err) {
        why = err instanceof Error && err.message ? err.message : 'The words could not be typed.'
      }
      if (why) keep(text, why)
    }

    /*
     * Every Space event, the hold timer and the recorder's answer go through
     * the one reducer (`spaceHold`); this only carries out what it says.
     */
    const dispatch = (event: SpaceHoldEvent): SpaceHoldStep => {
      const step = spaceHold(holdRef.current, event, performance.now(), voiceRef.current.holdMs)
      holdRef.current = step.state
      switch (step.output) {
        case 'arm-timer':
          clearHoldTimer()
          holdTimerRef.current = window.setTimeout(() => {
            holdTimerRef.current = null
            dispatch({ type: 'timer' })
          }, step.wait ?? voiceRef.current.holdMs)
          setError(null)
          setStatus('holding')
          break
        case 'start':
          clearHoldTimer()
          void beginRecording()
          break
        case 'type-space':
          clearHoldTimer()
          setStatus((s) => (s === 'holding' ? 'idle' : s))
          /*
           * Typed the way a typed space goes (the target's `typeSpace`), so
           * the draft tracking and selection clearing see a keystroke. It runs
           * before a non-Space key that interrupted the press lets that key
           * through, so "a b" typed with the space still down comes out in order.
           */
          targetRef.current.typeSpace()
          break
        case 'finish':
          void finishRecording()
          break
        case 'cancel':
          clearHoldTimer()
          recorder.cancel()
          stopWatch()
          setStatus('idle')
          break
      }
      return step
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const chord = IS_MAC
        ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
        : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
      if (chord && e.code === 'KeyD') {
        e.preventDefault()
        e.stopPropagation()
        toggleRef.current()
        return
      }

      if (!on) return

      if (e.code === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOn(false)
        return
      }

      /*
       * A held Space is a first keydown and then a stream of repeats, and BOTH
       * have to be taken. The repeats used to be let through (`if (e.repeat)
       * return`, to avoid restarting the live recording) — which handed the
       * pty exactly the repeat stream Claude Code's /voice listens for, so one
       * press started two recorders (gotcha 79). `spaceHold` takes every
       * repeat in every phase; the first press only arms the hold timer, so a
       * tap never opens the microphone, and it types a space on release.
       */
      const step = dispatch(spaceKey(e, 'keydown'))
      if (step.take) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (!on) return
      const step = dispatch(spaceKey(e, 'keyup'))
      if (step.take) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    /*
     * Focus leaving the pane with Space down: the keyup goes to whatever has
     * focus now, never here, so the reducer is told (`lost`). Focus moving
     * WITHIN the pane (xterm's own textarea) is not leaving it.
     */
    const onLost = (): void => {
      if (holdRef.current.phase !== 'idle') dispatch({ type: 'lost' })
    }
    const onFocusOut = (e: FocusEvent): void => {
      if (!host.contains(e.relatedTarget as Node | null)) onLost()
    }
    const onVisibility = (): void => {
      if (document.hidden) onLost()
    }

    host.addEventListener('keydown', onKeyDown, true)
    host.addEventListener('keyup', onKeyUp, true)
    host.addEventListener('focusout', onFocusOut)
    window.addEventListener('blur', onLost)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      host.removeEventListener('keydown', onKeyDown, true)
      host.removeEventListener('keyup', onKeyUp, true)
      host.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('blur', onLost)
      document.removeEventListener('visibilitychange', onVisibility)
      // A press still pending when the mode or the tab changes is dropped, not
      // typed: nobody is watching this pane's strip any more.
      clearHoldTimer()
      holdRef.current = SPACE_IDLE
    }
  }, [active, on, hostRef])

  /*
   * Leaving dictation — by Esc, by switching tabs, or by the pane going away —
   * must release the microphone. Without this the OS recording indicator stays
   * lit after the mode is off, which is exactly the kind of thing that makes a
   * person stop trusting an app with their microphone.
   */
  useEffect(() => {
    if (on && active) return
    recorderRef.current?.cancel()
    holdRef.current = SPACE_IDLE
    signalWatchRef.current = null
    noSignalRef.current = false
    setNoSignal(false)
    setStatus('idle')
  }, [on, active])

  useEffect(() => {
    return () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
    }
  }, [])

  /** Type the kept words again; a second press while one is on its way does nothing (gotcha 20). */
  const retry = (): void => {
    const words = kept
    if (!words || retryingRef.current) return
    retryingRef.current = true
    setRetrying(true)
    void targetRef.current
      .deliver(words.text)
      .catch((err: unknown) => (err instanceof Error && err.message ? err.message : 'The words could not be typed.'))
      .then((why) =>
        setKept((k) => {
          // Discarded while it was on its way, or discarded and replaced: the strip has moved on.
          if (!k || !k.text.startsWith(words.text)) return k
          // Words kept meanwhile were appended (`keep`); only these were typed.
          const later = k.text.slice(words.text.length).trim()
          if (!why) return later ? { text: later, why: k.why } : null
          return { text: k.text, why }
        })
      )
      .finally(() => {
        retryingRef.current = false
        setRetrying(false)
      })
  }

  const showLive = on
  const showNotice = !on && !!notice
  const stripKey = showLive ? 2 : showNotice || kept ? 1 : 0

  const strip =
    stripKey === 0 ? null : (
      <div
        className="voice-strip"
        role="status"
        data-tone={(showLive && (error || (status === 'recording' && noSignal))) || (!showLive && kept) ? 'error' : undefined}
        /*
         * Every plain key on the strip's buttons stops here: App types an
         * unclaimed key on a focused BUTTON through to the terminal in front
         * (`typeThroughKey`), so an Enter on Type again would be a `\r` in the
         * session. Enter and Space then press the focused button, natively.
         */
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          e.stopPropagation()
        }}
      >
        {showLive && (
          <div className="voice-row">
            <span className="voice-dot" data-state={error ? 'error' : status} />
            <span className="voice-text">
              {error
                ? error
                : status === 'holding'
                  ? 'Keep holding…'
                  : status === 'recording'
                    ? noSignal
                      ? noSignalLine(micLabelRef.current)
                      : (deviceNote ?? 'Listening — release Space to transcribe')
                    : status === 'working'
                      ? 'Transcribing…'
                      : 'Hold Space to speak · tap for a space · Esc to exit'}
            </span>
          </div>
        )}
        {showNotice && (
          <div className="voice-row">
            <span className="voice-dot" data-state="idle" />
            <span className="voice-text">{notice}</span>
          </div>
        )}
        {kept && (
          <div className="voice-kept">
            <div className="voice-row">
              <span className="voice-dot" data-state="error" />
              <span className="voice-text">{kept.why}</span>
            </div>
            <p className="voice-kept-words">{kept.text}</p>
            <div className="voice-kept-actions">
              <button className="btn" data-variant="primary" disabled={retrying} onClick={retry}>
                Type it now
              </button>
              <button className="btn" onClick={() => window.stoke.clipboard.writeText(kept.text)}>
                Copy
              </button>
              <button className="btn" data-variant="ghost" onClick={() => setKept(null)}>
                Discard
              </button>
            </div>
          </div>
        )}
        {/*
          The recording volume. Always mounted while the live strip is, so the
          recorder's frame callback has a node to write to from its first
          frame; shown only while recording. Its scale is data, not decoration,
          so reduced motion keeps it live and drops only the easing (gotcha 72).
        */}
        {showLive && (
          <span className="voice-level" aria-hidden="true" data-live={!error && status === 'recording' ? 'true' : undefined}>
            <span ref={levelRef} className="voice-level-fill" />
          </span>
        )}
      </div>
    )

  return { on, toggle, stripKey, strip }
}
