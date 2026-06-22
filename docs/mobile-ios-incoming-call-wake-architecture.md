# Connect iOS — Incoming-Call Wake Architecture (Production Design)

> **Status:** Authoritative technical design for how the Connect iPhone app wakes and
> rings for inbound calls across every app state. Supersedes the scattered "incoming
> call" notes in the phase reports by consolidating them into one production spec and
> **correcting one critical gap discovered during the Phase 7 on-device test** (see §12).
>
> **Scope:** iOS only. **Do not touch Android.** Android keeps its existing
> FCM + self-managed `ConnectionService`/Telecom wake path unchanged.
>
> **Source of truth (read these first):**
> - [`mobile-ios-current-state.md`](./mobile-ios-current-state.md)
> - [`mobile-ios-production-plan.md`](./mobile-ios-production-plan.md)
> - [`mobile-ios-phase1-implementation-report.md`](./mobile-ios-phase1-implementation-report.md)
> - [`mobile-ios-phase4-callkit-pushkit-report.md`](./mobile-ios-phase4-callkit-pushkit-report.md)
> - [`mobile-ios-phase5-cold-killed-callkit-report.md`](./mobile-ios-phase5-cold-killed-callkit-report.md)
> - [`mobile-ios-phase6-first-eas-build-report.md`](./mobile-ios-phase6-first-eas-build-report.md)
>
> **Key identifiers**
> - Bundle ID: `com.connectcommunications.mobile` (note the **double `m`** in
>   `communications` — distinct from the web domain `connectcomunications.com`, which
>   has a **single `m`**; this distinction is a real failure source, see §8/§12).
> - APNs VoIP topic: `com.connectcommunications.mobile.voip` (= `<bundleId>.voip`).
> - APNs auth: token-based `.p8` ES256 JWT (Team ID `PR63R6J84J`).
> - Deterministic CallKit UUID: FNV-1a-32 derivation from `callId`, identical in JS
>   (`apps/mobile/src/sip/callkitUuid.ts`) and native (`plugins/withIosVoipPush.js`).

---

## 1. Executive summary

**iOS incoming calls are not Android-style background keep-alive.** On Android, Connect
keeps a foreground service alive, pre-registers SIP, and lets FCM wake a custom
`ConnectionService`. **That model is not permitted on iOS.** Apple does not allow a
third-party VoIP app to hold a permanent background SIP registration or a persistent
socket to ring on inbound calls. An app that is backgrounded, locked, or swiped-away is
**suspended or terminated**, and its SIP registration is dead.

The only Apple-sanctioned way to ring a suspended/terminated iPhone is a **server-driven
wake**:

```
PBX detects inbound call
  → Connect backend sends an APNs VoIP push (apns-push-type: voip)
    → iOS PushKit wakes the app process (even from cold-killed)
      → native code reports the call to CallKit IMMEDIATELY, before completion
        → iOS shows the native incoming-call screen (lock screen / full screen)
          → user answers
            → only THEN does the app register + connect SIP/WebRTC
```

Two rules dominate the entire design and cannot be violated:

1. **The native CallKit report must happen before the PushKit completion handler
   returns.** If iOS delivers a VoIP push and the app does not synchronously report a new
   incoming call to CallKit, Apple **terminates the app and throttles/revokes future
   VoIP pushes**. This is why the report lives in the native AppDelegate
   (`plugins/withIosVoipPush.js`), not only in JS.
2. **VoIP pushes are call-only.** Voicemail, SMS, chat, and missed-call notifications
   must never use the VoIP topic — they use standard APNs alert pushes (today via Expo).
   Misusing the VoIP topic for a non-call event also triggers Apple termination.

The app must **not** rely on a permanent background SIP registration. SIP/WebRTC is
connected **after** the user answers (connect-after-answer), reusing the same
`handleAcceptInvite` pipeline Android already uses.

---

## 2. Required end-to-end call flow

This is the exact production flow. Each numbered step names the responsible layer and the
file that owns it.

1. **Inbound call reaches the telephony layer.** VitalPBX receives an INVITE for an
   extension; the Connect telephony service emits a call event toward the backend
   (existing PBX → backend signaling; AMI/ARI plus the `INCOMING_CALL_WAKE` pre-register
   hint).
2. **Backend receives the incoming-call event** with `callId`/`pbxCallId`, `tenantId`,
   and target extension/user. The backend resolves the target user's `MobileDevice`
   rows. *(Today the API's PBX-event handler does this and creates the `CallInvite` —
   `apps/api/src/server.ts`. See §12 for the gap this creates.)*
3. **Backend finds registered iOS devices** for that user (`MobileDevice` where
   `platform = IOS`).
4. **Backend selects `voipPushToken`, not `expoPushToken`, for the call wake.** The VoIP
   token is the only token APNs accepts on the `.voip` topic. The `expoPushToken` is for
   alert/data pushes only.
5. **Backend sends an APNs VoIP push** over HTTP/2 to APNs with
   `apns-push-type: voip`, `apns-topic: com.connectcommunications.mobile.voip`,
   `apns-priority: 10`, a short `apns-expiration` (~30 s), and a **minimal** JSON body:
   `{ callId, tenantId, toExtension, callerNumber, callerName, timestamp }`. The sender is
   `apps/worker/src/apnsVoipPush.ts` (`sendApnsVoipPush`).
6. **iOS receives the PushKit event** even when locked/backgrounded/cold-killed (subject
   to the device being online — §3). iOS launches/wakes the app process for PushKit.
7. **Native AppDelegate PushKit handler runs** —
   `pushRegistry:didReceiveIncomingPushWithPayload:forType:withCompletionHandler:`
   (injected by `plugins/withIosVoipPush.js`). It reads `payload.dictionaryPayload` and
   extracts `callId` (falling back to `inviteId`), `callerNumber`, `callerName`.
8. **Native handler derives the deterministic CallKit UUID** from `callId` via
   `ConnectDeterministicCallKitUUID(callId)` (Obj-C port of the JS FNV-1a-32 algorithm).
9. **Native handler calls `[RNCallKeep reportNewIncomingCall:…]` BEFORE completion**
   (`fromPushKit:YES`, `hasVideo:NO`). This is the Apple-mandated report-before-completion
   step; it works from a terminated app because RNCallKeep lazily configures the
   `CXProvider`.
10. **iOS displays the native incoming-call screen** on the lock screen / full screen and
    rings.
11. **JS wakes/initializes** and the VoIP payload is forwarded to JS via
    `[RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:…]` →
    `initVoipPushListener.onIncoming` (`apps/mobile/src/sip/voipPush.ts`, iOS-only). JS
    builds the `CallInvite` (`payloadToInvite`), de-dupes by `callId`, idempotently
    reports/updates CallKit (`showIncomingNativeCall`), and persists pending invite state
    (`safeSetInvite`) — **no SIP yet**.
12. **User taps Answer.** CallKeep emits `answerCall` with the CallKit **UUID**.
13. **CallKeep `answerCall` maps the UUID back to `callId`** via `callIdForCallKitUuid`
    (`apps/mobile/src/sip/callkeep.ts`), then calls `resolveInviteForAction(callId)`.
14. **App runs the existing accept pipeline** —
    `handleAcceptInvite(invite, callId)` in
    `apps/mobile/src/context/NotificationsContext.tsx`: ensures jsSIP is registered from
    the stored provisioning bundle, answers the INVITE, establishes WebRTC media, primes
    `AVAudioSession`, and marks the CallKit call active (`setCurrentCallActive`).
15. **User taps Decline (or the call ends).** CallKeep `endCall` → UUID → `callId` →
    `handleDeclineInvite(invite, callId)` (existing reject/BYE path). On SIP
    `ended`/`failed`/cancel/voicemail-rollover, `endNativeCall(callId)` ends the CallKit
    call and `restoreAudioSession()` runs.

**Invariant:** SIP/WebRTC is connected only inside `handleAcceptInvite`, reachable only
via the CallKit `answerCall` event (or the in-app Answer button). The push wake never
connects media.

---

## 3. App states — what iOS guarantees and what it does not

| State | Behavior | iOS guarantee |
|-------|----------|---------------|
| **Foreground (app open)** | VoIP push (and/or Expo data push) arrives; JS `onIncoming` reports to CallKit; native report also fires. CallKit UI overlays the app. | Reliable. Even without a push, a foreground SIP socket could ring, but the design still routes through CallKit for consistency. |
| **Background (app backgrounded, screen on)** | App process is suspended. VoIP push wakes it; native report rings CallKit. | Reliable **if the device is online** and the VoIP push is delivered. |
| **Locked phone** | Same as background; CallKit shows the full-screen lock-screen incoming UI; answer/decline work from the lock screen. | Reliable when online. Lock state does not block VoIP wake or CallKit. |
| **App swiped away / cold-killed (user-initiated from app switcher)** | App is terminated. iOS **still relaunches the app for a VoIP push** and delivers it to the native PushKit handler, which must report to CallKit before completion. | **iOS guarantees relaunch-for-VoIP** here, *provided* the app has registered for PushKit at least once and the report-before-completion rule is honored every time. This is the whole reason the report is native, not JS. |
| **App force-quit by user** | Same as swiped-away on modern iOS: PushKit still relaunches for VoIP. (Historically "force-quit" was treated specially, but VoIP pushes relaunch the app today.) | Generally relaunches; treat the same as cold-killed. The one hard exception below (Settings-disabled) overrides this. |
| **Phone offline (no network / airplane mode)** | No push can be delivered. APNs **stores the most recent VoIP push** and delivers it when the device reconnects — but VoIP pushes are low-TTL by design, so a ring that is no longer relevant should be allowed to expire. | **No delivery while offline.** APNs collapses/stores at most a short window; a stale wake on reconnect must be handled gracefully (call already gone → end CallKit). |
| **APNs delayed / fails** | The ring is late or never arrives. With `apns-expiration ~30 s` the push self-expires, so a very late delivery does not ring for a call that is already over. | **No real-time guarantee.** APNs is best-effort with priority 10; typical latency is sub-second but not contractual. |

**Hard non-guarantees (iOS will NOT wake the app):**
- The user has **disabled notifications** for the app, or disabled Background App Refresh
  in a way that revokes VoIP — VoIP is generally exempt from Background App Refresh, but
  a user who blocks the app entirely can prevent ringing.
- The app has **never launched once** after install (PushKit token never registered) —
  no token, no wake.
- **Sandbox/production APNs mismatch** — APNs "accepts" the push (or rejects with
  `BadDeviceToken`) but the device never rings (§8).
- The **device token is stale** (app reinstalled, restored to new device) until the app
  re-registers.

---

## 4. Backend responsibilities

| # | Responsibility | Where / how |
|---|----------------|-------------|
| 1 | **Store `voipPushToken` per iOS device.** | `registerMobileDevice` persists `voipPushToken` + `platform = IOS` on `MobileDevice` (`apps/api/src/server.ts`). Schema already has the column. |
| 2 | **Store `expoPushToken` separately.** | Same row; `expoPushToken` is independent and used only for alert/data pushes. |
| 3 | **Associate token with tenant/user/extension/device.** | `MobileDevice` rows are keyed by tenant + user; extension resolved via the user's owned `Extension`. |
| 4 | **Select `voipPushToken` only for `INCOMING_CALL`.** | The VoIP fan-out filters to `platform === "IOS"` with non-null `voipPushToken` and is invoked **only** when the push payload type is `INCOMING_CALL`. |
| 5 | **Never use VoIP push for SMS / voicemail / missed / general notifications.** | `INVITE_CANCELED`, `MISSED_CALL`, voicemail, chat, SMS stay on the Expo/alert path. Apple terminates apps that VoIP-push non-calls. |
| 6 | **Send a minimal payload.** | Body = `{ callId, tenantId, toExtension, callerNumber, callerName, timestamp }`. No alert/sound (silent VoIP wake). |
| 7 | **Log APNs attempt / success / failure.** | Structured single-line JSON: `apns_voip_token_selected`, `apns_voip_send_attempt`, `apns_voip_send_success`, `apns_voip_send_failure` (§9). |
| 8 | **Handle `410` / `BadDeviceToken` / `Unregistered` / `DeviceTokenNotForTopic`.** | Null the device's `voipPushToken`, stamp `lastPushStatus = "APNS_VOIP_TOKEN_INVALID"` + `lastPushError`; log `apns_voip_token_invalidation_candidate`. App re-registers a fresh token on next launch. |
| 9 | **Support a call-cancel / hangup signal** so CallKit can be ended if the caller hangs up before answer (see §6 / §8 cold-killed-cancel; currently a documented gap). | Needs a call-only cancel wake (a second VoIP push that the native handler maps to `endCallWithUUID:`) or reliance on CallKit ring timeout. |
| 10 | **Ensure `APNS_PRODUCTION` matches the build entitlement.** | Dev/ad-hoc builds use `aps-environment: development` → `APNS_PRODUCTION=false` (sandbox host). TestFlight/App Store → `aps-environment: production` → `APNS_PRODUCTION=true`. |
| 11 | **Ensure the topic is exactly `<bundleId>.voip`.** | `com.connectcommunications.mobile.voip`. The worker derives `<bundleId>.voip` automatically; if `APNS_VOIP_TOPIC` is set explicitly it must match **byte-for-byte** (watch the single-vs-double-`m` domain trap, §8/§12). |

**Required env (worker, and — per §12 — the API too):** `APNS_TEAM_ID`, `APNS_KEY_ID`,
`APNS_AUTH_KEY_P8` **or** `APNS_AUTH_KEY_BASE64`, `APNS_BUNDLE_ID` (default
`com.connectcommunications.mobile`), `APNS_VOIP_TOPIC` (default `<bundleId>.voip`),
`APNS_PRODUCTION`.

**Backend acceptance:** an inbound call to an iOS extension yields exactly one VoIP push
to the device's current token, logged with delivery status, with zero VoIP pushes for
non-call events.

---

## 5. Mobile native iOS responsibilities

Owned by `apps/mobile/plugins/withIosVoipPush.js` (AppDelegate patch) and the iOS-only JS
shims it forwards to. Verified compiling as **Objective-C++** on the EAS build (Phase 6).

| # | Responsibility | Detail |
|---|----------------|--------|
| 1 | **PushKit registration.** | `voipRegistration` + `PKPushRegistry` for `PKPushTypeVoIP` set up in the AppDelegate at launch. |
| 2 | **APNs VoIP token upload.** | `didUpdatePushCredentials:forType:` forwards to `RNVoipPushNotificationManager`; JS caches the hex token (`getCachedVoipPushToken`) and `NotificationsContext` re-registers the `MobileDevice` with `voipPushToken` (handles late arrival). |
| 3 | **AppDelegate PushKit delegate.** | All three `PKPushRegistryDelegate` methods compiled; `didInvalidatePushTokenForType:` is a documented no-op (iOS re-issues a fresh token via `didUpdatePushCredentials` — the 3.3.x library has no such class method; this was the Phase 6 build-#1 fix). |
| 4 | **Native immediate CallKit report.** | `[RNCallKeep reportNewIncomingCall:uuid handle:… handleType:@"number" hasVideo:NO localizedCallerName:… fromPushKit:YES payload:dict withCompletionHandler:nil]` **before** `completion()`. |
| 5 | **Deterministic `callId` → UUID mapping.** | `ConnectDeterministicCallKitUUID(callId)` (FNV-1a-32, RFC-4122 v5-style bits) — identical to JS so native and JS reference the same CallKit call with no shared state. Reference vectors locked in `callkitUuid.test.ts`. |
| 6 | **Completion-handler timing.** | `completion()` is called **after** the CallKit report and payload-forward, never before. |
| 7 | **CallKit answer/decline/end listeners.** | RNCallKeep `answerCall` / `endCall` events flow to JS `subscribeNativeCallActions`, which translates UUID → `callId`. |
| 8 | **Audio session handling.** | `apps/mobile/src/audio/telephonyAudio.ts` configures `AVAudioSession` (`playsInSilentModeIOS` for playback; recording category on connect). Routing via `react-native-incall-manager` `setForceSpeakerphoneOn` on iOS (`jssip.ts`, `audioRouteManager.ts`). |
| 9 | **Lock-screen behavior.** | CallKit renders the system incoming UI on the lock screen; answer/decline operate without unlocking. |
| 10 | **Killed-app behavior.** | The native report path is the *only* thing that makes a cold-killed app ring; it must never depend on JS being alive at report time. |

---

## 6. JS / mobile responsibilities

Owned by `apps/mobile/src/sip/voipPush.ts`, `src/sip/callkeep.ts`,
`src/context/NotificationsContext.tsx`. All iOS-gated; Android paths untouched.

| # | Responsibility | Detail |
|---|----------------|--------|
| 1 | **Dedupe Expo push and VoIP push by `callId`.** | `reportedIncomingCallIds` set in `callkeep.ts` + `shownInviteIdRef`/`suppressedIncomingInviteIdsRef` in `NotificationsContext`. Exactly one incoming UI per `callId`. |
| 2 | **Reconcile native-reported CallKit call with JS pending invite.** | Native and JS derive the **same** UUID from `callId`; JS `showIncomingNativeCall` is idempotent against a call the native side already reported (CallKit updates, not duplicates). |
| 3 | **Answer only after the CallKit answer event.** | `answerCall` → `handleAcceptInvite`. Never connect SIP on push receipt. |
| 4 | **Decline/end through existing shared handlers.** | `endCall` → `handleDeclineInvite`. Same path as Android Telecom + in-app buttons. |
| 5 | **End CallKit on SIP ended/failed/canceled/voicemail.** | `sip.callState === "idle"` effect calls `endNativeCall(lingerId)` on iOS; `INVITE_CANCELED` data push calls `endNativeCall(callId)` when JS is alive. `endNativeCall` resolves the **deterministic** UUID even if the in-memory map is empty (cold-killed reconciliation). |
| 6 | **Never create duplicate incoming-call UI.** | Guaranteed by the two dedupe layers + shared UUID. |
| 7 | **Preserve Android behavior.** | UUID maps/`reportedIncomingCallIds` are populated only on iOS; on Android every lookup falls through to the raw `callId`. No `telecom.ts`/ConnectionService/FCM changes. |

---

## 7. Timing requirements (strict)

1. **Native CallKit report must happen immediately** — synchronously inside
   `didReceiveIncomingPushWithPayload`, before any async/network work.
2. **PushKit completion must not be called before the CallKit report.** Order is:
   derive UUID → `reportNewIncomingCall` → forward payload to JS → `completion()`.
3. **SIP/WebRTC connect waits until answer.** No registration or media on wake;
   connect-after-answer only (cold-start jsSIP register latency is paid after the user
   accepts, optionally mitigated by a pre-register-on-wake before answer).
4. **Stale calls must be cleared quickly.** `apns-expiration ~30 s` so an old wake does
   not ring; on answer, if SIP says the INVITE is gone, end CallKit immediately.
5. **Call cancellation must end CallKit promptly.** Foreground/warm: `INVITE_CANCELED` →
   `endNativeCall`. Cold-killed cancel-before-answer currently relies on CallKit's ring
   timeout until a backend call-cancel wake exists (§8, gap).

---

## 8. Failure modes and mitigations

| Failure | Symptom | Mitigation |
|---------|---------|-----------|
| **APNs auth wrong** (bad `.p8`/Key ID/Team ID) | `403`/JWT errors; no ring | Validate the `.p8` ES256 JWT signs (`apns_voip_jwt_error` log); confirm Key ID + Team ID; `resetApnsProviderTokenCache()` after a 403. |
| **Sandbox/production mismatch** | APNs `400 BadEnvironmentKeyInToken` or silent non-delivery | `APNS_PRODUCTION` must match `aps-environment`. Dev/ad-hoc → `false` (sandbox); TestFlight/prod → `true`. Most common "accepted but never rings" cause. |
| **Bad / stale device token** | `410 Unregistered` / `BadDeviceToken` | Null `voipPushToken`, stamp invalid, re-register on next launch (§4.8). |
| **Wrong VoIP topic** (single-vs-double `m`) | `400 DeviceTokenNotForTopic` | Topic must be `com.connectcommunications.mobile.voip` (bundle = double-`m` `communications`). **Do not** use the web domain `connectcomunications` (single `m`). Verify `APNS_VOIP_TOPIC` byte-for-byte (§12). |
| **App receives Expo + VoIP duplicate** | Two incoming UIs | Dedupe by `callId` (`reportedIncomingCallIds` + invite-state guards). Worker uses `inviteId` as `callId`, so both transports share the key. |
| **AppDelegate plugin fails to apply** | No native report; cold-killed never rings | Plugin verifies the patch + logs `Objective-C++ AppDelegate patched`; absence of that log on a build = investigate. |
| **Swift AppDelegate (future SDK)** | Plugin can't patch Obj-C++ | Plugin **fails loudly** (multi-line `console.error`); requires a Swift port of the PushKit→CallKit handler. SDK 51 emits Obj-C++ (confirmed Phase 6). |
| **`RNCallKeep` import fails** | Build error `RNCallKeep.h` not found | Quote import `"RNCallKeep.h"` confirmed working Phase 6; fallback `<RNCallKeep/RNCallKeep.h>` if Pods header path changes. |
| **CallKit UUID mismatch** | Answer/end can't find the call | Deterministic UUID identical in JS + native; locked reference vectors prevent drift. `resolveInviteForAction` falls back to freshest pending invite if reverse map empty. |
| **PBX call already gone when user answers** | Answer connects to nothing | On answer, if SIP INVITE is gone (`failed`/no dialog), `endNativeCall` + clean UI. |
| **Voicemail answered before user answers** | Call rolls to VM; CallKit still ringing | SIP `idle`/rollover → `endNativeCall(lingerId)` (iOS guard in `NotificationsContext`). |
| **Network unavailable at wake** | Push wakes, SIP can't register | Report CallKit (rings), then graceful failure on answer if register times out; no crash. |
| **User disabled notifications** | No wake at all | Detectable via permission state; prompt the user; cannot be worked around (Apple policy). |
| **Microphone permission missing** | Rings, answer, no audio | Request mic permission on first call/launch; surface a clear in-call error if denied. |
| **Bluetooth / audio route problems** | Wrong output device | iOS uses `setForceSpeakerphoneOn` (not Android `setSpeakerphoneOn`/`chooseAudioRoute`); BT auto-routes when speaker override released. |
| **Cold-killed cancel-before-answer** (caller hangs up while app still terminated) | CallKit keeps ringing to timeout | **Open gap.** Needs a backend call-cancel wake or reliance on CallKit ring timeout (§6 of the Phase 5 report). |

---

## 9. Logging and proof checklist

To prove wake behavior end-to-end, these logs must be observable per call.

**Backend (worker / API):**
- `incoming call event received` — PBX event accepted, `CallInvite` created (`pbxCallId`,
  `tenantId`, `toExtension`).
- `iOS device selected` — at least one `platform=IOS` device matched.
- `apns_voip_token_selected` — a `voipPushToken` (tail only) chosen.
- `apns_voip_send_attempt` — about to POST to APNs.
- `apns_voip_send_success` — APNs `:status 200` (+ `apnsId`).
- `apns_voip_send_failure` — non-200 / transport error (`status`, `reason`, `error`).
- `apns_voip_token_invalidation_candidate` — `410`/`BadDeviceToken`/`Unregistered` → token nulled.
- `apns_voip_skipped_unconfigured` — iOS devices present but creds absent (devices won't wake).
- Existing `[CALL_TIMELINE] PUSH_SEND` / `PUSH_EXPO_RESPONSE` for the parallel Expo send.

**Mobile native:**
- PushKit token registered (`didUpdatePushCredentials`).
- PushKit push received (`didReceiveIncomingPushWithPayload`).
- Native CallKit report attempted (`reportNewIncomingCall` invoked).
- Native CallKit report success/failure.
- `completion()` called **after** the report.

**Mobile JS:**
- VoIP payload received (`onIncoming`, `callId`).
- Pending invite stored (`safeSetInvite`).
- `answerCall` received (UUID → `callId`).
- `handleAcceptInvite` called.
- SIP/WebRTC connected.
- `endNativeCall` called (which path: decline / cancel / SIP-idle / voicemail).

**Healthy sequence (one iOS device, one call):**
`incoming call event received` → `iOS device selected` → `apns_voip_token_selected` →
`apns_voip_send_attempt` → `apns_voip_send_success (200)` → native push received → native
report success → `completion()` → JS `onIncoming` → invite stored → (Answer) →
`handleAcceptInvite` → SIP connected.

---

## 10. Test plan (physical iPhone 15)

| # | Test | Pass criteria |
|---|------|---------------|
| 1 | **Foreground incoming call** | CallKit UI appears; answer connects two-way audio. |
| 2 | **Background incoming call** | VoIP push wakes; CallKit rings; answer connects. |
| 3 | **Locked-screen incoming call** | Full-screen lock-screen ring; answer/decline from lock screen; audio routes. |
| 4 | **App swiped away / cold-killed** | VoIP relaunches the app; native report rings CallKit; answer connects. |
| 5 | **Caller hangs up before answer** | Foreground/warm: CallKit dismisses on `INVITE_CANCELED`. Cold-killed: rings to CallKit timeout (documented gap). |
| 6 | **Voicemail answers before user** | SIP rollover → CallKit ends cleanly; no stuck UI. |
| 7 | **Answer from lock screen** | Connects + audio without unlock. |
| 8 | **Decline from lock screen** | SIP reject/BYE; CallKit dismisses. |
| 9 | **Bad APNs token** | `410`/`BadDeviceToken` logged; token nulled; re-registers next launch. |
| 10 | **`APNS_PRODUCTION` mismatch** | Reproduce the silent-no-ring; confirm flipping the flag fixes it (regression guard). |
| 11 | **Duplicate Expo + VoIP push** | Exactly one CallKit incoming UI. |
| 12 | **Poor network** | Push wakes; graceful failure if SIP can't register; no crash. |
| 13 | **Bluetooth / speaker / earpiece** | Route toggles work mid-call on iOS (`setForceSpeakerphoneOn`); BT auto-routes. |

Plus regression: login, QR provisioning, dialer/DTMF, contacts, recents, voicemail
playback, chat/SMS, registration status, settings (Android-only items hidden).

---

## 11. Acceptance criteria

"Works" means **all** of the following:

- iPhone rings with the **native CallKit UI on the lock screen** for an inbound call.
- A **swiped-away / cold-killed** app wakes and shows the call.
- **Answering connects the real SIP/WebRTC call** with two-way audio.
- **Declining rejects** the call (PBX notified via the existing reject/BYE path).
- **Caller hangup clears CallKit** (foreground/warm guaranteed; cold-killed via timeout
  until the backend cancel wake lands).
- **Voicemail rollover clears CallKit** (no stuck UI).
- **No duplicate incoming UI** regardless of how many transports deliver the call.
- **Android behavior is unchanged** (42/42 mobile unit tests still pass; no
  `telecom.ts`/FCM/keep-alive edits).
- **All behavior is logged end-to-end** (the §9 chain is observable for a real call).

---

## 12. Implementation gap checklist

Legend: ✅ implemented · 🟡 partial · ❌ missing · ❓ unknown until on-device · 🔒 blocked
by Apple creds/build.

| Area | Status | Notes |
|------|--------|-------|
| EAS `ios-dev-device` profile | ✅ | `eas.json`; physical-device internal distribution. |
| First iOS EAS build / `.ipa` | ✅ | Build `8cd8274e…`, Obj-C++ AppDelegate, team `PR63R6J84J`, iPhone UDID `00008110-001A34A10113801E` provisioned (Phase 6). |
| AppDelegate language = Obj-C++ | ✅ | Confirmed by the EAS compile (Phase 6 §4). |
| `withIosVoipPush.js` native PushKit + report-before-completion | ✅ | Compiled into the binary; `reportNewIncomingCall` ahead of `completion()`. |
| Deterministic `callId`↔UUID (JS + native parity) | ✅ | `callkitUuid.ts` + Obj-C port; locked reference vectors. |
| JS PushKit→CallKit wiring (report/answer/decline/end/dedupe) | ✅ | Phase 4; 42/42 tests; Android preserved. |
| Worker APNs VoIP sender (`apnsVoipPush.ts`) | ✅ | Token-based `.p8` ES256 over Node `http2`; call-only; token invalidation + logs. |
| Worker invokes VoIP send for `INCOMING_CALL` | ✅ | But via the worker's **PBX-poll** path only — see the critical gap below. |
| **Live incoming-call push actually sends a VoIP push** | ❌ **CRITICAL GAP** | The **real-time** incoming-call push for a live call is sent by the **API** (`apps/api/src/server.ts` → its own `sendPushToUserDevices`, which creates the `CallInvite` and sends **Expo-only**). The worker's VoIP sender lives only in `apps/worker` and its poll path is **preempted** by the API-created `PENDING` invite (dedup), so on a normal call **no `apns-push-type: voip` push is ever sent**. This is why the iPhone did not ring during the Phase 7 test even after the worker got `APNS_*`. **Fix:** send the VoIP push from the API's `INCOMING_CALL` path too (share/port `apnsVoipPush.ts`), gated to `platform=IOS` with `voipPushToken`, in addition to the existing Expo send. |
| API container has `APNS_*` env | ❌ | Only the worker container was given `APNS_*`. If the VoIP send moves to (or is duplicated in) the API, the **API** container must also load `APNS_*` from `/opt/connectcomms/env/.env.platform`. |
| `APNS_VOIP_TOPIC` correctness | ❓ **VERIFY** | Must equal `com.connectcommunications.mobile.voip` (double-`m`). Confirm the value set on the server is not the single-`m` web-domain form `com.connectcomunications.mobile.voip`, which APNs rejects with `DeviceTokenNotForTopic`. |
| `APNS_PRODUCTION` matches dev build | ✅ (intended) | Dev/ad-hoc build → `aps-environment: development` → `APNS_PRODUCTION=false` (sandbox). Re-verify on TestFlight. |
| PushKit `voipPushToken` persisted to `MobileDevice` | ✅ | Confirmed in Phase 7 (`platform: IOS`, non-null token). |
| On-device cold-killed ring proven | ❓ | Native report compiled; not yet proven end-to-end on the iPhone because of the API VoIP-send gap above. |
| Audio: playback in silent mode + iOS routing | ✅ (this session) | `initPlaybackAudioSession`, VoicemailTab pre-play mode, `setForceSpeakerphoneOn` in `jssip.ts`/`audioRouteManager.ts`. |
| Cold-killed cancel-before-answer (caller hangup) | ❌ | Needs a backend call-only cancel wake or CallKit ring-timeout reliance. |
| Apple production credentials / TestFlight | 🔒 | Phase 6 cert/profile on team `PR63R6J84J`; production `aps-environment` + submit pending. |
| `ITSAppUsesNonExemptEncryption` | ❌ (minor) | Set in `app.config.ts` to avoid a manual App Store Connect step. |

---

## Final architecture diagram (text)

```
                         ┌───────────────────────────────────────┐
                         │  VitalPBX (inbound INVITE → extension) │
                         └──────────────────┬────────────────────┘
                                            │ PBX/telephony call event
                                            │ (callId, tenantId, extension)
                                            ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │  Connect backend                                                    │
        │                                                                     │
        │   apps/api/src/server.ts  (REAL-TIME path — fires on live calls)    │
        │     • creates CallInvite (PENDING)                                  │
        │     • sendPushToUserDevices(INCOMING_CALL)                          │
        │         ├─ Expo data/alert push  → Android (FCM) + iOS (alert)      │
        │         └─ [REQUIRED, GAP §12] APNs VoIP push → iOS voipPushToken   │
        │                                                                     │
        │   apps/worker/src/main.ts (poll/fallback — preempted by API invite) │
        │     • apnsVoipPush.ts sendApnsVoipPush()  (the VoIP sender today)   │
        └──────────────────┬──────────────────────────────────────────────────┘
                           │  HTTP/2 → api[.sandbox].push.apple.com
                           │  apns-push-type: voip
                           │  apns-topic:  com.connectcommunications.mobile.voip
                           │  apns-priority: 10   apns-expiration: ~now+30s
                           │  body: { callId, tenantId, toExtension,
                           │          callerNumber, callerName, timestamp }
                           ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │  iPhone — foreground / background / locked / swiped-away            │
        │                                                                     │
        │  PKPushRegistry.didReceiveIncomingPushWithPayload  (AppDelegate)    │
        │     1. callId = payload.callId (?? inviteId)                        │
        │     2. uuid   = ConnectDeterministicCallKitUUID(callId)             │
        │     3. [RNCallKeep reportNewIncomingCall: uuid …]  ← RING (native)  │
        │     4. forward payload → RNVoipPushNotificationManager → JS         │
        │     5. completion()           (ONLY after the report)              │
        │                                                                     │
        │  CallKit shows native incoming UI (lock screen) ──── rings ────▶    │
        │                                                                     │
        │  JS onIncoming (voipPush.ts):                                       │
        │     payloadToInvite → dedupe(callId) → showIncomingNativeCall       │
        │     → safeSetInvite (pending; NO SIP)                               │
        │                                                                     │
        │     user taps ANSWER ─▶ CallKeep answerCall(uuid)                   │
        │        └▶ callIdForCallKitUuid(uuid) → handleAcceptInvite(callId)   │
        │             └▶ jsSIP register → answer INVITE → WebRTC media        │
        │                → AVAudioSession active → setCurrentCallActive       │
        │                                                                     │
        │     user DECLINES / call ends / VM rollover / cancel                │
        │        └▶ endCall/idle → handleDeclineInvite / endNativeCall(uuid)  │
        │             → restoreAudioSession                                   │
        └───────────────────────────────────────────────────────────────────┘
```

---

## Remaining implementation phases

**Phase 7a — Close the API VoIP-send gap (CRITICAL, unblocks every live-call test).**
- Send an APNs VoIP push from the API's `INCOMING_CALL` path (`apps/api/src/server.ts`
  `sendPushToUserDevices`) for `platform=IOS` devices with a `voipPushToken`, **in
  addition to** the existing Expo send. Reuse `apps/worker/src/apnsVoipPush.ts` (promote
  it to a shared package, or import/duplicate it into the API).
- Give the **API container** the `APNS_*` env (it reads the same
  `/opt/connectcomms/env/.env.platform`; recreate via the standard deploy).
- **Verify `APNS_VOIP_TOPIC`** = `com.connectcommunications.mobile.voip` (double-`m`).
- Exit: a live inbound call logs `apns_voip_send_success (200)` from the API and the
  iPhone rings (background/locked).

**Phase 7b — On-device live-call verification.**
- Run test matrix §10 #1–4, #7–8, #11 on the iPhone 15; capture the §9 log chain.
- Exit: foreground/background/locked/cold-killed all ring and connect.

**Phase 8 — Cold-killed cancel + hardening.**
- Backend call-only cancel wake so a caller hangup ends a still-terminated CallKit ring;
  poor-network and audio-route edge cases (§10 #5, #6, #9, #12, #13).

**Phase 9 — TestFlight / production.**
- `aps-environment: production` + `APNS_PRODUCTION=true`; ASC key from team `PR63R6J84J`;
  set `ITSAppUsesNonExemptEncryption`; submit.

---

## Exact next recommended Cursor prompt

> Close the iOS incoming-call VoIP-send gap (Phase 7a). In `apps/api/src/server.ts`, the
> real-time PBX-event handler creates the `CallInvite` and calls its own
> `sendPushToUserDevices`, which today sends **Expo only** — so a live call never sends an
> `apns-push-type: voip` push and the iPhone never rings when backgrounded/locked. The
> worker's `apps/worker/src/apnsVoipPush.ts` VoIP sender is correct but its poll path is
> preempted by the API-created PENDING invite. Fix: promote `apnsVoipPush.ts` to a shared
> location (or import it into the API), and in the API's `INCOMING_CALL` branch, after the
> existing Expo send, fan out a VoIP push to every `platform=IOS` device with a non-null
> `voipPushToken` (minimal payload `{ callId: inviteId, tenantId, toExtension,
> callerNumber, callerName, timestamp }`), with the same `apns_voip_*` logging and
> 410/BadDeviceToken/Unregistered token invalidation. Ensure the **API** container loads
> `APNS_*` from `/opt/connectcomms/env/.env.platform`, and verify `APNS_VOIP_TOPIC ==
> com.connectcommunications.mobile.voip` (double-`m` — not the single-`m` web domain).
> Keep VoIP call-only (never for INVITE_CANCELED/MISSED/SMS/voicemail). Do not touch
> Android. Typecheck the API; then deploy the API via the standard blue/green path and
> live-test: lock the iPhone, place a call, confirm `apns_voip_send_success (200)` in the
> API logs and a CallKit ring.

---

*End of incoming-call wake architecture. This is a design document — no application code,
native files, packages, migrations, or deploys were created in producing it.*
