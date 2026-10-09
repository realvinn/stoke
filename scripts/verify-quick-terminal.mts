import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QuickTerminal, quickTerminalEnv } from '../src/main/quickTerminal.ts'
import { QuickTerminalReplay } from '../src/shared/quickTerminal.ts'
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

  console.log('\nQuick terminal: opt-in and a real native shell')
  check('reading does not prepare or start a process', [service.snapshot().state.phase, preparations], ['idle', 0])
  check('disabled open is refused before preparation', await refused(() => service.open('panel', root)), true)
  enabled = true; service.refreshSettings()
  check('enabling still has no process', [service.view().phase, preparations], ['idle', 0])
  const first = service.open('panel', root)
  check('a second open cannot race the first preparation', await refused(() => service.open('popout', root)), true)
  const state = await first; const id = state.id!
  check('the cwd is canonical and Unicode survives', state.cwd, await realpath(root))
  check('it is an ordinary platform shell', state.shell.toLowerCase().includes(process.platform === 'win32' ? 'cmd.exe' : '/'), true)
  service.write('panel', id, process.platform === 'win32' ? 'echo STOKE_QUICK_ONE>verified.txt & type verified.txt\r' : "printf 'STOKE_QUICK_ONE🔥\\n' > verified.txt; cat verified.txt\r")
  check('native shell really executes the command in its folder', await until(async () => { try { return (await readFile(join(root, 'verified.txt'), 'utf8')).includes('STOKE_QUICK_ONE') } catch { return false } }), true)
  check('native shell output reaches the mirror', await until(() => service.snapshot().data.includes('STOKE_QUICK_ONE')), true)
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
} finally { service.dispose(); await rm(root, { recursive: true, force: true }) }
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
