/**
 * Which SSH key enrollment a pty belongs to, and when it is finished.
 *
 * Its own module, apart from `sshEnroll.ts`: index.ts reads it synchronously
 * from the pty callbacks, so it is imported at module scope, and `sshEnroll.ts`
 * stays a lazy import (gotcha 40). Relative imports with the extension, so
 * `verify:ssh-enroll` loads it under `node --experimental-strip-types`.
 */
import type { SshHost } from '@shared/types'
import { enrollInstallDone, enrollTail } from '../shared/sshAuth.ts'

/** One enrollment tab, from its start to whatever finishes it. */
export interface EnrollRun {
  host: SshHost
  keyPath: string
  fallback: boolean
}

/**
 * The enrollment tabs, by ptyId, each handed out to be proven exactly once:
 * by the tab printing that the install ran to its end (`output`), or by its
 * process exiting (`exit`), whichever comes first.
 *
 * The exit used to be the only way. On the owner's other computer
 * (2026-10-02) the key went on and the tab's process never exited, so the
 * strip sat on "Adding…" with only Not now to press and the tab that asked
 * for the password was never reconnected. What the tab printed is only a hint
 * (`enrollInstallDone`): taking the run on it starts `finishEnroll`'s probe,
 * exactly as an exit with code 0 would, and the probe alone decides.
 */
export class EnrollRuns {
  private readonly runs: Map<string, { run: EnrollRun; tail: string }>

  constructor() {
    this.runs = new Map()
  }

  add(ptyId: string, run: EnrollRun): void {
    this.runs.set(ptyId, { run, tail: '' })
  }

  /** Output from any pty. The run, taken, once its tab has printed that the install is done; else null. */
  output(ptyId: string, data: string): EnrollRun | null {
    const entry = this.runs.get(ptyId)
    if (!entry) return null
    entry.tail = enrollTail(entry.tail, data)
    if (!enrollInstallDone(entry.tail)) return null
    this.runs.delete(ptyId)
    return entry.run
  }

  /** A pty exited. The run, taken, if nothing finished it first; else null. */
  exit(ptyId: string): EnrollRun | null {
    const entry = this.runs.get(ptyId)
    if (!entry) return null
    this.runs.delete(ptyId)
    return entry.run
  }
}
