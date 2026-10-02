---
paths:
  - "src/main/ssh.ts"
  - "src/main/sshSessions.ts"
  - "src/main/sshUpload.ts"
  - "src/main/sshImages.ts"
  - "src/shared/imageUpload.ts"
  - "src/shared/imageJobs.ts"
  - "src/renderer/src/components/ImageSendStrip.tsx"
  - "src/shared/sshPersist.ts"
  - "src/main/sshEnroll.ts"
  - "src/main/enrollRuns.ts"
  - "src/shared/sshAuth.ts"
  - "scripts/verify-ssh-enroll.mts"
  - "src/renderer/src/components/SshKeyPrompt.tsx"
  - "src/main/sshTranscript.ts"
  - "src/main/pty.ts"
  - "src/main/remote/server.ts"
  - "src/main/worklog/watch.ts"
  - "src/main/worklog/sessionStore.ts"
  - "src/shared/paths.ts"
  - "src/renderer/src/lib/tabs.ts"
  - "src/renderer/src/components/HostsSettings.tsx"
  - "scripts/verify-ssh.mts"
  - "scripts/verify-tabs.mts"
  - "scripts/verify-worklog-gate.mts"
---

# SSH tabs

SSH tabs: the local-vs-remote cwd, the remote command, ssh escapes, and OSC 52 over tmux/byobu.
Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are
permanent — code comments cite them as "CLAUDE.md gotcha N".

## 18. An SSH session's `cwd` is the *local* folder, not the remote one

**An SSH session's `cwd` is the *local* folder, not the remote one.** `ssh -t <alias>` runs
`claude` on the far machine, so the transcript, the real working directory and the project
all live over there — but `SessionInfo.cwd` records wherever Stoke happened to be pointed
locally. Resolving a project group from it names the wrong project, or none. Anything that
gates on a folder needs a separate rule for SSH; the worklog uses a per-host switch
(`SshHost.worklog`) and reads the true cwd out of the fetched transcript.

## 19. Do not add flags to a user's remote connect command

**Do not add flags to a user's remote connect command.** Passing `--session-id` to the
remote `claude` would correlate a session exactly, but a remote CLI that does not know the
flag exits with an unknown-option error — and the *terminal itself* then breaks on every
connection to that host. `sshTranscript.ts` asks for the newest transcript instead. The
cost is real: two Claude sessions on one host at once cannot be told apart.

## 29. ssh's `~` escape is live on every SSH tab, and it corrupts pastes

**ssh's `~` escape is live on every SSH tab, and it corrupts pastes.** `buildSshArgs` sent no
`-e none`, and ssh runs on a pty here, so client-side escape processing is on regardless of
`-t`. `~` is read as an escape only directly after a newline — which is exactly where a
multi-line paste puts it, because xterm rewrites every newline to a bare `\r` and brackets
the blob as a whole rather than line by line (`Clipboard.ts:14,21-26`). Line 1 is safe and
lines 2..n are not: `~~` collapses to `~`, `~?` and `~#` print ssh's own help over the
session, and `~.` kills the connection while the user watches their paste do it. It reads as
"paste is flaky" because it is content-dependent, and `~/some/path` survives untouched.

Related and still open: **Stoke registers no OSC 52 handler** by default in xterm — 52 is
listed unimplemented in `InputHandler.ts` — so nothing on the far side of an ssh connection
could put text on the local clipboard. `pbcopy` writes to the *remote* clipboard; tmux
copy-mode and `vim "+y` had no channel at all. `TerminalView` now handles the write
direction and **refuses the read direction**, because `OSC 52 ; c ; ?` asks the terminal to
report the clipboard and everything a terminal renders is untrusted — a hostile file printed
with `cat` would otherwise read whatever was last copied.

"tmux wants `set -g set-clipboard on`" is too blunt, and the difference decides what to tell
a user. `set-clipboard` is a **server** option with three values, tmux 3.4 defaults to
`external`, and `external` is **asymmetric** — measured on the real VPS with an isolated
`tmux -L … -f /dev/null` server while watching the ssh pty:

| value      | tmux's own copy-mode → outer terminal | an app inside a pane emitting OSC 52 |
|------------|---------------------------------------|--------------------------------------|
| `off`      | no                                    | no                                   |
| `external` | **yes**                               | **no** — parsed and dropped          |
| `on`       | yes                                   | yes                                  |

So **byobu's own F7 copy-mode already reaches the local clipboard with no remote
configuration at all**, which is the honest answer to "how do I copy off the VPS": it is
keyboard-only and it covers the pane's scrollback. `on` buys exactly one more thing —
`vim "+y`, nvim's osc52 module, anything *inside* a pane. Two further traps: tmux emits at
all only if the outer `TERM` carries the `clipboard` feature, which `xterm*` has by tmux's
own built-in default and `pty.ts:231` sets, so the widely copy-pasted `Ms` override is
redundant here; and byobu already occupies `terminal-overrides` with `xterm*:smcup@:rmcup@`,
so "adding" an `Ms` entry with `set -g` **replaces** byobu's line rather than extending it.
`set -ga` is the only safe form.

One ceiling worth knowing before promising anything: **a pane running `claude` has no
scrollback anywhere.** It is on the alternate screen, so tmux keeps no history for it, and
byobu's `smcup@:rmcup@` stops tmux scrolling into Stoke's own scrollback either. Only the
visible screen is ever copyable out of such a pane, by any route — which is why the context
menu's `Copy screen` takes the viewport rather than the buffer.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - This is fixed, but the entry never says so, and its present-tense heading reads like an open bug. src/main/ssh.ts:376 pushes `-e none` on every SSH argv, ahead of `-t`, `--` and the alias. buildSshArgs is the only argv an SSH tab gets (src/main/pty.ts:219-221). scripts/verify-ssh.mts:167-244 pins it, including that `-e none` comes before the destination (:180-198).
> - This is not open. src/renderer/src/components/TerminalView.tsx:321-335 registers `term.parser.registerOscHandler(52, …)`. Writes go to `window.stoke.clipboard.writeText`, capped at `MAX_OSC52_BASE64` = 200,000 base64 characters (:32). A payload with no `;`, an empty payload, a `?` read and an oversized payload are all swallowed. The entry's own next sentence says the same thing, so calling it 'still open' contradicts itself.
> - The TERM assignment has moved. `env.TERM = 'xterm-256color'` is now src/main/pty.ts:259, and node-pty's `name: 'xterm-256color'` is :284.

## 75. A password prompt is recognised by what FOLLOWS it, not by the word "password"

**Every naive way to detect "ssh is asking for a password" also detects something the user is about
to type a different secret into.** The list is longer than it looks, and each entry is a real thing
that appears in a real terminal:

```
[sudo] password for v:                          a local sudo — a DIFFERENT password
Password for 'https://v@github.com':            git's credential helper — a TOKEN
Enter passphrase for key '/home/v/.ssh/id_...': ssh's OWN key prompt — the user already has a key
Do not share your password with anyone.         a server Banner, sent pre-auth by a machine we
                                                do not control, inside the detection window
```

A substring search for `password` matches all four. So does almost any regex with a free-form
`for <something>` clause, which is why that clause is absent from the PAM pattern in
`src/shared/sshAuth.ts` even though real PAM prompts sometimes have one — a pattern loose enough to
admit `Enter your LDAP password:` is loose enough to admit `[sudo] password for v:`. The miss is a
false negative and costs one unoffered key; the match costs a dialog offered while someone types a
production credential.

**The load-bearing rule is the tail anchor, and it is structural rather than lexical.** A prompt is
written *without a trailing newline*, because the program is about to block on the tty. So only the
text after the last line break can be a prompt. A banner line ends in `\n` and therefore can never
be one, whatever it says — which is the only defence against the banner case, since gates on
transport and byte budget both pass for it. The prompt patterns themselves are full matches taken
from the strings in the shipped `ssh` binary (`%s@%s's password:`, `Enter %.30s@%.128s's old
password:`, and the two others), not from memory.

Three more gates, each closing a case the shape rules cannot:

- **Transport.** Only a session launched with `opts.host` is scanned at all (`pty.ts`:
  `sshAuth: opts.host ? newSshAuthScan() : null`). One ternary excludes every local sudo, every
  local credential helper and every "password" the CLI itself prints, with no pattern matching
  whatsoever. Do not be tempted to widen it.
- **An escape byte closes the window permanently.** ssh's pre-auth output is plain ASCII with no
  `0x1b` in it at all (measured), so the first escape means something else is painting — `claude`,
  `tmux` and `byobu` all emit one in their first frame. Checked before the detector within a chunk,
  not after, so a chunk carrying both reports nothing: the safe answer to an ambiguous order is the
  quiet one.
- **Fired is one-way.** ssh asks three times by default (`numberofpasswordprompts 3`) and the
  enrollment PTY has `sshAuth: null` — without both, one connection produces three offers and the
  enrollment's own prompt produces an infinite loop.

**The parsed `user@host` is display-only and must stay that way.** It is text the far end sent.
Enrollment builds its argv from `SshHost.alias` — the same string the session that prompted was
built from — so a hostile server cannot redirect a key to a machine of its choosing. The parsed
value is shown precisely so a mismatch through a `ProxyJump` is visible to the user.

**`ssh-copy-id` exiting 0 is not evidence that anything works.** `PubkeyAuthentication no`, an
`AuthorizedKeysFile` pointing elsewhere, and a group-writable home directory each produce a happy
install and a server that still asks for a password. Only `buildPubkeyProbeArgs` — a real
connection with `BatchMode=yes`, which cannot prompt — may set `keyEnrolled`. This is CLAUDE.md's
"never print a diagnosis the tool can disprove" applied to a success message.

**Quoting: refuse, never escape.** `ssh-copy-id` sends the key on stdin (`cat >> authorized_keys`)
where it cannot be shell. The no-`ssh-copy-id` fallback has to embed it, so `isSafePublicKeyLine`
is a character whitelist and `buildRemoteInstallCommand` returns null rather than quoting anything
— the same rule `SAFE_ID` already applies to session ids. `isEnrollableAlias` is stricter than
`isConnectableAlias` for a specific reason: `buildSshArgs` can cope with a leading dash by emitting
`--`, and `ssh-copy-id` has no `--` in its usage line, so there an alias that looks like an option
becomes one.

**Gotcha 29 survives here in a different spelling.** The user types a password into the enrollment
PTY, so a `~` after a newline is still an ssh escape — but `ssh-copy-id` is a wrapper with no `-e`
flag. `-o EscapeChar=none` is the `ssh_config` form of the same setting; `ssh -G -o EscapeChar=none`
reports `escapechar none`.

> **Checked against the code on 2026-09-30** — this entry was written with the feature, and for
> two weeks none of it shipped: HEAD had only the contract (887b921); the main half, the strip and
> the suite sat on three unmerged branches. They are merged now, and four points above moved.
> - **`buildPubkeyProbeArgs` no longer sets `keyEnrolled`.** It probed with `-i <key> -o
>   IdentitiesOnly=yes`, which asks whether the SERVER takes the key — and passed for a key minted
>   as `~/.ssh/stoke_ed25519` that plain `ssh <alias>` never offers, so the flag went true and the
>   next tab still asked. The flag is now `buildLoginProbeArgs`' alone: BatchMode, publickey only,
>   `ControlPath=none`, no `-i`, no `IdentitiesOnly` — the tab's own identities. The `-i` probe only
>   words a failure. A key plain ssh would not offer gets one appended `Host`/`IdentityFile` block in
>   `~/.ssh/config` first (`saveKeyLocally`: bytes kept, `config.stoke.bak`, re-checked with `ssh -G`).
> - **"The enrollment PTY" is a tab now** — an "Add key to …" PtyManager session launched with
>   `LaunchOptions.enroll = { hostId }`, argv built in main by id (`planEnrollLaunch`). It still has
>   `sshAuth: null` (no `opts.host`), which is what keeps its own prompt from offering itself. See 109.
> - **"No `0x1b` before auth" is a POSIX measurement.** On Windows node-pty runs ConPTY, which
>   repaints as VT from its first frame (`CSI ?25l`, `CSI 2J`, an `OSC 0` title, `?9001h ?1004h`),
>   so the escape rule closed the window before ssh printed anything. `sshAuthStep(…, { conpty })`
>   scrubs OSC/CSI first and closes only on alt-screen, mouse tracking or bracketed paste — never on
>   ConPTY's own `?9001h`/`?1004h`. Replayed as a ConPTY-SHAPED stream in `verify:ssh-enroll`;
>   **never run on Windows**.
> - **The fallback body is `sh -c '…'`** with no single quote inside, because the remote LOGIN
>   shell parses it first: fish rejects `{ …; }`. Run under sh, bash, zsh, dash and tcsh here. A
>   Windows OpenSSH server has no `sh`; the failure says to run `ssh-copy-id` from Git Bash.

> **Checked against the code on 2026-09-30, second pass (review of the merge).** The tail anchor
> proves a prompt is on screen. It does not prove whose. The reconnect gate after an enrollment
> (`PtyManager.awaitingPassword`) read the last 512 bytes of a tab's output, and a shell that had
> logged in and then run `su` ends in `Password: ` (PAM's shape). Measured from bash 5.2:
> `su\r\n ESC[?2004l \r` then `Password: `. One that ran `ssh other` ends in `v@other's password: `.
> Both passed, so after every enrollment the renderer killed and reconnected them, on every tab of
> the host. The gate now reads `SshLoginWatch` (sshAuth.ts), a one-way flag kept for the session's
> whole life. It settles on the first of: something painting, the 16 KB budget, a finished line
> after the first prompt that is not ssh's own chatter, or Enter on a line that is not a prompt,
> not empty and not one of ssh's questions. That covers shells that paint nothing: dash, ash, bash
> before 5.1. The same watch withholds the OFFER from a session already in (`sshOutputStep`). That
> closes a false offer the detector made on its own: log in by key to a shell that paints nothing,
> run `su` inside the first 16 KB, and the detector saw an exact PAM prompt. Measured with dash.
> What remains is a host whose own `command` prompts before any shell runs (`su -`). That still
> reads as "at the prompt", and there is nothing to lose there.
> Proven on real bytes: a node-pty harness ran `/usr/bin/ssh` (OpenSSH 10.3) against a Debian sshd
> on loopback, with `-F /dev/null` and nothing in `~/.ssh` touched. After login, bash 5.2 and dash
> each ran `su` and a nested ssh, and a dash key login ran `su`. The old gate said true in all five
> cases and the new one false. On the key-login `su` the detector alone fired and the new step did
> not. Then in the built app: three restored tabs on one host. A stayed at ssh's prompt; B logged
> in and ran `su`; C logged in and ran a nested ssh. `awaitingPassword` answered true, false,
> false. After a real enrollment, A was reconnected by key and B and C kept their ptys. Two things
> that run showed: ssh 10.3 ends its log lines `\r\r\n\r`, and it prints `key fingerprint is:`
> with a colon. The pattern for that line now takes both forms.

## 109. An enrollment whose password prompt has no visible terminal can never complete

**ssh reads a password from its controlling terminal and from nowhere else — not stdin, not an
argument, not an environment variable Stoke would ever set — so an install that prompts has to run
where a person can type.** The first SSH key enrollment ran `ssh-copy-id` in a private node-pty
that was deliberately "not a PtyManager session" and that "nothing is ever written INTO": no tab,
no `pty:write`, no IPC reaching it. The renderer half, built in parallel, assumed the user would
type the password "into the terminal" — but the tab's xterm writes to the TAB's pty, the original
ssh sitting at its own prompt. So `ssh-copy-id`'s prompt appeared in the strip as text, sat for
`INSTALL_TIMEOUT_MS` (180 s) and was killed as "failed". On every host, every time — the feature
could only fail, and the timeout returned before the probe ran.

**Every suite was green and every commit said "measured".** The main half drove the orchestrator
with an injected `spawnPty` that exited on cue; the renderer half stubbed main in a throwaway copy
of the bundle; the detector was proved against a real sshd — up to the offer, and no further. Each
half was verified against the other's promise, and no run ever typed a password into a real
prompt. The injected fake is exactly the part that was wrong, so no amount of it could find this.

The shape now: the install is an ordinary PtyManager session (`LaunchOptions.enroll`, an "Add key
to …" tab, never saved for restore), the password goes over the existing `pty:write` path, and
main proves the result after the tab's process exits (`finishEnroll`). Proven end to end on
2026-09-30 on macOS against the built app and a password-only Debian sshd on loopback: the real
prompt raised the strip, Add a key opened the tab, the password typed over CDP `Input.insertText`
into that tab installed exactly one `authorized_keys` line (700/600), `keyEnrolled` went true, and
the source tab reconnected to a shell with no prompt. A wrong password left the tab open with ssh's
own "Permission denied" and a Try again that then succeeded; an already-authenticated tab was not
touched. `~/.ssh` was backed up first and restored byte-identical (19 files, same sha256 and modes).
(That tab sat at a shell prompt. One that had run `su` or a nested ssh WAS killed. The second
2026-09-30 note under 75 has the fix and the rerun.)

The rule for anything that asks a human for a secret: **verify against a real prompt, not an
injected fake**, and find the terminal the person will type into before writing the code that
waits for them to.

## 126. tmux draws SCREENS, not a stream: a kept session's scrollback and its reattach seam are both Stoke's job

**A host with `persist: 'tmux'` runs every SSH tab inside its own invisible tmux session**
(`buildPersistentCommand`, ssh.ts): a private server (`tmux -L stoke -f /dev/null`, so the user's own
tmux, byobu and `~/.tmux.conf` are never read or touched), no status bar, `mouse off`, one pane,
`new-session -A -s <Tab.remoteSession>`. The shell survives a dropped link, sleep and a Stoke quit;
ssh exit 255 reconnects by itself with backoff (`reconnectDecision`, tabs.ts), restore and Start
again reattach by name, closing asks Detach or End (`closeAsksDetach`), and the launcher lists
"Running on <host>" from a BatchMode `tmux -L stoke ls`. The name and the user's command reach a
remote shell, so both are whitelisted (`isSafeRemoteSessionName`, `isPersistableCommand`) — refused,
never escaped — and the whole body is one `sh -c '…'` because the login shell may be fish or tcsh.
`verify:ssh` runs it under sh, bash, dash, zsh and tcsh against a fake `tmux` that logs its argv.

Everything below was measured against real tmux 3.5a (Debian trixie) and 3.4 (Ubuntu 24.04) in
throwaway OrbStack containers, through a node-pty harness and the built app over CDP (2026-09-30).
**"With status off and one pane on the normal screen, output lands in xterm's scrollback" is only
half true, and each half needed a fix:**

- **tmux scrolls a burst with ONE `CSI n S` (terminfo `indn`), and xterm.js carries SU out WITHOUT
  keeping the lines.** `seq 1 3000` left a 30-line buffer: nothing reached the scrollback at all.
  `terminal-overrides` now also sets `indn@`, so tmux scrolls with newlines and xterm keeps them.
- **Even then, a burst is SNAPSHOTS.** tmux coalesces each read from the pane and clamps what it
  scrolls to the region height (`screen_write_collect_flush`), so `seq 1 3000` live kept 148 lines;
  interactive output a screen at a time is kept line for line. Byobu has the same limit. What makes
  the whole history come back is the reconnect: before attaching, the command prints
  `capture-pane -p -e -J -S - -E <end>` into the FRESH terminal a reconnect opens, and the tab's
  xterm has `scrollOnEraseInDisplay` (kept tabs only) so tmux's `CSI 2J` on attach pushes that dump
  into scrollback instead of blanking its last screenful. After a restart: 3000 of 3000 lines, in
  order, no duplicates (`history-limit` 5000; tmux's 2000 is less than one build log).
- **The capture's END has to match where the attach's screen starts, and the attach resizes the
  pane to the new pty FIRST.** Three ways that seam went wrong, each seen in the app: with no
  history, tmux clamps `-E -1` to screen line 0, so the top line showed twice; a pty shorter than
  the pane makes tmux drop blank rows under the cursor and push `cursor_y + 1 - rows` into history
  after the capture (a 38-row pane reattached at 36 lost two lines); a taller one pulls
  `rows - pane_height` lines back OUT of history (10 duplicated). The command asks tmux for
  `history_size pane_height cursor_y`, reads its own `stty size`, and ends the capture accordingly
  — tmux's own `screen_resize_y` rule — and the renderer starts a reattach at a live terminal's
  size (`termSizeHint`). Measured exact at 40→30, 30→40 and 36→36 on both versions, long and short
  output. `$(( ))` runs only once tmux answered all three numbers: dash exits on an empty operand.
- **`-u` is load-bearing.** A BatchMode or pty ssh without a UTF-8 `LANG` made tmux 3.5a draw `─`
  as ACS and `✓` as `_`. And tmux 3.4 printed each TAB of an `ls -F` format as `_` to such a client,
  so the listing splits on `|` (`REMOTE_SESSION_FORMAT`). `set -s terminal-overrides` REPLACES the
  array; `-ga` appended another copy on every reconnect.

**Keepalives are local options** (`-o ServerAliveInterval=15 -o ServerAliveCountMax=3`, before the
destination), not gotcha 19. A frozen container (`docker pause`) ended the link in 55–75 s and the
tab reconnected to the same shell once it thawed; a killed ProxyCommand ends it at once.

**Copy mode: do not bring Stoke's back.** It was removed in 0.9 for cause (gotcha 10's third clone
shape, Escape taken from the pane) and nothing here needs it: in a kept session the wheel, a plain
drag at a shell prompt, Shift-drag under an app that reports the mouse, `Copy screen` and OSC 52
(`set-clipboard on`) all work natively, and a reconnect reloads the history into the real
scrollback. tmux's own copy-mode is still the only route to history under BYOBU (mixed windows, no
kept seam) — the Hosts hint gives those users a snippet (`mouse on`, `set-clipboard on`, `-ga`) to
paste themselves — and no route at all reaches a pane on the alternate screen (`claude`), under
any setup. A Stoke-side wheel handler that types the tmux prefix and `[` was rejected: the prefix is
the user's to choose, and byobu uses F7.

Not measured: fish as the login shell ran the wrapper in the container but is not in the local
suite run (no fish here); mode 2031 / OSC 11 theme-follow through tmux (gotcha 42); a password
host's reconnect (it prompts again in the tab, by design); Windows OpenSSH as the client; the phone
starting a kept session (main mints the name in `launchSession`, unexercised).

> **Checked against the code on 2026-09-30, review of the branch.** Three corrections, each measured.
> - **"No chrome" left tmux's keys live.** `-f /dev/null` skips the user's config, not tmux's built-in
>   table, so C-b stayed the prefix. Through a pty client running the shipped command on 3.5a and 3.4:
>   `echo AB`, C-b, `X`, Enter printed `AB` (the shell never saw C-b); C-b [ put the pane in copy mode;
>   C-b c made a second window; C-b d detached with exit 0, which `reconnectDecision` reads as "the
>   shell ended", so the tab closed without asking Detach or End. `set -g prefix None` and
>   `set -g prefix2 None` now: `AXB`, no mode, one window, still attached, on 3.5a, 3.4 and 3.0a
>   (Ubuntu 20.04), and in the built app with real key events (`echo AXB` → `AXB`, `prefix=None`).
>   The root table holds only mouse bindings, which `mouse off` forwards to the pane. **Never
>   `unbind -a -T prefix`**, the obvious fix: once it has run the table is gone, so the next run
>   against that server (every reconnect, every second tab) fails "table prefix doesn't exist", and
>   tmux skips the rest of the `\;` sequence, `new-session` included. `-q` only hides it: still no
>   session, and exit 0. Measured on 3.5a and 3.4. `verify:ssh` pins both options and no `unbind`.
> - **Uptime is not "the link was up".** `decideHostExit` reset the try count once ssh had run 5 s.
>   A tab's ssh has no ConnectTimeout, so a try at a host that drops SYNs waits out TCP
>   (`net.inet.tcp.keepinit` is 75000 ms on macOS) and exits 255 long after 5 s: every failed try
>   reset the count, the wait never passed 1 s and the 24-try cap never fired. The exit event now
>   carries main's login watch (`loggedIn` = `SshLoginWatch.settled`; tmux's first paint settles it),
>   and `reconnectDecision` starts a run over only for a try that logged in AND lasted
>   `RECONNECT_MIN_UPTIME_MS`; a first try that never logged in stops however long it ran. Driven in
>   the built app against a proxy that swallows the connection for 8 s: tries 2, 3, 4 at 2, 5 and
>   10 s (the old rule: try 1 at 1 s each time), then the same shell (`$MARK` intact) once the host
>   came back, and a drop after that lasting login went back to try 1 at 1 s. A new tab whose first
>   try ran 8 s and never logged in got the plain card and no retry. **A password host does not
>   loop** — measured with OpenSSH 10.3 against sshd with `LoginGraceTime 8`: ssh sits at an
>   unanswered prompt past the grace time (it is blocked reading the tty), and exits 255 ("Connection
>   closed by … port …") only once something is typed. That line settles the watch, so a reconnect
>   after a late answer starts at try 1, with the user there to see the fresh prompt.
> - **The Detach/End question did not hold the countdown.** It ran on under the dialog, and a
>   reconnect replaced the tab with one on a new id, so the answer found nothing to close and the
>   tab came back live after End. Raising the question now pauses the timer (`pauseReconnect`),
>   `reconnectNow` refuses a session whose close is being asked, Cancel re-arms for the time the card
>   still shows, and the answer finds the tab by id or else by session name. A replacement whose
>   session tab was closed while its `pty.start` was in flight is killed, never appended
>   (`startHostSession`, gotcha 51). Driven: 9 s and 12 s under the question past a 5 s and a 10 s
>   countdown fired nothing (same pty, no try reached the proxy); Cancel tried at once; End closed
>   the tab and the host reported `no server running`. End pressed 4 ms after Reconnect now (before
>   the start's IPC reply) left no tab and no session behind. Not driven: Windows.

**Testing kept sessions without touching `~/.ssh`.** macOS's ssh reads its config and known_hosts from
the passwd home, but OrbStack's `Include ~/.orbstack/ssh/config` line expands `~` from `$HOME`. A
sandbox launched with a scratch `HOME` therefore gets its own `<HOME>/.orbstack/ssh/config`: hosts
with a scratch `UserKnownHostsFile` and a `ProxyCommand` script whose own command line names the
scratch dir, so a link drop is `kill -TERM` of your own process (it takes its relay child down;
ssh exits 255). Nothing in the real `~/.ssh` is written (it is still READ: the config, and any key a
`Host *` block names); hash it before and after anyway.

## 144. A process's exit must not be the only sign that its job is done: an "Add key" tab can finish its work and never exit

**Found by the owner on 2026-10-02, on a computer this session could not reach.** They pressed Add
a key on an SSH host, typed the password in the "Add key to …" tab, and the key went on, but nothing
followed. The strip sat on "Adding…" with only Not now to press, the tab stayed open, and the tab that
had asked for the password was never reconnected. Every path through `finishEnroll` reports to the
strip, and its probes give up within 25 s. So the strip can only stay busy like that if the
enrollment never reached `finishEnroll`, and the only way in was the tab's process EXITING
(`proc.onExit` → `finishEnrollRun`). Why that process stayed was not measured, because the machine
was not here. Two candidates fit: Windows' ssh under ConPTY with `-t` (the fallback's argv), and a
far side whose rc file leaves a background job holding the channel open. The fix does not depend on
which.

The rule: **watch for the result, and treat the exit as one of two ways in.** The install command
now ends with `printf "Stoke: key %s.\n" installed`. It is never spelled out in the command, so an
echo or a `set -x` trace of the command cannot match. `ssh-copy-id` already prints `Number of key(s)
added:` or `All keys were skipped…`. `EnrollRuns` (enrollRuns.ts) hands a run out exactly once,
either on `enrollInstallDone` over the tab's raw output tail (escapes stripped, so ConPTY's repaint
and a line cut across chunks still read whole) or on the exit, whichever comes first. A process
still running 1.5 s after the result is stopped. The line is only a hint. It is text, and the far
end can print anything, so all it starts is the same probe an exit with code 0 would, and the probe
alone sets `keyEnrolled`. `verify:ssh-enroll` holds the line under every shell installed here, the
matcher (ConPTY-shaped and split input, and never the command itself, its trace or ssh-copy-id's
pre-password INFO lines) and the exactly-once hand-out. Each was mutated back to red: dropping the
printf turned 6 checks red, dropping the escape strip 2.

**Not covered:** `ssh-copy-id` prints its count only after its own ssh returns. A far side that
holds the channel open therefore still keeps that path busy until the tab is closed. Closing it runs
the probe (the exit path, `signal` set), which then reports the truth. On Windows there is no
`ssh-copy-id.exe`, so the fallback, and with it the line, is always the one used. None of this has
run on Windows; the owner's machine is the first place it will.

## 146. An image reaches a remote `claude` only as a path that exists THERE, and several paths only in the form its splitter reads

**Built 2026-10-02 from the owner's "what can we do about images? for ssh sessions".** Three things
were true of an SSH tab before, each read out of Claude Code 2.1.287's own bundle, not assumed:

- **A local path names nothing on the far side.** A drop typed `'/Users/me/Shot.png'`; the remote
  `claude` tests each pasted piece for an image extension and reads it from ITS disk, finds nothing,
  and inserts the text. The model never sees a picture and nothing says why.
- **The clipboard is this machine's.** Ctrl+V makes the far `claude` read the far clipboard
  (`osascript`, `xclip`, `wl-paste`, PowerShell); over ssh it finds none and, when `SSH_CONNECTION`
  is set, flashes "No image found in clipboard. You're SSH'd; try scp?" for a second.
- **No byte of an image can ride the pty.** There is no image protocol in a terminal Claude reads;
  OSC 52's read is refused on purpose (gotcha 29).

So the bytes go over a **second** ssh, on stdin, and the far path is typed the way a drop types one
(`buildUploadArgs`/`buildUploadBody`, `sendImage`, `useSshImages`). The rules that make it safe:

- **The second connection's options are its own, before the destination, and never the tab's.**
  `-T` (a user's `RequestTTY force` would put a tty between `cat` and the bytes: CR/LF rewritten,
  ^D eaten), `RemoteCommand=none` (a config `RemoteCommand` refuses any command line),
  `BatchMode=yes` (it can never prompt — a password is typed only in a terminal, gotcha 109),
  `ControlMaster=no` and NO `ControlPath=none`: a master the user already runs may answer for a
  password host, but Stoke never becomes one, so it never leaves a persisted master behind. The
  tab's own argv, command and tmux session are untouched (gotchas 19, 126).
- **Everything that reaches the far shell is main's**: the host by id from settings, the name
  (`pasted-image-<stamp>-<hex>.png`, or a dropped stem cut to `[A-Za-z0-9._-]`), the extension from
  the magic bytes (`imageKind`: png, jpg, gif, webp — never the file's name or MIME type), the size
  from the bytes, a 25 MB cap. `isSafeUploadName` refuses rather than escapes, like `SAFE_ID`. The
  renderer sends "the clipboard" (main reads it — `public.png` raw first, so a screenshot is not
  decoded and re-encoded on the main thread) or a File's bytes, which also makes a path-less drag
  (an image out of a browser) work.
- **The far body cannot publish half a file.** `cat` into `NAME.part`, `wc -c` against the size,
  `mv`, and `rm -f NAME.part` on every failure — the scout's measured run left `.part` behind until
  that was added. A Cancel mid-send (the client killed) reached the far `cat` as EOF: exit 5, the
  `.part` removed, nothing typed. The fallback folder in a shared `$TMPDIR` must be the user's own
  and not a symlink (`-O`, `! -L`), or a planted `stoke-paste-<uid>` would receive the image.
- **The far path is text another machine sent**: accepted only absolute, ending in exactly the name
  Stoke chose, with no control character (a newline typed is Enter, gotcha 59), from the LAST
  `STOKE_PATH` line (rc files print to stdout too).
- **Listen for stdin's EPIPE** (`spawnWithInput`). ssh refusing a login exits before reading, and
  an `EPIPE` on a stream with no error listener is an uncaught exception in main. Measured by
  mutation: without the listener verify:ssh died with `Error: write EPIPE`.
- **Failures keep ssh's own words.** Only ssh's `Permission denied (` is `needs-login` (BatchMode:
  the answer is a key, so the strip offers the existing "Set up key login"), only its network lines
  are `unreachable`, anything else shows its last stderr line. A failed image stays held in main
  for Try again, so the clipboard is not read a second time.

**Several paths: the backslash form, never single quotes.** Claude Code splits a paste only at a
space followed by `/` or a drive letter (`/ (?=\/|[A-Za-z]:\\)/`), then strips one pair of matching
quotes per piece and turns `\x` into `x`. `'/a/Shot 1.png' '/a/Shot 2.png'` therefore reached it as
ONE piece, `/a/Shot 1.png' '/a/Shot 2.png`, which is no file — so a multi-file drop of macOS
screenshots, the commonest drop there is, never attached anything, and verify:drop asserted that
form as correct. `dropText` now types several POSIX paths with `escapePath`
(`/a/Shot\ 1.png /a/Shot\ 2.png`), which a shell reads literally too; one path keeps its quotes.
Two limits read from the same code: a path containing ` /` still splits there (rare, no form fixes
it), and on native Windows the reader's unescape eats single backslashes (`C:\a.png` becomes
`C:a.png` unless it is WSL), so Windows path attaching looks broken in the CLI itself — not
measured on Windows, and not changed here. Also from the bundle: Claude Code's image paste is
**Alt+V on Windows**, so `imagePasteKeys` sends ESC v there for a local Claude tab.

**Proven on 2026-10-02 in the built app on macOS** (screenshots kept beside the workflow): a scratch
non-root sshd on 127.0.0.1:2299 with throwaway keys and `SetEnv XDG_CACHE_HOME=<scratch>`, a second
one on 2298 with only password auth. The sandbox app could not be pointed at a scratch ssh config
any other way — `sshExecutable` pins `/usr/bin/ssh` ahead of PATH, macOS ssh reads the passwd home,
and a worktree agent may not move `HOME` (gotcha 128) — so its main process was started with
`NODE_OPTIONS=--require=<hook>`, a hook that prepends `-F <scratch config>` to every ssh argv
(child_process and node-pty alike) and logs it; nothing in `~/.ssh` was read for config or written.
A real PNG put on the system clipboard with `osascript` and Cmd+V in an SSH tab running a stub that
logs its pty input: the far file's sha256 matched the source, 0600 in a 0700 folder, and the stub
received ONE bracketed paste of its path. Through a throttling ProxyCommand the strip showed the
thumbnail, the size and Cancel; Cancel published nothing and left no `.part`. A drop of two
screenshots with spaces and a `.txt` sent both images (identical hashes) as one paste of two paths
and named the `.txt` as left out. The right-click Paste image, the per-host opt-out (the far stub
received `\x16`, nothing sent), a closed port ("could not be reached" + ssh's line, then Try again
after fixing the alias sent the held image) and the password host ("Permission denied (password)."
with Set up key login, nothing typed into its password prompt) were each driven. **Not proven:**
Windows (`ssh.exe` stdin of binary bytes, Alt+V), a real `claude` attaching the typed path, riding a
user's own ControlMaster, a remote tmux pane passing the bracketed paste, and fish or a Windows
OpenSSH server on the far side.

> **Checked against the code on 2026-10-02 (review of the branch).** Two of the hook's promises did
> not hold once a second paste or drop queued behind the first, and both were measured in the
> builder's own build against a ProxyCommand that throttles the upload to 100–400 KB/s:
> - **A queued paste read the clipboard when its turn came, not when it was pressed.** Copy A, Cmd+V,
>   copy B, Cmd+V, then copy some text: A arrived and B became "There is no image on the clipboard."
>   (with an image copied instead, that image would have been sent as B). `paste()` now asks main to
>   read and hold the clipboard at once; only the send waits its turn.
> - **A failure was drawn over by the job queued behind it.** With B queued, A's upload cut (its
>   proxy killed) showed no failure at all, even sampled every 100 ms: B started in the same tick, its
>   path was typed and A was lost without a word. A failure now holds the queue until it is answered:
>   Try again resends the held image and the queue carries on in order; Dismiss, or a new paste, lets
>   it go.
> The order, the waiting and what main is told to let go moved out of the hook into
> `ImageJobs` (src/shared/imageJobs.ts), pure, so verify:ssh holds them with a fake main: each rule
> was mutated back to red (eager read 1 check, the hold 1, Cancel ending only its own job 7, a
> cancelled send not holding the queue 2, an image held after the pane went being let go 1). Every
> id main holds belongs to one job and is let go when that job ends, however it ends. Also: main
> answers an image it no longer holds (`HELD_MS`) as `not-allowed`, a sentence, where `failed`
> offered a Try again that could only fail the same way. Re-proven in the fixed build on the same
> rig: A then B typed in order with the clipboard holding text by then (hashes A, B); A cut with B
> waiting held "The image was not sent. (1 more waiting)" plus ssh's `client_loop: send
> disconnect: Broken pipe` for 3 s with no upload running and nothing typed, then Try again typed A
> then B (hashes A, B, no `.part`); Cancel on A with B waiting published nothing of A and sent B; a
> two-screenshot drop with a `.txt`, the password host, the menu's Paste image and the opt-out (the
> stub got `^V`, nothing sent) behaved as before.
> - **The upload inherited the host's whole config, forwardings included.** A dev host's
>   `LocalForward` with `ExitOnForwardFailure yes` is common, and its tab already holds the port, so
>   EVERY image to it failed: measured with the shipped argv, exit 255, "bind [127.0.0.1]:23999:
>   Address already in use … Could not request local forwarding." A `LocalCommand` ran once per
>   image too. scp clears exactly these for its own ssh (scp.c's `do_cmd`), and an upload is a file
>   copy: `ClearAllForwardings=yes`, `PermitLocalCommand=no`, `ForwardAgent=no`, `-x`. verify:ssh
>   holds each in the argv and through real `ssh -G` over a config setting all of them the other way
>   (each mutated out: 2 checks red); in the built app a tab holding the forward then sent its image
>   (hash identical) with the host's `LocalCommand` run only by the tab.
> - **Riding the user's own ControlMaster, measured** (it was listed as not proven): an alias with
>   `PubkeyAuthentication no` and `ControlMaster auto` failed the upload argv with "Permission denied
>   (publickey)." while no master ran, and with a master open on its `ControlPath` the same argv
>   exited 0 and the file arrived sha256-identical (the master was a plain `ssh -M -N`, not a tab;
>   that a tab's own ssh becomes the master under `ControlMaster auto` is read from ssh, not driven).

## 152. A dropped file reaches main as a path the renderer never wrote, and main checks it twice: once when it is dropped and once when it is opened

**Built 2026-10-02 from the owner's "what about files? like if I want to drop a file through ssh?"**
On an SSH tab that sends uploads (gotcha 146), EVERY dropped regular file now goes to the machine
the way an image does — the same second BatchMode ssh with scp's options, the same `sh` body, the
same `~/.cache/stoke/paste` and day-old sweep — and the far paths are typed in the form Claude
Code's splitter reads. A file keeps its own name and extension through the image whitelist plus six
hex digits (`droppedFileName`: `Q3 board report.pdf` → `Q3-board-report-b4fe11.pdf`, `.tar.gz` kept
whole, `.env` → `env-<hex>`, an unsafe extension dropped, never cut). Images keep their own route
(bytes read in the renderer, named by their magic, a thumbnail, 25 MB); an image past 25 MB, or a
`.png` whose bytes are not one, goes as the file it is. Local tabs and hosts with `noUploads` type
the local path, as before.

**The path.** A File crosses to the preload, which reads its path with `webUtils.getPathForFile`
(`ssh.prepareFile(hostId, file)`) and sends only that, so the page names a File, never a path; a
File with no path behind it is answered without asking main. Files copied in Finder or Explorer are
read off the clipboard by main itself (`clipboardFiles`), as a pasted image is.

**Two checks, because a path is checked once and read later.** `inspectUploadFile` at the drop:
`realpath` through every link, then only a regular file within `MAX_FILE_BYTES` (100 MB); a folder
("…is a folder. Stoke sends files, not folders: drop the files inside it, or zip it first."), a
device, a pipe, a socket and a link to nothing each get a sentence. Nothing is tarred or walked.
Main holds the resolved PATH, not the bytes, so a queue of big files is never all in memory.
`openUploadFile` when its turn comes: `O_NOFOLLOW` (a link swapped in since is refused, ELOOP) and
`O_NONBLOCK`, then type and size from `fstat` of that descriptor, which is what is read.
**Without `O_NONBLOCK`, opening a FIFO swapped in for a checked file blocks forever** — measured by
mutation: verify:ssh hung until its 150 s timeout, and in main that open would sit on a libuv thread
for good. A file that grows after it is opened is sent as it was then (its first `size` bytes — a
live log), one that shrinks stops the send in a sentence and the far side keeps nothing (`.part`
removed, gotcha 146). A file gone by its turn is `not-file`: said, and the rest of its drop still
typed.

**A 0-byte file is a file.** The image body refused `size <= 0`, which is right for an image and
would have refused every empty file; it takes `0..MAX_FILE_BYTES` now, and `cat`/`wc -c` publish an
empty file. And the shared stem cut let a leading `_` survive, so `_x.png` (and `__init__.py`) failed
`isSafeUploadName` and was refused as "could not name that image safely"; it strips `[._-]` now.

**The bytes stream, and that is what the progress counts.** `spawnWithInput` writes 256 KB chunks,
each after the last was taken (`drained`), reading the file as it goes; `onProgress` is what ssh's
stdin has TAKEN, which runs ahead of what has arrived by ssh's own buffers, so the strip can sit at
100% for the last second or two of a slow link. A file gets 15 s + its bytes at 25 KB/s, at most 30
minutes, and is given up after `UPLOAD_IDLE_MS` (60 s) of ssh taking nothing while bytes are left —
never after the last byte, when a slow far side is not a stall. Images keep their two minutes.

**Copied files, per platform** (`clipboardFiles`; the peek's `files` count sends Cmd/Ctrl+V and the
menu's "Paste N files" to the machine ahead of the names Finder also puts on as text):
- **macOS, measured** in Electron 43: with two file URLs on the pasteboard, `clipboard.read(
  'public.file-url')` answered only the FIRST; `NSFilenamesPboardType`, which AppKit synthesises
  from them, is a plist listing both (XML, so `parseFilenamesPlist` decodes its entities). In the
  app, three URLs read back as three files. Chromium's own paste event also
  carried both as Files with paths, but Stoke's key handler takes Cmd+V before the page pastes, and
  main reading the clipboard keeps "the renderer names no path" for the menu's Paste too.
- **Linux**: `text/uri-list`, else GNOME's `x-special/gnome-copied-files`. Not run on Linux.
- **Windows**: `CF_HDROP` is a standard format Electron cannot name, so only `FileNameW` (the first
  path) is readable; `Shell IDList Array`'s first UINT is the count, and several copied files are
  refused with a sentence ("drop them instead") rather than one sent silently. Not run on Windows.

verify:ssh holds every rule above with real files (a FIFO, a socket, `/dev/null`, links, a sparse
file past the cap), the real body under `sh` for `sendFile`, and the queue with a fake main;
verify:drop holds the typed far-path form and that the strip types it as POSIX. 23 mutations, each
red (the `O_NONBLOCK` one as the hang above).

**Proven 2026-10-02 in the built app on macOS**, against a throwaway non-root sshd on
127.0.0.1:2301 (`SetEnv XDG_CACHE_HOME=<scratch>`, scratch keys and known_hosts, every ssh argv given
`-F <scratch config>` by a `NODE_OPTIONS=--require` hook as in 146; `~/.ssh` unchanged), the far
program a stub logging its pty input. One CDP `Input.dispatchDragEvent` of `server.log`,
`Q3 board report.pdf` and a 0-byte `empty.txt`: three sha256-identical files (0600 in a 0700 folder)
and ONE bracketed paste of three far paths. A folder drop: its sentence, nothing sent or typed. A
30 MB log through a ProxyCommand held to 1 MB/s: "Sending big build.log (1 of 2) to B2 slow… 30.0 MB
· 50%" and the bar, then identical; Cancel at 20% published nothing and left no `.part`. Three file
URLs put on the pasteboard with NSPasteboard (the type Finder writes) and Cmd+V: three identical
files, one paste; the menu said "Paste 3 files". A PNG and a text file named `.png` in one drop: the
first as an image (thumbnail, identical), the second as a file (identical). `noUploads` on: the local
path typed, nothing sent. A local tab: the local path typed. Two drops of `server.log` landed as two
names. **Not proven:** Finder's own Cmd+C (it adds names as text and an icon, which the files branch
goes ahead of), Linux and Windows clipboards, Windows `ssh.exe` streaming, a real `claude` reading a
non-image path, a fish or Windows OpenSSH far side.

Rig trap for whoever reruns it: count the pasteboard's items from a SECOND process before driving a
paste. Two early JXA `writeObjects` of two URLs each reported success and a fresh process then
listed one item (cause not found; later writes of three, through an `NSMutableArray`, all held).
And save and restore the owner's pasteboard around it (every item, every type) — it is theirs.

> **Checked against the code on 2026-10-02 (review of the branch).** Three defects, each fixed:
> - **A hold lapsed while it waited its turn.** Main let a held upload go `HELD_MS` (10 min) after
>   the press whatever else was happening, which was safe while every send was an image capped at
>   two minutes. A file may take 30. Copied files are all held at the press and sent one at a time,
>   and a pasted image waits behind a dropped file, so on a slow link the ones still waiting were
>   let go; their send answered `not-allowed` ("no longer waiting"), which ends the job WITHOUT
>   typing, so the paths of files that job had already sent were lost too. The holding is
>   `UploadHolds` (sshUpload.ts) now: a hold no one sends still lapses, but never while any send is
>   in flight. verify:ssh runs it on a fake clock; without the re-arm, 3 checks go red. Not driven
>   in the app (ten minutes a run). Drops were never affected: a drop's files are prepared only
>   when their turn comes.
> - **"huge.bin is 100.0 MB; Stoke sends files up to 100.0 MB."** is what a 100 MB + 1 byte drop
>   said in the built app: `formatBytes` rounds any size just past a cap to the cap's own figure.
>   Every cap refusal goes through `tooLargeSentence` ("is over 100.0 MB"); the suite had asserted
>   the contradictory sentence in three places.
> - **The strip said "Reading image…" while main read copied files**, and on Try again showed the
>   failed try's last percentage until the new ssh took a chunk (the retry keeps the upload id).
>   Driven: a 100 MB file through a 2 MB/s ProxyCommand, the proxy killed at 13% ("The file was not
>   sent." with ssh's `client_loop: send disconnect: Broken pipe`), Try again started with no figure,
>   then 0%, and arrived sha256-identical with no `.part`.
> Re-proven on 127.0.0.1:2301 in the fixed build: the three-file drop (one bracketed paste of three
> far paths, hashes identical, 0600 in 0700), the folder sentence with nothing sent or typed, an
> exactly-100 MiB file sent, and a local tab still typing the local paths.
