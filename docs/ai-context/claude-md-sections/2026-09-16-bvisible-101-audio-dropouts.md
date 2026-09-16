# B Visible ext 101 "no audio both ways, every day" — DIAGNOSED: the office side goes dead-mic, it is NOT the carrier and NOT the PBX (2026-09-16) — READ FIRST for any B Visible audio complaint, and for any "caller can't hear me" on a Yealink W-series office

**Complaint (Izzy, 2026-09-16):** ext 101 (B Visible, PBX T9, office WAN 47.17.126.158)
says lately, daily, "the caller cannot hear him and he cannot hear them." Last bad call:
845-428-2290, this morning.

## What happened on that exact call — measured, not guessed

`ConnectCdr` id `cmu48cidb2my6o513ey8mlasj`, incoming 845-428-2290 → (845) 238-0478,
**2026-09-16 15:02:17 UTC (11:02 ET)**, answered 11:02:26, hung up 11:02:45 (19 s live).
`rtpStats` (per [[rtpstats-is-the-per-call-quality-data]]):

- Leg `PJSIP/T9_101-00001a86` (his Yealink T53W): **rx 6 / tx 917** — the PBX streamed
  ~19 s of caller audio TO the phone but received only **6 RTP packets back**. The
  caller heard nothing from him. ⛔ NOT a hold — the Asterisk log for `C-0000093a` has
  no music-on-hold start; the MOH lines at call setup are class *configuration*.
- Trunk leg (`344022_Comfortcont`) was clean — the carrier delivered and accepted fine.
- They called back at 15:05 UTC and that call was clean both ways (rx 2143 / tx 2134).
  The two 3-second "answered" outbound calls from 101 to that number at 14:09/14:51 UTC
  (answered only after ~31 s) are almost certainly the caller's voicemail.
- Ear-proof if wanted: the call recording
  `/var/spool/asterisk/monitor/2b9df1ace9927067/2026/09/16/110221-IN-IVR-8454282290-101-1789570937.13199.wav`
  should carry the caller's voice and near-silence from 101.

## Why it's the OFFICE, not the carrier, not one phone, not the PBX

- **The dead-mic signature repeats and crosses phones:** rx≈6 while tx is hundreds —
  ext 101 today and on 09-14 (outgoing, rx 6 / tx 1087), ext 101 on 09-10 on an
  **internal** call (rx 6 / tx 164 — VoIP.ms never touched it), and **ext 104** on
  09-03 (rx 6 / tx 366). Same office, different devices.
- **All office endpoints flap Unreachable** (qualify OPTIONS unanswered ≥3 s):
  T9_101/102/103/104/106 + 111_1, 69 events over 09-15/09-16 alone, including
  overnight (06:30, 06:59 UTC). Flaps are common platform-wide on NAT'd endpoints, but
  this office's cluster is dense and correlates with the complaints.
- **Live qualify RTTs from the office were wild at 11:25 ET:** 101=41→294 ms,
  102=277 ms, 103=257→355 ms, 104=305 ms, 106=139 ms — phones on the SAME LAN varying
  by 300 ms at the same moment. Platform median at that instant was 44 ms (n=154).
  Per-phone variance on one LAN points at per-device radio links or a router/uplink
  oscillating under load.
- **All five office desk phones are Yealink W-series** (101/102/104/106 = T53W,
  103 = T54W — provisioning DB, tenant 9). "W" = built-in Wi-Fi. ⏳ NOT verified
  whether any are actually on Wi-Fi vs ethernet — that is the first thing to ask the
  customer / check on a phone's own screen. Wi-Fi desk phones produce exactly this
  signature (fine for minutes, dead RTP for one call, fine again).
- **The PBX is healthy:** 0% loss / 8 ms to 8.8.8.8, CPU 92% idle, no NIC errors,
  rx-drop 0.03%. The measured RTP loss on B Visible's trunk legs is ~0%.

## Flagged in passing, separate from this complaint

- ⚠️ **PBX → newyork1.voip.ms showed 10–20% ICMP loss** in two ping runs (30 pkts,
  10%; 5 pkts, 20%) while RTP-measured loss on live trunk legs stayed ~0% — possibly
  ICMP deprioritization at VoIP.ms, possibly a lossy path. Worth a re-measure if any
  VoIP.ms-carried audio complaint arrives platform-wide.
- ⚠️ **`T9_101_1` (101's WebRTC softphone device) has never registered**, so every ring
  of ext 101 logs `ERROR … Could not create dialog to invalid URI 'T9_101_1'` (the dial
  string is `PJSIP/T9_101&PJSIP/T9_101_1`). Harmless to the call, noisy in the log,
  and it means 101 has no working softphone fallback while his desk phone flakes —
  he was invited 2026-08-24 and has not signed in.
- PBX → Connect server latency is a steady 113 ms, 0% loss — looks like the normal
  route between the two Contabo boxes, flagged only so nobody "discovers" it later.

## What would fix it (NOT done — customer-side, needs Izzy's call)

1. Ask/verify whether the Yealinks are on Wi-Fi; move 101 (at least) to ethernet.
2. If wired: office router QoS/SIP-ALG and uplink saturation are next; the
   2026-08-26 Trimpro lesson applies — name the endpoint from rtpStats first.
3. Getting 101 signed into the Loopcom app would give him a fallback device and
   kill the log noise.

No writes were made anywhere (PBX read-only respected; Connect DB read-only queries).

## Round 2 (same day) — Izzy asked: port-related? did they always have this?

**Ports: the router IS misbehaving, but it did not cause the morning call.** Proven from
registration logs: overnight Sep 15 **all five phones' public NAT ports changed twice
within 50 minutes** (01:17 ET → ports 14213-16, then 02:07 ET → 14237-41, every phone
simultaneously = the router rebuilt its NAT table twice, reboot/flush/ISP reconnect),
and 103's 01:17 registration arrived with an **unrewritten :5060** — inconsistent SIP
ALG treatment. Stale pinholes after such a reset are exactly what the Unreachable flaps
look like (PBX sends to a dead port until re-registration). ⛔ **But the dead-mic calls
are NOT a port failure:** the full log has **zero strict-RTP discard events** (so
Asterisk never rejected a re-mapped stream) and NAT never blocks *outbound* — during the
11:02 call his audio never left the office at all. Port trouble explains some of the
"different problem every day" variants; the measured one is upstream of ports
(phone/Wi-Fi/LAN/uplink).

**History: they did NOT just start having this — it is chronic, flat, at least 7 weeks
old.** Weekly since RTP sampling began (Aug 23): dead-mic legs 4/1/0/2-3 and
phone-missed-audio (txLossPct≥1) legs 1/6/7/3/2 — every week, no trend; avg RTT steady
~50 ms. Redial proxy (answered call 5-35 s then same pair reconnects <5 min) back to
Jul 27: 5-9% of answered calls every week, no worsening. "Lately" is perception —
possibly because 101 carries by far the most traffic (643 sampled legs vs 148-347 for
the other extensions), so he eats the most incidents. ⛔ The census undercounts: the
sampler needs ~10 s of call, so short dead calls leave no rtpStats row.

**One actionable detail for the customer conversation:** the double NAT reset happened
at 1:17 AM and 2:07 AM — ask whether the router auto-reboots nightly / ISP renews; a
router that flushes NAT twice in an hour overnight can do the same midday under load.

## Round 3 — ⛔ "not enough ports, open more ports" was considered and is WRONG

Izzy asked whether the phones are fighting over too few ports. No: 5 phones use a
handful of mappings out of tens of thousands a router tracks; ports 14237-41 are
distinct with zero collisions; the overnight changes were the router WIPING its NAT
table (all phones re-mapped simultaneously), not exhaustion; and the dead-mic call's
audio never left the office, which no port count fixes. ⛔ Do NOT forward/open ports on
the customer router (not needed for outbound-registering phones, and standing-open
SIP/RTP ports attract scanner traffic/ghost calls). Server RTP range was already
widened 2026-08-23 and every other tenant on this server is clean. The real router-side
fix candidates remain: disable SIP ALG (proven meddling — one registration passed
unrewritten :5060), stop/explain the overnight resets, wire the Wi-Fi-capable Yealinks.

## Round 4 — ✅ WI-FI CONFIRMED BY IZZY: all five phones are on Wi-Fi, the office has NO Cat5 drops, and it is a big office with a lot of equipment

The ⏳ from round 1 is closed: Izzy confirms every Yealink is on Wi-Fi. Root cause is
now settled as **airtime contention on a crowded office Wi-Fi + an undersized router**,
which together produce every measured symptom (dead-mic legs, 41→355 ms RTT spread
across one LAN, Unreachable flaps, overnight NAT-table resets). ⛔ Izzy's "ports on
their router" instinct maps to a real thing but the wrong noun: consumer/ISP routers
exhaust their NAT **session table** (a few thousand entries) in equipment-heavy
offices and evict live mappings — the remedy is a business-grade router, never
"opening" ports. Proposed to Izzy (customer-side, nothing done):
1. business-grade router/AP (ask what model they run today — ISP combo box = prime
   suspect for both table exhaustion and the flaky ALG);
2. dedicated 5 GHz SSID that ONLY the five phones join (W-series support 5 GHz) —
   cheapest meaningful fix, zero wiring;
3. SIP ALG off on whatever router they keep;
4. powerline-ethernet or a small switch for ext 101 if any desk is near the router;
5. 101 signs into the Loopcom app as fallback (T9_101_1 has never registered).

## Round 5 — a diagnostic prompt was handed to the CUSTOMER'S own office agent; output pending

B Visible has an agent on an office computer. Izzy was given a READ-ONLY prompt for it
(in the 2026-09-16 chat): (1) is the computer wired or Wi-Fi + its own link stats,
(2) `netsh wlan show networks mode=bssid` channel/band survey, (3) **the split test** —
100 pings each to the default gateway, to 209.145.60.79, and to 8.8.8.8
(gateway lossy = Wi-Fi/LAN sick; gateway clean + others lossy = router/uplink sick),
(4) pathping to the PBX, (5) `arp -a` device count + IF the office grants router admin
access: make/model, uptime, connected-device count, SIP ALG on/off — read-only, change
nothing, no password guessing, (6) router identity from the gateway page title.
⛔ Told Izzy: run it during a busy hour / right after a bad call; a quiet-hour clean run
proves nothing ([[quiet-log-is-not-a-fixed-bug]] shape). ⛔ A wired computer's clean
gateway ping does NOT clear the Wi-Fi — it only isolates the router/uplink half; the
phones' own radio stats are unmeasurable from a PC. ⏳ AWAITING the report; interpret it
against the split-test key above and the server-side baseline in rounds 1–4.
