# DEPLOYMENT

> Read `CURSOR_START_HERE.md` and `AGENTS.md` first. This document **only describes
> what is discoverable from repo files**. It does NOT prescribe new deploy steps.
> All production deploys go through the deploy queue. Anything not directly
> verifiable is marked **UNKNOWN — verify before changing.**

---

## Hard deploy rules (re-stated for safety)

- **No manual deploys.** No SSH `git pull`, no `pnpm build`, no `docker compose ... --build`,
  no `pm2 restart`, no `bash scripts/release/deploy-tag.sh`. See `AGENTS.md`.
- **Correlate integration regressions with deploy timestamps.** Voicemail ingestion,
  VitalPBX REST polling, and telephony push paths do not always ship in the same image.
  When symptoms start after a specific time, pull `GET /ops/deploy/jobs?limit=30` (queue)
  and match `finished_at` to `docker logs` — but **do not assume** the deploy caused the
  bug until VitalPBX/AMI evidence is collected (`DEBUGGING.md` § voicemail). Deploy logs
  also surface **dirty queue clones** (`git status` during `git-sync`); see `AGENTS.md`
  required post-deploy SHA verification.
- **Migrations**: only run by the `api` deploy job, only when `packages/db/prisma/**`
  changed.
- **Forbidden commands** (from `AGENTS.md`): `git pull / checkout / reset` outside the
  queue's clone, `pnpm install / build`, `docker compose up / build / restart`,
  `pm2 restart / reload / kill`, any `pnpm prisma migrate` form, edits to
  `/opt/connectcomms/env/`, `/etc/nginx/`, `/etc/ssh/`, `/etc/ufw/`, `iptables` /
  `ufw`, destructive `psql`/`pg_dump`/`prisma db push --force-reset`.
- **Allowed read-only diagnostics**: see `DEBUGGING.md`.

---

## Docker Compose structure

`docker-compose.app.yml` (production application stack):

| Service | Port (host bind) | Notes |
|---|---|---|
| `api` | `127.0.0.1:3001:3001` | Builds `apps/api/Dockerfile`. `command:` runs Prisma generate + migrate deploy + `pnpm --filter @connect/api dev`. Mounts `moh-assets`, `ivr-prompts`, `chat-attachments` named volumes; mounts `/opt/connectcomms/downloads` read-only for APK distribution. Joins `default` and external `infra_default` networks. |
| `portal` | `127.0.0.1:3000:3000` | Builds `apps/portal/Dockerfile`. Build args include `NEXT_PUBLIC_TELEPHONY_WS_URL` and `NEXT_PUBLIC_FORCE_ICE_RELAY`. Same-origin `/api` (no `NEXT_PUBLIC_API_URL` baked in). |
| `realtime` | `127.0.0.1:3002:3002` | Builds `apps/realtime/Dockerfile`. |
| `telephony` | `127.0.0.1:3003:3003` | Builds `apps/telephony/Dockerfile`. Reads `JWT_SECRET`, `AMI_PASSWORD`, `ARI_PASSWORD` from env_file directly — do NOT override in compose. Joins `default` and `infra_default`. |
| `worker` | (no port) | Builds `apps/worker/Dockerfile`. `command:` runs Prisma generate + `pnpm --filter @connect/worker dev`. Mounts `chat-attachments`. Joins `default` and `infra_default`. |

`docker-compose.sbc.yml` exists for the SBC stack (Kamailio + RTPEngine, see
`infra/sbc/`). UNKNOWN current production usage; check `/voice/sbc/status` to know
whether mode is `LOCAL` (local SBC) or `REMOTE`.

External network: `infra_default` (declared external in compose; presumed to be
the infra stack with Postgres + Redis on the same Docker network). UNKNOWN exact
infra compose layout — not in this repo.

---

## Persistent volumes (named)

- `moh-assets` → `/var/lib/connect/moh-assets` (api). MOH audio files survive
  rebuilds. Pulled by PBX-host `connect-media-sync.sh` via signed HTTPS, never
  via shared filesystem.
- `ivr-prompts` → `/var/lib/connect/ivr-prompts` (api). VitalPBX system-recording
  audio uploaded by PBX-host `connect-prompt-sync.sh` cron. Streamed to browsers
  via `/voice/ivr/prompts/:id/stream`.
- `chat-attachments` → `/var/lib/connect/chat-attachments` (api + worker).
  Worker re-reads to transcode voice notes for VoIP.ms MMS submission.

Host-side directories also referenced:

- `/opt/connectcomms/downloads` (mounted **read-only** into api at
  `/var/lib/connect/downloads`) — Android APK files, populated by
  `scripts/android-publish.ps1` over scp.

---

## Environment variables (key ones, from compose + `apps/telephony/src/config/env.ts`)

> Secrets are loaded from `/opt/connectcomms/env/.env.platform` (operator-managed,
> not in repo). Don't try to read it.

### Common (apps/api, apps/worker)

- `DATABASE_URL` (Postgres) — UNKNOWN value; lives in `.env.platform`.
- `REDIS_URL` (default `redis://127.0.0.1:6379`).
- `JWT_SECRET` (required).
- `CREDENTIALS_MASTER_KEY` (required for credential crypto in `@connect/security`).
- `NODE_ENV` (default `production`).
- `LOG_LEVEL` (default `info`).
- `SMS_PROVIDER`, `SMS_PROVIDER_TEST_MODE`, `SIMULATE_PROVIDER_FAILURE_TWILIO`,
  `SIMULATE_PROVIDER_FAILURE_VOIPMS`.
- `SOLA_CARDKNOX_*` — sandbox/prod, simulate, base URL, keys, webhook secret,
  charge path, mode.
- `EXPO_PUSH_ACCESS_TOKEN`, `MOBILE_PUSH_SIMULATE`.
- `VOICE_SIMULATE`.
- `CDR_INGEST_SECRET` — shared between api `/internal/cdr-ingest` and telephony
  CDR notifier.
- `CDR_INGEST_URL` (telephony) → defaults to `http://api:3001/internal/cdr-ingest`.
- `TELEPHONY_INTERNAL_URL` (api + worker) → defaults to `http://telephony:3003`.
- `MOH_STORAGE_DIR`, `MOH_SYNC_SHARED_SECRET`, `MOH_URL_SIGNING_SECRET`.
- `PROMPT_STORAGE_DIR`, `PROMPT_SYNC_SHARED_SECRET`, `PROMPT_URL_SIGNING_SECRET`.
- `CHAT_STORAGE_DIR`.
- `APK_DOWNLOAD_DIR`, `ANDROID_APK_DOWNLOAD_URL`, `ANDROID_APK_DOWNLOAD_URL_BASE`,
  `PUBLIC_API_URL`.
- `PBX_*`: `PBX_BASE_URL`, `PBX_API_TOKEN`, `PBX_API_SECRET`, `PBX_TIMEOUT_MS`,
  `PBX_TIMEZONE` (default `America/New_York`), `PBX_WS_ENDPOINT`
  (default `wss://209.145.60.79:8089/ws`), `PBX_SIMULATE`, `PBX_WEBHOOK_*`,
  `PBX_ACTIVE_CALLS_PATH`, `PBX_SUPPORTS_WEBHOOKS`,
  `PBX_SUPPORTS_ACTIVE_CALL_POLLING`, `PBX_WEBHOOK_EVENT_TYPES`.
- `STUN_SERVER` (default `stun:stun.l.google.com:19302`).
- `TURN_SERVER`, `TURN_AUTH_SECRET`, `TURN_USERNAME`, `TURN_PASSWORD`.
- `VOIPMS_INBOUND_SYNC_INTERVAL_MS` (default 60000).

### Telephony-only

- `PORT` (default 3003), `TELEPHONY_PORT` (compose alias).
- `PBX_HOST` (default `209.145.60.79`).
- `AMI_PORT` (default 5038), `AMI_USERNAME`, `AMI_PASSWORD`.
- `ARI_BASE_URL` (default `http://209.145.60.79:8088`), `ARI_USERNAME`,
  `ARI_PASSWORD`, `ARI_APP_NAME` (default `connectcomms`).
- `TELEPHONY_WS_PATH` (default `/ws/telephony`).
- `TELEPHONY_SNAPSHOT_INTERVAL_MS` (default 5000).
- `TELEPHONY_EVENT_DEBOUNCE_MS` (default 100 in compose, 1000 in zod default —
  UNKNOWN which wins; verify).
- `ENABLE_TELEPHONY_DEBUG`, `ENABLE_BLF_DEBUG`.
- `TELEPHONY_PBX_MAP_URL` (optional override; otherwise derived from `CDR_INGEST_URL`).

### Portal-only

- `NEXT_PUBLIC_API_URL` (intentionally empty → same-origin `/api`).
- `PORTAL_API_INTERNAL_URL` (`http://api:3001` for SSR fetches).
- `NEXT_PUBLIC_TELEPHONY_WS_URL` (default `wss://app.connectcomunications.com/ws/telephony`).
- `NEXT_PUBLIC_FORCE_ICE_RELAY`.

### API-only

- `PBX_WEBHOOK_VERIFY_MODE` (`token | hmac | ip_allowlist`),
  `PBX_WEBHOOK_TOKEN`, `PBX_WEBHOOK_SIGNATURE_SECRET`, `PBX_WEBHOOK_ALLOWED_IPS`.
- `PBX_WEBHOOK_REGISTER_PATH`, `PBX_WEBHOOK_LIST_PATH`, `PBX_WEBHOOK_DELETE_PATH`.
- `PBX_ROUTE_HELPER_BASE_URL`, `PBX_ROUTE_HELPER_SECRET`,
  `PBX_ROUTE_HELPER_CONNECT_DESTINATION_ID`, `PBX_ROUTE_HELPER_BY_INSTANCE_JSON`
  — HTTP + HMAC secret for the on-PBX Connect helper (`packages/integrations/src/pbxRouteHelperEnv.ts`).
  api/worker call read-only voicemail spool list at `POST …/voicemail/spool/list` when configured.

### Worker-only (voicemail helper throttling)

- `VOICEMAIL_HELPER_FALLBACK_MAX_PER_CYCLE` (default `32`) — max PBX-helper calls per
  `runVoicemailSyncCycle` (each empty-REST extension can consume one call).
- `VOICEMAIL_HELPER_MIN_INTERVAL_MS` (default `200`) — minimum spacing between helper calls.

### VitalPBX host: Connect route helper script

- The Python helper under `/opt/connect-pbx-helper/` is installed/updated by
  `scripts/pbx/install-vitalpbx-inbound-route-helper.sh` on the **PBX host** (root).
  New HTTP routes (e.g. Phase 1 `POST /voicemail/spool/list`, helper `VERSION` `2026.05.08.1`+)
  ship with that script, **not** with the api/worker Docker images. After pulling repo changes
  that touch the installer, an operator must re-run the installer on the PBX to refresh
  `vitalpbx-inbound-route-helper.py` and restart `connect-pbx-route-helper` (systemd unit
  name may vary — verify on host).

### Voicemail Phase 1 — staged rollout (do not deploy everything at once)

Order of operations:

1. **Commit/push** only the voicemail-ingestion slice (api, worker, telephony, integrations, shared, installer, tests, ai-context docs). Avoid bundling unrelated portal/mobile/deploy-script changes into the same production SHA.
2. **Preflight:** `GET /ops/deploy/status` (from an allowed caller). Then enqueue **`dryRun: true`** for each service **before** any real deploy (`AGENTS.md`).
3. **Deploy queue (wave 1):** `api`, then `worker`, then `telephony` — each after its dry-run output is reviewed. Do **not** deploy `portal`, `realtime`, or `full-stack` for this change unless a separate decision says otherwise.
4. **Platform env** (api + worker; verify in `/opt/connectcomms/env/` or your secret store): `PBX_ROUTE_HELPER_BASE_URL`, `PBX_ROUTE_HELPER_SECRET`, and `PBX_ROUTE_HELPER_BY_INSTANCE_JSON` if used.
5. **PBX host:** copy the tagged `install-vitalpbx-inbound-route-helper.sh` from the **same commit** you deployed, then as root:  
   `bash install-vitalpbx-inbound-route-helper.sh`  
   Confirm helper reports `VERSION` **`2026.05.08.1`** or later via `GET http://127.0.0.1:8757/health`.
6. **Smoke:** `POST /voicemail/spool/list` on the PBX loopback with a known `tenantId` + `extension` (see `DEBUGGING.md` § voicemail).
7. **End-to-end:** trigger `POST /internal/voicemail-notify` (or leave a test voicemail and wait for AMI `MessageWaiting`). Expect logs with `rest_count = 0`, `helper_count > 0`, `source_used` reflecting helper path, `upserted > 0` when REST is empty but spool has messages.
8. **UI:** confirm new rows in web/mobile voicemail **lists**. **Do not** claim playback is fixed — Phase 1 is ingestion/list visibility only (`KNOWN_ISSUES.md`).

**Rollback (wave 1):** Re-enqueue `api`, `worker`, and `telephony` each pinned to the **previous known-good commit SHA** (same deploy queue, no manual docker). PBX helper: keep `2026.05.08.1` (read-only list) or restore the prior helper script from backup only if the new endpoint causes operational issues — coordinate with ops; do not delete voicemail files.

**Production check-in (2026-05-08):** Deploy queue shipped **`api` → `worker` → `telephony`** for commit **`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`** (`feat/voicemail-phase1-spool-ingestion`). Each job log ended with **`[deploy-*] done cf4a1f6`** and health checks passed. **`PBX_ROUTE_HELPER_*`** is present in api/worker containers. A follow-up HTTP check from the app host to **`http://<pbx>:8757/health`** still returned helper **`2026.05.07.1`** until the PBX installer from that commit is re-run — below **`2026.05.08.1`**, `POST /voicemail/spool/list` is absent (404 / `not_found`) and ingestion behaves REST-only. **Operator action:** run `bash install-vitalpbx-inbound-route-helper.sh` on the PBX as root, then re-check `/health` and spool list (`DEBUGGING.md`).

### PBX helper — Phase 1 install pin + `404` on `/voicemail/spool/list`

**Symptom:** `GET /health` returns 200 but `POST /voicemail/spool/list` returns **404**. The process is running an **old** `vitalpbx-inbound-route-helper.py` (pre-**`2026.05.08.1`**) that does not register the spool route.

**Fix (PBX host, root):**

1. Fetch the installer **exactly** from the shipped commit (example Phase 1 pin):  
   `https://raw.githubusercontent.com/izzwgg-arch/connect-platform/cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067/scripts/pbx/install-vitalpbx-inbound-route-helper.sh`  
   Save as `install-vitalpbx-inbound-route-helper.sh`, `chmod +x`, then:  
   `bash install-vitalpbx-inbound-route-helper.sh`  
   (Script installs to `/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py` and systemd unit **`connect-pbx-helper.service`**, env file **`/etc/connect-pbx-helper.env`** — see installer in-repo.)
2. **Verify:** `curl -s http://127.0.0.1:8757/health` → `"version":"2026.05.08.1"` (or newer). **`/health` alone is insufficient** if version is still `.07.x`.
3. **Verify:** `POST http://127.0.0.1:8757/voicemail/spool/list` with JSON `tenantId`, `extension`, header `x-connect-pbx-helper-secret` → **200**, `ok: true`, `messages` (array, may be empty).

### PBX helper — compromised `CONNECT_PBX_HELPER_SECRET` (rotation)

If the helper secret was **exposed** (screenshot, chat, ticket), treat it as **compromised** and rotate end-to-end.

**PBX (root):**

1. Generate a new secret (≥32 chars), e.g. `openssl rand -hex 32`.
2. Set **`CONNECT_PBX_HELPER_SECRET`** in **`/etc/connect-pbx-helper.env`** (installer-owned; mode `0600`). Do not commit this file.
3. `systemctl restart connect-pbx-helper.service`
4. `curl -s http://127.0.0.1:8757/health` — still **`2026.05.08.1`+**.

**Connect app host (human operator — not agent-edited in repo):**

1. Set **`PBX_ROUTE_HELPER_SECRET`** to the **same** new value in the platform env consumed by **api** and **worker** (e.g. `/opt/connectcomms/env/.env.platform` or your secret store). Update **`PBX_ROUTE_HELPER_BY_INSTANCE_JSON`** (or equivalent) if any per-instance entry carries its own `secret`.
2. **Restart api and worker** so containers load the new env. Per **`AGENTS.md`**, use the **deploy queue** (`POST /ops/deploy/enqueue`) with the **current production `commitHash`** and `dryRun: false` for **`api`** then **`worker`** — do not ad-hoc `docker compose` / `pm2` unless break-glass and human-approved.

**Re-test:** `POST /voicemail/spool/list` from an app host with the new secret; `POST /internal/voicemail-notify` and worker voicemail JSON should **not** show `helper_error:not_found` when REST is empty and spool has messages (`DEBUGGING.md`).

### Phase 1 — production verification checklist (A–G)

Use this after Connect images ship and before claiming fallback is live.

| Step | Action | Pass criteria |
|------|--------|----------------|
| **A** | On app host: `docker exec app-api-1 printenv PBX_ROUTE_HELPER_BASE_URL` (repeat for **worker**). If set, `printenv PBX_ROUTE_HELPER_BY_INSTANCE_JSON` (length > 0 means per-instance URLs/secrets). | Exact list of **active helper base URL(s)** (no trailing slash) recorded. |
| **B** | From app host: `curl -s http://<host>:8757/health` for **each** URL from A. Record UTC time. | Every host returns **`"version":"2026.05.08.1"`** or newer. Any **`2026.05.07.x`** → upgrade installer on **that** host (§ Phase 1 install pin). |
| **A′ IP mismatch** | If VitalPBX SSH MOTD shows a **different** public IP than `PBX_ROUTE_HELPER_BASE_URL`, `curl` **`:8757/health`** on both from the app host. | Traffic must hit the machine where the helper **actually** runs; update **`PBX_ROUTE_HELPER_BASE_URL`** (and JSON map) if wrong, then redeploy **api** + **worker** via queue. |
| **C** | On the **correct** PBX (root): run installer from commit **`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`**, restart **`connect-pbx-helper.service`**. | **`/health`** → **`2026.05.08.1`**. |
| **D** | Rotate compromised secret (§ compromised secret); queue **api** then **worker**. | PBX env, Connect env, and JSON secrets identical; services restarted. |
| **E** | `POST …/voicemail/spool/list` with valid `tenantId`, `extension`, `x-connect-pbx-helper-secret`. | **200**, `ok: true`, `messages` array; **not** 404 / 401. |
| **F** | AMI `MessageWaiting` or manual `/internal/voicemail-notify` (with `newCount > 0` when REST empty). | Logs: `rest_count: 0`, `helper_count > 0`, `source_used` helper path, `upserted > 0` when spool has mail. |
| **G** | Portal + mobile voicemail list | New rows, **current** `receivedAt` (not a stale date). Playback still separate (`KNOWN_ISSUES.md`). |

**Read-only snapshot (2026-05-08 UTC, app host → helper):** production **api/worker** had **`PBX_ROUTE_HELPER_BASE_URL=http://209.145.60.79:8757`**; **`PBX_ROUTE_HELPER_BY_INSTANCE_JSON`** unset (length 0). **`GET http://209.145.60.79:8757/health`** returned **`2026.05.07.1`** (Phase 1 route not present → **`helper_error:not_found`** until upgrade). **`GET http://209.145.62.75:8757/health`** returned no body from the app host (helper not listening there, blocked, or wrong target). **Operator:** confirm which VitalPBX owns **`209.145.60.79`** vs MOTD IP on the server you SSH into; align **BASE_URL** with the host where **`connect-pbx-helper`** runs.

---

## Exposed ports (publicly via nginx)

Only ports that nginx publishes to the internet (per `docs/TELEPHONY_NGINX.md`,
`docs/safe-deploy-queue.md`, and code defaults):

| URL | Backend |
|---|---|
| `https://app.connectcomunications.com/...` | portal (`127.0.0.1:3000`) |
| `https://app.connectcomunications.com/api/...` | api (`127.0.0.1:3001`) |
| `wss://app.connectcomunications.com/ws/telephony` | telephony (`127.0.0.1:3003/ws/telephony`) |
| `wss://app.connectcomunications.com/sip` | SBC (Kamailio) → PBX `:8089` |
| `https://app.connectcomunications.com/api/webhooks/pbx` | api PBX webhook (rate-limited, excluded from auto-ban) |
| `https://app.connectcomunications.com/api/downloads/<filename>.apk` | api APK serve |

The deploy queue (`127.0.0.1:3910`) is **server-loopback only**; reach via SSH port
forward `ssh -L 3910:127.0.0.1:3910 user@server`.

`/internal/...` paths are **blocked at nginx** from the public internet (same as
`/api/webhooks/pbx`).

---

## Build scripts (per service)

From `docs/safe-deploy-queue.md` and `scripts/`:

| Service | Script |
|---|---|
| `api` | `scripts/deploy-api.sh` (the only one that runs `prisma migrate deploy`) |
| `portal` | `scripts/deploy-portal.sh` |
| `telephony` | `scripts/deploy-telephony.sh` |
| `realtime` | `scripts/deploy-realtime.sh` |
| `worker` | `scripts/deploy-worker.sh` (health = container running) |
| `full-stack` | `scripts/deploy-full-stack.sh` (wraps `scripts/release/deploy-tag.sh`) |
| Shared helpers | `scripts/lib/deploy-common.sh` |
| Rollback | `scripts/release/rollback.sh` |

`scripts/build-changed.sh` and `scripts/smoke-fast.sh` exist for local fast checks.

---

## Deployment scripts (operator-side)

The deploy queue is the operator entry point. Documented thoroughly in
`docs/safe-deploy-queue.md` and re-stated in `AGENTS.md`.

Two paths for agents:

- **Path A** (on server via SSH): `POST http://127.0.0.1:3910/ops/deploy/enqueue`.
  Loopback origin grants trust.
- **Path B** (any networked caller): `POST https://app.connectcomunications.com/api/internal/deploy/auto`
  with `x-internal-deploy-secret` or admin Bearer JWT.

Required JSON body:

- `service`: `api | portal | telephony | realtime | worker | full-stack`.
- `branch`: git branch (or git **tag** for `full-stack`).
- `commitHash`: optional SHA pin.
- `requestedBy`: `cursor:<session-id>` or `human:<name>`.
- `reason`: one-line note.
- `dryRun`: prefer `true` first. Dry-runs now fetch refs and verify target checkout
  safety without checkout/reset/clean; they fail with exact dirty blocking paths
  before any Docker, Prisma, restart, or health-check work.
- `source`: `auto` (agent) or `manual` (UI).

Limits:

- 1 auto-enqueue per service per **30 s** (`429 auto_enqueue_rate_limited`).
- Same-commit skip (returns `200 { skipped: true }`).
- Duplicate-active-job guard (`409 duplicate_active_job_for_service`).
- Global serialization: one job at a time (PID-file lock).

Status checks:

- `GET /ops/deploy/status`
- `GET /ops/deploy/jobs/:id`
- `GET /ops/deploy/jobs/:id/log?lines=200`

---

## Production URLs (already in repo / docs)

- Portal: `https://app.connectcomunications.com`
- API base: `https://app.connectcomunications.com/api`
- Telephony WS: `wss://app.connectcomunications.com/ws/telephony`
- SIP/WSS: `wss://app.connectcomunications.com/sip`
- PBX (internal): `209.145.60.79` (AMI :5038, ARI :8088, WSS :8089)

> Note the spelling: the production hostname uses one `c` —
> `connectcomunications` (not `connectcommunications`). Mirror exactly.

---

## Mobile builds (Expo / EAS)

- Profiles in `apps/mobile/eas.json`: `dev`, `preview`, `production` for both
  Android and iOS.
- Helper PowerShell scripts live under `scripts/`:
  `mobile-android-live.ps1`, `android-live-capture.ps1`, `android-live-debug.ps1`,
  `android-logcat-clear.ps1`, `build-android-release.ps1`, `android-ship.ps1`,
  `setup-and-build-android-release.ps1`.
- APK distribution: `scripts/android-publish.ps1` copies a release APK into
  `/opt/connectcomms/downloads/` over scp; the api serves it via
  `/api/downloads/connectcomms-latest.apk` (filename allow-list enforced).
- iOS distribution: UNKNOWN — verify with EAS submit configuration.

---

## Warnings around production changes

1. **Don't change Docker network names or service hostnames.** `http://api:3001`,
   `http://telephony:3003`, the `infra_default` external network — all consumed
   internally.
2. **Don't change exposed host ports.** Only nginx talks to the loopback bindings.
3. **Don't add a public port.** Even Postgres and Redis must stay on the
   `infra_default` network.
4. **Don't merge a Prisma migration without coordinating an `api` deploy.**
   Other services run Prisma generate but not migrate; a missing column will throw
   at runtime in `worker` and `api`.
5. **Don't drop or rename existing volumes.** `moh-assets`, `ivr-prompts`,
   `chat-attachments` are live data.
6. **Don't relax internal endpoint guards.** `/internal/cdr-ingest`,
   `/internal/voicemail-notify`, `/internal/deploy/auto` rely on `x-cdr-secret` /
   `x-internal-deploy-secret` plus nginx-level blocking.
7. **Don't change the WS path** `/ws/telephony` — portal builds bake it into
   `NEXT_PUBLIC_TELEPHONY_WS_URL`.
8. **Don't restart the deploy worker** as part of a normal deploy — the queue
   manages itself. See `AGENTS.md`.
