# Release Tooling

Safe tagged release deployment/rollback scripts.

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
