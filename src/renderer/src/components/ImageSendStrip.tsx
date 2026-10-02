import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { ImagePrepared, ImageSent, ImageSource } from '@shared/api'
import type { SshHost } from '@shared/types'
import { dropText } from '@shared/drop'
import { MAX_IMAGE_BYTES, formatBytes, looksLikeImageFile } from '@shared/imageUpload'
import type { Tab } from '../types'
import { Spinner } from './Spinner'

/**
 * Images into an SSH tab, the renderer half: a paste or a drop becomes a job
 * that main checks and holds (`prepareImage`), sends over a second BatchMode
 * ssh (`sendImage`), and whose far path is then typed into the tab the way a
 * drop types a path (`dropText`, `term.paste`), so the `claude` over there
 * attaches it.
 *
 * Jobs run one at a time per tab, in the order they were made: each is chained
 * on the last SYNCHRONOUSLY in the key or drop handler, before anything is
 * awaited (gotchas 20, 51), so two quick pastes cannot type their paths out of
 * order or interleave. Nothing is typed on a failure; the strip says why, with
 * ssh's own words, and keeps the image for Try again.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading'; count: number }
  | { kind: 'sending'; count: number; bytes: number; thumb: string | null }
  | { kind: 'failed'; reason: string; message: string; detail: string; retry: (() => void) | null }
  | { kind: 'note'; message: string }

interface Held {
  uploadId: string
  bytes: number
  thumb: string | null
}

/** How long a sentence that needs no answer stays up. */
const NOTE_MS = 6000

/** Hosts this window has already told where images go, so the line is said once per run. */
const toldWhere = new Set<string>()

export interface SshImages {
  /** This tab sends images to its machine (a running host tab, uploads not turned off). */
  on: boolean
  pasteClipboard(): void
  /** Takes the drop when it holds at least one image; false leaves it to the caller. */
  dropFiles(files: File[]): boolean
  strip: React.JSX.Element | null
}

export function useSshImages({
  tab,
  host,
  termRef,
  onSetUpKey
}: {
  tab: Tab
  host: SshHost | null
  termRef: React.RefObject<Terminal | null>
  onSetUpKey?: (hostId: string) => void
}): SshImages {
  const on = !!tab.hostId && !tab.enrollHostId && tab.status === 'running' && !!host && host.noUploads !== true
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [queued, setQueued] = useState(0)
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  /** Every id main is holding for this tab, so Dismiss, a new job and unmount can let go of them. */
  const heldRef = useRef(new Set<string>())
  /** The id being sent right now, for Cancel. */
  const sendingRef = useRef<string | null>(null)
  /** Bumped by Cancel and by unmount: a job that sees it move stops at its next step. */
  const epochRef = useRef(0)
  /** A failed job is on screen, holding its images for Try again. */
  const failedRef = useRef(false)
  /** False once the pane is gone, so a job still queued never starts. */
  const aliveRef = useRef(true)
  const noteTimer = useRef<number | null>(null)
  const label = (host?.label.trim() || host?.alias.trim() || tab.projectName || 'the machine').trim()
  const labelRef = useRef(label)
  labelRef.current = label

  const clearNote = (): void => {
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
    noteTimer.current = null
  }
  const note = useCallback((message: string): void => {
    clearNote()
    setPhase({ kind: 'note', message })
    noteTimer.current = window.setTimeout(() => {
      noteTimer.current = null
      setPhase((p) => (p.kind === 'note' ? { kind: 'idle' } : p))
    }, NOTE_MS)
  }, [])

  const release = useCallback((ids: Iterable<string>): void => {
    for (const id of [...ids]) {
      heldRef.current.delete(id)
      void window.stoke.ssh.cancelImage(id)
    }
  }, [])

  // Leaving the tab (closed, or its process ended) lets go of everything held for it.
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      epochRef.current++
      clearNote()
      release(heldRef.current)
    }
  }, [release])
  useEffect(() => {
    if (tab.status === 'running') return
    epochRef.current++
    failedRef.current = false
    release(heldRef.current)
    setPhase({ kind: 'idle' })
  }, [tab.status, release])

  /**
   * Send what is held, from `from` on, then type every path at once — or stop
   * at the first failure with the rest still held for Try again.
   */
  const sendAll = useCallback(
    async (held: Held[], from: number, paths: string[], after: string[], epoch: number): Promise<void> => {
      const hostId = tab.hostId
      for (let i = from; i < held.length; i++) {
        if (epochRef.current !== epoch) return
        const item = held[i]
        const total = held.slice(i).reduce((n, h) => n + h.bytes, 0)
        setPhase({ kind: 'sending', count: held.length - i, bytes: total, thumb: item.thumb })
        sendingRef.current = item.uploadId
        let r: ImageSent
        try {
          r = await window.stoke.ssh.sendImage(item.uploadId)
        } catch (e) {
          r = { ok: false, reason: 'failed', message: 'The image was not sent.', detail: e instanceof Error ? e.message : String(e) }
        }
        sendingRef.current = null
        if (r.ok) {
          heldRef.current.delete(item.uploadId)
          paths.push(r.path)
          continue
        }
        if (r.reason === 'cancelled' || epochRef.current !== epoch) {
          release(held.slice(i).map((h) => h.uploadId))
          setPhase({ kind: 'idle' })
          return
        }
        if (r.reason === 'not-allowed') {
          release(held.slice(i).map((h) => h.uploadId))
          note(r.message)
          return
        }
        const retry = (): void => {
          if (!failedRef.current) return
          failedRef.current = false
          const again = ++epochRef.current
          chainRef.current = chainRef.current.then(() => sendAll(held, i, paths, after, again))
        }
        failedRef.current = true
        setPhase({ kind: 'failed', reason: r.reason, message: r.message, detail: r.detail, retry })
        return
      }
      if (epochRef.current !== epoch || !aliveRef.current) return
      /*
       * Every path at once, the way a drop types them: one paste (bracketed
       * when the far app asked for it), several in the form Claude Code
       * splits. 'linux' because the path is the far machine's (gotcha 18).
       */
      const term = termRef.current
      const text = dropText(paths, 'linux')
      if (term && text) {
        term.paste(text)
        term.focus()
      }
      const where = paths[0]?.slice(0, paths[0].lastIndexOf('/')) ?? ''
      const told = hostId ? toldWhere.has(hostId) : true
      if (hostId) toldWhere.add(hostId)
      const parts: string[] = []
      if (!told && where) parts.push(`Sent to ${labelRef.current}: ${where}, kept for a day.`)
      parts.push(...after)
      if (parts.length) note(parts.join(' '))
      else setPhase({ kind: 'idle' })
    },
    [note, release, tab.hostId, termRef]
  )

  /** One paste or one drop: prepare every source, then send them in order. */
  const run = useCallback(
    async (sources: (() => Promise<ImageSource | string>)[], leftOut: string[], epoch: number): Promise<void> => {
      const hostId = tab.hostId
      if (!hostId || !aliveRef.current || epochRef.current !== epoch) return
      clearNote()
      setPhase({ kind: 'reading', count: sources.length })
      const held: Held[] = []
      const refused: string[] = []
      for (const make of sources) {
        let source: ImageSource | string
        try {
          source = await make()
        } catch (e) {
          source = e instanceof Error ? e.message : String(e)
        }
        if (epochRef.current !== epoch) {
          release(held.map((h) => h.uploadId))
          return
        }
        if (typeof source === 'string') {
          refused.push(source)
          continue
        }
        let p: ImagePrepared
        try {
          p = await window.stoke.ssh.prepareImage(hostId, source)
        } catch (e) {
          p = { ok: false, reason: 'not-allowed', message: e instanceof Error ? e.message : String(e) }
        }
        if (p.ok) {
          heldRef.current.add(p.uploadId)
          held.push({ uploadId: p.uploadId, bytes: p.bytes, thumb: p.thumb })
        } else refused.push(p.message)
        if (epochRef.current !== epoch) {
          release(held.map((h) => h.uploadId))
          return
        }
      }
      // Files a drop carried that are not images: named, never typed (images only).
      const skipped = leftOut.length ? [`Only images are sent; left out: ${leftOut.join(', ')}.`] : []
      if (!held.length) {
        note([...refused, ...skipped].join(' ') || 'Nothing to send.')
        return
      }
      await sendAll(held, 0, [], [...refused, ...skipped], epoch)
    },
    [note, release, sendAll, tab.hostId]
  )

  /** Chain a job behind any running one, claimed before anything is awaited. */
  const enqueue = useCallback(
    (sources: (() => Promise<ImageSource | string>)[], leftOut: string[]): void => {
      // A new job answers a failure still on screen: what it held is let go.
      // (A failed job has already left the chain, so only its images are held.)
      if (failedRef.current) {
        failedRef.current = false
        release(heldRef.current)
        setPhase({ kind: 'idle' })
      }
      setQueued((n) => n + 1)
      const start = (): Promise<void> => {
        setQueued((n) => Math.max(0, n - 1))
        return run(sources, leftOut, epochRef.current)
      }
      chainRef.current = chainRef.current.then(start, start)
    },
    [release, run]
  )

  const pasteClipboard = useCallback((): void => {
    enqueue([async () => ({ kind: 'clipboard' })], [])
  }, [enqueue])

  const dropFiles = useCallback(
    (files: File[]): boolean => {
      const images = files.filter((f) => looksLikeImageFile(f.name, f.type))
      if (!images.length) return false
      const leftOut = files.filter((f) => !images.includes(f)).map((f) => f.name)
      enqueue(
        images.map((f) => async (): Promise<ImageSource | string> => {
          // Refused before reading, so a 2 GB "png" is never pulled into memory.
          if (f.size > MAX_IMAGE_BYTES) return `${f.name} is ${formatBytes(f.size)}; Stoke sends images up to ${formatBytes(MAX_IMAGE_BYTES)}.`
          return { kind: 'bytes', name: f.name, data: await f.arrayBuffer() }
        }),
        leftOut
      )
      return true
    },
    [enqueue]
  )

  /** Cancel a job in flight, or let go of a failed one: what main holds for it is dropped. */
  const cancel = (): void => {
    epochRef.current++
    failedRef.current = false
    const id = sendingRef.current
    if (id) void window.stoke.ssh.cancelImage(id)
    release(heldRef.current)
    clearNote()
    setPhase({ kind: 'idle' })
    termRef.current?.focus()
  }
  /** A sentence needs no answer: closing it touches no job. */
  const dismissNote = (): void => {
    clearNote()
    setPhase((p) => (p.kind === 'note' ? { kind: 'idle' } : p))
    termRef.current?.focus()
  }

  const strip = renderStrip(phase, queued, label, {
    cancel,
    dismissNote,
    setUpKey: tab.hostId && onSetUpKey ? () => onSetUpKey(tab.hostId as string) : null
  })
  return { on, pasteClipboard, dropFiles, strip }
}

function renderStrip(
  phase: Phase,
  queued: number,
  label: string,
  act: { cancel: () => void; dismissNote: () => void; setUpKey: (() => void) | null }
): React.JSX.Element | null {
  if (phase.kind === 'idle') return null
  const more = queued > 0 ? ` (${queued} more waiting)` : ''
  if (phase.kind === 'reading') {
    return (
      <div className="image-strip" role="status">
        <Spinner />
        <span className="image-strip-text">{phase.count > 1 ? `Reading ${phase.count} images…` : 'Reading the image…'}</span>
        <button className="btn" data-variant="ghost" onClick={act.cancel}>
          Cancel
        </button>
      </div>
    )
  }
  if (phase.kind === 'sending') {
    return (
      <div className="image-strip" role="status" aria-busy="true">
        {phase.thumb ? <img className="image-strip-thumb" src={phase.thumb} alt="" /> : <Spinner />}
        <span className="image-strip-text">
          {phase.count > 1 ? `Sending ${phase.count} images to ${label}…` : `Sending image to ${label}…`}{' '}
          <span className="image-strip-size">{formatBytes(phase.bytes)}</span>
          {more}
        </span>
        <button className="btn" data-variant="ghost" onClick={act.cancel}>
          Cancel
        </button>
      </div>
    )
  }
  if (phase.kind === 'note') {
    return (
      <div className="image-strip" role="status">
        <span className="image-strip-text">{phase.message}</span>
        <button className="btn" data-variant="ghost" onClick={act.dismissNote}>
          Dismiss
        </button>
      </div>
    )
  }
  return (
    <div className="image-strip" role="status" data-tone="error">
      <span className="image-strip-text">
        {phase.message}
        {phase.detail ? <span className="image-strip-detail mono">{phase.detail}</span> : null}
      </span>
      {phase.reason === 'needs-login' && act.setUpKey && (
        <button className="btn" data-variant="primary" onClick={act.setUpKey}>
          Set up key login
        </button>
      )}
      {phase.retry && (
        <button className="btn" data-variant={phase.reason === 'needs-login' ? undefined : 'primary'} onClick={phase.retry}>
          Try again
        </button>
      )}
      <button className="btn" data-variant="ghost" onClick={act.cancel}>
        Dismiss
      </button>
    </div>
  )
}
