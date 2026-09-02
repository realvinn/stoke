import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SshHost } from '@shared/types'
import { FieldHint } from './FieldHint'
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

  /*
   * Commit whatever is still being typed when this panel goes away.
   *
   * The drafts above are committed on blur or Enter, and closing the settings
   * sheet is neither. App renders it as `{settingsOpen && <SettingsSheet …>}`,
   * so Escape (or the close button, or clicking the backdrop) UNMOUNTS the
   * tree — and React fires no blur on an element it is removing. So typing a
   * new hostname or user and pressing Escape threw the edit away silently,
   * which reads as the setting not having saved rather than as not having been
   * committed.
   *
   * Written through a ref updated on every render, and an effect with an empty
   * dependency list, so the cleanup sees the LAST drafts rather than the ones
   * captured when the effect first ran — gotcha 31's shape. Everything is
   * folded into a single `onChange` because `hosts` is one array: committing
   * field by field would have each call overwrite the previous one's result.
   */
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = (): void => {
    const pending = Object.entries(drafts)
    if (!pending.length) return
    let next = hosts
    let moved = false
    for (const [key, draft] of pending) {
      const at = key.lastIndexOf(':')
      const id = key.slice(0, at)
      const field = key.slice(at + 1) as HostTextField
      const host = next.find((h) => h.id === id)
      if (!host) continue
      const changes = commitField(host, field, draft)
      if (!changes) continue
      next = next.map((h) => (h.id === id ? { ...h, ...changes } : h))
      moved = true
    }
    if (moved) onChange(next)
  }
  useEffect(() => () => flushRef.current(), [])

  const add = useCallback((): void => {
    onChange([
      ...hosts,
      // Explicitly off. A new host must never arrive with an agent already
      // reading its transcripts.
      { id: newHostId(hosts), label: '', alias: '', command: DEFAULT_COMMAND, worklog: false }
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
      {/*
        Everything that is true of every machine is said HERE, once.
        
        It used to be said inside the map, so a 312-character byobu paragraph
        and the worklog explanation were repeated verbatim under every host --
        591 characters of prose per machine that named none of them. Measured,
        that was 44% of a 281px card, which is why ten hosts came to 2993px in
        an 879px panel. Commit 2febab8 folded the section-level hints in this
        very file and left the one hint that gets multiplied by N.
      */}
      <FieldHint
        more={
          <>
            <p>
              Stoke stores no keys, ports, usernames or jump hosts — ssh reads those from the
              config every other tool on this machine already uses, so there is nothing here that
              can quietly drift out of step with it. Passphrase and host-key prompts appear in the
              terminal and behave as they would in any shell.
            </p>
            <p>
              <b>The connect command.</b> <span className="mono">byobu</span>, or{' '}
              <span className="mono">tmux new -A -s stoke</span>, leaves the session running on the
              far machine, so a dropped connection reconnects to the same work rather than losing
              it. A multiplexer is the only thing that survives the link going down, because
              Stoke&rsquo;s own resume cannot reach across. Leave it empty for a plain login shell.
            </p>
            <p>
              <b>Writing up work.</b> Ticking that on a machine copies the session&rsquo;s
              transcript back over the same connection, which is also what makes the context meter
              work — it cannot read a file that only exists on the far machine. While it is off,
              nothing is copied off that machine at all.
            </p>
            <p>
              Two things do not apply to a remote session, both for the same reason: the context
              meter stays blank and Stoke&rsquo;s resume cannot reach one. Both read the transcript
              Claude Code writes, and that file lives on the far machine — which is what the
              connect command is for.
            </p>
          </>
        }
      >
        An alias from your <span className="mono">~/.ssh/config</span>, plus what to run once you
        land.
      </FieldHint>

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

      {/*
        One collapsed row per machine, expanded to edit.

        Measured at Interface scale 1.0 in a real Chromium window: 206 / 282 /
        548px at 1 / 3 / 10 hosts, against 393 / 971 / 2993px before. A closed
        row is 30px; an open one adds 172px. The whole list stays inside one
        879px panel well past ten machines, where three used to overflow it.

        A native <details> rather than a useState, for the reasons FieldHint
        already gives: keyboard-operable, announced by screen readers, and
        Cmd+F finds text inside a closed one in Chromium.

        `open` when the alias is blank, so a machine you just added is already
        expanded rather than silently collapsed into a row saying nothing.
      */}
      {hosts.map((host) => {
        const alias = valueOf(host, 'alias').trim()
        const unknownAlias = suggestions.length > 0 && alias !== '' && !known.has(alias.toLowerCase())
        const name = host.label.trim() || host.alias.trim() || 'New machine'
        const summary = [host.alias.trim(), host.command.trim() || 'login shell']
          .filter(Boolean)
          .join(' — ')

        return (
          <details key={host.id} className="settings-item" open={host.alias.trim() === ''}>
            <summary className="settings-item-summary">
              <span className="settings-item-name">{name}</span>
              <span className="settings-item-sub mono truncate">{summary}</span>
              {host.worklog === true && (
                <span className="settings-item-dot" title="Work done here is written up">
                  <span className="sr-only">written up</span>
                </span>
              )}
            </summary>

            <div className="settings-item-body">
              <label className="cc-text">
                <span className="field-label">Name</span>
                <input
                  className="input"
                  placeholder="e.g. VPS"
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
              </label>

              {/* Labelled, not just placeholdered. Three placeholder-only boxes
                  become three unlabelled boxes the moment they are filled in,
                  which is the state they spend their whole life in. */}
              <label className="cc-text">
                <span className="field-label">SSH alias</span>
                <input
                  className="input mono"
                  list={ALIAS_LIST_ID}
                  placeholder="alias, or user@host"
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
              </label>
              {/* The one hint that stays inside the map: it is about THIS alias. */}
              {unknownAlias && (
                <span className="field-hint">
                  Not one of the <span className="mono">Host</span> entries in your ssh config. That
                  is fine for a full <span className="mono">user@host</span>, and a typo otherwise.
                </span>
              )}

              <label className="cc-text">
                <span className="field-label">Command on connect</span>
                <input
                  className="input mono"
                  placeholder="byobu — empty for a login shell"
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
              </label>

              {/*
                Per host, not per folder. A remote session's folder is wherever
                Stoke was pointed locally, so the profile checkboxes cannot mean
                anything for it — the machine is the only honest unit.
              */}
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={host.worklog === true}
                  onChange={(e) =>
                    onChange(
                      hosts.map((h) => (h.id === host.id ? { ...h, worklog: e.target.checked } : h))
                    )
                  }
                />
                <span className="field-label">Write up work done on this machine</span>
              </label>

              {/* In the body, not the summary. A button inside a <summary>
                  toggles the disclosure on its way through unless it calls
                  preventDefault, and a Remove that also collapses the row it is
                  removing reads as a bug either way. */}
              <div className="settings-item-actions">
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
                      Remove {name}
                    </button>
                    <button
                      className="btn"
                      data-variant="ghost"
                      onClick={() => setConfirming(null)}
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    onClick={() => setConfirming(host.id)}
                  >
                    <IconClose />
                    Remove
                  </button>
                )}
              </div>
            </div>
          </details>
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
