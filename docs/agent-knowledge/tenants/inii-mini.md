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

<!-- internal -->
- Port order 217760 (Verizon) landed 2026-08-12 — the first fully automatic
  landing end to end: routed to subaccount, SMS claimed, inbound route 240
  built, switched to Connect and published, temp 845-260-5692 retired.
- The switch only worked after restarting `connect-pbx-helper` (fd exhaustion).
- Their old temp inbound route on PBX tenant 105 still exists and costs $3/mo
  E911 until it is deleted in the panel.
- baila is the ONLY admin on this tenant — never delete that login.
<!-- /internal -->
