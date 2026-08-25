import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState } from '@shared/types'
import {
  IconArrowLeft,
  IconArrowRight,
  IconAsk,
  IconClose,
  IconCode,
  IconExternal,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStar
} from './Icons'

interface Props {
  state: BrowserState
  bookmarks: string[]
  /** Hand the current page to the active Claude session. */
  onAskClaude: (url: string, title: string) => void
  onClose: () => void
}

/** Chromium zoom is logarithmic; this step is roughly 20% per press. */
const ZOOM_STEP = 0.5

/**
 * Chrome for the docked browser.
 *
 * The pages themselves are native WebContentsViews owned by the main process
 * and painted over `.browser-hole`, so this component's real job is to keep
 * that element's geometry reported upstream and to drive the controls.
 */
export function BrowserPanel({ state, bookmarks, onAskClaude, onClose }: Props): React.JSX.Element {
  const holeRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(state.url)
  const [editing, setEditing] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')

  // While the address bar is focused the user owns its text; otherwise it
  // tracks whatever the page navigated to.
  useEffect(() => {
    if (!editing) setDraft(state.url === 'about:blank' ? '' : state.url)
  }, [state.url, editing])

  useEffect(() => {
    if (findOpen) findRef.current?.focus()
  }, [findOpen])

  // Ctrl/Cmd+F from either side: the main process forwards it when the page
  // view has focus, and this handler covers the case where focus is in the
  // app's own chrome.
  useEffect(() => {
    const open = (): void => {
      setFindOpen(true)
      findRef.current?.focus()
      findRef.current?.select()
    }
    const off = window.stoke.browser.onFindRequested(open)

    const onKey = (e: KeyboardEvent): void => {
      const primary = window.stoke.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (primary && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        open()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  /*
   * The last rect actually sent to the main process, so a report that would
   * change nothing costs no IPC. The effect below runs on every render.
   */
  const sentRef = useRef<string>('')

  const report = useCallback((): void => {
    const hole = holeRef.current
    if (!hole) return
    const r = hole.getBoundingClientRect()
    const key = `${r.left},${r.top},${r.width},${r.height}`
    if (key === sentRef.current) return
    sentRef.current = key
    window.stoke.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
  }, [])

  /*
   * Every render, deliberately, and NOT only when the hole is resized.
   *
   * A native WebContentsView is positioned by the rect this sends; nothing else
   * tells it where to be. The old code reported on mount, on ResizeObserver and
   * on window resize — and a *position-only* move fires none of the three.
   * Opening the worklog panel is exactly that move: it is a sibling column to
   * the right of the browser, so the hole slides from x=1021 to x=681 with its
   * size unchanged (459x789 both before and after, measured). ResizeObserver
   * watches size only, the window does not resize, and the component does not
   * remount — so `setBounds` was never re-sent and the page stayed painted over
   * the whole 340px worklog column, which is the very thing gotcha 14's
   * sibling-column layout exists to prevent. It only healed on a window resize
   * or on closing and reopening the panel.
   *
   * A no-dep layout effect is the cheap general answer: this component is not
   * memoised, so it re-renders whenever anything moves it, and the guard above
   * means the common case is a `getBoundingClientRect` and a string compare.
   */
  useLayoutEffect(report)

  useLayoutEffect(() => {
    const hole = holeRef.current
    if (!hole) return
    const ro = new ResizeObserver(report)
    ro.observe(hole)
    // A window resize moves the panel without changing its size.
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [report])

  const closeFind = (): void => {
    setFindOpen(false)
    setFindText('')
    window.stoke.browser.stopFind()
  }

  return (
    <section className="browser" style={{ width: '100%' }} aria-label="Browser">
      {/*
        The tab strip is a whole row, so it only exists when there is more than
        one tab to put in it.
        
        Measured before: two stacked chrome rows came to about 190 CSS px above
        the page, in a panel that is often half the window wide -- and the
        common case is one tab, where the strip was a row of chrome showing a
        single item whose title the address bar underneath already implies.
        Opening a second tab brings it back.
      */}
      {state.tabs.length > 1 && (
      <div className="browser-tabs">
        <div className="btablist" role="tablist" aria-label="Browser tabs">
          {state.tabs.map((tab) => (
            <div
              key={tab.id}
              className="btab"
              role="tab"
              aria-selected={tab.id === state.activeId}
              tabIndex={0}
              title={tab.url || tab.title}
              onClick={() => window.stoke.browser.selectTab(tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  window.stoke.browser.selectTab(tab.id)
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) window.stoke.browser.closeTab(tab.id)
              }}
            >
              <span className="btab-label">{tab.loading ? 'Loading…' : tab.title || 'New tab'}</span>
              {/*
                Always offered, including on the last tab. Hiding it there left no
                way to close a single tab at all, which reads as the button being
                broken. Closing the last one dismisses the whole panel, since that
                is what closing the only tab means - the main process already
                handles an empty tab list, it just left an empty browser on screen.
              */}
              <button
                className="tab-close"
                title={state.tabs.length > 1 ? 'Close tab' : 'Close tab and hide the browser'}
                onClick={(e) => {
                  e.stopPropagation()
                  window.stoke.browser.closeTab(tab.id)
                  if (state.tabs.length <= 1) onClose()
                }}
              >
                <IconClose />
                <span className="sr-only">Close tab</span>
              </button>
            </div>
          ))}
        </div>

      </div>
      )}

      <div className="browser-bar">
        <button
          className="icon-btn"
          onClick={() => window.stoke.browser.back()}
          disabled={!state.canGoBack}
          title="Back"
        >
          <IconArrowLeft />
          <span className="sr-only">Back</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => window.stoke.browser.forward()}
          disabled={!state.canGoForward}
          title="Forward"
        >
          <IconArrowRight />
          <span className="sr-only">Forward</span>
        </button>
        <button
          className="icon-btn"
          onClick={() =>
            state.loading ? window.stoke.browser.stop() : window.stoke.browser.reload()
          }
          title={state.loading ? 'Stop' : 'Reload'}
        >
          {state.loading ? <IconClose /> : <IconRefresh />}
          <span className="sr-only">{state.loading ? 'Stop' : 'Reload'}</span>
        </button>

        <label className="sr-only" htmlFor="browser-url">
          Address
        </label>
        {/* Bookmarks ride along as native autocomplete rather than as a bar. */}
        <input
          id="browser-url"
          className="input browser-url"
          list="stoke-bookmarks"
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
              window.stoke.browser.navigate(draft)
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setEditing(false)
              e.currentTarget.blur()
            }
          }}
        />
        <datalist id="stoke-bookmarks">
          {bookmarks.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>

        {/*
          Grouped by what they act on, which is the ordering the old layout did
          not have: zoom sat on the TAB row while find and close sat here, so
          two controls that do the same kind of thing were a row apart.

          Page actions first, then the two that act on the panel itself. `.bar-group`
          shrinks before the address bar does.
        */}
        <div className="browser-actions">
        <button
          className="icon-btn"
          aria-pressed={state.bookmarked}
          onClick={() => window.stoke.browser.bookmark()}
          disabled={!state.url || state.url === 'about:blank'}
          title={state.bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
        >
          <IconStar />
          <span className="sr-only">{state.bookmarked ? 'Remove bookmark' : 'Bookmark'}</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => onAskClaude(state.url, state.title)}
          disabled={!state.url || state.url === 'about:blank'}
          title="Ask Claude about this page"
        >
          <IconAsk />
          <span className="sr-only">Ask Claude about this page</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => window.stoke.browser.zoom(state.zoom - ZOOM_STEP)}
          title="Zoom out"
        >
          <IconMinus />
          <span className="sr-only">Zoom out</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => window.stoke.browser.zoom(state.zoom + ZOOM_STEP)}
          title="Zoom in"
        >
          <IconPlus />
          <span className="sr-only">Zoom in</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => window.stoke.browser.devtools()}
          title="Toggle devtools"
        >
          <IconCode />
          <span className="sr-only">Toggle devtools</span>
        </button>
        <button
          className="icon-btn"
          aria-pressed={findOpen}
          onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
          title="Find on page"
        >
          <IconSearch />
          <span className="sr-only">Find on page</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => window.stoke.browser.openExternal()}
          title="Open in your default browser"
        >
          <IconExternal />
          <span className="sr-only">Open externally</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => window.stoke.browser.newTab()}
          title="New tab"
        >
          <IconPlus />
          <span className="sr-only">New tab</span>
        </button>
        <button className="icon-btn" onClick={onClose} title="Close browser panel">
          <IconClose />
          <span className="sr-only">Close browser panel</span>
        </button>
        </div>
      </div>

      {findOpen && (
        <div className="browser-find">
          <input
            ref={findRef}
            className="input"
            placeholder="Find on page"
            value={findText}
            spellCheck={false}
            onChange={(e) => {
              setFindText(e.target.value)
              window.stoke.browser.find(e.target.value, true, false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                window.stoke.browser.find(findText, !e.shiftKey, true)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
          />
          <span className="browser-find-count">
            {findText ? `${state.findActive}/${state.findTotal}` : ''}
          </span>
          <button
            className="icon-btn"
            onClick={() => window.stoke.browser.find(findText, false, true)}
            disabled={!findText}
            title="Previous match"
          >
            <IconArrowLeft />
            <span className="sr-only">Previous match</span>
          </button>
          <button
            className="icon-btn"
            onClick={() => window.stoke.browser.find(findText, true, true)}
            disabled={!findText}
            title="Next match"
          >
            <IconArrowRight />
            <span className="sr-only">Next match</span>
          </button>
          <button className="icon-btn" onClick={closeFind} title="Close find">
            <IconClose />
            <span className="sr-only">Close find</span>
          </button>
        </div>
      )}

      <div className="browser-hole" ref={holeRef} />
    </section>
  )
}
