import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState } from '@shared/types'
import { IconArrowLeft, IconArrowRight, IconClose, IconExternal, IconRefresh } from './Icons'

interface Props {
  state: BrowserState
  onClose: () => void
}

/**
 * Chrome for the docked browser.
 *
 * The page itself is a native WebContentsView owned by the main process and
 * painted over `.browser-hole`, so this component's real job is to keep that
 * element's geometry reported upstream.
 */
export function BrowserPanel({ state, onClose }: Props): React.JSX.Element {
  const holeRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState(state.url)
  const [editing, setEditing] = useState(false)

  // While the address bar is focused the user owns its text; otherwise it
  // tracks whatever the page navigated to.
  useEffect(() => {
    if (!editing) setDraft(state.url === 'about:blank' ? '' : state.url)
  }, [state.url, editing])

  useLayoutEffect(() => {
    const hole = holeRef.current
    if (!hole) return

    const report = (): void => {
      const r = hole.getBoundingClientRect()
      window.hearth.browser.setBounds({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height
      })
    }

    report()
    const ro = new ResizeObserver(report)
    ro.observe(hole)
    // A window resize moves the panel without changing its size.
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  return (
    <section className="browser" style={{ width: '100%' }} aria-label="Browser">
      <div className="browser-bar">
        <button
          className="icon-btn"
          onClick={() => window.hearth.browser.back()}
          disabled={!state.canGoBack}
          title="Back"
        >
          <IconArrowLeft />
          <span className="sr-only">Back</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => window.hearth.browser.forward()}
          disabled={!state.canGoForward}
          title="Forward"
        >
          <IconArrowRight />
          <span className="sr-only">Forward</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => (state.loading ? window.hearth.browser.stop() : window.hearth.browser.reload())}
          title={state.loading ? 'Stop' : 'Reload'}
        >
          {state.loading ? <IconClose /> : <IconRefresh />}
          <span className="sr-only">{state.loading ? 'Stop' : 'Reload'}</span>
        </button>

        <label className="sr-only" htmlFor="browser-url">
          Address
        </label>
        <input
          id="browser-url"
          className="input browser-url"
          value={draft}
          placeholder="Search or enter address"
          spellCheck={false}
          onFocus={(e) => {
            setEditing(true)
            e.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              window.hearth.browser.navigate(draft)
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setEditing(false)
              e.currentTarget.blur()
            }
          }}
        />

        <button
          className="icon-btn"
          onClick={() => window.hearth.browser.openExternal()}
          title="Open in your default browser"
        >
          <IconExternal />
          <span className="sr-only">Open externally</span>
        </button>
        <button className="icon-btn" onClick={onClose} title="Close browser">
          <IconClose />
          <span className="sr-only">Close browser</span>
        </button>
      </div>

      <div className="browser-hole" ref={holeRef} />
    </section>
  )
}
