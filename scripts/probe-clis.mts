/*
 * What Stoke's own locator finds on THIS machine, and whether each find runs.
 *
 *   node scripts/probe-clis.mts [--path-file <file>] [--expect claude,codex,...] [--json <out>]
 *
 * Not a verify suite: it asserts nothing about the repo and everything about
 * the machine, which is why it is not in `check`. It exists for the Windows
 * workflow (.github/workflows/windows.yml), which installs coding agents by
 * every route their vendors document and then asks the one question that
 * matters to a Stoke user: does Stoke find it, and does it start?
 *
 * The answer comes from `detectCodingClis` in src/main/cli.ts itself — the same
 * function the first-run picker and Settings › Coding agents call — imported
 * directly, the way verify:cli does. A copy of the search here would agree with
 * itself and prove nothing.
 *
 * `--path-file` is the point of the exercise on Windows. A running Stoke
 * started BEFORE an install keeps the PATH it was born with: there is no login
 * shell to re-read there (`loginShellPath` is null on win32), so an installer's
 * PATH edit is invisible to it until it restarts. The workflow saves PATH at the
 * start of the job and hands it back here, so a pass means "found without a
 * restart" — the case where a user presses Install in the picker and then
 * Start — rather than "found by a fresh process that inherited the edit".
 */
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  const at = argv.indexOf(name)
  return at === -1 ? null : (argv[at + 1] ?? null)
}

const pathFile = flag('--path-file')
if (pathFile) {
  // Set BEFORE cli.ts is imported and before anything reads it. Trimmed,
  // because `$env:Path | Out-File` and `echo %PATH% >` both end in a newline.
  process.env.PATH = readFileSync(pathFile, 'utf8').replace(/^﻿/, '').trim()
}
const expect = (flag('--expect') ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const { detectCodingClis, spawnSpec } = await import('../src/main/cli.ts')
const { execFileSync } = await import('node:child_process')

const detection = await detectCodingClis()
const rows: { id: string; path: string | null; conflict?: string; version: string | null; error: string | null }[] = []
for (const c of detection.clis) {
  let version: string | null = null
  let error: string | null = null
  if (c.path) {
    try {
      const spec = spawnSpec(c.path, ['--version'])
      // A generous timeout: a first run of a freshly installed Node CLI on a
      // cold Windows runner, with Defender scanning every file it touches, is
      // measured in seconds, not milliseconds.
      version = execFileSync(spec.file, spec.args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        .trim()
        .split('\n')[0]
    } catch (err) {
      const e = err as { killed?: boolean; code?: unknown; stderr?: string; message?: string }
      // gotcha 25: a timeout is `killed: true, code: null`.
      error = e.killed ? 'timed out' : `${String(e.code ?? '')} ${(e.stderr ?? e.message ?? '').trim().split('\n')[0]}`.trim()
    }
  }
  rows.push({ id: c.id, path: c.path, ...('conflict' in c && c.conflict ? { conflict: c.conflict } : {}), version, error })
}

console.log(`PATH given to the locator: ${pathFile ? `saved before the install (${pathFile})` : 'this process\'s own'}`)
for (const r of rows) {
  const state = r.path ? (r.error ? `FOUND, DOES NOT RUN (${r.error})` : `ok  ${r.version}`) : r.conflict ? `conflict: ${r.conflict}` : '-'
  console.log(`  ${r.id.padEnd(9)} ${state}${r.path ? `\n            ${r.path}` : ''}`)
}

const failures: string[] = []
for (const id of expect) {
  const r = rows.find((x) => x.id === id)
  if (!r) failures.push(`${id}: not an agent Stoke knows`)
  else if (!r.path) failures.push(`${id}: installed, but Stoke's locator does not find it`)
  else if (r.error) failures.push(`${id}: found at ${r.path}, but \`--version\` failed: ${r.error}`)
}

const out = flag('--json')
if (out) writeFileSync(out, JSON.stringify({ probeFailed: detection.probeFailed, rows }, null, 2))

if (failures.length) {
  console.log('')
  for (const f of failures) console.log(`FAIL  ${f}`)
}
process.exitCode = failures.length ? 1 : 0
