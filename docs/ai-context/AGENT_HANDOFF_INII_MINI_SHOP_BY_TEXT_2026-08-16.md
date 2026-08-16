# AGENT HANDOFF — inii mini: shopping by text message (Shopify + SMS agent)

**Date:** 2026-08-16
**Status:** ⛔ **SCOPED AND QUOTED ONLY — NOT STARTED. No code written, no
server bought, nothing deployed, nothing registered.** Everything below is
research and design. The only artifacts are this document, the tenant knowledge
entry, and the customer proposal.
**Customer:** inii mini (`cmsgkl4y95grttd13yqhyf1gd`, PBX tenant 105) — children's
and baby clothing, <https://iniimini.com>, ~123 products, $52–64 typical price.
**Proposal:** <https://claude.ai/code/artifact/06af7ba8-35c6-4381-8ec6-3f8b453d65f3>
(PDF rendered from the same file; source HTML lives only in the session
scratchpad and is NOT in the repo).

---

## 1. What the customer wants

Their community largely does not use the internet — filtered internet, and many
customers on flip phones with no browser at all. The store wants an assistant
that lets those customers shop **entirely by text message**: ask about products
in plain language, receive photos and prices, build an order, confirm it, and
later ask "did it ship?" or cancel.

Izzy's constraints, given across the session:

- **No card information may ever flow through the agent.** Restated repeatedly.
- **A payment link is useless** — the customers have no internet to open it.
- **The traffic should not run on the Connect server.** A separate small VPS is
  the "brain"; Connect exposes only a messages API.
- **English only.** Yiddish was explicitly ruled out.
- **Text only.** A voice/IVR ordering path was explicitly removed from scope.
- Payments **pinned** for phase 1 after the PCI discussion below.

---

## 2. ⛔ The findings that shaped the design — verified live, not assumed

### 2a. Every Shopify store already exposes an MCP endpoint, by default

`POST https://iniimini.com/api/mcp` answers a standard `tools/list` with 200 and
five tools: `search_catalog`, `get_product_details`, `get_cart`, `update_cart`,
`search_shop_policies_and_faqs`. **Nobody set this up.** Probed four unrelated
Shopify stores — allbirds.com, gymshark.com, kith.com and inii mini's own
`inii-mini-store.myshopify.com` — and all four returned the identical five
tools. Shopify's docs: "Each Shopify store has its own MCP server endpoint."

- ⛔ **It works on the custom domain, not just `*.myshopify.com`.**
- ⛔ **A headless storefront exposes fewer tools.** hiutdenim.co.uk (Hydrogen/
  Oxygen) returned **one** tool — policies only, no catalog or cart — because
  there is no Shopify theme for them to attach to. inii mini runs the standard
  **Broadcast 7.1.1** theme, so it exposes the full set. Do not generalise "5
  tools" to every store.
- **Consequence: the entire catalog half of this project needs no credentials
  and can be prototyped today**, before the store owner is ever involved.
- ⏳ **UNVERIFIED:** whether a merchant can switch the endpoint off. "Default on"
  is proven; "cannot be disabled" is not.

### 2b. Shopify does NOT provide an agent — it provides tools

Their own storefront-agent template says: *"This template uses Claude, but you
can swap in any LLM"*, and its setup step is *"Generate a key in the Claude
Console."* Shopify supplies MCP tools, a **website** chat bubble, and a
conversation schema. The model, the loop, and **the channel** are ours. Sidekick
is merchant-facing (inside the admin), not a customer channel. **There is no
Shopify endpoint you can point SMS at.**

### 2c. ⛔⛔ Shopify will not let anything but its own checkout charge a card

- **There is no public API to submit a card payment to Shopify Payments.** The
  Payments Apps API is restricted to approved Payments Partners, and the
  credit-card extension programme is invite-only closed beta requiring a PCI
  Attestation of Compliance.
- Raw card data via Admin API is available only "through card imports from a PCI
  compliant environment."
- The only card-entry paths that exist: hosted web checkout (needs internet),
  Shopify POS (in person), and a **human** typing a card into a draft order in
  the admin (**Shopify Payments only**).
- ⛔ **Therefore an IVR that charges "through Shopify Payments" is impossible**
  short of becoming a Shopify Payments Partner. This was asked twice and the
  answer did not change. Every IVR-payment product on the market charges through
  a **gateway**, never through the storefront platform.

### 2d. ⛔ The stock-sync fear was unfounded — no platform pivot is needed

Izzy's worry: if Sola/Cardknox takes the money, how does Shopify learn about the
sale and decrement stock? Answer: **`draftOrderComplete` is what moves stock.**
Charge at the gateway, then complete the draft order with `paymentPending:
false`; Shopify converts it into a real Order, marks it paid, and **decrements
inventory exactly as a web sale would**. Refunds restock the same way. Shopify
stays the single source of truth across both channels, Shopify Payments keeps
serving web customers, and **nothing needs to be abandoned or replaced.**

Two consequences worth building for:

- ⛔ **Draft orders do NOT reserve stock.** Between the agent building a cart and
  the customer texting YES, a web customer can take the last one. Re-check
  availability immediately *before* charging and complete immediately *after*.
  Shopify will happily accept an oversell into negative stock.
- ⛔ **Refunds are a two-system action.** Refunding in Shopify restocks and fixes
  reports but **moves no money** — the money is at the gateway. Store the
  gateway transaction id on the Shopify order and make "refund" one atomic
  action across both, never two manual steps.

### 2e. ⛔ Sola IS Cardknox — there is no "pivot to Sola"

Fidelity Payment Services and its gateway Cardknox **rebranded as Sola in
October 2024**. Same company; their docs still serve `x1.cardknox.com`
endpoints. When the session said "Cardknox" and Izzy said "Sola," both meant one
vendor. Their API (searched in full, 1.9 MB of `llms-full.txt`) has everything
needed for charging and vaulting — `cc:sale`, `cc:save`, `cc:authonly`,
`cc:capture`, `cc:refund`, `cc:void`, `xToken` card-on-file, and a Customer &
Recurring API with `/CreatePaymentMethod`. **Zero mentions of IVR, DTMF, phone
payments or voice** — they document no phone-capture product.

### 2f. PCI: what it actually costs to capture cards ourselves

Izzy explored building our own DTMF capture with "masking." The findings, stated
plainly and repeatedly to him:

- PCI compliance is **not a government registration** — it is a contractual
  obligation flowing from the card networks through the processor to the
  merchant. Enforcement lands via Sola and the merchant agreement.
- ⛔ **"Masking" cannot be self-administered.** The entire product is that a
  *certified third party* decodes the digits so your systems never do. If we
  build the masking, our box is the one decoding — the scope simply moves.
- ⛔ **DTMF tones live in the call audio**, so any recording of that call
  contains the card number, and every system the audio crossed is in scope. PCI
  covers **transmission**, not only storage — so "we delete after a minute" or
  even "we store nothing at all" does not remove scope.
- DIY therefore means SAQ D as a **service provider**, quarterly ASV scans,
  annual re-attestation — small but permanent, and fines apply for
  non-compliance even with no breach.
- ⛔ Izzy's position at session end: build it ourselves anyway and "make sure
  there is never a breach," and Sola will never ask for documents. **That is his
  decision, recorded here as his decision.** The counter-argument (no one can
  promise no breach; the paperwork is contractual, not optional; a terminated
  merchant listing would cost inii mini card processing entirely) was made in
  full and is not to be re-litigated unless he asks.
- Zero-scope routes that were offered and remain open: Sola's own phone-capture
  product **if it exists** (he is calling them), a rented DTMF-masking service
  (PCI Pal / Paytia / IVR Tech Group class), or staff keying the card once into
  Sola's virtual terminal.

**Payments are pinned out of phase 1 entirely**, so none of this blocks the
build.

---

## 3. The agreed architecture

```
Customer flip phone ⇄ SMS/MMS ⇄ Connect (VoIP.ms) ⇄ Messages API ⇄ VPS "brain"
                                                                    ├─ Claude API
                                                                    ├─ Shopify store MCP (catalog, no creds)
                                                                    ├─ Shopify Admin GraphQL (orders, needs token)
                                                                    └─ [phase 2] Sola tokens
```

- **Connect's only new surface is a Messages API**: an authenticated send
  endpoint (SMS + up to 3 MMS images) and an inbound webhook pushing customer
  texts to the VPS. Everything else — conversation state, the agent loop,
  Shopify, payments — lives on the VPS.
- ✅ **MMS sending already exists and is proven**: `sendMMS` with up to three
  `mediaN` URLs in `packages/integrations/src/index.ts:491`, driven by
  `apps/worker/src/connectChatSmsJob.ts`. The catalog-photo leg is plumbing, not
  new capability.
- ⛔ **Inbound SMS does NOT currently reach the agent.** Verified: no agent
  reference in `apps/worker/src/voipMsInboundSyncJob.ts` or
  `apps/api/src/connectChatRoutes.ts`. `apps/agent/src/channels/` has `email.ts`
  and `messaging.ts` but no SMS path. **This connection is the actual missing
  piece.**
- The agent brain itself is not new work in kind — `completeWithTools`
  (`apps/agent/src/llm/router.ts:251`) and the tool registry
  (`apps/agent/src/tools/toolRegistry.ts`) already exist. Shopify tools drop in
  the same way `extension_status` and `call_history` did. **Whether the brain
  lives on the VPS as a fresh service or reuses `apps/agent` is an open design
  call** — Izzy asked for a separate VPS, which argues for a standalone service
  that borrows the patterns.
- ⛔ **The Shopify token must never enter the model's context.** The model names
  a tool; our code holds the token. Same rule the existing registry enforces
  about tenant ids.
- Build against **GraphQL Admin API** — REST is legacy as of 2024-10-01 and new
  apps have been GraphQL-only since 2025-04.

### Shopify access

Custom app created by the **store owner** in his own admin (Settings → Apps and
sales channels → Develop apps; Shopify is moving this into the Dev Dashboard).
⛔ **Collaborator accounts cannot do it** — it must be the owner or staff with
*App development → Develop*. Token is shown **once**, looks like `shpat_…`, and
never expires until revoked. Scopes: `read_products`, `write_draft_orders`,
`read_orders`, `write_orders`, `read_customers`, `write_customers`,
`read_fulfillments`. **Nothing payment-related.** Store it in the encrypted
`AgentSecret` pattern (as `polly_credentials` / the ElevenLabs key are), never an
env var.

---

## 4. Commercial terms as quoted

| | |
|---|---|
| Build ceiling | **20 hours @ $250/hr = $5,000**, guaranteed not to exceed |
| Honest estimate | 28–36 h originally; cut to 20 on Izzy's instruction |
| Server | $9/mo, **billed by Connect** (servers in Izzy's name, not the store's) |
| AI usage | $20–100/mo depending on volume |
| Messaging | **1.5¢ per SMS, 2¢ per MMS** |
| 10DLC | small one-time filing + a few dollars monthly |
| Phase 2 (payments) | separately quoted, ~10–15 h |

⛔ **The agent's messaging is a separate billing line from the $10/mo texting
inii mini already pays for.** Stated explicitly in the proposal.

⛔ **The 20-hour ceiling is below the honest estimate.** Recorded so nobody later
reads 20 h as an engineering assessment — it is a commercial decision, and the
overrun risk is Izzy's. The mitigation written into the proposal: pilot
transcripts are reviewed *by the store*, who flags problems, rather than every
transcript being read on the clock.

---

## 5. Sequence of work

0. **Day one, no code, two clocks:** (a) MMS photo test on 5 real community
   handsets — the whole concept rests on filtered/kosher flip phones actually
   receiving pictures; (b) file **10DLC** brand + campaign registration (1–3
   weeks, the only clock we do not control).
1. Messages API on Connect (send + inbound webhook + auth + tests). ~5–6 h.
2. VPS provisioned and hardened; agent skeleton; echo test over real SMS. ~2–3 h.
3. Catalog tools via the store's public MCP endpoint; photos by MMS;
   conversation memory keyed by phone number. ~7–8 h. **Demo-able here.**
4. Shopify Admin: owner creates the custom app; draft orders, tracking, cancel,
   customer matching by phone. ~5–6 h.
5. House rules, guardrails, human handoff. ~2–3 h.
6. Pilot with 10–20 customers, transcripts reviewed, then open. ~4–6 h.

**Build ≈ one working week. Public launch waits on 10DLC approval**, so
realistically 2–3 weeks from day one, with the system finished and piloting
while the registration processes.

### Human handoff — three options, customer's choice

Live takeover in the Connect chat inbox, forward to an email address, or forward
to somebody's phone as a text — or a mix (likely: text by day, email overnight).
All three ride existing rails. Full conversation history travels with the
handoff either way.

---

## 6. ⛔ Compliance the messaging pipeline must enforce in code

Not model discretion — pipeline behaviour:

- **Opt-in recorded before first contact** (who, when, how). A customer texting
  first *is* consent for conversational replies; marketing needs prior express
  **written** consent and has 8am–9pm quiet hours.
- **STOP** (and stop/unsubscribe/quit/cancel) → one confirmation, then that
  number goes on a suppression list checked before **every** outbound send,
  permanently, even mid-order. **HELP** returns store contact info.
- **First message discloses**: business name, "msg & data rates may apply",
  frequency, STOP/HELP.
- **The agent identifies itself as automated** (California bot-disclosure law).
- **SHAFT** content rules — irrelevant to baby clothes, but the 10DLC campaign
  description must be written accurately.
- **Records kept 4 years** (TCPA statute of limitations). The conversation
  logging we are building anyway satisfies this.
- ⛔ **No cold blasts to their customer list.** The agent texts only people who
  opted in or texted first. Promotional broadcasts are a different consent
  category and a deliberate later conversation.
- TCPA damages are **$500–$1,500 per message** and privately actionable — this is
  the one area where "we'll tidy it up later" is not survivable.

---

## 7. ⛔ Corrections made during the session — do not reintroduce

- **anymini.com is NOT their store and is not Shopify** — static nginx HTML,
  last modified 2021, `/products.json` 404s. The store is **iniimini.com**. The
  first question of the session was asked about the wrong domain.
- **Their port already landed.** 646-984-6023 has been live with texting since
  2026-08-12 and the temp 845-260-5692 was retired automatically. Earlier in the
  session it was described as "still mid-port" — wrong; there is **no number
  decision to make**, and 10DLC registration goes on 646-984-6023.
- **A fleet of 20–30 browser sessions driving the storefront was proposed and
  rejected**: it does not solve payment (the agent would still type card numbers
  into a checkout), Shopify/Cloudflare treat datacenter checkout automation as
  bot traffic, and every theme change breaks it. The Admin API does the same job
  in one call.
- **8 GB of VPS is unnecessary** — the model runs at Anthropic; this is a small
  Node service. 4 GB is comfortable. (Kept at the $9/mo tier anyway.)

---

## 8. Open questions

- ⏳ **Does Sola have a phone-capture product?** Izzy is calling them. Questions
  to ask: their phone/IVR capture product; what PCI validation they require if we
  capture and immediately tokenize; whether `cc:save` + $0 verify behaves as
  designed; whether the merchant account is set up for **MOTO/card-not-present**
  (mismatched account type raises declines).
- ⏳ **Do the community's handsets actually receive MMS?** Untested. Everything
  rests on it.
- ⏳ Standalone VPS service vs. reusing `apps/agent` for the brain.
- ⏳ inii mini has **no billing settings row at all** (per their knowledge doc) —
  it has to exist before any of these recurring lines can be invoiced.
- ⏳ Their old temp inbound route on PBX tenant 105 still exists and costs $3/mo
  E911 until deleted in the panel. Pre-existing, unrelated, still open.

---

## 9. Nothing is deployed

No code, no server, no registration, no Shopify token, no Sola account. The
repo changes from this session are **documentation only**: this file, the
tenant knowledge entry, the CLAUDE.md section, and a memory file. The customer
proposal exists as a published artifact and a PDF outside the repo.
