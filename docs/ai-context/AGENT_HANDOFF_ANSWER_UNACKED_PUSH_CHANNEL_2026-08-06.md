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
