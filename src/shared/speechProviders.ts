/**
 * Where Stoke's dictation can send a recording, and exactly what each place
 * wants on the wire.
 *
 * Until this module there was one backend: the speech sidecar the user runs
 * (`scripts/stt-sidecar.py`), sent a raw WAV at `/transcribe`. Now a person can
 * also paste a key for a hosted speech-to-text API, or point Stoke at any
 * OpenAI-compatible server (speaches, LocalAI, vLLM). Every provider takes the
 * WAV the browser already makes — 16 kHz mono 16-bit PCM (`voice.ts`) — so the
 * differences are all here: the URL, the auth header, the body shape, where the
 * text comes back, and how large a clip each will take.
 *
 * Pure and import-free apart from types, so both processes use the one table —
 * main's `stt.ts` builds and sends the request, Settings → Voice lists the
 * providers, their models and the honest "audio leaves this machine" line — and
 * `verify:voice` runs every builder under node strip-types (gotchas 27, 78).
 * The request is DATA (`SttRequest`), not a `fetch` call, so the suite can hold
 * every URL, header and field name without a network; `stt.ts` turns it into a
 * fetch with global FormData/Blob, no SDK.
 *
 * Keys go in headers only — never a URL, an argv or a log. Gemini also accepts
 * `?key=`, and that is exactly the form this module never builds; the suite
 * asserts no provider's URL ever contains the key.
 *
 * Wire formats were taken from each vendor's docs on 2026-09-30
 * (/tmp/stoke-research/stt-providers.md). Where those docs did not settle
 * something, the choice below is the one they DO show, and the comment says
 * what stayed unverified. Provider APIs drift; a changed one surfaces as that
 * provider's own error passed through (key-redacted, capped), never a silent
 * empty transcript.
 */
import type { VoiceSettings } from './types.ts'

export const STT_PROVIDER_IDS = [
  'sidecar',
  'openai',
  'groq',
  'deepgram',
  'elevenlabs',
  'mistral',
  'assemblyai',
  'gemini',
  'custom'
] as const
export type SttProviderId = (typeof STT_PROVIDER_IDS)[number]

export function isSttProvider(v: unknown): v is SttProviderId {
  return typeof v === 'string' && (STT_PROVIDER_IDS as readonly string[]).includes(v)
}

/** How the key travels. `raw` is AssemblyAI's `Authorization: <key>` with no scheme. */
export type SttAuth = 'none' | 'bearer' | 'token' | 'raw' | 'xi-api-key' | 'x-goog-api-key'
export type SttBodyKind = 'raw-wav' | 'multipart' | 'json-base64'

export interface SttProviderSpec {
  id: SttProviderId
  /** The picker's label. */
  label: string
  /** The provider in a sentence: "The OpenAI key was refused". */
  name: string
  /**
   * A company's servers transcribe the audio. False for the sidecar and a
   * custom server, whose destination is judged from their address instead
   * (`audioDestination`).
   */
  hosted: boolean
  /** No trailing slash. The sidecar's and a custom server's come from settings. */
  defaultBaseUrl: string
  /** Used when `voice.model` is empty. `''` for the sidecar, which picks its own. */
  defaultModel: string
  /** Offered in the picker, default first. Anything else can still be typed. */
  models: readonly string[]
  auth: SttAuth
  /** A request without a key is refused before it is sent. False for the sidecar and custom. */
  keyRequired: boolean
  body: SttBodyKind
  /** Where the transcript is in the answer, for the reader and for the docs. */
  textPath: string
  /**
   * The largest WAV Stoke will send, in bytes — the vendor's own limit where
   * one bites, with room for the multipart envelope, else Stoke's 25 MiB.
   */
  maxBytes: number
  /** The longest clip, in seconds, where the vendor caps duration rather than size. */
  maxSeconds: number | null
  /** Where a key is made, printed as text in Settings. */
  keysAt: string
  /** One sentence Settings shows under the picker, or ''. */
  note: string
}

/** Stoke's own cap: the phone's body reader and the sidecar's. */
export const STOKE_MAX_AUDIO_BYTES = 25 * 1024 * 1024

/**
 * OpenAI refuses a REQUEST over 26,214,400 bytes (413 "Maximum content size
 * limit (26214400) exceeded") — the whole multipart body, not the file. A WAV
 * right at Stoke's own 25 MiB cap plus its envelope would be refused, so every
 * multipart provider is held 64 KiB under it; the envelope is a few hundred bytes.
 */
const MULTIPART_MAX_BYTES = STOKE_MAX_AUDIO_BYTES - 64 * 1024

/** Groq documents "25 MB" on the free tier; read as decimal, the tighter reading. */
const GROQ_MAX_BYTES = 25_000_000 - 64 * 1024

/**
 * Gemini caps the whole inline request at 20 MB, base64 included, and base64
 * is 4/3 of the bytes. Decimal 20 MB, less 64 KiB for the JSON around it.
 */
const GEMINI_MAX_BYTES = Math.floor(((20_000_000 - 64 * 1024) * 3) / 4)

/** AssemblyAI's synchronous endpoint takes 80 ms to 120 s of audio per request. */
const ASSEMBLYAI_MAX_SECONDS = 120

/** 16 kHz × 2 bytes × 1 channel, the WAV `voice.ts` encodes. */
export const WAV_BYTES_PER_SECOND = 32_000
const WAV_HEADER_BYTES = 44

export const STT_PROVIDERS: Readonly<Record<SttProviderId, SttProviderSpec>> = {
  sidecar: {
    id: 'sidecar',
    label: 'Your own speech server (Stoke’s sidecar)',
    name: 'Speech server',
    hosted: false,
    defaultBaseUrl: 'http://127.0.0.1:17890',
    defaultModel: '',
    models: [],
    auth: 'none',
    keyRequired: false,
    body: 'raw-wav',
    textPath: 'text',
    maxBytes: STOKE_MAX_AUDIO_BYTES,
    maxSeconds: null,
    keysAt: '',
    note: ''
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    name: 'OpenAI',
    hosted: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    // gpt-transcribe (2026-07-28) is OpenAI's recommended file model now.
    defaultModel: 'gpt-transcribe',
    models: ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
    auth: 'bearer',
    keyRequired: true,
    body: 'multipart',
    textPath: 'text',
    maxBytes: MULTIPART_MAX_BYTES,
    maxSeconds: null,
    keysAt: 'platform.openai.com/api-keys',
    note: ''
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    name: 'Groq',
    hosted: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    // distil-whisper-large-v3-en was shut down on 2025-08-23.
    defaultModel: 'whisper-large-v3-turbo',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    auth: 'bearer',
    keyRequired: true,
    body: 'multipart',
    textPath: 'text',
    maxBytes: GROQ_MAX_BYTES,
    maxSeconds: null,
    keysAt: 'console.groq.com/keys',
    note: 'Groq bills every request as at least 10 seconds of audio.'
  },
  deepgram: {
    id: 'deepgram',
    label: 'Deepgram',
    name: 'Deepgram',
    hosted: true,
    defaultBaseUrl: 'https://api.deepgram.com/v1',
    // Flux is /v2/listen WebSocket only; nova-3 is the /v1/listen batch model.
    defaultModel: 'nova-3',
    models: ['nova-3', 'nova-3-medical', 'nova-2'],
    auth: 'token',
    keyRequired: true,
    body: 'raw-wav',
    textPath: 'results.channels[0].alternatives[0].transcript',
    // Deepgram takes 2 GB; Stoke's own cap is the one that bites.
    maxBytes: STOKE_MAX_AUDIO_BYTES,
    maxSeconds: null,
    keysAt: 'console.deepgram.com',
    note: ''
  },
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    name: 'ElevenLabs',
    hosted: true,
    defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    // scribe_v1 was removed on 2026-07-09.
    defaultModel: 'scribe_v2',
    models: ['scribe_v2'],
    auth: 'xi-api-key',
    keyRequired: true,
    body: 'multipart',
    textPath: 'text',
    maxBytes: MULTIPART_MAX_BYTES,
    maxSeconds: null,
    keysAt: 'elevenlabs.io/app/settings/api-keys',
    note: ''
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral (Voxtral)',
    name: 'Mistral',
    hosted: true,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    // The alias the docs name; the dated ids disagree between pages.
    defaultModel: 'voxtral-mini-latest',
    models: ['voxtral-mini-latest'],
    auth: 'bearer',
    keyRequired: true,
    body: 'multipart',
    textPath: 'text',
    // Mistral's own byte limit and a WAV mention are not in its docs (UNVERIFIED);
    // it is OpenAI-SDK compatible, so it is held to the multipart cap.
    maxBytes: MULTIPART_MAX_BYTES,
    maxSeconds: null,
    keysAt: 'console.mistral.ai/api-keys',
    note: ''
  },
  assemblyai: {
    id: 'assemblyai',
    label: 'AssemblyAI',
    name: 'AssemblyAI',
    hosted: true,
    defaultBaseUrl: 'https://sync.assemblyai.com/v1',
    // Sent as the X-AAI-Model header, which the sync endpoint requires.
    defaultModel: 'universal-3-5-pro',
    models: ['universal-3-5-pro'],
    auth: 'raw',
    keyRequired: true,
    body: 'multipart',
    textPath: 'text',
    maxBytes: WAV_HEADER_BYTES + ASSEMBLYAI_MAX_SECONDS * WAV_BYTES_PER_SECOND,
    maxSeconds: ASSEMBLYAI_MAX_SECONDS,
    keysAt: 'assemblyai.com/dashboard/api-keys',
    // Its sync endpoint has no language detection and treats an unset language as English.
    note: 'AssemblyAI’s instant endpoint transcribes English and takes clips up to 2 minutes.'
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    name: 'Gemini',
    hosted: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    /*
     * The default is a general model told to transcribe, because inline audio
     * (`inlineData`) is documented with gemini-3.8-flash. gemini-3.5-transcribe
     * is offered too, but its page shows only uploaded files (`fileData`) — that
     * it takes inline audio is UNVERIFIED, and a refusal would come back as
     * Gemini's own 400, passed through.
     */
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-transcribe'],
    auth: 'x-goog-api-key',
    keyRequired: true,
    body: 'json-base64',
    textPath: 'candidates[0].content.parts[].text',
    maxBytes: GEMINI_MAX_BYTES,
    maxSeconds: null,
    keysAt: 'aistudio.google.com/apikey',
    note: 'A general Gemini model is asked to transcribe word for word; the transcribe model is the dedicated one.'
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    name: 'Custom server',
    hosted: false,
    // speaches' port. Only a placeholder: an empty address is "not set up".
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'whisper-1',
    models: [],
    auth: 'bearer',
    keyRequired: false,
    body: 'multipart',
    textPath: 'text',
    // vLLM's VLLM_MAX_AUDIO_CLIP_FILESIZE_MB defaults to 25.
    maxBytes: MULTIPART_MAX_BYTES,
    maxSeconds: null,
    keysAt: '',
    note: 'speaches, LocalAI, vLLM or any server with OpenAI’s /audio/transcriptions. speaches wants a model it has downloaded, e.g. Systran/faster-whisper-small.'
  }
}

/* ------------------------------------------------------------ the config */

/** Everything a request needs, read from `voice` per call (`sttConfigOf`). */
export interface SttConfig {
  provider: SttProviderId
  /** `''` is the provider's default model. */
  model: string
  /** A custom server's base URL (…/v1). Ignored by every other provider. */
  baseUrl: string
  /** The sidecar's address. Ignored by every other provider. */
  sttUrl: string
  /** This provider's key, or `''`. Never logged, never in a URL. */
  key: string
}

export function sttConfigOf(voice: VoiceSettings): SttConfig {
  return {
    provider: voice.provider,
    model: voice.model,
    baseUrl: voice.baseUrl,
    sttUrl: voice.sttUrl,
    key: (voice.provider === 'sidecar' ? '' : voice.keys[voice.provider]) ?? ''
  }
}

/**
 * A config from anything — the renderer's Test button sends its drafts, and a
 * value crossing IPC is not trusted to have the shape its type claims.
 */
export function sttConfigFrom(raw: unknown): SttConfig {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  return {
    provider: isSttProvider(r.provider) ? r.provider : 'sidecar',
    model: cleanModel(r.model),
    baseUrl: str(r.baseUrl),
    sttUrl: str(r.sttUrl),
    key: str(r.key)
  }
}

/** A model id with no control characters, trimmed and capped; `''` for anything else. */
export function cleanModel(v: unknown): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
}

export function modelFor(cfg: SttConfig): string {
  const spec = STT_PROVIDERS[cfg.provider]
  let m = cfg.model.trim() || spec.defaultModel
  // Gemini's own listings name models `models/<id>`; the URL wants the id.
  if (cfg.provider === 'gemini') m = m.replace(/^models\//, '')
  return m
}

/** Trailing slashes off, whitespace off. */
export function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

const SCHEME = /^https?:\/\//i

/**
 * A custom server's base, normalised: no trailing slash, and a bare origin
 * gains `/v1` — `http://127.0.0.1:8000` is how everyone types speaches'
 * address, and its routes are under `/v1`. Null when it is not an http(s) URL.
 */
export function customBase(url: string): string | null {
  const t = trimBase(url)
  if (!t || !SCHEME.test(t)) return null
  try {
    const u = new URL(t)
    if (u.pathname === '/' || u.pathname === '') return `${t}/v1`
  } catch {
    return null
  }
  return t
}

/** The base a provider's paths hang off, or null when it has none configured. */
export function baseFor(cfg: SttConfig): string | null {
  if (cfg.provider === 'sidecar') return trimBase(cfg.sttUrl) || null
  if (cfg.provider === 'custom') return customBase(cfg.baseUrl)
  return STT_PROVIDERS[cfg.provider].defaultBaseUrl
}

/* ----------------------------------------------------------- the request */

export type SttPart =
  | { name: string; value: string }
  | { name: string; file: Uint8Array; type: string; filename: string }

export type SttBody =
  | { kind: 'raw'; type: string; bytes: Uint8Array }
  | { kind: 'multipart'; parts: SttPart[] }
  | { kind: 'json'; value: unknown }

export interface SttRequest {
  method: 'POST'
  url: string
  /** Never a content-type for multipart: fetch writes the boundary. */
  headers: Record<string, string>
  body: SttBody
}

/**
 * Why a request was not built. `unset` is the one refusal that is not this
 * clip's fault — nothing is configured — and is what makes the phone answer
 * 503 ("not set up") instead of 502.
 */
export interface SttRefusal {
  error: string
  unset?: true
}

/** A header value fetch will accept: printable ASCII, no spaces, nothing a paste could smuggle a line into. */
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/
const HEADER_SAFE_VALUE = /^[\x20-\x7e]+$/

function authHeaders(auth: SttAuth, key: string): Record<string, string> {
  if (!key) return {}
  switch (auth) {
    case 'bearer':
      return { authorization: `Bearer ${key}` }
    case 'token':
      return { authorization: `Token ${key}` }
    case 'raw':
      return { authorization: key }
    case 'xi-api-key':
      return { 'xi-api-key': key }
    case 'x-goog-api-key':
      return { 'x-goog-api-key': key }
    default:
      return {}
  }
}

/** The WAV's duration, from its size: 16 kHz mono 16-bit, 44-byte header. */
export function wavSeconds(byteLength: number): number {
  return Math.max(0, byteLength - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND
}

function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function clipLength(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`
}

/** The unset sentence per provider: what to add, and where. */
function unsetFor(cfg: SttConfig): SttRefusal {
  const spec = STT_PROVIDERS[cfg.provider]
  if (cfg.provider === 'sidecar') {
    return { error: 'No speech server is set for Stoke’s dictation. Add one in Settings → Voice.', unset: true }
  }
  if (cfg.provider === 'custom') {
    return { error: 'No address is set for the custom speech server. Add one in Settings → Voice.', unset: true }
  }
  return { error: `No ${spec.name} key is set for Stoke’s dictation. Paste one in Settings → Voice.`, unset: true }
}

/** Read to Gemini's non-transcribe models, with temperature 0. */
export const GEMINI_TRANSCRIBE_PROMPT =
  'Transcribe this audio verbatim. Output only the words spoken, with punctuation — no preamble, no notes, no quotes. If nothing is said, output nothing.'

/**
 * The request for one clip, or why there is none.
 *
 * Nothing here reads settings or the network: `cfg` is what `sttConfigOf` read
 * for THIS call, and the result is a description `stt.ts` sends.
 */
export function buildSttRequest(cfg: SttConfig, wav: Uint8Array): SttRequest | SttRefusal {
  const spec = STT_PROVIDERS[cfg.provider]
  const base = baseFor(cfg)
  if (!base) {
    if (cfg.provider === 'custom' && cfg.baseUrl.trim()) {
      return { error: 'The custom speech server’s address must start with http:// or https://. Fix it in Settings → Voice.' }
    }
    return unsetFor(cfg)
  }
  const key = cfg.provider === 'sidecar' ? '' : cfg.key.trim()
  if (spec.keyRequired && !key) return unsetFor(cfg)
  if (key && !HEADER_SAFE_KEY.test(key)) {
    return { error: `The ${spec.name} key has a character no key contains — paste it again in Settings → Voice.` }
  }
  if (wav.byteLength === 0) return { error: 'Nothing was recorded.' }
  // Length first: where a vendor caps duration, its byte cap is only that duration in bytes, and seconds are what a person can act on.
  if (spec.maxSeconds !== null && wavSeconds(wav.byteLength) > spec.maxSeconds) {
    return {
      error: `Recording too long for ${spec.name}: ${clipLength(wavSeconds(wav.byteLength))}, and it takes at most ${clipLength(spec.maxSeconds)} per clip.`
    }
  }
  if (wav.byteLength > spec.maxBytes) {
    return cfg.provider === 'sidecar'
      ? { error: 'Recording too large.' }
      : { error: `Recording too large for ${spec.name}: ${megabytes(wav.byteLength)}, and it takes at most ${megabytes(spec.maxBytes)}.` }
  }

  const model = modelFor(cfg)
  if (model && !HEADER_SAFE_VALUE.test(model)) {
    return { error: `The model “${model}” has characters no model id contains. Fix it in Settings → Voice.` }
  }
  const headers = authHeaders(spec.auth, key)
  const file = (name: string): SttPart => ({ name, file: wav, type: 'audio/wav', filename: 'dictation.wav' })

  switch (cfg.provider) {
    case 'sidecar':
      return {
        method: 'POST',
        url: `${base}/transcribe`,
        headers: { 'content-type': 'audio/wav' },
        body: { kind: 'raw', type: 'audio/wav', bytes: wav }
      }
    case 'openai':
    case 'groq':
    case 'custom':
      // `response_format=json` is `{ text }` on all three; no `language`, so each detects it.
      return {
        method: 'POST',
        url: `${base}/audio/transcriptions`,
        headers,
        body: { kind: 'multipart', parts: [file('file'), { name: 'model', value: model }, { name: 'response_format', value: 'json' }] }
      }
    case 'mistral':
      // Mistral's documented fields do not include response_format; `.text` is its default answer.
      return {
        method: 'POST',
        url: `${base}/audio/transcriptions`,
        headers,
        body: { kind: 'multipart', parts: [file('file'), { name: 'model', value: model }] }
      }
    case 'elevenlabs':
      /*
       * `file_format` stays unset (`other`): `pcm_s16le_16` is exactly these
       * samples, but whether it tolerates the RIFF header is UNVERIFIED. No
       * `(laughter)` tags in dictated text.
       */
      return {
        method: 'POST',
        url: `${base}/speech-to-text`,
        headers,
        body: {
          kind: 'multipart',
          parts: [{ name: 'model_id', value: model }, file('file'), { name: 'tag_audio_events', value: 'false' }]
        }
      }
    case 'assemblyai':
      return {
        method: 'POST',
        url: `${base}/transcribe`,
        headers: { ...headers, 'x-aai-model': model },
        body: { kind: 'multipart', parts: [file('audio')] }
      }
    case 'deepgram': {
      /*
       * The raw file, not multipart. Unset, `language` means `en`, so
       * `detect_language=true` (documented for Nova pre-recorded) keeps the
       * sidecar's "whatever you speak" behaviour; `smart_format` punctuates.
       */
      const q = new URLSearchParams({ model, smart_format: 'true', detect_language: 'true' })
      return {
        method: 'POST',
        url: `${base}/listen?${q.toString()}`,
        headers: { ...headers, 'content-type': 'audio/wav' },
        body: { kind: 'raw', type: 'audio/wav', bytes: wav }
      }
    }
    case 'gemini': {
      const audio = { inlineData: { mimeType: 'audio/wav', data: base64Of(wav) } }
      const dedicated = /transcribe/i.test(model)
      return {
        method: 'POST',
        url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
        headers: { ...headers, 'content-type': 'application/json' },
        body: {
          kind: 'json',
          value: dedicated
            ? {
                contents: [{ role: 'user', parts: [audio] }],
                generationConfig: { audioTranscriptionConfig: { languageCodes: [] } }
              }
            : {
                contents: [{ role: 'user', parts: [{ text: GEMINI_TRANSCRIBE_PROMPT }, audio] }],
                generationConfig: { temperature: 0 }
              }
        }
      }
    }
  }
}

export function isRefusal(r: SttRequest | SttRefusal): r is SttRefusal {
  return 'error' in r
}

/* ---------------------------------------------------------- the key test */

/**
 * A request that proves a key without spending anything: each vendor's model
 * or project listing, which no plan bills. The sidecar has none — it has no
 * key — and is probed instead (`stt.ts`). Null when there is nothing to ask:
 * no address, or a key a hosted provider needs and does not have.
 *
 * AssemblyAI's is a one-item transcript listing on its async API; billing is
 * per audio hour, so a listing costs nothing (that it is free is inferred, not
 * stated). ElevenLabs may refuse an STT-only scoped key here with
 * `missing_permissions`, which `stt.ts` reads as "known key, narrow scope".
 */
export function keyCheckRequest(cfg: SttConfig): { url: string; headers: Record<string, string> } | null {
  const spec = STT_PROVIDERS[cfg.provider]
  if (cfg.provider === 'sidecar') return null
  const base = baseFor(cfg)
  if (!base) return null
  const key = cfg.key.trim()
  if (spec.keyRequired && !key) return null
  if (key && !HEADER_SAFE_KEY.test(key)) return null
  const headers = authHeaders(spec.auth, key)
  switch (cfg.provider) {
    case 'deepgram':
      return { url: `${base}/projects`, headers }
    case 'assemblyai':
      return { url: 'https://api.assemblyai.com/v2/transcript?limit=1', headers }
    default:
      return { url: `${base}/models`, headers }
  }
}

/**
 * Whether dictation is ready, without a paid call: the status the phone's
 * `/api/host` and Settings' pill show. A server Stoke can reach for free (the
 * sidecar, a custom one) is probed at `url` — any HTTP answer counts; a hosted
 * provider is ready when it has a key, because the only way to know more is a
 * request, and that is the Test button's job, on a press.
 */
export function sttReadiness(cfg: SttConfig): { kind: 'probe'; url: string } | { kind: 'ready' } | { kind: 'off' } {
  const spec = STT_PROVIDERS[cfg.provider]
  if (cfg.provider === 'sidecar' || cfg.provider === 'custom') {
    const base = baseFor(cfg)
    if (!base) return { kind: 'off' }
    return { kind: 'probe', url: cfg.provider === 'sidecar' ? `${base}/transcribe` : `${base}/audio/transcriptions` }
  }
  return spec.keyRequired && !cfg.key.trim() ? { kind: 'off' } : { kind: 'ready' }
}

/* ---------------------------------------------------------- the answer */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * The transcript out of a provider's JSON answer, trimmed; `''` when it is not
 * there — a clip with no speech is an ordinary answer, not an error.
 */
export function readTranscript(provider: SttProviderId, json: unknown): string {
  if (!isRecord(json)) return ''
  switch (provider) {
    case 'deepgram': {
      const results = json.results
      if (!isRecord(results) || !Array.isArray(results.channels)) return ''
      const channel = results.channels[0]
      if (!isRecord(channel) || !Array.isArray(channel.alternatives)) return ''
      const alt = channel.alternatives[0]
      return isRecord(alt) && typeof alt.transcript === 'string' ? alt.transcript.trim() : ''
    }
    case 'gemini': {
      if (!Array.isArray(json.candidates)) return ''
      const first = json.candidates[0]
      if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) return ''
      return first.content.parts
        .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
        .join('')
        .trim()
    }
    default:
      return typeof json.text === 'string' ? json.text.trim() : ''
  }
}

/* ---------------------------------------------------------- the failures */

export type SttErrorKind = 'key' | 'credit' | 'too-large' | 'rate' | 'upstream' | 'other'

/**
 * What an HTTP failure means, per provider. The table is the vendors' own:
 * Gemini says a bad key with a 400 carrying `API_KEY_INVALID`, Deepgram's 402
 * and OpenAI's 429 `credit_balance_exhausted` are money rather than rate, and
 * Groq's 498 is capacity.
 */
export function classifySttError(provider: SttProviderId, status: number, body: string): SttErrorKind {
  if (status === 401 || status === 403) return 'key'
  if (provider === 'gemini' && status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) return 'key'
  if (status === 402) return 'credit'
  if (status === 429 && /credit_balance|insufficient_quota|spend_limit|billing/i.test(body)) return 'credit'
  if (status === 413 || /audio_too_large|request payload size exceeds|too large/i.test(body)) return 'too-large'
  if (status === 429 || status === 498 || /capacity_exceeded/i.test(body)) return 'rate'
  if (status >= 500) return 'upstream'
  return 'other'
}

/** Every occurrence of the key out of a string bound for a banner. */
export function redactKey(text: string, key: string): string {
  const k = key.trim()
  if (k.length < 4) return text
  return text.split(k).join('[key]')
}

/**
 * The provider's own sentence out of an error body, where it has one: OpenAI,
 * Groq and Mistral say `{error:{message}}`, Deepgram `{err_msg}` or
 * `{message}`, ElevenLabs `{detail:{message}}`, AssemblyAI `{error}` or
 * `{detail}`, Gemini `{error:{message}}`. Anything else — HTML, plain text —
 * comes back as it was.
 */
export function upstreamMessage(body: string): string {
  let j: unknown
  try {
    j = JSON.parse(body)
  } catch {
    return body
  }
  if (!isRecord(j)) return body
  const candidates: unknown[] = [
    isRecord(j.error) ? j.error.message : j.error,
    j.err_msg,
    j.message,
    isRecord(j.detail) ? j.detail.message : j.detail
  ]
  const found = candidates.find((c): c is string => typeof c === 'string' && c.trim() !== '')
  return found ?? body
}

/**
 * One sentence for the person who just spoke, from an HTTP failure.
 *
 * The provider's own words ride along — "expected 16000 Hz" or "model not
 * found" says what to fix — but capped at 200 characters (a wrong URL can
 * answer with a whole HTML page) and with the key cut out first: nothing puts
 * a key in a banner, even one a provider echoes back.
 */
export function describeSttFailure(
  provider: SttProviderId,
  status: number,
  body: string,
  opts: { key?: string; retryAfter?: string | null } = {}
): string {
  const spec = STT_PROVIDERS[provider]
  const words = (text: string): string => redactKey(text, opts.key ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  // The sidecar has no key and speaks for itself; its wording is the one the phone has always shown.
  if (provider === 'sidecar') return `Speech server: ${status} ${words(body)}`.trim()
  const detail = words(upstreamMessage(body))
  const said = detail ? `: ${detail}` : ''
  switch (classifySttError(provider, status, body)) {
    case 'key':
      return `The ${spec.name} key was refused (${status}${said}). Check it in Settings → Voice.`
    case 'credit':
      return `${spec.name} refused the request: the account is out of credit or over its spending limit (${status}).`
    case 'too-large':
      return `The recording is too large for ${spec.name} (${status}).`
    case 'rate': {
      const wait = Number(opts.retryAfter)
      const when = Number.isFinite(wait) && wait > 0 ? `in ${Math.ceil(wait)} s` : 'in a moment'
      return `${spec.name} is rate-limiting this key (${status}). Try again ${when}.`
    }
    case 'upstream':
      return `${spec.name} had a problem on its side (${status}${said}). Try again in a moment.`
    default:
      return `${spec.name}: ${status}${said}`
  }
}

/* ------------------------------------------------------ where audio goes */

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/**
 * The honest line Settings shows under the picker: whether a recording leaves
 * this machine, and for whom. A hosted provider always does; the sidecar and a
 * custom server do unless their address is loopback.
 */
export function audioDestination(cfg: SttConfig): { leaves: boolean; line: string } {
  const spec = STT_PROVIDERS[cfg.provider]
  if (spec.hosted) {
    const host = hostOf(spec.defaultBaseUrl) ?? spec.name
    return {
      leaves: true,
      line: `Audio leaves this machine for ${spec.name}: each recording is sent to ${host}, transcribed there and billed to your key.`
    }
  }
  const base = baseFor(cfg)
  const host = base ? hostOf(base) : null
  if (!host) return { leaves: false, line: 'Nothing is sent until an address is set.' }
  if (isLoopbackHost(host)) return { leaves: false, line: 'Audio stays on this machine: the speech server is at a local address.' }
  return { leaves: true, line: `Audio leaves this machine for ${host}, the server at that address.` }
}

/* ---------------------------------------------------------------- base64 */

const B64 = Uint8Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', (c) => c.charCodeAt(0))
const PAD = 61 // '='

/**
 * Standard base64, for Gemini's `inlineData`. No `Buffer` (this runs in the
 * browser's type world too) and no `btoa` over a binary string, which would
 * build a second 15 MB string first. Chunked so no single decode is huge; the
 * output is ASCII, so a UTF-8 TextDecoder reads it byte for byte.
 */
export function base64Of(bytes: Uint8Array): string {
  const CHUNK = 3 * 16_384
  const out = new Uint8Array(4 * 16_384)
  const decoder = new TextDecoder()
  const parts: string[] = []
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK)
    let o = 0
    let i = start
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
      out[o++] = B64[n >> 18]
      out[o++] = B64[(n >> 12) & 63]
      out[o++] = B64[(n >> 6) & 63]
      out[o++] = B64[n & 63]
    }
    const left = end - i
    if (left === 1) {
      const n = bytes[i] << 16
      out[o++] = B64[n >> 18]
      out[o++] = B64[(n >> 12) & 63]
      out[o++] = PAD
      out[o++] = PAD
    } else if (left === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
      out[o++] = B64[n >> 18]
      out[o++] = B64[(n >> 12) & 63]
      out[o++] = B64[(n >> 6) & 63]
      out[o++] = PAD
    }
    parts.push(decoder.decode(out.subarray(0, o)))
  }
  return parts.join('')
}
