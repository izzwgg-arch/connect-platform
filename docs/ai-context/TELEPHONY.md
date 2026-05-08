# TELEPHONY

> Read `CURSOR_START_HERE.md` and `ARCHITECTURE.md` first. This is the most
> dangerous area in the codebase. Every change here must come with evidence
> (snapshot + logs) and a rollback plan.
>
> Anything not directly verifiable from the repo is marked **UNKNOWN — verify before changing.**

---

## Hard rules (must-read for any telephony / PBX edit)

1. **Do NOT count `Local/...` / helper / `Down` channels as active calls.** The truth is
   here:
    - `apps/telephony/src/telephony/normalizers/normalizeCallEvent.ts`
        - `isHelperChannel(...)` — `Local/`, `mixing/`, `Multicast/`, `ConfBridge/`, `Message/` are helpers.
        - `isLocalOnlyCall(...)` — call has only helper channels.
        - `hasValidChannel(...)` — at least one non-helper channel.
        - `hasValidBridgedParticipants(...)` — call has a bridge with ≥2 non-helper participants.
    - `apps/telephony/src/telephony/state/CallStateStore.ts::getActive()` filters
      `state ∈ {up, held}` AND `!isLocalOnlyCall` AND `hasValidBridgedParticipants`.
2. **Prefer bridge-based active call logic** wherever possible. ARI is the source of
   bridge truth; AMI events are the trigger.
3. **One qualifying bridge = one active call.** Never sum channel counts and call
   that "active calls".
4. **Deduplicate using stable identifiers.** Use `linkedid` / `uniqueid` already used
   in the call store. Don't introduce new identity schemes.
5. **Never aggressively poll the PBX** if AMI/ARI events already deliver state.
   Existing intervals (5 s ARI bridged poll, 60 s presence refresh, 60 s voicemail
   fallback, 5 s call invite expiry) are tuned. Adding more is a regression risk.
6. **Never change VitalPBX behavior blindly.** Dialplan, contexts (e.g.
   `[connect-tenant-router]`, `[connect-tenant-ivr]`, `[connect-fallback-ivr]`), and
   AstDB schemas are owned by `docs/pbx/option-a-custom-context.conf` and the
   PBX-host helper scripts. UNKNOWN exact current production state — capture a
   snapshot first.
7. **Never assume PBX state without logs or snapshots.** Use `pbx-snapshot.txt`,
   `pbx-json-snapshot.json`, `pbx-logs.txt`, `pbx-diag-*.txt` if present, or run the
   `cursor-audit@` read-only SSH script.
8. **Any PBX-impacting change must include a validation plan.** See
   `docs/LIVE_CALL_FORENSIC_RUNBOOK.md`, `docs/LIVE_CALL_VALIDATION.md`,
   `docs/LIVE_CALL_REAL_WORLD_TEST_PLAN.md`.

---

## VitalPBX

- Host: `PBX_HOST=209.145.60.79` (default in `docker-compose.app.yml`).
- It is **the** call-control engine: SIP registration, dialplan, IVR, MOH, voicemail,
  CDR, recordings.
- REST client: `packages/integrations/src/vitalpbx/client.ts` (`VitalPbxClient`).
  Used by `apps/api` and `apps/worker` for provisioning, CDR fetch, voicemail
  records, MOH/IVR class sync, prompts, ring groups, inbound DIDs (Ombutel /
  per-tenant), VM greeting record-call status, and tenant directory sync.
- Connect's runtime overrides live in **AstDB** under:
    - `connect/t_<tenantSlug>/...` — `mode`, `dest_business`, `dest_afterhours`,
      `dest_holiday`, `dest_override`, `override_expires`, `active_prompt`,
      `active_prompt_invalid`, `active_prompt_timeout`, `timeout_seconds`,
      `max_retries`, `opt_<digit>/dest`, `opt_<digit>/type`, `active_moh_class`,
      `moh_class`, `hold_mode`, `hold_announcement_*`, `intro_announcement_ref`,
      `hold_announce`, `hold_repeat`, **`pbx_tenant_id`**, **`pbx_tenant_code`**,
      **`direct_dial`**.
    - `connect/didmap/<e164>/...` — per-DID overrides (with `+E.164` and raw-digits
      aliases). Includes `tenant` (Connect tenant slug) — this is the **only**
      thing that determines which Connect tenant a DID belongs to.
    - `connect/system/...` — global wake config (`wake_api_url`,
      `wake_api_secret`, `wake_wait_secs`).

---

## AMI (Asterisk Manager Interface)

- TCP `PBX_HOST:5038`. Username from `AMI_USERNAME`, password from `AMI_PASSWORD`.
- Connection in `apps/telephony/src/telephony/ami/AmiClient.ts`.
- Reconnect logic in `AmiReconnect.ts`.
- Event mapping in `AmiEventMapper.ts` produces `NormalizedCall`,
  `NormalizedExtensionState`, `NormalizedQueueState`.
- Used for:
    - `DBPut` / `DBGet` for AstDB writes (`/telephony/internal/ivr-publish`,
      `/telephony/internal/astdb-read-family`).
    - `Originate` (outbound dialing).
    - `Hangup` (channel hangup), used by stale-hangup endpoint.
    - `ExtensionStateList`, `PJSIPShowContacts` — called every 3 minutes via
      `refreshExtensionPresence()` so BLF stays consistent and tenants resolved
      after startup get backfilled.
- AMI **must not** be talked to from `apps/api` directly except via the telephony
  service's HTTP endpoints.

---

## ARI (Asterisk REST Interface)

- HTTP `ARI_BASE_URL` (default `http://209.145.60.79:8088`).
  Username `ARI_USERNAME`, app `ARI_APP_NAME=connectcomms`.
- Client: `apps/telephony/src/telephony/ari/AriClient.ts`.
- Actions wrapper: `AriActions.ts`.
- **Bridged Active Poller**: `AriBridgedActivePoller.ts` — polls bridges (interval is
  5 s in `apps/telephony/src/telephony/services/...` — verify) and emits an `update`
  event used to call `callStore.reconcileActiveBridges(...)`. This evicts zombie calls
  whose bridge no longer exists.
- ARI WebSocket events: see `docs/ARI_WEBSOCKET_ENABLE.md` for setup notes.

---

## SIP, PJSIP

- VitalPBX is PJSIP-based.
- Extension state is read via `PJSIPShowContacts` (AMI). Registration status
  (`idle | inuse | busy | ringing | onhold | unavailable | unknown`) is mapped in
  `ExtensionStateStore.ts`.
- Mobile uses jssip over WSS (see WebRTC).
- Trunks visible at `apps/portal/app/(platform)/pbx/trunks/page.tsx`.

---

## WebRTC, WSS, TURN/STUN

- WSS endpoint: `PBX_WS_ENDPOINT=wss://209.145.60.79:8089/ws` (default).
- Browser softphone: `apps/portal/contexts/TelephonyContext.tsx` +
  `hooks/useTelephonyAudio.ts`. Uses `jssip`.
- Mobile softphone: `apps/mobile/src/sip/jssip.ts` + `react-native-webrtc`.
- ICE: STUN default `stun:stun.l.google.com:19302`. TURN configured via
  `TURN_SERVER` + either `TURN_AUTH_SECRET` (HMAC time-limited) or
  `TURN_USERNAME`/`TURN_PASSWORD`.
- Tenant TURN validation jobs run in worker (`runTurnValidationMaintenanceCycle`).
- Media reliability gate per tenant — see
  `runMediaReliabilityMaintenanceCycle` in worker.
- SBC mode: `apps/api` exposes `/admin/sbc/status` and `/voice/sbc/status` to
  switch between LOCAL Kamailio (`infra/sbc/kamailio/`) and a REMOTE upstream.
  UNKNOWN current production mode.

---

## Active call counting (the "live calls" fight)

- Single source of truth: `apps/telephony/src/telephony/state/CallStateStore.ts::getActive()`.
- Definition: state in {`up`, `held`}, not local-only, has ≥2 non-helper participants
  in a bridge.
- Diagnostic helpers (always exposed, no debug flag required):
    - `GET /telephony/diagnostics` — store stats, bucket counts, overcount detection.
    - `GET /telephony/forensic` — single-shot mismatch capture (`?pbx=N&kpi=N&rows=N`).
    - `GET /telephony/calls` — active calls, tenant-filtered by JWT.
    - `GET /telephony/diag` — full unfiltered store + BLF + tenant map (admin diag).
    - `GET /telephony/health` — AMI/ARI status + active counts.
- For mismatches, follow `docs/LIVE_CALL_FORENSIC_RUNBOOK.md` step-by-step. Don't patch
  blindly.

---

## Bridges and channels

- Stored on `NormalizedCall.channels` (set of channel names) and
  `NormalizedCall.bridgeIds` (set of bridge ids).
- `reconcileActiveBridges(activeBridgeIds)` removes calls whose bridge has died.
- Helper channels (`Local/`, `mixing/`, `Multicast/`, `ConfBridge/`, `Message/`)
  count as **non-user-facing** and never inflate the active count.

---

## CDRs

- **Live CDR generation**: telephony's `CdrNotifier.ts` listens for `state==='hungup'`
  upserts and POSTs to `apps/api`'s `/internal/cdr-ingest` (auth: `x-cdr-secret`).
  `getCdrStats()` / `resetCdrStats()` exposed at `/cdr-stats`.
- **PBX CDR sync** (worker): `runPbxCdrSyncCycle` every 2 min — fetches from VitalPBX
  via WirePbx-style adapter and upserts `callRecord`.
- **Missed/canceled invite CDRs** (worker): `createMissedCallRecordForInvite` writes
  both legacy `callRecord` and authoritative `connectCdr` rows, so dashboards that
  read `connectCdr` only still see them.
- **Today KPI** (api): see `docs/DASHBOARD_KPI_SOURCE.md`. Computed via VitalPBX
  `/api/v2/cdr` with timezone bounds (`PBX_TIMEZONE` env, default `America/New_York`).
  Live tables read `connectCdr`. Don't conflate the two paths.
- Tables (`packages/db/prisma/schema.prisma`):
    - `ConnectCdr` — authoritative dashboard source (linkedId, fromNumber, toNumber,
      direction, disposition, startedAt, answeredAt, endedAt, durationSec, talkSec,
      rawLegCount, dcontext, isForwarded, fromName).
    - `CallRecord` — legacy table (kept for backward-compat).

---

## Voicemail

- **Live event path**: AMI `MessageWaiting` → telephony →
  `POST /internal/voicemail-notify` to api → DB upsert.
- **Fallback poll**: `apps/worker/src/main.ts::runVoicemailSyncCycle` every 60 s.
  Calls VitalPBX `GET /api/v2/extensions/:extensionId/voicemail_records` via
  `VitalPbxClient.getExtensionVoicemailRecords` (`packages/integrations/src/vitalpbx/client.ts`)
  and upserts `voicemail` rows. Handles legacy and new payload shapes (`date`, `clid`,
  `recfile`, `filename`, `msg_id` vs `origtime`, `callerid`, `msg_num`).
- **Tenant scoping on REST (critical for diagnostics).** `VitalPbxClient` defaults to
  `tenantTransport: "header"` — the VitalPBX tenant id is sent as the **`tenant` HTTP
  header**, not only as `?tenant=` on the URL. Raw `curl` or scripts that omit that
  header can show **too few extensions** or **empty `voicemail_records`** even when AMI
  and live calls are healthy. Always match production: same header as `callEndpoint`
  injects (`packages/integrations/src/vitalpbx/client.ts::maybeInjectTenant`).
- **AMI state ≠ REST index.** Asterisk can emit `MessageWaiting` and store messages on
  disk under the slug-named mailbox context (e.g. `101@gesheft-voicemail`) while
  VitalPBX REST still returns `200 {"data":[]}` for `voicemail_records`. That
  desynchronisation breaks Connect ingestion (worker sums **zero** records; notify
  handler logs `upserted:0`) without affecting SIP registration or call routing. See
  `KNOWN_ISSUES.md` (Voicemail / recordings).
- **Phase 1 spool fallback (2026-05-08).** When REST returns no rows, Connect can
  read the Asterisk voicemail spool **read-only** via the on-PBX helper
  `POST /voicemail/spool/list` (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`,
  helper `VERSION` `2026.05.08.1`+). **API** `/internal/voicemail-notify` tries REST
  first; if empty **and** AMI passed `newCount > 0`, it calls the helper with
  `tenantId`, `extension` (= mailbox), and `voicemailContext` (= AMI context).
  **Worker** `runVoicemailSyncCycle` tries REST per extension, then the helper when
  REST is empty, with throttling (`VOICEMAIL_HELPER_FALLBACK_MAX_PER_CYCLE`,
  `VOICEMAIL_HELPER_MIN_INTERVAL_MS`). Rows still dedupe on `pbxMessageId` (same
  composite as when REST omits `msg_id`). Shared normalization:
  `packages/shared/src/voicemailIngest.ts`. Helper client env resolution:
  `packages/integrations/src/pbxRouteHelperEnv.ts` (also re-exported from
  `apps/api/src/pbxInboundRouteHelperClient.ts`). **Staged production rollout**
  (commit → dry-run → api/worker/telephony → PBX installer → verify) is documented in
  `DEPLOYMENT.md` under **Voicemail Phase 1 — staged rollout**.
  **Copy/paste operator runbook** (upgrade helper on **`209.145.60.79`**, rotate secret, queue **api**/**worker**): **`DEPLOYMENT.md`** § **Phase 1 — operator handoff**. **Post-run evidence:** strict paste-back template **`DEPLOYMENT.md`** Phase 1 **operator execution transcript**. Execution requires PBX + app-host SSH / env access — see **`DEPLOYMENT.md`** § **Phase 1 — execution environment (Cursor / local dev)** for why IDE agents cannot finish this alone.
- **Helper version gate.** Spool fallback is inactive until the on-PBX helper reports
  **`2026.05.08.1`** (or later) from `GET /health`. Older helpers (e.g. `2026.05.07.x`)
  do not expose `POST /voicemail/spool/list`; Connect will log `helper_error:…` and
  leave `helper_calls` at `0` until the installer is upgraded (`DEPLOYMENT.md` production check-in).
  **Never** hand-edit **`vitalpbx-inbound-route-helper.py`** (or other helper Python) on
  the PBX — only re-run **`install-vitalpbx-inbound-route-helper.sh`** from git at the
  release pin (**`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`** for Phase 1). If `/health`
  stays **`2026.05.07.x`** after a run, the service did not pick up the installer output;
  troubleshoot the install/restart path, not one-off Python patches.
- **Helper HMAC secret alignment.** `CONNECT_PBX_HELPER_SECRET` on the PBX (`/etc/connect-pbx-helper.env`)
  must equal **`PBX_ROUTE_HELPER_SECRET`** (and any per-instance JSON `secret`) on **api** and **worker**.
  After rotation, restart **`connect-pbx-helper.service`** on the PBX and **redeploy or restart** api/worker
  so env is re-read (`DEPLOYMENT.md` § compromised secret). Mismatch → **401** from helper, or stale
  `helper_error` in logs.
  **Symptom:** app host **`GET …:8757/health`** shows **`2026.05.08.1`** but **`POST …/voicemail/spool/list`**
  returns **401** — secrets differ; **api**/**worker** often still match each other (`DEPLOYMENT.md` § **app-host smoke**).
  **Fix (no compromise):** preferred path is **PBX follows Connect** — set **`CONNECT_PBX_HELPER_SECRET`**
  in **`/etc/connect-pbx-helper.env`** to the **exact** **`PBX_ROUTE_HELPER_SECRET`** (no trailing whitespace),
  restart **`connect-pbx-helper`** (`DEPLOYMENT.md` § **helper secret alignment only**). **Do not** paste secrets into chat.
- **Helper host = `PBX_ROUTE_HELPER_BASE_URL`.** Production traffic uses whatever base URL is in **api/worker**
  env (and optional **`PBX_ROUTE_HELPER_BY_INSTANCE_JSON`**). That host must be the same machine where
  **`connect-pbx-helper`** listens on **`:8757`** and reports **`2026.05.08.1`** on **`/health`**. If a
  VitalPBX screenshot shows a different public IP, resolve the mismatch before blaming “empty REST”
  (`DEPLOYMENT.md` § Phase 1 verification A′).
- **Helper bind vs remote callers.** The installer defaults to **loopback-only** bind
  (**`CONNECT_PBX_HELPER_BIND=127.0.0.1`**). If **`/health`** is good on the PBX but the **Connect app host**
  cannot open **`http://<pbx-ip>:8757`**, set **`CONNECT_PBX_HELPER_BIND=0.0.0.0`** (or a specific NIC IP)
  and **`CONNECT_PBX_HELPER_PORT=8757`** separately. **Do not** use **`CONNECT_PBX_HELPER_BIND=0.0.0.0:8757`**
  (no **`host:port`** in the bind variable). Restart **`connect-pbx-helper`**, restrict **tcp/8757** to the
  app host — see **`DEPLOYMENT.md`** § **listen bind** (not a Python change).
- **Ingest monitoring (v1, super-admin).** Thresholded **`VoicemailIngestIncident`** rows record helper **404/401**, unreachable (debounced), notify **upsert=0** (3×/15m), worker **global zero records** (3 consecutive cycles), and **REST vs spool** divergence. Toggle with **`VOICEMAIL_INGEST_INCIDENTS_ENABLED`** (default **true**). See **`API_ROUTES.md`** (`/admin/voicemail-ingest/incidents*`) and **`GET /admin/ops-center`** / **`GET /admin/incidents`** summaries. No tenant-admin or email alerts in v1.
- **Greeting recording**: `apps/api/src/vmRecordCallJobs.ts` +
  `apps/api/src/pbxInboundRouteHelperClient.ts::uploadPbxVoicemailGreeting/getPbxVoicemailGreeting/...`.
  Mobile flow lives in `apps/mobile/src/voicemail/vmGreetingInviteUtils.ts` +
  `vmGreetingWakeBridge.ts`. **Treat as fragile.**
- **Greeting recording — PBX call flow (Phase B, 2026-05-07).**
  The Connect API calls the PBX helper at `POST /voicemail/greeting/record-call`
  (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`, version
  `2026.05.08.1`+). The helper:
  1. Calls `resolve_voicemail_context_from_conf(tenant_id, extension)`
     which reads `/etc/asterisk/vitalpbx/voicemail__50-<N>-main.conf`
     to find the actual Asterisk voicemail context for the extension
     (e.g. `test-voicemail`). VitalPBX names these contexts after the
     tenant slug, not the numeric id.
  2. Resolves the user's registered PJSIP contacts and writes the
     fan-out string `PJSIP/T<tenant>_<ext>&PJSIP/T<tenant>_<ext>_<n>`
     into AstDB key `connect_vm_dial/T<tenant>_<ext>`.
  3. Writes the resolved voicemail context into AstDB key
     `connect_vm_context/T<tenant>_<ext>` (e.g. `test-voicemail`).
     The dispatch dialplan reads this before dialing and falls back to
     the numeric tenant id if the key is absent.
  4. Polls the device-specific hint endpoint for Avail (max 20 s) as a
     diagnostic signal — but no longer overrides the originate channel.
  5. Originates `Local/<tenant>_<ext>_<file>@connect-vm-greeting-dispatch/n`
     with `channelSource: "dispatch_local:<base>[,<hint>]"`.
  6. Asterisk runs `[connect-vm-greeting-dispatch]`:
     `Wait(2)` → dial-string DB lookup → context DB lookup →
     `Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^${ext}^${file}))`.
     Every registered endpoint rings in parallel.
  7. When a device answers, Asterisk's `U(...)` option fires Gosub on
     the answered party's channel into `[connect-vm-greeting-record-sub]`,
     where `ARG1` is now the **voicemail context name** (not the tenant
     id). The subroutine writes to
     `/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${ext}/${file}.wav`
     — which is the path VitalPBX's `VoiceMail()` reads from.
  8. CallerID on the originate is
     `Voicemail Greeting Recording <${ext}>` (set in dispatch via
     `Set(CALLERID(name)=...)` / `Set(CALLERID(num)=...)`).
  9. Phase A.5 (push fan-out) is upstream of Phase B — vm-record's
     mobile wake push uses `includeInactiveDevices: true` to include
     heartbeat-deactivated rows. See
     `docs/ai-context/MOBILE_CALL_TIMELINE.md`.
  Phase E (vm-record synthetic invite claim fix, 2026-05-08): when the mobile
  taps Answer on a vm-record IncomingCallScreen, the answer pipeline calls
  `POST /mobile/call-invites/:id/respond` with the synthetic `vmr-<jobId>` ID.
  The `/respond` handler now returns `{ ok: true, code: "INVITE_CLAIMED_OK" }`
  for `vmr-*` IDs (no DB row required) instead of rejecting with
  `INVITE_ALREADY_HANDLED / UNKNOWN`. Without this, the mobile called
  `sip.hangup()` immediately after the user tapped Answer, disconnecting
  the SIP call before the recording IVR could bridge. See
  `KNOWN_ISSUES.md` § "Phase E" for full root cause.
  Phase D (browser Answer-button bug — desktop WebRTC sometimes does
  not send SIP 200 OK) is still open and is portal-side, NOT a PBX
  flow concern.
- Playback URL signing in `apps/api` uses signed download tokens.

---

## Recordings

- Persisted by VitalPBX. Streamed back to clients via `apps/api` (so tenants never
  call the PBX directly). See `apps/portal/app/(platform)/pbx/call-recordings/page.tsx`
  and recordings page.
- Migrations: `20260421160000_call_recording`, `20260421140000_connect_cdr_is_forwarded`,
  `add_recording_path.sql` (root, applied via Prisma).

---

## IVR

- Editor pages: `apps/portal/app/(platform)/pbx/ivr/page.tsx` +
  `pbx/ivr-routing/page.tsx` + `pbx/ivr/override/page.tsx`.
- API publish endpoint: `apps/api` (search `ivr-publish` / `ivrPublishRecord`).
- Telephony executes the publish: `POST /telephony/internal/ivr-publish` →
  `AMI DBPut` for each `family/key/value` triple. Allowed families:
    - `connect/t_<tenantSlug>` (and prefixes thereof).
    - `connect/didmap/<e164>` (only if `didE164` is supplied with the request).
    - `connect/system` (global wake config).
- Snapshot for rollback: `POST /telephony/internal/astdb-read-family` reads pre-publish
  values via `AMI DBGet`.
- Worker auto-publish: `runIvrScheduleCycle` runs every 5 min and writes
  `ivrPublishRecord` rows when computed mode (`business | afterhours | holiday | override`)
  differs from the last successful publish.
- Custom context for the dialplan to read these keys:
  `docs/pbx/option-a-custom-context.conf` (M, modified locally — verify before deploying).

---

## MOH (Music On Hold)

- Storage: `apps/api/src/mohStorage.ts` + Docker volume `moh-assets:/var/lib/connect/moh-assets`.
- Per-tenant MOH classes synced to PBX via `apps/api/src/pbxOmbutelMohClassSync.ts`.
- Native vs Connect MOH classes: `packages/shared/src/mohRuntimeClass.ts` +
  `apps/api/src/mohRuntimeClass.test.ts`.
- Schedule reconcile: worker's `runMohScheduleCycle` (60 s).
- Override + profile picker: `apps/portal/app/(platform)/pbx/moh-scheduling/page.tsx`.
- PBX-host helper to pull files via signed HTTPS: `connect-media-sync.sh`
  (see `docs/pbx/connect-media-sync-install.md`).

---

## Tenant filtering

- `PbxTenantMapCache` (`apps/telephony/src/telephony/state/PbxTenantMapCache.ts`):
  pulls tenant↔pbx map from api over HTTP, caches 60 s, exposes `resolveBySlug`,
  `tenantAliasesEqual`.
- Slug resolver attached to `CallStateStore` so `vpbx:<slug>` tenant ids are
  rewritten to canonical Connect CUIDs at ingest.
- Tenant alias matcher used by snapshot/broadcast filters so a JWT carrying a Connect
  CUID still sees calls/extensions tagged with `vpbx:<slug>` (and vice versa).
- This is the root cause guard for "regular users see no Team Directory / Presence /
  Live Calls" — do not regress it.

---

## WebSocket broadcasts

- `TelephonySocketServer.ts` — accepts WSS at `/ws/telephony`, validates JWT,
  resolves user-allowed extensions for non-admin roles via
  `GET /internal/telephony/user-extensions` on api.
- `TelephonyBroadcaster.ts` — listens to `callStore`, `extStore`, `queueStore`
  events; pushes tenant-filtered upsert/remove messages.
- Periodic ARI snapshot replacement is intentionally **disabled** — see comment in
  `apps/telephony/src/telephony/index.ts` near line ~155. Real-time updates ride on
  individual `callUpsert`/`callRemove` events, not periodic snapshot diffs (this
  prevented a flicker bug where ringing Local-only legs disappeared and reappeared).
- Initial snapshot uses ARI bridged poller's calls if any, otherwise `callStore.getActive()`.

---

## Mobile call handling

- **Push-wake** (Android): worker sends a high-priority FCM data message that the
  native FCM service routes to `handleCallTerminationNative` /
  `handleIncomingCallNative` so the device can ring even when the app is killed.
  Native code in `apps/mobile/android/app/src/main/java/com/connectcommunications/mobile/`.
- **PBX-side wake trigger (`connect-dial-with-wake`)** —
  installer is `scripts/pbx/install-connect-wake-dialplan.sh`; it writes the
  context into `/etc/asterisk/extensions__60_custom.conf`. Behavior verified
  by reading the dialplan source and live AstDB on 2026-05-06:
    1. **Scope — Connect-managed DIDs only.** This entire path only fires
       when the inbound-route helper has set `TENANT_SLUG` and
       `PBX_TENANT_ID` on the channel, which only happens for DIDs that
       have a `connect/didmap/<e164>/tenant=<slug>` AstDB entry **and** the
       matching `connect/t_<slug>/pbx_tenant_id` entry. As of 2026-05-06
       the live PBX has exactly one such DID (`8455577768` →
       `landau_home` → `pbx_tenant_id=21`); every other inbound DID is
       routed by VitalPBX-native dialplan and never enters this context. So
       killed-app failures on non-Connect-managed DIDs are **not** caused
       by anything in this section — they are plain
       "PJSIP_DIAL hits an AOR with no live mobile contact" with no wake to
       fire.
    2. The IVR direct-dial path (`[connect-tenant-ivr]`, lines ~143–148)
       sets `__DIAL_TARGET=T${PBX_TENANT_ID}_cos-all,${EXTEN},1`,
       `__WAKE_EXT=${EXTEN}` and `Goto(connect-dial-with-wake,s,1)`.
    3. **Tenant-mapping precondition** — when this path does fire, the
       resolved `T<id>_cos-all` endpoint must be on the same PBX tenant
       the mobile is registered under (`T<id>_<ext>_1`). If the user's
       Connect tenant maps to a different `pbx_tenant_id` than the mobile's
       SIP credentials, the dial target won't include that mobile's AOR
       regardless of wake logic. First thing to verify when an
       external-DID-to-mobile call doesn't ring.
    4. **Wake-skip probe** — `connect-dial-with-wake` reads
       `CONTACTS_PRIMARY = PJSIP_DIAL_CONTACTS(T<id>_<ext>)` (desktop AOR) and
       `CONTACTS_SECONDARY = PJSIP_DIAL_CONTACTS(T<id>_<ext>_1)` (mobile AOR),
       then `GotoIf(LEN(CONTACTS_PRIMARY)>0 || LEN(CONTACTS_SECONDARY)>0 ?dial_now)`.
       This **OR** is wrong for the killed-app case: if the desktop is
       registered but the mobile is killed, the probe still skips the wake
       API call, so the killed mobile never gets an FCM and the
       `Dial(T<id>_cos-all,...)` only rings the desktop. Tracked in tech-debt
       below; **needs `/var/log/asterisk/full` evidence of a real failed
       Connect-managed call hitting this branch before fixing**, since
       PBX-read alone cannot prove the path was taken.
    5. The wake POST goes to `${connect/system/wake_api_url}` with
       `pbxVitalTenantId` and `extensionNumber`. The API resolves the tenant
       via `Tenant.pbxVitalTenantId`, then looks up `MobileDevice` rows by
       `userId` derived from `Extension.userId`. If no MobileDevice exists,
       the call still reaches `Dial()` but the mobile is silently skipped.
- **AMI-driven mobile-ring fallback (`MobilePushNotifier`)** — for **all**
  inbound calls, regardless of whether `connect-dial-with-wake` runs, the
  telephony service watches AMI events. When a `PJSIP/T<id>_<ext>` or
  `PJSIP/T<id>_<ext>_1` channel appears for a non-terminal call state and
  `direction ∈ {inbound, internal}`, it POSTs `/internal/mobile-ring-notify`
  to `apps/api`, which creates a `CallInvite` and triggers an FCM push.
  This is the **primary** wake path for tenants whose DIDs are routed by
  VitalPBX-native IVR/COS-all (i.e. all tenants except `landau_home` as of
  2026-05-06). Source: `apps/telephony/src/telephony/services/MobilePushNotifier.ts`.
  The `selfOriginatingExt` self-ring guard (lines 135-153) is gated on
  `call.direction !== "inbound"` so inbound IVR-routed DIDs that share a
  caller-ID with the destination extension still reach the push pipeline.
  The matching outbound suppression log message is `"mobile-ring: suppressed
  outbound self-ring (extension dialed external from same AOR)"`. **Bug
  history**: prior to commit `b5f8a43` (deployed 2026-05-06), the guard
  was direction-blind and silently dropped pushes for every VitalPBX-native
  inbound call to a multi-AOR extension. See `KNOWN_ISSUES.md` for the
  forensic record (linkedId `1778094072.18393`).
  **Regression coverage**: 11 tests in
  `apps/telephony/src/telephony/services/MobilePushNotifier.test.ts` pin
  the inbound vs outbound vs internal decision across three different
  tenants (T2/T11/T18) and assert that the decision is tenant-id-,
  DID-, and extension-number-agnostic. Run with
  `pnpm --filter @connect/telephony test`. See `TEST_INVENTORY.md` for
  the per-case detail.
- **APNs VoIP** (iOS): `react-native-voip-push-notification` listens for VoIP push,
  CallKit shows incoming UI.
- **Invite lifecycle**: `CallInvite` rows in DB; status `PENDING → ACCEPTED |
  EXPIRED | CANCELED`. Worker expiry every 5 s. `INVITE_CANCELED` / `MISSED_CALL`
  pushes are sent to terminate the ringtone.
- **Diagnostics**: `mobile/src/diagnostics/CallFlightRecorder.ts` and
  `callWakeDiagnostics.ts` post wake events / timeline rows for forensics.
- **Audio**: `apps/mobile/src/audio/audioRouteManager.ts` is the **single
  source of truth** for in-call audio sink (added 2026-05-06). Priority:
  user-override > Bluetooth > wired > earpiece. Speaker is **never** picked
  automatically — only when the user taps the speaker button. Every
  transition emits a `[audio_route]` log line (`available_devices`,
  `selected`, `applied`, `user_override`, `call_connected_reapply`,
  `bluetooth_available`, `fallback`). `JsSipClient.dial / answer / confirmed
  / ended` and the BT/wired poll loop in `SipContext` all delegate to this
  manager — do **not** add direct `ICM.routeToEarpiece()` /
  `setSpeakerphoneOn()` calls anywhere else, they will fight the manager
  and re-introduce the "audio jumps off Bluetooth on call connect" bug.
  Per-call user override is cleared in `noteCallEnded()`. Companion files:
  `telephonyAudio.ts`, `ringtonePreferences.ts`.
- **CallKeep**: `src/sip/callkeep.ts`. **Telecom**: `src/sip/telecom.ts`.
- **Phone contacts import** (added 2026-05-06):
  `apps/mobile/src/contacts/phoneContactsImport.ts` +
  `apps/mobile/src/components/ImportPhoneContactsModal.tsx`. Permission
  is requested **only** on the explicit "Import from phone" tap. Each
  selected OS contact becomes one `POST /contacts` call; `409
  duplicate_phone` from the API is folded into a "merged" count, not a
  failure. No background scraping. Tenant isolation flows through the
  existing JWT — server resolves `tenantId` from the token.

---

## Call state lifecycle (within `CallStateStore`)

- States used: `ringing | dialing | up | held | hungup | unknown`.
- Stable id: `linkedid` (preferred). Channels are tracked in `channelIndex` keyed by
  `uniqueid` → `linkedid`.
- "Active" requires `up` or `held` AND non-local-only AND has valid bridged
  participants. `ringing`/`dialing` calls are visible (broadcast) but **not** counted as
  "active" by the dashboard.
- Eviction paths:
    - AMI `Hangup` → `state=hungup`, retained briefly for forensics.
    - `reconcileActiveBridges(...)` removes calls whose bridges no longer exist.
    - `forceEvictZombie(...)` invoked from `/telephony/calls/stale-hangup-for-extension`
      when the portal's last-resort safeguard fires.
    - Periodic stale cleanup every 60 s (`startPeriodicStaleCleanup`).

---

## Validation/testing requirements for telephony changes

For ANY change to AMI/ARI flow, call counting, broadcasts, push notifications, or
PBX runtime keys:

1. Capture a "before" snapshot:
   `GET /forensic`, `GET /diagnostics`, `GET /telephony/calls`, plus VitalPBX
   active channels (via `cursor-audit@` read-only SSH or
   `scripts/compare-pbx-dashboard.sh`).
2. Make the change, ship via the deploy queue with `dryRun: true` first.
3. Capture an "after" snapshot in the same conditions.
4. Diff. If active call count, bucket counts, or per-row reasons changed
   unintentionally, **revert**.
5. Document the diff in the PR / chat summary so the next agent can reuse it.
