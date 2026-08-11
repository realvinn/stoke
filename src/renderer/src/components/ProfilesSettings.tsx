import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProfileConfig, Settings } from '@shared/types'
import type { CreateProfileInput, ProfilePlan, ResolvedProfile } from '@shared/profiles'
import {
  PROFILE_SWATCHES,
  describePlan,
  foldGroup,
  folderName,
  resolveProfiles,
  visibleProfiles
} from '@shared/profiles'
import { IconClose, IconFolder, IconPlus } from './Icons'

/**
 * The profile bridge, typed here rather than in `@shared/api`.
 *
 * Two calls have to happen in the main process, because both touch the disk:
 * working out what a folder+name would do, and doing it. Everything else — the
 * folder picker, saving the record — already has an IPC route.
 *
 * It is read defensively so that a build where the bridge has not been wired up
 * shows a plain message instead of throwing `undefined is not a function` at the
 * user mid-flow. `window.stoke` is frozen by contextBridge, so this cannot be
 * stubbed from the page and there is no point trying.
 */
interface ProfilesBridge {
  plan(folder: string, name: string): Promise<ProfilePlan>
  create(input: CreateProfileInput): Promise<Settings>
}

const bridge: ProfilesBridge | null =
  (window.stoke as unknown as { profiles?: ProfilesBridge }).profiles ?? null

interface Props {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
  /**
   * Called once a profile has actually been created on disk. `profiles.create`
   * writes a new scan root whose projects have not been scanned yet, so
   * something has to ask for a fresh project list afterwards — the main
   * process has no listener-less broadcast to do it for us (see the comment
   * on `CH.profilesCreate` in `src/main/index.ts`). The caller passes its own
   * `refreshProjects`, the same one `openFolder` and `addRoot` already call in
   * `App.tsx`.
   */
  onCreated: () => void | Promise<void>
}

interface Draft {
  name: string
  folder: string
  swatch: string
}

const EMPTY_DRAFT: Draft = { name: '', folder: '', swatch: PROFILE_SWATCHES[0].id }

/** A colour row. The only way a profile is ever assigned a colour. */
function Swatches({
  value,
  onPick,
  label
}: {
  value: string
  onPick: (s: (typeof PROFILE_SWATCHES)[number]) => void
  label: string
}): React.JSX.Element {
  return (
    <div className="profiles" role="group" aria-label={label}>
      {PROFILE_SWATCHES.map((s) => (
        <button
          key={s.id}
          className="profile-chip"
          aria-pressed={value.toLowerCase() === s.accent.toLowerCase()}
          title={s.name}
          onClick={() => onPick(s)}
          style={
            {
              '--chip': s.accent,
              '--chip-ink': s.accentContrast,
              '--chip-second': s.accent
            } as React.CSSProperties
          }
        >
          {s.name}
        </button>
      ))}
    </div>
  )
}

export function ProfilesSettings({ settings, onPatch, onCreated }: Props): React.JSX.Element {
  /*
   * Counts come from the same project list the sidebar uses, fetched here rather
   * than passed in: this component is dropped into the settings sheet, which
   * carries settings and nothing else, and the alternative is threading projects
   * through two components that have no other use for them.
   */
  const [counts, setCounts] = useState<Map<string, number>>(new Map())
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [plan, setPlan] = useState<ProfilePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Renaming is a local draft, committed on blur — see the comment on rename. */
  const [labels, setLabels] = useState<Record<string, string>>({})

  useEffect(() => {
    void window.stoke.projects.list().then((list) => {
      const next = new Map<string, number>()
      for (const p of list) next.set(p.group, (next.get(p.group) ?? 0) + 1)
      setCounts(next)
    })
  }, [settings.projectRoots, settings.profiles])

  const resolved = useMemo(
    () => resolveProfiles(counts, settings.profiles),
    [counts, settings.profiles]
  )
  const visible = useMemo(
    () => visibleProfiles(resolved, counts, settings.projectRoots),
    [resolved, counts, settings.projectRoots]
  )
  const visibleIds = useMemo(
    () => new Set(visible.map((p) => foldGroup(p.id))),
    [visible]
  )
  /** Records that resolve to nothing here: deleted seeds, or another machine's. */
  const dormant = useMemo(
    () => resolved.filter((p) => !visibleIds.has(foldGroup(p.id))),
    [resolved, visibleIds]
  )

  const projectsIn = useCallback(
    (p: ResolvedProfile): number => {
      let n = 0
      for (const [group, c] of counts) {
        if (p.groups.some((g) => foldGroup(g) === foldGroup(group))) n += c
      }
      return n
    },
    [counts]
  )

  /** Write one record, replacing any existing one with the same id. */
  const store = useCallback(
    (profile: ResolvedProfile, changes: Partial<ProfileConfig>): void => {
      const key = foldGroup(profile.id)
      const record: ProfileConfig = {
        id: profile.id,
        groups: profile.groups,
        label: profile.label,
        accent: profile.accent,
        accentHover: profile.accentHover,
        accentSoft: profile.accentSoft,
        accentContrast: profile.accentContrast,
        createdByUser: profile.createdByUser,
        ...changes
      }
      const rest = settings.profiles.filter((p) => foldGroup(p.id) !== key)
      onPatch({ profiles: [...rest, record] })
    },
    [settings.profiles, onPatch]
  )

  /*
   * Deleting has two shapes, because a derived profile is not stored anywhere to
   * remove. A user-made record is dropped outright; a derived one is remembered
   * as a record covering no groups, which renders nothing and — the point —
   * stops the folder layout re-deriving it on the next launch. Restoring it is
   * dropping that record again.
   */
  const remove = useCallback(
    (profile: ResolvedProfile): void => {
      const key = foldGroup(profile.id)
      const rest = settings.profiles.filter((p) => foldGroup(p.id) !== key)
      const derived = resolveProfiles(counts, []).some((p) => foldGroup(p.id) === key)
      if (!derived) {
        onPatch({ profiles: rest })
        return
      }
      onPatch({
        profiles: [
          ...rest,
          {
            id: profile.id,
            groups: [],
            label: profile.label,
            accent: profile.accent,
            accentHover: profile.accentHover,
            accentSoft: profile.accentSoft,
            accentContrast: profile.accentContrast
          }
        ]
      })
    },
    [settings.profiles, counts, onPatch]
  )

  const restore = useCallback(
    (profile: ResolvedProfile): void => {
      const key = foldGroup(profile.id)
      onPatch({ profiles: settings.profiles.filter((p) => foldGroup(p.id) !== key) })
    },
    [settings.profiles, onPatch]
  )

  /* ----------------------------------------------------------- the creator */

  // Re-plan whenever either half of the answer changes. Debounced because the
  // name is typed and each keystroke would otherwise stat the disk.
  useEffect(() => {
    if (!creating || !bridge || !draft.folder || !draft.name.trim()) {
      setPlan(null)
      return
    }
    let cancelled = false
    const id = window.setTimeout(() => {
      void bridge
        .plan(draft.folder, draft.name)
        .then((p) => {
          if (!cancelled) setPlan(p)
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [creating, draft.folder, draft.name])

  const chooseFolder = useCallback(async (): Promise<void> => {
    const dir = await window.stoke.pickFolder()
    if (dir) setDraft((d) => ({ ...d, folder: dir }))
  }, [])

  const create = useCallback(async (): Promise<void> => {
    if (!bridge || !plan || plan.error) return
    const swatch = PROFILE_SWATCHES.find((s) => s.id === draft.swatch) ?? PROFILE_SWATCHES[0]
    setBusy(true)
    setError(null)
    try {
      await bridge.create({
        folder: draft.folder,
        name: draft.name.trim(),
        accent: swatch.accent,
        accentHover: swatch.accentHover,
        accentSoft: swatch.accentSoft,
        accentContrast: swatch.accentContrast
      })
      setCreating(false)
      setDraft(EMPTY_DRAFT)
      setPlan(null)
      // The new root's projects do not exist in the sidebar's list until this
      // resolves - see the comment on the `onCreated` prop above.
      await onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [plan, draft, onCreated])

  const preview = plan ? describePlan(plan) : null

  return (
    <div className="field">
      <span className="field-label">Profiles</span>
      <span className="field-hint">
        A profile is a colour and a folder. Picking one in the sidebar shows the projects
        inside that folder and repaints the accent — it never hides anything from Claude, and
        you can still open any directory or resume any chat from any profile.
      </span>

      {visible.length === 0 && (
        <span className="field-hint">
          None yet. Profiles appear on their own once a scanned folder holds more than one
          project, or you can make one below.
        </span>
      )}

      {visible.map((p) => {
        const n = projectsIn(p)
        return (
          <div
            key={p.id}
            className="field"
            style={{
              gap: 'var(--space-8)',
              padding: 'var(--space-8)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
              {/* The colour, shown the way the tab strip and the theme picker
                  already show one: a dot, not a stripe down the card. */}
              <span
                aria-hidden="true"
                style={{
                  width: '0.5rem',
                  height: '0.5rem',
                  flexShrink: 0,
                  borderRadius: 'var(--r-full)',
                  background: p.accent
                }}
              />
              {/*
                A local draft, committed on blur or Enter. A settings write is a
                round trip through the main process, and a controlled input fed
                straight from it drops characters typed while the write is in
                flight.
              */}
              <input
                className="input"
                aria-label={`Name of the ${p.label} profile`}
                value={labels[p.id] ?? p.label}
                spellCheck={false}
                onChange={(e) => setLabels((l) => ({ ...l, [p.id]: e.target.value }))}
                onBlur={() => {
                  const next = (labels[p.id] ?? p.label).trim()
                  setLabels((l) => {
                    const { [p.id]: _drop, ...rest } = l
                    return rest
                  })
                  if (next && next !== p.label) store(p, { label: next })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
              {confirming === p.id ? (
                <>
                  <button
                    className="btn"
                    data-variant="danger"
                    onClick={() => {
                      remove(p)
                      setConfirming(null)
                    }}
                  >
                    Delete
                  </button>
                  <button className="btn" data-variant="ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button
                  className="icon-btn"
                  data-size="sm"
                  title={`Delete the ${p.label} profile`}
                  onClick={() => setConfirming(p.id)}
                >
                  <IconClose />
                  <span className="sr-only">Delete {p.label}</span>
                </button>
              )}
            </div>

            <Swatches
              value={p.accent}
              label={`Colour for ${p.label}`}
              onPick={(s) =>
                store(p, {
                  accent: s.accent,
                  accentHover: s.accentHover,
                  accentSoft: s.accentSoft,
                  accentContrast: s.accentContrast
                })
              }
            />

            <span className="field-hint">
              <span className="mono">{p.groups.join(', ') || 'no folder'}</span>
              {' · '}
              {n === 1 ? '1 project' : `${n} projects`}
              {p.createdByUser ? ' · yours' : ''}
            </span>
          </div>
        )
      })}

      {dormant.length > 0 && (
        <div className="field" style={{ gap: 'var(--space-8)' }}>
          <span className="field-hint">
            Not showing here. A deleted profile is remembered so the folder layout does not
            re-derive it, and a profile whose folders live on another computer is kept for that
            computer — opening Settings here must not quietly erase it there.
          </span>
          {dormant.map((p) => {
            const deleted = p.groups.length === 0
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                <span className="mono truncate" style={{ flex: 1, fontSize: 'var(--fs-xs)' }}>
                  {p.label} — {deleted ? 'deleted' : p.groups.join(', ')}
                </span>
                {/* Only a deletion is undoable from here. The other kind belongs
                    to a machine this one cannot see, so there is nothing to
                    restore and dropping the record would be the destructive act,
                    not the safe one. */}
                {deleted && (
                  <button className="btn" data-variant="ghost" onClick={() => restore(p)}>
                    Restore
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {error && (
        <span className="field-hint" data-tone="warning">
          {error}
        </span>
      )}

      {!creating && (
        <button className="btn" onClick={() => setCreating(true)}>
          <IconPlus />
          New profile
        </button>
      )}

      {creating && (
        <div
          className="field"
          style={{
            gap: 'var(--space-8)',
            padding: 'var(--space-8)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)'
          }}
        >
          <input
            className="input"
            placeholder="Name, e.g. Task"
            aria-label="New profile name"
            value={draft.name}
            spellCheck={false}
            autoFocus
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
            <input
              className="input mono"
              placeholder="Folder to keep it in"
              aria-label="New profile folder"
              value={draft.folder}
              spellCheck={false}
              onChange={(e) => setDraft((d) => ({ ...d, folder: e.target.value }))}
            />
            <button className="btn" onClick={() => void chooseFolder()}>
              <IconFolder />
              Choose
            </button>
          </div>

          <Swatches
            value={
              (PROFILE_SWATCHES.find((s) => s.id === draft.swatch) ?? PROFILE_SWATCHES[0]).accent
            }
            label="Colour for the new profile"
            onPick={(s) => setDraft((d) => ({ ...d, swatch: s.id }))}
          />

          {/*
            The preview is the whole point of this form. Picking G:/Code and
            typing Task can mean three different things on disk, and the user
            gets told which one before anything is written.
          */}
          {!bridge && (
            <span className="field-hint" data-tone="warning">
              Profile creation is unavailable in this build — the main process has no profile
              bridge, so nothing can be written to disk.
            </span>
          )}
          {bridge && preview && (
            <span className="field-hint" data-tone={plan?.error ? 'warning' : undefined}>
              {preview}
              {plan && !plan.error && plan.imports.length > 0 && (
                <>
                  <br />
                  <span className="mono">{plan.imports.slice(0, 8).join(', ')}</span>
                  {plan.imports.length > 8 ? ` +${plan.imports.length - 8} more` : ''}
                </>
              )}
              {plan && !plan.error && (
                <>
                  <br />
                  Projects will show under the profile <b>{draft.name.trim()}</b>, matching the
                  folder <span className="mono">{folderName(plan.root)}</span>.
                </>
              )}
            </span>
          )}
          {bridge && !preview && (
            <span className="field-hint">
              Pick a folder and give the profile a name to see what will happen.
            </span>
          )}

          <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
            <button
              className="btn"
              data-variant="primary"
              disabled={busy || !bridge || !plan || Boolean(plan.error)}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : 'Create profile'}
            </button>
            <button
              className="btn"
              data-variant="ghost"
              onClick={() => {
                setCreating(false)
                setDraft(EMPTY_DRAFT)
                setPlan(null)
                setError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
