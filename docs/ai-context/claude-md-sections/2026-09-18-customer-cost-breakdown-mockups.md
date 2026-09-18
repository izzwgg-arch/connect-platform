# 2026-09-18 · CUSTOMER COST BREAKDOWN (office-only "what this customer cost us" on their invoice) — MOCKUPS ONLY, nothing built

Izzy, 2026-09-18: *"In billing, for each customer in their invoice (and that's only for
office view), the customer should not see this. I want to see how many minutes they used
(inbound and outbound) and how much they cost me that month on inbound and outbound
messages, call ID, and everything we're being charged for that customer. It should be
broken down: how much we paid. Show me mockups before you build."*

**Mockups: https://claude.ai/artifact/BMtViAYuCsesLP9gNCYLVx** (Design canvas, 5 boards).
Repo copy: `docs/mockups/customer-cost-breakdown/v1/` (+ `gen-mockups-v1.py`, the generator).
⏳ **Awaiting Izzy's approval. NOTHING is built, no schema, no route, no page.**

## What the mockups show
1. **Invoice page** (`/admin/billing/invoice/[id]`, light + dark) gains ONE card below "What they
   are being charged for": **"What this customer cost us"** — `Office only` pill, tiles
   (they paid / it cost us / margin; inbound min / outbound min / texts / caller-ID lookups),
   then a grouped table: Calls · Texting · Caller ID · Numbers & 911 · Services we run ·
   One-time. Columns: what · quantity · rate · carrier · our cost · **How we know**.
2. **Drill-down** "By number and by day" (per DID incl. the shared 0001 trunk; daily bars;
   share-of-cost list).
3. **Catalog → Carrier rates**: the one place for every rate the card multiplies by
   (versioned; feed overrides typed).
4. **Customer page**: month-by-month paid / cost / margin, 6 closed months + running one.

## The facts underneath (read before building)
- **Volumes in the mockup are Gesheft's REAL Aug 3 – Sep 3 numbers** (read-only query on
  `ConnectCdr` + `ConnectChatMessage`): 5,022 answered inbound calls / 11,036 billed min;
  6,031 outbound / 8,759 min; 246 internal; 770 SMS in + 10 MMS in + 3 out; 5,375 of
  5,692 inbound calls carried a CNAM name. **Rates + service costs are ILLUSTRATIVE.**
- ⛔ **`ConnectCdr` has NO cost field**, and NOTHING pulls carrier CDR costs today: no
  VoIP.ms `getCDR` call exists anywhere in `apps/api`; Telnyx `/detail_records` is wrapped
  (`telnyxClient.ts` `cost`) but only used as call proof.
- ⛔ **Outbound is the shared Telocall "0001" trunk on EVERY tenant** (trunk 72;
  `AGENT_HANDOFF_OUTBOUND_0001_PRIMARY_2026-08-20.md`) — one carrier account for all
  customers, and **Telocall has no known API**. So outbound cost per customer can only be
  our minutes × a rate Izzy types (or a Telocall export matched by caller ID). The mockup
  says so on the line ("Our minutes × rate") — do not fake it as a carrier figure.
- **Three honesty tiers** on every row, by design: `Carrier CDR` (carrier's own per-call
  record) · `Our minutes × rate` · `Estimated` (we metered, priced at list).
- **Inbound** is per-tenant: VoIP.ms subaccount DID (per-minute), moving to Telnyx as
  numbers port (Gesheft FOC Sep 22). VoIP.ms CDR has per-call `total`; Telnyx has `cost`.
- **CNAM lookups are the surprise**: at VoIP.ms list $0.008/lookup, Gesheft's 5,375 named
  inbound calls ≈ $43/mo — more than texting + numbers together. Whether VoIP.ms actually
  bills a lookup per call on these DIDs is ⏳ unverified — check the account's DID CNAM
  setting + a real VoIP.ms invoice before trusting the tile.
- Customer-facing surfaces must NEVER carry it: not `billing/pdf.ts`, not
  `emailTemplates.ts`, not the tenant `/billing` pages. Gate = platform staff
  (`SUPER_ADMIN`/`PLATFORM_ONLY`), same gate as the rest of `/admin/billing`.
- If built: new screen under `/admin/billing` → add to `REBUILT` in `layout.tsx`
  (`2026-08-07-billing-4-live-bugs-fixed-screens-rebuilt.md`); a new sidebar page needs
  its toggles (FOURTH RULE) — the cost card itself is a card on an existing page, so no
  new nav id unless the drill-down becomes its own route.

## Open questions for Izzy (answer = build scope)
1. Telocall rate per minute (and whether they can export CDRs) — decides whether
   outbound is ever more than an estimate.
2. Does VoIP.ms bill CNAM lookups on our DIDs? (check the account) — decides if that
   tile exists.
3. Which "services we run" lines matter (transcription / TTS / storage / pay-line share)
   or carrier-only for v1.
4. Advance-billed invoices: card shows the invoice's service period as "running" until it
   closes (mockup 4 shows this). OK?
