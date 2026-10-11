import { useEffect, useRef, useState } from 'react'
import type { GrokBotView, GrokBotSource, GrokBotAccountCommand, GrokBotOperation } from '@shared/grokBot'
import { GBOT_SOURCE } from '@shared/grokBot'
export function GrokBotPanel(): React.JSX.Element {
  const [view, setView] = useState<GrokBotView | null>(null)
  const [selected, setSelected] = useState('')
  const [nickname, setNickname] = useState('')
  const [sources, setSources] = useState<GrokBotSource[]>([])
  const [slot, setSlot] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  const [roster, setRoster] = useState<{ id: string; name: string; kind: string }[]>([])
  const [target, setTarget] = useState('')
  const [message, setMessage] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [gateway, setGateway] = useState('')
  const [token, setToken] = useState('')
  const [headers, setHeaders] = useState('{}')
  const [allowLocal, setAllowLocal] = useState(false)
  const live = useRef(true),
    claimed = useRef(false),
    generation = useRef(0)
  useEffect(() => {
    live.current = true
    const accept = (next: GrokBotView): void => {
      if (live.current) {
        setView((old) => (!old || next.revision >= old.revision ? next : old))
        setSelected((old) =>
          next.accounts.some((account) => account.id === old) ? old : (next.defaultAccount ?? '')
        )
      }
    }
    const off = window.stoke.grokBot.onChange(accept)
    window.stoke.grokBot
      .read()
      .then(accept)
      .catch((error) => {
        if (live.current) setError(String(error))
      })
    return () => {
      live.current = false
      off()
      generation.current++
    }
  }, [])
  useEffect(() => {
    generation.current++
    setOutput('')
    setRoster([])
    setTarget('')
    setMessage('')
    setError('')
  }, [selected])
  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    if (claimed.current) return
    claimed.current = true
    const current = generation.current
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (error) {
      if (live.current && current === generation.current) setError(String(error))
    } finally {
      claimed.current = false
      if (live.current) setBusy(false)
    }
  }
  const change = (command: GrokBotAccountCommand): Promise<void> =>
    window.stoke.grokBot.change(command).then((next) => {
      if (live.current) {
        setView((old) => (!old || next.revision >= old.revision ? next : old))
        if (command.kind === 'import' || command.kind === 'manual')
          setSelected(next.accounts.at(-1)?.id ?? '')
        setToken('')
        setNickname('')
      }
    })
  const account = view?.accounts.find((account) => account.id === selected)
  const run = (kind: GrokBotOperation['kind']): void => {
    const request = { accountId: selected, kind, target, message, name: nickname }
    const current = generation.current
    void act(async () => {
      const result = await window.stoke.grokBot.operate(request)
      if (!live.current || current !== generation.current) return
      if (!result.ok)
        setError(
          `${result.message ?? 'Action failed.'}${result.delivery === 'unknown' ? ' Read the thread before resending; delivery is unknown.' : ''}`
        )
      else {
        setOutput(JSON.stringify(result.data, null, 2))
        if (kind === 'list' && result.data && typeof result.data === 'object') {
          const data = result.data as Record<string, unknown>
          const rows: { id: string; name: string; kind: string }[] = []
          for (const category of ['bots', 'groups'])
            if (Array.isArray(data[category]))
              for (const row of data[category])
                if (row && typeof row.id === 'string')
                  rows.push({
                    id: row.id,
                    name: typeof row.name === 'string' ? row.name : row.id,
                    kind: category === 'bots' ? 'Bot' : 'Group'
                  })
          setRoster(rows)
          setTarget(rows[0]?.id ?? '')
        }
        if (kind === 'send') setMessage('')
      }
    })
  }
  return (
    <section className="plugin-panel" aria-label="Grok Bot">
      <h3>Grok Bot</h3>
      <p className="plugin-muted">
        Unofficial{' '}
        <button className="plugin-link" onClick={() => void window.stoke.openExternal(GBOT_SOURCE)}>
          grok-bot-cli
        </button>
        . Sessions are encrypted on this device. They are separate from Grok Build and xAI API accounts.
      </p>
      {!view?.cli.installed && (
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const next = await window.stoke.grokBot.install()
              if (live.current) setView((old) => (!old || next.revision >= old.revision ? next : old))
            })
          }
        >
          Install reviewed CLI {view?.cli.version ?? '0.12.4'}
        </button>
      )}
      <div className="plugin-account-list" aria-label="Saved Grok Bot accounts">
        {view?.accounts.map((item) => (
          <div className="plugin-row" key={item.id}>
            <button
              className="plugin-account"
              disabled={busy}
              aria-pressed={selected === item.id}
              onClick={() => {
                generation.current++
                setSelected(item.id)
                setOutput('')
                setRoster([])
                setTarget('')
                setMessage('')
                setNickname('')
                setError('')
              }}
            >
              <strong>{item.label}</strong>
              <span>
                {item.gatewayHost} · {item.status}
                {view.defaultAccount === item.id ? ' · default' : ''}
              </span>
            </button>
          </div>
        ))}
        {view?.accounts.length === 0 && (
          <p>
            No accounts yet. Sign in to the Grok Bot desktop app, then import that login. Repeat for each
            account.
          </p>
        )}
      </div>
      {account && (
        <div className="plugin-controls">
          <span>
            Active: <strong>{account.label}</strong>
          </span>
          <button disabled={busy} onClick={() => void act(() => change({ kind: 'default', id: selected }))}>
            Make default
          </button>
          <button disabled={busy} onClick={() => void act(() => change({ kind: 'remove', id: selected }))}>
            Remove account
          </button>
        </div>
      )}
      <div className="plugin-controls">
        <label>
          Account nickname
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Personal, Work, Account 3…"
            maxLength={100}
          />
        </label>
        {account && (
          <button
            disabled={busy || !nickname.trim()}
            onClick={() => void act(() => change({ kind: 'rename', id: selected, label: nickname }))}
          >
            Rename active account
          </button>
        )}
      </div>
      <div className="plugin-controls">
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const next = await window.stoke.grokBot.sources()
              if (live.current) {
                setSources(next)
                setSlot(next[0]?.id ?? '')
              }
            })
          }
        >
          Read desktop sessions
        </button>
        {sources.length > 0 && (
          <>
            <label>
              Desktop session
              <select value={slot} onChange={(event) => setSlot(event.target.value)}>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={busy || !nickname.trim() || !slot}
              onClick={() => void act(() => change({ kind: 'import', label: nickname, sourceSlot: slot }))}
            >
              Import as new account
            </button>
            {account && (
              <button
                disabled={busy || !nickname.trim() || !slot}
                onClick={() =>
                  void act(() =>
                    change({ kind: 'import', label: nickname, sourceSlot: slot, replace: selected })
                  )
                }
              >
                Replace {account.label} with this login
              </button>
            )}
          </>
        )}
      </div>
      <button className="plugin-link" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        Advanced connection
      </button>
      {advanced && (
        <div className="plugin-form">
          <p>
            Use an existing gateway session, including its routing headers. API keys from the xAI dashboard
            cannot sign in to Grok Bot.
          </p>
          <label>
            Gateway URL
            <input value={gateway} onChange={(event) => setGateway(event.target.value)} />
          </label>
          <label>
            Gateway token
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label>
            Routing headers (JSON)
            <textarea value={headers} onChange={(event) => setHeaders(event.target.value)} />
          </label>
          <label>
            <input
              type="checkbox"
              checked={allowLocal}
              onChange={(event) => setAllowLocal(event.target.checked)}
            />
            Allow local development gateway
          </label>
          <button
            disabled={busy || !nickname.trim() || !token}
            onClick={() =>
              void act(() =>
                change({
                  kind: 'manual',
                  label: nickname,
                  gatewayUrl: gateway,
                  token,
                  headers: JSON.parse(headers),
                  allowLocal
                })
              )
            }
          >
            Save separate account
          </button>
        </div>
      )}
      {account && view?.cli.installed && (
        <div className="plugin-form">
          <div className="plugin-controls">
            <button disabled={busy} onClick={() => run('list')}>
              List bots and groups / verify account
            </button>
            <label>
              Bot or group
              {roster.length > 0 && (
                <select value={target} onChange={(event) => setTarget(event.target.value)}>
                  <option value="">Choose a thread</option>
                  {roster.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.kind}: {row.name}
                    </option>
                  ))}
                </select>
              )}
              <input value={target} onChange={(event) => setTarget(event.target.value)} />
            </label>
            <button disabled={busy || !target} onClick={() => run('thread')}>
              Read thread
            </button>
          </div>
          <label>
            Message to send as {account.label}
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Write a message…"
            />
          </label>
          <button disabled={busy || !target || !message.trim()} onClick={() => run('send')}>
            Send message
          </button>
        </div>
      )}
      {busy && <p role="status">Working…</p>}
      {error && (
        <p role="alert" className="plugin-error">
          {error}
        </p>
      )}
      {output && (
        <pre className="plugin-output" tabIndex={0}>
          {output}
        </pre>
      )}
    </section>
  )
}
