# A8 — Deploy model audit: Connect (as-is) vs Loopcom Works (as-is) vs Works server plan

Read-only audit. All paths are absolute. Citations are `file:line`. Repo root for section 1
is `C:\dev\projects\Connect 2`; repo root for section 2 is `C:\dev\projects\Connect 2\Loopcom works`.

---

## 1. CONNECT DEPLOY MODEL (as it runs today, production)

### 1.1 Trigger paths

Two supported paths, documented in `AGENTS.md:143-213` and `docs/safe-deploy-queue.md`:

- **Direct deploy (preferred for `api`/`portal`)** — `scripts/deploy-direct.sh` run on the app
  host (`AGENTS.md:143-162`). Usage: `bash scripts/deploy-direct.sh api --branch main` or
  `--commit <sha>`, optional `--dry-run`. It:
  1. Sources `/opt/connectcomms/env/.env.deploy-queue` for blue/green nginx vars
     (`scripts/deploy-direct.sh:70-79`).
  2. Refuses to start if the deploy queue reports `runningCount > 0`, unless
     `--skip-queue-check` (`scripts/deploy-direct.sh:88-108`).
  3. Logs to `/var/log/connect-deploys/direct-<service>-<timestamp>.log`
     (`scripts/deploy-direct.sh:110-113`).
  4. Invokes the *same* `scripts/deploy-api.sh` / `scripts/deploy-portal.sh` the queue worker
     runs (`scripts/deploy-direct.sh:115-125`) — no separate code path.
- **Deploy queue (fallback + only path for `telephony`/`realtime`/`worker`/`full-stack`)** — a
  PM2-managed HTTP service on `127.0.0.1:3910` (`docs/safe-deploy-queue.md:1-35`).
  `POST /ops/deploy/enqueue` with `{service, branch|commitHash, requestedBy, reason, dryRun}`.
  Trusted from `127.0.0.1` and the Docker bridge subnets with no token
  (`docs/safe-deploy-queue.md:41-84`, `AGENTS.md:58-67`); from the public internet it needs
  `POST /internal/deploy/auto` with `x-internal-deploy-secret` or a `SUPER_ADMIN` JWT
  (`AGENTS.md:83-128`) — that route is nginx-blocked externally
  (`AGENTS.md:89-105`, proven by a 403 probe).
  Global serialization: one job at a time, SQLite partial-unique-index dedup per service
  (`docs/safe-deploy-queue.md:128-134`).

`AGENTS.md:168-206` forbids ad-hoc `git pull`/`docker compose up`/`pm2 restart` on the server
outside these scripts; migrations only run inside `scripts/deploy-api.sh`
(`AGENTS.md:194-196`); only the target service's container is restarted, never a blanket PM2
restart (`AGENTS.md:197-199`).

### 1.2 Blue/green — the actual zero-downtime mechanism

Both `api` and `portal` deploy blue/green by default
(`AGENTS.md:205-206`, `DEPLOY_API_BLUEGREEN=1` / `DEPLOY_PORTAL_BLUEGREEN=1` sourced from
`/opt/connectcomms/env/.env.deploy-queue`).

**Port pairs**, from `docker-compose.app.yml`:
| Service | Stable (host) | Candidate (host, profile `*_rollout`) |
|---|---|---|
| api | `127.0.0.1:3001:3001` (`docker-compose.app.yml:190-191`) | `127.0.0.1:3004:3001`, container `app-api-candidate-1` (`docker-compose.app.yml:242-250,374-375`) |
| portal | `127.0.0.1:3000:3000` (`docker-compose.app.yml:433-434`) | `127.0.0.1:3005:3000`, container `app-portal-candidate-1` (`docker-compose.app.yml:440-463`) |
| realtime | `127.0.0.1:3002:3002` (`docker-compose.app.yml:481-482`) — no blue/green |
| telephony | `127.0.0.1:3003:3003` + `4590:4590` AudioSocket ingress (`docker-compose.app.yml:540-541,619`) — no blue/green |
| worker | no published port (`docker-compose.app.yml:555-613`) — no blue/green |

**API rollout sequence** (`scripts/lib/deploy-api-rollout.sh:134-249`, called from
`scripts/deploy-api.sh:175-183`):
1. Build `api` and `api_candidate` from the same Dockerfile (`scripts/deploy-api.sh:158-163`).
2. Start `api_candidate` on `:3004` (`deploy-api-rollout.sh:168-172`).
3. Poll `http://127.0.0.1:3004/ready` up to 120×2s (`deploy-api-rollout.sh:79-118,174-182`).
4. Write the nginx upstream-active file to `server 127.0.0.1:3004;`, `nginx -t && nginx -s
   reload` (`deploy-api-rollout.sh:184-194`).
5. Optional `DEPLOY_API_PUBLIC_VERIFY_URL` curl through the real hostname
   (`deploy-api-rollout.sh:196-208`).
6. Force-recreate stable `api` on `:3001` (still not receiving traffic — nginx points at
   candidate) (`deploy-api-rollout.sh:210-214,121-124`).
7. Poll stable `/ready`, flip nginx back to `:3001`, re-verify, stop+rm the candidate
   (`deploy-api-rollout.sh:216-248`).

Portal rollout is the same shape on `:3000`/`:3005` (`scripts/deploy-portal.sh`, not fully
quoted here — same helper pattern per `AGENTS.md:206`).

Failure at any step rolls the nginx upstream file back to the port that was active before
(`deploy-api-rollout.sh:187-193,201-207,218-223`) — the **stable container on `:3001` is never
destroyed before the candidate is healthy** (`AGENTS.md:205`, this is the exact 502-class bug
the rule exists to prevent: `deploy_api_rollout_recreate_stable` uses `up -d --no-deps
--force-recreate`, never `rm -sf` first).

### 1.3 `.build-commit` verification convention

Every image's last Docker layer bakes the deployed git SHA into the image and the running
container:
- `apps/api/Dockerfile:33-35`: `ARG BUILD_COMMIT=""` → `RUN printf '%s\n' "$BUILD_COMMIT" >
  /app/.build-commit`.
- `apps/portal/Dockerfile:62,69-70`: identical pattern.
- `apps/worker/Dockerfile` has **no** `.build-commit` layer (checked — absent from the file).

`scripts/deploy-api.sh` uses this two ways:
1. **As the OLD_HEAD baseline for change-detection** when no queue state-dir marker exists —
   `docker exec app-api-1 sh -lc 'cat /app/.build-commit …'` (`deploy-api.sh:80-82`). An empty
   or missing file forces a rebuild rather than a false skip (`deploy-api.sh:96-115`, hardened
   2026-09-16 after a real "success but shipped nothing" incident).
2. **As the post-deploy verify step** — after health passes, it re-reads `.build-commit` from
   the (now-stable) container and hard-fails + rolls back if it doesn't match the target SHA
   (`deploy-api.sh:202-219`).

`AGENTS.md:236-245` documents the same check as the required manual proof for any agent: read
the deploy log's last line (`[deploy-api] done <sha> requested_by=…`) and independently
`docker exec app-<service>-1 grep -n '<unique new line>' /app/<path>` — a `status:"success"`
alone is explicitly called out as **not sufficient evidence** (`AGENTS.md:224-233`), because
the shared clone at `/opt/connectcomms/app` can carry another session's uncommitted hand-edits
that abort `git checkout` silently while the rest of the script proceeds
(`AGENTS.md:226-233`).

### 1.4 Migrations

Only the `api` deploy path ever runs `prisma migrate deploy`, and only when
`packages/db/prisma/schema.prisma` or `packages/db/prisma/migrations/**` changed between old
and new HEAD (`docs/safe-deploy-queue.md:24,153`, enforced by `deploy_common_needs_migrate` in
`scripts/deploy-api.sh:145-154`). It runs **before** the image build, against the live
production database (`DATABASE_URL` exported via `deploy_common_export_database_url`,
`scripts/deploy-api.sh:130`, `scripts/lib/deploy-common.sh:25-34`). `AGENTS.md:194-196` and
`docs/safe-deploy-queue.md` forbid running `prisma migrate` any other way in production.

### 1.5 Log locations

- Per-job deploy logs: `/var/log/connect-deploys/<job-id>.log` (queue) or
  `/var/log/connect-deploys/direct-<service>-<timestamp>.log` (direct)
  (`docs/safe-deploy-queue.md:140`, `scripts/deploy-direct.sh:110-113`). 30-day rotation,
  active/recent logs never removed (`docs/safe-deploy-queue.md:143`).
- Container logs: `docker logs --since=10m <container>` (`AGENTS.md:278`).
- Queue worker logs: `pm2 logs connect-deploy-worker` (`AGENTS.md:279`).
- A public, rate-limit-safe log viewer exists for `SUPER_ADMIN`s at
  `/admin/deploy/jobs/:id/log` — it was hardened after nginx auto-banned the office IP for
  polling an absent queued-job log 404 repeatedly
  (`docs/ai-context/claude-md-sections/2026-09-14-deploy-log-autoban.md`).

### 1.6 What "verify the running container" concretely means here

Not "the job said success." It is always the two-step `AGENTS.md:236-245` proof: (1) last log
line is `done <expected-sha>`, AND (2) `docker exec app-<service>-1 grep` for a line that only
exists in the new commit, run from the Linux sandbox over SSH per `CLAUDE.md`'s canonical SSH
method. `.build-commit` automates half of this inside `deploy-api.sh` itself
(§1.3 above) but the manual grep is still the standard for anyone reporting a fix "shipped."

### 1.7 Backups

**There is no `pg_dump`/backup script for the main platform database** (api/portal/worker/
telephony/realtime's shared Postgres). Searched `scripts/` and `docs/` repo-wide; the only
`pg_dump` usage anywhere in this repo is for a **different, separate application**:
`scripts/community/backup.sh:1-20` (Loopcom Community — see §3 below, it is the template to
copy). `AGENTS.md:257-270` and `docs/ai-context/DEPLOYMENT.md:100-104` explicitly list
destructive `pg_dump --clean` / `TRUNCATE` / `DROP` as forbidden agent actions, but nowhere
documents a *routine, non-destructive* nightly dump for the main platform DB. This is a real
gap in Connect's own operational discipline, not something to imitate for Works.

### 1.8 Monitoring / alerting that exists

- **TURN health watch** — `turnHealthWatch.ts`, texts Izzy via `AgentEscalation` (the only
  channel that reaches a phone; `ADMIN_ALERT` email is muted at the send door) on 3
  consecutive failed real STUN probes against both env and DB-configured TURN URLs; one text
  per fault + one all-clear + 10-day cert-expiry warning
  (`docs/ai-context/claude-md-sections/2026-08-21-turn-health-watch-izzy-is-texted-when-the-call-r.md`).
  Covers coturn (regular calls) only, not LiveKit (video meetings).
- **Admin alert email** — `EmailJob` rows type `ADMIN_ALERT`, tenant `connect-admin-tenant-v1`,
  sent to `tod10950@gmail.com` (`memory/connect2-ops-alerts.md:17`).
- **Support watcher / agent files** — a separate on-call-style watcher tied to the AI support
  agent, not a generic infra monitor (`memory/support-watcher.md`, out of scope for this
  audit).
- **Nginx public-verify auto-ban trap** (fixed) — nginx was auto-banning the office IP for
  polling absent queued-job logs; fixed in `docs/ai-context/claude-md-sections/2026-09-14-deploy-log-autoban.md`.
- No generic disk/mem/cpu/uptime dashboard is documented for the app host in this repo beyond
  the `/admin/storage-health` inventory panel (`docs/ai-context/DEPLOYMENT.md:150-154`, API
  container mounts host paths read-only for forensics).

### 1.9 Server sizing (for comparison only — do not reuse the box)

Measured 2026-08-23 (`docs/ai-context/claude-md-sections/2026-08-23-capacity-tuning-applied-rtp-range-widened-coturn.md`):
loopcom (app host, 45.14.194.179) is **18-core / 94 GB, hosted in France**; the PBX
(209.145.60.79, out of scope — never touched by Works) is a separate 12-core/47 GB box in
St. Louis. Postgres `max_connections` was raised 100→300 via `ALTER SYSTEM` (persists to
`postgresql.auto.conf`, never hand-edit that file). pgbouncer is **not** installed on Connect.

### 1.10 The reserved-ports gotcha (blue/green candidate port collision)

On 2026-08-23 the platform's perf tuning set `net.ipv4.ip_local_port_range = 1024 65000`
system-wide with nothing reserved. On 2026-09-17 this let the kernel hand an *outbound*
ephemeral connection (an nginx→telephony keepalive) the source port `3004` — the exact host
port the `api_candidate` blue/green container needs to bind — and two consecutive
`deploy-direct.sh api` runs died at the `candidate_start` step with `failed to bind host port
127.0.0.1:3004/tcp: address already in use`, while the live stable `api` on `:3001` was
untouched (`docs/ai-context/claude-md-sections/2026-09-17-pay-line-final-flow.md:54-58`, full
detail in memory `blue-green-deploy-ports-must-be-reserved.md`). Fixed at the root with
`net.ipv4.ip_local_reserved_ports=3000-3010` (runtime + `/etc/sysctl.d/zz-connectcomms-reserved-ports.conf`)
so those ports are never auto-assigned to an ephemeral outbound connection.
**Anyone building a similar blue/green port-pair scheme on the Works box must reserve its
candidate ports the same way up front**, or expect the identical failure mode once the box
carries meaningful outbound traffic volume.

---

## 2. LOOPCOM WORKS — AS-IS DEPLOY (current production, Contabo VPS, PM2)

Repo root: `C:\dev\projects\Connect 2\Loopcom works`. Current production server: `154.12.235.86`
(per `bootstrap-server.sh:5`, `deploy.sh:9,55`, `git-deploy-setup.md:17,40,128`,
`docs/JUPITER_RESTORE.md:459`), app directory **`/root/apps/trimpro`** (running as `root`, not
the `deploy` user `bootstrap-server.sh` provisions — see §2.6).

### 2.1 The deploy script and its dangerous line

`deploy-from-git.sh:1-120` is the script actually used for regular deploys (confirmed by
`DEPLOY.md:29-43` and `git-deploy-setup.md:11-25`). Sequence:
1. `git fetch origin && git checkout "$BRANCH" && git pull` in place — **no separate
   clone/build directory, no atomic swap** (`deploy-from-git.sh:29-35`).
2. `npm install --legacy-peer-deps --production=false` (`deploy-from-git.sh:43`).
3. `npx prisma generate` (`deploy-from-git.sh:47`).
4. Permission-catalog sync scripts, tolerated on failure with a warning
   (`deploy-from-git.sh:51-52`).
5. **`npx prisma db push --skip-generate --accept-data-loss`** (`deploy-from-git.sh:56`) — the
   line named in the task brief. `db push` diffs the *live* database directly against
   `prisma/schema.prisma` and applies whatever DDL is needed to match, including drops, with
   **no migration history, no review step, and `--accept-data-loss` pre-authorizing column
   drops/type-narrowing**. Failure here is caught and only logged as a warning
   (`deploy-from-git.sh:57-58`) — the deploy **continues** to build and restart on a
   possibly-unsynced schema.
6. `next build`, tolerated even on nonzero exit as long as `.next/BUILD_ID` exists
   (`deploy-from-git.sh:64-79`) — a "build failed but let's ship anyway if it looks usable"
   policy.
7. `pm2 stop/delete` then `pm2 start ecosystem.config.js` (`deploy-from-git.sh:86-97`) — this
   is a **hard stop-then-start**, not blue/green: the app is fully down for the install+
   build+restart window (build alone can be minutes; nothing serves `:3000` during rebuild
   since `next build` and `next start` are the same directory/process).
8. `pm2 save` (`deploy-from-git.sh:101`).

Two near-duplicate scripts exist with the same `db push --accept-data-loss` pattern:
`deploy-production.sh:32` and the manual recipe in `git-deploy-setup.md:57-58,218`. A fourth,
`deploy.sh:1-82`, is for a *different* generic app pattern (uses `pnpm`, a different app dir
`/home/deploy/apps/$APP_NAME`, and regenerates the nginx site from a template) — it does not
match how `trimpro` is actually deployed and looks like leftover boilerplate, not the live
path.

### 2.2 Process manager: `ecosystem.config.js`

Single PM2 app, `fork` mode, **`instances: 1`** (`ecosystem.config.js:38-39`) — no clustering,
no zero-downtime `pm2 reload`. `.env` is parsed by hand (custom `loadEnvFile`, handles quoted
values) rather than via `dotenv`, specifically because bash `source` breaks on `KEY= value`
lines (`ecosystem.config.js:1-23`, `deploy-from-git.sh:63`). `max_memory_restart: '1G'`; logs
to `./logs/err.log` / `./logs/out.log` inside the app directory (`ecosystem.config.js:41-45`) —
not `/var/log`, not rotated by anything in this repo.

### 2.3 Migration state — the real finding

`prisma/migrations/` **does exist and is populated**: 25 migration folders +
`migration_lock.toml` (provider `postgresql`), oldest `0001_optional_items_and_desc_visibility`,
newest `0023_request_estimate_created_status` (dated by content, not filesystem copy-time).
So this is not a pure `db push`-only schema — it started life migration-managed.

**But it has drifted badly out of sync with the live-deployed schema**, because every real
production deploy runs `db push --accept-data-loss` (§2.1) instead of `migrate deploy`:
- `git log -1 --format=%ad -- prisma/migrations/` → **2026-04-21** (last migration folder ever
  committed).
- `git log -1 --format=%ad -- prisma/schema.prisma` → **2026-09-15** (schema.prisma has kept
  changing for ~5 months since).
- Concretely: `Invoice.originalTotalAtConversion` (`prisma/schema.prisma:819`,
  `Decimal? @db.Decimal(10, 2)`) exists in the schema and — because `db push` is what actually
  ran in production — presumably exists in the live database, but **there is no migration file
  anywhere under `prisma/migrations/` that adds it** (grepped the whole directory).
- `BrandingSettings` (`prisma/schema.prisma:3296`) and `MeasuringRequest`
  (`prisma/schema.prisma:3370`) *do* have migrations
  (`0011_branding_settings_and_invoice_render_snapshot`, `0012_measuring_requests`), so the
  drift is not "nothing since migration 12" — it is specifically **everything schema-shaped
  that happened after 0023 (Apr 21) through today (Sep 15+), which is a large and unknown set**.

**Consequence for a fresh Works server:** running `prisma migrate deploy` against an empty
database would apply only the 25 recorded migrations and land on a schema **older** than what
`schema.prisma` — and the live production database — actually have. It will not match. A naive
`migrate deploy` is not sufter-safe here; it needs the baseline procedure in §3.5.

`docs/JUPITER_RESTORE.md:283-333` (an existing, separate "restore manifest" doc in this repo,
last touched 2026-03-13) independently documents the same `db push` policy as intentional
("Schema sync (non-destructive) … Safe for the Jupiter state") and lists `prisma migrate dev`
as the alternative "with history" path — i.e. the team's own documentation already treats
`db push` as the normal production path, migrations as optional. Postgres requirement stated
there: **14+**.

### 2.4 Redis — optional in code, "required" per the team's own docs (contradiction)

`lib/redis.ts:1-14` connects unconditionally at module load (`redis.connect().catch(console.error)`)
and exports `setCache`/`getCache`/`deleteCache` helpers — **but nothing in `app/`, `lib/`, or
`components/` ever imports `lib/redis`** (grepped `lib/redis` repo-wide: only self-references
inside the file itself). This module is dead code.

The real Redis consumer is `lib/dispatch-realtime.ts:1-200` (pub/sub fanout + a replay buffer
for the dispatch/job-activity real-time feed). It is **deliberately optional and
degrades gracefully**: `ensureRedisClients()` returns `false` on any connect failure
(`lib/dispatch-realtime.ts:39-54`) and every caller falls back to same-process, in-memory
`Map`-based fanout (`fanoutLocal`, `lib/dispatch-realtime.ts:56-66`) with Redis publish/replay
wrapped in try/catch that only logs (`lib/dispatch-realtime.ts:93-140`). On a single PM2 `fork`
instance (today's reality, §2.2) Redis buys **cross-process fanout for multiple instances and
a replay buffer for reconnecting clients** — neither is load-bearing for a single-instance
deploy, but losing it silently degrades real-time UX with no operator-visible signal (health
route does not check Redis — see §2.5).

`docs/JUPITER_RESTORE.md:182-188,335-349` and `git-deploy-setup.md:166` both call Redis
**"required for real-time dispatch"** — this contradicts the actual fallback code. Treat Redis
as **should-have, not must-have** for correctness on Works, but document it clearly either way
so the two sources stop disagreeing.

`socket.io`/`socket.io-client` are listed as dependencies (`package.json:73-74`) but **no
server.js/custom server exists at the repo root and no code anywhere references
`socket.io`/`res.socket.server`** (grepped `**/*.{ts,tsx,js}` repo-wide) — this is an unused
dependency; real-time is done via the Redis-backed fanout above plus (per file naming)
Server-Sent Events (`app/api/dispatch/stream/route.ts` exists per the earlier `setInterval`
grep hit list). No custom Node server is needed for Works; `next start` (via PM2) is sufficient
and is what's actually running (`package.json:31` `"start": "next start -H 0.0.0.0 -p 3000"`).

### 2.5 Health check

`app/api/health/route.ts:1-27` — checks Postgres only (`SELECT 1` via Prisma), returns
`{ok, db, time, durationMs}`. Does **not** check Redis, disk space, or puppeteer/Chrome
availability. `docs/JUPITER_RESTORE.md:240-243` documents `curl http://154.12.235.86:3000/api/health`
as the monitoring check today — there is no automated poller of it in this repo; it's a manual
curl.

### 2.6 PDF generation — puppeteer/Chrome is a real, undocumented-in-bootstrap production dependency

`lib/pdf/render-html-to-pdf.ts:1-57` launches a real Chromium via `puppeteer.launch()` with
`--no-sandbox --disable-setuid-sandbox` (required on most Linux VPS hosts without a configured
sandbox). Chrome executable path resolves via `PUPPETEER_EXECUTABLE_PATH` env override, else
`puppeteer.executablePath()` (`render-html-to-pdf.ts:17-29`). **`bootstrap-server.sh` installs
none of the system libraries Chromium headless needs** (no `libnss3`, `libatk1.0-0`,
`libgbm1`, fonts, etc. — standard Debian/Ubuntu headless-Chrome dependency list). This is a
real gap between the documented bootstrap and what production actually requires; puppeteer's
own `npm install` postinstall downloads a Chromium binary, but the shared libraries it links
against are an OS-level package requirement that isn't in any setup script here.

### 2.7 File storage — hardcoded path inside the deploy-replaced directory

Uploads are served and stored at a **hardcoded, non-configurable path**:
`app/uploads/[...path]/route.ts:68` — `path.join(process.cwd(), 'public', 'uploads', ...segments)`.
No env var controls this (unlike Connect's `*_STORAGE_DIR` pattern — see §3.7). Nginx also
serves it directly: `scripts/nginx-trimpro.conf:9-13,39-43` — `alias
/root/apps/trimpro/public/uploads` — confirming the real path matches `process.cwd()` when PM2
runs from `/root/apps/trimpro`. `docs/JUPITER_RESTORE.md:351-366` flags the same path as a
"files not fully in git" concern and even documents a `chmod o+x /root` workaround so nginx
can traverse into it — i.e. the app runs as `root` and serves user uploads out of `/root`,
which is itself worth flagging as a hardening gap.

**Today** this is survivable because `deploy-from-git.sh` does an in-place `git pull` (§2.1) —
the `public/uploads/` directory is never deleted by a normal deploy. It becomes a real hazard
the moment anyone moves this to a fresh-clone-per-deploy or containerized model (exactly what
§3 proposes) without first relocating uploads to a persistent volume/bind mount outside the
image — this is precisely the class of bug Connect hit and fixed for onboarding uploads,
avatars, and voicemail audio (`docker-compose.app.yml` comments throughout, e.g.
`docker-compose.app.yml:104-110`).

### 2.8 Cron / scheduled jobs — none are self-scheduling; all rely on an external trigger that is only partially wired up

Grepped for `node-cron`, `CronJob`, `setInterval` used as a scheduler — **none found** in
`app/`. Instead:
- `app/api/issues/reminders/route.ts:1-24`, `app/api/measuring-requests/reminders/route.ts`,
  `app/api/tasks/reminders/route.ts` — each is an HTTP `POST` route, dual-gated by either a
  `CRON_SECRET` header (`x-cron-secret`/`x-reminder-secret`) or normal user auth+permission
  (`app/api/issues/reminders/route.ts:9-23`). They do nothing unless something calls them.
- **`scripts/setup-reminder-cron.sh:1-19`** is the actual trigger mechanism used in production:
  it installs three lines into **root's system crontab** on the app server itself, each a
  `curl -fsS -X POST -H "x-cron-secret: …"` against the **public HTTPS domain**
  (`https://app.trimprony.com/...`, hardcoded, not parameterized) on schedules `0 8-19/4 * * *`
  (tasks), `0 */2 * * *` (issues), `0 */2 * * *` (measuring requests). `CRON_SECRET` is read
  from `.env` or auto-generated and appended to it (`setup-reminder-cron.sh:6-10`).
- **`app/api/qbo/worker/route.ts`** follows the same `CRON_SECRET`-gated HTTP pattern
  (`process.env.CRON_SECRET` referenced at line 21) but **`setup-reminder-cron.sh` does not
  install a crontab entry for it** — grepped the whole repo for any reference to
  `run-qbo-sync-worker` or a QBO cron line; none exists outside the two files themselves.
- **`scripts/run-qbo-sync-worker.ts:1-17`** is a second, independent way to run the same QBO
  sync (`runQboSyncWorker` from `lib/qbo/sync-queue`, invoked directly rather than over HTTP) —
  it is a plain Node script meant to be run by an external scheduler, but **nothing in this
  repo (crontab script, ecosystem.config.js, systemd unit) ever schedules it.** It is either
  orphaned or its scheduling is undocumented/manual today.

**Answer to "how are these triggered today": a root crontab on the production box, installed
once by hand via `scripts/setup-reminder-cron.sh`, curling the app's own public URL over the
internet with a shared secret header — not PM2 cron, not a systemd timer, not anything in the
deploy scripts themselves.** This crontab is server state, not repo state — it will not exist
on a fresh Works box until someone re-runs that script (or its systemd-timer equivalent, see
§3.9) there.

### 2.9 Runtime / package manager inconsistencies (worth flagging, not fixing here)

- `docs/JUPITER_RESTORE.md:30-45` pins production Node to **v18.20.8 LTS**; `package.json` has
  no `engines` field to enforce this.
- Package manager is inconsistent across the repo's own scripts: `deploy-from-git.sh`,
  `deploy-production.sh`, and `git-deploy-setup.md` all use **npm** (`npm install`,
  `package-lock.json` per `docs/JUPITER_RESTORE.md:52-58`), while `deploy.sh:33,37,46` uses
  **pnpm** throughout for the same app. `deploy.sh` also targets a different app directory
  convention (`/home/deploy/apps/$APP_NAME`) and regenerates nginx from a template — it does
  not match how `trimpro` is actually run today and should not be treated as authoritative.
- `next.config.js:12-17` re-declares `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
  `JWT_REFRESH_SECRET` under Next.js's `env:` key. Next.js's `env:` config performs a
  build-time string substitution (webpack `DefinePlugin`-style) for any `process.env.X`
  reference matching those names, in **both server and client** bundles — it is unnecessary
  (Next already loads `.env`/`.env.production` into `process.env` for server code without this)
  and is the kind of pattern that silently bakes a secret into a client bundle if any
  client-component ever references one of those four names. Grepped for client-side
  references to these four names — none found today — but this is worth removing rather than
  carrying forward onto the new server, since it has no correctness benefit and a latent risk.

### 2.10 Server provisioning as documented (`bootstrap-server.sh`) vs. as actually run

`bootstrap-server.sh:1-203` (written for a *different*, now-unused IP, `154.12.235.86` per its
own header comment — actually it's the same IP as current prod, but the script provisions a
**`deploy` user** with sudo, `/home/deploy/apps/...`) — while the real production app runs as
**`root`** out of `/root/apps/trimpro` (`git-deploy-setup.md:17-24,40-43`,
`scripts/nginx-trimpro.conf:10,40`, `docs/JUPITER_RESTORE.md:376,459`). The bootstrap script's
own hardening (non-root deploy user, `PermitRootLogin prohibit-password`) does not reflect
what is actually deployed. Additional bootstrap gaps for a "production-grade" bar: SSH
password auth is deliberately left **on** (`bootstrap-server.sh:76-81`, "Keeping Password Auth
Enabled"); UFW allows OpenSSH (22) from **anywhere**, not admin IPs only
(`bootstrap-server.sh:180-183`); fail2ban is installed but not configured beyond defaults
(`bootstrap-server.sh:186-191`); no automatic security-update-only unattended-upgrades
scoping is shown beyond installing the package.

---

## 3. WORKS SERVER PLAN — design for `works.loopcom.net` (new, separate box)

No code produced here per the task's read-only scope; this is the shape to hand the
lead engineer, built by pattern-matching what already works in this repo rather than
inventing something new.

### 3.1 The closest existing precedent is already in this repo — copy its shape, not Connect's

Connect's own blue/green platform (`docker-compose.app.yml`) is the wrong model to copy
wholesale: it's built for **6 interdependent services sharing one box** with a purpose-built
nginx blue/green harness. Works is a single Next.js app + Postgres + optional Redis — this
repo already has a **directly analogous, smaller, proven pattern** for exactly that shape:
**Loopcom Community** (`infra/community/docker-compose.yml`, `infra/community/nginx.conf.example`,
`docs/community/RUNBOOKS.md`, `scripts/community/backup.sh`, `scripts/community/restore-drill.sh`).
It runs on its **own, separate server** (never the Connect box, by explicit design comment:
`infra/community/docker-compose.yml:1`), which is exactly Works' situation. Recommend using it
as the literal starting template, adapted:

- `postgres:16` official image, `pg_isready` healthcheck, named volume
  (`infra/community/docker-compose.yml:6-19`).
- `redis:7-alpine`, `--appendonly yes` for durability, named volume
  (`infra/community/docker-compose.yml:20-25`).
- App container(s) built from the repo's own Dockerfile via `context: ../..`, health-gated
  `depends_on: condition: service_healthy`, published only to `127.0.0.1:<port>`
  (`infra/community/docker-compose.yml:26-64`).
- Nginx terminates TLS, reverse-proxies to `127.0.0.1:<port>`, `proxy_buffering off` +
  long `proxy_read_timeout` on any SSE path (`infra/community/nginx.conf.example:1-22`) —
  directly relevant to Works' `app/api/dispatch/stream/route.ts` SSE endpoint.
- **Migrations run as the container's own start command**, before the server boots:
  `apps/community-api/Dockerfile` CMD is `npx prisma migrate deploy --schema prisma/schema.prisma
  && node dist/server.js`. This is the exact discipline Works needs and currently lacks
  (§2.1/§2.3) — swap `db push --accept-data-loss` for `migrate deploy` baked into the
  container start.
- Deploy/rollback recipe is a single `docker compose … up -d --build` plus health curl;
  rollback is `git checkout <previous tag>` + rebuild — deliberately simpler than Connect's
  blue/green because Community accepts brief downtime rather than needing zero-downtime
  (`docs/community/RUNBOOKS.md:5-16`). **This tradeoff — accept a short restart window instead
  of building full blue/green — is the right default for Works too**, given it's a single
  fork-mode Next app with one Postgres, not 6 coupled services; blue/green adds real
  operational surface (nginx upstream files, candidate ports, the reserved-ports trap in
  §1.10) that isn't justified unless Works needs true zero-downtime deploys.
- Backups: `scripts/community/backup.sh:1-20` — `pg_dump --format=custom`, `pg_restore --list`
  self-check, optional GPG AES-256 encryption, sha256 sidecar, 30-day retention by `mtime`.
  **This script is directly reusable for Works with only the env var names changed**
  (`COMMUNITY_DATABASE_URL`→`WORKS_DATABASE_URL` etc.).
- **Restore drill**: `scripts/community/restore-drill.sh:1-30` — restores the newest backup
  into a scratch database, runs integrity `SELECT`s (migration count, orphan-row checks), drops
  the scratch DB, prints `"restore drill OK"`. `docs/community/RUNBOOKS.md:29-35` runs this
  weekly via cron alongside the nightly backup. **This is the concrete answer to "nightly
  pg_dump + off-box copy + restore drill"** — copy the pattern, adapt the integrity queries to
  Works' schema (e.g. orphan `InvoiceLineItem`s, double-`ACCEPTED` estimates analogous to the
  community script's double-accepted-quote check).

### 3.2 Proposed service list (Docker Compose on the new box)

| Service | Image/build | Notes |
|---|---|---|
| `postgres` | `postgres:16` | Own volume; `max_connections` sized to expected load (start at default 100 — Works is a single small tenant, nowhere near Connect's 300-connection tuning) |
| `redis` | `redis:7-alpine`, `--appendonly yes` | Optional per §2.4, but cheap to run; gives cross-instance fanout headroom if `instances` is ever raised above 1 |
| `works` (Next.js app) | own Dockerfile, multi-stage like `apps/portal/Dockerfile` (deps → build → slim runner) | `next start` under Node in the container; no custom server needed (§2.4) |
| `works_candidate` | same image, `profiles: [rollout]` | **Only if** blue/green is wanted later; start without it (§3.1) |
| `nginx` + certbot | host-level nginx (not containerized, matching both Connect's and Community's pattern) or a `certbot`/`nginx` sidecar container | See §4 for cert issuance |
| `pg_backup` | a `postgres:16`-based sidecar or a host cron running `scripts/community/backup.sh`'s adapted twin | Nightly dump + off-box copy (rsync/S3/Backblaze — pick one, not specified in-repo) |
| cron/worker runner | host `systemd` timers (preferred over a root crontab, see §3.9) or a lightweight `node-cron` process **inside** the app container | Replaces the manual `scripts/setup-reminder-cron.sh` root-crontab approach |

All container ports bind to `127.0.0.1:<port>` only, never `0.0.0.0` — matching every service
in `docker-compose.app.yml` (e.g. `docker-compose.app.yml:190-191,374-375`) and
`infra/community/docker-compose.yml:59,79`. Only nginx (80/443) is exposed externally.

### 3.3 Firewall

`ufw`: allow 22 (restrict to admin IPs/VPN if available — Connect's own bootstrap script for
Works left SSH open to the world on port 22, `bootstrap-server.sh:180-183`; tighten this on the
new box), 80/tcp, 443/tcp; default deny incoming, default allow outgoing — same shape as
`bootstrap-server.sh:177-183` minus the world-open SSH. Disable password auth once key-based
SSH is confirmed working (bootstrap-server.sh left it on deliberately — `bootstrap-server.sh:76-82`
— tighten this for the new box since there is no longer a "test key auth first" bootstrapping
reason to keep it open). Docker's own `iptables`/`DOCKER-USER` interaction should be reviewed
so published container ports don't bypass ufw the way Connect flags for its AudioSocket port
(`docker-compose.app.yml:614-618` comment) — bind everything to `127.0.0.1` as above and this
is moot.

### 3.4 `.build-commit` + health verification, adapted from Connect

Bake `ARG BUILD_COMMIT` into the Works image's last layer exactly like
`apps/portal/Dockerfile:62,69-70` / `apps/api/Dockerfile:33-35` (`LABEL
org.opencontainers.image.revision=$BUILD_COMMIT` + `/app/.build-commit`). Deploy script
verification recipe, adapted from `scripts/deploy-api.sh:187-219`:
1. `docker compose build --build-arg BUILD_COMMIT=$(git rev-parse HEAD) works`.
2. `docker compose up -d works` (or the candidate/cutover dance if blue/green is adopted later).
3. Poll `GET /api/health` (already exists, `app/api/health/route.ts`) until `{"ok":true}`
   — this is Works' equivalent of Connect's `/ready`; **recommend adding a dedicated `/ready`
   endpoint that returns before heavy DB work**, mirroring the api/portal split Connect uses
   (`/health` = deep check, `/ready` = fast liveness for the rollout gate) so a slow DB query
   doesn't false-negative a healthy deploy the way a single combined endpoint could.
4. `docker exec works sh -lc 'cat /app/.build-commit'` and assert it equals the target SHA;
   fail the deploy (and roll back) on mismatch, exactly as `deploy-api.sh:209-218` does.

### 3.5 Migrations — the baseline procedure for a `db push`-managed schema

Given §2.3's finding (23-migration history, 5 months stale, live schema advanced past it via
`db push`), a fresh Works server **cannot** just run `prisma migrate deploy` against migration
folder `0001`–`0023` and expect a correct schema — it would under-shoot the real schema.
Standard Prisma procedure to re-baseline safely (design only, per the task's no-code
instruction — this is the sequence to hand the engineer, not a script to run blind):

1. On a copy of the **current production database** (never the primary), run
   `prisma migrate diff --from-migrations prisma/migrations --to-schema-datasource
   prisma/schema.prisma --script > baseline.sql` to see exactly what the 23 recorded
   migrations are missing versus the live-shaped schema.
2. Generate one new migration folder that captures that entire delta
   (`prisma migrate dev --create-only --name baseline_catch_up_<date>`), review the generated
   SQL by hand for anything destructive `db push --accept-data-loss` might have silently done
   (dropped columns that got re-added differently, type narrowing, etc. — this is exactly the
   kind of drift `db push` obscures because it never recorded intent, only end-state).
3. Mark that migration (and, if starting a truly fresh migration history, all prior ones) as
   already-applied against the **live production database** with
   `prisma migrate resolve --applied <migration-name>` — never run it there; it only needs to
   run against a *fresh* Works database, since the live DB already has the shape it describes.
4. From this point forward, the container's start command runs `prisma migrate deploy` (like
   `apps/community-api/Dockerfile`'s CMD) and the deploy script **stops running `db push`
   entirely** — every future schema change must ship as a proper migration file, checked into
   the repo, the same discipline `AGENTS.md:194-196` already enforces for Connect's `api`.
5. For the *new* Works server specifically: since it starts from an actual `pg_dump` restore of
   production (not an empty DB — see §3.6), step 3's `migrate resolve --applied` is what makes
   `prisma migrate deploy` a no-op on first boot there too, rather than trying (and failing) to
   replay 23 stale migrations against an already-current schema.

### 3.6 Initial data move + file storage + backup

- Seed the new Postgres from a `pg_dump` of the current production `trimpro` database (taken
  with the same `--format=custom --no-owner --no-privileges` flags as
  `scripts/community/backup.sh:12`), restored with `pg_restore` on the new box, **then** run
  the baseline procedure above so `migrate deploy` treats it as current.
- Move `public/uploads/` (§2.7) onto a **named Docker volume mounted outside the app's own
  image**, exactly like Connect's `onboarding-files`/`voicemail-audio`/`user-avatars` pattern
  (`docker-compose.app.yml:104-135`) — do this **before** any container-based deploy replaces
  the app directory, or the first rebuild silently orphans every existing customer upload, the
  same class of bug Connect hit in 2026-08-05/08-09 (referenced in those volumes' own
  comments). Either keep serving `/uploads/*` from within the Next.js app reading from the
  mounted volume (current code path, `app/uploads/[...path]/route.ts:68`, just repoint
  `process.cwd()`-relative to an env-configured root) or let nginx serve the volume directly
  the way `scripts/nginx-trimpro.conf:9-13,39-43` already does — recommend doing both stay
  consistent, i.e. introduce an env var (e.g. `UPLOADS_STORAGE_DIR`) the route reads instead of
  a hardcoded `process.cwd()` join, matching Connect's `*_STORAGE_DIR` convention throughout
  `docker-compose.app.yml`.
- Nightly `pg_dump` (adapted `scripts/community/backup.sh`) to local disk, then an off-box copy
  (rsync to another host, or an S3-compatible bucket — nothing in this repo specifies which;
  it's an open choice for the engineer) — plus the weekly restore drill
  (`scripts/community/restore-drill.sh` adapted), both installed as `systemd` timers rather
  than a bare root crontab (see §3.9).
- Puppeteer/Chrome (§2.6): if containerizing, either install the standard headless-Chrome
  Debian dependency set in the app image's Dockerfile stage (mirroring
  `apps/api/Dockerfile:7` which already installs `openssl ffmpeg curl` at the OS layer for its
  own needs) or switch to `puppeteer-core` + a pinned `@sparticuz/chromium`-style bundled
  binary built for containers — either is fine, but it must be a deliberate Dockerfile line,
  not left to `npm install`'s postinstall download succeeding by luck in a minimal base image.

### 3.7 Env vars the Works app reads (names only — grepped `process.env.[A-Z0-9_]+` across
`app/`, `lib/`, `components/`, `scripts/`, `middleware.ts`; 74 distinct names)

```
ADMIN_CC_EMAIL, ALLOW_ENV_KEY_ROTATION, APP_URL, AWS_SES_REGION,
CANONICAL_PUBLIC_APP_URL, CARDKNOX_API_BASE_URL, CARDKNOX_HOSTED_FORM_URL,
CRON_SECRET, DATABASE_URL, DEFAULT_TENANT_ID, DISPATCH_REPLAY_MAX,
EMAIL_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME, EMAIL_PROVIDER, EMAIL_REPLY_TO,
ENCRYPTION_KEY, EXPO_ANDROID_APK_URL, FROM_EMAIL, FROM_NAME,
GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_SERVER_API_KEY, INTERNAL_APP_URL,
JWT_REFRESH_SECRET, JWT_SECRET, MAILGUN_API_KEY, MAILGUN_DOMAIN,
NEXTAUTH_SECRET, NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
NEXT_PUBLIC_PDF_LOGO_URL, NEXT_PUBLIC_RECAPTCHA_SITE_KEY, NODE_ENV,
PAYMENT_NOTIFICATION_TARGET_EMAILS, PAYMENT_NOTIFICATION_TARGET_USER_IDS,
PDF_ACCENT_COLOR, PDF_LOGO_URL, PROOF_BASE_URL, PUBLIC_APPROVAL_BASE_URL,
PUBLIC_APP_URL, PUBLIC_BASE_URL, PUPPETEER_EXECUTABLE_PATH,
QBO_ACH_RECONCILE_SECRET, QBO_BASE_URL, QBO_CLIENT_ID, QBO_CLIENT_SECRET,
QBO_ENV, QBO_LOG_INTUIT_TID, QBO_METERING_MODE, QBO_REDIRECT_URI,
QBO_SYNC_WORKER_LIMIT, QBO_WEBHOOK_VERIFIER_TOKEN, QUICKBOOKS_ACH_ENABLED,
RECAPTCHA_MIN_SCORE, RECAPTCHA_SECRET_KEY, RECAPTCHA_SITE_KEY, REDIS_URL,
REQUEST_NOTIFICATION_TARGET_EMAILS, REQUEST_NOTIFICATION_TARGET_USER_IDS,
RESEND_API_KEY, SENDGRID_API_KEY, SMOKE_BASE_URL, SOLA_API_BASE_URL,
SOLA_API_KEY, SOLA_API_SECRET, SOLA_API_URL, TOKEN_ENC_KEY,
TRIMPRO_FIELD_APK_URL, VOIPMS_API_PASSWORD, VOIPMS_API_USERNAME, VOIPMS_DID,
WEBWHATIS_API_BASE, WEBWHATIS_API_KEY, WHATSAPP_VERIFY_TOKEN
```

Cross-checked against `docs/JUPITER_RESTORE.md:157-282`, which independently documents the
same core set (DATABASE_URL, JWT_SECRET/JWT_REFRESH_SECRET, ENCRYPTION_KEY, the four
`*APP_URL` variants, REDIS_URL, reCAPTCHA, email, Cardknox/Sola, QBO, Google Maps, VoIP.ms,
WhatsApp, CRON_SECRET, mobile APK links) and additionally notes Cardknox/QBO credentials are
primarily stored **in the database** via an Integrations settings page, with the env vars only
as fallbacks (`docs/JUPITER_RESTORE.md:211-238`) — worth confirming with the engineer before
assuming every name above needs a real value on day one; several are optional fallbacks.

### 3.8 Rollback recipe

Adapted from Connect's per-service rollback (`scripts/deploy-api.sh:132-141` pattern) and
Community's documented one (`docs/community/RUNBOOKS.md:13-14`):
1. `git checkout <previous-good-sha-or-tag>` in the deploy clone.
2. `docker compose build --build-arg BUILD_COMMIT=<sha> works`.
3. `docker compose up -d --no-deps --force-recreate works`.
4. Wait for `/api/health` (or the recommended `/ready`) to pass; verify `.build-commit` inside
   the container matches `<sha>`.
5. **Database rollback is the harder half** — since step 3.5 moves Works onto real migrations,
   a bad migration's rollback is a **restore from the most recent pre-deploy `pg_dump`**
   (Community's documented policy is the same: "no down-migrations are needed [because we]
   never write destructive ones," `docs/community/RUNBOOKS.md:13`) rather than attempting a
   down-migration. Recommend the same discipline for Works: additive migrations only in normal
   operation; a destructive one is a deliberate, reviewed, backed-up-first exception.

### 3.9 Cron/reminders/QBO worker on the new box

Replace the root-crontab-curling-a-public-URL pattern (§2.8) with either:
- **`systemd` timers** calling the routes over `127.0.0.1` (not the public hostname — avoids
  the unnecessary public round-trip and TLS/DNS dependency the current
  `scripts/setup-reminder-cron.sh:14-16` has), reusing the same `CRON_SECRET` header gate
  already built into the routes, or
- A small in-process scheduler (e.g. wiring `scripts/run-qbo-sync-worker.ts`'s logic and the
  three reminder handlers into a `node-cron` loop started alongside the Next server) — more
  self-contained, one less moving part on the host, but couples scheduling to the app
  process's uptime (a restart briefly pauses cron, same tradeoff PM2's single-instance model
  already has today).

Either way, **this is currently undocumented server state that must be explicitly re-created**
on the new box — it will not "come along" with a git clone or a docker build.

### 3.10 What can be copied verbatim vs. must be adapted

**Copy near-verbatim:**
- `scripts/community/backup.sh` and `scripts/community/restore-drill.sh` (rename env vars).
- `infra/community/docker-compose.yml` and `infra/community/nginx.conf.example` as the
  starting skeleton (service shapes, healthchecks, `127.0.0.1`-only publishing, SSE-friendly
  nginx directives).
- The `.build-commit` Docker layer pattern from `apps/portal/Dockerfile:62,69-70`.
- The verify-after-deploy discipline (`AGENTS.md:224-255`) — read the deploy log's last line
  AND independently grep the running container, never trust `status:"success"` alone.

**Must be adapted, not copied:**
- Connect's blue/green harness (`scripts/lib/deploy-api-rollout.sh`) — real value only if
  Works needs zero-downtime deploys; start without it per §3.1, add later if justified.
- Connect's deploy queue (PM2 HTTP service, SQLite job table) — overkill for a single app on
  a single box with (presumably) one operator; a plain deploy script run by hand or via a
  simple CI job is proportionate, matching Community's simpler model.
- The reserved-ports fix (§1.10) only applies **if** Works adopts a fixed-port blue/green
  scheme later; not needed for the simple up-and-restart model.
- Connect's `*_STORAGE_DIR` env-var-per-asset-class convention — Works only has one upload
  surface today (`public/uploads/`), so a single `UPLOADS_STORAGE_DIR` env var is enough; no
  need to replicate Connect's dozen-plus separate storage dirs.

---

## 4. DNS / TLS

**How `app.connectcomunications.com` / `app.loopcom.net` get their certificates today:**
Let's Encrypt via **certbot running directly on the origin server** (loopcom,
45.14.194.179) — **not** Cloudflare-issued/terminated TLS. Evidence:
- `memory/connect-tls-cert-autorenew.md` (folded into `connect2-ops-alerts.md:26-49`):
  documents a real incident where the cert for `app.connectcomunications.com` expired because
  it bundled a second, DNS-dead hostname (`www.app.connectcomunications.com`) that broke
  Let's Encrypt's multi-domain validation; fixed with
  `certbot certonly --nginx --cert-name app.connectcomunications.com -d
  app.connectcomunications.com --non-interactive` + `systemctl reload nginx`
  (`connect2-ops-alerts.md:38-41`). New expiry tracked as 2026-10-22, auto-renew expected to
  work now that the dead domain is gone.
- `docs/ai-context/claude-md-sections/2026-08-17-cloudflare-phase-c-staging-is-complete-and-app-i.md`
  independently confirms, read back from the Cloudflare API and `dig @1.1.1.1`, that
  **`app.` is DNS-only (grey cloud) in Cloudflare, not proxied** — Cloudflare's edge is not in
  the TLS path for `app.*` at all; only `portal.` (an unrelated third-party CNAME) is proxied.
  The doc also notes Cloudflare's Universal SSL already covers `*.connectcomunications.com`
  automatically the moment any hostname *is* proxied, but that's not in use for `app.` today.
- The Works nginx config already follows the identical pattern for its own domain:
  `scripts/nginx-trimpro.conf:27-31` — `listen 443 ssl; # managed by Certbot`,
  `ssl_certificate /etc/letsencrypt/live/app.trimprony.com/fullchain.pem; # managed by
  Certbot`, with the standard certbot-managed HTTP→HTTPS redirect block
  (`scripts/nginx-trimpro.conf:34-48`).

**So `works.loopcom.net` should follow the exact same path already proven twice in this
ecosystem:** point a plain **A record** (DNS-only, not Cloudflare-proxied — keep it consistent
with how `app.*` is run, and simpler: an un-proxied record needs no WAF/skip-rule work at all)
at the new box's public IP, install nginx + certbot on that box, then
`certbot --nginx -d works.loopcom.net --non-interactive` (or `certonly --nginx` if the nginx
plugin isn't wanted) the same way `connect2-ops-alerts.md:38-39` shows for `app.connectcomunications.com`.
Auto-renewal is certbot's own systemd timer (`certbot.timer`, standard on any modern
certbot install) — no extra plumbing is documented anywhere in this repo beyond "don't bundle
a dead hostname onto the same cert," which is the one concrete lesson to carry forward.

**One adjacent fact worth flagging, not a blocker:** `loopcom.net` (the parent zone
`works.loopcom.net` hangs off) is **DNSSEC-signed** at its current DNS provider (per memory
`dnssec-blocks-a-nameserver-move.md`, measured 2026-08-24 — `DS` record present, TTL 86400s,
active validation confirmed via `dig +dnssec` against Cloudflare/Google/Quad9 resolvers). That
memory's warning is specifically about **moving nameservers** (which would require a 24h DS
removal wait first) — it does **not** block simply adding a new `works` A record through
whichever DNS panel currently manages `loopcom.net`; that's an ordinary additive record change
with no DNSSEC interaction. Flagging only so nobody conflates "add a subdomain" with "move
nameservers" and invents an unnecessary 24-hour wait.
