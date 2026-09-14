# ⛔ AGENT HANDOFF — the phone rang while the PBX had nowhere to send the call (2026-08-10) — READ FIRST for ANY "it rang but never connected", before treating a ring as proof the phone was reached, before flipping a tenant onto the 443 SIP route, or before looking a tenant up by name

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DEMO_INCOMING_CALLS_443_2026-08-10.md`**
(Loopcom Demo ext 101. **Config only — no deploy, no code change, no PBX write.**)

- ⛔ **THE RULE: a ring notification must not be sent when the call has nowhere
  to land — and nothing checks.** The ring push and the actual call are two
  independent systems. On all four calls the push path was perfect (`expoStatus:
  ok`, incoming screen **76 ms** after the push) while `PJSIP_DIAL_CONTACTS` was
  **empty** and `connect-wake-core` spun once a second for **13 s** (call 1) and
  **18 s** (call 4) without ever dialling the phone. Same family as
  [[desktop-ring-has-no-off-switch]].
- ⛔ **A client's own "registered" is an OPINION; the PBX contact list is the
  FACT.** The app reported `registered / wssConnected / sipStackHealthy` with a
  535 s-old registration while `pjsip show endpoint T102_101_1` read
  **`Unavailable, 0 of inf`** — and still did 13 minutes later. Believe the PBX.
- ⛔ **"Voicemail AND still ringing" was FOUR calls overlapping, not one call
  misbehaving.** The caller redialled 4× in 90 s. Line calls up by `linkedid`
  before believing one call did two contradictory things. The voicemail was a
  **DECLINE** (19:04:55 → `sub-leave-vm` → `VoiceMail(101@…,u)` one second
  later); **no message was recorded** — the INBOX newest is Aug 2. The
  still-ringing was call 4, where a DECLINE was tapped with **no SIP session
  behind it**, so it reached nothing and the PBX rang on 14 s more.
- **Cause of the churn:** every contact was `192.157.84.x` = **Cologuard, Old
  Bridge NJ** (the filter family in [[webrtc-filtered-internet-port-8089]]).
  `qualify_frequency 30` pings each contact; the filter never returns it, so the
  contact is dropped and re-minted on a new port — **23 registration events in 22
  minutes**.
- ⛔ **Moving a tenant to 443 is THREE fields, not two:** `webrtcRouteViaSbc:
  true` + `sipWsUrl: null` + **`sipDomain: "m.connectcomunications.com"`**. Both
  tenants moved had an IP literal in `sipDomain` too;
  `normalizeSipWsUrlHost()` self-corrects an IP-literal *sipWsUrl* and **nothing
  corrects `sipDomain`**. Diff the whole row against Gesheft/Displaydex. Read
  live per request — no deploy, no restart. ⛔ Probe the route with
  **`curl --http1.1`** — nginx has HTTP/2 on and a default curl returns **426
  Upgrade Required**, which reads like a broken route (correct answer: `101
  Switching Protocols` + `Sec-WebSocket-Protocol: sip`).
- **On 443 now:** Gesheft, Displaydex, **Loopcom Demo**, **inii mini**. ⛔ inii
  mini did **not** have this fault (11 reg events in 24 h, Optimum static
  business IP, `Avail` at 34.9 ms) — it was moved on Izzy's instruction, not on
  evidence. ⏳ **Nobody has completed a call on 443 on either tenant**, and both
  need their phones to **sign out and back in** (the app never refreshes a cached
  `sipWsUrl` — which is also why the flip is inert on a live session and broke
  nothing).
- ⛔ **21 of 50 tenant rows carry `pbxRemovedAt`** — a raw name lookup returns
  companies no Connect screen shows (cost a round of "which inii mini is real?").
  Filter `pbxRemovedAt: null`. They are inert: `billing/routes.ts:647` excludes
  them, so their ACTIVE billable extensions cannot invoice. Erase is a separate
  confirmed call and never touches a tenant that ever paid. See
  [[removed-tenants-still-answer-name-lookups]].
- ⏳ **Unexplained: "we got Unknown."** Every record carries the number — invite
  row, VoIP `callerNumber`, flight recorder, SIP invite. No CNAM from the carrier
  is normal. Ask WHICH SCREEN said Unknown before hunting.
- **Still open (the 443 move does not fix these):** the api fans out ring pushes
  without consulting whether the PBX holds a contact — though `connect-wake-core`
  already computes exactly that verdict as `WARM`; a decline with no session
  behind it is silently dropped; and the wake loop spins its full grace period
  against a permanently empty contact list instead of failing to voicemail early.
