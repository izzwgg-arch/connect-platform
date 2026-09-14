# ⛔⛔ AGENT HANDOFF — Relax Tires round 2: "vibrating but no incoming call until I opened the app" is ANDROID DELAYING THE RING PUSH 7–29 s, and the cell-forward backup is GONE (2026-09-01) — READ FIRST for any repeat of this report, before blaming the push senders, or before touching ext 101's dial string

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**Read-only investigation — no code, no deploy, no PBX write, no data change.**
Same tenant/user/device as the 08-27 section below: tenant `cmnlgryme000up9paz1w40fg0`,
PBX T25 ext 101, `relaxtires@gmail.com`, Samsung SM-S938U on T-Mobile, fleet APK
`1.0.0+20260823-175041` — current, do not tell him to update.)
Memory: [[relax-tires-app-ring-is-a-client-side-question]] (updated in place).

- ⛔⛔ **THE HEADLINE, measured from the device's own `pushReceivedAt` against the invite's
  `createdAt`: the ring push reaches his phone 7.5–29 SECONDS after the invite, and our side
  is proven fast** — on the 09-01 13:43Z call the api handed INCOMING_CALL to Google **3 s**
  after the invite (`[CALL_TIMELINE] PUSH_SEND` + `FCM_DIRECT_DELIVERED` in the api log), the
  device received it 4.4 s later. **The delay is Google→device**, almost certainly the same
  connectivity flap that rebuilds his SIP stack every ~14 min (361 registration events in
  19 h, T-Mobile CGNAT) also killing FCM's socket, so pushes wait for the phone's reconnect.
- ⛔⛔ **THE COMPLAINT DECODED, on the 08-31 19:52Z call (invite `cmthnn0xc…`):** caller rang
  31.6 s and hung up; the push landed on the phone at 19:52:37 — **2.6 s before the cancel** —
  so the notification buzzed and was immediately (correctly) dismissed by the cancel push.
  That near-instant buzz-and-vanish IS "vibrating with no incoming call". He opened the app at
  ~19:53:05 and `pending_call_native.json` replayed the dead invite's ring screen (`UI_SHOWN`
  logged 25 s AFTER the cancel) — "I only saw the call when I opened the app", literally true.
  The caller's retry (19:52:54) was DECLINED 1.3 s after its own late push arrived — likely a
  tap on the stale screen. Two more calls (20:02, 22:04, both canceled after 41 s/32 s) left
  **ZERO device telemetry** — push deferred past the ring entirely. **12 CANCELED invites in
  7 days** on this tenant; this is not twice.
- ⛔⛔ **THE CELL-FORWARD LEG (845-512-9339) WAS REMOVED FROM EXT 101'S DIAL STRING ~08-27/28**
  (last CDR to it 2026-08-27T22:02Z; AstDB dial key now
  `PJSIP/T25_101&Local/T25_101_1@connect-mobile-wake-dial/n` — dead desk + app wake-dial only).
  The 08-27 recommendation was app-first-THEN-cell, not removal. **With it gone there is no
  backup path: a deferred push is now a fully missed call**, where in August the cell caught
  it. That removal is exactly why he started noticing this week. Restoring a delayed cell leg
  is a PBX write — Izzy's call.
- ⛔ **The stale duplicate `MobileDevice` row (`cms4omoi01jmoro12bzrood5x`, lastSeen 08-23) is
  STILL active and now provably dead: FCM answers `NotRegistered` (404) for it on EVERY push**,
  after which the sender falls back to Expo (which accepts the ticket for the dead token). One
  doomed FCM attempt + one pointless Expo send per push, forever, and it keeps the row's
  `updatedAt` moving so it never looks abandoned. Flagged 08-27 and again now — deactivating
  it is a one-row update needing Izzy's word.
- ✅ **What worked today (09-01 13:43Z), for calibration:** prewake at IVR entry woke the phone
  and it registered in **2 s** (`DEVICE_REGISTERED`); ring push server→Google 3 s, on-device
  4.4 s later; the app **cold-started** (`SESSION_START` right after `UI_SHOWN`), ring UI at
  ~10 s, answered at 14 s, 3-minute conversation. So when FCM's socket is alive the chain is
  healthy — the failures are the calls that land while the socket is dead.
- ⛔ **What the server cannot see is still the 08-27 gap:** whether the notification RENDERED
  for the 20:02/22:04 calls is logcat-only (`emitCallFlowNative` never uploads). Do not claim
  the notification showed or didn't for a call with no telemetry.
- ⏳ **Remedies, none applied (his phone, his call):** on the handset — Loopcom battery =
  Unrestricted, Samsung "Never sleeping apps", full-screen-notification permission (the exact
  class for this device); decide on a backup ring leg; deactivate the dead device row.
- ⛔⛔ **ROUND 3 (2026-09-01, same day): THE DEEPER CAUSE IS OUR OWN HIGH-PRIORITY PUSH
  VOLUME — full census in
  `docs/ai-context/AGENT_HANDOFF_HIGH_PRIORITY_PUSH_CENSUS_2026-09-01.md`. READ IT before
  touching ANY wake/push sender.** Android budgets high-priority FCM per app per day by
  standby bucket (~10 for a rarely-opened app) and demotes over-budget pushes to normal =
  Doze-deferred. This device receives ~70–90 INVISIBLE high-priority WAKEs/day: the worker
  registration watchdog alone delivered **119 in 46 h** (⛔ its own comment says it was
  built FOR "the T25/ext101/S25 incident" — the cure feeds the disease), plus 4 invisible
  WAKEs + 1 visible INCOMING_CALL per call. Every WAKE has been 100% invisible since the
  placeholder heads-up was disabled 2026-07-07 (Izzy's request). ⛔ **Five WAKE senders
  exist** (ring-notify, telephony prewake `9c8d6a87`, wake-dial UserEvent consumer
  `e08e62a5` — the one wake-and-wait HOLDS for, worker watchdog `cdd5bbdd`, admin
  force-reregister + legacy wake-extension door) — each was a real fix; **none may be
  REMOVED**: the ring-notify WAKE is the ONLY wake on internal ext→ext calls (prewake is
  inbound-only). Proposed, NOT executed: watchdog wake → NORMAL priority; one WAKE per
  (call,user) gate across all senders; auto-deactivate NotRegistered tokens; on-device
  `getPriority()` vs `getOriginalPriority()` telemetry (the demotion proof — the app reads
  neither today). ⏳ The FCM Data API (priority-lowered %) is DISABLED on the Firebase
  project and the SA cannot enable it — one click for Izzy, project 853620654316.
  ⚠️ Demotion/quota is the best-fitting theory, NOT yet proven on-device.
- ✅✅ **ROUND 4 (2026-09-02): THE SERVER-SIDE FIX IS BUILT (`c16ce81c`, on Izzy's "I need
  a solution") — census §3 has the detail; deploy state in §3b of that doc.** Three
  changes, none touching INCOMING_CALL / INVITE_CANCELED / INVITE_CLAIMED: (1) the worker
  watchdog's recovery wake rides **NORMAL priority + 300s ttl** (`fcmPriority` option —
  everything else defaults HIGH; a guard pins the api at HIGH-only, and ⛔ never "fix" a
  slow recovery by putting the watchdog back to HIGH); (2) **one caller-less WAKE per
  (call, user)** — `apps/api/src/wakePushGate.ts`, consulted by all three api senders
  (ring-notify WAKE, `/internal/mobile-prewake` where BOTH prewake sources converge, and
  the legacy wake-extension door, which answers AS-IF-QUEUED on suppression so dialplan
  wait behaviour is byte-identical); check() and record() are SPLIT so a cooldown-refused
  wake never eats the call's one allowed wake; kill switch `WAKE_PUSH_GATE_DISABLED=1`;
  suppressions land as `CallWakeEvent` stage `WAKE_SUPPRESSED_DUPLICATE`; (3) **FCM 404
  UNREGISTERED retires the device row** (typed `FcmSendError.unregistered`, 404-only —
  ⛔ never a 400, which can be our bug) in BOTH api and worker senders; self-healing
  because `/mobile/devices/register` sets `active: true` on every branch. 17 new tests
  (13 api + 4 worker), every guard family reads 0 replayed at the pre-change HEAD; worker
  143/143; typechecks add 0 in touched files. ⛔ The FCM Data API was enabled + queried
  and is a **dead end at our volume** (HTTP 200, `data: {}` on every day incl. a fresh
  one — Google withholds breakdowns below a volume floor); the on-device
  `getPriority()`-vs-`getOriginalPriority()` telemetry (next mobile build) is the
  demotion proof. ⏳ Acceptance: Relax Tires' `pushReceivedAt − invite.createdAt` over
  the next week (was 7.5–29 s on the failing calls), plus `WAKE_SUPPRESSED_DUPLICATE`
  rows appearing on real inbound calls and his dead 08-23 device row reading
  `fcm_unregistered_deactivated`. Phone-side settings (battery Unrestricted etc.)
  are still worth setting and still not applied.
