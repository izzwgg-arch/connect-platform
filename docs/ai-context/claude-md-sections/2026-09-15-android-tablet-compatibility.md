# ⛔ ANDROID TABLET / EVERY-DEVICE COMPATIBILITY — the Play listing read "not compatible" on every tablet, and it was six IMPLIED hardware features nobody ever declared (2026-09-15)

Full handoff: `docs/ai-context/AGENT_HANDOFF_ANDROID_TABLET_COMPATIBILITY_2026-09-15.md`.
Play Console account / upload recipe / version-code ladder:
`2026-08-29-google-play-store-the-organization-account-exist.md`.

- ⛔⛔ **PLAY FILTERS ON IMPLIED FEATURES, NOT ON `<supports-screens>`.** A
  requested permission silently becomes a **required** `<uses-feature>` unless
  the manifest says `required="false"`. Ours declared **none**, so `aapt2 dump
  badging` on the shipped build reported **six required**: `telephony`,
  `camera`, `microphone`, `bluetooth`, `location`, `screen.portrait`.
  `supports-screens` was already all four sizes — that was never the problem.
  **vc100, vc101 and vc102 all shipped this.**
- ⛔ **`telephony` is the tablet killer and WE NEVER ASKED FOR IT**: it rides in
  on `CALL_PHONE`, injected by **`react-native-callkeep`'s own library
  manifest**, on top of our `READ_PHONE_STATE`. Invisible in our manifest —
  only the MERGED manifest shows it. **`camera` means the REAR camera**, so a
  front-camera-only tablet stays excluded even after telephony is fixed.
  `screen.portrait` comes from `android:screenOrientation="portrait"`.
- ✅ **FIX: 16 `<uses-feature … required="false"/>` entries** in
  `apps/mobile/android/app/src/main/AndroidManifest.xml` (the six + the
  sub-features Play also filters on; `touchscreen` + `faketouch` are what open
  Chromebooks). ⛔ `android/` is BARE so that file is what ships — but
  `app.config.ts` carries the SAME list in a new `withOptionalHardwareFeatures`
  config plugin, because an `expo prebuild` would otherwise re-exclude every
  tablet that day. **Keep the two in sync.**
- ✅ **Safe because every one of them already degrades**, traced before the
  change: `TelecomBridge` null-checks `TELECOM_SERVICE`, `MainApplication`
  try/catches the registration, `IncomingCallFirebaseService` has a **telecom
  fallback notification** path, `setupNativeCalling()` try/catches
  `RNCallKeep.setup`, and the camera is only reached from the two QR screens
  behind `useCameraPermissions()`.
- ✅ **The portrait lock STAYS on purpose.** targetSdk 36 ignores orientation
  restrictions on large screens anyway, and `phoneLayoutWidth()` already clamps
  to a **520 dp short side**, so a tablet gets a phone-shaped layout rather than
  a stretched one (`windowWidth.test.ts` asserts it at 1280×800). Only the
  store-side *filter* was removed.
- ✅ **Guard: `apps/mobile/src/ui/deviceCompatibility.test.ts`**
  (`test:device-compat`) reads BOTH files' source — no unit test of app code can
  see a store-side filter. **Replayed against pre-fix HEAD it fails 3 of 4.**
  ⛔ **A new permission can imply a NEW required feature on neither list and the
  store stays silent** — after any permission change re-run
  `aapt2 dump badging <apk> | grep uses-implied-feature`.
- ⛔ **STILL EXCLUDED, NOT FIXED BY THIS: x86 / x86_64.** The AAB carries
  `armeabi-v7a` + `arm64-v8a` only (verified inside `loopcom-play-vc102.aab`).
  Most x86 Chromebooks run ARM through the native bridge so the loss is small,
  but do not claim coverage that has not been built. Adding them is one
  parameter on `scripts/android-play-bundle.ps1`; ⏳ never proven to build here.
  `minSdkVersion 24` also stays (Android 7.0+).
- **STATUS:** ✅ code committed, guard green, `tsc --noEmit` clean, and
  `loopcom-play-vc103.aab` BUILT with **zero required features left**
  (`aapt2` re-run on the artifact — see `TESTS_RUN.md`).
  ⏳ **NOT UPLOADED — publishing is Izzy's call**; next version code after this
  is **104**. ⏳ **NOT PROVEN:** nobody has opened the store page on a real
  Wi-Fi-only tablet and seen **Install** instead of "Your device isn't
  compatible with this version", and no call has rung on a tablet.
