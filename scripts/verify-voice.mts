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
 *   node scripts/verify-voice.mts
 */
import { readFileSync } from 'node:fs'
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
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
