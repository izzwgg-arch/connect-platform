# AGENT HANDOFF — "he answered and got voicemail": the un-ACKed 200 OK, and three safeguards that were never armed (2026-08-06)

Engagement: Izzy reported that **Create A Box ext 102** (Sender Weiss) downloaded
the latest APK, took an incoming call, **answered, and the call did not connect** —
the caller landed in voicemail while the app kept ringing. His questions were
sharp and correct: *"we have safeguards for this and none of them worked"*, and
*"are the safeguards even working in the first place?"*

Commit: **`c55ae840`** on `feat/ivr-migration-takeover` (api + telephony DEPLOYED
and container-verified; worker fix `f9907e5d` deployed by a parallel session and
verified). **The mobile half is committed and on NO phone — see §8.**

---

## 1. ⛔ THE RULE FROM THIS ENGAGEMENT: read the blackbox payload, never the failure label

`failureReason: "session_not_found_timeout"` **is a lie.** In
`apps/mobile/src/sip/jssip.ts` it was chosen by

```js
const failureReason = attempt >= MAX_ATTEMPTS ? "max_attempts" : "session_not_found_timeout";
```

i.e. it is stamped on **any** failure with fewer than 3 attempts — *including one
where the session was found on the first poll and successfully answered*.

**Two consecutive wrong root causes were published to Izzy off that label** before
the raw `WEBRTC_CALL_DEBUG` payload was read. Both were wrong, both were retracted:

1. "The phone system rang an app that wasn't installed." — False. The app was
   installed, registered, and returned a real 180 Ringing.
2. "The app searched 16 seconds and found nothing." — False. It found the call
   immediately and answered it.

The payload said the opposite in fields that were there the whole time:

```json
"incomingSessionSnapshot": {
  "incomingSessionCount": 1, "answerableSessionCount": 1,
  "pollIterations": 1, "answerAttempts": 1,
  "candidates": [{ "status": 6, "hasAnswer": true, "from": "3475810799" }],
  "uaConnected": true, "uaRegistered": true, "sipStackHealthy": true
},
"sipAnswer": { "sent": true, "attempted": true, "confirmed": false },
"durationUntilFailureMs": 16145
```

**JsSIP `_status: 6` = `STATUS_WAITING_FOR_ACK`.** The app built and sent its
200 OK and waited for an ACK that never came.

## 2. What actually happened (pbxCallId `1785949038.169956`, 2026-08-05 12:57 ET)

| time (ET) | event |
|---|---|
| 12:57:20.7 | `T7_102_1` registers as `sip:6qhvvpq9@…:33030;transport=ws` |
| 12:57:26 | PBX dials it → **`PJSIP/T7_102_1-00011c59 is ringing`** (real 180 — the socket was alive) |
| 12:57:27.1 | native `RINGTONE_START` (from the push) |
| 12:57:33.9 | `RINGTONE_STOP reason=intent_answer:onCreate` ← **he tapped Answer** |
| 12:57:34.3 | `ANSWER_TAPPED` → found on poll #1 → **200 OK sent ~160 ms later** |
| 12:57:41 | PBX: **"Nobody picked up in 15000 ms"** → `VoiceMail(102@…)`; invite CANCELED |
| 12:57:50.4 | app gives up after **16.1 s** |
| 12:57:53.8 | Asterisk qualify finally marks the contact **UNREACHABLE** (27 s late) |

**The socket died between the ring and the answer while every health flag still
read healthy.** This IS the Simon/Luxure stranded-socket family (T-Mobile CGNAT);
an earlier claim in this session that it was *not* the same as Simon was wrong.

⛔ **Nothing watches for an un-ACKed 200 OK.** All four existing safeguards check
*before* or *around* the ring; none watches the pickup.

## 3. ⛔ The retry budget was fiction

`answerIncoming()` declares `MAX_ATTEMPTS = 3`, but the per-attempt timer was

```js
const ANSWER_TIMEOUT_MS = Math.max(500, getUntil() - Date.now());  // the WHOLE deadline
```

Attempt #1 swallowed all 16 s, so attempts #2/#3 were unreachable. Meanwhile the
PBX ring timer expired at 15 s. **Fixed** via
`MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS = 4_000`, an early `break` on the unacked
case, an honest new verdict `answer_unacked`, and a rescue that re-offers the
call over a fresh leg (`ANSWER_UNACKED_REQUEUE`) while the PBX is still ringing.

⛔ **Do NOT "fix" the budget by shrinking the cap so 3 attempts fit the initial
8 s window.** Only 2 fit, and that is asserted deliberately — a smaller cap cuts
SIP's 200 OK retransmission ladder (500 ms / 1 s / 2 s) short and abandons
merely-slow transports. The 3rd attempt becomes reachable once the deadline
extends after a backend claim.

⛔ **Do NOT add a socket rebuild between attempts.** `registerInner()`
deliberately suppresses force-restart inside `inInviteAnswerWindow()` — tearing
the UA down mid-ring rejects the pending INVITE. The rescue reuses the existing,
proven backend requeue instead.

## 4. ⛔ Config, not code: three safeguards that existed and had never run

| Safeguard | State found | Fix |
|---|---|---|
| On-ring contact-liveness probe | `PBX_CONTACT_QUALIFY_ON_RING` **set nowhere in production** — written in July, default-off, **never once enabled** | now `:-1` in compose; verified `qualify-on-ring: 1` in the running container |
| Worker direct-FCM sender | Code shipped 2026-07-31; container had **no credential mount and empty `FCM_SERVICE_ACCOUNT_PATH`** → `isFcmDirectConfigured()` false on every push, 6 days of 100% Expo fallback | mount + env (`f9907e5d`); verified **7 `FCM_DIRECT_DELIVERED`, 0 failures** |
| SIP→UI cancel bridge | Guarded by `if (!hadLiveInboundSipRef.current) return;` — arms only *after* a SIP INVITE surfaces in JS, so it is structurally disabled in exactly this failure | unchanged (correct as written); the rescue in §3 covers the gap |

**Lesson: `isFcmDirectConfigured()` fails closed and logs nothing per push.** A
boot assertion now logs `FCM_DIRECT_ARMED` / `FCM_DIRECT_UNCONFIGURED`
(console.error). ⛔ **Never claim a push channel is live from code alone** —
verify `FCM_DIRECT_DELIVERED` with `"source":"worker"` in the running container.

## 5. ⛔ The fast token was hostage to the slow one

The native FCM token can ONLY reach the server inside
`POST /mobile/devices/register` — and that route **required** `expoPushToken`
(`z.string().min(8)`), with `MobileDevice.expoPushToken` a NOT NULL unique column
the upsert keyed on. `getExpoToken()` has an explicit
`"Expo token failed (raw FCM available)"` branch, so **a handset holding a
perfectly good FCM token could not report it** and stayed on the deprioritized
relay forever. **8 of 16 active Android devices.**

Fixed: `expoPushToken` is nullable (Postgres keeps NULLs distinct, so real tokens
stay unique), tokenless rows key on the new `@@unique([userId, deviceId])`
(migration `20260806020000_mobile_device_optional_expo_token`), and the app now
registers on both call sites even when Expo fails. Verified safe against
production first: **94 rows, 0 duplicate (userId, deviceId) pairs, 1 null deviceId.**

## 6. ⛔ The 20 s wake hold could never finish — follow-me clips it to 15 s

The caller-side `Dial(...)` timeout comes from the extension's **follow-me** ring
time, not its `ringtimer`:

```
/<hash>/extensions/102/ringtimer          : 30      ← NOT used on this path
/<hash>/extensions/102/followme/ringtime  : 15      ← this one
```

**115 of 122 extensions fleet-wide are at 15** (VitalPBX default). So VitalPBX
sent callers to voicemail 5 s before the wake engine gave up. Fixed inside wake
enrollment via the sanctioned in-lane `ami.dbPut` (no ssh, no panel edit).

⛔ **It MUST run on the `!transformed.changed` path too** — every already-enrolled
extension hits that early return each 5-min cycle. Live proof: all 10 repairs
logged `dialChanged:false`. Had it only run on the "changed" branch, **none** of
the 12 live extensions would have been fixed.

Safety rules (all in the pure, testable `decideFollowMeRingTime()`): **raise only**,
never on un-enroll, never invent a value where none exists, and **leave `0` alone**
(VitalPBX's "no timeout" sentinel — raising it would impose one). Live outcome:
**10 raised 15→30, 2 left at 0** — exactly right.

⛔ Lowering `mobile_reach_wait_secs` is NOT the fix and makes things worse: if the
phone is not up, giving up sooner just reaches voicemail sooner.

⛔ **Parsing trap:** `asterisk -rx "database show"` pads the key column, so the
value's awk field index shifts with key length. `awk '{print $3}'` silently
reported "121 entries have no value". Split on the last `:`.

## 7. ⛔ Shared working tree: another session committed my work mid-task

`apps/api/src/server.ts` (my tokenless-register branch) was swept into another
session's **IVR** commit `6a30c9d4`, leaving HEAD referencing `userId_deviceId`
**without** the schema/migration that defines it — a broken HEAD. `c55ae840`
closes that gap.

Also confirmed: two fixes reported to Izzy as "done this session" (`8c15d5fa`
answer-retry, `f9907e5d` worker FCM) **already existed in the repo** before the
session started. They were simply **never deployed**. Verify with
`git log -S "<marker>" --all` before claiming authorship of anything in a shared
tree — and always check `git diff --cached --name-only` after `git add`, because
files can silently vanish from your staging area.

## 8. ⏳ State at handoff — what is live and what is NOT

**LIVE and container-verified:** worker direct-FCM (7 deliveries / 0 failures),
telephony `qualify-on-ring: 1`, ring times repaired on 10 extensions (PBX ground
truth), migration applied (`MobileDevice_userId_deviceId_key` present,
`expoPushToken` nullable), register route accepting tokenless devices.
api at `c55ae840` (since superseded by `183f14e4`, which contains it).

⛔ **NOT LIVE — the three MOBILE fixes are on NO phone**: the bounded answer
retry, the unacked-answer rescue, and the ability to *send* the fast token all
live in the app. **No build was made.** The fleet is unchanged at **8 fast /
8 slow**, and Sender's phone still has neither. Per the standing repo rule,
anything touching the answer path ships **alone** with a supervised two-way call
test — that needs Izzy.

**Tests: 126 green** (shared 23, mobile 22, telephony 59, worker 4, api 18). Three
failed first and were real: the compose-wiring guard failed against the actual
broken config; the retry-budget test proved only 2 attempts fit (asserted the
truth rather than shrinking the cap); the ring-time guard caught a parsing bug in
the test itself.

**Re-verify commands:**
```bash
docker exec app-worker-1 sh -c 'echo $FCM_SERVICE_ACCOUNT_PATH'
docker logs --since 30m app-worker-1 | grep -c FCM_DIRECT_DELIVERED
docker exec app-telephony-1 sh -c 'echo $PBX_CONTACT_QUALIFY_ON_RING'
docker logs --since 25m app-telephony-1 | grep '"changed":true,"from":15,"to":30'
# PBX (read-only):
asterisk -rx "database get <hash>/extensions/<ext>/followme ringtime"
```

---

## 9. ⛔ RECHECK 2026-08-17 — IT HAPPENED AGAIN, and the reason is that he is 8 days behind on the app

**Read-only investigation. No code change, no deploy, no PBX write, no data change.**
Izzy asked: is Create A Box ext 102 using the mobile app today, and is it working
well for him? Answer: **yes he is using it, and no it is not working well.** The
un-ACKed-answer failure described in §2 recurred **today at 16:47 ET**, on a real
customer call, and the caller went to voicemail.

### 9a. ⛔⛔ THE HEADLINE: the fix for this exact failure IS published and he does NOT have it

| | |
|---|---|
| His installed build | **`1.0.0+20260804-202642`** (from diag `SESSION_START`, 3× today) |
| Currently published | **`1.0.0+20260812-215020`** (published 2026-08-13, `/opt/connectcomms/downloads/`) |
| That build's own release note | *"**Answering a call retries instead of dying silently**, phones can report their fast push token even when the slow one fails…"* |

That release note **is** the §3 fix (bounded answer attempts + the `answer_unacked`
rescue, `c55ae840`). §8 of this handoff said those mobile fixes were "on NO phone" —
they shipped on 2026-08-13 and **his phone was never updated**. So the failure below
is not a new defect and needs no new engineering: **he needs to install the current
APK.** ⛔ Do not open a fresh investigation into the answer path for this extension
until he is on `20260812-215020` or later.

✅ What DID stick from the Aug 5/6 work: a new `MobileDevice` row
(`cmsgbqocr0hbrtd136dxshbsf`, created 2026-08-05 16:51Z) carries **`nativeFcmToken`
set** — he is on the fast direct-FCM push channel now, not the Expo relay. The four
older rows are stale (`appVersion "1.0.0"`, no FCM); ⛔ **query his devices ordered by
`updatedAt` and read the newest — reading the old `cmr9epohm0db5pe13ib1hmur5` row
still shows `hasFcm: false` and reproduces the old, now-wrong conclusion.**

### 9b. What today actually looked like (all times ET)

Five inbound calls reached ext 102. Ground truth is the PBX `app_dial.c … answered`
line, never the CDR — ⛔ **the CDR marks the 16:47 call `disposition: answered,
talk=63s`, which is the IVR + voicemail answering, not a human.**

| time | what happened | who answered |
|---|---|---|
| 11:41 | **app answered** — 74 s call | `PJSIP/T7_102_1` (APP) ✅ but **quality `poor`: 8.34 % packet loss, 186 lost** |
| 11:46 | rang, nobody got it → **voicemail** | none ❌ — the app was **offline 11:43:40→11:47:44**, the call landed in the hole |
| 15:10 | answered | `PJSIP/T7_102` (DESK) |
| 15:37 | answered | `PJSIP/T7_102` (DESK) |
| 16:47 | **the §2 failure, again** → **voicemail** | none ❌ (detail below) |

All **8 outbound** calls today came off the **desk phone**, not the app.

**The 16:47 failure, minute by minute** (caller `8456627956`, `C-0000ae33`):

```
16:47:32  PBX dials both legs; PJSIP/T7_102-000184ff and PJSIP/T7_102_1-00018500 both ringing
16:47:48  app callStart — HE TAPPED ANSWER (voiceDiag CALL_QUALITY_REPORT timeline)
16:47:56  Asterisk: "Endpoint T7_102_1 is now Unreachable"
16:47:58  app callEnd, endReason "user_hangup", packetsReceived: 0, primaryCause "one_way_audio"
16:48:02  PBX: "Nobody picked up in 30000 ms" -> CALL_STATUS=NOANSWER -> VoiceMail(102@create_a_box-voicemail)
16:48:11  "Recording the message"
16:48:24  contact 'sip:sd2hlkoq@...:36398' removed from AOR T7_102_1 due to shutdown
```

**He answered, heard nothing for ten seconds, and hung up — while Asterisk never saw
the answer at all and sent the caller to voicemail.** Identical shape to 2026-08-05.
⛔ The voicemail it produced (`8456627956`, 6 s, 2026-08-17 16:48:11) was still
**UNHEARD** at the time of writing, as were two more on ext 102 from 08-16.

### 9c. The backdrop: the app has no stable network, on either side

- **The app endpoint had no live contact for 93 minutes today — 8.9 % of the day**,
  across **27 gaps of ≥30 s** (many 3–6 min) plus 25 sub-30 s blips. 137 REGISTERED /
  118 UNREGISTERED events in one day. A call arriving in any ≥30 s gap cannot ring the
  app at all — that is exactly the 11:46 loss.
- ⛔ **He roamed across 14 distinct source IPs today.** T-Mobile CGNAT
  (`172.56.x`/`172.59.x`, the majority), two fixed lines (`96.56.30.234`,
  `69.123.169.102`), and **`45.14.194.179` = loopcom, i.e. the office Wi-Fi going out
  through the GL.iNet box → WireGuard → loopcom (France) → PBX (St. Louis)**.
- **Both networks hurt him today, differently:** the 11:41 poor-audio call was on
  **T-Mobile** (`172.59.212.134`, 8.34 % loss); the 16:47 dead-answer call was on the
  **office tunnel** (`45.14.194.179`, zero packets received, contact dropped mid-answer).
- ⛔ **Create A Box is NOT on the 443 SIP route** (`webrtcRouteViaSbc: false`,
  `sipWsUrl: wss://m.connectcomunications.com:8089/ws`). A `45.14.194.179` contact on
  this tenant therefore means **the office tunnel**, not the 443 route — do not read it
  the way you would for Gesheft/Displaydex/inii mini/B Visible/Loopcom Demo.
- Current contact RTT: app **305 ms**, desk **237 ms** (both via the tunnel) — that is
  the France detour, and it is the tenant's normal, not a fault.

### 9d. What to do (none of it is code)

1. **Get him onto `1.0.0+20260812-215020`** from
   `https://app.connectcomunications.com/api/downloads/connectcomms-latest.apk`.
   This is the whole recommendation — the answer-retry/rescue fix is in it.
2. Tell him the three unheard voicemails are waiting (one from today 16:48).
3. The registration churn and the office tunnel are **unfixed and not fixable in the
   app**. The long-term cure is still the one in the 2026-08-05 handoff §5: **real
   wired internet at that office**. Until then, expect the desk phone to be the
   reliable device and the app to be best-effort.
4. ⛔ Do **not** move this tenant to the 443 route as a reflex — it would route his
   SIP through France on purpose, and his RTT is already 305 ms through the tunnel.
   That is Izzy's call, on evidence, not a default.

### 9e. Query notes paid for this session

- `ConnectCdr` has **`durationSec`/`talkSec`**, not `durationSeconds`/`talkSeconds`.
- `Voicemail` has **`callerNumber`/`durationSec`/`listened`**, not
  `callerId`/`durationSeconds`/`readAt`.
- Ext attribution on a CDR is only via `channelsSeen`; `PJSIP/T7_102_1-…` = app leg,
  `PJSIP/T7_102-…` = desk leg. ⛔ **An inbound CDR shows BOTH legs because the PBX
  rings both — its presence proves the app was *rung*, never that it *answered*.**

---

## 10. ⛔⛔ SUPERSEDED 2026-08-23 — he took the advice in §9d, and that is what broke him

§9d said the whole recommendation was *"get him onto `1.0.0+20260812-215020`"*.
He updated (to `1.0.0+20260823-152650`, at 19:59Z on 2026-08-23) and the very next
three calls **all failed at the answer**. It is a different defect and a genuine
regression: `83a5728c` set `backendClaimed = true` on the warm answer path, which is
also the flag that gates the deadline extension, so the warm answer now runs on the
**150 ms pre-claim deadline** — a **500 ms** one-attempt budget instead of 4 s × 3 —
and then hangs the call up when it expires.

**Read `AGENT_HANDOFF_WARM_ANSWER_DEADLINE_2026-08-23.md`.** It is in every Android
build published since 2026-08-22 22:18.

⛔ The `answer_unacked` machinery from §3 is fine and is not implicated — it never
gets a chance to run, because the 500 ms cap expires before the session reaches
WAITING_FOR_ACK (the blackboxes show JsSIP `status: 5`, not 6).
