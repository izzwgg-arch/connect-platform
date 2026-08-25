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

## §8 — IZZY'S DIRECTIVE (2026-08-25 evening, in-chat) — the build this API feeds

⛔ **An earlier session summary claimed this section existed before it did — it was
written 2026-08-25 late evening.** Nothing here is built; these are his decisions.

1. **Pay-by-phone IVR**: caller recognized by phone number → PIN → hear balance →
   choose ANY partial amount → charge the stored card via the POS charges endpoint
   (never direct Sola for Gesheft — the POS charge keeps their books/balance in
   sync and uses their Sola underneath). ⛔ Stored cards only; new-card capture by
   phone stays a separate decision pending PhonePay pricing (see the Sola DTMF
   handoff of the same date).
2. **One DIY IVR** for it (IVR Studio + a new payment dialplan context — PBX write,
   needs a mandate when built).
3. **Yiddish voicemail orders → DRAFT orders**: transcription is already live
   (~97-99% by his estimate); the agent parses the transcript against the synced
   catalog into a draft; a REP reviews/corrects/approves; only approval posts the
   real order. ⛔ Corrections are CAPTURED as training data (guess vs corrected)
   — the measured correction rate is the evidence gate for later auto-submit.
   Drafts live in Connect; the POS has no draft concept, which fits.
4. **Text-message orders → same draft flow** (Gesheft SMS already lands in
   Connect). Screen pop on inbound calls shows the POS account.

**Architecture decisions, same conversation:**
- **The CRM is the rep cockpit** — reuse screen pop, timeline, work queue,
  permissions; the genuinely new pieces are the line-item draft-order editor, the
  correction capture, and the POS bridge. ⛔ LINK to POS accounts, never copy them
  into a third customer list — the POS stays source of truth for account/balance/
  cards (stale-mirror class).
- ⛔⛔ **CRM MODES, per industry**: the current CRM is cold-calling shaped (cash
  advance) and **Izzy is done with cold calling** — do not build on that shape.
  A per-tenant MODE decides which CRM screens/vocabulary a tenant sees;
  first new mode = **supermarket** (account-centric records, order drafts,
  order history, email/SMS specials). Cold-calling screens get mode-gated, not
  deleted. ⛔ A per-tenant mode flag that some code paths ignore is worse than no
  flag (the HIPAA-tier rule) — enforce server-side.
- ⛔⛔ **THE POS/TRACKING API IS MULTI-TENANT TOO (Izzy, same evening): "I should
  be able to assign the API key to a tenant from where I enter the API key and be
  able to add as many as I like. Sola and Tracking system."** ONE admin
  integration-keys screen — pick tenant, pick integration (Sola | Tracking
  system), paste key; unlimited rows; encrypted, masked after save, strictly
  tenant-scoped. ⛔ The Phase-1 POS bridge must therefore be tenant-keyed FROM
  DAY ONE — never a Gesheft-hardcoded key that later gets "made multi-tenant".
- ⛔⛔ **SOLA GOES MULTI-TENANT**: every payment-integrated customer will be on
  Sola; each tenant gets its OWN Sola API key (their merchant account, their
  name — standing rule), stored encrypted, tenant-scoped. ⛔ The existing
  `solaGateway.ts` runs CONNECT'S OWN billing on Connect's key — the tenant
  payment layer must be a SEPARATE tenant-keyed client that can never fall back
  to the platform key (a fallback charges the wrong merchant's account; fail
  closed on a missing tenant key). `ProviderCredential`/`AgentSecret` patterns
  are the storage precedent.
- ⛔ **Email specials from the CRM have a SENDING problem to solve first**: all
  platform mail rides ONE Google mailbox with a 500/day allowance
  ([[own-mailboxes-yes-but-sending-is-the-trap]]) — marketing blasts cannot ride
  it. The send path already accepts SENDGRID/SMTP providers by config; move
  marketing sending to SES/SendGrid (with unsubscribe/CAN-SPAM handling) before
  any specials feature ships. SMS specials = the 10DLC/TCPA lane already
  documented in the shop-by-text handoff.

## §9 — The FULL PLAN exists and is AWAITING IZZY'S APPROVAL (2026-08-25 late)

⛔ **Izzy's explicit gate, twice in one message: a full plan before ANY build, and
MOCKUPS he sees before ANY UI page is built.** The plan is published:
<https://claude.ai/code/artifact/0312b85a-9676-4e66-9cec-0d40bd762ff3> — 8 phases
(0 keys/answers → 1 POS bridge + screen pop → 2 CRM mode system + supermarket
cockpit → 3 draft orders with correction capture → 4 pay-by-phone → 5 multi-tenant
Sola → 6 specials incl. the marketing-mail sending lane → 7 automation graduation
+ delivery tie-in), six named mockups (M1 pop, M2 mode nav/account card, M3 draft
review, M4 IVR storyboard, M5 specials composer, M6 mode picker + Sola key
screen), and the safety rails (no platform-key fallback, stored cards only, drafts
never auto-post, server-side mode enforcement). ⛔ **Do not start building any of
it without his approval of the plan AND the relevant mockup.** ⏳ The Gesheft API
key has still not actually been received (he said "giving it to you now" twice;
no key has appeared in any message).

## §10 — The payment IVR's VOICE exists: 18 Kristen prompts generated (2026-08-25 night)

Izzy: *"create the IVR for the payment system with 11 labs and use Kristin's
voice."* ✅ **All 18 prompts of the pay-by-phone call script were generated with
ElevenLabs in Kristen's voice** (`CvD6hF1BJzAFN428j1cO`, "Warm, Corporate and
Steady" — ⛔ never the OTHER Kristen `dfeOmy6Uay63tNhyO99j`, the ad read), via the
real `synthesiseSpeech` (8 kHz phone-native, IVR tuning, one call per prompt,
never retried). 1,054 characters billed. Files delivered to Izzy as WAVs + zip;
server stash kept at **loopcom `/root/gesheft-pay-ivr/`** (18 wavs).
⛔ **REVIEW ARTIFACTS ONLY — nothing was written to any prompt catalog, tenant,
or the PBX.** The IVR itself (dialplan payment context, POS charge wiring) is
Phase 4 and remains gated on plan approval + the M4 script sign-off + a PBX
window + the API key that has still not arrived.
- ⛔ **`listElevenLabsVoices` objects do NOT expose `voice_id`** — an existence
  check against the list reads every voice as absent. The right gate is a direct
  1-word synthesis probe (the provider accepts or refuses the id).
- ⛔ **The script splices dynamic numbers between fixed prompts**
  (balance_intro → SayNumber → "dollars"/"and"/"cents" as Kristen fragments) —
  but **Asterisk's own digit sounds are Allison's voice**, so amounts will
  voice-switch mid-sentence unless a Kristen digit set (0–20, tens, hundred,
  thousand) is generated later. Flagged to Izzy, not yet decided.
- ⛔ **The prompts are ENGLISH; Gesheft's customers are largely Yiddish
  speakers** and no TTS on earth speaks Yiddish
  ([[no-voice-provider-speaks-yiddish]]). Options if wanted: a human recording
  run through the voice changer, or bilingual keys. Izzy's call.
- ✅ **SCRIPT REVISIONS, same night (Izzy):** (1) **unrecognized caller → offer
  account lookup by keyed-in phone number** (the API supports lookup by any
  number) — revised prompt 13 + new 19 (lookup not found) + 20 (connect to a
  person); (2) ⛔⛔ **AMOUNT ENTRY USES STAR AS THE DECIMAL POINT** — "2 5 * 3 7"
  = $25.37, pound to finish — **and the IVR will be BUILT that way**; prompt 05
  rewritten. (3) **A SECOND FULL SET exists in AMAZON POLLY, voice `Stephen`,
  generative engine** (Izzy asked for both voices to choose from). Server
  stashes on loopcom: `/root/gesheft-pay-ivr/` (Kristen v1, 05+13 superseded),
  `/root/gesheft-pay-ivr-kristen-v2/` (the 4 revised), `/root/gesheft-pay-ivr-stephen/`
  (all 20). Both full sets delivered to Izzy as zips. Still review-only.
  ⛔ **Polly's mapped voice objects key on `voiceId`** (`listPollyVoices`), and
  ElevenLabs' on neither `voice_id` nor `id` — BOTH providers' list objects
  defeated a naive `find` this session; probe by synthesising, or read the
  mapper's interface first.
- ⛔⛔ **THE PAYMENT IVR SHIPS IN TWO VOICES BY DESIGN (Izzy, same night): "two
  IVRs for payment that customers can choose from: male and female"** — Stephen
  (Polly) and Kristen (ElevenLabs) are BOTH kept as complete parallel sets; the
  voice is a per-line setting. Any future prompt change must be generated in
  BOTH voices or they drift.
- ⛔ **"Gesheft" was pronounced with a soft G (giraffe); Izzy wants hard G
  (get).** Four welcome candidates were generated and sent for his pick:
  A = Stephen generative + SSML `<phoneme alphabet="ipa" ph="ɡəˈʃɛft">`,
  B = Stephen neural + same phoneme, C = Stephen generative + respelling
  "Guh-sheft" (plain text), D = Kristen + the respelling (ElevenLabs' flash
  model takes no IPA — respelling is the ElevenLabs pronunciation tool).
  ⛔ Polly generative ACCEPTED the phoneme SSML (no refusal) but Polly
  generative is the engine already proven to accept-and-discard prosody markup
  — whether A actually honours the phoneme is for EARS to judge, which is why
  B and C exist. Server stash: loopcom `/root/gesheft-welcome-fix/`.
  ✅ **DECIDED: Izzy picked B** (Stephen NEURAL + IPA phoneme) — and clarified
  **Kristen's ORIGINAL welcome already said Gesheft correctly**, so candidate D
  is discarded and her v1 welcome stands.
- ✅✅ **THE FINAL VOICE SETS EXIST — 50 files per voice** (20 prompts + a
  30-word NUMBER set: zero–twenty, tens, hundred, thousand — so spliced
  balances/amounts never voice-switch to Asterisk's Allison).
  ⛔ **Stephen's ENTIRE set was regenerated on NEURAL** — mixing the chosen
  neural welcome with the earlier generative prompts is audible back-to-back;
  one engine per voice set is the rule now, and **Stephen = neural, always**
  (neural also honours the phoneme markup, which generative may discard).
  Kristen = her existing ElevenLabs set + numbers. Server stashes on loopcom:
  **`/root/stephen-neural/` (the 50 canonical Stephen files)** and
  `/root/kristen-numbers/`; Kristen's canonical prompt files = the v1 set
  (`/root/gesheft-pay-ivr/`) with 05+13 replaced from
  `/root/gesheft-pay-ivr-kristen-v2/` + 19/20 from there + numbers. Both final
  zips delivered to Izzy. Still review artifacts — nothing on the PBX or in any
  catalog.
- ⛔⛔ **PIN FLOW RULE (Izzy, 2026-08-25 night): caller ID matching the account's
  own number = NO PIN asked to hear the balance or pay; a caller from a
  DIFFERENT number (keyed-in account lookup) MUST key the PIN.** Plus: balance
  and payment are separate options, and (Izzy, next message) **a MAIN MENU comes
  first: "To hear your balance, press one. To make a payment, press two."**
  New prompts, both voices: 22_main_menu, and 21_menu_after_balance re-recorded
  so keys are CONSISTENT call-wide (**1 = balance, 2 = payment, everywhere** —
  its first cut had payment on 1 and would have clashed). Sets are 52 files
  each; loopcom stashes `/root/stephen-neural/` + `/root/kristen-extra/` updated.
  ⛔⛔ **The wrinkle nobody may paper over: the API requires X-Customer-Pin on
  EVERY balance/charge call regardless of who's calling — the IVR cannot simply
  skip it.** Two ways to deliver Izzy's UX, in preference order: (a) ask Gesheft
  whether PIN enforcement is configurable / how the missing PIN docs handle
  trusted caller ID; (b) **one-time PIN enrollment** — the first call from the
  account's own number asks the PIN once, Loopcom stores it encrypted bound to
  that account+number pair, and silently supplies it on later matching-caller-ID
  calls; a non-matching caller NEVER gets the stored PIN applied (that is the
  PIN's whole job). ⛔ Caller-ID spoofing is the accepted residual risk of the
  matching-number shortcut — same trade every bank IVR makes; the stored-card-
  only rule bounds the damage (an attacker can only pay the victim's bill with
  the victim's card).
- ⛔ **PIN answers (Izzy asked directly):** the PIN step IS in the IVR script
  because **the API requires X-Customer-Pin for balance and charges — their
  rule, non-negotiable**; whether every account HAS a PIN is UNKNOWN (the
  Customer PIN doc section is missing) and is the top ask-Gesheft item; if
  accounts lack PINs the IVR needs a no-PIN fallback or Gesheft issues PINs
  before launch.

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
