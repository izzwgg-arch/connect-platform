# ⛔⛔ AGENT HANDOFF — Fixup Group's iPhone was never in the ring list: the wake hold is per-shared-AOR but sleeping is per-DEVICE — Mode-B wake-leg rescue BUILT AND DEPLOYED (2026-08-24 → 25) — READ FIRST for ANY "the app rang but I couldn't answer" on iOS, before touching `connect-wake-core` / `connect-mobile-wake-dial` or `requeueLiveCallToDialplan`, or before telling an iPhone customer to update the app

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_FIXUP_GROUP_IPHONE_2026-08-24.md`**
(Investigation read-only; **the fix is `dc12d3c5`, telephony DEPLOYED via the
queue 2026-08-25 in a 0-active-calls window and container-verified** — §12. No
API change, no dialplan change, no PBX write, no migration.)
Izzy, 2026-08-24: *"Fix Up Group 101 is complaining that he had problems today
with the iPhone app."* ⛔ **The extension is 103 "Office", not 101** — T31 has no
101 in Connect or on the PBX. (Secro ext 103 is *named* "Fix Up Group" and is a
different, inactive record; T34_101 is RSBK.) Tenant `cmqr9cs9402qqs013m7p64lpi`,
PBX **T31**, user `fixupusa1@gmail.com`.

- ⛔⛔ **THE HEADLINE: on 6 of the 7 calls that rang him today, the PBX never
  dialled the iPhone at all.** Read from `connect-mobile-wake-dial:18
  Set(CONTACTS=…)`, the app contacts actually rung were the **desktop app** and the
  **Android** — never the iPhone. The one call where the iPhone was in the list
  (20:13 ET) was only because he had opened the app **5 seconds earlier**. The
  iPhone answered **zero** calls today, and in 14 days has accepted exactly one
  `CallInvite` — today's, which failed.
- ⛔⛔ **ROOT CAUSE, and it generalises to every tenant: the wake-and-wait hold
  is gated on the SHARED `_1` AOR, while sleeping is per DEVICE.**
  `connect-mobile-wake-dial:11` holds only while
  `DEVICE_STATE(PJSIP/T<t>_<ext>_1)` is `UNAVAILABLE` — the **app endpoint's
  own** state — and then commits a frozen contact list.
  ⛔ **CORRECTED 2026-08-25 (§12): the desk phone was over-blamed.** A desk
  phone ALONE would NOT disarm the hold (desk-only + sleeping iPhone →
  `UNAVAILABLE` → the hold engages); `connect-wake-core`'s per-extension `WARM`
  check only skips its own redundant grace loop. **What disarms it for Fixup is
  the desktop app and the Android sharing `T31_103_1`** — any always-on sibling
  app client keeps the AOR available, so the sleeping iPhone is never waited
  for and never in the frozen dial list.
  Verbatim on all 7 calls today: `connect-wake-core warm — live contact ext=103`
  then `connect-mobile-wake-dial dialing T31_103_1 after 0s`.
  ⛔ Across the whole PBX log (~2 days, ~230 wake-dials) the hold fired > 0 s
  **twice**. Any extension with a desk phone or a second always-on client has it
  silently disarmed.
- ⛔⛔ **THE FAILED ANSWER, TO THE SECOND (18:09 ET):** PBX commits its contact
  list at 18:09:39 (desktop + Android, no iPhone) → VoIP push delivered
  18:09:40.674 `expoStatus: "ok"` → iPhone `DEVICE_REGISTER_COMPLETE` at
  **18:09:43.9, 4.3 s after the PBX stopped looking** → he taps Answer 18:09:44.2,
  backend answers `INVITE_CLAIMED_OK` → the app waits **16.2 s** for a SIP INVITE
  that was never addressed to it → caller hangs up at 20 s. Blackbox:
  `sip_invite_not_received`, `incomingSessionCount: 0`, `candidates: []`,
  `answerAttempts: null`, `sipAnswer.sent: false`. **The 30-second ring had 26
  seconds of runway the PBX never used.**
- ⛔ **Why the iPhone has no contact: its registration lives a median of 33
  seconds** (n=18 over the full 15-day `PbxEndpointRegistrationEvent` retention;
  min 2 s, max 213 s) against **840 s** for his Android and **21 hours** for the
  office desktop on the same AOR. `qualify_frequency 30` / `qualify_timeout 3`, so
  the contact dies at almost exactly the first `OPTIONS` ping — iOS suspends the
  app, the WebSocket stops answering, Asterisk marks it Unreachable and stops
  dialling it. **That is normal iOS behaviour and is precisely what wake-and-wait
  exists to cover.**
- ⛔ **NOT the cause — checked, so nobody re-derives it.** **Not the push
  channel** (every call delivered `INCOMING_CALL_WAKE` + `INCOMING_CALL` to both
  iPhones, `expoStatus: "ok"`, on time). **Not the 2026-08-22 warm-answer-deadline
  regression** — that fingerprint is `answerAttempts: 1, pollIterations: 1,
  durationUntilFailureMs ≈ 641-745`; here `answerAttempts` is **null** and the
  failure took 16.2 s, i.e. the answer code never ran. ⛔ **Do not tell him to
  update the app for this.** **Not the two 2-second outbound calls at 20:25/20:26
  ET** — the PBX shows both answered by the far end and cleared with `Trunk
  Hangup`; test calls, not failures.
- ⛔ **`ConnectCdr.disposition: "answered"` is not proof a human answered** — four
  of today's calls read `answered` while the PBX log says `Nobody picked up in
  30000 ms → Leave Voicemail` (the IVR/voicemail answered). Only **2** voicemail
  recordings exist today. Use the `app_dial.c … answered` line.
- ⛔ **He is signed in on TWO iPhone 17 Pros** (iOS 26.6 and iOS 26.5.1, both
  created 2026-08-05, both pushed on every call) sharing one AOR with the desktop
  and the Android against `max_contacts: 5, remove_existing: true`. Both of
  today's `ANSWER_TAPPED action=DECLINE` taps came from the *other* iPhone while
  the first was showing the incoming screen — the two phones fight each other.
- ⛔ **Fixup Group is the LAST active iOS user still on the direct-to-PBX
  port-8089 route** (`webrtcRouteViaSbc: false`, `sipWsUrl:
  wss://209.145.60.79:8089/ws` — a raw IP that `normalizeSipWsUrlHost` serves as
  `wss://m.connectcomunications.com:8089/ws`, so no TLS-on-IP problem). B Visible,
  TYH, Hanna and Displaydex are all `via443: true`. Moving them is three fields
  and no deploy — but **it does not fix the hold gap on its own**; say so plainly.
- ⛔ **The identification trick worth keeping: `x-ast-orig-host=<id>.invalid` in a
  contact URI is the JsSIP instance id** and is stable per client install.
  Correlate it against `VoiceClientSession.startedAt` to say which physical device
  a contact belongs to — that is how the desktop, the Android and each iPhone were
  told apart on one shared AOR.
- ✅✅ **THE FIX IS BUILT AND DEPLOYED (`dc12d3c5`, 2026-08-25 — handoff §12):
  Mode-B learned the wake-dial leg shape, so a woken phone can JOIN a ring that
  is already up.** The late-join rescue existed all along — telephony's
  tap-triggered `requeueLiveCallToDialplan` Mode-B — and it **evaluated his
  exact 18:09 tap, found the fresh contact, and refused** on gates written
  before the wake-dial rollout (log preserved in §11: `not_direct_extension`,
  and `extLegAor` had captured the DESK AOR). Now: `resolveWakeDialLeg`
  (`wakeDialLeg.ts`, pure) derives the app AOR/ext/pbx from the wake channel's
  own name, the fresh-contact test runs against the **APP** AOR, and the
  redirect goes to the proven `T<pbx>_cos-all,<ext>` — ⛔ **the exten is the
  extension NUMBER from the wake leg, never `extLegDialExten`**, which for this
  shape is the endpoint name and would dead-end the redirect. **No API change**
  (`fallbackExten` already carries the invite's extension and pins which wake
  leg when several ring; ambiguity fails closed).
- ⛔⛔ **THE ANSWERED-GRACE IS LOAD-BEARING — never remove it.** Before ANY
  Mode-B redirect past a still-live extension leg, telephony waits
  `modeBAnswerGraceMs` (2.5 s) for a normal SIP 200 — a device answering the
  ordinary way (measured 300 ms–2.6 s) must never have its live INVITE torn
  down by a redirect racing its own answer; `extensionAnsweredAt` flipping
  during the grace stands the redirect down (`answered_during_grace`).
  ⛔ **Every historical Mode-B protection is unchanged and test-pinned**:
  `invite_accept` only (the 2026-06-28 revert), fresh-contact-not-dialed only,
  one-shot per call, `extensionAnsweredAt` dominates, ring-group/queue trunk
  positions excluded (the RSBK loop stays impossible — the wake shape also
  requires the trunk's own Dial position to be `*local-dialing*`).
- ✅ **Proven: 12 tests (`wakeLegRedelivery.test.ts`) driving the real service
  against the real CallStateStore/registry, rebuilt from the production call's
  own DialBegin shapes; 3 of 12 FAIL replayed against `HEAD`** (the rescue, the
  grace, the one-shot) while every safety test passes on both trees. Suite
  225/228 (the 3 documented smarthome `JWT_SECRET` artifacts — and
  `requeueTestEnv.ts`'s seed was lengthened to ≥32 chars, which is why it is no
  longer 4); typecheck 41 = the exact baseline. Container-verified: clone at
  `dc12d3c5`, `resolveWakeDialLeg` + `answered_during_grace` grepped in the
  running container's **src** (telephony runs from src via tsx), 0 restarts,
  AMI/ARI reconnected, 0 error lines, deployed at 0 active calls.
- ⏳ **NOT PROVEN: no real call has exercised the rescue.** Acceptance is the
  next inbound call he answers on the iPhone from a sleeping state — check
  `docker logs app-telephony-1 | grep -a "AMI mobile invite requeue sent" | grep wake_leg`;
  the negatives that matter: `answered_during_grace` rows when a desk/app
  answers normally, and NO `wake_leg` redirect ever on a ring-group call.
  ⏳ Registration-triggered join (INVITE the phone the moment it re-registers,
  before any tap — native ring instead of tap-and-wait) is designed, NOT built.
  Still worth doing regardless: **sign out one of his two iPhones** (they fight
  each other for AOR slots and both got pushed on every call).
- ✅✅ **THE DESK-ANSWERS-FIRST RACE IS CLOSED TOO (`f17f507a`, api — handoff
  §13, Izzy's follow-up "it would freeze on them until somebody already
  answered").** Three of four layers already existed (SIP CANCEL + the
  2026-07-30 VoIP cancel pushes dismiss an un-tapped ring; a tap after the
  cancel refuses at the claim; the dc12d3c5 answered-grace keeps the redirect
  off the desk's live call). ⛔ **The gap: the answered_elsewhere/hungup/
  voicemail sweep only canceled PENDING invites — a tapped invite is ACCEPTED,
  so the phone that tapped and LOST froze on "Connecting…" for its full 16 s
  budget.** The sweep now runs a second pass over **ACCEPTED + `endedAt` null**
  (claimed, never connected) and pushes INVITE_CANCELED at the loser, stamping
  `endedAt` as the one-shot loss marker (nothing else writes it on CallInvite).
  ⛔ **The safety ladder is the point**: the Hanna own-app guard dominates the
  loss push too (a shared-AOR sibling's win deliberately falls back to the 16 s
  give-up — pushing there could kill the sibling's live answer on pre-guard app
  builds); `input.answered` skips the pass on hungup/voicemail so a normally
  completed call never gets a cancel push at its winner; and the client cancel
  handler ignores cancels for calls with a CONFIRMED session. Also covers
  caller-gives-up-while-claimed and voicemail-divert-while-claimed. 4 new
  source guards (13/13; **all 4 fail against HEAD**); api typecheck 76 =
  baseline. ⏳ Acceptance:
  `docker logs app-api-1 | grep "claimed-but-unconnected invite lost"` on the
  next real desk-first race.
- ⚠ **Noticed, NOT touched:** the desk phone `T31_103` holds a contact at
  **159.89.179.105 — DigitalOcean**, which is odd for a desk phone and worth one
  question.
