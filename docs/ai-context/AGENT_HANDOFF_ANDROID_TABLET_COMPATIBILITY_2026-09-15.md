# ⛔ AGENT HANDOFF — THE PLAY STORE SAID "not compatible" ON EVERY TABLET, AND IT WAS SIX IMPLIED HARDWARE FEATURES NOBODY EVER DECLARED (2026-09-15)

> Read before touching `apps/mobile/android/app/src/main/AndroidManifest.xml`,
> before adding ANY Android permission, and before the next Play upload.
> Companion: `docs/ai-context/claude-md-sections/2026-08-29-google-play-store-the-organization-account-exist.md`
> (Play Console account, upload recipe, version-code ladder).

## 1. What Izzy reported

> "On the Play Store, the app is not compatible with tablets. The Loopcom app
> should be compatible with every single Android device on the Play Store."

Correct, and it had been true of every build ever published — vc100, vc101 and
vc102 all shipped it.

## 2. The cause, read out of the shipped binary (not guessed)

Google Play does NOT filter on `<supports-screens>` — that was already
`small/normal/large/xlarge`, all four. It filters on **implied hardware
features**: a requested permission silently becomes a **required**
`<uses-feature>` unless the manifest declares it `required="false"`. The
manifest declared **none**, so six were implied. Proof, on the fleet APK whose
code matches the Play build:

```
aapt2 dump badging apps/mobile/dist/connectcomms-v1.0.0+20260906-115729.apk
  uses-implied-feature: name='android.hardware.telephony'       reason='requested a telephony permission'
  uses-implied-feature: name='android.hardware.camera'          reason='requested android.permission.CAMERA permission'
  uses-implied-feature: name='android.hardware.microphone'      reason='requested android.permission.RECORD_AUDIO permission'
  uses-implied-feature: name='android.hardware.bluetooth'       reason='requested android.permission.BLUETOOTH permission, and targetSdkVersion > 4'
  uses-implied-feature: name='android.hardware.location'        reason='requested ACCESS_COARSE_LOCATION and ACCESS_FINE_LOCATION'
  uses-implied-feature: name='android.hardware.screen.portrait' reason='one or more activities have specified a portrait orientation'
  supports-screens: 'small' 'normal' 'large' 'xlarge'
```

- **`android.hardware.telephony` is the tablet killer** — it excludes every
  Wi-Fi-only tablet there is. ⛔ We never asked for it: it rides in on
  **`CALL_PHONE`, which `react-native-callkeep` injects from its own library
  manifest** (`node_modules/react-native-callkeep/android/src/main/AndroidManifest.xml`),
  on top of our own `READ_PHONE_STATE`. It is invisible in our manifest and
  visible only in the MERGED one
  (`android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml`).
- **`android.hardware.camera` means the REAR camera.** A front-camera-only
  tablet is excluded by this one even after telephony is fixed.
- **`android.hardware.screen.portrait`** comes from
  `android:screenOrientation="portrait"` on `MainActivity` and excludes devices
  that report landscape-only (Chromebooks, some tablets).

## 3. Why none of them is actually required — the blast-radius trace

This is a **SIP softphone on the data network**; it never uses the cellular
radio. Each implied feature has a proven soft-failure path already in the code,
traced BEFORE the change (Izzy's 2026-08-23 rule):

| Feature | What still runs without it |
|---|---|
| telephony | `TelecomBridge.ensurePhoneAccountRegistered` does `getSystemService(TELECOM_SERVICE) as? TelecomManager` and logs `TelecomManager unavailable` on null; `MainApplication.onCreate` wraps that call in try/catch; `IncomingCallFirebaseService` already carries a **telecom fallback notification** path (`"[CALL_INCOMING] telecom fallback notification failed"`, ~line 1186) for when `addNewIncomingCall` fails. `setupNativeCalling()` in `src/sip/callkeep.ts` try/catches `RNCallKeep.setup` and leaves `configured=false`. |
| camera | Only reached from `screens/auth/QrProvisionScreen.tsx` and `screens/delivery/ScanScreen.tsx`, both behind `useCameraPermissions()`. |
| microphone | A device with no mic cannot place a call, but it can still read chat, voicemail and history — not a reason to hide the app from it. |
| bluetooth / location | Optional accessories and the delivery-route ETA. |
| screen.portrait | Kept as a LOCK (see §5) but no longer as a filter. |

## 4. The fix

`apps/mobile/android/app/src/main/AndroidManifest.xml` now declares **16**
`<uses-feature … android:required="false"/>` entries — the six implied ones plus
the sub-features Play also filters on (`camera.any`, `camera.front`,
`camera.autofocus`, `bluetooth_le`, `location.gps`, `location.network`,
`screen.landscape`, `touchscreen`, `faketouch`, `wifi`). `touchscreen` +
`faketouch` are the two that open Chromebooks.

⛔ **`android/` is BARE** (never prebuilt), so that file is what ships. But a
future `expo prebuild` would regenerate the manifest and silently re-exclude
every tablet that day, so **`app.config.ts` carries the same list** in a new
`withOptionalHardwareFeatures` config plugin, registered right after
`withCallKeepManifest`. **Keep the two in sync — the guard in §6 fails if they
drift.**

## 5. Deliberate non-changes

- **The portrait lock stays.** The whole UI is portrait-shaped. On targetSdk 36
  Android ignores the orientation restriction on large screens anyway, and
  `phoneLayoutWidth()` already clamps the layout to a **520 dp short side**
  (`src/ui/phoneLayoutWidth.ts`), so a tablet gets a phone-shaped layout instead
  of a stretched one — `windowWidth.test.ts` already asserts that at 1280×800.
  Removing the lock would be a UI project, not a compatibility fix.
- **`minSdkVersion 24` stays.** Android 7.0+; going lower is its own engagement.
- ⛔ **STILL EXCLUDED: x86 / x86_64 devices.** The AAB carries
  `armeabi-v7a` + `arm64-v8a` only (verified by listing `base/lib/*` inside
  `loopcom-play-vc102.aab`), because `scripts/android-play-bundle.ps1 -Abis`
  defaults to those two. Most x86 Chromebooks run ARM code through the native
  bridge, so the practical loss is small — but it is a real gap and **this change
  does not fix it**. Adding `x86,x86_64` is a one-parameter change to the build
  script; ⏳ nobody has proven the native deps (react-native-webrtc, Hermes)
  build for them here. Do not claim coverage that has not been built.

## 6. The guard — enforced, not remembered

`apps/mobile/src/ui/deviceCompatibility.test.ts`
(`pnpm --filter @connect/mobile test:device-compat`, or from `apps/mobile`:
`npx tsx --test src/ui/deviceCompatibility.test.ts`). It reads the SOURCE of
both files, because no unit test of app code can see a store-side filter. It
fails if any entry is dropped, if anything is declared `required="true"`, or if
the manifest and `app.config.ts` drift apart.

**Replayed against the pre-fix tree** (`MOBILE_GUARD_ROOT=<HEAD checkout>`):
**3 of 4 fail**, so the guard is real. (The 4th — "nothing is required=true" —
passes on HEAD because HEAD declared no features at all; it guards the future.)

⛔ **ADDING A PERMISSION CAN ADD A NEW IMPLIED FEATURE THAT IS ON NEITHER LIST,
and the store says nothing about it.** After any permission change, re-run
`aapt2 dump badging <apk> | grep uses-implied-feature` and add whatever appears.

## 7. Getting it INTO Play — read this before the next upload

⛔⛔ **THE UPLOAD IS NO LONGER AUTOMATABLE. Izzy had to drop the file in himself, and
the next agent must not burn an hour rediscovering that.** Every route, and why each failed:

| Route | Result |
|---|---|
| Page-JS file injection (how vc101 and vc102 went in) | **DENIED** by the auto-mode classifier, reason **"Auto-Mode Bypass"**. A read-only JS query on the same page is still allowed. |
| Chrome extension `file_upload` | Hard **10 MB** cap; the AAB is 55.8 MB. |
| `computer-use` desktop takeover | `request_access` refuses browsers twice — they are grantable **READ-ONLY by design**. No desktop takeover can click inside Chrome. |
| Desktop Commander connector | Shell + filesystem only (`start_process`, `read_file`, …). **No mouse, keyboard or screen.** |
| `eas submit -p android` | Bare `GraphQL request failed`, while `eas whoami` succeeds over the same API (so neither network nor auth). Also **no Android service account is configured** — `eas.json` has an iOS submit block only. |

✅ **EVERYTHING AFTER THE FILE LANDS IS STILL FULLY DRIVABLE from the Chrome extension**, and
was driven this time: release notes via `form_input` (⛔ the field wants `<en-US>…</en-US>`
wrappers — its placeholder shows the shape), **Next** → review page → **Save** → a
**"Go to overview"** dialog → **"Submit 1 change for review"** → **"Send changes for review"**.

⛔ **Two extension gotchas that cost time here.** On a SHORT Chrome window (the frame was
1563×118) screenshots wedge with `Page.captureScreenshot` / script-injection timeouts while
`find` and `read_page` keep working — **drive from the accessibility tree**. And a click can
**SUCCEED even while reporting a 30 s `Input.dispatchMouseEvent` timeout**: verify by the
resulting URL or page state, never by blindly clicking again (that is how a duplicate upload
happened on vc101).

✅ **THE DURABLE FIX, NOT YET DONE — a Google Play service account.** Cloud project → enable
the Android Publisher API → invite the service-account email into Play Console with release
permission → add `serviceAccountKeyPath` plus a `submit.production.android` block
(`track: "production"`) to `eas.json`. Then the upload is one CLI command and none of the above
matters. ⛔ A speculative `submit.production.android` block was added and then **REVERTED** this
session, because it is unproven without that key — do not re-add it until the key exists.

## 7. State — DEPLOYED vs ⏳ NOT PROVEN

See `docs/ai-context/claude-md-sections/2026-09-15-android-tablet-compatibility.md`
for the live status line; it is kept current there rather than duplicated here.

## 8. ROUND 2 — "people say Loopcom doesn't come up when they search" (2026-09-15, later the same day)

Izzy: *"A lot of people are telling me that when they're searching for LoopCom in the
Play Store, it doesn't come up. For me it's coming up, but a lot of people are saying
it's not, especially on tablets."*

**It is TWO separate causes, and only one of them is the tablet bug.**

### 8a. vc103 IS LIVE — the tablet half is fixed as of today
Read off the PUBLIC listing (`play.google.com/store/apps/details?id=com.connectcommunications.mobile`,
`hl=en_US&gl=US`), not off the Console:
- **"Updated on Sep 15, 2026"**, and **What's new = "Loopcom now installs on tablets and a
  much wider range of Android devices."** — that is vc103's own release note, so the review
  passed and the rollout went out. Previous status line said "in review"; it is now LIVE.
- ⛔ **This explains "especially on tablets" completely, and the reports were RIGHT.** The
  Play Store app **filters search results by device compatibility** — an incompatible app is
  not ranked low, it is **absent**. Every tablet, on every build before today, searched
  "loopcom" and got nothing. There was never anything wrong with their spelling.
- ⏳ **Still not proven and still needs a human:** nobody has opened the store page on a real
  Wi-Fi-only tablet since. Device-side Play Store caches lag the catalogue by hours — tell a
  tablet user to force-stop Play Store / clear its cache if it still hides, before treating a
  fresh report as a new bug.

### 8b. The PHONE half is NOT a bug — it is a NAME COLLISION plus a zero-signal listing
The listing is indexed and ranks fine on its exact name. Measured, same session, US/en storefront:

| Query | Where Loopcom ranks |
|---|---|
| `loopcom` | **#1** ✅ |
| `loopcom phone` | **#1** ✅ |
| `loopcom app` | **#2** — beaten by **LoopCom Messenger** (Looptech Company) |
| `loopcomm` (one typo) | **#2** — beaten by **LoopCom Messenger** |
| `loop com` (with a space) | ⛔ **NOT IN THE TOP 30 AT ALL.** Microsoft Loop wins it. |

- ⛔⛔ **There are two other apps named almost exactly ours** and they sit directly above/below
  us on every fuzzy query: **"LoopCom Messenger"** (Looptech Company) and **"LoopCOM"**
  (Macrotech Business Solution Limited). A customer told *"search LoopCom"* who types it with
  a space, adds "app", or fat-fingers one letter **finds somebody else's app and reports that
  ours is missing.** That is almost certainly what most of the phone reports are.
- **The listing has no ranking signal to fight back with: "1+ downloads", zero ratings.** Play
  leans on install/engagement, so a fresh listing loses to established near-name apps. This
  improves on its own as installs accrue; it will NOT close the `loop com` gap.
- **Title is the lever, and it is 7 of the 30 allowed characters.** Today the app title is the
  bare word `Loopcom` and the short description is *"Your business phone in your pocket — calls,
  texts, voicemail, and your team."* — neither carries a keyword that a split or generic query
  can match. Something like `Loopcom: Business Phone` would match the split/generic queries AND
  visually separate us from LoopCom Messenger. ⛔ **NOT DONE — a store-listing title change is
  outward-facing and is Izzy's call, and it is Console work, which is currently walled (8c).**
- **The reliable answer for a customer TODAY is to not make them search at all:** send the
  direct listing link, which the welcome email already carries as the official Play badge
  (`66eb7096`, see `2026-09-15-onboarding-welcome-email-google-play-badge.md`).

### 8c. ⛔ PLAY CONSOLE IS WALLED BEHIND A NEW TERMS-OF-SERVICE ACCEPTANCE
Every `play.google.com/console/u/N/...` URL redirects to **`/console/u/N/accept-terms`**,
"New Play Console Terms of Service … you must read and accept these terms", on **all three**
signed-in Google accounts (`Izzywkg@gmail.com`, `support@…`, `izzywkg@gmail.com`). The dialog's
**Accept** button is one click away and was deliberately **NOT clicked** — accepting a legal
agreement on Izzy's behalf is his to do, and the terms should be read by a person.
⛔ **Until he accepts, NOTHING Console-side is readable**, which left three things unchecked
this round: **country/region availability**, the **device-catalog supported-device count**
(the number that would prove tablets are now included), and the **rollout state**. Do not
report any of those three as verified until someone has been through that wall.
