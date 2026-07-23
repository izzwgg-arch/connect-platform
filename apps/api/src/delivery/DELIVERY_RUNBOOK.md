# Supermarket Delivery Tracking — Runbook (migrate / build / verify)

Status at this commit: code + schema + Tracking section + full permissions are in place and
unit/stress-tested. The Prisma client has **not** been regenerated for the new models yet
(the CLI couldn't run in the authoring environment). Do the steps below in a healthy
toolchain (Node version per repo, working `pnpm`, reachable Postgres). **Do not deploy** until
verified and approved.

## 0. Prerequisites
- Node version the repo targets (Prisma 6.19 is unhappy on Node 26; use the repo's pinned Node).
- `pnpm` available; `DATABASE_URL` pointing at a **local/staging** Postgres (never prod).
- Redis for the worker paths (not required for the core API smoke).

## 1. Generate client + migrate (local/staging only)
```bash
pnpm install                                            # ensure @prisma/* fully linked
pnpm --filter @connect/db exec prisma format            # sanity-format the schema
pnpm --filter @connect/db exec prisma migrate dev --name delivery_core
# ^ creates the migration for all 17 delivery models AND regenerates the client.
```
Note: the schema uses scalar `tenantId` (+ SQL FKs added by the migration Prisma generates
for the declared relations). If you want DB-level Tenant/Store/User FK cascades on the
scalar columns, apply the supplemental `ALTER TABLE … _fkey` statements from
`scratchpad/phase{2,3,5}-delivery/migrations/*/migration.sql` as a follow-up raw migration.
Production migrations run **only** via the gated `api` deploy job — never by hand on the server.

## 2. Typecheck / build
```bash
pnpm --filter @connect/shared build      # permission registry (Tracking keys)
pnpm --filter @connect/api build         # server + delivery routes (needs generated client)
pnpm --filter @connect/portal build      # nav + /tracking pages + Permission type
```
All three should pass once the client is generated. If `@connect/api` typechecks fail on
`db.delivery*`, the client wasn't regenerated — re-run step 1.

## 3. Unit + stress tests
```bash
# unit (no DB):
node --import tsx --test apps/api/src/delivery/*.test.ts apps/mobile/src/delivery/*.test.ts   # 59 pass
# stress (no DB): copy scratchpad/stress/deliveryStress.ts to apps/api/src/delivery/__stress/ and run:
node --import tsx apps/api/src/delivery/__stress/stress.ts    # 9.2M iters, expect "ALL INVARIANTS HELD"
```

## 4. Enable a tenant + seed, then smoke end-to-end
```sql
-- enable the feature for a test tenant
INSERT INTO "DeliveryTenantSettings" ("id","tenantId","enabled","updatedAt")
VALUES ('dts_test','<TENANT_ID>',true,now());
-- a store the mock adapter can map to (externalRef 'elm-st')
INSERT INTO "DeliveryStore" ("id","tenantId","name","externalRef","active","updatedAt")
VALUES ('ds_elm','<TENANT_ID>','Elm St','elm-st',true,now());
-- a driver (DriverProfile.userId = an existing User) + store grant
INSERT INTO "DriverProfile" ("id","tenantId","userId","status","active","updatedAt")
VALUES ('drv_1','<TENANT_ID>','<USER_ID>','AVAILABLE',true,now());
INSERT INTO "DriverStore" ("id","tenantId","driverId","storeId") VALUES ('dst_1','<TENANT_ID>','drv_1','ds_elm');
```
```bash
export DELIVERY_ORDER_SOURCE_SECRET=<strong-random>
# ingest a mock order (returns { orderId, labelToken })
curl -sX POST localhost:3001/internal/delivery/orders \
  -H "x-delivery-source-secret: $DELIVERY_ORDER_SOURCE_SECRET" -H "x-tenant-id: <TENANT_ID>" \
  -H 'content-type: application/json' \
  -d '{"event":{"type":"created","id":"SRC-1","storeRef":"elm-st","address":{"line1":"142 Elm St","unit":"4B"}}}'
# driver scans it (idempotent — repeat with same clientOpId = no double assign)
curl -sX POST localhost:3001/mobile/delivery/scan -H "authorization: Bearer <DRIVER_JWT>" \
  -H 'content-type: application/json' -d '{"token":"<labelToken>","clientOpId":"op-1"}'
# dispatcher views
curl -s localhost:3001/delivery/dashboard -H "authorization: Bearer <ADMIN_JWT>"
```

## 5. Verify the Tracking section + permissions in the UI
- Open `/admin/roles/new` → confirm a **Tracking** section and all `can_*_tracking` toggles appear.
- As a tenant admin, open `/tracking/dashboard` → tiles + attention load.
- Create a custom role with only `can_view_tracking` → assignee sees the Tracking section (read).

## 6. Mobile (driver app) — remaining wiring
- Register `RunsScreen` + `ScanScreen` (`apps/mobile/src/screens/delivery/`) in the driver
  navigation. Add `expo-battery`; add `ACCESS_FINE_LOCATION` + `FOREGROUND_SERVICE_LOCATION`
  via the `app.config.ts` Expo plugin. Call `startTracking/stopTracking` on run start/end.

## 7. Rollback
- `git revert` this commit (or `git checkout main`). To drop the tables, revert the migration
  (`prisma migrate resolve`/down in staging). No existing data is touched by these additions.

## Phase 6 — customer tracking page (added)
- New model `TrackingToken` (included in the migrate step above).
- Public page: `apps/portal/app/track/[token]/page.tsx` → `GET /track/:token` (no auth; token-
  authed in the handler; already added to `jwtPublicRouteBypass.ts`). Dispatcher mint/revoke:
  `POST /delivery/orders/:id/tracking-link[/revoke]` (JWT-gated).
- Smoke: mint a link (`curl -sX POST .../delivery/orders/<id>/tracking-link -H "authorization: Bearer <ADMIN_JWT>"`
  → `{ token, path }`), then open `/track/<token>` in a browser (no login) → status/ETA/progressive map.
- Worker: register the ETA recompute cycle in `apps/worker/src/main.ts`:
  `import { runDeliveryEtaCycle } from "./deliveryEtaJob"; setInterval(() => runDeliveryEtaCycle().catch(() => {}), 30_000);`
- Verify `GET /track/<bad-token>` returns `{ state: "invalid" }` (200, leaks nothing).

## Phase 7 — SMS notifications + inbound commands (TEST MODE)
- New models `DeliveryNotification` (deduped outbound log) + `DeliverySmsConsent` (STOP/START).
- **Outbound is test-mode by default**: `notifyOrder()` records a `DeliveryNotification`
  (status `TEST`, deduped by `idempotencyKey`, consent-gated) but does **not** send. Real send
  requires `DELIVERY_SMS_LIVE=1` **and** completing the provider/queue wiring under separate
  approval (no production SMS is activated by this phase).
- Inbound command handling (STATUS/TRACK/ETA/ORDER/HELP/STOP/START) is fully functional but
  reached only via the **internal test endpoints** (secret-gated), NOT the live VoIP.ms webhook:
  ```bash
  curl -sX POST .../internal/delivery/sms/inbound -H "x-delivery-source-secret: $SECRET" \
    -H "x-tenant-id: <TENANT_ID>" -H 'content-type: application/json' \
    -d '{"from":"+15551230000","body":"where is my order"}'      # → { reply, intent }
  curl -sX POST .../internal/delivery/sms/notify -H "x-delivery-source-secret: $SECRET" \
    -H "x-tenant-id: <TENANT_ID>" -d '{"orderId":"<id>","trigger":"out_for_delivery"}'
  ```
- Set `PUBLIC_TRACKING_BASE_URL` so links in messages are absolute.
- Going live (later, with approval): wire `notifyOrder` to the `sms-send` BullMQ queue and hook
  `handleInboundSms` into the VoIP.ms inbound path (`handleVoipMsInbound`) — mirror the CRM
  inbound SMS hook pattern; respect carrier STOP/START compliance.

## Phase 8 — Voice / IVR status (READ-ONLY; no PBX changes)
- No schema changes. No PBX/AstDB/VitalPBX writes of any kind in this phase.
- `voiceStatus.ts` composes a prerecorded-fragment plan (prompt refs + number playback —
  decision 2). `resolveVoiceStatus()` (read-only) maps caller-ID / manual digits → order →
  scenario (matched-single/multiple, unmatched, no-order, delivered, delayed, canceled,
  after-hours, system-error). Never speaks address/payment/sensitive data.
- Internal test endpoint (secret-gated, non-prod): 
  ```bash
  curl -sX POST .../internal/delivery/voice/resolve -H "x-delivery-source-secret: $SECRET" \
    -H "x-tenant-id: <TENANT_ID>" -H 'content-type: application/json' \
    -d '{"callerId":"+15551230000"}'      # → { scenario, fragments:[...] }
  ```
- **Going live (SEPARATE, EXPLICIT PBX APPROVAL REQUIRED — not done here):** add a delivery
  status branch to the tenant's existing DID via the Connect IVR overlay (AstDB keys, e.g.
  `buildIvrKeys`/`/voice/did/publish`), record the prompt audio for the `delivery/*` refs
  (via the existing prompt sync/upload), and have the dialplan AGI call
  `/internal/delivery/voice/resolve` to fetch the plan. Cross-check every change against the
  PBX brain files first (docs/pbx-brain). Never mutate VitalPBX config.

## Guardrails (unchanged)
- No PBX/SMS/DID changes. No production deploy without explicit approval. Feature is off unless
  `DeliveryTenantSettings.enabled = true` for the tenant.
