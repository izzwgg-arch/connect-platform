# Dev/debug sandbox image.
#
# A throwaway Linux box you can SSH into to poke at connectivity, DNS, and the
# other services on the Docker network. It is NOT part of the running app and is
# never started by the main compose stacks — bring it up explicitly via
# docker-compose.devbox.yml.
#
# Security posture: key-based auth only, no root login, no password auth. The
# host port is bound to 127.0.0.1 in the compose file, so it is reachable only
# from the host (or an SSH tunnel) and never from an external interface.
FROM debian:bookworm-slim

# openssh-server plus the handful of tools you actually reach for when debugging
# telephony/network issues from inside the Docker network.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-server \
        ca-certificates \
        curl \
        wget \
        iputils-ping \
        dnsutils \
        netcat-openbsd \
        tcpdump \
        socat \
        traceroute \
        jq \
        less \
        vim-tiny \
        procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd

# Unprivileged user you actually log in as. No password is ever set; login is
# key-only (see entrypoint) and sudo is intentionally not installed.
RUN useradd --create-home --shell /bin/bash devbox

# Harden sshd: no root login, no passwords, key auth only.
RUN sed -i \
        -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
        -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
        -e 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' \
        -e 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' \
        -e 's/^#\?UsePAM.*/UsePAM no/' \
        /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/bin/devbox-entrypoint.sh
RUN chmod +x /usr/local/bin/devbox-entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/devbox-entrypoint.sh"]
