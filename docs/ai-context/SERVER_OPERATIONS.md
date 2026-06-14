# SERVER_OPERATIONS

> Read `CURSOR_START_HERE.md` and `AGENTS.md` first. This document covers production
> host operations, diagnostics, and capacity — **not** deploy mechanics (see `DEPLOYMENT.md`).

---

## Production host

| Field | Value |
|-------|-------|
| Hostname | `vmi3101417` |
| Root filesystem | `/dev/sda1` ext4, **678 GB** total |
| App root | `/opt/connectcomms` |
| Deploy clone | `/opt/connectcomms/app` |
| Deploy logs | `/var/log/connect-deploys/` |
| Direct deploy logs | `/var/log/connect-deploys/direct-<service>-<timestamp>.log` |

---

## Storage forensics (2026-06-14, read-only)

**Investigation type:** read-only inspection. **No cleanup performed.**

### Summary

| Metric | Value |
|--------|-------|
| Disk used | **545 GB / 678 GB (81%)** |
| Disk free | **133 GB** |
| Inode use | **11%** (9.3M / 91.6M) — not inode-bound |
| Primary consumer | **Docker BuildKit build cache** (~534 GB, 98%) |
| Production data on disk | **~1 GB** (postgres bind mount, redis, volumes, minio) |

### Filesystem map

| Path | Size | Classification |
|------|------|----------------|
| `/var/lib/containerd` | **509 GB** | Build cache + image layers (see below) |
| `/opt/connectcomms` | **13 GB** | App clone, APKs, monitoring, backups |
| `/var/log` | **2.3 GB** | systemd journal, nginx, deploy logs |
| `/usr` | **2.3 GB** | OS packages |
| `/root` | **2.0 GB** | root home (`.local`, `.cache`, `.npm`) |
| `/var/lib/docker/volumes` | **~820 MB** | Named Docker volumes (live data) |

### containerd breakdown

| Subpath | Size | Purpose |
|---------|------|---------|
| `io.containerd.snapshotter.v1.overlayfs/snapshots` | **407 GB** | 4,202 overlay snapshots (BuildKit layer cache) |
| `io.containerd.content.v1.content/blobs` | **103 GB** | Content-addressable layer blobs |
| `io.containerd.metadata.v1.bolt` | **86 MB** | Metadata DB |

Docker reports **2,744** BuildKit cache entries totaling **534 GB** (522.7 GB marked reclaimable).

### Build cache by layer type (top consumers)

| Layer type | Total | Entries | Source |
|------------|-------|---------|--------|
| `COPY . .` (full repo) | 247 GB | 254 | api/worker Dockerfiles during deploy builds |
| `pnpm install --frozen-lockfile` | 103 GB | 126 | Dependency install step |
| portal `.next/cache` | 45 GB | 103 | Portal Next.js build cache |
| portal `public` copy | 45 GB | 221 | Portal Dockerfile runner stage |
| portal `NEXT_OUTPUT_STANDALONE` | 29 GB | 210 | Portal production build |
| portal source copy | 23 GB | 241 | Portal builder stage |
| `prisma generate` | 23 GB | 81 | API/worker schema generation |
| portal `standalone` copy | 9 GB | 221 | Portal runner stage |
| `apt-get install` (base image) | 6 GB | 143 | Node bookworm base layers |

**Root cause:** routine blue/green deploys (`scripts/deploy-api.sh`, `scripts/deploy-portal.sh`)
run `docker build` with BuildKit caching enabled. Old cache layers are never pruned.
Each deploy creates new ~2.1 GB `COPY . .` and `pnpm install` layers.

### `/opt/connectcomms` breakdown

| Path | Size | Classification |
|------|------|----------------|
| `downloads/` | 6.6 GB | 49 mobile APK builds (~138 MB each) |
| `app/` | 3.9 GB | Git deploy clone (1.8 GB `node_modules`) |
| `monitoring/logs` | 1.3 GB | Host monitoring log accumulation |
| `data/postgres` | 262 MB | **ACTIVE REQUIRED** — live Postgres data (bind mount) |
| `data/redis` | 51 MB | **ACTIVE REQUIRED** — live Redis persistence |
| `data/minio` | 120 KB | MinIO object store |
| `backups/` | 149 MB | Backup artifacts |

### Docker images (19 total, 15 in use)

**Active (containers=1):** `app-api`, `app-portal`, `app-worker`, `app-telephony`,
`app-realtime`, `postgres:15`, `redis:7`, `minio/minio`, observability stack
(prometheus, grafana, loki, promtail:3.0.0, alertmanager), `kamailio/kamailio-ci`,
`drachtio/rtpengine`.

**Inactive (containers=0, rollback/superseded):**

| Image | Size | Notes |
|-------|------|-------|
| `app-api_candidate:latest` | 4.31 GB | Last blue/green candidate; no running container |
| `app-portal_candidate:latest` | 567 MB | Last blue/green candidate; no running container |
| `postgres:16-alpine` | 395 MB | Unused Postgres version |
| `grafana/promtail:2.9.8` | 287 MB | Superseded by 3.0.0 |

**Dangling images:** 0

**Stopped containers:** 0 (all 15 containers running)

### Docker volumes (10 total, all attached)

| Volume | Size | Mounted by | Purpose |
|--------|------|------------|---------|
| `obs_prometheus_data` | 481 MB | `obs-prometheus` | Metrics TSDB |
| `obs_loki_data` | 327 MB | `obs-loki` | Log aggregation |
| `app_ivr-prompts` | 22 MB | `app-api-1` | IVR audio prompts |
| `app_chat-attachments` | 3.9 MB | `app-api-1`, `app-worker-1` | Chat file uploads |
| `app_moh-assets` | 3.1 MB | `app-api-1` | Music-on-hold assets |
| `app_crm-voicemail-drops` | 2.2 MB | `app-api-1` | CRM voicemail drops |
| `app_crm-lead-docs` | 1.7 MB | `app-api-1` | CRM lead documents |
| `obs_grafana_data` | 1.1 MB | `obs-grafana` | Grafana dashboards/state |
| `obs_alertmanager_data` | 0 B | `obs-alertmanager` | Alertmanager state |
| `2336590b0ac4…` | 16 KB | `sbc-rtpengine` | RTPEngine runtime |

Postgres uses a **bind mount** (`/opt/connectcomms/data/postgres`), not a named volume.
Redis uses a **bind mount** (`/opt/connectcomms/data/redis`).

### Container writable layers (all negligible)

| Container | Writable layer | Virtual size |
|-----------|---------------|--------------|
| `app-worker-1` | 73.1 MB | 2.82 GB |
| `app-api-1` | 5.43 MB | 3.08 GB |
| All others | < 1 MB each | varies |

### Reclaim simulation (estimate only — no action taken)

| Category | Size | Reclaimable? | Risk if removed |
|----------|------|--------------|-----------------|
| BuildKit build cache | ~534 GB | Yes (522.7 GB per Docker) | Low — next deploy rebuilds from scratch (slower) |
| Inactive candidate images | ~4.9 GB | Partially | Low — current stable images remain; rollback via re-deploy |
| Unused `postgres:16-alpine` | 395 MB | Yes | None — not in use |
| Unused `promtail:2.9.8` | 287 MB | Yes | None — superseded |
| Mobile APK downloads | 6.6 GB | Partially | Low — old builds; keep latest N |
| Monitoring logs | 1.3 GB | Partially | Low — historical diagnostics only |
| systemd journal | 2.1 GB | Partially | Low — use `journalctl --vacuum` (not done) |
| Deploy clone `node_modules` | 1.8 GB | No | Required for deploy builds |
| Postgres bind mount | 262 MB | **No** | **CRITICAL** — production database |
| Redis bind mount | 51 MB | **No** | **HIGH** — session/cache state |
| Docker volumes (all) | ~820 MB | **No** | **HIGH** — live app/observability data |

### Dangerous to remove (production data / rollback)

- `/opt/connectcomms/data/postgres` — live Postgres database
- `/opt/connectcomms/data/redis` — Redis persistence
- All 10 Docker volumes (attached to running containers)
- `app-api:latest`, `app-portal:latest`, `app-worker:latest`, `app-telephony:latest` — running production images
- `/opt/connectcomms/app` — deploy git clone (required for builds)
- `/opt/connectcomms/env/` — environment configuration (out of bounds for agents)

### Read-only diagnostic commands used

```bash
df -hT && df -i
sudo du -xh / | sort -hr | head -100
docker system df -v
docker images / docker ps -a / docker volume ls
docker buildx du --verbose
sudo du -sh /var/lib/containerd/*
sudo du -sh /opt/connectcomms/*
```

Full raw report saved on server: `/tmp/storage_forensics_20260614T131434Z.txt`

**No cleanup commands were run.** Await explicit human approval before any storage reclamation.

### Storage cleanup controller (Phase 1 / 1.5 / 1.6 / 2)

Read-only scanner + classifier + dry-run cleanup plan + **operations dashboard** + **proof/dependency/readiness system** via API and portal **`/admin/storage-health`**.
Phase 1.6 adds **host visibility**: read-only mounts of `docker.sock`, `/var/lib/containerd`, `/opt/connectcomms`, and `/var/log` into the API container so scans report real production inventory (~535 GB BuildKit cache, ~509 GB containerd, top consumers, image/volume counts).
Phase 2 adds BuildKit forensics, container→image dependency graph, rollback coverage audit, APK/log analysis, confidence scoring, cleanup readiness score, safety gates, and read-only preflight snapshots under `/opt/connectcomms/backups/storage-preflight/` (writable mount for JSON only — no cleanup).
Phase 1.5 dashboard surfaces KPIs, distribution chart, top consumers, protected assets, reclaim simulation, and trend history — all from live scan data.
See **`STORAGE_MAINTENANCE.md`** for architecture, confidence/dependency/rollback models, snapshot system, safety gates, and future approval requirements.
