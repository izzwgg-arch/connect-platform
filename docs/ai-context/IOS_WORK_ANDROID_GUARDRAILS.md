# iOS Production Work — Android Safety Guardrails

> **Read this before ANY change made in the name of iOS App Store readiness.**
> Owner-mandated (Izzy): the Android app is in production on the Play Store and
> **must not break in any way while iOS work proceeds.** This is the #1 constraint.
> History: a June 28 2026 iOS cold-answer fix broke Android and had to be reverted
> (commit 1f5b0766). Do not repeat that. When in doubt, STOP and ask the owner.

---

## 1. The rule in one line

**iOS work may only touch iOS-only surfaces. If a change could alter Android
behavior, it is out of scope until the owner explicitly approves that specific change.**

---

## 2. What "iOS-only surface" means (allowed without extra sign-off)

- Files under an iOS-only path: `plugins/withIosVoipPush.js`, `ios/**`, any
  `*.ios.ts/tsx` file.
- The `ios:` block of `app.config.ts` (infoPlist, privacyManifests, entitlements,
  bundleIdentifier). Keys added *inside* `ios:` cannot affect the Android build.
- `Platform.OS === 'ios'` branches in shared TS, where the `else`/Android path is
  left byte-for-byte unchanged.
- iOS-only sections of `eas.json` build profiles (the `"ios"` keys), and the
  `submit.production.ios` block.
- iOS store assets, screenshots, and documentation.

## 3. Hands OFF without explicit per-change owner approval (shared arteries)

These are shared or Android-critical. Do not edit them for iOS reasons:

- `app.config.ts` `android:` block, top-level `plugins` ordering/behavior that
  affects Android (e.g. `withCallKeepManifest`, `withIncomingCallService`),
  `expo-notifications` androidChannels, `expo-build-properties` android.
- Anything under `apps/mobile/android/**` (the native Kotlin/Java layer:
  IncomingCallFirebaseService, SipKeepAliveService, IncomingCallUiModule,
  MainActivity/MainApplication, boot receivers, etc.).
- Shared telephony/call-state logic consumed by both platforms:
  ConnectWakeConsumer, CallStateStore, normalizeCallEvent, invite/requeue logic,
  the worker push fan-out (except the `device.platform === "IOS"` branch).
- Shared dependency or SDK version bumps. No upgrading a package "for iOS" if
  Android also depends on it — that is a separate, deliberate, owner-approved decision.
- `google-services.json`, FCM config, Android permissions list.

## 4. Mandatory gate before ANY iOS change ships

A change is not "done" until ALL of these pass. No exceptions, no "just this once":

1. **Scope proof:** `git diff --name-only` shows only iOS-only files (section 2).
   If any file from section 3 appears, STOP.
2. **Mobile pure-logic test suite** green.
3. **Telephony test suite** green (shared call-state paths).
4. **Manual Android cold-call smoke test** passes: kill the Android app, place an
   inbound call, confirm it rings and answers. Owner or a human performs this.
5. Written change summary: what changed, what was deliberately NOT touched, how to
   verify, how to revert.

## 5. If iOS genuinely needs a shared-file change

Stop. Do not make it silently. Surface it to the owner with: the exact file, why
iOS needs it, the precise Android impact, and a rollback plan. Proceed only on the
owner's explicit yes for that specific change.

---

*This doc is enforcement, not a suggestion. Cursor and every agent must honor it.*
