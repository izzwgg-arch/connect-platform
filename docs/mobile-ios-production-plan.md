# Connect Mobile — iOS Production-Readiness Implementation Plan

> **Status:** Planning doc. **Phase 0 (build config) + the backend APNs VoIP
> foundation are now partially implemented** — see
> [`mobile-ios-phase1-implementation-report.md`](./mobile-ios-phase1-implementation-report.md).
> Delivered so far: `ios-dev-device` EAS profile; worker call-only APNs VoIP sender
> (`apps/worker/src/apnsVoipPush.ts`) wired into `INCOMING_CALL`; token invalidation +
> structured logs + dry-run tests. Still pending: Apple credentials, first EAS iOS
> build, and the mobile CallKit/PushKit answer wiring (Phase 4).
> **Source of truth:** [`docs/mobile-ios-current-state.md`](./mobile-ios-current-state.md).
> **App:** `apps/mobile` (`@connect/mobile`, Expo SDK 51 prebuild).
> **Target device:** iPhone 15 (physical device — PushKit/CallKit are not testable on simulator).
> **Build host constraint:** Primary dev machine is Windows + Cursor; all native iOS
> compilation happens on **EAS cloud macOS** (no local Mac required).

---

## 1. Executive Summary

Connect's mobile app ships on Android today with a deep, custom native telecom
stack (self-managed `ConnectionService`, FCM wake services, keep-alive). iOS has
**never been built** — there is no `apps/mobile/ios/` project — but a surprising
amount of iOS *scaffolding* already exists in config and JS (bundle ID, Info.plist
permissions, VoIP background modes, EAS iOS profiles, a PushKit config plugin, a JS
VoIP-push listener, CallKeep iOS setup, and iOS `AVAudioSession` handling).

Making iOS production-ready is **not** a port of the Android native stack. iOS uses
Apple's prescribed model: **APNs VoIP push → PushKit → CallKit → connect SIP/WebRTC
after the user answers**. The shared React Native JS (screens, navigation, theme,
SIP via jsSIP, WebRTC, auth/QR) runs on iOS largely unchanged; the new work is a
thin layer of **iOS service adapters** plus a **backend APNs VoIP delivery path**.

The single hardest blocker is backend-side: the API stores `voipPushToken` but the
worker fans out **Expo push only** and never reads it. Until the worker sends a real
**APNs VoIP push** (`apns-push-type: voip`, topic `<bundleId>.voip`) for inbound
calls, a closed/backgrounded iPhone **cannot wake to ring**. That backend path and
the first EAS iOS prebuild are the two critical-path items everything else depends on.

This plan delivers iOS in **6 phases**: (0) credentials + first build, (1) JS parity
on a running dev build, (2) PushKit token plumbing, (3) backend APNs VoIP, (4) CallKit
incoming-call UX end-to-end, (5) hardening/audio/edge cases, (6) TestFlight/production.

---

## 2. Current State (condensed from source of truth)

**Exists / iOS-ready in principle:**
- `app.config.ts`: `ios.bundleIdentifier = com.connectcommunications.mobile`,
  `supportsTablet: false`, Info.plist usage strings (camera/mic/contacts),
  `UIBackgroundModes: ['voip','remote-notification','audio']`.
- `eas.json`: iOS profiles `dev` (`simulator: true`), `preview`, `production`
  (`autoIncrement: buildNumber`), `credentialsSource: local`.
- `plugins/withIosVoipPush.js`: PushKit/`PKPushRegistryDelegate` patch for
  `AppDelegate.mm` (Obj-C++), sentinel-guarded, runs only at `expo prebuild -p ios`.
- `src/sip/voipPush.ts`: iOS-only VoIP token + incoming-payload listener (no-op on Android).
- `src/sip/callkeep.ts`: `RNCallKeep.setup` includes an `ios` block.
- `src/audio/telephonyAudio.ts`: iOS `AVAudioSession` config (`initAudioSession`/`restoreAudioSession`).
- Shared JS: screens, `@react-navigation`, theme, `jssip`, `react-native-webrtc`,
  auth + QR provisioning + secure store.
- Deps already present: `react-native-callkeep`, `react-native-voip-push-notification`,
  `react-native-webrtc`, `react-native-incall-manager`, `jssip`.

**Missing / blocking:**
- The entire `apps/mobile/ios/` native project (never prebuilt).
- iOS signing assets (`credentials.json` is Android-keystore-only).
- Apple VoIP Services cert / VoIP-capable APNs key (topic `<bundleId>.voip`).
- **Worker APNs VoIP delivery** — worker selects only `expoPushToken`
  (`apps/worker/src/main.ts`); `voipPushToken` is stored but never read; no
  `node-apn`/APNs dependency in `apps/api`.
- iOS audio routing limited to InCallManager fallback (no BT device enumeration).

**Verify-on-first-prebuild risk:**
- Expo SDK 51 may emit a **Swift `AppDelegate`**; `withIosVoipPush.js` patches
  Obj-C++ and **skips with a warning** otherwise. Must confirm before trusting PushKit wiring.

---

## 3. Exact iOS Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  VitalPBX (inbound INVITE for an extension)                                │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  call event (existing PBX → backend signaling)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Connect backend (apps/api + apps/worker)                                  │
│   • Resolve target user's MobileDevice rows                                │
│   • iOS device w/ voipPushToken → APNs VoIP push (NEW worker path)         │
│   • Android device w/ expoPushToken → Expo/FCM (existing)                  │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  HTTP/2 to api.push.apple.com, apns-push-type: voip,
                │  apns-topic: com.connectcommunications.mobile.voip
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  iPhone — even when app is killed/backgrounded                            │
│                                                                            │
│  PushKit (PKPushRegistry) ── didReceiveIncomingPush ─▶ JS VoIP listener    │
│        │                                              (src/sip/voipPush.ts) │
│        │  (Apple REQUIRES a CallKit report on EVERY VoIP push)             │
│        ▼                                                                    │
│  CallKit (CXProvider via react-native-callkeep)                            │
│        • reportNewIncomingCall(uuid, handle)  ← immediately, synchronously │
│        • native full-screen incoming UI (ring, lock screen)               │
│        │                                                                    │
│        ├─ user taps Answer ─▶ CallKeep "answerCall" event                  │
│        │      ▼                                                             │
│        │   SIP/WebRTC CONNECT-AFTER-ANSWER                                  │
│        │      • jsSIP registers (if not already) using provisioning bundle │
│        │      • answer the INVITE / place outbound re-INVITE per design     │
│        │      • react-native-webrtc media; AVAudioSession already primed   │
│        │      • CallKit reportConnected / setActive                        │
│        │                                                                    │
│        └─ user taps Decline / call cancelled ─▶ endCall + SIP cleanup      │
└──────────────────────────────────────────────────────────────────────────┘
```

**Component responsibilities:**

| Component | Role on iOS | Where |
|-----------|-------------|-------|
| **EAS cloud build** | Compile native iOS app on hosted macOS; manage signing | `eas.json`, `eas build -p ios` |
| **APNs VoIP push** | Wake the killed/background app for inbound calls only | NEW `apps/worker` path |
| **PushKit** | Receive VoIP token + incoming-call payload natively | `withIosVoipPush.js` (AppDelegate), `src/sip/voipPush.ts` |
| **CallKit** | System incoming/active-call UI; answer/decline events | `react-native-callkeep` `ios` setup (`src/sip/callkeep.ts`) |
| **SIP/WebRTC connect-after-answer** | Register + answer + media only once the user accepts | `src/sip/jssip.ts`, `react-native-webrtc`, driven from CallKeep answer handler |
| **Shared JS UI** | All screens/nav/theme/auth/QR/dialer/etc. | `src/screens/**`, `src/navigation/**`, `src/theme/**` |
| **iOS service adapters** | Thin platform shims so the existing call pipeline is reused | `src/sip/voipPush.ts`, `src/audio/telephonyAudio.ts`, `audioRouteManager` iOS branch, new CallKit glue |

**Design principle:** reuse the *same* accept/decline/hangup pipeline the Android
path already drives (`handleAcceptInvite` / `handleDeclineInvite` in
`NotificationsContext`). CallKit events become a new *event source* feeding that
existing, well-tested pipeline — mirroring how Android's `telecom.ts` feeds it.

---

## 4. Backend Changes Required (`apps/api` + `apps/worker`)

> Goal: deliver a real APNs VoIP push to iOS devices for **inbound calls only**,
> while leaving the Android Expo/FCM path untouched.

1. **Store the APNs VoIP token correctly.**
   - Confirm `registerMobileDevice` persists `voipPushToken` and `platform = IOS`
     on the `MobileDevice` row (API already accepts it — verify column + write).
   - Ensure token rotation updates the row (re-register on PushKit `register`).

2. **Select `voipPushToken` for iOS incoming calls.**
   - In the worker's inbound-call fan-out, branch by platform:
     - iOS rows → require `voipPushToken` (skip if null) → APNs VoIP path.
     - Android rows → existing `expoPushToken` Expo/FCM path.
   - Today `apps/worker/src/main.ts` selects only `expoPushToken` — extend the
     query/select to include `voipPushToken` + `platform`.

3. **Send the APNs VoIP push from the worker.**
   - Add an APNs HTTP/2 client (e.g. token-based auth with the APNs Auth Key, or a
     library) — **decision pending** (see §11). Payload requirements:
     - `apns-push-type: voip`
     - `apns-topic: com.connectcommunications.mobile.voip`
     - `apns-priority: 10`, short `apns-expiration`
     - Body carries: `inviteId` (UUID shared across CallKit/SIP/in-app), `callerName`,
       `callerNumber`, and any correlation IDs the existing invite flow uses.
   - Environment/secrets: APNs Key ID, Team ID, `.p8` key (or VoIP cert), bundle ID —
     stored as backend secrets, **never** committed (mirror existing secret handling).

4. **Track delivery / failure logs.**
   - Log every VoIP push attempt with `inviteId`, device id, APNs status, and
     `apns-id`. Surface to the same diagnostics channel the call-flow logs use so an
     iOS ring failure is debuggable end-to-end (parity with Android wake diagnostics).

5. **Handle token invalidation.**
   - On APNs `410 Unregistered` / `BadDeviceToken`, mark the device's
     `voipPushToken` stale (null it / flag) so we stop pushing to dead tokens and
     prompt re-registration on next app launch.

6. **Do NOT misuse VoIP pushes for non-call events.**
   - VoIP pushes are reserved **exclusively** for inbound-call invites. Apple
     terminates apps that receive a VoIP push without promptly reporting a CallKit
     call. Voicemail / missed-call / chat / SMS notifications for iOS must use
     **standard APNs alert notifications** (via Expo's iOS push relay or a normal
     APNs alert path) — **never** the VoIP topic.

**Backend acceptance criteria:**
- An inbound call to an iOS-registered extension results in exactly one VoIP push
  to that device's current token, logged with delivery status, and no VoIP pushes
  are ever emitted for voicemail/chat/missed events.

---

## 5. Mobile Changes Required (`apps/mobile`)

1. **First iOS prebuild via EAS / hosted macOS.**
   - Generate `ios/` through the EAS build pipeline (no local Mac). This both
     creates the native project and exercises `withIosVoipPush.js`.

2. **Verify generated `AppDelegate` language.**
   - Inspect the EAS-generated `AppDelegate` (`.mm` vs `.swift`). If Obj-C++, confirm
     the `CONNECT_VOIP_PUSH_BEGIN`/`END` sentinels were injected and PushKit is wired.

3. **Fix the config plugin if a Swift AppDelegate is generated.**
   - If SDK 51 emits Swift, update `withIosVoipPush.js` to patch the Swift AppDelegate
     (PushKit registration + `PKPushRegistryDelegate` forwarding to
     `RNVoipPushNotificationManager`) — the plugin currently warns and skips for Swift.

4. **Verify entitlements.**
   - `aps-environment` (development → production), Push Notifications capability,
     and that `UIBackgroundModes` includes `voip` + `remote-notification` + `audio`
     in the *generated* Info.plist (not just config). Confirm via EAS credentials /
     the generated entitlements plist (`withEntitlementsPlist` hook is reserved for this).

5. **Register the PushKit token.**
   - Confirm `initVoipPushListener` fires `register`, caches the hex token
     (`getCachedVoipPushToken`), and `NotificationsContext` re-registers the
     `MobileDevice` with `voipPushToken` when it arrives late (logic already present —
     validate on a real device).

6. **Report the incoming call to CallKit immediately.**
   - On `didReceiveIncomingPush`, synchronously call
     `RNCallKeep.displayIncomingCall(inviteId, handle, ...)` **before** any async work,
     to satisfy Apple's "report on every VoIP push" rule and avoid termination.

7. **Connect SIP/WebRTC after the user answers.**
   - Wire the CallKeep `answerCall` event into the existing `handleAcceptInvite`
     pipeline: ensure jsSIP is registered (using the stored provisioning bundle),
     answer the INVITE, establish WebRTC media, prime `AVAudioSession`
     (`initAudioSession` already exists), and call CallKit `setCurrentCallActive`.

8. **End the CallKit call when the PBX call ends or voicemail answers.**
   - On SIP `ended`/`failed`/`BYE`, remote cancel, or rollover-to-voicemail, call
     `RNCallKeep.endCall(inviteId)` + `restoreAudioSession()` so the system UI tears
     down cleanly (parity with Android `terminateTelecomCall`).

**Mobile acceptance criteria:**
- Dev build installs on iPhone 15; PushKit token registers to backend; an inbound
  call shows the native CallKit screen; Answer connects two-way audio; all
  termination paths dismiss the CallKit UI without orphaned calls.

---

## 6. Android Parity Checklist (validate each on the iOS dev build)

| Area | Parity target on iOS | Notes |
|------|----------------------|-------|
| Login (email/password) | ✅ identical JS | Shared `AuthContext`/`LoginScreen` |
| QR login / provisioning | ✅ identical JS | Verify `expo-camera` permission prompt on iOS |
| Dialer / keypad | ✅ identical JS | DTMF tones via `expo-av` (cross-platform) |
| Contacts | ✅ identical JS | Verify `expo-contacts` read + `saveIos` write path |
| Recents / call history | ✅ identical JS | API-driven |
| Voicemail | ✅ identical JS | Playback via `expo-av`; iOS notif = standard alert |
| SMS / messages / chat | ✅ identical JS | iOS notif = standard alert push, not VoIP |
| Active call screen | ✅ identical JS + iOS audio | Mute/hold/DTMF/speaker; validate audio routing |
| Incoming call screen | 🔧 CallKit-driven | Native CallKit replaces Android self-managed UI |
| Missed calls | 🔧 standard alert | Ensure missed-call notification fires on iOS |
| Registration status | ✅ identical JS | Diagnostics screen; verify SIP re-register on foreground |
| Settings | ✅ identical JS | Hide Android-only items (battery-opt, full-screen-intent) on iOS |
| Audio route behavior | 🔧 iOS-specific | InCallManager path; earpiece/speaker/BT/lock-screen |

Legend: ✅ runs as-is (verify), 🔧 needs iOS-specific work/validation.

---

## 7. iPhone Closed-App Incoming Call Flow (target behavior)

1. **PBX detects inbound call** — VitalPBX receives an INVITE for the user's extension.
2. **Backend worker receives the event** — existing PBX→backend signaling resolves the
   target user's `MobileDevice` rows.
3. **Worker sends APNs VoIP push** — for the iOS row with a valid `voipPushToken`:
   HTTP/2 to APNs, `apns-push-type: voip`, topic `<bundleId>.voip`, payload with
   `inviteId` + caller identity. (Android row → Expo/FCM in parallel.)
4. **iOS wakes the app** — PushKit delivers `didReceiveIncomingPush` to the (killed)
   app; native side boots JS and forwards to `src/sip/voipPush.ts`.
5. **App reports the call to CallKit immediately** — `displayIncomingCall(inviteId,…)`
   synchronously; the system shows the full-screen/lock-screen ringing UI. (Mandatory
   per Apple, or iOS kills the app.)
6. **User answers** — CallKeep `answerCall` fires; app brings up the in-call context.
7. **App connects SIP/WebRTC** — jsSIP ensures registration from the stored
   provisioning bundle, answers the INVITE, establishes WebRTC media, primes
   `AVAudioSession`, and marks the CallKit call active → two-way audio.
8. **Call ends cleanly** — on hangup/BYE/cancel/voicemail rollover, app calls
   `endCall(inviteId)` + `restoreAudioSession()`; CallKit UI dismisses; no orphaned
   call or stuck audio session.

**Failure branches to design for:** caller cancels before answer (CallKit must
auto-dismiss), push arrives but SIP can't register (report failed call + clean UI),
duplicate pushes (dedupe by `inviteId`).

---

## 8. Development Workflow Without a Mac

- **Editor / JS:** Windows + Cursor for all React Native/TypeScript and backend work.
- **Native compilation:** **EAS cloud build** (hosted macOS) — no local Xcode needed.
- **Apple Developer account:** required (paid, $99/yr) for device installs, push
  capability, VoIP topic, and TestFlight. EAS manages signing (distribution cert,
  provisioning profile, push key) via `eas credentials`.
- **Install dev build on iPhone 15:** EAS produces an installable **internal
  distribution** dev-client build; install via the EAS install URL/QR (device must be
  registered in the provisioning profile — EAS handles UDID registration in the
  internal flow, or register the device once).
- **Run Metro from Windows:** `npx expo start --dev-client` (or existing
  `pnpm start:dev-client`). The dev-client app on the iPhone connects to the Windows
  Metro over LAN.
- **Live JS iteration:** edit in Cursor → Metro hot-reloads on the device. Only changes
  that touch **native modules / config plugins / entitlements** require a new EAS build;
  pure JS/TS changes do not.

**Practical loop:** one EAS dev build per native change set; otherwise stay in the
Metro live-reload loop for JS. Push/CallKit must be tested on the **physical iPhone**
(not simulator).

---

## 9. First Build Commands (for the implementation phase — do not run yet)

> Run from `apps/mobile/`. Listed for the plan; **not executed** during planning.

```bash
# 1. Authenticate with Expo/EAS
eas login

# 2. Inspect / set up iOS credentials (distribution cert, provisioning profile,
#    push key, VoIP topic). EAS will offer to generate what's missing.
eas credentials            # choose iOS → review/create

# 3. First iOS dev build (generates ios/ on hosted macOS, simulator profile off
#    for device install; use a device internal-distribution dev profile).
eas build --platform ios --profile dev

# 4. Install on iPhone 15
#    → open the EAS build URL / scan the QR from the CLI output on the device,
#      or use the Expo Orbit / install link for internal distribution.

# 5. Start Metro from Windows and connect the dev client
npx expo start --dev-client
# (equivalently: pnpm start:dev-client)
```

> Note: `eas.json`'s `dev` profile currently has `ios.simulator: true`. For a
> **physical** iPhone 15 install, a device-targeted internal-distribution profile is
> needed — flagged as a config decision in Phase 0 (no change made yet).

---

## 10. Testing Matrix (physical iPhone 15 unless noted)

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | Foreground incoming call | CallKit UI appears; answer connects audio |
| 2 | Background incoming call (app backgrounded) | VoIP push wakes; CallKit rings; answer connects |
| 3 | Killed / swiped-away incoming call | VoIP push wakes from terminated state; CallKit rings; answer connects |
| 4 | Outgoing call | Dial → ringback → remote answer → two-way audio; CallKit active call |
| 5 | Missed call | Caller cancels / no answer → CallKit dismisses; missed-call notification (standard alert) |
| 6 | Voicemail answer (rollover) | PBX sends to VM → CallKit ends cleanly; no stuck UI |
| 7 | Call cancellation before answer | CallKit auto-dismisses on remote cancel; no orphan |
| 8 | Poor network | Push still wakes; graceful failure UI if SIP can't register; no crash |
| 9 | Bluetooth | Audio routes to BT on answer; toggle works; reconnect handling |
| 10 | Speaker | Speaker toggle works mid-call (InCallManager path) |
| 11 | Lock screen | Ring + answer from lock screen; audio routes correctly; clean teardown |

Plus regression: login, QR provisioning, dialer/DTMF, contacts read/write, recents,
voicemail playback, chat/SMS, registration status, settings (Android-only items hidden).

---

## 11. Risks & Unknowns

1. **AppDelegate language (Obj-C++ vs Swift).** SDK 51 may emit Swift; the plugin
   patches Obj-C++ only. **Mitigation:** verify on first prebuild; budget time to
   port the plugin to Swift if needed (Phase 0/4 blocker).
2. **APNs client choice in the worker.** Token-based `.p8` auth vs VoIP cert; library
   vs raw HTTP/2. **Mitigation:** decide early; token-based `.p8` is generally simplest
   and supports the VoIP topic.
3. **`eas.json` dev profile targets simulator.** Physical-device install needs a
   device internal-distribution profile + UDID registration. **Mitigation:** add a
   device dev profile in Phase 0.
4. **Apple "report-on-every-VoIP-push" rule.** Any path that receives a VoIP push and
   fails to report a CallKit call risks app termination / push throttling.
   **Mitigation:** report to CallKit synchronously, always; never send VoIP for non-calls.
5. **SIP register latency after wake.** Cold-start jsSIP registration may add answer
   latency. **Mitigation:** connect-after-answer + measure; consider pre-register on
   push receipt before the user answers (Android already does an analogous pre-register).
6. **Audio routing parity.** iOS lacks the Android native router; relies on
   InCallManager with no BT enumeration. **Mitigation:** validate BT/speaker/earpiece
   explicitly (matrix #9–11); accept reduced device-list fidelity initially.
7. **Apple Developer account / capabilities provisioning lead time.** VoIP topic, push
   key, device registration. **Mitigation:** front-load in Phase 0.
8. **Token rotation & invalidation correctness.** Stale `voipPushToken` → silent ring
   failures. **Mitigation:** APNs 410 handling + re-register on launch.
9. **Background JS boot reliability from terminated state.** PushKit→JS boot timing.
   **Mitigation:** keep the native CallKit report independent of JS where possible;
   test scenario #3 heavily.
10. **TestFlight review / VoIP entitlement scrutiny.** Apple reviews VoIP usage.
    **Mitigation:** ensure CallKit integration is genuine and documented.

---

## 12. Recommended Build Order (Phased)

**Phase 0 — Credentials & First Build (unblocks everything)**
- Apple Developer account + App ID `com.connectcommunications.mobile` with Push +
  VoIP enabled; generate APNs Auth Key (`.p8`).
- `eas credentials` for iOS (dist cert, provisioning profile, push key).
- Add a device-targeted internal-distribution iOS dev profile to `eas.json`.
- First `eas build -p ios --profile dev`; install on iPhone 15.
- **Verify AppDelegate language + PushKit injection.** Fix plugin if Swift.
- Exit: app launches on device; Metro connects via `--dev-client`.

**Phase 1 — Shared JS Parity (no push yet)**
- Walk the Android parity checklist (§6) on the running dev build.
- Hide/adjust Android-only settings; verify contacts/camera/permissions prompts.
- Exit: all non-call screens work on iOS; outbound call works in foreground.

**Phase 2 — PushKit Token Plumbing**
- Confirm PushKit `register` → cached token → `registerMobileDevice(voipPushToken)`.
- Verify token persisted on `MobileDevice` (platform IOS) in the backend.
- Exit: a real device's VoIP token is in the DB, rotation updates it.

**Phase 3 — Backend APNs VoIP Delivery** — ✅ *foundation implemented (Phase 1 work)*
- ✅ APNs HTTP/2 client (Node built-in, no new deps) + token-based `.p8` ES256 JWT
  (`apps/worker/src/apnsVoipPush.ts`); worker selects iOS `voipPushToken`.
- ✅ VoIP push for inbound calls only; delivery/failure logging + 410/Unregistered
  token invalidation.
- ⏳ Remaining: set Apple credential env vars; verify against a real device with a live
  inbound call (needs Phase 0 build + Apple creds).
- Exit: inbound call to iOS extension delivers a logged VoIP push (verified via logs).

**Phase 4 — CallKit Incoming-Call UX End-to-End** — ✅ *JS wiring done*
- ✅ JS: `onIncoming` → CallKit report (deduped, UUID-mapped) → answer → connect
  SIP/WebRTC via existing `handleAcceptInvite` → end CallKit on decline/cancel/SIP-idle.
  Android preserved; 42/42 mobile tests pass. See
  [`mobile-ios-phase4-callkit-pushkit-report.md`](./mobile-ios-phase4-callkit-pushkit-report.md).

**Phase 5a — Cold-Killed PushKit → CallKit (native report)** — ✅ *Implemented; pending first EAS build to verify AppDelegate language*
- ✅ Native: `withIosVoipPush.js` AppDelegate patch now calls
  `[RNCallKeep reportNewIncomingCall:…]` **before the PushKit completion handler**
  for guaranteed cold-killed ringing.
- ✅ **Deterministic** CallKit UUID derived from `callId` (FNV-1a-32), identical in
  JS (`src/sip/callkitUuid.ts`) and native — so native and JS reconcile with no
  shared state. 7/7 UUID unit tests; native parity locked by reference vectors.
- ✅ Obj-C++ AppDelegate fully patched + verified; Swift/unknown AppDelegate
  **fails loudly** (no silent no-op).
- ⏳ Verify scenarios #1–3, #5, #7 on a real device once Phase 0 build exists;
  cold-killed cancel-before-answer needs a future backend "call canceled" signal.
- See [`mobile-ios-phase5-cold-killed-callkit-report.md`](./mobile-ios-phase5-cold-killed-callkit-report.md).
- Exit: closed-app incoming call rings and connects reliably.

**Phase 5b — Hardening: Audio, Edge Cases, Poor Network**
- Bluetooth/speaker/lock-screen routing (#9–11); voicemail rollover (#6); poor network (#8).
- Pre-register-on-push latency optimization if needed.
- Exit: full testing matrix green.

**Phase 6 — TestFlight / Production**
- `preview` then `production` EAS profiles; entitlements dev→prod (`aps-environment`).
- Update `credentials.json`/EAS with production signing; submit to TestFlight.
- Exit: external testers validate; ready for App Store submission.

---

## Ready-for-Implementation Checklist

Implementation may begin once these are confirmed (this plan does **not** start them):

- [ ] Apple Developer Program membership active.
- [ ] App ID `com.connectcommunications.mobile` created with **Push Notifications** + **VoIP** capabilities.
- [ ] APNs Auth Key (`.p8`) generated; Key ID + Team ID recorded as backend secrets.
- [ ] Expo/EAS account access confirmed (`eas login` works); project ID `53c72ced-180c-4885-a3ff-7d5da5717ead` matches.
- [ ] iPhone 15 available as a physical test device (UDID ready for registration).
- [x] APNs client approach decided + implemented: token-based `.p8` ES256 JWT over Node built-in HTTP/2 (no new deps) — `apps/worker/src/apnsVoipPush.ts`.
- [x] Device-targeted iOS internal-distribution dev profile added to `eas.json` (`ios-dev-device`, Phase 0/1).
- [ ] Owner assigned for backend APNs path (`apps/worker`) and for mobile CallKit glue (`apps/mobile`).
- [ ] Agreement that VoIP pushes are call-only; voicemail/chat/missed use standard alert notifications.
- [ ] Phase 0 scheduled first (credentials + first EAS build + AppDelegate-language verification) as the critical-path gate.

> When every box is checked, proceed to **Phase 0**. No code, packages, native
> generation, or EAS builds should be initiated before that gate is explicitly opened.

---

*End of implementation plan. Planning only — no code changes, package installs,
native generation, or EAS builds were performed.*
