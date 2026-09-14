# ⛔⛔ AGENT HANDOFF — the customer's price is ALL-INCLUSIVE now; taxes live INSIDE the total (2026-08-16) — READ FIRST before any billing-calculation work, before adding a tax or fee line, before quoting a price, or for "why did this customer's total change?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ALL_INCLUSIVE_PRICING_2026-08-16.md`**
(new module `billingAccountPricing.ts` + `invoiceEngine.ts` on
`feat/ivr-migration-takeover`. **Committed and pushed. ⛔ NOT DEPLOYED — awaiting
Izzy's word.**)

- ⛔⛔ **GOING FORWARD ONLY, AND IT IS OPT-IN. Izzy, 2026-08-16: "No, do not
  change any existing invoice totals. This is only going forward."** The model
  runs only when `TenantBillingSettings.metadata.billingAllInclusivePricing ===
  true`, stamped solely by `ensureOnboardingBillingDefaults` on a tenant a NEW
  sign-up creates (it already refuses any tenant with a fee config or taxes
  enabled, so it cannot reach an existing account). **Verified live 2026-08-16:
  32 billing rows, 0 opted in — not one existing total moves.** ⛔ **Never flip
  the default to on** — a default-on gate is indistinguishable from no gate the
  moment metadata goes missing. ⛔ **The proof that nothing moved is that
  `invoiceEngine.test.ts` is BYTE-IDENTICAL to its pre-change version and still
  passes**; if you ever need to know whether a billing change touched existing
  customers, restore that file from before your commit and run it.
- **The model (Izzy, 2026-08-16):** `customer_total = (extension_count × $30) + $5`,
  where the **$5 is charged ONCE PER ACCOUNT, never per extension** — 1 ext $35,
  2 $65, 3 $95, 5 $155, 10 $305. Then
  `net_service_revenue = customer_total − total_actual_taxes_and_fees` and
  `net_revenue_per_extension = net_service_revenue / extension_count`.
- ⛔ **THE RULE: that total is FINAL. Real taxes/E911/regulatory fees are NOT
  added on top — they are computed for real and carved OUT of it.** Fees above
  $5 are absorbed from per-extension service revenue and the customer's total
  does not move; fees below $5 leave the remainder as **service revenue, never
  re-labelled as a government tax**. The invariant
  `net + actual_fees = customer_total` holds by construction — the net is
  derived by SUBTRACTION, never summed and hoped over. Izzy's $27.40 example is
  a test, and ⛔ **$27.40 is an OUTPUT, never an input.**
- ⛔ **`customFee` is NOT the commercial bucket — this nearly shipped wrong and
  only reading production caught it.** Six live tenants (Trust Bookkeepings,
  Luxure, Smooth Leasing, Secro, ADDB, Solidify) keep their real **$2.00–$2.44
  telecom & regulatory fee** in `customFee` under the label "Other custom fee";
  Trimpro keeps $5.00 there. Splitting tax-vs-revenue by fee KEY would have
  raised six bills by $2 and booked a government charge as income. The rule is
  now an explicit opt-in flag, **`serviceCharge: true`** (line metadata
  `telecomFeeIsServiceCharge`): **absent = a real fee that lives inside the
  total; true = our own charge that adds to it.** Set today only by
  onboarding's $15 toll-free stamp. ⛔ Never re-derive it from the bucket, the
  label or the basis.
- ⛔ **A percentage tax is owed on the SERVICE revenue, not the all-in total** —
  8.125% of a total that already contains the 8.125% taxes the tax.
  `solveTaxInclusiveTaxableBase` backs the base out by asking the REAL fee
  engine on each pass (2–3 passes, capped at 12). Non-convergence is harmless
  by design: the net is a subtraction, so `net + fees = total` holds at
  whatever base it stops on, and the fees returned are always the ones computed
  **at** the returned base — the audit can never disagree with the invoice.
- ⛔ **No hard-coded $30.** The extension price still comes from
  `resolveTenantBillingPricing` — live tenants are on **$25.00, $26.70, $27.00
  and $30.00**, and hard-coding the sign-up constant would have overcharged four
  companies. Only the **$5** is a constant, overridable per tenant via
  `metadata.billingAccountFeeCents` (including `0`). **Zero billable extensions →
  the model does not apply** (no $5, taxes added on top as before).
- ⛔ **What moving an EXISTING tenant over would cost — none of this happens,
  it is why the gate exists.** Replayed read-only (26 tenants, 17 would change,
  net −$44.07/mo): **+$5 for nine** with no tax config at all (A plus center,
  B Visible, Comfort control, Create A Box, Displaydex, Ezra stress test 1,
  Landau Home, Loopcom Demo, RSBK); **unchanged for eight** whose real fees
  already total exactly $5; **DOWN for nine** where tax used to be added on top
  — **Gesheft −$39.98**, Trimpro −$18.36, Yossis −$15.06, Solidify −$7.28,
  inii mini/Matamim −$3.00, LUZER −$1.65, McNamara Lion −$0.74. **Read this
  table before setting `billingAllInclusivePricing` on any existing account.**
- ⏳ **OPEN, and now a LIVE edge for future customers: the sign-up quote still
  adds E911 per NUMBER** (`packages/shared/src/onboardingPricing.ts`) while new
  tenants ARE stamped onto the new model. One number → quote $35, month 2 $35,
  they agree exactly (every sign-up so far). **Two numbers → the quote says $38
  and month 2 says $35.** Customer-facing UI, deliberately out of scope —
  aligning it is one line in `quoteOnboarding` and needs Izzy's word.
- ✅ **The REPORTING half runs for EVERY tenant, gated or not** — `accountPricing`
  on every preview and every invoice's `metadata`: customer total,
  government-only fees inside it, net service revenue, net revenue per
  extension. For a legacy tenant it is a pure readout that moves nothing, so
  "how much of this invoice is really ours?" is answered for all 26 live
  customers with no pricing change. ⛔ **`BillingInvoice.taxCents` still counts a
  `serviceCharge` line as tax** (pre-existing — those lines are typed
  `REGULATORY_FEE`); use `accountPricing.totalTaxesAndFeesCents` for the honest
  government figure.
- ⏳ **NOT PROVEN: no real invoice has been generated under this math**, because
  no tenant is on it — the first will be the next sign-up. Proven by 17 new
  tests + the existing suites (601 pass / 0 fail across billing + onboarding;
  whole api suite 2400 pass / 7 fail, all 7 the pre-existing
  `pbxTenantDirectorySync` ones) and by read-only replay over live config.
  **Acceptance after deploy: (1) preview an existing customer — total unchanged,
  `accountPricing.applied` false; (2) run one sign-up and preview month 2 —
  `(extensions × their rate) + $5`, applied true.**
