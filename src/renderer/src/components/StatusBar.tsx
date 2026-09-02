import type { CliInfo, ContextSnapshot } from '@shared/types'
import { ContextBar } from './ContextMeter'
import { modelLabel, shortPath } from '../lib/format'
import { PERMISSION_LABELS } from '../lib/permissions'
import { versionNumber, type RelaunchPlan } from '../lib/tabs'
import type { SessionActivity, Tab } from '../types'

interface Props {
  tab: Tab | null
  context: ContextSnapshot | null
  /** Working / done / attention for the tab in front, or null when idle. */
  activity: SessionActivity | null
  /**
   * The tab in front's own statusLine payload: the version it runs and the
   * model it is on, with the tier suffix the transcript drops (gotcha 21).
   */
  line: { cliVersion: string | null; modelId: string | null; modelName: string | null } | null
  cli: CliInfo | null
  /** Newer CLI version found at launch, or null when up to date. */
  updateAvailable: string | null
  /**
   * Whether the session in front is running a `claude` that is no longer the
   * one installed — and if not, why not.
   *
   * A plan rather than a boolean because the refusals are worth saying. Once
   * the CLI updates under an open session there is nothing on screen that says
   * so: the chat keeps working, on the old binary, indefinitely. This is the
   * only place that gap is visible.
   */
  relaunch: RelaunchPlan
  /** A relaunch is in flight: the pill says so and refuses a second press. */
  relaunchBusy: boolean
  onRelaunch: () => void
  /**
   * The profile the sidebar is filtered to, or null for All.
   *
   * Named, not merely coloured, and here rather than only on the sidebar chip:
   * the profile follows the active tab now, so it changes without anyone
   * pressing anything, and the sidebar can be closed. Colour cannot carry it —
   * verify:profiles measures Ember's accent as identical to Personal's and
   * Moss's as 0.049 from Work's, inside the palette's own 0.083 "same colour"
   * band.
   */
  profileLabel: string | null
  onRevealProject: (path: string) => void
  onOpenSettings: () => void
}

export function StatusBar({
  tab,
  context,
  activity,
  line,
  cli,
  updateAvailable,
  relaunch,
  relaunchBusy,
  onRelaunch,
  profileLabel,
  onRevealProject,
  onOpenSettings
}: Props): React.JSX.Element {
  /*
   * Named for what it does to the conversation, not to the process. "Restart"
   * is the word for the thing people are afraid of here — losing the chat —
   * and the whole point is that the chat survives, so the tooltip says so
   * before anyone has to find out by pressing it.
   *
   * It also says what is NOT kept. Completed messages are on disk in the
   * transcript and `--resume` replays them; a turn that is mid-flight when the
   * process dies is gone, and so is anything typed but not sent. Both are
   * cheap to state and expensive to discover.
   */
  /*
   * Busy is checked BEFORE the plan, not folded into it as a disabled state.
   *
   * Mid-relaunch the old process is dead and the replacement tab has not landed
   * yet, so `relaunchPlan` can legitimately read `none` for a frame or two —
   * "no session in front", or a session that has not reported its version yet.
   * Gating on the plan alone therefore made the pill vanish at exactly the
   * moment it was doing something, which reads as the click having dismissed it
   * rather than started anything.
   */
  const relaunchPill = relaunchBusy ? (
    <button
      className="status-btn"
      disabled
      title="Stopping this session and resuming it on the installed version…"
    >
      <span className="pill" data-tone="accent">
        relaunching…
      </span>
    </button>
  ) : relaunch.kind === 'offer' ? (
    <button
      className="status-btn"
      onClick={onRelaunch}
      title={
        `This session is running ${relaunch.running}; ${relaunch.installed} is installed. ` +
        'Relaunching resumes the same conversation on the new version. ' +
        'Anything mid-reply, or typed and not sent, is lost.'
      }
    >
      <span className="pill" data-tone="accent">
        relaunch on {relaunch.installed}
      </span>
    </button>
  ) : null
  const updatePill = updateAvailable ? (
    <button
      className="status-btn"
      onClick={onOpenSettings}
      title={`Claude Code ${updateAvailable} is available — open Settings to update`}
    >
      <span className="pill" data-tone="accent">
        {updateAvailable} available
      </span>
    </button>
  ) : null

  /*
   * No colour of its own: `applyAppearance` writes the active profile's accent
   * over --accent and --accent-soft, so data-tone="accent" is already this
   * profile's colour, and stays right when there is no profile to override it.
   */
  const profilePill = profileLabel ? (
    <span
      className="pill"
      data-tone="accent"
      title={`Profile: ${profileLabel} — follows the folder of the tab in front`}
    >
      {profileLabel}
    </span>
  ) : null

  /*
   * A version, when one is known, in every branch. `versionNumber` strips the
   * `(Claude Code)` tail `claude --version` prints. With a tab in front the
   * session's own reading wins over the disk's, because they differ exactly
   * when the relaunch pill is about to say so.
   */
  const shownVersion = versionNumber(line?.cliVersion ?? null) ?? versionNumber(cli?.version ?? null)
  const versionItem = shownVersion ? (
    <button
      className="status-btn status-item mono"
      onClick={onOpenSettings}
      title={
        relaunch.kind === 'offer'
          ? `This session runs ${relaunch.running}; ${relaunch.installed} is installed`
          : line?.cliVersion
            ? 'Claude Code version this session is running'
            : 'Claude Code version installed'
      }
    >
      {shownVersion}
    </button>
  ) : null

  // A New tab has no session behind it, so it gets the same footer as no tab
  // at all — "waiting for first turn…" on a launcher was a promise about a
  // turn that could not come.
  if (!tab || tab.kind === 'new') {
    return (
      <footer className="statusbar">
        <span className="status-item">No active session</span>
        {profilePill}
        <span className="status-spacer" />
        {/* Carried here too: a relaunch kills its session before the
            replacement lands, and for those frames there is no active tab at
            all. Without this the "relaunching…" pill would blink out on the
            one path that reaches this branch. */}
        {relaunchPill}
        {updatePill}
        {versionItem}
      </footer>
    )
  }

  const bypass = tab.permissionMode === 'bypassPermissions'
  /*
   * The payload's model first: it carries the tier suffix (`claude-opus-5[1m]`)
   * the transcript drops, and it is stated from the first render rather than
   * after the first assistant turn — so the bar no longer reads `default`
   * until Claude has said something.
   */
  const model = line?.modelId ?? context?.model ?? (tab.model || null)
  /*
   * A paused tab's `context` is seeded at restore with a real saved reading
   * but a zeroed message-count breakdown (`toStored` never persisted one) —
   * see the boot-restore effect in App.tsx. `tab.status` is the single field
   * that carries "paused" (TabIndicator reads the same field the same way);
   * this derives a local boolean from it once rather than repeating the
   * `=== 'paused'` comparison at each render site below.
   */
  const paused = tab.status === 'paused'

  return (
    <footer className="statusbar">
      {/*
        The one item allowed to shrink. Everything else in this bar is a fixed
        few characters; the path is unbounded, so when the window is narrow it
        is the path that must give way — otherwise it pushes the context meter
        and the relaunch pill off the end of a bar that is `overflow: hidden`,
        and the two things you most need to see are the two that leave.
      */}
      <button
        className="status-btn status-item status-shrink mono"
        onClick={() => onRevealProject(tab.cwd)}
        title={`Open ${tab.cwd}`}
      >
        {shortPath(tab.cwd, 52)}
      </button>

      {profilePill}

      <span className="pill" data-tone={bypass ? 'danger' : undefined}>
        {PERMISSION_LABELS[tab.permissionMode]}
      </span>

      {/*
        Only when a model was actually chosen. `modelLabel(null)` is the word
        "default", which is not a fact about this session — it is the absence of
        one, printed in the row where every other item is something you set.
      */}
      {model && <span className="status-item">{modelLabel(model)}</span>}

      {tab.effort !== 'default' && <span className="status-item">effort: {tab.effort}</span>}

      {/*
        The one line that says whether it is your move. From the CLI's own
        hooks, so it is right the moment the turn ends rather than a poll
        later; `working` carries a pulse so a long turn does not read as hung.
      */}
      {activity && tab.status === 'running' && (
        <span
          className="status-item status-activity status-shrink"
          data-state={activity.state}
        >
          <span className="status-activity-dot" aria-hidden="true" />
          {activity.state === 'working'
            ? 'Claude is working…'
            : activity.state === 'done'
              ? 'Finished — your move'
              : (activity.message ?? 'Needs your attention')}
        </span>
      )}

      <span className="status-spacer" />

      {/*
        Before the update pill, and they are not the same thing. "2.1.251
        available" means something newer exists that is not installed;
        "relaunch on 2.1.251" means it IS installed and this session is still
        on the old one. They are consecutive states rather than alternatives —
        an automatic update turns the first into the second — which is why
        both live here and neither is drawn as the other.
      */}
      {versionItem}

      {relaunchPill}

      {updatePill}

      {context?.ready ? (
        <>
          {/*
           * A restored snapshot's messageCount is always 0 — genuinely
           * unrestorable, not a real count of zero — so stating it here
           * would read as "this session had no turns," which is false for
           * every paused tab that ever ran. Suppressed rather than guessed.
           */}
          {!paused && <span className="status-item">{context.messageCount} msgs</span>}
          <span
            className="status-item"
            title={paused ? 'Context window used when last active' : 'Context window in use'}
          >
            <ContextBar used={context.contextTokens} limit={context.contextLimit} paused={paused} />
          </span>
        </>
      ) : (
        <span className="status-item">waiting for first turn…</span>
      )}
    </footer>
  )
}
