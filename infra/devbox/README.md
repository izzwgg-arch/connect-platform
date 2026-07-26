# Dev/debug sandbox

A throwaway Linux container with SSH, for poking at connectivity, DNS, and the
other services on the Docker network while debugging. It is **not** part of the
running platform — the app and SBC stacks never start it — and it only comes up
when you explicitly bring it up.

## Security posture

- **Localhost-only.** The host port is bound to `127.0.0.1` (see
  `docker-compose.devbox.yml`), so SSH is reachable only from the host itself or
  through an SSH tunnel, never from an external interface.
- **Key-based auth only.** No passwords, no root login. The container refuses to
  start if no public key is supplied, so it never comes up unreachable or with a
  weak default.
- **Container port 22, host port 2222.** The container listens on `22`; the host
  publishes `127.0.0.1:2222 -> 22` so it never collides with the host's own
  sshd.

## Usage

```sh
# 1. Provide your SSH public key.
export DEVBOX_AUTHORIZED_KEY="$(cat ~/.ssh/id_ed25519.pub)"

# 2. Build and start.
docker compose -f docker-compose.devbox.yml up -d --build

# 3. Connect (from the host or over a tunnel).
ssh -p 2222 devbox@127.0.0.1

# 4. Tear down when finished.
docker compose -f docker-compose.devbox.yml down
```

Instead of the env var you can mount a keys file — uncomment the `volumes`
block in `docker-compose.devbox.yml` and drop your keys in
`infra/devbox/authorized_keys`.

To reach the running app services by name (e.g. `curl http://api:PORT/...`),
uncomment the `app_net` network in both the service and the top-level
`networks:` block. That maps to the app stack's external `infra_default`
network, so the app stack must be running.

## What's inside

`debian:bookworm-slim` plus the usual debug tools: `curl`, `wget`, `dig`/`nslookup`,
`ping`, `nc`, `tcpdump`, `socat`, `traceroute`, `jq`, `vim-tiny`, `less`. You log
in as the unprivileged `devbox` user (no sudo — rebuild the image if you need
more tools).

## Changing the host port

Set `DEVBOX_SSH_BIND` before starting, keeping the `127.0.0.1:` prefix so it
stays localhost-only:

```sh
DEVBOX_SSH_BIND=127.0.0.1:2200 docker compose -f docker-compose.devbox.yml up -d
```
