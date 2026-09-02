import { access } from 'node:fs/promises'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { CH } from '@shared/ipc'
import { activeThemeId, resolveTheme } from '@shared/themes'
import type {
  CliUpdateState,
  LaunchOptions,
  ProjectMeta,
  Rect,
  Settings,
  SshHost,
  StatusLineSnapshot,
  StoredTabs,
  Theme,
  UsageReadReason,
  WorklogScanOutcome,
  WorklogScanReport,
  WorklogWatchState
} from '@shared/types'
import { EmbeddedBrowser } from './browser.ts'
import { clearWallpaper, mimeFor, storeWallpaper, WALLPAPER_SCHEME, wallpaperFileFor } from './wallpaper.ts'
import { probeClaude } from './cli.ts'
import { ContextWatcher } from './context.ts'
import { findSessionFile, listProjects, listSessions } from './projects.ts'
import { IDLE_GAP_MS, readActivity, type ActivitySessionInput } from './activity.ts'
import { commitSubjects } from './activityGit.ts'
import { manualProjectPatch, projectMetaPatch } from './projectMeta.ts'
import { normalizePath, pathRulesFor } from '../shared/paths.ts'
import { keepUsage } from '../shared/statusLine.ts'
import { parseSession, readTranscript } from './sessionFile.ts'
import { fetchRemoteTranscript } from './sshTranscript.ts'
import { PtyManager, type StartResult } from './pty.ts'
import { checkMicrophone } from './audio/defaultDevice.ts'
import { transcribe } from './stt.ts'
import { createProfile, planProfile } from './profiles.ts'
import { readSshConfigHosts } from './ssh.ts'
import { readTabState, tabStateFile, writeTabState } from './tabStore.ts'
import { getWorklogQueue } from './worklog/queue.ts'
import {
  applyProposal,
  scanSession,
  APPLY_MAX_BUDGET_USD,
  WorklogBudgetError,
  WorklogParseError
} from './worklog/runner.ts'
import { groupForCwd, isWatchedGroup } from './worklog/gate.ts'
import { watchStateFrom } from './worklog/watch.ts'
import { AutoScanner } from './worklog/autoscan.ts'
import { autoScanStateFile, readAutoScanState, writeAutoScanState } from './worklog/autoscanStore.ts'
import { readSessionState, sessionStateFile, writeSessionState } from './worklog/sessionStore.ts'
import { invalidateRecall, recall, scanOutcomeFor } from './worklog/recall.ts'
import type { CreateProfileInput } from '@shared/profiles'
import type { CliRunResult, RemoteState } from '@shared/api'
import { flushSettings, getSettings, onSettingsChanged, setSettings } from './store.ts'
import {
  readSessionEvents,
  readStatusLine,
  sweepStaleSessionFiles,
  userStatusLineCommand,
  windowFor,
  writeSessionSettingsFile
} from './statusLine.ts'
import { createScratchDir, resolveDefaultCwd } from './workspace.ts'
import { BrowserMcpServer } from './mcp/server.ts'
import { connectTarget, generateToken, RemoteServer, tailnetAddress, type RemoteDeps } from './remote/server.ts'
import { TunnelManager } from './remote/tunnel.ts'
import {
  originCertPath,
  probeSetup,
  runSetupStep,
  startLogin,
  waitForCert
} from './remote/cloudflare.ts'
import {
  AUTO_CHECK_MS,
  checkForUpdate,
  runDoctor,
  runUpdate,
  shouldAutoUpdate,
  updateApplied,
  type AutoUpdateAttempt,
  type UpdateInfo
} from './updates.ts'
import { fetchUsage, keepLastGood, nextBackoff, type UsageSnapshot } from './usage.ts'
import { patchClaudeSetting, readClaudeSettings, untouchedKeys } from './claudeSettings.ts'
import {
  readGlobalConfigKey,
  releaseHeldLocks,
  writeGlobalConfigKey
} from './claudeGlobalConfig.ts'
import { claudeGlobalConfigPath } from './claudePaths.ts'
import {
  CLAUDE_SETTINGS,
  WORKFLOW_SIZE_KEY,
  validateWorkflowSize,
  type ClaudeSettingValue
} from '../shared/claudeConfig.ts'
import {
  checkSelfUpdate,
  downloadSelfUpdate,
  initSelfUpdate,
  installSelfUpdate,
  selfUpdateState
} from './selfUpdate.ts'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
/** Must match --titlebar-h in app.css, or the overlay and the bar disagree. */
const TITLEBAR_H = 44

let win: BrowserWindow | null = null
let browser: EmbeddedBrowser | null = null
let ptys: PtyManager | null = null
let watcher: ContextWatcher | null = null
let autoscan: AutoScanner | null = null
let mcp: BrowserMcpServer | null = null
/** Path of the generated --mcp-config file; null until the server is up. */
let mcpConfigPath: string | null = null
let remote: RemoteServer | null = null
/**
 * Timers armed by `createWindow`, cleared when that window closes.
 *
 * Everything in here is per-window rather than per-process, because
 * `createWindow` is what arms it and macOS calls that again on `activate`
 * (gotcha 35: closing the last window does not quit). Held in one list so the
 * teardown cannot forget one — a `setInterval` that outlives its window is not
 * merely garbage, it keeps calling `send()` at a window that is gone and, in
 * the CLI-update case, keeps deciding whether to spawn an installer.
 *
 * `clearInterval` cancels a timeout handle too — Node returns the same Timeout
 * object from both — so one loop is enough for both kinds.
 */
const timers: NodeJS.Timeout[] = []
let usageCache: UsageSnapshot | null = null
/**
 * When the endpoint was last actually CALLED, which is not `usageCache.fetchedAt`.
 *
 * They came apart when a failed read stopped throwing the last good numbers
 * away: the cache now keeps the timestamp of the data it holds, so the
 * scheduler needs its own record of when it last knocked, or a stale-but-good
 * reading would look overdue and be re-fetched on every single poll — turning
 * one rate limit into a permanent one.
 */
let usageAttemptedAt = 0
/** The wait currently in force after a failure; 0 whenever the last read worked. */
let usageBackoff = 0
/**
 * The idle refresh interval for the account reading, and the floor a
 * message-triggered one may not go below. The renderer polls on the first and
 * pre-empts with the second; see the `usageRead` handler for why both exist.
 * `POLL_MS` in UsageMeter.tsx is the same 30s from the other side — a shorter
 * interval there would only ever be handed this cache back.
 */
const USAGE_POLL_MS = 30_000
const USAGE_MESSAGE_FLOOR_MS = 5_000

/* ------------------------------------------------- keeping the CLI current */

/** The newest CLI check, shared by the panel and the auto-updater. */
let cliUpdate: UpdateInfo | null = null
/**
 * The last automatic `claude update` attempt and what came of it.
 *
 * Not just a timestamp: `shouldAutoUpdate` needs to know *what* was attempted,
 * because `claude update` follows its own stable channel while the check reads
 * the npm registry, and the two genuinely disagree. See AutoUpdateAttempt.
 */
let cliLastAttempt: AutoUpdateAttempt | null = null
/** What the last automatic attempt did, for the panel to report. */
let cliAutoNote: string | null = null

/**
 * Check the CLI, and install the update if the user has left that on.
 *
 * Deliberately not a wrapper around the Settings panel's own buttons: those are
 * a person deciding, and this is a timer. The difference that matters is the
 * gate — `shouldAutoUpdate` refuses on a *failed* check as well as on a check
 * that found nothing, because `updateAvailable: false` means both "already
 * current" and "the registry could not be reached", and only `error` separates
 * them. Running an installer off a failed check is running it off nothing.
 *
 * Never throws: it is called from a timer with nobody to catch it, and a
 * network blip must not take the main process down.
 */
let cliRefreshing = false

async function refreshCliUpdate(): Promise<void> {
  /*
   * One at a time. The two callers are 12s and six hours apart so an overlap is
   * hard to arrange today, but the body awaits a subprocess with a three-minute
   * timeout and the thing it would run twice is an installer — gotcha 20's
   * shape, with a worse payload than a duplicated scan. Claimed before the
   * first await, which is the half of that gotcha that is easy to get wrong.
   */
  if (cliRefreshing) return
  cliRefreshing = true
  try {
    const settings = getSettings()
    cliUpdate = await checkForUpdate(settings.claudePath)
    send(CH.updateState, cliState())

    const now = Date.now()
    const decision = shouldAutoUpdate(cliUpdate, settings.cliAutoUpdate, cliLastAttempt, now)
    if (!decision.run) return

    const from = cliUpdate.current
    const target = cliUpdate.latest
    const result = await runUpdate(settings.claudePath)
    const applied = updateApplied(result)

    /*
     * Reported as three distinct outcomes, not two. `claude update` exits 0
     * having changed nothing both when it is already current and when it cannot
     * write to the install — so "ok" alone would print "Updated" over a CLI that
     * did not move. `updateApplied` compares the versions read either side of
     * the run, which is what `runUpdate` reads them for.
     *
     * The middle case quotes the CLI rather than paraphrasing it, because the
     * CLI already gives the actual reason and Stoke cannot infer it. Measured
     * here: "You're running 2.1.237, which is newer than the stable channel's
     * 2.1.236. Skipping update." — a complete answer that the previous wording
     * ("Run doctor to see why") threw away in favour of sending the reader
     * somewhere else.
     */
    cliAutoNote = applied
      ? `Updated ${from ?? 'the CLI'} to ${result.to} automatically.`
      : result.ok
        ? `${result.to ?? 'The CLI'} is still what is installed${verdictLine(result.output) ? ` — ${verdictLine(result.output)}` : '.'}`
        : `Automatic update failed: ${result.error ?? 'the command failed.'}`

    // Recorded whatever happened, and only cleared on success: an attempt that
    // achieved nothing is exactly the one that must not be repeated on the next
    // tick, and the record is what tells shouldAutoUpdate that.
    cliLastAttempt = applied ? null : { at: now, target, from, failed: !result.ok }

    // Re-check so the panel's version line reflects what is on disk now rather
    // than what was there before the run.
    cliUpdate = await checkForUpdate(settings.claudePath)
    send(CH.updateState, cliState())
  } catch (err) {
    cliAutoNote = `Automatic update failed: ${err instanceof Error ? err.message : String(err)}`
    send(CH.updateState, cliState())
  } finally {
    cliRefreshing = false
  }
}

/**
 * The CLI's own verdict, which is the LAST line it printed, not the first.
 *
 * `claude update` narrates before it concludes ("Current version: …",
 * "Checking for updates to stable version…"), so the interesting sentence is
 * always at the end. Named for what it means rather than for where it is,
 * because "first line" is what someone would reach for and would be wrong.
 * Kept to one sentence because this lands inside a settings hint, not a log
 * pane; the full output is still available behind the panel's own Update button.
 */
function verdictLine(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  return last.length > 200 ? `${last.slice(0, 197)}…` : last
}

function cliState(): CliUpdateState {
  return { info: cliUpdate, auto: getSettings().cliAutoUpdate, note: cliAutoNote }
}
/**
 * The newest statusLine reading seen this run, whichever session produced it.
 *
 * The rate limits in it are account-wide, so any open session's payload
 * answers for all of them — and keeping one means the usage chip still has
 * figures once every tab is closed, which is the whole "as of HH:MM" case.
 */
let lastStatusLine: StatusLineSnapshot | null = null
/** receivedAt of the last payload pushed per session, so nothing is sent twice. */
const statusLineSeen = new Map<string, number>()

/**
 * Push a session's payload at the renderer, if it has actually changed.
 *
 * This only ever runs from the context watcher's emit callback below, which
 * caps how often it can fire: at most once per POLL_MS (1.5s) per session,
 * and only when the *transcript's* mtime has moved. The payload file itself
 * is rewritten roughly three times a second by the CLI, but that cadence
 * never reaches this function — by the time a call gets here, at least 1.5s
 * has usually passed since the last one, which is long enough that the
 * payload has almost always been rewritten too. So the `receivedAt` guard
 * below suppresses close to nothing in practice; it stays because "almost
 * always" is not "always" — a watcher publish can still land between two
 * identical renders — and it is what keeps a caller from ever seeing the
 * same `receivedAt` sent twice.
 */
function pushStatusLine(sessionId: string): void {
  const snap = readStatusLine(sessionId)
  if (!snap) return
  if (statusLineSeen.get(sessionId) === snap.receivedAt) return
  statusLineSeen.set(sessionId, snap.receivedAt)
  // Same rule as refreshStatusLine: the newer reading wins for everything
  // per-session, but the two account-wide rate limits are RETAINED when the
  // newer payload states none — otherwise opening a tab evicts a live
  // session's figures, because a payload carries no rate limits until its
  // first render after an API response. See `keepUsage`.
  lastStatusLine = keepUsage(lastStatusLine, snap)
  send(CH.statusLineUpdate, snap)
}

/**
 * Bring `lastStatusLine` up to date from every live session's payload file.
 *
 * `pushStatusLine` above only runs for sessions the context watcher watches,
 * which is every session Stoke minted an id for — but not a `--continue`,
 * whose id the CLI chooses after launch and which is therefore watched by
 * nothing. Its payload exists all the same, under its launch key.
 *
 * That matters because the rate limits in a payload are ACCOUNT-wide: any open
 * session answers for all of them. Without this, the one launch path we cannot
 * predict is also the one that contributes no usage figures at all.
 *
 * Called from the `statusline:last` invoke, not on a timer: the chip asks when
 * it opens, and a handful of small reads on demand is cheaper than polling
 * files that are rewritten three times a second anyway.
 */
function refreshLastStatusLine(): void {
  for (const key of ptys?.statusKeys() ?? []) {
    const snap = readStatusLine(key)
    if (!snap) continue
    lastStatusLine = keepUsage(lastStatusLine, snap)
  }
}
const tunnel = new TunnelManager()

/**
 * Where each session was started, kept past the life of its PTY.
 *
 * `ptys.list()` is the live answer and is gone the moment a tab closes — but
 * closing a tab is when a work block usually ends, and the worklog gate needs a
 * folder to resolve the group from. Without this, finishing and closing means
 * the session can never be placed and so is never logged. Bounded by the
 * sessions started in one run, which is a handful of strings.
 */
const sessionCwds = new Map<string, string>()

/**
 * Which sessions are running on another machine, and on which host.
 *
 * An SSH session spawns `ssh -t <alias> <command>`, so `claude` runs over there
 * and its transcript is written over there. Nothing in `SessionInfo` records
 * that, and every transcript reader needs to know — a remote session looked up
 * locally simply never resolves, which is why the context meter has always been
 * blank for one.
 */
const sessionHosts = new Map<string, SshHost>()

/**
 * When each entry in `sessionCwds`/`sessionHosts` was last genuinely written —
 * either restored off disk at boot or set by `launchSession` for the session
 * it just started.
 *
 * `writeSessionState` used to stamp every entry with `Date.now()` on every
 * call, because that call rewrites the whole map each time a session starts.
 * That refreshed the age of sessions the app did nothing to, so
 * `STORED_SESSION_MAX_AGE_MS`'s 14-day filter could only ever fire on an
 * install nobody was using — the one case that never needs it. This map is
 * the source of truth for "when did this entry last actually change", kept
 * as a sibling of the other two so the same key always exists in all three
 * once a session is known: `launchSession` sets it for the session it starts
 * and leaves every other key alone; the boot-restore loop below sets it from
 * the stamp already on disk, verbatim.
 */
const sessionAts = new Map<string, number>()

/**
 * How often a remote session's transcript is pulled back.
 *
 * The local cadence is 1.5s, which is a `stat` on this disk. This is an SSH
 * round trip and a file transfer, so it gets a cadence that suits a network:
 * slow enough to be unnoticeable on the link, fast enough that the meter is not
 * telling the user something untrue.
 */
const REMOTE_POLL_MS = 30_000


/** The folder a session ran in, live or remembered. */
function cwdForSession(sessionId: string): string {
  return (
    ptys?.list().find((s) => s.sessionId === sessionId)?.cwd || sessionCwds.get(sessionId) || ''
  )
}

/** The host a session is running on, or null when it is local. */
function hostForSession(sessionId: string): SshHost | null {
  const remembered = sessionHosts.get(sessionId)
  if (!remembered) return null
  // Re-read from settings rather than trusting the copy taken at launch: the
  // worklog switch can be turned off while the session is still open, and that
  // has to take effect at once.
  return getSettings().hosts.find((h) => h.id === remembered.id) ?? remembered
}

/**
 * The transcript for a session, wherever it lives.
 *
 * For a local session this is the file Claude wrote. For a remote one it is a
 * local cache of the file Claude wrote on the far machine, pulled back over the
 * same connection the session is already using. Both are plain JSONL, so every
 * caller downstream is unchanged.
 */
async function transcriptFor(sessionId: string): Promise<string | null> {
  const host = hostForSession(sessionId)
  if (!host) return findSessionFile(sessionId)
  /*
   * The per-host switch gates the *copy*, not just the write-up.
   *
   * Fetching pulls a conversation off somebody's machine and puts it on this
   * one. Doing that for the context meter alone — a nicety — while the user has
   * said no to the worklog would be taking the opt-in for one thing as consent
   * for another. So an unticked host is never read at all, and its meter stays
   * blank exactly as it always has.
   */
  if (host.worklog !== true) return null
  const fetched = await fetchRemoteTranscript(host, sessionId, app.getPath('userData'))
  return fetched?.file ?? null
}

/** Starting a session, shared by the renderer's IPC and the remote server. */
async function launchSession(opts: LaunchOptions): Promise<StartResult> {
  if (!ptys) throw new Error('Window is not ready')
  const settings = getSettings()
  // `statusKey` is what the files are named after, not necessarily a session
  // id: a --continue session has no id until the CLI picks one. See pty.ts.
  const result = await ptys.start(opts, settings.claudePath, mcpConfigPath, (statusKey) =>
    writeSessionSettingsFile({
      sessionId: statusKey,
      ultracode: opts.ultracode === true,
      hideStatusLine: settings.hideStatusLine,
      // Read now rather than cached: it is the user's own settings.json and
      // they can edit it between one session and the next.
      passthroughCommand: settings.hideStatusLine ? '' : userStatusLineCommand()
    })
  )
  // Empty for a --continue, and `watch('')` is a no-op by design (context.ts:99).
  // Such a session has never had a context meter; see this task's header for
  // why closing that gap belongs to a later change and not to this one.
  watcher?.watch(result.sessionId)
  const cwd = ptys.list().find((s) => s.sessionId === result.sessionId)?.cwd
  if (cwd) sessionCwds.set(result.sessionId, cwd)
  if (opts.host) sessionHosts.set(result.sessionId, opts.host)
  // Only the session that just launched gets a fresh stamp. Every other entry
  // keeps whatever `sessionAts` already has for it — restored-at-boot or set
  // by an earlier launch — so the 14-day age-out has something to measure
  // besides "the app was opened today".
  sessionAts.set(result.sessionId, Date.now())
  /*
   * Synchronous, and after all three maps are updated — CLAUDE.md gotcha 20's
   * shape. Nothing awaits between the update and the write, so what lands on
   * disk is always a state some pass could actually have observed. One write
   * per session start is a handful a day; this is not a hot path.
   */
  writeSessionState(
    sessionStateFile(app.getPath('userData')),
    [...sessionCwds.entries()].map(([sessionId, dir]) => ({
      sessionId,
      cwd: dir,
      hostId: sessionHosts.get(sessionId)?.id ?? null,
      // Falls back to now only for a key that could not have reached
      // sessionCwds without also reaching sessionAts (both are set together,
      // here and in the boot-restore loop) — defensive, not expected to fire.
      at: sessionAts.get(sessionId) ?? Date.now()
    }))
  )
  return result
}

/**
 * The remote settings as they stand. Reads only.
 *
 * This used to mint a key as a side effect of being read, and the read path
 * was the 4s status poll — so on a fresh install the panel's first poll wrote a
 * token the renderer did not know about, the next control the user touched
 * spread its stale copy of `remote` back over it, and the QR code then carried
 * a key the server was not holding. Minting is `ensureRemoteToken` now, called
 * only by the start paths, and every write here pushes `settingsChanged`.
 */
function remoteConfig(): Settings['remote'] {
  return getSettings().remote
}

/** Mint the bearer key if there is none yet, and tell the renderer. */
function ensureRemoteToken(): Settings['remote'] {
  const s = getSettings()
  if (s.remote.token) return s.remote
  const next = setSettings({ remote: { ...s.remote, token: generateToken() } })
  send(CH.settingsChanged, next)
  return next.remote
}

/**
 * Tell every listener the remote picture moved: the panel, the title bar's
 * phone button, and the tab strip's attached-phone marks. Defined as a function
 * declaration so the RemoteServer constructed at boot, above `remoteState`, can
 * name it.
 */
function pushRemote(): void {
  void remoteState().then((state) => send(CH.remoteChanged, state))
}

/*
 * The QR code, memoised on the link it encodes. `remoteState` is read on
 * every panel poll and every push, and rasterising a 320px code each time
 * was work for a picture that had not changed.
 */
let lastQr: { url: string; bg: string; qr: string } | null = null
/*
 * Whether the speech sidecar answers, probed at most every 15s and only
 * while something is asking. Any HTTP answer counts — the sidecar 405s an
 * OPTIONS — and a refused connection is the whole signal.
 */
let sttProbe: { url: string; at: number; result: 'up' | 'down' } | null = null
const probeStt = async (url: string): Promise<'up' | 'down' | 'unknown'> => {
  const base = url.trim().replace(/\/$/, '')
  if (!base) return 'unknown'
  if (sttProbe && sttProbe.url === base && Date.now() - sttProbe.at < 15_000) return sttProbe.result
  let result: 'up' | 'down'
  try {
    await fetch(`${base}/transcribe`, { method: 'OPTIONS', signal: AbortSignal.timeout(800) })
    result = 'up'
  } catch {
    result = 'down'
  }
  sttProbe = { url: base, at: Date.now(), result }
  return result
}

const remoteState = async (): Promise<RemoteState> => {
  const cfg = remoteConfig()
  const tun = tunnel.status()
  /*
   * The tunnel's live address wins, quick or named, so the QR code and the
   * link line follow the thing that is actually running. The quick tunnel's
   * URL used to be printed bare and the QR kept encoding the LAN link, so a
   * phone opening the tunnel got 401: the key was in the other string.
   */
  const target = connectTarget({ ...cfg, tunnelUrl: tun.running ? tun.url : null })
  // No key, no link: a URL with `?k=` would be a lie the server cannot honour.
  const url = cfg.token ? target.url : null
  let qr: string | null = null
  if (url) {
    const s = getSettings()
    const qrTheme = effectiveTheme(s)
    if (lastQr && lastQr.url === url && lastQr.bg === qrTheme.colors.bg) {
      qr = lastQr.qr
    } else {
      try {
        /*
         * Imported here rather than at the top of the file. `qrcode` is needed
         * by exactly one thing — the connect code — and a static import is a
         * synchronous `require` before `app.whenReady` even fires, because
         * electron-vite externalises dependencies rather than bundling them
         * (`externalizeDepsPlugin`). Measured at 5-16ms of every launch for a
         * module most launches never reach. Node caches it, so the second
         * call pays nothing.
         */
        const { default: QRCode } = await import('qrcode')
        qr = await QRCode.toDataURL(url, {
          margin: 1,
          width: 320,
          // Was Ember's bg and text, hardcoded -- so the code stayed dark-on-warm
          // inside a light window. A QR reader does not care, but the panel does.
          color: { dark: qrTheme.colors.text, light: qrTheme.colors.bg }
        })
        lastQr = { url, bg: qrTheme.colors.bg, qr }
      } catch {
        qr = null
      }
    }
  }
  return {
    server: remote?.status() ?? {
      running: false,
      port: cfg.port,
      error: null,
      clients: 0,
      addresses: [],
      attachedByPty: {}
    },
    tunnel: tun,
    url,
    reach: target.reach,
    address: target.address,
    candidates: target.candidates,
    tailnet: tailnetAddress(),
    qr,
    setup: tunnel.setupCommands(cfg.tunnelName, cfg.hostname, cfg.port),
    stt: await probeStt(cfg.sttUrl)
  }
}


/**
 * One definition of what the remote server can reach into, used by both places
 * a RemoteServer is constructed. They had drifted apart before as separate
 * literals, which is the kind of divergence that shows up as a feature working
 * only when the app happens to have started with remote access already on.
 */
function remoteDeps(): RemoteDeps {
  return {
    ptys: () => ptys,
    watcher: () => watcher,
    listProjects: () => listProjects(getSettings()),
    startSession: (opts) => launchSession(opts),
    defaultCwd: () => resolveDefaultCwd(getSettings().defaultCwd),
    listSessions: (projectPath) => listSessions(projectPath),
    readTranscript: async (sessionId) => {
      const file = await findSessionFile(sessionId)
      return file ? readTranscript(file) : null
    },
    hostFor: (sessionId) => {
      const host = hostForSession(sessionId)
      return host ? host.label || host.alias : null
    },
    theme: () => {
      const s = getSettings()
      return { theme: effectiveTheme(s), fontFamily: s.fontFamily }
    }
  }
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

/* --------------------------------------------------------------- worklog */

/** The process-wide review queue. */
function worklogQueue(): ReturnType<typeof getWorklogQueue> {
  return getWorklogQueue(app.getPath('userData'))
}

/**
 * Whether the worklog may look at one session, and why.
 *
 * A thin gatherer around the pure predicate: everything it reads is live, so a
 * repository cloned during this run, a profile ticked a second ago and a host
 * switched off mid-session all take effect at once.
 */
async function watchStateFor(sessionId: string): Promise<WorklogWatchState> {
  const settings = getSettings()
  return watchStateFrom({
    sessionId,
    cwd: cwdForSession(sessionId),
    host: hostForSession(sessionId),
    projects: await listProjects(settings),
    roots: settings.projectRoots,
    worklogGroups: settings.worklogGroups,
    now: Date.now()
  })
}

/**
 * Every session started this run, live or exited.
 *
 * `sessionCwds` rather than `ptys.list()` on purpose: closing a tab is when a
 * work block usually ends, and a session keeps being the worklog's business
 * after its PTY has gone (see worklog/autoscan.ts). The project list is read
 * once for the whole set — `watchStateFor` reads it per call, which is right
 * for one session and wasteful for twelve.
 */
async function watchStates(): Promise<WorklogWatchState[]> {
  const settings = getSettings()
  const projects = await listProjects(settings)
  const now = Date.now()
  return [...sessionCwds.keys()].map((sessionId) =>
    watchStateFrom({
      sessionId,
      cwd: cwdForSession(sessionId),
      host: hostForSession(sessionId),
      projects,
      roots: settings.projectRoots,
      worklogGroups: settings.worklogGroups,
      now
    })
  )
}

/**
 * Push the whole list.
 *
 * Never a delta, and never from the ContextWatcher tick: the tick runs every
 * 1.5s per session and would push an identical array each time. The triggers
 * are exactly four — a session starting, any settings write, a change to the
 * project list, and the renderer finishing its first load.
 */
function sendWatchStates(): void {
  void watchStates()
    .then((states) => send(CH.worklogWatchChanged, states))
    .catch((err) => console.warn('[stoke] could not resolve the worklog watch states', err))
}

/** The last scan of any session, so a freshly-opened panel is not blank. */
let lastScanReport: WorklogScanReport | null = null

/** Record a report, push it, and hand it back to whoever asked for the scan. */
function reportScan(report: WorklogScanReport): WorklogScanReport {
  lastScanReport = report
  send(CH.worklogScanned, report)
  return report
}

/**
 * One worklog scan, however it was asked for.
 *
 * Shared by the Scan button and the automatic trigger deliberately: the two
 * differ only in who asked, and every other behaviour — reading the boards
 * first, resolving the group, folding the result into the queue — has to stay
 * identical or the automatic path becomes a second, less-tested feature.
 *
 * **Never throws.** It used to, and both callers turned the throw into
 * something the user could not tell from "nothing to report": the automatic
 * path logged and returned 0, the button showed a bare string. Every ending —
 * proposals, nothing, out of budget, broken — now comes back as one
 * WorklogScanReport, which is the only record the panel has of whether this
 * thing has ever run (spec §2.4.4).
 */
async function runWorklogScan(sessionId: string, auto: boolean): Promise<WorklogScanReport> {
  // Nothing above the `try` below may throw — that is the entire reason this
  // function never does. Keep it to `Date.now()` and the `end` closure; put
  // anything else inside the `try`.
  const at = Date.now()
  const end = (
    outcome: WorklogScanOutcome,
    added: number,
    message: string | null
  ): WorklogScanReport => reportScan({ sessionId, at, auto, outcome, added, message })

  try {
    const host = hostForSession(sessionId)
    const file = await transcriptFor(sessionId)
    if (!file) {
      return end(
        'error',
        0,
        host
          ? `could not read a transcript on ${host.label || host.alias} — the session may not have started Claude yet`
          : 'no transcript found for that session yet'
      )
    }

    const settings = getSettings()
    const projects = await listProjects(settings)

    /*
     * A remote session is placed by the machine it runs on, not by a folder.
     * `SessionInfo.cwd` for one is wherever Stoke happened to be pointed locally,
     * so resolving a project group from it would name the wrong project. The real
     * working directory is recorded in the transcript itself, which by this point
     * has been fetched — so the proposal names the remote path, and the host takes
     * the place of the project group.
     */
    const cwd = host ? ((await parseSession(file)).cwd ?? '') : cwdForSession(sessionId)

    /*
     * Root-aware, and remote-aware, and those are two different rules.
     *
     * A remote session is placed by the machine it runs on: `SessionInfo.cwd`
     * for one is wherever Stoke happened to be pointed locally (CLAUDE.md
     * gotcha 18), so the folder rule would name the wrong project or none.
     * The line above already reads the true cwd out of the fetched transcript
     * for that reason — verify it, do not re-add it.
     *
     * A local session is placed by its folder, and by the scan roots too:
     * `/…/work` is itself a registered project on this machine, so the
     * longest-prefix rule answered `dev` for every sibling under it and 7 of
     * 12 work folders were never watched (spec §2.4.3). That third argument
     * is contracts Task 1 Step 4a's, not this task's — verify it is there,
     * do not re-add it.
     */
    const group = host
      ? host.label || host.alias
      : (groupForCwd(cwd, projects, settings.projectRoots) ?? '')

    const boards = settings.worklogBoards
    // Cached and single-flighted, so a scan of two sessions a second apart
    // reads the boards once. A failure here is reported to the scan rather
    // than thrown: proposing creates with no idea what exists is degraded,
    // not broken.
    const snapshot = await recall({
      clickupListId: boards.clickupListId,
      notionDataSource: boards.notionDataSource,
      // Only the boards the user has switched on — otherwise a ClickUp read
      // is paid for on every scan even with ClickUp off.
      targets: boards.targets,
      // The same directory the write would use, so both runs see the same MCP
      // servers. runHeadless falls back to a scratch dir if it has been deleted.
      cwd,
      claudePath: settings.claudePath
    })
    if (snapshot.error) console.warn('[stoke] worklog recall failed:', snapshot.error)

    const outcome = await scanSession({
      sessionId,
      transcriptFile: file,
      cwd,
      group,
      recall: snapshot,
      auto,
      claudePath: settings.claudePath,
      boards
    })
    if (outcome.demoted > 0) {
      // Not silent: a steady count means recall is truncating or the model is
      // inventing ids, and both look exactly like the feature working.
      console.warn(
        `[stoke] worklog: ${outcome.demoted} update(s) named a record that is not on the boards, filed as new instead`
      )
    }
    for (const drop of outcome.statusDropped) {
      // The one line that says why a finished job stayed open. Without it the
      // status was discarded here and the proposal went on to be written as a
      // note, ok, with a "Written" pill over a task nobody had closed.
      console.warn(
        `[stoke] worklog: ${drop.target} would not take the status "${drop.wanted}" — ` +
          `it offers ${drop.allowed.length ? drop.allowed.join(', ') : 'nothing that was read'}. ` +
          'The note was written; the status was left alone.'
      )
    }

    const added = worklogQueue().add(outcome.proposals)
    send(CH.worklogChanged, worklogQueue().list())
    if (auto && added.length) {
      // Reversed to match `list()`, which is newest first — so the prompt walks
      // them in the same order the panel shows them.
      send(CH.worklogProposed, { sessionId, ids: added.map((p) => p.id).reverse() })
    }
    /*
     * A starved board read is not silent just because the scan still drafted
     * something, overriding the
     * brief's pinned `if (added.length) return end('proposed', …, null)`
     * ahead of the budget test below). Proposals win — the outcome stays
     * `proposed` so the drafts are not hidden behind an error-styled banner —
     * but they were written against an empty view of the board, so the
     * warning rides along in `message` instead of being dropped. An ordinary
     * scan, where the board read succeeded, still reports no message at all.
     * See scanOutcomeFor for the full decision.
     */
    const verdict = scanOutcomeFor(snapshot, added.length)
    /*
     * Task 29 review, routed item 2: `scanOutcomeFor` only sees `added` and
     * the recall snapshot, so a transcript with no turns yet and a transcript
     * the model actually read and decided held nothing worth logging both
     * land on `outcome: 'nothing', message: null` — indistinguishable to the
     * panel. `outcome.emptyTranscript` (runner.ts) is where that distinction
     * still exists; it is carried into `message` here rather than discarded,
     * so `scanSentence` (src/shared/worklog.ts) can say which of the two
     * actually happened.
     *
     * Written as "it", not "this session": `scanSentence` prepends its own
     * subject, which names the session as "this session" or "another
     * session" depending on what is on screen when the report is read (Task
     * 29 review, finding 2) — a fragment that hardcoded "this session" would
     * contradict a subject that had just said "another".
     */
    const message =
      verdict.outcome === 'nothing' && outcome.emptyTranscript
        ? 'it had not sent anything yet, so there was nothing in its transcript to read'
        : verdict.message
    return end(verdict.outcome, added.length, message)
  } catch (err) {
    /*
     * Every ending is a report, including this one. The old code let the throw
     * out and both callers flattened it: the automatic path logged to a console
     * nobody has open and returned 0, and the button surfaced a bare string with
     * no record that a scan had happened at all.
     */
    if (err instanceof WorklogBudgetError) return end('budget', 0, err.message)
    /*
     * Task 29 review, routed item 3: `WorklogParseError.message` is
     * `the model's reply held no readable JSON: <up to 300 raw chars>` — a
     * debugging string, not a sentence, and this field is documented "shown
     * to the user verbatim". The raw reply is still worth having, so it goes
     * to the console (nobody reads that mid-scan, which is fine — this is a
     * developer trail, not the user-facing report); the report itself gets
     * plain English with no quoted model output in it.
     */
    if (err instanceof WorklogParseError) {
      console.warn('[stoke] worklog scan: the reply could not be read as an entry —', err.message)
      return end(
        'error',
        0,
        "Claude's reply could not be read back as an entry. Try scanning again."
      )
    }
    return end('error', 0, err instanceof Error ? err.message : String(err))
  }
}

/**
 * The theme actually on screen, which is not always `settings.themeId`.
 *
 * With `followSystemTheme` on there are two stored ids and the OS picks; every
 * main-process reader of "the theme" — the window's own backgroundColor, the
 * Windows title-bar overlay, the QR code's quiet zone, the palette served to
 * the phone — has to ask the same question, or the phone paints one theme while
 * the desktop paints the other.
 *
 * `nativeTheme.shouldUseDarkColors` is the OS answer only while `themeSource`
 * is 'system', which `applyNativeTheme` below guarantees whenever following is
 * on. Off, the value is Stoke's own pin and is not consulted.
 */
function effectiveTheme(settings: Settings): Theme {
  return resolveTheme(
    activeThemeId(settings, nativeTheme.shouldUseDarkColors),
    settings.customThemes
  )
}

/**
 * Tell Chromium which way round the app is.
 *
 * This is not about Stoke's own chrome, which is CSS custom properties and
 * needs nothing from the OS. It is about the docked browser: a page's
 * `prefers-color-scheme` resolves against `nativeTheme`, which defaults to
 * 'system' and was never set -- so a site that honours the query rendered to
 * whatever macOS was set to and could disagree with the window around it. A
 * white page inside a dark shell, or the reverse, with nothing in the app to
 * explain it.
 *
 * It also decides the default form-control and scrollbar rendering inside that
 * view, which the renderer already handles for itself via `colorScheme` on
 * :root (lib/theme.ts) but the WebContentsView does not inherit.
 */
function applyNativeTheme(settings: Settings): void {
  /*
   * Takes the settings rather than a resolved theme, and that is an ordering
   * fix rather than a preference. This call CHANGES what
   * `nativeTheme.shouldUseDarkColors` returns, and `effectiveTheme` reads it —
   * so a caller that resolved a theme first, passed it here, and then resolved
   * again would get two different answers either side of one line. With the
   * settings in hand this needs no resolved theme at all: while following, the
   * appearance is the OS's to decide.
   *
   * 'system' while following is also not merely a tidy equivalent. Pinning the
   * source is exactly what makes `shouldUseDarkColors` report Stoke's own
   * setting back to Stoke, so the pair would resolve against its own answer and
   * never switch. Following the OS and asking the OS have to be one state.
   */
  nativeTheme.themeSource = settings.followSystemTheme
    ? 'system'
    : resolveTheme(settings.themeId, settings.customThemes).appearance
}

/**
 * Repaint the parts of the window Chromium and the OS own, not the page.
 *
 * Shared by a settings change and by the OS flipping to light while Stoke is
 * following it — the second one repaints nothing on its own, so without this
 * the window's backgroundColor stayed on the old theme and flashed the wrong
 * colour at every resize until something else was saved.
 */
function paintWindowChrome(theme: Theme, previousBg: string | null): void {
  if (!win || win.isDestroyed()) return
  /*
   * Chromium paints the window's backgroundColor wherever the renderer has not
   * painted yet — the strip exposed by a resize, the whole window on a slow
   * repaint — and it is set once at creation. Switching Ember to Daylight then
   * flashed #181716 on a white app at every resize.
   */
  if (previousBg === null || theme.colors.bg !== previousBg) {
    win.setBackgroundColor(theme.colors.bg)
  }
  /*
   * The Windows overlay is painted by the OS, not the page, so a theme change
   * leaves the buttons on the old colour until it is told. Profiles repaint the
   * accent only, which the overlay does not use, so the theme is the trigger
   * that matters.
   */
  if (isWindows) {
    win.setTitleBarOverlay({
      color: theme.colors.bgSunken,
      symbolColor: theme.colors.textMuted,
      height: TITLEBAR_H
    })
  }
}

function createWindow(): void {
  const settings = getSettings()
  applyNativeTheme(settings)
  const theme = effectiveTheme(settings)

  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 940,
    minHeight: 580,
    show: false,
    backgroundColor: theme.colors.bg,
    /*
     * macOS keeps its native frame so the traffic lights stay put. Windows now
     * uses a native overlay rather than buttons drawn in the renderer: those
     * looked close but never right, and more importantly a hand-drawn maximise
     * button loses Windows 11's Snap Layouts, which appear on hover over the
     * real one. Linux has no overlay and keeps the custom row.
     */
    frame: isMac || !isWindows,
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    titleBarOverlay: isWindows
      ? {
          color: theme.colors.bgSunken,
          symbolColor: theme.colors.textMuted,
          height: TITLEBAR_H
        }
      : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  /*
   * Dictation needs getUserMedia, so the microphone has to be granted somewhere.
   *
   * Scoped twice over. `media` is the only permission approved, and only for
   * this window's own renderer — the app UI, whose code is in this repo. The
   * docked browser cannot reach this handler at all: it runs in a dedicated
   * persistent partition (browser.ts:36,109), a different session from the one
   * being configured here, so an arbitrary page cannot inherit the microphone
   * from the app that embeds it. The identity check is belt and braces against
   * that ever changing, and everything else is denied outright.
   *
   * This is only Chromium's half. On macOS the OS gates the microphone too, and
   * that half is not code: the hardened runtime needs
   * `com.apple.security.device.audio-input` and Info.plist needs
   * NSMicrophoneUsageDescription, both in electron-builder.yml. Without the
   * usage string macOS terminates the process rather than denying the request,
   * which surfaces as a crash with no message anywhere.
   */
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' && wc === win?.webContents)
  })

  win.once('ready-to-show', () => win?.show())

  const pushMaximized = (): void => send(CH.winMaximizedChanged, win?.isMaximized() ?? false)
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)
  win.on('enter-full-screen', pushMaximized)
  win.on('leave-full-screen', pushMaximized)

  /*
   * Separately, because on macOS full screen is not maximized — `isMaximized()`
   * is false throughout it. Reporting the two down one channel is what left the
   * title bar holding 88px open for traffic lights that were no longer drawn.
   */
  const pushFullScreen = (): void => send(CH.winFullScreenChanged, win?.isFullScreen() ?? false)
  win.on('enter-full-screen', pushFullScreen)
  win.on('leave-full-screen', pushFullScreen)

  // Anything the app UI itself tries to open goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  /*
   * The window never navigates. This is the backstop under file drag-and-drop:
   * Chromium's default action for a file dropped anywhere a `dragover` handler
   * did not claim is to navigate to it, which in a single-page Electron app
   * means the entire UI is replaced by a picture of the dropped file and the
   * only way back is to relaunch. The terminal pane claims its own drops
   * (`TerminalView`), so this covers every other pixel — the sidebar, the
   * title bar, the settings modal — where a near-miss would otherwise be
   * destructive rather than merely inert.
   *
   * Scoped to the top-level frame's own navigation: the docked browser is a
   * separate `WebContentsView` with its own webContents and is unaffected.
   */
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })

  browser = new EmbeddedBrowser(
    win,
    (state) => send(CH.browserState, state),
    () => send(CH.browserFindRequested)
  )
  browser.setBookmarks(settings.browser.bookmarks)

  /*
   * Self-update and the CLI check, both deferred so they never compete with
   * startup work, and both HELD so they can be cleared when the window goes.
   *
   * The handles are not tidiness. On macOS closing the last window does not
   * quit (gotcha 35), and `activate` calls createWindow() again on the next
   * dock click — so every one of these was re-armed per cycle while the
   * previous ones kept running. The interval is the one that accumulates: two
   * close/reopen cycles meant three six-hourly timers, each independently
   * deciding whether to spawn `claude update`, against a `cliRefreshing` claim
   * that only serialises them rather than making them one.
   */
  initSelfUpdate((s) => send(CH.selfState, s))
  timers.push(setTimeout(() => void checkSelfUpdate(), 8000))

  // The CLI's own version, on the same "not during startup" principle. Offset
  // from the self-update check so the two are not spawning subprocesses and
  // making network calls in the same tick.
  timers.push(setTimeout(() => void refreshCliUpdate(), 12_000))
  timers.push(setInterval(() => void refreshCliUpdate(), AUTO_CHECK_MS))

  // Expose the docked browser to Claude Code. Started eagerly so the config
  // file exists before the first session is launched.
  mcp = new BrowserMcpServer(browser)
  void mcp
    .start()
    .then((path) => {
      mcpConfigPath = path
    })
    .catch((err) => console.error('[stoke] browser MCP server failed to start', err))

  ptys = new PtyManager(
    (ptyId, data) => send(CH.ptyData, ptyId, data),
    (ptyId, code, signal, sessionId) => {
      send(CH.ptyExit, ptyId, code, signal)
      // A session that ends on its own (`/exit`, a crash) never reaches the
      // `CH.ptyKill` handler's cleanup below — by the time a user later
      // closes that tab, `sessionIdFor` already returns null, because
      // `proc.onExit` removed the session from PtyManager's own map before
      // this callback ever ran. `sessionId` here comes straight from that
      // same exit event, while it is still known, so this entry does not
      // sit in `statusLineSeen` forever.
      if (sessionId) statusLineSeen.delete(sessionId)
    }
  )
  /*
   * The worklog's automatic trigger.
   *
   * Built before the watcher because the watcher feeds it: every context
   * reading is also an activity reading, so noticing that a work block finished
   * costs no new polling, no new file handles and no new IPC. See
   * worklog/autoscan.ts for why the transcript is the right signal.
   */
  const autoscanState = autoScanStateFile(app.getPath('userData'))
  const sessionState = sessionStateFile(app.getPath('userData'))
  /*
   * Put the last run's sessions back before anything asks which are watched.
   *
   * A host the user has since deleted is dropped rather than carried: a
   * remembered SshHost would keep gating a machine that is no longer in
   * Settings, and the per-host worklog switch is an opt-in that has to be
   * revocable by deleting the host.
   */
  for (const s of readSessionState(sessionState)) {
    sessionCwds.set(s.sessionId, s.cwd)
    // Verbatim from disk, not `Date.now()` — this entry was not just used, it
    // was merely reloaded, and the age-out has to measure from the same clock
    // reading a fresh launch would have written.
    sessionAts.set(s.sessionId, s.at)
    if (!s.hostId) continue
    const host = getSettings().hosts.find((h) => h.id === s.hostId)
    if (host) sessionHosts.set(s.sessionId, host)
  }
  autoscan = new AutoScanner({
    /*
     * A cheap "could anything possibly be watched" check, so a pass with
     * nothing to do skips every tracked session without a disk read.
     *
     * Has to agree with watchStateFor's own notion of "nothing is watched",
     * or this becomes a second decision site by omission. watchStateFrom's
     * host branch never looks at worklogGroups — a ticked SSH host is
     * `watched: true` even with zero project groups ticked — so gating on
     * worklogGroups alone would skip the whole pass for a host the tab strip
     * is showing a dot for, and the dot would be lying about a run that can
     * never happen. Checking for a ticked host too is what keeps them tied.
     */
    enabled: () => {
      const settings = getSettings()
      return (
        settings.worklogAuto &&
        (settings.worklogGroups.length > 0 || settings.hosts.some((h) => h.worklog === true))
      )
    },
    watched: async (sessionId) => {
      // `worklogAuto` gates the automatic trigger only; whether a session is the
      // worklog's business at all is watchStateFor's answer, and it is the same
      // answer the tab strip draws. One predicate, so the dot and the run that
      // costs money cannot disagree.
      if (!getSettings().worklogAuto) return false
      return (await watchStateFor(sessionId)).watched
    },
    scan: async (sessionId) => {
      // runWorklogScan no longer throws; the report is the record of what
      // happened and has already been pushed to the renderer by the time this
      // returns. AutoScanner only needs the count for its own prompt. The push
      // alone is not yet a substitute for a log line — nothing reads
      // `worklog:scanned` until the panel lands, so until then a failed
      // automatic scan needs to show up here or it shows up nowhere. Keyed on
      // `message` rather than `outcome === 'budget' || outcome === 'error'`:
      // a 'proposed' outcome can now carry a message too, when the drafts
      // were written blind (H5), and that warning would otherwise go nowhere
      // for an automatic scan just as surely as a budget stop would.
      //
      // `outcome === 'nothing'` is excluded even when `message` is set (Task
      // 29 review, finding 1): since that same task taught `message` to carry
      // the empty-transcript distinction too, a session with no turns yet
      // would otherwise warn on every quiet auto-scan pass over it — a
      // console line for a session that is doing exactly nothing wrong.
      const report = await runWorklogScan(sessionId, true)
      if (report.outcome !== 'nothing' && report.message) {
        console.warn('[stoke] automatic worklog scan:', report.outcome, report.message)
      }
      return report.added
    },
    // Baselines and the hourly ceiling survive a restart. Without this, quitting
    // re-baselined every resumed session — so the work done just before a
    // restart was invisible to the scanner — and cleared the spending ceiling,
    // which made it not a ceiling.
    restore: () => readAutoScanState(autoscanState),
    persist: (snapshot) => writeAutoScanState(autoscanState, snapshot)
  })
  autoscan.start()

  // The window size comes from the statusLine payload first and the CLI's own
  // startup banner second; see windowFor. The banner used to be the only
  // source and 2.1.221 stopped printing it.
  watcher = new ContextWatcher(
    (snap) => {
      send(CH.ctxUpdate, snap)
      pushStatusLine(snap.sessionId)
      // `ready` is false for the placeholder emitted while a brand-new session
      // has no transcript yet; its counts are zeroes and would set a baseline
      // the real first reading then blows straight past.
      if (snap.ready) autoscan?.observe(snap.sessionId, snap.messageCount, snap.updatedAt)
    },
    (sessionId) => windowFor(sessionId, ptys?.bannerWindowFor(sessionId) ?? null),
    {
      /*
       * One poller, both kinds of session.
       *
       * A remote transcript is fetched back over the same connection rather
       * than read off this disk, and routing it through the watcher rather
       * than beside it is what makes everything downstream work unchanged:
       * the context meter starts reading for SSH sessions, and the auto-scan
       * trigger — which is fed from these very snapshots — starts firing for
       * them too. Without it the worklog over SSH would only ever run from the
       * Scan button.
       */
      resolve: (sessionId) => transcriptFor(sessionId),
      volatile: (sessionId) => hostForSession(sessionId) !== null,
      // A network round trip cannot run at the local 1.5s. Slow enough to be
      // unnoticeable on the link, fast enough that the meter is not a lie.
      pollMs: (sessionId) => (hostForSession(sessionId) ? REMOTE_POLL_MS : null)
    }
  )

  /*
   * Any settings write can change which sessions are watched — a profile
   * ticked, a host switched on, a scan root added. Settings changes are
   * user-paced, so recomputing unconditionally is cheaper than working out
   * whether this particular write mattered.
   */
  const offSettings = onSettingsChanged(() => sendWatchStates())
  win.webContents.on('did-finish-load', () => sendWatchStates())

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Bring remote access back up if it was left on.
  if (getSettings().remote.enabled) {
    const cfg = ensureRemoteToken()
    remote = new RemoteServer(remoteDeps(), pushRemote)
    void remote.start(cfg).then(() => {
      if (cfg.autoStartTunnel && cfg.hostname) {
        tunnel.start('named', { port: cfg.port, tunnelName: cfg.tunnelName, hostname: cfg.hostname })
      }
      pushRemote()
    })
  }

  win.on('closed', () => {
    offSettings()
    // Before anything else: on macOS this fires and `before-quit` does not
    // (gotcha 35), so this is the only flush the tail of a slider drag gets.
    flushSettings()
    for (const t of timers.splice(0)) clearInterval(t)
    ptys?.killAll()
    watcher?.disposeAll()
    autoscan?.dispose()
    autoscan = null
    mcp?.stop()
    void remote?.stop()
    tunnel.stop()
    remote = null
    /*
     * The docked browser's tabs are real WebContents, and dropping the
     * reference does not close any of them. Every other subsystem here is torn
     * down explicitly and this one was only nulled — so on macOS, where closing
     * the window does not quit and `activate` builds a fresh EmbeddedBrowser,
     * each close/reopen cycle orphaned one Chromium renderer per open tab, all
     * still holding the shared `persist:stoke-browser` session.
     */
    browser?.destroy()
    browser = null
    ptys = null
    watcher = null
    mcp = null
    mcpConfigPath = null
    win = null
  })
}

/*
 * The newest snapshot the renderer has sent.
 *
 * Held in memory so the before-quit flush below has something to retry. It is
 * NOT what makes quit safe against recent edits: `tabs:save` already calls
 * `writeTabState` synchronously on every push, before returning to the event
 * loop, so by the time before-quit fires this can never hold anything newer
 * than what is already on disk. It cannot buy back a very recent edit either -
 * anything the renderer has not sent yet is still sitting in its debounce,
 * unreachable from main. What the flush does cover is a push whose write
 * failed: `writeTabState` swallows its own errors (catches and logs), so a
 * disk hiccup gets one more attempt on the way out.
 */
let lastTabState: StoredTabs | null = null

function registerIpc(): void {
  /* ---------------------------------------------------------- window chrome */
  ipcMain.on(CH.winMinimize, () => win?.minimize())
  ipcMain.on(CH.winMaximize, () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(CH.winClose, () => win?.close())
  ipcMain.on(CH.winFocus, () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  ipcMain.handle(CH.winIsMaximized, () => win?.isMaximized() ?? false)
  // Asked once on mount, because a window can be launched already full screen
  // and no enter-full-screen event fires for a state it started in.
  ipcMain.handle(CH.winIsFullScreen, () => win?.isFullScreen() ?? false)

  /*
   * What the OS says, and a push when it changes.
   *
   * `shouldUseDarkColors` is only the OS's answer while `themeSource` is
   * 'system', which `applyNativeTheme` holds it at for exactly as long as
   * following is on — so the value is asked for only in the state where it
   * means anything, and the renderer ignores it in the other.
   */
  ipcMain.handle(CH.systemDark, () => nativeTheme.shouldUseDarkColors)
  let lastSystemDark = nativeTheme.shouldUseDarkColors
  nativeTheme.on('updated', () => {
    const dark = nativeTheme.shouldUseDarkColors
    /*
     * Guarded on a real change. This event also fires when Stoke itself writes
     * `themeSource` — which it does on every settings save — so an unguarded
     * handler would repaint the window and push at the renderer on each one,
     * and worse, would do it with a value that had not moved.
     */
    if (dark === lastSystemDark) return
    lastSystemDark = dark
    send(CH.systemDarkChanged, dark)
    const s = getSettings()
    if (!s.followSystemTheme) return
    // The renderer repaints itself from the push above; this is the half it
    // cannot reach — the window's own background and the Windows overlay.
    paintWindowChrome(effectiveTheme(s), null)
  })

  /* ------------------------------------------------------------------- cli */
  ipcMain.handle(CH.cliInfo, () => probeClaude(getSettings().claudePath))

  /* ---------------------------------------------------------- plan limits */
  /*
   * Two refresh rules, and the reason there are two is that a timer alone
   * cannot be both prompt and cheap.
   *
   * `poll` is the idle cadence: 30s, which is often enough that the countdown
   * never visibly stalls and rare enough not to hammer an endpoint that is
   * undocumented and moves in whole percentage points.
   *
   * `message` is the renderer saying a new turn just started (a changed
   * `prompt_id`, see UsageMeter). That is the moment the numbers are most
   * likely to have actually moved and the moment someone is most likely to be
   * looking, so it is allowed to pre-empt the 30s — that is the whole "or
   * every message, whichever is first" rule. It still has a floor, because
   * "a message" is not rate-limited by anything: several sessions can each
   * start a turn within the same second, and a floor of a few seconds turns
   * that into one call instead of five while staying imperceptible.
   *
   * The backoff outranks both. A 429 or a 5xx wants a longer wait than either
   * cadence, and a message boundary is not a reason to ignore it — continuing
   * to knock on an undocumented endpoint that has just said no is how access
   * gets worse rather than better. `nextBackoff` sets its length: what the
   * server asked for, or a minute doubling to fifteen when it asked for
   * nothing. It is NOT a flat fifteen minutes any more; see that function for
   * the measurement that changed it.
   */
  ipcMain.handle(CH.usageRead, async (_e, reason?: UsageReadReason) => {
    const now = Date.now()
    const floor = reason === 'message' ? USAGE_MESSAGE_FLOOR_MS : USAGE_POLL_MS
    const wait = Math.max(usageBackoff, floor)
    if (usageCache && now - usageAttemptedAt < wait) return usageCache

    usageAttemptedAt = now
    const fresh = await fetchUsage(now)
    if (!fresh.error) {
      usageBackoff = 0
      usageCache = fresh
      return usageCache
    }

    // Both halves are pure and asserted in verify:usage — see `keepLastGood`
    // for why a failure keeps the previous numbers, and `nextBackoff` for why
    // the wait is no longer a flat fifteen minutes.
    usageBackoff = nextBackoff(usageBackoff, fresh.retryAfter)
    usageCache = keepLastGood(usageCache, fresh, now + usageBackoff)
    return usageCache
  })

  /* -------------------------------------------------------------- projects */
  ipcMain.handle(CH.projectsList, () => listProjects(getSettings()))
  ipcMain.handle(CH.sessionsList, (_e, projectPath: string) => listSessions(projectPath))

  ipcMain.handle(CH.projectsAddRoot, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a folder to scan for projects',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    const dir = res.filePaths[0]
    const s = getSettings()
    if (!s.projectRoots.includes(dir)) {
      setSettings({ projectRoots: [...s.projectRoots, dir] })
    }
    sendWatchStates()
    return dir
  })

  /*
   * Picking a folder used to return the path and write nothing, so the dialog
   * closed and the sidebar was unchanged (spec 2.5). The record is what makes
   * `listProjects` able to emit a folder Claude has never seen.
   */
  ipcMain.handle(CH.projectsAdd, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    const dir = res.canceled ? null : (res.filePaths[0] ?? null)
    if (!dir) return null
    const rules = pathRulesFor(process.platform)
    setSettings(manualProjectPatch(getSettings(), dir, rules))
    sendWatchStates()
    // Return the same normalised string manualProjectPatch persisted under —
    // a dialog's "C:\\" would otherwise come back to App.tsx's setSelectedPath
    // as a key that never matches the row applyProjectMeta just created.
    return normalizePath(dir.trim(), rules)
  })

  ipcMain.handle(CH.projectsMeta, (_e, path: string, meta: ProjectMeta | null) => {
    const next = setSettings(projectMetaPatch(getSettings(), path, meta, pathRulesFor(process.platform)))
    sendWatchStates()
    return next
  })

  /* ------------------------------------------------------------- workspaces */
  ipcMain.handle(CH.workspaceDefault, () => resolveDefaultCwd(getSettings().defaultCwd))
  ipcMain.handle(CH.workspaceScratch, () => createScratchDir())

  ipcMain.handle(CH.projectsHide, (_e, path: string, hidden: boolean) => {
    const s = getSettings()
    const next = hidden
      ? [...new Set([...s.hiddenProjects, path])]
      : s.hiddenProjects.filter((p) => p !== path)
    const saved = setSettings({ hiddenProjects: next })
    sendWatchStates()
    return saved
  })

  ipcMain.handle(CH.projectsPin, (_e, path: string, pinned: boolean) => {
    const s = getSettings()
    const next = pinned
      ? [...new Set([...s.pinnedProjects, path])]
      : s.pinnedProjects.filter((p) => p !== path)
    return setSettings({ pinnedProjects: next })
  })

  ipcMain.handle(CH.projectsReveal, (_e, path: string) => shell.openPath(path))

  /* ------------------------------------------------------------------- pty */
  ipcMain.handle(CH.ptyStart, async (_e, opts: LaunchOptions) => {
    const result = await launchSession(opts)
    // After launchSession, so sessionCwds already holds the new id — the state
    // for a session nobody has recorded a folder for is 'unknown-folder', which
    // would be wrong and would not correct itself until the next settings write.
    sendWatchStates()
    return result
  })

  ipcMain.on(CH.ptyWrite, (_e, ptyId: string, data: string) => ptys?.write(ptyId, data))
  ipcMain.on(CH.ptyResize, (_e, ptyId: string, cols: number, rows: number) =>
    ptys?.resize(ptyId, cols, rows)
  )
  ipcMain.on(CH.ptyKill, (_e, ptyId: string) => {
    const sessionId = ptys?.sessionIdFor(ptyId)
    ptys?.kill(ptyId)
    if (sessionId) {
      watcher?.unwatch(sessionId)
      statusLineSeen.delete(sessionId)
    }
  })

  /* --------------------------------------------------------------- context */
  ipcMain.on(CH.ctxWatch, (_e, sessionId: string) => watcher?.watch(sessionId))
  ipcMain.on(CH.ctxUnwatch, (_e, sessionId: string) => watcher?.unwatch(sessionId))
  /*
   * Hook events, polled off the per-session events file every second.
   *
   * A poll rather than fs.watch, for the reason context.ts gives: the file is
   * appended to, watch semantics for appends differ per platform, and there
   * are only ever a handful of live sessions. One second is the ceiling on how
   * late a "done" dot or a notification can be, which is well under the time
   * it takes to switch to the tab and read the answer.
   *
   * Reentrancy-guarded, because the read is async and a pass can outlive its
   * own interval when the disk is slow (gotcha 20). Offsets are dropped for
   * sessions that have gone, so a key reused by a later launch — impossible
   * today, since keys are uuids, but cheap to be right about — starts at zero.
   */
  const eventOffsets = new Map<string, number>()
  let pollingEvents = false
  const pollSessionEvents = async (): Promise<void> => {
    if (pollingEvents) return
    pollingEvents = true
    try {
      const keys = ptys?.statusKeys() ?? []
      for (const known of [...eventOffsets.keys()]) if (!keys.includes(known)) eventOffsets.delete(known)
      for (const key of keys) {
        const { events, offset } = await readSessionEvents(key, eventOffsets.get(key) ?? 0)
        eventOffsets.set(key, offset)
        for (const ev of events) send(CH.sessionEvent, ev)
      }
    } finally {
      pollingEvents = false
    }
  }
  setInterval(() => void pollSessionEvents(), 1000)

  ipcMain.handle(CH.statusLineLast, () => {
    // Sweep first, so a session nothing watches — a --continue — still
    // contributes its account-wide rate limits. See refreshLastStatusLine.
    refreshLastStatusLine()
    return lastStatusLine
  })

  /* --------------------------------------------------------------- browser */
  ipcMain.on(CH.browserSetBounds, (_e, rect: Rect) => browser?.setBounds(rect))
  ipcMain.on(CH.browserShow, (_e, url?: string) => browser?.show(url))
  ipcMain.on(CH.browserHide, () => browser?.hide())
  ipcMain.on(CH.browserNavigate, (_e, url: string) => browser?.navigate(url))
  ipcMain.on(CH.browserBack, () => browser?.back())
  ipcMain.on(CH.browserForward, () => browser?.forward())
  ipcMain.on(CH.browserReload, () => browser?.reload())
  ipcMain.on(CH.browserStop, () => browser?.stop())
  ipcMain.on(CH.browserOpenExternal, () => browser?.openExternal())
  ipcMain.on(CH.browserDevtools, () => browser?.toggleDevtools())
  ipcMain.on(CH.browserNewTab, (_e, url?: string) => browser?.newTab(url))
  ipcMain.on(CH.browserCloseTab, (_e, id: string) => browser?.closeTab(id))
  ipcMain.on(CH.browserSelectTab, (_e, id: string) => browser?.selectTab(id))
  ipcMain.on(CH.browserFind, (_e, t: string, fwd?: boolean, next?: boolean) =>
    browser?.find(t, fwd ?? true, next ?? false)
  )
  ipcMain.on(CH.browserStopFind, () => browser?.stopFind())
  ipcMain.on(CH.browserZoom, (_e, level: number) => browser?.setZoom(level))

  ipcMain.on(CH.browserBookmark, () => {
    const url = browser?.currentState().url
    if (!url || url === 'about:blank') return
    const s = getSettings()
    const list = s.browser.bookmarks.includes(url)
      ? s.browser.bookmarks.filter((b) => b !== url)
      : [...s.browser.bookmarks, url]
    const next = setSettings({ browser: { ...s.browser, bookmarks: list } })
    browser?.setBookmarks(list)
    send(CH.settingsChanged, next)
  })

  /* ------------------------------------------------------ claude code config */
  /*
   * Claude Code's own settings, which are not Stoke's and live in Claude's own
   * files. Nothing here touches Stoke's `Settings`, so none of it broadcasts
   * `settingsChanged`; each handler returns the new state to its caller, the
   * convention the profiles and workspace handlers already use.
   */
  const claudeConfigState = async (): Promise<unknown> => {
    const read = await readClaudeSettings()
    const drawn = CLAUDE_SETTINGS.map((spec) => spec.key)
    const values: Record<string, boolean | string | number> = {}
    for (const key of drawn) {
      const found = read.values?.[key]
      // Only the three kinds the panel can draw. Anything else in this key —
      // a hand-written object, say — is left alone and reported as unset rather
      // than rendered as something a control could overwrite.
      if (typeof found === 'boolean' || typeof found === 'string' || typeof found === 'number') {
        values[key] = found
      }
    }
    const global = readGlobalConfigKey(WORKFLOW_SIZE_KEY)
    const shadow = read.values?.[WORKFLOW_SIZE_KEY]
    return {
      settingsPath: read.path,
      globalConfigPath: claudeGlobalConfigPath(process.env, homedir()),
      values,
      /*
       * `WORKFLOW_SIZE_KEY` counts as drawn even though it is not in `drawn`.
       *
       * The panel does render a control for it — `WorkflowSizeRow` — it just
       * writes to ~/.claude.json rather than to settings.json (gotcha 39). But
       * the key is *also* valid in settings.json, and when it appears there it
       * shadows the global one, which the panel says so in as many words. So
       * listing it under "left exactly as they are" told the user Stoke would
       * not touch the one key it had just drawn a control for and warned them
       * about.
       */
      untouched: untouchedKeys(read.values, [...drawn, WORKFLOW_SIZE_KEY]),
      workflowSize: typeof global.value === 'string' ? global.value : undefined,
      workflowSizeShadowed: typeof shadow === 'string',
      error: read.error ?? global.error
    }
  }

  ipcMain.handle(CH.claudeConfigRead, () => claudeConfigState())

  ipcMain.handle(CH.claudeConfigSet, async (_e, key: string, value: ClaudeSettingValue) => {
    const result = await patchClaudeSetting(key, value)
    return { ok: result.ok, error: result.error, state: await claudeConfigState() }
  })

  ipcMain.handle(CH.claudeWorkflowSize, async (_e, value: string | undefined) => {
    const invalid = validateWorkflowSize(value)
    if (invalid) return { ok: false, error: invalid, state: await claudeConfigState() }
    const result = await writeGlobalConfigKey(WORKFLOW_SIZE_KEY, value)
    // `wroteUnlocked` and `attempts` are carried through rather than dropped:
    // they are the only evidence the renderer can have that the write took the
    // unguarded path or had to be retried, and gotcha 38 is why that matters.
    return {
      ok: result.ok,
      error: result.error,
      wroteUnlocked: result.wroteUnlocked,
      attempts: result.attempts,
      state: await claudeConfigState()
    }
  })

  /* ---------------------------------------------------------------- remote */

  ipcMain.handle(CH.remoteStatus, () => remoteState())

  /**
   * One press does the whole job.
   *
   * A fresh install's "Turn on" used to produce a link a phone could not open:
   * every transport is off by default, so `connectTarget` fell through to
   * 127.0.0.1 and the panel drew it as a QR code under "Open on your phone".
   * Making it work took ticking a box below the code and turning the server off
   * and on again, and nothing said so. So if nothing reaches beyond this
   * machine, this picks: the tailnet when Tailscale is up (a smaller room than
   * the LAN), the local network otherwise. A transport the user already chose
   * is kept exactly as chosen.
   */
  ipcMain.handle(CH.remoteOpenOnPhone, async () => {
    const cur = ensureRemoteToken()
    /*
     * "Has the user already chosen" is the stored preference and a running
     * tunnel, and deliberately NOT a saved hostname. Counting the hostname is
     * what made this a no-op on the one machine that most needed it: a
     * hostname typed months ago made `reaches` true, so nothing was bound, the
     * server stayed on loopback, and the one press produced an https link to a
     * name no tunnel was serving.
     */
    const chosen = cur.reach !== 'auto' || tunnel.status().running
    /*
     * Both halves together. The preference alone gives a link nothing is
     * listening on; the bind alone leaves the choice inferred, which is the
     * conflation this field exists to end.
     */
    const pick: Partial<typeof cur> = chosen
      ? {}
      : tailnetAddress()
        ? { reach: 'tailnet', bindTailscale: true, bindLan: false }
        : { reach: 'lan', bindLan: true, bindTailscale: false }
    const next = setSettings({ remote: { ...cur, ...pick, enabled: true } })
    send(CH.settingsChanged, next)
    remote ??= new RemoteServer(remoteDeps(), pushRemote)
    await remote.start(next.remote)
    if (next.remote.autoStartTunnel && next.remote.hostname && !tunnel.status().running) {
      tunnel.start('named', {
        port: next.remote.port,
        tunnelName: next.remote.tunnelName,
        hostname: next.remote.hostname
      })
    }
    const state = await remoteState()
    send(CH.remoteChanged, state)
    return state
  })

  ipcMain.handle(CH.remoteStart, async () => {
    const cfg = ensureRemoteToken()
    remote ??= new RemoteServer(remoteDeps(), pushRemote)
    await remote.start(cfg)
    if (cfg.autoStartTunnel && cfg.hostname) {
      tunnel.start('named', { port: cfg.port, tunnelName: cfg.tunnelName, hostname: cfg.hostname })
    }
    // Pushed, not merely written: the panel builds every patch from ITS copy
    // of `remote`, so a write it is not told about is one it will undo.
    send(CH.settingsChanged, setSettings({ remote: { ...cfg, enabled: true } }))
    const state = await remoteState()
    send(CH.remoteChanged, state)
    return state
  })

  ipcMain.handle(CH.remoteStop, async () => {
    await remote?.stop()
    tunnel.stop()
    const s = getSettings()
    send(CH.settingsChanged, setSettings({ remote: { ...s.remote, enabled: false } }))
    const state = await remoteState()
    send(CH.remoteChanged, state)
    return state
  })

  ipcMain.handle(CH.remoteNewToken, async () => {
    const s = getSettings()
    const next = setSettings({ remote: { ...s.remote, token: generateToken() } })
    // Existing phones must re-open the link; restart so the old key stops working.
    if (remote?.status().running) await remote.start(next.remote)
    send(CH.settingsChanged, next)
    const state = await remoteState()
    send(CH.remoteChanged, state)
    return state
  })

  ipcMain.handle(CH.tunnelStart, async (_e, mode: 'named' | 'quick') => {
    const cfg = remoteConfig()
    await tunnel.locate()
    tunnel.start(mode, { port: cfg.port, tunnelName: cfg.tunnelName, hostname: cfg.hostname })
    /*
     * A quick tunnel announces its address a second or two after starting, and
     * cloudflared fails a second or two after that when it is going to. One
     * follow-up push a few seconds on catches both without the panel polling.
     */
    setTimeout(pushRemote, 4000)
    const state = await remoteState()
    send(CH.remoteChanged, state)
    return state
  })

  ipcMain.handle(CH.tunnelStop, async () => {
    tunnel.stop()
    const state = await remoteState()
    send(CH.remoteChanged, state)
    return state
  })

  ipcMain.handle(CH.tunnelLocate, async () => {
    await tunnel.locate(true)
    return remoteState()
  })

  ipcMain.handle(CH.cloudflareSetup, async () => {
    const cfg = getSettings().remote
    return probeSetup({
      tunnelName: cfg.tunnelName,
      hostname: cfg.hostname,
      running: tunnel.status().running
    })
  })

  ipcMain.handle(CH.cloudflareStep, async (_e, step: 'login' | 'create' | 'route', opts?: { overwriteDns?: boolean }) => {
    const cfg = getSettings().remote
    if (step !== 'login') {
      return runSetupStep(step, {
        tunnelName: cfg.tunnelName,
        hostname: cfg.hostname,
        overwriteDns: opts?.overwriteDns
      })
    }
    /*
     * Login is the only step that needs a person and a browser, so it is the
     * only one shaped like this: start it, hand the URL to the OS, and treat
     * the CERTIFICATE APPEARING as completion rather than the process exiting
     * — cloudflared stays alive precisely to write that file when the browser
     * comes back, and it refuses outright if one is already there.
     */
    const certPath = originCertPath()
    try {
      await access(certPath)
      return { ok: true, output: `Already logged in — ${certPath} exists.`, error: null }
    } catch {
      /* not logged in, which is the point */
    }
    const exe = (await tunnel.locate()) ?? 'cloudflared'
    const login = startLogin(exe)
    const url = await login.url
    if (url) shell.openExternal(url)
    const ok = await waitForCert(certPath)
    login.stop()
    return {
      ok,
      url: url ?? undefined,
      output: login.output(),
      error: ok
        ? null
        : url
          ? 'Timed out waiting for the browser. Open the link again and finish signing in.'
          : 'cloudflared did not offer a login link. Check that it is installed.'
    }
  })

  /* ---------------------------------------------------------- self update */
  ipcMain.handle(CH.selfState, () => selfUpdateState())
  ipcMain.handle(CH.selfCheck, () => checkSelfUpdate())
  ipcMain.handle(CH.selfDownload, () => downloadSelfUpdate())
  ipcMain.handle(CH.selfInstall, () => {
    installSelfUpdate()
    return true
  })

  /* --------------------------------------------------------------- updates */
  ipcMain.handle(CH.updateCheck, async () => {
    // Through the shared cache, so a manual Check and the automatic one cannot
    // disagree about what version is installed.
    cliUpdate = await checkForUpdate(getSettings().claudePath)
    send(CH.updateState, cliState())
    return cliUpdate
  })
  ipcMain.handle(CH.updateRun, async (): Promise<CliRunResult> => {
    /*
     * The same claim the timer takes, because the thing being serialised is an
     * installer rewriting the CLI on disk, and it does not care which of the
     * two callers asked for it.
     *
     * `refreshCliUpdate` has guarded ITSELF against overlapping since gotcha 20
     * was written, but that guard is private to it: this handler called
     * `runUpdate` directly, so a press of "Update now" while the six-hourly
     * check happened to be mid-install ran a second `claude update` against the
     * same install, concurrently. Not a rare window either — the automatic run
     * is exactly what puts the "an update is available" line on screen that
     * makes someone press the button.
     *
     * Refused rather than queued. Waiting would leave the button spinning for
     * up to three minutes with nothing said, and the automatic run is already
     * doing the thing the user asked for, so saying so is the more useful
     * answer. `from`/`to` are read anyway so the panel can still show what is
     * installed rather than blanking.
     */
    if (cliRefreshing) {
      // The cached reading rather than a fresh `claude --version`: spawning a
      // subprocess to answer a refusal is work done to say "no".
      const at = cliUpdate?.current ?? null
      return {
        ok: false,
        output: '',
        error: 'An automatic update is already running. This will finish on its own.',
        from: at,
        to: at
      }
    }
    cliRefreshing = true
    try {
      const result = await runUpdate(getSettings().claudePath)
      // A manual run is the user deciding, so it clears whatever the automatic
      // one last said — leaving a stale "Automatic update failed" above a
      // successful manual run would be the panel contradicting itself.
      cliAutoNote = null
      cliLastAttempt = null
      cliUpdate = await checkForUpdate(getSettings().claudePath)
      send(CH.updateState, cliState())
      return result
    } finally {
      cliRefreshing = false
    }
  })
  ipcMain.handle(CH.updateDoctor, () => runDoctor(getSettings().claudePath))
  ipcMain.handle(CH.updateState, () => cliState())

  /* -------------------------------------------------------------- settings */
  ipcMain.handle(CH.settingsGet, () => getSettings())
  ipcMain.handle(CH.settingsSet, async (_e, patch: Partial<Settings>) => {
    const prev = getSettings()
    const next = setSettings(patch)
    /*
     * A running remote server reads its config once, at start. So ticking
     * "also listen on the local network", changing the port, or requiring
     * Access used to change nothing until the server was turned off and on —
     * and nothing said so. Restart it here when a field it binds or checks
     * moves; `start()` stops the old listeners first.
     */
    const bindKeys = ['port', 'bindLan', 'bindTailscale', 'requireAccessHeader', 'hostname', 'token'] as const
    if (remote?.status().running && bindKeys.some((k) => prev.remote[k] !== next.remote[k])) {
      await remote.start(next.remote)
      pushRemote()
    } else if (prev.remote.sttUrl !== next.remote.sttUrl) {
      sttProbe = null
      pushRemote()
    } else if (prev.remote.reach !== next.remote.reach) {
      /*
       * NOT a bind key: the preference changes which link is drawn, never what
       * the socket listens on, so restarting the server for it would drop every
       * connected phone to repaint a QR code. It still has to be pushed, or the
       * panel keeps the old code until the 15s poll catches up — which reads as
       * the segment you just pressed having been ignored.
       */
      pushRemote()
    }
    /*
     * `prev` is resolved BEFORE the source is re-pinned, because
     * `applyNativeTheme` moves what `effectiveTheme` reads. Resolving both
     * after it would compare the new state against itself and skip the repaint.
     */
    const prevTheme = effectiveTheme(prev)
    applyNativeTheme(next)
    paintWindowChrome(effectiveTheme(next), prevTheme.colors.bg)
    /*
     * Load-bearing, not merely correct in advance.
     *
     * Recall's cache is keyed on which boards are switched *on* (see cacheKey
     * in recall.ts), not on their ids, so toggling a board already misses the
     * cache key on its own — editing an id in place would not, since the key
     * is unchanged. That is the bug this call is written to prevent: a stale
     * read of the *old* Notion data source or ClickUp list served for up to
     * RECALL_TTL_MS after the user points the setting at a different board.
     *
     * `runWorklogScan`'s recall() call now passes
     * settings.worklogBoards.notionDataSource / .clickupListId directly, not
     * the compiled-in CLICKUP_LIST_ID / NOTION_DATA_SOURCE constants — so an
     * id typed into this settings panel is exactly the thing a cached recall
     * snapshot can go stale against, and this comparison is what keeps it
     * from doing so. Cheap regardless of that: a settings write happens far
     * less often than a scan runs.
     */
    if (
      next.worklogBoards.notionDataSource !== prev.worklogBoards.notionDataSource ||
      next.worklogBoards.clickupListId !== prev.worklogBoards.clickupListId
    ) {
      invalidateRecall()
    }
    send(CH.settingsChanged, next)
    return next
  })

  /* -------------------------------------------------------------- profiles */
  /*
   * Creating a profile writes a folder and a scan root, so it happens here and
   * the renderer only ever sees the plan and the resulting settings. `plan` is
   * a dry run: the UI shows what will happen before anything is written.
   */
  ipcMain.handle(CH.profilesPlan, (_e, folder: string, name: string) => planProfile(folder, name))
  ipcMain.handle(CH.profilesCreate, async (_e, input: CreateProfileInput) => {
    const { patch } = await createProfile(getSettings(), input)
    const next = setSettings(patch)
    send(CH.settingsChanged, next)
    /*
     * The new root only becomes visible once its children have been scanned,
     * and nothing here does that scan. CH.sessionsChanged is declared for
     * exactly this shape of problem but has no preload bridge and no
     * renderer listener anywhere in the app - a send here would reach
     * nobody. Follow the pattern every other project-list mutation already
     * uses (openFolder, addRoot in App.tsx): the renderer calls
     * refreshProjects() itself once profiles.create() resolves - see
     * ProfilesSettings.tsx's create(). Do not re-add a send() here without
     * also wiring a preload bridge and a renderer subscriber, or this is
     * the exact "did nothing" bug again.
     */
    return next
  })

  /* ------------------------------------------------------------------- ssh */
  ipcMain.handle(CH.sshHosts, () => readSshConfigHosts())

  /* ------------------------------------------------------------------ tabs */
  ipcMain.on(CH.tabsSave, (_e, state: StoredTabs) => {
    lastTabState = state
    writeTabState(tabStateFile(app.getPath('userData')), state)
  })

  ipcMain.handle(CH.tabsRestore, () => readTabState(tabStateFile(app.getPath('userData'))))

  /* --------------------------------------------------------------- worklog */
  /*
   * Both runs cost money and can fail, so every handler returns a result object
   * rather than throwing across the bridge - a rejected invoke in the renderer
   * arrives as an opaque Error string and the panel could not tell "nothing to
   * propose" from "the run broke".
   */
  const queue = worklogQueue

  ipcMain.handle(CH.worklogQueue, () => queue().list())

  ipcMain.handle(CH.worklogWatch, () => watchStates())

  ipcMain.handle(CH.worklogScan, async (_e, sessionId: string) => {
    const report = await runWorklogScan(sessionId, false)
    // The panel reads the full report off `worklog:scanned`; this return value
    // stays the shape it always was so the existing caller is untouched, and
    // `error` here is what App.tsx puts in the red `role="alert"` banner.
    //
    // `report.message` alone is NOT the right condition any more (Task 29
    // review, finding 1) — the empty-transcript fix above now puts a message
    // on a 'nothing' outcome too, and pressing Scan on a session that has not
    // sent anything yet is not a failure; it is the exact case the calm state
    // line exists to explain. Surfacing it here would put a red alert on a
    // scan that worked perfectly.
    //
    // So `outcome`, not `message`, decides: null for every 'nothing', whether
    // or not it carries an explanation; non-null for 'budget', for 'error',
    // and for a 'proposed' scan whose drafts were written without a look at
    // the boards first (H5) — those are the only cases actually worth a red
    // banner. An ordinary successful 'proposed' still leaves it null, because
    // `message` is null there too.
    const error = report.outcome === 'nothing' ? null : report.message
    return { added: report.added, error }
  })

  /*
   * The work report: what was worked on, per day and per project.
   *
   * Reads only what is already on this machine — Claude Code's own transcripts,
   * plus git where a repository happens to exist. No model runs and nothing
   * leaves the laptop, which is why it answers in milliseconds where the
   * worklog's scan-and-write path took tens of seconds and real money.
   */
  ipcMain.handle(CH.activityRead, async (_e, from: number, to: number) => {
    const settings = getSettings()
    const projects = await listProjects(settings)

    /*
     * Display names are derived here rather than in the renderer because they
     * have to be unique: `commits` is keyed `project|day`, so two watched
     * folders sharing a leaf name would collide and one project's commits would
     * appear under the other. `projectRoots` holds both `/dev/work` and
     * `/dev/work/Work` on this machine, which is exactly the shape that
     * produces a duplicate leaf.
     */
    const nameFor = new Map<string, string>()
    const taken = new Set<string>()
    const watched: string[] = []
    for (const project of projects) {
      const group = groupForCwd(project.path, projects, settings.projectRoots)
      // The same gate the worklog uses, so the existing setting keeps meaning
      // what it meant — and so personal work cannot reach a screen whose whole
      // purpose is being shown to somebody else.
      if (!isWatchedGroup(group, settings.worklogGroups)) continue
      watched.push(project.path)
      let name = basename(project.path) || project.path
      if (taken.has(name)) name = `${basename(dirname(project.path))}/${name}`
      taken.add(name)
      nameFor.set(project.path, name)
    }

    const inputs: ActivitySessionInput[] = []
    for (const path of watched) {
      for (const session of await listSessions(path)) {
        inputs.push({
          sessionId: session.id,
          file: session.file,
          project: nameFor.get(path) ?? path,
          title: session.title,
          // Lets readActivity skip a transcript last written before the period
          // without opening it at all.
          modified: session.modified
        })
      }
    }

    const { slices, skipped } = await readActivity(inputs, { from, to })

    /*
     * Git is additive and must never hold the report up: every lookup runs in
     * parallel and each carries its own timeout inside commitSubjects. A slow
     * or missing repository costs its own subjects and nothing else.
     */
    const pathFor = new Map([...nameFor].map(([path, name]) => [name, path]))
    const wanted = [...new Set(slices.map((s) => `${s.project}|${s.day}`))]
    const resolved = await Promise.all(
      wanted.map(async (key): Promise<[string, string[]]> => {
        const cut = key.lastIndexOf('|')
        const dir = pathFor.get(key.slice(0, cut))
        return [key, dir ? await commitSubjects(dir, key.slice(cut + 1)) : []]
      })
    )
    const commits: Record<string, string[]> = {}
    for (const [key, list] of resolved) if (list.length) commits[key] = list

    return { slices, commits, skipped, idleGapMs: IDLE_GAP_MS }
  })

  ipcMain.handle(CH.worklogLastScan, () => lastScanReport)

  /*
   * Accepts in flight, by proposal id.
   *
   * The renderer disables its buttons while one runs, but there are now two
   * independent controls that can accept the same proposal — the panel and the
   * auto-scan prompt — and a renderer flag is not a lock anyway. Two invokes
   * arriving together would each read a proposal with no urls yet and each run
   * the write, creating the record twice in a live workspace. Nothing else in
   * this file can undo that, so the guard belongs here.
   */
  const accepting = new Set<string>()

  ipcMain.handle(CH.worklogAccept, async (_e, id: string) => {
    const q = queue()
    const item = q.list().find((p) => p.id === id)
    if (!item) return { ok: false, error: 'that proposal is no longer in the queue' }
    if (item.status === 'accepted') return { ok: true, error: null }
    if (item.status === 'rejected') return { ok: false, error: 'that proposal was rejected' }
    if (accepting.has(id)) return { ok: false, error: 'that proposal is already being written' }
    accepting.add(id)
    try {
      const settings = getSettings()
      const outcome = await applyProposal(item, {
        // All three were missing before this task. Without claudePath a user
        // with an explicit path in Settings got auto-detection instead;
        // without a budget the write sat on the CLI's default; without boards
        // it wrote to a destination the user may have switched off.
        claudePath: settings.claudePath,
        maxBudgetUsd: APPLY_MAX_BUDGET_USD,
        // The user's own switches and ids, not the shipped default — a board
        // switched off in Settings must not still receive the write, and an
        // edited id must be the one actually written to. hydrateSettings has
        // already dropped any target whose id is empty, so this is trusted
        // rather than re-validated (see settingsSchema.ts).
        boards: settings.worklogBoards,
        // Persist each URL the moment its write returns, so a failure on the
        // second destination cannot lose the first - and so a retry can tell
        // what has already been written and skip it.
        onWritten: async (target, url) => {
          if (!url) return
          const current = q.list().find((p) => p.id === id)
          q.update(id, { urls: { ...(current?.urls ?? {}), [target]: url } })
          send(CH.worklogChanged, q.list())
        }
      })
      const errors = Object.values(outcome.errors)
      q.update(id, {
        status: outcome.ok ? 'accepted' : 'failed',
        urls: { ...(q.list().find((p) => p.id === id)?.urls ?? {}), ...outcome.urls },
        error: errors.join('; ')
      })
      /*
       * The boards have moved, so the cached reading of them is stale.
       *
       * This matters more than it looks: the record just written is the one the
       * next scan most needs to know about. Left cached, that record stays
       * invisible for the rest of the TTL and the next scan of the same session
       * proposes creating it all over again - which is the exact duplication
       * recall was added to prevent.
       */
      if (Object.keys(outcome.urls).length) invalidateRecall()
      send(CH.worklogChanged, q.list())
      return { ok: outcome.ok, error: errors.join('; ') || null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      q.update(id, { status: 'failed', error: message })
      send(CH.worklogChanged, q.list())
      return { ok: false, error: message }
    } finally {
      accepting.delete(id)
    }
  })

  ipcMain.handle(CH.worklogReject, (_e, id: string) => {
    queue().reject(id)
    send(CH.worklogChanged, queue().list())
  })

  /* ----------------------------------------------------------------- audio */
  ipcMain.handle(CH.micCheck, () => checkMicrophone())

  /*
   * Desktop dictation. The renderer records and encodes the WAV — it has the
   * microphone and the audio APIs — but does not reach the speech server, which
   * has no authentication of its own. Same boundary the phone's
   * `/api/transcribe` route enforces, and `stt.ts` is the single implementation
   * behind both.
   *
   * The settings read happens per call rather than being captured, so changing
   * the address takes effect on the next dictation instead of the next launch.
   */
  ipcMain.handle(CH.transcribe, async (_e, wav: ArrayBuffer) => {
    return transcribe(getSettings().remote?.sttUrl, new Uint8Array(wav))
  })

  /* ------------------------------------------------------------- clipboard */
  /*
   * Read synchronously. xterm's key handler must decide whether to swallow a
   * paste before it returns, so an async round trip would always land a
   * keystroke too late. Reading the clipboard is microseconds, so blocking the
   * renderer for it is cheaper than the alternative of caching and going stale.
   *
   * hasImage is what lets plain Ctrl+V fall through to Claude Code's own image
   * handler: the CLI reads the image off the OS clipboard itself, so no image
   * bytes ever have to cross the PTY.
   */
  ipcMain.on(CH.clipboardRead, (e) => {
    e.returnValue = {
      text: clipboard.readText(),
      hasImage: !clipboard.readImage().isEmpty()
    }
  })
  ipcMain.on(CH.clipboardWrite, (_e, text: string) => {
    if (typeof text === 'string' && text) clipboard.writeText(text)
  })

  /* ------------------------------------------------------------------ misc */
  ipcMain.on(CH.openExternal, (_e, url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle(CH.wallpaperPick, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const path = await storeWallpaper(app.getPath('userData'), res.filePaths[0])
    const s = getSettings()
    const next = setSettings({ wallpaper: { ...s.wallpaper, path } })
    send(CH.settingsChanged, next)
    return next
  })

  ipcMain.handle(CH.wallpaperClear, async () => {
    await clearWallpaper(app.getPath('userData'))
    const s = getSettings()
    const next = setSettings({ wallpaper: { ...s.wallpaper, path: null } })
    send(CH.settingsChanged, next)
    return next
  })

  ipcMain.handle(CH.pickFolder, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
}

/*
 * An unpackaged run gets its own data directory.
 *
 * The single-instance lock and the settings file are both keyed on userData, so
 * a dev build previously fought the installed app for both: launching one while
 * the other ran made the new process quit on the spot, and any dev run that did
 * start wrote through the same settings.json. The workaround was to remember a
 * --user-data-dir flag on every launch, which electron-vite gives no way to pass
 * anyway.
 *
 * Must happen before requestSingleInstanceLock, which reads the path.
 * STOKE_USER_DATA overrides, for running two dev copies side by side.
 *
 * An explicit --user-data-dir always wins. Without that guard this silently
 * ignored the flag and booted a different profile than the one asked for, which
 * is a confusing way to lose an afternoon: the app starts, looks fine, and none
 * of the settings under test are loaded.
 */
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', process.env.STOKE_USER_DATA || `${app.getPath('userData')} (dev)`)
}

// A second launch should focus the existing window rather than open a rival one
// that fights over the same PTYs and settings file.
/*
 * The wallpaper scheme. Registered before `ready`, which is the only time
 * Electron accepts it, and privileged so the renderer's CSP can name it and
 * `img-src` can load from it. It serves exactly one directory (see
 * wallpaper.ts); a `file://` URL would have needed the whole filesystem open.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: WALLPAPER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    protocol.handle(WALLPAPER_SCHEME, (request) => {
      const file = wallpaperFileFor(app.getPath('userData'), request.url)
      if (!file) return new Response('not found', { status: 404 })
      return net.fetch(pathToFileURL(file).toString(), { headers: { 'content-type': mimeFor(file) } })
    })
    registerIpc()
    createWindow()
    /*
     * The only sweep for statusLine files that a crash, a SIGKILL or a failed
     * launch left behind on a previous run — see statusLine.ts for why it is
     * age-based rather than a blanket wipe. Once per boot, before any session
     * (and so before any fresh file this run could mistake for stale) exists.
     *
     * AFTER createWindow, not before it. The sweep is `readdirSync` plus up to
     * two more synchronous fs calls per entry across two passes, and it ran on
     * the boot path immediately before the window was built — so every one of
     * those blocked the event loop while nothing was on screen yet. Gotcha 40's
     * pattern exactly, in the one place a stall is most visible.
     *
     * Moving it is enough, and is safer than making it async: what correctness
     * requires is only that it finish before a session can start, and a session
     * cannot start before the window exists and the user has acted on it. The
     * ordering it must not lose — sweeping before any file THIS run writes — is
     * preserved, because createWindow starts no session by itself.
     */
    sweepStaleSessionFiles()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  app.on('before-quit', () => {
    if (lastTabState) writeTabState(tabStateFile(app.getPath('userData')), lastTabState)
    // Settings coalesce bursts of writes (see store.ts). Anything still waiting
    // is written here rather than lost with the process.
    flushSettings()
    /*
     * A lock left behind on ~/.claude.json stalls every CLI config write for
     * the ten seconds it takes to go stale. The writer already releases in a
     * `finally`; this covers a quit landing mid-write.
     */
    releaseHeldLocks()
    ptys?.killAll()
    watcher?.disposeAll()
    mcp?.stop()
    void remote?.stop()
    tunnel.stop()
  })
}
