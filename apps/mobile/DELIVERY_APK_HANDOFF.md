# Connect Delivery — Local Android APK: build, QA &amp; Desktop handoff (Gate 5)

This is the plan for producing the driver APK **locally** and handing it to the Desktop. Do NOT
publish to Google Play. Run in a working toolchain (this authoring env can't build Android).

## 0. Prerequisites
- JDK 17+ (Android Studio JBR / Adoptium / MS OpenJDK), Android SDK + NDK `26.1.10909125`,
  build-tools `34.0.0` (the committed `android/` project targets compile/target SDK 34).
- The API + DB must be reachable by the app (`EXPO_PUBLIC_API_BASE_URL`), and the delivery
  migration must be applied + client generated (see `apps/api/src/delivery/DELIVERY_RUNBOOK.md`).
- The delivery driver screens are wired: **Settings → Delivery → Delivery driver** opens the
  flow (Runs → Stop → Navigate/Arrive → Proof / Report a problem, plus Scan).

## 1. Release keystore (decision 6 — a NEW dedicated keystore, NOT the debug key)
```bash
node scripts/gen-keystore.cjs        # or keytool -genkeypair … (RSA 2048, validity 10000)
# store keystore + passwords OUTSIDE git (e.g. a password manager / CI secret). Never commit it.
```
Point `android/app/build.gradle` `signingConfigs.release` at the new keystore (replace the
debug-key reuse currently flagged there).

## 2. Version + build number
- Set `expo.version` (semantic, e.g. `1.0.0`) and Android `versionCode` in `app.config.ts` /
  `android/app/build.gradle`. Record both in the release notes.

## 3. Build the APK (arm64 release)
```bash
pnpm --filter @connect/mobile exec expo prebuild --platform android   # if android/ is stale
pnpm mobile:build:android:release      # scripts/build-android-release.ps1 → assembleRelease
# output: apps/mobile/android/app/build/outputs/apk/release/app-release.apk
#         (also copied to apps/mobile/dist/connect-android-release-<stamp>.apk)
```

## 4. Verify the artifact
```bash
# checksum
sha256sum apps/mobile/android/app/build/outputs/apk/release/app-release.apk
# secret scan (must find nothing)
unzip -p app-release.apk assets/index.android.bundle | grep -iE "PRIVATE KEY|BEGIN RSA|password=|secret=|voip\.ms|CREDENTIALS_MASTER_KEY" || echo "no obvious secrets"
# confirm it's release-signed (not the debug key)
apksigner verify --print-certs app-release.apk | grep -i "Signer #1 certificate DN"
```

## 5. On-device / emulator smoke (Gate 5 checklist)
Install (`adb install -r app-release.apk`) and verify, on a real arm64 device where possible:
- [ ] Login (email/password or QR provision)
- [ ] Settings → Delivery → **Delivery driver** opens Runs
- [ ] **Scan** a label (camera opens; success/duplicate/offline states behave)
- [ ] Offline scan queues + syncs on reconnect (no double assignment)
- [ ] Open a stop → **Navigate with Waze** (Waze opens; Google fallback if Waze absent)
- [ ] **I've arrived** → **Deliver — capture proof** (camera photo) → completes → DELIVERED
- [ ] **Report a problem** → reason + note/photo → dispatch notified
- [ ] Active-run **location sharing** shows the persistent notification; stops when run ends
- [ ] Battery-low / GPS-off / permission-revoked states are graceful
- [ ] Logout unlinks the device

## 6. Desktop handoff
Create `Connect Delivery Tracking - APK` on the Windows Desktop containing:
- `connect-delivery-driver-v1.0.0-rc1.apk`  (clear, versioned filename)
- `RELEASE-NOTES.md` (version, build number, what's included, known limitations)
- `INSTALL.md` (enable "install unknown apps", `adb install -r`, or sideload steps)
- `CHECKSUM.txt` (sha256)
- `TEST-CHECKLIST.md` (§5 above)
- `CONFIG.md` (required server env: EXPO_PUBLIC_API_BASE_URL, DELIVERY_ORDER_SOURCE_SECRET,
  PUBLIC_TRACKING_BASE_URL; and that a tenant must have DeliveryTenantSettings.enabled=true)
- `UNINSTALL.md` (adb uninstall / rollback note)

## 7. Known limitations to state in RELEASE-NOTES
- Signature capture pad is not yet in the proof screen (photo + recipient + handover are);
  wire a signature component next.
- Route optimization needs stop coordinates (source-provided or geocoded).
- SMS/IVR are test-mode only until separately activated; no live PBX/SMS changes.
- Real supermarket Order API (Phase 10) pending its docs — mock adapter until then.

## Guardrails
- Do NOT publish to Play. Do NOT embed production credentials. Do NOT commit the keystore.
- "APK built" is only true once the file exists, is release-signed, secret-scanned, and
  installed+smoke-tested — then report the exact Desktop path + checksum.
