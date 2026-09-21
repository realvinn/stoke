/*
 * The Windows workflow's hands (.github/workflows/windows.yml), for the steps
 * that must use Stoke's OWN code rather than a copy of it in YAML.
 *
 *   node scripts/windows-e2e.mts swap-files <dir> <pid> <appDir> <staged> <from> <to> <relaunch 0|1>
 *       Writes the portable-update helper and its plan into <dir> exactly as
 *       selfUpdate.ts `startSwap` does (writeSwapFilesSync), and prints the
 *       powershell.exe argv, one argument per line, for the caller to start.
 *
 *   node scripts/windows-e2e.mts wait-result <file> <seconds>
 *       Waits for the helper's result.json and prints it; exits 1 if it never
 *       appears or says ok: false.
 *
 *   node scripts/windows-e2e.mts classify
 *       Runs the install-kind probe the app runs at startup against THIS
 *       process's facts — pointed at a Stoke.exe with --exec — and prints the
 *       verdict. What the packaged app decides is asked of the app itself over
 *       CDP; this is the same function, for a folder no Stoke is running from.
 *
 *   node scripts/windows-e2e.mts registry-path <dir> <file>
 *       The caller has put <dir> on the USER PATH in the registry (and <file>
 *       in it) AFTER this process's own PATH was fixed. Stoke's locator must
 *       find <file> anyway — the registry re-read is the only way it can
 *       (gotcha 99) — and loginShellPathValue must name <dir>.
 *
 *   node scripts/windows-e2e.mts pty-path
 *       Spawns `cmd /d /c echo %PATH%` through the real node-pty twice: with the
 *       env the old pty.ts built (the inherited `Path` AND a fresh `PATH`) and
 *       with setPathKey's one key. Reports which PATH each child saw; fails if
 *       the fixed one does not see the fresh value.
 *
 * Not a verify suite: every command acts on the machine it runs on.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { backupDirFor, swapArgs } from '../src/main/portableSwap.ts'
import { gatherInstallFacts, writeSwapFilesSync } from '../src/main/portableUpdate.ts'
import { classifyInstall } from '../src/shared/installKind.ts'

const [cmd, ...rest] = process.argv.slice(2)

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

if (cmd === 'swap-files') {
  const [dir, pid, appDir, staged, from, to, relaunch] = rest
  if (!dir || !pid || !appDir || !staged || !from || !to || relaunch === undefined) fail('usage: swap-files <dir> <pid> <appDir> <staged> <from> <to> <relaunch 0|1>')
  const plan = {
    pid: Number(pid),
    appDir,
    staged,
    backup: backupDirFor(appDir, from),
    resultFile: join(dir, 'result.json'),
    startedFile: join(dir, 'started.json'),
    from,
    to,
    relaunch: relaunch === '1',
    exeName: 'Stoke.exe',
    waitSeconds: 120,
    renameTries: 40
  }
  const { scriptPath, planPath } = writeSwapFilesSync(dir, plan)
  for (const a of swapArgs(scriptPath, planPath)) console.log(a)
} else if (cmd === 'wait-result') {
  const [file, seconds] = rest
  if (!file) fail('usage: wait-result <file> <seconds>')
  const deadline = Date.now() + Number(seconds ?? 120) * 1000
  while (!existsSync(file)) {
    if (Date.now() > deadline) fail(`no result at ${file} after ${seconds}s — the helper never finished (or never ran)`)
    await new Promise((r) => setTimeout(r, 500))
  }
  // A moment for the writer to finish; WriteAllText is one call but not atomic.
  await new Promise((r) => setTimeout(r, 300))
  const raw = readFileSync(file, 'utf8')
  console.log(raw)
  const r = JSON.parse(raw.replace(/^﻿/, '')) as { ok?: boolean }
  process.exitCode = r.ok ? 0 : 1
} else if (cmd === 'classify') {
  const at = rest.indexOf('--exec')
  const execPath = at === -1 ? process.execPath : rest[at + 1]
  const facts = await gatherInstallFacts({ platform: process.platform, packaged: true, execPath, env: process.env })
  console.log(JSON.stringify({ facts, kind: classifyInstall(facts) }, null, 2))
} else if (cmd === 'registry-path') {
  const [dir, file] = rest
  if (!dir || !file) fail('usage: registry-path <dir> <file>')
  const { findTool, loginShellPathValue } = await import('../src/main/cli.ts')
  const own = (process.env.PATH ?? process.env.Path ?? '').toLowerCase()
  if (own.includes(dir.toLowerCase())) fail(`${dir} is already on this process's own PATH, so this would test nothing`)
  const registryPath = (await loginShellPathValue()) ?? ''
  const seen = registryPath.toLowerCase().split(';').some((p) => p.replace(/\\+$/, '') === dir.toLowerCase().replace(/\\+$/, ''))
  console.log(`registry PATH read: ${registryPath ? `${registryPath.split(';').length} entries` : 'NOTHING'}; names ${dir}: ${seen}`)
  const found = await findTool([file])
  console.log(`findTool(${file}) -> ${found}`)
  if (!seen) fail('the registry PATH Stoke reads does not name a folder just added to the user PATH')
  if (!found || found.toLowerCase() !== join(dir, file).toLowerCase()) fail('Stoke\'s locator did not find a tool that is only on the registry PATH')
  console.log('found through the registry, without a restart')
} else if (cmd === 'pty-path') {
  const { setPathKey } = await import('../src/main/cli.ts')
  const pty = (await import('@lydell/node-pty')) as unknown as typeof import('@lydell/node-pty')
  const marker = 'C:\\STOKE-FRESH-MARKER'
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  const inherited = base.Path ?? base.PATH ?? ''
  const see = (env: Record<string, string>): Promise<string> =>
    new Promise((resolve) => {
      let out = ''
      const p = pty.spawn('cmd.exe', ['/d', '/c', 'echo PATH=%PATH%'], { name: 'xterm-256color', cols: 400, rows: 50, cwd: process.cwd(), env, useConpty: true })
      p.onData((d) => (out += d))
      p.onExit(() => resolve(out))
    })
  // The old pty.ts: a copy of process.env (key `Path`), then `env.PATH = …`.
  const old: Record<string, string> = { ...base }
  old.PATH = `${marker};${inherited}`
  const oldOut = await see(old)
  const fixed: Record<string, string> = { ...base }
  setPathKey(fixed, `${marker};${inherited}`, 'win32')
  const fixedOut = await see(fixed)
  console.log(`old env keys: ${Object.keys(old).filter((k) => k.toUpperCase() === 'PATH').join(', ')} -> child saw the fresh PATH: ${oldOut.includes(marker)}`)
  console.log(`fixed env keys: ${Object.keys(fixed).filter((k) => k.toUpperCase() === 'PATH').join(', ')} -> child saw the fresh PATH: ${fixedOut.includes(marker)}`)
  if (!fixedOut.includes(marker)) fail('with setPathKey the child still did not see the PATH Stoke built')
} else {
  fail('usage: node scripts/windows-e2e.mts swap-files|wait-result|classify|registry-path|pty-path …')
}
