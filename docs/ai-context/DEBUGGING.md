# DEBUGGING

> Read `CURSOR_START_HERE.md` first. Read-only diagnostics found in the codebase.
> All commands listed here are **non-mutating**. Anything not directly verifiable is
> marked **UNKNOWN — verify before changing.**

---

## Health endpoints found in code

| Service | Path | What it returns |
|---|---|---|
| `apps/api` | `GET /health` | **Liveness** — process up; **`{ ok: true }`** when the HTTP server responds. |
| `apps/api` | `GET /ready` | **Readiness** — **`200`** when accepting real traffic (listening + DB + not draining); **`503`** with reason while booting or after SIGTERM drain. Deploy script gates cutover on this **with no JWT** (same global JWT bypass as **`/health`** in `apps/api/src/server.ts`). **`401` on `/ready` blocks blue/green** — the probe never sees a healthy candidate. On the host: **`curl http://127.0.0.1:3001/ready`** (stable) or **`...:3004/...`** (candidate). Through the browser edge, use the same path nginx maps to **`/ready`** on the upstream (often under **`/api/...`** — confirm **`location`** and alias/strip prefixes). |
| `apps/api` | `GET /metrics` | Prometheus (admin auth required, see `server.ts`). |
| `apps/api` | `GET /admin/sbc/status` | Live SBC probe (super-admin). |
| `apps/api` | `GET /voice/sbc/status` | Tenant-admin SBC view incl. active upstream + masked targets. |
| `apps/api` | `GET /mobile/android/latest` | Android APK manifest (public). |
| `apps/portal` | `GET /ready` | Deploy readiness only — **`{ ok: true }`** with **`Cache-Control: no-store`**. No auth/DB. Loopback gates in **`scripts/lib/deploy-portal-rollout.sh`** (**`:3005`** candidate, **`:3000`** stable). Public edge only if nginx routes **`/ready`** to **`connect_portal_active`** (optional). |
| `apps/realtime` | `GET /health` | `{ ok: true }` |
| `apps/telephony` | `GET /health` | Health from `HealthService.getHealth()` (status, AMI/ARI, active counts). |
| `apps/telephony` | `GET /metrics` | Prometheus. |
| `apps/telephony` | `GET /telephony/health` | Same as `/health`, JWT-authed. |

## Forensic / diagnostic endpoints found in code

`apps/telephony` (always exposed; no debug flag required):

| Path | Notes |
|---|---|
| `GET /diagnostics` | `HealthService.getDiagnostics()` — store stats, raw vs derived counts, overcount detection. |
| `GET /forensic` | `?pbx=N&kpi=N&rows=N` — single-shot mismatch capture incl. health + diagnostics + forensic + sample of active calls. |
| `GET /telephony/calls` | Active calls, tenant-filtered by JWT. |
| `GET /telephony/extensions` | BLF list, tenant-filtered. |
| `GET /telephony/queues` | Queue list, tenant-filtered. |
| `GET /telephony/snapshot` | `SnapshotService.getSnapshot(tenantId)`. |
| `GET /telephony/diag` | Full unfiltered store + BLF + tenant map. JWT required (any role). |
| `GET /cdr-stats` | CDR ingest counters since container start. |
| `DELETE /cdr-stats` | Reset CDR stats. |
| `GET /healing/status` | `HealingEngine` status. |
| `GET /healing/log?maxAgeMs=...` | Recent healing actions. |

### PBX reboot — telephony recovery (read-only checks)

1. Prefer verifying **without** restarting Connect: after VitalPBX/Asterisk returns, AMI **5038** and ARI **8088** must accept connections from the telephony container.
2. Poll **`GET /health`** on telephony (`http://telephony:3003/health` from Docker, or the operator-facing URL). Watch **`pbxLinkState`**: expect **`reconnecting`** while AMI is down, then **`healthy`** once AMI and ARI probes succeed ( **`degraded`** is normal if ARI lags briefly behind AMI).
3. In telephony logs, grep **`pbx_reconnect_success`** / **`pbx_connection_lost`** / **`pbx_resubscribe_success`**. If the PBX is up but **`pbx_reconnect_success`** never appears for AMI, check AMI credentials, `manager.conf`, or firewall to **5038**.
4. **`ami.lastTrafficAt`** should advance during idle PBX (Ping/Pong and other responses). If **`ami.connected`** is true but **`pbxLinkState`** flips to **`stale`**, treat as a possible half-open TCP path — capture network evidence before code changes.
5. Portal live calls and BLF ultimately require AMI events; extended ARI outage alone yields **`degraded`**, not a dead dashboard.

`apps/api`:

| Path | Notes |
|---|---|
| `GET /pbx/live/combined` | Tenant `summary` (incomingToday, outgoingToday, internalToday, missedToday). UNKNOWN current path naming — verify with Grep. |
| `GET /admin/pbx/live/combined` | Admin aggregate of the same. |

`ops/deploy-queue` (server-only, `127.0.0.1:3910`):

| Path | Notes |
|---|---|
| `GET /ops/deploy/status` | runningCount, idle/active state. |
| `GET /ops/deploy/jobs` | Recent jobs. |
| `GET /ops/deploy/jobs/:id` | Job detail. |
| `GET /ops/deploy/jobs/:id/log?lines=200` | Job log tail. |

### Worker image vs API billing source

`apps/worker` imports `createBillingInvoice` from `apps/api/src/billing/invoiceEngine` (runtime copy inside the worker image). If only `apps/api/src/billing/**` changes, a **worker** deploy must still **rebuild** the image or monthly invoice jobs can run a stale engine. **`scripts/lib/deploy-common.sh`** → **`_deploy_common_service_paths`** for **`worker`** includes **`apps/api/src/billing/`** plus **`scripts/deploy-worker.sh`** and **`scripts/lib/deploy-common.sh`** so billing edits and rebuild-detection script edits both invalidate skips. **`deploy-worker.sh` re-sources `deploy-common.sh` after `git-sync`** so the **checked-out tree’s** globs are used when diffing (**not** the stale in-memory `_deploy_common_service_paths` from before checkout). Symptom of a mistake: **`[deploy-worker] … skipping build/restart`** with **`unrelated_paths`** right after billing changes shipped on **api**.

---

## API CPU — nginx access log + Prometheus (no env profiler)

When **`CONNECT_API_PROFILE`** is not enabled, you can still find **route hammering**
from the edge and from in-process counters:

1. **Nginx** — default access log path is typically **`/var/log/nginx/access.log`**
   (see `access_log` in **`/etc/nginx/nginx.conf`**). Aggregate **`$request_uri`**
   (or the path field in your log format) with **`awk` / `sort` / `uniq -c`**. Filter
   **`4xx`/`5xx`** with **`$9`** (status field position depends on format — confirm with
   **`tail -n 3`** first). Correlate **User-Agent** and **Referer** for desktop vs mobile.
2. **Prometheus** — from the app host: **`curl -sS http://127.0.0.1:3001/metrics`**
   (bind address per `docker-compose.app.yml`) and **`grep connect_api_request_duration_seconds_count`**.
   Series are **counters since API process start** — pair with **`process_start_time_seconds{service="api"}`**
   for rates.
3. **Case study (2026-05):** Connect Desktop **`@connect/desktop`** hit **`/api/voice/voicemail?...`**
   and **`/api/admin/sms/provider-health`** on the **same 30 s** cadence from
   **`DesktopNotificationsBridge`** — fixed in portal by valid voicemail query + tenant
   SMS inbox for notifications + per-probe backoff (**`apps/portal/lib/desktopNotificationPoll.ts`**).
4. **PBX / helper CPU (2026-05):** dense **`POST /voicemail/spool/list`** bursts on **`connect-pbx-helper`** during **`app-worker-1`** scheduled **`voicemail-spool-reconcile-summary`** cycles (full-fleet enumeration). Mitigation: adaptive **`setTimeout`** scheduler + optional **probe skip** + **`sinceOrigtime`** narrowing + env throttles — see **`VOICEMAIL_FLEET_STALE_RISK.md`** §5 and **`TELEPHONY.md`** §Voicemail. Verify with **`journalctl -u connect-pbx-helper`** and worker JSON (**`helper_calls`**, **`skipped_probe_no_new`**, **`next_reconcile_delay_ms`**).

---

## API CPU spike — profiling HTTP hot routes (`app-api-1`)

Use this when **`app-api-1` CPU is high** and you need to know **which HTTP paths**,
**which client IPs**, and **rough latency** — without guessing from PBX or ARI.

### Existing metrics (no extra env)

- **`GET /metrics`** on the API (admin-auth as implemented in `server.ts`) exposes
  histogram **`connect_api_request_duration_seconds`** with labels **`method`**, **`route`**,
  **`status`**. In Prometheus/Grafana, rank by **`rate(...[5m])`** or **`increase`** and
  inspect high-count **`route`** label values.

### Temporary structured profiler (env-gated)

Implemented in **`apps/api/src/apiRequestProfiler.ts`**, installed from `server.ts`.
**Default off** — no per-request noise in production.

| Env | Effect |
|-----|--------|
| **`CONNECT_API_PROFILE=1`** | Every **10 s**, one **`pino`** line with **`msg":"api_request_profile_summary"`** and **`topRoutes`** (count, avgMs, maxMs) plus **`topClientIps`**. Grep logs for **`api_request_profile`**. |
| **`CONNECT_API_PROFILE_EACH=1`** | **Also** log **one line per completed request** with **`msg":"api_request_profile"`** (method, route template, status, durationMs, ip, truncated user-agent, `userId`/`tenantId`/`role` when JWT ran, `authKind`, optional `content-length`). **Very noisy** — enable only for a short diagnostic window. |

**Does not log:** bodies, Authorization values, cookies, or full URLs with query strings
(sensitive tokens sometimes appear in `?token=` for media downloads — only the path
prefix is logged on per-request lines).

**Deploy:** set env on the **API** container only, redeploy **api** via the deploy queue,
watch logs, then **remove** the env flags.

### Production log commands (read-only)

```bash
# Last 20 minutes — API container (JSON logs; adjust time)
docker logs app-api-1 --since 20m 2>&1 | grep api_request_profile | tail -200

# If logs are plain / single-line without jq, still useful:
docker logs app-api-1 --since 20m 2>&1 | grep -E '"(GET|POST|PUT|PATCH|DELETE) ' | tail -100
```

If nginx writes an **access log** with `$request_method`, `$request_uri`, `$status`,
`$remote_addr`, and `$http_user_agent`, aggregate there for **p95** (API logs above
expose **avg/max over 10 s windows** from the profiler, not full p95).

### Likely high-frequency callers (code pointers — verify with profiler)

- **Mobile** — React Query `refetchInterval` on chat / threads (e.g. multi-second
  intervals in `apps/mobile/src/screens/tabs/ChatTab.tsx`).
- **Internal** — `/internal/*` and shared-secret routes (CDR ingest, voicemail notify,
  mobile ring, telephony map); correlate **`authKind":"internal_path"`** in per-request
  mode or infer from **`topRoutes`** shape.
- **Portal PBX dashboard** — `apps/portal/app/(platform)/pbx/page.tsx` uses a **60 s**
  combined refresh tick; if `/pbx/live/combined` still dominates, check **how many**
  concurrent browser sessions / tenants are open.
- **Auth storms** — many **401/429** on the same route + IP (use status in per-request
  mode or extend summary later if needed).

**Do not** disable features or change polling until **`topRoutes`** / **`topClientIps`**
identifies the offender.

---

## PBX CPU spike — profiling Connect → Asterisk / VitalPBX traffic

Use this when Asterisk/VitalPBX CPU is high and you suspect **Connect** (not human
dial volume alone).

### Single ARI reader (implemented 2026-05-12)

- **`apps/telephony`** `AriBridgedActivePoller` is the **only** component that should
  poll **`GET /ari/bridges`**, **`GET /ari/channels`**, and **`GET /ari/endpoints`**
  on a steady interval (default **5 s**, env-tunable; min **3 s** unless debug).
- After each poll, telephony writes a **short-lived JSON snapshot** to **Redis**
  (key `connect:telephony:ariBridged:v1:<pbxHost>`; TTL default **15 s**). Requires
  **`REDIS_URL`** on the telephony container (same Redis URL as API/worker is fine).
- **`apps/api`** `/pbx/live/*` reads that snapshot first via `fetchAriSliceForPbxLiveFromRedisOrAri`
  (`pbxLiveAriSlice.ts`). **Direct Vital ARI** runs only when the snapshot is missing/stale,
  during **backoff** recovery it may return a **stale** snapshot instead of hammering ARI,
  or when **`?directAri=1`** on `/pbx/live/diagnostics` / env **`PBX_LIVE_DIAGNOSTICS_DIRECT_ARI=true`**.

### What still hits the PBX (code-backed)

| Source | Mechanism | Rough cadence | PBX surface |
|--------|-----------|----------------|-------------|
| `apps/telephony` | `AriBridgedActivePoller.tick` | **`ARI_BRIDGED_ACTIVE_POLL_MS`** (default **5 s**) | ARI bridges + channels + endpoints |
| `apps/telephony` | `AmiClient` keepalive | **30 s** | AMI `Ping` |
| `apps/telephony` | `TelephonyService.refreshExtensionPresence` | **3 min** | AMI `ExtensionStateList`, `PJSIPShowContacts` |
| `apps/telephony` | `PbxTenantMapCache` | **60 s** | HTTP to **Connect API** (not Asterisk) |
| `apps/api` | Direct ARI fallback | **Rare** — snapshot miss/stale, diagnostics force, or cold start | Same ARI URLs via `VitalPbxClient` (deduped per PBX host + 5 s backoff on failure) |
| `apps/api` | `startPbxLiveDashboardWarm` | **30 s** | Mostly **Redis + DB**; direct ARI only if snapshot unusable |
| `apps/worker` | CDR / voicemail / MOH | See `SERVICES.md` | Vital REST / telephony HTTP (unchanged) |

### Verifying ARI reduction after deploy

1. **`CONNECT_PBX_PROFILE=1`** on telephony + api (briefly). Expect telephony
   `pbx_outbound_profile` at **~1 / poll interval**, not per HTTP request.
2. API logs: **`pbx_outbound_profile`** should be **absent** during normal dashboard
   polling when Redis snapshot is fresh; look instead for **`pbx_live_ari_direct_fallback`**
   if something forces direct ARI.
3. Redis: `GET connect:telephony:ariBridged:v1:<PBX_HOST>` should exist and refresh
   while telephony is healthy.

### Env-gated structured logs (`CONNECT_PBX_PROFILE`)

Set on the **telephony** and/or **api** container (compose env or stack env), then
redeploy or restart only those services per `AGENTS.md`:

- `CONNECT_PBX_PROFILE=1` (or string `true`)

Telephony logs **`pbx_outbound_profile`** from `AriBridgedActivePoller` (includes
`pollIntervalMs`). The API logs **`pbx_outbound_profile`** only when the **direct ARI**
path runs. **Disable after a short capture.**

### Production / container commands (read-only)

```bash
docker compose -f docker-compose.app.yml ps
docker logs --since=15m app-telephony-1 2>&1 | rg "pbx_outbound_profile|ari_bridged_active_poll_failed"
docker logs --since=15m app-api-1 2>&1 | rg "pbx_outbound_profile|pbx_live_ari_direct_fallback|pbx_live"
docker logs --since=30m app-telephony-1 2>&1 | rg -c "pbx_outbound_profile" || true
```

### Rollback / operations notes

- Revert env: remove `REDIS_URL` from telephony **or** stop telephony snapshot writes —
  API will fall back to direct ARI (higher load).
- Emergency faster poller: **`ARI_BRIDGED_ACTIVE_POLL_DEBUG=true`** and
  **`ARI_BRIDGED_ACTIVE_POLL_MS=1000`** on telephony only (not a default).

---

## Billing API 403

Symptoms: portal **Billing** or **Invoices** loads but API returns **`403`** with **`forbidden`** (sometimes **`permission`** from the global JWT hook).

1. **Tenant paths** (`/billing/settings`, `/billing/platform/invoices`, … from `billing/routes.ts`): decode JWT **`role`**. Must be one of **`SUPER_ADMIN`, `TENANT_ADMIN`, `ADMIN`, `BILLING_ADMIN`, `BILLING`**. Also confirm **`portalPermissionSet`** from **`GET /me`** includes **`can_view_billing_overview`** (prefix rule for `/billing` in `server.ts`).
2. **Platform Admin Billing** (`/admin/billing/overview`, `/admin/billing/platform/tenants`, …): JWT **`role`** must be **`SUPER_ADMIN`** — tenant admins get **403** by design. Portal should hide **Admin Billing** unless `backendJwtRole === "SUPER_ADMIN"` (see `navConfig.ts` / admin billing page).
   - **Nav missing Admin Billing while `GET /me` shows `role: SUPER_ADMIN`:** Old or stripped JWTs may omit the **`role`** claim. **`backendJwtRole`** used to come only from the decoded token, so Admin Billing stayed hidden. **`AppProvider`** (`apps/portal/hooks/useAppContext.tsx`) syncs **`role`** and **`backendJwtRole`** from **`/me`** when **`me.role`** is present. **Workaround** without deploying portal: **logout and login** to mint a JWT that includes **`role`**. Permanent behavior is **`/me`** role sync after load.
3. **Email jobs from billing:** `EmailJob.invoiceId` is set when **`queueBillingEmail`** passes **`invoiceId`** (`buildBillingEmailJobCreateData` in `billingAuth.ts`). If jobs lack `invoiceId`, grep callers of **`queueBillingEmail`**.
4. **Portal vs API mismatch:** Tenant billing pages under **`/billing/*`** should use **`PermissionGate`** with **`can_view_billing_*`** keys aligned to **`navConfig.ts`** (overview, invoices, payments, receipts). If the nav shows Billing but the page shows “no access”, the user’s role is missing that portal permission even though JWT **`role`** may still allow the API — compare **`GET /me`** permissions to the gate on the page.
5. **Invoice PDF vs branding:** PDF route **`GET /billing/platform/invoices/:id/pdf`** loads **`tenant.billingSettings`** for header/footer text. If the PDF still shows only the tenant name, confirm migration applied and **`invoiceCompanyName`** / footer columns exist on **`TenantBillingSettings`**. **Logo URL** affects **HTML emails only**; a non-https URL is dropped by **`sanitizeInvoiceLogoUrl`** in `invoiceBranding.ts`.

---

## SOLA / Cardknox billing webhook (`POST /webhooks/sola-cardknox`)

1. **Webhook URL:** Must be **`https://<your-api-host>/webhooks/sola-cardknox`** — the Billing Settings UI shows the exact string from **`PUBLIC_API_BASE_URL`** / **`PUBLIC_API_URL`**. If SOLA never hits Connect, confirm the vendor URL matches byte-for-byte (no trailing slash unless your base URL includes one), TLS is valid, and firewalls allow SOLA’s IPs (vendor docs).
2. **PIN / signature mismatch (`403` + `invalid_signature`):** Connect compares **`ck-signature`** (and Sola HMAC when applicable) using the tenant’s saved **Webhook Verification PIN** (or env fallback in **`solaGateway.ts`**). Regenerate or re-paste the same PIN in both Connect and the SOLA postback security screen. After changing PIN in Connect, save settings again; empty PIN in **Production** is rejected on save and on **Enable**.
3. **HTTP codes:** **`400`** + `missing_event_id` — no **`eventId` / `xRefNum`** after parse, or billing apply returned **`missing_correlation`**. **`403`** + `invalid_signature` — header/body verification failed (see above).
4. **DB:** Inspect **`BillingEventLog`** (e.g. `webhook.deduped`, `webhook.signature_rejected`, `payment_failed`, `payment_succeeded`) and **`PaymentTransaction`** for the invoice — **declined (`D`) and error (`E`)** rows should still exist alongside logs.
5. **Correlation:** Confirm webhook **`xInvoice`** matches a charge (**`CONNECT:tenantId:invoiceId:…`**) or legacy **`invoiceNumber` / id**; confirm **`processorTransactionId`** / idempotency keys store **`xRefNum` / `xRefNumber` as strings**.
6. **Double pay:** If a duplicate webhook fired, expect **`webhook.deduped`** (or an existing **`PaymentTransaction`** matching the dedupe OR clause) — see **`buildBillingWebhookDedupeOrClause`** in `solaBillingPayments.ts`.

Reference: **`docs/ai-context/BILLING.md`** § SOLA / Cardknox and § SOLA setup (operators).

---

## Billing emails & dunning

1. **Processor:** **`apps/api/src/server.ts`** polls **`EmailJob`** (`QUEUED`, `nextRunAt`) and sends via tenant (or fallback) **`EmailProviderConfig`**. Billing jobs are created only from **`billing/routes.ts`**, **`billingEmailLifecycle.ts`**, **`solaBillingPayments.ts`** (no SOLA calls inside the email layer).
2. **Trace an invoice:** `EmailJob` where **`invoiceId`** = BillingInvoice id and **`type`** in (`BILLING_INVOICE_SENT`, `BILLING_PAYMENT_LINK`, `BILLING_RECEIPT`, `BILLING_PAYMENT_FAILED`, …). Match **`BillingEventLog`** types above; **`receipt_emailed`** / **`payment_failed_emailed`** rows use **`message`** = **`PaymentTransaction.id`** for dedupe.
3. **Dunning:** **`BillingInvoice.metadata.dunning`** — **`dunning_scheduled`** / **`dunning_exhausted`** events. Worker **`runBillingDunningRetries`** (6h) + env **`BILLING_DUNNING_MAX_ATTEMPTS`**, **`BILLING_DUNNING_RETRY_DELAY_HOURS`**.

---

## Useful log locations (from repo references)

- **Server-side container logs**: `docker logs --since=10m <container>` (read-only is
  fine; `docker compose ps` to list).
- **Deploy worker logs**: `/var/log/connect-deploys/...` on the server.
- **API process logs**: stdout via `docker logs api`. Mentioned in `_app-api-last40m.log`
  (committed dump) — UNKNOWN how it was captured.
- **PBX read-only audit wrapper**: `scripts/pbx/install-pbx-audit-wrapper.sh` +
  `scripts/pbx/pbx_readonly.sh` + `scripts/audit-moh-readonly.sh` +
  `scripts/audit-vm-greeting-readonly.sh`. SSH `cursor-audit@PBX_HOST` runs a forced
  read-only audit script (mentioned in `LIVE_CALL_FORENSIC_RUNBOOK.md`).
- **`pbx_audit@` (the wrapper at `scripts/pbx/pbx_readonly.sh`) — invocation gotchas**
  (verified 2026-05-06):
    - The forced-command wrapper only accepts an exact-match allowlist of 14
      commands. There is **no** `cat /var/log/asterisk/full`, no `verbose`, no
      `pjsip set logger`, no AMI tail, no `cdr show`, no general `mysql`
      query. Per-call dialplan tracing through this account is impossible.
    - SSH host: **`209.145.60.79` port 22** (the older `~/.ssh/config` entry
      pointing at port 2222 is stale; that port is firewalled). Use
      `ssh -i ~/.ssh/PBX-Read -p 22 pbx_audit@209.145.60.79 '<allowed cmd>'`.
    - On Windows OpenSSH, the wrapper rejects the canonical
      `asterisk -rx "pjsip show contacts"` form (PowerShell mangles the inner
      double quotes). Use **single quotes inside the SSH double-quoted string**:
      `ssh ... "asterisk -rx 'pjsip show contacts'"`. The wrapper's
      `sed s/'/"/g` normalization then matches the allowlist entry. The `help`
      keyword can also fail on Windows — a real allowlisted command is the
      reliable way to verify access.
    - Useful baseline captures (cross-tenant / killed-app diagnosis):
      `pjsip show contacts`, `pjsip show endpoints`, `core show channels concise`,
      `database show connect`, `dialplan show connect-tenant-ivr`, plus
      `cat /etc/asterisk/extensions__60_custom.conf`.
    - **`journalctl -u connect-pbx-helper -n 80` and
      `tail -20 /var/lib/connect-pbx-helper/audit.jsonl` are NOT call-flow
      logs.** They are the helper service's own HTTP access log and RBAC
      audit trail (e.g. `voicemail/greeting/get`). They contain no inbound
      DIDs, no dialplan steps, no INVITE traces. Do not interpret a quiet
      audit.jsonl as evidence about a call — it can only confirm the helper
      itself was/wasn't asked to do voicemail/greeting/IVR-publish work.
    - For per-call evidence the wrapper is **not** sufficient; escalate to a
      privileged session that can read `/var/log/asterisk/full` (do **not** add
      that path to `pbx_audit` — it would expose every call, voicemail, and
      auth challenge on the box). Alternative for routing-only forensics:
      VitalPBX's own CDR API (`/api/v2/cdr`), which Connect already calls
      via `apps/worker/src/main.ts::runPbxCdrSyncCycle`. That route is
      tenant-scoped and never exposes call audio or auth secrets.
- **Mobile native logs**: `scripts/android/vm-record-logcat-live.ps1`,
  `scripts/android/summarize-vm-record-log.ps1`,
  `scripts/mobile-android-live.ps1`,
  `scripts/android-live-capture.ps1`,
  `scripts/android-live-debug.ps1`,
  `scripts/android-logcat-clear.ps1`.
- **Phase A vm-record deploy (2026-05-07, evidence reference).**
  Successful Phase A API deploy `ad842f0e-721f-45b8-afe2-5976ce710673`
  to commit `f910e6d`. The deploy queue's clone at `/opt/connectcomms/app`
  did carry one unrelated dirty file (`apps/telephony/src/.../CallStateStore.ts`)
  but it did NOT block this deploy because the conflict-bearing
  `git checkout` only fails when the dirty path overlaps with the
  target commit's changed paths. Phase A only modified
  `apps/api/src/vmRecordCall*.ts` + `docs/ai-context/*`, none of which
  collided with the dirty telephony file, so the checkout succeeded
  and the post-deploy `grep` inside `app-api-1` confirmed the new
  strings were present. Use this as the canonical clean-success
  example when contrasting with the 2026-05-06 telephony stale-code
  failure already documented in `AGENTS.md`.
- **`mobile-push: device fan-out` (Phase A.5).** Every call to
  `sendPushToUserDevices` (any payload type) emits this structured
  Pino info line BEFORE Expo dispatch. Fields:
  - `payloadType` — `INCOMING_CALL`, `INCOMING_CALL_WAKE`,
    `INVITE_CANCELED`, `INVITE_CLAIMED`, `MISSED_CALL`, `voicemail`,
    `missed_call`, `dm_message`, `sms_message`.
  - `includeInactiveDevices` — `true` only on vm-record's
    `INCOMING_CALL_WAKE` path; `false` for every other caller.
  - `totalRowsFound` — `MobileDevice` rows returned by the where query
    (already scoped to tenant + user).
  - `activeRowsCount` — subset where `active=true`. When
    `includeInactiveDevices=false`, this equals `totalRowsFound`.
  - `rowsMissingToken` — subset where `expoPushToken` is null/empty.
    Surfaced for diagnostic only — not filtered out (Expo handles
    invalid tokens per-ticket and the existing
    `DeviceNotRegistered` → `active=false` flow still applies).
  - `afterExclude` — final count after `excludeDeviceId` removal;
    this is the number sent to Expo and the value `queued` returns
    for non-simulated sends.
  Use this line to tell apart "no devices on file" vs "devices on
  file but all stale" vs "device excluded". For vm-record specifically
  this is the line that explains a `wake_sent_but_not_registered`
  error code.
- **`vm-record-call: helper returned direct_pjsip channelSource` (Phase B regression detector).**
  After Phase B (2026-05-07) the PBX helper always returns
  `channelSource: dispatch_local:<base>[,hint]`. If the API ever logs
  this warn line, the helper running on the PBX is older than
  `2026.05.07.1` and the originate is bypassing the
  `[connect-vm-greeting-dispatch]` Dial fan-out. Recovery: re-run
  `bash scripts/pbx/install-vitalpbx-inbound-route-helper.sh` on the
  PBX host as root, then verify
  `curl http://127.0.0.1:8757/voicemail/greeting/diag | jq -r .version`
  reports `2026.05.07.2` or later. The
  `dispatchShowOutput` field of `/voicemail/greeting/diag` should
  contain
  `Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^...))`.
- **Voicemail greeting written to wrong directory (Phase C fix, 2026-05-07).**
  Symptom: `POST /voicemail/greeting/record-call` completes (job reaches
  `state=saved` or `verify_timeout`), but calling in plays the generic
  VoiceMail prompt instead of the recorded greeting.
  Root cause: VitalPBX names each tenant's voicemail context after the
  tenant slug (`test-voicemail`, not `21` or `T21`). The helper used to
  resolve candidates in the wrong priority order.
  Diagnostic steps:
  1. Check which context VitalPBX uses:
     `asterisk -rx "voicemail show users" | grep 101`
     → look for `test-voicemail 101 ...` (context is the first column).
  2. Check the AstDB context key (present after Phase C):
     `asterisk -rx "database show connect_vm_context"`
     → should show `T21_101 = test-voicemail`.
  3. Check the helper's `/voicemail/greeting/get` response:
     `curl -s -X POST http://127.0.0.1:8757/voicemail/greeting/get \
       -H 'Content-Type: application/json' \
       -d '{"tenantId":"21","extension":"101","greetingType":"unavailable"}' | jq`
     → `pbxPath` should resolve to
     `/var/spool/asterisk/voicemail/test-voicemail/101/unavail.wav`.
  4. After recording, verify the file:
     `ls -la /var/spool/asterisk/voicemail/test-voicemail/101/unavail.wav`
  Recovery: re-run the installer — `bash scripts/pbx/install-vitalpbx-inbound-route-helper.sh`.
  Helper version must be `2026.05.07.2` or later. The helper logs
  `astdb_vm_context: key=T21_101 context=test-voicemail` to stderr on
  each vm-record originate when the context is resolved successfully.
- **Voicemail Call-to-Record (`POST /voicemail/greeting/record-call`):**
  the API now emits three structured log lines per attempt that together
  classify the mobile-wake outcome:
  - `vm-record-call: mobile wake decision` — fires once. Fields:
    `deviceRowCount`, `activeDeviceCount`, `endpointAlreadyAvail`,
    `matchedEndpoints`, `decision` (`send_wake` or `skipped_no_devices`).
    A `skipped_no_devices` here means the user has zero `MobileDevice`
    rows for the tenant — verify with `SELECT COUNT(*) FROM "MobileDevice"
    WHERE "tenantId"=$1 AND "userId"=$2`. **Do not** read this line as
    evidence about the SIP originate path — that's still upstream of
    this decision.
  - `vm-record-call: mobile wake push sent` — fires after FCM dispatch.
    Fields: `pbxCallId`, `devicesNotified`, `deviceRowCount`. If
    `devicesNotified=0` while `deviceRowCount>0`, the user has stale
    push tokens (`MobileDevice.expoPushToken IS NULL`) — escalate to
    re-registration on the device.
  - `vm-record-call: mobile wake registration outcome` — fires after
    the 12s readiness poll. Fields: `registered` (boolean),
    `registrationState`, `waitedMs`. `registered=false` after a wake
    means the device received the push but JsSIP didn't reach
    `REGISTERED`; this maps to error code
    `wake_sent_but_not_registered` and should not be retried by an
    agent — ask the user to unlock and try again.
  - The job's public-view (`GET /voicemail/greeting/record-call/:jobId`)
    `wake` block exposes the same diagnostic fields plus
    `endpointAlreadyAvail` for portal-side debugging.
  - **vm-record mobile answer disconnect (Phase E, 2026-05-08 fix).**
    Symptom: user taps Answer on mobile vm-record IncomingCallScreen, call
    disconnects within 1–2 seconds, no recording prompt is heard. API log
    shows `POST /mobile/call-invites/vmr-<jobId>/respond` followed by a
    rapid `sip.hangup()` from the mobile.
    Root cause: the `/respond` endpoint returned
    `{ code: "INVITE_ALREADY_HANDLED", status: "UNKNOWN" }` because no
    `callInvite` DB row exists for `vmr-*` IDs (intentional design).
    `NotificationsContext.tsx` checked `status === "ACCEPTED"` to bypass
    the reject branch; got `"UNKNOWN"`; called `sip.hangup()`.
    Fix: `server.ts` `/respond` now returns `{ ok: true, code: "INVITE_CLAIMED_OK" }`
    for `vmr-*` ACCEPT requests. See `KNOWN_ISSUES.md` § "Phase E".
    If this regression reappears, look for the log line:
    `[ANSWER_PIPELINE] CLAIM_DONE code=INVITE_ALREADY_HANDLED`
    immediately after `CLAIM_START` on the mobile logcat. That pattern
    means the short-circuit is not firing — verify the API is on the
    post-Phase-E deploy and that `isSyntheticVmrInviteId` is exported
    from `vmRecordCallHelpers.ts`.
- **Trace dumps committed at root**: `trace3.txt` … `trace15-gap.txt`,
  `logcat-cancel.txt`. These are historical; recapture when investigating.
- **Android incoming call UI — Phase D (2026-05-07).**
  Symptom: user sees a Samsung/T-Mobile-style native phone call screen
  instead of (or in addition to) the Connect `IncomingCallScreen`, and
  answering from the native screen does not connect the call.
  Root cause: `TelecomBridge.startIncomingCall()` dispatched a
  SELF_MANAGED Telecom call before the SIP INVITE existed; the Telecom
  answer fired before JsSIP's `answerIncoming()` could find a session.
  **Fix deployed 2026-05-07**: Telecom dispatch disabled in
  `IncomingCallFirebaseService.handleIncomingCallNative()`. All calls
  now go through CallStyle notification + FSI.

  **Logcat filters for this path:**
  ```
  adb logcat -s IncomingCallService ConnectCallFlow
  ```
  After Phase D, every non-foregrounded call must log:
  ```
  [CALL_INCOMING] telecom_dispatch skipped (disabled) inviteId=<id>
  [CALL_INCOMING] presentation_decision locked=... fullScreen=true
  [CALL_INCOMING] posted incoming call notification mode=full_screen
  ConnectCallFlow: {"stage":"NATIVE_NOTIFICATION_POSTED",...}
  ```
  If you see `TELECOM_INCOMING_DISPATCH` in the logcat, the dead-code
  `if (false)` guard has been accidentally re-enabled — revert the
  `IncomingCallFirebaseService.java` change.

  **If calls still show native phone UI after Phase D:**
  1. Verify the APK was rebuilt after the Java change (`pnpm mobile:build:android:release`).
  2. Check whether `react-native-callkeep` is calling
     `VoiceConnectionService`. Search logcat for
     `VoiceConnectionService` — if it appears, a JS code path is calling
     `RNCallKeep.displayIncomingCall()`. The only Android path that does
     this is the synthetic-invite backgrounded/locked guard at
     `NotificationsContext.tsx` line ~1422. Verify
     `Platform.OS !== "android"` guards are intact at lines ~3656, ~3691,
     ~3727, ~3790.
  3. To roll back to Telecom: in `IncomingCallFirebaseService.java`,
     change `if (false)` back to `if (!appInForeground && !inActiveCall)`
     and remove the `if (false)` guard. Rebuild.

- **Missed call notifications (2026-05-07, updated native fix).**
  Symptom: user misses a call and no notification appears in the Android
  notification tray.
  Root cause: the API sends `MISSED_CALL` as a data-only FCM push (no
  `notification` field) so the native service can stop the ringtone. Android
  never shows a system notification for data-only pushes. Data-only pushes also
  do NOT trigger Expo's JS `addNotificationReceivedListener`, so an earlier fix
  in `NotificationsContext.tsx` was unreachable.
  Fix (v2): `IncomingCallFirebaseService.handleCallTerminationNative()` now
  calls `postMissedCallNotification()` for `type == "MISSED_CALL"` which posts a
  native `NotificationCompat` banner (title "Missed call", body "Missed call
  from …") on channel `connect-missed-calls` (notification ID range 52000–61000).
  Verify: miss a call → logcat shows `missed_call_notif_posted` →
  notification appears on device → tap opens app.
  **Logcat filter:**
  ```
  adb logcat -s IncomingCallService | grep -i "missed_call"
  ```
  Expected log: `[MISSED_CALL] missed_call_notif_posted notifId=52xxx caller=+1...`
  If no notification appears:
  1. Confirm `connect-missed-calls` channel exists and is not muted:
     `adb shell dumpsys notification --noredact | grep connect-missed-calls`
  2. Confirm POST_NOTIFICATIONS permission granted:
     `adb shell dumpsys package com.connectcommunications.mobile | grep POST_NOTIFICATIONS`
  3. Check logcat for `missed_call_notif_failed` to see the exception.

- **Contact import permission not appearing (2026-05-07).**
  Symptom: user taps Import Contacts, nothing seems to happen (no Android
  permission dialog, or modal opens but tapping "Continue" does nothing).
  Root cause: on Android 12+, calling `requestPermissionsAsync()` asynchronously
  inside a Modal's `useEffect` (after the triggering gesture has already been
  consumed) silently fails — no system dialog appears.
  Fix: `ContactTab` now calls `checkContactsPermission()` +
  `requestContactsPermission()` directly inside the import button's `onPress`
  handler, then passes the result as `initialPermission` to the modal.
  Verify: fresh install or permission-revoked device → tap Import Contacts →
  Android permission dialog appears immediately → grant → modal loads contacts.

- **Contact import succeeds in UI but zero rows saved (2026-05-12).**
  Symptom: preview lists phone contacts; after Import, summary shows many failures
  or `forbidden` in Metro / `adb logcat` / failure lines in the result panel.
  Root cause: `POST /contacts` was gated with `canManageCustomerWorkflow` (only
  SUPER_ADMIN / ADMIN / BILLING / SUPPORT) while `GET /contacts` allowed normal
  staff roles — mobile users could **view** the directory but not **create** rows.
  Fix: `POST /contacts` now uses `canCreateContacts` (same roster as directory
  viewers except READ_ONLY). Verify: sign in as USER or MANAGER → import one
  contact → `GET /contacts` (or pull-to-refresh in app) shows the new external
  contact; API must be deployed after this server change.

- **Contact import progress stuck at “0 of N” (2026-05-12).**
  Symptom: preview shows hundreds of contacts; after tapping Import, the sheet
  stays on the progress view with **0** completed for a long time (or forever).
  Common causes: (1) the UI counted **in-flight** uploads as done before the
  first `POST /contacts` returned, so React often still painted **0** while the
  first slow/hung network call blocked the serial loop; (2) **no fetch timeout**,
  so a wedged TCP connection never failed; (3) an **unhandled throw** in the
  import path left the sheet on the importing step with no error panel.
  Fix: progress increments **only after each contact finishes** (success, skip,
  duplicate, or failure); **parallel pool** (4) so work continues if one request
  stalls; **45s AbortController timeout** per `POST /contacts`; `runImport`
  wrapped in `try/catch` so unexpected errors surface on the error step.
  Verify with Metro / `adb logcat`: look for `[contacts_import] import_contact_done`
  lines advancing; failures log `import_failed`. Filter:
  `adb logcat | grep contacts_import`

- **Android release APK: contact import verification without Metro (2026-05-12).**
  Only the **release** artifact (`gradlew assembleRelease` / `pnpm mobile:build:android:release`)
  ships **`assets/index.android.bundle`** with the production JS bundle. A **debug**
  install often contains **`expo_dev_launcher_android.bundle`** only, so patched
  import diagnostics will not appear there. USB checklist: `adb devices -l` →
  `adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk` →
  `adb logcat -c` → launch `com.connectcommunications.mobile` → operator runs
  **Import from phone** through **Import(N)**. Pull logs, for example:
  `adb logcat -d -t 30000 | findstr /i "contacts_import ReactNativeJS"`.
  Expected sequence: `final_import_button_rendered` → `final_import_button_pressed` →
  `runImport_entered` → `import_contact_done` (repeats) → `import_complete`. Then
  confirm **External** list, force-stop + reopen persistence, and second import
  increases counts. **Do not run `scripts/android-publish.ps1` until that chain
  passes on a real device**; publishing requires SSH to the `connect` host (see
  `DEPLOYMENT.md` § Mobile builds). After an API change to `/mobile/android/latest`,
  enqueue an **`api`** deploy so `versionCode` / `buildId` from the manifest are served.

- **SMS chat back navigation (2026-05-07).**
  Symptom: inside an SMS/DM chat, pressing the Android hardware back button
  navigates to the Team tab instead of returning to the chat list.
  Root cause: `ChatTab` is a bottom-tab screen with no stack; React Navigation
  defaulted to the previous tab on back press when `activeThread !== null`.
  Fix: `ChatTab` registers a `BackHandler` when a thread is open, returning
  `true` (consumed) and calling `setActiveThread(null)`.
  Verify: open any SMS thread → press hardware back → returns to thread list,
  not to Team tab.

---

## Useful npm / pnpm scripts found

From `package.json`:

| Script | Purpose |
|---|---|
| `pnpm dev` | Run `turbo run dev --parallel` across services (local dev). |
| `pnpm build` | Turbo build all. |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | Standard. |
| `pnpm db:generate` / `pnpm db:migrate` | Prisma generate + dev migrate (LOCAL). |
| `pnpm smoke:pbx:v1.1.0` / `pnpm smoke:pbx` | `node scripts/smoke-v1.1.0.mjs`. |
| `pnpm audit-pbx` | `node scripts/pbx-live-observe.mjs`. |
| `pnpm mobile:start` | Expo dev server. |
| `pnpm mobile:start:dev-client` / `:usb` | Dev client. |
| `pnpm mobile:dev-live` / `:live-capture` / `:live-debug` / `:logcat-clear` | Android live debug helpers. |
| `pnpm mobile:android` | `expo run:android`. |
| `pnpm mobile:build:android:release` | PowerShell builder. |
| `pnpm mobile:android:ship` | PowerShell ship script. |
| `pnpm mobile:setup-and-build:android` | Setup + release build. |
| `pnpm mobile:ios` | `expo run:ios`. |
| `pnpm desktop:dev` / `desktop:build` | Electron. |
| `pnpm build:changed` | `bash scripts/build-changed.sh`. |
| `pnpm smoke:fast` | `bash scripts/smoke-fast.sh`. |

Per-service:

- `apps/api`: `pnpm --filter @connect/api dev` (tsx watch). PBX scripts:
  `pbx:diagnose`, `pbx:enable-instances`, `pbx:diagnose-by-name`, `pbx:link-tenant`,
  `pbx:link-all-tenants`, `pbx:set-ombu-mysql`.
- `apps/telephony`: `pnpm --filter @connect/telephony smoke` runs `tsx src/smoke.ts`.
- `apps/mobile`: `pnpm --filter @connect/mobile test:vm-greeting`.

---

## Suggested read-only diagnostics flow

1. **Always start with**: `GET /telephony/health` and `GET /telephony/diagnostics`.
2. For active-call mismatches: `GET /telephony/forensic?pbx=N&kpi=N&rows=N` plus
   the PBX read-only audit (`ssh cursor-audit@PBX_HOST`).
3. For deploy issues: `GET /ops/deploy/status` then `GET /ops/deploy/jobs?status=...`
   then `GET /ops/deploy/jobs/:id/log?lines=2000`.
4. For mobile call bugs: pull `mobileDeviceCallWakeDiagnostics` and
   `callWakeEventTimeline` rows by `userId`+`tenantId`+time window. Pair with
   `[CALL_TIMELINE]` log lines from telephony / api / worker.
5. For **voicemail ingestion** (new messages missing from web/mobile but calls work):
   1. **Worker** — `docker logs app-worker-1 --timestamps --since 24h | grep voicemail-sync`.
      Logs are **JSON** per cycle with `rest_count`, `helper_count`, `helper_calls`,
      `source_used`, `fallback_reason`, `upserted_count`. Legacy plain-text lines may
      still appear in older builds. `records=0` and `errors=0` for a long window means
      every polled extension got an **empty** REST payload (unless helper fallback
      populated `helper_count`).
   2. **Fast path** — `docker logs app-telephony-1 ... | grep MessageWaiting` and
      `docker logs app-api-1 ... | grep voicemail-notify`. Notify logs include
      `rest_count`, `helper_count`, `source_used`, `upserted_count`, `fallback_reason`.
      `upserted:0` with `rest_count:0` and no helper success means nothing was ingested.
      If the JSON body includes `fallback_reason` like `helper_error:not_found`, first
      `curl -s http://127.0.0.1:8757/health` on the **PBX** — version must be **`2026.05.08.1`+**
      or the spool route does not exist yet (re-run installer from pinned commit; `DEPLOYMENT.md`).
      **`404`** on `POST /voicemail/spool/list` against the PBX means the same (old helper binary).
      **Do not** patch helper Python on the PBX — re-run the **pinned**
      `install-vitalpbx-inbound-route-helper.sh` from git (**`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`**)
      and confirm **`/health`** flips to **`2026.05.08.1`** (`DEPLOYMENT.md` § installer only).
      **`Connection refused`** / **HTTP 000** from the **app host** to **`<pbx-ip>:8757`** while
      loopback **`127.0.0.1:8757/health`** on the PBX shows **`2026.05.08.1`** → helper is likely bound
      to **loopback only**; set **`CONNECT_PBX_HELPER_BIND=0.0.0.0`** (address only, not **`0.0.0.0:8757`**)
      + **`CONNECT_PBX_HELPER_PORT=8757`**, **`systemctl restart connect-pbx-helper`**, then on PBX
      **`ss -lntp | grep 8757`** — expect **`0.0.0.0:8757`** before blaming “Connect is wrong.”
      If listen is correct but app host still refused → **firewall / path** (`DEPLOYMENT.md` § listen bind).
      For production when **BASE_URL** is **`http://209.145.60.79:8757`** and **`/health`** is still **`2026.05.07.x`**, follow **`DEPLOYMENT.md`** § **Phase 1 — operator handoff** (commands, rollback, checklist). Diagnosis from a dev laptop may hit **SSH denied** or **curl timeout** to **`:8757`**; use the **app host** or **PBX loopback** as in the runbook (**`DEPLOYMENT.md`** § **execution environment**). After a rollout, require the operator **paste-back transcript** (**`DEPLOYMENT.md`** Phase 1 **operator execution transcript**) before closing “Phase 1 live” — no raw secrets.
      After **secret rotation**, if the helper returns **401**, re-check `x-connect-pbx-helper-secret`
      matches **`CONNECT_PBX_HELPER_SECRET`** / **`PBX_ROUTE_HELPER_SECRET`** and that **api** and **worker**
      were restarted with the new env.
      If **`/health`** from the **app host** is **`2026.05.08.1`** but **`POST …/spool/list`** is still **401**,
      the PBX **`CONNECT_PBX_HELPER_SECRET`** does not match Connect — not a routing/version problem
      (`DEPLOYMENT.md` § **app-host smoke**). Compare **`sha256sum`** of **api** vs **worker** env to confirm
      Connect-side consistency (do **not** paste raw secrets). **Preferred fix:** copy Connect’s
      **`PBX_ROUTE_HELPER_SECRET`** into PBX **`/etc/connect-pbx-helper.env`**, restart helper — see
      **`DEPLOYMENT.md`** § **helper secret alignment only** (avoid blind dual rotation).
      If operators **believe** PBX was updated but **401** persists, check **duplicate env keys**, **quotes**,
      **CRLF/trailing spaces**, and that **systemd** loads the file you edited (`DEPLOYMENT.md` § **Troubleshooting: still 401**).
      Live **`/internal/voicemail-notify`** lines with **`helper_error:unauthorized`** confirm the API’s helper
      client still sees **401** — same root cause as manual **`curl`** from the app host.
      **Fingerprint without pasting secrets:** app-host **`docker exec`** length + **`sha256sum`**, PBX **`/etc/connect-pbx-helper.env`**
      + **`/proc/<pid>/environ`** same — **`DEPLOYMENT.md`** § **Secret mismatch fingerprints**.
      When fixed, **`POST …/spool/list`** → **200**; worker JSON may show **`helper_count` > 0** and
      **`fallback_reason":"rest_empty_used_spool_fallback_fair_schedule"`** (worker; legacy
      **`rest_empty_used_spool_fallback`** on older builds) (**`DEPLOYMENT.md`** recorded verification).
   3. **Super-admin incidents** — open **`VoicemailIngestIncident`** rows (helper errors, notify upsert zero, worker global zero, REST vs spool) appear in **`GET /admin/ops-center`** and **`GET /admin/incidents`**, with detail/ack at **`GET/POST /admin/voicemail-ingest/incidents*`** (`API_ROUTES.md`). Disable emission with **`VOICEMAIL_INGEST_INCIDENTS_ENABLED=false`** on **api** + **worker** if needed for rollback.
   4. **Which PBX runs the helper?** Compare **`PBX_ROUTE_HELPER_BASE_URL`** (api/worker env) to the
      IP/hostname on the VitalPBX you SSH into. From the **app** host, `curl -s http://<candidate>:8757/health`
      for each suspect IP. If MOTD shows **`209.145.62.x`** but Connect points at **`209.145.60.x`**, you may
      be hitting the wrong machine — fix **BASE_URL** (and redeploy api/worker via queue), or install the
      helper on the host Connect actually calls (`DEPLOYMENT.md` § Phase 1 verification A′).
   5. **Helper smoke** (on PBX host, read-only): `curl -s -X POST http://127.0.0.1:8757/voicemail/spool/list \
      -H 'content-type: application/json' -H 'x-connect-pbx-helper-secret: <secret>' \
      -d '{"tenantId":"<vitalpbx_tenant_id>","extension":"<ext>"}' | jq .`
      Expect `ok`, `mailboxPath`, `messages[]`. Requires installer `VERSION` `2026.05.08.1`+.
   6. **Do not diagnose VitalPBX with query-only `?tenant=`** — production uses the
      **`tenant` header** (`VitalPbxClient` default). Mismatched probes falsely implied
      missing extensions in past incidents.
   7. **Confirm ID** — for a mailbox from AMI (`mailbox` + `context` in `MessageWaiting`),
      ensure `Extension` / `PbxExtensionLink.pbxExtensionId` matches
      `GET /api/v2/extensions` **with the correct tenant header** (see `TELEPHONY.md`).
   8. **When spool fallback runs (and when it does not).** `runVoicemailSyncCycle` and
      `/internal/voicemail-notify` call `POST /voicemail/spool/list` only after VitalPBX REST
      `voicemail_records` returns **zero rows** for that mailbox. The worker **fair-schedules**
      helper calls across tenants (interleave + rotating cursor, cap
      `VOICEMAIL_HELPER_FALLBACK_MAX_PER_CYCLE`); see `voicemail-sync-ext` JSON for
      `helper_scheduled`, `skipped_reason` (e.g. `helper_not_scheduled_this_cycle`), and
      `fair_cursor_next`. If REST returns **any** rows — even a **stale or incomplete**
      subset vs disk — Connect **does not** reconcile against spool in the current code path.
      Symptom pattern: PBX has many `msg*.txt` under the tenant’s voicemail context, Connect
      shows **some** or **zero** rows, worker logs show `rest_count > 0` and `helper_count: 0`
      for that extension. **Validate** with item **9** (counts) before treating as a UI-only bug.
      When REST is genuinely empty and helper still never fires, check helper version/secret/bind
      (items **2** / **5**), missing `TenantPbxLink.pbxTenantId`, and `mailboxPath` in helper JSON.
   9. **PBX files vs Connect DB (evidence, last 24h).** Do **not** close “ingestion broken”
      without both sides:
      - **Postgres** (read-only): `SELECT "tenantId", extension, COUNT(*) FROM "Voicemail" WHERE "deletedAt" IS NULL AND "receivedAt" >= NOW() - INTERVAL '24 hours' GROUP BY 1, 2 ORDER BY 1, 2;`
        Compare to a **working** tenant and a **reported-broken** tenant (same window).
      - **Mapping:** `SELECT id, "tenantId", "pbxTenantId", status FROM "TenantPbxLink";` and
        `Extension` + `PbxExtensionLink` for affected mailboxes — wrong `pbxExtensionId` or null
        `pbxTenantId` skips helper paths or REST scope.
      - **PBX disk** (on VitalPBX, read-only): under `/var/spool/asterisk/voicemail/`, locate the
        tenant’s Asterisk context (e.g. `voicemail show users` / greeting diag — `TELEPHONY.md`),
        then `find <context>/<ext> -name 'msg*.txt' -mtime -1` (or `-newermt`) for **24h** message
        sidecars. Count should **correlate** with Connect rows after sync lag (60s worker + notify).
      - **Logs:** worker JSON `voicemail-sync-cycle` — `exts_checked`, `rest_count`, `helper_calls`,
        `helper_count`, `upserted_count`, `errors`, `fallback_reason`, `fair_needy_mailboxes`,
        `fair_helper_picks`, `fair_cursor`; per-mailbox **`voicemail-sync-ext`** (toggle with
        `VOICEMAIL_SYNC_EXT_JSON_LOGS`); api `voicemail-notify` — `extension_not_found`,
        `helper_error:*`, `upserted_count`. **Cap:** at most **`VOICEMAIL_HELPER_FALLBACK_MAX_PER_CYCLE`**
        (default **32**) **distinct** helper calls per cycle, **fairly** distributed across tenants.
   9a. **Fleet mismatch audit + idempotent backfill (worker container on app host).** Fair scheduling
      prevents **ongoing** helper starvation across cycles; it does **not** guarantee every historic
      spool message appeared in Connect during a past incident window. For a **production-wide**,
      evidence-based recovery: run **`voicemail-spool-audit.ts`** (read-only SELECTs + helper list), then
      **`voicemail-spool-backfill.ts`** (idempotent upsert), then **re-audit**. All commands:
      **`docker exec app-worker-1 …`** on the Connect app host — **not** on the PBX. Exact CLI,
      summary fields (`mailboxes_scanned`, `mailboxes_with_missing_7d`, `total_missing_7d`,
      `helper_errors`), `--all-tenants` / `--tenant-ids-file`, acceptance, and “not fixed by backfill”
      cases are in **`DEPLOYMENT.md`** § **Voicemail — operational recovery (audit + backfill)**.
      If mismatches remain after backfill, use per-row `audit_error` plus items **8–10** here
      (REST-non-empty, mapping, duplicate `extNumber`, `deletedAt`, invalid `origtime`) — cite log/row
      JSON, not guesses.
   9b. **Fleet stale-risk (not only 7d “missing” rows).** `voicemail-spool-audit.ts` can be **green**
      while a tenant is still stale (helper path drift, stale list subset, REST-non-empty skipping helper,
      default **inbox-only** API hiding **Old/Urgent** rows). Run **`voicemail-fleet-stale-report.ts`**
      inside **`app-worker-1`** for a ranked, fleet-wide view (`newest_pbx` vs `newest_db` vs inbox-scoped
      DB, baseline volume). Failure-class write-up and hardening backlog: **`VOICEMAIL_FLEET_STALE_RISK.md`**.
   9b′. **Scheduled spool reconcile (insert-only, durable pipeline).** Complements the **60s**
      `voicemail-sync-cycle` (REST-first, capped helper fallback). Worker logs one JSON line per run:
      **`docker logs app-worker-1 --since 2h | grep voicemail-spool-reconcile-summary`**. Fields include
      **`unhealthy`**, **`total_inserted`** (missing rows repaired), **`pagination_incomplete_mailboxes`**,
      **`schema2_violation_mailboxes`** (helper not listing with **`spoolListSchema: 2`**),
      **`helper_version_ok_global`**, **`stale_high_risk_increased`**, **`top_risky_mailboxes`**. Last run
      snapshot: **`docker exec app-worker-1 bash -lc 'cd /app/apps/worker && pnpm run vm-reconcile-last'`**
      (reads Redis key **`connect:worker:vmSpoolReconcile:lastSummary`**). Env: **`VOICEMAIL_SPOOL_RECONCILE_INTERVAL_MS`**
      (default **900000**; **`0`** disables), **`VOICEMAIL_SPOOL_RECONCILE_MAILBOX_DELAY_MS`**, **`VOICEMAIL_SPOOL_RECONCILE_MIN_HELPER_VERSION`**
      (default **`2026.05.10.1`**), **`VOICEMAIL_HELPER_HEALTH_TIMEOUT_MS`**. Details: **`VOICEMAIL_FLEET_STALE_RISK.md`** §5.
   9c. **Voicemail list visibility (row exists in Postgres; portal/mobile does not show).** After
      ingestion/backfill are ruled out, compare **one** `Voicemail.id` (or `pbxMessageId`) end-to-end:
      - **DB:** `folder`, `deletedAt` (must be **null** for list), `tenantId`, `extension`, `listened`, `receivedAt`.
      - **API:** `GET /voice/voicemail` in **`apps/api/src/server.ts`** — default **`folder=inbox`** (only
        **`inbox` \| `old` \| `urgent`**); **`take=100`**, **`page`**, **`orderBy: receivedAt desc`**; non-admin users
        are scoped to the **`Extension`** whose **`ownerUserId`** matches the JWT (`API_ROUTES.md`).
        Reproduce with the **same JWT** and query string the client uses.
      - **Portal** (`apps/portal/.../voicemail/page.tsx`): fetches all three folders with the same **`page`**;
        **“New”** tab hides **`listened`**; **“Old”** includes **`folder=old` OR age heuristic**; search/date filters
        can exclude rows. Use **pagination** when **`total > 100`** for a folder.
      - **Mobile** (`apps/mobile/src/api/client.ts` **`getVoicemails`**): must load **all pages per folder** (API
        page size **100**); historically **page 1 only** hid messages past the first **100** in a folder — fixed
        by client-side paging up to **`VOICEMAIL_MAX_PAGES_PER_FOLDER`** (**`voicemailPagination.ts`**). Filters
        on **`VoicemailTab`** (**new** / **urgent** / **old**) mirror portal semantics.
   10. **`/internal/voicemail-notify` extension resolution.** The handler calls
      **`resolveExtensionForVoicemailNotify(mailbox, context)`** (`apps/api/src/voicemailNotifyResolveExtension.ts`):
      all **ACTIVE** rows for `extNumber === mailbox`, then disambiguates with AMI voicemail **`context`**
      against **`TenantPbxLink` + `PbxTenantDirectory`**. **Single match** → ingest; **multiple tenants +
      matching context** → one row; **ambiguous / `default` with duplicates** → **skip** with
      `notifyResolveReason` (no cross-tenant push). Logs: **`voicemail-notify: extension not resolved`**
      with **`notifyResolveReason`**. **List/stream isolation:** `GET /voice/voicemail` and stream routes
      enforce JWT tenant + mailbox rules in **`server.ts`** (see **`KNOWN_ISSUES.md`** voicemail privacy bullet).
   11. **Playback** — for `src_unsupported` / cannot play: hit
      `GET /voice/voicemail/:id/stream?token=...` with curl `-I` and inspect status,
      `Content-Type`, and body size. **`206 Partial Content`** is normal when the client sends **`Range`**;
      the API implements **`sendBufferWithOptionalRange`** (`apps/api/src/httpVoicemailRange.ts`).
      `503` + JSON means upstream audio/recfile failure,
      not a client codec limitation alone. After **Phase 2** (helper **`2026.05.08.2`+**, **api**
      deployed), successful **spool fallback playback** returns **`200`**, **`Content-Type: audio/*`**
      (often **`audio/mpeg`** after transcode). **API** logs may include
      **`voicemail: helper_audio_fallback`** with **`helper_audio_fallback: true`** (no paths).
      On-PBX smoke: authenticated **`POST /voicemail/spool/audio`** with JSON
      **`tenantId`**, **`extension`**, **`folder`** (`INBOX` \| `Old` \| `Urgent`), **`msgNum`**
      (`msg[0-9]+`) → **200** raw audio (`TELEPHONY.md`, **`DEPLOYMENT.md`** § Phase 2).
      If **`/health`** is still **`2026.05.08.1`**, the audio route is absent — upgrade the helper first; **`grep helper_audio_fallback`**
      inside **`app-api-1`** only proves **api** shipped Phase 2 (`DEPLOYMENT.md` **Recorded Phase 2 — api shipped**).
      **Operator install:** exact **`curl` + `bash`** for **`209.145.60.79`** is in **`DEPLOYMENT.md`** § **Phase 2 — operator handoff**.
      **App-host smoke (secret not printed):** from **`ssh connect`**, use **`docker exec app-api-1 printenv PBX_ROUTE_HELPER_SECRET`** only inside a remote script (do not **`echo`**). Call **`spool/list`** to pick a real **`msgNum`**, then **`POST …/voicemail/spool/audio`** — **200**, **`audio/wav`**, non-empty body (**`DEPLOYMENT.md`** recorded verification). Invalid stem **`not-a-msg`** → **400** **`invalid_msgNum`**. **`docker logs app-api-1`** for **`helper_audio_fallback: true`** after playing a spool-backed row.
   11b. **Post-deploy voicemail privacy proof (operator checklist).** After queue
      **`api`** + **`portal`** (`AGENTS.md`), run the **proof matrix** and paste results
      into the release ticket: (1) **T1 / ext 101** JWT cannot **`GET /voice/voicemail`**
      or **`GET /voice/voicemail/:id/stream`** rows belonging to **T2 / 101**; (2) symmetric
      for **T2**; (3) same tenant **USER** on **102** cannot list/play **103**; (4) **tenant
      admin** can list/play any mailbox in **their** tenant only; (5) **super admin**
      **`GET /voice/voicemail`** without **`tenantId`** or with **`tenantId=global`** → **400**
      **`tenant_required`**; (6) **`curl -I`** on stream → **200**; **`curl -I -H "Range: bytes=0-3"`**
      → **206** + **`Content-Range`**; wrong user's token → **403** JSON (no audio body).
      **Notify:** **`docker logs app-api-1`** — **`voicemail-notify: extension not resolved`**
      must include **`notifyResolveReason`**; push should only hit **`ownerUserId`** for the
      resolved extension. Push is **opt-in:** set **`VOICEMAIL_PUSH_NOTIFICATIONS_ENABLED=true`**
      on **api** to enable; when unset, push stays **off**. **List forensics:** grep **`[VOICEMAIL_LIST_SCOPE]`**
      — confirms **`sub`**, **`scopedMailboxesForUser`**, **`returnedPageRows`**, **`totalMatching`** per request.
      **Mobile still wrong after API deploy:** confirm a **fresh mobile build** — old apps could show
      **cached voicemails** from another login (see **`KNOWN_ISSUES.md`** React Query leak). **Call history parity:** super-admin **`GET /calls/history`**
      without **`tenantId`** is still fleet-wide by design — see **`KNOWN_ISSUES.md`** chat/history audit bullet.
   12. Optional sanity: `GET /pbx/live/combined` where available; correlate with
      `voicemail` rows + `connectCdr.recordingPath` for recording issues.
6. For SMS issues: `db.smsMessage`, `db.providerHealth`, BullMQ queue depth via
   `redis-cli LLEN bull:sms-send:wait`. Worker logs show
   `sms job completed` / `failed`.

### Failed inbound-to-mobile call: identifying which call actually failed

When a user reports "outside call didn't ring my killed mobile", **PBX-read alone
is not enough** — the `pbx_audit` allowlist has no historical view (no
`/var/log/asterisk/full`, no AMI tail, no CDR query, no general MySQL). Use
existing Connect data instead:

1. **`GET /calls/history`** (`apps/api/src/server.ts:20843`) reads
   `connectCdr` and is populated for **every** inbound call the PBX sees, not
   only Connect-managed DIDs (the `apps/worker` `runPbxCdrSyncCycle` mirrors
   VitalPBX's full CDR table every ~2 min, in addition to live ingest via
   `/internal/cdr-ingest`). Filter by `startDate`, `endDate`,
   `direction=incoming`, then look at `fromNumber`, `toNumber`, `dcontext`,
   `linkedId`, `disposition`, `rawLegCount`. The route auto-translates
   `vpbx:<slug>` ↔ Connect cuid so the row will appear regardless of which
   format the CDR row uses.
2. **`GET /mobile/wake/timeline`** (`server.ts:25111`) reads
   `callWakeEvent` rows. Filter by `pbxCallId=<linkedId>` to see whether
   `pbx_dialplan` ever emitted `WAKE_REQUESTED` for that specific call;
   absence of any `pbx_dialplan`-source row proves the wake API was not
   invoked (which is normal for a non-Connect-managed DID, since
   `connect-dial-with-wake` only runs for DIDs with a
   `connect/didmap/<e164>/tenant` AstDB entry).
3. The `dcontext` value on the CDR row distinguishes Connect-managed
   (`connect-tenant-router`, `connect-tenant-ivr`, `connect-dial-with-wake`)
   from VitalPBX-native flow (e.g. `from-internal`, `ext-did`,
   `from-did-direct`). This is the deciding evidence for "did this call ever
   touch Connect's wake path".
4. AOR-precision (which contact got the INVITE: `T<id>_<ext>` desktop AOR vs
   `T<id>_<ext>_1` mobile AOR) is **not** preserved reliably in CDR; for that
   you need `/var/log/asterisk/full` or AMI history. Do not pretend CDR can
   answer that.

**Why this matters**: the PBX-read pass for an inbound failure can only
confirm live state (current contacts/registrations/channels) — never the
identity of a specific past call. Always run step 1 before drawing any
conclusion about which DID was dialed.

### Telephony service: confirming whether `MobilePushNotifier` actually fired

When CDR shows `PJSIP/T<id>_<ext>_1` in `channelsSeen` but no `CallInvite`
row, no `CallWakeEvent` row, and `MobileDevice.lastPushSentAt` did not
advance, the FCM push was suppressed inside the telephony service. The
authoritative log lives in the `app-telephony-1` container; access via the
production app server:

```powershell
ssh -o ConnectTimeout=10 -o BatchMode=yes connect `
  "docker logs app-telephony-1 --since=10m 2>&1 | grep '<linkedId>'"
```

Look for these `MobilePushNotifier` log lines, in order of severity:

- `mobile-ring: notifying API` — push WAS sent to `apps/api`. Pair with
  `app-api-1` log `mobile-ring-notify: push sent` to confirm FCM dispatch.
- `mobile-ring: suppressed outbound self-ring (extension dialed external from same AOR)`
  — push was **explicitly suppressed** for an **outbound** external dial whose
  `extensions`/channels expose **desktop + mobile** AOR siblings for **one**
  subscriber. **Company DID Caller-ID:** hard phones often send **10-digit** `CallerIDNum`
  while still ringing `PJSIP/T<id>_<ext>` + `…_<ext>_1`; `MobilePushNotifier` now
  **infers `selfOriginatingExt` from SIP peers** when CID does not shorten to **`2–6` digits**.
  **`direction:"inbound"` here is NOT automatically stale**: see the next bullet
  for **`mobile-ring: suppressed mislabeled inbound …`** (**2026-05** onward).
  Older only: pre-`b5f8a43` logs sometimes showed suppressed self-ring alongside
  `direction:"inbound"` for VitalPBX IVR inbound — see **`KNOWN_ISSUES.md`**. The legacy
  text `"mobile-ring: suppressed same-extension outbound self-ring"` in current logs is
  a stale-image signal.
- `mobile-ring: suppressed mislabeled inbound (desk outbound self-ring)`
  accompanies JSON fields **`reason: "outbound_same_extension_family"`**,
  **`sourceAor`/`targetAor`**, **`callerExt`/`targetExt`**. The aggregator still carried
  `direction:"inbound"` (typically after ambiguous **`/^trk-[^-]+-in/`** CDR context) but AMI
  shows **short internal `from`/`source_extension`**, **PSTN-shaped `to`**, and Caller-ID **`from`**
  that is **not** PSTN-length — i.e. the desk extension “calling itself” phantom. Genuine
  inbound keeps **PSTN `from`** so this path stays **eligible for push**.
- `mobile-ring: notify-entry` with `exts:[]` and no later
  `notifying API` — extensions never resolved (helper-only legs); not a
  bug, the next AMI event will retry.

The `app-api-1` mate logs are also useful:

```powershell
ssh connect "docker logs app-api-1 --since=10m 2>&1 | grep -E 'mobile-ring-notify|<linkedId>'"
```

`mobile-ring-notify: received` proves the telephony→api hop happened;
absence proves the suppression was upstream of the API.

### Deploy queue: confirming a fix actually shipped

The deploy queue worker uses `scripts/lib/deploy-common.sh::deploy_common_git_sync`,
which historically could silently ship stale code if the shared clone at
`/opt/connectcomms/app` had uncommitted edits in a file your branch also
modified (see `KNOWN_ISSUES.md`). Current dry-runs perform a non-mutating
checkout-safety preflight and fail with exact dirty blocking paths before any
checkout, Docker, Prisma, restart, or health-check work. After any deploy whose
result matters, **still verify the commit landed inside the running container**
rather than trusting `status:"success"`:

```powershell
# 1. The deploy log's last line should read `done <expected-sha>`.
ssh connect "curl -s 'http://127.0.0.1:3910/ops/deploy/jobs/<jobid>/log?lines=400'" `
  | python -c "import sys,json; print(json.load(sys.stdin)['text'])" `
  | Select-String -Pattern '^\[deploy-\S+\] done '

# 2. Read the file inside the container and grep for the new code.
ssh connect "docker exec app-<service>-1 grep -n '<unique new line>' /app/<path>"
```

**Admin billing portal polish (Phase 8–9, display-only):** After a **`portal`** deploy, confirm SaaS polish classes shipped in the client bundle:

```bash
ssh connect "docker exec app-portal-1 sh -c 'grep -o billing-p8-skeleton /app/apps/portal/.next/static/chunks/*.js | head -1'"
ssh connect "docker exec app-portal-1 sh -c 'grep -o billing-inv-toolbar--sticky /app/apps/portal/.next/static/chunks/*.js | head -1'"
ssh connect "docker exec app-portal-1 sh -c 'grep -o billing-p8-drawer /app/apps/portal/.next/static/chunks/*.js | head -1'"
```

If a dry-run log shows `DRY RUN checkout safety: BLOCKED`, read the listed
paths and do not enqueue the real deploy until those production-clone edits are
reviewed, committed/ported, or explicitly restored.

**API health timeout (`DEPLOY_API_BLUEGREEN=1` default):** The **`api`** compose service no longer runs **`prisma migrate deploy`** at container boot; **`prisma migrate deploy`** runs in **`scripts/deploy-api.sh`** before **`api_candidate`** starts when schema changed. Stable boot is **`pnpm --filter @connect/api start`**. **`[timing] restart=`** captures the full blue/green sequence (candidate start → nginx cutovers → stable recreate → drain). If **`[deploy-api] FAIL`** references **`candidate /ready`** or **`stable /ready`**, read **`deploy-api-rollout`** log lines plus **`docker logs app-api-candidate-1`** or **`app-api-1`**. If logs show **`GET /ready`** → **`401`**, the rollout cannot succeed until **`/ready`** is exempt from JWT (same allowlist as **`/health`**). Rollout/recovery procedures: **`docs/ai-context/DEPLOYMENT_API_ROLLBACK.md`**.

Legacy **`DEPLOY_API_BLUEGREEN=0`:** queue still polls loopback **`http://127.0.0.1:3001/health`** after **`deploy_common_compose_up`**.

**Portal blue/green (`DEPLOY_PORTAL_BLUEGREEN=1` default):** Timing keys **`portal_candidate_*`**, **`portal_cutover_*`**, **`portal_stable_*`**, **`nginx_reload`**. Failures on **`candidate /ready`** or **`stable /ready`**: **`docker logs app-portal-candidate-1`** / **`app-portal-1`**. Recovery: **`docs/ai-context/DEPLOYMENT_PORTAL_ROLLBACK.md`**. Legacy **`DEPLOY_PORTAL_BLUEGREEN=0`** still uses **`http://127.0.0.1:3000/login`** (**`deploy_common_wait_http_2xx_3xx`**) after **`deploy_common_compose_up`**.

If **`[deploy-api] FAIL: health check failed after deploy`** appears at **`stage=health`**, when **`wait_http_ok`** exhausts its budget (~5 min) the job log contains three diagnostic sections — find them between **`stage=health`** and **`stage=rollback`**:

```
[deploy-common] wait_http_ok FAILED after 150 tries url=… http_code=… curl_exit=… body_snippet=… stderr_snippet=…
--- health failed: docker compose ps api ---
<compose ps output>
--- health failed: app-api-1 last 120 lines ---
<container stdout/stderr — prisma errors, tsx compile errors, startup crashes>
--- end health-failure container logs ---
```

`curl_exit=7` = connection refused (process not listening yet or crashed before bind). `curl_exit=28` = timeout. `http_code=000` = no HTTP response at all. If the container logs show a startup crash or `SyntaxError`/`TypeError`, the code is broken and the health timeout is a symptom, not the root cause. If logs show normal startup progress and no crash, the issue is purely a cold-start timing race.

If an older deploy queue log
shows `error: Your local changes to … would be overwritten by checkout …
Aborting` followed by `[deploy-common] stage=change-detect` (no fail-fast), the
deploy ran on the dirty pre-existing tree, **not** on your commit. Recovery:
SSH to the server and run
`cd /opt/connectcomms/app && git diff -- <path>` to capture the in-clone
changes (back them up locally first), then
`git checkout HEAD -- <path>` to restore only the file blocking your
deploy, then re-enqueue the deploy job. Do **not** wholesale-reset the
clone — other unrelated hand-edits may also exist there
(`KNOWN_ISSUES.md` lists the known ones).

**Worked example (voicemail ingest incidents, 2026-05-08):** `api` job
`465e0ebd-3d82-4d41-9021-0cb1093cb4a6` and `worker` job
`84e4b8d8-2d6d-434b-92d3-3a34d79548ec` targeting `55e9c20`. Each log’s last
line matched `[deploy-(api|worker)] done 55e9c20 requested_by=…`. The `api`
log showed `Applying migration 20260508183000_voicemail_ingest_incidents` and
`All migrations have been successfully applied`; host `curl
http://127.0.0.1:3001/health` returned `200`. In-container
`grep /admin/voicemail-ingest/incidents` on `apps/api/src/server.ts` matched
the new routes. Worker logs showed normal `voicemail-sync-cycle` JSON lines
after restart; `grep recordWorkerSyncGlobalZero` / `recordHelperIncident` on
`apps/worker/src/main.ts` confirmed incident hooks. Both jobs’ `git-sync`
still listed `M apps/telephony/.../CallStateStore.ts` — see `KNOWN_ISSUES.md`.

---

## PBX debugging notes (documentation only — do not run mutating commands)

- **PBX-host helper scripts**: live in `scripts/pbx/` and `docs/pbx/`. Most are
  installers (`install-connect-wake-dialplan.sh`, `install-prompt-sync.sh`,
  `install-vitalpbx-inbound-route-helper.sh`, `install-pbx-audit-wrapper.sh`).
  They are operator-run; do NOT run from agent shells against production.
- **AstDB inspection**: `pbx-diag-astdb.txt` is a captured snapshot. New captures
  go through `cursor-audit@` SSH — see runbook.
- **Dialplan custom contexts**: `docs/pbx/option-a-custom-context.conf` (M, modified
  locally — verify before deploying). Contexts referenced:
    - `[connect-tenant-router]` — reads `connect/t_<slug>/mode`, `dest_*`.
    - `[connect-tenant-ivr]` — Phase 2 prompts + digit options.
    - `[connect-fallback-ivr]` — default fallback.
    - `[from-internal]` — used as the `context` for `Originate`.
- **Prompt sync** workflow documented at `docs/pbx/connect-prompt-sync-install.md`.
- **MOH sync** workflow at `docs/pbx/connect-media-sync-install.md`.

### MOH publish: "I picked a file but Asterisk plays the wrong music"

The MOH publish path is multi-stage (UI selection → Connect API → AstDB write
→ `connect-media-sync.sh` → Asterisk `moh reload`). Use this order to localise
the failing stage:

1. **DB readiness — is the publish even accepting the class?**

   ```sql
   SELECT id, status, error,
          "nativeSync"->>'selectedClass'           AS selected_class,
          "nativeSync"->>'assetReady'              AS asset_ready,
          "nativeSync"->>'manifestFileCount'       AS manifest_files,
          "nativeSync"->>'canonicalSlug'           AS canonical_slug,
          "nativeSync"->'coverage'                 AS coverage
     FROM "MohPublishRecord"
    WHERE "tenantId" = '<tid>'
    ORDER BY "publishedAt" DESC
    LIMIT 5;
   ```

   - `status="failed"` with `error LIKE 'connect_asset_not_pbx_ready%'` →
     re-upload the audio (legacy non-WAV upload; transcoder produced no
     `pbxStorageKey`/`pbxFormat`). Re-publish after `conversionStatus=ready`.
   - `status="failed"` with `error LIKE 'connect_asset_not_in_sync_manifest%'`
     → asset exists but does not match the manifest filter (must be `.wav`
     and pass `isMohAssetPbxReady`). Almost always paired with the prior code.
   - `status="success"` with `coverage.nativePbxInboundExtensionsQueues=false`
     and a `connect_*` selectedClass → **expected**: native VitalPBX
     extensions/queues still play `mohN`. Pick a `mohN` class instead, or
     map the upload as a native music group on the PBX. Not a Connect bug.

2. **Slug — did API and worker write to the same AstDB family?**

   ```bash
   ssh connect "docker exec app-api-1 sh -c \
     'asterisk -rx \"database show connect/t_$SLUG\"'"
   ```

   Compare the family that has `moh_class` set vs `MohPublishRecord.nativeSync.canonicalSlug`.
   If two families exist for the same tenant (one with the PBX directory slug,
   one with the Connect `Tenant.name` slug), this is a regression of the slug
   drift fix from 2026-05 — `pickCanonicalTenantSlug` in
   `packages/shared/src/canonicalTenantSlug.ts` must be used by every writer.

3. **PBX file mirror — did `connect-media-sync.sh` actually copy the file?**

   ```bash
   ssh connect-pbx "ls -la /var/lib/asterisk/moh/$CLASS/"
   ssh connect-pbx "tail -n 50 /var/log/connect-media-sync.log"
   ```

   No `asset.wav` for a successful publish → the helper rejected the
   manifest entry. Check the manifest endpoint output directly:

   ```bash
   curl -s -H "x-connect-secret: $SECRET" \
     https://app.connectcomunications.com/api/voice/moh/sync-manifest \
     | jq '.files[] | select(.mohClass=="'$CLASS'")'
   ```

4. **Asterisk runtime — is the class actually loaded?**

   ```bash
   ssh connect-pbx "asterisk -rx 'moh show classes' | grep -i $CLASS"
   ssh connect-pbx "asterisk -rx 'moh show files'"
   ```

5. **Live call** — while a call is on hold, `core show channel <chan>` shows
   `MusicClass`. Compare to the published `connect/t_<slug>/moh_class`. If they
   differ, the dialplan path that owns this leg does not consult AstDB — that
   call is on a native-only path (queue, extension transfer, parking).

If `connect/t_<slug>/moh_class` is correct but the file the helper mirrored
does not match what Connect intends, see the "Deploy queue silently ships
stale code" note above — the helper sometimes survives a partial deploy with
stale config.

### MOH on outbound / internal / bridge / hold legs plays the wrong class

Symptom (canary 2026-05 on Secro / T3): Connect-published class (e.g.
`moh8`) plays correctly on inbound DIDs that flow through Connect's own
router, but outbound trunk legs, internal extension-to-extension calls,
and any leg put on hold during a bridge play the previous class (e.g.
`moh3`). All native VitalPBX `music_group_id` columns are at the right
value and Asterisk has the new class loaded with a valid file.

Root cause: VitalPBX's generated `[trk-<id>-dial]` / `[sub-local-dialing]`
contexts pre-set `CHANNEL(musicclass)` to the **tenant default music
group**, not from the per-route / per-extension column. Updating the
columns alone does not change what the channel inherits at bridge time.
Compounding factor: on builds where `[sub-before-connecting-call]` is
not invoked from `trk-<id>-dial` (verified 2026-05-10), the dialplan-side
caller-leg shim is unreachable for outbound trunk dials.

Fix that is now in place: a Connect-owned dialplan include hooks
`[global-before-bridging-call-hook]` (Gosub'd by VitalPBX-generated
`[sub-before-bridging-call]`) for the **trunk/called leg**, AND a
Connect-owned PJSIP include uses `[<endpoint>](+)` append syntax to set
`CHANNEL(musicclass)` via `set_var` at channel-creation time on each
tenant's `T<id>_*` extension endpoints, covering the **caller leg**.
See the **Tenant MOH enforcement layer** section in `TELEPHONY.md`.

Verification checklist (read-only):

1. **Single-command health probe (recommended first step).** The installer
   ships a read-only `--check` mode that runs all five hardening checks
   in one go and exits non-zero on any failure. Use this before manual
   inspection — it answers "is enforcement healthy right now?" without
   touching files or reloading asterisk:

   ```bash
   ssh connect-pbx "sudo /root/install-connect-tenant-moh-dialplan.sh --check"
   ```

   Expected: `RESULT: PASS (5/5 checks healthy)` with `[PASS]` per line.
   Any `[FAIL]` line tells you exactly which condition broke. If the
   final line is `RESULT: FAIL`, jump to the matching numbered step
   below for that specific failure.

2. Confirm Connect has published the reverse tenant map for this tenant:

   ```bash
   ssh connect-pbx "asterisk -rx 'database show connect/pbx_tenant_map'"
   ```

   Expect both keys present:
   `connect/pbx_tenant_map/<pbxTenantId>/slug`      = `<canonical-slug>`
   `connect/pbx_tenant_map/<pbxTenantId>/moh_class` = `<effective-class>`

   Missing? Trigger a Connect MOH publish (`POST /voice/moh/publish`) for
   the tenant. The reverse map is written best-effort on every successful
   publish and on every successful rollback. Inspect the
   `MohPublishRecord.nativeSync.tenantMohEnforcement` row to see whether
   the publish reported `reverseMapPublished:true` or supplied a `reason`.

3. Confirm the resolver dialplan + connect-leg shim are loaded:

   ```bash
   ssh connect-pbx "asterisk -rx 'dialplan show sub-connect-tenant-moh'"
   ssh connect-pbx "asterisk -rx 'dialplan show global-before-bridging-call-hook'"
   ssh connect-pbx "asterisk -rx 'dialplan show connect-tenant-moh-connect-shim'"
   ```

   All three contexts must be present. If any is missing, the operator
   has not yet run `scripts/pbx/install-connect-tenant-moh-dialplan.sh`
   on the PBX (or it failed verification and rolled itself back — backup
   is in `/etc/asterisk/extensions__65_connect_tenant_moh.conf.bak.*`).

3a. **Per-extension MOH debugging (Phase 3A writer live, Phase 3B
    resolver NOT yet installed as of 2026-05-12).** When an admin sets a
    `MohExtensionOverride` in Connect, the publish writes
    `connect/t_<slug>/extensions/<ext>/{moh_class,active_moh_class}` keys
    to AstDB, but **Asterisk does not read them yet** — live holds still
    play the tenant default. This is expected behavior until Phase 3B
    ships. To verify the AstDB write side is structurally healthy and
    the resolver install gate is met, run the read-only diagnostic on
    the PBX:

    ```bash
    ssh connect-pbx "sudo bash /root/diag-connect-moh-extension-key-readiness.sh"
    ```

    Exit 0 == Phase 3B resolver may proceed to its install gate. Non-zero
    exit lists the HARD failures (orphan extension families under
    unmapped slugs, per-extension class values not loaded in
    `moh show classes`, missing tenant defaults) — those must be
    resolved before any resolver edit. The diagnostic never writes to
    Asterisk config, never reloads anything, never places a call. Design
    and install-gate details: `docs/pbx/phase-3b-moh-extension-resolver-design.md`.

    To answer "has the Phase 3B resolver actually been installed on
    this host yet?" the existing installer's `--check` mode carries a
    probe `2a` that greps the loaded `[sub-connect-tenant-moh]` for
    the Phase 3B sentinel `per-extension override applied`:

    ```bash
    ssh connect-pbx "sudo /root/install-connect-tenant-moh-dialplan.sh --check"
    ```

    The Phase 3B resolver heredoc landed in repo. On any host that has
    NOT yet been re-installed since the heredoc landed, probe 2a will
    still print `[INFO] per-extension resolver NOT installed — Phase
    3A keys are published but inert`. After an operator re-runs the
    installer (default mode) on that host, the same probe flips to
    `[PASS] per-extension resolver installed (Phase 3B sentinel
    present in [sub-connect-tenant-moh])` and bumps the
    `RESULT: PASS (5/5 ...)` line to `(6/6)`. The probe never FAILs;
    its `[INFO]` state on an un-re-installed host is the documented
    pre-install state for that host, not a regression.

    Live-call verification after a successful install (canary only):

    ```bash
    # Place a call from an extension that has an admin-configured override.
    # While the bridge is up, on the PBX:
    sudo asterisk -rx 'core show channels concise'
    sudo asterisk -rx 'core show channel <caller-chan>' | grep -iE 'MusicClass|__CONNECT_MOH'
    sudo asterisk -rx 'core show channel <callee-chan>' | grep -iE 'MusicClass|__CONNECT_MOH'
    # Then 24h watch:
    sudo journalctl -u asterisk --since '24 hours ago' \
      | grep -iE 'per-extension override applied|per-extension override skipped'
    ```

    Both bridge legs must show `MusicClass: <override-class>` for an
    extension with an override row and `MusicClass: <tenant-default>`
    for an extension without one. The `applied` lines in the journal
    must have `slug` matching the resolver's `tenant_id` (cross-tenant
    leak would show mismatched slug/tenant_id — should be impossible
    per the resolver's cross-tenant guard).

4. Confirm the per-tenant connect-leg hook + PJSIP append exist for THIS
   tenant (caller-leg coverage). The installer enumerates these from
   AstDB at install time, so a tenant whose first publish happened after
   the most recent installer run will be missing here:

   ```bash
   ssh connect-pbx "asterisk -rx 'dialplan show T<id>_before-connecting-call-hook'"
   ssh connect-pbx "asterisk -rx 'pjsip show endpoint T<id>_<ext>' | grep -iE 'set_var|musicclass'"
   ```

   Both must show the Connect-installed line. If the dialplan context
   exists but the PJSIP `set_var` is missing (or vice-versa), re-run
   the installer in default mode to re-sync both layers.

5. Confirm VitalPBX still calls the bridging hook:

   ```bash
   ssh connect-pbx "asterisk -rx 'dialplan show sub-before-bridging-call' | grep -i hook"
   ```

   Expect a Gosub line that lands in `global-before-bridging-call-hook`.
   If a future VitalPBX upgrade renames or drops this hook the resolver
   will silently stop applying — symptom is identical to "uninstalled".

6. Live call inspection — both legs must carry the right MusicClass:

   ```bash
   ssh connect-pbx "asterisk -rx 'core show channels concise'"      # find both legs
   # caller leg (PJSIP/T<id>_<ext>-...)
   ssh connect-pbx "asterisk -rx 'core show channel <caller-chan>' | grep -i MusicClass"
   # trunk leg (PJSIP/<trunk-name>-...)
   ssh connect-pbx "asterisk -rx 'core show channel <trunk-chan>' | grep -i MusicClass"
   ```

   Both must report `MusicClass: <published-class>`. If only one leg has
   it, the failed leg's coverage layer is broken: caller leg → PJSIP
   append; trunk leg → dialplan U-flag hook.

7. Rollback (if the layer itself is the problem):

   ```bash
   ssh connect-pbx "sudo /root/install-connect-tenant-moh-dialplan.sh --rollback"
   ```

   This removes only Connect-owned files (the dialplan include, the
   PJSIP include, and the sentinel `#include` line in
   `extensions__60_custom.conf`) and reloads both dialplan and pjsip.
   PBX behavior reverts to pre-enforcement. Reverse-map AstDB keys are
   inert on their own; clear with `database deltree connect/pbx_tenant_map`
   if desired.

### Canary outbound caller-leg MOH wrapper — trunk 33 / tenant T3

Symptom: outbound holds on trunk 33 for tenant T3 still play the wrong
class even with the tenant MOH enforcement layer installed. Generated
`[trk-33-dial]` priority 21 sets `CHANNEL(musicclass)=default` on the
caller leg before the U-flag hook fires, and on this VitalPBX build
`[sub-before-connecting-call]` is not invoked from the per-trunk
caller dial path. See `TELEPHONY.md` → "Canary outbound caller-leg
MOH wrapper (trunk 33 / tenant T3)" for the approved fix.

Probe order (all read-only):

1. Confirm AstDB has the reverse-map key the wrapper reads:
   ```bash
   ssh connect-pbx "asterisk -rx 'database get connect/pbx_tenant_map/3 slug'"
   ssh connect-pbx "asterisk -rx 'database show connect/t_<slug>' | grep -E 'moh_class|active_moh_class'"
   ```
   Missing → run a Connect MOH publish for T3 first.

2. Read-only health probe (no writes, no reloads):
   ```bash
   ssh connect-pbx "sudo /root/install-connect-tenant-moh-dialplan.sh --check"
   ```
   The canary section reports `[INFO] wrapper include absent` when the
   wrapper is not installed (expected default), or `[PASS] ... loaded`
   plus `[PASS] generated [trk-33-dial] invariants present` when it is.

   **PJSIP probes are SOFT/WARN as of 2026-05-10.** A `--check` run on
   this VitalPBX build with the dialplan layer installed but the PJSIP
   layer absent (the expected steady state on canary) is **PASS** with
   warnings, not FAIL. Expected lines:

   - `[WARN] PJSIP caller-leg append not installed; deprecated/unsupported on this build: /etc/asterisk/pjsip__65_connect_tenant_moh.conf`
   - `[WARN] sample endpoint T<id>_<ext> missing CHANNEL(musicclass)=...` (or `could not pick a sample endpoint`)
   - `RESULT: PASS (N checks healthy; W deprecated-PJSIP warning(s))`

   Treat `RESULT: FAIL` as a real regression (one of the HARD probes —
   dialplan include, contexts loaded, AstDB reverse-map, or wrapper
   invariants — broke). Do **not** re-run `install` purely to "fix" a
   PJSIP WARN — the install will retry the append, fail verification,
   roll back the PJSIP layer, and you'll be back to the same WARN.
   The supported caller-leg fix on this build is the canary trunk
   wrapper (`--enable-trk-wrapper=33`).

3. Inspect the merged context — wrapper sentinel + generated tail:
   ```bash
   ssh connect-pbx "asterisk -rx 'dialplan show trk-33-dial'"
   ```
   Look for `connect-trk33-wrapper enter` at priority 1 AND priorities
   21/22/44 still showing `CHANNEL(musicclass)=default` /
   `__TRUNK_MOH_SET=yes` / `U(sub-before-bridging-call^${TENANT}^...)`.

4. If the wrapper is loaded but holds still play the wrong class for
   T3, capture both legs while a call is up:
   ```bash
   ssh connect-pbx "asterisk -rx 'core show channels concise'"
   ssh connect-pbx "asterisk -rx 'core show channel <caller-chan>' | grep -i MusicClass"
   ```
   Caller-leg `MusicClass` must equal the AstDB-published class.

Drift-mismatch recovery: `--enable-trk-wrapper=33` refuses to install
if the baseline SHA over `dialplan show trk-33-dial | head -80`
differs from `9636ed092f6f8154deae751d199574c2cf7e3dd29eb00a263be5ae7b6f250695`,
or if any of priorities 21/22/44 / the exact pattern no longer match.
If the installer reports `INVARIANT-FAIL: trk-33-dial baseline drift`,
**do not bypass**. Run the read-only drift-compare diagnostic to
collect evidence before re-opening architecture review:

```bash
ssh connect-pbx "sudo bash /root/diag-connect-trk33-drift-compare.sh 33 3"
```

(or fetch the pinned script first with the same `curl` pattern used
for the installer, then run the same command). The script never
writes to `/etc/asterisk/`, never reloads anything, and returns:

- exit `0` and `PROOF.REBASE_SAFE = yes` → invariants hold, `${TENANT}`
  is provably bound, trunk is not visibly shared. Candidate for
  re-baseline **after** architecture review approves a new constant.
- exit `1` and `PROOF.REBASE_SAFE = no` → at least one of: pattern /
  pri 21 / pri 22 / pri 44 is broken; `${TENANT}` cannot be proven
  bound; OR trunk 33 is referenced by ≥ 2 distinct `T<n>_` tenant
  prefixes. **NO-GO** — wrapper assumption is unsafe on this build.
- exit `2` and `PROOF.REBASE_SAFE = unknown` → `dialplan show` was
  empty / CLI unreachable / unable to enumerate upstream sites.
  Treat as NO-GO until evidence is reproducible.

Attach the full script output (sections A–G) to the recovery plan
markdown when re-opening architecture review. Do **not** edit the
installer's baseline SHA constant without that review.

### Outbound caller-leg MOH safety harness (2026-05-11)

Before any future re-attempt at `--enable-trk-wrapper=33`, the wrapper
is blocked on the `${TENANT}` provenance problem (drift-compare last
reported `REBASE_SAFE=no, reason="${TENANT} cannot be proven bound on
the caller channel when wrapper would run"`). A three-script safety
harness lives under `scripts/pbx/` to gate any future attempt. Run in
this strict order:

1. **Preflight snapshot** (no call required):
   ```bash
   ssh connect-pbx "sudo bash /root/diag-connect-moh-preflight-snapshot.sh --tag preflight"
   ```
   Writes `/root/connect-moh-safety/<ts>-preflight/` with the full
   dialplan + AstDB + MOH-class state + sha256 of every generated
   `extensions__*.conf` / `pjsip__*.conf`. PROOF must show
   `WRAPPER_FILE_ON_DISK = no` and `WRAPPER_SENTINEL_LOADED = no`.
   Save the `TRK33_HEAD80_SHA256` value — needed for rollback verify.

2. **Place a T3 outbound test call** from a known T3 endpoint
   (e.g. `T3_103`) to an external number; keep it on the line.

3. **Live-call diagnostic** (with the call still up):
   ```bash
   ssh connect-pbx "sudo bash /root/diag-connect-live-call-tenant-vars.sh --tenant-id 3"
   ```
   Reads `CHANNEL(endpoint)`, `CHANNEL(name)`, `CHANNEL(musicclass)`,
   plus the wrapper-relevant chanvars (`TENANT`, `TENANT_PREFIX`,
   `CALL_SOURCE`, `ORIGINATOR`, `__TRUNK_MOH_SET`, `CONNECT_MOH`) on
   every T3 candidate channel. PROOF resolves `SAFE_TENANT_SOURCE` to
   one of `endpoint` / `channel` / `CALL_SOURCE` / `none`. The wrapper
   may only proceed when SAFE_TENANT_SOURCE is one of the first three
   AND `${TENANT}` is explicitly NOT relied on by the gate.

4. **Rollback drill** (wrapper not yet installed — proves the rollback
   script is idempotent when there's nothing to remove):
   ```bash
   ssh connect-pbx "sudo bash /root/rollback-connect-moh-canary.sh --trunk 33 \
       --expected-sha <TRK33_HEAD80_SHA256 from step 1>"
   ```
   Expected output:
   `PROOF.RESULT = nothing_to_rollback`,
   `WRAPPER_FILE_PRESENT_POST = no`,
   `WRAPPER_SENTINEL_POST = no`. Exit 0.

If step 3 reports `SAFE_TENANT_SOURCE = none`, the wrapper remains
**NO-GO** — do not edit the installer's baseline SHA constant, do
not pass `--force`, do not bypass. Re-open architecture review with
the live-call PROOF block attached.

**Update 2026-05-11b — wrapper gate revised + baseline re-pinned.**
After steps 1–4 returned `SAFE_TENANT_SOURCE=channel` and
`PJSIP/T3_302-00000a93` as the live caller channel, the wrapper
heredoc in `scripts/pbx/install-connect-tenant-moh-dialplan.sh` was
revised to gate on `${CHAN_LOCAL:0:9} == "PJSIP/T3_"` instead of
`${TENANT} == "T3"`, and `TRK_WRAPPER_BASELINE_SHA256` was re-pinned
to `c59ab206c79078f1a4879270c982826114af6ecc8f83b08d6d26dcbf467602c8`.
Before any future `--enable-trk-wrapper=33` attempt the operator MUST
**re-run the drift-compare diag** against the new baseline:

```bash
ssh connect-pbx "sudo bash /root/diag-connect-trk33-drift-compare.sh 33 3"
```

Note that the drift-compare script's hard-coded
`EXPECTED_BASELINE_SHA256` is currently STALE (still
`9636ed09…`); the script's `MATCH/MISMATCH` line will report
`MISMATCH` against the live PBX. The structural invariant probes,
TENANT-guard probe, and TRUNK_SHARED_RISK probe are unaffected and
must all PASS — that is the gate, not the SHA-line. A follow-up
commit will re-pin the diag's hard-coded SHA; until then, treat the
SHA-line as informational only.

`rollback-connect-moh-canary.sh` is the canonical break-glass: it
deletes only `/etc/asterisk/extensions__65_connect_trk<N>_wrapper.conf`
(defense-in-depth refuses to touch any other path), backs up to
`/root/connect-moh-safety/rollback-<ts>/`, reloads dialplan, and
verifies wrapper file + sentinel are gone AND (if `--expected-sha`
was passed) the post-rollback first-80-lines SHA matches the
preflight baseline. Exit 1 on any verification failure → escalate.

Rollback (instant, Connect-owned only):
```bash
ssh connect-pbx "sudo /root/install-connect-tenant-moh-dialplan.sh --rollback"
# or, equivalent manual:
ssh connect-pbx "rm -f /etc/asterisk/extensions__65_connect_trk33_wrapper.conf && asterisk -rx 'dialplan reload'"
```
- **IVR runbook**: `docs/pbx/IVR_VITALPBX_PARITY_RUNBOOK.md`,
  `docs/pbx/option-a-setup.md`, `docs/pbx/option-a-runtime-keys.md`.
- **Live snapshot scripts** (PowerShell): `scripts/capture-forensic.ps1` (mentioned
  in `LIVE_CALL_FORENSIC_RUNBOOK.md`).

---

## Mobile debugging notes

- **Logcat helpers** (PowerShell, mentioned above) tail Android logs from a
  USB-connected device.
- **Diagnostic screens in-app**: `apps/mobile/src/screens/DiagnosticsScreen.tsx`.
- **Call flight recorder**: `apps/mobile/src/diagnostics/CallFlightRecorder.ts`.
- **Wake diagnostics**: `apps/mobile/src/diagnostics/callWakeDiagnostics.ts`.
- **Permissions checks**: `apps/mobile/src/sip/permissions.ts`.
- **Notification routing**: `apps/mobile/src/notifications/notificationRouting.ts`.
- **Common Android cold-start bug** is documented inline in
  `apps/worker/src/main.ts::sendPushToUserDevices` — keep FCM `data` only, all
  values stringified.

### Debugging inbound SMS push notifications

Real inbound SMS is delivered by the **worker** via `voipMsInboundSyncJob.ts`,
NOT the VoIP.ms webhook. To debug SMS push failures:

1. **Check `SmsRoutingLog`** in Postgres for recent inbound rows:
   ```sql
   SELECT direction, status, "resolvedUserId", "normalizedFrom", "createdAt"
   FROM "SmsRoutingLog" WHERE direction = 'inbound'
   ORDER BY "createdAt" DESC LIMIT 5;
   ```
   - `status = "routed_poll"` → worker handled it (expected for real SMS).
   - `status = "invalid_to"` → placeholder ping from VoIP.ms webhook (normal, ignore).

2. **Check worker logs** for the push fan-out event:
   ```bash
   docker logs app-worker-1 --since 10m 2>&1 | grep '"event":"voipms_inbound_sms_push'
   ```
   Expected: `voipms_inbound_sms_push_sent` with `attempted >= 1`.
   Missing → push not reaching the worker's `importInboundMessage`, re-check
   the `sendSmsPush` wiring in `main.ts`.

3. **Check worker logs** for the Expo result:
   ```bash
   docker logs app-worker-1 --since 10m 2>&1 | grep '"event":"sms_push_expo_result'
   ```
   Expected: `httpStatus: 200`, `expoResult.data[0].status: "ok"`.

4. **Check `MobileDevice.active` column** for the target user:
   ```sql
   SELECT id, active, platform, "expoPushToken" FROM "MobileDevice"
   WHERE "userId" = '<id>' ORDER BY "updatedAt" DESC;
   ```
   Only `active = true` devices receive the SMS push. If all are `false`, the
   user must re-open the app to re-register (sets `active = true`).

5. **Logcat for notification delivery** (device connected via ADB):
   ```powershell
   adb logcat -v time IncomingCallFirebaseService:V NotificationService:V *:S 2>&1
   ```
   SMS push is a **FCM notification message** (has title/body), so Android FCM
   SDK shows it directly — `onMessageReceived` is NOT called for it. Look for
   `PostNotification` or `vibrateLinearmotor` lines in `NotificationService`.

---

## CRM call timeline events missing

When a call is not showing up in the CRM contact timeline:

1. **Check CRM is enabled for the tenant:**
   ```sql
   SELECT "enabled" FROM "CrmTenantSettings" WHERE "tenantId" = '<tenantId>';
   ```
   If no row or `enabled = false`, the hook returns immediately.

2. **Check the contact is CRM-enrolled (`CrmContactMeta` exists):**
   ```sql
   SELECT id, stage FROM "CrmContactMeta" WHERE "contactId" = '<contactId>';
   ```
   Only enrolled contacts get timeline events.

3. **Check the phone number matches:**
   ```sql
   SELECT "numberNormalized", "contactId" FROM "ContactPhone"
   WHERE "numberNormalized" IN ('<digits_only_number>', '<10_digit_variant>')
     AND "contactId" IN (
       SELECT "contactId" FROM "CrmContactMeta" WHERE "tenantId" = '<tenantId>'
     );
   ```
   The hook normalises by stripping all non-digits and also checks the ±1 prefix variant.

4. **Check the timeline event wasn't already created (idempotency):**
   ```sql
   SELECT id, type, "linkedId", "createdAt" FROM "CrmTimelineEvent"
   WHERE "contactId" = '<contactId>'
     AND "linkedId" = '<cdrLinkedId>'
   ORDER BY "createdAt" DESC;
   ```

5. **Check CDR ingest logs for hook errors:**
   ```
   docker logs app-api-1 --since 10m 2>&1 | grep "\[CRM\]\[cdrHook\]"
   ```
   The hook logs `[CRM][cdrHook] Unexpected error` on top-level failures and
   `[CRM][cdrHook] Failed to write timeline for contact` on per-contact failures.
   Neither error will appear in normal operation — their presence indicates a bug.

6. **Check tenant resolution:** If the CDR's `tenantId` was not resolved (null), the hook
   is skipped entirely. Check `tenantResolutionSource` on the `ConnectCdr` row:
   ```sql
   SELECT "linkedId", "tenantId", "tenantResolutionSource" FROM "ConnectCdr"
   WHERE "linkedId" = '<linkedId>';
   ```
   A null `tenantId` means the CDR was not attributed to any Connect tenant.

---

---

## Debugging voicemail cross-context spool audio (audio_not_found 503)

**Symptom:** Specific voicemails return HTTP 503 with `error: "audio_not_found"` from
the API even though the voicemail row exists in the DB and the user sees "Could not play."

**Root cause pattern:** `pbxRecfile` is a raw `/var/spool/asterisk/voicemail/<context>/...`
path that points to a non-primary PBX voicemail context. The helper defaults to the
tenant's current context and cannot find the message.

**API diagnostic:**
```bash
docker logs app-api-1 --since 5m | grep voicemail
# Look for:
#   recfileReason: "spool_path_only"  → pbxRecfile is a spool path; normal
#   voicemailContext: "..."  helper_audio_fallback: true → fixed path picked up context
#   voicemailContext: null   helper_audio_fallback: false err: "audio_not_found"
#     → either the file was deleted from PBX, or voicemailContext could not be parsed
```

**Manual helper probe:**
```bash
# Replace context/ext/msgNum from pbxRecfile
curl -s -X POST http://209.145.60.79:8757/voicemail/spool/audio \
  -H "Content-Type: application/json" \
  -H "x-connect-pbx-helper-secret: <secret>" \
  -d '{"tenantId":"2","extension":"103","folder":"INBOX","msgNum":"msg0087","voicemailContext":"b_visible-voicemail"}'
# 200 = file exists, 404 = file missing from disk
```

**If 404 from helper:** The audio file was physically deleted from the PBX spool (e.g.
old messages pruned by Asterisk housekeeping). No fix possible; the error is correct.

**If 200 from helper but API returns 503:** The `voicemailContext` was not being parsed
from `pbxRecfile`. Fixed in commit `5275c55` (2026-05-17). Deploy API to pick up fix.

**DB audit — count cross-context voicemails for a tenant:**
```sql
SELECT REGEXP_REPLACE("pbxRecfile", '/var/spool/asterisk/voicemail/([^/]+)/.*', '\1') AS context,
       COUNT(*) FROM "Voicemail"
WHERE "tenantId" = '<tenantId>' AND "pbxRecfile" LIKE '/var/spool/%'
GROUP BY 1 ORDER BY 2 DESC;
```

---

## Debugging voicemail audio playback latency

Voicemail playback uses a two-path strategy:

| Path | When | Log tag |
|------|------|---------|
| **Cache (local file)** | `useVoicemailAudioCache` preloaded the file | `[VOICEMAIL_AUDIO] play_from_cache` |
| **Remote stream** | Cache miss or cache_play_failed | `[VOICEMAIL_AUDIO] play_stream_fallback` |

### Log filter (Metro / adb logcat)

```powershell
adb logcat -v time ReactNativeJS:V *:S 2>&1 | Select-String "VOICEMAIL_AUDIO"
```

Expected sequence on first open:
```
[VOICEMAIL_AUDIO] preload_start vmId=<id>
[VOICEMAIL_AUDIO] preload_done  vmId=<id> sizeBytes=<n> elapsedMs=<n>
```

Expected sequence on Play tap (after preload):
```
[VOICEMAIL_AUDIO] play_from_cache vmId=<id> elapsedMs=<n>
```

Expected sequence on Play tap (no preload / cache miss):
```
[VOICEMAIL_AUDIO] play_stream_fallback vmId=<id> preloadStatus=idle
```

Expected sequence on cache file corrupt:
```
[VOICEMAIL_AUDIO] cache_play_failed vmId=<id> error=<msg>
[VOICEMAIL_AUDIO] play_stream_fallback vmId=<id> preloadStatus=ready
```
(falls back to remote stream automatically)

### API side — confirm ?raw=1 works

```bash
curl -v "https://app.connectcomunications.com/api/voice/voicemail/<id>/stream?token=<jwt>&raw=1" \
  -H "Range: bytes=0-0" 2>&1 | grep -E "HTTP/|Content-Type|Content-Length"
```

Expected: `206`, `Content-Type: audio/wav` (or original format), no ffmpeg delay.

### API side — confirm already-compressed skips transcode

In API logs: absence of `voicemail: mp3 transcode failed` for MP3-source voicemails
confirms the early-exit path. Enable debug logging to see `rawMode=true` in the stream request log.

### Preload cache bounds

| Setting | Value |
|---------|-------|
| Max preloads per list update | 5 |
| Max cached files (LRU) | 10 |
| Max total cached bytes | 30 MB |
| Max single file | 5 MB (larger files stream-only) |

Cache files live in `FileSystem.cacheDirectory` (app-private, OS-managed, cleared under
storage pressure). Check cache hit with:
```
adb shell run-as com.connectcommunications.mobile ls cache/vm-audio-*.raw 2>/dev/null
```

---

## Debugging lock-screen call chip (Android)

The lock-screen "call chip" (e.g. "Home 00:05") is created by `SipKeepAliveService`
notification ID `4242` using `CallStyle.forOngoingCall` + `setUsesChronometer(true)`.

### Expected lifecycle

| Event | What happens |
|---|---|
| `callState === "connected"` in `SipContext.tsx` | `startInCallNotification()` → `ACTION_ENTER_CALL` → chip appears |
| `callState === "ended"` in `SipContext.tsx` | `stopInCallNotification()` → `ACTION_EXIT_CALL` → `stopForeground(REMOVE)` → chip disappears |

### Logcat filter

```powershell
adb logcat -v time SipKeepAliveService:V *:S 2>&1 | Select-String "CONNECT_CALL_UI"
```

Expected sequence on hangup:
```
[CONNECT_CALL_UI] active_call_notification_cleared startId=N
[CONNECT_CALL_UI] foreground_service_idle — idle notification reposted after call exit
```

JS side (Metro/logcat):
```
[CONNECT_CALL_UI] remote_hangup_cleanup or local_hangup_cleanup — callState=ended
[CONNECT_CALL_UI] active_call_notification_cleared — dispatching stopInCallNotification
```

### If chip persists after hangup

1. Check whether `callState === "ended"` fires in JS:
   ```powershell
   adb logcat -v time ReactNativeJS:V *:S 2>&1 | Select-String "CONNECT_CALL_UI"
   ```
   Missing `remote_hangup_cleanup` → SIP library didn't fire `onCallState("ended")`.
   Check `[CALL_EVENT] session_ended` in JsSIP logs.

2. Check whether `ACTION_EXIT_CALL` reached the service:
   ```powershell
   adb logcat -v time SipKeepAliveService:V *:S 2>&1 | Select-String "ACTION_EXIT_CALL|CONNECT_CALL_UI"
   ```
   Missing → `startForegroundService(ACTION_EXIT_CALL)` was dropped (OEM kill, process crash).
   Fix: re-open the app; the FGS notification should auto-clear when the app is reopened and
   idle `startForeground` fires.

3. Verify `stopForeground` ran:
   `[CONNECT_CALL_UI] active_call_notification_cleared` must appear BEFORE
   `startForeground posted ongoing notification id=4242` in the logcat.
   If the order is reversed, the chip might flash briefly but should still clear.

4. If the chip persists through a process restart, it is an OEM display artifact
   (OxygenOS lockscreen cache). Force-stop the app to clear it.

## WebSocket debugging notes

- Connect with a JWT-authed `wscat`-style client to:
    - `wss://app.connectcomunications.com/ws/telephony?token=<jwt>` for telephony.
    - `wss://app.connectcomunications.com/ws?token=<jwt>` for `apps/realtime`.
- Inspect a connection on the server with `docker logs telephony --tail 200`.
- Periodic 3-min presence refresh + 60-s stale cleanup are visible in telephony
  logs (`Telephony` child logger).
- nginx config required for keepalive: `docs/TELEPHONY_NGINX.md`
  (`proxy_read_timeout 86400s`).
- `scripts/ops/_inspect-live-broadcasts.sh` — UNKNOWN exact behavior; verify before
  running.
