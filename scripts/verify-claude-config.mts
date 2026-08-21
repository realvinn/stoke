/*
 * Writing into somebody else's config file.
 *
 * Stoke edits two files it does not own. `~/.claude/settings.json` is small and
 * hand-owned; `~/.claude.json` is 155 KB, rewritten constantly by every live
 * session, and losing it costs the account — a parse failure makes Claude Code
 * back it up and then reset to defaults, destroying `oauthAccount`, `userID`
 * and every project entry. So the interesting assertions here are not "does the
 * value round-trip" but "does it refuse when it should", and they run against
 * real files in a scratch directory rather than against a mock.
 *
 * CLAUDE_CONFIG_DIR is what makes that safe: every path function reads it, so
 * the whole suite is pointed at a temp tree and the real config is never opened.
 *
 *   node scripts/verify-claude-config.mts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeConfigDir,
  claudeGlobalConfigLockPath,
  claudeGlobalConfigPath,
  claudeSettingsPath
} from '../src/main/claudePaths.ts'
import { validateSetting, validateWorkflowSize, CLAUDE_SETTINGS, NEVER_OFFERED } from '../src/shared/claudeConfig.ts'

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

/* ------------------------------------------------------------------ paths */

console.log('\nwhere Claude Code keeps its own files')

const POSIX = { CLAUDE_CONFIG_DIR: undefined } as unknown as NodeJS.ProcessEnv
check(
  'settings live under the config dir',
  claudeSettingsPath(POSIX, '/home/x'),
  join('/home/x', '.claude', 'settings.json')
)
check(
  // The asymmetry that trips people: settings.json is INSIDE ~/.claude, the
  // global config is a sibling of it.
  'the global config is one level up from the settings, not beside them',
  claudeGlobalConfigPath(POSIX, '/home/x'),
  join('/home/x', '.claude.json')
)
check(
  'CLAUDE_CONFIG_DIR moves both',
  [
    claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/cfg' } as NodeJS.ProcessEnv, '/home/x'),
    claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: '/cfg' } as NodeJS.ProcessEnv, '/home/x')
  ],
  [join('/cfg', 'settings.json'), join('/cfg', '.claude.json')]
)
check(
  'the lock sits beside the config it guards',
  claudeGlobalConfigLockPath(POSIX, '/home/x'),
  `${join('/home/x', '.claude.json')}.lock`
)
check('the config dir is the settings dir', claudeConfigDir(POSIX, '/home/x'), join('/home/x', '.claude'))

/* ------------------------------------------------------------ validation */

console.log('\nwhat may be written, and what may not')

check('a boolean key takes a boolean', validateSetting('remoteControlAtStartup', false), null)
check(
  'and refuses a string',
  validateSetting('remoteControlAtStartup', 'false')?.includes('true or false'),
  true
)
check(
  // Unset is not a rejection to be tolerated - it is the only way back to the
  // CLI's own default once a key has been written, and the state that made
  // Remote Control turn itself on.
  'unset is allowed for every key',
  CLAUDE_SETTINGS.map((s) => validateSetting(s.key, undefined)).filter(Boolean),
  []
)
check('an enum takes one of its own options', validateSetting('effortLevel', 'xhigh'), null)
ok(
  'effortLevel refuses "max" — the schema is low|medium|high|xhigh and carries .catch(void 0), ' +
    'so writing max leaves the session with NO effort level, silently',
  validateSetting('effortLevel', 'max') !== null,
  String(validateSetting('effortLevel', 'max'))
)
ok(
  'and says so, rather than only rejecting it',
  (validateSetting('effortLevel', 'max') ?? '').includes('without saying so'),
  String(validateSetting('effortLevel', 'max'))
)
check('an integer key refuses a fraction', validateSetting('cleanupPeriodDays', 1.5) !== null, true)
check('and refuses zero, which the CLI rejects too', validateSetting('cleanupPeriodDays', 0) !== null, true)
check('but takes its minimum', validateSetting('cleanupPeriodDays', 1), null)

console.log('\nkeys Stoke must never write')
for (const key of ['statusLine', 'ultracode', 'apiKeyHelper', 'permissions', 'hasTrustDialogAccepted']) {
  ok(`${key} is refused`, validateSetting(key, true) !== null)
}
ok(
  // statusLine and ultracode are not merely dangerous - Stoke passes its own
  // --settings file, which is flagSettings and OUTRANKS ~/.claude/settings.json.
  // A control for either would visibly move and change nothing.
  'the two keys Stoke’s own --settings file outranks are on the never-offer list',
  NEVER_OFFERED.includes('statusLine') && NEVER_OFFERED.includes('ultracode')
)
ok(
  'no key is both drawn and never-offered',
  CLAUDE_SETTINGS.every((s) => !NEVER_OFFERED.includes(s.key)),
  CLAUDE_SETTINGS.filter((s) => NEVER_OFFERED.includes(s.key))
    .map((s) => s.key)
    .join(', ')
)
ok(
  'every enum spec actually carries options',
  CLAUDE_SETTINGS.every((s) => s.kind !== 'enum' || (s.options?.length ?? 0) > 0)
)

check('a workflow size takes one of four', validateWorkflowSize('unrestricted'), null)
check('and refuses anything else', validateWorkflowSize('enormous') !== null, true)
check('unset is fine there too', validateWorkflowSize(undefined), null)

/* ------------------------------------------------------- the real files */

const scratch = mkdtempSync(join(tmpdir(), 'stoke-claude-config-'))
process.env.CLAUDE_CONFIG_DIR = scratch
mkdirSync(scratch, { recursive: true })

// Imported AFTER CLAUDE_CONFIG_DIR is set. These modules read process.env at
// call time, not at import time, but pinning the order makes that explicit
// rather than something a later edit could quietly break.
const { patchClaudeSetting, untouchedKeys } = await import(
  '../src/main/claudeSettings.ts'
)
const { readGlobalConfigKey, writeGlobalConfigKey } = await import(
  '../src/main/claudeGlobalConfig.ts'
)

const settingsFile = join(scratch, 'settings.json')
const globalFile = join(scratch, '.claude.json')
const lockDir = `${globalFile}.lock`

console.log('\npatching settings.json')

writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      // The shapes a round trip would destroy. enabledPlugins is a union of
      // boolean | string[] | object, and flattening one silently changes which
      // plugins resolve.
      enabledPlugins: { 'a@b': true, 'c@d': ['>=1.0.0'] },
      statusLine: { type: 'command', command: 'x' },
      someKeyFromAFutureVersion: { nested: [1, 2, 3] },
      effortLevel: 'low'
    },
    null,
    2
  )
)

let result = await patchClaudeSetting('remoteControlAtStartup', false)
ok('a write reports success', result.ok, String(result.error))
check(
  'the new key landed',
  JSON.parse(readFileSync(settingsFile, 'utf8')).remoteControlAtStartup,
  false
)
check(
  'and every unknown key survived verbatim',
  JSON.parse(readFileSync(settingsFile, 'utf8')).enabledPlugins,
  { 'a@b': true, 'c@d': ['>=1.0.0'] }
)
check(
  'including one Stoke refuses to draw',
  JSON.parse(readFileSync(settingsFile, 'utf8')).statusLine,
  { type: 'command', command: 'x' }
)
check(
  'and one from a version that does not exist yet',
  JSON.parse(readFileSync(settingsFile, 'utf8')).someKeyFromAFutureVersion,
  { nested: [1, 2, 3] }
)

result = await patchClaudeSetting('effortLevel', undefined)
ok('clearing a key reports success', result.ok, String(result.error))
ok(
  // Not `null`, not `false`. Absent is a distinct state the CLI reads
  // differently, and writing null would be a value it has to cope with.
  'unset DELETES the key rather than writing null',
  !('effortLevel' in JSON.parse(readFileSync(settingsFile, 'utf8')))
)

result = await patchClaudeSetting('effortLevel', 'max')
ok('a bad enum value is refused before it reaches the file', !result.ok)
ok('and the file is untouched', !('effortLevel' in JSON.parse(readFileSync(settingsFile, 'utf8'))))

result = await patchClaudeSetting('statusLine', 'anything')
ok('a never-offered key is refused', !result.ok, String(result.error))

const written = readFileSync(settingsFile, 'utf8')
ok('no BOM is ever emitted — one breaks the CLI’s parse silently', written.charCodeAt(0) === 0x7b)
ok('and the file still parses', (() => { JSON.parse(written); return true })())

check(
  'untouched keys are named, not hidden',
  untouchedKeys(JSON.parse(written), CLAUDE_SETTINGS.map((s) => s.key)),
  ['enabledPlugins', 'someKeyFromAFutureVersion']
)

console.log('\nrefusing to write a settings file it could not read')
writeFileSync(settingsFile, '{ "broken": ')
result = await patchClaudeSetting('remoteControlAtStartup', true)
ok('an unparseable file is refused, not repaired', !result.ok, String(result.error))
check('and left exactly as found', readFileSync(settingsFile, 'utf8'), '{ "broken": ')

/* --------------------------------------------------------- global config */

console.log('\nthe global config, which is the one that can cost an account')

const goodConfig = {
  oauthAccount: { accountUuid: 'x' },
  userID: 'abc',
  numStartups: 12,
  projects: { '/p': { lastCost: 1 } }
}

const resetGlobal = (body: unknown = goodConfig): void =>
  writeFileSync(globalFile, JSON.stringify(body, null, 2))

resetGlobal()
let write = await writeGlobalConfigKey('workflowSizeGuideline', 'large')
ok('a locked write lands', write.ok, String(write.error))
check('and reads back', readGlobalConfigKey('workflowSizeGuideline').value, 'large')
check(
  'without disturbing anything else',
  JSON.parse(readFileSync(globalFile, 'utf8')).projects,
  { '/p': { lastCost: 1 } }
)
ok('the lock is released', !existsSync(lockDir))
check(
  // The CLI writes this file with no trailing newline. Matching it keeps
  // Stoke's writes from showing up as a whole-file diff to anyone watching.
  'the CLI’s own byte shape is matched: 2-space indent, no trailing newline',
  [readFileSync(globalFile, 'utf8').slice(0, 3), readFileSync(globalFile, 'utf8').slice(-2)],
  ['{\n ', '\n}']
)

write = await writeGlobalConfigKey('workflowSizeGuideline', undefined)
ok('clearing it lands too', write.ok, String(write.error))
ok('and the key is gone', !('workflowSizeGuideline' in JSON.parse(readFileSync(globalFile, 'utf8'))))

console.log('\nand the four times it must refuse')

resetGlobal()
writeFileSync(globalFile, '{ "oauthAccount": {}, ')
write = await writeGlobalConfigKey('workflowSizeGuideline', 'small')
ok(
  'an unparseable global config is refused — writing over one is exactly how ' +
    'the CLI resets to defaults and loses the account',
  !write.ok,
  String(write.error)
)
check('and it is left byte-identical', readFileSync(globalFile, 'utf8'), '{ "oauthAccount": {}, ')

resetGlobal([1, 2, 3])
write = await writeGlobalConfigKey('workflowSizeGuideline', 'small')
ok('an array is not a config', !write.ok, String(write.error))

resetGlobal({ numStartups: 3 })
write = await writeGlobalConfigKey('workflowSizeGuideline', 'small')
ok(
  'a config with no sign-in is refused — dropping the auth keys freezes the ' +
    'CLI’s own persistence, not just this write',
  !write.ok,
  String(write.error)
)

rmSync(globalFile)
write = await writeGlobalConfigKey('workflowSizeGuideline', 'small')
ok('a missing config is never created', !write.ok, String(write.error))
ok('and none appeared', !existsSync(globalFile))

/* ------------------------------------------------------------- the lock */

console.log('\nthe lock, which the CLI will not wait for')

resetGlobal()

mkdirSync(lockDir)
const fresh = new Date()
utimesSync(lockDir, fresh, fresh)
write = await writeGlobalConfigKey('workflowSizeGuideline', 'medium')
ok(
  // The CLI acquires with retries:0 and falls through to an UNLOCKED write
  // rather than waiting. Stoke blocking forever would be worse than the race,
  // so it proceeds - and the verify-after-write is what makes that safe.
  'a lock held by somebody else does not block the write forever',
  write.ok,
  String(write.error)
)
ok('it reports that it went ahead unlocked', write.wroteUnlocked)
ok('and it did not steal a fresh lock', existsSync(lockDir))
rmSync(lockDir, { recursive: true })

mkdirSync(lockDir)
const old = new Date(Date.now() - 30_000)
utimesSync(lockDir, old, old)
write = await writeGlobalConfigKey('workflowSizeGuideline', 'small')
ok('a stale lock directory is broken, the same rule the CLI uses at 10s', write.ok, String(write.error))
ok('and not left behind', !existsSync(lockDir))
ok('so the write was properly locked', !write.wroteUnlocked)

// A lock FILE is not something proper-lockfile ever creates - and it is worse
// than a stale directory, because the CLI breaks a stale lock with rmdir, which
// can never remove a file. One left here degrades every CLI config write to the
// unlocked, un-backed-up path permanently. Removing it repairs the CLI.
writeFileSync(lockDir, '')
utimesSync(lockDir, old, old)
write = await writeGlobalConfigKey('workflowSizeGuideline', 'large')
ok('a STALE lock file is unlinked, which rmdir could never do', write.ok, String(write.error))
ok('and the CLI’s locking is repaired rather than left wedged', !existsSync(lockDir))

writeFileSync(lockDir, '')
write = await writeGlobalConfigKey('workflowSizeGuideline', 'small')
ok('but a FRESH non-directory is left alone', existsSync(lockDir) && statSync(lockDir).isFile())
rmSync(lockDir)

console.log('\nthe .config.json override')
// Reset first: the lock section above wrote this key into .claude.json several
// times, so without this the "untouched" assertion below would be reading that
// history rather than what the override write did. It failed exactly that way
// the first time it ran.
resetGlobal()
const overridePath = join(scratch, '.config.json')
writeFileSync(overridePath, JSON.stringify(goodConfig, null, 2))
check(
  // Verified live against the real CLI: with both present it wrote .config.json
  // and never touched .claude.json. A writer that assumed the latter would be
  // editing a file nothing reads.
  '.config.json wins outright when it exists',
  claudeGlobalConfigPath(process.env, '/unused'),
  overridePath
)
write = await writeGlobalConfigKey('workflowSizeGuideline', 'medium')
ok('and is what gets written', write.ok, String(write.error))
check('there', JSON.parse(readFileSync(overridePath, 'utf8')).workflowSizeGuideline, 'medium')
check(
  'while the other file is untouched',
  'workflowSizeGuideline' in JSON.parse(readFileSync(globalFile, 'utf8')),
  false
)

/* ------------------------------- the retry loop, against a real racing writer
 *
 * This is the one path in the whole feature that can cost an account, and until
 * now nothing exercised it — the existing cases above all write into a file
 * nobody else is touching, so `attempts` was always 1 and the verify-and-retry
 * loop never actually ran.
 *
 * Gotcha 38 is the reason it exists: a live `claude` re-reads this file inside
 * its own critical section and writes back what it read, so a write that lands
 * between its read and its rename is silently reverted. `writeGlobalConfigKey`
 * answers that by waiting SETTLE_MS, reading the key back, and trying again if
 * it did not survive. Here that is provoked deliberately: a clobberer rewrites
 * the file part-way through the settle window with the key stripped out, which
 * is exactly the shape of the loss.
 */
console.log('\na write that a running session reverts is retried, not reported as success')

/*
 * The override file the case above created has to go first, or this races
 * nothing at all: `<CLAUDE_CONFIG_DIR>/.config.json` WINS over `.claude.json`
 * (gotcha 38's third trap), so with it present the module writes to one file
 * while a clobberer hammers the other, and the write sails through on attempt
 * 1 looking like proof that the retry loop is unnecessary. Which is exactly
 * what this suite reported the first time it was written.
 */
rmSync(overridePath, { force: true })
resetGlobal()
const clobberAt = setTimeout(() => {
  // A different writer entirely: it keeps its own key, drops ours.
  writeFileSync(globalFile, JSON.stringify({ ...goodConfig, numStartups: 99 }, null, 2))
}, 400)

const raced = await writeGlobalConfigKey('workflowSizeGuideline', 'large')
clearTimeout(clobberAt)

ok('the write still reports success', raced.ok, String(raced.error))
ok(
  'but it took more than one attempt — the first was reverted underneath it',
  (raced.attempts ?? 1) > 1,
  `attempts=${raced.attempts}`
)
check(
  'and the value that survived is ours',
  readGlobalConfigKey('workflowSizeGuideline').value,
  'large'
)
check(
  "while the other writer's own change survived too, so the retry re-read from disk rather than replaying a stale object",
  JSON.parse(readFileSync(globalFile, 'utf8')).numStartups,
  99
)
ok(
  'the sign-in keys are still there, which is the thing gotcha 38 is about',
  'oauthAccount' in JSON.parse(readFileSync(globalFile, 'utf8')),
  JSON.stringify(Object.keys(JSON.parse(readFileSync(globalFile, 'utf8'))))
)
ok('and no lock directory is left behind', !existsSync(lockDir), lockDir)

/*
 * A write that can never survive gives up rather than looping forever, and says
 * so. The clobberer here never stops, so every attempt is reverted.
 */
console.log('\na write that never survives gives up and reports failure')
resetGlobal()
const relentless = setInterval(() => {
  writeFileSync(globalFile, JSON.stringify(goodConfig, null, 2))
}, 200)
const doomed = await writeGlobalConfigKey('workflowSizeGuideline', 'small')
clearInterval(relentless)
check('it does not claim success', doomed.ok, false)
ok('it reports an error', typeof doomed.error === 'string' && doomed.error.length > 0, String(doomed.error))
ok('and it stopped at the attempt cap', (doomed.attempts ?? 0) >= 2, `attempts=${doomed.attempts}`)
ok('with no lock left behind', !existsSync(lockDir), lockDir)

rmSync(scratch, { recursive: true, force: true })

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
