# Connect Delivery — server deploy checklist (run per AGENTS.md; NOT from a dev box)

Preconditions: the branch builds clean locally (`apps/mobile/build-delivery-release.ps1` green),
the PR is reviewed, and you have server access. **Deploys go through the deploy queue / direct
scripts on the app host — never `docker`/`prisma migrate`/`pnpm build` by hand on the server.**

## 0. Merge first (recommended)
Deploying a feature branch straight to prod is unusual. Prefer:
- Open the PR: https://github.com/izzwgg-arch/connect-platform/pull/new/feature/supermarket-delivery-tracking
- Review, then **merge to `main`** and deploy `main`. (Steps below use `main`; swap the branch if you deliberately deploy the feature branch.)

## 1. Server env vars (set in /opt/connectcomms/env/.env.platform — operator-owned)
Required:
- `DELIVERY_ORDER_SOURCE_SECRET` = strong random (for the internal order-ingest + test endpoints)
- `PUBLIC_TRACKING_BASE_URL` = e.g. `https://app.connectcomunications.com` (absolute links in SMS/voice)
Optional / stays OFF unless intended:
- `DELIVERY_SMS_LIVE` — **leave unset** (SMS stays test-mode). Only set to `1` after carrier/compliance sign-off.
- `DELIVERY_GEOCODER_URL` + `DELIVERY_GEOCODER_FORMAT` (`nominatim|mapbox|google`) — enables geocoding.
- nginx: route `/track/*` publicly (customer page) same as other public paths; it's already in the JWT bypass.

## 2. Migration
The delivery migration runs **only** in the `api` deploy job (it detects changed `packages/db/prisma/**`).
Do NOT run `prisma migrate` by hand on the server. Confirm the migration file is committed.

## 3. Deploy api + portal (blue/green, dry-run first)
```bash
# on the app host (or scripts/release/deploy-direct.ps1 over SSH):
bash scripts/deploy-direct.sh api --branch main --dry-run
bash scripts/deploy-direct.sh api --branch main
bash scripts/deploy-direct.sh portal --branch main
```
(Or enqueue: `POST /ops/deploy/enqueue {service:"api"|"portal", branch:"main", dryRun:true}` first.)

## 4. Worker cron jobs (register, then deploy worker)
Add to `apps/worker/src/main.ts` and deploy the worker:
```ts
import { runDeliveryEtaCycle } from "./deliveryEtaJob";
import { runDeliveryRetentionCycle } from "./deliveryRetentionJob";
setInterval(() => runDeliveryEtaCycle().catch(() => {}), 30_000);       // ETA snapshots
setInterval(() => runDeliveryRetentionCycle().catch(() => {}), 6*3_600_000); // retention sweep
```
```bash
bash scripts/deploy-direct.sh worker --branch main   # or queue: service:"worker"
```

## 5. Post-deploy verification (do not skip — AGENTS.md)
```bash
# 1) deploy log ends with: [deploy-api] done <sha> ...
# 2) new code is inside the running container:
ssh connect "docker exec app-api-1 grep -n 'registerDeliveryRoutes' /app/apps/api/src/server.ts"
# 3) delivery routes respond (feature still off until a tenant is enabled):
curl -s https://app.connectcomunications.com/api/track/bad-token   # → {"state":"invalid"} (200)
```

## 6. Enable a pilot tenant
- Insert `DeliveryTenantSettings { tenantId, enabled: true }` (+ a `DeliveryStore`, drivers) — see DELIVERY_RUNBOOK.md §4.
- Grant tracking permissions to staff via **/admin/roles** (the Tracking section + `can_*_tracking` toggles are live).
- Smoke: ingest a mock order → open `/track/<token>` → scan on the driver APK.

## Guardrails (unchanged, absolute)
- NO VitalPBX/DID/SMS-routing changes. Voice/IVR + SMS ship in test/read-only mode.
- Migrations only via the `api` deploy job. No manual docker/prisma on the server.
- Roll back with the deploy queue rollback flow / `git revert`; the feature is inert unless a tenant enables it.
