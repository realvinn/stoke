import { useCallback, useEffect, useState } from 'react'
import type { VoiceState } from '@shared/api'
import type { Settings } from '@shared/types'
import { micAccessLine } from '@shared/voiceRoute'
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
 *     failure used to be mistaken for the first.
 */
export function VoiceSettings({
  settings,
  onOpenSection
}: {
  settings: Settings
  onOpenSection: (id: 'remote') => void
}): React.JSX.Element {
  const [state, setState] = useState<VoiceState | null>(null)
  const [asking, setAsking] = useState(false)
  const isMac = window.stoke.platform === 'darwin'
  const isWin = window.stoke.platform === 'win32'

  const refresh = useCallback(() => {
    void window.stoke.audio.voiceState().then(setState)
  }, [])

  useEffect(() => {
    refresh()
    // The permission is changed in another app. Coming back to this window is
    // the moment it may have moved, so re-read then rather than polling.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const access = state?.access ?? null
  const line = access ? micAccessLine(access, window.stoke.platform) : null
  const sttUrl = settings.remote.sttUrl.trim()

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
          {isMac ? '⇧⌘D' : 'Ctrl+Shift+D'} in any tab, then hold Space. For the tabs with no voice mode of
          their own — Codex, OpenCode, SSH sessions — and for keeping audio on a machine you run: it is
          transcribed by your own speech server,{' '}
          <span className="mono">{sttUrl || 'not set'}</span>.
        </span>
        <div>
          <button className="btn" onClick={() => onOpenSection('remote')}>
            Change the speech server
          </button>
        </div>
      </div>
    </>
  )
}
