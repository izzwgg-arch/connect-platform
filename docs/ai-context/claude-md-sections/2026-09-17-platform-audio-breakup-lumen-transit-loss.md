# ⛔⛔ PLATFORM-WIDE "AUDIO BREAKING UP" (calls, hold, IVR prompts, recordings) — DIAGNOSED READ-ONLY (2026-09-17): the PBX's Contabo St. Louis uplink loses 5–24 % of packets on the Lumen transit path to VoIP.ms New York 1 and to Telocall, since ~Sep 6, worst in business hours — READ FIRST for ANY choppy/scratchy/laggy audio complaint, before blaming a customer's router, a codec, the PBX, or our code

Full handoff: **`docs/ai-context/AGENT_HANDOFF_PLATFORM_AUDIO_BREAKUP_2026-09-17.md`**
(read-only; no server, DB, code or config change was made). Memory: [[pbx-uplink-loses-packets-on-the-lumen-path]].

- ⛔⛔ **THE FAULT IS THE NETWORK PATH OUT OF THE PBX, NOT THE PBX AND NOT THE CUSTOMERS.** From
  `vmi2718844` (209.145.60.79, Contabo St. Louis), traffic to **`newyork1.voip.ms` 208.100.60.66**
  (62 of 65 VoIP.ms trunks + DID media) and to **Telocall `us-east.telocall.com`** (8.36.70.3 SIP,
  8.36.70.9 media — the "0001" primary outbound trunk on EVERY tenant's route) exits via
  **Lumen (63.208.63.217 → 4.26.120.122)** and loses **5–24 % per 100 packets**; traffic to
  `atlanta1.voip.ms`, `chicago1.voip.ms`, `us-central.telocall.com`, `sip.telnyx.com`, loopcom exits
  via **Cogent (154.24.69.121)** and loses **0 %** in the same seconds. Per-hop: loss FIRST appears at
  4.26.120.122 (15/1/12/22/6 %) and PERSISTS to NY1 (14/14/24/3/11 %) and Telocall (13/10/19/4/6 %) —
  the opposite of ICMP deprioritisation. Same hosts: **0 % from loopcom (France) and 0 % from Izzy's PC.**
- ✅ **It is real media loss, measured three ways:** (1) live `pjsip show channelstats` — every Telocall
  leg reports **4–5 % Transmit Lost** (the carrier's own RTCP receiver report) while every phone leg in
  the same minute reports 0; (2) `ConnectCdr.rtpStats` — trunk legs with ≥1 % tx loss went
  **2.5 → 7.7 → 3.5 → 23.8 → 33.3 %** week over week; daily **1–4 % through Sep 4, 10 % on Sep 6,
  36.6 % on Sep 11 (19.8 % ≥5 %), 49.2 % today**; phone legs flat; jitter/RTT flat; loss tracks
  hour-of-day (11am–3pm ET ×10 overnight), NOT our concurrency (0–5 vs 6–15 calls identical, peak 15);
  (3) the recordings: Sep 16–17 files carry **2.4–7.8 mid-speech holes per minute of speech**
  (20–320 ms), July/August files from the same tenants **0–1.4** (`scripts/pbx/diag/recording-gap-census.py`).
  Today's log: all NY1 trunks + 0001 flapped Unreachable TOGETHER at 03:08:51 and 15:18:52 ET.
- ⚠ **Second pass (handoff §4a): the Sep 6 rise is on ALL trunk groups** — Telocall/Lumen worst
  (63.8 % of legs ≥1 %, mean 2.36 % on 09-17), newyork1/Lumen next (31.6 %, 0.81 %), atlanta1/Cogent
  smallest but NOT zero (29.2 %, 0.62 %) — so the shared Contabo edge (`209.126.0.11` 1–3 %) and/or the
  RETURN path (invisible from the PBX) are lossy too; a POP move reduces it, only Contabo removes it.
  **First episode 08-26/27** (Telocall + atlanta1 at 15–20 %) = "not the first time". Trunk Unreachable
  events in `PbxEndpointRegistrationEvent`: 5–9/day → **56–63/day from 09-08**; biggest mass-flaps
  09-14 02:19 UTC (61 trunks) and 09-08 05:19 (39). Peak loss hours **11 am–3 pm ET** (43.9 % at 11).
  Gesheft/Trust DESK-PHONE rx loss on 09-16/17 = 0.01–0.12 % → the recordings' holes are carrier→PBX.
- ⛔ **Why it explains every symptom Izzy named:** IVR prompts (the Gesheft pay line), hold music and
  a person's voice to an OUTSIDE caller all travel PBX → carrier — the lossy direction; recordings are
  what the PBX RECEIVED, and the inbound direction is lossy too at the sub-1 % level that the INTEGER
  `rxLossPct` column hides — **use `rxLost/rxCount`, never the Pct column, for anything under 1 %.**
- ⛔ **The PBX host is clean — do not re-derive it:** steal 0 on every core (⛔ `/proc/stat` col 8 is
  steal; col 7 is softirq — the first read got this wrong), 87–94 % idle, PSI ~0, NIC drops 0.017 %,
  UDP rcvbuf errors 1,330 lifetime, conntrack 0.2 %, timing 50/50, no crash/restart, main thread idle
  (`top -H`'s first row is the PROCESS total, not the main thread), MOH and prompts all 8 kHz PCM, RTP
  range + firewall intact, no `nft limit rate`. **Our code is clean** (Explore audit: sampler = one AMI
  command / 10 s; MOH pre-transcoded + reload-on-change; recordings pass-through; pay-line CURL is
  feature-scoped). ⛔ The 2026-09-16 "10–20 % ICMP loss to newyork1, RTP ~0 %" note was THIS fault,
  misread through the integer column and the receive side.
- ⚠ **Separate and CHRONIC:** app/WebRTC legs (`T<d>_<d>_1`, opus) have had **50–58 % of legs ≥1 % tx
  loss every week since Aug 24** — flat, older, the France-relayed TURN/rtpengine path (111 ms). Not
  today's change; not investigated further.
- ⚠ Side findings, none the cause: **Telocall registration `0001` `Rejected` ~23 h** — `server_uri`
  port **`:700`** vs AOR contact `:7000` (typo? outbound still works on the static contact);
  `/var/log/asterisk/full` keeps **ONE day** (no history on the box); `stasis/m:manager:core`
  high-water 3,000 hit 75×/day (AMI consumer over 110 ms — signaling stalls, not media);
  `audit.jsonl` 85 GB still unrotated; socket buffers at defaults; hourly `drop_caches` cron.
- ⏳ **NOTHING DONE — every remedy is a PBX or vendor write, Izzy's call (handoff §9, ranked):**
  (1) Contabo ticket with the per-hop table (the only fix of the cause); (2) `0001` → `us-central.telocall.com`
  (Cogent, 0 %, 11 ms) after Telocall confirms + fix the `:700`; (3) VoIP.ms trunks AND DID POPs
  NY1 → Chicago 1 (9 ms, 0 %) / Atlanta 1, BOTH halves per the 2026-09-10 NY2→NY1 recipe, one tenant
  first; (4) accelerate Telnyx (Cogent-routed, clean). ⛔ Do NOT touch codecs, jitter buffers, RTP
  ranges, buffers or the firewall for this. **Proof of fix = §2 Transmit Lost 0 in business hours +
  §3c hop pings 0 % + a fresh recording at 0–1 holes/min; a quiet-hour check proves nothing.**
