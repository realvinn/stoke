/**
 * Images into an SSH tab: the queue one tab's pastes and drops go through.
 * `useSshImages` (ImageSendStrip.tsx) is its React half; this half decides
 * the order, the waiting and what is let go, and is pure (Promises and
 * callbacks only), so verify:ssh drives it with fakes (gotcha 78).
 *
 * Three rules, each a bug the first cut of the hook had (review, 2026-10-02):
 *
 * - **A paste reads the clipboard when it is pressed.** `paste()` asks main to
 *   read and hold the image at once, before anything is awaited; only the
 *   SENDING waits its turn. A paste queued behind a slow one used to read the
 *   clipboard when its turn came, so copy A, paste, copy B, paste, copy C sent
 *   A and C — or, with text copied by then, nothing at all.
 * - **A failure holds the queue until it is answered.** Try again resends the
 *   held image and the queue carries on; Dismiss (or a new paste, which answers
 *   it) lets the next job go. A job queued behind a failure used to start at
 *   once and draw over the failure, so its Try again was never on screen, the
 *   failed image was never typed and nothing said so.
 * - **Every image main holds belongs to one job** (`Job.ids`), and the job lets
 *   all of them go when it ends, however it ends — sent, cancelled, dismissed,
 *   the tab gone — so Cancel on one job never drops a queued job's image, and
 *   nothing is left held in main. A claim says whose it is (gotcha 20's
 *   2026-09-30 note): `Job.done`, never a shared counter.
 *
 * Paths are typed only for a job whose images ALL arrived, in the order the
 * jobs were made: jobs run one at a time, chained in `enqueue` before any await.
 */
import type { ImagePrepared, ImageSent, ImageSource } from './api.ts'
import { MAX_IMAGE_BYTES, formatBytes, looksLikeImageFile } from './imageUpload.ts'

export type ImagePhase =
  | { kind: 'idle' }
  | { kind: 'reading'; index: number; count: number }
  | { kind: 'sending'; index: number; count: number; bytes: number; thumb: string | null }
  | { kind: 'failed'; reason: string; message: string; detail: string }
  | { kind: 'note'; message: string }

/** A dropped file, as much of it as the queue needs. `read` is only called when its turn comes. */
export interface DroppedImageFile {
  name: string
  type: string
  size: number
  read(): Promise<ArrayBuffer>
}

export interface ImageJobDeps {
  /** Main checks, names and holds an image (`ssh.prepareImage`). */
  prepare(source: ImageSource): Promise<ImagePrepared>
  /** Main sends a held image (`ssh.sendImage`). */
  send(uploadId: string): Promise<ImageSent>
  /** Main lets a held image go, stopping its send if one is in flight (`ssh.cancelImage`). */
  release(uploadId: string): void
  phase(p: ImagePhase): void
  /** How many jobs are waiting behind the one on screen. */
  waiting(n: number): void
  /**
   * A job ended with every image sent: type `paths` (in this order) and say
   * `notes` (what was left out or refused). Called before the next job starts.
   */
  finished(paths: string[], notes: string[]): void
}

type Got = Extract<ImagePrepared, { ok: true }> | string

interface Job {
  items: (() => Promise<Got>)[]
  leftOut: string[]
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

  /** The clipboard, read NOW (main reads and holds it), sent in turn. */
  paste(): void {
    if (this.closed) return
    const job = this.newJob([])
    const held = this.hold(job, this.deps.prepare({ kind: 'clipboard' }))
    job.items.push(() => held)
    this.enqueue(job)
  }

  /**
   * The images in a drop, read and sent in turn. False when it holds no image,
   * which leaves the drop to the caller (a path typed, as before). Anything
   * that is not an image is named in the closing note and never typed.
   */
  drop(files: DroppedImageFile[]): boolean {
    if (this.closed) return false
    const images = files.filter((f) => looksLikeImageFile(f.name, f.type))
    if (!images.length) return false
    const job = this.newJob(files.filter((f) => !images.includes(f)).map((f) => f.name))
    for (const f of images) {
      job.items.push(async () => {
        // Refused before reading, so a 2 GB "png" is never pulled into memory.
        if (f.size > MAX_IMAGE_BYTES) return `${f.name} is ${formatBytes(f.size)}; Stoke sends images up to ${formatBytes(MAX_IMAGE_BYTES)}.`
        let data: ArrayBuffer
        try {
          data = await f.read()
        } catch (e) {
          return `${f.name} could not be read (${errText(e)}).`
        }
        if (job.done) return ''
        return this.hold(job, this.deps.prepare({ kind: 'bytes', name: f.name, data }))
      })
    }
    this.enqueue(job)
    return true
  }

  /** Try again, for the failure on screen. */
  retry(): void {
    this.answerWith('retry')
  }

  /**
   * Cancel the job on screen (its send is stopped, its images let go), or
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

  private newJob(leftOut: string[]): Job {
    let stop = (): void => {}
    const ended = new Promise<null>((resolve) => {
      stop = () => resolve(null)
    })
    return { items: [], leftOut, ids: new Set(), started: false, done: false, ended, stop }
  }

  /** What main held for `job`, recorded as the job's — or let go at once if the job already ended. */
  private hold(job: Job, p: Promise<ImagePrepared>): Promise<Got> {
    return p.then(
      (r) => {
        if (!r.ok) return r.message
        if (job.done || this.closed) {
          this.deps.release(r.uploadId)
          return ''
        }
        job.ids.add(r.uploadId)
        return r
      },
      (e) => errText(e)
    )
  }

  /** End a job: every image main holds for it is let go. Idempotent. */
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
    // A new paste or drop answers a failure still on screen: that image is let go.
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
    const count = job.items.length
    const paths: string[] = []
    const notes: string[] = []
    try {
      for (let i = 0; i < count; i++) {
        this.deps.phase({ kind: 'reading', index: i, count })
        const got = await Promise.race([job.items[i](), job.ended])
        if (!live() || got === null) return
        if (typeof got === 'string') {
          if (got) notes.push(got)
          continue
        }
        for (;;) {
          this.deps.phase({ kind: 'sending', index: i, count, bytes: got.bytes, thumb: got.thumb })
          let r: ImageSent | null
          try {
            r = await Promise.race([this.deps.send(got.uploadId), job.ended])
          } catch (e) {
            r = { ok: false, reason: 'failed', message: 'The image was not sent.', detail: errText(e) }
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
      const skipped = job.leftOut.length ? [`Only images are sent; left out: ${job.leftOut.join(', ')}.`] : []
      if (!paths.length) {
        this.deps.phase({ kind: 'note', message: [...notes, ...skipped].join(' ') || 'Nothing to send.' })
        return
      }
      this.deps.finished(paths, [...notes, ...skipped])
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
