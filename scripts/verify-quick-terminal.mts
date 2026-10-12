import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QuickTerminal, quickTerminalEnv } from '../src/main/quickTerminal.ts'
import { discoverTerminalShells, terminalEnvironmentPath, terminalShellArgs } from '../src/main/terminalShells.ts'
import { ownedPtyExits } from '../src/main/ptyExitTracker.ts'
import { QuickTerminalReplay, quickTerminalLink } from '../src/shared/quickTerminal.ts'
import type { QuickTerminalFrame, QuickTerminalState } from '../src/shared/quickTerminal.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { LOCAL_KEYS, portableSettings } from '../src/shared/setupFile.ts'
import { addRefusal, clampTopBar, fitTopBar } from '../src/shared/topBar.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`)
}
async function until(condition: () => boolean | Promise<boolean>, limit = 5000): Promise<boolean> {
  const deadline = Date.now() + limit
  while (!await condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  return await condition()
}
async function refused(action: () => Promise<unknown>): Promise<boolean> { try { await action(); return false } catch { return true } }
const root = await mkdtemp(join(tmpdir(), 'stoke-quick-🔥-'))
let enabled = false
let preparations = 0
const states: QuickTerminalState[] = []
const frames: QuickTerminalFrame[] = []
const service = new QuickTerminal({ enabled: () => enabled, onState: state => states.push(state), onData: frame => frames.push(frame), environment: async () => { preparations++; return quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') } })
try {
  console.log('\nQuick terminal: defaults and the editable top bar')
  check('new and older settings leave it disabled', [hydrateSettings({}).quickTerminal, hydrateSettings({ quickTerminal: 'true' }).quickTerminal], [false, false])
  check('only an explicit true enables it', hydrateSettings({ quickTerminal: true }).quickTerminal, true)
  check('enablement is machine-local', LOCAL_KEYS.includes('quickTerminal'), true)
  check('portable settings do not enable another computer', 'quickTerminal' in portableSettings(hydrateSettings({ quickTerminal: true })), false)
  const bar = clampTopBar({ enabled: true, items: [{ id: 'one', kind: 'terminal', command: 'never execute this' }, { id: 'two', kind: 'terminal' }] })
  check('a single terminal item carries no executable text', bar.items, [{ id: 'one', kind: 'terminal' }])
  check('a second terminal is refused', addRefusal('terminal', bar.items) !== null, true)
  const fit = fitTopBar({ room: 60, gap: 4, fixed: 20, more: 20, items: [{ id: 'one', kind: 'terminal', full: 90, compact: 90 }] })
  check('a narrow top bar keeps the terminal in its actionable overflow', fit.overflow, ['one'])

  console.log('\nQuick terminal: installed shell catalog')
  check('shell arguments follow the executable instead of the OS', ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\powershell.exe', '/opt/homebrew/bin/pwsh', '/bin/bash'].map(terminalShellArgs), [['/d'], ['-NoLogo'], ['-NoLogo'], ['-l']])
  let finishPath!: (path: string) => void
  const refreshing = new Promise<string>(resolve => { finishPath = resolve })
  check('a slow environment refresh cannot consume the shell startup deadline', await terminalEnvironmentPath(refreshing, 'owned-inherited-path', 10), 'owned-inherited-path')
  finishPath('owned-refreshed-path')
  check('later shell discovery uses the completed environment refresh', await terminalEnvironmentPath(refreshing, 'owned-inherited-path', 10), 'owned-refreshed-path')
  check('a failed refresh still permits an absolute installed shell', await terminalEnvironmentPath(Promise.reject(new Error('owned registry refusal')), 'owned-inherited-path', 10), 'owned-inherited-path')
  const windowsShells = await discoverTerminalShells({
    platform: 'win32', env: { ComSpec: 'c:\\windows\\SYSTEM32\\cmd.exe', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, path: 'C:\\tools;relative',
    usable: async path => new Set(['c:\\windows\\system32\\cmd.exe', 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe', 'c:\\tools\\pwsh.exe', 'c:\\program files\\git\\bin\\bash.exe']).has(path.toLowerCase()), canonical: async path => path
  })
  check('Windows offers installed cmd, both PowerShell variants and Git Bash without duplicating Default', windowsShells.map(shell => [shell.id, shell.args]), [['default', ['/d']], ['powershell', ['-NoLogo']], ['pwsh', ['-NoLogo']], ['git-bash', ['-l']]])
  const customDefault = await discoverTerminalShells({ platform: 'win32', env: { ComSpec: 'C:\\tools\\pwsh.exe', SystemRoot: 'C:\\Windows' }, path: 'C:\\tools', usable: async path => path === 'C:\\tools\\pwsh.exe' || path === 'C:\\Windows\\System32\\cmd.exe', canonical: async path => path })
  check('a PowerShell default uses PowerShell arguments and still offers cmd', customDefault.map(shell => [shell.id, shell.args]), [['default', ['-NoLogo']], ['cmd', ['/d']]])
  const aliases = await discoverTerminalShells({ platform: 'linux', env: { SHELL: '/bin/bash' }, path: '/usr/bin', usable: async path => ['/bin/bash', '/usr/bin/bash', '/bin/sh'].includes(path), canonical: async path => path === '/bin/bash' ? '/usr/bin/bash' : path })
  check('filesystem aliases do not create two entries for the same shell', aliases.map(shell => shell.id), ['default', 'sh'])
  const catalog = await service.shells()
  check('listing installed shells starts no quick shell and exposes no executable arguments', [catalog.length > 0, preparations, service.view().id, catalog.every(shell => !('args' in shell))], [true, 0, null, true])

  console.log('\nQuick terminal: opt-in and a real native shell')
  check('reading does not prepare or start a process', [service.snapshot().state.phase, preparations], ['idle', 0])
  check('disabled open is refused before preparation', await refused(() => service.open('panel', root)), true)
  enabled = true; service.refreshSettings()
  check('enabling still has no process', [service.view().phase, preparations], ['idle', 0])
  const first = service.open('panel', root)
  check('a second open cannot race the first preparation', await refused(() => service.open('popout', root)), true)
  const state = await first; const id = state.id!
  check('the current terminal may open only complete web links', [quickTerminalLink(state, 'panel', id, 'http://localhost:3000/a'), quickTerminalLink(state, 'panel', id, 'file:///etc/passwd'), quickTerminalLink(state, 'panel', id, 'https://example.com/\nnext'), quickTerminalLink(state, 'panel', id, { url: 'https://example.com' })], ['http://localhost:3000/a', null, null, null])
  check('a disabled or obsolete view cannot dispatch links', [quickTerminalLink({ ...state, enabled: false }, 'panel', id, 'https://example.com'), quickTerminalLink(state, 'popout', id, 'https://example.com'), quickTerminalLink(state, 'panel', 'older-shell', 'https://example.com'), quickTerminalLink({ ...state, mode: 'hidden' }, 'panel', id, 'https://example.com')], [null, null, null, null])
  check('the cwd is canonical and Unicode survives', state.cwd, await realpath(root))
  check('it is an ordinary platform shell', state.shell.toLowerCase().includes(process.platform === 'win32' ? 'cmd.exe' : '/'), true)
  service.write('panel', id, process.platform === 'win32' ? 'echo STOKE_QUICK_ONE>verified.txt & type verified.txt\r' : "printf 'STOKE_QUICK_ONE🔥\\n' > verified.txt; cat verified.txt\r")
  check('native shell really executes the command in its folder', await until(async () => { try { return (await readFile(join(root, 'verified.txt'), 'utf8')).includes('STOKE_QUICK_ONE') } catch { return false } }), true)
  check('native shell output reaches the mirror', await until(() => service.snapshot().data.includes('STOKE_QUICK_ONE')), true)

  console.log('\nQuick terminal: real shell switching retains processes, commands and buffers')
  const alternate = catalog.find(shell => shell.id === (process.platform === 'win32' ? 'powershell' : 'bash')) ?? catalog.find(shell => shell.id !== 'default')
  check('a second native shell is installed on this target', !!alternate, true)
  if (alternate) {
    check('arbitrary executable paths cannot be selected', await refused(() => service.selectShell('panel', process.execPath)), true)
    check('a stale view cannot switch shells', await refused(() => service.selectShell('popout', alternate.id)), true)
    const waiter = join(root, 'wait-for-switch.cjs')
    await writeFile(waiter, `const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('switch.ready')) { clearInterval(timer); fs.writeFileSync('background.txt', 'STOKE_BACKGROUND_DONE'); process.stdout.write('STOKE_BACKGROUND_DONE\\n'); } }, 20);`)
    const quote = (text: string): string => process.platform === 'win32' ? `"${text}"` : `'${text.replace(/'/g, "'\\''")}'`
    const keepVariable = process.platform === 'win32' ? 'set STOKE_SWAP_VALUE=retained & ' : 'STOKE_SWAP_VALUE=retained; '
    service.write('panel', id, `${keepVariable}${quote(process.execPath)} ${quote(waiter)}\r`)
    const switching = service.selectShell('panel', alternate.id)
    check('simultaneous switches cannot create duplicate shells', await refused(() => service.selectShell('panel', 'default')), true)
    const selected = await switching
    const alternateId = selected.id!
    check('the selected native shell has its own identity and the same folder', [selected.shellId, alternateId !== id, selected.cwd], [alternate.id, true, state.cwd])
    check('both shells stay running', selected.sessions.filter(session => session.phase === 'running').length, 2)
    service.write('panel', id, process.platform === 'win32' ? 'echo WRONG>wrong-shell.txt\r' : 'printf WRONG > wrong-shell.txt\r')
    service.resize('panel', id, 121, 31)
    check('the inactive shell id cannot resize the selected shell', [service.view().cols, service.view().rows], [80, 24])
    check('the inactive shell id cannot dispatch links', quickTerminalLink(selected, 'panel', id, 'https://example.com'), null)
    const readyCommand = process.platform === 'win32' ? "Set-Content -Path switch.ready -Value READY; Write-Output STOKE_OTHER_SHELL\r" : "printf READY > switch.ready; printf 'STOKE_OTHER_SHELL\\n'\r"
    service.write('panel', alternateId, readyCommand)
    check('a command in the original shell completes while another shell is selected', await until(async () => { try { return (await readFile(join(root, 'background.txt'), 'utf8')) === 'STOKE_BACKGROUND_DONE' } catch { return false } }), true)
    check('the selected shell also executes real commands', await until(() => service.snapshot().data.includes('STOKE_OTHER_SHELL')), true)
    check('invalid selection preserves the selected process', [await refused(() => service.selectShell('panel', 'missing')), service.view().id], [true, alternateId])
    const restored = await service.selectShell('panel', 'default')
    check('switching back reuses the original process and retained output', [restored.id, service.snapshot().data.includes('STOKE_QUICK_ONE'), await until(() => service.snapshot().data.includes('STOKE_BACKGROUND_DONE'))], [id, true, true])
    const variableFrames = frames.length
    service.write('panel', id, process.platform === 'win32' ? 'echo VALUE=%STOKE_SWAP_VALUE%\r' : 'printf "VALUE=%s\\n" "$STOKE_SWAP_VALUE"\r')
    check('switching back retains shell variables', await until(() => frames.slice(variableFrames).some(frame => frame.data.includes('VALUE=retained'))), true)
    check('obsolete input did not create a file', await refused(() => access(join(root, 'wrong-shell.txt'))), true)
    check('state revisions remain monotonic across shell switches', states.every((value, index) => !index || value.revision > states[index - 1].revision), true)
  }
  const before = service.snapshot()
  service.move('popout')
  check('handoff keeps the same shell and output', [service.view().id, service.snapshot().sequence >= before.sequence, service.snapshot().data.includes('STOKE_QUICK_ONE')], [id, true, true])
  const marker = join(root, 'wrong-view.txt')
  const command = process.platform === 'win32' ? `echo WRONG > "${marker}"\r` : "printf WRONG > wrong-view.txt\r"
  service.write('panel', id, command)
  await new Promise(resolve => setTimeout(resolve, 40))
  let wrongFile = false
  try { await access(marker); wrongFile = true } catch { /* expected */ }
  check('the old panel cannot execute a command after transfer', wrongFile, false)
  service.resize('panel', id, 111, 33)
  check('the old panel cannot resize the pop-out shell', [service.view().cols, service.view().rows], [80, 24])
  service.resize('popout', id, 91, 27)
  check('the active view owns the grid', [service.view().cols, service.view().rows], [91, 27])
  service.write('popout', 'another-agent-id', command)
  service.move('hidden')
  check('hiding retains the running shell', [service.view().phase, service.view().id], ['running', id])
  service.move('panel')
  const n = frames.length
  service.write('panel', id, process.platform === 'win32' ? 'echo STOKE_QUICK_TWO\r' : "printf 'STOKE_QUICK_TWO\\n'\r")
  check('the same shell resumes accepting input', await until(() => frames.slice(n).some(frame => frame.data.includes('STOKE_QUICK_TWO'))), true)
  check('a running shell cannot be restarted alongside itself', await refused(() => service.restart('panel')), true)
  service.write('panel', id, 'exit\r')
  check('natural exit is retained with its last screen', await until(() => service.view().phase === 'exited'), true)
  check('reopening an ended shell does not secretly spawn', (await service.open('popout')).id, id)
  const next = await service.restart('panel')
  check('explicit new shell has a new identity', next.id !== id, true)
  enabled = false; service.disable()
  check('disable hides and waits for process exit', [service.view().mode, await until(() => service.view().phase === 'exited')], ['hidden', true])
  check('disabling also closes inactive shell processes', await until(() => service.view().sessions.every(session => session.phase === 'exited')), true)
  enabled = true; service.refreshSettings()
  check('reenabling does not relaunch commands', service.view().phase, 'exited')
  if (process.platform !== 'win32') {
    const held = await service.restart('panel')
    service.write('panel', held.id!, "trap '' HUP; printf READY > hold.ready\r")
    check('the real shell installs its HUP handler before shutdown', await until(async () => { try { return (await readFile(join(root, 'hold.ready'), 'utf8')) === 'READY' } catch { return false } }), true)
    const began = Date.now(); service.end()
    check('shutdown retains ownership of an uncooperative shell', [service.view().phase, await refused(() => service.restart('popout'))], ['stopping', true])
    check('an ignored HUP eventually forces only the owned shell to exit', await until(() => service.view().phase === 'exited'), true)
    check('the grace period is actually observed', Date.now() - began >= 1800, true)
  }

  console.log('\nQuick terminal: snapshot boundary and environment isolation')
  const written: string[] = []; const replay = new QuickTerminalReplay(id, data => written.push(data))
  replay.frame({ id, sequence: 1, data: 'already captured' }); replay.frame({ id, sequence: 3, data: 'after' })
  replay.frame({ id: 'another-shell', sequence: 99, data: 'wrong' })
  replay.snapshot({ state, sequence: 2, data: 'snapshot🔥' })
  replay.frame({ id, sequence: 3, data: 'duplicate' }); replay.frame({ id, sequence: 4, data: 'next' })
  check('queued frames covered by a snapshot never replay twice', written, ['snapshot🔥', 'after', 'next'])
  const env = quickTerminalEnv({ PATH: '/stale', NODE_OPTIONS: 'never', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_CHILD_SESSION: 'yes', TERM_PROGRAM: 'another-wrapper', STOKE_QUICK_FIXTURE: 'retained' }, '/usr/bin:/bin')
  check('agent runtime markers cannot nest shell commands', [env.NODE_OPTIONS, env.ELECTRON_RUN_AS_NODE, env.CLAUDE_CODE_CHILD_SESSION, env.TERM_PROGRAM, env.STOKE_QUICK_FIXTURE], [undefined, undefined, undefined, 'Stoke', 'retained'])

  console.log('\nQuick terminal: cancellation and bad folders')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const pending = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => { calls++; await gate; return env } })
  const opening = pending.open('panel', root)
  pending.disable(); pending.refreshSettings()
  check('a canceled preparation keeps its claim until it settles', await refused(() => pending.open('panel', root)), true)
  release(); check('a disable while preparing never starts a late shell', await refused(() => opening), true)
  check('canceled state is idle', [pending.view().phase, calls], ['idle', 1]); pending.dispose()
  check('a disposed service refuses a later open', await refused(() => pending.open('panel', root)), true)
  check('a disposed service refuses a restart', await refused(() => pending.restart('panel')), true)
  let releaseCatalog!: () => void
  const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve })
  let latePreparations = 0
  const slowCatalog = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, shells: async () => { await catalogGate; return [{ id: 'default', label: 'Default', path: process.execPath, args: [] }] }, environment: async () => { latePreparations++; return env } })
  slowCatalog.move('panel')
  const selecting = slowCatalog.selectShell('panel', 'default')
  enabled = false; slowCatalog.disable(); enabled = true; slowCatalog.refreshSettings()
  check('a disable while discovering shells retains its operation claim', await refused(() => slowCatalog.selectShell('panel', 'default')), true)
  releaseCatalog()
  check('reenabling cannot resurrect a canceled shell selection', [await refused(() => selecting), latePreparations, slowCatalog.view().id, slowCatalog.view().mode], [true, 0, null, 'hidden'])
  slowCatalog.dispose()
  const resolved = await discoverTerminalShells()
  let releaseSwitch!: () => void
  const switchGate = new Promise<void>(resolve => { releaseSwitch = resolve })
  let switchPreparations = 0
  const guarded = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, shells: async () => [...resolved, { id: 'removed', label: 'Removed', path: join(root, 'missing-shell'), args: [] }], environment: async () => { if (++switchPreparations === 3) await switchGate; return quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') } })
  try {
    const original = await guarded.open('panel', root)
    check('a failed shell launch preserves the active process and view', [await refused(() => guarded.selectShell('panel', 'removed')), guarded.view().id, guarded.view().phase, guarded.view().sessions.length], [true, original.id, 'running', 1])
    const other = resolved.find(shell => shell.id !== 'default')
    if (other) {
      const delayedSwitch = guarded.selectShell('panel', other.id)
      await until(() => switchPreparations === 3)
      enabled = false; guarded.disable(); enabled = true; guarded.refreshSettings()
      releaseSwitch()
      check('disabling and reenabling during shell preparation never launches the pending selection', [await refused(() => delayedSwitch), guarded.view().shellId, guarded.view().mode, guarded.view().sessions.length], [true, 'default', 'hidden', 1])
      await until(() => guarded.view().phase === 'exited')
      await guarded.restart('panel'); await guarded.selectShell('panel', other.id)
      check('two saved shell processes remain owned before app disposal', guarded.view().sessions.filter(session => session.phase === 'running').length, 2)
      guarded.dispose()
      check('app disposal drains both the visible and inactive shells', await until(() => guarded.view().sessions.every(session => session.phase === 'exited')), true)
    }
  } finally { releaseSwitch?.(); guarded.dispose() }
  const file = join(root, 'file'); await writeFile(file, 'bystander')
  const bad = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {} })
  check('files are not working folders', await refused(() => bad.open('panel', file)), true)
  check('relative folders are refused', await refused(() => bad.open('panel', 'relative')), true)
  if (process.platform !== 'win32') {
    const alias = `${root}-alias`; await symlink(root, alias)
    try { await bad.open('panel', alias); check('symlink aliases use one canonical folder', bad.view().cwd, await realpath(root)); bad.end(); await until(() => bad.view().phase === 'exited') }
    finally { await rm(alias, { force: true }) }
  }
  bad.dispose()
} finally { service.dispose(); check('all owned native shell callbacks drain before shutdown', await ownedPtyExits.wait(), 0); await rm(root, { recursive: true, force: true }) }
// A success also requires the real native transports to let Node exit. An
// unref'd watchdog cannot prolong a healthy run, but makes a leaked worker
// fail instead of leaving the Windows portability job stuck for 45 minutes.
setTimeout(() => {
  console.error('  FAIL native terminal transports remain open after shell exit and cleanup')
  process.exit(1)
}, 5000).unref()
process.once('beforeExit', () => {
  console.log(`\n${failures ? `${failures} failures` : 'All quick terminal checks passed, including native transport cleanup'}`)
  process.exitCode = failures ? 1 : 0
})
