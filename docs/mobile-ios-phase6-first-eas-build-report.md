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

### 3a. Update — credentials provided; device registration handed to user terminal

- User chose **App Store Connect API key** auth + **QR device-registration flow**.
- API key configured via env vars (key contents never printed):
  `EXPO_ASC_API_KEY_PATH` → `…/Downloads/AuthKey_KLM264D4Z8.p8.txt` (valid PKCS#8
  PEM, EC P-256), `EXPO_ASC_KEY_ID=KLM264D4Z8`,
  `EXPO_ASC_ISSUER_ID=c7b93db6-da90-460c-ba20-10d76f015a40`.
- Phase 4/5 work committed to `main` as `63f4d6e0` so the build includes it.
- **`eas device:create` cannot be run by the agent**: it requires an interactive
  TTY (failed immediately with `Input is required, but stdin is not readable` at
  the *"use the izz8457s-organization account?"* prompt) and the QR must be
  scanned on the physical iPhone. → Handed to the user as a copy-paste terminal
  block (env vars + `npx eas device:create`, choose **Website** method, scan QR
  on the iPhone 15).
- After the device shows registered, the agent ran
  `eas build --profile ios-dev-device --platform ios --non-interactive`. It
  progressed through environment resolution, created the `dev` update
  channel/branch, and selected **remote (Expo-managed) iOS credentials**, then
  failed with:
  `Failed to set up credentials. You're in non-interactive mode. EAS CLI couldn't
  find any credentials suitable for internal distribution. Run this command again
  in interactive mode.`
- **Root cause (not a code defect):** this is the **first** iOS build, so no
  Apple **Distribution Certificate** or **ad-hoc provisioning profile** exists
  yet. EAS deliberately refuses to *create* a new distribution certificate in
  `--non-interactive` mode (distribution certs are a hard-limited Apple resource,
  max ~2–3 per account, so creation requires an interactive confirmation). The
  ASC API-key env vars handle Apple **authentication** fine (proven by the
  successful `device:create`), but they do **not** bypass the interactive
  cert-creation gate.
- **Resolution:** run the build **once in interactive mode** in the user's
  terminal so EAS generates + stores the managed cert + profile (which will
  include the registered iPhone 15). That interactive run also produces the build
  artifact, so no extra build is needed. Subsequent builds can then be
  `--non-interactive`. A non-trivial config nit surfaced too: EAS warns
  `app.config.ts is missing ios.infoPlist.ITSAppUsesNonExemptEncryption` — not a
  build blocker for a dev build, but should be set to avoid a manual App Store
  Connect step later (added to remaining items).

### 3b. Update — Apple 401 diagnosed; root cause = empty team + missing env vars

The user reported the interactive build failed with **Apple 401 "Authentication
credentials are missing or invalid."** Investigated directly (signed an ASC API
JWT with the provided key and called the App Store Connect API; key contents /
token never printed):

| Probe | Result |
|-------|--------|
| `GET /v1/devices` with key `KLM264D4Z8` + issuer `c7b93db6…` | **HTTP 200** → key, issuer, signing, and permissions are **VALID**. |
| Device count on this team | **0** |
| Certificate count on this team | **0** |
| Bundle IDs matching `com.connectcommunications.mobile` | **0** |

Confirmed via eas-cli source (`SetUpInternalProvisioningProfile.js`,
`ConfigureProvisioningProfile.js`) that the correct env var names are exactly
`EXPO_ASC_API_KEY_PATH` / `EXPO_ASC_KEY_ID` / `EXPO_ASC_ISSUER_ID` (the ones we
set), and that **eas-cli auto-treats a non-TTY shell as non-interactive** — so
the agent's shell cannot create first-time credentials regardless of flags.

**Conclusions:**
1. The **401 was an auth-fallback artifact**, not a bad key: the user's
   interactive terminal did not have the ASC env vars set, so EAS fell back to a
   stale/absent Apple ID session and got 401. With the env vars set (key proven
   valid) EAS authenticates via the key — no Apple ID, no 2FA.
2. The key's Apple team is **empty** (0 devices / 0 certs / 0 bundle IDs). The
   earlier `device:create` "success" therefore registered the iPhone on a
   **different** Apple team than this key's team. Everything must be done on the
   **same** team or the adhoc profile will contain no device and the `.ipa` won't
   install.

**Fix handed to user (single TTY terminal, env vars set):**
```powershell
$env:EXPO_ASC_API_KEY_PATH = "$env:USERPROFILE\Downloads\AuthKey_KLM264D4Z8.p8.txt"
$env:EXPO_ASC_KEY_ID = "KLM264D4Z8"
$env:EXPO_ASC_ISSUER_ID = "c7b93db6-da90-460c-ba20-10d76f015a40"
cd "c:\dev\projects\Connect 2\apps\mobile"
npx eas device:create   # QR flow → registers iPhone 15 on THIS key's team
npx eas build --profile ios-dev-device --platform ios   # creates bundleId+cert+profile on THIS team, includes device, builds
```
Because the env vars pin auth to the key's team, both the device and the build
land on the same team, resolving both the 401 and the empty-profile risk.

### 3c. Update — build #1 reached Xcode; failed on a plugin selector defect (FIXED)

Build: `https://expo.dev/accounts/izz8457s-organization/projects/connect-mobile/builds/e39849a0-a866-43de-aaec-584f19be2e1c`

With the env vars set, the build **authenticated (no 401), created credentials,
uploaded, and ran fastlane/Xcode on the macOS worker** — then failed compiling
the injected AppDelegate:

```
no known class method for selector 'didInvalidatePushTokenForType:'
```

**Root cause (plugin defect):** `withIosVoipPush.js` forwarded the optional
PKPushRegistryDelegate `didInvalidatePushTokenForType:` to
`[RNVoipPushNotificationManager didInvalidatePushTokenForType:]`, **but that
class method does not exist** in `react-native-voip-push-notification@3.3.x`.
Verified the real class API from the installed header:

```
+ voipRegistration
+ didUpdatePushCredentials:forType:
+ didReceiveIncomingPushWithPayload:forType:
+ addCompletionHandler:completionHandler:
+ removeCompletionHandler:
```

**Fix:** made the `didInvalidatePushTokenForType:` delegate body a documented
no-op (iOS re-registers and delivers a fresh token via `didUpdatePushCredentials`
on next launch). The other three forwarded calls (`voipRegistration`,
`didUpdatePushCredentials:forType:`, `didReceiveIncomingPushWithPayload:forType:`)
all match the confirmed API.

**What this failure already PROVED (Task-4 verification, partial):**
- **AppDelegate language = Objective-C++** — the failure is an Obj-C *selector*
  error inside the patched AppDelegate, so the `.mm` patch was generated and
  applied (Swift would not have produced this, and the plugin would have logged
  its Swift warning instead). The SDK-51 assumption holds.
- **`withIosVoipPush.js` patch applied** — the failing line is our injected
  delegate method.
- **`#import "RNCallKeep.h"` resolved + `reportNewIncomingCall` compiled** — the
  build stopped at the `didInvalidatePushTokenForType:` line with no
  "file not found" for `RNCallKeep.h` and no error on `[RNCallKeep
  reportNewIncomingCall:…]`, so the CallKeep import/quote form and the native
  report call are good (the `<RNCallKeep/RNCallKeep.h>` fallback was not needed).
- **Credentials/provisioning succeeded** — the build got past credential setup to
  Xcode, so cert + ad-hoc profile were created on the key's team.

Remaining to confirm on the **next** build (after the fix ships): a green Xcode
compile, then on-device install of `aps-environment`, `UIBackgroundModes`, PushKit
token registration, and `voipPushToken` persistence.

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
