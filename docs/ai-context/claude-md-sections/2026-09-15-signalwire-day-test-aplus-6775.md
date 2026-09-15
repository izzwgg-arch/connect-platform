# SignalWire DAY TEST (2026-09-15): A plus center's 845-782-6775 hops through SignalWire (205) 351-3327 into its own time condition — LIVE, proven with real calls — READ before touching `[trk-132-in]` / `[default-trunk](+)` in the PBX's extensions__60_custom.conf or ending the test

Full handoff: **`docs/ai-context/AGENT_HANDOFF_SIGNALWIRE_APLUS_DAY_TEST_2026-09-15.md`**

- ✅ **LIVE + PROVEN 05:00 2026-09-15 with a real answered call to 6775**: inbound
  (delivered via VoIP.ms sub `344022_Comfortcont`, trunk 37) → custom
  `[default-trunk](+)` exact exten → `Dial(PJSIP/2053513327@0001)` (telocall, so the
  caller's own CID SURVIVES — dialing trunk 132 direct would stamp every caller as the
  205 number) → SignalWire → back in trunk 132 → SWDID rewritten 2053513327→8457826775
  in `[trk-132-in]` → A plus's own inbound route → `T2_app-time-condition,TC-1` → IVR.
- ⛔⛔ **The `GotoIf($["${TRUNK_ID}"="132"]?native)` guard IS the anti-loop** — the
  return leg lands on the same exten; removing the guard = infinite forward loop.
- **Everything is ONE PBX file** (`/etc/asterisk/extensions__60_custom.conf`, backups
  `*.bak.signalwire-aplus-{test.20260915045141,fwd.20260915050017}`). No app code, no
  deploy, no panel Apply (so no T2 queued-changes flush, no doorway wipe), no carrier
  write, survives regens. Rollback = delete the two additions, reload, verify LOADED
  dialplan + one real call (§5 of the handoff).
- ⛔ **6775 is NOT on the VoIP.ms master account** (getDIDsInfo → invalid_did) yet a
  live call arrived via a 344022 subaccount — likely a reseller CLIENT account; the PJSIP
  conf also holds telocall trunks (70/71) for it. Read a live call before assuming its
  carrier.
- Demo-bench note: calls to (205) 351-3327 now hear A plus's IVR (route 244 unreachable
  behind the rewrite) for the duration of the test. Loopcom Demo outbound currently goes
  out `@0001`, not trunk 132 — the 08-18 "route 123 has only trunk 132" claim is stale.
- ⏳ NOT PROVEN: no HUMAN call yet; audio quality is the whole point of the day — judge
  it from real calls + rtpStats, not from this trace.
