/*
 * A scratch temp directory for a whole suite run, and a check that the REAL
 * shared statusLine directory was left alone (gotcha 74: fake every input or
 * none).
 *
 * `statusLineDir()` is `<tmpdir()>/stoke/statusline`, ONE directory shared by
 * every Stoke on the machine: the installed app's live sessions run its
 * `run.sh` and `wrapper.mjs` for their status line and for the Stop,
 * Notification and UserPromptSubmit hooks. A suite that calls
 * `writeStatusLineWrapper()` there replaces both with the working tree's copy,
 * and the shim then points at this plain `node` rather than Stoke's own binary.
 * Measured 2026-10-27 on the owner's Mac: `run.sh` read
 * `ELECTRON_RUN_AS_NODE=1 exec "<…>/node/bin/node" …/wrapper.mjs` with the
 * mtime of the last `npm run check`, while the installed app's live sessions
 * pointed their `--settings` at it. verify-statusline even deletes
 * `wrapper.mjs` and puts a DIRECTORY there for a moment, so a live session's
 * status line or hook call landing in that window fails, and a lost Stop leaves
 * a tab's dot on "working".
 *
 * So a suite that writes or deletes there imports this module FIRST, as a bare
 * side-effect import above every other import:
 *
 *   import './suite-tmpdir.mts'
 *
 * ESM evaluates a module's imports in order before its body, so this body runs
 * before any module under test, and every later `tmpdir()` in this process
 * answers the scratch folder: the wrapper, `run.sh`/`run.cmd`, settings files,
 * payloads, events, sweeps, `ultracode-settings.json` and the suite's own
 * mkdtemp fixtures. Child processes inherit the environment, so the real
 * wrapper still runs under the real node, the way the CLI runs it. Nothing in
 * `src/` changes: the packaged app honours no new switch, it reads `TMPDIR`
 * exactly as it always did, and only this suite's own process is moved.
 *
 * Then, as the suite's FIRST statement, before anything is written:
 *
 *   requireScratch(statusLineDir(), 'statusLineDir()')
 *
 * which stops the run on the spot if the directory under test is not in the
 * scratch folder. A counted check is not enough there: a failed check lets the
 * suite carry on into exactly the writes it exists to prevent.
 *
 * The scratch folder is removed on exit, Ctrl-C and SIGTERM included.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The temp directory this process inherited, which is the one every Stoke on the machine uses. */
export const SHARED_TMPDIR = tmpdir()

/** The real shared statusLine directory, spelled the way `statusLineDir()` spells it. */
export const SHARED_STATUSLINE_DIR = join(SHARED_TMPDIR, 'stoke', 'statusline')

/** The files every Stoke session on the machine runs. A Stoke rewrites them on every launch, and never removes them. */
const SHIM_FILES = ['wrapper.mjs', 'run.sh', 'run.cmd'] as const

/** The shim this platform's sessions run; the one that names the executable it starts. */
const PLATFORM_SHIM = process.platform === 'win32' ? 'run.cmd' : 'run.sh'

interface Print {
  kind: 'absent' | 'file' | 'other'
  ino?: string
  mtimeNs?: string
  size?: string
  sha256?: string
}

function print(path: string): Print {
  try {
    const st = lstatSync(path, { bigint: true })
    if (!st.isFile()) return { kind: 'other' }
    return {
      kind: 'file',
      ino: String(st.ino),
      mtimeNs: String(st.mtimeNs),
      size: String(st.size),
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  } catch {
    return { kind: 'absent' }
  }
}

function snapshot(): { dir: boolean; files: Record<string, Print> } {
  const files: Record<string, Print> = {}
  for (const name of SHIM_FILES) files[name] = print(join(SHARED_STATUSLINE_DIR, name))
  return { dir: existsSync(SHARED_STATUSLINE_DIR), files }
}

/** Taken before anything in this process can reach the directory. */
const BEFORE = snapshot()

/** This run's own temp directory. Every `tmpdir()` in this process answers it from here on. */
export const SCRATCH_TMPDIR = mkdtempSync(join(SHARED_TMPDIR, 'stoke-suite-tmp-'))

// os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on Windows: set all three.
process.env.TMPDIR = SCRATCH_TMPDIR
process.env.TMP = SCRATCH_TMPDIR
process.env.TEMP = SCRATCH_TMPDIR

if (tmpdir() !== SCRATCH_TMPDIR) {
  // Refuse to run at all rather than run against the shared directory.
  rmSync(SCRATCH_TMPDIR, { recursive: true, force: true })
  throw new Error(`suite-tmpdir: tmpdir() still answers ${tmpdir()}, not the scratch ${SCRATCH_TMPDIR}; refusing to run`)
}

process.on('exit', () => {
  try {
    rmSync(SCRATCH_TMPDIR, { recursive: true, force: true })
  } catch {
    // A child still holding a file (Windows); the OS temp cleaner gets it.
  }
})

// A signal's default action ends the process without 'exit', which would leave
// the folder behind in the real temp directory. Exit instead, with the code the
// signal would have given, so the handler above runs. Once: a second Ctrl-C
// gets the default again.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  process.once(signal, () => process.exit(code))
}

/** Whether `path` lies inside this run's scratch directory. */
export function inScratch(path: string): boolean {
  return path.startsWith(SCRATCH_TMPDIR + (process.platform === 'win32' ? '\\' : '/'))
}

/**
 * Stops the run at once, exit code 1, unless `path` lies inside this run's
 * scratch directory. Called as a suite's first statement with the directory its
 * module under test will write (`statusLineDir()`), so a `statusLineDir()` that
 * one day stops deriving from `tmpdir()`, or a redirect that did not take, ends
 * the run before its first write rather than being counted as one failure among
 * the writes that follow it. Written with `writeSync` because a piped stdout or
 * stderr is asynchronous on macOS and `process.exit` would drop the line.
 */
export function requireScratch(path: string, what: string): void {
  if (inScratch(path)) return
  writeSync(
    2,
    `  FAIL  ${what} is ${path}, outside this run's scratch folder ${SCRATCH_TMPDIR}.\n` +
      '        Stopping before the first write: carrying on would rewrite the shim every\n' +
      '        Stoke session on this machine runs (gotcha 74).\n'
  )
  process.exit(1)
}

/**
 * What a SUITE did to the real shared directory while this run was going, as
 * findings (empty when nothing did). Called by the suite as one check before its
 * tally.
 *
 * A Stoke running beside the suite rewrites `wrapper.mjs` and the shim on every
 * session it launches, so a changed file alone is not evidence. A change counts
 * as a suite's when the platform shim now names THIS process's executable (the
 * app's names Stoke's own binary, `npm run dev`'s its Electron, and a suite's
 * names the node it ran under), when a shim file that existed is gone or is not
 * a file (no Stoke removes one; verify-statusline once put a directory there),
 * or when the directory itself appeared without a Stoke's shim in it. `notes`
 * lists changes a Stoke made.
 *
 * This process's node is not proof that THIS run was the writer: an unfixed
 * suite run elsewhere on the same node (an older checkout, another worktree, a
 * run without this import) leaves the same shim. The findings say so; either
 * way the live shim was rewritten by a suite, which is the damage.
 */
export function sharedStatusLineDamage(): { findings: string[]; notes: string[] } {
  const after = snapshot()
  const findings: string[] = []
  const notes: string[] = []
  let shimText = ''
  try {
    shimText = readFileSync(join(SHARED_STATUSLINE_DIR, PLATFORM_SHIM), 'utf8')
  } catch {
    // absent: judged below by its print
  }
  const shimIsSuites = shimText.includes(process.execPath)
  const bySuite = 'a suite did it: this run, or an unfixed one run elsewhere on the same node'
  if (!BEFORE.dir && after.dir) {
    if (after.files[PLATFORM_SHIM].kind === 'file' && !shimIsSuites) {
      notes.push(`${SHARED_STATUSLINE_DIR} appeared during the run, with a shim that is not a suite's (a Stoke launching a session)`)
    } else {
      findings.push(`${SHARED_STATUSLINE_DIR} did not exist when this run started and does now, with no Stoke's shim in it; ${bySuite}`)
    }
  }
  for (const name of SHIM_FILES) {
    const was = BEFORE.files[name]
    const now = after.files[name]
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    if (was.kind !== 'absent' && now.kind !== 'file') {
      findings.push(`${name} was a ${was.kind} when this run started and is ${now.kind === 'absent' ? 'gone' : 'not a file'} now; no Stoke removes one, so ${bySuite}`)
    } else if (shimIsSuites) {
      findings.push(`${name} was rewritten, and ${PLATFORM_SHIM} now runs this process's own node (${process.execPath}), never a Stoke's binary; ${bySuite}`)
    } else {
      notes.push(`${name} changed during the run, by a writer that is not a suite (a Stoke launching a session)`)
    }
  }
  return { findings, notes }
}
