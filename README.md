# stoke

a desktop app for claude code. one window instead of a pile of terminals.

it runs the real `claude` command underneath, so skills, mcp, plugins and slash
commands all work exactly like they do in a terminal.

mac (apple silicon and intel) and windows (x64 and arm64). linux gets an x64
appimage: ci builds it and drives the packaged app on every push, but that is
most of the running it has had, so treat it as experimental.

## download

the newest builds are betas. github only ever marks a stable release as
"latest", so the plain install line and the "latest" release both give you the
last stable one, which is older. for the current app, run this from a terminal
(not one inside stoke):

```bash
curl -fsSL https://stoke.vinn.dev/install-beta.sh | sh     # mac, linux, git bash
```

```bat
powershell -ExecutionPolicy Bypass -c "irm https://stoke.vinn.dev/install-beta.ps1 | iex"
```

the second one is windows, typed into command prompt or either powershell. then
open settings › updates and tick **offer beta releases**. leave it off and that
copy stays on the beta it installed until the next stable release: with it off
the updater only asks github for the latest stable, and that is older than your
beta, so it reports you're up to date.

stoke drives a coding agent you sign in to yourself — claude code, or one of the
others it supports. if none is installed, it offers to install one.

the latest stable release instead:

```bash
curl -fsSL https://stoke.vinn.dev | sh          # mac, linux
```

```bat
powershell -ExecutionPolicy Bypass -c "irm https://stoke.vinn.dev | iex"
```

more on what these do, and the knobs, under [the install lines](#the-install-lines).

### which file do i want?

or skip the terminal: every build is on
[releases](https://github.com/realvinn/stoke/releases). the newest one, at the
top, is marked pre-release — that's the current beta. the one marked latest is
the last stable release. each release has about thirty files, and you want one:

| you have | download |
| --- | --- |
| a mac with apple silicon (m1 or later) | `Stoke-<version>-arm64.dmg` |
| an intel mac | `Stoke-<version>-x64.dmg` |
| a windows pc | `Stoke-<version>-x64-setup.exe` |
| a windows pc on arm (snapdragon, surface pro x) | `Stoke-<version>-arm64-setup.exe` |
| linux, x64 | `Stoke-<version>.AppImage` |

not sure which mac? apple menu › about this mac says either "chip: apple m…" or
an intel processor. which windows? settings › system › about, "system type".

ignore the rest. `latest*.yml` and `*.blockmap` are for the updater, and so is
the mac `Stoke-<version>-<arch>.zip`. `Stoke-<version>-<arch>-win.zip` is a
portable windows copy with no installer (see [build an installer](#build-an-installer)).
`stoke-cli-*` is the [standalone terminal cli](docs/terminal.md), only if you want
that without the desktop app. there is no linux arm64 desktop build.

### opening a downloaded build the first time

the first time you open a browser download, mac and windows warn you, because
neither has a reason to trust these builds yet, and linux needs the file made
executable:

- **mac:** open the dmg, drag stoke into applications, open it. macos refuses
  it once: the app is signed with stoke's own certificate rather than an apple
  developer id, and apple hasn't notarized it. press done, then open system
  settings › privacy & security, scroll down to the line about stoke, press
  **open anyway** and confirm with your password. gatekeeper asks once per
  install, not on every update.
- **windows:** the installer isn't code-signed, so smartscreen says "windows
  protected your pc". press **more info**, then **run anyway**. edge may ask
  whether to keep the download first.
- **linux:** `chmod +x Stoke-<version>.AppImage`, then run it. if it says
  `No suitable fusermount binary found`, install fuse3 (`sudo apt install fuse3`
  on debian or ubuntu). as root it also needs `--no-sandbox`.

the install lines skip the mac and windows warnings: what `curl` and the
powershell script download carries no quarantine or mark-of-the-web flag, so
gatekeeper and smartscreen never look, and the script checks every byte against
the release's own sha512 instead. on linux they do the `chmod` and write a
`stoke` launcher that adds `--no-sandbox` for root; fuse3 is still yours to
install if it's missing. that's convenient, and it's exactly why the script is
worth reading first — the links are at the end of [the install lines](#the-install-lines).

## what you get

- all your projects in a sidebar, and old chats you can pick back up
- several sessions open at once, as tabs; use the mouse wheel over the tabs or
  the left/right scroll buttons when they overflow
- an optional [Codex usage-reset watcher](docs/codex-resume.md), with a custom resume message and follow-up timer
- a browser built in that claude can read and click
- how full the context window is, on every tab
- how much of your 5-hour and weekly limit is gone, and whether you're burning
  it faster than the clock is ticking
- your phone can drive it. hold the mic button to talk instead of typing
- it writes up your work into notion and clickup, if you let it. see below
- api keys in settings, so a launch from the dock or start menu has them:
  an anthropic console key, openrouter, or any anthropic-compatible gateway,
  plus openai and xai keys for codex and grok. they are sealed in a
  `secrets.json` beside stoke's settings, with the macos keychain, windows
  dpapi or a linux keyring; settings › backup & transfer says which

## the install lines

the windows ones work typed into command prompt, windows powershell or
powershell 7 alike. already in powershell, the short forms are
`irm https://stoke.vinn.dev | iex` and `irm https://stoke.vinn.dev/install-beta.ps1 | iex`
— but `irm` is a powershell word, so in command prompt either one alone says
`'irm' is not recognized`. in git bash the mac/linux line works too: it notices
windows and hands over to the powershell one, keeping the beta if you asked for it.

each line resolves the release, checks every byte against the sha512 in the
release's own update manifest, and puts the app where it goes. run the same line
again to upgrade. `STOKE_DRY_RUN=1` does all of it except the installing.

For automation, the ordinary installers still accept `--beta` / `-Beta` or
`STOKE_CHANNEL=beta`. `STOKE_VERSION` wins when you need one exact published
version, for example:

```bash
curl -fsSL https://stoke.vinn.dev/install.sh | STOKE_VERSION=1.0.0-beta.13 sh
```

Run from a terminal outside Stoke; installing closes the existing app cleanly.

The terminal unifier is now available as a [development preview](docs/terminal.md):
run `npm run terminal` from this checkout to resume your last live terminal or
start a normal shell. F2 opens New (shells, agents and connections), F3/F4 switch
sessions, F5 searches, F6 detaches and F9 opens settings.
Use `npm run terminal -- --cli opencode .` to open an agent directly. It includes
model selection, live session switching, native agent resume, config files,
OpenCode server attachment and SSH connections. `npm run pack:terminal` builds
a standalone CLI package without Electron. `npm run dist:terminal` builds a
portable archive with its own Node runtime. Shells and agents survive closing the UI or losing SSH;
`stoke sessions`, `stoke attach ID` and `stoke doctor` work from the shell.
Native CI targets macOS, Windows and Linux on x64 and ARM64; macOS ARM64 is
locally validated. New macOS builds default the `stoke`
command to this terminal; use `stoke --desktop .` for the graphical app.

In the currently published desktop builds, `stoke .` opens the folder you are in (or brings the tab
already running there forward), `stoke --new` always opens another tab,
`stoke --cli codex` starts a different coding cli, and `stoke --help` lists the
rest. on a mac the installer links the command into `~/.local/bin`; on linux it is
the launcher the installer writes; on windows, settings › updates › command line
puts it on your path. In new macOS builds use `stoke --desktop login` for Stoke sign-in
and device sync setup, and `stoke --desktop remote` for Phone access setup. See [CLI and remote setup](docs/cli.md)
for the difference between Stoke sign-in, coding-agent accounts and SSH access.

the canonical scripts are [install/install.sh](install/install.sh) and
[install/install.ps1](install/install.ps1). You can read the exact served scripts
at [install.sh](https://stoke.vinn.dev/install.sh),
[install.ps1](https://stoke.vinn.dev/install.ps1),
[install-beta.sh](https://stoke.vinn.dev/install-beta.sh) and
[install-beta.ps1](https://stoke.vinn.dev/install-beta.ps1) before running them.
The beta URLs reuse the same installers with the beta channel selected.

## run it from source

you need [node](https://nodejs.org) and [claude code](https://claude.com/product/claude-code) first.

```bash
git clone https://github.com/realvinn/stoke.git
cd stoke
npm install
npm run dev
```

## build an installer

```bash
npm run dist:win     # windows -> release/Stoke-<version>-x64-setup.exe
npm run dist:mac     # mac (m1) -> release/Stoke-<version>-arm64.dmg
```

`npm run targets` prints the rest. each one has to run on its own machine: a mac
app can only be built on a mac, and — less obviously — an arm64 installer can
only be built on an arm64 machine, because the terminal's native binary is
picked by name at runtime and npm only installs the build host's.

or build nothing at all: every tag builds all five on ci, so the windows
installers, the mac dmgs and the linux appimage are sitting on
[releases](https://github.com/realvinn/stoke/releases). the zips up there are two
different things: `Stoke-<version>-<arch>.zip` is only how a mac installs its own
updates, not something you need to download, while `Stoke-<version>-<arch>-win.zip`
is a portable windows copy — unzip it into a folder of its own and run `Stoke.exe`,
no installer. it updates itself in place, which is why the folder has to be its own: a copy
sharing a folder with other files (unzipped straight into downloads, say) says so and asks
you to update by hand instead.

## deploying the install endpoint

`stoke.vinn.dev` is one cloudflare worker whose whole job is deciding whether
you get the sh script, the ps1 script or the landing page. the two scripts are
baked into it from `install/` at deploy time. two commands, by hand:

```bash
npx wrangler login       # once, in a browser
npm run deploy:install   # every time install/ or worker/ changes
```

cutting a release does **not** need a deploy. the scripts ask github for the
latest release at run time, so a new tag is picked up by the next `curl | sh`
with nothing else to remember.

two things to set once in the cloudflare dashboard, and the first one breaks the
one-liner silently if you skip it:

- **turn bot fight mode off for that hostname**, or add a waf skip rule for
  `http.host eq "stoke.vinn.dev"`. a managed challenge answers with an html
  interstitial and **http 200**, which `curl -f` does not catch and `sh` will
  happily execute. both scripts check that what came back is really a release
  manifest for exactly this reason, but the fix is to stop it being served.
- **always use https** on for the zone.

`npm run verify:install` covers the routing rule, both scripts and the campfire
they draw — none of it needs a deploy or a token.

## phone access

press the phone button in the title bar. **Account → Pair phone to account** creates
a link to all your online computers, independent of the laptop that made the QR.
this needs the updated hub and remote website deployed; see [account remote availability](docs/remote-resilience.md).

for a computer-specific link, choose **This computer**, then **open on phone**. you get a code
to scan. same thing lives in settings -> phone access, with the knobs.

it picks a route a phone can actually use: tailscale if it's running on this
machine, otherwise your wi-fi. from outside the house, open the "reach it from
outside your network" section and point a cloudflare tunnel at it — install
`cloudflared`, give it the hostname yours routes to, and stoke runs the named
tunnel for you (or a throwaway quick one, which has no access policy in front
of it and is only worth using for a few minutes). turn on cloudflare access
once the named tunnel is up.

that link is a password. anyone with it can run commands on your machine, so
don't paste it anywhere. **replace the key** under advanced logs every phone
out.

the target desktop has to be awake and running stoke. the account website is
hosted independently; a **This computer** link also needs its issuing desktop
awake. add the computer-specific page to your home screen and it opens like an app.

## the worklog

settings -> worklog agent. tick the profiles you report on. off for everything
by default.

when a session you've ticked goes quiet for a couple of minutes, a cheap sonnet
run reads what you just did, looks at what's already on your notion and clickup
boards, and asks:

> add **fixed the context meter on resumed sessions** to clickup?

or, if the work was already on the board:

> mark **ship ssh sessions** as complete in clickup?

**nothing is written until you say yes.** every draft lands in the worklog panel
first, and "accept all" is still you accepting. a "not now" leaves it in the
panel; "reject" is permanent and never comes back.

it works for remote machines too. tick **write up work done on this machine** on
a host in settings, and stoke copies that session's transcript back over the
same ssh connection so the agent can read it — which also gives remote sessions
a context meter for the first time, since they've never had a transcript to read.
that tickbox gates the copy itself: while it's off nothing leaves the machine,
and the meter stays blank. if you run two claude sessions on one host at once it
can't tell them apart and will take the newest.

it costs tokens — it's a real claude run on top of the work you just did. it's
capped at six scans an hour, one per session every twenty minutes, and it reads
your boards at most once every ten minutes however many sessions get scanned.
those counters are kept on disk, so restarting stoke doesn't hand you a fresh
six an hour. only the ten-minute board read is held in memory, and that one does
start over. leave profiles you don't report on switched off.

## heads up

where things stand, so nothing here surprises you:

- **mac updates itself.** every release is signed with the same self-signed
  `Stoke` certificate, and that is what macos checks before it swaps in a
  downloaded update, so the in-app update works without an apple developer id.
  two things that certificate doesn't buy. notarization: a browser download
  needs **open anyway** once (see [opening a downloaded build the first
  time](#opening-a-downloaded-build-the-first-time)). and a team id: after an
  update macos may ask for your login password before stoke can read its
  keychain item, and "always allow" holds only until the next update, because
  without a team id the keychain ties that answer to the exact build. if stoke
  seems slow to open after an update, look for that dialog.
- **windows has run it.** the windows installer and portable zip aren't
  code-signed, so a browser download meets smartscreen. `install/install.ps1`
  first ran on real windows on 2026-09-21. ci now types the documented line into
  command prompt, windows powershell, powershell 7 and git bash, on x64 and
  arm64, against this branch's scripts; against the live site it installs from
  command prompt and windows powershell, on x64 only. both run weekly, and on
  every change to the installer.
- **keys are sealed** (see [what you get](#what-you-get)). the exception is a
  machine with no key store, like a linux box without gnome keyring or kwallet:
  there stoke keeps the keys in settings.json in plain text, as older versions
  did, and says so in settings › backup & transfer rather than call electron's
  fallback protected.
- **what no automated run has seen yet.** on mac: the window's own title bar —
  the traffic lights (a screenshot only ever shows the page, never the native
  chrome; the room the css leaves for them is measured) and its switch into full
  screen (the signal from macos that flips it is only read), finding `claude`
  when stoke is opened from the finder or the dock with no terminal to hand it a
  PATH (the failure path is measured; the login-shell probe succeeding there
  isn't), and ⌘ shortcuts from a real keyboard (the tests send synthetic key
  events). on windows: the context meter and tab dots with a
  real `claude` choosing git bash or powershell for its hooks, and a machine with
  no git for windows. ci runs the hook under both shells, with a stand-in cli.

## checks

```bash
npm run check             # typecheck, every suite, then the build. this is the gate
npm run verify:usage      # the limit numbers
npm run verify:install    # the one-liner: who gets which script, and what they do
npm run verify:context    # the context meter, run against the real transcripts
                          # in ~/.claude on whatever machine you run it on
```

the phone server has its own suite, and it wants a stoke that's already running
— give it the link and key from settings -> phone access:

```bash
npm run verify:security <url> <token>
```

add `--access` on the end if you've put cloudflare access in front of it.
