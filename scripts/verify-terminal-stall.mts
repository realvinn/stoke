/*
 * The terminal stall scrim (shared/terminalStall.ts, TerminalStallOverlay.tsx)
 * and Force restart's kill (main/processTree.ts, `PtyManager.stop(…, force)`).
 *
 * Four parts:
 *   1. what counts as typing, and what is a password prompt — every false alarm
 *      the rule has to rule out, by its bytes;
 *   2. the state machine on a fake clock: starting, slow, not responding, the
 *      probe, Stoke busy (the main ping), Keep waiting, exit;
 *   3. the tree kill with fakes (the order of signals, Windows' taskkill);
 *   4. a REAL pty whose node child traps SIGTERM with its event loop blocked,
 *      and a grandchild in its group that traps it too: the forced stop must
 *      leave neither, through a real PtyManager — and the ordinary stop must
 *      not be enough, or the escalation proves nothing.
 *
 * Plus the wire (gotcha 31): the source text that feeds the machine, offers the
 * restart and carries `force` to main.
 *
 * The real part spawns under this run's own scratch TMPDIR (suite-tmpdir.mts,
 * imported first, gotcha 74): PtyManager's bookkeeping releases statusLine
 * files, and nothing here may touch a shared directory.
 */
import { requireScratch } from './suite-tmpdir.mts'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NO_STALL,
  PING_DEADLINE_MS,
  PROBE_WAIT_MS,
  RECHECK_MS,
  SILENT_MS,
  STARTING_SHOW_MS,
  STARTING_SLOW_MS,
  UNPROBED_MIN_INPUTS,
  forceRestartRoute,
  isTypedInput,
  looksLikeSecretPrompt,
  newStall,
  sameStallView,
  schemeProbe,
  stallExit,
  stallInput,
  stallKeepWaiting,
  stallOutput,
  stallPingAnswered,
  stallPingSent,
  stallProbeSent,
  stallText,
  stallVerdict,
  type StallState
} from '../src/shared/terminalStall.ts'
import { isTerminalReport } from '../src/shared/remotePhone.ts'
import { FORCE_KILL_GRACE_MS, killProcessTree, type TreeKillDeps } from '../src/main/processTree.ts'

requireScratch(join(tmpdir(), 'stoke'), 'tmpdir()/stoke')

let failures = 0
let passes = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passes++
  else failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const root = new URL('..', import.meta.url).pathname
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

/* ---------------------------------------------------------- 1. classifiers */

console.log('\nWhat counts as typing (isTypedInput)')
const typed: [string, string, boolean][] = [
  ['a printable key', 'a', true],
  ['Enter', '\r', true],
  ['a space (dictation types it through onData too)', ' ', true],
  ['a non-ASCII character', 'é', true],
  ['a paste with text in its brackets', '\x1b[200~hello\x1b[201~', true],
  ['a focus report with a key after it', '\x1b[Ix', true],
  ['nothing', '', false],
  ['an arrow', '\x1b[A', false],
  ['an application-mode arrow (SS3)', '\x1bOA', false],
  ['F5', '\x1b[15~', false],
  ['focus in', '\x1b[I', false],
  ['focus out', '\x1b[O', false],
  ['an SGR mouse press', '\x1b[<0;10;5M', false],
  ['an SGR motion report', '\x1b[<35;80;20M', false],
  ['an X10 mouse report, whose payload bytes are printable', '\x1b[M #!', false],
  ['a urxvt mouse report', '\x1b[32;10;5M', false],
  ['bracketed-paste markers alone', '\x1b[200~\x1b[201~', false],
  ['a device-attributes reply', '\x1b[?1;2c', false],
  ['a cursor-position reply', '\x1b[12;5R', false],
  ['a DECRPM reply', '\x1b[?2026;2$y', false],
  ['an OSC 11 colour answer (ST)', '\x1b]11;rgb:1a1a/1b1b/1c1c\x1b\\', false],
  ['an OSC 11 colour answer (BEL)', '\x1b]11;rgb:1a1a/1b1b/1c1c\x07', false],
  ['a DCS reply', '\x1bP1$r0m\x1b\\', false],
  ['Alt+b (a chord)', '\x1bb', false],
  ['Ctrl+C', '\x03', false],
  ['Tab', '\t', false],
  ['Backspace', '\x7f', false],
  ['the probe itself, were it ever to pass through onData', schemeProbe(false), false]
]
for (const [name, data, want] of typed) check(name, isTypedInput(data), want)

console.log('\nA password prompt reads with echo off (looksLikeSecretPrompt)')
const prompts: [string, string, boolean][] = [
  ["ssh's own", "v@host's password: ", true],
  ['sudo', '[sudo] password for v: ', true],
  ["git's credential helper", "Password for 'https://v@github.com': ", true],
  ["ssh's key passphrase", "Enter passphrase for key '/home/v/.ssh/id_ed25519': ", true],
  ['PAM keyboard-interactive', '(v@host) Password:', true],
  ['a smart card', "Enter PIN for 'PIV Card Holder pin': ", true],
  ['a one-time code', 'Verification code: ', true],
  ['a styled prompt', '\x1b[1mPassword:\x1b[0m ', true],
  ['after a banner line', 'Do not share your password with anyone.\r\nv@host\'s password: ', true],
  [
    'ConPTY parks the cursor after a repainted prompt (gotcha 75)',
    "\x1b[H\x1b[KWelcome\x1b[K\r\nv@host's password: \x1b[K\r\n\x1b[K\x1b[2;20H",
    true
  ],
  [
    'ConPTY repainting row by row with cursor moves alone, a long banner row above the prompt',
    `\x1b[1;1H${'Welcome to the build machine. '.repeat(9)}\x1b[K\x1b[2;1Hv@host's password: \x1b[K\x1b[2;20H`,
    true
  ],
  ['a banner alone, then a shell prompt', 'Do not share your password with anyone.\r\n$ ', false],
  ['a line ending in > is not a prompt here', 'paste your token >', false],
  ['an answered prompt, then output', 'Password: \r\nok\r\nv@box:~$ ', false],
  ['a question that is not a secret', 'Enter your name: ', false],
  ['a Claude Code footer', '\x1b[2K\x1b[38;5;244m  ? for shortcuts\x1b[0m\x1b[K', false],
  ['a 300-character line', `${'x'.repeat(290)} password: `, false],
  ['nothing', '', false]
]
for (const [name, tail, want] of prompts) check(name, looksLikeSecretPrompt(tail), want)

/* ------------------------------------------------------- 2. state machine */

const v = (s: StallState, at: number) => stallVerdict(s, at)
const kind = (s: StallState, at: number): string => {
  const view = v(s, at).view
  return view.kind === 'starting' ? `starting${view.slow ? ':slow' : ''}` : view.kind
}
/** Send the ping a verdict asks for, as the watch does. */
function ping(s: StallState, at: number): { s: StallState; seq: number } {
  const sent = stallPingSent(s, at)
  return { s: sent.state, seq: sent.seq }
}

console.log('\nStarting: from the spawn to the first byte')
{
  const s0 = newStall(0)
  check('nothing shows before STARTING_SHOW_MS (no flash)', [kind(s0, 0), kind(s0, STARTING_SHOW_MS - 1)], ['none', 'none'])
  check('and it asks to be looked at again then', v(s0, 0).nextAt, STARTING_SHOW_MS)
  check('then "Starting…"', kind(s0, STARTING_SHOW_MS), 'starting')
  check('which waits until STARTING_SLOW_MS', [kind(s0, STARTING_SLOW_MS - 1), v(s0, STARTING_SHOW_MS).nextAt], ['starting', STARTING_SLOW_MS])
  check('slow: main is asked before Force restart is offered', [kind(s0, STARTING_SLOW_MS), v(s0, STARTING_SLOW_MS).act], ['starting', 'ping'])
  let { s, seq } = ping(s0, STARTING_SLOW_MS)
  check('no second ping beside one in flight', v(s, STARTING_SLOW_MS + 10).act, null)
  const answered = stallPingAnswered(s, seq, STARTING_SLOW_MS + 30)
  check('main answers in time: "It hasn\'t printed anything yet" + Force restart', kind(answered, STARTING_SLOW_MS + 30), 'starting:slow')
  check('its words', stallText(v(answered, STARTING_SLOW_MS + 30).view, { cliId: 'claude', hostId: null }, null).detail, "It hasn't printed anything yet.")
  check('Force restart offered when slow', stallText({ kind: 'starting', slow: true }, { cliId: 'claude', hostId: null }, null).canRestart, true)
  check('and not before', stallText({ kind: 'starting', slow: false }, { cliId: 'claude', hostId: null }, null).canRestart, false)
  // Main never answers: it is Stoke.
  check('main silent past its deadline: "Stoke is busy"', kind(s, STARTING_SLOW_MS + PING_DEADLINE_MS + 1), 'stoke-busy')
  s = stallPingAnswered(s, seq, STARTING_SLOW_MS + 4000)
  check('a late answer keeps "Stoke is busy" and asks again', [kind(s, STARTING_SLOW_MS + 4000), v(s, STARTING_SLOW_MS + 4000).act], ['stoke-busy', 'ping'])
  ;({ s, seq } = ping(s, STARTING_SLOW_MS + 4000))
  s = stallPingAnswered(s, seq, STARTING_SLOW_MS + 4020)
  check('the next answer in time: back to the slow start', kind(s, STARTING_SLOW_MS + 4020), 'starting:slow')
  s = stallOutput(s, 'x', STARTING_SLOW_MS + 5000)
  check('the first byte ends it', [kind(s, STARTING_SLOW_MS + 5000), v(s, STARTING_SLOW_MS + 5000).nextAt], ['none', null])
  const fast = stallOutput(newStall(0), '\x1b[?2004h', 40)
  check('a fast start never shows anything, even an escape-only first chunk', [kind(fast, STARTING_SHOW_MS), kind(fast, STARTING_SLOW_MS)], ['none', 'none'])
  check('an empty chunk is not output', stallOutput(s0, '', 10).outputAt, null)
}

console.log('\nTyping, and the silence after it (the probe answered)')
// A Claude Code tab: it turned mode 2031 on, so it can be asked.
const live = stallOutput(newStall(0), 'banner\x1b[?2031h', 100)
check('mode 2031 seen: the program can be probed', live.reportsScheme, true)
check('but nothing is known yet about whether it answers a probe', live.probeAnswers, false)
/*
 * A Claude Code whose theme is `auto` answers the probe with an OSC 11 query
 * (read out of 2.1.312: `watchSystemTheme`). One answered probe teaches it.
 */
const learned = stallOutput(stallProbeSent(live, 150), '\x1b]11;?\x07\x1b[c', 160)
check('a probe answered with an OSC 11 query: this program answers probes', learned.probeAnswers, true)
{
  let s = stallInput(learned, 'a', 1000)
  check('a keystroke starts the clock', [s.inputAt, kind(s, 1000), v(s, 1000).nextAt], [1000, 'none', 1000 + SILENT_MS])
  check('nothing before SILENT_MS', kind(s, 1000 + SILENT_MS - 1), 'none')
  s = stallInput(s, 'b', 1200)
  check('more keys keep the first one\'s clock', [s.inputAt, s.inputs], [1000, 2])
  const at = 1000 + SILENT_MS
  check('at SILENT_MS: ask main first, show nothing yet', [kind(s, at), v(s, at).act], ['none', 'ping'])
  let seq: number
  ;({ s, seq } = ping(s, at))
  check('waiting on the answer', [kind(s, at + 500), v(s, at + 500).act, v(s, at + 500).nextAt], ['none', null, at + PING_DEADLINE_MS + 1])
  s = stallPingAnswered(s, seq, at + 20)
  check('main answers: probe the program, still showing nothing', [kind(s, at + 20), v(s, at + 20).act], ['none', 'probe'])
  s = stallProbeSent(s, at + 20)
  check('waiting PROBE_WAIT_MS for any byte', [kind(s, at + 20 + PROBE_WAIT_MS - 1), v(s, at + 20).nextAt], ['none', at + 20 + PROBE_WAIT_MS])
  const answeredProbe = stallOutput(s, '\x1b]11;?\x07\x1b[c', at + 300)
  check('a live program answers the probe: no scrim ever', [kind(answeredProbe, at + 20 + PROBE_WAIT_MS), kind(answeredProbe, at + 60_000)], ['none', 'none'])
  check('"isn\'t responding" only once the probe went unanswered', kind(s, at + 20 + PROBE_WAIT_MS), 'not-responding')
  const shownAt = at + 20 + PROBE_WAIT_MS
  check('its words name the agent and clear Stoke', stallText(v(s, shownAt).view, { cliId: 'claude', hostId: null }, null), {
    confirm: "Restart Claude Code? Anything it hasn't saved is lost.",
    confirmLabel: 'Restart',
    restarting: 'Restarting Claude Code…',
    title: "Claude Code isn't responding",
    detail: 'Nothing has come back since you typed. Stoke itself is fine.',
    canRestart: true,
    canWait: true
  })
  const back = stallOutput(s, 'x', shownAt + 100)
  check('any byte takes it down at once', kind(back, shownAt + 100), 'none')

  // While it shows, main is asked again: a stall that starts now is Stoke's.
  // Counted from when the answered ping was SENT (at), not when it came back.
  const recheck = at + RECHECK_MS
  check('re-asks main every RECHECK_MS while it shows', [kind(s, recheck - 1), v(s, recheck - 1).act, v(s, recheck).act], ['not-responding', null, 'ping'])
  let r = ping(s, recheck)
  check('the recheck in flight keeps the scrim as it is', kind(r.s, recheck + 500), 'not-responding')
  check('main misses the recheck: now it is Stoke', kind(r.s, recheck + PING_DEADLINE_MS + 1), 'stoke-busy')
  check('"Stoke is busy" offers no Force restart', stallText({ kind: 'stoke-busy' }, { cliId: 'claude', hostId: null }, null).canRestart, false)
  // A stale answer (an older ping) changes nothing.
  check('a stale answer is ignored', stallPingAnswered(r.s, r.seq - 1, recheck + 10), r.s)

  // Keep waiting.
  let k = stallKeepWaiting(s)
  check('Keep waiting hides it', [kind(k, shownAt), kind(k, shownAt + 60_000)], ['none', 'none'])
  k = stallInput(k, 'z', shownAt + 61_000)
  check('the next keystroke starts the clock AGAIN, not the scrim at once', [k.inputAt, k.inputs, k.probeAt, kind(k, shownAt + 61_000)], [shownAt + 61_000, 1, null, 'none'])
  const k2at = shownAt + 61_000 + SILENT_MS
  r = ping(k, k2at)
  k = stallPingAnswered(r.s, r.seq, k2at + 5)
  check('and the new episode is probed afresh', v(k, k2at + 5).act, 'probe')

  // Exit.
  const ex = stallExit(s)
  check('an exited process shows nothing', kind(ex, shownAt), 'none')
  check('and typing after exit counts for nothing', stallInput(ex, 'a', shownAt + 10), ex)
}

console.log('\nA probe that is never answered: Claude Code on a pinned theme (the owner\'s is `dark`)')
{
  /*
   * 2.1.312 turns 2031 on whenever it holds the terminal, but nothing in it
   * listens for the report unless its theme is `auto`. So a live Claude at an
   * empty prompt, given one Enter that changes nothing, says nothing to the
   * probe either. That must not read as a hang.
   */
  const probeOnce = (start: StallState, keys: string[]): StallState => {
    let s = start
    for (const [i, key] of keys.entries()) s = stallInput(s, key, 1000 + i * 100)
    const at = 1000 + SILENT_MS
    const r = ping(s, at)
    return stallProbeSent(stallPingAnswered(r.s, r.seq, at + 10), at + 10)
  }
  const due = 1000 + SILENT_MS + 10 + PROBE_WAIT_MS
  const one = probeOnce(live, ['\r'])
  check('one Enter, the probe unanswered, nothing learned: no scrim', [kind(one, due), v(one, due).act, v(one, due).nextAt], ['none', null, null])
  check('Enter tapped on an empty prompt, again and again: no scrim', kind(probeOnce(live, ['\r', '\r', '\r', '\r']), due), 'none')
  check('letters at a permission dialog that ignores them: no scrim', kind(probeOnce(live, ['x', 'y', 'z', 'w']), due), 'none')
  check(`${UNPROBED_MIN_INPUTS} keys with a character AND an Enter, the probe unanswered: "isn't responding"`, kind(probeOnce(live, ['h', 'i', '\r']), due), 'not-responding')
  check('a program that has answered a probe before: one key is enough', kind(probeOnce(learned, ['\r']), due), 'not-responding')
  const unasked = stallOutput(live, '\x1b]11;?\x07', 200)
  check('an OSC 11 query nobody probed for teaches nothing', unasked.probeAnswers, false)
  const again = stallOutput(stallOutput(learned, '\x1b[?2031l$ ', 300), '\x1b[?2031h', 400)
  check('2031 off and on again (a new program) forgets it', [again.reportsScheme, again.probeAnswers], [true, false])
  check('and plain output keeps it', stallOutput(learned, 'x', 300).probeAnswers, true)
}

console.log('\nThe main ping when the silence is Stoke\'s')
{
  let s = stallInput(live, '\r', 1000)
  const at = 1000 + SILENT_MS
  const sent = ping(s, at)
  s = sent.s
  check('no answer within PING_DEADLINE_MS: "Stoke is busy", not the program', [kind(s, at + PING_DEADLINE_MS), kind(s, at + PING_DEADLINE_MS + 1)], ['none', 'stoke-busy'])
  check('no probe is sent while main is the one not answering', v(s, at + PING_DEADLINE_MS + 1).act, null)
  check('its words', stallText({ kind: 'stoke-busy' }, { cliId: 'claude', hostId: null }, null).title, 'Stoke is busy')
  s = stallOutput(s, 'queued bytes', at + 6000)
  check('main catching up delivers the bytes: gone', kind(s, at + 6000), 'none')
}

console.log('\nA program that cannot be probed (no mode 2031)')
{
  const shell = stallOutput(newStall(0), 'v@box:~$ ', 100)
  check('no 2031: not probeable', shell.reportsScheme, false)
  let s = stallInput(shell, 'q', 1000)
  const at = 1000 + SILENT_MS
  const sent = ping(s, at)
  s = stallPingAnswered(sent.s, sent.seq, at + 10)
  check(`one ignored key is not a hang (needs ${UNPROBED_MIN_INPUTS})`, [kind(s, at + 10), v(s, at + 10).act, v(s, at + 10).nextAt], ['none', null, null])
  s = stallInput(s, 'q', at + 500)
  check('two still are not', kind(s, at + 500), 'none')
  s = stallInput(s, 'q', at + 900)
  check(`${UNPROBED_MIN_INPUTS} letters a pager ignores, no Enter among them, are not either`, kind(s, at + 900), 'none')
  s = stallInput(s, '\r', at + 1200)
  check('characters and an Enter with nothing back are', kind(s, at + 1200), 'not-responding')
  const off = stallOutput(stallOutput(newStall(0), '\x1b[?2031h', 10), '\x1b[?2031l$ ', 20)
  check('2031 turned off again: not probeable', off.reportsScheme, false)
  check('the last of on/off in one chunk wins', stallOutput(newStall(0), '\x1b[?2031l\x1b[?2031h', 10).reportsScheme, true)
}

console.log('\nFalse alarms that must stay quiet')
{
  const prompt = stallOutput(newStall(0), "v@vps's password: ", 100)
  let s = prompt
  for (const [i, ch] of [...'hunter2\r'].entries()) s = stallInput(s, ch, 1000 + i * 100)
  check('typing a password into an echo-off prompt starts nothing', [s.inputAt, kind(s, 60_000)], [null, 'none'])
  const sudo = stallOutput(stallOutput(newStall(0), 'x', 10), '[sudo] password for v: ', 100)
  check('nor at sudo\'s', kind(stallInput(sudo, 'p', 1000), 60_000), 'none')
  const after = stallOutput(prompt, '\r\nWelcome\r\nv@vps:~$ ', 5000)
  check('once the prompt is answered, the shell counts again', stallInput(after, 'l', 6000).inputAt, 6000)

  let m = live
  for (const [i, data] of ['\x1b[<35;10;5M', '\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b[M #!', '\x1b[I', '\x1b[O', '\x1b[200~\x1b[201~', '\x1b[?1;2c', '\x1b]11;rgb:0/0/0\x1b\\', '\x1b[A', '\x1bOB'].entries()) {
    m = stallInput(m, data, 1000 + i)
  }
  check('mouse, focus, paste markers, replies and arrows start nothing', [m.inputAt, kind(m, 60_000)], [null, 'none'])
  const dismissed = stallKeepWaiting(stallInput(live, 'a', 1000))
  check('mouse movement after Keep waiting does not bring it back', stallInput(dismissed, '\x1b[<35;1;1M', 9000).dismissed, true)
}

console.log('\nThe probe, the copy and the route')
check('the probe is the colour-scheme report for the class in force (dark)', schemeProbe(false), '\x1b[?997;1n')
check('(light)', schemeProbe(true), '\x1b[?997;2n')
check('main reads the probe as a terminal report, not typing (lastInputAt does not move)', [isTerminalReport(schemeProbe(false)), isTerminalReport(schemeProbe(true))], [true, true])
check('starting, local', stallText({ kind: 'starting', slow: false }, { cliId: 'codex', hostId: null }, null).title, 'Starting Codex CLI…')
check('starting, SSH', stallText({ kind: 'starting', slow: false }, { cliId: 'claude', hostId: 'h1' }, 'VPS').title, 'Connecting to VPS…')
check('not responding, SSH', stallText({ kind: 'not-responding' }, { cliId: 'claude', hostId: 'h1' }, 'VPS').title, "VPS isn't responding")
check('confirm, SSH', stallText({ kind: 'not-responding' }, { cliId: 'claude', hostId: 'h1' }, 'VPS').confirm, "Reconnect to VPS? Anything it hasn't saved is lost.")
check('confirm, private chat', stallText({ kind: 'not-responding' }, { cliId: 'claude', hostId: null, private: true }, null).confirm, 'Restart this private chat? It is deleted, and a new one starts.')
check('starting, install', stallText({ kind: 'starting', slow: false }, { cliId: 'codex', hostId: null, installing: ['codex'] }, null).title, 'Starting the installer…')
check('starting, key enrollment', stallText({ kind: 'starting', slow: false }, { cliId: 'claude', hostId: 'h1', enrollHostId: 'h1' }, 'VPS').title, 'Connecting to VPS…')
check('sameStallView tells slow from not', [sameStallView({ kind: 'starting', slow: true }, { kind: 'starting', slow: false }), sameStallView(NO_STALL, { kind: 'none' })], [false, true])
check('a local Claude tab relaunches (resumes its session)', forceRestartRoute({ cliId: 'claude', hostId: null }), 'relaunch')
check('a local Codex tab relaunches too', forceRestartRoute({ cliId: 'codex', hostId: null }), 'relaunch')
for (const [name, tab] of [
  ['an SSH tab', { hostId: 'h1' }],
  ['a private chat', { hostId: null, private: true }],
  ['an install', { hostId: null, installing: ['codex'] }],
  ['a key enrollment', { hostId: 'h1', enrollHostId: 'h1' }],
  ['a sign-in', { hostId: null, accountLogin: 'acct-1' }]
] as const) {
  check(`${name} takes its Start again`, forceRestartRoute(tab), 'start-again')
}

/* ----------------------------------------------------- 3. tree kill, fakes */

console.log('\nThe tree kill, with fakes')
function fakeDeps(opts: {
  platform?: string
  /** When the group (or pid) stops existing, in fake ms, per signal that kills it. */
  diesOn?: 'SIGTERM' | 'SIGKILL' | 'never'
  /** `ps` says the child leads its group, but signalling the group fails anyway. */
  groupRefuses?: boolean
  /** `ps` says the child is NOT a group leader. */
  notLeader?: boolean
  /** `ps` could not say (no ps, a timeout). */
  noPs?: boolean
  /** `ps` says Stoke itself is in the child's group. */
  stokeInGroup?: boolean
  eperm?: boolean
  taskkillFails?: boolean
  /** The pty's exit event has already run (so its pid may be someone else's). */
  exited?: boolean
  /** The exit event runs this many fake ms in. */
  exitsAfterMs?: number
  /**
   * The leader dies on the pty's own kill (SIGHUP) and is reaped at once, so a
   * `ps` asked after it no longer lists it; its group lives on in a grandchild.
   */
  leaderDiesOnFallback?: boolean
}) {
  const calls: string[] = []
  let alive = true
  let now = 0
  let leaderGone = false
  const SELF = { pid: 7, ppid: 6 }
  const deps: TreeKillDeps = {
    platform: opts.platform ?? 'darwin',
    self: SELF,
    exited: () => leaderGone || opts.exited === true || (opts.exitsAfterMs !== undefined && now >= opts.exitsAfterMs),
    groups: async (pids) => {
      if (opts.noPs) return null
      const map = new Map<number, number>()
      for (const p of pids) {
        if (p === SELF.pid) map.set(p, opts.stokeInGroup ? 4242 : 5000)
        else if (!leaderGone) map.set(p, opts.notLeader ? 5000 : p)
      }
      return map
    },
    signal: (pid, sig) => {
      if (sig !== 0) calls.push(`${sig} ${pid}`)
      if (opts.groupRefuses && pid < 0) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      if (sig === 0) {
        if (alive) return
        if (opts.eperm) {
          const err = new Error('EPERM') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      if (sig === opts.diesOn) alive = false
    },
    taskkill: async (pid) => {
      calls.push(`taskkill ${pid}`)
      if (opts.taskkillFails) throw new Error('Access is denied.')
    },
    fallback: () => {
      calls.push('fallback')
      if (opts.leaderDiesOnFallback) leaderGone = true
    },
    sleep: async (ms) => {
      now += ms
    }
  }
  return { deps, calls, elapsed: () => now }
}
{
  const t = fakeDeps({ diesOn: 'SIGTERM' })
  check('a group that goes on SIGTERM: the pty\'s own kill, the group\'s SIGTERM, no SIGKILL', [await killProcessTree(4242, t.deps), t.calls], ['terminated', ['fallback', 'SIGTERM -4242']])
}
{
  const t = fakeDeps({ diesOn: 'SIGKILL' })
  const outcome = await killProcessTree(4242, t.deps)
  check('a group that holds SIGTERM: SIGKILL to the GROUP after the grace', [outcome, t.calls], ['killed', ['fallback', 'SIGTERM -4242', 'SIGKILL -4242']])
  check(`the grace is FORCE_KILL_GRACE_MS (${FORCE_KILL_GRACE_MS} ms)`, t.elapsed() >= FORCE_KILL_GRACE_MS, true)
}
{
  const t = fakeDeps({ diesOn: 'never' })
  check('a process the kernel holds even past SIGKILL is reported stuck', await killProcessTree(4242, t.deps), 'stuck')
}
{
  const t = fakeDeps({ diesOn: 'SIGKILL', notLeader: true })
  check('not a group leader (ps): the pid alone, never a group', [await killProcessTree(4242, t.deps), t.calls], ['killed', ['fallback', 'SIGTERM 4242', 'SIGKILL 4242']])
  const n = fakeDeps({ diesOn: 'SIGKILL', noPs: true })
  check('ps could not say: the pid alone', [await killProcessTree(4242, n.deps), n.calls], ['killed', ['fallback', 'SIGTERM 4242', 'SIGKILL 4242']])
  const g = fakeDeps({ diesOn: 'SIGKILL', stokeInGroup: true })
  check('Stoke is in the child\'s group: the pid alone, never Stoke\'s own group', [await killProcessTree(4242, g.deps), g.calls], ['killed', ['fallback', 'SIGTERM 4242', 'SIGKILL 4242']])
}
{
  const t = fakeDeps({ diesOn: 'SIGKILL', groupRefuses: true })
  const outcome = await killProcessTree(4242, t.deps)
  check('a leader whose group signal fails: the pid itself, same escalation', [outcome, t.calls], ['killed', ['fallback', 'SIGTERM -4242', 'SIGTERM 4242', 'SIGKILL 4242']])
}
{
  /*
   * The leader dies on the pty's own SIGHUP and is reaped before `ps` answers,
   * while a grandchild that traps SIGHUP and SIGTERM (an MCP server) is still
   * in its group. The group must still be killed: POSIX never reuses a group id
   * while the group has a member, so signalling it is safe after the leader is
   * gone. Only the pid ALONE is not.
   */
  const t = fakeDeps({ diesOn: 'SIGKILL', leaderDiesOnFallback: true })
  check('a leader that dies on the SIGHUP: its group is still killed', [await killProcessTree(4242, t.deps), t.calls], ['killed', ['fallback', 'SIGTERM -4242', 'SIGKILL -4242']])
  const e = fakeDeps({ diesOn: 'SIGKILL', leaderDiesOnFallback: true, groupRefuses: true })
  check('…and when nothing in the group takes the SIGTERM either, its freed pid is not signalled', [await killProcessTree(4242, e.deps), e.calls], ['terminated', ['fallback', 'SIGTERM -4242']])
}
{
  const t = fakeDeps({ diesOn: 'SIGTERM', eperm: true })
  check('EPERM (a setuid member) counts as still there', await killProcessTree(4242, t.deps), 'stuck')
}
{
  const t = fakeDeps({ platform: 'win32' })
  check('Windows: taskkill /T the tree, then the pty\'s own kill; no signals', [await killProcessTree(77, t.deps), t.calls], ['taskkill', ['taskkill 77', 'fallback']])
  const f = fakeDeps({ platform: 'win32', taskkillFails: true })
  check('Windows: a refused taskkill still closes the pty', [await killProcessTree(77, f.deps), f.calls], ['taskkill', ['taskkill 77', 'fallback']])
}
{
  /*
   * kill(0) is the CALLER's own process group (Stoke), `-0` is 0, and kill(-1)
   * is every process the user owns. An SSH tab's pty reports pid 0 once its
   * ssh has exited (sshFallback.ts), and an ended session stays in the map for
   * ten minutes (gotcha 84), so a confirm racing the exit lands exactly here.
   */
  for (const pid of [0, -0, 1, -1, -4242, Number.NaN, 4242.5, 7, 6]) {
    const t = fakeDeps({ diesOn: 'SIGKILL' })
    const label = Object.is(pid, -0) ? '-0' : pid === 7 ? "Stoke's own pid" : pid === 6 ? "Stoke's parent" : String(pid)
    check(`pid ${label}: nothing is signalled, only the pty's own kill`, [await killProcessTree(pid, t.deps), t.calls], ['gone', ['fallback']])
  }
  const w = fakeDeps({ platform: 'win32' })
  check('Windows pid 0 (System Idle): no taskkill', [await killProcessTree(0, w.deps), w.calls], ['gone', ['fallback']])
}
{
  // After its exit event a pid may be reused, on Windows within moments: never signal it, never taskkill it.
  const t = fakeDeps({ diesOn: 'SIGKILL', exited: true })
  check('an exited process: nothing is signalled', [await killProcessTree(4242, t.deps), t.calls], ['gone', ['fallback']])
  const w = fakeDeps({ platform: 'win32', exited: true })
  check('an exited process on Windows: no taskkill /T of whoever has its pid now', [await killProcessTree(77, w.deps), w.calls], ['gone', ['fallback']])
  // No group, the pid alone: it exits during the grace and its number is reused (still "alive").
  const r = fakeDeps({ diesOn: 'never', notLeader: true, exitsAfterMs: 500 })
  check('the pid alone, exited during the grace: no SIGKILL to its reused number', [await killProcessTree(4242, r.deps), r.calls], ['terminated', ['fallback', 'SIGTERM 4242']])
}
{
  const src = read('src/main/processTree.ts')
  check('taskkill by absolute path, /T /F', /System32', 'taskkill\.exe'\)/.test(src) && /'\/T', '\/F'/.test(src), true)
}

/* ----------------------------------------------- 4. a real pty, real kill */

const alivePid = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/*
 * NO LEAKS, whatever the code under test does. These children trap SIGTERM on
 * purpose, so a kill that is broken (a mutation, a regression) would leave
 * them running after the suite. Three locks:
 *   - every child is a SCRIPT FILE under this run's scratch directory, so its
 *     command line names that directory and `markedPids` can find it by it;
 *   - every child exits by itself after `SELF_EXIT_MS`, even if this process is
 *     SIGKILLed and nothing else ever runs;
 *   - `reap` (in a finally) and `reapSync` (on 'exit', which suite-tmpdir's
 *     signal handlers also reach) SIGKILL every group and pid launched here —
 *     never through processTree.ts, the code under test.
 * Then the suite asserts no process carrying the scratch path is left.
 */
const SELF_EXIT_MS = 30_000
const PROC_DIR = join(tmpdir(), 'stall-procs')
const launchedGroups = new Set<number>()
const launchedPids = new Set<number>()
/*
 * Only a process whose command line names this run's scratch folder is
 * killed, never a remembered pid or group: a child that exited minutes ago may
 * have handed its number to somebody else's process.
 */
function reapSync(): void {
  let marked: number[] = []
  try {
    marked = markedPids()
  } catch {
    return
  }
  for (const p of marked) {
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}
process.on('exit', reapSync)
/** Every process whose command line names this run's process folder (a READ: `ps`). */
function markedPids(): number[] {
  if (process.platform === 'win32') return []
  const out = execFileSync('ps', ['-ww', '-A', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return out
    .split('\n')
    .filter((line) => line.includes(PROC_DIR))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => pid > 0 && pid !== process.pid)
}
async function reap(): Promise<number[]> {
  reapSync()
  for (let i = 0; i < 40 && markedPids().length; i++) await sleep(50)
  return markedPids()
}

if (process.platform === 'win32') {
  console.log('\nThe real pty kill: SKIP on Windows (no process groups; taskkill /T is not exercised here)')
} else {
  console.log('\nA real pty: a hung node child and a grandchild, both trapping SIGTERM')
  const { spawn } = await import('@lydell/node-pty')
  const { PtyManager } = await import('../src/main/pty.ts')
  const { mkdirSync, writeFileSync } = await import('node:fs')

  /*
   * The grandchild traps SIGTERM and SIGHUP and idles. The child traps both
   * too (`block`), starts the grandchild (not detached, so in its process
   * group), prints its pid, then blocks its own event loop: a hung `claude`.
   * `quick` keeps the default handlers, so SIGTERM ends it. Built from lines,
   * never a template with backticks inside (CLAUDE.md's standing trap).
   */
  mkdirSync(PROC_DIR, { recursive: true })
  const grandScript = join(PROC_DIR, 'stall-grandchild.cjs')
  const childScript = join(PROC_DIR, 'stall-child.cjs')
  writeFileSync(
    grandScript,
    [
      "process.on('SIGTERM', () => {})",
      "process.on('SIGHUP', () => {})",
      `setTimeout(() => process.exit(0), ${SELF_EXIT_MS})`
    ].join('\n')
  )
  writeFileSync(
    childScript,
    [
      "const { spawn } = require('node:child_process')",
      "const block = process.argv[2] === 'block'",
      "if (block) { process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}) }",
      `const g = spawn(process.execPath, [${JSON.stringify(grandScript)}], { stdio: 'ignore' })`,
      "process.stdout.write('GRANDCHILD=' + g.pid + '\\n')",
      'if (block) {',
      `  setTimeout(() => { const end = Date.now() + ${SELF_EXIT_MS}; while (Date.now() < end) {} process.exit(0) }, 200)`,
      '} else {',
      `  setTimeout(() => process.exit(0), ${SELF_EXIT_MS})`,
      '}'
    ].join('\n')
  )

  type Spawned = { pm: InstanceType<typeof PtyManager>; ptyId: string; pid: number; grand: number; exitedAt: () => number | null }
  async function launch(block: boolean, label: string): Promise<Spawned> {
    const env: Record<string, string> = {}
    for (const [k, val] of Object.entries(process.env)) if (val !== undefined) env[k] = val
    env.ELECTRON_RUN_AS_NODE = '1'
    const proc = spawn(process.execPath, [childScript, block ? 'block' : 'quick'], { cwd: PROC_DIR, env, cols: 80, rows: 24 })
    // Claimed for the reaper before anything can fail.
    launchedGroups.add(proc.pid)
    launchedPids.add(proc.pid)
    let out = ''
    let exitedAt: number | null = null
    let markExited: () => void = () => {}
    const exitedPromise = new Promise<void>((resolve) => {
      markExited = resolve
    })
    const session = {
      ptyId: `stall-${label}`,
      statusKey: '',
      proc,
      exited: false,
      exitedPromise,
      installFile: null,
      mirror: { dispose() {} }
    }
    proc.onData((d) => {
      out += d
    })
    proc.onExit(() => {
      session.exited = true
      exitedAt = Date.now()
      markExited()
    })
    const pm = new PtyManager(() => {}, () => {}, () => {})
    // The private map, by hand: only `kill`/`stop`'s bookkeeping is under test, never `start()`'s spawn.
    ;(pm as unknown as { sessions: Map<string, unknown> }).sessions.set(session.ptyId, session)
    for (let i = 0; i < 100 && !/GRANDCHILD=(\d+)/.test(out); i++) await sleep(50)
    const grand = Number(/GRANDCHILD=(\d+)/.exec(out)?.[1] ?? 0)
    if (grand > 0) launchedPids.add(grand)
    await sleep(400) // past the child's 200 ms, so its loop is blocked
    return { pm, ptyId: session.ptyId, pid: proc.pid, grand, exitedAt: () => exitedAt }
  }
  const pgidOf = (pid: number): number => {
    try {
      return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    } catch {
      return -1
    }
  }
  const inMap = (r: Spawned): boolean => (r.pm as unknown as { sessions: Map<string, unknown> }).sessions.has(r.ptyId)

  try {
    // The leak guard first, on a forced failure: a kill that never happens.
    const orphan = await launch(true, 'orphan')
    const seen = markedPids()
    check('leak guard: the scan finds live children by this run\'s scratch path', [seen.includes(orphan.pid), seen.includes(orphan.grand)], [true, true])
    check('leak guard: after a kill that did nothing, the reaper leaves no process with the scratch path', await reap(), [])

    // The control: an ordinary stop (SIGHUP to the pid) cannot move a hung child.
    const control = await launch(true, 'control')
    check('the rig: a grandchild started', control.grand > 0, true)
    check('the rig: the pty child leads its own process group (forkpty → setsid)', pgidOf(control.pid), control.pid)
    check('the rig: the grandchild is in that group', pgidOf(control.grand), control.pid)
    const plain = await control.pm.stop(control.ptyId, 2500)
    check('control: the ordinary stop does NOT end a hung child inside 2.5 s', [plain, alivePid(control.pid)], [false, true])
    check('control: and leaves the grandchild', alivePid(control.grand), true)
    check('control reaped', await reap(), [])

    // The forced stop through a real PtyManager.
    const hung = await launch(true, 'hung')
    const t0 = Date.now()
    const stopped = await hung.pm.stop(hung.ptyId, 6000, true)
    const took = Date.now() - t0
    check('forced stop: resolves true (exited, and the group is empty)', stopped, true)
    check('forced stop: the entry left the map at once (an explicit close, gotcha 84)', inMap(hung), false)
    check('forced stop: the hung child is gone', alivePid(hung.pid), false)
    check('forced stop: the grandchild that trapped SIGTERM is gone too', alivePid(hung.grand), false)
    check(`forced stop: it took the SIGKILL, after the ${FORCE_KILL_GRACE_MS} ms grace`, took >= FORCE_KILL_GRACE_MS - 50, true)
    console.log(`    (took ${took} ms)`)

    // A leader that dies on SIGTERM: the grandchild still must not outlive it.
    const quick = await launch(false, 'quick')
    const q0 = Date.now()
    const qStopped = await quick.pm.stop(quick.ptyId, 6000, true)
    const qExit = quick.exitedAt()
    check('a child that honours SIGTERM exits at once…', qExit !== null && qExit - q0 < FORCE_KILL_GRACE_MS, true)
    check('…and the stop still waits for its group: the trapping grandchild is gone', [qStopped, alivePid(quick.pid), alivePid(quick.grand)], [true, false, false])

    /*
     * A pid of 0, and an exited session, through the REAL PtyManager and the
     * real `process.kill`. kill(-0) is kill(0): the caller's own process group,
     * which in the app is Stoke. So it runs in a child started detached (its
     * own session and group), which refuses to go on unless it really does
     * lead its group: whatever a regression signals, only that child can get it.
     * An SSH tab's pty answers pid 0 once ssh has exited (sshFallback.ts); an
     * exited session's pid here is the child's own, standing in for a pid that
     * has since been handed to another program.
     */
    const isoScript = join(PROC_DIR, 'stall-isolated.mjs')
    writeFileSync(
      isoScript,
      [
        "import { execFileSync, spawn } from 'node:child_process'",
        'const mode = process.argv[2]',
        // A plain process to stand in for a program that now holds an exited pty's old pid.
        "if (mode === 'sleeper') { setTimeout(() => process.exit(0), 30000); await new Promise(() => {}) }",
        "const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())",
        "if (pgid !== process.pid) { process.stdout.write('NOT-A-GROUP-LEADER\\n'); process.exit(3) }",
        "if (mode === 'control') {",
        "  process.kill(-0, 'SIGTERM')",
        '  await new Promise((r) => setTimeout(r, 2000))',
        "  process.stdout.write('SURVIVED\\n')",
        '  process.exit(0)',
        '}',
        `const { PtyManager } = await import(${JSON.stringify(new URL('../src/main/pty.ts', import.meta.url).href)})`,
        'const pm = new PtyManager(() => {}, () => {}, () => {})',
        'let killed = 0',
        "const standIn = mode === 'exited' ? spawn(process.execPath, [process.argv[1], 'sleeper'], { stdio: 'ignore' }) : null",
        'if (standIn) await new Promise((r) => setTimeout(r, 300))',
        "const session = { ptyId: 'p', statusKey: '', exited: mode === 'exited', exitedPromise: Promise.resolve(), installFile: null, mirror: { dispose() {} },",
        "  proc: { pid: standIn ? standIn.pid : 0, kill() { killed++ } } }",
        "pm.sessions.set('p', session)",
        "const stopped = await pm.stop('p', 3000, true)",
        'await new Promise((r) => setTimeout(r, 300))',
        'let standInAlive = null',
        'if (standIn) { try { process.kill(standIn.pid, 0); standInAlive = true } catch { standInAlive = false } standIn.kill(\'SIGKILL\') }',
        "process.stdout.write('RESULT=' + JSON.stringify({ stopped, killed, inMap: pm.sessions.has('p'), standInAlive }) + '\\n')",
        'process.exit(0)'
      ].join('\n')
    )
    const { spawn: spawnChild } = await import('node:child_process')
    const isolated = (mode: string): Promise<{ code: number | null; signal: string | null; out: string }> =>
      new Promise((resolve) => {
        const c = spawnChild(process.execPath, [isoScript, mode], { cwd: PROC_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        if (c.pid) launchedPids.add(c.pid)
        let out = ''
        c.stdout?.on('data', (d) => (out += d))
        c.stderr?.on('data', (d) => (out += d))
        const stuck = setTimeout(() => c.kill('SIGKILL'), 20_000)
        c.on('exit', (code, signal) => {
          clearTimeout(stuck)
          resolve({ code, signal, out })
        })
      })
    const resultOf = (r: { out: string }): unknown => JSON.parse(/RESULT=(\{.*\})/.exec(r.out)?.[1] ?? 'null')
    const ctl = await isolated('control')
    check('isolation rig: a detached child leads its own group, and kill(-0) there ends only it', [ctl.signal, /NOT-A-GROUP-LEADER|SURVIVED/.test(ctl.out)], ['SIGTERM', false])
    const zero = await isolated('zero')
    check('a forced stop of a pty reporting pid 0 signals no process group, and still runs the pty\'s own kill', [zero.signal, zero.code, resultOf(zero)], [null, 0, { stopped: true, killed: 1, inMap: false, standInAlive: null }])
    const gone = await isolated('exited')
    check('a forced stop of an exited session leaves whoever holds its old pid now alone', [gone.signal, gone.code, resultOf(gone)], [null, 0, { stopped: true, killed: 0, inMap: false, standInAlive: true }])
  } finally {
    const left = await reap()
    check('no process carrying this run\'s scratch path survives the suite', left, [])
  }
}

/* ------------------------------------------------------------- the wire */

console.log('\nThe wire (gotcha 31)')
{
  const tv = read('src/renderer/src/components/TerminalView.tsx')
  const sinkAt = tv.indexOf('attachSink(tab.ptyId, (data) => {')
  check('TerminalView: start() before the history replays', tv.lastIndexOf('stall.start()', sinkAt) > 0 && tv.lastIndexOf('stall.start()', sinkAt) < sinkAt, true)
  check('TerminalView: every output chunk feeds it', /attachSink\(tab\.ptyId, \(data\) => \{\s*stall\.output\(data\)/.test(tv), true)
  check('TerminalView: every onData feeds it', /term\.onData\(\(data\) => \{[\s\S]{0,400}stall\.input\(data\)/.test(tv), true)
  check('TerminalView: stop() when the pty is detached', /detach\(\)\s*stall\.stop\(\)/.test(tv), true)
  check('TerminalView: exit() when the tab ends', /tab\.status === 'exited'\) stall\.exit\(\)/.test(tv), true)
  check('TerminalView: the probe is the colour-scheme report', /schemeProbe\(lightRef\.current\)/.test(tv), true)
  check('TerminalView: the overlay is drawn, given the restart', /<TerminalStallOverlay[\s\S]{0,200}onForceRestart=\{onForceRestart\}/.test(tv), true)

  const ov = read('src/renderer/src/components/TerminalStallOverlay.tsx')
  const buttons = ov.match(/<button[\s\S]*?>/g) ?? []
  check('overlay: four buttons, each keeping focus where it was on press', [buttons.length, buttons.every((b) => b.includes('onMouseDown={keep}'))], [4, true])
  check('overlay: a press on the card itself keeps focus too (not dropped to <body>)', /className="term-stall-card"[^>]*?onMouseDown=\{keep\}/.test(ov), true)
  check('overlay: every button is a .btn (border and background declared, gotcha 47)', buttons.every((b) => b.includes('className="btn"')), true)
  check('overlay: Enter and Space stop at the card (no type-through)', /e\.key === 'Enter' \|\| e\.key === ' '\) \{\s*e\.stopPropagation\(\)/.test(ov), true)
  check('overlay: the restart is claimed before it runs', /if \(this\.restarting\) return\s*this\.restarting = true/.test(ov), true)
  check('overlay: Force restart asks first (the confirm runs it, the first button only asks)', /data-stall-action="restart"[^>]*onClick=\{\(\) => setConfirming\(true\)\}/.test(ov) && /data-stall-action="confirm"[^>]*onClick=\{restart\}/.test(ov), true)
  check('overlay: the ping answer, even a rejection, is an answer', /window\.stoke\.pty\.ping\(\)\.then\(answered, answered\)/.test(ov), true)

  const app = read('src/renderer/src/App.tsx')
  check('App: the overlay\'s restart is forceRestartTab', /onForceRestart=\{forceRestartTab\}/.test(app), true)
  check('App: a local session comes back through relaunchTab, forced', /relaunchTab\(tab, \{ sessionId, fresh: false \}, \{ force: true \}\)/.test(app), true)
  check('App: relaunchTab carries force to main', /opts\.force\s*\?\s*window\.stoke\.pty\.stop\(oldPty, FORCE_STOP_CAP_MS, true\)/.test(app), true)
  check('App: every other tab is force-stopped, then Start again', /pty\.stop\(tab\.ptyId, FORCE_STOP_CAP_MS, true\)[\s\S]{0,120}restartTab\(\{ \.\.\.tab, status: 'exited' \}\)/.test(app), true)
  check('App: guarded before the await', /if \(forcingRef\.current\.has\(tab\.id\) \|\| relaunchingRef\.current\.has\(tab\.id\)\) return false\s*forcingRef\.current\.add\(tab\.id\)/.test(app), true)

  const pre = read('src/preload/index.ts')
  check('preload: stop carries force', /invoke\(CH\.ptyStop, ptyId, capMs, force === true\)/.test(pre), true)
  check('preload: ping', /ping: \(\) => ipcRenderer\.invoke\(CH\.ptyPing\)/.test(pre), true)
  const main = read('src/main/index.ts')
  check('main: the stop handler passes force on', /ptys\.stop\(ptyId, cap, force === true\)/.test(main), true)
  check('main: ping answers', /ipcMain\.handle\(CH\.ptyPing, \(\) => true\)/.test(main), true)
  const pty = read('src/main/pty.ts')
  check('pty.ts: the forced stop is the tree kill', /if \(force\) \{\s*const tree = this\.forceKill\(ptyId\)/.test(pty) && /killProcessTree\(\s*s\.proc\.pid/.test(pty), true)
  check('pty.ts: kill and forceKill share one bookkeeping', (pty.match(/this\.drop\(ptyId, s\)/g) ?? []).length, 2)

  const css = read('src/renderer/src/styles/app.css')
  const block = css.slice(css.indexOf('.term-stall {'), css.indexOf('.term-stall-actions {') + 200)
  check('css: the veil lets the pointer through, the card takes it', /\.term-stall \{[^}]*pointer-events: none/.test(block) && /\.term-stall-card \{[^}]*pointer-events: auto/.test(block), true)
  check('css: no hex colour in the stall rules', /#[0-9a-fA-F]{3,8}\b/.test(block), false)
  check('css: theme colour only (the veil mixes --surface)', /color-mix\(in srgb, var\(--surface\)/.test(block), true)
  check('css: under the strips and toasts', /\.term-stall \{[^}]*z-index: calc\(var\(--z-sticky\) - 3\)/.test(block), true)
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  *,'))
  check('css: reduced motion stills the spinner, never hides it (gotcha 72)', /\.spinner,[\s\S]{0,80}animation: none/.test(reduced) && !/\.term-stall[^{]*\{[^}]*(display: none|opacity: 0)/.test(css), true)
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exitCode = failures ? 1 : 0
