import { useCallback, useEffect, useRef, useState } from 'react'
import type { SttProbe, VoiceTestResult } from '@shared/api'
import type { VoiceSettings } from '@shared/types'
import {
  audioDestination,
  STT_PROVIDER_IDS,
  STT_PROVIDERS,
  sttConfigOf,
  type SttConfig,
  type SttProviderId
} from '@shared/speechProviders'
import { DEFAULT_STT_URL } from '@shared/voiceSettings'
import { useDraft } from '../lib/useDraft'
import { FieldHint } from './FieldHint'
import { Spinner } from './Spinner'

/*
 * Who transcribes Stoke's dictation, in Settings → Voice: the speech sidecar
 * the user runs (the default, and the only choice before this panel), a hosted
 * speech-to-text API with the user's key, or any OpenAI-compatible server.
 *
 * The panel never sends audio or a key anywhere itself. The pill asks main
 * whether dictation is ready (`sttStatus` — a free probe for a server, "has a
 * key" for a provider), and Test asks main to prove the provider and key with a
 * request no plan bills (`voiceTest`). Both dictation surfaces read `voice` per
 * recording, so a change here reaches the next clip on the desktop and the phone.
 *
 * One honest line says where audio goes, from the same table main sends from
 * (`audioDestination`): a hosted provider always takes it off this machine; a
 * server does unless its address is loopback.
 */

/** The model select's value for "a model not in the list". */
const OTHER = '\u0000other'

export type PatchVoice = (p: Partial<VoiceSettings> | ((v: VoiceSettings) => Partial<VoiceSettings>)) => void

export function SpeechServiceSettings({
  voice,
  patchVoice
}: {
  voice: VoiceSettings
  patchVoice: PatchVoice
}): React.JSX.Element {
  const provider = voice.provider
  const spec = STT_PROVIDERS[provider]
  const savedKey = provider === 'sidecar' ? '' : (voice.keys[provider] ?? '')

  const sttField = useDraft(voice.sttUrl, (v) => patchVoice({ sttUrl: v.trim() || DEFAULT_STT_URL }))
  const baseField = useDraft(voice.baseUrl, (v) => patchVoice({ baseUrl: v.trim() }))
  const modelField = useDraft(voice.model, (v) => patchVoice({ model: v.trim() }))
  /*
   * A key is committed into `keys` under the provider showing when it was
   * typed — the blur that commits it fires before a provider change can land —
   * and merged into the LATEST keys (the functional patch), so it cannot put
   * back a key some other commit just removed.
   */
  const keyField = useDraft(savedKey, (v) => {
    const k = v.trim()
    patchVoice((cur) => {
      const keys = { ...cur.keys }
      if (k) keys[provider] = k
      else delete keys[provider]
      return { keys }
    })
  })
  const [reveal, setReveal] = useState(false)
  const [otherModel, setOtherModel] = useState(false)

  /* ---------------------------------------------------------- the pill */

  const [stt, setStt] = useState<SttProbe | null>(null)
  /*
   * Only the newest answer may paint the pill. A probe against an address that
   * swallows packets takes its whole 800ms, so an answer for the provider or
   * address someone just replaced can land after the answer for the new one.
   */
  const sttAsked = useRef(0)
  const readStt = useCallback(() => {
    const ask = ++sttAsked.current
    void window.stoke.audio.sttStatus().then((s) => {
      if (ask === sttAsked.current) setStt(s)
    })
  }, [])
  // On mount, and whenever what it depends on is committed: main drops its probe cache in the same write.
  useEffect(() => readStt(), [voice.sttUrl, voice.baseUrl, provider, !!savedKey, readStt])
  useEffect(() => {
    // A server is started in a terminal; coming back to this window is when it may have.
    window.addEventListener('focus', readStt)
    return () => window.removeEventListener('focus', readStt)
  }, [readStt])

  /* ---------------------------------------------------------- the test */

  const [test, setTest] = useState<VoiceTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  /*
   * Claimed before the await (gotchas 20 and 51) — `disabled` is only the
   * visible half. An answer that lands after the picker moved is not the new
   * provider's verdict, so it is dropped (`currentProvider`).
   */
  const testingRef = useRef(false)
  const currentProvider = useRef(provider)
  currentProvider.current = provider

  const showOther = provider !== 'custom' && (otherModel || (voice.model !== '' && !spec.models.includes(voice.model)))

  const runTest = (): void => {
    if (testingRef.current) return
    testingRef.current = true
    setTesting(true)
    setTest(null)
    // The drafts, not the saved values: Test proves what is on screen.
    const cfg: SttConfig = {
      provider,
      model: provider === 'custom' || showOther ? modelField.draft.trim() : voice.model,
      baseUrl: baseField.draft,
      sttUrl: sttField.draft.trim() || DEFAULT_STT_URL,
      key: keyField.draft
    }
    const mine = provider
    void window.stoke.audio
      .voiceTest(cfg)
      .catch((err: unknown): VoiceTestResult => ({ ok: false, tone: 'danger', message: String(err) }))
      .then((r) => {
        if (currentProvider.current === mine) setTest(r)
      })
      .finally(() => {
        testingRef.current = false
        setTesting(false)
        readStt()
      })
  }

  const pickProvider = (next: SttProviderId): void => {
    if (next === provider) return
    setTest(null)
    setOtherModel(false)
    setReveal(false)
    // A model id is one provider's; the next one starts on its own default.
    patchVoice({ provider: next, model: '' })
  }

  /* ---------------------------------------------------------- the words */

  const where = audioDestination(sttConfigOf(voice))
  const server = provider === 'sidecar' || provider === 'custom'
  const pill =
    stt === 'up'
      ? { text: provider === 'sidecar' ? 'running' : 'answering', tone: 'success' as const }
      : stt === 'down'
        ? { text: provider === 'sidecar' ? 'not running' : 'not answering', tone: undefined }
        : stt === 'ready'
          ? { text: 'key saved', tone: undefined }
          : stt === 'off'
            ? { text: server ? 'no address' : 'no key', tone: undefined }
            : null

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="voice-provider">
          Speech service{' '}
          {pill && (
            <span className="pill" data-tone={pill.tone}>
              {pill.text}
            </span>
          )}
        </label>
        <select
          id="voice-provider"
          className="select"
          value={provider}
          onChange={(e) => pickProvider(e.target.value as SttProviderId)}
        >
          {STT_PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>
              {STT_PROVIDERS[id].label}
            </option>
          ))}
        </select>
        <span className="field-hint" data-audio-leaves={where.leaves ? 'true' : 'false'}>
          {where.line}
        </span>
        {spec.note && <span className="field-hint">{spec.note}</span>}
      </div>

      {provider === 'sidecar' && (
        <div className="field">
          <label className="field-label" htmlFor="voice-stt-url">
            Speech server address
          </label>
          <input
            id="voice-stt-url"
            className="input mono"
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
      )}

      {provider === 'custom' && (
        <div className="field">
          <label className="field-label" htmlFor="voice-base-url">
            Server address
          </label>
          <input
            id="voice-base-url"
            className="input mono"
            placeholder={spec.defaultBaseUrl}
            value={baseField.draft}
            spellCheck={false}
            onChange={(e) => baseField.setDraft(e.target.value)}
            onBlur={baseField.onBlur}
            onKeyDown={baseField.onKeyDown}
          />
          <FieldHint
            more={
              <>
                Stoke posts to <span className="mono">&lt;address&gt;/audio/transcriptions</span> with
                the same fields as OpenAI&rsquo;s API, and checks a key against{' '}
                <span className="mono">&lt;address&gt;/models</span>. An address with no path gains{' '}
                <span className="mono">/v1</span>.
              </>
            }
          >
            {stt === 'down'
              ? 'Nothing is answering there, so dictation will fail until it is started.'
              : 'The base URL, ending in /v1.'}
          </FieldHint>
        </div>
      )}

      {provider !== 'sidecar' && (
        <div className="field">
          <label className="field-label" htmlFor="voice-model">
            Model
          </label>
          {provider === 'custom' ? (
            <input
              id="voice-model"
              className="input mono"
              placeholder={spec.defaultModel}
              value={modelField.draft}
              spellCheck={false}
              onChange={(e) => modelField.setDraft(e.target.value)}
              onBlur={modelField.onBlur}
              onKeyDown={modelField.onKeyDown}
            />
          ) : (
            <>
              <select
                id="voice-model"
                className="select"
                value={showOther ? OTHER : voice.model || spec.defaultModel}
                onChange={(e) => {
                  const m = e.target.value
                  if (m === OTHER) {
                    setOtherModel(true)
                    return
                  }
                  setOtherModel(false)
                  patchVoice({ model: m === spec.defaultModel ? '' : m })
                }}
              >
                {spec.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === spec.defaultModel ? ' (default)' : ''}
                  </option>
                ))}
                <option value={OTHER}>Another model…</option>
              </select>
              {showOther && (
                <input
                  className="input mono"
                  aria-label={`${spec.name} model id`}
                  placeholder="model id"
                  value={modelField.draft}
                  spellCheck={false}
                  onChange={(e) => modelField.setDraft(e.target.value)}
                  onBlur={modelField.onBlur}
                  onKeyDown={modelField.onKeyDown}
                />
              )}
            </>
          )}
        </div>
      )}

      {provider !== 'sidecar' && (
        <div className="field">
          <label className="field-label" htmlFor="voice-key">
            {provider === 'custom' ? 'Key (optional)' : `${spec.name} API key`}
          </label>
          <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center' }}>
            <input
              id="voice-key"
              className="input mono"
              style={{ flex: '1 1 0%', minWidth: 0 }}
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={provider === 'custom' ? 'only if the server asks for one' : 'paste key…'}
              value={keyField.draft}
              onChange={(e) => keyField.setDraft(e.target.value)}
              onBlur={keyField.onBlur}
              onKeyDown={keyField.onKeyDown}
            />
            <button type="button" className="btn" aria-pressed={reveal} onClick={() => setReveal((r) => !r)}>
              {reveal ? 'Hide' : 'Show'}
            </button>
          </div>
          <FieldHint
            more={
              provider === 'custom' ? (
                <>
                  speaches&rsquo; <span className="mono">API_KEY</span>, LocalAI&rsquo;s{' '}
                  <span className="mono">LOCALAI_API_KEY</span> or vLLM&rsquo;s{' '}
                  <span className="mono">--api-key</span>. Sent as a Bearer token, only by Stoke&rsquo;s
                  main process.
                </>
              ) : (
                <>
                  Only Stoke&rsquo;s main process sends it, in a request header — never in a URL, and
                  never to the phone. Where this system has a key store it is sealed in{' '}
                  <span className="mono">secrets.json</span> (Settings › Backup &amp; transfer says
                  which).
                </>
              )
            }
          >
            {provider === 'custom'
              ? 'Only if the server was started with one.'
              : `Made at ${spec.keysAt}. Each provider keeps its own key here.`}
          </FieldHint>
        </div>
      )}

      <div className="field">
        <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" disabled={testing} aria-busy={testing} onClick={runTest}>
            {testing && <Spinner />}
            {testing ? 'Testing…' : server ? 'Test the server' : 'Test the key'}
          </button>
        </div>
        {test ? (
          <span className="field-hint" role="status" data-tone={test.tone}>
            {test.message}
          </span>
        ) : (
          <span className="field-hint">
            {provider === 'sidecar'
              ? 'Asks the server whether it is there. Nothing is recorded or sent.'
              : provider === 'custom'
                ? 'Asks the server for its models, with the key if one is set. Nothing is recorded or sent.'
                : 'Lists the provider’s models with the key — it bills nothing and sends no audio.'}
          </span>
        )}
      </div>
    </>
  )
}
