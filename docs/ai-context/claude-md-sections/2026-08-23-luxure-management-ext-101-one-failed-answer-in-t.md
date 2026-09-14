# ⛔ AGENT HANDOFF — Luxure Management ext 101: ONE failed answer in three weeks, and it is a DIFFERENT fault from the current regression (2026-08-23) — READ FIRST before answering "did ext 101 have failed answers", before telling Luxure to update the app, or before reading `sip_invite_not_received` as the warm-answer bug

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_LUXURE_101_ANSWER_AUDIT_2026-08-23.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change.**
Tenant `cmnlgryob001cp9pafjjqyc99` = PBX **T5**, ext 101 Simon Wertzberger,
DID (845) 537-8318.)

- ✅ **THE ANSWER: 22 accept taps Aug 2 → Aug 23, 21 connected, ONE failed** —
  2026-08-16 22:34:49Z. Plus 3 deliberate DECLINE taps. Nothing has failed since;
  his last answer (Aug 19 23:45Z) connected in 918 ms.
- ⛔⛔ **THAT FAILURE IS `sip_invite_not_received`, WHICH IS THE OPPOSITE SHAPE
  FROM THE WARM-ANSWER REGRESSION — do not conflate them.** Blackbox reads
  `incomingSessionCount: 0`, `candidates: []`, `answerAttempts: **null**` — the
  answer code never ran, because **no SIP INVITE ever arrived**; the app polled
  **49 s**, force-restarted its socket and gave up while `uaRegistered: true`.
  The regression's fingerprint is the reverse: the INVITE arrives, the device
  answers, and the app kills its own live call at ~500 ms with
  `answerAttempts: 1, pollIterations: 1`. **`answerAttempts: null` vs `1` is the
  one field that tells them apart.**
- ⛔⛔ **AND HE WAS NOT SLOW — the ring reached his phone at t+34.6 s of a
  37.5-second call, he tapped Answer 1.23 s later, and the caller hung up 1.7 s
  after that.** The device was unreachable for the first 34 seconds while
  `connect-mobile-wake-dial` held for it. **Nothing about that call is user
  error and nothing about it is the answer code** — check the push-to-ring gap
  (`payload.pushMeta.pushReceivedAt` against the `pbxCallId` epoch) before
  reading any answer failure as a slow tap.
- ⛔ **Cause is the documented filtered-internet problem, still unfixed for this
  tenant.** Luxure is **NOT** on the 443 route (`webrtcRouteViaSbc: false`,
  `sipWsUrl wss://m.connectcomunications.com:8089/ws`), and its contacts are
  **`192.157.90.x`** — the Cologuard filter from
  `AGENT_HANDOFF_FILTERED_INTERNET_2026-08-03.md` — rotating address AND port
  constantly: **751 REGISTERED / 705 UNREACHABLE / 630 UNREGISTERED on
  `T5_101_1` in 7 days** (~107 re-registrations/day), matched by 306
  `WS_CONNECTED` / 293 `WS_DISCONNECTED` client-side. The ring push rides FCM so
  the screen still lights; the INVITE goes to a contact the filter will no longer
  deliver to. **The 2026-08-03 recommendation to move this tenant to
  SIP-over-443 (as Displaydex was on 08-05) was never applied — three fields, no
  deploy, but the user must sign out and back in. Izzy's call.**
- ⛔⛔ **HE IS ON `1.0.0+20260801-231353` AND MUST STAY THERE.** Every
  `SESSION_START` he has ever sent reports that build, so he is **not** exposed
  to the regression in every APK published since 2026-08-22. **13 of his 21
  successful answers (62%) took longer than 500 ms** — the whole budget the
  current build allows — so updating him today would break most of his answers.
  **Do not tell Luxure to install the latest APK until the deadline fix ships.**
- ⛔ **A blackbox is not the only failure shape** — also correlate every
  `ANSWER_TAPPED action=ACCEPT` against a `CALL_CONNECTED` within ~20 s. Both
  methods agreed on the same single call here, which is what makes "1" safe to
  report; the tap-correlation alone would also have caught a failure that
  uploaded no blackbox.
- ⏳ **Noticed in passing, NOT proven a fault: their DID has taken ZERO calls
  since 2026-08-21T19:53Z** (Friday afternoon), across Sat + Sun, while the app
  kept registering all weekend. Checked before reporting: the **CDR pipeline is
  healthy platform-wide** (newest CDR 2026-08-23T21:54Z) and the **DID is still
  live** (`PbxTenantInboundDid` `8455378318` → T5, `active: true`, synced
  22:00:38Z), and their weekend volume is genuinely low (2–7/day) — so it is most
  likely a quiet Shabbos weekend. **One test call to (845) 537-8318 settles it**
  and is worth doing before Monday.
- ⛔ Field-name traps that each cost a round trip: `MobileDevice` has **`model`**
  not `deviceModel`; `PbxEndpointRegistrationEvent` has **`endpoint`** +
  **`status`**, not `endpointName`/`eventType`; `PbxTenantInboundDid` keys on
  **`e164`**. And `require("@connect/db")` fails inside `app-api-1` — use
  `new (require("@prisma/client").PrismaClient)()`.
