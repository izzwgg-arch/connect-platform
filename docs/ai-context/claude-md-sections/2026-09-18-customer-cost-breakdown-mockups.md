# 2026-09-18 · CUSTOMER COST BREAKDOWN — office-only "What this customer cost us" on every invoice — ✅ BUILT + DEPLOYED (portal `6d0fa490`, api `57d9c7b9`), VoIP.ms feed LIVE + Aug 3 → today backfilled, PROVEN on Gesheft's closed period

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CUSTOMER_COST_BREAKDOWN_2026-09-18.md`** — read it
before touching anything under `apps/api/src/billing/cost/` or the cost cards in the portal.

Izzy, 2026-09-18: *"In billing, for each customer in their invoice (and that's only for
office view), the customer should not see this. I want to see how many minutes they used
(inbound and outbound) and how much they cost me that month on inbound and outbound
messages, call ID, and everything we're being charged for that customer. It should be
broken down: how much we paid. Show me mockups before you build."* → mockups
(https://claude.ai/artifact/BMtViAYuCsesLP9gNCYLVx, repo copy
`docs/mockups/customer-cost-breakdown/v1/`) → *"talocall 00.06 / for voip.ms, you can see
everything through their API"* → *"And approved, go."*

## ✅ PROVEN on real data (deployed api, 2026-09-18 20:40Z) — Gesheft, closed period Aug 5 – Sep 3 (invoice CC-202608-00002, $450.41)
Feed complete for every day. **Cost to us $169.78 → margin $280.06 (62.2%).** Inbound 8,529 min /
5,206 calls **$78.72** (carrier-priced) · outbound 5,157 min over Telocall **$30.94** (our minutes × $0.006)
+ 15 min on the VoIP.ms backup $0.16 · texts 570 in / 433 out + 165/12 pictures **$11.06** ·
**CNAM lookups 4,949 = $39.59 (23% of their cost, 96% of inbound calls named)** · numbers 3 × $1.10 +
911 4 × $1.50 = $9.30. The running Sep 3 – Oct 3 period reads $120.84 so far (73% margin). July
(feed starts Aug 3) is hybrid: uncovered days from our own log, lines say "N of M days from the carrier".
Census after backfill: 34,478 carrier records; 4 VoIP.ms DIDs carry cost but belong to NO Connect
tenant (845-213-6776, 845-288-2286, 845-287-0706, 845-248-9567) — nobody's card shows them yet.

## What is live (container-verified 2026-09-18 ~20:40Z)
- **api `57d9c7b9`** (`app-api-1` `.build-commit` = 57d9c7b9, healthy, migration
  `20260918200000_customer_cost_breakdown` APPLIED by the deploy, `/admin/billing/cost/rates`
  answers 401 unauthenticated and 200 as SUPER_ADMIN inside the container).
- **portal `6d0fa490`** (`app-portal-1` `.build-commit` = 6d0fa490; the shipped chunks carry
  "What this customer cost us" (shared chunk 3531 + customer + cost pages) and "What the carriers
  charge us" (catalog page); `/admin/billing/invoice/x` and `/admin/billing/customer/x/cost` 200).
- **The VoIP.ms feed is LIVE and backfilled Aug 3 → Sep 18** (boot run + hand backfills through
  `POST /admin/billing/cost/sync`; ~800 records/day, ~25 s per day; cursor at Sep 18). It runs by
  itself every 6 h (`CARRIER_COST_SYNC_DISABLED=1` to stop). ⛔ A deploy restarts the api and
  kills a pull in flight — re-run the range, it is idempotent.
- Where: invoice page card (under "What they are being charged for") · drill-down
  `/admin/billing/customer/[tenantId]/cost?invoiceId=…` · Catalog "What the carriers charge us"
  (typed rates + "Pull from VoIP.ms" date range) · customer page "month by month".

## The facts that shaped it (⛔ read before changing)
- ⛔ **Outbound = the shared Telocall 0001 trunk, no API** → ALWAYS our `ConnectCdr` minutes ×
  the typed Telocall rate (**$0.006/min, Izzy 2026-09-18 — "00.06" read as six-tenths of a
  cent; if he meant 6¢, type 0.06 in Catalog**), 6-second steps assumed. Minutes the feed shows
  fell to the VoIP.ms backup trunk are taken out of the Telocall pool (they are in both logs).
- ✅ **VoIP.ms gives everything per call**: `getCDR.total` is the cost; `call_logs` names the
  sub-account AND "Doing a CNAM lookup" → CNAM lookups are a carrier count per tenant, and the
  daily "CNAM Queries" transaction reconciles EXACTLY (519 × $0.008 = $4.152 on 09-17).
  VoIP.ms bills calls in **6-second steps** (49 s → 54 s). DID $1.10/mo + E911 $1.50/mo come
  from `getTransactionHistory` (type `DID<number>` / `E911 <number>`, field `ammount` sic).
  SMS/MMS rows carry no cost → count × list rate (0.0075 / 0.02).
- ⛔ **Never store a message body or a CNAM name; NEVER call `getSubAccounts`** (it returns every
  SIP password in clear text). Guard test in `costBreakdown.test.ts`.
- **Honesty tiers on every line**: Carrier record · Carrier count × rate · Our count × rate. With
  NO feed rows on any day of a period, calls/texts/CNAM fall back to our own tables and say so.
- **Gate** = `requirePlatformBilling` (SUPER_ADMIN), same as all of `/admin/billing`; the card
  renders nothing on 403; `billing/pdf.ts`, email templates, public pay and tenant `/billing` are
  not imported (guard test). No new sidebar page → no toggle work.
- ⛔ Tests are CJS (`node --test` + tsx): no top-level `await` in test files; use `await import`
  inside each test. 14/14 green, registered in the api `test` script.
- ⛔ The shared work tree had other sessions' uncommitted edits + the remote had moved: this was
  committed via a private index on the remote tip with `git merge-file` for `schema.prisma` and
  `server.ts` (both appended at EOF — conflict resolved keeping both, `YcPipelineState` +
  the three cost models).

## ⏳ Not proven
- ⏳ Izzy has not opened the card in a browser (the numbers above came through the deployed api
  as SUPER_ADMIN from inside the container).
- One-off SQL on the live DB after `57d9c7b9`: 44 stored E911SETUP rows reclassified to
  E911_MONTHLY, 172 French fee labels → English, 21 PayPal top-up rows deleted, 210 rows given
  their tenant — all inside `CarrierUsageRecord`, nothing else touched.
- ⏳ `getSMS`/`getMMS` `limit=100000` on a busy day; Telocall's real billing increment.
- Not built: Telnyx feed (rates exist as placeholders), "services we run" (transcription /
  TTS / storage), a Margin column on the customer LIST.
