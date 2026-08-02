import type { WebContents } from 'electron'

/**
 * Short-lived Chrome DevTools Protocol sessions over the docked page.
 *
 * browser.ts long carried a comment asserting that the debugger slot had to be
 * left free because only one client may attach at a time, and every capability
 * here was written off on that basis. It is not true of Chromium, which
 * supports multiple protocol clients per target. Probing Electron 43 directly:
 * commands succeed while DevTools is open, and a fresh attach succeeds while it
 * is open. CDP is available unconditionally, which is what makes design,
 * performance and security analysis possible at all.
 *
 * Sessions are opened per operation rather than held open. An attached debugger
 * is not free — enabling domains such as Accessibility carries a stated cost
 * while active — and nothing here needs to observe events between calls.
 */

export type Send = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>
) => Promise<T>

/**
 * One queue per WebContents. Two tools running at once would otherwise race on
 * attach and detach, and the loser sees "Debugger is already attached" or has
 * the session pulled out from under it mid-command.
 */
const queues = new Map<number, Promise<unknown>>()

export async function withCdp<T>(wc: WebContents, fn: (send: Send) => Promise<T>): Promise<T> {
  const id = wc.id
  const prior = queues.get(id) ?? Promise.resolve()

  const run = prior.then(
    () => attachRunDetach(wc, fn),
    () => attachRunDetach(wc, fn)
  )

  // Keep the chain alive regardless of outcome so one failure cannot wedge the
  // queue for every later caller.
  queues.set(
    id,
    run.catch(() => undefined)
  )
  return run
}

async function attachRunDetach<T>(wc: WebContents, fn: (send: Send) => Promise<T>): Promise<T> {
  // Someone else may already hold a session — DevTools being open does not show
  // up here, but a nested call would.
  const borrowed = wc.debugger.isAttached()
  if (!borrowed) wc.debugger.attach('1.3')

  const send: Send = async (method, params) =>
    (await wc.debugger.sendCommand(method, params ?? {})) as never

  try {
    return await fn(send)
  } finally {
    if (!borrowed && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        // Detaching a session the page already tore down is not an error worth
        // surfacing; the navigation that killed it is the real event.
      }
    }
  }
}

/* --------------------------------------------------------------- snapshots */

/**
 * The computed properties a DOMSnapshot is asked for.
 *
 * This list is a whitelist and it matters: asking for everything balloons the
 * payload, and even at this size a content-heavy page returns a couple of
 * megabytes. Nothing derived from it is ever serialised toward the model — the
 * analysis runs here and only the digest travels.
 */
export const DESIGN_PROPS = [
  'display',
  'position',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-align',
  'color',
  'background-color',
  'background-image',
  'border-radius',
  'border-top-width',
  'border-top-color',
  'box-shadow',
  'opacity',
  'margin-top',
  'margin-bottom',
  'padding-top',
  'padding-left',
  'padding-bottom',
  'gap',
  'z-index',
  'grid-template-columns',
  'flex-direction',
  'max-width',
  'overflow-x',
  'width',
  'height'
] as const

export interface SnapshotDoc {
  documentURL: number
  title: number
  contentWidth?: number
  contentHeight?: number
  nodes: {
    parentIndex: number[]
    nodeType: number[]
    nodeName: number[]
    nodeValue: number[]
    backendNodeId: number[]
    attributes: number[][]
    isClickable?: { index: number[] }
  }
  layout: {
    nodeIndex: number[]
    styles: number[][]
    bounds: number[][]
    text: number[]
    paintOrders?: number[]
    blendedBackgroundColors?: number[]
    textColorOpacities?: number[]
    clientRects?: number[][]
  }
  textBoxes?: {
    layoutIndex: number[]
    bounds: number[][]
    start: number[]
    length: number[]
  }
}

export interface RawSnapshot {
  documents: SnapshotDoc[]
  strings: string[]
}

/** Capture computed styles and geometry for every laid-out node, in one call. */
export async function captureSnapshot(send: Send): Promise<RawSnapshot> {
  await send('DOMSnapshot.enable')
  try {
    return await send<RawSnapshot>('DOMSnapshot.captureSnapshot', {
      computedStyles: [...DESIGN_PROPS],
      includePaintOrder: true,
      includeDOMRects: true,
      // The blended colour is the one a reader actually sees, with ancestors
      // and gradients already composited. Recomputing that by hand is the usual
      // source of wrong contrast numbers.
      includeBlendedBackgroundColors: true,
      includeTextColorOpacities: true
    })
  } finally {
    await send('DOMSnapshot.disable').catch(() => undefined)
  }
}
