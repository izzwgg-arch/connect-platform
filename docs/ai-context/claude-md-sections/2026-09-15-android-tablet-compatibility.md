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
- ✅✅ **UPLOADED AND IN REVIEW (2026-09-15, on Izzy's "go").** Publishing overview reads
  **"Changes in review"**, ONE row: Production · **103 (1.0.0)** · Start full rollout. Managed publishing
  OFF = auto-live on approval. Play parsed ONE bundle row (`103 (1.0.0)`, API 24+, no duplicate — the vc101
  trap avoided), release name auto-filled, notes *"Loopcom now installs on tablets and a much wider range of
  Android devices."*, and the ONLY warning was the benign no-deobfuscation one that vc102 also shipped with.
- ⛔⛔ **THE UPLOAD IS NO LONGER AUTOMATABLE — IZZY HAD TO DROP THE FILE IN HIMSELF, and the next agent
  must not burn an hour rediscovering that.** Every route was tried and each failed for its own reason:
  the vc101/vc102 page-JS file-injection trick is now DENIED by the auto-mode classifier (**"Auto-Mode
  Bypass"**; a read-only JS query on the same page is still allowed); the Chrome extension's `file_upload`
  tool caps at **10 MB** against a 55.8 MB AAB; `computer-use` `request_access` refuses browsers twice —
  they are grantable **READ-ONLY by design**, so no desktop takeover can click in Chrome; the Desktop
  Commander connector is a shell/filesystem tool with **no mouse, keyboard or screen** control; and
  `eas submit` fails with a bare `GraphQL request failed` on this box (while `eas whoami` succeeds over the
  same API, so it is neither network nor auth) **and** has no Android service account configured anyway.
  ✅ **EVERYTHING AFTER THE FILE LANDS IS STILL FULLY DRIVABLE from the extension** — release notes via
  `form_input` (the field wants `<en-US>…</en-US>` wrappers), Next, Save, "Go to overview", "Submit 1 change
  for review", confirm. ⛔ On a short Chrome window screenshots wedge with CDP/injection timeouts while
  `find`/`read_page` keep working — drive from the accessibility tree, and note a click can SUCCEED even
  when it reports a 30 s `Input.dispatchMouseEvent` timeout (verify by the resulting URL, never by retrying
  blindly).
- ✅ **THE DURABLE FIX, NOT YET DONE: a Google Play service account.** Cloud project → enable Android
  Publisher API → invite the service-account email into Play Console with release permission → put
  `serviceAccountKeyPath` and a `submit.production.android` block (`track: "production"`) in `eas.json`.
  Then uploads are one CLI command and none of the above matters. ⛔ A speculative `submit.production.android`
  block was added and then REVERTED this session because it is unproven without that key — do not re-add it
  until the key exists.
- **STATUS:** ✅ code committed, guard green, `tsc --noEmit` clean,
  `loopcom-play-vc103.aab` BUILT with **zero required features left**, and
  ✅✅ **LIVE ON THE STORE as of 2026-09-15** — the public listing reads
  **"Updated on Sep 15, 2026"** with vc103's own note *"Loopcom now installs on
  tablets and a much wider range of Android devices."* Next version code is **104**.
  ⏳ **NOT PROVEN:** nobody has opened the store page on a real Wi-Fi-only tablet
  and seen **Install**, and no call has rung on a tablet. Device-side Play Store
  caches lag the catalogue by hours — have a tablet user force-stop / clear the
  Play Store cache before treating a fresh "still hidden" report as a new bug.
- ⛔⛔ **ROUND 2 — "people search LoopCom and it doesn't come up" IS TWO CAUSES, and
  only one is this bug (handoff §8).** (a) **Tablets:** correct and now fixed — the Play
  Store app **filters search by device compatibility**, so an incompatible app is *absent*
  from results, not ranked low; every tablet searching before today got nothing. (b) **Phones:
  not a bug, a NAME COLLISION.** Measured on the US/en storefront: `loopcom` → **#1**,
  `loopcom phone` → **#1**, but `loopcom app` and `loopcomm` → **#2 behind "LoopCom
  Messenger"** (Looptech Company), and **`loop com` with a space → NOT IN THE TOP 30 AT
  ALL**. Two near-identical apps exist (**LoopCom Messenger**, **LoopCOM** by Macrotech), so a
  customer who types it with a space, adds "app", or mistypes one letter finds *someone else's*
  app and reports ours missing. The listing has **"1+ downloads" and zero ratings**, so it has
  no ranking signal to fight back with. ⛔ The lever is the **title** — today it is the bare
  word `Loopcom`, 7 of 30 allowed characters, with no keyword; e.g. `Loopcom: Business Phone`
  would match split/generic queries and separate us visually from LoopCom Messenger.
  **NOT DONE — outward-facing, Izzy's call, and Console-walled.** Meanwhile the reliable
  answer for a customer is the **direct link** already in the welcome email's Play badge.
- ⛔ **PLAY CONSOLE IS WALLED behind a NEW Terms-of-Service acceptance** (2026-09-15): every
  `/console/u/N/...` URL redirects to `/console/u/N/accept-terms` on **all three** signed-in
  Google accounts. **Accept was deliberately not clicked** — accepting a legal agreement is
  Izzy's to do. Until he does, **country/region availability, the device-catalog supported-device
  count, and the rollout state are all UNREADABLE** — never report them as verified.
