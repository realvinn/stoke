import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { flushSync } from 'react-dom'
import { autoscrollVelocity, clampDrag, nearestSlot, pastSlop, previewSlot } from './tabs'

/**
 * Chrome-style tab dragging for the session strip: the real tab follows the
 * pointer along the strip, its neighbours slide aside, and the order is
 * committed once, on release, with a FLIP settle.
 *
 * It replaced HTML5 drag-and-drop, which could not do any of that. The OS owned
 * the moving object — a translucent bitmap free to wander over the whole window
 * — so the app could only react to `dragover` hit tests, and every swap had to
 * be a committed reorder of App state that React then applied by teleporting
 * DOM nodes a whole slot. The costs that came with it went too: the tab id
 * leaked to the OS as `text/plain`, a drop was refused over the dragged tab
 * itself, and Escape kept every swap already made.
 *
 * The state machine is idle → pending (pressed, not yet past the slop) →
 * dragging → back to idle, with one detour: Escape mid-drag puts everything
 * back and parks the gesture as `spent` until the button comes up, so the rest
 * of that press can neither restart the drag nor reach the terminal.
 *
 * Imperative on purpose. The dragged tab moves every frame and its neighbours
 * whenever the target slot changes, and none of that goes through React state:
 * the transforms and the two `data-` attributes are written straight onto
 * nodes React renders but never names those properties on, so a re-render in
 * the middle of a drag — the context meter ticks about once a second — leaves
 * them alone. The only React state a drag ever touches is App's tab list, once.
 *
 * The maths is in `tabs.ts` and asserted by `verify:tabs`. What is here is the
 * wiring, which no suite can reach (gotcha 31): prove it over CDP.
 */

export interface TabDragOptions {
  listRef: RefObject<HTMLDivElement | null>
  /** The strip order as rendered. A change mid-drag cancels the drag. */
  ids: readonly string[]
  isMac: boolean
  onSelect: (id: string) => void
  /** The one commit: `dragId` takes `overId`'s index (`moveTab`). */
  onReorder: (dragId: string, overId: string) => void
}

export interface TabDrag {
  /** Bind to every tab's `onPointerDown`. */
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, id: string) => void
  /** True from a press until its release: a press is not a reason to scroll the strip. */
  busy: () => boolean
}

interface Pending {
  phase: 'pending'
  pointerId: number
  id: string
  startX: number
  startY: number
  /** Where in the tab the press landed, so the tab keeps that point under the pointer. */
  grab: number
}

interface Dragging {
  phase: 'dragging'
  pointerId: number
  id: string
  list: HTMLElement
  /** The strip at the moment the drag began; the order key it was measured under. */
  els: HTMLElement[]
  ids: string[]
  key: string
  /** Slot geometry in list-content coordinates, so scrolling the list moves none of it. */
  lefts: number[]
  centres: number[]
  width: number
  from: number
  to: number
  grab: number
  /** Latest pointer clientX; the frame loop reads it. */
  x: number
  raf: number
  last: number
  /** Sub-pixel autoscroll carried between frames. */
  carry: number
}

interface Spent {
  phase: 'spent'
  pointerId: number
  list: HTMLElement
}

type Gesture = Pending | Dragging | Spent

const keyOf = (ids: readonly string[]): string => ids.join('\n')

const tabEls = (list: HTMLElement): HTMLElement[] =>
  Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-tab-id]'))

/**
 * The settle's duration and easing, from the same tokens the CSS uses.
 *
 * WAAPI takes literal values and cannot resolve `var()`, so they are read off
 * `:root` at the moment of use rather than copied here, where they would drift.
 */
function motion(): { duration: number; easing: string } {
  const css = getComputedStyle(document.documentElement)
  const raw = css.getPropertyValue('--dur').trim()
  const n = parseFloat(raw)
  const duration = !Number.isFinite(n) ? 180 : raw.endsWith('ms') ? n : raw.endsWith('s') ? n * 1000 : n
  return { duration, easing: css.getPropertyValue('--ease').trim() || 'ease-out' }
}

function createTabDrag(get: () => TabDragOptions): TabDrag & {
  orderCommitted: (key: string) => void
  dispose: () => void
} {
  let g: Gesture | null = null
  /** Settle animations still running, finished before the next drag measures anything. */
  const running = new Set<Animation>()

  const listen = (): void => {
    // Capture phase on window, so nothing below can hide a move or a release.
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('keydown', onKey, true)
  }

  /** End the gesture outright: listeners off, capture released. Moves nothing. */
  const release = (): void => {
    const cur = g
    g = null
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)
    if (!cur || cur.phase === 'pending') return
    if (cur.phase === 'dragging') cancelAnimationFrame(cur.raf)
    cur.list.removeEventListener('lostpointercapture', onLost)
    if (cur.list.hasPointerCapture(cur.pointerId)) cur.list.releasePointerCapture(cur.pointerId)
  }

  /** Put a drag's DOM back to rest with no animation — the strip changed under it. */
  const abandon = (d: Dragging): void => {
    d.list.removeAttribute('data-reordering')
    for (const el of d.els) {
      el.style.transform = ''
      el.removeAttribute('data-dragging')
    }
    release()
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, id: string): void => {
    /*
     * Primary button only, and not a macOS Ctrl+click, which is the secondary
     * click arriving as button 0 (gotcha 28). Touch is left to the browser: a
     * finger on the strip means "scroll it", and the tab's own click selects on
     * a tap. The ✕ closes without selecting, exactly as Chrome's does.
     */
    if (e.button !== 0 || e.pointerType === 'touch') return
    if (get().isMac && e.ctrlKey) return
    if ((e.target as Element).closest('.tab-close')) return

    // Chrome selects on press, not on click, so the tab you drag is the one on screen.
    get().onSelect(id)

    /*
     * A new press means the previous one was released somewhere we never heard
     * about — pointerdown only fires when no button was already down. Finish it
     * as a release would, rather than refusing this press behind a stale one.
     */
    if (g) {
      if (g.phase === 'dragging') land(g, true)
      release()
    }

    const rect = e.currentTarget.getBoundingClientRect()
    g = {
      phase: 'pending',
      pointerId: e.pointerId,
      id,
      startX: e.clientX,
      startY: e.clientY,
      grab: e.clientX - rect.left
    }
    listen()
  }

  /**
   * The press has become a drag: snapshot the slots, capture the pointer, lift
   * the tab.
   */
  const begin = (p: Pending, x: number): void => {
    const list = get().listRef.current
    if (!list) return release()
    const els = tabEls(list)
    const ids = els.map((el) => el.dataset.tabId ?? '')
    const from = ids.indexOf(p.id)
    if (from < 0) return release()

    /*
     * Rects taken while the last drag's settle is still animating would put
     * every slot mid-flight, and nothing would ever correct it. Finish them
     * first, and drop any lift that has not come down yet.
     */
    for (const a of running) a.finish()
    for (const el of els) {
      el.style.transform = ''
      el.removeAttribute('data-dragging')
    }

    /*
     * Rects, not offsetLeft: an integer offset is a pixel off at Interface
     * scales like 0.8 and 1.1, and that pixel would show as a snap on release.
     * List-content coordinates, so autoscroll moves nothing measured here.
     */
    const box = list.getBoundingClientRect()
    const rects = els.map((el) => el.getBoundingClientRect())
    const lefts = rects.map((r) => r.left - box.left + list.scrollLeft)
    const centres = rects.map((r, i) => lefts[i] + r.width / 2)

    /*
     * Captured on the LIST, and only now. On pointerdown it would retarget the
     * click to the list and plain clicks would stop selecting; on the tab it
     * would be dropped the moment React moves that node. Capturing also keeps
     * every move of this press away from the terminal, and means the click
     * that follows the release never reaches a tab.
     */
    try {
      list.setPointerCapture(p.pointerId)
    } catch {
      return release() // the pointer is already gone
    }
    list.addEventListener('lostpointercapture', onLost)
    list.setAttribute('data-reordering', 'true')
    els[from].setAttribute('data-dragging', 'true')

    const d: Dragging = {
      phase: 'dragging',
      pointerId: p.pointerId,
      id: p.id,
      list,
      els,
      ids,
      key: keyOf(ids),
      lefts,
      centres,
      width: rects[from].width,
      from,
      to: from,
      grab: p.grab,
      x,
      raf: 0,
      last: performance.now(),
      carry: 0
    }
    g = d
    place(d)
    d.raf = requestAnimationFrame(frame)
  }

  /**
   * Move the dragged tab to the pointer and, if its slot changed, the neighbours
   * to theirs. Held inside the visible strip as well as its slots, so a tab
   * dragged to an edge to autoscroll stays in view while the strip scrolls
   * under it rather than following the pointer out past the clip.
   */
  const place = (d: Dragging): void => {
    const box = d.list.getBoundingClientRect()
    const scroll = d.list.scrollLeft
    const left = clampDrag(d.x - box.left + scroll - d.grab, d.lefts, {
      start: scroll,
      end: scroll + box.width,
      width: d.width
    })
    d.els[d.from].style.transform = `translateX(${left - d.lefts[d.from]}px)`
    const to = nearestSlot(d.centres, left + d.width / 2)
    if (to === d.to || to < 0) return
    d.to = to
    d.els.forEach((el, i) => {
      if (i === d.from) return
      const slot = previewSlot(i, d.from, to)
      // The CSS transition on `[data-reordering]` is what slides them.
      el.style.transform = slot === i ? '' : `translateX(${d.lefts[slot] - d.lefts[i]}px)`
    })
  }

  /** One frame of a drag: autoscroll if the pointer is at an edge, then place. */
  const frame = (now: number): void => {
    const d = g
    if (!d || d.phase !== 'dragging') return
    const box = d.list.getBoundingClientRect()
    const v = autoscrollVelocity(d.x, box.left, box.right)
    // Capped, so a stalled frame cannot fling the strip.
    const dt = Math.min(Math.max(now - d.last, 0), 64)
    d.last = now
    if (v === 0) {
      d.carry = 0
    } else {
      d.carry += (v * dt) / 1000
      const step = Math.trunc(d.carry)
      if (step !== 0) {
        d.list.scrollLeft += step
        d.carry -= step
      }
    }
    place(d)
    d.raf = requestAnimationFrame(frame)
  }

  /**
   * End a drag, committing the preview or putting it back, and settle.
   *
   * Leaves the gesture `spent` — the caller either releases it (a real
   * release) or keeps it until the button comes up (Escape).
   */
  const land = (d: Dragging, commit: boolean): void => {
    cancelAnimationFrame(d.raf)
    if (commit) place(d)
    // Where everything is ON SCREEN now, neighbours mid-slide included.
    const before = new Map(
      d.els.map((el, i): [string, number] => [d.ids[i], el.getBoundingClientRect().left])
    )
    const focus = document.activeElement
    // Before the commit below: its render must not read as the list changing under a drag.
    g = { phase: 'spent', pointerId: d.pointerId, list: d.list }
    if (commit && d.to !== d.from) {
      /*
       * Synchronously, so the DOM is in its new order by the time the settle
       * measures it. React 19 would batch this into the same commit anyway,
       * but from a native listener it lands in a microtask, and a settle that
       * ran first would animate every tab towards the OLD layout and then
       * watch the commit snap them.
       */
      const over = d.ids[d.to]
      flushSync(() => get().onReorder(d.id, over))
    }
    settle(d.list, before, d.id, focus)
  }

  /**
   * FLIP: every tab from where it was on screen to where layout now puts it.
   *
   * `data-reordering` comes off and the transforms are cleared in the same
   * style change, so the neighbours' CSS transition is gone before the cleared
   * transform could start one — a running one is cancelled, not reversed —
   * and the WAAPI animation takes over from the exact position the snapshot
   * recorded. The lifted tab stays lifted until it lands, or it would drop
   * under the neighbour it is still overlapping for the length of the settle.
   */
  const settle = (
    list: HTMLElement,
    before: Map<string, number>,
    liftedId: string,
    focus: Element | null
  ): void => {
    const els = tabEls(list)
    list.removeAttribute('data-reordering')
    for (const el of els) el.style.transform = ''
    const after = els.map((el) => el.getBoundingClientRect().left)
    const lifted = els.find((el) => el.dataset.tabId === liftedId) ?? null

    let landing: Animation | null = null
    // WAAPI ignores the global reduced-motion rule, which only shortens CSS.
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      try {
        const { duration, easing } = motion()
        for (let i = 0; i < els.length; i++) {
          const was = before.get(els[i].dataset.tabId ?? '')
          if (was === undefined) continue
          const dx = was - after[i]
          if (Math.abs(dx) < 0.5) continue
          const a = els[i].animate(
            [{ transform: `translateX(${dx}px)` }, { transform: 'none' }],
            { duration, easing }
          )
          running.add(a)
          const done = (): void => {
            running.delete(a)
          }
          a.finished.then(done, done)
          if (els[i] === lifted) landing = a
        }
      } catch {
        // An unparseable easing token: settle without the animation.
      }
    }

    const drop = (): void => {
      // Not if a new drag has already picked this same tab up again.
      if (g?.phase === 'dragging' && g.id === liftedId) return
      lifted?.removeAttribute('data-dragging')
    }
    if (landing) landing.finished.then(drop, drop)
    else drop()

    /*
     * React moves the node it reorders, and a moved node loses focus. The
     * terminal panes no longer follow the strip (`paneOrder`), so this only
     * matters for a tab that had keyboard focus when the drag began.
     */
    if (focus instanceof HTMLElement && focus.isConnected && document.activeElement !== focus) {
      focus.focus({ preventScroll: true })
    }
  }

  function onMove(e: PointerEvent): void {
    if (!g || e.pointerId !== g.pointerId) return
    /*
     * The buttons bitmask is the real "is the primary button down" — a
     * release the window never saw (let go outside it, or a drag the OS took)
     * shows up here first. Resizer's rule; commits what the drag showed.
     */
    if ((e.buttons & 1) === 0) {
      if (g.phase === 'dragging') land(g, true)
      release()
      return
    }
    if (g.phase === 'pending') {
      if (pastSlop(e.clientX - g.startX, e.clientY - g.startY)) begin(g, e.clientX)
    } else if (g.phase === 'dragging') {
      g.x = e.clientX
    }
  }

  function onUp(e: PointerEvent): void {
    if (!g || e.pointerId !== g.pointerId) return
    if (g.phase === 'dragging') {
      g.x = e.clientX
      land(g, true)
    }
    release()
  }

  /** The browser took the pointer away. Commit, as Resizer does — the user did drag it. */
  function onCancel(e: PointerEvent): void {
    if (!g || e.pointerId !== g.pointerId) return
    if (g.phase === 'dragging') land(g, true)
    release()
  }

  function onLost(e: PointerEvent): void {
    if (g?.phase !== 'dragging' || e.pointerId !== g.pointerId) return
    land(g, true)
    release()
  }

  /*
   * Escape puts the drag back — and has to be swallowed at the top of the
   * window's capture phase. Focus is almost always in the terminal's textarea
   * (a press on a tab no longer takes it), and an Escape that reached xterm
   * would interrupt whatever Claude is doing. Also swallowed while the button
   * is still held after a cancel, so an Escape held a moment too long cannot
   * auto-repeat into the session either.
   */
  function onKey(e: KeyboardEvent): void {
    if (!g || g.phase === 'pending' || e.key !== 'Escape') return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (g.phase === 'dragging') land(g, false)
  }

  return {
    onPointerDown,
    busy: () => g !== null,
    /**
     * The strip's order as committed. If it moved under a drag — a resume
     * replacing a tab's id, a close, a notification opening one — the drag is
     * measuring slots that no longer exist, so it is cancelled rather than
     * committed against stale indices.
     */
    orderCommitted: (key: string) => {
      if (g?.phase === 'dragging' && g.key !== key) abandon(g)
    },
    dispose: () => {
      if (g?.phase === 'dragging') abandon(g)
      else release()
      for (const a of running) a.cancel()
    }
  }
}

export function useTabDrag(opts: TabDragOptions): TabDrag {
  // Read through a ref by listeners that outlive a render (gotcha 31).
  const latest = useRef(opts)
  latest.current = opts
  const [drag] = useState(() => createTabDrag(() => latest.current))

  const key = keyOf(opts.ids)
  // Layout, not passive: it has to run before the new order paints.
  useLayoutEffect(() => drag.orderCommitted(key), [drag, key])
  useEffect(() => () => drag.dispose(), [drag])

  return drag
}
