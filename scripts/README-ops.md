# Ops Workflows (Server)

These workflows reduce server load by avoiding full rebuilds unless needed.

## Incremental Build

Run changed-package builds only:

```bash
pnpm build:changed
```

Optional override when you already know what changed:

```bash
CHANGED_PKGS="api,portal" pnpm build:changed
```

Notes:
- Uses `/opt/connectcomms/ops/run-heavy.sh` for single-flight + lower priority execution.
- Default detection compares from latest git tag, then falls back to `origin/main`.

## Fast Smoke

Run a lightweight smoke pass without docker image rebuilds:

```bash
pnpm smoke:fast
```

What it does:
- `./scripts/check-migrations.sh`
- local/public health checks
- minimal API route probes

## Force Rebuild in Heavy Smokes

Heavy smoke scripts now avoid rebuild by default.

To force rebuild when needed:

```bash
FORCE_REBUILD=1 ./scripts/smoke-v1.3.9.sh
```

Without `FORCE_REBUILD=1`, compose runs keep existing image layers and avoid `--build`.
