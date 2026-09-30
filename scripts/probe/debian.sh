#!/bin/sh
# The CI probe's "terminal-only Debian" legs (ci.yml `debian`, legs from
# `node scripts/targets.mjs --debian-matrix`). Runs as ROOT inside a bare
# `debian:bookworm` container, with only what a person needs to paste the
# one-liner (curl, ca-certificates) and what Electron needs to draw at all.
#
#   sh scripts/probe/debian.sh fuse|nofuse <workdir>
#
# What it proves, on the machine it runs on:
#
#   1. THIS branch's install.sh, served locally by scripts/serve-install.mjs
#      (the same route the Worker picks for curl), installs the PUBLISHED
#      linux-x64 AppImage as root, exit 0.
#   2. The launcher it writes adds --no-sandbox for uid 0 (gotcha 76) and
#      answers --help and --version itself.
#   3. `stoke` with no arguments, as root, starts Stoke (the AppImage stays up
#      with --no-sandbox on its command line) — or, with no FUSE, fails with a
#      READABLE reason rather than vanishing.
#   4. The AppImage boots to a renderer whose window.stoke.platform is
#      "linux", over CDP — through FUSE, or through extract-and-run without it.
#
# Every Stoke started here is stopped with SIGTERM, never SIGKILL. The tally
# is the last thing printed and the exit status is its verdict.
set -u

mode=${1:-}
W=${2:-}
if [ "$mode" != fuse ] && [ "$mode" != nofuse ] || [ -z "$W" ]; then
  echo 'usage: sh scripts/probe/debian.sh fuse|nofuse <workdir>' >&2
  exit 2
fi
mkdir -p "$W"
passes=0
fails=0
pass() { passes=$((passes + 1)); echo "  PASS  $*"; }
fail() { fails=$((fails + 1)); echo "  FAIL  $*"; }
note() { echo "        $*"; }

echo "Debian probe ($mode) as uid $(id -u) on $(. /etc/os-release && echo "$PRETTY_NAME"), $(uname -m)"
ls -l /dev/fuse 2>/dev/null | sed 's/^/  \/dev\/fuse: /' || echo '  /dev/fuse: absent'

# --- 1. the one-liner ------------------------------------------------------
echo
echo 'the one-liner, as root'
node scripts/serve-install.mjs 8787 >"$W/serve.log" 2>&1 &
serve_pid=$!
n=0
until grep -q '^listening' "$W/serve.log" 2>/dev/null || [ $n -ge 100 ]; do sleep 0.1; n=$((n + 1)); done
if curl -fsSL http://127.0.0.1:8787 | STOKE_NO_ANIMATION=1 sh >"$W/install.log" 2>&1; then
  pass 'curl -fsSL <installer> | sh exited 0'
else
  fail "curl -fsSL <installer> | sh failed: $(tail -n 5 "$W/install.log" | tr '\n' ' ')"
fi
kill -TERM "$serve_pid" 2>/dev/null
note "$(grep -m1 -- '->' "$W/serve.log" || echo 'served nothing')"

bin=$HOME/.local/bin/stoke
app=$HOME/.local/bin/stoke.AppImage
if [ -x "$bin" ] && [ -x "$app" ]; then pass "the launcher and the AppImage are in $HOME/.local/bin"; else fail "no launcher or AppImage in $HOME/.local/bin"; fi

# --- 2. the launcher ---------------------------------------------------------
echo
echo 'the launcher'
if grep -q -- '--no-sandbox' "$bin" 2>/dev/null && grep -q 'id -u' "$bin" 2>/dev/null; then
  pass 'it adds --no-sandbox for uid 0 (gotcha 76)'
else
  fail 'it has no uid-0 --no-sandbox branch'
fi
if "$bin" --help 2>&1 | grep -q '^Usage: stoke'; then pass 'stoke --help answers itself'; else fail 'stoke --help printed no usage'; fi
ver=$("$bin" --version 2>&1)
case "$ver" in
  'Stoke '[0-9]*) pass "stoke --version: $ver" ;;
  *) fail "stoke --version: $ver" ;;
esac

# --- 3. `stoke`, as root, with nothing else --------------------------------
echo
echo 'starting it through the launcher, as root'
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >"$W/xvfb.log" 2>&1 &
xvfb_pid=$!
export DISPLAY=:99
sleep 1

# The newest process whose command line names the AppImage's mount or file and
# carries --no-sandbox: the browser process, not a helper (helpers are younger).
stoke_main() { pgrep -o -f -- 'stoke.*--no-sandbox' 2>/dev/null | head -n 1; }

"$bin" >"$W/launcher.out" 2>"$W/launcher.err"
launch_status=$?
sleep 10
pid=$(stoke_main)
if [ "$launch_status" = 0 ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  pass "stoke started and is still up 10 s later (pid $pid)"
  if tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q -- '--no-sandbox'; then pass 'with --no-sandbox on its command line'; else fail 'without --no-sandbox — it could not have started as root'; fi
  kill -TERM "$pid" 2>/dev/null
  n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt 150 ]; do sleep 0.2; n=$((n + 1)); done
  if kill -0 "$pid" 2>/dev/null; then fail 'it did not quit on SIGTERM within 30 s'; else pass 'and quit on SIGTERM'; fi
elif [ "$mode" = nofuse ] && [ "$launch_status" != 0 ] && grep -qi -e fuse -e mount "$W/launcher.err"; then
  pass "with no FUSE it did not start, and said why (exit $launch_status): $(grep -i -m1 -e fuse -e mount "$W/launcher.err")"
else
  fail "stoke did not stay up (launcher exit $launch_status, pid '${pid:-none}')"
  note "stderr: $(head -c 1500 "$W/launcher.err" | tr '\n' ' ')"
fi

# --- 4. the renderer, over CDP ---------------------------------------------
echo
if [ "$mode" = fuse ]; then
  echo 'booting the AppImage (FUSE) to a renderer'
else
  echo 'booting the AppImage with APPIMAGE_EXTRACT_AND_RUN=1 (no FUSE) to a renderer'
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
# As root the sandbox has to be off by hand here: this bypasses the launcher.
"$app" --no-sandbox --user-data-dir="$W/ud" --remote-debugging-port=9340 --password-store=basic --disable-backgrounding-occluded-windows >"$W/stoke.log" 2>&1 &
app_pid=$!
platform=''
n=0
while [ $n -lt 90 ]; do
  platform=$(CDP_PORT=9340 node scripts/cdp-eval.mjs 'window.stoke.platform' 2>/dev/null) && [ -n "$platform" ] && break
  platform=''
  kill -0 "$app_pid" 2>/dev/null || break
  sleep 1
  n=$((n + 1))
done
if [ "$platform" = '"linux"' ]; then
  pass "window.stoke.platform is \"linux\" after ${n}s"
  CDP_PORT=9340 node scripts/cdp-eval.mjs --shot "$W/debian-$mode.png" >/dev/null 2>&1 && note "screenshot: $W/debian-$mode.png"
  inert=$(CDP_PORT=9340 node scripts/cdp-eval.mjs '!!document.querySelector(".app > .body-row")' 2>/dev/null)
  note "shell mounted: $inert"
else
  fail "no renderer answered on CDP (got '${platform}')"
  note "$(tail -n 20 "$W/stoke.log" | tr '\n' ' ' | head -c 2000)"
fi
# The browser process: the oldest one carrying our user-data-dir.
main=$(pgrep -o -f -- "--user-data-dir=$W/ud" 2>/dev/null | head -n 1)
for p in $main $app_pid; do kill -TERM "$p" 2>/dev/null; done
n=0
while [ -n "$main" ] && kill -0 "$main" 2>/dev/null && [ $n -lt 150 ]; do sleep 0.2; n=$((n + 1)); done
kill -TERM "$xvfb_pid" 2>/dev/null

echo
echo "$passes passed, $fails failed"
[ "$fails" = 0 ]
