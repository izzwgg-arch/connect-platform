# ⛔⛔ AGENT HANDOFF — a SignalWire inbound call rang NOBODY: the one-shot ring push raced the tenant, TWICE — first on DialBegin (2026-08-29), then on the recording VarSet (2026-08-30); the durable fix HOLDS AT THE LATCH — READ FIRST for ANY "the app didn't ring" on a SignalWire-routed number, before touching MobilePushNotifier's one-shot, or before letting resolvePbxEventTarget run without tenant evidence

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`ab33da33` + **`ded5d412`** on `feat/ivr-migration-takeover`. ✅ **api at
`ab33da33`, telephony at `ded5d412`, BOTH container-verified 2026-08-30**
(telephony queue job `d4ec89ea`, deployed at 0 active calls, `ringTenantWait`
grepped in the running container's src, AMI/ARI reconnected, 0 restarts,
0 error lines). ✅ **PROVEN WITH A REAL CALL through the SignalWire loop**
(AMI-originated `Local/2053513327@T102_cos-all` → trunk 132 → SignalWire →
back in as `1788096475.42709`): the ring notify carried
`connectTenantId: cms8yjvth…` (Loopcom Demo), the api fanned out a real
**INCOMING_CALL** push (`FCM_DIRECT_DELIVERED`), and the CallInvite row is on
**Loopcom Demo** — the first correctly-tenanted SignalWire invite ever. No
migration, no PBX write, no env change.) Izzy, 2026-08-29: *"I just made a
phone call to the Loopcom demo phone, and it ain't ringing... I tried three
times."* Memory: [[signalwire-inbound-rang-nobody-tenant-race]].

- ⛔⛔ **THE ab33da33 TELEPHONY HALF WAS NOT ENOUGH, AND THE REASON IS THE
  LESSON: it fixed the EVENT (DialBegin) instead of the LATCH.** The very next
  live call (`1788095464.42602`, 2026-08-30 13:11Z) latched the one-shot from a
  DIFFERENT event — the recording `__REC_FILENAME` VarSet handler resolves the
  destination extension for the ring push, and it fired with the tenant still
  null, **6 ms** before the wake leg resolved it. The api (correctly) refused
  the tenant-less notify, so no CallInvite existed at all and the phone got
  only a wake push — which renders NO ring UI. **Per-event fixes always miss
  the next event.**
- ✅ **THE DURABLE FIX (`ded5d412`): the one-shot REFUSES TO LATCH while the
  call has no tenant identity** (`!tenantId && !pbxVitalTenantId`). It HOLDS
  the ring notify (`ringTenantWait` map) and the next callUpsert — carrying the
  tenant milliseconds later — sends it complete. A fallback timer
  (`RING_TENANT_WAIT_MS`, 1000 ms, env-overridable for tests) sends
  tenant-less at the deadline so a call whose tenant never resolves
  (globally-unique ext, unattributed trunk) still rings exactly as before; a
  hangup during the hold cancels it. ⛔ VoIP.ms-shaped inbound resolves the
  tenant on the FIRST trunk event and never enters the hold — zero added
  latency on ordinary calls. ⛔ **Never "simplify" the hold back into an
  immediate send, and never fix a recurrence by patching another emit site** —
  the latch is the one place that covers every present and future event path.
- ✅ **Proven (`ringTenantHold.test.ts`, 6 tests, picked up by the services
  glob): 4 of 6 FAIL replayed against pre-fix HEAD** (the two that pass are the
  no-hold paths). Telephony typecheck **41 = the exact baseline**, 0 in edited
  files; suite 271/274 (the 3 documented smarthome artifacts).

- ⛔⛔ **THE CHAIN, measured to the millisecond on linkedId `1788055211.42054`:**
  he dialed the SignalWire number **(205) 351-3327**; the PBX side was PERFECT
  (trk-132-in → T102 → wake-dial held 24s). But the SignalWire trunk leg has
  **no DID in its exten** (request-URI user is `s`), so TenantResolver's DID
  lookup finds nothing and the call reaches DialBegin with tenantId NULL —
  and **DialBegin is the event that adds the extension AND fires
  MobilePushNotifier's ONE-SHOT ring push**. Push fired at 22:00:12.366 with
  `connectTenantId: null`; the wake Local channel's Newchannel resolved the
  tenant at **.368 — 2 ms too late**. VoIP.ms inbound never hits this (the DID
  resolves the tenant at the first trunk event), which is why the class was
  invisible until someone called the SignalWire number expecting a mobile ring.
- ⛔⛔ **THE API HALF WAS A CROSS-TENANT LEAK: `resolvePbxEventTarget` with no
  tenant evidence took the FIRST LINKED tenant owning ext 101 platform-wide —
  Trimpro** — so the CallInvite and the INCOMING_CALL push (carrying the
  caller's number) went to ANOTHER COMPANY's user (who had 0 devices, so
  nothing rang there either). The demo iPhone got only `INCOMING_CALL_WAKE`
  (an Expo background push) — ⛔ **iOS renders NO ring UI for a wake push**;
  CallKit needs the INCOMING_CALL VoIP push, which went to the wrong tenant.
  The phone woke 31 s later, after the caller was gone.
- ✅ **FIXES:** (1) `CallStateStore.onDialBegin` resolves the tenant from the
  dialed leg's OWN T-code marker (`Local/T102_101_1@…`) via the existing
  `tenantCodeToConnectIdResolver`, fill-only, BEFORE the callUpsert emit — so
  the one-shot push carries the tenant on the very event that triggers it.
  (2) `resolvePbxEventTarget` REFUSES (loud warn, TARGET_NOT_FOUND) when the
  event carries neither `pbxTenantId` nor `pbxExtensionId` and the extension
  number matches more than one tenant — a globally-unique extension still
  resolves. ⛔ Refusing is strictly no worse: the wrong-tenant invite never
  rang the right phone either.
- ⛔ **THE GENERAL RULE THIS EARNS: a one-shot notifier keyed on "first event
  where X appears" must verify the OTHER fields it sends are populated on that
  same event** — the extension and the tenant arrived on different events 2 ms
  apart, and the one-shot latched the wrong one.
- ⛔ **Diagnosis recipe:** telephony `PIPE[1/6]` lines show tenant_RESOLVED vs
  UNRESOLVED per channel; the api's `mobile-ring-notify: received` line shows
  the `connectTenantId` that arrived; the CallInvite row's tenantId shows who
  was actually rung. The CDR's `toNumber: "s"` is the SignalWire signature.
- ✅ **Proven:** 3 new behavioral tests in `CallStateStore.tenantMarker.test.ts`
  (the DialBegin test FAILS replayed against HEAD — proven by running HEAD's
  file side-by-side) + source guard `ringNotifyTenantGuess.test.ts`;
  typechecks at exact baselines (telephony 41, api 76, none in edited files);
  wakeLegRedelivery + multiPartyBridgeStopRing suites 17/17.
- ✅ **The server chain IS proven by the 2026-08-30 loop call** (right tenant,
  real INCOMING_CALL push, invite on Loopcom Demo, CANCELED cleanly on
  hangup). ⏳ **Still unproven by a HUMAN: the CallKit ring on the sleeping
  demo iPhone.** ⚠️ On the probe, the INCOMING_CALL fan-out for the demo user
  found only **1 active device row (the Samsung)** — the demo iPhone's
  `MobileDevice` row did not qualify (`includeInactiveDevices: false`), so if
  Izzy's iPhone test doesn't ring, **check that device row's freshness before
  suspecting the call path** — opening the app once re-registers it.
  Acceptance stays: one call to **(205) 351-3327** with the demo iPhone
  asleep → CallKit ring screen; the negative: no CallInvite for any other
  tenant. ⛔ **The 2026-08-30 02:02Z calls created wrong-tenant invites
  (ext 101 "Nachemya Ungar") DESPITE this handoff's 08-29 "deployed" claim** —
  the fixes demonstrably only took effect after the ~02:29Z container
  restarts; history, but do not trust the 08-29 deploy claim when reading old
  rows.
- ⛔ **Interim fact stated to Izzy: the OLD demo number 347-978-0090 rings via
  the VoIP.ms path and was never affected.**
