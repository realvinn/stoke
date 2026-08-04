import type { ProfileConfig } from '@shared/types'

interface Props {
  /** The resolved profile list — the same one the sidebar chips are drawn from. */
  profiles: ProfileConfig[]
  /** `Settings.worklogGroups`: the `Project.group` values the agent watches. */
  worklogGroups: string[]
  /** `Settings.worklogAuto`: scan a watched session once it goes quiet. */
  auto: boolean
  /** Called with the whole replacement list; the caller persists it. */
  onChange: (worklogGroups: string[]) => void
  onChangeAuto: (auto: boolean) => void
}

/** Matches `foldGroup` in src/main/worklog/gate.ts — the switch is case-blind. */
const fold = (group: string): string => group.trim().toLowerCase()

/**
 * Which profiles the worklog agent reviews.
 *
 * The stored value is a list of folder groups, not profile ids, because the gate
 * that reads it keys off the *session's* folder rather than whichever profile
 * chip happens to be selected in the sidebar — a Work session keeps being
 * watched while the user browses Personal. This panel is only the switch: it
 * writes group names and nothing else.
 */
export function WorklogSettings({
  profiles,
  worklogGroups,
  auto,
  onChange,
  onChangeAuto
}: Props): React.JSX.Element {
  const watched = new Set(worklogGroups.map(fold).filter(Boolean))

  /*
   * Turning a profile off drops every group it covers; turning it on drops them
   * and re-adds them. Removing first either way is what lets a stale duplicate
   * or a differently-cased leftover from an older write get cleaned up by a
   * single toggle, instead of accumulating invisible entries that keep the agent
   * running after the box looks unticked.
   */
  const setProfile = (groups: string[], on: boolean): void => {
    const mine = new Set(groups.map(fold))
    const rest = worklogGroups.filter((g) => !mine.has(fold(g)))
    onChange(on ? [...rest, ...groups] : rest)
  }

  // Groups that are switched on but belong to no profile — a profile that was
  // renamed or deleted leaves these behind, and they go on costing tokens with
  // no checkbox anywhere to show it.
  const covered = new Set(profiles.flatMap((p) => p.groups.map(fold)).filter(Boolean))
  const orphans = worklogGroups.filter((g) => fold(g) && !covered.has(fold(g)))

  return (
    <div className="field">
      <span className="field-label">
        Worklog agent{' '}
        {watched.size > 0 && (
          <span className="pill" data-tone="accent">
            {watched.size} watched
          </span>
        )}
      </span>
      <span className="field-hint">
        A Sonnet agent reads a session&apos;s transcript, checks what is already on your Notion
        and ClickUp boards, and <strong>proposes</strong> the difference — a new page, a new
        task, or a status change to something already tracked. Nothing is written to either
        until you accept it; Accept all is still you accepting.
      </span>

      {/*
        The switch, not a claim. Auto-scan is on by default but does nothing at
        all until a profile below is ticked, so the two controls read in that
        order: what happens, then where.
      */}
      <label className="check-row">
        <input type="checkbox" checked={auto} onChange={(e) => onChangeAuto(e.target.checked)} />
        <span>
          <span className="field-label">Scan while I work</span>
          <span className="field-hint">
            A watched session is reviewed on its own once it has been quiet for a couple of
            minutes, and Stoke asks whether to file it. Off, and scanning only happens when you
            press Scan in the worklog panel.
          </span>
        </span>
      </label>

      {profiles.length === 0 ? (
        <span className="field-hint">
          No profiles on this machine yet, so there is nothing to watch. Profiles come from the
          folders your projects sit in.
        </span>
      ) : (
        profiles.map((profile) => {
          const groups = profile.groups.filter((g) => g.trim().length > 0)
          const on = groups.some((g) => watched.has(fold(g)))
          const partial = on && !groups.every((g) => watched.has(fold(g)))

          return (
            <label className="check-row" key={profile.id}>
              <input
                type="checkbox"
                checked={on}
                disabled={groups.length === 0}
                ref={(el) => {
                  // A profile can cover several folders with only some of them
                  // on. Show that as the dash state rather than rounding it to a
                  // plain tick, which would claim more than is true.
                  if (el) el.indeterminate = partial
                }}
                onChange={(e) => setProfile(groups, e.target.checked)}
              />
              <span>
                <span
                  className="field-label"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}
                >
                  {/* The profile's own accent, so the row reads as the same
                      thing as its sidebar chip. The colour is data from
                      settings, never a literal in this file. */}
                  <span
                    aria-hidden="true"
                    style={{
                      width: '0.5rem',
                      height: '0.5rem',
                      borderRadius: 'var(--r-full)',
                      background: profile.accent,
                      flexShrink: 0
                    }}
                  />
                  Watch {profile.label}
                </span>
                <span className="field-hint">
                  {groups.length === 0 ? (
                    'This profile covers no folders yet, so there is nothing for the agent to see.'
                  ) : (
                    <>
                      Sessions whose folder sits under{' '}
                      <span className="mono">{groups.join(', ')}</span>, whichever profile you are
                      looking at at the time.
                    </>
                  )}
                  {partial && ' Only some of those folders are on — switch this off and on to cover them all.'}
                </span>
              </span>
            </label>
          )
        })
      )}

      {orphans.length > 0 && (
        <span className="field-hint" data-tone="warning">
          Still watching <span className="mono">{orphans.join(', ')}</span>, which no profile
          covers any more.{' '}
          <button
            className="btn"
            onClick={() => onChange(worklogGroups.filter((g) => !orphans.includes(g)))}
          >
            Stop watching
          </button>
        </span>
      )}

      <span className="field-hint">
        Each review costs tokens: it is a real Claude run on top of the work you just did. It
        uses Sonnet, reads the transcript rather than your repo, and reads your boards at most
        once every ten minutes however many sessions are scanned. Automatic scans are capped at
        six an hour and one per session every twenty minutes — but it is not free, so leave
        profiles you do not report on switched off.
      </span>
    </div>
  )
}
