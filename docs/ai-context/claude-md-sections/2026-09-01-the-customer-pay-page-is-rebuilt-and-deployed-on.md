# ⛔⛔ AGENT HANDOFF — the customer pay page is REBUILT AND DEPLOYED: one column, collapsible breakdown, token-scoped invoice PDFs (2026-09-01) — READ FIRST before touching pay-invoice.css, CardknoxIFieldsForm, PayInvoiceList, the iFields options object, or any public pay route

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_PAY_PAGE_REDESIGN_2026-08-31.md`**
(`7f79f4bd` on `feat/ivr-migration-takeover`. ✅ **api + portal DEPLOYED and PROVEN ON THE
LIVE PAGE** — the deployed combined pay page was opened with a real token for YS Plumbing's
real invoices: real Cardknox iframes (v3.4.2602.2001, 46px) inside 48px hosts, "Pay $43.26",
real line items ($20.00 + $1.63 sales tax), collapsible rows, four working PDF links, real
Sola vector, zero overflow at 760/390/320, light and dark. ⛔ The containers' `.build-commit`
reads `875bd560` because a LATER remote-support deploy pinned that commit — **it is a
DESCENDANT of `7f79f4bd`** (merge-base-verified), so the redesign is inside it; judge by
grepping the container for `billing-pay-cardtop`, never by `.build-commit` alone. No
migration, no PBX write, no env change.) Approved mockup, updated to as-built:
<https://claude.ai/code/artifact/2bba5d12-8a99-4d61-8879-beb40dc924f9>
Memory: [[checkout-page-redesign-mockup]], [[ifields-config-must-be-copied-verbatim]].
Izzy: *"The words are jumping off the page. The dropdown fields are overlapping each
other…"*, then *"they should be able to open the invoice from in there as well. There
should be a breakdown as much as possible."*, *"copy the iFields the way it is right now…
Size everything."*, *"make sure the breakdown is really collapsible"*, and the approval:
*"Exactly on the dot like the markups. It's perfect."*

- ⛔⛔ **THE iFIELDS OPTIONS ARE FROZEN AND A GUARD PINS EVERY VALUE.**
  `payPageRedesign.test.ts` asserts all 21 keys of `ifieldOptions` byte-for-byte (46px
  height/line-height, 14px/500, transparent, per-theme colour, autoFormat,
  blockNonNumericInput) — they style type INSIDE a cross-origin iframe no stylesheet can
  reach, so a regression is invisible until somebody looks at a live card field. The two
  per-field options objects are memoised for IDENTITY only; the VALUES never change.
  ⛔ **The detected `issuer` is deliberately NOT passed into the CVV `<IField>`** — that
  changes a prop on a live iframe mid-entry and can clear a typed CVV. The 3-vs-4-digit
  hint is OUR label; the iframe is untouched.
- ⛔⛔ **ONE FIELD HEIGHT: `--pay-field-h: 48px`** — the frozen 46px iframe + our 1px
  border each side. Every native input, ConnectSelect trigger and secure-field host on the
  pay surface is 48px outside (measured live: all 11 boxes). ⛔ ConnectSelect ships a 36px
  trigger and globals.css sizes the host to 42px for admin forms — the pay page
  out-specifies both via `.billing-pay-page` scoping. Do not "fix" a height mismatch by
  shrinking the iframe.
- ⛔⛔ **THE REPORTED "overlapping dropdowns" WAS `.cs-wrap { min-width: 160px }`** —
  ConnectSelect refuses to shrink below 160px, so in a narrow grid column the Year
  dropdown pushed past the card edge over its neighbour. Every grid child on this form
  now carries `min-width: 0`. Found only by measuring the BUILT page at 320px — the
  mockup could not contain it because the mockup used plain selects.
- ⛔⛔ **INVOICE DATES RENDER IN UTC, ALWAYS** (`payDate` in `PayInvoiceList.tsx`).
  Invoice dates are stored as UTC midnight standing for a calendar day; local-zone
  formatting showed "Due Jul 9" for a Jul-10 invoice to everyone west of UTC — and the
  PDF formats with `timeZone: "UTC"` (billing/pdf.ts), so the page and the PDF it opens
  disagreed. Caught by driving the built page, not by any test.
- ✅ **THE LAYOUT: one column, grouped by meaning** — card block (number, then
  Month · Year · CVV in one row), name, receipt email, then a bordered billing-address
  group. The `grid-column: 1|2` checkerboard is DELETED from pay-invoice.css and a guard
  fails if any field is pinned to a hand-picked column again. The amount is stated ONCE
  (`billing-pay-currency` is gone — a guard checks all four surfaces). Breakpoints:
  address collapses at 640, expiry at 430; measured zero-overflow at 320.
- ✅ **THE BREAKDOWN IS NATIVE `<details>/<summary>`** (`PayInvoiceList.tsx`, ONE
  component for all three surfaces): really collapses (driven, not assumed), keyboard
  and screen-reader operable with no state. First invoice open by default. Line items,
  qty × unit price, invoice total, issue date + billing period, and per-invoice
  **Open full invoice** / **Download PDF**.
- ⛔⛔ **THE PUBLIC PROJECTION LIVES ONCE: `apps/api/src/billing/publicInvoiceView.ts`.**
  `publicInvoiceLines` deliberately DROPS line-item `metadata` (extensionIds,
  phoneNumberIds, quantityMode — internal bookkeeping must not ride an unauthenticated
  response; test-pinned). `publicInvoiceTotals` deliberately emits NO `totalCents` —
  every caller already has one and a duplicate key silently overwrites it (TS2783 caught
  it once already). The pay-multi loader now includes `lineItems`; the pay-link row now
  carries `invoiceId` (the open-invoice link is built from it).
- ⛔⛔ **THREE TOKEN-SCOPED PDF ROUTES EXIST NOW** — `…/invoices/pay/:token/pdf`,
  `…/invoices/pay-multi/:token/invoice/:invoiceId/pdf`,
  `…/pay-links/:code/invoice/:invoiceId/pdf` — because the existing
  `GET /billing/platform/invoices/:id/pdf` runs `requireTenantBilling` (login-gated)
  while billing emails put that exact URL in front of customers. ⛔ **Each refuses an
  invoice id its own token does not name (404), and the row is still tenant-scoped** —
  proven live: a valid YS Plumbing token asked for another tenant's invoice id → 404;
  its own → 200 `application/pdf`, 144 KB, `%PDF` magic; `?download=1` flips the
  disposition to attachment (`sendBillingInvoicePdf` gained an options arg, default
  inline — every old caller byte-identical). ⛔ All three paths ride EXISTING bypass
  prefixes — no `jwtPublicRouteBypass.ts` change was needed, and a test pins all six
  path shapes. ⛔ The login-gated route is UNTOUCHED (test-pinned).
- ✅ **The wordmark sits INSIDE the card** (`PayCardTop.tsx` — the band with the
  secure-payment chip, on all four surfaces incl. add-card; `billing-pay-logo` is gone).
  ⛔ **The Sola mark is a DIFFERENT VENDOR FILE per theme (`2928ddea`, Izzy 2026-09-01:
  "dark mode and light mode should have different sola logos")** — light renders
  `sola-logo-positive-rgb.png`, dark renders `sola-logo-reverse-rgb.png` (white wordmark +
  the same `#0047FF` ring; Sola ships the pair and their README forbids recoloring). The
  earlier inline currentColor SVG and its generator `scripts/portal-sola-logo.py` are
  DELETED — the guard now fails on any re-tint/filter fake of the reverse.
  **Card brands are vector marks** (`CardBrandMarks.tsx` — self-contained SVGs, no
  clipPath/`<use>` ids because the marks repeat per page and ids collide). Live brand
  detection rides Cardknox's own `onUpdate.issuer` (decoration ONLY — the mark beside
  the field, the row dimming, the Amex 4-digit CVV hint; never a payment decision).
- ⛔ **The supermarket desk pins these class names** (`supermarketPortal.test.ts` styles
  them as `.sm-` descendants): `billing-ifields-card`, `billing-pay-row--expiration`,
  `billing-ifields-cvv`, `billing-field-cardholder`, `billing-field-zip-only`,
  `billing-pay-secure-note` — all survive; a guard fails on a rename. The desk's
  `order:` rules that forced card-first are now redundant but harmless. The admin
  drawer + desk (non-pay surfaces) get the new group wrappers via globals.css rules
  scoped `.billing-form:not(.billing-pay-form)`.
- ✅ **Proven:** 10 api tests (`publicPayBreakdown.test.ts`) + 13 portal guards
  (`payPageRedesign.test.ts`, `PAY_GUARD_ROOT` replay: **10 of 13 fail against the
  pre-change tree**; the 3 that pass are the regression guards). Portal typecheck 0;
  api typecheck 0 errors in any edited file; portal suite 462/465 (the 3 pre-existing).
  ⛔ `import.meta` is TS1343 in apps/api tests — use `__dirname`. ⛔ A stale
  `.next/types` entry for a deleted route reads as a typecheck regression — delete the
  `.next/types/app/...` folder, not code.
- **Decisions as shipped:** "Open full invoice" = the PDF (a styled web invoice can come
  later). **Save-card still ships UNTICKED** — the mockup ticked it, flipping the
  default turns on autopay, that stays Izzy's call (one line). The page shows each
  customer's own company name, unchanged.
- ⏳ **NOT PROVEN: nobody has PAID through the new page.** Everything else is proven on
  the deployed page with real data. Acceptance is the next real customer payment —
  including the negatives: a declined card still shows the retryable error, and the
  supermarket desk's card save still tokenizes (its surface re-rendered fine but no
  human has driven it since).
