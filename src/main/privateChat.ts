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
}

export interface PrivateChatsOptions {
  /** `<userData>/private`. Made 0700 on first use. */
  root: string
  platform?: string
  /** `<tmp>/claude-<uid>` folders the CLI may have written per-cwd temp files under. */
  tmpRoots: () => string[]
  /** Where a transcript for this id is, under any of these config dirs, or null. */
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
      finishing: false
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
    const known = e.ids
    if (known.includes(newId)) return 'same'
    const transcript = isPrivateId(newId) ? await this.findTranscript(newId, e.configDirs).catch(() => null) : null
    const verdict = privateRebindVerdict({ newId, known, transcript, slug: e.slug })
    if (verdict === 'adopt' && !e.ids.includes(newId)) {
      e.ids.push(newId)
      await this.writeMarker(e).catch((err) => console.error('[stoke] could not update a private chat marker', err))
    } else if (verdict === 'foreign' && !e.foreign) {
      e.foreign = true
      this.onState({ ptyId, leak: e.leak, foreign: true })
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
        finishing: true
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

  /** Every target, each only once its parent resolves inside an allowed base. Returns how many were removed. */
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
    for (const cfg of e.configDirs) {
      for (const dir of ID_NAMED_DIRS) {
        let names: string[] = []
        try {
          names = await this.within(readdir(join(cfg, dir)))
        } catch {
          continue
        }
        for (const n of idFileMatches(names, e.ids)) targets.push({ path: join(cfg, dir, n), within: cfg })
      }
    }
    const bases = await this.realBases([realRoot, ...e.configDirs, ...tmpRoots])
    let removed = 0
    for (const t of targets) {
      if (await this.removeContained(t.path, bases)) removed += 1
    }
    // Last: while the marker exists, a crash in the middle is finished by the next sweep.
    try {
      await this.within(rm(join(realRoot, `${e.id}.json`), { force: true }))
    } catch {
      /* the sweep retries it */
    }
    return removed
  }

  private async realBases(paths: readonly string[]): Promise<string[]> {
    const out: string[] = []
    for (const p of new Set(paths)) {
      try {
        out.push(await this.within(realpath(p)))
      } catch {
        /* a base that is not there holds nothing to remove */
      }
    }
    return out
  }

  /** Remove `path` when it exists and its parent resolves inside one of `bases`. */
  private async removeContained(path: string, bases: readonly string[]): Promise<boolean> {
    try {
      await this.within(lstat(path))
    } catch {
      return false
    }
    let parent: string
    try {
      parent = await this.within(realpath(dirname(path)))
    } catch {
      return false
    }
    if (!cleanupAllowed(parent, bases, this.platform)) {
      console.warn(`[stoke] a private chat file outside Stoke's reach was left alone: ${path}`)
      return false
    }
    try {
      await this.within(rm(path, { recursive: true, force: true }))
      return true
    } catch (err) {
      console.error('[stoke] could not remove a private chat file', err)
      return false
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
