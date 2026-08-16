---
tenantId: cmnlgnumu0001p9g6xyl1pbdd
tenant: Gesheft
---

# Gesheft

What the assistant should know before answering anyone from this company.
Everything outside the staff-only block may be said to the customer.

<!-- generated:facts -->
<!-- Rewritten by scripts/agent-knowledge/render-tenant-docs.mjs. Edit around this block, not inside it. -->

## Their phone numbers
- (845) 244-9666
- (845) 305-0021

## Their extensions
- **101** — Phone Orders
- **102** — Customer Service
- **103** — Customers Phone
- **104** — Register 2
- **105** — Register 3
- **106** — Register 4
- **107** — Customer Phone 2
- **108** — Office 2
- **109** — Hiring
- **111** — Accounts Payable
- **112** — Yossef Friedman
- **114** — Accounts Receivable
- **115** — Phone Orders 2
- **116** — Phone Orders 3
- **117** — Phone Orders 4
- **118** — Phone Orders 5
- **897** — Intercom
- **898** — Order Tracking

## Texting
- (845) 244-9666 — the number their texts go out from

## People with a Connect login
- Orders
- contact
- Orders
- scn@gesheftkosher.com
- connect@gesheftkosher.com
- Accounts Receivable

<!-- internal -->
## Staff-only notes
- Connect tenant id: `cmnlgnumu0001p9g6xyl1pbdd`; on the phone system as tenant 8 (LINKED).
- Customer since 2026-04-05. 12159 calls in the last 90 days.
- ⛔ No billing settings row at all — this account has never been set up for billing.
<!-- /internal -->

<!-- /generated:facts -->

## What we have learned about them

They are the busiest company on Connect by a wide margin — over twelve thousand
calls in the last ninety days — and most of it lands on the order lines. Answers
about their call volume should assume a shop under real pressure, not an office.

They work out of **two locations**, and extension 101 rings in both of them. If
someone reports that a call rang somewhere it should not have, that is why.

**Voicemail-to-email is only set up on some of their mailboxes.** Extensions
101, 102, 111, 114, 115 and 898 send emails; several others record voicemail but
email nobody. If someone says "we stopped getting voicemail emails", the honest
first question is which extension — because for some of them, no email was ever
being sent.

Their phones sign in over a route that goes through Connect's own server rather
than straight to the phone system. That changes nothing about how they work; it
matters only if they are moved between routes, which requires signing out and
back in on every phone.

<!-- internal -->
- Ext 101's INBOX holds ~9,146 of a 9,999 maximum, growing ~35/day. At the wall
  Asterisk plays "mailbox full" and the caller is NOT recorded — no voicemail,
  no email, no Connect row. This will present as "we stopped getting voicemail
  emails" and is a hard deadline, not a nuisance. 102 holds ~2,612.
- Blind mailboxes (no address in the voicemail conf): 103, 104, 105, 106, 108,
  112, 116, 117, 118, 897. 112 alone had 11 unnotified voicemails in 30 days.
- ⛔ Ext 102 emails to `Orders@pileupny.com` — another company's domain. It
  delivers, but nobody has confirmed it is intentional. Do not "fix" it silently.
- Two sites: 75.99.30.60 (102–111, 897, the original 101) and 66.250.98.9
  (114/115/116 and the moved 101).
- On the 443 SIP route, so contact IPs all read as the Connect server — PBX-side
  contact whois tells you nothing for this tenant.
- No billing settings row exists for them at all.
<!-- /internal -->
