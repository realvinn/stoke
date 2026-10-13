import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'
import { codexLimitReset, DEFAULT_CODEX_RESUME, hydrateCodexResume, type CodexResumeObservation } from '../src/shared/codexResume.ts'
import { CodexResumeWatcher } from '../src/main/codexResume.ts'
import { ScreenMirror } from '../src/main/screenMirror.ts'
import { hydrateAgents } from '../src/shared/agents.ts'
import { PtyManager } from '../src/main/pty.ts'
import { SubmitQueue } from '../src/shared/remotePhone.ts'

let checks = 0
function check(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name); checks++; console.log(`PASS ${name}`)
}
const base = Date.UTC(2026, 9, 14, 1), minute = 60000, hour = 3600000
const error = (reset: string) => `■ You've hit your usage limit. Try again at ${reset}.\n\n› \n  gpt-6 · 80% context left`
check('old settings leave the watcher off', hydrateAgents({}).codexResume, DEFAULT_CODEX_RESUME)
check('missing settings are repaired', hydrateCodexResume(null), DEFAULT_CODEX_RESUME)
check('control characters cannot become keystrokes', hydrateCodexResume({ message: 'Continue\r/exit' }).message, 'Continue')
check('extreme intervals and empty messages are repaired', hydrateCodexResume({ enabled: true, checkMinutes: Infinity, recheckHours: -5, message: '  ' }), { enabled: true, checkMinutes: 5, recheckHours: 1 / 60, message: 'Continue' })
check('ISO reset is absolute', codexLimitReset(error('2026-10-14T01:02:00Z'), base)?.resetAt, base + 2 * minute)
check('Codex local date includes the year', codexLimitReset(error('Oct 14, 2026 1:30 AM'), base)?.resetAt, new Date(2026, 9, 14, 1, 30).getTime())
check('invalid day is unknown', codexLimitReset(error('Feb 31, 2026 1:30 AM'), base)?.resetAt, null)
check('invalid hour is unknown', codexLimitReset(error('Oct 14, 2026 25:30 AM'), base)?.resetAt, null)
check('invalid ISO day is unknown', codexLimitReset(error('2026-02-31T01:30:00Z'), base)?.resetAt, null)
check('ISO timezone and milliseconds are preserved', codexLimitReset(error('2026-10-14T12:02:00.123+11:00'), base)?.resetAt, base + 2 * minute + 123)
check('time without a date stays unknown', codexLimitReset(error('1:30 AM'), base)?.resetAt, null)
check('a quoted error in an answer is not a limit screen', codexLimitReset('• The error is: You\'ve hit your usage limit. Try again at Oct 14, 2026 1:30 AM.\n› ', base), null)
check('a newer assistant response outranks a historical error', codexLimitReset(error('Oct 14, 2026 1:30 AM').replace('› ', '• Finished the change.\n› '), base), null)
check('a running turn cannot be resumed', codexLimitReset(error('Oct 14, 2026 1:30 AM') + '\nesc to interrupt', base), null)
check('billing without a reset is unknown', codexLimitReset('■ Usage limit reached. Increase your limits.\n› ', base)?.resetAt, null)

function fixture(text = error('2026-10-14T01:02:00Z')) {
  const watcher = new CodexResumeWatcher()
  watcher.configure({ enabled: true, checkMinutes: 1, recheckHours: 5, message: 'Keep working' })
  let observation: CodexResumeObservation | null = { text, ready: true, lastInputAt: null, lastOutputAt: base - minute }
  const sent: Array<[string, string]> = []
  const tick = (at: number, ids = ['a']) => watcher.tick(ids, () => observation, (id, message) => { sent.push([id, message]); return true }, at)
  return { watcher, sent, tick, get observation() { return observation }, set observation(next) { observation = next } }
}
const f = fixture()
f.tick(base); f.tick(base + minute)
check('future reset sends nothing', f.sent, [])
f.tick(base + 2 * minute)
check('reset has a one-second grace', f.sent, [])
f.tick(base + 3 * minute)
check('reset submits the configured message exactly once', f.sent, [['a', 'Keep working']])
f.tick(base + 4 * minute)
check('no repeated submissions during cooldown', f.sent.length, 1)
f.observation = { text: '• Working (esc to interrupt)\n› ', ready: false, lastInputAt: base + 3 * minute, lastOutputAt: base + 4 * minute }
f.tick(base + 3 * minute + 5 * hour)
f.observation = { text: error('2026-10-14T01:02:00Z'), ready: true, lastInputAt: base + 3 * minute, lastOutputAt: base + 5 * hour }
f.tick(base + 6 * hour)
check('running at the five-hour check stops further monitoring', f.sent.length, 1)
const finished = fixture('• Finished.\n› ')
finished.tick(base); finished.tick(base + minute)
finished.observation!.text = error('2026-10-14T01:02:00Z'); finished.tick(base + hour)
check('a normal finished turn stops monitoring', finished.sent.length, 0)
const typed = fixture()
typed.tick(base); typed.tick(base + minute); typed.watcher.cancel('a'); typed.tick(base + hour)
check('typing after a limit was detected cancels the watcher', typed.sent.length, 0)
const unknown = fixture(error('sometime tomorrow'))
unknown.tick(base); unknown.tick(base + minute); unknown.tick(base + 24 * hour)
check('unknown reset never spends a turn', unknown.sent.length, 0)
const draft = fixture(); draft.observation!.ready = false
draft.tick(base); draft.tick(base + hour)
check('nonempty composer is never submitted', draft.sent.length, 0)
const active = fixture()
active.tick(base)
active.observation = { text: '• Working (esc to interrupt)\n› ', ready: false, lastInputAt: null, lastOutputAt: base + minute }
active.tick(base + minute)
active.observation = { text: error('2026-10-14T01:02:00Z'), ready: true, lastInputAt: null, lastOutputAt: base }
active.tick(base + hour)
check('ongoing output cannot keep a running session watcher alive', active.sent.length, 0)
const relative = fixture("■ You've hit your usage limit. Try again in 2 minutes.\n› ")
relative.tick(base); relative.tick(base + minute); relative.tick(base + 2 * minute); relative.tick(base + 3 * minute); relative.tick(base + 4 * minute)
check('relative reset does not slide forward on each check', relative.sent.length, 1)
const stale = fixture()
stale.tick(base); stale.tick(base + 3 * minute); stale.tick(base + 3 * minute + 5 * hour)
check('unchanged old error cannot authorize a second continue', stale.sent.length, 1)
const limitedAgain = fixture()
limitedAgain.tick(base); limitedAgain.tick(base + 3 * minute)
limitedAgain.observation = { text: error('2026-10-14T01:02:00Z'), ready: true, lastInputAt: base + 3 * minute, lastOutputAt: base + 4 * minute }
limitedAgain.tick(base + 3 * minute + 5 * hour)
check('a new limit after resuming can trigger a later retry', limitedAgain.sent.length, 2)
const gone = fixture(); gone.tick(base); gone.tick(base + minute); gone.tick(base + hour, [])
check('closed sessions never receive input', gone.sent.length, 0)
const disabled = fixture(); disabled.tick(base); disabled.watcher.configure(DEFAULT_CODEX_RESUME); disabled.tick(base + hour)
check('disabling cancels pending checks', disabled.sent.length, 0)

const mirror = new ScreenMirror(100, 24)
try {
  const paint = async (text: string, row: number, col: number) => {
    mirror.write(`\x1b[2J\x1b[H${text}\x1b[${row};${col}H`)
    await pause(20)
    return mirror.inspectComposer()
  }
  const empty = await paint(error('Oct 14, 2026 1:30 AM').replace(/\n/g, '\r\n'), 3, 3)
  check('xterm recognizes the empty Codex composer', empty?.ready, true)
  check('xterm exposes the visible limit', codexLimitReset(empty!.text, base)?.resetAt, new Date(2026, 9, 14, 1, 30).getTime())
  check('xterm refuses typed text even with cursor moved to the beginning', (await paint('› existing draft', 1, 3))?.ready, false)
  check('dim placeholder is safe at the empty cursor', (await paint('› \x1b[2mExplain this codebase\x1b[0m', 1, 3))?.ready, true)
  mirror.write('\x1b[2J\x1b[H› ')
  check('unparsed terminal output stays unknown', mirror.inspectComposer(), null)
  await pause(20)
  check('erasing the screen removes old limit evidence', codexLimitReset(mirror.inspectComposer()!.text, base), null)
} finally { mirror.dispose() }

const narrow = new ScreenMirror(33, 24)
try {
  narrow.write(error('Oct 14, 2026 1:30 AM').replace(/\n/g, '\r\n'))
  await pause(20)
  check('soft wraps preserve limit words and reset dates on narrow terminals', codexLimitReset(narrow.inspectComposer()!.text, base)?.resetAt, new Date(2026, 9, 14, 1, 30).getTime())
} finally { narrow.dispose() }

// Exercise the real PTY manager's guarded submit queue, without launching a paid agent.
const nativeBase = Date.now() - hour
const settings = { enabled: true, checkMinutes: 1, recheckHours: 5, message: 'Continue' }
for (const scenario of ['send', 'typed', 'disabled', 'screen-changed', 'relative', 'private', 'remote', 'installer', 'signin', 'other-agent', 'exited']) {
  const screen = new ScreenMirror(100, 24)
  const writes: string[] = []
  const manager = new PtyManager(() => {}, () => {}, () => {})
  const session = {
    cli: scenario === 'other-agent' ? 'claude' : 'codex', ptyId: 'a', ordinary: !['installer', 'signin'].includes(scenario), private: scenario === 'private', hostId: scenario === 'remote' ? 'remote' : null,
    exited: scenario === 'exited', mirror: screen, lastInputAt: null, inputRevision: 0, lastActivityAt: nativeBase - minute, login: null,
    bracketedPaste: false, submits: new SubmitQueue({ chunkGapMs: 1, enterDelayMs: 10, afterEnterMs: 1 }), proc: { write: (data: string) => writes.push(data) }
  }
  const internal = manager as unknown as { sessions: Map<string, unknown> }
  internal.sessions.set('a', session)
  try {
    const text = scenario === 'relative' ? "■ You've hit your usage limit. Try again in 1 minute.\n\n› " : error(new Date(nativeBase + 2 * minute).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    screen.write(`\x1b[2J\x1b[H${text.replace(/\n/g, '\r\n')}\x1b[3;3H`)
    await pause(20)
    manager.checkCodexResume(settings, nativeBase)
    manager.checkCodexResume(settings, nativeBase + minute)
    manager.checkCodexResume(settings, nativeBase + 3 * minute)
    if (scenario === 'typed') manager.write('a', 'my draft')
    if (scenario === 'disabled') manager.checkCodexResume({ ...settings, enabled: false }, nativeBase + 3 * minute)
    if (scenario === 'screen-changed') screen.write('\x1b[2J\x1b[H• Finished\r\n› ')
    await pause(100)
    check(`PTY submit queue: ${scenario}`, writes.join(''), ['send', 'relative'].includes(scenario) ? 'Continue\r' : scenario === 'typed' ? 'my draft' : '')
  } finally { screen.dispose() }
}
console.log(`\n${checks} Codex resume checks passed`)
