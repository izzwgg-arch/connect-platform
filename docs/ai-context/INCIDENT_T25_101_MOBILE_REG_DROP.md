# Incident: T25 / ext 101 / device F25 — "Not Registered" when backgrounded

**Status:** Root cause **PROVEN** with live production evidence. Server-side
detection layer (H4–H7) **BUILT, DEPLOYED & VERIFIED** (commit `dd54d04c`,
2026-06-18). Mobile-native fixes (H1–H3) + on-device F25 validation **pending a
physical S25 Ultra** (see §6/§7).
**Date investigated:** 2026-06-17
**Tenant:** T25 = **Relax Tires** (`cmnlgryme000up9paz1w40fg0`)
**Extension:** 101 (`Extension.id = cmnmd7orq003tp9b023qj90vs`)
**User / owner:** S M Weiss (`cmnmjhlu3004xp96hv4g49htg`)
**PBX WebRTC endpoint:** `T25_101_1` (AOR `T25_101_1`, auth `authT25_101_1`)

---

## 0. Device identification (the "F24 / F25" devices)

`F24` and `F25` are the operator's shorthand for two physical Samsung Galaxy
handsets. Confirmed from `MobileDevice` rows for the owner user:

| Label | DB `model` | Marketing name | `osVersion` | `deviceId` | `active` | Last seen |
|-------|-----------|----------------|-------------|-----------|----------|-----------|
| **F25 (FAILING)** | `SM-S938U` | **Galaxy S25 Ultra** | **16** (Android 16 / One UI 8) | `cmow9iw3802s4n94c1ioyjenq` | **yes** | 2026-06-16 20:53 |
| **F24 (CONTROL)** | `SM-S921U` | **Galaxy S24** | 16 | (multiple) | no (deactivated 2026-06-10) | 2026-05-13 |
| (other) | `SM-T577U` | Galaxy Tab Active | 13 | — | yes | 2026-05-13 |

App version on both: `1.0.0`.

---

## 1. Root cause (PROVEN)

On the **Galaxy S25 Ultra (One UI 7/8, Android 16)** the `SipKeepAliveService`
**foreground service (FGS) never reaches the foreground state**, so nothing
holds the app's main process at `FOREGROUND_SERVICE` OOM importance while the
app is backgrounded. When the screen locks / the app is backgrounded:

1. One UI suspends the main process and tears down the JsSIP **WSS WebSocket**
   (the historic `1006 "Software caused connection abort"` ~10 s after lock).
2. The PBX contact for `T25_101_1` is not refreshed, so it **expires / is
   removed** → endpoint becomes `Unavailable` → **PBX `TotalContacts: 0`**.
3. The app cannot recover **while backgrounded** because:
   - JS `setInterval`/`setTimeout` (the 30 s keep-alive watchdog + backoff
     reconnect) are **frozen by Doze** when the process is not FGS-protected.
   - The **network-regain (NetInfo) reconnect trigger was removed** (it caused a
     Hermes startup crash because `@react-native-community/netinfo` is not
     installed), so a Wi-Fi↔LTE switch does **not** trigger an immediate
     re-register.
   - The only `AppState` handler that re-registers fires on **`active`**
     (foreground) — there is **no** background-transition handler.
4. Result: the app shows **"Not Registered"** until the user foregrounds it, or
   until an **FCM wake push** (incoming call) cold-registers it (~600 ms).

On the **Galaxy S24 (F24)** the same FGS **does** start
(`lastForegroundResult:"ok"`, `lastForegroundTypeUsed:"PHONE_CALL|DATA_SYNC"`),
so the process stays at foreground importance, the WebSocket survives, and the
device **stays Registered** in the background. That is the entire difference.

This is **not** the 2026-05-29 `T25_101_1` "SIP not registered" incident (that
was a URI-identity mismatch, `sipUsername=101_1` vs required `T25_101_1`, fixed
in `voiceProvisioningBundle.ts` / commit `dc371a75`). That bug is fixed —
`PbxExtensionLink.pbxDeviceName = T25_101_1`, `provisionStatus = PROVISIONED`,
and the device demonstrably registers and completes calls. The current incident
is a **background keep-alive / FGS** failure specific to the newer Samsung OS.

---

## 2. Evidence (all read-only production proof)

### 2a. PBX live state (authoritative — AMI `PJSIPShowAor`/`ShowEndpoint`, 2026-06-17)

```
AorDetail  ObjectName: T25_101_1
  MaxContacts: 3      RemoveExisting: true     RemoveUnavailable: false
  QualifyFrequency: 30   QualifyTimeout: 3
  MinimumExpiration: 600  DefaultExpiration: 3600  MaximumExpiration: 7200
  TotalContacts: 0    ContactsRegistered: 0    Contacts: (empty)
EndpointDetail T25_101_1  Webrtc: yes  Transport: transport-wss-...  DeviceState: Unavailable
```

- **Zero registered contacts** for the mobile endpoint at probe time → genuinely
  Not Registered at the PBX, independent of what the app reports.
- Desk endpoint `T25_101` also `TotalContacts: 0` (user is mobile-only — expected).
- Credentials are correct (`authT25_101_1` password present; matches DB);
  `RemoveExisting: true` but `MaxContacts: 3`, so multi-device is *not* the cause
  (no second device is evicting it).

### 2b. Backend keep-alive snapshot (`MobileDevice.keepAliveSnapshot`)

- **F25 (SM-S938U)** — current row, last seen 2026-06-16, **and every prior
  snapshot over weeks**:
  ```json
  {"isRunning": false, "lastStartResult": "dispatched", "serviceCreatedAtMs": 0,
   "lastForegroundResult": "", "lastForegroundTypeUsed": "", "lastForegroundErrorClass": ""}
  ```
  → `startForegroundService()` was dispatched but the service **never entered
  foreground** (`serviceCreatedAtMs:0`, `lastForegroundResult:""`, not running).
- **F24 (SM-S921U)** — historical rows:
  ```json
  {"isRunning": true, "lastForegroundResult": "ok",
   "lastForegroundTypeUsed": "PHONE_CALL|DATA_SYNC", "serviceCreatedAtMs": 1777906444076}
  ```
  → FGS came up cleanly with the `PHONE_CALL|DATA_SYNC` type.

### 2c. Registration state history (`VoiceClientSession` for the user)

- F25 sessions are repeatedly created in **`REGISTERING`** and replaced within
  <1 s; they only reach **`REGISTERED`/`CONNECTED`** transiently around an actual
  call. Permissions are fine (`permRecordAudio:true`, `permNotifications:true`).

### 2d. Incoming-call wake path WORKS (`CallWakeEvent` / `VoiceDiagEvent`)

```
WAKE_PUSH_DELIVERED (expoStatus: ok, model SM-S938U) → DEVICE_PUSH_RECEIVED (appState: SERVICE)
→ DEVICE_REGISTER_TRIGGERED (forceRestart:false, sipRegistered:true, latencySinceWakeMs: 5–25)
→ DEVICE_REGISTER_COMPLETE (regState: registered, registerLatencyMs ~160–840)
```
This is why calls *mostly still ring* — FCM push delivery is healthy and the
on-demand wake re-register succeeds. The failure is the **idle/persistent**
background registration, not push.

### 2e. Telephony channel logs confirm the device functions

`PJSIP/T25_101_1-xxxx` channels show successful inbound (ring group 800) and
outbound calls on 2026-06-15 and 2026-06-16 — the device registers and talks
when foregrounded or wake-pushed.

---

## 3. Required conclusion format

- **Root cause:** On Galaxy S25 Ultra (One UI 7/8, Android 16) the
  `SipKeepAliveService` foreground service does not reach/sustain foreground
  state, so the backgrounded main process (which owns the JsSIP WSS socket) is
  suspended/killed; the SIP registration is not refreshed and the PBX contact
  expires, and the app has no working background recovery path (Doze-frozen JS
  timers, removed NetInfo trigger, no background AppState re-register).
- **Evidence:** §2a PBX `TotalContacts:0`/`Unavailable`; §2b `keepAliveSnapshot`
  F25 never foreground vs F24 `ok`; §2c sessions stuck `REGISTERING`; §2d wake
  path healthy; §2e working call channels.
- **Exact failing component:** `apps/mobile/android/.../SipKeepAliveService.kt`
  foreground-service startup on One UI 7/8 (idle `PHONE_CALL|DATA_SYNC` ladder),
  compounded by missing background/network reconnect in
  `apps/mobile/src/context/SipContext.tsx`.
- **Why F24 works:** its FGS starts (`lastForegroundResult:"ok"`,
  `PHONE_CALL|DATA_SYNC`), keeping the process foreground-importance so the WSS
  socket and SIP registration survive backgrounding.
- **Why F25 fails:** its FGS is dispatched but never foregrounds
  (`serviceCreatedAtMs:0`, `isRunning:false`); backgrounded process is
  suspended; no recovery until foreground/wake-push.
- **What changed:** newer device/OS (S25 Ultra, Android 16 / One UI 8) with
  stricter background-FGS rules; the NetInfo network-regain reconnect was
  removed (crash fix) leaving a recovery gap; the app relies on an idle FGS that
  this OS does not grant the same way it did on the S24.
- **Classification:** **App + Android-OS-restriction interaction** (client-side),
  not backend, not PBX config, not credentials, not network, not push.
- **Permanent fix:** (a) make the FGS startup robust on One UI 7/8 and *verify*
  it actually foregrounded (escalate / re-arm if not), (b) re-add a safe
  network-change + background→foreground re-register path, (c) add a background
  registration-refresh verification watchdog, and (d) detect the condition
  server-side so we never rely on the user to report it.
- **Immediate workaround:** on F25, grant **"Don't optimize battery"** for
  Connect (Settings → Battery → Unrestricted) so One UI sustains the FGS; the
  app already prompts for this. Calls still ring via FCM wake even when idle-
  unregistered, but registration stability needs the battery exemption until the
  permanent native fix ships.
- **Detect next time automatically:** ingest PBX contact-state per device and
  raise an alert when an `active` mobile device's endpoint sits at 0 contacts
  for > N seconds while the user is otherwise online (see Hardening §4).

---

## 4. Hardening plan

| # | Area | Change |
|---|------|--------|
| H1 | mobile (JS) | Background→foreground + periodic background re-register verification; safe reconnect when transitioning, without the netinfo crash |
| H2 | mobile (JS) | Registration watchdog that, on repeated stale, re-arms the native FGS (`setKeepAliveEnabled(false→true)`) and reports FGS health |
| H3 | mobile (native) | After `startForegroundSafely()`, verify foreground state landed; if not, retry via AlarmManager/JobScheduler and surface a hard diagnostic |
| H4 | api/db | **DONE** — `PbxEndpointRegistration` + `PbxEndpointRegistrationEvent` Prisma models (migration `20260617200000`); `POST /internal/pbx/contact-status` ingest (shared `CDR_INGEST_SECRET`) |
| H5 | telephony | **DONE** — `RegistrationStatusNotifier` forwards AMI `ContactStatus`/`PeerStatus` (coalesced; reuses `CDR_INGEST_URL`) → API persistence |
| H6 | worker | **DONE** — 60 s cycle alerts (`db.alert` `DEVICE_REGISTRATION` HIGH) when an `active` mobile WebRTC endpoint is `UNREGISTERED`/`UNREACHABLE` > `DEVICE_REG_NOT_REGISTERED_ALERT_SEC` (default 300 s) and a device was seen in 24 h; 6 h prune of events > 14 d |
| H7 | portal | **DONE** — admin "Device Registration" dashboard (`/admin/device-registration`) + per-endpoint timeline; `GET /admin/pbx/registrations[/:endpoint/events]` |
| H1 | mobile (JS) | **PENDING** — background→foreground + periodic background re-register verification; safe reconnect on transition without the netinfo crash |
| H2 | mobile (JS) | **PENDING** — watchdog re-arms native FGS (`setKeepAliveEnabled(false→true)`) on repeated stale + reports FGS health |
| H3 | mobile (native) | **PENDING** — after `startForegroundSafely()`, verify foreground landed; retry via AlarmManager/JobScheduler + hard diagnostic |

### Validation gate (do not close until)
F25 can: register → background → stay reachable → receive + answer incoming →
remain stable across repeated tests → survive Wi-Fi/LTE switch → survive screen
lock → and the dashboard shows continuous heartbeat/registration. **Requires the
physical S25 Ultra in hand** for the on-device portion.

---

## 5. How to investigate the next registration drop

1. Identify device: `MobileDevice` row (model/osVersion/`keepAliveSnapshot`).
2. PBX truth: run `_latency_logs/incident_t25_101/ami_probe_t25.js` inside
   `app-telephony-1` → check `TotalContacts`/`DeviceState` for `T{n}_{ext}_1`.
3. App self-report: `VoiceClientSession.lastRegState` + recent `VoiceDiagEvent`.
4. Push health: `CallWakeEvent` (`WAKE_PUSH_DELIVERED`/`DEVICE_REGISTER_COMPLETE`).
5. FGS health: `keepAliveSnapshot.lastForegroundResult` / `serviceCreatedAtMs`.
6. If `lastForegroundResult != "ok"` on One UI → FGS startup; if `ok` but still
   0 contacts → network/Doze recovery gap.

Proof artifacts saved under `_latency_logs/incident_t25_101/`.

---

## 6. Server-side detection layer — deployed & verified (2026-06-18)

**Commit:** `dd54d04c` ("feat(telephony,api,worker,portal): PBX
device-registration observability"), shipped to all four services via the
AGENTS.md-sanctioned paths:

| Service | Path | Result |
|---------|------|--------|
| api | `scripts/deploy-direct.sh api --branch main` (blue/green) | `done dd54d04c`; **migration `20260617200000` applied** (both tables exist); routes present in container |
| portal | `scripts/deploy-direct.sh portal --branch main` (blue/green) | `done dd54d04c` |
| telephony | deploy queue job `a7aaf9fc…` | `done dd54d04c`, `/health` OK |
| worker | deploy queue job `20ac2727…` | `done dd54d04c`, container healthy |

**Live pipeline proof (minutes after deploy):**
- Telephony log: `RegistrationStatusNotifier ready url=http://api:3001/internal/pbx/contact-status`.
- `PbxEndpointRegistration` populated to **20 endpoints** from live AMI
  `ContactStatus` events; `PbxEndpointRegistrationEvent` recording transitions
  (e.g. `T21_101_1 REGISTERED Reachable`).
- Internal `POST → API → Postgres` path confirmed end-to-end.

**Known nuance:** `T25_101_1` (F25) does **not** appear until it next registers,
because AMI `ContactStatus` only fires when a contact exists/changes — a
permanently-cold endpoint emits nothing. The layer captures the real F25 pattern
(registers on foreground, then a `Reachable→Unreachable→Removed` transition when
backgrounded) and the worker alert fires off those transitions. A future
enhancement could bootstrap "expected but never-seen" endpoints from
`PbxExtensionLink` to flag cold devices proactively.

Data model: `packages/db/prisma/schema.prisma` (`PbxEndpointRegistration`,
`PbxEndpointRegistrationEvent`). Ingest/admin: `apps/api/src/server.ts`. Source:
`apps/telephony/.../RegistrationStatusNotifier.ts`,
`apps/worker/src/main.ts` (`runDeviceRegistrationAlertCycle`,
`runPbxRegistrationEventPrune`),
`apps/portal/app/(platform)/admin/device-registration/page.tsx`.

---

## 7. Remaining risks / not-yet-done

- **H1–H3 mobile-native fixes are NOT shipped.** Until then F25 still drops
  registration when backgrounded without the battery exemption; the immediate
  workaround (§3) stands. The server layer **detects** it but does not fix the
  device.
- **On-device F25 validation gate (§4) is unmet** — requires the physical S25
  Ultra to prove register→background→reachable→answer→survive Wi-Fi/LTE+lock and
  show continuous heartbeat. **This issue stays open** until that passes.
- The watchdog only alerts for endpoints that have registered at least once
  (see §6 nuance).
