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
