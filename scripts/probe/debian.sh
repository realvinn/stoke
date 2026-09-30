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

# Every LIVE process of an installed Stoke: the AppImage runtime, a FUSE
# mount's daemon, the app from its mount (/tmp/.mount_*) or its extraction
# (/tmp/appimage_extracted_*), and Chromium's helpers. A zombie is not one:
# the FUSE daemon exits once the app does, is reparented to the container's
# PID 1 — which is not an init and never reaps — and stays `<defunct>` (seen on
# the first FUSE run), holding nothing.
stoke_procs() { ps -eo pid=,ppid=,stat=,args= | awk '$3 !~ /^Z/' | grep -E 'stoke\.AppImage|\.mount_stoke|appimage_extracted' | grep -v -e grep -e 'ps -eo' ; }
# The browser process: carries --no-sandbox, is not a helper (--type=), and is
# not the AppImage runtime itself (its command line starts with the .AppImage).
browser_pid() { stoke_procs | awk '/--no-sandbox/ && !/--type=/ { if ($4 !~ /stoke\.AppImage$/) { print $1; exit } }'; }

# Start the installed command as root and judge it: $1 a file-safe slug, $2 the
# label, then the command. The launcher returns within a second (it detaches
# Stoke); a route that runs Stoke in the foreground is still running after 10 s,
# which counts as started. Output: $W/launcher-<slug>.{out,err}.
start_and_judge() {
  slug=$1
  label=$2
  shift 2
  "$@" >"$W/launcher-$slug.out" 2>"$W/launcher-$slug.err" &
  cmd_pid=$!
  n=0
  while kill -0 "$cmd_pid" 2>/dev/null && [ $n -lt 50 ]; do sleep 0.2; n=$((n + 1)); done
  if kill -0 "$cmd_pid" 2>/dev/null; then
    launch_status=0
  else
    wait "$cmd_pid"
    launch_status=$?
  fi
  sleep 8
  pid=$(browser_pid)
  stoke_procs >"$W/procs-$slug.txt"
  if [ "$launch_status" = 0 ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    pass "$label: started and is still up 10 s later (pid $pid)"
    if tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q -- '--no-sandbox'; then pass "$label: with --no-sandbox on its command line"; else fail "$label: without --no-sandbox — it could not have started as root"; fi
    kill -TERM "$pid" 2>/dev/null
    n=0
    while [ -n "$(stoke_procs)" ] && [ $n -lt 150 ]; do sleep 0.2; n=$((n + 1)); done
    if [ -n "$(stoke_procs)" ]; then
      fail "$label: SIGTERM to the app left Stoke processes behind after 30 s"
      note "$(stoke_procs | cut -c1-200 | tr '\n' '|')"
      note "(tree when started: $(cut -c1-160 "$W/procs-$slug.txt" | tr '\n' '|'))"
      stoke_procs | awk '{print $1}' | while read -r p; do kill -TERM "$p" 2>/dev/null; done
    else
      pass "$label: and every Stoke process went on SIGTERM to the app"
    fi
    return 0
  fi
  return 1
}

if start_and_judge stoke 'stoke' "$bin"; then
  :
elif [ "$mode" = nofuse ] && [ "$launch_status" != 0 ] && grep -qi -e fuse -e mount "$W/launcher-stoke.err"; then
  pass "with no FUSE it did not start, and said why (exit $launch_status): $(grep -i -m1 -e fuse -e mount "$W/launcher-stoke.err")"
else
  fail "stoke did not stay up (launcher exit $launch_status, pid '${pid:-none}')"
  note "stderr: $(head -c 1500 "$W/launcher-stoke.err" | tr '\n' ' ')"
  note "processes: $(cut -c1-160 "$W/procs-stoke.txt" | tr '\n' '|')"
fi

if [ "$mode" = nofuse ]; then
  # With no FUSE, what install.sh tells the user to do instead has to work too,
  # as root. Both routes go through the launcher, so both must still get
  # --no-sandbox (gotcha 76).
  echo
  echo "the installer's own no-FUSE remedies, as root"
  note "install.sh says: $(grep -A1 'refuses to start with a FUSE error' "$W/install.log" | tr '\n' ' ' | sed 's/  */ /g')"
  # AppRun adds --no-sandbox by itself when `unshare -Ur true` fails, which it
  # does inside Docker but NOT as root on a real host (gotcha 76) — so here a
  # --no-sandbox on the command line may be AppRun's, not the launcher's.
  # verify:install holds the launcher's own root branch for that reason.
  if unshare -Ur true 2>/dev/null; then
    note 'unshare -Ur true succeeds here, as on a real root host: any --no-sandbox below is the launcher'"'"'s'
  else
    note 'unshare -Ur true fails in this container, so AppRun adds --no-sandbox itself: the checks below cannot tell whose it is'
  fi
  if start_and_judge env-extract 'APPIMAGE_EXTRACT_AND_RUN=1 stoke' env APPIMAGE_EXTRACT_AND_RUN=1 "$bin"; then :; else
    fail "APPIMAGE_EXTRACT_AND_RUN=1 stoke did not stay up (exit $launch_status): $(head -c 600 "$W/launcher-env-extract.err" | tr '\n' ' ')"
  fi
  if start_and_judge arg-extract 'stoke --appimage-extract-and-run' "$bin" --appimage-extract-and-run; then :; else
    fail "stoke --appimage-extract-and-run did not stay up as root (exit $launch_status): $(head -c 600 "$W/launcher-arg-extract.err" | tr '\n' ' ')"
  fi
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
# Quit it the way the probe quits everything: SIGTERM to the APP, never to the
# AppImage runtime around it. With extract-and-run the runtime keeps the app as
# a child, and a TERM to the runtime alone left the app running with PID 1 as
# its parent (the first no-FUSE run) — so the target is the browser process.
main=$(browser_pid)
stoke_procs >"$W/procs-boot.txt"
kill -TERM "${main:-$app_pid}" 2>/dev/null
n=0
while [ -n "$(stoke_procs)" ] && [ $n -lt 150 ]; do sleep 0.2; n=$((n + 1)); done
if [ -n "$(stoke_procs)" ]; then
  fail "SIGTERM to the booted app (pid ${main:-none}) left Stoke processes behind after 30 s"
  note "$(stoke_procs | cut -c1-160 | tr '\n' '|')"
  stoke_procs | awk '{print $1}' | while read -r p; do kill -TERM "$p" 2>/dev/null; done
else
  pass "and it quit on SIGTERM, every process with it (pid ${main:-none})"
fi
kill -TERM "$xvfb_pid" 2>/dev/null

echo
echo "$passes passed, $fails failed"
[ "$fails" = 0 ]
