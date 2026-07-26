#!/bin/sh
# Entrypoint for the dev/debug sandbox.
#
# Installs the operator's public key for the `devbox` user, then hands off to
# sshd in the foreground. Login is key-only — if no key is provided the box
# refuses to start rather than come up unreachable (or, worse, insecure).
set -eu

AUTH_DIR="/home/devbox/.ssh"
AUTH_KEYS="${AUTH_DIR}/authorized_keys"

install_key() {
    mkdir -p "${AUTH_DIR}"
    : > "${AUTH_KEYS}"

    # Key material can arrive two ways:
    #   1. DEVBOX_AUTHORIZED_KEY env var (a single public key string), or
    #   2. a file mounted at /authorized_keys (one or more keys).
    if [ -n "${DEVBOX_AUTHORIZED_KEY:-}" ]; then
        printf '%s\n' "${DEVBOX_AUTHORIZED_KEY}" >> "${AUTH_KEYS}"
    fi
    if [ -f /authorized_keys ]; then
        cat /authorized_keys >> "${AUTH_KEYS}"
    fi

    if [ ! -s "${AUTH_KEYS}" ]; then
        echo "devbox: no SSH public key provided." >&2
        echo "devbox: set DEVBOX_AUTHORIZED_KEY or mount a file at /authorized_keys." >&2
        echo "devbox: refusing to start an unreachable sandbox." >&2
        exit 1
    fi

    chown -R devbox:devbox "${AUTH_DIR}"
    chmod 700 "${AUTH_DIR}"
    chmod 600 "${AUTH_KEYS}"
}

# Generate host keys on first boot if the image/volume doesn't have them.
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -A
fi

install_key

key_count=$(wc -l < "${AUTH_KEYS}")
echo "devbox: sandbox ready — sshd listening on :22 as user 'devbox' (${key_count} authorized key(s))."

# -D: run in the foreground so Docker owns the process.
# -e: log to stderr so `docker logs` shows auth attempts.
exec /usr/sbin/sshd -D -e
