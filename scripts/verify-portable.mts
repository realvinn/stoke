/*
 * A copy of Stoke that did not come from the Windows installer can update too.
 *
 *   node scripts/verify-portable.mts
 *
 * The bug this exists for: on Windows electron-updater only knows how to run the
 * NSIS installer. A folder unzipped onto the Desktop "updated" by installing a
 * SECOND copy under %LOCALAPPDATA%\Programs and launching that, while the
 * unzipped copy stayed on the old version and offered the same update on its
 * next start, forever — and a copy Scoop manages would have been overwritten
 * behind Scoop's back. Nothing in the repo could see it: the installer path was
 * the only path, and it worked.
 *
 * So this holds four things, each of which fails by returning the wrong answer
 * rather than by throwing:
 *   - src/shared/installKind.ts: which kind of copy this is, and the zip a
 *     release offers each architecture (never another arch's: gotcha 67);
 *   - src/main/portableSwap.ts: the helper that swaps the folder after Stoke
 *     quits — its plan, and the script itself, RUN under a real PowerShell when
 *     one is on this machine (GitHub's ubuntu runners ship `pwsh`; set
 *     STOKE_PWSH to point at one elsewhere). It must never kill, must put the
 *     old copy back when the new one will not move in, and must survive a path
 *     with an apostrophe and a curly quote in it;
 *   - src/main/portableUpdate.ts: download → verify → unpack → check, against a
 *     local server, with each refusal made to happen;
 *   - leftovers are swept by name only, and a bystander folder survives
 *     (gotcha 74: fake every input or none — every path here is a scratch dir).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyInstall,
  foreignEntries,
  isStokeBuildPath,
  isStokeInnerEntry,
  isVolumeRoot,
  sharedFolderNote,
  portableAssetFor,
  usesInstallerRoute,
  wingetIdFromFolder,
  winDirname,
  winIsUnder,
  winPathKey,
  type InstallFacts
} from '../src/shared/installKind.ts'
import { SWAP_SCRIPT, backupDirFor, isLeftover, planJson, stagedDirFor, stagedMarkerJson, swapArgs, type SwapPlan } from '../src/main/portableSwap.ts'
import {
  HELPER_START_ALLOWANCE_MS,
  downloadVerified,
  entriesNotIn,
  extractZip,
  gatherInstallFacts,
  helperVerdict,
  listBuild,
  readPlanAt,
  readRefusal,
  readStarted,
  readSwapResult,
  refusalStands,
  removeTree,
  stagedProblem,
  stagePortable,
  sweepLeftovers,
  swapWouldCarryAway,
  useRemover,
  writeRefusalSync,
  writeStagedMarkerSync,
  writeSwapFilesSync
} from '../src/main/portableUpdate.ts'

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`))
}
function ok(name: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}` + (cond || !detail ? '' : `\n        ${detail}`))
}

const scratch = mkdtempSync(join(tmpdir(), 'stoke-portable-'))

console.log('\nwhich kind of copy this is')
{
  const base: InstallFacts = {
    platform: 'win32',
    packaged: true,
    execPath: 'C:\\Users\\Ada\\Desktop\\Stoke\\Stoke.exe',
    env: {
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\Ada',
      ProgramData: 'C:\\ProgramData'
    },
    hasUninstaller: false,
    canWriteBeside: true,
    writeError: null,
    // The real top level of a Windows build (release/win-unpacked).
    // One level down in resources and locales as listBuild names it.
    entries: ['locales', 'resources', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'Stoke.exe', 'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'resources\\app.asar', 'resources\\app.asar.unpacked', 'resources\\app-update.yml', 'resources\\elevate.exe', 'resources\\bin', 'locales\\en-US.pak', 'locales\\zh-TW.pak']
  }
  const kind = (over: Partial<InstallFacts>) => classifyInstall({ ...base, ...over, env: { ...base.env, ...(over.env ?? {}) } })

  check('a development run is source, whatever else is true', kind({ packaged: false, hasUninstaller: true }).kind, 'source')
  check('macOS is the installer route (Squirrel swaps the .app wherever it is)', kind({ platform: 'darwin', execPath: '/Applications/Stoke.app/Contents/MacOS/Stoke' }).kind, 'installer')
  check('Linux is the installer route (AppImageUpdater replaces $APPIMAGE)', kind({ platform: 'linux', execPath: '/tmp/.mount_x/stoke' }).kind, 'installer')
  check(
    'the NSIS installer folder — website, one-liner, winget — keeps electron-updater',
    kind({ execPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Stoke\\Stoke.exe', hasUninstaller: true }).kind,
    'installer'
  )
  const port = kind({})
  check('an unzipped folder is portable, and says where', [port.kind, port.dir], ['portable', 'C:\\Users\\Ada\\Desktop\\Stoke'])
  ok('and its note says the swap happens on restart or quit', /swapped in when Stoke restarts or quits/.test(port.note ?? ''), port.note ?? '')
  const ro = kind({ execPath: 'C:\\Program Files\\Stoke\\Stoke.exe', canWriteBeside: false, writeError: 'EPERM' })
  check('a folder it cannot write beside is manual, not a doomed download', ro.kind, 'manual')
  ok('naming the folder and both ways out', /Program Files\\Stoke/.test(ro.note ?? '') && /releases/.test(ro.note ?? ''), ro.note ?? '')
  ok('administrator rights are named under Program Files', /administrator rights/.test(ro.note ?? ''))
  const stick = kind({ execPath: 'E:\\Apps\\Stoke\\Stoke.exe', canWriteBeside: false, writeError: 'EROFS' })
  ok('and NOT for a read-only stick, where they would not help — the errno is named instead', !/administrator/.test(stick.note ?? '') && /EROFS/.test(stick.note ?? ''), stick.note ?? '')

  /*
   * The review's critical finding: the swap renames the WHOLE folder, so a
   * folder shared with anything else must never be portable. 7-Zip's "Extract
   * Here" in Downloads makes Downloads the folder.
   */
  const shared = kind({ execPath: 'C:\\Users\\Ada\\Downloads\\Stoke.exe', entries: [...(base.entries ?? []), 'taxes-2025.pdf', 'photos', 'setup.msi', 'notes.txt'] })
  check('a folder shared with the user\'s own files is manual — never swapped', shared.kind, 'manual')
  ok('and the note names what is there, and the way out', /taxes-2025\.pdf/.test(shared.note ?? '') && /folder of its own/.test(shared.note ?? ''), shared.note ?? '')
  check('operating-system litter does not make a folder shared', kind({ entries: [...(base.entries ?? []), 'desktop.ini', 'Thumbs.db'] }).kind, 'portable')
  check('foreignEntries sees exactly the strangers', foreignEntries(['Stoke.exe', 'ffmpeg.dll', 'locales', 'photos', 'a.pdf', 'LICENSE.electron.txt']), ['photos', 'a.pdf'])

  /*
   * The review's low finding: every guard looked at top-level names only, so a
   * file of the user's inside resources or locales passed all three and the
   * sweep deleted it with the old copy.
   */
  const inRes = kind({ entries: [...(base.entries ?? []), 'resources\\my-notes.txt'] })
  check('a file of the user\'s inside resources makes the folder manual, and is named', [inRes.kind, /resources\\my-notes\.txt/.test(inRes.note ?? '')], ['manual', true])
  check('and inside locales', kind({ entries: [...(base.entries ?? []), 'locales\\readme.txt'] }).kind, 'manual')
  check(
    'what a build keeps one level down',
    [['locales', 'en-US.pak'], ['Locales', 'desktop.ini'], ['locales', 'x.txt'], ['resources', 'app.asar'], ['RESOURCES', 'App.Asar.Unpacked'], ['resources', 'bin'], ['resources', 'app.asar.bak'], ['elsewhere', 'app.asar']].map(([f, n]) => isStokeInnerEntry(f, n)),
    [true, true, false, true, true, true, false, false]
  )
  check('isStokeBuildPath reads either slash', [isStokeBuildPath('resources/app.asar'), isStokeBuildPath('resources\\app.asar'), isStokeBuildPath('Stoke.exe'), isStokeBuildPath('photos\\a.jpg')], [true, true, true, false])
  /*
   * A new extraResources target lands in resources\ of every build — so it must
   * be one isStokeInnerEntry accepts, or the NEXT build's own folder reads as
   * "shared" and every portable copy stops updating. Read from the yml, so
   * adding a target without adding its name fails here.
   */
  {
    const yml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'electron-builder.yml'), 'utf8')
    const tos = [...yml.matchAll(/^\s+to:\s*['"]?([^'"\s#]+)/gm)].map((m) => m[1].split(/[\\/]/)[0])
    ok('electron-builder.yml has extraResources targets to check', tos.length > 0)
    check('every extraResources target is a name a build may keep in resources', tos.filter((t) => !isStokeInnerEntry('resources', t)), [])
  }
  check('the shared-folder note names what is foreign and the way out', /with other things \(a\.pdf, b, c, and 1 more\)/.test(sharedFolderNote('C:\\x', ['a.pdf', 'b', 'c', 'd'])), true)

  /*
   * The review's high finding: a probe that times out must never produce the
   * destructive route. `false` for "no uninstaller" routed an INSTALLED copy
   * into the swap, which would have deleted its uninstaller.
   */
  for (const [what, over] of [
    ['the uninstaller check', { hasUninstaller: null }],
    ['the write test', { canWriteBeside: null }],
    ['the folder listing', { entries: null }]
  ] as const) {
    const k = kind(over as Partial<InstallFacts>)
    check(`${what} timing out is a cautious, UNSETTLED manual — never portable`, [k.kind, k.settled], ['manual', false])
  }
  check('an installed copy whose probe timed out still takes the installer route once the uninstaller is seen', kind({ hasUninstaller: true, canWriteBeside: null, entries: null }).kind, 'installer')
  check('every definite answer is settled', [kind({}).settled, ro.settled, shared.settled], [true, true, true])

  const root = kind({ execPath: 'E:\\Stoke.exe' })
  check('a drive root has no folder to swap: manual', [root.kind, root.dir], ['manual', 'E:'])
  // A timed-out realpath leaves execPath unresolved and every probe null: no
  // SETTLED answer may be read off that path, a drive root's included.
  check('a drive root whose probes did not answer is unsettled, never a settled guess', [kind({ execPath: 'E:\\Stoke.exe', hasUninstaller: null, canWriteBeside: null, entries: null }).settled], [false])
  check('isVolumeRoot', ['E:', 'E:\\', '\\\\srv\\share', '\\\\srv\\share\\Stoke', 'E:\\Tools'].map(isVolumeRoot), [true, true, true, false, false])

  const scoop = kind({ execPath: 'C:\\Users\\Ada\\scoop\\apps\\stoke\\current\\Stoke.exe', hasUninstaller: true })
  check('Scoop under the profile is managed, with its own command — even with an uninstaller in it', [scoop.kind, scoop.manager, scoop.command], ['managed', 'scoop', 'scoop update stoke'])
  check(
    '$env:SCOOP wins, and the app name comes from the path',
    kind({ execPath: 'D:\\tools\\scoop\\apps\\stoke-nightly\\1.0.0\\Stoke.exe', env: { SCOOP: 'D:\\tools\\scoop' } }).command,
    'scoop update stoke-nightly'
  )
  check('a global Scoop install under ProgramData', kind({ execPath: 'C:\\ProgramData\\scoop\\apps\\stoke\\current\\Stoke.exe' }).manager, 'scoop')
  const wg = kind({ execPath: 'C:\\Users\\Ada\\AppData\\Local\\Microsoft\\WinGet\\Packages\\realvinn.Stoke_Microsoft.Winget.Source_8wekyb3d8bbwe\\Stoke.exe' })
  check('a winget PORTABLE install is managed by winget, id read from its folder', [wg.kind, wg.command], ['managed', 'winget upgrade --id realvinn.Stoke'])
  check('Chocolatey\'s own lib folder', kind({ execPath: 'C:\\ProgramData\\chocolatey\\lib\\stoke\\tools\\Stoke.exe' }).command, 'choco upgrade stoke')
  check(
    'paths compare as Windows compares them: case and slash direction do not matter',
    kind({ execPath: 'c:/users/ADA/Scoop/Apps/Stoke/current/Stoke.exe' }).kind,
    'managed'
  )
  check('a folder merely NAMED like scoop is not Scoop', kind({ execPath: 'C:\\Users\\Ada\\scoopapps\\Stoke\\Stoke.exe' }).kind, 'portable')
  const temp = 'C:\\Users\\Ada\\AppData\\Local\\Temp'
  const pexe = kind({ env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\Ada\\Downloads\\Stoke.exe', TEMP: temp }, execPath: `${temp}\\2abc\\Stoke.exe` })
  check('electron-builder\'s single-file portable exe is manual: it cannot replace itself', [pexe.kind, pexe.dir], ['manual', 'C:\\Users\\Ada\\Downloads'])
  check(
    'but the variable is INHERITED: a normal install started from inside another portable app is not one',
    kind({ env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Tabby\\Tabby.exe', TEMP: temp }, execPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Stoke\\Stoke.exe', hasUninstaller: true }).kind,
    'installer'
  )
  check('a manager root with a trailing separator still matches (SCOOP=D:\\scoop\\)', kind({ execPath: 'D:\\scoop\\apps\\stoke\\current\\Stoke.exe', env: { SCOOP: 'D:\\scoop\\' } }).kind, 'managed')
  check(
    'a manager\'s folder behind a junction is recognised from the path the process was started with',
    kind({ execPath: 'D:\\elsewhere\\stoke\\1.0.0\\Stoke.exe', execPathRaw: 'C:\\Users\\Ada\\scoop\\apps\\stoke\\current\\Stoke.exe' }).kind,
    'managed'
  )
  check('winget ids keep their underscores', [wingetIdFromFolder('Some_Org.Stoke_Microsoft.Winget.Source_8wekyb3d8bbwe'), wingetIdFromFolder('realvinn.Stoke_Microsoft.Winget.Source_8wekyb3d8bbwe')], ['Some_Org.Stoke', 'realvinn.Stoke'])
  check('winPathKey collapses repeated separators, keeps a UNC prefix', [winPathKey('D:\\scoop\\\\apps\\'), winPathKey('\\\\srv\\share\\x')], ['d:\\scoop\\apps', '\\\\srv\\share\\x'])

  check('only the installer takes the NSIS route', ['installer', 'portable', 'managed', 'manual', 'source'].map((k) => usesInstallerRoute(k as never)), [true, false, false, false, false])
  check('winDirname', [winDirname('C:\\a\\b\\Stoke.exe'), winDirname('C:/a/b/'), winDirname('Stoke.exe')], ['C:\\a\\b', 'C:\\a', 'Stoke.exe'])
  check('winIsUnder is a path test, not a prefix test', [winIsUnder('C:\\a\\bc', 'C:\\a\\b'), winIsUnder('C:\\a\\b\\c', 'C:\\A\\B\\'), winIsUnder('C:\\a', '')], [false, true, false])
}

console.log('\nthe zip a release offers each architecture')
{
  const files = [
    { url: 'Stoke-1.0.0-x64-setup.exe', sha512: 'a' },
    { url: 'Stoke-1.0.0-arm64-setup.exe', sha512: 'b' },
    { url: 'Stoke-1.0.0-x64-win.zip', sha512: 'c', size: 3 },
    { url: 'Stoke-1.0.0-arm64-win.zip', sha512: 'd', size: 4 },
    { url: 'Stoke-1.0.0-arm64.zip', sha512: 'e' } // a mac zip, in case one ever strays into this feed
  ]
  check('x64 gets the x64 zip', portableAssetFor(files, 'x64')?.url, 'Stoke-1.0.0-x64-win.zip')
  check('arm64 gets the arm64 zip, never the mac one', portableAssetFor(files, 'arm64')?.url, 'Stoke-1.0.0-arm64-win.zip')
  check(
    'no zip for this arch is null — NOT another arch\'s folder, whose terminal binary would be for the wrong CPU',
    portableAssetFor(files.filter((f) => !f.url.includes('arm64-win')), 'arm64'),
    null
  )
  check('an installer is never mistaken for the portable build', portableAssetFor(files.slice(0, 2), 'x64'), null)
}

console.log('\nthe facts, gathered')
{
  // A real folder shaped like a portable copy, one level down included.
  const app = join(scratch, 'facts', 'Stoke')
  mkdirSync(join(app, 'resources', 'bin'), { recursive: true })
  mkdirSync(join(app, 'locales'), { recursive: true })
  for (const f of ['Stoke.exe', 'ffmpeg.dll', join('resources', 'app.asar'), join('locales', 'en-US.pak')]) writeFileSync(join(app, f), '')
  const exe = join(app, 'Stoke.exe')
  const probe = { platform: 'win32', packaged: true, execPath: exe, env: {} }
  const facts = await gatherInstallFacts(probe)
  check('the listing goes one level down into resources and locales', [...(facts.entries ?? [])].sort(), ['Stoke.exe', 'ffmpeg.dll', 'locales', 'locales\\en-US.pak', 'resources', 'resources\\app.asar', 'resources\\bin'])
  check('and a folder of Stoke\'s own classifies as portable from it', classifyInstall(facts).kind, 'portable')
  writeFileSync(join(app, 'resources', 'notes.txt'), '')
  check('a file dropped into resources is seen and makes it manual', classifyInstall(await gatherInstallFacts(probe)).kind, 'manual')
  rmSync(join(app, 'resources', 'notes.txt'))
  /*
   * The review's low finding: a realpath past its deadline fell back to the
   * UNRESOLVED path — a guess — so a junctioned portable folder could settle on
   * the junction and the swap would rename the junction.
   */
  const hung = await gatherInstallFacts({ ...probe, resolve: () => new Promise<string>(() => {}), deadlineMs: 50 })
  check('a realpath that times out nulls every probe', [hung.hasUninstaller, hung.canWriteBeside, hung.entries], [null, null, null])
  const hk = classifyInstall(hung)
  check('so the answer is the unsettled manual, asked again — never portable off an unresolved path', [hk.kind, hk.settled], ['manual', false])
  const failed = await gatherInstallFacts({ ...probe, resolve: () => Promise.reject(new Error('EISDIR: virtual drive')), deadlineMs: 2000 })
  check('a realpath that FAILS is an answer: the path as started, and the probes run there', [failed.execPath, classifyInstall(failed).kind], [exe, 'portable'])
}

console.log('\nthe swap helper, read')
{
  ok('the script is pure ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page', /^[\x00-\x7F]*$/.test(SWAP_SCRIPT))
  ok('it takes its paths from a plan, never from its own text', /param\(\[Parameter\(Mandatory = \$true\)\]\[string\]\$Plan\)/.test(SWAP_SCRIPT) && /ConvertFrom-Json/.test(SWAP_SCRIPT))
  const code = SWAP_SCRIPT.split('\r\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  ok('it never kills: no Stop-Process, taskkill, .Kill() or -Force on a process', !/Stop-Process|taskkill|\.Kill\(/i.test(code))
  ok('it waits on everything running out of the folder, not only the pid', /Get-Inside/.test(code) && /ExecutablePath/.test(code))
  ok('and keeps the old copy for the new one to sweep once it has started', /The old folder stays/.test(SWAP_SCRIPT))
  // The review's low finding: it cleared an existing backup with an unguarded
  // recursive Remove-Item — exactly the kind of folder the sweep guard keeps.
  ok('it deletes NOTHING, ever: no Remove-Item at all, an existing backup name is skipped instead', !/Remove-Item|\.Delete\(/i.test(code) && /Test-Path -LiteralPath \$backup; \$n\+\+/.test(code))
  ok('it requires the staged-copy marker, not merely a Stoke.exe', /\$p\.stagedMarker/.test(code) && /\$ready\.version -ne \[string\]\$p\.to/.test(code))
  ok('the result is written without a BOM', /UTF8Encoding\(\$false\)/.test(code))
  const args = swapArgs('C:\\x\\swap.ps1', 'C:\\x\\plan.json')
  check('the argv: -File with -Plan, never -EncodedCommand or -Command', [args.includes('-File'), args.includes('-EncodedCommand'), args.includes('-Command'), args.slice(-4)], [true, false, false, ['-File', 'C:\\x\\swap.ps1', '-Plan', 'C:\\x\\plan.json']])
  ok('non-interactive and hidden, so nothing can wait on a prompt nobody sees', args.includes('-NonInteractive') && args.includes('Hidden'))
  check('the sibling names', [stagedDirFor('C:\\T\\Stoke\\', '1.0.0'), backupDirFor('C:\\T\\Stoke', '0.9.9')], ['C:\\T\\Stoke.update-1.0.0', 'C:\\T\\Stoke.old-0.9.9'])
  check(
    'leftovers are recognised by exact name and version shape only',
    ['Stoke.old-0.9.9', 'Stoke.update-1.0.0-beta.2', 'stoke.OLD-1.2.3', 'Stoke.old-0.9.9-2', 'Stoke.old-notes', 'Stoke.old-0.9.9.txt', 'Other.old-0.9.9', 'Stoke'].map((n) => isLeftover('Stoke', n)),
    ['old', 'update', 'old', 'old', null, null, null, null]
  )
  const plan: SwapPlan = { pid: 1, appDir: 'C:\\Users\\O\u2019Brien\\Stoke', staged: 's', stagedMarker: 'm', backup: 'b', resultFile: 'r', startedFile: 'st', from: '0.9.9', to: '1.0.0', relaunch: true, exeName: 'Stoke.exe', waitSeconds: 120, renameTries: 40, createdAt: 5 }
  check('the plan round-trips a curly quote untouched (it is data, never code)', JSON.parse(planJson(plan)).appDir, 'C:\\Users\\O\u2019Brien\\Stoke')
}

console.log('\nthe swap helper, run')
/*
 * PowerShell 7 on this machine, if there is one. What it can prove off Windows
 * is the logic — wait, refuse, swap, roll back, report, relaunch — through the
 * Get-Process branch of Get-Inside; the Windows-only half (CIM, a real locked
 * folder) is the Windows workflow's job.
 */
function findPwsh(): string | null {
  if (process.env.STOKE_PWSH && existsSync(process.env.STOKE_PWSH)) return process.env.STOKE_PWSH
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of ['pwsh', 'pwsh.exe']) {
      const p = join(dir, name)
      if (dir && existsSync(p)) return p
    }
  }
  return null
}
const pwsh = findPwsh()
if (!pwsh) {
  console.log('  NOTE  no PowerShell here (set STOKE_PWSH to one), so the helper is read above but not run. CI runs it.')
} else {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  // A folder name with an apostrophe AND a right single quotation mark, which
  // PowerShell also treats as a quote: both must arrive intact.
  const root = join(scratch, "swap it's O\u2019Brien")
  // The staged-copy marker is written as stagePortable writes it, for the
  // plan's own folder and version, unless a case says otherwise.
  const run = (plan: SwapPlan, marker: 'write' | 'none' | { dir: string; version: string } = 'write') => {
    const dir = join(scratch, 'helper')
    mkdirSync(dir, { recursive: true })
    const scriptPath = join(dir, 'swap.ps1')
    const planPath = join(dir, 'plan.json')
    writeFileSync(scriptPath, SWAP_SCRIPT, 'ascii')
    writeFileSync(planPath, planJson(plan), 'utf8')
    rmSync(plan.resultFile, { force: true })
    rmSync(plan.stagedMarker, { force: true })
    if (marker === 'write') writeStagedMarkerSync(plan.stagedMarker, plan.staged, plan.to)
    else if (marker !== 'none') writeStagedMarkerSync(plan.stagedMarker, marker.dir, marker.version)
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-Plan', planPath], { encoding: 'utf8', timeout: 90_000 })
    const result = existsSync(plan.resultFile) ? JSON.parse(readFileSync(plan.resultFile, 'utf8')) : null
    return { status: r.status, result, stderr: r.stderr }
  }
  const layout = (tag: string) => {
    const base = join(root, tag)
    rmSync(base, { recursive: true, force: true })
    mkdirSync(join(base, 'Stoke'), { recursive: true })
    mkdirSync(join(base, 'Stoke.update-1.0.0'), { recursive: true })
    writeFileSync(join(base, 'Stoke', 'Stoke.exe'), 'old')
    writeFileSync(join(base, 'Stoke.update-1.0.0', 'Stoke.exe'), 'new')
    return base
  }
  const planFor = (base: string, over: Partial<SwapPlan> = {}): SwapPlan => ({
    pid: 2147483000, // a pid nothing has
    appDir: join(base, 'Stoke'),
    staged: join(base, 'Stoke.update-1.0.0'),
    stagedMarker: join(base, 'staged.json'),
    backup: join(base, 'Stoke.old-0.9.9'),
    resultFile: join(base, 'result.json'),
    startedFile: join(base, 'started.json'),
    from: '0.9.9',
    to: '1.0.0',
    relaunch: false,
    exeName: 'Stoke.exe',
    waitSeconds: 3,
    renameTries: 4,
    createdAt: Date.now(),
    ...over
  })

  {
    const base = layout('happy')
    // A stand-in "Stoke" that is really running, then exits: the helper must
    // wait for it rather than move a folder out from under it. Double-forked on
    // POSIX so it is NOT this process's child: `run` blocks in spawnSync, so a
    // child of ours could not be reaped when it exits, and a zombie still
    // answers `Get-Process -Id` — the helper would rightly call it running.
    // (Windows has no zombies; there a plain child is the honest stand-in.)
    const sleeperPid =
      process.platform === 'win32'
        ? (spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' }).pid ?? 0)
        : Number(execFileSync('/bin/sh', ['-c', 'sleep 1.5 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim())
    const r = run(planFor(base, { pid: sleeperPid, waitSeconds: 20 }))
    check('it waits for Stoke to exit, then swaps: exit 0, ok, the new copy in place', [r.status, r.result?.ok, readFileSync(join(base, 'Stoke', 'Stoke.exe'), 'utf8')], [0, true, 'new']); if (r.status !== 0) console.log('        helper said:', JSON.stringify(r.result), r.stderr)
    check('the old copy is kept beside it for the new Stoke to sweep', readFileSync(join(base, 'Stoke.old-0.9.9', 'Stoke.exe'), 'utf8'), 'old')
    check('and the staged folder is gone (it IS the app folder now)', existsSync(join(base, 'Stoke.update-1.0.0')), false)
    check('the result names the folder with both quotes intact', r.result?.dir, join(base, 'Stoke'))
    const started = existsSync(join(base, 'started.json')) ? JSON.parse(readFileSync(join(base, 'started.json'), 'utf8')) : null
    ok('the helper said it was running, with its own pid, before it waited', typeof started?.pid === 'number' && started.pid > 0)
  }
  {
    const base = layout('busy')
    const stubborn = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    const r = run(planFor(base, { pid: stubborn.pid ?? 0, waitSeconds: 2 }))
    const alive = stubborn.exitCode === null && !stubborn.killed
    stubborn.kill('SIGTERM')
    check('a Stoke that will not exit is NOT killed and NOT swapped: exit 1, step wait', [r.status, r.result?.step, alive], [1, 'wait', true])
    check('and the old copy is untouched', readFileSync(join(base, 'Stoke', 'Stoke.exe'), 'utf8'), 'old')
  }
  {
    // Something else running out of the folder — the statusLine shim, a
    // lingering helper — holds it just as surely as Stoke does.
    // A COPY of a real binary, not a script: a script's process is its
    // interpreter, whose path is /bin/sh — the same way the statusLine shim on
    // Windows is Stoke.exe itself. Linux only: .NET reads another process's
    // path from /proc there, and on macOS `Get-Process .Path` comes back empty
    // for it (measured), so the wait would be tested against nothing.
    const base = layout('inside')
    const sleepBin = ['/usr/bin/sleep', '/bin/sleep'].find((p) => existsSync(p))
    if (process.platform === 'linux' && sleepBin) {
      const inside = join(base, 'Stoke', 'lingering')
      writeFileSync(inside, readFileSync(sleepBin))
      chmodSync(inside, 0o755)
      const marker = join(base, 'relaunched')
      writeFileSync(join(base, 'Stoke', 'Stoke.exe'), `#!/bin/sh\ntouch "${marker}"\n`)
      chmodSync(join(base, 'Stoke', 'Stoke.exe'), 0o755)
      const lingering = spawn(inside, ['30'], { stdio: 'ignore' })
      const r = run(planFor(base, { waitSeconds: 2, relaunch: true }))
      lingering.kill('SIGTERM')
      check('a process running out of the folder blocks the swap too, and is named', [r.status, r.result?.step, /lingering/.test(r.result?.message ?? '')], [1, 'wait', true])
      check('and nothing moved', existsSync(join(base, 'Stoke.update-1.0.0', 'Stoke.exe')), true)
      for (let i = 0; i < 50 && !existsSync(marker); i++) spawnSync('sleep', ['0.1'])
      ok('and "Restart and install" still restarts the OLD copy: never no Stoke at all', existsSync(marker))
    } else {
      console.log('  NOTE  "something else runs out of the folder" needs Linux (/proc paths); CI runs it.')
    }
  }
  {
    const base = layout('missing')
    rmSync(join(base, 'Stoke.update-1.0.0'), { recursive: true })
    const r = run(planFor(base))
    check('a staged copy that vanished changes nothing', [r.status, r.result?.step, readFileSync(join(base, 'Stoke', 'Stoke.exe'), 'utf8')], [1, 'staged', 'old'])
  }
  {
    // The review's medium finding: the helper checked only for Stoke.exe, which
    // is also there halfway through an unpack — and the same session's
    // automatic download deletes and re-extracts into that very folder.
    const base = layout('unmarked')
    const r = run(planFor(base), 'none')
    check('a staged copy with no marker — mid-unpack, or unchecked — changes nothing', [r.status, r.result?.step, readFileSync(join(base, 'Stoke', 'Stoke.exe'), 'utf8'), existsSync(join(base, 'Stoke.update-1.0.0', 'Stoke.exe'))], [1, 'staged', 'old', true])
    const other = layout('other-version')
    const r2 = run(planFor(other), { dir: join(other, 'Stoke.update-1.0.0'), version: '0.9.0' })
    check('nor does a marker left by a different version', [r2.status, r2.result?.step, readFileSync(join(other, 'Stoke', 'Stoke.exe'), 'utf8')], [1, 'staged', 'old'])
    const elsewhere = layout('other-dir')
    const r3 = run(planFor(elsewhere), { dir: join(elsewhere, 'Stoke.update-9.9.9'), version: '1.0.0' })
    check('nor one naming a different folder', [r3.status, r3.result?.step], [1, 'staged'])
  }
  {
    // The review's low finding: an existing backup was Remove-Item'd to make
    // room — and the sweep keeps exactly those folders when they hold the
    // user's files. Now the helper takes the next free name and deletes nothing.
    const base = layout('backup-taken')
    mkdirSync(join(base, 'Stoke.old-0.9.9'))
    writeFileSync(join(base, 'Stoke.old-0.9.9', 'taxes.pdf'), 'precious')
    const r = run(planFor(base))
    check('with the backup name taken, the swap still happens', [r.status, r.result?.ok, readFileSync(join(base, 'Stoke', 'Stoke.exe'), 'utf8')], [0, true, 'new']); if (r.status !== 0) console.log('        helper said:', JSON.stringify(r.result), r.stderr)
    check('the folder that had the name is untouched', readFileSync(join(base, 'Stoke.old-0.9.9', 'taxes.pdf'), 'utf8'), 'precious')
    check('and the old copy went to the next free name, which the sweep recognises', [readFileSync(join(base, 'Stoke.old-0.9.9-2', 'Stoke.exe'), 'utf8'), isLeftover('Stoke', 'Stoke.old-0.9.9-2')], ['old', 'old'])
  }
  if (!isRoot && process.platform !== 'win32') {
    // The second rename fails (its source sits in a read-only folder) after the
    // first has succeeded: the old copy must go back where it was.
    const base = layout('rollback')
    mkdirSync(join(base, 'ro'))
    execFileSync('mv', [join(base, 'Stoke.update-1.0.0'), join(base, 'ro', 'Stoke.update-1.0.0')])
    chmodSync(join(base, 'ro'), 0o555)
    const r = run(planFor(base, { staged: join(base, 'ro', 'Stoke.update-1.0.0') }))
    chmodSync(join(base, 'ro'), 0o755)
    check('when the new copy will not move in, the old one is put BACK: exit 1, step move-new', [r.status, r.result?.step, readFileSync(join(base, 'Stoke', 'Stoke.exe'), 'utf8')], [1, 'move-new', 'old'])
    ok('and the reason is the inner exception, not PowerShell\'s wrapper', !/Exception calling/.test(r.result?.message ?? '') && /put back/.test(r.result?.message ?? ''), r.result?.message ?? '')
  } else {
    console.log('  NOTE  the rollback case needs a read-only folder, which root (or Windows ACLs) ignore; skipped here.')
  }
  if (process.platform !== 'win32') {
    // Relaunch: the new Stoke.exe is started, from outside its own folder.
    const base = layout('relaunch')
    const marker = join(base, 'started')
    // chmod after the write: the file already exists (layout made it), and
    // writeFileSync's mode applies only to a file it creates.
    writeFileSync(join(base, 'Stoke.update-1.0.0', 'Stoke.exe'), `#!/bin/sh\npwd > "${marker}"\n`)
    chmodSync(join(base, 'Stoke.update-1.0.0', 'Stoke.exe'), 0o755)
    const r = run(planFor(base, { relaunch: true }))
    for (let i = 0; i < 50 && !existsSync(marker); i++) spawnSync('sleep', ['0.1'])
    check('Restart and install starts the NEW copy afterwards', [r.status, existsSync(marker)], [0, true]); if (r.status !== 0) console.log('        helper said:', JSON.stringify(r.result), r.stderr)
    ok('with a working directory outside the app folder, which would otherwise be held open', existsSync(marker) && !readFileSync(marker, 'utf8').includes(join(base, 'Stoke')))
  }
}

console.log('\ndownload, verify, unpack, check')
{
  const payload = Buffer.from('pretend this is a zip '.repeat(4096))
  const sha = createHash('sha512').update(payload).digest('base64')
  const server = createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': payload.length })
    res.end(req.url === '/truncated' ? payload.subarray(0, 100) : payload)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const url = (p: string) => `http://127.0.0.1:${port}${p}`
  const dest = join(scratch, 'dl.bin')
  const tryDl = async (path: string, sha512: string, size?: number) => {
    try {
      const pcts: number[] = []
      await downloadVerified({ url: url(path), sha512, size, dest, fetchImpl: (u) => fetch(u), onProgress: (p) => pcts.push(p) })
      return { ok: true, kept: existsSync(dest), pcts }
    } catch (err) {
      return { ok: false, kept: existsSync(dest), message: (err as Error).message }
    }
  }
  const good = await tryDl('/ok', sha, payload.length)
  check('a matching download is kept', [good.ok, good.kept], [true, true])
  ok('and reports progress, never past 99 before it is verified', (good.pcts ?? []).length > 0 && Math.max(...(good.pcts ?? [0])) <= 99)
  const hex = createHash('sha512').update(payload).digest('hex')
  const wrong = await tryDl('/ok', hex, payload.length)
  check('a HEX sha512 never matches — latest.yml\'s is base64 (gotcha 71) — and the file is deleted', [wrong.ok, wrong.kept], [false, false])
  // A connection that drops mid-body fails inside fetch's own stream…
  const short = await tryDl('/truncated', sha, payload.length)
  check('a download cut off mid-body is refused and deleted', [short.ok, short.kept], [false, false])
  // …and a body that arrives whole but is not the size the release lists fails
  // the size check, before the hash is even compared.
  const sized = await tryDl('/ok', sha, payload.length + 1)
  check('a whole body of the wrong size is refused by size, and deleted', [sized.ok, sized.kept, /bytes, not the/.test(sized.message ?? '')], [false, false, true])
  // A destination that cannot be written — a folder that is gone, a full disk —
  // must REJECT, never throw uncaught and leave the download pending forever
  // (found by review: the hand-written loop had no 'error' listener on the file).
  const unwritable = await Promise.race([
    downloadVerified({ url: url('/ok'), sha512: sha, size: payload.length, dest: join(scratch, 'no', 'such', 'dir', 'x.bin'), fetchImpl: (u) => fetch(u) }).then(
      () => 'resolved',
      (e) => `rejected: ${(e as { code?: string }).code ?? (e as Error).message}`
    ),
    new Promise<string>((r) => setTimeout(() => r('HUNG'), 10_000))
  ])
  check('an unwritable destination rejects the download instead of hanging it', unwritable, 'rejected: ENOENT')
  const missing = await tryDl('/missing', sha, payload.length)
  check('a 404 is refused with the status in the message', [missing.ok, /HTTP 404/.test(missing.message ?? '')], [false, true])
  server.close()

  // The unpacked copy's own checks, against a folder built by hand.
  const copy = join(scratch, 'copy')
  mkdirSync(join(copy, 'resources'), { recursive: true })
  writeFileSync(join(copy, 'Stoke.exe'), '')
  writeFileSync(join(copy, 'resources', 'app.asar'), '')
  const v = (x: string | null) => async () => x
  check('no app-update.yml: refused, because that copy could never update again', /never update itself again/.test((await stagedProblem(copy, 'Stoke.exe', '1.0.0', v('1.0.0'))) ?? ''), true)
  writeFileSync(join(copy, 'resources', 'app-update.yml'), 'provider: github\n')
  check('complete, and the version inside matches: no problem', await stagedProblem(copy, 'Stoke.exe', '1.0.0', v('1.0.0')), null)
  check('a different version inside is refused', /says it is 0\.9\.9/.test((await stagedProblem(copy, 'Stoke.exe', '1.0.0', v('0.9.9'))) ?? ''), true)
  check('an unreadable version is refused, not assumed', /Could not read the version/.test((await stagedProblem(copy, 'Stoke.exe', '1.0.0', v(null))) ?? ''), true)

  /*
   * The whole of stagePortable, end to end, where this machine's tar can read a
   * zip (bsdtar: macOS, and Windows' own tar.exe). GNU tar cannot, which is
   * exactly why Stoke names System32\tar.exe and never a bare `tar`.
   */
  const tarPath = ['/usr/bin/bsdtar', '/usr/bin/tar'].find((p) => existsSync(p) && /bsdtar|libarchive/.test(spawnSync(p, ['--version'], { encoding: 'utf8' }).stdout ?? ''))
  if (tarPath && existsSync('/usr/bin/zip')) {
    const zipSrc = join(scratch, 'zipsrc')
    rmSync(zipSrc, { recursive: true, force: true })
    mkdirSync(join(zipSrc, 'resources'), { recursive: true })
    writeFileSync(join(zipSrc, 'Stoke.exe'), 'exe')
    writeFileSync(join(zipSrc, 'resources', 'app.asar'), 'asar')
    writeFileSync(join(zipSrc, 'resources', 'app-update.yml'), 'provider: github\n')
    const zipFile = join(scratch, 'Stoke-1.0.0-x64-win.zip')
    rmSync(zipFile, { force: true })
    execFileSync('/usr/bin/zip', ['-qr', zipFile, '.'], { cwd: zipSrc })
    const bytes = readFileSync(zipFile)
    const zipServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': bytes.length })
      res.end(bytes)
    })
    await new Promise<void>((r) => zipServer.listen(0, '127.0.0.1', () => r()))
    const zport = (zipServer.address() as { port: number }).port
    const appDir = join(scratch, 'apps', 'Stoke')
    const staged = stagedDirFor(appDir, '1.0.0')
    mkdirSync(appDir, { recursive: true })
    const markerAt = join(scratch, 'userData', 'portable-update', 'staged.json')
    const stage = async (sha512: string, version = '1.0.0') => {
      try {
        await stagePortable({
          zip: join(scratch, 'userData', 'portable-update', 'Stoke-1.0.0-x64-win.zip'),
          marker: markerAt,
          url: `http://127.0.0.1:${zport}/z`,
          sha512,
          size: bytes.length,
          staged,
          version,
          exeName: 'Stoke.exe',
          fetchImpl: (u) => fetch(u),
          tools: { tar: tarPath, powershell: null },
          readVersion: async () => '1.0.0'
        })
        return 'ok'
      } catch (err) {
        return (err as Error).message
      }
    }
    const zsha = createHash('sha512').update(bytes).digest('base64')
    const zipAt = join(scratch, 'userData', 'portable-update', 'Stoke-1.0.0-x64-win.zip')
    check('stagePortable end to end: a complete copy beside the app folder, and no zip left behind', [await stage(zsha), readFileSync(join(staged, 'Stoke.exe'), 'utf8'), existsSync(zipAt)], ['ok', 'exe', false])
    check('and the zip went to userData, never beside the app', existsSync(`${staged}.zip`), false)
    check('the marker the helper requires is written once the copy passed its checks, naming it', existsSync(markerAt) && JSON.parse(readFileSync(markerAt, 'utf8')), JSON.parse(stagedMarkerJson(staged, '1.0.0')))
    ok('and it is in userData, never inside the copy that becomes the app folder', !readdirSync(staged).some((n) => /staged|marker/i.test(n)))
    check('a bad checksum leaves NOTHING staged, and no marker', [/checksum/.test(await stage(hex)), existsSync(staged), existsSync(zipAt), existsSync(markerAt)], [true, false, false, false])
    check('a version mismatch leaves nothing staged either', [/says it is 1\.0\.0, not the 2\.0\.0/.test(await stage(zsha, '2.0.0')), existsSync(staged), existsSync(markerAt)], [true, false, false])
    zipServer.close()
  } else {
    console.log('  NOTE  no bsdtar and zip here, so stagePortable end to end is left to the Windows workflow.')
  }
  // Everywhere, tar or not: the marker goes BEFORE the folder is touched, so a
  // helper that starts while a re-stage is under way finds none.
  {
    const marker = join(scratch, 'm', 'staged.json')
    const stagedDir = join(scratch, 'm', 'Stoke.update-1.0.0')
    writeStagedMarkerSync(marker, stagedDir, '1.0.0')
    mkdirSync(stagedDir, { recursive: true })
    const failed = await stagePortable({
      zip: join(scratch, 'm', 'z.zip'),
      marker,
      url: 'http://127.0.0.1:9/never',
      sha512: 'x',
      staged: stagedDir,
      version: '1.0.0',
      exeName: 'Stoke.exe',
      fetchImpl: async () => new Response(null, { status: 404 }),
      tools: { tar: null, powershell: null },
      readVersion: async () => '1.0.0'
    }).then(
      () => 'ok',
      (e) => (e as Error).message
    )
    check('a stale marker from an earlier stage is gone the moment a new one starts, even when it then fails', [/HTTP 404/.test(failed), existsSync(marker), existsSync(stagedDir)], [true, false, false])
  }

  // extractZip refuses cleanly when it has no way to unpack.
  const noTools = await extractZip(join(scratch, 'nope.zip'), join(scratch, 'nope'), { tar: null, powershell: null }).then(
    () => 'ok',
    (e) => (e as Error).message
  )
  check('with no tar.exe and no PowerShell, unpacking says so', /no tar\.exe or PowerShell/.test(noTools), true)
}

console.log('\nthe helper\'s files, its result, and what is swept')
{
  const ud = join(scratch, 'userData', 'portable-update')
  const plan: SwapPlan = { pid: 1, appDir: 'a', staged: 's', stagedMarker: join(ud, 'staged.json'), backup: 'b', resultFile: join(ud, 'result.json'), startedFile: join(ud, 'started.json'), from: '1', to: '2', relaunch: false, exeName: 'Stoke.exe', waitSeconds: 1, renameTries: 1, createdAt: 1_700_000_000_000 }
  mkdirSync(ud, { recursive: true })
  writeFileSync(plan.resultFile, '{"stale":true}')
  writeFileSync(plan.startedFile, '{"pid":1}')
  const { scriptPath, planPath } = writeSwapFilesSync(ud, plan)
  check('writeSwapFilesSync writes the constant script byte for byte, and the plan', [readFileSync(scriptPath, 'ascii') === SWAP_SCRIPT, JSON.parse(readFileSync(planPath, 'utf8')).to], [true, '2'])
  check('and clears a stale result, so the next launch cannot read an old outcome as this one\'s', existsSync(plan.resultFile), false)
  check('and a stale started marker', existsSync(plan.startedFile), false)

  writeFileSync(plan.resultFile, '\uFEFF{"ok":false,"step":"wait","message":"m","from":"1","to":"2","dir":"d","at":5}')
  const r = await readSwapResult(plan.resultFile)
  check('a result is read (a BOM tolerated) and removed, so it is reported once', [r?.ok, r?.step, existsSync(plan.resultFile)], [false, 'wait', false])
  check('no result is null', await readSwapResult(plan.resultFile), null)
  writeFileSync(plan.resultFile, 'not json')
  check('garbage is null, not a crash', await readSwapResult(plan.resultFile), null)

  const parent = join(scratch, 'sweep')
  for (const d of ['Stoke', 'Stoke.old-0.9.8', 'Stoke.old-0.9.9', 'Stoke.update-1.0.0', 'Stoke.update-1.0.1', 'Stoke.old-notes', 'Photos']) mkdirSync(join(parent, d), { recursive: true })
  writeFileSync(join(parent, 'Stoke.old-1.0.0'), 'a FILE with a leftover-shaped name')
  const removed = await sweepLeftovers(join(parent, 'Stoke'), ['old', 'update'], [join(parent, 'Stoke.update-1.0.1')])
  check(
    'sweeping removes old and stale update folders, keeps the one in use',
    removed.map((p) => p.slice(parent.length + 1)).sort(),
    ['Stoke.old-0.9.8', 'Stoke.old-0.9.9', 'Stoke.update-1.0.0']
  )
  check(
    'and every bystander survives: the app itself, the user\'s folders, a same-named file',
    readdirSync(parent).sort(),
    ['Photos', 'Stoke', 'Stoke.old-1.0.0', 'Stoke.old-notes', 'Stoke.update-1.0.1']
  )
  check('only the kinds asked for', (await sweepLeftovers(join(parent, 'Stoke'), ['old'])).length, 0)

  // The one irreversible step checks for itself: a leftover-NAMED folder
  // holding anything but a Stoke build is never deleted, whatever put it there.
  mkdirSync(join(parent, 'Stoke.old-0.9.7', 'photos'), { recursive: true })
  writeFileSync(join(parent, 'Stoke.old-0.9.7', 'Stoke.exe'), '')
  writeFileSync(join(parent, 'Stoke.old-0.9.7', 'taxes.pdf'), 'precious')
  mkdirSync(join(parent, 'Stoke.old-0.9.6', 'locales'), { recursive: true })
  writeFileSync(join(parent, 'Stoke.old-0.9.6', 'Stoke.exe'), '')
  const guarded = await sweepLeftovers(join(parent, 'Stoke'), ['old'])
  check('a leftover-named folder with the user\'s files in it survives the sweep; a real old copy does not', [existsSync(join(parent, 'Stoke.old-0.9.7', 'taxes.pdf')), guarded.map((p) => p.slice(parent.length + 1))], [true, ['Stoke.old-0.9.6']])

  // One level down: an old copy whose resources hold a file of the user's is
  // kept; one whose resources and locales are all Stoke's goes.
  mkdirSync(join(parent, 'Stoke.old-0.9.5', 'resources'), { recursive: true })
  writeFileSync(join(parent, 'Stoke.old-0.9.5', 'Stoke.exe'), '')
  writeFileSync(join(parent, 'Stoke.old-0.9.5', 'resources', 'app.asar'), '')
  writeFileSync(join(parent, 'Stoke.old-0.9.5', 'resources', 'my-notes.txt'), 'precious')
  mkdirSync(join(parent, 'Stoke.old-0.9.4', 'resources'), { recursive: true })
  mkdirSync(join(parent, 'Stoke.old-0.9.4', 'locales'), { recursive: true })
  writeFileSync(join(parent, 'Stoke.old-0.9.4', 'Stoke.exe'), '')
  writeFileSync(join(parent, 'Stoke.old-0.9.4', 'resources', 'app.asar'), '')
  writeFileSync(join(parent, 'Stoke.old-0.9.4', 'locales', 'en-US.pak'), '')
  const deep = await sweepLeftovers(join(parent, 'Stoke'), ['old'])
  check('a user\'s file inside resources keeps an old copy from the sweep; a clean one still goes', [existsSync(join(parent, 'Stoke.old-0.9.5', 'resources', 'my-notes.txt')), deep.map((p) => p.slice(parent.length + 1)).sort()], [true, ['Stoke.old-0.9.4']])
  check('listBuild names one level down with a backslash, whatever the platform', (await listBuild(join(parent, 'Stoke.old-0.9.5'))).sort(), ['Stoke.exe', 'resources', 'resources\\app.asar', 'resources\\my-notes.txt'])

  check('entriesNotIn: what the swap would carry away', entriesNotIn(['Stoke.exe', 'photos', 'desktop.ini', 'FFMPEG.DLL'], ['stoke.exe', 'ffmpeg.dll', 'locales']), ['photos'])
  /*
   * The review's medium finding: a Stoke file the NEW build no longer ships (an
   * Electron upgrade dropping a DLL) was refused as "shared", while the
   * classifier — judging by the same shapes — kept calling the folder portable,
   * so every launch downloaded ~100 MB and refused again.
   */
  check('Stoke\'s own files that the new build dropped are not refused: they leave with the old version', entriesNotIn(['Stoke.exe', 'dxil.dll', 'old_percent.pak', 'LICENSE.old.txt', 'resources', 'resources\\elevate.exe', 'locales', 'locales\\xx.pak'], ['Stoke.exe', 'resources', 'locales']), [])
  check('but a stranger is, one level down too', entriesNotIn(['Stoke.exe', 'resources', 'resources\\notes.txt', 'photos'], ['Stoke.exe', 'resources', 'resources\\app.asar']), ['resources\\notes.txt', 'photos'])
  {
    // Every name a refusal gives is one the classifier also calls foreign — so
    // a refused folder is manual from the next launch on, and the loop is gone
    // by construction.
    const appNames = ['Stoke.exe', 'dxil.dll', 'photos', 'resources', 'resources\\notes.txt', 'resources\\app.asar', 'locales', 'locales\\readme.md', 'desktop.ini']
    const refused = entriesNotIn(appNames, ['Stoke.exe', 'resources', 'resources\\app.asar', 'locales'])
    const foreign = foreignEntries(appNames)
    ok('whatever the swap refuses on, the classifier refuses on too', refused.length > 0 && refused.every((n) => foreign.includes(n)), `${JSON.stringify(refused)} vs ${JSON.stringify(foreign)}`)
  }
  const app = join(scratch, 'carry', 'Stoke')
  const next = join(scratch, 'carry', 'Stoke.update-1.0.0')
  mkdirSync(app, { recursive: true })
  mkdirSync(next, { recursive: true })
  writeFileSync(join(app, 'Stoke.exe'), '')
  writeFileSync(join(next, 'Stoke.exe'), '')
  check('swapWouldCarryAway: nothing, for a folder of Stoke\'s own', swapWouldCarryAway(app, next), [])
  writeFileSync(join(app, 'my-notes.txt'), '')
  check('and names a file dropped in since the download', swapWouldCarryAway(app, next), ['my-notes.txt'])
  rmSync(join(app, 'my-notes.txt'))
  mkdirSync(join(app, 'resources'))
  mkdirSync(join(next, 'resources'))
  writeFileSync(join(app, 'resources', 'my-notes.txt'), '')
  check('and one dropped into resources', swapWouldCarryAway(app, next), ['resources\\my-notes.txt'])
  ok('an unreadable folder is unknown, and unknown refuses', swapWouldCarryAway(join(scratch, 'never-created-folder'), next).length === 1)

  // A refusal remembered, so the next pass does not download the same release
  // only to refuse it again — standing only while a name it gave is still there.
  const refusedAt = join(ud, 'refused.json')
  writeRefusalSync(refusedAt, { dir: app, version: '1.0.0', entries: ['resources\\my-notes.txt'], message: 'm' })
  const back = await readRefusal(refusedAt)
  check('a refusal round-trips', [back?.dir, back?.version, back?.entries, back?.message], [app, '1.0.0', ['resources\\my-notes.txt'], 'm'])
  check('it stands for that folder and version while the stranger is there', await refusalStands(back!, app, '1.0.0'), true)
  check('not for another version, nor another folder', [await refusalStands(back!, app, '1.0.1'), await refusalStands(back!, next, '1.0.0')], [false, false])
  rmSync(join(app, 'resources', 'my-notes.txt'))
  check('and moving the stranger out lifts it at once, with nothing to clear by hand', await refusalStands(back!, app, '1.0.0'), false)
  writeFileSync(refusedAt, '{"dir":1}')
  check('a garbled refusal is no refusal', await readRefusal(refusedAt), null)

  // Every recursive delete of an unpacked copy goes through the injected
  // remover (original-fs in Stoke, gotcha 98) — removeTree included, which is
  // what selfUpdate.ts uses for a discarded staged copy.
  const calls: unknown[] = []
  useRemover(async (path, opts) => {
    calls.push([path, opts])
  })
  await removeTree(join(scratch, 'x'))
  useRemover(rm)
  check('removeTree goes through the injected remover, recursively', calls, [[join(scratch, 'x'), { recursive: true, force: true }]])

  const st = join(ud, 'started.json')
  writeFileSync(st, JSON.stringify({ pid: process.pid }))
  check('readStarted: a helper whose pid is alive is still waiting', (await readStarted(st))?.alive, true)
  writeFileSync(st, JSON.stringify({ pid: 2147483000 }))
  check('and one whose pid is gone is not', (await readStarted(st))?.alive, false)
  check('no marker is null — PowerShell never ran it', await readStarted(join(ud, 'nope.json')), null)
  writeFileSync(st, '{"pi')
  check('a marker caught mid-write is there but unreadable, not a dead helper', await readStarted(st), { pid: 0, alive: false, readable: false })

  // When the plan was written: its createdAt, else the file's mtime.
  const planAtFile = join(ud, 'plan-at.json')
  writeFileSync(planAtFile, planJson(plan))
  check('readPlanAt reads the plan\'s createdAt', await readPlanAt(planAtFile), 1_700_000_000_000)
  writeFileSync(planAtFile, '{"cut sh')
  const mt = await readPlanAt(planAtFile)
  ok('a plan cut short falls back to its mtime', typeof mt === 'number' && Math.abs(mt - Date.now()) < 60_000)
  check('no plan is null: no helper was started', await readPlanAt(join(ud, 'no-plan.json')), null)

  /*
   * The review's low finding: "PowerShell never ran it" was decided on the
   * started marker alone, so a Stoke reopened before a slow helper wrote it was
   * told so, and the staged copy was swept out from under the helper.
   */
  const now = 1_700_000_100_000
  const young = now - 5_000
  const old = now - HELPER_START_ALLOWANCE_MS - 1
  const alive = { pid: 5, alive: true, readable: true }
  const dead = { pid: 5, alive: false, readable: true }
  const garbled = { pid: 0, alive: false, readable: false }
  const verdicts = [
    helperVerdict({ planAt: null, now, hasResult: false, started: null }),
    helperVerdict({ planAt: old, now, hasResult: true, started: null }),
    helperVerdict({ planAt: old, now, hasResult: false, started: alive }),
    helperVerdict({ planAt: young, now, hasResult: false, started: null }),
    helperVerdict({ planAt: young, now, hasResult: false, started: garbled }),
    helperVerdict({ planAt: old, now, hasResult: false, started: null }),
    helperVerdict({ planAt: old, now, hasResult: false, started: garbled }),
    helperVerdict({ planAt: old, now, hasResult: false, started: dead }),
    helperVerdict({ planAt: young, now, hasResult: false, started: dead })
  ]
  check(
    'helperVerdict: no plan idle; a result finished; a live helper pending; no marker YET pending; long silence never-ran; a dead helper stopped',
    verdicts,
    ['idle', 'finished', 'pending', 'pending', 'pending', 'never-ran', 'stopped', 'stopped', 'stopped']
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
