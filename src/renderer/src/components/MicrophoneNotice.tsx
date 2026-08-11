import { useEffect, useState } from 'react'
import type { MicrophoneCheck } from '@shared/api'

/*
 * Claude Code's /voice records from the Windows default capture endpoint and
 * cannot be pointed at a device. Installing a virtual audio driver - VB-Audio
 * Cable, VoiceMeeter, NVIDIA Broadcast - makes its silent cable the system
 * default, and dictation then records nothing at all. There is no error: you
 * hold space, speak, and nothing arrives.
 *
 * Stoke's own dictation has the same exposure, and says so in the same place.
 * The renderer calls getUserMedia with no device constraint, so it records from
 * that same default; a cable silences it exactly as it silences /voice, and
 * just as quietly - the transcript comes back empty rather than failing.
 *
 * This says so. It is the whole feature; Stoke deliberately does not change the
 * device, which is a global machine setting it does not own.
 */
export function MicrophoneNotice(): React.JSX.Element | null {
  const [check, setCheck] = useState<MicrophoneCheck | null>(null)

  useEffect(() => {
    let live = true
    void window.stoke.audio.micCheck().then((c) => {
      if (live) setCheck(c)
    })
    return () => {
      live = false
    }
  }, [])

  if (!check?.device) return null

  return (
    <div className="field">
      <span className="field-label">Microphone</span>
      <span className="mono truncate" style={{ fontSize: 'var(--fs-xs)' }}>
        {check.device.name}
      </span>
      {check.suspect ? (
        <span className="field-hint" data-tone="warning">
          This is a virtual audio cable, not a microphone, so dictation records silence — both
          Stoke&apos;s and Claude Code&apos;s <code>/voice</code>. Set a real microphone as the
          default recording device in Windows Sound settings
          {check.alternatives.length > 0 && <> — {check.alternatives[0].name} looks right</>}.
        </span>
      ) : (
        <span className="field-hint">
          What dictation records from, in Stoke and in Claude Code&apos;s <code>/voice</code>.
          Both use the Windows default recording device and neither can be pointed at another one.
        </span>
      )}
    </div>
  )
}
