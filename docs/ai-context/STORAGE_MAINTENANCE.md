# STORAGE_MAINTENANCE

> Safe storage cleanup controller for Connect production hosts.
> **Phase 1 / 1.5 / 1.6 (current): read-only scanner + classifier + dry-run plan + operations dashboard + host visibility.**
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
        ├── hostVisibility (mount probes, Docker API GET whitelist)
        ├── scanner (read-only: disk, docker, containerd, APKs, logs)
        ├── classifier (PROTECTED / ACTIVE / ROLLBACK / SAFE / UNKNOWN)
        ├── dashboard (KPIs, distribution, consumers, simulation, trends)
        ├── planBuilder (dry-run commands, command guard)
        ├── auditLog (in-memory ring buffer)
        └── executor (Phase 2 — currently refuses all execution)
```

### Phase 1.6 — Host visibility layer (read-only)

The API container previously could not see host storage (no `docker.sock`, no host paths).
Phase 1.6 adds **read-only inventory mounts** on `api` and `api_candidate` in `docker-compose.app.yml`:

| Host path | Container mount | Mode |
|-----------|-----------------|------|
| `/var/run/docker.sock` | `/var/run/docker.sock` | `ro` |
| `/var/lib/containerd` | `/host-inventory/var/lib/containerd` | `ro` |
| `/opt/connectcomms` | `/host-inventory/opt/connectcomms` | `ro` |
| `/var/log` | `/host-inventory/var/log` | `ro` |

`STORAGE_HOST_INVENTORY_ROOT=/host-inventory` remaps scanner config paths so the UI displays
familiar host paths (`/var/lib/containerd`, `/opt/connectcomms/...`) via `toHostDisplayPath()`.

```mermaid
flowchart LR
  subgraph host [Production host]
    DS[docker.sock]
    CTD[/var/lib/containerd]
    CC[/opt/connectcomms]
    LOG[/var/log]
  end
  subgraph api [API container]
    HV[hostVisibility.ts]
    SC[scanner.ts]
    DD[dockerDeps.ts]
  end
  DS -->|GET /system/df only| DD
  CTD -->|du -sb ro mount| SC
  CC -->|du -sb ro mount| SC
  LOG -->|du -sb ro mount| SC
  HV --> SC
  DD --> SC
```

**Docker inventory:** HTTP `GET` over the Unix socket — no `docker` CLI required.
Allowed paths are whitelisted in `hostVisibility.ts` (`/system/df`, `/images/json`, `/containers/json`, `/volumes`, `/info`, `/version`).
Any other path throws `storage_host_visibility_forbidden_docker_path`.

**Filesystem sizing:** `du -sb` on mounted inventory paths (180s timeout for large trees like containerd).

**Containerd breakdown:** overlay snapshots (`io.containerd.snapshotter.v1.overlayfs`) and content blobs (`io.containerd.content.v1.content`) reported separately.

### Security model (read-only guarantees)

| Layer | Guarantee |
|-------|-----------|
| Compose mounts | All host inventory mounts are `:ro` — kernel-enforced read-only |
| Docker API | Code-level GET whitelist; no POST/DELETE/prune endpoints callable |
| Scanner | No `rm`, `prune`, `truncate`, `journalctl --vacuum`, or write syscalls |
| HTTP routes | `POST /approve` → **501**, `POST /execute` → **403** (unchanged) |
| Plan validator | Rejects wildcard and destructive commands (Phase 1) |

**Caveat:** A read-only `docker.sock` mount still exposes the full Engine API at the socket level.
Mitigation is the application whitelist plus super-admin JWT on all `/admin/storage-health/*` routes.
A compromised API process could theoretically bypass the whitelist — treat socket access as privileged.

### Limitations (Phase 1.6)

- First scan after deploy may take **1–3 minutes** while `du` walks ~500 GB containerd tree.
- Disk totals use container root filesystem (`df`) — may differ slightly from host `df` on `/`.
- Growth trends require multiple scans over time (in-memory history ring).
- Worker/telephony hosts are not scanned — app host only.
- Build cache reclaimable estimate depends on Docker Engine `/system/df` reclaimable flags.

### API routes (super-admin JWT)

| Method | Path | Phase 1 behavior |
|--------|------|------------------|
| GET | `/admin/storage-health` | Dashboard snapshot: KPIs, distribution, trends, alerts |
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

## Phase 1.5 operations dashboard

Portal `/admin/storage-health` answers in under 10 seconds (after initial slow scan):

| Question | Source |
|----------|--------|
| Total / used / free disk | `dashboard.totalDiskBytes`, `usedBytes`, `freeBytes` |
| Build cache & reclaimable | `buildCacheBytes`, `reclaimableBytes` |
| Containerd total / overlay / blobs | `containerdBytes`, `containerdOverlayBytes`, `containerdContentBytes` |
| Protected data total | `protectedDataBytes` |
| Risk level | `riskLevel` (low / medium / high / critical) |
| Largest consumers (top 20) | `largestConsumers[]` (host paths, not mount prefixes) |
| Distribution by category | `distribution[]` (Build Cache, Application, Downloads, Logs, Database, Redis, Docker Volumes, Other) |
| Protected assets | `protectedAssets[]` |
| Reclaim simulation | `projectedUsageAfterCleanupBytes`, `projectedRecoveryBytes` (estimate only) |
| Disk trend | `trends[]` windows 24h / 7d / 30d with direction |
| Cleanup readiness | `cleanupReadiness[]` (eligible / review / blocked) |
| Host visibility status | `scan.hostVisibility` — mount and docker.sock probe |

API module: `apps/api/src/ops/storageMaintenance/dashboard.ts`

Execution remains blocked: approve **501**, execute **403**.

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
| `apps/api/src/ops/storageMaintenance/hostVisibility.ts` | Mount probes, Docker GET whitelist, display path remap |
| `apps/api/src/ops/storageMaintenance/dockerSystemDfApi.ts` | Parse Docker Engine `/system/df` JSON |
| `apps/api/src/ops/storageMaintenance/dockerDeps.ts` | Production deps: HTTP docker API, `du` sizing, config |
| `apps/api/src/ops/storageMaintenance/scanner.ts` | Read-only inventory (containerd breakdown) |
| `apps/api/src/ops/storageMaintenance/dashboard.ts` | KPIs, distribution, simulation, trends |
| `apps/api/src/ops/storageMaintenance/planBuilder.ts` | Dry-run plan |
| `apps/api/src/ops/storageMaintenance/alerts.ts` | Threshold alerts |
| `apps/api/src/ops/storageMaintenance/auditLog.ts` | Audit ring buffer |
| `apps/api/src/ops/storageMaintenance/service.ts` | Orchestration |
| `apps/api/src/ops/storageMaintenance/routes.ts` | HTTP routes |
| `apps/portal/app/(platform)/admin/storage-health/page.tsx` | Admin UI |
