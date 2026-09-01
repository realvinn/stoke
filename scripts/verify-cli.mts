/*
 * Locating the `claude` executable — and, mostly, what happens when the one
 * channel that usually finds it does not.
 *
 * The bug this suite exists for: on a machine where Claude Code is installed
 * through a version manager, `claude` lives in exactly ONE directory, and that
 * directory reaches Stoke only because `mise activate zsh` ran inside an
 * interactive `.zshrc`. A Finder launch inherits `PATH=/usr/bin:/bin:/usr/sbin:
 * /sbin`, so `cli.ts` asks a login shell for its PATH — and that probe was both
 * the only channel and permanently cached on failure. One slow boot therefore
 * produced "Could not find the `claude` executable" for the whole life of the
 * process, on a machine where `claude --version` answered fine a second later,
 * and quitting and reopening was the only cure. Measured, both directions.
 *
 * So the assertions are about the two halves of that: the probe must stop being
 * load-bearing (a version manager's shim dir is searched directly, and needs no
 * shell hook), and a failure must stop being forever.
 *
 * Hermetic on purpose. HOME is redirected into a temp tree, so every
 * home-relative search dir belongs to the suite rather than to whoever is
 * running it — a suite that only passes on one machine is a defect in the
 * suite, not a fact about the machine.
 *
 *   node scripts/verify-cli.mts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROBE_RETRY_MS,
  extraSearchDirs,
  findClaude,
  loginPathProbeFailed,
  notFoundError,
  probeClaude,
  shouldReprobe
} from '../src/main/cli.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`)
}

const sandbox = mkdtempSync(join(tmpdir(), 'stoke-verify-cli-'))
const realHome = process.env.HOME
const realPath = process.env.PATH
const realShell = process.env.SHELL

// ---------------------------------------------------------------------------
// The shim directories. These are what demote the login-shell probe from a
// single point of failure back to an optimisation.
// ---------------------------------------------------------------------------

process.env.HOME = sandbox
delete process.env.MISE_DATA_DIR
delete process.env.ASDF_DATA_DIR
delete process.env.FNM_DIR
delete process.env.XDG_DATA_HOME

check(
  "mise's shim dir is searched, because that is where a mise install of claude is",
  extraSearchDirs().includes(join(sandbox, '.local', 'share', 'mise', 'shims')),
  true
)
check("asdf's shim dir too", extraSearchDirs().includes(join(sandbox, '.asdf', 'shims')), true)
check(
  "and fnm's default alias, which is its nearest equivalent to a stable shim dir",
  extraSearchDirs().includes(join(sandbox, '.local', 'share', 'fnm', 'aliases', 'default', 'bin')),
  true
)

// Each manager lets its data dir be moved, and a hardcoded default would then
// name a directory nothing uses — the same class of mistake as writing to
// ~/.claude.json when .config.json is what actually wins.
process.env.MISE_DATA_DIR = join(sandbox, 'elsewhere', 'mise')
check(
  'MISE_DATA_DIR is honoured ahead of the default',
  extraSearchDirs().includes(join(sandbox, 'elsewhere', 'mise', 'shims')),
  true
)
delete process.env.MISE_DATA_DIR

process.env.XDG_DATA_HOME = join(sandbox, 'xdg')
check(
  'XDG_DATA_HOME moves mise and fnm together',
  [
    extraSearchDirs().includes(join(sandbox, 'xdg', 'mise', 'shims')),
    extraSearchDirs().includes(join(sandbox, 'xdg', 'fnm', 'aliases', 'default', 'bin'))
  ],
  [true, true]
)
delete process.env.XDG_DATA_HOME

// A shim dir has to outrank the system dirs, or a stale /usr/local/bin/claude
// left by an older install would win over the one the user actually manages.
const dirs = extraSearchDirs()
check(
  'shim dirs are searched before /usr/local/bin',
  dirs.indexOf(join(sandbox, '.local', 'share', 'mise', 'shims')) < dirs.indexOf('/usr/local/bin'),
  true
)

// ---------------------------------------------------------------------------
// The retry rule. A failure has to stand long enough that every PTY spawn does
// not pay the timeout again, and nothing like long enough to survive a boot.
// ---------------------------------------------------------------------------

check('with no failure on record, a probe may run', shouldReprobe(0, 1_000_000), true)
check(
  'a probe that has just failed is not retried — that is the stampede this cache exists to stop',
  shouldReprobe(1_000_000, 1_000_000 + PROBE_RETRY_MS - 1),
  false
)
check(
  'but it IS retried the moment the cooldown elapses',
  shouldReprobe(1_000_000, 1_000_000 + PROBE_RETRY_MS),
  true
)
check(
  'a failure is never sticky for the life of the process, which was the whole bug',
  shouldReprobe(1, 1 + 1000 * PROBE_RETRY_MS),
  true
)

// ---------------------------------------------------------------------------
// The message. "Install Claude Code" is a diagnosis the tool can disprove.
// ---------------------------------------------------------------------------

check(
  'a genuine miss still says to install it',
  notFoundError(false).includes('Install Claude Code'),
  true
)
check(
  'a miss caused by a failed probe does NOT, because the CLI may well be installed',
  notFoundError(true).includes('Install Claude Code'),
  false
)
check('...and names the real cause instead', notFoundError(true).includes('login shell'), true)

// ---------------------------------------------------------------------------
// The wire. Everything above is pure; this is the part that actually broke.
// A failed login-shell probe must no longer hide a version-manager install.
// ---------------------------------------------------------------------------

const shims = join(sandbox, '.local', 'share', 'mise', 'shims')
mkdirSync(shims, { recursive: true })
const fake = join(shims, 'claude')
writeFileSync(fake, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n')
chmodSync(fake, 0o755)

// An empty dir as PATH, so nothing the host machine happens to have installed
// can answer instead of the fake, and a $SHELL that cannot be spawned at all,
// so the probe fails immediately rather than after its five-second timeout.
const emptyBin = join(sandbox, 'empty-bin')
mkdirSync(emptyBin, { recursive: true })
process.env.PATH = emptyBin
process.env.SHELL = join(sandbox, 'no-such-shell')

const found = await findClaude(null)
check('a failed login-shell probe no longer hides a version-manager install', found, fake)
check('and the failure is recorded, so the message can name it', loginPathProbeFailed(), true)

// End to end, through the same --version call the CLI chip reads.
const info = await probeClaude(null)
check(
  'probeClaude reports it as usable rather than missing',
  { ok: info.ok, path: info.path, version: info.version, error: info.error },
  { ok: true, path: fake, version: '9.9.9 (Claude Code)', error: null }
)

// An explicit override still wins over everything, probe or no probe.
const override = join(sandbox, 'hand-picked-claude')
writeFileSync(override, '#!/bin/sh\necho "1.2.3 (Claude Code)"\n')
chmodSync(override, 0o755)
check('an explicit path in Settings still outranks the search', await findClaude(override), override)

process.env.HOME = realHome
process.env.PATH = realPath
process.env.SHELL = realShell
rmSync(sandbox, { recursive: true, force: true })

// The tally is the last statement in the file, and must stay that way: anything
// after it is unfalsifiable (gotcha 50).
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
