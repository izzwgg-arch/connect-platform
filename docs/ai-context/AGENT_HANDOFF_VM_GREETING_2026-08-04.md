# AGENT HANDOFF — Voicemail greeting: upload + Call-to-Record (2026-08-04)

**Status: VERIFIED WORKING by Izzy on 2026-08-04** — both paths (file upload and
Call-to-Record), tested on tenant **T21 "Landau Home"** (Connect tenant
`cmnlgryll000lp9paakiiyizj`), ext **101**, desktop app + Android simultaneously
ringing, greeting saved and verified on the PBX.

This engagement took a feature that "never worked" when built blind in May 2026
and fixed it with live PBX visibility. Three separate failure layers were found
**live**, one per test round. Read the invariants below before touching
`vmRecordCallJobs.ts`, `vmRecordCallHelpers.ts`, the vm-greeting dialplan in
`scripts/pbx/vitalpbx-inbound-route-helper.py`, or the ProfileMenu greeting
panel — every one of them is load-bearing and was proven by a failed live call.

## Architecture (all pieces verified live)

```
Portal side panel (apps/portal/components/ProfileMenu.tsx)
  → API routes (apps/api/src/server.ts ~18380–18960)
      /voicemail/greeting            GET status (helper fallback self-heals metadata)
      /voicemail/greeting/upload     ffmpeg → 8kHz mono WAV → helper upload
      /voicemail/greeting/reset      helper reset + local metadata rm
      /voicemail/greeting/record-call        creates async job
      /voicemail/greeting/record-call/:jobId poll (job map is IN-MEMORY)
  → vm-record job runner (apps/api/src/vmRecordCallJobs.ts)
  → PBX helper HTTP (apps/api/src/pbxInboundRouteHelperClient.ts,
      base URL + secret from PBX_ROUTE_HELPER_BASE_URL / PBX_ROUTE_HELPER_SECRET)
  → helper on PBX (/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py,
      service connect-pbx-helper, v2026.08.04.2, byte-identical to repo copy)
      /voicemail/greeting/{get,upload,reset,record-call,record-call/<id>,diag}
  → dialplan drop-in /etc/asterisk/vitalpbx/extensions__95-connect-vm-greeting.conf
      [connect-vm-greeting-dispatch]  → Dial all live contacts, U(record-sub)
      [connect-vm-greeting-record-sub] → prompts/Record/press-1-save, runs ONLY
                                          on the answered channel
  → greeting file /var/spool/asterisk/voicemail/<vm-context>/<ext>/unavail.wav
```

- Tenant 21's voicemail context is literally **`test-voicemail`** (the tenant
  was created under the name "test"). The helper resolves contexts from the
  voicemail__50-*.conf files and caches per-call in AstDB `connect_vm_context`.
- Custom prompts live in `/var/lib/asterisk/sounds/custom/connect-vm-*.wav`,
  all 8 kHz 16-bit mono PCM (uploaded 2026-05-05; verified correct format).
- The API verify loop polls the helper every 3s (max 8 min) and declares
  `saved` when the greeting file's sha/mtime changes and is active.

## The three live-proven failure layers (one per test round)

### 1. The wake dance was slow AND broke answering (api commit `707820cb`)
Original flow on every Call-to-Record: push INCOMING_CALL_WAKE to every
MobileDevice row (user had 23 rows, 1 active → ~4.5s), wait up to 12s for a
fresh mobile registration, re-diag, then originate: **~22s click-to-ring**.
Worse: the wake made the Android app tear down and rebuild its SIP socket
mid-ring, so the INVITE sat on an orphaned socket — tapping Answer found no
session and spun on "answering" forever (voiceDiagEvent: SESSION_START 7s
after ring start, re-registers at +17s/+32s, no INCOMING_INVITE ever).

Fix — *instant-originate*: when the validated `callerSipEndpoint` from the
requesting client is in the pre-wake `pjsip show contacts` Avail list
(`callerEndpointIsAvail`), skip the wake push and the 12s wait entirely and
originate immediately. Wake fan-out (when it does run) is bounded to devices
with `lastSeenAt` ≤ 30 days (`STALE_DEVICE_WAKE_CUTOFF_MS`). The wake path
still exists as fallback when the caller's endpoint is NOT registered.

### 2. Dial-by-endpoint rang ONE device, not all (helper v2026.08.04.2, commit `1f216a80`)
`Dial(PJSIP/T21_101_1)` creates **one channel** even when the AOR holds
several registrations (max_contacts=3; desktop + Android + iPhone all share
the `_1` endpoint; hard phones use the base endpoint). Proven live: two Avail
contacts, one channel created, and it went to the one that couldn't ring.
This is the same trap as the PBX push-and-wait engagement's
`PJSIP_DIAL_CONTACTS resolves once` lesson, in a different costume.

Fix — the dispatch context now expands
`PJSIP_DIAL_CONTACTS(T<t>_<ext>)` + `PJSIP_DIAL_CONTACTS(T<t>_<ext>_1)` **at
the moment of the Dial** (the same mechanism VitalPBX uses for normal
extension calls), joins them with `&`, and falls back to the old AstDB
`connect_vm_dial` string only when both expand empty. Pre-ring Wait trimmed
2s → 1s. Deployed by scp + remote `py_compile` + `systemctl restart
connect-pbx-helper` (the helper rewrites the dialplan drop-in and reloads on
start when content changed). Rollback backups on the PBX:
`/root/helper-backup-20260804-141045.py`,
`/root/vm-dialplan-backup-20260804-141045.conf`.

### 3. ⛔ The Android ring screen is PUSH-DRIVEN (api commit `b6034b7b`) — NEVER remove the UI push
A bare SIP INVITE renders **no incoming-call UI on Android** — the app logs
`INCOMING_INVITE` and sits silent (proven: phone received the call at
14:25:24, PBX rang it 28s, screen showed nothing). The ring screen appears
only when the synthetic `INCOMING_CALL` push (inviteId `vmr-<jobId>`)
arrives. Layer-1's fix briefly suppressed that push and re-broke the feature.

Invariant: **skip only the WAKE push in the instant path; the INCOMING_CALL
UI push is sent for every mobile device on every path.** The `vmr-` invite is
synthetic — no CallInvite row exists; `/voice/invites/:id/respond`
short-circuits via `isSyntheticVmrInviteId` (do not remove), and the mobile
maps the answer tap to the live SIP session via the single-session fallback.

## Deployment state at handoff

- **api**: commit `b6034b7b` (deploy-queue job cb9367ed, success). Contains
  all three fixes' server halves.
- **portal**: commit `2f0850e7` build (includes the panel changes: debug
  readout hidden unless `localStorage.ecpVmDebug === "1"`; plain-language
  status labels only).
- **PBX helper**: v2026.08.04.2 at `/opt/connect-pbx-helper/`, byte-identical
  to `scripts/pbx/vitalpbx-inbound-route-helper.py` at `b6034b7b`. The
  installer `scripts/pbx/install-vitalpbx-inbound-route-helper.sh` embeds
  **two copies** of the dispatch dialplan — keep all three copies in sync
  (they were updated together in `1f216a80`).
- Deploys go through the queue: `POST http://127.0.0.1:3910/ops/deploy/enqueue`
  on loopcom with `x-deploy-queue-token` from
  `/opt/connectcomms/env/.env.deploy-queue`, body
  `{"service":"api","branch":"feat/ivr-migration-takeover"}`. One heavy job at
  a time — a concurrent job from another agent session (branch feat/ai-agent)
  blocked ours mid-engagement; that branch was already merged into ours.

## Forensics toolkit that cracked this (reuse it)

1. **voiceDiagEvent** (Postgres via `docker exec -i -w /app/packages/db
   app-api-1 node -`): the mobile/desktop apps log SESSION_START,
   SIP_REGISTER, INCOMING_INVITE, CALL_CONNECTED per session with platform +
   appVersion in the SESSION_START payload. This is what proved layers 1 and 3.
2. **Asterisk full log** on the PBX (read-only): `/var/log/asterisk/full` —
   the dispatch context execution shows the exact Dial string and one
   `Called PJSIP/...` line per leg. One leg where you expect two = layer 2.
3. **Helper journal**: `journalctl -u connect-pbx-helper` (rotates fast —
   ~1 day; the 2s spool/list polling floods it).
4. **API job logs**: `docker logs app-api-1 | grep vm-record-call` — wake
   decision (with `callerEndpointAvail`), push sends, registration outcome.
5. Support debug readout in the panel: `localStorage.ecpVmDebug = "1"`.

## Open hardening (none block the feature)

- `VOICEMAIL_GREETING_STORAGE_DIR` is unset → preview/metadata live in the
  container and are wiped every deploy. Self-heals from the PBX via the
  status/stream fallbacks, but should move to a compose volume like
  `app_ivr-prompts` (e.g. `/var/lib/connect/voicemail-greetings`).
- Upload got an nginx **408** on 2026-08-03 (slow client body, default 60s);
  retry succeeded. Consider `client_body_timeout` bump for the upload route.
- Helper `RECORD_JOBS` and the API job map are in-memory — a restart mid-job
  loses status (the phone call itself is unaffected).
- ElevenLabs AI-greeting route crashes on `tenant.slug` (field doesn't exist)
  — separate task was spawned for it (elevenLabsRoutes.ts:217).
- `scripts/pbx/install-vm-greeting-only.sh` (May-era standalone installer) is
  stale; the helper owns the dialplan now.
- A phone whose WSS socket is silently dead (Izzy's dual-WAN flap) still won't
  ring — nothing can ring a dead socket; the contact-expansion dials it and
  moves on. The wake-fallback path covers the fully-unregistered case.

## Re-test procedure (per tenant rollout)

1. Desktop app open, wait for the green **Available** pill (a just-restarted
   desktop is not registered yet — this voided one test round).
2. Panel → Call to Record. Expect ring on desktop AND phone within ~3–5s.
3. Answer either, prompts play, record, press **1**; panel flips through
   "Recording — press 1 on the call to save" → "Saved successfully".
4. Verify: call the extension from another phone, don't answer, hear the
   greeting. Upload path: pick a WAV/MP3 ≤8 MB, expect success + Play works.
