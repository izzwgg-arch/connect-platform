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
- `VOICEMAIL_INGEST_INCIDENTS_ENABLED` — when **`false`**, **`VoicemailIngestIncident`** emission from **`/internal/voicemail-notify`** and the worker voicemail sync cycle is disabled (default **true**). Set on **api** and **worker** containers for rollback without code revert.

### Worker-only (voicemail helper throttling)

- `VOICEMAIL_HELPER_FALLBACK_MAX_PER_CYCLE` (default `32`) — max PBX-helper calls per
  `runVoicemailSyncCycle` (each empty-REST extension can consume one call).
- `VOICEMAIL_HELPER_MIN_INTERVAL_MS` (default `200`) — minimum spacing between helper calls.

### VitalPBX host: Connect route helper script

- The Python helper under `/opt/connect-pbx-helper/` is installed/updated by
  `scripts/pbx/install-vitalpbx-inbound-route-helper.sh` on the **PBX host** (root).
  New HTTP routes (e.g. Phase 1 `POST /voicemail/spool/list`, Phase 2 `POST /voicemail/spool/audio`, helper `VERSION` `2026.05.08.2`+)
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

### Voicemail Phase 2 — spool playback (api + helper `2026.05.08.2`+)

**Goal:** `GET /voice/voicemail/:id/stream` (and `/download`) return real audio for spool-ingested rows when VitalPBX **`pbxRecfile`** / REST is missing or broken — **no** mobile/portal URL change.

**Order:**

1. **PBX:** Re-run pinned **`install-vitalpbx-inbound-route-helper.sh`** from the commit that ships Phase 2 (embeds helper **`VERSION` `2026.05.08.2`**). Restart **`connect-pbx-helper.service`**. **`GET /health`** must report **`2026.05.08.2`** (or newer).
2. **Smoke (PBX loopback):** authenticated **`POST http://127.0.0.1:8757/voicemail/spool/audio`** with JSON **`tenantId`**, **`extension`**, **`folder`** (`INBOX` \| `Old` \| `Urgent`), **`msgNum`** matching **`msg[0-9]+`** for a message that exists on disk → **200**, **`Content-Type: audio/wav`**, binary body (not JSON). **400/404** = validation or missing file (expected for bad probes).
3. **Deploy queue:** enqueue **`api`** only (Phase 2 logic lives in **`streamVoicemailAudio`**). Worker/telephony unchanged for this slice.
4. **Verify:** for a known spool-backed voicemail id, **`GET /voice/voicemail/:id/stream?token=…`** → **200**, audio content-type; **API** logs may show **`voicemail: helper_audio_fallback`** with **`helper_audio_fallback: true`**.

**Recorded Phase 2 — api shipped (2026-05-09):** Queue job **`c19f5796-b4f9-4619-96a2-d5a703231f7c`** (**`api`** only, **`dryRun: false`**) ended with **`[deploy-api] done 303399d requested_by=human:phase2-rollout`**. Log showed **`prisma: no schema/migrations changes -> skipping migrate deploy`**. Post-restart loopback **`GET http://127.0.0.1:3001/health`** → **200**. **`docker exec app-api-1 grep -n helper_audio_fallback /app/apps/api/src/server.ts`** confirms Phase 2 code in the running tree. **Dirty clone fingerprint:** after **`git checkout`** the log still listed **`M apps/telephony/src/telephony/state/CallStateStore.ts`** on the queue working copy — treat per **`AGENTS.md`** / **`KNOWN_ISSUES.md`** (“Deploy queue silently ships stale code”); **`apps/api`** Dockerfile **`COPY . .`** still picked up **`303399d`** tree for this build, but ops should **`git checkout HEAD --`** that file (or resolve the diff) on **`/opt/connectcomms/app`** before the next telephony deploy. **Compose noise:** **`Found orphan containers ([sbc-rtpengine sbc-kamailio])`** during **`docker up api`** — unrelated to voicemail. **Helper gap at check time:** app-host **`GET http://209.145.60.79:8757/health`** still returned **`2026.05.08.1`** — operator must install **`2026.05.08.2`** before **`POST /voicemail/spool/audio`** and helper-based playback work end-to-end.

**Rollback:** Re-enqueue **api** to the prior SHA. Helper may stay on **`2026.05.08.2`** (audio route is harmless if unused) or restore prior installer only if ops requires it.

**Rollback (wave 1):** Re-enqueue `api`, `worker`, and `telephony` each pinned to the **previous known-good commit SHA** (same deploy queue, no manual docker). PBX helper: keep `2026.05.08.1` (read-only list) or restore the prior helper script from backup only if the new endpoint causes operational issues — coordinate with ops; do not delete voicemail files.

**Production check-in (2026-05-08):** Deploy queue shipped **`api` → `worker` → `telephony`** for commit **`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`** (`feat/voicemail-phase1-spool-ingestion`). Each job log ended with **`[deploy-*] done cf4a1f6`** and health checks passed. **`PBX_ROUTE_HELPER_*`** is present in api/worker containers. A follow-up HTTP check from the app host to **`http://<pbx>:8757/health`** still returned helper **`2026.05.07.1`** until the PBX installer from that commit is re-run — below **`2026.05.08.1`**, `POST /voicemail/spool/list` is absent (404 / `not_found`) and ingestion behaves REST-only. **Operator action:** run `bash install-vitalpbx-inbound-route-helper.sh` on the PBX as root, then re-check `/health` and spool list (`DEBUGGING.md`).

### PBX helper — upgrades: pinned installer only (no manual Python)

Do **not** manually edit **`/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py`**
(or any on-PBX helper Python), apply `vim`/SCP patches, or run ad-hoc package
installs. The **only** supported upgrade is: download **`install-vitalpbx-inbound-route-helper.sh`**
from **`origin` at a pinned commit** (Phase 1 pin: **`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`**),
then run **`bash …/install-vitalpbx-inbound-route-helper.sh`**, which installs the
embedded helper (**`VERSION` `2026.05.08.2`** as of Phase 2 — includes spool list + spool audio) and manages **`connect-pbx-helper.service`**.

If **`curl -s http://127.0.0.1:8757/health`** still shows **`2026.05.07.x`** after you
believe the installer ran, the **running** process did not pick up the new tree (bad
download, wrong host, service not restarted, or script error). **Do not** “fix” by
editing Python — re-run the **same** pinned installer from git, confirm **`systemctl status
connect-pbx-helper`**, then re-check `/health`. Do **not** change Asterisk dialplan or
reprovision extensions for this step.

### PBX helper — Phase 1 install pin + `404` on `/voicemail/spool/list`

**Symptom:** `GET /health` returns 200 but `POST /voicemail/spool/list` returns **404**. The process is running an **old** `vitalpbx-inbound-route-helper.py` (pre-**`2026.05.08.1`**) that does not register the spool route.

**Fix (PBX host, root):**

1. Fetch the installer **exactly** from the pinned commit (**`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`**):  
   `curl -fsSL https://raw.githubusercontent.com/izzwgg-arch/connect-platform/cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067/scripts/pbx/install-vitalpbx-inbound-route-helper.sh -o /root/install-vitalpbx-inbound-route-helper.sh`  
   then **`bash /root/install-vitalpbx-inbound-route-helper.sh`** (optional: `chmod +x` first).  
   (Script installs to `/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py` and systemd unit **`connect-pbx-helper.service`**, env file **`/etc/connect-pbx-helper.env`** — see installer in-repo.)
2. **Verify:** `curl -s http://127.0.0.1:8757/health` → **`"version":"2026.05.08.1"`** (or newer). If you still see **`2026.05.07.1`**, the helper binary in use was **not** updated — repeat step 1; do not patch Python by hand.
3. **Verify:** `POST http://127.0.0.1:8757/voicemail/spool/list` with JSON `tenantId`, `extension`, header `x-connect-pbx-helper-secret` → **200**, `ok: true`, `messages` (array, may be empty). Example on PBX loopback (replace `<SECRET>`):  
   `curl -s -X POST http://127.0.0.1:8757/voicemail/spool/list -H "Content-Type: application/json" -H "x-connect-pbx-helper-secret: <SECRET>" -d '{"tenantId":"8","extension":"101"}'`

### PBX helper — listen bind (`Connection refused` from Connect app host)

The pinned installer **defaults** to **`CONNECT_PBX_HELPER_BIND=127.0.0.1`** (loopback only).
That is correct for “PBX-local” smoke tests but **breaks** Connect when
**`PBX_ROUTE_HELPER_BASE_URL`** is something like **`http://209.145.60.79:8757`**: the
app host’s `curl` / api’s HTTP client will see **`Connection refused`** or time out even
though **`curl -s http://127.0.0.1:8757/health`** on the PBX shows **`2026.05.08.1`**.

**Env shape (read carefully):** **`CONNECT_PBX_HELPER_BIND`** must be a **bind address
only** — e.g. **`0.0.0.0`** (all interfaces) or a **specific private IP** on the path to
the Connect app host. The port is **separate**: **`CONNECT_PBX_HELPER_PORT=8757`** (already
written by the installer). **Do not** set **`CONNECT_PBX_HELPER_BIND=0.0.0.0:8757`** (or any
**`host:port`** in the bind variable); the helper reads host and port as two settings and a
combined value can break startup or listening.

**Phase 1 — bind + firewall checklist (operator, not Python):**

1. **PBX — local `/health`:** **`curl -s http://127.0.0.1:8757/health`** → **`"version":"2026.05.08.1"`**.
2. **PBX — local spool route:** authenticated **`POST http://127.0.0.1:8757/voicemail/spool/list`**
   → **HTTP 200**, **`ok: true`**, **`messages`** present (may be empty).
3. **PBX — env file:** edit **`/etc/connect-pbx-helper.env`**. Set exactly **`CONNECT_PBX_HELPER_BIND=0.0.0.0`**
   (or a specific NIC IP) and **`CONNECT_PBX_HELPER_PORT=8757`**. **Never** **`CONNECT_PBX_HELPER_BIND=0.0.0.0:8757`**.
4. **PBX — restart:** **`systemctl restart connect-pbx-helper.service`**.
5. **PBX — still healthy on loopback:** **`curl -s http://127.0.0.1:8757/health`** → **`2026.05.08.1`**.
   Optional: **`ss -lntp | grep 8757`** should show listen on **`0.0.0.0:8757`** (or `*:8757`), not only **`127.0.0.1:8757`**.
6. **Firewall:** allow **tcp/8757** **only** from the **Connect app host** IP (and ops nets if required).
   **Do not** expose **:8757** broadly or to **0.0.0.0/0** without an explicit policy exception.
7. **App host — remote `/health`:** **`curl -s http://<pbx-ip>:8757/health`** → **`2026.05.08.1`**.
   If this still **refused** after step 5 shows `0.0.0.0:8757`, the block is **firewall/routing**, not bind.
8. **App host — remote spool:** authenticated **`POST http://<pbx-ip>:8757/voicemail/spool/list`**
   → **200** / **`ok: true`** (same secret as **`PBX_ROUTE_HELPER_SECRET`**).
9. If the helper secret was rotated: align **`PBX_ROUTE_HELPER_SECRET`**, enqueue **`api`** then **`worker`**
   via the deploy queue only (`AGENTS.md`).
10. **Logs:** notify / worker JSON — **`rest_count: 0`**, **`helper_count > 0`**, **`source_used`**
    reflects helper, **`upserted > 0`** when spool has new mail and REST is empty (`DEBUGGING.md`).

### Phase 1 — app-host smoke (after bind + firewall)

Run from the **Connect app host** (same network path **api**/**worker** use), **not** the PBX loopback:

1. **`curl -s http://<pbx-ip>:8757/health`** → **`"version":"2026.05.08.1"`** (JSON may space fields differently).
2. **`POST http://<pbx-ip>:8757/voicemail/spool/list`** with **`Content-Type: application/json`**, body
   **`{"tenantId":"…","extension":"…"}`**, header **`x-connect-pbx-helper-secret`** equal to
   **`PBX_ROUTE_HELPER_SECRET`** from **`docker exec app-api-1 printenv PBX_ROUTE_HELPER_SECRET`**
   (**never** paste the value into tickets).

| HTTP | Body hint | Action |
|------|-----------|--------|
| **200** | **`ok: true`**, **`messages`** array | Secret + route OK — proceed to **`/internal/voicemail-notify`** / worker log checks (`DEBUGGING.md`). |
| **401** | **`unauthorized`** | **`CONNECT_PBX_HELPER_SECRET`** in **`/etc/connect-pbx-helper.env`** on the PBX ≠ Connect **`PBX_ROUTE_HELPER_SECRET`**. Align (one source of truth), **`systemctl restart connect-pbx-helper.service`**. If Connect **`.env.platform`** changed, enqueue **api** then **worker** via queue. |
| **404** | e.g. **`not_found`** | Wrong helper version or wrong host — re-check **`/health`** **`version`**. |

**Recorded check (Connect app host):** **`GET http://209.145.60.79:8757/health`** → **`2026.05.08.1`** OK.
**`POST …/spool/list`** → **401** until PBX **`CONNECT_PBX_HELPER_SECRET`** **byte-matches** Connect at
runtime (see § **Troubleshooting: still 401**). **api**/**worker** **`PBX_ROUTE_HELPER_SECRET`** remain
internally consistent (`sha256sum` identical in prior checks).

### Phase 1 — helper secret alignment only (401 `unauthorized`, not a version/bind issue)

**When:** App-host **`GET …:8757/health`** shows **`2026.05.08.1`**, but **`POST …/voicemail/spool/list`**
returns **401** with body like **`{"error":"unauthorized"}`**. **api** and **worker** **`PBX_ROUTE_HELPER_SECRET`**
already match each other — only **PBX** **`CONNECT_PBX_HELPER_SECRET`** differs.

Pick **one** source of truth. **Do not** “rotate both sides blindly” to a new random value without a
controlled copy into your secret store.

#### Preferred: PBX follows Connect (no Connect redeploy)

Use the **existing** Connect **`PBX_ROUTE_HELPER_SECRET`** (same bytes **api**/**worker** already load).
Copy it **securely** from the app host (e.g. **`docker exec app-api-1 printenv PBX_ROUTE_HELPER_SECRET`**
into the operator’s password manager / PBX root session only) — **never** paste into tickets or chat.

**On the PBX (root):**

1. Edit **`/etc/connect-pbx-helper.env`**.
2. Set **`CONNECT_PBX_HELPER_SECRET=<exact same value as Connect PBX_ROUTE_HELPER_SECRET>`** on a single line.
   **Do not** add wrapping quotes unless your env format already requires them. **No** trailing spaces or
   newline characters inside the secret value.
3. **`chmod 0600 /etc/connect-pbx-helper.env`** if needed.
4. **`systemctl restart connect-pbx-helper.service`**
5. **`curl -s http://127.0.0.1:8757/health`** → still **`2026.05.08.1`**.

**On the Connect app host (verify):**

1. **`curl -s http://<pbx-ip>:8757/health`** → **`2026.05.08.1`**
2. **`POST http://<pbx-ip>:8757/voicemail/spool/list`** with **`x-connect-pbx-helper-secret`** from
   **`docker exec app-api-1 printenv PBX_ROUTE_HELPER_SECRET`** (trim CR/LF) → expect **HTTP 200**,
   **`ok: true`**, **`messages`** array present (may be empty).

#### Alternate: Connect follows PBX (requires queue recycle)

If policy says the PBX file is canonical: set **`PBX_ROUTE_HELPER_SECRET=`** in **`/opt/connectcomms/env/.env.platform`**
(or your secret store) to the PBX **`CONNECT_PBX_HELPER_SECRET`** value, then enqueue **`api`** then **`worker`**
via the deploy queue only (`AGENTS.md`) so containers reload env. Re-run the app-host **`POST …/spool/list`** probe.

#### After HTTP 200

Trigger or wait for **`/internal/voicemail-notify`** / worker **`voicemail-sync-cycle`**; confirm JSON includes
**`helper_count > 0`**, **`source_used`** reflecting helper, **`upserted > 0`** when REST is empty and spool has
mail; confirm portal/mobile **lists** show rows (`DEBUGGING.md`). Playback remains separate from Phase 1.

#### Troubleshooting: **`POST …/spool/list` still 401** after editing **`/etc/connect-pbx-helper.env`**

**Verify the running process actually has the new secret** (do **not** paste values into tickets):

- **`systemctl show connect-pbx-helper.service -p EnvironmentFiles` / `-p ExecStart`** — confirm which env file
  systemd loads; only edit **that** file.
- **`grep -n '^CONNECT_PBX_HELPER_SECRET=' /etc/connect-pbx-helper.env`** — exactly **one** line; remove duplicate
  keys or commented duplicates that confuse operators.
- **No** surrounding **single/double quotes** in the value unless the secret itself contains characters that
  require them — a quote stored **inside** the secret bytes will break comparison.
- **CRLF / trailing space:** re-type the line or use **`sed`** to strip `\r` and trailing spaces; the Connect
  side uses **`PBX_ROUTE_HELPER_SECRET`** without trailing newline in process env.
- **`systemctl restart connect-pbx-helper.service`** then **`curl -s http://127.0.0.1:8757/health`** (still
  **`2026.05.08.1`**) then re-test **`POST …/spool/list`** from the **app host** with the header from
  **`docker exec app-api-1 printenv PBX_ROUTE_HELPER_SECRET`** (trim with **`tr -d '\r\n'`** in shell).

#### Secret mismatch fingerprints (no secret in tickets)

**Connect app host (reference):** compare **api** vs **worker**, then compare to PBX file/runtime.

```bash
# Length + sha256 of Connect secret (value never printed)
for SVC in app-api-1 app-worker-1; do
  echo "=== $SVC ==="
  docker exec "$SVC" sh -lc 'test -n "$PBX_ROUTE_HELPER_SECRET" && echo exists=yes || echo exists=no'
  docker exec "$SVC" sh -lc 'printf %s "$PBX_ROUTE_HELPER_SECRET" | wc -c'
  docker exec "$SVC" sh -lc 'printf %s "$PBX_ROUTE_HELPER_SECRET" | sha256sum'
done
```

**PBX (root, SSH on the helper host)** — still **no** printing the raw secret; line numbers redacted, counts,
**`sha256` prefix**, quote/trailing-space flags, file vs **`/proc/<pid>/environ`**.

Preferred one-shot (copy as a block):

```bash
echo "=== file lines ==="
grep -n '^CONNECT_PBX_HELPER_SECRET=' /etc/connect-pbx-helper.env | sed 's/=.*/=<redacted>/'

echo "=== duplicate count ==="
grep -c '^CONNECT_PBX_HELPER_SECRET=' /etc/connect-pbx-helper.env

echo "=== file fingerprint ==="
python3 - <<'PY'
from pathlib import Path
import hashlib
text = Path("/etc/connect-pbx-helper.env").read_text(encoding="utf-8", errors="replace")
vals = []
for line in text.splitlines():
    if line.startswith("CONNECT_PBX_HELPER_SECRET="):
        vals.append(line.split("=", 1)[1])
print("count", len(vals))
for i, v in enumerate(vals, 1):
    b = v.encode("utf-8")
    print(
        "idx", i,
        "len", len(b),
        "sha256_prefix", hashlib.sha256(b).hexdigest()[:16],
        "quoted", (v.startswith('"') or v.startswith("'")),
        "trailing_space", (v != v.rstrip()),
    )
PY

echo "=== runtime pid (prefer systemd MainPID) ==="
pid_sys=$(systemctl show connect-pbx-helper.service -p MainPID --value)
pid_pg=$(pgrep -f vitalpbx-inbound-route-helper.py | head -1)
echo "MainPID=$pid_sys pgrep_first=$pid_pg"

echo "=== runtime fingerprint (uses MainPID if non-zero) ==="
python3 - <<'PY'
import hashlib, subprocess
main = subprocess.check_output(
    ["systemctl", "show", "connect-pbx-helper.service", "-p", "MainPID", "--value"],
    text=True,
).strip()
pid = main if main and main != "0" else subprocess.check_output(
    "pgrep -f vitalpbx-inbound-route-helper.py | head -1", shell=True, text=True
).strip()
if not pid:
    print("no_pid")
    raise SystemExit(0)
data = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
vals = []
for item in data:
    if item.startswith(b"CONNECT_PBX_HELPER_SECRET="):
        vals.append(item.split(b"=", 1)[1])
print("pid", pid, "count", len(vals))
for i, v in enumerate(vals, 1):
    print("idx", i, "len", len(v), "sha256_prefix", hashlib.sha256(v).hexdigest()[:16])
PY

echo "=== systemd env files ==="
systemctl cat connect-pbx-helper.service | sed -n '/Environment/p'
systemctl show connect-pbx-helper.service -p FragmentPath -p DropInPaths -p EnvironmentFiles -p ActiveEnterTimestamp --no-pager
```

**Notes:**

- Compare **Connect** **`docker exec … sha256sum`** (full hex) to **file** / **runtime** **`sha256_prefix`** (extend locally to full hash if needed).
- **`quoted: True`** usually means the secret bytes include wrapping quotes — helper compares **without** stripping
  quotes unless the Connect side also stores quotes (it should **not**).
- Prefer **`MainPID`** over **`pgrep`** if multiple Python helpers could match the pattern.

**Decision tree:**

| Compare | Meaning |
|---------|---------|
| Connect **sha256** ≠ PBX **file** **sha256** | Fix **`/etc/connect-pbx-helper.env`** (bytes, quotes, CRLF, duplicate lines). |
| PBX **file** **sha256** = Connect but ≠ PBX **runtime** **sha256** | **systemd** not loading that file, wrong unit, or restart didn’t happen — fix **EnvironmentFiles** / **`daemon-reload`** / restart. |
| All three **sha256** match but **HTTP 401** | Rare — capture request headers at helper (redacted) or inspect helper auth code path (`install-vitalpbx-inbound-route-helper.sh` embedded Python). |

**Recorded verification (Connect app host):** **`GET …/health`** → **HTTP 200**, **`2026.05.08.1`** ✓.
**`POST …/spool/list`** (secret from **api** container, **`printf %s`**, not logged) → **HTTP 200**,
**`ok: true`**, large **`messages`** array (tenant **`8`** / ext **`101`** probe) — helper **auth** and **route**
reachable from Connect after **`CONNECT_PBX_HELPER_SECRET`** alignment on PBX.
**`app-worker-1`** **`voicemail-sync-cycle`** then showed **`helper_count` > 0**, **`source_used":"helper"`**,
**`upserted_count` > 0**, **`fallback_reason":"rest_empty_used_spool_fallback"`** (proof of Phase 1 fallback).
**`app-api-1`** **`/internal/voicemail-notify`** lines shortly before may still show **`helper_error:unauthorized`**
from events **prior** to alignment — re-check **`docker logs app-api-1 --since 5m`** after a new AMI/notify.

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

### Phase 1 — operator handoff (fix helper on `209.145.60.79`)

**Context:** Connect **api/worker** use **`http://209.145.60.79:8757`**. **`PBX_ROUTE_HELPER_BY_INSTANCE_JSON`** is unset. **`/health`** reports **`2026.05.07.1`** → **`POST /voicemail/spool/list`** is missing (**404**). Do **not** point Connect at **`209.145.62.75`** unless you deliberately change env and redeploy — that IP did not answer `:8757` from the app host in checks.

#### B. Safety checks (before any change)

1. **`GET /ops/deploy/status`** on the app host (`127.0.0.1:3910`) — prefer **`runningCount: 0`** before enqueueing reload deploys.
2. Record baseline: `curl -s http://209.145.60.79:8757/health` (expect **`2026.05.07.1`** today).
3. On the PBX (**`209.145.60.79`**), backup helper artifacts:
   ```bash
   sudo cp -a /opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py "/root/vitalpbx-inbound-route-helper.py.bak.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
   sudo cp -a /etc/connect-pbx-helper.env "/root/connect-pbx-helper.env.bak.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
   ```
4. Schedule during a **low-traffic** window if possible (brief helper restart; brief api/worker recycle after secret rotation).

#### A. Copy-paste operator commands

**1–2. SSH to the helper host and confirm local health**

```bash
# From your workstation (replace user if you use non-root sudo)
ssh root@209.145.60.79

# On the PBX:
curl -s http://127.0.0.1:8757/health
```

**3. Download and run the pinned installer** (commit **`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`** — required helper **`2026.05.08.1`**)

```bash
# Still on 209.145.60.79 as root (installer only — never edit helper .py by hand):
curl -fsSL https://raw.githubusercontent.com/izzwgg-arch/connect-platform/cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067/scripts/pbx/install-vitalpbx-inbound-route-helper.sh -o /root/install-vitalpbx-inbound-route-helper.sh
bash /root/install-vitalpbx-inbound-route-helper.sh
```

(Re-running the installer refreshes `/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py` and **`connect-pbx-helper.service`** per script. It rewrites **`/etc/connect-pbx-helper.env`** but **preserves** the existing **`CONNECT_PBX_HELPER_SECRET`** when the file already exists — Connect’s **`PBX_ROUTE_HELPER_SECRET`** usually stays valid through the upgrade. Use step **5** to rotate a **compromised** secret or to align after a fresh install.)

**4. Verify local and remote `/health`**

```bash
# On PBX:
curl -s http://127.0.0.1:8757/health

# On Connect app host (SSH to app server):
curl -s http://209.145.60.79:8757/health
```

**5–6. Rotate compromised secret (PBX), restart helper**

```bash
# On PBX — generate a new ≥32-char secret (example: 32 bytes hex)
NEW_SECRET="$(openssl rand -hex 32)"
echo "New secret (store in password manager; paste into Connect env next): $NEW_SECRET"

# Update ONLY the CONNECT_PBX_HELPER_SECRET line in /etc/connect-pbx-helper.env
# Use nano/vi, or sed if you are careful:
sudo sed -i.bak "s/^CONNECT_PBX_HELPER_SECRET=.*/CONNECT_PBX_HELPER_SECRET=${NEW_SECRET}/" /etc/connect-pbx-helper.env
sudo chmod 0600 /etc/connect-pbx-helper.env

sudo systemctl restart connect-pbx-helper.service
sudo systemctl status connect-pbx-helper.service --no-pager
curl -s http://127.0.0.1:8757/health
```

**7. Update Connect env and redeploy api + worker (deploy queue only)**

On the **app** host, edit the platform env file that docker-compose loads (commonly **`/opt/connectcomms/env/.env.platform`** — **human operator only**; not agent-edited):

- Set **`PBX_ROUTE_HELPER_SECRET=`** to the **same** `NEW_SECRET` string.
- Leave **`PBX_ROUTE_HELPER_BASE_URL=http://209.145.60.79:8757`** unless you intentionally move the helper.
- **`PBX_ROUTE_HELPER_BY_INSTANCE_JSON`**: unchanged if unset; if you add it later, keep **`secret`** in sync.

Then enqueue **api** then **worker** (replace **`COMMIT_SHA`** with current production pin, e.g. **`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`**):

```bash
# On Connect app host:
curl -s http://127.0.0.1:3910/ops/deploy/status

cat >/tmp/enq_api.json <<EOF
{"service":"api","branch":"main","commitHash":"COMMIT_SHA","requestedBy":"human:ops-vm-helper","reason":"pickup PBX_ROUTE_HELPER_SECRET after rotation","dryRun":false,"source":"manual"}
EOF
curl -s -X POST http://127.0.0.1:3910/ops/deploy/enqueue -H 'Content-Type: application/json' -d @/tmp/enq_api.json

# Wait until job success, then:
cat >/tmp/enq_worker.json <<EOF
{"service":"worker","branch":"main","commitHash":"COMMIT_SHA","requestedBy":"human:ops-vm-helper","reason":"pickup PBX_ROUTE_HELPER_SECRET after rotation","dryRun":false,"source":"manual"}
EOF
curl -s -X POST http://127.0.0.1:3910/ops/deploy/enqueue -H 'Content-Type: application/json' -d @/tmp/enq_worker.json
```

Poll: `GET http://127.0.0.1:3910/ops/deploy/jobs/<id>` until **`success`**. Confirm log line **`[deploy-*] done <short-sha>`** matches **`COMMIT_SHA`** (`AGENTS.md`).

**8. Authenticated `POST /voicemail/spool/list`**

```bash
# On app host — use the SAME secret as PBX + Connect env
export PBX_ROUTE_HELPER_SECRET='paste-secret-here'
curl -s -X POST 'http://209.145.60.79:8757/voicemail/spool/list' \
  -H 'Content-Type: application/json' \
  -H "x-connect-pbx-helper-secret: ${PBX_ROUTE_HELPER_SECRET}" \
  -d '{"tenantId":"<VITALPBX_TENANT_ID>","extension":"<EXT>"}'
```

**9. Notify / worker fallback** — leave a test voicemail or POST `/internal/voicemail-notify` (with **`newCount > 0`** when REST empty). Inspect **`docker logs app-api-1`** / **`app-worker-1`** for structured fields (**`rest_count`**, **`helper_count`**, **`source_used`**, **`upserted`**).

#### C. Expected output (after each step)

| Step | Expected |
|------|----------|
| Local `/health` before upgrade | `"version":"2026.05.07.1"` (or older) |
| After installer + restart | `"version":"2026.05.08.1"` locally and from app host |
| After secret rotation + helper restart | `/health` still **`2026.05.08.1`**; wrong secret → **401** on POST |
| Authenticated POST spool list | **HTTP 200**, JSON with **`"ok":true`**, **`"messages":[...]`** (may be empty array if mailbox has no `msg*.txt`) |
| If route still missing | **404** body like **`not_found`** → wrong Python file still running; re-check installer commit and `systemctl status` |

#### D. Rollback plan

1. **PBX:** Restore **`vitalpbx-inbound-route-helper.py`** and **`/etc/connect-pbx-helper.env`** from **`/root/*.bak.*`**, then **`systemctl restart connect-pbx-helper.service`**. Verify `/health` returns previous version.
2. **Connect:** Restore previous **`PBX_ROUTE_HELPER_SECRET`** in **`.env.platform`**, enqueue **api** then **worker** again with same **`commitHash`**.
3. **Do not** delete voicemail spool files; **do not** run manual **`docker compose`** except break-glass per **`AGENTS.md`**.

#### E. Final verification checklist

- [ ] `curl -s http://209.145.60.79:8757/health` → **`2026.05.08.1`**
- [ ] Authenticated **`POST /voicemail/spool/list`** → **200**, not 404/401
- [ ] **`docker exec app-api-1 printenv PBX_ROUTE_HELPER_SECRET`** matches PBX **`CONNECT_PBX_HELPER_SECRET`** (compare securely, do not paste into tickets)
- [ ] **`voicemail-notify`** / worker logs: no **`helper_error:not_found`** when REST empty and spool has messages; **`helper_count > 0`**, **`source_used`** reflects helper, **`upserted > 0`** when applicable
- [ ] Portal/mobile voicemail **list** shows current rows (playback is **not** Phase 1 scope)

#### F. Execution environment (Cursor / local dev)

The steps in **§ A–E** are **operator-executed** on the PBX and Connect **app** host. A Cursor agent on a typical developer machine **cannot** complete them alone:

- **SSH** to `root@209.145.60.79` (or your sudo user) requires keys or VPN-approved access; without them, OpenSSH returns **`Permission denied (publickey,password)`**.
- **`http://209.145.60.79:8757`** may be **unreachable** from the public internet (UFW, bind to internal only, or routing) — `curl` can **time out** even when the helper is healthy on-loopback on the PBX.
- **Deploy queue** `http://127.0.0.1:3910/...` is only valid **on the app server** (loopback), not from a laptop.
- **`.env.platform`** is **human-managed**; agents must not edit it per **`AGENTS.md`**.

**After a human runs the runbook**, use the **operator execution transcript** below (strict paste-back; not the same as checklist table row **G**). Minimum ticket payload: `/health` JSON (version **`2026.05.08.1`**), **deploy job IDs**, **`[deploy-*] done <sha>`** lines, redacted **`POST /voicemail/spool/list`** proof, and voicemail-notify / worker log lines (**`helper_count`**, **`source_used`**, **`upserted`**). **Never paste secrets** — use booleans, lengths, or “matched offline”.

#### Operator execution transcript template (strict paste-back)

Copy the block into your ticket or internal doc. Replace `<…>` with values; leave secrets out (use **yes/no**, **redacted**, or **verified offline**).

```markdown
## Phase 1 voicemail helper — execution transcript

### Metadata
- **Operator:** <name>
- **UTC start / end:** <ISO8601> – <ISO8601>
- **Ticket / incident:** <link or id>

---

### 1. PBX helper host confirmation
- **`PBX_ROUTE_HELPER_BASE_URL`** (api): `<from docker exec app-api-1 printenv PBX_ROUTE_HELPER_BASE_URL>`
- **Same env (worker):** `<match yes/no + note if different>`
- **`PBX_ROUTE_HELPER_BY_INSTANCE_JSON`:** `<unset | set, length N chars — do not paste JSON secrets>`
- **SSH host used (actual login):** `<user@host or hostname>`
- **PBX loopback:** `curl -s http://127.0.0.1:8757/health` → `<paste JSON body>`
- **From Connect app host:** `curl -s http://<host-from-BASE_URL>:8757/health` → `<paste JSON body>`

---

### 2. Helper upgrade
- **Installer source commit:** `cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067` (confirm same) **yes/no**
- **Command run (summary):** `<e.g. bash /root/install-vitalpbx-inbound-route-helper.sh from raw GitHub URL>` — **no** env file contents
- **`/health` `version` after upgrade:** `<string>`
- **Expected `2026.05.08.1`:** **yes/no**

---

### 3. Secret rotation
- **Old `CONNECT_PBX_HELPER_SECRET` replaced on PBX:** **yes/no** (do **not** paste old or new value)
- **`connect-pbx-helper.service` restarted after change:** **yes/no**
- **`PBX_ROUTE_HELPER_SECRET` updated in Connect platform env** (e.g. `.env.platform`): **yes/no**
- **API + worker recycled via deploy queue only** (not ad-hoc docker): **yes/no**
- **PBX secret == Connect secret** (verified how?): `<e.g. compared hashes offline / Vault reference — no raw secret>`

---

### 4. Deploy queue evidence
- **Preflight** `GET /ops/deploy/status`: `<runningCount, note>`
- **API job ID:** `<uuid>`
- **Worker job ID:** `<uuid>`
- **Deployed SHA** (must match enqueue `commitHash`): `<full or short sha>`
- **API final log line** (`GET …/jobs/<id>/log`): `<paste [deploy-api] done … line>`
- **Worker final log line:** `<paste [deploy-worker] done … line>`

---

### 5. Helper route verification (`POST /voicemail/spool/list`)
- **Host:** `<same as BASE_URL>`
- **Auth:** header present **yes/no** (do **not** paste `x-connect-pbx-helper-secret`)
- **Body:** `tenantId`, `extension`, optional `voicemailContext` / `context` → `<values only>`
- **HTTP status:** `<e.g. 200>`
- **Response `ok`:** **true/false**
- **`messages` array length:** `<N>`
- **Mailbox/context exercised:** `<e.g. extension 101, context …>`

---

### 6. Voicemail fallback verification (structured logs)
- **`voicemail-notify` log line** (api): `<paste one JSON or grep line>`
- **Worker voicemail sync line:** `<paste one line>`
- **`rest_count`:** `<number>`
- **`helper_count`:** `<number>`
- **`source_used`:** `<string>`
- **`upserted` (or upserted_count):** `<number>`

---

### 7. Product verification
- **Web app voicemail list** shows new message: **yes/no** `<note>`
- **Mobile app voicemail list** shows new message: **yes/no** `<note>`
- **Playback tested:** **not part of Phase 1** | **tested separately** `<if applicable, note>`

---

### 8. Failure checklist (tick any that applied; else “none”)
- [ ] **404** on spool list → old helper / route missing (`/health` still `2026.05.07.x`)
- [ ] **401** on spool list → secret mismatch (PBX vs api/worker env)
- [ ] **`helper_count` 0** → wrong mailbox/extension/context, helper can’t see spool, or **no `msg*.txt` files**
- [ ] **`upserted` 0** with **`helper_count` > 0** → dedupe / row already exists (not always failure)
- [ ] **No notify/worker log lines** → api/worker not restarted, wrong **`PBX_ROUTE_HELPER_*`**, or no triggering AMI/notify
```

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

**Read-only snapshot (2026-05-08 UTC, app host → helper):** production **api/worker** had **`PBX_ROUTE_HELPER_BASE_URL=http://209.145.60.79:8757`**; **`PBX_ROUTE_HELPER_BY_INSTANCE_JSON`** unset (length 0). **`GET http://209.145.60.79:8757/health`** returned **`2026.05.07.1`** (Phase 1 route not present → **`helper_error:not_found`** until upgrade). **`GET http://209.145.62.75:8757/health`** returned no body from the app host (helper not listening there, blocked, or wrong target). **Operator:** confirm which VitalPBX owns **`209.145.60.79`** vs MOTD IP on the server you SSH into; align **BASE_URL** with the host where **`connect-pbx-helper`** runs. **Upgrade path:** pinned **`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`** installer from git only (§ **upgrades: pinned installer only**); re-probe **`/health`** until **`2026.05.08.1`** — if it stays **`2026.05.07.x`**, the install did not take; do not patch Python by hand. **Post-upgrade note:** operators may see **`2026.05.08.1`** on **PBX loopback** while the app host still gets **`Connection refused`** on **`<pbx-ip>:8757`** — default **loopback bind**; see § **listen bind**.
**Post-bind note:** once the app host reaches **`/health` `2026.05.08.1`**, a **`POST /voicemail/spool/list`** that returns **401** **`unauthorized`** indicates **secret skew** (PBX **`CONNECT_PBX_HELPER_SECRET`** vs Connect **`PBX_ROUTE_HELPER_SECRET`**), not a missing route — see § **app-host smoke**.

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
