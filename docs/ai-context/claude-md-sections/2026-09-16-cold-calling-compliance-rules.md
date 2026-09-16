# Cold-calling on Loopcom/Telnyx — the compliance ground rules (advisory, nothing built) — 2026-09-16

A customer asked Izzy to set up a few people for cold calling. Izzy asked whether it can be
done 100% legal + 100% inside Telnyx policy, without risking the platform. This file is the
ruling so any future session that builds dialer features or onboards this customer starts
from the same rules. **Nothing was built or changed for this — advisory only.**

## The verdict
**Doable — as HUMAN-DIALED cold calling only.** A few salespeople clicking/dialing one call
at a time from their extensions is ordinary business use. What is NOT doable on Telnyx:

- ⛔⛔ **Telnyx's AUP explicitly bans auto-dialing / predictive dialing ("robo-dialing")**,
  abandoned calls above thresholds, and "unsolicited calls … that could reasonably be
  expected to or do in fact provoke complaints" (telnyx.com/acceptable-use-policy, read
  2026-09-16). So: no power/predictive dialer, no prerecorded-message drops, no ringless
  voicemail, ever. A human presses the button on every call.
- ⛔ **Short-duration-call rule**: Telnyx allows ≤15% of monthly traffic at ≤6 s; above that
  → email warning, then penalty pricing on ALL SDCs that month. Cold calling naturally
  makes short calls — pacing + caps keep this under the line
  (support.telnyx.com article 1130707).

## The law (US), in the order it bites
1. **National DNC registry** — consumer numbers on the DNC may not be cold-called (no
   consent / no existing business relationship). The CUSTOMER must get their own SAN at
   telemarketing.donotcall.gov and scrub lists at least every 31 days. **B2B calls are
   mostly exempt from DNC** — a business-targeted campaign is the safe shape.
2. **TCPA** — no autodialer or artificial/prerecorded voice to cell phones without prior
   express (written, for marketing) consent. Human manual dialing sidesteps the ATDS issue
   entirely. $500–$1,500 statutory damages PER CALL, private right of action.
3. **Calling hours** — 8am–9pm at the CALLED party's local time (federal); FL/OK are
   8am–8pm and FL caps 3 attempts/24h per subject (state mini-TCPAs are stricter).
4. **Truth in Caller ID Act** — CID must be a real, answerable callback number owned by the
   caller. Never rotate through pools of numbers to dodge spam labels (snowshoeing — that
   pattern itself gets accounts terminated).
5. **TSR disclosures** — promptly identify the caller, the company, and that it's a sales
   call; keep an internal DNC list, honor requests immediately, retain 5 years.
6. **State telemarketer registration** — several states (incl. NY) require registration/
   bonding for telemarketing operations. The customer's obligation; flag it to them.
7. **Loopcom's own RMD duty** — Loopcom is in the Robocall Mitigation Database (see the
   FRN/499 handoff): we must know this customer (KYC), keep the signed agreement, and be
   able to answer a traceback. This customer's traffic is exactly what that file is for.

## How to set it up so Loopcom is protected
- **Their own numbers, not shared ones** — complaints and spam labels attach to the DIDs.
  Keep this tenant's outbound on DIDs owned by/assigned to them only. (On Telnyx, numbers
  on the account sign SHAKEN **A** automatically — good for answer rates.)
- **Separate blast radius** — when this moves onto Telnyx, put the tenant's traffic behind
  its own outbound voice profile (own daily spend cap, own concurrency), tagged with
  `customer_reference`, so Telnyx enforcement lands on the profile, not the platform.
  Managed Accounts is the real isolation lane later (approval-gated, see Telnyx handoff).
- **Caps Izzy already offered = right instinct.** Reasonable shape: per-extension daily
  outbound cap (~100–150/day is a human dialer's natural max anyway), per-DID daily cap
  (keep a number under ~100 calls/day to stay off Hiya/TNS/First Orion spam models), and
  hours enforcement (block outbound to a destination outside its local 8am–8pm).
- **Paper first**: written rider making the customer responsible for TCPA/TSR/DNC
  compliance — they hold the SAN, they scrub, they keep consent/DNC records, they
  indemnify Loopcom; Loopcom may suspend on complaint signals. No rider, no dial tone.
- **Watch it**: spam-label checks on their DIDs (Free Caller Registry registration helps),
  SDC% of their traffic, any Telnyx complaint notice → kill switch first, investigate after.

## Not proven / not built
⏳ No cap enforcement, hours enforcement, or per-tenant outbound throttle exists in Connect
today — those are build items if Izzy signs this customer. No rider template written.
