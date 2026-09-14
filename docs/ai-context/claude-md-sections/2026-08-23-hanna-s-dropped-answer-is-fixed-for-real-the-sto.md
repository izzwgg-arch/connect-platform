# ⛔⛔ AGENT HANDOFF — Hanna's dropped answer is FIXED FOR REAL: the stop-ring was asking who answered one event too early (2026-08-23) — READ FIRST before touching `answeredByAnyParty`, `bridgeIds`, or anything that decides "somebody answered, stop ringing"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`9621f6ac` on `feat/ivr-migration-takeover`. **telephony DEPLOYED and
container-verified 2026-08-23 in a measured 0-active-calls window** — queue job
`bb6e347d`, `multiPartyBridgeAt` present in both files inside `app-telephony-1`, the
old `call.bridgeIds.length > 0` test greps **0**, 0 restarts, AMI + ARI reconnected,
**0 error-level lines**, PBX back to 145 registered contacts and processing calls.
No app build — this is server-side and reaches both platforms at once.)

- ⛔⛔ **THE FIX SHIPPED 2026-08-22 (`61c34205`) NEVER WORKED, AND THE REASON IS
  ORDERING, NOT A RACE.** It asks telephony WHICH endpoint answered so the api can
  spare the answering app — but the field was **always blank by the time it was
  read**. The decider was
  `call.extensionAnsweredAt != null || call.bridgeIds.length > 0`, and **`bridgeIds`
  is pushed at the TOP of `onBridgeEnter`, on EVERY BridgeEnter — including the first
  channel entering a bridge ALONE** (music-on-hold, parking, an announcement), which
  happens before anyone answers. So the one-shot `answered_elsewhere` stop-ring fired
  one `callUpsert` too early, with `extensionAnsweredChannel` still null.
- ⛔ **Live proof, pbxCallId `1787515311.13805` (Create A Box ext 102, 2026-08-23):**
  `20:02:00.973` telephony → api `answered_elsewhere`, `answeredEndpoint` **null** →
  `20:02:00.982` `extensionAnsweredChannel` recorded, **9 ms too late** → `20:02:01.344`
  api queues `INVITE_CANCELED` **at the phone that had just answered**.
- ✅ **THE FIX: `NormalizedCall.multiPartyBridgeAt`**, stamped ONLY inside the
  `bridgeNumChannels >= 2` branch — the same handler that resolves
  `extensionAnsweredChannel`, and **before its emit** — so any reader is guaranteed to
  see the answering endpoint. `MobilePushNotifier` tests that instead of `bridgeIds`.
- ⛔⛔ **DO NOT "FIX" THIS BY MAKING THE STOP-RING WAIT UNTIL IT KNOWS WHO ANSWERED.**
  In the follow-me / virtual-extension case the customer answers on their **CARRIER
  phone** and NO tenant extension leg ever answers — a wait would never resolve and the
  app would ring on after pickup (the 2026-07-29 complaint). **Both arms stay.**
- ⛔ **Traced before the edit, per the standing rule:** `bridgeIds` itself is unchanged
  so every other reader is untouched; `answeredByAnyParty` is local to that one block
  (2 references); desk answers still resolve to `T<t>_<ext>` with no device suffix and
  still cancel-push the apps; and the stop-ring can now only fire **LATER, never
  earlier**, so no ring can be cut off prematurely.
- ✅ **5 tests** in `multiPartyBridgeStopRing.test.ts` (picked up by the existing
  services glob). **Proven non-vacuous: 3 of 5 FAIL replayed against the pre-fix tree**
  via `TELEPHONY_GUARD_ROOT`. Telephony typecheck **41 = the exact baseline**, none in
  an edited file; suite 197/201 (the 4 failures are the documented pre-existing
  smarthome `JWT_SECRET` local-shell artifact).
- ⏳ **NOT PROVEN: no call has exercised it.** It is proven as deployed code and tests,
  never as a call that answered and stayed up. **Acceptance: one app answer that
  survives — no `INVITE_CANCELED` to the answering device, and the caller stays on.**
- ⛔ **The client-side half of Hanna's protection is UNCHANGED and still shipping** —
  `hasConfirmedSipSession()` + `answerInviteRef` guard both cancel branches; verified
  present inside the published APK's bundle. The 2026-08-23 answer-budget revert did
  NOT touch it.
