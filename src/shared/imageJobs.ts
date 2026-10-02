/**
 * Images and files into an SSH tab: the queue one tab's pastes and drops go
 * through. `useSshImages` (ImageSendStrip.tsx) is its React half; this half
 * decides the order, the waiting and what is let go, and is pure (Promises and
 * callbacks only), so verify:ssh drives it with fakes (gotcha 78).
 *
 * Three rules, each a bug the first cut of the hook had (review, 2026-10-02):
 *
 * - **A paste reads the clipboard when it is pressed.** `paste()` and
 *   `pasteFiles()` ask main to read and hold at once, before anything is
 *   awaited; only the SENDING waits its turn. A paste queued behind a slow one
 *   used to read the clipboard when its turn came, so copy A, paste, copy B,
 *   paste, copy C sent A and C — or, with text copied by then, nothing at all.
 * - **A failure holds the queue until it is answered.** Try again resends the
 *   held one and the queue carries on; Dismiss (or a new paste, which answers
 *   it) lets the next job go. A job queued behind a failure used to start at
 *   once and draw over the failure, so its Try again was never on screen, the
 *   failed image was never typed and nothing said so.
 * - **Every upload main holds belongs to one job** (`Job.ids`), and the job
 *   lets all of them go when it ends, however it ends — sent, cancelled,
 *   dismissed, the tab gone — so Cancel on one job never drops a queued job's
 *   upload, and nothing is left held in main. A claim says whose it is (gotcha
 *   20's 2026-09-30 note): `Job.done`, never a shared counter.
 *
 * What each dropped file becomes (gotcha 152): an image of at most
 * `MAX_IMAGE_BYTES` is read here and sent as an image (named by its bytes, a
 * thumbnail on the strip), exactly as before files were sent; anything else —
 * any other file, an image too big for that, a `.png` whose bytes are not one
 * — goes by its PATH (`viaPath`), which main reads, and keeps its own name.
 *
 * Paths are typed only for a job whose uploads ALL arrived, in the order the
 * jobs were made: jobs run one at a time, chained in `enqueue` before any await.
 */
import type { ImagePrepared, ImageSent, ImageSource } from './api.ts'
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, looksLikeImageFile, tooLargeSentence } from './imageUpload.ts'

export type ImagePhase =
  | { kind: 'idle' }
  /** `name`: a file's own name, when what is being read is a file. */
  | { kind: 'reading'; index: number; count: number; name?: string }
  /** `file`: a file's own name; an image has none. `uploadId` ties the strip to main's progress. */
  | { kind: 'sending'; index: number; count: number; bytes: number; thumb: string | null; uploadId: string; file?: string }
  | { kind: 'failed'; reason: string; message: string; detail: string }
  | { kind: 'note'; message: string }

/** A dropped file, as much of it as the queue needs. `read` and `viaPath` are only called when its turn comes. */
export interface DroppedFile {
  name: string
  type: string
  size: number
  /** Its bytes, for the image route. */
  read(): Promise<ArrayBuffer>
  /**
   * Main checks and holds it by the path behind it (`ssh.prepareFile`), to send
   * as the file it is. Absent for a File with no path on this computer (a drag
   * out of a browser), which can then go only as an image.
   */
  viaPath?: () => Promise<ImagePrepared>
}

/** The name the image half was written with. */
export type DroppedImageFile = DroppedFile

export interface ImageJobDeps {
  /** Main checks, names and holds an image (`ssh.prepareImage`). */
  prepare(source: ImageSource): Promise<ImagePrepared>
  /** Main reads the files a file manager copied off the clipboard and holds each (`ssh.prepareClipboardFiles`). */
  prepareClipboardFiles(): Promise<ImagePrepared[]>
  /** Main sends a held upload (`ssh.sendImage`). */
  send(uploadId: string): Promise<ImageSent>
  /** Main lets a held upload go, stopping its send if one is in flight (`ssh.cancelImage`). */
  release(uploadId: string): void
  phase(p: ImagePhase): void
  /** How many jobs are waiting behind the one on screen. */
  waiting(n: number): void
  /**
   * A job ended with everything sent: type `paths` (in this order) and say
   * `notes` (what was refused). Called before the next job starts.
   */
  finished(paths: string[], notes: string[]): void
}

type Got = Extract<ImagePrepared, { ok: true }> | string

interface Item {
  /** A file's own name, for the strip while it is read; none for an image. */
  name?: string
  get: () => Promise<Got>
}

interface Job {
  items: Item[]
  /** Items known only once main answers (a paste of copied files). */
  expand: Promise<Item[]> | null
  /** Every id main holds for this job. Let go when the job ends. */
  ids: Set<string>
  started: boolean
  /** Ended: cancelled, dismissed, finished, or the tab gone. Nothing of it acts after this. */
  done: boolean
  /**
   * Settles when the job ends, so an await the job is parked on (main's
   * answer to a send it was told to stop) never holds the queue behind it.
   */
  ended: Promise<null>
  stop: () => void
}

type Answer = 'retry' | 'dismiss'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class ImageJobs {
  private readonly deps: ImageJobDeps
  private chain: Promise<void> = Promise.resolve()
  private readonly jobs = new Set<Job>()
  private current: Job | null = null
  /** The answer the failure on screen waits for; null when none is. */
  private answer: ((a: Answer) => void) | null = null
  private closed = false

  constructor(deps: ImageJobDeps) {
    this.deps = deps
  }

  /** The clipboard's image, read NOW (main reads and holds it), sent in turn. */
  paste(): void {
    if (this.closed) return
    const job = this.newJob()
    const held = this.hold(job, this.deps.prepare({ kind: 'clipboard' }))
    job.items.push({ get: () => held })
    this.enqueue(job)
  }

  /**
   * The files a file manager copied, read NOW (main reads the paths off the
   * clipboard and holds each), sent in turn, in the order they were copied.
   */
  pasteFiles(): void {
    if (this.closed) return
    const job = this.newJob()
    job.expand = this.deps.prepareClipboardFiles().then(
      (list) =>
        list.map((r) => {
          const got = this.keep(job, r)
          return { name: r.ok ? r.file : undefined, get: () => Promise.resolve(got) }
        }),
      (e) => [{ get: () => Promise.resolve<Got>(errText(e)) }]
    )
    this.enqueue(job)
  }

  /**
   * Everything in a drop, read and sent in turn: images as images, anything
   * else as the file it is. False only for an empty drop, which leaves it to
   * the caller. What cannot be sent (a folder, a device, a file past the cap)
   * is named in the closing note and never typed.
   */
  drop(files: DroppedFile[]): boolean {
    if (this.closed || !files.length) return false
    const job = this.newJob()
    for (const f of files) {
      const image = looksLikeImageFile(f.name, f.type)
      if (image && f.size <= MAX_IMAGE_BYTES) job.items.push({ get: () => this.asImage(job, f) })
      // Too big to send as an image, and no file behind it to send instead.
      else if (image && !f.viaPath) job.items.push({ get: async () => tooLargeSentence(f.name, f.size, MAX_IMAGE_BYTES, 'image') })
      else job.items.push({ name: f.name, get: () => this.asFile(job, f) })
    }
    this.enqueue(job)
    return true
  }

  /** A dropped image, read here and checked by main as before; a `.png` that is not one goes as a file. */
  private async asImage(job: Job, f: DroppedFile): Promise<Got> {
    let data: ArrayBuffer
    try {
      data = await f.read()
    } catch (e) {
      return `${f.name} could not be read (${errText(e)}).`
    }
    if (job.done) return ''
    let r: ImagePrepared
    try {
      r = await this.deps.prepare({ kind: 'bytes', name: f.name, data })
    } catch (e) {
      return errText(e)
    }
    // Named like an image, but its bytes are not one: it is still a file, and goes as one.
    if (!r.ok && r.reason === 'not-image' && f.viaPath && !job.done) return this.asFile(job, f)
    return this.keep(job, r)
  }

  /** A dropped file of any kind, by the path behind it, which main reads. */
  private asFile(job: Job, f: DroppedFile): Promise<Got> {
    // Refused before main is asked, so a 2 GB file is never opened.
    if (f.size > MAX_FILE_BYTES) return Promise.resolve(`${tooLargeSentence(f.name, f.size, MAX_FILE_BYTES, 'file')} Copy it with scp instead.`)
    if (!f.viaPath) return Promise.resolve(`${f.name} is not a file on this computer, so it cannot be sent.`)
    return this.hold(job, f.viaPath())
  }

  /** Try again, for the failure on screen. */
  retry(): void {
    this.answerWith('retry')
  }

  /**
   * Cancel the job on screen (its send is stopped, its uploads let go), or
   * dismiss its failure. Jobs waiting behind it then go on.
   */
  cancel(): void {
    const job = this.current
    if (job) this.end(job)
    this.answerWith('dismiss')
    this.deps.phase({ kind: 'idle' })
  }

  /** The tab stopped running: every job ends, waiting ones too. The queue stays usable. */
  reset(): void {
    for (const job of [...this.jobs]) this.end(job)
    this.answerWith('dismiss')
    this.deps.phase({ kind: 'idle' })
    this.emitWaiting()
  }

  /** The pane is gone: as `reset`, and nothing new is taken. */
  close(): void {
    this.closed = true
    for (const job of [...this.jobs]) this.end(job)
    this.answerWith('dismiss')
  }

  private newJob(): Job {
    let stop = (): void => {}
    const ended = new Promise<null>((resolve) => {
      stop = () => resolve(null)
    })
    return { items: [], expand: null, ids: new Set(), started: false, done: false, ended, stop }
  }

  /** What main held for `job`, recorded as the job's — or let go at once if the job already ended. */
  private keep(job: Job, r: ImagePrepared): Got {
    if (!r.ok) return r.message
    if (job.done || this.closed) {
      this.deps.release(r.uploadId)
      return ''
    }
    job.ids.add(r.uploadId)
    return r
  }

  private hold(job: Job, p: Promise<ImagePrepared>): Promise<Got> {
    return p.then(
      (r) => this.keep(job, r),
      (e) => errText(e)
    )
  }

  /** End a job: every upload main holds for it is let go. Idempotent. */
  private end(job: Job): void {
    job.done = true
    job.stop()
    for (const id of job.ids) this.deps.release(id)
    job.ids.clear()
    this.jobs.delete(job)
    if (this.current === job) this.current = null
  }

  private answerWith(a: Answer): void {
    const resolve = this.answer
    this.answer = null
    resolve?.(a)
  }

  private emitWaiting(): void {
    let n = 0
    for (const j of this.jobs) if (!j.started && !j.done) n++
    this.deps.waiting(n)
  }

  /** Chain `job` behind every earlier one — synchronously, so order is the order of the presses. */
  private enqueue(job: Job): void {
    // A new paste or drop answers a failure still on screen: that upload is let go.
    if (this.answer) {
      if (this.current) this.end(this.current)
      this.answerWith('dismiss')
    }
    this.jobs.add(job)
    this.emitWaiting()
    this.chain = this.chain.then(() => this.run(job)).catch(() => {})
  }

  private async run(job: Job): Promise<void> {
    job.started = true
    this.emitWaiting()
    if (job.done || this.closed) {
      this.end(job)
      return
    }
    this.current = job
    const live = (): boolean => !job.done && !this.closed
    const paths: string[] = []
    const notes: string[] = []
    try {
      if (job.expand) {
        // Main is reading what a file manager copied: say files, not "image".
        this.deps.phase({ kind: 'reading', index: 0, count: 1, name: 'copied files' })
        const more = await Promise.race([job.expand, job.ended])
        if (!live() || more === null) return
        job.items.push(...more)
      }
      const count = job.items.length
      for (let i = 0; i < count; i++) {
        const item = job.items[i]
        this.deps.phase({ kind: 'reading', index: i, count, name: item.name })
        const got = await Promise.race([item.get(), job.ended])
        if (!live() || got === null) return
        if (typeof got === 'string') {
          if (got) notes.push(got)
          continue
        }
        for (;;) {
          this.deps.phase({ kind: 'sending', index: i, count, bytes: got.bytes, thumb: got.thumb, uploadId: got.uploadId, file: got.file })
          let r: ImageSent | null
          try {
            r = await Promise.race([this.deps.send(got.uploadId), job.ended])
          } catch (e) {
            r = { ok: false, reason: 'failed', message: got.file ? `${got.file} was not sent.` : 'The image was not sent.', detail: errText(e) }
          }
          if (!live() || r === null) return
          if (r.ok) {
            // Main let it go itself once it landed.
            job.ids.delete(got.uploadId)
            paths.push(r.path)
            break
          }
          if (r.reason === 'cancelled') {
            this.deps.phase({ kind: 'idle' })
            return
          }
          // This one cannot be sent now (gone, or no longer a file); the rest still go.
          if (r.reason === 'not-file') {
            notes.push(r.message)
            break
          }
          if (r.reason === 'not-allowed') {
            this.deps.phase({ kind: 'note', message: [r.message, ...notes].join(' ') })
            return
          }
          // Nothing is typed; the queue waits here for Try again or Dismiss.
          this.deps.phase({ kind: 'failed', reason: r.reason, message: r.message, detail: r.detail })
          const a = await new Promise<Answer>((resolve) => {
            this.answer = resolve
          })
          if (a !== 'retry' || !live()) return
        }
      }
      if (!live()) return
      if (!paths.length) {
        this.deps.phase({ kind: 'note', message: notes.join(' ') || 'Nothing to send.' })
        return
      }
      this.deps.finished(paths, notes)
    } finally {
      this.end(job)
    }
  }
}

/**
 * Whether typing the far path also takes the keyboard to the terminal.
 *
 * Only when the keyboard is nowhere in particular (`<body>`, or nothing), or
 * already in the terminal or on the image strip's own buttons (`owners`: the
 * terminal's element and the strip's). Anywhere else it is somebody else's:
 * an upload takes seconds over a slow link, and the find bar is opened in that
 * time — the path was typed and `term.focus()` pulled the keyboard out of the
 * find input mid-query, so the rest of the query landed in Claude's prompt
 * after the path (found in review, 2026-10-02, the find bar and the image strip
 * merged into one pane). Same for a rename field or any other input.
 */
export function pathTakesFocus(
  active: unknown,
  body: unknown,
  owners: ReadonlyArray<{ contains(node: never): boolean } | null | undefined>
): boolean {
  if (!active || active === body) return true
  return owners.some((o) => !!o && o.contains(active as never))
}
