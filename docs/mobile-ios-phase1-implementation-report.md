# Connect Mobile — iOS Phase 0 / Phase 1 Implementation Report

> **Date:** 2026-06-21
> **Scope:** Phase 0 (physical-device build profile) + the **backend APNs VoIP
> push foundation** for iOS incoming calls. Focused, non-destructive changes only.
> **Source of truth:** [`mobile-ios-current-state.md`](./mobile-ios-current-state.md),
> [`mobile-ios-production-plan.md`](./mobile-ios-production-plan.md).
> **Not done in this phase:** native iOS project generation, EAS builds, package
> installs, deploys, UI redesign, Android rewrites.

---

## 1. Files Changed / Added

| File | Type | Change |
|------|------|--------|
| `apps/mobile/eas.json` | edit | Added `ios-dev-device` EAS profile for **physical iPhone** dev builds. Existing `dev` (simulator) profile left intact. |
| `apps/worker/src/apnsVoipPush.ts` | **new** | Dependency-free APNs VoIP push sender (token-based `.p8` ES256 JWT, Node built-in `http2` + `crypto`). Call-only. |
| `apps/worker/src/apnsVoipPush.test.ts` | **new** | Dry-run unit tests (config detection, topic derivation, host selection, unconfigured no-network path, `.p8`/base64 acceptance). |
| `apps/worker/src/main.ts` | edit | Import the VoIP sender; add `sendVoipPushesForIncomingCall(...)`; invoke it from `sendPushToUserDevices` **only for `INCOMING_CALL`**, after the unchanged Expo send. |
| `docs/mobile-ios-production-plan.md` | edit | Marked Phase 0 items + backend APNs foundation as in-progress/done; updated checklist. |
| `docs/mobile-ios-current-state.md` | edit | Noted the backend VoIP foundation now exists (the previous hard blocker is partially addressed). |
| `docs/mobile-ios-phase1-implementation-report.md` | **new** | This report. |

No other files were touched. No schema migration was created (the existing
`MobileDevice` model already has every column used — see §6).

---

## 2. What Was Added

### 2a. Physical-device EAS profile (`apps/mobile/eas.json`)
```jsonc
"ios-dev-device": {
  "developmentClient": true,
  "distribution": "internal",
  "channel": "dev",
  "ios": { "simulator": false, "resourceClass": "m-medium" },
  "env": { "EXPO_PUBLIC_VOICE_SIMULATE": "false", "EXPO_PUBLIC_LOG_LEVEL": "debug" }
}
```
- `simulator: false` → installable on a real iPhone 15.
- `credentialsSource` is intentionally **omitted** → defaults to `remote`, so **EAS
  manages** the Apple distribution cert, ad-hoc provisioning profile, and device
  registration. (The Android `dev` profile uses `local` because the Android keystore
  is committed; there are no committed iOS credentials, so remote is correct.)
- `EXPO_PUBLIC_VOICE_SIMULATE: "false"` so real SIP/calls can be exercised on device.

### 2b. APNs VoIP sender (`apps/worker/src/apnsVoipPush.ts`)
- **Token-based auth:** signs a short-lived ES256 JWT from the `.p8` AuthKey using
  Node `crypto` with `dsaEncoding: "ieee-p1363"` (raw R||S, as JOSE requires). JWT is
  cached and refreshed at 50 min (Apple allows 60).
- **Transport:** Node built-in `http2` to APNs (`/3/device/<token>`). No new packages.
- **Exports:** `isApnsVoipConfigured()`, `sendApnsVoipPush(token, payload)`,
  `describeApnsVoipConfig()`, `resetApnsProviderTokenCache()`.
- **Headers:** `apns-push-type: voip`, `apns-topic: <bundleId>.voip`,
  `apns-priority: 10`, short `apns-expiration` (~30s — a ring is only briefly relevant).
- **Minimal payload** (only what CallKit needs): `callId`, `tenantId`, `toExtension`,
  `callerNumber`, `callerName`, `timestamp`. No alert/sound (silent VoIP wake).

### 2c. Worker incoming-call wiring (`apps/worker/src/main.ts`)
- New `sendVoipPushesForIncomingCall(...)` filters the already-fetched device list to
  `platform === "IOS"` with a non-null `voipPushToken`, and sends one VoIP push each.
- Invoked from `sendPushToUserDevices` **only when `payload.type === "INCOMING_CALL"`**,
  **in addition to** the existing Expo send (which is unchanged).
- Runs inside the existing non-simulate branch, so `MOBILE_PUSH_SIMULATE=true` still
  short-circuits before any real push (Expo or VoIP).

### 2d. Structured logs (single-line JSON, greppable)
| Event | Meaning |
|-------|---------|
| `apns_voip_token_selected` | An iOS device + VoIP token was chosen for this call (`voipPushTokenTail` only). |
| `apns_voip_send_attempt` | About to POST to APNs. |
| `apns_voip_send_success` | APNs returned 200 (`apnsId`, `status`). |
| `apns_voip_send_failure` | Non-200 / transport error (`status`, `reason`, `error`). |
| `apns_voip_token_invalidation_candidate` | 410 / BadDeviceToken / Unregistered → token nulled. |
| `apns_voip_skipped_unconfigured` | iOS devices present but APNs creds absent — devices won't wake. |
| `apns_voip_fanout_error` | Unexpected throw in the fan-out (call still proceeds). |

---

## 3. What Was Intentionally NOT Done

- **No iOS native project generation / prebuild** (Phase 0 build step is a *command*,
  not run here — requires Apple credentials + EAS run).
- **No EAS build, no deploy, no package install, no DB migration.**
- **No VoIP push for non-call events.** `INVITE_CANCELED` and `MISSED_CALL` deliberately
  stay on the Expo/alert path. Consequence: a ringing iOS CallKit call will **not**
  auto-dismiss on remote cancel yet — that requires a call-update mechanism wired in
  Phase 4 (CallKit `endCall`), and must be done carefully to remain call-only.
- **iOS device is NOT excluded from the existing Expo send.** To minimize regression
  risk, iOS still also receives the Expo data push; the JS side dedupes by `callId`.
  Trimming the Expo send for iOS can be a later optimization.
- **No mobile-side CallKit/PushKit answer wiring** (Phase 4). This phase is backend +
  build-config foundation only.
- **No new admin UI** for VoIP delivery status (logs only for now).

---

## 4. Required Apple Credential Env Vars (worker)

No real secret values are committed. Set these in the worker's environment/secrets:

| Env var | Required | Description |
|---------|----------|-------------|
| `APNS_TEAM_ID` | yes | Apple Developer Team ID (10 chars). |
| `APNS_KEY_ID` | yes | Key ID of the APNs AuthKey `.p8`. |
| `APNS_AUTH_KEY_P8` | yes* | The `.p8` PEM contents (multi-line; literal `\n` accepted). |
| `APNS_AUTH_KEY_BASE64` | yes* | Alternative to the above: base64 of the `.p8` contents. |
| `APNS_BUNDLE_ID` | no | Defaults to `com.connectcommunications.mobile`. |
| `APNS_VOIP_TOPIC` | no | Defaults to `<APNS_BUNDLE_ID>.voip`. |
| `APNS_PRODUCTION` | no | `"true"` → `api.push.apple.com`; else sandbox host. |

\* Provide **either** `APNS_AUTH_KEY_P8` **or** `APNS_AUTH_KEY_BASE64`.

If none of the required vars are set, `isApnsVoipConfigured()` is `false`, the worker
logs `apns_voip_skipped_unconfigured`, and **Android/Expo behavior is unaffected**.

---

## 5. Exact Commands

### First physical-iPhone dev build (run from `apps/mobile/`, when ready)
```bash
eas login
eas credentials                # iOS → create/verify dist cert + ad-hoc profile + push key + VoIP
eas build --platform ios --profile ios-dev-device
# → install on iPhone 15 via the EAS build URL / QR from the CLI output
```

### Metro (live JS, from `apps/mobile/`)
```bash
npx expo start --dev-client
# (equivalent: pnpm start:dev-client)
```

### How to verify APNs VoIP push selection in logs
Trigger an inbound call to an iOS-registered extension and grep the worker logs:
```bash
# token chosen + send lifecycle for a given call
grep -E "apns_voip_(token_selected|send_attempt|send_success|send_failure)" worker.log

# creds missing (devices won't wake)
grep "apns_voip_skipped_unconfigured" worker.log

# dead token detected
grep "apns_voip_token_invalidation_candidate" worker.log
```
Expected healthy sequence per iOS device:
`apns_voip_token_selected` → `apns_voip_send_attempt` → `apns_voip_send_success` (`status: 200`).

---

## 6. Token Invalidation Behavior (exact)

- On APNs **`410`** or reason **`BadDeviceToken` / `Unregistered` / `DeviceTokenNotForTopic`**,
  the worker logs `apns_voip_token_invalidation_candidate` and **nulls** that device's
  `voipPushToken`, setting `lastPushStatus = "APNS_VOIP_TOKEN_INVALID"` and
  `lastPushError = <reason>`.
- The device row is **not** deactivated/deleted — the Android Expo path (if any) stays
  valid, and the existing project pattern only ever nulls/stamps push fields here. The
  app re-registers a fresh VoIP token on next launch (existing `NotificationsContext`
  late-arrival re-register path).
- Other failures (e.g. transient 5xx/transport) set `lastPushStatus = "APNS_VOIP_FAILED"`
  with `lastPushError`, but **keep** the token for retry on the next call.
- Schema note: no migration was needed — `MobileDevice` already has `voipPushToken`,
  `lastPushSentAt`, `lastPushType`, `lastPushStatus`, `lastPushError`.

---

## 7. Android Preservation

- The Expo/FCM send (`buildExpoPushV2Item` → `exp.host`) is **byte-for-byte unchanged**;
  Android devices are unaffected.
- VoIP fan-out filters to `platform === "IOS"` only — Android rows are never selected.
- `MOBILE_PUSH_SIMULATE=true` still returns before any real send (Expo or VoIP).
- The VoIP call is wrapped in `.catch(...)` so any APNs error **cannot** break the
  existing Expo/Android path or the call flow.

---

## 8. Test / Build Command Results

| Command | Result |
|---------|--------|
| `npx tsx --test src/apnsVoipPush.test.ts` (in `apps/worker`) | ✅ **7 pass / 0 fail** |
| ReadLints on `apnsVoipPush.ts`, `apnsVoipPush.test.ts`, `main.ts`, `eas.json` | ✅ No linter errors |
| `pnpm --filter @connect/worker typecheck` | ⚠️ Fails only on **pre-existing** unrelated errors in `packages/db` / `packages/shared` webrtc files (module-resolution + an arg-count test). **None reference the new/edited files.** |

> The pre-existing typecheck failures are in `webrtcCallingIncidentService.*`,
> `webrtcPlatformOutageService.*`, and `webrtcGlobalOutageAlerts.test.ts` — untouched by
> this work. No build or deploy was run (out of scope / not safe per instructions).

---

## 9. Remaining Blockers Before the First iPhone Call Test

1. **Apple credentials provisioned** — Team ID, Key ID, `.p8` AuthKey with **VoIP**
   capability; set the worker env vars (§4).
2. **First EAS iOS build** (`ios-dev-device`) generated + installed on iPhone 15, and
   the generated `AppDelegate` language verified (Obj-C++ vs Swift) for the PushKit patch.
3. **Mobile CallKit/PushKit answer wiring (Phase 4)** — report-to-CallKit on push,
   connect SIP/WebRTC after answer, end CallKit on call end. Not in this phase.
4. **Remote-cancel handling on iOS** — `INVITE_CANCELED` → CallKit `endCall` (call-only)
   still to be designed.
5. **APNs environment** — confirm `APNS_PRODUCTION` matches the build's `aps-environment`
   (sandbox for dev builds, production for TestFlight/App Store).

---

## 10. Status / Risks / Next Prompt

### Status
- ✅ **Phase 0 build-config:** physical-iPhone EAS profile added.
- ✅ **Backend APNs VoIP foundation:** call-only sender + worker wiring + token
  invalidation + structured logs + dry-run tests (7/7 pass).
- 🔸 **Not yet runnable end-to-end:** needs Apple creds + first EAS build + Phase 4
  mobile CallKit wiring.

### Risks
- **AppDelegate language** may be Swift on SDK 51 → `withIosVoipPush.js` would need a
  Swift port (verify on first prebuild).
- **APNs sandbox vs production mismatch** is the most common "push accepted but never
  delivered" cause — `APNS_PRODUCTION` must match the build's entitlement.
- **Report-on-every-VoIP-push rule:** once the mobile side handles pushes, it MUST
  report a CallKit call every time or iOS throttles/kills the app.
- **Double delivery on iOS** (Expo + VoIP) is intentional for now; relies on JS
  dedupe by `callId`.
- **No live APNs integration test** here (network + real creds required); only dry-run
  unit tests exercise the module.

### Next recommended Cursor prompt
> "Begin Phase 4: wire iOS CallKit/PushKit on the mobile side. On
> `didReceiveIncomingPush` in `src/sip/voipPush.ts`, synchronously report the call to
> CallKit via `react-native-callkeep` using the VoIP payload (`callId`, caller info),
> then connect SIP/WebRTC only after the CallKeep `answerCall` event by reusing the
> existing `handleAcceptInvite` pipeline in `NotificationsContext`. End the CallKit call
> on SIP `ended`/`failed` and on a new `INVITE_CANCELED` VoIP/alert path. Do not run EAS
> builds or deploys; planning + code changes with typecheck only. Also confirm the
> generated AppDelegate language after the first `ios-dev-device` build and port
> `withIosVoipPush.js` to Swift if required."

---

*End of Phase 0 / Phase 1 implementation report. No native generation, EAS builds,
package installs, migrations, or deploys were performed.*
