/**
 * The one place Stoke talks to the speech server.
 *
 * Two surfaces dictate — the phone, through the remote server's
 * `/api/transcribe` route, and the desktop, through an IPC handler — and both
 * arrive here. That is deliberate rather than tidy-minded: the sidecar has no
 * authentication of its own, so the rule "only the main process may reach it"
 * is a security property, and a second implementation is how such a rule stops
 * being true. It also means the timeout, the body cap and the error wording are
 * decided once instead of drifting between the two.
 *
 * Neither surface sends the audio itself here in any other shape: the WAV is
 * encoded in the browser (`src/shared/voice.ts`) because the sidecar validates
 * the RIFF header, and converting here would mean shipping ffmpeg.
 */

/**
 * A transcript, or a sentence to show the person who just spoke.
 *
 * Errors are strings rather than thrown, because every caller has to render
 * one: the phone turns it into an HTTP status, the desktop into a banner. A
 * rejected promise would make both of them re-derive the same message.
 */
export type SttResult = { ok: true; text: string } | { ok: false; error: string }

/**
 * What a dictated clip may weigh. Matched by the sidecar, and by the remote
 * server's own body reader, so a recording refused anywhere is refused
 * everywhere for the same stated reason.
 */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/**
 * Whisper on a long clip is slow but not unbounded; a first run also pays for
 * the model load. Two minutes is far past a push-to-talk utterance and still
 * short enough that a wedged sidecar surfaces as an error rather than a
 * microphone that never comes back.
 */
const TIMEOUT_MS = 120_000

/**
 * POST a 16-bit PCM WAV and read the transcript back.
 *
 * `sttUrl` is the sidecar's base address; `/transcribe` is appended. An empty
 * or absent one is not an error state to log — it is the shipped default for
 * anyone who has not set a speech server up — so it answers with the sentence
 * that tells them so.
 */
export async function transcribe(sttUrl: string | undefined, wav: Uint8Array): Promise<SttResult> {
  const base = sttUrl?.trim()
  if (!base) {
    return { ok: false, error: 'No speech server configured. Set one in Settings.' }
  }
  if (wav.byteLength === 0) return { ok: false, error: 'Nothing was recorded.' }
  if (wav.byteLength > MAX_AUDIO_BYTES) return { ok: false, error: 'Recording too large.' }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!upstream.ok) {
      // The sidecar's own message is the useful half — "expected 16000 Hz, got
      // 8000 Hz" says exactly what to fix — so pass it through rather than
      // flattening every upstream failure to one house sentence. Capped because
      // a misconfigured URL can answer with an entire HTML error page.
      const detail = (await upstream.text()).slice(0, 200)
      return { ok: false, error: `Speech server: ${upstream.status} ${detail}` }
    }
    const data = (await upstream.json()) as { text?: unknown }
    return { ok: true, text: typeof data.text === 'string' ? data.text.trim() : '' }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Speech server unreachable: ${why}` }
  }
}
