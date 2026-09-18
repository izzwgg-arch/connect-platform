# AGENT HANDOFF — the office-only "What this customer cost us" card (2026-09-18)

Izzy, 2026-09-18: *"In billing, for each customer in their invoice (and that's only for
office view), the customer should not see this. I want to see how many minutes they used
(inbound and outbound) and how much they cost me that month on inbound and outbound
messages, call ID, and everything we're being charged for that customer. It should be
broken down: how much we paid. Show me mockups before you build."* → mockups →
*"talocall 00.06 / for voip.ms, you can see everything through their API"* → *"And
approved, go."*

Mockups (approved): https://claude.ai/artifact/BMtViAYuCsesLP9gNCYLVx ·
repo copy `docs/mockups/customer-cost-breakdown/v1/`.
Build commits on `feat/ivr-migration-takeover`: **`6d0fa490`** (build) · `8fad6359` (hybrid per-day coverage: uncovered days fall back to our tables, line says the split) · `57d9c7b9` (E911SETUP recurs monthly → E911_MONTHLY; English labels; PayPal top-ups skipped). Deployed: portal 6d0fa490, api 57d9c7b9.

---

## 1. What exists now

### Data (additive migration `20260918200000_customer_cost_breakdown`)
| model | what |
|---|---|
| `CarrierRate` | a typed rate, versioned by insertion (`key`, `rate` Decimal(14,6) dollars/unit, `effectiveFrom`, `source` TYPED/FEED). The row with the latest `effectiveFrom ≤ period end` wins; no row → the default in `carrierRates.ts`. |
| `CarrierUsageRecord` | ONE row per thing a carrier charged us for, pulled from the carrier's own API. Unique on (`carrier`,`kind`,`externalId`) → every re-pull is a no-op. `kind` ∈ CALL_IN, CALL_OUT, SMS_IN/OUT, MMS_IN/OUT, CNAM_LOOKUP, DID_MONTHLY, E911_MONTHLY, CNAM_DAILY, OTHER. `tenantId` resolved from `numberE164` at ingest (and re-resolved for null rows each sync). |
| `CarrierSyncCursor` | `voipms:<accountId>` → last fully-pulled UTC day, last run, last error. |

### api — `apps/api/src/billing/cost/`
- **`voipmsFeed.ts`** — the VoIP.ms feed. Built on the LIVE response shapes (probed
  read-only inside `app-api-1` on 2026-09-18, scripts were `/tmp/voipms-probe*.ts`,
  removed from the container after):
  - `getCDR` row: `total` = per-call cost, `seconds`, `rate`, `destination` (the DID
    on inbound), `callerid` (`"NAME" <digits>` — the DID on outbound), `account`
    (`344022` main on inbound, `344022_<sub>` on outbound), `destination_type`
    (`IN:USA` / `IN:TOLLFREE` / `OUT:USA` / `OUT:INTL`), and **`call_logs`**, which
    names **`Routing to sub-account: 344022_gesheft`** and **`Doing a CNAM lookup`**.
    ⛔ VoIP.ms bills in **6-second steps**: 49 s → 54 s → $0.0081 at $0.009/min.
  - `getSMS` / `getMMS` rows: `id`, `date`, `type` (`1` received / `0` sent), `did`,
    `contact`, `message`. Different id spaces. **No cost field** → priced at the rate.
  - `getTransactionHistory` rows: `type` `DID8452136776` (−1.10 "Frais mensuel de
    DID"), `E911 8452136776` (−1.50), and a daily aggregate `CNAM Queries` with
    `date: "2026-09-17 to 2026-09-17"`, `uniqueid: "n/a"`, `ammount` (sic).
  - ✅ **Reconciliation proof:** 2026-09-17 CNAM Queries = −$4.1520 and 519 CDR rows
    carried "Doing a CNAM lookup" → 519 × $0.008 = $4.152 exactly. So CNAM per tenant
    is a **carrier count**, priced at a rate the carrier's own ledger confirms.
  - ⛔ **Never stored:** message bodies, CNAM names (only `other` digits in `raw`).
    ⛔ **Never called:** `getSubAccounts` — it returns every SIP password in clear
    text (the probe printed two; they are in a tool transcript, not in any file).
    A source guard test enforces both.
  - Tenant resolution: number → tenant via `TenantSmsNumber.phoneE164` (wins) then
    `PbxTenantInboundDid.e164 → connectTenantId`. Outbound-over-VoIP.ms resolves by
    the caller-ID number the same way.
  - All calls pass `timezone: "0"` (getCDR honours it; the others ignore unknown
    params) and dates are parsed as UTC; days are UTC days.
- **`costBreakdown.ts`** — one breakdown per (tenant, period). Tiers on every line:
  `CARRIER_CDR` (carrier-priced) · `CARRIER_COUNT` (carrier count × rate) ·
  `OUR_COUNT` (our log × rate) · `ESTIMATED` (unused in v1).
  - Inbound = feed CALL_IN (`total`). Outbound = **our `ConnectCdr` outgoing talkSec →
    6-second-step minutes × Telocall rate**, MINUS the minutes the feed shows fell to
    the VoIP.ms backup trunk (those are in both logs; the carrier prices them).
  - Texts/MMS = feed counts × rate. CNAM = feed CNAM_LOOKUP count × rate. Numbers/911 =
    DID_MONTHLY/E911_MONTHLY transactions in the period. OTHER transactions naming one of
    the tenant's numbers → "One-time / other".
  - ⛔ **Coverage is PER DAY** (`8fad6359`): a day with no VoIP.ms row (any tenant) is
    uncovered → that day's inbound/CNAM/texts come from `ConnectCdr` /
    `ConnectChatMessage` (SMS threads); any uncovered day drops the line to `OUR_COUNT`
    with "N of M days from the carrier's records"; `feed.complete=false` and the UI says so.
    A covered day NEVER double-counts our own copy of the call.
  - Feed coverage is probed one `take:1` query per day — never load a month of rows
    to learn coverage.
- **`carrierRates.ts`** — defaults + `loadRates(db, asOf)` + `saveTypedRate`.
  Defaults: voipms.inbound_min 0.009 · voipms.outbound_min 0.01 · **telocall.outbound_min
  0.006 (Izzy)** · telnyx.inbound_min 0.0035 · voipms.sms 0.0075 · voipms.mms 0.02 ·
  telnyx.sms_out 0.004 · voipms.cnam_lookup 0.008 · voipms.did_monthly 1.10 ·
  voipms.e911_monthly 1.50 · telnyx.did_monthly 1.00 · telnyx.e911_monthly 1.00 ·
  telnyx.tendlc_monthly 1.50. ⛔ Telnyx keys are placeholders — no Telnyx feed exists yet.
- **`costRoutes.ts`** (registered inside `registerBillingRoutes`, same
  `requirePlatformBilling` = SUPER_ADMIN gate):
  `GET /admin/billing/cost/invoices/:id` · `GET /admin/billing/cost/tenants/:tenantId?invoiceId=|from=&to=` ·
  `GET …/tenants/:tenantId/months?limit=` · `GET|PUT /admin/billing/cost/rates` ·
  `GET|POST /admin/billing/cost/sync` (POST `{from,to}` ≤ 62 days, runs inline).
- **`costSyncBoot.ts`** — boot run after 90 s, then every 6 h; window = cursor−2 days →
  today, or the last 14 days with no cursor. `CARRIER_COST_SYNC_DISABLED=1` stops it.
  Wired in `server.ts` right after `startServiceInterruptionSweep`.
- Tests: `apps/api/src/billing/cost/*.test.ts` (13; registered in the api `test`
  script). CJS runner → no top-level await in tests.

### portal
- `_new/CostCard.tsx` — `CustomerCostCard` on **`/admin/billing/invoice/[id]`** under
  "What they are being charged for". 403 → renders nothing.
- `customer/[tenantId]/cost/page.tsx` — by number / by day / where the money went /
  every line. Under `/admin/billing/customer`, already in `REBUILT`.
- `_new/CarrierRatesCard.tsx` on **Catalog** — typed rates (versioned) + "Pull from
  VoIP.ms" date range + feed status.
- `_new/CostMonthsCard.tsx` on the **customer page** (top of the left column).
- No new sidebar page → no navConfig / toggle change (FOURTH RULE not triggered).

## 2. Blast radius checked
- `registerBillingRoutes` gained one call; `requirePlatformBilling` unchanged.
- `server.ts` gained one timer (unref'd, shutdown-registered). Nothing else touched.
- `billing/pdf.ts`, `emailTemplates.ts`, `billingEmailLifecycle.ts`, public pay routes,
  tenant `/billing` routes: **not touched, not imported** (guard test).
- The VoIP.ms calls are all GET/read-only; the feed adds ~4 API calls per day per run.
- `apps/api/package.json` test line: my glob added; the same line also carried another
  session's uncommitted escape fix (`\"` vs `\\\"` on the yiddishCorpus glob) — it
  rode along in the commit.

## 3. Proven on real data
Gesheft Aug 5 – Sep 3 (CC-202608-00002): feed complete, cost $169.78 on $450.41 → 62.2% margin;
inbound $78.72 carrier-priced, Telocall $30.94, backup $0.16, texting $11.06, CNAM 4,949 =
$39.59, numbers/911 $9.30. Read via `GET /admin/billing/cost/tenants/<id>?from=2026-08-05&to=2026-09-03`
as SUPER_ADMIN inside the container (token recipe: `/tmp/cost-sync.js` on loopcom, same
HS256-from-JWT_SECRET trick as the October projection).

## 3b. ⏳ Not proven / open
- ⏳ The card opened in a browser by a human (the api answers were verified in-container).
- 4 VoIP.ms DIDs carry cost but map to no Connect tenant (845-213-6776, 845-288-2286,
  845-287-0706, 845-248-9567) — an "unattributed carrier cost" view would surface them.
- ⏳ Whether `getSMS`/`getMMS` honour `limit=100000` for a busy day (the probe used 5).
- ⏳ Telocall's billing increment (6 s assumed; the line says so).
- Telnyx feed (for numbers that land there after porting) — rates exist, no puller.
- "Services we run" (transcription/TTS/storage) — not in v1; Izzy did not pick them.
