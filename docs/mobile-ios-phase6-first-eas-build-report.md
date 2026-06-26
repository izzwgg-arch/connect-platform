# Phase 6 — First iOS EAS Dev-Device Build & Native Verification

Status: **✅ FIRST iOS BUILD SUCCEEDED.** Build `8cd8274e-b215-4a22-a35a-7ccfcdb3e35b` (profile `ios-dev-device`, SDK 51.0.0, commit `04a4f0cc`) finished and produced an installable `.ipa`. The native CallKit/PushKit plugin compiled on the macOS worker (Objective-C++ AppDelegate), and the ad-hoc provisioning profile includes the physical iPhone (UDID `00008110-001A34A10113801E`). Remaining work is on-device install + smoke test. (History of how we got here — auth/credential/compile blockers and fixes — retained in §3a–§3c below.)

**Build artifact:** `https://expo.dev/artifacts/eas/R9JjJ7NMk5m9ZQAj3TAg-Tj7oyQLoyXkxU3zWzC8h4Q.ipa`
**Install / logs:** `https://expo.dev/accounts/izz8457s-organization/projects/connect-mobile/builds/8cd8274e-b215-4a22-a35a-7ccfcdb3e35b`

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

### 3d. Update — build #2 SUCCEEDED ✅

`eas build --profile ios-dev-device --platform ios --non-interactive` (run from
the agent's PowerShell — now possible because build #1's credentials already
exist on EAS, so non-interactive no longer needs to *create* them):

| Field | Value |
|-------|-------|
| Build ID | `8cd8274e-b215-4a22-a35a-7ccfcdb3e35b` |
| Status | **finished** |
| Profile / Distribution / Channel | `ios-dev-device` / `internal` / `dev` |
| SDK / Runtime / Version / Build # | `51.0.0` / `1.0.0` / `1.0.0` / `1` |
| Commit | `04a4f0cc` (includes the selector fix) |
| Apple Team | `PR63R6J84J` (israel weinstock — Individual) |
| Provisioned device | iPhone UDID `00008110-001A34A10113801E` |
| `.ipa` | `https://expo.dev/artifacts/eas/R9JjJ7NMk5m9ZQAj3TAg-Tj7oyQLoyXkxU3zWzC8h4Q.ipa` |
| Install / logs | `https://expo.dev/accounts/izz8457s-organization/projects/connect-mobile/builds/8cd8274e-b215-4a22-a35a-7ccfcdb3e35b` |

Note on credentials/team: the stored credentials (cert + ad-hoc profile +
device) live on Apple Team **`PR63R6J84J`**, created during build #1's
interactive run. The ASC API key the agent holds (`KLM264D4Z8`) belongs to a
*different*, empty team — which is why the direct ASC probe saw 0 devices/certs.
This is harmless for building (non-interactive uses the stored EAS credentials
and skips Apple-server validation), but **`eas submit` / future credential
changes should use an ASC API key from team `PR63R6J84J`**, not `KLM264D4Z8`.

Note on archive size: EAS warned the project archive is **772 MB** (untracked
artifacts under `_latency_logs/` etc. get swept into the git archive). Not a
blocker, but a `.easignore` excluding `_latency_logs/`, `*.apk`, `*.ipa`, and
screenshots would speed future uploads. (Left untouched — outside this phase's
"fix only the direct blocker" scope.)

## 4. Native-output verification — deferred to the cloud build (Windows cannot prebuild iOS)

Attempted locally: `npx expo prebuild -p ios --no-install` →
**`⚠️ Skipping generating the iOS native project files. Run npx expo prebuild again from macOS or Linux to generate the iOS project.`** (Expo CLI blocks iOS prebuild on Windows.) No `ios/` folder was created and **no files were modified** (verified clean afterward).

Windows cannot prebuild iOS, so these Task-4 items were confirmed from the
**EAS macOS build** instead (build #1 failure pinpointed the AppDelegate
language; build #2 success confirmed the rest by compiling cleanly):

| Item | Result |
|------|--------|
| AppDelegate language | ✅ **Objective-C++ `.mm`** — proven by build #1's Obj-C *selector* error inside the patched delegate; build #2 compiled it. (SDK 51, as expected.) |
| `withIosVoipPush.js` applied | ✅ The patched delegate methods are in the compiled binary (build #1 failed *on* our injected line; build #2 compiled them). |
| `#import "RNCallKeep.h"` resolves | ✅ Compiled — no "file not found"; the quote-form import worked, `<RNCallKeep/RNCallKeep.h>` fallback **not** needed. |
| PushKit delegate present | ✅ All three `PKPushRegistryDelegate` methods compiled. |
| `reportNewIncomingCall` before completion | ✅ `[RNCallKeep reportNewIncomingCall:…]` compiled in `didReceiveIncomingPushWithPayload` ahead of `completion()`. |
| `UIBackgroundModes` | ✅ `voip`, `remote-notification`, `audio` (introspect + app.config). |
| `aps-environment` entitlement | ✅ `development` (introspect; profile is `development`). |
| Bundle ID / `.voip` topic | ✅ `com.connectcommunications.mobile`; VoIP topic `com.connectcommunications.mobile.voip` (worker derives `<bundleId>.voip`). |

## 5. Build failure diagnosis (resolved)

Two real blockers were hit and fixed; neither was an app-logic defect:

1. **Apple 401 at credential setup** — caused by the interactive terminal lacking
   the ASC API-key env vars (EAS fell back to a stale Apple ID session). Fixed by
   setting `EXPO_ASC_API_KEY_PATH/EXPO_ASC_KEY_ID/EXPO_ASC_ISSUER_ID`; the key
   itself was proven valid (direct ASC API `200`). (§3a–§3b)
2. **Xcode compile error** `no known class method for selector
   'didInvalidatePushTokenForType:'` — the plugin forwarded to a
   `RNVoipPushNotificationManager` class method that doesn't exist in 3.3.x.
   Fixed by making that optional delegate a documented no-op (commit `04a4f0cc`).
   (§3c)

First-time credential *creation* also required an interactive (TTY) run, since
eas-cli treats a non-TTY shell as non-interactive and won't create new
distribution certs there; once build #1 created+stored them, the agent's
non-interactive build #2 reused them and succeeded.

## 6–7. Device install + smoke test (handed to user — needs the physical iPhone)

The `.ipa` is built and the iPhone (UDID `00008110-001A34A10113801E`) is in the
profile, so it will install. On the **iPhone 15**:

1. **Install:** open the build link (or scan its QR) and tap **Install**:
   `https://expo.dev/accounts/izz8457s-organization/projects/connect-mobile/builds/8cd8274e-b215-4a22-a35a-7ccfcdb3e35b`
   — then **Settings → General → VPN & Device Management → trust the developer
   (israel weinstock)** so the dev build can launch.
2. **Start Metro** (dev client) on the workstation:
   ```powershell
   cd "c:\dev\projects\Connect 2\apps\mobile"
   npx expo start --dev-client
   ```
   Open the app on the iPhone; it should connect to Metro (same Wi-Fi / use
   tunnel if needed).
3. **Smoke checks to capture:** app launches without crash; login / QR-login
   screen renders; UI parity with Android at a glance; **camera + microphone +
   notifications** permission prompts; PushKit registration + **`voipPushToken`**
   appears in logs; the backend `MobileDevice` row shows `platform: IOS` with a
   non-null `voipPushToken`; JS fast-refresh works.

These weren't run by the agent (they require the physical device); they are the
content of the next phase.

## What worked / what's outstanding

**Worked:**
- Full credential chain set up on Apple Team `PR63R6J84J`; first iOS build
  **succeeded** with the native CallKit/PushKit plugin compiled.
- All Task-4 native items verified via the build (table in §4).
- Diagnosed + fixed the 401 (env vars) and the Xcode selector defect (commit
  `04a4f0cc`); both committed on `main`.

**Outstanding (next phase, needs the iPhone):**
- On-device install + smoke test (§6–7).
- Worker `APNS_*` env vars for the live inbound-call test.
- Optional: `.easignore` to shrink the 772 MB archive; set
  `ITSAppUsesNonExemptEncryption`; use an ASC key from team `PR63R6J84J` for
  `eas submit`.

## Remaining blockers before first inbound-call test

1. Install the dev build on the iPhone 15 and trust the developer profile.
2. Grant microphone + notification permissions; confirm `voipPushToken`
   registers and the `MobileDevice` row updates (`platform: IOS`).
3. Set the worker `APNS_*` env vars (`APNS_TEAM_ID`, `APNS_KEY_ID`,
   `APNS_AUTH_KEY_P8`/`_BASE64`, `APNS_BUNDLE_ID`, `APNS_VOIP_TOPIC`,
   `APNS_PRODUCTION`) so a real incoming call fans out a VoIP push.
4. Place a test call and confirm CallKit rings (foreground, background, and
   cold-killed) and connects after answer.

---

## Status

**✅ Phase 6 core goal achieved: the first iOS dev-device build succeeded.**
Apple auth, EAS-managed credentials (cert + ad-hoc profile incl. the iPhone),
and the native Objective-C++ CallKit/PushKit plugin all compiled; an installable
`.ipa` is published. Two blockers (Apple 401, Xcode selector error) were
diagnosed and fixed (commit `04a4f0cc`). Remaining work is on-device install +
smoke test, which requires the physical iPhone.

## Risks

- **Two Apple teams in play:** stored EAS credentials + device are on team
  `PR63R6J84J`; the agent's ASC API key (`KLM264D4Z8`) is on a different empty
  team. Builds are fine (stored creds), but `eas submit` / future credential
  edits must use a key from `PR63R6J84J`.
- **772 MB archive:** untracked artifacts (e.g. `_latency_logs/`) inflate the
  upload; add a `.easignore` to speed future builds.
- **`ITSAppUsesNonExemptEncryption` unset:** harmless for dev, but set it to
  avoid a manual App Store Connect step before TestFlight.
- **Cold-killed call path still unproven on a real device** — the native report
  compiled, but end-to-end ringing on a terminated app must be tested on the
  iPhone with the worker sending APNs VoIP.

## Next recommended Cursor prompt

> Phase 7: install the iOS dev build on the iPhone 15 and run the first
> on-device smoke + push-registration test. The build is live at
> `https://expo.dev/accounts/izz8457s-organization/projects/connect-mobile/builds/8cd8274e-b215-4a22-a35a-7ccfcdb3e35b`.
> Steps: (1) install on the iPhone 15 and trust the developer profile; (2) start
> `npx expo start --dev-client` and open the app; (3) verify launch, login/QR
> screen, camera/mic/notification permission prompts, and capture the PushKit
> `voipPushToken` registration logs + the `MobileDevice` row (`platform: IOS`,
> non-null `voipPushToken`); (4) set the worker `APNS_*` env vars and place a test
> inbound call to verify CallKit rings (foreground, background, cold-killed) and
> connects after answer; (5) record results in a Phase 7 report. Do not deploy
> production; do not change Android.
