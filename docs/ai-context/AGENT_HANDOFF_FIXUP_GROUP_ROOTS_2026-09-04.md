# AGENT HANDOFF — Fixup Group "to the roots": every failure since the system went up, each with its fix and the proof of the fix (2026-09-04 → 2026-09-06)

Izzy, 2026-09-04: *"Fixup USA, Fixup Group is complaining again about the app. They're
complaining about the answering calls on the iPhone. The office phones are complaining.
… I want you to find every single issue. Go dig deep, all the way to the roots. I want
to know everything, every failure, every hiccup they had since the system went up."*
Then: *"in every failure, I want a solution and proof that the solution is the right
solution."*

Tenant `cmqr9cs9402qqs013m7p64lpi` (Connect) = PBX **T31**, one extension **103 "Office"**,
login `fixupusa1@gmail.com`. Devices on the ONE app AOR `T31_103_1`: the office
Windows app, an Android phone, and **two iPhone 17 Pros**. Desk phone `T31_103`.
Related earlier work: `AGENT_HANDOFF_FIXUP_GROUP_IPHONE_2026-08-24.md` (the Mode-B
late-join rescue, `dc12d3c5`), `AGENT_HANDOFF_FIXUP_SMS_COMPLAINTS_2026-08-30.md`
(the desktop-notification + MMS fixes, `78e6d827`).

Everything below was read from production: `asterisk.cdr` on the PBX (all-time, ET),
`/var/log/asterisk/full` (today + yesterday only), Connect `CallInvite`,
`CallWakeEvent`, `PbxEndpointRegistrationEvent` (retention from 08-21),
`VoiceDiagEvent` blackboxes, `ConnectCdr.rtpStats`, telephony `docker logs`
(container up 4 days), nginx access logs. SQL in the session scratchpad
(`q1.sql`…`q8.sql`, `pbx1.sh`…`pbx4.sh`).

---

## 1. The whole history in one table (inbound calls to Fixup, 2026-06-23 → 09-04)

| Outcome | Calls | Notes |
|---|---:|---|
| Total inbound to the DID | **92** | since the tenant went live |
| Answered on the **desk phone** | 43 | healthy throughout |
| Answered on an **app** | 4 | **all Android or the Windows app — the iPhones have NEVER connected an inbound call** |
| Went to voicemail | 7 | |
| Caller hung up inside IVR-48 without pressing a key | 29 | the menu REQUIRES a keypress; every option routes to 103 |
| Rang the office 30 s, nobody picked up | 7 | 2 of them today (09-04) |
| iPhone **Answer taps on inbound calls** | 4 | **4 of 4 failed** — 08-05, 08-07, 08-24, 09-04 |

Fixup has filed **zero** support tickets. SMS ingest is clean (every carrier row since
08-24 landed). The 08-30 notification/MMS fixes are deployed; the office desktop has been on
`Loopcom/0.1.16` since 09-03.

---

## 2. Failure by failure

### F1 — TODAY, 2026-09-04 10:12 ET: iPhone answered, caller got voicemail (linkedid `1788531118.72336`)

Caller 973-756-5563 called **three times in five minutes** and never reached a person.

Timeline (UTC), every line from a different system:

| Time | Source | Fact |
|---|---|---|
| ~14:10:49 | iOS app | iPhone (sjcw) backgrounded — its last registration before the call |
| 14:11:22 | PBX registration events | **iPhone contact removed** (qualify: `qualify_frequency 30`, `qualify_timeout 3` → Unreachable at the first missed OPTIONS, contact dropped) |
| 14:11:59 | CallWakeEvent | `INCOMING_CALL_WAKE` delivered to both iPhones (Expo) |
| 14:12:15 | PBX `full` log | wake-dial commits `CONTACTS=` **desk + desktop + Android** — no iPhone (its contact was already gone) |
| 14:12:18 | CallWakeEvent | `INCOMING_CALL` push delivered to both iPhones |
| 14:12:25 | CallInvite | sjcw taps **Answer** (`ACCEPTED`) |
| 14:12:25–33 | telephony log | Mode-B rescue waits `modeBFreshContactWaitMs = 8000` for a NEW contact — **`no_fresh_contact`** |
| 14:12:41 | iOS blackbox `WEBRTC_INBOUND_ANSWER_FAIL` | `registrationState: "registered"`, **`registrationAgeMs: 156681`**, `wssConnected: true`, `INBOUND_INVITE_NOT_RECEIVED` — the app still believed it was registered and **never sent a REGISTER**; a forced restart only fired at +16 s |
| 14:12:45 | PBX | 30 s ring expired → voicemail |
| 14:12:52 | CallInvite | loss marker (`endedAt`) |

**Root cause (code):** the iOS ring path trusts JsSIP's local `isRegistered()`. Three
places skip on "registered": the eager pre-register in `NotificationsContext.tsx`
(`eager_preregister_skipped_already_registered`), `registerInner`'s *"Already registered,
skipping re-register"* in `jssip.ts`, and `shouldForceRestartOnWake` (Android only
anyway). The iOS cold/background answer path also deliberately disables the stale-socket
restart (`earlyColdAcceptSent`, the 07-13 fix). The only staleness watchdog is the 540 s
keepalive check. So a suspended iPhone's contact dies on the PBX ≤33 s after backgrounding
and the app never notices — **the PBX cannot dial a phone that is not in its contact list,
whatever the phone believes.**

**Same signature 2026-08-07** (`registrationAgeMs 162675`, `registered`, invite not received).

**Platform-wide, not Fixup-specific:** 6 of 15 iOS `WEBRTC_INBOUND_ANSWER_FAIL`
blackboxes on the platform (B Visible, Loopcom Demo, Fixup) carry `registered` +
`registrationAgeMs > 30 s` + `INBOUND_INVITE_NOT_RECEIVED`.

**Fix — `5dcc38a5`, iOS build 58.** `decideRingRegister()` in
`apps/mobile/src/sip/mobileWakeRegistration.ts`: on iOS, when the ring push arrives with
the app NOT active and the registration older than `IOS_PBX_CONTACT_DROP_MS = 30 000`
(the PBX qualify period — a shorter age cannot have missed a ping), the eager pre-register
site calls `sip.register({ forceRestart: true })` instead of skipping. Foreground apps,
registrations younger than 30 s, "registering", and **Android are byte-identical to
before**. jssip's `inInviteAnswerWindow()` guard still refuses the restart once an INVITE has
landed, so a call already delivered is never torn down.

**Proof the fix is right:**
- 17 tests in `mobileWakeRegistration.test.ts`, the decisive ones built from the real
  blackbox values (156 681 / 162 675 ms, background) → `force_restart`; foreground with the
  same age → `skip`; 30 000 → `skip`, 30 001 → `force_restart`; Android → `skip`.
- Three SOURCE guards read `NotificationsContext.tsx` (comment-stripped, CRLF-normalised)
  and **all three FAIL replayed against HEAD** (`MOBILE_GUARD_ROOT=/tmp/mob-head`): the
  defect was a caller, and a unit test of the rule alone passes straight through it.
- `tsc --noEmit` on apps/mobile: **0 errors** (baseline 0).
- Blast radius traced: the only changed call site is the eager pre-register block; the
  `ring_predeliver` `sip.register()` (no forceRestart) is serialised behind it by
  `register()`'s promise chain and resolves once the fresh REGISTER completes — which is
  exactly when the `DEVICE_REGISTER_COMPLETE` requeue should fire.
- ⏳ **NOT proven on a phone yet** — build 58 was queued 2026-09-06 14:57Z
  (`1ae3d8f9-f406-4a62-aaae-f71a4b839e31`); the acceptance test is §4.

### F2 — 2026-08-24: iPhone registered 4.3 s AFTER the PBX froze the dial list

The other shape: the iPhone did re-register, but the wake-dial had already committed
`CONTACTS=` without it. **Fixed 2026-08-25 by `dc12d3c5`** (Mode-B late-join: a contact
registered AFTER the dial and not in the dialed list is redirected to `T31_cos-all,103`) —
proven by 12 tests replaying that exact call (3 fail against pre-fix HEAD) and container-
verified. It has **not** fired on a real Fixup call because every later failure was F1 (no
fresh contact ever arrived inside its 8 s window). With F1 fixed, F2's rescue is the backstop
for a slow REGISTER.

### F3 — 2026-08-05: iPhone answer tap on a call with two iPhones fighting

Both iPhones share one `CallInvite`. A **DECLINE** from one iPhone flips the row to
`DECLINED`; the other iPhone's ACCEPT then answers `INVITE_ALREADY_HANDLED`
(`server.ts` ~16692–16848). Declines from the sibling iPhone observed 08-05, 08-12, 08-24,
08-25. **No lost call is proven from this alone** (each of those calls also had F1/F2), but
the hazard is real from the code. ⏳ **Not fixed — needs a per-device invite state
(migration)**; the cheap mitigation is to sign out one of the two iPhones (still
recommended, still not done).

### F4 — the iPhones were on the direct 8089 route behind a filtering proxy

Fixup was the **last active iOS tenant on the direct route** (`webrtcRouteViaSbc: false`,
`sipWsUrl` pinned to the raw PBX IP, `sipDomain` an IP literal). Its contacts came through
a Cologuard filter (`192.157.x` block); register-on-wake latency on that path was the
**slowest on the platform: p50 15.4 s / p90 57.7 s**, and 18 of 52 iOS sessions logged
`SIP_REGISTER_FAILED`.

**Fix — applied 2026-09-04 (production data, no deploy):** `webrtcRouteViaSbc=true`,
`sipWsUrl=NULL`, `sipDomain='m.connectcomunications.com'` (the three-field rule); guarded
UPDATE, 1 row; backup `/root/fixup-443-20260904/tenant-before.json` on loopcom; read back.
⛔ **Requires every device to sign out and back in** (the app never refreshes a cached
`sipWsUrl`); until then nothing changed for them.

**Honest statement: 443 is NOT the answer-failure fix.** B Visible has been on 443 for
weeks and carries **7** iPhone `INVITE_NOT_RECEIVED` failures with the F1 signature. The
flip removes the filter from the SIP path (faster, steadier REGISTERs — which is what F1's
fix needs to land inside the ring); the stale-registration bug is F1.

### F5 — the Android is five weeks behind

Fixup's Android runs `1.0.0+20260802-103722`. Every fix since (warm-answer deadline,
contact names, keypad, wake-push gate…) is not on it. **Fix: install the current APK from
the download page** (nothing pushes it). Not a code item.

### F6 — the office: "rang 30 s and nobody picked up", twice today

Both of today's calls rang the desk phone + desktop + Android for the full 30 s. The desk
phone was **registered, RTT 32 ms, 0 % loss** the whole time (`rtpStats` + registration
events); the ring reached it. ⚠️ A second desk contact via a DigitalOcean address
(`159.89.179.105` / `10.65.30.2`) vanished 08-31 20:40Z — unexplained, and worth one
question to them ("did you move/remove a phone?"). Brief unreachable flaps 09-01/09-02.
**No platform fault found on the desk path.**

### F7 — 29 of 92 callers hung up inside the menu

IVR-48 requires a keypress (every option → 103) and a timeout plays *"that option is
invalid"*. A third of all callers never pressed anything. That is their menu design, not a
fault — but it is where a third of their inbound traffic goes. Izzy's call (a
no-key-pressed default to 103 is one dialplan change).

### F8 — 2026-09-06 (reported by Izzy the same day): "a voicemail was playing, a call came in, and the voicemail didn't stop"

Three voicemail players exist and **none of them paused on a ring** — read from the code,
each a component with its own `<audio>`/`Audio.Sound` and no phone awareness:

| Surface | What it keyed on before | Why that missed the ring |
|---|---|---|
| Mobile `VoicemailTab` (iPhone/Android) | `sip.callState` ∈ dialing/ringing/connected | `sip.callState` becomes "ringing" only when the **SIP INVITE reaches JsSIP**. The ring screen is **push-driven** (`incomingInvite` in NotificationsContext) and the INVITE arrives seconds later — or **never**, which is exactly F1's failure shape on every Fixup iPhone call. So the voicemail played straight through the CallKit ring. |
| Portal voicemail page `SmartAudioPlayer` | nothing | never consulted `useSipPhone` at all |
| Mini dialer `VoicemailPlayer` | nothing | never consulted the phone at all |

Which surface Fixup meant is **not provable from the server**: their desktop window has
produced **0** `CLIENT_TRACE` rows in 7 days (never restarted since the 09-03 deploy, so
it records nothing), and the iOS blackbox carries no playback state. All three were fixed.

**Fix — `6a86b621`.** Mobile: `callIsActive` now also includes
`notifications.incomingInvite !== null` (the push invite), so playback stops the instant the
ring push lands, whatever the SIP stack is doing. Portal page + mini dialer: each player reads
`useOptionalSipPhone()` and pauses its `<audio>` on `ringing` / `dialing` / `connected`.

**Proof:** `apps/portal/lib/voicemailPausesOnRing.test.ts` (2 guards, registered) and
`apps/mobile/src/screens/tabs/voicemailPausesOnRing.test.ts` (1 guard, registered as
`test:voicemail-ring-stop`) — **all three FAIL replayed against HEAD** (`PORTAL_GUARD_ROOT`
/ `MOBILE_GUARD_ROOT`); portal `tsc` 0, mobile `tsc` 0. Deploy/build state in §5.
⛔ The mobile half rides **iOS build 59** (build 58 does not have it) and the next Android
fleet APK; the portal half reaches the office desktop only after a **full close + reopen**
(an open window keeps the old bundle).

---

## 3. What was done, in order

1. **Read-only investigation** (all systems above) — the table in §1 and the timelines in §2.
2. **Production data change:** Fixup Group → 443 route (F4). Backed up, guarded, read back.
3. **Code:** `5dcc38a5` — iOS stale-registration fix (F1). Committed by explicit pathspec,
   pushed to `origin/feat/ivr-migration-takeover`.
4. **iOS build 58** started on loopcom from a FRESH clone `/tmp/connect-ios-build2`
   (the old `/tmp/connect-ios-build` object store refused every fetch with *"pack has N
   unresolved deltas"* even for a bundle that `git bundle verify` called okay — its
   `node_modules` trees were moved across, the rest is dead; **use build2 from now on**).
   GitHub also 401'd the server's pack fetch again, so the commit travelled by
   `git bundle create ^2ce97a7a feat/ivr-migration-takeover` → scp → `git fetch <bundle>`.
5. Build state + TestFlight: see §5 (filled in as it lands).

---

## 4. Acceptance test (the only proof that counts)

1. Every Fixup device signs out and back in (443 route takes effect; iPhones install
   build 58 from TestFlight).
2. Lock one iPhone, wait > 60 s, call the Fixup number, press a key, answer on the iPhone.
   Expected: `[ANSWER_PIPELINE] eager_preregister_stale_ios_force_restart` in the app log,
   a fresh `T31_103_1` REGISTER on the PBX within the ring, and EITHER the PBX dials the
   new contact directly OR telephony logs `AMI mobile invite requeue sent … wake_leg`
   (Mode-B) — and a two-way conversation.
3. Negatives: an iPhone in the FOREGROUND must show
   `eager_preregister_skipped_already_registered … appState=active` (never torn down); a
   desk-phone answer must still read `answered_during_grace`; no `wake_leg` redirect on any
   ring-group call.
4. If the answer still fails: read the blackbox. `registrationAgeMs > 30000` with
   `registered` → the fix did not run (wrong build); a fresh REGISTER that landed **more than
   8 s after the tap** → raise `modeBFreshContactWaitMs` (telephony, 0-active-calls deploy) —
   the 443 route is expected to bring register-on-wake well under that; measure before
   touching it.

---

## 5. Build / distribution state

- 2026-09-06 14:57:36Z — EAS build **58** queued, id
  `1ae3d8f9-f406-4a62-aaae-f71a4b839e31`, profile `ios-prod`, commit `5dcc38a5`,
  `appBuildVersion 58`; **FINISHED 15:04:27Z** (IPA artifact on EAS).
- 15:06Z — `eas submit` → App Store Connect (submission
  `a7fbdc83-353b-4c2d-b9b0-b39d45bb2a18`); **15:08:48Z Apple processing `VALID`**;
  attached to TestFlight group **"Loopcom Testers"** (`fe508ee6-…`, HTTP 204) and beta
  review submitted (`WAITING_FOR_REVIEW`, 201) — `/root/.appstoreconnect/asc-release-58.mjs`.
  `fixupusa1@gmail.com` is already a tester in that group, so both Fixup iPhones get build 58
  from TestFlight once Apple's beta review passes. The App Store release is Izzy's call;
  **the phones only change when the customer installs.**
- Android: the F1 fix is gated `Platform.OS === "ios"`, so no Android build is needed for it;
  Fixup's Android still needs the current fleet APK (F5).
- **F8 (`6a86b621`):** ✅ **portal DEPLOYED and container-verified 2026-09-06 15:42Z** —
  `app-portal-1` `.build-commit` = `6a86b621`, 0 restarts, `/voicemail` + `/api/health` 200
  on both hostnames, and the shipped chunks carry the new pause effect (measured by the
  `.paused` literal, which survives minification: voicemail page chunk **2 → 3**, mini-dialer
  chunk `app/desktop/mini-dialer/page-*.js` **0 → 1** — exactly the source deltas).
  ⛔ Deploy ran through the bundle → `/root/connect-mirror.git` route (GitHub still 401s the
  server's pack fetch); origin restored to GitHub afterwards (`/root/vm59-deploy.log`).
  **iOS build 59** (`855a24c3-f5cd-48dd-bf95-83971b28ce84`, commit `6a86b621`) FINISHED
  15:43Z, submitted to App Store Connect, **Apple processing VALID 15:46:55Z, attached to
  "Loopcom Testers" (204), beta review WAITING_FOR_REVIEW (201)** —
  `/root/.appstoreconnect/asc-release-59.mjs`. **Build 59 supersedes 58** (it carries both
  F1 and F8); Fixup's iPhones should install 59.
  ⛔ Android: the mobile half of F8 is NOT on any Android phone — it rides the next fleet APK
  (not built here; publishing an APK is Izzy's call).
