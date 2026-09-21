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
  - "wrangler.jsonc"
  - "scripts/verify-install.mts"
  - "scripts/serve-install.mjs"
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

> **Checked against the released feed on 2026-09-12.** v0.9.5 is the first release built by the
> five-platform matrix, and it invalidates two claims above. **macOS is no longer arm64-only**: the
> Rosetta paragraph's "the refusal would be total" and its *"has no mac x64 build"* measurement
> both described a matrix that no longer exists — `Stoke-0.9.5-x64.zip` is published, so misreading
> `uname -m` under Rosetta now costs a translated build rather than an install. The flip to arm64
> is still correct and is now load-bearing for a second reason: electron-updater's `MacUpdater`
> reads `sysctl.proc_translated` itself and prefers an arm64 file, so a script that installed the
> Intel build there would hand it an updater that immediately wanted the other architecture.
> **`latest-linux.yml` exists now**, so its fetch 404ing is a fault rather than the expected
> answer; only `latest-linux-arm64.yml` is still a deliberate 404 (`targets.mjs --list`), and the
> Linux refusal branch names arm64 rather than Linux for that reason.
>
> **Shim `uname` on PATH to reach the branches this machine cannot.** A four-line `uname` that
> answers `-s`/`-m` with the target's strings, prepended to PATH with `STOKE_DRY_RUN=1`, runs the
> shipped script through another platform's resolve/download/verify without a VM — it is how the
> Rosetta pair above was measured and the only way most of this file gets exercised at all. Run
> that way against the live v0.9.5 release, `linux/x86_64` resolved `latest-linux.yml` and verified
> `Stoke-0.9.5.AppImage` (121.9 MB), `Darwin/x86_64` verified `Stoke-0.9.5-x64.zip` (126.9 MB), and
> `Linux/aarch64` took the refusal. It stops at the download: what a shim cannot reach is the
> install itself — the AppImage landing in `~/.local/bin`, the `ditto` into `/Applications` on a
> machine that has no Stoke — so "the Linux path works" still means "resolves and verifies".

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

**`zsh -n` is not `zsh`, and the whole script was dead under the shell macOS makes the
default while every assertion passed.** zsh does not split an unquoted parameter expansion on
IFS unless it is told to, and three things here depend on that splitting: the flicker table
(`for fire_v in $FIRE_FLICKER`), the stage thresholds in `fire_stage_of`, and the painter's
`KEY:text` segments. So `$FIRE_FLICKER` arrived as ONE word, `eval "FIRE_FLICK_0=0 1 2 1 0 2"`
ran `1` as a command, and `zsh install.sh` died with `command not found: 1` on its first line of
real work — including for `--fire-frames`, which is the flag the suite uses. Measured: exit 127,
before the version was even resolved. `setopt sh_word_split` behind a `[ -n "${ZSH_VERSION:-}" ]`
guard is the whole fix, and `emulate sh` is NOT: it resets the options to sh's defaults and would
take the `set -eu` above it with them.

The generalisable half is the suite's, not the script's: `verify:install` parsed install.sh under
four shells and RAN it under one, so the difference between "parses" and "works" was the only gap
it had and it was exactly where the bug lived. It now runs every offline flag under every shell
and requires the output to be **byte-identical to `/bin/sh`'s** — identical rather than merely
exit 0, because a shell that painted wrongly would still exit 0. (Pass `LINES`/`COLUMNS`
explicitly when comparing: zsh assigns `LINES` itself, as **0** when there is no terminal, so
`--print-plan tty` degrades there and nowhere else for a reason that is not the script's.)

**And zsh has a SECOND, unrelated hazard in the same file: `$NAME[` is an array subscript there,
even inside double quotes.** `printf '%s' "$ESC[?25l"` is `zsh: invalid subscript`, fatal, so the
fire died on its first byte — and the same construct was in `fire_cleanup`, which means the cursor
would never have come back either. `setopt sh_word_split` does nothing about it. Write `$ESC'['`,
as `fire_draw` already did, which is the only reason that was not a third site.

That one is worth more as a lesson about the suite than as a fix. `fire_open`, `fire_draw` and
`fire_cleanup` only ever run with a terminal on the other end, so **no pipe and no offline flag
can reach them** — the suite had just been taught to run every flag under every shell and still
could not see it. It took a real pty. The suite now sources install.sh with `--help` (main returns
without doing anything) and calls the three functions directly, which is how the animate path gets
asserted at all: hide first, restore last, one redraw per draw, no 1049.

**The `?` in the `?sh` override is a glob, and zsh refuses an unmatched one outright.** The
landing page documented `curl -fsSL https://stoke.vinn.dev?sh | sh`, which on a stock Mac
terminal is `zsh: no matches found: https://stoke.vinn.dev?sh` and never runs curl at all — and
that line exists for the one person behind a User-Agent-rewriting proxy for whom nothing else
works. bash and dash pass an unmatched glob through unchanged, which is why it reads as fine.
Quote it. `verify:install` now scans the page and README for a `stoke.vinn.dev` URL carrying `?`
or `*` outside quotes.

**"Rename aside" is only an improvement while the replacement arrives.** The macOS replace
renames `/Applications/Stoke.app` out of the way and then copies the new one in — and the copy
was unguarded, so a read-only `/Applications`, a full disk or a `ditto` that dies took `set -e`
straight out of the script with nothing on screen but ditto's own line. Measured against a
relocated copy of the script with a ditto that refuses to write: **no `/Applications/Stoke.app`
at all**, a `Stoke.app.replaced-NNN` nobody had been told about, and no sentence anywhere saying
the app the user had was gone. The copy is guarded now and the aside is moved BACK on failure,
which is allowed for the same reason the rename was; `rm -rf` on the half-written bundle first is
safe precisely because that bundle is one this script created. Same class, same fix, for the
unpack: a bare tool error does not say whether anything was installed, and at that point the
answer is always "no".

**On Linux, `mv` from the temp dir is a COPY, and that is two failures rather than a style
point.** `$TMPDIR` is `/tmp` on nearly every Linux and nearly always a different filesystem from
`$HOME`, so `mv "$lin_src" ~/.local/bin/stoke` opens the destination for writing: `ETXTBSY` for
as long as Stoke is running, and a truncated binary where the working one was if it fails part
way. Copy into the target DIRECTORY under a temporary name and rename within it — atomic, and it
replaces a running AppImage happily, since the running process keeps the old inode until it
exits. That is also why the Linux path never asks Stoke to quit, and why it now says so: a
rename is silent, so a running copy carries on being the old version with nothing anywhere
saying why the upgrade "did nothing".

**Three bodies come back from one URL and nothing varies on it, so the response is `private`.**
`Vary: User-Agent` is refused for the reason above, and that refusal only holds if no shared
cache is invited to store the body: a `public` response with no `Vary` is one a corporate MITM
proxy — the very thing the `?sh` override exists for — may hand to the next client whatever it
asked for, which is a shell receiving the landing page or a browser offered a script. `private`
keeps the five-minute TTL for the end client, which has exactly one User-Agent.

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
> HKCU upgrade detection or the VT probe do anything at all.
>
> **Checked again on 2026-09-12, and several of those gaps are now closed.** Against the real
> v0.9.4 zip on this machine: `ditto -x -k` unpacks it, `codesign --verify --strict --deep` exits
> **0**, and `spctl --assess` answers `rejected` with exit **3** — the claim that gating on spctl
> would refuse every valid build, measured rather than cited. The macOS install half (rename
> aside, copy in, remove the aside, clear the pending cache, `open`) and the whole Linux half
> (arch-less x64 AppImage chosen over the arm64 one, stage-and-rename into `~/.local/bin`, desktop
> entry, recorded version, PATH warning) have both been run end to end against a copy of the
> script relocated onto temp directories, with the download served by a stand-in `curl`. Every
> failure path has been exercised the same way and each one fails closed with a sentence: an HTML
> body with status 200 for the manifest and for the asset, a truncated file, a wrong digest, a
> 404, no network at all, an unpack that fails and a copy that fails. Ctrl-C mid-download exits
> 130, removes the temp directory, and the **last escape sequence on the wire is `ESC[?25h`**.
> A body truncated at 10/30/60/90/99% and piped into `sh` installs nothing at any of them.
> The Worker has now answered real requests under `wrangler dev --local` — the whole User-Agent
> matrix, and all three bodies byte-identical to the files in `install/` — but nothing has been
> deployed, so the custom domain, the certificate and Cloudflare's bot defences remain untested.
> What is still genuinely unrun on macOS: the write into the real `/Applications` and the App
> Management refusal behind it, and `osascript -e 'quit app "Stoke"'` against a running copy
> (which will also raise a TCC prompt the first time, from whatever terminal ran the one-liner).

## 77. Cloudflare attaches a custom domain long before it publishes the DNS record

`npm run deploy:install` printed `Deployed stoke-install triggers / stoke.vinn.dev (custom
domain)` and `GET /accounts/{id}/workers/domains` listed the hostname as `enabled: true` with a
`cert_id` — while both of the zone's own authoritative nameservers answered **NXDOMAIN** for it,
and kept answering NXDOMAIN for about thirty minutes. Every API surface the wrangler token can
reach said "done"; only DNS disagreed.

The binding and the record are two separate objects. The account-level binding (hostname -> script,
plus the certificate) is what `wrangler deploy` creates synchronously. The DNS record inside the
zone is written separately and asynchronously, and it is what actually makes the name resolve.

**Prove where the gap is before touching anything**, by pinning the hostname to the zone's own
proxy IP — any address the apex resolves to — and letting the edge route on the `Host` header:

```
curl --resolve stoke.vinn.dev:443:104.21.9.126 \
  -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://stoke.vinn.dev
200 0
```

`200` with `ssl_verify_result=0` means the Worker, the route and the certificate are all already
correct and DNS is the only missing hop. A proxied record decides what resolvers answer, never
what the edge does with a `Host` header, so this test is valid while the name does not exist.

Then **wait**, and do not escalate. Deleting the binding (`DELETE
/accounts/{id}/workers/domains/{id}`) and re-running the deploy does not force the record out any
sooner; re-issuing the attach as a `PUT` is an upsert that returns the existing row unchanged and
writes nothing. Both were tried here and neither helped — the record simply appeared later.

The wrangler OAuth token cannot see or write DNS records at all: `GET /zones/{id}/dns_records` is
`403 code 10000`, and there is no `dns_records` scope anywhere in the scope set wrangler requests.
So the dashboard is the only fallback if a record genuinely never lands, and the record to add by
hand is a **proxied A** record (`192.0.2.0`, the address Cloudflare documents for originless
setups) or a proxied AAAA to `100::` — never a CNAME, which a custom domain refuses to coexist
with.

> **Checked against the code on 2026-09-13.** First real deploy of the Worker. After the record
> published, all three bodies were confirmed live by User-Agent — curl -> `install.sh`, a
> PowerShell UA -> `install.ps1`, a browser UA -> the landing page — plus `/install.sh` and
> `/install.ps1` as readable URLs, and the shipped body piped into `sh` ran `--print-plan pipe`
> (`animate=0 / color=none / reason=stdout is not a terminal`) and `--sha512`, which returned
> base64 ending `==`. No bot challenge appeared for a plain `curl` UA, so Bot Fight Mode is not
> currently interstitialling the hostname — that remains worth re-checking, since a challenge is
> HTML with status 200 that `curl -f` passes (71).

## 76. Electron refuses to start as root on Linux, and nothing in the app can catch it

**A Linux user running Stoke as root gets this and nothing else:**

```
[FATAL:electron/shell/app/electron_main_delegate.cc:224] Running as root without
--no-sandbox is not supported. See https://crbug.com/638180.
Trace/breakpoint trap (core dumped)
```

It is a `LOG(FATAL)` inside Chromium's own startup, long before the main process's JavaScript is
loaded, so there is no hook, no `app.on('ready')`, no try/catch and no "friendly error dialog"
available. Do not go looking for one. The check is Linux-only — crbug.com/638180 is a Linux bug,
and root on macOS starts normally — which is exactly why it survived every round of development
here.

**A wrapper IS the fix, and `~/.local/bin/stoke` is now that wrapper** — `linux_wrapper` writes
it, the AppImage sits beside it at `stoke.AppImage`, and as root the wrapper prints one line about
the cost and execs with `--no-sandbox`. Non-root pays one `id -u` and nothing else.

**Do not expect `AppRun` to have handled this.** It looks like it does: it adds `--no-sandbox` when
`unshare -Ur true` fails. As root that probe SUCCEEDS, and its own generated comment says so —
"when running as root, this check will always succeed ... this probe is mostly a no-op in that
scenario". Root is the one case the sandbox-detecting launcher does not detect.

`install.sh` still **warns before the download**, when interrupting is still free, because a root
install is a real choice rather than a typo — but it now warns about what running as root costs,
not about a build that cannot start. Up to v0.9.5 it wrote into `/root/.local/bin`, printed
`installed`, and left the user to find a core dump with a Chromium bug number in it.

> **Checked against the code on 2026-09-13.** This entry used to say the installer "cannot wrap its
> way out of it", because the AppImage had to BE `~/.local/bin/stoke` for in-place self-update.
> That was wrong, and it blocked the fix for a release. `node_modules/electron-updater/out/
> AppImageUpdater.js` reads `process.env["APPIMAGE"]` at lines 18, 38 and 73 and reads `execPath`,
> `argv` and `PATH` nowhere; the in-place decision is `path.basename(installerPath) ===
> existingBaseName || !/\d+\.\d+\.\d+/.test(existingBaseName)`. The constraint is a version-free
> BASENAME, at whatever path the runtime sets `$APPIMAGE` to — not a location on PATH. The updater
> cannot see a wrapper, so a wrapper on PATH is free. `verify:install` now RUNS the shipped
> wrapper, both branches, with `id` shimmed for the root one.

**`--preflight` exists for this.** Every decision the script makes about the machine — platform,
arch, root, and whether the warning fires — printed as `key=value`, resolving nothing and
downloading nothing. It is what lets `verify:install` shim `uname` and `id` onto the front of PATH
and assert all six branches from a Mac, including the two Linux ones that no machine here can
reach. Breaking the root condition turns exactly one assertion red (measured). The rule from
gotcha 74 applies to shell as well as to TypeScript: code that reads the real environment needs a
way to be asked about a different one, or five of its six branches are untestable everywhere.

## 100. `irm … | iex` is PowerShell, and a Windows user who opened "a terminal" is usually in cmd.exe

**The landing page's Windows line was `irm https://stoke.vinn.dev | iex`, and in Command Prompt
that is `'irm' is not recognized as an internal or external command`** — `irm` is a PowerShell
alias, and cmd.exe is what Windows opens for "Command Prompt", what many people call "the
terminal", and what a user reported the one-liner failing in (2026-09-21). The documented line is
now `powershell -ExecutionPolicy Bypass -c "irm https://stoke.vinn.dev | iex"`, which runs the
same install from cmd, Windows PowerShell 5.1 and PowerShell 7 alike (PowerShell's User-Agent
still routes it to the ps1 body); the short form stays on the page as prose for somebody already
in PowerShell, never as the `<pre>` a reader copies. `verify:install` holds all five places the
line is written (page, README, install.sh, install.ps1's header, the suite) and that the short
form is never the copyable one.

**The macOS/Linux line typed into Git Bash, MSYS2 or Cygwin now works too.** curl.exe sends
`curl/8.x`, so the Worker hands it install.sh; that used to print "run this in PowerShell
instead" and exit 1. `windows_handoff` runs the PowerShell installer itself: `powershell.exe`
first (it ships in every Windows 10/11), `-Command "irm https://stoke.vinn.dev/install.ps1 |
iex"` — the explicit path, so no User-Agent guess can turn it into the page — with stdin from
`/dev/null` (install.sh is still being read from curl's pipe, and PowerShell reading it would
swallow the rest of the file), `MSYS2_ARG_CONV_EXCL='*'` so MSYS2's argv rewriting keeps its
hands off the command, and the exit code passed back. `--preflight` reports `handoff=` so the
branch is assertable from a Mac, and verify:install RUNS it under sh, bash, dash and zsh against a
recording `powershell.exe`, with PATH holding nothing but the shims — GitHub's ubuntu runners ship
`/usr/bin/pwsh`, so any PATH including the host's would make the "no PowerShell" branch
unreachable in CI.

`scripts/serve-install.mjs` serves install/ through the Worker's own `routeFor`, so
`irm http://127.0.0.1:8787 | iex` exercises this branch's scripts rather than the deploy;
`.github/workflows/windows.yml` runs the line from cmd, Windows PowerShell, PowerShell 7 and Git
Bash on x64 and arm64. **The page change reaches users only after `npm run deploy:install`**,
which stays a deliberate, manual act (the Worker serves what was embedded at the last deploy).

> **Checked on Windows on 2026-09-21** (workflow run 35559817481). The documented line ran from
> cmd.exe, and the short form from Windows PowerShell 5.1, against the deployed stoke.vinn.dev on
> x64 — both installed Stoke. That is the first time install.ps1 has run anywhere. After review:
> the handoff's `MSYS2_ARG_CONV_EXCL='*'` leaked into the Stoke install.ps1 starts at the end, so
> every Claude Code session's Git Bash ran with MSYS path conversion off; PowerShell's first act
> is now `Remove-Item Env:MSYS2_ARG_CONV_EXCL`. And install.ps1 no longer calls an install with no
> Stoke.exe a success — the published arm64 installer exits 0 and installs nothing (gotcha 102).

> **Checked on Windows on 2026-09-21** (workflow run 35566018076): the Git Bash leg on
> `windows-11-arm` PASSED while the cmd, 5.1 and pwsh legs failed on the empty arm64 installer —
> because it installed the **x64** build. Git Bash is an x64 program running emulated on an arm64
> PC, `PROCESSOR_ARCHITECTURE` describes the process that set it, and powershell.exe inherited
> `AMD64` through the handoff; install.ps1 printed `machine windows x64` and every check passed,
> none of which asked what the installed Stoke.exe was built for. An emulated x64 Stoke works, but
> slowly, and its updater then follows `process.arch` and stays x64 for good. The workflow's
> one-liner check now reads Stoke.exe's PE machine field (0x8664 x64, 0xAA64 arm64) against the
> runner's arch. install.ps1 reads the MACHINE's value instead — Session Manager's registry
> `PROCESSOR_ARCHITECTURE`, then WMI's `Win32_Processor.Architecture` (12 = ARM64), its own
> process's value last. Measured from a Windows PowerShell started by Git Bash on
> `windows-11-arm` (`scripts/windows-arch-probe.ps1`, run 35568658784): env `AMD64` and .NET
> `RuntimeInformation.OSArchitecture` `X64` are wrong; the registry `ARM64`, WMI `12` and
> `IsWow64Process2`'s native `0xAA64` are right.
>
> **And the Git Bash leg had never tested this branch's install.ps1 at all.** install.sh's handoff
> fetches a hard-coded `STOKE_PS1_URL` (https://stoke.vinn.dev/install.ps1), so the leg ran the
> DEPLOYED script whatever the branch said — which is why the registry fix looked like it "did not
> work" there (it was never run) and the second attempt was written against a false reading.
> `scripts/serve-install.mjs` now rewrites that one assignment to point at itself and refuses to
> start if the line is gone. Every Git Bash user on arm64 still gets the x64 build until
> `npm run deploy:install`.
