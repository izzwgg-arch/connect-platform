# AGENT HANDOFF — B Visible missed charges + `billingRecurringCustomLines` (2026-09-15)

Task (Izzy): an extension added last month for **Lester** ($25/mo) and a **$40/mo
Contabo server** were supposed to be on B Visible's bill and weren't. Check this
month; if missed, one-time invoice both + email it; add both to every future
monthly bill.

Summary file: `docs/ai-context/claude-md-sections/2026-09-15-bvisible-missed-charges-recurring-custom-lines.md`

## 1. Diagnosis (all verified in the prod DB, 2026-09-15)

- Tenant `cmnlgryp8001lp9pajhatv3t9` (B Visible), bills the **2nd**, autopay ON,
  card on file, `billingEmail ap@bvisible.us`, **`taxEnabled: false`**.
- `metadata.billingFlatRate = { enabled, extensions, 10500 }` — $105/mo flat for
  extensions regardless of count. **Lester Tan = ext 111, created 2026-08-17.**
  The flat-rate line's count moved 10 → 11 ("11 billing extensions; 11 active")
  and the amount stayed $105 — this is the whole reason the $25 never billed.
- Cycle invoices: CC-202608-00004 (Aug 5 – Sep 2, transition month) PAID $140;
  CC-202608-00027 (Sep 2 – Oct 2) PAID $140. $140 = 105 + 2×$10 local numbers
  (manual override) + $15 toll-free (manual override). No $25, no $40, either month.

## 2. One-time catch-up invoice — DONE

- **CC-202609-00010** (`cmu32cn8i02qenl13r6z09pgm`), **$65.00**, OPEN, due
  2026-09-15 EOD NY. Created through the real route
  `POST /admin/billing/invoices/manual`, request signed as Izzy's SUPER_ADMIN
  (`cmm0414y7000tmq10nxtha90f`) inside `app-api-1` — hand-rolled HS256 with the
  container's `JWT_SECRET` (`jsonwebtoken` is NOT installed at /app; a first
  attempt died on `require` BEFORE any request, so nothing was double-sent).
  Sent exactly once ([[a-creating-write-is-sent-exactly-once]]).
- Lines (both `CUSTOM`, `taxable:false` — total is exactly the sum):
  - `Extension 111 - Lester Tan (added Aug 17) - one-time catch-up` — $25.00
  - `Contabo server - one-time catch-up` — $40.00
- Wording deliberately avoids /monthly service|service balance/i so the invoice
  stays "additive" for the paid-period guard (`isAdditiveOneTimeInvoice`,
  `74e7730a`) — it is chargeable inside the paid September month.
- **Email SENT**: `POST /admin/billing/invoices/:id/send` → 200
  `{sentTo:"ap@bvisible.us"}`; EmailJob row SENT 19:27:41 UTC; invoice
  `lastEmailStatus` SENT.
- ⛔ **The card was NOT charged.** Manual invoices are excluded from the autopay
  cycle — this $65 sits OPEN until paid via the pay link/customer page or charged
  by hand (admin /pay). Izzy asked for invoice + send only.

## 3. The new feature: `metadata.billingRecurringCustomLines` (api `5573d567`)

Why: the cycle engine had NO named recurring add-on. Existing levers all fail
this ask: flat rate = one unlabeled total; virtual extensions = one bucket, one
price, generic label; `billingTelecomFees.customFee` is ⛔ untouchable on
B Visible (shared `tax_profile_ny_default` — a settings PUT carrying
billingTelecomFees rewrites Fixup Group's and RSBK's tax rows,
[[shared-tax-profile-rewrites-other-tenants]]).

- `apps/api/src/billing/billingRecurringCustomLines.ts`:
  `parseBillingRecurringCustomLines(metadata)` → `{description, amountCents,
  taxable?}[]` (cap 20 entries, description trim ≤200, amount int 1..25,000,000,
  junk skipped silently, `taxable` only on `=== true`);
  `buildRecurringCustomInvoiceLines` → `type:"CUSTOM"`, qty 1,
  `metadata.lineItemKind:"recurring_custom"`.
- `invoiceEngine.ts`: lines pushed after the SMS-package block, **before
  `applyBillingPeriodToRecurringLines`** — so they carry servicePeriod metadata
  and scale on multi-month invoices like every other recurring line.
- Blast radius (traced before building): opt-in key absent everywhere else →
  byte-identical previews for all other tenants. `taxable:false` lines join
  `subtotalCents` only — never the taxable subtotal, the tax/fee engines, or the
  all-inclusive solver (`applyAccountPricing` reads taxable lines). Discounts
  would apply to them (documented; B Visible has 0%). `createBillingInvoice`
  persists preview lines verbatim; CUSTOM is an already-shipping line type
  (manual invoices).
- Tests: `billingRecurringCustomLines.test.ts`, **added to the api runner's
  explicit file list in `apps/api/package.json`** (the runner never globs
  billing tests). Includes a CRLF-normalised source guard
  ([[source-reading-tests-must-normalise-crlf]]) pinning the push-before-stamp
  placement. 8/8 pass under
  `node --experimental-test-module-mocks --import tsx --test` (plain `tsx --test`
  fails billingPeriodGuards on `mock.module` — flag, not code).
- ⛔ There is NO route/UI to edit the key — it is set in the DB directly. A
  `PUT /admin/billing/tenants/:id/settings` preserves unknown metadata keys
  (proven 2026-08-31), so ordinary settings saves won't drop it.

## 4. Deploy + live state

- `bash scripts/deploy-direct.sh api --commit 5573d567...` on the app host:
  blue/green clean, health 200, **container `.build-commit` = `5573d567`**,
  `/app/apps/api/src/billing/billingRecurringCustomLines.ts` present in the
  running container.
- B Visible metadata set with a guarded UPDATE (`AND NOT (metadata ?
  'billingRecurringCustomLines')` — re-run is a no-op). **Backup of the full
  prior metadata: `/root/bvisible-billing-metadata-backup-20260915.json`**
  (loopcom). Reversal = `metadata - 'billingRecurringCustomLines'`.
- **Live proof through the deployed route**
  `GET /admin/billing/platform/tenants/cmnlgryp8001lp9pajhatv3t9/invoice-preview`
  (default period AND `?periodMonth=10&periodYear=2026`): **TOTAL 20500** —
  flat 10500 + phones 2000 + toll-free 1500 + `CUSTOM Contabo server 4000` +
  `CUSTOM Extension 111 - Lester Tan 2500`, tax 0.

## 5. Open / not proven

- ⏳ No real money has moved on the new lines. Acceptance: the worker creates the
  Oct 2 – Nov 2 cycle invoice at **$205.00** in the T-3 window (~Sep 29) and
  autopay charges it **Oct 2**. Check `BillingInvoice` for period 2026-10-02 →
  2026-11-02 and its `PaymentTransaction`.
- ⏳ CC-202609-00010 ($65) is OPEN and outside autopay — someone must collect it.
- ⛔ **Never ALSO bump B Visible's flat rate for Lester** — the $25 rides as a
  recurring custom line; doing both double-charges.
- The two known pre-existing typecheck errors
  (billingPricingDiagnostics/State `accountPricing`) still stand; none of this
  work touched them.
