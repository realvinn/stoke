/**
 * The `voice` settings block: its defaults and its repair.
 *
 * Pure and import-free apart from a type, so both processes use the one copy —
 * main's `hydrateSettings`, and the Voice panel's "an emptied box falls back to
 * the default" — and `verify:settings` runs it under node strip-types
 * (gotcha 78). Browser-only voice code lives in `voice.ts`, which the node
 * project excludes; nothing here may reach for an audio API (gotcha 27).
 */
import type { VoiceSettings } from './types.ts'
import { cleanModel, isSttProvider, STT_PROVIDER_IDS, type SttProviderId } from './speechProviders.ts'

/**
 * The speech sidecar's documented local port (`scripts/stt-sidecar.py`).
 * Nothing is contacted unless the microphone is actually used, and if nothing
 * is listening the person dictating gets a sentence naming this address and
 * saying it is not the microphone (`stt.ts`) rather than a silent failure.
 */
export const DEFAULT_STT_URL = 'http://127.0.0.1:17890'

/**
 * How long a Space press must last before Stoke's dictation records, and the
 * range a hand-edited value is held to. 250ms sits above a typing tap (measured
 * taps run 50–150ms) and well under the OS key-repeat delay a hold also proves
 * itself by (`spaceHold`, voiceRoute.ts).
 */
export const DEFAULT_HOLD_MS = 250
export const HOLD_MS_MIN = 150
export const HOLD_MS_MAX = 800

export const VOICE_DEFAULTS: VoiceSettings = {
  sttUrl: DEFAULT_STT_URL,
  provider: 'sidecar',
  model: '',
  baseUrl: '',
  keys: {},
  holdMs: DEFAULT_HOLD_MS,
  micDeviceId: null,
  micLabel: ''
}

/** A hold threshold from anything: a finite number, rounded and clamped, else the default. */
export function clampHoldMs(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_HOLD_MS
  return Math.min(HOLD_MS_MAX, Math.max(HOLD_MS_MIN, Math.round(v)))
}

/**
 * Repair a stored `voice` block, migrating the address from where it used to
 * live.
 *
 * `legacySttUrl` is the old `remote.sttUrl`. A settings file written before
 * Settings → Voice had the field has only that key, and must come back with
 * the same address rather than the default — someone who pointed dictation at
 * a speech box on their tailnet would otherwise find it silently re-aimed at
 * localhost. The stored `voice.sttUrl` wins whenever it is a string, because
 * `remote.sttUrl` is only a mirror of it from now on (types.ts).
 *
 * Rebuilds the object from named keys rather than spreading its input, the
 * same shape as `clampTerminal`: junk in a hand-edited file cannot ride
 * through, and a field added to VoiceSettings without a line here hydrates as
 * undefined — which is why the two are changed together.
 *
 * The empty string is kept, not defaulted. It is the only way to say "no
 * speech server" today, and it is what makes `sttStatus` answer `off` and the
 * phone say dictation is not set up, rather than probing a default nobody runs.
 */
export function clampVoice(raw: unknown, legacySttUrl?: unknown): VoiceSettings {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<
    Record<keyof VoiceSettings, unknown>
  >
  const sttUrl =
    typeof r.sttUrl === 'string'
      ? r.sttUrl.trim()
      : typeof legacySttUrl === 'string'
        ? legacySttUrl.trim()
        : VOICE_DEFAULTS.sttUrl
  /*
   * The microphone is a pair or nothing. An id with no label still works (the
   * label is only the fallback lookup), but a label with no id is a choice
   * nobody can act on, so it is dropped rather than kept as a ghost the picker
   * would show as "not connected" forever.
   */
  const micDeviceId = typeof r.micDeviceId === 'string' && r.micDeviceId.trim() ? r.micDeviceId : null
  const micLabel = micDeviceId && typeof r.micLabel === 'string' ? r.micLabel.trim() : ''
  return {
    sttUrl,
    /*
     * An unknown provider — a typo, or one a newer build added — is the
     * sidecar, never a guess at a hosted API: the default sends audio nowhere
     * it was not already going.
     */
    provider: isSttProvider(r.provider) ? r.provider : VOICE_DEFAULTS.provider,
    model: cleanModel(r.model),
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '',
    keys: clampSttKeys(r.keys),
    holdMs: clampHoldMs(r.holdMs),
    micDeviceId,
    micLabel
  }
}

/**
 * The per-provider keys, rebuilt from the provider ids this build knows —
 * never spread from the input, so neither junk nor a `__proto__` key rides
 * through. Trimmed like every other key (`hydrateProviders`); an empty one is
 * dropped, which is also how settings.json's scrubbed `''` reads (the vault
 * puts the real value back before hydrate, `applySecrets`). The sidecar has no
 * key to keep.
 */
export function clampSttKeys(raw: unknown): Partial<Record<SttProviderId, string>> {
  const out: Partial<Record<SttProviderId, string>> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  for (const id of STT_PROVIDER_IDS) {
    if (id === 'sidecar' || !Object.prototype.hasOwnProperty.call(r, id)) continue
    const v = r[id]
    if (typeof v === 'string' && v.trim()) out[id] = v.trim()
  }
  return out
}
