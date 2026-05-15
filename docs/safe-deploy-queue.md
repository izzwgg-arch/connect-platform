# Safe deploy queue (serialized production deploys)

All routine production deploys **must** go through **`ops/deploy-queue`** so there are **no parallel** `docker compose` builds, **no concurrent** `deploy-tag.sh` runs, and **no accidental** cross-agent races.

| Who | Rule |
|-----|------|
| **Cursor agents** | Only `curl` the queue (`POST /ops/deploy/enqueue`). Never SSH in to run `docker compose … --build`, `pnpm prisma migrate deploy`, or `deploy-tag.sh` unless it is **documented emergency** work. |
| **Humans** | Same: use the queue on the server (`127.0.0.1:3910` + token). |
| **Emergency** | Direct `deploy-tag.sh` / `docker compose` is allowed for **break-glass recovery** only. You will see **warnings**; set `DEPLOY_QUEUE_ACK=1` to acknowledge and silence them. |

**What this does *not* change:** port 22, firewall rules, nginx, Postgres **application** schema (queue uses **SQLite** on disk), or existing Docker service names.

---

## Supported targets

| `service` (enqueue) | Script | Notes |
|---------------------|--------|--------|
| `api` | `scripts/deploy-api.sh` | **Only** this target runs `prisma migrate deploy`. |
| `portal` | `scripts/deploy-portal.sh` | No migrations. |
| `telephony` | `scripts/deploy-telephony.sh` | No migrations. |
| `realtime` | `scripts/deploy-realtime.sh` | No migrations. |
| `worker` | `scripts/deploy-worker.sh` | No migrations; health = container running. |
| `full-stack` | `scripts/deploy-full-stack.sh` | Wraps `scripts/release/deploy-tag.sh` (api+portal+worker+realtime + migrate + smoke). |

**Global serialization:** the worker runs **at most one job at a time** (any target). A file lock prevents a second PM2 instance from executing deploy scripts.

**API public verify on the app host:** When **`DEPLOY_API_PUBLIC_VERIFY_URL`** is set, **`scripts/lib/deploy-api-rollout.sh`** curls that URL from the same machine that runs the deploy worker. If nginx returns **`403`** for the public hostname but **`curl --resolve host:443:127.0.0.1 …`** returns **`200`**, set **`DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1`** in the worker environment (see **`docs/nginx/README.md`** and **`docs/ai-context/DEPLOYMENT.md`** § API blue/green).

**Out of scope — PBX-host installers:** The queue is **app-host / container scoped** only. PBX-host root installers (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`, `scripts/pbx/install-connect-tenant-moh-dialplan.sh`, and similar) are **not** queue targets and must not be added as queue targets without a separate cross-host trust review. They are operator-run break-glass actions on the VitalPBX host; see `docs/ai-context/DEPLOYMENT.md` § "VitalPBX host: Connect route helper script" and § "VitalPBX host: Connect tenant MOH enforcement layer".

---

## How to enqueue (examples)

Replace `TOKEN`, host, and IDs. Bind address defaults to **`127.0.0.1`** — use SSH port forward:  
`ssh -L 3910:127.0.0.1:3910 user@server`

### Per-service (branch)

```bash
curl -sS -X POST "http://127.0.0.1:3910/ops/deploy/enqueue" \
  -H "Content-Type: application/json" \
  -H "x-deploy-queue-token: $TOKEN" \
  -d '{"service":"api","branch":"main","requestedBy":"cursor:session-abc","dryRun":false}'
```

Optional: `"commitHash":"<sha>"` instead of tracking `branch` for detached deploys.

### Worker

```bash
curl -sS -X POST "http://127.0.0.1:3910/ops/deploy/enqueue" \
  -H "Content-Type: application/json" \
  -H "x-deploy-queue-token: $TOKEN" \
  -d '{"service":"worker","branch":"main","requestedBy":"human:ops"}'
```

### Full-stack (git **tag**, not branch name)

The `branch` JSON field carries the **tag** string passed to `deploy-tag.sh`:

```bash
curl -sS -X POST "http://127.0.0.1:3910/ops/deploy/enqueue" \
  -H "Content-Type: application/json" \
  -H "x-deploy-queue-token: $TOKEN" \
  -d '{"service":"full-stack","branch":"v2.1.70","requestedBy":"human:release"}'
```

### Dry run (`dryRun: true`)

Logs what **would** happen and performs a non-mutating git checkout-safety preflight. The preflight fetches refs, verifies the target branch/commit/tag exists, compares target-changed paths against dirty non-ignored paths in the production clone, and fails with the exact blocking paths if a real checkout would overwrite local edits. Scripts still exit **before** git checkout/reset/clean, `docker compose` rebuilds, Prisma migrations, service restarts, and health-driven rollbacks. Still consumes a queue slot and respects duplicate protection. **`commit_already_deployed`** (when `commitHash` is supplied) inspects only **real** (`dryRun: false`) successes for that service: **`connect-deploy-queue` 1.1.1+** excludes dry-run rows; **1.1.2+** also matches the requested SHA against **`deployed_commit`** or, for legacy rows, **`commit_hash`**, and deploy scripts publish **`deployedCommit`** to the state file without subshell loss (see **`deploy_common_git_sync`**).

```bash
curl -sS -X POST "http://127.0.0.1:3910/ops/deploy/enqueue" \
  -H "Content-Type: application/json" \
  -H "x-deploy-queue-token: $TOKEN" \
  -d '{"service":"portal","branch":"main","requestedBy":"cursor:test","dryRun":true}'
```

---

## HTTP API

All routes except **`GET /health`** require:

- Header `x-deploy-queue-token: <DEPLOY_QUEUE_TOKEN>` **or**
- `Authorization: Bearer <DEPLOY_QUEUE_TOKEN>`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Plain `ok` (no token). |
| GET | `/ops/deploy/status` | `queuedCount`, `runningCount` (0 or 1), `maxQueued`, `runningJob`, `targets`, worker `lock`, `version` (`deployQueuePackage` + `repoHead`). |
| GET | `/ops/deploy/jobs` | `?status=&limit=` |
| GET | `/ops/deploy/jobs/:id` | Job row + optional `logTail` (last bytes). |
| GET | `/ops/deploy/jobs/:id/log` | JSON `{ lines, text }` — last **N** lines (default **200**, max **2000**). `?lines=500`. **Only** reads the log file registered for that job id (no arbitrary paths). |
| POST | `/ops/deploy/enqueue` | Body: `service`, `branch`, optional `commitHash`, `requestedBy`, optional `dryRun`. |
| POST | `/ops/deploy/jobs/:id/cancel` | Queued jobs only. |

### Job object fields

All `job` objects returned by the API include both snake_case (raw SQLite columns) and camelCase aliases:

| camelCase | snake_case | Meaning |
|-----------|------------|---------|
| `id` | `id` | UUID |
| `service` | `service` | `api` / `portal` / `telephony` / `realtime` / `worker` / `full-stack` |
| `branch` | `branch` | Branch (or tag for `full-stack`) |
| `commitHash` | `commit_hash` | Enqueue pin (may be null for branch-only jobs) |
| `deployedCommit` | `deployed_commit` | SHA written from deploy state (`deployedCommit` JSON); prefer this for audit. **`1.1.2` worker** back-fills with `commit_hash` on success when the state file did not carry a value. |
| `requestedBy` | `requested_by` | Caller identifier |
| `status` | `status` | `queued` / `running` / `success` / `failed` / `cancelled` |
| `dryRun` | `dry_run` | Boolean / 0-1 |
| `queuedAt` | `created_at` | Epoch ms when enqueued |
| `startedAt` | `started_at` | Epoch ms when worker picked it up |
| `finishedAt` | `finished_at` | Epoch ms when it reached a terminal status |
| `duration`, `durationMs` | `duration_ms` | ms between `startedAt` and `finishedAt` (null while running) |
| `currentStage` | `current_stage` | `git-sync` / `change-detect` / `install` / `migrate` / `build` / `restart` / `health` / `done` / `rollback` / `dry-run` |
| `skipReason` | `skip_reason` | `no_changes`, `unrelated_paths`, or null (only set on `success` short-circuits) |
| `logPath` | `log_path` | Path on server, under `/var/log/connect-deploys/` |
| `errorMessage` | `error_message` | Populated on failure |

### Duplicate protection

SQLite **partial unique index**: at most one row per `service` with `status IN ('queued','running')`. A second enqueue for the same target returns **409** `duplicate_active_job_for_service`.

### Queue length limit

Env **`DEPLOY_QUEUE_MAX_QUEUED`** (default **10**): if `COUNT(*)` of `queued` jobs ≥ max, enqueue returns **429** `queue_full`.

---

## Logs

- Per-job file: `/var/log/connect-deploys/<job-id>.log`
- View via API: `GET /ops/deploy/jobs/<id>/log?lines=200`
- Or `pm2 logs connect-deploy-worker`
- **Rotation:** the worker deletes `.log` files older than **30 days** on startup and daily. Active logs (`queued` or `running`) and logs newer than 1 hour are never removed.
- Every successful deploy writes `[timing] install=… build=… restart=… health=… total=…` lines so you can see where the time went without running a profiler.

## Optimization behaviour

The worker + per-service scripts cooperate to avoid wasted work:

- **No-change skip** — if `origin/<branch>` or the pinned commit already equals the currently deployed HEAD, the script exits with `status=success`, `skipReason=no_changes`, and no docker / prisma work runs.
- **Change-path detection** — when the commit changed but the diff touches none of the service's paths (e.g. `apps/api/**`, `packages/db/**`, `packages/shared/**`, `pnpm-lock.yaml`, `docker-compose.app.yml`), the script exits with `skipReason=unrelated_paths`.
- **Smart install** — `pnpm install --frozen-lockfile --prefer-offline` only runs if `pnpm-lock.yaml` **or** `package.json` changed.
- **Gated migrations** — `prisma migrate deploy` only runs on `api` jobs **and** only when `packages/db/prisma/schema.prisma` or `packages/db/prisma/migrations/**` changed.
- **Service-scoped restart** — each per-service script runs `docker compose up -d <service>` for its own container only. No other PM2 process is ever restarted.
- **Instant wake** — `POST /ops/deploy/enqueue` wakes the worker loop immediately (no 3 s poll delay); fallback poll runs every **1 s**.

---

## Bypass warnings (emergency only)

| Entry point | Behaviour |
|-------------|-----------|
| `scripts/release/deploy-tag.sh` | After the `run-heavy` re-exec lock, prints a **stderr WARNING** unless `DEPLOY_QUEUE_ACK=1`. The queue sets this when running `full-stack`. |
| `scripts/release/deploy-via-ssh.ps1` | Emits a **PowerShell warning** unless `$env:DEPLOY_QUEUE_ACK -eq '1'`. |
| Direct `docker compose …` | No automatic wrapper — **policy + code review**; agents must not do this for routine work. |

---

## Server setup (summary)

```bash
sudo mkdir -p /var/log/connect-deploys && sudo chown "$USER" /var/log/connect-deploys
sudo install -m 600 /dev/null /opt/connectcomms/env/.env.deploy-queue
# add DEPLOY_QUEUE_TOKEN, optional DEPLOY_QUEUE_MAX_QUEUED, etc.

cd /opt/connectcomms/app
pnpm install
pnpm approve-builds && pnpm rebuild better-sqlite3   # Linux: native better-sqlite3

bash scripts/ops/start-deploy-queue-pm2.sh
```

### Upgrading `connect-deploy-queue` only (e.g. **1.1.2**)

Pin `/opt/connectcomms/app` to the desired git revision (via your normal queue-driven deploy of **`api`** if this change shipped there, or operator policy). Then **`bash scripts/ops/start-deploy-queue-pm2.sh`** rebuilds **`ops/deploy-queue`** and **`pm2 reload`**s **`connect-deploy-worker`**. Verify **`GET http://127.0.0.1:3910/ops/deploy/status`** shows **`version.deployQueuePackage":"1.1.2"`** (and idle **`runningCount`** / **`queuedCount`** before and after). This path does **not** restart **`api`**, **`portal`**, or **`telephony`** containers by itself — only the PM2 queue process.

### Env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `DEPLOY_QUEUE_TOKEN` | (required) | Shared secret for API auth. |
| `DEPLOY_QUEUE_MAX_QUEUED` | `10` | Max **queued** jobs (not counting running). |
| `DEPLOY_QUEUE_BIND` | `127.0.0.1` | Listen address. |
| `DEPLOY_QUEUE_PORT` | `3910` | Listen port. |
| `DEPLOY_QUEUE_LOG_DIR` | `/var/log/connect-deploys` | Job logs directory. |
| `DEPLOY_QUEUE_STATE_DIR` | `…/ops/deploy-queue/var` | SQLite + worker lock. |
| `DEPLOY_REPO_ROOT` | `/opt/connectcomms/app` | Git + compose root. |

---

## Verification checklist (staging / maintenance)

1. **PM2:** `pm2 status` shows `connect-deploy-worker` online; `curl -sS http://127.0.0.1:3910/health` → `ok`.
2. **Status:** `GET /ops/deploy/status` with token → `targets` includes all six services; `lock` sane.
3. **Enqueue api:** job reaches `success` (or `failed` with log reason).
4. **Duplicate api:** second enqueue while first `queued`/`running` → **409**.
5. **Serialize:** enqueue `portal`, then `api` — second starts only after first completes.
6. **Log API:** `GET /ops/deploy/jobs/<id>/log?lines=50` returns text.
7. **Dry run:** enqueue with `"dryRun":true` — log shows “DRY RUN checkout safety”, target ref verification, and either `OK` or exact blocking paths; no checkout or container churn occurs (inspect `docker ps` timestamps).
8. **Infra:** confirm no intentional edits to port 22 / nginx / Postgres platform schema from this feature.

---

## Known limitations

- `full-stack` jobs use the same global lock as single-service jobs; tag must exist on `origin` after `git fetch`.
- Rollback in per-service scripts is best-effort (rebuild previous git state).
- Windows dev hosts may skip running the queue locally if `better-sqlite3` is not built.
- A successful dry-run only proves checkout safety at that moment. Operators must still run the real deploy through the queue and verify the final `done <sha>` log line / container contents for production-impact changes.
