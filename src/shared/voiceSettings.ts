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

/**
 * The speech sidecar's documented local port (`scripts/stt-sidecar.py`).
 * Nothing is contacted unless the microphone is actually used, and if nothing
 * is listening the person dictating gets a sentence naming this address and
 * saying it is not the microphone (`stt.ts`) rather than a silent failure.
 */
export const DEFAULT_STT_URL = 'http://127.0.0.1:17890'

export const VOICE_DEFAULTS: VoiceSettings = { sttUrl: DEFAULT_STT_URL }

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
  return { sttUrl }
}
