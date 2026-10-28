/**
 * Driven only by verify-pty-exit: a real Electron main with real ptys, quit
 * the way Stoke quits (gotcha 163). before-quit runs `PtyManager.shutdown()`,
 * as index.ts's does (node-pty's own kill: SIGHUP to each child), and the quit
 * is held by the SHIPPED `holdQuitForPtys`, as index.ts registers it, unless
 * `PTYQUIT_NO_HOLD` asks for the control run without it.
 *
 * Each child is `quit-child.cjs <kind>` from the suite's scratch folder, run by
 * this binary as node. Every step is written to `PTYQUIT_OUT` with a
 * timestamp: `app.exit()` and a quit both drop a piped stdout (CLAUDE.md's
 * standing trap), and the suite times the exit from its own side.
 */
import { app } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from '@lydell/node-pty'
import { PtyManager } from '../src/main/pty.ts'
import { holdQuitForPtys, ownedPtyExits } from '../src/main/ptyExitTracker.ts'

const OUT = process.env.PTYQUIT_OUT ?? ''
const DIR = process.env.PTYQUIT_DIR ?? ''
const kinds = (process.env.PTYQUIT_KINDS ?? '').split(',').filter(Boolean)
const log = (line: string): void => appendFileSync(OUT, `${Date.now()} ${line}\n`)

app.on('window-all-closed', () => {})
process.on('exit', () => log('process-exit'))

const pm = new PtyManager(() => {}, () => {}, () => {})
app.on('before-quit', () => {
  log('before-quit')
  pm.shutdown()
})
if (!process.env.PTYQUIT_NO_HOLD) holdQuitForPtys(app, ownedPtyExits, undefined, (r) => log('settle ' + JSON.stringify(r)))
app.on('will-quit', () => log('will-quit'))
app.on('quit', () => log('quit-event'))

async function main(): Promise<void> {
  if (!OUT || !DIR || !kinds.length) throw new Error('PTYQUIT_OUT, PTYQUIT_DIR and PTYQUIT_KINDS are required')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.ELECTRON_RUN_AS_NODE = '1'
  const pids: Record<string, number>[] = []
  for (const [i, kind] of kinds.entries()) {
    const proc = spawn(process.execPath, [join(DIR, 'quit-child.cjs'), kind], { cwd: DIR, env, cols: 80, rows: 24 })
    // What PtyManager.start does with every local child.
    ownedPtyExits.track(proc)
    let out = ''
    let markExited: () => void = () => {}
    const exitedPromise = new Promise<void>((resolve) => { markExited = resolve })
    const session = { ptyId: `quit-${i}`, statusKey: '', proc, exited: false, exitedPromise, installFile: null, mirror: { dispose() {} } }
    proc.onData((d) => { out += d })
    proc.onExit((e) => {
      session.exited = true
      markExited()
      log(`child-exit ${kind} ${proc.pid} ${JSON.stringify(e)}`)
    })
    // The private map, by hand, as verify-terminal-stall does: start()'s spawn is not under test, its kill is.
    ;(pm as unknown as { sessions: Map<string, unknown> }).sessions.set(session.ptyId, session)
    for (let n = 0; n < 200 && !/READY child=\d+ grand=\d+/.test(out); n++) await new Promise((r) => setTimeout(r, 25))
    const m = /READY child=(\d+) grand=(\d+)/.exec(out)
    if (!m) throw new Error(`the ${kind} child never said READY: ${JSON.stringify(out)}`)
    pids.push({ child: Number(m[1]), grand: Number(m[2]) })
  }
  log('ready ' + JSON.stringify({ electron: process.pid, kinds, pids }))
  await new Promise((r) => setTimeout(r, 200))
  log('quit')
  app.quit()
}

app.whenReady().then(main).catch((err) => {
  log('error ' + String(err?.stack ?? err).replace(/\n/g, ' | '))
  app.exit(1)
})
