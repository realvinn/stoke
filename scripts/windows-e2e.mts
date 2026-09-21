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
} else {
  fail('usage: node scripts/windows-e2e.mts swap-files|wait-result|classify …')
}
