# ⛔⛔ AGENT HANDOFF — ZERO-TOUCH YEALINK (RPS) PROVISIONING is built into the existing Desk Phone Wizard and deployed INERT; no Yealink credentials, no RPS call, no handset proof (2026-09-14) — READ FIRST before touching `apps/api/src/deskPhoneSetup/managedPhone*.ts` / `yealinkRps.ts` / `yealinkConfig.ts`, `/phone-provisioning/*`, `ManagedDeskPhone`, or before enabling Yealink RPS

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full developer doc: **`docs/ai-context/AGENT_HANDOFF_YEALINK_MANAGED_PROVISIONING_2026-09-14.md`**
(architecture, APIs, env vars, enable-LIVE steps, troubleshooting, limits). Memory:
[[yealink-managed-provisioning-built-inert]]. DEPLOY STATE: see the last bullet.

- **Shape:** a "Prepare a Yealink for delivery / manage phones" mode INSIDE the existing
  wizard (`ManagedPhonePanel`) → `/desk-phones/managed*` → `ManagedPhoneService`
  (manufacturer-agnostic, `DeskPhoneProvider`; `YealinkProvider` today) → persisted
  `ManagedDeskPhone` (fleet-unique MAC, per-device AES-GCM secrets) → Yealink JSON RPS v1
  (`YealinkRpsClient`, signature per the official doc) or `DisabledRps` → the phone fetches
  `/api/phone-provisioning/<mac>/<mac>.cfg` with per-device HTTP Basic → registers the DESK
  endpoint `T<n>_<ext>` using credentials READ from `ombu_devices` (bare `101`, never `_1`).
  The office-scan/PnP/reset ladder is untouched.
- ⛔ **Inert switches:** `MANAGED_PHONE_PROVISIONING_ENABLED=1` (master; unset → capabilities
  `enabled:false`, handset route 404, management 503). RPS is live only when
  `YEALINK_RPS_ENABLED=1` AND base URL (`https://*.yealink.com/`), access key id, secret and
  server id are all set; otherwise devices record `rpsState: pending_credentials` — never a
  claimed success. `YEALINK_RPS_MODE=test|mock` THROWS at runtime; the simulator
  (`yealinkRpsSimulator.ts`) is test-only and a guard fails if runtime imports it.
- ⛔ **Four statuses, never collapsed:** RPS assignment ≠ phone contacted (`lastSeenAt`) ≠
  this config version delivered (`servedVersion == configVersion`, recorded in `onResponse`,
  never at generation) ≠ `online` (fresh REGISTERED after delivery, same tenant/extension/desk
  endpoint, AND the phone's MAC in the SIP UA/contact). ⛔ Yealink's stock SIP User-Agent has
  no MAC, so real phones normally stop at `endpoint_registered_device_unverified`. Replacement
  keeps the old phone until proven; with no MAC evidence it finishes ONLY via
  `attestedWorking: true` (admin confirmed a call; audited) AND a post-delivery registration.
- ⛔ **Security:** tenant from the token only (a body `tenantId` is a 400); foreign ids 404;
  cross-tenant MAC (Loopcom row or PBX `provisioning.devices` row) = `device_ownership_conflict`;
  same-MAC concurrent claims serialize on a Postgres advisory lock; RPS vendor bodies/fetch
  errors never propagate or log; JWT bypass is an anchored handset-filename regex only;
  handset IP = LAST `X-Forwarded-For` (`handsetSourceIp`), never `req.ip`.
- ⛔ **FKs to Tenant and Extension are CASCADE** — the first draft used Restrict, which would
  have blocked the removed-tenant erase (the ConnectChatThread class). Proven on real Postgres.
- ✅ **Proven:** api `src/deskPhoneSetup/*.test.ts` 181 pass + 1 skipped; the real-PostgreSQL
  test passes against a local 127.0.0.1:55439 DB (convergent claims, unique MAC, audit-FK
  rollback, tenant cascade); migration drift = fresh DB (pre-change baseline dump + migration)
  vs schema → `prisma migrate diff` **empty**; portal `managedPhoneStatus.test.ts` 3/3
  (registered); typechecks api 84 = baseline, portal 0. PBX transports read (read-only):
  UDP/TCP 5060, TLS 5061.
- ⏳ **NOT PROVEN:** any live Yealink RPS call (no credentials; whether the 2019 JSON v1 API is
  entitled for a 2026 account is unconfirmed), any handset check-in, any real registration via
  this path. Limits imposed by Yealink: RPS redirects only at factory boot; reboot / factory
  reset / firmware need YMCS (not integrated — capabilities report false). Enable steps: §7 of
  the handoff; test on a designated test Yealink on Loopcom Demo only.
- ✅ **Yealink Partner Agreement SIGNED 2026-09-14 11:32 (In Effect, expires 2029-09-14)** — account.yealink.com, company "connect communications" (A1124985). Memory: [[yealink-rps-account-and-ticket]].
- ✅ **THE YMCS ACCOUNT IS ISSUED (2026-09-15).** Email "[YMCS] Account Set up" from ymcs@yealink.com landed at **izzy@loopcom.net** 05:27 ET: enterprise account created, **Current permission: RPS**, login https://us.ymcs.yealink.com/manager/login, account `izzy@loopcom.net`, with a temporary system-generated password IN THE EMAIL (⛔ never paste it into chat/docs; Izzy must sign in and change it). Ticket #530705 is "Confirmed and Fixing" — Wynn_Yealink replied 09-15 05:36 "We have created a new account … RPS account come with RPS API in default", pointing at the API guide https://support.yealink.com/document-detail/7212879a94584800aa1b8f9e3697c9b5. #530712 was CLOSED by Andy as a duplicate of #530705. ⛔ **The AccessKey now lives at YMCS → System → Integration → API (super admin only)** — NOT the "System Management → API Service → Acquire" path older notes recorded — and that same screen shows the **enterprise's API domain name**, which is the value for `YEALINK_RPS_BASE_URL`. Yealink's page says the API covers the Phone Device module (what RPS provisioning needs); Workspace is not covered.
- ✅✅ **2026-09-15: THE WHOLE CHAIN IS LIVE except the handset proof.** Izzy signed in + changed the password; the AccessKey was generated (YMCS → System → Integration → API; API Domain `us-api.ymcs.yealink.com`). ⛔⛔ **The v1 JSON X-Ca API is DEAD on YMCS** — every path 401s `"Invalid request header"`; the real API is **OAuth2 client-credentials** (`POST /v2/token` Basic id:secret → Bearer; `/v2/rps/*` endpoints; errors `{code}`: 800004 = owned by another org, 800003 = exists). **`YealinkRpsClient` was rewritten to v2 in `b1f6357c`** (same `RpsAdapter` surface, same error codes, read-back discipline kept; ⛔ v2 `checkMac` can never say `self:false` — a foreign owner only surfaces at add time). The one-off script (`apps/api/scripts/yealink-rps-create-server.ts`) ran for real: server "Loopcom" id `01a0a48be8567d07b8eac49abab70f13` → `https://app.loopcom.net/api/phone-provisioning/`, console shows Servers: 1. All §6 env vars set in `/opt/connectcomms/env/.env.platform` (backup `.env.platform.bak-20260915-yealink`; SIP `5060/UDP` pending handset qualification).
- ✅✅ **2026-09-15 (later) — MAC-ONLY ADD IS FORBIDDEN; PROVISION IS BY MAC + SERIAL (`265402dd`, api+portal DEPLOYED).** Live: `POST /v2/rps/addDevicesByMac` → **403 "This request is forbidden"** for our tier; `POST /v2/rps/devices` (add WITH serial) → **201**, persists our per-device `uniqueServerUrl`+`authName`. The client now adds by MAC+SN; `assign()` fails fast without a serial; `ManagedPhoneService.provision` requires+stores the serial and passes it at reconcile; the route validates it; the wizard panel has a **required Serial number field** (shipped in the client chunk — grep "zero-touch setup"). **LIVE ROUND-TRIP PROVEN through the deployed container** (`265402dd`, 0 restarts): assign(mac,serial)→assigned→`deviceDetail` confirms serverId=Loopcom + our per-device URL + authName=mac→release→gone; **cloud verified back to 0 devices**. Endpoint auth live: no-creds 401+WWW-Authenticate+no-store, wrong-creds 401 (never 200). deskPhoneSetup: my tests pass (the 1 failing file `provisioningRecordWriter.test.ts` is PRE-EXISTING from `7e427c28`, imports none of these files — task_cd5351d0 filed). api tsc 85=baseline (0 in my files); portal tsc 0.
- ⏳ **NOT PROVEN (only a handset can, by design — the per-device password lives only in RPS + on the phone): the real factory-boot → RPS → config fetch → REGISTER leg.** "Every model, flawless, for years" is NOT provable from one handset; one handset proves the UNIVERSAL RPS+autoprovision mechanism. Per-model config-key/line-key correctness stays `pending_handset_validation` until a handset of that model registers (sustainability = qualification list + firmware floor + existing evidence). Test on a designated phone on Loopcom Demo only, never a customer phone.
- ⛔ `.managed-phone-test-pg/` (a running local Postgres data dir) and `.managed-phone-baseline.*`
  are untracked scratch in the repo root — never commit them.
- ✅ **DEPLOY STATE (2026-09-14): api DEPLOYED and container-verified at `0f17fe1a`** — migration
  `20260914150000_managed_desk_phones` applied 15:17Z (table present, **0 rows**), `verify: container
  commit 0f17fe1a1893 matches target`, 0 restarts, 0 error-level lines; on BOTH hostnames health 200,
  `/api/phone-provisioning/<mac>/<mac>.cfg` → **404** (inert, handler-owned), `/api/desk-phones/managed/*`
  → 401 without a token; neither `MANAGED_PHONE_PROVISIONING_ENABLED` nor `YEALINK_RPS_ENABLED` is set.
  ⛔ **The FIRST deploy attempt failed `failed to bind host port 127.0.0.1:3004: address already in use`
  (candidate never started) — a transient port clash, not the code; production stayed on `882c9bee`
  and a plain retry succeeded.** An in-image `node -e require(...)` probe hit
  `Cannot find module '@connect/shared/webrtcIncidentAlerts'` — an artifact of bypassing tsconfig
  `paths`, not a boot defect (prod already loads that file). ✅ **Portal DEPLOYED** (container
  `.build-commit` `93b81e81` ⊇ `0f17fe1a`); "Prepare a Yealink for delivery" is in the shipped
  `settings/desk-phones` page chunk — hidden in the UI because capabilities answers `enabled:false`.
  ⏳ Nobody has opened the managed mode in a browser (it cannot show until enabled).
