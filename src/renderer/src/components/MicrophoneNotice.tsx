import { useEffect, useState } from 'react'
import type { MicrophoneCheck } from '@shared/api'

/*
 * Claude Code's /voice records from the Windows default capture endpoint and
 * cannot be pointed at a device. Installing a virtual audio driver - VB-Audio
 * Cable, VoiceMeeter, NVIDIA Broadcast - makes its silent cable the system
 * default, and dictation then records nothing at all. There is no error: you
 * hold space, speak, and nothing arrives.
 *
 * Stoke's own dictation shares that exposure only while it is left on "System
 * default": it can be pointed at a device of its own in the picker below
 * (MicPicker), which is also where a PICKED virtual cable is warned about. So
 * the copy splits the two — /voice always uses this device, Stoke's dictation
 * uses whatever is picked.
 *
 * This says so. Stoke deliberately does not change the Windows default, which
 * is a global machine setting it does not own.
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
      <span className="field-label">Windows default microphone</span>
      <span className="mono truncate" style={{ fontSize: 'var(--fs-xs)' }}>
        {check.device.name}
      </span>
      {check.suspect ? (
        <span className="field-hint" data-tone="warning">
          This is a virtual audio cable, not a microphone, so Claude Code&apos;s <code>/voice</code>{' '}
          records silence — it always uses the Windows default recording device. Set a real
          microphone as the default in Windows Sound settings
          {check.alternatives.length > 0 && <> — {check.alternatives[0].name} looks right</>}. Stoke&apos;s
          dictation can instead be pointed at a real microphone below.
        </span>
      ) : (
        <span className="field-hint">
          The Windows default recording device. Claude Code&apos;s <code>/voice</code> always
          records from it; Stoke&apos;s dictation does too unless you pick another microphone below.
        </span>
      )}
    </div>
  )
}
