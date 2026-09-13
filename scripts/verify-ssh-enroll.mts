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
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  SSH_AUTH_SCAN_LIMIT,
  SSH_AUTH_TAIL_BYTES,
  buildRemoteInstallCommand,
  detectSshPasswordPrompt,
  isEnrollableAlias,
  isSafePublicKeyLine,
  newSshAuthScan,
  shouldOfferKey,
  sshAuthStep
} from '../src/shared/sshAuth.ts'
import {
  buildCopyIdArgs,
  buildEnrollFallbackArgs,
  buildPubkeyProbeArgs,
  sshCopyIdExecutable,
  sshExecutable
} from '../src/main/ssh.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import type { SshHost, SshKeyEnroll } from '../src/shared/types.ts'

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
    // The probe is the only thing that may set keyEnrolled, and it may never
    // prompt: BatchMode is what guarantees it either succeeds on the key or
    // exits non-zero.
    'BatchMode=yes, so the probe can never prompt',
    probe.includes('BatchMode=yes'),
    probe.join(' ')
  )
  ok('and it is a real option, before the alias', probe.indexOf('BatchMode=yes') < probe.indexOf('web'))
}
check('null for a leading-dash alias', buildPubkeyProbeArgs(dashHost, '/home/v/.ssh/id_ed25519'), null)

/* ------------------------------------------ the remote install command, run */

console.log('\nthe remote install command')

check('null for a key line that is not provably safe', buildRemoteInstallCommand(`${KEY} \`id\``), null)
check('and for empty input', buildRemoteInstallCommand(''), null)

const installCmd = buildRemoteInstallCommand(`  ${KEY_WITH_COMMENT}  `)
ok('a safe line round-trips into a command', installCmd !== null)
ok(
  'carrying the trimmed key, quoted',
  installCmd !== null && installCmd.includes(`'${KEY_WITH_COMMENT}'`),
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
  seed?: { content: string; mode: number }
): Promise<{ text: string; dirMode: number; fileMode: number }> {
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
    await execFileAsync('sh', ['-c', cmd], { env: { ...process.env, HOME: home }, cwd: home })
    const text = await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')
    const dirMode = (await stat(join(home, '.ssh'))).mode & 0o777
    const fileMode = (await stat(join(home, '.ssh', 'authorized_keys'))).mode & 0o777
    return { text, dirMode, fileMode }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

if (installCmd && process.platform !== 'win32') {
  const fresh = await runInstall(installCmd)
  check('on a machine with no .ssh at all, the file is exactly the key', fresh.text, `${KEY_WITH_COMMENT}\n`)
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
} else {
  console.log('  SKIP  running the command needs a POSIX sh')
}

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
