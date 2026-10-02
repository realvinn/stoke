import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import type { FindConsent, TranscriptFindHit, TranscriptFindResult } from '@shared/transcriptFind'
import { isClaudeCode } from '@shared/codingClis'
import type { Tab } from '../types'
import { relativeTime, shortPath } from '../lib/format'
import {
  barKey,
  consentAfterSend,
  conversationCountLabel,
  roleLabel,
  screenCountLabel,
  typedInto
} from '../lib/terminalFind'
import type { FindColors } from '../lib/theme'
import { Highlight } from './Highlight'
import { IconArrowDown, IconArrowUp, IconClose, IconRefresh } from './Icons'

const IS_MAC = window.stoke.platform === 'darwin'

/** A query typed a letter at a time asks main once it settles, not once per letter. */
const DEBOUNCE_MS = 180
/** How long "Copied …" stays in the count line. */
const NOTE_MS = 2200

interface Props {
  tab: Tab
  term: Terminal
  search: SearchAddon
  colors: FindColors
  /** The selection when the bar opened, if it was one short line: the first query. */
  initialQuery: string
  /** Bumped by every open request (Cmd+F again, the menu, the palette): focus and select. */
  openSeq: number
  onClose: () => void
}

interface Options {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

interface Scopes {
  screen: boolean
  conversation: boolean
  tools: boolean
}

/**
 * Find in a conversation: one bar floating inside the terminal pane, two
 * engines behind one input.
 *
 * The SCREEN engine is xterm's own SearchAddon over the buffer — the screen and,
 * on a normal-buffer tab, its scrollback — highlighting in the canvas and
 * selecting the active match, so Cmd+C copies it. The CONVERSATION engine is
 * main's search of the tab's own Claude Code transcript (findInConversation.ts),
 * because a fullscreen Claude tab is on the alternate screen and keeps no
 * scrollback: "the code a bit back up" exists only there. Its hits are listed
 * newest first, with Copy match / Copy token / Copy message / Paste into prompt.
 *
 * It floats (absolute, inside `.term-pane`) rather than taking a row, so opening
 * it never resizes the terminal: a resize makes the pty SIGWINCH and Claude
 * repaint mid-session, the reason the dictation strip floats too.
 *
 * Decorations only while the bar has focus: with decorations on, the addon
 * re-runs the search 200 ms after every write and re-selects the active match,
 * which would replace a selection the user makes in the terminal behind it.
 */
export function TerminalFind({ tab, term, search, colors, initialQuery, openSeq, onClose }: Props): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [opts, setOpts] = useState<Options>({ caseSensitive: false, wholeWord: false, regex: false })
  const [scopes, setScopes] = useState<Scopes>({ screen: true, conversation: true, tools: true })
  const [screen, setScreen] = useState<{ count: number; index: number } | null>(null)
  const [screenError, setScreenError] = useState<string | null>(null)
  const [buffer, setBuffer] = useState<'normal' | 'alternate'>(term.buffer.active.type)
  const [tx, setTx] = useState<{ result: TranscriptFindResult | null; busy: boolean }>({ result: null, busy: false })
  const [selected, setSelected] = useState(-1)
  const [note, setNote] = useState<string | null>(null)
  /** "Not now" on an SSH host's question, for this bar's life. */
  const [declined, setDeclined] = useState(false)
  /** Bumped to send the conversation search again (an answer, a refresh). */
  const [askSeq, setAskSeq] = useState(0)
  /** The host's answer for this bar: sent with every search until the bar closes. */
  const consentRef = useRef<FindConsent | null>(null)
  const refreshRef = useRef(false)
  /** Numbers each conversation search, so a slow answer never lands on a newer query. */
  const reqRef = useRef(0)
  /** The tab as of the last render, read when a search is SENT (gotchas 26, 80: the id moves). */
  const tabRef = useRef(tab)
  tabRef.current = tab
  /** Whether the bar holds focus, so a blur can drop the highlights and a focus bring them back. */
  const focusedRef = useRef(true)

  const supported =
    !tab.enrollHostId && !(tab.installing?.length ?? 0) && (tab.hostId !== null || isClaudeCode(tab.cliId))
  const conversationOn = supported && scopes.conversation && !declined

  /* ---------------------------------------------------------------- screen */

  const runScreen = useCallback(
    (dir: 'incremental' | 'next' | 'prev'): void => {
      setScreenError(null)
      if (!scopes.screen || !query) {
        search.clearDecorations()
        setScreen(null)
        return
      }
      if (opts.regex) {
        try {
          new RegExp(query)
        } catch {
          search.clearDecorations()
          setScreen(null)
          setScreenError('Not a pattern JavaScript can read')
          return
        }
      }
      const o: ISearchOptions = {
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        regex: opts.regex,
        incremental: dir === 'incremental',
        decorations: colors
      }
      try {
        if (dir === 'prev') search.findPrevious(query, o)
        else search.findNext(query, o)
      } catch (err) {
        setScreenError((err as Error).message || 'The terminal search failed')
      }
      setBuffer(term.buffer.active.type)
    },
    [query, opts, scopes.screen, colors, search, term]
  )

  useEffect(() => {
    const d = search.onDidChangeResults((e) => setScreen({ count: e.resultCount, index: e.resultIndex }))
    return () => d.dispose()
  }, [search])

  useEffect(() => {
    const d = term.buffer.onBufferChange((b) => setBuffer(b.type))
    return () => d.dispose()
  }, [term])

  // Search as the query or an option changes, from where the last match was.
  useEffect(() => {
    if (focusedRef.current) runScreen('incremental')
  }, [runScreen])

  // Closing (or the pane going away) takes the highlights with it.
  useEffect(() => () => search.clearDecorations(), [search])

  /* ---------------------------------------------------------- conversation */

  useEffect(() => {
    const n = ++reqRef.current
    if (!conversationOn || !query) {
      setTx({ result: null, busy: false })
      return
    }
    setTx((t) => ({ result: t.result, busy: true }))
    const timer = window.setTimeout(() => {
      const t = tabRef.current
      const consent = consentRef.current
      consentRef.current = consentAfterSend(consent)
      const refresh = refreshRef.current
      refreshRef.current = false
      void window.stoke.transcript
        .find({
          sessionId: t.sessionId,
          hostId: t.hostId,
          query,
          caseSensitive: opts.caseSensitive,
          wholeWord: opts.wholeWord,
          regex: opts.regex,
          includeTools: scopes.tools,
          ...(consent ? { consent } : {}),
          ...(refresh ? { refresh: true } : {})
        })
        .catch((err: unknown): TranscriptFindResult => ({
          ok: false,
          reason: 'failed',
          message: err instanceof Error ? err.message : 'The search failed.'
        }))
        .then((result) => {
          if (n !== reqRef.current) return
          setTx({ result, busy: false })
          setSelected(-1)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // tab.sessionId: a --continue tab's id arrives later, and /clear moves it.
  }, [query, opts, scopes.tools, conversationOn, askSeq, tab.sessionId])

  /* ----------------------------------------------------------------- focus */

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [openSeq])

  useEffect(() => {
    if (!note) return
    const t = window.setTimeout(() => setNote(null), NOTE_MS)
    return () => window.clearTimeout(t)
  }, [note])

  useEffect(() => {
    if (selected < 0) return
    const el = listRef.current?.children[selected] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const close = (): void => {
    search.clearDecorations()
    onClose()
  }

  const onFocusIn = (): void => {
    if (focusedRef.current) return
    focusedRef.current = true
    runScreen('incremental')
  }

  const onFocusOut = (e: React.FocusEvent): void => {
    const next = e.relatedTarget as Node | null
    if (next && rootRef.current?.contains(next)) return
    focusedRef.current = false
    // Keep the count and the selection; drop the decorations, and with them the
    // addon's re-search after every write (see the component's comment).
    search.clearDecorations()
  }

  /* ----------------------------------------------------------- the actions */

  const hits = tx.result?.ok ? tx.result.hits : []

  const copy = (text: string, what: string): void => {
    window.stoke.clipboard.writeText(text)
    setNote(`Copied ${what}`)
  }

  const copyMessage = (hit: TranscriptFindHit): void => {
    if (!tx.result?.ok) return
    const m = tx.result.messages[hit.message]
    if (m) copy(m.text, m.cut ? 'the first 50,000 characters of the message' : 'the message')
  }

  const pasteToken = (hit: TranscriptFindHit): void => {
    // paste(), so bracketed paste applies exactly as for any paste. Typed into
    // the prompt, never sent: the user presses Enter.
    term.paste(hit.token)
    term.focus()
  }

  const answer = (consent: FindConsent | 'not-now'): void => {
    // The question's buttons go once it is answered, and focus would fall to
    // <body> with them: out of the bar, where Escape no longer closes it.
    inputRef.current?.focus()
    if (consent === 'not-now') {
      setDeclined(true)
      return
    }
    consentRef.current = consent
    setAskSeq((s) => s + 1)
  }

  const step = (dir: 'next' | 'prev'): void => runScreen(dir)

  /*
   * Every key pressed in the bar — the input, a toggle, a hit's button — is
   * decided here before it can reach App's window listener, which would hand a
   * plain key on a button to the terminal: the letters typed after clicking Aa,
   * and an Enter meant for Copy message that submitted Claude's prompt instead
   * (`barKey`). Escape closes and hands the keyboard back to the terminal.
   * React's stopPropagation stops the native event at the root, before window.
   */
  const onRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const what = barKey(e, e.target === inputRef.current)
    if (what === 'chord') return
    e.stopPropagation()
    if (what === 'close') {
      e.preventDefault()
      close()
    } else if (what === 'type') {
      e.preventDefault()
      const typed = e.key
      setQuery((q) => typedInto(q, typed))
      setSelected(-1)
      inputRef.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = selected >= 0 ? hits[selected] : undefined
      if (hit) copy(hit.matchText, `“${hit.matchText}”`)
      else step(e.shiftKey ? 'prev' : 'next')
      return
    }
    const findAgain = IS_MAC
      ? e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyG'
      : e.key === 'F3' && !e.ctrlKey && !e.metaKey && !e.altKey
    if (findAgain) {
      e.preventDefault()
      step(e.shiftKey ? 'prev' : 'next')
      return
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && hits.length > 0) {
      e.preventDefault()
      setSelected((i) =>
        e.key === 'ArrowDown' ? Math.min(hits.length - 1, i + 1) : Math.max(-1, i - 1)
      )
      return
    }
    // Alt+C / Alt+R / Alt+W toggle the options, by key position: on a Mac,
    // Alt+C types "ç", and that must not land in the query.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = e.code === 'KeyC' ? 'caseSensitive' : e.code === 'KeyR' ? 'regex' : e.code === 'KeyW' ? 'wholeWord' : null
      if (key) {
        e.preventDefault()
        setOpts((o) => ({ ...o, [key]: !o[key] }))
      }
    }
  }

  /* ------------------------------------------------------------ the words */

  const result = tx.result
  const screenLabel = scopes.screen && query ? (screenError ?? (screen ? screenCountLabel(screen.count, screen.index, buffer) : null)) : null
  const conversationLabel =
    supported && declined && query
      ? 'Conversation not searched'
      : conversationOn && query
        ? conversationCountLabel(result, tx.busy)
        : null
  /*
   * The owner's case, said plainly: a fullscreen Claude tab where the needle is
   * not on screen any more but IS in the conversation.
   */
  const notOnScreen =
    buffer === 'alternate' && screen?.count === 0 && !screenError && result?.ok === true && result.total > 0
  const countLine = note
    ? note
    : notOnScreen
      ? `Not on screen. ${result.total} in the conversation, newest first.`
      : [screenLabel, conversationLabel].filter(Boolean).join(' · ')
  const findAgainHint = IS_MAC ? '⌘G' : 'F3'

  const toggle = (key: keyof Options, label: string, text: string, chord: string): React.JSX.Element => (
    <button
      type="button"
      className="term-find-toggle"
      aria-pressed={opts[key]}
      title={`${label} (${IS_MAC ? '⌥' : 'Alt+'}${chord})`}
      onClick={() => setOpts((o) => ({ ...o, [key]: !o[key] }))}
    >
      {text}
      <span className="sr-only">{label}</span>
    </button>
  )

  const scope = (key: keyof Scopes, label: string, disabled = false): React.JSX.Element => {
    // After "Not now", the Conversation chip is the way to be asked again.
    const pressed = key === 'conversation' ? scopes.conversation && !declined : scopes[key]
    return (
      <button
        type="button"
        className="term-find-scope"
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => {
          if (key === 'conversation' && declined) {
            setDeclined(false)
            setScopes((s) => ({ ...s, conversation: true }))
          } else setScopes((s) => ({ ...s, [key]: !s[key] }))
        }}
      >
        {label}
      </button>
    )
  }

  return (
    <div
      ref={rootRef}
      className="term-find"
      role="search"
      aria-label="Find in this conversation"
      onFocus={onFocusIn}
      onBlur={onFocusOut}
      onKeyDown={onRootKeyDown}
    >
      <div className="term-find-row">
        <input
          ref={inputRef}
          className="input term-find-input"
          placeholder="Find in conversation"
          aria-label="Find in conversation"
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(-1)
          }}
          onKeyDown={onKeyDown}
        />
        {toggle('caseSensitive', 'Match case', 'Aa', 'C')}
        {toggle('wholeWord', 'Whole word', 'W', 'W')}
        {toggle('regex', 'Regular expression', '.*', 'R')}
        <button
          type="button"
          className="icon-btn"
          title={`Previous on screen (⇧Enter)`}
          disabled={!query || !scopes.screen}
          onClick={() => step('prev')}
        >
          <IconArrowUp />
          <span className="sr-only">Previous on screen</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          title={`Next on screen (Enter, ${findAgainHint})`}
          disabled={!query || !scopes.screen}
          onClick={() => step('next')}
        >
          <IconArrowDown />
          <span className="sr-only">Next on screen</span>
        </button>
        <button type="button" className="icon-btn" title="Close (Esc)" onClick={close}>
          <IconClose />
          <span className="sr-only">Close find</span>
        </button>
      </div>

      {(countLine || supported) && (
        <div className="term-find-meta">
          <span className="term-find-count" role="status" aria-live="polite">
            {countLine}
          </span>
          {supported && (
            <span className="term-find-scopes" role="group" aria-label="Search in">
              {scope('screen', 'Screen')}
              {scope('conversation', 'Conversation')}
              {scope('tools', 'Tool output', !scopes.conversation || declined)}
            </span>
          )}
        </div>
      )}

      {/* With no hit, the count line already says "None in the conversation". */}
      {conversationOn && query && result && !(result.ok && result.hits.length === 0) && (
        <div className="term-find-results">
          {!result.ok ? (
            result.reason === 'consent' ? (
              <div className="term-find-ask">
                <p>{result.message}</p>
                <div className="term-find-ask-actions">
                  <button type="button" className="btn" data-variant="primary" onClick={() => answer('always')}>
                    Allow for this host
                  </button>
                  <button type="button" className="btn" onClick={() => answer('once')}>
                    Just this once
                  </button>
                  <button type="button" className="btn" data-variant="ghost" onClick={() => answer('not-now')}>
                    Not now
                  </button>
                </div>
              </div>
            ) : (
              <p className="term-find-why">{result.message}</p>
            )
          ) : (
            <>
              <div className="term-find-source">
                {result.source.kind === 'ssh' ? (
                  <>
                    <span className="truncate" title={result.source.remotePath}>
                      From <span className="mono">{shortPath(result.source.remotePath, 44)}</span>, the newest Claude
                      conversation on {result.source.host} (its last {Math.round(result.source.tailBytes / 1_000_000)} MB)
                      {result.source.kept ? '' : ', not kept'}
                      {result.truncated ? ' · only the newest are listed' : ''}
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Copy it again"
                      onClick={() => {
                        refreshRef.current = true
                        setAskSeq((s) => s + 1)
                      }}
                    >
                      <IconRefresh />
                      <span className="sr-only">Copy the conversation again</span>
                    </button>
                  </>
                ) : (
                  <span className="truncate">
                    Newest first, from this conversation’s transcript
                    {result.source.partial ? ' (its last 64 MB)' : ''}
                    {result.truncated ? ' · only the newest are listed' : ''}
                  </span>
                )}
              </div>
              {result.hits.length > 0 && (
                <ol className="term-find-hits" ref={listRef}>
                  {result.hits.map((hit, i) => (
                    <li
                      key={`${hit.message}:${i}`}
                      className="term-find-hit"
                      data-selected={i === selected || undefined}
                      data-role={hit.role}
                    >
                      <div className="term-find-hit-head">
                        <span className="term-find-hit-who">{roleLabel(hit.role, hit.tool, hit.isError)}</span>
                        {hit.atMs !== null && <span className="term-find-hit-time">{relativeTime(hit.atMs)}</span>}
                        {hit.more > 0 && <span className="term-find-hit-more">+{hit.more} more in this message</span>}
                      </div>
                      <div className="term-find-hit-text">
                        {hit.cutBefore && '…'}
                        <Highlight text={hit.window} ranges={hit.ranges} />
                        {hit.cutAfter && '…'}
                      </div>
                      <div className="term-find-hit-actions">
                        <button type="button" className="btn" title={hit.matchText} onClick={() => copy(hit.matchText, `“${hit.matchText}”`)}>
                          Copy match
                        </button>
                        <button type="button" className="btn" title={hit.token} onClick={() => copy(hit.token, `“${hit.token}”`)}>
                          Copy token
                        </button>
                        <button type="button" className="btn" onClick={() => copyMessage(hit)}>
                          Copy message
                        </button>
                        <button
                          type="button"
                          className="btn"
                          title={`Types ${hit.token} into the prompt. Nothing is sent.`}
                          onClick={() => pasteToken(hit)}
                        >
                          Paste into prompt
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
