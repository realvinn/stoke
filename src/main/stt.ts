/**
 * The one place Stoke sends a recording to be transcribed.
 *
 * Two surfaces dictate — the phone, through the remote server's
 * `/api/transcribe` route, and the desktop, through an IPC handler — and both
 * arrive here. That is deliberate rather than tidy-minded: the sidecar has no
 * authentication of its own, so the rule "only the main process may reach it"
 * is a security property, and a second implementation is how such a rule stops
 * being true. A hosted provider adds a second reason: its key lives in main
 * (sealed in secrets.json at rest) and travels only in a header built here, so
 * neither the phone nor a web page ever holds it. It also means the timeout,
 * the body caps and the error wording are decided once instead of drifting
 * between the two.
 *
 * WHAT is sent is `buildSttRequest` (shared/speechProviders.ts): a pure
 * description per provider — URL, headers, raw / multipart / JSON body — that
 * `verify:voice` holds field by field. This file turns it into a `fetch` with
 * the runtime's own FormData and Blob, so there is no SDK to load (gotcha 40)
 * and nothing provider-specific beyond the table. The WAV is encoded in the
 * browser (`src/shared/voice.ts`) because the sidecar validates the RIFF
 * header, every hosted provider accepts it as it is, and converting here would
 * mean shipping ffmpeg.
 *
 * No key is ever logged, put in a URL or passed to a process; upstream text is
 * redacted before it reaches a banner (`describeSttFailure`).
 */
import {
  buildSttRequest,
  describeSttFailure,
  isRefusal,
  keyCheckRequest,
  readTranscript,
  redactKey,
  STOKE_MAX_AUDIO_BYTES,
  STT_PROVIDERS,
  trimBase,
  type SttBody,
  type SttConfig
} from '../shared/speechProviders.ts'
import type { VoiceTestResult } from '../shared/api.ts'

/**
 * A transcript, or a sentence to show the person who just spoke.
 *
 * Errors are strings rather than thrown, because every caller has to render
 * one: the phone turns it into an HTTP status, the desktop into a banner. A
 * rejected promise would make both of them re-derive the same message.
 *
 * `unset` marks the one failure that is not this request's fault — nothing is
 * configured: no speech server, no custom address, no key for the chosen
 * provider — so the phone's route can answer 503 rather than 502 from the same
 * settings read the call itself used.
 */
export type SttResult = { ok: true; text: string } | { ok: false; error: string; unset?: true }

/**
 * What a dictated clip may weigh at the door: the remote server's body reader
 * refuses anything larger before it is read. Each provider's own cap is lower
 * or equal (`STT_PROVIDERS[p].maxBytes`) and is checked per call.
 */
export const MAX_AUDIO_BYTES = STOKE_MAX_AUDIO_BYTES

/**
 * Whisper on a long clip is slow but not unbounded; a first run also pays for
 * the model load. Two minutes is far past a push-to-talk utterance and still
 * short enough that a wedged server surfaces as an error rather than a
 * microphone that never comes back. A hosted API answers in seconds, so the
 * same bound only ever catches a hang.
 */
const TIMEOUT_MS = 120_000

/** A key check or probe answers in well under this, or the service is not there. */
const TEST_TIMEOUT_MS = 10_000

export interface SttCallOptions {
  /** For the suite's hang case; production always uses TIMEOUT_MS. */
  timeoutMs?: number
  /**
   * For `verify:voice` only: the suite passes a fetch that swaps a hosted
   * provider's origin for a loopback fake and then calls the real one, so the
   * FormData/Blob encoding under test is the shipped path, byte for byte, with
   * no network. Production never sets it.
   */
  fetchImpl?: typeof fetch
}

/** The declarative body as fetch wants it. File parts become Blobs, so the bytes are never copied into a string. */
function toFetchBody(body: SttBody): NonNullable<RequestInit['body']> {
  switch (body.kind) {
    case 'raw':
      return body.bytes as Uint8Array<ArrayBuffer>
    case 'json':
      return JSON.stringify(body.value)
    case 'multipart': {
      const form = new FormData()
      for (const part of body.parts) {
        if ('file' in part) form.append(part.name, new Blob([part.file as Uint8Array<ArrayBuffer>], { type: part.type }), part.filename)
        else form.append(part.name, part.value)
      }
      return form
    }
  }
}

/** The runtime's error, in words, with the cause's code when fetch hides it behind "fetch failed". */
function whyOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause
  const detail =
    cause && typeof cause.code === 'string' ? cause.code : cause && typeof cause.message === 'string' ? cause.message : null
  return detail && !err.message.includes(detail) ? `${err.message}: ${detail}` : err.message
}

function isTimeout(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'TimeoutError'
}

/**
 * The sentence for a request that never got an HTTP answer. It names where it
 * went and says what it is NOT: the first version read "Speech server
 * unreachable: fetch failed", which in a strip that appears when you hold
 * Space to talk was read as "the microphone does not work" — while the
 * microphone had recorded perfectly and only this request failed.
 */
function unreachable(cfg: SttConfig, url: string, err: unknown, timeoutMs: number): string {
  const spec = STT_PROVIDERS[cfg.provider]
  const why = redactKey(isTimeout(err) ? `no answer within ${Math.round(timeoutMs / 1000)} s` : whyOf(err), cfg.key)
  if (cfg.provider === 'sidecar') {
    const base = trimBase(cfg.sttUrl)
    return `Speech server at ${base} did not answer (${why}). That is Stoke’s dictation server, not the microphone — start it, or change it in Settings → Voice.`
  }
  if (cfg.provider === 'custom') {
    const base = url.replace(/\/audio\/transcriptions$|\/models$/, '')
    return `The speech server at ${base} did not answer (${why}). That is the speech service, not the microphone — start it, or change it in Settings → Voice.`
  }
  return `${spec.name} did not answer (${why}). That is the speech service, not the microphone — check the connection, or pick another in Settings → Voice.`
}

/**
 * POST a 16-bit PCM WAV to the configured provider and read the transcript
 * back.
 *
 * `cfg` is `sttConfigOf(getSettings().voice)`, read by the caller per call, so
 * a change in Settings → Voice reaches the next clip on both surfaces. An
 * empty sidecar address or a missing key is not an error state to log — it is
 * how someone says they have not set dictation up — so it answers with the
 * sentence that tells them where to.
 */
export async function transcribe(cfg: SttConfig, wav: Uint8Array, opts: SttCallOptions = {}): Promise<SttResult> {
  const built = buildSttRequest(cfg, wav)
  if (isRefusal(built)) return built.unset ? { ok: false, error: built.error, unset: true } : { ok: false, error: built.error }
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const send = opts.fetchImpl ?? fetch
  try {
    const upstream = await send(built.url, {
      method: built.method,
      headers: built.headers,
      body: toFetchBody(built.body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!upstream.ok) {
      // The provider's own message is the useful half — "expected 16000 Hz,
      // got 8000 Hz" or "model not found" says exactly what to fix — so it
      // rides along, redacted and capped (describeSttFailure).
      const detail = await upstream.text().catch(() => '')
      return {
        ok: false,
        error: describeSttFailure(cfg.provider, upstream.status, detail, {
          key: cfg.key,
          retryAfter: upstream.headers.get('retry-after')
        })
      }
    }
    const data: unknown = await upstream.json().catch(() => null)
    if (data === null) {
      return { ok: false, error: `${STT_PROVIDERS[cfg.provider].name} answered with something that is not JSON.` }
    }
    return { ok: true, text: readTranscript(cfg.provider, data) }
  } catch (err) {
    return { ok: false, error: unreachable(cfg, built.url, err, timeoutMs) }
  }
}


/**
 * Whether dictation would reach the service `cfg` names — WITHOUT spending
 * anything. The sidecar is probed (any HTTP answer counts: it 405s an
 * OPTIONS); a hosted provider or custom server is asked its model or project
 * listing with the key (`keyCheckRequest`), which no plan bills. Never a
 * transcription: a Test press must not cost money.
 */
export async function testSpeechService(cfg: SttConfig, opts: SttCallOptions = {}): Promise<VoiceTestResult> {
  const spec = STT_PROVIDERS[cfg.provider]
  const timeoutMs = opts.timeoutMs ?? TEST_TIMEOUT_MS
  const send = opts.fetchImpl ?? fetch
  if (cfg.provider === 'sidecar') {
    const base = trimBase(cfg.sttUrl)
    if (!base) return { ok: false, tone: 'danger', message: 'No speech server address is set.' }
    try {
      await send(`${base}/transcribe`, { method: 'OPTIONS', signal: AbortSignal.timeout(timeoutMs) })
      return { ok: true, tone: 'success', message: `The speech server at ${base} is answering.` }
    } catch (err) {
      return { ok: false, tone: 'danger', message: unreachable(cfg, `${base}/transcribe`, err, timeoutMs) }
    }
  }
  const check = keyCheckRequest(cfg)
  if (!check) {
    const probe = buildSttRequest(cfg, new Uint8Array(64))
    return { ok: false, tone: 'danger', message: isRefusal(probe) ? probe.error : `Nothing to test for ${spec.name}.` }
  }
  try {
    const res = await send(check.url, { method: 'GET', headers: check.headers, signal: AbortSignal.timeout(timeoutMs) })
    if (res.ok) {
      if (cfg.provider === 'custom') {
        return {
          ok: true,
          tone: 'success',
          message: cfg.key.trim()
            ? 'The server answered and accepted the key.'
            : 'The server answered. It asked for no key.'
        }
      }
      return { ok: true, tone: 'success', message: `${spec.name} accepted the key. Nothing was billed: this only listed models.` }
    }
    const body = await res.text().catch(() => '')
    // A custom server that has no model listing is still a server that answered.
    if (cfg.provider === 'custom' && (res.status === 404 || res.status === 405)) {
      return {
        ok: true,
        tone: 'warning',
        message: `The server answered, but has no /models route to check a key against (${res.status}). Dictate once to be sure.`
      }
    }
    // ElevenLabs refuses a key scoped to speech-to-text only on its model list; the key itself is real.
    if (cfg.provider === 'elevenlabs' && res.status === 401 && /missing_permissions/i.test(body)) {
      return {
        ok: true,
        tone: 'warning',
        message: 'ElevenLabs knows this key, but it is not allowed to list models. If it has speech-to-text access, dictation will work.'
      }
    }
    return {
      ok: false,
      tone: 'danger',
      message: describeSttFailure(cfg.provider, res.status, body, { key: cfg.key, retryAfter: res.headers.get('retry-after') })
    }
  } catch (err) {
    return { ok: false, tone: 'danger', message: unreachable(cfg, check.url, err, timeoutMs) }
  }
}
