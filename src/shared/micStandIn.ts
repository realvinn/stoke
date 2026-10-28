/*
 * The `arecord` Stoke installs on an SSH host as `~/.local/bin/arecord`, so
 * Claude Code's `/voice` there records THIS computer's microphone through the
 * tab's forwarded socket (shared/micTunnel.ts says why each piece exists).
 *
 * POSIX sh: it runs under dash on Debian and Ubuntu, often as root, and under
 * whatever `/bin/sh` is anywhere else. Built from an array of lines, never a
 * template literal, because the shell's own `${…}` would be read as one.
 * verify:mic-tunnel runs this exact text under /bin/sh and dash against a real
 * Unix socket.
 *
 * What it does, by its arguments:
 *
 *  - `--version`: one line, exit 0 (Claude Code's availability check).
 *  - The probe (format arguments and `/dev/null`): exit 0 when a Stoke socket
 *    is there; else the real `arecord` if there is one, so a Linux desktop's
 *    own recorder answers for itself; else exit 0 anyway. The probe is
 *    memoised for the life of a `claude` process, and a `claude` started
 *    inside byobu before Stoke connected must still be able to use the socket
 *    a later connection brings.
 *  - Recording (`-f S16_LE -r 16000 -c 1 -t raw [-q] [-]`, exactly what
 *    Claude Code asks for, since the tunnel only ever carries that): try each
 *    `/tmp/stoke-mic.<32 hex>.sock`, newest first, that is a socket (-S), not
 *    a link, and OWNED by this user (-O) — REQUIRED: another local user who
 *    planted a socket there could otherwise feed this `claude` dictated
 *    prompts. Send the token (the random part of the name) and copy what
 *    comes back to stdout until EOF or SIGTERM (the connector is `exec`ed, so
 *    Claude's SIGTERM reaches it, and its socket closes with it). A socket
 *    that closes before any audio (stale, or Stoke refused) is skipped for the
 *    next. With none answering: the real `arecord` if there is one, else one
 *    line on stderr and exit 1.
 *  - Stale sockets: sshd never unlinks a forwarded socket, so one file is
 *    left per connection. A socket the connector finds REFUSING (ECONNREFUSED:
 *    nobody listens) is removed only when all of these hold, checked again
 *    after a second refused try: its path is exactly `/tmp/stoke-mic.<32
 *    hex>.sock`, it is a socket and not a link, it is owned by this user, and
 *    it is over 60 s old (a forward being set up now is younger). Nothing else
 *    is ever removed, and a socket that answers is never touched.
 *  - Any other arguments: the real `arecord`, or a refusal. It never writes a
 *    format nobody asked for.
 *
 * The connector is python3, else perl (perl-base is Essential on Debian, so
 * one of the two is nearly always there). `nc -U` is not used: its variants
 * disagree on half-close and on whether they exit at EOF.
 */

const PYTHON = [
  'import errno, os, socket, stat, sys, time',
  'real = sys.argv[1]; n = int(sys.argv[2]); orig = sys.argv[3:3 + n]; socks = sys.argv[3 + n:]',
  'uid = os.geteuid()',
  'PREFIX = "/tmp/stoke-mic."',
  // sshd never unlinks a forwarded socket (gotcha 165), so one is left behind per connection.
  'def gone(path):',
  '    if not path.startswith(PREFIX) or not path.endswith(".sock"):',
  '        return',
  '    tok = path[len(PREFIX):-len(".sock")]',
  '    if len(tok) != 32 or tok.strip("0123456789abcdef"):',
  '        return',
  '    def stale():',
  '        try:',
  '            st = os.lstat(path)',
  '        except OSError:',
  '            return False',
  '        return stat.S_ISSOCK(st.st_mode) and st.st_uid == uid and time.time() - st.st_mtime > 60',
  '    if not stale():',
  '        return',
  '    time.sleep(0.1)',
  '    t = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
  '    try:',
  '        t.connect(path)',
  '        t.close()',
  '        return',
  '    except OSError as e:',
  '        t.close()',
  '        if e.errno != errno.ECONNREFUSED:',
  '            return',
  '    if stale():',
  '        try:',
  '            os.unlink(path)',
  '        except OSError:',
  '            pass',
  'for path in socks:',
  '    try:',
  '        st = os.lstat(path)',
  '    except OSError:',
  '        continue',
  '    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != uid:',
  '        continue',
  '    base = os.path.basename(path)',
  '    token = base[len("stoke-mic."):-len(".sock")]',
  '    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
  '    try:',
  '        s.connect(path)',
  '    except OSError as e:',
  '        s.close()',
  '        if e.errno == errno.ECONNREFUSED:',
  '            gone(path)',
  '        continue',
  '    try:',
  '        s.sendall((token + "\\n").encode("ascii"))',
  '    except OSError:',
  '        s.close()',
  '        continue',
  '    got = 0',
  '    while True:',
  '        try:',
  '            b = s.recv(65536)',
  '        except OSError:',
  '            break',
  '        if not b:',
  '            break',
  '        got += len(b)',
  '        mv = memoryview(b)',
  '        while mv:',
  '            try:',
  '                w = os.write(1, mv)',
  '            except OSError:',
  '                sys.exit(0)',
  '            mv = mv[w:]',
  '    s.close()',
  '    if got:',
  '        sys.exit(0)',
  'if real:',
  '    os.execv(real, [real] + orig)',
  'sys.stderr.write("arecord (Stoke stand-in): no Stoke microphone answered. Open this machine in Stoke with Lend this computer\\u2019s microphone on, and hold or tap Space in that tab.\\n")',
  'sys.exit(1)'
].join('\n')

const PERL = [
  'use strict; use Socket; use Errno;',
  'my ($real, $n, @rest) = @ARGV; my @orig = splice(@rest, 0, $n); my $uid = $>;',
  'my $PREFIX = "/tmp/stoke-mic.";',
  // The same rule as the python connector's `gone`.
  'sub gone {',
  '  my ($p) = @_;',
  '  return unless index($p, $PREFIX) == 0 && substr($p, length $PREFIX) =~ /^[0-9a-f]{32}\\.sock$/;',
  '  my $stale = sub { my @st = lstat($p) or return 0; my $old = -S _ && $st[4] == $uid && time - $st[9] > 60; return $old ? 1 : 0 };',
  '  return unless $stale->();',
  '  select(undef, undef, undef, 0.1);',
  '  socket(my $t, PF_UNIX, SOCK_STREAM, 0) or return;',
  '  if (connect($t, pack_sockaddr_un($p))) { close $t; return }',
  '  my $refused = $!{ECONNREFUSED}; close $t;',
  '  unlink $p if $refused && $stale->();',
  '}',
  'for my $path (@rest) {',
  '  my @st = lstat($path) or next;',
  '  next unless -S _ && $st[4] == $uid;',
  '  my ($tok) = $path =~ m{/stoke-mic\\.([0-9a-f]{32})\\.sock$} or next;',
  '  socket(my $s, PF_UNIX, SOCK_STREAM, 0) or next;',
  '  connect($s, pack_sockaddr_un($path)) or do { my $refused = $!{ECONNREFUSED}; close $s; gone($path) if $refused; next };',
  '  syswrite($s, "$tok\\n");',
  '  my $got = 0;',
  '  while (1) {',
  '    my $r = sysread($s, my $buf, 65536);',
  '    last unless $r;',
  '    $got += $r; my $off = 0;',
  '    while ($off < $r) { my $w = syswrite(STDOUT, $buf, $r - $off, $off); exit 0 unless defined $w; $off += $w }',
  '  }',
  '  close $s; exit 0 if $got;',
  '}',
  'if ($real ne "") { exec { $real } $real, @orig; }',
  // The apostrophe as its UTF-8 bytes: a `\x{2019}` is a wide character, and perl prints "Wide character in print" before it.
  'print STDERR "arecord (Stoke stand-in): no Stoke microphone answered. Open this machine in Stoke with Lend this computer\\xe2\\x80\\x99s microphone on, and hold or tap Space in that tab.\\n";',
  'exit 1;'
].join('\n')

/** The stand-in's version line and marker; the installer and the fallback look for the marker. */
export const MIC_STAND_IN_MARKER = 'STOKE_MIC_STANDIN'
export const MIC_STAND_IN_VERSION = '1'

export const MIC_STAND_IN: string = [
  '#!/bin/sh',
  `# ${MIC_STAND_IN_MARKER} ${MIC_STAND_IN_VERSION}`,
  '# Installed by Stoke (https://stoke.vinn.dev): an arecord that records the microphone of the',
  '# computer this machine was opened from in Stoke, through that SSH connection, for Claude',
  '# Code\'s /voice. Remove this file to stop. Any other use goes to the real arecord, if any.',
  '',
  /*
   * Every hand-over to a real arecord is an `exec`. If that arecord is a
   * wrapper that runs `arecord` by name, PATH finds this file again, and
   * without this the same process loops for ever at full CPU. Nothing else
   * this script starts ever runs arecord, so being reached with the mark set
   * means exactly that loop.
   */
  'if [ -n "${STOKE_MIC_HANDED_OVER-}" ]; then',
  '  echo "arecord (Stoke stand-in): reached again through the arecord it handed over to, which runs arecord by name. Stopping rather than looping." >&2',
  '  exit 1',
  'fi',
  'STOKE_MIC_HANDED_OVER=1; export STOKE_MIC_HANDED_OVER',
  '',
  'real_arecord=',
  'find_real() {',
  '  old_ifs=$IFS; IFS=:; set -f',
  '  for d in ${PATH-}; do',
  '    [ -n "$d" ] || continue',
  '    c=$d/arecord',
  '    [ -f "$c" ] && [ -x "$c" ] || continue',
  `    grep -q ${MIC_STAND_IN_MARKER} "$c" 2>/dev/null && continue`,
  '    real_arecord=$c',
  '    break',
  '  done',
  '  IFS=$old_ifs; set +f',
  '}',
  '',
  'candidates=',
  'find_sockets() {',
  '  files=$(ls -t /tmp/stoke-mic.*.sock 2>/dev/null)',
  '  set -f',
  '  for s in $files; do',
  '    case $s in /tmp/stoke-mic.*.sock) ;; *) continue ;; esac',
  '    t=${s#/tmp/stoke-mic.}; t=${t%.sock}',
  '    case $t in *[!0-9a-f]*|"") continue ;; esac',
  '    [ ${#t} -eq 32 ] || continue',
  '    [ -S "$s" ] && [ ! -L "$s" ] && [ -O "$s" ] || continue',
  '    candidates="$candidates $s"',
  '  done',
  '  set +f',
  '}',
  '',
  'fmt=; rate=; chans=; ftype=; out=; extra=; prev=',
  'for a in "$@"; do',
  '  case $prev in',
  '    -f) fmt=$a; prev=; continue ;;',
  '    -r) rate=$a; prev=; continue ;;',
  '    -c) chans=$a; prev=; continue ;;',
  '    -t) ftype=$a; prev=; continue ;;',
  '  esac',
  '  case $a in',
  `    --version) echo "arecord: Stoke microphone stand-in ${MIC_STAND_IN_VERSION} (records the microphone Stoke lends over SSH)"; exit 0 ;;`,
  '    -f|-r|-c|-t) prev=$a ;;',
  '    --format=*) fmt=${a#*=} ;;',
  '    --rate=*) rate=${a#*=} ;;',
  '    --channels=*) chans=${a#*=} ;;',
  '    --file-type=*) ftype=${a#*=} ;;',
  '    -q|--quiet) ;;',
  '    -) out=- ;;',
  '    -*) extra=$a ;;',
  '    *) if [ -z "$out" ]; then out=$a; else extra=$a; fi ;;',
  '  esac',
  'done',
  '',
  'ours=no',
  '[ "$fmt" = S16_LE ] && [ "$rate" = 16000 ] && [ "$chans" = 1 ] && [ "$ftype" = raw ] && [ -z "$extra" ] && [ -z "$prev" ] && ours=yes',
  'find_real',
  '',
  'if [ "$ours" = yes ] && [ "$out" = /dev/null ]; then',
  '  find_sockets',
  '  [ -n "$candidates" ] && exit 0',
  '  [ -n "$real_arecord" ] && exec "$real_arecord" "$@"',
  '  exit 0',
  'fi',
  '',
  'if [ "$ours" = yes ] && { [ -z "$out" ] || [ "$out" = - ]; }; then',
  '  find_sockets',
  '  if [ -n "$candidates" ]; then',
  '    if command -v python3 >/dev/null 2>&1; then',
  `      exec python3 -c '${PYTHON}' "$real_arecord" "$#" "$@" $candidates`,
  '    fi',
  '    if command -v perl >/dev/null 2>&1; then',
  `      exec perl -e '${PERL}' "$real_arecord" "$#" "$@" $candidates`,
  '    fi',
  '    echo "arecord (Stoke stand-in): needs python3 or perl to reach Stoke." >&2',
  '  fi',
  '  [ -n "$real_arecord" ] && exec "$real_arecord" "$@"',
  '  echo "arecord (Stoke stand-in): no Stoke microphone is connected. Open this machine in Stoke with \\"Lend this computer\'s microphone\\" on." >&2',
  '  exit 1',
  'fi',
  '',
  '[ -n "$real_arecord" ] && exec "$real_arecord" "$@"',
  'echo "arecord (Stoke stand-in): only records what Claude Code asks for (-f S16_LE -r 16000 -c 1 -t raw to stdout), and there is no other arecord here." >&2',
  'exit 1',
  ''
].join('\n')
