# Relax Tires ext 101 — "it only rang my cell, not the app" (2026-08-27)

**Read-only investigation. No code, no deploy, no PBX write, no data change, no config touched.**
Every fact below was read live on 2026-08-27 from the PBX (`209.145.60.79`) and Connect's
database/logs on loopcom (`45.14.194.179`). Both clocks agreed (17:47 UTC = 13:47 EDT).

Izzy, 2026-08-27: *"relax tires just had more problems with the incoming calls … On the
Android app, he said it only rang his cell phone, which is the virtual extension. Usually,
they ring both."*

---

## 1. The account, so nobody re-derives it

| | |
|---|---|
| Connect tenant | `cmnlgryme000up9paz1w40fg0` "Relax Tires" |
| PBX tenant | **T25**, AstDB hash `fcab1cd3482527c3` |
| Main DID | (845) 776-1765 |
| User | `relaxtires@gmail.com` (`cmnmjhlu3004xp96hv4g49htg`), role USER, last login 2026-08-23 |
| Phone | Samsung **SM-S938U**, Android 16, app `1.0.0+20260823-175041` (**the current fleet build**) |
| Network | **T-Mobile USA cellular** — contact IP `172.56.166.134`, whois `TMO9 / T-Mobile USA, Inc.` |
| SIP route | **direct to the PBX on :8089** (`webrtcRouteViaSbc: false`, `sipWsUrl wss://m.connectcomunications.com:8089/ws`) |

**Extension 101 "S M Weiss" has THREE devices** (`ombu_devices`, tenant 25):

| device_id | technology | user | what it is |
|---|---|---|---|
| 209 | pjsip | `101` | desk phone — **has NEVER registered** (0 events in the 15-day retention; AOR `T25_101` holds 0 contacts) |
| 210 | pjsip | `101_1` | the Android app |
| 211 | virtual | — | the cell forward to **845-512-9339** |

⛔ **So "both" means the APP and the CELL.** There is no working desk phone and there has not
been one for at least 15 days — do not chase it as the missing leg.

Live dial string (AstDB `/fcab1cd3482527c3/extensions/101/dial`) — **correct, all three legs**:

```
PJSIP/T25_101 & Local/T25_101_1@connect-mobile-wake-dial/n & Local/8455129339@T25_cos-all
```

Ext 101 is wake-enrolled (`/connect/wake_canary/T25_101 : 1`), `ringtimer 30`,
`followme/ringtime 30`, wake hold `MAX_WAIT=20`. ✅ **20 < 30, so the hold is correctly sized
for this extension** — this is NOT the `followme/ringtime` clipping trap from the
2026-08-06 answer-unacked handoff. No diversions/DND are enabled on 101.

Other extensions: 1002 "Screening" (virtual → 5622096644) and 1003 "test" (never registered).

---

## 2. THE HEADLINE — the PBX rang the app on EVERY call, and the app leg really rang

⛔⛔ **The complaint's own signature — "the cell rang and the app did not" — does not exist in
the data.** Over 30 days, for every call where the cell leg was dialed, the app leg was dialed
too:

```sql
select date_trunc('day', c."startedAt") as day,
       count(*) as cell_rang,
       count(*) filter (where c."channelsSeen"::text like '%T25_101_1%') as app_also_rang,
       count(*) filter (where c."channelsSeen"::text not like '%T25_101_1%') as app_MISSING
from "ConnectCdr" c
where c."tenantId"='cmnlgryme000up9paz1w40fg0'
  and c.direction='outgoing' and c."toNumber"='8455129339'
  and c."startedAt" > now() - interval '30 days'
group by 1 order by 1 desc;
```

**`app_MISSING` is 0 on every single day from 2026-08-03 onward.** The only misses are
2026-07-28/29/31 (3+2+1), which predate his 2026-08-23 re-login.

And the app leg is not merely *dialed* — it **answers 180 Ringing**. From today's 08:33:56 EDT
call in `/var/log/asterisk/full`:

```
08:33:57  app_dial.c: Called PJSIP/T25_101_1/sip:1b75hht3@172.56.166.26:51946;transport=ws
08:33:57  app_dial.c: PJSIP/T25_101_1-00003f6b is ringing              <-- the APP rang
08:33:57  app_dial.c: Local/8455129339@T25_cos-all-00001c08;1 is ringing  <-- the CELL rang
08:34:26  app_dial.c: Nobody picked up in 30000 ms
```

⛔ `NOTICE app_dial.c: Unable to create channel of type 'PJSIP' (cause 3 - No route to
destination)` on the same call is the **dead desk phone**, not a fault. Expect it on every
Relax Tires call until that phone is removed or brought online.

**All three of today's calls to ext 101** (08:33:56, 08:44:48, 13:43:30 EDT) dialed the app,
and the wake-dial logged `dialing T25_101_1 after 0s` on each (a live contact was already
present — the hold never had to wait).

### The 13:43 call worked end to end

`pbxCallId 1787852568.35098`, from 845-978-4710. From the api log:

- `17:43:30.699` `PUSH_SEND` `INCOMING_CALL_WAKE`
- `17:43:31.033` `FCM_DIRECT_DELIVERED` (device `cmt69ey2d…`, token tail `F_sZCaIP-8`)
- `17:43:31.255` `FCM_DIRECT_DELIVERED` `INCOMING_CALL`
- `17:43:31.563` `PUSH_DELIVERED` `INCOMING_CALL` `expoStatus: ok`
- `17:43:31.578` `INVITE_PUSH_DELIVERED`
- **`17:43:34.765` the invite is ACCEPTED — the app answered, 4.5 s after the invite**
- `17:43:34.777` `mobile-ring-notify: invite fulfilled by its own app — no cancel push`

Push delivery, the wake, the invite, the SIP INVITE and the answer are all healthy on that call.

⛔ **Timezone trap that will waste an hour:** `ConnectCdr.startedAt` is naive UTC, so
`"startedAt" at time zone 'America/New_York'` **adds** 4 hours instead of subtracting.
Real EDT = displayed − 8h. And the call's CDR `startedAt` is when the call hit the **IVR**;
ext 101 is only dialed when the caller picks an option — on the 13:43 call that was
**42 seconds later** (`latencyMs: 41600` in the wake logs). Do not read that gap as a delay.

---

## 3. What the inbound path actually is

The DID does **not** ring ext 101 directly. It is:

**DID 8457761765 → `T25_incoming-calls` → IVR-43 → ring group "New Tires" → ext 101** (which
then fans out to desk/app/cell).

Proven from the log: `sub-notify-missed-call,s,1(fcab1cd3482527c3,101,CANCEL,9176859089,New
Tires:,2,RING_GROUP,New Tires)` and `Local/101@T25_ring-group-dial`.

⛔ **This is why a lot of inbound calls show `app_leg = false` and have no cell leg either** —
they never reached ext 101 at all. Example: today 08:34:32 EDT, caller 917-685-9089 pressed
**2** in IVR-43 and went somewhere else entirely (`Executing [2@IVR-43:2]`). Those calls are
*not* instances of the complaint; on those, the cell does not ring either. **Check for a
paired outgoing CDR to 8455129339 before treating an `app_leg=false` call as a miss.**

---

## 4. What IS wrong: the app's SIP registration churns badly

`PbxEndpointRegistrationEvent` for `T25_101_1`:

| day | REGISTERED | UNREACHABLE | UNREGISTERED |
|---|---|---|---|
| 08-27 (partial) | 97 | 97 | 88 |
| 08-26 | 145 | 138 | 124 |
| 08-25 | 136 | 133 | 123 |
| 08-24 | 160 | 159 | 125 |
| 08-23 | 133 | 131 | 111 |

⛔ **The SIP username changes on every single re-registration** (`29touipr` → `js5tmnao` →
`tq4r5juv` → `gi58uka0` → `4fvug1o6` → `31ksbuk9` → `s93okd57` …). Per the Gesheft 101 handoff,
a plain re-REGISTER keeps its contact URI — **a new contact user means JsSIP built a NEW UA**,
i.e. the app is tearing down and rebuilding its entire SIP stack, roughly **every 10 minutes**.

✅ **It is ONE device, not several sharing the AOR.** `x-ast-orig-host=4pqif3nji323.invalid` is
identical on every registration (the JsSIP instance id, stable per install), and
`max_contacts` is 3 with only ever 1 in use. **So the Fixup Group "an always-on sibling
disarms the wake hold" mechanism does NOT apply here.**

### Dark time — measured, not estimated

Most cycles are a clean swap (unregister old / register new inside ~0.5 s), but not all:

| day | gaps | gaps >= 30 s | total dark | longest |
|---|---|---|---|---|
| 08-27 | 97 | 7 | **32.5 min** | 6.0 min |
| 08-26 | 145 | 12 | **34.8 min** | 5.4 min |
| 08-25 | 136 | 11 | **32.9 min** | 5.6 min |
| 08-24 | 160 | 15 | **42.4 min** | 5.3 min |
| 08-23 | 132 | 14 | **45.7 min** | 5.6 min |

So the app is unreachable **~33–46 minutes a day (~2.3–3.2%)**, in gaps of up to ~6 minutes.

⛔ **There was also a 28-hour total outage: 2026-08-21 21:15 UTC → 2026-08-23 01:13 UTC**
(plus 72 min on 08-20). He re-signed-in on 08-23 20:28, which is where the current device row
begins.

### Fleet context — elevated, but not the worst

Last 24 h, app (`_1`) endpoints, event counts: T34_102_1 **2661**, T3_301_1 1096,
T5_101_1 631 (Luxure, the documented filtered-internet case), T2_103_1 418, T11_108_1 410,
**T25_101_1 395**, T7_102_1 382 … Mean across the 20 app endpoints is **347**.

**Relax Tires is 6th of 20 and near the mean.** This is the ordinary
cellular-CGNAT / filtered-internet class this platform already lives with — it is not a new
or unique fault, which is consistent with Izzy's "*more* problems".

---

## 5. Ruled out — with evidence, so nobody re-derives these

- ⛔ **The churn did not cause any observed miss.** For all **46** rings in the last 10 days,
  the endpoint's most recent registration event at the moment the invite was created was
  **`REGISTERED`** — every time. Not one ring landed in a dark window.
- ⛔ **The dial string, wake enrolment, hold sizing, DND and diversions are all correct.**
- ⛔ **The push channel works** — direct FCM (`FCM_DIRECT_DELIVERED`) *and* Expo, both `ok`,
  with a `DEVICE_PUSH_RECEIVED` ack in 70 ms on the call I traced fully.
- ⛔ **He is on the current fleet APK** (`1.0.0+20260823-175041`), i.e. he already has the
  2026-08-23 warm-answer-deadline fix. **Do not tell him to update.**
- ⛔ **Not the desk phone** — it has never registered, so it was never part of "both".
- ⛔ **The server-side device-registration watchdog is NOT firing for him** — 6 hits fleet-wide
  in 24 h, **0** for this user. The `gateReason: "server:device_registration_watchdog"` in his
  `keepAliveSnapshot` is **stale**, latched `1787516909111` = 2026-08-23 21:48 UTC.
  **Read `gateLatchedAtMs` before treating that field as current.**

### ⛔⛔ The client telemetry is ~75% LOSSY — do not build a finding on it

`VoiceDiagEvent` for this user over 10 days reads `INCOMING_INVITE` **32** against **46**
rings, and `UI_SHOWN` only **8**. That looks like a smoking gun and **it is not**:

**Of the 8 calls the app demonstrably ANSWERED (`CallInvite.status = ACCEPTED`, which only the
app can produce), only 2 have a matching `INCOMING_INVITE` event.** The app plainly received
those INVITEs. So roughly three quarters of this device's diagnostic posts never land, and the
"32 of 46" gap measures telemetry loss, not ring failures. `UI_SHOWN` is emitted on only some
paths and is likewise unusable here.

⛔ **Always sanity-check a telemetry gap against a case you know succeeded before reporting
it.** This one would have produced a confident, wrong root cause.

---

## 6. Honest conclusion

**Nothing on Connect's side failed on any call I can see.** The PBX dialed the app on every
call for 24 days, the app's SIP stack answered `180 Ringing`, and the ring pushes were
delivered on both channels. On today's three calls the machinery is healthy end to end, and
one of them was answered **on the app** in 4.5 s.

What is genuinely wrong is the **app's SIP registration stability on T-Mobile cellular**: it
rebuilds its whole SIP stack every ~10 minutes and is unreachable ~3% of the day in gaps of up
to 6 minutes. The cell forward is a plain PSTN leg that depends on none of that, so **the cell
always rings and the app is the only leg that can be missing** — which is exactly what the
customer experiences and describes.

⏳ **NOT PROVEN, and this is the gap: I could not identify the specific failed call.** I have
no timestamp for the incident, today's three calls all rang the app correctly, and the api
container was recreated at **18:04 UTC** by another session's deploy, which **wiped
`docker logs`** — so I can no longer inspect the api's push detail for earlier calls, and
`/var/log/asterisk/full` on the PBX holds **today only**.

Two possibilities remain open and the data cannot separate them:

1. **He answered on the cell.** The cell rings instantly over PSTN; the app needs push → wake →
   render. If he picks up the cell, the app's ring is canceled and it can read as "only the
   cell rang". 38 of 46 rings ended `CANCELED`.
2. **The app got the INVITE but never alerted him.** The Android ring *screen* is push-driven,
   so the SIP stack can answer `180 Ringing` (which the PBX sees, and did see) while no screen
   or sound reaches the user. This fits the complaint exactly and would be invisible from the
   server.

---

## 7. What to do next

1. ⛔ **Get the time of the call from him — this is the single highest-value thing, and it is
   perishable.** The PBX log holds **today only**. With a timestamp on the same day I can say
   in minutes whether the app leg rang, for how long, and whether the push landed.
2. **Ask him the one question that separates the two possibilities:** *when it "only rang the
   cell", did the phone show a Connect incoming-call screen at all?* If the screen never
   appeared, it is the alerting path (2); if it appeared and he answered the cell instead, it
   is (1) and nothing is broken.
3. ✅ **Housekeeping (safe, one row):** he has **TWO `active` MobileDevice rows for one
   phone** — `cms4omoi01jmoro12bzrood5x` (deviceId `mobile-android-ms4omoaw-7tfv0exl`,
   created 07-28, **last seen 2026-08-23 20:15**, i.e. the install he replaced) and
   `cmt69ey2d1p3tph13t2hjsida` (deviceId `mobile-android-mt69exyg-j73ds5qv`, created 08-23
   20:28, live). Different deviceIds and different tokens, so the dedupe key never matched and
   the old row was never deactivated. **Every push is therefore sent twice**
   (`device-fan-out … activeRowsCount: 2`), one of them to a dead install. Harmless but noisy;
   deactivating the stale row is a one-row update. **Not done — needs Izzy's word.**
4. **On the device (free, most likely to help):** Samsung One UI battery management — put
   Connect in **Settings → Battery → Background usage limits → Never sleeping apps**, and
   confirm it is not in *Deep sleeping apps*. A killed/throttled keepalive service is the
   classic cause of exactly this rebuild-every-10-minutes pattern on Samsung.
5. ⚠️ **Do NOT reflexively move this tenant to the 443 SIP route.** That fix is for *filtered*
   internet (blocked ports). His contact IP is plain T-Mobile cellular and his registrations
   are succeeding — the churn is CGNAT idle-timeout on his side of the NAT, which the 443 route
   does not obviously fix. It is a reasonable experiment, not a known remedy, and it costs him
   a sign-out/sign-in (the app never refreshes a cached `sipWsUrl`).

---

## 8. Query and log recipes used (reusable)

- **Is the app reachable at ring time?** Join `CallInvite` to the last
  `PbxEndpointRegistrationEvent` at or before `createdAt` with `left join lateral … order by
  "occurredAt" desc limit 1`. This is the test that killed the churn hypothesis.
- **Did the PBX ring the app?** `ConnectCdr."channelsSeen"::text like '%T25_101_1%'` on the
  **outgoing** row to the cell number — that pairs the two legs of one call.
  ⛔ `channelsSeen` is Json, not a string array; `has:` throws. Column names need quoting
  (`"channelsSeen"`, not `channelsSeen`).
- **Dark windows:** `lead()` over `PbxEndpointRegistrationEvent` where
  `status in ('UNREACHABLE','UNREGISTERED')` and `next_status = 'REGISTERED'`.
- **Did the app really ring?** On the PBX, `grep -a "<linkedid>" /var/log/asterisk/full |
  grep -a "is ringing"`. `PJSIP/T25_101_1-xxxx is ringing` is ground truth that the SIP INVITE
  reached the app and it answered 180.
- ⛔ **Do not grep the api log by `pbxCallId`** — several `[CALL_WAKE]` lines (including
  `FCM_DIRECT_DELIVERED`) carry no `pbxCallId` field, so the grep silently under-reports.
  I ran it against a call I had already seen the lines on and it returned **0** — that control
  is what caught the method. Grep by `userId` and filter by time instead.
- ⛔ `ombu_devices` has **no `dial_string` column** (it is `user` / `technology` /
  `assigned_exten`), and `VoiceDiagEvent` uses **`type`**, not `eventType`.

---

## 9. FOLLOW-UP 2026-08-27 — he answered on the CELL, and the app showed a STALE ring screen later

Izzy relayed the missing detail: **he answered the call on the virtual extension (his regular
phone). Later, after the call, he opened the app, saw the incoming-call screen, and it went
away "like it was stale" — and he insists it never actually rang.** He asked whether the cause
is that both legs land on **one physical handset** (the cell forward rings the same phone the
app is installed on).

**Yes. That is almost certainly the mechanism, and it explains every observation in sections
2-6 at once** — including why the PBX looked perfectly healthy.

### 9a. What the stale screen proves

`IncomingCallFirebaseService.writeCacheFile()` persists every incoming push to
**`pending_call_native.json`** in the app cache, and JS reads it back via `readCachedInvite()`
(`NotificationsContext.tsx:689`). So a stale incoming-call screen on next app open means **the
push reached the handset and the native service ran** — it is not a lost push. That agrees
with the server, which logged `FCM_DIRECT_DELIVERED` + Expo `ok` on every ring.

### 9b. Why it never rang — the app's incoming UI is a HEADS-UP, not a screen takeover

⛔⛔ **I first assumed Android Telecom arbitration (a self-managed `ConnectionService` being
refused while a carrier call is up) and that was WRONG — check the code before asserting it.**
The Telecom path exists (`TelecomBridge.startIncomingCall`, `CAPABILITY_SELF_MANAGED`) but is
**disabled behind `if (false)` since 2026-05-07** (`IncomingCallFirebaseService.java:1155`),
deliberately, because on Samsung One UI it drew the OS dialer screen before the SIP INVITE
existed. `isIncomingCallPermitted` is called **nowhere** in the repo.

What actually presents an incoming call is a **CallStyle notification + full-screen intent**,
and the code states its own limitation (`IncomingCallFirebaseService.java:1713`):

> "This does NOT force a screen takeover on the home screen: the OS only launches the
> full-screen intent when the device is **locked / screen-off**; while the device is unlocked
> and interactive it is shown as a **floating heads-up notification** instead (and if
> `USE_FULL_SCREEN_INTENT` is not granted it is always demoted to a heads-up)."

So on an unlocked, in-use phone, Connect's incoming call is **a heads-up banner competing with
the native carrier incoming-call screen for the same handset** — and the carrier call owns the
display.

### 9c. And the ringtone is on the same audio stream telephony uses

`startIncomingCallRingtone` plays on **`STREAM_RING`** with
`USAGE_NOTIFICATION_RINGTONE` (`IncomingCallFirebaseService.java:2524-2538`) — the same stream
the carrier ringer uses, and the stream Android suppresses once a call goes `MODE_IN_CALL`.
**The moment he answers on the cell, Connect's ringtone is silenced by the platform**, even if
it had started.

⛔ **The app checks native cellular call state NOWHERE.** `inActiveCall` is set only from JS
(`IncomingCallUiModule.kt:871`) and reflects Connect's OWN call, not a carrier call; there is
no `TelephonyManager` / `getCallState()` reference anywhere in the Android source. So the app
cannot know it is competing with a native call and cannot adapt.

### 9d. The measurement that makes this concrete

Of **38** cancelled rings in 10 days, **20 (53%) lasted under 10 seconds** and **9 under 5
seconds** — the single commonest value is **5 s** (8 calls), then 4 s and 7 s (4 each). Mean
17 s. The 31-44 s tail is the calls nobody answered at all.

```sql
select round(extract(epoch from ("canceledAt" - "createdAt")))::int as app_ring_seconds,
       count(*) from "CallInvite"
where "tenantId"='cmnlgryme000up9paz1w40fg0' and "canceledAt" is not null
  and "createdAt" > now() - interval '10 days' group by 1 order by 1;
```

**On more than half his calls the app was only "ringing" for 2-8 seconds** before he picked up
the cell and the PBX cancelled the invite. A heads-up banner behind a native incoming-call
screen, for five seconds, is indistinguishable from never ringing.

### 9e. ⛔ The diagnostics that would settle it NEVER LEAVE THE PHONE

`emitCallFlowNative()` (`IncomingCallFirebaseService.java:527`) ends in **`Log.i(...)` and
nothing else** — it is logcat-only. So `incoming_call_ui_displayed`,
`NATIVE_NOTIFICATION_POSTED`, `RINGTONE_START`, `preferFullScreen`, `channelImportance` and
**`canUseFullScreenIntent`** are all unreadable from the server. **This whole class of failure
— "the push arrived, the app had it, and the user saw nothing" — is structurally invisible to
us.** Uploading those few fields with the existing quality report would make it diagnosable.
⏳ Not built.

### 9f. What to do — the real fix is on the PBX, not the phone

- ✅✅ **RECOMMENDED: stop ringing both legs simultaneously — give the app a head start.**
  Today `/fcab1cd3482527c3/extensions/101/dial` fires all three legs at once, so the carrier
  call reaches the handset at the same moment as the app push and takes the screen. Ringing the
  app alone for ~10 s and only then adding the cell gives the app an uncontested window and
  keeps the cell as backup. **This is a PBX change and needs Izzy's mandate — NOT done.**
- **The 2-minute test that proves it before changing anything:** place a test call with the
  cell leg temporarily removed from ext 101. If the app rings reliably with no carrier call
  competing, the mechanism is confirmed.
- ⚠️ **Phone-side settings cannot beat a native call screen** — granting full-screen intent or
  raising the channel importance will not make a heads-up win against the carrier UI. Worth
  setting anyway (and Samsung "Never sleeping apps" still helps the churn in section 4), but do
  not present it as the fix.
- ⛔ **Nothing here is a Connect bug in the sense of something being broken.** The PBX,
  the push and the SIP layer all did their jobs. It is a **design collision**: two legs of one
  call landing on one handset, where the carrier leg always wins the screen and the ringer.
