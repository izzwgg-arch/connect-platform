# Notification reliability — root causes, evidence, and the permanent architecture

**Date:** 2026-07-29 · **Commits:** `e1568b99`, `6417d280`, `5dea3c1f` · **Author:** overnight agent session with Izzy

This document exists because voicemail / missed-call / SMS notifications died
repeatedly over months, were "fixed" repeatedly, and died again. Read this
BEFORE touching any notification code.

## Part 1 — The proven root causes (with evidence)

### 1. Voicemail alerts: tenant-name mismatch in the notify resolver
- **Evidence:** 30 new inbox voicemails across tenants in a 48h window with
  ZERO voicemail push fanouts in API logs; repeated
  `voicemail-notify: extension not resolved — skipping` with
  `context=gesheft-voicemail, reason=no_tenant_matches_voicemail_context`;
  direct query showed the old lookup (`tenantSlug = "gesheft-voicemail"`)
  matched nothing while the directory stored `gesheft`.
- **Mechanism:** Asterisk reports voicemail context `<slug>-voicemail`; the
  directory stores the bare slug. The context check only runs when a mailbox
  number exists on MULTIPLE tenants (ext 101 exists on 32). **This is why it
  "worked, then stopped":** every onboarded tenant duplicates previously
  unique extension numbers, killing their notifications; wiping test tenants
  resurrects them.
- **Fix:** resolver accepts both forms (`e1568b99`). Live-verified same night:
  first voicemail pushes in 48+ hours, three tenants, `PUSH_DELIVERED`.

### 2. Missed-call alerts: only the losing writer was allowed to notify
- **Evidence:** zero `missed_call` fanouts in logs while missed CDRs existed;
  Izzy's 9:06 AM test (562-209-6644 → Landau ext 101) produced invite
  CANCELED + CDR `missed` and **no callRecord row** — proving the cancel ran
  through `/internal/mobile-ring-notify`, which never recorded/alerted.
- **Mechanism:** three separate paths cancel a ringing invite (real-time
  ring-notify fast-path, pbx-event handler, worker poll/expiry). The ONLY
  alert sender was the CDR-ingest push, gated on being the FIRST ConnectCdr
  writer — but the invite paths always write first, and ingest's `toNumber`
  is the DID (e.g. 8455577768), not the extension, so its extension lookup
  fails anyway.
- **Fix:** the record writers themselves alert (`e1568b99`), including the
  ring-notify fast-path (`6417d280`), suppressed when the call was answered
  (telephony now sends `answered: extensionAnsweredAt != null`).

### 3. All alert types: live phone deactivated by receipt misattribution
- **Mechanism:** Expo tickets come back positionally for the messages SENT
  (`expoTargets`), but were indexed against the pre-direct-FCM device list
  (`filtered`). When direct FCM served the live phone, a dead ghost row's
  `DeviceNotRegistered` was blamed on the live phone's token →
  `active: false` → ALL alerts for that user silently stopped (fanout is
  active-only) until the app re-registered. Another "stops and comes back."
- **Fix:** tickets aligned to `expoTargets` (`e1568b99`).

### Why nobody noticed any of this
Every push send is wrapped in catch-and-ignore. A dead path produces no
errors, no alarms — just absence. The system could not distinguish "nothing
happened" from "we are broken."

## Part 2 — The permanent architecture (commit `5dea3c1f`)

Three layers, designed so notification death is either impossible or loud:

1. **`NotificationLedger` (exactly-once claims).** Every sender — all fast
   paths in api and worker, and the reconciler — must claim
   `(type, entityId, userId)` via `claimNotification()` (packages/db) BEFORE
   sending. The unique constraint arbitrates; exactly one sender wins.
   Racing senders and double alerts are structurally impossible. Fail-open:
   infra errors send anyway (a rare duplicate beats a dropped alert).

2. **Reconciler (worker, every 60s).** Re-derives alerts from the durable
   FACTS — new inbox `Voicemail` rows, `ConnectCdr` rows with disposition
   `missed`, inbound SMS `ConnectChatMessage` rows — and sends any alert
   with no ledger claim (2-minute grace so fast paths stay instant). Even if
   every fast path breaks in a future refactor, alerts flow within ~2 min.
   File: `apps/worker/src/notificationReconciler.ts`.

3. **Canary (worker, hourly).** Counts resolvable facts older than the sweep
   grace with NO ledger claim. Healthy = ZERO. Anything else → loud
   `[notification-canary] ALERT DELIVERY DEGRADED` error log + a
   `PUSH_CANARY_ALERT` audit row. Silent degradation becomes visible.

### Rules for future changes
- **Adding a new alert type or send site?** It MUST claim the ledger first,
  and should be added to the reconciler's fact sweep.
- **Never remove the reconciler or canary** because "the fast paths work" —
  that reasoning is exactly what broke this system for months.
- **Health check one-liners** (loopcom):
  - `docker logs app-worker-1 --since 2h | grep notification-canary`
  - `docker logs app-worker-1 --since 2h | grep notification-reconciler`
  - Ledger activity: `SELECT type, source, count(*) FROM "NotificationLedger" WHERE "sentAt" > now() - interval '1 day' GROUP BY 1,2;`
  - A high `reconciler` share means a fast path is broken — find it via its
    logs; users are still covered meanwhile.
- **Container logs only cover the container's lifetime** — deploys recreate
  containers; check `docker ps` uptime before trusting "no log lines in 48h."
