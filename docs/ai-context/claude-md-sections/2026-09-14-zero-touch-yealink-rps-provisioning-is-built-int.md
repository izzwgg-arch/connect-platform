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
- ✅ **The one-off server-creation script EXISTS now: `apps/api/scripts/yealink-rps-create-server.ts`** (handoff §7 step 2). Run from `apps/api` with the three `YEALINK_RPS_*` env values; it is idempotent (find-by-name before create, refuses a same-name/different-URL server, reads the create back) and prints `YEALINK_RPS_SERVER_ID=<id>`. Dry-run proven: with no env it refuses with exit 2. ⏳ Still to do, in order: Izzy signs in + changes the password → generates AccessKey (System → Integration → API) → run the script → set the §6 env vars in `/opt/connectcomms/env/.env.platform` → deploy api with a carrying commit → prove on a designated test Yealink on Loopcom Demo only (§7 step 4). No live RPS call has been made yet.
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
