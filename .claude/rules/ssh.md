---
paths:
  - "src/main/ssh.ts"
  - "src/main/sshEnroll.ts"
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

The rule for anything that asks a human for a secret: **verify against a real prompt, not an
injected fake**, and find the terminal the person will type into before writing the code that
waits for them to.
