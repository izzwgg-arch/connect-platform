# Managed Yealink provisioning (zero-touch via Yealink RPS) — 2026-09-14

Status: **code complete, tested, deployed INERT.** Nothing reaches a customer until
`MANAGED_PHONE_PROVISIONING_ENABLED=1`. No Yealink credentials exist, no RPS call
has been made, no handset has checked in, no PBX write was made.

## 1. What this is, and the four separate systems

| Concept | Owner | Role |
|---|---|---|
| **Yealink RPS** | Yealink | Bootstrap only: a factory-new/reset phone asks RPS "where do I go?" and is redirected to a per-MAC Loopcom URL. |
| **Loopcom provisioning server** | Connect api | `GET /api/phone-provisioning/<mac>/<file>` serves the actual Yealink config, per-device HTTP Basic. |
| **Yealink YMCS / management** | Yealink (optional) | Reboot / factory reset / firmware. **Not integrated**; interface boundary only (`YealinkManagement`). Capabilities report `false`. |
| **Loopcom PBX (Asterisk/VitalPBX)** | PBX | Authoritative for extensions, SIP credentials and registration. Read-only from this feature. |

```
DeskPhoneWizard (existing) ─► ManagedPhonePanel (new mode inside it)
        │
        ▼
/desk-phones/managed routes ─► ManagedPhoneService (manufacturer-agnostic)
        │                              │
        │                              ├─► DeskPhoneProvider = YealinkProvider
        │                              │        ├─ yealinkConfig (generator + model registry)
        │                              │        └─ RpsAdapter: YealinkRpsClient | DisabledRps
        │                              ├─► readManagedPhoneSip (PBX MySQL, read-only)
        │                              └─► PbxEndpointRegistration (registration evidence)
        ▼
Yealink phone ─► RPS redirect ─► /api/phone-provisioning/<mac>/<mac>.cfg ─► registers T<n>_<ext>
```

A future Grandstream/Poly adapter implements `DeskPhoneProvider`; the wizard and
service do not change. The existing office-scan / PnP / reset ladder is untouched.

## 2. Discovery facts this relies on (do not re-derive)

- `DeskPhoneSetupPhone` is unique per **run**, not per device, so it cannot enforce
  fleet-wide ownership. A new table `ManagedDeskPhone` (unique `macAddress`) does.
- The desk device on the PBX is `ombu_devices.user = '101'` (bare); Asterisk's
  endpoint is `T<n>_101`. Never the `_1` softphone. Credentials are READ from
  `ombu_devices.secret`; nothing rotates or creates PBX credentials.
- PBX SIP listeners (read 2026-09-14): **UDP 5060, TCP 5060, TLS 5061**, WSS 8089.
- `provisioning.devices` rows owned by a different PBX tenant for the same MAC →
  refused `device_ownership_conflict` (never a cross-tenant move).
- `req.ip` is the nginx hop; the real handset IP is the LAST `X-Forwarded-For` entry
  (`handsetSourceIp`). nginx sets `X-Forwarded-Proto $scheme` on every location.

## 3. Files

- `apps/api/src/deskPhoneSetup/yealinkRps.ts` — JSON RPS v1 client (signing per the
  official API doc + RpsJsonOpenApiDemo), `DisabledRps`, `configuredRps`, `strictMac`.
- `apps/api/src/deskPhoneSetup/yealinkConfig.ts` — model registry + config generator.
- `apps/api/src/deskPhoneSetup/managedPhoneService.ts` — provision / reconcile /
  update(move) / release / retire / replace / check-in / delivery tracking; audit.
- `apps/api/src/deskPhoneSetup/managedPhonePbx.ts` — SIP read + `registrationEvidence`.
- `apps/api/src/deskPhoneSetup/managedPhoneRoutes.ts` — routes + `handsetSourceIp`.
- `apps/api/src/deskPhoneSetup/managedPhoneMetrics.ts` — prom-client metrics.
- `apps/api/src/deskPhoneSetup/yealinkRpsSimulator.ts` — **test-only** RPS simulator.
- `apps/api/src/jwtPublicRouteBypass.ts` — anchored handset-filename exception only.
- `apps/portal/components/deskPhones/ManagedPhonePanel.tsx` + `managedPhoneStatus.ts`.
- `packages/db/prisma/migrations/20260914150000_managed_desk_phones/` (additive).

## 4. APIs

Management (JWT + `can_setup_desk_phones`, tenant from the token only; foreign ids = 404):
`GET /desk-phones/managed/capabilities` · `GET /desk-phones/managed` · `GET /desk-phones/managed/:id` ·
`POST /desk-phones/managed` `{mac, model, extensionId, nickname?, displayName?, options?, replacesId?}` ·
`POST …/:id/update` (move/edit/reprovision; bumps `configVersion`) · `POST …/:id/reconcile` (retry RPS) ·
`POST …/:id/release` · `POST …/:id/remove` · `POST …/:id/complete-replacement` `{attestedWorking?}`.

Handset (no JWT; HTTPS via proxy; Basic `<mac>:<per-device password>`; 30/min):
`GET /api/phone-provisioning/<mac>/{<mac>.boot|y000000000000.boot|y<12 digits>.cfg|<mac>.cfg}`.

## 5. Status model — never collapsed

`rpsState`: `pending_credentials | assigned | failed | conflict | released`.
Device evidence: `lastSeenAt` (phone fetched something) → `servedVersion == configVersion`
(this config version delivered, recorded in `onResponse`, never at generation) →
`registrationState` from `PbxEndpointRegistration`: `unknown | offline |
waiting_for_registration | endpoint_registered_device_unverified | online`.
`online` requires REGISTERED, fresh (<3 min), registered AFTER delivery, same
tenant/extension/desk endpoint, **and the phone's MAC in the SIP User-Agent or contact**.

⛔ Yealink's stock SIP User-Agent is `Yealink SIP-T53W <fw>` with no MAC, so real
phones will normally sit at `endpoint_registered_device_unverified`. That is honest.
Replacement can then be finished only with `attestedWorking: true` (admin confirms
a call on the new phone; audited as an attestation) and never without a
post-delivery registration.

## 6. Environment variables

| Variable | Meaning |
|---|---|
| `MANAGED_PHONE_PROVISIONING_ENABLED=1` | Master switch. Unset = capabilities `enabled:false`, handset route 404, management 503. |
| `MANAGED_PHONE_PROVISIONING_BASE_URL` | Must be `https://<host>/api/phone-provisioning/` (https, no query/creds). |
| `MANAGED_PHONE_SIP_PORT` / `MANAGED_PHONE_SIP_TRANSPORT` | Desk SIP listener. Qualify on a real handset; PBX offers UDP/TCP 5060, TLS 5061. |
| `YEALINK_RPS_ENABLED=1` | Turns on live RPS **only if all four below are set**; otherwise DisabledRps. |
| `YEALINK_RPS_BASE_URL` | Must be an `https://*.yealink.com/` origin (regional endpoint Yealink assigns). |
| `YEALINK_RPS_ACCESS_KEY_ID` / `YEALINK_RPS_ACCESS_KEY_SECRET` | From Yealink's RPS open-API account. |
| `YEALINK_RPS_SERVER_ID` | The RPS "server" record pointing at Loopcom (created once, see §7). |
| `YEALINK_RPS_MODE=test|mock` | **Refused at runtime** (throws). Tests inject the simulator directly. |

Secrets: env only (compose `env_file`, never an `environment:` override — see the
compose trap in CLAUDE.md). Device passwords live AES-GCM encrypted in
`ManagedDeskPhone.secretsEncrypted` (`CREDENTIALS_MASTER_KEY`).

## 7. Enabling LIVE, step by step (Yealink answered 2026-09-15)

**2026-09-15: the YMCS account EXISTS** — "[YMCS] Account Set up" email to izzy@loopcom.net
(permission: RPS; login https://us.ymcs.yealink.com/manager/login; temporary password in the
email — Izzy signs in and changes it; never record it). Ticket #530705 "Confirmed and Fixing":
Wynn_Yealink — "RPS account come with RPS API in default"; API guide:
https://support.yealink.com/document-detail/7212879a94584800aa1b8f9e3697c9b5. #530712 closed as
duplicate.

1. In YMCS (as super admin): **System → Integration → API** — this screen shows the
   **enterprise's API domain name** (→ `YEALINK_RPS_BASE_URL`) and issues the AccessKey ID +
   Secret. (Older notes said "System Management → API Service → Acquire"; the 2026-08 doc says
   System → Integration → API.) Still confirm the JSON v1 request shape with a live read
   (`server/list`) before trusting it — the 2019 doc predates 2026 accounts.
2. Create the provisioning server once: **`apps/api/scripts/yealink-rps-create-server.ts`**
   (from `apps/api`: `YEALINK_RPS_BASE_URL=… YEALINK_RPS_ACCESS_KEY_ID=… YEALINK_RPS_ACCESS_KEY_SECRET=…
   pnpm exec tsx scripts/yealink-rps-create-server.ts`). Idempotent: finds an existing
   "Loopcom" server by name, refuses one pointing at a different URL, reads the create back,
   prints `YEALINK_RPS_SERVER_ID=<id>`. Defaults `url: https://app.loopcom.net/api/phone-provisioning/`.
   The per-device `uniqueServerUrl` still points each MAC at `…/<mac>/`.
3. Set in `/opt/connectcomms/env/.env.platform`: the variables in §6. Deploy api
   through the queue (an env-only change needs a real api commit to rebuild).
4. With a **designated test Yealink** only (never a customer phone): provision it on
   Loopcom Demo ext 101 → `rpsState: assigned` → factory-reset the handset by hand →
   watch `MANAGED_PHONE_PHONE_FIRST_CONTACT`, `CONFIGURATION_SERVED` in AuditLog and
   `pjsip show endpoint T102_101` registering.
5. Only then enable for customers.

## 8. Troubleshooting

- **RPS**: `rpsState=failed` + `lastError` (`rps_authentication_failed`, `rps_rate_limited_retry_later`,
  `rps_unreachable_retry_to_reconcile`). Retry is idempotent: persisted identity + secret, then
  check-MAC → list → detail read-back; a duplicate add reconciles. `conflict` = MAC held by
  another RPS account or assigned to another server — needs release there, never overwritten.
- **Phone never checks in**: no `MANAGED_PHONE_PHONE_FIRST_CONTACT` audit row. Check the phone
  was factory reset (RPS is consulted only at factory boot), RPS assignment, nginx access log for
  `/api/phone-provisioning/<mac>/`. A 401 then nothing = wrong/old password on the phone.
- **Config served, no registration**: `servedVersion == configVersion`, registration `offline/unknown`.
  Check `MANAGED_PHONE_SIP_PORT/TRANSPORT`, the tenant `sipDomain`, and `pjsip show endpoint`.
- **409 `endpoint_assignment_changed`** on download: the extension's endpoint moved; run update.
- Metrics: `loopcom_managed_phone_operations_total{operation,result}`,
  `loopcom_managed_phone_duration_seconds`. No tenant/MAC labels by design.

## 9. Adding a model / a manufacturer

Model: add to `YEALINK_MANAGED_MODELS` (line keys drive the BLF cap). Keep
`qualification: "pending_handset_validation"` until a handset proves it.
Manufacturer: implement `DeskPhoneProvider` (validateModel, configuration, rps-like
bootstrap adapter) and select it in `ManagedPhoneService` by `manufacturer`.

## 10. Rotating secrets / disabling

- Disable everything: unset `MANAGED_PHONE_PROVISIONING_ENABLED`, restart api.
- Disable RPS only: unset `YEALINK_RPS_ENABLED` → new devices record `pending_credentials`.
- Rotate Yealink keys: replace env values, redeploy api. Device passwords are per-device;
  to rotate one, release + remove + re-provision that phone.

## 11. Tests and evidence (2026-09-14)

- `yealinkRps.test.ts` (12): MAC forms, official signature vector, mock refused at runtime,
  half-configured stays disabled, simulator not imported by runtime, BLF cap, RPS timeout
  reconcile, 401/403/429/500 never leak body, server lifecycle.
- `managedPhoneIntegration.test.ts` (13): full chain with fakes, concurrent same-MAC claims,
  cross-tenant refusal (404/409), RPS timeout reconcile, disabled mode, auth gate, move +
  stale-version delivery, replacement (MAC-proven and attested), real-client IP, stale/wrong
  evidence never online, real Fastify route (401/400 tenant-injection/403/200 + no-store),
  JWT bypass anchoring.
- `managedPhonePostgres.test.ts` (real PostgreSQL 16, local 127.0.0.1:55439 only): advisory-lock
  convergence, unique MAC, audit-FK rollback, tenant delete cascades.
- Migration drift: fresh DB = pre-change baseline dump + migration → `prisma migrate diff`
  against schema = **empty**.
- Portal `managedPhoneStatus.test.ts` (3). Typechecks: api 84 = baseline, portal 0.
- ⛔ The local verification Postgres (`.managed-phone-test-pg/`, port 55439, trust auth) and the
  `.managed-phone-baseline.*` dumps are untracked scratch in the repo root — never commit them.

## 12. Limitations imposed by Yealink / not proven

- RPS only redirects at **factory boot**; an in-service phone must be factory reset (by hand,
  or via YMCS which is not integrated).
- RPS cannot reboot, reset or push firmware. `reboot/factoryReset/firmwareUpdate` are `false`.
- A MAC already claimed by another RPS account can only be released by that account/Yealink.
- SIP User-Agent carries no MAC → physical identity usually unverifiable from the PBX.
- NOT PROVEN: any live RPS call, any handset download, any real registration through this path,
  and whether the JSON v1 endpoint is available to a 2026 account.
- `firmware`/`serialNumber` columns exist but nothing fills them yet.

## Sources

- https://support-cdn.yealink.com/attachment/upload/attachment/2019-2-26/5/fe3701af-d78e-4f6c-b78f-7148e6f5aad8/Yealink_Json_API_for_RPS_Management_Platform.pdf
- https://github.com/yealink/RpsJsonOpenApiDemo
