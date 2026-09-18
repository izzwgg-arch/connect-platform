# 2026-09-18 · CUSTOMER COST BREAKDOWN — office-only "What this customer cost us" on every invoice — ✅ BUILT + DEPLOYED (api+portal `6d0fa490`), VoIP.ms feed LIVE

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

## What is live (container-verified 2026-09-18 ~20:10Z)
- **api `6d0fa490`** (`app-api-1` `.build-commit` = 6d0fa490, healthy, migration
  `20260918200000_customer_cost_breakdown` APPLIED by the deploy, `/admin/billing/cost/rates`
  answers 401 unauthenticated and 200 as SUPER_ADMIN inside the container).
- **portal `6d0fa490`** (`app-portal-1` `.build-commit` = 6d0fa490; the shipped chunks carry
  "What this customer cost us" (shared chunk 3531 + customer + cost pages) and "What the carriers
  charge us" (catalog page); `/admin/billing/invoice/x` and `/admin/billing/customer/x/cost` 200).
- **The VoIP.ms feed is PULLING**: boot run (last 14 days) + a hand backfill of Aug 3 – Sep 3
  through `POST /admin/billing/cost/sync`; 17,566 carrier records on file mid-pull, ~800/day,
  ~25 s per day. It runs by itself every 6 h (`CARRIER_COST_SYNC_DISABLED=1` to stop).
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
  inside each test. 13/13 green, registered in the api `test` script.
- ⛔ The shared work tree had other sessions' uncommitted edits + the remote had moved: this was
  committed via a private index on the remote tip with `git merge-file` for `schema.prisma` and
  `server.ts` (both appended at EOF — conflict resolved keeping both, `YcPipelineState` +
  the three cost models).

## ⏳ Not proven
- ⏳ Izzy has not opened the card in a browser. ⏳ The Aug 3 – Sep 3 backfill was still running
  at handoff time — check `GET /admin/billing/cost/sync` (cursor + earliest/latest) or the
  Catalog card; the Gesheft Aug 3 – Sep 3 breakdown is the acceptance check.
- ⏳ `getSMS`/`getMMS` `limit=100000` on a busy day; Telocall's real billing increment.
- Not built: Telnyx feed (rates exist as placeholders), "services we run" (transcription /
  TTS / storage), a Margin column on the customer LIST.
