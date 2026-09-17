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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// An earlier draft of this message said "this retries by itself shortly", which
// is the same sin one line up: nothing refetches CliInfo on a timer short
// enough to honour it (the only automatic push lands at 12s, inside the
// cooldown, then every six hours). Starting a session does re-probe, so the
// message may tell the user to try again and may not promise to self-heal.
check(
  'the message does not promise a recovery nothing in the app performs',
  /by itself|automatically|on its own/i.test(notFoundError(true)),
  false
)
check(
  'it tells the user to try again instead',
  notFoundError(true).includes('Trying again'),
  true
)
// Derived, not retyped: a cooldown change must not silently make the text lie.
check(
  'and quotes the real cooldown, derived from PROBE_RETRY_MS',
  notFoundError(true).includes(`${Math.round(PROBE_RETRY_MS / 1000)}s re-runs`),
  true
)

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

/*
 * ------------------------------------------------------- STRIP_ENV, in sync
 *
 * Gotcha 1 requires the two copies of this list — `pty.ts` for terminal tabs
 * and `agent.ts` for headless `claude -p` runs — to be identical, and until now
 * nothing said so out loud. They are two hand-maintained literals in two files
 * that are edited for different reasons, which is the exact shape gotcha 62
 * names: two lists that must agree, maintained by hand, will diverge.
 *
 * The failure is silent and it is not small. An inherited `CLAUDECODE` or
 * `CLAUDE_CODE_SESSION_ID` makes the spawned `claude` believe it is a nested
 * child, so it writes no transcript — and with no transcript there is no
 * resume, no context ring and no session in the sidebar. A drift in the agent
 * copy alone would break every worklog run while every terminal tab stayed
 * perfectly fine, which is the version of this bug that would take longest to
 * find.
 *
 * Compared as text rather than by importing either module: `pty.ts` loads
 * `@lydell/node-pty`, a native binding this suite has no reason to pull in, and
 * the thing being protected is the source literal anyway.
 */
function stripEnvList(file: string): string[] {
  const src = readFileSync(new URL(`../src/main/${file}`, import.meta.url), 'utf8')
  const m = /const STRIP_ENV = \[([\s\S]*?)\]/.exec(src)
  if (!m) return []
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

const ptyStrip = stripEnvList('pty.ts')
const agentStrip = stripEnvList('agent.ts')

console.log('\nSTRIP_ENV (gotcha 1): the two copies must not drift')
check('pty.ts has a STRIP_ENV list at all', ptyStrip.length > 0, true)
check('agent.ts has one too', agentStrip.length > 0, true)
check('the two lists are identical, in the same order', agentStrip, ptyStrip)
for (const marker of [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID'
]) {
  check(`${marker} is stripped, or the child writes no transcript`, ptyStrip.includes(marker), true)
}
/*
 * The other direction, and the one that would be a real incident: these carry
 * the user's credentials and the config the CLI is meant to obey. Stripping one
 * would sign the user out of a session Stoke started, or silently ignore their
 * configuration, and no test above would notice.
 */
for (const keep of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH']) {
  check(`${keep} is NOT stripped`, ptyStrip.includes(keep), false)
}

rmSync(sandbox, { recursive: true, force: true })

// The tally is the last statement in the file, and must stay that way: anything
// after it is unfalsifiable (gotcha 50).
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
