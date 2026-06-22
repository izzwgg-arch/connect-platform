# Phase 5 — Harden iOS Cold-Killed PushKit → CallKit Reporting

Status: **Implemented (native + JS), pending first EAS `ios-dev-device` build to verify generated AppDelegate language.**

Goal: make a **fully cold-killed** (swiped-away / terminated) iPhone ring on an
incoming call by reporting the call to CallKit **inside the native PushKit
handler, before the PushKit completion handler returns** — Apple's hard
requirement. JS-only reporting (Phase 4) covers foreground / warm-background
only; it cannot wake a terminated app in time.

---

## 1. Files changed

| File | Change |
|------|--------|
| `apps/mobile/src/sip/callkitUuid.ts` | **NEW.** Pure, dependency-free deterministic CallKit-UUID derivation (`deterministicCallKitUuid`) + `utf8Bytes` / `fnv1a32` helpers. No React Native imports, so it is unit-testable and shared as the single source of truth for the algorithm. |
| `apps/mobile/src/sip/callkitUuid.test.ts` | **NEW.** 7 unit tests: format/version/variant, determinism, distinctness, empty-string defense, UTF-8 parity, FNV-1a-32 canonical vector, and **locked reference vectors** that the native code must reproduce. |
| `apps/mobile/src/sip/callkeep.ts` | `callKitUuidForCallId()` now derives the UUID via `deterministicCallKitUuid(callId)` instead of a random v4. Removed the old `generateUuidV4()`. `endNativeCall()` now resolves the **deterministic** UUID on iOS even when the map is empty (cold-killed cancel reconciliation). |
| `apps/mobile/plugins/withIosVoipPush.js` | Native PushKit handler now **reports to CallKit before completion** via `[RNCallKeep reportNewIncomingCall:…]`, using `ConnectDeterministicCallKitUUID` (Obj-C port of the JS algorithm). Added `#import "RNCallKeep.h"`. Hardened AppDelegate language handling: full Obj-C++ patch + post-patch verification; **loud, actionable failure logging** for Swift / unknown AppDelegate instead of a silent no-op. Updated header docs. |
| `docs/mobile-ios-phase5-cold-killed-callkit-report.md` | **NEW** (this file). |
| `docs/mobile-ios-production-plan.md` | Phase 5 marked done; native cold-killed path described. |
| `docs/mobile-ios-current-state.md` | Updated to reflect native CallKit reporting + deterministic UUID. |

No backend, worker, or Android files were modified.

---

## 2. Deterministic UUID algorithm

Both JS (`apps/mobile/src/sip/callkitUuid.ts`) and native
(`ConnectDeterministicCallKitUUID` in `plugins/withIosVoipPush.js`) compute the
**identical** UUID from the backend `callId` with no shared runtime state.

```
INPUT:  callId (UTF-8 bytes; Connect callIds are ASCII cuids)
OUTPUT: 16 bytes → canonical 8-4-4-4-12 lowercase hex UUID

FNV-1a-32:  offset basis = 0x811c9dc5, prime = 0x01000193, 32-bit wraparound
            h = offset
            for each byte b:  h = (h XOR b) ; h = (h * prime) mod 2^32

for i in 0..15:
    h      = FNV-1a-32 over the byte sequence [ i, ...utf8(callId) ]   // salt = i
    out[i] = (h XOR (h>>>8) XOR (h>>>16) XOR (h>>>24)) & 0xFF          // fold to 8 bits

out[6] = (out[6] & 0x0F) | 0x50     // RFC-4122 version 5 nibble
out[8] = (out[8] & 0x3F) | 0x80     // RFC-4122 variant bits

format: out[0..3] "-" out[4..5] "-" out[6..7] "-" out[8..9] "-" out[10..15]
```

Why this design:
- **Deterministic** — same `callId` always yields the same UUID, so native (cold
  start) and JS (after boot) converge without coordination.
- **Dependency-free** — FNV-1a + bit folding is trivial to implement identically
  in JS (`Math.imul` for 32-bit multiply) and Obj-C/Swift (`uint32_t`). No SHA-1
  / CommonCrypto / external uuid package needed on either side.
- **Valid for CallKit** — `NSUUID(uuidString:)` only requires the canonical
  8-4-4-4-12 hex shape; version/variant bits are set to keep it a well-formed
  RFC-4122 v5-style UUID.

### Locked reference vectors (JS ↔ native parity anchors)

These are asserted by `callkitUuid.test.ts` and **must** be reproduced
byte-for-byte by the native Obj-C function. Changing the algorithm means
updating both sides and these vectors together.

| callId | UUID |
|--------|------|
| `call-123` | `bcbdbb23-3b75-50f2-a5ad-b6d46bada693` |
| `clx0a1b2c3d4e5f6g7h8i9j0k1` | `4b9c9e39-9e19-5ebe-8fc9-a826b860851d` |
| FNV-1a-32(`"a"`) | `0xe40c292c` (canonical sanity check) |

---

## 3. Native CallKit report path (cold-killed)

In `withIosVoipPush.js`, the injected
`pushRegistry:didReceiveIncomingPushWithPayload:forType:withCompletionHandler:`:

1. Reads `payload.dictionaryPayload` and extracts `callId` (falls back to
   `inviteId`), `callerNumber`, `callerName`.
2. Derives the deterministic UUID via `ConnectDeterministicCallKitUUID(callId)`.
3. Calls **`[RNCallKeep reportNewIncomingCall:uuid handle:… handleType:@"number"
   hasVideo:NO localizedCallerName:… supportsHolding:YES supportsDTMF:YES
   supportsGrouping:NO supportsUngrouping:NO fromPushKit:YES payload:dict
   withCompletionHandler:nil]`** — this is the Apple-compliant "report before
   completion" call, and works from a terminated app because RNCallKeep
   lazily configures the CXProvider when called from PushKit.
4. Forwards the same payload to JS via
   `[RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:…]` so the
   existing JS pipeline can hydrate invite state.
5. Calls `completion()`.

Flow for a cold-killed device:

```
PBX inbound → worker sendApnsVoipPush (apns-push-type: voip)
  → iOS wakes app process for PushKit
  → AppDelegate didReceiveIncomingPush:
        report to CallKit (native, deterministic UUID)  ← rings the phone
        forward payload to JS
        completion()
  → JS boots, onIncoming() hydrates CallInvite + safeSetInvite (NO SIP yet)
  → user taps Answer in CallKit
  → CallKeep 'answerCall' (UUID) → callIdForCallKitUuid → handleAcceptInvite
  → SIP/WebRTC connects (connect-after-answer)
```

---

## 4. AppDelegate language support

| Generated AppDelegate | Behavior |
|-----------------------|----------|
| **Objective-C++ (`.mm`, `objc`/`objcpp`)** | **Fully supported.** All three PKPushRegistryDelegate methods + native CallKit report are injected, then the patch is verified (sentinel present) and a success line is logged. This is the **Expo SDK 51 default**. |
| **Swift (`.swift`)** | **Detected, not auto-patched.** The plugin prints a loud, multi-line `console.error` explaining that a Swift port of the PushKit→CallKit handler is required and that cold-killed calls will not ring until it exists. No silent no-op. |
| **Unknown** | `console.error` with guidance; patch skipped. |

Rationale: the repo has never run an iOS prebuild, so we cannot verify the
generated language without an EAS/macOS build. SDK 51 emits Obj-C++, which we
fully handle; for anything else we fail loudly per the task's "safe detection and
clear failure logging" requirement. **First EAS `ios-dev-device` build must
confirm the language and that the success log line appears.**

---

## 5. JS / native dedupe reconciliation

- **Same UUID, both sides.** Native and JS both derive the CallKit UUID from
  `callId` with the identical algorithm, so they reference the *same* CallKit
  call object. CallKit keys calls by UUID, so a JS `displayIncomingCall` for a
  UUID the native side already reported is idempotent (CallKit updates the
  existing call; it does not create a second incoming UI).
- **`reportedIncomingCallIds` set** in `callkeep.ts` dedupes within a single JS
  runtime (e.g. device receiving both an Expo alert push and a VoIP push).
- **Answer** → CallKeep `answerCall` carries the UUID → `callIdForCallKitUuid()`
  reverses it to the backend `callId` (map populated by `onIncoming`, which runs
  before the user can answer) → existing **`handleAcceptInvite`** path. If the
  reverse map is somehow empty, `resolveInviteForAction` falls back to the
  freshest pending invite, so answer still resolves.
- **Decline / end** → CallKeep `endCall` → reversed to `callId` → existing
  **`handleDeclineInvite`** path.

---

## 6. Cancel / end-call behavior (INVITE_CANCELED, caller hung up before answer)

What is implemented now:
- **Foreground / warm-background:** the existing JS path ends the CallKit call.
  An `INVITE_CANCELED` data event and a SIP `idle` transition both call
  `endNativeCall(callId)`. `endNativeCall` now resolves the **deterministic**
  UUID on iOS (even if the map was never populated), so it ends *exactly* the
  call the native handler reported. This is an improvement over Phase 4's random
  UUID, which could not be matched after a native cold-killed report.
- **SIP terminates (remote hangup / voicemail rollover):** the iOS guard in
  `NotificationsContext` (`Platform.OS === "ios" && lingerId → endNativeCall`)
  tears down the CallKit UI.

What still requires backend support (documented, **not** implemented):
- **Fully cold-killed cancel-before-answer.** If the caller hangs up while the
  callee's app is still terminated, there is no live JS to receive the
  `INVITE_CANCELED` data push, and the CallKit UI would keep ringing until its
  own timeout. Properly ending it requires the backend to send a **second
  call-only signal** that wakes the app to call `endCall(uuid)`. Per the task
  constraints we did **not** misuse a VoIP push for a non-incoming-call event
  and did **not** modify the backend. Options for a future phase:
  - send a dedicated "call canceled" VoIP push that the native handler maps to
    `endCallWithUUID:` (requires careful Apple-compliance: a VoIP push that does
    not report a new call is discouraged), **or**
  - rely on CallKit's incoming-call timeout (default ~ a few seconds of ringing
    then "missed"), **or**
  - have the app, immediately after CallKit answer, learn from SIP that the
    INVITE is already gone and end the call.
  Recommended: track this as a backend "call canceled" event in a later phase.

No general/notification UI is shown for cancels; VoIP pushes remain call-only.

---

## 7. Android regression protection

- All new logic is gated on `Platform.OS === "ios"` (the `endNativeCall` UUID
  branch) or lives in the iOS-only config plugin / iOS-only `voipPush` listener.
- The `callId ↔ UUID` maps and `reportedIncomingCallIds` set are only populated
  via `showIncomingNativeCall`, which is invoked on iOS only. On Android every
  lookup falls through to the raw `callId`, so `endNativeCall` / answer / decline
  behave exactly as before.
- `plugins/withIosVoipPush.js` only patches iOS AppDelegate; Android's
  `plugins/withIncomingCallService.js` and native Telecom/ConnectionService code
  are untouched.
- No worker/backend changes, so Android FCM/Expo killed-app wake is unchanged.

---

## 8. Commands run and results

| Command | Result |
|---------|--------|
| `node -e "require('./plugins/withIosVoipPush.js')"` | **OK** — plugin loads, exports a function (valid JS, no syntax errors). |
| `npx tsx --test src/sip/callkitUuid.test.ts` | **7/7 passed** (format, determinism, distinctness, empty-string, UTF-8 parity, FNV canonical vector, locked reference vectors). |
| `pnpm --filter @connect/mobile typecheck` | Exit 2 — **only the 6 pre-existing, unrelated errors** in `CallSessionManager.tsx`, `SipContext.tsx`, `jssip.ts` (identical set to the committed baseline `_latency_logs/_tsc_mobile_gate2.txt`). **Zero errors in `callkitUuid.ts`, `callkeep.ts`, or `withIosVoipPush.js`.** |
| Lint (ReadLints on changed files) | **No linter errors.** |

The deterministic-UUID reference vectors were generated from the JS
implementation and locked into the test, so the native Obj-C function can be
validated against them on the first build.

---

## 9. Remaining blockers before first iPhone 15 EAS dev build/test

1. **Apple credentials / EAS:** Apple Developer account enrolled; EAS able to
   provision the `ios-dev-device` profile for the physical iPhone 15.
2. **APNs env vars** for the worker (`APNS_TEAM_ID`, `APNS_KEY_ID`,
   `APNS_AUTH_KEY_P8`/`_BASE64`, `APNS_BUNDLE_ID`, `APNS_VOIP_TOPIC`,
   `APNS_PRODUCTION`) so VoIP pushes actually send.
3. **First `expo prebuild` / EAS build must verify the AppDelegate language.**
   If Obj-C++ → expect the `[withIosVoipPush] Objective-C++ AppDelegate patched`
   log. If Swift → the loud error fires and a Swift port is required before
   cold-killed calls work.
4. **`RNCallKeep.h` import resolution** under the generated Pods header search
   path must be confirmed on the build (quote import `"RNCallKeep.h"` is the
   library-documented form; if it fails, switch to `<RNCallKeep/RNCallKeep.h>`).
5. **Cold-killed cancel-before-answer** needs a future backend "call canceled"
   signal (Section 6).

---

## Status

**Implemented and verified as far as is possible without macOS/EAS.** Native
PushKit→CallKit reporting before completion is wired for Obj-C++ AppDelegate with
a deterministic UUID shared bit-for-bit between native and JS; Swift is detected
with loud failure logging; JS reconciliation, dedupe, answer/decline, and
end/cancel paths are updated and unit-tested where pure; Android and the backend
are untouched. The remaining work is an EAS build to confirm the generated
AppDelegate language and exercise the live call path.

## Risks

- **AppDelegate language unknown until first build.** Mitigated by full Obj-C++
  support + loud Swift detection (no silent failure).
- **`RNCallKeep.h` import form** may need `<RNCallKeep/RNCallKeep.h>` depending
  on Pods config — easy one-line fix once the build reveals it.
- **Cold-killed cancel** still rings until CallKit timeout without a backend
  cancel signal (documented, out of scope this phase).
- **Native parity drift:** if the JS algorithm is edited without updating the
  Obj-C port (or vice-versa), native and JS would diverge. Mitigated by the
  locked reference vectors + prominent cross-reference comments in both files.

## Exact next recommended Cursor prompt

> Begin Phase 6: first iOS EAS dev build + native verification for Connect.
> Do not deploy. Do not change Android. Tasks:
> 1. Run `eas login` and `eas credentials` for iOS; confirm the Apple team can
>    provision the `ios-dev-device` profile for a physical iPhone 15.
> 2. Trigger `eas build -p ios --profile ios-dev-device` (or `expo prebuild -p
>    ios` first if the workflow requires) and capture the build log.
> 3. From the build, determine whether the generated AppDelegate is Objective-C++
>    or Swift. Confirm the `[withIosVoipPush] Objective-C++ AppDelegate patched`
>    log appears, or, if Swift, implement and verify the Swift PushKit→CallKit
>    port using the deterministic UUID from `apps/mobile/src/sip/callkitUuid.ts`.
> 4. Verify `RNCallKeep.h` resolves in the Pods build; switch to
>    `<RNCallKeep/RNCallKeep.h>` if the quote import fails.
> 5. Install on the iPhone 15, set the worker `APNS_*` env vars, and run the
>    cold-killed incoming-call test: kill the app, place a call, confirm CallKit
>    rings from the native handler, answer, confirm SIP/WebRTC connects.
> 6. Document results in `docs/mobile-ios-phase6-first-build-report.md`.
