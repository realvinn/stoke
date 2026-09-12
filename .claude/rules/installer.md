---
paths:
  - "src/shared/campfire.ts"
  - "scripts/gen-installer-art.mts"
  - "scripts/verify-campfire.mts"
  - "scripts/campfire-demo.mts"
  - "install/install.sh"
  - "install/install.ps1"
  - "install/index.html"
  - "worker/index.ts"
  - "worker/route.ts"
  - "scripts/verify-install.mts"
---

# The one-line installer

The two install scripts, the endpoint that serves them, and the ASCII fire they burn while they
download. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each.
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

## 71. Every signal the installer trusts arrives in a form that also has a plausible wrong reading

**Every signal the one-line installer trusts arrives in a form that also has a plausible wrong
reading, and six of them fail silently rather than loudly.** The script itself is simple; what is
not simple is that a 200 is not a success, a `Mozilla/5.0` is not a browser, a base64 digest looks
exactly like the hex one everybody's fingers type, and a 404 can be the correct answer. Each of
these is written down because the wrong reading is the one a competent implementation reaches for.

**`curl -f` does not catch an HTML interstitial served with HTTP 200, and that is the most likely
way this breaks in production.** Cloudflare's own Bot Fight Mode, Browser Integrity Check and any
Managed Challenge answer a request with an HTML page and status **200** — so `-f` passes, the body
reaches `sh`, and `sh` executes it. GitHub's error pages do the same. So the scripts assert the
SHAPE of what came back before trusting a byte: a manifest opens with `version:` at the start of a
line, and the asset it names must begin `Stoke-`. That assertion is not belt-and-braces, it is the
only thing standing between a challenge page and a shell. The other half of the fix is not in the
repo at all — Bot Fight Mode has to be off for that hostname, or a WAF skip rule added for
`http.host eq "stoke.vinn.dev"` — which is why README carries it as a deploy step rather than a
note.

**The `sha512` in `latest*.yml` is BASE64 of the raw 64-byte digest, not hex.** Measured against
the real v0.9.4 release: `openssl dgst -sha512 -binary <file> | openssl base64 -A` gives
`B14Hg5HLDSc3bBVqvR4D4PomUL9Yyllceb+zvgHupukxDxlJE4EYJNYnDwDiBRSkOjkaoBcOQO2TffJL4mdMqw==`,
byte for byte what the manifest carries. Every reflex — `shasum -a 512`, `sha512sum`,
`Get-FileHash` — emits the 128-character hex form, and a hex comparison fails **100% of the time**
looking exactly like a corrupted download, which is the kind of check that gets "fixed" by being
deleted. `verify:install` runs `install.sh --sha512` on random bytes against node's own
`createHash('sha512').digest('base64')` rather than grepping for the pipeline, because it is the
pipeline that has to be right.

**PowerShell's User-Agent starts with `Mozilla/5.0`.** Its own source builds it as
`{Compatibility} ({PlatformName}; {OS}; {Culture}) {App}` where `Compatibility` is that literal and
`App` is `PowerShell/7.5.0` or `WindowsPowerShell/5.1.x`. So "contains Mozilla, therefore a
browser" hands `irm | iex` an HTML page, and PowerShell's parse error on HTML reads like a broken
installer rather than a routing bug. In `worker/route.ts` the PowerShell test runs before anything
browser-shaped and is a case-insensitive substring test so the 5.1 spelling matches too — and the
`why` string is asserted alongside the body, so a case that starts passing for the wrong reason
(a browser served HTML by the fallback rather than by the Accept test) is a failure rather than a
coincidence. The fallback is HTML and must stay HTML: whatever fetched a pasted link and could not
be identified is far more likely to be a preview bot than a shell.

**A handled 404 is not a failure, and the downloader saying so out loud makes it look like one.**
`latest-linux.yml` does not exist in v0.9.4 — the release matrix gained Linux afterwards — so the
Linux branch's fetch is *expected* to 404, and `curl -fsSL` printed `curl: (56) The requested URL
returned error: 404` immediately above the sentence explaining that there is no Linux build yet.
Measured, and it reads as an unhandled error. The downloader's stderr is captured to a file now and
quoted only by the paths that have nothing better to say (`fetch_said`). The same capture matters a
second time and for an unrelated reason: **anything written to the terminal mid-frame lands inside
the campfire's 7-row canvas and smears it**, and the download runs in the background beside the
draw loop.

**electron-builder drops the architecture from the DEFAULT arch's filename, so the x64 AppImage has
no arch in its name at all.** `expandArtifactNamePattern` passes `skipDefaultArch = true`
(`platformPackager.js:547-556`), so `Stoke-0.9.5.AppImage` is the x64 build and only arm64 carries
a suffix — while macOS names both, because `electron-builder.yml` pins mac's `artifactName`. An
asset matcher written from the mac names alone finds nothing on Linux. `asset_matches` therefore
accepts a name with NO architecture in it as x64, and never as a fallback for arm64. (Related, from
the same file: `getArtifactArchName` rewrites x64 to `x86_64` for AppImage and rpm, and to `amd64`
for deb and snap, so the token is per-format too.)

**`uname -m` says `x86_64` on an Apple Silicon Mac when the shell is running under Rosetta**, and
taking that at face value refuses a machine that runs Stoke perfectly well — the release matrix is
arm64-only for macOS today, so the refusal would be total. `sysctl -n sysctl.proc_translated`
returning 1 is the tell, and the script flips back to arm64. Verified both ways with a `uname`/
`sysctl` shim on PATH: translated picks `Stoke-0.9.4-arm64.zip`, a genuine Intel Mac gets the
honest *"Stoke 0.9.4 has no mac x64 build"* and exit 1.

**`spctl --assess` rejects every build this project will ever ship.** It exits 3 by construction —
the app is signed but not notarized — so gating on it refuses every valid install. `codesign
--verify --strict --deep` is the check that means something and exits 0 on a real release. And do
not strip quarantine "just in case": measured, a `curl`-downloaded file gets `com.apple.provenance`
and no `com.apple.quarantine` at all, so there is nothing to strip and doing it unconditionally is
the habit that trains people to strip it from things that need it.

**macOS App Management will not let a script delete or write inside an app bundle some other
installer put in `/Applications` — but renaming it within `/Applications` is allowed.** So the
replace is: rename aside, `ditto` the new one in, then *attempt* to remove the renamed one and
carry on when that fails. Leaving a `Stoke.app.replaced-NNN` behind is far better than aborting an
install, and a script that does `rm -rf /Applications/Stoke.app` fails exactly for the user who
installed from the dmg.

**Never let the installer kill Stoke, on either platform, and on Windows that means closing it
*before* NSIS gets a chance.** The PTYs die with the app and the `claude` processes underneath do
not, and the restarted app cannot reattach to the orphans. NSIS's own "please close it" prompt
takes the default under `/S` (`allowOnlyOneInstallerInstance.nsh`'s `/SD IDOK`) and force-stops
everything under `$INSTDIR` — so `install.ps1` calls `CloseMainWindow()` and waits, leaving NSIS
nothing to do. `/S` and nothing else: `/allusers` under `/S` sends a `perMachine: false` installer
down the elevation path, which is a UAC prompt out of a one-liner, and `/D=` on an upgrade can only
move an install the user put somewhere deliberately, since the installer already reuses the
recorded `InstallLocation`.

**And clear `<cache>/stoke-updater/pending` after installing.** `selfUpdate.ts` sets
`autoInstallOnAppQuit`, so a build the user downloaded in the update panel and has not yet quit for
is sitting there waiting to be installed over whatever the script just put down.

**The one number in the fire that is hand-written is the stride.** The generated art block states
`n = stage * 3 + flicker` in its preamble and carries no variable for that 3, so both scripts
declare `FIRE_STRIDE` / `$FireStride` and `verify:install` asserts them against `STAGES[i].frames.length`.
A wrong stride is not a crash — it is a fire that flickers between the wrong two stages and looks
almost right.

**`verify:install` runs the shipped shell, not a copy of it**, which is the whole reason
`install.sh` has three offline flags. `--fire-frames <tier>` prints all twelve frames through the
same `fire_paint_row` the download loop calls, and the suite diffs them against `paint()` in
`campfire.ts` byte for byte in all four tiers — the art block being generated protects the DATA,
and this protects the decoder that reads it, which is the half that shipped a visible `||` once
(gotcha 70). `--print-plan tty|pipe` takes the terminal-ness as an ARGUMENT, exactly as
`campfire.ts` takes `Terminal.isTty`, so a suite with no terminal can still ask what the script
does on one; it is run against `renderPlan` over a table of environments, with `TERM`, `COLORTERM`
and `WT_SESSION` all set to what would otherwise win, so a rule that consulted them before the
degraded reason shows up as `truecolor` rather than `none`. And `--sha512` is what makes the base64
claim above assertable.

**A "never does X" assertion has to run against the code, not the file.** The scripts explain at
length why they do not use `spctl`, `/allusers`, `Get-FileHash` or `Invoke-WebRequest` — so the
first version of every one of those assertions failed on its own explanation. `verify:install`
strips whole-line `#` comments first (`code()`); grepping the raw text teaches the next person to
delete the comment.

> **Not verified from this machine, and the gap is larger on one side than the other.**
> `install.sh` has been driven end to end against the real v0.9.4 release — version resolved,
> 123,361,985 bytes downloaded, the base64 sha512 matched, the fire drawn on a pty and zero escape
> bytes when piped, plus the Intel refusal, the Rosetta flip, the Git Bash refusal and the Linux
> "not yet" through `uname` shims. `install.ps1` has been run **never**, and parsed by a PowerShell
> **never**, because there is none on this machine: every Windows claim in it is read out of
> `app-builder-lib`'s templates and Microsoft's docs. Nobody has watched the NSIS `/S` path, the
> HKCU upgrade detection or the VT probe do anything at all. The Worker has never answered a
> request either — `wrangler` is not installed and nothing has been deployed.
