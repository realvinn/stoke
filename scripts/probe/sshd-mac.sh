#!/bin/sh
# The macOS probe leg's SSH target (ci.yml `probe`, `matrix.ssh` on macOS): the
# runner's own /usr/sbin/sshd on 127.0.0.1:2222 with a config of its own, and
# two throwaway local accounts — the same pair the Linux leg's Debian container
# has (.github/probe/sshd.Dockerfile):
#
#   stokekey  key only, its key in a root-owned file sshd reads (probe_keys)
#   stokepw   password only, until the probe's enrollment installs a key in
#             its own ~/.ssh/authorized_keys. Keyboard-interactive is on beside
#             password, as Apple's sshd may take a password only through PAM —
#             so the prompt may be ssh's `(user@host) Password:` form, which
#             sshAuth.ts reads as well as `user@host's password:`
#
# macOS runners have no Docker (no nested virtualisation), so this is the only
# way the Mac's ssh CLIENT — the one a Mac user's SSH tabs run — meets a real
# sshd in CI. tmux comes from Homebrew, and sshd's SetEnv puts it on the PATH a
# remote command gets, since a kept host runs its tab inside tmux (gotcha 126).
#
# ssh reads the passwd home's ~/.ssh, never $HOME, so the Host entries go in the
# RUNNER's real ~/.ssh/config — which is why this only ever runs on a runner.
#
#   STOKE_PROBE_SSH_PASSWORD=… sh scripts/probe/sshd-mac.sh <dir>
set -eu
D=${1:?usage: sh scripts/probe/sshd-mac.sh <dir>}
PW=${STOKE_PROBE_SSH_PASSWORD:?STOKE_PROBE_SSH_PASSWORD is not set}
[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'sshd-mac.sh adds accounts and edits ~/.ssh: CI runners only' >&2; exit 2; }
mkdir -p "$D"

command -v tmux >/dev/null 2>&1 || HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install tmux
TMUX_BIN=$(dirname "$(command -v tmux)")
echo "tmux: $(command -v tmux) ($(tmux -V))"

ssh-keygen -q -t ed25519 -N '' -f "$D/client_key"
sudo ssh-keygen -q -t ed25519 -N '' -f "$D/host_ed25519"

for u in stokekey stokepw; do
  sudo sysadminctl -addUser "$u" -fullName "$u" -shell /bin/bash -home "/Users/$u" -password "$PW" 2>&1 | grep -v '^$' || true
  sudo createhomedir -c -u "$u" >/dev/null 2>&1 || true
  # Only matters where the Remote Login SACL exists; harmless where it does not.
  sudo dseditgroup -o edit -a "$u" -t user com.apple.access_ssh 2>/dev/null || true
done
id stokekey
id stokepw

sudo mkdir -p /etc/ssh/probe_keys
sudo install -m 644 "$D/client_key.pub" /etc/ssh/probe_keys/stokekey

cat >"$D/sshd_config" <<EOF
Port 2222
ListenAddress 127.0.0.1
HostKey $D/host_ed25519
PidFile $D/sshd.pid
AuthorizedKeysFile /etc/ssh/probe_keys/%u .ssh/authorized_keys
UsePAM yes
PasswordAuthentication yes
KbdInteractiveAuthentication yes
AllowUsers stokekey stokepw
SetEnv PATH=$TMUX_BIN:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8
Match User stokekey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
EOF
sudo /usr/sbin/sshd -t -f "$D/sshd_config"
sudo /usr/sbin/sshd -f "$D/sshd_config" -E "$D/sshd.log"

mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat >>~/.ssh/config <<EOF
Host stoke-key
  HostName 127.0.0.1
  Port 2222
  User stokekey
  IdentityFile $D/client_key
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $D/known_hosts
Host stoke-pw
  HostName 127.0.0.1
  Port 2222
  User stokepw
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $D/known_hosts
EOF
chmod 600 ~/.ssh/config

i=0
until ssh -o BatchMode=yes -o ConnectTimeout=5 stoke-key true 2>/dev/null; do
  i=$((i + 1))
  if [ $i -ge 40 ]; then
    echo 'the key user never got in; sshd said:' >&2
    sudo tail -n 40 "$D/sshd.log" >&2 || true
    exit 1
  fi
  sleep 0.5
done
ssh -o BatchMode=yes stoke-key 'echo key login ok; tmux -V'
if ssh -o BatchMode=yes -o ConnectTimeout=5 stoke-pw true 2>/dev/null; then
  echo 'stoke-pw let a key in before any enrollment' >&2
  exit 1
fi
echo 'stoke-pw refuses BatchMode, as it should'
