# AGENT HANDOFF — the warm answer gets 500 ms instead of 4 s, so answering a call tears it down (2026-08-23)

**Read-only investigation. No code change, no deploy, no build, no PBX write, no
data change.** Izzy, 2026-08-23: *"Create a box extension 102 is on the latest APK.
I tried to call him. He tried to answer. I tried multiple times, and he was not
able to answer the call. Investigate what happened."*

Supersedes the recommendation in
`AGENT_HANDOFF_ANSWER_UNACKED_PUSH_CHANNEL_2026-08-06.md` §9 ("he needs to install
the current APK"). **He installed it. Installing it is what broke him.**

---

## 1. ⛔⛔ THE HEADLINE: this is a REGRESSION shipped in every Android build since 2026-08-22

`83a5728c` ("the warm answer claims in the background", the client half of the
Hanna fix) added **one line** to the warm answer path:

```js
if (inviteReady && !earlyColdAcceptSent) {
  backendClaimed = true;                      // <-- added by 83a5728c
  consumedInviteActionRef.current.add(acceptKey);
  void (async () => { ...respondInvite... })();   // background claim
}
```

`backendClaimed` is not just bookkeeping — **it is the flag that decides whether the
answer deadline is extended**, ~200 lines further down
(`apps/mobile/src/context/NotificationsContext.tsx`):

```js
let answered: boolean;
if (!backendClaimed) {
  ...
  answerDeadline.handle.extend(MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS);   // +16 s
  answered = await sip.answerIncomingInvite(..., answerDeadline.handle);
} else {
  // Cold / requeue path: ACCEPT was already awaited above; answer now.
  answered = await sip.answerIncomingInvite(..., answerDeadline.handle);  // NO extend
}
```

The `else` branch is the **cold** path, and it is correct there because the cold
path already extended the deadline earlier (three other call sites do). The warm
path never extended anything — it used to reach the `if` branch and extend there.
Now it is routed into the `else` and answers on the **pre-claim** deadline.

**Measured against the real constants** (simulation driving the actual
`createSipAnswerDeadline` from `mobileAnswerTiming.ts`):

| | deadline | first-attempt cap | attempts that fit |
|---|---|---|---|
| warm path **today** (`backendClaimed = true`) | tap + **150 ms** | **500 ms** | **1** |
| warm path **before `83a5728c`** | tap + 16,000 ms | 4,000 ms | 3 |

`MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS` is **150 ms** — deliberately tiny, because on
the cold path it is only a grace window before claiming. As an *answer* budget it
collapses `ANSWER_TIMEOUT_MS = max(500, min(4000, remaining))` to its **500 ms
floor** and reduces `MAX_ATTEMPTS = 3` to **one attempt**.

Then, on failure, the pipeline does this:

```js
if (!answered) {
  sip.rejectIncomingInvite({...});   // kills the ringing/answered PBX leg
  sip.hangup();
  endNativeCall(callId);
}
```

**So tapping Answer now reliably destroys the call ~1 second later on any link
whose SIP round trip is slower than ~500 ms.** His is: current contact RTT
**303.8 ms** (desk phone on the same tunnel: 236.0 ms), and that is before the
device's own createAnswer/setLocalDescription/ICE work, which must finish before
the 200 OK is even sent.

⛔ **The 8 s `MOBILE_SIP_ANSWER_INITIAL_WAIT_MS` passed at the call site is DEAD
and this is what makes the bug invisible on a read.** `answerIncoming()` does
`deadlineHandle ?? createSipAnswerDeadline(answerStartAt, timeoutMs)` — the handle
wins, so the 8 s argument sitting right there in the call is never used.

---

## 2. The three calls, minute by minute (all times ET; UTC = ET + 4)

Caller `5622096644` (Izzy) → DID `8457826722` → IVR → he pressed `102` → PBX rings
**both** legs: `PJSIP/T7_102` (desk) and, via `connect-mobile-wake-dial`,
`PJSIP/T7_102_1` (app). The app's contact was T-Mobile CGNAT
`sip:35914ihm@172.56.161.98:38552;transport=ws`.

| | call 1 | call 2 | call 3 |
|---|---|---|---|
| invite | `cmt68fjy6...` | `cmt68gty9...` | `cmt68hbo1...` |
| pbxCallId | 1787515249.13798 | 1787515311.13805 | 1787515332.13814 |
| app leg rang | 16:00:58 | 16:01:57 | 16:02:19 |
| he tapped Answer | 16:01:07.962 (9.8 s in) | 16:01:59.769 (96 ms) | 16:02:22.777 (61 ms) |
| app gave up | 16:01:08.610 (**641 ms**) | 16:02:00.516 (**745 ms**) | 16:02:23.475 (**694 ms**) |
| PBX app leg | `No one is available (1:0/0/0)` 16:01:08 | **ANSWERED 16:02:00.982** | `No one is available (1:0/0/0)` 16:02:23 |
| PBX DialEnd | 16:01:08.972 | 16:02:01.278 | 16:02:24.178 |
| caller ended up | **voicemail 16:01:27** | **dropped after ~1.3 s** | **voicemail 16:02:48** |

**Every blackbox has the identical fingerprint:**
`answerAttempts: 1, pollIterations: 1, sipAnswer.confirmed: false,
durationUntilFailureMs: 641 / 745 / 694`, candidate JsSIP `status: 5`
(`STATUS_ANSWERED` — the device was still building its SDP; the 200 OK had not
gone out yet).

⛔ **Call 2 is the proof that this is a budget bug and not a transport bug: the
answer WORKED.** Asterisk bridged it (`PJSIP/T7_102_1-00001b93 answered`,
`extensionAnsweredAt 20:02:00.982Z`) — but the app had already declared failure at
~500 ms and ran `rejectIncomingInvite()` + `hangup()`, so it tore down its own
live, bridged call 280 ms later. The app's `CALL_CONNECTED` arrived *after* the
call was already dead.

---

## 3. ⛔ The `answered_elsewhere` cancel push is REAL but it is NOT the cause — check the order

On call 2 the server did exactly what the Hanna incident describes: telephony
reported `answered_elsewhere` at 20:02:00.990, the API cancelled the invite and
**pushed `INVITE_CANCELED` to the very phone that had just answered**
(`FCM_DIRECT_DELIVERED ... INVITE_CANCELED ... SM-S908U`), and the app's own claim
POST came back `respond skipped because invite is no longer pending`.

**But the call was already gone before the push landed:**

```
20:02:01.263  telephony: "mobile-ring: notifying API of hangup"   <- call already dead
20:02:01.278  DialEnd on the app leg
20:02:01.344  API queues INVITE_CANCELED
20:02:01.439  FCM delivers INVITE_CANCELED                        <- 176 ms too late
```

So the server-side race is still live and still needs closing, but it did not
cause today's failure. **On calls 1 and 3 no cancel push was sent at all** — the
`INVITE_CLAIMED` fan-out logged `afterExclude: 0`, i.e. the claiming device was
correctly excluded and nothing was pushed.

⛔ **Also ruled out, with evidence — do not re-investigate these:**
- **The telephony requeue.** Every requeue on all three calls was correctly
  **skipped** (`mobile invite requeue skipped — extension leg already ringing/live`).
- **The wake-dial dialplan.** `Dial(${CONTACTS})` at
  `extensions__60_custom.conf:417` carries **no timeout**, so the 10 s / 4 s cut-off
  was not a PBX timer — it was the app hanging up. `(1:0/0/0)` reads
  `numlines:busy/congestion/nochan`, i.e. one line dialled and no failure cause:
  a normal clearing, from the far end.
- **The app version.** He is on `1.0.0+20260823-152650+1787513210` (versionCode
  1787513210, SM-S908U), which matches `apps/mobile/ship-proof.json` exactly.

---

## 4. ⛔ Why the green test suite could not see it

`apps/mobile/src/sip/answerAttemptBudget.test.ts` — written for the 2026-08-05
failure and correct in its own terms — builds every deadline from
**`MOBILE_SIP_ANSWER_INITIAL_WAIT_MS` (8 s)** and `MOBILE_SIP_ANSWER_MAX_WAIT_MS`
(30 s). One of its tests is even named *"more than one attempt fits in the
pre-claim budget"* while constructing that budget from `INITIAL_WAIT_MS`.

**`MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS` appears in no test in the repo** — and it
is the only value the warm answer path actually runs on. The suite proves the
retry budget works in a window production never uses.

**Any fix must add a test anchored on `MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS`, and a
source guard that the warm branch extends the deadline before answering.**

---

## 5. The fix (NOT applied — mobile answer-path changes need Izzy's word)

One line, in `NotificationsContext.tsx`, on the warm branch, **before**
`answerIncomingInvite`:

```js
answerDeadline.handle.extend(MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS);
```

⛔ **Do NOT "fix" it by reverting `backendClaimed = true`** — that flag is what
stops the `answered_elsewhere` sweep cancelling a call this device is on (the
Hanna fix). Keep the background claim; extend the deadline.

⛔ Per the standing repo rule, anything touching the answer path ships **alone**
with a supervised two-way call test.

---

## 6. Blast radius and what else is true

- ⛔ **All three fleet APKs published on 2026-08-23 contain this** —
  `1.0.0+20260823-113754`, `-132318` and `-152650` are all descendants of
  `83a5728c` (verified with `git merge-base --is-ancestor`). Anyone who installs
  the current Android app gets it.
- Only **2 users** have opened the newest build so far, and Sender is the only one
  who has taken an inbound call on it — **3 answer attempts, 3 failures, 0
  successes**. Platform-wide there are **no** inbound answer failures on any other
  build since Aug 22.
- ⛔ **His two most recent SUCCESSFUL answers would both fail on today's build:**
  2026-08-19 14:19:39 tap → 14:19:41.841 connected = **2,644 ms**; 2026-08-21
  22:19:44.336 → 22:19:44.972 = **636 ms**. Both are over the 500 ms this build
  allows.
- The network backdrop from the 08-17 handoff is unchanged and is what makes him
  the first to hit it: registration churns every 5–12 minutes all day
  (WS_DISCONNECTED → SIP_REGISTER), and his T-Mobile contact
  `172.56.161.98` currently reads **Unavail / RTT nan** while the office-tunnel
  contact reads **303.8 ms**. ⛔ Create A Box is still NOT on the 443 SIP route, so
  a `45.14.194.179` contact on this tenant means the office tunnel.
- ✅ **No voicemail was left** — calls 1 and 3 reached the voicemail app (16:01:27 and
  16:02:48) but **0 `Voicemail` rows exist** for this tenant after 19:30Z, so the caller
  hung up rather than recording. Nothing is waiting for him.
- ⚠️ Still open and unrelated to today: the `answered_elsewhere` → `INVITE_CANCELED`
  race in §3 is still able to cancel an invite for a call the app has answered.

---

## 7. ⏳ Acceptance test for the fix

One call to ext 102 on a build carrying the extend, answered on the app:
`CALL_CONNECTED` with no `WEBRTC_INBOUND_ANSWER_FAIL` beside it, and the PBX
showing `PJSIP/T7_102_1-... answered` with the call staying up. **The negative that
matters: the blackbox must show `answerAttempts` able to reach 2–3 and a
first-attempt cap of 4,000 ms, not 500.**

---

## 8. Query notes paid for this session

- The three blackboxes are `voiceDiagEvent` rows of type `CALL_QUALITY_REPORT`
  with `payload.debugKind = "WEBRTC_INBOUND_ANSWER_FAIL"`; the fingerprint lives in
  `payload.incomingSessionSnapshot`.
- ⛔ `Extension` orders on **`extNumber`**, not `extension`.
- ⛔ `MobileDevice.appVersion` is **null** on his live row — the app version only
  ever reaches us in a `SESSION_START` diag payload. Order his devices by
  `updatedAt` and read the newest (the stale 2026-07-06 row still says `1.0.0`).
- The PBX log is one day only. Find a call with
  `grep "CALLID=<pbxCallId>" /var/log/asterisk/full` to get its `C-xxxxxxxx`, then
  filter that id to `app_dial.c:` lines — everything else is thousands of
  `Set()`/`GotoIf` lines.
- ⛔ `grep -E "...|dialing"` on the PBX log matches `sub-local-dialing` and buries
  the answer. Filter on `app_dial\.c:` plus `Nobody picked|No one is available`.
