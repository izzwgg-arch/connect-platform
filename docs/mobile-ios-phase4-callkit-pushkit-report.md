# Connect Mobile — iOS Phase 4: PushKit + CallKit Wiring Report

> **Date:** 2026-06-21
> **Scope:** Mobile-side wiring so an APNs VoIP push reports the incoming call to
> CallKit immediately, and SIP/WebRTC connects **only after the user taps Answer**.
> **Source of truth:** [`mobile-ios-current-state.md`](./mobile-ios-current-state.md),
> [`mobile-ios-production-plan.md`](./mobile-ios-production-plan.md),
> [`mobile-ios-phase1-implementation-report.md`](./mobile-ios-phase1-implementation-report.md).
> **Constraints honored:** focused mobile-only changes; no UI redesign; no Android
> rewrite; no EAS build; no native iOS project generation; no deploy; Android preserved.

---

## 1. Files Changed

| File | Change |
|------|--------|
| `apps/mobile/src/sip/callkeep.ts` | Added iOS **callId ↔ CallKit UUID** bidirectional map + non-crypto v4 UUID gen; **dedupe** set; `showIncomingNativeCall` now reports with a valid UUID and is idempotent; `endNativeCall` ends the mapped UUID + clears dedupe/mapping; `subscribeNativeCallActions` translates the CallKit UUID back to `callId` at the boundary. |
| `apps/mobile/src/context/NotificationsContext.tsx` | Implemented the iOS VoIP `onIncoming` handler (report to CallKit + persist invite, **no SIP connect**); added an iOS-only `endNativeCall` in the `sip.callState === "idle"` cleanup effect. |
| `apps/mobile/src/sip/voipPush.ts` | Expanded `VoipPushIncomingPayload` typing to document the backend VoIP payload fields (`callId`, `tenantId`, `toExtension`, `timestamp`). |
| `docs/mobile-ios-phase4-callkit-pushkit-report.md` | **new** — this report. |
| `docs/mobile-ios-production-plan.md`, `docs/mobile-ios-current-state.md` | Status updates. |

No Android native modules, no `telecom.ts`, no worker/backend code, and no other
files were touched.

---

## 2. Exact Call Flow Implemented

**Incoming (closed/background iPhone):**
```
APNs VoIP push  ──▶  react-native-voip-push-notification "notification" event
                     └▶ initVoipPushListener.onIncoming  (src/sip/voipPush.ts, iOS-only)
                          │  payload: { callId, tenantId, toExtension, callerNumber, callerName, timestamp }
                          ├─ build CallInvite via payloadToInvite(...)  (maps callerNumber→fromNumber, callerName→fromDisplay)
                          ├─ if callId suppressed → endNativeCall(callId); return
                          ├─ showIncomingNativeCall(callId, displayName)   ← REPORT TO CALLKIT FIRST (deduped)
                          └─ safeSetInvite(invite)                          ← persist pending state (NO SIP yet)
```

**Answer (user taps Answer in CallKit):**
```
CallKit answerCall  ──▶  subscribeNativeCallActions (callkeep.ts)
                          └▶ translate UUID → callId (callIdForCallKitUuid)
                               └▶ onAnswer(callId)  →  resolveInviteForAction(callId)
                                    └▶ handleAcceptInvite(invite, callId)  ← SIP/WebRTC CONNECTS HERE
```

**Decline / End (user taps Decline, or CallKit ends):**
```
CallKit endCall  ──▶  subscribeNativeCallActions → translate UUID → callId
                       └▶ onEnd(callId)  →  resolveInviteForAction → handleDeclineInvite(invite, callId)  (SIP reject/BYE via existing path)
```

**Caller cancels before answer (INVITE_CANCELED):**
```
Expo/FCM data push type=INVITE_CANCELED  ──▶  foreground listener (existing)
   └▶ suppressedIncomingInviteIdsRef.add(callId)
   └▶ endNativeCall(callId)   ← CallKit UI dismissed (now ends the mapped UUID on iOS)
```

**SIP/PBX ends (remote hangup / local hangup / voicemail rollover):**
```
sip.callState → "idle"  ──▶  cleanup effect
   ├─ terminateTelecomCall(lingerId)   (Android-only, unchanged)
   └─ if iOS: endNativeCall(lingerId)  ← ends the CallKit call so the iPhone stops showing it
```

**Key invariant:** SIP/WebRTC is **never** connected on push receipt — only inside
`handleAcceptInvite`, which is reached exclusively via the CallKit `answerCall` event
(or the in-app Answer button). This is the same pipeline Android already uses.

---

## 3. How callId Maps to a CallKit UUID

- The backend identifies a call by `callId`/`inviteId` — a **cuid** (e.g. `clx…`),
  which is **not** a valid RFC-4122 UUID. iOS CallKit requires a real UUID
  (`[[NSUUID alloc] initWithUUIDString:]` returns `nil` otherwise and the report
  silently fails).
- `callkeep.ts` keeps a **bidirectional in-process map**:
  - `callKitUuidForCallId(callId)` → lazily generates a v4 UUID, stores both directions, reuses it for the same `callId`.
  - `callIdForCallKitUuid(uuid)` → reverse lookup.
- `showIncomingNativeCall` reports to CallKit with the **UUID** (iOS); `answerCall`/
  `endCall` events carry that UUID, which is translated **back to `callId`** before
  reaching `resolveInviteForAction`/`handleAcceptInvite`/`handleDeclineInvite`. So all
  downstream logic continues to use the original `callId` unchanged.
- **Stability:** the same JS runtime that reports the call also handles the answer
  (iOS boots JS for the VoIP push and keeps it alive through CallKit interaction), so
  the in-memory map is sufficient. The map is cleared on `endNativeCall`.
- **Android:** the map is never populated (`showIncomingNativeCall` runs on iOS only),
  so every lookup falls through to the raw `callId` — identical to prior behavior.

---

## 4. How Answer / Decline / End Are Handled (reuse, not duplication)

- **Answer:** `subscribeNativeCallActions.onAnswer` → `resolveInviteForAction(callId)`
  → `handleAcceptInvite(invite, callId)`. This is the **existing** shared accept
  pipeline (same one the Android Telecom bridge and the in-app Answer button call). No
  new SIP logic was added.
- **Decline/End:** `onEnd` → `handleDeclineInvite(invite, callId)` — existing reject/BYE
  path. Notification of the PBX happens through that existing call-control path only.
- **End on SIP/PBX termination:** existing `endNativeCall(...)` calls (cancel bridge,
  expire timer, decline, error paths) now also end the iOS CallKit call via the UUID
  map; plus the new iOS-only `endNativeCall` on `sip.callState === "idle"` covers the
  answered-call remote-hangup / voicemail-rollover case.
- **Pending state cleared safely:** `safeSetInvite(null)` + the existing
  `sip.callState === "idle"` effect already reset `shownInviteIdRef`, suppressed-id
  set, and in-flight refs; `endNativeCall` clears the dedupe set and UUID mapping.

---

## 5. Dedupe Behavior

iOS may receive **both** an Expo push and a VoIP push for the same call. Dedupe is
enforced at two layers, both keyed by `callId`:

1. **CallKit report dedupe (`callkeep.ts`):** `reportedIncomingCallIds` Set — the first
   `showIncomingNativeCall(callId,…)` reports to CallKit; any subsequent call for the
   same `callId` is ignored until `endNativeCall` clears it. Prevents duplicate CallKit
   calls / double incoming UI from duplicate or repeated pushes.
2. **Invite-state dedupe (`safeSetInvite`):** existing `shownInviteIdRef.current === invite.id`
   guard ignores re-setting the same invite, and `suppressedIncomingInviteIdsRef`
   blocks resurrecting a canceled/answered-elsewhere call.

Net effect: exactly one visible incoming call UI per `callId`, regardless of how many
push transports deliver it.

---

## 6. Android Regression Protection

- **UUID maps stay empty on Android** — `showIncomingNativeCall` (the only populator)
  is invoked only under `Platform.OS !== "android"` guards in the push paths. Every
  `callIdToCallKitUuid.get(...) ?? callId` and `callIdForCallKitUuid(...) ?? callUUID`
  therefore returns the **raw callId** on Android, exactly as before.
- **`endNativeCall` on Android** still calls `dismissNativeIncomingUi` (Android native
  dismiss) + `RNCallKeep.endCall(callId)` with the unchanged value.
- **New code is iOS-gated:** the `onIncoming` handler runs only on iOS (the VoIP
  listener early-returns on Android), and the new `sip.callState === "idle"`
  `endNativeCall` is wrapped in `Platform.OS === "ios"`.
- **No changes** to `telecom.ts`, `ConnectionService`, FCM services, keep-alive, or any
  Android native module. The Android killed-app wake → custom Telecom UI flow is untouched.
- **Verified:** 42/42 existing mobile unit tests pass (notification routing, call
  origin, caller identity).

---

## 7. Commands Run + Results

| Command | Result |
|---------|--------|
| ReadLints on `callkeep.ts`, `voipPush.ts`, `NotificationsContext.tsx` | ✅ No linter errors |
| `pnpm --filter @connect/mobile typecheck` | ⚠️ Fails only on **pre-existing** errors in untouched files (`CallSessionManager.tsx:920`, `SipContext.tsx:227/1790/1869/1870`, `jssip.ts:251`). **Identical set to the committed baseline** `_latency_logs/_tsc_mobile_gate2.txt`. **None reference the 3 edited files.** |
| `npx tsx --test notificationRouting.test.ts callOrigin.test.ts callerIdentity.test.ts` | ✅ **42/42 pass** |

No EAS build, no native generation, no deploy was run (out of scope).

> **Pre-existing typecheck note:** the baseline log shows the same 6 errors in the same
> files/codes (line numbers differ only because unrelated working-tree edits shifted
> them). My changes add **zero** new type errors.

---

## 8. Remaining Blockers Before First iPhone Build/Test

1. **Native cold-killed CallKit report (most important).** For a **fully terminated**
   app, iOS requires `reportNewIncomingCall` to be invoked in the AppDelegate's
   `didReceiveIncomingPushWithPayload` **before** the completion handler returns, or iOS
   may terminate/ban the app. The current JS `onIncoming` handles foreground + warm
   background reliably and is the correct JS reconciliation, but the **native report**
   must be added to `plugins/withIosVoipPush.js` (calling `RNCallKeep`/`reportNewIncomingCall`
   with a UUID the JS side can reconcile). This was intentionally deferred because it
   patches the native AppDelegate, whose **language (Obj-C++ vs Swift) is unknown until
   the first prebuild** and cannot be verified without an iOS build. **Do this during
   Phase 0's first `ios-dev-device` build.**
2. **Apple credentials + first EAS iOS build** (Phase 0) — none of this is testable
   without a signed dev build on the iPhone 15.
3. **APNs sandbox vs production** must match the build's `aps-environment`
   (`APNS_PRODUCTION` env on the worker, Phase 1).
4. **`setCurrentCallActive` on answer (polish).** Consider calling
   `RNCallKeep.setCurrentCallActive(uuid)` once SIP media is up so CallKit shows the
   active-call timer; not required for basic answer/connect.
5. **Background INVITE_CANCELED on iOS.** Cancel currently dismisses CallKit when JS is
   alive (foreground/warm). True cold-killed cancel handling depends on the same native
   path as (1) and the worker emitting a call-only cancel signal.

---

## 9. Status / Risks / Next Prompt

### Status
- ✅ **JS-side PushKit→CallKit wiring complete:** VoIP push reports to CallKit; answer
  connects SIP/WebRTC via the existing pipeline; decline/end/cancel end CallKit; dedupe
  across Expo+VoIP; iOS-only; Android preserved (42/42 tests pass).
- 🔸 **Not yet runnable end-to-end** — needs Apple creds, the first EAS build, and the
  native cold-killed report (blocker #1).

### Risks
- **Cold-killed reporting race** until the native AppDelegate report is added (blocker #1)
  — Apple may throttle/terminate if a VoIP push arrives with no prompt CallKit report.
- **AppDelegate language** may be Swift → `withIosVoipPush.js` needs a Swift port for
  both the existing PushKit wiring and the new native report.
- **UUID map is in-memory** — correct for the report→answer flow in one runtime; a future
  native pre-report must share/reconcile the UUID with JS.
- **Double delivery (Expo+VoIP)** is handled by dedupe, but relies on both arriving with
  the same `callId` (they do — worker uses `inviteId` as `callId`).

### Next recommended Cursor prompt
> "Harden iOS cold-killed CallKit reporting. After the first `ios-dev-device` EAS build,
> confirm the generated AppDelegate language. Update `apps/mobile/plugins/withIosVoipPush.js`
> so `didReceiveIncomingPushWithPayload` natively calls react-native-callkeep's
> `reportNewIncomingCall` with a UUID derived from the push `callId` BEFORE invoking the
> completion handler, and ensure the JS `callKitUuidForCallId` mapping reconciles with
> that native UUID (e.g. derive a deterministic UUID from `callId` on both sides). Add a
> call-only background INVITE_CANCELED path that ends the CallKit call. Keep changes
> iOS-only; do not regress Android; typecheck only — no EAS build or deploy in the same step."

---

*End of Phase 4 report. No EAS builds, native iOS generation, package installs, or
deploys were performed. Android behavior preserved; 42/42 mobile unit tests pass.*
