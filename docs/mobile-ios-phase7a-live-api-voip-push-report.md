# Phase 7a — Fix Live iOS Inbound-Call VoIP Push Path

> **Date:** 2026-06-21
> **Scope:** Make **normal live inbound calls** send an APNs VoIP push from the
> **actual API-created `CallInvite` path**, not only from the worker's PBX-poll
> fallback. iOS only. **No deploy performed.** Android untouched.
> **Source of truth:** [`mobile-ios-incoming-call-wake-architecture.md`](./mobile-ios-incoming-call-wake-architecture.md),
> [`mobile-ios-phase1-implementation-report.md`](./mobile-ios-phase1-implementation-report.md),
> [`mobile-ios-phase4-callkit-pushkit-report.md`](./mobile-ios-phase4-callkit-pushkit-report.md),
> [`mobile-ios-phase5-cold-killed-callkit-report.md`](./mobile-ios-phase5-cold-killed-callkit-report.md).

---

## 1. The exact live path that was broken — and is now fixed

**Root cause (confirmed in code + on-device test).** A real inbound call is handled
in **real time by the API**, not the worker:

```
VitalPBX inbound INVITE
  → telephony → API PBX-event handler (apps/api/src/server.ts)
      → db.callInvite.create({ status: "PENDING", … })          // server.ts ~3390
      → sendPushToUserDevices({ type: "INCOMING_CALL", … })      // server.ts ~3407
            └─ Expo data push ONLY  (to: expoPushToken)          // ← was the whole story
```

The worker's correct APNs VoIP sender (`sendVoipPushesForIncomingCall` →
`sendApnsVoipPush`) only runs on the worker's **PBX-poll** path, which **early-returns**
when a `PENDING` invite already exists for that `pbxCallId`
(`apps/worker/src/main.ts:685`). Because the API creates that `PENDING` invite first, the
worker poll is **always preempted**, so **no `apns-push-type: voip` push was ever sent for
a live call** → a backgrounded/locked/cold-killed iPhone never rang (observed in Phase 7:
worker had `APNS_*`, the invite was created, yet the worker logged zero push activity).

**Fix.** The API's `sendPushToUserDevices`, after its unchanged Expo send, now also fans
out an APNs VoIP push to the user's iOS devices — **only for `INCOMING_CALL`** — using the
**same** APNs sender the worker uses (now shared). The Expo/Android path is byte-for-byte
unchanged.

```
sendPushToUserDevices(INCOMING_CALL)            // apps/api/src/server.ts
  ├─ Expo data push → all devices (unchanged; iOS still gets it, JS dedupes by callId)
  └─ sendApnsVoipPushesForIncomingCallApi(...)   // NEW
        → filter devices: platform === "IOS" && voipPushToken != null
        → sendApnsVoipPush(token, { callId: inviteId, tenantId, toExtension,
                                    callerNumber: fromNumber, callerName: fromDisplay,
                                    timestamp })           // @connect/shared/apnsVoipPush
        → api_apns_voip_* logs + 410/BadDeviceToken/Unregistered token invalidation
```

---

## 2. Files changed

| File | Type | Change |
|------|------|--------|
| `packages/shared/src/apnsVoipPush.ts` | **new (moved)** | The APNs VoIP sender — **moved verbatim** from `apps/worker/src/apnsVoipPush.ts` so the fragile ES256/`.p8`/HTTP-2 signing logic lives in **one** place, importable by both API and worker. Dependency-free (Node `http2` + `crypto`). |
| `packages/shared/src/apnsVoipPush.test.ts` | **new (moved)** | The 7 dry-run unit tests, moved from the worker. |
| `packages/shared/package.json` | edit | Added the `./apnsVoipPush` subpath export and `src/apnsVoipPush.test.ts` to the `test` script. |
| `apps/worker/src/main.ts` | edit | Import changed from local `./apnsVoipPush` → `@connect/shared/apnsVoipPush`. **No behavior change** — `sendVoipPushesForIncomingCall` is untouched. |
| `apps/worker/src/apnsVoipPush.ts` | **deleted** | Promoted to `@connect/shared`. |
| `apps/worker/src/apnsVoipPush.test.ts` | **deleted** | Promoted to `@connect/shared`. |
| `apps/api/src/server.ts` | edit | Import `isApnsVoipConfigured`, `sendApnsVoipPush`, `ApnsVoipCallPayload` from `@connect/shared/apnsVoipPush`; add `sendApnsVoipPushesForIncomingCallApi(...)`; invoke it from `sendPushToUserDevices` **only for `INCOMING_CALL`**, after the Expo send, wrapped in `.catch(...)`. |
| `apps/api/.env.example` | edit | Documented the `APNS_*` block (with the topic double-`m` warning). |
| `docs/mobile-ios-phase7a-live-api-voip-push-report.md` | **new** | This report. |

No schema migration (the `MobileDevice` model already has `voipPushToken`,
`lastPushType/Status/Error`, `lastPushSentAt`). No Android files touched. No deploy.

**Sharing decision (no duplicated signing logic):** the sender was **moved** to
`@connect/shared`, not copied. It is **subpath-only** (`@connect/shared/apnsVoipPush`),
**deliberately not** re-exported from the `@connect/shared` barrel — because it imports
node-only `http2`/`crypto` and the **portal (browser/Next.js) imports the barrel** in many
client components. This mirrors the existing `@connect/shared/chatSignedUrl` convention
(node-only, subpath-only) called out in `packages/shared/src/index.ts`.

---

## 3. Env vars needed on the API container

The API now needs the **same** `APNS_*` env the worker has (both read `process.env`
through the shared module). They live in `/opt/connectcomms/env/.env.platform` (already
appended for the worker in Phase 7); the **API container must also load them**.

| Env var | Required | Value / note |
|---------|----------|--------------|
| `APNS_TEAM_ID` | yes | Apple Developer Team ID (`PR63R6J84J` for the build's signing team). |
| `APNS_KEY_ID` | yes | Key ID of the APNs `.p8` AuthKey. |
| `APNS_AUTH_KEY_P8` **or** `APNS_AUTH_KEY_BASE64` | yes (one) | `.p8` PEM (literal `\n` ok) or its base64. |
| `APNS_BUNDLE_ID` | no (default) | `com.connectcommunications.mobile`. |
| `APNS_VOIP_TOPIC` | no (default) | `com.connectcommunications.mobile.voip` (`<bundleId>.voip`). |
| `APNS_PRODUCTION` | no | `false` for the dev/ad-hoc build (`aps-environment: development` → APNs **sandbox**). `true` only for TestFlight/App Store. |

If absent, `isApnsVoipConfigured()` is `false`, the API logs
`api_apns_voip_skipped_unconfigured`, and Android/Expo behavior is unaffected.

---

## 4. Proof the API path now sends a VoIP push

**Code path (static):** `db.callInvite.create` → `sendPushToUserDevices(INCOMING_CALL)` →
(after Expo send) `sendApnsVoipPushesForIncomingCallApi` → `sendApnsVoipPush` (shared).
The helper filters to `platform === "IOS" && voipPushToken`, checks
`isApnsVoipConfigured()`, and per device emits the structured logs in §7 and POSTs to APNs
(`apns-push-type: voip`, `apns-topic: <bundleId>.voip`, `apns-priority: 10`,
`apns-expiration ~now+30s`).

**Runtime resolution (proven):** the new `@connect/shared/apnsVoipPush` subpath resolves
and executes from **both** packages (Node 22 honors the package `exports` map):

```
# from apps/worker (static named import)
named-import OK: function function configured= false payloadKeys= callId,tenantId,toExtension,timestamp
# from apps/worker and apps/api (dynamic import)
worker exports: default        api exports: default       (exit 0 both)
```

**Live verification (still required):** set the API `APNS_*` env, deploy the API, then
place an inbound call to an iOS-registered extension and grep the **API** logs for
`api_apns_voip_send_success` with `status: 200`. (Not run here — no deploy was performed.)

---

## 5. Proof the worker path remains safe

- `sendVoipPushesForIncomingCall` and its caller in `apps/worker/src/main.ts` are
  **unchanged** except the import source (`./apnsVoipPush` → `@connect/shared/apnsVoipPush`,
  same symbols, same signatures).
- The worker still emits its `apns_voip_*` (`source: "worker"`) logs; the API emits
  `api_apns_voip_*` (`source: "api"`) — the two are **distinguishable**.
- **No double-send in practice:** the worker poll path is still preempted by the API's
  `PENDING` invite (unchanged dedupe at `main.ts:685`), so for a live call **only the API**
  sends the VoIP push. If both ever fired (e.g. a poll-only call the API didn't handle),
  the device dedupes by `callId` (deterministic CallKit UUID, Phase 4/5), so at most one
  CallKit incoming UI appears.
- **Worker tests: 65/65 pass** after the refactor.

---

## 6. Topic spelling verification

- Bundle id: **`com.connectcommunications.mobile`** — note the **double `m`** in
  `communications`.
- VoIP topic: **`com.connectcommunications.mobile.voip`** = `<bundleId>.voip`.
- The web domain is `connectcomunications.com` (**single `m`**) — **must not** be used for
  the bundle/topic. A single-`m` topic → APNs `400 DeviceTokenNotForTopic` (silent no-ring).
- Enforced by a shared unit test:
  `topic defaults to <bundleId>.voip` asserts `bundleId = com.connectcommunications.mobile`
  and `topic = com.connectcommunications.mobile.voip`.
- `apps/api/.env.example` sets `APNS_BUNDLE_ID=com.connectcommunications.mobile` and
  `APNS_VOIP_TOPIC=com.connectcommunications.mobile.voip` with an inline double-`m` warning.
- **Action item (server):** verify the value already on `/opt/connectcomms/env/.env.platform`
  is the **double-`m`** form before the next live test (Phase 7 set it from a prior session
  and the single-`m` web-domain spelling is an easy mistake — see §10).

---

## 7. Structured API logs added

All single-object pino logs (`event` field + message), `source: "api"`, keyed by `callId`:

| Event | When |
|-------|------|
| `api_apns_voip_token_selected` | An iOS device + `voipPushToken` (tail only) chosen for this call. |
| `api_apns_voip_send_attempt` | About to POST to APNs. |
| `api_apns_voip_send_success` | APNs `200` (`apnsId`, `status`). |
| `api_apns_voip_send_failure` | Non-200 / transport error (`status`, `reason`, `error`, `tokenInvalid`). |
| `api_apns_voip_skipped_unconfigured` | iOS devices present but `APNS_*` not set on the API. |
| `api_apns_voip_token_invalidation_candidate` | `410`/`BadDeviceToken`/`Unregistered`/`DeviceTokenNotForTopic` → `voipPushToken` nulled. |
| `api_apns_voip_fanout_error` | Unexpected throw in the fan-out (call flow still proceeds). |

Token-invalidation behavior mirrors the worker: on a dead token, null `voipPushToken` and
stamp `lastPushStatus = "APNS_VOIP_TOKEN_INVALID"`; other failures stamp
`APNS_VOIP_FAILED` but keep the token; success stamps `APNS_VOIP_OK` +
`lastPushType = "VOIP_INCOMING_CALL"`.

---

## 8. Android regression protection

- The VoIP fan-out filters to **`platform === "IOS"`** with a non-null `voipPushToken` —
  Android rows are never selected.
- The Expo send (`buildExpoPushV2Item` → `exp.host`) and all its per-device tracking,
  `CallWakeEvent` rows, and audit logs are **byte-for-byte unchanged**.
- `mobilePushSimulate` still short-circuits **before** any real send (Expo or VoIP).
- The whole VoIP block is gated on `payload.type === "INCOMING_CALL"` and wrapped in
  `.catch(...)`, so an APNs error can never break the Expo/Android path or the call flow.
- iOS is still **also** sent the Expo push (not trimmed) — minimizes regression risk; the
  mobile JS dedupes Expo+VoIP by `callId` (Phase 4). Trimming the iOS Expo send is a later
  optional optimization.

---

## 9. Test / verification results

| Check | Result |
|-------|--------|
| ReadLints (shared `apnsVoipPush.ts` + test, worker `main.ts`, api `server.ts`) | ✅ No linter errors |
| `pnpm --filter @connect/shared test` | ✅ **APNs 7/7 pass.** 1 unrelated pre-existing failure (`portalPermissions.customRoles`: `can_view_admin_roles … PROTECTED_PLATFORM_ADMIN_PERMISSIONS`) — not touched by this work. |
| `pnpm --filter @connect/worker test` | ✅ **65/65 pass** |
| Runtime resolution of `@connect/shared/apnsVoipPush` from worker **and** api (tsx) | ✅ static named import executes (`isApnsVoipConfigured`/`sendApnsVoipPush` are functions); dynamic import exit 0 |
| `pnpm --filter @connect/worker typecheck` | ⚠️ Only **`src/main.ts(50): TS2307`** (module-resolution, see note) + the **pre-existing** `packages/db`/`packages/shared` webrtc errors documented in earlier phases. |
| `pnpm --filter @connect/api typecheck` | ⚠️ Only **`src/server.ts(108): TS2307`** (module-resolution, see note) from my change; the new helper + invocation add **zero** type errors. All other errors are **pre-existing/unrelated** (crm bulk email, ops/serverHealth, storageMaintenance, webrtc subpaths, two pre-existing server.ts lines 692/5289). |

> **Module-resolution note (TS2307, runtime-safe).** Under this repo's classic
> `moduleResolution`, `tsc` cannot follow a package `exports` **subpath**, so
> `@connect/shared/apnsVoipPush` is flagged `TS2307` — the **identical** tolerated class
> already present for `@connect/shared/webrtcBlackbox`,
> `@connect/shared/webrtcIncidentAlerts`, and `@connect/shared/webrtcGlobalOutageAlerts`
> (all live in production API/worker/db code today). At **runtime** Node and tsx honor the
> `exports` map (proven in §4), so the live VoIP send works. Adding the module to the
> `@connect/shared` barrel would fix the tsc cosmetic but **break the portal's browser
> bundle** (it would pull `http2`/`crypto` in) — which is exactly why `chatSignedUrl` is
> subpath-only. The correct, browser-safe choice is the subpath import.

---

## 10. Remaining blockers before another cold-killed iPhone test

1. **Set `APNS_*` on the API container** (only the worker has them today). Append/confirm
   in `/opt/connectcomms/env/.env.platform` and ensure the **API** service loads it.
2. **Verify `APNS_VOIP_TOPIC` spelling** on the server is the **double-`m`**
   `com.connectcommunications.mobile.voip` (not the single-`m` web-domain spelling).
3. **`APNS_PRODUCTION=false`** for the current dev/ad-hoc build (`aps-environment:
   development` → APNs sandbox). A sandbox/production mismatch is the #1 "accepted but
   never rings" cause.
4. **Deploy the API** via the standard blue/green path (not done here — awaiting explicit
   instruction).
5. **Live test:** lock the iPhone 15, place an inbound call, confirm
   `api_apns_voip_send_success status:200` in the API logs, and that CallKit rings
   (background, locked, cold-killed) and connects after answer.
6. **Cold-killed cancel-before-answer** still needs a backend call-cancel wake (unchanged
   from Phase 5; out of scope here).

---

## Status

**✅ Code complete and verified as far as possible without a deploy.** The live
API-created inbound-call path now sends an APNs VoIP push (iOS + `voipPushToken`, call-only)
in addition to the unchanged Expo push, using a single shared APNs sender that both the API
and worker import. Android is untouched; worker behavior is unchanged (65/65 tests);
shared APNs tests 7/7. The only new typecheck diagnostic is a runtime-safe, pre-existing-class
module-resolution `TS2307` (subpath export), proven to resolve at runtime from both packages.

## Risks

- **API container env not yet set** — without `APNS_*` the API logs
  `api_apns_voip_skipped_unconfigured` and iOS won't wake. (Blocker #1.)
- **Topic/`APNS_PRODUCTION` mismatch** — silent no-ring; verify before testing (#2/#3).
- **Double push to iOS (Expo + VoIP)** — intentional; relies on JS `callId` dedupe.
- **TS2307 subpath cosmetic** — runtime-safe, matches existing convention; if the team
  later flips `moduleResolution` to `bundler`/`node16`, these clear repo-wide.
- **No live APNs integration test here** — only dry-run unit tests + runtime resolution;
  the real send needs API creds + deploy + a physical-device call.

## Next recommended Cursor prompt

> Deploy + live-verify Phase 7a iOS VoIP push. (1) Ensure the **API** container loads
> `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_AUTH_KEY_P8`/`_BASE64`,
> `APNS_BUNDLE_ID=com.connectcommunications.mobile`,
> `APNS_VOIP_TOPIC=com.connectcommunications.mobile.voip`, `APNS_PRODUCTION=false` from
> `/opt/connectcomms/env/.env.platform` — and **verify the topic is the double-`m`
> spelling**. (2) Deploy the API via the standard blue/green direct-deploy path; confirm
> `[deploy-api] done <sha>` and grep the running container for the new
> `sendApnsVoipPushesForIncomingCallApi` symbol. (3) On the iPhone 15: lock it, place an
> inbound call, and confirm `api_apns_voip_send_success status:200` in the API logs plus a
> CallKit ring (background, locked, cold-killed) that connects after answer. (4) If APNs
> returns `DeviceTokenNotForTopic`, fix the topic; if `BadDeviceToken`/sandbox errors, fix
> `APNS_PRODUCTION`. Do not change Android. Record results in a Phase 7b report.

---

*End of Phase 7a report. Code + docs only — no EAS build, no native iOS generation, no
package installs, no migrations, and no deploys were performed. Android behavior preserved;
worker 65/65 + shared APNs 7/7 tests pass.*
