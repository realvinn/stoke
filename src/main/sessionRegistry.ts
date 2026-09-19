import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { LiveSessionState } from '../shared/types.ts'
import {
  descendsFrom,
  isBusyStatus,
  parseProcessTable,
  parseRegistry,
  pickEntry,
  REGISTRY_FALLBACK_AFTER_MS,
  rebindTo,
  type RegistryEntry,
  type RegistryTarget
} from '../shared/claudeRegistry.ts'

/**
 * Reads Claude Code's own session registry (`<config dir>/sessions/<pid>.json`)
 * for every live local Claude pty, and says when a pty's session id moved or
 * its state changed.
 *
 * Why this exists at all: Stoke learned a tab's session id once, from
 * `pty:start`, and never again — but `/clear` mints a new id and the in-TUI
 * `/resume` switches to another, so relaunch, Resume, tab restore and the
 * sidebar's de-dupe all went on naming the conversation the process had left.
 * A `/clear`ed id has no transcript, so `--resume` on it exits 1 with "No
 * conversation found". And nothing said whether a turn was running, so a
 * relaunch could kill one mid-reply. The CLI already writes both facts to this
 * file; nothing else states them (hooks do not fire on Esc, a `--continue`'s
 * payload is keyed by a launch key). See `src/shared/claudeRegistry.ts`.
 *
 * No `electron` import, and the file system arrives as an argument — gotcha 74:
 * a suite that fakes the clock has to fake the directory too, so
 * `scripts/verify-registry.mts` drives this against a map in memory and never
 * the real `~/.claude/sessions`.
 *
 * Async all the way (gotcha 40) and one pass at a time (gotcha 20): a pass
 * awaits reads, and a slow disk must not let two passes overlap and emit the
 * same rebind twice.
 */

export interface RegistryFs {
  /** The file's text; rejects when it cannot be read (missing is the usual case). */
  readFile(path: string): Promise<string>
  /** Names in the directory; rejects when it cannot be listed. */
  readdir(dir: string): Promise<string[]>
  /**
   * Every process's parent, pid -> ppid, or null when it cannot be read. Only
   * asked for when a pty needs the folder fallback (`pickEntry`), which answers
   * nothing without it. Optional so a caller with no process table simply
   * never takes that fallback.
   */
  processTable?(): Promise<ReadonlyMap<number, number> | null>
}

export interface RegistryEvents {
  /** The pty's `claude` is on `sessionId` now; Stoke held `previous`. */
  rebind(ptyId: string, sessionId: string, previous: string): void
  /** The reading for this pty changed. */
  state(state: LiveSessionState): void
  /**
   * A pass finished, changed or not — the phone's prompt identity re-confirms
   * a prompt from a reading taken after input (`trackPrompt`), which is not a
   * change `state` would report.
   */
  passed?(at: number): void
}

/**
 * This machine's pid -> parent pid table, for `pickEntry`'s folder fallback, or
 * null when it cannot be read in time. `ps` on macOS and Linux; on Windows (the
 * only layout the fallback exists for, and UNVERIFIED there) the CIM process
 * list. A generous `maxBuffer` (gotcha 13) and a deadline, because this runs in
 * main's poll.
 */
export function readProcessTable(platform: NodeJS.Platform = process.platform): Promise<Map<number, number> | null> {
  const [cmd, args] =
    platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
          ]
        ]
      : ['ps', ['-A', '-o', 'pid=,ppid=']]
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const table = parseProcessTable(String(stdout))
      resolve(table.size ? table : null)
    })
  })
}

function sameState(a: LiveSessionState | undefined, b: LiveSessionState): boolean {
  return (
    !!a &&
    a.sessionId === b.sessionId &&
    a.status === b.status &&
    a.waitingFor === b.waitingFor &&
    a.version === b.version
  )
}

export class RegistryPoller {
  private readonly dir: () => string
  private readonly fs: RegistryFs
  private readonly targets: () => RegistryTarget[]
  private readonly events: RegistryEvents
  private readonly last = new Map<string, LiveSessionState>()
  /**
   * Every pty whose own `<pid>.json` has been read at least once. Its file going
   * away later means the process is dying (SIGHUP removes it ~0.37s before the
   * exit), never "look elsewhere" — gotcha 92: a dying tab fell through to the
   * folder fallback and was rebound to a stranger's `claude` in the same repo.
   */
  private readonly everMatched = new Set<string>()
  private running = false

  // Explicit fields, not TS parameter properties: node's strip-only mode
  // rejects those, and the suite runs this file under it.
  constructor(
    dir: () => string,
    fs: RegistryFs,
    targets: () => RegistryTarget[],
    events: RegistryEvents
  ) {
    this.dir = dir
    this.fs = fs
    this.targets = targets
    this.events = events
  }

  /** Every live reading, for a renderer that has just (re)loaded. */
  states(): LiveSessionState[] {
    return [...this.last.values()]
  }

  private async read(file: string): Promise<RegistryEntry | null> {
    try {
      return parseRegistry(await this.fs.readFile(file))
    } catch {
      return null
    }
  }

  private async processTable(): Promise<ReadonlyMap<number, number> | null> {
    try {
      return (await this.fs.processTable?.()) ?? null
    } catch {
      return null
    }
  }

  /** Every entry in the directory, or null when it cannot be listed. */
  private async readAll(dir: string): Promise<RegistryEntry[] | null> {
    let names: string[]
    try {
      names = await this.fs.readdir(dir)
    } catch {
      return null
    }
    const files = names.filter((n) => /^\d+\.json$/.test(n))
    const read = await Promise.all(files.map((n) => this.read(join(dir, n))))
    return read.filter((e): e is RegistryEntry => e !== null)
  }

  /**
   * One pass. Returns without reading anything when there is no local Claude
   * pty — most of the time on most machines, which is why the poll costs
   * nothing when nothing is open.
   */
  async pass(now: number = Date.now()): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const targets = this.targets()
      const live = new Set(targets.map((t) => t.ptyId))
      for (const id of [...this.last.keys()]) if (!live.has(id)) this.last.delete(id)
      for (const id of [...this.everMatched]) if (!live.has(id)) this.everMatched.delete(id)
      if (!targets.length) return

      const dir = this.dir()
      const byPid = new Map<string, RegistryEntry | null>()
      await Promise.all(
        targets.map(async (t) => {
          byPid.set(t.ptyId, t.pid ? await this.read(join(dir, `${t.pid}.json`)) : null)
        })
      )

      /*
       * The directory is listed only for a pty old enough that its own file
       * should exist by now and does not — on this machine, never. It is the
       * fallback for a pty whose pid is not claude's (a Windows `.cmd` install
       * runs under cmd.exe), and listing it every second for a session that is
       * simply still starting would be work for nothing.
       */
      const pidMatched = (t: RegistryTarget): boolean => {
        const e = byPid.get(t.ptyId)
        return !!e && (e.pid === null || e.pid === t.pid)
      }
      for (const t of targets) if (pidMatched(t)) this.everMatched.add(t.ptyId)
      const fallsBack = (t: RegistryTarget): boolean =>
        !pidMatched(t) && !this.everMatched.has(t.ptyId) && now - t.startedAt >= REGISTRY_FALLBACK_AFTER_MS
      const needAll = targets.some(fallsBack)
      const all = needAll ? await this.readAll(dir) : null
      const parents = needAll && this.fs.processTable ? await this.processTable() : null

      // Sessions some target has provably by pid: a fallback may not take them.
      const claimed = new Set<string>()
      for (const t of targets) {
        const e = byPid.get(t.ptyId)
        if (pidMatched(t) && e?.sessionId) claimed.add(e.sessionId)
      }

      for (const t of targets) {
        const descends =
          parents && t.pid !== null ? (pid: number): boolean => descendsFrom(pid, t.pid as number, parents) : null
        const entry = pidMatched(t)
          ? (byPid.get(t.ptyId) ?? null)
          : fallsBack(t)
            ? pickEntry(t, null, all, claimed, descends)
            : null
        /*
         * No reading keeps the last one rather than clearing it. The file goes
         * away ~0.37s after a SIGHUP, i.e. while the process is dying — and the
         * pty's own exit is what ends the target, one tick later. A pty that
         * was ever matched by pid never falls back (`everMatched`), so that
         * second cannot rebind it to another process in the same folder.
         */
        if (!entry) continue
        const moved = rebindTo(t.sessionId, entry)
        if (moved) this.events.rebind(t.ptyId, moved, t.sessionId)
        const next: LiveSessionState = {
          ptyId: t.ptyId,
          sessionId: entry.sessionId,
          status: entry.status,
          busy: isBusyStatus(entry.status),
          waitingFor: entry.waitingFor,
          version: entry.version,
          statusUpdatedAt: entry.statusUpdatedAt,
          readAt: now
        }
        // Stored every pass (the stamps move), reported only on a real change.
        const changed = !sameState(this.last.get(t.ptyId), next)
        this.last.set(t.ptyId, next)
        if (changed) this.events.state(next)
      }
      this.events.passed?.(now)
    } finally {
      this.running = false
    }
  }
}
