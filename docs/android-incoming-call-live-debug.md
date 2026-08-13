# Android incoming call — live debug workflow

Correlation key: **`inviteId`** (same string in API/worker `[CALL_TIMELINE]`, device `ConnectCallFlow` / JS `[CALL_FLOW]`).

## Part 1 — Device commands (ADB + optional scrcpy)

Prerequisites: USB debugging on, phone authorized, Android SDK `platform-tools` installed (default: `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`).

From repo root:

| Goal | Command |
|------|---------|
| Print copy-paste commands | `pnpm mobile:live-debug -- -Action print-commands` |
| Clear logcat | `pnpm mobile:logcat-clear` |
| Filtered capture to `logs/` | `pnpm mobile:live-capture -- -Scenario ring-home` (Ctrl+C stops) |
| Clear + capture + optional mirror | `pnpm mobile:live-debug -- -Action both -Scenario ring-home` |
| Screen mirror only | `pnpm mobile:live-debug -- -Action mirror` (requires [scrcpy](https://github.com/Genymobile/scrcpy) on PATH) |

**Logcat filter tags** (see `scripts/android-live-capture.ps1`): `IncomingCallService`, `ConnectCallFlow`, `ConnectMainActivity`, `FirebaseMessaging`, `ReactNativeJS`, `ReactNative`, `ExpoModules`.

**JS timeline grep** (broader than tags):

```powershell
adb logcat -v threadtime | Select-String "CALL_FLOW|CALL_TIMELINE|ANSWER_FLOW|\[CALL_INCOMING\]"
```

## Part 2 — On-device debug overlay

- **When it shows**: `__DEV__` builds always show a **DBG** FAB (bottom-right). Release builds only if `EXPO_PUBLIC_CALL_FLOW_DEBUG_OVERLAY=true` at build time (`app.config.ts` → `extra.callFlowDebugOverlay`).
- **What it shows**: recent `CALL_FLOW` ring buffer, app state, SIP `callState`, incoming UI phase, last invite id, SIP `lastError`, **Mark blank** (emits `BLANK_SCREEN_MANUAL_MARK`).
- **Removal**: delete `CallFlowDebugOverlay` from `App.tsx` and the `callFlowDebug` imports; remove `src/debug/` when done. Toggle release overlay by unsetting `EXPO_PUBLIC_CALL_FLOW_DEBUG_OVERLAY`.

## Part 3 — Stage logs (device)

| Stage | Where |
|--------|--------|
| `PUSH_SEND` | API (`server.ts` `sendPushToUserDevices`) and worker (`main.ts`) as `[CALL_TIMELINE]` JSON |
| `MOBILE_INVITE_ACCEPT_REQUEST` | API `POST /mobile/call-invites/:id/respond` (ACCEPT) |
| `FCM_DATA_INCOMING_CALL`, `RINGTONE_START/STOP`, `NATIVE_*` | Android `IncomingCallFirebaseService` tag **`ConnectCallFlow`** |
| `BACKGROUND_TASK_*`, `CALLKEEP_*`, `[CALL_FLOW]` JSON | JS (`backgroundCallTask`, `callkeep`, contexts, screens) via **`ReactNativeJS`** |

Each JS `[CALL_FLOW]` line is one JSON object: `stage`, `ts`, `appState`, `inviteId`, optional `pbxCallId`, `extension`.

## Part 4 — Backend correlation

Search API/worker logs for **`[CALL_TIMELINE]`** or JSON field `callTimeline: true`. Fields include `inviteId`, `tenantId`, `userId`, `payloadType`, `toExtension`, `deviceCount` (push batch).

## Part 5 — Manual test matrix (one scenario per run)

For each row: clear logcat → start capture → perform steps → stop capture → align server log time with `inviteId`.

| # | App state before ring | When to place call | Pass (observe + logs) | Fail signals |
|---|------------------------|--------------------|------------------------|--------------|
| 1 | App open on Quick Action | After capture starts | `PUSH_RECEIVED_FOREGROUND` → `INCOMING_CALL_SCREEN_MOUNT` → ring/hear audio or JS handoff; answer → `SIP_ANSWER_START` → `SIP_CONNECTED` → `ACTIVE_CALL_SCREEN_MOUNT` | No `PUSH_RECEIVED_*`; no `INCOMING_CALL_SCREEN_MOUNT` |
| 2 | Home / recent apps (not killed) | Same | Native: `FCM_DATA_INCOMING_CALL` → `RINGTONE_START` → notification / full-screen; answer path continues | `FCM_*` without `RINGTONE_START`; duplicate UIs |
| 3 | Swipe away / “clear all” (not force-stop) | Same | Same as row 2; `BACKGROUND_TASK_FIRED` may appear with `BACKGROUND_INCOMING_CALL_PAYLOAD_OK` | Push only, no native/JS wake |

Hang up: expect `SIP_CALL_STATE_ENDED` → `CALL_ENDED_SCREEN_SHOWN` (if shown) → `NAVIGATE_BACK_TO_QUICK`.

## Part 6 — Rebuild vs fast iteration

| Change type | Needs new APK? | Notes |
|-------------|----------------|--------|
| TypeScript/React only (`src/**` except no native) | **No** (dev client + Metro) | Use `pnpm mobile:dev-live` or USB reverse + `expo start --dev-client`; reload JS. |
| `app.config.ts` plugins / extra flags | **Yes** (prebuild) | Native project regenerated. |
| Java/Kotlin under `android/` | **Yes** | `expo run:android` or EAS build. |
| `AndroidManifest`, Firebase service class | **Yes** | Same as native. |

**Typical setups**

- **Dev client + Metro**: debuggable, fastest JS iteration; matches “Metro-attached development flow”.
- **Release / preview APK**: no Metro; each native change needs rebuild + install (`adb install -r`).
- **Expo Go**: not applicable for CallKeep / custom native incoming path.

## Part 7 — One traced call (procedure)

This environment cannot place a real PSTN/SIP call. **You** run one call with capture on, then:

1. Copy **`inviteId`** from `[CALL_TIMELINE] PUSH_SEND` (server/API log).
2. In the device log file, `Select-String` that `inviteId` through `ConnectCallFlow`, `ReactNativeJS`, `IncomingCallService`.
3. List stages **in time order**; the **first missing stage after a successful prior stage** is the breakpoint (push → native → ring → JS → answer → SIP → navigation).

Example interpretation (hypothetical):

- If `PUSH_SEND` exists but no `FCM_DATA_INCOMING_CALL` → delivery/FCM/OS.
- If `FCM_DATA_INCOMING_CALL` but no `RINGTONE_START` → native audio path.
- If ring OK but no `INCOMING_CALL_SCREEN_MOUNT` after answer intent → navigation / deep link.
- If `SIP_ANSWER_START` but no `SIP_CONNECTED` → SIP / PBX / media gate.
