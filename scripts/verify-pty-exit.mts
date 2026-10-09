import assert from 'node:assert/strict'
import { setImmediate as turn } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type IPty } from '@lydell/node-pty'
import { PtyExitTracker } from '../src/main/ptyExitTracker.ts'
import { releaseExitedPtyTransports } from '../src/main/ptyTransportCleanup.ts'

let checks = 0
function check(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name)
  console.log(`  PASS ${name}`); checks++
}
function fixture() {
  const listeners: Array<() => void> = []
  const child = { onExit: (callback: () => void) => { listeners.push(callback); return { dispose() {} } } } as unknown as IPty
  return { child, listeners, exit: () => listeners.forEach(callback => callback()) }
}

console.log('\nPTY quit drain: exact native ownership')
const tracker = new PtyExitTracker(), first = fixture(), second = fixture()
tracker.track(first.child); tracker.track(first.child); tracker.track(second.child)
check('the same child has only one exit registration', first.listeners.length, 1)
check('two exact objects stay owned independently', tracker.count, 2)
const deadline = await tracker.wait(15)
check('a deadline reports pending exits', deadline, 2)
check('a deadline keeps native ownership', tracker.count, 2)
first.exit()
check('delivery inside the native callback does not release its object', tracker.count, 2)
await turn()
check('one loop turn still owns the native close', tracker.count, 2)
await turn()
check('the first completed callback releases only its own object', tracker.count, 1)
let drained = false
const waiting = tracker.wait().then(count => { drained = true; return count })
await turn()
check('a closed tab cannot imply the remaining native exit', drained, false)
second.exit()
check('the final callback still needs its close turns', drained, false)
check('the wait finishes only after actual delivery and closing', await waiting, 0)
tracker.track(first.child)
check('an exited object cannot be registered again', tracker.count, 0)
check('an empty drain returns immediately', await tracker.wait(), 0)

console.log('\nPTY quit drain: real native children')
const root = await mkdtemp(join(tmpdir(), 'stoke-pty-exit-'))
const native = new PtyExitTracker(), children: IPty[] = []
try {
  const launch = (code: string) => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.execPath, ['-e', code], { cwd: root, env, cols: 80, rows: 24 })
    children.push(child); native.track(child)
    child.onExit(() => releaseExitedPtyTransports(child))
    return child
  }
  launch('setTimeout(() => process.exit(0), 100)')
  check('a natural native exit drains', await native.wait(), 0)
  const killed = launch('setInterval(() => {}, 1000)')
  killed.kill()
  check('requesting termination still owns the native callback', native.count, 1)
  check('a killed native child drains after actual exit', await native.wait(), 0)
} finally {
  if (native.count) { for (const child of children) { try { child.kill() } catch {} }; await native.wait() }
  await rm(root, { recursive: true, force: true })
}
setTimeout(() => {
  console.error('FAIL native terminal transports remain open after the exit drain')
  process.exit(1)
}, 5000).unref()
process.once('beforeExit', () => console.log(`\n${checks} PTY exit checks passed, including native transport cleanup`))
