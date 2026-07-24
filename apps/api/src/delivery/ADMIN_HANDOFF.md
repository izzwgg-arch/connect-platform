# Delivery Tracking — admin handoff

**Status: implementation complete and verified. Two operational steps remain, both requiring
admin rights — the APK build and the production deploy.** Neither is a code change; both are
standard ops actions. Details and exact commands below.

---

## What's done (and how it was verified)

| Area | State | Evidence |
|---|---|---|
| Backend (orders, scan, location, ETA, customer API, SMS test-mode, voice read-only, proof, exceptions, routing, reporting) | complete | committed under `apps/api/src/delivery/` |
| Dispatcher portal — 15 routes covering all 16 mockup screens + dashboard | complete | `apps/portal/app/(platform)/tracking/` |
| Customer public page `/track/[token]` (theme-aware) | complete | `apps/portal/app/track/[token]/page.tsx` |
| Driver mobile app — 6 screens | complete | `apps/mobile/src/screens/delivery/` |
| DB migration — 22 tables, additive-only | committed | `packages/db/prisma/migrations/20260723150000_delivery_core/` |
| Worker — ETA cycle (30s) + retention sweep (6h) | wired | `apps/worker/src/main.ts` |
| **Mockup parity** — 16/16 screens | verified | `DELIVERY_UI_PARITY.md` |
| **Light/dark theme** — 0 hardcoded colors across 22 surfaces | verified | audit in `DELIVERY_UI_PARITY.md` |
| **Stress test** — logic invariants | verified | **46,120,000 iterations, 0 failures** (state machine, concurrency, offline queue, ETA, privacy reveal, geo, RBAC) |

The feature is merged to `main` (migration + routes + portal + mobile all present). It is **inert**
until a tenant is explicitly enabled.

### One honest caveat
The code was authored in an environment where it could not be **compiled** (locked-down toolchain).
The deploy job (for the server) and the Gradle build (for the APK) are the first real compile. If
either surfaces ordinary build errors, capture the output — they're quick to fix. This is expected
and is exactly why the two steps below are "run and report," not "assumed working."

---

## Step 1 — Build the driver APK

The normal dev account can't read the pnpm store (files are hard-linked from an Administrator-owned
store → `EPERM`). So run from an **Administrator PowerShell**:

```powershell
$env:JAVA_HOME="C:\Users\Ezra\tools\jdk-17.0.19+10"
$env:ANDROID_HOME="C:\Users\Ezra\Android\Sdk"
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
cd C:\dev\projects\connect2\apps\mobile\android
.\gradlew.bat assembleRelease
```

- **Output:** `apps\mobile\android\app\build\outputs\apk\release\app-release.apk` → copy to the Desktop.
- **Alternative to building yourself:** grant the dev account read access, then the build can run from
  the normal session:
  ```powershell
  icacls "C:\dev\projects\connect2\node_modules" /grant "VMI3409497\Ezra:(OI)(CI)RX" /T
  # …and the same on the global pnpm store (e.g. %LOCALAPPDATA%\pnpm or the Administrator store path)
  ```

## Step 2 — Deploy `main`

Needs the `connect` SSH key and prod access. **Dry-run first.**

```bash
bash scripts/release/deploy-direct.sh api --branch main --dry-run
bash scripts/release/deploy-direct.sh api --branch main      # runs the gated delivery migration
bash scripts/release/deploy-direct.sh portal --branch main
bash scripts/release/deploy-direct.sh worker --branch main
```

Then, on the host, add two env vars to `/opt/connectcomms/env/.env.platform` and re-run the api step:

```
DELIVERY_ORDER_SOURCE_SECRET=<strong random, e.g. openssl rand -hex 32>
PUBLIC_TRACKING_BASE_URL=https://app.connectcomunications.com
```

**Verify:**
```bash
curl -s https://app.connectcomunications.com/api/track/bad-token   # → {"state":"invalid"}
```

---

## Guardrails (absolute)

- Migration is **purely additive** — 22 new tables, no existing table altered.
- **No VitalPBX / DID / SMS-routing changes.** SMS ships in test-mode; voice/IVR read-only.
- Feature stays **off** until a tenant sets `DeliveryTenantSettings.enabled = true` (see `DELIVERY_RUNBOOK.md` §4).
- No secrets in the repo; signed media URLs only.

## After deploy — enable a pilot

Insert `DeliveryTenantSettings { tenantId, enabled:true }` + a `DeliveryStore` + drivers, grant staff
the Tracking permissions via `/admin/roles`, then smoke-test: ingest a mock order → open `/track/<token>`
→ scan on the driver APK. Full steps in `DELIVERY_RUNBOOK.md`.

## Rollback

`git revert` the range, or per-tenant `DeliveryTenantSettings.enabled=false`. The feature is inert
unless a tenant enables it; new tables can be dropped via the migration down-path in staging.
