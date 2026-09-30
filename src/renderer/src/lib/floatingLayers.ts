import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react'
import { coversBrowser, type Rect } from '@shared/floating'

/*
 * Every floating layer the docked browser could paint over (gotcha 14).
 *
 * The full-screen overlays — palette, Settings, the agent picker, BusyDialog —
 * already hide the browser through App's `overlayOpen`. Anything smaller used
 * to need its own `open` prop threaded up to App, which is how the phone
 * popover got fixed on its own (1c93b7a) while the usage panel, the launcher's
 * chips and menus, the folder switcher, the project picker, every right-click
 * menu and the welcome splash all stayed behind the browser.
 *
 * Now a layer calls `useFloatingLayer(ref, open)` and App reads
 * `useBrowserCovered()`. The browser hides only while a registered layer
 * actually overlaps `.browser-hole` (`coversBrowser`), so a terminal menu on
 * the far side of the window leaves it alone. `verify:layers` fails on any
 * component that draws a popover, menu or dialog without registering.
 */

const layers = new Map<number, () => Element | null>()
const listeners = new Set<() => void>()
let seq = 0
let covered = false

function rectOf(el: Element | null): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/** Re-measure every open layer against the browser, and tell App if the answer moved. */
function recompute(): void {
  const rects: Rect[] = []
  for (const get of layers.values()) {
    const r = rectOf(get())
    if (r) rects.push(r)
  }
  const next = coversBrowser(rects, rectOf(document.querySelector('.browser-hole')))
  if (next === covered) return
  covered = next
  for (const l of listeners) l()
}

/*
 * A layer's rect can move after it registers: ContextMenu renders hidden for a
 * frame and nudges itself back on screen in an effect, a popover grows when its
 * content loads and slides into place as it enters, and the window can be
 * resized with a popover open. One more measurement on the next frame, one per
 * resize of the layer, one when its entrance ends (all in `useFloatingLayer`)
 * and one per window resize cover them without polling.
 */
if (typeof window !== 'undefined') window.addEventListener('resize', recompute)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Register `ref`'s element as floating while `open`. A layout effect, so the
 * layer is counted in the same commit that mounts it, before the frame paints.
 * Pass `true` for a component that is only mounted while open.
 */
export function useFloatingLayer(ref: RefObject<Element | null>, open: boolean): void {
  useLayoutEffect(() => {
    if (!open) return
    const id = ++seq
    layers.set(id, () => ref.current)
    recompute()
    const frame = requestAnimationFrame(recompute)
    // A layer can grow after it opens: the usage panel fills in its figures
    // once they load, and measured only at open it was still short of the
    // browser, so the view stayed over it.
    const el = ref.current
    const ro = el ? new ResizeObserver(recompute) : null
    if (el) ro?.observe(el)
    // And it can move without resizing: `.popover` enters with `pop`, 0.5rem
    // higher than it rests, so the phone panel measured clear of the browser
    // on the way in and came to rest over it. The end of the entrance is the
    // settled rect (under reduced motion it ends after 1ms — gotcha 72).
    el?.addEventListener('animationend', recompute)
    el?.addEventListener('transitionend', recompute)
    return () => {
      cancelAnimationFrame(frame)
      ro?.disconnect()
      el?.removeEventListener('animationend', recompute)
      el?.removeEventListener('transitionend', recompute)
      layers.delete(id)
      recompute()
    }
  }, [open, ref])
}

/** True while an open floating layer overlaps the docked browser. */
export function useBrowserCovered(): boolean {
  return useSyncExternalStore(subscribe, () => covered)
}
