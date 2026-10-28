/*
 * The lent microphone's AudioWorklet (components/MicTunnel.tsx): the context's
 * Float32 samples in, 20 ms frames of 16 kHz signed 16-bit LITTLE-endian mono
 * out (320 samples, 640 bytes), posted to the page, which sends them to main.
 *
 * Plain JS with no imports: a worklet module is fetched by URL into its own
 * scope, so it is loaded through Vite's `?url` and served from the app's own
 * origin, which the page's `script-src 'self'` allows (a blob: or data: URL
 * would not be). Runs on the audio thread, so a busy page does not drop audio:
 * the frames queue on the port instead.
 *
 * The page asks for a 16 kHz context, and Chromium resamples the microphone to
 * it; where that is refused it runs at the device's rate and this averages each
 * output sample's share of input samples (a box filter: plenty for speech).
 */
const OUT_RATE = 16000
const FRAME = 320

class StokeMicFrames extends AudioWorkletProcessor {
  constructor() {
    super()
    // Input samples per output sample: 1 at 16 kHz, 3 at 48 kHz.
    this.step = sampleRate / OUT_RATE
    this.pos = 0
    this.acc = 0
    this.count = 0
    this.frame = new ArrayBuffer(FRAME * 2)
    this.view = new DataView(this.frame)
    this.n = 0
  }

  push(v) {
    const c = v > 1 ? 1 : v < -1 ? -1 : v
    // Asymmetric on purpose, as voice.ts's WAV encoder: -1 is -32768, +1 is 32767.
    this.view.setInt16(this.n * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true)
    this.n++
    if (this.n === FRAME) {
      this.port.postMessage(this.frame, [this.frame])
      this.frame = new ArrayBuffer(FRAME * 2)
      this.view = new DataView(this.frame)
      this.n = 0
    }
  }

  process(inputs) {
    const input = inputs[0]
    const ch = input && input[0]
    if (!ch) return true
    if (this.step <= 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i])
      return true
    }
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]
      this.count++
      this.pos += 1
      if (this.pos >= this.step) {
        this.pos -= this.step
        this.push(this.acc / this.count)
        this.acc = 0
        this.count = 0
      }
    }
    return true
  }
}

registerProcessor('stoke-mic-frames', StokeMicFrames)
