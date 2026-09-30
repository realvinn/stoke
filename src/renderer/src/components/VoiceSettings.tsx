import { useCallback, useEffect, useRef, useState } from 'react'
import type { SttProbe, VoiceState } from '@shared/api'
import type { Settings } from '@shared/types'
import { micAccessLine } from '@shared/voiceRoute'
import { DEFAULT_STT_URL } from '@shared/voiceSettings'
import { useDraft } from '../lib/useDraft'
import { FieldHint } from './FieldHint'
import { MicPicker } from './MicPicker'
import { MicrophoneNotice } from './MicrophoneNotice'

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
 *  3. Stoke's dictation (⇧⌘D): getUserMedia plus the speech server the user
 *     runs, which is the one piece that needs setting up — and the one whose
 *     failure used to be mistaken for the first. Its address is edited here,
 *     in `settings.voice`; it used to sit under Phone access → Advanced with
 *     only a jump button on this page. So are the microphone it records from
 *     and how long Space must be held before it does (`MicPicker`).
 */
export function VoiceSettings({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const [state, setState] = useState<VoiceState | null>(null)
  const [stt, setStt] = useState<SttProbe | null>(null)
  const [asking, setAsking] = useState(false)
  const isMac = window.stoke.platform === 'darwin'
  const isWin = window.stoke.platform === 'win32'
  const voice = settings.voice

  /*
   * Patches are built from the LATEST settings, never a render-time copy — the
   * RemoteSettings rule. The block will grow (provider, microphone), and a
   * patch spread from an older copy would put a field someone just changed
   * back the way it was.
   */
  const latest = useRef({ voice, onPatch })
  latest.current = { voice, onPatch }
  const patchVoice = useCallback((p: Partial<Settings['voice']>): void => {
    const { voice: v, onPatch: patch } = latest.current
    patch({ voice: { ...v, ...p } })
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

  const sttField = useDraft(voice.sttUrl, (v) => patchVoice({ sttUrl: v.trim() || DEFAULT_STT_URL }))

  const readAccess = useCallback(() => {
    void window.stoke.audio.voiceState().then(setState)
  }, [])

  /*
   * Only the newest probe may paint the pill. One against an address that
   * swallows packets takes its whole 800ms, so an answer for the address
   * someone just replaced can land after the answer for the new one.
   */
  const sttAsked = useRef(0)
  const readStt = useCallback(() => {
    const ask = ++sttAsked.current
    void window.stoke.audio.sttStatus().then((s) => {
      if (ask === sttAsked.current) setStt(s)
    })
  }, [])

  useEffect(() => {
    readAccess()
    // The permission is changed in another app, and the speech server is
    // started in a terminal. Coming back to this window is the moment either
    // may have moved, so re-read then rather than polling.
    const onFocus = (): void => {
      readAccess()
      readStt()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [readAccess, readStt])

  // On mount, and whenever a new address is committed: main drops the old
  // address's cached answer in the same settings write this render follows.
  useEffect(() => readStt(), [voice.sttUrl, readStt])

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
          Codex, OpenCode, SSH sessions — and for keeping audio on a machine you run: both are
          transcribed by your own speech server.
        </span>
      </div>

      <MicPicker voice={voice} patchVoice={patchVoice} />

      <div className="field">
        <span className="field-label">
          Speech server{' '}
          {stt && stt !== 'unknown' && (
            <span className="pill" data-tone={stt === 'up' ? 'success' : undefined}>
              {stt === 'up' ? 'running' : 'not running'}
            </span>
          )}
        </span>
        <input
          className="input mono"
          aria-label="Speech server address"
          placeholder={DEFAULT_STT_URL}
          value={sttField.draft}
          spellCheck={false}
          onChange={(e) => sttField.setDraft(e.target.value)}
          onBlur={sttField.onBlur}
          onKeyDown={sttField.onKeyDown}
        />
        <FieldHint
          more={
            <>
              Stoke proxies to it, so it never has to face the internet — it has no authentication
              of its own, and only Stoke&rsquo;s main process ever talks to it. The terminal and the
              phone both read this address on every recording, so a change reaches the next one.{' '}
              <span className="mono">uv run scripts/stt-sidecar.py</span> in Stoke&rsquo;s repo
              runs one locally.
            </>
          }
        >
          {stt === 'down'
            ? 'Nothing is answering there, so dictation will fail until it is started.'
            : 'Where speech is transcribed, for the phone and the terminal alike.'}
        </FieldHint>
      </div>
    </>
  )
}
