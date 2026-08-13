# iOS App Store Readiness Checklist

> Goal: get the Connect iPhone app fully production-ready and submitted to the App
> Store, at parity with the Android app, **without breaking Android**.
> Safety spine for every step: `IOS_WORK_ANDROID_GUARDRAILS.md`.
> Plain-English status so the owner (Izzy) can see exactly what's left.

Legend: ✅ done · 🟡 prepared, needs owner action · ⬜ not started

---

## A. Already done in the repo (verified in code)

- ✅ Bundle identifier `com.connectcommunications.mobile` (`app.config.ts` → ios).
- ✅ iOS purpose strings: camera, microphone, contacts (`ios.infoPlist`).
- ✅ Background modes: `voip`, `remote-notification`, `audio`.
- ✅ Native PushKit + CallKit wiring via `plugins/withIosVoipPush.js` (reports
  CallKit before JS boots; no-op on Android).
- ✅ Worker APNs VoIP sender (`packages/shared/apnsVoipPush.ts`), gated on
  `device.platform === "IOS"`.
- ✅ `eas.json` production profile with iOS `autoIncrement: buildNumber`.
- ✅ Cold-killed CallKit ring verified on a real iPhone (Phase 7b, commit 0141aa2d).
- ✅ OTA updates disabled (owner directive) — ship only via new builds.

## B. Compliance changes made this session (iOS-scoped, zero Android surface)

- ✅ **Encryption export declaration** — `ITSAppUsesNonExemptEncryption: false`
  added to `ios.infoPlist`. Removes the manual export-compliance prompt on every
  build. (App uses only standard TLS/HTTPS — exempt.)
- ✅ **Privacy manifest** — `ios.privacyManifests` added, declaring the
  required-reason APIs (UserDefaults, file timestamp, system boot time, disk
  space), `NSPrivacyTracking: false`, no tracking domains. Apple requires this.

## C. Cursor builds these (iOS-scoped, behind the Android gate)

- ⬜ Prebuild + production iOS build via EAS (`eas build -p ios --profile production`).
- ⬜ Confirm the privacy manifest and encryption key land in the generated
  `Info.plist` / `PrivacyInfo.xcprivacy` after prebuild.
- ⬜ Run mobile + telephony test suites; produce the iOS-only `git diff` proof.

## D. Owner-only human steps (no tool can do these for you)

These are hard-gated by Apple and by safety rules. They are quick, but they're yours:

- 🟡 **Apple Developer account / signing.** Sign in to your Apple Developer
  account; let EAS manage or upload the distribution certificate + provisioning
  profile. (Credentials never pass through an agent.)
- 🟡 **APNs production flip.** Set `APNS_PRODUCTION=1` (or the equivalent) in the
  server worker environment so VoIP pushes go to Apple's production host for
  TestFlight/App Store builds. Agents can only tell you the value; you apply it in
  `/opt/connectcomms/env/` — which is off-limits to agents.
- 🟡 **Demo account for Apple review.** Apple reviewers must be able to place a
  call that actually rings. Provide a test extension/login that rings on iOS (e.g.
  enroll an iOS-only test extension in the wake canary). Put the credentials in the
  App Store review notes.
- 🟡 **`eas.json` submit block.** Fill `submit.production.ios` with your `appleId`,
  `ascAppId`, and `appleTeamId` (or connect an App Store Connect API key). These
  are your account identifiers — you add them.
- 🟡 **Store listing in App Store Connect.** App name, subtitle, description,
  keywords, support URL, **privacy policy URL**, category, screenshots (6.7" and
  6.1" at minimum), app privacy questionnaire.
- 🟡 **Submit for review** (`eas submit -p ios --profile production`, then hit
  Submit in App Store Connect). This is an irreversible publish action — yours.

## E. Ship gate (must pass before submission — see guardrails doc)

- ⬜ `git diff --name-only` shows only iOS-only files + docs.
- ⬜ Mobile pure-logic test suite green.
- ⬜ Telephony test suite green.
- ⬜ **Manual Android cold-call smoke test passes** (kill app, inbound call rings
  and answers). Android must be provably intact.

---

*Update the checkboxes as steps land. Do not mark C or E complete on green CI
alone — confirm the artifact and the Android smoke test per the guardrails doc.*
