import { useEffect } from 'react'
import { WELCOME_DISMISS_MS, type WelcomeReason } from '@shared/welcome'

/*
 * The first-run campfire: one screen, once per install or upgrade, then never
 * again until the version moves. Whether it plays at all is `welcomePlan`'s
 * decision (shared/welcome.ts) and nothing here re-derives it.
 *
 * This module is loaded through `import()` from App, so it is a chunk of its
 * own and costs a launch that is not showing it exactly nothing — no parse, no
 * evaluate, no fetch. That is gotcha 40's lesson carried into the renderer:
 * "only used on some launches" is not the same as "only paid for on some
 * launches" unless the import is dynamic.
 *
 * Two art rules worth stating because breaking either is invisible.
 *
 * No colour is written here. Every fill, stroke and gradient stop is a class
 * that app.css resolves from the theme's own custom properties, so the fire is
 * the accent's colour on all twelve built-in themes and on a profile accent
 * too. A hex in this file would look right on Ember and only on Ember.
 *
 * Every moving part is INSIDE the one <svg>. A spark drawn as a positioned
 * <div> over the artwork agrees with it in `getBoundingClientRect` and paints
 * up to 0.707px off, because Blink snaps a painted box to whole pixels and
 * leaves SVG geometry where the arithmetic put it (gotcha 33).
 *
 * The geometry is `build/installerSidebar.svg`'s, byte for byte — the same
 * campfire the Windows installer draws, so the first thing the installer shows
 * and the first thing the app shows are one mark rather than two that drifted.
 * verify:welcome asserts the two `d` strings are identical; changing one means
 * `npm run art` and changing both.
 */

const FLAME_D =
  'M83 263C62 263 51 249 55 232C58 220 67 212 67 199C73 205 76 213 75 221C86 207 92 190 86 168C109 190 104 209 99 222C106 220 111 213 112 208C123 230 118 252 101 260C95 263 89 264 83 263Z'
const CORE_D =
  'M83 260C72 259 69 251 72 242C74 235 81 230 85 220C91 231 87 237 91 243C94 240 97 235 98 232C103 245 98 259 88 261Z'
const LOGS_D = 'M52 264L110 277M54 278L111 263'

/** Sparks: x, y and the delay that takes them out of lockstep. */
const SPARKS: ReadonlyArray<{ x: number; y: number; delay: string }> = [
  { x: 72, y: 214, delay: '0ms' },
  { x: 95, y: 222, delay: '420ms' },
  { x: 84, y: 200, delay: '840ms' },
  { x: 66, y: 230, delay: '1260ms' },
  { x: 101, y: 236, delay: '1680ms' }
]

export interface CampfireProps {
  /** Why it is playing. Decides the one line of copy, nothing else. */
  reason: WelcomeReason
  /** The build that is running, e.g. `0.9.4`. */
  version: string
  onDismiss: () => void
}

function headingFor(reason: WelcomeReason, version: string): { title: string; sub: string } {
  if (reason === 'install') {
    return {
      title: 'Welcome to Stoke',
      sub: 'One window for every project, session and the browser.'
    }
  }
  if (reason === 'downgrade') {
    return { title: `Stoke ${version}`, sub: 'Now running an earlier build.' }
  }
  return { title: `Stoke ${version}`, sub: 'Updated and ready.' }
}

export function Campfire({ reason, version, onDismiss }: CampfireProps): React.JSX.Element {
  /*
   * Three ways out, and the timer is the one that matters: a splash whose only
   * exit is a gesture is a splash that can be left on screen by someone who
   * walked away, in front of the session Stoke has just restored.
   *
   * Escape is bound on `window` rather than on the overlay because nothing here
   * takes focus — grabbing it would fight the terminal that is mounting behind
   * this at the same moment. `keydown` with `capture` so it runs before App's
   * own chord handler, which has no Escape case today but would be the natural
   * place for one.
   */
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, WELCOME_DISMISS_MS)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onDismiss()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onDismiss])

  const { title, sub } = headingFor(reason, version)

  return (
    /*
     * A div rather than a button, with an explicit role. The whole surface is
     * the dismiss target, and a <button> wrapping a heading is invalid markup
     * that screen readers flatten to one label.
     */
    <div
      className="campfire"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onDismiss}
    >
      <div className="campfire-card">
        <svg
          className="campfire-art"
          viewBox="40 156 88 136"
          role="img"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id="campfire-flame" x1="0" y1="0" x2="0" y2="1">
              <stop className="campfire-stop-hot" offset="0" />
              <stop className="campfire-stop-mid" offset="0.52" />
              <stop className="campfire-stop-deep" offset="1" />
            </linearGradient>
            <linearGradient id="campfire-core" x1="0" y1="0" x2="0" y2="1">
              <stop className="campfire-stop-core" offset="0" />
              <stop className="campfire-stop-mid" offset="1" />
            </linearGradient>
            <radialGradient id="campfire-halo" cx="0.5" cy="0.5" r="0.5">
              <stop className="campfire-stop-halo" offset="0" />
              <stop className="campfire-stop-halo-out" offset="1" />
            </radialGradient>
          </defs>

          <circle className="campfire-halo" cx="83" cy="252" r="66" fill="url(#campfire-halo)" />
          <path className="campfire-logs" d={LOGS_D} />
          <g className="campfire-body">
            <path className="campfire-flame" d={FLAME_D} fill="url(#campfire-flame)" />
            <path className="campfire-core" d={CORE_D} fill="url(#campfire-core)" />
          </g>
          {SPARKS.map((s) => (
            <circle
              key={`${s.x}-${s.y}`}
              className="campfire-spark"
              cx={s.x}
              cy={s.y}
              r="1.6"
              style={{ animationDelay: s.delay }}
            />
          ))}
        </svg>

        <h1 className="campfire-title">{title}</h1>
        <p className="campfire-sub">{sub}</p>
        <p className="campfire-hint">Click anywhere, or press Escape.</p>
      </div>
    </div>
  )
}
