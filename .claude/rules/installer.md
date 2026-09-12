---
paths:
  - "src/shared/campfire.ts"
  - "scripts/gen-installer-art.mts"
  - "scripts/verify-campfire.mts"
  - "scripts/campfire-demo.mts"
  - "installer/install.sh"
  - "installer/install.ps1"
---

# The one-line installer's campfire

The ASCII fire the installer burns while it downloads, and the constraints that decide what it
may be made of. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each.
Numbers are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 70. The installer's fire is a quoting contract before it is an animation

**The installer's fire is a quoting contract before it is an animation, and five of its six
rules exist because a plausible implementation fails somewhere nobody on this machine would
look.** One copy of the art has to live in a POSIX single-quoted string and a PowerShell
here-string, print on a console that may round every colour it is sent, and leave a readable
transcript in a CI log — and each of those is a different failure when it goes wrong.

**The alphabet is `space ( ) / \ _ - . , * # = ^` and nothing else, and the apostrophe ban is
the load-bearing one.** A `'` ends a POSIX single-quoted string mid-art and takes the rest of
the script with it, which is why the sparks are `^` and the ground is `.-.,…,.-.` rather than
the `'-.,…,.-'` the first draft used. A backtick is PowerShell's escape character and POSIX
command substitution; `$` expands in both; `"` collides in both; and a line beginning `'@` ends
a PowerShell here-string, so `@` is banned outright rather than positionally. Everything is
ASCII on purpose: a PowerShell 5.1 console is often on cp437 or cp1252, and an installer whose
first act is to print `â–ˆ` has already lost. `*` is a glob and is safe only because every
expansion is quoted and everything is printed with `printf '%s'`.

**`$(cat <<'EOF' … EOF)` is a syntax error in bash 3.2 when the heredoc body has UNBALANCED
parens, and the art is nothing but unbalanced parens.** Measured here on GNU bash 3.2.57 — which
is what `#!/bin/sh` gets on every Mac — with a body of `     ( ) (` / `    ) (#) (`:
`unexpected EOF while looking for matching `)'`, exit 2, from both `/bin/sh` and `/bin/bash`,
while `/bin/dash` and `/bin/zsh` print it happily. A body whose parens happen to balance parses
fine under all four, which is exactly how this survives a casual test. So the failure appears
**only on macOS** and only on some art, and it passes every Linux CI check. Frames are therefore
stored as plain single-quoted assignments (`FIRE_F0='…'`), verified byte-for-byte through
`/bin/sh`, `/bin/bash`, `/bin/zsh` and `/bin/dash` by `verify:campfire` itself. That is also the
second reason the apostrophe had to leave the alphabet. Related: `$(…)` strips trailing
newlines, so round-tripping a painted frame through command substitution silently eats the last
row.

**Never use the alternate screen buffer.** It makes the animation trivially easy and is exactly
wrong here: it has no scrollback, and leaving it restores the previous buffer — so everything
the installer printed, including where it put the app and what to add to PATH, is gone the
instant it exits. It also destroys the scrollback of anyone scrolling back to audit what a
`curl | sh` just did, and a hard kill leaves the terminal *in* it with `reset` as the only way
out. `verify:campfire` asserts `1049` appears nowhere in the generated blocks, so a future
"let's just use the alt screen" cannot land quietly. Redraw is `ESC[7A` plus one `ESC[K` per
row, with the cursor always ending one line below the block so scrolling cannot desynchronise
it; the canvas is a fixed 7x15 for the same reason, and short stages are padded with empty rows
rather than shortened. Cursor restore (`ESC[?25h`) goes FIRST in cleanup, before anything that
can itself fail.

**`NO_COLOR` governs colour, not motion.** no-color.org says the variable, "when present and not
an empty string (regardless of its value), prevents the addition of ANSI color" — and says
nothing about animation. So `NO_COLOR=1` gets the monochrome fire (the art is a silhouette and
reads perfectly at 99 bytes a frame), `NO_COLOR=""` is explicitly *not* a trigger, and only
`TERM=dumb`, a pipe, CI, a window under 12 rows and `STOKE_NO_ANIMATION=1` reach the degraded
path — those say "this cannot render cursor movement", which is a different claim. The degraded
path prints one line per decile, append-only, no `\r` and no escape byte, and prints **no
percentage at all** when the server sent no Content-Length: a fabricated percent in a log
someone later pastes into a support thread is worse than no percent.

The other half of that, which is easy to leave untested and was: **a degraded terminal gets no
colour TIER either, not merely no animation.** `colorMode` returns `none` for every
`degradedReason`, before it ever looks at `COLORTERM` or `WT_SESSION` — deleting that one line
passed every other assertion in `verify:campfire` while making `renderPlan({}, piped).color`
`ansi256`, i.e. a pipe full of escape sequences, which is the exact failure the `none` assertions
exist to prevent one level down. `verify:campfire` now asserts `animate === false && color ===
'none'` for all six degraded shapes with `TERM=xterm-256color`, `COLORTERM=truecolor` and
`WT_SESSION` all set, since those are what would win. Seed `plainProgress`'s `lastDecile` at
**-1**, not 0: decile 0 is the real `0%` line that says the download started.

**On Windows the 16-colour tier is a choice, not a degradation.** The console host documents
that for colours beyond its sixteen it "will choose the nearest appropriate color from the
existing 16 color table", and its rounding table cannot be modified — `#e85f24`, `#ff9552` and
`#ffc48c` are close enough that conhost can collapse all three into one red and the fire loses
every bit of depth. So truecolor is used only when Windows Terminal or `COLORTERM` says so, and
`TERM` is not consulted on win32 at all. Detect VT by *trying to enable it* and believing
`SetConsoleMode`, never by OS version: a false positive prints `←[38;2;255;149;82m` at someone
as the first thing Stoke ever does, and `Add-Type` failing under ConstrainedLanguage or
AppLocker is an ordinary corporate way to reach that ambiguity. The 16-colour tier is
8-colour-safe (SGR 30-37 plus SGR 1, never the aixterm 90-97 brights).

**Colour by glyph class first, row second.** Colouring by row alone is the obvious
implementation and it paints the spark stage's only content — rows 3-4 — in the DIMMEST tier, so
the fire opens looking like ash. `#` and `*` are always white-hot, `.`/`,`/`^` are always
sparks, the hearth is always log brown, and only what is left takes its row's colour. That one
rule makes `(*)` read as a dark ring round a white-hot centre and `#####` read as the core of a
roaring fire.

**The art is generated and must never be hand-edited**, for the same reason `themes.ts` must not
be (gotcha 43). `src/shared/campfire.ts` owns it; `scripts/gen-installer-art.mts` emits the
block between `# BEGIN CAMPFIRE ART` sentinels; `verify:campfire` compares every file in the
repo carrying that sentinel against the generator's output byte for byte. That is not ceremony:
the segment encoding (`KEY:text|KEY:text`, so the draw loop forks no `awk` eight times a second)
was hand-written once during the research and shipped `(|#|=|` and a stray trailing pair into a
running script, which printed a literal `||` at the user and were found only by reading a real
run's stripped output. The defences are generation plus `decode(encode(x)) === x`, asserted on
the shipped bytes as well as on the module. Two things about that comparison: the block's own
preamble is **per target** — a ps1 block naming `FIRE_STAGE_PCT` and telling its reader to reach
for `printf` is a wrong instruction in a file nobody is allowed to correct by hand — and the
sentinel scan stops at any directory carrying its own `.git`, because `.claude/worktrees/` holds
a full checkout per parallel stream on this machine and a plain walk compares somebody else's
branch against this branch's generator. Measured: a stale block under `.claude/worktrees/` failed
the run naming a path that is not part of the checkout at all.

**And say out loud what no suite here can see** (gotcha 31, which this feature is unusually
exposed to): nothing pure proves that a Windows console renders the sequences, that the cursor
comes back after Ctrl-C or a `taskkill /F`, or that the canvas stays put when the terminal
scrolls at the bottom of the window. `node scripts/campfire-demo.mts` is the harness for all
three — `--sweep` redirects cleanly, so a Windows tester can be sent a file to `type`, but it
must be `--sweep --mode=ansi16 > frames.txt`: redirected with no `--mode` the tier is `none` by
the very rule above, so the file carries **zero escape bytes** and cannot answer the one question
that tester is there to answer. The demo says so on stderr rather than leaving it to be
discovered. It also traps SIGTERM and SIGHUP as well as SIGINT, because node runs no `exit`
listener under their default disposition — verified on a real pty, and verified failing with the
SIGTERM line removed. The three boxes are macOS Terminal or iTerm, Windows Terminal + pwsh, and
bare conhost + PowerShell 5.1.

> **Not verified from this machine** — there is no `pwsh` or `powershell` here, so the
> PowerShell art block has never been parsed by PowerShell. The here-string shape (`@'` ending
> its line, `'@` starting one, one variable per string so no `'@,` ever appears at the start of
> a line) is from the documentation, and the block's contents are asserted equal to the sh
> block's, which four real shells do reproduce byte for byte.
