# STORAGE_MAINTENANCE

> Safe storage cleanup controller for Connect production hosts.
> **Phase 1 (current): read-only scanner + classifier + dry-run plan only.**
> No deletes, prunes, restarts, or execution.

Read `SERVER_OPERATIONS.md` for the 2026-06-14 forensic baseline and `AGENTS.md` for forbidden server commands.

---

## Architecture

```
Portal /admin/storage-health
        │
        ▼
API  /admin/storage-health/*
        │
        ├── scanner (read-only: disk, docker, APKs, logs)
        ├── classifier (PROTECTED / ACTIVE / ROLLBACK / SAFE / UNKNOWN)
        ├── planBuilder (dry-run commands, command guard)
        ├── auditLog (in-memory ring buffer)
        └── executor (Phase 2 — currently refuses all execution)
```

### API routes (super-admin JWT)

| Method | Path | Phase 1 behavior |
|--------|------|------------------|
| GET | `/admin/storage-health` | Latest snapshot + trend + alerts |
| POST | `/admin/storage-health/scan` | Run read-only inventory |
| GET | `/admin/storage-health/history` | Scan trend rows |
| GET | `/admin/storage-health/audit` | Audit events |
| POST | `/admin/storage-health/plan` | Generate dry-run cleanup plan |
| GET | `/admin/storage-health/plan` | Latest plan |
| POST | `/admin/storage-health/approve` | **501** — not implemented |
| POST | `/admin/storage-health/execute` | **403** — forbidden Phase 1 |
| GET | `/admin/storage-health/executions` | Empty (Phase 2) |

Permission: `can_view_admin_storage_health` (super-admin via `can_manage_global_settings`).

Future approval: `can_approve_storage_cleanup` (reserved, unused in Phase 1).

---

## Classifications

| Class | Meaning |
|-------|---------|
| `PROTECTED_NEVER_DELETE` | Production data, env, backups policy, protected volumes |
| `ACTIVE_REQUIRED` | Running containers, attached volumes, active images |
| `ROLLBACK_CANDIDATE` | `*_candidate` images — manual policy before removal |
| `SAFE_CANDIDATE` | BuildKit cache, old APKs, trimmable logs (future) |
| `UNKNOWN_REQUIRES_REVIEW` | Blocks automated cleanup until human review |

---

## Hard protection rules (enforced in code)

Never delete / never target in cleanup commands:

- `/opt/connectcomms/data` (Postgres, Redis, MinIO)
- `/opt/connectcomms/env`
- `/opt/connectcomms/backups` (unless separate future policy)
- Protected Docker volumes: `app_chat-attachments`, `app_crm-*`, `app_ivr-prompts`, `app_moh-assets`, `obs_*`
- Bind mounts used by running containers
- Active Docker images and running containers
- CRM documents, chat attachments, voicemail drops, IVR prompts, MOH assets

### Forbidden commands (plan validator rejects)

- `rm -rf`, `find -delete`, `truncate`, `shred`
- `docker system prune`, `docker volume prune`, `docker system prune --volumes`
- Wildcards (`*`)

---

## Reclaim simulation (Phase 1 plan only)

The plan builder proposes **explicit commands** with **dry-run counterparts**:

| Category | Example dry-run command | Execution |
|----------|-------------------------|-----------|
| BuildKit cache | `docker builder prune --filter until=336h --dry-run` | Phase 2 + approval |
| Unused images | `docker image inspect <id>` | Phase 2 + approval |
| Old APKs | `ls -la <exact-path>` | Phase 2 + approval |
| Monitoring logs | `find … -print` only (no delete in Phase 1) | Phase 2 + approval |
| journald | `journalctl --disk-usage` | Phase 2 + approval |

Plans are **blocked** when:

- Any `UNKNOWN_REQUIRES_REVIEW` item exists in the scan
- Any protected path appears in a command
- Any forbidden command pattern is detected
- Rollback candidates are included without explicit approval policy

---

## Alerts (thresholds via env)

| Alert | Default threshold |
|-------|-------------------|
| Disk warning / critical | 70% / 80% |
| containerd warning / critical | 300 GB / 400 GB |
| BuildKit warning / critical | 200 GB / 400 GB |
| Free space warning / critical | 50 GB / 20 GB |

Env vars: `STORAGE_DISK_WARNING_PCT`, `STORAGE_BUILDKIT_CRITICAL_BYTES`, etc. (see `dockerDeps.ts`).

---

## Phase 2 (requires manual approval — not implemented)

- Approval token issuance (`can_approve_storage_cleanup`)
- Pre/post service health checks
- Audited execution of **non-blocked** plan actions only
- Persistent execution history
- Optional scheduled scan + alert webhook

---

## Verification

```bash
pnpm --filter @connect/api exec node --experimental-test-module-mocks --import tsx --test "src/ops/storageMaintenance/*.test.ts"
```

Portal: `/admin/storage-health` → Scan Now → Cleanup Plan (read-only).

---

## Source files

| Path | Role |
|------|------|
| `apps/api/src/ops/storageMaintenance/types.ts` | Types + config |
| `apps/api/src/ops/storageMaintenance/protectionRules.ts` | Hard guards |
| `apps/api/src/ops/storageMaintenance/classifier.ts` | Classification |
| `apps/api/src/ops/storageMaintenance/scanner.ts` | Read-only inventory |
| `apps/api/src/ops/storageMaintenance/planBuilder.ts` | Dry-run plan |
| `apps/api/src/ops/storageMaintenance/alerts.ts` | Threshold alerts |
| `apps/api/src/ops/storageMaintenance/auditLog.ts` | Audit ring buffer |
| `apps/api/src/ops/storageMaintenance/service.ts` | Orchestration |
| `apps/api/src/ops/storageMaintenance/routes.ts` | HTTP routes |
| `apps/portal/app/(platform)/admin/storage-health/page.tsx` | Admin UI |
