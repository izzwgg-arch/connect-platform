# Safe deploy queue

Serializes production deploys so **multiple Cursor agents (or humans) never run `docker compose` / Prisma / git deploy steps at the same time** on the Connect server.

Production today uses **Docker Compose** (`docker-compose.app.yml`) for `api`, `portal`, `telephony`, `realtime` (and `worker`). The queue runs a small **Node service** (`ops/deploy-queue`) that:

- Exposes **localhost-only** HTTP endpoints under `/ops/deploy/…`
- Persists jobs in **SQLite** (no changes to the main Postgres schema)
- Runs a **single-threaded worker** that executes `scripts/deploy-<service>.sh` **one job at a time globally**
- Writes **per-job logs** under `/var/log/connect-deploys/`
- Uses a **PID lock file** so a second PM2 instance cannot accidentally run a second worker

This does **not** replace `scripts/release/deploy-tag.sh` for full tagged releases (API + portal + worker + realtime + migrations + smoke). Use the queue for **targeted service** deploys from branches.

---

## Architecture

| Piece | Path / name |
|--------|-------------|
| HTTP + worker (one process) | `ops/deploy-queue` → PM2 app **`connect-deploy-worker`** (`GET /health` = `ok`, no token) |
| Per-service shell scripts | `scripts/deploy-api.sh`, `deploy-portal.sh`, `deploy-telephony.sh`, `deploy-realtime.sh` |
| Shared bash helpers | `scripts/lib/deploy-common.sh` |
| SQLite DB | `$DEPLOY_QUEUE_SQLITE_PATH` (default `ops/deploy-queue/var/queue.db`) |
| Worker file lock | `$DEPLOY_QUEUE_STATE_DIR/worker.lock` |
| Job logs | `/var/log/connect-deploys/<job-id>.log` |

**Migrations:** only `scripts/deploy-api.sh` runs `prisma migrate deploy`. Other services **must not** run migrations (requirement #7).

**Duplicate protection:** SQLite partial unique index: at most one job per `service` in `queued` or `running`. A second enqueue for the same service returns **409**.

---

## Environment variables

Create **`/opt/connectcomms/env/.env.deploy-queue`** on the server (chmod `600`, owned by the deploy user). Minimum:

| Variable | Required | Description |
|----------|----------|-------------|
| `DEPLOY_QUEUE_TOKEN` | **yes** | Shared secret; callers send `x-deploy-queue-token: <token>` or `Authorization: Bearer <token>` |
| `DEPLOY_REPO_ROOT` | no | Git checkout root (default `/opt/connectcomms/app`) |
| `DEPLOY_QUEUE_BIND` | no | Default `127.0.0.1` |
| `DEPLOY_QUEUE_PORT` | no | Default `3910` |
| `DEPLOY_QUEUE_LOG_DIR` | no | Default `/var/log/connect-deploys` |
| `DEPLOY_QUEUE_STATE_DIR` | no | Lock + SQLite parent dir |
| `DEPLOY_QUEUE_SQLITE_PATH` | no | Default `$DEPLOY_QUEUE_STATE_DIR/queue.db` (see `server.ts`) |
| `DEPLOY_QUEUE_POLL_MS` | no | Worker poll interval (default `3000`) |

Optional override for compose file path inside scripts:

- `DEPLOY_COMPOSE_FILE` (default `docker-compose.app.yml` under repo root)

---

## One-time server setup

```bash
# From repo root on the Linux server
sudo mkdir -p /var/log/connect-deploys
sudo chown "$(whoami)" /var/log/connect-deploys

# Secrets file (example)
sudo install -m 600 /dev/null /opt/connectcomms/env/.env.deploy-queue
sudoedit /opt/connectcomms/env/.env.deploy-queue
# add:  DEPLOY_QUEUE_TOKEN='openssl rand -hex 32 output here'

cd /opt/connectcomms/app
pnpm install
pnpm approve-builds   # allow better-sqlite3 native build (required on Linux for the queue to run)
pnpm rebuild better-sqlite3

bash scripts/ops/start-deploy-queue-pm2.sh
```

**`better-sqlite3`:** uses a native addon. On the **Linux** server you must allow/rebuild install scripts (`pnpm approve-builds` / `pnpm rebuild better-sqlite3`). Windows dev machines may skip running the queue locally if the binary is not built.

---

## HTTP API (localhost only)

Bind address defaults to **`127.0.0.1:3910`**. Do not expose this port on the public internet. Reach it via:

- SSH port forward: `ssh -L 3910:127.0.0.1:3910 user@server`
- Or an existing internal admin nginx `location` (optional; not shipped here)

All routes require the token header.

### `POST /ops/deploy/enqueue`

Body (JSON):

```json
{
  "service": "api",
  "branch": "main",
  "commitHash": "optional-full-sha",
  "requestedBy": "cursor-agent-session-xyz"
}
```

- `service`: `api` \| `portal` \| `telephony` \| `realtime`
- `branch`: required if `commitHash` omitted (scripts default to `main` when branch empty but commit empty fails)
- `commitHash`: optional; if set, deploy scripts `git checkout` that SHA (detached)
- `requestedBy`: audit string (agent id, human name, etc.)

Responses: **201** created, **409** duplicate active job for that service, **401** bad token.

### `GET /ops/deploy/jobs`

Query: `?status=queued&limit=50`

### `GET /ops/deploy/jobs/:id`

Returns `job` plus `logTail` (last ~64 KiB of the log file if present).

### `POST /ops/deploy/jobs/:id/cancel`

Only if status is **`queued`**. Running jobs cannot be cancelled via this MVP endpoint.

---

## How Cursor agents should deploy (do not SSH-run deploy concurrently)

1. **Do not** run `bash scripts/release/deploy-tag.sh`, `docker compose … --build`, or `pnpm prisma migrate deploy` directly over SSH while another agent might do the same.
2. Open an SSH tunnel to the queue port (or use an internal jump host that can curl localhost).
3. **Enqueue** one job per service you need:

```bash
export DEPLOY_QUEUE_TOKEN='…from server env file…'
curl -sS -X POST "http://127.0.0.1:3910/ops/deploy/enqueue" \
  -H "Content-Type: application/json" \
  -H "x-deploy-queue-token: $DEPLOY_QUEUE_TOKEN" \
  -d '{"service":"portal","branch":"main","requestedBy":"cursor:<session-id>"}'
```

4. Poll until terminal state:

```bash
curl -sS "http://127.0.0.1:3910/ops/deploy/jobs/<id>" \
  -H "x-deploy-queue-token: $DEPLOY_QUEUE_TOKEN"
```

5. For **full stack / tagged** releases that must match `deploy-tag.sh` behaviour, **coordinate** so only one human (or one agent with exclusive lock) runs `deploy-tag.sh`, or extend the queue later with a `full-stack` job type (TODO).

---

## PM2

- **Process name:** `connect-deploy-worker` (see `ops/deploy-queue/ecosystem.config.cjs`)
- **Instances:** must stay at **1**. Scaling to 2+ can fight over Docker unless you rely solely on the file lock (second process will crash-loop on lock — intentional).

Start / rebuild:

```bash
bash scripts/ops/start-deploy-queue-pm2.sh
```

Logs:

```bash
pm2 logs connect-deploy-worker
```

---

## Crash safety

- On process start, any job still marked **`running`** is moved to **`failed`** with message `worker restarted while job was running (marked failed)`.
- A **worker lock file** prevents two workers from running deploy scripts; stale locks are reclaimed if the owning PID is dead or the lock is older than ~2 minutes (see `src/lockfile.ts`).

---

## Test checklist (staging or maintenance window)

- [ ] `curl` enqueue each service once with a throwaway branch; confirm job reaches `success` or expected `failed`.
- [ ] Second enqueue for same service while first is `queued` → **409**.
- [ ] Cancel queued job → status `cancelled`.
- [ ] Kill worker mid-deploy (`pm2 stop`) → restart → previous `running` job becomes `failed`; new jobs still process.
- [ ] Confirm **portal** job does **not** run `prisma migrate` (grep log).
- [ ] Confirm **api** job **does** run `prisma migrate deploy` once.
- [ ] Health failures trigger rollback attempt in log (git + rebuild).

---

## Known limitations / TODOs

- **Worker** Docker service is **not** a queue target; `deploy-tag.sh` still rebuilds it. Add a fifth script if needed.
- **Rollback** rebuilds the previous git revision; it is best-effort and may still fail if Docker state is inconsistent — check logs.
- Servers that **only** deploy detached tags (never `origin/main`) may need branch/tag workflow adjustments — see `scripts/lib/deploy-common.sh` (`DEPLOY_COMMIT` vs `DEPLOY_BRANCH`).
- **Nginx / port 22** are untouched by this feature.
