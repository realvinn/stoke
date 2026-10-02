/*
 * The title bar's git chip (main/gitStatus.ts, shared/gitStatus.ts), against
 * REAL repositories made here with the real `git`: clean, dirty, conflicted,
 * ahead/behind as of a fetch, an upstream that is gone, detached, unborn, a
 * linked worktree, a subfolder, no repository at all — and a booby-trapped
 * repository whose `core.fsmonitor` hook and `filter.<x>.clean` command must
 * NOT run (gotcha 147), each beside a control proving the trap is live.
 *
 * Hermetic: every repository is under one mkdtemp folder, and the folder is
 * removed at the end. The fixtures are built by git with a scratch global
 * config (`GIT_CONFIG_GLOBAL`) and no system config, so neither the owner's
 * signing, hooks nor aliases reach them. The reader under test is handed a
 * scratch HOME instead (`readerEnv`): `gitEnv` drops every `GIT_*` variable,
 * so `GIT_CONFIG_GLOBAL` never reaches its git, which read the owner's own
 * ~/.gitconfig until 2026-10-02 — a `status.showUntrackedFiles=no` there would
 * have failed this suite on that one machine.
 *
 *   node scripts/verify-git.mts
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeGitError,
  findGit,
  gitEnv,
  GitStatusReader,
  readGitStatus,
  type GitDeps
} from '../src/main/gitStatus.ts'
import {
  changeCount,
  filterOverrides,
  gitChip,
  GIT_STALE_MS,
  parseHead,
  parseStatusV2,
  shownGitStatus,
  type GitStatus
} from '../src/shared/gitStatus.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}

/* ------------------------------------------------------------ pure parts */

console.log('parsing porcelain v2')
{
  const clean = parseStatusV2('# branch.oid 1234567890abcdef1234567890abcdef12345678\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n')
  check('a clean branch with an upstream', clean, {
    oid: '1234567',
    unborn: false,
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead: 2,
    behind: 3,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  })
  const dirty = parseStatusV2(
    [
      '# branch.oid (initial)',
      '# branch.head main',
      '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 new.txt',
      '1 .M N... 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 a file with spaces.txt',
      '1 MM N... 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 both.txt',
      '2 R. N... 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 R100 to.txt\tfrom.txt',
      'u UU N... 100644 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 c.txt',
      '? untracked.txt',
      '? "quoted\\nname"',
      ''
    ].join('\n')
  )
  check('staged, modified, both, renamed, conflicted, untracked', dirty.changes, { staged: 3, unstaged: 2, untracked: 2, conflicts: 1 })
  check('an unborn branch', [dirty.unborn, dirty.oid, dirty.branch], [true, null, 'main'])
  check('a detached HEAD', parseStatusV2('# branch.oid abcdef0123456789abcdef0123456789abcdef01\n# branch.head (detached)\n'), {
    oid: 'abcdef0',
    unborn: false,
    branch: null,
    detached: true,
    upstream: null,
    ahead: null,
    behind: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  })
  check('an upstream with no ab line (gone) keeps ahead/behind unknown', parseStatusV2('# branch.head x\n# branch.upstream origin/x\n').ahead, null)
  check('changeCount', changeCount({ staged: 1, unstaged: 2, untracked: 3, conflicts: 4 }), 10)
  check('HEAD on a branch', parseHead('ref: refs/heads/feature/x\n'), { branch: 'feature/x', oid: null, detached: false })
  check('HEAD detached', parseHead('abcdef0123456789abcdef0123456789abcdef01\n'), { branch: null, oid: 'abcdef0', detached: true })
  check('HEAD unreadable', parseHead(''), { branch: null, oid: null, detached: false })
}

console.log('\nwhich filters a status empties (gotcha 147)')
{
  check('none configured: nothing to add', filterOverrides(''), [])
  check(
    'the repo’s own filter is emptied; the user’s own (global, system: git-lfs) is left on',
    filterOverrides('global\0filter.lfs.clean\0system\0filter.sys.process\0local\0filter.ev.clean\0worktree\0filter.wt.process\0'),
    ['-c', 'filter.ev.clean=', '-c', 'filter.ev.process=', '-c', 'filter.ev.required=false', '-c', 'filter.wt.clean=', '-c', 'filter.wt.process=', '-c', 'filter.wt.required=false']
  )
  check('a scope it does not know is emptied', filterOverrides('command\0filter.x.clean\0').length, 6)
  check('one name, several keys: once', filterOverrides('local\0filter.ev.clean\0local\0filter.ev.smudge\0local\0filter.ev.required\0').length, 6)
  check('a dotted name keeps its dots', filterOverrides('local\0filter.a.b.clean\0')[1], 'filter.a.b.clean=')
  check('a name -c cannot carry (an "=") refuses the whole status', filterOverrides('local\0filter.a=b.clean\0'), null)
}

console.log('\nwhat the chip says, and never a stale clean')
{
  const base: GitStatus = {
    repo: true,
    root: '/r',
    branch: 'main',
    oid: 'abc1234',
    detached: false,
    unborn: false,
    upstream: 'origin/main',
    upstreamGone: false,
    ahead: 1,
    behind: 0,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
    worktree: null,
    error: null,
    at: 1000
  }
  const c = gitChip(base)
  check('a clean branch: zero changes, ahead 1', [c?.head, c?.changes, c?.ahead, c?.behind], ['main', 0, 1, 0])
  check('the tooltip says ahead/behind is as of the last fetch', /as of your last fetch/.test(c?.title ?? ''), true)
  check('unknown changes are null, not zero', gitChip({ ...base, changes: null, error: 'git took too long to answer' })?.changes, null)
  check('and the tooltip says why', /took too long/.test(gitChip({ ...base, changes: null, error: 'git took too long to answer' })?.title ?? ''), true)
  check('no repository draws nothing', [gitChip({ ...base, repo: false }), gitChip(null)], [null, null])
  check('detached shows the commit', gitChip({ ...base, branch: null, detached: true })?.head, 'abc1234')
  check('a linked worktree is tagged', gitChip({ ...base, worktree: { main: '/m', name: 'wt' } })?.worktree, 'worktree')
  check('a reading inside GIT_STALE_MS is shown as it is', shownGitStatus(base, 1000 + GIT_STALE_MS)?.changes, base.changes)
  const old = shownGitStatus(base, 1001 + GIT_STALE_MS)
  check('an older one shows its branch but NOT its changes or ahead/behind', [old?.branch, old?.changes, old?.ahead, old?.behind], ['main', null, null, null])
}

console.log('\nerrors read killed first (gotcha 25)')
{
  type E = Parameters<typeof describeGitError>[0]
  const err = (e: Record<string, unknown>, stderr = ''): E => ({ stdout: '', stderr, error: Object.assign(new Error('x'), e) }) as E
  check('a timeout that ALSO carries a numeric code is a timeout', describeGitError(err({ killed: true, code: 143 })), 'git took too long to answer')
  check('a maxBuffer overrun', describeGitError(err({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })), 'too many changes to count')
  check('no git', describeGitError(err({ code: 'ENOENT' })), 'git was not found')
  check('an exit with a fatal line quotes it', describeGitError(err({ code: 128 }, 'fatal: detected dubious ownership in repository\n')), 'detected dubious ownership in repository')
  check('git’s own variables never reach it', Object.keys(gitEnv({ GIT_DIR: '/x', GIT_WORK_TREE: '/y', PATH: 'p' })).sort(), ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'LC_ALL', 'PATH'])
}

/* ------------------------------------------------------ real repositories */

/*
 * `.native`: on a Windows runner TEMP is `C:\Users\RUNNER~1\…`, an 8.3 short
 * name the JS realpath keeps and the reader's own (native) `realpath` expands,
 * so every root compared below would have differed (verify:folders met the
 * same: twenty-five checks red on the Windows leg).
 */
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stoke-verify-git-')))
const slash = (p: string): string => p.replace(/\\/g, '/')
const globalConfig = join(base, 'gitconfig')
writeFileSync(globalConfig, '')
const env: NodeJS.ProcessEnv = {
  ...gitEnv(process.env),
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Stoke Verify',
  GIT_AUTHOR_EMAIL: 'verify@example.invalid',
  GIT_COMMITTER_NAME: 'Stoke Verify',
  GIT_COMMITTER_EMAIL: 'verify@example.invalid'
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const gitTolerant = (cwd: string, ...args: string[]): void => {
  try {
    git(cwd, ...args)
  } catch {
    /* a merge that stops on a conflict exits 1, which is the point */
  }
}
/*
 * The reader's environment. `readGitStatus` runs `gitEnv` over it, which drops
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM with every other `GIT_*`, so the
 * scratch config above never reached its git: it read the owner's real
 * ~/.gitconfig. A scratch HOME is the one route that survives `gitEnv`.
 */
const home = join(base, 'home')
mkdirSync(join(home, '.config'), { recursive: true })
writeFileSync(join(home, '.gitconfig'), '[stoke]\n\tverify = scratch\n')
const readerEnv: NodeJS.ProcessEnv = { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') }
// process.env, never `env`: on Windows the copied key is `Path`, so `env.PATH`
// is undefined there and no git would be found.
const gitBin = await findGit(process.env.PATH ?? '')
const deps: GitDeps = { git: async () => gitBin, env: async () => readerEnv }
const read = (p: string): Promise<GitStatus> => readGitStatus(p, deps)
const repo = (name: string): string => {
  const dir = join(base, name)
  git(base, 'init', '-q', '-b', 'main', dir)
  return dir
}
const commit = (dir: string, file: string, text: string, msg = file): void => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', msg)
}
const pick = (s: GitStatus): Record<string, unknown> => ({
  repo: s.repo,
  branch: s.branch,
  detached: s.detached,
  unborn: s.unborn,
  upstream: s.upstream,
  upstreamGone: s.upstreamGone,
  ahead: s.ahead,
  behind: s.behind,
  changes: s.changes,
  worktree: s.worktree,
  error: s.error
})
const ZERO = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }

try {
  check('a git to run was found on PATH', gitBin !== null, true)
  check(
    'the reader’s git reads the scratch global config, never the machine owner’s',
    await (async () => {
      try {
        return execFileSync(gitBin ?? 'git', ['config', '--global', '--get', 'stoke.verify'], { env: gitEnv(await deps.env()), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      } catch {
        return null // exit 1: not set in whatever global config it read
      }
    })(),
    'scratch'
  )

  console.log('\nreal repositories')

  const plain = join(base, 'not-a-repo')
  mkdirSync(plain)
  let asked = 0
  const counting: GitDeps = { git: async () => (asked++, gitBin), env: async () => readerEnv }
  const none = await readGitStatus(plain, counting)
  check('a folder in no repository: no repo, and git was never even looked for', [none.repo, none.root, asked], [false, null, 0])

  const clean = repo('clean')
  commit(clean, 'a.txt', 'one\n')
  check('clean: the branch, no upstream, zero changes', pick(await read(clean)), {
    repo: true,
    branch: 'main',
    detached: false,
    unborn: false,
    upstream: null,
    upstreamGone: false,
    ahead: null,
    behind: null,
    changes: ZERO,
    worktree: null,
    error: null
  })
  const sub = join(clean, 'src', 'deep')
  mkdirSync(sub, { recursive: true })
  check('a subfolder reads its repository', [(await read(sub)).root, (await read(sub)).branch], [clean, 'main'])

  const dirty = repo('dirty')
  commit(dirty, 'tracked.txt', 'one\n')
  writeFileSync(join(dirty, 'tracked.txt'), 'two\n')
  writeFileSync(join(dirty, 'staged.txt'), 'new\n')
  git(dirty, 'add', 'staged.txt')
  writeFileSync(join(dirty, 'loose.txt'), 'untracked\n')
  check('dirty: one staged, one modified, one untracked', (await read(dirty)).changes, { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 })

  const conflicted = repo('conflicted')
  commit(conflicted, 'c.txt', 'base\n')
  git(conflicted, 'checkout', '-q', '-b', 'other')
  commit(conflicted, 'c.txt', 'theirs\n')
  git(conflicted, 'checkout', '-q', 'main')
  commit(conflicted, 'c.txt', 'ours\n')
  gitTolerant(conflicted, 'merge', '-q', 'other')
  check('a merge conflict counts as one conflicted path', (await read(conflicted)).changes?.conflicts, 1)

  const unborn = repo('unborn')
  check('unborn: the branch from HEAD, no commit, zero changes', pick(await read(unborn)), {
    repo: true,
    branch: 'main',
    detached: false,
    unborn: true,
    upstream: null,
    upstreamGone: false,
    ahead: null,
    behind: null,
    changes: ZERO,
    worktree: null,
    error: null
  })

  const detached = repo('detached')
  commit(detached, 'a.txt', '1\n')
  commit(detached, 'b.txt', '2\n')
  git(detached, 'checkout', '-q', '--detach', 'HEAD~1')
  const d = await read(detached)
  check('detached: no branch, the short commit', [d.detached, d.branch, d.oid?.length], [true, null, 7])

  // Ahead and behind, as of a fetch: one commit each way.
  const origin = join(base, 'origin.git')
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  const work = repo('work')
  commit(work, 'a.txt', '1\n')
  git(work, 'remote', 'add', 'origin', origin)
  git(work, 'push', '-q', '-u', 'origin', 'main')
  const other = join(base, 'other')
  git(base, 'clone', '-q', origin, other)
  commit(other, 'theirs.txt', 'x\n')
  git(other, 'push', '-q', 'origin', 'main')
  commit(work, 'ours.txt', 'y\n')
  const beforeFetch = await read(work)
  check('before a fetch, only what is known: ahead 1, behind 0', [beforeFetch.upstream, beforeFetch.ahead, beforeFetch.behind], ['origin/main', 1, 0])
  git(work, 'fetch', '-q', 'origin')
  const afterFetch = await read(work)
  check('after one: ahead 1, behind 1', [afterFetch.ahead, afterFetch.behind], [1, 1])
  check('and the poll itself never fetched: a second clone’s push is not seen until the next fetch', await (async () => {
    commit(other, 'more.txt', 'z\n')
    git(other, 'push', '-q', 'origin', 'main')
    const r = await read(work)
    return [r.ahead, r.behind]
  })(), [1, 1])

  git(work, 'checkout', '-q', '-b', 'gone')
  git(work, 'push', '-q', '-u', 'origin', 'gone')
  git(work, 'push', '-q', 'origin', '--delete', 'gone')
  const gone = await read(work)
  check('an upstream deleted on the remote reads as gone, ahead/behind unknown', [gone.upstream, gone.upstreamGone, gone.ahead, gone.behind], ['origin/gone', true, null, null])
  git(work, 'checkout', '-q', 'main')

  // A linked worktree of `clean`.
  const wt = join(base, 'wt-feature')
  git(clean, 'worktree', 'add', '-q', '-b', 'feature', wt)
  const w = await read(wt)
  check('a linked worktree: its own branch, tagged with the main work tree', [w.branch, w.root, w.worktree], ['feature', wt, { main: clean, name: 'wt-feature' }])
  check('and the main work tree is not tagged', (await read(clean)).worktree, null)

  console.log('\nnever a stale "clean"')
  /*
   * A git that answers `status` only after 2 s, so the deadline fires every time. This used to be
   * the real git under a 1 ms deadline, which is a race, not a test: on the v1.0.0-beta.1 release
   * gate (2026-10-02) a fast Linux runner's git answered first and the gate went red. The stand-in
   * is a POSIX script; the deadline itself is execFile's timeout, the same code on every platform.
   */
  if (process.platform !== 'win32') {
    const slowGit = join(base, 'slow-git')
    writeFileSync(slowGit, `#!/bin/sh\ncase "$*" in *status*) sleep 2 ;; esac\nexec ${JSON.stringify(gitBin)} "$@"\n`, { mode: 0o755 })
    const slow = await readGitStatus(dirty, { ...deps, git: async () => slowGit, timeouts: { status: 300 } })
    check('a status past its deadline: the branch from HEAD, changes UNKNOWN, and why', [slow.repo, slow.branch, slow.changes, slow.error], [true, 'main', null, 'git took too long to answer'])
  } else {
    console.log('  SKIP  a status past its deadline: the slow stand-in git is a POSIX script (the timeout is execFile\'s, the same on every platform)')
  }
  const noGit = await readGitStatus(clean, { git: async () => null, env: async () => readerEnv })
  check('no git at all: the branch still, changes unknown', [noGit.branch, noGit.changes, noGit.error], ['main', null, 'git was not found'])

  console.log('\nrunning no repo code (gotcha 147)')
  {
    const trap = repo('trap')
    commit(trap, 'f.txt', 'content\n')
    const fsMarker = join(base, 'FSMONITOR_RAN')
    const filterMarker = join(base, 'FILTER_RAN')
    const hookMarker = join(base, 'INDEX_HOOK_RAN')
    const script = (name: string, marker: string, body = ''): string => {
      const p = join(base, name)
      writeFileSync(p, `#!/bin/sh\ntouch '${slash(marker)}'\n${body}`)
      chmodSync(p, 0o755)
      return slash(p)
    }
    git(trap, 'config', 'core.fsmonitor', script('fsmonitor.sh', fsMarker, 'exit 1\n'))
    git(trap, 'config', 'filter.ev.clean', script('clean.sh', filterMarker, 'cat\n'))
    writeFileSync(join(trap, '.git', 'info', 'attributes'), '* filter=ev\n')
    mkdirSync(join(trap, '.git', 'hooks'), { recursive: true })
    script(join('trap', '.git', 'hooks', 'post-index-change'), hookMarker)
    const statDirty = (): void => {
      const t = new Date(Date.now() + 60_000 + Math.random() * 60_000)
      utimesSync(join(trap, 'f.txt'), t, t)
    }
    const clear = (): void => {
      for (const m of [fsMarker, filterMarker, hookMarker]) rmSync(m, { force: true })
    }

    // Controls: the traps are live, so the checks below can fail.
    clear()
    statDirty()
    git(trap, 'status', '--porcelain=v2')
    check('control: a plain git status RUNS the repo’s fsmonitor hook', existsSync(fsMarker), true)
    check('control: and its clean filter, on a stat-dirty file', existsSync(filterMarker), true)

    clear()
    statDirty()
    const r = await read(trap)
    check('Stoke’s status runs the fsmonitor hook: never', existsSync(fsMarker), false)
    check('nor the repo’s clean filter', existsSync(filterMarker), false)
    check('nor writes the index (no post-index-change hook)', existsSync(hookMarker), false)
    check('and still answers', [r.repo, r.branch, r.error], [true, 'main', null])
  }

  console.log('\none git per folder at a time (gotcha 20)')
  {
    let runs = 0
    const reader = new GitStatusReader({ git: async () => (runs++, gitBin), env: async () => readerEnv }, 60_000)
    const [a, b] = await Promise.all([reader.read(clean), reader.read(clean)])
    check('two asks at once share one run', [runs, a === b], [1, true])
    await reader.read(clean)
    check('an ask inside the cache window is answered from it', runs, 1)
    await reader.read(clean, true)
    check('a fresh ask (a click) runs again', runs, 2)
    check('nothing left in flight', reader.running, 0)
  }

  console.log('\nfinding git')
  {
    const bin = join(base, 'bin')
    mkdirSync(bin)
    const fake = join(bin, process.platform === 'win32' ? 'git.exe' : 'git')
    writeFileSync(fake, '#!/bin/sh\nexit 0\n')
    chmodSync(fake, 0o755)
    const sep = process.platform === 'win32' ? ';' : ':'
    check('the first git on PATH, skipping folders without one', await findGit([join(base, 'nowhere'), bin].join(sep)), fake)
    check('an empty PATH finds none', await findGit(''), null)
    if (existsSync('/usr/bin/git')) {
      check('macOS: the /usr/bin/git stub is skipped without the Command Line Tools', await findGit('/usr/bin', { platform: 'darwin', cltInstalled: async () => false }), null)
      check('and taken with them', await findGit('/usr/bin', { platform: 'darwin', cltInstalled: async () => true }), '/usr/bin/git')
    } else {
      console.log('  note  no /usr/bin/git here: the macOS stub rule is held by the Mac and Linux runs')
    }
  }
} finally {
  rmSync(base, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
