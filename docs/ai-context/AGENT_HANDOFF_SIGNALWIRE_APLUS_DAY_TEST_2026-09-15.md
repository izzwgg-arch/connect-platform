# AGENT HANDOFF — SignalWire DAY TEST on A plus center's main line (2026-09-15): 845-782-6775 hops through SignalWire (205) 351-3327 and lands on its own time condition — READ FIRST before touching `[trk-132-in]`, `[default-trunk](+)` in extensions__60_custom.conf, before ending the test, or for ANY "A plus callers hear something weird" today

**Izzy, 2026-09-15:** *"I want to run a test today with SignalWire … forward all calls
from [845-782-6775] to the SignalWire phone number … point the SignalWire number to the
time condition that the A+ Center number is pointed to right now. We'll leave it like
this for the whole day to see the quality … then we're going to start porting numbers in."*

**Everything lives in ONE file on the PBX: `/etc/asterisk/extensions__60_custom.conf`.
No app code changed, no deploy, no panel write, no DB write, no carrier write, no
SignalWire-side change.** Backups on the PBX (in `/etc/asterisk/`):
- `extensions__60_custom.conf.bak.signalwire-aplus-test.20260915045141` (pre first edit)
- `extensions__60_custom.conf.bak.signalwire-aplus-fwd.20260915050017` (pre second edit)

## §1 The two edits (both live, both proven with real calls)

**(a) SignalWire number → A plus's time condition.** In the existing `[trk-132-in]`
block (the custom SignalWire inbound handler that lifts the DID out of `To:`), one line
was added after the `+1` strip:

```
 same => n,ExecIf($["${SWDID}"="2053513327"]?Set(SWDID=8457826775))
```

A call arriving on trunk 132 for the SignalWire number is re-labelled as a call to
8457826775 BEFORE `__DID_NUMBER`/`CDR(did)` are set, so it runs A plus center's own
inbound route byte-for-byte — same `sub-set-call-vars` tenant hash (tenant resolution /
mobile ring pushes attribute to A plus correctly, VoIP.ms-shaped, no ring-hold latency),
same recording setup, same MOH, and lands on **`T2_app-time-condition,TC-1`** ("Main":
open → IVR-5 "A plus main", closed → IVR-4 "After hours main"). ⛔ Deliberately NOT a
direct `Goto(T2_app-time-condition,…)` — jumping straight to the TC would skip the
tenant hash and recording and re-create the 2026-08-29 tenant-null ring race class.
If A plus's routing changes mid-day, the test follows it automatically.

**(b) The forward: 6775 → out to SignalWire.** Appended block:

```
[default-trunk](+)
exten => 8457826775,1,NoOp(Connect day-test: A plus main line -> SignalWire hop, TRUNK_ID=${TRUNK_ID})
 same => n,GotoIf($["${TRUNK_ID}"="132"]?native)
 same => n,Dial(PJSIP/2053513327@0001,60)
 same => n,Hangup()
 same => n(native),Goto(T2_default-trunk,8457826775,1)
```

- **Why `default-trunk`:** every inbound call to 6775 provably passes through
  `default-trunk,8457826775` no matter which trunk delivered it or what the request-URI
  looked like — an exact exten in a `(+)` addition beats the generated `_8457826775`
  pattern and **survives every regen** (the generated files are rewritten; the custom
  file is not). No panel Apply was needed, so the T2 queued-changes flush trap and the
  doorway-wipe class were never risked.
- ⛔⛔ **THE TRUNK_ID GUARD IS THE ANTI-LOOP AND MUST NOT BE "SIMPLIFIED" AWAY.** The
  return leg from SignalWire is re-labelled 8457826775 by edit (a) and ALSO lands on
  this exten. `[trk-132-in]` sets `__TRUNK_ID=132`; the guard passes trunk-132 arrivals
  through to native routing. Without it: 6775 → SignalWire → back in → forward →
  SignalWire → … infinite loop, ~4 channels per second.
- **Why `@0001` (telocall) and not `@loopcom-pbx` (trunk 132 direct):** dialing the
  SignalWire endpoint directly is an OUTBOUND SignalWire call — SignalWire stomps the
  caller ID to `send_as` +12053513327 (proven live 2026-08-18), so every A plus caller
  would have shown as (205) 351-3327 all day, killing screen pops and callbacks. Via
  telocall the call arrives at SignalWire as a genuine PSTN INBOUND call and
  **the caller's own CID survives** (proven: probe CID +13479780090 arrived intact on
  the return leg).

## §2 Proof (real calls, read from /var/log/asterisk/full — never DB state)

- 04:52 `C-00000401`: call to the SignalWire number → `trk-132-in` → SWDID rewritten →
  `T2_incoming-calls` "INBOUND_ROUTE: A plus center" → `TC-1` (America/New_York, no
  match at that hour) → `T2_app-ivr,IVR-4` (After hours main).
- 05:00 `C-00000402..404`: call **to 8457826775 itself** → delivered inbound on
  `PJSIP/344022_Comfortcont` (TRUNK_ID=37) → day-test exten → `Dial(PJSIP/2053513327@0001)`
  → back in on trunk 132 → guard saw TRUNK_ID=132 → native → TC-1 → IVR-4 → **answered**,
  CID preserved. The loop guard is therefore proven in both directions.

## §3 Facts learned on the way (worth keeping)

- ⛔ **845-782-6775 is NOT on the VoIP.ms master account** (`getDIDsInfo` on the master
  → `invalid_did`; 74 DIDs, 6775 absent) — **yet the live call was DELIVERED inbound via
  `344022_Comfortcont` (VoIP.ms subaccount, trunk 37)**. Likely a VoIP.ms reseller
  *client* account (client DIDs don't show on the master's getDIDsInfo). The PJSIP conf
  ALSO carries a telocall registration trunk `[8457826775]` (user_2tnes8nx,
  us-east.telocall.com:7000, context trk-71-in) and telocall's IP-identify endpoint
  `user_WX9tUakR` → trk-70-in. Nobody should assume which carrier delivers 6775 without
  reading a live call — the carrier-migration board's "52 numbers on VoIP.ms" does not
  include this one.
- T102 (Loopcom Demo) outbound to BOTH probe targets went out `@0001` (telocall), not
  trunk 132 — route 123's config has evidently changed since the 08-18 handoff said
  "only trunk 132". Irrelevant to this test (the return path is what matters) but the
  08-18 claim is stale.
- Trunk 132's inbound half is untouched and still serves any other number on the
  SignalWire account. Loopcom Demo's route 244 for 2053513327 still exists but is now
  unreachable (the rewrite fires first) — that IS the intended change; demo bench calls
  to the SignalWire number now hear A plus's IVR for the duration of the test.

## §4 What to watch during the day / known trade-offs

- Every real call to 6775 now holds **2 extra channels** (one out on 0001, one in on
  loopcom-pbx) and produces **2 extra CDR legs** (first-pass trunk CDR did=8457826775 →
  out 0001; the return leg is the "real" A plus inbound CDR). Connect's CDR view may
  show the extra hop leg — cosmetic, one day.
- Recording/MOH/tenant vars run ONLY on the return pass (the forward exten deliberately
  does none of it), so calls record once, exactly like before.
- Audio path: caller ↔ carrier ↔ PBX ↔ telocall ↔ PSTN ↔ SignalWire ↔ PBX ↔ extension.
  Two more PSTN legs of latency than normal; that is inherent to any forward-based test.
- Attestation C does NOT matter here — the SignalWire legs are inbound; no customer
  outbound moved.
- SMS on 6775: untouched (voice-only change).

## §6 THE ANSWER-DROP (found 2026-09-15 10:17 ET, complaint from A plus: "we answer and it disconnects")

**Every call an extension answered on this path today died the instant it was answered
— 4 out of 4.** CEL (`mysql asterisk`, table `cel`, times UTC):

- 10:05:24 ET → ext 101, 10:06:24 → ext 101 (caller +17186350969), 10:08:56 → ext 101,
  10:09:15 → ext 112 via Local (caller +18458060616). All: `BRIDGE_ENTER` then
  `BRIDGE_EXIT` of `PJSIP/loopcom-pbx-*` in the SAME second, then
  `HANGUP {"hangupcause":58,"hangupsource":"PJSIP/loopcom-pbx-<self>","dialstatus":"ANSWER"}`.
- Cause **58 = AST_CAUSE_BEARERCAPABILITY_NOTAVAIL** — chan_pjsip's cause when a
  mid-call media renegotiation (re-INVITE) fails. The hangup SOURCE is the SignalWire
  return leg itself: Asterisk killed it, no BYE came from the caller or the extension.
- **IVR and voicemail on the exact same path work** (BackGround 11–14 s calls; a 30 s
  voicemail on 105 at 09:09) — the only thing that happens at extension-answer and not
  before is the BRIDGE, and the bridge is what triggers a re-INVITE toward SignalWire:
  `pjsip show endpoint loopcom-pbx` → `direct_media: true`, `direct_media_method:
  invite` (T2 extension endpoints are also direct_media=true). SignalWire rejects the
  renegotiation (RTP re-pointed at the customer's NATed phone / codec topology change);
  Asterisk responds by hanging the channel up with cause 58.
- The 04:52/05:00 §2 "proof" calls never exercised this: they landed after-hours
  (IVR-4 → no extension bridge). The defect was live from the first minute of the test.
- Distinct real victims seen: +17186350969 (twice), +18458060616 (twice, incl. the
  ext-112 leg). The forward hop pair (344022↔0001) natively re-INVITEs fine — both
  carrier legs accept direct media; SignalWire's leg is the one that refuses.
- ⛔ Verbose log carries NO SIP trace at this level, so the 488/4xx itself is inferred
  from cause 58 + timing; the proof of any fix is ONE real answered call.

**Fix options (pick one, then prove with a real answered call to 6775):**
1. **Surgical (keeps the test running):** turn off direct media for trunk 132 only —
   append to `/etc/asterisk/pjsip__60_custom.conf` (or the pjsip custom file that
   exists there): `[loopcom-pbx](+)` newline `direct_media=no`, then
   `asterisk -rx "core reload res_pjsip.so"` (or `pjsip reload`), verify with
   `pjsip show endpoint loopcom-pbx | grep direct_media` → `false`. Blast radius:
   trunk-132 calls only (this test + demo bench); RTP for them anchors on the PBX,
   which is already true for every non-direct bridge. ⛔ Do NOT edit the generated
   pjsip file — regen reverts it.
2. **Rollback (§5):** ends the test, restores A plus to the direct VoIP.ms path.

⛔ Whatever the choice, the SignalWire MIGRATION plan inherits this: a ported number
with direct_media left on = every desk-phone answer drops. Carry `direct_media=no`
into the trunk-132 endpoint config as a standing requirement.

## §5 HOW TO END THE TEST (rollback)

Delete the `[default-trunk](+)` block AND the one `ExecIf($["${SWDID}"="2053513327"]…)`
line (plus its two comment lines) from `/etc/asterisk/extensions__60_custom.conf`, then
`asterisk -rx "dialplan reload"` and verify with `dialplan show default-trunk` (the
exact '8457826775' exten must be GONE) + one real call to 6775. Or restore the
`…bak.signalwire-aplus-test.20260915045141` backup (pre-everything) the same way.
⛔ The custom file silently keeps the OLD dialplan on a parse error — always re-read the
LOADED dialplan after reload, then place a call. Partial rollback (removing only one of
the two edits) is safe in either order: removing (b) alone stops the forward, removing
(a) alone sends SignalWire-number calls back to demo ext 101 via route 244.
