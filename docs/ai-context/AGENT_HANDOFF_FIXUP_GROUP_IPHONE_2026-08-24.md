# AGENT HANDOFF — Fixup Group's iPhone was never in the ring list: the wake hold is per-EXTENSION but sleeping is per-DEVICE (2026-08-24)

**Read-only investigation. No code change, no deploy, no build, no PBX write, no
data change.** Izzy, 2026-08-24: *"Fix Up Group 101 is complaining that he had
problems today with the iPhone app… check all of his calls today on the iPhone
app."*

Tenant **Fixup Group** `cmqr9cs9402qqs013m7p64lpi` (PBX **T31**), user
`fixupusa1@gmail.com` `cmqs0t62s0kz9mk133y509003`, DID **(845) 806-7040**.

---

## 0. ⛔ First correction: the extension is **103**, not 101

Fixup Group has exactly **one** extension, **103 "Office"**, in Connect *and* on
the PBX (`ombu_extensions where tenant_id=31` returns one row, devices 224/226 =
`103` desk + `103_1` app). There is no 101 on T31.

⛔ Two other things carry the name and are **not** this customer — do not chase
them: **Secro Selutions ext 103 is named "Fix Up Group"** (a virtual forward,
INACTIVE in Connect — the orphaned `mobile_client` row from
`AGENT_HANDOFF_EXTENSION_DELETE_MOBILE_FLAG_2026-08-13.md`), and **T34_101 is
RSBK "Appointments"**, which CLAUDE.md already warns is not Fixup Group.

---

## 1. ⛔⛔ THE HEADLINE: on 6 of the 7 calls that rang him today, the PBX never
## dialled the iPhone at all

Every inbound call to ext 103 today, with the app contacts Asterisk actually
rang (`connect-mobile-wake-dial:18 Set(CONTACTS=…)`) and the outcome read from
the PBX log, not the CDR:

| ET | app contacts the PBX rang | iPhone in the list? | Outcome (PBX truth) |
|---|---|---|---|
| 08:08:15 | desktop | ❌ | `Nobody picked up in 30000 ms` → voicemail |
| 11:46:39 | desktop | ❌ | **desk phone** answered (+3 s) |
| 16:55:13 | desktop + Android | ❌ | **desk phone** answered (+8 s) |
| 18:08:42 | desktop + Android | ❌ | `Nobody picked up in 30000 ms` → voicemail |
| **18:09:39** | desktop + Android | ❌ | **he tapped Answer on the iPhone; no INVITE ever reached it; caller gave up at 20 s** |
| 18:53:53 | Android + desktop | ❌ | `Nobody picked up in 30000 ms` → voicemail |
| 20:13:07 | **iPhone** + desktop + Android | ✅ | voicemail (his own test call to himself) |

**The iPhone answered zero calls today.** Over the last 14 days the iPhone has
accepted exactly **one** `CallInvite` — today's 18:09 one — and that one failed.
The only other accepted invite in 14 days was on the **Android**, 2026-08-18.

⛔ The one time the iPhone *was* in the ring list (20:13:07) it was only because
he had opened the app **5 seconds earlier**.

---

## 2. The failed answer, to the second (18:09 ET / 22:09 UTC)

Call `1787609370.20746`, caller `8456993907` → DID `8458067040` → IVR → ext 103.

| | |
|---|---|
| 18:09:39.x | PBX runs `connect-wake-core` → **`warm — live contact ext=103`** → `connect-mobile-wake-dial dialing T31_103_1 **after 0s**`. Contact list committed: `p13utp95@50.122.143.130` (desktop) + `5prquhca@192.157.90.181` (Android). **No iPhone.** |
| 18:09:40.674 | `INVITE_PUSH_DELIVERED` to **both** iPhones, `expoStatus: "ok"` |
| 18:09:43.3 | iPhone `sjcw2s7d` `SESSION_START` (VoIP push woke the app) |
| **18:09:43.9** | iPhone **`DEVICE_REGISTER_COMPLETE`, source `ring_predeliver`** — **4.3 s after the PBX stopped looking** |
| 18:09:44.2 | he taps Answer. Backend claim → `INVITE_CLAIMED_OK`, `CallInvite` → ACCEPTED |
| 18:09:50.4 | client logs `SIP_REGISTER` / `WS_CONNECTED` |
| 18:09:53 | Asterisk marks that fresh contact **UNREACHABLE** (one `qualify_timeout` = 3 s) |
| 18:09:59 | **caller hangs up** — 20 s in |
| 18:10:00.2 | app gives up after **16,156 ms**, forces a socket restart, uploads the blackbox |

Blackbox (`VoiceDiagEvent CALL_QUALITY_REPORT`,
`payload.debugKind = WEBRTC_INBOUND_ANSWER_FAIL`):

```
failureReason:          "sip_invite_not_received"
diagnosisCategory:      "INBOUND_INVITE_NOT_RECEIVED"
incomingSessionCount:   0     answerableSessionCount: 0
candidates:             []    jssipCallIds: []
answerAttempts:         null  pollIterations: null
sipAnswer:              { sent: false, attempted: false, confirmed: false }
uaConnected: true  uaRegistered: true  sipStackHealthy: true
registration.registrationAgeMs: 986
backendAccept: { requested: true, responseCode: "INVITE_CLAIMED_OK" }
durationUntilFailureMs: 16156
pushMeta: { pushToAnswerMs: 0 }   answerPath: "background_app"
```

**He did nothing wrong.** He was woken by the push, tapped Answer inside a
second, the backend told him he owned the call — and the PBX had never addressed
an INVITE to that phone.

---

## 3. ⛔⛔ ROOT CAUSE: the wake-and-wait hold is per-EXTENSION, sleeping is per-DEVICE

`connect-wake-core` (`/etc/asterisk/extensions__60_custom.conf:294-302`):

```
5.  Set(EP_PRIMARY=T${TID}_${EXT})            ; the DESK endpoint
6.  Set(EP_SECONDARY=T${TID}_${EXT}_1)        ; the APP endpoint
7.  Set(CONTACTS_PRIMARY=${PJSIP_DIAL_CONTACTS(${EP_PRIMARY})})
8.  Set(CONTACTS_SECONDARY=${PJSIP_DIAL_CONTACTS(${EP_SECONDARY})})
10. Set(WARM=${IF($[LEN(PRIMARY) > 0 | LEN(SECONDARY) > 0]?1:0)})
13. GotoIf($["${WARM}" = "1"]?warm)           ; -> Return(), NO grace wait
```

and `connect-mobile-wake-dial:11`:

```
11. GotoIf($["${DEVICE_STATE(PJSIP/${EP})}" != "UNAVAILABLE"]?dial)
```

**Two gates, and both are satisfied by somebody else's device.** Fixup Group has
a permanently registered **desk phone** (`T31_103`, two contacts), a permanently
registered **desktop app**, and an **Android** — all on the same extension. So
`CONTACTS_PRIMARY` is never empty, `WARM` is always 1, the endpoint is never
`UNAVAILABLE`, and the hold that exists precisely to wait for a sleeping phone
**can never engage for this customer.**

Verbatim from the PBX log on **all seven** calls today:

```
connect-wake-core warm — live contact ext=103
connect-mobile-wake-dial dialing T31_103_1 after 0s
```

The ring window was **30 seconds**. The PBX committed its dial list at t=0 and
never re-read `PJSIP_DIAL_CONTACTS` again. The iPhone came back at **t+4.3 s**.
**26 seconds of runway went unused.**

⛔ This is not specific to Fixup Group — it is the shape of the dialplan. Any
extension with a registered desk phone, or a second always-on client, has the
mobile wake hold silently disarmed. Across the whole PBX log (~2 days) the hold
fired > 0 s **twice** (`T2_103_1 after 7s`, `T141_101_1 after 1s`) out of ~230
wake-dials; everything else is `after 0s`.

---

## 4. ⛔ Why the iPhone has no contact: its registration lives a median of **33 seconds**

Measured over the full retention of `PbxEndpointRegistrationEvent`
(2026-08-10 → 2026-08-24, 2,328 events on `T31_103_1`), grouped by client family
via the contact IP:

| client family | distinct contacts | lifetimes measured | median life | min / max |
|---|---|---|---|---|
| **iPhone** (Verizon wireless `174.216.244.213`, `174.197.x`, `174.204.x`; Cisco IoT `198.182.177.x`, `198.102.229.x`) | ~52 | 18 | **33 s** | 2 s / 213 s |
| Android (Cologuard filter `192.157.90.x`) | 1,042 | 993 | **840 s** | 0 s / 919 s |
| Desktop app (office wired `50.122.143.130`) | 17 | 12 | **75,828 s** (21 h) | 27 s / 271,571 s |

`T31_103_1` AOR: `qualify_frequency 30`, `qualify_timeout 3.0`,
`max_contacts 5`, `remove_existing true`.

**33 s ≈ exactly one qualify cycle.** The iPhone registers, iOS suspends the app,
the WebSocket stops answering `OPTIONS`, and at the first ping Asterisk marks the
contact **Unreachable** and stops dialling it. Over 14 days on this endpoint the
iPhone family shows **5 REGISTERED vs 13 UNREACHABLE and 12 UNREGISTERED**.

⛔ **That is normal iOS behaviour, not a fault in his phone or his network** — an
iOS app cannot hold a WebSocket while suspended. It is exactly the condition
wake-and-wait was built to cover, and §3 is why it doesn't.

The pattern is universal to iOS here — all five active iOS users show
`REGISTERED ≈ UNREACHABLE ≈ UNREGISTERED`:

| endpoint | tenant | via443 | 7-day reg events | median contact life |
|---|---|---|---|---|
| T9_111_1 | B Visible (Lester) | ✅ | 386/335/216 | 272 s |
| T106_101_1 | TYH Industries | ✅ | 41/38/37 | 598 s |
| **T31_103_1** | **Fixup Group** | **❌** | 477/36/462 | **33 s (iPhone rows)** |
| T141_101_1 | Hanna | ✅ | 18/18/12 | 93 s |
| T6_101_1 | Displaydex (Eli) | ✅ | 13/13/10 | 154 s |

⛔ **Fixup Group is the last active iOS user on the platform still on the
direct-to-PBX port-8089 route.** `webrtcRouteViaSbc: false`,
`sipWsUrl: wss://209.145.60.79:8089/ws` — a raw IP, which
`normalizeSipWsUrlHost` serves to the client as
`wss://m.connectcomunications.com:8089/ws`, so there is no TLS-on-IP problem,
but it is still **port 8089 straight to the PBX** rather than the 443 route every
other iOS customer is on. Confirmed by the contact IPs: theirs are the customer's
own addresses, while B Visible / TYH / Hanna show `45.14.194.179` (loopcom).

---

## 5. ⛔ What is NOT the cause — checked, so nobody re-derives it

- **Not the push channel.** Every call today delivered `INCOMING_CALL_WAKE` *and*
  `INCOMING_CALL` to **both** iPhones with `expoStatus: "ok"` and no `expoError`.
  The push side is flawless; it is the only reason the screen lit up at all.
- **Not the 2026-08-22 warm-answer-deadline regression.** That fingerprint is
  `answerAttempts: 1, pollIterations: 1, durationUntilFailureMs ≈ 641–745`. Here
  `answerAttempts` is **null**, `sipAnswer.sent` is **false** and the failure took
  **16.2 s** — the answer code never ran, because there was no session to answer.
  ⛔ **Do not tell him to update the app for this.** (Same discrimination as
  `AGENT_HANDOFF_LUXURE_101_ANSWER_AUDIT_2026-08-23.md` §2.)
- **Not the two 2-second outbound calls at 20:25:52 and 20:26:00 ET.** The PBX
  shows both dialled out through `trk-72-dial`, were **answered by the far end**
  (`PJSIP/0001 answered PJSIP/T31_103_1`) and cleared 2 s later with
  `Trunk Hangup`. Back-to-back 2-second test calls, not failures.
- **Not a Connect outage.** api/telephony/worker all healthy; the 14 other CDR
  rows today completed normally.
- ⛔ **`ConnectCdr.disposition: "answered"` is not proof a human answered.** Four
  of today's calls read `answered` in the CDR while the PBX log says
  `Nobody picked up in 30000 ms` → `Leave Voicemail` — the IVR/voicemail answered.
  Only **2 voicemail recordings** exist today (22:54:32 1 s, 00:13:46 0 s), so on
  the rest the caller hung up at the greeting. Use the `app_dial.c … answered`
  line, never the CDR.

---

## 6. Contributing factors worth acting on

- ⛔ **He is signed in on TWO iPhone 17 Pros** — `rj3z7vxg` (iOS 26.6) and
  `sjcw2s7d` (iOS 26.5.1), both created 2026-08-05, both active, both holding
  VoIP tokens, both pushed on every call. Different OS versions means two
  physical handsets. With `max_contacts: 5` and `remove_existing: true` on a
  shared AOR that also carries the desktop and the Android, they compete for
  slots. Both of today's `ANSWER_TAPPED action=DECLINE` taps (18:08:57 and
  18:53:57 ET) came from the **other** iPhone while the first one was showing the
  incoming screen — the two phones are also fighting each other.
- The **Android** is behind the **Cologuard** content filter
  (`192.157.80.0/20`, Old Bridge NJ) — the same filter documented for Luxure in
  `AGENT_HANDOFF_FILTERED_INTERNET_2026-08-03.md`. It is healthy: a clean
  14-minute re-registration metronome.
- ⚠️ **Noticed, not touched:** the desk phone `T31_103` holds a contact at
  **159.89.179.105 — DigitalOcean**. A desk phone registering from a cloud host
  is odd and worth one question to the customer.

---

## 7. Recommendations, cheapest first

1. **Sign out of one of the two iPhones.** Zero risk, removes the contact
   competition and the phantom declines.
2. **Sign out / close the desktop app when he is out of the office.** It is one
   of the two contacts that keeps the AOR "warm" and disarms the hold. A
   workaround, not a fix — and it also stops his desk ringing, so it is his call.
3. ⛔⛔ **The real fix is ours, and it is a PBX dialplan change with
   platform-wide blast radius — NOT attempted here.** Two candidate shapes:
   (a) make the hold per-device — wait when a *known mobile device* has no
   reachable contact rather than only when the whole extension is `UNAVAILABLE`;
   (b) re-read `PJSIP_DIAL_CONTACTS` during the ring and dial contacts that
   arrive late, instead of committing the list at t=0.
   `connect-wake-core` and `connect-mobile-wake-dial` are **shared by every
   tenant** — per CLAUDE.md's third standing rule, trace every consumer before
   proposing either.
4. **Move Fixup Group to SIP-over-443** (`webrtcRouteViaSbc: true`,
   `sipWsUrl: null`, `sipDomain: m.connectcomunications.com` — three fields, read
   live per request, no deploy; ⛔ the user must sign out and back in, because the
   app never refreshes a cached `sipWsUrl`). This will **not** fix the hold gap on
   its own — say so plainly — but it brings the last iOS customer off the filtered
   8089 path and in line with the other four.

---

## 8. ⏳ NOT PROVEN / still open

- **Nothing was changed.** No fix has been applied, so nothing here is proven to
  have improved anything. The acceptance test for any fix is a real inbound call
  that rings his iPhone while the app is in the background and he answers it.
- **The per-device hold has not been designed or traced.** Item 7.3 is a
  direction, not a plan.
- Whether the two iPhones are two people or one person with two handsets is
  unknown — worth asking before signing one out.
- The DigitalOcean desk-phone contact (§6) is unexplained.

## 9. Query recipes used here

- Which app contacts a call actually rang:
  `grep "T31_103_1@connect-mobile-wake-dial:18\] Set" /var/log/asterisk/full`
- Whether the hold engaged:
  `grep -oE "connect-mobile-wake-dial dialing T[0-9]+_[0-9]+_1 after [0-9]+s"` —
  `after 0s` means it never waited.
- Which client a contact belongs to: the **`x-ast-orig-host=<id>.invalid`**
  parameter is the JsSIP instance id and is stable per client install; correlate
  it against `VoiceClientSession.startedAt` to name the device.
- Contact lifetime: group `PbxEndpointRegistrationEvent` by `contactUri`, take
  `REGISTERED` → first later `UNREACHABLE`/`UNREGISTERED`.
- ⛔ `PbxEndpointRegistrationEvent` orders by **`occurredAt`**, and
  `CallWakeEvent` too — neither has `createdAt`. `Extension` has **`displayName`**,
  not `name`. `PbxTenantInboundDid` keys on **`connectTenantId`**, not `tenantId`.

---

## 10. Appendix — CLAUDE.md carries a NUL byte (found in passing, NOT repaired)

Found while doing the routine end-of-task CLAUDE.md update. Recorded here so the
evidence is not lost; the decision is Izzy's and is written up in CLAUDE.md's own
section. Short version:

- Three warning bullets in CLAUDE.md are each **about** the heredoc-escape trap
  and each **fell into it** — a NUL, a BACKSPACE and a real right-to-left
  override sit where their two-character escapes belong.
- The NUL is why `grep -n CLAUDE.md` answers `Binary file CLAUDE.md matches`.
  git disagrees (its binary sniff window is the first 8,000 bytes; the NUL is at
  29,684), which is why `git diff` still renders the file as text.
- ⛔ Because git considered it binary, `core.autocrlf` stopped converting:
  blob line endings went **0 CRLF / 13,870 LF** at `5f2b071d` →
  **13,771 CRLF** at `d39cad7f` (the commit that introduced the NUL) and CRLF
  ever since.
- ⛔ **Removing the NUL therefore triggers a one-time 14,049-line renormalisation
  — a 28,099-line diff.** Measured, then reverted, because a whole-file
  line-ending diff cannot be reviewed, and reviewing the staged diff is the only
  thing that catches another session's in-flight CLAUDE.md work.
- ⛔ **Write the repair through the editor, never a heredoc.** This session's
  first attempt used a heredoc; the shell consumed the double backslashes and
  wrote the same bad bytes straight back, while still changing the surrounding
  wording — so it *looked* like it had worked.

The repair, for whoever runs it (four substitutions, in a `python` script file):

| in CLAUDE.md | replace with |
|---|---|
| `` `"<NUL>nul"` `` | `` `"\0nul"` `` |
| `` `<BACKSPACE>` became a literal BACKSPACE `` | `` `\b` became a literal BACKSPACE `` |
| `` `<U+202E>` `` | `` `‮` `` |
| the real CRLF/CR inside the desk-phone heredoc bullet's backticks | `` `\n` `` and `` `\r` `` |

Then assert zero characters remain matching
`c < 32 and c not in "\r\n\t"`, or in `U+200B-200F / U+202A-202E / U+2066-2069 / U+FEFF`,
before writing the file back.

---

## 11. Follow-up (2026-08-25): the late-join rescue EXISTS and it refused this exact call — Mode-B diag preserved

Asked "how would we fix this", the design investigation found that telephony's
**Mode-B cold-answer re-delivery** (`requeueLiveCallToDialplan`,
`apps/telephony/src/telephony/services/TelephonyService.ts:892`) is precisely
the tap-triggered late-join mechanism — and it **ran on the 18:09 answer tap,
found the fresh contact, and refused**. The log line (preserved here because
`docker logs` is wiped at every telephony deploy):

```json
{"time":1787609384250,"component":"TelephonyService","linkedId":"1787609370.20746",
 "trigger":"invite_accept","callState":"up",
 "extLegAor":"T31_103","extLegDialedAt":1787609379916,
 "extLegDialContext":"connect-mobile-wake-dial","extLegDialExten":"T31_103_1",
 "modeBAlreadyRedirected":false,"isInviteAccept":true,
 "isDirectExtTarget":false,
 "freshContactNotDialed":"sip:t31_103@50.122.143.130:8961",
 "modeBReDeliver":false,"modeBReason":"not_direct_extension",
 "msg":"mode-b diag: invite_accept requeue evaluation"}
```

Plus, in the same second: `mobile invite requeue skipped — extension leg
already ringing/live` (the desk legs genuinely were), and at ring start a
`device_register_complete` requeue attempt refused with `no safe trunk Dial
position`.

**Three mechanical reasons it refused, all fixable in Connect code (no dialplan
change):**

1. ⛔ **`isDirectExtTarget` only recognises `*local-dialing*` contexts, and the
   app leg is dialed from `connect-mobile-wake-dial`** — a context that did not
   exist when the Mode-B gate was written (Mode-B: 2026-06-29; wake-dial fleet
   rollout: 2026-08-05). The gate was never taught the new context.
2. ⛔ **`extLegAor` captured the DESK AOR (`T31_103`), not the app AOR
   (`T31_103_1`)** — so `freshContactNotDialed` searched the wrong endpoint and
   found a fresh *desktop* contact instead of the iPhone's fresh registration.
   The capture takes one leg's DialBegin per call; with desk + wake-dial legs
   both live, it kept the desk one.
3. ⛔ **The re-delivery mechanism is an AMI Redirect of the TRUNK leg**, which
   restarts the entire dial — that is why the `extension leg already
   ringing/live` skip exists (the RSBK ring-group loop, 2026-06-25) and why it
   must keep firing while a desk phone is legitimately ringing. A safe
   late-join needs to dial **only the one fresh contact as an additional leg**
   (Originate + bridge), disturbing nothing already ringing; the
   answered-elsewhere machinery (Hanna fix, `multiPartyBridgeAt`) already
   cleans up losing legs.

**The stale-vs-sleeping question is already answered in code and it is
time-based, not state-based**: `AorContactRegistry` stamps `firstSeenAt`;
`freshContactNotDialed(aor, dialedAt, dialedContacts)` = registered AFTER this
call's dial AND not among the dialed contacts. A stale/zombie contact (which
can keep answering qualify and even return 180 — proven 2026-06-28) existed
before the dial by definition; a woken phone registers after the push, and
JsSIP rotates the Contact URI on every REGISTER so the fresh one is always
literally new. Do not add a contact-classification heuristic — watch for the
new registration.

⛔ **Fix order per the blast-radius rule** (the Mode-B comment block records
FOUR prior regressions from loosening these gates — trace before editing):
teach the gate the `connect-mobile-wake-dial` context + capture the leg's own
AOR per leg (tap-triggered only; fixes exactly this call's shape), prove on a
real call, and only then consider registration-triggered join and the
Originate-a-single-leg mechanism. NOT built, NOT started.

---

## 12. THE FIX IS BUILT AND DEPLOYED (2026-08-25) — Mode-B learns the wake-dial leg shape

Izzy: *"Build it and do it."* Commit **`dc12d3c5`** on
`feat/ivr-migration-takeover`, **telephony DEPLOYED via the queue** (job
`683341f1`, 2026-08-25 11:47Z) **in a measured 0-active-calls window and
container-verified**: server clone at `dc12d3c5`, `resolveWakeDialLeg` ×3 +
`answered_during_grace` grepped in the running container's src (telephony runs
from src via tsx — there is no dist/), `wakeDialLeg.ts` present, 0 restarts,
AMI authenticated + ARI healthy, 0 error-level lines. No API change, no
dialplan change, no PBX write, no migration.

**What shipped** (`apps/telephony/src/telephony/services/`):

- **`wakeDialLeg.ts`** — pure `resolveWakeDialLeg(channels, preferExt)`:
  derives the app AOR / extension / pbx code from the wake channel's own name
  (`Local/T31_103_1@connect-mobile-wake-dial-…` → `T31_103_1` / `103` / `T31`).
  `preferExt` (= the invite's `toExtension`, already arriving as
  `fallbackExten` — **no API change was needed**) pins WHICH extension's wake
  leg when several ring; ambiguity fails closed to `null`.
- **The wake-leg shape in `requeueLiveCallToDialplan`**: when an
  `invite_accept` requeue finds a live wake-dial channel AND the trunk's own
  Dial position is a direct extension dial (`*local-dialing*` — ring groups /
  queues keep the old refusals, so the RSBK restart-at-priority-1 loop stays
  impossible), the fresh-contact test runs against the **APP** AOR instead of
  the mis-captured desk AOR, and the redirect goes to the proven
  `T<pbx>_cos-all,<ext>` target — ⛔ **the exten is the extension NUMBER from
  the wake leg, never `extLegDialExten`**, which for this shape is the endpoint
  name `T31_103_1` and would dead-end the redirect.
- **`modeBAnswerGraceMs` (2.5 s)**: before ANY Mode-B redirect past a
  still-live extension leg, wait for a normal SIP 200 — a device answering the
  ordinary way (measured 300 ms–2.6 s) must never have its live INVITE torn
  down by a redirect racing its own answer. `extensionAnsweredAt` flipping
  during the grace stands the redirect down (`answered_during_grace`).
- Timing knobs became test-overridable class fields
  (`modeBFreshContactWaitMs/PollMs`, `modeBAnswerGraceMs/PollMs`);
  `requeueTestEnv.ts`'s `JWT_SECRET` seed lengthened to satisfy env.ts's ≥32
  minimum (`d21fd166`) so TelephonyService-importing tests run in a bare shell.

**Every historical protection is unchanged and re-asserted by test:**
`invite_accept` only (the 2026-06-28 `device_register_complete` revert), a
fresh contact NOT among the dialed set only, one-shot per call,
`extensionAnsweredAt` dominates everything, ring-group/queue trunk positions
excluded.

**Proven:** 12 tests in `wakeLegRedelivery.test.ts` driving the real service
against the real `CallStateStore`/`AorContactRegistry`, rebuilt from the
production call's own DialBegin shapes (so `extLegAor` really captures the desk
AOR and `extLegDialContext` really reads `connect-mobile-wake-dial`, exactly as
prod logged them). **Non-vacuous: 3 of 12 FAIL replayed against `HEAD`'s
TelephonyService** — the Fixup rescue, the grace, and the one-shot — while
every safety test passes on BOTH trees. Full telephony suite **225/228** (the 3
documented pre-existing smarthome `JWT_SECRET` local-shell artifacts);
typecheck **41 = the exact baseline**, the 5 in TelephonyService.ts being the
pre-existing `Timeout` typing artifacts present at HEAD.

⛔ **CORRECTION to §3's attribution, found while tracing the fix — the desk
phone was over-blamed.** `connect-mobile-wake-dial:11` gates its hold on
`DEVICE_STATE(PJSIP/T31_103_1)` — the **app endpoint's own** state — so a desk
phone ALONE would not disarm it (desk-only + sleeping iPhone → `UNAVAILABLE` →
the hold loop engages). What disarms it for Fixup is the **desktop app and the
Android sharing the `_1` AOR**: any always-on sibling app client keeps
`DEVICE_STATE` available and the frozen dial list ships without the iPhone.
The per-extension `WARM` check in `connect-wake-core` only skips its own
(redundant) grace loop. The mechanism conclusion and the fix are unchanged —
the hold's granularity is the shared `_1` AOR, not the device.

⏳ **NOT PROVEN: no real call has exercised the rescue.** It is proven as
deployed code, container greps and 12 tests — never as a conversation.
**Acceptance: the next inbound call he answers on the iPhone from a sleeping
state.** The one-grep check:
`docker logs app-telephony-1 | grep -a "AMI mobile invite requeue sent" | grep wake_leg`
— and the negatives that matter: `answered_during_grace` rows when a desk/app
answers normally, and NO `wake_leg` redirect ever appearing on a ring-group
call. ⏳ Registration-triggered join (INVITE the phone the moment it
re-registers, before any tap — native ring instead of tap-and-wait) is the
designed next step and is NOT built.

---

## 13. The desk-answers-first race (2026-08-25, Izzy's follow-up) — every layer, and the one that was missing is built

Izzy: *"the desk phone is going to start ringing before the iPhone and
potentially answer... the iPhone would still ring, they would answer, and it
would freeze on them."* Traced layer by layer:

| moment | what happens | state |
|---|---|---|
| desk answers while iPhone rings, **no tap yet** | Asterisk CANCELs the app INVITEs; the answered_elsewhere sweep cancels the PENDING invite and pushes INVITE_CANCELED (incl. the iOS VoIP cancel push, built 2026-07-30) → ring dismissed in ~1–2 s | ✅ already built |
| iPhone taps **after** the invite was canceled | the claim refuses (`INVITE_ALREADY_HANDLED` / `INVITE_EXPIRED`) → app dismisses | ✅ already built |
| iPhone taps, claim WINS, **then** desk answers | the Mode-B **answered-grace** (dc12d3c5) sees `extensionAnsweredAt` flip and stands the redirect down — the desk's live call is never stolen | ✅ built yesterday |
| …but the iPhone then sat on **"Connecting…" for its full 16 s budget** | ⛔ the answered_elsewhere sweep only canceled **PENDING** invites; a claimed invite is **ACCEPTED**, so the loser was never told | **THIS was the gap** |

**The fix (`f17f507a`, api):** the mobile-ring-notify fast-path runs a second
pass over invites that are **ACCEPTED with `endedAt` null** (claimed, never
connected) and pushes INVITE_CANCELED at the loser, stamping `endedAt` as the
one-shot loss marker (conditional `updateMany` — nothing else writes `endedAt`
on `CallInvite`). The frozen screen dismisses in ~1–3 s instead of 16.

⛔ **Safety ladder, in order of dominance — each line is a test:**
1. **The Hanna own-app guard applies to the loss push too**: an invite whose
   own app endpoint answered is never touched — including a shared-AOR sibling
   (the desktop app answering while the iPhone claimed), which deliberately
   falls back to the app's own 16 s give-up. ⛔ Pushing there could tear down
   the sibling's live answer on pre-guard app builds (Luxure's 2026-08-01 APK
   has no client-side cancel guard) — the safe direction is chosen.
2. **`hungup`/`voicemail` reports for a call that WAS answered skip the pass**
   (`input.answered`) — the loser was handled at answer time, and the winner
   must not get a pointless cancel push after every completed call.
3. **Client side** (fleet builds since `83a5728c`): the cancel handler ignores
   a cancel for a call with a CONFIRMED session (`hasConfirmedSipSession() &&
   answeredId === prev.id`) — so this push can only ever dismiss a screen with
   no call behind it. Verified by reading `NotificationsContext.tsx:5685`.

Also covered for free: **caller-gives-up-while-claimed** (state `hungup`,
`answered: false`) and **ring-diverts-to-voicemail-while-claimed** — both
previously froze the tapping phone the same way.

⛔ `answeredEndpoint: null` on an answered_elsewhere report means a
carrier/follow-me answer (the Hanna fix resolves the endpoint BEFORE emit when
an extension leg answered) — the app cannot be the connected party, so pushing
is safe there.

**Proven:** 13/13 in `mobileRingAnswerPolicy.test.ts`; **all 4 new source
guards FAIL replayed against `HEAD`'s server.ts**. api typecheck **76 = the
exact baseline**. Deploy state at the end of this section.

⏳ **NOT PROVEN by a real race** — acceptance: desk answers while the iPhone
is mid-tap; the iPhone should show "Call ended" within ~3 s instead of
freezing. The one-grep check:
`docker logs app-api-1 | grep "claimed-but-unconnected invite lost"`.
