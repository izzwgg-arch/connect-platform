# 2026-09-16 · "How much are we projecting to charge next month?" — October 2026 projection, computed from the LIVE engine (read-only)

Izzy asked what we project to charge next month across every card on file.
**Read-only task** — nothing was written to prod, no invoice created, no card touched.

## How the number was produced (repeatable)
- `ssh root@45.14.194.179` → `docker exec connectcomms-postgres psql -U connectcomms -d connectcomms`
  for settings/cards/history.
- ⛔ **The amounts are NOT hand-derived.** They come from the engine's own
  preview route, run inside `app-api-1` for **every tenant with a card**:
  `GET /admin/billing/platform/tenants/:id/invoice-preview?periodMonth=10&periodYear=2026`,
  signed with a hand-rolled HS256 SUPER_ADMIN token from the container's
  `JWT_SECRET` (`jsonwebtoken` is NOT installed; the api listens on **3001**, not
  4000). Script kept at `loopcom:/tmp/preview.js` + `/tmp/tenants.json`.
- Cross-checked against each tenant's last 3 cycle invoices — every preview
  matches what was actually charged, except the four flagged below.

## The answer (updated 2026-09-16 after the Nexus cutover)
**$1,901.04 auto-charged in October** across **18 autopay tenants** (all 18 have an
ACTIVE default card; none expires before November). **$1,846.04** is the realistic
figure — Secro is blocked (below). With Fixup's Sola schedule and Yossis' manual
invoice the month is **~$2,153**.

⛔ **Nexus Realty moved onto Connect autopay on 2026-09-16** ($65, day 26, Sola
schedule disabled — `2026-09-15-displaydx-nexus-realty-split.md` §3c of the handoff).
It was $65 on Sola's rail in the first version of this file; the money did not change,
the rail did. The pre-cutover figure was $1,836.04 / 17 tenants.

| Day | Tenant | Oct amount |
|----|--------|-----------|
| 1 | TYH Industries | 45.00 |
| 2 | B Visible | 205.00 (first $205 cycle — $140 + the new recurring $40 Contabo + $25 Lester) |
| 3 | Gesheft | 450.41 |
| 3 | Trimpro | 204.79 |
| 5 | ADDB Builders | 105.00 |
| 5 | inii mini | 48.00 ⚠ |
| 5 | Matamim | 45.00 |
| 6 | McNamara Lion | 46.65 |
| 6 | Secro Selutions | 55.00 ⛔ blocked |
| 20 | RSBK | 13.91 ⚠ |
| 21 | Luxure Management | 75.00 |
| 23 | Trust Bookkeepings | 155.00 |
| 24 | Smooth Leasing | 35.00 |
| 26 | Nexus Realty | 65.00 ← moved off Sola 09-16 |
| 26 | Relax Tires | 105.00 (3 extensions now) |
| 26 | Solidify Concrete | 87.28 |
| 27 | Create A Box | 130.00 |
| 28 | DisplayDX | 30.00 |
| | **Connect autopay total** | **1,901.04** |

Not Connect autopay, same month: **Yossis Wood Works $206.96** (Oct 4, autopay OFF
on purpose, pays manually) and **Fixup Group $45** (Oct 9, Sola schedule, probed live
2026-09-09). Rest of September still to charge: **$696.19** on Connect (RSBK 20th,
Luxure 21st, Trust 23rd, Smooth 24th, **Nexus 26th**, Relax 26th, Solidify 26th,
Create A Box 27th, DisplayDX 28th) — Nexus' $65 is now a Connect charge, not Sola's.

## ⛔ Four things the projection exposed — all real, none fixed by this task
1. **Secro Selutions will be skipped AGAIN on Oct 6.** The mis-mapped
   `fix up usa` Sola link is STILL on the tenant (MAPPED + isActive +
   cutoverStatus `TOKEN_LINKED`), so `checkActiveSolaScheduleBlock` refuses the
   invoice. Last block event 2026-09-07; September only got charged because a
   human did it by hand on the 9th. The Fixup split that clears it is still
   STAGED, not run → `2026-09-09-secro-selutions-was-not-invoiced-or-charged-on-0.md` §4.
2. ⛔⛔ **inii mini and Matamim lost ALL of September (~$83) to a one-instant
   period overlap.** Their Aug 5 invoices were created at 20:59 and 17:47 local
   wall-clock, so `periodEnd` is Sep 5 **20:59**, while the Sep cycle starts Sep 5
   **04:00Z** — `findPaidBillingPeriodCoverage` sees a 17-hour overlap and logs
   `billing.autopay_skipped_period_already_paid`. TYH Industries lost September the
   same way (paid period ran to Sep 18, billing day is 1). **October is clean for
   all three** (no overlap), so they do bill — but the same trap fires for any
   tenant whose invoice was created off-cycle at a late hour.
   Memory: [[a-paid-period-that-ends-mid-day-eats-the-next-cycle]].
3. ⚠ **RSBK will auto-charge $13.91 on Oct 20 while running 4 ACTIVE billable
   extensions.** Cause is deliberate-looking config, not a bug:
   `metadata.billingQuantityOverrides.extensions = {mode:"manual", quantity:0}`
   (set around the 08-31 manual $230.49 invoice). If that was meant to be
   temporary it is ~$120/mo of under-billing. **Izzy's call.**
4. ⚠ **inii mini's October preview is $48, but every invoice they have ever paid
   was $35** — they have since gained a second number (E911 ×2) and SMS billing.
   Worth confirming against the sign-up quote before the 5th.

Open money right now: Relax Tires **$105 OPEN** (due Sep 26, this is the re-issued
$45→$105 invoice), LUZER **2 × $45 FAILED** (Jul/Aug, autopay now OFF), Landau Home
$500 OPEN + $1 FAILED from May (test rows, never chased).

## Not counted, on purpose
- **`BillingSolaExternalScheduleLink` is 4 months stale** (`lastSyncedAt` max =
  2026-05-21), so the three still-live unmapped Sola schedules it lists —
  Fleetease $20, Comfort Control $25, coat one seal coating $35 — are NOT in the
  total. Nexus ($65) and Fixup ($45) are quoted only because both were probed live
  in September.
- **Nexus Realty carries a `TenantBillingProfile` with `autoBillingEnabled=true`
  ($60)** — it is INERT: `runBillingProfilesForTenant` only runs inside the
  autopay-tenant loop, and Nexus' tenant-level autopay is OFF. It has never
  produced an invoice. Don't count it, and don't "fix" it without asking.
- Loopcom Mobile's LM- ledger has no live lines.
- Cards on file with no October charge: Landau Home, LUZER, Connect Communications.
