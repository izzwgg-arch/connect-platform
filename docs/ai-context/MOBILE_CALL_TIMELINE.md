# Mobile Call Timeline (Push → Wake → Ring → Answer)

> **Scope:** how an inbound PSTN call from VitalPBX reaches a mobile
> device and produces a ringing screen the user can answer.
> **Source-of-truth files** referenced below — load these (with line
> windows, not whole files) when actively debugging this path.

## Files most relevant to this flow

- `apps/mobile/src/context/NotificationsContext.tsx` (3,814 lines, ~178 KB)
  — push registration, OS-tray suppression, synthetic-invite path,
  call-wake bridge, eager pre-register optimisation.
- `apps/mobile/src/context/SipContext.tsx` (1,235 lines) — SIP REGISTER
  lifecycle, call state, hold/resume/transfer.
- `apps/mobile/src/context/CallSessionManager.tsx` (1,067 lines) — UI
  call session bookkeeping.
- `apps/mobile/src/sip/jssip.ts` (1,727 lines) — JsSIP wrapper.
- `apps/mobile/src/sip/callkeep.ts` — `RNCallKeep` integration (Android).
- `apps/mobile/src/sip/voipPush.ts` — `react-native-voip-push-notification`
  (iOS).
- `apps/mobile/src/voicemail/vmGreetingWakeBridge.ts` — bridges a
  voicemail-greeting record-wake to a synthetic invite.
- `apps/api/src/server.ts` — `sendPushToUserDevices` (around line ~2500–2800)
  fans out the FCM/APNs pushes; `/mobile/devices/register`,
  `/voice/mobile-provisioning/*` for device → user mapping.
- `scripts/pbx/install-connect-wake-dialplan.sh` — the
  wake-then-dial dialplan wrapper that reads
  `connect/system/wake_*` keys.
- DB models: `MobileDevice`, `CallInvite`, `CallWakeEvent` — see
  `docs/ai-context/DATA_MODEL.md`.

## High-level lifecycle

```
PSTN call hits VitalPBX
        │
        ▼
[connect-tenant-router] / [connect-tenant-ivr]    (reads connect/t_<slug>/*)
        │
        ▼  HTTP POST /voice/wake (with tenant + extension)
Connect API (apps/api/src/server.ts)
   1. Creates CallInvite                             (Prisma)
   2. Resolves MobileDevice rows for the user
   3. sendPushToUserDevices: data-only, priority=high
        ├─ INCOMING_CALL_WAKE (TTL=10s)  ─── pre-register hint
        └─ INCOMING_CALL      (TTL=45s)  ─── ringing trigger
   4. Writes CallWakeEvent rows at every step
        │
        ▼
FCM / APNs
        │
        ▼  delivers to device with NO system-tray UI
Native side (Android: IncomingCallFirebaseService;
             iOS: PushKit / RNVoipPushNotification)
        │
        ├─ INCOMING_CALL_WAKE → kick SIP REGISTER, no UI
        └─ INCOMING_CALL      → CallKeep.displayIncomingCall (Android)
                                 / CallKit displayIncomingCall (iOS)
        │
        ▼
React Native JS layer (NotificationsContext + SipContext)
   1. Hydrate CallInvite via /me/...                 (REST)
   2. SIP REGISTER if not already registered
   3. Wait for SIP INVITE from PBX (~6s after wake)
   4. JsSIP delivers UA "newRTCSession" → ringing UI
        │
        ▼
User taps Answer (CallKeep.answerCall event)
   → JsSIP session.answer()
   → CallInvite status → ACCEPTED
   → CallWakeEvent stage = DEVICE_ANSWER_TAPPED
```

---

## Stage 1 — PBX → Connect API ("/voice/wake")

The dialplan wrapper installed by
`scripts/pbx/install-connect-wake-dialplan.sh` runs **before** the actual
`Dial(PJSIP/<ext>)`. For each call destined to a Connect-managed
extension, the wrapper:

1. Reads three globals from `connect/system`:
   - `wake_api_url` — POST target.
   - `wake_api_secret` — bearer.
   - `wake_wait_secs` — how long to wait for `DEVICE_REGISTER_COMPLETE`
     before falling through to a normal `Dial()`.
2. POSTs `{ pbxCallId, fromNumber, toExtension, … }` to the Connect API.
3. Waits up to `wake_wait_secs` for the API to confirm the device is
   registered, then dials.

If `wake_api_url` is empty, the wrapper short-circuits and behaves like
plain `Dial()`. This is the "PBX-only" fallback.

Reference: `scripts/pbx/install-connect-wake-dialplan.sh` lines ~283–325.

---

## Stage 2 — Connect API push fan-out

`apps/api/src/server.ts` `sendPushToUserDevices(...)` is the canonical API-side
fan-out. **Shared shaping** lives in `packages/shared/src/expoMobilePushFormat.ts`
(`buildExpoPushV2Item`): every mobile payload is an **FCM data message** with
`priority: "high"` — including voicemail, missed-call tray, and chat/SMS alerts.
User-visible text for non-call alerts is carried in `data.alertTitle`,
`data.alertBody`, and `data.androidChannelId` (never in Expo's top-level
`title`/`body`, which would downgrade Android to notification-only delivery and
skip `IncomingCallFirebaseService.onMessageReceived`).

Structured API logs: `mobile_push_audit.expo_messages_built` and
`mobile_push_audit.expo_response` (stable `event` / `stage` fields).

| Payload type | TTL | Purpose | Native handler |
|---|---:|---|---|
| `INCOMING_CALL_WAKE` | 10s | "Get ready: SIP REGISTER now" — no UI. | wake handler |
| `INCOMING_CALL` | 45s | "Ring now" — drives CallKeep / CallKit. | ringing UI |
| `INVITE_CANCELED` / `INVITE_CLAIMED` / `MISSED_CALL` | 45s | Stop the ringtone / dismiss UI. | termination handler |
| `voicemail` / `missed_call` / `dm_message` / `sms_message` | 1h / 1h / … | User alerts (tray). | user-alert handler + JS |

**Critical contract — read this comment block before touching push code**
(`server.ts` ~line 2604):

> `INVITE_CANCELED / INVITE_CLAIMED / MISSED_CALL` MUST wake the native
> `FirebaseMessagingService` on a cold-killed app so it can stop the
> ringtone started by the prior `INCOMING_CALL` push. If we send them as
> Expo notification messages (sound/title/body/channelId/priority=default),
> Android delivers them via the system notification tray without invoking
> `onMessageReceived` — the ringtone then plays forever until the user
> taps the stale incoming-call notification. Fix: send these as **strict
> data-only, priority=high pushes**.

Strict data-only means:
- No Expo top-level `title`, `body`, `sound`, `channelId` for **any** mobile type
  (call control **or** user alerts) — use `buildExpoPushV2Item` so FCM always
  delivers to `onMessageReceived`.
- All `data` values are strings (see `stringifyFcmDataValues` in shared).
- Priority `"high"` so they bypass Doze.

Every push attempt updates the `MobileDevice` row's `lastPushSentAt`,
`lastPushType`, `lastPushStatus`, `lastPushError`, and writes a
`CallWakeEvent` row.

---

## Stage 3 — Native delivery (Android / iOS)

### Android — Firebase + CallStyle notification

- `IncomingCallFirebaseService.onMessageReceived` is the only entry
  point. It reads `data.type` and routes:
  - `INCOMING_CALL_WAKE` → starts `SipKeepAliveService`, emits
    `Sip.WakeRegister` to JS for pre-registration. **No UI**.
  - `INCOMING_CALL` (app **not** foregrounded) →
    `startIncomingCallRingtone()` + `launchIncomingCallUi()`:
    posts a `CATEGORY_CALL / PRIORITY_MAX` **CallStyle notification**
    with Answer / Decline actions and a **full-screen intent** that
    launches `MainActivity` → Connect `IncomingCallScreen`.
    `triggerFullScreenIntent()` uses `MODE_BACKGROUND_ACTIVITY_START_ALLOWED`
    (Android 14+) to bypass Background Activity Launch restrictions.
  - `INCOMING_CALL` (app **foregrounded**) → emits
    `IncomingCall.ForegroundInvite` to JS; posts a heads-up-only
    CallStyle notification as a fallback surface.
  - `INVITE_CANCELED` / `INVITE_CLAIMED` / `MISSED_CALL` →
    `dismissIncomingCallUi` + `stopIncomingCallRingtone`.
  - `voicemail` / `missed_call` / `dm_message` / `sms_message` (data-only user
    alerts) → when the process is **not** `FOREGROUND`/`VISIBLE`, post a tray
    notification on `androidChannelId` using `alertTitle` / `alertBody`, with
    deep links `com.connectcommunications.mobile://voicemail?…`,
    `…://missed-call`, `…://chat?…` (see `RootNavigator.tsx`). Always
    `forwardToExpo` so JS stays in sync.

**Android Telecom (SELF_MANAGED ConnectionService) — RE-ENABLED (Phase 1,
2026-05-07):**
`TelecomBridge.startIncomingCall()` is called for all non-foregrounded
incoming calls. Falls back to the CallStyle/FSI path transparently if the
PhoneAccount is not enabled or `addNewIncomingCall()` fails.

Answer correctness contract (Phase 1 fix):
- `ConnectIncomingConnection.onAnswer()` does **NOT** call `setActive()`.
  Instead it arms a 15 s safety watchdog and emits `Telecom.Answer` to JS.
- JS runs `handleAcceptInvite()` (the same pipeline as the in-app Answer
  button) with a 4 s cold-start invite-resolution poll.
- On SIP success: JS calls `NativeModules.IncomingCallUi.telecomMarkActive()`
  → `ConnectIncomingConnection.markActive()` → `setActive()`. OS in-call
  timer starts at the correct moment.
- On SIP failure: JS calls `terminateTelecomCall(inviteId, "other")` →
  `terminate()` → `setDisconnected(CANCELED)`. OS shows "call ended".
- If JS never responds within 15 s, the watchdog terminates the Connection.

Phase 1 known tradeoff: on Samsung One UI, both the Samsung native phone UI
and the Connect CallStyle notification appear simultaneously (two answer
surfaces). Both correctly connect the SIP call. Phase 2 will resolve the
duplicate. See `KNOWN_ISSUES.md` "Phase 1" for full context.

### iOS — PushKit + CallKit

- `react-native-voip-push-notification` delivers VoIP pushes to the
  native CallKit handler.
- App must call `displayIncomingCall` immediately on every PushKit
  delivery (Apple-mandated; failing to do so within ~30s results in
  the push being throttled or refused).
- A separate `voipPushToken` is stored on `MobileDevice`.

**UNKNOWN — verify before changing:** the exact iOS-specific
synchronization between PushKit delivery and the JS thread waking up.
Live behavior is documented in `apps/mobile/src/sip/voipPush.ts` plus
the iOS native bridge in `apps/mobile/ios/`. Do not rewrite without a
real iOS device test.

---

## Stage 4 — JS layer hydrates and rings

When the JS thread wakes (already running, or just started), in
`NotificationsContext.tsx`:

1. `setNotificationHandler` is configured to suppress the system banner
   for any data-only push (see line 123–135).
2. The push payload triggers a fetch against the Connect API to
   hydrate the `CallInvite` row by `inviteId`.
3. **Eager SIP pre-register** (line ~1142): the JS thread fires
   `REGISTER` *before* waiting for INVITE; measured savings ≈ 1.6 s.
4. `SipContext` waits for JsSIP `newRTCSession`. If it doesn't arrive
   within the window, the app falls back to the **synthetic-invite
   path** (lines ~1314–1400), which constructs a local invite from a
   recent `vmGreetingWakeBridge` event so the UI still rings even when
   the SIP INVITE is delayed/lost.

---

## Stage 5 — Answer / decline / cancel

| User action | Sequence |
|---|---|
| **Answer (Connect IncomingCallScreen)** | User taps Answer in the branded React UI → `handleAcceptInvite()` → `sip.answerIncomingInvite()` → JsSIP `session.answer()` → SIP 200 OK → `CallInvite.status = ACCEPTED` → `CallWakeEvent` stage `DEVICE_ANSWER_TAPPED` → media flows. Session is guaranteed to exist because `IncomingCallScreen` only renders after `newRTCSession`. |
| **Answer (notification action button)** | User taps the Answer action on the CallStyle heads-up/lock-screen notification → `PendingIntent` launches `MainActivity` with `action=answer` deep-link → same `handleAcceptInvite()` pipeline as above. |
| **Decline** | User taps Decline in IncomingCallScreen or notification → `handleDeclineInvite()` → JsSIP `session.terminate({ status_code: 486 })` → `CallInvite.status = DECLINED`. |
| **Caller cancels** | JsSIP delivers `failed`/`canceled` → API broadcasts `INVITE_CANCELED` push to all of the user's devices → native handler dismisses CallStyle notification and stops ringtone. |
| **Answered on another device** | API broadcasts `INVITE_CLAIMED` to the other devices for the same user → native handler dismisses UI. |

Worker-side: `runCallInviteExpiryCycle()` in `apps/worker/src/main.ts`
marks rows that never reach a terminal state and broadcasts a
`MISSED_CALL` push as cleanup.

---

## Known risks / race conditions (from code comments + tracking)

- **Cold-kill ring loop.** If `INVITE_CANCELED` is sent as a notification
  (not data-only), the ringtone plays forever. **Tested mitigation:**
  data-only/priority-high, see Stage 2 contract.
- **JS thread not yet running when push arrives.** Mitigated by the
  CallStyle notification (shown from native before JS boots) providing a
  visible ringing surface; JS catches up via `pending_call_native.json`
  hydration.
- **FSI blocked on some Android 14+ OEMs.** If the user revokes
  `USE_FULL_SCREEN_INTENT` permission or the channel importance is
  downgraded below HIGH, the full-screen intent may not fire. The
  CallStyle notification still shows in the notification shade and the
  user can tap Answer there. The diagnostics screen surfaces
  `canUseFullScreenIntentSafely` to detect this case.
- **SIP REGISTER half-closed.** `NotificationsContext.tsx` line 1871
  notes "in a half-closed state and the fresh REGISTER may need a
  retry."
- **Synthetic-invite vs real INVITE collision.** If the synthetic
  invite fires and then a real PBX INVITE arrives, they must be
  reconciled by `inviteId`. Reference: `[CALL_RECONCILE]` log lines
  in `NotificationsContext.tsx` ~lines 2461–2473.
- **TTL mismatch.** `INCOMING_CALL_WAKE` is TTL=10s by design — if FCM
  can't deliver in 10s the dialplan's `Wait()` is over and the push is
  useless. Don't increase this TTL "to be safe".
- **[RESOLVED — Phase 1] Telecom native call screen answer race.**
  Phase D disabled Telecom dispatch entirely to avoid the answer race but
  this broke lock-screen wake reliability (FSI blocked by Android 14/15+
  OEM restrictions when app is killed). Phase 1 re-enables Telecom and fixes
  the root cause: `setActive()` is now deferred until after
  `sip.answerIncomingInvite()` succeeds (JS calls `telecomMarkActive()`).
  See `KNOWN_ISSUES.md` "Phase 1" for full context.

---

## Voicemail Call-to-Record wake (Phase A, 2026-05-07)

Call-to-Record uses the same `INCOMING_CALL_WAKE` push as a normal
inbound call so the mobile app can pre-register and ring alongside
desk phone / WebRTC. The decision to send the push is made by
`apps/api/src/vmRecordCallJobs.ts::runVmRecordCallJob` and delegated to
the pure helper `decideVmRecordWake` in `apps/api/src/vmRecordCallHelpers.ts`.

Phase A behavior (must hold):

- Wake push is sent whenever the user has **at least one** `MobileDevice`
  row for the tenant — `active=true` is **not** required. A stale row may
  still hold a working push token; the post-wake `voiceClientSession`
  registration poll is the authoritative readiness signal.
- Wake push is **not suppressed** when a PJSIP AOR contact is already
  Avail. Desktop WebRTC and the mobile app share the same
  `T<tenant>_<ext>_1` authUsername, so a registered desktop made the
  AOR appear Avail and the previous gate suppressed mobile fan-out.
- The pre-wake `pjsip show contacts` parse is still done — its result
  is stored as `wake.endpointAlreadyAvail` for diagnostics — but it
  no longer blocks the push.
- Job public view exposes new diagnostic fields under `wake`:
  `attempted`, `deviceRowCount`, `activeDeviceCount`,
  `endpointAlreadyAvail`, `skipReason`, `pbxCallId`. Existing fields
  (`devicesNotified`, `waitedMs`, `sent`, `registered`,
  `registrationState`, `error`) are unchanged.
- API logs the decision once on every job:
  `vm-record-call: mobile wake decision` with all of the above plus
  `decision`. On send: `vm-record-call: mobile wake push sent`. On
  poll completion: `vm-record-call: mobile wake registration outcome`.

## vm-record INCOMING_CALL push (2026-05-07)

After Phase A/A.5 the mobile woke up and the PBX dialed
`PJSIP/T<tenant>_<ext>_1`, but the mobile never showed an incoming-call
UI. Root cause: the telephony pipeline sees the originating channel as
`Local/<ext>@connect-vm-greeting-dispatch` (`tenant_UNRESOLVED`) and
does NOT create a `CallInvite` or send an `INCOMING_CALL` FCM push.
Without the push the user cannot answer and `Dial()` times out.

Fix: `runVmRecordCallJob` sends a synthetic `INCOMING_CALL` push (to
active devices only, `includeInactiveDevices: false`) immediately before
`requestPbxVoicemailGreetingRecordCall`. Push fields:

| Field | Value |
|---|---|
| `type` | `INCOMING_CALL` |
| `inviteId` | `vmr-<jobId>` (stable per-job synthetic ID) |
| `fromDisplay` | `Voicemail Greeting Recording` |
| `fromNumber` | `vm-greeting` |
| `pbxCallId` | `wake.pbxCallId` if wake was sent, else `vmr-<jobId>` |

The mobile's `IncomingCallFirebaseService` handles this like any
`INCOMING_CALL` push: shows the `Connect IncomingCallScreen` with
Answer / Decline. When the user taps Answer, `jssip.ts::findIncoming()`
cannot match the synthetic inviteId to an SIP header (no
`X-Connect-Invite-ID` in the vm-record INVITE) but falls back to the
single answerable incoming session (line 1306 single-session fallback).
JsSIP sends 200 OK and the recording prompts play.

API log on send: `vm-record-call: sent mobile INCOMING_CALL push`
with `{jobId, extNumber, vmInviteId}`.

## Phase A.5 (2026-05-07) — second `active: true` filter

Production verification of Phase A revealed that
`sendPushToUserDevices` (`apps/api/src/server.ts:2544`) had its OWN
`active: true` filter at the Prisma query level, AFTER vm-record's
relaxed wake decision passed. For users whose `MobileDevice` rows had
all been heartbeat-deactivated, FCM dispatch returned `queued: 0` even
though Phase A correctly decided `send_wake`.

Phase A.5 adds an opt-in to that helper:

- `sendPushToUserDevices(input)` accepts an optional
  `includeInactiveDevices?: boolean`. Default `false` preserves the
  prior `active: true` filter for every existing caller (normal
  incoming calls, missed-call, INVITE_CANCELED/CLAIMED, voicemail,
  sms_message, dm_message). When `true`, the `active` filter is
  dropped; tenant + user scoping is unchanged.
- Only `runVmRecordCallJob` sets the flag, mediated through
  `buildVmRecordWakePushInput` in `vmRecordCallHelpers.ts`. The
  literal `includeInactiveDevices: true` in that helper is unit-tested
  as a regression guard.
- Every dispatch (Phase A.5 or not) emits a structured
  `mobile-push: device fan-out` log line with `totalRowsFound`,
  `activeRowsCount`, `rowsMissingToken`, `afterExclude`,
  `includeInactiveDevices` so we can tell "no devices on file" vs
  "all stale" vs "excluded" apart per call.

What Phase A.5 still does NOT change:

- Normal incoming-call wake semantics (logout, device-unregister)
  — still active-only, by default-false flag.
- `active: false` rows with `DeviceNotRegistered` Expo errors are
  still re-flipped inactive by the existing per-ticket cleanup at
  `server.ts:2871–2876`. Phase A.5 is self-cleaning.

## Phase B (2026-05-07) — dispatch-only originate + post-answer Gosub

The PBX helper used to override the originate channel to a single
`PJSIP/<hint>` endpoint after polling confirmed Avail, which made
`[connect-vm-greeting-dispatch]`'s `Dial(${CONNECT_VM_DIAL},30)`
fan-out moot — only the hinted device rang. Phase B removes that
override unconditionally:

- The helper (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`,
  VERSION `2026.05.07.1`) always originates
  `Local/<recording_exten>@connect-vm-greeting-dispatch/n` and tags
  the response `channelSource: "dispatch_local:<base>[,<hint>]"`. The
  AstDB-driven Dial fan-out rings every registered endpoint at once.
- The prompt-before-answer race that the override used to dodge is
  now solved at the dialplan layer:
  `Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${tenant}^${ext}^${file}))`
  fires the new `[connect-vm-greeting-record-sub]` context as a
  Gosub on the answered party's channel only AFTER pickup. Prompts
  never play to an empty bridge.
- `Set(CALLERID(name)=Voicemail Greeting Recording)` +
  `Set(CALLERID(num)=${CONNECT_VM_EXT})` are set in dispatch, so the
  outgoing INVITE shows the user their own extension as the caller
  with a clear name (instead of `anonymous@anonymous.invalid`).
- Legacy `[connect-vm-greeting-record]` context is intentionally
  retained for back-compat.
- API-side `runVmRecordCallJob` warn-logs
  `vm-record-call: helper returned direct_pjsip channelSource` if
  the helper ever returns the old shape — pure regression detector,
  no control-flow change.

What Phase A explicitly does NOT do (still TODO):

- It does **not** fix the desktop browser Answer-button bug
  (Failure A — browser never sends SIP 200 OK). That is a separate
  portal-side phase (Phase C).
- **Push token rotation on app reinstall.** Old `expoPushToken` rows
  remain on `MobileDevice`; the latest registration overrides via
  `@unique` constraint. Stale tokens get `lastPushError` set on
  failure but are not auto-deleted.
- **PBX dialplan wakes pre-resolution.** `WAKE_REQUESTED` events are
  written before `userId` / `deviceId` is resolved; `CallWakeEvent`
  has those fields nullable for exactly this reason.

---

## Android / iOS differences (discoverable from repo)

| Concern | Android | iOS |
|---|---|---|
| Push transport | FCM | APNs (VoIP class via PushKit) |
| Token field | `expoPushToken` | `expoPushToken` for non-VoIP, `voipPushToken` for PushKit |
| Native UI | `react-native-callkeep` | `CallKit` via `react-native-voip-push-notification` |
| Background wake | FCM `onMessageReceived` (high priority) | PushKit (must `displayIncomingCall` immediately) |
| Ringtone control | App-managed (`stopIncomingCallRingtone`) | OS-managed (CallKit) |
| Diagnostics | `manufacturer`/`model`/`osVersion` saved per-device for S24 vs S25 vs Pixel etc. | Same fields populated, but mostly homogenous. |

---

## Reading rules (cost-saving)

1. **Never load `NotificationsContext.tsx` whole.** It's 3,814 lines.
   `Grep` for the symbol you need (e.g. `setNotificationHandler`,
   `INCOMING_CALL_WAKE`, `synthetic_invite`, `[CALL_RECONCILE]`) and
   `Read` ±50 lines.
2. The push fan-out lives in a single big `sendPushToUserDevices` in
   `apps/api/src/server.ts` (~lines 2500–2800). Read **only** that
   range.
3. For native-side issues, read `apps/mobile/src/sip/callkeep.ts` and
   `voipPush.ts` first — they're small and almost always tell you what
   to look at next.
4. For "ring forever" / "ring once" / "wrong device rings" bugs, start
   with the `CallWakeEvent` rows (admin call-wake-diagnostics page,
   line ~1366 in `apps/portal/app/(platform)/admin/call-wake-diagnostics/page.tsx`).
   That page reconstructs the timeline from DB rows — read it instead of
   replaying live logs.

---

## What this doc deliberately does NOT cover

- Outbound calls (covered tangentially by `SipContext`/`useSipPhone`).
- WebRTC media negotiation details.
- Voicemail playback.
- Push notifications for SMS, chat, voicemail (different code paths;
  `channelId`-based instead of data-only).
- **In-call audio routing** (Bluetooth / wired / earpiece / speaker).
  Centralised in `apps/mobile/src/audio/audioRouteManager.ts` since
  2026-05-06. See the **Audio** bullet in
  `TELEPHONY.md#mobile-call-handling`. Search logcat for `[audio_route]`
  when debugging "audio jumped to earpiece on connect" / "speaker grabbed
  the route" complaints.

For those, see `apps/mobile/src/context/SipContext.tsx`,
`apps/portal/hooks/useSipPhone.ts`, and the SMS/chat handlers in
`apps/mobile/src/screens/tabs/`.
