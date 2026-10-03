import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceSettings } from '@shared/types'
import { audioInputs, isVirtualCapture, labelsHidden, noSignalLine, pickDevice, type MicDevice } from '@shared/micDevice'
import { listDevices, revealDeviceNames, testMicrophone } from '@shared/voice'
import { createSignalWatch } from '@shared/voiceLevel'
import { microphoneError } from '@shared/voiceRoute'
import { holdChoices, holdLabel, HOLD_MS_MAX, HOLD_MS_MIN } from '@shared/voiceSettings'

/*
 * Which microphone Stoke's dictation records from, how long a hold is, and a
 * live meter to prove the choice — in Settings → Voice.
 *
 * Only Stoke's own recorder moves. Claude Code's /voice records through its
 * own native module from the system default and has no device setting, so the
 * hint says so rather than letting a pick look like it fixed both.
 *
 * Settings are written only by a choice made here (gotcha 57). A chosen device
 * that has been unplugged stays chosen and is listed as "not connected": the
 * recorder falls back to the default for as long as it is gone and says so in
 * the strip, and plugging it back in brings it back.
 */

/** The select's value for a saved device that is not in the list right now. */
const MISSING = '\u0000missing'

/** Chromium labels its `default` alias "Default - <device>"; the device is the useful half. */
function defaultName(devices: readonly MicDevice[]): string {
  const alias = devices.find((d) => d.kind === 'audioinput' && d.deviceId === 'default')
  return alias?.label.replace(/^Default\s*-\s*/i, '') ?? ''
}

export function MicPicker({
  voice,
  patchVoice
}: {
  voice: VoiceSettings
  patchVoice: (p: Partial<VoiceSettings>) => void
}): React.JSX.Element | null {
  const [devices, setDevices] = useState<MicDevice[] | null>(null)
  const [revealing, setRevealing] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.enumerateDevices

  /*
   * Only the newest listing may land: a devicechange during a slow one would
   * otherwise let the older answer overwrite the newer.
   */
  const asked = useRef(0)
  const refresh = useCallback(() => {
    if (!supported) return
    const ask = ++asked.current
    void listDevices()
      .catch(() => [] as MicDevice[])
      .then((d) => {
        if (ask === asked.current) setDevices(d)
      })
  }, [supported])

  useEffect(() => {
    refresh()
    if (!supported) return
    const md = navigator.mediaDevices
    md.addEventListener('devicechange', refresh)
    return () => md.removeEventListener('devicechange', refresh)
  }, [refresh, supported])

  /* ----------------------------------------------------------- test meter */

  const [testing, setTesting] = useState<{ label: string; notice: string | null } | null>(null)
  /** Between the press and the microphone opening — the first macOS prompt holds it open. */
  const [opening, setOpening] = useState(false)
  const [testFlat, setTestFlat] = useState(false)
  const fillRef = useRef<HTMLSpanElement>(null)
  /*
   * The live test's claim: a fresh object per press, holding its stop once
   * the microphone is open. Every callback of one start compares against ITS
   * object, so an open that lands after a Stop — or after a later Test — sees
   * someone else's claim, or none, and closes its own microphone.
   *
   * It used to be one shared placeholder, `() => {}`, and any non-null value
   * read as "mine". Test, Stop, Test while the first open was pending then let
   * both opens install themselves, the second overwriting the first's stop, so
   * one stream, its AudioContext and its rAF loop ran on with the OS indicator
   * lit until the renderer reloaded — Stop and closing Settings reached only
   * the survivor. The older start's failure also cleared the newer claim, which
   * orphaned the newer stream the same way and showed an error for a test
   * already cancelled. Both measured over CDP against the built app.
   */
  const claimRef = useRef<{ stop: (() => void) | null } | null>(null)
  const testTimerRef = useRef(0)

  const stopTest = useCallback(() => {
    window.clearTimeout(testTimerRef.current)
    const claim = claimRef.current
    claimRef.current = null
    claim?.stop?.()
    setTesting(null)
    setOpening(false)
    setTestFlat(false)
  }, [])

  // Never leave the microphone open behind a closed sheet.
  useEffect(() => stopTest, [stopTest])

  const startTest = (): void => {
    if (claimRef.current) return
    // Claimed before the await, so a second press cannot open a second stream (gotcha 20).
    const mine: { stop: (() => void) | null } = { stop: null }
    claimRef.current = mine
    setOpening(true)
    setMicError(null)
    const watch = createSignalWatch()
    let flat = false
    void testMicrophone({ id: voice.micDeviceId, label: voice.micLabel }, (level) => {
      // A superseded test's last frame (and its stop's zero) must not move the live line.
      if (claimRef.current !== mine) return
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${level.toFixed(3)})`
      const now = watch(level, performance.now())
      if (now !== flat) {
        flat = now
        setTestFlat(now)
      }
    })
      .then((t) => {
        if (claimRef.current !== mine) {
          // Stopped, restarted or unmounted while the microphone was opening.
          t.stop()
          return
        }
        mine.stop = t.stop
        setOpening(false)
        setTesting({ label: t.label, notice: t.notice })
        // A test, not a recording: it lets go by itself.
        testTimerRef.current = window.setTimeout(stopTest, 15_000)
        // A grant was just given, so the names may be readable now.
        refresh()
      })
      .catch((err: unknown) => {
        // A failure of a test already stopped is nobody's news, and not ours to clear.
        if (claimRef.current !== mine) return
        claimRef.current = null
        setOpening(false)
        setMicError(microphoneError(err, window.stoke.platform))
      })
  }

  if (!supported) return null

  const list = devices ?? []
  const inputs = audioInputs(list)
  const hidden = labelsHidden(list)
  const saved = voice.micDeviceId ? { id: voice.micDeviceId, label: voice.micLabel } : null
  // What the recorder would open right now: the saved id, or the same device
  // under a re-minted id (matched by label), or nothing.
  const resolved = saved && devices ? pickDevice(list, saved).deviceId : null
  const missing = !!saved && !!devices && !resolved
  const value = !saved ? '' : resolved ?? MISSING
  const chosen = inputs.find((d) => d.deviceId === resolved)
  const chosenName = saved ? chosen?.label || voice.micLabel : defaultName(list)
  const virtual = !!chosenName && isVirtualCapture(chosenName)
  const holdOptions = holdChoices(voice.holdMs)

  return (
    <>
      <div className="field" data-setting="voice.microphone">
        <label className="field-label" htmlFor="voice-mic">
          Microphone for Stoke’s dictation
        </label>
        <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center' }}>
          <select
            id="voice-mic"
            className="select"
            style={{ flex: '1 1 0%', minWidth: 0 }}
            value={value}
            onChange={(e) => {
              const id = e.target.value
              if (id === MISSING) return
              stopTest()
              if (!id) {
                patchVoice({ micDeviceId: null, micLabel: '' })
                return
              }
              const d = inputs.find((x) => x.deviceId === id)
              patchVoice({ micDeviceId: id, micLabel: d?.label ?? '' })
            }}
          >
            <option value="">
              System default{!saved && defaultName(list) ? ` — ${defaultName(list)}` : ''}
            </option>
            {inputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
            {missing && <option value={MISSING}>{voice.micLabel || 'The chosen microphone'} — not connected</option>}
          </select>
          {/* While the microphone is opening the press already cancels, so it says so. */}
          <button
            className="btn"
            onClick={() => (claimRef.current ? stopTest() : startTest())}
            aria-pressed={!!testing || opening}
          >
            {testing || opening ? 'Stop test' : 'Test'}
          </button>
        </div>
        {testing && (
          <div className="mic-test" role="status">
            <span className="voice-level mic-test-level" data-live="true" aria-hidden="true">
              <span ref={fillRef} className="voice-level-fill" />
            </span>
            <span className="field-hint" data-tone={testFlat || testing.notice ? 'warning' : undefined}>
              {testFlat
                ? noSignalLine(testing.label)
                : testing.notice
                  ? testing.notice
                  : `Listening to ${testing.label || 'the microphone'} — speak and the line moves. Nothing is recorded or sent.`}
            </span>
          </div>
        )}
        {hidden && (
          <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="field-hint">
              The system is keeping device names back until Stoke has used the microphone once.
            </span>
            <button
              className="btn"
              disabled={revealing}
              onClick={() => {
                setRevealing(true)
                setMicError(null)
                void revealDeviceNames()
                  .then(refresh)
                  .catch((err: unknown) => setMicError(microphoneError(err, window.stoke.platform)))
                  .finally(() => setRevealing(false))
              }}
            >
              Show device names
            </button>
          </div>
        )}
        {micError && (
          <span className="field-hint" data-tone="warning">
            {micError}
          </span>
        )}
        {virtual ? (
          <span className="field-hint" data-tone="warning">
            {chosenName} is a virtual audio cable, not a microphone, so Stoke’s dictation would
            record silence from it. Pick a real microphone here.
          </span>
        ) : missing ? (
          <span className="field-hint" data-tone="warning">
            Not connected, so dictation records from the system default until it is plugged back in.
          </span>
        ) : (
          <span className="field-hint">
            Only Stoke’s dictation records from this. Claude Code’s /voice always records from the
            system default and cannot be pointed at another device.
          </span>
        )}
      </div>

      <div className="field" data-setting="voice.hold">
        <label className="field-label" htmlFor="voice-hold">
          Hold Space for
        </label>
        <select
          id="voice-hold"
          className="select"
          value={voice.holdMs}
          onChange={(e) => patchVoice({ holdMs: Number(e.target.value) })}
        >
          {holdOptions.map((ms) => (
            <option key={ms} value={ms}>
              {holdLabel(ms)}
            </option>
          ))}
        </select>
        <span className="field-hint">
          Once dictation is on in a tab, a quicker press types an ordinary space and never opens the
          microphone; a longer one records until you let go. The keyboard’s own repeat never starts
          it sooner. Between {HOLD_MS_MIN} and {HOLD_MS_MAX} ms.
        </span>
      </div>
    </>
  )
}
