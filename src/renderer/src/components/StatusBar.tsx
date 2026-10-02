import { capsFor, cliFor, cliIdOf, isClaudeCode } from '@shared/codingClis'
import type { CliInfo, ContextSnapshot } from '@shared/types'
import type { RemoteSessionStatus } from '@shared/hub/remote'
import { clock, countdown, remainingLabel, shortLabel, tone } from '@shared/usageView'
import { ContextBar } from './ContextMeter'
import { modelLabel, shortPath } from '../lib/format'
import { PERMISSION_LABELS } from '../lib/permissions'
import { MODE_LABELS, sessionMode } from '@shared/launch'
import { folderMenuEntry, openableFolder, versionNumber, type RelaunchPlan } from '../lib/tabs'
import { agentMark } from '../lib/agentColor'
import type { ActivityView } from '@shared/activityView'
import type { Tab } from '../types'

interface Props {
  tab: Tab | null
  context: ContextSnapshot | null
  /**
   * What the tab in front's activity line says — working, background work,
   * waiting for you, done — decided by `activityView`, the same reading the
   * tab strip's dot is drawn from. Null for a tab with no session.
   */
  activity: ActivityView | null
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
   * The tab in front will be relaunched the moment its running turn ends
   * ("Wait" in the busy dialog, or an automatic relaunch queued for it). The
   * pill says so and a press cancels it — a relaunch that fires later with
   * nothing on screen saying it was coming would read as a crash.
   */
  relaunchPending: boolean
  onCancelRelaunch: () => void
  /** Stoke restarts to install its own update once every session is idle. */
  selfRestartPending: boolean
  onCancelSelfRestart: () => void
  /**
   * The running binary's version from the CLI's own registry, when it has
   * said. Preferred over the payload's: it is stated from the first second.
   */
  liveVersion: string | null
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
  /**
   * The mode Claude Code's own settings name (`permissions.defaultMode`) for
   * the tab's folder, for a tab launched with no `--permission-mode`. Null when
   * no file sets one; undefined while that folder's answer has not arrived.
   */
  claudeDefaultMode?: string | null
  /**
   * A remote tab's session as its own machine's status bar reads it — model,
   * effort, context and its account's plan-limit windows — sent over the
   * relay for that session only (`RemoteSessionStatus`). Null until the
   * other machine has said, or for a host that sends none.
   */
  remoteSession?: RemoteSessionStatus | null
}

/**
 * Another machine's session, said the way a local tab's is: its model and
 * effort, its context bar, and the plan limits of the account it runs on
 * there — the other machine's figures, which is why the first item names it.
 */
function RemoteSessionItems({ status, device, now }: { status: RemoteSessionStatus; device: string; now: number }): React.JSX.Element {
  const claude = isClaudeCode(cliIdOf(status.agent))
  const asOf = status.usageAt !== null ? clock(status.usageAt) : null
  return (
    <>
      {status.model && (
        <span className="status-item" title={`${status.model}, on ${device}`} data-remote-item="model" {...agentMark(cliIdOf(status.agent))}>
          <span className="agent-dot" aria-hidden="true" />
          {claude ? modelLabel(status.model) : status.model}
        </span>
      )}
      {status.effort && (
        <span className="status-item" data-remote-item="effort">
          effort: {status.effort}
        </span>
      )}
      <span className="status-spacer" />
      {status.usage.length > 0 && (
        <span
          className="status-item status-usage"
          data-remote-item="usage"
          title={`Plan limits of the account this session runs on, on ${device}${asOf ? `, as of ${asOf}` : ''}`}
        >
          {status.usage.map((w) => (
            <span className="status-usage-row" data-tone={tone(w)} key={`${w.kind}-${w.label}`}>
              <span className="usage-mini-label">{shortLabel(w)}</span>
              <span className="usage-track usage-mini-track" data-tone={tone(w)} style={{ '--usage-fill': w.percent / 100 } as React.CSSProperties}>
                <span className="usage-fill" />
              </span>
              <span>{remainingLabel(w)}</span>
              {w.kind === 'session' && <span className="usage-mini-reset">{countdown(w.resetsAt, w.percent, now)}</span>}
            </span>
          ))}
        </span>
      )}
      {status.context && (
        <span className="status-item" title={`Context window in use, on ${device}`} data-remote-item="context">
          <ContextBar used={status.context.used} limit={status.context.limit} />
        </span>
      )}
    </>
  )
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
  relaunchPending,
  onCancelRelaunch,
  selfRestartPending,
  onCancelSelfRestart,
  liveVersion,
  profileLabel,
  onRevealProject,
  onOpenSettings,
  claudeDefaultMode,
  remoteSession = null
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
  ) : relaunchPending ? (
    <button
      className="status-btn"
      onClick={onCancelRelaunch}
      title="Relaunching as soon as the prompt that is running finishes. Click to cancel."
    >
      <span className="pill" data-tone="accent">
        relaunch when idle… <span aria-hidden="true">×</span>
        <span className="sr-only">cancel</span>
      </span>
    </button>
  ) : relaunch.kind === 'offer' ? (
    <button
      className="status-btn"
      onClick={onRelaunch}
      title={
        `This session is running ${relaunch.running}; ${relaunch.installed} is installed. ` +
        (relaunch.fresh
          ? 'Nothing has been said in it yet, so it starts again empty on the new version. '
          : 'Relaunching resumes the same conversation on the new version. ') +
        (relaunch.busy
          ? 'A prompt is running — you will be asked whether to wait for it.'
          : 'Anything typed and not sent is lost.')
      }
    >
      <span className="pill" data-tone="accent">
        relaunch on {relaunch.installed}
      </span>
    </button>
  ) : null
  const selfRestartPill = selfRestartPending ? (
    <button
      className="status-btn"
      onClick={onCancelSelfRestart}
      title="Stoke restarts to install its update once every session is idle. Click to cancel."
    >
      <span className="pill" data-tone="accent">
        update when idle… <span aria-hidden="true">×</span>
        <span className="sr-only">cancel</span>
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
  /*
   * Both sources here are Claude Code's, so neither may be shown beside a
   * session that is not Claude Code.
   *
   * `line.cliVersion` comes from a statusLine payload, which only an
   * instrumented Claude session writes — so on a Codex tab it is null and the
   * fallback took over, printing the local `claude --version` under the
   * tooltip "Claude Code version installed". A true sentence about the machine,
   * rendered as if it described the session in front of it, which is the exact
   * shape this project treats as worse than showing nothing.
   */
  // An install tab carries its first agent as `cliId` — which can be Claude
  // Code — but it is a shell running installers, not a session: none of the
  // session items below describe it (found by review).
  // An "Add key to …" tab is the same: ssh-copy-id in a terminal, no session.
  const installTab = !!tab?.installing?.length || !!tab?.enrollHostId
  const claudeTab = !installTab && isClaudeCode(cliIdOf(tab?.cliId))
  const shownVersion = claudeTab
    ? (versionNumber(liveVersion) ??
      versionNumber(line?.cliVersion ?? null) ??
      versionNumber(cli?.version ?? null))
    : null
  const versionItem = shownVersion ? (
    <button
      className="status-btn status-item mono"
      onClick={onOpenSettings}
      title={
        relaunch.kind === 'offer'
          ? `This session runs ${relaunch.running}; ${relaunch.installed} is installed`
          : liveVersion || line?.cliVersion
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
  if (tab?.kind === 'remote') {
    const device = tab.remote?.deviceLabel ?? 'another machine'
    return (
      <footer className="statusbar" data-remote-status={remoteSession ? 'on' : 'off'}>
        {/* Another machine's session: what its own status bar says, named as
            that machine's — nothing here is claimed for this one. */}
        <span className="status-item" title="Another machine’s session, through your hub">
          On {device}
        </span>
        {profilePill}
        {remoteSession ? (
          <RemoteSessionItems status={remoteSession} device={device} now={Date.now()} />
        ) : (
          <>
            <span className="status-item">another machine’s session</span>
            <span className="status-spacer" />
          </>
        )}
        {relaunchPill}
        {selfRestartPill}
        {updatePill}
      </footer>
    )
  }

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
        {selfRestartPill}
        {updatePill}
        {versionItem}
      </footer>
    )
  }

  /*
   * The mode it is actually in (`sessionMode`): the transcript's word once
   * there is one, else the flag, else — for a no-flag tab — the settings
   * default. The danger tone reads the same value, so a no-flag tab running
   * as bypassPermissions from settings is marked as one.
   */
  const mode = sessionMode({
    reported: context?.permissionMode ?? null,
    launched: tab.permissionMode,
    claudeDefault: claudeDefaultMode
  })
  const bypass = mode === 'bypassPermissions'
  const caps = capsFor(cliIdOf(tab.cliId))
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
  const folder = openableFolder(tab)
  // Why not, in the tab menu's own words ("This session runs on vps; …").
  const folderEntry = folder ? null : folderMenuEntry(tab, null)
  const noFolder = folderEntry && 'reason' in folderEntry ? folderEntry.reason : null

  return (
    <footer className="statusbar">
      {/*
        The one item allowed to shrink. Everything else in this bar is a fixed
        few characters; the path is unbounded, so when the window is narrow it
        is the path that must give way — otherwise it pushes the context meter
        and the relaunch pill off the end of a bar that is `overflow: hidden`,
        and the two things you most need to see are the two that leave.
      */}
      {/*
        Clickable only where there is a folder HERE to open — the rule the tab
        menu's folder item reads (`openableFolder`). An SSH tab's cwd is the
        host alias (gotcha 18), and this button used to hand `vps` to
        `shell.openPath`: a click that promised a folder and opened nothing.
      */}
      {folder ? (
        <button
          className="status-btn status-item status-shrink mono"
          onClick={() => onRevealProject(folder)}
          title={`Open ${folder}`}
        >
          {shortPath(tab.cwd, 52)}
        </button>
      ) : tab.private ? (
        /* Not the scratch folder's uuid path: it is no place of the user's (PRIVATE_FOLDER_TEXT). */
        <span className="status-item status-shrink status-static" title={noFolder ?? undefined}>
          Temporary folder
        </span>
      ) : (
        <span className="status-item status-shrink status-static mono" title={noFolder ?? tab.cwd}>
          {shortPath(tab.cwd, 52)}
        </span>
      )}

      {profilePill}

      {/*
        Claude Code's three launch flags, and only for a session that was given
        them.

        `--permission-mode`, `--model` and `--effort` are `buildArgs` output, so
        on a CLI Stoke launches bare they describe nothing: the pill read "Ask"
        beside a Codex session, which is a specific and wrong claim about how
        that session handles tool use. `capsFor` is the same table that decided
        not to pass the flags, so the display cannot drift from the launch.
      */}
      {!installTab && caps.launchFlags.permissionMode && mode && (
        <span className="pill" data-tone={bypass ? 'danger' : undefined}>
          {/* A tab launched with no flag runs in whatever mode the user's
              settings name: the pill said "Ask" while the TUI beside it said
              "auto mode on" (QA L11), until the first turn wrote the real one
              into the transcript. */}
          {PERMISSION_LABELS[mode as keyof typeof PERMISSION_LABELS] ?? MODE_LABELS[mode] ?? mode}
        </span>
      )}

      {/*
        Only when a model was actually chosen. `modelLabel(null)` is the word
        "default", which is not a fact about this session — it is the absence of
        one, printed in the row where every other item is something you set.
      */}
      {/*
        Marked with the tab's agent, so while more than one agent is in view
        the model carries the same colour as the tab's tag and its pane's rule —
        whose model this is, at a glance.
      */}
      {/*
        Another agent's model is shown as it was typed and passed: `modelLabel`
        reads Claude Code's ids (`claude-opus-5[1m]` -> "Opus 5 · 1M"), and
        turned Codex's `gpt-6.1-sol` into "Gpt" when it was first driven.
      */}
      {!installTab && caps.launchFlags.model && model && (
        <span className="status-item" title={model} {...agentMark(cliIdOf(tab.cliId))}>
          <span className="agent-dot" aria-hidden="true" />
          {claudeTab ? modelLabel(model) : model}
        </span>
      )}

      {!installTab && caps.launchFlags.effort && tab.effort !== 'default' && (
        <span className="status-item">effort: {tab.effort}</span>
      )}

      {/*
        The one line that says whether it is your move. From the CLI's own
        hooks and its session registry together (activityView), so it is right
        the moment a turn ends, stays working while a workflow the turn
        started runs on, and says "Waiting for you" for exactly as long as a
        question is on screen. Working and waiting pulse, so neither a long
        turn nor an unanswered prompt reads as hung.
      */}
      {activity?.dot && tab.status === 'running' && (
        <span
          className="status-item status-activity status-shrink"
          data-state={activity.dot}
          title={activity.detail ? `${activity.label}: ${activity.detail}` : activity.label}
        >
          <span className="status-activity-dot" aria-hidden="true" />
          <span>{activity.label}</span>
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

      {selfRestartPill}

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
      ) : tab.private ? (
        /*
         * A private chat writes no transcript, so the context watcher has
         * nothing to read and "waiting for first turn…" would be a promise
         * that never resolves (shared/privateChat.ts).
         */
        <span className="status-item">Private chat · nothing saved, so no context reading</span>
      ) : claudeTab ? (
        <span className="status-item">waiting for first turn…</span>
      ) : (
        /*
         * Not "waiting for first turn…", which is a promise: it says a reading
         * is coming, and for a session Stoke does not instrument none ever is.
         * The user would watch a status bar that never resolves and reasonably
         * conclude the meter was broken.
         */
        tab.enrollHostId ? (
          <span className="status-item">Setting up key login — the password goes in this tab</span>
        ) : tab.installing?.length ? (
          <span className="status-item">
            Installing {tab.installing.map((id) => cliFor(id).label).join(', ')}
          </span>
        ) : (
          <span
            className="status-item"
            {...agentMark(cliIdOf(tab.cliId))}
            title="Stoke reads context usage from Claude Code's own status line, which this CLI does not write."
          >
            <span className="agent-dot" aria-hidden="true" />
            {cliFor(cliIdOf(tab.cliId)).label} — no context reading
          </span>
        )
      )}
    </footer>
  )
}
