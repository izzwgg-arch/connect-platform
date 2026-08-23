# AGENT HANDOFF — Luxure Management ext 101: 1 failed answer in three weeks, and it is NOT the current regression (2026-08-23)

**Read-only investigation. No code change, no deploy, no build, no PBX write, no
data change.** Izzy, 2026-08-23: *"Check Luxure Management 101 Android app if he
had any failed answers in the past two or three weeks."*

Tenant **Luxure Management** `cmnlgryob001cp9pafjjqyc99` (PBX **T5**), ext **101
Simon Wertzberger**, user `cmnmjhp83007np96hmme5t38q`, DID **(845) 537-8318**.

---

## 1. THE ANSWER: 22 answer taps, 21 connected, **1 failed** — 2026-08-16 6:34 PM ET

Window swept: **2026-08-02 → 2026-08-23** (three weeks).

| | count |
|---|---|
| `ANSWER_TAPPED` with `action=ACCEPT` | **22** |
| …that reached `CALL_CONNECTED` | **21** |
| …that did not | **1** (2026-08-16T22:34:49Z) |
| `ANSWER_TAPPED` with `action=DECLINE` (deliberate) | 3 |
| `WEBRTC_INBOUND_ANSWER_FAIL` blackboxes | **1** |

Successful tap→connect times, all 21: 305, 309, 323, 324, 339, 376, 479, 485,
588, 656, 707, 713, 747, 773, 803, 918, 950, 1135, 1262, 1319, 2775 ms.

⛔ **There is exactly ONE failure and it is not part of a pattern** — the other
21 answers connected, and the most recent one (2026-08-19 23:45Z) connected in
918 ms. Nothing has failed since.

---

## 2. The one failure, in full — `sip_invite_not_received`, NOT the answer-deadline bug

Call `1786919653.221382`, from `9293555916` → `8455378318`, 2026-08-16
22:34:13Z. CDR: **`missed`**, rang **37 s**, caller hung up.

Blackbox (`VoiceDiagEvent` `CALL_QUALITY_REPORT`,
`payload.debugKind = WEBRTC_INBOUND_ANSWER_FAIL`):

```
failureReason:          "sip_invite_not_received"
incomingSessionCount:   0
answerableSessionCount: 0
candidates:             []
newRtcsessionObserved:  false
uaConnected: true   uaRegistered: true   sipStackHealthy: true
answerAttempts: null   pollIterations: null
sinceAnswerMs: 49293
backendAccept: { requested: true, responseCode: "INVITE_CLAIMED_OK" }
```

Timeline: push received → incoming screen shown → he tapped Answer **1,231 ms
after the push** → backend claim returned **INVITE_CLAIMED_OK** → the app then
sat for **49 seconds** waiting for a SIP INVITE **that never arrived**, forced a
socket restart, and gave up.

⛔⛔ **This is the opposite shape from the 2026-08-23 warm-answer-deadline
regression.** There, the INVITE arrives, the device answers, and the app tears
down its own live call at ~500 ms (`answerAttempts: 1, pollIterations: 1,
durationUntilFailureMs ≈ 641–745`). Here `answerAttempts` is **null** — the
answer code never ran at all, because there was no session to answer.
**The PBX rang him over a socket the INVITE could not come back down.**

---

## 3. ⛔ Why: Luxure is still on the direct-to-PBX route behind the content filter

```
webrtcRouteViaSbc: false
sipWsUrl:          wss://m.connectcomunications.com:8089/ws
sipDomain:         m.connectcomunications.com
```

Live contact URIs on `T5_101_1` today are **`192.157.90.x`** — the **Cologuard
content filter** (`192.157.80.0/20`, Old Bridge NJ) documented for this exact
tenant in `AGENT_HANDOFF_FILTERED_INTERNET_2026-08-03.md` — and the contact
address **and port rotate constantly**:

```
21:48:48 REGISTERED   sip:73o234jc@192.157.90.181:35472;transport=ws
21:48:48 UNREGISTERED sip:0alnprg6@192.157.90.164:35852;transport=ws
21:48:48 UNREACHABLE
21:34:49 REGISTERED   sip:0alnprg6@192.157.90.164:35852;transport=ws
21:29:24 UNREGISTERED sip:u47s9ne9@192.157.90.164:47916;transport=ws
```

**`PbxEndpointRegistrationEvent` for `T5_101_1`, last 7 days:
751 REGISTERED / 705 UNREACHABLE / 630 UNREGISTERED** — roughly **107
re-registrations a day**. His own client telemetry agrees: **306
`WS_CONNECTED` / 293 `WS_DISCONNECTED` / 306 `SIP_REGISTER` / 292
`SIP_UNREGISTER` in 7 days**.

`sip_invite_not_received` is exactly what that churn produces: the PBX holds a
contact the filter will no longer deliver to, so the ring push (which travels
over FCM, not SIP) still lights the screen while the INVITE goes nowhere.

⛔ **The fix recommended on 2026-08-03 — move Luxure to the SIP-over-443 route
as was done for Displaydex on 2026-08-05 — was never applied.** It is three
fields (`webrtcRouteViaSbc: true`, `sipWsUrl: null`, `sipDomain` →
`m.connectcomunications.com`), read live per request, no deploy — and the user
must sign out and back in, because the app never refreshes a cached `sipWsUrl`.
**That is Izzy's call, not an automatic one.**

---

## 4. ⛔⛔ HE IS ON THE 2026-08-01 BUILD — DO NOT TELL HIM TO UPDATE

Every `SESSION_START` he has sent, up to the newest (2026-08-21T19:54Z),
reports **`1.0.0+20260801-231353+1785640433`**. He is therefore **not** exposed
to the warm-answer regression carried by every Android build published since
2026-08-22.

⛔ **If he installs the current APK, most of his answers will start failing.**
Measured against his own 21 successful answers: **13 of 21 (62%) took longer
than 500 ms** to connect — the entire budget the current build allows on the
warm answer path. (Same methodology as
`AGENT_HANDOFF_WARM_ANSWER_DEADLINE_2026-08-23.md` §6, which measured Create A
Box ext 102 the same way.)

**Leave him on 20260801 until the one-line deadline fix ships.**

---

## 5. Everything else that is true about this line

- **Not-answered inbound calls, Aug 2 → Aug 23: 17.** Three of those he
  **declined on purpose** (Aug 2 21:27, Aug 13 18:13, Aug 16 03:18 — each has a
  matching `action=DECLINE` tap). Three never rang the app at all (caller id
  `Restricted`, 100 s each). The remaining eleven rang the app and nobody
  picked up — ordinary missed calls, not failures.
- **7 voicemails** since Aug 2.
- Two **active** Android devices on this user, both seen today: **SM-X828U**
  (Samsung tablet, Android 16) and a **Unihertz Jelly Star** (Android 13). Both
  hold a native FCM token, so both are on the fast push channel.
  ⛔ `MobileDevice.appVersion` is null on both live rows — the version only ever
  arrives in a `SESSION_START` payload (the stale 2026-06-26 row still says
  `1.0.0`). `SESSION_START` carries no device model, so the two devices cannot
  be told apart by version — every session reports the same 20260801 build.
- ⛔ `iceHasTurn: false` in his `SESSION_START` payloads is the documented lie
  (the client never sends the field; the server defaults it). Ignore it.

---

## 6. ⏳ Noticed in passing, NOT a fault I could prove — two quiet days

**Their DID has received nothing since 2026-08-21T19:53Z (3:53 PM ET Friday)** —
zero calls on Sat 22 and Sun 23, and no client telemetry since 19:55Z the same
evening, while the app has kept registering to the PBX all weekend (newest
registration 2026-08-23T21:48Z).

Checked before reporting it, and it is **most likely just a quiet weekend**:

- The **CDR pipeline is healthy platform-wide** — newest CDR 2026-08-23T21:54Z
  (Gesheft), so this is not an ingest failure.
- **The DID is still live**: `PbxTenantInboundDid` `8455378318` → `T5` /
  `luxure_management`, `active: true`, its sync record refreshed
  2026-08-23T22:00:38Z — so the inbound route still exists on the PBX.
- Their weekend volume is genuinely low (Sat 15 Aug: 5 inbound, Sun 16 Aug: 2,
  Sat 8 Aug: 7, Sun 9 Aug: 2), so two empty low-volume days is possible.

⛔ **But it is not zero-risk and it is not something the database can settle** —
they closed Friday afternoon for Shabbos, and two consecutive empty days is
still outside their pattern. **One test call to (845) 537-8318 settles it in ten
seconds** and is worth doing before Monday.

---

## 7. Query notes

- Failures live in `VoiceDiagEvent` type `CALL_QUALITY_REPORT` with
  `payload.debugKind = "WEBRTC_INBOUND_ANSWER_FAIL"`; the fingerprint is
  `payload.incomingSessionSnapshot`.
- ⛔ **A blackbox is not the only failure shape** — also correlate every
  `ANSWER_TAPPED action=ACCEPT` against a `CALL_CONNECTED` within ~20 s. Here
  both methods agreed on the same single call, which is what makes the "1" safe
  to report.
- ⛔ Field names that cost a round trip each: `MobileDevice` has **`model`**,
  not `deviceModel`; `PbxEndpointRegistrationEvent` has **`endpoint`** and
  **`status`**, not `endpointName`/`eventType`; `PbxTenantInboundDid` keys on
  **`e164`**, not `did`/`tenantId`.
- ⛔ `require("@connect/db")` fails inside `app-api-1`; use
  `new (require("@prisma/client").PrismaClient)()` and pipe the script over
  stdin into `docker exec -i -w /app/packages/db app-api-1 node -`.
- ⛔ Wrap the whole script in try/catch — an unhandled Prisma validation error
  dumps ~12 KB of minified client source before the useful message.
