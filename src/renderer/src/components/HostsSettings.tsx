import { useCallback, useMemo, useState } from 'react'
import type { SshHost } from '@shared/types'
import { IconClose, IconPlus } from './Icons'

interface Props {
  hosts: SshHost[]
  /** Host aliases read out of ~/.ssh/config. Offered, never required. */
  suggestions: string[]
  onChange: (hosts: SshHost[]) => void
}

/**
 * What a new host runs on connect, and why it is not empty.
 *
 * A remote session cannot use Stoke's resume: resume replays the transcript
 * Claude Code writes, and for a remote session that file is on the far machine
 * where Stoke cannot see it. A terminal multiplexer is therefore the only thing
 * that survives a dropped link, so the useful default is one — not a bare login
 * shell that loses the work the first time the wifi drops.
 */
const DEFAULT_COMMAND = 'byobu'

/** One shared datalist: every alias box offers the same aliases. */
const ALIAS_LIST_ID = 'stoke-ssh-aliases'

/**
 * Ids only have to be unique inside this list and never leave settings.json, so
 * a counter is enough. It also keeps the stored file readable, which a UUID per
 * host would not.
 */
export function newHostId(hosts: SshHost[]): string {
  const taken = new Set(hosts.map((h) => h.id))
  for (let n = 1; ; n++) {
    const id = `host-${n}`
    if (!taken.has(id)) return id
  }
}

export type HostTextField = 'label' | 'alias' | 'command'

/**
 * What committing an edited box should change, or null when it changes nothing.
 *
 * Pure, and exported, because this is the part worth testing: it decides
 * whether a keystroke is kept. There is no DOM test environment in this repo,
 * so logic left inside the component would be verified by reading it, and
 * "typing into a box sometimes does nothing" is precisely the plausible-looking
 * failure this project keeps producing.
 */
export function commitField(
  host: SshHost,
  field: HostTextField,
  draft: string
): Partial<SshHost> | null {
  const next = draft.trim()
  if (next === host[field]) return null

  const changes: Partial<SshHost> = { [field]: next }
  // Naming a host twice is busywork: the alias is already a name, so use it
  // when the label has been left blank.
  if (field === 'alias' && next && !host.label.trim()) changes.label = next
  return changes
}

/**
 * Remote machines, offered in the launcher as an alternative to a local project.
 *
 * Everything comes in as props: this renders inside the settings sheet, which
 * already owns the settings round trip, and a component that fetched its own
 * hosts would be a second copy of the same list to keep in step.
 */
export function HostsSettings({ hosts, suggestions, onChange }: Props): React.JSX.Element {
  /*
   * Text fields are local drafts, committed on blur or Enter.
   *
   * Writing a setting is a round trip through the main process, and an input
   * fed straight from the value that comes back drops characters typed while
   * that write is in flight — the same hazard PLAN records against the remote
   * panel, where a status poll landing mid-edit parks the caret at the end.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string | null>(null)

  const known = useMemo(
    () => new Set(suggestions.map((s) => s.trim().toLowerCase())),
    [suggestions]
  )

  const keyFor = (id: string, field: HostTextField): string => `${id}:${field}`

  const valueOf = (host: SshHost, field: HostTextField): string =>
    drafts[keyFor(host.id, field)] ?? host[field]

  const update = useCallback(
    (id: string, changes: Partial<SshHost>): void => {
      onChange(hosts.map((h) => (h.id === id ? { ...h, ...changes } : h)))
    },
    [hosts, onChange]
  )

  const commit = useCallback(
    (host: SshHost, field: HostTextField): void => {
      const key = keyFor(host.id, field)
      const draft = drafts[key]
      setDrafts((d) => {
        const { [key]: _drop, ...rest } = d
        return rest
      })
      if (draft === undefined) return

      const changes = commitField(host, field, draft)
      if (changes) update(host.id, changes)
    },
    [drafts, update]
  )

  const add = useCallback((): void => {
    onChange([
      ...hosts,
      { id: newHostId(hosts), label: '', alias: '', command: DEFAULT_COMMAND }
    ])
  }, [hosts, onChange])

  const remove = useCallback(
    (id: string): void => {
      onChange(hosts.filter((h) => h.id !== id))
    },
    [hosts, onChange]
  )

  return (
    <div className="field">
      <span className="field-label">Remote machines</span>
      <span className="field-hint">
        A remote profile is an alias from your <span className="mono">~/.ssh/config</span> plus
        what to run once you land. Stoke stores no keys, ports, usernames or jump hosts — ssh
        reads those from the config every other tool on this machine already uses, so there is
        nothing here that can quietly drift out of step with it.
      </span>
      <span className="field-hint">
        Two things do not apply to a remote session, both for the same reason. The context meter
        stays blank, because it reads the transcript Claude Code writes and that file lives on
        the far machine. Stoke&rsquo;s resume cannot reach one either — which is exactly what the
        connect command below is for.
      </span>
      <span className="field-hint">
        Passphrase and host-key prompts appear in the terminal and work as they would in any
        shell. Stoke never stores or asks for a secret itself.
      </span>

      {/* Native datalist: the box stays free-form, so a host that is not in the
          config can still be typed out in full as user@host. */}
      <datalist id={ALIAS_LIST_ID}>
        {suggestions.map((alias) => (
          <option key={alias} value={alias} />
        ))}
      </datalist>

      {hosts.length === 0 && (
        <span className="field-hint">
          None yet. Add one to reach a VPS or a home server from here, and from your phone
          through the remote server — without installing anything on it.
        </span>
      )}

      {hosts.map((host) => {
        const alias = valueOf(host, 'alias').trim()
        const unknownAlias = suggestions.length > 0 && alias !== '' && !known.has(alias.toLowerCase())

        return (
          <div
            key={host.id}
            className="field"
            style={{
              gap: 'var(--sp-2)',
              padding: 'var(--sp-3)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
              <input
                className="input"
                placeholder="Name, e.g. VPS"
                aria-label="Name of this remote machine"
                value={valueOf(host, 'label')}
                spellCheck={false}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [keyFor(host.id, 'label')]: e.target.value }))
                }
                onBlur={() => commit(host, 'label')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
              {confirming === host.id ? (
                <>
                  <button
                    className="btn"
                    data-variant="danger"
                    onClick={() => {
                      remove(host.id)
                      setConfirming(null)
                    }}
                  >
                    Remove
                  </button>
                  <button className="btn" data-variant="ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button
                  className="icon-btn"
                  title={`Remove ${host.label || host.alias || 'this host'}`}
                  onClick={() => setConfirming(host.id)}
                >
                  <IconClose width={12} height={12} />
                  <span className="sr-only">Remove {host.label || host.alias || 'this host'}</span>
                </button>
              )}
            </div>

            <input
              className="input mono"
              list={ALIAS_LIST_ID}
              placeholder="ssh alias, or user@host"
              aria-label="SSH alias for this remote machine"
              value={valueOf(host, 'alias')}
              spellCheck={false}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [keyFor(host.id, 'alias')]: e.target.value }))
              }
              onBlur={() => commit(host, 'alias')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            {unknownAlias && (
              <span className="field-hint">
                Not one of the <span className="mono">Host</span> entries in your ssh config. That
                is fine for a full <span className="mono">user@host</span>, and a typo otherwise.
              </span>
            )}

            <input
              className="input mono"
              placeholder="Command on connect — empty for a login shell"
              aria-label="Command to run on connect"
              value={valueOf(host, 'command')}
              spellCheck={false}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [keyFor(host.id, 'command')]: e.target.value }))
              }
              onBlur={() => commit(host, 'command')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <span className="field-hint">
              <span className="mono">byobu</span> — or{' '}
              <span className="mono">tmux new -A -s stoke</span> — leaves the session running on
              the far machine, so a dropped connection reconnects to the same work rather than
              losing it. Since Stoke&rsquo;s own resume cannot reach across, a multiplexer is the
              only thing that survives the link going down. Empty gives a plain login shell.
            </span>
          </div>
        )
      })}

      {suggestions.length === 0 && (
        <span className="field-hint">
          No <span className="mono">Host</span> entries were found in{' '}
          <span className="mono">~/.ssh/config</span>, so there is nothing to suggest. A full{' '}
          <span className="mono">user@host</span> works just as well.
        </span>
      )}

      <button className="btn" onClick={add}>
        <IconPlus />
        Add machine
      </button>
    </div>
  )
}
