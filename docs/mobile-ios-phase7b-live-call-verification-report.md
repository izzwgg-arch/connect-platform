# Phase 7b — Deploy API APNs VoIP Live-Path + Live iPhone Call Verification

**Status: ✅ Primary goal achieved** — a locked / backgrounded / **cold-killed** iPhone
now receives a **native CallKit incoming call**, driven by an `apns-push-type: voip`
push sent from the live API CallInvite path.

**Remaining blocker (not in 7b scope):** on a **cold-killed** answer the call does not
yet complete the SIP/WebRTC media leg ("answers but doesn't connect"). Foreground
answer connects. This is the next phase (7c).

Date: 2026-06-22 (UTC-4) · Verified against tenant **Landau Home**, extension **101**,
device **iPhone 13 / iOS 18.7.8**.

---

## 1. Deployed commit / hash

Two API deploys were made (both blue/green, API only):

| # | Commit | Why |
|---|--------|-----|
| 1 | `4bb15afa34c594435a2887624d2f786e8b88fd95` | Phase 7a code: send APNs VoIP push from the live API `INCOMING_CALL` path (`sendApnsVoipPushesForIncomingCallApi`). |
| 2 | `4698208537b7417e4eadaee4bfa2c30cf68c2bb8` | Fix: only null a VoIP token on `410 Unregistered`, **not** on `BadDeviceToken`/`DeviceTokenNotForTopic` (those are env/topic config errors, not dead tokens). |

Final running container commit (verified inside `app-api-1`): **`4698208537b7…`**.

---

## 2. Environment configured on the API (no secrets)

The API service (`docker-compose.app.yml` → `api`) already loads
`/opt/connectcomms/env/.env.platform` (same `env_file` as the worker), so **no compose
change was needed** — the redeploy recreated `app-api-1` and it picked up the existing
APNS_* values. The API container previously had **0** APNS_ vars (never recreated since
they were added for the worker); it now has **6**.

| Var | Value (non-secret) |
|-----|--------------------|
| `APNS_TEAM_ID` | `PR63R6J84J` |
| `APNS_KEY_ID` | `DPPVWTA5YY` |
| `APNS_BUNDLE_ID` | `com.connectcommunications.mobile` |
| `APNS_VOIP_TOPIC` | `com.connectcommunications.mobile.voip` ✅ **double-`m`** |
| `APNS_AUTH_KEY_BASE64` | present (base64 .p8, len 345; not printed) |
| `APNS_PRODUCTION` | **`true`** ← changed from `false` during 7b (see §6) |

> **Topic spelling verified double-`m`:** `com.connectcommunications.mobile.voip`
> (the app bundle), NOT the single-`m` web domain `connectcomunications.com`. A wrong
> topic would have returned APNs `DeviceTokenNotForTopic`; we never saw that.

> **Worker is not sufficient:** the live inbound-call push is created by the **API**
> (`server.ts` → `sendPushToUserDevices`, `INCOMING_CALL`). The worker's PBX-poll VoIP
> sender is preempted by the API-created `PENDING` invite, so the API container **must**
> carry APNS_* too. Confirmed: API now has all 6.

---

## 3. Exact deploy commands

Preflight + both deploys ran on the app host (`/opt/connectcomms/app`), blue/green,
API only:

```bash
# preflight
curl -s http://127.0.0.1:3910/ops/deploy/status        # runningCount:0
git -C /opt/connectcomms/app fetch origin main && git log --oneline -1 origin/main

# dry-run (deploy #1)
bash scripts/deploy-direct.sh api --branch main --dry-run

# real deploys
bash scripts/deploy-direct.sh api --branch main        # → 4bb15afa
bash scripts/deploy-direct.sh api --branch main        # → 46982085 (after the token-invalidation fix + APNS_PRODUCTION=true)
```

`APNS_PRODUCTION` flip (with backup):

```bash
cp /opt/connectcomms/env/.env.platform /opt/connectcomms/env/.env.platform.bak.phase7b.<ts>
sed -i 's/^APNS_PRODUCTION=false/APNS_PRODUCTION=true/' /opt/connectcomms/env/.env.platform
```

Both deploys used `DEPLOY_API_BLUEGREEN=1`: `api_candidate` on `:3004` → `/ready` →
nginx flip → recreate stable `api` on `:3001` → `/ready` → flip back → remove candidate.
No Prisma migrations ran (no `packages/db/prisma/**` change).

---

## 4. API boot verification

Post-deploy checks against the running `app-api-1`:

- `verify: container commit 4698208537b7 matches target` (from the deploy log).
- New symbol present in container: `grep -c sendApnsVoipPushesForIncomingCallApi /app/apps/api/src/server.ts` → **2** (definition + call site).
- Token-invalidation fix present: `const APNS_INVALID_TOKEN_REASONS = new Set(["Unregistered"]);`.
- `printenv APNS_PRODUCTION` inside container → **`true`**; APNS_ env count → **6**.
- `/health` → **200**, `/ready` → **200**.
- No APNs/boot errors at startup. (One unrelated pre-existing warning: `turn_probe_failed`
  for `app.connectcomunications.com:5349` — TURN reachability, not APNs. See §10.)

---

## 5. Live call log evidence (APNs result)

Two live inbound calls to ext 101, both **accepted by APNs with HTTP 200**:

```text
api_apns_voip_token_selected  callId=cmqoptq7o… voipPushTokenTail=72a02b   (foreground)
api_apns_voip_send_attempt    callId=cmqoptq7o…
api_apns_voip_send_success    callId=cmqoptq7o… status=200 apnsId=4135A814-C79C-6CCC-0CAB-21072201C11D

api_apns_voip_token_selected  callId=cmqopv2kx… voipPushTokenTail=72a02b   (cold-killed)
api_apns_voip_send_attempt    callId=cmqopv2kx…
api_apns_voip_send_success    callId=cmqopv2kx… status=200 apnsId=AE7BA268-55A0-F8A5-F759-49078F5996F9
```

No `BadDeviceToken`, no `DeviceTokenNotForTopic`, no `Unregistered` after the
`APNS_PRODUCTION=true` correction. (Server snapshot: `/tmp/_phase7b_api.log` on app host.)

---

## 6. The one real failure found & fixed during 7b — sandbox/production mismatch

**First attempt failed**: with `APNS_PRODUCTION=false` (sandbox host), the very first
live call produced:

```text
api_apns_voip_send_failure  status=400 reason=BadDeviceToken tokenInvalid=true
api_apns_voip_token_invalidation_candidate  action=null_voip_push_token
```

Root cause = **sandbox/production mismatch**. The iPhone build uses eas.json
`distribution: "internal"` (ad-hoc), which embeds `aps-environment: production`, so its
PushKit VoIP token is a **production** token. Sending it to the **sandbox** APNs host
returns `400 BadDeviceToken`. The topic was correct (else it would be
`DeviceTokenNotForTopic`) and the token was well-formed (64 hex) — both rule out
token/topic problems.

Two fixes applied:
1. **`APNS_PRODUCTION=true`** (production host `api.push.apple.com`) → matches the build
   entitlement. Subsequent sends returned **200**.
2. **Stop nulling the token on `BadDeviceToken`** (commit `46982085`). The original
   shared set treated `BadDeviceToken`/`DeviceTokenNotForTopic` as "dead token" and
   nulled it; those are recoverable **config** errors. Narrowed to `Unregistered`/410
   only. (The first failure had already nulled the token; the device re-registered the
   same token on the next **cold** launch.)

> Note: a warm app foreground does **not** re-register the VoIP token; only a **cold
> launch** triggers PushKit `didUpdatePushCredentials` → `/mobile/devices/register`.

---

## 7. iPhone behavior (ring)

| App state | Native CallKit incoming call shown? |
|-----------|-------------------------------------|
| Foreground | ✅ Yes |
| **Swiped away / cold-killed** | ✅ **Yes** (PushKit woke the app, CallKit presented) |

This is the core Phase 7b acceptance criterion and it **passes**.

---

## 8. Answer / connect result

| App state | Answer → media connect |
|-----------|------------------------|
| Foreground | ✅ Connects |
| **Cold-killed** | ❌ **Answers but does not connect** (no media) |

Server-side trace of the cold-killed answer (`callId=cmqopv2kx…`):

1. VoIP push 200 → CallKit shown.
2. App cold-boots: `/mobile/call-invites/active`, `/mobile/devices/register`
   → `DEVICE_REGISTERED`, `/voice/diag/session/start`.
3. `DEVICE_REGISTER_COMPLETE source=ring_predeliver **latencyMs=7125**` →
   `mobile-invite: telephony requeue sent` (backend re-bridged after the ~7s cold boot).
4. App polls `/mobile/call-invites/{id}/answer-status` for ~8s, then
   `POST /mobile/call-invites/{id}/respond` (answer).
5. Media (SIP/WebRTC) does not establish.

Contributing signals:
- **~7.1s cold-boot register latency** — the JS/SIP stack isn't registered when the
  CallKit answer fires; by the time `/respond` lands the media path isn't ready.
- `SIP_UNREGISTER code=UNKNOWN` observed in the cold window.
- **API bug (diagnostics):** `POST /voice/diag/session/start`-driven
  `db.voiceDiagEvent.create({ type: "UI_SHOWN" })` throws
  `PrismaClientValidationError` (HTTP **500**) — `UI_SHOWN` is **not** in the
  `VoiceDiagEventType` enum. This is non-fatal to the call but it **destroys exactly the
  telemetry needed to debug the connect step**. Should be fixed first in 7c.

This matches the prompt's anticipated branch: *"CallKit displayed but JS/SIP failed
after answer."* It is a **mobile cold-start SIP/WebRTC sequencing** problem, separate
from the APNs/API deploy that Phase 7b delivered.

---

## 9. Hangup / cleanup result

Not formally exercised this round because the cold-killed call never reached connected
media. CallKit dismissed when the call ended/was canceled (the `INVITE_CANCELED` Expo
fan-out and `/respond` were observed). Full hangup-cleanup verification is folded into
7c once the cold-killed call actually connects.

---

## 10. Remaining blockers

1. **Cold-killed post-answer connect (primary).** CallKit answers, but SIP/WebRTC media
   doesn't establish. Suspected: ~7s cold-boot delays SIP registration; CallKit
   `didActivateAudioSession`/JS `answer()` bridging and the post-register re-bridge race.
   Needs device-side logs (Metro/Xcode/Console) — server logs alone can't see the media leg.
2. **`VoiceDiagEventType` missing `UI_SHOWN` → 500 on every cold-start incoming call.**
   Additive Prisma enum fix; restores the diagnostic telemetry for blocker #1.
3. **TURN reachability:** `turn_probe_failed` for `app.connectcomunications.com:5349`
   (ECONNREFUSED). Likely **not** the cold-killed cause (foreground connects on the same
   network), but confirm TURN relay is healthy for cellular/NAT before broad rollout.
4. **`APNS_PRODUCTION=true` is now global** (shared `.env.platform`). Correct for the
   current ad-hoc/TestFlight builds; **a true `development` build (Xcode/dev provisioning)
   would mint sandbox tokens and then fail with `BadDeviceToken`.** If both build types
   must coexist, per-device environment selection is needed (future).

---

## 11. Next recommended prompt (Phase 7c)

```
Begin Phase 7c: fix iOS cold-killed post-answer SIP/WebRTC connect.

Context:
- Phase 7b is deployed and verified: a cold-killed iPhone now receives native CallKit
  via APNs VoIP push (api_apns_voip_send_success status 200). See
  docs/mobile-ios-phase7b-live-call-verification-report.md.
- Remaining failure: on a cold-killed answer the call connects to CallKit but the
  SIP/WebRTC media leg never establishes ("answers but doesn't connect"). Foreground
  answer connects fine.

Tasks:
1. FIRST fix the telemetry bug blocking diagnosis: add "UI_SHOWN" (and audit the mobile
   client's full set of voice-diag event types) to the VoiceDiagEventType Prisma enum so
   POST /voice/diag/session events stop 500-ing. Additive migration, API deploy only.
2. Instrument and capture the cold-start answer sequence on-device (Metro + Xcode/Console
   logs) for callId-correlated events: PushKit didUpdatePushCredentials → CallKit
   reportNewIncomingCall → user answer → JS boot → SIP register → INVITE/answer →
   CallKit provider didActivateAudioSession → WebRTC ICE/DTLS → media.
3. Identify where the cold-killed flow diverges from the (working) foreground flow:
   - Is SIP registered before CallKit answer fires? (DEVICE_REGISTER_COMPLETE latencyMs≈7s)
   - Is the CallKit answer action bridged to the JS SIP answer()?
   - Is the AVAudioSession activated via provider:didActivateAudioSession before media?
   - Does the PBX still have the leg when the app finally answers (telephony requeue race)?
4. Verify TURN (app.connectcomunications.com:5349) is reachable for relay candidates on
   cellular/NAT; fix or document if media requires TURN.
5. Re-test cold-killed: ring → answer → two-way audio → hangup → CallKit clears.
6. Do not change Android. Update docs/mobile-ios-phase5-cold-killed-callkit-report.md (or
   a new phase7c report) with the fix and a clean cold-killed pass.
```

---

## Appendix — environment correctness summary

| Check | Result |
|-------|--------|
| Topic double-`m` (`…mobile.voip`) | ✅ |
| API container loads `.env.platform` | ✅ (already in compose) |
| API has all 6 APNS_ vars | ✅ |
| Build entitlement vs host | ad-hoc → `production` → `APNS_PRODUCTION=true` ✅ |
| APNs accepts VoIP push | ✅ HTTP 200 ×2 |
| Cold-killed CallKit ring | ✅ |
| Cold-killed answer → media | ❌ (Phase 7c) |
| Android regression | none (path is `payload.type === "INCOMING_CALL"` iOS-token-gated) |
