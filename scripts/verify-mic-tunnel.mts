/*
 * verify:mic-tunnel — lending this computer's microphone to Claude Code's
 * `/voice` on an SSH host (shared/micTunnel.ts, shared/micStandIn.ts,
 * main/micTunnel.ts).
 *
 * Node only, no window. What it holds:
 *  - the forward: `-o RemoteForward=/tmp/stoke-mic.<token>.sock <local>` only
 *    when lent, among the LOCAL options before the destination, a fresh token
 *    per connection, never a word of the remote command (gotcha 19), and read
 *    as an option (not the host) by `prepareSshRoute`'s own parser;
 *  - every gate rule and every stop rule, on a fake clock;
 *  - main's listener for real, behind a real socket, with a fake renderer: the
 *    token is checked first, and a refused connection gets no byte;
 *  - the stand-in `arecord` run for real under /bin/sh and dash against real
 *    Unix socket servers: --version, the probe, a non-socket, a stale socket,
 *    a link and a refusing socket skipped, the token sent first, bytes copied
 *    intact, SIGTERM ending it, python3 and perl, and the fallback to a real
 *    arecord;
 *  - the installer body run for real under sh and dash into a scratch HOME;
 *  - the AudioWorklet's conversion (48 kHz and 16 kHz in, 640-byte S16LE out);
 *  - who owns Space, hydrate's literal-true rule, and hub sync never carrying
 *    the consent.
 *
 * The suite moves TMPDIR to a scratch folder first (suite-tmpdir.mts); the
 * stand-in's sockets live in a fresh `/tmp/vmic-*` (short enough for
 * sun_path), removed at exit. The stand-in's fixed `/tmp/stoke-mic.` is
 * pointed there by an exact, counted substitution — every other byte is the
 * shipped text — and the shipped text itself runs against the real /tmp only
 * for the two answers that cannot depend on what is there.
 */
import './suite-tmpdir.mts'
import { SCRATCH_TMPDIR } from './suite-tmpdir.mts'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  MIC_END_GRACE_MS,
  MIC_FRAME_BYTES,
  MIC_GATE_IDLE,
  MIC_HOLD_FRESH_MS,
  MIC_ISOLATION_MS,
  MIC_MAX_STREAM_MS,
  MIC_TAP_WINDOW_MS,
  isMicForwardOption,
  isMicLocalEndpoint,
  isMicToken,
  micForwardOption,
  micGateAdmit,
  micGateEnded,
  micGateKey,
  micGatePane,
  micGateTick,
  micKeyOf,
  micOwnsSpace,
  micRemoteSocket,
  micSetupBody,
  micTokenLine,
  micTokenOf,
  parseMicSetup,
  type MicGateState,
  type MicKey,
  type MicPane
} from '../src/shared/micTunnel.ts'
import { MIC_STAND_IN, MIC_STAND_IN_MARKER } from '../src/shared/micStandIn.ts'
import { spaceOwner } from '../src/shared/voiceRoute.ts'
import { buildMicSetupArgs, buildSshArgs, sshHostArgs } from '../src/main/ssh.ts'
import { prepareSshRoute } from '../src/main/sshRoutes.ts'
import { MicTunnels, installMicStandIn, micSetupCommandBody, registerMicTunnelIpc } from '../src/main/micTunnel.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { applySyncedSettings, hostPayloadFor } from '../src/shared/hub/settings.ts'
import { idFromBytes } from '../src/shared/hub/codec.ts'
import type { SshHost } from '../src/shared/types.ts'
import { restartPlan } from '../src/renderer/src/lib/tabs.ts'
import { closedTabFor, toStored } from '../src/renderer/src/lib/restore.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

let failures = 0
let passes = 0
function check(name: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}\n        got:  ${a}\n        want: ${b}`)
  }
}
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const host = (extra: Partial<SshHost> = {}): SshHost => ({ id: 'host-1', label: 'VPS', alias: 'vps', command: 'byobu', ...extra })
const TOKEN = 'a'.repeat(16) + '0123456789abcdef'

/* ===================================================== names and the forward */

console.log('\nnames: the token, the far socket and the local endpoint')
{
  check('a token is 32 lowercase hex', [isMicToken(TOKEN), isMicToken(TOKEN.toUpperCase()), isMicToken(TOKEN.slice(1)), isMicToken(`${TOKEN}0`)], [true, false, false, false])
  check('the far socket is /tmp/stoke-mic.<token>.sock', micRemoteSocket(TOKEN), `/tmp/stoke-mic.${TOKEN}.sock`)
  check('no far socket for a bad token', micRemoteSocket('../x'), null)
  check('the token comes back out of the name', micTokenOf(`/tmp/stoke-mic.${TOKEN}.sock`), TOKEN)
  check('and nothing out of another name', [micTokenOf('/tmp/stoke-mic.zz.sock'), micTokenOf(`/var/stoke-mic.${TOKEN}.sock`)], [null, null])
  check('a local Unix path is one plain word', isMicLocalEndpoint('/var/folders/ab/T/stoke-mic-x1/m.sock'), true)
  check('127.0.0.1:<port> on Windows', [isMicLocalEndpoint('127.0.0.1:52011'), isMicLocalEndpoint('127.0.0.1:0'), isMicLocalEndpoint('0.0.0.0:5000'), isMicLocalEndpoint('localhost:5000')], [true, false, false, false])
  check('no space, colon, quote or relative part', [isMicLocalEndpoint('/a b/m.sock'), isMicLocalEndpoint('/a:b/m.sock'), isMicLocalEndpoint('/a/../m.sock'), isMicLocalEndpoint('a/m.sock'), isMicLocalEndpoint("/a'b")], [false, false, false, false, false])
  check('nothing past sun_path', isMicLocalEndpoint(`/${'x'.repeat(100)}`), false)
  const fwd = micForwardOption(TOKEN, '/tmp/x/m.sock')
  check('the -o value', fwd, `RemoteForward=/tmp/stoke-mic.${TOKEN}.sock /tmp/x/m.sock`)
  check('and it is the shape the argv accepts', isMicForwardOption(fwd), true)
  check('a forged value is not', [isMicForwardOption('RemoteForward=/etc/passwd /tmp/x'), isMicForwardOption(`RemoteForward=/tmp/stoke-mic.${TOKEN}.sock /tmp/x -oProxyCommand=evil`), isMicForwardOption(`LocalForward=/tmp/stoke-mic.${TOKEN}.sock /tmp/x`)], [false, false, false])
  check('the token line: exactly the token and a newline', micTokenLine(`${TOKEN}\n`), { done: true, token: TOKEN })
  check('a CR before the newline is fine', micTokenLine(`${TOKEN}\r\n`), { done: true, token: TOKEN })
  check('not done before the newline', micTokenLine(TOKEN.slice(0, 10)), { done: false })
  check('a wrong line is a refusal', micTokenLine('GET / HTTP/1.1\r\n'), { done: true, token: null })
  check('a long line without a newline is a refusal', micTokenLine('x'.repeat(200)), { done: true, token: null })
}

console.log('\nthe ssh argv: the forward is a local option, only when lent')
{
  const fwd = micForwardOption(TOKEN, '/tmp/x/m.sock')!
  const plain = buildSshArgs(host())
  const lent = buildSshArgs(host(), undefined, { micForward: fwd })
  check('not lent: no forward', plain.some((a) => a.includes('RemoteForward') || a.includes('stoke-mic')), false)
  const at = lent.indexOf(fwd)
  ok('lent: -o RemoteForward=… is there', at > 0 && lent[at - 1] === '-o', JSON.stringify(lent))
  ok('before the destination', at >= 0 && at < lent.indexOf('vps'), JSON.stringify(lent))
  check('the remote command is untouched (gotcha 19)', lent[lent.length - 1], 'byobu')
  check('nothing else moved', lent.filter((a) => a !== fwd && a !== '-o' ), plain.filter((a) => a !== '-o'))
  check('no -R and no ExitOnForwardFailure', lent.some((a) => a === '-R' || /ExitOnForwardFailure/i.test(a)), false)
  check('a value that is not the shape is left out', buildSshArgs(host(), undefined, { micForward: 'RemoteForward=/etc/x /tmp/y' }), plain)
  const kept = sshHostArgs(host({ persist: 'tmux' }), 'stoke-abcdef01', fwd)
  ok('a kept session carries it too', kept.ok && kept.args.includes(fwd))
  ok('and never inside the wrapped command', kept.ok && !kept.args[kept.args.length - 1].includes('stoke-mic'))
  const one = sshHostArgs(host(), null, fwd)
  ok('sshHostArgs passes it for a plain host', one.ok && one.args.includes(fwd))
  check('and not without it', sshHostArgs(host(), null).ok && (sshHostArgs(host(), null) as { args: string[] }).args.some((a) => a.includes('stoke-mic')), false)

  // prepareSshRoute finds the destination by skipping the options it knows
  // take a value. Run it for real with a stand-in "ssh" that logs what -G was
  // asked for: the forward must be skipped as -o's value, never read as the host.
  if (!isWin) {
    const work = mkdtempSync(join(SCRATCH_TMPDIR, 'route-'))
    const fake = join(work, 'ssh')
    const log = join(work, 'asked')
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nprintf 'hostname 203.0.113.7\\nport 22\\nuser root\\n'\n`)
    chmodSync(fake, 0o755)
    const routed = buildSshArgs(host({ preferredAddress: '127.0.0.1' }), undefined, { micForward: fwd })
    await prepareSshRoute(routed, fake, process.env).catch(() => null)
    const asked = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    check('prepareSshRoute asks ssh -G about the alias, not the forward', asked, ['-G', 'vps'])
  }
}

/* ============================================================ the gate */

console.log('\nthe gate: who may be streamed to')
const FRONT: MicPane = { front: true, focused: true, dictating: false }
function at(state: MicGateState, events: Array<[number, MicKey]>): MicGateState {
  let s = state
  for (const [t, k] of events) s = micGateKey(s, k, t).state
  return s
}
const READY = micGatePane(MIC_GATE_IDLE, FRONT).state
{
  check('nothing pressed: refused', micGateAdmit(READY, 1000, true).verdict, { ok: false, reason: 'no-press' })
  check('not in front: refused', micGateAdmit(micGatePane(READY, { ...FRONT, front: false }).state, 1000, true).verdict, { ok: false, reason: 'not-front' })
  check('terminal not focused: refused', micGateAdmit(micGatePane(READY, { ...FRONT, focused: false }).state, 1000, true).verdict, { ok: false, reason: 'not-focused' })
  check('window not focused (main’s own reading): refused', micGateAdmit(at(READY, [[1000, 'space-down']]), 1100, false).verdict, { ok: false, reason: 'not-focused' })
  check('Stoke’s dictation on there: refused', micGateAdmit(micGatePane(at(READY, [[1000, 'space-down']]), { ...FRONT, dictating: true }).state, 1100, true).verdict, { ok: false, reason: 'dictating' })

  // HOLD: typed, then held Space (not isolated): hold-to-talk.
  const typedThenHeld = at(READY, [[900, 'other'], [1000, 'space-down'], [1500, 'space-repeat'], [1583, 'space-repeat']])
  check('held (2 repeats, fresh): admitted as a hold', micGateAdmit(typedThenHeld, 1650, true).verdict, { ok: true, mode: 'held' })
  check('one repeat is not a hold yet', micGateAdmit(at(READY, [[900, 'other'], [1000, 'space-down'], [1500, 'space-repeat']]), 1550, true).verdict, { ok: false, reason: 'not-asked' })
  check(`a hold whose last repeat is older than ${MIC_HOLD_FRESH_MS} ms (a lost keyup) is not`, micGateAdmit(typedThenHeld, 1583 + MIC_HOLD_FRESH_MS + 1, true).verdict, { ok: false, reason: 'not-asked' })
  check('a released hold is not', micGateAdmit(at(typedThenHeld, [[1600, 'space-up']]), 1650, true).verdict, { ok: false, reason: 'not-asked' })
  check('repeats with no press of ours start nothing', micGateAdmit(at(READY, [[900, 'other'], [1500, 'space-repeat'], [1583, 'space-repeat']]), 1600, true).verdict, { ok: false, reason: 'no-press' })

  // TAP: an isolated Space.
  const tapped = at(READY, [[1000, 'other'], [1000 + MIC_ISOLATION_MS, 'space-down'], [1000 + MIC_ISOLATION_MS + 90, 'space-up']])
  const tapAt = 1000 + MIC_ISOLATION_MS
  check('an isolated tap: admitted as a tap', micGateAdmit(tapped, tapAt + 400, true).verdict, { ok: true, mode: 'tap' })
  check(`at the window's last moment (${MIC_TAP_WINDOW_MS} ms) still`, micGateAdmit(tapped, tapAt + MIC_TAP_WINDOW_MS, true).verdict, { ok: true, mode: 'tap' })
  check('past it: refused', micGateAdmit(tapped, tapAt + MIC_TAP_WINDOW_MS + 1, true).verdict, { ok: false, reason: 'not-asked' })
  check(`a Space typed ${MIC_ISOLATION_MS - 1} ms after another key is typing: refused`, micGateAdmit(at(READY, [[1000, 'other'], [1000 + MIC_ISOLATION_MS - 1, 'space-down'], [1100 + MIC_ISOLATION_MS, 'space-up']]), 1300 + MIC_ISOLATION_MS, true).verdict, { ok: false, reason: 'not-asked' })
  check('a key typed after the tap, before the connection: refused', micGateAdmit(at(tapped, [[tapAt + 200, 'other']]), tapAt + 300, true).verdict, { ok: false, reason: 'no-press' })
  check('a tap with nothing before it ever is isolated', micGateAdmit(at(READY, [[50, 'space-down']]), 300, true).verdict, { ok: true, mode: 'tap' })
  check('an isolated HOLD is read as a tap (ended by the next Space, never on release)', micGateAdmit(at(READY, [[1000, 'space-down'], [1500, 'space-repeat'], [1583, 'space-repeat']]), 1600, true).verdict, { ok: true, mode: 'tap' })

  // A typed sentence: every Space follows a letter within ~200 ms.
  let typing = READY
  let t = 10_000
  let admitted = 0
  for (const ch of 'the quick brown fox jumps over the lazy dog') {
    typing = micGateKey(typing, ch === ' ' ? 'space-down' : 'other', t).state
    if (ch === ' ') typing = micGateKey(typing, 'space-up', t + 60).state
    for (const lag of [50, 300, 1000]) if (micGateAdmit(typing, t + lag, true).verdict.ok) admitted++
    t += 180
  }
  check('a looping far process gets nothing while a sentence is typed', admitted, 0)

  // One connection per press.
  const first = micGateAdmit(tapped, tapAt + 300, true)
  check('the press is used by its admission: busy while it streams', micGateAdmit(first.state, tapAt + 400, true).verdict, { ok: false, reason: 'busy' })
  check('and used after it ended', micGateAdmit(micGateEnded(first.state), tapAt + 500, true).verdict, { ok: false, reason: 'used' })
  const endTap = at(first.state, [[tapAt + 3000, 'space-down'], [tapAt + 3080, 'space-up']])
  check('a Space pressed during a stream (the ending tap) never admits the next', micGateAdmit(micGateEnded(endTap), tapAt + 3300, true).verdict, { ok: false, reason: 'used' })
  check('a fresh isolated tap after it does', micGateAdmit(at(micGateEnded(endTap), [[tapAt + 6000, 'space-down']]), tapAt + 6200, true).verdict, { ok: true, mode: 'tap' })
  check('a tab switch forgets a press', micGateAdmit(micGatePane(micGatePane(at(READY, [[1000, 'space-down']]), { ...FRONT, front: false }).state, FRONT).state, 1200, true).verdict, { ok: false, reason: 'no-press' })
}

console.log('\nthe gate: what stops a stream')
{
  const tapAt = 5000
  const streaming = micGateAdmit(at(READY, [[tapAt, 'space-down'], [tapAt + 80, 'space-up']]), tapAt + 300, true).state
  check('any other key: stop now', micGateKey(streaming, 'other', tapAt + 900).stop, 'key')
  check('a Space repeat or release in tap mode: nothing', [micGateKey(streaming, 'space-up', tapAt + 900).stop, micGateTick(micGateKey(streaming, 'space-up', tapAt + 900).state, tapAt + 9000)], [null, null])
  check('tab switch: stop', micGatePane(streaming, { ...FRONT, front: false }).stop, 'tab')
  check('focus lost: stop', micGatePane(streaming, { ...FRONT, focused: false }).stop, 'blur')
  check('Stoke’s dictation armed there: stop', micGatePane(streaming, { ...FRONT, dictating: true }).stop, 'dictating')
  check('the same pane again: nothing', micGatePane(streaming, FRONT).stop, null)
  check(`the cap: ${MIC_MAX_STREAM_MS / 1000} s`, [micGateTick(streaming, tapAt + 300 + MIC_MAX_STREAM_MS - 1), micGateTick(streaming, tapAt + 300 + MIC_MAX_STREAM_MS)], [null, 'cap'])
  const ending = micGateKey(streaming, 'space-down', tapAt + 4000).state
  check(`tap mode: the next Space ends it ${MIC_END_GRACE_MS} ms later`, [micGateTick(ending, tapAt + 4000 + MIC_END_GRACE_MS - 1), micGateTick(ending, tapAt + 4000 + MIC_END_GRACE_MS)], [null, 'ended'])
  const held = micGateAdmit(at(READY, [[900, 'other'], [1000, 'space-down'], [1500, 'space-repeat'], [1583, 'space-repeat']]), 1600, true).state
  const released = micGateKey(held, 'space-up', 3000).state
  check(`hold mode: the release ends it ${MIC_END_GRACE_MS} ms later`, [micGateTick(released, 3000 + MIC_END_GRACE_MS - 1), micGateTick(released, 3000 + MIC_END_GRACE_MS)], [null, 'ended'])
  check('a stream ended is idle again', micGateEnded(released).stream, null)
}

console.log('\nkeys in: what the renderer reports')
{
  const k = (e: Partial<Parameters<typeof micKeyOf>[0]>) =>
    micKeyOf({ type: 'keydown', code: 'KeyA', key: 'a', repeat: false, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, ...e })
  check('a letter is other', k({}), 'other')
  check('Space down, repeat, up', [k({ code: 'Space', key: ' ' }), k({ code: 'Space', key: ' ', repeat: true }), k({ type: 'keyup', code: 'Space', key: ' ' })], ['space-down', 'space-repeat', 'space-up'])
  check('Shift+Space is a space', k({ code: 'Space', key: ' ' }), 'space-down')
  check('Ctrl/Alt/Cmd+Space is a chord: other', [k({ code: 'Space', ctrlKey: true }), k({ code: 'Space', altKey: true }), k({ code: 'Space', metaKey: true })], ['other', 'other', 'other'])
  check('bare modifiers are never sent', [k({ code: 'ShiftLeft', key: 'Shift' }), k({ code: 'MetaRight', key: 'Meta' }), k({ code: 'ControlLeft', key: 'Control' }), k({ code: 'CapsLock', key: 'CapsLock' })], [null, null, null, null])
  check('an untrusted event is never sent', k({ isTrusted: false, code: 'Space' }), null)
  check('a keyup of another key is not sent', k({ type: 'keyup' }), null)
  check('an IME composition is other', k({ code: 'Space', keyCode: 229 }), 'other')
}

/* ============================================ main's listener, for real */

console.log('\nmain’s listener: a real socket, a fake renderer')
{
  const sent: Array<{ owner: number; event: Record<string, Record<string, string>> }> = []
  const logs: string[] = []
  let focused = true
  let clock = 1_000_000
  const tunnels = new MicTunnels({
    send: (owner, event) => sent.push({ owner, event: event as unknown as Record<string, Record<string, string>> }),
    windowFocused: () => focused,
    now: () => clock,
    log: (l) => logs.push(l),
    tmpRoot: SCRATCH_TMPDIR,
    tickMs: 15
  })
  const lease = await tunnels.prepare('host-1')
  ok('the lease is the shape the argv accepts', isMicForwardOption(lease.forward), lease.forward)
  const m = /^RemoteForward=(\S+) (\S+)$/.exec(lease.forward)!
  const token = micTokenOf(m[1])!
  const local = m[2]
  ok('with a token', isMicToken(token))
  if (!isWin) {
    const dirMode = statSync(dirname(local)).mode & 0o777
    const sockMode = lstatSync(local).mode & 0o777
    check('the local socket is in a private folder (0700) and is 0600', [dirMode.toString(8), sockMode.toString(8)], ['700', '600'])
  } else {
    ok('Windows: 127.0.0.1:<port>', /^127\.0\.0\.1:\d+$/.test(local))
  }
  const lease2 = await tunnels.prepare('host-1')
  ok('a second connection gets another token and endpoint', lease2.forward !== lease.forward && !lease2.forward.includes(token))
  lease2.release()

  const connect = (): Socket => (local.startsWith('/') ? createConnection(local) : createConnection({ host: '127.0.0.1', port: Number(local.split(':')[1]) }))
  /** Connect, send `line`, and collect what comes back until the far end closes. */
  const talk = (line: string | null, waitMs = 600): Promise<{ bytes: Buffer; closed: boolean; ms: number }> =>
    new Promise((resolve) => {
      const sock = connect()
      const chunks: Buffer[] = []
      const t0 = Date.now()
      let closed = false
      sock.on('data', (c) => chunks.push(c))
      sock.on('error', () => {})
      sock.on('close', () => {
        closed = true
        resolve({ bytes: Buffer.concat(chunks), closed, ms: Date.now() - t0 })
      })
      sock.on('connect', () => {
        if (line !== null) sock.write(line)
      })
      setTimeout(() => {
        if (!closed) resolve({ bytes: Buffer.concat(chunks), closed: false, ms: Date.now() - t0 })
      }, waitMs)
    })

  // Before the pty exists.
  const early = await talk(`${token}\n`)
  check('before the tab runs: closed, no byte', [early.closed, early.bytes.length], [true, 0])
  lease.attach('pty-1')
  tunnels.pane(7, 'pty-1', FRONT)

  const opens = (): number => sent.filter((s) => 'open' in s.event).length
  const wrong = await talk(`${'b'.repeat(32)}\n`)
  check('a wrong token: closed at once, no byte, no microphone opened', [wrong.closed, wrong.bytes.length, opens()], [true, 0, 0])
  ok('and logged without the token', logs.some((l) => /wrong or missing token/.test(l)) && !logs.some((l) => l.includes(token)))
  const junk = await talk(`GET / HTTP/1.1\r\nHost: x\r\n\r\n`)
  check('a stranger’s protocol: closed, no byte', [junk.closed, junk.bytes.length, opens()], [true, 0, 0])
  const none = await talk(`${token}\n`)
  check('the right token with nobody pressing Space: closed, no byte, no microphone', [none.closed, none.bytes.length, opens()], [true, 0, 0])

  // A hold: typed, then Space held.
  tunnels.key(7, 'pty-1', 'other')
  clock += 100
  tunnels.key(7, 'pty-1', 'space-down')
  clock += 500
  tunnels.key(7, 'pty-1', 'space-repeat')
  clock += 83
  tunnels.key(7, 'pty-1', 'space-repeat')
  tunnels.key(8, 'pty-1', 'other') // another window's report: not heard
  clock += 40
  /*
   * A wrong token WHILE the press would admit: refused, no byte, and the press
   * is not used up by it (the token is checked before the gate is asked).
   */
  const wrongNow = await talk(`${'c'.repeat(32)}\n`)
  check('a wrong token while Space is held: closed, no byte, no microphone', [wrongNow.closed, wrongNow.bytes.length, opens()], [true, 0, 0])
  const held = talk(`${token}\n`, 1500)
  await sleep(150)
  const open = sent.find((s) => 'open' in s.event)?.event.open
  ok('admitted: the owner’s renderer is asked to open the microphone', !!open && sent.find((s) => 'open' in s.event)?.owner === 7, JSON.stringify(sent))
  check('for this pty and host, as a hold', [open?.ptyId, open?.hostId, open?.mode], ['pty-1', 'host-1', 'held'])
  const streamId = open?.streamId ?? ''
  const frame = (seed: number): Buffer => Buffer.from(Array.from({ length: MIC_FRAME_BYTES }, (_, i) => (i * 7 + seed) & 0xff))
  // As an ArrayBuffer (what Electron's IPC hands main), a Uint8Array and a Buffer.
  const f1 = frame(1)
  tunnels.frame(7, streamId, f1.buffer.slice(f1.byteOffset, f1.byteOffset + MIC_FRAME_BYTES))
  tunnels.frame(7, streamId, new Uint8Array(frame(2)))
  tunnels.frame(8, streamId, frame(9)) // not the owner
  tunnels.frame(7, 'not-this-stream', frame(9))
  tunnels.frame(7, streamId, frame(3))
  const busy = await talk(`${token}\n`)
  check('a second connection while one streams: closed, no byte', [busy.closed, busy.bytes.length], [true, 0])
  await sleep(50)
  tunnels.key(7, 'pty-1', 'other')
  const heldRes = await held
  check('the owner’s frames arrived intact, in order, and nothing else', heldRes.bytes.equals(Buffer.concat([frame(1), frame(2), frame(3)])), true)
  check('another key ended it: the socket closed', heldRes.closed, true)
  const closeEv = (): Record<string, string> | undefined => [...sent].reverse().find((s) => 'close' in s.event)?.event.close
  check('and the renderer was told why', [closeEv()?.streamId === streamId, closeEv()?.reason], [true, 'key'])

  // A tap, ended by the far side closing (claude's SIGTERM).
  clock += MIC_ISOLATION_MS + 10
  tunnels.key(7, 'pty-1', 'space-down')
  tunnels.key(7, 'pty-1', 'space-up')
  clock += 300
  {
    const sock = connect()
    sock.on('error', () => {})
    await new Promise((r) => sock.on('connect', r))
    sock.write(`${token}\n`)
    await sleep(120)
    const tapOpen = [...sent].reverse().find((s) => 'open' in s.event)?.event.open
    check('a tap is admitted as a tap', tapOpen?.mode, 'tap')
    sock.destroy()
    await sleep(120)
    check('the far side closing ends it', closeEv()?.reason, 'closed')
  }

  // Stop on the strip.
  clock += MIC_ISOLATION_MS + 10
  tunnels.key(7, 'pty-1', 'space-down')
  clock += 200
  {
    const r = talk(`${token}\n`, 1200)
    await sleep(120)
    const sid = [...sent].reverse().find((s) => 'open' in s.event)?.event.open.streamId ?? ''
    tunnels.stop(8, sid, 'stop') // another window cannot stop it
    await sleep(40)
    ok('Stop from another window is not heard', tunnels.streaming('pty-1') !== null)
    tunnels.stop(7, sid, 'stop')
    const res = await r
    check('Stop from the tab’s own window: closed', [res.closed, closeEv()?.reason], [true, 'stop'])
  }

  // The window loses focus (main's own reading), checked by the ticker.
  clock += MIC_ISOLATION_MS + 10
  tunnels.key(7, 'pty-1', 'space-down')
  clock += 200
  {
    const r = talk(`${token}\n`, 1200)
    await sleep(100)
    focused = false
    const res = await r
    check('the window losing focus ends it', [res.closed, closeEv()?.reason], [true, 'blur'])
    focused = true
  }

  // The cap.
  clock += MIC_ISOLATION_MS + 10
  tunnels.key(7, 'pty-1', 'space-down')
  clock += 200
  {
    const r = talk(`${token}\n`, 1200)
    await sleep(100)
    clock += MIC_MAX_STREAM_MS
    const res = await r
    check('two minutes is the cap', [res.closed, closeEv()?.reason], [true, 'cap'])
  }

  // The tab switching away while streaming.
  clock += MIC_ISOLATION_MS + 10
  tunnels.key(7, 'pty-1', 'space-down')
  clock += 200
  {
    const r = talk(`${token}\n`, 1200)
    await sleep(100)
    tunnels.pane(8, 'pty-1', { front: false, focused: false, dictating: false }) // a window it left: not heard
    await sleep(30)
    ok('a window the tab left is not heard', tunnels.streaming('pty-1') !== null)
    tunnels.pane(7, 'pty-1', { front: false, focused: false, dictating: false })
    const res = await r
    check('the tab leaving the front ends it', [res.closed, closeEv()?.reason], [true, 'tab'])
    tunnels.pane(7, 'pty-1', FRONT)
  }

  /*
   * The tab moved to another window while it streamed, and the new window's
   * "in front" landed before the old one's "not in front" (which is then not
   * heard). The microphone is open in the OLD window: the stream must end and
   * the OLD window be told, not the new one, which never opened anything.
   */
  clock += MIC_ISOLATION_MS + 10
  tunnels.key(7, 'pty-1', 'space-down')
  clock += 200
  {
    const r = talk(`${token}\n`, 1200)
    await sleep(100)
    const sid = [...sent].reverse().find((s) => 'open' in s.event)?.event.open.streamId ?? ''
    ok('streaming in window 7 before the move', sid !== '' && tunnels.streaming('pty-1')?.streamId === sid)
    tunnels.pane(9, 'pty-1', FRONT)
    const res = await r
    const last = [...sent].reverse().find((s) => 'close' in s.event)
    check('a tab moved to another window mid-stream: ended, and the window that opened the microphone is told', [res.closed, last?.owner, last?.event.close.streamId === sid, last?.event.close.reason], [true, 7, true, 'tab'])
    tunnels.pane(7, 'pty-1', FRONT)
  }

  // No token at all: closed once the wait is over.
  {
    const r = await talk(null, 4500)
    check('a connection that never sends its token is closed (3 s)', [r.closed, r.bytes.length, r.ms >= 2500], [true, 0, true])
  }

  // The pty goes: the listener and its folder go with it.
  clock += MIC_ISOLATION_MS + 10
  tunnels.key(7, 'pty-1', 'space-down')
  clock += 200
  {
    const r = talk(`${token}\n`, 1500)
    await sleep(100)
    await tunnels.release('pty-1')
    const res = await r
    check('the tab closing ends a stream', [res.closed, closeEv()?.reason], [true, 'tab-closed'])
    if (!isWin) check('and removes its private folder', existsSync(dirname(local)), false)
    const after = await talk(`${token}\n`, 400)
    check('nothing listens there any more', after.bytes.length, 0)
  }
  const lease3 = await tunnels.prepare('host-1')
  const dir3 = dirname(/ (\S+)$/.exec(lease3.forward)![1])
  lease3.release()
  await sleep(50)
  if (!isWin) check('a launch that failed before the pty: its folder goes too', existsSync(dir3), false)
  await tunnels.closeAll()

  // The IPC: every argument checked.
  const handlers = new Map<string, (e: { sender: { id: number } }, ...a: unknown[]) => void>()
  const calls: string[] = []
  const fake = {
    key: (o: number, p: string, k: string) => calls.push(`key ${o} ${p} ${k}`),
    pane: (o: number, p: string, pane: MicPane) => calls.push(`pane ${o} ${p} ${JSON.stringify(pane)}`),
    frame: (o: number, s: string) => calls.push(`frame ${o} ${s}`),
    stop: (o: number, s: string, r: string) => calls.push(`stop ${o} ${s} ${r}`)
  } as unknown as MicTunnels
  registerMicTunnelIpc({ on: (ch, fn) => handlers.set(ch, fn) }, fake, { key: 'k', pane: 'p', frame: 'f', stop: 's' })
  const e = { sender: { id: 3 } }
  handlers.get('k')!(e, 'pty', 'space-down')
  handlers.get('k')!(e, 'pty', 'rm -rf')
  handlers.get('k')!(e, 42, 'other')
  handlers.get('p')!(e, 'pty', { front: 'yes', focused: true, dictating: 1 })
  handlers.get('p')!(e, 'pty', null)
  handlers.get('f')!(e, 7, new ArrayBuffer(4))
  handlers.get('s')!(e, 'sid', 'anything')
  check('the IPC takes only what it names, by the sender’s id', calls, [
    'key 3 pty space-down',
    'pane 3 pty {"front":false,"focused":true,"dictating":false}',
    'stop 3 sid stop'
  ])
}

/* ========================================== the stand-in, run for real */

const SH_SHELLS = isWin ? [] : ['/bin/sh', '/bin/dash'].filter((s) => existsSync(s))
if (isWin) console.log('\nthe stand-in: SKIP on Windows (it runs on Linux servers; there is no /bin/sh here)')
else {
  console.log(`\nthe stand-in arecord, run for real (${SH_SHELLS.join(', ')})`)
  ok('/bin/sh is here to run it', SH_SHELLS.includes('/bin/sh'))
  if (process.platform === 'linux') ok('dash is here on Linux too', SH_SHELLS.includes('/bin/dash'))
  check('it is POSIX sh with the marker', [MIC_STAND_IN.startsWith('#!/bin/sh\n'), MIC_STAND_IN.includes(MIC_STAND_IN_MARKER)], [true, true])
  for (const sh of SH_SHELLS) {
    const r = spawnSync(sh, ['-n', '-c', MIC_STAND_IN], { encoding: 'utf8' })
    check(`${sh} parses it`, [r.status, r.stderr], [0, ''])
  }

  const which = (name: string): string | null => {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
    return r.status === 0 && r.stdout.trim().startsWith('/') ? r.stdout.trim() : null
  }
  /*
   * The interpreters' REAL binaries, not whatever is first on PATH: a pyenv or
   * asdf shim is a bash script that needs its own PATH, which the stand-in's
   * scratch PATH does not have.
   */
  const realExe = (name: string, code: string[]): string | null => {
    const p = which(name)
    if (!p) return null
    const r = spawnSync(p, code, { encoding: 'utf8' })
    const exe = r.status === 0 ? r.stdout.trim() : ''
    return exe.startsWith('/') && existsSync(exe) ? exe : null
  }
  const tools = {
    ls: which('ls'),
    grep: which('grep'),
    python3: realExe('python3', ['-c', 'import sys; print(sys.executable)']),
    perl: realExe('perl', ['-e', 'print $^X'])
  }
  console.log(`  NOTE  python3 ${tools.python3 ?? 'not here'}, perl ${tools.perl ?? 'not here'}`)
  ok('ls and grep found', !!tools.ls && !!tools.grep)
  const work = mkdtempSync(join(SCRATCH_TMPDIR, 'standin-'))
  const toolDir = (name: string, with_: Array<keyof typeof tools>): string => {
    const d = join(work, `tools-${name}`)
    mkdirSync(d, { recursive: true })
    for (const t of with_) if (tools[t]) symlinkSync(tools[t]!, join(d, t))
    return d
  }
  const TOOLS_PY = toolDir('py', ['ls', 'grep', 'python3'])
  const TOOLS_PL = toolDir('pl', ['ls', 'grep', 'perl'])
  const TOOLS_NONE = toolDir('none', ['ls', 'grep'])

  // A short, private folder for the sockets (sun_path is 104 bytes on macOS).
  const sockDir = mkdtempSync('/tmp/vmic-')
  // suite-tmpdir.mts turns SIGINT/TERM/HUP into exits, so this runs then too.
  process.on('exit', () => rmSync(sockDir, { recursive: true, force: true }))
  const placed = MIC_STAND_IN.split('/tmp/stoke-mic.')
  check('the stand-in names /tmp/stoke-mic. in exactly three places (the substitution below is exact)', placed.length - 1, 3)
  const script = placed.join(`${sockDir}/stoke-mic.`)
  const binA = join(work, 'binA')
  const binB = join(work, 'binB')
  const binReal = join(work, 'binReal')
  for (const d of [binA, binB, binReal]) mkdirSync(d)
  writeFileSync(join(binA, 'arecord'), script, { mode: 0o755 })
  writeFileSync(join(binB, 'arecord'), script, { mode: 0o755 })
  writeFileSync(join(binReal, 'arecord'), '#!/bin/sh\necho "REAL $*"\n', { mode: 0o755 })
  const shipped = join(work, 'shipped-arecord')
  writeFileSync(shipped, MIC_STAND_IN, { mode: 0o755 })

  const REC = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q', '-']
  const PROBE = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '/dev/null']
  interface Run {
    code: number | null
    signal: NodeJS.Signals | null
    out: Buffer
    err: string
    ms: number
  }
  const run = (sh: string, file: string, args: string[], path: string, opts: { killAfterBytes?: number; timeoutMs?: number } = {}): Promise<Run> =>
    new Promise((resolve) => {
      const t0 = Date.now()
      const child = spawn(sh, [file, ...args], { env: { PATH: path, HOME: work, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      let n = 0
      let err = ''
      let killed = false
      child.stdout.on('data', (c: Buffer) => {
        out.push(c)
        n += c.length
        if (opts.killAfterBytes && n >= opts.killAfterBytes && !killed) {
          killed = true
          child.kill('SIGTERM')
        }
      })
      child.stderr.on('data', (c: Buffer) => (err += c.toString()))
      let done = false
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ code, signal, out: Buffer.concat(out), err, ms: Date.now() - t0 })
      }
      /*
       * A hard deadline that does not wait for stdio to close: a connector the
       * shell failed to `exec` outlives a killed shell and holds the pipe, and
       * waiting for 'close' would hang the suite (gotcha 161's rule). Reads as
       * a failure: no exit code.
       */
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        setTimeout(() => finish(null, 'SIGKILL'), 300)
      }, opts.timeoutMs ?? 8000)
      child.on('close', (code, signal) => finish(code, signal))
    })

  interface Far {
    server: Server
    path: string
    conns: number
    tokens: string[]
    closedAt: number | null
    close(): Promise<void>
  }
  const PAYLOAD = Buffer.from(Array.from({ length: 64 * 1024 + 17 }, (_, i) => (i * 31 + (i >> 8)) & 0xff))
  /** A far socket as sshd would offer it, behaving as the Stoke behind it would. */
  const far = (token: string, behave: 'stream' | 'refuse' | 'slow'): Promise<Far> =>
    new Promise((resolve) => {
      const path = `${sockDir}/stoke-mic.${token}.sock`
      const open = new Set<Socket>()
      const f: Far = {
        server: createServer(),
        path,
        conns: 0,
        tokens: [],
        closedAt: null,
        // Every connection is ended first: a connector left running (a shell
        // that did not exec it) would otherwise hold close() open forever.
        close: () =>
          new Promise((r) => {
            for (const s of open) s.destroy()
            f.server.close(() => r())
          })
      }
      f.server.on('connection', (sock) => {
        open.add(sock)
        sock.on('close', () => open.delete(sock))
        f.conns++
        sock.on('error', () => {})
        let buf = ''
        let timer: ReturnType<typeof setInterval> | null = null
        sock.on('close', () => {
          f.closedAt = Date.now()
          if (timer) clearInterval(timer)
        })
        // Like main's own wait: no token in 2 s and the far side hangs up.
        const wait = setTimeout(() => sock.destroy(), 2000)
        const onData = (c: Buffer): void => {
          buf += c.toString('latin1')
          const nl = buf.indexOf('\n')
          if (nl < 0) return
          clearTimeout(wait)
          sock.off('data', onData)
          f.tokens.push(buf.slice(0, nl + 1))
          if (behave === 'refuse') return void sock.destroy()
          if (behave === 'stream') return void sock.end(PAYLOAD)
          timer = setInterval(() => sock.write(Buffer.alloc(MIC_FRAME_BYTES, 0x5a)), 20)
        }
        sock.on('data', onData)
      })
      f.server.listen(path, () => resolve(f))
    })
  const tok = (n: number): string => n.toString(16).padStart(32, '0')
  const touch = (path: string, ageS: number): void => {
    const t = Date.now() / 1000 - ageS
    utimesSync(path, t, t)
  }
  /** A socket file nobody listens on: bound by a process that exited without unlinking it. */
  const stale = (token: string): string => {
    const path = `${sockDir}/stoke-mic.${token}.sock`
    if (tools.python3) execFileSync(tools.python3, ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(path)})`])
    else if (tools.perl) execFileSync(tools.perl, ['-MSocket', '-e', `socket(my $s, PF_UNIX, SOCK_STREAM, 0); bind($s, pack_sockaddr_un(${JSON.stringify(path)}))`])
    return path
  }
  const clean = (): void => {
    for (const name of readdirSync(sockDir)) rmSync(join(sockDir, name), { force: true, recursive: true })
  }

  // The shipped text against the real /tmp: the two answers that cannot depend on what is there.
  for (const sh of SH_SHELLS) {
    const v = await run(sh, shipped, ['--version'], TOOLS_PY)
    check(`${sh}: --version prints a line and exits 0 (shipped text)`, [v.code, /^arecord: Stoke microphone stand-in/.test(v.out.toString())], [0, true])
    const p = await run(sh, shipped, PROBE, TOOLS_PY)
    check(`${sh}: the probe exits 0 at once with no real arecord (shipped text)`, [p.code, p.ms < 1500], [0, true])
  }

  for (const sh of SH_SHELLS) {
    const connectors: Array<[string, string]> = []
    if (tools.python3) connectors.push(['python3', TOOLS_PY])
    if (tools.perl) connectors.push(['perl', TOOLS_PL])
    ok(`${sh}: python3 or perl here to connect`, connectors.length > 0)
    for (const [name, tdir] of connectors) {
      const PATH = `${binA}:${tdir}`
      const label = `${sh} + ${name}`
      clean()
      /*
       * Newest first (ls -t, which follows a link to its target's time): a
       * LINK to a socket outside the pattern (a trap: it would stream a
       * different payload), a refusing socket, a non-socket, a stale socket,
       * then the good one.
       */
      const good = await far(tok(1), 'stream')
      touch(good.path, 50)
      const st = stale(tok(2))
      touch(st, 40)
      writeFileSync(`${sockDir}/stoke-mic.${tok(3)}.sock`, 'not a socket')
      touch(`${sockDir}/stoke-mic.${tok(3)}.sock`, 30)
      const trap = await new Promise<Far>((resolve) => {
        const f: Far = { server: createServer(), path: `${sockDir}/trap.sock`, conns: 0, tokens: [], closedAt: null, close: () => new Promise((r) => f.server.close(() => r())) }
        f.server.on('connection', (sock) => {
          f.conns++
          sock.on('error', () => {})
          sock.end(Buffer.alloc(1000, 0x21))
        })
        f.server.listen(f.path, () => resolve(f))
      })
      touch(trap.path, 5)
      symlinkSync(trap.path, `${sockDir}/stoke-mic.${tok(4)}.sock`)
      const refusing = await far(tok(5), 'refuse')
      touch(refusing.path, 10)
      writeFileSync(`${sockDir}/stoke-mic.notatoken.sock`, '')
      const r = await run(sh, join(binA, 'arecord'), REC, PATH)
      check(`${label}: recording exits 0 with the good socket's bytes, intact`, [r.code, r.out.length, r.out.equals(PAYLOAD)], [0, PAYLOAD.length, true])
      check(`${label}: a link named like a Stoke socket (newest) was never followed`, trap.conns, 0)
      check(`${label}: the refusing socket was tried next, with its own token`, refusing.tokens, [`${tok(5)}\n`])
      check(`${label}: the token is the first thing the good socket got`, good.tokens, [`${tok(1)}\n`])
      check(`${label}: the non-socket and the stale one were skipped (one connection to the good one)`, good.conns, 1)
      await good.close()
      await refusing.close()
      await trap.close()

      // The probe with a socket there: exit 0, and never connects.
      clean()
      const there = await far(tok(6), 'stream')
      const p = await run(sh, join(binA, 'arecord'), PROBE, PATH)
      check(`${label}: the probe with a socket there exits 0 and connects to nothing`, [p.code, there.conns], [0, 0])

      // SIGTERM from claude ends it, and the far side sees the close.
      await there.close()
      clean()
      const slow = await far(tok(7), 'slow')
      const s = await run(sh, join(binA, 'arecord'), REC, PATH, { killAfterBytes: 4 * MIC_FRAME_BYTES })
      await sleep(100)
      ok(`${label}: SIGTERM ends it (no recorder left behind)`, s.signal === 'SIGTERM' || s.code === 143 || s.code === 0, `code ${s.code} signal ${s.signal}`)
      ok(`${label}: and the socket closed with it`, slow.closedAt !== null && s.ms < 5000)
      ok(`${label}: the frames it copied were the far side's`, s.out.length >= 4 * MIC_FRAME_BYTES && s.out.every((b) => b === 0x5a))
      await slow.close()

      // Every socket refusing: no recorder, so exit 1 with one line.
      clean()
      const no = await far(tok(8), 'refuse')
      const nr = await run(sh, join(binA, 'arecord'), REC, PATH)
      check(`${label}: every socket refusing and no real arecord: exit 1, nothing on stdout`, [nr.code, nr.out.length, /no Stoke microphone answered/.test(nr.err)], [1, 0, true])
      // Claude shows that stderr: one sentence, its apostrophe whole, and no interpreter warning (perl's "Wide character in print").
      check(`${label}: and it is the one sentence, nothing else`, [nr.err.trim().split('\n').length, /Wide character|\\u|\\x/.test(nr.err), nr.err.includes('computer\u2019s microphone')], [1, false, true])
      // ...and with a real arecord after it on PATH, that one records instead.
      const nf = await run(sh, join(binA, 'arecord'), REC, `${binA}:${binB}:${binReal}:${tdir}`)
      check(`${label}: with a real arecord on PATH (past a second stand-in), it records instead`, [nf.code, nf.out.toString().trim()], [0, `REAL ${REC.join(' ')}`])
      /*
       * The "real" arecord it hands over to is itself a wrapper that runs
       * `arecord` by name, which PATH resolves to the stand-in again: every
       * hop is an `exec`, so without a guard that is one process looping
       * forever at full CPU. It must stop at once, and say why.
       */
      const binWrap = join(work, 'binWrap')
      mkdirSync(binWrap, { recursive: true })
      writeFileSync(join(binWrap, 'arecord'), '#!/bin/sh\nexec arecord "$@"\n', { mode: 0o755 })
      const loops = async (what: string, args: string[]): Promise<void> => {
        const loop = await run(sh, join(binA, 'arecord'), args, `${binA}:${binWrap}:${tdir}`, { timeoutMs: 4000 })
        check(`${label}: a wrapper that runs arecord by name again (${what}): stops at once and says why, never loops`, [loop.code, loop.ms < 3000, /reached again/.test(loop.err)], [1, true, true])
      }
      // Recording past a refusing socket (the connector's own hand-over), and any other use.
      await loops('recording, every socket refusing', REC)
      await loops('any other use', ['-l'])
      await no.close()
      // The probe hands over only with no socket there at all.
      clean()
      await loops('the probe, no socket', PROBE)
    }

    // No connector at all.
    clean()
    const f = await far(tok(9), 'stream')
    const nc = await run(sh, join(binA, 'arecord'), REC, `${binA}:${TOOLS_NONE}`)
    check(`${sh}: neither python3 nor perl: exit 1, says so, connects to nothing`, [nc.code, /needs python3 or perl/.test(nc.err), f.conns], [1, true, 0])
    await f.close()

    // Nothing there at all.
    clean()
    const empty = await run(sh, join(binA, 'arecord'), REC, `${binA}:${TOOLS_PY}`)
    check(`${sh}: no socket and no real arecord: exit 1 with one line`, [empty.code, empty.out.length, /no Stoke microphone is connected/.test(empty.err)], [1, 0, true])
    const toReal = await run(sh, join(binA, 'arecord'), REC, `${binA}:${binReal}:${TOOLS_PY}`)
    check(`${sh}: no socket: the real arecord records`, toReal.out.toString().trim(), `REAL ${REC.join(' ')}`)
    const probeReal = await run(sh, join(binA, 'arecord'), PROBE, `${binA}:${binReal}:${TOOLS_PY}`)
    check(`${sh}: no socket: the real arecord answers the probe`, probeReal.out.toString().trim(), `REAL ${PROBE.join(' ')}`)
    const other = await run(sh, join(binA, 'arecord'), ['-f', 'cd', 'out.wav'], `${binA}:${binReal}:${TOOLS_PY}`)
    check(`${sh}: anything else goes to the real arecord`, other.out.toString().trim(), 'REAL -f cd out.wav')
    const f2 = await far(tok(10), 'stream')
    const wrongRate = await run(sh, join(binA, 'arecord'), ['-f', 'S16_LE', '-r', '44100', '-c', '1', '-t', 'raw', '-'], `${binA}:${TOOLS_PY}`)
    check(`${sh}: a format the tunnel does not carry: refused, never streamed`, [wrongRate.code, f2.conns, /only records what Claude Code asks for/.test(wrongRate.err)], [1, 0, true])
    await f2.close()
  }
  if (process.getuid && process.getuid() !== 0) {
    console.log('  NOTE  a socket owned by ANOTHER user (the -O check, and the connector’s st_uid check) cannot be made without root here: unproven by this suite')
  }
  /*
   * The python connector's owner check, the shipped text unmodified, run with
   * os.geteuid answering another uid: to it, our own socket is then someone
   * else's. It must not connect at all (a planted socket could feed this
   * claude prompts). The control is the same run with the real uid. The sh
   * -O check and perl's $> cannot be faked without root.
   */
  if (tools.python3 && process.getuid) {
    const code = /exec python3 -c '([^']*)'/.exec(MIC_STAND_IN)?.[1] ?? null
    ok('the python connector is one single-quoted word of the stand-in', code !== null && code.includes('st.st_uid != uid'))
    if (code) {
      const asUid = async (uid: number): Promise<{ code: number | null; out: number; conns: number; tokens: number }> => {
        clean()
        const f = await far(tok(21), 'stream')
        const wrapper = `import os, sys\nos.geteuid = lambda: ${uid}\nexec(compile(sys.argv.pop(1), "connector", "exec"))`
        const r = await new Promise<{ code: number | null; out: number }>((resolve) => {
          const c = spawn(tools.python3!, ['-c', wrapper, code, '', '0', f.path], { stdio: ['ignore', 'pipe', 'pipe'] })
          let out = 0
          c.stdout.on('data', (d: Buffer) => (out += d.length))
          const t = setTimeout(() => c.kill('SIGKILL'), 5000)
          c.on('close', (codeOut) => {
            clearTimeout(t)
            resolve({ code: codeOut, out })
          })
        })
        await f.close()
        return { ...r, conns: f.conns, tokens: f.tokens.length }
      }
      const me = process.getuid()
      check('python connector, the socket is ours: connects, sends the token, copies the audio', await asUid(me), { code: 0, out: PAYLOAD.length, conns: 1, tokens: 1 })
      check('python connector, the socket is another user’s: never connects, exit 1, nothing out', await asUid(me + 1), { code: 1, out: 0, conns: 0, tokens: 0 })
    }
  }
  clean()

  /* ------------------------------------------------- the installer body */

  console.log('\nthe installer body, run for real into a scratch HOME')
  const body = micSetupCommandBody()
  check('it holds no single quote (it is wrapped in sh -c \'…\')', body.includes("'"), false)
  check('a base64 that is not plain is refused', micSetupBody('abc def; rm -rf ~'), null)
  for (const sh of SH_SHELLS) {
    const home = mkdtempSync(join(SCRATCH_TMPDIR, 'home-'))
    writeFileSync(join(home, '.profile'), 'PATH="$HOME/.local/bin:$PATH"; export PATH\n')
    const env = { HOME: home, SHELL: sh, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }
    const r = spawnSync(sh, ['-c', body], { env, encoding: 'utf8' })
    const f = join(home, '.local', 'bin', 'arecord')
    check(`${sh}: installs and exits 0`, r.status, 0)
    check(`${sh}: the file is the stand-in, byte for byte, 0755`, [existsSync(f) && readFileSync(f, 'utf8') === MIC_STAND_IN, existsSync(f) ? (statSync(f).mode & 0o777).toString(8) : null], [true, '755'])
    check(`${sh}: no .part left`, existsSync(`${f}.part`), false)
    const rep = parseMicSetup(r.stdout)
    check(`${sh}: it says where, and that a login shell finds it`, [rep.installed, rep.loginFinds], [f, f])
    check(`${sh}: and, with nothing to fix, no sentence for the setup tab`, r.stdout.split('\n').filter((l) => l.startsWith('Stoke: ')), [])
    ok(`${sh}: and how it connects`, rep.connector === 'python3' || rep.connector === 'perl', r.stdout)
    const again = spawnSync(sh, ['-c', body], { env, encoding: 'utf8' })
    check(`${sh}: running it again replaces its own copy`, again.status, 0)
    writeFileSync(f, '#!/bin/sh\necho mine\n')
    const theirs = spawnSync(sh, ['-c', body], { env, encoding: 'utf8' })
    check(`${sh}: an arecord that is not Stoke’s is left alone (exit 4)`, [theirs.status, readFileSync(f, 'utf8')], [4, '#!/bin/sh\necho mine\n'])
    rmSync(f)
    rmSync(join(home, '.profile'))
    const noPath = spawnSync(sh, ['-c', body], { env, encoding: 'utf8' })
    const rep2 = parseMicSetup(noPath.stdout)
    ok(`${sh}: with ~/.local/bin off a login shell's PATH, it says so`, noPath.status === 0 && rep2.loginFinds !== f && rep2.notes.some((n) => /PATH/.test(n)) && !rep2.ready, noPath.stdout)
    // The setup TAB shows this output as it is, so the finding is in words there too.
    ok(`${sh}: and says it in words for the setup tab`, noPath.stdout.split('\n').some((l) => l.startsWith('Stoke: a login shell on this machine finds no arecord, not ') && l.includes('~/.local/bin first on PATH')), noPath.stdout)
    /*
     * An rc file that prints (a greeting, fortune, neofetch) and a login shell
     * that finds no arecord: the last line out of that shell is the rc file's,
     * not a path. It must read as "finds none", never as "finds arecord at
     * Welcome to the server".
     */
    writeFileSync(join(home, '.profile'), 'echo "Welcome to the server"\n')
    const chatty = parseMicSetup(spawnSync(sh, ['-c', body], { env, encoding: 'utf8' }).stdout)
    check(`${sh}: an rc file's greeting is never read as where arecord is`, [chatty.loginFinds, chatty.notes.some((n) => /Welcome/.test(n)), chatty.notes.some((n) => /does not find arecord/.test(n))], [null, false, true])
    writeFileSync(join(home, '.profile'), 'echo "/etc/motd: Welcome"\n')
    const chattyPath = parseMicSetup(spawnSync(sh, ['-c', body], { env, encoding: 'utf8' }).stdout)
    check(`${sh}: nor an rc line that starts with /`, chattyPath.loginFinds, null)
    writeFileSync(join(home, '.profile'), 'echo "Welcome to the server"\nPATH="$HOME/.local/bin:$PATH"; export PATH\necho "/etc/motd says hi"\n')
    const chattyFound = parseMicSetup(spawnSync(sh, ['-c', body], { env, encoding: 'utf8' }).stdout)
    check(`${sh}: and with it on PATH, an rc line starting with / before the answer does not hide it`, [chattyFound.loginFinds, chattyFound.ready || chattyFound.connector === null], [f, true])
  }
}

console.log('\nreading what the installer printed')
{
  const rep = parseMicSetup('Welcome to Ubuntu\nSTOKE_MIC installed /root/.local/bin/arecord\nSTOKE_MIC login /root/.local/bin/arecord\nSTOKE_MIC connect python3\n')
  check('a good install is ready', [rep.installed, rep.loginFinds, rep.connector, rep.ready], ['/root/.local/bin/arecord', '/root/.local/bin/arecord', 'python3', true])
  const shadowed = parseMicSetup('STOKE_MIC installed /root/.local/bin/arecord\nSTOKE_MIC login /usr/bin/arecord\nSTOKE_MIC connect perl\n')
  ok('a real arecord ahead of it on PATH is named', !shadowed.ready && shadowed.notes[0].includes('/usr/bin/arecord'))
  const nothing = parseMicSetup('STOKE_MIC installed /root/.local/bin/arecord\nSTOKE_MIC login none\nSTOKE_MIC connect none\n')
  ok('no PATH and no connector: both said', !nothing.ready && nothing.notes.some((n) => /PATH/.test(n)) && nothing.notes.some((n) => /python3 nor perl/.test(n)))
  check('only STOKE_MIC lines are read', parseMicSetup('installed /x\nSTOKE_MIC installed relative/x\n').installed, null)
  check('a login answer that is not a path (an older far side, an alias) is "finds none"', parseMicSetup('STOKE_MIC installed /root/.local/bin/arecord\nSTOKE_MIC login Welcome to Ubuntu\nSTOKE_MIC connect python3\n').loginFinds, null)
}

console.log('\nthe setup argv: a file copy, never a session')
{
  const body = micSetupCommandBody()
  const batch = buildMicSetupArgs(host(), body, 'batch')!
  const tab = buildMicSetupArgs(host(), body, 'tab')!
  const before = (args: string[], what: string): boolean => args.indexOf(what) >= 0 && args.indexOf(what) < args.indexOf('vps')
  ok('batch: BatchMode, -T, RemoteCommand=none, ClearAllForwardings=yes, all before the alias', ['BatchMode=yes', '-T', 'RemoteCommand=none', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ForwardAgent=no', '-x'].every((o) => before(batch, o)))
  ok('tab: one password prompt, no BatchMode', before(tab, 'NumberOfPasswordPrompts=1') && !tab.includes('BatchMode=yes'))
  ok('both end in sh -c \'<body>\'', batch[batch.length - 1] === `sh -c '${body}'` && tab[tab.length - 1] === `sh -c '${body}'`)
  check('the host’s own command is not run', [batch.includes('byobu'), tab.includes('byobu')], [false, false])
  check('an alias that reads as an option, or a body with a quote: refused', [buildMicSetupArgs(host({ alias: '-oProxyCommand=x' }), body, 'batch'), buildMicSetupArgs(host(), "echo 'x'", 'tab')], [null, null])
  const said = async (code: number | null, stdout: string, stderr: string, killed = false) =>
    installMicStandIn(host(), async () => ({ code, stdout, stderr, killed }))
  check('a password host asks for the tab', await said(255, '', 'root@203.0.113.7: Permission denied (publickey,password).\r\n'), { ok: false, needsLogin: true, message: 'That machine wants a password.' })
  check('a timeout says so', await said(null, '', '', true), { ok: false, needsLogin: false, message: 'The machine did not answer in time.' })
  check('the far side’s own sentence is kept', ((await said(4, 'Stoke: /root/.local/bin/arecord is there and is not from Stoke, so it was left alone.\n', '')) as { message: string }).message, 'Stoke: /root/.local/bin/arecord is there and is not from Stoke, so it was left alone.')
  const good = await said(0, 'STOKE_MIC installed /root/.local/bin/arecord\nSTOKE_MIC login /root/.local/bin/arecord\nSTOKE_MIC connect python3\n', '')
  check('a good run is a report', good.ok && good.report.ready, true)
}

/* =============================================== the worklet's conversion */

console.log('\nthe AudioWorklet: Float32 in, 20 ms of 16 kHz S16LE out')
{
  const code = readFileSync(join(ROOT, 'src/renderer/src/lib/micWorklet.js'), 'utf8')
  const load = (rate: number): { proc: { process(i: Float32Array[][]): boolean }; posted: ArrayBuffer[] } => {
    const posted: ArrayBuffer[] = []
    let Cls: (new () => { process(i: Float32Array[][]): boolean }) | null = null
    class AudioWorkletProcessor {
      port = { postMessage: (b: ArrayBuffer) => posted.push(b) }
    }
    vm.runInNewContext(code, {
      AudioWorkletProcessor,
      sampleRate: rate,
      registerProcessor: (name: string, c: typeof Cls) => {
        if (name === 'stoke-mic-frames') Cls = c
      },
      DataView,
      ArrayBuffer
    })
    return { proc: new Cls!(), posted }
  }
  const q16 = load(16000)
  const known = new Float32Array(128)
  known.set([0, 0.5, -0.5, 1, -1, 2, -2])
  for (let i = 0; i < 5; i++) q16.proc.process([[known]])
  check('16 kHz: 640 samples make two 640-byte frames', q16.posted.map((b) => b.byteLength), [MIC_FRAME_BYTES, MIC_FRAME_BYTES])
  const v = new DataView(q16.posted[0])
  check('little-endian, -1 → -32768, +1 → 32767, clamped', [0, 1, 2, 3, 4, 5, 6].map((i) => v.getInt16(i * 2, true)), [0, 16383, -16384, 32767, -32768, 32767, -32768])
  const q48 = load(48000)
  for (let k = 0; k < 375; k++) {
    const ch = new Float32Array(128)
    for (let i = 0; i < 128; i++) ch[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * (k * 128 + i)) / 48000)
    q48.proc.process([[ch]])
  }
  check('48 kHz in: one second is fifty 20 ms frames', [q48.posted.length, q48.posted.every((b) => b.byteLength === MIC_FRAME_BYTES)], [50, true])
  const pcm = q48.posted.flatMap((b) => Array.from({ length: b.byteLength / 2 }, (_, i) => new DataView(b).getInt16(i * 2, true)))
  let crossings = 0
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) crossings++
  ok('and a 1 kHz tone is still 1 kHz at 16 kHz (about 2000 zero crossings a second)', Math.abs(crossings - 2000) <= 20, `${crossings}`)
  ok('at about its level', Math.max(...pcm) > 14000 && Math.max(...pcm) < 16500, `${Math.max(...pcm)}`)
  const q0 = load(16000)
  check('no input: nothing posted, the node lives on', [q0.proc.process([[]]), q0.posted.length], [true, 0])
  /*
   * Vite inlines an asset under 4 KB as a `data:` URL, and the renderer's CSP (`script-src 'self'`)
   * refuses a data: worklet module: the built app fell back to the ScriptProcessor (measured
   * 2026-10-28, "Unable to load a worklet's module"). `?url&no-inline` keeps it a file.
   */
  const hookText = readFileSync(join(ROOT, 'src/renderer/src/components/MicTunnel.tsx'), 'utf8')
  ok('the worklet is imported as a file, never inlined as a data: URL the CSP refuses', /from '\.\.\/lib\/micWorklet\.js\?url&no-inline'/.test(hookText))
  const csp = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8')
  ok('and the CSP that refuses one still says script-src \'self\' only', /script-src 'self';/.test(csp) && !/script-src[^;]*(data:|blob:)/.test(csp))
}

/* ============================================ Space, settings and sync */

console.log('\nwho owns Space on a lending tab (gotcha 79)')
{
  check('an SSH tab that lends the microphone: the far claude’s /voice', spaceOwner({ cliId: 'claude', hostId: 'host-1' }, false, true), 'cli')
  check('the same tab not lending: Stoke’s dictation, as before', spaceOwner({ cliId: 'claude', hostId: 'host-1' }, true, false), 'stoke')
  check('a local tab is not moved by the third argument', [spaceOwner({ cliId: 'claude', hostId: null }, false, true), spaceOwner({ cliId: 'claude', hostId: null }, true, true)], ['stoke', 'cli'])
  check('a remote (hub) tab stays Stoke’s', spaceOwner({ cliId: 'claude', hostId: null, kind: 'remote' }, true, true), 'stoke')
  const said = micOwnsSpace('VPS')
  ok('⇧⌘D’s sentence names the host, /voice tap and the way back', said.includes('VPS') && said.includes('/voice tap') && said.includes('Lend this computer’s microphone'))
}

console.log('\nthe setting: hydrate and hub sync')
{
  const hosts = hydrateSettings({
    hosts: [
      { id: 'host-1', label: 'A', alias: 'a', command: '', micTunnel: true },
      { id: 'host-2', label: 'B', alias: 'b', command: '', micTunnel: 'yes' },
      { id: 'host-3', label: 'C', alias: 'c', command: '' }
    ]
  }).hosts
  check('only the literal true lends the microphone', hosts.map((h) => h.micTunnel), [true, false, false])
  const payload = hostPayloadFor({ id: 'host-1', label: 'A', alias: 'a', command: '', micTunnel: true } as SshHost)
  check('the hub payload never carries it', 'micTunnel' in payload.host, false)
  const syncA = idFromBytes('host', new Uint8Array(10).fill(41))
  const syncB = idFromBytes('host', new Uint8Array(10).fill(42))
  const current = hydrateSettings({ hosts: [{ id: 'host-1', label: 'A', alias: 'a', command: '', micTunnel: true, syncId: syncA }] })
  const forged = { ...hostPayloadFor({ id: 'x', label: 'A2', alias: 'a', command: '' } as SshHost) }
  ;(forged.host as Record<string, unknown>).micTunnel = false
  const forgedNew = { ...hostPayloadFor({ id: 'y', label: 'New', alias: 'n', command: '' } as SshHost) }
  ;(forgedNew.host as Record<string, unknown>).micTunnel = true
  const next = hydrateSettings(applySyncedSettings(current, { hosts: { [syncA]: forged, [syncB]: forgedNew } }).raw)
  check('an incoming edit keeps this machine’s consent', next.hosts.find((h) => h.alias === 'a')?.micTunnel, true)
  check('a host synced in arrives NOT lending, whatever the payload says', next.hosts.find((h) => h.alias === 'n')?.micTunnel, false)
  const moved = hydrateSettings(applySyncedSettings(current, { hosts: { [syncA]: hostPayloadFor({ id: 'x', label: 'A', alias: 'elsewhere', command: '' } as SshHost) } }).raw)
  check('a host whose alias moved to another server loses the consent', moved.hosts[0]?.micTunnel, false)
}

console.log('\nthe "Set up microphone on …" tab')
{
  const tab = { kind: 'session', cwd: 'vps', hostId: 'host-1', enrollHostId: 'host-1', micSetup: true }
  check('Try again runs the same setup, never a key install', restartPlan(tab, ['host-1']), { kind: 'mic-setup', hostId: 'host-1' })
  check('an "Add key" tab is still an enrollment', restartPlan({ ...tab, micSetup: undefined }, ['host-1']), { kind: 'enroll', hostId: 'host-1' })
  check('a host gone from Settings: nothing to set up', restartPlan(tab, []).kind, 'impossible')
  const full = { ...tab, id: 't1', ptyId: 'p1', sessionId: '', cliId: 'claude', projectName: 'VPS', title: 'Set up microphone on VPS', permissionMode: 'default', model: '', effort: 'default', ultracode: false, status: 'running', exitCode: null, selectedPath: null, expandedPath: null }
  check('never kept for an undo close', closedTabFor(full as never), null)
  const stored = toStored([full as never], 't1', {}, () => '') as { tabs?: unknown[] } | null
  check('never saved for restore', stored?.tabs?.length ?? 0, 0)
}

console.log('\nthe wire (source text)')
{
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
  const term = read('src/renderer/src/components/TerminalView.tsx')
  const micTsx = read('src/renderer/src/components/MicTunnel.tsx')
  const index = read('src/main/index.ts')
  const pty = read('src/main/pty.ts')
  const hostsUi = read('src/renderer/src/components/HostsSettings.tsx')
  const settingsIndex = read('src/shared/settingsIndex.ts')
  ok('TerminalView runs the hook for a lending SSH tab', /useMicTunnel\(\{/.test(term) && /host\?\.micTunnel === true/.test(term))
  ok('and ⇧⌘D asks spaceOwner with the lent flag first', /spaceOwner\(tab, false, micLentRef\.current\) === 'cli'/.test(term))
  const onKeyBody = /const onKey = \(e: KeyboardEvent\): void => \{([\s\S]*?)\n {4}\}/.exec(micTsx)?.[1] ?? null
  ok('the hook only observes keys: its key listener reports micKeyOf and takes nothing from the terminal', onKeyBody !== null && /micKeyOf\(e\)/.test(onKeyBody) && !/preventDefault|stopPropagation|stopImmediatePropagation|return false/.test(onKeyBody), onKeyBody ?? '(no onKey listener found)')
  ok('nothing else in the hook cancels a key: no preventDefault, and the one stopPropagation is the strip’s own (gotcha 145)', !/preventDefault/.test(micTsx) && (micTsx.match(/stopPropagation\(\)/g) ?? []).length === 1 && /onKeyDown=\{\(e\) => \{[\s\S]{0,120}e\.stopPropagation\(\)/.test(micTsx))
  // One record of what main was told, so neither of the two pane reporters can leave main on a state the other moved off.
  ok('every pane report goes through the one sendPane', (micTsx.match(/micTunnel\.pane\(/g) ?? []).length === 1 && /const sendPane = /.test(micTsx))
  ok('the microphone opens only on main’s open, through openMicrophone', /micTunnel\.onOpen\(/.test(micTsx) && /openMicrophone\(/.test(micTsx))
  ok('main mints a lease from SETTINGS’ host, passes its forward, attaches, releases', /settings\.hosts\.find\(\(h\) => h\.id === opts\.host!\.id\)\?\.micTunnel === true/.test(index) && /micLease\?\.forward \?\? null/.test(index) && /micLease\?\.attach\(started\.ptyId\)/.test(index) && /micLease\?\.release\(\)/.test(index))
  ok('a pty’s exit releases its listener', /void micTunnels\?\.release\(ptyId\)/.test(index))
  ok('pty.ts hands the forward to sshHostArgs', /sshHostArgs\(opts\.host!, opts\.remoteSession, micForward\)/.test(pty))
  ok('the Settings row is marked and indexed (gotcha 138)', /data-setting="hosts\.mic"/.test(hostsUi) && /id: 'hosts\.mic'/.test(settingsIndex))
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'} (${passes} passed)`)
process.exitCode = failures ? 1 : 0
