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
 * range a hand-edited value is held to.
 *
 * 500ms since 2026-10-04, from the owner: "I think we need to increase the hold
 * duration before activation". 250 sat above a typing tap (measured taps run
 * 50–150ms) but under a deliberate pause on the space bar, so a thinking pause
 * mid-sentence opened the microphone. The OS key-repeat does NOT prove a hold
 * any more (`spaceHold`, voiceRoute.ts): macOS's default repeat delay is 500ms
 * (measured), so a repeat that started the recorder cut every longer setting
 * back to it. Only the threshold starts a take; the ceiling went from 800 to
 * 1500 so a slow, deliberate hold is possible.
 */
export const DEFAULT_HOLD_MS = 500
export const HOLD_MS_MIN = 150
export const HOLD_MS_MAX = 1500

/**
 * The default before 2026-10-04. Every settings file from then holds it
 * EXPLICITLY — `hydrateSettings` writes the whole repaired block on the first
 * save of any field — so a new default alone would never reach anyone who had
 * ever saved a setting. `clampVoice` moves a stored 250 to `DEFAULT_HOLD_MS`
 * once, on a block from before `VOICE_FORMAT` 2.
 */
export const LEGACY_DEFAULT_HOLD_MS = 250

/**
 * The shape the `voice` block is stored in, written into it (`format`) so a
 * file from an earlier build can be told apart on its first read here — the
 * agents block's `AGENTS_FORMAT` pattern.
 *
 *   1  (no number) `holdMs` 250 was the default, and since hydrate writes every
 *      field, a stored 250 is the default nobody chose rather than a choice.
 *   2  The default is 500; a 250 stored from now on was picked in Settings and
 *      is kept.
 *
 * A file an older build rewrote loses the number (its clampVoice names no such
 * key) and a 250 in it is upgraded again — right for a file only that build
 * touched, and the price of a downgrade for a 250 picked on purpose here.
 */
export const VOICE_FORMAT = 2

/** The format a stored `voice.format` names; anything but a whole number ≥ 1 is 1. */
export function voiceFormatOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1
}

export const VOICE_DEFAULTS: VoiceSettings = {
  sttUrl: DEFAULT_STT_URL,
  provider: 'sidecar',
  model: '',
  baseUrl: '',
  keys: {},
  holdMs: DEFAULT_HOLD_MS,
  micDeviceId: null,
  micLabel: '',
  format: VOICE_FORMAT
}

/** A hold threshold from anything: a finite number, rounded and clamped, else the default. */
export function clampHoldMs(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_HOLD_MS
  return Math.min(HOLD_MS_MAX, Math.max(HOLD_MS_MIN, Math.round(v)))
}

/**
 * Settings → Voice's choices for the hold, each with words for what it feels
 * like under the thumb. A value set by hand that is not one of them is still
 * listed, as plain milliseconds (`holdChoices`), so the select never shows a
 * value it cannot name.
 */
export const HOLD_PRESETS: readonly { ms: number; feel: string }[] = [
  { ms: 250, feel: 'quick — a pause on Space can start it' },
  { ms: 350, feel: 'brisk' },
  { ms: 500, feel: 'a firm press' },
  { ms: 700, feel: 'deliberate' },
  { ms: 1000, feel: 'a full second' },
  { ms: 1500, feel: 'only a long, sure hold' }
]

/** One choice's label: "500 ms — a firm press (default)", or "420 ms" for a hand-set value. */
export function holdLabel(ms: number): string {
  const preset = HOLD_PRESETS.find((p) => p.ms === ms)
  const amount = ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`
  return `${amount}${preset ? ` — ${preset.feel}` : ''}${ms === DEFAULT_HOLD_MS ? ' (default)' : ''}`
}

/** The values the select lists: the presets, plus the saved one when it is none of them, in order. */
export function holdChoices(current: number): number[] {
  const presets = HOLD_PRESETS.map((p) => p.ms)
  return presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b)
}

/**
 * A stored threshold, brought from format `from` up to `VOICE_FORMAT`: a
 * format-1 block's exact 250 is the old default and becomes the new one; any
 * other value — and any 250 in a format-2 block — is the user's, clamped.
 */
export function upgradeHoldMs(raw: unknown, from: number): number {
  if (from < 2 && raw === LEGACY_DEFAULT_HOLD_MS) return DEFAULT_HOLD_MS
  return clampHoldMs(raw)
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
    holdMs: upgradeHoldMs(r.holdMs, voiceFormatOf(r.format)),
    micDeviceId,
    micLabel,
    // Upgraded above, so this build's number whatever was read: a second
    // hydrate of the result changes nothing (gotcha 116).
    format: VOICE_FORMAT
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
