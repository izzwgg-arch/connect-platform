# MOH per-call-source — DB/API-layer validation runbook

> **Scope:** staging/local only. This validates the **database + shared-logic
> layer** that the `/voice/moh/*` API endpoints wrap. It does **not** stand up
> the Fastify/Redis/auth stack, and it proves **nothing** about live PBX
> behavior — no `CHANNEL(musicclass)`, no `MOH_SRC`, no AstDB, no call routing.
> Live-call validation still requires a real staging PBX or an approved
> production maintenance window.

Harness: [`scripts/validation/moh_db_validation.ts`](../../scripts/validation/moh_db_validation.ts)

## What it checks

- **source-policy CRUD** — tenant + extension scope, in-place upsert (no dup
  row), list, unique-constraint enforcement, delete.
- **tenant isolation** — unknown `tenantId` rejected by FK; no cross-tenant leak.
- **global-default CRUD** — singleton `id="global"` set / update-in-place / clear.
- **schedule targeting fields** — `scope` / `extension` / `callSource`; legacy
  rows default to tenant-wide / all-sources.
- **hidden-source behavior** — `mobile_app` / `parked` are valid DB tokens,
  legacy policies persist (never auto-deleted), and the portal UI constant
  `UNSUPPORTED_MOH_SOURCES` hides them.
- **diagnostics / resolution priority** — `schedule_extension → extension_source
  → extension_default → tenant_source → tenant_default → global_default →
  pbx_default`; whitespace treated as unset; `pbx_default` ⇒ `class=null`.
- **rollback** — AstDB tombstone builder clears only newly-added keys;
  disabled sources emit no key (fail-closed).
- **cascade** — deleting a tenant cascades its source policies.

## Safety gates (the harness refuses to run otherwise)

1. `ALLOW_MOH_DB_VALIDATION=1` must be set.
2. `DATABASE_URL` host must be `localhost` / `127.0.0.1` / `::1` /
   `host.docker.internal` (or an explicit host in `MOH_VALIDATION_ALLOWED_HOST`).
3. `DATABASE_URL` database name must clearly look non-production (contains
   `stage` or `test`, e.g. `connect_stage`, `moh_stage`). The production name
   `connectcomms` is hard-blocked.

## How to run (throwaway Docker Postgres)

```bash
# 1) Start a throwaway Postgres (non-standard port to avoid clashing with a real one)
docker run -d --name moh_stage_pg \
  -e POSTGRES_PASSWORD=stage -e POSTGRES_USER=stage -e POSTGRES_DB=connect_stage \
  -p 55433:5432 postgres:16

# 2) Materialize the current Prisma schema onto the throwaway DB (from packages/db)
export DATABASE_URL="postgresql://stage:stage@localhost:55433/connect_stage"
npx prisma generate
npx prisma db push --skip-generate --accept-data-loss

# 3) Run the harness (from the repo root)
export ALLOW_MOH_DB_VALIDATION=1
export DATABASE_URL="postgresql://stage:stage@localhost:55433/connect_stage"
npx tsx scripts/validation/moh_db_validation.ts

# 4) Tear down
docker rm -f moh_stage_pg
```

PowerShell equivalents use `$env:NAME="value"` instead of `export NAME=value`.

## Optionally validate the migration + rollback SQL directly

```bash
# Rollback (drops MOH tables/columns), then forward (recreates them):
Get-Content packages/db/prisma/migrations/20260630120000_moh_call_source_policies/ROLLBACK.sql -Raw \
  | docker exec -i moh_stage_pg psql -U stage -d connect_stage -v ON_ERROR_STOP=1
Get-Content packages/db/prisma/migrations/20260630120000_moh_call_source_policies/migration.sql -Raw \
  | docker exec -i moh_stage_pg psql -U stage -d connect_stage -v ON_ERROR_STOP=1

# Confirm zero drift vs schema.prisma (exit 0 = no difference):
npx prisma migrate diff --from-schema-datamodel packages/db/prisma/schema.prisma \
  --to-url "$DATABASE_URL" --exit-code
```

## Expected result

`==== RESULT: 29 passed, 0 failed ====`

## Not covered / still blocked

- Live PBX behavior (`CHANNEL(musicclass)`, `MOH_SRC`, AstDB, real calls).
- HTTP/auth layer of the API (route wiring, RBAC) — only the underlying Prisma
  ops + shared logic are exercised here.
