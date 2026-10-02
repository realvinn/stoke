/**
 * Private chats on disk: the folder each one runs in, the marker that names
 * what it may have left behind, the cleanup once its `claude` has really
 * exited, the boot sweep after a crash, and the watchdog for a transcript the
 * CLI writes anyway. The rules are pure, in `shared/privateChat.ts`; this file
 * does the fs work around them.
 *
 * No electron import, explicit `.ts` imports and no parameter properties, so
 * `verify:private` runs the class itself under strip-types against fixture
 * folders (gotcha 74: every path it is handed is the suite's, never the real
 * `~/.claude` or userData). Every fs call is async and under a deadline (gotcha
 * 40): a slow disk delays a cleanup, never the main thread.
 *
 * WHAT IS NEVER DELETED. Only paths `privateCleanupTargets` builds by exact join
 * from a validated id, this chat's own slug and a config dir main named at
 * launch — never "whatever is in the folder". A folder under the private root
 * with no marker is left alone. An id the chat `/resume`d INTO (a conversation
 * saved before, `foreign`) is never added: deleting a real conversation's
 * file-history would be real damage. Gotcha 148.
 */
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  cleanupAllowed,
  ID_NAMED_DIRS,
  idFileMatches,
  isPrivateId,
  markerText,
  parseMarker,
  privateCleanupTargets,
  privateRebindVerdict,
  privateSlug,
  type PrivateMarker,
  type PrivateRebind
} from '../shared/privateChat.ts'

/** How long one fs step may take before it is given up (and left to the next sweep). */
const FS_DEADLINE_MS = 4000
/** How often the watchdog looks for a transcript. */
export const PRIVATE_WATCH_MS = 5000
/** Files `inspect` counts before it stops: "has files" needs one, the number is only shown. */
const INSPECT_MAX = 500

/** What the renderer is told about a private tab beyond its being private. */
export interface PrivateState {
  ptyId: string
  /** A transcript appeared under this chat's folder despite the env (version drift). */
  leak: boolean
  /** The tab `/resume`d into a conversation saved before: no longer private. */
  foreign: boolean
}

interface Entry {
  /** The launch id: the marker's and the folder's name. */
  id: string
  ptyId: string | null
  /** `<realRoot>/<id>`: the cwd the CLI was given, and so the one it records. */
  folder: string
  slug: string
  ids: string[]
  configDirs: string[]
  createdAt: number
  leak: boolean
  foreign: boolean
  /** Claimed before the first await of `finish`, so two exits cannot both clean (gotcha 20). */
  finishing: boolean
  /**
   * Ids the chat moved to whose transcript lookup could not answer: neither
   * deleted nor called saved until a later look does (`settle`). The watchdog
   * and the close each look again.
   */
  unsure: Set<string>
  /** Rebinds still looking their id up. `finish` waits for them, or an id they adopt would miss the cleanup. */
  pending: Set<Promise<unknown>>
}

/** What became of one cleanup target. Only `failed` keeps the marker for the next sweep. */
type Removal = 'removed' | 'absent' | 'refused' | 'failed'

export interface PrivateChatsOptions {
  /** `<userData>/private`. Made 0700 on first use. */
  root: string
  platform?: string
  /** `<tmp>/claude-<uid>` folders the CLI may have written per-cwd temp files under. */
  tmpRoots: () => string[]
  /**
   * Where a transcript for this id is, under any of these config dirs; null
   * ONLY when there is certainly none. Rejects when it cannot tell
   * (`findTranscriptStrict`): a rebind reads null as a `/clear` and deletes
   * the id's files, so "could not look" must never arrive as null.
   */
  findTranscript: (id: string, configDirs: readonly string[]) => Promise<string | null>
  /** Remove a status key's statusLine files (a crashed chat's; a live one's go with its pty). */
  clearStatusFiles: (id: string) => void
  /** The watchdog or a rebind changed what a tab should say. */
  onState: (state: PrivateState) => void
  deadlineMs?: number
}

export class PrivateChats {
  private readonly root: string
  private readonly platform: string
  private readonly tmpRoots: () => string[]
  private readonly findTranscript: (id: string, configDirs: readonly string[]) => Promise<string | null>
  private readonly clearStatusFiles: (id: string) => void
  private readonly onState: (state: PrivateState) => void
  private readonly deadlineMs: number
  private realRoot: string | null = null
  private readonly byId = new Map<string, Entry>()
  private readonly byPty = new Map<string, Entry>()
  private timer: NodeJS.Timeout | null = null
  private scanning = false

  constructor(opts: PrivateChatsOptions) {
    this.root = opts.root
    this.platform = opts.platform ?? process.platform
    this.tmpRoots = opts.tmpRoots
    this.findTranscript = opts.findTranscript
    this.clearStatusFiles = opts.clearStatusFiles
    this.onState = opts.onState
    this.deadlineMs = opts.deadlineMs ?? FS_DEADLINE_MS
  }

  /** The private root as given and through symlinks: every list hides both. */
  roots(): string[] {
    return this.realRoot && this.realRoot !== this.root ? [this.root, this.realRoot] : [this.root]
  }

  /** Every session id a live private chat has been on — what `tabs:save` and the lists refuse. */
  sessionIds(): Set<string> {
    const out = new Set<string>()
    for (const e of this.byId.values()) for (const id of e.ids) out.add(id)
    return out
  }

  isPrivatePty(ptyId: string): boolean {
    return this.byPty.has(ptyId)
  }

  state(ptyId: string): PrivateState | null {
    const e = this.byPty.get(ptyId)
    return e ? { ptyId, leak: e.leak, foreign: e.foreign } : null
  }

  states(): PrivateState[] {
    return [...this.byPty.values()].map((e) => ({ ptyId: e.ptyId as string, leak: e.leak, foreign: e.foreign }))
  }

  /** The root, made owner-only, through symlinks (gotcha 91: the CLI records the real path). */
  private async ensureRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const real = await this.within(realpath(this.root))
    this.realRoot = real
    return real
  }

  /**
   * A fresh private folder for a new chat, and its id. The marker is written
   * BEFORE the folder exists and removed only after everything else has gone,
   * so at any moment a crash leaves either nothing or a marker the next boot
   * sweep can act on.
   */
  async begin(configDirs: readonly string[], id: string = randomUUID()): Promise<{ id: string; folder: string }> {
    if (!isPrivateId(id)) throw new Error('A private chat needs a fresh id.')
    const realRoot = await this.ensureRoot()
    const folder = join(realRoot, id)
    const slug = privateSlug(folder)
    if (!slug) {
      throw new Error(
        `Stoke keeps its files at a path too long for Claude Code's folder names (${realRoot}), so it could not clean up after a private chat there.`
      )
    }
    const entry: Entry = {
      id,
      ptyId: null,
      folder,
      slug,
      ids: [id],
      configDirs: [...new Set(configDirs)],
      createdAt: Date.now(),
      leak: false,
      foreign: false,
      finishing: false,
      unsure: new Set(),
      pending: new Set()
    }
    // Claimed before the first await below, so a sweep running beside it skips it.
    this.byId.set(id, entry)
    try {
      await this.writeMarker(entry)
      // Not recursive: the folder must be new, never one that was already there.
      await this.within(mkdir(folder, { mode: 0o700 }))
    } catch (err) {
      this.byId.delete(id)
      await this.cleanup(entry).catch(() => {})
      throw err
    }
    return { id, folder }
  }

  /** The launch succeeded: this pty is that chat. */
  attach(id: string, ptyId: string): void {
    const e = this.byId.get(id)
    if (!e) return
    e.ptyId = ptyId
    this.byPty.set(ptyId, e)
    this.arm()
  }

  /** The launch failed after `begin`: nothing ran in the folder, so it all goes now. */
  async abandon(id: string): Promise<void> {
    const e = this.byId.get(id)
    if (!e) return
    this.byId.delete(id)
    await this.cleanup(e)
  }

  /**
   * The pty's `claude` is on another session id now (the registry, gotcha 80).
   * See `privateRebindVerdict`: a `/clear` successor joins what is deleted, a
   * conversation `/resume`d into is never touched and the tab is told.
   */
  async rebind(ptyId: string, newId: string): Promise<PrivateRebind | null> {
    const e = this.byPty.get(ptyId)
    if (!e) return null
    if (e.ids.includes(newId)) return 'same'
    // Registered before its first await, so a close arriving meanwhile waits
    // for it (gotcha 20): adopted after the cleanup had listed its targets, the
    // id's files would stay, and its marker write would land after the marker
    // was removed.
    const run = this.settle(e, newId)
    e.pending.add(run)
    try {
      return await run
    } finally {
      e.pending.delete(run)
    }
  }

  /**
   * Look `newId` up and act on the verdict. A lookup that cannot answer (an
   * unreadable folder, the deadline) is `unsure`: the id is kept aside and
   * looked at again, never adopted on a guess — adopting a conversation the
   * chat `/resume`d into would delete its checkpoints at close.
   */
  private async settle(e: Entry, newId: string): Promise<PrivateRebind> {
    let transcript: string | null | undefined = null
    if (isPrivateId(newId)) {
      try {
        transcript = await this.within(this.findTranscript(newId, e.configDirs))
      } catch {
        transcript = undefined
      }
    }
    const verdict = privateRebindVerdict({ newId, known: e.ids, transcript, slug: e.slug })
    if (verdict === 'unsure') {
      if (!e.unsure.has(newId)) console.warn('[stoke] could not tell whether a private chat moved to a saved conversation; looking again')
      e.unsure.add(newId)
      return verdict
    }
    e.unsure.delete(newId)
    if (verdict === 'adopt' && !e.ids.includes(newId)) {
      e.ids.push(newId)
      await this.writeMarker(e).catch((err) => console.error('[stoke] could not update a private chat marker', err))
    } else if (verdict === 'foreign' && !e.foreign) {
      e.foreign = true
      if (e.ptyId && !e.finishing) this.onState({ ptyId: e.ptyId, leak: e.leak, foreign: true })
    }
    return verdict
  }

  /**
   * How many files the chat's folder holds (regular files and links, at any
   * depth; empty folders are nothing to lose). Null when it could not be read
   * in time — the close then asks, since a delete cannot be undone.
   */
  async inspect(ptyId: string): Promise<{ files: number | null }> {
    const e = this.byPty.get(ptyId)
    if (!e) return { files: null }
    try {
      return { files: await this.within(countFiles(e.folder, INSPECT_MAX)) }
    } catch {
      return { files: null }
    }
  }

  /**
   * The chat's `claude` has REALLY exited (the pty's exit, not the kill that
   * asked for it: the CLI writes its exit stats and flushes after SIGHUP).
   * Everything it may have left goes, then the marker.
   */
  async finish(ptyId: string): Promise<number> {
    const e = this.byPty.get(ptyId)
    if (!e || e.finishing) return 0
    e.finishing = true
    this.byPty.delete(ptyId)
    this.byId.delete(e.id)
    if (!this.byPty.size) this.disarm()
    // A rebind still looking up a `/clear`'s id, and any id no look could
    // place yet: each is settled before the targets are listed.
    if (e.pending.size) await Promise.allSettled([...e.pending])
    for (const id of [...e.unsure]) await this.settle(e, id)
    return this.cleanup(e)
  }

  /**
   * After a crash, a force-kill or a quit that could not wait: every marker
   * under the root that no live chat holds is a chat whose files may still be
   * there. Its own marker is the only list it is cleaned from.
   */
  async sweepAtBoot(): Promise<number> {
    let names: string[]
    try {
      const realRoot = await this.ensureRoot()
      names = await this.within(readdir(realRoot))
    } catch {
      return 0
    }
    let swept = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!isPrivateId(id) || this.byId.has(id)) continue
      let marker: PrivateMarker | null = null
      try {
        marker = parseMarker(await this.within(readFile(join(this.realRoot as string, name), 'utf8')), id)
      } catch {
        marker = null
      }
      if (!marker) {
        console.warn(`[stoke] a private chat marker could not be read and was left alone: ${name}`)
        continue
      }
      const folder = join(this.realRoot as string, id)
      const slug = privateSlug(folder)
      if (!slug) continue
      for (const sid of marker.ids) this.clearStatusFiles(sid)
      await this.cleanup({
        id,
        ptyId: null,
        folder,
        slug,
        ids: marker.ids,
        configDirs: marker.configDirs,
        createdAt: marker.createdAt,
        leak: false,
        foreign: false,
        finishing: true,
        unsure: new Set(),
        pending: new Set()
      })
      swept += 1
    }
    return swept
  }

  /**
   * Quitting: the processes are being killed and their exits may never be
   * delivered, so only the FOLDERS go now, synchronously. The markers stay,
   * and the next boot's sweep removes the rest — the load-bearing half, as
   * tab restore's per-push write is for tabs (gotcha 35).
   */
  quitSync(): void {
    this.disarm()
    for (const e of this.byId.values()) {
      try {
        rmSync(e.folder, { recursive: true, force: true })
      } catch {
        /* left for the boot sweep */
      }
    }
  }

  /* ---------------------------------------------------------- watchdog */

  private arm(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.scan(), PRIVATE_WATCH_MS)
    this.timer.unref?.()
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Belt and braces: the env var is undocumented as a privacy switch, so if a
   * CLI release stops honouring it, the chat's transcript appears under its
   * own folder's slug. Found, the tab says so at once; the file goes at close
   * with everything else. Exported for the suite, which calls it directly.
   */
  async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      for (const e of [...this.byPty.values()]) {
        // An id an earlier look could not place: looked at again.
        for (const id of [...e.unsure]) if (!e.finishing) await this.settle(e, id)
        if (e.leak || !e.ptyId) continue
        if (await this.hasTranscript(e)) {
          e.leak = true
          this.onState({ ptyId: e.ptyId, leak: true, foreign: e.foreign })
        }
      }
    } finally {
      this.scanning = false
    }
  }

  private async hasTranscript(e: Entry): Promise<boolean> {
    for (const cfg of e.configDirs) {
      try {
        const names = await this.within(readdir(join(cfg, 'projects', e.slug)))
        if (names.some((n) => n.endsWith('.jsonl'))) return true
      } catch {
        /* no folder: nothing written */
      }
    }
    return false
  }

  /* ----------------------------------------------------------- cleanup */

  /**
   * Every target, each only once its parent resolves inside an allowed base.
   * Returns how many were removed. The marker goes last, and only when nothing
   * failed: a folder a process still holds (Windows refuses to remove one), a
   * permission, a tree too big for the deadline — each is left for the next
   * boot's sweep to try again, which it can only do while the marker names it.
   */
  private async cleanup(e: Entry): Promise<number> {
    const realRoot = this.realRoot ?? (await this.ensureRoot().catch(() => this.root))
    const tmpRoots = this.tmpRoots()
    const targets = privateCleanupTargets({
      ids: e.ids,
      folder: e.folder,
      privateRoot: realRoot,
      configDirs: e.configDirs,
      tmpRoots,
      join
    })
    let failed = 0
    for (const cfg of e.configDirs) {
      for (const dir of ID_NAMED_DIRS) {
        let names: string[] = []
        try {
          names = await this.within(readdir(join(cfg, dir)))
        } catch (err) {
          if (!isAbsence(err)) failed += 1
          continue
        }
        for (const n of idFileMatches(names, e.ids)) targets.push({ path: join(cfg, dir, n), within: cfg })
      }
    }
    const { bases, unread } = await this.realBases([realRoot, ...e.configDirs, ...tmpRoots])
    failed += unread
    let removed = 0
    for (const t of targets) {
      const r = await this.removeContained(t.path, bases)
      if (r === 'removed') removed += 1
      else if (r === 'failed') failed += 1
    }
    if (failed) {
      console.warn(`[stoke] ${failed} of a private chat's files could not be removed now; the next start tries again`)
      return removed
    }
    // Last: while the marker exists, a crash in the middle is finished by the next sweep.
    try {
      await this.within(rm(join(realRoot, `${e.id}.json`), { force: true }))
    } catch {
      /* the sweep retries it */
    }
    return removed
  }

  /** The bases' realpaths, and how many exist but could not be resolved (their targets wait for the next sweep). */
  private async realBases(paths: readonly string[]): Promise<{ bases: string[]; unread: number }> {
    const bases: string[] = []
    let unread = 0
    for (const p of new Set(paths)) {
      try {
        bases.push(await this.within(realpath(p)))
      } catch (err) {
        // A base that is not there holds nothing to remove.
        if (!isAbsence(err)) unread += 1
      }
    }
    return { bases, unread }
  }

  /** Remove `path` when it exists and its parent resolves inside one of `bases`. */
  private async removeContained(path: string, bases: readonly string[]): Promise<Removal> {
    try {
      await this.within(lstat(path))
    } catch (err) {
      return isAbsence(err) ? 'absent' : 'failed'
    }
    let parent: string
    try {
      parent = await this.within(realpath(dirname(path)))
    } catch (err) {
      return isAbsence(err) ? 'absent' : 'failed'
    }
    if (!cleanupAllowed(parent, bases, this.platform)) {
      console.warn(`[stoke] a private chat file outside Stoke's reach was left alone: ${path}`)
      return 'refused'
    }
    try {
      await this.within(rm(path, { recursive: true, force: true }))
      return 'removed'
    } catch (err) {
      console.error('[stoke] could not remove a private chat file', err)
      return 'failed'
    }
  }

  private async writeMarker(e: Entry): Promise<void> {
    const realRoot = this.realRoot ?? (await this.ensureRoot())
    const marker: PrivateMarker = {
      version: 1,
      id: e.id,
      ids: [...e.ids],
      configDirs: [...e.configDirs],
      createdAt: e.createdAt
    }
    await this.within(writeFile(join(realRoot, `${e.id}.json`), markerText(marker), { encoding: 'utf8', mode: 0o600 }))
  }

  /** One fs step under the deadline (gotcha 40). */
  private within<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), this.deadlineMs)
    })
    return Promise.race([p, late]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
}

/** The error a missing path gives: anything else (a permission, the deadline) means "could not tell". */
function isAbsence(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Where a transcript for `id` is under any of these config dirs; null only
 * when every `projects` folder was listed and none holds one. Rejects when it
 * cannot tell — a folder it could not list, a stat that failed for any reason
 * but absence — which `PrivateChats.settle` reads as `unsure`.
 * `findSessionFile` (projects.ts) answers null for both on purpose, for lists
 * that may be briefly wrong rather than late (gotcha 40); here null deletes.
 */
export async function findTranscriptStrict(id: string, configDirs: readonly string[]): Promise<string | null> {
  for (const cfg of new Set(configDirs)) {
    const root = join(cfg, 'projects')
    let names: string[]
    try {
      names = await readdir(root)
    } catch (err) {
      if (isAbsence(err)) continue
      throw err
    }
    const hits = await Promise.all(
      names.map(async (n) => {
        const file = join(root, n, `${id}.jsonl`)
        try {
          await lstat(file)
          return file
        } catch (err) {
          if (isAbsence(err)) return null
          throw err
        }
      })
    )
    const hit = hits.find((h) => h !== null)
    if (hit) return hit
  }
  return null
}

/** Regular files and links under `dir`, at any depth, up to `max`. */
async function countFiles(dir: string, max: number): Promise<number> {
  let count = 0
  const stack = [dir]
  while (stack.length && count < max) {
    const at = stack.pop() as string
    let entries
    try {
      entries = await readdir(at, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of entries) {
      if (d.isDirectory()) stack.push(join(at, d.name))
      else count += 1
      if (count >= max) break
    }
  }
  return count
}
