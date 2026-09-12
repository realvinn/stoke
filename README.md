# stoke

a desktop app for claude code. one window instead of a pile of terminals.

it runs the real `claude` command underneath, so skills, mcp, plugins and slash
commands all work exactly like they do in a terminal.

windows and mac. a linux appimage is built too, but nothing here has ever
been run on linux — treat it as experimental.

## what you get

- all your projects in a sidebar, and old chats you can pick back up
- several sessions open at once, as tabs
- a browser built in that claude can read and click
- how full the context window is, on every tab
- how much of your 5-hour and weekly limit is gone, and whether you're burning
  it faster than the clock is ticking
- your phone can drive it. hold the mic button to talk instead of typing
- it writes up your work into notion and clickup, if you let it. see below

## install it

```bash
curl -fsSL https://stoke.vinn.dev | sh          # mac, linux
```

```powershell
irm https://stoke.vinn.dev | iex                # windows
```

that resolves the latest release, checks every byte against the sha512 in the
release's own update manifest, and puts the app where it goes. run the same line
again to upgrade. `STOKE_DRY_RUN=1` does all of it except the installing.

the scripts are [install/install.sh](install/install.sh) and
[install/install.ps1](install/install.ps1), and the endpoint serves those files
byte for byte — <https://stoke.vinn.dev/install.sh> is worth reading before you
pipe anything into a shell.

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
[releases](https://github.com/realvinn/stoke/releases). there's a `.zip` up there
too — that one is only how a mac installs its own updates, not something you
need to download.

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

press the phone button in the title bar, then **open on phone**. you get a code
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

your desktop has to be awake and running stoke — nothing is hosted anywhere.
add the page to your home screen and it opens like an app.

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

mac is real now — it gets built, launched and used, and ci builds it on every
tag. these bits of it still haven't been proven:

- the window chrome. every screenshot so far was taken from inside the page, so
  the title bar and the gap the traffic lights sit in have never actually been
  looked at
- finding `claude` when stoke is opened from the finder or the dock. that case
  asks your login shell where its PATH is, and every launch so far already had
  one handed to it by the terminal that started it
- the ⌘ shortcuts. the buttons behind them have been clicked plenty of times;
  the keystrokes themselves have never been pressed
- reading your plan limits off your account. on mac that token lives in the
  login keychain and stoke only looks in `~/.claude/.credentials.json`, so the
  call fails — the meter still fills in, because it reads the same numbers out
  of the running session instead
- updating itself. the ci build is ad-hoc signed and macos won't swap an ad-hoc
  build for a downloaded one, so the download button stays greyed out and sends
  you to the releases page until there's a developer id to sign with

the windows half of the one-liner is in the same position, only more so:
`install/install.ps1` has never been run, and has never been *parsed* by any
powershell, because there is none on the machine it was written on. the mac and
linux half has been driven end to end against a real release.

one thing worth knowing about installing this way rather than downloading the
dmg: `curl` attaches no quarantine attribute, so the app gets past the gatekeeper
prompt a browser download would have shown you. the build is signed but not
notarized by apple, and the windows installer isn't signed at all. that's
convenient and it's exactly why the script is worth reading first.

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
