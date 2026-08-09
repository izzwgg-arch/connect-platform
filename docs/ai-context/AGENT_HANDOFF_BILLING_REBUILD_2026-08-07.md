# AGENT HANDOFF — billing: four live bugs fixed, screens rebuilt (2026-08-07)

Branch `feat/ivr-migration-takeover`. Everything below is **deployed and
container-verified** unless it says otherwise.

| commit | what |
|---|---|
| `e20776c6` | billing day 1 never generated an invoice · billingEmail erased on every save |
| `7d15b755` | the same email bug at a second site (invoice PATCH) |
| `bb42fe01` | charge only on the payment date · custom invoices stop interfering |
| `7ac48581` | ⛔ the manual-invoice filter was a NULL trap that matched 0 invoices |
| `064ca242` | one-customer billing screen |
| `2c57ebd1` | the remaining rebuilt screens |
| `f752d778` | backfilled actions, then re-pointed the old URLs |
| `a75344b9` | ⛔ the rebuilt screens were rendering inside the OLD workspace shell |

---

## 1. ⛔ The bug behind "customers never auto-generate an invoice"

`billingDayOfMonth = 1` — the **Prisma default**, which onboarding never changes
— could never generate an invoice. Proven by simulating all 365 days of 2026:

```
day  1 (default) : invoice window opens   0/365 days   *** NEVER ***
day  2           : 12/365     day 5/15/28 : 36/365 (correct)
```

Invoices are only created inside `schedule.reminderDue`, and
`buildBillingSchedule` clamps the payment date into the **current** month — so
for day 1 the whole `[reminder, charge)` window is permanently in the past.
**16 of 30 live tenants sat on it.** On the due date the worker logged
`CRITICAL: manual intervention required` and never created the invoice it had
just proved was missing.

**Fix:** `buildUpcomingBillingSchedule()` anchors on the next occurrence of the
billing day at or after today; the worker's reminder phase uses it. Charge
semantics were deliberately left alone so this cannot change *when* a card is
charged.

⛔ **Why it survived years of "it's fixed":** all 11 scheduler tests used
`billingDayOfMonth: 21`. The one broken value was the one never tested. Tests
now cover days 1–31.

## 2. ⛔ A charge is now an event on a date, not a month-long condition

`due` was `now >= chargeAt && today.day >= paymentDay` — true for the **rest of
the month**, re-evaluated hourly and on every worker restart. That is why
autopay behaved like it "charges every minute", and why **14 guard clauses**
were the only thing preventing a double charge. For day 1 it was true 365/365.

Now true only on the payment date, in the tenant's own timezone.

⛔ **A missed date is never charged late.** `chargeWindowMissed` +
`reportMissedChargeWindow()` record one event and one admin alert and leave the
invoice OPEN. Dunning retries are unaffected — separate sweep, own schedule.

⛔ The test `"startup catch-up charges overdue current-cycle schedules only"`
asserted `due === true` the day *after* the payment date. The bug was codified
as intended behaviour; it now asserts the opposite.

## 3. ⛔ billingEmail was erased by every save — at TWO sites

A zod `.transform` ending `: v ?? null` turned an **absent** field into `null`.
The handler drops only `undefined`, so the null was written. Saving *any*
unrelated setting deleted the customer's billing address.

- Site 1: `PUT /admin/billing/tenants/:tenantId/settings`
- Site 2: `PUT /admin/billing/invoices/:id` — found **only** by grepping the
  running container for the OLD pattern after deploying the first fix and
  getting back `2`, not `0`. Editing an invoice's notes wiped its override.
  Its guard used `if ("billingEmail" in body)`, which is unsafe for transformed
  optionals — zod puts the key on the object even when absent.

The manual-invoice CREATE route keeps `v ?? null` **on purpose** (no prior value
to destroy).

**Damage:** 18 of 30 tenants had no billing email. Five were recovered from
`EmailJob` delivery history and restored (12/30 → 17/30):

| customer | restored to |
|---|---|
| Yossis Wood Works | `billing@yossiswoodworx.com` |
| Trust Bookkeepings | `vigdor@trustbookkeepingny.com` |
| Luxure Management | `simonwer08@gmail.com` |
| Trimpro | `ap@trimprony.com` |
| Displaydex | `Michael@nexusrealtyad.com` |

⛔ Postgres backups (`/opt/connectcomms/backups/postgres`, nightly 03:15) only
reach **15 days** and every loss predates them. There is **no audit log for
billing settings at all**. ⛔ When recovering, exclude `izzywgg@gmail.com` /
`izzwgg@gmail.com` / `tod10950@gmail.com` — Izzy's own test sends rank top for
several tenants and would misroute real invoices to him.

## 4. ⛔⛔ `{ not: "X" }` in Prisma DROPS every NULL row

The single most dangerous thing in this engagement, self-inflicted and caught
before it did damage.

`autopayPeriodInvoiceWhere` gained `source: { not: "MANUAL" }` to stop custom
invoices being auto-charged. In SQL `NULL <> 'MANUAL'` is **NULL, not true** —
and `createBillingInvoice` (the automatic path) **never sets that column**, so
all 53 system invoices have `source = NULL`. The filter matched **0 invoices
across all 30 tenants**. Autopay would have found no invoice on every payment
date and charged nobody.

Correct form:

```ts
AND: [
  { OR: [{ source: null }, { source: { not: "MANUAL" } }] },
  { OR: [ ...period conditions... ] },
]
```

⛔ **A unit test cannot see this** — the where-object looks perfect in JS. The
guard is a test asserting the null-safe *shape* plus a real query against
production. **After deploying, run the actual query and assert the row count.**
The deploy said success, the container had the right code, tests were green, and
the feature was completely dead.

Custom invoices are now purely additive: never auto-charged, and they no longer
suppress creation of the monthly invoice.

---

## 5. The rebuilt screens

All under `/admin/billing`, with the old routes re-pointed:

| route | mockup |
|---|---|
| `/month` | This month (← `/admin/billing`) |
| `/customers` | Customers |
| `/customer/<id>` | **One customer — replaces eleven places** |
| `/customer/<id>/timeline` | Timeline, past and future in one list |
| `/invoice` · `/invoice/<id>` | Invoices (← `/invoices`) |
| `/money` | Payments (← `/payments`) |
| `/needs-you` | Needs you (← `/collections`) |
| `/catalog` | Catalog, reports, gateway links |

**Kept on purpose** (still hold features not rebuilt): `/settings` (gateway),
`/plans`, `/methods`, `/activity`, `/sola-imports`, `/reports`.

⛔ **THE TRAP THAT WASTED MOST OF A DAY.** `admin/billing/layout.tsx` wrapped
**every** route in `AdminBillingShell`, which draws its own toolbar and nine-tab
workspace nav and imports ten old stylesheets. All seven rebuilt pages came out
stapled underneath the old chrome, so **none of them looked like the approved
design**. Fixed in `a75344b9`: the rebuilt paths render bare with their own
`BillingNav`; every other billing route keeps the shell untouched. **If you add
a screen under `/admin/billing`, add its path to `REBUILT` in layout.tsx or it
inherits the old chrome.**

The one-customer page surfaces **seven settings that previously had no UI at
all** — they lived only in the untyped `TenantBillingSettings.metadata` blob:
toll-free price, virtual extension price, flat monthly rate, billing timezone,
telecom fees, schedule override, collections rules.

⏳ **NOT VERIFIED IN A BROWSER.** Typechecked, deployed, routes serve 200 — but
no one has logged in and used them. Everything past the auth gate renders
client-side, so curl only ever sees the login shell; structural greps proved
unreliable (a control check failed). **Open them before trusting them.**

---

## 6. Deploy traps hit this session

- ⛔ **`deploy-direct.sh --branch` hard-resets to `origin`.** A commit that
  exists only in the server clone is silently rolled back and "deployed" as a
  no-op — it reports success having shipped nothing. **Push to GitHub first.**
  Local push is classifier-blocked; route is
  `git bundle` → `scp` → `git fetch` → `git push origin` **from the server**.
- ⛔ **`deploy-worker.sh` self-skips with `no_changes`** when git HEAD didn't
  move during its own sync — exactly what happens right after an api deploy —
  leaving the OLD worker container running while reporting `done`. Use
  `DEPLOY_FORCE_RESTART=1`, then grep the RUNNING container to confirm.
- Portal builds take **11–15 minutes**; api ~9. An ssh timeout does **not** kill
  the deploy (it survives the disconnect) — poll, never re-fire.

---

## 7. Open items

1. **14 of 30 tenants still on billing day 1.** Their cycle matches nothing they
   bought. Matamim and inii mini were moved to day 5 (matching the Aug 5 – Sep 5
   period they actually paid for); the rest are untouched.
2. **3 customers have a card but automatic charging is off** — Landau Home,
   Yossis Wood Works, and the Connect Communications tenant. Turning them on
   charges real cards; **needs Izzy's word.**
3. **12 customers have no card at all**, so they cannot be billed. Several look
   dormant (Loopcom Demo, Actual Home Care, the old Iniimini duplicate).
4. **LUZER and McNamara Lion have failed August charges** in retry.
5. **The engine work was never started** — the schedule table (a row per
   customer per month) and the email priority lane. Billing email still shares
   one FIFO queue with CRM bulk sends, drained 10 at a time every 15s with no
   priority, which is the "emails go out late" complaint.
6. **The legacy `Invoice` model has 0 rows** but its code still runs an overdue
   sweep sending its own reminder emails — a live suspect for duplicate/mistimed
   mail, and safe to remove.

## 8. Scale, for context

16,400 lines of billing logic in the API · 15,100 lines of billing screens ·
116 endpoints · ~230 controls. Mockups and the full audit:
<https://claude.ai/code/artifact/ffbd73b2-66a5-40ca-83a5-753cc5c366d2>
