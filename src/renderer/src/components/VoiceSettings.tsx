import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceState } from '@shared/api'
import type { Settings } from '@shared/types'
import { micAccessLine } from '@shared/voiceRoute'
import { DEFAULT_STT_URL } from '@shared/voiceSettings'
import { MicPicker } from './MicPicker'
import { MicrophoneNotice } from './MicrophoneNotice'
import { SpeechServiceSettings, type PatchVoice } from './SpeechServiceSettings'

/*
 * Everything that decides whether speaking into Stoke does anything, in one place.
 *
 * It used to be split across "Phone access" — the speech server and the Windows
 * device notice lived there, because the phone was dictation's first surface —
 * which is the last section anyone opens when Claude Code's /voice says
 * "Microphone access is denied". Three separate things are involved, and the
 * section keeps them separate because they fail separately:
 *
 *  1. The OS permission. On macOS it is Stoke's, and it covers every CLI in a
 *     Stoke tab, since a pty child records as Stoke (voiceRoute.ts). So it is
 *     the first row, and it says that in words.
 *  2. Claude Code's own `/voice`: its own recorder, its own speech service,
 *     switched on by `/voice` in a session. Stoke only reports it.
 *  3. Stoke's dictation (⇧⌘D): getUserMedia plus a speech service, which is
 *     the one piece that needs setting up — and the one whose failure used to
 *     be mistaken for the first. The service is chosen here, in
 *     `settings.voice` (`SpeechServiceSettings`): the speech server the user
 *     runs — whose address used to sit under Phone access → Advanced with only
 *     a jump button on this page — a hosted provider with the user's key, or
 *     any OpenAI-compatible server. So are the microphone it records from and
 *     how long Space must be held before it does (`MicPicker`).
 */
export function VoiceSettings({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const [state, setState] = useState<VoiceState | null>(null)
  const [asking, setAsking] = useState(false)
  const isMac = window.stoke.platform === 'darwin'
  const isWin = window.stoke.platform === 'win32'
  const voice = settings.voice

  /*
   * Patches are built from the LATEST settings, never a render-time copy — the
   * RemoteSettings rule — because `voice` is written whole: a patch spread from
   * an older copy puts a field someone just changed back the way it was.
   *
   * "Latest" includes a patch still on its way. Pasting a key and then picking
   * another provider is two commits a few milliseconds apart (the key's blur,
   * then the select); spread from the props, the second would carry the voice
   * block from before the first came back — moving the provider and dropping
   * the key just pasted. So the ref holds what was last SENT until settings
   * arrive from main again (a new `voice` object), and only then follows the
   * props: a re-render for any other reason cannot wind it back.
   */
  const latest = useRef({ voice, onPatch })
  const seenVoice = useRef(voice)
  if (seenVoice.current !== voice) {
    seenVoice.current = voice
    latest.current.voice = voice
  }
  latest.current.onPatch = onPatch
  const patchVoice: PatchVoice = useCallback((p) => {
    const { voice: v, onPatch: patch } = latest.current
    const next = { ...v, ...(typeof p === 'function' ? p(v) : p) }
    latest.current.voice = next
    patch({ voice: next })
  }, [])

  /*
   * An emptied box is repaired on close as well as on blur (gotcha 63: Escape
   * unmounts the sheet and delivers no blur). A hand-written empty value is
   * repaired too, the first time this page is left — the same as when the
   * field lived under Phone access.
   */
  useEffect(
    () => () => {
      const { voice: v } = latest.current
      if (!v.sttUrl.trim()) patchVoice({ sttUrl: DEFAULT_STT_URL })
    },
    [patchVoice]
  )

  const readAccess = useCallback(() => {
    void window.stoke.audio.voiceState().then(setState)
  }, [])

  useEffect(() => {
    readAccess()
    // The permission is changed in another app, so coming back to this window
    // is the moment it may have moved: re-read then rather than polling. The
    // speech service's pill does the same for itself.
    window.addEventListener('focus', readAccess)
    return () => window.removeEventListener('focus', readAccess)
  }, [readAccess])

  const access = state?.access ?? null
  const line = access ? micAccessLine(access, window.stoke.platform) : null

  return (
    <>
      {access && access !== 'not-applicable' && (
        <div className="field">
          <span className="field-label">
            Microphone access{' '}
            <span
              className="pill"
              data-tone={access === 'granted' ? 'success' : access === 'denied' ? 'danger' : undefined}
            >
              {access === 'granted'
                ? 'allowed'
                : access === 'denied'
                  ? 'denied'
                  : access === 'not-determined'
                    ? 'not asked yet'
                    : access}
            </span>
          </span>
          {line && (
            <span className="field-hint" data-tone={access === 'denied' ? 'warning' : undefined}>
              {line}
            </span>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
            {isMac && access === 'not-determined' && (
              <button
                className="btn"
                data-variant="primary"
                disabled={asking}
                onClick={() => {
                  setAsking(true)
                  void window.stoke.audio
                    .requestMic()
                    .then(setState)
                    .finally(() => setAsking(false))
                }}
              >
                Allow the microphone
              </button>
            )}
            {(isMac || isWin) && access !== 'granted' && (
              <button className="btn" onClick={() => window.stoke.audio.openMicPrivacy()}>
                Open {isMac ? 'Privacy & Security' : 'privacy settings'}
              </button>
            )}
          </div>
        </div>
      )}

      <MicrophoneNotice />

      <div className="field">
        <span className="field-label">
          Claude Code’s /voice{' '}
          {state && (
            <span className="pill" data-tone={state.claudeVoice ? 'success' : undefined}>
              {state.claudeVoice ? 'on' : 'off'}
            </span>
          )}
        </span>
        <span className="field-hint">
          {state?.claudeVoice
            ? 'Hold Space at an empty prompt in a Claude Code tab to talk. It records with its own recorder and transcribes through your Claude.ai account — no speech server needed. Stoke’s dictation steps aside in those tabs so the two never fight over Space.'
            : 'Type /voice in a Claude Code session to turn it on; then hold Space at an empty prompt to talk. It needs a Claude.ai login, not an API key.'}
        </span>
      </div>

      <div className="field">
        <span className="field-label">Stoke’s dictation</span>
        <span className="field-hint">
          {isMac ? '⇧⌘D' : 'Ctrl+Shift+D'} in any tab, then hold Space — a quick tap still types a
          space; on the phone, hold the microphone. For the tabs with no voice mode of their own —
          Codex, OpenCode, SSH sessions. Both are transcribed by the speech service below: a server
          you run, which keeps audio on hardware you own, or a provider&rsquo;s API with your key.
        </span>
      </div>

      <MicPicker voice={voice} patchVoice={patchVoice} />

      <SpeechServiceSettings voice={voice} patchVoice={patchVoice} />
    </>
  )
}
