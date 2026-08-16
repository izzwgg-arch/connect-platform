---
tenantId: cmnlgryob001cp9pafjjqyc99
tenant: Luxure Management
---

# Luxure Management

What the assistant should know before answering anyone from this company.
Everything outside the staff-only block may be said to the customer.

<!-- generated:facts -->
<!-- Rewritten by scripts/agent-knowledge/render-tenant-docs.mjs. Edit around this block, not inside it. -->

## Their phone numbers
- (845) 537-8318

## Their extensions
- **101** — Simon Wertzberger
- **102** — Secretary
- **103** — Sec hard phone
- **104** — phone

## Texting
- (845) 537-8318

## People with a Connect login
- simonwer08 — the account admin
- info

<!-- internal -->
## Staff-only notes
- Connect tenant id: `cmnlgryob001cp9pafjjqyc99`; on the phone system as tenant 5 (LINKED).
- Customer since 2026-04-05. 135 calls in the last 90 days.
- ⛔ No billing settings row at all — this account has never been set up for billing.
- Admin login: simonwer08@gmail.com
<!-- /internal -->

<!-- /generated:facts -->

## What we have learned about them

Their internet runs through a content filter. That is normal for them and for a
lot of our customers, but it means the phone app's connection gets dropped and
remade far more often than usual. Most of those reconnects last only a few
seconds and nobody notices them. So a long list of reconnects is not by itself
evidence that something is broken — the question is always whether a real call
was actually missed.

Extension 104 is set up to dial Simon's mobile. Nothing rings into 104 from
outside, and that is deliberate.

<!-- internal -->
- Phone system tenant 5. Simon Wertzberger is ext 101 and the account admin.
- Their traffic arrives through a filtering proxy, so the contact address on a
  registration belongs to the filter, not to them. Split reconnects by duration
  before reporting instability — the sub-5-second ones are lease renewals, and a
  fixed interval between them means a timer, not a bad line.
- Ext 101 is enrolled in wake-and-wait. ⛔ Ext 104 is outbound-only by Izzy's
  instruction — do not add it to a ring group to "fix" it.
- Two Android phones on one login.
<!-- /internal -->
