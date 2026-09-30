/**
 * Showing one Settings row: find it by its `data-setting` mark, open any
 * `<details>` it is folded inside, scroll it to the middle of the pane, flash
 * it, and — when the keyboard asked — put focus on its first control.
 *
 * DOM work, so it lives here rather than in shared/settingsIndex.ts, and runs
 * from an effect after the page it is on has rendered. A page does not always
 * draw its rows in its first commit (the Updates page waits for main's answer
 * before it draws anything), so the row is looked for on every frame for a
 * while; a row that is only drawn in some states (an API key field that exists
 * only in one auth mode) is given up on after `FALLBACK_AFTER_MS` in favour of
 * the row that decides it (`SettingRow.fallback`).
 */

/** How long a flash is on. Long enough to find with the eye after a scroll. */
export const FLASH_MS = 1600
/** How long to wait for the row itself before settling for its fallback. */
const FALLBACK_AFTER_MS = 250
/** How long to look at all. */
const GIVE_UP_MS = 1500

const FOCUSABLE_IN_ROW =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

function rowIn(pane: HTMLElement, id: string): HTMLElement | null {
  return pane.querySelector<HTMLElement>(`[data-setting="${CSS.escape(id)}"]`)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/*
 * One flash at a time across the sheet: a second jump before the first has
 * faded takes the mark off the first row rather than leaving two lit.
 */
let lit: { el: HTMLElement; timer: number } | null = null

function flash(el: HTMLElement): void {
  if (lit) {
    window.clearTimeout(lit.timer)
    lit.el.removeAttribute('data-flash')
  }
  el.removeAttribute('data-flash')
  // Restart the animation on a row flashed again: a style read between the
  // removal and the re-add makes them two states rather than one.
  void el.offsetWidth
  el.setAttribute('data-flash', '')
  const timer = window.setTimeout(() => {
    el.removeAttribute('data-flash')
    if (lit?.el === el) lit = null
  }, FLASH_MS)
  lit = { el, timer }
}

/**
 * Find `id` (or, after a moment, `fallback`) in `pane` and show it. Returns a
 * cleanup that stops looking, for an effect whose page changed underneath it.
 */
export function flashSettingRow(
  pane: HTMLElement,
  id: string,
  fallback: string | null,
  opts: { focus: boolean }
): () => void {
  const started = performance.now()
  let frame = 0
  let done = false
  const attempt = (): void => {
    if (done) return
    const waited = performance.now() - started
    const el = rowIn(pane, id) ?? (fallback && waited >= FALLBACK_AFTER_MS ? rowIn(pane, fallback) : null)
    if (!el) {
      if (waited < GIVE_UP_MS) frame = requestAnimationFrame(attempt)
      return
    }
    done = true
    // A row folded inside a closed disclosure (Phone access › Advanced) is
    // not on screen to scroll to until every <details> around it is open.
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
      if (!d.open) d.open = true
    }
    if (el.tagName === 'DETAILS' && !(el as HTMLDetailsElement).open) (el as HTMLDetailsElement).open = true
    el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    flash(el)
    if (opts.focus) {
      const control = el.matches(FOCUSABLE_IN_ROW) ? el : el.querySelector<HTMLElement>(FOCUSABLE_IN_ROW)
      // preventScroll: the scroll above is smooth, and focus() would jump it.
      ;(control ?? pane).focus({ preventScroll: true })
    }
  }
  frame = requestAnimationFrame(attempt)
  return () => {
    done = true
    cancelAnimationFrame(frame)
  }
}

/**
 * Mark every row of the page on show that the current query matches
 * (`data-hit`), and keep marking as the page draws more of itself. Returns the
 * cleanup that takes the marks off again.
 */
export function markSettingHits(pane: HTMLElement, rows: ReadonlySet<string>): () => void {
  const apply = (): void => {
    for (const el of pane.querySelectorAll<HTMLElement>('[data-setting]')) {
      const on = rows.has(el.dataset.setting ?? '')
      if (on && !el.hasAttribute('data-hit')) el.setAttribute('data-hit', '')
      else if (!on && el.hasAttribute('data-hit')) el.removeAttribute('data-hit')
    }
  }
  apply()
  if (rows.size === 0) return () => {}
  // Children only: marking is an attribute change, so it cannot retrigger this.
  const watch = new MutationObserver(apply)
  watch.observe(pane, { childList: true, subtree: true })
  return () => {
    watch.disconnect()
    for (const el of pane.querySelectorAll<HTMLElement>('[data-hit]')) el.removeAttribute('data-hit')
  }
}
