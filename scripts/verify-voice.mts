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
  CLI_OWNS_SPACE,
  claudeVoiceEnabled,
  dictationKeyAction,
  isMicAccess,
  micAccessLine,
  microphoneError,
  spaceOwner
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

console.log('\na held Space is one first press and then a stream of repeats')
check('the first press starts a recording', dictationKeyAction({ code: 'Space', repeat: false }), 'start')
check(
  'a REPEAT is swallowed — letting it through is what started Claude’s recorder too',
  dictationKeyAction({ code: 'Space', repeat: true }),
  'swallow'
)
check('any other key is left alone', dictationKeyAction({ code: 'KeyA', repeat: false }), 'pass')
check('including its repeats', dictationKeyAction({ code: 'KeyA', repeat: true }), 'pass')
{
  // The shipped rule before the fix, restated so the counterfactual is on record.
  const before = (e: { code: string; repeat: boolean }): string => (e.code !== 'Space' || e.repeat ? 'pass' : 'start')
  check('the old rule passed repeats on to the pty (the bug, pinned as history)', before({ code: 'Space', repeat: true }), 'pass')
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

console.log('\nthe wire: TerminalView really routes through these')
{
  const src = readFileSync(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url), 'utf8')
  ok('the old repeat pass-through is gone', !/e\.code !== 'Space' \|\| e\.repeat\) return/.test(src))
  ok('keydown decides with dictationKeyAction', /dictationKeyAction\(e\)/.test(src))
  ok('switching dictation on asks spaceOwner first', /spaceOwner\(tab, state\.claudeVoice\)/.test(src))
  ok('the chord and the menu share one toggle', (src.match(/toggleDictation(Ref\.current)?\(\)/g) ?? []).length >= 2)
  ok('a refused microphone goes through microphoneError', /microphoneError\(err, window\.stoke\.platform\)/.test(src))
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
