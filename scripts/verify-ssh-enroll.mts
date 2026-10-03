/*
 * SSH key enrollment: the detector, the window reducer, the offer table, the
 * validators, the argv and the remote install command.
 *
 * Everything under test is pure, so this suite needs no host, no network and no
 * PTY — which is the whole reason `src/shared/sshAuth.ts` exists apart from the
 * impure half. The real modules are imported; nothing here reimplements a rule
 * it is checking, because a test that restates the implementation is a test of
 * nothing.
 *
 * The one thing that is genuinely run is `buildRemoteInstallCommand`'s output,
 * under `sh -c` with a temporary HOME. A shell command is not provably correct
 * by reading it: the clause that matters most — the `tail -1c` test that stops
 * two keys being concatenated onto one line when the existing file's last line
 * has no newline — is exactly the kind of thing that reads fine and does the
 * wrong thing. That temp HOME is synthetic end to end (gotcha 74: fake every
 * input or none), and is removed afterwards.
 *
 *   node scripts/verify-ssh-enroll.mts
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, chmod, stat, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  SSH_AUTH_SCAN_LIMIT,
  SSH_AUTH_TAIL_BYTES,
  ENROLL_TAIL_CHARS,
  awaitingSshPassword,
  reconnectAfterEnroll,
  buildRemoteInstallCommand,
  conptyScrub,
  detectSshPasswordPrompt,
  enrollInstallDone,
  enrollTail,
  isEnrollableAlias,
  isSafePublicKeyLine,
  newSshAuthScan,
  newSshLoginWatch,
  shouldOfferKey,
  sshAuthStep,
  sshLoginInput,
  sshOutputStep,
  type SshAuthPrompt,
  type SshAuthStepOptions,
  type SshLoginWatch
} from '../src/shared/sshAuth.ts'
import {
  appendIdentityBlock,
  buildCopyIdArgs,
  buildEnrollFallbackArgs,
  buildIdentityBlock,
  buildLoginProbeArgs,
  buildPubkeyProbeArgs,
  identityFilesFromSshG,
  sshConfigHostPattern,
  sshCopyIdExecutable,
  sshExecutable
} from '../src/main/ssh.ts'
import { EnrollRuns } from '../src/main/enrollRuns.ts'
import {
  appendToSshConfig,
  finishEnroll,
  planEnrollLaunch,
  prepareEnroll,
  type ExecResult
} from '../src/main/sshEnroll.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import type { LaunchOptions, SshEnrollEvent, SshHost, SshKeyEnroll } from '../src/shared/types.ts'

const execFileAsync = promisify(execFile)

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`
  )
}

/*
 * Written as an escape, never as a raw 0x1b byte, for the same reason
 * `sshAuth.ts` does it: a literal control character in source survives npm but
 * not every editor, diff or paste.
 */
const ESC = '\u001b'

/* ------------------------------------------------------- the detector, firing */

console.log('\nthe prompts ssh and PAM actually print')

check("ssh's own password prompt", detectSshPasswordPrompt("v@web's password: "), {
  kind: 'password',
  user: 'v',
  host: 'web'
})
check('an expired password, old', detectSshPasswordPrompt("Enter v@web's old password: "), {
  kind: 'change',
  user: 'v',
  host: 'web'
})
check('an expired password, new', detectSshPasswordPrompt("Enter v@web's new password: "), {
  kind: 'change',
  user: 'v',
  host: 'web'
})
check('and its confirmation', detectSshPasswordPrompt("Retype v@web's new password: "), {
  kind: 'change',
  user: 'v',
  host: 'web'
})
check(
  // The bare PAM form names nobody, so user and host must come back empty
  // rather than as some guess made from the alias.
  'a bare keyboard-interactive prompt',
  detectSshPasswordPrompt('Password: '),
  { kind: 'kbdinteractive', user: '', host: '' }
)
check('and the form that names the account', detectSshPasswordPrompt('(v@web) Password: '), {
  kind: 'kbdinteractive',
  user: 'v',
  host: 'web'
})

/* ----------------------------------------------------- the detector, refusing */

/*
 * Each of these is a separate named assertion because each is a real thing a
 * terminal prints, and each would otherwise offer to install an SSH key while
 * the user is part-way through typing a DIFFERENT secret.
 */
console.log('\nwhat must never be read as a password prompt')

check(
  // The user already HAS a key. Offering to add one is both wrong and rude,
  // and the secret being typed unlocks a private key file.
  'a passphrase for an existing key',
  detectSshPasswordPrompt("Enter passphrase for key '/home/v/.ssh/id_ed25519': "),
  null
)
check('sudo asking for the login password', detectSshPasswordPrompt('[sudo] password for v: '), null)
check(
  "git's credential helper",
  detectSshPasswordPrompt("Password for 'https://v@github.com': "),
  null
)
check(
  // Terminated by a newline, so nothing is blocking on the tty.
  'sudo complaining that it got none',
  detectSshPasswordPrompt('sudo: a password is required\r\n'),
  null
)
check(
  // A server `Banner` is pre-auth and inside the scan window, and its wording
  // is chosen by a machine Stoke does not control. The trailing-newline anchor
  // is the only thing in front of it.
  'a server banner about passwords',
  detectSshPasswordPrompt('Do not share your password with anyone.\r\n'),
  null
)
check(
  'the same banner unterminated, once something is painting',
  detectSshPasswordPrompt(`${ESC}[32mDo not share your password with anyone.`),
  null
)
check(
  // The load-bearing half of the same rule: this text WOULD fire, and does not,
  // purely because an escape byte reached the line. ssh's pre-auth output is
  // plain ASCII; anything painting is a TUI, not a prompt.
  'a genuine prompt with an escape byte in front of it',
  detectSshPasswordPrompt(`${ESC}[2Kv@web's password: `),
  null
)
check('and nothing at all', detectSshPasswordPrompt(''), null)

/* ------------------------------------------------------------- the reducer */

/*
 * The order-dependent failures live here and none of them is reachable by
 * testing the detector alone.
 */
console.log('\nthe scan window')

{
  // PTY output routinely arrives split mid-sequence.
  let s = newSshAuthScan()
  const fires: unknown[] = []
  for (const chunk of ["v@we", "b's pass", 'word: ']) {
    const r = sshAuthStep(s, chunk)
    s = r.next
    fires.push(r.fire)
  }
  check('a prompt split across three chunks fires once, on the last', fires, [
    null,
    null,
    { kind: 'password', user: 'v', host: 'web' }
  ])
  ok('and the window is shut behind it', !s.open && s.fired)

  // ssh asks three times by default (numberofpasswordprompts 3). The user is
  // offered a key once.
  const second = sshAuthStep(s, "\r\nPermission denied, please try again.\r\nv@web's password: ")
  check('the second ask does not fire again', second.fire, null)
  const third = sshAuthStep(second.next, "\r\nPermission denied, please try again.\r\nv@web's password: ")
  check('nor the third', third.fire, null)
  ok('and the window stays shut', !third.next.open)
}

{
  // `claude`, `tmux` and `byobu` all emit an escape in their first frame, so in
  // practice this shuts the detector before any remote program can print the
  // word "password" at all.
  const painted = sshAuthStep(newSshAuthScan(), `${ESC}[?1049h`)
  check('an escape byte fires nothing', painted.fire, null)
  ok('and closes the window', !painted.next.open)
  const later = sshAuthStep(painted.next, "v@web's password: ")
  check('so a genuine prompt afterwards is ignored', later.fire, null)
  ok('permanently — the window never reopens', !later.next.open)
}

{
  // A chunk carrying BOTH an escape sequence and something prompt-shaped must
  // report nothing: within one chunk there is no way to tell which came first.
  const mixed = sshAuthStep(newSshAuthScan(), `${ESC}[2J\r\nv@web's password: `)
  check('an escape and a prompt in one chunk fires nothing', mixed.fire, null)
}

{
  const big = sshAuthStep(newSshAuthScan(), 'x'.repeat(SSH_AUTH_SCAN_LIMIT + 1))
  ok('exceeding the scan limit closes the window', !big.next.open)
  check('and a prompt after it is ignored', sshAuthStep(big.next, "v@web's password: ").fire, null)
  check('with the state handed straight back', sshAuthStep(big.next, 'anything').next, big.next)
}

{
  // Unbounded growth here would be a leak on every long-lived SSH tab.
  let s = newSshAuthScan()
  let worst = 0
  for (let i = 0; i < 10; i++) {
    s = sshAuthStep(s, `${i}`.repeat(1000)).next
    worst = Math.max(worst, s.tail.length)
  }
  check('the tail never exceeds its cap however much is pushed through', worst, SSH_AUTH_TAIL_BYTES)
  ok('and the window is still open below the scan limit', s.open, `scanned ${s.scanned}`)
  check(
    // Not merely capped: it must be the TAIL, or a prompt at the end of a big
    // chunk would be cut off rather than kept.
    'and it is the last bytes that were kept',
    s.tail.slice(-4),
    '9999'
  )
}

check(
  // The real bytes off a refused connection, `\r\r\n` and all.
  'a connection refusal fires nothing',
  sshAuthStep(newSshAuthScan(), 'ssh: connect to host 127.0.0.1 port 1: Connection refused\r\r\n')
    .fire,
  null
)

/* ------------------------------------------------------------ ConPTY */

/*
 * On Windows node-pty runs ConPTY, which re-renders its screen as VT from the
 * first frame — before ssh has printed anything. Under the POSIX rule (first
 * escape byte closes the window) no Windows prompt could ever be seen. These
 * streams are ConPTY-SHAPED: the sequences ConPTY is documented and reported
 * to emit, replayed on this Mac. Not a measurement of a real Windows run.
 */
console.log('\nthe scan window under ConPTY (replayed shape, not measured on Windows)')

const CONPTY_HELLO =
  `${ESC}[?9001h${ESC}[?1004h${ESC}[?25l${ESC}[2J${ESC}[m${ESC}[H` +
  `${ESC}]0;C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe\u0007${ESC}[?25h`

{
  // The exact case the POSIX rule loses: ConPTY's own first frame.
  const posix = sshAuthStep(newSshAuthScan(), CONPTY_HELLO)
  ok('without the ConPTY option, its first frame closes the window (why Windows never fired)', !posix.next.open)

  let s = newSshAuthScan()
  const fires: unknown[] = []
  const stream = [
    CONPTY_HELLO,
    // ConPTY paints cells: the trailing space of "password: " may never come,
    // and the cursor is parked with a CUP afterwards.
    `${ESC}[?25l${ESC}[H`,
    "v@web's password:",
    `${ESC}[1;19H${ESC}[?25h`
  ]
  for (const chunk of stream) {
    const r = sshAuthStep(s, chunk, { conpty: true })
    s = r.next
    fires.push(r.fire)
  }
  check('a ConPTY-shaped prompt stream fires exactly once', fires.filter(Boolean).length, 1)
  check('naming the prompt the remote printed', fires.find(Boolean), { kind: 'password', user: 'v', host: 'web' })
  const again = sshAuthStep(
    s,
    `\r\nPermission denied, please try again.\r\n${ESC}[?25lv@web's password:${ESC}[?25h`,
    { conpty: true }
  )
  check('and ssh asking again does not fire again', again.fire, null)
}

{
  // A PAM prompt, split mid-escape across chunks: the cut-off sequence is held
  // for the next chunk rather than leaking "[?25" into the line.
  let s = newSshAuthScan()
  let fired: unknown = null
  for (const chunk of [CONPTY_HELLO, `${ESC}[?2`, '5l(v@web) Password:', `${ESC}[?25h`]) {
    const r = sshAuthStep(s, chunk, { conpty: true })
    s = r.next
    fired = fired ?? r.fire
  }
  check('a PAM prompt with an escape split across chunks still fires', fired, {
    kind: 'kbdinteractive',
    user: 'v',
    host: 'web'
  })
}

for (const [label, enable] of [
  ['the alternate screen (tmux, byobu)', `${ESC}[?1049h`],
  ['mouse tracking', `${ESC}[?1000h${ESC}[?1006h`],
  ['bracketed paste (bash and zsh at their first prompt, claude)', `${ESC}[?2004h`]
] as const) {
  const painted = sshAuthStep(sshAuthStep(newSshAuthScan(), CONPTY_HELLO, { conpty: true }).next, enable, {
    conpty: true
  })
  ok(`under ConPTY, ${label} still closes the window (gotcha 75's rule)`, !painted.next.open)
  check(
    '  so a prompt-shaped line afterwards is ignored',
    sshAuthStep(painted.next, 'Password: ', { conpty: true }).fire,
    null
  )
}

{
  // ConPTY asks its host for these itself; they must not count as painting.
  const own = conptyScrub(`${ESC}[?9001h${ESC}[?1004h${ESC}[?25l`)
  ok("ConPTY's own ?9001h and ?1004h are not a far-side program painting", !own.painting)
  check('and scrub to nothing', own.text, '')
  check(
    'a banner line under ConPTY is still not a prompt — the newline anchor holds',
    sshAuthStep(sshAuthStep(newSshAuthScan(), CONPTY_HELLO, { conpty: true }).next, 'Do not share your password with anyone.\r\n', {
      conpty: true
    }).fire,
    null
  )
  check(
    'nor is sudo, scrubbed or not',
    sshAuthStep(newSshAuthScan(), `${ESC}[?25l[sudo] password for v: `, { conpty: true }).fire,
    null
  )
}

/* ------------------------------------------------ awaiting a password NOW */

/*
 * Asked after an enrollment succeeds, before a tab on that host is killed and
 * reconnected. "Yes" kills that tab's ssh, so every doubtful case is "no".
 *
 * Replayed through the production reducers exactly as `PtyManager` feeds them:
 * a string is an output chunk (`sshOutputStep`, which is `onData`), `{ in }` a
 * write the user made (`sshLoginInput`, which is `write`/`submit`). The first
 * version of this gate read only the end of the output, so a tab that had
 * logged in and then ran `su` or `ssh other` — both of which end in an exact
 * prompt shape — was killed like one that had never got in.
 */
console.log('\nis the tab still at ssh’s own prompt?')

type Replay = (string | { in: string })[]

function replay(steps: Replay, opts: SshAuthStepOptions = {}): { login: SshLoginWatch; offers: SshAuthPrompt[] } {
  let scan = newSshAuthScan()
  let login = newSshLoginWatch()
  const offers: SshAuthPrompt[] = []
  for (const s of steps) {
    if (typeof s === 'string') {
      const r = sshOutputStep(scan, login, s, opts)
      scan = r.scan
      login = r.login
      if (r.offer) offers.push(r.offer)
    } else {
      login = sshLoginInput(login, s.in, opts)
    }
  }
  return { login, offers }
}

const awaiting = (steps: Replay, opts: SshAuthStepOptions = {}): boolean =>
  awaitingSshPassword(replay(steps, opts).login, opts)

// As OpenSSH 10.3 prints it (measured against a real sshd): note the colon
// after "is", which older releases do not print — `OLD_FINGERPRINT` below.
const HOST_KEY_QUESTION: Replay = [
  "The authenticity of host 'web (10.0.0.5)' can't be established.\r\n",
  'ED25519 key fingerprint is: SHA256:a7OV5UAKzgpFKfbV4VeK5l8F2LSDrSxLvHGEYZ2IEEE\r\n',
  'This key is not known by any other names.\r\n',
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
  'yes', // cooked mode: the local tty echoes the answer
  { in: '\r' },
  '\r\n',
  "Warning: Permanently added 'web' (ED25519) to the list of known hosts.\r\n"
]
// What a logged-in bash 5.1+ prints: its prompt turns bracketed paste on, and
// Enter turns it off again before the command runs.
const BASH_PROMPT = `${ESC}[?2004hv@web:~$ `
const BASH_ENTER = `\r\n${ESC}[?2004l\r`

// -- still logging in: a reconnect loses nothing, so yes.
ok('a tab sitting at the prompt: yes', awaiting(["v@web's password: "]))
ok('behind a pre-auth banner: yes', awaiting(['Do not share your password with anyone.\r\n', "v@web's password: "]))
ok(
  'after a wrong password and the re-ask: yes',
  awaiting(["v@web's password: ", { in: 'hunter1\r' }, '\r\n', 'Permission denied, please try again.\r\n', "v@web's password: "])
)
ok(
  'the same with the line ends ssh 10.3 really printed (`\\r\\r\\n\\r`, measured): yes',
  awaiting([
    "\rv@127.0.0.1's password: ",
    { in: 'nope\r' },
    '\r\n',
    'Permission denied, please try again.\r\r\n\r',
    "v@127.0.0.1's password: "
  ])
)
ok(
  'the same, arriving as one chunk: yes',
  awaiting(["v@web's password: \r\nPermission denied, please try again.\r\nv@web's password: "])
)
ok('a first connection, host key answered "yes": yes', awaiting([...HOST_KEY_QUESTION, "v@web's password: "]))
ok('Enter pressed while it connects: yes', awaiting([{ in: '\r' }, '\r\n', "v@web's password: "]))
ok(
  'a key passphrase answered, then the password: yes',
  awaiting(["Enter passphrase for key '/Users/v/.ssh/id_ed25519': ", { in: 'pp\r' }, '\r\n', "v@web's password: "])
)
ok(
  "through a ProxyJump, the jump host's password then the target's host key: yes",
  awaiting(["v@jump's password: ", { in: 'pw\r' }, '\r\n', ...HOST_KEY_QUESTION, "v@web's password: "])
)
{
  const OLD_FINGERPRINT = 'ED25519 key fingerprint is SHA256:a7OV5UAKzgpFKfbV4VeK5l8F2LSDrSxLvHGEYZ2IEEE.\r\n'
  ok(
    '  and with an older OpenSSH, whose fingerprint line has no colon: yes',
    awaiting([
      "v@jump's password: ",
      { in: 'pw\r' },
      '\r\n',
      ...HOST_KEY_QUESTION.map((s) => (typeof s === 'string' && s.includes('fingerprint is:') ? OLD_FINGERPRINT : s)),
      "v@web's password: "
    ])
  )
}
ok('keyboard-interactive: yes', awaiting(['(v@web) Password: ']))
ok(
  'under ConPTY, a repainted prompt: yes',
  awaiting([`${CONPTY_HELLO}${ESC}[H(v@web) Password:${ESC}[1;19H`], { conpty: true })
)
ok(
  "a terminal report is not typing — xterm's focus and colour-scheme replies: yes",
  awaiting(["v@web's password: ", { in: `${ESC}[I` }, { in: `${ESC}[?997;1n` }])
)
ok(
  'a host whose own command is `su -`, logged in by key: yes — no shell ever ran, a reconnect loses nothing',
  awaiting(['Password: '])
)

// -- got in: whatever it is sitting at now, never killed.
ok(
  'the user typed it and got a shell: no',
  !awaiting(["v@web's password: ", { in: 'pw\r' }, '\r\n', 'Welcome to Ubuntu 24.04\r\n', 'v@web:~$ '])
)
ok(
  'logged in, then `su` at a bash 5.1+ prompt: no',
  !awaiting([
    "v@web's password: ",
    { in: 'pw\r' },
    '\r\n',
    'Linux web 6.1.0-25-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.106-3 x86_64\r\n',
    BASH_PROMPT,
    'su',
    { in: '\r' },
    BASH_ENTER,
    'Password: '
  ])
)
ok(
  'logged in, then a nested `ssh other` at a dash prompt that paints nothing: no',
  !awaiting(["v@web's password: ", { in: 'pw\r' }, '\r\n', '$ ', 'ssh other', { in: '\r' }, '\r\n', "v@other's password: "])
)
ok(
  '  and the same with no keystroke seen — the finished line alone settles it (rule 3): no',
  !awaiting(["v@web's password: ", '\r\n', '$ ssh other\r\n', "v@other's password: "])
)
ok(
  'logged in, a MOTD with no escape in it, then a prompt printed with nothing typed: no',
  !awaiting(["v@web's password: ", { in: 'pw\r' }, '\r\n', 'Last login: Tue Sep 30 10:00:00 2026 from 10.0.0.1\r\n', 'Password: '])
)
ok(
  'logged in BY KEY to bash 4.4 (RHEL 8: no bracketed paste), then `su -`: no',
  !awaiting(['Last login: Tue Sep 30 10:00:00 2026 from 10.0.0.1\r\n', '[v@web ~]$ ', 'su -', { in: '\r' }, '\r\n', 'Password: '])
)
ok(
  '  and with Enter arriving before the echo did: no',
  !awaiting(['[v@web ~]$ ', { in: 'su -\r' }, 'su -\r\n', 'Password: '])
)
ok(
  'under ConPTY, a DECSET that means a shell is drawing: no',
  !awaiting([CONPTY_HELLO, "v@web's password:", { in: 'pw\r' }, '\r\n', `${ESC}[?2004h`, 'v@web:~$ '], { conpty: true })
)
ok(
  'under ConPTY with that DECSET swallowed, `su` typed at the shell still settles it: no',
  !awaiting(
    [CONPTY_HELLO, "v@web's password:", { in: 'pw\r' }, '\r\n', 'v@web:~$ ', 'su', { in: '\r' }, '\r\n', 'Password:'],
    { conpty: true }
  )
)
ok('a TUI painting: no', !awaiting(["v@web's password: ", '\r\n', `${ESC}[?1049h${ESC}[H`]))
ok('nothing printed: no', !awaiting([]))
ok(
  `past the ${SSH_AUTH_SCAN_LIMIT}-byte budget, nothing is proved: no`,
  !awaiting([`${'x'.repeat(SSH_AUTH_SCAN_LIMIT)}\r\n`, "v@web's password: "])
)
{
  const settled = replay(["v@web's password: ", '\r\n', BASH_PROMPT]).login
  ok('once settled, it stays settled', settled.settled)
  ok(
    '  so a prompt of the exact ssh shape later still reads no',
    !awaitingSshPassword(replay(["v@web's password: ", '\r\n', BASH_PROMPT, 'exit\r\n', "v@web's password: "]).login)
  )
}

/*
 * Real bytes, not a replayed shape: each pty's output exactly as node-pty
 * delivered it, from a real sshd asking for a password (keys refused with
 * `-o PubkeyAuthentication=no`, nothing typed). Captured 2026-10-03: macOS
 * `/usr/bin/ssh` (OpenSSH 10.3) against the owner's Windows sshd, and Windows
 * `ssh.exe` (OpenSSH_for_Windows 9.5p2) under ConPTY against its own sshd on
 * localhost — the first ConPTY stream here measured rather than shaped.
 */
const MEASURED_MAC_PROMPT = ['\r', "User@protech-desktop's password: "]
const MEASURED_CONPTY_PROMPT = [
  `${ESC}[?9001h${ESC}[?1004h`,
  `${ESC}[?25l${ESC}[2J${ESC}[m${ESC}[HWarning: Permanently added 'localhost' (ED25519) to the list of known hosts.\r\n` +
    `${ESC}]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\u0007${ESC}[?25h`,
  "User@localhost's password: "
]
/*
 * The same Windows session, resized three times at its prompt (120x27, 100x27,
 * 100x30) — what the key offer's own strip does to the tab in front, taking a
 * row of the column. ConPTY repaints the whole screen from `CSI H` and parks
 * the cursor back at the end of the prompt row with a CUP, so the unfinished
 * line is empty. Read with the cursor moves dropped, the repainted banner
 * joined the prompt row and settled the watch: no reconnect, ever, for the tab
 * the user added the key from. Measured on Windows 11, 2026-10-03.
 */
const REPAINT_HEAD =
  `${ESC}[HWarning: Permanently added 'localhost' (ED25519) to the list of known hosts.${ESC}[K\r\n` +
  `User@localhost's password:${ESC}[K\r\n`
const MEASURED_CONPTY_RESIZES = [
  `${ESC}[?25l${ESC}[8;27;120t` + REPAINT_HEAD + `${ESC}[K\r\n`.repeat(24) + `${ESC}[K${ESC}[2;28H${ESC}[?25h`,
  `${ESC}[?25l` + REPAINT_HEAD + `${ESC}[K\r\n`.repeat(24) + `${ESC}[K${ESC}[2;28H${ESC}[?25h`,
  `${ESC}[?25l` + REPAINT_HEAD + `${ESC}[K\r\n`.repeat(27) + `${ESC}[K${ESC}[2;28H${ESC}[?25h`,
]
ok('measured on macOS: a tab at a real ssh prompt is still at it', awaiting(MEASURED_MAC_PROMPT))
ok(
  'measured under ConPTY: a tab at a real ssh.exe prompt is still at it',
  awaiting(MEASURED_CONPTY_PROMPT, { conpty: true })
)
check(
  '  and the offer fires once, naming the machine that asked',
  replay(MEASURED_CONPTY_PROMPT, { conpty: true }).offers,
  [{ kind: 'password', user: 'User', host: 'localhost' }]
)
{
  const resized = [...MEASURED_CONPTY_PROMPT, ...MEASURED_CONPTY_RESIZES]
  ok('measured under ConPTY: still at the prompt after three resizes repaint it', awaiting(resized, { conpty: true }))
  ok('  and not settled by the repaint', !replay(resized, { conpty: true }).login.settled)
  check('  and the offer still fires exactly once', replay(resized, { conpty: true }).offers.length, 1)
  ok(
    'answered (Enter at the prompt), then repainted: not at the prompt — the login is in flight',
    !awaiting([...MEASURED_CONPTY_PROMPT, { in: '\r' }, '\r\n', ...MEASURED_CONPTY_RESIZES], { conpty: true })
  )
  ok(
    'answered, then ssh asks again: at the prompt',
    awaiting(
      [
        ...MEASURED_CONPTY_PROMPT,
        { in: '\r' },
        '\r\n',
        'Permission denied, please try again.\r\n',
        "User@localhost's password: "
      ],
      { conpty: true }
    )
  )
}
ok(
  'POSIX: answered, and the echo of Enter finishes the prompt line: not at the prompt',
  !awaiting(["v@web's password: ", { in: '\r' }, '\r\n'])
)
ok(
  '  nor before the echo arrives',
  !awaiting(["v@web's password: ", { in: 'hunter2\r' }])
)
ok(
  '  and a wrong password, asked again: at the prompt',
  awaiting(["v@web's password: ", { in: '\r' }, '\r\n', 'Permission denied, please try again.\r\n', "v@web's password: "])
)

console.log('\nthe watch under ConPTY repaints and cursor moves (shapes built from the measured ones)')
{
  /*
   * An adversarial review's replays (2026-10-03), each built from the measured
   * ConPTY repaint above — home, rows ended `CSI K` + `\r\n`, a CUP parking the
   * cursor — and each wrong before the fix it pins. The dangerous direction is
   * a TRUE that is not: a logged-in tab, or one whose password is in flight,
   * killed for a reconnect and offered a key while `su` asks for root's.
   */
  const C = { conpty: true }
  const repaint = (rows: string[], height: number, cur: [number, number]): string => {
    const body: string[] = []
    for (let i = 0; i < height; i++) body.push((rows[i] ?? '') + `${ESC}[K`)
    return `${ESC}[?25l${ESC}[H` + body.join('\r\n') + `${ESC}[${cur[0]};${cur[1]}H${ESC}[?25h`
  }
  const HELLO = `${ESC}[?9001h${ESC}[?1004h${ESC}[?25l${ESC}[2J${ESC}[m${ESC}[H${ESC}]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\u0007${ESC}[?25h`
  const W = "Warning: Permanently added 'localhost' (ED25519) to the list of known hosts."
  const P = "User@localhost's password:"
  const MP = MEASURED_CONPTY_PROMPT
  const keyLogin = [HELLO, 'Linux web 6.1.0-25-amd64 #1 SMP Debian x86_64\r\n', '\r\n', `${ESC}[32mv@web${ESC}[m:~$ `]
  const atShell = repaint(['Linux web 6.1.0-25-amd64 #1 SMP Debian x86_64', '', 'v@web:~$'], 27, [3, 10])
  const answeredRepaint = repaint([W, P], 27, [3, 1])
  const cut = answeredRepaint.indexOf(P) + P.length
  const inFlight: Replay = [...MP, { in: 'pw\r' }, '\r\n']
  const wrong: Replay = [...MP, { in: 'bad\r' }, '\r\n']
  const banner = 'Authorized users only. All activity may be monitored and reported.'
  const pq = [
    '** WARNING: connection is not using a post-quantum key exchange algorithm.',
    '** This session may be vulnerable to "store now, decrypt later" attacks.',
    '** The server may need to be upgraded. See https://openssh.com/pq.html'
  ]
  const cases: [string, Replay, boolean][] = [
    // A logged-in tab: never at the prompt.
    [
      'a key login whose shell parks the cursor with a CUP, then `su -`: no (rule 4 on the parked line)',
      ['Linux web 6.1\r\n', 'v@web:~$ su -', `${ESC}[1;10H`, { in: '\r' }, '\r\n', 'Password: '],
      false
    ],
    [
      'a key login, Home-edited to `exec su -` (CUPs), then su asks: no',
      [...keyLogin, 'su -', { in: `${ESC}[H` }, `${ESC}[3;10H`, { in: 'exec ' }, `exec su -${ESC}[3;15H`, { in: '\r' }, `${ESC}[3;19H\r\n`, 'Password: '],
      false
    ],
    [
      'a key login to pwsh, a prediction drawn and the cursor parked back, then a nested ssh: no',
      [HELLO, `${ESC}[HPS C:\\Users\\v> `, 's', 's', 'h', ' ', 'o', `${ESC}[90mther${ESC}[m${ESC}[1;21H`, { in: '\r' }, `${ESC}[K\r\n`, "v@other's password: "],
      false
    ],
    ['a key login, a resize, `su -` pasted: no', [...keyLogin, atShell, { in: 'su -\r' }, 'su -\r\n', 'Password: '], false],
    [
      'a key login, a resize, `su -` typed with Enter before its echo: no',
      [...keyLogin, atShell, { in: 's' }, { in: 'u' }, { in: ' ' }, { in: '-' }, { in: '\r' }, 'su -\r\n', 'Password: '],
      false
    ],
    ['a key login, a resize, `ssh other` pasted: no', [...keyLogin, atShell, { in: 'ssh other\r' }, 'ssh other\r\n', "v@other's password: "], false],
    ['a password login to dash, then a resize: no', [...MP, { in: 'pw\r' }, '\r\n', '$ ', repaint([W, P, '$'], 27, [3, 3])], false],
    // A password in flight: not at the prompt, however the repaint is chunked.
    ['in flight, a repaint split right after the old prompt row: no', [...inFlight, answeredRepaint.slice(0, cut), answeredRepaint.slice(cut)], false],
    ['in flight, a repaint split inside its CSI K: no', [...inFlight, answeredRepaint.slice(0, cut + 2), answeredRepaint.slice(cut + 2)], false],
    [
      're-asked, repainted, answered again, repainted: no',
      [...wrong, `Permission denied, please try again.\r\n${P} `, repaint([W, P, 'Permission denied, please try again.', P], 27, [4, 28]), { in: 'pw\r' }, '\r\n', repaint([W, P, 'Permission denied, please try again.', P], 27, [5, 1])],
      false
    ],
    // ssh asking again: at the prompt, however the row ends.
    ['a re-ask as text: yes', [...wrong, `Permission denied, please try again.\r\n${P} `], true],
    ['a re-ask ended by a CUP in the same chunk: yes', [...wrong, `Permission denied, please try again.\r\n${P}${ESC}[4;28H`], true],
    ['a re-ask, the CUP in the next chunk: yes', [...wrong, `Permission denied, please try again.\r\n${P}`, `${ESC}[4;28H`], true],
    ['a re-ask, then a resize: yes', [...wrong, `Permission denied, please try again.\r\n${P} `, repaint([W, P, 'Permission denied, please try again.', P], 27, [4, 28])], true],
    ['a keyboard-interactive re-ask ended by a CUP: yes', [HELLO, '(v@web) Password:', { in: 'bad\r' }, `\r\n(v@web) Password:${ESC}[3;19H`], true],
    // A pre-auth Banner a repaint finishes again is not text after the prompt.
    ['a Banner above the prompt, one resize: yes', [HELLO, `${banner}\r\n`, `${P} `, repaint([banner, P], 27, [2, 28])], true],
    ['OpenSSH’s post-quantum warning above the prompt, one resize: yes', [HELLO, pq.join('\r\n') + '\r\n', `${P} `, repaint([...pq, P], 27, [4, 28])], true],
    ['a Banner, answered, the login prints a shell, a resize: no', [HELLO, `${banner}\r\n`, `${P} `, { in: 'pw\r' }, '\r\n', '$ ', repaint([banner, P, '$'], 27, [3, 3])], false],
    // Answered after a resize, by the keyboard or the phone (text, then a lone Enter).
    ['the prompt, a resize, the password and Enter: no', [...MP, ...MEASURED_CONPTY_RESIZES, { in: 'pw\r' }], false],
    ['the same from the phone: no', [...MP, ...MEASURED_CONPTY_RESIZES, { in: 'hunter2' }, { in: '\r' }], false],
    // A repaint cuts short the row it lands on; that row counts on the OLD screen
    // (found in review: counted on the new one, these two read as waiting).
    ['a repaint between Enter and ssh’s newline: no — the password is in flight', [...MP, { in: 'pw\r' }, MEASURED_CONPTY_RESIZES[0], '\r\n'], false],
    ['  the same with the newline folded into the repaint: no', [...MP, { in: 'pw\r' }, repaint([W, P], 27, [3, 1])], false],
    [
      'a resize at the prompt, a wrong password, a repaint in the delay, then ssh asks again: yes',
      [
        ...MP,
        MEASURED_CONPTY_RESIZES[0],
        { in: 'bad\r' },
        '\r\n',
        'Permission denied, please try again.\r\n',
        repaint([W, P, 'Permission denied, please try again.'], 27, [4, 1]),
        "User@localhost's password: "
      ],
      true
    ]
  ]
  for (const [name, steps, want] of cases) ok(name, awaiting(steps, C) === want)
  check('a repaint at the prompt leaves one prompt row counted, not two', replay([...MP, MEASURED_CONPTY_RESIZES[0]], C).login.shown, 1)
  ok(
    'and a tab at a key login whose cursor is parked is never offered a key for su’s prompt',
    replay(['Linux web 6.1\r\n', 'v@web:~$ su -', `${ESC}[1;10H`, { in: '\r' }, '\r\n', 'Password: '], C).offers.length === 0
  )
}

console.log('\nwhich tabs a proven key reconnects')
{
  const base = { running: false, awaitingPassword: false, loggedIn: undefined, exitCode: null, isSource: false }
  ok('a running tab still at ssh’s prompt: yes', reconnectAfterEnroll({ ...base, running: true, awaitingPassword: true }))
  ok(
    'a running tab that got in: no, even the one the key was for',
    !reconnectAfterEnroll({ ...base, running: true, awaitingPassword: false, isSource: true })
  )
  ok(
    '  and a running tab’s exit report is never read',
    !reconnectAfterEnroll({ ...base, running: true, awaitingPassword: false, loggedIn: false, exitCode: 255 })
  )
  ok(
    'an exited tab nothing ever ran in (Ctrl+C at the prompt, refused): yes',
    reconnectAfterEnroll({ ...base, loggedIn: false, exitCode: 0 })
  )
  ok(
    // "Connection closed by …" after a late answer settles the watch too.
    'the exited tab the key was for, whose ssh gave up (255, settled): yes',
    reconnectAfterEnroll({ ...base, isSource: true, loggedIn: true, exitCode: 255 })
  )
  ok(
    'the tab the key was for, logged in and ended cleanly (exit 0): no — it keeps its last screen',
    !reconnectAfterEnroll({ ...base, isSource: true, loggedIn: true, exitCode: 0 })
  )
  ok(
    'any other exited tab with a settled watch: no, whatever its code',
    !reconnectAfterEnroll({ ...base, loggedIn: true, exitCode: 255 })
  )
  ok('any other exited tab with no watch: no', !reconnectAfterEnroll({ ...base, loggedIn: null, exitCode: 1 }))
}

/*
 * The offer uses the same watch: the detector alone reads a window of bytes,
 * and a key login into a shell that paints nothing shows it `su`'s prompt
 * inside that window, in exactly ssh's shape — gotcha 75's "a DIFFERENT
 * password". `sshOutputStep` is what `PtyManager` runs, so this is the rule
 * as it ships, not a copy of it.
 */
console.log('\nthe offer, through the same step PtyManager runs')

check('a plain prompt is offered once', replay(["v@web's password: "]).offers.length, 1)
check(
  'ssh asking three times is still one offer',
  replay([
    "v@web's password: ",
    '\r\n',
    'Permission denied, please try again.\r\n',
    "v@web's password: ",
    '\r\n',
    'Permission denied, please try again.\r\n',
    "v@web's password: "
  ]).offers.length,
  1
)
check('a first connection (host key answered) is offered', replay([...HOST_KEY_QUESTION, "v@web's password: "]).offers.length, 1)
check('Enter pressed while it connects does not cost the offer', replay([{ in: '\r' }, '\r\n', "v@web's password: "]).offers.length, 1)
check(
  'a key login into bash 4.4, then `su -`: never offered',
  replay(['Last login: Tue Sep 30 10:00:00 2026 from 10.0.0.1\r\n', '[v@web ~]$ ', 'su -', { in: '\r' }, '\r\n', 'Password: ']).offers
    .length,
  0
)
check(
  'a key login, then a nested `ssh other`: never offered',
  replay(['$ ', 'ssh other', { in: '\r' }, '\r\n', "v@other's password: "]).offers.length,
  0
)

/* --------------------------------------------------------- shouldOfferKey */

/*
 * The full truth table, written out as literals rather than computed — a table
 * generated from the same rule the code uses would agree with any rule at all.
 */
console.log('\nwhether to offer a key')

const OFFER_TABLE: {
  setting: SshKeyEnroll
  refused: boolean
  enrolled: boolean
  inFlight: boolean
  want: 'ask' | 'auto' | 'no'
}[] = [
  { setting: 'ask', refused: false, enrolled: false, inFlight: false, want: 'ask' },
  { setting: 'ask', refused: false, enrolled: false, inFlight: true, want: 'no' },
  { setting: 'ask', refused: false, enrolled: true, inFlight: false, want: 'ask' },
  { setting: 'ask', refused: false, enrolled: true, inFlight: true, want: 'no' },
  { setting: 'ask', refused: true, enrolled: false, inFlight: false, want: 'no' },
  { setting: 'ask', refused: true, enrolled: false, inFlight: true, want: 'no' },
  { setting: 'ask', refused: true, enrolled: true, inFlight: false, want: 'no' },
  { setting: 'ask', refused: true, enrolled: true, inFlight: true, want: 'no' },
  { setting: 'auto', refused: false, enrolled: false, inFlight: false, want: 'auto' },
  { setting: 'auto', refused: false, enrolled: false, inFlight: true, want: 'no' },
  { setting: 'auto', refused: false, enrolled: true, inFlight: false, want: 'auto' },
  { setting: 'auto', refused: false, enrolled: true, inFlight: true, want: 'no' },
  { setting: 'auto', refused: true, enrolled: false, inFlight: false, want: 'no' },
  { setting: 'auto', refused: true, enrolled: false, inFlight: true, want: 'no' },
  { setting: 'auto', refused: true, enrolled: true, inFlight: false, want: 'no' },
  { setting: 'auto', refused: true, enrolled: true, inFlight: true, want: 'no' },
  { setting: 'off', refused: false, enrolled: false, inFlight: false, want: 'no' },
  { setting: 'off', refused: false, enrolled: false, inFlight: true, want: 'no' },
  { setting: 'off', refused: false, enrolled: true, inFlight: false, want: 'no' },
  { setting: 'off', refused: false, enrolled: true, inFlight: true, want: 'no' },
  { setting: 'off', refused: true, enrolled: false, inFlight: false, want: 'no' },
  { setting: 'off', refused: true, enrolled: false, inFlight: true, want: 'no' },
  { setting: 'off', refused: true, enrolled: true, inFlight: false, want: 'no' },
  { setting: 'off', refused: true, enrolled: true, inFlight: true, want: 'no' }
]

check('the table covers every combination', OFFER_TABLE.length, 3 * 2 * 2 * 2)
check(
  'with no row written twice',
  new Set(OFFER_TABLE.map((r) => `${r.setting}/${r.refused}/${r.enrolled}/${r.inFlight}`)).size,
  OFFER_TABLE.length
)
for (const row of OFFER_TABLE) {
  check(
    `${row.setting}, ${row.refused ? 'refused' : 'not refused'}, ${
      row.enrolled ? 'enrolled' : 'not enrolled'
    }, ${row.inFlight ? 'in flight' : 'idle'}`,
    shouldOfferKey(row),
    row.want
  )
}

/*
 * Stated on its own because it is the counter-intuitive one, and the one a
 * future "optimisation" would break: if the host is asking for a password
 * again, the key is NOT working, and going silent leaves the user with no way
 * to find out why.
 */
check(
  'an already-enrolled host is still offered — silence there hides a broken key',
  shouldOfferKey({ setting: 'ask', refused: false, enrolled: true, inFlight: false }),
  'ask'
)
check(
  'and under auto it still goes ahead',
  shouldOfferKey({ setting: 'auto', refused: false, enrolled: true, inFlight: false }),
  'auto'
)

/* ------------------------------------------------------------- validators */

console.log('\nwhat may be handed to the enrollment tools')

for (const bad of ['', '-oProxyCommand=x', 'a b', '*', '!x', 'web?']) {
  ok(`alias refused: ${JSON.stringify(bad)}`, !isEnrollableAlias(bad))
}
ok('alias accepted: "web"', isEnrollableAlias('web'))
ok('alias accepted: "user@1.2.3.4"', isEnrollableAlias('user@1.2.3.4'))

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL9tR0M0KcmVqQvFFxTKcVYb4nHLhTmZ0Q8sS1rW6vJq'
const KEY_WITH_COMMENT = `${KEY} v@laptop`

ok('a real ed25519 line is accepted', isSafePublicKeyLine(KEY))
ok('and the same line with a comment', isSafePublicKeyLine(KEY_WITH_COMMENT))

/*
 * The fallback path embeds this line in a command the FAR machine's login shell
 * runs, so each of these is refused outright rather than escaped.
 */
const BAD_KEYS: [string, string][] = [
  ["a single quote, which would end the shell string", `${KEY} '; rm -rf ~ #`],
  ['a backtick', `${KEY} \`id\``],
  ['a $( substitution', `${KEY} $(id)`],
  ['an embedded newline carrying a second command', `${KEY}\nrm -rf ~`],
  ['a key type nobody ships', `ssh-fake AAAAC3NzaC1lZDI1NTE5 v@laptop`],
  ['a comment with a space and a semicolon', `${KEY} v@laptop; id`]
]
for (const [label, line] of BAD_KEYS) {
  ok(`key line refused: ${label}`, !isSafePublicKeyLine(line), JSON.stringify(line))
}

/* ------------------------------------------------------------------ argv */

console.log('\nthe argv')

const host: SshHost = { id: 'h1', label: 'web', alias: 'web', command: '', worklog: false }
const dashHost: SshHost = { ...host, id: 'h2', alias: '-oProxyCommand=id' }

const copyId = buildCopyIdArgs(host, '/home/v/.ssh/id_ed25519.pub')
ok('buildCopyIdArgs returns an argv for a sane alias', copyId !== null)
if (copyId) {
  /*
   * ssh stops parsing options at the first non-option argument, which is the
   * same rule verify-ssh.mts pins for `-e none`. An `-o` after the alias is not
   * an option at all — it becomes part of the remote command.
   */
  const aliasAt = copyId.indexOf('web')
  const optionsAfterAlias = copyId.map((a, i) => (a === '-o' && i > aliasAt ? i : -1)).filter((i) => i >= 0)
  ok('the alias is there', aliasAt >= 0, copyId.join(' '))
  check('every -o precedes it', optionsAfterAlias, [])
  check('and the alias is the last argument', copyId[copyId.length - 1], 'web')
  ok(
    // gotcha 29 must survive here too: the user types a password into this PTY,
    // and ssh-copy-id has no `-e` flag of its own.
    'EscapeChar=none is set, ssh-copy-id having no -e',
    copyId.includes('EscapeChar=none'),
    copyId.join(' ')
  )
  ok('the key path is passed with -i', copyId[copyId.indexOf('-i') + 1] === '/home/v/.ssh/id_ed25519.pub')
}
check(
  'and a leading-dash alias gets no argv at all',
  buildCopyIdArgs(dashHost, '/home/v/.ssh/id_ed25519.pub'),
  null
)

const fallback = buildEnrollFallbackArgs(host, KEY_WITH_COMMENT)
ok('buildEnrollFallbackArgs returns an argv', fallback !== null)
if (fallback) {
  const aliasAt = fallback.indexOf('web')
  ok('with the alias present', aliasAt >= 0, fallback.join(' '))
  check('the remote command last, after the alias', fallback.length - 1, aliasAt + 1)
  ok('and -e none for the escape character', fallback.includes('-e') && fallback.includes('none'))
}
check('null for an unsafe key line', buildEnrollFallbackArgs(host, `${KEY} $(id)`), null)
check('null for a leading-dash alias', buildEnrollFallbackArgs(dashHost, KEY_WITH_COMMENT), null)

const probe = buildPubkeyProbeArgs(host, '/home/v/.ssh/id_ed25519')
ok('buildPubkeyProbeArgs returns an argv', probe !== null)
if (probe) {
  ok(
    // Only ever used to WORD a failure of the login probe below, but it must
    // never prompt either: BatchMode is what guarantees it either succeeds on
    // the key or exits non-zero.
    'BatchMode=yes, so the -i probe can never prompt',
    probe.includes('BatchMode=yes'),
    probe.join(' ')
  )
  ok('and it is a real option, before the alias', probe.indexOf('BatchMode=yes') < probe.indexOf('web'))
}
check('null for a leading-dash alias', buildPubkeyProbeArgs(dashHost, '/home/v/.ssh/id_ed25519'), null)

/*
 * The probe that may set keyEnrolled asks what the TAB will do next time, so
 * it has the tab's identities, not one forced with -i. The first version used
 * the -i form, and a key minted as ~/.ssh/stoke_ed25519 — not a default name,
 * never in the config — passed it while every new tab still asked for a
 * password.
 */
const login = buildLoginProbeArgs(host)
ok('buildLoginProbeArgs returns an argv', login !== null)
if (login) {
  ok('the login probe has no -i', !login.includes('-i'), login.join(' '))
  ok('and no IdentitiesOnly', !login.some((a) => /identitiesonly/i.test(a)), login.join(' '))
  ok('BatchMode=yes, so it can never prompt', login.includes('BatchMode=yes'), login.join(' '))
  ok('publickey only, so a keyboard-interactive host does not count', login.includes('PreferredAuthentications=publickey'))
  ok('ControlPath=none, so a multiplexed master cannot answer for it', login.includes('ControlPath=none'))
  check('the alias then exit, last', login.slice(-2), ['web', 'exit'])
}
check('null for a leading-dash alias', buildLoginProbeArgs(dashHost), null)

/* ------------------------------------------ the remote install command, run */

console.log('\nthe remote install command')

check('null for a key line that is not provably safe', buildRemoteInstallCommand(`${KEY} \`id\``), null)
check('and for empty input', buildRemoteInstallCommand(''), null)

const installCmd = buildRemoteInstallCommand(`  ${KEY_WITH_COMMENT}  `)
ok('a safe line round-trips into a command', installCmd !== null)
ok(
  'carrying the trimmed key, double-quoted inside the sh -c body',
  installCmd !== null && installCmd.includes(`"${KEY_WITH_COMMENT}"`),
  installCmd ?? 'null'
)
ok(
  // The remote LOGIN shell parses this first, and it is whatever the user has:
  // fish rejects `{ …; }` and csh reads `$(` differently. One outer `sh -c '…'`
  // with no single quote inside survives all of them.
  "wrapped as sh -c '…', so the login shell never parses the body",
  installCmd !== null && installCmd.startsWith("sh -c '") && installCmd.endsWith("'"),
  installCmd ?? 'null'
)
ok(
  'with exactly two single quotes, the outer pair',
  installCmd !== null && (installCmd.match(/'/g) ?? []).length === 2,
  installCmd ?? 'null'
)

/**
 * Run the generated command under a throwaway HOME and report what landed.
 *
 * Synthetic end to end: the directory is made by mkdtemp and removed after, so
 * nothing here can reach the real `~/.ssh` (gotcha 74).
 */
async function runInstall(
  cmd: string,
  seed?: { content: string; mode: number },
  shell = 'sh'
): Promise<{ text: string; dirMode: number; fileMode: number; out: string }> {
  const home = await mkdtemp(join(tmpdir(), 'stoke-enroll-'))
  try {
    if (seed) {
      await mkdir(join(home, '.ssh'), { recursive: true })
      // Deliberately loose, so the explicit chmods have something to fix —
      // sshd silently ignores an authorized_keys with permissions like these.
      await chmod(join(home, '.ssh'), 0o755)
      await writeFile(join(home, '.ssh', 'authorized_keys'), seed.content)
      await chmod(join(home, '.ssh', 'authorized_keys'), seed.mode)
    }
    // Run by `shell -c`, the way sshd hands a command to the login shell.
    const { stdout } = await execFileAsync(shell, ['-c', cmd], { env: { ...process.env, HOME: home }, cwd: home })
    const text = await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')
    const dirMode = (await stat(join(home, '.ssh'))).mode & 0o777
    const fileMode = (await stat(join(home, '.ssh', 'authorized_keys'))).mode & 0o777
    return { text, dirMode, fileMode, out: String(stdout) }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

if (installCmd && process.platform !== 'win32') {
  const fresh = await runInstall(installCmd)
  check('on a machine with no .ssh at all, the file is exactly the key', fresh.text, `${KEY_WITH_COMMENT}\n`)
  // The line the "Add key" tab is watched for (enrollInstallDone), once every step has worked.
  check('and it says so, in one line, last', fresh.out, 'Stoke: key installed.\n')
  ok('a line enrollInstallDone takes', enrollInstallDone(fresh.out))
  check('.ssh is 700', fresh.dirMode.toString(8), '700')
  check('authorized_keys is 600', fresh.fileMode.toString(8), '600')

  const OLD = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDold old@laptop'

  /*
   * The clause the whole command exists for. Without the `tail -1c` test this
   * comes back as ONE line with both keys run together, which sshd reads as a
   * single malformed entry — so the old key stops working AND the new one never
   * starts, with no error anywhere.
   */
  const noNewline = await runInstall(installCmd, { content: OLD, mode: 0o644 })
  check(
    'an existing file whose last line has no newline gets a separator',
    noNewline.text,
    `${OLD}\n${KEY_WITH_COMMENT}\n`
  )
  check('so both keys are whole lines', noNewline.text.split('\n').filter(Boolean), [
    OLD,
    KEY_WITH_COMMENT
  ])
  check('and the loose mode it arrived with is repaired', noNewline.fileMode.toString(8), '600')
  check('as is the directory it sat in', noNewline.dirMode.toString(8), '700')

  const withNewline = await runInstall(installCmd, { content: `${OLD}\n`, mode: 0o600 })
  check(
    'a file that already ends in a newline gains no blank line',
    withNewline.text,
    `${OLD}\n${KEY_WITH_COMMENT}\n`
  )

  const twice = await runInstall(installCmd, { content: `${OLD}\n${KEY_WITH_COMMENT}`, mode: 0o600 })
  check(
    // Not deduplicated, deliberately — but it must still be well-formed lines.
    'a second run of the same key still produces whole lines',
    twice.text.split('\n').filter(Boolean).length,
    3
  )

  /*
   * The login shells a VPS actually has. Each is only run where it is
   * installed — a missing one is a SKIP, printed, never a silent pass.
   */
  for (const shell of ['/bin/bash', '/bin/zsh', '/bin/dash', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/bin/tcsh']) {
    let present = true
    try {
      await stat(shell)
    } catch {
      present = false
    }
    if (!present) {
      console.log(`  SKIP  as the login shell: ${shell} is not installed here`)
      continue
    }
    const r = await runInstall(installCmd, { content: OLD, mode: 0o644 }, shell)
    check(`as the login shell, ${shell} installs it as a whole line`, r.text, `${OLD}\n${KEY_WITH_COMMENT}\n`)
    check(`  and prints the line the tab is watched for`, r.out, 'Stoke: key installed.\n')
  }
} else {
  console.log('  SKIP  running the command needs a POSIX sh')
}

/* ------------------------------------------ the install ran to its end: the tab's own words */

/*
 * The enrollment used to finish only when the "Add key" tab's process exited.
 * On the owner's other computer (2026-10-02) the key went on and the process
 * stayed, so the strip sat on "Adding…" and the asking tab was never
 * reconnected. Main now also reads the tab's output for these lines and runs
 * the probe at once (`enrollOutput`). A hint only — the probe decides — but a
 * hint must not fire early: before the password, or on the command's own text.
 */
console.log('\nthe install ran to its end, read from the tab')

ok('ssh-copy-id’s own report of a key added', enrollInstallDone('\nNumber of key(s) added: 1\n\nNow try logging into the machine, with: "ssh \'web\'"\n'))
ok('and of every key already being there', enrollInstallDone('/usr/bin/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.\n'))
ok('the fallback’s own line', enrollInstallDone('Stoke: key installed.\r\n'))
ok(
  'through ConPTY’s repaint: cursor and mode sequences between and around the words',
  enrollInstallDone('\u001b[?25l\u001b[2;1HStoke: key \u001b[mi\u001b[?25hnstalled.\u001b]0;ssh\u0007\r\n')
)
{
  let tail = ''
  for (const chunk of ['Stoke: key ins', 'talled', '.\r\n']) tail = enrollTail(tail, chunk)
  ok('a line cut across chunks reads whole', enrollInstallDone(tail))
  tail = ''
  for (const chunk of ['Stoke: key \u001b[', '?25linstalled.\r\n']) tail = enrollTail(tail, chunk)
  ok('and so does an escape cut across chunks', enrollInstallDone(tail))
}
check('the tail stays bounded', enrollTail('x'.repeat(ENROLL_TAIL_CHARS), 'y'.repeat(10_000)).length, ENROLL_TAIL_CHARS)
ok('…keeping its newest end', enrollInstallDone(enrollTail('x'.repeat(50_000), 'Stoke: key installed.\n')))
for (const [label, text] of [
  ['ssh-copy-id before the password', '/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed\n/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys\nv@web\'s password: '],
  ['a wrong password', 'v@web\'s password: \r\nPermission denied, please try again.\r\n'],
  ['the install command itself, echoed', installCmd ?? ''],
  ['a set -x trace of it on the far side', '+ printf \'Stoke: key %s.\\n\' installed\n'],
  ['a count of no keys', 'Number of key(s) added: \n']
] as const) {
  ok(`not before it has: ${label}`, !enrollInstallDone(text), JSON.stringify(text))
}
{
  // index.ts proves a run on whichever comes first; this is what makes "first" exactly once.
  const runs = new EnrollRuns()
  const host = { id: 'host-9', label: 'Web', alias: 'web', command: '', persist: 'off' }
  runs.add('pty-1', { host, keyPath: '/k1', fallback: true })
  check('output before the install is done takes nothing', runs.output('pty-1', "v@web's password: "), null)
  check('another pty’s output is never this run’s', runs.output('pty-2', 'Stoke: key installed.\r\n'), null)
  check('the line takes the run', runs.output('pty-1', '\r\nStoke: key ins')?.keyPath ?? runs.output('pty-1', 'talled.\r\n')?.keyPath, '/k1')
  check('then the tab’s exit proves nothing a second time', runs.exit('pty-1'), null)
  check('nor does more of its output', runs.output('pty-1', 'Stoke: key installed.\r\n'), null)
  runs.add('pty-3', { host, keyPath: '/k3', fallback: false })
  check('a tab that exits without the line is taken by its exit, as before', runs.exit('pty-3')?.keyPath, '/k3')
  check('once', runs.exit('pty-3'), null)
}

/* ------------------------------------------- the key, saved in the config */

/*
 * Plain `ssh <alias>` — what every tab runs — only offers keys its config
 * names (or the default names). A key it would not offer is appended as one
 * `Host` / `IdentityFile` block: append-only, never an edit, and refused for
 * anything that cannot be written safely.
 */
console.log('\nthe IdentityFile block')

check('the Host pattern for an alias is the alias', sshConfigHostPattern('web'), 'web')
check('for user@host it is the host part ssh matches on', sshConfigHostPattern('v@203.0.113.9'), '203.0.113.9')
for (const bad of ['-oProxyCommand=x', 'a b', 'web*', '!web', 'ssh://v@web:2222', 'v@[2001:db8::1]', '']) {
  check(`no Host pattern for ${JSON.stringify(bad)}`, sshConfigHostPattern(bad), null)
}
check('no block for a refused alias', buildIdentityBlock('-oProxyCommand=x', '/k'), null)
check('no block for a path with a %, which ssh would expand', buildIdentityBlock('web', '/home/v/%u/key'), null)
check('nor one with a quote', buildIdentityBlock('web', '/home/v/"key'), null)
check('nor one with a newline, which would be a second directive', buildIdentityBlock('web', '/k\nProxyCommand x'), null)
{
  const block = buildIdentityBlock('web', '/Users/Jo Smith/.ssh/stoke_ed25519')
  ok('a path with a space is quoted', block !== null && block.includes('IdentityFile "/Users/Jo Smith/.ssh/stoke_ed25519"'), block ?? 'null')
  const lines = (block ?? '').split('\n')
  check('the block is a comment, Host, IdentityFile — nothing else', lines.filter(Boolean).length, 3)

  const cases: [string, string][] = [
    ['an empty file', ''],
    ['a file ending in a newline', 'Host a\n  User x\n'],
    ['a file with no final newline', 'Host a\n  User x'],
    ['a CRLF file', 'Host a\r\n  User x\r\n']
  ]
  for (const [label, existing] of cases) {
    const next = appendIdentityBlock(existing, block ?? '')
    ok(`appending to ${label} keeps every existing byte as a prefix`, next.startsWith(existing), JSON.stringify(next))
    ok(`  and the Host line starts a line of its own`, /(^|\n)Host web\r?\n/.test(next), JSON.stringify(next))
  }
  ok('a CRLF file stays CRLF', !/[^\r]\n/.test(appendIdentityBlock('Host a\r\n', block ?? '')))
}

/*
 * The writer, on synthetic paths only (gotcha 74): a temp dir standing in for
 * ~/.ssh, never the real one.
 */
/*
 * Windows has no POSIX mode: node reports every writable file as 666, and
 * `appendToSshConfig` deliberately does not chmod there — Windows OpenSSH
 * judges the file by the ACL it inherits from the profile folder instead. So
 * the reading there is "left writable, not read-only", and 600 everywhere else.
 * Asserting 600 on Windows failed the first Windows CI run on a mode the OS
 * cannot hold, not on anything the writer did.
 */
const CONFIG_MODE = process.platform === 'win32' ? '666' : '600'
const sandbox = await mkdtemp(join(tmpdir(), 'stoke-enroll-cfg-'))
try {
  const block = buildIdentityBlock('web', join(sandbox, 'stoke_ed25519')) ?? ''

  {
    const file = join(sandbox, 'config')
    // Not valid UTF-8, no final newline: a decode/re-encode would change it.
    const original = Buffer.concat([Buffer.from('Host a\n  User caf'), Buffer.from([0xe9]), Buffer.from('\n# end')])
    await writeFile(file, original)
    await chmod(file, 0o600)
    // A backup the USER made. Stoke's own is `.stoke.bak`, so this must survive.
    await writeFile(`${file}.bak`, 'mine')
    const r = await appendToSshConfig(file, block)
    const after = await readFile(file)
    ok('the original bytes are a byte-for-byte prefix of the new file', after.subarray(0, original.length).equals(original))
    ok('and the block follows them', after.subarray(original.length).toString('utf8').includes('Host web'))
    ok('the previous file is kept as config.stoke.bak, exactly', (await readFile(`${file}.stoke.bak`)).equals(original))
    check("the user's own config.bak is untouched", await readFile(`${file}.bak`, 'utf8'), 'mine')
    check(`the mode is kept at ${CONFIG_MODE} — ssh refuses a config others can write`, ((await stat(file)).mode & 0o777).toString(8), CONFIG_MODE)
    // Beside the REAL path: macOS's $TMPDIR is itself behind /var -> /private/var.
    check('it reports the backup it made, beside the resolved file', r.backup, `${await realpath(file)}.stoke.bak`)
  }

  {
    // A dotfiles setup: ~/.ssh/config is a symlink into a repo.
    const real = join(sandbox, 'dotfiles-config')
    const link = join(sandbox, 'linked-config')
    await writeFile(real, 'Host a\n')
    await symlink(real, link)
    await appendToSshConfig(link, block)
    ok('a symlinked config stays a symlink', (await lstat(link)).isSymbolicLink())
    ok('and its target gained the block', (await readFile(real, 'utf8')).includes('Host web'))
  }

  {
    const fresh = join(sandbox, 'nested', 'config')
    await appendToSshConfig(fresh, block)
    check('a missing config is created holding just the block', await readFile(fresh, 'utf8'), block)
    check(`at ${CONFIG_MODE}`, ((await stat(fresh)).mode & 0o777).toString(8), CONFIG_MODE)
  }
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

/* ---------------------------------------------- the launch plan, by id only */

console.log('\nthe enroll launch plan never takes argv from the renderer')

{
  const hosts: SshHost[] = [{ id: 'h1', label: 'web', alias: 'web', command: 'byobu', worklog: false }]
  // Everything a compromised or buggy renderer could put in the request.
  const hostile = {
    cwd: '/etc',
    cli: 'codex',
    install: ['codex'],
    host: { id: 'h1', label: 'x', alias: 'evil.example', command: 'rm -rf ~' },
    extraArgs: ['-oProxyCommand=sh'],
    addDirs: ['/'],
    sessionId: 'x',
    resume: true,
    permissionMode: 'bypassPermissions',
    model: 'x',
    effort: 'max',
    cols: 132,
    rows: 40,
    enroll: { hostId: 'h1' }
  } as unknown as LaunchOptions
  const plan = planEnrollLaunch(hostile, hosts)
  ok('a known host id plans', plan.ok)
  if (plan.ok) {
    check('the host is the one settings holds under that id', plan.host, hosts[0])
    check('and the options are built from scratch: id and size only', plan.opts, {
      cwd: '',
      permissionMode: 'default',
      model: '',
      effort: 'default',
      cols: 132,
      rows: 40,
      enroll: { hostId: 'h1' }
    })
  }
  check('an unknown id is refused', planEnrollLaunch({ ...hostile, enroll: { hostId: 'nope' } }, hosts).ok, false)
  check('no id is refused', planEnrollLaunch({ ...hostile, enroll: undefined }, hosts).ok, false)
}

/* ------------------------------------------ prepare and finish, faked ssh */

/*
 * The orchestrator end to end with every program faked and every path in a
 * temp dir: which key, whether the config is written, what the tab runs, and
 * what the proof runs. The fake `ssh -G` reads the synthetic config, so "the
 * key is now listed" is decided by what was actually written.
 */
console.log('\nprepare and finish, with ssh faked and ~/.ssh synthetic')

const DEFAULT_IDS = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk']

async function withSandbox(
  seed: (sshDir: string) => Promise<void>,
  probes: { login: boolean; direct: boolean },
  run: (ctx: {
    sshDir: string
    configFile: string
    calls: { file: string; args: string[] }[]
    events: SshEnrollEvent[]
    deps: Parameters<typeof prepareEnroll>[1]
  }) => Promise<void>
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'stoke-enroll-home-'))
  const sshDir = join(home, '.ssh')
  const configFile = join(sshDir, 'config')
  await mkdir(sshDir, { recursive: true })
  await seed(sshDir)
  const calls: { file: string; args: string[] }[] = []
  const events: SshEnrollEvent[] = []
  const exec = async (file: string, args: string[]): Promise<ExecResult> => {
    calls.push({ file, args })
    if (args[0] === '-G') {
      // Real ssh prints the defaults unless the config names a file. This fake
      // reads the synthetic config for the IdentityFile lines Stoke wrote.
      let text = ''
      try {
        text = await readFile(configFile, 'utf8')
      } catch {
        /* none */
      }
      const named = [...text.matchAll(/IdentityFile "([^"]+)"/g)].map((m) => m[1])
      const lines = [...DEFAULT_IDS.map((n) => `identityfile ~/.ssh/${n}`), ...named.map((p) => `identityfile ${p}`)]
      return { ok: true, stdout: `host ${args[1]}\n${lines.join('\n')}\n`, stderr: '', error: null }
    }
    if (args.includes('-t') && args.includes('ed25519')) {
      const target = args[args.indexOf('-f') + 1]
      await writeFile(target, 'PRIVATE')
      await writeFile(`${target}.pub`, `${KEY} Stoke`)
      return { ok: true, stdout: '', stderr: '', error: null }
    }
    if (args.includes('BatchMode=yes')) {
      const direct = args.includes('-i')
      const pass = direct ? probes.direct : probes.login
      return pass
        ? { ok: true, stdout: '', stderr: '', error: null }
        : { ok: false, stdout: '', stderr: 'v@web: Permission denied (publickey).', error: 'exit 255' }
    }
    return { ok: false, stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, error: 'unexpected' }
  }
  try {
    await run({
      sshDir,
      configFile,
      calls,
      events,
      deps: { exec, sshDir, configFile, home, copyId: '/usr/bin/ssh-copy-id', emit: (e) => events.push(e) }
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const webHost: SshHost = { id: 'h1', label: 'web', alias: 'web', command: '', worklog: false }

await withSandbox(
  async (d) => {
    await writeFile(join(d, 'id_ed25519'), 'PRIVATE')
    await writeFile(join(d, 'id_ed25519.pub'), `${KEY} v@laptop`)
  },
  { login: true, direct: true },
  async ({ sshDir, configFile, calls, events, deps }) => {
    const prep = await prepareEnroll(webHost, deps)
    ok('a key ssh already offers is reused', prep.ok && prep.keyPath === join(sshDir, 'id_ed25519'))
    ok('no ssh-keygen ran', !calls.some((c) => c.args.includes('ed25519')))
    let wrote = true
    try {
      await stat(configFile)
    } catch {
      wrote = false
    }
    ok('and no config was written — ssh already offers it', !wrote)
    if (prep.ok) {
      check('the tab runs ssh-copy-id with that key', prep.command.file, '/usr/bin/ssh-copy-id')
      check('  built from the settings alias', prep.command.args.at(-1), 'web')
      ok('  EscapeChar=none, since a password is typed there (gotcha 29)', prep.command.args.includes('EscapeChar=none'))
      const done = await finishEnroll(webHost, prep.keyPath, 0, false, deps)
      ok('a passing login probe is a success', done.ok)
      const loginCall = calls.find((c) => c.args.includes('BatchMode=yes'))
      ok('and that probe carried no -i', !!loginCall && !loginCall.args.includes('-i'), loginCall?.args.join(' '))
      ok('the last event is done, ok', events.at(-1)?.stage === 'done' && events.at(-1)?.ok === true)
    }
  }
)

await withSandbox(
  async () => {},
  { login: true, direct: true },
  async ({ sshDir, configFile, calls, deps }) => {
    const prep = await prepareEnroll(webHost, deps)
    ok('with no key at all, id_ed25519 is made — a default name', prep.ok && prep.keyPath === join(sshDir, 'id_ed25519'))
    const keygen = calls.find((c) => c.args.includes('ed25519'))
    ok('  with an empty passphrase on argv, never a real one', !!keygen && keygen.args[keygen.args.indexOf('-N') + 1] === '')
    let wrote = true
    try {
      await stat(configFile)
    } catch {
      wrote = false
    }
    ok('  and no config write: ssh offers id_ed25519 by default', !wrote)
  }
)

await withSandbox(
  async (d) => {
    // Somebody's key, with no public half: never overwritten, never read.
    await writeFile(join(d, 'id_ed25519'), 'SOMEONE ELSES')
    await writeFile(join(d, 'config'), 'Host *\n  ServerAliveInterval 30')
  },
  { login: true, direct: true },
  async ({ sshDir, configFile, deps }) => {
    const before = await readFile(configFile, 'utf8')
    const prep = await prepareEnroll(webHost, deps)
    const key = join(sshDir, 'stoke_ed25519')
    ok('an id_ed25519 with no .pub is left alone and stoke_ed25519 is made', prep.ok && prep.keyPath === key)
    check('  the existing private key is untouched', await readFile(join(sshDir, 'id_ed25519'), 'utf8'), 'SOMEONE ELSES')
    const after = await readFile(configFile, 'utf8')
    ok('  the config gained a block for it — plain ssh would not offer that name', after.includes(`IdentityFile "${key}"`))
    ok('  appended: the old config is an exact prefix', after.startsWith(before))
    check('  and backed up first', await readFile(`${configFile}.stoke.bak`, 'utf8'), before)
    ok('  and ssh -G was asked again to confirm it is now offered', identityFilesFromSshG(`identityfile ${key}`).includes(key))
  }
)

await withSandbox(
  async (d) => {
    await writeFile(join(d, 'id_ed25519'), 'PRIVATE')
    await writeFile(join(d, 'id_ed25519.pub'), `${KEY} v@laptop`)
  },
  { login: false, direct: true },
  async ({ sshDir, events, deps }) => {
    const done = await finishEnroll(webHost, join(sshDir, 'id_ed25519'), 0, false, deps)
    ok('server accepts the key but plain ssh does not offer it: NOT enrolled', !done.ok && done.installed)
    ok('  and it says which half is wrong', /does not offer/.test(done.message), done.message)
    check('  reported as done, not ok', [events.at(-1)?.stage, events.at(-1)?.ok], ['done', false])
  }
)

await withSandbox(
  async () => {},
  { login: false, direct: false },
  async ({ sshDir, events, deps }) => {
    const done = await finishEnroll(webHost, join(sshDir, 'id_ed25519'), 127, true, deps)
    ok('a fallback that failed on a non-POSIX login shell is not enrolled', !done.ok && !done.installed)
    ok('  and says to run ssh-copy-id from Git Bash', /Git Bash/.test(done.message), done.message)
    check('  reported as failed', events.at(-1)?.stage, 'failed')
  }
)

await withSandbox(
  async () => {},
  { login: false, direct: false },
  async ({ sshDir, events, deps }) => {
    // SIGHUP from closing the tab: exit code 0 and a signal, on macOS.
    const done = await finishEnroll(webHost, join(sshDir, 'id_ed25519'), 0, false, deps, 1)
    ok('closing the Add-key tab mid-prompt is a cancel, not "the install reported success"', /was closed/.test(done.message), done.message)
    check('  reported as failed', events.at(-1)?.stage, 'failed')
  }
)

await withSandbox(
  async () => {},
  { login: true, direct: true },
  async ({ calls, events, deps }) => {
    const bad = await prepareEnroll({ ...webHost, alias: '-oProxyCommand=sh' }, deps)
    ok('an option-shaped alias is refused before anything runs', !bad.ok && calls.length === 0)
    check('  with a failed event for the strip', events.at(-1)?.stage, 'failed')
  }
)

/* -------------------------------------------------------------- hydration */

console.log('\nsettings hydration')

check('an untouched machine asks', hydrateSettings({}).sshKeyEnroll, 'ask')
check('a value nobody offers falls back to ask', hydrateSettings({ sshKeyEnroll: 'yes' }).sshKeyEnroll, 'ask')
check('as does a number', hydrateSettings({ sshKeyEnroll: 2 }).sshKeyEnroll, 'ask')
check('auto survives', hydrateSettings({ sshKeyEnroll: 'auto' }).sshKeyEnroll, 'auto')
check('off survives', hydrateSettings({ sshKeyEnroll: 'off' }).sshKeyEnroll, 'off')

{
  /*
   * `keyEnrollRefused` silences an offer and `keyEnrolled` claims a key is
   * installed and working, so neither may be asserted by a truthy leftover in a
   * hand-edited file. `worklog` is checked in the same breath as a regression
   * guard: it is on the very line these two were added to, and it decides
   * whether an agent reads that machine's transcripts.
   */
  const hosts = hydrateSettings({
    hosts: [
      {
        id: 'h1',
        label: 'web',
        alias: 'web',
        command: '',
        worklog: 'yes',
        keyEnrollRefused: 'yes',
        keyEnrolled: 1
      },
      { id: 'h2', label: 'nuc', alias: 'nuc', command: '' },
      { id: 'h3', label: 'box', alias: 'box', command: '', worklog: true, keyEnrolled: true }
    ]
  }).hosts

  check('three hosts survive the filter', hosts.length, 3)
  check('a truthy string does not refuse an offer', hosts[0].keyEnrollRefused, false)
  check('nor does a 1 claim a key is enrolled', hosts[0].keyEnrolled, false)
  check('and worklog is still coerced the same way', hosts[0].worklog, false)
  check('a host written before the fields existed gets both as false', [
    hosts[1].keyEnrollRefused,
    hosts[1].keyEnrolled
  ], [false, false])
  check('and worklog too', hosts[1].worklog, false)
  check('a literal true does survive', [hosts[2].worklog, hosts[2].keyEnrolled], [true, true])
}

/* ----------------------------------------------------------- this machine */

console.log(`\nssh: ${sshExecutable()}`)
console.log(`ssh-copy-id: ${sshCopyIdExecutable() ?? 'not installed — the fallback path is what runs'}`)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
