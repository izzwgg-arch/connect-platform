# Connect Mobile — iOS Current State (Discovery Report)

> **Scope:** Read-only investigation of where the iOS build of the Connect mobile
> app currently stands. No code was modified, no packages installed, no prebuild
> or native generation was run. Date: 2026-06-21.
>
> **App location:** `apps/mobile` (pnpm workspace package `@connect/mobile`).
>
> **UPDATE (2026-06-21, Phase 0/1):** Two items below have changed since this
> discovery. (1) `eas.json` now has a physical-iPhone profile `ios-dev-device`
> (the simulator-only `dev` profile remains). (2) The **backend APNs VoIP
> foundation now exists** — the worker sends a call-only APNs VoIP push for
> `INCOMING_CALL` to iOS devices with a `voipPushToken` (`apps/worker/src/apnsVoipPush.ts`),
> so the "worker only fans out Expo push" blocker is **partially resolved**
> (still needs Apple creds + the mobile CallKit answer wiring). See
> [`mobile-ios-phase1-implementation-report.md`](./mobile-ios-phase1-implementation-report.md).
>
> **UPDATE (2026-06-21, Phase 4):** The **mobile PushKit→CallKit wiring is now
> implemented in JS** — the iOS VoIP `onIncoming` handler reports the call to
> CallKit (with a valid callId↔UUID mapping + Expo/VoIP dedupe), and the existing
> answer/decline pipeline (`handleAcceptInvite`/`handleDeclineInvite`) connects
> SIP/WebRTC only after Answer; CallKit ends on decline/cancel/SIP-idle. Android
> untouched (42/42 mobile tests pass). See
> [`mobile-ios-phase4-callkit-pushkit-report.md`](./mobile-ios-phase4-callkit-pushkit-report.md).
>
> **UPDATE (2026-06-21, Phase 5):** The **native cold-killed path is now
> implemented**. `plugins/withIosVoipPush.js` patches the AppDelegate so the
> PushKit handler calls `[RNCallKeep reportNewIncomingCall:…]` **before the
> completion handler returns** (Apple's requirement for terminated-app wake). The
> CallKit UUID is now **deterministically derived from `callId`** (FNV-1a-32) by
> an identical algorithm in JS (`src/sip/callkitUuid.ts`) and native, so the two
> reconcile with no shared state (7/7 UUID unit tests; native parity locked by
> reference vectors). Obj-C++ AppDelegate is fully patched + verified; a Swift or
> unknown AppDelegate **fails loudly** instead of silently no-op'ing. **Remaining:**
> Apple creds + first EAS `ios-dev-device` build to confirm the generated
> AppDelegate language and exercise a live cold-killed call; cold-killed
> cancel-before-answer needs a future backend "call canceled" signal. See
> [`mobile-ios-phase5-cold-killed-callkit-report.md`](./mobile-ios-phase5-cold-killed-callkit-report.md).
>
> **UPDATE (2026-06-28, Server VoIP shipped):** The "backend never sends APNs
> VoIP" blocker called out below is **resolved**. The APNs VoIP sender now lives
> in [`packages/shared/src/apnsVoipPush.ts`](../packages/shared/src/apnsVoipPush.ts)
> (moved out of `apps/worker`) and is invoked by **both** the API (live path
> `/internal/mobile-ring-notify` → `sendPushToUserDevices`) and the worker
> (PBX-poll fallback). For an `INCOMING_CALL`, iOS devices with a stored
> `voipPushToken` get **both** an Expo data push and a direct
> `apns-push-type: voip` push, gated only by the `APNS_TEAM_ID` / `APNS_KEY_ID` /
> `APNS_AUTH_KEY_*` env vars (`isApnsVoipConfigured()`). Treat every "worker only
> sends Expo push" / "server VoIP is a TODO" statement in §4/§6/§8 below as
> **outdated**.
>
> **UPDATE (2026-06-28, iOS DND parity):** Do-Not-Disturb now suppresses
> incoming calls on iOS, matching Android — implemented **without touching any
> Android-shared file** (all changes are in the iOS-only `src/sip/voipPush.ts`
> and the iOS-only `plugins/withIosVoipPush.js`):
> - JS mirrors the DND flag into native `NSUserDefaults` (`connect_dnd`) via a
>   new `ConnectDnd` RN bridge module, subscribed to `dndStore` changes from
>   `voipPush.ts` (so `dndStore.ts` itself is unmodified).
> - The PushKit handler in `withIosVoipPush.js` reads `connect_dnd` and, when on,
>   does the Apple-required `reportNewIncomingCall` then immediately
>   `endCallWithUUID:reason:` (Unanswered) and skips waking JS — so a
>   cold-killed/background iPhone never rings and the call times out to
>   voicemail.
> - Warm/background VoIP pushes are also guarded in `voipPush.ts`
>   (`onNotification` → `endNativeCall` + skip in-app UI when `getDnd()`).
> - Foreground DND continues to rely on the existing, **unchanged**
>   cross-platform SIP 486 decline in `src/sip/jssip.ts`.
> - **Remaining:** ships only on the next EAS `ios-dev-device` build (native
>   plugin changes don't hot-reload); the JS guard works on the current build.

---

## TL;DR

- **iOS does NOT exist as a buildable target today.** There is **no `apps/mobile/ios/`
  folder**, no Xcode project, no `Podfile`, no `AppDelegate`, no `Info.plist`. Git
  history confirms an iOS native project has **never been committed** (and `ios/`
  is **not** in `.gitignore`).
- The app is **Expo "prebuild" (bare-ish) for Android only**: a committed
  `android/` folder exists with extensive **custom native modules**, while iOS has
  only **declarative config + JS-level scaffolding** that has never been
  materialized into a native project.
- **iOS config and JS plumbing are surprisingly complete** (bundle ID,
  Info.plist permissions, VoIP background modes, a PushKit/VoIP config plugin,
  CallKit-via-CallKeep wiring, iOS audio-session handling, iOS contacts write).
- **The native incoming-call experience is Android-only.** Android uses a custom
  self-managed `ConnectionService`/Telecom stack; the iOS equivalent (CallKit +
  PushKit VoIP push) is **wired in JS/plugin but unproven and the server-side
  delivery path does not exist**.
- The **backend never sends APNs VoIP pushes** — it only sends **Expo push**
  (`exp.host/--/api/v2/push/send`) and the worker selects **only** `expoPushToken`,
  ignoring the stored `voipPushToken`. So the iOS killed/background wake-to-ring
  chain is incomplete end-to-end.

---

## 1. Does iOS exist today?

**No — not as a native target.** What exists is split across three layers:

| Layer | iOS status |
|-------|-----------|
| Native project (`ios/`) | ❌ Absent. No `.xcodeproj`, `.xcworkspace`, `Podfile`, `AppDelegate`, `Info.plist`. |
| Declarative config (`app.config.ts`) | ✅ Present — `ios` block with bundle ID, permissions, background modes. |
| EAS build profiles (`eas.json`) | ✅ Present — `ios.simulator`, `resourceClass`, `autoIncrement` per profile. |
| JS feature plumbing (`src/**`) | 🔶 Partial — iOS branches exist but several are no-ops or fallbacks. |
| Config plugin for iOS VoIP (`plugins/withIosVoipPush.js`) | ✅ Written, but only runs at `expo prebuild -p ios`, which has never been run/committed. |

Git evidence:
- `git log --all --diff-filter=A -- "apps/mobile/ios/*"` → **empty** (folder never added).
- Glob for `Podfile / *.xcodeproj / *.xcworkspace / AppDelegate* / Info.plist` under `apps/mobile` → **0 files**.
- No iOS-specific branches exist (`git branch -a` shows only Android/telephony/CRM branches).

The README states it plainly: *"Premium **Android** softphone app built with Expo SDK 51."*

---

## 2. Managed / Prebuild / Bare?

**Expo SDK 51 "prebuild" (Continuous Native Generation), currently realized for Android only.**

- Evidence of prebuild (not pure managed): a committed `apps/mobile/android/` native
  project with Gradle, `MainApplication.kt`, and many bespoke Kotlin/Java modules.
- Evidence it is still Expo-driven (not fully ejected/bare): `app.config.ts` +
  config plugins generate native config; `expo`, `expo-dev-client`, `expo-updates`
  are all present; native folders are regenerated by `expo prebuild`.
- iOS would be created by running `expo prebuild --platform ios` (script
  `prebuild:ios` exists) — **but it has never been run/committed.**

---

## 3. Key configuration files reviewed

| File | Notes |
|------|-------|
| `apps/mobile/package.json` | Scripts include `ios`, `build:ios:*`, `prebuild:ios`. iOS-relevant deps present (see §4). |
| `apps/mobile/app.config.ts` | Full `ios` block: `bundleIdentifier: com.connectcommunications.mobile`, `supportsTablet: false`, Info.plist usage strings, `UIBackgroundModes: ['voip','remote-notification','audio']`. Plugins include `./plugins/withIosVoipPush`. |
| `apps/mobile/eas.json` | `dev` (simulator build), `preview`, `production` (`autoIncrement: buildNumber`). `credentialsSource: local`. |
| `apps/mobile/credentials.json` | **Android keystore only** — no iOS distribution cert/provisioning profile config. |
| `apps/mobile/metro.config.js` | Platform-agnostic; Windows-tuned watch folders + `@connect/shared` resolver. Works for iOS as-is. |
| `apps/mobile/index.js` | Registers Android-oriented headless tasks (`backgroundCallTask`, `sipPreRegisterHeadlessTask`) before root component. |
| `apps/mobile/plugins/withIosVoipPush.js` | iOS-only config plugin that patches `AppDelegate.mm` for PushKit; **only effective after an iOS prebuild**. |
| `apps/mobile/plugins/withIncomingCallService.js` | Android-only incoming-call service wiring. |
| `android/` | Fully prebuilt with custom native modules (see §6). **No iOS counterpart.** |

---

## 4. iOS dependencies, IDs, permissions, push/VoIP setup

**Bundle identifier:** `com.connectcommunications.mobile` (same string used for Android `package`).

**iOS Info.plist (declared in `app.config.ts`):**
- `NSCameraUsageDescription` (QR provisioning)
- `NSMicrophoneUsageDescription` (voice calls)
- `NSContactsUsageDescription` (contact import)
- `UIBackgroundModes: ['voip', 'remote-notification', 'audio']`

**iOS-capable native libraries already in `package.json`:**
- `react-native-callkeep` ^4.3.13 — CallKit bridge (also Android via Wazo service)
- `react-native-voip-push-notification` ^3.3.3 — PushKit VoIP token + payload
- `react-native-webrtc` ^124.0.5 — media engine (cross-platform)
- `react-native-incall-manager` ^4.0.0 — audio routing fallback (iOS path used)
- `jssip` ^3.10.1 — SIP signaling (cross-platform JS)
- `expo-notifications`, `expo-av`, `expo-contacts`, `expo-camera`, `expo-secure-store`, etc.

**VoIP / CallKit / PushKit setup status:**
- `plugins/withIosVoipPush.js` injects PushKit registration + `PKPushRegistryDelegate`
  forwarding into the (not-yet-generated) `AppDelegate.mm`. Idempotent, sentinel-guarded.
- `src/sip/voipPush.ts` — iOS-only listener (`initVoipPushListener`) that captures the
  VoIP hex token and forwards incoming PushKit payloads. **No-op on Android.**
- `src/sip/callkeep.ts` — `RNCallKeep.setup` includes an `ios` block (`appName`,
  `supportsVideo: false`). Used for native call UI.
- The plugin's own header documents the **three missing external pieces**:
  1. Apple VoIP Services cert / VoIP-capable APNs key (topic `<bundleId>.voip`).
  2. AppDelegate PushKit wiring (only applied at prebuild — never run).
  3. **Server-side APNs VoIP delivery** — explicitly marked `TODO in apps/worker`.

**Backend push reality (confirms the gap):**
- `apps/api/src/server.ts` stores `voipPushToken` on the `MobileDevice` row
  (registration accepts it) but pushes go out via **Expo** only
  (`https://exp.host/--/api/v2/push/send`).
- `apps/worker/src/main.ts` selects **only** `expoPushToken` when fanning out
  notifications (`select: { expoPushToken: true }`) — the stored `voipPushToken`
  is **never read** and **no APNs/PushKit path exists** (no `node-apn`/`apns`
  dependency anywhere in `apps/api`).
- Net effect on iOS: even with a correct native build, **inbound calls would not
  wake a killed/backgrounded iOS app via CallKit**, because no VoIP push is ever sent.

---

## 5. SIP / WebRTC platform handling

- **Signaling/media are cross-platform** (`jssip` + `react-native-webrtc`) and would
  run on iOS unchanged.
- **Audio session:** `src/audio/telephonyAudio.ts` has a proper **iOS `AVAudioSession`**
  path (`initAudioSession`/`restoreAudioSession` configure `allowsRecordingIOS`,
  `playsInSilentModeIOS`, `staysActiveInBackground`); Android intentionally skips it.
- **Audio routing:** `src/audio/audioRouteManager.ts` is **Android-first** — the native
  router (`NativeModules.IncomingCallUi.routeAudioTo*`) is Android-only; iOS falls back
  to `react-native-incall-manager` (`chooseAudioRoute` / `setSpeakerphoneOn`). Device
  enumeration (`getAudioDevicesSnapshot`) returns inert defaults on iOS, so BT/wired
  auto-switching logic is effectively Android-only.
- **Telecom layer:** `src/sip/telecom.ts` (self-managed `ConnectionService` bridge) is
  **fully Android-only** (`if (Platform.OS !== "android") return`). iOS has no equivalent
  beyond the CallKeep/CallKit path.

---

## 6. Android vs iOS implementation comparison

### Shared / cross-platform (works on iOS once a native build exists)
- **Screens** (`src/screens/**`): auth (Welcome/Login/QR), call (Active/Incoming/Transfer/
  CallsDrawer/CallWaitingBanner), tabs (Keypad/Recent/Contacts/Team/Chat/Voicemail),
  Settings, Diagnostics, Home, Dialpad, CallHistory — all RN/JS, platform-agnostic.
- **Navigation** (`@react-navigation/*`, `RootNavigator`, `TabNavigator`) — shared.
- **Theme/styles** (`src/theme/*`) — shared, no platform forks.
- **SIP registration / outbound / DTMF / mute / hold** — shared JS (`jssip.ts`).
- **Auth + QR provisioning + secure store** — shared.

### Android-only (no iOS counterpart today)
| Capability | Android implementation | iOS today |
|-----------|------------------------|-----------|
| Native incoming-call UI | Custom self-managed Telecom: `TelecomBridge.kt`, `ConnectConnectionService.kt`, `ConnectIncomingConnection.kt`, `IncomingCallUiModule.kt` | None (would rely on CallKit via CallKeep, unbuilt/unproven) |
| Killed-app wake-to-ring | `IncomingCallFirebaseService.java` + FCM + `sipPreRegisterHeadlessTask` + headless JS | Designed for PushKit VoIP, but **no native build + no server VoIP push** |
| SIP keep-alive / pre-register | `SipKeepAliveService.kt`, `SipPreRegisterTaskService.kt`, `KeepAliveRestartReceiver.kt`, `BootReceiver.kt` | None (iOS uses VoIP push model instead) |
| In-call notification actions | `InCallNotificationReceiver.kt`, `ChatReplyReceiver.java` | None native |
| Audio routing (BT/earpiece/speaker) | Native `IncomingCallUi` AudioManager methods | InCallManager fallback only |
| Device contacts read/write | `DeviceContactsModule.kt` + expo-contacts | expo-contacts `saveIos` path exists (JS) |
| Battery-optimization / full-screen-intent prompts | Android settings intents | No-op on iOS (correctly guarded) |
| Push channels | 4 Android notification channels (calls/messages/voicemail/missed) pre-declared | iOS uses APNs categories — not configured |

### Push notifications (calls / voicemail / missed / messages)
- **Android:** Expo push token → FCM → `IncomingCallFirebaseService` → native call UI;
  rich channels for calls/messages/voicemail/missed-calls.
- **iOS:** Would receive **standard Expo remote-notification** (foreground/short
  background) but **NOT** VoIP/CallKit wake. The intended VoIP push path is
  scaffolded (token captured, registered to backend) but **the backend never emits
  APNs VoIP**, so the high-value "ring while killed" behavior is non-functional.

### Background behavior
- **Android:** foreground services + headless JS + boot receiver keep SIP alive and
  wake on incoming pushes.
- **iOS:** relies on `UIBackgroundModes: voip` + PushKit (Apple's model). None of it is
  exercised because there is no native build and no VoIP push sender.

---

## 7. Git history findings

- **No iOS native project ever committed** (`--diff-filter=A` on `apps/mobile/ios/*` empty).
- **No iOS-specific branches** (only Android/telephony/CRM/billing branches).
- `ios/` is **not** in `apps/mobile/.gitignore` — so its absence is genuine, not hidden.
- iOS support has been built **proactively in config/JS** (the `withIosVoipPush` plugin
  and `voipPush.ts` are thoroughly documented with a post-prebuild checklist), but the
  native materialization step and server VoIP path were never completed.
- Recent mobile commit history is entirely Android/feature-focused (chat polish, voice
  notes, ring vibration, warm answer, battery prompt) — no iOS work.

---

## 8. What is built / missing / broken-or-outdated (summary)

**Already built (iOS-ready in principle):**
- Bundle ID, Info.plist permissions, VoIP/remote-notification/audio background modes.
- EAS iOS build profiles (simulator + device, autoIncrement build number).
- iOS VoIP-push config plugin + JS listener + CallKeep iOS setup.
- iOS audio-session handling and iOS contacts-write path.
- All shared UI/navigation/theme/SIP/WebRTC JS.

**Missing:**
- The entire `apps/mobile/ios/` native project (never prebuilt).
- iOS signing assets in `credentials.json` (Apple cert / provisioning profile) — Android only today.
- Apple VoIP Services certificate / VoIP-capable APNs key (topic `<bundleId>.voip`).
- **Server-side APNs VoIP delivery in `apps/worker`** (the documented `TODO`).
- iOS-side equivalents of Android's native call UI, keep-alive, and in-call notification actions (by design these use CALLKit/PushKit on iOS, which is unbuilt).
- CocoaPods install / macOS build host (cannot build iOS on this Windows workstation).

**Broken / outdated risks to validate after first prebuild:**
- `withIosVoipPush.js` fully patches an Objective-C++ `AppDelegate.mm` (the SDK 51
  default) and **verifies** the patch applied (logs success). If Expo emits a Swift
  `AppDelegate`, the plugin **fails loudly** (multi-line `console.error`) instead of
  silently skipping — a Swift port of the PushKit→CallKit handler is then required.
  Verify the generated language on the first EAS build.
- README's iOS feature claims are aspirational; treat the "Production-Ready vs Placeholder"
  table as Android-validated only.
- iOS audio routing relies solely on InCallManager (no BT device enumeration) — likely needs work.

---

## 9. Exact commands available today

> These are the scripts/commands **as they exist now**. iOS build commands cannot
> succeed on this Windows machine and before an `ios/` project exists — they are
> listed for completeness, not as a recommendation to run them yet.

**Run from `apps/mobile/`.**

### Start Metro (works for any platform; cross-platform JS bundler)
```bash
pnpm start                  # expo start
pnpm start:dev-client       # expo start --dev-client   (required for WebRTC/CallKeep builds)
pnpm start:dev-client:usb   # expo start --dev-client --localhost --port 8081
```

### iOS simulator / device (currently NON-functional — no ios/ project, Windows host)
```bash
pnpm ios                    # expo run:ios            → FAILS: no ios/ project, needs macOS
pnpm prebuild:ios           # expo prebuild --platform ios --clean   → generates ios/ (needs macOS + pods)
pnpm build:ios:dev          # eas build --platform ios --profile dev      (simulator build, EAS cloud mac)
pnpm build:ios:preview      # eas build --platform ios --profile preview
pnpm build:ios:production   # eas build --platform ios --profile production
```

### Android (for contrast — these work today)
```bash
pnpm android                # expo run:android
pnpm build:android:dev|preview|production   # eas build --platform android --profile …
```

---

## 10. Recommended next steps (not yet executed)

1. **Provision an iOS build host.** iOS cannot be built on this Windows workstation.
   Use **EAS Build (cloud macOS)** — the path of least resistance given `eas.json`
   already defines iOS profiles — or a local Mac with Xcode + CocoaPods.
2. **Set up Apple credentials.** Create an Apple Developer App ID for
   `com.connectcommunications.mobile`, enable **Push Notifications** + **VoIP**, and
   generate an APNs Auth Key (or VoIP Services cert). Add iOS credentials to EAS
   (`eas credentials`) — `credentials.json` currently has Android only.
3. **First iOS prebuild + verify the AppDelegate patch.** Run `pnpm prebuild:ios` on a
   Mac, then confirm `withIosVoipPush.js` actually injected PushKit code (check for the
   `CONNECT_VOIP_PUSH_BEGIN` sentinel in `ios/.../AppDelegate.mm`). If Expo emitted a
   Swift AppDelegate, the plugin must be updated before VoIP push will work.
4. **Build the server-side APNs VoIP path in `apps/worker`** (the documented TODO):
   read `voipPushToken` from `MobileDevice`, send a VoIP push to APNs with
   `apns-push-type: voip` and topic `<bundleId>.voip` for inbound-call invites. Without
   this, killed/background iOS ring will not work even on a correct build.
5. **Wire CallKit incoming-call UX** end-to-end (PushKit payload → `RNCallKeep.displayIncomingCall`
   → existing accept/decline pipeline) and validate against the Android self-managed
   Telecom flow for parity.
6. **Validate iOS audio routing** (earpiece/speaker/Bluetooth) via InCallManager, since
   the Android-native `IncomingCallUi` audio router is unavailable on iOS.
7. **Do a feature pass for parity gaps** identified in §6 (keep-alive/background model,
   notification categories, in-call notification actions) under Apple's VoIP model.
8. **Start with a dev simulator build** (`pnpm build:ios:dev`, `ios.simulator: true`) to
   shake out JS/runtime issues before tackling push/CallKit on a physical device
   (PushKit/CallKit require a real device, not the simulator).

---

*End of discovery report. No application code, native files, packages, migrations,
or prebuild artifacts were created or modified in producing this document.*
