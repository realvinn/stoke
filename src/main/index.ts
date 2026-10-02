import './threadPool.ts'
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  screen,
  shell,
  systemPreferences
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { CH } from '@shared/ipc'
import { activeThemeId, resolveTheme } from '@shared/themes'
import { revealInsetFor, revealsOnEntry } from '@shared/fullScreenReveal'
import { DEFAULT_BROWSER_PROFILE_ID, newProfileId, nextProfileLabel } from '@shared/browserProfiles'
import type { RevealInfo } from '@shared/fullScreenReveal'
import type {
  CliUpdateState,
  LaunchOptions,
  ProjectMeta,
  Rect,
  Settings,
  SshAuthPromptEvent,
  SshEnrollEvent,
  RemoteSessionList,
  SshHost,
  StatusLineSnapshot,
  LiveSessionState,
  SessionRebind,
  StoredTabs,
  Theme,
  UsageBoard,
  UsageReadReason,
  UsageTarget,
  WorklogScanOutcome,
  WorklogScanReport,
  WorklogWatchState
} from '@shared/types'
import { EmbeddedBrowser } from './browser.ts'
import { clearWallpaper, mimeFor, storeWallpaper, WALLPAPER_SCHEME, wallpaperFileFor } from './wallpaper.ts'
import {
  buildEnvPath,
  detectCodingClis,
  findClaude,
  forgetIdentities,
  forgetLoginPath,
  loginShellPathValue,
  probeClaude,
  rememberLoginPathIn,
  resumeOrMint
} from './cli.ts'
import { scanSkills } from './skillsScan.ts'
import { ClaudeSkillsProjector } from './skillsProject.ts'
import {
  ClaudeConfigReader,
  McpFileStore,
  readMcpCatalog,
  resolveAccountMirror,
  resolveLaunchMcp,
  type LaunchMcp
} from './mcpLaunch.ts'
import {
  accountMcpSummary,
  claudeAccountServers,
  claudeMcpConfigs,
  PI_MCP_EXTENSION,
  type AccountMcpSummary,
  type McpRefusal
} from '../shared/mcpServers.ts'
import { ContextWatcher } from './context.ts'
import {
  findSessionFile,
  listProjects,
  listSessions,
  migrateSymlinkedProjectKeys,
  projectsRoot
} from './projects.ts'
import { indexSessions } from './sessionIndex.ts'
import { IDLE_GAP_MS, readActivity, type ActivitySessionInput } from './activity.ts'
import { commitSubjects } from './activityGit.ts'
import { manualProjectPatch, projectMetaPatch } from './projectMeta.ts'
import { isInside, normalizePath, pathKey, pathRulesFor } from '../shared/paths.ts'
import { ChatIndexHost } from './chatIndex/host.ts'
import type { SourceEnv } from './chatIndex/sources.ts'
import chatWorkerPath from './chatIndex/worker.ts?modulePath'
import { CHAT_SEARCH_MIN_CHARS, type ChatImportResult, type ChatIndexStatus } from '../shared/chatIndex.ts'
import {
  folderOf,
  folderProblem,
  parseStokeArgs,
  requestFrom,
  withDefaultCli,
  withFolder,
  type StokeCliRequest
} from '../shared/stokeArgs.ts'
import { installCommand, readCommandState, removeCommand, type CommandEnv } from './stokeCommand.ts'
import { keepUsage } from '../shared/statusLine.ts'
import { emptyRemoteView } from '../shared/hub/remote.ts'
import {
  advertisedRemoteToken,
  livePushSubscriptions,
  pushSubscriptionKey,
  rememberGonePush,
  shouldRestartRemote,
  withPushSubscription
} from '../shared/remotePhone.ts'
import { parseSession, readTranscript } from './sessionFile.ts'
import { fetchRemoteTranscript } from './sshTranscript.ts'
import { PtyManager, type StartResult } from './pty.ts'
import { checkMicrophone } from './audio/defaultDevice.ts'
import { CODING_CLIS, capsFor, cliIdOf, isClaudeCode, isCodingCliId, type CodingCliId } from '../shared/codingClis.ts'
import {
  agentLaunchPlan,
  installedAgents,
  PI_PROVIDER_EXTENSION,
  resolveDefaultAgent,
  visibleAgents,
  type LaunchPlan
} from '../shared/agents.ts'
import { claudeVoiceEnabled, isMicAccess, type MicAccess } from '../shared/voiceRoute.ts'
import { testSpeechService, transcribe } from './stt.ts'
import { sttConfigFrom, sttConfigOf, sttReadiness } from '../shared/speechProviders.ts'
import { createProfile, planProfile } from './profiles.ts'
import { readSshConfigHosts } from './ssh.ts'
import { endRemoteSession, listRemoteSessions } from './sshSessions.ts'
import { registerSshImageHandlers } from './sshImages.ts'
import { hostPersists, isSafeRemoteSessionName, mintRemoteSessionName } from '../shared/sshPersist.ts'
import { shouldOfferKey } from '../shared/sshAuth.ts'
import { EnrollRuns } from './enrollRuns.ts'
import {
  consumeUpdateRestart,
  readTabState,
  tabStateFile,
  updateRestartFile,
  writeTabState,
  writeUpdateRestart
} from './tabStore.ts'
import { readProcessTable, RegistryPoller } from './sessionRegistry.ts'
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
import type { CliRunResult, RemoteSessionStarted, RemoteState, StokeCommandState, VoiceState } from '@shared/api'
import { flushSettings, getSettings, initSecretStore, onSettingsChanged, secretStoreStatus, setSettings } from './store.ts'
import { hydrateSettings } from './settingsSchema.ts'
import { defaultSetupName, openSetup, sealSetup } from './setupFile.ts'
import {
  buildSetupPayload,
  judgePassphrase,
  parseSetupEnvelope,
  planImport,
  portableSecrets,
  SETUP_EXTENSION,
  type SetupPayload
} from '@shared/setupFile'
import {
  gitBashPath,
  readSessionEvents,
  readStatusLine,
  sweepStaleSessionFiles,
  userStatusLineCommand,
  windowFor,
  writeSessionSettingsFile
} from './statusLine.ts'
import { createScratchDir, resolveDefaultCwd } from './workspace.ts'
import { launchFolderProblem, realpathFolder } from './folderCheck.ts'
import { BrowserMcpServer } from './mcp/server.ts'
import { connectTarget, generateToken, RemoteServer, tailnetAddress, type RemoteDeps, type RemotePushDeps } from './remote/server.ts'
import { generateVapidKeys, isVapidPair, sendPush } from './remote/push.ts'
import { TunnelManager } from './remote/tunnel.ts'
import { discoverAccess } from './remote/accessJwt.ts'
import { ACCESS_STATUS_OFF, type AccessLookup } from '../shared/cfAccess.ts'
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
import { planUsageSources, readUsageSource, toReading, USAGE_FLOORS, UsageScheduler, usagePlanInput } from './usageBoard.ts'
import { CLAUDE_DEFAULT_KEY, usageKey, usageRouteFor } from '../shared/usageSources.ts'
import { patchClaudeSetting, readClaudeSettings, readLaunchDefaults, untouchedKeys } from './claudeSettings.ts'
import {
  readGlobalConfigKey,
  releaseHeldLocks,
  writeGlobalConfigKey
} from './claudeGlobalConfig.ts'
import { claudeConfigDir, claudeGlobalConfigPath } from './claudePaths.ts'
import {
  accountsRoot,
  defaultTrees,
  makeAccountHome,
  readClaudeAccountEmail,
  repairAccountHome,
  updateAccountIndex
} from './accounts.ts'
import {
  accountEnv,
  accountIdFor,
  accountKindsFor,
  accountProblem,
  accountsFromRenderer,
  accountsOf,
  accountSlug,
  cleanAccountLabel,
  loginArgsFor,
  nextSwatch,
  DEFAULT_ACCOUNT_ID,
  isAccountId,
  resolveLaunchAccount,
  type AgentAccount
} from '../shared/accounts.ts'
import { agentSeed } from '../shared/agentColors.ts'
import type { AccountCreateInput, AccountCreateResult } from '@shared/api'
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
let registry: RegistryPoller | null = null
/**
 * How often the registry is read. A second is the ceiling on how late a
 * rebind or an idle can be noticed — well under the time it takes to reach
 * for the relaunch pill after a `/clear`.
 */
const REGISTRY_POLL_MS = 1000
let autoscan: AutoScanner | null = null
let mcp: BrowserMcpServer | null = null
/** Path of the generated --mcp-config file; null until the server is up. */
let mcpConfigPath: string | null = null
/**
 * Builds the `--plugin-dir` that lends a local Claude session the shared
 * skills (skillsProject.ts). Created on the first Claude launch, because it is
 * keyed on userData, and kept: the sets it handed out this run are in its memory.
 */
let skillsProjector: ClaudeSkillsProjector | null = null
/**
 * Claude Code's own MCP list, read at each launch that needs it and cached on
 * the file's mtime (mcpLaunch.ts). Read-only: `~/.claude.json` is never written
 * for MCP (gotcha 38), and never through claudeGlobalConfig's sync reader
 * (gotcha 40).
 */
const claudeConfigReader = new ClaudeConfigReader()
/** The owner-only MCP files Qwen, Copilot and Claude Code are pointed at; keyed on userData, so made on first use. */
let mcpFiles: McpFileStore | null = null
let remote: RemoteServer | null = null
/**
 * The phone server's handlers as the hub relay serves them to the owner's
 * other machines (src/main/hub/remote.ts, spec §6.4): a second RemoteServer
 * that is never `start`ed, so it binds nothing and runs whether or not Phone
 * access is on, and whose attached sockets are relayed ones only. Made on the
 * first relayed request or status.
 */
let relayServer: RemoteServer | null = null
function relayRemote(): RemoteServer {
  if (!relayServer) {
    relayServer = new RemoteServer(remoteDeps())
    relayServer.serveRelay()
  }
  return relayServer
}
/**
 * Stoke Hub's client (hub/service.ts), made on first use — a hub panel opened,
 * or a boot with a hub configured — and loaded lazily, never by a static
 * import (gotcha 40: it pulls in node:crypto work, the ssh helpers and `ws`).
 */
let hubClient: import('./hub/service.ts').HubService | null = null

/* ------------------------------------------------------------ chat history */

/**
 * The chat index's worker handle (chatIndex/host.ts), made on first use. Every
 * read of a chat and every write of the store happens in that worker; nothing
 * here does more than post a message.
 */
let chatIndex: ChatIndexHost | null = null
/** First pass after boot: out of the way of everything boot does (gotcha 40). */
const CHAT_BOOT_DELAY_MS = 30_000
/** Then every fifteen minutes while the app is open, and on focus at most every five. */
const CHAT_PASS_EVERY_MS = 15 * 60_000
const CHAT_FOCUS_FLOOR_MS = 5 * 60_000
let chatPassTimer: ReturnType<typeof setTimeout> | null = null

function chatHost(): ChatIndexHost {
  chatIndex ??= new ChatIndexHost({
    workerPath: chatWorkerPath,
    dir: join(app.getPath('userData'), 'chat-index'),
    onStatus: (s) => send(CH.chatsStatus, chatStatusFor(s)),
    onError: (err) => console.error('[stoke] chat index:', err.message)
  })
  return chatIndex
}

/** The status with the setting's word on it: a store can exist while indexing is off. */
function chatStatusFor(s: ChatIndexStatus): ChatIndexStatus {
  return getSettings().chatIndex === 'on' || s.state === 'running' ? s : { ...s, state: 'off' }
}

/** Where the sources are: this user's home and the overrides the tools themselves honour. */
function chatEnv(): SourceEnv {
  const e = process.env
  return {
    home: homedir(),
    platform: process.platform,
    env: {
      CLAUDE_CONFIG_DIR: e.CLAUDE_CONFIG_DIR,
      CODEX_HOME: e.CODEX_HOME,
      XDG_DATA_HOME: e.XDG_DATA_HOME,
      XDG_CONFIG_HOME: e.XDG_CONFIG_HOME,
      APPDATA: e.APPDATA,
      LOCALAPPDATA: e.LOCALAPPDATA
    }
  }
}

/** Start a pass when indexing is on; a pass already running takes this as its follow-up. */
function runChatPass(): void {
  const s = getSettings()
  if (s.chatIndex !== 'on') return
  chatHost()
    .scan({ env: chatEnv(), options: s.chatIndexOptions })
    .catch((err: Error) => console.error('[stoke] chat index pass failed:', err.message))
}

/** One pass `delay` from now, replacing any already waiting — a burst of setting changes is one pass. */
function scheduleChatPass(delay: number): void {
  if (chatPassTimer) clearTimeout(chatPassTimer)
  chatPassTimer = setTimeout(() => {
    chatPassTimer = null
    runChatPass()
  }, delay)
}
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
/**
 * Every usage source's cache, attempt time and backoff, PER SOURCE AND
 * ACCOUNT (usageBoard.ts). One account's 429 pauses that account only, and
 * one account's last good figures are never kept in another's place.
 *
 * The attempt time is not the cache's `fetchedAt`: they came apart when a
 * failed read stopped throwing the last good numbers away — the cache keeps
 * the timestamp of the data it holds, so the scheduler needs its own record
 * of when it last knocked, or a stale-but-good reading would look overdue and
 * be re-fetched on every single poll, turning one rate limit into a permanent
 * one. The floors (`USAGE_FLOORS`): Anthropic's 30s idle cadence and 5s
 * message floor are the chip's long-standing ones — `POLL_MS` in
 * UsageMeter.tsx is the same 30s from the other side.
 */
const usageScheduler = new UsageScheduler()

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
 * The newest statusLine reading seen this run PER ACCOUNT, whichever of that
 * account's sessions produced it.
 *
 * The rate limits in a payload are the ACCOUNT's, so any open session of an
 * account answers for all of its sessions — and for no other account's. One
 * slot for every account (as this was until accounts) would have let a
 * second Claude sign-in's payload stand in for the first's. Keeping one per
 * account also means the chip still has figures once every tab is closed,
 * which is the whole "as of HH:MM" case.
 */
const lastStatusLines = new Map<string, StatusLineSnapshot>()

/** File a payload under the account its session runs on, and keep its rate limits (`keepUsage`). */
function fileStatusLine(snap: StatusLineSnapshot): void {
  const account = snap.accountId || DEFAULT_ACCOUNT_ID
  lastStatusLines.set(account, keepUsage(lastStatusLines.get(account) ?? null, snap))
}

/** A payload read from the key's files, stamped with the account of the session that owns the key. */
function readAccountStatusLine(key: string): StatusLineSnapshot | null {
  const read = readStatusLine(key)
  return read ? { ...read, accountId: ptys?.accountIdForKey(key) ?? DEFAULT_ACCOUNT_ID } : null
}
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
  // Through the launch key: a rebound session's files are named after the id
  // it was LAUNCHED with, not the one it is on now. See `payloadKeyFor`.
  const key = payloadKeyFor(sessionId)
  // Stamped with the session's account, so its rate limits are filed — here
  // and in the renderer — under that account and no other.
  const snap = readAccountStatusLine(key)
  if (!snap) return
  if (statusLineSeen.get(sessionId) === snap.receivedAt) return
  statusLineSeen.set(sessionId, snap.receivedAt)
  // Same rule as refreshStatusLine: the newer reading wins for everything
  // per-session, but the account's two rate limits are RETAINED when the
  // newer payload states none — otherwise opening a tab evicts a live
  // session's figures, because a payload carries no rate limits until its
  // first render after an API response. See `keepUsage`.
  fileStatusLine(snap)
  send(CH.statusLineUpdate, snap)
}

/**
 * The name a session's statusLine files go by.
 *
 * The launch key, which is the session id for every session until it is
 * rebound — `/clear`, an in-TUI `/resume`, or a `--continue`'s real id arriving
 * (see sessionRegistry.ts). After that the id and the file name differ, and a
 * reader keyed on the id alone would find nothing: no payload, so no version
 * for the relaunch pill and no stated window for the meter. Falls back to the
 * id itself for a session with no live pty.
 */
function payloadKeyFor(sessionId: string): string {
  return ptys?.statusKeyFor(sessionId) ?? sessionId
}

/**
 * Bring `lastStatusLines` up to date from every live session's payload file.
 *
 * `pushStatusLine` above only runs for sessions the context watcher watches,
 * which is every session Stoke minted an id for — but not a `--continue`,
 * whose id the CLI chooses after launch and which is therefore watched by
 * nothing. Its payload exists all the same, under its launch key.
 *
 * That matters because the rate limits in a payload are ACCOUNT-wide: any open
 * session of an account answers for all of that account's. Without this, the one launch path we cannot
 * predict is also the one that contributes no usage figures at all.
 *
 * Called from the `statusline:last` invoke, not on a timer: the chip asks when
 * it opens, and a handful of small reads on demand is cheaper than polling
 * files that are rewritten three times a second anyway.
 */
function refreshLastStatusLine(): void {
  for (const key of ptys?.statusKeys() ?? []) {
    const snap = readAccountStatusLine(key)
    if (snap) fileStatusLine(snap)
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
 * The last context window a session was seen reading, kept for the life of
 * this run even after the session ends. See the comment where it is written,
 * in the `ContextWatcher` constructor below.
 */
const lastContextLimit = new Map<string, number>()

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
 * Hosts with a key enrollment running, from the press until the probe after
 * its tab exits. Claimed in `startEnrollSession` before its first await and
 * refused on re-entry (gotchas 20, 51, 66): two presses would otherwise open
 * two tabs, both asking for the same password, and race two `ssh-keygen`s over
 * one file name. Read synchronously by the offer (`shouldOfferKey`'s
 * `inFlight`), which is decided inside `PtyManager`'s data callback.
 */
const enrolling = new Set<string>()

/**
 * The enrollment tab behind each pty, each proven once: when it prints that the
 * install ran to its end, or when its process exits (`EnrollRuns`, enrollRuns.ts).
 */
const enrollRuns = new EnrollRuns()

/** How long an install tab's process may linger once its result is proven, before it is stopped. */
const ENROLL_LINGER_MS = 1500

/**
 * An install tab printed that the install ran to its end: prove it now rather
 * than waiting for an exit that may never come (2026-10-02, the owner's other
 * computer). A process still there once the result is out is stopped — what it
 * was for is done, and the tab keeps its words either way.
 */
function enrollOutput(ptyId: string, data: string): void {
  const run = enrollRuns.output(ptyId, data)
  if (!run) return
  void finishEnrollRun(run, 0, undefined).then(() => {
    setTimeout(() => void ptys?.stop(ptyId, 3000), ENROLL_LINGER_MS)
  })
}

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

/**
 * Pi's provider extension for a custom endpoint, written under Stoke's own
 * userData — never into `~/.pi`. Constant text (agents.ts), so it is rewritten
 * only when missing or different, and holds no secret: the endpoint and key
 * reach Pi through the environment. Null if it cannot be written, which the
 * launch plan turns into a sentence rather than a Pi that ignores the setting.
 */
async function piExtensionFile(): Promise<string | null> {
  const file = join(app.getPath('userData'), 'agents', 'pi-provider.ts')
  try {
    const current = await readFile(file, 'utf8').catch(() => null)
    if (current !== PI_PROVIDER_EXTENSION) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, PI_PROVIDER_EXTENSION, 'utf8')
    }
    return file
  } catch {
    return null
  }
}

/**
 * The MCP servers one local launch hands its agent (mcpServers.ts): Stoke's
 * browser server when it is ticked and up, then the servers the user ticked for
 * this agent — Claude Code's own list read afresh for this folder, or ones
 * Stoke holds. Empty for an agent with no launch-time route. What could not be
 * handed over is logged by name and reason, never by value.
 */
async function launchMcpFor(cliId: CodingCliId, cwd: string): Promise<LaunchMcp> {
  if (capsFor(cliId).mcp === 'none') return { servers: [], own: [], keep: [] }
  try {
    return await resolveLaunchMcp({
      cliId,
      cwd,
      mcp: getSettings().agents.mcp,
      browser: mcp?.spec() ?? null,
      reader: claudeConfigReader
    })
  } catch (err) {
    // A launch never dies of its tools. It goes with none — not the browser
    // alone: for Kimi that would name a file without the user's own beside it.
    console.error('[stoke] could not resolve MCP servers for a launch', err)
    return { servers: [], own: [], keep: [] }
  }
}

/**
 * `~/.claude.json` as a second Claude account's CLI reads it: its home as
 * `CLAUDE_CONFIG_DIR`, exactly the variable its launch gets (`accountEnv`).
 * One cached reader per home, like the Default's.
 */
const accountConfigReaders = new Map<string, ClaudeConfigReader>()
function accountConfigReader(home: string): ClaudeConfigReader {
  let r = accountConfigReaders.get(home)
  if (!r) {
    r = new ClaudeConfigReader({ ...process.env, CLAUDE_CONFIG_DIR: home }, homedir())
    accountConfigReaders.set(home, r)
  }
  return r
}

/**
 * The Default account's user-scope servers a second Claude account is handed
 * (`resolveAccountMirror`), for one launch folder or — `cwd` null — for its
 * row in Settings. Never throws: a launch never dies of its tools.
 */
async function accountMirrorFor(account: AgentAccount, cwd: string | null): ReturnType<typeof resolveAccountMirror> {
  try {
    return await resolveAccountMirror({ cwd, defaultReader: claudeConfigReader, accountReader: accountConfigReader(account.home) })
  } catch (err) {
    console.error('[stoke] could not read MCP servers for an account', err)
    return { mirror: { servers: [], own: [], refused: [], accountNames: [] }, error: 'Its MCP servers could not be read.' }
  }
}

/** What each Claude login account's row says about the Default account's servers (`CH.accountsMcp`). */
async function accountsMcp(): Promise<Record<string, AccountMcpSummary>> {
  const out: Record<string, AccountMcpSummary> = {}
  const claude = Object.values(getSettings().accounts).filter((a) => a.cli === 'claude' && a.kind === 'login')
  const reads = await Promise.all(claude.map((a) => accountMirrorFor(a, null)))
  claude.forEach((a, i) => {
    out[a.id] = accountMcpSummary(reads[i].mirror, reads[i].error)
  })
  return out
}

/**
 * Pi's MCP extension (mcpServers.ts `PI_MCP_EXTENSION`), under Stoke's own
 * userData — never into `~/.pi`. Constant text holding no secret, rewritten
 * only when missing or different. Null when it cannot be written, and Pi then
 * goes without MCP rather than with a flag naming nothing.
 */
async function piMcpExtensionFile(): Promise<string | null> {
  const file = join(app.getPath('userData'), 'agents', 'pi-mcp.ts')
  try {
    if ((await readFile(file, 'utf8').catch(() => null)) !== PI_MCP_EXTENSION) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, PI_MCP_EXTENSION, 'utf8')
    }
    return file
  } catch {
    return null
  }
}

function logMcpSkipped(cliId: CodingCliId, skipped: readonly McpRefusal[] | undefined): void {
  for (const s of skipped ?? []) console.warn(`[stoke] ${cliId} was not handed MCP server "${s.name}": ${s.reason}`)
}

/**
 * Whether a transcript exists for this session id, on this machine.
 *
 * Both roots: `projectsRoot()` now follows an inherited `CLAUDE_CONFIG_DIR`
 * too, so the two are usually one (the Set folds them), and an account's own
 * `projects` is a link into that same tree (accounts.ts) — so a conversation
 * started on one account resumes on another. Answering "no transcript" wrongly is
 * the expensive direction — `resumeOrMint` would then pass `--session-id` for a
 * conversation that exists and the CLI refuses it — so a hit in EITHER root
 * counts.
 */
async function transcriptExists(sessionId: string): Promise<boolean> {
  const roots = [...new Set([projectsRoot(), join(claudeConfigDir(process.env, homedir()), 'projects')])]
  const found = await Promise.all(roots.map((r) => findSessionFile(sessionId, r)))
  return found.some((f) => f !== null)
}

/**
 * Starting a session, shared by the renderer's IPC and the remote server.
 *
 * `origin` is 'remote' for exactly one caller: `RemoteDeps.startSession`,
 * which is what `POST /api/sessions` calls. That is the only path that needs
 * `CH.remoteSessionStarted` pushed afterward — the desktop's own `ptyStart`
 * IPC handler already turns its own return value into a tab in `App.tsx`, so
 * pushing the event there too would create the tab twice. Phone contract
 * point 10 / audit PX-9 / F3.
 */
async function launchSession(
  requested: LaunchOptions,
  origin: 'desktop' | 'remote' = 'desktop'
): Promise<StartResult> {
  if (!ptys) throw new Error('Window is not ready')
  // Its own path, before anything else reads the request: an enrollment takes
  // the host id from it and nothing more (`planEnrollLaunch`).
  if (requested.enroll) return startEnrollSession(requested)
  // The same shape for an account's sign-in tab: only the account id is read.
  if (requested.accountLogin) return startAccountLogin(requested)
  const settings = getSettings()
  /*
   * A phone starting a session on a host that keeps its shells sends no
   * session name — the desktop mints one per tab in `startHostSession`, and a
   * phone has no tab to keep it on. Named here, so the launch is a kept one
   * (pty.ts refuses a persisting host without a name) and the desktop tab it
   * becomes, told the name in `RemoteSessionStarted`, reconnects to it.
   */
  if (
    origin === 'remote' &&
    requested.host &&
    hostPersists(requested.host) &&
    !isSafeRemoteSessionName(requested.remoteSession)
  ) {
    requested = { ...requested, remoteSession: mintRemoteSessionName() }
  }
  /*
   * `--resume` or `--session-id`, decided here, against the disk, right before
   * the spawn — not by the renderer, whose idea of "has a transcript" is a
   * context reading that may not have ticked yet. A relaunch of a session
   * nobody has typed into, a `/clear`ed id, and a restored tab whose
   * conversation was never written all name an id with no transcript, and
   * `--resume` on one exits 1. See `resumeOrMint`.
   */
  const opts =
    !requested.host && isClaudeCode(cliIdOf(requested.cli)) && requested.sessionId && !requested.continueLast
      ? resumeOrMint(requested, await transcriptExists(requested.sessionId))
      : requested
  // `statusKey` is what the files are named after, not necessarily a session
  // id: a --continue session has no id until the CLI picks one. See pty.ts.
  /*
   * A non-Claude CLI's launch plan: its endpoint, Stoke's browser tools as an
   * MCP server where the CLI takes one per launch, and its own continue flag.
   * Built from settings here in main — the renderer never sends keys — and
   * refused with the plan's own sentence when a field it needs is empty.
   */
  const cliId = cliIdOf(opts.cli)
  /*
   * The account this launch runs on (shared/accounts.ts): the one the tab
   * names, else this agent's default account, else Default — the agent's own
   * sign-in, nothing added. A named account that has gone, or that belongs to
   * another agent, is refused: resuming a conversation on someone else's plan
   * is not a fallback. An SSH tab's `claude` and an install are not an
   * agent's session, so they carry none.
   */
  let account: AgentAccount | null = null
  let accountId: string | undefined
  if (!opts.host && !opts.install?.length) {
    const resolved = resolveLaunchAccount({
      cli: cliId,
      requested: opts.accountId,
      accounts: settings.accounts,
      defaults: settings.agents.defaultAccount
    })
    if (!resolved.ok) throw new Error(resolved.message)
    account = resolved.account
    accountId = resolved.accountId
    if (account) {
      const trouble = accountProblem(
        account,
        isClaudeCode(cliId) ? 'default' : (settings.agents.endpoints[cliId]?.mode ?? 'default')
      )
      if (trouble) throw new Error(trouble)
      // The folder and its links, repaired if something removed them: a Claude
      // account whose `projects` link had gone would write a second history
      // nobody reads. Never a new path — only the stored home.
      if (account.kind === 'login') {
        await repairAccountHome(account, defaultTrees(process.env, homedir())).catch((err) =>
          console.error('[stoke] could not repair an account folder', err)
        )
      }
    }
  }
  /**
   * MCP servers only for a LOCAL session: an SSH tab's agent is on another
   * machine and takes no flag from here (gotcha 19), and an install or an
   * enrollment runs no agent. Headless worklog runs never come through here
   * (agent.ts, gotcha 15).
   */
  const localAgent = !opts.host && !opts.install?.length
  mcpFiles ??= new McpFileStore(join(app.getPath('userData'), 'agents'))
  const launchMcp: LaunchMcp = localAgent ? await launchMcpFor(cliId, opts.cwd) : { servers: [], own: [], keep: [] }
  let agentPlan: LaunchPlan | null = null
  if (localAgent && !isClaudeCode(cliId)) {
    const endpoint = settings.agents.endpoints[cliId]
    const input = {
      id: cliId,
      endpoint,
      openrouterKey: settings.providers.openrouterApiKey,
      continueLast: opts.continueLast === true,
      // A chat found by search, reopened by its own id (`resumeArgs`); the
      // plan refuses an id or a CLI it cannot vouch for.
      resumeId: opts.agentResumeId ?? null,
      mcp: launchMcp.servers,
      mcpFileFor: mcpFiles.fileFor,
      mcpOwn: launchMcp.own,
      mcpKeep: launchMcp.keep,
      piExtensionPath: cliId === 'pi' && endpoint?.mode === 'custom' ? await piExtensionFile() : null,
      piMcpExtensionPath: cliId === 'pi' && launchMcp.servers.length ? await piMcpExtensionFile() : null,
      account
    }
    let planned = agentLaunchPlan(input)
    if (!planned.ok) throw new Error(planned.message)
    // An agent that reads its servers from a file gets one only once it is on
    // disk, owner-only; if it cannot be written, the launch goes without MCP
    // rather than with a flag naming nothing.
    if (planned.plan.files && !(await mcpFiles.write(planned.plan.files))) {
      planned = agentLaunchPlan({ ...input, mcpFileFor: null })
      if (!planned.ok) throw new Error(planned.message)
    }
    agentPlan = planned.plan
    logMcpSkipped(cliId, agentPlan.mcpSkipped)
  }
  /*
   * Claude Code loads its own servers itself, so its `--mcp-config` carries
   * only Stoke's: the browser file when ticked, and one generated file of the
   * servers Stoke holds that are ticked for it — plus, on a second account
   * (its own `CLAUDE_CONFIG_DIR`, so its own `~/.claude.json`), the Default
   * account's user-scope servers it would otherwise never see
   * (`accountMcpMirror`): URL and headers only for an http server, never an
   * OAuth token (gotcha 36), and never a name the account defines itself.
   */
  let claudeConfigs: string[] = []
  if (localAgent && isClaudeCode(cliId)) {
    let servers = launchMcp.servers
    if (account?.kind === 'login') {
      const { mirror, error } = await accountMirrorFor(account, opts.cwd)
      if (error) console.warn(`[stoke] ${account.id}: ${error}`)
      logMcpSkipped(cliId, mirror.refused)
      servers = claudeAccountServers(servers, mirror)
    }
    const out = claudeMcpConfigs(servers, mcpConfigPath, mcpFiles.fileFor)
    claudeConfigs = (await mcpFiles.write(out.files))
      ? out.configs
      : out.configs.filter((c) => !out.files.some((f) => f.path === c))
  }
  // Which shell the CLI will run the statusLine and hooks under is decided from
  // the PATH the child is given, which on Windows now leads with the registry's
  // (gotcha 99) — Stoke's own inherited PATH can predate a Git install.
  const hasGitBash = process.platform === 'win32' ? gitBashPath({ ...process.env, PATH: await buildEnvPath() }) !== null : undefined
  /*
   * The shared skills Claude Code does not read on its own, lent to this one
   * local session as a plugin. Never for an SSH tab (its `claude` is another
   * machine's, gotcha 19), an install tab or another agent; `prepare` answers
   * null rather than failing, so a launch never waits on it past its deadline
   * or dies of it. Filtered by the `skillOverrides` Claude reads in this
   * folder, whose local layer is the git root's (`localSettingsFiles`).
   */
  let claudePluginDir: string | null = null
  if (!opts.host && !opts.install?.length && isClaudeCode(cliId) && settings.agents.shareSkillsToClaude) {
    skillsProjector ??= new ClaudeSkillsProjector({ root: join(app.getPath('userData'), 'agents', 'claude-skills') })
    claudePluginDir = await skillsProjector.prepare(opts.cwd)
  }
  const started = await ptys.start(
    accountId ? { ...opts, accountId } : opts,
    settings.claudePath,
    claudeConfigs,
    (statusKey) =>
      writeSessionSettingsFile({
        sessionId: statusKey,
        hasGitBash,
        ultracode: opts.ultracode === true,
        hideStatusLine: settings.hideStatusLine,
        // Read now rather than cached: it is the user's own settings.json and
        // they can edit it between one session and the next.
        passthroughCommand: settings.hideStatusLine ? '' : userStatusLineCommand()
      }),
    settings.providers,
    agentPlan,
    null,
    claudePluginDir,
    // A second Claude account's home, applied in place of the Providers keys.
    isClaudeCode(cliId) && account ? accountEnv(account) : null
  )
  /*
   * Another agent's tab carries the model its plan asked for (`launchModel`):
   * its endpoint's, or its Default model where the table has a flag for one,
   * or '' when the agent picks. Never the renderer's Claude default, which it
   * sends with every launch and which nothing here passed to this binary.
   */
  const planned: StartResult = agentPlan ? { ...started, model: agentPlan.model } : started
  const result: StartResult = accountId ? { ...planned, accountId } : planned
  // A brand-new row for /ws/events, whichever side started it — a phone
  // watching the list should see a desktop-started session appear too.
  remote?.notifySessionsChanged()
  relayServer?.notifySessionsChanged()
  // And the owner's other machines, when this one shares its sessions.
  hubClient?.remoteSessionsChanged()
  if (origin === 'remote') {
    /*
     * An SSH start is adopted the way `startHostSession` makes its own tab:
     * `hostId` set and `cwd` the alias, never the local folder the ssh
     * process happens to run in (gotcha 18), and always Claude Code.
     */
    const started: RemoteSessionStarted = {
      ptyId: result.ptyId,
      sessionId: result.sessionId,
      cwd: opts.host ? opts.host.alias : opts.cwd,
      name: opts.host
        ? opts.host.label || opts.host.alias
        : (opts.cwd.split(/[\\/]/).filter(Boolean).pop() ?? opts.cwd),
      cli: opts.host ? 'claude' : cliId,
      permissionMode: opts.permissionMode ?? 'default',
      model: agentPlan ? agentPlan.model : (opts.model ?? ''),
      effort: opts.effort ?? 'default',
      hostId: opts.host?.id ?? null,
      ...(opts.host && opts.remoteSession ? { remoteSession: opts.remoteSession } : {}),
      ...(accountId ? { accountId } : {})
    }
    send(CH.remoteSessionStarted, started)
  }
  /*
   * Everything below reads a Claude Code transcript — the context watcher, the
   * worklog's session → folder map and its on-disk copy. Another CLI's launch
   * gets an opaque key from pty.ts, not a Claude session id, and tracking it
   * polled for a transcript named after that key, which can never appear, and
   * put it on the worklog's watch list. An SSH tab is always `claude`
   * (`startHostSession`), so it is still tracked.
   */
  if (opts.install?.length || !isClaudeCode(cliId)) return result
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
  persistSessionState()
  return result
}

/**
 * Set up key login for a host, in a tab (`opts.enroll`).
 *
 * The renderer names the host by id; everything else — the key, the config
 * line that makes plain `ssh <alias>` offer it, the `ssh-copy-id` argv — is
 * built here from settings (`planEnrollLaunch`, `prepareEnroll`). The tab is a
 * real PtyManager session so the user can type the password into it (gotcha
 * 109); the password goes over the ordinary `pty:write` path and nothing else.
 * When the tab's process exits, `finishEnrollRun` proves the result.
 *
 * `sshEnroll.ts` is imported lazily, never at module scope: a static import is
 * evaluated before `app.whenReady()`, and this is a button most launches never
 * press (gotcha 40).
 */
async function startEnrollSession(requested: LaunchOptions): Promise<StartResult> {
  if (!ptys) throw new Error('Window is not ready')
  const hostId = requested.enroll?.hostId
  if (typeof hostId !== 'string' || !hostId) throw new Error('No host was named.')
  // Claimed before the first await and refused on re-entry (gotchas 20, 66).
  if (enrolling.has(hostId)) throw new Error('Stoke is already setting up key login for that machine.')
  enrolling.add(hostId)
  let started = false
  const emit = (event: SshEnrollEvent): void => send(CH.sshEnrollEvent, event)
  try {
    const { planEnrollLaunch, prepareEnroll } = await import('./sshEnroll.ts')
    const plan = planEnrollLaunch(requested, getSettings().hosts)
    if (!plan.ok) {
      emit({ hostId, stage: 'failed', message: plan.message })
      throw new Error(plan.message)
    }
    const prep = await prepareEnroll(plan.host, { emit })
    if (!prep.ok) throw new Error(prep.message)
    const result = await ptys.start(plan.opts, null, null, () => null, getSettings().providers, null, prep.command)
    enrollRuns.add(result.ptyId, { host: plan.host, keyPath: prep.keyPath, fallback: prep.fallback })
    started = true
    return result
  } finally {
    // On success the claim is held until the tab exits (`finishEnrollRun`).
    if (!started) enrolling.delete(hostId)
  }
}

/**
 * An enrollment tab's process has exited: prove it worked for the TAB's own
 * connection, and only then write `keyEnrolled` (gotcha 75). The host is
 * re-read by id rather than patched from the launch copy: Settings may have
 * changed while the install waited on a password.
 */
async function finishEnrollRun(
  run: { host: SshHost; keyPath: string; fallback: boolean },
  exitCode: number,
  signal: number | undefined
): Promise<void> {
  const hostId = run.host.id
  const emit = (event: SshEnrollEvent): void => send(CH.sshEnrollEvent, event)
  try {
    const { finishEnroll } = await import('./sshEnroll.ts')
    const result = await finishEnroll(run.host, run.keyPath, exitCode, run.fallback, { emit }, signal)
    if (!result.ok) return
    if (!getSettings().hosts.some((h) => h.id === hostId)) return
    const hosts = getSettings().hosts.map((h) => (h.id === hostId ? { ...h, keyEnrolled: true } : h))
    send(CH.settingsChanged, setSettings({ hosts }))
  } catch (err) {
    emit({ hostId, stage: 'failed', message: `Could not check the key: ${(err as Error).message}` })
  } finally {
    enrolling.delete(hostId)
  }
}

/* ------------------------------------------------------------- accounts */

/**
 * Accounts being made, signed in or removed, one at a time: each reads the
 * list, decides and writes (gotcha 66), and a sign-in tab is claimed per
 * account before the first await and held until its process exits (gotcha
 * 20) — two presses would open two logins racing one folder.
 */
let accountChain: Promise<unknown> = Promise.resolve()
const signingIn = new Set<string>()
/** The sign-in tab behind each pty, so its exit can read the email it signed in as. */
const accountLoginRuns = new Map<string, string>()

function serialAccounts<T>(work: () => Promise<T>): Promise<T> {
  const next = accountChain.then(work, work)
  accountChain = next.catch(() => {})
  return next
}

/** The label an account made with no name gets, which a sign-in may replace with its email. */
function numberedLabel(cli: CodingCliId, n: number): string {
  return `${CODING_CLIS.find((c) => c.id === cli)?.label ?? cli} ${n}`
}

/** Whether a label is still the numbered one the account was made with. */
function isNumberedLabel(account: AgentAccount): boolean {
  const n = Number(account.label.split(' ').pop())
  return Number.isInteger(n) && account.label === numberedLabel(account.cli, n)
}

/**
 * Make an agent account, or find the one already there under that name.
 *
 * A login account gets its folder here and nowhere else — the renderer and
 * the `stoke` command name an agent and a label, never a path — made under
 * ~/.stoke/accounts, realpath'd (gotcha 91), and for Claude Code linked into
 * the default tree (accounts.ts). A key account stores its key, which the
 * secret store seals (`accounts.*.apiKey`).
 */
function createAccount(input: AccountCreateInput): Promise<AccountCreateResult> {
  return serialAccounts(async (): Promise<AccountCreateResult> => {
    const cli = CODING_CLIS.find((c) => c.id === input?.cli)?.id
    if (!cli) return { ok: false, message: 'Stoke does not know that agent.' }
    const kind = input.kind === 'key' ? 'key' : 'login'
    const agentLabel = CODING_CLIS.find((c) => c.id === cli)?.label ?? cli
    if (!accountKindsFor(cli).includes(kind)) {
      return {
        ok: false,
        message:
          kind === 'login'
            ? `${agentLabel} keeps one sign-in for the whole machine, so Stoke cannot hold a second one.`
            : `${agentLabel} takes no API key from Stoke.`
      }
    }
    const s = getSettings()
    const typed = cleanAccountLabel(input.name ?? '')
    let id: string
    let name: string
    if (typed) {
      const slug = accountSlug(typed)
      if (!slug) return { ok: false, message: 'Give the account a name with a letter or digit in it.' }
      id = accountIdFor(cli, slug)
      name = typed
    } else {
      let n = 2
      while (s.accounts[accountIdFor(cli, String(n))]) n++
      id = accountIdFor(cli, String(n))
      name = numberedLabel(cli, n)
    }
    const existing = s.accounts[id]
    if (existing) {
      if (existing.kind !== kind) {
        return { ok: false, message: `${existing.label} is already a ${existing.kind === 'key' ? 'key' : 'sign-in'} account.` }
      }
      return { ok: true, account: existing, created: false }
    }
    const swatch = nextSwatch(cli, accountsOf(cli, s.accounts).map((a) => a.swatch), agentSeed(cli, s.agents.colors))
    let account: AgentAccount
    if (kind === 'login') {
      const made = await makeAccountHome({
        root: accountsRoot(homedir()),
        id,
        cli,
        trees: defaultTrees(process.env, homedir())
      })
      account = { id, cli, label: name, kind, home: made.home, apiKey: '', swatch }
    } else {
      account = { id, cli, label: name, kind, home: '', apiKey: (input.apiKey ?? '').trim(), swatch }
    }
    const next = setSettings({ accounts: { ...getSettings().accounts, [id]: account } })
    send(CH.settingsChanged, next)
    return { ok: true, account: next.accounts[id] ?? account, created: true }
  })
}

/**
 * Forget an account. Its folder stays on disk — it holds a sign-in and maybe
 * a history, and deleting either unasked is not Stoke's to do — and a default
 * that pointed at it goes back to the agent's own sign-in.
 */
function removeAccount(id: string): Promise<void> {
  return serialAccounts(async () => {
    const s = getSettings()
    if (typeof id !== 'string' || !s.accounts[id]) return
    const accounts = { ...s.accounts }
    delete accounts[id]
    const defaultAccount = Object.fromEntries(
      Object.entries(s.agents.defaultAccount).filter(([, v]) => v !== id)
    ) as typeof s.agents.defaultAccount
    send(CH.settingsChanged, setSettings({ accounts, agents: { ...s.agents, defaultAccount } }))
  })
}

/** Each Claude login account's signed-in email, read-only, or null. */
async function identifyAccounts(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const a of Object.values(getSettings().accounts)) {
    if (a.cli === 'claude' && a.kind === 'login') out[a.id] = await readClaudeAccountEmail(a.home, process.env)
  }
  return out
}

/**
 * Keep this Stoke's part of `~/.stoke/accounts/index.json` — what `stoke
 * account list|env` reads — in step with its stored accounts, when that part
 * changed. The file is shared with every other Stoke on the machine (the
 * installed app, `npm run dev`, a sandbox), so it is MERGED under this
 * userData's name, never rewritten from this list alone: a dev build with no
 * accounts used to boot, find the installed app's index and write it back
 * empty, and `stoke account env work` then failed until the app restarted.
 */
let indexedAccounts: string | null = null
let indexWriter: Promise<string> | null = null
function syncAccountIndex(accounts: Record<string, AgentAccount>): void {
  const list = Object.values(accounts)
  const key = JSON.stringify(list.map((a) => [a.id, a.kind, a.home, a.label]))
  if (key === indexedAccounts) return
  indexedAccounts = key
  // realpath'd once, so a `/tmp` sandbox is one writer however it was typed (gotcha 91).
  const writer = (indexWriter ??= realpathFolder(app.getPath('userData')))
  void serialAccounts(async () => {
    await updateAccountIndex({ root: accountsRoot(homedir()), me: await writer, accounts: list })
  }).catch((err) => {
    // Not written, so the next change (or the next boot) tries again.
    if (indexedAccounts === key) indexedAccounts = null
    console.error('[stoke] could not write the account index', err)
  })
}

/**
 * An account's sign-in, in a tab: the agent's own login under the account's
 * home, where the user can answer it (gotcha 109). Only the account id is
 * read from the request. A key account has nothing to sign in.
 */
async function startAccountLogin(requested: LaunchOptions): Promise<StartResult> {
  if (!ptys) throw new Error('Window is not ready')
  const id = requested.accountLogin?.accountId
  const settings = getSettings()
  const account = typeof id === 'string' ? settings.accounts[id] : undefined
  if (!account) throw new Error('That account is no longer in Settings › Agents.')
  if (account.kind !== 'login') throw new Error(`${account.label} is an API-key account; there is nothing to sign in.`)
  // Claimed before the first await and refused on re-entry (gotchas 20, 66).
  if (signingIn.has(account.id)) throw new Error(`${account.label} is already signing in, in another tab.`)
  signingIn.add(account.id)
  let started = false
  try {
    const trouble = accountProblem(account)
    if (trouble) throw new Error(trouble)
    await repairAccountHome(account, defaultTrees(process.env, homedir()))
    const plan: LaunchPlan = { args: loginArgsFor(account.cli), env: accountEnv(account), model: '' }
    const result = await ptys.start(
      {
        cwd: homedir(),
        cli: account.cli,
        accountLogin: { accountId: account.id },
        accountId: account.id,
        permissionMode: 'default',
        model: '',
        effort: 'default',
        appearance: requested.appearance,
        cols: requested.cols,
        rows: requested.rows
      },
      settings.claudePath,
      null,
      () => null,
      settings.providers,
      plan
    )
    accountLoginRuns.set(result.ptyId, account.id)
    started = true
    return { ...result, accountId: account.id }
  } finally {
    // On success the claim is held until the tab exits (`finishAccountLogin`).
    if (!started) signingIn.delete(account.id)
  }
}

/**
 * A sign-in tab's process has exited: release the claim, and for Claude read
 * the email it signed in as (read-only, `.claude.json`). An account still
 * wearing the numbered name it was made with takes the email as its label;
 * one the user named keeps its name.
 */
async function finishAccountLogin(accountId: string): Promise<void> {
  try {
    const account = getSettings().accounts[accountId]
    if (!account || account.cli !== 'claude' || account.kind !== 'login') return
    const email = await readClaudeAccountEmail(account.home, process.env)
    const now = getSettings().accounts[accountId]
    if (!email || !now || !isNumberedLabel(now)) return
    const label = cleanAccountLabel(email)
    send(CH.settingsChanged, setSettings({ accounts: { ...getSettings().accounts, [accountId]: { ...now, label } } }))
  } catch (err) {
    console.error('[stoke] could not read the account it signed in as', err)
  } finally {
    signingIn.delete(accountId)
  }
}

/** Write the session address book the worklog reads. See `launchSession`. */
function persistSessionState(): void {
  writeSessionState(
    sessionStateFile(app.getPath('userData')),
    [...sessionCwds.entries()].map(([sessionId, dir]) => ({
      sessionId,
      cwd: dir,
      hostId: sessionHosts.get(sessionId)?.id ?? null,
      // Falls back to now only for a key that could not have reached
      // sessionCwds without also reaching sessionAts (both are set together,
      // here, in `rebindSession` and in the boot-restore loop) — defensive,
      // not expected to fire.
      at: sessionAts.get(sessionId) ?? Date.now()
    }))
  )
}

/**
 * A live pty's `claude` is on a different session now. Everything main keys by
 * session id follows it, then the renderer is told.
 *
 * The context watcher moves to the new id — which is what finally gives a
 * `--continue` tab a ring (gotcha 26): its id was '' and `watch('')` is a no-op,
 * so until now nothing was ever polled for it. The address book gains the new
 * id and KEEPS the old one: the conversation a `/clear` left is still a real
 * transcript the worklog may want to place. The statusLine files do not move —
 * they belong to the launch (gotcha 73) and `payloadKeyFor` finds them.
 */
function rebindSession(ptyId: string, sessionId: string, previous: string): void {
  if (!ptys) return
  const was = ptys.rebind(ptyId, sessionId)
  if (was === null) return
  if (previous) {
    watcher?.unwatch(previous)
    statusLineSeen.delete(previous)
  }
  watcher?.watch(sessionId)
  const cwd = ptys.list().find((s) => s.ptyId === ptyId)?.cwd
  if (cwd) {
    sessionCwds.set(sessionId, cwd)
    sessionAts.set(sessionId, Date.now())
    persistSessionState()
  }
  const msg: SessionRebind = { ptyId, sessionId, previous }
  send(CH.sessionRebind, msg)
  sendWatchStates()
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

/**
 * Mint the bearer key if there is none yet — and Web Push's VAPID pair if
 * there is no whole one (phone contract point 14) — in one write, and tell the
 * renderer. Only the start paths call this (gotcha 53): `/api/host` reads the
 * public key and never mints. A new pair retires every subscription, which was
 * made to the old one and could never be sent to again.
 */
function ensureRemoteToken(): Settings['remote'] {
  const s = getSettings()
  const push = s.remote.push
  const pushWhole = isVapidPair({ publicKey: push.vapidPublic, privateKey: push.vapidPrivate })
  if (s.remote.token && pushWhole) return s.remote
  const pair = pushWhole ? null : generateVapidKeys()
  const next = setSettings({
    remote: {
      ...s.remote,
      token: s.remote.token || generateToken(),
      push: pair ? { vapidPublic: pair.publicKey, vapidPrivate: pair.privateKey, subscriptions: [] } : push
    }
  })
  send(CH.settingsChanged, next)
  return next.remote
}

/**
 * Which phone key a subscription was made under: a truncated hash, never the
 * key. A key replaced in Settings is a phone locked out, so a subscription made
 * under the old one is never sent to again (`livePushSubscriptions`).
 */
function pushKeyTag(token: string): string {
  return createHash('sha256').update(`stoke-push:${token}`).digest('hex').slice(0, 16)
}

/**
 * Whether a push may go to plain http on 127.0.0.1: only an unpackaged build
 * launched with `STOKE_PUSH_LOOPBACK=1`, which is how a sandbox points a phone
 * at a fake push service (the same shape as `STOKE_ACCESS_CERTS_URL`). A
 * packaged build never does.
 */
function pushLoopbackAllowed(): boolean {
  return !app.isPackaged && process.env.STOKE_PUSH_LOOPBACK === '1'
}

/** `remote.push.subscriptions`, rewritten by main alone, then the renderer told (gotcha 53). */
function writePushSubscriptions(edit: (list: Settings['remote']['push']['subscriptions']) => Settings['remote']['push']['subscriptions']): void {
  const s = getSettings()
  const next = setSettings({ remote: { ...s.remote, push: { ...s.remote.push, subscriptions: edit(s.remote.push.subscriptions) } } })
  send(CH.settingsChanged, next)
}

/**
 * Subscriptions a push service answered 404/410 for since this Stoke started
 * (`rememberGonePush`), so a phone re-sending one is told 410 rather than
 * re-enrolled to be refused again.
 */
let pushGone: string[] = []

/**
 * Web Push for the phone server (phone contract point 14), every read from
 * settings on the call (gotcha 111). A send's `gone` (the phone unsubscribed,
 * or its browser dropped it) forgets that subscription and remembers it as
 * gone; a `failed` one is kept.
 */
function remotePushDeps(): RemotePushDeps {
  const pair = (): { publicKey: string; privateKey: string } | null => {
    const p = getSettings().remote.push
    const keys = { publicKey: p.vapidPublic, privateKey: p.vapidPrivate }
    return isVapidPair(keys) ? keys : null
  }
  return {
    publicKey: () => pair()?.publicKey ?? null,
    subscribe: (sub) => {
      if (pushGone.includes(pushSubscriptionKey(sub))) return 'gone'
      const tag = pushKeyTag(getSettings().remote.token)
      writePushSubscriptions((list) => withPushSubscription(list, sub, tag, Date.now()))
      return 'ok'
    },
    unsubscribe: (endpoint) => {
      const had = getSettings().remote.push.subscriptions.some((s) => s.endpoint === endpoint)
      if (had) writePushSubscriptions((list) => list.filter((s) => s.endpoint !== endpoint))
      return had
    },
    notify: async (payload, opts = {}) => {
      const keys = pair()
      if (!keys) return []
      const s = getSettings()
      const live = livePushSubscriptions(s.remote.push.subscriptions, pushKeyTag(s.remote.token), pushLoopbackAllowed()).filter(
        (sub) => !opts.only || sub.endpoint === opts.only
      )
      const outcomes = await Promise.all(live.map((sub) => sendPush(sub, payload, keys, { urgency: opts.urgency })))
      const goneSubs = live.filter((_, i) => outcomes[i] === 'gone')
      if (goneSubs.length) {
        pushGone = rememberGonePush(pushGone, goneSubs.map(pushSubscriptionKey))
        const gone = new Set(goneSubs.map((sub) => sub.endpoint))
        writePushSubscriptions((list) => list.filter((sub) => !gone.has(sub.endpoint)))
      }
      return outcomes
    },
    allowLoopback: pushLoopbackAllowed
  }
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
 * Whether a speech server Stoke can reach for free answers — the sidecar, or a
 * custom OpenAI-compatible one — probed at most every 15s and only while
 * something is asking: Settings → Voice's pill (`CH.sttStatus`) and the phone's
 * `/api/host`. Any HTTP answer counts — the sidecar 405s an OPTIONS — and a
 * refused connection is the whole signal. `url` is the full route
 * (`sttReadiness`), read by the caller from settings; the cache is keyed on it,
 * so a new address is probed at once.
 */
let sttProbe: { url: string; at: number; result: 'up' | 'down' } | null = null
const probeStt = async (url: string): Promise<'up' | 'down'> => {
  if (sttProbe && sttProbe.url === url && Date.now() - sttProbe.at < 15_000) return sttProbe.result
  let result: 'up' | 'down'
  try {
    await fetch(url, { method: 'OPTIONS', signal: AbortSignal.timeout(800) })
    result = 'up'
  } catch {
    result = 'down'
  }
  sttProbe = { url, at: Date.now(), result }
  return result
}

/*
 * Dictation's readiness for whichever provider is chosen. A hosted provider is
 * never probed — the only question it answers is a request, which is the Test
 * button's, on a press — so it is `ready` with a key and `off` without one.
 */
const sttStatusNow = async (): Promise<'up' | 'down' | 'ready' | 'off'> => {
  const r = sttReadiness(sttConfigOf(getSettings().voice))
  return r.kind === 'probe' ? probeStt(r.url) : r.kind
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
  // Advertise the token the RUNNING server authorises against, not a fresh
  // settings read: the two can drift (a restart race — the phone got "This
  // link's key isn't current" from the server's own QR on Windows), and the
  // running token is the only one a scan can actually connect with.
  const token = advertisedRemoteToken(remote?.runningToken() ?? null, cfg.token)
  const target = connectTarget({ ...cfg, token, tunnelUrl: tun.running ? tun.url : null })
  // No key, no link: a URL with `?k=` would be a lie the server cannot honour.
  const url = token ? target.url : null
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
      attachedByPty: {},
      access: { ...ACCESS_STATUS_OFF }
    },
    tunnel: tun,
    url,
    reach: target.reach,
    address: target.address,
    candidates: target.candidates,
    tailnet: tailnetAddress(),
    qr,
    setup: tunnel.setupCommands(cfg.tunnelName, cfg.hostname, cfg.port)
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
    startSession: (opts) => launchSession(opts, 'remote'),
    defaultCwd: () => resolveDefaultCwd(getSettings().defaultCwd),
    listSessions: (projectPath) => listSessions(projectPath),
    readTranscript: async (sessionId) => {
      const file = await findSessionFile(sessionId)
      return file ? readTranscript(file) : null
    },
    transcriptExists: (sessionId) => transcriptExists(sessionId),
    hostFor: (sessionId) => {
      const host = hostForSession(sessionId)
      return host ? host.label || host.alias : null
    },
    theme: () => {
      const s = getSettings()
      return { theme: effectiveTheme(s), fontFamily: s.fontFamily, contrastBoost: s.terminal.contrastBoost }
    },
    registryStates: () => registry?.states() ?? [],
    recordedContextLimit: (sessionId) => lastContextLimit.get(sessionId) ?? null,
    /**
     * The picker's own list, filtered to installed + chosen — the same
     * `visibleAgents` the launcher's "other agents" row already uses, so the
     * phone offers exactly what the desktop would.
     */
    agents: async () => {
      const detection = await detectCodingClis()
      const installed = new Set(detection.clis.filter((c) => c.path).map((c) => c.id))
      const chosen = getSettings().agents.chosen
      return visibleAgents(chosen, installed).map((id) => ({
        id,
        name: CODING_CLIS.find((c) => c.id === id)?.label ?? id
      }))
    },
    /**
     * As stored. /api/host strips bypassPermissions (never offered to the
     * phone) and resolves the agent against its own list (`phoneHostDefaults`).
     */
    defaults: () => {
      const s = getSettings()
      return {
        permissionMode: s.defaults.permissionMode,
        model: s.defaults.model,
        effort: s.defaults.effort,
        cli: s.agents.defaultCli
      }
    },
    /**
     * Per call (gotcha 111): an endpoint model or an account changed on the
     * desktop is what the phone's next sheet shows, and what its next start
     * is held to. `phoneAgentChoices` sends on ids, labels and models only.
     */
    launchFacts: () => {
      const s = getSettings()
      return {
        endpoints: s.agents.endpoints,
        accounts: s.accounts,
        defaultAccount: s.agents.defaultAccount,
        defaultModel: s.defaults.model
      }
    },
    push: remotePushDeps(),
    sttStatus: async () => {
      const s = await sttStatusNow()
      return s === 'up' || s === 'ready' ? 'ready' : s
    },
    /*
     * Read per call, like the desktop's `CH.transcribe` below, so a provider,
     * key or address changed in Settings → Voice reaches the phone's next clip
     * without Phone access being turned off and on. The phone never sees the
     * key: it posts audio here, and only this process sends it on.
     */
    transcribe: (wav) => transcribe(sttConfigOf(getSettings().voice), wav),
    projectRoots: () => getSettings().projectRoots,
    hosts: () => getSettings().hosts,
    /*
     * A folder a phone picked or created: remembered exactly as `stoke .`
     * remembers one — `manualProjectPatch`, then `settingsChanged` and the
     * watch states pushed (gotcha 53), nothing written when it is already
     * there. Already a realpath (`addRemoteProject`, gotcha 91). Returns the
     * normalised string `manualProjectPatch` stores it under.
     */
    addProject: (realPath) => {
      rememberLaunchFolder(realPath)
      return normalizePath(realPath.trim(), pathRulesFor(process.platform))
    },
    createScratch: async () => createScratchDir()
  }
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

/* ------------------------------------------- `stoke …` from a terminal */
/*
 * The request arrives in one of two ways — this process's own argv on a cold
 * start, or `second-instance` when Stoke was already running — and either way
 * before the renderer can necessarily take it. So it is checked here, queued,
 * and handed over when the renderer asks (`CH.cliPending`), which it does once,
 * after tab restore has settled. Parsing is `src/shared/stokeArgs.ts`; nothing
 * here decides what the words mean.
 */

/** Checked requests the renderer has not taken yet. */
const launchQueue: StokeCliRequest[] = []
/** True once this window's renderer has asked for the queue; pushes go straight to it after that. */
let launchReady = false
/**
 * One request at a time, in the order they came. Each may wait on a disk that
 * is asleep, and two `stoke` presses must not overtake each other on the way
 * to the renderer.
 */
let launchChain: Promise<void> = Promise.resolve()
/*
 * `launchFolderProblem`, `realpathFolder` and their deadline live in
 * `folderCheck.ts`, so the phone's folder routes and `verify:folders` run the
 * same checks `stoke .` does.
 */

/**
 * Put a folder `stoke` named into the sidebar, as Open a Folder does — but
 * only when it is not already there by hand, so a second `stoke .` writes
 * nothing. `manualProjectPatch` also un-hides it: naming a folder you once
 * hid is asking to see it.
 */
function rememberLaunchFolder(path: string): void {
  const rules = pathRulesFor(process.platform)
  const key = pathKey(path, rules)
  const s = getSettings()
  const added = Object.entries(s.projectMeta ?? {}).some(
    ([p, m]) => pathKey(p, rules) === key && m.addedManually === true
  )
  const hidden = (s.hiddenProjects ?? []).some((p) => pathKey(p, rules) === key)
  if (added && !hidden) return
  const next = setSettings(manualProjectPatch(s, path, rules))
  send(CH.settingsChanged, next)
  sendWatchStates()
}

/**
 * The agent a `stoke` request that named none starts: the default agent,
 * resolved the way the launcher's Start resolves it (`resolveDefaultAgent`), so
 * `stoke .` and Start can never disagree, and a default that has since been
 * uninstalled or unticked falls back rather than failing to spawn. A lookup
 * that throws trusts the stored value; the spawn then says plainly if that
 * agent is missing (`notFoundError`).
 */
async function launchDefaultCli(): Promise<CodingCliId> {
  const s = getSettings()
  try {
    const [detection, claude] = await Promise.all([detectCodingClis(), findClaude(s.claudePath)])
    const installed = installedAgents(detection.clis, claude !== null)
    return resolveDefaultAgent(s.agents.defaultCli, visibleAgents(s.agents.chosen, installed))
  } catch {
    return s.agents.defaultCli
  }
}

/** Check a request, then hand it over or queue it. Never throws. */
function acceptLaunch(req: StokeCliRequest): void {
  // `stoke` on its own asks for the window and nothing else; the caller has
  // already brought it forward.
  if (req.kind === 'focus') return
  launchChain = launchChain
    .then(async () => {
      let checked: StokeCliRequest = req
      /*
       * `stoke account add AGENT NAME`: made here, where accounts are made
       * (`createAccount`), then handed to the renderer as the one thing it
       * does with an account id — open its sign-in tab.
       */
      if (req.kind === 'account-add') {
        const made = await createAccount({ cli: req.cli, name: req.name, kind: 'login' })
        checked = made.ok
          ? { kind: 'account-login', accountId: made.account.id }
          : { kind: 'error', message: `stoke: ${made.message}` }
      }
      const folder = folderOf(req)
      if (folder) {
        const problem = await launchFolderProblem(folder)
        if (problem) checked = folderProblem(folder, problem)
        else {
          const real = await realpathFolder(folder)
          checked = withFolder(req, real)
          rememberLaunchFolder(real)
        }
      }
      // `stoke .` with no --cli: the running app's default agent, filled here
      // so the renderer only ever sees a request that names its agent.
      if (checked.kind === 'session' && checked.cli === null) checked = withDefaultCli(checked, await launchDefaultCli())
      if (launchReady && win) send(CH.cliRequest, checked)
      else launchQueue.push(checked)
    })
    .catch((err) => console.error('[stoke] could not deliver a stoke request', err))
}

/**
 * The window to the front — and a window at all, on macOS, where closing the
 * last one leaves the app running without one (gotcha 35).
 *
 * `steal` because the app asking is a terminal, not Stoke: without it macOS
 * treats a background app's focus() as a request to bounce in the Dock.
 */
function bringForward(): void {
  if (!win) {
    if (app.isReady()) createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  // Before ready-to-show there is nothing painted to show; that handler shows it.
  if (!win.isVisible()) return
  if (isMac) app.focus({ steal: true })
  win.focus()
}

/** What `src/main/stokeCommand.ts` needs to know about this process. */
function commandEnv(): CommandEnv {
  return {
    platform: process.platform,
    home: homedir(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    loginPath: loginShellPathValue
  }
}

/**
 * Install and Remove, one at a time (gotcha 66): each reads the link, decides,
 * then writes, and two presses interleaved could each decide on a state the
 * other has already changed.
 */
let commandChain: Promise<unknown> = Promise.resolve()
function serialCommand(fn: () => Promise<StokeCommandState>): Promise<StokeCommandState> {
  const run = commandChain.then(fn, fn)
  commandChain = run.catch(() => {})
  return run
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
      claudePath: settings.claudePath,
      providers: settings.providers
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
      providers: settings.providers,
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

/*
 * A standard titled window's title bar, in px: the height of the strip macOS
 * slides down over a full-screen window. Stoke's own window cannot say — with
 * `hiddenInset` its content fills the frame — so a hidden `BaseWindow` (no
 * renderer behind it) is asked once and kept. 32 on macOS 27, 28 before; 0 if
 * the probe fails, which `revealInsetFor` replaces with its fallback.
 */
let titleBarHeight: number | null = null
function standardTitleBarHeight(): number {
  if (titleBarHeight !== null) return titleBarHeight
  let probe: BaseWindow | null = null
  try {
    probe = new BaseWindow({ show: false, width: 240, height: 160 })
    titleBarHeight = probe.getContentBounds().y - probe.getBounds().y
  } catch {
    titleBarHeight = 0
  } finally {
    probe?.destroy()
  }
  return titleBarHeight
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
   * identity check is belt and braces against that ever changing, and
   * everything else is denied outright.
   *
   * The docked browser cannot reach this handler at all: it runs in a dedicated
   * persistent partition (`PARTITION` in browser.ts), a different session from
   * the one being configured here. That used to be written down as the reason a
   * browsed page could not take the microphone, and it was the wrong conclusion
   * from a true premise — an unhandled session is not denied, it is ungated, so
   * the browsed page had the LARGER grant of the two. Its partition gets its own
   * deny-all in `EmbeddedBrowser.hookPermissions`; this handler covers only the
   * app's own window.
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
  browser.setProfiles(settings.browser.profiles, settings.browser.currentProfile, settings.browser.homepage)

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
  /*
   * And again on the CLI's cadence. With the background download on, a check
   * is what starts it — and a Stoke left open for a week used to check exactly
   * once, eight seconds after it launched.
   */
  timers.push(setInterval(() => void checkSelfUpdate(), AUTO_CHECK_MS))

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
    (ptyId, data) => {
      send(CH.ptyData, ptyId, data)
      enrollOutput(ptyId, data)
    },
    (ptyId, code, signal, sessionId, loggedIn) => {
      // `loggedIn`: whether a remote session got past authentication, which
      // the renderer's kept-tab reconnect needs and cannot see (gotcha 126).
      send(CH.ptyExit, ptyId, code, signal, loggedIn)
      // A session that ends on its own (`/exit`, a crash) never reaches the
      // `CH.ptyKill` handler's cleanup below — by the time a user later
      // closes that tab, `sessionIdFor` already returns null, because
      // `proc.onExit` removed the session from PtyManager's own map before
      // this callback ever ran. `sessionId` here comes straight from that
      // same exit event, while it is still known, so this entry does not
      // sit in `statusLineSeen` forever.
      if (sessionId) statusLineSeen.delete(sessionId)
      // An enrollment tab: ssh-copy-id has finished, been closed, or failed.
      // Whichever — only the probe knows whether it worked.
      const run = enrollRuns.exit(ptyId)
      if (run) void finishEnrollRun(run, code, signal)
      // An account's sign-in tab: see who it signed in as, and release it.
      const login = accountLoginRuns.get(ptyId)
      if (login) {
        accountLoginRuns.delete(ptyId)
        void finishAccountLogin(login)
      }
    },
    /*
     * A remote asked one of our sessions for a password.
     *
     * Everything this does is decide whether to SAY so. `shouldOfferKey` is
     * pure and its whole truth table is asserted without bytes; a 'no' sends
     * nothing at all, so an offer the user turned off costs one map lookup and
     * leaves no trace. Nothing here can install anything — that needs a
     * `pty:start` with `opts.enroll`, which the renderer sends from a press
     * (or from an 'auto' offer the user chose in Settings).
     *
     * The host is resolved by ID from settings, never from the `user@host` the
     * far end printed: that text is display-only (gotcha 75), and it travels on
     * to the renderer purely so a mismatch through a ProxyJump is visible.
     */
    (ptyId, hostId, prompt) => {
      const settings = getSettings()
      const host = settings.hosts.find((h) => h.id === hostId)
      if (!host) return
      const offer = shouldOfferKey({
        setting: settings.sshKeyEnroll,
        refused: host.keyEnrollRefused === true,
        enrolled: host.keyEnrolled === true,
        inFlight: enrolling.has(hostId)
      })
      if (offer === 'no') return
      const event: SshAuthPromptEvent = {
        ptyId,
        hostId,
        offer,
        user: prompt.user,
        host: prompt.host
      }
      send(CH.sshAuthPrompt, event)
    }
  )
  /*
   * Claude Code's own session registry, read once a second for every live
   * local Claude pty — and not at all while there is none. Two facts nothing
   * else states: which session each process is on NOW (so a `/clear` or an
   * in-TUI `/resume` does not leave the tab naming a conversation it has left),
   * and whether a turn is running (so a relaunch can ask first). See
   * sessionRegistry.ts.
   *
   * `CLAUDE_CONFIG_DIR` is honoured through `claudeConfigDir`, read per pass so
   * it is never a stale copy of the environment.
   */
  registry = new RegistryPoller(
    () => join(claudeConfigDir(process.env, homedir()), 'sessions'),
    { readFile: (f) => readFile(f, 'utf8'), readdir: (d) => readdir(d), processTable: () => readProcessTable() },
    () => ptys?.registryTargets() ?? [],
    {
      rebind: (ptyId, sessionId, previous) => rebindSession(ptyId, sessionId, previous),
      state: (st: LiveSessionState) => {
        // A status change (a permission dialog appearing) is activity even
        // with no bytes written, and the phone's `lastActivityAt` (phone
        // contract point 3) needs it as much as pty output does.
        ptys?.touch(st.ptyId)
        send(CH.sessionState, st)
        // Tells /ws/events to re-push the list and pushes a {type:'status'}
        // frame to any phone attached to this pty directly (phone contract
        // point 5).
        remote?.onRegistryState(st.ptyId)
        relayServer?.onRegistryState(st.ptyId)
        hubClient?.remoteSessionsChanged()
      },
      // The phone's prompt identity can move on a pass that changed nothing
      // the renderer cares about (`trackPrompt`'s re-confirmation).
      passed: () => {
        remote?.onRegistryPass()
        relayServer?.onRegistryPass()
      }
    }
  )
  timers.push(setInterval(() => void registry?.pass(), REGISTRY_POLL_MS))

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
      // The last window this session was ever seen reading, kept after it
      // stops being live — /api/history's `contextLimit` (phone contract
      // point 9 / PX-19) needs this for a session that just ended, since the
      // statusLine payload file itself is deleted at exit (gotcha 73) and the
      // transcript's own model id drops the `[1m]` tier (gotcha 2).
      if (snap.ready && snap.contextLimit) lastContextLimit.set(snap.sessionId, snap.contextLimit)
      pushStatusLine(snap.sessionId)
      // `ready` is false for the placeholder emitted while a brand-new session
      // has no transcript yet; its counts are zeroes and would set a baseline
      // the real first reading then blows straight past.
      if (snap.ready) autoscan?.observe(snap.sessionId, snap.messageCount, snap.updatedAt)
    },
    (sessionId) => windowFor(payloadKeyFor(sessionId), ptys?.bannerWindowFor(sessionId) ?? null),
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
  /*
   * A reload is a new renderer that has not asked for the launch queue yet, so
   * anything that arrives meanwhile has to wait in it rather than be pushed at
   * a page that is tearing down. It asks again once its own restore settles.
   */
  launchReady = false
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) launchReady = false
  })

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
    registry = null
    mcp = null
    mcpConfigPath = null
    launchReady = false
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
   * How far macOS's full-screen reveal — the menu bar, and under it the title
   * strip with the traffic lights — reaches over the window. Gotcha 105.
   *
   * Asked by the renderer once it hears the window is full screen, so the
   * bounds read here are already the full-screen frame. Every input is
   * measured rather than assumed: the menu bar is the display's work-area
   * inset (still 30 while full screen on macOS 27, where it is cached), and the
   * strip is a hidden standard window's frame-to-content height.
   */
  ipcMain.handle(CH.winRevealInfo, (): RevealInfo => {
    if (!isMac || !win || !win.isFullScreen()) return { inset: 0, onEntry: false }
    const bounds = win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    return {
      inset: revealInsetFor({
        windowTop: bounds.y - display.bounds.y,
        menuBar: display.workArea.y - display.bounds.y,
        titleBar: standardTitleBarHeight()
      }),
      onEntry: revealsOnEntry(process.getSystemVersion())
    }
  })

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
    remote?.onThemeChanged()
    relayServer?.onThemeChanged()
  })

  /* ------------------------------------------------------------------- cli */
  ipcMain.handle(CH.cliInfo, () => probeClaude(getSettings().claudePath))
  ipcMain.handle(CH.skillsScan, () => scanSkills())
  /* ------------------------------------------------------------ accounts */
  ipcMain.handle(CH.accountsCreate, (_e, input: AccountCreateInput) => createAccount(input))
  ipcMain.handle(CH.accountsRemove, (_e, id: string) => removeAccount(id))
  ipcMain.handle(CH.accountsIdentify, () => identifyAccounts())
  ipcMain.handle(CH.accountsMcp, () => accountsMcp())
  ipcMain.handle(CH.mcpCatalog, () => readMcpCatalog(claudeConfigReader))
  ipcMain.handle(CH.cliDetect, (_e, opts?: { fresh?: boolean }) => {
    if (opts?.fresh === true) {
      forgetLoginPath()
      forgetIdentities()
    }
    return detectCodingClis()
  })

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
   *
   * All of that now holds PER SOURCE AND ACCOUNT (`UsageScheduler`): each
   * Claude account's endpoint, each Codex home, each Cline sign-in and the
   * OpenRouter key has its own floor, attempt time and backoff. `usage:read`
   * asks only the source the tab in front spends; `usage:all` (the panel is
   * open) asks every one, each under its own floor.
   */
  const usageReason = (v: unknown): UsageReadReason => (v === 'message' ? 'message' : 'poll')
  /** A wire-borne target, or null for anything that is not one: an agent id and `default` or an account id. */
  const usageTargetOf = (v: unknown): UsageTarget | null => {
    if (!v || typeof v !== 'object') return null
    const t = v as { cli?: unknown; accountId?: unknown }
    if (!isCodingCliId(t.cli)) return null
    const accountId = t.accountId === DEFAULT_ACCOUNT_ID || isAccountId(t.accountId) ? (t.accountId as string) : DEFAULT_ACCOUNT_ID
    return { cli: t.cli, accountId }
  }
  const usageBoard = async (reasonRaw: unknown, targetRaw: unknown, all: boolean): Promise<UsageBoard> => {
    const reason = usageReason(reasonRaw)
    const target = usageTargetOf(targetRaw)
    const input = usagePlanInput(getSettings())
    const fake = process.env.STOKE_FAKE_USAGE || undefined
    const plans = planUsageSources(input, process.env, homedir(), fake)
    usageScheduler.retain(plans.map((p) => p.key))
    // No tab to follow (a New tab, the launcher): Claude Code's Default
    // account, as the chip always showed. A tab whose agent states nothing
    // readable answers null, and the chip falls back to that same reading.
    const route = target ? usageRouteFor(target, input) : { source: 'anthropic' as const, accountId: DEFAULT_ACCOUNT_ID }
    const activeKey = route ? usageKey(route.source, route.accountId) : null
    const wanted = all ? plans : plans.filter((p) => p.key === (activeKey ?? CLAUDE_DEFAULT_KEY))
    await Promise.all(
      wanted.map((p) =>
        usageScheduler.read(p.key, reason, Date.now(), () => readUsageSource(p, Date.now(), fake), USAGE_FLOORS[p.source])
      )
    )
    const readings = plans.flatMap((p) => {
      const snap = usageScheduler.peek(p.key)
      return snap ? [toReading(p, snap)] : []
    })
    return { readings, activeKey }
  }
  ipcMain.handle(CH.usageRead, (_e, reason?: unknown, target?: unknown) => usageBoard(reason, target, false))
  ipcMain.handle(CH.usageAll, (_e, reason?: unknown, target?: unknown) => usageBoard(reason, target, true))

  /* -------------------------------------------------------------- projects */
  ipcMain.handle(CH.projectsList, () => listProjects(getSettings()))
  ipcMain.handle(CH.sessionsList, (_e, projectPath: string) => listSessions(projectPath))
  /*
   * Every session's title and first prompt, for the sidebar's search. The
   * project list is read here rather than taken from the renderer: it is
   * `listProjects` that drops hidden projects, so asking it again is what keeps
   * a hidden project's sessions from reaching the renderer by way of search.
   */
  ipcMain.handle(CH.sessionsIndex, async () => indexSessions(await listProjects(getSettings())))

  /* ---------------------------------------------------------- chat history */
  // Names and sizes only: what the offer card and Settings show before a yes.
  ipcMain.handle(CH.chatsDetect, () => chatHost().detect(chatEnv(), getSettings().chatIndexOptions.subagents))
  ipcMain.handle(CH.chatsStatus, async () => chatStatusFor(await chatHost().status()))
  /*
   * Body search. Nothing unless indexing is on — an index left on disk after a
   * switch-off is not searched. A hit in a HIDDEN project never reaches the
   * renderer, the rule `listProjects` keeps for session titles (sessionsIndex
   * above): hiding a folder must hide its conversations from search too.
   */
  ipcMain.handle(CH.chatsSearch, async (_e, query: unknown) => {
    const s = getSettings()
    if (s.chatIndex !== 'on' || typeof query !== 'string' || query.trim().length < CHAT_SEARCH_MIN_CHARS) return []
    const hits = await chatHost().search(query.slice(0, 200), 50)
    const rules = pathRulesFor(process.platform)
    return hits.filter((h) => !h.cwd || !s.hiddenProjects.some((p) => isInside(p, h.cwd!, rules)))
  })
  ipcMain.handle(CH.chatsIndexNow, () => {
    runChatPass()
  })
  // Every chat read from this computer's tools goes and is read again. Imports
  // stay: no pass could bring them back, and nobody asked for them to go.
  ipcMain.handle(CH.chatsRebuild, async () => {
    await chatHost().rebuild()
    runChatPass()
  })
  ipcMain.handle(CH.chatsDelete, async () => {
    await chatHost().deleteIndex()
    return chatStatusFor(await chatHost().status())
  })
  /*
   * An account export into the index. Only while chat history is on: search
   * answers nothing otherwise, and an import is text copied into the index, the
   * thing that switch consents to. No path means ask; a path is a drop on
   * Settings › Chat history, taken only as a regular file named .zip or .json
   * (the worker then recognises it by content). Claimed in the host before its
   * first await (gotcha 20); the pass that follows balances the total cap.
   */
  ipcMain.handle(CH.chatsImport, async (_e, given: unknown): Promise<ChatImportResult | null> => {
    const s = getSettings()
    if (s.chatIndex !== 'on') return { ok: false, error: 'Turn on chat history first: an import is searched with everything else in it.' }
    if (chatHost().importRunning) return { ok: false, error: 'An import is already running.' }
    let path: string
    if (typeof given === 'string' && given) {
      path = given
    } else {
      if (!win) return null
      const res = await dialog.showOpenDialog(win, {
        title: 'Import a claude.ai or ChatGPT export',
        properties: ['openFile'],
        filters: [{ name: 'Chat export (.zip, conversations.json)', extensions: ['zip', 'json'] }]
      })
      if (res.canceled || !res.filePaths[0]) return null
      path = res.filePaths[0]
    }
    if (!/\.(zip|json)$/i.test(path)) return { ok: false, error: 'Stoke imports a .zip export or a conversations.json file.' }
    try {
      if (!(await stat(path)).isFile()) return { ok: false, error: 'That is not a file.' }
    } catch {
      return { ok: false, error: 'That file could not be found.' }
    }
    const result = await chatHost().importExport(path, s.chatIndexOptions)
    if (result.ok) runChatPass()
    return result
  })
  ipcMain.handle(CH.chatsRemoveImport, async (_e, importId: unknown) => {
    if (typeof importId === 'number' && Number.isInteger(importId) && importId > 0) await chatHost().removeImport(importId)
    return chatStatusFor(await chatHost().status())
  })
  /*
   * One chat for the viewer. Nothing while chat history is off (as search), and
   * nothing in a hidden project — the rule search keeps: hiding a folder hides
   * its conversations everywhere they could surface.
   */
  ipcMain.handle(CH.chatsOpen, async (_e, chatId: unknown) => {
    const s = getSettings()
    if (s.chatIndex !== 'on' || typeof chatId !== 'number' || !Number.isInteger(chatId) || chatId <= 0) return null
    const t = await chatHost().open(chatId, chatEnv(), s.chatIndexOptions.redact, s.chatIndexOptions.caps.fileMb)
    if (!t) return null
    const rules = pathRulesFor(process.platform)
    if (t.cwd && s.hiddenProjects.some((p) => isInside(p, t.cwd!, rules))) return null
    return t
  })

  ipcMain.handle(CH.projectsAddRoot, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a folder to scan for projects',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    // Through symlinks, same as `projectsAdd` below (gotcha 91) — a scan
    // root's children inherit whichever path the root itself was stored
    // under, so a symlinked root would otherwise duplicate every project
    // under it against Claude's own, already-resolved history entries.
    const dir = await realpathFolder(res.filePaths[0])
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
    const picked = res.canceled ? null : (res.filePaths[0] ?? null)
    if (!picked) return null
    /*
     * Through symlinks before it is ever stored (gotcha 91): the dialog can
     * hand back a symlinked path (an iCloud-synced folder, a symlinked
     * dev directory, `/tmp` on macOS), and Claude's own history for the same
     * folder is keyed by `process.cwd()`'s OS-resolved one — without this,
     * opening a folder by dialog and by `stoke`/a session both opening it
     * created two sidebar rows for one place.
     */
    const dir = await realpathFolder(picked)
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
  /*
   * Through symlinks, same as every other folder gotcha 91 resolves before it
   * is stored or handed to the renderer — this one was missed. `stoke DIR`'s
   * `req.cwd` is realpath'd in `acceptLaunch`, but a launcher "Start here" or
   * the default New-tab folder used the typed candidate straight from
   * `resolveDefaultCwd` (`~/Developer` etc., or a symlinked explicit setting).
   * Confirmed live: a launcher tab opened on the typed spelling, then `stoke
   * .` from the SAME, symlinked folder found no running-tab match in
   * `App.tsx`'s `handleLaunch` (`pathKey(t.cwd) !== pathKey(req.cwd)`) and
   * started a second `claude` beside it — the twin-claude failure
   * `launchClaims` exists to prevent, just reached through the other door.
   */
  ipcMain.handle(CH.workspaceDefault, () => realpathFolder(resolveDefaultCwd(getSettings().defaultCwd)))
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
  /*
   * The relaunch's kill: the same cleanup as `pty:kill`, then resolve once the
   * process has really gone, capped. The cap is clamped here rather than
   * trusted, because a renderer bug that passed an hour would otherwise hang a
   * relaunch for an hour.
   */
  ipcMain.handle(CH.ptyStop, async (_e, ptyId: string, capMs?: number) => {
    if (!ptys) return true
    const sessionId = ptys.sessionIdFor(ptyId)
    const cap = Math.min(Math.max(typeof capMs === 'number' && Number.isFinite(capMs) ? capMs : 3000, 0), 10_000)
    const stopped = ptys.stop(ptyId, cap)
    if (sessionId) {
      watcher?.unwatch(sessionId)
      statusLineSeen.delete(sessionId)
    }
    return await stopped
  })
  ipcMain.handle(CH.sessionState, () => registry?.states() ?? [])

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
    // contributes its account's rate limits. See refreshLastStatusLine.
    refreshLastStatusLine()
    return [...lastStatusLines.values()]
  })

  /* --------------------------------------------------------------- browser */
  ipcMain.on(CH.browserSetBounds, (_e, rect: Rect) => browser?.setBounds(rect))
  ipcMain.on(CH.browserShow, (_e, url?: string) => browser?.show(url))
  ipcMain.on(CH.browserHide, () => browser?.hide())
  ipcMain.handle(CH.browserSnapshot, () => browser?.snapshot() ?? null)
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

  /*
   * Browser profiles. The list and the active id live in settings and nowhere
   * else (gotcha 57); `browser.setProfiles` follows every write of them, here
   * and in `CH.settingsSet`.
   */
  const writeBrowser = (patch: Partial<Settings['browser']>): Settings => {
    const s = getSettings()
    const next = setSettings({ browser: { ...s.browser, ...patch } })
    browser?.setProfiles(next.browser.profiles, next.browser.currentProfile, next.browser.homepage)
    // The star reads its own copy; an import that adds bookmarks must refresh it,
    // or a bookmarked page shows unstarred and a click REMOVES the bookmark.
    browser?.setBookmarks(next.browser.bookmarks)
    send(CH.settingsChanged, next)
    return next
  }
  /*
   * Profile edits go through main, against the settings as they are NOW. The
   * renderer used to send its whole copy of the browser block, and a copy taken
   * just before an import finished dropped the profiles the import had added.
   */
  ipcMain.handle(CH.browserRenameProfile, (_e, id: unknown, label: unknown) => {
    if (typeof id !== 'string' || typeof label !== 'string' || !label.trim()) return getSettings()
    const profiles = getSettings().browser.profiles
    if (!profiles.some((p) => p.id === id)) return getSettings()
    return writeBrowser({ profiles: profiles.map((p) => (p.id === id ? { ...p, label: label.trim() } : p)) })
  })
  ipcMain.handle(CH.browserUseProfile, (_e, id: unknown) => {
    if (typeof id !== 'string' || !getSettings().browser.profiles.some((p) => p.id === id)) return getSettings()
    return writeBrowser({ currentProfile: id })
  })
  ipcMain.handle(CH.browserDismissImportOffer, () =>
    getSettings().browser.importOffer === 'unasked' ? writeBrowser({ importOffer: 'dismissed' }) : getSettings()
  )
  ipcMain.handle(
    CH.browserProfileMenu,
    (_e, x: number, y: number) =>
      new Promise<'manage' | null>((resolve) => {
        if (!win) return resolve(null)
        const s = getSettings()
        const menu = Menu.buildFromTemplate([
          ...s.browser.profiles.map((p) => ({
            label: p.label,
            sublabel: p.source || undefined,
            type: 'radio' as const,
            checked: p.id === s.browser.currentProfile,
            click: (): void => {
              if (p.id !== getSettings().browser.currentProfile) writeBrowser({ currentProfile: p.id })
              resolve(null)
            }
          })),
          { type: 'separator' },
          { label: 'Manage profiles…', click: () => resolve('manage') }
        ])
        // `callback` runs when the menu closes, which may be before a click
        // handler on some platforms: resolving twice is a no-op, so dismissal
        // waits a beat for a click that is on its way.
        menu.popup({
          window: win,
          x: Math.round(x),
          y: Math.round(y),
          callback: () => setTimeout(() => resolve(null), 50)
        })
      })
  )
  ipcMain.handle(CH.browserAddProfile, () => {
    const profiles = getSettings().browser.profiles
    const profile = { id: newProfileId(profiles, randomUUID), label: nextProfileLabel(profiles), source: '', origin: '' }
    return writeBrowser({ profiles: [...profiles, profile] })
  })
  /*
   * Importing from Chrome and Safari (browserImport/). Loaded on first use:
   * most launches never import, and the module pulls in SQLite and crypto
   * (gotcha 40).
   */
  ipcMain.handle(CH.browserImportScan, async () => {
    const { cookieStoreEncrypted, scanImportSources } = await import('./browserImport/index.ts')
    const [sources, loginsAllowed] = await Promise.all([scanImportSources(), cookieStoreEncrypted()])
    return { sources, loginsAllowed }
  })
  ipcMain.handle(CH.browserImportRun, async (_e, keys: unknown, what: unknown) => {
    const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
    const w = (what ?? {}) as { cookies?: unknown; bookmarks?: unknown; closeReopen?: unknown }
    const { runImport } = await import('./browserImport/index.ts')
    return runImport(
      list,
      { cookies: w.cookies === true, bookmarks: w.bookmarks === true, closeReopen: w.closeReopen === true },
      { getSettings, writeBrowser }
    )
  })
  ipcMain.on(CH.browserOpenFullDiskAccess, () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles')
  })
  ipcMain.handle(CH.browserRemoveProfile, async (_e, id: string) => {
    if (id === DEFAULT_BROWSER_PROFILE_ID || !getSettings().browser.profiles.some((p) => p.id === id)) return getSettings()
    // Not while an import is writing: it may be writing into this very profile,
    // and would leave logins in a partition no profile names.
    if ((await import('./browserImport/index.ts')).importInProgress()) return getSettings()
    await browser?.clearProfileData(id)
    // Read AFTER the await: settings may have moved while the jar was wiped.
    const s = getSettings()
    return writeBrowser({
      profiles: s.browser.profiles.filter((p) => p.id !== id),
      currentProfile: s.browser.currentProfile === id ? DEFAULT_BROWSER_PROFILE_ID : s.browser.currentProfile
    })
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

  ipcMain.handle(CH.claudeLaunchDefaults, (_e, cwd: unknown) =>
    readLaunchDefaults(typeof cwd === 'string' && cwd ? cwd : null)
  )

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

  /*
   * "Look it up": the Access team and AUD in front of the saved hostname. One
   * lookup at a time — the promise is claimed before its first await (gotcha
   * 20), so a double press joins the running probe rather than starting a
   * second one. Returns the answer; the panel writes it (one writer, gotcha 57).
   */
  let accessLookup: Promise<AccessLookup> | null = null
  ipcMain.handle(CH.remoteLookupAccess, () => {
    if (accessLookup) return accessLookup
    const hostname = getSettings().remote.hostname
    accessLookup = discoverAccess(hostname).finally(() => {
      accessLookup = null
    })
    return accessLookup
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
    /*
     * Recorded BEFORE the quit, synchronously, because the next statement ends
     * the process. `installSelfUpdate` returns false without quitting when there
     * is nothing downloaded, and then the marker is taken straight back out so
     * it cannot resume the tabs on some later, ordinary launch.
     */
    const file = updateRestartFile(app.getPath('userData'))
    const st = selfUpdateState()
    writeUpdateRestart(file, { at: Date.now(), from: st.currentVersion, to: st.availableVersion })
    // Before quitAndInstall, not after: the tab snapshot the next boot resumes
    // from is this one.
    if (lastTabState) writeTabState(tabStateFile(app.getPath('userData')), lastTabState)
    flushSettings()
    const started = installSelfUpdate()
    if (!started) consumeUpdateRestart(file)
    return started
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
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => commitSettings(patch))
  /*
   * A settings write and everything a moved field has to reach: the docked
   * browser, the phone server, the window's own paint, the recall cache. One
   * function because two paths write settings wholesale — Settings itself and
   * an imported setup file — and an import that skipped these would leave a
   * new theme unpainted and new bookmarks unshown until a restart.
   */
  async function commitSettings(patch: Partial<Settings>, from: 'renderer' | 'hub' = 'renderer'): Promise<Settings> {
    const prev = getSettings()
    /*
     * `hub` has one writer, the hub service (gotcha 57): the renderer changes
     * it through `window.stoke.hub`, and a patch that carries a stale copy —
     * a panel spreading the settings it rendered — must not undo a sign-in.
     */
    if (from === 'renderer' && patch.hub) patch = { ...patch, hub: prev.hub }
    /*
     * The renderer may rename an account, recolour it or change its key —
     * never add one, remove one or move its home, which becomes an agent's
     * config dir. Those are `accounts:create`/`accounts:remove`, in main.
     *
     * Nor may it write `remote.push` at all: Phone access spreads its whole
     * copy of `remote` into every patch, and a phone that subscribed since that
     * copy was taken would be dropped by the next toggle (the same shape as
     * gotcha 53's stale token). Main's own copy always stands.
     */
    const guarded: Partial<Settings> = patch.remote ? { ...patch, remote: { ...patch.remote, push: prev.remote.push } } : patch
    const next = setSettings(
      guarded.accounts ? { ...guarded, accounts: accountsFromRenderer(prev.accounts, guarded.accounts) } : guarded
    )
    // A renamed or re-ordered profile list, a switch, or a bookmark list moved.
    if (patch.browser) {
      browser?.setProfiles(next.browser.profiles, next.browser.currentProfile, next.browser.homepage)
      browser?.setBookmarks(next.browser.bookmarks)
    }
    /*
     * A new speech service is probed afresh rather than reported from the last
     * address's 15s cache. Not a remote field and never a restart: both
     * dictation paths read `voice` per call (`RemoteDeps.transcribe`,
     * `CH.transcribe`), and Settings → Voice asks for its pill again itself.
     */
    if (
      prev.voice.sttUrl !== next.voice.sttUrl ||
      prev.voice.provider !== next.voice.provider ||
      prev.voice.baseUrl !== next.voice.baseUrl
    ) {
      sttProbe = null
    }
    /*
     * A running remote server reads its config once, at start. So ticking
     * "also listen on the local network", changing the port, or requiring
     * Access used to change nothing until the server was turned off and on —
     * and nothing said so. Restart it here when a field it binds or checks
     * moves; `start()` stops the old listeners first.
     */
    /*
     * A server that FAILED to bind (a busy port) is retried too, while Phone
     * access is still on: its error tells the user to pick another port, and
     * doing so used to change nothing until they turned it off and on
     * (`shouldRestartRemote`, review of PX-8).
     */
    if (remote && shouldRestartRemote(prev.remote, next.remote, remote.status())) {
      await remote.start(next.remote)
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
    // A phone paints this theme too; it re-fetches only if it moved (audit PX-21).
    remote?.onThemeChanged()
    relayServer?.onThemeChanged()
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
  }

  /* ------------------------------------------------- backup & transfer */
  ipcMain.handle(CH.secretsStatus, () => secretStoreStatus())

  /*
   * One slot for the whole flow, claimed before the first await (gotcha 20):
   * a second Export press while the first is still deriving its key would
   * otherwise open a second save dialog, and an Apply pressed twice would fold
   * the same file in twice.
   */
  let setupBusy = false
  /** The file picked for import and, once unlocked, its payload. Main's only; never sent. */
  let pendingImport: { name: string; text: string; payload: SetupPayload | null } | null = null
  const SETUP_MAX_BYTES = 8 * 1024 * 1024
  /*
   * A test hook, the chrome.ts `STOKE_TEST_CHROME_SAFE_STORAGE` shape: an
   * UNPACKAGED run may name the file both dialogs answer with, because a
   * native save/open panel cannot be driven over CDP (gotcha 31 — the wire
   * from the buttons to the file is only provable in the running app). A
   * packaged build never reads it.
   */
  const testSetupFile = (): string | undefined =>
    app.isPackaged ? undefined : process.env.STOKE_TEST_SETUP_FILE || undefined

  ipcMain.handle(CH.setupExport, async (_e, req: { passphrase?: unknown; includeSecrets?: unknown }) => {
    const passphrase = typeof req?.passphrase === 'string' ? req.passphrase : ''
    const verdict = judgePassphrase(passphrase)
    if (!verdict.acceptable) return { ok: false, message: verdict.hint }
    if (setupBusy) return { ok: false, message: 'Already working on a setup file.' }
    setupBusy = true
    try {
      const now = new Date()
      const opts = {
        title: 'Export Stoke setup',
        defaultPath: join(app.getPath('documents'), defaultSetupName(now)),
        filters: [{ name: 'Stoke setup', extensions: [SETUP_EXTENSION] }]
      }
      const seam = testSetupFile()
      const res = seam
        ? { canceled: false, filePath: seam }
        : win
          ? await dialog.showSaveDialog(win, opts)
          : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true, message: '' }
      const payload = buildSetupPayload(getSettings(), {
        includeSecrets: req?.includeSecrets === true,
        version: app.getVersion(),
        platform: process.platform,
        now
      })
      const text = await sealSetup(payload, passphrase)
      await writeFile(res.filePath, text, { encoding: 'utf8', mode: 0o600 })
      return { ok: true, path: res.filePath, keys: Object.keys(payload.secrets).length }
    } catch (err) {
      return { ok: false, message: `The setup file could not be written: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      setupBusy = false
    }
  })

  ipcMain.handle(CH.setupImportPick, async () => {
    if (setupBusy) return { ok: false, message: 'Already working on a setup file.' }
    setupBusy = true
    try {
      const opts = {
        title: 'Import Stoke setup',
        properties: ['openFile' as const],
        filters: [{ name: 'Stoke setup', extensions: [SETUP_EXTENSION] }]
      }
      const seam = testSetupFile()
      const res = seam
        ? { canceled: false, filePaths: [seam] }
        : win
          ? await dialog.showOpenDialog(win, opts)
          : await dialog.showOpenDialog(opts)
      const file = res.filePaths[0]
      if (res.canceled || !file) return { ok: false, canceled: true, message: '' }
      const info = await stat(file)
      if (info.size > SETUP_MAX_BYTES) return { ok: false, message: 'That file is far too large to be a Stoke setup file.' }
      const text = await readFile(file, 'utf8')
      // Refuse a file that is not one, or that this build cannot open, BEFORE
      // asking for a passphrase that could never work.
      const envelope = parseSetupEnvelope(text)
      if (!envelope.ok) return { ok: false, message: envelope.message }
      pendingImport = { name: basename(file), text, payload: null }
      return { ok: true, name: basename(file) }
    } catch (err) {
      return { ok: false, message: `That file could not be read: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      setupBusy = false
    }
  })

  ipcMain.handle(CH.setupImportPreview, async (_e, passphrase: unknown) => {
    const pending = pendingImport
    if (!pending) return { ok: false, message: 'Choose a setup file first.' }
    if (typeof passphrase !== 'string' || !passphrase) {
      return { ok: false, message: 'Type the passphrase the file was made with.' }
    }
    if (setupBusy) return { ok: false, message: 'Already working on a setup file.' }
    setupBusy = true
    try {
      const opened = await openSetup(pending.text, passphrase)
      if (!opened.ok) return { ok: false, message: opened.message }
      // Cancelled, or another file picked, while this one derived its key.
      if (pendingImport !== pending) return { ok: false, message: 'That import was cancelled.' }
      pending.payload = opened.payload
      const { preview } = planImport(getSettings(), opened.payload, { includeSecrets: true }, hydrateSettings)
      return { ok: true, preview }
    } finally {
      setupBusy = false
    }
  })

  ipcMain.handle(CH.setupImportApply, async (_e, opts: { includeSecrets?: unknown }) => {
    const payload = pendingImport?.payload
    if (!payload) return { ok: false, message: 'Unlock a setup file first.' }
    if (setupBusy) return { ok: false, message: 'Already working on a setup file.' }
    setupBusy = true
    try {
      const includeSecrets = opts?.includeSecrets === true
      // Against the settings as they are NOW, not at preview time: anything
      // changed since is kept unless the file names it.
      const { next, preview } = planImport(getSettings(), payload, { includeSecrets }, hydrateSettings)
      const changed = preview.changes.length
      pendingImport = null
      const settings = await commitSettings(next)
      return { ok: true, settings, changed, keys: includeSecrets ? Object.keys(portableSecrets(payload.secrets)).length : 0 }
    } catch (err) {
      return { ok: false, message: `The setup could not be applied: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      setupBusy = false
    }
  })

  ipcMain.handle(CH.setupImportCancel, () => {
    pendingImport = null
  })

  /* ------------------------------------------------------------ Stoke Hub */
  /*
   * Settings › Account & sync. Everything is main's hub service; these
   * handlers only hand it the renderer's arguments (each re-checked there)
   * and main's dialogs. The service claims each action before its first await
   * and refuses a second press (gotcha 20).
   */
  let hubStarting: Promise<import('./hub/service.ts').HubService> | null = null
  const hubService = (): Promise<import('./hub/service.ts').HubService> => {
    if (hubClient) return Promise.resolve(hubClient)
    hubStarting ??= (async () => {
      const [{ HubService }, { safeStorageBackend }] = await Promise.all([import('./hub/service.ts'), import('./secrets.ts')])
      const { hostname } = await import('node:os')
      const svc = new HubService({
        userData: app.getPath('userData'),
        backend: safeStorageBackend(safeStorage, process.platform),
        platform: process.platform,
        hostname: hostname().replace(/\.local$/, ''),
        appVersion: app.getVersion(),
        getSettings,
        commit: (patch) => commitSettings(patch, 'hub'),
        hydrate: hydrateSettings,
        onSettingsChanged,
        emit: (view) => send(CH.hubChanged, view),
        saveKit: async (name, text) => {
          /*
           * The `STOKE_TEST_SETUP_FILE` shape: an UNPACKAGED run may name the
           * file the save dialog answers with, because a native panel cannot be
           * driven over CDP. A packaged build never reads it.
           */
          const seam = app.isPackaged ? undefined : process.env.STOKE_TEST_KIT_FILE || undefined
          const opts = { title: 'Save your Recovery Kit', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'Text', extensions: ['txt'] }] }
          const res = seam ? { canceled: false, filePath: seam } : win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
          if (res.canceled || !res.filePath) return { ok: false, canceled: true, message: '' }
          try {
            await writeFile(res.filePath, text, { encoding: 'utf8', mode: 0o600 })
            return { ok: true, path: res.filePath }
          } catch (err) {
            return { ok: false, message: `The Recovery Kit could not be saved: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
        printKit: async (text) => {
          // A window of our own holding only the Kit, printed through the system dialog, then gone.
          const page = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
          const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<pre style="font:14px/1.5 monospace">${escaped}</pre>`)}`)
          await new Promise<void>((resolve) => page.webContents.print({}, () => resolve()))
          page.destroy()
        },
        log: (message, err) => (err ? console.error(`[stoke] ${message}`, err) : console.warn(`[stoke] ${message}`)),
        /*
         * "Other machines": this computer's sessions and the phone server's
         * own handlers, through the relay instance above — the host's grant
         * and scope are judged in hub/remote.ts before any of these runs.
         */
        remote: {
          sessions: () => relayRemote().sessionRows(),
          request: (method, path, body) => relayRemote().relayRequest(method, path, body),
          socket: (path, sock) => relayRemote().relaySocket(path, sock),
          emit: (view) => send(CH.hubRemoteChanged, view),
          frame: (tab, frame) => send(CH.hubRemoteFrame, tab, frame)
        }
      })
      await svc.start()
      hubClient = svc
      return svc
    })()
    return hubStarting
  }
  /** Resume background sync after boot, only when a hub was set up (the window is up by then). */
  setTimeout(() => {
    if (getSettings().hub.url) void hubService().catch((err) => console.error('[stoke] hub client did not start', err))
  }, 4000).unref()
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  ipcMain.handle(CH.hubView, async () => (await hubService()).view())
  ipcMain.handle(CH.hubSetUrl, async (_e, url: unknown) => (await hubService()).setUrl(str(url)))
  ipcMain.handle(CH.hubCheckUrl, async (_e, url: unknown) => (await hubService()).checkUrl(str(url)))
  ipcMain.handle(CH.hubSignIn, async (_e, req: Record<string, unknown> | null) =>
    (await hubService()).signIn({
      email: str(req?.email),
      password: str(req?.password),
      label: typeof req?.label === 'string' ? req.label : undefined,
      invite: typeof req?.invite === 'string' ? req.invite : undefined
    })
  )
  ipcMain.handle(CH.hubSignOut, async () => (await hubService()).signOut())
  ipcMain.handle(CH.hubCreateVault, async () => (await hubService()).createVault())
  ipcMain.handle(CH.hubKit, async () => (await hubService()).pendingKitText())
  ipcMain.handle(CH.hubKitConfirm, async (_e, group: unknown) => (await hubService()).confirmKit(str(group)))
  ipcMain.handle(CH.hubKitCancel, async () => (await hubService()).cancelKit())
  ipcMain.handle(CH.hubKitSave, async () => (await hubService()).saveKit())
  ipcMain.handle(CH.hubKitPrint, async () => (await hubService()).printKit())
  ipcMain.handle(CH.hubNewKit, async () => (await hubService()).newKit())
  ipcMain.handle(CH.hubJoinStart, async () => (await hubService()).joinStart())
  ipcMain.handle(CH.hubJoinCancel, async () => (await hubService()).joinCancel())
  ipcMain.handle(CH.hubJoinConfirm, async (_e, match: unknown) => (await hubService()).joinConfirm(match === true))
  ipcMain.handle(CH.hubRecover, async (_e, kit: unknown) => (await hubService()).recover(str(kit)))
  ipcMain.handle(CH.hubApproveStart, async (_e, pair: unknown) => (await hubService()).approveStart(str(pair)))
  ipcMain.handle(CH.hubApproveConfirm, async (_e, pair: unknown) => (await hubService()).approveConfirm(str(pair)))
  ipcMain.handle(CH.hubRefuse, async (_e, pair: unknown) => (await hubService()).refusePair(str(pair)))
  ipcMain.handle(CH.hubSyncNow, async () => (await hubService()).syncNow())
  ipcMain.handle(CH.hubSetScope, async (_e, patch: Record<string, unknown> | null) => {
    const pick = (k: string): boolean | undefined => (typeof patch?.[k] === 'boolean' ? (patch[k] as boolean) : undefined)
    return (await hubService()).setScope({ settings: pick('settings'), hosts: pick('hosts'), keys: pick('keys') })
  })
  ipcMain.handle(CH.hubSetAccountKeys, async (_e, on: unknown) => (await hubService()).setAccountKeys(on === true))
  ipcMain.handle(CH.hubRename, async (_e, id: unknown, name: unknown) => (await hubService()).renameDevice(str(id), str(name)))
  ipcMain.handle(CH.hubRevoke, async (_e, id: unknown, how: Record<string, unknown> | null) =>
    (await hubService()).revokeDevice(str(id), how?.newKit === true ? { newKit: true } : { kit: str(how?.kit) })
  )
  ipcMain.handle(CH.hubDismissNotes, async () => (await hubService()).dismissNotes())
  ipcMain.handle(CH.hubRepublish, async () => (await hubService()).republish())
  ipcMain.handle(CH.hubApplyHeld, async (_e, group: unknown) => (await hubService()).applyHeld(str(group)))
  ipcMain.handle(CH.hubKeepHeld, async (_e, group: unknown) => (await hubService()).keepHeld(str(group)))
  ipcMain.handle(CH.hubLocalKeys, async () => (await hubService()).localKeys())
  ipcMain.handle(CH.hubShareKey, async (_e, name: unknown) => (await hubService()).shareKey(str(name)))
  ipcMain.handle(CH.hubUnshareKey, async (_e, keyId: unknown) => (await hubService()).unshareKey(str(keyId)))
  ipcMain.handle(CH.hubInstallKey, async (_e, keyId: unknown) => (await hubService()).installKey(str(keyId)))
  // "Other machines" (hub/remote.ts). Every argument is re-checked there.
  // Read by the window at boot: never STARTS the hub client (a Stoke with no hub set up loads none of it).
  ipcMain.handle(CH.hubRemoteView, () => hubClient?.remoteView() ?? emptyRemoteView())
  ipcMain.handle(CH.hubRemoteOpen, async (_e, device: unknown, ptyId: unknown) => (await hubService()).remoteOpen(str(device), str(ptyId)))
  ipcMain.on(CH.hubRemoteInput, (_e, tab: unknown, data: unknown) => hubClient?.remoteInput(str(tab), str(data)))
  ipcMain.handle(CH.hubRemoteClose, (_e, tab: unknown) => hubClient?.remoteClose(str(tab)))
  ipcMain.handle(CH.hubRemoteRetry, async (_e, tab: unknown) => (await hubService()).remoteRetry(str(tab)))
  ipcMain.handle(CH.hubRemoteAnswer, async (_e, ask: unknown, answer: unknown) => (await hubService()).remoteAnswer(str(ask), answer))
  ipcMain.handle(CH.hubRemoteDrop, async () => (await hubService()).remoteDropGuests())
  ipcMain.handle(CH.hubSetSharing, async (_e, on: unknown) => (await hubService()).setSharing(on === true))
  ipcMain.handle(CH.hubRevokeGrant, async (_e, device: unknown) => (await hubService()).revokeGrant(str(device)))

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

  /**
   * Is this SSH tab still sitting at a password prompt? Asked by the renderer
   * after a key was enrolled, before it reconnects the tab that raised the
   * offer: only a tab with nothing to lose is ever restarted (`awaitingPassword`
   * in pty.ts). A string id and nothing else — this reads, it never acts.
   */
  ipcMain.handle(CH.sshAwaitingPassword, (_e, ptyId: unknown) =>
    typeof ptyId === 'string' && ptyId ? (ptys?.awaitingPassword(ptyId) ?? false) : false
  )

  /*
   * The managed sessions on a host (`SshHost.persist`), and ending one. Both
   * take the host by ID and look it up in settings here, so nothing the
   * renderer sends becomes a destination; the name is whitelisted again inside
   * `buildRemoteSessionKillArgs`. BatchMode both ways: a password host answers
   * "cannot say" in seconds instead of prompting where nobody can type.
   */
  ipcMain.handle(CH.sshRemoteSessions, async (_e, hostId: unknown): Promise<RemoteSessionList> => {
    const host = typeof hostId === 'string' ? getSettings().hosts.find((h) => h.id === hostId) : undefined
    if (!host) return { ok: false, message: 'That machine is not in Settings.' }
    if (!hostPersists(host)) return { ok: true, sessions: [] }
    return listRemoteSessions(host)
  })
  ipcMain.handle(CH.sshEndRemoteSession, async (_e, hostId: unknown, name: unknown) => {
    const host = typeof hostId === 'string' ? getSettings().hosts.find((h) => h.id === hostId) : undefined
    if (!host) return { ok: false, message: 'That machine is not in Settings.' }
    if (!isSafeRemoteSessionName(name)) return { ok: false, message: 'That is not a session Stoke started.' }
    return endRemoteSession(host, name)
  })
  // Images pasted or dropped on an SSH tab, copied to the machine (sshImages.ts).
  registerSshImageHandlers({ getSettings, isAppWindow: (sender) => !!win && sender === win.webContents })

  /* ------------------------------------------------------------------ tabs */
  ipcMain.on(CH.tabsSave, (_e, state: StoredTabs) => {
    lastTabState = state
    writeTabState(tabStateFile(app.getPath('userData')), state)
  })

  /*
   * `afterUpdate` rides out on the restore and nowhere else: it is true only
   * when the last quit was Stoke installing its own update ("Restart and
   * install"), and the marker is consumed here, so a second restore in the same
   * run — a renderer reload — reads false. See `writeUpdateRestart`.
   */
  ipcMain.handle(CH.tabsRestore, (): StoredTabs => {
    const userData = app.getPath('userData')
    const state = readTabState(tabStateFile(userData))
    return consumeUpdateRestart(updateRestartFile(userData)) ? { ...state, afterUpdate: true } : state
  })

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
        providers: settings.providers,
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
   * The microphone permission, asked of the OS for Stoke — which on macOS is
   * also the permission for every `claude` in a Stoke tab, since a pty child
   * records as its responsible process (see voiceRoute.ts). Windows has a
   * desktop-apps switch this reads too; Linux has no per-app gate at all.
   */
  const micAccess = (): MicAccess => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'not-applicable'
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      return isMicAccess(status) ? status : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  const voiceState = async (): Promise<VoiceState> => ({
    access: micAccess(),
    claudeVoice: claudeVoiceEnabled((await readClaudeSettings()).values)
  })
  ipcMain.handle(CH.voiceState, () => voiceState())
  ipcMain.handle(CH.micRequest, async () => {
    // Only macOS has a prompt to show. A 'denied' answer never prompts again —
    // the OS remembers it — which is why Settings offers the privacy page too.
    if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone')
    return voiceState()
  })
  ipcMain.on(CH.micPrivacy, () => {
    const url =
      process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        : process.platform === 'win32'
          ? 'ms-settings:privacy-microphone'
          : null
    if (url) void shell.openExternal(url)
  })

  /*
   * Desktop dictation. The renderer records and encodes the WAV — it has the
   * microphone and the audio APIs — but does not reach the speech service: the
   * sidecar has no authentication of its own, and a provider's key is sent only
   * from here. Same boundary the phone's `/api/transcribe` route enforces, and
   * `stt.ts` is the single implementation behind both.
   *
   * The settings read happens per call rather than being captured, so changing
   * the provider, key or address takes effect on the next dictation instead of
   * the next launch.
   */
  ipcMain.handle(CH.transcribe, async (_e, wav: ArrayBuffer) => {
    return transcribe(sttConfigOf(getSettings().voice), new Uint8Array(wav))
  })
  /*
   * Settings → Voice's pill. Its own channel rather than a field of
   * `voiceState`, which the terminal asks every time dictation is switched on:
   * that answer is two local reads, and a probe can take its whole 800ms
   * against an address that swallows packets.
   */
  ipcMain.handle(CH.sttStatus, () => sttStatusNow())
  /*
   * Settings → Voice's Test. It tests the panel's drafts (`sttConfigFrom`
   * repairs whatever crossed IPC), so a key pasted a moment ago is the key
   * tested, and it never transcribes: a model listing proves a key for free.
   * One at a time, claimed BEFORE the first await (gotcha 20) — the button is
   * disabled while it runs, but a second press is refused here too.
   */
  let voiceTesting = false
  ipcMain.handle(CH.voiceTest, async (_e, raw: unknown) => {
    if (voiceTesting) return { ok: false, tone: 'warning', message: 'A test is already running.' }
    voiceTesting = true
    try {
      return await testSpeechService(sttConfigFrom(raw))
    } finally {
      voiceTesting = false
      // A test is the moment someone has just started their server; let the pill ask again.
      sttProbe = null
    }
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

  /* ------------------------------------------------------ stoke from a shell */
  /*
   * The renderer's one ask, after its tab restore has settled. Everything
   * queued so far goes over in one answer, and every later request is pushed.
   * Only the app's own window may take them: a docked-browser page has no
   * preload, but the check costs nothing and the queue can name folders.
   */
  ipcMain.handle(CH.cliPending, (e) => {
    if (!win || e.sender !== win.webContents) return []
    launchReady = true
    return launchQueue.splice(0)
  })
  ipcMain.handle(CH.commandState, () => readCommandState(commandEnv()))
  ipcMain.handle(CH.commandInstall, () => serialCommand(() => installCommand(commandEnv())))
  ipcMain.handle(CH.commandRemove, () => serialCommand(() => removeCommand(commandEnv())))

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

/*
 * `stoke …` from a terminal, parsed from this process's OWN argv, before the
 * lock — because when another Stoke is already running, this process is about
 * to quit, and the request has to travel to that one as the lock's
 * `additionalData`. Electron says of the `argv` a `second-instance` handler
 * receives that it "will not be exactly the same list of arguments as those
 * passed to the second instance" (Chromium moves every switch ahead of every
 * positional), so the parsed request is sent rather than trusting the receiver
 * to re-parse a reordered one. Null for every argv without the `--stoke-cli`
 * marker — a Finder launch, a test's `--user-data-dir`, an updater relaunch.
 */
const launchRequest = parseStokeArgs(process.argv, { home: homedir(), platform: process.platform })

/*
 * A COLD double launch (no Stoke running yet, two `stoke` invocations racing
 * within the same few milliseconds) can still leave two live primaries, or
 * silently drop one launch's request — reproduced directly: two independent,
 * fully-booted Electron mains, each with its own renderer/GPU children, both
 * bound to the same userData dir, with `process_singleton_posix.cc` logging
 * `Failed to create .../SingletonSocket: File exists` / `Failed to create
 * symlinks` on the loser. That is Chromium's `ProcessSingleton::Create()`
 * race on POSIX, not electron/electron#52020 (`additionalData` overflowing
 * into a SIGKILL) — that issue is CLOSED as COMPLETED
 * (2026-07-27, fixed by #52025), and its signature
 * (`additional_data_size exceeds payload length`) never appeared in any
 * reproduction here. WARM double launches (one Stoke already running) are
 * reliable, because only a cold launch races to CREATE the lock file at all.
 * No fix shipped: the only real mitigation is Stoke owning its own
 * mkdir-based pre-lock and a launch-request relay ahead of this call, which is
 * boot-lifecycle surgery on the scale of gotchas 35/73/74, not a
 * `requestSingleInstanceLock` one-liner.
 */
if (!app.requestSingleInstanceLock(launchRequest ? { stokeCli: launchRequest } : undefined)) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    /*
     * The forwarded request first, re-validated field by field: it crossed a
     * process boundary and may come from another build. The argv is only a
     * fallback, for a second instance that sent nothing — see stokeArgs.ts for
     * why the transport's `--` keeps even a reordered argv readable.
     */
    const data = additionalData as { stokeCli?: unknown } | null | undefined
    const req =
      requestFrom(data?.stokeCli, process.platform) ??
      parseStokeArgs(argv, { home: homedir(), platform: process.platform })
    bringForward()
    if (req) acceptLaunch(req)
  })

  app.whenReady().then(() => {
    /*
     * Before anything reads a setting: open secrets.json and migrate any key
     * still in plain text in settings.json (secrets.ts). `safeStorage` is not
     * usable before `ready` on Windows and Linux, and the window's first paint
     * and every IPC answer should already see the keys.
     */
    initSecretStore()
    /*
     * The `stoke` command's copy of the account list (accounts.ts), brought
     * up to date now — an upgrade, or a settings.json edited by hand — and
     * after every write that changes it. Process-wide, not per window.
     */
    syncAccountIndex(getSettings().accounts)
    onSettingsChanged((next) => syncAccountIndex(next.accounts))
    protocol.handle(WALLPAPER_SCHEME, (request) => {
      const file = wallpaperFileFor(app.getPath('userData'), request.url)
      if (!file) return new Response('not found', { status: 404 })
      return net.fetch(pathToFileURL(file).toString(), { headers: { 'content-type': mimeFor(file) } })
    })
    registerIpc()
    createWindow()
    /*
     * Chat history. Nothing runs unless the user said yes (`chatIndex: 'on'`):
     * the first pass waits out boot, then one every fifteen minutes and on
     * window focus at most every five. A pass that finds nothing changed costs
     * one stat per chat, in the worker. Turning it on starts one at once;
     * changing a source or a cap starts one shortly after the last change;
     * turning it off stops the one running.
     */
    scheduleChatPass(CHAT_BOOT_DELAY_MS)
    setInterval(runChatPass, CHAT_PASS_EVERY_MS).unref()
    app.on('browser-window-focus', () => {
      if (getSettings().chatIndex !== 'on' || chatPassTimer || chatIndex?.running) return
      if (Date.now() - (chatIndex?.lastPassAt ?? 0) > CHAT_FOCUS_FLOOR_MS) runChatPass()
    })
    let chatSeen = { mode: getSettings().chatIndex, opts: JSON.stringify(getSettings().chatIndexOptions) }
    onSettingsChanged((s) => {
      const was = chatSeen
      chatSeen = { mode: s.chatIndex, opts: JSON.stringify(s.chatIndexOptions) }
      if (s.chatIndex !== was.mode) {
        if (s.chatIndex === 'on') scheduleChatPass(250)
        else {
          if (chatPassTimer) clearTimeout(chatPassTimer)
          chatPassTimer = null
          void chatIndex?.cancel().catch(() => undefined)
        }
        if (chatIndex) void chatIndex.status().then((st) => send(CH.chatsStatus, chatStatusFor(st)), () => undefined)
      } else if (s.chatIndex === 'on' && chatSeen.opts !== was.opts) {
        scheduleChatPass(1500)
      }
    })
    /*
     * Start the login-shell PATH probe now rather than when the renderer first
     * asks: it takes seconds, and the first session waits on it. The
     * remembered PATH loads first so a start in the meantime has one.
     */
    if (!isWindows) {
      void rememberLoginPathIn(join(app.getPath('userData'), 'login-path.json')).then(() => loginShellPathValue())
    }
    // A cold start's own request, queued until the renderer asks for it.
    if (launchRequest) acceptLaunch(launchRequest)
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
    /*
     * One-time, off the main thread: rewrite any `projectMeta`/`projectRoots`/
     * `pinnedProjects`/`hiddenProjects` entry still stored under a symlinked
     * path from before gotcha 91's launch-time realpath shipped (or written
     * into `~/.claude.json` by hand) onto its real path. `listProjects`
     * already merges these live for display, but a merge is a VIEW — Remove
     * and clearing an emoji patch the EXACT key the renderer sent, which is
     * the realpath, and never touch the stale one sitting underneath, so
     * neither ever took effect on a folder added before this shipped. Skips
     * the write (and the `settingsChanged` broadcast) when nothing was stale.
     */
    migrateSymlinkedProjectKeys(getSettings())
      .then((patch) => {
        if (!patch) return
        const next = setSettings(patch)
        send(CH.settingsChanged, next)
        sendWatchStates()
      })
      .catch((err) => console.error('[stoke] could not migrate symlinked project keys', err))
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
    // A pass stops where it is; the store is WAL, so an interrupted write is simply not there.
    void chatIndex?.stop()
    mcp?.stop()
    void remote?.stop()
    tunnel.stop()
    hubClient?.stop()
  })
}
