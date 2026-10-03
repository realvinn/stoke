import { useEffect, useMemo, useRef, useState } from 'react'
import {
  chatAssistantName,
  chatOriginBadge,
  chatOriginLabel,
  highlightRanges,
  isChatImportKind,
  isChatOrigin,
  type ChatSearchHit,
  type ChatTranscriptMessage
} from '@shared/chatIndex'
import type { RemoteChatHit } from '@shared/hub/remote'
import { remoteChatWhere } from '@shared/remoteChatsView'
import { Highlight } from './Highlight'
import { IconCheck, IconClose, IconCopy } from './Icons'
import { Spinner } from './Spinner'
import { baseName, ipcErrorMessage, relativeTime } from '../lib/format'

/**
 * What the sidebar handed over: the hit (for a header while the text loads),
 * the query it matched, and — for this computer's chats — why this is not a
 * live session. A `remote` hit is a chat on another of the owner's computers
 * (spec 2026-10-03 §4): read through the hub relay, never copied here, and
 * never resumed from here.
 */
export type ChatViewTarget =
  | { kind: 'local'; hit: ChatSearchHit; query: string; note: string | null }
  | { kind: 'remote'; device: string; computer: string; hit: RemoteChatHit; query: string }

/** One chat as the viewer draws it, whichever computer it came from. */
interface Shown {
  /** Which load this is the answer to (`loadKey`). */
  key: string
  title: string | null
  updatedMs: number | null
  messages: ChatTranscriptMessage[]
  partial: boolean
  /** Where the text came from when it is not the tool's own copy now, or null. */
  fallback: string | null
}

function loadKey(t: ChatViewTarget): string {
  return t.kind === 'local' ? `local:${t.hit.chatId}` : `remote:${t.device}:${t.hit.source}:${t.hit.nativeId}`
}

/** A remote hit's source is the other computer's word: shown by its badge only when this build knows it. */
function badgeFor(source: string): string {
  return isChatOrigin(source) ? chatOriginBadge(source) : source
}

function assistantFor(source: string): string {
  return isChatOrigin(source) ? chatAssistantName(source) : 'Assistant'
}

function stampLabel(ms: number | null): string {
  if (ms === null) return ''
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The whole chat as plain text, for Copy all: who, when, then what they said. */
function asText(messages: readonly ChatTranscriptMessage[], source: string, title: string): string {
  const who = assistantFor(source)
  const lines = [`# ${title}`, '']
  for (const m of messages) {
    lines.push(`${m.role === 'user' ? 'You' : who}${m.atMs !== null ? ` — ${stampLabel(m.atMs)}` : ''}`, m.text, '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Read one chat: this computer's index, or another computer's over the hub relay. */
async function load(target: ChatViewTarget, key: string): Promise<{ shown: Shown | null; error: string | null }> {
  if (target.kind === 'local') {
    const t = await window.stoke.chats.open(target.hit.chatId)
    if (!t) return { shown: null, error: 'This chat is no longer in the index.' }
    return { shown: { key, title: t.title, updatedMs: t.updatedMs, messages: t.messages, partial: t.partial, fallback: t.fallback }, error: null }
  }
  const r = await window.stoke.hub.remote.openChat(target.device, target.hit.source, target.hit.nativeId)
  if (!r.ok) return { shown: null, error: r.message || `${target.computer} could not open this chat.` }
  const c = r.chat
  return { shown: { key, title: c.title, updatedMs: c.updatedMs, messages: c.messages, partial: c.partial, fallback: c.note }, error: null }
}

/**
 * A chat that cannot be taken back up, read-only: an import, a Zed or Cowork
 * thread, a subagent's transcript, an agent that is not installed or cannot be
 * handed a session id. Messages in order, who said each and when, the search's
 * words marked, and a copy button per message and for the whole chat.
 *
 * A column of `.body-row` (App places it beside the main column), never an
 * overlay: the docked browser is a native view that paints over every pixel of
 * the page (gotcha 14), and a chat you are reading should stay beside the
 * terminal you might paste it into.
 *
 * Main re-reads a local chat from its own tool's file when it is opened, so
 * what shows is the tool's copy now, not the index's; the header says when it
 * is the index's instead (an import, or an original that is gone).
 *
 * A chat from another computer has the same view under "On <Computer> ·
 * <folder>": that computer redacted it and names the folder only, and it is
 * held in this component's state alone — closed, it is gone from here.
 */
export function ChatViewer({ target, onClose }: { target: ChatViewTarget; onClose: () => void }): React.JSX.Element {
  const { query } = target
  const remote = target.kind === 'remote' ? target : null
  const hit = target.hit
  const key = loadKey(target)
  const [state, setState] = useState<{ key: string; shown: Shown | null; error: string | null } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const scrolledFor = useRef<string | null>(null)
  const targetRef = useRef(target)
  targetRef.current = target

  // Numbered like every other load here: a slow answer for the chat before must not land on this one.
  const req = useRef(0)
  useEffect(() => {
    const n = ++req.current
    setState(null)
    load(targetRef.current, key).then(
      (r) => {
        if (n === req.current) setState({ key, shown: r.shown, error: r.error })
      },
      (e: unknown) => {
        if (n === req.current) setState({ key, shown: null, error: ipcErrorMessage(e) })
      }
    )
  }, [key])

  const t = state?.key === key ? state.shown : null
  const marks = useMemo(() => (t ? t.messages.map((m) => highlightRanges(m.text, query)) : []), [t, query])
  const hits = marks.reduce((n, r) => n + r.length, 0)

  // To the first message that says what was searched for, once per chat.
  useEffect(() => {
    if (!t || scrolledFor.current === t.key) return
    scrolledFor.current = t.key
    const first = listRef.current?.querySelector('[data-hit="true"]')
    if (first) first.scrollIntoView({ block: 'center' })
    else listRef.current?.scrollTo({ top: 0 })
  }, [t])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(null), 1400)
    return () => clearTimeout(id)
  }, [copied])

  const title = t?.title ?? hit.title ?? (target.kind === 'local' ? target.hit.firstPrompt : null) ?? 'Untitled chat'
  const who = assistantFor(hit.source)
  const copy = (key: string, text: string): void => {
    window.stoke.clipboard.writeText(text)
    setCopied(key)
  }
  const updated = t?.updatedMs ?? hit.updatedMs
  // This computer's chat names its folder by the path's last segment; another computer sent only that segment.
  const cwd = target.kind === 'local' ? target.hit.cwd : null
  const where = remote ? remoteChatWhere(remote.computer, remote.hit.folder) : null

  return (
    <section className="chat-view" aria-label={`Chat: ${title}`} data-chat-view={target.kind}>
      <header className="chat-view-head">
        <div className="chat-view-heading">
          {where && (
            <span className="chat-view-where truncate" title={where} data-chat-where="">
              {where}
            </span>
          )}
          <span className="chat-view-title truncate" title={title}>
            {title}
          </span>
          <span className="chat-view-meta">
            <span className="pill chat-badge">{badgeFor(hit.source)}</span>
            {updated !== null && <span className="chat-hit-age">{relativeTime(updated)}</span>}
            {cwd && (
              <span className="truncate" title={cwd}>
                {baseName(cwd)}
              </span>
            )}
            {t && (
              <span className="chat-hit-age">
                {t.messages.length.toLocaleString()} {t.messages.length === 1 ? 'message' : 'messages'}
              </span>
            )}
          </span>
        </div>
        <button
          className="btn"
          data-variant="ghost"
          disabled={!t || t.messages.length === 0}
          onClick={() => t && copy('all', asText(t.messages, hit.source, title))}
          title="Copy the whole chat as text"
        >
          {copied === 'all' ? <IconCheck /> : <IconCopy />}
          {copied === 'all' ? 'Copied' : 'Copy all'}
        </button>
        <button className="icon-btn" onClick={onClose} title="Close the chat">
          <IconClose />
          <span className="sr-only">Close the chat</span>
        </button>
      </header>

      <div className="chat-view-notes">
        {target.kind === 'local' && target.note && <p className="chat-view-note">{target.note}</p>}
        {remote && (
          <p className="chat-view-note">
            Read-only, from {remote.computer}: it stays there, and nothing of it is kept on this computer. Secrets were redacted there.
          </p>
        )}
        {target.kind === 'local' && isChatImportKind(hit.source) && (
          <p className="chat-view-note">From your {chatOriginLabel(hit.source)}: the index’s copy, the only one Stoke has.</p>
        )}
        {t?.fallback && (
          <p className="chat-view-note" data-tone="warning">
            {t.fallback}
          </p>
        )}
        {t?.partial && (
          <p className="chat-view-note">
            Part of this chat is not shown: the middle of a very long conversation, or a file past the size read in one go.
          </p>
        )}
        {t && query.trim() && (
          <p className="chat-view-note">
            {hits === 0
              ? `“${query.trim()}” is not in what is shown here.`
              : `${hits.toLocaleString()} ${hits === 1 ? 'match' : 'matches'} for “${query.trim()}”, marked below.`}
          </p>
        )}
      </div>

      {!state ? (
        <p className="chat-view-status" aria-live="polite">
          <Spinner /> Reading the chat…
        </p>
      ) : state.error || !t ? (
        <p className="chat-view-status" role="status">
          {state.error ?? 'This chat could not be read.'}
        </p>
      ) : t.messages.length === 0 ? (
        <p className="chat-view-status">This chat has no text to show.</p>
      ) : (
        <ol className="chat-view-list" ref={listRef}>
          {t.messages.map((m, i) => {
            const key = `m${i}`
            const ranges = marks[i] ?? []
            return (
              <li key={key} className="chat-msg" data-role={m.role} data-hit={ranges.length > 0 ? 'true' : undefined}>
                <div className="chat-msg-head">
                  <span className="chat-msg-who">{m.role === 'user' ? 'You' : who}</span>
                  {m.atMs !== null && <time className="chat-msg-at">{stampLabel(m.atMs)}</time>}
                  <button
                    className="icon-btn chat-msg-copy"
                    onClick={() => copy(key, m.text)}
                    title="Copy this message"
                  >
                    {copied === key ? <IconCheck /> : <IconCopy />}
                    <span className="sr-only">Copy this message</span>
                  </button>
                </div>
                <div className="chat-msg-text">
                  <Highlight text={m.text} ranges={ranges} />
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
