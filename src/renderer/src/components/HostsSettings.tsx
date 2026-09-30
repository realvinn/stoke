import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SshHost, SshKeyEnroll } from '@shared/types'
import { isEnrollableAlias } from '@shared/sshAuth'
import { persistRefusal } from '@shared/sshPersist'
import { FieldHint } from './FieldHint'
import { IconClose, IconCopy, IconPlus } from './Icons'

interface Props {
  hosts: SshHost[]
  /** Host aliases read out of ~/.ssh/config. Offered, never required. */
  suggestions: string[]
  onChange: (hosts: SshHost[]) => void
  /** `Settings.sshKeyEnroll`. The only copy — never mirrored into state. */
  keyEnroll: SshKeyEnroll
  onChangeKeyEnroll: (value: SshKeyEnroll) => void
  /**
   * Set up key login for this host now: App closes the sheet and opens the
   * "Add key to …" tab (`startSshEnroll`), where the password is typed.
   */
  onSetUpKey: (hostId: string) => void
  /** The host an enrollment is running for, or null. One at a time. */
  enrollingHostId: string | null
}

/**
 * What to do when a remote asks for a password, in the user's words.
 *
 * The middle label says what it says on purpose and must not be shortened to
 * "add keys automatically". Installing a key requires authenticating to the
 * machine, authenticating requires the password, and the password is the one
 * thing Stoke never holds — so the automatic setting cannot mean "without you".
 * It skips the question and nothing else; the password is still typed by hand.
 *
 * Radios rather than a <select>: a closed <select> cannot ellipsis its own
 * value, and that middle line is the one that would be cut in half
 * (ClaudeCodeSettings measured the same trap and records it).
 */
const KEY_ENROLL_CHOICES: { id: SshKeyEnroll; label: string; hint: string }[] = [
  {
    id: 'ask',
    label: 'Offer to add a key',
    hint: 'A strip above the terminal asks. Nothing is installed until you press it.'
  },
  {
    id: 'auto',
    label: 'Start adding a key straight away — you still type the password',
    hint: 'Skips the yes/no. Stoke cannot install a key without you authenticating, so you type the password once either way.'
  },
  {
    id: 'off',
    label: 'Do nothing',
    hint: 'Never offer, on any machine. Passwords keep working exactly as they do now.'
  }
]

/**
 * What a new host runs on connect: nothing extra, a login shell.
 *
 * It used to be `byobu`, because a multiplexer was the only thing that
 * survived a dropped link — Stoke's own resume replays a transcript that, for a
 * remote session, lives on the far machine. A new host now keeps its tabs'
 * shells itself (`persist: 'tmux'`, a private invisible session per tab), so
 * byobu's status bar, windows and F-keys are no longer the price of surviving
 * the wifi. A host saved with `byobu` keeps it (gotcha 126).
 */
const DEFAULT_COMMAND = ''

/**
 * For people who keep byobu (or their own tmux) as the connect command.
 * Nothing Stoke writes: it goes in their own config, by their own hand.
 */
const BYOBU_SNIPPET = [
  '# ~/.byobu/.tmux.conf for byobu, ~/.tmux.conf for plain tmux',
  '# The wheel scrolls tmux history; it leaves copy mode at the bottom.',
  'set -g mouse on',
  '# Copies inside the session reach this machine (vim "+y, tmux drags).',
  'set -g set-clipboard on',
  '# Append with -ga: plain -g replaces byobu’s own xterm* line.',
  "set -ga terminal-overrides ',xterm*:indn@'"
].join('\n')

/** A snippet the user may copy into their own config, and the button that takes it. */
function Snippet({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="step-cmd">
      <pre className="mono">{text}</pre>
      <button
        className="btn"
        data-variant="ghost"
        onClick={() => {
          window.stoke.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        }}
      >
        <IconCopy />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

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
export function HostsSettings({
  hosts,
  suggestions,
  onChange,
  keyEnroll,
  onChangeKeyEnroll,
  onSetUpKey,
  enrollingHostId
}: Props): React.JSX.Element {
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
      /*
       * Every optional flag stated, none left to `undefined`.
       *
       * `worklog: false` so a new machine never arrives with an agent already
       * reading its transcripts — and the two key fields for the same reason,
       * one step further: `keyEnrollRefused` decides whether this machine is
       * ever offered a key and `keyEnrolled` claims one is already installed
       * and working. A field that is absent reads as false everywhere, which is
       * the right answer both times; writing it down is what stops a later
       * `h.keyEnrolled ?? somethingElse` from quietly meaning something else.
       */
      {
        id: newHostId(hosts),
        label: '',
        alias: '',
        command: DEFAULT_COMMAND,
        worklog: false,
        keyEnrollRefused: false,
        keyEnrolled: false,
        // A NEW machine keeps its tabs' shells running between connections;
        // one saved before this existed hydrates as 'off', unchanged.
        persist: 'tmux'
      }
    ])
  }, [hosts, onChange])

  const remove = useCallback(
    (id: string): void => {
      onChange(hosts.filter((h) => h.id !== id))
    },
    [hosts, onChange]
  )

  return (
    <div className="field" data-setting="hosts.list">
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
              <b>Keep sessions running.</b> Each tab to the machine gets its own shell inside an
              invisible <span className="mono">tmux</span> session (a private one, so your own tmux
              and byobu are never touched). A dropped connection, a sleeping laptop or quitting
              Stoke leaves it running; the tab reconnects by itself, and a restart reattaches.
              There is no status bar, no copy mode and no tmux keys (Ctrl+B reaches your shell): the
              wheel, dragging and Copy work as they do locally. Closing a tab asks whether to detach or end the shell, and the launcher lists
              the ones still running. The machine needs <span className="mono">tmux</span>; without
              it the tab says so and runs a plain shell.
            </p>
            <p>
              What scrolls back: everything a reconnect brings back (tmux keeps 5000 lines), and
              anything that arrives a screen at a time. A burst longer than the screen keeps only
              what tmux drew, as byobu does; reconnecting brings the rest back.
            </p>
            <p>
              <b>The connect command</b> runs inside that session, as it is. Leave it empty for a
              login shell. It cannot contain <span className="mono">&apos; &quot; \ $ `</span> or{' '}
              <span className="mono">!</span> while sessions are kept, because Stoke hands it to the
              remote shell untouched rather than escaping it.
            </p>
            <p>
              <b>Keeping byobu instead?</b> Turn &ldquo;Keep sessions running&rdquo; off and set the
              command to <span className="mono">byobu</span>. These lines in its config make the
              wheel scroll its history and copies reach this machine:
            </p>
            <Snippet text={BYOBU_SNIPPET} />
            <p>
              <b>Writing up work.</b> Ticking that on a machine copies the session&rsquo;s
              transcript back over the same connection, which is also what makes the context meter
              work — it cannot read a file that only exists on the far machine. While it is off,
              nothing is copied off that machine at all.
            </p>
            <p>
              Stoke&rsquo;s own conversation resume does not reach a remote session: it replays the
              transcript Claude Code writes, and that file lives on the far machine. A kept session
              is what survives instead.
            </p>
          </>
        }
      >
        An alias from your <span className="mono">~/.ssh/config</span>, plus what to run once you
        land.
      </FieldHint>

      {/*
        One control for every machine, above the list, because that is its
        scope: `Settings.sshKeyEnroll` is app-wide and each host's own
        `keyEnrollRefused` is the exception to it. Both are readable here, which
        is the point -- a refusal pressed under a password prompt months ago is
        otherwise a setting the user can turn on and never off.

        `keyEnroll` comes in as a prop and goes out through `onChangeKeyEnroll`;
        it is never copied into a `useState` here (gotcha 57), so the radios can
        only ever show what settings actually holds.
      */}
      <div className="field" role="radiogroup" aria-labelledby="ssh-key-enroll-label" data-setting="hosts.key-enroll">
        <span className="field-label" id="ssh-key-enroll-label">
          When a remote asks for a password
        </span>
        {KEY_ENROLL_CHOICES.map((c) => (
          <label className="check-row" key={c.id}>
            <input
              type="radio"
              name="ssh-key-enroll"
              checked={keyEnroll === c.id}
              onChange={() => onChangeKeyEnroll(c.id)}
            />
            <span>
              <span className="field-label">{c.label}</span>
              <span className="field-hint">{c.hint}</span>
            </span>
          </label>
        ))}
        <FieldHint
          more={
            <>
              <p>
                A password prompt from a machine you use every day is a machine that has never been
                given a key. Stoke notices the prompt -- the detection is a whitelist of{' '}
                <span className="mono">ssh</span>&rsquo;s own wording, so a{' '}
                <span className="mono">sudo</span> prompt or a credential helper&rsquo;s prompt
                inside the session is never mistaken for one -- and offers to run{' '}
                <span className="mono">ssh-copy-id</span> for that host.
              </p>
              <p>
                <b>Your password never reaches Stoke.</b> The install opens its own tab, &ldquo;Add
                key to &hellip;&rdquo;, which asks for the password itself, and you type it there,
                once. Stoke holds no password at any point, in any setting, which is also why the
                automatic setting cannot be silent.
              </p>
              <p>
                Stoke uses the key <span className="mono">ssh</span> already picks for that host, or
                makes <span className="mono">~/.ssh/id_ed25519</span>. When your ssh config would not
                offer that key to the host, it adds one <span className="mono">Host</span> block
                naming it at the end of <span className="mono">~/.ssh/config</span> (backed up to{' '}
                <span className="mono">config.stoke.bak</span> first) and changes nothing else.
                Then it connects once with <span className="mono">BatchMode</span> to prove a plain{' '}
                <span className="mono">ssh</span> gets in without a password.
              </p>
              <p>
                Nothing is offered at all while this is set to <b>Do nothing</b>. &ldquo;Set up key
                login&rdquo; on a machine below works either way.
              </p>
            </>
          }
        >
          Offered only by machines that ask; &ldquo;Set up key login&rdquo; below works on any. The
          key goes in that machine&rsquo;s <span className="mono">authorized_keys</span>.
        </FieldHint>
      </div>

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
        const kept = host.persist === 'tmux'
        const summary = [host.alias.trim(), host.command.trim() || 'login shell', kept ? 'kept running' : '']
          .filter(Boolean)
          .join(' — ')
        // Said against the committed command, like the argv main will build.
        const refusal = kept ? persistRefusal(host.command) : null

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
              {/* Per-host state, readable without opening the row. A pill
                  rather than a second dot: the dot beside it already means
                  "written up", and two dots of different colours in one row is
                  a legend nobody has. */}
              {host.keyEnrolled === true && (
                <span
                  className="pill"
                  data-tone="accent"
                  title="Stoke added an SSH key to this machine"
                >
                  key
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
                  placeholder="empty for a login shell"
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
              {refusal && <FieldHint tone="warning">{refusal}</FieldHint>}

              {/*
                Keep this machine's shells running between connections (gotcha
                126). Per host, because it needs tmux over there and changes what
                closing a tab means; new machines start with it on.
              */}
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={kept}
                  onChange={(e) => update(host.id, { persist: e.target.checked ? 'tmux' : 'off' })}
                />
                <span>
                  <span className="field-label">Keep sessions running on this machine</span>
                  <span className="field-hint">
                    {kept
                      ? 'Each tab survives a dropped link and a restart. Needs tmux there.'
                      : 'Off: a dropped link ends the shell, unless the command above keeps it.'}
                  </span>
                </span>
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

              {/*
                The way back from "Never for this host".

                That button writes `keyEnrollRefused` from a strip that appears
                under a password prompt and is gone a moment later, so without a
                row here it would be a setting a user can turn on and never off
                -- which is also why the offer itself needs no confirm step.
              */}
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={host.keyEnrollRefused !== true}
                  onChange={(e) => update(host.id, { keyEnrollRefused: !e.target.checked })}
                />
                <span>
                  <span className="field-label">
                    Offer to add a key when this machine asks for a password
                  </span>
                  {/* Only where there is something to say: a hint under every
                      host in every state is the prose-per-machine this file
                      already paid for once. */}
                  {host.keyEnrolled === true ? (
                    <span className="field-hint">
                      Stoke has added a key here and checked that it works
                      {host.keyEnrollRefused === true ? ', and the offer is off.' : '.'}
                    </span>
                  ) : (
                    host.keyEnrollRefused === true && (
                      <span className="field-hint">
                        Turned off by &ldquo;Never for this host&rdquo;. Ticking it is the way back.
                      </span>
                    )
                  )}
                </span>
              </label>

              {/*
                The way in that needs no password prompt first. Uses the
                COMMITTED alias (what a tab would connect to), not a draft still
                being typed; main looks the host up by id anyway.
              */}
              <div className="settings-item-actions">
                <button
                  className="btn"
                  data-size="sm"
                  disabled={!isEnrollableAlias(host.alias.trim()) || enrollingHostId !== null}
                  onClick={() => onSetUpKey(host.id)}
                  aria-label={`Set up key login for ${name}`}
                >
                  {enrollingHostId === host.id ? 'Setting up key login…' : 'Set up key login'}
                </button>
                {host.alias.trim() !== '' && !isEnrollableAlias(host.alias.trim()) ? (
                  <span className="field-hint">
                    Stoke will not hand this alias to <span className="mono">ssh-copy-id</span>. Run it
                    yourself.
                  </span>
                ) : (
                  <span className="field-hint">
                    Opens a tab that asks for this machine&rsquo;s password once.
                  </span>
                )}
              </div>

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
