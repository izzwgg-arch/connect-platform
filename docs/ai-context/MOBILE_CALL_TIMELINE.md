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

`apps/api/src/server.ts` `sendPushToUserDevices(...)` (around lines
**~2500–2800**) is the only place that emits the call-related pushes.
Three payload types share the same data-only, priority=high transport:

| Payload type | TTL | Purpose | Native handler |
|---|---:|---|---|
| `INCOMING_CALL_WAKE` | 10s | "Get ready: SIP REGISTER now" — no UI. | wake handler |
| `INCOMING_CALL` | 45s | "Ring now" — drives CallKeep / CallKit. | ringing UI |
| `INVITE_CANCELED` / `INVITE_CLAIMED` / `MISSED_CALL` | 45s | Stop the ringtone / dismiss UI. | termination handler |

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
- No `title`, `body`, `sound`, `channelId`.
- No Expo notification template.
- All fields are stringified (`fcmDataStrings`) so FCM accepts them.
- Priority `"high"` so they bypass Doze.

Every push attempt updates the `MobileDevice` row's `lastPushSentAt`,
`lastPushType`, `lastPushStatus`, `lastPushError`, and writes a
`CallWakeEvent` row.

---

## Stage 3 — Native delivery (Android / iOS)

### Android — Firebase + CallKeep

- `IncomingCallFirebaseService.onMessageReceived` is the only entry
  point. It reads `data.type` and routes:
  - `INCOMING_CALL_WAKE` → background task that fires SIP REGISTER via
    `vmGreetingWakeBridge` / native bridge. **No UI**.
  - `INCOMING_CALL` → `RNCallKeep.displayIncomingCall(callId, from,
    from, "number", false)` (see `apps/mobile/src/sip/callkeep.ts`
    line 85).
  - `INVITE_CANCELED` / `INVITE_CLAIMED` / `MISSED_CALL` →
    `dismissIncomingCallUi` + `stopIncomingCallRingtone`.
- `react-native-callkeep` provides `answerCall` / `endCall` event
  listeners (`callkeep.ts` lines 113–116).

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
| **Answer** | CallKeep `answerCall` event → JsSIP `session.answer()` → `CallInvite.status = ACCEPTED` → `CallWakeEvent` stage `DEVICE_ANSWER_TAPPED` → media flows. |
| **Decline** | CallKeep `endCall` event before answer → JsSIP `session.terminate({ status_code: 486 })` → `CallInvite.status = DECLINED`. |
| **Caller cancels** | JsSIP delivers `failed`/`canceled` → API broadcasts `INVITE_CANCELED` push to all of the user's devices → native handler dismisses CallKeep UI and stops ringtone. |
| **Answered on another device** | API broadcasts `INVITE_CLAIMED` to the other devices for the same user → native handler dismisses UI. |

Worker-side: `runCallInviteExpiryCycle()` in `apps/worker/src/main.ts`
marks rows that never reach a terminal state and broadcasts a
`MISSED_CALL` push as cleanup.

---

## Known risks / race conditions (from code comments + tracking)

- **Cold-kill ring loop.** If `INVITE_CANCELED` is sent as a notification
  (not data-only), the ringtone plays forever. **Tested mitigation:**
  data-only/priority-high, see Stage 2 contract.
- **JS thread not yet running when push arrives.** Mitigated by
  CallKeep displaying the UI from native code; JS catches up via
  hydration.
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
  `endpointAlreadyAvail`, `skipReason`. Existing fields
  (`devicesNotified`, `waitedMs`, `sent`, `registered`,
  `registrationState`, `error`) are unchanged.
- API logs the decision once on every job:
  `vm-record-call: mobile wake decision` with all of the above plus
  `decision`. On send: `vm-record-call: mobile wake push sent`. On
  poll completion: `vm-record-call: mobile wake registration outcome`.

What Phase A explicitly does NOT do (still TODO):

- It does **not** change the SIP originate / PBX helper path. The PBX
  originate currently still goes direct to the most-specific device
  endpoint when the helper sees a `pjsipEndpointHint` populated. A
  separate phase will move that to the dispatch / fan-out path so the
  PBX itself rings every reachable contact.
- It does **not** fix the desktop browser Answer-button bug
  (Failure A — browser never sends SIP 200 OK). That is a separate
  portal-side phase.
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
