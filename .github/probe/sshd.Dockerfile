# The SSH target of the CI probe (ci.yml `probe`, the Linux leg): a Debian
# bookworm box of the kind Stoke's SSH tabs are for — a VPS reached by key, and
# one that still asks for a password.
#
#   stokekey  key only: its authorized_keys is the runner's client_key.pub,
#             and password logins are refused for it outright
#   stokepw   password only, no key installed: the host that must raise
#             Stoke's add-a-key offer, once, and then take the key the
#             enrollment tab installs (gotchas 75, 109)
#
# tmux is there because a kept host (`persist: 'tmux'`) runs each tab inside
# its own invisible tmux session on the far side (gotcha 126); nothing else is
# installed, so the probe also shows that is all a server needs.
#
#   docker build -t stoke-probe-sshd --build-arg PROBE_PASSWORD=… -f .github/probe/sshd.Dockerfile <dir holding client_key.pub>
#   docker run -d --name stoke-probe-sshd -p 127.0.0.1:2222:22 stoke-probe-sshd
#
# The password is a throwaway for a container that lives for one job and
# listens on the runner's loopback only.
FROM debian:bookworm
ARG PROBE_PASSWORD
RUN test -n "$PROBE_PASSWORD" \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server tmux locales ca-certificates \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd && ssh-keygen -A \
 && useradd -m -s /bin/bash stokekey && usermod -p '*' stokekey \
 && useradd -m -s /bin/bash stokepw && echo "stokepw:${PROBE_PASSWORD}" | chpasswd \
 && install -d -m 700 -o stokekey -g stokekey /home/stokekey/.ssh \
 && printf '%s\n' \
      'PasswordAuthentication yes' \
      'KbdInteractiveAuthentication no' \
      'Match User stokekey' \
      '  PasswordAuthentication no' \
      > /etc/ssh/sshd_config.d/probe.conf
ENV LANG=en_US.UTF-8
COPY --chown=stokekey:stokekey --chmod=600 client_key.pub /home/stokekey/.ssh/authorized_keys
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
