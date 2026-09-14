# ⛔ AGENT HANDOFF — inii mini wants to sell by TEXT MESSAGE; Shopify scoped and quoted, nothing built (2026-08-16) — READ FIRST before any Shopify work, before designing a payment path for a customer's store, or before quoting "the agent can just browse the site"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_INII_MINI_SHOP_BY_TEXT_2026-08-16.md`**
(⛔ **SCOPED AND QUOTED ONLY — no code, no server, no registration, no token, no
deploy.** Repo changes are documentation only. Customer proposal:
<https://claude.ai/code/artifact/06af7ba8-35c6-4381-8ec6-3f8b453d65f3>.)
Memory: [[shopify-agent-integration-shape]], [[sola-is-cardknox]],
[[dtmf-masking-cannot-be-self-administered]].

- ⛔⛔ **EVERY SHOPIFY STORE ALREADY EXPOSES AN MCP ENDPOINT AND NOBODY SET IT
  UP.** `POST https://<store>/api/mcp` → `search_catalog`, `get_product_details`,
  `get_cart`, `update_cart`, `search_shop_policies_and_faqs`. Proven by probing
  **four unrelated stores** (allbirds, gymshark, kith, iniimini) — identical five
  tools, on the custom domain too. **So the whole catalog half needs NO
  credentials and can be prototyped before the store owner is involved.**
  ⛔ A **headless** storefront (Hydrogen — hiutdenim) returns only the policies
  tool; don't generalise "five tools."
- ⛔⛔ **SHOPIFY WILL NOT LET ANYTHING BUT ITS OWN CHECKOUT CHARGE A CARD** — no
  public API submits a payment to Shopify Payments, the Payments Apps API is
  approved-partners-only, and the card extension is invite-only closed beta
  needing a PCI AoC. **Asked twice, same answer: an IVR charging "through
  Shopify Payments" is impossible.** Every phone-payment product charges through
  a **gateway** and records the result in the platform.
- ⛔ **AND THAT COSTS NOTHING, BECAUSE `draftOrderComplete` IS WHAT MOVES
  STOCK.** Charge at the gateway → complete the draft with `paymentPending:
  false` → Shopify creates a real Order, marks it paid and **decrements
  inventory exactly like a web sale.** The "how would Shopify know about the sale"
  fear that nearly triggered a platform pivot was unfounded — **no pivot, keep
  Shopify Payments for web.** ⛔ Two traps: **draft orders do NOT reserve stock**
  (re-check right before charging), and **refunds are a two-system action** —
  Shopify restocks but moves no money, so store the gateway transaction id and
  make refund atomic across both.
- ⛔ **SOLA *IS* CARDKNOX** (rebranded Oct 2024, docs still serve
  `x1.cardknox.com`). "Pivot to Sola" is not a pivot. Their API has `cc:sale`,
  `cc:save`, `xToken` card-on-file and a Customer/Recurring API — and **zero
  mentions of IVR/DTMF/phone payments**. ⛔ A customer's merchant account opens
  in **THEIR** name, never Connect's.
  ✅ **UPDATE 2026-08-25 — Sola DOES have a phone-payment product, and it is
  NOT an API: PhonePay**, a hosted fully-automated IVR line (first-party
  Cardknox product since 2019 — schema.org datePublished 2019-04-05, updated
  2023-11; NOT a third-party partnership, no Datatel/IVR-vendor anywhere).
  Merchant gets a dedicated phone number; customers dial 24/7, key card digits
  on their own keypad; Sola captures the DTMF and charges the merchant account
  — the zero-PCI-scope route, because the tones never cross our PBX.
  ⛔ **It has no developer docs and never did**: re-swept the full current
  `docs.solapayments.com/llms.txt` index (76 pages) — zero DTMF/IVR/phone
  pages; the only living references are the docs glossary's IVR entry (still
  linking `cardknox.com/phonepay`, now 410 Gone — the page died in the
  cardknox→solapayments site migration, not the product) and Sola's own
  public-sector guide selling "Sola PhonePay". **Provisioned via sales/support
  only** — so "the DTMF thing should be in the docs" is half-right.
  ⛔ **"Tokenize the DTMF" via the API = `cc:save`** (tokenize without
  charging → `xToken`): our IVR can collect digits and immediately trade the
  PAN for a token — but PCI covers TRANSMISSION, so the DIY path's scope stands
  regardless (the masking bullet below). Memory: [[sola-is-cardknox]].
  Full handoff (findings, DIY build sketch, the six questions for the Sola
  rep, and the wayback/tab-group research traps):
  **`docs/ai-context/AGENT_HANDOFF_SOLA_PHONEPAY_DTMF_2026-08-25.md`**.
- ⛔ **"MASKING" CANNOT BE SELF-ADMINISTERED** — the product IS that a certified
  third party decodes the digits so yours never do; build it and your box is
  simply the in-scope one. **PCI covers transmission, so storing nothing (or
  "deleting after a minute") does NOT remove scope**, and DTMF tones ride inside
  the call audio, which puts every recording and every system the audio crossed
  in scope. Zero-scope routes: the gateway's own capture product, a rented
  masking service, or staff keying once into the virtual terminal.
  ⛔ **Izzy chose the DIY path anyway on 2026-08-16 after hearing all of it —
  recorded in §2f, his call, do not re-litigate unless he raises it.**
  **Payments are PINNED out of phase 1 entirely, so none of it blocks the build.**
- ⛔ **A 20–30 BROWSER-SESSION FLEET WAS PROPOSED AND REJECTED**: it doesn't solve
  payment (the agent still types card numbers into a checkout), Shopify/Cloudflare
  treat datacenter checkout automation as bot traffic, and theme changes break it.
  The Admin API does the same job in one call. Build on **GraphQL** — REST is
  legacy since 2024-10-01.
- **What Connect actually has to build is ONE connection.** ✅ MMS sending already
  works (`sendMMS`, 3 media, `packages/integrations/src/index.ts:491` +
  `connectChatSmsJob.ts`) and the agentic loop already exists
  (`completeWithTools`, `apps/agent/src/llm/router.ts:251`). ⛔ **Inbound SMS does
  NOT reach the agent** — verified: no agent reference in `voipMsInboundSyncJob.ts`
  or `connectChatRoutes.ts`, and `apps/agent/src/channels/` has email + messaging
  but no SMS. The brain lives on a separate VPS; Connect exposes only a
  **Messages API** (send + inbound webhook).
- ⛔ **The Shopify token is created by the STORE OWNER in his own admin** —
  collaborator accounts cannot, it's shown once (`shpat_…`), never expires.
  Scopes: products / draft orders / orders / customers / fulfillments,
  **nothing payment-related**. Store it in the encrypted `AgentSecret` pattern
  and ⛔ **never let it enter the model's context.**
- ⛔ **COMPLIANCE IS PIPELINE CODE, NOT MODEL DISCRETION**: opt-in recorded before
  first contact, **STOP → permanent suppression list checked before every
  outbound send**, HELP, first-message disclosure, the agent identifying itself
  as automated, 4-year records, **no cold blasts to their customer list.** TCPA is
  **$500–$1,500 per message** and privately actionable. 10DLC registration takes
  **1–3 weeks** and is the only clock we don't control — file it day one.
- ⛔ **Quoted at a 20-hour / $5,000 ceiling against an honest 28–36 h estimate** —
  a commercial decision of Izzy's, not an engineering assessment; the overrun is
  his. Recurring: server **$9/mo billed by Connect** (servers in Izzy's name, not
  the store's), AI $20–100/mo, **SMS 1.5¢ / MMS 2¢**, 10DLC fees. ⛔ **Separate
  billing line from the $10/mo texting they already pay for.**
- ⏳ **Two day-one checks gate everything and neither has been run:** do the
  community's filtered/kosher flip phones actually **receive MMS**, and what does
  **Sola** say about a phone-capture product (Izzy is calling them).
  ⛔ **anymini.com is NOT their store** (static 2021 HTML, not Shopify) — the
  store is **iniimini.com**. ⛔ Their port **already landed 2026-08-12**, so
  10DLC goes on **646-984-6023** and there is no number decision to make.
  ⏳ inii mini has **no billing settings row at all** — it must exist before any
  of these recurring lines can be invoiced.
