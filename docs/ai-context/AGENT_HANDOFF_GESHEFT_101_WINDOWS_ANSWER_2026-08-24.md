# AGENT HANDOFF — Gesheft ext 101: "she hits Answer on the Windows app and it doesn't answer" (2026-08-24)

**Read-only investigation — no code change, no deploy, no PBX write, no data change.**
Izzy, 2026-08-24: *"gesheft 101 — 1 of the devices [has] multiple contacts, but one of
the devices there keeps complaining. Windows app: most of the time, when she hits answer
on an incoming call, it doesn't answer."*

Tenant `cmnlgnumu0001p9g6xyl1pbdd` (Gesheft) = PBX tenant **8**. Extension **101
"Phone Orders"**, owner `yisraelweinstock@gmail.com` (`cmnmjhr3500anp96hc00p068a`,
role `USER`, JWT name "Orders"). Office IP **38.105.207.69**.

---

## 1. What ext 101 actually is

⛔ **Ext 101 rings SIX devices on every call**, read live from the PBX:

```
Aor: T8_101_1  (softphone/WebRTC, max_contacts 10)  — 4 contacts, all Avail, RTT ~200-225 ms
  sip:pdgu5m12@45.14.194.179:51522;transport=ws
  sip:vk6pu8qe@45.14.194.179:42692;transport=ws
  sip:56kd6o18@45.14.194.179:29274;transport=ws
  sip:mretfpde@45.14.194.179:42668;transport=ws
Aor: T8_101    (desk phones, max_contacts 5)        — 2 contacts, Avail, RTT ~29-37 ms
  sip:T8_101@75.99.30.60:33781    (site A)
  sip:T8_101@38.105.207.69:33149  (site B — the office in question)
```

⛔ **All four softphone contacts are the SAME LOGIN.** Three distinct JWTs were pulled
from that office's nginx traffic and all three decode to the same `sub`
(`cmnmjhr3500anp96hc00p068a`, `yisraelweinstock@gmail.com`), differing only in `iat`:

| `iat` | signed in |
|---|---|
| 1784237167 | **2026-07-16** |
| 1784296970 | **2026-07-17** |
| 1786548086 | **2026-08-12** |

Portal tokens never expire, so sign-ins from five weeks ago are still live windows.

⛔ **The office runs three different desktop shells at once.** `/sip` WebSocket
upgrades today from 38.105.207.69, by User-Agent:

| shell | `/sip` upgrades today | total requests today |
|---|---|---|
| `Loopcom/0.1.14` (current) | 3 | 2,625 |
| `@connect/desktop/0.1.6` | 3 | **96,710** |
| `@connect/desktop/0.1.3` | 1 | **21,309** |

0.1.3 and 0.1.6 are pre-rename "Connect" builds. The two old shells carry ~98% of the
office's traffic, and their `/sip` sockets connected at **00:05:33** and stayed up.

## 2. Two theories I formed and DISPROVED — do not re-derive them

⛔ **(a) "Her app only rings for 2 seconds."** I measured per-channel first-to-last
mention of `PJSIP/T8_101_1-*` in the Asterisk log and got *94% of legs ring under 2 s*.
**That number is an artifact of log verbosity, not a ring duration** — at the default
verbosity a ringing leg is mentioned exactly twice (`connected line has changed`,
`is ringing`) and its teardown is never logged against the channel name. **Never
measure a ring window that way.**

⛔ **(b) "She loses the ringall race."** The authoritative source is
`asterisk.queues_log` (root SELECT on the PBX), queue `T8_Q750`, last 7 days:

| agent | RINGNOANSWER | CONNECT (answered) | avg ring ms |
|---|---|---|---|
| 117 | 520 | 0 | 337 |
| 118 | 520 | 0 | 335 |
| 108 | 518 | 0 | 602 |
| 102 | 91 | 204 | 18,253 |
| 115 | 69 | 2 | 29,072 |
| 116 | 68 | 22 | 30,000 |
| **101** | **68** | **208** | **30,000** |
| 111 | 68 | 2 | 29,471 |

**Ext 101 is the single biggest answerer in the queue (208/week) and rings the FULL
30 seconds when it doesn't answer.** It is not starved and it is not being cut off.
(Agents 108/117/118 ring ~300-600 ms and never answer — dead members, already recorded
in CLAUDE.md.) Today desk answered 27, app answered 3, at comparable time-to-answer
(desk 6 s; app 4/7/7 s) — so the desk phones are not beating her to the button either.

## 3. ⛔⛔ THE MECHANISM: the softphone rebuilds its SIP stack every ~30 minutes, and the portal has NO protection for an answer that is never acknowledged

`PbxEndpointRegistrationEvent` for `T8_101_1`, last 24 h — 28 events
(13 UNREGISTERED / 14 REGISTERED / 1 UNREACHABLE). The tail:

```
13:00:09 UNREGISTERED sip:1ptf26sq@...:42682   13:00:47 REGISTERED sip:ef525g8i@...:22108
13:32:43 UNREGISTERED sip:stc65ua3@...:33722   13:32:46 REGISTERED sip:thuhlfk9@...:40414
14:04:26 UNREGISTERED sip:thuhlfk9@...:40414   14:04:30 REGISTERED sip:p7eh24et@...:30700
14:06:43 UNREGISTERED sip:ef525g8i@...:22108   14:06:49 REGISTERED sip:pdgu5m12@...:51522
14:11:05 UNREGISTERED sip:p7eh24et@...:30700   14:11:08 REGISTERED sip:56kd6o18@...:29274
2026-08-23T21:48:31 UNREACHABLE  sip:vk6pu8qe@...:31626   <- died without unregistering
```

⛔ **The SIP username changes on every single one** (`ef525g8i` to `pdgu5m12`). A plain
re-REGISTER keeps its contact URI; a new random contact user means JsSIP built a **new
UA** — i.e. the portal is tearing down and recreating the whole SIP stack, roughly every
30 minutes per window. Between the two events there is a 3-40 s hole with no contact,
and Asterisk keeps the **old** contact for up to `qualify_frequency 30` seconds after it
is already dead.

⛔ **This churn is NORMAL, not a bad network.** Fleet-wide over the same 24 h: 4,974
registration events across 53 endpoints, mean **93.8/endpoint**. `T8_101_1` sits **14th
with 28** — well below average, and far below the known-bad `T7_102_1` (Create A Box,
T-Mobile) and `T5_101_1` (Luxure, filtered internet).

**And here is what turns a transient hole into a dead button:**

`apps/portal/hooks/useSipPhone.ts:3061`

```js
const answer = useCallback(() => {
  if (!sessionRef.current) return;            // SILENT no-op
  stopAllAudio();
  navigator.mediaDevices.getUserMedia({...})
    .then((localStream) => {
      sessionRef.current?.answer({ mediaStream: localStream });
      // Do NOT set callState("connected") here — wait for JsSIP "confirmed"
      // event (fired when ACK arrives) ...
    })
```

⛔⛔ **There is no timeout on that wait, no retry, no error and no message.** If the
200 OK rides a socket the rebuild has just replaced — or a stranded one (the
`UNREACHABLE` above) — the ACK never comes, `confirmed` never fires, and **the screen
just sits there showing an incoming call that will not connect.** That is a verbatim
match for the complaint.

⛔ **The mobile app was given exactly this protection and the portal never was.**
`c55ae840` (2026-08-06, the Create A Box ext 102 engagement) added the
`answer_unacked` verdict, a bounded 4 s per-attempt cap and an `ANSWER_UNACKED_REQUEUE`
rescue to `apps/mobile/src/sip/jssip.ts`. Grep the portal for `answer_unacked` /
`unacked` / `WAITING_FOR_ACK`: **zero hits.** The Windows app has none of it.

⛔ **Second, independent dead-button path:** the ring UI renders on
`phone.callState === "ringing"` (React state — `FloatingDialer.tsx:611`,
`DesktopMiniDialer.tsx:1155`) while `answer()` gates on `sessionRef.current` (a ref).
The three phantom-ring guards (`killPhantomRing`, ~line 3421) null the ref; in the
desktop **proxy** windows `answer` is just `send("answer")` over IPC (line 3900) against
a mirrored `callState`. Any window where the mirrored state and the engine's ref
disagree shows an Answer button that does **nothing at all, with no feedback**.

## 4. ⛔ Her softphone's own telemetry is being thrown away — which is why none of this is provable from the server side

`PORTAL_API_PERMISSION_RULES` (`server.ts` ~2888) carries:

```js
{ prefix: "/voice/diag", permission: "can_view_pbx_sbc_connectivity" },
```

This user does not hold it, so **every self-report her softphone posts is refused 403**:
today from that office, `/api/voice/diag/call-quality-ping` 23, `session/start` 8,
`call-quality-report` 4, `call-quality-ping/clear` 4, `webrtc-sdp-debug` 3 — **42 of the
73 `/voice/diag` 403s on the whole platform today came from this one office**, the
largest single source. (Fleet-wide the endpoint is mostly fine: 600 × 200 vs 73 × 403.)

⛔ **The consequence:** the last `CALL_QUALITY_REPORT` in `VoiceDiagEvent` for Gesheft
is **2026-08-21T17:14Z**, and every WEB row for the tenant belongs to a *different*
user (`ap@gesheftkosher.com`, ext 114). **There is no server-side record of a single
one of her calls.** The PBX cannot help either — a 200 OK that never arrives leaves no
trace — so the failure is invisible from both ends by construction.

⛔ **The design point worth carrying:** `/voice/diag/*` is a client **self-report**,
gated on a **viewing** permission. Gating a device's own telemetry on an admin
diagnostics permission means the users most likely to have problems are exactly the
ones we cannot see.

## 5. Noticed in passing, NOT acted on

- **120,642 requests from 38.105.207.69 today**, incl. `/api/chat/threads` 25,633,
  one thread's `/messages` 25,221, `/api/voice/voicemail` 13,735, `/api/sms/messages`
  10,785, `/api/calls/history` 8,820. ⛔ This is the same IP auto-banned in the
  2026-08-17 voicemail-preload flood; it is under the >1200/5 min ban threshold today
  (~660/5 min) but it is the same shape, and it is coming from the two stale shells.
- **`/api/crm/notifications` 403 × 2,941** — a poller running all day against an
  endpoint this user has no permission for. Also `/api/desk-phones/pending` 403 × 161.
- **36 × 502** from that office today.

## 6. What to do — cheapest first

1. ✅ **Get her down to ONE softphone window, on 0.1.14.** Close/uninstall the 0.1.3 and
   0.1.6 shells and sign out the stale July sessions. Zero code risk. Four windows on
   one SIP account means four independent UA rebuild cycles minting and abandoning
   contacts on the same AOR — every extra window widens the hole an answer can fall
   into, and three of the four are shells from July. **Do this before anything else and
   see whether the complaint survives it.**
2. ✅ **Grant her `can_view_pbx_sbc_connectivity`** so `/voice/diag` stops 403ing.
   Low risk (diagnostics only) and it is the only way to *prove* §3 rather than infer
   it — the next failed answer would then land as a real `CALL_QUALITY_REPORT`.
3. ⏳ **The actual fix: port the mobile `answer_unacked` watchdog to the portal.**
   Arm a timer when `session.answer()` is called; if `confirmed` has not fired within a
   few seconds, say so on screen and re-offer rather than sitting silent. ⛔ **NOT
   built and NOT traced here** — `c55ae840`'s own notes warn that the cap interacts with
   SIP's 200 OK retransmit ladder and that a socket rebuild between attempts rejects the
   pending INVITE. Trace every caller before touching it.
4. ⏳ Also unfixed: `answer()`'s silent `if (!sessionRef.current) return;` should tell
   the user something rather than nothing.

## 7. ⏳ NOT PROVEN

**No specific failed answer of hers is recorded anywhere** — see §4; her telemetry is
403'd and the PBX cannot see an unsent 200 OK. §3 is a mechanism established from the
registration data, the portal source and the absent-by-grep mobile fix, **not** from a
captured failure. **The acceptance test is step 2 above plus one real failed answer**;
alternatively `pjsip set logger on` at the PBX during a test call would show whether her
200 OK ever arrives — that is a PBX-side diagnostic toggle and needs Izzy's word.

---

## 8. ADDENDUM — she filed a support report, and it moves several of the findings above

Izzy, later 2026-08-24: *"one of the users in that office upgraded today to the new app
and sent me a technical support report through the agent this morning. That same user
complains."*

**The report is `AgentEscalation` `cmt79xh45640lrz13zq2fjlrk`, ref `Q2FJRK`**, created
**2026-08-24T13:30:39Z = 09:30 ET**, status SENT (SMS + email both went out). Same user
(`yisraelweinstock@gmail.com`, "Orders", ext 101). Callback **+1 845-248-6206**. Her own
words:

> **"I cant answer from the computer anymore, it used to work"**

⛔⛔ **SHE WAS ALREADY ON THE NEW APP WHEN SHE FILED IT.** The
`POST /api/support/report` is stamped `Loopcom/0.1.14`. So **"upgrade the app" is not the
fix** — §6 step 1 is about cutting the *number of windows*, not the shell version, and
that distinction now matters. The desktop shell loads the hosted portal, so 0.1.3 and
0.1.14 run the *same* SIP code; upgrading was never going to change the answer path.

⛔ **Correction to §7:** it is no longer true that nothing of hers is recorded. **Three
failure blackboxes were generated this morning and all three were destroyed by the 403.**
`postWebrtcBlackbox` is bound inside the SHARED `bindSession`, so despite the
misleading name `buildOutboundFailurePayload` it fires on **inbound** sessions too.

### The morning, minute by minute (nginx is CEST, pinned against the escalation row; PBX log is ET)

| time (ET) | event |
|---|---|
| 09:00:56 | `session/start` from **0.1.14** — her upgraded window's first SIP session |
| 09:15:34 | inbound call rings her app — nothing answers |
| 09:19:30 / 09:19:56 / 09:20:53 / 09:22:12 | **four SIP re-authentications in under 3 minutes** on `T8_101_1` (baseline is ~1 per 30 min) |
| 09:19:57 | she dials **her own mobile 845-248-6206** from the softphone — recording stamped `091957-OUT-NONE-101-8452486206`, dead in 5 s |
| **09:20:02** | **failure blackbox → 403, payload discarded** |
| 09:23:53 | inbound queue call rings all 4 app contacts + both desk phones |
| **09:24:09** | **failure blackbox → 403** (17 s into that ring; **nothing ever answered that call**, so this one is NOT a lost race) |
| 09:25:53 | inbound call rings her app |
| 09:25:59 | a **desk phone** answers it (6 s in) |
| **09:26:05** | **failure blackbox → 403** (6 s after the desk took it — this one *is* consistent with a lost race) |
| **09:30:39** | she files ref `Q2FJRK` |
| 09:32:44 | her app starts a **fresh SIP session** |
| 09:37:44 | an app leg **answers** — first success of the day |
| 09:37 / 09:44 / 09:57 / 10:03 / 10:55 | five calls connect and complete normally on her window |

⛔ **What this establishes, and what it does not.** It establishes that her softphone was
genuinely failing calls **in both directions** in a ~6-minute window while its
registration churned four times, that it reported each failure and we threw every report
away, that she gave up and complained, and that it **recovered by itself after a fresh
registration at 09:32**. It does **not** establish the cause of any individual failure —
the `cause` / `sipCode` fields were inside the 403'd payloads.

⛔ **So the complaint is not purely about answering.** Outbound died too. The common
factor is the SIP connection, and the portal's total silence — no timeout, no error, no
message (§3) — is what makes every variety of it feel like "answer doesn't work".

⛔ **This promotes §6 step 2 from useful to the single most valuable action.** Three
usable failure reports were generated and destroyed in ten minutes this morning; the
permission grant is the difference between guessing and knowing. Do it before the next
complaint, not after.
