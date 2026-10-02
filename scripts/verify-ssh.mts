/*
 * Verifies the ssh config parser and the argv builder.
 *
 * Two halves, and the second is the one that matters. The parser's rules about
 * comments, `=`, quoting and wildcards are claims about how OpenSSH behaves, and
 * a claim like that is exactly the kind of thing this project keeps getting
 * plausibly wrong. So the fixture config written here is fed to the real `ssh`
 * binary with `-F`, and what the parser says is compared against what ssh itself
 * resolves. `-G` dumps the effective configuration and exits without connecting,
 * so nothing is dialled and no network is needed.
 *
 *   node scripts/verify-ssh.mts
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  MAX_REMOTE_TRANSCRIPT_BYTES,
  appendIdentityBlock,
  buildIdentityBlock,
  buildLoginProbeArgs,
  buildSshArgs,
  identityFilesFromSshG,
  buildTranscriptArgs,
  buildTranscriptCommand,
  isConnectableAlias,
  isSafeSessionId,
  parseSshConfig,
  readSshConfigHosts,
  splitTranscriptOutput,
  sshConfigPath,
  sshExecutable
} from '../src/main/ssh.ts'
import { fetchRemoteTranscript } from '../src/main/sshTranscript.ts'
import {
  MANAGED_HISTORY_LIMIT,
  MANAGED_TERMINAL_OVERRIDES,
  NO_TMUX_NOTICE,
  REMOTE_SESSION_FORMAT,
  buildPersistentCommand,
  buildRemoteSessionKillArgs,
  buildRemoteSessionListArgs,
  parseRemoteSessionList,
  sshHostArgs
} from '../src/main/ssh.ts'
import { endRemoteSession, listRemoteSessions, type RunResult } from '../src/main/sshSessions.ts'
import { buildUploadArgs, buildUploadBody } from '../src/main/ssh.ts'
import {
  inspectUploadFile,
  openUploadFile,
  sendFile,
  sendImage,
  sendUpload,
  spawnWithInput,
  type InputRunOpts,
  type InputRunResult,
  type UploadInput,
  UploadHolds,
  type HoldTimers
} from '../src/main/sshUpload.ts'
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  UPLOAD_IDLE_MS,
  cidaCount,
  clipboardImageName,
  droppedFileName,
  droppedImageName,
  fileNameW,
  fileUploadTimeoutMs,
  fileUrlPath,
  formatBytes,
  imageKind,
  isSafeFarName,
  isSafeUploadName,
  parseFilenamesPlist,
  parseUploadPath,
  parseUriList,
  uploadFailureKind,
  uploadTimeoutMs
} from '../src/shared/imageUpload.ts'
import { ImageJobs, type DroppedFile, type DroppedImageFile, type ImagePhase } from '../src/shared/imageJobs.ts'
import type { ImagePrepared, ImageSent, ImageSource } from '../src/shared/api.ts'
import {
  isPersistableCommand,
  isSafeRemoteSessionName,
  mintRemoteSessionName,
  persistRefusal
} from '../src/shared/sshPersist.ts'
import { chmod, readFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { SshHost } from '../src/shared/types.ts'

const execFileAsync = promisify(execFile)

let failures = 0

/**
 * Windows OpenSSH refuses to read an *Include*d config file whose ACL grants any
 * SID other than the owner, SYSTEM and Administrators — and a directory created
 * under %TEMP% inherits whatever stale SIDs are already there, so ssh aborts
 * before resolving a single alias. The file named by `-F` is exempt from that
 * check; only included ones are inspected.
 *
 * So lock the fixture down before ssh is pointed at it. Per path, because the
 * `(OI)(CI)` inheritance flags apply to directories and grant a *file* nothing:
 * applying them with /T leaves the files with an empty DACL, which fails in the
 * opposite direction and reads as "permission denied" on the config itself.
 */
async function lockDown(paths: { path: string; dir: boolean }[]): Promise<void> {
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (!user) return
  for (const { path, dir } of paths) {
    try {
      await execFileAsync('icacls', [
        path,
        '/inheritance:r',
        '/grant:r',
        `${user}:${dir ? '(OI)(CI)F' : 'F'}`
      ])
    } catch {
      /* Best effort. If it fails, the ssh checks below report it themselves. */
    }
  }
}

function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

function same(name: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a}, want ${b}`)
}

/** Host aliases in some config text, without going near the disk. */
const aliasesIn = (text: string): string[] =>
  parseSshConfig(text)
    .filter((e) => e.kind === 'host')
    .map((e) => e.value)
    .filter(isConnectableAlias)

const host = (p: Partial<SshHost>): SshHost => ({
  id: 'h1',
  label: 'Test',
  alias: 'vps',
  command: '',
  ...p
})

/* ------------------------------------------------- this machine's real config */

/*
 * The real file is read, but nothing is asserted about *which* aliases it
 * holds. An earlier version of this block listed six by name — the author's own
 * hosts, from one particular desk — which made the suite pass on exactly that
 * machine, fail on every other, and publish six private hostnames to a public
 * repo. `npm run check` could therefore never go green anywhere else, and
 * CLAUDE.md calls that chain the gate for "done".
 *
 * What this half genuinely promises is machine-independent: reading the real
 * config must not throw, whatever it happens to contain, and every alias it
 * offers must be connectable. That is what is checked.
 *
 * The connectable check is vacuously true on a machine with no ssh config at
 * all, and deliberately so — the fixture below is where that rule is put under
 * real load, with aliases chosen to break it.
 */
console.log('\nthe real ~/.ssh/config on this machine')

const real = await readSshConfigHosts()
console.log(`  found: ${real.join(', ') || '(none)'}`)

check('nothing unusable slipped in', real.every(isConnectableAlias), `${real.length} aliases`)

/* ------------------------------------------------------------ missing file */

console.log('\na machine with no ssh config')
same(
  'a missing file is [] rather than a throw',
  await readSshConfigHosts(join(tmpdir(), 'stoke-no-such-ssh-config-3f9a2')),
  []
)
same(
  'a directory where a file should be is [] too',
  await readSshConfigHosts(tmpdir()),
  []
)

/* ---------------------------------------------------------------- patterns */

console.log('\npatterns that name a family are not machines')
same('a bare wildcard is skipped', aliasesIn('Host *\n  User root\n'), [])
same('so is a suffix wildcard', aliasesIn('Host *.example.com\n'), [])
same('and a single-character wildcard', aliasesIn('Host web?\n'), [])
same('a negation is an exclusion, not a host', aliasesIn('Host !bad good\n'), ['good'])
same(
  'the connectable half of a mixed line survives',
  aliasesIn('Host vps *.internal backup\n'),
  ['vps', 'backup']
)
check('isConnectableAlias rejects empty', !isConnectableAlias(''), '')

console.log('\nline shapes')
same('several aliases on one Host line', aliasesIn('Host a b c\n'), ['a', 'b', 'c'])
same('a whole-line comment is ignored', aliasesIn('# Host nope\nHost yes\n'), ['yes'])
same('an indented comment too', aliasesIn('   # Host nope\nHost yes\n'), ['yes'])
same('a trailing comment ends the line', aliasesIn('Host web # prod\n'), ['web'])
same('but a # inside a token does not', aliasesIn('Host web#1\n'), ['web#1'])
same('the equals form', aliasesIn('Host=eq\n'), ['eq'])
same('the spaced equals form', aliasesIn('Host = eq\n'), ['eq'])
same('lower case keyword', aliasesIn('host lower\n'), ['lower'])
same('tabs and ragged spacing', aliasesIn('\t Host \t a   b \t\n'), ['a', 'b'])
same('a quoted alias stays one alias', aliasesIn('Host "two words"\n'), ['two words'])
same('CRLF line endings', aliasesIn('Host a\r\n  User x\r\nHost b\r\n'), ['a', 'b'])
same('no Host lines at all', aliasesIn('User root\nPort 22\n'), [])
same('an empty file', aliasesIn(''), [])
same('a Match block names no host', aliasesIn('Match user root\n  User root\n'), [])

/* ------------------------------------------------------------------- argv */

/*
 * The keepalive pair every SSH tab carries (gotcha 126): local options, before
 * the destination, so a dead link ENDS with exit 255 in ~45 s instead of
 * freezing the tab until TCP gives up. Pinned here once and spread into every
 * argv below, so a change to it is one visible edit, not eleven.
 */
const KA = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']

console.log('\nargv')
same('no command means a plain login shell', buildSshArgs(host({})), ['-e', 'none', ...KA, 'vps'])
same(
  '-t is sent whenever a command is',
  buildSshArgs(host({ command: 'byobu' })),
  ['-e', 'none', ...KA, '-t', 'vps', 'byobu']
)
check(
  '-t comes before the destination, or ssh reads it as part of the command',
  buildSshArgs(host({ command: 'byobu' })).indexOf('-t') <
    buildSshArgs(host({ command: 'byobu' })).indexOf('vps'),
  ''
)
/*
 * ssh's escape character is live on any session with a tty, and it is `~`. A
 * multi-line paste arrives as bare `\r`s (xterm rewrites newlines that way), so
 * every line after the first sits exactly where ssh looks for an escape: `~~`
 * silently collapses, `~?` prints ssh's help into the session, and `~.` hangs up
 * mid-paste. Both host shapes need it, since a tty comes from the pty rather
 * than from `-t`.
 */
for (const shape of [host({}), host({ command: 'byobu' })]) {
  const args = buildSshArgs(shape)
  const at = args.indexOf('-e')
  check(
    `the ~ escape is disabled${shape.command ? ' with a command' : ' with none'}`,
    at !== -1 && args[at + 1] === 'none',
    args.join(' ')
  )
  check(
    'and -e none precedes the destination, or ssh stops parsing options first',
    at !== -1 && at + 1 < args.indexOf(shape.alias),
    args.join(' ')
  )
}
same(
  'a command with spaces stays exactly one argument',
  buildSshArgs(host({ command: 'tmux new -A -s stoke' })),
  ['-e', 'none', ...KA, '-t', 'vps', 'tmux new -A -s stoke']
)
check(
  'and that argument is not split however long it gets',
  buildSshArgs(host({ command: 'cd /srv/app && tmux new -A -s stoke' })).length === 9,
  ''
)
same(
  'shell metacharacters in the command add no argv elements',
  buildSshArgs(host({ command: 'echo "a b"; ls | wc -l' })),
  ['-e', 'none', ...KA, '-t', 'vps', 'echo "a b"; ls | wc -l']
)
same(
  'an alias with a space stays one argument',
  buildSshArgs(host({ alias: 'two words' })),
  ['-e', 'none', ...KA, 'two words']
)
same(
  'an alias with shell metacharacters is not split either',
  buildSshArgs(host({ alias: 'user@host;rm -rf /' })),
  ['-e', 'none', ...KA, 'user@host;rm -rf /']
)
same(
  'a leading dash is fenced off with --',
  buildSshArgs(host({ alias: '-oProxyCommand=calc' })),
  ['-e', 'none', ...KA, '--', '-oProxyCommand=calc']
)
same(
  'and -- sits after -t, since -- ends option parsing',
  buildSshArgs(host({ alias: '-weird', command: 'byobu' })),
  ['-e', 'none', ...KA, '-t', '--', '-weird', 'byobu']
)
same(
  'surrounding whitespace is not passed to ssh',
  buildSshArgs(host({ alias: '  vps  ', command: '  byobu  ' })),
  ['-e', 'none', ...KA, '-t', 'vps', 'byobu']
)
same(
  'a whitespace-only command is no command',
  buildSshArgs(host({ command: '   ' })),
  ['-e', 'none', ...KA, 'vps']
)

/* ------------------------------------------------------------- the binary */

console.log('\nthe ssh binary')
const exe = sshExecutable()
console.log(`  using: ${exe}`)

let version = ''
try {
  // ssh writes -V to stderr and exits 255 on some builds, so take either stream.
  const r = await execFileAsync(exe, ['-V'], { encoding: 'utf8' }).catch(
    (e: { stdout?: string; stderr?: string }) => e
  )
  version = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
} catch (e) {
  version = e instanceof Error ? e.message : String(e)
}
check('it runs and reports a version', /OpenSSH/.test(version), version)

/* ------------------------------------------- the parser against real ssh */

console.log('\nthe parser agrees with ssh itself')

const dir = await mkdtemp(join(tmpdir(), 'stoke-ssh-'))
try {
  await mkdir(join(dir, 'conf.d'), { recursive: true })
  await mkdir(join(dir, 'cond.d'), { recursive: true })
  await writeFile(
    join(dir, 'conf.d', 'extra.conf'),
    'Host included-one\n    User inc1\n\nHost included-two\n    User inc2\n',
    'utf8'
  )
  // Not matched by the glob below, so it proves the glob filters rather than
  // sweeping in every file in the directory.
  await writeFile(join(dir, 'conf.d', 'notes.txt'), 'Host should-not-appear\n', 'utf8')
  await writeFile(
    join(dir, 'cond.d', 'cond.conf'),
    'Host conditional-one\n    User condituser\n',
    'utf8'
  )

  const fixture = join(dir, 'config')
  await writeFile(
    fixture,
    [
      '# a comment line',
      // Top level, so ssh always applies it. See the conditional one below.
      `Include ${join(dir, 'conf.d', '*.conf')}`,
      '',
      'Host plain',
      '    User plainuser',
      '',
      'Host web # prod',
      '    User webuser',
      '',
      'Host web#1',
      '    User hashuser',
      '',
      'Host=eq',
      '    User equser',
      '',
      'Host "two words"',
      '    User quoteduser',
      '',
      'Host multi-a multi-b',
      '    User multiuser',
      '',
      'Host !negated realone',
      '    User neguser',
      /*
       * An Include *inside* a Host block is conditional: ssh reads it only when
       * the enclosing block matches the host being resolved. The parser here
       * reads it unconditionally and that is deliberate — it is building a list
       * of every alias the user has defined anywhere, and an alias inside a
       * conditional include is still a real machine they can connect to. The
       * assertions below pin both halves so the divergence stays intentional.
       */
      `    Include ${join(dir, 'cond.d', 'cond.conf')}`,
      '',
      /*
       * The wildcard block goes last, which is both how real configs are written
       * and what makes this fixture test what it claims to. ssh keeps the *first*
       * value it obtains for an option, so a `Host *` block near the top sets
       * `user` for every alias and every specific block below it is ignored —
       * which is exactly how an earlier draft of this file "proved" that
       * included-one resolved to wilduser.
       */
      'Host *.wild web? *',
      '    User wilduser',
      ''
    ].join('\n'),
    'utf8'
  )

  await lockDown([
    { path: dir, dir: true },
    { path: join(dir, 'conf.d'), dir: true },
    { path: join(dir, 'cond.d'), dir: true },
    { path: fixture, dir: false },
    { path: join(dir, 'conf.d', 'extra.conf'), dir: false },
    { path: join(dir, 'conf.d', 'notes.txt'), dir: false },
    { path: join(dir, 'cond.d', 'cond.conf'), dir: false }
  ])

  const parsed = await readSshConfigHosts(fixture)
  console.log(`  parser: ${parsed.join(', ')}`)

  same(
    'every alias, in file order, includes the Included ones',
    parsed,
    [
      'included-one',
      'included-two',
      'plain',
      'web',
      'web#1',
      'eq',
      'two words',
      'multi-a',
      'multi-b',
      'realone',
      'conditional-one'
    ]
  )
  check(
    'a file the Include glob does not match is not read',
    !parsed.includes('should-not-appear'),
    ''
  )

  /*
   * Now the real check: ask ssh to resolve each alias against the same file.
   * A pattern the parser offers must produce the User its block sets — if ssh
   * fell through to the defaults, the parser invented an alias that cannot
   * connect.
   */
  const effective = async (alias: string): Promise<string> => {
    const { stdout } = await execFileAsync(exe, ['-F', fixture, '-G', '--', alias], {
      encoding: 'utf8',
      timeout: 15000
    })
    return (/^user (.*)$/m.exec(stdout)?.[1] ?? '').trim()
  }

  /*
   * OpenSSH 9 and later reject a hostname containing a space *before* resolving
   * anything: `ssh -G -- "two words"` exits non-zero with "hostname contains
   * invalid characters", which threw straight out of this suite on OpenSSH 10.2
   * and took `npm run build` — the step after it in the check chain — with it.
   *
   * That is a change in ssh, not a fault in the parser. `Host "two words"` is
   * still valid config syntax that a user can write, the parser must still
   * offer the alias, and the parse assertion above pins exactly that. Only the
   * live cross-check of it became impossible.
   *
   * So recognise the refusal from ssh's own message rather than testing a
   * version number — the boundary moved once and may move again — and print the
   * skip rather than quietly dropping a case. Any *other* failure still throws,
   * because it means something real broke.
   */
  const refusesAlias = (err: unknown): boolean =>
    /invalid characters/i.test(String((err as { stderr?: string })?.stderr ?? ''))

  /** Everything ssh said, on either stream, whether it exited zero or not. */
  const combinedOutput = async (argv: string[]): Promise<string> => {
    try {
      const { stdout, stderr } = await execFileAsync(exe, argv, {
        encoding: 'utf8',
        timeout: 15000
      })
      return `${stdout}${stderr}`
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      return `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  }

  const resolvedUser = async (alias: string): Promise<string | null> => {
    try {
      return await effective(alias)
    } catch (err) {
      if (refusesAlias(err)) return null
      throw err
    }
  }

  const WANT: Record<string, string> = {
    plain: 'plainuser',
    web: 'webuser',
    'web#1': 'hashuser',
    eq: 'equser',
    'two words': 'quoteduser',
    'multi-a': 'multiuser',
    'multi-b': 'multiuser',
    realone: 'neguser',
    'included-one': 'inc1',
    'included-two': 'inc2'
  }

  for (const [alias, want] of Object.entries(WANT)) {
    const got = await resolvedUser(alias)
    if (got === null) {
      console.log(
        `  SKIP  this ssh will not resolve ${JSON.stringify(alias)} at all; ` +
          'the parse assertion above is what still covers it'
      )
      continue
    }
    check(`ssh resolves ${JSON.stringify(alias)} to its own block`, got === want, `user=${got}`)
  }

  // The deliberate divergence, asserted rather than assumed: the parser offers
  // an alias out of a conditional Include, and ssh does not apply that Include
  // when resolving it, so the alias falls through to the wildcard block.
  check(
    'the parser offers an alias from a conditional Include',
    parsed.includes('conditional-one'),
    ''
  )
  check(
    'and ssh, correctly, does not read that Include for it',
    (await effective('conditional-one')) === 'wilduser',
    `user=${await effective('conditional-one')}`
  )

  // The mirror image: things the parser refused must genuinely not be hosts.
  // `prod` and `negated` appear in the file as text, and ssh must not match
  // either — if it did, the parser would be dropping a real alias.
  for (const ghost of ['prod', 'negated', 'should-not-appear']) {
    const got = await effective(ghost)
    const isGhost = !Object.values(WANT).includes(got)
    check(`${JSON.stringify(ghost)} is not a host ssh knows`, isGhost, `user=${got}`)
  }

  /*
   * And the argv itself, run through ssh's own parser. `-G` exits before
   * connecting, so this proves the shape is accepted — the -t flag, the
   * destination and a command with spaces all landing where intended — without
   * opening a connection to anything.
   */
  const shape = buildSshArgs(host({ alias: 'plain', command: 'tmux new -A -s stoke' }))
  const { stdout: shaped } = await execFileAsync(exe, ['-F', fixture, '-G', ...shape], {
    encoding: 'utf8',
    timeout: 15000
  })
  check(
    'ssh accepts the full argv shape and still resolves the host',
    /^user plainuser$/m.test(shaped),
    shape.join(' ')
  )

  /*
   * `buildSshArgs` inserts `--` so an alias starting with a dash reaches ssh as
   * a hostname rather than as options. Proving that needs care on a modern ssh.
   *
   * OpenSSH 9+ rejects `-weird` as a hostname outright, so the old assertion —
   * that `-G` prints `host -weird` — can no longer hold, and the non-zero exit
   * threw out of this suite. The two outcomes stay cleanly distinguishable
   * though, which is the entire point of the flag. Measured on OpenSSH 10.2:
   *
   *     with `--`     hostname contains invalid characters   (taken as a host)
   *     without `--`  Bad tun device 'eird'                  (parsed as -w eird)
   *
   * So assert the discrimination rather than one version's stdout: ssh must
   * treat it as a host — an older ssh by resolving it, a newer one by rejecting
   * the hostname — and must never have read it as the `-w` option. Both halves
   * are required, so a `buildSshArgs` that dropped the `--` still fails here.
   */
  const dashed = buildSshArgs(host({ alias: '-weird' }))
  const dashOut = await combinedOutput(['-F', fixture, '-G', ...dashed])
  check(
    '-- stops ssh reading a leading-dash alias as options',
    (/^host -weird$/m.test(dashOut) || /hostname contains invalid characters/i.test(dashOut)) &&
      !/tun device/i.test(dashOut),
    dashed.join(' ')
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}

/* --------------------------------- key login: the probe and the config block */

/*
 * What sets `keyEnrolled` has to ask what the TAB will do, so its argv must
 * look like the tab's: no `-i`, no `IdentitiesOnly`. The first version probed
 * with both and passed for a key plain ssh never offers.
 */
console.log('\nkey login: the login probe and the IdentityFile block')

{
  const probe = buildLoginProbeArgs(host({}))
  check('the login probe is built for a plain alias', probe !== null, '')
  if (probe) {
    check('it carries no -i: the tab offers what the config offers', !probe.includes('-i'), probe.join(' '))
    check(
      'and no IdentitiesOnly, which would narrow it to one key',
      !probe.some((a) => /IdentitiesOnly/i.test(a)),
      probe.join(' ')
    )
    for (const opt of ['BatchMode=yes', 'PreferredAuthentications=publickey', 'ControlPath=none']) {
      check(`${opt}, before the destination`, probe.indexOf(opt) > 0 && probe.indexOf(opt) < probe.indexOf('vps'), probe.join(' '))
    }
    check('-e none before the destination (gotcha 29)', probe.indexOf('-e') < probe.indexOf('vps') && probe[probe.indexOf('-e') + 1] === 'none', probe.join(' '))
    same('the alias then `exit`, last', probe.slice(-2), ['vps', 'exit'])
  }
  same('a leading-dash alias gets no probe at all', buildLoginProbeArgs(host({ alias: '-oProxyCommand=x' })), null)
}

{
  /*
   * The claim that makes APPENDING safe: `IdentityFile` accumulates across
   * matching blocks, so a block at the end adds a key and overrides nothing.
   * A claim about ssh, so ssh is asked — `-G` against a fixture, no connection.
   */
  const kdir = await mkdtemp(join(tmpdir(), 'stoke-ssh-key-'))
  const combinedOutput = async (argv: string[]): Promise<string> => {
    try {
      const { stdout, stderr } = await execFileAsync(sshExecutable(), argv, { encoding: 'utf8', timeout: 15000 })
      return `${stdout}${stderr}`
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      return `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  }
  try {
    const key = join(kdir, 'stoke_ed25519')
    const base = ['Host *', '  IdentityFile ~/.ssh/work_key', '  IdentitiesOnly yes', ''].join('\n')
    const block = buildIdentityBlock('vps', key)
    const bare = buildIdentityBlock('v@203.0.113.9', key)
    check('a block is built for a plain alias', block !== null, '')
    check('and for user@host, as a Host line for the host part', bare !== null && bare.includes('\nHost 203.0.113.9\n'), bare ?? 'null')
    if (block && bare) {
      const fixture = join(kdir, 'config')
      await writeFile(fixture, appendIdentityBlock(appendIdentityBlock(base, block), bare), 'utf8')
      const out = await combinedOutput(['-F', fixture, '-G', 'vps'])
      const files = identityFilesFromSshG(out)
      check('ssh -G still lists the key the config already named', files.some((f) => f.endsWith('work_key')), files.join(', '))
      check('and now lists the appended one too — IdentityFile accumulates', files.includes(key), files.join(', '))
      const outBare = await combinedOutput(['-F', fixture, '-G', 'v@203.0.113.9'])
      check('a user@host alias picks up its Host-part block', identityFilesFromSshG(outBare).includes(key), identityFilesFromSshG(outBare).join(', '))
      const other = identityFilesFromSshG(await combinedOutput(['-F', fixture, '-G', 'some-other-host']))
      check('and a host the block does not name is untouched', !other.includes(key), other.join(', '))
    }
  } finally {
    await rm(kdir, { recursive: true, force: true })
  }
}

/* ------------------------------------------- fetching a remote transcript */

/*
 * A remote session's `claude` runs on the far machine and writes its JSONL
 * there, which is why the context meter and the worklog have never worked for
 * one. This fetch is what closes that, and the command it builds is executed by
 * somebody else's login shell — so what may be interpolated into it is a
 * security property, not a detail.
 */
console.log('\nthe remote transcript command')

const cmd = buildTranscriptCommand()
check('it globs every transcript when no id is known', cmd.includes('/*/*.jsonl'), cmd)
check('it takes the newest', cmd.includes('ls -1t') && cmd.includes('head -n 1'), cmd)
check('it prints the path first, so the user can see which one was read', cmd.includes("printf '%s\\n'"), cmd)
check('it bounds the transfer', cmd.includes(`tail -c ${MAX_REMOTE_TRANSCRIPT_BYTES}`), cmd)
check(
  'a machine that has never run Claude is silence, not an error',
  cmd.includes('2>/dev/null') && cmd.includes('if [ -n "$f" ]'),
  cmd
)
check('it reads and nothing else', !/\b(rm|mv|cp|chmod|curl|wget|dd|>)\b/.test(cmd), cmd)

/*
 * The user's own connect command is deliberately left alone. Passing
 * --session-id to the remote claude would correlate the session exactly, but a
 * remote CLI old enough not to know the flag would exit with an unknown-option
 * error and break the terminal itself on every connection to that host.
 */
const remoteHost: SshHost = { id: 'h1', label: 'Work box', alias: 'work', command: 'tmux new -A -s stoke' }
const fetchArgs = buildTranscriptArgs(remoteHost)
check('the fetch never allocates a tty, which would corrupt the JSONL', !fetchArgs.includes('-t'), fetchArgs.join(' '))
check('it fails fast rather than hanging on a passphrase prompt', fetchArgs.includes('BatchMode=yes'), fetchArgs.join(' '))
check("it does not carry the user's own connect command", !fetchArgs.some((a) => a.includes('tmux')), fetchArgs.join(' '))
check('and never asks the remote claude for a session id', !fetchArgs.some((a) => a.includes('--session-id')), fetchArgs.join(' '))
same(
  'an alias starting with a dash is still not read as an option',
  buildTranscriptArgs({ ...remoteHost, alias: '-oProxyCommand=x' }).includes('--'),
  true
)

/*
 * Run the thing, rather than pattern-match the string it is.
 *
 * Every assertion above is about what the command *says*; none of them would
 * notice a quoting mistake that makes a real `sh` behave differently — and the
 * only shell that ever runs this is somebody else's, over a link, where a
 * mistake reads as "no transcript found". So the command is executed here
 * against a fixture home, exactly as the remote login shell would.
 */
console.log('\nthe command, run by a real shell')

const shell = process.platform === 'win32' ? 'sh.exe' : 'sh'
const fixtureHome = await mkdtemp(join(tmpdir(), 'stoke-home-'))
await mkdir(join(fixtureHome, '.claude', 'projects', 'proj-a'), { recursive: true })
await mkdir(join(fixtureHome, '.claude', 'projects', 'proj-b'), { recursive: true })
await writeFile(join(fixtureHome, '.claude', 'projects', 'proj-a', 'older.jsonl'), '{"type":"user","cwd":"/srv/old"}\n')
// A second apart, because the whole selection rule is "newest wins" and two
// files written in the same millisecond do not test it.
await new Promise((r) => setTimeout(r, 1100))
await writeFile(
  join(fixtureHome, '.claude', 'projects', 'proj-b', 'newer.jsonl'),
  '{"type":"user","cwd":"/srv/api"}\n{"type":"assistant"}\n'
)

const runInShell = async (home: string): Promise<{ out: string; code: number } | null> => {
  try {
    const { stdout } = await execFileAsync(shell, ['-c', buildTranscriptCommand()], {
      env: { ...process.env, HOME: home },
      maxBuffer: 8 * 1024 * 1024
    })
    return { out: stdout, code: 0 }
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    // No POSIX shell on this machine — the assertions below cannot run, and
    // pretending they passed would be worse than saying so.
    if (typeof e.code !== 'number') return null
    return { out: e.stdout ?? '', code: e.code }
  }
}

const ran = await runInShell(fixtureHome)
if (!ran) {
  console.log(`  SKIP  no \`${shell}\` on this machine, so the command was not executed`)
} else {
  const parsed = splitTranscriptOutput(ran.out)
  check('a real shell produces a readable answer', !!parsed, JSON.stringify(ran.out.slice(0, 80)))
  check(
    'and it picked the newest transcript, not just any',
    parsed?.path.endsWith('newer.jsonl') === true,
    parsed?.path ?? '(none)'
  )
  same(
    'the transcript came back whole',
    parsed?.jsonl,
    '{"type":"user","cwd":"/srv/api"}\n{"type":"assistant"}\n'
  )

  const bare = await mkdtemp(join(tmpdir(), 'stoke-bare-'))
  const empty = await runInShell(bare)
  same('a machine that has never run Claude prints nothing', empty?.out, '')
  same('and exits cleanly rather than looking like a broken link', empty?.code, 0)
  await rm(bare, { recursive: true, force: true })
}
await rm(fixtureHome, { recursive: true, force: true })

console.log('\nwhat may reach the remote shell')

check('a plain uuid is accepted', isSafeSessionId('0b9c1a2d-3e4f-5678-9abc-def012345678'), '')
for (const nasty of [
  '../../etc/passwd',
  'a; rm -rf ~',
  'a$(id)',
  'a`id`',
  'a b',
  'a|b',
  "a'b",
  'a*',
  '',
  'sh'
]) {
  check(`refused: ${JSON.stringify(nasty)}`, !isSafeSessionId(nasty), '')
}
check(
  'and an id that was refused never reaches the command',
  buildTranscriptCommand('a; rm -rf ~').includes('/*/*.jsonl') &&
    !buildTranscriptCommand('a; rm -rf ~').includes('rm -rf'),
  buildTranscriptCommand('a; rm -rf ~')
)
check(
  'a trustworthy id narrows the glob to exactly it',
  buildTranscriptCommand('0b9c1a2d-3e4f-5678-9abc-def012345678').includes(
    '/*/0b9c1a2d-3e4f-5678-9abc-def012345678.jsonl'
  ),
  ''
)

console.log('\nreading what came back')

const body = '{"type":"user"}\n{"type":"assistant"}\n'
same('the path is taken off the first line', splitTranscriptOutput(`/home/v/.claude/projects/x/y.jsonl\n${body}`)?.path, '/home/v/.claude/projects/x/y.jsonl')
same('and the rest is the transcript', splitTranscriptOutput(`/home/v/x.jsonl\n${body}`)?.jsonl, body)
same('no output at all is not a transcript', splitTranscriptOutput(''), null)
same('neither is a path with nothing after it', splitTranscriptOutput('/home/v/x.jsonl'), null)

/*
 * `tail -c` cuts at a byte, so a capped fetch starts mid-record. The parsers
 * would drop the fragment anyway — but a fragment that happens to parse is an
 * invented turn, which is worse than a missing one.
 */
const truncated = splitTranscriptOutput(`/home/v/x.jsonl\nype":"user"}\n{"type":"assistant"}\n`, 20)
same('a half record at the cut is dropped', truncated?.jsonl, '{"type":"assistant"}\n')
same(
  'an uncapped fetch keeps its first line',
  splitTranscriptOutput(`/home/v/x.jsonl\n${body}`, 10_000)?.jsonl,
  body
)

console.log('\ncaching it locally')

const cacheDir = await mkdtemp(join(tmpdir(), 'stoke-ssh-'))
const fetched = await fetchRemoteTranscript(remoteHost, 'sess-1', cacheDir, {
  run: async () => `/home/v/.claude/projects/proj/abc.jsonl\n${body}`
})
check('the fetch produced a local file', !!fetched?.file, fetched?.file ?? '(none)')
same('and reports where it came from', fetched?.remotePath, '/home/v/.claude/projects/proj/abc.jsonl')
same('the cached bytes are the transcript', (await import('node:fs')).readFileSync(fetched!.file, 'utf8'), body)
same('the first fetch counts as a change', fetched?.changed, true)

/*
 * The one that would have killed the feature silently.
 *
 * Everything that reads a transcript decides "has anything happened?" from the
 * file's mtime — the meter re-parses on it, and auto-scan measures how long a
 * session has been *quiet* from it. Rewriting an identical cache on every poll
 * moves that mtime forward every 30 seconds forever, so a remote session would
 * never once look idle and would never be scanned. It would look like it worked.
 */
const { statSync } = await import('node:fs')
const mtimeBefore = statSync(fetched!.file).mtimeMs
await new Promise((r) => setTimeout(r, 1100))
const again = await fetchRemoteTranscript(remoteHost, 'sess-1', cacheDir, {
  run: async () => `/home/v/.claude/projects/proj/abc.jsonl\n${body}`
})
same('an unchanged transcript is reported as unchanged', again?.changed, false)
same(
  'and the cache is not touched, so the session can still go quiet',
  statSync(again!.file).mtimeMs,
  mtimeBefore
)

const moved = await fetchRemoteTranscript(remoteHost, 'sess-1', cacheDir, {
  run: async () => `/home/v/.claude/projects/proj/abc.jsonl\n${body}{"type":"user"}\n`
})
same('but real new output is written', moved?.changed, true)
check('and moves the clock on', statSync(moved!.file).mtimeMs > mtimeBefore, '')

/*
 * Every one of these is ordinary for a background poll against a machine that
 * is asleep, locked, or has simply never run Claude. None may throw: a poll that
 * raises turns a quiet nothing into an error the user has to dismiss.
 */
same(
  'a host that cannot be reached is null, not a throw',
  await fetchRemoteTranscript(remoteHost, 's', cacheDir, {
    run: async () => {
      throw new Error('ssh: connect to host work port 22: Connection refused')
    }
  }),
  null
)
same(
  'a machine with no transcripts is null too',
  await fetchRemoteTranscript(remoteHost, 's', cacheDir, { run: async () => '' }),
  null
)
same(
  'and so is a path with an empty transcript behind it',
  await fetchRemoteTranscript(remoteHost, 's', cacheDir, { run: async () => '/home/v/x.jsonl\n\n' }),
  null
)
await rm(cacheDir, { recursive: true, force: true })

/* ------------------------------------------- the managed remote session */

/*
 * Gotcha 126. A host with `persist: 'tmux'` runs each tab inside its own tmux
 * session on a private socket, so the shell survives a dropped link, sleep and
 * a Stoke restart. Everything that reaches the far machine's shell is built
 * from a whitelisted name and a whitelisted command — refused, never escaped —
 * and the command is then RUN here by every login shell this machine has,
 * against a fake `tmux` that records its argv, so the claims about quoting are
 * a shell's word rather than a regex's.
 */
console.log('\nthe managed session: names')

{
  const minted = mintRemoteSessionName()
  check('a minted name is stoke- and 8 hex', /^stoke-[0-9a-f]{8}$/.test(minted), minted)
  check('and passes its own whitelist', isSafeRemoteSessionName(minted), minted)
  same('minting reads the bytes it is given', mintRemoteSessionName(new Uint8Array([0, 0xab, 0x0c, 0xff])), 'stoke-00ab0cff')
  check('two mints differ', mintRemoteSessionName() !== mintRemoteSessionName(), '')
  for (const bad of ['', '-x', 'a.b', 'a:b', 'a b', 'a;b', "a'b", 'a$(id)', 'a`id`', '../x', 'x'.repeat(65), 'é']) {
    check(`refused as a name: ${JSON.stringify(bad)}`, !isSafeRemoteSessionName(bad), '')
  }
  check('a non-string is no name', !isSafeRemoteSessionName(undefined) && !isSafeRemoteSessionName(42), '')
}

console.log('\nthe managed session: which commands may run inside one')

{
  for (const ok of ['', 'claude', 'cd /srv/app && claude --model opus', 'htop', '~/bin/x | tee -a log.txt', 'a; b', 'make -j4 test > out 2>&1']) {
    check(`accepted: ${JSON.stringify(ok)}`, isPersistableCommand(ok) && persistRefusal(ok) === null, '')
  }
  for (const bad of [
    "echo 'x'",
    'echo "x"',
    'echo $HOME',
    'echo `id`',
    'echo \\x',
    'echo !!',
    'a\nb',
    'a\tb',
    '-l',
    'echo x;',
    'byobu\u0007'
  ]) {
    check(`refused: ${JSON.stringify(bad)}`, !isPersistableCommand(bad) && persistRefusal(bad) !== null, '')
  }
}

console.log('\nthe managed session: the command')

const kept = (p: Partial<SshHost>): SshHost => host({ persist: 'tmux', ...p })
{
  same('a refused name builds nothing', buildPersistentCommand(kept({}), 'a;rm -rf ~'), null)
  same('a refused command builds nothing', buildPersistentCommand(kept({ command: 'echo $HOME' }), 'stoke-00000001'), null)
  const cmd = buildPersistentCommand(kept({}), 'stoke-00000001') ?? ''
  check('it is one sh -c with a single-quoted body', /^sh -c '[^']*'$/.test(cmd), cmd)
  check('on the private socket with no config file', cmd.includes('tmux -u -L stoke -f /dev/null start-server'), cmd)
  check('status bar and tmux mouse off', cmd.includes('set -g status off') && cmd.includes('set -g mouse off'), cmd)
  /*
   * `-f /dev/null` skips the user's config, not tmux's built-in C-b: C-b d
   * detached with exit 0 (the tab closed as "the shell ended"), C-b c added a
   * window, C-b [ opened copy mode (gotcha 126, measured on 3.5a and 3.4).
   */
  check(
    'no prefix key: C-b and every key after it reach the pane',
    cmd.includes('set -g prefix None') && cmd.includes('set -g prefix2 None') && cmd.indexOf('set -g prefix None') < cmd.indexOf('new-session'),
    cmd
  )
  /*
   * And never `unbind -a`: after its first run the prefix table no longer
   * exists, so every later run — each reconnect, each second tab — errors
   * "table prefix doesn't exist" and tmux skips the rest of the sequence,
   * `new-session` included; `-q` only makes that abort silent (exit 0).
   */
  check('no unbind, which aborts every later attach', !/\bunbind(-key)?\b/.test(cmd), cmd)
  check(
    'terminal-overrides REPLACED with -s, never grown with -ga on every reconnect',
    cmd.includes(`set -s terminal-overrides "${MANAGED_TERMINAL_OVERRIDES}"`) && !cmd.includes('-ga'),
    cmd
  )
  check('attach-or-create by exactly that name', cmd.includes('new-session -A -s stoke-00000001'), cmd)
  check(
    'the history is printed before the attach',
    cmd.indexOf('capture-pane') > -1 && cmd.indexOf('capture-pane') < cmd.indexOf('exec tmux'),
    cmd
  )
  check('the user command is not there when there is none', !/new-session -A -s stoke-00000001 "/.test(cmd), cmd)
  const withCmd = buildPersistentCommand(kept({ command: '  cd /srv && claude --model opus  ' }), 'stoke-00000001') ?? ''
  check(
    'the user command is embedded verbatim, never with a flag added (gotcha 19)',
    withCmd.includes('new-session -A -s stoke-00000001 "cd /srv && claude --model opus"') && !withCmd.includes('--session-id'),
    withCmd
  )
}

console.log('\nthe managed session: the argv')

{
  same('a host that does not persist is the plain argv', sshHostArgs(host({ command: 'byobu' }), 'stoke-00000001'), {
    ok: true,
    args: buildSshArgs(host({ command: 'byobu' }))
  })
  const noName = sshHostArgs(kept({}), undefined)
  check('a kept host with no name is refused, not connected unkept', !noName.ok, JSON.stringify(noName))
  const badName = sshHostArgs(kept({}), 'x;y')
  check('so is one with a name that fails the whitelist', !badName.ok, JSON.stringify(badName))
  const badCmd = sshHostArgs(kept({ command: 'echo "$HOME"' }), 'stoke-00000001')
  check(
    'and one whose command cannot be wrapped, with the sentence Settings shows',
    !badCmd.ok && badCmd.message === persistRefusal('echo "$HOME"'),
    JSON.stringify(badCmd)
  )
  const plan = sshHostArgs(kept({}), 'stoke-00000001')
  check('a kept host with a good name connects', plan.ok, JSON.stringify(plan))
  if (plan.ok) {
    const at = plan.args.indexOf('vps')
    check('-t, since there is now always a command', plan.args.includes('-t') && plan.args.indexOf('-t') < at, plan.args.join(' '))
    check('the command is the last argument, whole', plan.args.length === at + 2 && plan.args[at + 1].startsWith("sh -c '"), plan.args.join(' '))
    for (const opt of ['ServerAliveInterval=15', 'ServerAliveCountMax=3']) {
      const i = plan.args.indexOf(opt)
      check(`${opt} is a -o option before the destination`, i > 0 && plan.args[i - 1] === '-o' && i < at, plan.args.join(' '))
    }
    check('-e none still first (gotcha 29)', plan.args[0] === '-e' && plan.args[1] === 'none', plan.args.join(' '))

    /*
     * ssh's own parser, with no connection: `-G` prints the resolved options.
     * If the keepalives were anywhere but before the destination they would be
     * part of the remote command and `-G` would report ssh's defaults (0).
     */
    // An empty config of our own rather than /dev/null, which Windows lacks.
    const emptyDir = await mkdtemp(join(tmpdir(), 'stoke-ssh-empty-'))
    const empty = join(emptyDir, 'config')
    await writeFile(empty, '')
    await lockDown([
      { path: emptyDir, dir: true },
      { path: empty, dir: false }
    ])
    const g = await execFileAsync(exe, ['-F', empty, '-G', ...plan.args], { encoding: 'utf8', timeout: 15000 }).catch(
      (e: { stdout?: string }) => ({ stdout: e.stdout ?? '' })
    )
    await rm(emptyDir, { recursive: true, force: true })
    check('ssh -G reads serveraliveinterval 15', /^serveraliveinterval 15$/m.test(g.stdout), '')
    check('and serveralivecountmax 3', /^serveralivecountmax 3$/m.test(g.stdout), '')
  }
}

console.log('\nthe managed session: run by real login shells against a fake tmux')

{
  /*
   * The far machine runs `$SHELL -c '<remote command>'`. Reproduced here for
   * every login shell present: bin/ holds a fake `tmux` that logs each argv
   * element on its own line and exits, and a link to `sh`; bare/ holds only
   * the `sh` link, for the no-tmux fallback. `SHELL` is a fake too, so the
   * fallback's `exec "$SHELL" -l` is observable and runs nothing real.
   */
  const root = await mkdtemp(join(tmpdir(), 'stoke-managed-'))
  const bin = join(root, 'bin')
  const bare = join(root, 'bare')
  await mkdir(bin)
  await mkdir(bare)
  const log = join(root, 'tmux.log')
  const shellLog = join(root, 'shell.log')
  const posixSh = existsSync('/bin/sh') ? '/bin/sh' : null
  if (!posixSh || process.platform === 'win32') {
    console.log('  SKIP  no /bin/sh here (Windows), so the remote command was not run')
  } else {
    await writeFile(
      join(bin, 'tmux'),
      [
        '#!/bin/sh',
        `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done`,
        `printf '%s\\n' '--end--' >> '${log}'`,
        'case "$*" in',
        '  *display*) printf "%s\\n" "${FAKE_HISTORY-5}";;',
        '  *capture-pane*) printf "%s\\n" "HISTORY-LINE";;',
        '  *) printf "%s\\n" "ATTACHED";;',
        'esac'
      ].join('\n')
    )
    await chmod(join(bin, 'tmux'), 0o755)
    // `stty size` as the far pty would answer it: "rows cols", or a failure
    // (no tty) when FAKE_ROWS is unset — which is what execFile gives anyway.
    await writeFile(
      join(bin, 'stty'),
      ['#!/bin/sh', '[ -n "$FAKE_ROWS" ] || exit 1', 'printf "%s 120\\n" "$FAKE_ROWS"'].join('\n')
    )
    await chmod(join(bin, 'stty'), 0o755)
    await symlink(posixSh, join(bin, 'sh'))
    await symlink(posixSh, join(bare, 'sh'))
    const fakeShell = join(root, 'fake-login-shell')
    await writeFile(fakeShell, ['#!/bin/sh', `printf '%s\\n' "$*" >> '${shellLog}'`, 'echo FALLBACK-SHELL'].join('\n'))
    await chmod(fakeShell, 0o755)

    const name = 'stoke-0badc0de'
    const userCmd = 'cd /srv && touch PWNED-BY-LOGIN-SHELL; claude --model opus | tee out.log'
    const remote = buildPersistentCommand(kept({ command: userCmd }), name) ?? ''
    const plain = buildPersistentCommand(kept({}), name) ?? ''
    const wantTmux = [
      '-u', '-L', 'stoke', '-f', '/dev/null', 'start-server', ';',
      'set', '-s', 'escape-time', '10', ';',
      'set', '-s', 'set-clipboard', 'on', ';',
      'set', '-s', 'terminal-overrides', MANAGED_TERMINAL_OVERRIDES, ';',
      'set', '-g', 'status', 'off', ';',
      'set', '-g', 'mouse', 'off', ';',
      'set', '-g', 'prefix', 'None', ';',
      'set', '-g', 'prefix2', 'None', ';',
      'set', '-g', 'history-limit', String(MANAGED_HISTORY_LIMIT), ';',
      'new-session', '-A', '-s', name
    ]
    const wantAsk = ['-L', 'stoke', 'display', '-p', '-t', `=${name}:`, '#{history_size} #{pane_height} #{cursor_y}']
    const capture = (end: string): string[] => ['-L', 'stoke', 'capture-pane', '-p', '-e', '-J', '-S', '-', '-E', end, '-t', `=${name}:`]
    const wantCapture = capture('-1')

    const run = async (
      login: string,
      command: string,
      path: string,
      history = '5 36 35',
      rows = ''
    ): Promise<{ out: string; calls: string[][]; shell: string }> => {
      await rm(log, { force: true })
      await rm(shellLog, { force: true })
      const cwd = await mkdtemp(join(root, 'cwd-'))
      const r = await execFileAsync(login, ['-c', command], {
        cwd,
        env: { PATH: path, SHELL: fakeShell, HOME: root, FAKE_HISTORY: history, ...(rows ? { FAKE_ROWS: rows } : {}) },
        encoding: 'utf8',
        timeout: 15000
      }).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '' }))
      const text = existsSync(log) ? await readFile(log, 'utf8') : ''
      const calls = text
        .split('--end--\n')
        .filter((c) => c.length)
        .map((c) => c.replace(/\n$/, '').split('\n'))
      const pwned = existsSync(join(cwd, 'PWNED-BY-LOGIN-SHELL'))
      return {
        out: `${r.stdout}${(r as { stderr?: string }).stderr ?? ''}${pwned ? 'PWNED' : ''}`,
        calls,
        shell: existsSync(shellLog) ? await readFile(shellLog, 'utf8') : ''
      }
    }

    const logins = ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh', '/bin/tcsh', '/usr/bin/fish', '/opt/homebrew/bin/fish']
    let ran = 0
    for (const login of logins) {
      if (!existsSync(login)) {
        console.log(`  SKIP  no ${login} on this machine`)
        continue
      }
      ran++
      const a = await run(login, remote, bin)
      same(`${login}: first, how much history that one session has`, a.calls[0], wantAsk)
      same(`${login}: then the history itself, of exactly that session`, a.calls[1], wantCapture)
      same(`${login}: then tmux gets every option as its own argument, and the command as ONE`, a.calls[2], [...wantTmux, userCmd])
      check(`${login}: history printed before the attach`, a.out.indexOf('HISTORY-LINE') > -1 && a.out.indexOf('HISTORY-LINE') < a.out.indexOf('ATTACHED'), JSON.stringify(a.out))
      check(`${login}: nothing in the user's command ran in the login shell`, !a.out.includes('PWNED'), JSON.stringify(a.out))
      /*
       * No history (a session whose output never scrolled, or none yet): no
       * capture at all. tmux clamps `-E -1` to the screen's first line when
       * there is no history, so capturing anyway printed that line and the
       * attach drew it again — measured in the app, fixed here.
       */
      const steps = (calls: string[][]): string[] =>
        calls.map((c) => (c.includes('capture-pane') ? 'capture' : c.includes('display') ? 'ask' : c.includes('new-session') ? 'attach' : '?'))
      for (const none of ['0 36 35', '0 36 4', '', 'no server running on /tmp/tmux-1000/stoke']) {
        const e = await run(login, remote, bin, none)
        same(`${login}: history ${JSON.stringify(none)} captures nothing, and still attaches`, steps(e.calls), ['ask', 'attach'])
      }
      /*
       * The attach resizes the pane to this pty, so the seam moves; the
       * capture follows tmux's own `screen_resize_y` rule (FAKE_HISTORY is
       * "history_size pane_height cursor_y", FAKE_ROWS the pty's rows):
       * shrinking drops blank rows under the cursor first and pushes
       * `cursor_y + 1 - rows` into history; growing pulls up to
       * `rows - pane_height` back out of it.
       */
      const endOf = async (history: string, rows: string): Promise<string | null> =>
        (await run(login, remote, bin, history, rows)).calls.find((c) => c.includes('capture-pane'))?.[9] ?? null
      same(`${login}: shorter, cursor at the bottom: the 6 pushed rows too`, await endOf('5 36 35', '30'), '5')
      same(`${login}: the same with no history yet`, await endOf('0 36 35', '30'), '5')
      same(`${login}: shorter, cursor near the top: blank rows go, nothing is pushed`, await endOf('5 36 4', '30'), '-1')
      same(`${login}: shorter, cursor near the top, no history: nothing at all`, await endOf('0 36 4', '30'), null)
      same(`${login}: shorter by more than the blank rows: only the overflow`, await endOf('5 36 32', '30'), '2')
      same(`${login}: taller: the lines tmux pulls back are left out`, await endOf('5 36 35', '40'), '-5')
      same(`${login}: taller by more than the history: nothing left to print`, await endOf('3 36 35', '44'), null)
      same(`${login}: the same size, or no tty: history only`, [await endOf('5 36 35', '36'), await endOf('5 36 35', '')], ['-1', '-1'])
      const b = await run(login, plain, bin)
      same(`${login}: with no command the session runs the default shell`, b.calls[2], wantTmux)
      const c = await run(login, plain, bare)
      check(`${login}: no tmux — the notice, then the login shell`, c.out.includes(NO_TMUX_NOTICE) && c.out.includes('FALLBACK-SHELL'), JSON.stringify(c.out))
      same(`${login}: the fallback shell is a login shell`, c.shell.trim(), '-l')
      const d = await run(login, remote, bare)
      same(`${login}: no tmux with a command — the command, as the plain tab ran it`, d.shell.trim(), `-c ${userCmd}`)
    }
    check('at least sh and bash ran it', ran >= 2, `${ran} shells`)

    /*
     * The listing and the kill, through the same fake: the format must reach
     * tmux as one argument with its `#{…}` intact (unquoted, `#` starts a
     * comment), and the kill must target exactly one name on Stoke's socket.
     */
    const listArgs = buildRemoteSessionListArgs(kept({})) ?? []
    const listCmd = listArgs[listArgs.length - 1] ?? ''
    const l = await run('/bin/sh', listCmd, bin)
    same('the listing asks tmux exactly this', l.calls[0], ['-L', 'stoke', 'ls', '-F', REMOTE_SESSION_FORMAT])
    const killArgs = buildRemoteSessionKillArgs(kept({}), name) ?? []
    const k = await run('/bin/sh', killArgs[killArgs.length - 1] ?? '', bin)
    same('the kill asks tmux exactly this', k.calls[0], ['-L', 'stoke', 'kill-session', '-t', `=${name}`])
  }
  await rm(root, { recursive: true, force: true })
}

console.log('\nthe managed session: listing and ending them')

{
  const listArgs = buildRemoteSessionListArgs(kept({})) ?? []
  const at = listArgs.indexOf('vps')
  for (const opt of ['BatchMode=yes', 'ControlPath=none', 'ConnectTimeout=10']) {
    check(`the listing: ${opt} before the destination`, listArgs.indexOf(opt) > -1 && listArgs.indexOf(opt) < at, listArgs.join(' '))
  }
  check('the listing never allocates a tty', !listArgs.includes('-t'), listArgs.join(' '))
  same('a leading-dash alias lists nothing', buildRemoteSessionListArgs(kept({ alias: '-oProxyCommand=x' })), null)
  same('and a bad name is never sent to kill', buildRemoteSessionKillArgs(kept({}), 'a;b'), null)

  const rows = [
    'stoke-00000001|1790748224|1|bash|/home/v',
    'stoke-00000002|1790748300|0|claude|/srv/a|b',
    'evil;rm -rf ~|1|0|sh|/',
    '',
    'stoke-00000003|nope|x|htop|'
  ].join('\n')
  const parsed = parseRemoteSessionList(rows)
  same('rows parse newest first, a hostile name dropped', parsed.map((s) => s.name), ['stoke-00000002', 'stoke-00000001', 'stoke-00000003'])
  same('activity is kept in ms', parsed[0].activity, 1790748300 * 1000)
  same('a path holding | is rejoined', parsed[0].path, '/srv/a|b')
  same('attached is a count', [parsed[1].attached, parsed[0].attached], [1, 0])
  same('an unreadable number is null / 0, not NaN', [parsed[2].activity, parsed[2].attached], [null, 0])

  const fake = (r: Partial<RunResult>) => async (): Promise<RunResult> => ({ stdout: '', stderr: '', code: 0, error: '', ...r })
  same('no sessions (or no tmux) is an empty list', await listRemoteSessions(kept({}), fake({})), { ok: true, sessions: [] })
  same(
    'ssh failing says ssh’s own last line',
    await listRemoteSessions(kept({}), fake({ code: 255, stderr: 'banner\nv@vps: Permission denied (publickey,password).\n' })),
    { ok: false, message: 'v@vps: Permission denied (publickey,password).' }
  )
  same('a timeout says so', await listRemoteSessions(kept({}), fake({ code: null, error: 'No answer within 20 s.' })), {
    ok: false,
    message: 'No answer within 20 s.'
  })
  same('ending a session that is already gone is done', await endRemoteSession(kept({}), 'stoke-00000001', fake({ code: 1, stderr: "can't find session: =stoke-00000001" })), { ok: true, message: '' })
  same('ending with a bad name never runs ssh', (await endRemoteSession(kept({}), 'x;y', async () => { throw new Error('ran') })).ok, false)
}

/* ------------------------------------------------- an image sent to the machine */

console.log('\nan image sent to the machine: the argv')

{
  const args = buildUploadArgs(host({}), 'pasted-image-20261002-143005-a1b2c3.png', 1234) ?? []
  const at = args.indexOf('vps')
  for (const opt of ['-T', 'BatchMode=yes', 'ConnectTimeout=10', 'ControlMaster=no', 'RemoteCommand=none']) {
    check(`the upload: ${opt} before the destination`, args.indexOf(opt) > -1 && args.indexOf(opt) < at, args.join(' '))
  }
  check('-e none before the destination (gotcha 29)', args.indexOf('-e') > -1 && args[args.indexOf('-e') + 1] === 'none' && args.indexOf('-e') < at, args.join(' '))
  // A user's own master may answer for a password host; Stoke never becomes one.
  check('no ControlPath=none: a master the user runs may answer', !args.includes('ControlPath=none'), args.join(' '))
  check('never a pty, which would rewrite the bytes', !args.includes('-t'), args.join(' '))
  check('the destination is followed by exactly one command', at === args.length - 2, args.join(' '))
  const cmd = args[args.length - 1] ?? ''
  check('the command is one sh -c with no quote inside', cmd.startsWith("sh -c '") && cmd.endsWith("'") && !cmd.slice(7, -1).includes("'"), cmd.slice(0, 40))
  check('the size is in the body', cmd.includes('[ $n -eq 1234 ]'), '')
  // A file copy, not a session: what scp sets for its own ssh (scp.c's do_cmd).
  for (const opt of ['ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ForwardAgent=no']) {
    const i = args.indexOf(opt)
    check(`the upload: ${opt} is a -o before the destination`, i > 0 && args[i - 1] === '-o' && i < at, args.join(' '))
  }
  check('the upload: -x (no X11) before the destination', args.indexOf('-x') > -1 && args.indexOf('-x') < at, args.join(' '))
  /*
   * ssh's own parser over a config that sets every one of those the other way,
   * the shape of a real dev host: a LocalForward with ExitOnForwardFailure (with
   * the tab holding the port, every image failed "Could not request local
   * forwarding."), a LocalCommand (it ran once per image), agent and X11
   * forwarding, RequestTTY force and a RemoteCommand. `-G` resolves without
   * connecting.
   */
  {
    const dir = await mkdtemp(join(tmpdir(), 'stoke-upload-g-'))
    const cfg = join(dir, 'config')
    await writeFile(
      cfg,
      [
        'Host vps',
        '  HostName 127.0.0.1',
        '  LocalForward 127.0.0.1:23999 127.0.0.1:22',
        '  RemoteForward 23998 127.0.0.1:22',
        '  DynamicForward 23997',
        '  ExitOnForwardFailure yes',
        '  PermitLocalCommand yes',
        '  LocalCommand echo ran',
        '  ForwardAgent yes',
        '  ForwardX11 yes',
        '  RequestTTY force',
        '  RemoteCommand echo nope',
        ''
      ].join('\n')
    )
    await lockDown([
      { path: dir, dir: true },
      { path: cfg, dir: false }
    ])
    const g = await execFileAsync(exe, ['-F', cfg, '-G', ...args.slice(0, at + 1)], { encoding: 'utf8', timeout: 15000 }).catch(
      (e: { stdout?: string; message?: string }) => ({ stdout: e.stdout ?? `failed: ${e.message ?? ''}` })
    )
    await rm(dir, { recursive: true, force: true })
    const out = g.stdout
    check('ssh -G: the host config’s forwardings are cleared (no local/remote/dynamic forward)', /^clearallforwardings yes$/m.test(out) && !/^(localforward|remoteforward|dynamicforward) /m.test(out), out.split('\n').filter((l) => /^(clearallforwardings|localforward|remoteforward|dynamicforward) /.test(l)).join('; '))
    check('ssh -G: its LocalCommand is not run', /^permitlocalcommand no$/m.test(out), '')
    check('ssh -G: no agent and no X11 handed to the far side', /^forwardagent no$/m.test(out) && /^forwardx11 no$/m.test(out), '')
    check('ssh -G: no tty, whatever RequestTTY says', /^requesttty (false|no)$/m.test(out), (/^requesttty .*$/m.exec(out) ?? [''])[0])
    check('ssh -G: its RemoteCommand is dropped', !/^remotecommand /m.test(out), (/^remotecommand .*$/m.exec(out) ?? [''])[0])
  }
  same('a leading-dash alias sends nothing', buildUploadArgs(host({ alias: '-oProxyCommand=x' }), 'a.png', 3), null)
  same('an empty alias sends nothing', buildUploadArgs(host({ alias: ' ' }), 'a.png', 3), null)
}

console.log('\nan image sent to the machine: what may be named, and how big')

{
  for (const bad of [
    '../x.png',
    'a/b.png',
    'a b.png',
    "a'b.png",
    'a"b.png',
    '$(id).png',
    '`id`.png',
    'a\\b.png',
    '-x.png',
    '.x.png',
    'a\nb.png',
    '_x.txt',
    '',
    `${'a'.repeat(77)}.png`
  ]) {
    same(`refused as a name: ${JSON.stringify(bad)}`, [isSafeUploadName(bad), isSafeFarName(bad), buildUploadBody(bad, 10), buildUploadArgs(host({}), bad, 10)], [false, false, null, null])
  }
  same('a name at the cap is fine', isSafeUploadName(`${'a'.repeat(76)}.png`), true)
  // A FILE keeps its own extension (gotcha 152): what an image's name may not end in, a file's may.
  for (const file of ['x.txt', 'x.png.sh', 'x', 'notes-a1b2c3.log', 'archive-a1b2c3.tar.gz']) {
    same(`a file may be called ${JSON.stringify(file)}, an image may not`, [isSafeUploadName(file), isSafeFarName(file), typeof buildUploadBody(file, 10)], [file.endsWith('.png'), true, 'string'])
  }
  for (const size of [-1, 1.5, Number.NaN, MAX_FILE_BYTES + 1]) {
    same(`refused as a size: ${size}`, buildUploadBody('a.png', size), null)
  }
  same('a 0-byte file is a file (the body makes it empty)', buildUploadBody('empty-a1b2c3', 0)?.includes('[ $n -eq 0 ]'), true)
  same('the file cap itself is allowed', typeof buildUploadBody('a.bin', MAX_FILE_BYTES), 'string')
  same('an image past its own cap is still a size the body takes (it goes as a file)', typeof buildUploadBody('a.png', MAX_IMAGE_BYTES + 1), 'string')

  const at = new Date(2026, 9, 2, 14, 30, 5)
  same('a clipboard image is named by local time and six hex digits', clipboardImageName(at, 'a1b2c3ff'), 'pasted-image-20261002-143005-a1b2c3.png')
  const dropped = [
    ['Screenshot 2026-10-02 at 2.30.05 pm.png', 'png', 'Screenshot-2026-10-02-at-2.30.05-pm-a1b2c3.png'],
    ['../../etc/passwd.png', 'png', 'passwd-a1b2c3.png'],
    ["it's $(rm -rf ~) `x`.jpeg", 'jpg', 'it-s-rm-rf-x-a1b2c3.jpg'],
    ['.hidden.gif', 'gif', 'hidden-a1b2c3.gif'],
    ['---.webp', 'webp', 'image-a1b2c3.webp'],
    ['日本語.png', 'png', 'image-a1b2c3.png'],
    [`${'long'.repeat(30)}.png`, 'png', `${'long'.repeat(12)}-a1b2c3.png`],
    ['photo.txt', 'png', 'photo-a1b2c3.png'],
    // An underscore at the start used to survive and fail isSafeUploadName: "could not name that image safely".
    ['__init__.png', 'png', 'init__-a1b2c3.png']
  ] as const
  for (const [file, kind, want] of dropped) {
    const got = droppedImageName(file, 'a1b2c3', kind)
    same(`a dropped ${JSON.stringify(file)} keeps a safe, recognisable name`, [got, isSafeUploadName(got)], [want, true])
  }

  // A FILE keeps its own name and extension through the same whitelist, plus the suffix (gotcha 152).
  const files = [
    ['report.pdf', 'report-a1b2c3.pdf'],
    ['My Report (final).pdf', 'My-Report-final-a1b2c3.pdf'],
    ['server 2026-10-02.log', 'server-2026-10-02-a1b2c3.log'],
    ['archive.tar.gz', 'archive-a1b2c3.tar.gz'],
    ['backup.TAR.XZ', 'backup-a1b2c3.TAR.XZ'],
    ['a.b.c.txt', 'a.b.c-a1b2c3.txt'],
    ['Makefile', 'Makefile-a1b2c3'],
    ['.env', 'env-a1b2c3'],
    ['.bashrc.local', 'bashrc-a1b2c3.local'],
    ['__init__.py', 'init__-a1b2c3.py'],
    ['日本語.pdf', 'file-a1b2c3.pdf'],
    ['notes.日本', 'notes-a1b2c3'],
    ['data.reallylongextension', 'data.reallylongextension-a1b2c3'],
    ["it's $(rm -rf ~) `x`.sh", 'it-s-rm-rf-x-a1b2c3.sh'],
    ['../../etc/passwd', 'passwd-a1b2c3'],
    ['C:\\Users\\me\\Q3 plan.docx', 'Q3-plan-a1b2c3.docx'],
    ['-rf', 'rf-a1b2c3'],
    ['...', 'file-a1b2c3'],
    [`${'long'.repeat(30)}.csv`, `${'long'.repeat(12)}-a1b2c3.csv`]
  ] as const
  for (const [file, want] of files) {
    const got = droppedFileName(file, 'a1b2c3ff')
    same(`a dropped file ${JSON.stringify(file)} keeps its own name, made safe`, [got, isSafeFarName(got)], [want, true])
  }
  same('two drops of one name never meet: the suffix is main’s random hex', droppedFileName('notes.txt', '000001') === droppedFileName('notes.txt', '000002'), false)
  {
    // Whatever the name, the result is one Stoke may write (fuzzed over awkward characters).
    const alphabet = ['a', 'Z', '9', '.', '-', '_', ' ', "'", '"', '$', '`', '\\', '/', '\n', 'é', '日', '🎉', '(', ';', '&']
    let bad = ''
    for (let i = 0; i < 3000 && !bad; i++) {
      let n = ''
      const len = 1 + (i % 90)
      for (let j = 0; j < len; j++) n += alphabet[(i * 31 + j * 17 + ((i * j) % 7)) % alphabet.length]
      const got = droppedFileName(n, 'a1b2c3')
      if (!isSafeFarName(got)) bad = `${JSON.stringify(n)} -> ${JSON.stringify(got)}`
    }
    same('3000 awkward names all come out as safe far names', bad, '')
  }

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
  same('PNG by its magic', imageKind(png), 'png')
  same('JPEG', imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
  same('GIF89a and GIF87a', [imageKind(new TextEncoder().encode('GIF89a..')), imageKind(new TextEncoder().encode('GIF87a..'))], ['gif', 'gif'])
  same('WebP', imageKind(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'webp')
  same('text named .png is not an image', imageKind(new TextEncoder().encode('#!/bin/sh\nrm -rf ~\n')), null)
  same('a cut-off PNG header is not one', imageKind(png.slice(0, 5)), null)
  same('nor a RIFF that is not WebP (a WAV)', imageKind(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')), null)

  same('the path is the LAST STOKE_PATH line (rc files print too)', parseUploadPath('hello from .bashrc\nSTOKE_PATH /x/old.png\nSTOKE_PATH /home/v/.cache/stoke/paste/a.png\n', 'a.png'), '/home/v/.cache/stoke/paste/a.png')
  same('a relative path is refused', parseUploadPath('STOKE_PATH home/a.png\n', 'a.png'), null)
  same('a path to another name is refused', parseUploadPath('STOKE_PATH /home/v/b.png\n', 'a.png'), null)
  same('a name that only ends the same is refused', parseUploadPath('STOKE_PATH /home/v/xa.png\n', 'a.png'), null)
  same('a control character is refused (it would press keys)', parseUploadPath('STOKE_PATH /home/v\u001b[2J/a.png\n', 'a.png'), null)
  same('no line at all is null', parseUploadPath('', 'a.png'), null)
  same('a home with a space is kept whole', parseUploadPath('STOKE_PATH /home/my user/.cache/stoke/paste/a.png\r\n', 'a.png'), '/home/my user/.cache/stoke/paste/a.png')

  // ssh's own lines, as the scout measured them against a real sshd.
  same('Permission denied is a key to set up', uploadFailureKind(255, 'thevinh@127.0.0.1: Permission denied (publickey).\n'), 'needs-login')
  same('so is a password host under BatchMode', uploadFailureKind(255, 'v@h: Permission denied (publickey,password,keyboard-interactive).'), 'needs-login')
  same('a refused port is unreachable', uploadFailureKind(255, 'ssh: connect to host 127.0.0.1 port 2298: Connection refused'), 'unreachable')
  same('an unknown name too', uploadFailureKind(255, 'ssh: Could not resolve hostname nope: nodename nor servname provided, or not known'), 'unreachable')
  same('a changed host key is neither: ssh’s line is shown', uploadFailureKind(255, 'Host key verification failed.'), 'failed')
  same('a far-side exit is never "needs login", whatever it printed', uploadFailureKind(5, 'Permission denied (publickey)'), 'failed')
  same('the timeout grows with the size and stops at two minutes', [uploadTimeoutMs(0), uploadTimeoutMs(1500 * 1024), uploadTimeoutMs(MAX_IMAGE_BYTES)], [15_000, 25_000, 120_000])
}

console.log('\nan image sent to the machine: the body, run by real login shells')

{
  /*
   * The far machine runs `$SHELL -c '<the last argv element>'`. Run here by
   * every login shell present, with a scratch HOME and TMPDIR, the bytes on
   * stdin exactly as ssh delivers them. Nothing outside the scratch folder is
   * read for writing.
   */
  const root = await mkdtemp(join(tmpdir(), 'stoke-upload-'))
  const posix = existsSync('/bin/sh') && process.platform !== 'win32'
  if (!posix) {
    console.log('  SKIP  no /bin/sh here (Windows), so the upload body was not run')
  } else {
    const { createHash, randomBytes } = await import('node:crypto')
    const { readdir, stat, utimes } = await import('node:fs/promises')
    const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
    const uid = process.getuid?.() ?? 0
    // Every byte value, then random: anything a pty or a text decode would mangle.
    const bytes = new Uint8Array(Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(300_000)]))
    const name = 'pasted-image-20261002-143005-a1b2c3.png'
    const remote = (n: string, size: number): string => {
      const a = buildUploadArgs(host({}), n, size) ?? []
      return a[a.length - 1] ?? ''
    }
    // spawnWithInput passes no env, as ssh's own child has none of ours; the
    // login shell is started through `env -i` so HOME and TMPDIR are scratch.
    const run = (login: string, command: string, input: Uint8Array, env: Record<string, string>): Promise<InputRunResult> =>
      spawnWithInput(
        '/usr/bin/env',
        ['-i', ...Object.entries({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env }).map(([k, v]) => `${k}=${v}`), login, '-c', command],
        input,
        { timeoutMs: 20_000 }
      )
    const logins = ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh', '/bin/tcsh']
    let ran = 0
    for (const login of logins) {
      if (!existsSync(login)) {
        console.log(`  SKIP  no ${login} on this machine`)
        continue
      }
      ran++
      const home = join(root, `home-${ran}`)
      const tmp = join(root, `tmp-${ran}`)
      await mkdir(home)
      await mkdir(tmp)
      const dir = join(home, '.cache', 'stoke', 'paste')

      const a = await run(login, remote(name, bytes.length), bytes, { HOME: home, TMPDIR: tmp })
      const file = join(dir, name)
      same(`${login}: exits 0 and says where`, [a.code, parseUploadPath(a.stdout, name)], [0, file])
      const got = existsSync(file) ? new Uint8Array(await readFile(file)) : new Uint8Array()
      same(`${login}: the bytes arrive identical (sha256)`, sha(got), sha(bytes))
      same(`${login}: the folder is 0700 and the file 0600`, [(await stat(dir)).mode & 0o777, existsSync(file) ? (await stat(file)).mode & 0o777 : -1], [0o700, 0o600])
      same(`${login}: no .part is left`, (await readdir(dir)).filter((f) => f.endsWith('.part')), [])

      // A 0-byte file is a file (gotcha 152): the body publishes it empty.
      const zero = 'empty-a1b2c3'
      const z = await run(login, remote(zero, 0), new Uint8Array(0), { HOME: home, TMPDIR: tmp })
      same(
        `${login}: a 0-byte file arrives, empty, and says where`,
        [z.code, parseUploadPath(z.stdout, zero), existsSync(join(dir, zero)) ? (await stat(join(dir, zero))).size : -1],
        [0, join(dir, zero), 0]
      )

      // A stream cut short, and one too long: never published, nothing left behind.
      const short = 'cut-short-a1b2c3.png'
      const b = await run(login, remote(short, bytes.length), bytes.slice(0, 1000), { HOME: home, TMPDIR: tmp })
      same(`${login}: a cut-off stream exits 5 and leaves no file and no .part`, [b.code, existsSync(join(dir, short)), existsSync(join(dir, `${short}.part`))], [5, false, false])
      const long = 'too-long-a1b2c3.png'
      const c = await run(login, remote(long, 10), bytes.slice(0, 20), { HOME: home, TMPDIR: tmp })
      same(`${login}: more bytes than said is refused the same way`, [c.code, existsSync(join(dir, long)), existsSync(join(dir, `${long}.part`))], [5, false, false])

      // The sweep: a file from two days ago goes; a fresh one (a bystander) stays.
      const old = join(dir, 'old-a1b2c3.png')
      const fresh = join(dir, 'fresh-a1b2c3.png')
      await writeFile(old, 'old')
      await writeFile(fresh, 'fresh')
      const twoDays = (Date.now() - 2 * 86_400_000) / 1000
      await utimes(old, twoDays, twoDays)
      await run(login, remote('third-a1b2c3.png', 3), new Uint8Array([1, 2, 3]), { HOME: home, TMPDIR: tmp })
      same(`${login}: the sweep removes a day-old file and keeps a fresh one`, [existsSync(old), existsSync(fresh), existsSync(join(dir, 'third-a1b2c3.png'))], [false, true, true])

      // XDG_CACHE_HOME wins when set.
      const xdg = join(root, `xdg-${ran}`)
      const x = await run(login, remote('xdg-a1b2c3.png', 3), new Uint8Array([1, 2, 3]), { HOME: home, TMPDIR: tmp, XDG_CACHE_HOME: xdg })
      same(`${login}: XDG_CACHE_HOME is honoured`, parseUploadPath(x.stdout, 'xdg-a1b2c3.png'), join(xdg, 'stoke', 'paste', 'xdg-a1b2c3.png'))

      // A home that cannot be written: the temp folder, per user.
      const ro = join(root, `ro-${ran}`)
      await mkdir(ro, { mode: 0o500 })
      const d = await run(login, remote('fallback-a1b2c3.png', 3), new Uint8Array([1, 2, 3]), { HOME: ro, TMPDIR: tmp })
      same(
        `${login}: a home it cannot write falls back to TMPDIR/stoke-paste-<uid>`,
        uid === 0 ? 'root writes anywhere; not tested as root' : parseUploadPath(d.stdout, 'fallback-a1b2c3.png'),
        uid === 0 ? 'root writes anywhere; not tested as root' : join(tmp, `stoke-paste-${uid}`, 'fallback-a1b2c3.png')
      )

      // A planted symlink in a shared temp folder is never written through.
      if (uid !== 0) {
        const shared = join(root, `shared-${ran}`)
        const target = join(root, `target-${ran}`)
        await mkdir(shared)
        await mkdir(target)
        await symlink(target, join(shared, `stoke-paste-${uid}`))
        const e = await run(login, remote('planted-a1b2c3.png', 3), new Uint8Array([1, 2, 3]), { HOME: ro, TMPDIR: shared })
        same(`${login}: a symlinked fallback folder is refused (exit 3), nothing written through it`, [e.code, (await readdir(target)).length], [3, 0])
      }
    }
    check('at least sh and bash ran the upload body', ran >= 2, `${ran} shells`)
  }
  await rm(root, { recursive: true, force: true })
}

console.log('\nan image sent to the machine: the stdin runner and the result')

{
  if (!existsSync('/bin/sh') || process.platform === 'win32') {
    console.log('  SKIP  no /bin/sh here (Windows), so the runner was not run')
  } else {
    // A child that stops reading at once while 8 MB are still to write: an EPIPE
    // on stdin must not throw in main, and the exit code is what comes back.
    const big = new Uint8Array(8 * 1024 * 1024)
    const early = await spawnWithInput('/bin/sh', ['-c', 'echo bye >&2; exit 7'], big, { timeoutMs: 10_000 })
    same('a child that exits before reading: its code, its stderr, no throw', [early.code, early.stderr.trim(), early.cancelled], [7, 'bye', false])
    const slow = await spawnWithInput('/bin/sh', ['-c', 'sleep 5'], new Uint8Array(1), { timeoutMs: 300 })
    same('a timeout is a sentence and no code (gotcha 25)', [slow.code, slow.error, slow.cancelled], [null, 'No answer within 0 s.', false])
    const ac = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ac.abort(), 150)
    const cut = await spawnWithInput('/bin/sh', ['-c', 'sleep 5'], new Uint8Array(1), { timeoutMs: 10_000, signal: ac.signal })
    same('Cancel ends it at once', [cut.cancelled, cut.code, Date.now() - t0 < 3000], [true, null, true])
    const missing = await spawnWithInput('/nonexistent/ssh-xyz', [], new Uint8Array(1), { timeoutMs: 1000 })
    same('an ssh that is not there is a result, not a throw', [missing.code, missing.error.length > 0], [null, true])
  }

  const seen: string[][] = []
  const fake =
    (r: Partial<InputRunResult>) =>
    async (args: string[]): Promise<InputRunResult> => {
      seen.push(args)
      return { stdout: '', stderr: '', code: 0, error: '', cancelled: false, ...r }
    }
  const bytes = new Uint8Array([1, 2, 3])
  same(
    'a sent image comes back with its far path',
    await sendImage(host({}), 'a1-a1b2c3.png', bytes, { run: fake({ stdout: 'motd\nSTOKE_PATH /home/v/.cache/stoke/paste/a1-a1b2c3.png\n' }) }),
    { ok: true, path: '/home/v/.cache/stoke/paste/a1-a1b2c3.png' }
  )
  same('it ran the upload argv, sized by the bytes', seen[0]?.[seen[0].length - 1]?.includes('[ $n -eq 3 ]'), true)
  same(
    'Permission denied: needs a key, with ssh’s own line',
    await sendImage(host({}), 'a1-a1b2c3.png', bytes, { run: fake({ code: 255, stderr: 'v@h: Permission denied (publickey,password).\n' }) }),
    { ok: false, reason: 'needs-login', message: 'Stoke sends images over a second connection, which cannot type a password.', detail: 'v@h: Permission denied (publickey,password).' }
  )
  same(
    'a cut-off stream says so, as a failure',
    await sendImage(host({}), 'a1-a1b2c3.png', bytes, { run: fake({ code: 5 }) }),
    { ok: false, reason: 'failed', message: 'The image arrived incomplete, so it was not kept.', detail: 'ssh exited with 5.' }
  )
  same(
    'an unreachable host says ssh’s line',
    await sendImage(host({}), 'a1-a1b2c3.png', bytes, { run: fake({ code: 255, stderr: 'ssh: connect to host 127.0.0.1 port 2298: Connection refused\n' }) }),
    { ok: false, reason: 'unreachable', message: 'The machine could not be reached.', detail: 'ssh: connect to host 127.0.0.1 port 2298: Connection refused' }
  )
  same(
    'exit 0 with no path is a failure, not a path typed',
    await sendImage(host({}), 'a1-a1b2c3.png', bytes, { run: fake({ stdout: 'STOKE_PATH /etc/passwd\n' }) }),
    { ok: false, reason: 'failed', message: 'The machine did not say where it saved the image.', detail: '' }
  )
  same(
    'a cancel is a cancel',
    await sendImage(host({}), 'a1-a1b2c3.png', bytes, { run: fake({ code: null, cancelled: true }) }),
    { ok: false, reason: 'cancelled', message: 'Cancelled.', detail: '' }
  )
  const before = seen.length
  same('a bad name never runs ssh', (await sendImage(host({}), '../x.png', bytes, { run: fake({}) })).ok, false)
  same('…and nothing was run', seen.length, before)

  // A file's sentences say "file", and it gets a file's limits: longer, and a stall limit.
  const limits: InputRunOpts[] = []
  const fakeOpts =
    (r: Partial<InputRunResult>) =>
    async (_args: string[], _input: UploadInput, opts: InputRunOpts): Promise<InputRunResult> => {
      limits.push(opts)
      return { stdout: '', stderr: '', code: 0, error: '', cancelled: false, ...r }
    }
  const big = 60 * 1024 * 1024
  const denied = await sendUpload(host({}), 'r-a1b2c3.pdf', { noun: 'file', size: big, input: new Uint8Array(0) }, { run: fakeOpts({ code: 255, stderr: 'v@h: Permission denied (publickey).\n' }) })
  same('a file’s Permission denied says "files"', denied.ok ? 'sent' : denied.message, 'Stoke sends files over a second connection, which cannot type a password.')
  same('…and it got the long limit and the stall limit', [limits[0]?.timeoutMs, limits[0]?.idleMs], [fileUploadTimeoutMs(big), UPLOAD_IDLE_MS])
  const cutFile = await sendUpload(host({}), 'r-a1b2c3.pdf', { noun: 'file', size: 3, input: bytes }, { run: fakeOpts({ code: 5 }) })
  same('a cut-off file says "file"', cutFile.ok ? 'sent' : cutFile.message, 'The file arrived incomplete, so it was not kept.')
  await sendImage(host({}), 'a1-a1b2c3.png', bytes, { run: fakeOpts({ stdout: 'STOKE_PATH /x/a1-a1b2c3.png\n' }) })
  same('an image keeps its own limit and no stall limit', [limits[limits.length - 1]?.timeoutMs, limits[limits.length - 1]?.idleMs], [uploadTimeoutMs(3), undefined])
  same('100 MB may take half an hour at most; 2 minutes stays an image’s', [fileUploadTimeoutMs(MAX_FILE_BYTES), fileUploadTimeoutMs(0), uploadTimeoutMs(MAX_IMAGE_BYTES)], [30 * 60_000, 15_000, 120_000])
}

console.log('\na file sent to the machine: the runner reads it as it sends, and says how far it is')

if (!existsSync('/bin/sh') || process.platform === 'win32') {
  console.log('  SKIP  no /bin/sh here (Windows), so the file runner was not run')
} else {
  const { createHash, randomBytes } = await import('node:crypto')
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
  const root = await mkdtemp(join(tmpdir(), 'stoke-files-'))
  try {
    // Chunks from a generator, as a file is read: every byte arrives, and progress climbs to the total.
    const data = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17))
    const out = join(root, 'out.bin')
    const seen: number[] = []
    const r = await spawnWithInput('/bin/sh', ['-c', `cat > '${out}'`], async function* () {
      for (let at = 0; at < data.length; at += 100_000) yield data.subarray(at, at + 100_000)
    }, { timeoutMs: 20_000, idleMs: 10_000, onProgress: (n) => seen.push(n) })
    same('a streamed input arrives whole (sha256)', [r.code, sha(new Uint8Array(await readFile(out)))], [0, sha(data)])
    same('progress only climbs, and ends at the total', [seen.every((n, i) => i === 0 || n > seen[i - 1]), seen[seen.length - 1]], [true, data.length])
    const bytesSeen: number[] = []
    await spawnWithInput('/bin/sh', ['-c', 'cat > /dev/null'], data, { timeoutMs: 20_000, onProgress: (n) => bytesSeen.push(n) })
    same('bytes in hand go in chunks too, so an image shows progress', [bytesSeen.length > 1, bytesSeen[bytesSeen.length - 1]], [true, data.length])

    // A read that fails half-way: ssh is stopped, and the far side would see EOF short of the size.
    const failed = await spawnWithInput('/bin/sh', ['-c', 'cat > /dev/null'], async function* () {
      yield data.subarray(0, 1000)
      throw new Error('disk went away')
    }, { timeoutMs: 20_000 })
    same('a read that fails is the result, in its own words, and no exit code', [failed.code, failed.error], [null, 'disk went away'])

    // A link that stops taking bytes: given up after the stall limit, not the half-hour one.
    const t0 = Date.now()
    const stalled = await spawnWithInput('/bin/sh', ['-c', 'exec sleep 30'], new Uint8Array(4 * 1024 * 1024), { timeoutMs: 60_000, idleMs: 1000 })
    same('a child that stops reading is given up at the stall limit', [stalled.code, stalled.error, Date.now() - t0 < 10_000], [null, 'Nothing was taken for 1 s.', true])
    // …but not once everything is written: the stall limit is for bytes left to give.
    const slowExit = await spawnWithInput('/bin/sh', ['-c', 'cat > /dev/null; sleep 1.5; echo done'], new Uint8Array(10), { timeoutMs: 20_000, idleMs: 500 })
    same('a slow far side after the last byte is not a stall', [slowExit.code, slowExit.stdout.trim()], [0, 'done'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\na file sent to the machine: what may be read, and what is refused with a sentence')

if (process.platform === 'win32') {
  console.log('  SKIP  links, pipes, sockets and devices are POSIX fixtures')
} else {
  const { createHash, randomBytes } = await import('node:crypto')
  const { truncate, unlink, appendFile, stat } = await import('node:fs/promises')
  const { createServer } = await import('node:net')
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
  const collect = async (src: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
    const parts: Uint8Array[] = []
    for await (const c of src) parts.push(c)
    return new Uint8Array(Buffer.concat(parts))
  }
  // realpath'd: macOS's own TMPDIR is a link, and the resolved path is what comes back.
  const { realpath } = await import('node:fs/promises')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stoke-files-')))
  const server = createServer()
  try {
    const log = join(root, 'server 2026-10-02.log')
    const logBytes = new Uint8Array(randomBytes(70_000))
    await writeFile(log, logBytes)
    const empty = join(root, 'empty')
    await writeFile(empty, '')
    const folder = join(root, 'Projects')
    await mkdir(folder)
    await symlink(log, join(root, 'link-to-log'))
    await symlink(folder, join(root, 'link-to-folder'))
    await symlink(join(root, 'gone'), join(root, 'dangling'))
    const fifo = join(root, 'a-pipe')
    await execFileAsync('mkfifo', [fifo])
    const sock = join(root, 's.sock')
    await new Promise<void>((resolve) => server.listen(sock, resolve))
    const huge = join(root, 'huge.bin')
    await writeFile(huge, '')
    await truncate(huge, MAX_FILE_BYTES + 1) // sparse: no disk is used
    const atCap = join(root, 'at-cap.bin')
    await writeFile(atCap, '')
    await truncate(atCap, MAX_FILE_BYTES)

    same('a regular file: its path and size', await inspectUploadFile(log, 'server 2026-10-02.log'), { ok: true, path: log, size: logBytes.length })
    same('a 0-byte file is a file', await inspectUploadFile(empty, 'empty'), { ok: true, path: empty, size: 0 })
    same('a link is followed to the file it names', await inspectUploadFile(join(root, 'link-to-log'), 'link-to-log'), { ok: true, path: log, size: logBytes.length })
    same('exactly the cap is allowed', (await inspectUploadFile(atCap, 'at-cap.bin')).ok, true)
    const refusals: [string, unknown, string][] = [
      ['a folder', folder, 'Projects is a folder. Stoke sends files, not folders: drop the files inside it, or zip it first.'],
      ['a link to a folder', join(root, 'link-to-folder'), 'link-to-folder is a folder. Stoke sends files, not folders: drop the files inside it, or zip it first.'],
      ['a link to nothing', join(root, 'dangling'), 'dangling is a link to something that is not there.'],
      ['a pipe', fifo, 'a-pipe is a pipe, not a file.'],
      ['a socket', sock, 's.sock is a socket, not a file.'],
      ['a device', '/dev/null', 'null is a device, not a file.'],
      ['past the cap', huge, `huge.bin is ${formatBytes(MAX_FILE_BYTES + 1)}; Stoke sends files up to ${formatBytes(MAX_FILE_BYTES)}. Copy it with scp instead.`],
      ['a missing file', join(root, 'nope.txt'), 'nope.txt is no longer there.'],
      ['a relative path', 'notes.txt', 'notes.txt is not a file on this computer.'],
      ['not a string', 42, 'that is not a file on this computer.'],
      ['a NUL in the path', `${log}\u0000.txt`, 'x is not a file on this computer.']
    ]
    for (const [what, p, want] of refusals) {
      const label = typeof p === 'string' ? (p.split('/').pop() ?? '').replace(/\u0000.*$/, '') : 'that'
      const r = await inspectUploadFile(p, what === 'a NUL in the path' ? 'x' : label)
      same(`refused with a sentence: ${what}`, r.ok ? 'accepted' : r.message, want)
    }

    // Opening for the send: the bytes are the file's, read as they are sent.
    const opened = await openUploadFile(log, 'server 2026-10-02.log')
    same('opened: the size, and the bytes read back identical', opened.ok ? [opened.size, sha(await collect(opened.input()))] : opened.message, [logBytes.length, sha(logBytes)])
    if (opened.ok) await opened.close()
    const zero = await openUploadFile(empty, 'empty')
    same('a 0-byte file opens and yields nothing', zero.ok ? [zero.size, (await collect(zero.input())).length] : zero.message, [0, 0])
    if (zero.ok) await zero.close()

    // Swapped after the check: a link (O_NOFOLLOW) and a pipe (O_NONBLOCK, so the open cannot hang main).
    const swapped = join(root, 'swapped.txt')
    await writeFile(swapped, 'x')
    const checked = await inspectUploadFile(swapped, 'swapped.txt')
    await unlink(swapped)
    await symlink(log, swapped)
    const asLink = await openUploadFile(checked.ok ? checked.path : swapped, 'swapped.txt')
    same('a link swapped in after the check is refused, not followed', asLink.ok ? 'opened' : asLink.message, 'swapped.txt changed since it was dropped. Drop it again.')
    await unlink(swapped)
    await execFileAsync('mkfifo', [swapped])
    const t0 = Date.now()
    const asPipe = await openUploadFile(swapped, 'swapped.txt')
    same('a pipe swapped in is refused at once, never waited on', [asPipe.ok ? 'opened' : asPipe.message, Date.now() - t0 < 2000], ['swapped.txt is a pipe, not a file.', true])

    // A log still being written: sent as it was when opened (its first `size` bytes), whole.
    const growing = join(root, 'growing.log')
    await writeFile(growing, 'line 1\n')
    const g = await openUploadFile(growing, 'growing.log')
    await appendFile(growing, 'line 2\n')
    same('a file that grows after it is opened is sent as it was then', g.ok ? [g.size, new TextDecoder().decode(await collect(g.input()))] : g.message, [7, 'line 1\n'])
    if (g.ok) await g.close()
    // One that shrinks: stopped, in a sentence, so the far side keeps nothing.
    const shrinking = join(root, 'shrinking.log')
    await writeFile(shrinking, 'x'.repeat(5000))
    const s = await openUploadFile(shrinking, 'shrinking.log')
    await truncate(shrinking, 10)
    let shrunk = ''
    if (s.ok) {
      await collect(s.input()).catch((e: Error) => {
        shrunk = e.message
      })
      await s.close()
    }
    same('a file that shrinks while it is sent stops, and says so', shrunk, 'shrinking.log got shorter while it was being sent.')

    // The whole route, but ssh: sendFile runs the REAL upload body under sh with a scratch HOME.
    const home = join(root, 'home')
    await mkdir(home)
    const viaSh = (args: string[], input: UploadInput, opts: InputRunOpts): Promise<InputRunResult> =>
      spawnWithInput('/usr/bin/env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', '/bin/sh', '-c', args[args.length - 1]], input, opts)
    const name = droppedFileName('server 2026-10-02.log', 'a1b2c3')
    const progress: number[] = []
    const sent = await sendFile(host({}), name, log, 'server 2026-10-02.log', { run: viaSh, onProgress: (n) => progress.push(n) })
    const far = join(home, '.cache', 'stoke', 'paste', name)
    same(
      'sendFile: the file arrives under its own name, sha256 identical, and the path comes back',
      [sent, existsSync(far) ? sha(new Uint8Array(await readFile(far))) : 'missing'],
      [{ ok: true, path: far }, sha(logBytes)]
    )
    same('…with progress up to its size', progress[progress.length - 1], logBytes.length)
    const sentEmpty = await sendFile(host({}), 'empty-a1b2c3', empty, 'empty', { run: viaSh })
    same('sendFile: a 0-byte file arrives empty', [sentEmpty.ok, existsSync(join(home, '.cache', 'stoke', 'paste', 'empty-a1b2c3')) ? (await stat(join(home, '.cache', 'stoke', 'paste', 'empty-a1b2c3'))).size : -1], [true, 0])
    const gone = await sendFile(host({}), 'gone-a1b2c3.txt', join(root, 'gone.txt'), 'gone.txt', { run: viaSh })
    same('sendFile: a file gone by its turn is not-file, a sentence, and no ssh', gone, { ok: false, reason: 'not-file', message: 'gone.txt is no longer there.', detail: '' })
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\nfiles copied in Finder, Explorer or a Linux file manager: reading the clipboard')

{
  // What Electron's clipboard.read('NSFilenamesPboardType') returned on this Mac for two copied files.
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
    '\t<string>/tmp/b2/a.log</string>',
    '\t<string>/tmp/b2/my report &amp; co.pdf</string>',
    '\t<string>/tmp/b2/&lt;odd&gt; &#233;t&#xE9; &apos;q&apos; &quot;d&quot;.txt</string>',
    '</array>',
    '</plist>',
    ''
  ].join('\n')
  same('macOS: every copied file, in order, entities read', parseFilenamesPlist(plist), ['/tmp/b2/a.log', '/tmp/b2/my report & co.pdf', `/tmp/b2/<odd> été 'q' "d".txt`])
  same('macOS: nothing copied is no paths', parseFilenamesPlist(''), [])
  same('macOS: a relative entry is not a path', parseFilenamesPlist('<array><string>a.txt</string></array>'), [])
  same('a file URL is its path, decoded', fileUrlPath('file:///tmp/b2/my%20report%20%26%20co.pdf'), '/tmp/b2/my report & co.pdf')
  same('file://localhost/ is this machine too', fileUrlPath('file://localhost/etc/hosts'), '/etc/hosts')
  same('a file URL naming another host is not a file here', fileUrlPath('file://server/share/x.txt'), null)
  same('an http URL is not a file', fileUrlPath('https://example.com/x.pdf'), null)
  same('a NUL is refused', fileUrlPath('file:///tmp/a%00b'), null)
  same('broken percent-encoding is refused, not thrown', fileUrlPath('file:///tmp/%E0%A4%A'), null)
  same(
    'Linux: text/uri-list, CRLF and comments, file URLs only',
    parseUriList('# copied by Files\r\nfile:///home/v/a%20b.txt\r\nhttps://example.com/\r\nfile:///home/v/c.log\r\n'),
    ['/home/v/a b.txt', '/home/v/c.log']
  )
  const utf16 = (s: string): Uint8Array => {
    const b = new Uint8Array((s.length + 1) * 2)
    for (let i = 0; i < s.length; i++) {
      b[i * 2] = s.charCodeAt(i) & 0xff
      b[i * 2 + 1] = s.charCodeAt(i) >> 8
    }
    return b
  }
  same('Windows: FileNameW is the first path, to its NUL', fileNameW(utf16('C:\\Users\\me\\Q3 plan.docx')), 'C:\\Users\\me\\Q3 plan.docx')
  same('Windows: an empty FileNameW is no path', fileNameW(new Uint8Array(0)), '')
  same('Windows: the CIDA count is its first UINT', [cidaCount(new Uint8Array([3, 0, 0, 0, 20, 0])), cidaCount(new Uint8Array([1, 1, 0, 0])), cidaCount(new Uint8Array([1]))], [3, 257, 0])
}


console.log('\nan image sent to the machine: the queue a tab’s pastes and drops go through')

{
  /*
   * A fake main that answers like the real one (sshImages.ts): prepare reads
   * "the clipboard" the moment it is called and holds the image under an id;
   * send waits until the test answers it; release of an id whose send is in
   * flight answers that send 'cancelled', as an aborted ssh does.
   */
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  }
  const rig = (opts: { slowPrepare?: boolean; stuckSends?: boolean } = {}) => {
    /*
     * `clip.now` is the clipboard's image; `clip.files` the files a file
     * manager copied (a name each, or a sentence main refuses the paste with).
     * A dropped name in `notImages` has bytes that are not an image.
     */
    const clip: { now: string; files: string[] | string } = { now: 'A', files: [] }
    const notImages = new Set<string>()
    const log: string[] = []
    const released: string[] = []
    const typed: string[][] = []
    const said: string[][] = []
    const phases: ImagePhase[] = []
    const sends = new Map<string, (r: ImageSent) => void>()
    const prepares: (() => void)[] = []
    let n = 0
    const prepare = (source: ImageSource): Promise<ImagePrepared> => {
      const what = source.kind === 'clipboard' ? clip.now : source.name
      log.push(`prepare ${what}`)
      const answer = (): ImagePrepared =>
        what === ''
          ? { ok: false, reason: 'no-image', message: 'There is no image on the clipboard.' }
          : notImages.has(what)
            ? { ok: false, reason: 'not-image', message: `${what} is not a PNG, JPEG, GIF or WebP image.` }
            : { ok: true, uploadId: `${what}#${++n}`, name: `${what}.png`, bytes: 10, thumb: null }
      if (!opts.slowPrepare) return Promise.resolve(answer())
      return new Promise((r) => prepares.push(() => r(answer())))
    }
    /** What main answers for a file it checked by its path: held, under its own name. */
    const heldFile = (name: string): ImagePrepared => ({ ok: true, uploadId: `${name}#${++n}`, name: `far-${name}`, bytes: 10, thumb: null, file: name })
    /** A dropped File with a path behind it; `refuse` is main's sentence for it (a folder, say). */
    const file = (name: string, type: string, size = 10, p: { refuse?: string; path?: boolean } = {}): DroppedFile => ({
      name,
      type,
      size,
      read: async () => {
        log.push(`read ${name}`)
        return new ArrayBuffer(4)
      },
      viaPath:
        p.path === false
          ? undefined
          : async () => {
              log.push(`path ${name}`)
              return p.refuse ? { ok: false, reason: 'not-file', message: p.refuse } : heldFile(name)
            }
    })
    const jobs = new ImageJobs({
      prepare,
      prepareClipboardFiles: async () => {
        log.push('prepare clipboard files')
        const now = clip.files
        if (typeof now === 'string') return [{ ok: false, reason: 'not-allowed', message: now }]
        return now.map(heldFile)
      },
      send: (id) => {
        log.push(`send ${id}`)
        return new Promise((r) => sends.set(id, r))
      },
      release: (id) => {
        released.push(id)
        if (opts.stuckSends) return
        const pending = sends.get(id)
        sends.delete(id)
        pending?.({ ok: false, reason: 'cancelled', message: 'Cancelled.', detail: '' })
      },
      phase: (p) => phases.push(p),
      waiting: () => {},
      finished: (paths, notes) => {
        typed.push(paths)
        said.push(notes)
      }
    })
    /** Answer the send in flight whose id starts with `what#`. */
    const answer = async (what: string, r: ImageSent | 'ok'): Promise<void> => {
      await tick()
      const id = [...sends.keys()].find((k) => k.startsWith(`${what}#`))
      if (!id) {
        // A missing reading is a failure, not a skip (gotcha 113) — and not a crash that hides the rest.
        check(`a send of ${what} was in flight to answer`, false, `in flight: ${[...sends.keys()].join(', ') || 'none'}`)
        return
      }
      const resolve = sends.get(id)
      sends.delete(id)
      resolve?.(r === 'ok' ? { ok: true, path: what.includes('.') ? `/far/${what}` : `/far/${what}.png` } : r)
      await tick()
    }
    const sent = (what: string): number => log.filter((l) => l.startsWith(`send ${what}#`)).length
    const last = (): string => phases[phases.length - 1]?.kind ?? 'none'
    return { jobs, clip, notImages, file, log, released, typed, said, phases, prepares, answer, sent, last }
  }
  const unreachable: ImageSent = { ok: false, reason: 'unreachable', message: 'The machine could not be reached.', detail: 'ssh: connect to host h port 22: Connection refused' }

  {
    // Copy A, paste; copy B, paste; copy C. The queue must send A then B, never C.
    const t = rig()
    t.jobs.paste()
    t.clip.now = 'B'
    t.jobs.paste()
    t.clip.now = 'C'
    same('a paste reads the clipboard when it is pressed, not when its turn comes', t.log.filter((l) => l.startsWith('prepare')), ['prepare A', 'prepare B'])
    await t.answer('A', 'ok')
    same('…and only one image is sent at a time', [t.sent('A'), t.sent('B')], [1, 1])
    await t.answer('B', 'ok')
    same('the paths are typed in the order of the presses', t.typed, [['/far/A.png'], ['/far/B.png']])
    same('nothing main holds is let go after a send lands (main drops it itself)', t.released, [])
  }

  {
    // A fails with B queued: B waits for the answer; Try again sends A, then B.
    const t = rig()
    t.jobs.paste()
    t.clip.now = 'B'
    t.jobs.paste()
    await t.answer('A', unreachable)
    same('a failure stays on screen while a paste waits behind it', [t.last(), t.sent('B'), t.typed], ['failed', 0, []])
    t.jobs.retry()
    await t.answer('A', 'ok')
    await t.answer('B', 'ok')
    same('Try again sends the same held image, then the queue goes on, in order', [t.sent('A'), t.typed], [2, [['/far/A.png'], ['/far/B.png']]])
  }

  {
    // A fails with B queued; Dismiss lets A go and B goes on.
    const t = rig()
    t.jobs.paste()
    t.clip.now = 'B'
    t.jobs.paste()
    await t.answer('A', unreachable)
    t.jobs.cancel()
    await t.answer('B', 'ok')
    same('Dismiss lets the failed image go, types nothing for it, and the next goes on', [t.released.filter((id) => id.startsWith('A#')).length, t.typed], [1, [['/far/B.png']]])
  }

  {
    // A new paste while a failure is on screen answers it.
    const t = rig()
    t.jobs.paste()
    await t.answer('A', unreachable)
    t.clip.now = 'C'
    t.jobs.paste()
    await t.answer('C', 'ok')
    same('a new paste answers a failure on screen: that image let go, the new one sent', [t.released.some((id) => id.startsWith('A#')), t.typed], [true, [['/far/C.png']]])
  }

  {
    // Cancel while A sends, B queued: only A is let go.
    const t = rig()
    t.jobs.paste()
    t.clip.now = 'B'
    t.jobs.paste()
    await tick()
    t.jobs.cancel()
    await tick()
    same('Cancel lets go of the image being sent and never one waiting behind it', [t.released.map((id) => id.split('#')[0]), t.sent('B')], [['A'], 1])
    await t.answer('B', 'ok')
    same('…which is then sent and typed', t.typed, [['/far/B.png']])
  }

  {
    // Main slow to answer a send it was told to stop: the next job must not wait for it.
    const t = rig({ stuckSends: true })
    t.jobs.paste()
    t.clip.now = 'B'
    t.jobs.paste()
    await tick()
    t.jobs.cancel()
    await t.answer('B', 'ok')
    same('a cancelled send main has not answered yet never holds the queue', t.typed, [['/far/B.png']])
  }

  {
    // The pane goes while A sends and B waits: everything held is let go, nothing typed or sent after.
    const t = rig()
    t.jobs.paste()
    t.clip.now = 'B'
    t.jobs.paste()
    await tick()
    t.jobs.close()
    await tick()
    same('closing the pane lets every held image go, waiting ones too, and sends nothing more', [t.released.map((id) => id.split('#')[0]).sort(), t.sent('B'), t.typed], [['A', 'B'], 0, []])
    t.jobs.paste()
    same('a closed queue takes nothing new', t.log.filter((l) => l.startsWith('prepare')).length, 2)
  }

  {
    // An image main finishes holding only after the pane went is let go too.
    const t = rig({ slowPrepare: true })
    t.jobs.paste()
    t.jobs.close()
    for (const p of t.prepares) p()
    await tick()
    same('an image held after the pane went is let go, not left in main', t.released.map((id) => id.split('#')[0]), ['A'])
  }

  {
    // The tab stops running: every job ends, and the queue still takes the next paste.
    const t = rig()
    t.jobs.paste()
    t.clip.now = 'B'
    t.jobs.paste()
    await tick()
    t.jobs.reset()
    await tick()
    same('a stopped tab lets go of the one sending and the one waiting', [t.released.map((id) => id.split('#')[0]).sort(), t.sent('B'), t.last()], [['A', 'B'], 0, 'idle'])
    t.clip.now = 'C'
    t.jobs.paste()
    await t.answer('C', 'ok')
    same('…and the next paste after it is sent', t.typed, [['/far/C.png']])
  }

  {
    // Main says the image is gone (held too long): a sentence, no Try again.
    const t = rig()
    t.jobs.paste()
    await t.answer('A', { ok: false, reason: 'not-allowed', message: 'That image is no longer waiting to be sent. Paste it again.', detail: '' })
    same('an image main no longer holds is a sentence, not a Try again', [t.last(), t.typed], ['note', []])
    t.clip.now = ''
    t.jobs.paste()
    await tick()
    const p = t.phases[t.phases.length - 1]
    same('an empty clipboard is a sentence', p.kind === 'note' ? p.message : p.kind, 'There is no image on the clipboard.')
  }

  {
    // A drop with no path behind its files (a drag out of a browser): images as before, anything else said.
    const t = rig()
    const reads: string[] = []
    const file = (name: string, type: string, size = 10): DroppedImageFile => ({
      name,
      type,
      size,
      read: async () => {
        reads.push(name)
        return new ArrayBuffer(4)
      }
    })
    same('an empty drop is left to the caller', t.jobs.drop([]), false)
    const took = t.jobs.drop([file('one.png', 'image/png'), file('huge.png', 'image/png', MAX_IMAGE_BYTES + 1), file('notes.txt', 'text/plain'), file('two.jpg', '')])
    same('a drop is taken', took, true)
    await tick()
    same('…and only the first image is read before it is sent', reads, ['one.png'])
    await t.answer('one.png', 'ok')
    await t.answer('two.jpg', 'ok')
    same('every image of a drop is typed together, in the drop’s order', t.typed, [['/far/one.png', '/far/two.jpg']])
    same('an oversized image is never read', reads, ['one.png', 'two.jpg'])
    same(
      'what could not be sent is said, never typed',
      t.said[0],
      [`huge.png is ${formatBytes(MAX_IMAGE_BYTES + 1)}; Stoke sends images up to ${formatBytes(MAX_IMAGE_BYTES)}.`, 'notes.txt is not a file on this computer, so it cannot be sent.']
    )
  }

  {
    // Any file (gotcha 152): an image, a log, a PDF and a folder in one drop, by their paths, one at a time.
    const t = rig()
    const took = t.jobs.drop([
      t.file('shot.png', 'image/png'),
      t.file('server.log', 'text/plain'),
      t.file('My Report.pdf', 'application/pdf'),
      t.file('Projects', '', 96, { refuse: 'Projects is a folder. Stoke sends files, not folders: drop the files inside it, or zip it first.' }),
      t.file('empty', '', 0)
    ])
    same('a drop of files of any kind is taken', took, true)
    await tick()
    same('the image is read as an image; nothing after it is asked for yet', t.log.filter((l) => /^(read|path|prepare) /.test(l)), ['read shot.png', 'prepare shot.png'])
    await t.answer('shot.png', 'ok')
    same('then the log, by its path (main reads it), and only now', t.log.filter((l) => /^(read|path|prepare) /.test(l)).slice(2), ['path server.log'])
    const sending = t.phases.filter((p): p is Extract<ImagePhase, { kind: 'sending' }> => p.kind === 'sending')
    const s = sending[sending.length - 1]
    same('the strip names the file and can match main’s progress to it', [s?.file, s?.uploadId.startsWith('server.log#'), s?.index, s?.count], ['server.log', true, 1, 5])
    await t.answer('server.log', 'ok')
    await t.answer('My Report.pdf', 'ok')
    await t.answer('empty', 'ok')
    same('every path of the drop is typed together, in the drop’s order', t.typed, [['/far/shot.png', '/far/server.log', '/far/My Report.pdf', '/far/empty.png']])
    same('a folder is said, with main’s sentence, and never typed', t.said[0], ['Projects is a folder. Stoke sends files, not folders: drop the files inside it, or zip it first.'])
    same('nothing main held is left held', t.released, [])
  }

  {
    // Images past their cap, and "images" that are not: each goes as the file it is.
    const t = rig()
    t.notImages.add('fake.png')
    t.jobs.drop([t.file('big.png', 'image/png', MAX_IMAGE_BYTES + 1), t.file('fake.png', 'image/png')])
    await tick()
    same('an image past the image cap goes by its path, never read here', t.log.filter((l) => /^(read|path|prepare) /.test(l)), ['path big.png'])
    await t.answer('big.png', 'ok')
    same('a .png whose bytes are not an image goes by its path too', t.log.filter((l) => /^(read|path|prepare) /.test(l)).slice(1), ['read fake.png', 'prepare fake.png', 'path fake.png'])
    await t.answer('fake.png', 'ok')
    same('…and both are typed', [t.typed, t.said], [[['/far/big.png', '/far/fake.png']], [[]]])
  }

  {
    // Past the file cap: refused before main is asked, so it is never opened.
    const t = rig()
    t.jobs.drop([t.file('disk.img', '', MAX_FILE_BYTES + 1), t.file('ok.txt', 'text/plain')])
    await tick()
    await t.answer('ok.txt', 'ok')
    same('a file past the cap never reaches main', t.log.some((l) => l === 'path disk.img'), false)
    same(
      '…it is said, and the rest still goes',
      [t.typed, t.said[0]],
      [[['/far/ok.txt']], [`disk.img is ${formatBytes(MAX_FILE_BYTES + 1)}; Stoke sends files up to ${formatBytes(MAX_FILE_BYTES)}. Copy it with scp instead.`]]
    )
  }

  {
    // A file gone by its turn (main answers not-file): said, and the rest of the drop still typed.
    const t = rig()
    t.jobs.drop([t.file('a.txt', 'text/plain'), t.file('b.txt', 'text/plain'), t.file('c.txt', 'text/plain')])
    await t.answer('a.txt', 'ok')
    await t.answer('b.txt', { ok: false, reason: 'not-file', message: 'b.txt is no longer there.', detail: '' })
    await t.answer('c.txt', 'ok')
    same('a file that went missing is said; the others are typed', [t.typed, t.said[0]], [[['/far/a.txt', '/far/c.txt']], ['b.txt is no longer there.']])
  }

  {
    // Files copied in Finder: main reads them at the PRESS, and they are typed together, in order.
    const t = rig()
    t.jobs.paste()
    t.clip.files = ['notes.txt', 'Q3 plan.pdf']
    t.jobs.pasteFiles()
    t.clip.files = ['later.txt']
    await tick()
    same('a file paste reads the clipboard when it is pressed, even queued behind a send', t.log.filter((l) => l.startsWith('prepare')), ['prepare A', 'prepare clipboard files'])
    await t.answer('A', 'ok')
    await t.answer('notes.txt', 'ok')
    await t.answer('Q3 plan.pdf', 'ok')
    same('…and its files are typed together, after the paste before it', t.typed, [['/far/A.png'], ['/far/notes.txt', '/far/Q3 plan.pdf']])
    t.clip.files = 'Stoke can read only the first of the 3 files copied here. Drop them on the tab instead, or copy one at a time.'
    t.jobs.pasteFiles()
    await tick()
    const p = t.phases[t.phases.length - 1]
    same('a paste main refuses whole is its sentence, nothing typed', [p.kind === 'note' ? p.message : p.kind, t.typed.length], ['Stoke can read only the first of the 3 files copied here. Drop them on the tab instead, or copy one at a time.', 2])
  }

  {
    // The pane goes while main is still reading the copied files: whatever it then holds is let go.
    const t = rig()
    t.clip.files = ['x.txt', 'y.txt']
    t.jobs.pasteFiles()
    t.jobs.close()
    await tick()
    same('files held after the pane went are let go, not left in main', t.released.map((id) => id.split('#')[0]).sort(), ['x.txt', 'y.txt'])
  }

  {
    // While main reads what was copied, the strip says files: "Reading image…" named the wrong thing.
    const t = rig()
    t.clip.files = ['a.txt']
    t.jobs.pasteFiles()
    await tick()
    const reading = t.phases.find((p) => p.kind === 'reading')
    same('a file paste reads as "copied files" while main looks, never as an image', reading?.kind === 'reading' ? reading.name : 'none', 'copied files')
  }
}

console.log('\nwhat main holds to send: let go unasked only while nothing is sending')

{
  /*
   * `UploadHolds` (sshUpload.ts) on a clock this suite runs. The first cut let
   * a hold go HELD_MS after the press whatever else was happening, so a paste
   * of several copied files, or an image pasted behind a 100 MB file, was let
   * go while it waited its turn, and its job ended on "no longer waiting"
   * without typing the paths it HAD sent.
   */
  const pending: { fn: () => void; ms: number; live: boolean }[] = []
  const timers: HoldTimers = {
    set: (fn, ms) => {
      const t = { fn, ms, live: true }
      pending.push(t)
      return t
    },
    clear: (t) => {
      ;(t as { live: boolean }).live = false
    }
  }
  /** The clock runs past every timer armed so far (not the ones they arm). */
  const lapse = (): void => {
    for (const t of pending.splice(0)) {
      if (!t.live) continue
      t.live = false
      t.fn()
    }
  }
  const HELD = 10 * 60_000
  const holds = new UploadHolds<string>(HELD, timers)
  holds.add('A', 'a 100 MB file')
  holds.add('B', 'an image pasted behind it')
  holds.add('C', 'the second of two copied files')
  same('each hold is armed for its time', pending.map((t) => t.ms), [HELD, HELD, HELD])
  const a = holds.begin('A')
  same('a claim is one send: a second claim is refused', [a instanceof AbortController, holds.begin('A'), holds.sending('A')], [true, null, true])
  lapse()
  same('nothing waiting behind a send in flight is let go, nor the send itself', [holds.get('A'), holds.get('B'), holds.get('C')], ['a 100 MB file', 'an image pasted behind it', 'the second of two copied files'])
  lapse()
  same('…however long that send takes', holds.size, 3)
  if (a) holds.end('A', a, false)
  same('a sent upload is let go at once', holds.get('A'), undefined)
  const b = holds.begin('B')
  if (b) holds.end('B', b, true)
  same('a failed send is held again, for Try again', [holds.get('B'), holds.sending('B')], ['an image pasted behind it', false])
  lapse()
  same('once nothing is sending, a hold no one sends is let go', [holds.get('B'), holds.get('C'), holds.size], [undefined, undefined, 0])
  holds.add('D', 'd')
  const d = holds.begin('D')
  holds.cancel('D')
  same('Cancel stops the send and lets it go', [d?.signal.aborted, holds.get('D')], [true, undefined])
  if (d) holds.end('D', d, true)
  same('a send that ends after its Cancel is not held again', holds.get('D'), undefined)
  same('nothing is left armed', pending.filter((t) => t.live).length, 0)
}

/* ------------------------------------------------------------------------ */

console.log(`\nconfig read from: ${sshConfigPath()}  (home ${homedir()})`)
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
