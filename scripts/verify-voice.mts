/*
 * Who owns a held Space, and what a refused microphone is called.
 *
 * The bug this suite exists for was two dictation features on one key. With
 * Stoke's dictation on, `TerminalView` took the first Space keydown and let
 * every auto-repeat through (`if (e.code !== 'Space' || e.repeat) return`) — and
 * the auto-repeat stream is precisely what Claude Code's /voice listens for. So
 * one press started two recorders; Stoke's failed on a speech server that was
 * not running, and the user concluded Claude Code could not reach the
 * microphone in Stoke. It could: measured on 2026-09-19 over CDP with real key
 * events against the installed app, `/voice` recorded and streamed as soon as
 * Stoke's dictation was off.
 *
 * Nothing covered voice at all before this, so the wire is checked too: a pure
 * function that nobody calls is gotcha 31's green run over a broken feature.
 *
 * Also the speech providers (shared/speechProviders.ts, main/stt.ts): every
 * provider's URL, auth header and body, the transcript each one answers with,
 * the refusals, and the shipped dispatcher against a fake on loopback port 0.
 *
 *   node scripts/verify-voice.mts
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { testSpeechService, transcribe } from '../src/main/stt.ts'
import {
  audioDestination,
  base64Of,
  buildSttRequest,
  describeSttFailure,
  GEMINI_TRANSCRIBE_PROMPT,
  isRefusal,
  keyCheckRequest,
  readTranscript,
  redactKey,
  sttReadiness,
  upstreamMessage,
  STOKE_MAX_AUDIO_BYTES,
  STT_PROVIDER_IDS,
  STT_PROVIDERS,
  WAV_BYTES_PER_SECOND,
  wavSeconds,
  type SttConfig,
  type SttProviderId,
  type SttRefusal,
  type SttRequest
} from '../src/shared/speechProviders.ts'
import {
  audioInputs,
  isMissingDevice,
  isVirtualCapture,
  labelsHidden,
  noSignalLine,
  notConnected,
  pickDevice,
  type MicDevice
} from '../src/shared/micDevice.ts'
import { createSignalWatch, levelFromSamples, smoothLevel } from '../src/shared/voiceLevel.ts'
import {
  CLI_OWNS_SPACE,
  claudeVoiceEnabled,
  isMicAccess,
  micAccessLine,
  microphoneError,
  SPACE_IDLE,
  spaceHold,
  spaceKey,
  spaceOwner,
  type SpaceHoldEvent,
  type SpaceHoldOutput,
  type SpaceHoldState
} from '../src/shared/voiceRoute.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`)
}

/*
 * Drive the reducer through a sequence of events at given times, the way
 * TerminalView and the phone do, and return every output in order.
 */
const HOLD = 250
type Ev = [number, SpaceHoldEvent]
function run(events: Ev[], holdMs = HOLD): { outs: SpaceHoldOutput[]; takes: boolean[]; state: SpaceHoldState } {
  let state: SpaceHoldState = SPACE_IDLE
  const outs: SpaceHoldOutput[] = []
  const takes: boolean[] = []
  for (const [at, ev] of events) {
    const step = spaceHold(state, ev, at, holdMs)
    state = step.state
    outs.push(step.output)
    takes.push(step.take)
  }
  return { outs, takes, state }
}
const down = (repeat = false, code = 'Space'): SpaceHoldEvent => ({ type: 'keydown', code, repeat })
const up = (code = 'Space'): SpaceHoldEvent => ({ type: 'keyup', code })

console.log('\na tap types a space; only a hold records')
{
  const tap = run([
    [0, down()],
    [60, up()]
  ])
  check('a 60ms tap: arm the timer, then type the space', tap.outs, ['arm-timer', 'type-space'])
  ok('a tap never starts a recording — no microphone opens on a tap', !tap.outs.includes('start'))
  check('and both of its events are taken, so xterm never types a second space', tap.takes, [true, true])
  check('back to idle afterwards', tap.state, SPACE_IDLE)
}
{
  const hold = run([
    [0, down()],
    [HOLD, { type: 'timer' }],
    [HOLD + 80, { type: 'opened' }],
    [1500, up()]
  ])
  check('a hold past holdMs: arm, start, open, finish', hold.outs, ['arm-timer', 'start', 'pass', 'finish'])
  check('and ends idle', hold.state, SPACE_IDLE)
}
{
  // A key-repeat delay shorter than a long threshold: the repeat is the OS
  // saying the key is held, so it starts before the timer.
  const early = run(
    [
      [0, down()],
      [225, down(true)],
      [260, { type: 'opened' }],
      [900, up()]
    ],
    600
  )
  check('a repeat while pending proves a hold and starts at once', early.outs, ['arm-timer', 'start', 'pass', 'finish'])
  check('the repeat itself is taken', early.takes[1], true)
}
{
  const held = run([
    [0, down()],
    [HOLD, { type: 'timer' }],
    [300, { type: 'opened' }],
    [330, down(true)],
    [363, down(true)],
    [396, down(true)],
    [800, up()]
  ])
  check('repeats while recording are swallowed (gotcha 79)', held.outs.slice(3, 6), ['swallow', 'swallow', 'swallow'])
  check('and TAKEN, never passed on to the pty where /voice listens', held.takes.slice(3, 6), [true, true, true])
}
{
  // Every phase: a repeat must never reach xterm. This is gotcha 79's rule.
  const phases: SpaceHoldState[] = [SPACE_IDLE, { phase: 'pending', since: 0 }, { phase: 'starting' }, { phase: 'recording' }]
  const passed = phases.filter((st) => !spaceHold(st, down(true), 100, HOLD).take)
  check('a Space repeat is taken in every phase', passed.map((p) => p.phase), [])
  check('and a repeat with no press of ours before it starts nothing', spaceHold(SPACE_IDLE, down(true), 0, HOLD).output, 'swallow')
}
{
  const ime = spaceHold(SPACE_IDLE, { type: 'keydown', code: 'Space', repeat: false, composing: true }, 0, HOLD)
  check('an IME composing Space passes — it is the conversion key', [ime.output, ime.take], ['pass', false])
  const imeUp = spaceHold({ phase: 'recording' }, { type: 'keyup', code: 'Space', composing: true }, 0, HOLD)
  check('even its keyup', [imeUp.output, imeUp.take], ['pass', false])
  check(
    'keyCode 229 counts as composing even when isComposing is still false',
    spaceKey({ code: 'Space', repeat: false, isComposing: false, keyCode: 229 }, 'keydown'),
    { type: 'keydown', code: 'Space', repeat: false, composing: true }
  )
}
{
  const early = run([
    [0, down()],
    [HOLD, { type: 'timer' }],
    [400, up()],
    [900, { type: 'opened' }]
  ])
  check(
    'released while getUserMedia is still opening: cancel, and a late open is cancelled too',
    early.outs,
    ['arm-timer', 'start', 'cancel', 'cancel']
  )
  check('ends idle', early.state, SPACE_IDLE)
}
{
  const fast = run([
    [0, down()],
    [40, down(false, 'KeyB')],
    [70, up()]
  ])
  check('"a b" typed with Space still down: the space goes out before the b', fast.outs, ['arm-timer', 'type-space', 'swallow'])
  check('and the b itself is NOT taken', fast.takes[1], false)
  check('other keys pass untouched otherwise', spaceHold(SPACE_IDLE, down(false, 'KeyA'), 0, HOLD).output, 'pass')
  check('including while recording', spaceHold({ phase: 'recording' }, down(false, 'KeyA'), 0, HOLD).take, false)
}
{
  const late = run([
    [0, down()],
    [HOLD + 40, up()]
  ])
  check('a release past holdMs with the timer not yet run types nothing', late.outs, ['arm-timer', 'cancel'])
  const early = spaceHold({ phase: 'pending', since: 100 }, { type: 'timer' }, 200, HOLD)
  check('a timer that fires early re-arms for what is left', [early.output, early.wait], ['arm-timer', 150])
  check('a stale timer while recording does nothing', spaceHold({ phase: 'recording' }, { type: 'timer' }, 0, HOLD).output, 'pass')
  check('a failed open goes back to idle', spaceHold({ phase: 'starting' }, { type: 'failed' }, 0, HOLD).state, SPACE_IDLE)
  check(
    'the threshold is the caller’s: at 600ms a 400ms press is a tap',
    run(
      [
        [0, down()],
        [400, up()]
      ],
      600
    ).outs,
    ['arm-timer', 'type-space']
  )
}
{
  // The shipped rules before the hold threshold, restated so the
  // counterfactuals are on record. The last one started on the first press, so
  // a tap opened the microphone and typed nothing; the one before that let
  // repeats through, which is gotcha 79's bug.
  const before = (e: { code: string; repeat: boolean }): string => (e.code !== 'Space' ? 'pass' : e.repeat ? 'swallow' : 'start')
  check('the previous rule started on the first press (pinned as history)', before({ code: 'Space', repeat: false }), 'start')
  const older = (e: { code: string; repeat: boolean }): string => (e.code !== 'Space' || e.repeat ? 'pass' : 'start')
  check('the rule before it passed repeats on to the pty (pinned as history)', older({ code: 'Space', repeat: true }), 'pass')
}

console.log('\nthe recording-volume line')
{
  const n = 1024
  const sine = (amp: number): Float32Array => {
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * 440 * i) / 48000)
    return a
  }
  check('silence reads 0', levelFromSamples(new Float32Array(n)), 0)
  check('an empty block reads 0', levelFromSamples(new Float32Array(0)), 0)
  const full = levelFromSamples(sine(1))
  ok('a full-scale sine reads about 1 (RMS -3 dBFS, so 0.95)', full > 0.93 && full <= 1, String(full))
  // A sine's RMS is its peak over root 2, so a -30 dBFS RMS sine peaks at 10^(-30/20)·√2.
  const mid = levelFromSamples(sine(Math.pow(10, -30 / 20) * Math.SQRT2))
  ok('-30 dBFS reads about half', Math.abs(mid - 0.5) < 0.02, String(mid))
  check('below -60 dBFS is the floor', levelFromSamples(sine(0.0001)), 0)
  check('a clipped block cannot read past 1', levelFromSamples(new Float32Array(n).fill(4)), 1)
  const rise = smoothLevel(0, 1, 16)
  const fall = 1 - smoothLevel(1, 0, 16)
  ok('the line rises faster than it falls (attack beats release)', rise > fall * 3, `${rise} vs ${fall}`)
  ok('and holds a steady reading', Math.abs(smoothLevel(0.5, 0.5, 16) - 0.5) < 1e-9)
  const watch = createSignalWatch(2000, 0.02)
  check('a flat line is not "no signal" before 2s', [watch(0, 0), watch(0, 1999)], [false, false])
  check('it is at 2s', watch(0, 2000), true)
  check('and any sound clears it at once', [watch(0.3, 2100), watch(0, 2200)], [false, false])
  ok('a virtual cable is named in the no-signal line', noSignalLine('CABLE Output (VB-Audio Virtual Cable)').includes('virtual audio cable'))
  ok('any other device gets the plain line', noSignalLine('MacBook Pro Microphone').startsWith('No signal from the microphone'))
}

console.log('\npicking the microphone')
{
  const mic = (deviceId: string, label: string, kind = 'audioinput'): MicDevice => ({ deviceId, label, kind })
  const devices = [
    mic('default', 'Default - MacBook Pro Microphone'),
    mic('abc', 'MacBook Pro Microphone'),
    mic('usb1', 'USB Audio Mic'),
    mic('out1', 'MacBook Pro Speakers', 'audiooutput')
  ]
  check('the exact id wins', pickDevice(devices, { id: 'usb1', label: 'USB Audio Mic' }), { deviceId: 'usb1', notice: null })
  check(
    'an id that is gone but whose label is here: that device, under its new id',
    pickDevice(devices, { id: 'old-usb', label: 'USB Audio Mic' }),
    { deviceId: 'usb1', notice: null }
  )
  check(
    'neither: the default, and a notice naming the device',
    pickDevice(devices, { id: 'gone', label: 'Blue Yeti' }),
    { deviceId: null, notice: 'Blue Yeti is not connected — using the default microphone.' }
  )
  check('a saved null is the default, with nothing to say', pickDevice(devices, { id: null, label: '' }), { deviceId: null, notice: null })
  check('no saved choice at all is the default', pickDevice(devices, null), { deviceId: null, notice: null })
  check('an output is never matched by label', pickDevice(devices, { id: 'x', label: 'MacBook Pro Speakers' }).deviceId, null)
  ok('a nameless missing device still gets a sentence', notConnected('').startsWith('The chosen microphone'))
  check('the pseudo "default" entry is not listed twice', audioInputs(devices).map((d) => d.deviceId), ['abc', 'usb1'])
  check(
    'nor is Windows’ "communications"',
    audioInputs([mic('communications', 'Communications - Headset'), mic('h', 'Headset')]).map((d) => d.deviceId),
    ['h']
  )
  check('names withheld before a grant are noticed', labelsHidden([mic('a', ''), mic('b', '')]), true)
  check('and named devices are not', labelsHidden(devices), false)
  check('nothing listed is not "withheld"', labelsHidden([]), false)
  check('an exact id the browser cannot satisfy falls back', isMissingDevice({ name: 'OverconstrainedError' }), true)
  check('as does no input at all', isMissingDevice(Object.assign(new Error('x'), { name: 'NotFoundError' })), true)
  check('but a refused permission does not — it is not a missing device', isMissingDevice({ name: 'NotAllowedError' }), false)
}

console.log('\nvirtual cables, picked or default (moved from audio/defaultDevice.ts)')
{
  for (const name of [
    'CABLE Output (VB-Audio Virtual Cable)',
    'VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)',
    'Microphone (NVIDIA Broadcast)',
    'Line 1 (Virtual Audio Cable)',
    'Voicemod Virtual Audio Device (WDM)',
    'Microphone (Steam Streaming Microphone)',
    'Elgato Wave Link MicrophoneFX',
    'OBS Virtual Camera Audio'
  ]) {
    ok(`virtual: ${name}`, isVirtualCapture(name))
  }
  for (const name of [
    'MacBook Pro Microphone',
    'Headset Microphone (Oculus Virtual Audio Device)',
    'Microphone (Realtek(R) Audio)',
    'Yeti Stereo Microphone',
    'KNOBS Mixer Mic'
  ]) {
    ok(`a real microphone: ${name}`, !isVirtualCapture(name))
  }
  const main = readFileSync(new URL('../src/main/audio/defaultDevice.ts', import.meta.url), 'utf8')
  ok(
    'main’s default-device check uses the shared rule, not a copy',
    /from '\.\.\/\.\.\/shared\/micDevice\.ts'/.test(main) && !/const VIRTUAL\s*=/.test(main)
  )
}

console.log('\nClaude Code’s /voice: both shapes /voice writes')
check('voiceEnabled: true', claudeVoiceEnabled({ voiceEnabled: true }), true)
check('voice.enabled: true', claudeVoiceEnabled({ voice: { enabled: true, mode: 'hold' } }), true)
check('both, as /voice actually writes them', claudeVoiceEnabled({ voice: { enabled: true, mode: 'hold' }, voiceEnabled: true }), true)
check('neither', claudeVoiceEnabled({ theme: 'dark' }), false)
check('explicitly off', claudeVoiceEnabled({ voiceEnabled: false, voice: { enabled: false } }), false)
check('a string "true" is not a switch', claudeVoiceEnabled({ voiceEnabled: 'true' }), false)
check('no settings file at all', claudeVoiceEnabled(null), false)
check('voice set to null does not throw', claudeVoiceEnabled({ voice: null }), false)
// The CLI's own precedence, read from the 2.1.278 bundle: the nested key wins.
check('nested off outranks a top-level true', claudeVoiceEnabled({ voiceEnabled: true, voice: { enabled: false } }), false)
check('nested on outranks a top-level false', claudeVoiceEnabled({ voiceEnabled: false, voice: { enabled: true } }), true)
check('a nested object without `enabled` falls back to the top-level key', claudeVoiceEnabled({ voiceEnabled: true, voice: { mode: 'hold' } }), true)

console.log('\nwho owns Space in a tab')
check('a local Claude tab with /voice on: Claude Code', spaceOwner({ cliId: 'claude', hostId: null }, true), 'cli')
check('a local Claude tab with /voice off: Stoke', spaceOwner({ cliId: 'claude', hostId: null }, false), 'stoke')
check(
  'an SSH tab is Stoke’s even running claude — the far machine has no microphone',
  spaceOwner({ cliId: 'claude', hostId: 'vps' }, true),
  'stoke'
)
check('a Codex tab: Stoke, whatever Claude’s setting says', spaceOwner({ cliId: 'codex', hostId: null }, true), 'stoke')
ok('the refusal names /voice and how to turn it off', CLI_OWNS_SPACE.includes('/voice') && /turn it off/.test(CLI_OWNS_SPACE))

console.log('\na refused microphone names the switch to change')
{
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
  const mac = microphoneError(denied, 'darwin')
  ok('macOS names Stoke and Privacy & Security', mac.includes('Stoke') && mac.includes('Privacy & Security'), mac)
  ok('Windows names its own privacy page', microphoneError(denied, 'win32').includes('Privacy & security'))
  // DOMException is not an Error subclass in every runtime; a plain object with a name is the portable shape.
  ok('a non-Error with a name still maps', microphoneError({ name: 'NotAllowedError' }, 'darwin').includes('Stoke'))
  ok('no device at all is said so', microphoneError(Object.assign(new Error('x'), { name: 'NotFoundError' }), 'darwin').startsWith('No microphone'))
  check('anything else keeps the browser’s own message', microphoneError(new Error('Device busy'), 'darwin'), 'Device busy')
  check('and a message-less failure gets the fallback', microphoneError(undefined, 'darwin'), 'Could not open the microphone.')
}

console.log('\nthe permission line in Settings')
{
  const denied = micAccessLine('denied', 'darwin') ?? ''
  ok('denied on macOS says there is no separate claude entry', denied.includes('no separate “claude” entry'), denied)
  ok('granted on macOS says the one switch covers every CLI', (micAccessLine('granted', 'darwin') ?? '').includes('every other CLI'))
  check('Linux has nothing to say', micAccessLine('not-applicable', 'linux'), null)
  ok('no line repeats the pill’s own word', !/^(Allowed|Denied)\b/.test(micAccessLine('granted', 'darwin') ?? '') && !/^(Allowed|Denied)\b/.test(denied))
  check('isMicAccess accepts what Electron returns', ['granted', 'denied', 'restricted', 'not-determined', 'unknown'].every(isMicAccess), true)
  check('and refuses anything else', isMicAccess('allowed'), false)
}

/*
 * Speech providers. Every hosted API and the custom server take the same WAV
 * but want it differently — a raw body, a multipart field called `file` or
 * `audio`, base64 inside JSON — behind five different auth headers. The
 * builder is pure, so the whole matrix is held here field by field; then the
 * shipped `stt.ts` is driven against a loopback fake, so FormData and Blob are
 * the real encoding, not a description of it. No real directory is touched and
 * no request leaves 127.0.0.1 (gotcha 74): hosted URLs reach the fake through
 * `fetchImpl`, which only swaps the origin.
 */
console.log('\nspeech providers: the request each one gets')
const KEY = 'sk-CANARY-7f3e9a1b2c'
const wav = (() => {
  const b = new Uint8Array(44 + 3200)
  b.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF", so a bytes-intact check has a header to find
  for (let i = 44; i < b.length; i++) b[i] = (i * 31) & 0xff
  return b
})()
const cfg = (provider: SttProviderId, over: Partial<SttConfig> = {}): SttConfig => ({
  provider,
  model: '',
  baseUrl: '',
  sttUrl: '',
  key: provider === 'sidecar' || provider === 'custom' ? '' : KEY,
  ...over
})
function built(c: SttConfig, w: Uint8Array = wav): SttRequest {
  const r = buildSttRequest(c, w)
  if (isRefusal(r)) throw new Error(`${c.provider} refused: ${r.error}`)
  return r
}
const fieldsOf = (r: SttRequest): string[] =>
  r.body.kind === 'multipart' ? r.body.parts.map((p) => ('file' in p ? `${p.name}=<${p.type} ${p.filename}>` : `${p.name}=${p.value}`)) : []
{
  const expect: Record<Exclude<SttProviderId, 'sidecar' | 'custom'>, { url: string; auth: [string, string]; kind: string; fields: string[] }> = {
    openai: {
      url: 'https://api.openai.com/v1/audio/transcriptions',
      auth: ['authorization', `Bearer ${KEY}`],
      kind: 'multipart',
      fields: ['file=<audio/wav dictation.wav>', 'model=gpt-transcribe', 'response_format=json']
    },
    groq: {
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      auth: ['authorization', `Bearer ${KEY}`],
      kind: 'multipart',
      fields: ['file=<audio/wav dictation.wav>', 'model=whisper-large-v3-turbo', 'response_format=json']
    },
    deepgram: {
      url: 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true',
      auth: ['authorization', `Token ${KEY}`],
      kind: 'raw',
      fields: []
    },
    elevenlabs: {
      url: 'https://api.elevenlabs.io/v1/speech-to-text',
      auth: ['xi-api-key', KEY],
      kind: 'multipart',
      fields: ['model_id=scribe_v2', 'file=<audio/wav dictation.wav>', 'tag_audio_events=false']
    },
    mistral: {
      url: 'https://api.mistral.ai/v1/audio/transcriptions',
      auth: ['authorization', `Bearer ${KEY}`],
      kind: 'multipart',
      fields: ['file=<audio/wav dictation.wav>', 'model=voxtral-mini-latest']
    },
    assemblyai: {
      url: 'https://sync.assemblyai.com/v1/transcribe',
      auth: ['authorization', KEY],
      kind: 'multipart',
      fields: ['audio=<audio/wav dictation.wav>']
    },
    gemini: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      auth: ['x-goog-api-key', KEY],
      kind: 'json',
      fields: []
    }
  }
  for (const [id, want] of Object.entries(expect) as [keyof typeof expect, (typeof expect)[keyof typeof expect]][]) {
    const r = built(cfg(id))
    check(`${id}: POST to its documented URL`, [r.method, r.url], ['POST', want.url])
    check(`${id}: the key in its own header, its own scheme`, r.headers[want.auth[0]], want.auth[1])
    check(`${id}: body kind`, r.body.kind, want.kind)
    if (want.kind === 'multipart') check(`${id}: multipart field names and order`, fieldsOf(r), want.fields)
  }
  check('assemblyai: the model rides in X-AAI-Model, which its sync endpoint requires', built(cfg('assemblyai')).headers['x-aai-model'], 'universal-3-5-pro')
  const dg = built(cfg('deepgram'))
  check('deepgram: the raw WAV, as audio/wav', [dg.headers['content-type'], dg.body.kind === 'raw' && dg.body.bytes === wav], ['audio/wav', true])
  ok('multipart never sets its own content-type — fetch must write the boundary', ['openai', 'groq', 'elevenlabs', 'mistral', 'assemblyai'].every((id) => !('content-type' in built(cfg(id as SttProviderId)).headers)))

  const gem = built(cfg('gemini'))
  const gv = gem.body.kind === 'json' ? (gem.body.value as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> }) : null
  const inline = gv?.contents[0].parts.find((p) => 'inlineData' in p)?.inlineData as { mimeType: string; data: string } | undefined
  check('gemini: the WAV as base64 inlineData, audio/wav', [inline?.mimeType, inline ? Buffer.from(inline.data, 'base64').equals(Buffer.from(wav)) : false], ['audio/wav', true])
  check('gemini: a general model is told to transcribe, at temperature 0', [gv?.contents[0].parts[0].text, gv?.generationConfig], [GEMINI_TRANSCRIBE_PROMPT, { temperature: 0 }])
  const ded = built(cfg('gemini', { model: 'models/gemini-3.5-transcribe' }))
  const dv = ded.body.kind === 'json' ? (ded.body.value as { contents: { parts: unknown[] }[]; generationConfig: unknown }) : null
  check('gemini: the transcribe model gets audio only, with its transcription config', [ded.url.endsWith('/models/gemini-3.5-transcribe:generateContent'), dv?.contents[0].parts.length, dv?.generationConfig], [true, 1, { audioTranscriptionConfig: { languageCodes: [] } }])

  // A model id is the user's to pick, and still goes where each provider reads it.
  check('a chosen model reaches the multipart field', fieldsOf(built(cfg('openai', { model: 'whisper-1' })))[1], 'model=whisper-1')
  check('and Deepgram’s query, encoded', new URL(built(cfg('deepgram', { model: 'nova-3-medical' })).url).searchParams.get('model'), 'nova-3-medical')

  const side = built(cfg('sidecar', { sttUrl: 'http://127.0.0.1:17890/' }))
  check('sidecar: today’s request exactly — raw WAV at /transcribe, no auth', [side.url, side.headers, side.body.kind], [
    'http://127.0.0.1:17890/transcribe',
    { 'content-type': 'audio/wav' },
    'raw'
  ])
  check('custom: trailing slashes normalised', built(cfg('custom', { baseUrl: 'http://box:8000/v1///' })).url, 'http://box:8000/v1/audio/transcriptions')
  check('custom: a bare origin gains /v1, as speaches serves it', built(cfg('custom', { baseUrl: 'http://127.0.0.1:8000' })).url, 'http://127.0.0.1:8000/v1/audio/transcriptions')
  check('custom: no key, no Authorization header at all', built(cfg('custom', { baseUrl: 'http://x/v1' })).headers, {})
  check('custom: a key goes as Bearer', built(cfg('custom', { baseUrl: 'http://x/v1', key: KEY })).headers.authorization, `Bearer ${KEY}`)
  check('custom: an unset model is whisper-1', fieldsOf(built(cfg('custom', { baseUrl: 'http://x/v1' })))[1], 'model=whisper-1')

  const everyUrl = STT_PROVIDER_IDS.flatMap((id) => {
    const c = cfg(id, { key: KEY, sttUrl: 'http://127.0.0.1:17890', baseUrl: 'http://127.0.0.1:8000/v1' })
    return [built(c).url, keyCheckRequest(c)?.url ?? '']
  })
  ok('no key ever appears in any provider’s URL — request or key check', everyUrl.every((u) => !u.includes(KEY)), everyUrl.filter((u) => u.includes(KEY)).join(', '))
  check('the sidecar never sends a key, even if one is on the config', built(cfg('sidecar', { sttUrl: 'http://s', key: KEY })).headers, { 'content-type': 'audio/wav' })
}

console.log('\nspeech providers: refused before anything is sent')
{
  const refusal = (c: SttConfig, w: Uint8Array = wav): SttRefusal | null => {
    const r = buildSttRequest(c, w)
    return isRefusal(r) ? r : null
  }
  check('no key for a hosted provider is `unset` (the phone’s 503), and names Settings → Voice', (() => {
    const r = refusal(cfg('openai', { key: '  ' }))
    return [r?.unset, /No OpenAI key/.test(r?.error ?? ''), /Settings → Voice/.test(r?.error ?? '')]
  })(), [true, true, true])
  check('no custom address is unset too', refusal(cfg('custom'))?.unset, true)
  check('an address that is not http(s) is a mistake, not unset', (() => {
    const r = refusal(cfg('custom', { baseUrl: '127.0.0.1:8000/v1' }))
    return [r?.unset ?? null, /http:\/\/ or https:\/\//.test(r?.error ?? '')]
  })(), [null, true])
  ok('a key with a newline in it is refused before fetch could throw on the header', /character no key contains/.test(refusal(cfg('groq', { key: 'gsk_a\nb' }))?.error ?? ''))
  ok('and that refusal does not print the key', !(refusal(cfg('groq', { key: `${KEY}\n` + 'x' }))?.error ?? '').includes(KEY))
  const bytesFor = (seconds: number): Uint8Array => new Uint8Array(44 + seconds * WAV_BYTES_PER_SECOND)
  check('AssemblyAI takes exactly 120 s', refusal(cfg('assemblyai'), bytesFor(120)), null)
  check('and refuses 121 s by length, in words', refusal(cfg('assemblyai'), bytesFor(121))?.error, 'Recording too long for AssemblyAI: 2 min 1 s, and it takes at most 2 min per clip.')
  check('and 120 s is what its duration maths says', wavSeconds(bytesFor(120).byteLength), 120)
  const gemMax = STT_PROVIDERS.gemini.maxBytes
  ok('Gemini’s cap keeps the base64 request under its 20 MB limit', Math.ceil(gemMax / 3) * 4 + 4096 < 20_000_000, String(gemMax))
  check('and a clip over it is refused', /too large for Gemini/.test(refusal(cfg('gemini'), new Uint8Array(gemMax + 1))?.error ?? ''), true)
  ok(
    'OpenAI’s cap leaves room under 26,214,400 for the WHOLE multipart body, not just the file',
    STT_PROVIDERS.openai.maxBytes + 4096 < 26_214_400 && STT_PROVIDERS.openai.maxBytes < STOKE_MAX_AUDIO_BYTES
  )
  check('the sidecar keeps its own 25 MiB and its old sentence', refusal(cfg('sidecar', { sttUrl: 'http://s' }), new Uint8Array(STOKE_MAX_AUDIO_BYTES + 1))?.error, 'Recording too large.')
  check('an empty clip is still "Nothing was recorded."', refusal(cfg('openai'), new Uint8Array(0))?.error, 'Nothing was recorded.')
}

console.log('\nspeech providers: reading the transcript back')
check('the OpenAI family: .text, trimmed', readTranscript('openai', { text: ' hello there ' }), 'hello there')
check('groq, mistral, elevenlabs, assemblyai, custom, sidecar: the same', (['groq', 'mistral', 'elevenlabs', 'assemblyai', 'custom', 'sidecar'] as const).map((p) => readTranscript(p, { text: 'x' })), ['x', 'x', 'x', 'x', 'x', 'x'])
check('deepgram: results.channels[0].alternatives[0].transcript', readTranscript('deepgram', { results: { channels: [{ alternatives: [{ transcript: ' dg text ', confidence: 0.9 }] }] } }), 'dg text')
check('deepgram with no alternatives is empty, not a throw', readTranscript('deepgram', { results: { channels: [{ alternatives: [] }] } }), '')
check('deepgram with no channels', readTranscript('deepgram', { results: {} }), '')
check('gemini: every text part of the first candidate, joined', readTranscript('gemini', { candidates: [{ content: { parts: [{ text: 'one ' }, { text: 'two\n' }] } }] }), 'one two')
check('gemini with no candidates (a blocked prompt) is empty', readTranscript('gemini', { promptFeedback: { blockReason: 'OTHER' } }), '')
check('a missing text is empty', readTranscript('openai', {}), '')
check('a non-string text is empty', readTranscript('openai', { text: 7 }), '')
check('a non-object answer is empty', [readTranscript('openai', null), readTranscript('deepgram', 'x'), readTranscript('gemini', [])], ['', '', ''])

console.log('\nspeech providers: what a failure says')
{
  check('401: the key was refused, by provider name, in the provider’s own words', describeSttFailure('openai', 401, '{"error":{"message":"Incorrect API key"}}'), 'The OpenAI key was refused (401: Incorrect API key). Check it in Settings → Voice.')
  check(
    'the provider’s sentence is found in each vendor’s error shape',
    [
      upstreamMessage('{"error":{"message":"a"}}'),
      upstreamMessage('{"err_code":"X","err_msg":"b"}'),
      upstreamMessage('{"detail":{"status":"s","message":"c"}}'),
      upstreamMessage('{"detail":"d"}'),
      upstreamMessage('{"error":"e"}'),
      upstreamMessage('<html>f</html>'),
      upstreamMessage('{"weird":1}')
    ],
    ['a', 'b', 'c', 'd', 'e', '<html>f</html>', '{"weird":1}']
  )
  ok('403 is the key too', /^The Deepgram key was refused \(403/.test(describeSttFailure('deepgram', 403, '')))
  ok('Gemini says a bad key with a 400 and API_KEY_INVALID', /^The Gemini key was refused \(400/.test(describeSttFailure('gemini', 400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}')))
  ok('but a Gemini 400 about anything else is not the key', !/key was refused/.test(describeSttFailure('gemini', 400, '{"error":{"message":"Unsupported MIME type"}}')))
  ok('402 is out of credit', /out of credit/.test(describeSttFailure('deepgram', 402, '{"err_code":"ASR_PAYMENT_REQUIRED"}')))
  ok('OpenAI’s 429 credit_balance_exhausted is credit, not rate', /out of credit/.test(describeSttFailure('openai', 429, '{"error":{"code":"credit_balance_exhausted"}}')))
  check('a plain 429 is rate-limited, with the Retry-After it sent', describeSttFailure('groq', 429, 'slow down', { retryAfter: '7' }), 'Groq is rate-limiting this key (429). Try again in 7 s.')
  ok('Groq’s 498 is capacity, read as rate', /rate-limiting/.test(describeSttFailure('groq', 498, '')))
  check('413 is too large', describeSttFailure('openai', 413, 'Maximum content size limit (26214400) exceeded'), 'The recording is too large for OpenAI (413).')
  ok('a 5xx is the provider’s side', /had a problem on its side \(503/.test(describeSttFailure('elevenlabs', 503, '')))
  check('the sidecar keeps its own words, exactly as the phone has always shown them', describeSttFailure('sidecar', 500, '{"error":"model fell over"}'), 'Speech server: 500 {"error":"model fell over"}')
  const echoed = describeSttFailure('openai', 401, `Incorrect API key provided: ${KEY}. You can find your API key at …`, { key: KEY })
  ok('a key the provider echoes back is cut out before it reaches a banner', !echoed.includes(KEY) && echoed.includes('[key]'), echoed)
  check('redactKey leaves text alone when there is no key to cut', redactKey('abc', ''), 'abc')
  ok('upstream text is capped', describeSttFailure('mistral', 400, 'x'.repeat(5000)).length < 300)
}

console.log('\nspeech providers: the key test never transcribes')
{
  const kc = (id: SttProviderId, over: Partial<SttConfig> = {}): string | null => keyCheckRequest(cfg(id, over))?.url ?? null
  check('each provider’s free check is a listing', STT_PROVIDER_IDS.map((id) => kc(id, { baseUrl: 'http://127.0.0.1:8000' })), [
    null,
    'https://api.openai.com/v1/models',
    'https://api.groq.com/openai/v1/models',
    'https://api.deepgram.com/v1/projects',
    'https://api.elevenlabs.io/v1/models',
    'https://api.mistral.ai/v1/models',
    'https://api.assemblyai.com/v2/transcript?limit=1',
    'https://generativelanguage.googleapis.com/v1beta/models',
    'http://127.0.0.1:8000/v1/models'
  ])
  check('the check carries the same auth header as the request', keyCheckRequest(cfg('deepgram'))?.headers, { authorization: `Token ${KEY}` })
  check('no key, no check', kc('openai', { key: '' }), null)
  check('readiness: a hosted provider with a key is ready, never probed', sttReadiness(cfg('openai')), { kind: 'ready' })
  check('without one it is off', sttReadiness(cfg('openai', { key: '' })), { kind: 'off' })
  check('the sidecar is probed at /transcribe', sttReadiness(cfg('sidecar', { sttUrl: 'http://127.0.0.1:17890/' })), { kind: 'probe', url: 'http://127.0.0.1:17890/transcribe' })
  check('a custom server at its transcriptions route', sttReadiness(cfg('custom', { baseUrl: 'http://127.0.0.1:8000' })), { kind: 'probe', url: 'http://127.0.0.1:8000/v1/audio/transcriptions' })
  check('an empty address is off', [sttReadiness(cfg('sidecar')), sttReadiness(cfg('custom'))], [{ kind: 'off' }, { kind: 'off' }])
}

console.log('\nspeech providers: where the audio goes, said honestly')
{
  const d = (c: SttConfig) => audioDestination(c)
  ok('a hosted provider always leaves the machine, named', d(cfg('openai')).leaves && d(cfg('openai')).line.startsWith('Audio leaves this machine for OpenAI'))
  ok('and names the host it goes to', d(cfg('deepgram')).line.includes('api.deepgram.com'))
  check('a loopback sidecar stays', d(cfg('sidecar', { sttUrl: 'http://127.0.0.1:17890' })).leaves, false)
  check('localhost and ::1 too', [d(cfg('custom', { baseUrl: 'http://localhost:8000/v1' })).leaves, d(cfg('custom', { baseUrl: 'http://[::1]:8000/v1' })).leaves], [false, false])
  ok('a server on another machine leaves, and names it', d(cfg('sidecar', { sttUrl: 'http://box.tailnet.ts.net:17890' })).leaves && d(cfg('sidecar', { sttUrl: 'http://box.tailnet.ts.net:17890' })).line.includes('box.tailnet.ts.net'))
  check('nothing set says nothing is sent', d(cfg('custom')).line, 'Nothing is sent until an address is set.')
}

console.log('\nbase64 for Gemini’s inlineData')
{
  const sizes = [0, 1, 2, 3, 4, 5, 47, 48, 49, 3 * 16_384 - 1, 3 * 16_384, 3 * 16_384 + 1, 200_001]
  const bad = sizes.filter((n) => {
    const b = new Uint8Array(n)
    for (let i = 0; i < n; i++) b[i] = (i * 7919 + 13) & 0xff
    return base64Of(b) !== Buffer.from(b).toString('base64')
  })
  check('matches Node’s encoder at every tail length and across chunk edges', bad, [])
}

/*
 * The shipped stt.ts against a fake on 127.0.0.1:0. Hosted URLs keep their
 * paths and queries; `via` only swaps the origin, so what arrives is exactly
 * what the provider would have been sent.
 */
console.log('\nspeech providers: through stt.ts, against a loopback fake')
{
  type Seen = { method: string; path: string; headers: IncomingMessage['headers']; body: Buffer }
  const seen: Seen[] = []
  const answers: ((s: Seen, res: ServerResponse) => void)[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }
      seen.push(s)
      const answer = answers.shift()
      if (answer) answer(s, res)
      else res.writeHead(500).end('no answer queued')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  const via: typeof fetch = (input, init) => fetch(String(input).replace(/^https?:\/\/[^/]+/, origin), init)
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => (_s: Seen, res: ServerResponse) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(typeof body === 'string' ? body : JSON.stringify(body))

  /** A minimal multipart reader, on Buffers so the audio bytes are compared as bytes. */
  function parts(s: Seen): { name: string; filename: string | null; type: string | null; data: Buffer }[] {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(s.headers['content-type']))
    if (!m) return []
    const delim = Buffer.from(`--${m[1] ?? m[2]}`)
    const out: { name: string; filename: string | null; type: string | null; data: Buffer }[] = []
    let at = s.body.indexOf(delim)
    while (at >= 0) {
      const start = at + delim.length
      if (s.body.subarray(start, start + 2).toString() === '--') break
      const next = s.body.indexOf(delim, start)
      if (next < 0) break
      const chunk = s.body.subarray(start + 2, next - 2) // CRLF after the delimiter, CRLF before the next
      const split = chunk.indexOf('\r\n\r\n')
      const head = chunk.subarray(0, split).toString('utf8')
      out.push({
        name: /name="([^"]*)"/.exec(head)?.[1] ?? '',
        filename: /filename="([^"]*)"/.exec(head)?.[1] ?? null,
        type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? null,
        data: chunk.subarray(split + 4)
      })
      at = next
    }
    return out
  }

  // A custom OpenAI-compatible server: multipart file + model, bytes intact, Bearer only when a key is set.
  answers.push(json(200, { text: ' from custom ' }))
  const custom = await transcribe(cfg('custom', { baseUrl: `${origin}/v1/`, key: KEY }), wav)
  check('custom: the transcript comes back', custom, { ok: true, text: 'from custom' })
  const cs = seen.at(-1)!
  const cp = parts(cs)
  check('custom: POST to /v1/audio/transcriptions', [cs.method, cs.path], ['POST', '/v1/audio/transcriptions'])
  check('custom: multipart carries file and model (and json)', cp.map((p) => p.name), ['file', 'model', 'response_format'])
  const filePart = cp.find((p) => p.name === 'file')
  check('custom: the file part is dictation.wav, audio/wav', [filePart?.filename, filePart?.type], ['dictation.wav', 'audio/wav'])
  ok('custom: the WAV arrives byte for byte', !!filePart && filePart.data.equals(Buffer.from(wav)), `${filePart?.data.length} vs ${wav.length}`)
  check('custom: model and the key as Bearer', [cp.find((p) => p.name === 'model')?.data.toString(), cs.headers.authorization], ['whisper-1', `Bearer ${KEY}`])

  // Deepgram: the raw body, the Token scheme, the query intact.
  answers.push(json(200, { results: { channels: [{ alternatives: [{ transcript: 'from deepgram' }] }] } }))
  check('deepgram: the transcript comes back', await transcribe(cfg('deepgram'), wav, { fetchImpl: via }), { ok: true, text: 'from deepgram' })
  const ds = seen.at(-1)!
  check('deepgram: /v1/listen with its query', ds.path, '/v1/listen?model=nova-3&smart_format=true&detect_language=true')
  check('deepgram: a raw audio/wav body, not multipart, bytes intact', [ds.headers['content-type'], ds.body.equals(Buffer.from(wav))], ['audio/wav', true])
  check('deepgram: Authorization: Token', ds.headers.authorization, `Token ${KEY}`)
  answers.push(json(200, { results: { channels: [{ alternatives: [] }] } }))
  check('deepgram with no alternatives is an empty transcript, not an error', await transcribe(cfg('deepgram'), wav, { fetchImpl: via }), { ok: true, text: '' })

  // AssemblyAI: the part is `audio`, the auth is the bare key, the model a header.
  answers.push(json(200, { text: 'from assembly', words: [] }))
  check('assemblyai: the transcript comes back', await transcribe(cfg('assemblyai'), wav, { fetchImpl: via }), { ok: true, text: 'from assembly' })
  const as = seen.at(-1)!
  check('assemblyai: /v1/transcribe, bare key, X-AAI-Model', [as.path, as.headers.authorization, as.headers['x-aai-model']], ['/v1/transcribe', KEY, 'universal-3-5-pro'])
  check('assemblyai: one part, `audio`, bytes intact', parts(as).map((p) => [p.name, p.type, p.data.equals(Buffer.from(wav))]), [['audio', 'audio/wav', true]])

  // Gemini: JSON with the base64 audio; the key in x-goog-api-key and nowhere in the path.
  answers.push(json(200, { candidates: [{ content: { parts: [{ text: 'from gemini\n' }] } }] }))
  check('gemini: the transcript comes back', await transcribe(cfg('gemini'), wav, { fetchImpl: via }), { ok: true, text: 'from gemini' })
  const gs = seen.at(-1)!
  const gbody = JSON.parse(gs.body.toString('utf8')) as { contents: { parts: { inlineData?: { data: string } }[] }[] }
  check('gemini: x-goog-api-key, JSON, key not in the path', [gs.headers['x-goog-api-key'], gs.headers['content-type'], gs.path.includes(KEY)], [KEY, 'application/json', false])
  ok('gemini: the base64 decodes to the WAV', Buffer.from(gbody.contents[0].parts.find((p) => p.inlineData)?.inlineData?.data ?? '', 'base64').equals(Buffer.from(wav)))

  // ElevenLabs and OpenAI: their field names and headers, through real FormData.
  answers.push(json(200, { text: 'from eleven', language_code: 'en' }))
  await transcribe(cfg('elevenlabs'), wav, { fetchImpl: via })
  const es = seen.at(-1)!
  check('elevenlabs: model_id, file, tag_audio_events; xi-api-key', [parts(es).map((p) => p.name), es.headers['xi-api-key'], es.headers.authorization ?? null], [['model_id', 'file', 'tag_audio_events'], KEY, null])

  // Failures, in the words the strip shows.
  answers.push(json(401, { error: { message: `Incorrect API key provided: ${KEY}` } }))
  const refused = await transcribe(cfg('openai'), wav, { fetchImpl: via })
  check(
    'a 401 says the OpenAI key was refused, and prints no key',
    refused.ok ? 'ok' : [/^The OpenAI key was refused \(401/.test(refused.error), refused.error.includes(KEY), refused.unset ?? null],
    [true, false, null]
  )
  answers.push(json(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '12' }))
  const limited = await transcribe(cfg('groq'), wav, { fetchImpl: via })
  check('a 429 with Retry-After says when to try again', limited.ok ? 'ok' : limited.error, 'Groq is rate-limiting this key (429). Try again in 12 s.')
  answers.push(() => {}) // a server that takes the request and never answers
  const t0 = Date.now()
  const hung = await transcribe(cfg('custom', { baseUrl: `${origin}/v1` }), wav, { timeoutMs: 300 })
  check(
    'a hang is a timeout, said as one, and says it is not the microphone',
    hung.ok ? 'ok' : [/no answer within 0 s|no answer within/.test(hung.error), /not the microphone/.test(hung.error), Date.now() - t0 < 5000],
    [true, true, true]
  )
  const before = seen.length
  const nokey = await transcribe(cfg('openai', { key: '' }), wav, { fetchImpl: via })
  check('no key: unset, and nothing was sent', [nokey.ok ? 'ok' : nokey.unset, seen.length - before], [true, 0])

  // The Test button: a listing, never a transcription.
  answers.push(json(200, { data: [{ id: 'whisper-1' }] }))
  const good = await testSpeechService(cfg('custom', { baseUrl: `${origin}/v1`, key: KEY }))
  const gt = seen.at(-1)!
  check('Test: GET /v1/models with the key, no body', [gt.method, gt.path, gt.headers.authorization, gt.body.length], ['GET', '/v1/models', `Bearer ${KEY}`, 0])
  check('and a 200 is a working key', [good.ok, good.tone], [true, 'success'])
  answers.push(json(401, { error: 'bad key' }))
  const badKey = await testSpeechService(cfg('openai'), { fetchImpl: via })
  check('Test: a 401 is the key refused, in red', [badKey.ok, badKey.tone, /^The OpenAI key was refused/.test(badKey.message)], [false, 'danger', true])
  check('Test hit the listing, not transcriptions', seen.at(-1)!.path, '/v1/models')
  answers.push(json(404, 'Not Found'))
  const noList = await testSpeechService(cfg('custom', { baseUrl: `${origin}/v1` }))
  check('Test: a custom server with no /models answered, which is a warning, not a failure', [noList.ok, noList.tone], [true, 'warning'])
  answers.push(json(401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission models_read' } }))
  const scoped = await testSpeechService(cfg('elevenlabs'), { fetchImpl: via })
  check('Test: an ElevenLabs key scoped to speech only is known, not refused', [scoped.ok, scoped.tone], [true, 'warning'])
  answers.push((_s, res) => res.writeHead(405).end())
  const probe = await testSpeechService(cfg('sidecar', { sttUrl: origin }))
  check('Test: the sidecar is probed with OPTIONS; any answer is up', [probe.ok, seen.at(-1)!.method, seen.at(-1)!.path], [true, 'OPTIONS', '/transcribe'])
  const n = seen.length
  const emptyTest = await testSpeechService(cfg('deepgram', { key: '' }), { fetchImpl: via })
  check('Test with no key sends nothing and says what is missing', [emptyTest.ok, seen.length - n, /No Deepgram key/.test(emptyTest.message)], [false, 0, true])

  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
}

console.log('\nthe wire: TerminalView and the phone really route through these')
/*
 * Regexes over the shipped source, so they can be pointed at any revision:
 *
 *   node scripts/verify-voice.mts --wire <TerminalView.tsx> <session.ts> <VoiceSettings.tsx> [MicPicker.tsx]
 *
 * reads those files instead of the working copy's (MicPicker's only when a
 * fourth is given). That is how the checks were shown to FAIL against the files
 * from before the hold threshold (gotcha 79's method) — a wire check that
 * passes on the old file proves nothing.
 */
{
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--wire')
  const given = at >= 0 ? argv.slice(at + 1, at + 5) : []
  const termPath = given[0] ?? new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url)
  const phonePath = given[1] ?? new URL('../src/remote/session.ts', import.meta.url)
  const settingsPath = given[2] ?? new URL('../src/renderer/src/components/VoiceSettings.tsx', import.meta.url)
  const micPath = given[3] ?? new URL('../src/renderer/src/components/MicPicker.tsx', import.meta.url)
  const term = readFileSync(termPath, 'utf8')
  const phone = readFileSync(phonePath, 'utf8')
  const settingsUi = readFileSync(settingsPath, 'utf8')
  const micUi = readFileSync(micPath, 'utf8')
  if (at >= 0) console.log(`  (reading ${termPath}, ${phonePath}, ${settingsPath}, ${micPath})`)

  ok('the old repeat pass-through is gone', !/e\.code !== 'Space' \|\| e\.repeat\) return/.test(term))
  ok(
    'keydown and keyup both step spaceHold, through spaceKey',
    /spaceHold\(holdRef\.current/.test(term) && /spaceKey\(e, 'keydown'\)/.test(term) && /spaceKey\(e, 'keyup'\)/.test(term)
  )
  ok('the old start-on-the-first-press is gone', !/dictationKeyAction/.test(term) && !/void beginRecording\(\)\s*\n\s*\}\s*\n\s*\n\s*const onKeyUp/.test(term))
  ok('a tap types its space through term.input, as typing does', /\.input\(' ', true\)/.test(term))
  ok('only a step that takes the key stops it', /if \(step\.take\) \{\s*e\.preventDefault\(\)/.test(term))
  ok(
    'the hold timer is armed from the reducer and fires back into it',
    /case 'arm-timer':[\s\S]{0,200}setTimeout\([\s\S]{0,120}dispatch\(\{ type: 'timer' \}\)/.test(term)
  )
  ok('the strip says Keep holding while a press is pending', /'Keep holding…'/.test(term))
  ok(
    'the recorder’s level drives the line through a ref, not state',
    /onLevel: \(level\) =>[\s\S]{0,120}style\.transform = `scaleX\(/.test(term) && /ref=\{levelRef\}/.test(term)
  )
  ok('the recorder is handed the saved microphone', /device: \(\) => \(\{ id: voiceRef\.current\.micDeviceId/.test(term))
  ok('switching dictation on asks spaceOwner first', /spaceOwner\(tab, state\.claudeVoice\)/.test(term))
  ok('the chord and the menu share one toggle', (term.match(/toggleDictation(Ref\.current)?\(\)/g) ?? []).length >= 2)
  ok('a refused microphone goes through microphoneError', /microphoneError\(err, window\.stoke\.platform\)/.test(term))
  ok('the phone’s voice mode steps the same reducer', /spaceHold\(hold, event/.test(phone) && /spaceKey\(e, 'keydown'\)/.test(phone))
  ok('and no longer starts on the first press', !/e\.code === 'Space' && !e\.repeat\) void begin\(e\)/.test(phone))
  ok('the phone’s composer carries the level line', /onLevel: \(level\) =>[\s\S]{0,80}levelFill\.style\.transform/.test(phone))
  ok('Settings → Voice offers the microphone picker', /<MicPicker voice=\{voice\} patchVoice=\{patchVoice\}/.test(settingsUi))
  /*
   * Settings' Test meter claims per press. A shared placeholder claim let Test,
   * Stop, Test during a slow open install both streams and orphan one, lit
   * indicator and all — measured over CDP: one live track and one running
   * AudioContext left after Stop and after closing Settings.
   */
  ok(
    'the Test meter claims with a fresh object per press, not a shared placeholder',
    /const mine\b[^\n]*= \{ stop: null \}/.test(micUi) && /claimRef\.current = mine/.test(micUi) && !/Ref\.current = \(\) => \{\}/.test(micUi)
  )
  ok(
    'an open that lands after its claim moved closes its own microphone',
    /\.then\(\(t\) => \{\s*if \(claimRef\.current !== mine\) \{[\s\S]{0,120}t\.stop\(\)/.test(micUi)
  )
  ok(
    'a superseded failure clears nothing and shows nothing',
    /\.catch\([\s\S]{0,200}if \(claimRef\.current !== mine\) return\s*\n\s*claimRef\.current = null/.test(micUi)
  )

  /*
   * The providers' wire (gotcha 31): a dispatcher nobody calls with the chosen
   * provider is a green suite over dictation that still only reaches the
   * sidecar. Always read from the working copy.
   */
  const mainSrc = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  check(
    'desktop dictation and the phone both transcribe through sttConfigOf, read per call',
    (mainSrc.match(/transcribe\(sttConfigOf\(getSettings\(\)\.voice\)/g) ?? []).length,
    2
  )
  ok('no caller still hands stt.ts a bare address', !/transcribe\(getSettings\(\)\.voice\.sttUrl/.test(mainSrc))
  ok('the pill and the phone’s status ask sttReadiness, never a paid probe', /sttReadiness\(sttConfigOf\(getSettings\(\)\.voice\)\)/.test(mainSrc))
  ok(
    'main’s Test claims before its first await and refuses a second (gotcha 20)',
    /if \(voiceTesting\) return[^\n]*\n\s*voiceTesting = true\s*\n\s*try \{\s*\n\s*return await testSpeechService\(sttConfigFrom\(raw\)\)/.test(mainSrc)
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
