import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus } from '@shared/gitStatus'

/**
 * The git state of the folder the tab in front is in, for the title bar's git
 * chip (`git:status`, main/gitStatus.ts).
 *
 * Stale-while-revalidate: the last reading for a folder is kept here, so
 * switching back to a tab paints its branch at once and the fresh reading
 * replaces it a moment later. A reading older than `GIT_STALE_MS` is not shown
 * as known (`shownGitStatus`) — its changes read "…" until the fresh one lands —
 * so a chip never says "clean" about a tree it last looked at minutes ago.
 *
 * Read again when the folder changes, when the window comes back into focus,
 * when a turn ends (Claude may have committed or edited), every
 * `POLL_MS` while the document is visible, and on a click (`refresh`, which
 * skips main's shared cache). Every request carries its own claim object, and
 * only the newest claim may paint (gotcha 20's "whose claim"): a slow answer
 * for the tab you just left never lands under the one you are on.
 */
export const POLL_MS = 10_000

const cache = new Map<string, GitStatus>()

export function useGitStatus(
  cwd: string | null,
  opts: { enabled: boolean; busy: boolean }
): { status: GitStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<GitStatus | null>(() => (cwd ? (cache.get(cwd) ?? null) : null))
  const claim = useRef<object | null>(null)
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  const request = useCallback((fresh: boolean): void => {
    const path = cwdRef.current
    if (!path) return
    const mine = {}
    claim.current = mine
    window.stoke.git
      .status(path, fresh)
      .then((r) => {
        cache.set(path, r)
        if (claim.current === mine && cwdRef.current === path) setStatus(r)
      })
      .catch(() => {
        /* main answers every failure as a reading; a rejected invoke is a reload */
      })
  }, [])

  // A new folder: what we knew of it at once, then a fresh look.
  useEffect(() => {
    claim.current = null
    setStatus(cwd ? (cache.get(cwd) ?? null) : null)
    if (cwd && opts.enabled) request(false)
  }, [cwd, opts.enabled, request])

  // The poll, and the window coming back: only while the bar shows git.
  useEffect(() => {
    if (!cwd || !opts.enabled) return
    const tick = (): void => {
      if (document.visibilityState === 'visible') request(false)
    }
    const id = window.setInterval(tick, POLL_MS)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [cwd, opts.enabled, request])

  // A turn just ended: the agent may have written files or committed.
  const wasBusy = useRef(opts.busy)
  useEffect(() => {
    if (wasBusy.current && !opts.busy && opts.enabled) request(true)
    wasBusy.current = opts.busy
  }, [opts.busy, opts.enabled, request])

  const refresh = useCallback(() => request(true), [request])
  return { status: cwd ? status : null, refresh }
}
