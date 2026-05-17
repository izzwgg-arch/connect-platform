# KNOWN_ISSUES — fragile areas to handle with care

> Read `CURSOR_START_HERE.md` first. This file collects the fragile / historically
> regression-prone areas of the Connect Communications codebase, derived from
> what is **visible in the repo**: file names, comments, runbooks, audit reports,
> migrations, scripts, and snapshots. Anything not directly verifiable is marked
> **UNKNOWN — verify before changing.**

When you find a new fragile area, add it here.

---

## Billing

- **Fixed 2026-05-12 — tenant billing 403 with valid portal access.** `registerBillingRoutes` used a **too-narrow** JWT role list (`ADMIN`, `BILLING`, `SUPER_ADMIN` only) for tenant paths while the portal granted billing via permissions. **`TENANT_ADMIN`** / **`BILLING_ADMIN`** received **403** on `/billing/settings`, `/billing/platform/invoices`, etc. Fix: shared allowlist in `apps/api/src/billing/billingAuth.ts` aligned with `canManageBilling()` in `server.ts`.
- **Fixed 2026-05-12 — Admin Billing UI vs API.** The `/admin/billing` page and nav used **permission-only** gates; the API required **`SUPER_ADMIN`**. Non–super-admins saw UI then **403**. Fix: portal nav (`isNavItemVisibleForUser`) and admin billing page require **`backendJwtRole === "SUPER_ADMIN"`** plus `can_view_admin_billing`.
- **Fixed 2026-05-12 — SOLA platform `BillingInvoice` webhook + charges.** `POST /webhooks/sola-cardknox` inlined platform-invoice handling (weaker dedupe, **`xInvoice`** = plain invoice number only) while **`cc:sale`** already needed unique gateway **`xInvoice`**. Fix: shared **`applySolaWebhookToBillingInvoice`** + **`resolvePlatformBillingInvoiceForWebhookRef`**, **`CONNECT:…`** `xInvoice` on charges, dedupe OR on processor ref + webhook idempotency keys, **`ck-signature`** verified before Sola HMAC. Details: **`docs/ai-context/BILLING.md`** § SOLA / Cardknox.
- **Fixed 2026-05-12 — BillingInvoice email & dunning gaps.** New invoices (API + worker) did not queue **`BILLING_INVOICE_SENT`**; webhooks did not queue receipt/failure emails; worker autopay had no capped retry metadata. Fix: **`billingEmailLifecycle.ts`** (queue + dedupe by `PaymentTransaction.id`), **`billingDunning.ts`**, worker dunning sweep, tenant **`POST .../email-payment-link`**. See **`BILLING.md`** § Automation & email.
- **Fixed 2026-05-17 — Admin Billing UI scoped but data was cross-tenant.** After removing the in-billing company rail, the workspace switcher updated the toolbar but **Invoices / Payments / Collections / Reports** still called list APIs without `?tenantId=`. Fix: `useAdminBillingTenant` prefers global `tenantId` in tenant mode; portal passes `tenantId` on all relevant fetches; API collections/reports accept optional `tenantId` filter.
- **Dual billing surfaces.** New `BillingInvoice` routes in `billing/routes.ts` plus legacy `/billing/*` handlers in `server.ts` — easy to fix one path and miss the other. See `docs/ai-context/BILLING.md`.

---

## Connect API

- **Fixed 2026-05-13 — Connect Desktop background polls hammering `app-api-1` CPU.** `DesktopNotificationsBridge` polled every **30 s** with a **hard-coded** `GET /voice/voicemail?folder=inbox&page=1&pageSize=10` that omitted **`tenantId`**, so **`SUPER_ADMIN`** sessions hit **`400 tenant_required`** (see `GET /voice/voicemail` in `server.ts`). The same loop called **`loadSmsThreads("GLOBAL")`**, which always **`GET /admin/sms/provider-health`** first — even while the user sat on unrelated pages (nginx showed **Referer: `/billing/invoices`**). **Fix:** `apps/portal/lib/desktopNotificationPoll.ts` (valid probe path + **independent exponential backoff** per SMS vs voicemail), `fetchTenantSmsInboxThreads()` in `apps/portal/services/platformData.ts`, and `apps/portal/components/DesktopNotificationsBridge.tsx` (tenant SMS inbox only for notifications; voicemail probe gated on `can_view_workspace_voicemail`). Diagnosis used **nginx `access.log`** + **`connect_api_request_duration_seconds`** from **`GET /metrics`** — see **`DEBUGGING.md`** § *API CPU — nginx + Prometheus (no env profiler)*.
- **Mitigated 2026-05-13 — PBX / `connect-pbx-helper` CPU from worker voicemail spool reconcile.** `runVoicemailSpoolReconcileCycle` walked **every** PBX-linked mailbox on a **fixed 15 min** timer, issuing **`POST /voicemail/spool/list`** up to **~97× per cycle** with **large page sizes** even when **`total_inserted` stayed 0**, hammering the helper while **AMI + 60 s `runVoicemailSyncCycle`** remain the primary near-realtime paths. **Fix (worker):** adaptive delay + jitter (`startVoicemailSpoolReconcileLoop`), Redis-backed **zero-insert backoff**, optional **probe** (`limit:1`) skip when **`maxOrigtimeAll`** is not newer than DB high-water, **`sinceOrigtime`** on full fetches, **`VOICEMAIL_SPOOL_RECONCILE_TENANT_DELAY_MS`**, extended summary fields (**`helper_calls`**, **`next_reconcile_delay_ms`**, …). Ops relief: raise **`VOICEMAIL_SPOOL_RECONCILE_INTERVAL_MS`** / **`VOICEMAIL_SPOOL_RECONCILE_MAILBOX_DELAY_MS`**. Details: **`DEBUGGING.md`** (PBX helper CPU bullet), **`VOICEMAIL_FLEET_STALE_RISK.md`** §5, **`TELEPHONY.md`** §Voicemail.
- **API container CPU high — hot HTTP routes (investigate with profiling).** Symptom:
  sustained **`app-api-1`** CPU without a clear PBX cause. **Do not assume** `/pbx/live/*`
  until logs/metrics prove it. **Steps:** (1) Prometheus histogram
  **`connect_api_request_duration_seconds`** from **`GET /metrics`** (admin-auth).
  (2) Short window with **`CONNECT_API_PROFILE=1`** on the API container — grep
  **`api_request_profile`** for **`api_request_profile_summary`** (10 s aggregates:
  top routes + client IPs). (3) Optional **`CONNECT_API_PROFILE_EACH=1`** only for a
  few minutes — per-request lines; **disable after** diagnosis. Full runbook:
  **`docs/ai-context/DEBUGGING.md`** § *API CPU spike — profiling HTTP hot routes*.

---

## Telephony

- **PBX CPU / duplicate ARI readers (resolved 2026-05-12).** Previously both telephony
  and the API polled Asterisk ARI for bridged active calls. **Now:** telephony
  `AriBridgedActivePoller` is the steady-state reader (interval **`ARI_BRIDGED_ACTIVE_POLL_MS`**,
  default **5 s**, min **3 s** unless **`ARI_BRIDGED_ACTIVE_POLL_DEBUG`**); it publishes
  a Redis snapshot (`connect:telephony:ariBridged:v1:<host>`). The API `/pbx/live/*`
  path prefers that snapshot (`pbxLiveAriSlice.ts`) and hits Vital ARI only on miss/stale,
  backoff escape, or explicit diagnostics **`?directAri=1`**. **Requirement:** telephony
  must have **`REDIS_URL`** aligned with the API Redis for snapshots to appear.
- **Active call counting vs VitalPBX active channels.** Multiple recent runbooks and
  snapshots:
    - `docs/LIVE_CALL_FORENSIC_RUNBOOK.md`, `docs/LIVE_CALL_VALIDATION.md`,
      `docs/LIVE_CALL_REAL_WORLD_TEST_PLAN.md`, `docs/LIVE_CALL_ENGINE_AUDIT.md`,
      `MULTICALL_QA_REPORT.md`, `docs/audit/CYCLE-1-GROUND-TRUTH.md`.
    - Forensic / diagnostics endpoints exist (`GET /forensic`, `/diagnostics`) — they
      were added because mismatches happened.
    - The "active = bridge with ≥2 non-helper participants" rule lives in
      `CallStateStore.getActive()` + `normalizeCallEvent.ts`. Don't touch without
      capturing before/after.
- **Helper / `Local/` channel inflation.** Filtering happens in `isHelperChannel`
  / `isLocalOnlyCall` — any new helper channel type (e.g. PJSIP variations) needs
  to be added there or the count drifts.
- **Periodic snapshot replacement disabled.** See comment near
  `apps/telephony/src/telephony/index.ts` line ~155: replacing the active list on
  every ARI tick caused ringing calls to flicker. Do not re-enable.
- **AMI reconnect ghosts.** AMI reconnect can leave stale channel index entries.
  `reconcileActiveBridges(...)` + `forceEvictZombie(...)` + 60 s
  `startPeriodicStaleCleanup` mitigate this. UNKNOWN whether all paths converge —
  monitor `/diagnostics`. **Update 2026-05-12:** AMI **bad-greeting** and **auth-failure**
  paths now use the same reconnect scheduler as TCP close (previously a bad greeting
  could strand the client with no reconnect). Bootstrap timers are cleared on each
  disconnect to avoid stacked `CoreShowChannels` / presence refreshes. See
  `TELEPHONY.md` § “PBX restart / network loss”.
- **Tenant alias handling (`vpbx:<slug>` ↔ Connect CUID).** Without this, regular
  users see empty Live Calls / Team Directory while admins see everything. Lives
  in `PbxTenantMapCache.tenantAliasesEqual`. Do not bypass.
- **Mismatch between dashboard KPI and live calls table.** KPI uses VitalPBX
  `/api/v2/cdr` (today window, timezone-aware); live table uses `connectCdr` and
  `/telephony/calls`. These are two paths — fixes to one do not heal the other.
- **CDR direction inference fragility.** `inferPbxLiveDirection.ts` +
  `cdrDirection.ts` rely on call type / context heuristics. Wrong direction =
  wrong KPI bucket. Tests exist (`cdrDirection.test.ts`,
  `pbx-live.test.ts`) — keep them green.
- **MOH `connect_*` upload classes do NOT cover native PBX paths.** A
  Connect-uploaded MOH (`connect_<tenantSlug>_<name>`) only applies to inbound
  DIDs that flow through Connect's `[connect-tenant-router]` /
  `[connect-tenant-ivr]` dialplan and read `connect/t_<slug>/moh_class` from
  AstDB. Native VitalPBX inbound routes / extensions / queues / parking /
  transfer hold music continue to play `mohN` until a native music group is
  mapped on the PBX side. The publish helper deliberately returns
  `noop` with reason `connect_uploaded_moh_no_vitalpbx_music_group` for these
  classes; this is **not** a bug to "fix" by silently overwriting native
  rows. The portal MOH picker now warns about this scope; the publish record
  records `coverage.nativePbxInboundExtensionsQueues=false` so it cannot be
  mistaken for full coverage. To get tenant-wide coverage of a custom file,
  upload it as a native music group in VitalPBX and pick the resulting
  `mohN` instead. (Investigated 2026-05; canary tenant Secro Selutions.)
- **MOH publish silently shipped non-PBX-ready assets (fixed 2026-05).**
  Before the readiness gate, `doMohPublish` would write `connect/t_<slug>/moh_class`
  pointing at a class whose backing `MohAsset` had `conversionStatus=failed`
  / `pbxStorageKey=null`. The PBX media-sync helper then had no `.wav` to
  mirror, but the API still reported `status=success`. The current code
  fails publish with `connect_asset_not_pbx_ready` or
  `connect_asset_not_in_sync_manifest` BEFORE writing AstDB keys.
  See `evaluateMohRuntimeReadiness` and `isMohAssetPbxReady`.
- **MOH AstDB slug drift between API and worker (fixed 2026-05).** Historic
  bug: API used `getIvrSlugForTenant` (preferring `PbxTenantDirectory.tenantSlug`)
  while the worker reconciliation cycle slugified `Tenant.name` directly. For
  tenants whose Connect display name differed from the PBX directory slug,
  both writers wrote to different `connect/t_<slug>/...` AstDB families
  and live calls read whichever the dialplan happened to match. Both are
  now centralised through `pickCanonicalTenantSlug` in
  `packages/shared/src/canonicalTenantSlug.ts`. Any new caller that writes
  to `connect/t_<slug>/...` must use this helper — do NOT re-derive the
  slug locally.
- **MOH transcoder rejected valid uploads because temp file lacked `.wav`
  extension (fixed 2026-05).** `apps/api/src/mohStorage.ts::transcodeMohToPbxWav`
  used to invoke ffmpeg with output path `${dest}.tmp.${process.pid}` (e.g.
  `asset.wav.tmp.156`). ffmpeg picks the output muxer from the filename's
  extension; `.156` is not a registered format, so every Connect-uploaded
  audio file failed transcoding with `ffmpeg_failed: Unable to find a
  suitable output format for '...asset.wav.tmp.<pid>'` and the API stored
  a `MohAsset` with `conversionStatus=failed` / `pbxStorageKey=null`. The
  publish-readiness gate then (correctly) refused the publish with
  `connect_asset_not_pbx_ready`, leaving tenants unable to land a working
  `connect_*` asset through the portal. Reproduced 2026-05-09 against
  canary tenant Secro Selutions. Fix: pass `-f wav` to ffmpeg explicitly
  AND keep a `.wav` suffix on the temp output (`...asset.wav.tmp.<pid>.wav`)
  so muxer selection no longer depends on the temp filename. Same change
  also cleans up the temp file when the final atomic `rename` fails
  (e.g. EXDEV on bind mounts) instead of leaving it on disk. Tests live
  in `apps/api/src/mohStorage.test.ts` (skip if ffmpeg is not on PATH).
- **MOH on outbound / internal / bridge / hold legs played the wrong class
  even with native columns updated (fixed 2026-05).** VitalPBX's generated
  `[trk-<id>-dial]` / `[sub-local-dialing]` contexts pre-set
  `CHANNEL(musicclass)` to the **tenant default music group**, which is a
  different column from `ombu_inbound_routes.music_group_id` /
  `ombu_extensions.music_group_id` / `ombu_queues.music_group_id` that
  Connect's helper updates. So a tenant who selected `moh8` in Connect would
  see all three columns at 8 and Asterisk loaded `moh8` with a valid file,
  yet outbound/internal/bridge holds still played `moh3`. Confirmed canary
  2026-05 on Secro / T3. Fix is a two-layer Connect-owned PBX include
  installed by `scripts/pbx/install-connect-tenant-moh-dialplan.sh`:
    1. Dialplan layer at `/etc/asterisk/extensions__65_connect_tenant_moh.conf`
       hooks `[global-before-bridging-call-hook]` (Gosub'd by VitalPBX-generated
       `[sub-before-bridging-call]`) and Sets `CHANNEL(musicclass)` on the
       **trunk/called leg** before bridge.
    2. PJSIP layer at `/etc/asterisk/pjsip__65_connect_tenant_moh.conf`
       uses `[<endpoint>](+)` append syntax to add
       `set_var = CHANNEL(musicclass)=<class>` to each Connect-known tenant's
       `T<id>_*` extension endpoints. `set_var` fires at channel-creation time,
       covering the **caller leg** — required because some VitalPBX builds
       (verified 2026-05-10 against `trk-33-dial`) skip
       `[sub-before-connecting-call]` for outbound trunk dials, leaving the
       dialplan-side connect-leg shim unreachable.
  API publishes a reverse map `connect/pbx_tenant_map/<pbxTenantId>/{slug,moh_class}`
  on every MOH publish/rollback, which both layers read at install time
  (best-effort; missing keys → bare `Return()`, fail-safe to existing PBX
  behavior). The installer is **idempotent** and ships three operator
  modes: default `install` (writes + reloads + verifies), `--check`
  (read-only health probe with exit code), and `--rollback` (removes
  only Connect-owned files + sentinel include, reloads both
  dialplan/pjsip). See `TELEPHONY.md` "Tenant MOH enforcement layer" and
  `DEBUGGING.md` "MOH on outbound / internal / bridge / hold legs plays
  the wrong class".
- **Caller-leg MOH on outbound trunk calls is FROZEN at partial
  coverage (open, accepted limitation, 2026-05-10).** The trunk/called-
  leg dialplan hook reliably sets `CHANNEL(musicclass)` on the trunk
  leg, so when the **external** party places an outbound call on hold
  the internal extension hears the correct tenant MOH. The remaining
  gap is the **caller/originating leg**: when the **internal**
  extension places the call on hold, the external party may hear
  `default` MOH instead of the tenant class because VitalPBX-generated
  `trk-NN-dial` priority 21 emits
  `Set(CHANNEL(musicclass)=default)` and we have proven there is no
  safe way to land a value upstream of that priority on this build.
  Three diagnostic scripts under `scripts/pbx/` (`diag-connect-pjsip-
  append.sh`, `diag-connect-trunk-dial-hooks.sh`, `diag-connect-
  vitalpbx-source.sh`) ruled out PJSIP `[endpoint](+)` append,
  pre-trunk dialplan hooks, `${TENANT_PREFIX}before-connecting-call-
  hook`, and VitalPBX source-of-truth DB updates. The only mechanism
  that remains is a wrapper/shadow of the trunk dial context, which
  is documented as high-risk and requires a separate written
  architecture-review approval before any patch. Full audit trail
  and operator policy in `docs/ai-context/TELEPHONY.md` →
  "Caller-leg MOH on outbound trunk calls — FROZEN as of 2026-05-10".
  **Update 2026-05-10:** an approved canary same-context same-pattern
  shadow ("F2") of `[trk-33-dial]` is now implemented in
  `scripts/pbx/install-connect-tenant-moh-dialplan.sh` behind the
  additive `--enable-trk-wrapper=33` flag (OFF by default). Scope is
  hard-coded to **trunk 33 + tenant T3 only**, uses the EXACT
  generated pattern `_[-+*#0-9a-zA-Z].`, and refuses to install if
  the captured baseline SHA / priorities 21/22/44 / pattern shape
  differ. **Code only — not yet installed on any PBX.** Installing
  on the canary PBX requires a separate written operator approval.
  Other tenants and trunks remain frozen. See `TELEPHONY.md` →
  "Canary outbound caller-leg MOH wrapper (trunk 33 / tenant T3)"
  and `DEPLOYMENT.md` → canary wrapper runbook for full operational
  detail.
  **Update 2026-05-10b — PJSIP append demoted to deprecated/SOFT.**
  Verified on canary PBX `209.145.60.79` that `install` mode writes
  `pjsip__65_connect_tenant_moh.conf` correctly but the PJSIP
  `[<endpoint>](+)` append does NOT propagate
  `set_var = CHANNEL(musicclass)` to `T<N>_*` endpoints; sample-endpoint
  verification fails and the installer rolls back ONLY the PJSIP
  layer, leaving the dialplan layer healthy. `--check` no longer
  fails when the PJSIP include is absent or the sample endpoint is
  missing `CHANNEL(musicclass)`: probes 3 and 5 emit `[WARN]` (not
  `[FAIL]`) and the RESULT line surfaces the warning count. Exit
  code is `0` as long as the HARD probes (dialplan include,
  resolver/global-hook/connect-shim contexts, AstDB reverse-map,
  and — when present — trk-33 wrapper invariants) all pass.
  Caller-leg coverage on this build is delivered by the canary
  trunk wrapper, not PJSIP append. See `TELEPHONY.md` PJSIP demote
  block and `DEBUGGING.md` "PJSIP probes are SOFT/WARN" note.
  **Update 2026-05-11 — canary wrapper still NOT installed; blocked
  on `${TENANT}` provenance.** `--enable-trk-wrapper=33` was attempted
  and correctly refused to install due to baseline drift; the read-only
  `scripts/pbx/diag-connect-trk33-drift-compare.sh` confirmed
  `REBASE_SAFE=no` with reason `${TENANT} cannot be proven bound on
  the caller channel when wrapper would run`. A three-script safety
  harness has landed under `scripts/pbx/` to gate any future attempt:
  `diag-connect-moh-preflight-snapshot.sh` (read-only forensic
  snapshot), `diag-connect-live-call-tenant-vars.sh` (read-only
  live-call channel-variable introspection that resolves
  `SAFE_TENANT_SOURCE` to `endpoint` / `channel` / `CALL_SOURCE` /
  `none`), and `rollback-connect-moh-canary.sh` (Connect-canary-only
  rollback with on-disk + sentinel + SHA verification). The wrapper
  remains NO-GO until live-call diag returns a safe non-`${TENANT}`
  identity source. See `DEBUGGING.md` "Outbound caller-leg MOH safety
  harness (2026-05-11)".
  **Update 2026-05-11b — `${TENANT}` provenance blocker RESOLVED in
  code; install still NOT attempted.** Live-call diag returned
  `SAFE_TENANT_SOURCE=channel` with caller channel
  `PJSIP/T3_302-00000a93`. The wrapper heredoc in
  `scripts/pbx/install-connect-tenant-moh-dialplan.sh` was revised to
  gate on `${CHAN_LOCAL:0:9} == "PJSIP/T3_"`; `${TENANT}` is no longer
  referenced in the wrapper body. `TRK_WRAPPER_BASELINE_SHA256` was
  re-pinned to
  `c59ab206c79078f1a4879270c982826114af6ecc8f83b08d6d26dcbf467602c8`.
  Wrapper file remains absent on disk; live `[trk-33-dial]` is
  unchanged. Re-attempt of `--enable-trk-wrapper=33` is now gated on
  drift-compare returning `REBASE_SAFE=yes` against the new baseline.
  Tech debt: `scripts/pbx/diag-connect-trk33-drift-compare.sh` still
  hard-codes the OLD `9636ed09…` SHA; its MATCH/MISMATCH line is
  informational only until a follow-up commit re-pins it. The
  drift-compare's structural-invariant + TENANT-guard +
  TRUNK_SHARED_RISK decision logic is unaffected.
- **Some VitalPBX/Asterisk builds do not ship the `pjsip reload` CLI
  alias (fixed 2026-05).** `asterisk -rx "pjsip reload"` is the
  convenience alias for `module reload res_pjsip.so` on newer Asterisk
  builds, but the alias is missing on the canary PBX (and silently
  returns `No such command 'pjsip reload'` while leaving PJSIP at its
  previous config — the CLI's `-rx` exit code is still 0). This caused
  the tenant MOH enforcement installer to write
  `pjsip__65_connect_tenant_moh.conf` correctly but then fail the
  sample-endpoint verification (because the file was never read into
  Asterisk's runtime), triggering a clean rollback of just the PJSIP
  layer. Fix: the installer now reloads PJSIP through a
  `pjsip_reload()` helper that prefers `module reload res_pjsip.so`
  (supported on every Asterisk ≥ 12 build) and falls back to
  `core reload` only if the module form is also unknown. The
  break-glass manual rollback in `TELEPHONY.md` and `DEPLOYMENT.md` was
  updated to match. Do **not** ever shell out to `asterisk -rx "pjsip
  reload"` from automation that needs to work on this fleet — use the
  module-reload form directly.
- **Tenant MOH enforcement requires re-running the installer after every
  new tenant's first MOH publish (open, operational).** The per-tenant
  `T<id>_before-connecting-call-hook` dialplan stanzas and the per-tenant
  PJSIP `[T<id>_<ext>](+)` set_var appends are both generated from
  `connect/pbx_tenant_map` AstDB **at install time**. A tenant who
  publishes for the first time after the most recent installer run will
  have AstDB keys present (so the global trunk-leg hook works) but no
  per-tenant caller-leg coverage until the installer runs again. The
  trunk-leg hook is global and works for every tenant unconditionally,
  so calls already on the platform still play the right class on hold
  *from the trunk side*; only the caller-leg-initiated hold direction is
  affected for newly-published tenants. Mitigation: run
  `install-connect-tenant-moh-dialplan.sh --check` after every publish
  for a new tenant to confirm coverage; if `--check` reports `[FAIL]
  sample endpoint ... missing CHANNEL(musicclass)`, re-run the installer
  in default mode. The end-of-run install summary now includes a
  "Skipped tenants this run" rollup so operators can see exactly which
  tenants couldn't be covered (and why).
- **Tenant MOH enforcement layer does NOT cover queue wait or parking
  (open).** `app_queue` plays MoH from `queues.conf` per-queue `musicclass`
  (driven by `ombu_queues.music_group_id`, which Connect's helper already
  updates) and `res_parking` plays from the parkinglot's static
  `musicclass` setting in `res_parking.conf`. Neither path consults
  `CHANNEL(musicclass)` at hold time, so the new `[sub-connect-tenant-moh]`
  resolver does not reach them. Queues should already use the right class
  via the helper-updated column; parking is unverified. A separate proof
  pass is required before any extension to those paths — explicitly out of
  scope for the 2026-05 enforcement layer ship.
- **Stale per-tenant AstDB family from pre-2026-05 slug drift (open,
  cosmetic).** Tenants whose Connect `Tenant.name` slug differed from the
  PBX directory slug have a residual `connect/t_<old-slug>/...` family in
  AstDB from before the slug-drift fix. The new canonical writer uses the
  PBX directory slug correctly; the old family is inert (no dialplan reads
  it) but shows up in `database show connect`. Cleanup: `database deltree
  connect/t_<old-slug>` per tenant once verified. Not blocking.
- **Per-extension MOH overrides are inert on live calls (Phase 3B
  resolver in repo as of 2026-05-12; live-call effect lands per-host
  on next installer run).** Phase 3A (`doMohPublish` in
  `apps/api/src/server.ts`) writes
  `connect/t_<slug>/extensions/<ext>/{moh_class,active_moh_class}` on
  every publish and empty-string tombstones on rollback. The Phase 3B
  resolver edit to `[sub-connect-tenant-moh]` in
  `scripts/pbx/install-connect-tenant-moh-dialplan.sh` now reads the
  per-extension family before the tenant-default reads, with a tenant-
  id cross-check and empty-string-as-tombstone semantics; full design
  in `docs/pbx/phase-3b-moh-extension-resolver-design.md`. **The repo
  change does NOT touch any PBX.** Each host remains on its previously
  installed dialplan (per-extension overrides inert) until an operator
  re-runs the installer there. Operators can check the per-host
  status by running
  `sudo /root/install-connect-tenant-moh-dialplan.sh --check`:
  - Pre-install: probe 2a prints `[INFO] per-extension resolver NOT
    installed — Phase 3A keys are published but inert`. RESULT stays
    `(5/5 checks healthy)`. This is the documented pre-install state
    on every host today.
  - Post-install: probe 2a prints `[PASS] per-extension resolver
    installed`. RESULT flips to `(6/6 checks healthy)`.
  No PBX install command has been generated yet (per AGENTS.md §Hard
  rules: requires written operator approval + deploy queue). Not
  blocking — tenant default MOH still works for all calls. Known
  Phase 3B follow-up: the canary outbound trunk wrapper
  (`--enable-trk-wrapper=33`) applies tenant default before the
  connect-leg shim, so per-extension overrides on trunk 33 will
  require a separate wrapper edit after Phase 3B is installed and
  signed off. Out of Phase 3B scope.

## Mobile calling

- **Cold-killed Android push reliability.** Long inline comment in
  `apps/worker/src/main.ts::sendPushToUserDevices` explains: every call-control
  push must be a data-only FCM message; values stringified to keep
  `FirebaseMessagingService.onMessageReceived` running. Adding `title`/`body`/`sound`
  silently turns the push into a notification message and breaks ringtone teardown.
- **`MobilePushNotifier` self-ring guard misfires on IVR-fronted inbound DIDs**
  (**FIXED + VERIFIED + REGRESSION-LOCKED** as of 2026-05-06). Source fix:
  commit `b5f8a43` on branch `fix/telephony-mobile-push-self-ring-direction-guard`,
  deployed via queue job `335fce62-7dca-476e-8465-a45911e09d86`. End-to-end
  verified by user the same day: an outside call to A plus DID `8457826775`
  rang **both** the desktop WebRTC softphone **and** the killed/backgrounded
  Android mobile via FCM-driven CallKeep UI. Regression-locked by
  `apps/telephony/src/telephony/services/MobilePushNotifier.test.ts`
  (11 tests, run via `pnpm --filter @connect/telephony test`) — five of
  the eleven tests fail if the `call.direction !== "inbound"` gate at line
  151 is removed, across three different tenants (T2/T11/T18) and the
  dual-AOR path. Originally confirmed by live PBX + log + DB evidence
  2026-05-06 against linkedId `1778094072.18393`, A plus center / ext 103. In
  `apps/telephony/src/telephony/services/MobilePushNotifier.ts` lines 135-147,
  the `selfOriginatingExt` filter is computed without a direction guard:
  `selfOriginatingExt = isExternalDialTarget(call.to) ? extractShortExtension(call.source_extension ?? "") ?? extractShortExtension(call.from ?? "") : null`,
  then applied to `toExtensions` regardless of inbound vs outbound. For
  inbound calls routed through VitalPBX's `T<id>_cos-all` dial, the dialed
  extension's PJSIP channel reports `callerIDNum=<dest-ext>` (e.g. `103`),
  which the notifier reads as `source_extension`. Combined with `to=<10-digit-DID>`
  satisfying `isExternalDialTarget`, the destination extension is filtered
  out of its own push list, the extensions array goes empty, and the early-
  return logs `"mobile-ring: suppressed same-extension outbound self-ring"`
  even though `direction === "inbound"`. **No `/internal/mobile-ring-notify`
  POST happens, no `CallInvite` row is created, no FCM push is sent, no
  `CallWakeEvent` rows are written**, and a backgrounded mobile is silent
  while the desktop softphone rings normally over its still-foregrounded
  WSS contact. The comment at lines 128-131 already warns about this exact
  pattern for `callerExt` (which IS gated on `call.direction === "internal"`)
  but the later-added `selfOriginatingExt` did not inherit the gate.
  **Fix as deployed** (one-liner gate at lines 135-153 of
  `apps/telephony/src/telephony/services/MobilePushNotifier.ts`):
  `const selfOriginatingExt = call.direction !== "inbound" && isExternalDialTarget(call.to) ? … : null;`.
  The same gate already protects `callerExt` for the `"internal"`-only path
  one block above; the new gate extends that direction-awareness to the
  outbound self-ring case. **This is the root cause of the broader
  "killed/backgrounded Android mobile doesn't ring on external calls"
  symptom for every tenant whose inbound DIDs are VitalPBX-native (i.e. all
  but `landau_home`).** The earlier-documented `connect-dial-with-wake`
  wake-skip OR-bug is a separate latent bug that only matters once a
  tenant's DIDs are migrated to Connect-managed routing. **Rollback**
  (if a regression appears in outbound self-ring suppression): revert
  `b5f8a43`, re-enqueue `service: telephony` from `main`. The pre-fix
  outbound behavior is preserved so a regression in *inbound* paths is the
  only realistic concern, and that path is the one we just fixed.
- **Desk hard-phone outbound falsely rings sibling mobile (`INCOMING_CALL` / CallKeep)**

  FIXED in **`MobilePushNotifier`** + **`CallStateStore`** + **`normalizeExtensionFromChannel`** (2026-05-13). **Symptom:** subscriber places an **external** call from **`PJSIP/T<id>_<ext>`** while **`T<id>_<ext>_1`** (mobile) is registered → mobile shows incoming call from **own extension**.
  **Mechanism:**
  (**a**) Asterisk emits VitalPBX **carrier/CDR contexts** matching **`/^trk-[^-]+-in/`**. Older code lumped those with authoritative **`from-trunk`/`from-pstn`**, overwriting aggregated **`direction` → `inbound`** even after **DialBegin** had marked **`outbound`**.
  (**b**) Hard phones expose **company DID** as **`CallerIDNum`**, **≥10 digits**, so **`hasStrongOutboundEvidence`** (short caller + PSTN **`to`)** failed and **`selfOriginatingExt`** stayed **`null`** until peer inference shipped.
  **Mitigation:**
  (**1**) `CallStateStore.onCdr`: **`suppressTrkInboundDcontextMisclass`** — ambiguous **`trk-*-in`** legs do **not** coerce **`direction=inbound`** when AMI already classified **`outbound`/`internal`**, **`call.to`** is PSTN-shaped, and SIP peers collapse to exactly **one** subscriber short extension.
  (**2**) `MobilePushNotifier`: infer originating short ext from **`uniqShortSubscriberPeers`** when CID lacks **`2–6`** digit identity; **`shouldSuppressInboundMislabeledOutboundSelfRing`** clears residual bogus **`direction:"inbound"`** only when **`from`** is **not** PSTN-shaped (authentic PSTN Caller-ID **`from`** preserves mobile push).
  (**3**) `normalizeExtensionFromChannel` peels **`T<id>_<ext>_<slot>`** (mobile / secondary-contact AOR tails).
  **Diagnostics:** **`reason:"outbound_same_extension_family"`** plus **`mobile-ring: suppressed mislabeled inbound (desk outbound self-ring)`** in **`app-telephony-1`**. Tests: **`pnpm --filter @connect/telephony test`**, cases **company CID outbound**, mislabeled **`inbound`**, PSTN CID inbound parity, two-extension guard.
- **Deploy queue silently shipped stale code when `git checkout` aborted in the
  shared clone at `/opt/connectcomms/app`** (mitigated in repo 2026-05-06;
  verify the deploy queue itself is running this version before relying on it).
  The original failure: `scripts/lib/deploy-common.sh::deploy_common_git_sync`
  called `git checkout` without fail-fast handling. When git refused checkout
  ("Your local changes to the following files would be overwritten by checkout
  … Aborting"), the deploy script proceeded to `change-detect → install →
  build → restart → health` and reported `success` while building the dirty
  pre-existing tree. This caused deploy job
  `36b830d2-b159-4afa-a360-adab40b52db6` (real, not dry-run) to skip shipping
  commit `b5f8a43`. Current mitigation in source: dry-runs run a non-mutating
  checkout-safety preflight that fetches refs, resolves the target commit, and
  rejects dirty paths that overlap target-changed paths; real git checkout/fetch
  failures now exit non-zero. Remaining risk: skipping dry-run, running an older
  deploy queue version, or leaving production-only hand-edits in the shared
  clone still requires post-deploy verification and cleanup.
- **API deploy 502 on `/api/*`** (**deploy outage, not VitalPBX**): **`deploy_common_compose_up`** runs **`docker compose rm -sf api`** **before** the replacement listens; nginx keeps **`127.0.0.1:3001`**, yielding **`upstream connect() failed`** and client **`502`**. Blue/green is **the routine standard** (**`DEPLOY_API_BLUEGREEN=1`**, **`AGENTS.md`** hard rule **10**); flow is candidate **`:3004`** → nginx flip → stable **`:3001`** recreate → flip back — final include **`server 127.0.0.1:3001;`**. Supporting pieces: **`GET /ready`** (**no JWT**), graceful drain (**`CONNECT_API_SHUTDOWN_MS`**), **`stop_grace_period: 60s`**, **`scripts/lib/deploy-api-rollout.sh`**. Legacy **`DEPLOY_API_BLUEGREEN=0`** is **break-glass only**. **`docs/nginx/`** snippets + worker env remain operator-owned; rollback: **`docs/ai-context/DEPLOYMENT_API_ROLLBACK.md`**.
- **Portal deploy `502` (HTML/UI):** **`deploy_common_compose_up`** on **`portal`** removes **`127.0.0.1:3000`** before the successor binds — **`nginx`** still proxies **`/`** there ⇒ **`connect() refused`**. **Routine mitigation:** **`DEPLOY_PORTAL_BLUEGREEN=1`** (**`AGENTS.md`** hard rule **11**), **`portal_candidate`** **`:3005`**, **`GET /ready`**, **`DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE`**, **`scripts/lib/deploy-portal-rollout.sh`**. Rollback: **`docs/ai-context/DEPLOYMENT_PORTAL_ROLLBACK.md`**.
- **Production deploy clone (`/opt/connectcomms/app`) has uncommitted
  hand-edits never pushed to `origin`** (open, confirmed today). As of
  2026-05-06 the clone has 57 lines of uncommitted local edits in
  `apps/telephony/src/telephony/state/CallStateStore.ts` plus the now-fixed
  edits in `MobilePushNotifier.ts`. These are *currently running in
  production* (baked into the most recent telephony image build) but they
  exist nowhere in version control. Risk: any deploy that touches
  `CallStateStore.ts` should now fail dry-run with that path listed as a
  checkout blocker (and real checkout should fail non-zero), but replacing the
  running hand-edits with origin/main's older version could still regress live
  call counting / stale cleanup behavior the hand-edits were patching.
  Backup of the dirty diff was saved on 2026-05-06 to
  `_latency_logs/queue-clone-CallStateStore.dirty.<ts>.diff`. Action
  needed: review the diff, port any genuine fix into a real commit on a
  branch, deploy through the queue, and discard the in-clone version.
  Until then, treat any deploy whose change-set touches
  `CallStateStore.ts` as a tripwire — verify the commit landed by reading
  the file inside `app-telephony-1` after deploy.
  **2026-05-08:** real `api` + `worker` jobs shipping `55e9c20` still printed
  `M apps/telephony/src/telephony/state/CallStateStore.ts` in `git-sync` right
  after `HEAD is now at 55e9c20` — checkout succeeded, but the uncommitted
  telephony edit in the shared clone is still present; clean it up when it
  blocks a future checkout (see `AGENTS.md` / `DEBUGGING.md` deploy recovery).
- **`connect-dial-with-wake` wake-skip OR-bug** (open, latent — confirmed by
  reading the dialplan source on 2026-05-06; **NOT yet proven to have caused
  any specific failed test call**). In
  `scripts/pbx/install-connect-wake-dialplan.sh` the `[connect-dial-with-wake]`
  body computes `CONTACTS_PRIMARY = PJSIP_DIAL_CONTACTS(T<id>_<ext>)` (desktop
  AOR) and `CONTACTS_SECONDARY = PJSIP_DIAL_CONTACTS(T<id>_<ext>_1)` (mobile
  AOR), then
  `GotoIf(LEN(CONTACTS_PRIMARY)>0 || LEN(CONTACTS_SECONDARY)>0 ?dial_now)`. The
  intent is "skip wake when the mobile is already registered". The bug is the
  OR: when the desktop is registered but the mobile is killed, the probe still
  jumps to `dial_now` and the wake POST is never made. **Caveat / scope:** this
  context **only fires for Connect-managed DIDs** (DIDs with a
  `connect/didmap/<e164>/tenant=<slug>` entry whose `connect/t_<slug>/pbx_tenant_id`
  is set). On the live PBX as of 2026-05-06 this means **only** DID
  `8455577768` → `landau_home` (`pbx_tenant_id=21`); every other inbound DID is
  handled by VitalPBX-native dialplan and never enters
  `connect-dial-with-wake`. Smallest fix is one line:
  `GotoIf($[${LEN(${CONTACTS_SECONDARY})} > 0]?dial_now)`. Roll out via
  the deploy queue (`service: api` + PBX dialplan re-install through the
  helper); do **not** hand-SSH the PBX. Do not delete the PRIMARY computation
  — keep it for logging so we can see desktop registrations in
  `/var/log/asterisk/full`. **Before fixing, prove via `/var/log/asterisk/full`
  that a real failed-call instance hit this branch** — PBX-read alone cannot
  prove that.
- **Tenant-mapping precondition for `connect-dial-with-wake`.** This entire
  context only runs when the inbound DID's tenant is wired to the **same**
  PBX tenant the mobile is registered under. AstDB needs both
  `connect/didmap/<e164>/tenant=<slug>` and `connect/t_<slug>/pbx_tenant_id=<id>`,
  and the mobile must register as `T<id>_<ext>_1`. If those don't agree, the
  IVR direct-dial path resolves `T<wrongId>_cos-all,<ext>,1` and silently
  fails. As of 2026-05-06 only `landau_home` has any `pbx_tenant_id` entry —
  any test mobile signed in to a different tenant cannot be reached by an
  IVR direct-dial through that DID, regardless of FCM / wake / native code.
  When triaging "mobile didn't ring on external call", **first** confirm
  the DID's `connect/didmap/<e164>/tenant` resolves to the same tenant whose
  `t_<slug>/pbx_tenant_id` matches the mobile's `T<id>_<ext>_1`. PBX-read
  commands sufficient: `asterisk -rx "database show connect"` +
  `asterisk -rx "pjsip show endpoints"`.
- **Most external DIDs on the live PBX are NOT Connect-managed.** Only DIDs
  with a `connect/didmap/<e164>/tenant=<slug>` AstDB entry enter the
  `connect-tenant-router` / `connect-tenant-ivr` / `connect-dial-with-wake`
  pipeline. Every other DID is routed entirely by VitalPBX-native logic
  (`from-pstn` → built-in inbound route → IVR / ring group / extension)
  and **never invokes the FCM-wake mechanism**. So if a killed mobile
  doesn't ring on an external call, the **first** question is: is that DID
  actually wired into Connect? If not, the failure is just plain
  "PJSIP_DIAL on an AOR with no live mobile contact" — there is no wake to
  fire. Diagnostic: `asterisk -rx "database show connect"` then look for
  the dialed E.164 (and its non-`+` alias) under `connect/didmap/`.
- **PBX-read cannot identify which DID was just called.** The
  `pbx_audit` allowlist exposes only live-state snapshots
  (`pjsip show contacts/endpoints`, `core show channels concise`,
  `database show connect`, fixed dialplan dumps) plus the helper's own HTTP
  access log and a fixed `mysql ombutel` SELECT. There is no path to
  `/var/log/asterisk/full`, no AMI tail, no `cdr show`, no general MySQL
  query. For per-call forensics, escalate to either (a) the privileged
  PBX session that can read `/var/log/asterisk/full`, or (b) VitalPBX's own
  `/api/v2/cdr` endpoint (already used by Connect's CDR sync cycle), which
  is tenant-scoped and read-only without exposing audio or auth secrets.
- **Native `KeepAliveRestartReceiver.kt` + `MainApplication.kt`.** Custom
  Android keep-alive logic. UNKNOWN current state of doze-mode handling — verify with
  logcat before touching.
- **iOS APNs VoIP push** via `react-native-voip-push-notification`. UNKNOWN current
  certificate state and entitlement status. Verify with EAS build configuration.
- **`require(uninstalled-package)` → `Requiring unknown module "undefined"` fatal crash
  (FIXED 2026-05-07, commit after `1539cda`).** When a `require("some-pkg")` call
  references a package not present in `node_modules`, Metro does not error the build
  — it silently substitutes `undefined` for the module ID. The Hermes runtime then
  executes `metroRequire(undefined)`, which is a fatal regardless of any `try/catch`
  wrapper. Expo's error-recovery thread reports it as
  `FATAL EXCEPTION: expo-updates-error-recovery` /
  `com.facebook.react.common.JavascriptException: Error: Requiring unknown module "undefined"`.
  This pattern has now crashed the APK **twice** from two separate files:
    1. `NotificationsContext.tsx` — `require("@react-native-community/netinfo")` on answer
       tap (fixed earlier; a comment at ~line 2013 documents the removal).
    2. `SipContext.tsx` — `require("@react-native-community/netinfo")` inside the Stage 1
       NetInfo connectivity-regain `useEffect` (introduced in `e070c03`, first shipped in
       the `1539cda` APK build, fixed by removing the entire useEffect block).
  **`@react-native-community/netinfo` is NOT installed in `apps/mobile/package.json`.**
  Do NOT add a `require()` or `import` for it anywhere without first adding it as a
  dependency AND running a native-linked prebuild (it has a native Android/iOS bridge).
  The SIP reconnect stack falls back to the 30-second keep-alive health check and the
  exponential-backoff orchestrator in `SipContext.tsx` — no reconnect capability is lost.
- **CallKeep + Telecom flicker on remote cancel.** Comment in `NotificationsContext.tsx`
  documents that dynamic `import("../audio/telephonyAudio")` in teardown paths threw
  `Object is not a function` and short-circuited `moveAppToBackground`. Static
  import is required — do not move it back to dynamic.
- **Push wake → dialplan timing.** Documented under `docs/pbx/connect-push-wake-T25.md`.
  Timeouts and AstDB `connect/system` keys are tuned. Don't change them blindly.
- **Voicemail greeting recording flow.** Recently changed:
  `apps/mobile/src/voicemail/vmGreetingInviteUtils.ts`,
  `vmGreetingWakeBridge.ts`, plus API `vmRecordCallJobs.ts`. Treat as fragile.
  - **Phase A (2026-05-07) — mobile wake gate relaxed. DEPLOYED.**
    Commit `f910e6d` shipped via deploy queue job
    `ad842f0e-721f-45b8-afe2-5976ce710673`; running API container
    confirmed to contain the new wake-decision strings and the
    `active: true` filter removed. Call-to-Record used to skip the
    mobile wake push whenever a PJSIP contact for `T<tenant>_<ext>*`
    was Avail and only included `MobileDevice` rows with `active=true`.
    Both gates suppressed mobile fan-out in the common case where a
    desktop WebRTC session shared the same authUsername (e.g. `T21_101_1`)
    as the mobile app. The decision now lives in `decideVmRecordWake`
    (pure helper in `vmRecordCallHelpers.ts`) and sends the wake whenever
    the user has at least one `MobileDevice` row. The pre-wake AOR-Avail
    signal is preserved as a diagnostic only. See
    `vmRecordCallJobs.ts::runVmRecordCallJob` log lines
    `vm-record-call: mobile wake decision` / `mobile wake push sent` /
    `mobile wake registration outcome`.
  - **Phase A.5 (2026-05-07) — second `active: true` filter removed
    via opt-in flag.** Production verification of Phase A surfaced a
    second `active: true` filter inside `sendPushToUserDevices`
    (`apps/api/src/server.ts:2544`) that fired AFTER Phase A's
    decision passed. Job `90b4a38d-aadb-4d51-97ff-6e07f6fdbb0e`
    logged `decision: "send_wake", deviceRowCount: 7,
    activeDeviceCount: 0, devicesNotified: 0` — the wake decision
    was right, but FCM dispatch returned 0. Phase A.5 adds an
    opt-in `includeInactiveDevices?: boolean` parameter to
    `sendPushToUserDevices` (default `false`, preserves all 9 other
    call-sites' active-only semantics) and routes vm-record's wake
    push through `buildVmRecordWakePushInput` (in
    `vmRecordCallHelpers.ts`) which always sets the flag to `true`.
    A new `mobile-push: device fan-out` log line records
    `totalRowsFound`, `activeRowsCount`, `rowsMissingToken`,
    `afterExclude`, `includeInactiveDevices` per dispatch.
  - **Phase B (2026-05-07) — dispatch-only originate + post-answer
    Gosub.** The `direct_pjsip:` channel-source override in the PBX
    helper (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`,
    formerly lines 950–967) was deleted: every vm-record originate
    now flows through `Local/<recording_exten>@connect-vm-greeting-dispatch/n`,
    which dials the AstDB-driven fan-out string `PJSIP/T<tenant>_<ext>&PJSIP/T<tenant>_<ext>_<n>`
    so hardphone + WebRTC + mobile ring in parallel. The
    prompt-before-answer race is fixed inside the dialplan: dispatch
    uses `Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${tenant}^${ext}^${file}))`,
    and the new `[connect-vm-greeting-record-sub]` context runs the
    recording flow as a Gosub on the answered party's channel only
    AFTER pickup. Legacy `[connect-vm-greeting-record]` context is
    retained for back-compat. Helper VERSION bumped to
    `2026.05.07.1`. The API logs a structured warn line
    `vm-record-call: helper returned direct_pjsip channelSource`
    if it ever sees the old path again — purely a regression
    detector. Originating CallerID is now
    `Voicemail Greeting Recording <${ext}>` instead of
    `anonymous@anonymous.invalid`.
  - **Phase C (2026-05-07) — voicemail context path fix. DEPLOYED via
    installer re-run.**
    Root cause: VitalPBX names each tenant's voicemail context after the
    tenant slug (e.g. `test-voicemail`), not the numeric tenant id (`21`).
    The helper's `voicemail_mailbox_dir` used to guess `<numeric>/<ext>`
    first, creating and writing to the wrong directory
    (`/var/spool/asterisk/voicemail/21/101/`). `VoiceMail()` reads from
    `/var/spool/asterisk/voicemail/test-voicemail/101/` — so the custom
    greeting was silently ignored.
    Fix: new `resolve_voicemail_context_from_conf(tenant_id, extension)`
    reads `/etc/asterisk/vitalpbx/voicemail__50-<N>-main.conf` at request
    time to find the real context; `voicemail_mailbox_dir` uses that as
    `candidates[0]` (falls back to numeric/T-prefix/default for tenants
    whose conf file cannot be read). `vm_record_call` also stores the
    resolved context in AstDB key `connect_vm_context/T<tenant>_<ext>`
    before originating; the dispatch dialplan reads it and passes it as
    `ARG1` to `connect-vm-greeting-record-sub`; both `CONNECT_VM_PATH`
    and `CONNECT_VM_TMP` now use `${CONNECT_VM_CONTEXT}/...` instead of
    `${CONNECT_VM_TENANT}/...`. Legacy `[connect-vm-greeting-record]`
    context also does the same AstDB lookup + numeric fallback.
    Helper VERSION bumped to `2026.05.07.2`.
    Verify: `asterisk -rx "database show connect_vm_context"` → shows
    `T21_101 = test-voicemail`; after recording,
    `ls /var/spool/asterisk/voicemail/test-voicemail/101/unavail.wav`
    should exist with a recent mtime.
  - **Phase D (2026-05-07) — disabled Telecom dispatch. SUPERSEDED by Phase 1.**
    Phase D disabled `TelecomBridge.startIncomingCall()` via an `if (false)`
    guard to remove the Samsung native phone UI race condition (see root cause
    below). This created a regression: the FSI/CallStyle-only path requires
    `USE_FULL_SCREEN_INTENT` runtime permission and is blocked by Android 14/15+
    OEM battery/power managers. Incoming calls on Samsung / killed app showed
    no visual UI on lock or home screen. Phase D was the correct diagnosis of
    the *answer* race but the wrong fix (removing Telecom entirely).
  - **Phase E (vm-record synthetic invite claim — 2026-05-08). DEPLOYED.**
    Root cause: when the mobile taps Answer on a vm-record IncomingCallScreen the
    answer pipeline calls `POST /mobile/call-invites/:id/respond` with the synthetic
    `vmr-<jobId>` invite ID. No `callInvite` DB row exists for `vmr-*` by design
    (see `vmRecordCallJobs.ts` comment at line 485). The `/respond` handler returned
    `{ ok: false, code: "INVITE_ALREADY_HANDLED", status: "UNKNOWN" }` for any
    not-found invite. `NotificationsContext.tsx` treats that as a backend rejection
    and calls `sip.hangup()`, immediately disconnecting the SIP call before the
    recording IVR could bridge.
    Fix: in `server.ts` `/respond` handler (after the DB lookup), if `existing` is
    null AND `isSyntheticVmrInviteId(id)` is true AND `action === "ACCEPT"`, return
    `{ ok: true, code: "INVITE_CLAIMED_OK" }`. This lets the mobile answer pipeline
    proceed to bridge the SIP session with the recording IVR.
    `isSyntheticVmrInviteId` is a pure helper exported from `vmRecordCallHelpers.ts`,
    covered by 6 unit tests. All other `/respond` behavior (normal callInvite lookup,
    DECLINE handling, rate-limit, TURN/media gates) is unchanged.
    Verify: trigger Call-to-Record, tap Answer on mobile — call should stay connected
    past 2 s; user hears recording prompt or beep; `sizeBytes > 0` after save.
  - **Phase 1 (2026-05-07) — Telecom re-enabled, answer race fixed. IMPLEMENTED,
    NOT YET DEPLOYED.**
    Root cause of the original Phase D answer failure: `ConnectIncomingConnection
    .onAnswer()` called `setActive()` immediately, before the SIP session
    existed. This showed an OS in-call timer with no audio on Samsung and timed
    out when `jssip.answerIncoming()` polled for a session that hadn't arrived.
    **Fix — three changes:**
    1. `ConnectIncomingConnection.onAnswer()`: `setActive()` removed entirely.
       A 15 s safety watchdog is armed instead; it terminates the Connection
       if JS never confirms the answer result.
    2. `ConnectIncomingConnection.markActive()`: now the ONLY path to
       `setActive()`. Called by JS via `NativeModules.IncomingCallUi
       .telecomMarkActive(inviteId)` after `sip.answerIncomingInvite()` succeeds.
    3. `NotificationsContext.tsx Telecom.Answer handler`: cold-start invite
       resolution retry extended from 250 ms (too short) to a 4 s polling loop
       (200 ms intervals). After `handleAcceptInvite()` resolves successfully,
       `markTelecomActive(inviteId)` is called to trigger `setActive()`.
       On failure/exception, `terminateTelecomCall(inviteId, "other")` cleans
       up the Connection.
    `IncomingCallFirebaseService.handleIncomingCallNative()` now attempts
    Telecom dispatch for all non-foregrounded states (`!appInForeground`).
    Falls back transparently to the FSI/CallStyle path if the PhoneAccount
    is not enabled or `addNewIncomingCall()` throws.
    **Known Phase 1 tradeoff:** on Samsung One UI, both the Samsung native phone
    call UI and the Connect CallStyle notification appear simultaneously. Both
    surfaces now correctly connect the SIP call. Phase 2 will add
    Samsung-path awareness to suppress the duplicate.
    Verify: `adb logcat | grep CALL_INCOMING` shows `telecom_dispatch result=true`
    → user taps Answer on Samsung native UI → `[TELECOM] onAnswer` in JS →
    4 s invite poll → `[ANSWER_PIPELINE] SIP_200OK_SENT` → `markTelecomActive`
    → `[ConnectIncomingConn] markActive` → OS shows in-call timer.
  - **Open: Phase E (browser Answer button).** Desktop WebRTC rings
    but `session.answer()` never emits a SIP `200 OK` — the browser
    sends `480 Temporarily Unavailable` ~22s later. SIP-over-WSS
    capture is on file; root cause is in the portal's `useSipPhone`
    answer path, not in the API or PBX. See agent transcript
    [Call-to-record fan-out + answer](dd85d75d-082c-49b1-90b2-2da51add268d).
- **Mobile invite multi-call race** — migration `20260419200000_call_invite_multi_call`
  exists; UNKNOWN current bug history. Read the migration before touching `CallInvite`.
- **Bluetooth audio yanked to earpiece on call connect — FIXED 2026-05-06
  (commit `1539cda`).** Root cause was an unconditional
  `ICM.routeToEarpiece()` 150 ms after the SIP `confirmed` event in
  `JsSipClient.bindSession`, plus the same call inside `answer()`. Both
  ignored Bluetooth/wired headsets. Replaced with
  `apps/mobile/src/audio/audioRouteManager.ts` — central manager, priority
  user-override > BT > wired > earpiece, speaker never auto-selected.
  **Do not re-add direct route-to-earpiece calls anywhere in the SIP
  client; route every decision through `audioRouteManager`.** Verify with
  `adb logcat | grep audio_route` — every connect should log
  `selected route=bluetooth reason=call_connected` when a BT headset is
  paired.
- **Phone contacts import — added 2026-05-06.** No background scraping.
  Permission only on explicit user tap. Server-side `POST
  /contacts/import` is still a 501 stub; the import path falls back to
  per-contact `POST /contacts` and treats `409 duplicate_phone` as
  "merged". If a real `/contacts/import` endpoint is added later, swap
  the fallback in `phoneContactsImport.ts::importContacts`.
  - **Import preview footer unreachable on Android (FIXED 2026-05-12, commit `27d9b8e`).**
    Symptom: preview listed contacts but the bottom **Cancel / Import(N)** strip was
    off-screen or taps did not reach `runImport` (flow appeared hung with no server
    traffic). Fix: bounded flex layout (`minHeight: 0`, `flex: 1` on list + footer
    region) in `ImportPhoneContactsModal`. **Follow-up:** with hundreds of rows the
    footer could still sit **below the scroll fold**, so users tapped list rows instead
    of Import — **Cancel / Import** were moved **above** the `FlatList` so the CTAs
    stay visible without scrolling. Logcat (`[contacts_import]`): confirm
    `final_import_button_rendered` → `final_import_button_pressed` → `runImport_entered`
    before expecting `import_contact_done` / `import_complete`.
  - **Permission request timing fix (2026-05-07).** On Android 12+, calling
    `requestPermissionsAsync()` from inside a React Native `Modal`'s `useEffect`
    can silently fail (gesture window has expired). Fix: `ContactTab` now calls
    `checkContactsPermission()` + `requestContactsPermission()` directly inside
    the import button's `onPress` handler (active gesture context), then passes
    the resolved status to `ImportPhoneContactsModal` via the `initialPermission`
    prop. The modal's `boot()` uses that value instead of re-checking async.
  - **API create permission (FIXED 2026-05-12).** `POST /contacts` incorrectly
    required `canManageCustomerWorkflow`, so typical mobile roles (USER, MANAGER,
    TENANT_ADMIN, …) received `403 forbidden` on every import row while still
    being able to load `GET /contacts`. Creation now uses `canCreateContacts`
    (view-capable roles except READ_ONLY). Deploy the API for imports to persist.
  - **Import progress / hung uploads (FIXED 2026-05-12).** Serial `POST /contacts`
    with no timeout could leave the progress UI at zero while the first request
    blocked; imports now use a small parallel pool, per-request timeouts, and
    progress counts only **finished** contacts.
- **SMS chat back navigation — fixed 2026-05-07.** `ChatTab` is a bottom tab
  screen. Android hardware back button went to the previous tab (Team) instead
  of closing the open thread. Fix: `ChatTab` registers a `BackHandler` when
  `activeThread !== null` that calls `setActiveThread(null)` and returns `true`.
- **Missed call notifications — fixed 2026-05-07 (native, v2).** The API sends
  `MISSED_CALL` as a data-only FCM push (so `IncomingCallFirebaseService` can
  stop the ringtone). Data-only pushes never reach Expo's JS
  `addNotificationReceivedListener`, so the earlier
  `NotificationsContext.scheduleNotificationAsync` branch was unreachable. Fix
  (v2): `IncomingCallFirebaseService.handleCallTerminationNative()` now calls
  `postMissedCallNotification()` when `type == "MISSED_CALL"`, which posts a
  native Android notification via `NotificationManagerCompat` on channel
  `connect-missed-calls` (ID range 52000–61000). Tapping opens `MainActivity`
  with `notificationType=missed_call`.
- **vm-record mobile ring — fixed 2026-05-07.** The telephony pipeline sees the
  vm-record originating channel as `Local/...@connect-vm-greeting-dispatch`
  (`tenant_UNRESOLVED`) and does not create a `CallInvite` or send an
  `INCOMING_CALL` push. Fix: `vmRecordCallJobs.ts` now sends a synthetic
  `INCOMING_CALL` push (inviteId `vmr-<jobId>`, `fromDisplay: "Voicemail
  Greeting Recording"`) to active mobile devices immediately before
  `requestPbxVoicemailGreetingRecordCall`. JsSIP's single-session fallback in
  `findIncoming()` maps the Answer tap to the live SIP session without requiring
  an `X-Connect-Invite-ID` header.

## WebRTC / SIP

- **TURN/STUN configuration.** Telephony env validates `PBX_WS_ENDPOINT`. Without
  TURN, audio fails behind strict NAT. Worker maintenance cycles (`runTurnValidationMaintenanceCycle`,
  `runMediaReliabilityMaintenanceCycle`) flag tenants as STALE/PASSED.
- **SBC LOCAL vs REMOTE switching.** `apps/api`'s `/voice/sbc/status` exposes the
  active upstream. UNKNOWN current production mode; do not flip without coordination.
- **WSS endpoint URL hardcoded default.** `wss://209.145.60.79:8089/ws`. If the PBX
  IP changes, multiple env files need updating.

## Dashboard KPIs

- **"Today" window timezone alignment.** Documented in
  `docs/DASHBOARD_KPI_SOURCE.md`. Without `PBX_TIMEZONE`, KPIs return zero in
  evening UTC. Default `America/New_York`. Don't remove.
- **`missed` was overcounted before** — only inbound non-answered calls count.
  Don't regress that definition.
- **Two truth sources.** KPI cards = VitalPBX `/api/v2/cdr`, live table = `connectCdr`
  rows. Keep both in mind.

## Voicemail / recordings

- **Voicemail privacy / tenant + mailbox isolation (non-negotiable).** Voicemail
  list (`GET /voice/voicemail`), playback (`GET /voice/voicemail/:id/stream` and
  `/download`), PATCH, and push notifications must never return or target another
  tenant’s or another user’s mailbox. **Rules:** derive `tenantId` for non–super-admin
  callers from the JWT only; never trust query/body `tenantId` for those roles;
  `TENANT_ADMIN` / `ADMIN` may see any mailbox **in their JWT tenant**; everyone
  else is limited to extensions **owned by `ownerUserId = sub`**; `SUPER_ADMIN`
  must pass an explicit `tenantId` for listing (no `global` / fleet-wide). Internal
  `POST /internal/voicemail-notify` must resolve `Extension` with mailbox **and**
  AMI voicemail `context` (see `resolveExtensionForVoicemailNotify`) — **never**
  `findFirst(extNumber)` across tenants. **Containment:** set
  `VOICEMAIL_PUSH_NOTIFICATIONS_ENABLED=false` on **api** if push must stop during
  an incident. **Verify:** two users, two tenants, same extension digits — each
  sees only their tenant’s rows; notify logs show `notifyResolveReason` and the
  correct `ownerUserId`; playback returns **200** or **206** with `Accept-Ranges`
  when the client sends `Range`. **Production deploy evidence (per release, not
  stored here):** queue **api** then **portal** only (`AGENTS.md`); record **commit
  SHA**, **job IDs**, and log lines **`[deploy-api] done <sha>`** /
  **`[deploy-portal] done <sha>`**; confirm the SHA matches `commitHash` / branch
  enqueued (clone dirty-tree caveat in `AGENTS.md`). **Push:** note whether
  **`VOICEMAIL_PUSH_NOTIFICATIONS_ENABLED`** stayed **true** or was set **false**
  on **api** for containment until notify targeting is proven.
- **Mobile React Query leaked voicemails across logins (2026-05).** The mobile
  client used **`queryKey: ["mobile","voicemails","all"]`** with **no JWT/user
  segment**, so **TanStack Query** could serve **cached rows from a previous
  account** after login switch (stale for up to **`gcTime`**). Symptom: “other
  people’s” messages on a **new** user; playback fails (**403**) when IDs belong
  to the prior user. **Fix:** include **`voicemailQueryUserScope(token)`**
  (`sub`+`tenantId` from a **non-verifying** JWT payload decode) in the key; on
  logout **`removeQueries({ queryKey: ["mobile","voicemails"] })`**. Shipped in
  **`apps/mobile`** — requires a **new mobile build**; API isolation alone does
  not clear the device cache. **API logs:** each list emits **`[VOICEMAIL_LIST_SCOPE]`**
  with **`sub`**, **`scopedMailboxesForUser`**, **`returnedPageRows`**, **`totalMatching`**
  (no audio, no secrets). **Voicemail push** is **opt-in:** **`VOICEMAIL_PUSH_NOTIFICATIONS_ENABLED=true`**
  only — default **off** when unset (`apps/api/src/server.ts`).
- **Call history + chat (privacy audit, 2026-05).** **`GET /calls/history`**
  (`apps/api/src/server.ts`): non–super-admin callers always get a **JWT-derived
  `tenantIdFilter`** (plus **extension-scoped** filtering for roles that are not
  tenant-wide viewers — see **`isTenantWideCallViewer`** / **`isExtensionScopedCallViewer`**).
  **Super admin** with **no** `tenantId` query omits a tenant predicate on **`connectCdr`**
  (fleet-wide history) — **not** the same rule as post-SEV-1 **`GET /voice/voicemail`**
  (explicit tenant required). Treat as a **product/security parity TODO** if fleet-wide
  history should be restricted or audit-logged like voicemail. **Connect chat**
  (`apps/api/src/connectChatRoutes.ts`): **`effectiveChatTenantId`** (JWT; super-admin
  may set **`x-tenant-context`**); **`GET /chat/threads/:threadId/messages`** requires an
  active **`connectChatParticipant`** for **`user.sub`** with **`thread.tenantId`**
  matching — cross-tenant thread access by ID without membership is **denied** (**404**).
- **Voicemail upsert key drift risk.** Worker uses `pbxMessageId` (preferring
  VitalPBX `msg_id`); a future API shape change could break dedupe. The
  `runVoicemailSyncCycle` function defensively reads multiple aliases — keep that.
- **Silent ingestion stall: AMI `MessageWaiting` vs empty `voicemail_records`.**
  Primary ingestion still uses VitalPBX REST `GET /api/v2/extensions/:extensionId/voicemail_records`
  (same in `/internal/voicemail-notify`). Asterisk can still fire AMI `MessageWaiting`
  and maintain mailbox audio on the PBX host while this endpoint returns **`200` with an
  empty `data` payload**. **Mitigation (Phase 1, 2026-05-08):** when REST returns no rows,
  api/worker call the on-PBX helper `POST /voicemail/spool/list` (read-only directory scan)
  if `PBX_ROUTE_HELPER_BASE_URL` + secret are configured; notify path also requires AMI
  `newCount > 0`. Dedupe remains `pbxMessageId`. Symptom if **unmitigated** or helper
  offline: worker JSON logs `rest_count` high / `helper_calls:0`; API `voicemail-notify`
  with `upserted:0`; no new `Voicemail` rows. **Do not infer** from an empty REST response
  that extensions were deleted — verify AMI mailbox/context, disk under
  `/var/spool/asterisk/voicemail/<context>/<ext>/`, REST with **`tenant` header**
  (`TELEPHONY.md` § Voicemail), and helper `VERSION` / `mailboxPath` JSON. Root causes for
  REST divergence often live in VitalPBX; spool fallback is a **safety net**, not a
  guarantee of playback (`pbxRecfile` may still be empty until REST recovers).
- **Connect vs PBX helper version skew.** Shipping api/worker that call
  `POST /voicemail/spool/list` while the PBX helper is still on **`2026.05.07.x`**
  yields HTTP **404** / `not_found` from the helper. Symptoms: `fallback_reason` like
  `helper_error:not_found` on `/internal/voicemail-notify`, worker `helper_calls:0`.
  Re-run **`install-vitalpbx-inbound-route-helper.sh`** from the **pinned git commit**
  (**`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`**) only — **never** hand-edit
  `/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py`; confirm
  `GET …:8757/health` → **`2026.05.08.1`**+ (`DEPLOYMENT.md` production check-in).
  Step-by-step fix for the **`209.145.60.79`** mismatch: **`DEPLOYMENT.md`** § **Phase 1 — operator handoff**. Automated “agent execution” from Cursor without PBX/app-host access will not apply the fix; after a human runs it, use the strict **paste-back transcript** (**`DEPLOYMENT.md`** Phase 1 **operator execution transcript**) so evidence (job IDs, `done` SHAs, log fields) is reviewable without leaking secrets.
- **Voicemail ingest incidents (super-admin v1).** `VoicemailIngestIncident` rows summarize thresholded stalls (notify **upsert=0**, worker **global zero** sync, helper **404/401** immediate, unreachable debounced, REST vs spool divergence). They are **not** a substitute for log forensics — multi-instance api could theoretically skew rare counters until a v2 event table exists. Tenant admins are **not** notified in v1.
- **Incomplete Phase 1 evidence.** Claiming “helper fallback works” without the **operator execution transcript** (or equivalent) risks hidden **BASE_URL** skew, unstaged **api/worker** env, or **deploy log SHA** mismatch (`AGENTS.md`). Treat missing queue **`done <sha>`** lines as **not verified**.
- **`PBX_ROUTE_HELPER_BASE_URL` points at the wrong host.** Connect will happily call
  **`http://<ip>:8757`** on a machine that still runs **`2026.05.07.x`** while operators upgrade a
  **different** VitalPBX (MOTD / SSH IP mismatch). Symptom: persistent **`helper_error:not_found`** after
  “we upgraded the helper.” Fix: `curl /health` from the **app** host to the URL in env; upgrade **that**
  host; or change **BASE_URL** to the upgraded host and redeploy **api** + **worker** (`DEPLOYMENT.md` A′).
- **Helper `2026.05.08.1` on loopback but app host `Connection refused`.** The service may be listening
  only on **`127.0.0.1:8757`** (installer default). Connect uses **`PBX_ROUTE_HELPER_BASE_URL`** from
  another host, so TCP never connects. Fix **`CONNECT_PBX_HELPER_BIND`** in **`/etc/connect-pbx-helper.env`**
  to **`0.0.0.0`** or a **NIC IP** (address **only** — do not use **`0.0.0.0:8757`**; port stays in
  **`CONNECT_PBX_HELPER_PORT`**), restart **`connect-pbx-helper`**, confirm **`ss -lntp | grep 8757`**
  shows **`0.0.0.0:8757`**, allow **tcp/8757** from the **app host IP only** (`DEPLOYMENT.md` § listen bind).
  **Not** a Python patch.
- **PBX vs Connect helper secret skew (401 after bind fix).** App host **`GET …:8757/health`** can show
  **`2026.05.08.1`** while **`POST …/voicemail/spool/list`** returns **401** **`unauthorized`**: PBX
  **`/etc/connect-pbx-helper.env`** still has a different **`CONNECT_PBX_HELPER_SECRET`** than
  **`PBX_ROUTE_HELPER_SECRET`** on **api**/**worker**. **Preferred:** set PBX line to **byte-match** Connect
  (no trailing spaces), **`systemctl restart connect-pbx-helper`** — **no** api/worker recycle needed.
  **Alternate:** update **`.env.platform`** to PBX value + queue **api**/**worker** (`DEPLOYMENT.md` § **helper secret alignment only**).
  **Still 401 after “we fixed it”:** duplicate **`CONNECT_PBX_HELPER_SECRET=`** lines, stray quotes, CRLF,
  or editing the wrong file — see **`DEPLOYMENT.md`** § **Troubleshooting: still 401**; **`voicemail-notify`**
  **`helper_error:unauthorized`** matches manual app-host **`curl`** **401**. Prove where bytes diverge with
  **`DEPLOYMENT.md`** § **Secret mismatch fingerprints** (Connect **`docker exec`** vs PBX file vs **`/proc/…/environ`**).
  When aligned, app-host **`POST …/voicemail/spool/list`** → **200** **`ok: true`**; **worker** **`voicemail-sync-cycle`**
  may show **`source_used":"helper"`** and **`helper_count` > 0** (**`DEPLOYMENT.md`** recorded verification).
- **Exposed `CONNECT_PBX_HELPER_SECRET`.** If the PBX helper secret appears in a screenshot,
  ticket, or chat, assume compromise. Rotate **`CONNECT_PBX_HELPER_SECRET`** in
  **`/etc/connect-pbx-helper.env`**, set the same value in Connect **`PBX_ROUTE_HELPER_SECRET`**
  (and per-instance helper JSON if used), **`systemctl restart connect-pbx-helper`**, then
  restart **api** and **worker** via approved process (`DEPLOYMENT.md` § compromised secret).
- **Spool fallback vs playback.** Phase 1 ingestion can store **`pbxRecfile`** as a PBX
  **absolute spool path** (or leave it empty) while list metadata is correct. **`GET /voice/voicemail/:id/stream`**
  historically joined that path to Vital **`baseUrl`** and failed. **Phase 2 (2026-05-08):** after
  helper **`2026.05.08.2`+** and **api** deploy, the same stream endpoint tries Vital/REST first, then
  **`POST /voicemail/spool/audio`** (validated **`tenantId` / extension / folder / msgNum`** only — no
  client paths). Success → real audio bytes (`TELEPHONY.md`). Helper pre-**`2026.05.08.2`** → audio route **404**,
  API still **`503` JSON**.   **Rollout state:** Helper **`2026.05.08.2`** is live on **`209.145.60.79`**; app-host **`/health`**, **`spool/audio`** smoke, and **`helper_audio_fallback`** logs are recorded in **`DEPLOYMENT.md`** (**Recorded Phase 2 — helper `2026.05.08.2` live**). If **`/health`** ever regresses to **`.1`**, playback fallback **`POST /voicemail/spool/audio`** is absent (**404**) until the installer is re-run.
- **Voicemail ingest — REST-non-empty skips spool reconcile (current code).** Phase 1 only
  calls `POST /voicemail/spool/list` when VitalPBX `voicemail_records` is **empty** for that
  extension. If the REST API returns a **non-empty but wrong** list (stale, partial index, or
  tenant/header mismatch that still yields some rows), Connect **never** compares to disk for that
  poll/notify — new files on the PBX may be invisible in Connect until REST catches up (if ever).
  **Worker helper starvation (fixed 2026-05):** previously a **global** “first N extensions” cap could
  skip mailboxes every cycle; the worker now **fair-schedules** helper calls across tenants with a
  rotating cursor (`packages/shared/src/voicemailSyncFair.ts`, `apps/worker/src/voicemailSyncCycle.ts`).
  **`/internal/voicemail-notify`** resolves `Extension` via
  **`resolveExtensionForVoicemailNotify`** (mailbox + AMI `context` + PBX directory
  mapping). Duplicate `extNumber` across tenants without a resolvable context yields
  **`ambiguous_*`** / **`no_tenant_matches_voicemail_context`** and **skips** sync
  rather than guessing (privacy-safe). Evidence: **`DEBUGGING.md`** § voicemail items **8–10**.
- **Fair scheduler ≠ automatic historic backfill.** After deploy, operators may still need a **one-time**
  **`voicemail-spool-audit.ts`** → **`voicemail-spool-backfill.ts`** (`--all-tenants` or targeted) →
  **re-audit** sequence on the **app worker** container to close gaps accumulated while mailboxes were
  starved or offline. Procedure: **`DEPLOYMENT.md`** § **Voicemail — operational recovery (audit + backfill)**;
  **`DEBUGGING.md`** item **9a**.
- **Spool “missing in 7d” audit can be green while the tenant is still broken.** The helper may return
  **no** or **stale** files (path/slug drift), REST may suppress helper fallback while wrong, and the
  default **`GET /voice/voicemail`** list is **inbox-only** — so “healthy audit” ≠ healthy UX. Use
  **`voicemail-fleet-stale-report.ts`** + **`VOICEMAIL_FLEET_STALE_RISK.md`** for fleet stale-risk and
  evidence-backed failure classes (`DEBUGGING.md` item **9b**).
- **Playback / `src_unsupported` (mobile) and 503 (API).** List/stale rows still
  show in UI if created before the stall. `GET /voice/voicemail/:id/stream` loads audio
  via `streamVoicemailAudio` (`apps/api/src/server.ts`): it follows **`pbxRecfile`** when it is a
  VitalPBX **`/static/...`** or **https** URL, or refreshes metadata via `getExtensionVoicemailRecords`.
  If that path fails and **Phase 2** helper audio is unavailable or identifiers are missing, the handler
  returns **`503` JSON** (`audio_unavailable`, `audio_fetch_failed`) — not audio bytes. Clients
  using `expo-av` `loadAsync({ uri })` then fail decoding (users may see a generic playback
  error). After Phase 2 + helper upgrade, spool-backed rows with valid **`pbxMsgNum`** should stream;
  persistent **`503`** then points at missing disk file, wrong folder, or helper/network issues.
- **Recording playback path.** Streamed via API. UNKNOWN current expiry of signed
  URLs; verify before changing.
- **Recording file presence on PBX.** Documented as fragile in
  `scripts/pbx/patch-dialplan-file-presence.sh` — UNKNOWN current production state.

## Tenant isolation

- **`pbxTenantId="1"` is the global / system tenant** in VitalPBX (shared MOH
  classes etc.). Worker MOH/IVR cycles include `pbxTenantId: "1"` as a fallback.
  Confusing this with a real customer tenant has caused bugs.
- **Slug normalization** is `name.toLowerCase().replace(/[^a-z0-9]+/g, "_")`. Two
  tenants with names that collapse to the same slug would conflict. UNKNOWN whether
  any tenant pair is at risk — verify with a `Tenant.findMany` audit.
- **Mixed-case email duplication.** `scripts/ops/_audit-mixed-case-emails.sh` and
  `_fix-mixed-case-emails.sh` exist — there's a known data-cleanup task here.
- **Null-tenant rows.** `scripts/null-tenant-audit.sh`, `scripts/audit-null-tenant-rows.sh`
  — there's been a history of rows with `tenantId=null` that should not exist.

## Deployment

- **Deploy queue is the only path.** See `AGENTS.md` and `docs/safe-deploy-queue.md`.
  Manual deploys are explicitly forbidden.
- **`api` is the ONLY service that runs migrations.** A migration file checked in
  but not deployed via `api` will silently miss production.
- **`docker-compose.app.yml` `command:` line for `api` runs Prisma generate +
  migrate every container start.** UNKNOWN whether this assumption holds across all
  deploy scripts — verify in `scripts/deploy-api.sh`.
- **Volumes `moh-assets`, `ivr-prompts`, `chat-attachments`** must persist. Renaming
  drops customer media.
- **`/opt/connectcomms/downloads` mounted read-only into the api container** for
  Android APK distribution. Don't change to RW.

## Database

- **80+ migrations under `packages/db/prisma/migrations/`.** Some recent ones
  touch heavily-used tables: `voicemail`, `mohScheduling`, `ivrOptionRoutes`,
  `tenantPbxPrompt`, `mobileDeviceCallWakeDiagnostics`, `chatAttachmentMediaMetadata`.
  Read the migration before extending the table.
- **Two CDR tables**: `callRecord` (legacy) and `connectCdr` (authoritative). Worker
  writes both for missed/canceled invites. Don't remove either without coordinated
  reads update.
- **Encrypted columns** (`apiAuthEncrypted`, `credentialsEncrypted`,
  `tokenEncrypted`) require `CREDENTIALS_MASTER_KEY`. Schema changes that move/copy
  these need careful re-encryption logic.
- **`PbxJob`, `TenantPbxLink`, `PbxInstance`** drive provisioning. Their state
  machine (`status: LINKED|ERROR|...`, `pbxJob.status: QUEUED|RUNNING|FAILED|COMPLETED`)
  is tied to worker cycles. Mutating without the worker is risky.

## Realtime / websockets

- **Two WS services exist**: `wss://…/ws` (`apps/realtime`) and `wss://…/ws/telephony`
  (`apps/telephony`). They have different auth and contracts. Don't conflate.
- **`apps/realtime` is currently minimal.** UNKNOWN which features depend on it
  — verify before changing or removing.
- **Telephony WS does NOT push periodic full snapshots.** Initial snapshot only,
  then upsert/remove deltas. See note in `apps/telephony/src/telephony/index.ts`.
  Anyone re-enabling periodic full snapshots reintroduces the ringing-flicker bug.
- **WS keepalive** comes from nginx `proxy_read_timeout 86400s` (`docs/TELEPHONY_NGINX.md`).
  Do not lower without testing 24-hour persistence.

## Mobile — SMS / messaging push notifications

- **VoIP.ms inbound SMS arrives via worker poll, not webhook.**
  The VoIP.ms webhook (`POST /webhooks/voipms/sms`) receives only template
  placeholder pings (`{FROM}`, `{TO}` etc.) — not real messages. Real inbound
  SMS is delivered by the worker's `voipMsInboundSyncJob.ts` polling cycle
  (`status: "routed_poll"` in `SmsRoutingLog`).
- **Fixed 2026-05-08**: The worker poll path never called `sendPushToUserDevices`.
  Push fan-out is now in `importInboundMessage()` via a `sendSmsPush` callback
  injected from `main.ts`. Look for `event: "voipms_inbound_sms_push_sent"` in
  worker logs to confirm.
- **SMS push uses FCM notification message** (includes `title`/`body`/`channelId`),
  not data-only. This ensures Android displays the notification directly even when
  the app is swiped away, without relying on `onMessageReceived` being woken.
- **Webhook `sms_message` fan-out in API** (`connectChatRoutes.ts`) remains as-is
  for the unlikely case VoIP.ms ever switches to real webhook delivery. The two
  paths produce the same push payload shape.

## CRM module (Phases 1A–6B, shipped 2026-05)

- **Local presence is advisory only — not SIP-enforced (open, accepted).** The CRM
  `POST /crm/calls/originate` endpoint selects a matching area-code DID from
  `CrmCallerIdPool` and returns it as a suggested `callerId`. It does NOT modify SIP
  headers, AMI originate parameters, or PBX config. The actual outbound caller ID
  is whatever the normal SIP/PBX flow uses. This is intentional (no PBX changes allowed
  without a separate architecture review). Future work: pass the advisory callerId
  through `crm:dial` → `FloatingDialer` → SIP header if the PBX operator approves it.

- **XLSX import deferred — CSV only (open).** `POST /crm/import/upload` accepts CSV
  only. An XLSX parser was scoped but not implemented. Agents must export to CSV before
  importing. The row cap is 5,000 rows per batch; file size cap is 5 MB.

- **Transcription is a stub — not implemented (open).** `CrmTenantSettings.transcriptionEnabled`
  exists and can be toggled, but no transcription pipeline is wired. Enabling the flag
  has no effect beyond saving the boolean. A real implementation requires a separate
  architecture decision (Whisper, Deepgram, etc.) and is explicitly out of scope for
  the current CRM release.

- **Cross-tenant campaign CSV import not exercised in smoke (open, operational gap).**
  `POST /crm/campaigns/:id/import` is tenant-scoped by JWT like the rest of CRM, but
  Phase 13A/13B smoke runs used only a single pilot tenant with no second-tenant campaign
  fixture in the database. **Isolation is enforced in code**, not proven by a two-tenant
  import test in production. Before treating multi-tenant CRM import as battle-tested,
  run a controlled second-tenant negative test (expect 404 / empty enrollment).

- **CRM nav requires re-login / hard reload after first access grant (open, documented).**
  When an admin grants `CrmUserAccess` to a user, the portal shows the CRM nav only after
  the user's next `GET /me` call (triggered by page reload or re-login). There is no
  live-push of permission changes. This is documented in `CRM_ROLLOUT_CHECKLIST.md` § 1.

- **No power dialer or predictive dialer (open, out of scope).** The CRM campaign queue
  is a manual assembly-line workflow. Agents pick their next contact and click Call.
  There is no auto-dial, no pacing algorithm, and no AMD (answering machine detection).
  These require AMI originate integration which is not part of the current release.

- **Bulk reassign writes no timeline event (intentional).** `POST /crm/contacts/bulk-reassign`
  does not write `ASSIGNED_TO_USER` events to avoid flooding the timeline of every contact
  in a large reassignment operation. Only individual `PATCH /crm/contacts/:id` assignment
  changes create timeline events.

- **Migration ordering — FIXED in Phase 6B.** The two enum-extension migrations
  (`CONTACT_MERGED`, `ASSIGNED_TO_USER`) were originally created with May-12 timestamps
  (`20260512*`), which caused `ALTER TYPE "CrmTimelineEventType"` to run before
  `CREATE TYPE "CrmTimelineEventType"` on a fresh install. Fixed: both migrations were
  moved to `20260522110000` and `20260522120000` (after the foundation migrations).
  The production DB was not affected because the CRM had not yet been deployed at the
  time of the fix.

## Build / repo hygiene

- **Many leftover `_check-*` / `_diag-*` / `pbx-*.txt` files at repo root.** They
  are diagnostic artifacts checked in by accident. Don't extend that pattern; if
  you must, drop them under `_latency_logs/` or `docs/audit/`.
- **`apps/desktop/release/win-unpacked/...` is bundled output**, not source.
- **`logcat-cancel.txt`, `trace*.txt`, `_app-api-last40m.log`,
  `_adb-connect-vm-record-live.log`** are large diagnostic dumps. Don't load them
  unless directly relevant.
