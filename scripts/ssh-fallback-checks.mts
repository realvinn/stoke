import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setImmediate as turn } from 'node:timers/promises'
import { spawn, type IPty } from '@lydell/node-pty'
import { SshFallbackScan, passwordFallbackArgs, resolvePasswordFallback, spawnSshPty } from '../src/main/sshFallback.ts'
import { sshChildEnv, sshExecutable } from '../src/main/ssh.ts'
import { PtyExitTracker } from '../src/main/ptyExitTracker.ts'
import { releaseExitedPtyTransports } from '../src/main/ptyTransportCleanup.ts'
import { conptyScrub } from '../src/shared/sshAuth.ts'

const failure = 'Received disconnect from 127.0.0.1 port 2222:2: Too many authentication failures\r\nDisconnected from 127.0.0.1 port 2222\r\n'
const config = 'batchmode no\npubkeyauthentication true\npasswordauthentication yes\nkbdinteractiveauthentication yes\nnumberofpasswordprompts 3\npreferredauthentications publickey,keyboard-interactive,password\n'
const env = sshChildEnv()

export async function runSshFallbackChecks(): Promise<void> {
  let checks = 0
  const check = (name: string, actual: unknown, expected: unknown): void => {
    assert.deepEqual(actual, expected, name)
    console.log(`  PASS  ${name}`); checks++
  }
  console.log('\nSSH password fallback: config, authentication boundaries and PTY ownership')
  for (let split = 0; split <= failure.length; split++) {
    const scan = new SshFallbackScan(false)
    scan.output(failure.slice(0, split)); scan.output(failure.slice(split))
    assert.equal(scan.retry(255), true, `key failure split ${split}`)
  }
  check('a real OpenSSH MaxAuthTries diagnostic survives every chunk boundary', true, true)
  const authenticated = 'Authenticated to box ([127.0.0.1]:2222) using "publickey".\r\n' + failure
  for (let split = 0; split <= authenticated.length; split++) {
    const scan = new SshFallbackScan(false)
    scan.output(authenticated.slice(0, split)); scan.output(authenticated.slice(split))
    assert.equal(scan.retry(255), false, `authentication boundary split ${split}`)
  }
  check('a split success marker always prevents replay, even beside a forged failure', true, true)
  for (const [name, prelude] of [
    ['authenticated public-key command', 'Authenticated to box ([127.0.0.1]:2222) using "publickey".\r\n'],
    ['older authentication-success wording', 'debug1: Authentication succeeded (publickey).\r\n'],
    ['partial success / MFA', 'Authenticated using "publickey" with partial success.\r\n'],
    ['multiplexed remote command', 'mux_client_request_session: master session id: 1\r\n'],
    ['a password prompt already reached', "user@box's password: "],
    ['an interactive terminal program', '\u001b[?1049h'],
    ['authentication output over the scan budget', 'x'.repeat(16 * 1024 + 1)]
  ]) {
    const scan = new SshFallbackScan(false); scan.output(prelude); scan.output(failure)
    check(`${name} cannot replay a command`, scan.retry(255), false)
  }
  for (const [name, data] of [['password or command input', 'secret\r'], ['OTP input', '1'], ['Ctrl+C cancellation', '\u0003']] as const) {
    const scan = new SshFallbackScan(false); scan.input(data); scan.output(failure)
    check(`${name} permanently prevents a retry`, scan.retry(255), false)
  }
  const reports = new SshFallbackScan(false); reports.input('\u001b[1;1R'); reports.output(failure)
  check('a terminal cursor report is not credential input', reports.retry(255), true)
  for (const diagnostic of ['Permission denied (publickey).\r\n', 'Host key verification failed.\r\n', 'Connection timed out\r\n', 'Connection reset by peer\r\n', 'Could not resolve hostname box\r\n']) {
    const scan = new SshFallbackScan(false); scan.output(diagnostic)
    check(`ordinary SSH failure remains final: ${diagnostic.trim()}`, scan.retry(255), false)
  }
  const badExit = new SshFallbackScan(false); badExit.output(failure)
  check('a remote command exit code or killed child is not an auth retry', [badExit.retry(1), badExit.retry(255, 1), badExit.retry(0)], [false, false, false])
  const conpty = new SshFallbackScan(true); conpty.output('\u001b[?9001h\u001b[?1004h\u001b[2J\u001b[H' + failure)
  check('ConPTY startup paint does not hide the real key failure', conpty.retry(255), true)
  const conptySuccess = new SshFallbackScan(true); conptySuccess.output('\u001b[HAuthenticated to box ([127.0.0.1]:2222) using "publickey".\u001b[2;1H' + failure)
  check('ConPTY cursor moves cannot hide an authenticated connection', conptySuccess.retry(255), false)

  const args = ['-e', 'none', '-t', 'fixture', 'run --the-original-command']
  check('fallback preserves the complete destination/command and method preference order', passwordFallbackArgs(config, args), ['-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password', ...args])
  for (const [name, changed] of [
    ['batch mode', config.replace('batchmode no', 'batchmode yes')],
    ['public-key-only preference', config.replace('publickey,keyboard-interactive,password', 'publickey')],
    ['password and keyboard-interactive disabled', config.replace('passwordauthentication yes', 'passwordauthentication no').replace('kbdinteractiveauthentication yes', 'kbdinteractiveauthentication no')],
    ['no password prompts', config.replace('numberofpasswordprompts 3', 'numberofpasswordprompts 0')],
    ['malformed prompt limit', config.replace('numberofpasswordprompts 3', 'numberofpasswordprompts invalid')],
    ['a jump host', config + 'proxyjump bastion\n'],
    ['an arbitrary proxy', config + 'proxycommand exec something\n'],
    ['a multiplexed connection', config + 'controlpath /tmp/existing-master\n'],
    ['missing effective options', ''],
    ['public-key authentication disabled', config.replace('pubkeyauthentication true', 'pubkeyauthentication no')]
  ]) check(`respects ${name}`, passwordFallbackArgs(changed, args), null)
  check('OpenSSH false also disables public-key fallback', passwordFallbackArgs(config.replace('pubkeyauthentication true', 'pubkeyauthentication false'), args), null)
  check('password-only permission does not enable keyboard-interactive', passwordFallbackArgs(config.replace('kbdinteractiveauthentication yes', 'kbdinteractiveauthentication no'), args)?.[3], 'PreferredAuthentications=password')
  check('keyboard-interactive-only permission does not enable password', passwordFallbackArgs(config.replace('passwordauthentication yes', 'passwordauthentication no'), args)?.[3], 'PreferredAuthentications=keyboard-interactive')

  // ConPTY paints cells and may omit a trailing blank or insert cursor moves
  // inside a prompt. The fixture is ready at the colon, not at a space that
  // may never be emitted (the same rendering rule as the real SSH detector).
  const fixturePrompt = (text: string): boolean => conptyScrub(text).text.includes('fixture password:')
  check('native fixture handshake accepts a prompt without a trailing blank', fixturePrompt('fixture password:'), true)
  check('native fixture handshake accepts ConPTY cursor repainting', fixturePrompt('\u001b[Hfixture pass\u001b[1;13Hword:\u001b[1;18H'), true)
  check('native fixture handshake waits until the complete prompt is ready', fixturePrompt('fixture pass'), false)

  const root = await mkdtemp(join(tmpdir(), 'stoke-ssh-fallback-'))
  try {
    const path = join(root, 'config')
    await writeFile(path, 'Host fixture\n  HostName 127.0.0.1\n  Port 1\n  BatchMode no\nHost only-key\n  HostName 127.0.0.1\n  PreferredAuthentications publickey\n', { mode: 0o600 })
    const directArgs = ['-F', path, '-e', 'none', 'fixture', 'true']
    const resolved = await resolvePasswordFallback(sshExecutable(), directArgs, env, new AbortController().signal)
    check('real ssh -G defaults permit interactive fallback without making a connection', resolved?.slice(-directArgs.length), directArgs)
    check('real ssh -G key-only choice is preserved', await resolvePasswordFallback(sshExecutable(), ['-F', path, 'only-key'], env, new AbortController().signal), null)
    const cancelledConfig = new AbortController(); cancelledConfig.abort()
    check('a cancelled real config subprocess cannot authorize a retry', await resolvePasswordFallback(sshExecutable(), directArgs, env, cancelledConfig.signal), null)
    if (resolved) {
      const { stdout } = await promisify(execFile)(sshExecutable(), ['-G', ...resolved], { encoding: 'utf8', timeout: 4000, env })
      check('OpenSSH really disables key offers for the replacement', /^pubkeyauthentication (?:false|no)$/m.test(stdout), true)
      check('OpenSSH keeps the original endpoint/command policy', [/^hostname 127\.0\.0\.1$/m.test(stdout), /^port 1$/m.test(stdout)], [true, true])
    }

    type Listener<T> = (value: T) => void
    const fake = () => {
      const data = new Set<Listener<string>>(), exits = new Set<Listener<{ exitCode: number; signal?: number }>>()
      const writes: Array<string | Buffer> = [], sizes: number[][] = []
      let kills = 0
      const child = {
        pid: 123, cols: 80, rows: 24, process: 'ssh', handleFlowControl: false,
        onData(fn: Listener<string>) { data.add(fn); return { dispose: () => data.delete(fn) } },
        onExit(fn: Listener<{ exitCode: number; signal?: number }>) { exits.add(fn); return { dispose: () => exits.delete(fn) } },
        write(value: string | Buffer) { writes.push(value) }, resize(c: number, r: number) { sizes.push([c, r]) },
        kill() { kills++ }, clear() {}, pause() {}, resume() {}
      } as unknown as IPty
      return { child, writes, sizes, get kills() { return kills }, output: (text: string) => { for (const fn of data) fn(text) }, exit: (code = 255) => { for (const fn of exits) fn({ exitCode: code }) } }
    }
    const first = fake(), second = fake(), natives: IPty[] = [], released: IPty[] = [], startedArgs: string[][] = [], startedSizes: number[][] = []
    let resolve!: (args: string[] | null) => void
    const pty = spawnSshPty('ssh', args, { cols: 80, rows: 24 }, {
      spawn(_file, nextArgs, options) { startedArgs.push(nextArgs); startedSizes.push([options.cols!, options.rows!]); return startedArgs.length === 1 ? first.child : second.child },
      started: child => natives.push(child), exited: child => released.push(child), conpty: false,
      fallback: () => new Promise(done => { resolve = done })
    })
    const output: string[] = [], ended: number[] = []
    pty.onData(data => output.push(data)); pty.onExit(event => ended.push(event.exitCode))
    check('the initial connection enables the trusted authentication marker', startedArgs[0].slice(0, 2), ['-o', 'LogLevel=VERBOSE'])
    first.output(failure); first.exit()
    check('the failed native child is cleaned without ending the logical tab', [released.length, ended.length, pty.pid], [1, 0, 0])
    pty.write('must not be queued'); pty.resize(100, 32)
    resolve(passwordFallbackArgs(config, startedArgs[0])); await turn()
    check('one replacement inherits the latest grid', [natives.length, startedSizes[1]], [2, [100, 32]])
    check('keys typed during the disconnected gap are never replayed', [first.writes, second.writes], [[], []])
    check('the retry is visible before the new password prompt', output.some(text => text.includes('Trying another sign-in method')), true)
    pty.write('new-password\r')
    check('new input goes only to the current native terminal', [first.writes, second.writes], [[], ['new-password\r']])
    second.output(failure); second.exit()
    check('a failed replacement never starts a third connection', [natives.length, released.length, ended], [2, 2, [255]])
    first.exit(); second.exit()
    check('duplicate native exit delivery cannot end the tab twice', ended, [255])

    const closing = fake(); let late!: (args: string[] | null) => void, launches = 0, aborted = false
    const cancelled = spawnSshPty('ssh', args, {}, {
      spawn() { launches++; return closing.child }, started() {}, exited() {}, conpty: false,
      fallback: (_file, _args, _env, signal) => { signal.addEventListener('abort', () => { aborted = true }); return new Promise(done => { late = done }) }
    })
    const closed: number[] = []; cancelled.onExit(event => closed.push(event.exitCode))
    closing.output(failure); closing.exit(); cancelled.kill(); late(passwordFallbackArgs(config, args)); await turn()
    check('closing during config lookup aborts it and never kills an already-exited PID', [aborted, launches, closing.kills, closed], [true, 1, 0, [255]])

    // Actual native terminals exercise output drain, echo and exit ownership;
    // this fixture is its own process and never contacts a real SSH account.
    const script = join(root, 'fixture.cjs')
    await writeFile(script, `if(process.argv.includes('PubkeyAuthentication=no')){process.stdin.setRawMode(true);process.stdout.write("fixture password:");process.stdin.on('data',()=>{process.stdout.write('\\r\\nfixture command ran once\\r\\n');process.exit(0)});}else{process.stdout.write(${JSON.stringify(failure)});process.exit(255);}`)
    const nativeTracker = new PtyExitTracker(), nativeChildren: IPty[] = []
    const nativeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    let nativeOutput = '', nativeStarts = 0
    let replacementStarted!: () => void
    const replacement = new Promise<void>(done => { replacementStarted = done })
    const real = spawnSshPty(process.execPath, [], { cwd: root, env: nativeEnv, cols: 80, rows: 24 }, {
      spawn(file, nextArgs, options) {
        nativeStarts++
        const child = spawn(file, [script, ...nextArgs], options)
        if (nativeStarts === 2) replacementStarted()
        return child
      },
      started(child) { nativeChildren.push(child); nativeTracker.track(child) }, exited: releaseExitedPtyTransports, conpty: process.platform === 'win32',
      fallback: async (_file, nextArgs) => passwordFallbackArgs(config, nextArgs)
    })
    let answered = false, childrenAtPrompt = 0
    const final = new Promise<number>(done => real.onExit(event => done(event.exitCode)))
    real.onData(text => {
      nativeOutput += text
      if (!answered && fixturePrompt(nativeOutput)) {
        childrenAtPrompt = nativeChildren.length
        answered = true
        real.write('fixture-secret\r')
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const diagnostic = (): string => JSON.stringify({ starts: nativeStarts, answered, raw: nativeOutput.slice(-2048), normalized: conptyScrub(nativeOutput).text.slice(-2048) })
      const timeout = new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(`SSH fallback native fixture timed out: ${diagnostic()}`)), 7000) })
      await Promise.race([replacement, final.then(code => { throw new Error(`SSH fallback native fixture exited before replacement (code ${code}): ${diagnostic()}`) }), timeout])
      check('the native key failure starts exactly one replacement before prompt completion', [nativeStarts, nativeChildren.length], [2, 2])
      const code = await Promise.race([final, timeout])
      const normalized = conptyScrub(nativeOutput).text
      check('actual native PTYs retry once and finish through the same logical tab', [nativeStarts, code, normalized.includes('fixture command ran once'), childrenAtPrompt], [2, 0, true, 2])
      check('the replacement receives echo-off credentials without leaking them into output', normalized.includes('fixture-secret'), false)
      check('both exact native children deliver their exit/transport cleanup', await nativeTracker.wait(), 0)
    } finally {
      clearTimeout(timer)
      if (nativeTracker.count) { real.kill(); await nativeTracker.wait() }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
  console.log(`  ${checks} SSH password-fallback checks passed`)
}
