# ⛔ AGENT HANDOFF — the 100-person MEETINGS load test ran for an hour with US ends (2026-09-10): LiveKit relayed CLEANLY, the 10–22 % loss was the LOAD GENERATORS starving, Izzy's office line caps at ~45–48 sessions, and screen share was NEVER exercised — READ FIRST before quoting ANY meeting capacity number, before running `lk load-test` from a workstation or from the SFU host, or before touching `toggleShare` in `MeetingRoom.tsx`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_MEETINGS_LOAD_TEST_2026-09-10.md`**
(**No code, no deploy, no migration, no PBX interaction, no env change.** One real meeting
`xps-etsu-9e7` created + ended through the real routes; `lk` CLI v2.18.6 in `/root/lk/`
on loopcom, logs left there. Memory: [[meetings-load-test-starved-senders-not-the-sfu]].)
Izzy: *"Real data, not fake-ass tests … the ends in the U.S. … run it for 1 hour … stress
test screen sharing as well."*

- ✅ **THE SERVER HELD.** 200 real WebRTC connections (100 US talkers requested, 99 watchers
  on the host, ~9,900 subscriptions): LiveKit **3.4 cores avg, 6.3 peak, 12.8 at the join
  burst, 1.4 GB, 0 crashes, 0 ERROR lines of its own; nginx answered every join 200**.
  ✅ **A clean stream to the US is clean:** 28 server-published tracks watched from the
  workstation over the Atlantic = **0 loss, full-rate audio, 1.7 Mbps per watcher**.
- ⛔⛔ **THE 19.9 % / 21 % / 18 % LOSS FIGURES ARE THE TESTERS, NOT THE SFU — never quote
  them as server loss.** Proven by three vantage points on the same tracks: US watchers and
  host watchers saw identical loss (so not Docker's port proxy), while LiveKit's OWN inbound
  stats read `packetLostPercentage: 0` with **jitter 885–1,219 ms** and 47k–50k "too old"
  discards — the senders (a Windows tester driving 48–100 goroutines; the host tester on a
  load-20 box beside the api) burst ~1 s late and LiveKit correctly threw the late packets
  away. ⛔ **Equally: the 0 % control is NOT a 100-publisher proof.** Neither host can make
  100 clean publishers; the true ceiling needs a US cloud VPS with ≥100 Mbps up.
- ⛔ **Izzy's office line opened ~45–48 concurrent meeting sessions and not one more**, at
  5 joins/s (49 in) and at 2 joins/s (48 in); 10 more were reaped in the first 10 minutes
  and 38 held the hour. A fresh HTTPS request answered in 0.37 s while the wall stood, nginx
  has no `limit_conn` on `/meetws`, `ss` showed exactly 45 sockets from his address. And
  ~8 Mbps of upstream media took his RTT **104 ms → 1.3 s**. Facts about a filtered US
  office line, not about the meeting.
- ⛔ **The PBX was refused as the US load host on Izzy's own "zero risk" condition**: no
  Docker on it (a container = installing one on the production phone server), one NIC
  shared with every customer's RTP (containers do not isolate bandwidth), 12 cores already
  serving 27 tenants. Read-only inspection only.
- ⛔ **SCREEN SHARE AND THE 100-TILE BROWSER WERE NOT TESTED** — nobody joined from a
  browser; the roster never held a human. `toggleShare` swallows every failure as "picker
  dismissed", and the Loopcom desktop app's `setDisplayMediaRequestHandler` bypasses the
  picker — get the SYMPTOM and the SURFACE from Izzy before touching either.
- ⛔ Recipe traps: `lk load-test` publishers do NOT subscribe (100-watch-100 = 200 in the
  room, 200 tiles in the grid); Go testers run `AdaptiveStream: false`; git-bash `tar`
  cannot open the Windows zip; foreground `sleep` is blocked here (checkpoints must be
  `run_in_background`); the Go SDK's own ICE gathering probes the second IP's TURN-443 and
  logs `TLS handshake failed: EOF` — not a fault. ⚠️ Seen in passing: the pm2 deploy-queue
  worker sat at ~100 % of one core on loopcom the whole time.
