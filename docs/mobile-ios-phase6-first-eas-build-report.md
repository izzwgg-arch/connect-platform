# Phase 6 — First iOS EAS Dev-Device Build & Native Verification

Status: **Blocked on Apple Developer credentials + physical-device registration (awaiting user decision).** All safe, credential-free preflight and config verification is complete and green; the actual cloud build cannot proceed autonomously because it requires interactive Apple login (with 2FA on the user's device) and the physical iPhone 15 to register its UDID.

---

## 1. Preflight results

| Check | Result |
|-------|--------|
| EAS CLI available | ✅ `eas-cli/18.5.0` (local via `npx`). A newer `20.3.0` exists but is not required. |
| Logged into Expo/EAS | ✅ `izz8457` (`izzwgg@gmail.com`); owns accounts `izz8457` and `izz8457s-organization`. |
| EAS project | ✅ `projectId 53c72ced-180c-4885-a3ff-7d5da5717ead`, slug `@izz8457s-organization/connect-mobile`. |
| Git branch | `main`. Working tree has many uncommitted changes (Phase 4/5 mobile files + unrelated pre-existing Android/asset edits + `_latency_logs/` artifacts). **Phase 4/5 native-plugin changes are NOT yet committed.** |
| `eas.json` → `ios-dev-device` | ✅ Present: `developmentClient: true`, `distribution: internal`, `channel: dev`, `ios.simulator: false`, `resourceClass: m-medium`. No `credentialsSource` override ⇒ **EAS-managed (remote) credentials** — correct for a first device build. |
| Bundle ID | ✅ `com.connectcommunications.mobile` (app.config.ts `ios.bundleIdentifier`). |
| `credentials.json` | Holds **Android keystore only**; no iOS block, so iOS uses remote managed credentials. |

## 2. Capability / entitlement verification (config level — `expo config --type introspect`)

| Item | Result |
|------|--------|
| `withIosVoipPush` plugin in config | ✅ Present in resolved plugin list. |
| `UIBackgroundModes` | ✅ `['voip', 'remote-notification', 'audio']`. |
| Push entitlement | ✅ `entitlements: { 'aps-environment': 'development' }` auto-injected (dev build). Becomes `production` for the production profile. |
| Bundle ID in native config | ✅ `com.connectcommunications.mobile`. |
| VoIP topic compatibility | ✅ APNs VoIP topic is `<bundleId>.voip` = `com.connectcommunications.mobile.voip` (worker `apnsVoipPush.ts` derives this). |

> Note: introspect validates the **plist/entitlements** mods in-memory, but it does **not** reveal the generated `AppDelegate` language or the injected Obj-C body — those are "dangerous mods" that only materialize during a real prebuild (see §4).

## 3. First physical-device build — NOT executed (blocked)

Command that Phase 6 calls for (run from `apps/mobile`):

```bash
eas build --profile ios-dev-device --platform ios
```

This was **intentionally not run** because read-only checks proved it cannot succeed without interactive user action and real Apple credentials:

- `eas device:list` → **`No Apple teams found for account izz8457s-organization`** — the EAS account is not yet linked to any Apple Developer team, and no devices are registered.
- `eas build:list --platform ios` → **empty** — no iOS build has ever run for this project (first-build confirmed).

A real run of the command would, in sequence:
1. Prompt for **Apple Developer login** (Apple ID + app-specific/2FA — 2FA code is delivered to the user's trusted Apple device; the agent cannot complete this).
2. Offer to **register the iPhone 15** (generates a provisioning/registration URL or QR the user must open **on the physical iPhone** to install the device profile).
3. Generate a **distribution certificate + ad-hoc/development provisioning profile** (EAS-managed).
4. Upload the project archive and build on a macOS worker (where `expo prebuild -p ios` runs and the `withIosVoipPush.js` patch is applied).

All four are interactive and/or require the physical device + the user's Apple account. Per the task's "Ask before using real Apple credentials" rule, the build is paused for the user.

## 4. Native-output verification — deferred to the cloud build (Windows cannot prebuild iOS)

Attempted locally: `npx expo prebuild -p ios --no-install` →
**`⚠️ Skipping generating the iOS native project files. Run npx expo prebuild again from macOS or Linux to generate the iOS project.`** (Expo CLI blocks iOS prebuild on Windows.) No `ios/` folder was created and **no files were modified** (verified clean afterward).

Therefore the following Task-4 items can only be confirmed from the **EAS build logs / generated project** on the macOS worker, not on this Windows host:

| To verify on the build | Expectation (SDK 51 / RN 0.74.5) |
|------------------------|----------------------------------|
| AppDelegate language | **Objective-C++ `AppDelegate.mm`** (Swift AppDelegate is SDK 52+; SDK 51 emits `.mm`). |
| `withIosVoipPush.js` applied | Build log should print `[withIosVoipPush] Objective-C++ AppDelegate patched: PushKit + native CallKit reportNewIncomingCall wired.` |
| `#import "RNCallKeep.h"` resolves | Compiles under the generated Pods header search path; if it fails, switch the plugin import to `<RNCallKeep/RNCallKeep.h>`. |
| PushKit delegate present | The three `PKPushRegistryDelegate` methods injected by the plugin. |
| `reportNewIncomingCall` before completion | Injected `didReceiveIncomingPushWithPayload` calls `[RNCallKeep reportNewIncomingCall:…]` then `completion()`. |
| `UIBackgroundModes` | `voip`, `remote-notification`, `audio` (already in Info.plist via app.config). |
| `aps-environment` entitlement | `development` for this profile. |

## 5. Build failure diagnosis

Not applicable yet — no build was run. The **pre-build blocker** is credentials/team linkage + device registration (not a code/config defect). Config and plugin are validated as far as Windows allows.

## 6–7. Device install + smoke test

Not reached — depends on a successful build artifact. (App launch, permission prompts, mic/notification permissions, Expo push token + `voipPushToken` registration logs, `MobileDevice` record `platform: IOS` + `voipPushToken`, Metro `npx expo start --dev-client`, JS reload — all pending the build.)

## What worked / what's blocked

**Worked (autonomous, safe):**
- EAS CLI + login confirmed; project linkage confirmed.
- `eas.json` `ios-dev-device` profile, bundle ID, background modes, push entitlement, plugin presence — all verified at config level.
- Confirmed first-ever iOS build (no prior builds, no devices, no Apple team linked).
- Confirmed Windows cannot locally prebuild iOS (documented).
- Phase 5 code unchanged and intact; no working-tree damage from verification steps.

**Blocked (needs the user):**
- Apple Developer Program membership + interactive Apple login (2FA on the user's device) **or** an App Store Connect API key for non-interactive credential setup.
- Physical iPhone 15 present to register its UDID via the EAS guided flow.
- Committing the Phase 4/5 changes so the cloud build includes the native plugin + deterministic-UUID code (EAS archives the committed git tree).

## Remaining blockers before first inbound-call test

1. **Apple Developer team** linked to EAS (currently none) + **iPhone 15 UDID** registered.
2. **Commit Phase 4/5 changes** (otherwise the build won't contain `withIosVoipPush.js` native CallKit reporting, `callkitUuid.ts`, or the `callkeep.ts` deterministic UUID).
3. **Run the EAS build** and read the log to confirm AppDelegate language + plugin application + `RNCallKeep` compilation.
4. **Worker `APNS_*` env vars** set so VoIP pushes actually send for the inbound-call test.
5. Install on device, grant mic + notification permissions, confirm `voipPushToken` registers and the `MobileDevice` row updates.

---

## Status

**Paused for user input.** Everything that can be verified without Apple credentials on a Windows host is done and green. The actual `eas build --profile ios-dev-device --platform ios` requires the user's Apple Developer login (with 2FA) and the physical iPhone 15 for device registration, so it was not run. No code or working-tree changes were made in Phase 6.

## Risks

- **Apple account not yet linked / no membership:** if the Apple Developer Program isn't active, the build cannot create credentials. (Requires a paid membership.)
- **Uncommitted changes excluded from build:** EAS archives committed git state by default — building before committing Phase 4/5 would silently test stale code. Commit first.
- **AppDelegate language assumption:** strong evidence it's Obj-C++ (SDK 51), but only the build confirms it; the plugin fails loudly if Swift, so a wrong assumption is caught, not silent.
- **`RNCallKeep.h` import form** may need `<RNCallKeep/RNCallKeep.h>` — a one-line fix discoverable only from the build.

## Next recommended Cursor prompt

> Phase 6b: complete the first iOS EAS dev-device build. I (the user) have an
> active Apple Developer membership and my iPhone 15 in hand. Steps:
> 1. Commit the Phase 4/5 mobile changes (callkitUuid.ts/.test.ts, callkeep.ts,
>    withIosVoipPush.js, NotificationsContext.tsx, docs) on `main` with a clear
>    message — iOS PushKit/CallKit cold-killed hardening.
> 2. Walk me through `eas build --profile ios-dev-device --platform ios`,
>    including the Apple login + iPhone 15 device-registration prompts (I will
>    enter credentials / 2FA and scan the device-registration QR myself).
> 3. When the build finishes, pull the build logs and verify: AppDelegate is
>    Obj-C++ `.mm`, the `[withIosVoipPush] Objective-C++ AppDelegate patched` line
>    appears, `RNCallKeep.h` compiled, PushKit delegate + reportNewIncomingCall
>    present, UIBackgroundModes + aps-environment correct.
> 4. Help me install the build on the iPhone 15, run `npx expo start --dev-client`,
>    and capture `voipPushToken` registration logs + the `MobileDevice` row.
> 5. Update docs/mobile-ios-phase6-first-eas-build-report.md with the results.
