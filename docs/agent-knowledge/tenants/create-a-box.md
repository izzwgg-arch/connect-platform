---
tenantId: cmnlgryox001ip9paov24bmr0
tenant: Create A Box
---

# Create A Box

What the assistant should know before answering anyone from this company.
Everything outside the staff-only block may be said to the customer.

<!-- generated:facts -->
<!-- Rewritten by scripts/agent-knowledge/render-tenant-docs.mjs. Edit around this block, not inside it. -->

## Their phone numbers
- (845) 201-9889
- (845) 450-6721
- (845) 782-6722

## Their extensions
- **101** — Blimie Weiss
- **102** — Sender Weiss
- **103** — Mrs. Koufman
- **104** — Main Room
- **105** — Home Line 2
- **106** — Laser Room
- **107** — Home Line 1
- **109** — blimie Cell
- **110** — Mrs. Mushkowitz
- (1 more extension exist but are not active.)

## Texting
- Texting is not set up for this company.

## People with a Connect login
- Senderweiss

<!-- internal -->
## Staff-only notes
- Connect tenant id: `cmnlgryox001ip9paov24bmr0`; on the phone system as tenant 7 (LINKED).
- Customer since 2026-04-05. 682 calls in the last 90 days.
- ⛔ No billing settings row at all — this account has never been set up for billing.
<!-- /internal -->

<!-- /generated:facts -->

## What we have learned about them

Their office runs over a **cellular router with a tunnel back to the phone
system**. When that router loses its state, every desk phone in the office goes
dead at once and callers go straight to voicemail — while everything on our side
looks perfectly healthy. If they report that all the phones stopped together,
power-cycling the office router is the fix, and it is not something they did
wrong.

Individual phones can also stay dark for an hour or two after such an event,
because a phone only recovers at its next check-in.

One person on their team works from a mobile on a cellular connection that
changes address constantly. Calls to that extension are less reliable than the
desk phones, and that is the network rather than the app.

<!-- internal -->
- 2026-08-05 12:57 ET: total desk-phone outage, tcpdump-proven as the GL.iNet
  router (wg peer 10.88.0.2, T-Mobile) losing its NAT ledger. This tenant only.
  Registration expiry on T7 aors 101–107 is capped at 120s so recovery is
  minutes not hours — verify with `pjsip show aor T7_101 | grep -i expir`.
- Ext 102 (Sender Weiss): registered only 1–3.5 h/day, T-Mobile CGNAT churn,
  ~90 IPs in 10 days. Chronic, and separate from the outage above.
- Ext 102's phone served a seven-week-stale config because the panel held the
  WRONG MAC — the phone fetched its own file with a clean 200 every time.
  Fixed 2026-08-06; diagnostic is `grep phoneprov /var/log/nginx/access.log`.
- Ext 104 and 106 were unregistered as of 2026-08-06 and were never chased.
<!-- /internal -->
