/*
 * Lending this computer's microphone to Claude Code's `/voice` on an SSH host.
 *
 * The owner's words (2026-10-27): "stream via ws or something so we can tunnel
 * through our mic to the remotely connected so stoke becomes a mic that claude
 * listens to". The target is a Linux VPS with no sound card, reached by
 * password, whose `claude` runs inside a byobu/tmux server an EARLIER
 * connection may have started.
 *
 * What Claude Code does there, read out of the 2.1.312 linux-x64 binary (never
 * run): its native capture needs a non-empty `/proc/asound/cards`, which a VPS
 * has not, so it falls to `arecord` — found on PATH, accepted when `arecord
 * --version` exits 0 within 3 s AND the probe `arecord -f S16_LE -r 16000 -c 1
 * -t raw /dev/null` is still alive at 150 ms or exits 0 (memoised per
 * process). It then records `arecord -f S16_LE -r 16000 -c 1 -t raw -q -`,
 * reads raw PCM from stdout until the process closes, and stops it with
 * SIGTERM. No SSH gate: `qv()` in the availability check is `return!1`.
 *
 * So the whole tunnel is three pieces, and none of them touches the remote
 * command (gotcha 19):
 *
 *  1. The tab's ssh gets `-o RemoteForward=/tmp/stoke-mic.<token>.sock <local>`
 *     — a LOCAL option, beside the keepalives. sshd makes the far socket 0600
 *     (StreamLocalBindMask's default) and never unlinks a stale one
 *     (StreamLocalBindUnlink=no), so every connection gets a fresh token.
 *  2. A stand-in `arecord` in the user's `~/.local/bin` (micStandIn.ts) that
 *     connects to the newest of those sockets it OWNS, sends the token, and
 *     copies what comes back to stdout.
 *  3. Main's listener behind `<local>` (src/main/micTunnel.ts), which checks
 *     the token and then asks the GATE below whether anyone in front of this
 *     computer is actually talking to that `claude` right now.
 *
 * The gate is the security of the whole feature, not a nicety. Any process on
 * the far machine running as the user can connect to that socket as often as
 * it likes, and the token (the socket's own name) is no secret there. So a
 * connection gets audio only while the person here is plainly asking for it:
 * Space HELD in that tab (auto-repeat seen, as the CLI's own hold detection
 * needs), or a connection within `MIC_TAP_WINDOW_MS` of an ISOLATED Space tap
 * (`/voice tap`). A plain "a Space was typed recently" would hand a looping
 * process audio every time the user typed a sentence.
 *
 * Pure, and compiled by both tsconfigs: no `node:` import (gotcha 27).
 * verify:mic-tunnel holds every rule.
 */

/** What Claude Code records: 16 kHz, mono, signed 16-bit little-endian, raw. */
export const MIC_SAMPLE_RATE = 16_000
/** One frame to main: 20 ms, 320 samples, 640 bytes. */
export const MIC_FRAME_SAMPLES = 320
export const MIC_FRAME_BYTES = MIC_FRAME_SAMPLES * 2

/** The token: 16 random bytes as 32 lowercase hex, the random part of the far socket's name. */
export const MIC_TOKEN_HEX = 32
export const MIC_REMOTE_DIR = '/tmp'
export const MIC_REMOTE_PREFIX = 'stoke-mic.'
export const MIC_REMOTE_SUFFIX = '.sock'

/** How long a new connection has to send its token before it is closed. */
export const MIC_TOKEN_WAIT_MS = 3000
/** The most bytes a token line may take, newline included. */
export const MIC_TOKEN_LINE_MAX = 80

/*
 * The gate's numbers, each derived rather than picked.
 *
 * HOLD. The OS repeats a held key after a delay and then at an interval:
 * macOS 500 ms then 83 ms (NSEvent.keyRepeatDelay/keyRepeatInterval, measured
 * on the owner's Mac 2026-10-28), Windows ~500 ms then ~33 ms, GNOME 500 ms
 * then ~33 ms. The CLI starts a hold only after five Space events each within
 * 120 ms — four repeats at least — and only then spawns `arecord`, whose
 * connection crosses the link once more. So a real hold's connection lands
 * with three or more repeats seen here even at zero latency; asking for TWO
 * leaves a margin and still refuses a press that has not started repeating.
 * FRESH: the last Space event must be this recent, so a keyup lost to a focus
 * change (no `space-up` ever arrives) cannot leave a "hold" open: four of the
 * slowest common repeat intervals (~100 ms), which also covers a renderer that
 * stalled for a few frames.
 */
export const MIC_HOLD_REPEATS = 2
export const MIC_HOLD_FRESH_MS = 400

/*
 * TAP. `/voice tap` starts on one Space at the prompt. The connection follows
 * after the byte crosses the link (one-way L), the stand-in starts (sh plus
 * python3: ~30-100 ms on a small VPS) and the forward crosses back (L): about
 * 2L + 100 ms, so 1.5 s covers a one-way latency up to ~650 ms. Longer is a
 * longer window for a looping process on the far side; shorter fails a slow
 * link. One connection per tap, ever.
 *
 * ISOLATED: no other key in this tab for 800 ms before the tap. Inter-key
 * intervals while typing run about 100-300 ms (median ~200 ms; well under
 * 800 ms for nearly every keystroke of an ordinary typist), so every Space
 * between two words of a sentence fails this, while a tap at an idle prompt —
 * the only place `/voice tap` starts — passes it. A non-Space key after the
 * tap, before the connection, refuses it too: that was typing.
 */
export const MIC_TAP_WINDOW_MS = 1500
export const MIC_ISOLATION_MS = 800

/*
 * Once streaming, Claude Code ends it itself (SIGTERM, which closes the
 * socket): a 200 ms gap in the repeats in hold mode, a second tap in tap mode,
 * 15 s of silence, a 2 min cap. Stoke ends it too, so a far process that won
 * a window cannot keep it: GRACE after the Space that should end it (the
 * release of a hold, the second tap) is ample for the CLI's own hang-up to
 * cross the link, and the cap matches the CLI's two minutes.
 */
export const MIC_END_GRACE_MS = 1500
export const MIC_MAX_STREAM_MS = 120_000
/** A far side not reading: past this many unsent bytes (16 s of audio) the stream ends. */
export const MIC_BACKLOG_MAX_BYTES = 512 * 1024

/* ---------------------------------------------------------------- names */

export function isMicToken(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
}

/** The far socket this connection forwards: `/tmp/stoke-mic.<token>.sock`. */
export function micRemoteSocket(token: string): string | null {
  return isMicToken(token) ? `${MIC_REMOTE_DIR}/${MIC_REMOTE_PREFIX}${token}${MIC_REMOTE_SUFFIX}` : null
}

/** The token a far socket's name carries, or null for anything else. */
export function micTokenOf(path: string): string | null {
  const m = /^\/tmp\/stoke-mic\.([0-9a-f]{32})\.sock$/.exec(path)
  return m ? m[1] : null
}

/**
 * The longest local socket path a forward may name. `sun_path` is 104 bytes on
 * macOS and 108 on Linux, NUL included; ssh must `connect()` to it.
 */
export const MIC_LOCAL_PATH_MAX = 100

/**
 * Where ssh connects on THIS machine: a Unix socket in a private (0700)
 * folder, or `127.0.0.1:<port>` on Windows. Whitelisted, never escaped: it is
 * one whitespace-split word of an ssh option, so a space, a colon in a path or
 * a `..` would be a different forward.
 */
export function isMicLocalEndpoint(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const tcp = /^127\.0\.0\.1:(\d{1,5})$/.exec(v)
  if (tcp) {
    const port = Number(tcp[1])
    return port >= 1 && port <= 65535
  }
  if (v.length > MIC_LOCAL_PATH_MAX || !v.startsWith('/')) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(v)) return false
  return !v.split('/').some((seg) => seg === '..' || seg === '.')
}

/**
 * The `-o` value that lends the microphone: `RemoteForward=<far> <local>`.
 *
 * `-o RemoteForward=` rather than `-R`, though `ssh -G` reads both the same
 * (measured, OpenSSH 10.3): `prepareSshRoute` (sshRoutes.ts) finds the
 * destination by skipping the options it knows take a value, `-o` among them
 * and `-R` not, so a `-R <spec>` would have been read as the host.
 */
export function micForwardOption(token: string, local: string): string | null {
  const remote = micRemoteSocket(token)
  if (!remote || !isMicLocalEndpoint(local)) return null
  return `RemoteForward=${remote} ${local}`
}

export function isMicForwardOption(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = /^RemoteForward=(\S+) (\S+)$/.exec(v)
  return !!m && micTokenOf(m[1]) !== null && isMicLocalEndpoint(m[2])
}

/**
 * Does this first line from a connection carry the listener's token? Exactly
 * the token and a newline (a CR before it tolerated); anything else is a
 * refusal. The caller compares in constant time; this is the shape.
 */
export function micTokenLine(buffered: string): { done: false } | { done: true; token: string | null } {
  const nl = buffered.indexOf('\n')
  if (nl < 0) return buffered.length >= MIC_TOKEN_LINE_MAX ? { done: true, token: null } : { done: false }
  const line = buffered.slice(0, nl).replace(/\r$/, '')
  return { done: true, token: isMicToken(line) ? line : null }
}

/* ----------------------------------------------------------------- gate */

/** What the renderer reports of a key in that tab. Bare modifiers are never sent. */
export type MicKey = 'space-down' | 'space-repeat' | 'space-up' | 'other'

/** The pane's state as the renderer sees it. Main ANDs its own window focus in. */
export interface MicPane {
  /** The tab is the one in front in its window. */
  front: boolean
  /** The terminal holds the keyboard in a focused window. */
  focused: boolean
  /** Stoke's own dictation is armed or recording there. */
  dictating: boolean
}

export type MicRefusal =
  | 'busy'
  | 'not-front'
  | 'not-focused'
  | 'dictating'
  | 'no-press'
  | 'used'
  | 'not-asked'

export type MicStopReason =
  | 'closed'
  | 'key'
  | 'tab'
  | 'blur'
  | 'dictating'
  | 'tab-closed'
  | 'cap'
  | 'ended'
  | 'stop'
  | 'failed'
  | 'slow'

/** How a stream was admitted, which decides the Space that ends it. */
export type MicMode = 'held' | 'tap'

interface MicPress {
  downAt: number
  /** No other key in the `MIC_ISOLATION_MS` before it. */
  isolated: boolean
  down: boolean
  repeats: number
  /** The last Space event of this press (its down or a repeat). */
  lastAt: number
  /** Admitted a stream already, or happened while one ran (an ending tap): never admits. */
  used: boolean
}

interface MicStreaming {
  mode: MicMode
  startedAt: number
  /** The latest moment the stream may run to: the cap, pulled in by an ending Space. */
  endBy: number
}

export interface MicGateState {
  pane: MicPane
  lastOtherAt: number | null
  press: MicPress | null
  stream: MicStreaming | null
}

export const MIC_GATE_IDLE: MicGateState = {
  pane: { front: false, focused: false, dictating: false },
  lastOtherAt: null,
  press: null,
  stream: null
}

export interface MicGateStep {
  state: MicGateState
  /** Set when the stream running must end now. */
  stop: MicStopReason | null
}

/**
 * A key in the tab. While streaming, any non-Space key ends it at once (the
 * person is typing, not talking); the Space that should end a stream — the
 * release of a hold, a new tap during a tap stream — pulls its end in to
 * `MIC_END_GRACE_MS` for Claude Code to hang up first.
 */
export function micGateKey(s: MicGateState, kind: MicKey, now: number): MicGateStep {
  if (kind === 'other') {
    return { state: { ...s, lastOtherAt: now, press: null }, stop: s.stream ? 'key' : null }
  }
  if (kind === 'space-down') {
    const isolated = s.lastOtherAt === null || now - s.lastOtherAt >= MIC_ISOLATION_MS
    const press: MicPress = { downAt: now, isolated, down: true, repeats: 0, lastAt: now, used: !!s.stream }
    let stream = s.stream
    if (stream && stream.mode === 'tap') stream = { ...stream, endBy: Math.min(stream.endBy, now + MIC_END_GRACE_MS) }
    return { state: { ...s, press, stream }, stop: null }
  }
  if (kind === 'space-repeat') {
    // A repeat with no press of ours (Space already down when the tab came to
    // the front, or after another key cleared it) starts nothing.
    if (!s.press || !s.press.down) return { state: s, stop: null }
    return { state: { ...s, press: { ...s.press, repeats: s.press.repeats + 1, lastAt: now } }, stop: null }
  }
  // space-up
  if (!s.press) return { state: s, stop: null }
  let stream = s.stream
  if (stream && stream.mode === 'held' && s.press.used) {
    stream = { ...stream, endBy: Math.min(stream.endBy, now + MIC_END_GRACE_MS) }
  }
  return { state: { ...s, press: { ...s.press, down: false }, stream }, stop: null }
}

/**
 * The pane moved. Leaving the front, losing the keyboard, or Stoke's own
 * dictation arming there ends a stream, and forgets the press: a tap made
 * before a tab switch must not admit anything after it.
 */
export function micGatePane(s: MicGateState, pane: MicPane): MicGateStep {
  const stop: MicStopReason | null = !s.stream
    ? null
    : !pane.front
      ? 'tab'
      : !pane.focused
        ? 'blur'
        : pane.dictating
          ? 'dictating'
          : null
  const keep = pane.front && pane.focused && !pane.dictating
  return { state: { ...s, pane, press: keep ? s.press : null }, stop }
}

export type MicVerdict = { ok: true; mode: MicMode } | { ok: false; reason: MicRefusal }

/**
 * A connection with the right token has arrived: stream to it, or not.
 * `windowFocused` is main's own reading of the window (`isFocused()`), ANDed
 * with the renderer's. An admission uses the press up: one connection per hold
 * or tap.
 *
 * The mode: a hold that was NOT isolated is plainly hold-to-talk (typed, then
 * held Space), so its release ends it. An isolated press is ambiguous — an
 * idle hold, or a `/voice tap` pressed a little long — and is treated as a
 * tap, ended by the next Space, so a tap-mode user is never cut off on
 * release.
 *
 * This gate is the lent microphone's security, not the token: any far process
 * can connect, and the token is the socket's own name there. Never loosen it
 * to "a Space was typed recently" (CLAUDE.md gotcha 166).
 */
export function micGateAdmit(s: MicGateState, now: number, windowFocused: boolean): { state: MicGateState; verdict: MicVerdict } {
  const no = (reason: MicRefusal) => ({ state: s, verdict: { ok: false, reason } as MicVerdict })
  if (s.stream) return no('busy')
  if (!s.pane.front) return no('not-front')
  if (!s.pane.focused || !windowFocused) return no('not-focused')
  if (s.pane.dictating) return no('dictating')
  const p = s.press
  if (!p) return no('no-press')
  if (p.used) return no('used')
  const held = p.down && p.repeats >= MIC_HOLD_REPEATS && now - p.lastAt <= MIC_HOLD_FRESH_MS
  const tap = p.isolated && now - p.downAt <= MIC_TAP_WINDOW_MS && now >= p.downAt
  if (!held && !tap) return no('not-asked')
  const mode: MicMode = held && !p.isolated ? 'held' : 'tap'
  return {
    state: { ...s, press: { ...p, used: true }, stream: { mode, startedAt: now, endBy: now + MIC_MAX_STREAM_MS } },
    verdict: { ok: true, mode }
  }
}

/** The stream ended (any reason): the gate is idle again, the press stays used. */
export function micGateEnded(s: MicGateState): MicGateState {
  return s.stream ? { ...s, stream: null } : s
}

/** Past its end: the cap, or the grace after the ending Space. */
export function micGateTick(s: MicGateState, now: number): MicStopReason | null {
  if (!s.stream) return null
  if (now < s.stream.endBy) return null
  return now - s.stream.startedAt >= MIC_MAX_STREAM_MS ? 'cap' : 'ended'
}

/** When the next tick has something to decide, for the caller's timer. */
export function micGateDeadline(s: MicGateState): number | null {
  return s.stream ? s.stream.endBy : null
}

/* ------------------------------------------------------------ the wire */

/** main -> the tab's renderer: a connection was admitted; open the microphone for it. */
export interface MicOpenEvent {
  streamId: string
  ptyId: string
  hostId: string
  mode: MicMode
}

/** main -> the tab's renderer: the stream ended; close the microphone. */
export interface MicCloseEvent {
  streamId: string
  ptyId: string
  reason: MicStopReason
}

/** What "Set up microphone there" answered over a one-shot key-login ssh. */
export type MicInstallResult =
  | { ok: true; report: MicSetupReport }
  | { ok: false; needsLogin: boolean; message: string }

/* -------------------------------------------------------------- keys in */

/**
 * What a DOM key event in the tab is to the gate, or null for one it never
 * hears: an untrusted event, and a bare modifier (Shift, Ctrl, Alt, Cmd, Caps
 * Lock, Fn), which is not typing. Space with Ctrl, Alt or Cmd is a chord, so
 * "other"; Shift+Space still types a space. An IME composition is "other".
 */
export function micKeyOf(
  e: { type: string; code: string; key: string; repeat: boolean; isTrusted: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean; keyCode?: number },
): MicKey | null {
  if (!e.isTrusted) return null
  if (e.type !== 'keydown' && e.type !== 'keyup') return null
  if (/^(Shift|Control|Alt|Meta|CapsLock|Fn|FnLock|Hyper|Super|OS)(Left|Right)?$/.test(e.code) || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'AltGraph'].includes(e.key)) return null
  const composing = e.isComposing === true || e.keyCode === 229
  const space = e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey && !composing
  if (e.type === 'keyup') return space ? 'space-up' : null
  if (!space) return 'other'
  return e.repeat ? 'space-repeat' : 'space-down'
}

/* ---------------------------------------------------------------- words */

/** What the strip says while streaming. */
export function micStripText(hostLabel: string): string {
  return `Mic → ${hostLabel}`
}

/** One short line per refusal, for main's log: never audio, never the token. */
export const MIC_REFUSAL_WORDS: Record<MicRefusal | 'token' | 'unbound', string> = {
  busy: 'a stream is already running',
  'not-front': 'the tab is not in front',
  'not-focused': 'the window or terminal does not have focus',
  dictating: 'Stoke’s own dictation is on there',
  'no-press': 'Space was not pressed there',
  used: 'that press already admitted a stream',
  'not-asked': 'Space is not held and was not tapped on its own just now',
  token: 'wrong or missing token',
  unbound: 'the tab is not running yet'
}

/** Why ⇧⌘D does not arm Stoke's dictation on a tab that lends the microphone (gotcha 79). */
export function micOwnsSpace(hostLabel: string): string {
  return `This tab lends your microphone to Claude’s /voice on ${hostLabel}: hold Space there to talk to it, or run /voice tap and tap Space. To use Stoke’s dictation here instead, turn off “Lend this computer’s microphone” for this machine in Settings › SSH hosts.`
}

/* ---------------------------------------------------------- setting up */

/**
 * The far `sh` body that installs the stand-in as `~/.local/bin/arecord`,
 * from base64 (`b64`, made in main from `MIC_STAND_IN`). Null when `b64` is
 * not plain base64 — it is put in a command a remote shell parses, so refused,
 * never escaped, like every other body here.
 *
 * - It never replaces an `arecord` there that is not Stoke's (the marker).
 * - `.part`, a run of `--version`, then `mv`: a cut-off copy is never the
 *   recorder Claude finds.
 * - It then asks an interactive LOGIN shell (`-ilc`, as gotcha 52's probe
 *   does) which `arecord` it finds (`STOKE_MIC login <path>`), because that is
 *   what a byobu/tmux window's shell is — and Claude Code's native installer
 *   puts `~/.local/bin` on PATH in `~/.bashrc`, which a non-interactive login
 *   shell may never reach — and says so when it is not this one: the stand-in
 *   only works where Claude's PATH reaches `~/.local/bin` first. Under a 10 s
 *   `timeout` where there is one, so an rc file that waits cannot hang it.
 *   Only a line starting with `/` AFTER the shell's own `STOKE_MIC_ASK` is
 *   taken: rc files print to stdout too (a greeting, fortune, a path), and
 *   with no arecord found the last line out was theirs, read as "finds
 *   arecord at Welcome to …".
 * - Python 3 or Perl is how the stand-in connects; it says which is missing.
 *
 * No single quote anywhere in it: the caller wraps it in `sh -c '…'`.
 * Exit codes: 3 no folder, 4 an arecord that is not Stoke's, 5 no base64,
 * 6 write failed, 7 install failed, 8 installed but would not run.
 */
export function micSetupBody(b64: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  return [
    'umask 022;',
    'd="$HOME/.local/bin"; f="$d/arecord";',
    'mkdir -p "$d" || { echo "Stoke: could not make $d"; exit 3; };',
    'if [ -e "$f" ] && ! grep -q STOKE_MIC_STANDIN "$f" 2>/dev/null; then echo "Stoke: $f is there and is not from Stoke, so it was left alone."; exit 4; fi;',
    'command -v base64 >/dev/null 2>&1 || { echo "Stoke: this machine has no base64 command."; exit 5; };',
    `printf %s ${b64} | base64 -d > "$f.part" || { rm -f "$f.part"; echo "Stoke: could not write $f"; exit 6; };`,
    'chmod 755 "$f.part" && mv -f "$f.part" "$f" || { rm -f "$f.part"; echo "Stoke: could not install $f"; exit 7; };',
    '"$f" --version >/dev/null 2>&1 || { echo "Stoke: $f is installed but would not run."; exit 8; };',
    'printf "STOKE_MIC installed %s\\n" "$f";',
    't=; command -v timeout >/dev/null 2>&1 && t="timeout 10";',
    'p=$($t "${SHELL:-/bin/sh}" -ilc "echo STOKE_MIC_ASK; command -v arecord" </dev/null 2>/dev/null | sed -n "/^STOKE_MIC_ASK\\$/,\\$p" | grep "^/" | tail -n 1);',
    'printf "STOKE_MIC login %s\\n" "${p:-none}";',
    // The same findings in words, for the "Set up microphone on …" tab, where the person reads this output itself.
    '[ "$p" = "$f" ] || echo "Stoke: a login shell on this machine finds ${p:-no arecord}, not $f. Put ~/.local/bin first on PATH (in ~/.profile), then start claude again.";',
    'if command -v python3 >/dev/null 2>&1; then echo "STOKE_MIC connect python3"; elif command -v perl >/dev/null 2>&1; then echo "STOKE_MIC connect perl"; else echo "STOKE_MIC connect none"; echo "Stoke: this machine has neither python3 nor perl, which the stand-in needs to connect. Install one of them."; fi'
  ].join(' ')
}

export interface MicSetupReport {
  /** Where the stand-in went, as the far side said. */
  installed: string | null
  /** What a login shell there finds for `arecord`, or null when it said none. */
  loginFinds: string | null
  /** `python3`, `perl`, or null when neither is there. */
  connector: 'python3' | 'perl' | null
  /** The login shell finds the stand-in, and it has a way to connect. */
  ready: boolean
  /** Sentences for the person, in order: empty when there is nothing to fix. */
  notes: string[]
}

/**
 * Read what `micSetupBody` printed. Every line is text the far machine sent,
 * so only the `STOKE_MIC` lines are read, the last of each kind wins (rc files
 * print too), and a path is shown, never acted on.
 */
export function parseMicSetup(stdout: string): MicSetupReport {
  let installed: string | null = null
  let login: string | null = null
  let connector: MicSetupReport['connector'] | undefined
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    let m = /^STOKE_MIC installed (\/[^\u0000-\u001f]*)$/.exec(line)
    if (m) installed = m[1]
    m = /^STOKE_MIC login (.*)$/.exec(line)
    // A path or nothing: an rc file's greeting (and `command -v`'s answer for an alias) is not where claude finds arecord.
    if (m) login = !m[1].startsWith('/') || /[\u0000-\u001f]/.test(m[1]) ? null : m[1]
    m = /^STOKE_MIC connect (python3|perl|none)$/.exec(line)
    if (m) connector = m[1] === 'none' ? null : (m[1] as 'python3' | 'perl')
  }
  const notes: string[] = []
  const finds = !!installed && login === installed
  if (installed && !finds) {
    notes.push(
      login
        ? `A login shell there finds arecord at ${login}, not ${installed}. Put ~/.local/bin first on PATH there (in ~/.profile), then start claude again.`
        : `A login shell there does not find arecord on its PATH. Add ~/.local/bin to PATH there (in ~/.profile), then start claude again.`
    )
  }
  if (installed && connector === null) notes.push('That machine has neither python3 nor perl, which the stand-in needs to connect. Install one of them there.')
  if (installed) {
    notes.push(
      'A claude already running there keeps the PATH it started with, and one that started inside a byobu or tmux window keeps that window’s: start claude again in a new window if /voice says it finds no recorder.'
    )
  }
  return { installed, loginFinds: login, connector: connector ?? null, ready: finds && !!connector, notes }
}
