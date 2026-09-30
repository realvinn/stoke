import { useState } from 'react'
import type { HubRemoteView, OtherMachineView, RemoteSessionSummary } from '@shared/hub/remote'
import { ContextBar } from './ContextMeter'
import { IconChevron } from './Icons'
import { relativeTime } from '../lib/format'
import { platformName } from '../lib/hubRemote'

/*
 * The sidebar's "Other machines" group: each of the owner's other signed-in
 * desktops that is online right now, and — where its owner ticked "Let my
 * other devices see and open my sessions" THERE — its running sessions.
 * Clicking one opens it as a remote tab here; the other machine asks first
 * (src/main/hub/remote.ts). A group in the sidebar column, never an overlay
 * (gotcha 14): the docked browser paints over anything floating.
 *
 * What it shows is what the other machine sealed for its devices: a project's
 * folder NAME, never its path, and a title. Every string is another machine's
 * text, cut to size in `parseRemoteStatus` before it gets here.
 */

const STATUS_WORDS: Record<RemoteSessionSummary['status'], string> = {
  waiting: 'needs you',
  busy: 'working',
  idle: 'idle',
  ended: 'ended',
  unknown: ''
}

interface Props {
  view: HubRemoteView
  onOpen: (machine: OtherMachineView, session: RemoteSessionSummary) => void
}

export function OtherMachines({ view, onOpen }: Props): React.JSX.Element | null {
  const [folded, setFolded] = useState(false)
  if (!view.available) return null
  const open = new Set(view.tabs.map((t) => `${t.device}\n${t.ptyId}`))
  return (
    <section className="other-machines" aria-label="Other machines" data-hub="other-machines">
      <button className="sidebar-group other-machines-head" aria-expanded={!folded} onClick={() => setFolded((f) => !f)}>
        <IconChevron className="other-machines-chevron" />
        Other machines
        {view.machines.length > 0 && <span className="other-machines-count">{view.machines.length}</span>}
      </button>
      {!folded && view.machines.length === 0 && (
        <p className="sidebar-note">None of your other devices is online. Each one shows here while Stoke runs on it, signed in to your hub.</p>
      )}
      {!folded &&
        view.machines.map((m) => (
          <div key={m.id} className="machine" data-device={m.id}>
            <div className="machine-row" title={`${m.label} · ${platformName(m.platform)}`}>
              <span className="machine-dot" aria-hidden="true" />
              <span className="machine-name truncate">{m.label}</span>
              <span className="machine-platform">{platformName(m.platform)}</span>
            </div>
            {m.status === null ? (
              <p className="sidebar-note machine-note">Waiting for it to say what it runs…</p>
            ) : !m.status.open ? (
              <p className="sidebar-note machine-note">Not sharing its sessions. Tick “Let my other devices see and open my sessions” in Settings › Account &amp; sync there.</p>
            ) : m.status.sessions.length === 0 ? (
              <p className="sidebar-note machine-note">No session running.</p>
            ) : (
              <div className="sessions">
                {m.status.sessions.map((s) => (
                  <button
                    key={s.ptyId}
                    className="session remote-session"
                    data-pty={s.ptyId}
                    aria-current={open.has(`${m.id}\n${s.ptyId}`) ? 'true' : undefined}
                    onClick={() => onOpen(m, s)}
                    title={`Open on this computer: ${s.title ?? s.project} (${s.project}) on ${m.label}. ${m.label} asks first.`}
                  >
                    <span className="session-title">{s.title || s.project || 'Untitled session'}</span>
                    <span className="session-meta">
                      <span className="truncate">{s.project}</span>
                      {STATUS_WORDS[s.status] && (
                        <span className="remote-session-status" data-status={s.status}>
                          {STATUS_WORDS[s.status]}
                        </span>
                      )}
                      {s.context ? (
                        <ContextBar used={s.context.used} limit={s.context.limit} showLabel={false} />
                      ) : (
                        s.lastActivityAt && <span>{relativeTime(s.lastActivityAt)}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
    </section>
  )
}
