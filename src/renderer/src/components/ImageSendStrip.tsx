import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { ImagePrepared } from '@shared/api'
import type { SshHost } from '@shared/types'
import { dropText } from '@shared/drop'
import { formatBytes } from '@shared/imageUpload'
import { ImageJobs, pathTakesFocus, type ImagePhase } from '@shared/imageJobs'
import type { Tab } from '../types'
import { Spinner } from './Spinner'

/**
 * Images into an SSH tab, the renderer half: a paste or a drop becomes a job
 * that main checks and holds (`prepareImage`), sends over a second BatchMode
 * ssh (`sendImage`), and whose far path is then typed into the tab the way a
 * drop types a path (`dropText`, `term.paste`), so the `claude` over there
 * attaches it.
 *
 * The order, the waiting and what main is told to let go are `ImageJobs`'
 * (shared/imageJobs.ts, held by verify:ssh): a paste reads the clipboard the
 * moment it is pressed, jobs send one at a time in the order they were made,
 * and a failure holds the queue until it is answered. This hook only wires it
 * to the IPC, the terminal and the strip. Nothing is typed on a failure; the
 * strip says why, with ssh's own words, and keeps the image for Try again.
 */

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
  const [phase, setPhase] = useState<ImagePhase>({ kind: 'idle' })
  const [waiting, setWaiting] = useState(0)
  const jobsRef = useRef<ImageJobs | null>(null)
  /** The strip's own element, whose buttons may hand the keyboard back to the terminal. */
  const stripRef = useRef<HTMLDivElement | null>(null)
  const noteTimer = useRef<number | null>(null)
  const label = (host?.label.trim() || host?.alias.trim() || tab.projectName || 'the machine').trim()
  const labelRef = useRef(label)
  labelRef.current = label
  const hostIdRef = useRef(tab.hostId)
  hostIdRef.current = tab.hostId

  const clearNote = (): void => {
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
    noteTimer.current = null
  }
  /** Every phase goes through here, so a note's timer never clears the phase after it. */
  const show = useCallback((p: ImagePhase): void => {
    clearNote()
    setPhase(p)
    if (p.kind !== 'note') return
    noteTimer.current = window.setTimeout(() => {
      noteTimer.current = null
      setPhase((cur) => (cur === p ? { kind: 'idle' } : cur))
    }, NOTE_MS)
  }, [])

  /*
   * One queue per mounted pane. Made in the effect, not in render, so React's
   * StrictMode remount (mount, unmount, mount) closes the first and makes a
   * second rather than leaving a closed one in the ref.
   */
  useEffect(() => {
    const jobs = new ImageJobs({
      prepare: (source) => {
        const hostId = hostIdRef.current
        if (!hostId) return Promise.resolve<ImagePrepared>({ ok: false, reason: 'not-allowed', message: 'This tab is not on a machine.' })
        return window.stoke.ssh.prepareImage(hostId, source)
      },
      send: (uploadId) => window.stoke.ssh.sendImage(uploadId),
      release: (uploadId) => void window.stoke.ssh.cancelImage(uploadId),
      phase: show,
      waiting: setWaiting,
      finished: (paths, notes) => {
        /*
         * Every path at once, the way a drop types them: one paste (bracketed
         * when the far app asked for it), several in the form Claude Code
         * splits. 'linux' because the path is the far machine's (gotcha 18).
         */
        const term = termRef.current
        const text = dropText(paths, 'linux')
        if (term && text) {
          term.paste(text)
          // Not out of the find bar (or any other field) the user went to
          // while the image was on its way (`pathTakesFocus`).
          if (pathTakesFocus(document.activeElement, document.body, [term.element, stripRef.current])) term.focus()
        }
        const hostId = hostIdRef.current
        const where = paths[0].slice(0, paths[0].lastIndexOf('/'))
        const told = hostId ? toldWhere.has(hostId) : true
        if (hostId) toldWhere.add(hostId)
        const parts = !told && where ? [`Sent to ${labelRef.current}: ${where}, kept for a day.`, ...notes] : notes
        show(parts.length ? { kind: 'note', message: parts.join(' ') } : { kind: 'idle' })
      }
    })
    jobsRef.current = jobs
    return () => {
      jobs.close()
      if (jobsRef.current === jobs) jobsRef.current = null
      clearNote()
    }
  }, [show, termRef])

  // A tab whose process ended drops everything held for it, waiting jobs too.
  useEffect(() => {
    if (tab.status !== 'running') jobsRef.current?.reset()
  }, [tab.status])

  const pasteClipboard = useCallback((): void => {
    jobsRef.current?.paste()
  }, [])

  const dropFiles = useCallback(
    (files: File[]): boolean =>
      jobsRef.current?.drop(files.map((f) => ({ name: f.name, type: f.type, size: f.size, read: () => f.arrayBuffer() }))) ?? false,
    []
  )

  /** Cancel a job in flight, or dismiss a failure: what main holds for it is let go. */
  const cancel = (): void => {
    jobsRef.current?.cancel()
    termRef.current?.focus()
  }
  const retry = (): void => jobsRef.current?.retry()
  /** A sentence needs no answer: closing it touches no job. */
  const dismissNote = (): void => {
    clearNote()
    setPhase((p) => (p.kind === 'note' ? { kind: 'idle' } : p))
    termRef.current?.focus()
  }

  const strip = renderStrip(phase, waiting, label, {
    ref: stripRef,
    cancel,
    retry,
    dismissNote,
    setUpKey: tab.hostId && onSetUpKey ? () => onSetUpKey(tab.hostId as string) : null
  })
  return { on, pasteClipboard, dropFiles, strip }
}

function renderStrip(
  phase: ImagePhase,
  waiting: number,
  label: string,
  act: { ref: React.Ref<HTMLDivElement>; cancel: () => void; retry: () => void; dismissNote: () => void; setUpKey: (() => void) | null }
): React.JSX.Element | null {
  if (phase.kind === 'idle') return null
  const more = waiting > 0 ? ` (${waiting} more waiting)` : ''
  const of = (p: { index: number; count: number }): string => (p.count > 1 ? ` ${p.index + 1} of ${p.count}` : '')
  if (phase.kind === 'reading') {
    return (
      <div className="image-strip" role="status" ref={act.ref}>
        <Spinner />
        <span className="image-strip-text">
          {`Reading image${of(phase)}…`}
          {more}
        </span>
        <button className="btn" data-variant="ghost" onClick={act.cancel}>
          Cancel
        </button>
      </div>
    )
  }
  if (phase.kind === 'sending') {
    return (
      <div className="image-strip" role="status" aria-busy="true" ref={act.ref}>
        {phase.thumb ? <img className="image-strip-thumb" src={phase.thumb} alt="" /> : <Spinner />}
        <span className="image-strip-text">
          {`Sending image${of(phase)} to ${label}…`} <span className="image-strip-size">{formatBytes(phase.bytes)}</span>
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
      <div className="image-strip" role="status" ref={act.ref}>
        <span className="image-strip-text">{phase.message}</span>
        <button className="btn" data-variant="ghost" onClick={act.dismissNote}>
          Dismiss
        </button>
      </div>
    )
  }
  return (
    <div className="image-strip" role="status" data-tone="error" ref={act.ref}>
      <span className="image-strip-text">
        {phase.message}
        {more}
        {phase.detail ? <span className="image-strip-detail mono">{phase.detail}</span> : null}
      </span>
      {phase.reason === 'needs-login' && act.setUpKey && (
        <button className="btn" data-variant="primary" onClick={act.setUpKey}>
          Set up key login
        </button>
      )}
      <button className="btn" data-variant={phase.reason === 'needs-login' ? undefined : 'primary'} onClick={act.retry}>
        Try again
      </button>
      <button className="btn" data-variant="ghost" onClick={act.cancel}>
        Dismiss
      </button>
    </div>
  )
}
