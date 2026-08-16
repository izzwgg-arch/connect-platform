---
tenantId: cmsgkl4y95grttd13yqhyf1gd
tenant: inii mini
---

# inii mini

What the assistant should know before answering anyone from this company.
Everything outside the staff-only block may be said to the customer.

<!-- generated:facts -->
<!-- Rewritten by scripts/agent-knowledge/render-tenant-docs.mjs. Edit around this block, not inside it. -->

## Their phone numbers
- (646) 984-6023
- (845) 260-5692

## Their extensions
- **101** — baila
- (1 more extension exist but are not active.)

## Texting
- (646) 984-6023 — the number their texts go out from

## People with a Connect login
- sales — the account admin

<!-- internal -->
## Staff-only notes
- Connect tenant id: `cmsgkl4y95grttd13yqhyf1gd`; on the phone system as tenant 105 (LINKED).
- Customer since 2026-08-05. 184 calls in the last 90 days.
- ⛔ No billing settings row at all — this account has never been set up for billing.
- Admin login: sales@iniimini.com
<!-- /internal -->

<!-- /generated:facts -->

## What we have learned about them

They came onto Connect through the sign-up flow and **moved their existing
number across from their old carrier**. That transfer completed on 12 August
2026: their real number now rings on Connect and texting works on it. The
temporary number they used while waiting has been retired.

Their extension is 101. It started life numbered 1 and had to be changed, so
anything in their setup still referring to a one-digit extension is stale.

## What they sell, and where

inii mini is a **children's and baby clothing store** — Liberty-print footie
sets, pajamas, nightgowns, layette — selling online at **iniimini.com**, which
runs on Shopify. Prices sit around $52–64 and the catalog runs to roughly 120
products. Their customer base is largely a community that does not use the
internet: many customers have filtered phones or flip phones and shop by
phone rather than by browser.

## Shopping by text (planned)

We are planning a **text-message shopping assistant** for them: a customer
texts their store number, asks about products in plain language, receives
photos and prices as picture messages, and places an order — all by text, no
website or app needed. Orders would land in their normal Shopify screen and
stock would keep itself right. It is quoted and not yet started, so nothing
about it works today. If anyone from inii mini asks about it, it is a plan
under discussion, not a live service.

<!-- internal -->
- **Shop-by-text project (quoted 2026-08-16, NOT started).** Full record:
  `docs/ai-context/AGENT_HANDOFF_INII_MINI_SHOP_BY_TEXT_2026-08-16.md`.
  Quoted to Izzy's customer at a **20-hour / $5,000 ceiling** (expected 28–30h
  of real work was cut to 20 on his instruction — the overrun is his to absorb).
  Recurring, billed by Connect on their normal invoice: server $9/mo, AI usage
  $20–100/mo, **SMS 1.5¢ / MMS 2¢ per message**, plus 10DLC fees.
  ⛔ The agent's messaging is a SEPARATE line from the $10/mo texting they
  already pay for — never merge the two on an invoice or in an explanation.
- Payments are **deliberately out of phase 1**: orders complete as
  payment-pending, the store collects as it does today. Phase 2 (Sola card-on-
  file) is separately quoted and unstarted.
- Proposal PDF + artifact:
  <https://claude.ai/code/artifact/06af7ba8-35c6-4381-8ec6-3f8b453d65f3>
<!-- /internal -->

<!-- internal -->
- Port order 217760 (Verizon) landed 2026-08-12 — the first fully automatic
  landing end to end: routed to subaccount, SMS claimed, inbound route 240
  built, switched to Connect and published, temp 845-260-5692 retired.
- The switch only worked after restarting `connect-pbx-helper` (fd exhaustion).
- Their old temp inbound route on PBX tenant 105 still exists and costs $3/mo
  E911 until it is deleted in the panel.
- baila is the ONLY admin on this tenant — never delete that login.
<!-- /internal -->
