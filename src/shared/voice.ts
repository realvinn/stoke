/**
 * Dictation on the phone.
 *
 * Push-to-talk rather than continuous: the Web Speech API is the obvious
 * alternative and is wrong here twice over - Chrome sends the audio to Google,
 * and on iOS it breaks outright once the site is added to the home screen.
 * Recording locally and posting to Stoke keeps the audio on hardware the user
 * owns, and Stoke forwards it to the speech sidecar.
 *
 * The conversion to 16-bit PCM WAV happens here, in the browser, because the
 * sidecar validates the RIFF header and rejects anything else. Doing it on the
 * phone also sidesteps the container split - Safari records mp4/aac, Chrome
 * records webm/opus - since `decodeAudioData` reads both and we re-encode from
 * raw samples either way.
 */

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']

/** What Whisper wants. Resampling here saves the sidecar a conversion. */
const TARGET_RATE = 16_000

export function voiceSupported(): boolean {
  return Boolean(
    navigator.mediaDevices &&
      typeof MediaRecorder !== 'undefined' &&
      typeof OfflineAudioContext !== 'undefined' &&
      (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
  )
}

function audioContext(): AudioContext {
  const Ctor =
    window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  return new Ctor()
}

/** Mono 16 kHz 16-bit PCM in a RIFF container. */
function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    // Asymmetric on purpose: -1 maps to -32768, +1 to 32767.
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return buffer
}

async function toWav(blob: Blob): Promise<ArrayBuffer> {
  const ctx = audioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    void ctx.close()
  }

  // Rendering into a one-channel context downmixes and resamples in one pass.
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return encodeWav(rendered.getChannelData(0), TARGET_RATE)
}

export interface Recorder {
  start(): Promise<void>
  /** Stops, converts and uploads. Returns the transcript, or '' if silent. */
  finish(): Promise<string>
  cancel(): void
  recording(): boolean
}

export function createRecorder(): Recorder {
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []

  const release = (): void => {
    recorder?.stream.getTracks().forEach((t) => t.stop())
    recorder = null
    chunks = []
  }

  return {
    recording: () => recorder?.state === 'recording',

    async start() {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
      // isTypeSupported can be optimistic, so fall back to the browser default
      // rather than forcing a type it claims to know and then mishandles.
      const mimeType = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunks = []
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      recorder.start()
    },

    cancel: release,

    async finish() {
      const active = recorder
      if (!active || active.state === 'inactive') {
        release()
        return ''
      }

      const blob = await new Promise<Blob>((resolve) => {
        active.onstop = () => resolve(new Blob(chunks, { type: active.mimeType || 'audio/webm' }))
        active.stop()
      })
      release()

      // Under about a tenth of a second is a mis-tap, not speech.
      if (blob.size < 1024) return ''

      const wav = await toWav(blob)
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav
      })
      const data = (await res.json()) as { text?: string; error?: string }
      if (!res.ok) throw new Error(data.error || `Transcription failed (${res.status})`)
      return (data.text || '').trim()
    }
  }
}
