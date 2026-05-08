# KNOWN_ISSUES — fragile areas to handle with care

> Read `CURSOR_START_HERE.md` first. This file collects the fragile / historically
> regression-prone areas of the Connect Communications codebase, derived from
> what is **visible in the repo**: file names, comments, runbooks, audit reports,
> migrations, scripts, and snapshots. Anything not directly verifiable is marked
> **UNKNOWN — verify before changing.**

When you find a new fragile area, add it here.

---

## Telephony

- **Active call counting vs VitalPBX active channels.** Multiple recent runbooks and
  snapshots:
    - `docs/LIVE_CALL_FORENSIC_RUNBOOK.md`, `docs/LIVE_CALL_VALIDATION.md`,
      `docs/LIVE_CALL_REAL_WORLD_TEST_PLAN.md`, `docs/LIVE_CALL_ENGINE_AUDIT.md`,
      `MULTICALL_QA_REPORT.md`, `docs/audit/CYCLE-1-GROUND-TRUTH.md`.
    - Forensic / diagnostics endpoints exist (`GET /forensic`, `/diagnostics`) — they
      were added because mismatches happened.
    - The "active = bridge with ≥2 non-helper participants" rule lives in
      `CallStateStore.getActive()` + `normalizeCallEvent.ts`. Don't touch without
      capturing before/after.
- **Helper / `Local/` channel inflation.** Filtering happens in `isHelperChannel`
  / `isLocalOnlyCall` — any new helper channel type (e.g. PJSIP variations) needs
  to be added there or the count drifts.
- **Periodic snapshot replacement disabled.** See comment near
  `apps/telephony/src/telephony/index.ts` line ~155: replacing the active list on
  every ARI tick caused ringing calls to flicker. Do not re-enable.
- **AMI reconnect ghosts.** AMI reconnect can leave stale channel index entries.
  `reconcileActiveBridges(...)` + `forceEvictZombie(...)` + 60 s
  `startPeriodicStaleCleanup` mitigate this. UNKNOWN whether all paths converge —
  monitor `/diagnostics`.
- **Tenant alias handling (`vpbx:<slug>` ↔ Connect CUID).** Without this, regular
  users see empty Live Calls / Team Directory while admins see everything. Lives
  in `PbxTenantMapCache.tenantAliasesEqual`. Do not bypass.
- **Mismatch between dashboard KPI and live calls table.** KPI uses VitalPBX
  `/api/v2/cdr` (today window, timezone-aware); live table uses `connectCdr` and
  `/telephony/calls`. These are two paths — fixes to one do not heal the other.
- **CDR direction inference fragility.** `inferPbxLiveDirection.ts` +
  `cdrDirection.ts` rely on call type / context heuristics. Wrong direction =
  wrong KPI bucket. Tests exist (`cdrDirection.test.ts`,
  `pbx-live.test.ts`) — keep them green.

## Mobile calling

- **Cold-killed Android push reliability.** Long inline comment in
  `apps/worker/src/main.ts::sendPushToUserDevices` explains: every call-control
  push must be a data-only FCM message; values stringified to keep
  `FirebaseMessagingService.onMessageReceived` running. Adding `title`/`body`/`sound`
  silently turns the push into a notification message and breaks ringtone teardown.
- **`MobilePushNotifier` self-ring guard misfires on IVR-fronted inbound DIDs**
  (**FIXED + VERIFIED + REGRESSION-LOCKED** as of 2026-05-06). Source fix:
  commit `b5f8a43` on branch `fix/telephony-mobile-push-self-ring-direction-guard`,
  deployed via queue job `335fce62-7dca-476e-8465-a45911e09d86`. End-to-end
  verified by user the same day: an outside call to A plus DID `8457826775`
  rang **both** the desktop WebRTC softphone **and** the killed/backgrounded
  Android mobile via FCM-driven CallKeep UI. Regression-locked by
  `apps/telephony/src/telephony/services/MobilePushNotifier.test.ts`
  (11 tests, run via `pnpm --filter @connect/telephony test`) — five of
  the eleven tests fail if the `call.direction !== "inbound"` gate at line
  151 is removed, across three different tenants (T2/T11/T18) and the
  dual-AOR path. Originally confirmed by live PBX + log + DB evidence
  2026-05-06 against linkedId `1778094072.18393`, A plus center / ext 103. In
  `apps/telephony/src/telephony/services/MobilePushNotifier.ts` lines 135-147,
  the `selfOriginatingExt` filter is computed without a direction guard:
  `selfOriginatingExt = isExternalDialTarget(call.to) ? extractShortExtension(call.source_extension ?? "") ?? extractShortExtension(call.from ?? "") : null`,
  then applied to `toExtensions` regardless of inbound vs outbound. For
  inbound calls routed through VitalPBX's `T<id>_cos-all` dial, the dialed
  extension's PJSIP channel reports `callerIDNum=<dest-ext>` (e.g. `103`),
  which the notifier reads as `source_extension`. Combined with `to=<10-digit-DID>`
  satisfying `isExternalDialTarget`, the destination extension is filtered
  out of its own push list, the extensions array goes empty, and the early-
  return logs `"mobile-ring: suppressed same-extension outbound self-ring"`
  even though `direction === "inbound"`. **No `/internal/mobile-ring-notify`
  POST happens, no `CallInvite` row is created, no FCM push is sent, no
  `CallWakeEvent` rows are written**, and a backgrounded mobile is silent
  while the desktop softphone rings normally over its still-foregrounded
  WSS contact. The comment at lines 128-131 already warns about this exact
  pattern for `callerExt` (which IS gated on `call.direction === "internal"`)
  but the later-added `selfOriginatingExt` did not inherit the gate.
  **Fix as deployed** (one-liner gate at lines 135-153 of
  `apps/telephony/src/telephony/services/MobilePushNotifier.ts`):
  `const selfOriginatingExt = call.direction !== "inbound" && isExternalDialTarget(call.to) ? … : null;`.
  The same gate already protects `callerExt` for the `"internal"`-only path
  one block above; the new gate extends that direction-awareness to the
  outbound self-ring case. **This is the root cause of the broader
  "killed/backgrounded Android mobile doesn't ring on external calls"
  symptom for every tenant whose inbound DIDs are VitalPBX-native (i.e. all
  but `landau_home`).** The earlier-documented `connect-dial-with-wake`
  wake-skip OR-bug is a separate latent bug that only matters once a
  tenant's DIDs are migrated to Connect-managed routing. **Rollback**
  (if a regression appears in outbound self-ring suppression): revert
  `b5f8a43`, re-enqueue `service: telephony` from `main`. The pre-fix
  outbound behavior is preserved so a regression in *inbound* paths is the
  only realistic concern, and that path is the one we just fixed.
- **Deploy queue silently shipped stale code when `git checkout` aborted in the
  shared clone at `/opt/connectcomms/app`** (mitigated in repo 2026-05-06;
  verify the deploy queue itself is running this version before relying on it).
  The original failure: `scripts/lib/deploy-common.sh::deploy_common_git_sync`
  called `git checkout` without fail-fast handling. When git refused checkout
  ("Your local changes to the following files would be overwritten by checkout
  … Aborting"), the deploy script proceeded to `change-detect → install →
  build → restart → health` and reported `success` while building the dirty
  pre-existing tree. This caused deploy job
  `36b830d2-b159-4afa-a360-adab40b52db6` (real, not dry-run) to skip shipping
  commit `b5f8a43`. Current mitigation in source: dry-runs run a non-mutating
  checkout-safety preflight that fetches refs, resolves the target commit, and
  rejects dirty paths that overlap target-changed paths; real git checkout/fetch
  failures now exit non-zero. Remaining risk: skipping dry-run, running an older
  deploy queue version, or leaving production-only hand-edits in the shared
  clone still requires post-deploy verification and cleanup.
- **Production deploy clone (`/opt/connectcomms/app`) has uncommitted
  hand-edits never pushed to `origin`** (open, confirmed today). As of
  2026-05-06 the clone has 57 lines of uncommitted local edits in
  `apps/telephony/src/telephony/state/CallStateStore.ts` plus the now-fixed
  edits in `MobilePushNotifier.ts`. These are *currently running in
  production* (baked into the most recent telephony image build) but they
  exist nowhere in version control. Risk: any deploy that touches
  `CallStateStore.ts` should now fail dry-run with that path listed as a
  checkout blocker (and real checkout should fail non-zero), but replacing the
  running hand-edits with origin/main's older version could still regress live
  call counting / stale cleanup behavior the hand-edits were patching.
  Backup of the dirty diff was saved on 2026-05-06 to
  `_latency_logs/queue-clone-CallStateStore.dirty.<ts>.diff`. Action
  needed: review the diff, port any genuine fix into a real commit on a
  branch, deploy through the queue, and discard the in-clone version.
  Until then, treat any deploy whose change-set touches
  `CallStateStore.ts` as a tripwire — verify the commit landed by reading
  the file inside `app-telephony-1` after deploy.
  **2026-05-08:** real `api` + `worker` jobs shipping `55e9c20` still printed
  `M apps/telephony/src/telephony/state/CallStateStore.ts` in `git-sync` right
  after `HEAD is now at 55e9c20` — checkout succeeded, but the uncommitted
  telephony edit in the shared clone is still present; clean it up when it
  blocks a future checkout (see `AGENTS.md` / `DEBUGGING.md` deploy recovery).
- **`connect-dial-with-wake` wake-skip OR-bug** (open, latent — confirmed by
  reading the dialplan source on 2026-05-06; **NOT yet proven to have caused
  any specific failed test call**). In
  `scripts/pbx/install-connect-wake-dialplan.sh` the `[connect-dial-with-wake]`
  body computes `CONTACTS_PRIMARY = PJSIP_DIAL_CONTACTS(T<id>_<ext>)` (desktop
  AOR) and `CONTACTS_SECONDARY = PJSIP_DIAL_CONTACTS(T<id>_<ext>_1)` (mobile
  AOR), then
  `GotoIf(LEN(CONTACTS_PRIMARY)>0 || LEN(CONTACTS_SECONDARY)>0 ?dial_now)`. The
  intent is "skip wake when the mobile is already registered". The bug is the
  OR: when the desktop is registered but the mobile is killed, the probe still
  jumps to `dial_now` and the wake POST is never made. **Caveat / scope:** this
  context **only fires for Connect-managed DIDs** (DIDs with a
  `connect/didmap/<e164>/tenant=<slug>` entry whose `connect/t_<slug>/pbx_tenant_id`
  is set). On the live PBX as of 2026-05-06 this means **only** DID
  `8455577768` → `landau_home` (`pbx_tenant_id=21`); every other inbound DID is
  handled by VitalPBX-native dialplan and never enters
  `connect-dial-with-wake`. Smallest fix is one line:
  `GotoIf($[${LEN(${CONTACTS_SECONDARY})} > 0]?dial_now)`. Roll out via
  the deploy queue (`service: api` + PBX dialplan re-install through the
  helper); do **not** hand-SSH the PBX. Do not delete the PRIMARY computation
  — keep it for logging so we can see desktop registrations in
  `/var/log/asterisk/full`. **Before fixing, prove via `/var/log/asterisk/full`
  that a real failed-call instance hit this branch** — PBX-read alone cannot
  prove that.
- **Tenant-mapping precondition for `connect-dial-with-wake`.** This entire
  context only runs when the inbound DID's tenant is wired to the **same**
  PBX tenant the mobile is registered under. AstDB needs both
  `connect/didmap/<e164>/tenant=<slug>` and `connect/t_<slug>/pbx_tenant_id=<id>`,
  and the mobile must register as `T<id>_<ext>_1`. If those don't agree, the
  IVR direct-dial path resolves `T<wrongId>_cos-all,<ext>,1` and silently
  fails. As of 2026-05-06 only `landau_home` has any `pbx_tenant_id` entry —
  any test mobile signed in to a different tenant cannot be reached by an
  IVR direct-dial through that DID, regardless of FCM / wake / native code.
  When triaging "mobile didn't ring on external call", **first** confirm
  the DID's `connect/didmap/<e164>/tenant` resolves to the same tenant whose
  `t_<slug>/pbx_tenant_id` matches the mobile's `T<id>_<ext>_1`. PBX-read
  commands sufficient: `asterisk -rx "database show connect"` +
  `asterisk -rx "pjsip show endpoints"`.
- **Most external DIDs on the live PBX are NOT Connect-managed.** Only DIDs
  with a `connect/didmap/<e164>/tenant=<slug>` AstDB entry enter the
  `connect-tenant-router` / `connect-tenant-ivr` / `connect-dial-with-wake`
  pipeline. Every other DID is routed entirely by VitalPBX-native logic
  (`from-pstn` → built-in inbound route → IVR / ring group / extension)
  and **never invokes the FCM-wake mechanism**. So if a killed mobile
  doesn't ring on an external call, the **first** question is: is that DID
  actually wired into Connect? If not, the failure is just plain
  "PJSIP_DIAL on an AOR with no live mobile contact" — there is no wake to
  fire. Diagnostic: `asterisk -rx "database show connect"` then look for
  the dialed E.164 (and its non-`+` alias) under `connect/didmap/`.
- **PBX-read cannot identify which DID was just called.** The
  `pbx_audit` allowlist exposes only live-state snapshots
  (`pjsip show contacts/endpoints`, `core show channels concise`,
  `database show connect`, fixed dialplan dumps) plus the helper's own HTTP
  access log and a fixed `mysql ombutel` SELECT. There is no path to
  `/var/log/asterisk/full`, no AMI tail, no `cdr show`, no general MySQL
  query. For per-call forensics, escalate to either (a) the privileged
  PBX session that can read `/var/log/asterisk/full`, or (b) VitalPBX's own
  `/api/v2/cdr` endpoint (already used by Connect's CDR sync cycle), which
  is tenant-scoped and read-only without exposing audio or auth secrets.
- **Native `KeepAliveRestartReceiver.kt` + `MainApplication.kt`.** Custom
  Android keep-alive logic. UNKNOWN current state of doze-mode handling — verify with
  logcat before touching.
- **iOS APNs VoIP push** via `react-native-voip-push-notification`. UNKNOWN current
  certificate state and entitlement status. Verify with EAS build configuration.
- **`require(uninstalled-package)` → `Requiring unknown module "undefined"` fatal crash
  (FIXED 2026-05-07, commit after `1539cda`).** When a `require("some-pkg")` call
  references a package not present in `node_modules`, Metro does not error the build
  — it silently substitutes `undefined` for the module ID. The Hermes runtime then
  executes `metroRequire(undefined)`, which is a fatal regardless of any `try/catch`
  wrapper. Expo's error-recovery thread reports it as
  `FATAL EXCEPTION: expo-updates-error-recovery` /
  `com.facebook.react.common.JavascriptException: Error: Requiring unknown module "undefined"`.
  This pattern has now crashed the APK **twice** from two separate files:
    1. `NotificationsContext.tsx` — `require("@react-native-community/netinfo")` on answer
       tap (fixed earlier; a comment at ~line 2013 documents the removal).
    2. `SipContext.tsx` — `require("@react-native-community/netinfo")` inside the Stage 1
       NetInfo connectivity-regain `useEffect` (introduced in `e070c03`, first shipped in
       the `1539cda` APK build, fixed by removing the entire useEffect block).
  **`@react-native-community/netinfo` is NOT installed in `apps/mobile/package.json`.**
  Do NOT add a `require()` or `import` for it anywhere without first adding it as a
  dependency AND running a native-linked prebuild (it has a native Android/iOS bridge).
  The SIP reconnect stack falls back to the 30-second keep-alive health check and the
  exponential-backoff orchestrator in `SipContext.tsx` — no reconnect capability is lost.
- **CallKeep + Telecom flicker on remote cancel.** Comment in `NotificationsContext.tsx`
  documents that dynamic `import("../audio/telephonyAudio")` in teardown paths threw
  `Object is not a function` and short-circuited `moveAppToBackground`. Static
  import is required — do not move it back to dynamic.
- **Push wake → dialplan timing.** Documented under `docs/pbx/connect-push-wake-T25.md`.
  Timeouts and AstDB `connect/system` keys are tuned. Don't change them blindly.
- **Voicemail greeting recording flow.** Recently changed:
  `apps/mobile/src/voicemail/vmGreetingInviteUtils.ts`,
  `vmGreetingWakeBridge.ts`, plus API `vmRecordCallJobs.ts`. Treat as fragile.
  - **Phase A (2026-05-07) — mobile wake gate relaxed. DEPLOYED.**
    Commit `f910e6d` shipped via deploy queue job
    `ad842f0e-721f-45b8-afe2-5976ce710673`; running API container
    confirmed to contain the new wake-decision strings and the
    `active: true` filter removed. Call-to-Record used to skip the
    mobile wake push whenever a PJSIP contact for `T<tenant>_<ext>*`
    was Avail and only included `MobileDevice` rows with `active=true`.
    Both gates suppressed mobile fan-out in the common case where a
    desktop WebRTC session shared the same authUsername (e.g. `T21_101_1`)
    as the mobile app. The decision now lives in `decideVmRecordWake`
    (pure helper in `vmRecordCallHelpers.ts`) and sends the wake whenever
    the user has at least one `MobileDevice` row. The pre-wake AOR-Avail
    signal is preserved as a diagnostic only. See
    `vmRecordCallJobs.ts::runVmRecordCallJob` log lines
    `vm-record-call: mobile wake decision` / `mobile wake push sent` /
    `mobile wake registration outcome`.
  - **Phase A.5 (2026-05-07) — second `active: true` filter removed
    via opt-in flag.** Production verification of Phase A surfaced a
    second `active: true` filter inside `sendPushToUserDevices`
    (`apps/api/src/server.ts:2544`) that fired AFTER Phase A's
    decision passed. Job `90b4a38d-aadb-4d51-97ff-6e07f6fdbb0e`
    logged `decision: "send_wake", deviceRowCount: 7,
    activeDeviceCount: 0, devicesNotified: 0` — the wake decision
    was right, but FCM dispatch returned 0. Phase A.5 adds an
    opt-in `includeInactiveDevices?: boolean` parameter to
    `sendPushToUserDevices` (default `false`, preserves all 9 other
    call-sites' active-only semantics) and routes vm-record's wake
    push through `buildVmRecordWakePushInput` (in
    `vmRecordCallHelpers.ts`) which always sets the flag to `true`.
    A new `mobile-push: device fan-out` log line records
    `totalRowsFound`, `activeRowsCount`, `rowsMissingToken`,
    `afterExclude`, `includeInactiveDevices` per dispatch.
  - **Phase B (2026-05-07) — dispatch-only originate + post-answer
    Gosub.** The `direct_pjsip:` channel-source override in the PBX
    helper (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`,
    formerly lines 950–967) was deleted: every vm-record originate
    now flows through `Local/<recording_exten>@connect-vm-greeting-dispatch/n`,
    which dials the AstDB-driven fan-out string `PJSIP/T<tenant>_<ext>&PJSIP/T<tenant>_<ext>_<n>`
    so hardphone + WebRTC + mobile ring in parallel. The
    prompt-before-answer race is fixed inside the dialplan: dispatch
    uses `Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${tenant}^${ext}^${file}))`,
    and the new `[connect-vm-greeting-record-sub]` context runs the
    recording flow as a Gosub on the answered party's channel only
    AFTER pickup. Legacy `[connect-vm-greeting-record]` context is
    retained for back-compat. Helper VERSION bumped to
    `2026.05.07.1`. The API logs a structured warn line
    `vm-record-call: helper returned direct_pjsip channelSource`
    if it ever sees the old path again — purely a regression
    detector. Originating CallerID is now
    `Voicemail Greeting Recording <${ext}>` instead of
    `anonymous@anonymous.invalid`.
  - **Phase C (2026-05-07) — voicemail context path fix. DEPLOYED via
    installer re-run.**
    Root cause: VitalPBX names each tenant's voicemail context after the
    tenant slug (e.g. `test-voicemail`), not the numeric tenant id (`21`).
    The helper's `voicemail_mailbox_dir` used to guess `<numeric>/<ext>`
    first, creating and writing to the wrong directory
    (`/var/spool/asterisk/voicemail/21/101/`). `VoiceMail()` reads from
    `/var/spool/asterisk/voicemail/test-voicemail/101/` — so the custom
    greeting was silently ignored.
    Fix: new `resolve_voicemail_context_from_conf(tenant_id, extension)`
    reads `/etc/asterisk/vitalpbx/voicemail__50-<N>-main.conf` at request
    time to find the real context; `voicemail_mailbox_dir` uses that as
    `candidates[0]` (falls back to numeric/T-prefix/default for tenants
    whose conf file cannot be read). `vm_record_call` also stores the
    resolved context in AstDB key `connect_vm_context/T<tenant>_<ext>`
    before originating; the dispatch dialplan reads it and passes it as
    `ARG1` to `connect-vm-greeting-record-sub`; both `CONNECT_VM_PATH`
    and `CONNECT_VM_TMP` now use `${CONNECT_VM_CONTEXT}/...` instead of
    `${CONNECT_VM_TENANT}/...`. Legacy `[connect-vm-greeting-record]`
    context also does the same AstDB lookup + numeric fallback.
    Helper VERSION bumped to `2026.05.07.2`.
    Verify: `asterisk -rx "database show connect_vm_context"` → shows
    `T21_101 = test-voicemail`; after recording,
    `ls /var/spool/asterisk/voicemail/test-voicemail/101/unavail.wav`
    should exist with a recent mtime.
  - **Phase D (2026-05-07) — disabled Telecom dispatch. SUPERSEDED by Phase 1.**
    Phase D disabled `TelecomBridge.startIncomingCall()` via an `if (false)`
    guard to remove the Samsung native phone UI race condition (see root cause
    below). This created a regression: the FSI/CallStyle-only path requires
    `USE_FULL_SCREEN_INTENT` runtime permission and is blocked by Android 14/15+
    OEM battery/power managers. Incoming calls on Samsung / killed app showed
    no visual UI on lock or home screen. Phase D was the correct diagnosis of
    the *answer* race but the wrong fix (removing Telecom entirely).
  - **Phase E (vm-record synthetic invite claim — 2026-05-08). DEPLOYED.**
    Root cause: when the mobile taps Answer on a vm-record IncomingCallScreen the
    answer pipeline calls `POST /mobile/call-invites/:id/respond` with the synthetic
    `vmr-<jobId>` invite ID. No `callInvite` DB row exists for `vmr-*` by design
    (see `vmRecordCallJobs.ts` comment at line 485). The `/respond` handler returned
    `{ ok: false, code: "INVITE_ALREADY_HANDLED", status: "UNKNOWN" }` for any
    not-found invite. `NotificationsContext.tsx` treats that as a backend rejection
    and calls `sip.hangup()`, immediately disconnecting the SIP call before the
    recording IVR could bridge.
    Fix: in `server.ts` `/respond` handler (after the DB lookup), if `existing` is
    null AND `isSyntheticVmrInviteId(id)` is true AND `action === "ACCEPT"`, return
    `{ ok: true, code: "INVITE_CLAIMED_OK" }`. This lets the mobile answer pipeline
    proceed to bridge the SIP session with the recording IVR.
    `isSyntheticVmrInviteId` is a pure helper exported from `vmRecordCallHelpers.ts`,
    covered by 6 unit tests. All other `/respond` behavior (normal callInvite lookup,
    DECLINE handling, rate-limit, TURN/media gates) is unchanged.
    Verify: trigger Call-to-Record, tap Answer on mobile — call should stay connected
    past 2 s; user hears recording prompt or beep; `sizeBytes > 0` after save.
  - **Phase 1 (2026-05-07) — Telecom re-enabled, answer race fixed. IMPLEMENTED,
    NOT YET DEPLOYED.**
    Root cause of the original Phase D answer failure: `ConnectIncomingConnection
    .onAnswer()` called `setActive()` immediately, before the SIP session
    existed. This showed an OS in-call timer with no audio on Samsung and timed
    out when `jssip.answerIncoming()` polled for a session that hadn't arrived.
    **Fix — three changes:**
    1. `ConnectIncomingConnection.onAnswer()`: `setActive()` removed entirely.
       A 15 s safety watchdog is armed instead; it terminates the Connection
       if JS never confirms the answer result.
    2. `ConnectIncomingConnection.markActive()`: now the ONLY path to
       `setActive()`. Called by JS via `NativeModules.IncomingCallUi
       .telecomMarkActive(inviteId)` after `sip.answerIncomingInvite()` succeeds.
    3. `NotificationsContext.tsx Telecom.Answer handler`: cold-start invite
       resolution retry extended from 250 ms (too short) to a 4 s polling loop
       (200 ms intervals). After `handleAcceptInvite()` resolves successfully,
       `markTelecomActive(inviteId)` is called to trigger `setActive()`.
       On failure/exception, `terminateTelecomCall(inviteId, "other")` cleans
       up the Connection.
    `IncomingCallFirebaseService.handleIncomingCallNative()` now attempts
    Telecom dispatch for all non-foregrounded states (`!appInForeground`).
    Falls back transparently to the FSI/CallStyle path if the PhoneAccount
    is not enabled or `addNewIncomingCall()` throws.
    **Known Phase 1 tradeoff:** on Samsung One UI, both the Samsung native phone
    call UI and the Connect CallStyle notification appear simultaneously. Both
    surfaces now correctly connect the SIP call. Phase 2 will add
    Samsung-path awareness to suppress the duplicate.
    Verify: `adb logcat | grep CALL_INCOMING` shows `telecom_dispatch result=true`
    → user taps Answer on Samsung native UI → `[TELECOM] onAnswer` in JS →
    4 s invite poll → `[ANSWER_PIPELINE] SIP_200OK_SENT` → `markTelecomActive`
    → `[ConnectIncomingConn] markActive` → OS shows in-call timer.
  - **Open: Phase E (browser Answer button).** Desktop WebRTC rings
    but `session.answer()` never emits a SIP `200 OK` — the browser
    sends `480 Temporarily Unavailable` ~22s later. SIP-over-WSS
    capture is on file; root cause is in the portal's `useSipPhone`
    answer path, not in the API or PBX. See agent transcript
    [Call-to-record fan-out + answer](dd85d75d-082c-49b1-90b2-2da51add268d).
- **Mobile invite multi-call race** — migration `20260419200000_call_invite_multi_call`
  exists; UNKNOWN current bug history. Read the migration before touching `CallInvite`.
- **Bluetooth audio yanked to earpiece on call connect — FIXED 2026-05-06
  (commit `1539cda`).** Root cause was an unconditional
  `ICM.routeToEarpiece()` 150 ms after the SIP `confirmed` event in
  `JsSipClient.bindSession`, plus the same call inside `answer()`. Both
  ignored Bluetooth/wired headsets. Replaced with
  `apps/mobile/src/audio/audioRouteManager.ts` — central manager, priority
  user-override > BT > wired > earpiece, speaker never auto-selected.
  **Do not re-add direct route-to-earpiece calls anywhere in the SIP
  client; route every decision through `audioRouteManager`.** Verify with
  `adb logcat | grep audio_route` — every connect should log
  `selected route=bluetooth reason=call_connected` when a BT headset is
  paired.
- **Phone contacts import — added 2026-05-06.** No background scraping.
  Permission only on explicit user tap. Server-side `POST
  /contacts/import` is still a 501 stub; the import path falls back to
  per-contact `POST /contacts` and treats `409 duplicate_phone` as
  "merged". If a real `/contacts/import` endpoint is added later, swap
  the fallback in `phoneContactsImport.ts::importContacts`.
  - **Permission request timing fix (2026-05-07).** On Android 12+, calling
    `requestPermissionsAsync()` from inside a React Native `Modal`'s `useEffect`
    can silently fail (gesture window has expired). Fix: `ContactTab` now calls
    `checkContactsPermission()` + `requestContactsPermission()` directly inside
    the import button's `onPress` handler (active gesture context), then passes
    the resolved status to `ImportPhoneContactsModal` via the `initialPermission`
    prop. The modal's `boot()` uses that value instead of re-checking async.
- **SMS chat back navigation — fixed 2026-05-07.** `ChatTab` is a bottom tab
  screen. Android hardware back button went to the previous tab (Team) instead
  of closing the open thread. Fix: `ChatTab` registers a `BackHandler` when
  `activeThread !== null` that calls `setActiveThread(null)` and returns `true`.
- **Missed call notifications — fixed 2026-05-07 (native, v2).** The API sends
  `MISSED_CALL` as a data-only FCM push (so `IncomingCallFirebaseService` can
  stop the ringtone). Data-only pushes never reach Expo's JS
  `addNotificationReceivedListener`, so the earlier
  `NotificationsContext.scheduleNotificationAsync` branch was unreachable. Fix
  (v2): `IncomingCallFirebaseService.handleCallTerminationNative()` now calls
  `postMissedCallNotification()` when `type == "MISSED_CALL"`, which posts a
  native Android notification via `NotificationManagerCompat` on channel
  `connect-missed-calls` (ID range 52000–61000). Tapping opens `MainActivity`
  with `notificationType=missed_call`.
- **vm-record mobile ring — fixed 2026-05-07.** The telephony pipeline sees the
  vm-record originating channel as `Local/...@connect-vm-greeting-dispatch`
  (`tenant_UNRESOLVED`) and does not create a `CallInvite` or send an
  `INCOMING_CALL` push. Fix: `vmRecordCallJobs.ts` now sends a synthetic
  `INCOMING_CALL` push (inviteId `vmr-<jobId>`, `fromDisplay: "Voicemail
  Greeting Recording"`) to active mobile devices immediately before
  `requestPbxVoicemailGreetingRecordCall`. JsSIP's single-session fallback in
  `findIncoming()` maps the Answer tap to the live SIP session without requiring
  an `X-Connect-Invite-ID` header.

## WebRTC / SIP

- **TURN/STUN configuration.** Telephony env validates `PBX_WS_ENDPOINT`. Without
  TURN, audio fails behind strict NAT. Worker maintenance cycles (`runTurnValidationMaintenanceCycle`,
  `runMediaReliabilityMaintenanceCycle`) flag tenants as STALE/PASSED.
- **SBC LOCAL vs REMOTE switching.** `apps/api`'s `/voice/sbc/status` exposes the
  active upstream. UNKNOWN current production mode; do not flip without coordination.
- **WSS endpoint URL hardcoded default.** `wss://209.145.60.79:8089/ws`. If the PBX
  IP changes, multiple env files need updating.

## Dashboard KPIs

- **"Today" window timezone alignment.** Documented in
  `docs/DASHBOARD_KPI_SOURCE.md`. Without `PBX_TIMEZONE`, KPIs return zero in
  evening UTC. Default `America/New_York`. Don't remove.
- **`missed` was overcounted before** — only inbound non-answered calls count.
  Don't regress that definition.
- **Two truth sources.** KPI cards = VitalPBX `/api/v2/cdr`, live table = `connectCdr`
  rows. Keep both in mind.

## Voicemail / recordings

- **Voicemail upsert key drift risk.** Worker uses `pbxMessageId` (preferring
  VitalPBX `msg_id`); a future API shape change could break dedupe. The
  `runVoicemailSyncCycle` function defensively reads multiple aliases — keep that.
- **Silent ingestion stall: AMI `MessageWaiting` vs empty `voicemail_records`.**
  Primary ingestion still uses VitalPBX REST `GET /api/v2/extensions/:extensionId/voicemail_records`
  (same in `/internal/voicemail-notify`). Asterisk can still fire AMI `MessageWaiting`
  and maintain mailbox audio on the PBX host while this endpoint returns **`200` with an
  empty `data` payload**. **Mitigation (Phase 1, 2026-05-08):** when REST returns no rows,
  api/worker call the on-PBX helper `POST /voicemail/spool/list` (read-only directory scan)
  if `PBX_ROUTE_HELPER_BASE_URL` + secret are configured; notify path also requires AMI
  `newCount > 0`. Dedupe remains `pbxMessageId`. Symptom if **unmitigated** or helper
  offline: worker JSON logs `rest_count` high / `helper_calls:0`; API `voicemail-notify`
  with `upserted:0`; no new `Voicemail` rows. **Do not infer** from an empty REST response
  that extensions were deleted — verify AMI mailbox/context, disk under
  `/var/spool/asterisk/voicemail/<context>/<ext>/`, REST with **`tenant` header**
  (`TELEPHONY.md` § Voicemail), and helper `VERSION` / `mailboxPath` JSON. Root causes for
  REST divergence often live in VitalPBX; spool fallback is a **safety net**, not a
  guarantee of playback (`pbxRecfile` may still be empty until REST recovers).
- **Connect vs PBX helper version skew.** Shipping api/worker that call
  `POST /voicemail/spool/list` while the PBX helper is still on **`2026.05.07.x`**
  yields HTTP **404** / `not_found` from the helper. Symptoms: `fallback_reason` like
  `helper_error:not_found` on `/internal/voicemail-notify`, worker `helper_calls:0`.
  Re-run **`install-vitalpbx-inbound-route-helper.sh`** from the **pinned git commit**
  (**`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`**) only — **never** hand-edit
  `/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py`; confirm
  `GET …:8757/health` → **`2026.05.08.1`**+ (`DEPLOYMENT.md` production check-in).
  Step-by-step fix for the **`209.145.60.79`** mismatch: **`DEPLOYMENT.md`** § **Phase 1 — operator handoff**. Automated “agent execution” from Cursor without PBX/app-host access will not apply the fix; after a human runs it, use the strict **paste-back transcript** (**`DEPLOYMENT.md`** Phase 1 **operator execution transcript**) so evidence (job IDs, `done` SHAs, log fields) is reviewable without leaking secrets.
- **Voicemail ingest incidents (super-admin v1).** `VoicemailIngestIncident` rows summarize thresholded stalls (notify **upsert=0**, worker **global zero** sync, helper **404/401** immediate, unreachable debounced, REST vs spool divergence). They are **not** a substitute for log forensics — multi-instance api could theoretically skew rare counters until a v2 event table exists. Tenant admins are **not** notified in v1.
- **Incomplete Phase 1 evidence.** Claiming “helper fallback works” without the **operator execution transcript** (or equivalent) risks hidden **BASE_URL** skew, unstaged **api/worker** env, or **deploy log SHA** mismatch (`AGENTS.md`). Treat missing queue **`done <sha>`** lines as **not verified**.
- **`PBX_ROUTE_HELPER_BASE_URL` points at the wrong host.** Connect will happily call
  **`http://<ip>:8757`** on a machine that still runs **`2026.05.07.x`** while operators upgrade a
  **different** VitalPBX (MOTD / SSH IP mismatch). Symptom: persistent **`helper_error:not_found`** after
  “we upgraded the helper.” Fix: `curl /health` from the **app** host to the URL in env; upgrade **that**
  host; or change **BASE_URL** to the upgraded host and redeploy **api** + **worker** (`DEPLOYMENT.md` A′).
- **Helper `2026.05.08.1` on loopback but app host `Connection refused`.** The service may be listening
  only on **`127.0.0.1:8757`** (installer default). Connect uses **`PBX_ROUTE_HELPER_BASE_URL`** from
  another host, so TCP never connects. Fix **`CONNECT_PBX_HELPER_BIND`** in **`/etc/connect-pbx-helper.env`**
  (**`0.0.0.0`** or NIC IP), restart **`connect-pbx-helper`**, allow **:8757** from the app host
  (`DEPLOYMENT.md` § listen bind). **Not** a Python patch.
- **Exposed `CONNECT_PBX_HELPER_SECRET`.** If the PBX helper secret appears in a screenshot,
  ticket, or chat, assume compromise. Rotate **`CONNECT_PBX_HELPER_SECRET`** in
  **`/etc/connect-pbx-helper.env`**, set the same value in Connect **`PBX_ROUTE_HELPER_SECRET`**
  (and per-instance helper JSON if used), **`systemctl restart connect-pbx-helper`**, then
  restart **api** and **worker** via approved process (`DEPLOYMENT.md` § compromised secret).
- **Spool fallback vs playback.** Phase 1 ingestion can create/update rows from disk
  metadata while `pbxRecfile` stays empty if the helper did not derive a usable file
  URL; `GET /voice/voicemail/:id/stream` may still 503 until REST returns `recfile` or
  a later Phase implements streaming from spool. Not a regression of list ingestion, but
  user-visible playback can remain broken until VitalPBX REST or playback fallback catches up.
- **Playback / `src_unsupported` (mobile) and 503 (API).** List/stale rows still
  show in UI if created before the stall. `GET /voice/voicemail/:id/stream` loads audio
  via `streamVoicemailAudio` (`apps/api/src/server.ts`): it follows `pbxRecfile` (often
  a VitalPBX `/static/...` URL) or refreshes metadata via `getExtensionVoicemailRecords`.
  If that refresh returns no rows, or the static URL is expired/404, the handler returns
  **`503` JSON** (`audio_unavailable`, `audio_fetch_failed`) — not audio bytes. Clients
  using `expo-av` `loadAsync({ uri })` then fail decoding (users may see a generic playback
  error). Fix ingestion or refresh `pbxRecfile`; do not assume the mobile player is the
  primary fault.
- **Recording playback path.** Streamed via API. UNKNOWN current expiry of signed
  URLs; verify before changing.
- **Recording file presence on PBX.** Documented as fragile in
  `scripts/pbx/patch-dialplan-file-presence.sh` — UNKNOWN current production state.

## Tenant isolation

- **`pbxTenantId="1"` is the global / system tenant** in VitalPBX (shared MOH
  classes etc.). Worker MOH/IVR cycles include `pbxTenantId: "1"` as a fallback.
  Confusing this with a real customer tenant has caused bugs.
- **Slug normalization** is `name.toLowerCase().replace(/[^a-z0-9]+/g, "_")`. Two
  tenants with names that collapse to the same slug would conflict. UNKNOWN whether
  any tenant pair is at risk — verify with a `Tenant.findMany` audit.
- **Mixed-case email duplication.** `scripts/ops/_audit-mixed-case-emails.sh` and
  `_fix-mixed-case-emails.sh` exist — there's a known data-cleanup task here.
- **Null-tenant rows.** `scripts/null-tenant-audit.sh`, `scripts/audit-null-tenant-rows.sh`
  — there's been a history of rows with `tenantId=null` that should not exist.

## Deployment

- **Deploy queue is the only path.** See `AGENTS.md` and `docs/safe-deploy-queue.md`.
  Manual deploys are explicitly forbidden.
- **`api` is the ONLY service that runs migrations.** A migration file checked in
  but not deployed via `api` will silently miss production.
- **`docker-compose.app.yml` `command:` line for `api` runs Prisma generate +
  migrate every container start.** UNKNOWN whether this assumption holds across all
  deploy scripts — verify in `scripts/deploy-api.sh`.
- **Volumes `moh-assets`, `ivr-prompts`, `chat-attachments`** must persist. Renaming
  drops customer media.
- **`/opt/connectcomms/downloads` mounted read-only into the api container** for
  Android APK distribution. Don't change to RW.

## Database

- **80+ migrations under `packages/db/prisma/migrations/`.** Some recent ones
  touch heavily-used tables: `voicemail`, `mohScheduling`, `ivrOptionRoutes`,
  `tenantPbxPrompt`, `mobileDeviceCallWakeDiagnostics`, `chatAttachmentMediaMetadata`.
  Read the migration before extending the table.
- **Two CDR tables**: `callRecord` (legacy) and `connectCdr` (authoritative). Worker
  writes both for missed/canceled invites. Don't remove either without coordinated
  reads update.
- **Encrypted columns** (`apiAuthEncrypted`, `credentialsEncrypted`,
  `tokenEncrypted`) require `CREDENTIALS_MASTER_KEY`. Schema changes that move/copy
  these need careful re-encryption logic.
- **`PbxJob`, `TenantPbxLink`, `PbxInstance`** drive provisioning. Their state
  machine (`status: LINKED|ERROR|...`, `pbxJob.status: QUEUED|RUNNING|FAILED|COMPLETED`)
  is tied to worker cycles. Mutating without the worker is risky.

## Realtime / websockets

- **Two WS services exist**: `wss://…/ws` (`apps/realtime`) and `wss://…/ws/telephony`
  (`apps/telephony`). They have different auth and contracts. Don't conflate.
- **`apps/realtime` is currently minimal.** UNKNOWN which features depend on it
  — verify before changing or removing.
- **Telephony WS does NOT push periodic full snapshots.** Initial snapshot only,
  then upsert/remove deltas. See note in `apps/telephony/src/telephony/index.ts`.
  Anyone re-enabling periodic full snapshots reintroduces the ringing-flicker bug.
- **WS keepalive** comes from nginx `proxy_read_timeout 86400s` (`docs/TELEPHONY_NGINX.md`).
  Do not lower without testing 24-hour persistence.

## Mobile — SMS / messaging push notifications

- **VoIP.ms inbound SMS arrives via worker poll, not webhook.**
  The VoIP.ms webhook (`POST /webhooks/voipms/sms`) receives only template
  placeholder pings (`{FROM}`, `{TO}` etc.) — not real messages. Real inbound
  SMS is delivered by the worker's `voipMsInboundSyncJob.ts` polling cycle
  (`status: "routed_poll"` in `SmsRoutingLog`).
- **Fixed 2026-05-08**: The worker poll path never called `sendPushToUserDevices`.
  Push fan-out is now in `importInboundMessage()` via a `sendSmsPush` callback
  injected from `main.ts`. Look for `event: "voipms_inbound_sms_push_sent"` in
  worker logs to confirm.
- **SMS push uses FCM notification message** (includes `title`/`body`/`channelId`),
  not data-only. This ensures Android displays the notification directly even when
  the app is swiped away, without relying on `onMessageReceived` being woken.
- **Webhook `sms_message` fan-out in API** (`connectChatRoutes.ts`) remains as-is
  for the unlikely case VoIP.ms ever switches to real webhook delivery. The two
  paths produce the same push payload shape.

## Build / repo hygiene

- **Many leftover `_check-*` / `_diag-*` / `pbx-*.txt` files at repo root.** They
  are diagnostic artifacts checked in by accident. Don't extend that pattern; if
  you must, drop them under `_latency_logs/` or `docs/audit/`.
- **`apps/desktop/release/win-unpacked/...` is bundled output**, not source.
- **`logcat-cancel.txt`, `trace*.txt`, `_app-api-last40m.log`,
  `_adb-connect-vm-record-live.log`** are large diagnostic dumps. Don't load them
  unless directly relevant.
