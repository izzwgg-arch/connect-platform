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

## §11 — ORDERS-DESK REQUIREMENTS + THE FIRST MOCKUPS (2026-08-25 late night)

**Izzy's added requirements for the draft-order build:**
- ⛔ **Learn from the EXISTING corpus before going live**: months of Gesheft
  voicemails (already transcribed) + text threads sit in Connect — study how
  people phrase orders; no need to back-transcribe everything.
- ⛔ **WIC rule**: a customer mentioning they're paying with WIC → that goes
  **automatically into the order's COMMENTS**; any OTHER remark ("leave it by
  the side door") → the order's **NOTES**. (POS invoices have `memo`; the
  order-object fields are in the missing Data Models section — confirm where
  comments vs notes land on THEIR side.)
- ⛔ **The Orders page lives inside Loopcom**: drafts arrive with a **button
  opening the original source** (the text thread or the voicemail player) so the
  rep verifies the pre-fill against what the customer actually sent, then puts
  the order through; **Loopcom keeps tracking it afterward** (register status +
  delivery tracker).
- **PIN flow addition**: a MAIN MENU after recognition (1 = balance,
  2 = payment, consistent everywhere — see §10 notes).

✅ **MOCKUPS ROUND 1 PUBLISHED ("The Orders Desk"):**
<https://claude.ai/code/artifact/1dd4bc4c-003f-4481-9185-ecacc1550f75> — four
screens: Orders page (draft queue + sent-with-tracking), draft review (Yiddish
transcript + translation with item-mapping highlights beside the editable order;
WIC auto-comment; notes; correction capture called out), the call screen pop
with the POS account, and settings (mode picker + integration keys). All names
fabricated. ✅ **Izzy on v1: "the mock-ups are good" but wanted them "a lot
more SaaS, a lot more professional, fully consistent with the Connect theme" —
v2 REPUBLISHED at the same URL** using the portal's EXACT globals.css tokens
(dark `#0c1218/#141f2b/#22a8ff/#26374a…` bare-:root, light `#f6f8fb/#3b82f6…`
via data-theme, Inter, real chrome: topbar + sectioned sidebar, KPI strip, SVG
icons — no emoji). ⏳ v2 awaiting his approval; M5 (specials composer) not yet
drawn.
⛔ Per the standing rule, when these are BUILT the built-vs-mockup comparison
must be published before claiming a match.

## §12 — DELIVERY-TRACKING REQUIREMENTS (Izzy, 2026-08-25 night) + mockups v3

**His spec for the dispatcher/driver side** (extends the dormant delivery module
— see the CLAUDE.md delivery section; most machinery exists, these finish it):
- **Full live map in the Gesheft UI**: every driver's position, his route, stops
  done/remaining, ETAs — plus per-driver cards. (The `/tracking/map` page +
  `DriverLocationSample` exist; the GPS feed was never wired — that's the gap.)
- ⛔ **Calling a driver rings his REAL CELL, not an app** — drivers will NOT have
  the Loopcom phone app; the rep clicks Call and Loopcom dials the cell number
  on the driver's record. (Driver's mobile app is ONLY the delivery flow:
  runs/scans/GPS.)
- **Driver-login page**: create a driver with name + cell + email → Loopcom
  emails a set-your-password link for the driver app; name/number pre-filled in
  the app. (`DriverProfile` + the USER_INVITE machinery cover most of this;
  needs the clean Add-a-driver screen + driver-scoped invite.)
- ⛔⛔ **NO OFF SWITCH IN THE DRIVER APP** — tracking runs whenever he's on a
  run; the only escape is revoking the OS location permission, and **that must
  fire a dispatcher notification immediately** (banner + amber driver card +
  last-known position on the map). The dashboard's `staleGps` tile is currently
  a hardcoded 0 — this requirement is what makes it real.
✅ **Mockups v3 republished (same URL)** adding screen 4 (live map: SVG map,
route with done-checks/numbered remaining stops, GPS-off banner + last-known
marker, call-cell buttons) and screen 5 (Drivers: table with app status/last
location, Add-a-driver panel with the setup-email flow, resend for
not-yet-set-up invites), then **screen 7: the driver SETUP EMAIL** (Izzy's
ask) — drawn in the Loopcom email shell language: wordmark header, "Gesheft
Kosher set you up as a delivery driver", Choose-my-password CTA, his
name/phone/sign-in shown not asked, get-the-app steps, footer naming the store;
annotated as riding the real hardened shell + resend-safe (same link, never a
second account). **Plus (Izzy, next message): NUMBERS-AND-ENTER item entry** —
the order editor's quick-add box always holds focus: punch the item number,
Enter adds the line at catalog price (`GET /products/code/{code}` is the exact
primitive) and the box empties/refocuses for the next; mouse never needed;
refined (Izzy, next message) into ONE unified box: item numbers AND names in
the same field, live auto-suggest as you type, ↓/↑ moves through suggestions,
Enter adds the highlighted item and refocuses empty for the next — mouse never
needed. Suggest data = the synced catalog; number path = code lookup. Mockups
v6 republished with the dropdown drawn open mid-keystroke ("chal" → 4
suggestions, keyboard legend bar). **v7 after Izzy's design notes:** the REAL
wordmark (`loopcom-wordmark-email-336.png` embedded as a data URI — artifacts
cannot load external images) replaces the styled-text logo in every topbar and
the email; the oversized global search was shrunk to portal scale; ⛔ **the v6
dark/light toggle NEVER WORKED — inline `onclick=` handlers are blocked by the
artifact CSP; bind with addEventListener** (that is why he "only saw the email
in light"); and the setup email is now the PRODUCTION `loopcomEmailShell` design
verbatim (white card on #f1f4f8, 168×30 wordmark, 2px 22a8ff→4f7bff rule, the
real flat ctaButton, footer naming the store) rendered THREE ways — phone frame
(mobile media-query behavior: 142px logo, 22px padding, block button), Gmail
browser, and an Outlook window (fixed 600px, noted as identical by the shell's
own mso engineering). **v8 (Izzy: "you're giving me different incoming call
screens than the actual Gesheft"): screen 3 is now the REAL Gesheft surface** —
a Windows-desktop scene with the MINI DIALER ringing in the corner (caller
identified + account line on the ring card, Answer/Decline, mini tab bar) and
the main Loopcom window ALREADY OPEN on a NEW ORDER inside the caller's account
(quick-add focused "punch while you talk", her file/usuals beside it, pill
"opened by the incoming call"; on-ring vs on-answer noted as a setting).
⛔ Do not draw generic call screens for Gesheft — their reps live in the
desktop app + mini dialer. ⛔ Artifact-editing traps hit here: inline `onclick=`
handlers are CSP-blocked (bind listeners; also apply data-theme to BODY and
duplicate token sets on body[data-theme] so the viewer's own root stamp can't
fight the toggle), and **a concurrent session republished the same artifact
mid-edit (409)** — resolve by WebFetching the URL (full HTML lands in
tool-results/), stripping the frame-runtime wrapper, and diffing before
publishing the merge; never force blind. The parallel session's "Loopcom
Driver" separate-APK decision (memory: delivery-tracking file) is reflected in
the setup email's step 1.
**v9 (Izzy, 2026-08-26 — THE ORDER TWIN; this supersedes v8's
main-window-pre-open design for the Windows flow):** when a call rings, the
mini dialer pops; **the moment somebody ANSWERS, a SECOND mini window — a twin
of the mini dialer, same size — pops beside it: the new-order window.** His
spec, verbatim requirements:
- The twin pops only for **whoever answered** the call.
- **Known caller**: twin opens already inside her account — balance, card on
  file, the quick-add box focused, and **her LAST THREE ORDERS visible** so the
  rep sees what she usually takes, plus a **"See her usual order" button**.
- **Unknown number on the Phone Orders queue**: the twin opens **ready to take
  the account's phone number — keyboard focus already in the field, no mouse
  click needed** the second the call is answered; matches show as you type.
- ⛔ **The twin must NOT disappear until the order is put through** ("everything
  is good") — a call can't end with a half-taken order lost.
- **Later phase**: once enough order history exists, the twin **auto-suggests
  her usual order** for one-tap confirm (explicitly "eventually, once the
  system starts knowing the customers").
- **No Windows app → the browser does the same thing**: answering in the
  browser pops the new-order page in that account, cursor in the item box.
Screen 3 redrawn as three frames (known-caller desktop scene, unknown-caller
lookup scene, browser fallback) + 6 annotations; republished same URL, label
`v9-order-twin`.
⏳ Awaiting Izzy's approval of the full set (now v9).

## §13 — THE DRIVER APP IS A SEPARATE APK (Izzy, 2026-08-25 late night)

⛔⛔ **Izzy rejected the driver-flow-inside-the-main-app path: "I want to make it
a separate APK because I want to be able to give it to people without a phone,
or make a switch that turns the app into the tracking and turns off the phone
side."** Decision taken: a **separate "Loopcom Driver" APK**, NOT a mode switch
— a switch would entangle with the SIP/call path (the most regression-sensitive
code in the fleet), while a separate app simply never contains it.
- Same codebase (`apps/mobile`), second build target: **own applicationId
  (permanent once chosen), own icon/name, own signing keystore (create once,
  BACK IT UP off-machine — the Play-keystore lesson)**; installs alongside the
  main app; boots straight into the delivery flow; permissions = location +
  camera, ⛔ NO microphone, no SIP stack, no call push channels.
- Server side unchanged — same delivery APIs; a driver login is a User +
  `DriverProfile`, no extension needed.
- Publishing = a second artifact beside `connectcomms-latest.apk` on the
  download page; the driver setup email's step 1 says **"Get the Loopcom
  Driver app"** (applied to all three email renderings in the mockups and
  republished).
- ⛔ The fork session working the mockups found that **v6's dark/light toggle
  never worked — inline `onclick=` is blocked by the artifact CSP; bind with
  addEventListener** (recorded in its v7 note above; kept here too since this
  session authored the broken toggle).

### §13b — Driver APP mockups added (screen 8, same artifact)

Izzy: "I don't see any app markups in there" — correct; the set was
dispatcher-side only. **Screen 8 added: four phone frames of the Loopcom Driver
app** (morning runs list with "Start run" + location-notice, mid-run with
Location-on chip / next-stop card / customer note carried from the voicemail,
stop-finish with proof options, and the **location-off full-screen blocker**:
"run paused, dispatcher notified"). Republished at the same URL after two
publish conflicts with the fork session — ⛔ both sessions edit the SAME
scratchpad file; re-read the live artifact (WebFetch) before publishing, verify
disk ⊇ live by grepping the saved copy, then retry — never force.

### §13c — Navigation choice + the barcode question (2026-08-25)

- **Navigate offers the driver a choice** (Izzy): Waze, Google Maps, or Apple
  Maps on the iPhone build; "Always use this app" remembers it. Mockup frame
  added to screen 8 (the `psheet` chooser).
- **Order tracking is scan-to-track by a system-generated barcode** (Izzy) —
  and ⛔ **the POS API has NO barcode facility** (grepped the whole intake: zero
  barcode/UPC/label hits; the printout is incomplete, but nothing points at
  one). **Ours already works exactly this way**: `orderService.ts` mints a
  `labelToken` per order at ingest (returned ONCE raw; stored HASHED in
  `DeliveryOrderIdentifier`, kind LABEL, tenant-unique), and
  `POST /mobile/delivery/scan` → `scanLabel` (idempotent clientOpId,
  tenant/store-safe) transitions READY→SCANNED→ASSIGNED — the scan IS the
  moment tracking attaches to the driver. ⛔ **The missing piece is PRINTING**:
  no route renders the token as a barcode label (grep label in routes.ts = 0
  print route). Plan: the Orders desk's put-through step generates the printed
  label (Code 128/QR of the raw token; the POS `externalInvoiceId` ties our
  order to theirs). Mockup annotation 5 records it customer-facing.

### §13d — Scan resolution DESIGN APPROVED (Izzy, 2026-08-25 night): order-number smart search, never items

Izzy: "For now, make it the order number... when we test it tomorrow, we'll
find out. Yes, build it this way. You can even make it smarter... search the
system for that number, the whole system... Only if it's an order, not an
item."

- **The scan resolver searches ORDER IDENTIFIERS ONLY**: our raw labelToken
  (hashed lookup, existing) + the POS order id + externalOrderId + invoice
  number/externalInvoiceId, stored per order at ingest as additional
  `DeliveryOrderIdentifier` kinds (e.g. POS_ORDER / POS_INVOICE, value hashed
  like LABEL). First match wins; tenant-scoped as today.
- ⛔ **Items are excluded BY CONSTRUCTION** — the search never touches the
  product catalog, so a scanned UPC can never resolve to an order. No
  blocklist logic needed; keep it structural.
- Unknown number → explicit "not an order" on the driver screen WITH the
  scanned number (never silent). Our own printed label stays the fallback if
  the sticker's number turns out not to be in the API.
- ⏳ **NO API KEY EXISTS YET** (Izzy acknowledged); first live test planned
  "tomorrow" (2026-08-26): pull a real order, enumerate its numbers, scan a
  real sticker, see which matches. ⛔ This approves the scan-resolution
  DESIGN; the overall plan/mockup sign-off gate for the build is unchanged.

### §14 — SMART CONVERSATIONAL ORDER-TAKING IVR (Izzy, 2026-08-25 night): recommendation given, NOT built

Izzy: an interactive smart IVR that takes orders "instead of a human… understand
people and be very human-like"; open-source vs "the OpenAI model we already
have"; ⛔ **multi-tenant: every tenant enters their OWN OpenAI API key**; must
understand item numbers/names/codes; MALE voice; efficient + professional +
sustainable for our call volume.

**Recommendation (delivered in chat, sources verified 2026-08-25):**
- **Brain = OpenAI realtime speech-to-speech (`gpt-realtime` family)**, ~$0.06–
  0.11/min (mini $0.02–0.05/min); barge-in native. **Plumbing = OUR Asterisk**:
  ARI ExternalMedia bridge → Realtime WebSocket (proven public pattern, incl.
  DTMF human-handoff), or OpenAI's native SIP connector as the simpler variant.
  ⛔ NO middleman voice platform (Vapi/Retell/Bland — per-minute markup between
  our own PBX and OpenAI). Open-source harnesses exist (LiveKit Agents — we
  self-host LiveKit already; Pipecat) but apps/telephony + ARI already fill
  that role; keep the harness ours, the model rented and swappable.
- **Items are a TOOL, not speech**: the model calls our catalog search (number/
  name/code — same search as the Orders desk auto-suggest, POS catalog synced
  via lastMod) and READS BACK name+price; orders land in the Orders desk as
  AI-taken drafts first, straight-through once trusted (same learn-then-
  autopilot rule as voicemail orders; WIC→comments etc. unchanged).
- **Male voice = Cedar** (OpenAI's production-recommended voice, no surcharge).
  Stephen stays on the prerecorded payment line — different system.
- **Multi-tenant OpenAI keys**: the §8 integration-keys screen grows a third
  integration — Sola | Tracking | **OpenAI** — per-tenant, encrypted;
  ⛔ **NO fallback to the platform key** (same rule as Sola: a runaway call must
  never bill us) + per-tenant minutes cap/alert.
- **Volume math**: Gesheft ~2,020 phone-order calls/30d × ~4 min ≈ $250–900/mo
  on the tenant's key.
- ⛔ **Yiddish is the honest limit**: no provider does human-like real-time
  Yiddish. Design = language detect at greeting → Yiddish → voicemail-order
  path (existing draft pipeline) or human; English/Spanish/Hebrew → AI. Never
  promise conversational Yiddish. AI-down = calls fall to the human queue
  exactly as today (additive, never a replacement).
- ⏳ NOT built, not in the published plan artifact yet — becomes its own phase
  at the next plan revision; the plan/mockup approval gates are unchanged.
  ⛔ Another fork session exists and may be working the same question.

### §13e — THE LOOPCOM DRIVER APK IS BUILT (Izzy: "Build an APK", 2026-08-25 night) — commit `3544f2fa`

- **Second app from the same codebase, env-gated**: `CONNECT_DRIVER_APP=1` in
  `android/app/build.gradle` flips applicationId → `com.loopcom.driver`, swaps
  in `src/driver/AndroidManifest.xml`, swaps the JS entry to `index.driver.js`,
  and SKIPS the google-services plugin (its json has no client for the driver
  id; FirebaseInitProvider no-ops → no FCM in the driver app, by design).
  ⛔ **Deliberately NOT productFlavors** — flavors rename output paths/tasks and
  would break android-ship.ps1 + android-play-bundle.ps1. Unset env = the phone
  build is byte-path identical.
- **The driver manifest** grants location (fine/coarse + FOREGROUND_SERVICE_LOCATION)
  and camera, and `tools:node="remove"`s RECORD_AUDIO/telecom/contacts that
  library manifests (webrtc) would merge back in. ⛔ It keeps the
  LauncherBlue/Navy aliases — ThemeContext flips them by component name at boot
  and a missing alias would reject on every launch (caught, but noisy).
- **The missing wiring is CONNECTED now**: `runTracking.ts` ties
  `/mobile/delivery/tracking/start|end` to `trackingService`'s foreground task;
  RunsScreen has Start run / "Location on — End run"; permission refusal ends
  the server session immediately (dispatcher never watches an empty map);
  sign-out force-ends tracking.
- **The map setting (Izzy)**: `navPrefs.ts` — mapMode inapp|external + navApp
  waze|google|apple(iOS-only in UI). `DriverMapScreen` = Leaflet/OSM in a
  react-native-webview (NEW DEP ^13.17.0 — ⛔ its class typing collapses to
  `never` under React 19 types; cast via ComponentClass<WebViewProps>),
  numbered stop pins, route polyline, follow-me, giant next-stop bar with
  Navigate (external handoff always available). `DriverSettingsScreen` — map
  mode, nav app, sign-out; ⛔ deliberately NO tracking switch (the no-off-switch
  rule). Server side: navLinks/routes grew `app=apple`;
  `listRunsForDriver` select widened (lat/lng/customerName/instructions).
- **`src/driver/appKind.ts`**: index.driver.js calls `markDriverApp()`;
  shared screens gate driver-only chrome on `isDriverApp()` — the phone app's
  navigator doesn't register DriverMap/DriverSettings and would crash on tap.
- **Signing: debug keystore, same as every sideload build** (house practice —
  the fleet convention). Play upload key comes later with its own decision.
- ✅ **BUILT AND ARTIFACT-VERIFIED (aapt + bundle grep, 2026-08-25 ~20:30):**
  `apps/mobile/dist/loopcom-driver-1.0.0+20260825-driver1.apk` (62,474,067 b,
  versionCode 260825201). Package `com.loopcom.driver`, label `Loopcom
  Driver`; location+camera IN; **RECORD_AUDIO / MANAGE_OWN_CALLS / contacts /
  mic+phoneCall FGS / ConnectionService all read 0**; the JS bundle greps 0
  for sipWakeRegistrar/backgroundCallTask and 3 for driver markers — the
  driver entry really was bundled. Delivered to Izzy as a file; no phone was
  attached, so it is NOT installed anywhere and NOT on the download page.
  ⛔ `com.google.firebase.messaging.FirebaseMessagingService` (the SDK's base
  service, from its library manifest) IS declared — inert with no
  google-services config; do not chase it as a leak.
  ⛔ Two library-manifest permissions survive (CALL_PHONE, READ_PHONE_NUMBERS,
  from callkeep's lib manifest) — cosmetic follow-up: tools:node=remove them.
  ⛔ SHIP_VERSION_CODE must fit a 32-bit Int — `2608252030` overflowed
  `.toInteger()` and failed the build; 9 digits (`260825201`) works.
- ⏳ **NOT PROVEN: never launched on a device.** Acceptance: install beside
  the phone app → boots to the Loopcom Driver sign-in → sign in as a driver
  user → Start run asks for location and the dispatcher map moves. Needs the
  server side enabled (env + pilot tenant per DELIVERY_RUNBOOK §4) and a
  DriverProfile — none exist yet.
### §15 — VOICE AGENT BUILT, COMMITTED, AND API-DEPLOYED; PBX/env steps await Izzy's live word — 2026-08-26

Izzy: "Build it end to end. Do not stop until you have tested it and it is
production-ready. After you test it, stress the fuck out of it." (This order
overrides the mockups-before-UI gate for THIS feature's screens.)

**Architecture (all reuses the fork's supermarket module, no duplication):**
OpenAI `gpt-realtime` bridged from OUR Asterisk. PBX dialplan
`[connect-voice-agent]` answers a tenant's DID, announces the call over AMI
(`UserEvent(ConnectVoiceAgent, UUID, Tenant, ...)`, the ConnectWake lane), and
`AudioSocket(uuid, loopcom:4590)` streams μ-law 8 kHz to a new TCP server in
apps/telephony. That server (`apps/telephony/src/voiceAgent/*`) bridges to the
OpenAI realtime WebSocket with the TENANT'S OWN key, runs the order-taking
conversation, writes the finished order as a `SupermarketOrderDraft`
(sourceType "voice_call", agentItems frozen, NEEDS_REVIEW — the fork's review
queue), and on "get me a person" / any failure returns to the dialplan's HUMAN
fallback (the default branch, never hangup — additive in front of today's flow).

**⛔ Load-bearing invariants (all test-proven):**
- The OpenAI key is the tenant's own (ProviderCredential/OPENAI via the fork's
  `resolveIntegrationKey('OPENAI')`) — NO platform-key fallback (source-guarded);
  a runaway AI call bills the tenant, never us. Same wall as tenant Sola keys.
- The model's arguments are UNTRUSTED: every finalized price comes from
  PosCatalogItem at execution time (10k-attempt stress proves a model-supplied
  price never moves the total); an order with a phantom item is refused WHOLE,
  never trimmed; one draft per call (50-way concurrent finalize → 1 draft);
  tenant comes from the api-issued session, never the model.
- The voice agent NEVER submits to the POS — `approveAndSubmitDraft` (fork) stays
  the only register path, human-gated (source-guarded: no posClientForTenant /
  PosWithLogicClient reference).
- The AudioSocket port is internet-reachable (docker bypasses ufw), gated by a
  single-use 128-bit session UUID announced over AMI (unknown UUID → terminated
  instantly) + a DOCKER-USER iptables rule pinning it to the PBX. 100-probe
  hostile assault admits ZERO sessions.
- ⛔ Armed ONLY by VOICE_AGENT_ENABLED=1 — a pure no-op otherwise; shipping the
  code changes nothing until the flag is set. Touches no other telephony service.
- Yiddish: the model is instructed to transfer to a person (no provider does
  real-time Yiddish); English/Hebrew/Spanish handled by the AI.

**State:**
- ✅ API DEPLOYED + CONTAINER-VERIFIED 2026-08-26 (rode the supermarket api deploy,
  job b1b93518 → `c65bf3a8`; `app-api-1` .build-commit = c65bf3a8): my code
  grepped IN the container (registerVoiceAgentRoutes ×2, 6 voiceAgent files, 2
  bypass entries), migration applied (VoiceAgentSettings + VoiceAgentCall tables
  exist, 0 rows — inert). LIVE-PROBED: session-start for T102 →
  `{"ok":false,"reason":"no_settings"}` (tenant resolver works, refuses cleanly →
  human fallback); wrong secret → 403; admin door no-JWT → 401. The whole api
  chain is proven on production.
- ⛔⛔ THE REMAINING STEPS ARE PRODUCTION-MUTATING AND NEED IZZY'S LIVE WORD
  (per the standing rules — PBX is read-only by default; a firewall/env edit on
  the live box is his call; "build it end to end" covered CODE, not a PBX write):
  (1) `VOICE_AGENT_ENABLED=1` + `VOICE_AGENT_PORT=4590` in `.env.platform`;
  (2) the DOCKER-USER iptables rule pinning 4590 to the PBX;
  (3) telephony deploy (in a 0-active-calls window, ⛔ never mid-api-rollout);
  (4) PBX dialplan install (`scripts/pbx/patch-connect-voice-agent.sh`);
  (5) pilot enablement — Loopcom Demo `cms8yjvth8ctlo4137738yg0n` (T102): OpenAI
  key on /admin/integrations + settings + a catalog + DID→context + fallback dest;
  (6) the acceptance REAL CALL. Runbook: `scripts/voice-agent-deploy-prep.md`.
- ✅ Telephony half COMMITTED + PUSHED (`58fafae9`, 17 files) — inert until
  flagged. 37 tests (31 unit + 6 stress: 5000-run parser fuzz, 200k-sample
  μ-law round-trip verified against the standard G.711 table, hostile assault,
  concurrency flood, 300-session well-formed-frame chaos). typecheck 41 = baseline.
- ✅ PBX dialplan + idempotent patch script committed (`scripts/pbx/
  connect-voice-agent.{conf,sh}`, LF-pinned). Deploy runbook + phone-free
  live-check script committed (`41b0ad3e`).
- ✅ API half COMMITTED (`5856d4c8`): `apps/api/src/voiceAgent/*` (routes,
  executor, catalog, policy) + server.ts registration + the test glob. The
  fork's schema commit `8e224306` created my VoiceAgentSettings/VoiceAgentCall
  tables + the OPENAI enum AND carried my 3 /internal/voice-agent bypass entries
  + the admin.voice_agent nav wiring. 25 tests (incl. the 10k hostile-executor
  stress); 0 typecheck errors in my files; all 6 Prisma accessors verified
  against the generated client.
- ✅ Portal admin page COMMITTED (`6f64c768` page/css + `1d2c5157` nav guard
  test): standalone /admin/voice-agent (enable/voice/greeting/caps + readiness
  card + call history). OpenAI key is entered on the fork's /admin/integrations
  (one writer, one ProviderCredential row). SUPER_ADMIN-forced; portal 0 errors.
- ✅ Telephony transcription model made env-tunable (`1d2c5157`,
  VOICE_AGENT_TRANSCRIBE_MODEL). FULL VERIFICATION: telephony 41 typecheck +
  37 tests, api 25 + 18 bypass, portal 0 + 9 nav — 71 tests, all green.
- ⏳ NOT DONE (the deploy chain, all mine after the fork's api deploy): the api
  deploy carries both halves + the migration (the fork enqueues it); then
  VOICE_AGENT_ENABLED=1 + the DOCKER-USER firewall rule (loopcom), the telephony
  deploy (in a 0-active-calls window, ⛔ never during the api rollout), the PBX
  dialplan install (`scripts/pbx/patch-connect-voice-agent.sh`), pilot-tenant
  enablement (Loopcom Demo T102: OpenAI key on /admin/integrations + settings +
  catalog + DID→context + fallback dest), and the acceptance REAL CALL. Runbook:
  `scripts/voice-agent-deploy-prep.md`; phone-free chain check:
  `scripts/voice-agent-live-check.mjs`.

### §13f — THE DEMO APK (Izzy: "fully populated demo… real addresses… prompt the GPS… create a login") — `3c0851ba`

- **A THIRD app**: `CONNECT_DRIVER_DEMO=1` → `com.loopcom.driver.demo`, label
  "Loopcom Driver Demo" (manifest label is now `${driverAppLabel}` via
  manifestPlaceholders), entry `index.driverdemo.js` (= driver entry +
  `markDriverDemo()`). Installs beside BOTH real apps. Artifact-verified:
  `apps/mobile/dist/loopcom-driver-demo-1.0.0+20260825-demo1.apk`
  (62,480,447 b, vc 260825211; demo markers grep 3 in the bundle, SIP 0,
  RECORD_AUDIO 0, location perms present). Delivered to Izzy as a file.
- **`src/driver/demoBackend.ts` is the whole "server"**: one Gesheft run, 8
  stops on real KJ/Monroe streets (Forest Rd, Acres Rd, Van Buren Dr,
  Bakertown Rd, Israel Zupnick Dr, Satmar Dr, Getzel Berger Blvd, Seven
  Springs Rd) with hand-placed coords — ⛔ never dispatch a real driver off
  them — names + notes (side door, WIC, frozen). Stop state advances
  locally (any scan attaches the next READY stop) and persists in
  AsyncStorage; Settings gains a demo-only "Reset the demo".
- **Every deliveryClient function branches on `isDriverDemo()`** (8 branches —
  syncOp rides scanLabel). Navigate builds real Waze/Google/Apple URLs from
  stop coords, so turn-by-turn genuinely opens on the demo.
- **GPS is REAL**: Start run fires the actual permission prompt + foreground
  service; ⛔ only `trackingService.flush()` short-circuits in demo (no
  server session; a 401 loop would be noise). Follow-me on the in-app map
  works off the real fix stream.
- **Login is LOCAL**: `driver@gesheftkosher.com` / `demo1234` — prefilled
  email + on-screen hint (demo builds only); accepted via
  `setTokenFromQr(DEMO_TOKEN)`, no server account exists.
- ⛔ **Build order gotcha**: all three variants share
  `apk/release/app-release.apk` — whatever built LAST sits there. The ship
  scripts build fresh so the fleet is safe, but never grab that path without
  checking `aapt dump badging` first.
- ⏳ NOT PROVEN on a device (no phone attached). Acceptance: install → login
  hint visible → sign in → Start run pops the location prompt → map shows
  the KJ route + follow-me → scan anything → stop → proof photo → stop goes
  green; "Reset the demo" starts over.

### Verbatim fact learned 2026-08-26 00:45 ET — the API is a GATEWAY to a server AT THE STORE

Authenticated 0-credit probe (invoices/id/{bogus}, real key from the vault):
**`503 {"success":false,"error":"STORE_UNREACHABLE","message":"The store
server is currently unreachable. Please retry shortly.","retryable":true}`**
— auth PASSED (key active; the same call with no key answers 401), then the
gateway failed to reach the in-store server. At 12:45 AM with the store
closed that reads as a nightly window, not a fault — the sibling's catalog
walks all succeeded the previous evening. ⛔ **Every automation against this
API must treat 503 STORE_UNREACHABLE as retryable-later and never fail an
order on it** — overnight the register system may simply be off. Liveness
recipe: resolve the key via `resolveIntegrationKey(db, gesheftTenantId,
"POS_TRACKING")` inside app-api-1, GET /invoices/id/{bogus} (0cr): 401/403 =
key dead, 404 = key fine + store up, 503 STORE_UNREACHABLE = key fine +
store down.

### ⛔ LIVE SITE OUTAGE at Gesheft's MAIN store, 2026-08-26 11:09:40 ET — phones AND the register server went together

Read-only investigation (Connect DB + PBX inspection; no write anywhere).

- **Gesheft is TWO sites and only ONE is down.** `75.99.30.60` (main store)
  holds exts **101, 102, 103, 104, 105, 106, 107, 108, 111, 897** — every one
  `Unavail`. `38.105.207.69` (second site) holds **114, 115, 116 + a SECOND
  101 phone** — all `Avail`, 32 ms ping. ⛔ So "Gesheft's phones are down" is
  half-true and the half matters: inbound still lands (ext 101 keeps a live
  contact at site B plus 3 softphone contacts on the 443 route).
- **Exact sequence (Asterisk log, EDT), 10 phones in 21 seconds:** 11:09:40
  ext 104 · 11:09:45 ext 101 · 11:09:46 ext 111 · 11:09:47 ext 107 · 11:09:48
  ext 106 · 11:09:53 exts 105 + 108 · 11:09:54 ext 897 · 11:09:56 ext 102 ·
  11:10:01 ext 103. **Nothing from that IP since 11:10:01**; ping from the PBX
  = **100% packet loss**. Same shape as the Create A Box T7 site outage.
- ⛔⛔ **ONE EVENT, NOT TWO — the timestamp that proves it: the POS catalog
  sync last wrote successfully at 11:07:56 ET, 104 SECONDS before the first
  phone dropped.** So the store's whole network died ~11:08–11:09 and took the
  register server and the phones with it; `STORE_UNREACHABLE` from the POS
  gateway right now is that outage, not an API fault.
- **The 00:45 ET STORE_UNREACHABLE was genuinely separate** — the registration
  history shows NO mass-drop at that hour, so the phones were up while only
  the register server was unreachable (overnight shutdown, as read).
- **What to tell the customer:** their internet/network at the main store is
  down — router/modem/switch at the site. Nothing on Loopcom's side; the PBX,
  the second site and every softphone are healthy.
- ⛔ **Query trap that cost a round:** `LIKE 'T8[_]%' ESCAPE '['` returns ZERO
  rows — with `[` as the escape char, `[_` is a literal underscore and `]` a
  literal bracket, so it searches for `T8_]`. Use `endpoint ~ '^T8_'`.
- **Liveness recipe for any site:** `pjsip show contacts | grep T8_` (Avail vs
  Unavail per site IP) → the Asterisk log for the exact second → ping the
  site's public IP from the PBX → `max("updatedAt")` on PosCatalogItem to date
  the last successful register-server contact.

## Open questions for Gesheft (nobody has asked yet)

- **The box sticker (2026-08-25, gates the label design):** their POS already
  prints a sticker that goes on the box (Izzy). Does it carry a BARCODE, and is
  it the order/invoice number? If yes → the driver scans THEIR sticker and we
  resolve by that number (add a second identifier kind beside the hashed
  labelToken; scan is driver-authenticated so a guessable number is acceptable
  there) — zero change in the store. If no → we print our own label from the
  Orders desk at put-through (already planned, §13c). One photo of a sticker
  answers it.
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
