# AGENT HANDOFF — Gesheft's POS API docs ARRIVED (2026-08-25): the delivery tracker's Phase 10 blocker is gone, and the API can carry far more than delivery

**Read-only intake — no code, no deploy, no key exists yet, no request has ever been
made against this API.** Source: an email titled "API Key Docs" from
`Contact | Gesheft Kosher <contact@gesheftkosher.com>` to Izzy, 2026-08-25 5:07 PM,
supplied as `C:\Users\izzyw\Documents\AD_Port`.

⛔ **THE FILE IS AN XPS PRINTOUT WITH NO EXTRACTABLE TEXT.** It looks like a .docx
(OOXML zip) but is an XPS print-to-file whose every glyph was converted to vector
outlines — zero `UnicodeString`s anywhere. The way to read it: PyMuPDF opens it
directly (`fitz.open(path)` sniffs content, extension irrelevant), render pages to
PNG at 150 DPI, read the images. 20 pages. Plain-English report published for Izzy:
<https://claude.ai/code/artifact/f46069de-22fa-4b91-8f5d-a7709809e5f3>

⛔ **THE PRINTOUT IS INCOMPLETE and starts mid-document at "Endpoints".** It
references a **"Customer PIN" section, a "Rate Limiting" section, and a Data Models
section that are NOT in these 20 pages**, and nothing explains authentication
sign-up, the credit system's pricing, or PIN provisioning. Ask Gesheft for the full
docs / portal access before building.

## The API, verbatim facts

- **Base URL `https://api.poswithlogic.dev`** ("POS with Logic" — Gesheft's register
  system). Auth: **`x-api-key` header**. Metered **credits per call** with scoped
  keys; each endpoint documents `Scope`, `Access: own|all`, `Cost`.
- ⛔ **"own" scoping is the structural limit: you can only access orders created
  WITH YOUR OWN API KEY** (stated twice, for orders and invoices). In-store orders
  are invisible unless Gesheft's vendor pushes them or grants more. This decides the
  whole delivery-ingest design — settle it with Gesheft first.
- ⛔ **`customer:get:all` is called out by the vendor as a SENSITIVE scope**
  (all-customer access; needed for caller-ID lookup of customers who never ordered
  through us). Request it explicitly.
- **Credits observed:** reads 0–1 credit; **writes (create order, create invoice,
  charge card) are 18 credits** — a write is ~18× a read. Price per credit unknown.

### Orders
- `POST /orders` (order:post, 18cr) — OrderMethod `Pickup|Delivery`; 201 +
  `Location: /orders/id/{id}`. ⛔ Requires **`X-Customer-Pin` header (string ≤8)**
  when payment is `OnAccount` or a stored card (`cardId`); NOT for ad-hoc temp
  card / cash / food-stamp.
- `GET /orders/id/{id}`, `GET /orders/external/{externalOrderId}` (0cr, own).

### Payment webhook (their → us)
- Order creation may carry `paymentEndpoint: { url, headers }`. **At checkout their
  POS POSTs to that URL and WE process the payment**, replying 200 with
  `status: accepted|rejected`, `authorizationNumber`, per-method `payments[]`.
  ⛔ **30-second timeout; failure leaves the invoice unpaid for manual processing.**
  ⛔ `charges[].eligibleChargeAmount` is the MAXIMUM chargeable per method
  (`CreditCard|FoodStamps`), not a suggested amount — the sum across methods can
  exceed `totalAmountDue`. Without a webhook, orders stay unpaid.
  ⛔ This makes Loopcom a payment processor in their flow — Sola wiring + Izzy's
  explicit sign-off before ever going live.

### Products
- `GET /products` (product:get, 1cr, all) — `take` (max 100) / `cursor` /
  `lastMod` / `lastSold` / `includeInactive`. Incremental sync: store `lastMod`,
  re-query with it, keep ALL original params on cursor pages.
  ⛔ `lastMod` moves on internal-field changes too — it can update with no visible
  API-field change; that is what makes it safe for catch-all syncing.
- `GET /products/id/{id}`, `GET /products/code/{code}` (1cr).
- ⛔ **`priceQty` is a DIVISOR: unit price = price ÷ priceQty** (bulk "2 for $10",
  by-weight, multi-packs). Ignoring it mis-prices items.

### Invoices
- `POST /invoices` (invoice:post, 18cr) — direct invoice with line items; needs
  `customerId` OR an inline `customer` object (⛔ the only customer-create shown —
  there is no standalone create-customer endpoint in these pages).
  `externalInvoiceId` (≤20 chars) is the idempotency key → **409 on duplicate**.
  Line items: `productId` OR `productCode`, quantity, unitPrice, subtotal,
  isTaxable, discountAmount. Payments array: `APICreditCard|APIFoodStamp`,
  amount, `referenceNo` (≤15), dateTime, masked card fields.
- Reads (0cr): `/invoices/id/{id}`, `/invoices/order/{orderId}`,
  `/invoices/externalinvoiceid/{id}`, `/invoices/externalorderid/{id}`
  (⛔ `/invoices/external/{externalOrderId}` is DEPRECATED for the latter).

### Customers
- `GET /customers` (1cr, all+sensitive) — take/cursor/lastMod.
- `GET /customers/id/{id}` (1cr, own|all),
  **`GET /customers/phonenumber/{10-digit}`** (1cr) and
  `GET /customers/phonenumber/{phone}/id` (customerid:get, 1cr) — the caller-ID
  screen-pop primitives.
- **Cards**: `GET /customers/id/{id}/cards` + `/cards/{cardId}` (0cr — masked,
  exp, issuer only; never full numbers), `POST /customers/id/{id}/cards`
  (customercard:post, 1cr) — full card number + cvv in the request, tokenized by
  their gateway, never stored raw; zip + houseNumber for AVS.
- **Balance**: `GET /customers/id/{id}/balance` and
  `/customers/phonenumber/{phone}/balance` (customerbalance:get, 1cr) —
  ⛔ **both REQUIRE `X-Customer-Pin`**. Positive = customer owes the store.
- **Charges**: `POST /customers/id/{customerId}/charges` (customercharge:post,
  18cr, ⛔ requires `X-Customer-Pin`) — `externalId` (≤20) idempotency → 409 replay
  protection; amount 0.01–99999.99; `cardId` XOR inline `card`; returns
  amountCharged, authCode, referenceNo, maskedCardNumber, **newBalance**.
  ⛔ **REFUNDS ARE NOT SUPPORTED via the API** — store-side only.

### Vendor best-practice notes
Honor `Retry-After` + exponential backoff on 429; webhook replies within 30 s;
`lastMod` for incremental sync; `paymentEndpoint` for automated payment handling.

## What this unblocks / enables (full pitch in the artifact above)

1. **Delivery tracker Phase 10** — replace `MockOrderSourceAdapter`
   (`apps/api/src/delivery/routes.ts:24`) with a real POS adapter. The delivery
   system's own ingest door (`POST /internal/delivery/orders`) already models
   source events; the fit question is push-vs-poll and the "own orders only" limit.
2. **Caller-ID screen pop** on Gesheft's Phone Orders queue (~2,020 calls/30d)
   via phonenumber lookup; contact auto-fill/sync via customers+lastMod.
3. **Self-service "where's my order"** by IVR/SMS — the delivery module's
   `voiceStatus.ts` / SMS command parsing were built for exactly this.
4. **House-account balance + pay-by-phone**: X-Customer-Pin maps 1:1 onto IVR DTMF
   entry; stored-card charge with idempotent externalId. Money — Izzy's sign-off,
   stored cards only (⛔ never voice-captured card numbers —
   [[dtmf-masking-cannot-be-self-administered]]).
5. **Assistant order-taking (shop-by-text/phone)** with the synced catalog; the
   agent's tool registry + Yiddish bridge already exist.
6. **Checkout payment automation** via their paymentEndpoint webhook — deepest and
   most sensitive; last.

## Open questions for Gesheft (nobody has asked yet)
- An actual API key, and which scopes they'll grant (incl. sensitive
  `customer:get:all`).
- Credit pricing / monthly allowance.
- The missing doc sections (Customer PIN provisioning, rate limits, data models).
- Whether their vendor can push/expose orders NOT created with our key
  (in-store + their own phone-entry orders) — decides the delivery design.
- Whether customers already have PINs set, and how they learn them.

⏳ **NOT PROVEN: nothing has been called.** Every fact above is from reading their
20-page printout, not from a live request. First live step is a 0-credit read
(`GET /orders/id/{x}` with the real key) to prove auth, then a 1-credit product
read to learn the response shapes the printout doesn't show (product/customer
response bodies are NOT documented in these pages).
