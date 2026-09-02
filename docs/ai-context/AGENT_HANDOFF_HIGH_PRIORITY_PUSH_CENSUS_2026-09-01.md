# AGENT HANDOFF — the high-priority push census: five WAKE senders, why each exists, and what is safe to change (2026-09-01)

**Read-only investigation — no code change, no deploy, no PBX write, no data change.**
Triggered by Relax Tires ext 101 "vibrating but no incoming call until I open the app,
continuously" and Izzy's mandate: *"before you go and remove them, I want an investigation
on each of them: why it was placed there… triple check that it's not going to cause any
problems — with different extensions as well."*

## 0. The finding this census exists to support

Android gives each app a limited daily budget of high-priority FCM pushes, sized by the
app's standby bucket (how often the user opens it). Over budget, further "high" pushes are
silently treated as NORMAL priority → deferred by Doze → the 7–29 s late ring pushes
measured on Relax Tires (device `pushReceivedAt` vs invite `createdAt`; server→Google
hand-off proven ~3 s). Google additionally demotes apps whose high-priority pushes don't
produce visible notifications.

**Measured burn for this ONE device:**
- Worker registration watchdog: **119 delivered invisible WAKEs in 46 h (~62/day)** —
  independent of calls.
- Per inbound call: **4 delivered invisible WAKEs + 1 visible INCOMING_CALL** (measured on
  the 2026-09-01 13:43Z call).
- Every WAKE has been 100% invisible since **2026-07-07**, when the wake placeholder
  heads-up was disabled at Izzy's own request (`IncomingCallFirebaseService.java`, step 3
  comment block).

Total ≈ 70–90 invisible high-priority pushes/day against a bucket quota on the order of
~10. The quota is exhausted early, so by most calls the ring push is already demoted. It
also explains "continuously": once spent, every call that day is late.

⚠️ **Demotion/quota is the best-fitting theory, NOT yet proven on-device.** The proof
instruments are §4. The change set in §3 is justified either way — the waste is real.

## 1. The five WAKE senders — origin, purpose, consumers

All ride `sendPushToUserDevices` → direct FCM v1 (`fcmDirect.ts`, `priority: HIGH,
ttl: 45s` — correct) with Expo fallback per device. Android consumer:
`handleWakePushNative` — starts SipKeepAliveService (idempotent), emits `Sip.WakeRegister`
(JS re-registers ONLY if the stack is not connected+registered — `SipContext.tsx:1686`;
`registerInner` suppresses forceRestart inside `inInviteAnswerWindow()`), boots the JS
runtime if dead. **No UI, ever.** iOS: silent background push (iOS VoIP prewake is
DISABLED — the duplicate-CallKit bug, 2026-08-02).

| # | Sender | Origin | Why it exists | Verdict |
|---|--------|--------|---------------|---------|
| S1 | `/internal/mobile-ring-notify` WAKE (server.ts ~35712), sent right before INCOMING_CALL | The original ring path (evolved via `0f86e753` "mobile answer reliability") | The ring UI is push-driven but ANSWERING needs a live SIP stack — this kicks registration in parallel with the ring. ⛔ **It is the ONLY wake for internal ext→ext calls** (prewake is inbound-only) and for calls whose tenant resolved too late for prewake. | KEEP; gate (§3.2) |
| S2 | `/internal/mobile-prewake` from telephony `maybePreWake` at call-first-seen (`9c8d6a87`, 2026-06-26) | Wake ASLEEP devices during the IVR window so the extension dial finds contacts (all-apps-asleep class). One-shot per call in telephony; 12 s/user cooldown in the api; targets stale-`lastSeenAt` devices only. | KEEP — it demonstrably works (device registered 2 s after it today) |
| S3 | `ConnectWakeConsumer.ts` → same `/internal/mobile-prewake`, fired by the dialplan's `ConnectWake` UserEvent at dial time (`e08e62a5`, 2026-06-30; fleet 2026-08-05) | **The wake that wake-and-wait HOLDS the call for.** Load-bearing on every wake-enrolled extension. Carries the extension. This is why one call shows TWO prewake POSTs (two telephony source ports; the api's 12 s cooldown lets the second through at ~15 s). | KEEP; gate (§3.2) |
| S4 | Worker registration watchdog recovery wake (`cdd5bbdd`, 2026-07-30), 60 s cycle, endpoint UNREGISTERED/UNREACHABLE > 300 s, per-endpoint cooldown 300 s | Luxure 2026-07-30: detection alone let a dead device sit 3 h 13 m. ⛔ **Its own comment says it was built for "the T25/ext101/S25 incident" — Relax Tires itself.** On a chronically flapping device it is a quota furnace and demonstrably futile (the device re-registers by ITSELF every ~14 min — 361 reg events in 19 h). | CHANGE (§3.1) — the cure is feeding the disease |
| S5 | `/admin/mobile/devices/:id/force-reregister` (admin diagnostics) + `/internal/pbx/wake-extension` (server.ts ~36504, the legacy dialplan HTTP door — no events on today's calls, superseded by S3's UserEvent path but still routed) | Diagnostics / legacy | LEAVE; include wake-extension in the §3.2 gate, do not delete |

**Untouchables — verified, do not touch:** `INCOMING_CALL` (the UI; also the one push
that "refills" the visible-notification signal), `INVITE_CANCELED` (ghost-ring
protection), `INVITE_CLAIMED` (multi-device stop-ring), missed-call / voicemail / message
notifications (visible). The vm-greeting record flow already uses NO wake on purpose.

## 2. The scenario matrix (Izzy's "with different extensions as well")

| Scenario | Wakes today | After §3 changes |
|---|---|---|
| Wake-enrolled ext, Android, inbound (Relax Tires) | S2 + S3 + S1 (+S4 all day) | ONE wake (first of S2/S3/S1 wins), INCOMING_CALL unchanged |
| Internal ext→ext call | S1 only (S2/S3 don't fire) | S1 passes the gate — unchanged |
| Tenant unknown at first sight (SignalWire `s`-exten) | S2 skipped early; S3/S1 later | first of S3/S1 passes — unchanged |
| Non-wake-enrolled ext (T34_101 class) | S2 + S1 | first passes — unchanged |
| iOS | same senders; ring = INCOMING_CALL VoIP push (untouched) | unchanged |
| Multi-device / shared-AOR users (Fixup) | per-USER fan-outs | gate keyed (call, user) still wakes every device once |
| vm-greeting record | no wake by design | unchanged |
| Genuinely dead device, no calls (Luxure class) | S4 every 5 min | S4 still fires, at normal priority (and/or truly-dark gate) |

## 3. The change set — ✅ BUILT 2026-09-02 (`c16ce81c`), on Izzy's "I need a solution"

Items 1–3 below shipped exactly as designed (deploy state in §3b). Item 4 (the
mobile priority telemetry + stale-replay fix) still rides the next app build.
Where it lives: `apps/api/src/wakePushGate.ts` (+ its 13-test file, all source
guards replay-proven failing at the pre-change HEAD), `apps/api/src/fcmDirect.ts`
(`FcmSendOptions` — HIGH stays the default; typed `FcmSendError.unregistered`,
404-only), the three gated send sites in `apps/api/src/server.ts`, and the
worker's `fcmPriority: "NORMAL"` watchdog send + UNREGISTERED retirement in
`apps/worker/src/main.ts` (4-test guard file). Kill switch:
`WAKE_PUSH_GATE_DISABLED=1` (api env + restart). Suppressions are visible as
`CallWakeEvent` stage `WAKE_SUPPRESSED_DUPLICATE`; retirements as
`lastPushStatus = "fcm_unregistered_deactivated"` (row re-activates itself on
the next `/mobile/devices/register`).

⛔ The gate's check() and record() are SPLIT on purpose (a cooldown-refused
wake must not eat the call's one allowed wake), the wake-extension door answers
AS-IF-QUEUED on suppression so dialplan wait behaviour is byte-identical, and
the api itself may never pass NORMAL — both pinned by tests.

### 3a. FCM Data API postscript (2026-09-02)

Enabled + viewer role granted in Izzy's Chrome on 09-01; queried twice. It
answers HTTP 200 with rows (Aug 21–28) and **every day's `data` is `{}`** —
Google withholds the percentage breakdowns below a minimum daily message
volume, and our Android direct-FCM fleet is under it. A fresh day arriving
empty settles that this is a volume floor, not lag. **Dead end at our size**;
left enabled (read-only, costs nothing). The proofs that remain: the §3.4
on-device priority telemetry, and the acceptance metric in §4.

## 3-orig. The proposed change set (as designed 2026-09-01)

1. **S4 watchdog wake → NORMAL priority** (and optionally gate on "no REGISTERED event in
   ≥ 30–60 min" instead of 300 s stale). A recovery wake is not time-critical: a
   Doze-deferred delivery still revives a truly dead device within minutes, which is what
   the Luxure case needed (it had sat 3 h). Normal priority consumes ZERO high-priority
   quota. Not on the call path at all.
2. **One WAKE per (call, user) across S1/S2/S3/wake-extension** — an api-side sent-marker
   (TTL ~45 s, the invite window) consulted by all four sends; generalizes the prewake's
   existing 12 s cooldown map. First wake always passes, so every scenario in §2 keeps its
   coverage. Blue/green caveat: two api processes = two maps; worst case one duplicate
   wake during a rollout — acceptable.
3. **Auto-deactivate `MobileDevice` rows on FCM `NotRegistered`** (Google's documented
   token contract). Relax Tires' dead 08-23 row still gets a doomed FCM attempt + Expo
   fallback on EVERY push.
4. Mobile build (with the next release, not urgent): upload
   `RemoteMessage.getPriority()` vs `getOriginalPriority()` + `getSentTime()` in the
   existing telemetry — **direct on-device proof of demotion**; and stale-cached-invite
   replay should render "Missed call" instead of a live ring screen.

## 4. Proof instruments

- **FCM Data API** (`fcmdata.googleapis.com`) — per-day delivery insights incl.
  priority-lowered / delayed-by-doze percentages. ⛔ DISABLED on the Firebase project and
  the FCM service account may not enable it (`serviceusage` 403, tried 2026-09-01). One
  click for Izzy:
  `https://console.developers.google.com/apis/api/fcmdata.googleapis.com/overview?project=853620654316`
- The §3.4 priority telemetry.
- Acceptance metric: Relax Tires' `pushReceivedAt − invite.createdAt` distribution for a
  week before vs after (before: 7.5–29 s on the failing calls).

## 5. Where the evidence lives

Invite/push timelines: `CallInvite` + `VoiceDiagEvent` (`pushReceivedAt` in the
`UI_SHOWN`/`ANSWER_TAPPED` payloads); server sends: api log `[CALL_WAKE]` /
`[CALL_TIMELINE] PUSH_SEND` (wiped per deploy); watchdog sends: worker log
`[DEVICE_REG_WATCHDOG]` + `CallWakeEvent` stage `WATCHDOG_REREGISTER_PUSH_QUEUED`
(durable — use this for counts, not the log). Android handler:
`IncomingCallFirebaseService.java:382` / `handleWakePushNative` (~:986). JS guards:
`SipContext.tsx:1686`, `jssip.ts` `registerInner`/`inInviteAnswerWindow`.
