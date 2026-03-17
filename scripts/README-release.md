# Release Tooling

Safe tagged release deployment/rollback scripts.

## Git deploy key

The server uses a **read-only deploy key** for `git fetch`/`git pull` from GitHub:

- **Fingerprint:** `SHA256:2lz0/oLGArI7/PVzm4foQzt390aqckA2QNZnWlBV/Xo`
- **Usage:** Add the matching public key to this repo as a **Deploy key** (Settings → Deploy keys). On the server, ensure `git` uses that key for `github.com` (e.g. `~/.ssh/config` or `GIT_SSH_COMMAND`).

Verify on the server: `ssh -T git@github.com` and confirm the fingerprint when prompted. To force git to use the deploy key on the server, add to `~/.ssh/config`:

```
Host github.com
  HostName github.com
  User git
  IdentityFile /path/to/deploy_key
  IdentitiesOnly yes
```

## Status

```bash
bash scripts/release/status.sh
```

Shows current git/tag, container image metadata, health checks, and migration status.

## Deploy a Tag

```bash
bash scripts/release/deploy-tag.sh v1.4.7
```

Behavior:
- enforces single-flight with `/opt/connectcomms/ops/run-heavy.sh`
- validates clean working tree and tag existence
- checks out requested tag (detached HEAD when needed)
- runs install only when `pnpm-lock.yaml` changed
- runs prisma migrate deploy + `scripts/check-migrations.sh`
- restarts app services and runs `pnpm smoke:fast`

## Rollback

```bash
bash scripts/release/rollback.sh
```

Finds previous tag and delegates to `deploy-tag.sh`.

## Force Rebuild

By default, deploy restarts services without image rebuilds.
To force image rebuild during deploy:

```bash
FORCE_REBUILD=1 bash scripts/release/deploy-tag.sh v1.4.7
```
