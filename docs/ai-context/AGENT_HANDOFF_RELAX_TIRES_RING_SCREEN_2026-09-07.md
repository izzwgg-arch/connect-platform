# AGENT HANDOFF — Relax Tires ext 101 "vibrating, not ringing, no incoming-call screen" (2026-09-07): the ring reaches the phone in half a second, the SCREEN stopped taking over on 2026-08-31, and the one fact that decides why never leaves the handset

**Read-only investigation — no code change, no deploy, no PBX write, no data change, no
customer contacted.** Everything below was read live on 2026-09-07 between 21:00Z and
21:45Z from Connect's Postgres, the api container log, the PBX `/var/log/asterisk/full`,
the app's own flight recorder rows, and the Android source at HEAD `cb70a2ab`.

Izzy, 2026-09-07: *"Relaxed Tires 101 is complaining again that his phone is vibrating
and not ringing, and he doesn't get an incoming call screen … We turned off the virtual
extension, and he still has the same issue … do not come back to me until you have proof."*

Tenant `cmnlgryme000up9paz1w40fg0` (Relax Tires), PBX **T25**, ext 101 "S M Weiss",
user `relaxtires@gmail.com` (`cmnmjhlu3004xp96hv4g49htg`), device row
`cmt69ey2d1p3tph13t2hjsida` (Samsung SM-S938U, Android **16**, T-Mobile), app
`1.0.0+20260823-175041` (the current sideloaded fleet APK — NOT the Play build).
Earlier rounds: `AGENT_HANDOFF_RELAX_TIRES_APP_RING_2026-08-27.md`,
`AGENT_HANDOFF_HIGH_PRIORITY_PUSH_CENSUS_2026-09-01.md`.

---

## 0. The answer in one paragraph

The virtual extension was never the cause and removing it changed nothing: the PBX dial
string is `PJSIP/T25_101&Local/T25_101_1@connect-mobile-wake-dial/n` (cell leg gone),
the app leg is dialled after 0 s and answers 180 Ringing at once on every call, and the
server hands the ring push to Google ~0.9 s after the call starts. **On the handset, the
native ringtone + vibration start ~0.5 s after the call (proven by the app's own
native-stamped `RINGTONE_START`), so the phone IS being rung by Connect — the vibration
he feels is our ring.** What no longer happens is the **screen takeover**: the Connect
incoming-call screen only appears **5–26 s later**, always after a human action (tap the
notification, or open the app), and he answers within ~1 s of it appearing. **On
2026-08-28 the same phone auto-launched the screen 2.9–5.5 s after the ring on 4 of 4
calls; from 2026-08-31 onward it has auto-launched on 0 of 21.** The only code path that
takes the screen over is Android's full-screen intent, which the OS honours only when the
handset's **"Allow full screen notifications" (USE_FULL_SCREEN_INTENT) special access is ON
for Loopcom** and the phone is locked/screen-off. Android's own doc says that when it is
OFF the notification is shown as *"persistent heads-up with pill buttons for 60 s in every
device state (unlocked, locked, screen off)"* — which is byte-for-byte the pattern in the
flight data since 08-31. That toggle's state is **never uploaded by the app**, so it is the
one fact this investigation cannot read from the server; §6 says how to read it in 30
seconds and how to make it provable forever. A second, rarer mechanism (§4) — Android
holding the ring push itself for minutes — hit 1 of 8 calls today and is documented
separately; it is NOT what he is describing.

---

## 1. What "vibrating and not ringing" is

`IncomingCallFirebaseService.onMessageReceived` → `startIncomingCallRingtone()` runs BEFORE
any UI decision (line ~487). His ringtone preference is **classic** (the flight recorder
shows `source: "system_fallback"` on every call), so the app plays **the phone's own default
ringtone through `RingtoneManager` on `STREAM_RING`** and starts the vibrator pattern
(`startIncomingVibration`, skipped only in RINGER_MODE_SILENT). That is the same stream and
the same ringer-mode rules as a carrier call. **If the phone is on vibrate, or the ring
volume is down, it vibrates and does not ring — exactly like every other call on that
handset.** Nothing in Connect decides that. The flight recorder proves the native ring
started on 21 of the 23 incoming calls since 08-31 that produced a session (the two without
a `RINGTONE_START` are the held-push case in §4 and the second leg of an overlapping call).

## 2. The ring reaches the phone on time — measured, not inferred

All timestamps are the device's own clock (native `System.currentTimeMillis()` read off the
`IncomingCallUi.getRingtoneTimings()` bridge) or the api log. Today's answered calls:

| Call (UTC) | Invite created | Native ring started | Δ | Screen appeared | Ring→screen | Tap after screen |
|---|---|---|---|---|---|---|
| 12:39 | 12:39:20.69 | 12:39:25.1 | 4.4 s | 12:39:32.76 | 7.6 s | 1.1 s |
| 14:06 | 14:06:12.15 | (not in session) | — | 14:06:30.20 | 17.7 s from ring | 0.8 s |
| 15:32 | 15:32:24.95 | 15:32:25.47 | 0.5 s | 15:32:35.18 | 9.7 s | 0.8 s |
| 18:43 | 18:43:24.62 | 18:43:25.22 | 0.6 s | 18:43:36.09 | 10.9 s | 0.9 s |
| 19:46 | 19:46:09.28 | 19:46:09.83 | 0.55 s | 19:46:17.99 | 8.2 s | 0.8 s |
| 20:40 | 20:40:34.26 | 20:40:34.78 | 0.5 s | 20:40:41.87 | 7.1 s | 2.5 s |
| 21:08 | 21:08:44 | ring 4.0 s | — | answered from the notification's Answer pill (`intent_answer:onCreate`) | 4.1 s | 0.1 s |

Server side for the same calls: telephony prewake → `FCM_DIRECT_DELIVERED` (WAKE) → the
device acks `DEVICE_PUSH_RECEIVED` in **727 ms** (20:46 call); ring-notify →
`FCM_DIRECT_DELIVERED` (INCOMING_CALL) **0.9 s** after the invite row. The PBX
(`/var/log/asterisk/full`) on every call: `connect-wake-core warm — live contact` →
`dialing T25_101_1 after 0s` → `PJSIP/T25_101_1-… is ringing` in the same second → the
ring timer is the ring group's **30 s** (`Dial(Local/101@T25_ring-group-dial/n,30,…)`).

So the whole chain — PBX → api → Google → handset native layer → ringtone/vibrator — is
complete inside ~1 s. **The 09-01 handoff's "Android delays the ring push 7.5–29 s" was
wrong for the ordinary case**: the field it measured (`pushReceivedAt` on `UI_SHOWN`) is
stamped by JavaScript when the incoming-call URL is parsed at app launch
(`NotificationsContext.tsx:501`, `_pushReceivedAt: Date.now()`), i.e. it measures **when
the JS screen came up**, not when the push arrived. The native `_storedAt` in the cache
file and the native ring timestamp are the honest ones, and they say ~0.5 s.

## 3. The screen stopped taking over between 2026-08-28 and 2026-08-31

Ring-start → Connect-screen gap, every incoming call with a flight session, and how the
answer was delivered (`intent_answer:onNewIntent` = the activity already existed when he
pressed Answer, i.e. the full-screen launch had already created it; `onCreate` = the
activity did NOT exist, his tap created it; `js_stop_ringtone` = he tapped Answer inside
the Connect screen):

| Day | Calls | Ring→screen | Answer path |
|---|---|---|---|
| 08-28 | 4 | **2.9 / 3.5 / 3.5 / 5.5 s** | `onNewIntent` ×2, in-app ×1, decline ×1 |
| 08-31 | 5 | 12.2 / 18.8 / 5.1 / 26.1 / 6.9 s | in-app |
| 09-01 | 8 | 5.5 / 13.9 / 11.6 / 6.1 / 8.9 / 17.7 / 6.8 / 5.2 s | in-app ×6, `onCreate` ×2 |
| 09-02 | 3 | 11.2 / 7.1 / 4.9 s | in-app ×2, `onCreate` ×1 |
| 09-03 | 1 | 21.1 s (caller gave up at 26.7 s) | none |
| 09-04 | 2 | 4.4 / 3.9 s | `onCreate` ×2 |
| 09-07 | 8 | 7.6 / 17.7 / 9.7 / 10.9 / 8.2 / 7.1 / 4.1 s (+ one held push, §4) | in-app ×6, `onCreate` ×1 |

Read that table as a device state, not as network weather: a React Native cold boot on an
S25 Ultra is ~3 s (the 08-28 numbers), and it does not vary between 4 s and 26 s. A gap
that wide with a ~1 s tap after it is a **person noticing a vibrating phone, picking it up
and tapping** — and `onCreate` on every notification-answer since 08-31 (vs `onNewIntent`
on 08-28) says the activity was never launched for him first. Two more independent
tells from the same rows: `PUSH_RECEIVED_FG` carries `appState: "background"` on four of
the calls (JS alive, invite set, screen NOT in front), and `INCOMING_INVITE source:
native_cache` with `nativeAge` 9–14 s on the calls where the app booted late — the native
layer had the call for 9–14 s before JS looked at it.

**Nothing on our side changed between 08-28 16:05Z and 08-31 12:31Z**: same APK
(`1.0.0+20260823-175041` on every `SESSION_START`), same device row (created 08-23), same
dial string, same api build for the ring path (`c16ce81c` came on 09-02). The change is on
the handset.

## 4. The second mechanism — the ring push held for minutes (rare, real, separate)

Call `1788813966.86522` (20:46Z, caller 845-500-2930, went to voicemail):

- 20:46:06.98 telephony prewake → 20:46:07.27 FCM accepted WAKE → **20:46:08.07 device
  acked it (727 ms)**; app state `FOREGROUND_SERVICE`, SIP already registered.
- 20:46:22.60 ring-notify → invite created → **20:46:23.46 FCM accepted INCOMING_CALL**.
- 20:46:23.20 the SIP INVITE reached the app's JavaScript (`INCOMING_INVITE source:
  sip_state`) and the PBX logged `PJSIP/T25_101_1 is ringing` — socket alive, JS alive.
- 20:46:52 the 30 s ring timer expired → voicemail. **No `RINGTONE_START` was ever
  recorded for this call** — the native handler never ran.
- **20:49:08 (165 s after Google accepted it)** the push finally landed; the app drew a
  ring screen for a call dead for 2 min 16 s (`PUSH_RECEIVED_FG appState background`, then
  `APP_FOREGROUNDED backgroundedForMs 283359` — he had just opened the app).

So the push sent 15 s before it arrived in 0.7 s, and this one was held on-device for
~165 s while the phone's own WebSocket was passing SIP traffic. That is Android holding a
high-priority data message (the standby-bucket / Doze demotion the 09-01 census
describes), not the network and not our send: `fcmDirect.ts` sends every ring push
`android: { priority: "HIGH", ttl: "45s" }` (line 145) — a message delivered at 165 s
against a 45 s TTL can only have been sitting inside Google Play Services on the phone.
The 09-02 wake gate did fire on this call (`WAKE_SUPPRESSED_DUPLICATE` ×2), and the
watchdog still queued **247 recovery wakes on 09-05** while the phone sat unregistered all
Shabbos (`CallWakeEvent WATCHDOG_REREGISTER_PUSH_QUEUED`, now NORMAL priority). Frequency:
1 of 8 calls today; 08-31 20:02 and 22:04 were the same shape. **When this happens there
is no vibration at all** — so it is not the complaint in the title, and it must not be
confused with it.

## 5. Why the screen needs the full-screen permission (code, not theory)

`launchIncomingCallUi` (IncomingCallFirebaseService.java ~1600–1755) posts ONE
`CallStyle` notification with `setFullScreenIntent(fullScreenIntent, true)` and, only when
`shouldUseFullScreenUi()` says the device is locked or the screen is off, additionally
calls `triggerFullScreenIntent()` (a `PendingIntent.send()` from a service — a background
activity start, which Android 14+ refuses for a non-visible app, so in practice the
system's own FSI launch off `notify()` is the path that works). The comment at ~1710 says
it in so many words: *"if USE_FULL_SCREEN_INTENT is not granted it is always demoted to a
heads-up."* The manifest declares the permission (`AndroidManifest.xml:21`), `MainActivity`
carries `showWhenLocked` + `turnScreenOn` (line 78), and targetSdk is **36**. Android's
rule (source.android.com, *Full-screen intent limits*): granted by default on install
(sideloaded included), **the user can turn it off** under Settings → Apps → Special app
access → *Manage full screen intents* (Samsung: Settings → Notifications → Loopcom →
*Allow full screen notifications*), and when it is off the notification is shown as *"a
persistent heads-up notification with pill buttons for 60 s"* in **every** device state.

The app knows this and has a one-shot nudge for it — `useFullScreenCallPermissionPrompt.ts`
shows *"Allow full-screen calls"* **once per install** (`cc_fsi_onboard_prompted_v1`); a
single "Not now" and it never asks again. The Diagnostics screen shows the state
(`DiagnosticsScreen.tsx:426` — *"Revoked — call screen will not appear over lock"*), but
⛔ **nothing in the shipped app navigates to `Diagnostics`** (the route is registered in
`RootNavigator.tsx:413` and no screen links to it), so the customer cannot see it either.
And ⛔ **none of it is uploaded**: `getCallWakeDiagnostics()` carries
`lastIncomingUiPresentation` ("full_screen" | "heads_up") and `canUseFullScreenIntent()` is
a bridge call, but the register payload (`client.ts:905`, `headlessDeviceReport.ts`) sends
only the keep-alive block — `MobileDevice.keepAliveSnapshot` for this device holds
`isRunning/gateNeeded/…` and nothing about presentation or FSI. The 08-27 handoff already
named this hole ("the diagnostics that would settle it never leave the phone"); this is
the case it was written for.

⛔ **Ruled out, so nobody re-derives them:** the virtual extension (gone from the dial key,
verified on the PBX); the wake hold (`warm — live contact` on every call, 0 s hold); FCM
token/device rows (one active row, native FCM token present, `lastPushStatus ok`); the PBX
ring timer (30 s, ring-group); DND (`CustomDevstate/T25_DND_101 = UNAVAILABLE` = off); the
Play-Store build (he is on the sideloaded APK, whose FSI is granted by default unless
turned off); server-side push lateness (FCM accepts in ~0.9 s on every call today).

## 6. What settles it, and what to build so it never needs settling by hand again

**30-second check on the handset (either one):**
1. Settings → Notifications → App notifications → Loopcom → **Allow full screen
   notifications** (Samsung wording; stock Android: Settings → Apps → Special app access →
   Manage full screen intents → Loopcom). Expected: **OFF** since ~08-29/30. Turn it ON.
2. While there: the Loopcom notification categories — *Incoming calls* must be "Alert /
   pop-up", and Battery must be **Unrestricted** (the §4 hold is the other half).

**The code change that makes this provable from the server (NOT built — an app build,
Izzy's call):** upload `canUseFullScreenIntent`, `lastIncomingUiPresentation`,
`areNotificationsEnabled`, the incoming-calls channel importance, `batteryOptimizationIgnored`
and the ringer mode with every `/mobile/devices/register` (the server patch-skips absent
blocks, so it is additive) and stamp `lastIncomingUiPresentation` into the flight session
at `PUSH_RECEIVED_FG`. With that, the acceptance metric is one query per call:
`presentation = full_screen` and ring→screen ≈ 3 s. The **product** fix is in the same
build: re-prompt for the permission while it is off (daily, not once per install) and show
a persistent in-app banner — the customer should be able to fix this himself without a
support call.

## 7. Queries and recipes that reproduce this

- Flight sessions (the decisive data):
  `select "inviteId","startedAt",events from "CallFlightSession" where "userId"='cmnmjhlu3004xp96hv4g49htg' and "startedAt" > now() - interval '10 days' and "inviteId" is not null order by "startedAt";`
  then per row: `RINGTONE_START.tsMs` (native) vs `INCOMING_SCREEN_SHOWN.tsMs` vs
  `ANSWER_TAPPED.tsMs`, and `RINGTONE_STOP.payload.reason`.
- Server push hand-off: `docker logs app-api-1 --since <date> | grep -E "<pbxCallId>" | grep -E "FCM_DIRECT_DELIVERED|DEVICE_PUSH_RECEIVED|mobile-ring-notify"`.
- Device-side push receipt for the ring push is the native cache: `INCOMING_INVITE source:
  native_cache` carries `nativeAge` = now − `_storedAt` (native receipt time). ⛔ Never use
  `UI_SHOWN.pushReceivedAt` as push receipt — it is a JS launch stamp.
- PBX: `asterisk -rx "database showkey dial" | grep T25_101` for the dial string;
  `grep -a "2026-09-07 HH:MM" /var/log/asterisk/full | grep -aE "app_dial|connect-wake-core:(9|13|33)\]|wake-dial:(20|21)\]"` for the app leg.
