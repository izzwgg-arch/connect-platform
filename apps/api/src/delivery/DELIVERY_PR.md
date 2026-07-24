# Supermarket order delivery tracking (Connect/Loopcom)

Paste this into the PR at:
https://github.com/izzwgg-arch/connect-platform/pull/new/feature/supermarket-delivery-tracking

---

## Summary

Adds a complete, multi-tenant **supermarket order delivery-tracking** platform inside Connect —
order intake → printed label → driver Android scan → assignment → live GPS + ETA → customer
status via **web / SMS / phone** → proof of delivery → notify → dispatcher portal → reporting.
Built additively behind a **per-tenant feature flag** (off by default). **No PBX/SMS/DID or
production changes** are activated by this PR.

Delivered as **11 focused commits**; **117 unit tests + a 9.22M-iteration fuzz/concurrency stress
test all green**. Not yet migrated/generated/deployed — see **Activation** below.

## What's included

| Area | Highlights |
|---|---|
| **Order domain** | State machine (server-enforced, raw source status kept separate), idempotent label scan (tenant/store-safe), orders/packages/runs/assignments, mock `OrderSourceAdapter` |
| **Dispatcher web** | New **Tracking** sidebar section: dashboard, orders, live map, runs, drivers, exceptions, reports, audit, settings |
| **Driver Android** | Runs → scan → stop → **Waze** navigate → arrive → proof / exception; offline op-queue + idempotent, conflict-aware sync engine; foreground-only location |
| **Live location + ETA** | Adaptive reporting, stale detection (never stale-as-live), provider-agnostic ETA (haversine stub), dispatcher map |
| **Customer** | Public `/track/:token` page — privacy-filtered (progressive map reveal), tiered verification, honest ETA, safe failure states |
| **SMS** | Inbound command parser + outbound templates + consent/dedup — **test-mode only** (no send unless `DELIVERY_SMS_LIVE=1`) |
| **Voice / IVR** | Read-only status resolve → prerecorded-fragment plan + number playback — **no PBX writes** |
| **Proof + exceptions** | Photo/signature/PIN/GPS proof (signed media), reason-coded exceptions, completion safeguards |
| **Route + Waze** | Nearest-neighbor + 2-opt optimizer; Waze/Google deep links; geocoding (Nominatim/Mapbox/Google, off by default) |
| **Reporting + retention** | Success/first-attempt/ETA-accuracy (approximates flagged); location/ETA retention sweep |
| **RBAC** | Full **Tracking** permission set wired into the custom-role editor (section + 9 page keys + 6 action toggles) |

## Key design decisions (locked with the product owner)
Progressive map reveal · prerecorded voice + Asterisk number playback (no TTS) · reuse tenant DID
via the AstDB IVR overlay (no VitalPBX config) · tiered customer verification · driver =
Connect User + role · foreground-only GPS + a dedicated release keystore.

## Data model
22 new tenant-scoped Prisma models (scalar `tenantId` + SQL FKs, `ConnectCdr` precedent — no edits
to the `Tenant`/`User` models). Statuses stored as `String` (validated in code) to avoid enum churn.

## Testing / verification
- `node --import tsx --test apps/api/src/delivery/*.test.ts apps/mobile/src/delivery/*.test.ts` → **117 pass**.
- Stress harness (state machine, scan/assign concurrency, offline queue, ETA, privacy reveal, geo,
  permissions): **9,220,000 iterations, 0 invariant failures** — 0 double-assignments, 0
  cross-tenant leaks, 0 lost offline ops, 0 stale-as-live, 0 privilege escalations.
- Mobile screens compile against RN/Expo conventions but are **not build-verified in CI** (no Metro/EAS in the authoring env).

## Activation (NOT done in this PR)
1. `prisma migrate dev --name delivery_core` + generate (local/staging), then `apps/mobile/build-delivery-release.ps1`.
2. Server deploy per `apps/api/src/delivery/DELIVERY_DEPLOY.md` (gated `api` migration, blue/green, worker cron).
3. APK per `apps/mobile/DELIVERY_APK_HANDOFF.md`. Runbook: `apps/api/src/delivery/DELIVERY_RUNBOOK.md`.

## Not in scope / follow-ups
- **Phase 10 — real supermarket Order API**: pending its docs (mock adapter until then; no invented fields).
- Signature-pad in the mobile proof screen; Prometheus delivery metrics; live SMS/IVR activation (separate approval).

## Guardrails honored
No VitalPBX/DID/SMS-routing changes · migrations only via the gated `api` deploy job · feature off
unless a tenant enables it · signed media URLs · secrets via `@connect/security` · no secrets committed.

## Rollback
`git revert` the range, or disable per tenant (`DeliveryTenantSettings.enabled=false`). The feature
is inert unless a tenant enables it; new tables can be dropped with the migration down-path in staging.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
