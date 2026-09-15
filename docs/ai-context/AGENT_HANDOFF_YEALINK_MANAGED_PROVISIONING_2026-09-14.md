# Managed Yealink provisioning (zero-touch via Yealink RPS) — 2026-09-14

Status as of **2026-09-15: LIVE except the handset proof.** The YMCS account exists,
the client is rewritten for the real (v2) API and proven against it, the "Loopcom"
RPS server record exists (id `01a0a48be8567d07b8eac49abab70f13` →
`https://app.loopcom.net/api/phone-provisioning/`, console shows Servers: 1), all
§6 env vars are set on loopcom (`.env.platform`, backup
`.env.platform.bak-20260915-yealink`), api is deployed at `b1f6357c`
(container-verified, 0 restarts) and the handset route answers 401 (was 404 inert).
⏳ NOT PROVEN: §7 step 4 — no real phone has checked in or registered through this
path yet; `MANAGED_PHONE_SIP_PORT=5060/UDP` is set but not yet qualified on a handset.

## 0b. ⛔⛔ 2026-09-15 (later) — OUR ACCOUNT CANNOT ADD A MAC WITHOUT ITS SERIAL; PROVISION IS BY MAC + SN

Proven live against `us-api.ymcs.yealink.com` (real writes, deleted after, cloud left clean):

- `POST /v2/rps/addDevicesByMac` (add by MAC alone) → **403 `{"code":"900403","message":"This request is forbidden"}`** for our account tier, on every body shape. Our client USED this call, so as first written it would 403 on every real phone.
- `POST /v2/rps/devices` `{mac, sn, serverId, uniqueServerUrl, authName, password}` (add WITH serial) → **201 Created**, and it **persists our per-device `uniqueServerUrl` and `authName`** (confirmed by `GET /v2/rps/devices/{id}`). This is the anti-hijack guarantee: Yealink requires the serial as proof of possession before it will claim a MAC into an RPS account.
- ⛔ The SN is NOT validated against the MAC at add time (a placeholder SN was accepted), but it is REQUIRED and non-empty. Real phones supply their real SN; the wizard already collects it (serial-on-the-extension-screen).
- **Fix committed `265402dd` (deployed):** the client adds one device with its SN (`addDevice` → `rps/devices`); `assign()` fails fast without a serial (`serial_number_required`, 400); `ManagedPhoneService.provision` REQUIRES and stores `serialNumber` (the column already existed) and passes it to `assign` at reconcile; the route validates it (`z.string().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/)`); `ManagedPhonePanel` has a required Serial number field. Read-back verify via `deviceDetail` is unchanged.
- **LIVE ROUND-TRIP PROVEN through the DEPLOYED container** (`app-api-1`, commit `265402dd`): `configuredRps()` (mode live) → `assign({mac, serialNumber, …})` → `state:assigned` + device id → `deviceDetail` shows `serverId`=our Loopcom server, `uniqueServerUrl`=`https://app.loopcom.net/api/phone-provisioning/<mac>/`, `authName`=`<mac>` → `release` → `checkMac` gone. Cloud verified back to **0 devices**.
- **LIVE endpoint auth** (`https://app.loopcom.net/api/phone-provisioning/<mac>/<mac>.cfg`): no creds → **401** + `WWW-Authenticate: Basic realm="Loopcom phone provisioning"` + `Cache-Control: no-store, private`; wrong creds → **401** (never 200); `/api/desk-phones/managed/*` → 401 without a JWT.
- ⛔ **v2 `checkMac` can never see another account's device** (v2 only lists ours), so a foreign owner surfaces ONLY as code 800004 at add time — the wizard's cloud lookup cannot pre-say "owned elsewhere" for Yealink before a claim.

## 0. ⛔⛔ 2026-09-15 — THE v1 JSON API IS DEAD ON YMCS; THE CLIENT IS A v2 OAUTH CLIENT NOW

- The 2019/2020 "Json API for RPS Management Platform" (X-Ca-Key/X-Ca-Signature HMAC
  scheme, `/api/open/v1/*`) is **rejected by us-api.ymcs.yealink.com on every path
  with 401 `{"code":"500401","message":"Invalid request header"}`**. Do not debug the
  signature — the whole auth scheme changed.
- The real YMCS open API: **OAuth2 client-credentials.** `POST /v2/token` with
  `Authorization: Basic base64(AccessKeyId:AccessKeySecret)`, body
  `{"grant_type":"client_credentials"}`, plus `timestamp` (ms) and `nonce` headers →
  `{access_token, expires_in: 3600}`; then `Authorization: Bearer` + the same two
  headers on every call. Endpoints: `POST /v2/rps/listDevices`
  `{skip,limit,autoCount,filter:{mac}}` → `{total,data|null}`; `GET /v2/rps/devices/{id}`;
  `POST /v2/rps/addDevicesByMac` `[{mac,serverId?,uniqueServerUrl?,authName?,password?}]`;
  `POST /v2/rps/delDevices` `{deviceIdType:"mac"|"id",deviceIds}`; `POST /v2/rps/servers`
  `{serverName,url}`; `POST /v2/rps/listServers`. Errors are `{code,message,details}`:
  **800004** = MAC managed by another org → `rps_ownership_conflict`; **800003** =
  already exists → `rps_duplicate_retry_to_reconcile`. (Shape learned from
  nethesis/falconieri `libs/ymcs` and proven live.)
- ⛔ **v2 has NO checkMac and only ever shows OUR devices.** `checkMac()` now returns
  `{existed:true,self:true}` or `{existed:false,self:null}` — `self:false` can never
  happen; a foreign owner surfaces only as 800004 when an add is attempted. The wizard's
  cloud lookup therefore can no longer say "owned elsewhere" for Yealink before a claim.
- The AccessKey lives at **YMCS → System → Integration → API** (super admin), which
  also shows the API **Domain** (`us-api.ymcs.yealink.com`) → `YEALINK_RPS_BASE_URL=https://us-api.ymcs.yealink.com/`.
  A key was generated 2026-09-15 (values live ONLY in `.env.platform`; the "Reacquire"
  button invalidates the old key immediately).
- The simulator simulates the v2 contract now (Bearer + nonce replay + v2 error bodies);
  the one-shot 401 token refresh is tested; suite 267/268 (1 pre-existing skip).

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

## 3b. What is proven vs what only a handset can prove (2026-09-15)

- ✅ PROVEN LIVE: YMCS auth; the Loopcom RPS server record; **device claim by MAC + serial → RPS redirect to our exact per-device URL with the phone's Basic username**; release; endpoint auth (401/no-store/WWW-Authenticate). All reversible; cloud left at 0 devices.
- ✅ PROVEN BY TEST: the generated Yealink `.cfg` is well-formed (`#!version:1.0.0.1`, `account.1.*`, bounded line keys) — the SAME code the endpoint serves.
- ⏳ ONLY A HANDSET CAN PROVE (by design — the per-device provisioning password lives ONLY in RPS + on the phone, never in our API in the clear): the phone factory-booting → consulting RPS → fetching `<mac>.cfg` with its Basic creds → applying it → REGISTERING the desk endpoint. RPS consults happen ONLY at factory boot.
- ⛔ "Works on EVERY model, flawlessly, for years" is NOT provable from one handset. One handset proves the UNIVERSAL mechanism (RPS-redirect-at-factory-boot + auto-provision), which is identical across RPS-capable Yealinks. Per-MODEL correctness (config-key set, physical line-key count, firmware-specific params) still needs per-model validation: every model in `YEALINK_MANAGED_MODELS` stays `qualification: "pending_handset_validation"` until a real handset of that model registers. Sustainability layer = that qualification list + a firmware floor + the existing rpsState/served/registration evidence.

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
- ~~NOT PROVEN: any live RPS call~~ **2026-09-15: live v2 calls proven** (token, listDevices,
  listServers, server create with read-back). STILL NOT PROVEN: any handset download or real
  registration through this path (needs the designated test Yealink), and the SIP 5060/UDP choice.
- `firmware`/`serialNumber` columns exist but nothing fills them yet.

## Sources

- https://support-cdn.yealink.com/attachment/upload/attachment/2019-2-26/5/fe3701af-d78e-4f6c-b78f-7148e6f5aad8/Yealink_Json_API_for_RPS_Management_Platform.pdf
- https://github.com/yealink/RpsJsonOpenApiDemo
