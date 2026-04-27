# Cursor Agent Deployment Rules

> Read this file **before every deploy-related action**. It applies to all Cursor
> agents (Composer, Background, CLI, subagents) and to any human running agent
> commands on their behalf.

## Agent auto-enqueue (no token required)

Agents can enqueue deployments **without knowing `DEPLOY_QUEUE_TOKEN`** using
two safe paths:

### Path A — direct queue call (on the server via SSH)

The deploy queue grants trust to requests originating from `127.0.0.1` (the
host loopback) and the Docker bridge subnets (`172.16.0.0/12`, `10.0.0.0/8`).
No Authorization header needed from these origins.

```bash
# SSH onto the server, then:
curl -s -X POST http://127.0.0.1:3910/ops/deploy/enqueue \
  -H "Content-Type: application/json" \
  -d '{
    "service": "api",
    "branch": "main",
    "requestedBy": "cursor:agent",
    "reason": "deploy updated API routes",
    "dryRun": true,
    "source": "auto"
  }'
```

### Path B — Connect API internal route (from any networked caller)

```
POST /internal/deploy/auto
```

This endpoint is **blocked externally by nginx** (same as `/internal/cdr-ingest`).
Call it from a server-side script, via SSH tunnel, or with an admin JWT:

```bash
curl -s -X POST https://app.connectcomunications.com/api/internal/deploy/auto \
  -H "Content-Type: application/json" \
  -H "x-internal-deploy-secret: <INTERNAL_DEPLOY_SECRET>" \
  -d '{
    "service": "portal",
    "branch": "main",
    "requestedBy": "cursor:agent",
    "reason": "agent deploy after code change",
    "dryRun": false
  }'
```

Or with an admin Bearer token:
```bash
curl -s -X POST https://app.connectcomunications.com/api/internal/deploy/auto \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "service": "api", "branch": "main", "dryRun": false }'
```

### Auto-enqueue safety limits

- **Rate limit**: 1 auto-enqueue per service per **30 seconds**. Returns
  `429 auto_enqueue_rate_limited` with `retryAfterMs` if too fast.
- **Same-commit skip**: If `commitHash` is supplied and was already
  successfully deployed, returns `200 { skipped: true, reason: "commit_already_deployed" }`.
- **Duplicate guard**: Only one active job per service — a second call for
  the same service returns `409 duplicate_active_job_for_service`.
- Jobs enqueued via these paths are labelled `source: "auto"` and show
  an **⚡ Auto** badge in the Deploy Center UI.

---

## Hard rules

1. **NEVER deploy manually** via SSH commands, `git pull`, `npm/pnpm build`,
   `docker compose up --build`, `pm2 restart`, or `scripts/release/deploy-tag.sh`
   on the server. No exceptions for "just this once".
2. **ALL deployments MUST go through the deploy queue API.** Use Path A (direct
   localhost call) or Path B (`/internal/deploy/auto`) above.
3. Enqueue with:
   ```
   POST /ops/deploy/enqueue        (no token needed from localhost)
   POST /internal/deploy/auto      (via Connect API, admin JWT or secret)
   ```
4. Required payload:
   - `service` — one of `api | portal | telephony | realtime | worker | full-stack`
   - `branch` — git branch (for `full-stack`, pass the git **tag** here, e.g. `v2.1.72`)
   - `commitHash` — optional; pins a specific SHA (wins over branch)
   - `requestedBy` — e.g. `cursor:<session-id>` or `human:<name>`
   - `reason` — one-line free-form note for the log
   - `source` — `"auto"` for agent triggers; `"manual"` for human UI (inferred if omitted)
5. Check status:
   ```
   GET /ops/deploy/jobs/:id
   GET /ops/deploy/jobs/:id/log?lines=200
   GET /ops/deploy/status
   ```
6. **NEVER run database migrations directly.** Only the `api` deploy job runs
   `prisma migrate deploy`, and only when `packages/db/prisma/**` actually
   changed between the deployed commit and the target commit.
7. **NEVER restart all PM2 processes.** Only the target service's container
   (`docker compose up -d <service>`) is restarted. Leave every other service
   alone — especially `connect-deploy-worker`, Postgres, Redis, and nginx.
8. **NEVER modify server infrastructure.** Hands off: firewall rules, port 22,
   nginx config, Postgres schema (outside a reviewed Prisma migration),
   QuickBooks integration logic, and anything under `/etc/` or `/opt/connectcomms/env/`.
9. **If unsure what to deploy → DO NOT GUESS.** Stop, ask the human, and prefer
   a `dryRun: true` enqueue before the real one.

## Required preflight before any enqueue

- Run `GET /ops/deploy/status` — confirm `runningCount` is `0` or the
  currently-running job is expected.
- Confirm the requested branch/commit exists on `origin` (`git fetch` locally,
  or let the deploy script do it). A missing ref is rejected with a clear error.
- Prefer `"dryRun": true` first. The dry-run prints what the script would do
  without touching git, docker, prisma, or health checks.

## Forbidden commands on production

The following are **not allowed** for agents, even over SSH:

- `git pull` / `git checkout` / `git reset` outside the deploy queue's own clone
- `pnpm install`, `pnpm build`, `npm ci`, `npm run build`
- `docker compose up`, `docker compose build`, `docker compose restart`
- `pm2 restart`, `pm2 reload`, `pm2 kill`
- `pnpm prisma migrate` in any form
- `bash scripts/release/deploy-tag.sh …` (use `service: "full-stack"` instead)
- Editing files under `/opt/connectcomms/env/`, `/etc/nginx/`, `/etc/ssh/`,
  `/etc/ufw/`, or `iptables`/`ufw` rules
- Any deletion or truncation of Postgres tables, `pg_dump --clean`,
  `TRUNCATE`, `DROP`, or destructive Prisma `db push --force-reset`

## Allowed read-only diagnostics

These are fine for agents:

- `GET /ops/deploy/status` and `/ops/deploy/jobs[?status=…][&limit=…]`
- `GET /ops/deploy/jobs/:id/log?lines=<=2000>`
- `docker compose ps`, `docker logs --since=10m <container>` (read-only)
- `pm2 status`, `pm2 logs --lines 200 connect-deploy-worker` (read-only)
- Reading log files under `/var/log/connect-deploys/` (read-only)

## Duplicate / concurrent job handling

- The queue enforces **one active job per service** (`queued` or `running`).
  A second enqueue for the same `service` while one is active returns **409
  `duplicate_active_job_for_service`**. If you see that, **do not retry** —
  wait for the running job, or cancel the queued one via
  `POST /ops/deploy/jobs/:id/cancel`.
- The worker runs **one job at a time globally** (single-threaded loop + PID
  file lock). If it is idle, a new enqueue wakes it immediately.

## Emergency override

Direct `docker compose` / `deploy-tag.sh` execution is **break-glass only**
(e.g., the queue itself is down or the server is in recovery). In that case:

1. Ask a human first.
2. Set `DEPLOY_QUEUE_ACK=1` to acknowledge and silence warnings.
3. Write a short note into the repo/PR describing what was bypassed and why.

## Where to learn more

- Full HTTP reference & examples: `docs/safe-deploy-queue.md`
- Per-service scripts: `scripts/deploy-<service>.sh`
- Shared helpers: `scripts/lib/deploy-common.sh`
- Worker source: `ops/deploy-queue/src/`
