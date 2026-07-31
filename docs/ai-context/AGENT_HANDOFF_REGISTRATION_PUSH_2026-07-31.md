# AGENT HANDOFF — Mobile registration drops & the half-finished Expo→FCM migration (2026-07-30 → 07-31)

Written at the end of a session that started as "Luxure Management ext 101 didn't ring
again" and ended somewhere quite different. **Read this before touching the device
registration watchdog, push delivery, or any "calls don't ring" report.**

Owner context: Izzy does not read code. Every explanation to him must be plain English
(see memory `izzy-plain-english`). He is (rightly) frustrated that many rounds of
registration engineering have not made the phone ring. Do not promise another fix
before you have the evidence in this doc's §1 methodology.

---

## 0. TL;DR

- **The reported symptom is real and NOT fixed:** calls to Luxure Management ext 101
  still go to voicemail. As of 2026-07-31 08:32 EDT both `T5_101` and `T5_101_1` are
  `Unavailable` with 0 contacts.
- **The root cause is not registration code.** That extension's device has been
  offline ~85–90% of the time for at least 10 days. It is a device/provisioning
  problem, not a SIP problem.
- **What did ship** (deployed, verified live): detection → email alerting → automatic
  wake-push recovery. This is real and works on reachable devices, but it does not and
  cannot make an unreachable device ring.
- **The biggest open discovery:** the Expo→direct-FCM migration is **half done**. The
  worker still pushes everything (including real incoming-call rings) over the Expo
  relay, and 10 of 16 active Android devices have no native FCM token at all.

---

## 1. METHODOLOGY — the mistake this session made, do not repeat it

The first diagnosis was built from **one day** of data: a 3-hour gap was found, a story
about Android freezing the app was constructed, and fixes were prescribed for that
story. It was wrong.

**Before diagnosing any "extension doesn't ring" report, pull the longitudinal history
first.** One command:

```bash
ssh -i ~/.ssh/connect2_ed25519 root@45.14.194.179 'docker exec -i -w /app/packages/db app-api-1 node -e "
const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();
p.pbxEndpointRegistrationEvent.findMany({where:{endpoint:\"T5_101_1\",occurredAt:{gte:new Date(Date.now()-10*24*3600e3)},status:\"REGISTERED\"},orderBy:{occurredAt:\"asc\"},select:{occurredAt:true}}).then(r=>{
const t=r.map(x=>x.occurredAt.getTime());const f=d=>new Date(d).toLocaleString(\"en-US\",{timeZone:\"America/New_York\"});
console.log(\"REGISTERED events in 10d:\",t.length,\"(healthy ≈1200)\");
for(let i=1;i<t.length;i++){const g=t[i]-t[i-1];if(g>45*60e3)console.log(f(t[i-1]),\"->\",f(t[i]),\"DOWN\",Math.round(g/60000),\"min\");}
process.exit(0)})"'
```

A healthy device on a ~10-minute refresh produces ~1,200 REGISTERED events in 10 days.
**T5_101_1 produced 153.** Gaps included 47 hours straight (Jul 26 13:12 → Jul 28
12:37), 30 hours, 20 hours, and multiple multi-hour gaps **during business days**.

If the history shows chronic absence, stop. The problem is the device or the
extension's provisioning, and no amount of registration/keep-alive/wake engineering
will fix it.

---

## 2. What actually happened at Luxure (evidence)

Tenant **Luxure Management** = Connect `cmnlgryob001cp9pafjjqyc99`, VitalPBX tenant 5.
Ext 101 = **Simon Wertzberger**, owner user `cmnmjhp83007np96hmme5t38q`.

- **The extension has no reliably-powered device.** Its only two devices are a
  Samsung **Galaxy Tab S9 FE+ tablet** (`SM-X828U`) and a **Unihertz Jelly Star**
  (novelty mini-phone, last seen Jul 28). There is no desk phone — `T5_101` has had
  0 contacts throughout.
- 2026-07-30 incident: registered fine, dropped 11:21 EDT ("due to shutdown" = app
  socket closed), stayed down 3h13m, and the 14:34 inbound call failed
  `cause 3 - No route to destination` → caller heard "the person at extension 101 is
  unavailable" → voicemail. The wake register that followed took **27.2 s** and landed
  **7 s after** the call had already failed.
- 2026-07-31: dropped again at 02:42 EDT, contact expired 02:50, still down at 08:32.

### The wake test (2026-07-31 12:28 UTC) — the decisive experiment

A wake push was sent with **no phone call**, via `POST /internal/mobile-prewake`
(header `x-cdr-secret: $CDR_INGEST_SECRET`, run inside `app-api-1`). Result:

| Step | Outcome |
|---|---|
| Push channel | **direct FCM** (`FCM_DIRECT_DELIVERED`, `fcm_direct_ok`), both devices |
| Registration | **never** — PBX polled every 3 s for 302 s, no contact appeared |

Plus: the watchdog had already sent **63** wake pushes to this endpoint in 15 hours and
the device produced **zero** `DEVICE_PUSH_RECEIVED` acks — while 425 acks landed
fleet-wide in the same window.

**Conclusion:** the tablet is genuinely unreachable — powered off, off-network, or
force-stopped / in Samsung's "Deep sleeping apps" list. Android deliberately blocks FCM
delivery to a force-stopped app; **no server-side or app-side code can revive it.**
Only opening the app manually can.

> Note: "Deep sleeping apps" is a *separate* Samsung list from the battery-optimization
> whitelist. This device already had `batteryOptimizationIgnored: true` and still died.

### The fix that would actually make it ring

**Parallel-ring a real cell number on ext 101**, exactly like TrimPro (T11) ext 101 does
(`PJSIP/T11_101 & Local/8455546252@T11_cos-all`). Then the call rings the cell no matter
what the tablet is doing. **This is a PBX write and requires Izzy's explicit mandate** —
the PBX is read-only by hard guardrail. It has been proposed to him; he has not yet
answered. Better long-term: put the app on Simon's actual daily phone, or add a desk phone.

---

## 3. ⚠️ BIGGEST OPEN FINDING — the Expo→FCM migration is half done

`apps/api/src/fcmDirect.ts` (commit `4291fa3b`) was added specifically to bypass the
Expo relay, because — quoting its own header — on aggressive OEMs *"that relay is
deprioritized and pushes die between 'expo accepted' and the device."*

**That work landed in the API only.**

| | direct FCM | Expo relay | APNs |
|---|---|---|---|
| `apps/api` | ✅ yes, works | fallback | ✅ |
| `apps/worker` | ❌ **none at all** | ✅ everything | ✅ |

The worker sends `INCOMING_CALL`, `INCOMING_CALL_WAKE`, `INVITE_CANCELED`,
`missed_call`, `voicemail`, `sms_message` — **all over the relay**.

And even the API can only use direct FCM when the device reported a token:

```
ACTIVE ANDROID DEVICES: 16
  with nativeFcmToken (direct-FCM eligible):  6
  WITHOUT (fall back to Expo relay):         10      ← all report appVersion "1.0.0"
```

All 16 report the same `appVersion`, so the version string cannot distinguish them —
**find out why those 10 never reported a native token.** They are permanently on the
deprioritized channel for every incoming call. This may explain "calls don't ring"
reports well beyond Luxure and is, in this session's judgement, the highest-value
open thread on the whole board.

Related: `expo-notifications` the **library** is still legitimate and must stay —
`getDevicePushTokenAsync()` is *how the native FCM token is obtained*. Don't rip it out.
The thing to eliminate is `https://exp.host/--/api/v2/push/send`.

Verify current state:
```bash
grep -n "sendFcmDirectData" apps/worker/src/main.ts   # empty today = still unmigrated
grep -n "exp.host" apps/worker/src/main.ts            # lines 790, 2432
```

---

## 4. What shipped and is LIVE

**`cdd5bbdd`** on `feat/ai-agent` — api + worker **deployed and verified in production**.

- **Worker device-registration watchdog now recovers, not just alerts.** When a mobile
  endpoint sits unregistered >5 min while its owner has an active device, it sends the
  caller-less `INCOMING_CALL_WAKE` push (cooldown `DEVICE_REG_WAKE_COOLDOWN_SEC`,
  default 300 s per endpoint) and stamps `featureFlags.keepAliveRequired` on the
  affected Android devices. Logs `[DEVICE_REG_WATCHDOG]`, records
  `WATCHDOG_REREGISTER_PUSH_QUEUED` in `CallWakeEvent`.
  *Proven:* 5 endpoints woken on the first cycle; `T7_102_1` re-registered within seconds.
  **Caveat: these wakes ride the Expo relay** (see §3) — port them to direct FCM.
- **All alerts now email `tod10950@gmail.com`** (`ADMIN_ALERT_EMAIL`, tenant
  `connect-admin-tenant-v1`, via the `EmailJob` queue the API processes):
  DEVICE_REGISTRATION, VOICE_DIAG, media-gate, billing autopay, relay-collapse,
  media-test-failed, TURN-validation-failed, tenant-suspended. Per-key cooldown
  (`ADMIN_ALERT_EMAIL_COOLDOWN_MIN`, default 60).
  *Proven:* `[Connect Alert] Device not registered: T21_101_1 (Landau Home)` SENT 21:27Z.
- **Alert-spam bug fixed.** The DEVICE_REGISTRATION message used to embed a growing
  seconds counter, so the 30-min dedupe never matched and one outage created a row
  **every minute** (~190 rows for the Luxure outage). Message is now stable; duration
  moved to metadata.
- **`featureFlags` inheritance** falls back to `userId + model` when `deviceId` changed
  (`deviceId` is per-install in SecureStore and dies on reinstall — that is how the
  Luxure tablet silently lost its keep-alive latch).

**`20ca197b`** on `feat/expo-sdk54-upgrade` — mobile half. **NOT in any APK yet.**
Verified still in history as of `4b997245`.

- `featureFlags.ts` — server-set `keepAliveRequired` force-latches the adaptive
  keep-alive gate on every register.
- `jssip.ts` — a `forceRestart` (wake) register now aborts a stuck in-flight connect
  attempt instead of queueing behind it. **This is the 27.2 s fix**: the wake register
  had been inheriting two stacked 12 s connect watchdogs before its own attempt started.
- `headlessDeviceReport.ts` (new) — throttled (~5 min) `/mobile/devices/register`
  re-report from headless SIP paths, so `lastSeenAt` / `keepAliveSnapshot` stay fresh
  when the app runs with no React tree mounted. (Luxure's tablet was SIP-refreshing for
  3 hours after its `lastSeenAt` froze.)

**DB (done live):** deactivated 2 stale duplicate `MobileDevice` rows for the Luxure user
(they had 4 active rows for 2 physical devices).

---

## 5. Open items, highest value first

1. **Find why 10 of 16 active Android devices have no `nativeFcmToken`** (§3). Diagnosis
   before code. Likely explains ring failures fleet-wide.
2. **Port direct FCM into the worker.** It already imports from `apps/api/src` (billing),
   so importing `fcmDirect` is small. Moves real call rings, cancels, and the watchdog
   wakes off the relay.
3. **Luxure ext 101 parallel cell-forward** — needs Izzy's explicit PBX mandate (§2).
4. **Worker `sendPushToUserDevices` is missing the `active: true` filter** the API has
   (`buildMobileDevicePushWhere`). It currently pushes to deactivated rows — the Luxure
   user showed `queued=6` when only 2 devices were active.
5. **Make the alert email distinguish** "endpoint down but device is acking our wakes"
   (transient, self-heals) from "device has ignored N consecutive wakes" (dead — go
   physically touch it). Proposed to Izzy; he has not yet said yes.
6. *Low:* watchdog wake backoff. Currently 1 push / 5 min forever — `T8_101_1` took 164
   pushes in 15 h. Harmless today because FCM messages carry `ttl: "45s"` so nothing
   backlogs, but wasteful.

---

## 6. Environment / access (verified working this session)

SSH runs **directly from local Git Bash** with keys in `~/.ssh` — the "sandbox-only SSH"
rule in `CLAUDE.md` did not apply in this environment.

| Host | Purpose | Key |
|---|---|---|
| loopcom `45.14.194.179` | Connect server | `connect2_ed25519` |
| pbx `209.145.60.79` | **READ-ONLY, hard guardrail** | `connect2_server2_ed25519` |

- Prod repo clone on loopcom: **`/opt/connectcomms/app`** (not `/root`).
- **API/portal deploy:** `cd /opt/connectcomms/app && bash scripts/deploy-direct.sh api --branch feat/ai-agent` (~10 min, blue/green).
- **Worker/telephony deploy:** deploy queue —
  `POST http://127.0.0.1:3910/ops/deploy/enqueue`, header `x-deploy-queue-token`, token
  from `DEPLOY_QUEUE_TOKEN` in `/opt/connectcomms/env/.env.platform`.
  ⚠️ The queue's heavy-job lock **rejects a worker build while an API compose-build is
  running** (`HEAVY JOB ALREADY RUNNING`) — deploy serially, api then worker.
- **DB one-liners:** pipe JS into `docker exec -i -w /app/packages/db app-api-1 node -`.
  Schema gotchas: `Extension.extNumber` (not `number`), `Extension.ownerUserId`,
  `CallWakeEvent.occurredAt` (not `createdAt`), `Alert.category` (not `type`).
- `CDR_INGEST_SECRET` exists but is **empty** on the API container, so `/internal/*`
  endpoints currently log `"CDR_INGEST_SECRET not set — internal endpoint is
  unauthenticated"`. They are bound to the internal network, but worth flagging.

### Post-deploy verification
```bash
docker exec app-api-1 cat /app/.build-commit          # expect the deployed SHA
docker logs app-worker-1 --since 10m | grep DEVICE_REG_WATCHDOG
```

---

## 7. Pre-existing typecheck noise (NOT caused by this work)

`apps/worker` and `apps/api` both fail `tsc` on main already — `@connect/shared/apnsVoipPush`
moduleResolution errors, duplicate `canonicalSmsPhone`, `Prisma`/`PrismaClient` export
errors in `packages/db`. Baseline was measured before and after these changes: **7
`server.ts` errors before, 7 after; worker main.ts clean apart from the pre-existing
`apnsVoipPush` import.** Do not chase these as regressions.

`apps/mobile` typechecks clean for all files touched here.
