# Changelog

Tracks notable product and agent-delivered changes. Newest entry first.

---

## 2026-06-14 — Storage Health Phase 5B (BuildKit inventory visibility)

**Task:** Fix API scanner returning 0 BuildKit entries while host reports ~535.6 GB cache.

- **Root cause:** `GET /system/df` over the Docker socket returns 2,781 `BuildCache` entries but took ~90s; the API HTTP client timed out at 30s and fell back silently to empty inventory. The investigation endpoint also invoked `docker system df -v` CLI, which is not installed in the `app-api` image.
- Added `buildKitInventory.ts` — unified collector via Docker socket API with `STORAGE_DOCKER_SYSTEM_DF_TIMEOUT_MS` (default 600s), optional `docker builder du` / `docker system df -v` fallbacks when host `docker` CLI is available.
- Scanner dedupes to a single `/system/df` fetch per scan; surfaces `inventoryStatus` + explicit error instead of silent 0 entries.
- Safety gates + dry plan block BuildKit prune when inventory is not `OK`.
- Portal: **BUILDKIT INVENTORY (PHASE 5B)** panel on `/admin/storage-health`.
- **No cleanup executed** — read-only inventory fix only.

---

## 2026-06-14 — Storage Health Phase 5 (controlled cleanup executor)

**Task:** First approved storage reclamation path — staged, gated, auditable cleanup only.

**Changes:**
- Added `apps/api/src/ops/storageMaintenance/cleanupExecutor/*` — health gate (14 services), inventory fingerprint, BuildKit investigation, staged command runner, pre-cleanup snapshot writer.
- Enabled routes when `STORAGE_CLEANUP_ENABLED=1`: `prepare-cleanup`, `approve`, `execute` (stages 1–4), `investigation/buildkit`, `executions`.
- Portal Phase 5 panel: Prepare → Approve → Stage 1–4 buttons.
- Protected `/opt/connectcomms/app` clone root explicitly in `protectionRules`.
- `docker-compose.app.yml`: `STORAGE_CLEANUP_ENABLED` (default `0`).

**Tests:** 38 passing in `storageMaintenance.test.ts`.

---

## 2026-06-14 — Storage Health Phase 3 (zero-unknown forensics)

**Task:** Eliminate unknown inventory blockers with forensic proof; reach 95%+ readiness without cleanup.
**Risk:** read-only — classification fixes and dashboard panels only.

- Fixed 3 production unknowns: `/opt/connectcomms` app root → `ACTIVE_REQUIRED`; deploy logs → `SAFE_CANDIDATE`; anonymous rtpengine volume → `ACTIVE_REQUIRED` via container mount cross-reference (Docker RefCount=0 proof).
- Added `volumeMountIndex`, `forensicInvestigation`, `containerdForensics`, `buildCacheGrouping`, `readinessBreakdown` proof modules.
- Dashboard: Unknown Items, Dependency Proof, Orphan Analysis, Blockers, Readiness Breakdown, Containerd/Build cache forensics panels.
- Safety gates now list exact blocker IDs/paths (not generic counts).
- 34 unit tests.

**No cleanup executed.**

---

## 2026-06-14 — Storage reclaim estimate dedupe fix

**Task:** Build proof, dependency mapping, confidence scoring, rollback verification, and pre-cleanup readiness before any storage reclamation.
**Risk:** critical scope — read-only except timestamped JSON preflight snapshots; no prune, delete, restart, or execution.

- Added `apps/api/src/ops/storageMaintenance/proofSystem/*` — BuildKit forensics, container→image dependency graph, rollback audit, APK/log forensics, confidence engine, readiness scoring, safety gates, preflight snapshot generator.
- Extended scanner + dashboard with `operationsCenter` payload (build cache analysis, dependency coverage, rollback coverage, confidence distribution, risk matrix, protected assets).
- Added `POST /admin/storage-health/snapshot` (202 async) — writes read-only JSON to `/opt/connectcomms/backups/storage-preflight/`.
- Added writable preflight mount on `api` / `api_candidate` in `docker-compose.app.yml` (`STORAGE_PREFLIGHT_SNAPSHOT_ROOT`).
- Redesigned portal `/admin/storage-health` as Operations Center: Cleanup Readiness KPI, Generate Snapshot, safety gate blockers, dependency/rollback/confidence sections.
- Extended Docker API whitelist for `/images/{id}/json` image inspect.
- 30 unit tests (confidence, dependency, rollback, readiness, snapshot, safety gates, protected/unknown blocking).

**Documentation:** `STORAGE_MAINTENANCE.md` § Phase 2, `SERVER_OPERATIONS.md`, `DEPLOYMENT.md`.

**No cleanup executed.** Approve **501** / execute **403** unchanged.

---

## 2026-06-14 — Storage Health host visibility layer (Phase 1.6)

**Task:** Enable Storage Health scanner to see real Docker host inventory from inside the API container.
**Risk:** low — read-only mounts and GET-only Docker API access; no cleanup, prune, delete, or restart.

- Added read-only host inventory mounts to `api` / `api_candidate` in `docker-compose.app.yml`:
  `docker.sock`, `/var/lib/containerd`, `/opt/connectcomms`, `/var/log` under `/host-inventory`.
- Added `hostVisibility.ts` — mount probes, Docker Engine GET whitelist, host path display remap.
- Added `dockerSystemDfApi.ts` — parse `/system/df` JSON (BuildKit cache, reclaimable estimate).
- Rewrote `dockerDeps.ts` — HTTP Docker API over socket (no CLI), `du -sb` sizing for large paths.
- Extended `scanner.ts` — containerd overlay/content breakdown, host visibility snapshot on scan.
- Extended dashboard + portal Containerd KPI card; 23 unit tests (3 new).

**Documentation:** `STORAGE_MAINTENANCE.md` § Phase 1.6, `SERVER_OPERATIONS.md`, `DEPLOYMENT.md`.

**No cleanup executed.** Approve **501** / execute **403** unchanged.

---

## 2026-06-14 — Storage Health operations dashboard (Phase 1.5)

**Task:** Upgrade `/admin/storage-health` from basic tables to production-grade operations dashboard.
**Risk:** low — read-only UI + API analytics; no execution, prune, or delete.

- Added `dashboard.ts` — KPI summary, distribution breakdown, top-20 consumers, protected assets, reclaim simulation, risk scoring, trend series (24h/7d/30d), cleanup readiness rows.
- Expanded `GET /admin/storage-health` and scan responses with `dashboard` payload (actual scan data, not placeholders).
- Redesigned portal page: premium KPI cards, distribution chart, alert center, trend graphs, consumer table, protection status, reclaim simulation, cleanup readiness (approve 501 / execute 403 unchanged).
- 20 unit tests covering dashboard analytics and API contracts.

**Documentation:** `STORAGE_MAINTENANCE.md` § Phase 1.5, `SERVER_OPERATIONS.md`, `DEPLOYMENT.md`.

**No cleanup executed.**

---

## 2026-06-14 — Production storage forensics (read-only)

**Task:** Investigate 545 GB disk usage on production app host (`vmi3101417`).
**Risk:** none — read-only inspection only; no cleanup, no server mutations.

**Findings:**
- **545 GB / 678 GB (81%)** used on `/dev/sda1`.
- **~534 GB (98%)** is Docker BuildKit build cache in `/var/lib/containerd` (2,744 cache entries, 4,202 overlay snapshots) accumulated from routine api/portal/worker blue/green deploy builds.
- **~13 GB** is `/opt/connectcomms` (6.6 GB mobile APK downloads, 3.9 GB deploy clone, 1.3 GB monitoring logs).
- **~2.3 GB** is `/var/log` (mostly systemd journal).
- Live production data (Postgres bind mount, Redis, Docker volumes) totals **~1 GB**.
- 0 dangling images, 0 stopped containers, 4 inactive images (2 candidate + 2 superseded base images).

**Documentation:** `SERVER_OPERATIONS.md` (new), `DEPLOYMENT.md` § Storage capacity, this entry.

**No cleanup performed.** Await explicit approval before any reclamation.

**Follow-up:** Phase 1 storage cleanup controller — read-only scanner, classifier, dry-run plan API + `/admin/storage-health` UI. See `STORAGE_MAINTENANCE.md`.

---

## 2026-06-14 — Storage cleanup controller Phase 1 (read-only)

**Task:** Safe storage cleanup controller — scanner, classifier, dry-run plan, admin UI.
**Risk:** low — read-only Phase 1; no deletes, prunes, restarts, or execution endpoints.

- Added `apps/api/src/ops/storageMaintenance/*` — read-only scanner (disk, Docker, APKs, logs), safety classifier, command guard, dry-run cleanup plan builder, in-memory audit log.
- Added super-admin API routes under `/admin/storage-health` (scan, plan, history, audit; approve/execute return 501/403).
- Added portal **`/admin/storage-health`** workspace with Scan Now, Cleanup Plan preview, inventory table, disk trend, alerts.
- Permission: `can_view_admin_storage_health`; reserved `can_approve_storage_cleanup` for Phase 2.

**Documentation:** `STORAGE_MAINTENANCE.md`, updates to `SERVER_OPERATIONS.md`, `DEPLOYMENT.md`.

Verification:
- `pnpm --filter @connect/api exec node --experimental-test-module-mocks --import tsx --test "src/ops/storageMaintenance/storageMaintenance.test.ts"`

**No cleanup executed.** Phase 2 requires explicit human approval token.

---

## 2026-06-14 — Server Health workspace + portal/mobile polish deploy

**Task:** API + portal server-health observability, portal workspace polish, chat media metadata, and supporting test fixes.
**Risk:** medium — API + portal blue/green production deploy; no Prisma migration.

- Added the super-admin **Server Health** workspace at `/admin/server-health` with live host metrics, CPU consumer ranking, service probes, deploy queue status, and dark/light themed CPU trend charts.
- Added API health snapshot support under `/admin/server-health`, backed by host metrics sampling and cache refresh helpers. Access is gated by `can_view_admin_server_health`.

Deploy: **api + portal** direct blue/green deploy pinned to `bec76d5847dbaa9f38008e7d33e8a4ea290b669c`.

---

## 2026-06-10 — Mobile Add-to-Contacts form + foreground notification presentation

**Task:** Mobile app — make Add-to-Contacts an editable, pre-filled form; make
new-message / voicemail / missed-call notifications surface while the app is open.
**Risk:** high — mobile (Expo/React Native) client only; **no PBX, telephony, API,
worker, or database changes** in this entry.

- **Add to Contacts is now an editable form** (`apps/mobile/src/components/AddContactModal.tsx`,
  shared component): tapping "Add to contacts" from a Recent Call opens a
  pre-filled "New Contact" sheet (external number filled in, plus a caller name
  only when the PBX delivered a real caller ID — never the user's own extension
  name). The user reviews/edits the name and adds email/company/notes before
  saving. It no longer silently saves a bare, nameless number. Dedupe + the API
  `DUPLICATE_PHONE` guard still apply; saved contacts resolve onto Recent rows.
- **Foreground notification gap fixed** (`NotificationsContext.tsx` +
  `notifications/notificationRouting.ts`): the native Android FCM service
  deliberately skips the tray while the app is foreground, and the JS listener
  previously only logged — so a new chat message / voicemail / missed call that
  arrived while the app was open was silently dropped. The foreground push
  listener now presents a local notification (on the correct channel:
  `connect-voicemail` / `connect-missed-calls` / `connect-messages`) for the four
  user-alert types, guarded against re-entrancy, against pushes that already
  carried an OS notification block, and against the actively-viewed chat thread.
  New pure helpers `shouldPresentForegroundUserAlert` / `userAlertChannelId` /
  `isUserAlertPushType` with 11 unit tests
  (`pnpm --filter @connect/mobile test:notification-routing`).

**Per-user notification isolation (no leakage between users):**
- **Hard client-side recipient guard** (`notificationRouting.ts`
  `isNotificationForCurrentUser` + `setCurrentNotificationIdentity`): the app now
  tracks the signed-in user's `userId`/`tenantId` (decoded from the JWT) and the
  notification handler, foreground listener, and foreground-present decision all
  drop any user-alert addressed to a different user/tenant. Last line of defence
  against a stale/rotated/reassigned push token ever delivering another user's
  notification. Conservative: only blocks on a positive mismatch.
- **Logout now unregisters the device** (`AuthContext.logout` →
  `POST /mobile/devices/unregister` with this device's expo token) so the
  user signing out stops receiving notifications on that phone immediately.
- **Server stamps `recipientUserId`** on every user-alert push (`dm_message`,
  `sms_message`, `voicemail`, `missed_call` in `apps/api` + the worker SMS poll)
  so the client guard is exact at the **user** level (not just tenant) — closes
  the same-tenant cross-user chat case. (Server send path was already scoped to
  `{tenantId, userId, active:true}`; this is defence-in-depth.) **Requires api +
  worker deploy.**

**Notification root-cause findings (server-side):**
- **Voicemail push is disabled by default** — gated behind
  `VOICEMAIL_PUSH_NOTIFICATIONS_ENABLED` (a "SEV-1 containment" default in
  `apps/api/src/server.ts`). Unless that env flag is `true`, no voicemail push is
  ever sent. This is the primary cause of "no voicemail notifications" and
  requires an env/ops decision (or an approved API code-default change + deploy).
- All user-alert pushes are **data-only** (no `notification` block). Android
  renders them via the native service (background) + the new foreground path;
  **iOS has no native equivalent**, so iOS background/killed alerts remain a
  structural gap (out of scope for this Android APK).
- Pushes are filtered by `active: true` device + per-thread `muted: false`;
  battery-optimization / force-stop can stop the Android FCM service from firing.

Deploy: **none for the APK** — mobile build + publish only. Voicemail re-enable
is a separate server decision.

---

## 2026-06-10 — Mobile caller ID / ring-group prefix + Recent Calls fixes

**Task:** Mobile app — Recent Calls Add-to-Contact, external number display, incoming caller ID / ring-group prefix
**Risk:** high — mobile (Expo/React Native) client only; **no PBX, telephony, API, worker, or database changes**

Evidence (from `docs/pbx-brain/` snapshot): VitalPBX ring groups prepend the
prefix to the CallerID **name** with a colon — `Set(CALLERID(name)=Estimates:${CALLERID(name)})`
(`extensions__50-9-dialplan.conf`) — while `CALLERID(num)` keeps the raw
external number. The Connect wake hook forwards **both** (`fromNumber=${CALLERID(num)}`,
`fromDisplay=${CALLERID(name)}`), telephony (`MobilePushNotifier`), the
`CallInvite`/push payload, and `GET /voice/me/calls` (`ConnectCdr.fromNumber` +
`fromName`) all preserve both. The defects were **mobile rendering only**.

- New shared helper `apps/mobile/src/calls/callerIdentity.ts` — a single
  normalized caller-identity model (`externalNumber`, `displayName`,
  `ringGroupPrefix`, `extensionNumber`, `extensionName`, `rawSipCallerId`,
  `rawPbxCallerId`, `direction`) with deterministic display rules and
  `callbackNumber` / `suggestedContactName`. 13 unit tests
  (`callerIdentity.test.ts`, `pnpm --filter @connect/mobile test:caller-identity`).
- **Recent Calls** (`RecentTab.tsx`): rows now show the external number as a
  secondary line + a ring-group prefix badge; the number is never hidden behind
  the name. Saved contacts resolve onto rows (number→name map).
- **Add to Contacts** (`RecentTab.tsx`): implemented — creates a contact from
  the recent call's external number (prefix-stripped name pre-filled), dedupes
  against existing contacts and the API `DUPLICATE_PHONE` guard, clear error
  when no usable number exists.
- **Incoming Call screen** (`IncomingCallScreen.tsx`): shows the ring-group
  prefix as a context badge + caller name + external number, deterministically;
  never collapses to prefix-only and never uses the user's own extension name
  for an inbound external caller.

Deploy: **none** — APK build + publish to the Connect download page only.
Rollback: republish previous APK (`connectcomms-latest.previous.apk`).

---

## 2026-06-10 — Hosted payment page Sola trust badge + dark mode

**Task:** Billing / hosted invoice payment page — official Sola brand asset, trust badge polish, dark-mode support
**Risk:** high — public payment UX only; no API, worker, gateway, database, CRM, telephony, WebRTC, onboarding, or PBX changes

- Replaced the hosted payment footer's plain `SOLA` text with the official Sola Payments logo via reusable `SolaLogo` and `PaymentTrustBadge` components.
- Added the official logo SVG under `apps/portal/public/assets/vendor/sola/`, with source/usage notes.
- Hosted invoice payment page theme now supports `?theme=dark` / `?theme=light`, existing app theme when available, and `prefers-color-scheme` fallback.
- Refined the public payment trust badge layout for desktop, tablet, and narrow mobile widths; copy remains limited to secure processing and SSL encryption without PCI overclaiming.

Deploy: **portal only** (blue/green direct deploy after local verification). Rollback: redeploy previous portal SHA.

---

## 2026-06-09 — PBX brain snapshot (docs only, no deploy)

**Task:** PBX repo/config read-only export for Cursor + voicemail-drop design  
**Risk:** low — documentation only; secrets redacted per `RISKS_AND_LIMITATIONS.md`

- Added `docs/pbx-brain/` extracted VitalPBX/Asterisk snapshot + architecture indexes:
  `PBX_ARCHITECTURE.md`, `VITALPBX_STRUCTURE.md`, `TENANT_MODEL.md`,
  `CONNECT_INTEGRATION_POINTS.md`, `RISKS_AND_LIMITATIONS.md`.
- **Excluded** local `pbx-full-brain-*.tar.gz` (~500MB) from git — extracted tree only.
- Referenced by `docs/pbx/connect-voicemail-drop-plugin-design.md`.

Deploy: **none** (docs-only).

---

## 2026-06-09 — CRM UI/design cleanup: queue, wallboard, workspace CSS

**Task:** CRM portal visual refresh — queue + wallboard + shared workspace surfaces  
**Risk:** low — portal CSS/layout only; no API/worker/telephony changes

- **`globals.css`:** expanded CRM workspace styling for queue, wallboard, checklists,
  tasks, contacts, and email action links; light/dark theme scoping preserved.
- **`/crm/queue`:** adds `crm-my-queue-workspace` route hook for scoped layout rules;
  member status chips use semantic `crm-queue-status-*` classes (see `queueUtils.ts`).
- **`/crm/wallboard`:** locks light wallboard presentation (`lightWallboard = true`) and
  removes runtime theme flip observer — wallboard is intentionally light-first for TV/desk
  displays.
- **Tests:** `@connect/portal` typecheck clean.

Deploy: **portal only** (blue/green direct deploy). Rollback: redeploy previous portal SHA
(`fa58959623fe06961804c367deac944ab30eb24f` or earlier).

---

## 2026-06-09 — Voicemail Drop: PBX plugin design + AMI app-side wiring (local only)

**Task:** CRM / dialer / voicemail drop — design from PBX repo snapshot + build
**Risk:** extreme — live telephony, active call legs, PBX dialplan

Built (local only — **PBX plugin NOT installed**; backend safely refuses until it is):

- **PBX plugin** `scripts/pbx/install-connect-vm-drop-dialplan.sh` (install/`--check`/
  `--dry-run`/`--rollback`) writing the additive `[connect-vm-drop]` context to
  `/etc/asterisk/vitalpbx/extensions__96-connect-vm-drop.conf` (auto-loaded by the
  existing `#include vitalpbx/extensions__*.conf`, mirroring `__95-connect-vm-greeting`).
  Exact snippet: `docs/pbx/connect-voicemail-drop-context.conf`. Pluggable wait
  strategy (Choice B): `fixed` default; `amd`/`waitsilence` ready (both modules loaded).
- **Telephony** `POST /telephony/internal/calls/voicemail-drop` — classifies customer
  vs agent leg (`voicemailDropLegs.ts`, unit-tested), **hard-guards** on
  `DIALPLAN_EXISTS(connect-vm-drop,s,1)` (never redirects into a missing context),
  `Setvar`+`Redirect` customer leg, `Hangup` agent leg.
- **API** `POST /crm/voicemail-drops/drop` repointed from broken ARI play-prompt to the
  AMI path; `contactId`/`voicemailDropId` optional (default recording); timeline on
  success/failure.
- **UI** floating dialer: CRM-gated ("can_view_section_crm") Voicemail Drop control; the
  backend hangs up the agent leg so the dialer frees immediately.

Design + full answers (include point, context name, channel strategy, install/rollback,
risks, tests): `docs/pbx/connect-voicemail-drop-plugin-design.md`.

Tests: `@connect/telephony` 48/48 pass (incl. 7 new leg-classifier tests); telephony +
portal typecheck clean. PBX brain snapshot inspected: `docs/pbx-brain/`.

---

## 2026-06-09 — Voicemail Drop: root-cause investigation (playback inoperable on this PBX)

**Task:** CRM / dialer / voicemail drop / live-server investigation  
**Risk:** extreme — live telephony, active call legs, PBX dialplan

### Root cause (server-verified, not guessed)

The CRM Voicemail Drop **playback step has never worked on this PBX build** and is
architecturally incapable of working as currently written:

- The drop path is `POST /crm/voicemail-drops/drop` → push WAV to PBX `custom/`
  (works) → `POST /telephony/internal/calls/play-prompt` → ARI
  `POST /ari/channels/{id}/play` (`apps/telephony/src/routes/telephony.ts`).
- That ARI call **requires the channel to be inside a registered Stasis
  application**. This Asterisk build ships **without `res_ari_websockets.so`**,
  so the telephony service runs **REST-only ARI** and never connects a Stasis
  app (`apps/telephony/src/telephony/ari/AriClient.ts` header comment).
- Live ARI proof against `http://209.145.60.79:8088`:
  - `GET /ari/applications` → **`[]`** (no `connectcomms` Stasis app registered).
  - `GET /ari/channels` → live call channels are ordinary dialplan channels
    (`app_name: Hangup`, context `messages`), **never in Stasis**.
  - Result: `/channels/{id}/play` returns `409` → caught as `pbx_playback_failed`.
- Corroboration that it never once succeeded: DB `CrmVoicemailDrop.usageCount = 0`,
  `lastUsedAt = NULL`; **zero** `CrmTimelineEvent` rows of type `VOICEMAIL_DROP`;
  **zero** `/telephony/internal/calls/play-prompt` hits in 9 days of telephony logs.
- Secondary gap: the drop UI exists **only on the CRM contact page**
  (`CrmVoicemailDropDrawer`), not on the active-call dialer; it also never
  releases the agent leg or ends the call after playback.

### Sustainable fix (planned — gated on approval)

Working playback on this build must go through **AMI**, not ARI: AMI `Setvar`
+ `Redirect` the customer/PSTN trunk leg into a new additive dialplan context
`[connect-vm-drop]` (`Answer → Playback(custom/${VMDROP_FILE}) → Hangup`), then
AMI `Hangup` the agent leg. See `docs/pbx/connect-voicemail-drop-context.conf`
and `TELEPHONY.md` § Voicemail Drop.

### Not included / blocked

- **No PBX dialplan change made** — adding `[connect-vm-drop]` + `dialplan reload`
  is a VitalPBX change requiring human approval (`AGENTS.md`); not done blindly.
- **No live proof test** — the drop cannot complete until the dialplan context is
  installed; shipping an AMI redirect against a missing context would drop the
  live customer call, so backend wiring is held until the context is approved.
- **Beep/voicemail detection is not implemented** (no AMD / `WaitForSilence`); the
  safe available approach is a fixed `Wait()` before `Playback`.

---

## 2026-06-09 — CRM learned website submission email intake

**Task:** CRM / email sync / learned website submission rule  
**Risk:** high — CRM email worker, Prisma schema, contact/document writes, PII handling

### Shipped

- Added tenant-scoped learned website submission email rules in CRM Email settings.
- Extended the existing CRM email sync worker with a rule-gated inbox scan that leaves tracked-thread reply sync unchanged.
- Matching emails create `CrmWebsiteSubmission` records, extract only existing CRM contact fields, create/update CRM contacts, link email attachments through CRM document storage, write timeline events, and create dismissible CRM notifications.
- Added PII redaction for logs/UI summaries and masked notification/timeline text.

### Not included

- No webhook intake, separate intake app, broad Gmail archive, or generic custom-field system.
- Low-confidence/review-first submissions are recorded without auto-updating important contact fields.

---

## 2026-06-08 — WebRTC TURN provisioning unify + relay health guards

**Task:** telephony / TURN / app-level relay hardening deploy  
**Risk:** high — production telephony provisioning path; API blue/green deploy

### Root cause (preserved)

- Softphone provisioning ignored the admin `TurnConfig` table.
- Because `tenant.iceServers` was `null`, `GET /voice/me/extension` fell back to env `TURN_SERVER`.
- `TURN_SERVER` was a **bare IP**, so `buildEnvIceServers()` emitted only
  `turn:45.14.194.179:3478` (**UDP only**).
- Clients had **no TCP/TLS relay fallback** → restricted/4G/CGNAT users failed media/audio.
- Relay usage was **0% system-wide for days**; nobody was watching.
- **coturn TLS 5349 is still down** and must be fixed separately (infra runbook pending).

### Shipped (app-level only)

- New `apps/api/src/voice/iceServers.ts` — multi-transport ICE builder (UDP+TCP+TLS) with
  HMAC ephemeral creds + `assertIceServersHaveRelayFallback` guard.
- New `apps/api/src/voice/turnProbe.ts` — active STUN/TURN Allocate probe (udp/tcp/tls, no deps).
- New `apps/api/src/voice/relayUsage.ts` — per-tenant relay-usage SLO analyzer.
- `apps/api/src/server.ts` — `resolveClientIceServers()` serves the admin `TurnConfig`
  multi-transport set with fresh HMAC creds (config delivered == config validated); env
  fallback now expands to udp+tcp(+TLS); startup ICE-fallback guard, TURN Allocate probe loop,
  and relay-usage SLO loop with Prometheus gauges.
- `apps/api/package.json` — test runner now includes `src/voice/*.test.ts`.

No infra (coturn/firewall/nginx/PBX), CRM, billing, or onboarding changes. No DB migration.

### Verification

- `iceServers` / `turnProbe` / `relayUsage` / `voiceProvisioningBundle` tests: **31/31 pass**.
- API typecheck: new files + `server.ts` clean. Pre-existing unrelated errors remain in
  `src/voice/webrtcCallDiagnostics.ts`, `src/webrtcCallingIncident.test.ts`,
  `src/webrtcGlobalOutage.test.ts`, and `packages/{db,shared}/src/webrtc*` (subpath
  `@connect/shared/*` moduleResolution + implicit-any in existing tests — not introduced here).
- Live Allocate probe vs coturn: **udp:3478 OK, tcp:3478 OK, tls:5349 ECONNREFUSED**.

### Remaining infra blocker

**coturn TLS listener on 5349 down (`ECONNREFUSED`).** TLS relay URL advertised but unusable
until coturn TLS is restored; TCP relay on 3478 is the working fallback. **Infra runbook for
5349 still pending** — handle separately.

---

## 2026-06-06 — CRM page rollout + backend support deploy

**Task:** CRM portal pages / API support / production deploy  
**Risk:** high — multi-page CRM UI, Prisma migrations, API + portal blue/green deploy

### Shipped

- Independent CRM page commits for shared shell/styles, campaigns, checklists, contacts,
  email/signing, funders, live call, queue, scripts, tasks, and voicemail drops.
- API/DB support for CRM SMS templates, funder timeline events, CRM form autofill/public
  signing behavior, CRM contact SMS decoration, and worker email sync support.
- Prisma migrations applied in production:
  `20260606001000_crm_sms_templates` and `20260606002000_funder_timeline_events`.
- API and portal deployed via scripted blue/green direct deploy at `0102aa45`.

### Verification

- `pnpm --filter @connect/portal typecheck` passed.
- Focused CRM/API tests passed: `crmFormService.test.ts`, `crm/bulkEmail.test.ts`,
  `crm/crmPermissionAudit.test.ts`, and `smsSharedInbox.test.ts` (37/37).
- Full API suite still has two unrelated `cdrDirection.test.ts` failures for local
  ambiguous PSTN direction expectations.
- Container verification:
  - API `app-api-1` contains `createSmsTemplateBodySchema`.
  - Portal `app-portal-1` `.build-commit` is `0102aa45bd50fff83c8de7366f4ba72f5bb8f07e`.
  - Portal `/ready` returns `{ "ok": true }`.

### Deploy note

The direct deploy dry-run advanced the shared server checkout and an immediate real deploy
reported `skip=no_changes` despite the running API image being stale. The real rollout was
completed using the normal scripted deploy path with a temporary service state pointing to
the pre-CRM SHA so change detection rebuilt and ran migrations. See `DEBUGGING.md`.

---

## 2026-06-04 — Platform-wide WebRTC outage detection

**Task:** telephony / WebRTC / outage prevention  
**Risk:** extreme — incident system only; no PBX/media fix

### Shipped

- **`GLOBAL_WEBRTC_OUTAGE`** incident type with warning/critical severity.
- **Global triggers (15 min):** 3+ tenant failures, 10+ SDP/488 cluster, 10+ inbound
  answer failures, success-rate collapse (min 10 attempts), mixed-direction outage.
- **`WebrtcPlatformOutage`** + per-admin dismissals; dedupe by 15-minute bucket.
- **API:** `GET /admin/webrtc-platform/outage/active`, `POST …/dismiss`,
  `GET /admin/webrtc-platform/health` (super-admin / `can_manage_global_settings`).
- **Portal:** `WebrtcGlobalOutageBanner`, `WebrtcPlatformHealthCard` on `/admin`;
  global outage merged into Incident Center and Ops Center.
- **Tests:** shared evaluator, db dismiss/reopen/dedupe, API route + aggregation checks.

### Prevention coverage

Before this pass, the Jun 2026 multi-tenant outage (T2/T25/T7, portal + mobile,
inbound + outbound) would only surface as isolated per-tenant alerts. Global
correlation now fires a platform incident when multiple tenants degrade simultaneously.

### Docs

- `WEBRTC_DIAGNOSTICS.md` — § Platform-wide WebRTC outage detection
- `TELEPHONY.md` — global outage subsection

---

## 2026-06-04 — WebRTC black-box diagnostics hardening (schema v2)

**Task:** telephony / WebRTC / black-box diagnostics  
**Risk:** extreme — instrumentation only; no PBX/media fix

### Shipped

- **`packages/shared/src/webrtcBlackbox.ts`** — schema v2, extended SDP summary, timeline,
  redaction, truncation (48 KB), alert specs, diagnosis classification.
- **API** — `POST /voice/diag/webrtc-sdp-debug` accepts outbound/inbound/summary payloads;
  Zod validation (400 on malformed); `WEBRTC_CALL_DEBUG` compact log line for grep.
- **Portal** — `PortalWebrtcBlackboxRecorder` wired on outbound dial + all failure paths.
- **Mobile** — `MobileWebrtcBlackboxRecorder`, inbound timeline at answer-tap,
  `session_not_found_timeout` / `sip_invite_not_received` black-box posts.
- **Admin incidents** — `WebrtcCallingIncident` + dismissible `/admin` banner; threshold
  evaluation on diag ingest; Incident Center / Ops Center integration.

### Docs

- `WEBRTC_BLACKBOX_SCHEMA.md` — full field reference
- `WEBRTC_DIAGNOSTICS.md`, `CURSOR_START_HERE.md` — routing updated

### Mobile build

**Pending EAS build** — mobile black-box hooks require a new APK; API + portal active immediately.

---

## 2026-06-04 — WebRTC outage proof-only pass (BLOCKED_BY_PBX_ACCESS)

**Task:** telephony / WebRTC / P0 proof-only investigation  
**Risk:** extreme — read-only; no code/deploy/PBX changes

### Classification

**BLOCKED_BY_PBX_ACCESS** — failure/recovery timestamps and distinct failure signatures are
**proven in DB**; outage cause and recovery trigger are **not proven** (PBX SSH denied).

### Proven (DB / deploy / container / AMI)

- Portal outbound: 10× `VoiceDiagEvent.endReason = "Incompatible SDP"`; recovery at
  `2026-06-04T10:44:36.598Z` (`user_hangup`, 53447 ms).
- Mobile outbound: 3 failed + 1 recovered (`cfs_mpzddtvd_4s3nl`, `OUTBOUND_CONNECTED`).
- Mobile inbound: 5 failed sessions; 3× `session_not_found_timeout`, 2× `INVITE_CLAIMED` →
  `CALL_ENDED` without `SIP_ANSWER_SENT`. Zero inbound rows with `sdpReject: true`.
- First failure `2026-06-03T15:38:40.296Z` predates deploy `0f86e753` (api `16:35:17Z`).
- Diagnostics deploys `c2aa5ae5`/`2fffba59` finished `05:17:41Z`; recovery `10:44:36Z`.
- `WEBRTC_SDP_DEBUG` count = 0.
- AMI: `CoreStartupDate: 2026-05-12`; `CoreReloadDate: 2026-06-04`, `CoreReloadTime: 06:46:44`.
- `app-telephony-1` not restarted in recovery window (`StartedAt: 2026-05-31`).

### Blocked

- PBX logs, timezone, reload actor/scope, config mtimes, package/cron history.
- Outbound rejected SDP attribute.
- Single shared root cause for inbound + outbound.

### Docs

- `WEBRTC_DIAGNOSTICS.md` — proof/blocker status only (speculation removed)
- `TELEPHONY.md` — banner updated
- `MOBILE_CALL_TIMELINE.md` — DB evidence rows cited

---

## 2026-06-04 — Full WebRTC calling outage forensics (inbound + outbound)

## 2026-06-04 — Portal WebRTC SDP debug capture (gated, redacted) — webrtc-internals failed

**Task:** telephony / WebRTC / portal call-path diagnostics  
**Risk:** extreme — instrumentation only; gated; **no media fix, no deploy yet, no APK**

### Why

Live portal capture showed `chrome://webrtc-internals` exposing **only `getUserMedia`** — no
`RTCPeerConnection` / no `setLocalDescription` SDP — while Console showed ICE
`gathering → complete` then `[SIP] CALL_FAILED cause: Incompatible SDP`. So webrtc-internals
can't give us the offer; we must capture it in-app.

### What shipped (code, gated + redacted)

- `apps/portal/lib/webrtcSdpDiagnostics.ts` — added `redactSdpForDebug()` (strips
  `a=ice-ufrag`/`a=ice-pwd` + masks candidate/connection IPs; keeps codecs/fmtp/profile/DTLS
  fingerprint); strengthened `webrtcSdpDebugEnabled()` (dev build **or** `?webrtcDebug=1` **or**
  `localStorage cc_webrtc_sdp_debug=1`).
- `apps/portal/hooks/useSipPhone.ts` — full outbound lifecycle record (`webrtcDebugRef`):
  target, `ua.call()` invoked/returned, sessionId, `peerconnection` event, local offer SDP
  (redacted; from JsSIP `sdp` event with peerconnection `localDescription` fallback), failed
  cause, SIP `status_code`/`reason_phrase`/method. On failure emits a `[WEBRTC_SDP_DEBUG]`
  console block + `window.__ccWebrtcDebug` + `__ccDownloadWebrtcDebug()` download. All capture
  is gated; ICE creds never logged.
- `apps/portal/lib/webrtcSdpDiagnostics.test.ts` — +1 test for redaction (9 total, green).

### Not done (still gated on the captured offer)

No media/codec fix, no deploy, no APK. To capture in production this needs a **gated portal
diagnostics deploy** (blue/green) since webrtc-internals can't surface the offer. See
`WEBRTC_DIAGNOSTICS.md` §4b.

---

## 2026-06-04 — WebRTC 488: endpoint config identical + codec-runtime DISPROVEN

**Task:** telephony / WebRTC / codec runtime verification  
**Risk:** extreme (read-only diagnostics; no code/deploy/PBX change)

### Evidence captured (live, read-only AMI)

- **Endpoint config comparison** `T2_103_1` (failing portal) vs `T30_102_1` (reference) via
  `PJSIPShowEndpoint`: **identical and WebRTC-correct** across every focus field — `webrtc`,
  `use_avpf`, `media_encryption=dtls`, `dtls_setup=actpass`, `ice_support`, `rtcp_mux`,
  `allow` (incl. opus+ulaw), `transport=wss`, `rtp_symmetric`, `direct_media=false`. Static
  endpoint config is **not** the cause. Artifact: `_latency_logs/webrtc_endpoint_live.txt`.
- **Codec runtime** via AMI `ModuleCheck`: `codec_opus.so`, `res_format_attr_opus.so`,
  `codec_g729.so`, `res_format_attr_g729.so`, `codec_ulaw/alaw`, `res_srtp`, `res_pjsip` all
  **LOADED**. Asterisk **20.18.2**. The "opus module unloaded" hypothesis is **DISPROVEN**.
  Artifact + reusable probe: `_latency_logs/ami_codec_runtime.js`.

### AMI capabilities established for `pbx_audit`

Permitted (read): `GetConfig`, `PJSIPShowEndpoint`, `ModuleCheck`, `CoreSettings`,
`CoreStatus`. Blocked: `Command` (arbitrary CLI). `/var/log/asterisk` is **not** mounted in
the app containers, so Asterisk SDP/488 logs require full PBX shell.

### Net root-cause status

Ruled out: recent server deploys (CRM/mobile-only in the break window), static endpoint
config, runtime codec modules. Remaining: the **client offer SDP** (decisive artifact, still
uncaptured) or an **Asterisk-20.18.2 / global media** change on the PBX. See
`WEBRTC_DIAGNOSTICS.md` §9–§10.

---

## 2026-06-04 — WebRTC outbound SDP instrumentation + release gate (portal)

**Task:** telephony / WebRTC / P0 outage fix and hardening  
**Risk:** extreme (STOP THE LINE) — instrumentation only this turn; **no media fix, no deploy, no APK**

### What shipped (code, safe/additive)

To get the one missing artifact (the failed client **offer SDP**) without guessing a fix:

- **`apps/portal/lib/webrtcSdpDiagnostics.ts`** *(new, pure)* — `summarizeOfferSdp()`
  (non-secret offer summary: profiles, codecs, rtcp-mux, BUNDLE, DTLS, ICE, extmap),
  `isWebrtcSdpRejection()` (SIP **488/606** = JsSIP `INCOMPATIBLE_SDP`),
  `sdpRejectionLabel()`, `checkOfferCompatibility()` (regression guard),
  `webrtcSdpDebugEnabled()`.
- **`apps/portal/lib/webrtcSdpDiagnostics.test.ts`** *(new)* — 8 tests, added to portal `test`
  script. All green.
- **`apps/portal/hooks/useSipPhone.ts`** — read-only `session.on("sdp")` capture of the local
  outbound offer (**never munged**) with a safe console summary; on `failed`, extract the SIP
  status code, and for 488/606 emit a clearly-labeled **`[WEBRTC_SDP_REJECT]`** console group
  (offer summary + full SDP) plus an **ungated** server diag event (the normal call-quality
  report drops sub-1s failures, which is why fast SDP rejects were invisible). Full-SDP console
  dump is opt-in via `localStorage cc_webrtc_sdp_debug=1`.

### Why (root cause status)

Proven: Asterisk returns **488** to the WebRTC outbound INVITE → **no channel, pre-dialplan**.
The exact rejected SDP attribute is still **unproven**, so no media/codec/constraint change was
made. The previously-suspected "strict `channelCount`/`sampleRate`" theory **cannot** produce a
488 (capture constraints don't change the SDP codec list); this instrumentation will prove the
real attribute on the next failed portal call.

### Hardening

- New **`docs/ai-context/WEBRTC_RELEASE_GATE.md`** — manual smoke check + rollback + known-good
  config; any deploy touching WebRTC/SIP/provisioning/media must pass it before publish.
- `checkOfferCompatibility()` gives a regression guard against shipping an offer missing
  DTLS/opus/SAVPF/rtcp-mux.

### Not done (gated on SDP proof)

Media-config fix, deploy, and APK are **deliberately withheld** until the captured offer proves
the exact mismatch.

---

## 2026-06-04 — WebRTC outbound 488/Incompatible SDP incident (diagnostics doc)

**Task:** telephony / WebRTC / diagnostics documentation  
**Risk:** low (docs only — no code, no deploy)

### Summary

Documented the **WebRTC outbound call failure** incident and the exact SDP evidence
required before any fix. Read-only investigation (mobile flight recorder, PBX `pjsip show`
/ AMI `GetConfig`, telephony AMI stream, deploy logs) **localized** the fault to
**outbound WebRTC SDP offer/answer negotiation** (client creates the offer → Asterisk
rejects with **488 / "Incompatible SDP"** before any channel/dialplan/trunk).

### Proven healthy (so NOT the cause)

Registration/WSS `:8089`, SIP auth, outbound route + VoIP.ms trunk, dialplan/trunk path
(hard-phone outbound `T2_105` → PSTN connected), PBX WebRTC endpoint media config
(`T25_101_1` == known-good `T30_102_1`), and **inbound** WebRTC (Asterisk offers). Failed
WebRTC outbound INVITEs create **no Asterisk channel** — rejection is pre-dialplan.

### Stop-the-line

**No deploy, no APK, no PBX media change** until a client SDP offer from a failed outbound
call (portal `chrome://webrtc-internals`, or mobile `adb logcat`) proves the exact
rejected attribute/codec. Note: the prior 2026-06-03 "relaxed audio constraints" fix
(`5a63561b`) is **undeployed** and the failure **still reproduces** (incl. portal) — its
root cause is **unverified**.

### Docs

- **`WEBRTC_DIAGNOSTICS.md`:** new section *"Incident: WebRTC OUTBOUND fails — 488 /
  Incompatible SDP (2026-06-03/04)"* — incident summary, proven-healthy table, missing
  decisive artifact, portal + mobile SDP capture steps, what-to-look-for, stop-the-line
  rule, next-action ladder, entity/access reference.

---

## 2026-06-03 — Mobile SIP call reliability (SDP rejection + answer pipeline)

**Task:** mobile / telephony / SIP call reliability  
**Risk:** extreme

### Root cause (production APK telemetry)

**Outbound:** Registration and `OUTBOUND_INVITE_SENT` succeeded; ~473ms later JsSIP failed with **`Incompatible SDP`** — Asterisk rejected the WebRTC offer (strict `channelCount` / `sampleRate` constraints), not stale registration or dial normalization.

**Inbound:** Wake/requeue worked and PBX created mobile PJSIP legs, but healthy PSTN wake still **`forceRestart`**'d the UA (tearing down during INVITE delivery). UI showed **CONNECTED** from `answerHandoffInviteIdRef` before JsSIP confirmed; backend **ACCEPT** / **INVITE_CLAIMED** ran before a real incoming session was found — no **`SIP_ANSWER_SENT`** / **`SIP_CONNECTED`**.

### Changes

- **`mobileWakeRegistration.ts`:** `shouldForceRestartOnWake()` — skip restart when connected + registered.
- **`SipContext` wake:** uses healthy-stack guard; records **`SIP_INVITE_RECEIVED`** on `newRTCSession`.
- **`NotificationsContext` answer pipeline:** register → wait for JsSIP session → backend ACCEPT → `answerIncomingInvite`; requeue path ACCEPT only after initial invite-wait expires; **`ANSWER_HANDOFF_STARTED`** / **`SIP_INVITE_WAIT_TIMEOUT`** flight events.
- **`ActiveCallScreen`:** **`ANSWERING…`** during handoff; **CONNECTED** only on real SIP `connected` state (`activeCallStatusLabel.ts`).
- **`voiceAudioConstraints.ts`:** relaxed Asterisk-compatible audio (AEC/NS/AGC only; no strict channelCount/sampleRate).
- **`mobileOutboundDial.ts`:** **`OUTBOUND_MEDIA_SDP_REJECTED`** for 488 / Incompatible SDP; flight payload includes `sipCode`, `sipCause`, `sipReason`, `diagnosisCategory`.
- **Tests:** wake restart guard, UI status label, audio constraints, outbound SDP classification, answer timing (unchanged).

### Manual QA

See `MOBILE_CALL_TIMELINE.md` § Mobile SIP reliability (2026-06-03, post-APK telemetry).

---

## 2026-06-03 — Mobile outbound call reliability (stale SIP reg + flight recorder)

**Task:** mobile / telephony / outbound call reliability  
**Risk:** extreme

### Root cause

Outbound mobile dials checked React **`registrationState === "registered"`** (UI tabs) or only **`this.ua` existence** (`JsSipClient.dial`) — not **`isConnected() && isRegistered()`**. After cold start / background, the UI could show registered while the WebSocket was stale; **`ua.call()`** then failed immediately (403/408/local error). **`hasActiveSession()`** counted **terminated** zombie sessions, blocking keep-alive reconnect. Outbound calls had **no Call Flight Recorder timeline** (`flightRecord` no-ops without `flightBeginCall`).

### Changes

- **`mobileOutboundDial.ts`:** normalize dial target; **`ensureOutboundSipRegistration`** (15s wait, force refresh); SIP failure → diagnosis category.
- **`jssip.ts`:** live-session **`hasActiveSession`** / register guard; **`dial()`** awaits healthy registration; **`OUTBOUND_*` trace** events with SIP code/reason.
- **`SipContext.dial`:** centralized mic preflight, flight session, registration-age logging (all dial entry points).
- **Call Flight Recorder + API explain:** `OUTBOUND_*` stages, warning flags, AI diagnosis categories.
- **Inbound answer reliability (same day)** unchanged — separate commit `0f86e753`.

### Manual QA

See `MOBILE_CALL_TIMELINE.md` § Mobile outbound reliability (2026-06-03).

---

## 2026-06-03 — Mobile answer reliability (late SIP INVITE / ring-group requeue)

**Task:** telephony / mobile / call-answer reliability  
**Risk:** extreme

### Root cause

Ring-group inbound calls used `/internal/mobile-ring-notify`, which sent **`INCOMING_CALL` only** (UI push) — not **`INCOMING_CALL_WAKE`** (SIP pre-register). The PBX dialed hard phone + mobile PJSIP via the ring group; mobile was often **not registered** when the leg started. On Answer, mobile cold-registered, backend **ACCEPT** triggered AMI requeue, but **`PJSIP/T*_ext_1` arrived ~10–17s** after call start — after JsSIP’s **8s** `session_not_found_timeout`.

### Changes

- **API `mobile-ring-notify`:** also sends **`INCOMING_CALL_WAKE`** before `INCOMING_CALL`; records `WAKE_PUSH_QUEUED`.
- **API `/mobile/wake/event`:** on **`DEVICE_REGISTER_COMPLETE`**, idempotently requeues pending invite via telephony (`device_register_complete` trigger).
- **API accept path:** requeue uses shared idempotent guard (`mobileInviteRequeue.ts`, max 4 attempts / 120s).
- **Mobile answer pipeline:** centralized timing (`mobileAnswerTiming.ts`); **extends** SIP INVITE poll **+16s after backend ACCEPT** (hard cap 30s); rejects stale sessions on failure; epoch guard against double-answer.
- **SipContext wake:** flight-recorder events for wake register stages.
- **Flight recorder upload:** resolves `inviteId` / `pbxCallId` from **`session.meta.*`**; warning flags for `SIP_INVITE_TIMEOUT`, `SIP_REGISTER_FAILED`, etc.; differentiated AI diagnosis categories in `/admin/call-flight/.../explain` + portal UI.

### Manual QA

See `MOBILE_CALL_TIMELINE.md` § Mobile answer reliability (2026-06-03).

---

## 2026-06-02 — VoIP.ms `sms_toolong` fix (160-char API limit + auto-split)

**Task:** telephony / API / SMS — VoIP.ms rejects short-looking messages with `sms_toolong`  
**Risk:** medium

### Root cause

VoIP.ms REST **`sendSMS` accepts max 160 characters per API call** and does **not** auto-concatenate longer SMS ([VoIP.ms wiki](https://wiki.voip.ms/article/SMS-MMS)). The prior Connect fix validated against **1600 chars / 10 logical segments**, so messages between 161–1600 chars (or ≤160 **visible** chars with **>160 GSM septets** from `{}[]|€` symbols) were queued and sent as **one** API payload. VoIP.ms returned generic `sms_toolong`. Connect Chat does **not** append STOP/campaign footers — campaign `normalizeSmsWithStop` is a separate path. Smart apostrophes/Unicode could also diverge from what users counted in the textbox.

### Changes

- **`@connect/shared/smsText`:** VoIP.ms limit **`VOIPMS_SENDSMS_MAX_CHARS=160`**; smart-punct → GSM normalization; payload char/byte/septet analysis; `splitVoipMsSendSmsParts`; precise `formatVoipMsSmsTooLongMessage` / `formatVoipMsProviderRejection`.
- **`VoipMsSmsProvider`:** preflight single-part validation; structured `voipms_sms_send_payload` log (counts only); map `sms_toolong` to detailed error with encoding + bytes.
- **Worker:** all Connect Chat SMS sends auto-split into ≤160-char / ≤160-septet parts (`voipms_sms_part_send` logs per part).
- **Portal counter:** shows chars, UTF-8 bytes, encoding, VoIP.ms part count.
- **Tests:** 13 cases including 95 pipes (140 visible), smart apostrophes, hidden chars, 159/160/161 chars, no STOP append.

### Manual QA

- Send 120 plain ASCII chars — 1 VoIP.ms SMS, delivers.
- Send 161 chars — delivers as 2 SMS; counter shows `2 VoIP.ms SMS`.
- Send 95 `|` symbols — delivers as 2 SMS (160+30 septets); no `sms_toolong`.
- Paste iOS smart apostrophes — normalizes to GSM; single SMS under 160.
- Worker logs show `voipms_sms_send_payload` / `voipms_sms_part_send` with char + byte counts.

### Rollback

Revert shared + integrations + worker changes; redeploy `api`, `worker`, `portal`.

---

## 2026-06-02 — Connect SMS encoding-aware length validation

**Task:** telephony / UI / API — SMS compose validation for Connect Chat + CRM  
**Risk:** medium

### Root cause

Connect SMS composers (Chat + CRM contact panel) used raw JavaScript `String.length` or no counter at all. That diverges from carrier SMS units: GSM-7 septets (160 single / 153 multi-segment, extended chars = 2 septets) vs UCS-2 (70 / 67 per segment when emojis, smart quotes, or other non-GSM characters appear). Invisible paste characters (zero-width spaces, BOM) could also inflate counts. The Connect Chat send path had **no backend pre-send validation** — messages queued and failed asynchronously with opaque VoIP.ms errors instead of clear `SMS_TOO_LONG` responses.

### Changes

- **`@connect/shared/smsText`:** normalize invisible characters safely, analyze GSM vs Unicode encoding, segment counts, VoIP.ms max (1600 chars / 10 segments), and `validateOutboundSmsText`.
- **API:** `sendConnectChatSmsMessage` validates text-only outbound SMS before queueing; returns `400 SMS_TOO_LONG` or `SMS_EMPTY` with explicit counts/limits.
- **Worker:** MMS→SMS link fallback splitting uses encoding-aware multipart helper (replaces naive 150-char slices).
- **Portal:** live counter under Chat SMS composer and CRM `ContactSmsPanel`; send disabled only when over VoIP.ms limits; chat send toast surfaces API validation message.
- **Tests:** eight unit tests in `packages/shared/src/smsText.test.ts`.

### Manual QA

- Send GSM text under 160 chars from `/chat` and CRM contact SMS — succeeds, counter shows `N/160`.
- Send exactly 160 GSM chars — succeeds.
- Paste text with zero-width characters — counter strips invisibles; short message still sends.
- Add emoji — counter switches to Unicode (`70/segment` hint); message under limit still sends.
- Exceed 1600 chars — send blocked in UI; API returns `SMS_TOO_LONG` with counts.

### Rollback

Revert shared + api + worker + portal changes; deploy `api`, `worker`, and `portal`.

---

## 2026-06-01 — CRM edit/delete: all CRM users, Delete labels (fix)

**Task:** Correct edit/delete rollout — reps could not edit; UI showed Archive instead of Delete  
**Risk:** high

### Root cause

Edit/Delete menus were gated on `can_manage_crm` (managers only). Campaign detail had no **Edit campaign** toolbar button (`onEditCampaign` unused). Funder list delete modal referenced removed `archiveTarget` state. Funder detail used undefined `canManageCrm`, hiding delete for everyone.

### Changes

- **API:** campaign/contact/funder PATCH and DELETE use `requireCrmAccess` plus existing scope checks (not `requireCrmManager`).
- **Portal:** **Delete** labels everywhere; Edit/Delete for users with `can_view_crm_campaigns` / `funders` / `contacts`; campaign detail **Edit campaign** button; funder delete modal wired to `deleteTarget`; list **Edit** opens detail with `?edit=1`.
- **Docs:** `CRM.md` edit/delete section updated.

### Manual QA

- Agent with campaign assignment: Edit + Delete on assigned campaign; 403 on unassigned.
- Agent: Edit + Delete contact in scope; funder edit/delete on `/crm/funders`.
- Funder list Delete confirm works (no runtime error).

### Rollback

Revert API + portal + docs; deploy `api` and `portal`.

---

## 2026-06-01 — CRM edit/archive actions (campaigns, funders, contacts)

**Task:** CRM / campaigns / funders / leads / edit-delete actions  
**Risk:** high

### Root cause

Soft-archive APIs already existed for campaigns (`status: ARCHIVED`), funders (`active` + `archivedAt`), and contacts (`active` + `archivedAt`), but list rows lacked consistent Edit/Archive menus, several surfaces used `window.confirm` without toasts, funder save called `POST` instead of `PATCH`, contact `PATCH` omitted `assertCrmContactAllowed`, and archive routes required platform JWT admin instead of CRM Manager.

### Changes

- **Portal:** shared `CrmRowActionMenu` + `CrmConfirmModal`; list/detail actions on `/crm/campaigns`, `/crm/funders`, `/crm/contacts`; campaign `EditCampaignModal`; archive confirmations label **Archive** (not hard delete).
- **API:** contact `PATCH` enforces `assertCrmContactAllowed`; contact/funder archive+restore use `requireCrmManager`; campaign `DELETE` idempotently sets `ARCHIVED` with tenant check.
- **Tests:** `apps/api/src/crm/crmRecordEditDelete.test.ts` guards route permissions and soft-archive behavior.

### Manual QA

- Manager edits/archives a campaign, funder, and contact from list + detail; archived rows disappear from default lists.
- Agent edits in-scope contact; cannot archive; out-of-scope edit/archive blocked by API.
- Active campaign archive shows warning copy; members/timeline/imports remain queryable on archived detail.

### Rollback

Revert API + portal + docs together; deploy `api` and `portal`. No migration.

---

## 2026-06-01 — CRM workspace template send via tenant sender

**Task:** CRM / email / workspace templates / tenant sender  
**Risk:** high

### Root cause

CRM email already had TENANT-scoped Google sender connections, but normal send resolution preferred a caller's USER sender before the tenant sender. The contact workspace Email tab also hid templates behind a compose drawer, lacked CC-self, and did not record enough send metadata for template/sender audit.

### Changes

- **Tenant-first sending:** implicit CRM sends now resolve explicit `connectionId` first, then tenant default TENANT sender, lone TENANT sender, caller USER sender, then no sender.
- **Workspace templates:** the contact workspace Email tab now shows saved templates directly, supports search, preview, small subject/body edits, template attachments, and one-at-a-time sends.
- **CC myself:** workspace sends can CC the logged-in user's email only; missing/invalid user email is rejected safely.
- **Permissions:** tenant Google sender management is limited to platform admins or CRM ADMIN users. CRM Agents/Managers can send with the tenant sender but cannot manage connection settings.
- **Reply tracking:** no fake reply-tracking address was added. Contact replies to the tenant sender remain tracked by the existing Gmail thread sync when reply tracking is enabled; agent self-CC is for visibility, and personal inbox replies are only tracked if the tenant sender remains in the Gmail thread/recipient chain.
- **Timeline:** sent email timeline metadata now includes template, sender connection, sender account, and CC-self details.

### Manual QA

- Admin connects the tenant Google sender with reply tracking.
- Agent without personal Google opens a contact workspace Email tab, selects a template, confirms merge fields, checks CC myself, and sends.
- Confirm the email sends from the tenant Gmail account, the agent receives the CC, and contact replies sync back after Gmail reply sync.
- Confirm an out-of-scope Agent is blocked, Agents cannot open/manage email settings, and CRM Admin can still manage the tenant sender.

### Rollback

Revert the API, worker, portal, test, and docs changes together, then deploy `api`, `worker`, and `portal`. No Prisma rollback is required.

---

## 2026-06-01 — CRM Email layout polish

**Task:** CRM / email page / layout polish  
**Risk:** medium

### Root cause

The CRM Email landing page rendered the large sender/connect card before the KPI strip and activity panels, so the Sent, Delivered, Replies, and Reply Rate cards were pushed below the most prominent card. Recent Replies and Recent Sent also lived in normal content flow instead of bounded panel scroll regions, and the no-data states used dashed bordered containers that added visual clutter.

### Changes

- **KPI placement:** Sent, Delivered, Replies, and Reply Rate now render directly below the CRM Email header and reply-tracking health banner.
- **Sender card:** the Google sender/connect card moved lower on the page and can be hidden per tenant/user in local storage; a compact sender status row remains with Connect Google/Manage and Show details actions.
- **Activity panels:** Recent Replies and Recent Sent use bounded independent scroll areas with their headers fixed inside each card.
- **Empty states:** removed dashed/bordered empty-state containers while preserving the No replies synced and No outbound sends messages.
- **Scope:** portal CRM Email UI/docs only; no API, database, permission, OAuth, send, or reply-tracking logic changes.

### Manual QA

- Open `/crm/email` and confirm Sent, Delivered, Replies, and Reply Rate are directly under the header.
- Confirm the Connect Google / sender card is lower on the page and no longer dominates the top.
- Hide the sender card, refresh, and confirm the hidden state persists while compact Connect Google/Manage access remains.
- Confirm Recent Replies and Recent Sent scroll independently with headers visible.
- Confirm No outbound sends and No replies synced show as simple text states without bordered outlines.
- Confirm Sync now, Templates, Connect Google/Manage, reply tracking, recent replies, recent sent, and existing permission behavior still work.

### Rollback

Revert the CRM Email page/CSS changes and this docs entry. No backend, schema, permission, OAuth, or email sending rollback is required.

---

## 2026-06-01 — CRM Funders workspace layout polish

**Task:** CRM / funders page / layout polish  
**Risk:** medium

### Root cause

The Funders page kept an always-rendered bulk toolbar in the fixed CRM chrome, so the zero-selection state reserved a full toolbar row and pushed the search filters, main list, and right rail lower than needed.

### Changes

- **Bulk actions:** the Funders bulk bar now renders only when at least one row is selected, and selected actions stay in a compact one-line toolbar.
- **Workspace layout:** Funders-scoped styles tighten chrome spacing, keep the filter row sticky/visible, and preserve independent desktop scroll regions for the funder list and right rail.
- **Right rail:** removed the duplicate Quick Actions card; header actions remain the source for Add Funder, Import CSV, and Export CSV.
- **Scope:** portal Funders UI/docs only; no API, database, permissions, or business logic changes.

### Manual QA

- Open `/crm/funders` with no selected rows and confirm no `0 selected` bulk block appears.
- Select and deselect a funder; confirm the compact bulk bar appears only while selected.
- Confirm the search/filter row is higher, remains visible, and the list and right rail scroll independently on desktop.
- Confirm Add Funder, Import CSV, and Export CSV still exist in the page header.

### Rollback

Revert the Funders page markup/CSS changes and this docs entry. No backend or schema rollback is required.

---

## 2026-06-01 — CRM contacts filters and import-to-queue assignment

**Task:** CRM / contacts page / filters / queue assignment
**Risk:** high

### Root cause

The contacts filter row rendered six controls into a five-column grid and used native selects, so the Filters button wrapped and dropdowns looked browser-default. Imported contacts also did not reliably appear in My Queue because My Queue reads `CrmCampaignMember.assignedToUserId`, while standalone import created contacts only and contacts assignment wrote `CrmContactMeta.assignedToUserId`.

### Changes

- **Contacts filters:** search is shorter; campaign/tag/timezone/stage filters use `ConnectSelect`; quick status filters and Assigned to me moved into a compact Filters panel.
- **Contacts shell:** desktop contacts list and right rail use bounded scroll regions under sticky filter chrome; tablet/mobile keep normal page flow.
- **Queue assignment:** selected contacts can be assigned to self into a chosen active campaign without granting global assignment powers.
- **Standalone import:** import now requires a destination active campaign and enrolls imported leads as campaign members assigned to the importer so they appear in My Queue.
- **Scope:** all assignment paths remain CRM-enabled, tenant-scoped, campaign-scoped, and self-only for regular CRM users.

### Manual QA

- Open `/crm/contacts`; confirm filters fit on one row, Filters opens the compact panel, and list/right rail scroll independently on desktop.
- Import a CSV from `/crm/import`, choose an active destination campaign, and confirm imported leads appear in `/crm/queue`.
- Select contacts on `/crm/contacts`, choose a queue campaign, click Assign to me, and confirm My Queue updates.
- Confirm a regular CRM user cannot assign selected/imported leads to another user or across an unassigned tenant/campaign.

### Rollback

Revert the contacts/import portal changes, the CRM import/contact route additions, and this docs entry. No schema rollback is required.

---

## 2026-05-31 — CRM My Queue workbench simplification

**Task:** CRM / My Queue / UI workbench redesign  
**Risk:** medium

### Root cause

My Queue had the right fixed-scroll shell, but the center work area still carried dashboard-style sections after the assigned list while the right rail repeated snapshot, session, queue health, and campaign context. That made the page answer "how is everything doing?" instead of "what assigned lead/task should I work next?"

### Changes

- **Workbench focus:** removed My Queue's Power Session, Today's Snapshot, Session, Queue Health, and Active Campaign summary widgets.
- **Right rail:** moved Priority Focus into the right rail as compact Due Today, Overdue, Follow Ups, and High Priority cards.
- **Center workspace:** left assigned queue rows and the caught-up empty state as the only center workspace content, inside the existing independent scroll region.
- **Scope:** portal UI/docs only; no API, database, permissions, routing, or backend behavior changes.

### Manual QA

- Open `/crm/queue` with assigned queue items and confirm the rows render in the center while the header, filters, and KPI row stay visible.
- Open `/crm/queue` with an empty queue and confirm the caught-up state renders without retired widgets.
- Confirm the center list scrolls independently on desktop and the compact Priority Focus right rail remains visible.
- Confirm mobile/tablet stacks remain usable with no horizontal overflow.

### Rollback

Revert the My Queue portal component/CSS deletions and this docs entry. No backend or schema rollback is required.

---

## 2026-05-31 — Connect Chat SMS reliability polish

**Task:** chat / SMS / UI reliability / performance  
**Risk:** high

### Root cause

The `/chat` page used a flexible two-column layout without a bounded height or inner scroll regions, so the full page became the scroll container and the conversation header/composer scrolled away. Background polling also replaced the whole message array and unconditionally scrolled to the bottom on message-count changes, causing visible refresh churn and yanking users while reading older SMS history.

### Changes

- **Shell:** `/chat` now uses a bounded split-pane shell: thread list scrolls independently, message list scrolls independently, and the header/composer stay pinned inside the conversation panel.
- **Refresh stability:** message loads merge by ID and preserve existing rows where content is unchanged; active thread selection is preserved across thread refreshes.
- **Scroll behavior:** auto-scroll only happens on initial open, user send/manual refresh, or new messages when the user is already near the bottom. Reading position is preserved during background updates.
- **Presentation:** bubbles are more compact, outgoing messages use a branded blue treatment, URLs wrap as compact links, media thumbnails are capped, and voice notes blend into the bubble instead of rendering as neutral white boxes.
- **Tests:** focused helper tests cover merge de-duplication, selected thread preservation, scroll decisions, bubble class selection, CRM/shared SMS badge helpers, and media/audio presentation classes.

### Manual QA

- Open `/chat`, select a long SMS conversation, and confirm the sidebar, header, message list, and composer behave as separate panes on desktop.
- Scroll up, wait for background refresh, and confirm there is no blanking or forced jump to bottom.
- Send a message and confirm it appears without a full visual reload.
- Confirm links, photos/MMS, and voice notes remain compact and readable in both incoming and outgoing bubbles.
- Confirm mobile still allows returning to the thread list and keeps the composer reachable.

### Rollback

Revert the `/chat` portal component/helper/CSS changes plus this docs entry. No backend routing, provider behavior, permissions, or database schema changed.

---

## 2026-05-31 — CRM SMS unified with Connect Chat

**Task:** CRM / SMS / Connect Chat integration
**Risk:** high

### Root cause

CRM contact SMS used a CRM-specific provider-send route that called SMS providers directly, then mirrored a timeline event. That bypassed the regular `ConnectChatThread` / `ConnectChatMessage` SMS source of truth, so CRM and main Chat could diverge.

### Changes

- **Outbound CRM SMS:** `/crm/contacts/:id/sms` now requires CRM access, contact scope, and `can_send_sms`, then creates/reuses the regular Connect Chat SMS thread and queues the normal Connect Chat SMS message.
- **CRM SMS panel:** contact workspace SMS reads from the matching Connect Chat SMS thread/messages instead of timeline-only SMS events.
- **Main Chat:** the same thread/message appears in `/chat`; CRM SMS labels/contact titles are returned only when the viewer has CRM/contact access. Ambiguous phone matches are marked safely without choosing a random contact name.
- **Timeline mirroring:** CRM timeline `SMS_SENT` / inbound hook mirroring remains supplemental, not the SMS source of truth.

### Verify

- Send one SMS from a CRM contact workspace; confirm the same message appears in `/chat`.
- Simulate/receive an inbound reply; confirm it appears in the same Chat thread and the CRM SMS panel after refresh.
- Check a non-CRM chat viewer sees phone-based SMS title only, without CRM contact name or CRM badge.

---

## 2026-05-31 — CRM workspace shell (fixed chrome + scroll regions)

**Task:** CRM / UI shell / scrolling architecture  
**Risk:** high

### Root cause

Major CRM list pages used flat vertical stacks inside `.console-content`, which scrolls the entire page. There was no shared height chain or independent scroll regions (unlike Call History `ch-shell` and contact detail workspace). Headers, filters, and right rails scrolled away on long lists.

### Changes

- **Shared shell:** `CRMWorkspaceShell` compound components + `.crm-workspace-*` CSS utilities in `globals.css`. When present, `.console-content` stops page-level scroll (`overflow: hidden`) and the shell fills viewport height below the topbar.
- **Pages updated:** Queue, Funders, Tasks, Scripts, Checklists, Voicemail Drops.
- **Pattern:** fixed chrome (header, KPIs, filters, controls) + scrollable main list/library + optional right rail with its own scroll.
- **Responsive:** below 1280px, split layouts degrade to stacked flow with normal page scroll.

### Manual QA

- Desktop: open each page with a long list; confirm header/filters stay visible while only the list region scrolls.
- Funders / Queue / Tasks / Scripts / Checklists: confirm right rail stays on screen (desktop) and scrolls independently when tall.
- Mobile/tablet: confirm pages remain usable (stacked layout, no broken controls).

---

## 2026-05-31 — CRM contact workspace right-rail section reorder

**Task:** CRM / contact workspace / right rail ordering  
**Risk:** medium

### Root cause

Right-rail collapsible section order was hardcoded in the contact workspace page with no per-user persistence, so agents could not personalize panel priority.

### Changes

- **Portal:** `ContactRightRailSectionList` wraps the seven reorderable right-rail sections (Relationship Health through Contact Info). Drag starts from the existing section header after an 8px pointer threshold — no drag handle, icon, or “drag” copy.
- **Persistence:** order saved to `localStorage` per signed-in user (`crm-contact-workspace-right-rail-order[:userId]`). Default order unchanged for users without a saved layout.
- **Responsive:** drag disabled on coarse pointer and viewports ≤1279px to avoid accidental drags while scrolling on touch devices.
- **Pinned sections:** Quick Disposition (top) and Possible duplicates (bottom, when present) remain outside the reorder list.
- **Visual feedback:** subtle lift/shadow while dragging and inset line for drop position only during drag.
- **Tests:** `contactRightRailOrder.test.ts` covers default order, normalization, move helper, load/save round-trip, and reset helper.

### Manual QA

- Drag Relationship Health below Activity Summary on desktop, refresh, confirm order persists.
- Expand/collapse each section after reorder.
- Confirm no visible drag handle or permanent markings.
- On tablet/mobile, confirm scrolling works without accidental section drags.

---

## 2026-05-31 — CRM Quick Disposition card utility polish

**Task:** CRM / contact workspace / UI polish  
**Risk:** low

### Root cause

After the compact card redesign, **More** and **Manage** still used pill/hover button styling that matched disposition pills, and the multi-phone selector retained input chrome that made read-only phone context look editable.

### What changed

- **Utility actions:** `More` and `Manage` are now lightweight text links with optional icons and blue hover — no pill border or background.
- **Phone display:** single and multi-phone rows render as plain text (borderless select for multi-phone switching).
- **Spacing:** tightened vertical gaps inside the Quick Disposition card by ~4px.

### Deliberately unchanged

Disposition pill buttons, save behavior, manage panel functionality, card position, right rail layout, APIs, database, and permissions.

### Verify

Open a campaign contact workspace and confirm More/Manage look secondary, phone reads as display text, disposition pills unchanged, and all actions still work.

---

## 2026-05-31 — CRM contact workspace visual polish

**Task:** CRM / contact workspace / visual polish  
**Risk:** medium

### Root cause

The compact workspace structure was correct, but remaining presentation details still felt uneven: the Quick Disposition card used older borders/button styling, collapsed right-rail sections displayed noisy summary text, card wrappers varied between sections, and empty states often rendered inside dashed/bordered containers.

### What changed

- **Quick Disposition:** kept the compact footprint and workflow, but updated typography, pill buttons, white card surface, hover states, and softer shadow treatment.
- **Right rail sections:** collapsed state now shows only the section title. Section wrappers use a consistent white card surface, radius, border, and soft shadow.
- **Empty states:** replaced bordered empty containers in contact workspace panels with simple text states.
- **Header actions:** kept the same actions and functionality while ensuring Call remains the primary far-right action next to VM Drop, Edit, and Archive.

### Deliberately unchanged

- Three-column layout, workspace order, quick disposition save behavior, APIs, database schema, and permissions.

### Verify

- Open a campaign contact workspace and confirm the Quick Disposition card remains compact, collapsed sections show title-only rows, empty states are plain text, and header actions remain Call / VM Drop / Edit / Archive from the right-side action cluster.

---

## 2026-05-31 — CRM campaign workspace UI polish

**Task:** CRM / campaign workspace / UI polish  
**Risk:** medium

### Root cause

After the quick disposition rollout, the sticky header duplicated communication actions already available in the left workspace nav, secondary contact actions sat below the KPI strip, the Quick Disposition card consumed too much right-rail height, and timeline rows used bordered edit/delete controls with generous vertical spacing — pushing Relationship Health and other right-rail cards below the fold.

### What changed

- **Header:** removed SMS, Email, and Note from `ContactCampaignStickyHeader`; Call stays top-right. Voicemail Drop, Edit, and Archive moved to the header action cluster on the right.
- **Quick Disposition card:** compact layout — active phone, last disposition, four primary one-click buttons, expandable **More…** for remaining labels, and **Manage** for custom dispositions. Removed title, subtitle, channel selector row, and note field from the card (channel still follows Call/SMS/Email/VM outreach context).
- **Timeline:** icon-only note edit/delete (✏️ / 🗑️, no button borders); reduced event padding and inter-event gap for higher density.
- **Right rail:** tighter spacing below the disposition slot so Relationship Health, Activity Summary, and downstream cards appear sooner.

### Deliberately unchanged

- Workspace three-column layout, left sidebar navigation, disposition API, permissions, and all workspace tabs (Email, SMS, Notes, etc.).

### Verify

- Call button remains in header; SMS/Email/Note reachable via left nav only.
- Quick Disposition card is ~70% shorter; right-rail summary cards visible with less scroll.
- One-click dispositions still save; timeline updates with phone/channel metadata.

---

## 2026-05-31 — CRM campaign workspace disposition redesign

**Task:** CRM / campaign workspace / disposition redesign  
**Risk:** high

### Root cause

Disposition controls lived inside the scrolling center workspace card, so agents lost quick access while reading timeline/script content. Panel scroll only activated at very wide breakpoints and the right rail had no pinned action area. Quick disposition labels were hardcoded and not tenant-configurable, and per-phone/channel dispositions needed a dedicated sticky workflow surface.

### What changed

- **Scroll shell:** left, center, and right panels now use dedicated inner scroll regions (`crm-contact-left-scroll`, `crm-contact-center-scroll`, `crm-contact-right-rail-scroll`) with sticky header + pinned quick disposition slot.
- **Navigation cleanup:** removed duplicate center mini-tabs; left sidebar remains sole workspace navigation; removed Next Step card.
- **Quick Disposition card:** sticky right-rail card (`ContactQuickDispositionCard`) with channel + phone target, one-click disposition buttons, optional note save, and manager custom label management.
- **Quick disposition API:** `GET/PUT /crm/quick-dispositions` with tenant defaults + custom JSON on `CrmTenantSettings.quickDispositions`.
- **Per-phone/channel dispositions:** reuses `CrmContactPhoneDisposition` + extended `POST /crm/contacts/:id/disposition`.
- **Tests:** quick disposition merge/permissions, workspace scroll class helpers, phone disposition helpers.

### Verify

- Desktop: each column scrolls independently; Quick Disposition stays visible in right rail while scrolling center content.
- One-click disposition saves immediately with phone + channel context.
- Manager can add/reorder custom quick dispositions.

---

## 2026-05-31 — CRM campaign workspace disposition UX

**Task:** CRM / campaign workspace / disposition UX  
**Risk:** medium

### Root cause

The campaign contact workspace duplicated navigation (left sidebar + center mini-tab row), buried disposition controls in the left rail, and stored dispositions only at contact level (`CrmContactMeta.lastDisposition`) with no phone/channel metadata. The redundant right-rail “Next step” card duplicated guidance already available via tasks, notes, and timeline.

### What changed

- **Portal:** removed center `ContactWorkspaceTabBar` mini-tabs and the right-rail Next Step card; left sidebar remains the sole workspace navigation.
- **Portal:** added `ContactWorkspaceDispositionBar` in the center workspace header — channel selector (Call/SMS/Email/VM Drop), active phone target, quick disposition buttons, note, and save.
- Call/SMS picker and single-phone flows now set the active disposition phone + channel before outreach.
- Per-phone disposition labels appear in contact info, SMS select, and Call/SMS picker.
- **API + schema:** new `CrmContactPhoneDisposition` model and migration; `POST /crm/contacts/:id/disposition` accepts optional `phoneId` + `channel`, writes phone-level history, enriches timeline metadata (phone label/number/channel), and returns latest disposition on each phone via `GET /crm/contacts/:id`.
- Contact-level `lastDisposition` behavior preserved for backward compatibility.
- **Tests:** `contactPhoneDisposition.test.ts`, expanded `contactWorkspaceHelpers.test.ts`.

### Deliberately unchanged

- Notes, timeline, scripts, checklist, email, SMS, tasks, and intelligence tabs remain in the left sidebar.
- CRM permission model unchanged (`requireCrmAccess` + `assertCrmContactAllowed` on disposition).

### Verify

- Multi-phone contact: Call → pick Mobile → save “No answer” → Mobile shows disposition; SMS → pick Office → save “Interested” → both numbers retain separate latest dispositions.
- Timeline entries include phone type, number, channel, and disposition.
- Center mini-tabs and Next Step card are gone; sidebar navigation still switches workspace panels.

---

## 2026-05-31 — CRM campaign active workspace UX polish

**Task:** CRM / campaign workspace / UX polish  
**Risk:** medium

### Root cause

The first workspace redesign still trapped wheel scroll inside desktop panels (`overscroll-behavior: contain`), only partially applied collapsible summaries, and left call/SMS actions tied to the primary phone even when contacts had multiple numbers. The existing CRM phone record already exposes a per-phone `type`, but the UI did not consistently display or use it.

### What changed

- **Portal only:** removed scroll trapping from campaign contact workspace panels.
- Right-rail informational panels now use collapsed-by-default summaries.
- Sticky contact header gets subtle CRM accent/gradient treatment while staying compact.
- Campaign Prev/Next lead navigation is now a smaller segmented floating pill.
- Call/SMS actions open a phone picker for multi-phone contacts; single-phone contacts execute immediately.
- Phone `type` labels are shown in the header, contact info, SMS panel, and Call/SMS picker. Existing add-phone flow now offers Mobile, Office, Direct, Main, Billing, Home, Cell, Work, Other.
- **Tests:** expanded `contactWorkspaceHelpers.test.ts` for phone label formatting and single vs multi-phone picker behavior.

### Deliberately unchanged

- No backend/API/schema changes. Existing API supports add/delete phones, but no phone update route exists for editing saved phone types.
- CRM permissions, telephony routing, SMS send route, and campaign APIs unchanged.

### Verify

- Desktop scroll continues naturally when a workspace panel reaches top/bottom.
- Right rail starts compact and expands on section header click.
- Multi-phone contacts show picker for Call and SMS; selected number is used.
- Single-phone contacts call/open SMS immediately.

---

## 2026-05-31 — CRM campaign active workspace UX redesign

**Task:** CRM / campaign workspace / UX redesign  
**Risk:** high

### Root cause

The campaign contact workspace (`/crm/contacts/[id]?campaignId=&memberId=`) used a single page scroll surface, a tall header that scrolled away, and a horizontally scrolling tab strip. **Start outreach** called `scrollToNoteComposer()` while the user was on the Timeline tab, but the note composer only mounted on the Notes tab — `noteComposerRef` was null, so the click appeared to do nothing (silent failure).

### What changed

- **`apps/portal/app/(platform)/crm/contacts/[id]/page.tsx`:** sticky compact header, three-panel independent scroll layout (desktop), campaign prev/next navigation (+ ArrowLeft/ArrowRight), Start outreach switches to Notes with toast feedback, explicit Notes tab branch.
- **New components:** `ContactCampaignStickyHeader`, `ContactWorkspaceTabBar` (primary tabs + More menu), `ContactCampaignLeadNav`, `ContactCollapsibleSection`, `contactWorkspaceHelpers.ts`.
- **`ContactDocumentSummary`:** collapsible summary-first sections (verified CRM, extracted docs, phones).
- **`ContactTimeline`:** Start outreach loading state on button.
- **`globals.css`:** `.crm-contact-detail-workspace` scoped layout/toast styles.
- **Tests:** `contactWorkspaceHelpers.test.ts` (tab overflow, campaign nav, start-outreach validation).

### Deliberately unchanged

- CRM permissions, API routes, campaign roster page, queue page, live-call workspace, telephony.

### Verify

- Open workspace from `/crm/campaigns/[id]` member row → sticky header stays visible while scrolling panels.
- Desktop: left / center / right panels scroll independently; no full-page scroll.
- Mobile/tablet: stacked layout, no horizontal tab swipe; More menu reaches overflow tabs.
- Empty timeline → Start outreach → Notes tab + toast + focused composer.
- Campaign context → fixed Prev/Next (bottom-right) and keyboard arrows move through roster order.
- Document summary sections collapse/expand with summary lines visible when closed.

### Deploy

**Portal only.** No API/worker/DB changes.

---

## 2026-05-31 — Shared tenant SMS inbox consistency (VoIP.ms / Connect Chat)

**Task:** SMS / VoIP.ms / shared inbox consistency  
**Risk:** high

### Root cause

Inbound SMS to tenant-assigned numbers with no extension used permission-blind fan-out to **all** tenant users and consistent shared `inboxScope=""`, but **outbound-first** thread creation only added the creator as participant and used a flawed `inboxScope` heuristic. Send routes checked JWT roles via `canSendSmsRole` instead of portal `can_send_sms`. Users with `can_view_tenant_chats` could read shared threads but got **404** on reply because `POST /chat/threads/:id/messages` required a participant row.

### What changed

- **`packages/shared/src/smsInbox.ts`:** shared inbox scope, dedupe key, permission eligibility helpers (+ unit tests).
- **`apps/api/src/smsInboxParticipants.ts`**, **`apps/worker/src/smsInboxParticipants.ts`:** permission-based participant fan-out; batch role snapshot + custom roles.
- **`connectChatRoutes.ts`:** outbound-first shared inbox uses same fan-out as inbound; send permission union; shared-inbox reply auto-participant or `403 SMS_VIEW_ONLY`; thread list `smsInboxKind`.
- **`voipMsInboundSyncJob.ts`:** uses shared dedupe + participant module.
- **Portal:** VoIP.ms “shared tenant inbox” label; chat badges; composer hidden for view-only SMS.
- **Tests:** `smsSharedInbox.test.ts`, `smsInbox.test.ts`.

### Deploy

Requires **`api`**, **`worker`**, and **`portal`**. No Prisma migration.

### Verify

- Assign VoIP.ms DID to tenant with no extension → inbound and outbound-first threads show **Shared SMS** and same participants (users with SMS/chat permissions only).
- User with `can_view_tenant_chats` + `can_send_sms` can reply without 404.
- View-only user sees thread but composer hidden / `403 SMS_VIEW_ONLY` on send.
- Personal extension/user assignment unchanged.

---

## 2026-05-31 — CRM lead document summary on contact profile

**Task:** CRM / document import / lead profile summary
**Risk:** high

### Root cause

Google Drive import, OCR/text extraction, contact discovery, and AI intelligence already ran, but the lead profile had no structured “business profile” view. Required fields (EIN, revenue, industry, credit score, addresses, phones) were neither extracted into a summary schema nor rendered on the contact workspace — only a separate AI Intelligence tab showed generic entities.

### What changed

- **`documentProfileExtractor.ts`:** regex/heuristic extraction from document text (EIN, revenue, credit score, dates, labeled addresses). SSN extracted only in memory for masking — never persisted.
- **`leadDocumentSummaryService.ts`:** merges verified CRM contact fields, document extractions, and AI `documentProfile` (SSN stripped before DB persist). `GET /crm/contacts/:id/document-summary` with `assertCrmContactAllowed`.
- **`leadIntelligenceProvider.ts`:** extended AI schema with `documentProfile` business fields (no SSN in prompt/storage).
- **Portal:** `ContactDocumentSummary` card on contact profile — separate sections for verified CRM fields, document-extracted fields, and all phones.
- **Tests:** extractor, summary merge/masking, route contract (24 tests).
- **Docs:** CRM document summary fields + SSN policy in `CRM.md`.

### Deploy

Requires **`api`** and **`portal`**. No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/documentProfileExtractor.test.ts src/crm/leadDocumentSummaryService.test.ts src/crm/leadDocumentSummaryRoutes.test.ts
pnpm --dir apps/portal typecheck
```

Manual QA: import/scan Drive docs → open lead profile → Extracted Business Profile card shows fields; SSN masked; all phones listed; restricted Agent blocked out-of-scope.

---

## 2026-05-31 — CRM checklist create/save list refresh

**Task:** CRM / checklists / permissions / save flow
**Risk:** high

### Root cause

Checklist create/update API routes already used `requireCrmAccess` (Agent/Manager allowed, tenant-scoped). The portal create flow only silent-refetched the list and replaced state wholesale — unlike scripts, it did not merge the saved checklist into local state, so a stale or failed refetch left the library panel empty until a full browser refresh. Create also lacked the success toast shown on edit save.

### What changed

- **`crmSaveHelpers.ts`:** added `mergeChecklistSummaries` (mirrors script merge helper).
- **`checklists/page.tsx`:** optimistic merge after create/edit; silent refetch with `mergeLocal`; success toast on create; 403/save errors still via `formatCrmSaveError`.
- **Tests:** `checklistRoutes.test.ts` (API list/create contract, tenant scoping, Agent/Manager portal permissions); `crmSaveHelpers.test.ts` (merge helper).
- **Docs:** CRM checklist save-flow note in `CRM.md`.

### Deploy

Requires **`portal`** only (API unchanged). No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/checklistRoutes.test.ts src/crm/scriptChecklistAccess.test.ts
pnpm --dir apps/portal exec node --import tsx --test components/crm/crmSaveHelpers.test.ts
```

Manual QA: CRM Agent → create checklist → save → appears in library without refresh; repeat as Manager; confirm Admin still works; user without CRM access denied on page/API.

---

## 2026-05-31 — CRM contact list/search scope filter

**Task:** CRM / permissions / contact list scope fix
**Risk:** high

### Root cause

The prior CRM permission audit scoped detail and mutation routes via `assertCrmContactAllowed`, but `GET /crm/contacts`, stats, phone lookup, and duplicate suggestions still queried all tenant contacts — restricted Agents could see names and totals for out-of-scope leads.

### What changed

- **`crmContactAccess.ts`:** added `resolveCrmContactScopeContext`, `buildCrmContactListScopeWhere`, `buildCrmContactMetaListScopeWhere`, and `mergeAndWhereClauses` — same assigned-or-allowed-campaign rules as single-contact access.
- **`contactRoutes.ts`:** list, stats, lookup, and duplicate candidate queries now apply scope filters; lookup also post-filters with `userCanAccessCrmContact`.
- **Tests:** `crmContactListScope.test.ts` (pure helpers + route contract tests).
- **Docs:** CRM permission matrix updated for list/search/stats scope.

### Deploy

Requires **`api`** only. No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/crmContactListScope.test.ts src/crm/crmContactAccess.test.ts
```

Manual QA: restricted Agent — `/crm/contacts` and search show only assigned/in-campaign contacts; totals match visible rows; Manager sees full tenant list.

---

## 2026-05-31 — CRM Agent/Manager permission audit

**Task:** CRM / permissions / access audit (checklists, dispositions, email, templates, voicemail drops, scripts, live workspace)
**Risk:** high

### Root cause

Several CRM features were visible in the portal nav for Agent/Manager roles but API guards were inconsistent: voicemail drop upload/edit used platform-admin `requireCrmAdmin` instead of `requireCrmAccess`; contact-scoped actions (disposition, checklist respond, voicemail drop, notes, tasks, contact detail) did not call `assertCrmContactAllowed`; email template edit only honored platform JWT admin or creator, not CRM Manager; CRM Manager/Admin `CrmUserAccess.role` did not bypass campaign contact restrictions.

### What changed

- **Voicemail drops:** `POST/PATCH/DELETE /crm/voicemail-drops` now use `requireCrmAccess` so Agents/Managers can upload, rename, and archive tenant-scoped recordings. Drop-on-call still tenant-scoped; now also contact-scoped for restricted agents.
- **Contact scope:** `assertCrmContactAllowed` added to disposition, checklist respond, voicemail drop, contact detail GET, notes, and tasks. CRM MANAGER / CRM ADMIN bypass campaign allow-list within tenant via `crmRoleBypassesContactRestriction`.
- **Email templates:** `canEditTemplate` is async and grants edit on shared templates to CRM Manager/Admin (not only platform admins).
- **Portal:** `PermissionGate` added on `/crm/checklists`, `/crm/scripts`, `/crm/voicemail-drops`, `/crm/live-call` matching nav permissions.
- **Tests:** `crmPermissionAudit.test.ts`, expanded `scriptChecklistAccess.test.ts` and `crmContactAccess.test.ts`.
- **Docs:** CRM permission matrix added to `CRM.md`.

### Deploy

Requires **`api`** and **`portal`**. No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/crmPermissionAudit.test.ts src/crm/scriptChecklistAccess.test.ts src/crm/crmContactAccess.test.ts src/crm/emailRoutes.crmAccess.test.ts
pnpm --dir packages/shared exec node --import tsx --test src/portalPermissions.crm.test.ts src/portalPermissions.crmEmail.test.ts
pnpm --dir apps/api typecheck
pnpm --dir apps/portal typecheck
```

Manual QA: log in as CRM Agent with campaign restriction — confirm visible actions work in-scope and return 403 out-of-scope; log in as CRM Manager — confirm upload voicemail, edit shared email template, set disposition; confirm `/crm/email/settings` and fleet diagnostics remain blocked for Agent/Manager.

---

## 2026-05-31 — CRM Email Template backend completion

**Task:** CRM / email templates / backend implementation
**Risk:** high

### Gap

The UI had controls for branding logos and template attachments, but the backend still needed the final production path: uploaded logos must not expose storage keys, final emails need inline logo images instead of expiring links, and attachment send behavior needed tighter tenant/template scoping and allowlist coverage.

### What changed

- **Branding logos:** API branding responses now resolve uploaded logos to a safe preview route and never return raw `logoStorageKey`. Final server-side renders use `cid:connect-crm-business-logo` for uploaded tenant logos.
- **Worker sends:** Gmail MIME construction now supports inline CID logo parts plus normal template attachments in the same multipart send.
- **Attachments:** ZIP was removed from the CRM template attachment allowlist. Allowed types are PDF, DOCX, XLSX, CSV, JPG, PNG, and WEBP.
- **Tenant isolation:** worker attachment loading now scopes selected attachment IDs by tenant and template, preventing cross-template/cross-tenant attachment injection.
- **Tests:** added focused storage, source-safety, shared rendering, and MIME tests for logo scoping, safe preview rendering, CID logo sends, ZIP rejection, attachment inclusion, cross-tenant scoping, missing merge values, and plain-template compatibility.

### Deploy

Requires **`api`** and **`worker`**. No new Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/emailTemplateAttachmentStorage.test.ts src/crm/emailTemplateRoutes.source.test.ts
pnpm --dir packages/shared exec node --import tsx --test src/crmEmailTemplates.test.ts
pnpm --dir apps/worker exec node --import tsx --test src/crmEmailSend.test.ts src/crmBulkEmail.test.ts
pnpm --dir apps/api typecheck
pnpm --dir apps/worker typecheck
```

Manual QA: upload branding logo, confirm API branding payload has `logoUrl` but no `logoStorageKey`; send a test email from a rich template and confirm the message includes the business logo inline; upload/send PDF/DOCX/XLSX/CSV/JPG/PNG/WEBP attachments; confirm ZIP upload is rejected; confirm another tenant/template attachment ID cannot be selected into a send.

---

## 2026-05-31 — CRM Email Template Builder UI polish

**Task:** CRM / email templates / UI polish
**Risk:** medium

### Gap

The CRM email builder had the right core feature set but still behaved like a dense first-pass implementation: one large page owned all state and panels, library cards lacked direct actions, autosave/dirty-state feedback was missing, and drag/drop/upload/preview affordances needed a more premium 2026 SaaS feel.

### What changed

- Split the templates page into reusable portal components under `apps/portal/components/crm/email/templates/`:
  - `TemplateLibraryPanel`
  - `EmailBuilderCanvas`
  - `EmailPreviewPanel`
  - `UtilityPanels`
  - `StarterTemplatesStrip`
- Polished the three-panel layout, library cards, hover states, shadows, compact filters, inline favorite/rename/duplicate/archive/restore actions, and responsive behavior.
- Added autosave/dirty-state UI, before-unload protection for unsaved edits, drag/drop block insertion, drag/drop attachment/logo upload affordances, and upload progress feedback.
- Improved Branding, Attachments, Merge Fields, AI Assistant, and live preview panels without changing schema or API contracts.

### Deploy

Requires **`portal`** only. No Prisma migration and no backend deploy required for this polish pass.

### Verify

```bash
pnpm --dir apps/portal typecheck
pnpm --dir packages/shared exec tsx --test src/crmEmailTemplates.test.ts
pnpm --dir apps/worker exec tsx --test src/crmBulkEmail.test.ts
```

Manual QA still recommended for `/crm/email/templates`: desktop/tablet/mobile layout, create/edit, autosave, duplicate, archive/restore, send test, logo upload, attachment upload, merge insert/copy, AI actions, and live preview modes.

---

## 2026-05-31 — CRM Email Template Builder rebuild

**Task:** CRM / email templates / UI rebuild / attachments / branding
**Risk:** high

### Gap

`/crm/email/templates` was still a Phase 1 plain-text CRUD form backed by `CrmEmailTemplate.bodyText`, and CRM Gmail sending emitted `text/plain` only. There was no reusable CRM branding, visual builder content, server-side merge contract, template attachments, starter gallery, or professional HTML email rendering.

### What changed

- **Data model:** added backward-compatible CRM email template metadata (`category`, favorite/draft flags, preview text, usage tracking, HTML/body JSON), tenant branding, per-user signature, and tenant-scoped template attachments.
- **API:** template routes now support rich fields, duplicate/archive/send-test, starters, branding/signature save, attachment upload/remove, merge field discovery, and real AI generation when `OPENAI_API_KEY` is configured.
- **Rendering:** CRM sends can render server-side HTML + plain-text fallback and include template attachments in Gmail multipart MIME.
- **Portal:** `/crm/email/templates` is now a three-panel no-code builder matching the mockup structure: template library, visual TipTap builder with block rail, live desktop/mobile preview, and bottom Branding/Attachments/Merge Fields/AI panels.
- **Compatibility:** compose and bulk email paths remain compatible with existing plain-text templates while tolerating new rich template fields.

### Migration

- `packages/db/prisma/migrations/20260610120000_crm_email_builder`

### Deploy

Requires **`api`**, **`worker`**, and **`portal`**. Prisma migration is required and should be run by the API deploy job only.

### Verify

```bash
pnpm --dir packages/shared exec tsx --test src/crmEmailTemplates.test.ts
pnpm --dir apps/worker exec tsx --test src/crmBulkEmail.test.ts
pnpm --dir apps/portal typecheck
pnpm --dir apps/api typecheck
pnpm --dir apps/worker typecheck
```

Manual QA: create blank/starter templates, save draft/template, add branding/signature, insert merge fields, upload PDF/XLSX/image attachment, preview desktop/mobile, send test email, confirm HTML email and attachment delivery, confirm Agent/Manager access and settings admin-only behavior.

---

## 2026-05-30 — CRM Email access for Agent and Manager roles

**Task:** CRM / email / permissions / UI
**Risk:** medium

### Gap

CRM Email sidebar and routes required `can_view_crm_settings` (CRM Admin bucket only). CRM Agent and CRM Manager could not reach templates, send flows, or the Email nav item despite having CRM access.

### What changed

- **Shared permissions:** `can_view_crm_email` added to `can_view_crm` and `can_manage_crm` expansions (`packages/shared/src/portalPermissions.ts`). CRM Admin retains `can_view_crm_settings` for settings/wallboard only.
- **Portal:** `navConfig` CRM Email → `can_view_crm_email`; `PermissionGate` on `/crm/email` and `/crm/email/templates`; `/crm/email/settings` gated by `can_view_crm_settings`; agents connect USER Gmail from landing page (OAuth redirect → `/crm/email`).
- **API:** All `/crm/email/*` routes (except OAuth callback) use `requireCrmAccess`; `POST /crm/email/send` uses `assertCrmContactAllowed` (campaign/assignment scope); fleet diagnostics use `requireCrmEmailSettingsAccess` (platform admin or CrmUserAccess ADMIN).
- **Shared helper:** `apps/api/src/crm/crmContactAccess.ts` (reused by inbound caller match).

### Deploy

Requires **`api`** and **`portal`**. No Prisma migration.

### Verify

```bash
pnpm --dir packages/shared exec node --import tsx --test src/portalPermissions.crm.test.ts src/portalPermissions.crmEmail.test.ts
pnpm --dir apps/api exec node --import tsx --test src/crm/crmContactAccess.test.ts src/crm/emailRoutes.crmAccess.test.ts src/crm/emailRoutes.test.ts
```

1. CRM Agent — sidebar **Email**, `/crm/email`, `/crm/email/templates`; no `/crm/email/settings`.
2. CRM Manager — same; no CRM settings unless CRM Admin role.
3. Send to contact outside agent campaign scope → API `403`.
4. CRM Admin / tenant admin — settings + fleet diagnostics still work.

---

## 2026-05-30 — Inbound CRM caller ID on dialer + telephony WS

**Task:** Telephony / CRM / dialer UI
**Risk:** high

### Gap

Inbound calls showed only PBX/SIP caller ID. CRM lead names and profile links were not on the telephony WebSocket payload, and the floating dialer had no permission-safe server match.

### What changed

- **API:** `apps/api/src/crm/inboundCallerMatch.ts` — tenant-scoped phone match (E.164 + exact `ContactPhone`, safe last-10 suffix), per-viewer CRM/campaign access filter; internal `POST /internal/telephony/inbound-crm-match` (CDR secret).
- **Telephony:** `CrmInboundCallerEnricher` — per-WS-client enrichment on `telephony.call.upsert` and snapshots; optional fields `crmContactId`, `crmContactName`, `crmCompanyName`, `crmProfileUrl`, `crmMatchSource` (inbound only).
- **Portal:** Floating dialer + `ActiveCallsPanel` prefer CRM display name; compact **Open CRM Profile** on matched inbound calls; `CrmScreenPop` uses WS fields first.

### Deploy

Requires **`api`** and **`telephony`** (same `CDR_INGEST_URL` / `CDR_INGEST_SECRET` as CDR ingest). No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/inboundCallerMatch.test.ts
pnpm --filter @connect/telephony test
pnpm --dir apps/portal exec vitest run lib/crmInboundCallDisplay.test.ts
```

1. CRM-enabled tenant, contact with primary phone matching inbound DID.
2. Ring extension from that number — floating dialer shows contact name + **Open CRM Profile**.
3. User without CRM access or campaign assignment — no CRM fields on WS payload, no button.

---

## 2026-05-30 — CRM lead timezone: Arizona/Phoenix display polish

**Task:** CRM / leads / timezone UI polish
**Risk:** low

### Gap

Phoenix (`America/Phoenix`) was stored and displayed as generic **Mountain / MT**, which implies DST. Arizona does not observe DST and needs a distinct display label while staying in the Mountain filter bucket.

### What changed

- `America/Phoenix` now stores `timezoneLabel: "Arizona"` (Denver remains `"Mountain"`).
- Mountain filter (`timezoneZone=mountain`) matches labels `Mountain` + `Arizona` and IANAs `America/Denver`, `America/Boise`, `America/Phoenix` (includes legacy Phoenix rows still labeled Mountain).
- Row badge: Phoenix → **AZ**; detail → **Arizona (MST)** with tooltip noting no DST.
- Shared display helpers: `leadTimezoneBadgeShort`, `leadTimezoneDetailLabel` (API + portal).

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/leadTimezoneResolver.test.ts
```

---

## 2026-05-30 — CRM lead timezone resolution + filtering

**Task:** CRM / leads / data normalization / filtering
**Risk:** medium

### Gap

CRM leads stored city/state on `ContactAddress` but had no derived timezone, no server-side persistence, and no list filtering by US timezone bucket.

### What changed

- Added timezone fields on `CrmContactMeta`: `timezoneIana`, `timezoneLabel`, `timezoneOffsetMinutes`, `timezoneResolvedAt`, `timezoneResolutionStatus`.
- Added deterministic US resolver (`city-timezones` dataset) in `apps/api/src/crm/leadTimezoneResolver.ts`.
- Timezone sync runs on lead create, lead update when city/state changes, CSV import rows, and admin backfill.
- `GET /crm/contacts` accepts `timezoneZone`, `timezoneLabel`, and `timezoneIana` filters (tenant-scoped via existing `crmMeta.tenantId`).
- `GET /crm/campaigns/:id/members` accepts the same timezone query params for campaign-safe roster filtering.
- CRM contacts list UI adds a timezone dropdown and compact row badge; contact detail shows timezone near address.
- Admin backfill: `POST /crm/admin/lead-timezone/backfill?dryRun=true&limit=200&cursor=`.

### Migration

- `packages/db/prisma/migrations/20260609000000_crm_lead_timezone`

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/leadTimezoneResolver.test.ts src/crm/leadTimezoneService.test.ts
```

Backfill (CRM admin JWT):

```bash
curl -s -X POST "$API/crm/admin/lead-timezone/backfill?dryRun=true&limit=50" -H "Authorization: Bearer $JWT"
```

Filter example:

```bash
curl -s "$API/crm/contacts?timezoneZone=eastern&limit=10" -H "Authorization: Bearer $JWT"
```

### Deliberately not changed

- Telephony, billing, worker jobs, VitalPBX, mobile.
- Frontend-only timezone calculation (all values stored server-side).
