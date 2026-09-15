# ⛔ AGENT HANDOFF — a SECOND VoIP.ms account can be attached now (2026-09-15) — read before touching `GlobalVoipMsConfig`, the VoIP.ms DID sync, the inbound SMS poller, or any outbound VoIP.ms send

Izzy: *"Add the capability for me to attach a second voip.ms account."*

## 1. The shape — one table, one row per account, the primary keeps its old id

`GlobalVoipMsConfig` was a singleton (`id: "default"`). It is now **one row per
VoIP.ms account**:

- The **primary account stays the `"default"` row.** Every legacy consumer that
  does `findUnique({ where: { id: "default" } })` — onboarding provisioning
  (`loadMasterCreds`), the trunk guardrail, the port watchdog, billing/platform
  SMS (`resolvePlatformSmsSender`), `isCrmOutboundSmsConfigured`, the CRM/agent
  provisioning helpers, number search on sign-up — **still reads the primary and
  was deliberately NOT touched.** That is the blast-radius decision: new
  sign-ups, purchases, ports, 911, billing texts and the guardrail all stay on
  the primary account.
- **Additional accounts** are rows with a random UUID id and a `label`.
- **`TenantSmsNumber.voipmsAccountId`** (NOT NULL, default `'default'`, plain
  string — no FK on purpose) says which account owns each DID. It is **stamped
  by the DID sync**: the account whose `getDIDsInfo` returns the number owns it,
  and a number moved between VoIP.ms accounts is restamped on the next sync.

Migration: `20260915220000_voipms_second_account` (adds
`GlobalVoipMsConfig.label`, `TenantSmsNumber.voipmsAccountId` + index — purely
additive, defaults keep every existing row on the primary).

## 2. What follows the number's account now

- **Outbound chat SMS/MMS (worker, `connectChatSmsJob.ts`)** — after the
  SignalWire provider dispatch (unchanged, still first), the VoIP.ms config +
  credentials are read from `smsRow.voipmsAccountId` instead of hardcoded
  `"default"`. A never-synced from-number falls back to the primary — the exact
  pre-feature behaviour.
- **Inbound SMS poll (worker, `voipMsInboundSyncJob.ts`)** — the cycle now
  groups pollable numbers by `voipmsAccountId` and runs the same
  account-wide-getSMS-then-per-number-fallback shape **once per account, with
  that account's credentials**. ⛔ This matters because a getSMS call only sees
  the DIDs of the account whose credentials it carries — polling a
  second-account DID with primary credentials silently fetches nothing forever.
  An account with no usable credentials is skipped WITH a warn line naming it.
- **`/admin/apps/voip-ms/send-test-sms`** — resolves the account from the FROM
  number's synced row (`loadVoipMsCredsForNumber`).
- **DID sync (`/admin/apps/voip-ms/sync-numbers`)** — now loops every account
  that has credentials (or one, with `{accountId}` in the body), stamping
  `voipmsAccountId` on create AND update, updating that row's `lastDidsSyncAt`.
  Response keeps the old fields (`upserted`, `total`, …, now aggregated) plus
  `accounts: [{accountId,label,ok,upserted,total,error?}]`. All targeted
  accounts failing → 502; a partial failure returns 200 with the per-account
  error visible.

## 3. New API surface (all SUPER_ADMIN + credential-crypto-gated, in `connectChatRoutes.ts`)

- `GET  /admin/apps/voip-ms/accounts` — list (primary first) with usernameHint,
  health, last sync, per-account number counts.
- `POST /admin/apps/voip-ms/accounts` `{label, username, password, apiBaseUrl?}` — attach.
- `PUT  /admin/apps/voip-ms/accounts/:accountId` — label and/or creds
  (username+password must travel together; the primary's label is fixed).
- `POST /admin/apps/voip-ms/accounts/:accountId/test` — `validateVoipMsCredentials`
  probe, writes lastHealth* on THAT row.
- `DELETE /admin/apps/voip-ms/accounts/:accountId` — refused for the primary,
  and refused while the account still owns synced numbers
  (`canDeleteVoipMsAccount` in `voipMsAccounts.ts` is the pure, tested rule).

Helpers live in **`apps/api/src/voipMsAccounts.ts`** (`listVoipMsAccounts`,
`loadVoipMsAccountCreds`, `loadVoipMsCredsForNumber`, `createVoipMsAccount`,
`canDeleteVoipMsAccount`, `VOIPMS_PRIMARY_ACCOUNT_ID`).

## 4. Portal (`/apps/voip-ms`, existing page — no new nav entry, no new permission key)

Connection tab (super admin only): a **"VoIP.ms accounts"** panel — table of
accounts (name/username hint/number count/health/last sync) with per-account
**Test** / **Sync** / **Remove** buttons, and an **"Attach another VoIP.ms
account"** form (name, API username, API password, optional base URL). The old
credentials form is retitled **"Primary account credentials"** and unchanged.
Numbers tab: an **Account** column appears once there is more than one account.
The fourth-rule toggle audit does not apply: no new page, no new permission key
— the page stays behind `can_manage_voip_ms`.

## 5. Traps for the next agent

- ⛔ **Do NOT extend the trunk guardrail / provisioning to secondary accounts
  casually.** `voipMsTrunkGuardrail.ts` still sweeps only the primary
  (`loadMasterCreds`). If a second account ever carries PBX-trunked numbers,
  the guardrail must learn accounts FIRST or those registrations are unwatched.
  Today the second-account capability is SMS/number-inventory + routing.
- ⛔ **The VoIP.ms API is IP-allowlisted per account** — a second account must
  have API access enabled for the Connect server's IP in ITS VoIP.ms portal
  (Main Menu → SOAP and REST/JSON API) or every call answers `ip_not_enabled`.
  The page says this under the attach form.
- ⛔ The **webhook secret stays a primary-row concern** — inbound for
  second-account numbers arrives by POLL (the poller is account-aware); the
  account-wide webhook URL story is unchanged.
- ⛔ `isCrmOutboundSmsConfigured` still checks only the primary row's
  credentials. If the primary is ever unconfigured while a second account
  carries a tenant's numbers, CRM shows texting unavailable while the worker
  could actually send. Cosmetic-level wrongness; fix by checking the tenant's
  numbers' accounts if it ever bites.
- ⛔ Deleting an account row does nothing at VoIP.ms — it only removes stored
  credentials. The delete is blocked while numbers are stamped to it.

## 6. Proven / not proven

- ✅ 11 new tests (`apps/api/src/voipMsAccounts.test.ts`, covered by the
  existing `src/*.test.ts` glob — no package.json edit needed): deletion rules,
  per-number creds resolution + fallbacks, listing/counts, id-collision, and 3
  source guards (worker send follows `voipmsAccountId`; poller groups by
  account; sync stamps both create and update). **All 3 source guards fail
  replayed against pre-feature HEAD** (`VOIPMS_GUARD_ROOT` against `git show
  HEAD:` copies — the `git archive` technique, never `git stash` here).
- ✅ Existing guards updated WITHOUT weakening: worker
  `signalWireChatSend.test.ts` (dispatch-before-creds ordering now matches the
  parameterized call) and `voipMsInboundSyncJob.test.ts` (fetch-once/fallback
  invariants now asserted per account, plus two NEW assertions: grouped by
  account, per-account creds).
- ✅ Full worker suite 168/168; api SMS/chat-adjacent suites green; typecheck:
  portal 0, worker 8 (all pre-existing, none in changed files), api 87 (none in
  changed files; baseline was 84 on 09-10 and had drifted before this task).
- ⏳ **NOT PROVEN: no second account has actually been attached** — Izzy has to
  paste the second account's API credentials on `/apps/voip-ms` → Connection →
  "Attach another VoIP.ms account", enable the server IP in that account's API
  settings, then Sync. No real second-account SMS has been sent or received yet.
