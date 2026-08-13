# Phase 7d — Live Answer→Connect Test Report (iOS)

**Date:** 2026-06-22
**Deployed API commit:** `eb4133e0` (`feat(mobile,api): defer iOS cold-start CallKit answer until SIP ready + fix diag enum`)
**Device:** iPhone 13, ext **101**, dev-client build `8cd8274e` (`ios-dev-device`), JS served live from Metro (LAN `192.168.5.104:8081`).
**Tester:** human (device actions) + agent (deploy, verification, log capture, analysis).

---

## TL;DR / Status

| Area | Result |
|------|--------|
| 1. Blue/green API deploy (`eb4133e0`) | ✅ PASS — `[deploy-api] done eb4133e0`, container commit verified, normalized to stable `:3001` |
| 2. Prisma migration applied safely | ✅ PASS — `20260622040000_voice_diag_event_types_cold_start_answer`, enum 16→37 values |
| 3. `/health` + `/ready` | ✅ PASS — both `200` |
| 4. `voiceDiagEvent` accepts new types | ✅ PASS — `UI_SHOWN`, `PUSH_RECEIVED`, all 4 `ANSWER_DEFERRED_*` accepted, **zero** 400/500 under live load |
| 5. Fresh EAS iOS dev-client | ✅ Reused `8cd8274e` (JS-only change → Metro serves Phase 7c; verified in bundle) |
| 6. Installed on iPhone | ✅ Already installed + connected to Metro |
| 7. Live answer matrix | ⚠️ MIXED — see below |
| 8. Capture proving connect path | ⚠️ Captured — **proves Phase 7c deferral never executed** + 3 new client-side defects |

**Bottom line:** The **backend half of Phase 7d is fully verified working** under real load (APNs VoIP 200, diag persistence fixed). The **cold-killed answer→connect is still broken**, and the live test surfaced that the **native CallKit answer action is not reaching the JS `onAnswer` handler** — which is *upstream* of the Phase 7c deferral, so the Phase 7c queue never ran. Three additional client-side defects were observed. **No production risk introduced** (API change is additive/verified; all open issues are mobile-client only). Recommend a focused **Phase 7e** (native CallKit answer/end bridging + foreground UI suppression + hangup teardown).

---

## Part A — Backend deploy & verification (steps 1–4) ✅

### Deploy
- Committed Phase 7c (7 files) as `eb4133e0`, pushed `origin/main` (`46982085..eb4133e0`).
- Preflight: queue idle (`runningCount:0`), server saw `eb4133e0`, dry-run reported checkout-safe (`dirty_path_count=10 target_changed_path_count=0` — no overlap).
- `bash scripts/deploy-direct.sh api --branch main` → blue/green rollout:
  - `api_candidate` `:3004` ready (16.3s) → nginx flip → stable `api` `:3001` recreated + ready (14.2s) → flip back → candidate drained/removed.
  - `verify: container commit eb4133e047c7 matches target`; `health=118ms`; `[deploy-api] done eb4133e0 requested_by=direct:root`.

### Migration
- `_prisma_migrations`: `20260622040000_voice_diag_event_types_cold_start_answer` → `finished_at` set (applied).
- `VoiceDiagEventType` enum count **16 → 37**.
- Direct enum cast check (the exact validation that previously 500'd) succeeds for `UI_SHOWN`, `PUSH_RECEIVED`, `ANSWER_DEFERRED_AWAITING_SIP`, `ANSWER_DEFERRED_EXECUTED`, `ANSWER_DEFERRED_TIMEOUT`, `ANSWER_DEFERRED_STALE_CALL`.

### Health & diag acceptance under live load
- `/health` = `200`, `/ready` = `200`.
- During the live test, the client posted `UI_SHOWN`, `INCOMING_INVITE`, `SIP_REGISTER`, `WS_CONNECTED`, `ANSWER_TAPPED`, `CALL_CONNECTED`, `CALL_ENDED`, `SESSION_START` — **all persisted, no `PrismaClientValidationError`, no 400/500** in `app-api-1` logs. The Phase 7b telemetry-blocking bug is fixed.

### APNs VoIP (live)
Every one of the 5 test calls logged the full healthy sequence in `app-api-1`:
```
api_apns_voip_token_selected → api_apns_voip_send_attempt → api_apns_voip_send_success status:200
```
voipPushTokenTail `72a02b`, no `BadDeviceToken` / `DeviceTokenNotForTopic` / `Unregistered`. (Evidence: `_latency_logs/_phase7d_api.txt`.)

---

## Part B — Build & install (steps 5–6) ✅

Phase 7c touched **only** `apps/mobile/src/api/client.ts` and `apps/mobile/src/context/NotificationsContext.tsx` — pure JS/TS, **zero** native deps / `package.json` / config-plugin / iOS-project changes. A dev-client build loads JS from Metro at runtime, so the existing native binary is identical. A fresh `ios-dev-device` build (`8cd8274e`, exit 0) from earlier the same day was already installed and attached to Metro, and the Metro iOS bundle was verified to contain the Phase 7c code (`deferNativeAcceptUntilReady`, `pendingNativeAcceptRef`, `ANSWER_DEFERRED_AWAITING_SIP`, `ANSWER_DEFERRED_STALE_CALL`). User chose to reuse + reload rather than rebuild a byte-identical native artifact.

---

## Part C — Live answer matrix (step 7) ⚠️

| # | Scenario | Ring (CallKit) | Answered via | Connect | Audio | Notes |
|---|----------|----------------|--------------|---------|-------|-------|
| 1 | Foreground #1 | ✅ (+ in-app screen) | Connect in-app "Answer" | ✅ `CALL_CONNECTED` | ❌ **none** | Two incoming screens shown (Connect + floating native CallKit). |
| 2 | Foreground #2 | ✅ | Native CallKit (floating) | ✅ | ✅ | Worked end-to-end. |
| 3 | Lock screen | ✅ | Native CallKit | ✅ | ✅ | **Hang-up from app did NOT tear down the call** — remote leg stayed up. |
| 4 | Cold-killed / swiped-away + locked | ✅ | (tapped answer) | ❌ **no connect** | ❌ | Rang ~15s then **DECLINE** sent (`decline_tapped` → SIP `Rejected`). |

---

## Part D — Log evidence (step 8)

### Diag-event timeline (server, UTC — `VoiceDiagEvent`)
```
05:22:50 INCOMING_INVITE → 05:22:51 UI_SHOWN → 05:22:57 ANSWER_TAPPED → 05:22:58 CALL_CONNECTED x2   (fg#1: connected, no audio)
05:23:35 INCOMING_INVITE → 05:23:36 UI_SHOWN → 05:23:38 ANSWER_TAPPED → 05:23:40 CALL_CONNECTED x2   (fg#2: audio OK)
05:24:03 INCOMING_INVITE → 05:24:04 UI_SHOWN → 05:24:05 ANSWER_TAPPED → 05:24:06 CALL_CONNECTED x2   (lock: audio OK, hangup stuck)
05:25:15 SESSION_START (cold boot) → 05:25:16 UI_SHOWN/SIP_REGISTER/WS_CONNECTED/INCOMING_INVITE
         → [rang 15s] → 05:25:30 ANSWER_TAPPED (action=DECLINE) → 05:25:30 CALL_ENDED                (cold-killed: no connect)
```

### What the capture PROVES
- ✅ **Diagnostics fix works** — `UI_SHOWN` and friends persist with no error.
- ✅ **APNs path works** — 5/5 pushes `status:200`.
- ❌ **`[CALLKEEP_ANSWER] native onAnswer fired` appears ZERO times** across the entire Metro log — the native CallKit *answer* action never reached `subscribeNativeCallActions.onAnswer`.
- ❌ **`ANSWER_DEFERRED_AWAITING_SIP` / `_EXECUTED` / `_TIMEOUT` / `_STALE_CALL` appear ZERO times** — the Phase 7c deferral queue never executed in any scenario.
- ❌ Cold-killed call timeline ends with `RINGTONE_STOPPED reason=decline_tapped` → `respondInvite DECLINE` → `[CALL_EVENT] session_failed Call failed: Rejected`, and the latency timeline reports `MISSING: ANSWER_TAPPED, NATIVE_ANSWER_TRIGGERED, SESSION_ACCEPT_START, …`.

(Evidence files: Metro terminal `336195.txt` lines 1592–1752 for the cold cycle; `_latency_logs/_phase7d_api.txt`.)

---

## Root-cause analysis

### R1 — Native CallKit *answer* action is not reaching JS `onAnswer` (PRIMARY blocker)
`onAnswer` logs `[CALLKEEP_ANSWER] native onAnswer fired …` on its very first line (`NotificationsContext.tsx:4047`). That line is absent for **every** call, including the lock-screen call that *did* connect. Implication: the calls that connected were accepted through the **in-app Connect IncomingCall screen** (its own Answer button → `handleAcceptInvite`), not through the CallKit→`onAnswer` bridge. On the cold-killed/locked call there is no in-app surface reachable, so the only actionable control is CallKit — and its answer action did not arrive as an `answer` event; an end/decline arrived instead.
**Because Phase 7c's `deferNativeAcceptUntilReady` is invoked only from inside `onAnswer` and the cold-start `consumeInitialCallKeepEvents` "answer" branch, it can never run while the upstream answer event is missing.** Phase 7c is necessary but not sufficient; the native CallKit provider's `performAnswerCallAction` → RN bridge delivery must be fixed first.

### R2 — Cold-killed answer is delivered/handled as DECLINE
The cold cycle sent `respondInvite("DECLINE")` + `sip.rejectIncomingInvite()` (`decline_tapped`), so the PBX leg was rejected. Either the native answer action is mis-mapped to `endCall` on cold start, or a timeout/teardown fired `handleDeclineInvite` (`NotificationsContext.tsx:3783–3807`) before any accept. Needs native-side CallKit action logging to disambiguate (see Phase 7e).

### R3 — Double incoming UI (in-app screen + native CallKit) in foreground/background
The VoIP-push `onIncoming` calls `showIncomingNativeCall(...)` (`:4031`) **and** the app navigates to its own IncomingCall screen (`INCOMING_CALL_SCREEN_MOUNT`). With both surfaces up, answering the in-app one connects SIP while CallKit still owns/expects the audio session → the **no-audio** result in fg#1. On iOS the CallKit surface should be the single source of truth for push-driven calls; the in-app incoming screen should be suppressed when a CallKit call is active.

### R4 — In-app hang-up does not tear down the PBX leg (lock scenario)
After a CallKit-answered call, hanging up inside the app did not propagate BYE / CallKit `endCall` to the remote leg. Likely the in-app call session isn't bound to the CallKit/SIP session that actually carried the answered call, so the local hangup acts on a different (or no) session.

---

## Phase 7c verdict
The Phase 7c code (diag enum reconciliation + `deferNativeAcceptUntilReady`) is **correct and the diag half is verified in production**. The deferral half is **unproven** because the test never reached it — the native answer event is missing upstream. No regression to the working foreground/lock connect was observed that is attributable to Phase 7c.

## Remaining blockers (before cold-killed answer can connect)
1. **R1/R2 (native):** CallKit `performAnswerCallAction` must reliably deliver an `answer` event to RN (live + cold-start replay), and must not be coerced into decline/end. Add native (Swift/ObjC) CallKit provider logging.
2. **R3 (JS):** Suppress the in-app IncomingCall screen when a CallKit call is active for the same `callId` (single answer surface) → fixes fg#1 no-audio.
3. **R4 (JS/native):** Bind the in-app hang-up to the CallKit/SIP session so BYE + CallKit `endCall` propagate.

## Rules compliance
- Android untouched. APNs unchanged (already correct from 7a/7b). No broad refactor performed. API deploy was additive + fully verified; **no production risk** — stopped at analysis rather than attempting risky native changes without approval.

## Recommended next prompt (Phase 7e)
> Phase 7e: Fix iOS native CallKit answer/end bridging so a CallKit *answer* reliably reaches JS `onAnswer` (live + cold-start), then verify Phase 7c deferral actually runs on a cold-killed answer. Also: (a) suppress the in-app IncomingCall screen whenever a CallKit call is active for the same callId (fix foreground no-audio / double UI); (b) bind in-app hang-up to the CallKit/SIP session so BYE + CallKit endCall propagate to the PBX leg. Add native CallKit provider logging (performAnswerCallAction / performEndCallAction) and re-run the 4-scenario matrix. Do not touch Android, do not change APNs, do not broad-refactor.
