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

---

## 9. ADDENDUM 2 — the reload, and why "no failures since" is NOT evidence it is fixed

Izzy: *"I told her to reload... I suspect she just updated the app from the old one to the
new one and the computer hadn't cleared it... After she reloaded again after those calls,
she told me again, 'Sometimes it works, sometimes it doesn't.'"*

### She reloaded THREE times today, not once

Full page loads on her `Loopcom/0.1.14` window (HTML 200 + fresh `/sip` + fresh
`/ws/telephony`), ET:

| ET | page |
|---|---|
| 09:00:38 | `GET /?desktop=1` + `/desktop/mini-dialer` — the **app launching** after the upgrade |
| **09:32:43** | `GET /dashboard` — **the reload Izzy asked for**, 2 min after her report |
| **10:04:26** | `GET /voicemail` — another reload |
| **10:11:04** | `GET /voicemail` — another reload |

She is already self-medicating with reloads. ⛔ Correction to Addendum 1, which called
10:04 and 10:11 "rebuilds" — they are full page loads.

### ⛔⛔ The stale-bundle theory is RULED OUT, and what the reload really does matters more

Measured against the live origin:

```
GET /dashboard        ->  cache-control: no-store, must-revalidate
GET /_next/static/chunks/*.js  ->  cache-control: public, max-age=31536000, immutable
```

**The HTML is never cached, and the chunks are content-hashed.** So a page load ALWAYS
pulls the current build, and a stale bundle can only survive inside a window that has not
been reloaded. Her app **launched fresh at 09:00:38** — a new Electron process, a new
document fetch — so **she was already running the current code when it failed at
09:20/09:24/09:26.** The portal build (`bNWpncA_gaWt0kGCmQKke`) has been deployed since
2026-08-23 20:18Z, before any of it.

⛔⛔ **So reloading does not fix stale code — it forces a brand-new SIP registration.**
That is the whole of its effect here, and it is why the fix does not hold: it is a
workaround for a connection that goes bad, not a cure. Telling her to reload will keep
working, and will keep being needed. **Do not record "the reload fixed it" as a
resolution.**

### The PBX rings her every single time — this is entirely client-side

For all **24** inbound calls to ext 101 today, the wake-dial `Dial()` string contained
**exactly 4 app contacts, every time**:

```
09:15:34 contacts_dialled=4   10:03:00 contacts_dialled=4   11:02:20 contacts_dialled=4
09:23:52 contacts_dialled=4   10:10:28 contacts_dialled=4   11:04:25 contacts_dialled=4
...                            (24 of 24, no variation)
```

⛔ **No contact eviction, no dropout, no gap in the dial list** (`max_contacts` 10 vs 4 in
use, so `remove_existing` never fires). **The phone system is not the problem and neither
is the registration count** — she is offered every call. Everything that goes wrong,
goes wrong after the INVITE reaches her window.

### Since the reload: 2 hours, clean on paper

09:32 → 11:36 ET: **~21 calls rang ext 101, the app answered 6**, her window posted
**7 `call-quality-report`s** (completed calls, inbound + outbound) and **ZERO
`webrtc-sdp-debug` failure blackboxes**. All three failures of the day were before 09:32.

### ⛔⛔ AND THAT SILENCE PROVES NOTHING — the symptom she describes emits NO telemetry

The three blackboxes came from JsSIP's **`failed`** event. The failure mode in §3 —
answer sent, ACK never arrives — **does not fire `failed`.** The session sits in
`WAITING_FOR_ACK` indefinitely and the portal never reports anything. The same is true of
the other two silent paths: `killPhantomRing` posts nothing, and `answer()`'s
`if (!sessionRef.current) return;` posts nothing.

⛔ **So "no failure blackboxes since the reload" is NOT evidence that the answer failures
stopped.** It only means no SIP session *failed outright*. Her own report —
"sometimes it works, sometimes it doesn't" — is the more reliable instrument right now,
and it says the problem is still there. **This is exactly why §6 step 2 (the permission
grant) is not optional: it is the only thing that would make the silent mode visible**,
because `call-quality-report` is posted on `ended` with an `endReason`, which WOULD
capture a ring that terminated without ever connecting.

---

## 10. THE FIX — a device reporting its own trouble no longer needs an admin permission

Izzy, 2026-08-24: *"So those errors that were lost, how can we prevent that from happening
again?"* and *"if it's granting that permission granted for everybody by default adjust in
the backend. Don't let him see it in the sidebar or anything."*

Commit `3385e70c`, `apps/api` only. Deploy state at the end of this section.

### ⛔⛔ Granting the permission was NOT the way to do it

`can_view_pbx_sbc_connectivity` is the key behind the **"SBC Connectivity" sidebar item**
(`navConfig.ts:128`, `portalPermissions.ts:41`). Granting it to everybody would have
(a) put a new nav entry in every customer's sidebar — the exact thing Izzy ruled out — and
(b) unlocked the three **admin READ** routes under the same prefix
(`/voice/diag/sessions`, `/voice/diag/sessions/:id/events`, `/voice/diag/recent-errors`),
i.e. reading other people's diagnostic sessions. A guard test records this so nobody
"simplifies" the fix into a blanket grant later.

### What shipped instead: invert the default under /voice/diag

The prefix splits perfectly by method — **all 7 POSTs are client self-reports, all 3 GETs
are admin views**:

| method | route | what it is |
|---|---|---|
| POST | `session/start`, `session/heartbeat`, `event` | this device's own session |
| POST | `call-quality-report`, `call-quality-ping`, `call-quality-ping/clear` | this device's own call |
| POST | `webrtc-sdp-debug` | this device's own failure blackbox |
| GET | `sessions`, `sessions/:id/events`, `recent-errors` | **admin, cross-user** |

`PortalApiPermissionRule.permission` now accepts `null` (= authenticated only, no
permission check — `portalApiPermissionForPath` already returned `null` for "no rule", and
the preHandler already skips the check on `null`). The rules became:

```js
{ prefix: "/voice/diag",               permission: null },
{ prefix: "/voice/diag/sessions",      permission: "can_view_pbx_sbc_connectivity" },
{ prefix: "/voice/diag/recent-errors", permission: "can_view_pbx_sbc_connectivity" },
```

⛔ **`portalApiPermissionForPath` sorts by prefix length descending and takes the LONGEST
match**, so the two named read paths override the open default. `/voice/diag/sessions`
also covers `sessions/:id/events` by prefix.

⛔⛔ **The default is OPEN and the reads are locked BY NAME — that direction is
deliberate.** An allowlist of the seven write paths would have reintroduced this exact bug
the next time somebody adds a self-report route: it would silently start 403ing and we
would lose telemetry again without noticing. Inverting it means the failure mode moves to
"a new READ route is exposed", which the guard test catches at build time instead.

### Why dropping the permission is safe — traced, not assumed

All seven writes call `getUser(req)` and scope to the token:

- `session/start` → `mobileDevice.findFirst({ id: input.deviceId, tenantId: user.tenantId, userId: user.sub })`
- `session/heartbeat`, `event` → `voiceClientSession.findFirst({ id: input.sessionId, tenantId: user.tenantId, userId: user.sub })`
- `call-quality-report` (30/h), `webrtc-sdp-debug` (60/h), `call-quality-ping` (12/min) → rate-limited per `user.sub`
- `call-quality-ping/clear` → `liveCallStore.delete(user.sub)`

**None accepts a `userId` or `tenantId` from the body**, so "authenticated" is the correct
gate and nothing new is exposed. A guard asserts that too — if one of these ever declares
`userId`/`tenantId` in its body schema it becomes a cross-tenant write, and the test fails.

### The guard: `apps/api/src/voiceDiagSelfReport.test.ts`

7 tests, picked up by the existing `src/*.test.ts` glob (no registration needed). It reads
`server.ts`, parses the rules table, mirrors the longest-prefix resolver, and asserts:
every POST under `/voice/diag` resolves to `null`; **every GET resolves to a non-null
permission**; the two read paths are pinned to `can_view_pbx_sbc_connectivity`; no write
takes identity from the body; and that the SBC nav item still exists (so the
"just grant it" shortcut stays visibly wrong).

✅ **Proven non-vacuous: 2 of 7 FAIL replayed against `HEAD`** via
`VOICE_DIAG_GUARD_SERVER=<HEAD copy of server.ts>`.

⛔⛔ **Two authoring traps hit while writing it, both already in CLAUDE.md and both hit
anyway:**
1. **A block-comment stripper over `server.ts` swallows the file.** A regex literal opens a
   fake block comment; the rules block measured **90,906 chars and contained no rules at
   all**, so every assertion passed for the wrong reason. Use a **whole-line** `//` filter.
2. **Backslash escapes do not survive this shell's heredocs** — `"
"` became a real
   newline inside a string literal and broke the file. Write test files through the editor.

### Proof

- 7/7 pass on the fixed tree; **2/7 fail against `HEAD`**
- api typecheck **76 — the exact documented baseline**, with **no error between lines
  2870-3020** (the edited region)
- permission-rule + adjacent security suites (`adminRouteTenantScope`, `internalSecret`,
  `publicReadyJwtBypass`, `nodeEnvGates`) **59/59**
- ⛔ Committed with the **private-index technique**: `server.ts` also carried another
  session's in-flight `startSmsForwardGuardrail` import + call whose `apps/api/src/sms/`
  module is still untracked. A pathspec commit would have swept in an import of a file
  that does not exist in the repo — **an api that fails to boot.** The commit tree was
  built as HEAD + only these hunks and verified `git diff HEAD --stat` = exactly 2 files.
  Afterwards the shared index read the new test as DELETED (documented trap) and was
  re-synced with `git add` on that path only.

### ✅ DEPLOYED AND PROVEN LIVE ON PRODUCTION, BOTH HALVES

api DEPLOYED and container-verified 2026-08-24: `app-api-1` `.build-commit` =
**`3385e70c`**, the three new rules grep inside the running container, the old gated rule
greps **0**, **0 restarts, 0 error-level lines**, health **200** on both hostnames.

⛔ **Proven by driving the real routes, not by the deploy's exit line.** A 60-second
HS256 token was minted inside `app-api-1` for a **synthetic** `role: "USER"` id (touches
no real account) and the routes were called on `127.0.0.1:3001`:

| call | result |
|---|---|
| `POST /voice/diag/call-quality-ping` | **200** (was 403) |
| `POST /voice/diag/call-quality-report` | **400 validation_error** — the handler RAN |
| `POST /voice/diag/session/start` | **400 validation_error** — the handler RAN |
| `GET /voice/diag/sessions` | **403 forbidden** — still locked ✓ |
| `GET /voice/diag/recent-errors` | **403 forbidden** — still locked ✓ |

⛔ **The 400s are the proof, and deliberately so** — an invalid body means the request
reached the handler's own validation, which can only happen once the permission gate is
gone, and it writes nothing. The one `liveCallStore` entry the 200 created for the
synthetic id was cleared with `call-quality-ping/clear`.

### ⏳ NOT PROVEN

The deploy verification is above. **No 403 has yet been observed turning into a 200 for a
real user** — that happens on her next call. **The acceptance check:**

```sql
select "createdAt", "type", payload->>'endReason', payload->>'qualityGrade'
from "VoiceDiagEvent"
where "tenantId" = 'cmnlgnumu0001p9g6xyl1pbdd'
  and "userId"   = 'cmnmjhr3500anp96hc00p068a'
order by "createdAt" desc limit 20;
```

Her user has **never** produced a row. Any row at all is the fix working. ⛔ And the
negative that matters: `/api/voice/diag/*` 403s from 38.105.207.69 should fall to **zero**
while the GETs stay refused for her.

## 11. ADDENDUM 3 (2026-08-27) — she filed it AGAIN (ref QP7APH), the telemetry fix WORKED, and the churn is now provably hers

**Read-only investigation — no code, no deploy, no PBX write, no data change.**
Escalation `cmtbuamwb021bo5138qpo7aph`, ref **QP7APH**, filed **2026-08-27 18:11:50Z**
(2:11 PM ET), status SENT (SMS + email dispatched 18:12:56Z). Same person, same
extension, same complaint as **Q2FJRK** three days earlier:

> "answering the phone on the computer works on and off, sometimes it does other
> times it doesn't. it's very annoying"

⛔ **The ref is the id tail with the ambiguous characters dropped** — id ends
`…8qpo7aph`, the `o` is removed, giving `QP7APH`. A `lower(id) like '%qp7aph%'`
lookup therefore returns **nothing**; search `smsBody`/`requestSummary`/`report`
instead. That cost the first query of this session.

### 11a. ✅ §10's acceptance test PASSED — her telemetry is flowing

§4 and §10 said her `/voice/diag` posts were 403'd and that her user had **never**
produced a row. **That is no longer true, and the sentence at the end of §10 should
be read as history.** After the `3385e70c` cutover she produces rows on every day
she works:

| day | SESSION_START | CALL_QUALITY_REPORT | INCOMING_INVITE | UI_SHOWN |
|---|---|---|---|---|
| 08-24 | 5 | 19 | 2 | 1 |
| 08-25 | 8 | 43 | 0 | 0 |
| 08-26 | 24 | 18 | 1 | 1 |
| 08-27 | 14 | 14 | 5 | 1 |

⛔ **But it did NOT produce a failure blackbox, and that is expected, not a
disappointment.** §9 already predicted it: the failure mode in §3 — answer sent, ACK
never arrives — does **not** fire JsSIP's `failed` event, so it emits nothing. There
are **zero** `WEBRTC_CALL_DEBUG` rows for her on 08-27. **Her telemetry can now
confirm she is present and how often her stack restarts; it still cannot see the
answer failure itself.** Do not go looking for a blackbox that the code cannot write.

### 11b. ⛔⛔ THE NEW EVIDENCE: 29 distinct SIP stacks in 33 registrations, and her phone on the same AOR used ONE

§3 measured the rebuild at "roughly every 30 minutes" off 28 events. Measured again
on 08-27, splitting the AOR by contact address:

| route | REGISTERED | distinct `x-ast-orig-host` UAs |
|---|---|---|
| `@45.14.194.179` (443 route — her Windows windows) | 33 | **29** |
| `@75.99.30.60` (direct :8089 — her Android) | 2 | **1** |

**Same AOR, same extension, same day.** A plain re-REGISTER keeps its contact URI, so
a new instance id means a **new UA** — nearly every desktop registration is a SIP
stack built from scratch and the previous one abandoned. Her phone, on the same
`T8_101_1`, re-registered normally. **That contrast is the finding**: this is not the
network and not the AOR, it is the desktop client.

Cadence on 08-27 (UNREGISTERED then REGISTERED 2-4 s later, a fresh instance id each
time): 17:06, 17:12, 17:23, 17:29, 17:46, 17:53, 18:02, 18:03, 18:03, 18:11, 18:13 —
**a rebuild every ~6-11 minutes**, tightening around the moment she gave up and filed.

### 11c. ⛔ It is HERS, not a fleet-wide deploy artifact — and that was checked, not assumed

The obvious benign explanation is that portal deploys prompt a reload and each reload
mints a UA. **Ruled out by comparing her against every other 443-route app endpoint:**

| day | fleet UAs (443 route, all `*_1` endpoints) | of which HERS |
|---|---|---|
| 08-26 | 52 | **39** |
| 08-27 | 40 | **29** |

**She is ~75% of all web SIP-stack rebuilds on the entire platform.** A deploy-driven
reload would be spread across the fleet; this is concentrated on one machine.

⛔ **And it roughly DOUBLED on 08-26**: her own baseline over the preceding week was
10-17 web registrations/day (08-19 16, 08-20 19, 08-21 10, 08-23 9, 08-24 17,
08-25 4), then **08-26 38 and 08-27 33**. Whatever changed on her machine on 08-26 is
the upstream cause and **has not been investigated**.

### 11d. The PBX rings FIVE contacts, several of them abandoned

From the wake-dial `Set(CONTACTS=…)` line at 14:08 EDT (18:08Z), ext 101's app leg
carried **five** contacts, every one on the 443 route with a **different** instance
id: `se6nfeff4gka`, `vqn6ml00qteb`, `sp8p808r5ekv`, `i3umguqqtdl1`, `he6r2i7m8hin`.
By 14:12:49 EDT `i3umguqqtdl1` had been replaced by `lrqnu5duh4di`, and by 14:13:49 by
`eo7amp93l7o6` — the list is rewritten as fast as the PBX can re-read it.

⛔ `max_contacts` is 10, so **`remove_existing` never fires** and dead contacts simply
accumulate until `qualify_frequency` (30 s) notices. **Every call is therefore fired
into a set of sockets of which only some have a live UA reading them.** That is the
mechanism behind "works on and off" in one sentence.

### 11e. The code is UNCHANGED — §3 still describes the live product

`apps/portal/hooks/useSipPhone.ts:3150` (line moved, code identical):

```js
const answer = useCallback(() => {
    if (!sessionRef.current) return;          // silent no-op
    …
      sessionRef.current?.answer({ mediaStream: localStream });
      // Do NOT set callState("connected") here — wait for JsSIP "confirmed"
```

`grep -rn "answer_unacked\|unacked\|WAITING_FOR_ACK" apps/portal` → **still zero
hits**. The only commit touching this file since 08-24 is `2ee9a614` (call-waiting
timer / DTMF sink / settings popover), which does not go near the answer path.

### 11f. What today's numbers can and cannot say

**84** wake-dial invocations offered the call to ext 101's app endpoint today; **16**
app legs answered.

⛔⛔ **The other 68 are NOT 68 failures and must never be reported as such.** Ext 101
is a queue extension (`T8_Q750`) that also rings two desk phones and shares the queue
with other agents, so a call the app did not answer was very often answered correctly
by somebody else. **And the failure itself is invisible from the server** — §9's rule
still holds: a 200 OK that never arrives leaves no trace, so **her failed answers
cannot be counted from here at all.** Her own account of the frequency is still the
best instrument we have.

### 11g. ⏳ What to do — unchanged from §6, but now with a measured case behind it

1. **Cut her to ONE window on `desktop-0.1.16`.** She still has a
   **`desktop-pre-0.1.5`** session alive (last seen 08-27 13:48Z) beside the current
   ones — a shell many releases old. Five contacts on one AOR, each rebuilding
   independently, is itself the mechanism. Zero code risk and it is the only step that
   can be taken today.
2. **Port the mobile `answer_unacked` watchdog to the portal** (`c55ae840`). This is
   the real fix and it is still **not traced** — see the warning in §6 and
   [[never-propose-a-fix-without-checking-blast-radius]].
3. **Find out why her stack rebuilds every ~6 minutes**, and what changed on 08-26 to
   double it. Nobody has looked at her machine.

⏳ **NOT PROVEN and still the honest gap: nobody has watched her press Answer.** Every
finding here is server-side. The one question that would settle branch (1) vs (2) is
still the one from §9 — when it fails, does the incoming-call screen **stay up** (the
answer went nowhere) or **disappear** (someone else got it)?
