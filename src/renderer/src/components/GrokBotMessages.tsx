import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GrokBotMessage } from '@shared/grokBotConversation'
import '../styles/grokBot.css'

/** No raw HTML or remote image loads; links allow HTTP(S) without URL user info. */
function linkUrl(value: string): string {
  try {
    const url = new URL(value)
    return value.length <= 2048 && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}
const MessageText = memo(function MessageText({ text, onOpenUrl }: { text: string; onOpenUrl: (url: string) => void }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={linkUrl} components={{
    a: ({ href, children }) => href ? <a href={href} onClick={event => { event.preventDefault(); onOpenUrl(href) }}>{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
    table: ({ children }) => <div className="grok-table"><table>{children}</table></div>
  }}>{text}</Markdown>
})

export function GrokBotMessages({ messages, name = 'Grok Bot', onOpenUrl = url => { void window.stoke.openExternal(url) } }: {
  messages: GrokBotMessage[]
  name?: string
  onOpenUrl?: (url: string) => void
}): React.JSX.Element {
  return <ol className="grok-messages" aria-label="Grok Bot messages">
    {messages.map((message, index) => <li className="grok-message" data-role={message.role} key={`${message.id}:${index}`}>
      <div className="grok-message-heading">
        <strong>{message.role === 'user' ? 'You' : message.role === 'assistant' ? name : 'Activity'}</strong>
        {message.atMs !== null && <time dateTime={new Date(message.atMs).toISOString()}>{new Date(message.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
        {/* .grok-message-copy is user-select: none, so a selection across messages does not copy "Copy" between them. */}
        <button className="btn grok-message-copy" data-variant="ghost" onClick={() => window.stoke.clipboard.writeText(message.text)} aria-label="Copy message">Copy</button>
      </div>
      <div className="grok-message-text">{message.role === 'user' ? <p className="grok-user-text">{message.text}</p> : <MessageText text={message.text} onOpenUrl={onOpenUrl} />}</div>
    </li>)}
  </ol>
}
