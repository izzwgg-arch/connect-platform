# ⛔ AGENT HANDOFF — LOOPCOM MOBILE: branded mobile service on Telnyx wireless is BUILT END TO END (schema, provider client, tenant page, owner console, webhooks, sweeps) and INERT until Izzy grants the key / buys the first eSIM (2026-09-15) — READ FIRST before touching apps/api/src/loopcomMobile/, the /mobile page, or before answering "can we sell mobile service?"

Izzy's brief (via the build prompt): a complete new product, **LoopCom Mobile** —
eSIM activation, data, SMS, mobile voice where available, plans, usage, billing,
suspension, porting, self-service, admin console, fraud controls, webhooks —
"LoopCom owns the customer relationship. Telnyx is the underlying platform."
Non-negotiables honored: no invented Telnyx endpoints, no fake data, no purchase
without approval, no tenant leakage, nothing retried that costs money.

## 1. WHAT TELNYX ACTUALLY OFFERS THIS ACCOUNT — live-probed 2026-09-15, not assumed

Probe ran INSIDE app-api-1 with the stored AgentSecret key (read-only GETs only):

- ✅ **The whole wireless family answers 200 on izzy@loopcom.net (VERIFIED tier)**:
  `/sim_cards`, `/sim_card_groups`, `/sim_card_orders`, `/ota_updates`,
  `/wireless_blocklists`, `/private_wireless_gateways`,
  `/sim_card_data_usage_notifications`, `/mobile_operator_networks` (755 roaming
  networks), `/detail_records?filter[record_type]=sim_card_usage` (also
  `wireless`), **`/mobile_phone_numbers` and `/mobile_voice_connections`** —
  all enabled, all empty (0 SIMs). Balance was $8.46.
- **eSIM purchase** = `POST /actions/purchase/esims` `{amount, sim_card_group_id?,
  product:"whitelabel", whitelabel_name, status, tags}` → 202 with SIM card
  objects. ⛔ Money. **Whitelabel SPN means the handset's carrier line can read
  "LoopCom".** Activation code (QR contents) = `GET /sim_cards/{id}/activation_code`
  (eSIM only, errors once installed). Physical SIMs: `POST /sim_card_orders`
  `{address_id, quantity}` with a FREE cost preview first
  (`POST /sim_card_order_preview` → total/shipping/SIM costs).
- **SIM lifecycle** = async ACTIONS (202 + action object, poll/webhook):
  `/sim_cards/{id}/actions/enable|disable|set_standby|enable_voice|disable_voice`,
  `POST /actions/register/sim_cards` (physical, by registration codes). SIM
  object carries `status.value`, `esim_installation_status released|disabled`,
  `eid`, `msisdn`, `voice_enabled`, `current_billing_period_consumed_data`,
  `live_data_session`, `current_imei/mcc/mnc`, `data_limit`.
- ⛔ **Mobile Voice / VoLTE is BETA at Telnyx**: the endpoints exist in their
  OpenAPI spec (team-telnyx/openapi) and answer on this account
  (`/mobile_voice_connections` CRUD, `/mobile_phone_numbers` GET/PATCH with
  call_forwarding, CNAM, recording, interception app ids; `enable_voice` takes a
  Mobile Voice Connection id), **but the public docs say "API reference and
  detailed configuration docs coming soon"**. Do NOT promise cellular voice to a
  customer until a real voice-enabled SIM proves a call; the capability report
  says "beta" for exactly this reason.
- **SMS**: the messaging API is live (bench-proven) but **0 messaging profiles
  exist and no 10DLC brand/campaign is registered** — business SMS on a mobile
  DID won't deliver until that's done (same 10DLC reality as everywhere else).
- **E911**: per-number emergency addresses + dynamic-E911 API exist; ⛔ mobile/
  nomadic rules differ from fixed VoIP; test dial is 933, never 911.
- **Porting**: full API incl. LOA; wireless ports need the losing carrier's
  account number + transfer PIN (customer-supplied).

## 2. WHAT WAS BUILT (all committed this task)

**Prisma** (`packages/db/prisma/schema.prisma` + migration
`20260915180000_loopcom_mobile`, PURELY ADDITIVE — 7 tables):
`MobilePlan` (LoopCom-owned pricing; `telnyxCostCentsEstimate` = margin view,
never shown to customers), `MobileLine` (tenant-scoped lifecycle:
draft → pending_activation → active ⇄ suspended/lost → terminated;
`needsReconcile`/`reconcileReason` = partial-failure flags), `MobileSim`
(mirror keyed on `telnyxSimId @unique`; **eSIM activation code stored AES-GCM
encrypted** in `activationCodeEnc`), `MobileSimOrder`, `MobilePortRequest`
(draft-first; ⛔ NO submit-to-Telnyx route exists anywhere — filing a port is an
Izzy-gated act), `MobileUsageRecord` (normalized, `@@unique([kind,
providerRecordId])` = ingest dedupe), `MobileWebhookEvent` (verbatim event
ledger, `providerEventId @unique` = exactly-once).

**API — `apps/api/src/loopcomMobile/`**:
- `telnyxWirelessClient.ts` — wireless client over the SAME transport as the
  bench (`txRequest` from ../telnyx/telnyxClient; no SDK, injectable fetch,
  ⛔ mutations never retried). All endpoint strings from the official OpenAPI
  spec; usage record_type `sim_card_usage` live-probed.
- `mobileCapabilities.ts` — probes 8 surfaces, 5-min cache, plain-English
  blockers ("beta", "unconfigured", "blocked" + why). The product grays
  features by this report instead of breaking.
- `mobilePlanMath.ts` — PURE money math: cycle recount
  (`buildMobileBillingLineItems`: proration by day, activation fee only in its
  period, suspended holds the seat, draft/terminated bill nothing, overage
  rounds UP to the cent, deterministic ⇒ a twice-run job cannot double-bill),
  spike detection (floor 1 GB, 3× trailing avg).
- `mobileService.ts` — lifecycle orchestration. `provisionEsimForLine` is the
  ONE money moment (tags eSIMs `tenant:<id>`/`line:<id>` so
  purchased-but-not-saved is auto-recovered by import); suspend/resume/lost;
  `reconcileSimsWithTelnyx` (imports unknown SIMs, confirms optimistic states,
  flips pending→active when the SIM enables).
- `mobileSyncJobs.ts` — usage sync (48h lookback, dedupe makes overlap free),
  state reconcile, anomaly sweep (⛔ detection only, NEVER auto-suspends).
  Registered in server.ts (~line 40021) per the house sweep pattern; 15-min
  default, `MOBILE_USAGE_SYNC_INTERVAL_MS=0` disables; zero-footprint fast path.
- `mobileRoutes.ts` — ⛔ **prefixes are `/mobile-service` and
  `/admin/mobile-service` because `/mobile/*` AND `/admin/mobile/*` already
  belong to the phone-app device routes** (traced before choosing). Tenant
  routes derive tenant from the JWT only (source-guarded). Owner console:
  plans CRUD, fleet search (number/ICCID/customer), create line (free),
  **provision eSIM (confirm:true required; timeout answers "unknown — reconcile,
  don't re-click")**, suspend/resume/terminate (terminate disables, never
  deletes the Telnyx SIM), change plan, diagnostics (read-only), billing
  recount preview, webhook event log, provider listings.
- `mobileWebhookRoutes.ts` — `POST /webhooks/telnyx/mobile`
  `{config:{rawBody:true}}`, **Ed25519 over `timestamp|rawBody`** with the
  publicKey stored beside the API key; FAIL CLOSED (no key/header/signature or
  stale ts ⇒ 401, no NODE_ENV escape); dedupe on event id (P2002 ⇒ "duplicate",
  200 so Telnyx stops); fold errors keep the row ("failed", dead_letter at 5)
  and still 200 — the reconcile sweep converges state. On the JWT bypass in
  jwtPublicRouteBypass.ts (both /api-prefixed and bare shapes).
  ⛔ **No webhook URL is registered AT Telnyx yet, and the publicKey field in
  AgentSecret telnyx_credentials is EMPTY (probe: publicKeySet:false)** — the
  door is built and locked; opening it = paste the portal's Public Key on
  /apps/telnyx, then set the URL on the Telnyx side.
- `mobileAudit.ts` — tenant AuditLog helper. ⛔ It deliberately does NOT set
  `provider` (IntegrationProvider enum has no telnyx member — the delivery
  helper's "delivery" literal is a live bug that makes its rows silently never
  write; flagged as a separate task).

**Portal**:
- `/mobile` (tenant, `PermissionGate can_view_workspace_mobile`): lines table
  with status/plan/cycle data, **eSIM install screen (real QR via qrcode.react
  + manual code)**, pause/resume, lost-device (confirm), plan catalog (retail
  only), port-in draft form + status list.
- `/admin/mobile-console` (owner-only like the Telnyx page): capability table,
  plans with margin column, fleet with per-line actions (provision eSIM says
  "PURCHASES 1 eSIM… cannot be un-bought" before doing it), diagnostics panel,
  webhook events, reconcile/usage-sync/re-check buttons. ConnectSelect only.
- **Toggles (the fourth rule)**: `workspace.mobile` +
  `admin.mobile_console` in BOTH `@connect/shared` SIDEBAR_ITEMS and
  navConfig navItems; console has the SUPER_ADMIN force line +
  OWNER_ONLY_FIXED_NAV_ITEMS row (Locked chip); **workspace.mobile has NO
  force line and is in NO default bucket — granting the key IS the launch**,
  the Direct/Meetings pattern. permissionToggleCoverage passes with both.

**Security controls**: tenant scoping on every query (JWT only), per-prefix
permission rules in PORTAL_API_PERMISSION_RULES (both prefixes — the
/admin/wake-health trap avoided), requireSuperAdmin on every console route,
zod on every body, activation codes encrypted at rest + returned only to the
owning tenant (the read itself is audited), no secret in any log, webhook
signature fail-closed + replay window 5 min + dedupe, money ops confirm-gated
audited never-retried.

## 3. TESTS (all green at commit time)

- `apps/api/src/loopcomMobile/loopcomMobile.test.ts` — **17 tests**: money math
  (incl. the twice-run recount identity), fake-fetch client (ONE request per
  purchase; timeout NOT re-sent), REAL Ed25519 verify (tamper/stale/wrong-key
  refuse), bypass shapes, and source guards (server wiring + both prefix
  rules, requireOwner on every console route, tenant-from-JWT, fail-closed
  webhook + rawBody, no-retry/no-console.log/no-code-leak, nav+catalog+toggle
  contract incl. "workspace.mobile has NO force line" and "key in NO default
  bucket", package.json glob). Glob `src/loopcomMobile/*.test.ts` registered.
  ⛔ Guard lesson: **stripComments on server.ts eats whole regions** (a `/*`
  inside a string literal) — the server guard matches RAW source on purpose.
- `apps/portal/navigation/loopcomMobileNav.test.ts` — 5 tests through the REAL
  `isNavItemVisibleForUser` + page-source guards (PermissionGate key, owner
  check, no native `<select>`, purchase warning text). Registered BY NAME in
  portal package.json (the glob trap).
- Portal nav suites incl. permissionToggleCoverage: 37/37 with the new rows.
- Typecheck: portal 0 errors; api 87 = 85 pre-existing ambient + **2 new of the
  SAME ambient class** (`registerShutdownTimer(setTimeout(...))` number-vs-
  Timeout — every existing sweep line has it; zero errors in loopcomMobile/*).

## 4. WHAT IS DELIBERATELY NOT DONE (and why — read before "finishing" it)

1. ⛔ **No eSIM purchased, no SIM ordered, no number attached, no port filed,
   no webhook URL registered at Telnyx.** Every one costs money or creates a
   durable provider object = Izzy's approval, per the standing rules. The
   first-line runbook is §5.
2. ⛔ **Live-invoice wiring is NOT flipped.** `buildMobileBillingLineItems` is
   built + tested and the console shows the recount preview, but nothing
   touches `invoiceEngine.ts` / `buildBillingInvoicePreview` — that is the
   money path, and the billingReconcile.ts rule (invoices RECOUNT live, no
   charge rows at provisioning) plus the blast-radius rule mean the wiring
   happens with the FIRST real customer line, as its own traced change.
   Nothing double-bills today because nothing bills at all.
3. **Mobile voice**: capability-gated "beta". `enable_voice` +
   `/mobile_voice_connections` are in the client, no UI promises calls. The
   PBX-identity convergence (one user = desk + desktop + app + cellular) is a
   design note, not built — Telnyx's mobile number PATCH takes forwarding +
   interception app ids, so the credible v1 convergence is "mobile DID
   forwards to the LoopCom line" once voice is GA.
4. **SMS on mobile lines**: needs a messaging profile + 10DLC per the ISV
   pattern (one brand per downstream business — never under Loopcom's brand).
   Not started here.
5. **Port submission**: drafts only, by design. The Telnyx porting API incl.
   LOA is documented in AGENT_HANDOFF_TELNYX_ONBOARDING §5.
6. **Physical SIM UI**: client + models exist (orders, preview, register by
   code); console buttons for it are not drawn yet (eSIM-first product).
7. The role-editor screens will show the two new toggles automatically (they
   render from navItems); ⏳ nobody has opened them since this commit.

## 5. THE FIRST REAL LINE — the exact runbook (all Izzy-gated where marked)

1. On /apps/telnyx: paste the account's **Public Key** into the credentials
   card (webhook verification needs it; probe showed publicKeySet:false).
2. In the Telnyx portal: set webhooks for wireless to
   `https://<api-host>/webhooks/telnyx/mobile` (optional for v1 — the sweeps
   converge without it).
3. On /admin/mobile-console: create the first MobilePlan (retail price is
   Izzy's call; put the Telnyx cost estimate in for the margin column).
4. Create a line for a test tenant (free), then **⛔ Provision eSIM** — the
   confirm dialog states the purchase; Telnyx bills per eSIM + monthly fee.
5. Install the eSIM from the customer page's QR on a real handset; the
   reconcile sweep (or webhook) flips the line active. **Data flowing on the
   handset + usage rows appearing = the product's first acceptance test.**
6. Voice/SMS/number-on-SIM: gated on Telnyx Mobile Voice GA + 10DLC — check
   the capability card, don't guess.

## 6. TRAPS FOR THE NEXT SESSION

- ⛔ `/mobile` and `/admin/mobile` API prefixes are the PHONE APP's. Mobile-
  service routes are `/mobile-service` + `/admin/mobile-service`.
- ⛔ Telnyx SIM actions are ASYNC 202s — never assert provider state from the
  action response; the sweep/webhook confirms (that's what needsReconcile is).
- ⛔ `filter[record_type]` for SIM usage is `sim_card_usage`; CDR voice records
  remain `sip-trunking` + field `shaken_stir` (bench-pinned).
- ⛔ The eSIM activation code is a secret (it installs the line's identity).
  It lives encrypted, the tenant read is audited, and it must never appear in
  logs, events, or admin listings (`hasActivationCode` boolean only).
- ⛔ A timeout on purchase = "unknown — reconcile first". The reconcile import
  recovers orphans via the `line:<id>` tag. Never re-click, never auto-retry.
- The capability report caches 5 min; the console's Re-check busts it.
