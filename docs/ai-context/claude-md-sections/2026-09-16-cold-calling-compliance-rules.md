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

## Evidence of human dialing (Izzy's follow-up, same day) — what the system can prove
Verified in code 2026-09-16:
- **Web/desktop softphone: YES, press-level evidence.** `CLIENT_TRACE` (`press` in the
  allowlist `apps/api/src/voice/clientTraceBatch.ts`, stored as `VoiceDiagEvent` rows)
  records every press with timestamps — a dial is a human tapping digits (digit COUNT,
  no numbers, by design). Server-stamped identity + session; forged rows dropped.
- **Mobile: Call Flight Recorder** (`CallFlightSession`, one session per call attempt).
- **CDRs both sides** (`ConnectCdr`/`CallRecord` + the PBX's own CDRs): timestamps,
  durations, pacing — one-call-at-a-time human cadence is visible.
- **No autodialer exists in the product** — in a TCPA fight the question is the
  equipment's capacity; Connect exposes no bulk/predictive dial capability to a tenant.
- **Retention: nothing prunes any of these tables today** (grepped: no `deleteMany` on
  voiceDiagEvent/connectCdr/callRecord in prod code) — but that is an accident, not a
  policy. TCPA SOL = 4 years; write a retention policy before selling this as evidence.
- ⛔ **The gaps, stated honestly:** DESK-PHONE calls leave CDRs only, no press trace
  (a Yealink keypad is invisible to us) — cold callers should work from the
  softphone/app if evidence matters; CLIENT_TRACE is best-effort telemetry (300-row
  ring buffer, batches lost if a window dies; old bundles record nothing), it was
  built for support, not as a compliance audit log. A gap proves nothing either way.

## DNC hookup cost + dial-time blocking (Izzy's follow-up #2, same day)
- **FTC registry fees (the customer's cost, not ours):** first 5 area codes FREE;
  $82/area-code/yr FY2026 → $85 from Oct 1 2026; all-US cap $22,626. ⛔ The SAN must be
  in the SELLER's (customer's) name — SANs cannot be shared; Loopcom as service provider
  may download under the customer's SAN. Regional campaign ≤5 area codes = $0.
- **No FTC real-time API** — you download list + change files per subscribed area code.
  Wiring shape: DNC table in Connect + nightly sync under the customer's SAN + dial-time
  lookup on flagged extensions at the PBX outbound path (curl-to-Connect, the doorway
  pattern; ⛔ PBX-write territory — clone rehearsal + reconciler rules apply). The
  customer's internal DNC list (legally mandatory) rides the same table.
- **Shortcut lane:** commercial scrub APIs (DNC.com/PossibleNOW) ~$1k–3k/yr bundle
  federal + STATE DNC lists + known-litigator screening behind a real-time API — the
  better lane if this grows past one customer.
- **The onboarding flow (Izzy's follow-up #3): no API keys exist — the customer's SAN IS
  the key.** Customer registers as a SELLER at telemarketing.donotcall.gov (~15 min,
  free ≤5 area codes), hands us the SAN. Loopcom registers ONCE as a Telemarketer/
  Service Provider (TM/SP) profile — free, and every future cold-calling customer's SAN
  just gets added under it; downloads run under our TM/SP login on the seller's behalf
  (FTC-sanctioned). Access = automated file downloads (full list once, then DAILY change
  files), not REST. Build notes: SAN + renewal date live on the tenant (⛔ calling on an
  EXPIRED SAN is itself a violation — nag before expiry), and the dial-time block FAILS
  CLOSED if the sync goes staler than the 31-day scrub window.

## BUILD ORDERED, THEN PIVOTED TO MOCKUPS (Izzy, same day) — awaiting approval
Izzy: build it end-to-end into the CRM as a GATE — then mid-task: "make a switch for it…
by default, if I turn on the CRM for somebody, that would be the gate unless I turn it
off… in the admin panel… Show me mockups." So: **MOCKUPS ONLY, artifact
`MWbMeajvf7USPXT2hKWRpa`** (source `docs/mockups/dnc-gate/dnc-gate-mockups.html`), build
paused for his approval. The design shown:
- **Rule: CRM ON ⇒ gate ARMED by default** (CRM extensions blocked from dialing until DNC
  ready); per-tenant off-switch on the tenant's admin page + an Admin → DNC-gate overview.
- ⛔⛔ **Rollout decision flagged IN the mockup: existing CRM tenants (Gesheft etc.) seed
  OFF** or deploying this blocks their calling instantly (they have no SAN). New CRM
  activations arm by default. Izzy has not yet confirmed.
- Customer setup page (SAN + expiry + area codes + registry file upload + gated-extension
  list), fail-closed past the 31-day scrub window, two blocked-dial toasts (setup
  incomplete / number on DNC), evidence log of every dial check with list age.
- Enforcement legs planned: softphone pre-dial check via api (Phase 1, in-repo) +
  PBX outbound dialplan hook (Phase 2, ⛔ clone rehearsal — global dial path, must
  fail open for non-armed tenants and bound the curl timeout). Nothing coded yet.

## Not proven / not built
⏳ No cap enforcement, hours enforcement, or per-tenant outbound throttle exists in Connect
today — those are build items if Izzy signs this customer. No rider template written.
