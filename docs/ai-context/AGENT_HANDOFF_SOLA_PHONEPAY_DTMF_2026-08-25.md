# AGENT HANDOFF — Sola DTMF/phone-payments investigation: the "DTMF API" is a PRODUCT called PhonePay, and the DIY path runs on `cc:save` (2026-08-25)

**Read-only research — no code, no deploy, no Sola account touched, no credential
used, nothing built.** One docs commit (`9b521ebd`, CLAUDE.md) plus this handoff.
Session context: Izzy had the Sola API docs open and a Sola rep had told him a
DTMF API "should be there" for taking payments over the phone. His follow-ups in
the same conversation: *"Is it a third party? … maybe there's a way that we can
tokenize the DTMF"*, *"Sola is very developer-friendly, so there's got to be
something there"*, and *"What if we use their own tokenized and we make our own —
can we take the DIY path? Because if it's an add-on, they probably charge money
for it."*

Prior art this extends (read them first):
- `docs/ai-context/AGENT_HANDOFF_INII_MINI_SHOP_BY_TEXT_2026-08-16.md` — the
  engagement where phone payments first came up; §2f records Izzy choosing the
  DIY path knowingly.
- Memories: `sola-is-cardknox` (updated 2026-08-25 with these findings),
  `dtmf-masking-cannot-be-self-administered`, `shopify-agent-integration-shape`.
- CLAUDE.md: the "inii mini wants to sell by TEXT MESSAGE" section's SOLA IS
  CARDKNOX bullet now carries the 2026-08-25 update and points here.

---

## §1 — The headline: there is NO DTMF/IVR endpoint in Sola's API, and there never was — but the phone-payment PRODUCT exists and is called PhonePay

- **The developer docs were swept in full, not sampled.** `docs.solapayments.com`
  publishes a complete index at `https://docs.solapayments.com/llms.txt` —
  **76 pages** as of 2026-08-25. Zero pages mention DTMF, IVR, pay-by-phone,
  voice, telephone, or virtual terminal. The only IVR mention anywhere in the
  docs is the **glossary definition**, and that entry links to the product:
  `https://www.cardknox.com/phonepay/`.
- **PhonePay is a hosted, fully-automated IVR payment line.** The merchant gets
  a dedicated phone number on their merchant account; customers dial it 24/7,
  follow prompts, and key card digits on their own keypad; Sola's system
  captures the DTMF and processes the charge. Sola's own marketing pairs it
  with texting: text the PhonePay number to customers with outstanding
  balances. Meta description from the archived page, verbatim: *"PhonePay is a
  hosted, fully automated interactive voice response system that lets you
  accept phone payments from your customers quickly, securely, day or night."*
- ⛔ **It is NOT an API and has NO developer documentation.** It is provisioned
  through Sola sales/support only. So the rep's "it should be there" is
  half-right: the capability exists, but structurally it can never appear in
  the API docs, which is exactly where everyone was told to look.

## §2 — "Is it a third party?" — NO, and the page being gone is a migration casualty, not a retirement

- **First-party Cardknox product since 2019.** The page's schema.org metadata
  reads `datePublished 2019-04-05`, `dateModified 2023-11-16`, branded
  "Cardknox PhonePay", thumbnail served from cardknox.com's own wp-content.
  Searches for a powering partner (Datatel, IVR Technology Group, any IVR
  vendor + Cardknox) found **nothing** — no partnership exists in public record.
- **Not retired.** Two LIVING references sell it today: the current Sola docs
  glossary (its IVR entry still links the cardknox.com URL), and a current
  guide on solapayments.com
  (`/guides/online-guides/payment-solutions-to-boost-operational-efficiency-in-the-public-sector/`)
  that names **"Sola PhonePay"** as an active offering.
- ⛔ **`cardknox.com/phonepay/` answers 410 Gone and `solapayments.com` has no
  PhonePay page in its nav** (checked: nav is online-payments, in-person,
  omnichannel, PayFac, integrated-platforms, tap-to-pay). The page simply did
  not survive the cardknox.com → solapayments.com marketing migration
  (Fidelity Payment Services + Cardknox merged into Sola in 2024). Do not read
  the 410 as "the product died".

## §3 — "Tokenize the DTMF": the DIY path is fully supported by the API, and half of it already exists in Connect

- **`cc:save` is the primitive**: it tokenizes a card **without charging it**
  and returns an `xToken`. (`check:save` is the ACH sibling.) So a self-built
  IVR collects digits, makes ONE `cc:save` call, keeps the token, discards the
  PAN. Charging is `cc:sale` + `xToken`, or store the token as a payment
  method in their Customer & Recurring API for card-on-file / schedules.
- **No gate on the developer side**: no certification required (self-certify
  optional), sandbox keys behave like production, test card numbers published,
  sandbox transactions capped at $10 unless using the published test PANs.
  `xKey` identifies the account; sandbox and production keys are separate.
- ✅ **Connect already integrates this exact gateway for its own billing** —
  `apps/api/src/billing/solaGateway.ts` (SUT → xToken → charge, the whole
  chain proven in production). A DIY customer-facing build is a
  tenant-scoped variant of the same client using the TENANT's xKey — not a
  new integration.
- ⛔ **The merchant account is opened in the CUSTOMER's name, never Connect's**
  (standing rule, unchanged). The tenant's xKey belongs to their account.
- ⛔ **The PCI trade is unchanged and must be stated whenever this is planned**:
  DIY means the digits transit OUR PBX, so we are the in-scope box regardless
  of storing nothing — tokenize-immediately shrinks exposure as far as DIY
  can, but transmission scope stands
  ([[dtmf-masking-cannot-be-self-administered]]). Izzy chose the DIY path
  knowingly on 2026-08-16 and re-affirmed the direction on 2026-08-25 (his
  reasoning: PhonePay is probably a paid add-on). PhonePay is the zero-scope
  alternative because the tones never cross our systems.

## §4 — DIY build sketch (NOT built — for whoever picks this up)

1. **Digit collection**: a payment context in the Asterisk dialplan —
   `Read()` with `#` terminator for card number / expiry / CVV / ZIP — or DTMF
   events through apps/telephony, which already listens for them.
2. **Tokenize instantly**: api-side call to Sola `cc:save` with the tenant's
   xKey; keep `xToken`, discard the PAN in the same function. Nothing raw ever
   reaches the database, CDRs, or logs.
3. **Charge or vault**: `cc:sale` + `xToken` now, or CreatePaymentMethod on
   their Customer & Recurring API for later.
4. **Scope-shrinking mitigations, all mandatory in any build**:
   - **Pause call recording during the payment segment** (MixMonitor pause) —
     recordings are the biggest scope item; DTMF can land in recorded audio.
   - Never log digits anywhere; PAN lives in one process's memory only.
   - TLS to Sola only (their endpoints are HTTPS anyway).
   - **Velocity caps** on the payment line — a stolen-card tester hammering an
     unattended IVR is a classic gateway-abuse pattern and lands on the
     merchant.
5. Response handling: `xResult` A/E/D, `xRefNum` on every transaction (store as
   BIGINT/string), `xError` is customer-displayable per their own guidance,
   pass unique `xInvoice` for duplicate protection (10-min window, override
   with `xAllowDuplicate`/`xDuplicateWindow`).

## §5 — Open questions for the Sola rep (none asked yet — Izzy is talking to them)

1. **What does PhonePay cost?** If it is cheap it beats weeks of build for
   "press 1 to pay"; if expensive, DIY wins. This is THE deciding number.
2. Ask for the exact docs link the rep meant by "it should be there" — the
   public docs provably don't contain it.
3. Does PhonePay support **invoice/account-number lookup** (customer keys a
   reference, IVR fetches the amount) or amount-entry only?
4. How do PhonePay results flow back — their **Webhooks** product? Reporting
   API polling?
5. Can we **transfer a caller from our own IVR into the PhonePay line**
   mid-call?
6. **Does the merchant account's pricing care about keyed/MOTO volume?** An
   IVR submits everything keyed CNP; some underwriting tiers price that
   differently. Better heard now than on the first statement.

## §6 — Environment traps hit during this research (each cost a round trip)

- ⛔ **A tab the user "adds to your group" may not be in YOUR session's tab
  group.** Izzy put the Sola docs tab in a Claude tab group; this session's
  `tabs_context_mcp` group was empty — each session gets its own group. Don't
  hunt for the user's tab; open the URL yourself.
- ⛔ **web.archive.org is unreachable from both WebFetch (hard-blocked: "unable
  to fetch from web.archive.org") and the in-Chrome navigate on Izzy's filtered
  line** (the navigate silently bounced back to the previous page). **What
  works: Bash `curl` to `http://web.archive.org/web/<ts>id_/<url>`** — the
  availability API (`archive.org/wayback/available`) answers fine and the
  snapshot fetch succeeded over plain http where https timed out.
- ⛔ The archived PhonePay capture (snapshot 20240804230837) is **truncated at
  65,700 bytes** — head + menu CSS only, body content absent. The schema.org
  JSON-LD in the head carried the useful description; don't burn time trying
  to extract body copy that isn't in the capture.
- `kb.cardknox.com` 301s to `docs.cardknox.com`, which mirrors
  `docs.solapayments.com` — same GitBook, not a second corpus.

## §7 — What is NOT done / not proven

- ⏳ Nobody has asked Sola anything — §5 is the list, and PhonePay pricing is
  the gating fact for the build-vs-buy decision.
- ⏳ Nothing is built: no payment dialplan, no tenant-key Sola client, no
  `cc:save` call has ever been made from Connect code (the existing
  `solaGateway.ts` path is Connect's OWN billing on Connect's key).
- ⏳ Whether inband DTMF actually appears in OUR recordings (vs RFC4733
  out-of-band events that never enter the audio) was NOT measured — it decides
  how much the recording-pause mitigation is load-bearing vs belt-and-braces.
  Measure on a real call before writing the compliance story.
- Payments remain **pinned out of phase 1** of the inii mini shop-by-text build
  — none of this blocks that work.
