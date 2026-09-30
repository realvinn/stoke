/**
 * Dictation, for both surfaces that have it: the phone and the desktop.
 *
 * Push-to-talk rather than continuous: the Web Speech API is the obvious
 * alternative and is wrong here twice over - Chrome sends the audio to Google,
 * and on iOS it breaks outright once the site is added to the home screen.
 * Recording locally and handing the bytes to Stoke keeps the audio on hardware
 * the user owns, and Stoke forwards it to the speech sidecar.
 *
 * The conversion to 16-bit PCM WAV happens here, in the browser, because the
 * sidecar validates the RIFF header and rejects anything else. Doing it on the
 * client also sidesteps the container split - Safari records mp4/aac, Chrome
 * records webm/opus - since `decodeAudioData` reads both and we re-encode from
 * raw samples either way.
 *
 * It lives in `src/shared` rather than beside either caller because the two
 * differ only in how the finished WAV *travels*: the phone POSTs it to
 * `/api/transcribe` over the remote server, the desktop hands it to the main
 * process over IPC. Everything before that - permission, container choice,
 * decode, downmix, resample, encode - is identical and was worth having in one
 * place rather than two that drift. So the transport is injected
 * (`createRecorder`'s `upload`) and nothing here knows which surface it is on;
 * that is also why this file must stay free of Node and Electron imports, since
 * `tsconfig.web.json` gives `src/shared` no Node types.
 */

import { isMissingDevice, notConnected, pickDevice, type MicDevice, type SavedMic } from './micDevice.ts'
import { levelFromSamples, smoothLevel } from './voiceLevel.ts'

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
  /**
   * Opens the microphone and starts recording. Resolves null when `cancel()`
   * (or another `start()`) came first — the microphone that finished opening
   * after that is closed again at once, so nothing is left recording that
   * nobody asked to keep on. Rejects when the microphone cannot be opened.
   */
  start(): Promise<RecordingInfo | null>
  /** Stops, converts and uploads. Returns the transcript, or '' if silent. */
  finish(): Promise<string>
  cancel(): void
  recording(): boolean
}

/** What a started recording is recording from. */
export interface RecordingInfo {
  /** The track's device label, or '' while the browser withholds names. */
  label: string
  /** Set when the chosen microphone could not be used and the default was. */
  notice: string | null
}

export interface RecorderOptions {
  /**
   * Called on every animation frame while recording, with the smoothed input
   * level 0..1 (`levelFromSamples`), and once with 0 when it stops. Drive a
   * style through a ref from it, never React state: it is ~60 calls a second.
   */
  onLevel?: (level: number) => void
  /** The saved microphone (`voice.micDeviceId`/`micLabel`), read at each start. */
  device?: () => SavedMic | null
}

/**
 * Hands a finished 16 kHz mono 16-bit PCM WAV to whoever can reach the speech
 * server, and resolves with the transcript. Rejecting is how a recorder reports
 * a transcription failure; the caller shows the message.
 *
 * The two implementations are `postTranscription` below (phone, over HTTP) and
 * the desktop's IPC bridge. Neither the sidecar's address nor its auth story is
 * visible from here, which is the point: the browser never talks to the speech
 * server directly on either surface.
 */
export type UploadWav = (wav: ArrayBuffer) => Promise<string>

/** POSTs to the remote server's proxy route. The phone's transport. */
export async function postTranscription(wav: ArrayBuffer): Promise<string> {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav
  })
  const data = (await res.json()) as { text?: string; error?: string }
  if (!res.ok) throw new Error(data.error || `Transcription failed (${res.status})`)
  return (data.text || '').trim()
}

/** What every recording asks the microphone for, whichever device it is. */
const AUDIO = { channelCount: 1, echoCancellation: true, noiseSuppression: true }

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop())
}

/**
 * Open the saved microphone, or the system default.
 *
 * The saved id is asked for EXACTLY — `ideal` would let the browser quietly
 * substitute another input, and the user would dictate into a device they did
 * not choose without being told. When it is gone (`OverconstrainedError`,
 * `NotFoundError`), the devices are listed again and matched by label, since an
 * OS or driver update can re-mint an id for the same device (`pickDevice`); if
 * nothing matches, the default records this time and `notice` says so.
 */
export async function openMicrophone(saved: SavedMic | null): Promise<{ stream: MediaStream; notice: string | null }> {
  const md = navigator.mediaDevices
  const open = (deviceId: string | null): Promise<MediaStream> =>
    md.getUserMedia({ audio: deviceId ? { ...AUDIO, deviceId: { exact: deviceId } } : { ...AUDIO } })

  if (!saved?.id) return { stream: await open(null), notice: null }
  try {
    return { stream: await open(saved.id), notice: null }
  } catch (err) {
    if (!isMissingDevice(err)) throw err
  }
  const pick = pickDevice(await listDevices(), saved)
  if (pick.deviceId && pick.deviceId !== saved.id) {
    try {
      return { stream: await open(pick.deviceId), notice: null }
    } catch (err) {
      if (!isMissingDevice(err)) throw err
    }
  }
  return { stream: await open(null), notice: pick.notice ?? notConnected(saved.label) }
}

/** The devices the browser will name, as plain objects. */
export async function listDevices(): Promise<MicDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return all.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind }))
}

/**
 * Ask for the microphone once and let it go, so the browser starts naming
 * devices: enumerateDevices() returns blank labels until a grant. On macOS,
 * before Stoke has ever been allowed, this is the moment the system asks.
 */
export async function revealDeviceNames(): Promise<void> {
  stopStream(await navigator.mediaDevices.getUserMedia({ audio: true }))
}

/**
 * Report a stream's input level every animation frame until the returned stop
 * is called.
 *
 * The analyser is connected to the source and to NOTHING else — never to the
 * context's destination, which would play the microphone back out of the
 * speakers into itself. Chromium pulls an analyser with no outputs regardless.
 * The context is closed on stop, so one per recording never accumulates.
 */
export function meterStream(stream: MediaStream, onLevel: (level: number) => void): () => void {
  let ctx: AudioContext | null = null
  let raf = 0
  try {
    ctx = audioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    // A context made outside a gesture may start suspended; the keydown that
    // got us here counts, but asking costs nothing.
    void ctx.resume().catch(() => {})
    const samples = new Float32Array(analyser.fftSize)
    let level = 0
    let last = performance.now()
    const tick = (now: number): void => {
      analyser.getFloatTimeDomainData(samples)
      level = smoothLevel(level, levelFromSamples(samples), now - last)
      last = now
      onLevel(level)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  } catch {
    // The line is a nicety. A browser that cannot build the graph still records.
  }
  return () => {
    cancelAnimationFrame(raf)
    if (ctx) void ctx.close().catch(() => {})
    ctx = null
    onLevel(0)
  }
}

/**
 * The level line with no recording behind it, for Settings' "Test microphone":
 * opens the saved device exactly as a recording would, and uploads nothing.
 */
export async function testMicrophone(
  saved: SavedMic | null,
  onLevel: (level: number) => void
): Promise<{ stop: () => void } & RecordingInfo> {
  const { stream, notice } = await openMicrophone(saved)
  const stopMeter = meterStream(stream, onLevel)
  return {
    label: stream.getAudioTracks()[0]?.label ?? '',
    notice,
    stop: () => {
      stopMeter()
      stopStream(stream)
    }
  }
}

interface Take {
  rec: MediaRecorder
  chunks: Blob[]
  stopMeter: (() => void) | null
}

export function createRecorder(upload: UploadWav, opts: RecorderOptions = {}): Recorder {
  let take: Take | null = null
  /*
   * Bumped by every cancel and every start. A start that was still waiting on
   * getUserMedia when it moved has been superseded, and closes the microphone
   * it was handed rather than overwriting the take — which used to leak a
   * live stream, and with it the OS recording indicator, when Space was
   * released during a permission prompt and pressed again.
   */
  let generation = 0

  const release = (): void => {
    generation++
    if (!take) return
    take.stopMeter?.()
    stopStream(take.rec.stream)
    take = null
  }

  return {
    recording: () => take?.rec.state === 'recording',

    async start() {
      release()
      const gen = generation
      const { stream, notice } = await openMicrophone(opts.device?.() ?? null)
      if (gen !== generation) {
        stopStream(stream)
        return null
      }
      let rec: MediaRecorder
      try {
        // isTypeSupported can be optimistic, so fall back to the browser default
        // rather than forcing a type it claims to know and then mishandles.
        const mimeType = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
        rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      } catch (err) {
        stopStream(stream)
        throw err
      }
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      rec.start()
      take = { rec, chunks, stopMeter: opts.onLevel ? meterStream(stream, opts.onLevel) : null }
      return { label: stream.getAudioTracks()[0]?.label ?? '', notice }
    },

    cancel: release,

    async finish() {
      const own = take
      if (!own || own.rec.state === 'inactive') {
        release()
        return ''
      }
      // Detached before the await, so a new start() while this one stops and
      // uploads gets a take of its own instead of having this one released
      // out from under it.
      take = null
      const { rec, chunks } = own
      const blob = await new Promise<Blob>((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
        rec.stop()
      })
      own.stopMeter?.()
      stopStream(rec.stream)

      // Under about a tenth of a second is a mis-tap, not speech. Measured on
      // compressed bytes, so it is a floor rather than an exact duration; the
      // sidecar re-checks on decoded samples, where it can be exact.
      if (blob.size < 1024) return ''

      return upload(await toWav(blob))
    }
  }
}
