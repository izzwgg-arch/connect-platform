# Cursor Agent Deployment Rules

> Read this file **before every deploy-related action**. It applies to all Cursor
> agents (Composer, Background, CLI, subagents) and to any human running agent
> commands on their behalf.

## ⛔ ABSOLUTE RULE — Connect must NOT modify the PBX without explicit owner permission

Connect (and any agent) has **no business modifying the VitalPBX in any shape,
type, or form** — creating/updating/deleting tenants, adding/removing inbound
DIDs, regenerating/applying tenant config, queue or code CRUD, or any other
VitalPBX configuration write — **without the owner's specific, explicit
permission for that specific operation.**

This is enforced in code, not just by convention:

- `VitalPbxClient` runs in **PBX READ-ONLY SAFE MODE by default**. Every endpoint
  flagged `pbxConfigMutation: true` (`packages/integrations/src/vitalpbx/endpointRegistry.ts`)
  throws `PBX_MUTATION_BLOCKED` unless writes are explicitly enabled.
- The **only** way to permit a write is the env var
  `PBX_ALLOW_CONFIG_MUTATIONS=1` (or constructing the client with
  `allowConfigMutations: true`) — and only for a deliberate, human-authorized
  action. Default unset = blocked.
- Background: an automatic tenant re-save (`PUT /api/v2/tenants/:id` with only
  `{name,description,settings}`) is a full-resource replace and **silently wiped
  tenants' inbound DIDs** (June 2026). Inbound DIDs live in a separate
  sub-collection, not in `settings`. Never re-introduce a tenant PUT for a
  "config regenerate". `apply_changes` is the only regenerate trigger and is
  itself gated.

**Hard rules for agents:**
1. Never set `PBX_ALLOW_CONFIG_MUTATIONS`, never pass `allowConfigMutations: true`,
   and never weaken/remove the safeguard or the `pbxConfigMutation` flags without
   the owner explicitly asking for that exact change.
2. Never write code that mutates VitalPBX config on an automatic/background path
   (sync, refresh, provisioning, cron). PBX config changes are owner-initiated only.
3. Regression test `apps/api/src/pbxMutationSafeguard.test.ts` must stay green.

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

## Direct deploy (default for api + portal)

**Preferred after local testing and `git push`:** bypass the queue and run the same
per-service scripts the worker invokes.

| Step | Command |
|------|---------|
| Local test | `pnpm --filter @connect/api test` / portal `tsc`; `bash scripts/build-changed.sh` |
| Dry-run on server | `bash scripts/deploy-direct.sh api --branch main --dry-run` |
| Direct API | `bash scripts/deploy-direct.sh api --branch main` (on app host) |
| Direct portal | `bash scripts/deploy-direct.sh portal --branch main` |
| From workstation | `pwsh -File scripts/release/deploy-direct.ps1 -Service api -Branch main` |
| Verify SHA | `docker exec app-api-1 grep -n '<unique line>' /app/...` (see post-deploy checks below) |

Direct deploy sets `DEPLOY_QUEUE_ACK=1`, sources `/opt/connectcomms/env/.env.deploy-queue`
for blue/green nginx vars, and runs `scripts/deploy-api.sh` or `scripts/deploy-portal.sh`
unchanged (migrations, BuildKit, `/ready` gates, rollback traps).

**Refuses to start** when the deploy queue reports `runningCount > 0` (unless
`--skip-queue-check`). Logs to `/var/log/connect-deploys/direct-<service>-<timestamp>.log`.

---

## Hard rules

1. **NEVER ad-hoc deploy** via raw `git pull`, `npm/pnpm build` on the server outside
   the scripted paths, `docker compose up --build` by hand, `pm2 restart`, or untagged
   `scripts/release/deploy-tag.sh`. No exceptions for "just this once".
2. **Routine `api` / `portal` production deploys** use **`scripts/deploy-direct.sh`**
   (or `scripts/release/deploy-direct.ps1` over SSH). **Deploy queue** (Path A/B below)
   is **fallback / safe mode** — other services (`telephony`, `worker`, `realtime`,
   `full-stack`), Deploy Center audit UI, or when direct path is blocked.
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
5. Queue fallback helper (on server): `bash scripts/ops/_deploy-queue-fallback.sh api`
6. Check status:
   ```
   GET /ops/deploy/jobs/:id
   GET /ops/deploy/jobs/:id/log?lines=200
   GET /ops/deploy/status
   ```
8. **NEVER run database migrations directly** (outside `scripts/deploy-api.sh` / direct deploy). Only the `api` deploy path runs
   `prisma migrate deploy`, and only when `packages/db/prisma/**` actually
   changed between the deployed commit and the target commit.
9. **NEVER restart all PM2 processes.** Only the target service's container
   (`docker compose up -d <service>`) is restarted. Leave every other service
   alone — especially `connect-deploy-worker`, Postgres, Redis, and nginx.
10. **NEVER modify server infrastructure.** Hands off: firewall rules, port 22,
   nginx config, Postgres schema (outside a reviewed Prisma migration),
   QuickBooks integration logic, and anything under `/etc/` or `/opt/connectcomms/env/`.
11. **If unsure what to deploy → DO NOT GUESS.** Stop, ask the human, and prefer
   `--dry-run` on direct deploy or `dryRun: true` on queue enqueue before the real one.
12. **API deploys MUST use blue/green.** Keep **`DEPLOY_API_BLUEGREEN=1`** enabled (in **`/opt/connectcomms/env/.env.deploy-queue`** — sourced by direct deploy and the queue worker). The **routine** **`api`** path is **`scripts/lib/deploy-api-rollout.sh`**: **`api_candidate`** on **`:3004`**, **`GET /ready`** (no JWT), nginx include flips (**`DEPLOY_NGINX_API_UPSTREAM_ACTIVE_FILE`**), stable **`api`** on **`:3001`**, flip back — final include **must read `server 127.0.0.1:3001;`** after success. **`DEPLOY_API_BLUEGREEN=0`** / **`deploy_common_compose_up` + `docker compose rm -sf`** for **`api`** is **not** permitted for normal production rollout: it destroys the listening container before nginx has a candidate to talk to (**historic `/api/*` `502`**). Only a **human-written** emergency runbook may override (**break-glass**).
13. **Portal deploys MUST use blue/green for routine production.** Keep **`DEPLOY_PORTAL_BLUEGREEN=1`** (default in **`scripts/deploy-portal.sh`**). Routine path: **`portal_candidate`** on **`:3005`**, **`GET /ready`** on **`apps/portal`** (**no auth**), nginx include (**`DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE`** → **`docs/nginx/connect-portal-upstream-active.snippet`**), **`docker compose` `--profile portal_rollout`**, **`scripts/lib/deploy-portal-rollout.sh`**. **`DEPLOY_PORTAL_BLUEGREEN=0`** / **`deploy_common_compose_up`** for **`portal`** (**`rm -sf portal` before replacement healthy**) is **break-glass only** — same **`502`** class as legacy API (**`/`** upstream **`127.0.0.1:3000`**). Rollback: **`docs/ai-context/DEPLOYMENT_PORTAL_ROLLBACK.md`**.

## Required preflight before direct deploy

- `git push` your branch/commit to `origin` before SSH direct deploy.
- On server: `GET /ops/deploy/status` → prefer `runningCount: 0` (direct deploy refuses when a queue job is running).
- Dry-run first: `bash scripts/deploy-direct.sh api --branch main --dry-run`.
- After success: confirm `[deploy-api] done <sha>` or `[deploy-portal] done <sha>` in the log **and** `docker exec` grep for a unique line (`AGENTS.md` post-deploy verification).

## Required preflight before any enqueue (queue fallback)

- Run `GET /ops/deploy/status` — confirm `runningCount` is `0` or the
 currently-running job is expected.
- Confirm the requested branch/commit exists on `origin` (`git fetch` locally,
 or let the deploy script do it). A missing ref is rejected with a clear error.
- Prefer `"dryRun": true` first. The dry-run prints what the script would do
 without touching git, docker, prisma, or health checks.

## Required POST-deploy verification (do not skip)

A deploy job ending in `status:"success"` is **not** sufficient evidence
that your commit shipped. The shared queue clone at `/opt/connectcomms/app`
can have uncommitted hand-edits in files your branch also modifies, in
which case `deploy_common_git_sync`'s `git checkout` aborts but the rest
of the deploy script proceeds and silently builds the dirty pre-existing
working tree (confirmed 2026-05-06 against telephony job
`36b830d2-b159-4afa-a360-adab40b52db6`; see
`docs/ai-context/KNOWN_ISSUES.md` "Deploy queue silently ships stale code").
For **every** deploy that you care about:

1. Read the last line of the deploy log. It must read
 `[deploy-<service>] done <expected-sha> requested_by=...`. If the SHA does
 not match what you enqueued, your code did not ship.
2. Confirm the new code is actually inside the running container by reading
 the file from inside it:
 ```pwsh
 ssh connect "docker exec app-<service>-1 grep -n '<unique new line>' /app/<path>"
 ```
3. If either check fails, **do not retry blindly**. SSH to the server,
 capture the dirty working-tree diff (`cd /opt/connectcomms/app && git diff -- <path>`)
 to a backup file under `_latency_logs/`, then run
 `git checkout HEAD -- <path>` to restore only the file blocking the
 checkout, and re-enqueue. Do not wholesale-reset the clone — other
 unrelated hand-edits may exist there.

The full recovery workflow (commands + log signatures to look for) lives in
`docs/ai-context/DEBUGGING.md` under "Deploy queue: confirming a fix
actually shipped".

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
