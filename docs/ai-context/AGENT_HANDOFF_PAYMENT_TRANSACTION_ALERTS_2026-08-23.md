# AGENT HANDOFF — Izzy is emailed on every settled payment (2026-08-23)

**Commit `4eed014c` on `feat/ivr-migration-takeover`.** api + one migration.
No PBX write, no env change, no portal change, no tenant row, no customer email
changed.

Izzy, 2026-08-23: *"Every time there is a successful transaction, I should get
an email to Izzy@loopcom.net, same every time there is a declined transaction."*

---

## 1. What was built

`apps/api/src/billing/paymentTransactionAlerts.ts` — a sweep that watches
`PaymentTransaction` and queues one email to **izzy@loopcom.net** for every row
that reaches a settled status.

- **Type `PAYMENT_TRANSACTION_ALERT`.** ⛔ Never `ADMIN_ALERT` — that category is
  muted at the send door (`server.ts`, `ALERTS_MUTED`) and would build clean, log
  clean and reach nobody. A guard test asserts the constant is not that string
  and that the module never mentions it in executable code.
- Recipient, tenant, cutover, lookback and cadence are all env-overridable:
  `PAYMENT_ALERT_EMAIL`, `PAYMENT_ALERT_TENANT_ID`, `PAYMENT_ALERT_CUTOVER_AT`,
  `PAYMENT_ALERT_LOOKBACK_MS`, `PAYMENT_ALERT_SWEEP_INTERVAL_MS`,
  `PAYMENT_ALERT_BOOT_DELAY_MS`. Kill switch:
  **`PAYMENT_TRANSACTION_ALERTS_DISABLED=1`** (env edit + api restart, no rebuild).
- Boot line **`PAYMENT_TRANSACTION_ALERTS_ARMED`** carries the interval, the
  recipient and the cutover. Grep it after any api deploy.

## 2. ⛔⛔ It is a SWEEP, not a hook in the charge path — and both halves of that matter

**Safety.** Nothing in this file runs inside a charge. A fault here cannot fail,
delay or double a customer's payment; the worst case is a late alert. A source
guard reads `solaBillingPayments.ts`, `payLinkRoutes.ts`, `externalPayment.ts`
and `publicPayRoutes.ts` and fails if any of them ever imports this module.

**Coverage.** Money settles from **five** places today:

| Path | File |
| --- | --- |
| autopay + admin retry (saved card) | `solaBillingPayments.ts` `chargeBillingInvoice` |
| public pay page (one-time card) | `solaBillingPayments.ts` `chargeBillingInvoiceWithSut` |
| combined pay link (one charge, many invoices) | `payLinkRoutes.ts` |
| Sola webhook reconciler | `solaBillingPayments.ts` (webhook branch) |
| operator posts a check / Zelle / cash | `externalPayment.ts` |

Hooking each is exactly how the two IVR publish paths and the two invite paths
shipped half-broken. All five end at a `PaymentTransaction` row reaching a
settled status, so watching **that** covers every one — and every path added
later, for free.

## 3. The rules, and why each exists

- **One alert per (transaction, settled status).** Keyed on the status as well as
  the id, so an APPROVED payment later REFUNDED raises a second, correct alert
  instead of being swallowed as a duplicate.
- **`PENDING` is the only status never alerted** — it has not settled, so there is
  nothing true to say. Every *other* member of the enum is alerted, so a new one
  can never silently vanish. `paymentTransactionAlerts.test.ts` reads
  `BillingPaymentTransactionStatus` out of `schema.prisma` and fails if a member
  is added that this file would drop.
- **`ERROR` is included on purpose.** Izzy named approved and declined; a charge
  that *errors* is neither, and would otherwise reach nobody. Production has 4 of
  them in the last 90 days (two on 2026-08-18, followed by a successful retry).
  If he wants them off, that is a one-line change to `paymentAlertHeadline`'s
  caller — say so rather than deleting the status silently.
- ⛔ **Pay-link ALLOCATION rows are skipped.** A combined pay link is ONE card
  charge that then writes a child `PaymentTransaction` per invoice it covered
  (`rawResponseSafeJson.allocation === true`). Alerting on those would report one
  $300 charge as four separate payments and quadruple the day's total. The parent
  row is alerted and says *"3 invoices (combined payment)"*.
- **External/manual payments ARE alerted** (check, Zelle, cash, QuickPay…), labelled
  *"Check — posted by an operator · ref 1042 · from <name>"*. That makes the
  success stream every dollar collected, not just card charges. If Izzy wants
  gateway-only, filter on `source === "MANUAL" || processor === "MANUAL"`.
- ⛔ **The slot is CLAIMED before the email**, `updateMany` conditioned on the
  value that was read — the compliance-calendar pattern — so the second api
  process during a blue/green rollout cannot double-send.
- ⛔ **A failed email RELEASES the claim.** This is the *opposite* of a money
  operation, where a spent claim must stay spent: re-sending an alert is
  harmless, never sending one is the failure this file exists to prevent. Retry
  is bounded by the lookback window.
- **The cutover constant stops a back-catalogue burst.**
  `DEFAULT_PAYMENT_ALERT_CUTOVER_AT = 2026-08-23T21:00:00Z`. Without it the first
  sweep would have mailed all **77** historical rows at once. The newest
  transaction before the cutover was 2026-08-23T04:35Z, so the backlog is zero.

## 4. The email

Subject is scannable on a phone: `Payment approved — $155.00 — Trust Bookkeepings`
/ `Payment DECLINED — $130.00 — Create A Box`. Body carries company, amount,
result, decline reason, how it was paid, invoice, time, processor ref,
transaction id, and a link to that customer's admin billing page.

- ⛔ **Times render in New York with the zone named** (`Mon, Aug 24, 11:04 AM EDT`).
  The server is in France; a bare timestamp is six hours wrong to the only person
  reading it.
- ⛔ **It carries NEITHER `connect-billing-transaction:` NOR
  `connect-billing-invoice:`.** Those markers are parsed out of `htmlBody` at the
  send door and cause a receipt or invoice **PDF to be attached**. Guard-tested.
- It rides `emailShell` from `billing/emailTemplates.ts`, so it inherits the
  Outlook `[if mso]` fixed-width frame rather than hand-rolled HTML.
- ⚠️ It inherits the known, pre-existing **81 KB logo** (`loopcom-wordmark-560.png`)
  that the billing shell still serves. Documented in CLAUDE.md as Izzy's call;
  not changed here.

## 5. Volume — measured, not assumed

Read live 2026-08-23 before designing: **60 transactions in 90 days** (APPROVED 46,
DECLINED 10, ERROR 4), busiest day 6, ~0.7/day. Against the one mailbox's
**500/day** Google cap — which currently sends ~14/day — this is negligible.
`izzy@loopcom.net` is **proven deliverable**: a `COMPLIANCE_REMINDER` reached it
**SENT** at 2026-08-23T16:26Z with no error. (That answers the
domain-verified-≠-mailbox-exists trap for this address.)

## 6. Proven

- **38 tests**, registered in `apps/api/package.json`. ⛔ `apps/api` names billing
  test files **explicitly** — `src/billing/` is not globbed, so an unregistered
  billing test never runs (the `billingPdf.test.ts` trap).
- The arming guard **fails all three assertions replayed against `HEAD`**
  (import / start / shutdown-registration), so it is not decoration.
- The new columns were verified against the **REAL generated Prisma client**
  (`Prisma.dmmf`), not just the schema file — the `(db as any)` transposition trap.
- Migration generated by `prisma migrate diff` (schema-to-schema, offline), never
  hand-written: two nullable columns, no table rewrite.
- api typecheck **76 = the exact baseline**, none in an edited file. Billing
  suites 190/190.
- Both emails were **rendered and read**, not assumed.

## 7. Deploy state

See the CLAUDE.md section for the verified container commit and the live boot
line.

## 8. ⏳ NOT PROVEN

**No alert has been delivered to a human inbox yet** — no payment has settled
since this shipped. It is proven as tests, a rendered email, a container grep and
the armed boot line, never by an email arriving.

**The acceptance test is the next real payment**, and the cheapest check is:

```sql
select "createdAt", type, status, "toEmail", subject
from "EmailJob" where type = 'PAYMENT_TRANSACTION_ALERT'
order by "createdAt" desc limit 5;
```

`status = SENT` means the provider took it. The negatives that matter: exactly
**one** row per transaction, and a combined pay link producing **one** alert
rather than one per invoice.
