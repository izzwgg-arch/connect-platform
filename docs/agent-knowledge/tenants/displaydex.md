---
tenantId: cmnlgryom001fp9paw7le6582
tenant: Displaydex
---

# Displaydex

What the assistant should know before answering anyone from this company.
Everything outside the staff-only block may be said to the customer.

<!-- generated:facts -->
<!-- Rewritten by scripts/agent-knowledge/render-tenant-docs.mjs. Edit around this block, not inside it. -->

## Their phone numbers
- (212) 888-0885
- (845) 200-3535
- (845) 364-7474
- (845) 414-3736

## Their extensions
- **101** — Eli Lovi
- **102** — Michael Fromowitz
- **103** — Micheal Cell
- **104** — Yehuda Tyberg

## Texting
- (845) 200-3535 — the number their texts go out from

## People with a Connect login
- eli
- Michael
- Yehuda

<!-- internal -->
## Staff-only notes
- Connect tenant id: `cmnlgryom001fp9paw7le6582`; on the phone system as tenant 6 (LINKED).
- Customer since 2026-04-05. 71 calls in the last 90 days.
- ⛔ No billing settings row at all — this account has never been set up for billing.
<!-- /internal -->

<!-- /generated:facts -->

## What we have learned about them

Their main user is on an iPhone and had the app freezing on him. That was traced
to how his phone reached the phone system and fixed by moving them onto a
different route. After a change like that each phone must sign out and sign back
in once — the app keeps the old setting until it does.

He has also reported that pasting does not work inside the app on a very new
version of iOS. That is a real difference between iPhone versions, not something
he is doing wrong.

They keep a large contact list. There was a period when contacts past the first
thousand were invisible in the phone app, so people appeared to be missing and
re-adding them was refused as a duplicate. That is fixed — so if someone says a
contact "disappeared", it is worth checking rather than assuming they deleted it.

<!-- internal -->
- On the 443 SIP route since 2026-08-05 (`webrtcRouteViaSbc=true`,
  `sipWsUrl=null`). Contact IPs now read as loopcom — use nginx logs, not
  PBX-side contact whois.
- 1,247 contacts; 16 of 16 iOS saves failed before the paging fix, and zero
  contacts were created between 31 Jul and that fix.
- Eli is on TestFlight ("Loopcom Testers"). The paste problem is on iOS 26.5;
  candidate fix is RN 0.81.6 in a later build. Not resolved.
<!-- /internal -->
