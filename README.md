# stoke

a desktop app for claude code. one window instead of a pile of terminals.

it runs the real `claude` command underneath, so skills, mcp, plugins and slash
commands all work exactly like they do in a terminal.

windows and mac.

## what you get

- all your projects in a sidebar, and old chats you can pick back up
- several sessions open at once, as tabs
- a browser built in that claude can read and click
- how full the context window is, on every tab
- how much of your 5-hour and weekly limit is gone, and whether you're burning
  it faster than the clock is ticking
- your phone can drive it. hold the mic button to talk instead of typing

## run it

you need [node](https://nodejs.org) and [claude code](https://claude.com/product/claude-code) first.

```bash
git clone git@github-personal:realvinn/stoke.git
cd stoke
npm install
npm run dev
```

## build an installer

```bash
npm run dist:win     # windows -> release/Stoke-0.3.0-x64-setup.exe
npm run dist:mac     # mac (m1) -> release/Stoke-0.3.0-arm64.dmg
```

a mac app can only be built on a mac. windows can't make one.

or just download the windows one from
[releases](https://github.com/realvinn/stoke/releases).

## phone access

settings -> remote. you get a link and a qr code.

that link is a password. anyone with it can run commands on your machine, so
don't paste it anywhere. **new key** in settings kills the old one.

your desktop has to be awake and running stoke — nothing is hosted anywhere.

to reach it from outside your house, put a cloudflare tunnel in front of it and
turn on cloudflare access. `BUILDING.md` has the steps.

## heads up

mac has never actually been run. it builds from the same code, but nothing on
that side has been tested.

## checks

```bash
npm run typecheck
npm run verify:usage      # the limit numbers
npm run verify:security   # the phone server
npm run verify:context    # the context meter
```
