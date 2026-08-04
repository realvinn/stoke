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
  buildSshArgs,
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

console.log('\nthe real ~/.ssh/config on this machine')

const real = await readSshConfigHosts()
console.log(`  found: ${real.join(', ') || '(none)'}`)

const EXPECTED = [
  'code.vinn.dev',
  'hermes.vinn.dev',
  'github-personal',
  'github-school',
  'gitea-vibe',
  'gitea-company'
]
for (const alias of EXPECTED) {
  check(`${alias} is offered`, real.includes(alias), '')
}
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

console.log('\nargv')
same('no command means a plain login shell', buildSshArgs(host({})), ['vps'])
same(
  '-t is sent whenever a command is',
  buildSshArgs(host({ command: 'byobu' })),
  ['-t', 'vps', 'byobu']
)
check(
  '-t comes before the destination, or ssh reads it as part of the command',
  buildSshArgs(host({ command: 'byobu' }))[0] === '-t',
  ''
)
same(
  'a command with spaces stays exactly one argument',
  buildSshArgs(host({ command: 'tmux new -A -s stoke' })),
  ['-t', 'vps', 'tmux new -A -s stoke']
)
check(
  'and that argument is not split however long it gets',
  buildSshArgs(host({ command: 'cd /srv/app && tmux new -A -s stoke' })).length === 3,
  ''
)
same(
  'shell metacharacters in the command add no argv elements',
  buildSshArgs(host({ command: 'echo "a b"; ls | wc -l' })),
  ['-t', 'vps', 'echo "a b"; ls | wc -l']
)
same(
  'an alias with a space stays one argument',
  buildSshArgs(host({ alias: 'two words' })),
  ['two words']
)
same(
  'an alias with shell metacharacters is not split either',
  buildSshArgs(host({ alias: 'user@host;rm -rf /' })),
  ['user@host;rm -rf /']
)
same(
  'a leading dash is fenced off with --',
  buildSshArgs(host({ alias: '-oProxyCommand=calc' })),
  ['--', '-oProxyCommand=calc']
)
same(
  'and -- sits after -t, since -- ends option parsing',
  buildSshArgs(host({ alias: '-weird', command: 'byobu' })),
  ['-t', '--', '-weird', 'byobu']
)
same(
  'surrounding whitespace is not passed to ssh',
  buildSshArgs(host({ alias: '  vps  ', command: '  byobu  ' })),
  ['-t', 'vps', 'byobu']
)
same(
  'a whitespace-only command is no command',
  buildSshArgs(host({ command: '   ' })),
  ['vps']
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
    const got = await effective(alias)
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

  const dashed = buildSshArgs(host({ alias: '-weird' }))
  const { stdout: dashOut } = await execFileAsync(exe, ['-F', fixture, '-G', ...dashed], {
    encoding: 'utf8',
    timeout: 15000
  })
  check(
    '-- stops ssh reading a leading-dash alias as options',
    /^host -weird$/m.test(dashOut),
    dashed.join(' ')
  )
} finally {
  await rm(dir, { recursive: true, force: true })
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

/* ------------------------------------------------------------------------ */

console.log(`\nconfig read from: ${sshConfigPath()}  (home ${homedir()})`)
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
