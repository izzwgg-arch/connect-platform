# ⛔⛔ AGENT HANDOFF — Relax Tires "it only rang my cell, not the app": the PBX rang the app on EVERY call for 24 days, and the app rebuilds its SIP stack every 10 minutes (2026-08-27) — READ FIRST for ANY "the app didn't ring" report, before trusting a VoiceDiagEvent gap, or before moving a cellular tenant to the 443 route

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_RELAX_TIRES_APP_RING_2026-08-27.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change, no config
touched.**) Izzy, 2026-08-27: *"relax tires just had more problems with the incoming calls …
On the Android app, he said it only rang his cell phone, which is the virtual extension.
Usually, they ring both."* Tenant `cmnlgryme000up9paz1w40fg0`, PBX **T25**, ext 101
"S M Weiss", user `relaxtires@gmail.com`.

- ⛔⛔ **THE COMPLAINT'S OWN SIGNATURE DOES NOT EXIST IN THE DATA.** Over 30 days, on every
  call where the cell leg was dialed, the app leg was dialed too — `app_MISSING` is **0 every
  day from 2026-08-03 onward** (the only misses are 07-28/29/31, before his 08-23 re-login).
  The one-query test: `ConnectCdr."channelsSeen"::text like '%T25_101_1%'` on the **outgoing**
  row to the cell number `8455129339`, which pairs the two legs of one call.
- ⛔ **And the app leg does not merely get dialed — it answers `180 Ringing`.** Today's
  08:33:56 EDT call: `PJSIP/T25_101_1-00003f6b is ringing` **and**
  `Local/8455129339@T25_cos-all is ringing`, then `Nobody picked up in 30000 ms`. Today's
  13:43 call went further — push → invite → **ACCEPTED on the app in 4.5 s**
  (`invite fulfilled by its own app — no cancel push`). Push is healthy on BOTH channels
  (`FCM_DIRECT_DELIVERED` + Expo `ok`, `DEVICE_PUSH_RECEIVED` ack in **70 ms**).
- ⛔ **Ext 101 has THREE devices and the desk phone is DEAD — so "both" means APP + CELL.**
  `PJSIP/T25_101` has **never registered** (0 events in the 15-day retention, 0 contacts), so
  every Relax Tires call logs `Unable to create channel of type 'PJSIP' (cause 3 - No route to
  destination)`. **That NOTICE is the dead desk phone, not a fault** — do not chase it.
  Dial string is correct: `PJSIP/T25_101 & Local/T25_101_1@connect-mobile-wake-dial/n &
  Local/8455129339@T25_cos-all`; wake-enrolled, `MAX_WAIT=20` against `ringtimer 30` —
  ✅ **correctly sized**, not the `followme/ringtime` clipping trap.
- ⛔⛔ **WHAT IS ACTUALLY WRONG: the app rebuilds its ENTIRE SIP stack every ~10 minutes.**
  ~130–160 REGISTERED **and** ~130–160 UNREACHABLE per day, and **the SIP username changes on
  every re-registration** (`29touipr` → `js5tmnao` → `tq4r5juv` → `s93okd57`…) — per the
  Gesheft 101 rule, a plain re-REGISTER keeps its contact URI, so a **new contact user means a
  NEW UA**. Measured dark time: **33–46 minutes a day (~3%)**, in gaps up to **6 minutes**,
  plus a **28-hour total outage 08-21 21:15 → 08-23 01:13 UTC**. Network is **T-Mobile USA
  cellular** (whois `TMO9` on `172.56.166.134`), tenant is on the **direct :8089 route**.
  ✅ **ONE device, not siblings** — `x-ast-orig-host=4pqif3nji323.invalid` is identical on
  every registration, so the Fixup Group "an always-on sibling disarms the wake hold"
  mechanism does **not** apply here.
- ⛔ **The churn did not cause any observed miss, and that was checked, not assumed:** for all
  **46** rings in 10 days the endpoint's most recent registration event at invite time was
  **`REGISTERED`** — every one. Not a single ring landed in a dark window.
- ⛔⛔ **THE TRAP THAT WOULD HAVE PRODUCED A CONFIDENT WRONG ANSWER: this device's
  `VoiceDiagEvent` telemetry is ~75% LOSSY.** It reads `INCOMING_INVITE` **32** against **46**
  rings and `UI_SHOWN` only **8**, which looks exactly like "the app never got the INVITE".
  It is not — **of the 8 calls the app demonstrably ANSWERED (`CallInvite.status = ACCEPTED`,
  which only the app can produce), only 2 carry an `INCOMING_INVITE` event.** The gap measures
  telemetry loss, not ring failures. **Sanity-check any telemetry gap against a case you KNOW
  succeeded before reporting it.**
- ⛔ **Method traps, each of which produced a wrong answer first:** `ConnectCdr.startedAt` is
  naive UTC so `at time zone 'America/New_York'` **adds** 4 h (real EDT = displayed − 8h);
  the CDR `startedAt` is when the call hit the **IVR**, and ext 101 is dialed only when the
  caller picks an option (**42 s later** on the 13:43 call — not a delay); the DID goes
  **IVR-43 → ring group "New Tires" → ext 101**, so many `app_leg=false` calls never reached
  101 at all and the cell did not ring either — **require a paired outgoing CDR to
  8455129339 before calling an `app_leg=false` call a miss**; and ⛔ **do NOT grep the api log
  by `pbxCallId`** — several `[CALL_WAKE]` lines (incl. `FCM_DIRECT_DELIVERED`) carry no such
  field, and the control test (a call whose lines I had already read) returned **0**.
- ⛔ **He is on the CURRENT fleet APK** (`1.0.0+20260823-175041`, i.e. he already has the
  warm-answer-deadline fix) — **do not tell him to update.** Fleet context: T25_101_1 is
  **6th of 20** app endpoints by 24 h churn (395 events vs a mean of 347); T34_102_1 is 2661.
  This is the ordinary cellular-CGNAT class, not a new fault.
- ⚠ **TWO `active` MobileDevice rows for ONE phone**, so **every push is sent twice** (one to
  a dead install): `cms4omoi01jmoro12bzrood5x` (deviceId `mobile-android-ms4omoaw-7tfv0exl`,
  last seen 08-23 20:15) and the live `cmt69ey2d1p3tph13t2hjsida` (created 08-23 20:28).
  Different deviceIds **and** different tokens, so the `@@unique([userId, deviceId])` dedupe
  never matched. Harmless but noisy; deactivating the stale row is a one-row update —
  **not done, needs Izzy's word.**
- ⚠ **Do NOT reflexively move this tenant to the 443 SIP route.** That fix is for *filtered*
  internet (blocked ports); his contact IP is plain T-Mobile cellular and his registrations
  succeed. The churn is CGNAT idle-timeout on **his** side of the NAT, which 443 does not
  obviously fix. It is an experiment, not a known remedy, and it costs him a sign-out/sign-in.
- ⏳ **NOT PROVEN, and it is the whole gap: I could not identify the specific failed call.**
  No timestamp was supplied, today's three calls all rang the app correctly, and **the api
  container was recreated at 18:04 UTC by another session's deploy, which wiped `docker
  logs`** — while `/var/log/asterisk/full` holds **today only**. Two possibilities remain and
  the data cannot separate them: **(1)** he answered on the cell (it rings instantly over PSTN
  while the app needs push → wake → render; 38 of 46 rings ended CANCELED), or **(2)** the app
  got the INVITE and never alerted him — the Android ring **screen is push-driven**, so the
  SIP stack can answer 180 while no screen or sound reaches the user, which is invisible from
  the server.
- ✅✅ **ANSWERED SAME DAY — he answered on the CELL, and the app later showed a STALE ring
  screen. The cause is that BOTH LEGS LAND ON ONE HANDSET (handoff §9).** The cell forward
  rings the same physical phone the app is installed on, so the carrier call takes the screen
  and the ringer and Connect's ring is never noticed.
  ⛔⛔ **I first blamed Android Telecom arbitration (a self-managed `ConnectionService`
  refused while a carrier call is up) and that was WRONG — read the code before asserting it.**
  That path exists (`TelecomBridge.startIncomingCall`, `CAPABILITY_SELF_MANAGED`) but is
  **disabled behind `if (false)` since 2026-05-07**, deliberately; `isIncomingCallPermitted` is
  called **nowhere** in the repo.
  ⛔ **What actually presents a call is a CallStyle notification + full-screen intent, and the
  code states its own limit** (`IncomingCallFirebaseService.java:1713`): *"the OS only launches
  the full-screen intent when the device is **locked / screen-off**; while the device is
  unlocked and interactive it is shown as a **floating heads-up notification** instead."* So on
  an in-use phone Connect's ring is a **banner competing with the native incoming-call screen**.
  ⛔ **And the ringtone is on `STREAM_RING`** (`USAGE_NOTIFICATION_RINGTONE`) — the same stream
  the carrier ringer uses and the one Android silences at `MODE_IN_CALL`, so answering the cell
  kills Connect's ringtone outright.
  ⛔ **The app checks native cellular call state NOWHERE** — `inActiveCall` is set only from JS
  and means Connect's OWN call; there is no `TelephonyManager`/`getCallState()` anywhere in the
  Android source, so the app cannot know it is competing and cannot adapt.
- ⛔ **The stale screen PROVES the push landed:** `writeCacheFile()` persists every incoming
  push to **`pending_call_native.json`** and JS replays it via `readCachedInvite()`
  (`NotificationsContext.tsx:689`), so a stale ring screen on next open means the phone had the
  invite all along. It is never a lost push.
- ⛔⛔ **THE MEASUREMENT: of 38 cancelled rings in 10 days, 20 (53%) lasted UNDER 10 SECONDS
  and 9 under 5** — commonest value **5 s**, mean 17 s (the 31–44 s tail is calls nobody
  answered). **A heads-up banner behind a native call screen, for five seconds, is
  indistinguishable from never ringing.**
- ⛔⛔ **THE DIAGNOSTICS THAT WOULD SETTLE THIS NEVER LEAVE THE PHONE.**
  `emitCallFlowNative()` (`IncomingCallFirebaseService.java:527`) ends in **`Log.i(...)` and
  nothing else** — so `incoming_call_ui_displayed`, `NATIVE_NOTIFICATION_POSTED`,
  `RINGTONE_START`, `preferFullScreen`, `channelImportance` and **`canUseFullScreenIntent`** are
  logcat-only. **The whole class "the push arrived, the app had it, the user saw nothing" is
  structurally invisible from the server.** ⏳ Uploading those few fields with the existing
  quality report would make it diagnosable — not built.
- ✅✅ **THE REAL FIX IS ON THE PBX: stop ringing both legs simultaneously.** Ext 101's dial
  string fires all three legs at once, so the carrier call hits the handset at the same instant
  as the app push. Ring the **app alone for ~10 s, then add the cell** — the app gets an
  uncontested window and the cell stays as backup. ⛔ **PBX change, needs Izzy's mandate — NOT
  done.** The 2-minute proof first: one test call with the cell leg removed from ext 101.
  ⚠ **Phone-side settings cannot beat a native call screen** — full-screen-intent permission
  and channel importance are worth setting but must not be presented as the fix.
- ⛔⛔ **"HE NEVER HAD A PROBLEM, IT'S BEEN LIKE THIS FOR MONTHS" IS NOT WHAT THE DATA SAYS —
  AND THE CELL FORWARD IS WHY NOBODY NOTICED (handoff §10).** `CallInvite.status='ACCEPTED'`
  can only be produced by the app claiming an invite, so the ACCEPTED share per week is a clean
  "did he answer on the app" series — and it is written by `mobile-ring-notify`, a **different
  pipeline from the CDR**, so it is trustworthy this far back. It reads: **May 55–79%, June
  35–45%, then a collapse in early July (07-06 12%, 07-13 2%), then ZERO of 83 consecutive
  rings across the weeks of 08-10 and 08-17, then 36% from 08-24.**
- ⛔⛔ **THE CELL FORWARD DID NOT EXIST BEFORE 2026-07-27** — first ever leg to `8455129339` is
  `2026-07-27 14:11:55`, and there is no earlier forward number on the tenant. So: the app fails
  from early July → calls are genuinely MISSED → the forward is added on 07-27 (⚠️ very likely
  as the workaround, stated as the natural reading of the dates, not as fact) → from then on
  **every call is answered on the cell and the total app failure produces no complaint** → he
  re-signs in 08-23 and the app comes back → he starts noticing what it still loses.
  ⛔ **THE LESSON: a forward-to-cell is an excellent workaround and a perfect blindfold. When an
  extension has one, NO call is ever missed, so the app-answer rate is the ONLY thing that can
  tell you the app is dead.** ✅ Worth a per-tenant weekly metric — it would have caught this in
  July; not built.
- ⛔ **DO NOT read leg composition from the CDR before August on this account** — per-week
  `channelsSeen` shows 0 app legs before 07-27 and inbound jumping ~15→~74/wk. That is the
  **documented CDR-loss bug**, backfilled for **Aug 1–4 only**, not an app-leg trend.
- ✅ **CURRENT STATE: the app is NOT broken.** This week it answered **8 of 22** rings in
  **4, 4, 4, 5, 6, 12, 13, 20 s**. Of the 13 cancelled, four ran 31–44 s (nobody answered —
  ordinary timeout) and **eight were cancelled in 2–12 s, i.e. the cell was picked up first.**
  What remains is the one-handset race, not a fault.
- ⏳ **The cause of the July–August failure is NOT established and probably never will be** —
  `PbxEndpointRegistrationEvent` retains **15 days** and api `docker logs` are wiped by every
  deploy. Visible: **28 h totally dark 08-21 21:15 → 08-23 01:13 UTC** + 112 min on 08-20, and
  recovery coincides with the re-login. ⛔ **The 08-22 warm-answer-deadline regression is NOT
  the explanation — it postdates the 0% week of Aug 10. Do not invent a cause; say the data
  does not survive.**
- ✅ **The two cheap next steps, in order:** (a) **get the time of the call — it is
  perishable**, the PBX log holds today only; (b) ask him the one question that separates the
  two branches: *did the phone show a Connect incoming-call screen at all?* Then, on the
  device, put Connect in Samsung's **Never sleeping apps** (a throttled keepalive service is
  the classic cause of exactly this 10-minute rebuild pattern).
