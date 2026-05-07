# DEBUGGING

> Read `CURSOR_START_HERE.md` first. Read-only diagnostics found in the codebase.
> All commands listed here are **non-mutating**. Anything not directly verifiable is
> marked **UNKNOWN — verify before changing.**

---

## Health endpoints found in code

| Service | Path | What it returns |
|---|---|---|
| `apps/api` | `GET /health` | `{ ok: true }` |
| `apps/api` | `GET /metrics` | Prometheus (admin auth required, see `server.ts`). |
| `apps/api` | `GET /admin/sbc/status` | Live SBC probe (super-admin). |
| `apps/api` | `GET /voice/sbc/status` | Tenant-admin SBC view incl. active upstream + masked targets. |
| `apps/api` | `GET /mobile/android/latest` | Android APK manifest (public). |
| `apps/realtime` | `GET /health` | `{ ok: true }` |
| `apps/telephony` | `GET /health` | Health from `HealthService.getHealth()` (status, AMI/ARI, active counts). |
| `apps/telephony` | `GET /metrics` | Prometheus. |
| `apps/telephony` | `GET /telephony/health` | Same as `/health`, JWT-authed. |

## Forensic / diagnostic endpoints found in code

`apps/telephony` (always exposed; no debug flag required):

| Path | Notes |
|---|---|
| `GET /diagnostics` | `HealthService.getDiagnostics()` — store stats, raw vs derived counts, overcount detection. |
| `GET /forensic` | `?pbx=N&kpi=N&rows=N` — single-shot mismatch capture incl. health + diagnostics + forensic + sample of active calls. |
| `GET /telephony/calls` | Active calls, tenant-filtered by JWT. |
| `GET /telephony/extensions` | BLF list, tenant-filtered. |
| `GET /telephony/queues` | Queue list, tenant-filtered. |
| `GET /telephony/snapshot` | `SnapshotService.getSnapshot(tenantId)`. |
| `GET /telephony/diag` | Full unfiltered store + BLF + tenant map. JWT required (any role). |
| `GET /cdr-stats` | CDR ingest counters since container start. |
| `DELETE /cdr-stats` | Reset CDR stats. |
| `GET /healing/status` | `HealingEngine` status. |
| `GET /healing/log?maxAgeMs=...` | Recent healing actions. |

`apps/api`:

| Path | Notes |
|---|---|
| `GET /pbx/live/combined` | Tenant `summary` (incomingToday, outgoingToday, internalToday, missedToday). UNKNOWN current path naming — verify with Grep. |
| `GET /admin/pbx/live/combined` | Admin aggregate of the same. |

`ops/deploy-queue` (server-only, `127.0.0.1:3910`):

| Path | Notes |
|---|---|
| `GET /ops/deploy/status` | runningCount, idle/active state. |
| `GET /ops/deploy/jobs` | Recent jobs. |
| `GET /ops/deploy/jobs/:id` | Job detail. |
| `GET /ops/deploy/jobs/:id/log?lines=200` | Job log tail. |

---

## Useful log locations (from repo references)

- **Server-side container logs**: `docker logs --since=10m <container>` (read-only is
  fine; `docker compose ps` to list).
- **Deploy worker logs**: `/var/log/connect-deploys/...` on the server.
- **API process logs**: stdout via `docker logs api`. Mentioned in `_app-api-last40m.log`
  (committed dump) — UNKNOWN how it was captured.
- **PBX read-only audit wrapper**: `scripts/pbx/install-pbx-audit-wrapper.sh` +
  `scripts/pbx/pbx_readonly.sh` + `scripts/audit-moh-readonly.sh` +
  `scripts/audit-vm-greeting-readonly.sh`. SSH `cursor-audit@PBX_HOST` runs a forced
  read-only audit script (mentioned in `LIVE_CALL_FORENSIC_RUNBOOK.md`).
- **`pbx_audit@` (the wrapper at `scripts/pbx/pbx_readonly.sh`) — invocation gotchas**
  (verified 2026-05-06):
    - The forced-command wrapper only accepts an exact-match allowlist of 14
      commands. There is **no** `cat /var/log/asterisk/full`, no `verbose`, no
      `pjsip set logger`, no AMI tail, no `cdr show`, no general `mysql`
      query. Per-call dialplan tracing through this account is impossible.
    - SSH host: **`209.145.60.79` port 22** (the older `~/.ssh/config` entry
      pointing at port 2222 is stale; that port is firewalled). Use
      `ssh -i ~/.ssh/PBX-Read -p 22 pbx_audit@209.145.60.79 '<allowed cmd>'`.
    - On Windows OpenSSH, the wrapper rejects the canonical
      `asterisk -rx "pjsip show contacts"` form (PowerShell mangles the inner
      double quotes). Use **single quotes inside the SSH double-quoted string**:
      `ssh ... "asterisk -rx 'pjsip show contacts'"`. The wrapper's
      `sed s/'/"/g` normalization then matches the allowlist entry. The `help`
      keyword can also fail on Windows — a real allowlisted command is the
      reliable way to verify access.
    - Useful baseline captures (cross-tenant / killed-app diagnosis):
      `pjsip show contacts`, `pjsip show endpoints`, `core show channels concise`,
      `database show connect`, `dialplan show connect-tenant-ivr`, plus
      `cat /etc/asterisk/extensions__60_custom.conf`.
    - **`journalctl -u connect-pbx-helper -n 80` and
      `tail -20 /var/lib/connect-pbx-helper/audit.jsonl` are NOT call-flow
      logs.** They are the helper service's own HTTP access log and RBAC
      audit trail (e.g. `voicemail/greeting/get`). They contain no inbound
      DIDs, no dialplan steps, no INVITE traces. Do not interpret a quiet
      audit.jsonl as evidence about a call — it can only confirm the helper
      itself was/wasn't asked to do voicemail/greeting/IVR-publish work.
    - For per-call evidence the wrapper is **not** sufficient; escalate to a
      privileged session that can read `/var/log/asterisk/full` (do **not** add
      that path to `pbx_audit` — it would expose every call, voicemail, and
      auth challenge on the box). Alternative for routing-only forensics:
      VitalPBX's own CDR API (`/api/v2/cdr`), which Connect already calls
      via `apps/worker/src/main.ts::runPbxCdrSyncCycle`. That route is
      tenant-scoped and never exposes call audio or auth secrets.
- **Mobile native logs**: `scripts/android/vm-record-logcat-live.ps1`,
  `scripts/android/summarize-vm-record-log.ps1`,
  `scripts/mobile-android-live.ps1`,
  `scripts/android-live-capture.ps1`,
  `scripts/android-live-debug.ps1`,
  `scripts/android-logcat-clear.ps1`.
- **Phase A vm-record deploy (2026-05-07, evidence reference).**
  Successful Phase A API deploy `ad842f0e-721f-45b8-afe2-5976ce710673`
  to commit `f910e6d`. The deploy queue's clone at `/opt/connectcomms/app`
  did carry one unrelated dirty file (`apps/telephony/src/.../CallStateStore.ts`)
  but it did NOT block this deploy because the conflict-bearing
  `git checkout` only fails when the dirty path overlaps with the
  target commit's changed paths. Phase A only modified
  `apps/api/src/vmRecordCall*.ts` + `docs/ai-context/*`, none of which
  collided with the dirty telephony file, so the checkout succeeded
  and the post-deploy `grep` inside `app-api-1` confirmed the new
  strings were present. Use this as the canonical clean-success
  example when contrasting with the 2026-05-06 telephony stale-code
  failure already documented in `AGENTS.md`.
- **`mobile-push: device fan-out` (Phase A.5).** Every call to
  `sendPushToUserDevices` (any payload type) emits this structured
  Pino info line BEFORE Expo dispatch. Fields:
  - `payloadType` — `INCOMING_CALL`, `INCOMING_CALL_WAKE`,
    `INVITE_CANCELED`, `INVITE_CLAIMED`, `MISSED_CALL`, `voicemail`,
    `missed_call`, `dm_message`, `sms_message`.
  - `includeInactiveDevices` — `true` only on vm-record's
    `INCOMING_CALL_WAKE` path; `false` for every other caller.
  - `totalRowsFound` — `MobileDevice` rows returned by the where query
    (already scoped to tenant + user).
  - `activeRowsCount` — subset where `active=true`. When
    `includeInactiveDevices=false`, this equals `totalRowsFound`.
  - `rowsMissingToken` — subset where `expoPushToken` is null/empty.
    Surfaced for diagnostic only — not filtered out (Expo handles
    invalid tokens per-ticket and the existing
    `DeviceNotRegistered` → `active=false` flow still applies).
  - `afterExclude` — final count after `excludeDeviceId` removal;
    this is the number sent to Expo and the value `queued` returns
    for non-simulated sends.
  Use this line to tell apart "no devices on file" vs "devices on
  file but all stale" vs "device excluded". For vm-record specifically
  this is the line that explains a `wake_sent_but_not_registered`
  error code.
- **`vm-record-call: helper returned direct_pjsip channelSource` (Phase B regression detector).**
  After Phase B (2026-05-07) the PBX helper always returns
  `channelSource: dispatch_local:<base>[,hint]`. If the API ever logs
  this warn line, the helper running on the PBX is older than
  `2026.05.07.1` and the originate is bypassing the
  `[connect-vm-greeting-dispatch]` Dial fan-out. Recovery: re-run
  `bash scripts/pbx/install-vitalpbx-inbound-route-helper.sh` on the
  PBX host as root, then verify
  `curl http://127.0.0.1:8757/voicemail/greeting/diag | jq -r .version`
  reports `2026.05.07.2` or later. The
  `dispatchShowOutput` field of `/voicemail/greeting/diag` should
  contain
  `Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^...))`.
- **Voicemail greeting written to wrong directory (Phase C fix, 2026-05-07).**
  Symptom: `POST /voicemail/greeting/record-call` completes (job reaches
  `state=saved` or `verify_timeout`), but calling in plays the generic
  VoiceMail prompt instead of the recorded greeting.
  Root cause: VitalPBX names each tenant's voicemail context after the
  tenant slug (`test-voicemail`, not `21` or `T21`). The helper used to
  resolve candidates in the wrong priority order.
  Diagnostic steps:
  1. Check which context VitalPBX uses:
     `asterisk -rx "voicemail show users" | grep 101`
     → look for `test-voicemail 101 ...` (context is the first column).
  2. Check the AstDB context key (present after Phase C):
     `asterisk -rx "database show connect_vm_context"`
     → should show `T21_101 = test-voicemail`.
  3. Check the helper's `/voicemail/greeting/get` response:
     `curl -s -X POST http://127.0.0.1:8757/voicemail/greeting/get \
       -H 'Content-Type: application/json' \
       -d '{"tenantId":"21","extension":"101","greetingType":"unavailable"}' | jq`
     → `pbxPath` should resolve to
     `/var/spool/asterisk/voicemail/test-voicemail/101/unavail.wav`.
  4. After recording, verify the file:
     `ls -la /var/spool/asterisk/voicemail/test-voicemail/101/unavail.wav`
  Recovery: re-run the installer — `bash scripts/pbx/install-vitalpbx-inbound-route-helper.sh`.
  Helper version must be `2026.05.07.2` or later. The helper logs
  `astdb_vm_context: key=T21_101 context=test-voicemail` to stderr on
  each vm-record originate when the context is resolved successfully.
- **Voicemail Call-to-Record (`POST /voicemail/greeting/record-call`):**
  the API now emits three structured log lines per attempt that together
  classify the mobile-wake outcome:
  - `vm-record-call: mobile wake decision` — fires once. Fields:
    `deviceRowCount`, `activeDeviceCount`, `endpointAlreadyAvail`,
    `matchedEndpoints`, `decision` (`send_wake` or `skipped_no_devices`).
    A `skipped_no_devices` here means the user has zero `MobileDevice`
    rows for the tenant — verify with `SELECT COUNT(*) FROM "MobileDevice"
    WHERE "tenantId"=$1 AND "userId"=$2`. **Do not** read this line as
    evidence about the SIP originate path — that's still upstream of
    this decision.
  - `vm-record-call: mobile wake push sent` — fires after FCM dispatch.
    Fields: `pbxCallId`, `devicesNotified`, `deviceRowCount`. If
    `devicesNotified=0` while `deviceRowCount>0`, the user has stale
    push tokens (`MobileDevice.expoPushToken IS NULL`) — escalate to
    re-registration on the device.
  - `vm-record-call: mobile wake registration outcome` — fires after
    the 12s readiness poll. Fields: `registered` (boolean),
    `registrationState`, `waitedMs`. `registered=false` after a wake
    means the device received the push but JsSIP didn't reach
    `REGISTERED`; this maps to error code
    `wake_sent_but_not_registered` and should not be retried by an
    agent — ask the user to unlock and try again.
  - The job's public-view (`GET /voicemail/greeting/record-call/:jobId`)
    `wake` block exposes the same diagnostic fields plus
    `endpointAlreadyAvail` for portal-side debugging.
- **Trace dumps committed at root**: `trace3.txt` … `trace15-gap.txt`,
  `logcat-cancel.txt`. These are historical; recapture when investigating.
- **Android incoming call UI — Phase D (2026-05-07).**
  Symptom: user sees a Samsung/T-Mobile-style native phone call screen
  instead of (or in addition to) the Connect `IncomingCallScreen`, and
  answering from the native screen does not connect the call.
  Root cause: `TelecomBridge.startIncomingCall()` dispatched a
  SELF_MANAGED Telecom call before the SIP INVITE existed; the Telecom
  answer fired before JsSIP's `answerIncoming()` could find a session.
  **Fix deployed 2026-05-07**: Telecom dispatch disabled in
  `IncomingCallFirebaseService.handleIncomingCallNative()`. All calls
  now go through CallStyle notification + FSI.

  **Logcat filters for this path:**
  ```
  adb logcat -s IncomingCallService ConnectCallFlow
  ```
  After Phase D, every non-foregrounded call must log:
  ```
  [CALL_INCOMING] telecom_dispatch skipped (disabled) inviteId=<id>
  [CALL_INCOMING] presentation_decision locked=... fullScreen=true
  [CALL_INCOMING] posted incoming call notification mode=full_screen
  ConnectCallFlow: {"stage":"NATIVE_NOTIFICATION_POSTED",...}
  ```
  If you see `TELECOM_INCOMING_DISPATCH` in the logcat, the dead-code
  `if (false)` guard has been accidentally re-enabled — revert the
  `IncomingCallFirebaseService.java` change.

  **If calls still show native phone UI after Phase D:**
  1. Verify the APK was rebuilt after the Java change (`pnpm mobile:build:android:release`).
  2. Check whether `react-native-callkeep` is calling
     `VoiceConnectionService`. Search logcat for
     `VoiceConnectionService` — if it appears, a JS code path is calling
     `RNCallKeep.displayIncomingCall()`. The only Android path that does
     this is the synthetic-invite backgrounded/locked guard at
     `NotificationsContext.tsx` line ~1422. Verify
     `Platform.OS !== "android"` guards are intact at lines ~3656, ~3691,
     ~3727, ~3790.
  3. To roll back to Telecom: in `IncomingCallFirebaseService.java`,
     change `if (false)` back to `if (!appInForeground && !inActiveCall)`
     and remove the `if (false)` guard. Rebuild.

- **Missed call notifications (2026-05-07, updated native fix).**
  Symptom: user misses a call and no notification appears in the Android
  notification tray.
  Root cause: the API sends `MISSED_CALL` as a data-only FCM push (no
  `notification` field) so the native service can stop the ringtone. Android
  never shows a system notification for data-only pushes. Data-only pushes also
  do NOT trigger Expo's JS `addNotificationReceivedListener`, so an earlier fix
  in `NotificationsContext.tsx` was unreachable.
  Fix (v2): `IncomingCallFirebaseService.handleCallTerminationNative()` now
  calls `postMissedCallNotification()` for `type == "MISSED_CALL"` which posts a
  native `NotificationCompat` banner (title "Missed call", body "Missed call
  from …") on channel `connect-missed-calls` (notification ID range 52000–61000).
  Verify: miss a call → logcat shows `missed_call_notif_posted` →
  notification appears on device → tap opens app.
  **Logcat filter:**
  ```
  adb logcat -s IncomingCallService | grep -i "missed_call"
  ```
  Expected log: `[MISSED_CALL] missed_call_notif_posted notifId=52xxx caller=+1...`
  If no notification appears:
  1. Confirm `connect-missed-calls` channel exists and is not muted:
     `adb shell dumpsys notification --noredact | grep connect-missed-calls`
  2. Confirm POST_NOTIFICATIONS permission granted:
     `adb shell dumpsys package com.connectcommunications.mobile | grep POST_NOTIFICATIONS`
  3. Check logcat for `missed_call_notif_failed` to see the exception.

- **Contact import permission not appearing (2026-05-07).**
  Symptom: user taps Import Contacts, nothing seems to happen (no Android
  permission dialog, or modal opens but tapping "Continue" does nothing).
  Root cause: on Android 12+, calling `requestPermissionsAsync()` asynchronously
  inside a Modal's `useEffect` (after the triggering gesture has already been
  consumed) silently fails — no system dialog appears.
  Fix: `ContactTab` now calls `checkContactsPermission()` +
  `requestContactsPermission()` directly inside the import button's `onPress`
  handler, then passes the result as `initialPermission` to the modal.
  Verify: fresh install or permission-revoked device → tap Import Contacts →
  Android permission dialog appears immediately → grant → modal loads contacts.

- **SMS chat back navigation (2026-05-07).**
  Symptom: inside an SMS/DM chat, pressing the Android hardware back button
  navigates to the Team tab instead of returning to the chat list.
  Root cause: `ChatTab` is a bottom-tab screen with no stack; React Navigation
  defaulted to the previous tab on back press when `activeThread !== null`.
  Fix: `ChatTab` registers a `BackHandler` when a thread is open, returning
  `true` (consumed) and calling `setActiveThread(null)`.
  Verify: open any SMS thread → press hardware back → returns to thread list,
  not to Team tab.

---

## Useful npm / pnpm scripts found

From `package.json`:

| Script | Purpose |
|---|---|
| `pnpm dev` | Run `turbo run dev --parallel` across services (local dev). |
| `pnpm build` | Turbo build all. |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | Standard. |
| `pnpm db:generate` / `pnpm db:migrate` | Prisma generate + dev migrate (LOCAL). |
| `pnpm smoke:pbx:v1.1.0` / `pnpm smoke:pbx` | `node scripts/smoke-v1.1.0.mjs`. |
| `pnpm audit-pbx` | `node scripts/pbx-live-observe.mjs`. |
| `pnpm mobile:start` | Expo dev server. |
| `pnpm mobile:start:dev-client` / `:usb` | Dev client. |
| `pnpm mobile:dev-live` / `:live-capture` / `:live-debug` / `:logcat-clear` | Android live debug helpers. |
| `pnpm mobile:android` | `expo run:android`. |
| `pnpm mobile:build:android:release` | PowerShell builder. |
| `pnpm mobile:android:ship` | PowerShell ship script. |
| `pnpm mobile:setup-and-build:android` | Setup + release build. |
| `pnpm mobile:ios` | `expo run:ios`. |
| `pnpm desktop:dev` / `desktop:build` | Electron. |
| `pnpm build:changed` | `bash scripts/build-changed.sh`. |
| `pnpm smoke:fast` | `bash scripts/smoke-fast.sh`. |

Per-service:

- `apps/api`: `pnpm --filter @connect/api dev` (tsx watch). PBX scripts:
  `pbx:diagnose`, `pbx:enable-instances`, `pbx:diagnose-by-name`, `pbx:link-tenant`,
  `pbx:link-all-tenants`, `pbx:set-ombu-mysql`.
- `apps/telephony`: `pnpm --filter @connect/telephony smoke` runs `tsx src/smoke.ts`.
- `apps/mobile`: `pnpm --filter @connect/mobile test:vm-greeting`.

---

## Suggested read-only diagnostics flow

1. **Always start with**: `GET /telephony/health` and `GET /telephony/diagnostics`.
2. For active-call mismatches: `GET /telephony/forensic?pbx=N&kpi=N&rows=N` plus
   the PBX read-only audit (`ssh cursor-audit@PBX_HOST`).
3. For deploy issues: `GET /ops/deploy/status` then `GET /ops/deploy/jobs?status=...`
   then `GET /ops/deploy/jobs/:id/log?lines=2000`.
4. For mobile call bugs: pull `mobileDeviceCallWakeDiagnostics` and
   `callWakeEventTimeline` rows by `userId`+`tenantId`+time window. Pair with
   `[CALL_TIMELINE]` log lines from telephony / api / worker.
5. For voicemail/recording bugs: `GET /pbx/live/combined` for sanity, then look at
   `voicemail` rows + `connectCdr.recordingPath`.
6. For SMS issues: `db.smsMessage`, `db.providerHealth`, BullMQ queue depth via
   `redis-cli LLEN bull:sms-send:wait`. Worker logs show
   `sms job completed` / `failed`.

### Failed inbound-to-mobile call: identifying which call actually failed

When a user reports "outside call didn't ring my killed mobile", **PBX-read alone
is not enough** — the `pbx_audit` allowlist has no historical view (no
`/var/log/asterisk/full`, no AMI tail, no CDR query, no general MySQL). Use
existing Connect data instead:

1. **`GET /calls/history`** (`apps/api/src/server.ts:20843`) reads
   `connectCdr` and is populated for **every** inbound call the PBX sees, not
   only Connect-managed DIDs (the `apps/worker` `runPbxCdrSyncCycle` mirrors
   VitalPBX's full CDR table every ~2 min, in addition to live ingest via
   `/internal/cdr-ingest`). Filter by `startDate`, `endDate`,
   `direction=incoming`, then look at `fromNumber`, `toNumber`, `dcontext`,
   `linkedId`, `disposition`, `rawLegCount`. The route auto-translates
   `vpbx:<slug>` ↔ Connect cuid so the row will appear regardless of which
   format the CDR row uses.
2. **`GET /mobile/wake/timeline`** (`server.ts:25111`) reads
   `callWakeEvent` rows. Filter by `pbxCallId=<linkedId>` to see whether
   `pbx_dialplan` ever emitted `WAKE_REQUESTED` for that specific call;
   absence of any `pbx_dialplan`-source row proves the wake API was not
   invoked (which is normal for a non-Connect-managed DID, since
   `connect-dial-with-wake` only runs for DIDs with a
   `connect/didmap/<e164>/tenant` AstDB entry).
3. The `dcontext` value on the CDR row distinguishes Connect-managed
   (`connect-tenant-router`, `connect-tenant-ivr`, `connect-dial-with-wake`)
   from VitalPBX-native flow (e.g. `from-internal`, `ext-did`,
   `from-did-direct`). This is the deciding evidence for "did this call ever
   touch Connect's wake path".
4. AOR-precision (which contact got the INVITE: `T<id>_<ext>` desktop AOR vs
   `T<id>_<ext>_1` mobile AOR) is **not** preserved reliably in CDR; for that
   you need `/var/log/asterisk/full` or AMI history. Do not pretend CDR can
   answer that.

**Why this matters**: the PBX-read pass for an inbound failure can only
confirm live state (current contacts/registrations/channels) — never the
identity of a specific past call. Always run step 1 before drawing any
conclusion about which DID was dialed.

### Telephony service: confirming whether `MobilePushNotifier` actually fired

When CDR shows `PJSIP/T<id>_<ext>_1` in `channelsSeen` but no `CallInvite`
row, no `CallWakeEvent` row, and `MobileDevice.lastPushSentAt` did not
advance, the FCM push was suppressed inside the telephony service. The
authoritative log lives in the `app-telephony-1` container; access via the
production app server:

```powershell
ssh -o ConnectTimeout=10 -o BatchMode=yes connect `
  "docker logs app-telephony-1 --since=10m 2>&1 | grep '<linkedId>'"
```

Look for these `MobilePushNotifier` log lines, in order of severity:

- `mobile-ring: notifying API` — push WAS sent to `apps/api`. Pair with
  `app-api-1` log `mobile-ring-notify: push sent` to confirm FCM dispatch.
- `mobile-ring: suppressed outbound self-ring (extension dialed external from same AOR)`
  — push was **explicitly suppressed** for an outbound dial from an
  extension that has both desktop (`T<id>_<ext>`) and mobile
  (`T<id>_<ext>_1`) AORs registered. This is **expected** when
  `direction:"outbound"` and prevents the originator's own mobile
  re-ringing. If you see `direction:"inbound"` on this log line you are
  looking at pre-`b5f8a43` (2026-05-06) behavior — the running container
  is stale; `KNOWN_ISSUES.md` "Deploy queue silently ships stale code"
  note explains how that happens and how to recover. The legacy message
  text was `"mobile-ring: suppressed same-extension outbound self-ring"`
  — finding that exact message in current logs is also a stale-image
  signal.
- `mobile-ring: notify-entry` with `exts:[]` and no later
  `notifying API` — extensions never resolved (helper-only legs); not a
  bug, the next AMI event will retry.

The `app-api-1` mate logs are also useful:

```powershell
ssh connect "docker logs app-api-1 --since=10m 2>&1 | grep -E 'mobile-ring-notify|<linkedId>'"
```

`mobile-ring-notify: received` proves the telephony→api hop happened;
absence proves the suppression was upstream of the API.

### Deploy queue: confirming a fix actually shipped

The deploy queue worker uses `scripts/lib/deploy-common.sh::deploy_common_git_sync`,
which historically could silently ship stale code if the shared clone at
`/opt/connectcomms/app` had uncommitted edits in a file your branch also
modified (see `KNOWN_ISSUES.md`). Current dry-runs perform a non-mutating
checkout-safety preflight and fail with exact dirty blocking paths before any
checkout, Docker, Prisma, restart, or health-check work. After any deploy whose
result matters, **still verify the commit landed inside the running container**
rather than trusting `status:"success"`:

```powershell
# 1. The deploy log's last line should read `done <expected-sha>`.
ssh connect "curl -s 'http://127.0.0.1:3910/ops/deploy/jobs/<jobid>/log?lines=400'" `
  | python -c "import sys,json; print(json.load(sys.stdin)['text'])" `
  | Select-String -Pattern '^\[deploy-\S+\] done '

# 2. Read the file inside the container and grep for the new code.
ssh connect "docker exec app-<service>-1 grep -n '<unique new line>' /app/<path>"
```

If a dry-run log shows `DRY RUN checkout safety: BLOCKED`, read the listed
paths and do not enqueue the real deploy until those production-clone edits are
reviewed, committed/ported, or explicitly restored. If an older deploy queue log
shows `error: Your local changes to … would be overwritten by checkout …
Aborting` followed by `[deploy-common] stage=change-detect` (no fail-fast), the
deploy ran on the dirty pre-existing tree, **not** on your commit. Recovery:
SSH to the server and run
`cd /opt/connectcomms/app && git diff -- <path>` to capture the in-clone
changes (back them up locally first), then
`git checkout HEAD -- <path>` to restore only the file blocking your
deploy, then re-enqueue the deploy job. Do **not** wholesale-reset the
clone — other unrelated hand-edits may also exist there
(`KNOWN_ISSUES.md` lists the known ones).

---

## PBX debugging notes (documentation only — do not run mutating commands)

- **PBX-host helper scripts**: live in `scripts/pbx/` and `docs/pbx/`. Most are
  installers (`install-connect-wake-dialplan.sh`, `install-prompt-sync.sh`,
  `install-vitalpbx-inbound-route-helper.sh`, `install-pbx-audit-wrapper.sh`).
  They are operator-run; do NOT run from agent shells against production.
- **AstDB inspection**: `pbx-diag-astdb.txt` is a captured snapshot. New captures
  go through `cursor-audit@` SSH — see runbook.
- **Dialplan custom contexts**: `docs/pbx/option-a-custom-context.conf` (M, modified
  locally — verify before deploying). Contexts referenced:
    - `[connect-tenant-router]` — reads `connect/t_<slug>/mode`, `dest_*`.
    - `[connect-tenant-ivr]` — Phase 2 prompts + digit options.
    - `[connect-fallback-ivr]` — default fallback.
    - `[from-internal]` — used as the `context` for `Originate`.
- **Prompt sync** workflow documented at `docs/pbx/connect-prompt-sync-install.md`.
- **MOH sync** workflow at `docs/pbx/connect-media-sync-install.md`.
- **IVR runbook**: `docs/pbx/IVR_VITALPBX_PARITY_RUNBOOK.md`,
  `docs/pbx/option-a-setup.md`, `docs/pbx/option-a-runtime-keys.md`.
- **Live snapshot scripts** (PowerShell): `scripts/capture-forensic.ps1` (mentioned
  in `LIVE_CALL_FORENSIC_RUNBOOK.md`).

---

## Mobile debugging notes

- **Logcat helpers** (PowerShell, mentioned above) tail Android logs from a
  USB-connected device.
- **Diagnostic screens in-app**: `apps/mobile/src/screens/DiagnosticsScreen.tsx`.
- **Call flight recorder**: `apps/mobile/src/diagnostics/CallFlightRecorder.ts`.
- **Wake diagnostics**: `apps/mobile/src/diagnostics/callWakeDiagnostics.ts`.
- **Permissions checks**: `apps/mobile/src/sip/permissions.ts`.
- **Notification routing**: `apps/mobile/src/notifications/notificationRouting.ts`.
- **Common Android cold-start bug** is documented inline in
  `apps/worker/src/main.ts::sendPushToUserDevices` — keep FCM `data` only, all
  values stringified.

---

## WebSocket debugging notes

- Connect with a JWT-authed `wscat`-style client to:
    - `wss://app.connectcomunications.com/ws/telephony?token=<jwt>` for telephony.
    - `wss://app.connectcomunications.com/ws?token=<jwt>` for `apps/realtime`.
- Inspect a connection on the server with `docker logs telephony --tail 200`.
- Periodic 3-min presence refresh + 60-s stale cleanup are visible in telephony
  logs (`Telephony` child logger).
- nginx config required for keepalive: `docs/TELEPHONY_NGINX.md`
  (`proxy_read_timeout 86400s`).
- `scripts/ops/_inspect-live-broadcasts.sh` — UNKNOWN exact behavior; verify before
  running.
