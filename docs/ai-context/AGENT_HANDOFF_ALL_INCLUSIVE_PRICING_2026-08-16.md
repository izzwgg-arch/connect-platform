# AGENT HANDOFF — the customer's price is now ALL-INCLUSIVE (2026-08-16)

**Read this before touching `apps/api/src/billing/invoiceEngine.ts`, before
adding any tax or fee line, and before answering "why did this customer's total
change?"**

Status: **committed and pushed. ⛔ NOT DEPLOYED — held for Izzy's approval,**
because it changes what 17 of 26 live customers are billed. See §6.

---

## 1. What was asked, and what it means

Izzy's pricing model, 2026-08-16:

```
customer_total            = (extension_count × $30.00) + $5.00
net_service_revenue       = customer_total − total_actual_taxes_and_fees
net_revenue_per_extension = net_service_revenue / extension_count
```

- $30.00 is the commercial price of an extension. **$5.00 is a taxes-and-fees
  allocation charged ONCE PER ACCOUNT**, never once per extension.
  1 ext = $35 · 2 = $65 · 3 = $95 · 5 = $155 · 10 = $305.
- ⛔ **That total is FINAL.** Real taxes, E911, telecom taxes and regulatory
  fees are NOT added on top of it — they are computed for real and live INSIDE
  it. What moves with the fee bill is the SPLIT, not the price.
- Fees **above** $5 are absorbed out of the per-extension service revenue; the
  customer's total does not move.
- Fees **below** $5 leave the remainder as service revenue. ⛔ It must never be
  re-labelled as a government tax — and it isn't: only the lines the fee engine
  actually produced are booked as taxes.
- The invariant, on every invoice:
  **`net_service_revenue + total_actual_taxes_and_fees = customer_total`.**

Izzy's worked example — 5 extensions, $18 of real fees → $155 total, $137 net,
**$27.40 net per extension** — is a test (`billingAccountPricing.test.ts`), and
⛔ **$27.40 is never an input.** It is the number the engine has to *reach*.

---

## 2. What changed in code

| File | Change |
|---|---|
| `apps/api/src/billing/billingAccountPricing.ts` | **NEW.** The account fee, the tax-inclusive solver, the government-vs-service-charge rule, and the split summary. |
| `apps/api/src/billing/invoiceEngine.ts` | The fee computation became a function of the taxable base; the account fee is folded in and the real fees carved out of the extension line; `accountPricing` added to the preview and persisted on invoice metadata. |
| `apps/api/src/billing/billingTelecomFees.ts` | New `serviceCharge` flag on a fee item + `telecomFeeIsServiceCharge` on the emitted line metadata. |
| `apps/api/src/onboarding/onboardingBillingDefaults.ts` | The toll-free `customFee` is stamped `serviceCharge: true`. |
| `apps/api/src/billing/billingAccountPricing.test.ts` | **NEW** — 14 tests, the pricing model pinned end to end. |
| `apps/api/src/billing/invoiceEngine.test.ts`, `onboarding/onboardingBillingDefaults.test.ts` | Updated for the new totals. |

**Nothing else moved.** No migration, no schema change, no new route, no portal
change, no change to the billing schedule, autopay, payment processing, invoice
editing, or the sign-up wizard.

### The mechanism, in order

1. Commercial lines are built exactly as before (extensions, virtual extensions,
   local/toll-free numbers, PBX DIDs, SMS, credits, discount, period scaling).
   Their sum is the **list** price.
2. `accountFeeCents = accountFeeCentsPerMonth × billingMonthCount` — so a
   3-month invoice carries three account fees and a half-month prorates one.
3. `solveTaxInclusiveTaxableBase` backs out the taxable SERVICE revenue hiding
   inside the all-in price, by asking the real fee engine what it would charge
   on a candidate base until the base stops moving (§3).
4. The extension line is adjusted **once**, by `accountFee − governmentFees`.
   Its `amountCents` stays authoritative; `unitPriceCents` becomes the displayed
   per-extension net.
5. Tax lines are pushed and the totals recomputed. The total lands on
   `list + accountFee + serviceCharges` exactly.

---

## 3. Why a solver, and why it cannot be wrong

A percentage fee (sales tax, USF/regulatory recovery) is owed on the **service
revenue**, not on the customer's all-in total — charging 8.125% of a total that
already contains the 8.125% taxes the tax. So the base `b` solves
`b + fees(b) = taxable_gross`, by fixed-point iteration against the real fee
engine. Percentage rates sum to far under 1, so it contracts in 2–3 passes;
integer rounding can make the last cent oscillate, so it is capped at 12 passes
rather than looped to a fixed point.

⛔ **Non-convergence is harmless and that is deliberate.** The service revenue
is derived by SUBTRACTING the fees from the pinned total, so
`net + fees = total` holds at whatever base it stops on — only the last cent of
a percentage line is at stake. And the fees returned are always the ones
computed **at** the returned base, so the audit trail can never disagree with
the invoice. Fixed-amount fees (E911 at $3 a number) do not depend on the base
at all: for those tenants the first pass is already exact.

---

## 4. ⛔ The trap that nearly shipped: `customFee` is NOT the commercial bucket

The first implementation split "real tax" from "our charge" by fee key —
everything except `customFee` is a tax. That reads right, and the code comments
justifying it were persuasive: onboarding's $15/month toll-free number is
stamped into `customFee` precisely because it is commercial revenue.

**It was wrong, and only reading production caught it.** On 2026-08-16, six
live tenants — **Trust Bookkeepings, Luxure Management, Smooth Leasing, Secro
Selutions, ADDB Builders, Solidify Concrete** — keep their real telecom &
regulatory fee ($2.00, and $2.44 for Solidify) in `customFee` under the generic
label **"Other custom fee"**. Trimpro keeps $5.00 there. Splitting on the key
would have **raised six customers' bills by $2 and booked a government charge
as income** — the exact mislabelling the pricing rule forbids.

The rule is now an **explicit opt-in flag** on the fee config,
`serviceCharge: true`, surfaced on the line as `telecomFeeIsServiceCharge`:

- **absent / false → a real tax or fee.** Lives inside the customer's total.
  This is the default, so every fee row configured before today keeps its
  current meaning.
- **true → our own charge.** Adds to the total, like any service line. Set
  today only by onboarding's toll-free stamp.

⛔ **Never re-derive this from the bucket, the label, or the basis.** Judge it
by the flag.

---

## 5. Deliberate boundaries

- ⛔ **No hard-coded $30.** The commercial extension price comes from
  `resolveTenantBillingPricing` as it always has — live tenants are on **$25.00,
  $26.70, $27.00 and $30.00**, and hard-coding the sign-up constant would have
  overcharged four companies. Only the **$5** is a constant, and it is
  overridable per tenant via `metadata.billingAccountFeeCents` (including `0`).
- **Zero billable extensions → the model does not apply.** There is nothing to
  price per extension against, so no account fee is charged and taxes are added
  on top as before. Reported as `accountPricing.applied: false`.
- **The extension line absorbs everything.** Add-on lines (extra numbers, SMS,
  toll-free) keep their own prices, so adding an SMS package still raises the
  bill by exactly $10. `agentProvisioning/billingReconcile.ts` — which refuses
  to report success unless the bill actually moved — still works, and is now
  more accurate: adding a second phone number moves the total by its $10
  commercial price, and the extra $3 of E911 is absorbed rather than
  double-counted.
- **Flat-rate tenants are included.** A tenant on `billingFlatRate` gets the
  account fee folded into the flat line and its taxes carved out of it. Nobody
  is on a flat rate today. If Izzy wants a negotiated flat price to stand alone,
  set that tenant's `billingAccountFeeCents` to `0`.
- **If fees somehow exceed the extension line's whole revenue**, the line clamps
  at zero rather than going negative and
  `accountPricing.feesExceedCommercialRevenue` is set. It should never fire.

---

## 6. ⛔ What this does to live customers — read before deploying

Replayed read-only against production config on 2026-08-16 (approximate: the
replay ignores credits, discounts, virtual extensions and $0 PBX DID lines).
**26 live tenants; 17 change; net −$44.07/month.**

**Nine tenants go UP by exactly $5.00** — the account fee, on accounts that have
no tax configuration at all so all of it stays service revenue:
A plus center, B Visible, Comfort control, Create A Box, Displaydex,
Ezra stress test 1, Landau Home, Loopcom Demo, RSBK.

**Eight are unchanged** — their real fees already come to exactly $5.00:
ADDB Builders, Fixup Group, Luxure Management, Relax Tires, Secro Selutions,
Smooth Leasing, Trust Bookkeepings, and both Connect Communications rows (which
bill nothing).

**Nine go DOWN**, because tax that used to be added on top now lives inside the
price:

| Tenant | Old | New | Change | Real fees inside |
|---|---|---|---|---|
| Gesheft | $504.98 | $465.00 | **−$39.98** | $41.63 |
| Trimpro | $212.36 | $194.00 | −$18.36 | $21.98 |
| Yossis Wood Works | $206.96 | $191.90 | −$15.06 | $18.80 |
| Solidify Concrete | $87.28 | $80.00 | −$7.28 | $11.67 |
| inii mini | $48.00 | $45.00 | −$3.00 | $8.00 |
| Matamim | $48.00 | $45.00 | −$3.00 | $8.00 |
| LUZER | $46.65 | $45.00 | −$1.65 | $6.51 |
| McNamara Lion | $35.74 | $35.00 | −$0.74 | $5.67 |

That is the model working as specified — but it is a price cut for nine paying
customers and a $5 rise for nine others, so **it is Izzy's call, not a
deployment detail.** Nothing is deployed.

---

## 7. Open, deliberately not done

1. ⛔ **The sign-up quote still adds E911 per NUMBER**
   (`packages/shared/src/onboardingPricing.ts` → `$30/ext + $3/number + $2`).
   For a one-number customer that is $35 and agrees with the new recurring
   total exactly. **For a two-number customer the quote says $38 and month 2
   will say $35.** The quote is customer-facing UI and was explicitly out of
   scope. Someone has to decide whether the quote follows the formula.
2. **The admin taxes-and-fees screen's estimator**
   (`apps/portal/lib/billingTelecomFees.ts`) still applies percentages to the
   gross, so it now over-states a percentage fee slightly. It is labelled
   "estimate only until invoiced" and no customer sees it.
3. **`BillingInvoice.taxCents`** still counts a `serviceCharge` line as tax
   (pre-existing: those lines are typed `REGULATORY_FEE`). The honest,
   government-only figure is `metadata.accountPricing.totalTaxesAndFeesCents`.
   Use that for accounting, not `taxCents`.
4. **The portal does not show the split anywhere.** `accountPricing` is on the
   preview and on invoice metadata; no screen reads it yet.

---

## 8. Proof

- `apps/api` billing + onboarding suites: **598 pass, 0 fail, 2 skipped**
  (the 2 need `CREDENTIALS_MASTER_KEY` and were already skipped).
- Whole `apps/api` suite: **2400 pass, 7 fail** — the 7 are the pre-existing
  `pbxTenantDirectorySync` failures documented in CLAUDE.md, untouched by this.
- Typecheck: 75 errors, **0 in any file this touched** (all pre-existing, in
  `server.ts`, ops/storage and webrtc modules).

Run them with:

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/billing/*.test.ts" "src/onboarding/*.test.ts"
```

⏳ **NOT PROVEN: no real invoice has been generated under this math.** It is
proven by unit test against the real engine and by a read-only replay over live
tenant config — not by an invoice a customer has received. The acceptance test
is one preview through `GET /admin/billing/tenants/:id/preview` after deploy,
checked against the table in §6.
