---
tenantId: cmqtgxtwr1rhgmk130kw0ustz
tenant: RSBK
---

# RSBK

What the assistant should know before answering anyone from this company.
Everything outside the staff-only block may be said to the customer.

<!-- generated:facts -->
<!-- Rewritten by scripts/agent-knowledge/render-tenant-docs.mjs. Edit around this block, not inside it. -->

## Their phone numbers
- (845) 305-0203

## Their extensions
- **101** — Appointments
- **102** — Hazkoora
- **103** — Emergancy
- **104** — Barish

## Texting
- Texting is not set up for this company.

## People with a Connect login
- sh9673
- rosnfeld.yoel
- 7816646

<!-- internal -->
## Staff-only notes
- Connect tenant id: `cmqtgxtwr1rhgmk130kw0ustz`; on the phone system as tenant 34 (LINKED).
- Customer since 2026-06-25. 909 calls in the last 90 days.
- ⛔ No billing settings row at all — this account has never been set up for billing.
<!-- /internal -->

<!-- /generated:facts -->

## What we have learned about them

A busy account — around nine hundred calls a quarter across four extensions,
with 101 "Appointments" taking most of it.

Two things have caused them trouble. Calls to Appointments were not reaching the
phone app at all, so they rang out with nobody able to pick up. And do-not-disturb
has been left switched on for that extension for a long stretch, which stops it
ringing entirely — worth checking first if they say a line is silent.

They have also hit a problem where a voicemail looks like it is playing but no
sound comes out, and reinstalling the app was the only thing that helped. If
that happens again, force-stopping the app from the phone's settings and
reopening it does the same job without a reinstall.

Texting is not set up for this company.

<!-- internal -->
- Phone system tenant 34. ⛔ Ext 101's dial key rings only the dead base
  endpoint, so calls never reach the app. The fix is to add the app endpoint
  alongside it — a phone-system write, still open.
- DND on 101 has been on since early July. Check it before promising the line
  will ring.
- The silent-voicemail symptom was a leaked phone-system call left active by a
  ghost ring. Backstops shipped, but older app builds still need the force-stop.
- Three Android phones on one login.
<!-- /internal -->
