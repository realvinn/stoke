/*
 * The updater's reporting, on both surfaces.
 *
 * The bug this suite exists for was not that an update failed — it was that a
 * failure and a success were the same value. `runUpdate` returned
 * `stdout + stderr` from the success path *and* from the catch, so a non-zero
 * exit, a three-minute timeout and a killed-for-buffer-overflow child all came
 * back as a plain string and were rendered in the same grey box. "It sometimes
 * works and sometimes doesn't, and it never says why" is what that looks like
 * from the outside.
 *
 * So the assertions here are mostly about *distinguishability*: given two runs
 * that differ only in outcome, does the result differ?
 *
 *   node scripts/verify-updates.mts
 */
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { UpdateInfo } from '../src/shared/api.ts'
import { leafAuthority, signatureBlocker } from '../src/main/codesign.ts'
import { describeExecError } from '../src/main/updates.ts'
import { updateButton, updateVerdict } from '../src/renderer/src/lib/updateVerdict.ts'

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

function checkMatch(name: string, got: string, want: RegExp): void {
  const ok = want.test(got)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want match ${want}`)
  )
}

/* ------------------------------------------------ what execFile actually does
 *
 * describeExecError reads fields off a real Node error, so the shapes it is fed
 * have to be real ones rather than what the docs imply. These four runs produce
 * them from actual child processes, and the assertions below then pin what Node
 * put there — if a future Node reports a timeout differently, this fails here
 * rather than silently downgrading every timeout to "exited with code null".
 */
const dir = mkdtempSync(join(tmpdir(), 'stoke-updates-'))
const isWin = process.platform === 'win32'

function fakeClaude(name: string, body: string): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(file, 0o755)
  return file
}

async function errorFrom(
  file: string,
  opts: { timeout?: number; maxBuffer?: number }
): Promise<Record<string, unknown>> {
  try {
    await execFileAsync(file, [], { encoding: 'utf8', ...opts })
    return { threw: false }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
    return { threw: true, code: e.code, killed: e.killed, signal: e.signal }
  }
}

if (isWin) {
  console.log('\nreal execFile error shapes  (skipped: /bin/sh fixtures are POSIX-only)')
} else {
  console.log('\nreal execFile error shapes, taken from real child processes')

  const exits7 = fakeClaude('exits7', 'echo "partial progress"; exit 7')
  const hangs = fakeClaude('hangs', 'echo "started"; sleep 30')
  const floods = fakeClaude('floods', 'head -c 200000 /dev/zero | tr "\\0" "x"')
  const clean = fakeClaude('clean', 'echo ok')

  const bad = await errorFrom(exits7, {})
  check('a non-zero exit arrives with a numeric code', bad, {
    threw: true,
    code: 7,
    killed: false,
    signal: null
  })
  checkMatch(
    'and describeExecError names the code',
    describeExecError(bad as never, 'claude update', 180_000),
    /exited with code 7/
  )

  const timedOut = await errorFrom(hangs, { timeout: 300 })
  check(
    'a timeout arrives killed, with a signal and NO exit code — which is why the ' +
      'code check cannot come first',
    { killed: timedOut.killed, code: timedOut.code, signal: timedOut.signal },
    { killed: true, code: null, signal: 'SIGTERM' }
  )
  checkMatch(
    'and describeExecError calls it a timeout rather than "code null"',
    describeExecError(timedOut as never, 'claude update', 180_000),
    /did not finish within 180s/
  )

  const overflowed = await errorFrom(floods, { maxBuffer: 1024 })
  check(
    'exceeding maxBuffer kills the child with its own ERR_ code',
    overflowed.code,
    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  )
  checkMatch(
    'and describeExecError says so instead of falling through to the raw message',
    describeExecError(overflowed as never, 'claude update', 180_000),
    /more output than Stoke will hold/
  )

  check('a clean run does not throw at all', await errorFrom(clean, {}), { threw: false })
}

rmSync(dir, { recursive: true, force: true })

console.log('\ndescribeExecError separates the three things Node packs into `code`')
check(
  'a missing executable is a spawn failure, not an exit status',
  describeExecError({ code: 'ENOENT' }, 'claude update', 1000),
  '`claude update` could not be started: the executable is no longer at the path Stoke found it at.'
)
check(
  'permission denied says permission denied',
  describeExecError({ code: 'EACCES' }, 'claude update', 1000),
  '`claude update` could not be started: permission denied.'
)
check(
  'exit code 0 is still reported when it somehow reaches here, rather than being ' +
    'mistaken for "no code"',
  describeExecError({ code: 0 }, 'claude doctor', 1000),
  '`claude doctor` exited with code 0.'
)
checkMatch(
  'an error with nothing recognisable falls back to its own message',
  describeExecError({ message: 'something specific went wrong' }, 'claude update', 1000),
  /something specific went wrong/
)
check(
  'and with no message at all, still a sentence rather than "undefined"',
  describeExecError({}, 'claude update', 1000),
  '`claude update` failed.'
)

/*
 * The ordering guard. `killed` and a numeric code can both be present — Node
 * sets `killed: true` alongside the code when a process is signalled after
 * producing one — and the timeout reading has to win, because that is the branch
 * that explains the outcome.
 */
check(
  'killed beats a numeric code, so a killed process is never reported as a normal exit',
  describeExecError({ killed: true, code: 143, signal: 'SIGTERM' }, 'claude update', 60_000),
  '`claude update` did not finish within 60s and was stopped. Anything it printed before that is below; the install may be incomplete.'
)

/* --------------------------------------------------- the verdict the UI draws
 *
 * These are the sentences a person reads. The case that matters is the third:
 * exit 0, version unmoved, an update was known to be waiting. That is a failed
 * update wearing a success's clothes, and it has to read as neither.
 */
console.log('\nthe verdict shown after an update')

const ran = (over: Partial<Parameters<typeof updateVerdict>[0]>): Parameters<typeof updateVerdict>[0] => ({
  ok: true,
  output: '',
  error: null,
  from: '2.1.220',
  to: '2.1.220',
  ...over
})

check(
  'a version that moved is a plain success, and says both numbers',
  updateVerdict(ran({ to: '2.1.226' }), true),
  { tone: 'success', text: 'Updated 2.1.220 → 2.1.226.' }
)
check(
  'nothing to do, and nothing was done: success, not a warning',
  updateVerdict(ran({}), false),
  { tone: 'success', text: 'Already on 2.1.220.' }
)
checkMatch(
  'an update WAS waiting and the version did not move: warned, not congratulated',
  updateVerdict(ran({}), true).text,
  /finished without error, but the version is still 2\.1\.220/
)
check(
  '…and that case is a warning, which is the whole point of the tone',
  updateVerdict(ran({}), true).tone,
  'warning'
)
check(
  'a failure reports the reason it was given',
  updateVerdict(ran({ ok: false, error: '`claude update` exited with code 7.' }), true),
  { tone: 'danger', text: '`claude update` exited with code 7.' }
)
check(
  'a failure with no reason still says something, rather than rendering null',
  updateVerdict(ran({ ok: false, error: null }), true),
  { tone: 'danger', text: 'The update failed.' }
)
check(
  'an unreadable version is not printed as the word "null"',
  updateVerdict(ran({ from: null, to: null }), false),
  { tone: 'success', text: 'Already on the latest version.' }
)

/*
 * The distinguishability property itself, stated as a property rather than as
 * another example: no two different outcomes may produce the same line. Before
 * this change every one of these collapsed to the same string.
 */
console.log('\nno two outcomes render the same line')
const outcomes: Array<[string, ReturnType<typeof updateVerdict>]> = [
  ['updated', updateVerdict(ran({ to: '2.1.226' }), true)],
  ['already current', updateVerdict(ran({}), false)],
  ['claimed success, changed nothing', updateVerdict(ran({}), true)],
  ['non-zero exit', updateVerdict(ran({ ok: false, error: 'exited with code 7' }), true)],
  ['timed out', updateVerdict(ran({ ok: false, error: 'did not finish within 180s' }), true)]
]
const seen = new Map<string, string>()
for (const [label, v] of outcomes) {
  const line = `${v.tone}:${v.text}`
  const clash = seen.get(line)
  check(
    `"${label}" is distinguishable from every other outcome`,
    clash ? `identical to "${clash}"` : 'distinct',
    'distinct'
  )
  seen.set(line, label)
}

/* ------------------------------------------------- when the button is pressable
 *
 * The greying-out, stated as rules. The trap here is that "no update available"
 * and "we could not find out" are the same boolean, so the disabled state has to
 * be derived from more than `updateAvailable`.
 */
console.log('\nwhether "Update now" is offered')

const check1 = (over: Partial<UpdateInfo>): UpdateInfo => ({
  current: '2.1.220',
  latest: '2.1.226',
  updateAvailable: true,
  checkedAt: 0,
  error: null,
  ...over
})

check(
  'an update is waiting: offered',
  updateButton(check1({})),
  { enabled: true, hint: 'Install Claude Code 2.1.226.' }
)
check(
  'both versions read and equal: greyed out, which is the state a successful ' +
    'update lands in once the re-check runs',
  updateButton(check1({ current: '2.1.226', updateAvailable: false })),
  { enabled: false, hint: 'Already on the latest version (2.1.226).' }
)
check(
  'still checking: greyed out rather than offering an action with no basis',
  updateButton(null),
  { enabled: false, hint: 'Checking for updates…' }
)
check(
  'the registry could not be reached: still offered, because not knowing is not ' +
    'a reason to withhold the updater',
  updateButton(check1({ latest: null, updateAvailable: false, error: 'getaddrinfo ENOTFOUND' })),
  {
    enabled: true,
    hint: 'Could not check the registry, but the updater can still be run.'
  }
)
/*
 * The one that was wrong on the first pass, and would have shipped a lie.
 *
 * A `claude` that Stoke cannot find yields `current: null` — and a perfectly
 * successful registry lookup alongside it, with `updateAvailable` false because
 * that flag needs both numbers. Testing `latest` alone therefore greys the
 * button out under the words "already on the latest version", which is a claim
 * about a version nobody ever read.
 */
check(
  'the installed version could not be read: offered, and does NOT claim to be current',
  updateButton(check1({ current: null, updateAvailable: false })),
  {
    enabled: true,
    hint: 'Stoke could not read the installed version — run this to find out why.'
  }
)
check(
  'and the registry answering with no version is not "up to date" either',
  updateButton(check1({ latest: null, updateAvailable: false })),
  {
    enabled: true,
    hint: 'No version came back from the registry; the updater can still be run.'
  }
)

/* ------------------------------------------- the one build-config invariant
 *
 * Not a unit test, and it is here on purpose. A .zip in the feed is *necessary*
 * for a macOS auto-update, and on its own not sufficient — the ad-hoc signature
 * CI produces is a second, independent blocker, which `selfUpdate.ts` probes for
 * separately (see its `detectBlocker`, and CLAUDE.md gotcha 24). This assertion
 * covers the first half only: Squirrel.Mac installs by swapping
 * an .app out of an archive, so electron-updater searches the published files
 * for a zip and rejects "dmg" and "pkg" by name (MacUpdater.js:81-83 in 6.8.9).
 * Every release up to v0.4.0-beta.3 built a dmg only, so latest-mac.yml listed
 * one file, the download threw ERR_UPDATER_ZIP_FILE_NOT_FOUND before fetching a
 * byte, and the panel went on saying an update was available.
 *
 * Nothing else fails when this target is removed. `npm run build` passes, the
 * dmg builds, CI is green, the release publishes — and Macs silently stop being
 * able to update. That combination is exactly what a cheap invariant is for.
 */
console.log('\nelectron-builder still emits the archive macOS updates are installed from')
const configPath = fileURLToPath(new URL('../electron-builder.yml', import.meta.url))
const config = readFileSync(configPath, 'utf8')
// Take the `mac:` block only, so a `zip` under some other platform cannot
// satisfy this by accident. Top-level keys are the unindented lines.
const macBlock = /^mac:\n((?:[ \t].*\n|\n)*)/m.exec(config)?.[1] ?? ''
check('electron-builder.yml has a mac: block at all', macBlock.length > 0, true)
check(
  'and its target list includes zip, without which no Mac can auto-update',
  /^\s*-\s*target:\s*zip\s*$/m.test(macBlock),
  true
)
check(
  'the dmg is still built too — it is what a person downloads by hand',
  /^\s*-\s*target:\s*dmg\s*$/m.test(macBlock),
  true
)

/* --------------------------------- which signatures can install an update
 *
 * The real reports below are verbatim `codesign -dv` stderr, because that is
 * the shape the rule has to survive: multi-line, chain leaf-first, and with the
 * interesting field on a line of its own rather than at a fixed offset.
 *
 * The self-signed case is the one this suite exists for. It shipped returning
 * null — not ad-hoc, so not blocked — which meant the panel offered an update a
 * locally-built copy could never install, and said so only after the whole
 * archive had been downloaded. A test that only pinned the ad-hoc case would
 * have gone on passing through all of it.
 */
console.log('\nwhich code signatures can install a downloaded update')

const ADHOC_REPORT = `Executable=/Applications/Stoke.app/Contents/MacOS/Stoke
Identifier=Electron
CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded
Signature=adhoc
Info.plist entries=32
TeamIdentifier=not set
`

const SELF_SIGNED_REPORT = `Executable=/Applications/Stoke.app/Contents/MacOS/Stoke
Identifier=dev.vinn.stoke
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=431 flags=0x10000(runtime) hashes=3+7 location=embedded
Signature size=5942
Authority=MyTouchBar Local
Timestamp=20 Aug 2026 at 6:36:40 pm
TeamIdentifier=not set
`

const DEVELOPER_ID_REPORT = `Executable=/Applications/Stoke.app/Contents/MacOS/Stoke
Identifier=dev.vinn.stoke
Signature size=9051
Authority=Developer ID Application: The Vinh Nguyen (AB12CD34EF)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=AB12CD34EF
`

check(
  'an ad-hoc signature is blocked — its requirement is this binary’s own hash',
  signatureBlocker(ADHOC_REPORT)?.includes('ad-hoc'),
  true
)
check(
  'a self-signed certificate is blocked too, which is the case that used to slip through',
  signatureBlocker(SELF_SIGNED_REPORT) !== null,
  true
)
check(
  'and it names the certificate, because it is usually not the one you expect',
  signatureBlocker(SELF_SIGNED_REPORT)?.includes('MyTouchBar Local'),
  true
)
check(
  'a Developer ID signature is NOT blocked — this is the case that must keep working',
  signatureBlocker(DEVELOPER_ID_REPORT),
  null
)
check(
  'the leaf authority is read, not an intermediate further down the chain',
  leafAuthority(DEVELOPER_ID_REPORT),
  'Developer ID Application: The Vinh Nguyen (AB12CD34EF)'
)
check(
  'a probe that produced nothing blocks nothing — it cannot answer, so it must not stand in the way',
  signatureBlocker(''),
  null
)
check(
  'nor does a report that states no authority and no ad-hoc flag',
  signatureBlocker('Executable=/Applications/Stoke.app/Contents/MacOS/Stoke\n'),
  null
)

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
