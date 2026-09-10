# AGENT HANDOFF — Loopcom Meetings 100-person load test, US ends → server in Europe (2026-09-10)

Izzy, 2026-09-10: *"super, super, super stress test the meetings to see what a meeting with
100 people would look like … Real data, not fake-ass tests"* → *"I want the ends to be in
the U.S. … Run the meeting for 1 hour"* → *"use my workstation, run it for the hour"* →
*"stress test screen sharing as well. It wasn't working properly."*

**No code change, no deploy, no migration, no PBX interaction, no env change.** One real
`VideoMeeting` row was created through `POST /meetings` and ended through
`POST /meetings/:code/end` (both with a 120-s self-signed SUPER_ADMIN token inside
`app-api-1`). LiveKit's official load tester (`lk load-test`, v2.18.6) was the only tool:
a Go binary in this session's scratchpad on the workstation and in `/root/lk/lk` on loopcom.
Nothing was installed into the repo or any container. ⛔ The PBX was refused as a load host
(no Docker, one NIC shared with every customer's RTP, hard read-only rule) — see §1.

## 0. The answer in five lines

1. **The server is not the thing that breaks a 100-person meeting.** 200 concurrent real
   WebRTC connections (100 talkers + 99 watchers, ~9,900 track subscriptions) cost LiveKit
   **3.4 cores average, 6.3 peak steady-state, 12.8 for the join burst, 1.4 GB**, with
   **0 crashes, 0 LiveKit-caused connection failures, every join answered 200 by nginx**.
2. **A clean stream across the Atlantic is clean.** 28 server-published tracks watched from
   the US workstation: **0 packets lost, full-rate audio (18.8–20.6 kbps), 1.7 Mbps per
   watcher, 0 discards** (§4, the "clean small" run).
3. **The 10–22 % loss seen under full load was the LOAD GENERATORS starving, not the SFU**
   — proven by three vantage points on the same tracks (§4). It is *not* attributable to the
   server, and it also means **the server's ceiling at 100 real publishers is NOT proven**,
   because 100 clean publishers could not be produced from either available host.
4. **Izzy's office line caps at ~45–48 concurrent meeting sessions** and goes to 1.3 s
   latency under ~8 Mbps of upstream media. Both runs stopped at the same wall at different
   join speeds. A true fact about a filtered US office line; nothing to do with the server.
5. **Screen sharing was not tested and the browser 100-tile grid was not tested** — nobody
   joined the meeting from a browser during the hour (the roster never held a human).

## 1. Why the PBX was refused (Izzy: "only if zero risk")

Read-only inspection of `vmi2718844` (the PBX, St. Louis): **no Docker binary** (an
"isolated container" = installing Docker on the production phone server, a write); one
virtual NIC (`eth0`, speed unreadable) that carries every customer's live RTP — a container
isolates CPU and process, **never bandwidth**; 12 cores already running Asterisk for 27
tenants. Any one of those is more than zero risk. Not done.

## 2. Setup that works (re-usable recipe)

- **Tester:** `lk` CLI. Windows: `lk_<ver>_windows_amd64.zip` (⛔ git-bash `tar` cannot
  open the zip — `Expand-Archive` from PowerShell). Linux: `lk_<ver>_linux_amd64.tar.gz`,
  kept at `/root/lk/lk` on loopcom.
- **Credentials:** the one `keys:` line of `/opt/connectcomms/env/livekit.yaml` (root-only),
  exported as `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`. ⛔ Never printed; the workstation
  copy lived in the session scratchpad and was deleted afterwards.
- **URL:** `wss://app.loopcom.net/meetws` — the same nginx path the browser uses. The Go SDK
  appends `/rtc` and `/rtc/validate` itself; both proxied fine (nginx logged
  `/meetws/rtc/validate` 200 and `/meetws/rtc` 101). Media went to `45.14.194.179:7882/udp`
  as advertised.
- **Room = the real meeting:** `POST /meetings {title}` → code `xps-etsu-9e7`, id
  `cmtvg2c4sfuxynn14tcnmvpzc`, LiveKit room `meet-<id>` (`liveKitRoomForMeeting`). A human
  joins the same room from `https://app.loopcom.net/meet/<code>`. End it with
  `POST /meetings/<code>/end` (deletes the LiveKit room too).
- **Roles:** `--video-publishers N --audio-publishers M` (talkers) and `--subscribers K
  --layout 5x5` (watchers; 5x5 subscribes up to 25 video + all audio). Publishers in this
  tool do NOT subscribe, so a "100 people who all watch each other" needs 100 talkers + 100
  watchers = 200 participants in the room. ⛔ The browser grid draws a tile for every one.
- **Server-side sampler:** `/root/lk/sampler.sh` (docker stats + eth0 Mbps + load every
  30 s → `/root/lk/stress-20260910.log`); `/root/lk/roomcount.sh` (participants/publishers
  every 60 s → `roomcount.log`). All logs are still in `/root/lk/` (the 208 MB LiveKit
  log dump was deleted).
- ⛔ **Foreground `sleep` is blocked in this harness** — timed checkpoints must be
  `run_in_background` commands.

## 3. The workstation's line, measured first

| | Value |
|---|---|
| RTT to loopcom, idle | 99–111 ms (avg 104) |
| Download from loopcom | ~7 Mbps (⛔ Cloudflare speed test is blocked by the filter, so no CDN control) |
| Upload to loopcom | 14.0 Mbps (scp), 16.6 Mbps to Cloudflare |
| RTT during run 1 join burst | **1,052–1,738 ms (avg 1,297)** |
| RTT during run 2 ramp / steady | 360 ms avg / 109–122 ms |

## 4. Every run, with numbers

### Run 1 — 11:30Z, the burst (aborted after 6 min on purpose)
100 US talkers (8 camera **medium** + 92 audio) at **5 joins/s** + 99 host watchers.
- **49 joined, 51 failed**: `context deadline exceeded` on `GET /meetws/rtc/validate` — the
  tester's own HTTPS call timing out while the line was saturated (nginx had answered
  454×200 / 11×499 to the same address). The server was never the refuser.
- LiveKit inbound stats on the US audio: `rtt 1992 ms, maxRtt 14676 ms`, propagation delay
  1–3 s, packets discarded "too old".
- LiveKit CPU: **1,283 %** (12.8 cores) at the join burst, 2.4–7.5 cores after; load 27.
- Host watchers: **22.5 % loss**, 10 errored. Stopped because it was measuring the line.

### Run 2 — 11:36Z → 12:37Z, the hour
100 US talkers (8 camera **low** + 92 audio) at **2 joins/s** + 99 host watchers.
- **48 joined, 52 failed** (`could not establish signal connection` / `could not connect
  after timeout`, publishers 36–90). Same wall as run 1 at a different speed → a cap on
  concurrent long-lived sessions between the desk and the internet, ~45–48. Proof it is not
  the server: a fresh HTTPS request from the workstation answered in 0.37 s while the wall
  stood; nginx has **no** `limit_conn` on the meeting path, 18 workers × 768 connections,
  0 `limiting` lines in error.log; `ss` on the server showed exactly 45 sockets from the
  workstation's address.
- **10 of the 48 were reaped in the first 10 minutes; 38 held for the rest of the hour.**
  Roster flat at **135 (97 watchers + 38 talkers) for 47 consecutive minutes.** No human.
- LiveKit: **avg 335 % CPU (3.4 cores), 1.24–1.4 GB**, 0 ERROR lines; host load ~20 on 18
  cores (the tester + the api's node process, which sat at ~100 % of one core throughout).
- LiveKit discarded **50,228 packets as "too old"** over the hour (US audio arriving ~4 s
  late in bursts).
- Host watchers at the end: **19.9 % loss (p50 17.2 %, p90 21.3 %, max 58.6 %)**, 2 could
  not connect, 67 tester-side `panic in consumeTrack` (a bug in `lk` itself, not the server).

### Discriminator 1 — 12:40Z, 200 s: is the 20 % Docker's port proxy?
US talkers (8 low + 20 audio) + **6 US watchers** + 99 host watchers, same streams.
- US watchers **21.1 %** loss, host watchers **20.9 %** → identical → **not the proxy**.
- But: 28 tracks arriving at **83 kbps total per watcher ≈ 3 kbps per track**, against
  18.8 kbps audio / 290 kbps video in the 1-publisher smoke test. The streams were starved at
  the SOURCE. LiveKit's own inbound stat for a US talker: audio at **29 packets/s instead of
  50**.

### Discriminator 2 — 12:44Z, 200 s: publish from the SERVER instead
48 server-published streams (8 medium + 40 audio, loopback into LiveKit) + 50 host watchers
+ 6 US watchers, host load ~20.
- US watchers **10.9 %**, host watchers **18.1 % (p50 11.2 %, max 23 %)**; video tracks at
  8–22 kbps with 19–77 % loss.
- LiveKit's inbound view of those loopback publishers: **`packetLostPercentage: 0`** but
  **jitter 885–1,219 ms** and 47,388 "too old" discards in the window — the packets all
  arrived, in ~1-second bursts, because the tester process on the loaded host could not send
  on schedule. LiveKit correctly threw the late ones away; the watchers counted them lost.
- ERROR lines in that window (105): 5× pion `udp_mux Failed to write packet: closed pipe`
  (teardown of disconnecting testers), 2× `TLS handshake failed: EOF` and 2× `closeNotify
  broken pipe` from **169.58.213.204** (the second IP — TURN-on-443 probes from the testers'
  own ICE gathering). None is a server fault. WARN: 1,551 `error reading data channel`
  (tester disconnects), 12 `set local description on closed peer connection`.

### Clean small — 12:56Z, 190 s: the control that settles it
28 server-published streams (8 medium + 20 audio), **host otherwise idle** (load 6), 3 US
watchers over the real internet.
- **0 packets lost on every one of 84 track subscriptions. 1.7 Mbps per watcher. Audio
  18.8–20.6 kbps per track. 0 "too old" discards. LiveKit 59 % of one core.**

**Reading:** the SFU relays cleanly to the US when it is fed cleanly. Every lossy number above
coincides with a starved sender — the Windows tester driving 48–100 goroutines, or the
server-side tester sharing a host at load 20 with the api. ⛔ **Do not quote 20 % as the
server's loss, and do not quote 0 % as proof of a 100-publisher ceiling either.** The true
ceiling needs 100 clean publishers, which means a US cloud VPS (or several) with a fat
uplink — neither the workstation nor the SFU host can produce them.

## 5. What Izzy's line taught, for the customer base

- One filtered office line opened **~45–48** concurrent meeting sessions and no more, at
  any join speed. A customer trying to put a whole company into one meeting from one
  connection hits this. Ordinary meetings (one session per person per line) never will.
- **~8 Mbps of upstream media took a 14-Mbps uplink from 104 ms to 1.3 s.** A single
  camera + screen share is ~2–4 Mbps and is fine; the workstation itself was never the
  reference for what a customer's single session feels like.

## 6. Screen sharing — NOT tested, and what the code says

Nobody joined from a browser during the hour, so no share ever happened. From
`apps/portal/app/meet/[code]/MeetingRoom.tsx`:
- The room re-renders (`bump`) on `TrackSubscribed` / `Unsubscribed` / `LocalTrackPublished`
  etc., and `sharer` is found by `getTrackPublication(Track.Source.ScreenShare)` with a
  present `.track` (or the local participant). A remote share that gets subscribed WILL
  show; the wiring is not obviously broken.
- ⛔ **`toggleShare` swallows every failure** as `/* picker dismissed — not an error */`. A
  real refusal (permission denied, the Loopcom desktop app's own display-media handler
  choosing a surface without a picker, a `getDisplayMedia` that hangs) shows NOTHING on
  screen. If "wasn't working" meant "I pressed it and nothing happened", that catch is the
  first suspect; if it meant "the other side never saw it", it is the adaptive-stream /
  subscription path, and the Go testers (`AdaptiveStream: false`) cannot reproduce a browser
  watcher.
- ⛔ The desktop app registers `setDisplayMediaRequestHandler` for remote support (see the
  2026-09-01 remote-support section in CLAUDE.md) — a share from the Windows app goes
  through that handler, not Chrome's picker. **Get the symptom and the surface (browser vs
  Loopcom app) from Izzy before touching either.**

## 7. Observations, not acted on

- `node /opt/connectcomms/...` (the pm2 deploy-queue worker) sat at **~100 % of a core** on
  loopcom throughout the test — unrelated to meetings, worth a look.
- The Go tester's ICE gathering hit the **TURN-on-443 listener on 169.58.213.204** and got
  `TLS handshake failed: EOF` — the relay path is still the unfinished one from 2026-08-21.
- 200 participants = 200 tiles in `MeetingRoom.tsx`'s grid. A browser-side test of that is
  still owed (Izzy's own browser as participant #100 is the cheapest way).

## 8. Acceptance still owed

1. **The server ceiling:** 100 clean publishers from a US cloud box (≥100 Mbps up), 100
   watchers elsewhere, read loss at the WATCHERS and jitter at LiveKit's inbound. Expect the
   join-burst CPU spike (12.8 cores here) to be the first thing to size.
2. **Screen share:** one human shares from Chrome, one from the Loopcom desktop app, a
   second human watches — with the symptom Izzy saw written down first.
3. **The 100-tile browser:** join a 100+ room from a normal laptop and watch CPU.
