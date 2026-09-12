---
paths:
  - "src/main/ssh.ts"
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
