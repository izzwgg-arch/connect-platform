# Phase 7c — iOS Cold-Killed CallKit Answer → SIP/WebRTC Connect Sequencing

**Status: implemented, typechecked, unit-tested — NOT deployed (awaiting approval).**

Goal: a cold-killed iPhone that rings via CallKit (Phase 7b, working) must also
**connect** when answered, instead of "answers but doesn't connect." Root cause is a
cold-start sequencing/timing problem, not APNs. This phase fixes the diagnostics that
were hiding it and adds an **answer-deferral queue** so a CallKit answer that fires
before the app/SIP are ready is replayed once ready instead of being dropped.

Sources used: `docs/mobile-ios-phase7b-live-call-verification-report.md`,
`docs/mobile-ios-incoming-call-wake-architecture.md`, prior iOS phase docs.

---

## 1. Exact root cause

Two independent defects compounded on the cold-killed answer:

### 1a. Telemetry was being rejected (diagnosis blocker)
`POST /voice/diag/event` accepted `UI_SHOWN`/`PUSH_RECEIVED` at the **Zod** layer but
the **Prisma** enum `VoiceDiagEventType` didn't contain them → `db.voiceDiagEvent.create`
threw `PrismaClientValidationError` (**HTTP 500**) on every cold-start incoming call.
The remaining cold-start answer events the client emits (`CALLKEEP_*`, `INVITE_RESTORE*`,
`SIP_ANSWER_*`, `PBX_*`) weren't in the Zod enum at all → **400**. Net effect: the exact
telemetry needed to see where the cold-start answer breaks was being thrown away. (A
three-way drift: Prisma enum ⊂ Zod enum ⊂ client union.)

### 1b. The cold-start answer tap was dropped (the connect failure)
In `NotificationsContext.tsx`, the CallKeep `answerCall` handler resolved the invite via
`resolveInviteForAction(callId)` and, if it returned null after a single 100 ms retry,
called `endNativeCall(callId)` and **returned — discarding the answer**. On a cold-killed
launch the invite metadata is frequently not resolvable yet at the instant the user taps
Answer (in-memory state empty, auth token not hydrated, AsyncStorage/native-cache not yet
written by the VoIP listener). So the answer was silently dropped before the real answer
pipeline (`handleAcceptInvite`) ever ran.

> Note: `handleAcceptInvite` itself was already correct — it awaits SIP registration and
> performs the backend ACCEPT/claim → PBX re-INVITE requeue. The failure was *upstream*:
> the tap never reached it on cold start. (Server logs from the 7b cold-killed test showed
> `DEVICE_REGISTER_COMPLETE latencyMs≈7125` and a `respond` arriving, but the media leg
> never connected — consistent with the tap being dropped/raced rather than executed once
> SIP was ready.)

---

## 2. Files changed

| File | Change |
|------|--------|
| `packages/db/prisma/schema.prisma` | Added 21 values to `enum VoiceDiagEventType` (cold-start answer telemetry + `ANSWER_DEFERRED_*`). |
| `packages/db/prisma/migrations/20260622040000_voice_diag_event_types_cold_start_answer/migration.sql` | Additive `ALTER TYPE … ADD VALUE IF NOT EXISTS` for each new value (safe, idempotent, no data rewrite). |
| `apps/api/src/server.ts` | Extended the `/voice/diag/event` Zod enum to match Prisma (kept all three sources in sync; comment added). |
| `apps/api/src/voiceDiagEventTypes.test.ts` | **New** validation tests pinning Prisma ⊇ Zod ⊇ client union + required cold-start types present. |
| `apps/mobile/src/api/client.ts` | Added `ANSWER_DEFERRED_*` to the `postVoiceDiagEvent` type union. |
| `apps/mobile/src/context/NotificationsContext.tsx` | Added the answer-deferral queue (`pendingNativeAcceptRef`, `deferNativeAcceptUntilReady`), wired it into the CallKeep `onAnswer` drop point and the initial-events drain, extended `AnswerFlowEventType`, imported `MOBILE_SIP_ANSWER_MAX_WAIT_MS`. |

Android paths untouched. No UI changes. No APNs delivery changes.

---

## 3. Diagnostic fix

- **One source of truth, three layers reconciled:** Prisma enum, API Zod enum, and the
  mobile client union now all carry the same diag event vocabulary.
- New values: `PUSH_RECEIVED, UI_SHOWN, INCOMING_PUSH_RECEIVED, CALLKEEP_UI_SHOWN,
  CALLKEEP_ANSWER_TAPPED, APP_FOREGROUNDED_FROM_CALL, INVITE_RESTORED,
  INVITE_RESTORE_FAILED, SIP_ANSWER_REQUESTED, SIP_ANSWER_SENT, SIP_ANSWER_CONFIRMED,
  SIP_ANSWER_FAILED, PBX_CALL_ANSWERED, PBX_STILL_RINGING_AFTER_ANSWER,
  ANSWER_DESYNC_DETECTED, UI_SWITCHED_TO_CONNECTING, UI_SWITCHED_TO_ACTIVE`,
  plus the Phase 7c lifecycle `ANSWER_DEFERRED_AWAITING_SIP, ANSWER_DEFERRED_EXECUTED,
  ANSWER_DEFERRED_TIMEOUT, ANSWER_DEFERRED_STALE_CALL`.
- **Migration is additive only.** `ALTER TYPE ... ADD VALUE IF NOT EXISTS` — no rewrite,
  idempotent, matches the repo's existing enum-extension migrations. It will run via the
  standard `scripts/deploy-api.sh` path (which runs `prisma migrate deploy` only when
  `packages/db/prisma/**` changed — which it has).
- **Validation tests** (`apps/api/src/voiceDiagEventTypes.test.ts`, 3/3 passing) parse all
  three sources from disk and assert: every Zod type ∈ Prisma enum (no 500), every client
  type ∈ Zod (no 400) and ∈ Prisma (no 500), and the required cold-start types exist
  end-to-end. This prevents the drift from ever recurring.

---

## 4. Answer-deferral algorithm

Implemented as `deferNativeAcceptUntilReady(callId)` in `NotificationsContext.tsx`, invoked
**only** when the CallKeep `onAnswer` handler could not resolve the invite (i.e. the
foreground/warm path already returned an invite and is unaffected):

```
onAnswer(callId):
  invite = resolveInviteForAction(callId)         # memory → pending API → cache
  if !invite and token: wait 100ms; invite = resolveInviteForAction(callId)
  if invite:  handleAcceptInvite(invite, callId)   # UNCHANGED fast path (foreground/warm)
  else:       deferNativeAcceptUntilReady(callId)   # NEW cold-start path

deferNativeAcceptUntilReady(callId):
  if a loop is already running for callId: return         # dedupe (iOS redelivers answerCall)
  mark pendingNativeAcceptRef[callId] = {running:true}
  emit ANSWER_DEFERRED_AWAITING_SIP   (local + server diag)
  sip.register()                       # kick registration now (fire-and-forget)
  startedAt = now; deadline = startedAt + MOBILE_SIP_ANSWER_MAX_WAIT_MS (30s)
  loop while now < deadline:
    if suppressedIncomingInviteIdsRef has callId:        # canceled / answered elsewhere
        emit ANSWER_DEFERRED_STALE_CALL; endNativeCall(callId); return
    invite = resolveInviteForAction(callId)
    if invite: break
    sleep 300ms
  if !invite:                                            # timed out
    emit ANSWER_DEFERRED_TIMEOUT; endNativeCall(callId); return
  emit ANSWER_DEFERRED_EXECUTED
  safeSetInvite(invite)
  handleAcceptInvite(invite, callId)    # existing pipeline: awaits SIP register + claim/requeue
  finally: delete pendingNativeAcceptRef[callId]
```

Key properties:
- **No duplicate accepts.** Two guards: `pendingNativeAcceptRef` (one defer loop per callId)
  and `handleAcceptInvite`'s own `accept:<id>` in-flight/consumed guards.
- **SIP-readiness is respected without re-implementing it.** The deferral waits for the
  *invite* to resolve; `handleAcceptInvite` then performs the proven register-await +
  backend-claim + PBX-requeue. We start `sip.register()` early to shave latency.
- **Foreground untouched.** Deferral only triggers when the invite is unresolved after the
  existing two attempts, so warm/foreground answers keep the exact prior timing.

---

## 5. Timeout behavior

- Hard cap **`MOBILE_SIP_ANSWER_MAX_WAIT_MS` = 30 s** (reused from `mobileAnswerTiming.ts`),
  polling every **300 ms**.
- On timeout → emit `ANSWER_DEFERRED_TIMEOUT` (local console + server diag with
  `waitedMs`, `sipReg`), then `endNativeCall(callId)` so CallKit is cleared rather than
  left hanging.
- On the call going stale mid-wait (caller hung up / voicemail / answered on another device,
  surfaced via `suppressedIncomingInviteIdsRef`) → emit `ANSWER_DEFERRED_STALE_CALL`,
  `endNativeCall(callId)`, stop. (`suppressedIncomingInviteIdsRef` is also set by the VoIP
  listener when a push arrives for an already-suppressed callId.)

---

## 6. Instrumentation added/enabled

- **Now persisted server-side (previously 400/500):** `UI_SHOWN`, `PUSH_RECEIVED`,
  `INCOMING_PUSH_RECEIVED`, and the rest of the answer-flow vocabulary — so the existing
  client emitters stop erroring and land in `VoiceDiagEvent`.
- **New server-posted lifecycle:** `ANSWER_DEFERRED_AWAITING_SIP` (accept queued),
  `ANSWER_DEFERRED_EXECUTED` (accept executed), `ANSWER_DEFERRED_TIMEOUT`,
  `ANSWER_DEFERRED_STALE_CALL` — each with `callId`, `waitedMs`, `sipReg`.
- **Existing server milestones** already cover the rest of the chain: `PUSH_RECEIVED` →
  `INCOMING_INVITE` → (`ANSWER_DEFERRED_*`) → `ANSWER_TAPPED{ACCEPT}` → `CALL_CONNECTED`,
  plus `SIP_REGISTER`/`SIP_UNREGISTER` from the SIP-state effect.
- The fine-grained `CALLKEEP_ANSWER_TAPPED`/`INVITE_RESTORED`/`SIP_ANSWER_*` events remain
  **local-only** (console + in-process CALL_FLOW timeline) by design (high frequency); the
  server-visible milestone chain above is sufficient to localize a cold-start failure.

---

## 7. Test results

- `apps/api/src/voiceDiagEventTypes.test.ts` — **3/3 pass** (enum/Zod/client sync + required types).
- Mobile `tsc --noEmit`: **no new errors in touched files** (`NotificationsContext.tsx`,
  `client.ts`). Pre-existing baseline errors remain in untouched files — see §9.
- API `tsc -p tsconfig.json --noEmit`: my new test file is **clean**; remaining errors are
  pre-existing — see §9.
- Lint: no linter errors in any touched file.

---

## 8. Live test evidence

None yet — **not deployed / not built**, per "do not deploy until tested and approved."
The full cold-killed connect can only be validated on-device after (a) the API deploy
(migration + Zod) and (b) a fresh EAS iOS build carrying the mobile deferral. The test
matrix to run once approved:

- foreground answer still connects (no added latency)
- background answer connects
- locked-screen answer connects
- swiped-away / cold-killed answer **waits for SIP then connects** (this phase's target)
- caller hangs up before answer → `ANSWER_DEFERRED_STALE_CALL`, CallKit clears
- voicemail answers before the app connects → stale path, CallKit clears
- duplicate `answerCall` events → single accept (no double-accept)
- confirm server `VoiceDiagEvent` rows now persist (no 500), incl. `ANSWER_DEFERRED_*`

---

## 9. Pre-existing errors (documented separately — NOT introduced here)

Mobile `tsc` (all in files this phase did not touch):
- `src/context/CallSessionManager.tsx(920,23)` TS2367
- `src/context/SipContext.tsx(227,9)` TS2722; `(1790,39)` TS2345; `(1869,52)` TS2339; `(1870,61)` TS2551
- `src/sip/jssip.ts(265,7)` TS2322

API `tsc` (pre-existing):
- `src/server.ts(108,8)` TS2307 `@connect/shared/apnsVoipPush` — the documented Phase 7a
  `moduleResolution` artifact (runtime-resolved by tsx; same class as `webrtcBlackbox`,
  `webrtcIncidentAlerts`, `webrtcGlobalOutageAlerts`). `server.ts(692,51)`, `(5289,5)`
  pre-existing type issues unrelated to this change.
- `src/ops/storageMaintenance/*`, `src/voice/webrtcCallDiagnostics.ts`, and the
  `webrtc*` test files — pre-existing TS2307/`import.meta`/`any` issues.

My edits added **no** new tsc errors (the initial `import.meta` error in my new test was
removed by switching to a cwd-based repo-root walk).

---

## 10. Remaining blockers / risks

1. **Not yet validated live.** Needs API deploy + EAS iOS build + on-device cold-killed test.
2. **Deferral waits on invite resolution, which still depends on the PBX requeue.** If the
   PBX/`requeueLiveCallToDialplan` never lands a fresh INVITE after the backend ACCEPT
   within 30 s, the deferred answer will `ANSWER_DEFERRED_TIMEOUT`. The deferral guarantees
   the tap is no longer *dropped*, but end-to-end connect still requires the requeue to
   succeed (validate this in the live test; the now-working telemetry will show exactly
   where it stalls if it does).
3. **TURN reachability** (`turn_probe_failed` for `app.connectcomunications.com:5349`) — if
   cellular/NAT media needs relay, confirm TURN is healthy. Likely not the cold-start cause
   (foreground connects on the same network) but must be ruled out for rollout.
4. **Migration must ship via the API deploy path** (`prisma migrate deploy`), not by hand.

---

## 11. Next recommended prompt (Phase 7d)

```
Phase 7d: deploy the Phase 7c API diagnostics fix + build/test the cold-killed answer.

Use: docs/mobile-ios-phase7c-cold-killed-answer-connect-report.md

1. Deploy API only (blue/green, scripts/deploy-direct.sh api --branch main). Confirm the
   migration 20260622040000_voice_diag_event_types_cold_start_answer applied (prisma migrate
   deploy ran) and POST /voice/diag/event no longer 500s on UI_SHOWN.
2. Build a fresh EAS iOS dev-client (ios-dev-device profile) carrying the answer-deferral
   change; install on the iPhone 13 (ext 101).
3. Run the §8 test matrix, capturing server VoiceDiagEvent rows correlated by callId:
   PUSH_RECEIVED → INCOMING_INVITE → ANSWER_DEFERRED_AWAITING_SIP → ANSWER_DEFERRED_EXECUTED
   → ANSWER_TAPPED{ACCEPT} → CALL_CONNECTED. Capture on-device Metro/Xcode logs too.
4. If cold-killed still doesn't connect after the deferral, the telemetry now shows the exact
   stall (register? backend claim? PBX requeue/re-INVITE? CallKit audio session?). Fix that
   specific seam:
   - if the requeued INVITE never arrives → investigate requeueLiveCallToDialplan / AMI.
   - if INVITE arrives but no media → CallKit provider didActivateAudioSession + WebRTC ICE/TURN.
5. Confirm TURN (app.connectcomunications.com:5349) relay health for cellular.
6. Do not change Android. Update this report (or a 7d report) with the live cold-killed pass.
```
