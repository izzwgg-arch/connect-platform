# AGENT HANDOFF — platform-wide "audio breaking up" (calls, hold, IVR prompts, recordings): the PBX's Contabo uplink loses 5–24% of packets on the Lumen transit path to VoIP.ms New York 1 and to Telocall, since ~2026-09-06, worst in US business hours (2026-09-17)

**Read-only investigation. Nothing was changed on either server, in the database, or in code.**
Requested by Izzy 2026-09-17: *"Audio recordings, hold, and maybe even phone calls are all
breaking up across the platform … I also heard it when I dialed in to the Gesheft before. The
audio was very scratchy and laggy. This is not the first time this happened."*

Summary line lives in `docs/ai-context/claude-md-sections/2026-09-17-platform-audio-breakup-lumen-transit-loss.md`.
Memory: [[pbx-uplink-loses-packets-on-the-lumen-path]].

---

## 0. The answer in one paragraph

The PBX (`vmi2718844`, Contabo **St. Louis**, 209.145.60.79) is healthy: no CPU steal, 87–94 % idle,
no I/O pressure, no memory pressure, NIC drops 0.017 % since boot, UDP buffer errors 1,330 lifetime,
Asterisk timing exact, no crashes, no restarts. Our code does nothing per-call that could damage media.
**What is broken is the network path out of Contabo St. Louis toward two of the three carrier
destinations the platform depends on.** Traffic to `newyork1.voip.ms` (208.100.60.66 — **62 of 65
VoIP.ms trunks register there**, and it is where the DIDs deliver media from) and to **Telocall**
(`us-east.telocall.com` 8.36.70.3 SIP / 8.36.70.9 media — the **"0001" primary outbound trunk on every
tenant's route**) exits Contabo through **Lumen/Level3 (63.208.63.217 → 4.26.120.122)** and loses
**5–24 % of packets per 20-second sample** in business hours. Traffic to `atlanta1.voip.ms`,
`chicago1.voip.ms`, `us-central.telocall.com`, `sip.telnyx.com` and the app server exits through
**Cogent (154.24.69.121 → 154.54.x)** and loses **0 %** in the same seconds. The loss is real media
loss, not ICMP deprioritisation: the carriers' own RTCP receiver reports on live calls show **4–5 %
of the PBX's outbound audio lost on every Telocall leg** sampled, the per-call quality table shows
the fraction of trunk legs with ≥1 % outbound loss climbing **2.5 % → 7.7 % → 3.5 % → 23.8 % →
33.3 %** week over week since sampling began, and today's recordings carry **2–8 mid-speech
dropouts per minute of speech** where July/August recordings from the same tenant carry 0–1.
The same hosts measure **0 % loss from the app server in France and 0 % from Izzy's PC in New York**,
so it is the PBX's uplink/transit, not the carriers.

**Why Izzy heard it on the Gesheft pay line:** everything the PBX plays to an outside caller
(IVR prompts, hold music, a person's voice) travels PBX → carrier. That is the lossy direction.

**Why "recordings break up":** the recorded file is what the PBX received. Today's files have
holes; July/August files do not. The inbound direction is also lossy, just less (sub-1 %, invisible
to the integer `rxLossPct` column — see §4).

**Why "not new":** it has been bad since about **Sep 6**, spiked **Sep 11**, and today (**Sep 17**)
is the worst sampled day (49 % of trunk legs with ≥1 % loss). Before Sep 6 the baseline was 1–7 %.
The mobile/WebRTC app legs are a *separate*, older, chronic story (§7).

---

## 1. Host health — everything checked, everything clean (PBX, read-only)

| Check | Result |
|---|---|
| CPU | 12 vCPU EPYC (KVM), 87–94 % idle at 5–9 active calls; **steal = 0 jiffies on every core since boot** (`/proc/stat` col 8; the first read mis-indexed softirq as steal — corrected) |
| PSI (`/proc/pressure/*`) | cpu some avg300 0.82, io full avg300 0.06, memory 0 |
| Memory | 48 GB, 29 GB free, 0 swap; MariaDB 14 GB RES (VitalPBX's own) |
| Disk | sda 490 GB, 64 % used, avg read 1.8 ms / write 1.9 ms, `mq-deadline`, non-rotational |
| Asterisk | 20.18.2, up 5 d 13 h (boot Sep 12 01:42 ET), last reload 23 h ago, **no restart/crash** in journal, `timing test` = 50/50 ticks (timerfd), 145 threads, **main thread idle** (utime+stime unchanged over 10 s; `top -H` first row is the process total, not the main thread) |
| Taskprocessors | 0 in queue; `pjsip/distributor-*` "High time" 0.2–2.4 s (single slow tasks — see §8 AMI note); `stasis/m:manager:core` hit high-water 3000 **75× today** |
| Translation | ulaw↔slin 6–9 ms/s of audio; opus 17–23 ms/s — trivial at this call count |
| MOH | all classes `mode=files`, every file 8 kHz 16-bit mono PCM WAV (VitalPBX's and ours) — no mp3, no resampling |
| Pay-line prompts | `/var/lib/asterisk/sounds/connect-pay/en-male/*.wav` all 8 kHz 16-bit mono PCM — nothing to resample |
| Recordings | native `MixMonitor` → 8 kHz 16-bit mono PCM WAV under `/var/spool/asterisk/monitor/<tenant_hash>/…` (634 files today) |
| NIC (`ip -s -s link eth0`) | RX 55.4 M pkts / **9,685 dropped (0.017 %)**, 0 errors; TX 53.3 M / 0 dropped |
| UDP (`nstat`) | `UdpInErrors = UdpRcvbufErrors = 1,330` lifetime (≈0.003 % of 43 M datagrams); `IpInDiscards 0`, `IpOutDiscards 6` |
| conntrack | 578 / 262,144; drops ≈ 0 |
| Firewall | RTP 10000–60000/udp still open runtime + permanent (2026-08-23 widening intact); `nft` has **no** `limit rate` rules; qdisc `fq_codel` default |
| Clock | kvm-clock, NTP synchronised |

Two host oddities noted, **neither the cause**:
- `/etc/cron.d/sync` (VitalPBX, Jul 2025): `46 * * * * root sync; echo 3 > /proc/sys/vm/drop_caches`
  — drops the whole page cache hourly. Harmless at this load; would matter at 300+ calls.
- `net.core.rmem_max/wmem_max` are the 212,992-byte defaults (the 2026-08-23 capacity pass did not
  touch socket buffers). The 1,330 lifetime rcvbuf errors are all this. Not today's problem.

Agent-C code audit (Explore, read-only): nothing in `apps/` or `scripts/pbx/` touches live media on a
timer. `RtpStatsSampler` = **one** AMI `pjsip show channelstats` every 10 s while calls exist;
MOH assets are transcoded once at upload to 8 kHz WAV and pulled by a 5-minute cron that reloads
`res_musiconhold` only on change; recordings are served by one pass-through HTTP request per click
with no transcoding; the only mid-call blocking is the pay line's `CURL()` (6 s connect / 25 s
http) which is feature-scoped, not platform-wide. The PBX helper has no scheduler.

---

## 2. Live proof on the wire (PBX, `pjsip show channelstats`, 19:21–19:22 UTC = 15:21 ET)

Receive columns are the PBX's own sequence-number count; **Transmit "Lost" is what the far end
reports back in RTCP receiver reports** — i.e. packets the PBX sent that the carrier never got.

| Bridge | Leg | Codec | Rx count / lost | **Tx count / lost / %** | RTT |
|---|---|---|---|---|---|
| 199084cd | `0001-000033db` (Telocall) | **opus** | 8,491 / 0 | **8,275 / 424 / 5 %** | 48 ms |
| 199084cd | `T18_101-000033da` (Trust desk phone) | ulaw | 8,274 / 0 | 8,275 / 6 / 0 % | 51 ms |
| 55890d88 | `0001-000033d8` (Telocall) | ulaw | 8,287 / 74 (0.9 %) | **8,027 / 345 / 4 %** | 52 ms |
| 55890d88 | `T7_101-000033d7` (Create A Box phone) | ulaw | 8,028 / 1 | 8,055 / 0 / 0 % | 247 ms |
| d1adabb8 | `0001-000033e3` (Telocall) | ulaw | 1,879 / 0 | **1,592 / 83 / 5 %** | 42 ms |
| e4955709 | `0001-000033e2` (Telocall) | ulaw | 1,782 / 0 | **1,530 / 62 / 4 %** | 44 ms |
| e4955709 | `T2_101-000033e1` (A plus phone) | ulaw | 1,529 / 0 | 1,533 / 0 / 0 % | 47 ms |
| ed57218d | `344022_Comfortcont` (VoIP.ms NY1) | ulaw | 10,205 / 0 | 9,815 / 0 / 0 % | 34 ms |

Every Telocall leg: 4–5 % of the PBX's outbound audio lost; every phone leg on the same box in the
same minute: 0 %. The one NY1 leg in that minute happened to be clean (the NY1 loss is bursty — §3).
Earlier in the same session (19:15 UTC) a Gesheft call showed **15 % rx loss on the Telocall leg and
16 % on the `T8_108` phone leg simultaneously** (a burst — §3 bursts hit both directions).

Note `0001` negotiates **opus** with some calls (`allow=(opus|ulaw|alaw|g726)`, opus first) — the PBX
transcodes ulaw↔opus for those. Not the cause (§1 translation cost), but worth knowing.

---

## 3. Path measurement from the PBX (ICMP, 172-byte = voice-sized payload, 0.2 s interval)

### 3a. Destinations, 100 packets each, all in parallel, 19:10–19:12 UTC

| Host | Role | Loss | avg RTT |
|---|---|---|---|
| newyork1.voip.ms 208.100.60.66 | 62/65 VoIP.ms trunks + DID media | **7 %** | 32 ms |
| us-east.telocall.com 8.36.70.3 | "0001" primary outbound trunk (SIP) | **10 %** | 31 ms |
| dallas1.voip.ms | (not used; control) | **5 %** | 30 ms |
| atlanta1.voip.ms 208.100.60.17 | `344022_gesheft` only | 0 % | 37 ms |
| chicago1.voip.ms 208.100.60.8 | (not used; control) | 0 % | **9 ms** |
| sip.telnyx.com 192.76.120.10 | Telnyx trunk 183 | 0 % | 41 ms |
| 45.14.194.179 loopcom | app server / coturn / rtpengine (France) | 0 % | 111 ms |

### 3b. Ten rounds × 50 packets, 19:26–19:27 UTC (`scratchpad/loss-timeline.txt`)

NY1: 2,0,0,0,2,0,2,0,0,4 % · Telocall: 4,2,0,0,0,2,6,2,0,0 % · Atlanta1: 0×10 · Chicago1: 0×10 · loopcom: 0×10.
Bursty, low-level, path-specific, persistent.

### 3c. Per hop, five rounds × 100 packets, 19:30–19:38 UTC (`scratchpad/perhop.txt`) — THE LOCATING RESULT

Traceroute shapes (`traceroute -n -I`):
- **Lossy path** (NY1, Dallas, Telocall SIP *and* media, Telocall us-west): `209.126.0.11/.12 (Contabo gw)
  → 63.208.63.217 (Lumen) → * → 4.26.120.122 (Lumen) → 141.101.73.x (Cloudflare Magic Transit) → … → destination`
- **Clean path** (Atlanta1, Chicago1, Telocall us-central, Telnyx): `209.126.0.x → 154.24.69.121 (Cogent)
  → 154.54.80.185 → 154.54.46.178 → 38.122.181.134 (Cogent) → 141.101.73.111 (Cloudflare) → … → destination`

| Hop | Who | Loss per round |
|---|---|---|
| 209.126.0.11 | Contabo gateway A | 1, 0, 0, 2, 3 % |
| 63.208.63.217 | Lumen edge | 2, 0, 0, 0, 0 % |
| **4.26.120.122** | **Lumen backbone** | **15, 1, 12, 22, 6 %** |
| **208.100.60.66** | **newyork1.voip.ms** | **14, 14, 24, 3, 11 %** |
| **8.36.70.3** | **Telocall SIP** | **13, 10, 19, 4, 6 %** |
| 154.24.69.121 / 154.54.80.185 | Cogent | 1,0,0,0,0 / 0×5 |
| 141.101.73.111 / .171, 162.158.219.60 / .81, 172.69.57.248, 172.70.129.30 | Cloudflare edges (reached via Cogent) | 0–1 % |
| 208.100.60.17 | atlanta1.voip.ms | 1, 0, 0, 0, 0 % |

Follow-up single round (19:40 UTC): Telocall **media** 8.36.70.9 = 7 %, 8.36.70.3 = 7 %, NY1 = 8 %,
4.26.120.122 = 6 %, chicago1 media 208.100.60.8 = 0 %. Telocall regions: `us-central.telocall.com`
161.38.211.132 → **Cogent path, 0 %, 11 ms**; `us-west.telocall.com` 8.30.173.3 → Lumen path, 0 % in
that round, 54 ms.

**Reading:** loss first appears at the Lumen backbone hop and persists to every destination behind
it; the Cogent-side hops and every destination behind them are clean in the same seconds. ICMP
deprioritisation produces loss at a hop that *disappears* at the destination — the opposite of this.
The prior 2026-09-16 note ("10–20 % ICMP loss to newyork1, RTP ~0 %") was this same fault; the RTP
"~0 %" was read from the integer `rxLossPct` column (§4) and from the *receive* side.

### 3d. Other vantage points (same hosts, same hour)

| From | NY1 208.100.60.66 | Telocall 8.36.70.3 | Atlanta1 | PBX 209.145.60.79 |
|---|---|---|---|---|
| loopcom, Lauterbourg FR (100 × 0.2 s) | 0 % / 85 ms | 0 % / 98 ms | 0 % / 98 ms | 0 % / 113 ms |
| Izzy's PC, NY (60 × 1 s) | 0 % / 28 ms | 0 % / 24 ms | 0 % / 45 ms | 0 % / 48 ms |

The carriers are reachable cleanly from everywhere except the PBX's own uplink.

### 3e. Corroboration in today's Asterisk log

- `is now Unreachable` today: **1,641** events (all endpoints). Trunk endpoints: every VoIP.ms NY1
  trunk plus `0001` flapped **together** in two ~15-second bursts — **03:08:51–03:09:08 ET** and
  **15:18:52–15:19:02 ET** (15 trunks each). A whole-POP simultaneous flap = the path dropped
  OPTIONS for ≥3 s, i.e. real loss on the SIP path too, not just ICMP.
- `No response received` on registration: 0 today (registrations retry; they survive a burst).

---

## 4. The database history (`ConnectCdr.rtpStats`, agent A, read-only SQL on loopcom)

`rtpStats` is a **JSON array** of legs: `{channel, codec, rxCount, txCount, rxLost, txLost, rxLossPct,
txLossPct, rxJitter, txJitter, rttSec, uptime, sampledAt}` (jitter/rtt in seconds). ⛔ `rxLossPct` /
`txLossPct` are **integers** — anything under 1 % reads 0. Use `rxLost/rxCount` for sub-1 % loss.
Sampling began 2026-08-23; short calls (<10 s) have no row.

Weekly, trunk legs (channel not `PJSIP/T<d>_`): share of legs with **tx** loss ≥1 % / ≥5 %:

| Week of | legs | tx ≥1 % | tx ≥5 % | rx ≥1 % | med jitter | med RTT |
|---|---|---|---|---|---|---|
| 08-17 | 282 | 2.5 % | 0 | 0 | 4 ms | 35 ms |
| 08-24 | 2,595 | 7.7 % | 3.7 % | 0 | 5 ms | 37 ms |
| 08-31 | 3,082 | 3.5 % | 0.2 % | 0 | 4 ms | 36 ms |
| 09-07 | 3,605 | **23.8 %** | 5.1 % | 0.1 % | 3 ms | 38 ms |
| 09-14 (partial) | 2,570 | **33.3 %** | 4.4 % | 0 | 4 ms | 40 ms |

Daily, trunk legs, tx ≥1 %: 09-01 3.7 · 09-02 2.4 · 09-03 3.1 · 09-04 2.3 · **09-06 10.2 · 09-07 17.9 ·
09-08 30.5 · 09-09 23.1 · 09-10 10.9 · 09-11 36.6 (19.8 % ≥5 %, 6.2 % ≥10 %) · 09-14 12.8 · 09-15 34.7 ·
09-16 35.3 · 09-17 49.2**. Phone legs stayed flat (0.6–8 % ≥1 %, ~0 % ≥5 %) the whole time.
Jitter and RTT never moved — it is loss, not latency.

Per trunk group, last 14 days, tx ≥1 % / ≥5 %: `PJSIP/0001` (Telocall) **30.5 % / 5.3 %** (4,722 legs);
`344022_gesheft` (atlanta1) 13.1 % / 2.1 %; `344022_Comfortcont` (NY1) 13.8 % / 1.6 %; `344022_Smooth2` 12.5 %.

Hour of day (UTC, 14 d): legs ≥5 % loss ≈ 0–0.4 % overnight, **3–4.6 % 15:00–19:00 UTC** (11 am–3 pm ET).
Concurrency bands 0–5 vs 6–15 simultaneous calls: identical loss (2.5 % each) — **our own call load is
not the driver; the time of day (the transit link's load) is.** Peak concurrency in 14 days ≈ 15.

Per tenant (14 d, legs): Gesheft 8,582 (the pay line `845-244-9666` alone = 5,202 calls in 21 d),
A plus 1,264, B Visible 1,244, Trimpro 637 … everyone on NY1/Telocall shows the same trunk signature.

Data-quality notes: 104 legs carry jitter >1,000 ms (sampler artefact, ignore for p95); Saturdays have
0 samples (no calls ≥10 s, not a sampler outage — unverified).

### 4a. Follow-up (agent A, second pass) — onset per trunk group, registration events, where the inbound holes are

Daily share of trunk legs with tx loss ≥1 % (mean txLossPct in parentheses), three groups:

| day | Telocall `0001` (Lumen) | `344022_gesheft` atlanta1 (Cogent) | other VoIP.ms = newyork1 (Lumen) |
|---|---|---|---|
| 08-26 / 08-27 | **18.0 (2.75) / 15.1 (1.15)** | **19.8 (1.95) / 14.3 (1.13)** | 1.3 / 1.5 |
| 08-28 → 09-04 | 1.5–5.3 (≤0.7) | 0–1.6 (0) | 0–3.1 (≤0.06) |
| 09-06 | **13.6** (0.19) | 3.3 (0.03) | 0 |
| 09-07 | 23.2 (0.44) | 8.1 (0.09) | 9.6 (0.12) |
| 09-08 | **40.1** (0.86) | 9.8 (0.13) | **19.2** (0.33) |
| 09-09 | 28.9 (0.50) | 11.8 (0.20) | 18.7 (0.42) |
| 09-10 | 13.7 (0.34) | 3.7 (0.15) | 11.5 (0.28) |
| 09-11 | **42.1 (3.06)** | 25.4 (1.20) | 6.7 (0.47) |
| 09-14 | 16.8 (0.76) | 4.5 (0.05) | 0 |
| 09-15 | 46.5 (1.31) | 16.8 (0.50) | 12.7 (0.21) |
| 09-16 | 44.7 (2.19) | 17.6 (0.44) | 20.2 (0.52) |
| 09-17 | **63.8 (2.36)** | 29.2 (0.62) | 31.6 (0.81) |

- **The Sep 6 rise is on all three groups**, ordered exactly as the paths measure: Telocall (Lumen)
  worst, newyork1 (Lumen) next, atlanta1 (Cogent) smallest but not zero. The atlanta1 share says the
  forward Lumen hop is not the whole story: something shared — the Contabo gateway `209.126.0.11`
  (1–3 % in some rounds) and/or the **return path** (carrier → PBX, which traceroute from the PBX
  cannot see and which may ride Lumen for every destination) — is also lossy. Treat it as
  "Contabo St. Louis upstream, Lumen-side" and let Contabo/a reverse mtr settle which leg.
- **An earlier episode on 08-26/27** hit Telocall and atlanta1 (not newyork1) at 15–20 % — the same
  class of fault, a different transit mix. That is the "not the first time".
- `PbxEndpointRegistrationEvent` (loopcom DB, rows since 09-03): TRUNK Unreachable events per day
  **5–9 (09-03 → 09-07) → 56, 60, 47, 40 (09-08 → 09-11) → 63 (09-14), 30 (09-16), 44 (09-17)**;
  phones 300–2,200/day throughout (chronic NAT flapping, unrelated). Largest same-minute trunk
  mass-flaps: **09-14 02:19 UTC (61 endpoints)**, 09-08 05:19 (39), 09-09 12:49–12:50 (50),
  09-17 07:09 (18), 09-17 19:18–19:19 (16). Overnight timestamps = link/route events, not load.
  `0001` never appears in a mass-flap minute (its qualify is per-contact, and it is on a different
  destination); the mass-flaps are all VoIP.ms newyork1/newyork3 subaccounts together.
- **Where the recordings' inbound holes come from:** Gesheft PHONE legs' rx loss (`rxLost/rxCount`)
  on 09-16 = 0.011 %, 09-17 = 0.120 %; Trust phones 0.004 % / 0.028 % — not elevated. So the holes in
  the Sep 16–17 recordings are **carrier → PBX** loss (the return path), not the customers' phones.
  (Relax Tires has no sampled desk-phone legs — only app legs — so no number for it.)
- Trunk legs, 09-06 → 09-17, by hour **ET**: ≥1 % share 0–1 % overnight, 10.7 % at 8, 20.9 % at 9,
  26.7 % at 10, **43.9 % at 11 (10.1 % ≥5 %)**, 35 % at 12–13, **41.8 % at 14**, 35.7 % at 15,
  23 % at 16, 19 % at 17, 12 % at 18, then single digits. Peak = 11 am–3 pm ET.
- App legs: 25–71 % of legs ≥1 % on any day but **mean txLossPct < 1.3 % every day** and no step on
  09-06 — a chronic low-grade floor, not this fault (§7 softened accordingly).

---

## 5. The recordings themselves (copied to the scratchpad, analysed locally with `gap.py`)

Method: 10 ms RMS frames; a "hole" = 15–400 ms of near-digital silence (RMS < 3) with speech
(RMS > 300) within 150 ms on both sides. Same tenants, old vs new:

| File (tenant / date / type) | speech | holes | holes per min of speech |
|---|---|---|---|
| Trust Bookkeepings 2026-08-06 IN-RG806 | 13 s | 0 | 0.0 |
| Trust 2026-08-06 IN-RG806 | 27 s | 0 | 0.0 |
| Trust 2026-08-06 OUT | 42 s | 1 | 1.4 |
| Trust 2026-08-06 IN-RG806 (5 min) | 83 s | 0 | 0.0 |
| Trust 2026-08-06 IN-RG804 | 6 s | 0 | 0.0 |
| Relax Tires 2026-07-15 IN-RG800 | 35 s | 0 | 0.0 |
| **Trust 2026-09-16 OUT** | 86 s | **10** | **7.0** (320, 80, 120 ms …) |
| **Trust 2026-09-16 IN-RG800** | 70 s | **7** | **6.0** |
| Trust 2026-09-16 IN-IVR | 22 s | 1 | 2.7 |
| Trust 2026-09-16 OUT | 84 s | 2 | 1.4 |
| **Trust 2026-09-16 OUT** | 46 s | **6** | **7.8** |
| **Relax Tires 2026-09-17 OUT** | 123 s | **5** | **2.4** (320, 310, 120 ms …) |

A recording is the PBX's *received* audio, so these holes are inbound loss (carrier → PBX or phone →
PBX). At 50 pps, 6 holes/min ≈ 0.2 % — exactly the sub-1 % band the integer column hides.

---

## 6. What is NOT the cause (each checked, so nobody re-derives it)

- Not the PBX host (CPU/steal/PSI/IO/NIC/UDP/conntrack — §1). Not Asterisk (no crash, timing exact, main thread idle).
- Not our code (agent C, §1 last paragraph). Not the RTP sampler. Not MOH format. Not prompt format. Not the pay-line CURL (feature-scoped).
- Not the RTP port range / firewall (2026-08-23 widening intact; `nft` has no rate limits).
- Not the carriers' servers (0 % from France and from NY; VoIP.ms status page all green; Contabo status page has nothing for St. Louis).
- Not any one customer's office (phone legs 0 % on the same box in the same minute; B Visible's Wi-Fi story from 2026-09-16 is real but separate and does not explain trunk-side loss).
- Not concurrency / our call volume (0–5 vs 6–15 bands identical; peak 15 calls).
- Not the VoIP.ms NY2 → NY1 moves of 2026-09-10 (loss began 09-06, before them, and NY1 is the lossy host either way).
- Not the Sep 12 reboot (loss began before it).

---

## 7. Separate, older, chronic: the mobile/WebRTC app legs

APP legs (`PJSIP/T<d>_<d>_1-`, opus) have shown **50–58 % of legs with ≥1 % tx loss every week since
sampling began** (08-24: 57.8 %, 08-31: 56.8 %, 09-07: 52.3 %, 09-14: 49.7 %), median RTT 40–47 ms,
p95 RTT 90–240 ms — but the **mean tx loss is under 1.3 % every day** (most flagged legs sit just over
the 1 % integer threshold) and there is no step on Sep 6. That is a flat, low-grade floor on the
app/TURN/rtpengine path (coturn and `sbc-rtpengine` live on loopcom in **France**, 111 ms from the
PBX — every relayed US app call crosses the Atlantic twice), not this fault. Not investigated further
today; opus FEC (`codecs.conf` fec=yes, packet_loss=5) masks some of it. The *trunk* fault (§3–§5)
is the new thing since Sep 6, with a first episode on Aug 26–27 (§4a).

---

## 8. Side findings (not the cause; each worth a ticket)

1. **Telocall registration `0001` has been `Rejected` for ~23 h** (`pjsip show registrations`):
   `server_uri = sip:us-east.telocall.com:700` — port **700**, while the AOR contact is `:7000`.
   Outbound still works (static contact + IP auth); anything Telocall would deliver *inbound* to
   that registration is dead. Read-only, not touched; probably a typo in the trunk's registration
   fields — confirm with Izzy before changing anything (PBX write).
2. **`/var/log/asterisk/full` keeps ONE day** (starts 00:00:02 today, no rotated copies) — no
   log-based history beyond today is possible on this box. Consider keeping 7–14 days.
3. **`stasis/m:manager:core` hit its 3,000 high-water mark 75× today** — the AMI consumer
   (`connectcommsgef` from loopcom, 110 ms away, plus VitalPBX's `astmanager`) is not draining
   events fast enough. When any taskprocessor is in alert, `res_pjsip` refuses new requests until it
   clears — signaling stalls (the 1–2.4 s distributor "High time"), not media. Worth its own look.
4. `audit.jsonl` (85 GB, +1.4 GB/day) — still not rotated ([[helper-audit-jsonl-rotation-designed]]).
5. `net.core.rmem_max/wmem_max` at defaults; hourly `drop_caches` cron — both fine today, both
   wrong at 300 calls.
6. Every ring to an extension whose `_1` app device never registered logs an ERROR (dozens of
   tenants today, not just T9_101_1) — noise, documented on 2026-09-16.

---

## 9. What can be done (NOTHING done — Izzy decides; every item is a PBX or vendor write)

Ranked by blast radius (smallest first). None of these were traced for side effects beyond what is
written here; treat each as a proposal to be checked before doing, per the third rule.

1. **Open a Contabo ticket now with §3c** ("packet loss on our St. Louis VPS 209.145.60.79 toward
   destinations routed via Lumen/AS3356 — 4.26.120.122 — 5–24 % per 100 packets, 0 % via Cogent, since
   ~Sep 6, worst 15:00–19:00 UTC; traceroutes and per-hop pings attached"). This is the only fix that
   addresses the cause. Ask them to depref Lumen or move the VM's uplink. Zero platform risk.
2. **Move the "0001" Telocall trunk from `us-east.telocall.com` to `us-central.telocall.com`**
   (161.38.211.132 — Cogent path, 0 % loss, 11 ms vs 31 ms). Needs Telocall to confirm the same
   credentials/IP auth work on us-central and that the DIDs/CID behave the same; it is the primary
   outbound trunk for **every** tenant, so test on one tenant's route first. While there, fix the
   `:700` registration port (§8.1). Backups + inode-preserving edit per the 2026-09-10 handoff.
3. **Move the VoIP.ms trunks and the DID POPs from New York 1 to Chicago 1** (9 ms, Cogent, 0 %) or
   Atlanta 1 (37 ms, 0 %). ⚠ This reduces, not removes, the loss — §4a shows atlanta1 (already
   Cogent-routed) still carries a smaller share of it, so the shared Contabo edge / return path
   (item 1) stays open. ⛔ Both halves are required — the trunk registration host (5 rows in
   `ombu_trunk_parameters` + the block in `pjsip__50-1-trunks.conf`, no Apply Changes) **and**
   `setDIDPOP` at VoIP.ms, exactly as `AGENT_HANDOFF_BVISIBLE_BUSY_NEWYORK2_2026-09-10.md` did for
   NY2 → NY1. 62 trunks; do one tenant, measure with §2, then the rest. ⛔ Verify Chicago's media
   IPs are also Cogent-routed before committing (208.100.60.8 was, today).
4. **Accelerate the Telnyx migration** — `sip.telnyx.com` is Cogent-routed and clean from this box,
   and the wizard/porting machinery already exists (`2026-09-16-telnyx-onboarding-wizard.md`).
5. Do **not** change codecs, jitter buffers, RTP ranges, socket buffers or the PBX's firewall for
   this — none of them is the cause, and the third rule forbids proposing fixes that do not address
   the measured fault.

**How to know it is fixed:** §2 (`pjsip show channelstats` — Telocall/NY1 legs' Transmit Lost at 0
in business hours), §3c (per-hop pings 0 % at 4.26.120.122 and the destinations), §4 (daily trunk
tx ≥1 % back under 5 %), and §5 (a fresh recording with 0–1 holes/min). A quiet-hour check proves
nothing ([[quiet-log-is-not-a-fixed-bug]]).

---

## 10. Reproduce the measurements (all read-only)

```bash
# PBX (read-only): live per-call loss — Transmit Lost = carrier's RTCP report
asterisk -rx "pjsip show channelstats"
# path loss, voice-sized, in parallel
for h in 208.100.60.66 8.36.70.3 8.36.70.9 4.26.120.122 208.100.60.17 208.100.60.8 161.38.211.132; do
  (ping -c 100 -i 0.2 -s 172 -q $h | grep loss | sed "s/^/[$h] /") & done; wait
traceroute -n -I -q 2 -w 1.5 -m 14 208.100.60.66     # Lumen path
traceroute -n -I -q 2 -w 1.5 -m 14 208.100.60.17     # Cogent path
grep "is now Unreachable" /var/log/asterisk/full | grep -E "Endpoint (0001|344022_)" | cut -c2-20 | sort | uniq -c
```
```sql
-- loopcom DB, weekly trunk-leg tx loss (jsonb_array_elements, NOT jsonb_each)
SELECT date_trunc('week',"startedAt")::date wk,
       count(*) legs,
       round(100.0*avg(((l->>'txLossPct')::numeric>=1)::int),1) pct_tx_ge1,
       round(100.0*avg(((l->>'txLost')::numeric/NULLIF((l->>'txCount')::numeric,0))*100 >= 0.2 ::int),1) pct_tx_ge0_2
FROM "ConnectCdr" c, jsonb_array_elements(c."rtpStats"::jsonb) l
WHERE c."rtpStats" IS NOT NULL AND (l->>'channel') !~ '^PJSIP/T[0-9]+_'
GROUP BY 1 ORDER BY 1;
```
Recording gap census: `scripts/pbx/diag/recording-gap-census.py <dir-of-wavs>` (added with this handoff).

Evidence files from this session (scratchpad, not committed): `loss-timeline.txt`, `perhop.txt`,
`rec/*.wav` (12 recordings), `gap.py` (same as the committed script).

---

## 11. Round 2 (2026-09-18 00:25–00:50 UTC) — the accounting proof, and the Contabo ticket is FILED

- **Accounting proof (read-only, closes "maybe the server dropped them"):** on Sep 17 alone the
  carriers' RTCP receiver reports counted **49,894 lost of 3,546,852 RTP packets** the PBX sent on
  sampled trunk legs (829 legs; DB sum of `txLost`/`txCount`). Every guest-side egress drop counter
  since the Sep 12 boot totals ≈ **1,738**: fq_codel qdisc **1,708** of 61.4 M pkts (0.003 %, shared
  with all traffic), NIC TX dropped **0** / errors **0**, `IpOutDiscards` **6**, `UdpSndbufErrors`
  **0**, conntrack ≈ 24. There is no counter left to hide 50 k packets in one day — they left the VM.
  Inbound `rxLost` summed at arrival that day: 1,112 of 3.7 M (sequence gaps arrive pre-made).
- At 00:25 UTC (20:25 ET): 0 active calls, all paths 0 % — the diurnal shape again; a quiet-hour
  reading proves nothing. A read-only watcher now runs from Izzy's PC (scratchpad `proof/watch.sh`,
  background): every 10 min it logs loss to NY1/Telocall-media/Lumen-hop/atlanta1 + live call count
  to `proof/timeline.csv`, and when loss ≥4 % fires DURING live calls it streams a 75 s RTP pcap off
  the PBX (`tcpdump -w -` over ssh, nothing written on the PBX) + channelstats before/after. Parse
  the pcap for outbound seq continuity (left the box) vs the RTCP delta (never arrived). Deadline
  Sep 18 21:30 UTC, max 2 captures.
- ✅ **CONTABO TICKET FILED — no. 16240435361**, 2026-09-18 ~00:47 UTC, by Izzy's explicit
  instruction, from his logged-in panel (new.contabo.com → Support → Contact Us → Submit a Ticket):
  Technical & Configuration → Server Down / Connection Issue → subscription vmi2718844, "recurring
  issue" since 09/06/2026 09:00. Body = the §0/§3c evidence (Lumen path loss with hop table, Cogent
  0 % controls, EU + residential 0 % controls, the 49,894/3,546,852 RTCP count, guest counters ≈ 0,
  diurnal pattern), the traceroutes in the MTR field, and a preempt for their panel diagnostic.
- ⛔ **Their panel diagnostic ran as a REQUIRED step and reads 1 Failed / 1 Warning: the ping and
  port checks fail because OUR geo firewall blocks their non-US probe source — by design, not an
  outage.** The ticket says so explicitly. ⛔ Their "Suggested action: Reboot server" was NOT
  clicked and must never be — a reboot fixes nothing here and drops live calls.
- ⚠ The form required ticking *"I understand that resolving this issue may require a server reboot
  or brief downtime (only if necessary)"* — ticked as part of filing. **If support proposes a
  reboot/migration, insist on scheduling outside 12:00–22:00 UTC** (business hours are when calls
  run) and note a reboot is not a remedy for transit loss.
- ⛔ Izzy asked whether Contabo's "high performance" servers would help → **NO for this fault**: a
  VDS/dedicated in the same St. Louis DC uses the same upstream; steal is 0 and CPU is 90 % idle, so
  there is no noisy-neighbor component to buy out of. Only the transit fix (or moving carriers onto
  the Cogent-routed POPs, §9.2–9.4) changes anything.

## 12. Round 3 (2026-09-18 ~03:00 UTC) — Contabo's first reply is the deflection the ticket preempted, and they power-cycled the PBX uninvited

- Contabo reply (agent "Oni"): *"your VPS is unable to reach external servers (no ping)"* + VNC
  instructions to rewrite `/etc/network/interfaces` + `systemctl restart networking` + a request for
  **root credentials**. ⛔ All three are wrong for this box: the VPS was reachable and reaching the
  internet the whole time (their probe is geo-blocked by our firewall, stated in the original
  ticket), the static config already matched their values, and credentials never go in a ticket.
  ⛔ **Never run their VNC/interfaces/restart-networking steps on the live PBX** — a networking
  restart mid-day drops every call and registration platform-wide.
- ⛔⛔ **THE PBX WAS POWER-CYCLED TWICE, UNINVITED: boots at 02:28:xx and 02:31:52 UTC Sep 18
  (22:28/22:31 ET Sep 17), with `/etc/network/interfaces` rewritten at 02:31:23 between them.**
  Izzy confirms it was not him; the guest's `auth.log`/`wtmp` show **no SSH login, no console
  login, no shutdown command** in the window — so it was done from the **hypervisor side** (rescue
  boot or a host-side network re-provision; the file now carries Contabo's standard template with
  their resolvers), which only Contabo can do. The reboot-consent box on the ticket form is how
  they justify it. Impact: ~4 min of platform downtime at 22:28–22:32 ET with **0 active calls**;
  everything came back clean (67 registrations, 143 contacts Avail, RTP range intact, asterisk /
  firewalld / helper / fail2ban active). `0001` still `Rejected` (the pre-existing `:700` typo).
- The panel sessions (my.contabo.com and new.contabo.com) had expired by round 3 — the sharpened
  reply is DRAFTED (in the 2026-09-18 chat) and awaits Izzy's login to post, or he pastes it into
  the email thread. It adds: confirm whether your team accessed/power-cycled the VM; the change was
  unnecessary; coordinate any future intervention in advance; if it was NOT your team, treat it as
  a security event. Option flagged to Izzy (his call, not done): the panel's "Disable VNC" closes
  the console door between tickets.
